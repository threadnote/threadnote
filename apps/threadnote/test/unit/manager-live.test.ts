import * as BunServices from '@effect/platform-bun/BunServices';
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunSocket from '@effect/platform-bun/BunSocket';
import {it as effectIt} from '@effect/vitest';
import {Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, PlatformError, Ref, Schema, Stream} from 'effect';
import {HttpClient, HttpServer, HttpServerRequest, HttpServerResponse} from 'effect/http';
import * as Socket from 'effect/socket/Socket';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {resourceAccountMutationLockPath, resourceAccountMutationLockPolicy} from '@threadnote/store/resource/lock';
import {
  advanceCanonicalMutationGeneration,
  readCanonicalMutationGeneration,
} from '@threadnote/store/resource/mutation_generation';
import {readSettledCanonicalMutationGeneration} from '@threadnote/store/resource/settled_revision';
import {makeCanonicalRevisionObservation, makeManagerLiveSources} from '../../src/manager/live_sources.js';
import {makeManagerLive, makeManagerLiveMailbox} from '../../src/manager/live.js';
import {MANAGER_LIVE_LIMITS, ManagerLiveServerFrame} from '@threadnote/manager/live/contracts';
import {TestError} from '@threadnote/testing/test-error';

const systemLayer = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'manager-live.test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: environment => ({...environment}),
        sanitizeExternal: environment => ({...environment}),
      }),
    ),
  ),
);
const testLayer = Layer.mergeAll(
  BunServices.layer,
  systemLayer,
  BunHttpClient.layer,
  BunSocket.layerWebSocketConstructor,
);
function provideLayer<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(Layer.build(testLayer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}

describe('Manager canonical live observation', () => {
  effectIt.effect('reconciles atomic auxiliary replacements without a canonical marker change', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-live-auxiliary-'});
      const semanticFile = path.join(home, 'threadnote', 'semantic-reviews', 'v1.json');
      const manifestPath = path.join(home, 'manifest.json');
      yield* fs.makeDirectory(path.dirname(semanticFile), {recursive: true});
      for (const file of [semanticFile, manifestPath]) yield* fs.writeFileString(file, '{}');

      const seen: string[] = [];
      let scopeChanges = 0;
      const maintenanceStatePath = path.join(home, 'context-maintenance', 'state-v2.json');
      // Dropped watcher delivery is intentional: every replacement must be
      // recovered by the bounded reconciliation timer alone.
      const unwatchedFs: FileSystem.FileSystem = {...fs, watch: () => Stream.never};
      const sources = yield* makeManagerLiveSources({
        home,
        account: 'local',
        maintenanceStatePath,
        manifestPath,
        onScopeChange: Effect.sync(() => {
          scopeChanges++;
        }),
        onInvalidate: (topics, revision) =>
          Effect.sync(() => {
            if (revision !== '') {
              expect(topics).toContain('context-maintenance');
              seen.push(revision);
            }
          }),
      }).pipe(Effect.provideService(FileSystem.FileSystem, unwatchedFs));
      const canonicalBefore = (yield* sources.diagnostics).canonicalRevision;
      const replace = (file: string, value: string) =>
        Effect.gen(function* () {
          const before = seen.length;
          const temporary = `${file}.tmp`;
          yield* fs.writeFileString(temporary, value);
          yield* fs.rename(temporary, file);
          for (let i = 0; i < 120 && seen.length === before; i++) yield* Effect.sleep(50);
          expect(seen.length).toBeGreaterThan(before);
          expect((yield* sources.diagnostics).canonicalRevision).toBe(canonicalBefore);
        });
      yield* replace(semanticFile, '{"semantic":1}');
      expect(scopeChanges).toBe(0);
      yield* replace(manifestPath, '{"manifest":1}');
      expect(scopeChanges).toBe(1);
    }).pipe(Effect.timeout('18 seconds'), TestClock.withLive, provideLayer),
  );

  effectIt.effect('discovers an auxiliary source when its missing parent is first created', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-live-missing-parent-'});
      const semanticFile = path.join(home, 'threadnote', 'semantic-reviews', 'v1.json');
      const seen: string[] = [];
      const sources = yield* makeManagerLiveSources({
        home,
        account: 'local',
        maintenanceStatePath: path.join(home, 'context-maintenance', 'state-v2.json'),
        onInvalidate: (topics, revision) =>
          Effect.sync(() => {
            if (revision !== '') {
              expect(topics).toContain('context-maintenance');
              seen.push(revision);
            }
          }),
      }).pipe(Effect.provideService(FileSystem.FileSystem, {...fs, watch: () => Stream.never}));
      const canonicalBefore = (yield* sources.diagnostics).canonicalRevision;
      yield* fs.makeDirectory(path.dirname(semanticFile), {recursive: true});
      yield* fs.writeFileString(`${semanticFile}.tmp`, '{}');
      yield* fs.rename(`${semanticFile}.tmp`, semanticFile);
      for (let i = 0; i < 120 && seen.length === 0; i++) yield* Effect.sleep(50);
      expect(seen).toHaveLength(1);
      expect((yield* sources.diagnostics).canonicalRevision).toBe(canonicalBefore);
    }).pipe(Effect.timeout('8 seconds'), TestClock.withLive, provideLayer),
  );

  effectIt.effect('observes canonical and atomic maintenance changes with bounded revisions', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-live-sources-'});
      const maintenanceDirectory = path.join(home, 'context-maintenance');
      const maintenanceStatePath = path.join(maintenanceDirectory, 'state-v2.json');
      const canonicalSeen = yield* Deferred.make<string>();
      const maintenanceSeen = yield* Deferred.make<string>();
      const sources = yield* makeManagerLiveSources({
        home,
        account: 'local',
        maintenanceStatePath,
        onInvalidate: (topics, revision) =>
          Effect.gen(function* () {
            expect(topics).toContain('context-health');
            if (revision === '') return;
            if (revision.startsWith('v1:')) {
              expect(topics).toContain('context-maintenance');
              yield* Deferred.succeed(canonicalSeen, revision);
            } else {
              expect(topics).toContain('context-maintenance');
              yield* Deferred.succeed(maintenanceSeen, revision);
            }
          }),
      });
      const marker = (yield* advanceCanonicalMutationGeneration(fs, path, home, 'local')).currentGeneration;
      yield* sources.hints.canonical;
      expect(yield* Deferred.await(canonicalSeen).pipe(Effect.timeout('5 seconds'))).toBe(marker);
      yield* fs.makeDirectory(maintenanceDirectory, {recursive: true});
      const temporary = `${maintenanceStatePath}.tmp`;
      yield* fs.writeFileString(temporary, '{}');
      yield* fs.rename(temporary, maintenanceStatePath);
      yield* sources.hints.maintenance;
      expect((yield* Deferred.await(maintenanceSeen).pipe(Effect.timeout('5 seconds'))).length).toBe(64);
      const diagnostics = yield* sources.diagnostics;
      expect(diagnostics.canonicalRevision).toBe(marker);
      expect(diagnostics.canonicalDirty).toBe(false);
      expect(diagnostics.maintenanceRevision).toHaveLength(64);
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('a failed initial fence later publishes the unchanged settled marker', () =>
    Effect.gen(function* () {
      const raw = yield* Ref.make('v1:initial');
      const published: string[] = [];
      let attempts = 0;
      const observer = yield* makeCanonicalRevisionObservation(
        Ref.get(raw),
        Effect.gen(function* () {
          attempts++;
          if (attempts === 1) return yield* Effect.fail('busy');
          return yield* Ref.get(raw);
        }),
        revision =>
          Effect.sync(() => {
            published.push(revision);
          }),
      );
      yield* observer.reconcile;
      expect((yield* observer.state).observed).toBeUndefined();
      expect((yield* observer.state).dirty).toBe(true);
      // A subscriber can take a stale REST snapshot after the failed first
      // attempt. No new marker or watch notification is needed to recover it.
      yield* observer.reconcile;
      expect(published).toEqual(['v1:initial']);
      expect((yield* observer.state).dirty).toBe(false);
      yield* observer.reconcile;
      expect(published).toEqual(['v1:initial']);
    }),
  );

  effectIt.effect('maintenance I/O failure preserves the last revision until a successful stat', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-live-permission-'});
      const directory = path.join(home, 'context-maintenance');
      const maintenanceStatePath = path.join(directory, 'state-v2.json');
      yield* fs.makeDirectory(directory, {recursive: true});
      yield* fs.writeFileString(maintenanceStatePath, '{}');
      const deniedAttempt = yield* Deferred.make<void>();
      const changed = yield* Deferred.make<string>();
      let denied = false;
      const restrictedFs: FileSystem.FileSystem = {
        ...fs,
        stat: file =>
          file === maintenanceStatePath && denied
            ? Deferred.succeed(deniedAttempt, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: 'PermissionDenied',
                      module: 'FileSystem',
                      method: 'stat',
                      pathOrDescriptor: file,
                    }),
                  ),
                ),
              )
            : fs.stat(file),
      };
      const revisions: string[] = [];
      const sources = yield* makeManagerLiveSources({
        home,
        account: 'local',
        maintenanceStatePath,
        onInvalidate: (topics, revision) =>
          Effect.gen(function* () {
            if (!topics.includes('context-maintenance') || revision.length !== 64) return;
            revisions.push(revision);
            yield* Deferred.succeed(changed, revision);
          }),
      }).pipe(Effect.provideService(FileSystem.FileSystem, restrictedFs));
      const baseline = (yield* sources.diagnostics).maintenanceRevision;
      denied = true;
      yield* sources.hints.maintenance;
      yield* Deferred.await(deniedAttempt).pipe(Effect.timeout('5 seconds'));
      expect((yield* sources.diagnostics).maintenanceRevision).toBe(baseline);
      expect(revisions).toEqual([]);
      denied = false;
      const temporary = `${maintenanceStatePath}.tmp`;
      yield* fs.writeFileString(temporary, '{"new":true}');
      yield* fs.rename(temporary, maintenanceStatePath);
      yield* sources.hints.maintenance;
      expect(yield* Deferred.await(changed).pipe(Effect.timeout('5 seconds'))).not.toBe(baseline);
      expect(revisions).toHaveLength(1);
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('recovery from a failed initial maintenance stat invalidates an early snapshot', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-live-first-stat-'});
      const maintenanceStatePath = path.join(home, 'state-v2.json');
      const changed = yield* Deferred.make<string>();
      let denied = true;
      const restrictedFs: FileSystem.FileSystem = {
        ...fs,
        stat: file =>
          file === maintenanceStatePath && denied
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: 'PermissionDenied',
                  module: 'FileSystem',
                  method: 'stat',
                  pathOrDescriptor: file,
                }),
              )
            : fs.stat(file),
      };
      const sources = yield* makeManagerLiveSources({
        home,
        account: 'local',
        maintenanceStatePath,
        onInvalidate: (_topics, revision) =>
          revision.length === 64 ? Deferred.succeed(changed, revision).pipe(Effect.asVoid) : Effect.void,
      }).pipe(Effect.provideService(FileSystem.FileSystem, restrictedFs));
      expect((yield* sources.diagnostics).maintenanceRevision).toBeUndefined();
      // Consumers can have an old snapshot now; absence is also a valid new state.
      denied = false;
      yield* sources.hints.maintenance;
      expect(yield* Deferred.await(changed).pipe(Effect.timeout('5 seconds'))).toHaveLength(64);
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('retains an unchanged precommit marker across an early snapshot and lost completion event', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-live-fence-'});
      const account = 'local';
      const notifications: string[] = [];
      const observer = yield* makeCanonicalRevisionObservation(
        readCanonicalMutationGeneration(fs, path, home, account),
        readSettledCanonicalMutationGeneration(fs, path, home, account),
        revision =>
          Effect.sync(() => {
            notifications.push(revision);
          }),
      );
      yield* observer.reconcile;
      expect((yield* observer.state).observed).toBe('');
      for (const writerFails of [false, true]) {
        const advanced = yield* Deferred.make<string>();
        const release = yield* Deferred.make<void>();
        const writer = yield* withExclusiveFileLock(
          fs,
          resourceAccountMutationLockPath(path, home, account),
          resourceAccountMutationLockPolicy,
          Effect.gen(function* () {
            const marker = (yield* advanceCanonicalMutationGeneration(fs, path, home, account)).currentGeneration;
            yield* Deferred.succeed(advanced, marker);
            yield* Deferred.await(release);
            if (writerFails) return yield* Effect.fail('writer failed after precommit marker');
          }),
        ).pipe(Effect.result, Effect.forkChild({startImmediately: true}));
        const marker = yield* Deferred.await(advanced);
        const earlySnapshot = yield* readCanonicalMutationGeneration(fs, path, home, account);
        expect(earlySnapshot).toBe(marker);
        const reconciliation = yield* observer.reconcile.pipe(Effect.forkChild({startImmediately: true}));
        yield* Effect.sleep(75);
        expect(notifications).not.toContain(marker);
        expect((yield* observer.state).dirty).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
        yield* Fiber.join(reconciliation);
        // There is deliberately no completion hint. The unchanged marker is
        // enough for the next cheap reconciliation to complete after the lock.
        yield* observer.reconcile;
        expect(notifications.filter(item => item === marker)).toHaveLength(1);
        expect((yield* observer.state).observed).toBe(marker);
      }
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('failed settlement retries the same marker, and a hint during settlement stays dirty', () =>
    Effect.gen(function* () {
      const raw = yield* Ref.make('base');
      const gate = yield* Deferred.make<void>();
      let attempts = 0;
      const notifications: string[] = [];
      const observer = yield* makeCanonicalRevisionObservation(
        Ref.get(raw),
        Effect.gen(function* () {
          attempts++;
          if (attempts === 2) return yield* Effect.fail('busy');
          if (attempts === 3) yield* Deferred.await(gate);
          return yield* Ref.get(raw);
        }),
        revision =>
          Effect.sync(() => {
            notifications.push(revision);
          }),
      );
      yield* observer.reconcile;
      yield* Ref.set(raw, 'next');
      yield* observer.reconcile;
      expect((yield* observer.state).dirty).toBe(true);
      const settling = yield* observer.reconcile.pipe(Effect.forkChild({startImmediately: true}));
      yield* Effect.yieldNow;
      yield* observer.hint;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(settling);
      expect((yield* observer.state).dirty).toBe(true);
      yield* observer.reconcile;
      expect((yield* observer.state).dirty).toBe(false);
      expect(notifications).toEqual(['base', 'next']);
      expect((yield* observer.state).fenceFailures).toBe(1);
    }),
  );

  effectIt.effect.prop(
    'coalesces duplicate hints and publishes only settled revision changes',
    {revisions: Schema.Array(Schema.Literals(['a', 'b', 'c'])).check(Schema.isMaxLength(20))},
    ({revisions}) =>
      Effect.gen(function* () {
        const raw = yield* Ref.make('initial');
        const published: string[] = [];
        const observer = yield* makeCanonicalRevisionObservation(Ref.get(raw), Ref.get(raw), revision =>
          Effect.sync(() => {
            published.push(revision);
          }),
        );
        yield* observer.reconcile;
        const expected: string[] = ['initial'];
        let prior = 'initial';
        for (const revision of revisions) {
          yield* Ref.set(raw, revision);
          yield* observer.hint;
          yield* observer.hint;
          yield* observer.reconcile;
          if (revision !== prior) expected.push(revision);
          prior = revision;
          expect((yield* observer.state).dirty).toBe(false);
        }
        expect(published).toEqual(expected);
      }),
    {arbitrary: {runs: 24}},
  );
});

