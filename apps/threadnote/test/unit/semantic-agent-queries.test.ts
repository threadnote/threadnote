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
  Tracer,
} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import * as Statement from 'effect/sql/Statement';
import * as Reactivity from 'effect/reactivity/Reactivity';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {ResourceStore} from '@threadnote/store/resource-store';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import type {CodeGraphStatus, CodeGraphQueryResult} from '@threadnote/graph/types';
import {compileSemanticContextKnowledge} from '../../src/context_brief/index.js';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {canonicalFileUri, Counter, type Observation, type QueryOutcome} from '@threadnote/semantic/contracts';
import type {Continuation} from '@threadnote/semantic/views';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  makeSemanticAgentDiskQueries,
  makeSemanticAgentQueryStore,
  semanticAgentQueryLimits,
} from '../../src/semantic/agent_query_store.js';
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
import {SemanticSessionFault, type SemanticSession} from '../../src/semantic/provider.js';
import type {SemanticContextKnowledgeV1} from '@threadnote/context/types';

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

type DiagnosticMode =
  'ok' | 'missing-proof' | 'wrong-observation' | 'wrong-proof' | 'malformed-proof' | 'structural-proof' | 'timeout';
const diagnosticsFixture = Effect.fn('test.agentDiagnostics')(function* (messages: readonly string[]) {
  const f = yield* profileFixture;
  yield* f.write(f.profile);
  const started = yield* Deferred.make<void>();
  const runtime = sha256HexSync('diagnostic-runtime');
  const items = EffectArray.map(messages, (message, code) => ({
    id: sha256HexSync(JSON.stringify([code, message])),
    range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}},
    code,
    category: 'error',
    message,
  }));
  let mode: DiagnosticMode = 'ok';
  let current: Observation | undefined;
  let calls = 0;
  const api: SemanticSession = {
    upsert: () => Effect.die('The coordinator owns attachment'),
    query: () => Effect.die('Diagnostics must not issue navigation queries'),
    diagnostics: observed =>
      Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(started, undefined);
        if (mode === 'timeout') return yield* Effect.never;
        const proof = outcome([], observed).evidence;
        return {
          observation: mode === 'wrong-observation' ? {...observed, projectEpoch: observed.projectEpoch + 1} : observed,
          ...(mode === 'missing-proof'
            ? {}
            : {
                evidence:
                  mode === 'wrong-proof'
                    ? {...proof, observation: {...observed, projectEpoch: observed.projectEpoch + 1}}
                    : mode === 'malformed-proof'
                      ? {...proof, scope: '\ninvalid'}
                      : mode === 'structural-proof'
                        ? {...proof, basis: 'structural' as const}
                        : proof,
              }),
          items,
          added: calls === 1 ? items : [],
          remaining: calls === 1 ? [] : items,
          resolved: [],
        };
      }),
    project: () => Effect.die('The coordinator owns project verification'),
    observation: () => Effect.succeed(current),
    available: Effect.succeed(true),
    invalidate: Effect.void,
    close: Effect.die('No provider process exists in this fixture'),
  };
  const coordinator: Parameters<typeof makeSemanticAgentDiskQueries>[0] = {
    attach: seed =>
      Effect.sync(() => {
        current = {
          ...seed,
          configuration: sha256HexSync('diagnostic-config'),
          toolchain: sha256HexSync('diagnostic-tools'),
          provider: {...seed.provider, version: 'v0.24.0', generation: 1},
          projectEpoch: 1,
        };
        return {
          observation: current,
          status: 'experimental' as const,
          completeness: 'partial' as const,
          edits: 'preparation-only' as const,
          project: undefined,
        };
      }),
    observe: () => Effect.succeed(current),
    use: (_observed, _milliseconds, action) => action(api),
  };
  const disk = yield* makeSemanticAgentDiskQueries(coordinator, f.worktree, runtime);
  const services = yield* Effect.context<Effect.Services<ReturnType<typeof disk.query>>>();
  const host: SemanticAgentQueryHost = {
    runtimeIdentity: Effect.succeed(runtime),
    connect: () =>
      Effect.succeed({
        request: body => {
          if (body.operation !== 'agent-query') return Effect.die('Unexpected endpoint operation');
          return disk.query(body.request).pipe(
            Effect.provide(services),
            Effect.catch(error =>
              Effect.succeed({
                status: 'unavailable',
                reason: Schema.is(SemanticSessionFault)(error) ? error.reason : 'provider',
              }),
            ),
            Effect.flatMap(value => Schema.decodeUnknownEffect(Schema.Json)(value)),
            Effect.mapError(() => LspFault.make({code: 'protocol'})),
          );
        },
      }),
  };
  return {
    ...f,
    host,
    started,
    items,
    input: {callerCwd: f.root, file: 'source.ts', language: 'go', operation: 'diagnostics', maxBytes: 8192},
    calls: () => calls,
    status: disk.status,
    observe: disk.observe,
    mode: (value: DiagnosticMode) => {
      mode = value;
    },
    drift: () => {
      if (current) current = {...current, content: sha256HexSync('changed source')};
    },
  };
});

