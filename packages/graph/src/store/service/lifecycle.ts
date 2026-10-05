import {DateTime, Effect, Option, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import * as SqlError from 'effect/sql/SqlError';
import {CODE_GRAPH_CACHE_TRANSACTION_LIMITS, codeGraphTextFieldsCapacityBytes} from '../../cache_capacity.js';
import {saturatingCapacityAdd} from '../../disk/capacity.js';
import {ensureBoundedCodeGraphFact} from '../../fact/budget.js';
import {
  type CodeGraphOrphanProvenanceCandidatePage,
  type CodeGraphOrphanProvenanceViewObservation,
  type CodeGraphSnapshotPurgeObservationResult,
  type CodeGraphSnapshotPurgeStoreResult,
  type CodeGraphViewObservationResult,
  type CodeGraphViewRemovalResult,
  type CodeGraphViewSnapshotLeaseRetainResult,
  type CodeGraphViewSnapshotLeaseValidationResult,
} from '../models.js';
import {assertCodeGraphRuntimeSchemaCompatible} from '../schema/metadata.js';
import {
  CODE_GRAPH_WRITER_MAIN_CACHE_KIB,
  CodeGraphDatabaseSession,
  type CodeGraphDatabaseSessionShape,
  configureConnection,
  configureReadConnection,
  configureReconstructibleBuildDurability,
  configureSqliteWriterConnection,
  tableExists,
  useDatabase,
  useDatabaseDirect,
  useExistingDatabase,
  useReadOnlyDatabase,
} from '../session.js';
import {CodeGraphStoreError, isCodeGraphStoreError} from '../../types.js';
import {storeError} from '../utilities.js';
import {CodeGraphPromotionCapacityPlanChanged, type CodeGraphActivationLease} from '../internal_models.js';
import {
  stageActivationFiles,
  stageActivationSymbols,
  stageActivationSymbolTerms,
  stageActivationEdges,
  activationMode,
} from '../build/core.js';
import {validateViewRemovalTarget, observeActiveView} from '../reconciliation/core.js';
import {
  associateMaterializedFileShardBatch,
  cacheCapacityPlanningError,
  prepareFreshFactCacheBatchChunks,
  storeFreshFactRows,
  prepareMaterializedShardCacheChunks,
  prepareMaterializedShardCacheBatchChunks,
  writeMaterializedShardCacheRows,
} from '../cache.js';
import {validatedSnapshotLeaseDuration} from '../maintenance_core.js';
import {validateSnapshotPurgeInput, observeSnapshotPurge} from '../cleanup_core.js';
import {
  claimOrphanProvenanceCandidates,
  claimWorktreeReconciliationCandidates,
  claimRemovedViewCleanupCandidates,
  observeOrphanProvenanceView,
  authorizeRemovedViewCleanup,
  updateRemovedViewCleanup,
} from '../reconciliation.js';
import {acquireSnapshotLease, retainViewSnapshotLease, validateViewSnapshotLease} from '../leases.js';
import {prepareActivationTables} from '../staging_core.js';
import {initializeSchema} from '../schema/initialization.js';
import {pruneRetiredSnapshotRowsPage, purgeSelectedSnapshot, removeActiveView} from '../view_cleanup.js';
import {
  drainCompletedPersistentBuildRows,
  activatePersistedFullSnapshot,
  activateCleanSnapshotAlias,
} from '../activation/persistent.js';
import {
  prepareWorktreeReconciliationIndex,
  prepareWorktreeReconciliationIndexesBounded,
} from '../reconciliation/preparation.js';
import {activateStagedSnapshot, activatePersistedIncrementalSnapshot} from '../activation.js';
import {prepareSnapshotPromotionCapacity} from '../build/preparation.js';
import {promoteSnapshot} from '../resolution.js';
import {type CodeGraphStoreRuntime} from '../runtime.js';
import {type CodeGraphStoreShape} from '../shape.js';
import {temporaryActivationPublicationCapacity} from '../temporary_capacity.js';

type CodeGraphStoreLifecycleMethods = Pick<
  CodeGraphStoreShape,
  | 'withSession'
  | 'shrinkMemory'
  | 'assertRuntimeSchemaCompatible'
  | 'acquireSnapshotLease'
  | 'retainViewSnapshotLease'
  | 'validateViewSnapshotLease'
  | 'activate'
  | 'activateStaged'
  | 'activateCleanSnapshotAlias'
  | 'cacheFactBatches'
  | 'cacheFacts'
  | 'cacheMaterializedFileShards'
  | 'cacheMaterializedFileShardBatches'
  | 'associateMaterializedFileShardBatches'
  | 'promote'
  | 'observeView'
  | 'observeSnapshotPurge'
  | 'claimOrphanProvenanceCandidates'
  | 'claimWorktreeReconciliationCandidates'
  | 'observeOrphanProvenanceView'
  | 'prepareWorktreeReconciliationIndexes'
  | 'removeView'
  | 'purgeSnapshot'
  | 'claimRemovedViewCleanupCandidates'
  | 'authorizeRemovedViewCleanup'
  | 'updateRemovedViewCleanup'
>;

export function makeCodeGraphStoreLifecycleMethods(runtime: CodeGraphStoreRuntime): CodeGraphStoreLifecycleMethods {
  const {
    withWriterGate,
    scheduleCompletedBuildCleanup,
    startCompletedBuildCleanup,
    startRoutinePhysicalCleanup,
    fs,
    system,
    crypto,
    prepare,
    ensureLeaseSchemaInitialized,
    scheduleRoutinePhysicalCleanup,
    ensureSchemaInitialized,
  } = runtime;
  const cacheMaterializedFileShardBatches: CodeGraphStoreLifecycleMethods['cacheMaterializedFileShardBatches'] = (
    databasePath,
    batches,
    persistentCapacityProtector,
  ) =>
    Effect.gen(function* () {
      if (batches.length === 0) return;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const chunks = yield* Effect.try({
        catch: cause => cacheCapacityPlanningError('materialized file shards', cause),
        try: () => prepareMaterializedShardCacheBatchChunks(batches, createdAt),
      });
      yield* prepare(databasePath);
      yield* useDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* ensureSchemaInitialized(databasePath, sql);
        }),
      );
      for (const chunk of chunks) {
        yield* writeMaterializedShardCacheRows({
          databasePath,
          persistentCapacityProtector,
          rows: chunk.rows,
          withWriterGate,
        });
      }
    }).pipe(Effect.mapError(cause => storeError('cache materialized code graph file shard batches', cause)));
  const cacheFactBatches: CodeGraphStoreLifecycleMethods['cacheFactBatches'] = (
    databasePath,
    batches,
    persistentCapacityProtector,
  ) =>
    Effect.gen(function* () {
      if (batches.length === 0) return;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const chunks = yield* Effect.try({
        catch: cause => cacheCapacityPlanningError('file facts', cause),
        try: () => prepareFreshFactCacheBatchChunks(batches, createdAt),
      });
      const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
      const initializedSession =
        Option.isSome(session) && session.value.databasePath === databasePath && session.value.schemaInitialized;
      if (!initializedSession) {
        yield* prepare(databasePath);
        yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* ensureSchemaInitialized(databasePath, sql);
          }),
        );
      }
      yield* useDatabase(
        databasePath,
        Effect.gen(function* () {
          yield* configureReconstructibleBuildDurability(yield* SqlClient.SqlClient);
        }),
      );
      for (const chunk of chunks) {
        yield* persistentCapacityProtector(
          chunk.boundary,
          withWriterGate(
            databasePath,
            useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* sql.withTransaction(storeFreshFactRows(sql, chunk.rows));
              }),
            ),
          ),
        );
      }
    }).pipe(Effect.mapError(cause => storeError('cache code graph file facts', cause)));

  return {
    shrinkMemory: databasePath =>
      useDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe('PRAGMA shrink_memory');
        }),
      ).pipe(Effect.mapError(cause => storeError('release code graph SQLite memory', cause))),
    withSession: (databasePath, effect, options) => {
      const detachedCleanupRequest: CodeGraphDatabaseSessionShape['detachedCleanupRequest'] = {
        completedBuild: false,
        completedSnapshotId: undefined,
        routinePhysical: false,
      };
      const useSessionDatabase = options?.existingOnly === true ? useExistingDatabase : useDatabaseDirect;
      return useSessionDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* options?.readOnly ? configureReadConnection(sql) : configureConnection(sql);
          if (options?.writerLockPath !== undefined) {
            // Keep hot upper B-tree pages resident for the one long-lived
            // indexing writer. Read/query sessions retain SQLite's small
            // default cache, so concurrent agents do not multiply this
            // bounded 32 MiB writer budget.
            yield* configureSqliteWriterConnection(
              sql,
              {mainCacheKiB: CODE_GRAPH_WRITER_MAIN_CACHE_KIB, ...options.sqliteWriterTuning},
              'connection',
              options.onSqliteWriterConfigured,
            );
          }
          const session = {
            databasePath,
            detachedCleanupRequest,
            reconstructibleDurabilityConfigured: false as boolean,
            schemaInitialized: false as boolean,
            sql,
            ...options,
          } satisfies CodeGraphDatabaseSessionShape;
          return yield* Effect.gen(function* () {
            let completedBuildCleanup = Effect.void;
            // Indexing sessions identify themselves with the checkout-wide
            // writer lock. Validate the schema before normal work, but defer
            // completed-build reclamation until the session effect exits.
            // Build-only rows are unreachable after publication, so putting
            // their bounded maintenance after admission keeps worktree
            // registration proportional without weakening cleanup or making
            // graph queries pay the latency.
            if (options?.cleanupCompletedBuildRows && (yield* tableExists(sql, 'snapshots'))) {
              // Initialize once under the checkout writer gate before work.
              // The receipt makes the ordinary path bounded, and marking this
              // session avoids replaying the same admission when the indexing
              // effect calls store.initialize immediately afterward.
              yield* ensureSchemaInitialized(databasePath, sql).pipe(
                Effect.mapError(cause =>
                  isCodeGraphStoreError(cause) ? cause : storeError('initialize code graph database session', cause),
                ),
                Effect.asVoid,
              );
              completedBuildCleanup = Effect.gen(function* () {
                const cleanup = yield* drainCompletedPersistentBuildRows(
                  sql,
                  undefined,
                  write => withWriterGate(databasePath, write),
                  1,
                ).pipe(Effect.option);
                if (Option.isSome(cleanup) && cleanup.value.remaining) {
                  yield* scheduleCompletedBuildCleanup(databasePath);
                }
              });
            }
            return yield* effect.pipe(Effect.ensuring(completedBuildCleanup));
          }).pipe(Effect.provideService(CodeGraphDatabaseSession, session));
        }),
        options?.readOnly === true,
      ).pipe(
        Effect.catchTag('SqlError', cause =>
          Effect.fail(storeError('use code graph database session', cause as SqlError.SqlError)),
        ),
        Effect.tap(() =>
          detachedCleanupRequest.completedBuild
            ? startCompletedBuildCleanup(
                databasePath,
                detachedCleanupRequest.completedSnapshotId,
                detachedCleanupRequest.routinePhysical,
                options,
              )
            : detachedCleanupRequest.routinePhysical
              ? startRoutinePhysicalCleanup(databasePath, options)
              : Effect.void,
        ),
      );
    },
    assertRuntimeSchemaCompatible: databasePath =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists ? useReadOnlyDatabase(databasePath, assertCodeGraphRuntimeSchemaCompatible()) : Effect.void,
        ),
        Effect.mapError(cause => storeError('check code graph runtime compatibility', cause)),
      ),
    acquireSnapshotLease: (databasePath, snapshotId, durationMilliseconds, options) =>
      Effect.gen(function* () {
        const token = `${options?.retainedBase === true ? 'retained-base:' : ''}${system.processId}:${yield* crypto.randomUUIDv4}`;
        const acquired = yield* prepare(databasePath).pipe(
          Effect.andThen(
            withWriterGate(
              databasePath,
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* ensureLeaseSchemaInitialized(databasePath, sql, false);
                  const acquiredToken = yield* acquireSnapshotLease(
                    snapshotId,
                    durationMilliseconds,
                    token,
                    options?.retireWhenInactive === true,
                  );
                  const cleanup = yield* pruneRetiredSnapshotRowsPage();
                  return {cleanup, token: acquiredToken};
                }),
              ),
              options?.waitTimeoutMilliseconds,
            ),
          ),
          Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause)),
        );
        if (acquired.cleanup.remaining) yield* scheduleRoutinePhysicalCleanup(databasePath);
        return acquired.token;
      }).pipe(Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause))),
    retainViewSnapshotLease: (databasePath, worktreeId, snapshotId, durationMilliseconds, options) =>
      Effect.gen(function* () {
        yield* validateViewRemovalTarget(worktreeId, snapshotId);
        const candidateToken = `${system.processId}:${yield* crypto.randomUUIDv4}`;
        return yield* withWriterGate(
          databasePath,
          Effect.gen(function* () {
            // The writer gate also serializes whole-checkout quarantine.
            // Recheck containment only after it is held so a purged store
            // cannot be recreated by SQLite between an outer stat and open.
            if (!(yield* fs.exists(databasePath))) {
              return {
                observation: {expectedSnapshotId: snapshotId, state: 'not-found'},
                state: 'view-unavailable',
              } satisfies CodeGraphViewSnapshotLeaseRetainResult;
            }
            if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
              return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
            }
            if ((yield* fs.stat(databasePath)).type !== 'File') {
              return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
            }
            return yield* useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* ensureLeaseSchemaInitialized(databasePath, sql, true);
                return yield* retainViewSnapshotLease(
                  sql,
                  worktreeId,
                  snapshotId,
                  durationMilliseconds,
                  candidateToken,
                  options,
                );
              }),
            );
          }),
          options?.waitTimeoutMilliseconds,
        );
      }).pipe(Effect.mapError(cause => storeError('retain code graph view snapshot lease', cause))),
    validateViewSnapshotLease: (databasePath, worktreeId, snapshotId, token, minimumRemainingMilliseconds) =>
      Effect.gen(function* () {
        yield* validateViewRemovalTarget(worktreeId, snapshotId);
        if (
          token.length === 0 ||
          token.length > 1_024 ||
          token.includes('\0') ||
          !Number.isSafeInteger(minimumRemainingMilliseconds) ||
          minimumRemainingMilliseconds < 0 ||
          minimumRemainingMilliseconds > 60 * 60_000
        ) {
          return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
        }
        if (!(yield* fs.exists(databasePath))) {
          return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
        }
        if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
          return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
        }
        if ((yield* fs.stat(databasePath)).type !== 'File') {
          return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
        }
        return yield* useDatabaseDirect(
          databasePath,
          validateViewSnapshotLease(worktreeId, snapshotId, token, minimumRemainingMilliseconds),
          true,
        );
      }).pipe(Effect.mapError(cause => storeError('validate code graph view snapshot lease', cause))),
    activate: (databasePath, identity, snapshot, files, symbols, edges, snapshotPackProvenance) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          withWriterGate(
            databasePath,
            useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* initializeSchema(sql);
                yield* prepareActivationTables(sql);
                yield* stageActivationFiles(sql, files, 'insert');
                yield* stageActivationSymbols(sql, symbols, 'insert');
                yield* stageActivationSymbolTerms(sql, symbols, 'insert');
                yield* stageActivationEdges(sql, edges, 'insert');
                yield* activateStagedSnapshot(
                  sql,
                  identity,
                  snapshot,
                  undefined,
                  undefined,
                  undefined,
                  snapshotPackProvenance,
                );
              }),
            ),
          ),
        ),
        Effect.mapError(cause => storeError('activate code graph snapshot', cause)),
      ),
    activateStaged: (
      databasePath,
      identity,
      snapshot,
      reusableBaseReceipt,
      promotionLeaseDurationMilliseconds,
      onProgress,
      persistentCapacityProtector,
      snapshotPackProvenance,
      materializedFileShardAssociationsComplete,
      checkpointImportReceipt,
    ) =>
      Effect.gen(function* () {
        const activationPackProvenance = snapshotPackProvenance ?? reusableBaseReceipt?.packProvenance;
        const promotionLease =
          promotionLeaseDurationMilliseconds === undefined
            ? Option.none<CodeGraphActivationLease>()
            : Option.some({
                durationMilliseconds: validatedSnapshotLeaseDuration(promotionLeaseDurationMilliseconds),
                token: `${system.processId}:${yield* crypto.randomUUIDv4}`,
              });
        yield* prepare(databasePath);
        const completedPersistentSnapshot = yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const mode = yield* activationMode(sql);
            if (mode?.mode === 'persisted-delta') {
              if (checkpointImportReceipt !== undefined) {
                return yield* CodeGraphStoreError.of(
                  'Checkpoint imports require a self-contained persistent full build.',
                );
              }
              const publication = withWriterGate(
                databasePath,
                activatePersistedIncrementalSnapshot(
                  sql,
                  identity,
                  snapshot,
                  mode.baseSnapshotId,
                  reusableBaseReceipt,
                  promotionLease,
                  onProgress,
                  activationPackProvenance,
                ),
              );
              const capacity = yield* temporaryPublicationCapacity(sql);
              yield* persistentCapacityProtector ? persistentCapacityProtector(capacity, publication) : publication;
              return undefined;
            }
            if (mode?.mode === 'persisted-full') {
              if (mode.snapshotId !== snapshot.id) {
                return yield* CodeGraphStoreError.of('Persistent full-build activation identity changed.');
              }
              yield* activatePersistedFullSnapshot(
                sql,
                identity,
                snapshot,
                mode.ownerToken,
                reusableBaseReceipt,
                promotionLease,
                onProgress,
                effect => withWriterGate(databasePath, effect),
                persistentCapacityProtector,
                activationPackProvenance,
                materializedFileShardAssociationsComplete,
                checkpointImportReceipt,
              );
              return snapshot.id;
            }
            if (checkpointImportReceipt !== undefined) {
              return yield* CodeGraphStoreError.of(
                'Checkpoint imports require a self-contained persistent full build.',
              );
            }
            const publication = withWriterGate(
              databasePath,
              activateStagedSnapshot(
                sql,
                identity,
                snapshot,
                reusableBaseReceipt,
                promotionLease,
                onProgress,
                activationPackProvenance,
              ),
            );
            const capacity = yield* temporaryPublicationCapacity(sql);
            yield* persistentCapacityProtector ? persistentCapacityProtector(capacity, publication) : publication;
            return undefined;
          }),
        );
        if (completedPersistentSnapshot) {
          yield* scheduleCompletedBuildCleanup(databasePath, completedPersistentSnapshot);
        }
        return Option.map(promotionLease, lease => lease.token);
      }).pipe(Effect.mapError(cause => storeError('activate staged code graph snapshot', cause))),
    activateCleanSnapshotAlias: (databasePath, identity, snapshot, baseSnapshotId, currentSnapshotReceipt, options) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* ensureSchemaInitialized(databasePath, sql);
              yield* withWriterGate(
                databasePath,
                activateCleanSnapshotAlias(sql, identity, snapshot, baseSnapshotId, currentSnapshotReceipt, options),
              );
            }),
          ),
        ),
        Effect.mapError(cause => storeError('activate clean code graph snapshot alias', cause)),
      ),
    cacheFactBatches,
    cacheFacts: (databasePath, files, facts, extractorSet, persistentCapacityProtector) =>
      cacheFactBatches(databasePath, [{extractorSet, facts, files}], persistentCapacityProtector),
    cacheMaterializedFileShards: (
      databasePath,
      files,
      facts,
      extractorSet,
      derivationIdentity,
      persistentCapacityProtector,
    ) =>
      Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const chunks = yield* Effect.try({
          catch: cause => cacheCapacityPlanningError('materialized file shards', cause),
          try: () =>
            prepareMaterializedShardCacheChunks(
              files,
              facts.map(ensureBoundedCodeGraphFact),
              extractorSet,
              derivationIdentity,
              createdAt,
            ),
        });
        yield* prepare(databasePath);
        yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* ensureSchemaInitialized(databasePath, sql);
          }),
        );
        for (const chunk of chunks) {
          yield* writeMaterializedShardCacheRows({
            databasePath,
            persistentCapacityProtector,
            rows: chunk.rows,
            withWriterGate,
          });
        }
      }).pipe(Effect.mapError(cause => storeError('cache materialized code graph file shards', cause))),
    cacheMaterializedFileShardBatches,
    associateMaterializedFileShardBatches: (
      databasePath,
      snapshotId,
      ownerToken,
      batches,
      persistentCapacityProtector,
    ) =>
      Effect.gen(function* () {
        const rowCount = batches.reduce((total, batch) => saturatingCapacityAdd(total, batch.files.length), 0);
        if (batches.length === 0) return;
        if (rowCount > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows) {
          return yield* CodeGraphStoreError.of('Materialized file shard association group is too large.');
        }
        const finalFactBytes = batches.reduce(
          (total, batch) =>
            batch.files.reduce(
              (batchTotal, file) =>
                saturatingCapacityAdd(
                  batchTotal,
                  codeGraphTextFieldsCapacityBytes(snapshotId, file.path, batch.selectedShardIds.get(file.path) ?? ''),
                ),
              total,
            ),
          0,
        );
        if (finalFactBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes) {
          return yield* CodeGraphStoreError.of('Materialized file shard association group payload is too large.');
        }
        yield* prepare(databasePath);
        yield* persistentCapacityProtector(
          {
            finalFactBytes,
            operation: 'cache materialized code graph file shards',
            rowCount,
          },
          withWriterGate(
            databasePath,
            useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* ensureSchemaInitialized(databasePath, sql);
                yield* sql.withTransaction(
                  Effect.forEach(
                    batches,
                    batch =>
                      associateMaterializedFileShardBatch(
                        sql,
                        snapshotId,
                        ownerToken,
                        batch.files,
                        batch.extractorSet,
                        batch.derivationIdentity,
                        batch.selectedShardIds,
                      ),
                    {discard: true},
                  ),
                );
              }),
            ),
          ),
        );
      }).pipe(Effect.mapError(cause => storeError('associate materialized code graph file shard batches', cause))),
    promote: (databasePath, identity, snapshotId, options) =>
      Effect.gen(function* () {
        yield* prepare(databasePath);
        yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* ensureSchemaInitialized(databasePath, sql);
          }),
        );
        for (;;) {
          const plan = yield* useDatabase(databasePath, prepareSnapshotPromotionCapacity(identity, snapshotId));
          const transaction = withWriterGate(
            databasePath,
            useDatabase(databasePath, promoteSnapshot(identity, snapshotId, plan)),
            options?.waitTimeoutMilliseconds,
          );
          const attempted = yield* (
            options?.persistentCapacityProtector
              ? options.persistentCapacityProtector(plan.boundary, transaction)
              : transaction
          ).pipe(
            Effect.map(value => ({state: 'completed' as const, value})),
            Effect.catchIf(Schema.is(CodeGraphPromotionCapacityPlanChanged), () =>
              Effect.succeed({state: 'retry' as const}),
            ),
          );
          if (attempted.state === 'retry') {
            yield* Effect.yieldNow;
            continue;
          }
          break;
        }
        // A successful promotion can make pre-policy parser and shard
        // cache rows unreachable even when it does not displace a pointer.
        // The detached collector never waits for the writer gate and
        // reclaims at most one physical table page per acquisition.
        yield* scheduleRoutinePhysicalCleanup(databasePath);
      }).pipe(Effect.mapError(cause => storeError('promote code graph snapshot', cause))),
    observeView: (databasePath, worktreeId, expectedSnapshotId, scopeId) =>
      Effect.gen(function* () {
        yield* validateViewRemovalTarget(worktreeId, expectedSnapshotId);
        if (!(yield* fs.exists(databasePath))) {
          return {expectedSnapshotId, state: 'not-found'} satisfies CodeGraphViewObservationResult;
        }
        if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
          return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
        }
        if ((yield* fs.stat(databasePath)).type !== 'File') {
          return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
        }
        return yield* useReadOnlyDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe('PRAGMA busy_timeout = 0');
            return yield* sql.withTransaction(observeActiveView(sql, worktreeId, expectedSnapshotId, scopeId));
          }),
        );
      }).pipe(Effect.mapError(cause => storeError('observe code graph view', cause))),
    observeSnapshotPurge: (databasePath, snapshotId, nowMilliseconds) =>
      Effect.gen(function* () {
        yield* validateSnapshotPurgeInput(snapshotId, nowMilliseconds);
        if (!(yield* fs.exists(databasePath))) {
          return {snapshotId, state: 'not-found'} satisfies CodeGraphSnapshotPurgeObservationResult;
        }
        if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
          return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
        }
        if ((yield* fs.stat(databasePath)).type !== 'File') {
          return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
        }
        return yield* useReadOnlyDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe('PRAGMA busy_timeout = 0');
            return yield* observeSnapshotPurge(sql, snapshotId, nowMilliseconds);
          }),
        );
      }).pipe(Effect.mapError(cause => storeError('observe code graph snapshot purge', cause))),
    claimOrphanProvenanceCandidates: (databasePath, worktreeIds, limit, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) {
            return {worktreeIds: []} as const satisfies CodeGraphOrphanProvenanceCandidatePage;
          }
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* claimOrphanProvenanceCandidates(sql, worktreeIds, limit);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('claim code graph orphan provenance candidates', cause))),
    observeOrphanProvenanceView: (databasePath, worktreeId, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) {
            return {state: 'absent'} as const satisfies CodeGraphOrphanProvenanceViewObservation;
          }
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* observeOrphanProvenanceView(sql, worktreeId);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('observe code graph orphan provenance view', cause))),
    claimWorktreeReconciliationCandidates: (databasePath, limit, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) return [];
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* claimWorktreeReconciliationCandidates(sql, limit);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('claim code graph reconciliation candidates', cause))),
    prepareWorktreeReconciliationIndexes: (databasePath, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) {
            return {reason: 'incompatible-schema', state: 'deferred'} as const;
          }
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              if (options?.preview !== true) {
                return yield* sql.withTransaction(prepareWorktreeReconciliationIndex(sql));
              }
              yield* sql.unsafe('BEGIN IMMEDIATE');
              return yield* (options.afterPreviewTransactionStarted?.() ?? Effect.void).pipe(
                Effect.andThen(prepareWorktreeReconciliationIndexesBounded(sql)),
                Effect.ensuring(sql.unsafe('ROLLBACK').pipe(Effect.orDie)),
              );
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('prepare code graph reconciliation indexes', cause))),
    removeView: (databasePath, worktreeId, expectedSnapshotId, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) {
            return {expectedSnapshotId, state: 'not-found'} satisfies CodeGraphViewRemovalResult;
          }
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
          }
          const remove = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            if (options?.requireReconciliationSchema === true) {
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
            } else {
              yield* initializeSchema(sql);
            }
            return yield* removeActiveView(
              sql,
              worktreeId,
              expectedSnapshotId,
              options?.requireReconciliationSchema === true,
              options?.cleanupEvidence,
              options?.scopeId,
            );
          });
          const result = yield* options?.requireReconciliationSchema === true
            ? useExistingDatabase(databasePath, remove)
            : useDatabase(databasePath, remove);
          return result;
        }),
        // View removal is opportunistic foreground maintenance. Never
        // queue it behind a checkout writer unless an internal caller
        // explicitly opts into a bounded wait.
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(
        Effect.tap(result =>
          options?.requireReconciliationSchema !== true &&
          result.retiredSnapshots !== undefined &&
          result.retiredSnapshots > 0
            ? scheduleRoutinePhysicalCleanup(databasePath)
            : Effect.void,
        ),
        Effect.mapError(cause => storeError('remove code graph view', cause)),
      ),
    purgeSnapshot: (databasePath, snapshotId, expectedGraphEvidenceDigest, nowMilliseconds, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* validateSnapshotPurgeInput(snapshotId, nowMilliseconds);
          if (!/^[0-9a-f]{64}$/u.test(expectedGraphEvidenceDigest)) {
            return yield* CodeGraphStoreError.of('Code graph snapshot purge approval is invalid.');
          }
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) {
            return {snapshotId, state: 'not-found'} satisfies CodeGraphSnapshotPurgeStoreResult;
          }
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* purgeSelectedSnapshot(sql, snapshotId, expectedGraphEvidenceDigest, nowMilliseconds);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('purge selected code graph snapshot', cause))),
    claimRemovedViewCleanupCandidates: (databasePath, nowMilliseconds, limit, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) return [];
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* claimRemovedViewCleanupCandidates(sql, nowMilliseconds, limit);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('claim removed code graph view cleanup', cause))),
    authorizeRemovedViewCleanup: (databasePath, entry, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) return {state: 'stale'} as const;
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* authorizeRemovedViewCleanup(sql, entry);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('authorize removed code graph view cleanup', cause))),
    updateRemovedViewCleanup: (databasePath, entry, update, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) return {state: 'stale'} as const;
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* CodeGraphStoreError.of('Code graph database target is a symbolic link.');
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* CodeGraphStoreError.of('Code graph database target is not a regular file.');
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* updateRemovedViewCleanup(sql, entry, update);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('update removed code graph view cleanup', cause))),
  } as const;
}

