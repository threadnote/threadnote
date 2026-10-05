import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, Ref} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect, it} from 'vitest';
import {CodeGraphStore, type CodeGraphResolutionProgressCallback} from '@threadnote/graph/store';
import {compareCodeUnits} from '@threadnote/graph/ordering';
import {
  type CodeGraphWriterGate,
  PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES,
  PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES,
} from '@threadnote/graph/store/build/core';
import {resolveActivationReferences} from '@threadnote/graph/store/resolution';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  type CodeGraphEdge,
  type CodeGraphInventoryFile,
  type CodeGraphReference,
  type CodeGraphResolutionActivity,
  type CodeGraphSnapshot,
  CodeGraphStoreError,
  type CodeGraphSymbol,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import {claimPersistentBuildForTest} from '@threadnote/graph/test/helpers/code-graph-build';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {join, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {force: true, recursive: true})));
});

describe('code graph reference-resolution progress', () => {
  it('reports every bounded page, including pages with no matches, and cooperatively yields between pages', async () => {
    const fixture = await resolutionFixture();
    const caller = symbol('caller', 'caller');
    const references = Array.from({length: 1_201}, (_, index) => unresolvedReference(fixture.file, caller, index));
    const observations: CodeGraphResolutionActivity[] = [];

    const result = await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          const firstPage = yield* Deferred.make<void>();
          const completed = yield* Ref.make(false);
          const schedulerTurns = yield* Ref.make(0);
          yield* Effect.forkScoped(
            Deferred.await(firstPage).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  while (!(yield* Ref.get(completed))) {
                    yield* Ref.update(schedulerTurns, turns => turns + 1);
                    yield* Effect.yieldNow;
                  }
                }),
              ),
            ),
          );
          const onProgress: CodeGraphResolutionProgressCallback = progress =>
            Effect.gen(function* () {
              observations.push(progress);
              if (progress.pageCompleted === 0) yield* Deferred.succeed(firstPage, undefined);
            });
          const summary = yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
              yield* store.stageActivationFacts(
                fixture.databasePath,
                [caller],
                references.map(entry => entry.edge),
                references.map(entry => entry.reference),
              );
              return yield* store.resolveStagedReferences(fixture.databasePath, onProgress);
            }),
          );
          yield* Ref.set(completed, true);
          yield* Effect.yieldNow;
          return {schedulerTurns: yield* Ref.get(schedulerTurns), summary};
        }),
      ),
    );

    expect(observations.map(progress => progress.pageCompleted)).toEqual([0, 0, 1, 2, 3]);
    expect(observations.map(progress => progress.referencesCompleted)).toEqual([0, 0, 500, 1_000, 1_201]);
    expect(observations.every(progress => progress.pageTotal === 3 && progress.referencesTotal === 1_201)).toBe(true);
    expect(observations.at(-1)).toMatchObject({
      pagesCompleted: 3,
      pass: 1,
      referencesExamined: 1_201,
      resolved: 0,
    });
    expect(observations.every(progress => progress.elapsedMilliseconds >= progress.matchingMilliseconds)).toBe(true);
    expect(result.summary).toMatchObject({
      pagesCompleted: 3,
      passesCompleted: 1,
      referencesExamined: 1_201,
      resolved: 0,
      transactionMilliseconds: 0,
    });
    expect(result.schedulerTurns).toBeGreaterThan(0);
  });

  effectIt.effect(
    'groups production-shaped persistent pages under one bounded capacity reservation',
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => resolutionFixture());
        const target = symbol('bulk-target', 'bulkTarget');
        const callers = Array.from({length: 5_001}, (_, index) => {
          const suffix = String(index).padStart(4, '0');
          return symbol(`bulk-caller-${suffix}`, `bulkCaller${suffix}`);
        });
        const unresolved = callers.map((caller, index) => resolvableReference(fixture.file, caller, target, index));
        const snapshot = persistentSnapshot(fixture.identity, callers.length + 1, unresolved.length);
        const observations: CodeGraphResolutionActivity[] = [];
        const capacityBoundaries: Array<{readonly finalFactBytes: number; readonly rowCount: number}> = [];

        const store = yield* CodeGraphStore;
        const result = yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(
              fixture.databasePath,
              [target, ...callers],
              unresolved.map(entry => entry.edge),
              unresolved.map(entry => entry.reference),
              undefined,
              0,
            );
            const resolution = yield* store.resolveStagedReferences(
              fixture.databasePath,
              progress => Effect.sync(() => observations.push(progress)),
              (boundary, transaction) =>
                Effect.sync(() => capacityBoundaries.push(boundary)).pipe(Effect.andThen(transaction)),
            );
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              resolution,
            };
          }),
        );

        expect(result.resolution).toMatchObject({
          aliasesDiscovered: 5_001,
          pagesCompleted: 2,
          passesCompleted: 1,
          referencesExamined: 5_001,
          resolved: 5_001,
        });
        expect(result.resolution.elapsedMilliseconds).toBeLessThan(30_000);
        expect(result.resolution.longestTransactionMilliseconds).toBeGreaterThan(0);
        expect(capacityBoundaries).toHaveLength(1);
        expect(capacityBoundaries[0]).toMatchObject({rowCount: 55_011});
        expect(capacityBoundaries[0].finalFactBytes).toBeGreaterThan(0);
        expect(observations[0]).toMatchObject({
          pageCompleted: 0,
          pageTotal: 2,
          referencesCompleted: 0,
          referencesTotal: 5_001,
        });
        expect(observations.map(progress => progress.pageCompleted)).toEqual([0, 0, 0, 1, 1, 2, 2]);
        expect(observations.at(-2)).toMatchObject({resolved: 0});
        expect(observations.at(-1)).toMatchObject({resolved: 5_001});
        expect(observations.at(-1)?.longestTransactionMilliseconds).toBe(
          result.resolution.longestTransactionMilliseconds,
        );
        expect(result.graph.edges).toHaveLength(5_001);
        expect(result.graph.edges.every(edge => edge.targetId === target.id)).toBe(true);
        const semanticDigest = sha256HexSync(
          JSON.stringify(
            result.graph.edges.map(edge => [edge.id, edge.sourceId, edge.relation, edge.targetId, edge.provenance]),
          ),
        );
        expect(semanticDigest).toBe('db81d8f0de093727cacb3d934d779743287400d78764fafd2386d029a0bafba4');
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    30_000,
  );

  effectIt.effect(
    'resumes a committed transaction prefix inside a wider capacity reservation',
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => resolutionFixture());
        const target = symbol('window-target', 'windowTarget');
        const callers = Array.from({length: 17}, (_, index) =>
          symbol(`window-caller-${index}`, `windowCaller${index}`),
        );
        const unresolved = callers.map((caller, index) => resolvableReference(fixture.file, caller, target, index));
        const snapshot = persistentSnapshot(fixture.identity, callers.length + 1, unresolved.length);
        const firstCapacityRows: number[] = [];
        const firstProgress: CodeGraphResolutionActivity[] = [];
        const resumedCapacityRows: number[] = [];
        let firstTransactionAttempts = 0;
        let resumedTransactions = 0;

        const store = yield* CodeGraphStore;
        const result = yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(
              fixture.databasePath,
              [target, ...callers],
              unresolved.map(entry => entry.edge),
              unresolved.map(entry => entry.reference),
              undefined,
              0,
            );
            const failSecondTransaction: CodeGraphWriterGate = transaction =>
              Effect.gen(function* () {
                firstTransactionAttempts += 1;
                if (firstTransactionAttempts === 2) {
                  return yield* CodeGraphStoreError.of('Injected second resolution transaction failure.');
                }
                return yield* transaction;
              });
            const pageLimits = {
              candidateCount: PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES,
              payloadBytes: PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES,
              references: 1,
            };
            const firstFailure = yield* resolveActivationReferences(
              progress => Effect.sync(() => firstProgress.push(progress)),
              failSecondTransaction,
              (boundary, transactions) =>
                Effect.sync(() => firstCapacityRows.push(boundary.rowCount)).pipe(Effect.andThen(transactions)),
              pageLimits,
            ).pipe(Effect.flip);
            const sql = yield* SqlClient.SqlClient;
            const afterFailure = yield* sql<{readonly remaining: number; readonly resolved: number}>`
                SELECT
                  (SELECT COUNT(*) FROM building_references WHERE snapshot_id = ${snapshot.id}) AS remaining,
                  (SELECT COUNT(*) FROM edges
                   WHERE snapshot_id = ${snapshot.id} AND target_id IS NOT NULL) AS resolved
              `;
            const resumed = yield* resolveActivationReferences(
              undefined,
              transaction =>
                Effect.sync(() => {
                  resumedTransactions += 1;
                }).pipe(Effect.andThen(transaction)),
              (boundary, transactions) =>
                Effect.sync(() => resumedCapacityRows.push(boundary.rowCount)).pipe(Effect.andThen(transactions)),
              pageLimits,
            );
            const afterResume = yield* sql<{readonly remaining: number; readonly resolved: number}>`
                SELECT
                  (SELECT COUNT(*) FROM building_references WHERE snapshot_id = ${snapshot.id}) AS remaining,
                  (SELECT COUNT(*) FROM edges
                   WHERE snapshot_id = ${snapshot.id} AND target_id IS NOT NULL) AS resolved
              `;
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {
              afterFailure: afterFailure[0],
              afterResume: afterResume[0],
              firstFailure,
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              resumed,
            };
          }),
        );

        expect(result.firstFailure).toBeInstanceOf(CodeGraphStoreError);
        expect(firstCapacityRows).toEqual([88]);
        expect(firstTransactionAttempts).toBe(2);
        expect(result.afterFailure).toEqual({remaining: 13, resolved: 4});
        expect(firstProgress.at(-1)).toMatchObject({pageCompleted: 8, resolved: 4});
        expect(resumedCapacityRows).toEqual([88, 55]);
        // Commit width adapts from live SQLite duration; the durable eight-page
        // capacity windows and exact committed prefix are the stable contract.
        expect(resumedTransactions).toBeGreaterThanOrEqual(3);
        expect(resumedTransactions).toBeLessThanOrEqual(7);
        expect(result.resumed).toMatchObject({pagesCompleted: 13, referencesExamined: 13, resolved: 13});
        expect(result.afterResume).toEqual({remaining: 0, resolved: 17});
        expect(result.graph.edges).toHaveLength(17);
        expect(result.graph.edges.every(edge => edge.targetId === target.id)).toBe(true);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    30_000,
  );

  effectIt.effect(
    'resumes deferred unresolved-edge publication after a committed prefix',
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => resolutionFixture());
        const referenceCount = 1_501;
        const callers = Array.from({length: referenceCount}, (_, index) =>
          symbol(`deferred-caller-${String(index).padStart(4, '0')}`, `deferredCaller${index}`),
        );
        const unresolved = callers.map((caller, index) => unresolvedReference(fixture.file, caller, index));
        const snapshot = persistentSnapshot(fixture.identity, callers.length, unresolved.length);
        const firstCapacityRows: number[] = [];
        const resumedCapacityRows: number[] = [];
        let firstTransactionAttempts = 0;
        let resumedTransactions = 0;

        const store = yield* CodeGraphStore;
        const result = yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(
              fixture.databasePath,
              callers,
              unresolved.map(entry => entry.edge),
              unresolved.map(entry => entry.reference),
              undefined,
              0,
            );
            const dieBeforeSecondTransaction: CodeGraphWriterGate = transaction =>
              Effect.gen(function* () {
                firstTransactionAttempts += 1;
                if (firstTransactionAttempts === 2) {
                  return yield* Effect.die(new Error('Injected deferred-edge publication crash.'));
                }
                return yield* transaction;
              });
            const firstExit = yield* resolveActivationReferences(
              undefined,
              dieBeforeSecondTransaction,
              (boundary, transaction) =>
                Effect.sync(() => firstCapacityRows.push(boundary.rowCount)).pipe(Effect.andThen(transaction)),
            ).pipe(Effect.exit);
            const sql = yield* SqlClient.SqlClient;
            const afterCrash = yield* sql<{readonly remaining: number; readonly unresolved: number}>`
                SELECT
                  (SELECT COUNT(*) FROM building_references WHERE snapshot_id = ${snapshot.id}) AS remaining,
                  (SELECT COUNT(*) FROM edges
                   WHERE snapshot_id = ${snapshot.id} AND target_id IS NULL) AS unresolved
              `;
            const resumed = yield* resolveActivationReferences(
              undefined,
              transaction =>
                Effect.sync(() => {
                  resumedTransactions += 1;
                }).pipe(Effect.andThen(transaction)),
              (boundary, transaction) =>
                Effect.sync(() => resumedCapacityRows.push(boundary.rowCount)).pipe(Effect.andThen(transaction)),
            );
            const afterResume = yield* sql<{readonly remaining: number; readonly unresolved: number}>`
                SELECT
                  (SELECT COUNT(*) FROM building_references WHERE snapshot_id = ${snapshot.id}) AS remaining,
                  (SELECT COUNT(*) FROM edges
                   WHERE snapshot_id = ${snapshot.id} AND target_id IS NULL) AS unresolved
              `;
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {
              afterCrash: afterCrash[0],
              afterResume: afterResume[0],
              firstExit,
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              resumed,
            };
          }),
        );

        expect(Exit.isFailure(result.firstExit)).toBe(true);
        expect(firstTransactionAttempts).toBe(2);
        expect(firstCapacityRows).toEqual([12_000, 8]);
        expect(result.afterCrash).toEqual({remaining: 1, unresolved: 1_500});
        expect(resumedTransactions).toBe(1);
        expect(resumedCapacityRows).toEqual([8]);
        expect(result.resumed).toMatchObject({passesCompleted: 1, referencesExamined: 1, resolved: 0});
        expect(result.afterResume).toEqual({remaining: 0, unresolved: referenceCount});
        const semanticRows = (edges: readonly CodeGraphEdge[]) =>
          edges
            .map(edge => [
              edge.id,
              edge.sourceId,
              edge.sourceName,
              edge.relation,
              edge.targetId,
              edge.targetName,
              edge.provenance,
              edge.confidence,
              edge.evidencePath,
              edge.evidenceSpan,
            ])
            .sort((left, right) => compareCodeUnits(String(left[0]), String(right[0])));
        expect(semanticRows(result.graph.edges)).toEqual(semanticRows(unresolved.map(entry => entry.edge)));
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    30_000,
  );

  it('keeps persistent lookup-summary work observable across many distinct keys', async () => {
    const fixture = await resolutionFixture();
    const targets = Array.from({length: 600}, (_, index) => symbol(`target-${index}`, `target${index}`));
    const callers = Array.from({length: targets.length}, (_, index) => symbol(`caller-${index}`, `caller${index}`));
    const unresolved = callers.map((caller, index) => resolvableReference(fixture.file, caller, targets[index], index));
    const snapshot = persistentSnapshot(fixture.identity, targets.length + callers.length, unresolved.length);
    const observations: CodeGraphResolutionActivity[] = [];

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(
              fixture.databasePath,
              [...targets, ...callers],
              unresolved.map(entry => entry.edge),
              unresolved.map(entry => entry.reference),
              undefined,
              0,
            );
            const resolution = yield* store.resolveStagedReferences(fixture.databasePath, progress =>
              Effect.sync(() => observations.push(progress)),
            );
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              resolution,
            };
          }),
        );
      }),
    );

    expect(result.resolution).toMatchObject({
      pagesCompleted: 1,
      referencesExamined: targets.length,
      resolved: targets.length,
    });
    // Two phase-start observations plus three 256-key lookup-summary batches
    // keep the heartbeat live before the page can report completed references.
    expect(observations.filter(progress => progress.pageCompleted === 0)).toHaveLength(5);
    expect(observations.at(-1)).toMatchObject({
      pageCompleted: 1,
      referencesCompleted: targets.length,
      resolved: targets.length,
    });
    expect(result.graph.edges).toHaveLength(targets.length);
    expect(result.graph.edges.every(edge => edge.targetId?.startsWith('target-') === true)).toBe(true);
  }, 30_000);
});