const serveLive = Effect.fn('test.managerLive.serve')(function* (
  projects: Effect.Effect<ReadonlySet<string>> = Effect.succeed(new Set(['one', 'two'])),
) {
  const context = yield* Layer.build(
    BunHttpServer.layer({
      hostname: '127.0.0.1',
      port: 0,
      websocket: {
        maxPayloadLength: MANAGER_LIVE_LIMITS.messageBytes,
        backpressureLimit: MANAGER_LIVE_LIMITS.bufferedBytes,
        closeOnBackpressureLimit: true,
      },
    }),
  );
  const server = Context.get(context, HttpServer.HttpServer);
  if (server.address._tag === 'UnixPathAddress') return yield* TestError.make({message: 'Expected TCP server'});
  const origin = `http://127.0.0.1:${server.address.port}`;
  const live = yield* makeManagerLive({
    origin,
    token: 'synthetic-live-token',
    projects,
  });
  yield* server.serve(
    Effect.gen(function* () {
      const response = yield* live.handle(yield* HttpServerRequest.HttpServerRequest);
      return response ?? HttpServerResponse.empty({status: 404});
    }),
  );
  const ticket = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.post(`${origin}/api/live-session`, {
      headers: {authorization: 'Bearer synthetic-live-token', origin},
    });
    expect(response.status).toBe(200);
    return (yield* response.json) as {ticket: string};
  });
  const connect = (value: string, from = origin) =>
    Effect.gen(function* () {
      const socket = yield* Socket.makeWebSocket(`${origin.replace('http:', 'ws:')}/api/live?ticket=${value}`, {
        headers: {origin: from},
        openTimeout: 1_000,
        highWaterMark: 262_144,
      });
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const pending: ManagerLiveServerFrame[] = [];
      const next = Effect.suspend(() =>
        pending.length > 0
          ? Effect.succeed(pending.shift()!)
          : reader.pull.pipe(
              Effect.flatMap(batch =>
                Effect.gen(function* () {
                  for (const raw of batch) {
                    const value = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as unknown;
                    pending.push(yield* Schema.decodeUnknownEffect(ManagerLiveServerFrame)(value));
                  }
                  return pending.shift()!;
                }),
              ),
            ),
      );
      return {
        next,
        send: (value: unknown) => writer.write(JSON.stringify(value)),
        sendRaw: (value: string) => writer.write(value),
        close: writer.write(new Socket.CloseEvent()),
      };
    });
  return {origin, live, ticket, connect};
});

