import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {useDatabase, useReadOnlyDatabase} from '../session.js';
import {CodeGraphStoreError} from '../../types.js';
import {persistedIncrementalFactCounts} from '../activation/core.js';
import {storeError} from '../utilities.js';
import {
  stageActivationSymbols,
  stageActivationSymbolTerms,
  stageActivationEdges,
  activationMode,
  type PreparedPersistedFullFactBatch,
} from '../build/core.js';
import {selectSearchSymbols, selectSearchSymbolsMany, selectSymbolsByIds} from '../queries.js';
import {stageActivationMonikers, stageActivationReferences} from '../staging_core.js';
import {stagePersistedFullFacts} from '../resolution/core.js';
import {activationStagingObserver, stageActivationWorkspace, stagePersistedFullWorkspace} from '../persistent_build.js';
import {
  preparePersistedFullWorkspace,
  preparePersistedFullFactCapacity,
  stagePersistedFullFactBatches,
} from '../build/preparation.js';
import {resolveActivationReferences} from '../resolution.js';
import {selectSymbolsByPaths} from '../relationship_queries.js';
import {type CodeGraphStoreRuntime} from '../runtime.js';
import {type CodeGraphStoreShape} from '../shape.js';
import {temporaryActivationFactsCapacity, temporaryActivationWorkspaceCapacity} from '../temporary_capacity.js';
import {appendPersistentMaterializationSpoolFactBatches} from '../materialization/spool_lifecycle.js';

type CodeGraphStoreStagingMethods = Pick<
  CodeGraphStoreShape,
  | 'searchSymbols'
  | 'searchSymbolsMany'
  | 'searchSymbolsByPaths'
  | 'symbolsByIds'
  | 'stageActivationFacts'
  | 'stageActivationFactBatches'
  | 'stageWorkspaceCatalog'
  | 'resolveStagedReferences'
  | 'stagedFactCounts'
>;

