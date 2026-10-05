import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, Fiber, FileSystem, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CodeGraphDiskCapacityPressureError,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '@threadnote/graph/disk/capacity';
import {CodeGraphStore} from '@threadnote/graph/store';
import {
  codeGraphColdIndexDeferralEligible,
  codeGraphColdIndexDeferralWorthwhile,
  deferCodeGraphQueryIndexesForColdBuild,
  restoreCodeGraphQueryIndexesAfterColdBuild,
} from '@threadnote/graph/store/cold_index_deferral';
import type {CodeGraphDirectPersistentCapacityProtector} from '@threadnote/graph/store/models';
import {claimPersistentSnapshotBuild} from '@threadnote/graph/store/persistent_build';
import {CODE_GRAPH_QUERY_INDEX_DEFINITIONS, inspectCodeGraphQueryIndexes} from '@threadnote/graph/store/query/indexes';
import {codeGraphSchemaInitializationReceiptCurrent} from '@threadnote/graph/store/schema/receipt';
import type {
  CodeGraphEdge,
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphStoreFailure,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {claimPersistentBuildForTest} from '@threadnote/graph/test/helpers/code-graph-build';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('code graph cold query-index deferral', () => {
  it('admits exactly stores with no visible or reusable graph state', () => {
    fc.assert(
      fc.property(
        fc.record({
          activeSnapshotPresent: fc.boolean(),
          edgePresent: fc.boolean(),
          otherIncompleteSnapshotPresent: fc.boolean(),
          readySnapshotPresent: fc.boolean(),
          symbolPresent: fc.boolean(),
        }),
        observation => {
          const expected = Object.values(observation).every(present => !present);
          expect(codeGraphColdIndexDeferralEligible(observation)).toBe(expected);
        },
      ),
      {numRuns: 150},
    );
  });

  it('defers only when file count or source bytes reaches the bulk-build envelope', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({min: 0, max: 256 * 1_024}), {maxLength: 511}), sizes => {
        const files = sizes.map(size => ({size}));
        const totalBytes = sizes.reduce((total, size) => total + size, 0);
        expect(codeGraphColdIndexDeferralWorthwhile(files)).toBe(totalBytes >= 16 * 1_048_576);
      }),
      {numRuns: 150},
    );
    expect(codeGraphColdIndexDeferralWorthwhile(Array.from({length: 512}, () => ({size: 0})))).toBe(true);
  });

  effectIt.effect('restores every exact index through one capacity boundary before reference resolution', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* coldIndexFixture('restore');
        const store = yield* CodeGraphStore;
        const boundaries: CodeGraphDirectPersistentCapacityBoundary[] = [];
        const progress: {readonly completed: number; readonly elapsedMilliseconds: number; readonly total: number}[] =
          [];
        let pauseRestoration = true;
        const guard: CodeGraphDirectPersistentCapacityProtector = <A, E, R>(
          boundary: CodeGraphDirectPersistentCapacityBoundary,
          transaction: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E | CodeGraphStoreFailure, R> =>
          Effect.suspend((): Effect.Effect<A, E | CodeGraphStoreFailure, R> => {
            boundaries.push({...boundary});
            if (pauseRestoration && boundary.operation === 'restore persistent code graph query indexes') {
              return Effect.fail(CodeGraphDiskCapacityPressureError.of(boundary.operation));
            }
            return transaction;
          });

        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.initialize(fixture.databasePath);
            const sql = yield* SqlClient.SqlClient;
            const ownerToken = yield* claimPersistentBuildForTest(
              store,
              fixture.databasePath,
              fixture.identity,
              fixture.snapshot,
            );
            yield* store.prepareActivation(
              fixture.databasePath,
              [fixture.file],
              fixture.snapshot.id,
              undefined,
              ownerToken,
            );
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing.map(definition => definition.name)).toEqual(
              CODE_GRAPH_QUERY_INDEX_DEFINITIONS.map(definition => definition.name),
            );
            expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(false);

            yield* store.stageActivationFactBatches(fixture.databasePath, [
              {
                batchIndex: 0,
                edges: [fixture.edge],
                finalFactBytes: 512,
                references: [],
                symbols: [fixture.symbol],
              },
            ]);
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toHaveLength(
              CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length,
            );
            const failed = yield* store
              .finalizePersistentMaterializationPlan(fixture.databasePath, 1, guard)
              .pipe(Effect.exit);
            expect(Exit.isFailure(failed)).toBe(true);
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toHaveLength(
              CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length,
            );
            const building = yield* sql<{readonly state: string}>`
              SELECT state FROM snapshots WHERE id = ${fixture.snapshot.id}
            `;
            expect(building[0]?.state).toBe('building');

            pauseRestoration = false;
            yield* store.finalizePersistentMaterializationPlan(fixture.databasePath, 1, guard, observation =>
              Effect.sync(() => progress.push(observation)),
            );
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toEqual([]);
            expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(true);
            yield* store.resolveStagedReferences(fixture.databasePath);
          }),
          {writerLockPath: fixture.writerLockPath},
        );

        const restorationBoundaries = boundaries.filter(
          boundary => boundary.operation === 'restore persistent code graph query indexes',
        );
        expect(restorationBoundaries).toHaveLength(2);
        expect(restorationBoundaries[0]).toEqual(restorationBoundaries[1]);
        expect(restorationBoundaries[1]).toEqual({
          finalFactBytes: 0,
          operation: 'restore persistent code graph query indexes',
          rowCount:
            1 +
            CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length +
            CODE_GRAPH_QUERY_INDEX_DEFINITIONS.filter(definition => definition.table === 'edges').length +
            CODE_GRAPH_QUERY_INDEX_DEFINITIONS.filter(definition => definition.table === 'symbols').length,
        });
        expect(progress.map(observation => observation.completed)).toEqual(
          Array.from({length: CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length + 1}, (_, index) => index),
        );
        expect(progress.every(observation => observation.total === CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length)).toBe(
          true,
        );
        expect(
          progress.every(
            (observation, index) =>
              index === 0 || observation.elapsedMilliseconds >= progress[index - 1].elapsedMilliseconds,
          ),
        ).toBe(true);
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('repairs a session-loss deferral before the next session can read graph state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* coldIndexFixture('session-loss');
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.initialize(fixture.databasePath);
            const ownerToken = yield* claimPersistentBuildForTest(
              store,
              fixture.databasePath,
              fixture.identity,
              fixture.snapshot,
            );
            yield* store.prepareActivation(
              fixture.databasePath,
              [fixture.file],
              fixture.snapshot.id,
              undefined,
              ownerToken,
            );
            const sql = yield* SqlClient.SqlClient;
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toHaveLength(
              CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length,
            );
          }),
          {writerLockPath: fixture.writerLockPath},
        );

        yield* store.initialize(fixture.databasePath);
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toEqual([]);
            expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(true);
          }),
          {writerLockPath: fixture.writerLockPath},
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('commits each index independently and rolls back only the failed restoration statement', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* coldIndexFixture('partial-yield');
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.initialize(fixture.databasePath);
            const ownerToken = yield* claimPersistentBuildForTest(
              store,
              fixture.databasePath,
              fixture.identity,
              fixture.snapshot,
            );
            yield* store.prepareActivation(
              fixture.databasePath,
              [fixture.file],
              fixture.snapshot.id,
              undefined,
              ownerToken,
            );
            const sql = yield* SqlClient.SqlClient;
            let cooperativeTicks = 0;
            const ticker = yield* Effect.forkScoped(
              Effect.forever(
                Effect.yieldNow.pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      cooperativeTicks += 1;
                    }),
                  ),
                ),
              ),
            );
            const observations: number[] = [];
            const failed = yield* restoreCodeGraphQueryIndexesAfterColdBuild({
              observeTransaction: () =>
                Effect.gen(function* () {
                  expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(false);
                  observations.push(cooperativeTicks);
                  if (observations.length === 3) throw new Error('injected index restoration failure');
                }).pipe(Effect.orDie),
              ownerToken,
              snapshotId: fixture.snapshot.id,
              sql,
            }).pipe(Effect.exit);
            yield* Fiber.interrupt(ticker);

            expect(Exit.isFailure(failed)).toBe(true);
            expect(new Set(observations).size).toBeGreaterThan(1);
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toHaveLength(
              CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length - 2,
            );
            expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(false);

            expect(
              yield* restoreCodeGraphQueryIndexesAfterColdBuild({
                ownerToken,
                snapshotId: fixture.snapshot.id,
                sql,
              }),
            ).toBe(true);
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toEqual([]);
            expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(true);
          }),
          {writerLockPath: fixture.writerLockPath},
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect.prop(
    'resumes every interrupted index prefix without prematurely publishing schema completion',
    {
      interruptAt: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length})),
    },
    ({interruptAt}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* coldIndexFixture('interrupted-prefix');
          const store = yield* CodeGraphStore;
          yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              yield* store.initialize(fixture.databasePath);
              const ownerToken = yield* claimPersistentBuildForTest(
                store,
                fixture.databasePath,
                fixture.identity,
                fixture.snapshot,
              );
              yield* store.prepareActivation(
                fixture.databasePath,
                [fixture.file],
                fixture.snapshot.id,
                undefined,
                ownerToken,
              );
              const sql = yield* SqlClient.SqlClient;
              const paused = yield* Deferred.make<void>();
              let observed = 0;
              const restoration = yield* restoreCodeGraphQueryIndexesAfterColdBuild({
                observeTransaction: () =>
                  Effect.gen(function* () {
                    expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(false);
                    observed += 1;
                    if (observed === interruptAt) {
                      yield* Deferred.succeed(paused, undefined);
                      return yield* Effect.never;
                    }
                  }).pipe(Effect.orDie),
                ownerToken,
                snapshotId: fixture.snapshot.id,
                sql,
              }).pipe(Effect.forkScoped);
              yield* Deferred.await(paused);
              yield* Fiber.interrupt(restoration);
              expect(Exit.isFailure(yield* Fiber.await(restoration))).toBe(true);
              expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toHaveLength(
                CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length - interruptAt + 1,
              );
              expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(false);
              const marker = yield* sql<{readonly value: string}>`
                SELECT value FROM activation_state WHERE key = 'query_indexes_deferred'
              `;
              expect(marker).toEqual([{value: '1'}]);

              const options = {ownerToken, snapshotId: fixture.snapshot.id, sql};
              expect(yield* restoreCodeGraphQueryIndexesAfterColdBuild(options)).toBe(true);
              expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toEqual([]);
              expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(true);
              expect(yield* restoreCodeGraphQueryIndexesAfterColdBuild(options)).toBe(false);
            }),
            {writerLockPath: fixture.writerLockPath},
          );
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    {arbitrary: {runs: 8, seed: 'cold-index-interrupted-prefix'}},
  );

  effectIt.effect('revalidates indexes atomically when a claim races cold deferral', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* coldIndexFixture('claim-race');
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.initialize(fixture.databasePath);
            const firstOwnerToken = yield* claimPersistentBuildForTest(
              store,
              fixture.databasePath,
              fixture.identity,
              fixture.snapshot,
            );
            // A known batch count keeps the first build's preparation eager so
            // the test can place deferral exactly inside the second claim.
            yield* store.prepareActivation(
              fixture.databasePath,
              [fixture.file],
              fixture.snapshot.id,
              1,
              firstOwnerToken,
            );

            const sql = yield* SqlClient.SqlClient;
            const secondIdentity = {...fixture.identity, worktreeId: 'v'.repeat(64)};
            const secondSnapshot = {
              ...fixture.snapshot,
              id: 'claim-race-second-snapshot',
              worktreeId: secondIdentity.worktreeId,
            };
            let writerAcquisitions = 0;
            let deferredBetweenSchemaCheckAndPublication = false;
            const writerGate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.suspend(() => {
                writerAcquisitions += 1;
                if (writerAcquisitions !== 3) return effect;
                return deferCodeGraphQueryIndexesForColdBuild(sql, fixture.snapshot.id, firstOwnerToken).pipe(
                  Effect.tap(deferred =>
                    Effect.sync(() => {
                      deferredBetweenSchemaCheckAndPublication = deferred;
                    }),
                  ),
                  Effect.andThen(effect),
                );
              });

            yield* claimPersistentSnapshotBuild(
              secondIdentity,
              secondSnapshot,
              'claim-race-owner-token',
              {
                logicalSnapshotId: `cgsn_${'0'.repeat(40)}`,
                owner: {buildId: '11111111-1111-1111', processId: process.pid},
              },
              writerGate,
            );

            expect(writerAcquisitions).toBe(3);
            expect(deferredBetweenSchemaCheckAndPublication).toBe(true);
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toEqual([]);
            expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(true);
          }),
          {writerLockPath: fixture.writerLockPath},
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('keeps query indexes live when a ready snapshot is reusable', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* coldIndexFixture('ready');
        const store = yield* CodeGraphStore;
        const ready = {...fixture.snapshot, id: `${fixture.snapshot.id}-ready`, state: 'ready' as const};
        yield* store.activate(
          fixture.databasePath,
          fixture.identity,
          ready,
          [fixture.file],
          [fixture.symbol],
          [fixture.edge],
        );
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(
              store,
              fixture.databasePath,
              fixture.identity,
              fixture.snapshot,
            );
            yield* store.prepareActivation(
              fixture.databasePath,
              [fixture.file],
              fixture.snapshot.id,
              undefined,
              ownerToken,
            );
            const sql = yield* SqlClient.SqlClient;
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toEqual([]);
          }),
          {writerLockPath: fixture.writerLockPath},
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );
});

