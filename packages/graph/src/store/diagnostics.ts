import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {type CodeGraphDatabaseHealth} from './models.js';
import {codeGraphPersistentExtensionSchemaCompatible} from './schema/inspection.js';
import {type CodeGraphSnapshot} from '../types.js';
import {codeGraphPersistentSchemaIsCurrent} from './schema/revision.js';
import {codeGraphRemovedViewCleanupSchemaAdmission} from './schema/migration.js';
import {codeGraphWorktreeReconciliationSchemaCompatible} from './reconciliation.js';
import {codeGraphDatabaseIntegrity} from './health.js';
import {inspectCodeGraphSnapshotFileCitationSchema} from './file_alias_schema.js';

const diagnoseDatabase = Effect.fn('codeGraph.diagnoseDatabase')(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  const integrityRows = yield* sql.unsafe<{readonly integrity_check: string}>('PRAGMA integrity_check(10)');
  const schemaRows = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'schema_version'
  `;
  const schemaVersion = Number.parseInt(schemaRows[0]?.value ?? '', 10);
  const cleanupAdmission = yield* codeGraphRemovedViewCleanupSchemaAdmission(sql);
  const persistentExtensionSchemaRevision = cleanupAdmission.persistentExtensionSchemaRevision;
  const snapshotFileCitation = yield* inspectCodeGraphSnapshotFileCitationSchema(sql);
  const persistentExtensionCurrent =
    codeGraphPersistentSchemaIsCurrent(persistentExtensionSchemaRevision) &&
    (yield* codeGraphPersistentExtensionSchemaCompatible(sql)) &&
    snapshotFileCitation.baseIndexes === 'current' &&
    snapshotFileCitation.state === 'current' &&
    cleanupAdmission.current;
  const coreReadSchemaCompatible = yield* codeGraphWorktreeReconciliationSchemaCompatible(
    sql,
    false,
    false,
    false,
    false,
  );
  const stateRows = yield* sql<{readonly count: number; readonly state: CodeGraphSnapshot['state']}>`
    SELECT state, COUNT(*) AS count FROM snapshots GROUP BY state
  `;
  const activeRows = yield* sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM active_snapshots`;
  const cacheRows = yield* sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM file_blobs`;
  const foreignKeyRows = yield* sql.unsafe('PRAGMA foreign_key_check');
  const counts = new Map(stateRows.map(row => [row.state, Number(row.count)]));
  const integrityOk =
    integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' && foreignKeyRows.length === 0;
  return {
    activeSnapshots: Number(activeRows[0]?.count ?? 0),
    buildingSnapshots: counts.get('building') ?? 0,
    cachedFileBlobs: Number(cacheRows[0]?.count ?? 0),
    failedSnapshots: counts.get('failed') ?? 0,
    foreignKeyViolations: foreignKeyRows.length,
    integrity: codeGraphDatabaseIntegrity({
      coreReadSchemaCompatible,
      integrityOk,
      persistentExtensionCurrent,
      persistentExtensionSchemaRevision,
      schemaVersion: Number.isSafeInteger(schemaVersion) ? schemaVersion : undefined,
    }),
    snapshotFileCitationBaseIndexes: snapshotFileCitation.baseIndexes,
    snapshotFileCitationSchema: snapshotFileCitation.state,
    readySnapshots: counts.get('ready') ?? 0,
    persistentExtensionSchemaRevision,
    schemaVersion: Number.isSafeInteger(schemaVersion) ? schemaVersion : undefined,
  } satisfies CodeGraphDatabaseHealth;
});

export {diagnoseDatabase};
