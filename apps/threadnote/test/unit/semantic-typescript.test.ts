import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {it as effectIt} from '@effect/vitest';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import serverPackage from 'typescript-language-server/package.json' with {type: 'json'};
import sdkPackage from 'typescript/package.json' with {type: 'json'};
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {sha256FileHex} from '@threadnote/platform/digest';
import {CommandExecutor} from '@threadnote/platform/command';
import {Observation, Position} from '@threadnote/semantic/contracts';
import {LspFault, makeLspClient, spawnLspWire, type LspClient} from '../../src/semantic/lsp_transport.js';
import {
  makeTypeScriptRuntime,
  typeScriptPolicyCommand,
  typeScriptPolicyVersion,
} from '../../src/semantic/providers/typescript_runtime.js';
import {makeTypeScriptSession, validTextPosition} from '../../src/semantic/providers/typescript.js';
import {
  makeSemanticCoordinator,
  semanticCandidateKey,
  semanticTreeDigest,
  serveSemanticEndpoint,
  requestSemanticEndpoint,
} from '../../src/semantic/coordinator.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
const observation = (text: string, overrides: Partial<Observation> = {}): Observation => ({
  version: 1,
  repository: 'test-repository',
  worktree: 'file:///test',
  project: 'file:///test',
  configuration: EffectString.repeat(64)('a'),
  toolchain: EffectString.repeat(64)('b'),
  provider: {id: 'typescript-language-server', version: '6.0.2', generation: 0},
  view: {kind: 'overlay', id: 'test-view', owner: 'test-owner', epoch: 0},
  uri: 'file:///test/example.ts',
  content: sha256HexSync(text),
  documentVersion: 1,
  projectEpoch: 0,
  ...overrides,
});
const options = (basis: Observation) => ({
  basis,
  tsserver: '/host/typescript/tsserver.js',
  compiler: '/host/typescript/typescript.js',
  sourceRoot: '/host/typescript',
  verifyPolicy: Effect.void,
  challenge: Effect.succeed(sha256HexSync('test-challenge')),
  maxMemoryMb: 256,
  startupMilliseconds: 1000,
});
const fakeClient = (request: (method: string, params: Schema.Json | undefined) => Effect.Effect<Schema.Json>) =>
  ({
    pid: 1,
    request: (method: string, params?: Schema.Json, _milliseconds?: number): Effect.Effect<Schema.Json> => {
      if (method === 'initialize') return Effect.succeed({capabilities: {positionEncoding: 'utf-16'}});
      if (
        method === 'workspace/executeCommand' &&
        typeof params === 'object' &&
        params !== null &&
        'arguments' in params &&
        EffectArray.isArray(params.arguments) &&
        params.arguments[0] === typeScriptPolicyCommand
      ) {
        const challenge = Schema.decodeUnknownSync(Schema.Struct({challenge: Schema.String}))(
          params.arguments[1],
        ).challenge;
        return Effect.succeed({
          success: true,
          body: {
            policy: typeScriptPolicyVersion,
            launcher: '/host/typescript/tsserver.js',
            compiler: '/host/typescript/typescript.js',
            version: '6.0.3',
            pid: 2,
            instance: sha256HexSync('test-instance'),
            challenge,
            locked: true,
          },
        });
      }
      if (
        method === 'workspace/executeCommand' &&
        typeof params === 'object' &&
        params !== null &&
        'arguments' in params &&
        EffectArray.isArray(params.arguments) &&
        params.arguments[0] === 'projectInfo'
      )
        return Effect.succeed({success: true, body: {configFileName: '/test/tsconfig.json', fileNames: []}});
      return request(method, params);
    },
    notify: () => Effect.void,
    close: Effect.succeed({code: 0, drained: true, forced: false, stdioClosed: true, fault: undefined, graceful: true}),
  }) satisfies LspClient;