const temporaryPublicationCapacity = Effect.fn('codeGraph.temporaryPublicationCapacity')(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql.unsafe<{
    readonly edges: unknown;
    readonly files: unknown;
    readonly lookup_keys: unknown;
    readonly reexports: unknown;
    readonly symbols: unknown;
    readonly terms: unknown;
    readonly workspace_rows: unknown;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM activation_edges) AS edges,
      (SELECT COUNT(*) FROM activation_files) AS files,
      (SELECT COUNT(*) FROM activation_symbol_lookup) AS lookup_keys,
      (SELECT COUNT(*) FROM activation_reexport_provenance) AS reexports,
      (SELECT COUNT(*) FROM activation_symbols) AS symbols,
      (SELECT COUNT(*) FROM activation_symbol_terms) AS terms,
      (SELECT COUNT(*) FROM activation_workspace_scopes)
        + (SELECT COUNT(*) FROM activation_workspace_components)
        + (SELECT COUNT(*) FROM activation_workspace_dependencies)
        + (SELECT COUNT(*) FROM activation_workspace_external_dependencies)
        + (SELECT COUNT(*) FROM activation_monikers) AS workspace_rows
  `);
  const counts = rows[0];
  return temporaryActivationPublicationCapacity({
    edges: Number(counts?.edges ?? Number.NaN),
    files: Number(counts?.files ?? Number.NaN),
    lookupKeys: Number(counts?.lookup_keys ?? Number.NaN),
    reexports: Number(counts?.reexports ?? Number.NaN),
    symbols: Number(counts?.symbols ?? Number.NaN),
    terms: Number(counts?.terms ?? Number.NaN),
    workspaceRows: Number(counts?.workspace_rows ?? Number.NaN),
  });
});
