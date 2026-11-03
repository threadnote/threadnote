import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Clock,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schema,
  String as EffectString,
} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {canonicalFileUri, Counter, type Observation, type QueryOutcome} from '@threadnote/semantic/contracts';
import type {Continuation} from '@threadnote/semantic/views';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {makeSemanticAgentQueryStore, semanticAgentQueryLimits} from '../../src/semantic/agent_query_store.js';
import {
  readSemanticHostProfile,
  semanticHostProfileName,
  SemanticHostProfileFault,
} from '../../src/semantic/host_profile.js';
import {runSemanticAgentQueryWith, type SemanticAgentQueryHost} from '../../src/semantic/agent_queries.js';
import {SemanticAgentQueryResult} from '../../src/semantic/agent_query_protocol.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
import {LspFault} from '../../src/semantic/lsp_transport.js';

const profileIo = Layer.merge(BunServices.layer, TestSystemInfoLayer);
const queryIo = Layer.merge(profileIo, TestCommandExecutorLayer.pipe(Layer.provide(profileIo)));

const observation = (): Observation => ({
  version: 1,
  repository: 'repo',
  worktree: 'file:///repo',
  project: 'file:///repo',
  configuration: sha256HexSync('config'),
  toolchain: sha256HexSync('tools'),
  provider: {id: 'typescript-language-server', version: '6.0.2', generation: 1},
  view: {kind: 'disk', id: 'disk', owner: 'host', epoch: 0},
  uri: 'file:///repo/source.ts',
  content: sha256HexSync('source'),
  documentVersion: null,
  projectEpoch: 1,
});
const outcome = (items: readonly Schema.Json[], observed = observation()): Extract<QueryOutcome, {status: 'ok'}> => ({
  version: 1,
  status: 'ok',
  evidence: {
    basis: 'semantic',
    observation: observed,
    scope: 'project:fixture',
    completeness: 'partial',
    limitations: ['Fixture scope'],
  },
  items,
});

