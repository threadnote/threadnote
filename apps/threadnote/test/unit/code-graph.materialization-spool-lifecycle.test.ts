import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import {expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphDirectPersistentCapacityProtector} from '@threadnote/graph/store/models';
import type {CodeGraphDirectPersistentCapacityBoundary} from '@threadnote/graph/disk/capacity';
import type {
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphStoreFailure,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import {CodeGraphDiskCapacityPressureError} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {claimPersistentBuildForTest} from '@threadnote/graph/test/helpers/code-graph-build';
import {materializationStorageFiles} from '@threadnote/graph/indexer/materialization';
import {codeGraphSqliteGet} from '@threadnote/graph/sqlite_statement';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

effectIt.effect('materializes a full build through the sorted sidecar and removes it after finalization', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-materialization-spool-lifecycle-'});
    const identity = repositoryIdentity(root);
    const repositoryRoot = path.join(root, identity.checkoutId);
    yield* fs.makeDirectory(repositoryRoot, {recursive: true});
    const databasePath = path.join(repositoryRoot, 'graph-v3.sqlite');
    const file: CodeGraphInventoryFile = {
      blobId: Effect2.pipe('1', EffectString.repeat(40)),
      contentHash: Effect2.pipe('2', EffectString.repeat(64)),
      language: 'typescript',
      mode: '100644',
      path: 'src/main.ts',
      size: 128,
      source: 'commit',
    };
    const snapshot: CodeGraphSnapshot = {
      commit: identity.headCommit,
      dirty: false,
      edgeCount: 0,
      extractorSet: 'materialization-spool-test',
      fileCount: 1,
      graphContentId: `cgc_${Effect2.pipe('3', EffectString.repeat(40))}`,
      id: `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}-direct`,
      repositoryId: identity.repositoryId,
      state: 'building',
      symbolCount: 0,
      worktreeId: identity.worktreeId,
    };
    const symbol: CodeGraphSymbol = {
      contentHash: file.contentHash,
      exported: true,
      id: 'symbol-main',
      kind: 'function',
      language: 'typescript',
      lookupKeys: ['typescript:name:main', 'generic:main'],
      name: 'main',
      path: file.path,
      qualifiedName: 'main',
      span: {column: 1, endColumn: 5, endLine: 1, line: 1},
    };
    let databaseJournalHighWaterBytes = 0;
    let databaseWalHighWaterBytes = 0;
    let sidecarDatabaseHighWaterBytes = 0;
    let sidecarJournalHighWaterBytes = 0;
    let sidecarWalHighWaterBytes = 0;
    const context = {
      checkoutId: identity.checkoutId,
      onStorageObservation: (observation: {
        readonly journalBytes: number;
        readonly sidecarDatabaseBytes: number;
        readonly sidecarJournalBytes: number;
        readonly sidecarWalBytes: number;
        readonly walBytes: number;
      }) => {
        databaseJournalHighWaterBytes = Math.max(databaseJournalHighWaterBytes, observation.journalBytes);
        databaseWalHighWaterBytes = Math.max(databaseWalHighWaterBytes, observation.walBytes);
        sidecarDatabaseHighWaterBytes = Math.max(sidecarDatabaseHighWaterBytes, observation.sidecarDatabaseBytes);
        sidecarJournalHighWaterBytes = Math.max(sidecarJournalHighWaterBytes, observation.sidecarJournalBytes);
        sidecarWalHighWaterBytes = Math.max(sidecarWalHighWaterBytes, observation.sidecarWalBytes);
      },
      repositoryRoot,
    };
    const store = yield* CodeGraphStore;
    const resources: string[] = [];
    yield* store.withSession(
      databasePath,
      Effect.gen(function* () {
        const ownerToken = yield* claimPersistentBuildForTest(store, databasePath, identity, snapshot);
        yield* store.prepareActivation(databasePath, [file], snapshot.id, undefined, ownerToken);
        const batch = {
          batchIndex: 0,
          edges: [],
          finalFactBytes: 100,
          references: [],
          sourceBytes: file.size,
          symbols: [symbol],
        } as const;
        yield* store.stageActivationFactBatches(databasePath, [batch], undefined, undefined, context);
        yield* store.stageActivationFactBatches(databasePath, [batch], undefined, undefined, context);
        resources.length = 0;
        const prepared = yield* store.preparePersistentMaterializationSpool(
          databasePath,
          1,
          undefined,
          context,
          preparation =>
            Effect.acquireUseRelease(
              Effect.sync(() => resources.push('preparation-acquired')),
              () => preparation,
              () => Effect.sync(() => resources.push('preparation-released')),
            ),
        );
        expect(resources).toEqual(['preparation-acquired', 'preparation-released']);
        expect(yield* store.stagedFactCounts(databasePath)).toEqual({edges: 0, symbols: 0});
        yield* store.finalizePersistentMaterializationPlan(databasePath, 1, undefined, undefined, context, prepared);
        expect(yield* store.stagedFactCounts(databasePath)).toEqual({edges: 0, symbols: 1});
      }),
      {
        onWriterAcquired: () => Effect.sync(() => resources.push('writer-acquired')),
        onWriterReleased: () => Effect.sync(() => resources.push('writer-released')),
        writerLockPath: path.join(root, 'writer.lock'),
      },
    );
    expect(resources.indexOf('preparation-released')).toBeLessThan(resources.indexOf('writer-acquired'));
    const sidecarPath = path.join(repositoryRoot, `materialization-spool-v2-${snapshot.id}.sqlite`);
    for (const candidate of [sidecarPath, `${sidecarPath}-journal`, `${sidecarPath}-shm`, `${sidecarPath}-wal`]) {
      expect(yield* fs.exists(candidate)).toBe(false);
    }
    expect(Math.max(databaseJournalHighWaterBytes, databaseWalHighWaterBytes)).toBeGreaterThan(0);
    expect(sidecarDatabaseHighWaterBytes).toBeGreaterThan(0);
    expect(sidecarJournalHighWaterBytes).toBeGreaterThan(0);
    expect(sidecarWalHighWaterBytes).toBe(0);
    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(
        codeGraphSqliteGet<{
          readonly lookup: number;
          readonly postings: number;
          readonly receipts: number;
          readonly symbols: number;
        }>(
          database,
          `SELECT
             (SELECT COUNT(*) FROM symbols WHERE snapshot_id = ?) AS symbols,
             (SELECT COUNT(*) FROM snapshot_symbol_lookup WHERE snapshot_id = ?) AS lookup,
             (SELECT COUNT(*) FROM building_materialization_batches WHERE snapshot_id = ?) AS receipts,
             (SELECT posting_count FROM building_lexical_counters WHERE snapshot_id = ?) AS postings`,
          snapshot.id,
          snapshot.id,
          snapshot.id,
          snapshot.id,
        ),
      ).toEqual({lookup: 2, postings: 3, receipts: 1, symbols: 1});
    } finally {
      database.close(true);
    }
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect('rejects a replaced ready sidecar before registering or applying its plan', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-materialization-spool-replaced-'});
    const identity = repositoryIdentity(root);
    const repositoryRoot = path.join(root, identity.checkoutId);
    yield* fs.makeDirectory(repositoryRoot, {recursive: true});
    const databasePath = path.join(repositoryRoot, 'graph-v3.sqlite');
    const file: CodeGraphInventoryFile = {
      blobId: Effect2.pipe('1', EffectString.repeat(40)),
      contentHash: Effect2.pipe('2', EffectString.repeat(64)),
      language: 'typescript',
      mode: '100644',
      path: 'src/replaced.ts',
      size: 128,
      source: 'commit',
    };
    const snapshot: CodeGraphSnapshot = {
      commit: identity.headCommit,
      dirty: false,
      edgeCount: 0,
      extractorSet: 'materialization-spool-replaced-test',
      fileCount: 1,
      graphContentId: `cgc_${Effect2.pipe('3', EffectString.repeat(40))}`,
      id: `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}-direct`,
      repositoryId: identity.repositoryId,
      state: 'building',
      symbolCount: 0,
      worktreeId: identity.worktreeId,
    };
    const symbol: CodeGraphSymbol = {
      contentHash: file.contentHash,
      exported: true,
      id: 'symbol-replaced',
      kind: 'function',
      language: 'typescript',
      lookupKeys: ['typescript:name:replaced'],
      name: 'replaced',
      path: file.path,
      qualifiedName: 'replaced',
      span: {column: 1, endColumn: 9, endLine: 1, line: 1},
    };
    const context = {checkoutId: identity.checkoutId, repositoryRoot};
    const store = yield* CodeGraphStore;
    yield* store.withSession(
      databasePath,
      Effect.gen(function* () {
        const ownerToken = yield* claimPersistentBuildForTest(store, databasePath, identity, snapshot);
        yield* store.prepareActivation(databasePath, [file], snapshot.id, undefined, ownerToken);
        yield* store.stageActivationFactBatches(
          databasePath,
          [
            {
              batchIndex: 0,
              edges: [],
              finalFactBytes: 100,
              references: [],
              sourceBytes: file.size,
              symbols: [symbol],
            },
          ],
          undefined,
          undefined,
          context,
        );
        const prepared = yield* store.preparePersistentMaterializationSpool(
          databasePath,
          1,
          undefined,
          context,
          preparation => preparation,
        );
        const replacement = `${prepared.spoolPath}.replacement`;
        yield* fs.copy(prepared.spoolPath, replacement, {overwrite: true});
        yield* Effect.sync(() => {
          const database = new Database(replacement, {strict: true});
          try {
            database
              .query('UPDATE materialization_spool_header SET graph_content_id = ? WHERE singleton = 1')
              .run(`cgc_${Effect2.pipe('9', EffectString.repeat(40))}`);
          } finally {
            database.close(true);
          }
        });
        yield* fs.remove(prepared.spoolPath);
        yield* fs.rename(replacement, prepared.spoolPath);
        expect(
          (yield* Effect.exit(
            store.finalizePersistentMaterializationPlan(databasePath, 1, undefined, undefined, context, prepared),
          ))._tag,
        ).toBe('Failure');
      }),
    );
    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(
        codeGraphSqliteGet<{readonly count: number}>(
          database,
          'SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?',
          snapshot.id,
        ),
      ).toEqual({count: 0});
    } finally {
      database.close(true);
    }
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect('seals raw spool surfaces before a refused sort and resumes without surface loss', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-materialization-spool-capacity-'});
    const identity = repositoryIdentity(root);
    const repositoryRoot = path.join(root, identity.checkoutId);
    yield* fs.makeDirectory(repositoryRoot, {recursive: true});
    const databasePath = path.join(repositoryRoot, 'graph-v3.sqlite');
    const file: CodeGraphInventoryFile = {
      blobId: Effect2.pipe('1', EffectString.repeat(40)),
      contentHash: Effect2.pipe('2', EffectString.repeat(64)),
      language: 'typescript',
      mode: '100644',
      path: 'src/capacity.ts',
      size: 128,
      source: 'commit',
    };
    const snapshot: CodeGraphSnapshot = {
      commit: identity.headCommit,
      dirty: false,
      edgeCount: 0,
      extractorSet: 'materialization-spool-capacity-test',
      fileCount: 1,
      graphContentId: `cgc_${Effect2.pipe('3', EffectString.repeat(40))}`,
      id: `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}-direct`,
      repositoryId: identity.repositoryId,
      state: 'building',
      symbolCount: 2,
      worktreeId: identity.worktreeId,
    };
    const symbols: readonly CodeGraphSymbol[] = EffectArray.map(['alpha', 'beta'], (name, index) => ({
      contentHash: file.contentHash,
      exported: true,
      id: `symbol-${name}`,
      kind: 'function',
      language: 'typescript',
      lookupKeys: [`typescript:name:${name}`, `generic:${name}`],
      name,
      path: file.path,
      qualifiedName: name,
      span: {column: 1, endColumn: name.length + 1, endLine: index + 1, line: index + 1},
    }));
    const context = {checkoutId: identity.checkoutId, repositoryRoot};
    const boundaries: Array<{
      readonly finalFactBytes: number;
      readonly mainSortPayloadBytes?: number;
      readonly operation: string;
      readonly rowCount: number;
      readonly transientFilesystem?: string;
    }> = [];
    let refuseSort = true;
    const protector: CodeGraphDirectPersistentCapacityProtector = <A, E, R>(
      boundary: CodeGraphDirectPersistentCapacityBoundary,
      transaction: Effect.Effect<A, E, R>,
    ) =>
      Effect.suspend((): Effect.Effect<A, E | CodeGraphStoreFailure, R> => {
        boundaries.push(boundary);
        return refuseSort && boundary.operation === 'sort persistent code graph materialization spool'
          ? Effect.fail(CodeGraphDiskCapacityPressureError.of(boundary.operation))
          : transaction;
      });
    const store = yield* CodeGraphStore;
    yield* store.withSession(
      databasePath,
      Effect.gen(function* () {
        const ownerToken = yield* claimPersistentBuildForTest(store, databasePath, identity, snapshot);
        yield* store.prepareActivation(databasePath, [file], snapshot.id, undefined, ownerToken);
        yield* store.stageActivationFactBatches(
          databasePath,
          [{batchIndex: 0, edges: [], finalFactBytes: 200, references: [], sourceBytes: file.size, symbols}],
          undefined,
          undefined,
          context,
        );
        const failed = yield* Effect.exit(
          store.preparePersistentMaterializationSpool(databasePath, 1, protector, context, preparation => preparation),
        );
        expect(failed._tag).toBe('Failure');
        expect(boundaries).toHaveLength(1);
        expect(boundaries[0]).toMatchObject({
          operation: 'sort persistent code graph materialization spool',
          transientFilesystem: 'temporary',
        });
        expect(boundaries[0].finalFactBytes).toBeGreaterThan(0);
        expect(boundaries[0].mainSortPayloadBytes).toBeGreaterThanOrEqual(boundaries[0].finalFactBytes);

        const spoolPath = path.join(repositoryRoot, `materialization-spool-v2-${snapshot.id}.sqlite`);
        const sealed = new Database(spoolPath, {readonly: true, strict: true});
        try {
          expect(sealed.query('SELECT stage, sorted_surface_count FROM materialization_spool_state').get()).toEqual({
            stage: 'sealed',
            sorted_surface_count: 0,
          });
          expect(
            sealed
              .query(
                "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'materialization_raw_%'",
              )
              .get(),
          ).toEqual({count: 7});
          expect(
            sealed
              .query(
                "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'materialization_ordered_%'",
              )
              .get(),
          ).toEqual({count: 0});
        } finally {
          sealed.close(true);
        }

        refuseSort = false;
        const prepared = yield* store.preparePersistentMaterializationSpool(
          databasePath,
          1,
          protector,
          context,
          preparation => preparation,
        );
        expect(boundaries).toHaveLength(2);
        expect(EffectArray.map(prepared.surfaces, surface => surface.name)).toEqual([
          'symbols',
          'lookup',
          'edges',
          'references',
          'reexports',
          'monikers',
          'lexical_snapshot',
          'lexical_symbols',
          'lexical_terms',
          'symbol_terms',
        ]);
        expect(EffectArray.filter(prepared.surfaces, surface => surface.name === 'symbols')).toEqual([
          {name: 'symbols', rowCount: 2},
        ]);
        yield* store.finalizePersistentMaterializationPlan(databasePath, 1, undefined, undefined, context, prepared);
        expect(yield* store.stagedFactCounts(databasePath)).toEqual({edges: 0, symbols: 2});
      }),
      {writerLockPath: path.join(root, 'writer.lock')},
    );
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect('accounts for the sidecar and every journal family in durable high-water samples', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-materialization-spool-storage-'});
    const databasePath = path.join(root, 'graph.sqlite');
    const sidecarPath = path.join(root, 'spool.sqlite');
    for (const [file, size] of [
      [databasePath, 10],
      [`${databasePath}-journal`, 2],
      [`${databasePath}-shm`, 3],
      [`${databasePath}-wal`, 4],
      [sidecarPath, 20],
      [`${sidecarPath}-journal`, 5],
      [`${sidecarPath}-shm`, 6],
      [`${sidecarPath}-wal`, 7],
    ] as const) {
      yield* fs.writeFile(file, new Uint8Array(size));
    }
    expect(yield* materializationStorageFiles(fs, databasePath, [sidecarPath])).toEqual({
      databaseBytes: 10,
      journalBytes: 2,
      sharedMemoryBytes: 3,
      sidecarDatabaseBytes: 20,
      sidecarJournalBytes: 5,
      sidecarSharedMemoryBytes: 6,
      sidecarWalBytes: 7,
      totalBytes: 57,
      walBytes: 4,
    });
  }).pipe(provideTestLayer(ApplicationLayer)),
);

function repositoryIdentity(root: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
    displayName: 'materialization-spool-fixture',
    gitCommonDirectory: root,
    headCommit: Effect2.pipe('4', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
    worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
  };
}