const coldIndexFixture = Effect.fn('test.coldIndexFixture')(function* (suffix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-cold-index-${suffix}-`});
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: `cold-index-${suffix}`,
    gitCommonDirectory: root,
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'r'.repeat(64),
    worktreeId: 'w'.repeat(64),
  };
  const file: CodeGraphInventoryFile = {
    blobId: 'b'.repeat(40),
    contentHash: 'h'.repeat(64),
    language: 'typescript',
    mode: '100644',
    path: 'src/cold-index.ts',
    // Exercise the deferred bulk-build path rather than the small-graph eager
    // index path covered by the pure admission property above.
    size: 16 * 1_048_576,
    source: 'commit',
  };
  const symbol: CodeGraphSymbol = {
    contentHash: file.contentHash,
    exported: true,
    id: `symbol-${suffix}`,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`typescript:name:coldIndex${suffix}`],
    name: `coldIndex${suffix}`,
    path: file.path,
    qualifiedName: `coldIndex${suffix}`,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
  const edge: CodeGraphEdge = {
    confidence: 1,
    evidencePath: file.path,
    evidenceSpan: symbol.span,
    id: `edge-${suffix}`,
    provenance: 'declared',
    relation: 'calls',
    sourceId: symbol.id,
    sourceName: symbol.name,
    targetId: symbol.id,
    targetName: symbol.name,
  };
  const snapshot: CodeGraphSnapshot = {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: 1,
    extractorSet: 'cold-index-test',
    fileCount: 1,
    id: `cgsn_${suffix.padEnd(40, '0').slice(0, 40)}`,
    repositoryId: identity.repositoryId,
    state: 'building',
    symbolCount: 1,
    worktreeId: identity.worktreeId,
  };
  return {
    databasePath: path.join(root, 'graph.sqlite'),
    edge,
    file,
    identity,
    snapshot,
    symbol,
    writerLockPath: path.join(root, 'writer.lock'),
  };
});