describe('host-bound public document diagnostics', () => {
  effectIt.effect('projects only diagnostic summary fields without mutating provider payloads', () =>
    Effect.gen(function* () {
      const f = yield* diagnosticsFixture(['reported message']);
      const expected = structuredClone(f.items);
      const item = f.items[0];
      if (!item) throw new Error('Missing fixture diagnostic');
      Object.assign(item, {data: {internal: 'item sentinel'}, source: 'provider metadata'});
      Object.assign(item.range, {data: {internal: 'range sentinel'}});
      Object.assign(item.range.start, {internal: 'start sentinel'});
      Object.assign(item.range.end, {internal: 'end sentinel'});
      const original = structuredClone(f.items);
      const result = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.items).toEqual(expected);
      expect(f.items).toEqual(original);
    }).pipe(provideTestLayer(queryIo)),
  );
  effectIt.effect.prop(
    'pages reconstruct the complete current snapshot even when subsequent delivery deltas contain no added items',
    [
      Schema.Array(Schema.String.check(Schema.isMaxLength(80))).check(Schema.isMaxLength(12)),
      Counter.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(5)),
    ],
    ([messages, maxItems]) =>
      Effect.gen(function* () {
        const f = yield* diagnosticsFixture(messages);
        const original = structuredClone(f.items);
        const collected: Schema.Json[] = [];
        let cursor: Continuation | undefined;
        do {
          const page = yield* runSemanticAgentQueryWith(f.host, f.config, {
            ...f.input,
            maxItems,
            ...(cursor ? {cursor} : {}),
          });
          expect(page.status).toBe('ok');
          if (page.status !== 'ok') throw new Error('Missing diagnostic page');
          expect(page.evidence.scope).toContain('document:');
          expect(page.evidence.completeness).toBe('partial');
          expect(page.evidence.limitations).toEqual(['Fixture scope']);
          expect(page.items.length).toBeLessThanOrEqual(maxItems);
          expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(f.input.maxBytes);
          collected.push(...page.items);
          cursor = page.next ?? undefined;
        } while (cursor);
        expect(collected).toEqual(original);
        expect(f.calls()).toBe(1);
        const repeated = yield* runSemanticAgentQueryWith(f.host, f.config, {...f.input, maxItems});
        expect(repeated.status).toBe('ok');
        if (repeated.status === 'ok') expect(repeated.items).toEqual(EffectArray.take(original, maxItems));
        expect(f.calls()).toBe(2);
        expect(f.items).toEqual(original);
      }).pipe(provideTestLayer(queryIo)),
    {arbitrary: {runs: 16}},
  );
  effectIt.effect('distinguishes an empty diagnostic snapshot, unavailable proof and mismatched observations', () =>
    Effect.gen(function* () {
      const f = yield* diagnosticsFixture([]);
      const empty = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
      expect(empty.status).toBe('ok');
      if (empty.status === 'ok') {
        expect(empty.items).toEqual([]);
        expect(empty.remaining).toBe(0);
        expect(empty.next).toBeNull();
        expect(empty.evidence.completeness).toBe('partial');
      }
      for (const [mode, status] of [
        ['missing-proof', 'unsupported'],
        ['wrong-observation', 'stale'],
        ['wrong-proof', 'stale'],
        ['malformed-proof', 'unavailable'],
        ['structural-proof', 'unavailable'],
      ] as const) {
        f.mode(mode);
        const before = f.status();
        const result = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
        expect(result.status).toBe(status);
        expect(result.evidence).toBeNull();
        expect(f.status()).toEqual(before);
      }
    }).pipe(provideTestLayer(queryIo)),
  );
  effectIt.effect('rejects stale diagnostic continuations without requesting a replacement snapshot', () =>
    Effect.gen(function* () {
      const f = yield* diagnosticsFixture(['first', 'second']);
      const first = yield* runSemanticAgentQueryWith(f.host, f.config, {...f.input, maxItems: 1});
      if (first.status !== 'ok' || !first.next) throw new Error('Missing diagnostic continuation');
      expect(
        (yield* runSemanticAgentQueryWith(f.host, f.config, {...f.input, operation: 'symbols', cursor: first.next}))
          .status,
      ).toBe('stale');
      expect(f.calls()).toBe(1);
      f.drift();
      const next = yield* runSemanticAgentQueryWith(f.host, f.config, {...f.input, cursor: first.next});
      expect(next.status).toBe('stale');
      expect(f.calls()).toBe(1);
      expect(f.status()).toEqual({snapshots: 0, retainedBytes: 0});
    }).pipe(provideTestLayer(queryIo)),
  );
  effectIt.effect('keeps diagnostics deadline-bound and rejects positional requests before provider work', () =>
    Effect.gen(function* () {
      const f = yield* diagnosticsFixture(['first']);
      expect(
        (yield* runSemanticAgentQueryWith(f.host, f.config, {...f.input, position: {line: 0, character: 0}})).status,
      ).toBe('invalid-request');
      expect(f.calls()).toBe(0);
      f.mode('timeout');
      const pending = yield* runSemanticAgentQueryWith(f.host, f.config, {...f.input, milliseconds: 15}).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(f.started);
      yield* TestClock.adjust(15);
      expect((yield* Fiber.join(pending)).status).toBe('timeout');
      expect(f.status()).toEqual({snapshots: 0, retainedBytes: 0});
    }).pipe(provideTestLayer(queryIo)),
  );
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