const tsDiagnostic = {
  message: 'Type mismatch',
  start: 0,
  length: 1,
  startLocation: {line: 1, offset: 1},
  endLocation: {line: 1, offset: 2},
  category: 'error',
  code: 2322,
};
describe('TypeScript observation fences', () => {
  effectIt.effect('keeps disk observations versionless while using monotonic wire versions', () =>
    Effect.gen(function* () {
      const notifications: Schema.Json[] = [];
      const first = observation('x', {
        view: {kind: 'disk', id: 'disk', owner: 'reader', epoch: 0},
        documentVersion: null,
      });
      const client = {
        ...fakeClient(() => Effect.succeed(null)),
        notify: (_method: string, params: Schema.Json) =>
          Effect.sync(() => {
            notifications.push(params);
          }),
      };
      const session = yield* makeTypeScriptSession(client, options(first));
      const a = yield* session.upsert(first, 'x', 'typescript', 1000);
      const b = yield* session.upsert({...first, content: sha256HexSync('y')}, 'y', 'typescript', 1000);
      expect(a.documentVersion).toBeNull();
      expect(b.documentVersion).toBeNull();
      expect(b.projectEpoch).toBeGreaterThan(a.projectEpoch);
      expect(notifications.slice(1)).toMatchObject([{textDocument: {version: 1}}, {textDocument: {version: 2}}]);
      expect((yield* session.query('definition', a, {line: 0, character: 0}, 1000)).status).toBe('stale');
    }),
  );
  effectIt.effect('invalidates unchanged documents when another overlay document changes', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const response = yield* Deferred.make<Schema.Json>();
      const text = 'let x = 1;';
      const a = observation(text);
      const session = yield* makeTypeScriptSession(
        fakeClient(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(response)))),
        options(a),
      );
      yield* session.upsert(a, text, 'typescript', 1000);
      const b = observation('export const y = 1;', {uri: 'file:///test/dependency.ts'});
      yield* session.upsert(b, 'export const y = 1;', 'typescript', 1000);
      expect((yield* session.query('definition', a, {line: 0, character: 4}, 1000)).status).toBe('stale');
      const rebound = yield* session.upsert(a, text, 'typescript', 1000);
      expect(rebound.projectEpoch).toBeGreaterThan(a.projectEpoch);
      const pending = yield* Effect.forkChild(session.query('definition', rebound, {line: 0, character: 4}, 1000));
      yield* Deferred.await(started);
      yield* session.upsert(
        observation('export const y = 2;', {uri: b.uri, documentVersion: 2}),
        'export const y = 2;',
        'typescript',
        1000,
      );
      yield* Deferred.succeed(response, null);
      expect((yield* Fiber.join(pending)).status).toBe('stale');
      const current = yield* session.upsert(rebound, text, 'typescript', 1000);
      expect(current.documentVersion).toBe(rebound.documentVersion);
      expect(current.content).toBe(rebound.content);
      expect(current.projectEpoch).toBeGreaterThan(rebound.projectEpoch);
      expect((yield* session.query('definition', current, {line: 0, character: 4}, 1000)).status).toBe('ok');
    }),
  );
  effectIt.effect('refuses unguarded or mismatched launcher proof before opening any source', () =>
    Effect.gen(function* () {
      for (const mode of ['missing', 'launcher', 'unlocked', 'challenge'] as const) {
        const base = fakeClient(() => Effect.succeed(null));
        const notifications: string[] = [];
        const client: LspClient = {
          ...base,
          notify: method =>
            Effect.sync(() => {
              notifications.push(method);
            }),
          request: (method, params, milliseconds) =>
            base.request(method, params, milliseconds).pipe(
              Effect.map(raw => {
                if (method !== 'workspace/executeCommand') return raw;
                const proof = Schema.decodeUnknownSync(
                  Schema.Struct({success: Schema.Boolean, body: Schema.Record(Schema.String, Schema.Json)}),
                )(raw);
                if (mode === 'missing') return {success: false};
                return {
                  ...proof,
                  body: {
                    ...proof.body,
                    ...(mode === 'launcher'
                      ? {launcher: '/repo/tsserver.js'}
                      : mode === 'unlocked'
                        ? {locked: false}
                        : {challenge: sha256HexSync('wrong')}),
                  },
                };
              }),
            ),
        };
        expect((yield* makeTypeScriptSession(client, options(observation('x'))).pipe(Effect.exit))._tag).toBe(
          'Failure',
        );
        expect(notifications).toEqual(['initialized']);
      }
    }),
  );
  effectIt.effect('invalidates the session when the guarded child process instance changes', () =>
    Effect.gen(function* () {
      const basis = observation('x');
      const base = fakeClient(() => Effect.succeed([]));
      let generation = 0;
      let reads = 0;
      const client: LspClient = {
        ...base,
        request: (method, params, milliseconds) =>
          base.request(method, params, milliseconds).pipe(
            Effect.map(raw => {
              if (method === 'textDocument/definition') reads++;
              if (
                method !== 'workspace/executeCommand' ||
                !Schema.is(Schema.Struct({body: Schema.Struct({instance: Schema.String})}))(raw)
              )
                return raw;
              const proof = Schema.decodeUnknownSync(
                Schema.Struct({success: Schema.Boolean, body: Schema.Record(Schema.String, Schema.Json)}),
              )(raw);
              return {...proof, body: {...proof.body, instance: sha256HexSync(String(generation))}};
            }),
          ),
      };
      const session = yield* makeTypeScriptSession(client, options(basis));
      const current = yield* session.upsert(basis, 'x', 'typescript', 1000);
      generation++;
      expect((yield* session.query('definition', current, {line: 0, character: 0}, 1000).pipe(Effect.exit))._tag).toBe(
        'Failure',
      );
      expect(yield* session.available).toBe(false);
      expect(reads).toBe(0);
      expect(yield* session.observation(current.uri)).toBeUndefined();
    }),
  );
  it('candidate identity ignores object insertion order without merging different installations', () => {
    const candidate = {
      runtime: '/host/node',
      runtimeDigest: EffectString.repeat(64)('a'),
      runtimeVersion: '24.19.0' as const,
      serverDirectory: '/host/tls',
      serverTreeDigest: EffectString.repeat(64)('b'),
      sdkDirectory: '/host/sdk',
      sdkTreeDigest: EffectString.repeat(64)('c'),
    };
    const entries = EffectRecord.toEntries(candidate);
    fc.assert(
      fc.property(fc.shuffledSubarray(entries, {minLength: entries.length, maxLength: entries.length}), shuffled => {
        const reordered = EffectRecord.fromEntries(shuffled);
        const candidateSchema = Schema.Struct({
          runtime: Schema.String,
          runtimeDigest: Schema.String,
          runtimeVersion: Schema.Literal('24.19.0'),
          serverDirectory: Schema.String,
          serverTreeDigest: Schema.String,
          sdkDirectory: Schema.String,
          sdkTreeDigest: Schema.String,
        });
        if (!Schema.is(candidateSchema)(reordered)) throw new Error('Incomplete candidate permutation');
        expect(semanticCandidateKey(reordered)).toBe(semanticCandidateKey(candidate));
      }),
      {numRuns: 100},
    );
    expect(semanticCandidateKey({...candidate, sdkTreeDigest: EffectString.repeat(64)('d')})).not.toBe(
      semanticCandidateKey(candidate),
    );
  });
  it('uses UTF-16 positions without splitting surrogate pairs under CRLF', () => {
    expect(validTextPosition('a🧵\r\nb', {line: 0, character: 1})).toBe(true);
    expect(validTextPosition('a🧵\r\nb', {line: 0, character: 2})).toBe(false);
    expect(validTextPosition('a🧵\r\nb', {line: 0, character: 4})).toBe(false);
    expect(validTextPosition('a🧵\r\nb', {line: 1, character: 1})).toBe(true);
  });
  it('accepts every ordinary UTF-16 boundary in bounded ASCII documents', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.integer({min: 32, max: 126}), {maxLength: 50}), {minLength: 1, maxLength: 10}),
        rows => {
          const text = EffectArray.join(
            EffectArray.map(rows, row => String.fromCharCode(...row)),
            '\r\n',
          );
          EffectArray.forEach(rows, (row, line) => {
            for (let character = 0; character <= row.length; character++)
              expect(validTextPosition(text, {line, character})).toBe(true);
            expect(validTextPosition(text, {line, character: row.length + 1})).toBe(false);
          });
        },
      ),
      {numRuns: 100},
    );
  });
  effectIt.effect('never relabels an older response after a document change', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<Schema.Json>();
      const client = fakeClient(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(answer))),
      );
      const first = observation('let x = 1;');
      const session = yield* makeTypeScriptSession(client, options(first));
      yield* session.upsert(first, 'let x = 1;', 'typescript', 1000);
      const pending = yield* Effect.forkChild(session.query('definition', first, {line: 0, character: 4}, 1000));
      yield* Deferred.await(started);
      const next = observation('let x = 2;', {documentVersion: 2});
      yield* session.upsert(next, 'let x = 2;', 'typescript', 1000);
      yield* Deferred.succeed(answer, null);
      expect((yield* Fiber.join(pending)).status).toBe('stale');
      expect(yield* session.upsert(first, 'let x = 1;', 'typescript', 1000).pipe(Effect.flip)).toMatchObject({
        reason: 'conflict',
      });
      yield* session.invalidate;
      expect((yield* session.query('definition', next, {line: 0, character: 4}, 1000)).status).toBe('stale');
    }),
  );
  effectIt.effect('binds new/resolved/remaining diagnostics to their own observation', () =>
    Effect.gen(function* () {
      let mismatch = true;
      const session = yield* makeTypeScriptSession(
        fakeClient(() => Effect.succeed({success: true, body: mismatch ? [tsDiagnostic] : []})),
        options(observation('x')),
      );
      const a = observation('x');
      yield* session.upsert(a, 'x', 'typescript', 1000);
      const initial = yield* session.diagnostics(a, 1000);
      expect(initial.added).toHaveLength(1);
      expect(initial.evidence).toMatchObject({basis: 'semantic', observation: a, completeness: 'partial'});
      expect((yield* session.diagnostics(a, 1000)).remaining).toHaveLength(1);
      mismatch = false;
      const b = yield* session.upsert(observation('y', {documentVersion: 2}), 'y', 'typescript', 1000);
      const cleared = yield* session.diagnostics(b, 1000);
      expect(cleared.items).toEqual([]);
      expect(cleared.evidence).toMatchObject({basis: 'semantic', observation: b, completeness: 'partial'});
      expect(cleared.resolved).toMatchObject([{observation: a, resolvedIn: b}]);
      const exposed = yield* session.observation(b.uri);
      expect(exposed).toEqual(b);
      if (exposed)
        (
          exposed as {
            projectEpoch: number;
          }
        ).projectEpoch = 99;
      expect(yield* session.observation(b.uri)).toEqual(b);
    }),
  );
  effectIt.effect('does not let an older diagnostic refresh replace a newer one', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const session = yield* makeTypeScriptSession(
        fakeClient(() =>
          Effect.gen(function* () {
            if (++calls === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return {success: true, body: []};
          }),
        ),
        options(observation('x')),
      );
      const a = observation('x');
      yield* session.upsert(a, 'x', 'typescript', 1000);
      const old = yield* Effect.forkChild(session.diagnostics(a, 1000).pipe(Effect.flip));
      yield* Deferred.await(entered);
      expect((yield* session.diagnostics(a, 1000)).items).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(old)).toMatchObject({reason: 'stale'});
    }),
  );
  effectIt.effect('rejects cross-owner, cross-project and malformed source observations', () =>
    Effect.gen(function* () {
      const a = observation('x');
      const session = yield* makeTypeScriptSession(
        fakeClient(() => Effect.succeed(null)),
        options(a),
      );
      for (const changed of [
        observation('x', {view: {...a.view, owner: 'other'}}),
        observation('x', {configuration: EffectString.repeat(64)('c')}),
        observation('x', {project: 'file:///other'}),
        observation('x', {content: EffectString.repeat(64)('d')}),
      ])
        expect(yield* session.upsert(changed, 'x', 'typescript', 1000).pipe(Effect.flip)).toMatchObject({
          reason: 'invalid',
        });
      expect(
        yield* session.upsert(observation('\ud800'), '\ud800', 'typescript', 1000).pipe(Effect.flip),
      ).toMatchObject({reason: 'invalid'});
    }),
  );
});
const io = Layer.merge(BunFileSystem.layer, BunPath.layer);
const coordinatorIo = Layer.mergeAll(io, cryptoLayer, TestSystemInfoLayer);
// Runtime coordination tests inject the version probe and run the real engine on Bun.
// This is not the separate exact-Node candidate qualification smoke.
const versionProbe = CommandExecutor.of({
  execute: (_executable, args) =>
    Effect.sync(() => {
      expect(args).toEqual(['--version']);
      return {exitCode: 0, stdout: 'v24.19.0\n', stderr: ''};
    }),
  executeStreaming: () => Effect.die('Unexpected streaming execution'),
});
const coordinatorFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolveFrom = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({directory: '/tmp', prefix: 'tn6-'}));
  const sdkDirectory = yield* fs.realPath(path.dirname(Bun.resolveSync('typescript/package.json', resolveFrom)));
  const serverDirectory = yield* fs.realPath(
    path.dirname(Bun.resolveSync('typescript-language-server/package.json', resolveFrom)),
  );
  const runtime = yield* fs.realPath(process.execPath);
  const candidate = {
    runtime,
    runtimeDigest: yield* sha256FileHex(runtime),
    runtimeVersion: '24.19.0' as const,
    sdkDirectory,
    sdkTreeDigest: yield* semanticTreeDigest(sdkDirectory),
    serverDirectory,
    serverTreeDigest: yield* semanticTreeDigest(serverDirectory),
  };
  const options = {enabled: true, dataHome: root, candidate};
  const coordinator = yield* makeSemanticCoordinator(options);
  return {fs, path, root, coordinator, candidate};
});
describe.skipIf(process.platform === 'win32')('semantic coordinator with injected runtime version probe', () => {
  effectIt.effect('rejects relative host paths and excluded Git sources before provider execution', () =>
    Effect.gen(function* () {
      const {path, root, candidate, coordinator} = yield* coordinatorFixture;
      for (const field of ['runtime', 'serverDirectory', 'sdkDirectory'] as const) {
        const relative = path.relative(process.cwd(), candidate[field]);
        expect(path.isAbsolute(relative)).toBe(false);
        expect(
          (yield* Effect.exit(
            makeSemanticCoordinator({enabled: true, dataHome: root, candidate: {...candidate, [field]: relative}}),
          ))._tag,
        ).toBe('Failure');
      }
      const uri = (yield* path.toFileUrl(root)).href;
      const metadataSource = observation('x', {worktree: uri, project: uri, uri: uri + '/.git/hidden.ts'});
      expect((yield* Effect.exit(coordinator.attach(metadataSource, 'x', 'typescript')))._tag).toBe('Failure');
      expect((yield* coordinator.status).providers).toBe(0);
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow OS test entrypoint.
      Effect.provide(coordinatorIo),
      Effect.provideService(CommandExecutor, versionProbe),
      Effect.provideService(ChildEnvironmentPolicy, {sanitizeExternal: env => env, preserveIntendedChild: env => env}),
      TestClock.withLive,
    ),
  );
  effectIt.effect.prop(
    'gives concurrent first attachments exactly one durable view capability',
    [Schema.Int.check(Schema.isBetween({minimum: 2, maximum: 6}))],
    ([contenders]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({directory: '/tmp', prefix: 'tn-grant-'}));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let attaches = 0;
        const input = observation('x');
        const endpoint = yield* serveSemanticEndpoint(
          {
            status: Effect.die('Unexpected status'),
            closeView: () => Effect.void,
            use: () => Effect.die('Unexpected query'),
            attach: (input: Observation) =>
              Effect.gen(function* () {
                attaches++;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return {
                  observation: input,
                  status: 'experimental' as const,
                  completeness: 'partial' as const,
                  edits: 'disabled' as const,
                  project: undefined,
                };
              }),
          },
          {directory: root + '/ipc', token: EffectString.repeat(64)('c'), worktree: input.worktree},
        );
        const body = {operation: 'attach' as const, observation: input, text: 'x', language: 'typescript' as const};
        yield* Effect.gen(function* () {
          const first = yield* Effect.forkChild(
            requestSemanticEndpoint(endpoint.socket, EffectString.repeat(64)('c'), body),
          );
          yield* Deferred.await(entered);
          const denied = yield* Effect.all(
            Array.from({length: contenders - 1}, () =>
              requestSemanticEndpoint(endpoint.socket, EffectString.repeat(64)('c'), body),
            ),
            {concurrency: 'unbounded'},
          ).pipe(Effect.timeout(1000));
          expect(denied).toEqual(
            Array.from({length: contenders - 1}, () => expect.objectContaining({reason: 'conflict'})),
          );
          expect(attaches).toBe(1);
          yield* Deferred.succeed(release, undefined);
          const grant = yield* Schema.decodeUnknownEffect(Schema.Struct({capability: Schema.String}))(
            yield* Fiber.join(first),
          );
          expect(
            yield* requestSemanticEndpoint(
              endpoint.socket,
              EffectString.repeat(64)('c'),
              {operation: 'close', observation: input},
              grant.capability,
            ),
          ).toEqual({status: 'closed'});
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      }).pipe(
        Effect.provideService(CommandExecutor, versionProbe),
        Effect.provideService(ChildEnvironmentPolicy, {
          sanitizeExternal: env => env,
          preserveIntendedChild: env => env,
        }),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow real socket and filesystem test entrypoint.
        Effect.provide(coordinatorIo),
        TestClock.withLive,
      ),
    {arbitrary: {runs: 8}, timeout: 30000},
  );
  effectIt.effect('rolls back a failed initial attachment before another client claims its view', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({directory: '/tmp', prefix: 'tn-grant-'}));
      const input = observation('x');
      let attaches = 0;
      let closes = 0;
      const endpoint = yield* serveSemanticEndpoint(
        {
          status: Effect.die('Unexpected status'),
          use: () => Effect.die('Unexpected query'),
          closeView: () =>
            Effect.sync(() => {
              closes++;
            }),
          attach: (input: Observation) =>
            Effect.suspend(() => {
              if (++attaches === 1) return Effect.fail(LspFault.make({code: 'rejected'}));
              return Effect.succeed({
                observation: input,
                status: 'experimental' as const,
                completeness: 'partial' as const,
                edits: 'disabled' as const,
                project: undefined,
              });
            }),
        },
        {directory: root + '/ipc', token: EffectString.repeat(64)('c'), worktree: input.worktree},
      );
      const body = {operation: 'attach' as const, observation: input, text: 'x', language: 'typescript' as const};
      expect(yield* requestSemanticEndpoint(endpoint.socket, EffectString.repeat(64)('c'), body)).toMatchObject({
        reason: 'rejected',
      });
      expect(closes).toBe(1);
      const grant = yield* Schema.decodeUnknownEffect(Schema.Struct({capability: Schema.String}))(
        yield* requestSemanticEndpoint(endpoint.socket, EffectString.repeat(64)('c'), body),
      );
      expect(grant.capability).toMatch(/^[a-f0-9]{64}$/u);
      expect(attaches).toBe(2);
      expect(
        yield* requestSemanticEndpoint(
          endpoint.socket,
          EffectString.repeat(64)('c'),
          {operation: 'close', observation: input},
          grant.capability,
        ),
      ).toEqual({status: 'closed'});
      expect(closes).toBe(2);
    }).pipe(
      Effect.provideService(ChildEnvironmentPolicy, {sanitizeExternal: env => env, preserveIntendedChild: env => env}),
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow real socket and filesystem test entrypoint.
      Effect.provide(coordinatorIo),
      TestClock.withLive,
    ),
  );
  effectIt.effect(
    'rejects a disk change between the initial content check and project fingerprint and drains its provider',
    () =>
      Effect.gen(function* () {
        const {fs, path, root, candidate} = yield* coordinatorFixture;
        const repo = path.join(root, 'repo');
        const file = path.join(repo, 'main.ts');
        yield* fs.makeDirectory(repo);
        yield* fs.writeFileString(path.join(repo, 'tsconfig.json'), '{"files":["main.ts"]}');
        const before = 'const x: number = 1;\nx;\n';
        const after = 'const x: string = "new disk";\nx;\n';
        yield* fs.writeFileString(file, before);
        const uri = (yield* path.toFileUrl(repo)).href;
        let armed = true;
        let writes = 0;
        const wrapped = {
          ...fs,
          stat: (name: string) =>
            Effect.gen(function* () {
              if (name === file && armed) {
                armed = false;
                yield* fs.writeFileString(file, after);
                writes++;
              }
              return yield* fs.stat(name);
            }),
        };
        yield* Effect.gen(function* () {
          const coordinator = yield* makeSemanticCoordinator({enabled: true, dataHome: root, candidate});
          const input = observation(before, {
            worktree: uri,
            project: uri,
            uri: uri + '/main.ts',
            view: {kind: 'disk', id: 'disk', owner: 'reader', epoch: 0},
            documentVersion: null,
          });
          expect(yield* coordinator.attach(input, before, 'typescript').pipe(Effect.flip)).toMatchObject({
            code: 'rejected',
          });
          expect(writes).toBe(1);
          expect(yield* fs.readFileString(file)).toBe(after);
          expect(yield* coordinator.status).toMatchObject({sessions: 0, providers: 0, imports: 0});
        }).pipe(Effect.provideService(FileSystem.FileSystem, wrapped));
      }).pipe(
        Effect.provideService(CommandExecutor, versionProbe),
        Effect.provideService(ChildEnvironmentPolicy, {
          sanitizeExternal: env => env,
          preserveIntendedChild: env => env,
        }),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow real provider and filesystem test entrypoint.
        Effect.provide(coordinatorIo),
        TestClock.withLive,
      ),
    30000,
  );
  effectIt.effect('reads project configuration and Git metadata without an unbounded text read', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'semantic-config-'}));
      yield* fs.writeFileString(path.join(root, 'tsconfig.json'), '{"compilerOptions":{}}');
      yield* fs.makeDirectory(path.join(root, '.git'));
      yield* fs.writeFileString(path.join(root, '.git', 'HEAD'), '0123456789abcdef\n');
      const wrapped = {...fs, readFileString: () => Effect.die('Unbounded text read')};
      const digest = yield* semanticTreeDigest(root, true).pipe(Effect.provideService(FileSystem.FileSystem, wrapped));
      expect(digest).toMatch(/^[a-f0-9]{64}$/u);
      yield* fs.writeFileString(path.join(root, 'tsconfig.json'), EffectString.repeat(1024 * 1024 + 1)(' '));
      expect(yield* semanticTreeDigest(root, true).pipe(Effect.flip)).toMatchObject({code: 'capacity'});
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow filesystem test entrypoint.
      Effect.provide(coordinatorIo),
      TestClock.withLive,
    ),
  );
  effectIt.effect(
    'caps crash retries, reports their cause and releases each proven dead provider',
    () =>
      Effect.gen(function* () {
        const {fs, path, root, candidate} = yield* coordinatorFixture;
        const badServer = path.join(root, 'bad-server');
        yield* fs.makeDirectory(path.join(badServer, 'lib'), {recursive: true});
        yield* fs.writeFileString(path.join(badServer, 'package.json'), '{"version":"6.0.2"}');
        yield* fs.writeFileString(path.join(badServer, 'lib', 'cli.mjs'), 'process.exit(1);');
        const coordinator = yield* makeSemanticCoordinator({
          enabled: true,
          dataHome: root,
          candidate: {...candidate, serverDirectory: badServer, serverTreeDigest: yield* semanticTreeDigest(badServer)},
        });
        const repo = path.join(root, 'repo');
        yield* fs.makeDirectory(repo);
        yield* fs.writeFileString(path.join(repo, 'tsconfig.json'), '{"files":["main.ts"]}');
        yield* fs.writeFileString(path.join(repo, 'main.ts'), 'const x = 1;');
        const uri = (yield* path.toFileUrl(repo)).href;
        const source = observation('const x = 1;', {worktree: uri, project: uri, uri: uri + '/main.ts'});
        for (let attempt = 0; attempt < 3; attempt++)
          expect(yield* coordinator.attach(source, 'const x = 1;', 'typescript').pipe(Effect.flip)).toMatchObject({
            code: 'prerequisite',
          });
        const status = yield* coordinator.status;
        expect(status).toMatchObject({providers: 0, imports: 0, queued: 0, sessions: 0});
        expect(status.failures).toEqual([expect.objectContaining({attempts: 2, cause: 'startup'})]);
      }).pipe(
        Effect.provideService(CommandExecutor, versionProbe),
        Effect.provideService(ChildEnvironmentPolicy, {
          sanitizeExternal: env => env,
          preserveIntendedChild: env => env,
        }),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow OS coordinator test entrypoint.
        Effect.provide(coordinatorIo),
        TestClock.withLive,
      ),
    20000,
  );
  effectIt.effect(
    'selects each monorepo dependency version and denies repository plugin/build execution',
    () =>
      Effect.gen(function* () {
        const {fs, path, root, coordinator} = yield* coordinatorFixture;
        const repo = path.join(root, 'repo');
        yield* fs.makeDirectory(repo);
        yield* fs.writeFileString(path.join(repo, 'base.json'), '{/* shared */"compilerOptions":{"strict":true}}');
        const worktree = (yield* path.toFileUrl(repo)).href;
        const marker = path.join(root, 'executed');
        const opened = [];
        for (const [name, type, version] of [
          ['left', 'number', '1.0.0'],
          ['right', 'string', '2.0.0'],
        ]) {
          const project = path.join(repo, name);
          const dependency = path.join(project, 'node_modules', 'demo');
          const plugin = path.join(project, 'node_modules', 'trap-plugin');
          yield* fs.makeDirectory(dependency, {recursive: true});
          yield* fs.makeDirectory(plugin, {recursive: true});
          yield* fs.writeFileString(
            path.join(dependency, 'package.json'),
            JSON.stringify({name: 'demo', version, types: 'index.d.ts'}),
          );
          yield* fs.writeFileString(path.join(dependency, 'index.d.ts'), `export declare const value: ${type};\n`);
          yield* fs.writeFileString(
            path.join(plugin, 'package.json'),
            '{"name":"trap-plugin","version":"1.0.0","main":"index.js"}',
          );
          yield* fs.writeFileString(
            path.join(plugin, 'index.js'),
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'plugin'); module.exports = () => ({});`,
          );
          yield* fs.writeFileString(
            path.join(project, 'package.json'),
            JSON.stringify({scripts: {postinstall: `touch ${marker}`, build: `touch ${marker}`}}),
          );
          yield* fs.writeFileString(
            path.join(project, 'tsconfig.json'),
            JSON.stringify({
              extends: '../base.json',
              compilerOptions: {strict: true},
              files: ['main.ts'],
            }),
          );
          const text = 'import {value} from "demo";\nvalue;\n';
          yield* fs.writeFileString(path.join(project, 'main.ts'), text);
        }
        // Finish the disk snapshot before attaching either project.
        for (const [name, type] of [
          ['left', 'number'],
          ['right', 'string'],
        ]) {
          const project = (yield* path.toFileUrl(path.join(repo, name))).href;
          const text = 'import {value} from "demo";\nvalue;\n';
          const attached = yield* coordinator.attach(
            observation(text, {
              worktree,
              project,
              uri: project + '/main.ts',
              view: {kind: 'overlay', id: name, owner: name, epoch: 0},
            }),
            text,
            'typescript',
          );
          opened.push(attached.observation);
          expect(attached.project?.configuration).toBe(path.join(repo, name, 'tsconfig.json'));
          const hover = yield* coordinator.use(attached.observation, 10000, api =>
            api.query('hover', attached.observation, {line: 1, character: 0}, 10000),
          );
          expect(JSON.stringify(hover)).toContain(`value: ${type}`);
          const definition = yield* coordinator.use(attached.observation, 10000, api =>
            api.query('definition', attached.observation, {line: 1, character: 0}, 10000),
          );
          expect(JSON.stringify(definition)).toContain(`/${name}/node_modules/demo/index.d.ts`);
          if (definition.status === 'ok') expect(definition.evidence.completeness).toBe('partial');
        }
        expect(yield* fs.exists(marker)).toBe(false);
        yield* fs.writeFileString(
          path.join(repo, 'base.json'),
          JSON.stringify({compilerOptions: {plugins: [{name: 'trap-plugin'}]}}),
        );
        expect(yield* semanticTreeDigest(repo, true).pipe(Effect.flip)).toMatchObject({code: 'prerequisite'});
        expect(yield* fs.exists(marker)).toBe(false);
        yield* fs.writeFileString(path.join(repo, 'base.json'), '{"compilerOptions":{"strict":true}}');
        // An external config cannot supply an analysis basis that the selected worktree fingerprint never covers.
        yield* fs.writeFileString(path.join(root, 'outside.json'), '{"compilerOptions":{}}');
        yield* fs.writeFileString(
          path.join(repo, 'left', 'tsconfig.json'),
          '{"extends":"../../outside.json","files":["main.ts"]}',
        );
        expect(yield* semanticTreeDigest(repo, true).pipe(Effect.flip)).toMatchObject({code: 'prerequisite'});
        for (const observation of opened) yield* coordinator.closeView(observation);
      }).pipe(
        Effect.provideService(CommandExecutor, versionProbe),
        Effect.provideService(ChildEnvironmentPolicy, {
          sanitizeExternal: env => env,
          preserveIntendedChild: env => env,
        }),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow OS coordinator test entrypoint.
        Effect.provide(coordinatorIo),
        TestClock.withLive,
      ),
    45000,
  );
  effectIt.effect(
    'isolates worktrees and client overlays, authenticates IPC and fences disk changes',
    () =>
      Effect.gen(function* () {
        const {fs, path, root, coordinator, candidate} = yield* coordinatorFixture;
        const other = yield* makeSemanticCoordinator({enabled: true, dataHome: root, candidate});
        const aRoot = path.join(root, 'a');
        const bRoot = path.join(root, 'b');
        for (const directory of [aRoot, bRoot]) {
          yield* fs.makeDirectory(directory);
          yield* fs.writeFileString(
            path.join(directory, 'tsconfig.json'),
            '{"compilerOptions":{"strict":true},"files":["main.ts"]}',
          );
          yield* fs.writeFileString(path.join(directory, 'main.ts'), 'const x: number = 1;\nx;\n');
        }
        const aUri = (yield* path.toFileUrl(aRoot)).href;
        const bUri = (yield* path.toFileUrl(bRoot)).href;
        const source = 'const x: number = 1;\nx;\n';
        const a = observation(source, {worktree: aUri, project: aUri, uri: aUri + '/main.ts'});
        const bText = 'const x: string = "other worktree";\nx;\n';
        const b = observation(bText, {worktree: bUri, project: bUri, uri: bUri + '/main.ts'});
        const first = yield* coordinator.attach(a, source, 'typescript');
        const second = yield* other.attach(b, bText, 'typescript');
        expect(yield* coordinator.status).toMatchObject({providers: 2, sessions: 1});
        expect(yield* other.status).toMatchObject({providers: 2, sessions: 1});
        expect(first.observation.configuration).not.toBe(a.configuration);
        expect(first.observation.provider.generation).not.toBe(second.observation.provider.generation);
        const hoverA = yield* coordinator.use(first.observation, 10000, api =>
          api.query('hover', first.observation, {line: 1, character: 0}, 10000),
        );
        const hoverB = yield* other.use(second.observation, 10000, api =>
          api.query('hover', second.observation, {line: 1, character: 0}, 10000),
        );
        expect(JSON.stringify(hoverA)).toContain('number');
        expect(JSON.stringify(hoverB)).toContain('string');
        const token = EffectString.repeat(64)('c');
        const endpoint = yield* serveSemanticEndpoint(coordinator, {
          directory: path.join(root, 'ipc'),
          token,
          worktree: aUri,
        });
        expect(
          yield* requestSemanticEndpoint(endpoint.socket, EffectString.repeat(64)('d'), {operation: 'status'}),
        ).toEqual({
          status: 'unavailable',
        });
        const overlayText = 'const x: boolean = true;\nx;\n';
        const overlay = observation(overlayText, {
          ...a,
          content: sha256HexSync(overlayText),
          view: {...a.view, id: 'second-view', owner: 'second-owner'},
        });
        const attached = yield* requestSemanticEndpoint(endpoint.socket, token, {
          operation: 'attach',
          observation: overlay,
          text: overlayText,
          language: 'typescript',
        });
        const grant = yield* Schema.decodeUnknownEffect(
          Schema.Struct({observation: Observation, capability: Schema.String}),
        )(attached);
        const actual = grant.observation;
        const query = {
          operation: 'query' as const,
          observation: actual,
          query: 'hover' as const,
          position: {line: 1, character: 0},
          milliseconds: 10000,
        };
        expect(yield* requestSemanticEndpoint(endpoint.socket, token, query)).toMatchObject({
          status: 'unavailable',
          reason: 'conflict',
        });
        const answer = yield* requestSemanticEndpoint(endpoint.socket, token, query, grant.capability);
        expect(JSON.stringify(answer)).toContain('const x: true');
        expect(
          JSON.stringify(
            yield* coordinator.use(first.observation, 10000, api =>
              api.query('hover', first.observation, {line: 1, character: 0}, 10000),
            ),
          ),
        ).toContain('number');
        const hung = yield* Effect.forkChild(coordinator.use(actual, 50, () => Effect.never).pipe(Effect.flip));
        expect(
          (yield* other.use(second.observation, 10000, api =>
            api.query('hover', second.observation, {line: 1, character: 0}, 10000),
          )).status,
        ).toBe('ok');
        expect(yield* Fiber.join(hung)).toMatchObject({code: 'timeout'});
        expect((yield* coordinator.status).failures).toContainEqual(
          expect.objectContaining({cause: 'timeout', attempts: 1}),
        );
        yield* coordinator.closeView(actual);
        yield* fs.writeFileString(
          path.join(aRoot, 'tsconfig.json'),
          '{"compilerOptions":{"strict":false},"files":["main.ts"]}',
        );
        expect(
          yield* coordinator
            .use(first.observation, 10000, api => api.query('hover', first.observation, {line: 1, character: 0}, 10000))
            .pipe(Effect.flip),
        ).toMatchObject({code: 'rejected'});
        expect(
          (yield* other.use(second.observation, 10000, api =>
            api.query('hover', second.observation, {line: 1, character: 0}, 10000),
          )).status,
        ).toBe('ok');
        yield* other.closeView(second.observation);
        yield* requestSemanticEndpoint(
          endpoint.socket,
          token,
          {operation: 'close', observation: actual},
          grant.capability,
        );
        expect(yield* coordinator.status).toMatchObject({providers: 0});
      }).pipe(
        Effect.provideService(CommandExecutor, versionProbe),
        Effect.provideService(ChildEnvironmentPolicy, {
          sanitizeExternal: env => env,
          preserveIntendedChild: env => env,
        }),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow OS coordinator test entrypoint.
        Effect.provide(coordinatorIo),
        TestClock.withLive,
      ),
    45000,
  );
});
describe.skipIf(process.platform === 'win32')('pinned TypeScript engine read pilot', () => {
  effectIt.effect(
    'resolves aliases and typed occurrences while excluding unrelated same-name members',
    () =>
      Effect.gen(function* () {
        expect(serverPackage.version).toBe('6.0.2');
        expect(sdkPackage.version).toBe('6.0.3');
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resolveFrom = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-semantic-ts-'});
        const uri = (yield* path.toFileUrl(root)).href;
        const source =
          'class Alpha { run() { return 1; } }\nclass Beta { run() { return 2; } }\nconst alias = new Alpha();\nalias.run();\nnew Beta().run();\n';
        const file = path.join(root, 'main.ts');
        const fileUri = (yield* path.toFileUrl(file)).href;
        yield* fs.writeFileString(
          path.join(root, 'tsconfig.json'),
          JSON.stringify({compilerOptions: {strict: true}, files: ['main.ts']}),
        );
        yield* fs.writeFileString(file, source);
        const wire = yield* spawnLspWire({
          command: process.execPath,
          args: [Bun.resolveSync('typescript-language-server/lib/cli.mjs', resolveFrom), '--stdio'],
          cwd: root,
          environment: {},
        });
        const client = yield* makeLspClient(wire);
        const basis = observation(source, {worktree: uri, project: uri, uri: fileUri});
        const privateHome = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn6-ts-host-'}));
        const sdkDirectory = yield* fs.realPath(path.dirname(Bun.resolveSync('typescript/package.json', resolveFrom)));
        const runtime = yield* makeTypeScriptRuntime({
          home: privateHome,
          sdkDirectory,
          sdkTreeDigest: yield* semanticTreeDigest(sdkDirectory),
          worktree: yield* fs.realPath(root),
        });
        const session = yield* makeTypeScriptSession(client, {
          ...options(basis),
          tsserver: runtime.launcher,
          compiler: runtime.compiler,
          sourceRoot: runtime.sourceRoot,
          verifyPolicy: runtime.verify,
          startupMilliseconds: 15000,
        });
        yield* session.upsert(basis, source, 'typescript', 15000);
        const position: Position = {line: 3, character: 7};
        const definition = yield* session.query('definition', basis, position, 5000);
        expect(definition.status).toBe('ok');
        if (definition.status === 'ok')
          expect(definition.items).toMatchObject([{uri: fileUri, range: {start: {line: 0}}}]);
        const references = yield* session.query('references', basis, position, 5000);
        expect(references.status).toBe('ok');
        if (references.status === 'ok') {
          const lines = EffectArray.map(
            references.items,
            item =>
              Schema.decodeUnknownSync(Schema.Struct({range: Schema.Struct({start: Position})}))(item).range.start.line,
          );
          expect(lines.sort()).toEqual([0, 3]);
          expect(references.evidence.completeness).toBe('partial');
        }
        const broken = source + 'const broken: number = "text";\n';
        const next = yield* session.upsert(
          observation(broken, {...basis, content: sha256HexSync(broken), documentVersion: 2}),
          broken,
          'typescript',
          5000,
        );
        const diagnostics = yield* session.diagnostics(next, 10000);
        expect(EffectArray.some(diagnostics.added, item => item.code === 2322)).toBe(true);
        const fixed = yield* session.upsert(
          observation(source, {...basis, documentVersion: 3}),
          source,
          'typescript',
          5000,
        );
        const delta = yield* session.diagnostics(fixed, 10000);
        expect(EffectArray.some(delta.resolved, ({item}) => item.code === 2322)).toBe(true);
        expect(
          EffectArray.every(
            delta.resolved,
            item => item.observation.documentVersion === 2 && item.resolvedIn.documentVersion === 3,
          ),
        ).toBe(true);
        const javascript =
          '// @ts-check\n/** @param {number} value */\nfunction twice(value) { return value * 2; }\ntwice("bad");\n';
        const jsInput = observation(javascript, {
          ...basis,
          uri: basis.project + '/extra.js',
          content: sha256HexSync(javascript),
        });
        const js = yield* session.upsert(jsInput, javascript, 'javascript', 5000);
        expect(EffectArray.some((yield* session.diagnostics(js, 10000)).items, item => item.code === 2345)).toBe(true);
        expect(yield* client.close).toEqual({
          graceful: true,
          code: 0,
          drained: true,
          stdioClosed: true,
          forced: false,
          fault: undefined,
        });
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow OS test entrypoint.
        Effect.provide(coordinatorIo),
        Effect.provideService(ChildEnvironmentPolicy, {
          sanitizeExternal: env => env,
          preserveIntendedChild: env => env,
        }),
        TestClock.withLive,
      ),
    30000,
  );
});