export function makeCodeGraphStoreStagingMethods(runtime: CodeGraphStoreRuntime): CodeGraphStoreStagingMethods {
  const {prepare, withWriterGate} = runtime;
  return {
    searchSymbols: (databasePath, snapshotId, query, limit) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectSearchSymbols(snapshotId, query, limit))),
        Effect.mapError(cause => storeError('search code graph symbols', cause)),
      ),
    searchSymbolsMany: (databasePath, snapshotId, queries, limit) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectSearchSymbolsMany(snapshotId, queries, limit))),
        Effect.mapError(cause => storeError('search code graph symbols', cause)),
      ),
    searchSymbolsByPaths: (databasePath, snapshotId, sourcePaths, limitPerPath) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectSymbolsByPaths(snapshotId, sourcePaths, limitPerPath))),
        Effect.mapError(cause => storeError('search code graph symbols by path', cause)),
      ),
    symbolsByIds: (databasePath, snapshotId, ids) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectSymbolsByIds(snapshotId, ids))),
        Effect.mapError(cause => storeError('load code graph symbols', cause)),
      ),
    stageActivationFacts: (
      databasePath,
      symbols,
      edges,
      references = [],
      onProgress,
      batchIndex,
      persistentCapacityProtector,
      monikers = [],
    ) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const mode = yield* activationMode(sql);
              const observer = activationStagingObserver(
                sql,
                onProgress,
                mode?.mode === 'persisted-full' ? 'main' : 'temp',
              );
              if (mode?.mode === 'persisted-full') {
                yield* withWriterGate(
                  databasePath,
                  stagePersistedFullFacts(
                    sql,
                    mode.snapshotId,
                    mode.ownerToken,
                    batchIndex ?? 0,
                    symbols,
                    edges,
                    references,
                    observer,
                    false,
                    undefined,
                    monikers,
                  ),
                );
                return;
              }
              const transaction = sql.withTransaction(
                Effect.gen(function* () {
                  yield* stageActivationSymbols(sql, symbols, 'insert', observer);
                  yield* stageActivationSymbolTerms(sql, symbols, 'insert', observer);
                  yield* stageActivationEdges(sql, edges, 'insert', observer);
                  yield* stageActivationReferences(sql, references, 'insert', observer);
                  yield* stageActivationMonikers(sql, monikers);
                  yield* observer('committing', 0, true);
                }),
              );
              yield* persistentCapacityProtector
                ? persistentCapacityProtector(
                    temporaryActivationFactsCapacity(symbols, edges, references, monikers),
                    transaction,
                  )
                : transaction;
              yield* observer('committed', 0, true);
            }),
          ),
        ),
        Effect.mapError(cause => storeError('stage code graph facts', cause)),
      ),
    stageActivationFactBatches: (
      databasePath,
      batches,
      onProgress,
      persistentCapacityProtector,
      materializationSpool,
    ) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const mode = yield* activationMode(sql);
              if (mode?.mode !== 'persisted-full') {
                return yield* CodeGraphStoreError.of('Grouped fact staging requires a persistent full build.');
              }
              if (materializationSpool) {
                yield* appendPersistentMaterializationSpoolFactBatches(
                  runtime,
                  databasePath,
                  sql,
                  mode.snapshotId,
                  mode.ownerToken,
                  batches,
                  materializationSpool,
                  batchIndex =>
                    activationStagingObserver(
                      sql,
                      onProgress ? progress => onProgress(batchIndex, progress) : undefined,
                      'main',
                    ),
                  persistentCapacityProtector,
                );
                return;
              }
              let prepared: readonly PreparedPersistedFullFactBatch[] | undefined;
              if (persistentCapacityProtector) {
                const preparation = preparePersistedFullFactCapacity(batches);
                prepared = preparation.batches;
                const transaction = withWriterGate(
                  databasePath,
                  stagePersistedFullFactBatches(
                    sql,
                    mode.snapshotId,
                    mode.ownerToken,
                    batches,
                    batchIndex =>
                      activationStagingObserver(
                        sql,
                        onProgress ? progress => onProgress(batchIndex, progress) : undefined,
                        'main',
                      ),
                    prepared,
                  ),
                );
                yield* persistentCapacityProtector(preparation.capacity, transaction);
                return;
              }
              yield* withWriterGate(
                databasePath,
                stagePersistedFullFactBatches(
                  sql,
                  mode.snapshotId,
                  mode.ownerToken,
                  batches,
                  batchIndex =>
                    activationStagingObserver(
                      sql,
                      onProgress ? progress => onProgress(batchIndex, progress) : undefined,
                      'main',
                    ),
                  prepared,
                ),
              );
            }),
          ),
        ),
        Effect.mapError(cause => storeError('stage grouped code graph facts', cause)),
      ),
    stageWorkspaceCatalog: (databasePath, workspace, persistentCapacityProtector) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const mode = yield* activationMode(sql);
              if (mode?.mode === 'persisted-full') {
                const prepared = preparePersistedFullWorkspace(mode.snapshotId, workspace);
                const transaction = withWriterGate(
                  databasePath,
                  stagePersistedFullWorkspace(sql, mode.snapshotId, mode.ownerToken, prepared),
                );
                yield* persistentCapacityProtector
                  ? persistentCapacityProtector(prepared.capacity, transaction)
                  : transaction;
              } else {
                const staging = stageActivationWorkspace(workspace);
                yield* persistentCapacityProtector
                  ? persistentCapacityProtector(temporaryActivationWorkspaceCapacity(workspace), staging)
                  : staging;
              }
            }),
          ),
        ),
        Effect.mapError(cause => storeError('stage code graph workspace catalog', cause)),
      ),
    resolveStagedReferences: (databasePath, onProgress, persistentCapacityProtector) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            resolveActivationReferences(
              onProgress,
              effect => withWriterGate(databasePath, effect),
              persistentCapacityProtector,
            ),
          ),
        ),
        Effect.mapError(cause => storeError('resolve staged code graph references', cause)),
      ),
    stagedFactCounts: databasePath =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const mode = yield* activationMode(sql);
              if (mode?.mode === 'persisted-delta') {
                const counts = yield* persistedIncrementalFactCounts(sql, mode.baseSnapshotId);
                return {edges: counts.edges, symbols: counts.symbols};
              }
              if (mode?.mode === 'persisted-full') {
                const rows = yield* sql<{readonly edges: number; readonly symbols: number}>`
                          SELECT
                            (SELECT COUNT(*) FROM edges WHERE snapshot_id = ${mode.snapshotId}) AS edges,
                            (SELECT COUNT(*) FROM symbols WHERE snapshot_id = ${mode.snapshotId}) AS symbols
                        `;
                return {
                  edges: Number(rows[0]?.edges ?? 0),
                  symbols: Number(rows[0]?.symbols ?? 0),
                };
              }
              const [symbolRows, edgeRows] = yield* Effect.all([
                sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM activation_symbols`,
                sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM activation_edges`,
              ]);
              return {
                edges: Number(edgeRows[0]?.count ?? 0),
                symbols: Number(symbolRows[0]?.count ?? 0),
              };
            }),
          ),
        ),
        Effect.mapError(cause => storeError('count staged code graph facts', cause)),
      ),
  } as const;
}