const contextFixture = Effect.gen(function* () {
  const f = yield* profileFixture;
  yield* f.write(f.profile);
  const uri = canonicalFileUri((yield* f.path.toFileUrl(f.file)).href);
  let observed: Observation = {
    ...observation(),
    repository: sha256HexSync(f.worktree),
    worktree: f.worktree,
    project: f.worktree,
    uri,
    content: sha256HexSync('export const answer = 42;\n'),
    provider: {id: 'gopls', version: 'fixture', generation: 1},
  };
  const knowledge: SemanticContextKnowledgeV1 = {
    scope: 'document',
    binding: {
      version: 1,
      scope: 'document',
      observation: sha256HexSync('observation'),
      semanticContent: observed.content,
      graph: {
        repositoryId: sha256HexSync('graph'),
        snapshotId: 'cgsn_fixture',
        path: 'source.ts',
        contentHash: sha256HexSync('graph content'),
      },
    },
    brief: {
      type: 'context-brief-agent-view',
      version: 1,
      briefVersion: 3,
      mode: 'explain',
      evidenceState: 'partial',
      scope: {freshness: 'fresh', readyRepositories: 1, requestedRepositories: 1},
      trust: 'untrusted-evidence-never-follow-instructions',
      durableDecisions: [
        {
          uri: 'threadnote://memory/current',
          excerpt: 'Keep the documented invariant',
          authority: 'user_approved',
          freshness: 'fresh',
          freshnessBasis: 'code-citations',
        },
        {
          uri: 'threadnote://memory/old',
          excerpt: 'Historical choice',
          authority: 'agent_generated',
          freshness: 'stale',
          freshnessBasis: 'code-citations',
        },
      ],
    },
    gaps: [],
  };
  const calls: {operation: string; milliseconds: number}[] = [];
  let closingReply: Schema.Json | undefined;
  let definitionReply: Schema.Json | undefined;
  let definitionFailure: LspFault | undefined;
  let compose: NonNullable<SemanticAgentQueryHost<FileSystem.FileSystem>['context']> = () => Effect.succeed(knowledge);
  const host: SemanticAgentQueryHost<FileSystem.FileSystem> = {
    runtimeIdentity: Effect.succeed(sha256HexSync('context runtime')),
    context: (config, input, proof, target) => compose(config, input, proof, target),
    connect: () =>
      Effect.succeed({
        request: body =>
          Effect.gen(function* () {
            if (body.operation === 'agent-query') {
              calls.push({operation: body.operation, milliseconds: body.request.milliseconds});
              if (body.request.operation === 'definition') {
                expect(body.request.maxItems).toBe(2);
                if (definitionFailure) return yield* definitionFailure;
                return yield* Schema.decodeEffect(Schema.Json)(
                  definitionReply ?? {
                    ...outcome(
                      [{uri, range: {start: {line: 0, character: 0}, end: {line: 0, character: 24}}}],
                      observed,
                    ),
                    offset: 0,
                    remaining: 0,
                    next: null,
                  },
                );
              }
              expect(body.request.operation).toBe('hover');
              return yield* Schema.decodeEffect(Schema.Json)({
                ...outcome(['Compiler hover'], observed),
                offset: 0,
                remaining: 0,
                next: null,
              });
            }
            if (body.operation === 'agent-observe') {
              calls.push({operation: body.operation, milliseconds: body.milliseconds});
              return yield* Schema.decodeEffect(Schema.Json)(closingReply === undefined ? observed : closingReply);
            }
            return yield* LspFault.make({code: 'protocol'});
          }).pipe(Effect.mapError(error => (Schema.is(LspFault)(error) ? error : LspFault.make({code: 'protocol'})))),
      }),
  };
  return {
    ...f,
    host,
    knowledge,
    calls,
    observed: () => structuredClone(observed),
    definition: (value: Schema.Json) => {
      definitionReply = value;
      definitionFailure = undefined;
    },
    definitionFault: (fault: LspFault) => {
      definitionFailure = fault;
    },
    closing: (value: Schema.Json | undefined) => {
      closingReply = value;
    },
    input: {
      callerCwd: f.root,
      file: 'source.ts',
      language: 'go',
      operation: 'context',
      task: 'Understand answer',
      position: {line: 0, character: 14},
      budgetTokens: 1500,
      maxBytes: 8192,
    },
    compose: (value: typeof compose) => {
      compose = value;
    },
    drift: () => {
      observed = {...observed, projectEpoch: observed.projectEpoch + 1};
    },
  };
});

