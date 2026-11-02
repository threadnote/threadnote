import * as EffectString from 'effect/String';
import {describe, expect, it} from '@effect/vitest';
import {Context, Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {
  inferredCodeGraphWriterLockPath,
  useDatabaseDirect,
  withCodeGraphDeferredTransaction,
} from '@threadnote/graph/store/session';
import {CodeGraphIndexer, extractorSetIdentityFromPackProvenance} from '@threadnote/graph/indexer';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {
  observeCodeGraphAdmissionEnvironment,
  recordCodeGraphSnapshotAdmission,
} from '@threadnote/graph/admission_freshness';
import type {CodeGraphSnapshot} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {captureMemoryCodeCitations, MemoryCodeCitationCaptureError} from '../../src/citation/capture.js';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
const unexpected = () => Effect.die('Citation capture must not index or request maintenance');
const packs = createCodeGraphLanguagePackRegistry([]);
const base = Layer.mergeAll(
  citationPlatformLayer,
  Layer.succeed(CodeGraphLanguagePackRegistry, packs),
  Layer.succeed(CodeGraphIndexer, CodeGraphIndexer.of({index: unexpected, ensureCommit: unexpected})),
  Layer.succeed(
    CodeGraphMaintenanceCoordinator,
    CodeGraphMaintenanceCoordinator.of({
      request: unexpected,
      tick: unexpected,
      kickOrdinary: unexpected,
      kickReconciliation: unexpected,
      kickResidual: unexpected,
    }),
  ),
  Layer.succeed(
    CodeGraphEmbeddingIndex,
    CodeGraphEmbeddingIndex.of({
      check: () => Effect.succeed({state: 'unavailable', reason: 'fixture'}),
      ensure: unexpected,
      search: unexpected,
    }),
  ),
);
const dependencies = CodeGraphStore.layer.pipe(Layer.provideMerge(base));
const source = 'export const value = 1;\n';
const moduleId = 'cgs_' + EffectString.repeat(40)('b');
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'citation-session-'});
  const repo = paths.join(root, 'repo');
  const home = paths.join(root, 'home');
  yield* fs.makeDirectory(repo);
  yield* fs.makeDirectory(home);
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
  yield* git(['init', '--quiet']);
  yield* fs.writeFileString(paths.join(repo, 'source.ts'), source);
  yield* git(['add', 'source.ts']);
  yield* git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  ]);
  const identity = yield* resolveRepositoryIdentity(repo);
  const layout = codeGraphLayout(paths, home, identity.checkoutId, identity.worktreeId);
  const bytes = new TextEncoder().encode(source);
  const snapshot: CodeGraphSnapshot = {
    id: `cgsn_${EffectString.repeat(40)('1')}`,
    commit: identity.headCommit,
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    extractorSet: extractorSetIdentityFromPackProvenance([]),
    dirty: false,
    edgeCount: 0,
    fileCount: 1,
    symbolCount: 1,
    state: 'ready',
    completedAt: '2026-10-26T00:00:00.000Z',
  };
  yield* store.activate(
    layout.databasePath,
    identity,
    snapshot,
    [
      {
        blobId: EffectString.trim((yield* git(['rev-parse', 'HEAD:source.ts'])).stdout),
        contentHash: codeGraphCommittedFileContentHash('sha1', bytes),
        path: 'source.ts',
        language: 'typescript',
        mode: '100644',
        size: bytes.length,
        source: 'commit',
      },
    ],
    [
      {
        id: moduleId,
        contentHash: codeGraphCommittedFileContentHash('sha1', bytes),
        exported: false,
        kind: 'module',
        language: 'typescript',
        name: 'source.ts',
        path: 'source.ts',
        qualifiedName: 'source.ts',
        span: {line: 1, column: 1, endLine: 1, endColumn: 1},
      },
    ],
    [],
    [],
  );
  yield* store.promote(layout.databasePath, identity, snapshot.id);
  yield* recordCodeGraphSnapshotAdmission(
    layout,
    snapshot,
    yield* observeCodeGraphAdmissionEnvironment(identity),
    packs,
    false,
  );
  const config = {
    account: 'test',
    user: 'test',
    agentId: 'test',
    agentContextHome: home,
    manifestPath: paths.join(home, 'manifest.yaml'),
    manifestSource: 'bundled-example' as const,
  };
  const queryContext = yield* Layer.build(CodeGraphQueryService.layer);
  const query = Context.get(queryContext, CodeGraphQueryService);
  return {fs, paths, store, query, repo, home, identity, snapshot, layout, config};
});