describe('Manager live protocol', () => {
  effectIt.effect('bounds incoming frames while subscription authorization is pending', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const server = yield* serveLive(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(new Set(['one']))),
      );
      const client = yield* server.connect((yield* server.ticket).ticket);
      yield* client.next;
      yield* client.send({
        type: 'subscribe',
        version: 1,
        generation: 1,
        resources: [{topic: 'context-maintenance', project: 'one'}],
      });
      yield* Deferred.await(started);
      // Pace below the adapter batch/rate limits so this reaches admission
      // overflow while the separate processor is still awaiting authorization.
      for (let i = 0; i < MANAGER_LIVE_LIMITS.incomingFrames; i++) {
        yield* client.send({type: 'heartbeat', version: 1});
        yield* Effect.sleep(5);
        expect((yield* server.live.diagnostics).incomingFrames).toBeLessThanOrEqual(MANAGER_LIVE_LIMITS.incomingFrames);
      }
      expect((yield* server.live.diagnostics).incomingFrames).toBe(MANAGER_LIVE_LIMITS.incomingFrames);
      yield* client.send({type: 'heartbeat', version: 1});
      // Must close without waiting for the 1s project-read timeout or releasing
      // authorization. The prior single pull/processing loop fails this bound.
      expect((yield* Effect.result(client.next).pipe(Effect.timeout('500 millis')))._tag).toBe('Failure');
      expect(yield* Deferred.isDone(release)).toBe(false);
      for (let i = 0; i < 100 && (yield* server.live.diagnostics).connections !== 0; i++) yield* Effect.sleep(10);
      expect((yield* server.live.diagnostics).incomingFrames).toBe(0);
      expect((yield* server.live.diagnostics).connections).toBe(0);
    }).pipe(Effect.timeout('5 seconds'), TestClock.withLive, provideLayer),
  );
  effectIt.effect(
    'authenticates real upgrades, acknowledges installed scopes, and releases disconnected sessions',
    () =>
      Effect.gen(function* () {
        const server = yield* serveLive();
        const http = yield* HttpClient.HttpClient;
        const denied = yield* http.post(`${server.origin}/api/live-session`);
        expect(denied.status).toBe(401);
        const issued = yield* server.ticket;
        const foreign = yield* Effect.result(server.connect(issued.ticket, 'https://foreign.invalid'));
        expect(foreign._tag).toBe('Failure');
        const client = yield* server.connect(issued.ticket);
        expect(yield* client.next).toMatchObject({type: 'welcome', topics: ['context-maintenance']});
        expect((yield* Effect.result(server.connect(issued.ticket)))._tag).toBe('Failure');
        yield* client.send({
          type: 'subscribe',
          version: 1,
          generation: 1,
          resources: [{topic: 'context-maintenance', project: 'one'}],
        });
        const ack = yield* client.next;
        expect(ack).toMatchObject({type: 'subscribed', generation: 1, startingSequence: 0});
        for (let i = 0; i < 100; i++) yield* server.live.publish(['context-maintenance'], `revision-${i}`);
        const event = yield* client.next;
        expect(event).toMatchObject({
          type: 'invalidation',
          generation: 1,
          sequence: 1,
          resource: {topic: 'context-maintenance', project: 'one'},
        });
        yield* client.send({
          type: 'subscribe',
          version: 1,
          generation: 2,
          resources: [{topic: 'context-maintenance', project: 'two'}],
        });
        expect(yield* client.next).toMatchObject({type: 'subscribed', generation: 2, startingSequence: 1});
        yield* server.live.publish(['context-health'], 'filtered');
        yield* server.live.publish(['context-maintenance'], 'next');
        expect(yield* client.next).toMatchObject({
          type: 'invalidation',
          generation: 2,
          sequence: 2,
          resource: {project: 'two'},
        });
        yield* client.close;
        for (let i = 0; i < 100 && (yield* server.live.diagnostics).connections !== 0; i++) yield* Effect.sleep(10);
        expect((yield* server.live.diagnostics).connections).toBe(0);
        expect((yield* server.live.diagnostics).pendingResources).toBe(0);
      }).pipe(Effect.timeout('10 seconds'), TestClock.withLive, provideLayer),
  );

  effectIt.effect('rejects unadvertised health subscriptions', () =>
    Effect.gen(function* () {
      const server = yield* serveLive();
      const client = yield* server.connect((yield* server.ticket).ticket);
      expect(yield* client.next).toMatchObject({type: 'welcome', topics: ['context-maintenance']});
      yield* client.send({
        type: 'subscribe',
        version: 1,
        generation: 1,
        resources: [{topic: 'context-health', project: 'one'}],
      });
      expect((yield* Effect.result(client.next))._tag).toBe('Failure');
    }).pipe(Effect.timeout('5 seconds'), TestClock.withLive, provideLayer),
  );

  effectIt.effect('scope invalidation revokes pending tickets and active sockets, then admits fresh sessions', () =>
    Effect.gen(function* () {
      const server = yield* serveLive();
      const client = yield* server.connect((yield* server.ticket).ticket);
      expect((yield* client.next).type).toBe('welcome');
      yield* client.send({
        type: 'subscribe',
        version: 1,
        generation: 1,
        resources: [{topic: 'context-maintenance', project: 'one'}],
      });
      expect(yield* client.next).toMatchObject({type: 'subscribed', generation: 1});
      const pending = yield* server.ticket;
      expect((yield* server.live.diagnostics).tickets).toBe(1);
      yield* server.live.invalidateScope;
      expect((yield* server.live.diagnostics).tickets).toBe(0);
      expect((yield* Effect.result(server.connect(pending.ticket)))._tag).toBe('Failure');
      expect((yield* Effect.result(client.next))._tag).toBe('Failure');
      for (let i = 0; i < 100 && (yield* server.live.diagnostics).connections !== 0; i++) yield* Effect.sleep(10);
      expect((yield* server.live.diagnostics).connections).toBe(0);
      const fresh = yield* server.connect((yield* server.ticket).ticket);
      expect(yield* fresh.next).toMatchObject({type: 'welcome', topics: ['context-maintenance']});
      yield* fresh.close;
    }).pipe(Effect.timeout('10 seconds'), TestClock.withLive, provideLayer),
  );

  for (const invalid of [
    {
      type: 'subscribe',
      version: 1,
      generation: 1,
      resources: [{topic: 'context-maintenance', project: 'not-authorized'}],
    },
    {type: 'subscribe', version: 8, generation: 1, resources: []},
    {type: 'heartbeat', version: 1, unexpected: 'x'},
    {
      type: 'subscribe',
      version: 1,
      generation: 1,
      resources: Array.from({length: 33}, () => ({topic: 'context-maintenance', project: 'one'})),
    },
    'x'.repeat(MANAGER_LIVE_LIMITS.messageBytes + 1),
  ])
    effectIt.effect(`closes a real invalid client: ${JSON.stringify(invalid).slice(0, 95)}`, () =>
      Effect.gen(function* () {
        const server = yield* serveLive();
        const client = yield* server.connect((yield* server.ticket).ticket);
        expect((yield* client.next).type).toBe('welcome');
        yield* client.send(invalid);
        expect((yield* Effect.result(client.next))._tag).toBe('Failure');
      }).pipe(Effect.timeout('5 seconds'), TestClock.withLive, provideLayer),
    );

  effectIt.effect('refuses malformed JSON and an obsolete subscription generation', () =>
    Effect.gen(function* () {
      const server = yield* serveLive();
      const malformed = yield* server.connect((yield* server.ticket).ticket);
      yield* malformed.next;
      yield* malformed.sendRaw('{');
      expect((yield* Effect.result(malformed.next))._tag).toBe('Failure');
      const client = yield* server.connect((yield* server.ticket).ticket);
      yield* client.next;
      const frame = {type: 'subscribe', version: 1, generation: 1, resources: []};
      yield* client.send(frame);
      expect(yield* client.next).toMatchObject({type: 'subscribed', generation: 1});
      yield* client.send(frame);
      expect((yield* Effect.result(client.next))._tag).toBe('Failure');
    }).pipe(Effect.timeout('5 seconds'), TestClock.withLive, provideLayer),
  );

  effectIt.effect('bounds real connections and admits a new connection after cleanup', () =>
    Effect.gen(function* () {
      const server = yield* serveLive();
      const clients = [];
      for (let i = 0; i < MANAGER_LIVE_LIMITS.connections; i++) {
        const client = yield* server.connect((yield* server.ticket).ticket);
        expect((yield* client.next).type).toBe('welcome');
        clients.push(client);
      }
      expect((yield* server.live.diagnostics).connections).toBe(MANAGER_LIVE_LIMITS.connections);
      expect((yield* Effect.result(server.connect((yield* server.ticket).ticket)))._tag).toBe('Failure');
      yield* clients[0].close;
      for (let i = 0; i < 100 && (yield* server.live.diagnostics).connections === MANAGER_LIVE_LIMITS.connections; i++)
        yield* Effect.sleep(10);
      const replacement = yield* server.connect((yield* server.ticket).ticket);
      expect((yield* replacement.next).type).toBe('welcome');
    }).pipe(Effect.timeout('10 seconds'), TestClock.withLive, provideLayer),
  );

  effectIt.effect('expires and bounds tickets before upgrade without exposing the bearer', () =>
    Effect.gen(function* () {
      const origin = 'http://127.0.0.1:44000';
      const live = yield* makeManagerLive({
        origin,
        token: 'synthetic-token',
        projects: Effect.succeed(new Set(['one'])),
      });
      const request = () =>
        HttpServerRequest.fromWeb(
          new Request(`${origin}/api/live-session`, {
            method: 'POST',
            headers: {host: '127.0.0.1:44000', authorization: 'Bearer synthetic-token', origin},
          }),
        );
      const first = (yield* live.handle(request()))!;
      const body = yield* Effect.promise(() => HttpServerResponse.toWeb(first).json());
      const ticket = (body as {ticket: string}).ticket;
      expect(JSON.stringify(body)).not.toContain('synthetic-token');
      for (let i = 1; i < MANAGER_LIVE_LIMITS.tickets; i++) expect((yield* live.handle(request()))?.status).toBe(200);
      expect((yield* live.handle(request()))?.status).toBe(429);
      yield* TestClock.adjust(MANAGER_LIVE_LIMITS.ticketLifetimeMilliseconds);
      const expired = yield* live.handle(
        HttpServerRequest.fromWeb(
          new Request(`${origin}/api/live?ticket=${ticket}`, {
            headers: {host: '127.0.0.1:44000', origin},
          }),
        ),
      );
      expect(expired?.status).toBe(401);
      expect((yield* live.handle(request()))?.status).toBe(200);
    }).pipe(provideLayer),
  );

  effectIt.effect.prop(
    'coalesces scoped latest revisions and resets at the mailbox bound',
    {
      count: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: MANAGER_LIVE_LIMITS.subscriptions})),
      revisions: Schema.Array(Schema.Int).check(Schema.isMaxLength(50)),
    },
    ({count, revisions}) =>
      Effect.sync(() => {
        const mailbox = makeManagerLiveMailbox();
        const resources = Array.from({length: count}, (_, i) => ({
          topic: 'context-maintenance' as const,
          project: `p${i}`,
        }));
        mailbox.replace(resources);
        mailbox.dirty(['context-health'], 'unrelated');
        expect(mailbox.size()).toBe(0);
        for (const revision of revisions) mailbox.dirty(['context-maintenance'], String(revision));
        expect(mailbox.size()).toBeLessThanOrEqual(MANAGER_LIVE_LIMITS.pendingResources);
        const actual = mailbox.drain();
        const overflow = count > MANAGER_LIVE_LIMITS.pendingResources && revisions.length > 0;
        expect(actual.reset).toBe(overflow);
        expect(actual.invalidations).toEqual(
          overflow || revisions.length === 0
            ? []
            : resources.map(resource => ({resource, revision: String(revisions.at(-1))})),
        );
        expect(mailbox.drain()).toEqual({reset: false, invalidations: []});
      }),
    {arbitrary: {runs: 24}},
  );
});