describe('document-linked semantic context', () => {
  effectIt.effect('preserves real closing RPC timeout, capacity, conflict and stale outcomes', () =>
    Effect.gen(function* () {
      const f = yield* contextFixture;
      for (const [reason, status] of [
        ['timeout', 'timeout'],
        ['capacity', 'unavailable'],
        ['provider', 'unavailable'],
        ['conflict', 'conflict'],
        ['stale', 'stale'],
        ['rejected', 'stale'],
        ['invalid', 'invalid-request'],
      ] as const) {
        f.closing({status: 'unavailable', readOnly: true, reason, nextAction: 'Fixture retry hint'});
        const result = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
        expect(result.status).toBe(status);
        expect(result.evidence).toBeNull();
        expect(result).not.toHaveProperty('items');
      }
      const malformedReplies: readonly Schema.Json[] = [null, {notAnObservation: true}, {status: 'unavailable'}];
      for (const malformed of malformedReplies) {
        f.closing(malformed);
        expect((yield* runSemanticAgentQueryWith(f.host, f.config, f.input)).status).toBe('unavailable');
      }
    }).pipe(provideTestLayer(queryIo)),
  );
  effectIt.effect('retains separate compiler facts and memory authority/freshness without mutation', () =>
    Effect.gen(function* () {
      const f = yield* contextFixture;
      const original = structuredClone(f.knowledge);
      f.compose((_config, input, proof, target) =>
        Effect.sync(() => {
          expect(input.codeRefs).toEqual(['source.ts']);
          expect(input.scope).toEqual({kind: 'repository', callerCwd: f.root});
          expect(proof.basis).toBe('semantic');
          expect(target?.uri).toBe(proof.observation.uri);
          expect(target?.evidence.observation).toEqual(proof.observation);
          return f.knowledge;
        }),
      );
      const result = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('Context fixture refused');
      expect(result.items).toEqual([{kind: 'context', semantic: ['Compiler hover'], knowledge: f.knowledge}]);
      expect(f.knowledge).toEqual(original);
      expect(EffectArray.map(f.calls, call => call.operation)).toEqual(['agent-query', 'agent-query', 'agent-observe']);
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(4500);
    }).pipe(provideTestLayer(queryIo)),
  );

  effectIt.effect('keeps code useful with explicit missing knowledge and refuses source/profile changes', () =>
    Effect.gen(function* () {
      const f = yield* contextFixture;
      f.compose(() => Effect.fail('graph unavailable'));
      const missing = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
      expect(missing.status).toBe('ok');
      if (missing.status !== 'ok') throw new Error('Missing knowledge must not erase compiler facts');
      expect(missing.items).toEqual([
        {
          kind: 'context',
          semantic: ['Compiler hover'],
          knowledge: {
            scope: 'document',
            binding: null,
            brief: null,
            gaps: ['knowledge-unavailable'],
          },
        },
      ]);
      f.compose(() =>
        Effect.sync(() => {
          f.drift();
          return f.knowledge;
        }),
      );
      expect((yield* runSemanticAgentQueryWith(f.host, f.config, f.input)).status).toBe('stale');
      f.compose(() => f.write({...f.profile, enabled: false}).pipe(Effect.as(f.knowledge)));
      const revoked = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
      expect(revoked.status).toBe('unavailable');
      if (revoked.status !== 'ok') expect(revoked.reason).toContain('disabled');
    }).pipe(provideTestLayer(queryIo)),
  );

  effectIt.effect('shares the remaining deadline across reads, knowledge and closing observation', () =>
    Effect.gen(function* () {
      const f = yield* contextFixture;
      const started = yield* Deferred.make<void>();
      f.compose(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.sleep(5)), Effect.as(f.knowledge)),
      );
      const pending = yield* runSemanticAgentQueryWith(f.host, f.config, {...f.input, milliseconds: 20}).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(5);
      expect((yield* Fiber.join(pending)).status).toBe('ok');
      expect(EffectArray.map(f.calls, call => call.milliseconds)).toEqual([20, 20, 15]);
      f.compose(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)));
      const timeout = yield* runSemanticAgentQueryWith(f.host, f.config, {...f.input, milliseconds: 10}).pipe(
        Effect.forkScoped,
      );
      yield* TestClock.adjust(10);
      expect((yield* Fiber.join(timeout)).status).toBe('timeout');
    }).pipe(provideTestLayer(queryIo)),
  );

  effectIt.effect(
    'closes symbol selection on a deterministic post-transaction snapshot change before memory reads',
    () =>
      Effect.gen(function* () {
        for (const change of ['stale', 'snapshot'] as const) {
          const f = yield* contextFixture;
          const contentHash = codeGraphCommittedFileContentHash(
            'sha1',
            new TextEncoder().encode('export const answer = 42;\n'),
          );
          const identity = {
            caseMode: 'sensitive' as const,
            checkoutId: sha256HexSync('checkout'),
            displayName: 'fixture',
            gitCommonDirectory: f.path.join(f.root, '.git'),
            headCommit: EffectString.repeat(40)('a'),
            objectFormat: 'sha1' as const,
            repoRoot: f.root,
            repositoryId: sha256HexSync('repository'),
            worktreeId: sha256HexSync('worktree'),
          };
          const snapshot = {
            commit: identity.headCommit,
            dirty: false,
            id: 'cgsn_' + EffectString.repeat(40)('a'),
            worktreeId: identity.worktreeId,
          };
          const node = {
            id: 'cgs_' + EffectString.repeat(32)('a'),
            kind: 'variable',
            language: 'typescript',
            name: 'answer',
            qualifiedName: 'answer',
            exported: true,
            score: 1,
            path: 'source.ts',
            contentHash,
            span: {line: 1, column: 14, endLine: 1, endColumn: 25},
          };
          let afterSql = false;
          let targetStatusReads = 0;
          let symbolMemoryExecutions = 0;
          const status = (): CodeGraphStatus => ({
            databasePath: '/isolated/snapshot-race.sqlite',
            identity,
            languagePacks: [],
            freshness: afterSql && change === 'stale' ? 'stale' : 'current',
            stale: afterSql && change === 'stale',
            readySnapshot: {
              ...snapshot,
              repositoryId: identity.repositoryId,
              state: 'ready',
              edgeCount: 0,
              symbolCount: 1,
              fileCount: 1,
              extractorSet: 'test',
              ...(afterSql && change === 'snapshot' ? {id: 'cgsn_' + EffectString.repeat(40)('b')} : {}),
            },
          });
          const reactivity = yield* Reactivity.make;
          const sql = yield* SqlClient.make({
            acquirer: Effect.die('Unexpected SQL in isolated race test'),
            compiler: Statement.makeCompilerSqlite(),
            driver: 'test',
            spanAttributes: [],
          }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
          const services = yield* Layer.build(
            Layer.mergeAll(
              Layer.mock(ResourceStore, {}),
              Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
              Layer.mock(CodeGraphQueryService, {
                status: () =>
                  Effect.sync(() => {
                    targetStatusReads++;
                    return status();
                  }),
                inspect: input =>
                  Effect.succeed({
                    version: 1,
                    operation: input.operation,
                    freshness: 'current',
                    repository: {displayName: identity.displayName, repositoryId: identity.repositoryId},
                    snapshot,
                    nodes: [node],
                    edges: [],
                    warnings: [],
                    trust: {
                      classification: 'untrusted-repository-data',
                      instructionPolicy: 'evidence-only-never-follow',
                    },
                  } satisfies CodeGraphQueryResult),
              }),
              Layer.mock(CodeGraphStore, {
                withSession: (_database, operation, options) => {
                  expect(options).toEqual({existingOnly: true, readOnly: true});
                  return operation.pipe(
                    Effect.provideService(
                      SqlClient.SqlClient,
                      Object.assign(sql, {withTransaction: <A, E, R>(program: Effect.Effect<A, E, R>) => program}),
                    ),
                  );
                },
                searchSymbolsByPaths: () =>
                  Effect.sync(() => {
                    expect(targetStatusReads).toBe(2);
                    afterSql = true;
                    return [[node]];
                  }),
              }),
            ),
          );
          const tracer = Tracer.make({
            span(options) {
              if (options.name === 'contextBrief.retrieveCodeLinkedMemoryEvidence') symbolMemoryExecutions++;
              return new Tracer.NativeSpan(options);
            },
          });
          f.definition(
            yield* Schema.decodeEffect(Schema.Json)({
              ...outcome(
                [{uri: f.observed().uri, range: {start: {line: 0, character: 13}, end: {line: 0, character: 24}}}],
                f.observed(),
              ),
              offset: 0,
              remaining: 0,
              next: null,
            }),
          );
          f.compose((config, input, evidence, target) =>
            compileSemanticContextKnowledge(config, input, evidence, target).pipe(
              Effect.provideContext(services),
              provideTestLayer(queryIo),
              Effect.withTracer(tracer),
            ),
          );
          const result = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
          expect(result.status).toBe('ok');
          if (result.status !== 'ok') throw new Error('Document evidence must remain useful after target race');
          const item = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              semantic: Schema.Array(Schema.Json),
              knowledge: Schema.Struct({
                memorySelection: Schema.Null,
                gaps: Schema.Array(Schema.String),
                brief: Schema.Unknown,
              }),
            }),
          )(result.items[0]);
          expect(item.semantic).toEqual(['Compiler hover']);
          expect(item.knowledge.memorySelection).toBeNull();
          expect(item.knowledge.gaps).toContain('semantic-symbol-snapshot-unbound');
          expect(item.knowledge.brief).not.toBeNull();
          expect(targetStatusReads).toBe(3);
          expect(symbolMemoryExecutions).toBe(0);
        }
      }).pipe(provideTestLayer(queryIo)),
  );

  effectIt.effect('reports distinct bounded definition abstention reasons without exposing provider text', () =>
    Effect.gen(function* () {
      const f = yield* contextFixture;
      const sentinel = 'UNTRUSTED_PROVIDER_TEXT';
      const location = {uri: f.observed().uri, range: {start: {line: 0, character: 0}, end: {line: 0, character: 5}}};
      const page = (items: readonly Schema.Json[]) => ({
        ...outcome(items, f.observed()),
        offset: 0,
        remaining: 0,
        next: null,
      });
      const denied: SemanticContextKnowledgeV1 = {
        scope: 'document',
        binding: null,
        brief: null,
        gaps: ['knowledge-not-authorized'],
      };
      for (const [reply, gap] of [
        [
          {version: 1, status: 'unsupported', reason: sentinel, evidence: null},
          'semantic-symbol-definition-unsupported',
        ],
        [
          page([{...location, uri: 'file:///external/' + sentinel + '.ts'}]),
          'semantic-symbol-definition-external-target',
        ],
        [page([location, location]), 'semantic-symbol-definition-ambiguous'],
        [{...page([]), remaining: 1}, 'semantic-symbol-definition-incomplete'],
        [page([]), 'semantic-symbol-definition-unresolved'],
        [
          {
            ...page([location]),
            evidence: {
              ...outcome([], f.observed()).evidence,
              observation: {...f.observed(), projectEpoch: f.observed().projectEpoch + 1},
            },
          },
          'semantic-symbol-definition-observation-mismatch',
        ],
        [{version: 1, status: 'timeout', reason: sentinel, evidence: null}, 'semantic-symbol-definition-timeout'],
        [{version: 1, status: 'stale', reason: sentinel, evidence: null}, 'semantic-symbol-definition-stale'],
        [{version: 1, status: 'unavailable', reason: sentinel, evidence: null}, 'semantic-symbol-definition-failed'],
        [page([{contents: sentinel}]), 'semantic-symbol-definition-target-unsupported'],
        [{notAProviderResult: sentinel}, 'semantic-symbol-definition-failed'],
      ] as const) {
        f.definition(yield* Schema.decodeEffect(Schema.Json)(reply));
        f.compose((_config, _input, _proof, target) => {
          expect(target).toBeNull();
          return Effect.succeed(f.knowledge);
        });
        const result = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
        expect(result.status).toBe('ok');
        if (result.status === 'ok')
          expect(result.items).toEqual([
            {
              kind: 'context',
              semantic: ['Compiler hover'],
              knowledge: {...f.knowledge, memorySelection: null, gaps: [gap]},
            },
          ]);
        expect(JSON.stringify(result)).not.toContain(sentinel);
        // Definition diagnostics cannot disclose knowledge when memory reads were denied.
        f.compose(() => Effect.succeed(denied));
        const restricted = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
        expect(restricted.status).toBe('ok');
        if (restricted.status === 'ok')
          expect(restricted.items).toEqual([{kind: 'context', semantic: ['Compiler hover'], knowledge: denied}]);
        expect(JSON.stringify(restricted)).not.toContain(sentinel);
      }
    }).pipe(provideTestLayer(queryIo)),
  );

  effectIt.effect('maps generic rejected definition faults to failure while preserving explicit stale status', () =>
    Effect.gen(function* () {
      const f = yield* contextFixture;
      const sentinel = 'UNTRUSTED_PROVIDER_TEXT';
      f.compose((_config, _input, _proof, target) => {
        expect(target).toBeNull();
        return Effect.succeed(f.knowledge);
      });
      // A rejected endpoint grant is a generic boundary failure, without proof of stale source.
      f.definitionFault(
        Object.assign(LspFault.make({code: 'rejected'}), {message: sentinel + ': endpoint grant unavailable'}),
      );
      const rejected = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
      expect(rejected.status).toBe('ok');
      if (rejected.status === 'ok')
        expect(rejected.items).toEqual([
          {
            kind: 'context',
            semantic: ['Compiler hover'],
            knowledge: {...f.knowledge, memorySelection: null, gaps: ['semantic-symbol-definition-failed']},
          },
        ]);
      expect(JSON.stringify(rejected)).not.toContain(sentinel);
      f.definition({version: 1, status: 'stale', reason: sentinel, evidence: null});
      const stale = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
      expect(stale.status).toBe('ok');
      if (stale.status === 'ok')
        expect(stale.items).toEqual([
          {
            kind: 'context',
            semantic: ['Compiler hover'],
            knowledge: {...f.knowledge, memorySelection: null, gaps: ['semantic-symbol-definition-stale']},
          },
        ]);
      expect(JSON.stringify(stale)).not.toContain(sentinel);
    }).pipe(provideTestLayer(queryIo)),
  );

  effectIt.effect('bounds combined output, preserves omissions, and keeps context-only fields closed', () =>
    Effect.gen(function* () {
      const f = yield* contextFixture;
      f.compose(() =>
        Effect.succeed({...f.knowledge, brief: {...f.knowledge.brief!, answer: EffectString.repeat(10000)('x')}}),
      );
      const bounded = yield* runSemanticAgentQueryWith(f.host, f.config, {...f.input, budgetTokens: 1000});
      expect(bounded.status).toBe('ok');
      expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(3000);
      expect(JSON.stringify(bounded)).toContain('knowledge-output-budget-exhausted');
      for (const extra of [{task: undefined}, {position: undefined}, {budgetTokens: 1501}, {operation: 'hover'}]) {
        expect((yield* runSemanticAgentQueryWith(f.host, f.config, {...f.input, ...extra})).status).toBe(
          'invalid-request',
        );
      }
    }).pipe(provideTestLayer(queryIo)),
  );

  effectIt.effect('closing observations accept only the coordinator-owned disk namespace', () =>
    Effect.gen(function* () {
      const f = yield* diagnosticsFixture([]);
      const result = yield* runSemanticAgentQueryWith(f.host, f.config, f.input);
      if (result.status !== 'ok') throw new Error('Missing observation fixture');
      expect(yield* f.observe(result.evidence.observation, 100)).toEqual(result.evidence.observation);
      const refused = yield* f
        .observe({...result.evidence.observation, view: {...result.evidence.observation.view, owner: 'foreign'}}, 100)
        .pipe(Effect.result);
      expect(refused._tag).toBe('Failure');
    }).pipe(provideTestLayer(queryIo)),
  );
});
