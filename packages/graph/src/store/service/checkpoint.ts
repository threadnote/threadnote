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
            );
          }),
        );
        yield* scheduleCompletedBuildCleanup(databasePath, snapshot.id);
      }).pipe(Effect.mapError(cause => storeError('finalize code graph checkpoint import', cause))),
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
