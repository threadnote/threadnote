import {checkpointCompletionCapacity} from '../../checkpoint/pack.js';
import {
  verifyCheckpointCompletionInPublishingTransaction,
  consumeCheckpointCompletion,
} from '../../checkpoint/authority.js';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {CodeGraphStoreError} from '../../types.js';
import {DateTime, Effect, Option} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  bindCheckpointImportBuild,
  readCheckpointImportReceipt,
  recordReadyCheckpointImportReceipt,
  selectReadySnapshotByLogicalDigest,
  stageCheckpointImportRecordPage,
} from '../checkpoint_import.js';
import {activatePersistedFullSnapshot} from '../activation/persistent.js';
import {type CodeGraphStoreRuntime} from '../runtime.js';
import {type CodeGraphStoreShape} from '../shape.js';
import {useDatabase, useReadOnlyDatabase} from '../session.js';
import {storeError} from '../utilities.js';

type CodeGraphStoreCheckpointMethods = Pick<
  CodeGraphStoreShape,
  | 'bindCheckpointImportBuild'
  | 'checkpointImportReceipt'
  | 'finalizeCheckpointImport'
  | 'completeVerifiedCheckpointImport'
  | 'readySnapshotByLogicalDigest'
  | 'recordCheckpointImportReceipt'
  | 'stageCheckpointImportRecordPage'
>;

export function makeCodeGraphStoreCheckpointMethods(runtime: CodeGraphStoreRuntime): CodeGraphStoreCheckpointMethods {
  const {ensureSchemaInitialized, fs, prepare, scheduleCompletedBuildCleanup, withWriterGate} = runtime;
  return {
    bindCheckpointImportBuild: (databasePath, snapshotId, input) =>
      Effect.gen(function* () {
        yield* prepare(databasePath);
        yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* ensureSchemaInitialized(databasePath, sql);
          }),
        );
        return yield* withWriterGate(
          databasePath,
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql.withTransaction(
                bindCheckpointImportBuild(sql, snapshotId, input, DateTime.formatIso(yield* DateTime.now)),
              );
            }),
          ),
        );
      }).pipe(Effect.mapError(cause => storeError('bind code graph checkpoint import', cause))),
    checkpointImportReceipt: (databasePath, snapshotId) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  return yield* readCheckpointImportReceipt(sql, snapshotId);
                }),
              )
            : succeedUndefined,
        ),
        Effect.mapError(cause => storeError('load code graph checkpoint import receipt', cause)),
      ),
    finalizeCheckpointImport: (databasePath, identity, snapshot, ownerToken, input, options) =>
      Effect.gen(function* () {
        yield* prepare(databasePath);
        yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* ensureSchemaInitialized(databasePath, sql);
            yield* activatePersistedFullSnapshot(
              sql,
              identity,
              snapshot,
              ownerToken,
              options?.reusableBaseReceipt,
              Option.none(),
              options?.onProgress,
              effect => withWriterGate(databasePath, effect),
              options?.persistentCapacityProtector,
              undefined,
              true,
              input,
              options?.verification,
            );
          }),
        );
        yield* scheduleCompletedBuildCleanup(databasePath, snapshot.id);
      }).pipe(Effect.mapError(cause => storeError('finalize code graph checkpoint import', cause))),
    completeVerifiedCheckpointImport: (databasePath, identity, snapshotId, input, verification, leaseToken, options) =>
      Effect.gen(function* () {
        yield* prepare(databasePath);
        return yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* ensureSchemaInitialized(databasePath, sql);
            const transaction = withWriterGate(
              databasePath,
              sql.withTransaction(
                Effect.gen(function* () {
                  const before = yield* readCheckpointImportReceipt(sql, snapshotId);
                  if (!before) return yield* CodeGraphStoreError.of('Historical checkpoint receipt is absent.');
                  const {
                    completionSha256: _ignoredCompletion,
                    importedAt: _ignoredAt,
                    snapshotId: _ignoredId,
                    ...original
                  } = before;
                  if (canonicalJson(original) !== canonicalJson(input))
                    return yield* CodeGraphStoreError.of('Historical checkpoint receipt changed.');
                  const token = yield* verifyCheckpointCompletionInPublishingTransaction(sql, {
                    snapshotId,
                    input,
                    identity,
                    artifactVerification: verification.artifactVerification,
                    leaseToken,
                  }).pipe(Effect.provide(verification.context));
                  const completion = yield* consumeCheckpointCompletion(sql, token, snapshotId, input);
                  if (before.completionSha256 !== undefined && before.completionSha256 !== completion)
                    return yield* CodeGraphStoreError.of('Historical checkpoint completion conflicts.');
                  const changed = yield* sql<{
                    readonly snapshot_id: string;
                  }>`UPDATE checkpoint_import_receipts SET completion_sha256=${completion}
              WHERE snapshot_id=${snapshotId} AND (completion_sha256 IS NULL OR completion_sha256=${completion}) RETURNING snapshot_id`;
                  if (changed.length !== 1)
                    return yield* CodeGraphStoreError.of('Historical checkpoint completion lost its receipt.');
                }),
              ),
            );
            const capacity = yield* Effect.try({
              try: () => checkpointCompletionCapacity(verification.artifactVerification),
              catch: () => CodeGraphStoreError.of('Historical checkpoint verification capacity is invalid.'),
            });
            return yield* options?.persistentCapacityProtector
              ? options.persistentCapacityProtector(
                  {
                    operation: 'publish persistent code graph snapshot',
                    finalFactBytes: capacity.bytes,
                    rowCount: capacity.rows,
                  },
                  transaction,
                )
              : transaction;
          }),
        );
      }).pipe(Effect.mapError(cause => storeError('complete verified historical checkpoint import', cause))),
    readySnapshotByLogicalDigest: (databasePath, repositoryId, logicalDigest, abiDigest) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  return yield* selectReadySnapshotByLogicalDigest(sql, repositoryId, logicalDigest, abiDigest);
                }),
              )
            : succeedUndefined,
        ),
        Effect.mapError(cause => storeError('load code graph checkpoint by logical digest', cause)),
      ),
    recordCheckpointImportReceipt: (databasePath, snapshotId, input) =>
      Effect.gen(function* () {
        yield* prepare(databasePath);
        yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* ensureSchemaInitialized(databasePath, sql);
          }),
        );
        return yield* withWriterGate(
          databasePath,
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql.withTransaction(
                recordReadyCheckpointImportReceipt(sql, snapshotId, input, DateTime.formatIso(yield* DateTime.now)),
              );
            }),
          ),
        );
      }).pipe(Effect.mapError(cause => storeError('record code graph checkpoint import receipt', cause))),
    stageCheckpointImportRecordPage: (databasePath, snapshotId, ownerToken, page) =>
      Effect.gen(function* () {
        yield* prepare(databasePath);
        yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* ensureSchemaInitialized(databasePath, sql);
          }),
        );
        return yield* withWriterGate(
          databasePath,
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql.withTransaction(
                stageCheckpointImportRecordPage(
                  sql,
                  snapshotId,
                  ownerToken,
                  page,
                  DateTime.formatIso(yield* DateTime.now),
                ),
              );
            }),
          ),
        );
      }).pipe(Effect.mapError(cause => storeError('stage code graph checkpoint import record page', cause))),
  };
}