async function resolutionFixture() {
  const root = await mkdtemp('threadnote-resolution-progress-');
  temporaryRoots.push(root);
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: 'resolution-progress-fixture',
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
    path: 'src/resolution.ts',
    size: 128,
    source: 'commit',
  };
  return {databasePath: join(root, 'graph-v3.sqlite'), file, identity};
}

function symbol(id: string, name: string): CodeGraphSymbol {
  return {
    contentHash: `hash-${id}`,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`typescript:name:${name}`],
    name,
    path: 'src/resolution.ts',
    qualifiedName: name,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function unresolvedReference(
  file: CodeGraphInventoryFile,
  caller: CodeGraphSymbol,
  index: number,
): {readonly edge: CodeGraphEdge; readonly reference: CodeGraphReference} {
  const suffix = String(index).padStart(4, '0');
  const edge: CodeGraphEdge = {
    confidence: 0.7,
    evidencePath: file.path,
    evidenceSpan: caller.span,
    id: `unresolved-${suffix}`,
    provenance: 'syntactic',
    relation: 'calls',
    sourceId: caller.id,
    sourceName: caller.name,
    targetName: `missing-${suffix}`,
  };
  return {
    edge,
    reference: {
      edgeId: edge.id,
      evidencePath: file.path,
      evidenceSpan: caller.span,
      lookupTiers: [[`typescript:name:missing-${suffix}`]],
      provenance: 'syntactic',
      relation: 'calls',
      resolutionDomain: 'typescript',
      sourceId: caller.id,
      sourceName: caller.name,
      targetName: edge.targetName,
    },
  };
}

function resolvableReference(
  file: CodeGraphInventoryFile,
  caller: CodeGraphSymbol,
  target: CodeGraphSymbol,
  index: number,
): {readonly edge: CodeGraphEdge; readonly reference: CodeGraphReference} {
  const suffix = String(index).padStart(4, '0');
  const edge: CodeGraphEdge = {
    confidence: 0.7,
    evidencePath: file.path,
    evidenceSpan: caller.span,
    id: `bulk-unresolved-${suffix}`,
    provenance: 'syntactic',
    relation: 'calls',
    sourceId: caller.id,
    sourceName: caller.name,
    targetName: target.name,
  };
  return {
    edge,
    reference: {
      aliasLookupKeys: [`typescript:name:bulkAlias${suffix}`],
      edgeId: edge.id,
      evidencePath: file.path,
      evidenceSpan: caller.span,
      lookupTiers: [[`typescript:name:${target.name}`]],
      provenance: 'syntactic',
      relation: edge.relation,
      resolutionDomain: 'typescript',
      sourceId: caller.id,
      sourceName: caller.name,
      targetName: target.name,
    },
  };
}

function persistentSnapshot(identity: RepositoryIdentity, symbolCount: number, edgeCount: number): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: false,
    edgeCount,
    extractorSet: 'resolution-progress-test',
    fileCount: 1,
    id: `persistent-resolution-${symbolCount}-${edgeCount}`,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount,
    worktreeId: identity.worktreeId,
  };
}