describe('coordinator retained semantic pages', () => {
  it('clones retained provider items without mutating or aliasing the input', () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), {maxLength: 60}), values => {
        const original = [...values];
        const store = makeSemanticAgentQueryStore('private namespace', () => Effect.succeed(observation()));
        const snapshot = store.retain(sha256HexSync('query'), outcome(values), 0);
        expect(values).toEqual(original);
        values.push(-1);
        expect(snapshot?.items).toEqual(original);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot?.items)).toBe(true);
      }),
      {numRuns: 32},
    );
  });
  effectIt.effect.prop(
    'bounded pages reconstruct the original ordered immutable set',
    [
      Schema.Array(Schema.String.check(Schema.isMaxLength(80))).check(Schema.isMaxLength(60)),
      Counter.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(12)),
      Counter.check(Schema.isGreaterThanOrEqualTo(3200), Schema.isLessThanOrEqualTo(8192)),
    ],
    ([values, maxItems, maxBytes]) =>
      Effect.gen(function* () {
        const current = observation();
        let observations = 0;
        const store = makeSemanticAgentQueryStore('private namespace', () =>
          Effect.sync(() => {
            observations++;
            return structuredClone(current);
          }),
        );
        const items = EffectArray.map(values, (value, ordinal) => ({ordinal, value}));
        const expected = structuredClone(items);
        const binding = sha256HexSync('query');
        const snapshot = store.retain(binding, outcome(items, current), yield* Clock.currentTimeMillis);
        expect(snapshot).toBeDefined();
        if (!snapshot) throw new Error('Valid bounded fixture was not retained');
        items.push({ordinal: -1, value: 'not in retained evidence'});
        const collected: Schema.Json[] = [];
        let cursor: Continuation | undefined;
        let pages = 0;
        do {
          const page = yield* store.page(binding, snapshot.id, {maxItems, maxBytes}, 10000, cursor);
          expect(page.status).toBe('ok');
          if (page.status !== 'ok') throw new Error('Page unexpectedly unavailable');
          expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(maxBytes);
          expect(page.items.length).toBeLessThanOrEqual(maxItems);
          expect(page.evidence.observation).toEqual(current);
          collected.push(...page.items);
          cursor = page.next ?? undefined;
          pages++;
          expect(pages).toBeLessThanOrEqual(expected.length + 1);
        } while (cursor);
        expect(collected).toEqual(expected);
        expect(observations).toBe(pages);
      }),
    {arbitrary: {runs: 32}},
  );

  effectIt.effect('refuses changed observations and never substitutes refreshed query items', () =>
    Effect.gen(function* () {
      let current = observation();
      const store = makeSemanticAgentQueryStore('private namespace', () => Effect.succeed(current));
      const binding = sha256HexSync('query');
      const snapshot = store.retain(binding, outcome([1, 2, 3], current), yield* Clock.currentTimeMillis);
      if (!snapshot) throw new Error('Missing fixture snapshot');
      const first = yield* store.page(binding, snapshot.id, {maxItems: 1, maxBytes: 4096}, 10000);
      if (first.status !== 'ok' || !first.next) throw new Error('Missing fixture continuation');
      current = {...current, content: sha256HexSync('changed'), projectEpoch: 2};
      const next = yield* store.page(binding, snapshot.id, {maxItems: 1, maxBytes: 4096}, 10000, first.next);
      expect(next.status).toBe('stale');
      expect(store.status()).toEqual({snapshots: 0, retainedBytes: 0});
    }),
  );

  effectIt.effect('binds snapshots to the query and rejects invalid cursor offsets', () =>
    Effect.gen(function* () {
      let reads = 0;
      const store = makeSemanticAgentQueryStore('private namespace', () =>
        Effect.sync(() => {
          reads++;
          return observation();
        }),
      );
      const binding = sha256HexSync('query');
      const snapshot = store.retain(binding, outcome([1, 2, 3]), yield* Clock.currentTimeMillis);
      if (!snapshot) throw new Error('Missing fixture snapshot');
      const foreign = yield* store.page(sha256HexSync('foreign'), snapshot.id, {maxItems: 1, maxBytes: 4096}, 10000);
      expect(foreign.status).toBe('stale');
      expect(reads).toBe(0);
      const first = yield* store.page(binding, snapshot.id, {maxItems: 1, maxBytes: 4096}, 10000);
      if (first.status !== 'ok' || !first.next) throw new Error('Missing fixture continuation');
      for (const offset of [0, 3, 100]) {
        const invalid = yield* store.page(binding, snapshot.id, {maxItems: 1, maxBytes: 4096}, 10000, {
          ...first.next,
          offset,
        });
        expect(invalid.status).toBe('invalid-cursor');
      }
    }),
  );

  effectIt.effect('expires snapshots on the test clock without requerying a provider', () =>
    Effect.gen(function* () {
      let reads = 0;
      const store = makeSemanticAgentQueryStore('private namespace', () =>
        Effect.sync(() => {
          reads++;
          return observation();
        }),
      );
      const binding = sha256HexSync('query');
      const snapshot = store.retain(binding, outcome([1]), yield* Clock.currentTimeMillis);
      if (!snapshot) throw new Error('Missing fixture snapshot');
      yield* TestClock.adjust(semanticAgentQueryLimits.ttlMilliseconds);
      expect((yield* store.page(binding, snapshot.id, {maxItems: 1, maxBytes: 4096}, 10000)).status).toBe('stale');
      expect(reads).toBe(0);
      expect(store.status()).toEqual({snapshots: 0, retainedBytes: 0});
    }),
  );

  effectIt.effect('enforces count, aggregate and individual serialized retention limits', () =>
    Effect.gen(function* () {
      const store = makeSemanticAgentQueryStore('private namespace', () => Effect.succeed(observation()));
      const firstBinding = sha256HexSync('query0');
      const first = store.retain(firstBinding, outcome([0]), 0);
      if (!first) throw new Error('Missing fixture snapshot');
      for (let i = 1; i <= semanticAgentQueryLimits.maxSnapshots; i++)
        store.retain(sha256HexSync('query' + i), outcome([i]), 0);
      expect(store.status().snapshots).toBe(semanticAgentQueryLimits.maxSnapshots);
      expect((yield* store.page(firstBinding, first.id, {maxItems: 1, maxBytes: 4096}, 10000)).status).toBe('stale');
      for (let i = 0; i < 32; i++)
        store.retain(sha256HexSync('large' + i), outcome([EffectString.repeat(600000)('x')]), 0);
      expect(store.status().retainedBytes).toBeLessThanOrEqual(semanticAgentQueryLimits.maxRetainedBytes);
      expect(store.status().snapshots).toBeLessThan(semanticAgentQueryLimits.maxSnapshots);
      const before = store.status();
      expect(
        store.retain(
          sha256HexSync('oversized'),
          outcome([EffectString.repeat(semanticAgentQueryLimits.maxSnapshotBytes)('x')]),
          0,
        ),
      ).toBeUndefined();
      expect(store.status()).toEqual(before);
    }),
  );
});

const profileFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-semantic-agent-'}));
  const home = path.join(directory, 'home');
  const root = path.join(directory, 'worktree');
  for (const dir of [home, root, path.join(home, 'semantic', 'profiles')])
    yield* fs.makeDirectory(dir, {recursive: true, mode: 0o700});
  const file = path.join(root, 'source.ts');
  yield* fs.writeFileString(file, 'export const answer = 42;\n');
  const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
  const config: RuntimeConfig = {
    account: 'local',
    user: 'tester',
    agentId: 'semantic-test',
    agentContextHome: home,
    manifestPath: path.join(directory, 'manifest.json'),
  };
  const profile = {
    version: 1,
    enabled: true,
    worktree,
    catalog: {
      go: {
        executable: '/host/gopls',
        executableDigest: sha256HexSync('gopls'),
        sdkDirectory: '/host/go',
        sdkTreeDigest: sha256HexSync('go'),
      },
    },
  };
  const profileFile = path.join(home, 'semantic', 'profiles', semanticHostProfileName(config, worktree));
  const write = (value: unknown) => fs.writeFileString(profileFile, JSON.stringify(value), {mode: 0o600});
  return {fs, path, home, root, file, worktree, config, profile, profileFile, write};
});

describe('private semantic host profiles and the canonical application read', () => {
  effectIt.effect('requires explicit enabled private regular worktree-bound profile bytes', () =>
    Effect.gen(function* () {
      const f = yield* profileFixture;
      const missing = yield* readSemanticHostProfile(f.config, f.worktree).pipe(Effect.result);
      expect(missing._tag).toBe('Failure');
      if (missing._tag === 'Failure')
        expect(Schema.is(SemanticHostProfileFault)(missing.failure) && missing.failure.reason).toBe('missing');
      yield* f.write(f.profile);
      const accepted = yield* readSemanticHostProfile(f.config, f.worktree);
      expect(accepted.profile).toEqual(f.profile);
      for (const [profile, reason] of [
        [{...f.profile, enabled: false}, 'disabled'],
        [{...f.profile, worktree: 'file:///different-worktree'}, 'incompatible'],
        [{...f.profile, executable: '/repository/run'}, 'invalid'],
      ] as const) {
        yield* f.write(profile);
        const rejected = yield* readSemanticHostProfile(f.config, f.worktree).pipe(Effect.result);
        expect(rejected._tag).toBe('Failure');
        if (rejected._tag === 'Failure')
          expect(Schema.is(SemanticHostProfileFault)(rejected.failure) && rejected.failure.reason).toBe(reason);
      }
      yield* f.write(f.profile);
      yield* f.fs.chmod(f.profileFile, 0o644);
      const publicFile = yield* readSemanticHostProfile(f.config, f.worktree).pipe(Effect.result);
      expect(publicFile._tag).toBe('Failure');
      if (publicFile._tag === 'Failure')
        expect(Schema.is(SemanticHostProfileFault)(publicFile.failure) && publicFile.failure.reason).toBe('untrusted');
    }).pipe(provideTestLayer(profileIo)),
  );

  effectIt.effect('refuses a symlinked profile and an oversized profile before consuming host configuration', () =>
    Effect.gen(function* () {
      const f = yield* profileFixture;
      const other = f.path.join(f.home, 'other.json');
      yield* f.fs.writeFileString(other, JSON.stringify(f.profile), {mode: 0o600});
      yield* f.fs.symlink(other, f.profileFile);
      expect((yield* readSemanticHostProfile(f.config, f.worktree).pipe(Effect.result))._tag).toBe('Failure');
      yield* f.fs.remove(f.profileFile);
      yield* f.fs.writeFileString(f.profileFile, EffectString.repeat(16385)(' '), {mode: 0o600});
      expect((yield* readSemanticHostProfile(f.config, f.worktree).pipe(Effect.result))._tag).toBe('Failure');
    }).pipe(provideTestLayer(profileIo)),
  );

  effectIt.effect('rejects public execution authority and unavailable languages without connecting', () =>
    Effect.gen(function* () {
      const f = yield* profileFixture;
      let connections = 0;
      const host: SemanticAgentQueryHost = {
        runtimeIdentity: Effect.succeed(sha256HexSync('runtime')),
        connect: () => {
          connections++;
          return Effect.die('Unexpected connection');
        },
      };
      const input = {callerCwd: f.root, file: 'source.ts', language: 'go', operation: 'symbols'};
      for (const extra of [
        {executable: '/repo/run'},
        {catalog: {}},
        {profile: '/repo/config'},
        {view: {kind: 'overlay', owner: 'claimed'}},
      ]) {
        expect((yield* runSemanticAgentQueryWith(host, f.config, {...input, ...extra})).status).toBe('invalid-request');
      }
      expect((yield* runSemanticAgentQueryWith(host, f.config, {...input, language: 'kotlin'})).status).toBe(
        'unsupported',
      );
      expect((yield* runSemanticAgentQueryWith(host, f.config, {...input, operation: 'rename'})).status).toBe(
        'unsupported',
      );
      for (const file of ['file://[', 'file://remote/source.ts', 'file:///bad%zz']) {
        expect((yield* runSemanticAgentQueryWith(host, f.config, {...input, file})).status).toBe('invalid-request');
      }
      expect((yield* runSemanticAgentQueryWith(host, f.config, input)).status).toBe('unavailable');
      expect(connections).toBe(0);
    }).pipe(provideTestLayer(queryIo)),
  );

  effectIt.effect('applies the caller deadline to host binding as well as the provider request', () =>
    Effect.gen(function* () {
      const f = yield* profileFixture;
      yield* f.write(f.profile);
      const started = yield* Deferred.make<void>();
      let connected = false;
      const host: SemanticAgentQueryHost = {
        runtimeIdentity: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        connect: () => {
          connected = true;
          return Effect.die('Unexpected connection');
        },
      };
      const fiber = yield* runSemanticAgentQueryWith(host, f.config, {
        callerCwd: f.root,
        file: 'source.ts',
        language: 'go',
        operation: 'symbols',
        milliseconds: 15,
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust(15);
      expect((yield* Fiber.join(fiber)).status).toBe('timeout');
      expect(connected).toBe(false);
    }).pipe(provideTestLayer(queryIo)),
  );
  effectIt.effect('uses the protected profile for the host binding and rechecks revocation before publication', () =>
    Effect.gen(function* () {
      const f = yield* profileFixture;
      yield* f.write(f.profile);
      let requests = 0;
      let revoke = false;
      let variant: 'ok' | 'scope' | 'budget' | 'offset' = 'ok';
      const host: SemanticAgentQueryHost = {
        runtimeIdentity: Effect.succeed(sha256HexSync('runtime')),
        connect: options => {
          expect(options.worktree).toBe(f.worktree);
          expect(options.go).toEqual(f.profile.catalog.go);
          return Effect.succeed({
            request: body =>
              Effect.gen(function* () {
                if (body.operation !== 'agent-query') throw new Error('Unexpected protocol operation');
                requests++;
                expect(JSON.stringify(body)).not.toContain('/host/gopls');
                const observed = {
                  ...observation(),
                  provider: {id: 'gopls', version: 'v0.24.0', generation: 1},
                  worktree: f.worktree,
                  project: f.worktree,
                  uri: canonicalFileUri((yield* f.path.toFileUrl(f.file)).href),
                };
                if (variant === 'scope') observed.worktree = 'file:///different-worktree';
                const result = {
                  version: 1,
                  status: 'ok',
                  evidence: outcome([], observed).evidence,
                  items: [{name: variant === 'budget' ? EffectString.repeat(5000)('x') : 'answer'}],
                  offset: variant === 'offset' ? 1 : 0,
                  remaining: 0,
                  next: null,
                };
                if (revoke) yield* f.write({...f.profile, enabled: false});
                return yield* Schema.decodeEffect(Schema.Json)(result);
              }).pipe(Effect.mapError(() => LspFault.make({code: 'protocol'}))),
          });
        },
      };
      const input = {callerCwd: f.root, file: 'source.ts', language: 'go', operation: 'symbols'};
      const accepted = yield* runSemanticAgentQueryWith(host, f.config, input);
      expect(accepted.status).toBe('ok');
      expect(Schema.is(SemanticAgentQueryResult)(accepted)).toBe(true);
      for (const [mode, status] of [
        ['scope', 'conflict'],
        ['budget', 'budget-exceeded'],
        ['offset', 'stale'],
      ] as const) {
        variant = mode;
        const refused = yield* runSemanticAgentQueryWith(host, f.config, input);
        expect(refused.status).toBe(status);
        expect(refused.evidence).toBeNull();
      }
      variant = 'ok';
      revoke = true;
      for (const file of ['file://[', 'file://remote/source.ts', 'file:///bad%zz']) {
        expect((yield* runSemanticAgentQueryWith(host, f.config, {...input, file})).status).toBe('invalid-request');
      }
      expect((yield* runSemanticAgentQueryWith(host, f.config, input)).status).toBe('unavailable');
      expect(requests).toBe(5);
    }).pipe(provideTestLayer(queryIo)),
  );
});
