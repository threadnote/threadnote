import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Path, Ref, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {SqlError} from 'effect/sql/SqlError';
import * as FC from 'fast-check';
import {describe, expect} from 'vitest';
import {
  observeCodeGraphAdmissionEnvironment,
  recordCodeGraphSnapshotAdmission,
} from '@threadnote/graph/admission_freshness';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphIndexer, extractorSetIdentityFromPackProvenance} from '@threadnote/graph/indexer';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphQueryService, type CodeGraphInspectOptions} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphStoreTransientIoError, type CodeGraphQueryNode, type CodeGraphSnapshot} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';

import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const platform = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, CodeGraphLanguagePackRegistry.layer);
const dependencies = Layer.merge(platform, TestCommandExecutorLayer.pipe(Layer.provide(platform)));
const node: CodeGraphQueryNode = {
  contentHash: 'fixture',
  exported: true,
  id: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
  kind: 'function',
  language: 'typescript',
  name: 'value',
  path: 'source.ts',
  qualifiedName: 'value',
  score: 1,
  span: {column: 1, endColumn: 2, endLine: 1, line: 1},
};
const operations = ['query', 'node', 'neighbors', 'explain', 'path', 'impact'] as const;

// Real Git and admission receipts keep the currentness contract observable; only graph storage and indexing are modeled.
const makeFixture = Effect.fn('test.makeQueryRuntimeFixture')(function* () {
  const fixtureContext = yield* Effect.context<Layer.Success<typeof dependencies>>();
  const readSqlContext = yield* Layer.build(SqliteClient.layer({disableWAL: true, filename: ':memory:'}));
  const readSql = Context.get(readSqlContext, SqlClient.SqlClient);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packs = yield* CodeGraphLanguagePackRegistry;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-query-runtime-'});
  const repository = path.join(root, 'repository');
  const home = path.join(root, 'home');
  yield* fs.makeDirectory(repository);
  const git = (args: readonly string[]) =>
    runCommandEffect('git', ['-C', repository, ...args]).pipe(Effect.provide(fixtureContext));
  yield* git(['init', '-q']);
  yield* fs.writeFileString(path.join(repository, 'source.ts'), 'export const value = 1;\n');
  yield* git(['add', 'source.ts']);
  yield* git([
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'fixture',
  ]);
  const identity = yield* resolveRepositoryIdentity(repository);
  const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
  const snapshot: CodeGraphSnapshot = {
    commit: identity.headCommit,
    completedAt: '2026-08-08T00:00:00.000Z',
    dirty: false,
    edgeCount: 0,
    extractorSet: extractorSetIdentityFromPackProvenance([]),
    fileCount: 1,
    id: `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 1,
    worktreeId: identity.worktreeId,
  };
  const ready = yield* Ref.make<CodeGraphSnapshot | undefined>(snapshot);
  const valid = yield* Ref.make(true);
  const failProvenance = yield* Ref.make(false);
  const failRead = yield* Ref.make(false);
  const counters = yield* Ref.make({indexed: 0, provenance: 0, acquired: 0, released: 0, strict: 0});
  const record = (field: 'indexed' | 'provenance' | 'acquired' | 'released' | 'strict') =>
    Ref.update(counters, value => ({...value, [field]: value[field] + 1}));
  const admission = (environment?: string) =>
    Effect.gen(function* () {
      yield* recordCodeGraphSnapshotAdmission(
        layout,
        snapshot,
        environment ?? (yield* observeCodeGraphAdmissionEnvironment(identity)),
        packs,
        false,
      );
    }).pipe(Effect.provide(fixtureContext));
  yield* admission();
  const store = {
    readySnapshot: () => Ref.get(ready),
    readySnapshotById: () => Ref.get(ready),
    snapshotPackProvenance: () =>
      Effect.gen(function* () {
        yield* record('provenance');
        if (yield* Ref.get(failProvenance))
          return yield* CodeGraphStoreTransientIoError.of('provenance read failed', {operation: 'snapshot provenance'});
        return (yield* Ref.get(valid)) ? [] : undefined;
      }),
    acquireSnapshotLease: () => record('acquired').pipe(Effect.as('lease')),
    releaseSnapshotLease: () => record('released'),
    symbolsByIds: (_database: string, _snapshot: string, ids: readonly string[]) =>
      Effect.gen(function* () {
        if (yield* Ref.get(failRead))
          return yield* CodeGraphStoreTransientIoError.of('graph read failed', {operation: 'symbol read'});
        return ids.includes(node.id) ? [node] : [];
      }),
    searchSymbolsMany: () => Effect.succeed([[node]]),
    searchSymbolsByPaths: () => Effect.succeed([[node]]),
    edgesForNodes: () => Effect.succeed([]),
    withSession: <A, E, R>(_database: string, use: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
      use.pipe(
        Effect.provideService(SqlClient.SqlClient, readSql),
        Effect.catchIf(Schema.is(SqlError), error =>
          Effect.fail(CodeGraphStoreTransientIoError.of(error.message ?? 'Graph query transaction failed.')),
        ),
      ),
  };
  const indexer = {
    index: () =>
      Effect.gen(function* () {
        yield* record('indexed');
        yield* Ref.set(ready, snapshot);
        yield* Ref.set(valid, true);
        yield* Ref.set(failProvenance, false);
        yield* admission();
      }).pipe(Effect.as({diagnostics: [], durationMs: 0, identity, reusedFiles: 0, skippedFiles: 0, snapshot})),
    ensureCommit: () => Effect.die(TestError.make({message: 'unexpected historical build'})),
  };
  const services = Layer.mergeAll(
    dependencies,
    Layer.mock(CodeGraphStore, store),
    Layer.mock(CodeGraphIndexer, indexer),
    Layer.mock(CodeGraphMaintenanceCoordinator, {
      request: () => Effect.die(TestError.make({message: 'unexpected maintenance'})),
    }),
    Layer.mock(CodeGraphEmbeddingIndex, {
      search: () => Effect.succeed(new Map()),
    }),
  );
  const context = yield* Layer.build(CodeGraphQueryService.layer.pipe(Layer.provide(services)));
  const query = Context.get(context, CodeGraphQueryService);
  const inspect = (options: Partial<CodeGraphInspectOptions> = {}) =>
    query.inspect({
      cwd: repository,
      threadnoteHome: home,
      operation: 'node',
      nodeId: node.id,
      query: 'value',
      from: node.id,
      to: node.id,
      requestMaintenance: false,
      statusObservation: {identity},
      telemetry: {
        skip: () => Effect.void,
        stage: (_phase, stage, effect) =>
          stage === 'query-strict-reobservation' ? record('strict').pipe(Effect.andThen(effect)) : effect,
      },
      ...options,
    });
  return {
    admission,
    counters,
    failProvenance,
    failRead,
    fs,
    git,
    identity,
    inspect,
    path,
    ready,
    repository,
    snapshot,
    valid,
  };
});

describe('query runtime probe policy', () => {
  effectIt.effect('reuses an observed full route while resolving omitted scope observations', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const manifestPath = fixture.path.join(fixture.repository, 'invalid-manifest.yaml');
      yield* fixture.fs.writeFileString(manifestPath, 'not: [valid');
      const result = yield* fixture.inspect({
        manifestPath,
        refresh: false,
        strictFreshness: false,
        statusObservation: {identity: fixture.identity, projectScopeObserved: true},
      });
      expect(EffectArray.map(result.nodes, candidate => candidate.id)).toContain(node.id);
      const missingProof = yield* fixture
        .inspect({
          manifestPath,
          refresh: false,
          strictFreshness: false,
          statusObservation: {identity: fixture.identity},
        })
        .pipe(Effect.result);
      expect(missingProof._tag).toBe('Failure');
    }).pipe(provideTestLayer(dependencies), TestClock.withLive),
  );

  for (const operation of operations) {
    effectIt.effect(`preserves selected-snapshot and explicit refresh/strict checks for ${operation}`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        for (const refresh of [undefined, false, true] as const) {
          for (const strictFreshness of [false, true]) {
            yield* Ref.set(fixture.counters, {indexed: 0, provenance: 0, acquired: 0, released: 0, strict: 0});
            const result = yield* fixture.inspect({operation, refresh, strictFreshness});
            expect(result.freshness).toBe(refresh === false && !strictFreshness ? 'deferred' : 'current');
            expect(EffectArray.map(result.nodes, value => value.id)).toContain(node.id);
            const rebuildMode = refresh === true || operation === 'path' || operation === 'impact';
            expect(yield* Ref.get(fixture.counters)).toEqual({
              indexed: 0,
              provenance: refresh !== false && rebuildMode ? 2 : 1,
              acquired: 0,
              released: 0,
              strict: strictFreshness ? 1 : 0,
            });
          }
        }
      }).pipe(provideTestLayer(dependencies), TestClock.withLive),
    );

    fcEffectProp(
      effectIt,
      `preserves cold-build, refresh, and stale-result policy for ${operation} across runtime validity`,
      {
        refresh: FC.constantFrom(undefined, false, true),
        strictFreshness: FC.constantFrom(undefined, false, true),
        available: FC.boolean(),
        valid: FC.boolean(),
      },
      ({refresh, strictFreshness, available, valid}) =>
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          yield* Ref.set(fixture.ready, available ? fixture.snapshot : undefined);
          yield* Ref.set(fixture.valid, valid);
          const run = fixture.inspect({operation, refresh, strictFreshness});
          if (!available && refresh === false) {
            expect(yield* run.pipe(Effect.flip)).toMatchObject({_tag: 'CodeGraphSnapshotUnavailable'});
            expect(yield* Ref.get(fixture.counters)).toEqual({
              indexed: 0,
              provenance: 0,
              acquired: 0,
              released: 0,
              strict: 0,
            });
            return;
          }
          const result = yield* run;
          const refreshesStale =
            refresh !== false && (refresh === true || operation === 'path' || operation === 'impact');
          const builds = !available || (!valid && refreshesStale);
          const observed = refresh !== false || (strictFreshness ?? (operation === 'path' || operation === 'impact'));
          expect(result.freshness).toBe(!valid && !builds ? 'stale' : observed ? 'current' : 'deferred');
          expect(EffectArray.map(result.nodes, value => value.id)).toContain(node.id);
          expect(yield* Ref.get(fixture.counters)).toMatchObject({indexed: builds ? 1 : 0, acquired: 0, released: 0});
        }).pipe(provideTestLayer(dependencies), TestClock.withLive),
      // Four generated fixtures per operation: 24 total, separately bounded by the ordinary test timeout.
      {fastCheck: {numRuns: 4}},
    );
  }

  effectIt.effect('keeps cold auto-indexing and refresh decisions even when strict reobservation is disabled', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      for (const refresh of [undefined, true, false] as const) {
        yield* Ref.set(fixture.ready, undefined);
        yield* Ref.set(fixture.counters, {indexed: 0, provenance: 0, acquired: 0, released: 0, strict: 0});
        const run = fixture.inspect({refresh, strictFreshness: false});
        if (refresh === false) {
          expect(yield* run.pipe(Effect.flip)).toMatchObject({_tag: 'CodeGraphSnapshotUnavailable'});
          expect(yield* Ref.get(fixture.counters)).toMatchObject({indexed: 0, acquired: 0, released: 0});
        } else {
          expect((yield* run).freshness).toBe('current');
          expect(yield* Ref.get(fixture.counters)).toEqual({
            indexed: 1,
            provenance: 1,
            acquired: 0,
            released: 0,
            strict: 0,
          });
        }
      }
      yield* Ref.set(fixture.ready, fixture.snapshot);
      for (const operation of ['node', 'path', 'impact'] as const) {
        yield* Ref.set(fixture.valid, false);
        yield* Ref.set(fixture.counters, {indexed: 0, provenance: 0, acquired: 0, released: 0, strict: 0});
        const result = yield* fixture.inspect({
          operation,
          refresh: operation === 'node' ? true : undefined,
          strictFreshness: false,
        });
        expect(result.freshness).toBe('current');
        expect(yield* Ref.get(fixture.counters)).toEqual({
          indexed: 1,
          provenance: 2,
          acquired: 0,
          released: 0,
          strict: 0,
        });
      }
    }).pipe(provideTestLayer(dependencies), TestClock.withLive),
  );

  effectIt.effect('observes invalid provenance after the worktree observation without taking writer-gated leases', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const result = yield* fixture.inspect({interlock: {afterObservation: () => Ref.set(fixture.valid, false)}});
      expect(result.freshness).toBe('stale');
      expect(yield* Ref.get(fixture.counters)).toEqual({
        indexed: 0,
        provenance: 1,
        acquired: 0,
        released: 0,
        strict: 0,
      });
      yield* Ref.set(fixture.failProvenance, true);
      expect((yield* fixture.inspect()).freshness).toBe('stale');
      yield* Ref.set(fixture.failRead, true);
      expect(yield* fixture.inspect().pipe(Effect.flip)).toMatchObject({message: 'graph read failed'});
      expect(yield* Ref.get(fixture.counters)).toMatchObject({indexed: 0, acquired: 0, released: 0});
    }).pipe(provideTestLayer(dependencies), TestClock.withLive),
  );

  effectIt.effect(
    'keeps selected admission and strict closing admission checks without the ordinary preflight probe',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.admission(Effect2.pipe('0', EffectString.repeat(64)));
        expect((yield* fixture.inspect()).freshness).toBe('stale');
        yield* fixture.admission();
        const strict = yield* fixture.inspect({
          strictFreshness: true,
          interlock: {
            afterSnapshotSelected: () =>
              fixture.admission(Effect2.pipe('0', EffectString.repeat(64))).pipe(Effect.orDie),
          },
        });
        expect(strict.freshness).toBe('stale');
        expect(yield* Ref.get(fixture.counters)).toEqual({
          indexed: 0,
          provenance: 2,
          acquired: 0,
          released: 0,
          strict: 1,
        });
      }).pipe(provideTestLayer(dependencies), TestClock.withLive),
  );

  effectIt.effect('retains strict closing worktree and repository identity reobservation', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const dirty = yield* fixture.inspect({
        strictFreshness: true,
        interlock: {
          afterSnapshotSelected: () =>
            fixture.fs
              .writeFileString(fixture.path.join(fixture.repository, 'source.ts'), 'export const value = 2;\n')
              .pipe(Effect.orDie),
        },
      });
      expect(dirty.freshness).toBe('stale');
      yield* fixture.git(['checkout', '--', 'source.ts']);
      const changedIdentity = yield* fixture
        .inspect({
          strictFreshness: true,
          interlock: {
            afterSnapshotSelected: () =>
              fixture
                .git(['remote', 'add', 'origin', 'https://github.com/example/replaced.git'])
                .pipe(Effect.asVoid, Effect.orDie),
          },
        })
        .pipe(Effect.flip);
      expect(changedIdentity).toMatchObject({
        _tag: 'CodeGraphRepositoryError',
        message: 'Repository identity changed during the graph read.',
      });
      expect(yield* Ref.get(fixture.counters)).toEqual({
        indexed: 0,
        provenance: 2,
        acquired: 0,
        released: 0,
        strict: 2,
      });
    }).pipe(provideTestLayer(dependencies), TestClock.withLive),
  );
});