describe('ready citation capture without writer leases', () => {
  it.layer(dependencies)(test => {
    test.effect('copies retained evidence while another writer holds SQLite and the graph gate', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const lock = inferredCodeGraphWriterLockPath(f.paths, f.layout.databasePath);
        if (!lock) throw new Error('Expected the repository graph writer gate');
        const writer = yield* withExclusiveFileLock(
          f.fs,
          lock,
          {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 120_000, waitTimeoutMilliseconds: 0},
          f.store.withSession(
            f.layout.databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.withTransaction(
                sql`UPDATE snapshots SET completed_at = completed_at WHERE id = ${f.snapshot.id}`.pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Deferred.await(release)),
                ),
              );
            }),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const observed = CodeGraphStore.of({
          ...f.store,
          acquireSnapshotLease: () => Effect.die('Ready capture must not acquire a writer lease'),
          releaseSnapshotLease: () => Effect.die('Ready capture must not release a writer lease'),
        });
        const citations = yield* captureMemoryCodeCitations(f.config, {
          callerCwd: f.repo,
          refs: ['source.ts', moduleId],
          expectedCallerIdentity: f.identity,
          expectedProjectScope: {kind: 'full'},
        }).pipe(
          Effect.provideService(CodeGraphQueryService, f.query),
          Effect.provideService(CodeGraphStore, observed),
          Effect.timeout('5 seconds'),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
        yield* Fiber.join(writer);
        expect(citations).toHaveLength(1);
        expect(citations[0].evidenceRetention).toBe('capsule-retained');
      }).pipe(TestClock.withLive),
    );

    test.effect(
      'rejects retirement after copying through a fresh closing read and preserves the caller transaction',
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const observed = CodeGraphStore.of({
            ...f.store,
            readReadySnapshotCitationEvidence: (...args) =>
              f.store.readReadySnapshotCitationEvidence!(...args).pipe(
                Effect.tap(() =>
                  useDatabaseDirect(
                    f.layout.databasePath,
                    Effect.gen(function* () {
                      const sql = yield* SqlClient.SqlClient;
                      yield* sql
                        .withTransaction(sql`UPDATE snapshots SET state='retired' WHERE id=${f.snapshot.id}`)
                        .pipe(Effect.orDie);
                    }),
                  ),
                ),
              ),
          });
          yield* f.store.withSession(
            f.layout.databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* withCodeGraphDeferredTransaction(
                sql,
                Effect.gen(function* () {
                  expect((yield* f.store.readySnapshot(f.layout.databasePath, f.identity.worktreeId))?.id).toBe(
                    f.snapshot.id,
                  );
                  const result = yield* captureMemoryCodeCitations(f.config, {
                    callerCwd: f.repo,
                    refs: ['source.ts'],
                  }).pipe(
                    Effect.provideService(CodeGraphQueryService, f.query),
                    Effect.provideService(CodeGraphStore, observed),
                    Effect.result,
                  );
                  expect(result._tag).toBe('Failure');
                  if (result._tag === 'Failure') expect(result.failure).toBeInstanceOf(MemoryCodeCitationCaptureError);
                  expect((yield* f.store.readySnapshot(f.layout.databasePath, f.identity.worktreeId))?.id).toBe(
                    f.snapshot.id,
                  );
                }),
              );
              expect(yield* f.store.readySnapshot(f.layout.databasePath, f.identity.worktreeId)).toBeUndefined();
            }),
          );
        }).pipe(TestClock.withLive),
    );

    test.effect('keeps the writer lease fallback for older graph adapters', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let acquired = 0;
        let released = 0;
        const observed = CodeGraphStore.of({
          ...f.store,
          readReadySnapshotCitationEvidence: undefined,
          acquireSnapshotLease: (...args) =>
            f.store.acquireSnapshotLease(...args).pipe(Effect.tap(() => Effect.sync(() => acquired++))),
          releaseSnapshotLease: (...args) =>
            f.store.releaseSnapshotLease(...args).pipe(Effect.tap(() => Effect.sync(() => released++))),
        });
        const citations = yield* captureMemoryCodeCitations(f.config, {callerCwd: f.repo, refs: ['source.ts']}).pipe(
          Effect.provideService(CodeGraphQueryService, f.query),
          Effect.provideService(CodeGraphStore, observed),
        );
        expect(citations).toHaveLength(1);
        expect({acquired, released}).toEqual({acquired: 1, released: 1});
      }).pipe(TestClock.withLive),
    );
  });
});
