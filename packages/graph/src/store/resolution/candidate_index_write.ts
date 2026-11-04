import {
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_FILES,
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS,
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES,
} from '../../incremental/work.js';
import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {CodeGraphStoreError} from '../../types.js';
import type {CodeGraphDirectPersistentCapacityProtector} from '../models.js';
import {
  RESOLUTION_CANDIDATE_INDEX_PAGE_ROWS,
  RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES,
  RESOLUTION_CANDIDATE_INDEX_VERSION,
  resolutionCandidateAuthorityToken,
  resolutionCandidateIndexSchemaReady,
  type ResolutionCandidateIndexFinish,
  type ResolutionCandidateIndexStage,
} from './candidate_index.js';
import {readCandidateFileProjection} from './candidate_page_read.js';
import {
  candidateFileOperations,
  completeCandidateFiles,
  type CandidateFileCompletion,
  type CandidateWriteOperation,
  candidatePreparationWork,
  candidateSnapshotKey,
  prepareCandidateFiles,
  type CandidatePreparedFile,
} from './candidate_page_store.js';
import {CANDIDATE_PAGE_PROTOCOL_SHA, CANDIDATE_CODEC_BUFFER_BYTES} from './candidate_pages.js';
import {resolutionCandidateIndexLayers} from './candidate_index_read.js';

const authorityChanged = Symbol('candidate-index-authority-changed');
const isAuthorityChanged = (error: unknown): error is typeof authorityChanged => error === authorityChanged;

export type CandidateIndexWriter = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | unknown, R>;

/** Every additional durable write owns a bounded reservation and releases the writer between pages. */
export function candidateIndexWrite<A, E, R>(
  sql: SqlClient.SqlClient,
  writer: CandidateIndexWriter,
  protector: CodeGraphDirectPersistentCapacityProtector | undefined,
  rows: number,
  bytes: number,
  effect: Effect.Effect<A, E, R>,
  authorityToken?: string,
  schemaVersion?: number,
) {
  const write = writer(
    sql.withTransaction(
      Effect.gen(function* () {
        if (
          authorityToken !== undefined &&
          ((schemaVersion === undefined
            ? !(yield* resolutionCandidateIndexSchemaReady(sql))
            : (yield* sql<{readonly schema_version: number}>`PRAGMA schema_version`)[0]?.schema_version !==
              schemaVersion) ||
            (yield* resolutionCandidateAuthorityToken(sql)) !== authorityToken)
        )
          return yield* Effect.fail(authorityChanged);
        return yield* effect;
      }),
    ),
  );
  return protector
    ? protector({operation: 'stage persistent code graph facts', rowCount: rows * 3 + 1, finalFactBytes: bytes}, write)
    : write;
}

export const candidateIndexPages = Effect.fn('codeGraph.candidateIndexPages')(function* <A>(
  values: readonly A[],
  bytes: (value: A) => number,
) {
  const pages: A[][] = [];
  let page: A[] = [];
  let total = 0;
  for (const value of values) {
    const size = bytes(value);
    if (size > RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES)
      return yield* CodeGraphStoreError.of('Candidate index row is oversized.');
    if (
      page.length > 0 &&
      (page.length >= RESOLUTION_CANDIDATE_INDEX_PAGE_ROWS || total + size > RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES)
    ) {
      pages.push(page);
      page = [];
      total = 0;
    }
    page.push(value);
    total += size;
  }
  if (page.length > 0) pages.push(page);
  return pages;
});

/** One full schema admission, then compare its monotonically changed SQLite cookie inside every guarded transaction. */
const candidateWriteAdmission = Effect.fn('codeGraph.candidateWriteAdmission')(function* (sql: SqlClient.SqlClient) {
  const before = (yield* sql<{readonly schema_version: number}>`PRAGMA schema_version`)[0]?.schema_version;
  if (!(yield* resolutionCandidateIndexSchemaReady(sql))) return undefined;
  const token = yield* resolutionCandidateAuthorityToken(sql);
  const after = (yield* sql<{readonly schema_version: number}>`PRAGMA schema_version`)[0]?.schema_version;
  return token && before !== undefined && before === after ? {token, schemaVersion: before} : undefined;
});

const stagePreparedCandidateFiles = Effect.fn('codeGraph.stagePreparedCandidateFiles')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  files: readonly CandidatePreparedFile[],
  writer: CandidateIndexWriter,
  protector?: CodeGraphDirectPersistentCapacityProtector,
) {
  const admission = yield* candidateWriteAdmission(sql);
  if (!admission) return;
  const write = <A, E, R>(rows: number, bytes: number, effect: Effect.Effect<A, E, R>) =>
    candidateIndexWrite(sql, writer, protector, rows, bytes, effect, admission.token, admission.schemaVersion);
  let snapshotKey = yield* candidateSnapshotKey(sql, snapshotId, admission.token);
  if (snapshotKey === undefined) {
    snapshotKey = yield* write(
      1,
      Buffer.byteLength(snapshotId) + 256,
      Effect.gen(function* () {
        yield* sql`INSERT OR IGNORE INTO snapshot_candidate_page_snapshots
        (snapshot_id,authority_token,protocol_sha,format_version) VALUES (${snapshotId},${admission.token},${CANDIDATE_PAGE_PROTOCOL_SHA},3)`;
        return yield* candidateSnapshotKey(sql, snapshotId, admission.token);
      }),
    );
  }
  if (snapshotKey === undefined) return;
  const admittedSnapshotKey = snapshotKey;
  let operations: CandidateWriteOperation[] = [];
  let rows = 0;
  let bytes = 0;
  let codecBytes = 0;
  let reservationBytes = 0;
  const flush = () =>
    write(
      rows,
      reservationBytes,
      Effect.gen(function* () {
        const terminal: CandidateFileCompletion[] = [];
        for (const operation of operations) {
          if (operation.completion) {
            const completed = operation.completion();
            if (!completed) return yield* CodeGraphStoreError.of('Candidate terminal source identity is unavailable.');
            terminal.push(completed);
          } else yield* operation.effect;
        }
        yield* completeCandidateFiles(sql, snapshotId, admittedSnapshotKey, admission.token, terminal);
      }),
    );
  // All files/pages share bounded batches. Encoding is charged here in writing-candidates,
  // and the next page plus native codec scratch fits the same aggregate 8 MiB buffer.
  for (const operation of candidateFileOperations(sql, snapshotId, snapshotKey, files)) {
    if (
      operation.rows > RESOLUTION_CANDIDATE_INDEX_PAGE_ROWS ||
      operation.bytes > RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES
    )
      return yield* CodeGraphStoreError.of('Candidate index operation is oversized.');
    if (
      operations.length > 0 &&
      (rows + operation.rows > RESOLUTION_CANDIDATE_INDEX_PAGE_ROWS ||
        bytes + operation.bytes > RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES ||
        codecBytes + operation.codecBytes > RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES - CANDIDATE_CODEC_BUFFER_BYTES)
    ) {
      yield* flush();
      operations = [];
      rows = 0;
      bytes = 0;
      codecBytes = 0;
      reservationBytes = 0;
    }
    operations.push(operation);
    reservationBytes += operation.reservationBytes ?? operation.bytes;
    rows += operation.rows;
    bytes += operation.bytes;
    codecBytes += operation.codecBytes;
  }
  if (operations.length > 0) yield* flush();
});

const stageResolutionCandidateIndexInternal = Effect.fn('codeGraph.stageCandidateIndex')(function* (
  sql: SqlClient.SqlClient,
  input: ResolutionCandidateIndexStage,
  writer: CandidateIndexWriter,
  protector?: CodeGraphDirectPersistentCapacityProtector,
) {
  if (!(yield* resolutionCandidateIndexSchemaReady(sql))) return;
  const work = yield* Effect.try(() => candidatePreparationWork(input));
  const prepare = Effect.try(() => prepareCandidateFiles(input));
  const ownedPreparation = input.preparationGate ? input.preparationGate(prepare) : prepare;
  // Reservation admission/maintenance precedes preparation ownership; no writer wait is nested inside the preparation gate.
  const files = yield* protector
    ? protector(
        {operation: 'stage persistent code graph facts', rowCount: work.rowCount, finalFactBytes: work.originalBytes},
        ownedPreparation,
      )
    : ownedPreparation;
  yield* stagePreparedCandidateFiles(sql, input.snapshotId, files, writer, protector);
});

export const stageResolutionCandidateIndex = (...args: Parameters<typeof stageResolutionCandidateIndexInternal>) =>
  stageResolutionCandidateIndexInternal(...args).pipe(Effect.catchIf(isAuthorityChanged, () => Effect.void));

/** Carry every key/hyperedge of each bounded inherited file, including keys not queried by this change. */
const inheritCandidateDelta = Effect.fn('codeGraph.inheritCandidateDelta')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  inheritedId: string,
  authorityToken: string,
  writer: CandidateIndexWriter,
  protector?: CodeGraphDirectPersistentCapacityProtector,
) {
  const snapshotKey = yield* candidateSnapshotKey(sql, inheritedId, authorityToken);
  if (snapshotKey === undefined) return false;
  const files: CandidatePreparedFile[] = [];
  let copiedRows = 0;
  let copiedBytes = 0;
  let afterFile = -1;
  for (;;) {
    // Pre-exhaustion precedes even the next metadata cursor; a nonempty sentinel is charged.
    if (
      copiedRows >= CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS ||
      copiedBytes + 256 > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES
    )
      return false;
    const remainingBytes = CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES - copiedBytes - 256;
    const metadata = yield* sql<{
      readonly file_key: number;
      readonly path: string | null;
      readonly content_hash: string | null;
      readonly association_count: number;
      readonly reexport_count: number;
      readonly page_count: number;
      readonly original_tuple_bytes: number;
      readonly canonical_sha: string;
    }>`
      SELECT prior.file_key, CASE WHEN length(CAST(prior.path AS BLOB)) + length(CAST(prior.content_hash AS BLOB)) <= ${remainingBytes}
        THEN prior.path ELSE NULL END AS path,
        CASE WHEN length(CAST(prior.path AS BLOB)) + length(CAST(prior.content_hash AS BLOB)) <= ${remainingBytes}
        THEN prior.content_hash ELSE NULL END AS content_hash,
        prior.association_count,prior.reexport_count,prior.page_count,prior.original_tuple_bytes,prior.canonical_sha
      FROM snapshot_candidate_page_files AS prior WHERE prior.snapshot_key = ${snapshotKey} AND prior.sealed = 1
        AND prior.file_key > ${afterFile} AND EXISTS (SELECT 1 FROM snapshot_files AS current
          WHERE current.snapshot_id = ${snapshotId} AND current.path = prior.path AND current.content_hash = prior.content_hash)
        AND NOT EXISTS (SELECT 1 FROM snapshot_candidate_files AS fresh WHERE fresh.snapshot_id = ${snapshotId} AND fresh.path = prior.path)
      ORDER BY prior.file_key LIMIT 1`;
    copiedBytes += 256;
    if (metadata.length === 0) break;
    copiedRows += 1;
    if (files.length >= CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_FILES) return false;
    const file = metadata[0];
    afterFile = file.file_key;
    if (file.path === null || file.content_hash === null) return false;
    copiedBytes += Buffer.byteLength(file.path) + Buffer.byteLength(file.content_hash);
    const logicalRows = file.association_count * 2 + file.page_count + file.reexport_count + 2;
    if (
      !Number.isSafeInteger(logicalRows) ||
      logicalRows < 0 ||
      copiedRows + logicalRows > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS ||
      copiedBytes + file.original_tuple_bytes > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES
    )
      return false;
    const totals = yield* sql<{readonly rows: number; readonly bytes: number}>`SELECT COUNT(*) AS rows,
      COALESCE(SUM(raw_bytes + stored_bytes + 256),0) AS bytes FROM (SELECT raw_bytes,stored_bytes FROM snapshot_candidate_pages
        WHERE snapshot_key = ${snapshotKey} AND file_key = ${file.file_key} LIMIT ${file.page_count + 1})`;
    if (totals[0]?.rows !== file.page_count || !Number.isSafeInteger(totals[0].bytes)) return false;
    copiedBytes += totals[0].bytes + file.original_tuple_bytes;
    copiedRows += logicalRows;
    if (copiedBytes > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES) return false;
    const projection = yield* readCandidateFileProjection(
      sql,
      snapshotKey,
      file.file_key,
      file.path,
      file.association_count,
      file.page_count,
      file.canonical_sha,
    );
    if (!projection) return false;
    const reexports: {id: string; json: string}[] = [];
    let afterEdge: string | undefined;
    for (;;) {
      const left = CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES - copiedBytes;
      if (left < 128) return false;
      copiedBytes += 128;
      const rows = yield* sql.unsafe<{readonly edge_id: string | null; readonly payload_json: string | null}>(
        `
        SELECT CASE WHEN length(CAST(edge_id AS BLOB)) + length(CAST(payload_json AS BLOB)) <= ? THEN edge_id ELSE NULL END AS edge_id,
          CASE WHEN length(CAST(edge_id AS BLOB)) + length(CAST(payload_json AS BLOB)) <= ? THEN payload_json ELSE NULL END AS payload_json
        FROM snapshot_candidate_reexports WHERE snapshot_id = ? AND evidence_path = ? ${afterEdge === undefined ? '' : 'AND edge_id > ?'}
        ORDER BY edge_id LIMIT 1`,
        [left - 128, left - 128, inheritedId, file.path, ...(afterEdge === undefined ? [] : [afterEdge])],
      );
      if (rows.length === 0) break;
      const row = rows[0];
      if (row.edge_id === null || row.payload_json === null || reexports.length >= file.reexport_count) return false;
      copiedBytes += Buffer.byteLength(row.edge_id) + Buffer.byteLength(row.payload_json);
      reexports.push({id: row.edge_id, json: row.payload_json});
      afterEdge = row.edge_id;
    }
    if (reexports.length !== file.reexport_count) return false;
    files.push({path: file.path, contentHash: file.content_hash, pairs: projection.pairs, reexports});
  }
  // Recheck inherited authority before carrying fully verified independent tuples into the current file-owned pages.
  if ((yield* resolutionCandidateAuthorityToken(sql)) !== authorityToken) return false;
  yield* stagePreparedCandidateFiles(sql, snapshotId, files, writer, protector);
  return true;
});

const finishResolutionCandidateIndexInternal = Effect.fn('codeGraph.finishCandidateIndex')(function* (
  sql: SqlClient.SqlClient,
  input: ResolutionCandidateIndexFinish,
  writer: CandidateIndexWriter,
  protector?: CodeGraphDirectPersistentCapacityProtector,
) {
  if (!(yield* resolutionCandidateIndexSchemaReady(sql))) return false;
  const authorityToken = yield* resolutionCandidateAuthorityToken(sql);
  if (!authorityToken) return false;
  const snapshots = yield* sql<{
    readonly base_snapshot_id: string | null;
    readonly state: string;
    readonly file_count: number;
    readonly graph_content_id: string;
    readonly extractor_set: string;
  }>`
    SELECT base_snapshot_id, state, file_count, graph_content_id, extractor_set FROM snapshots WHERE id = ${input.snapshotId} LIMIT 1`;
  const snapshot = snapshots[0];
  if (!snapshot || snapshot.state !== 'ready') return false;
  yield* stagePreparedCandidateFiles(sql, input.snapshotId, [], writer, protector);
  const snapshotKey = yield* candidateSnapshotKey(sql, input.snapshotId, authorityToken);
  if (snapshotKey === undefined) return false;
  if (snapshot.base_snapshot_id !== null) {
    const root = yield* resolutionCandidateIndexLayers(
      sql,
      {...input, snapshotId: snapshot.base_snapshot_id},
      authorityToken,
    );
    if (!root || root.deltaId !== undefined) return false;
    if (input.inheritedSnapshotId !== undefined) {
      const inherited = yield* resolutionCandidateIndexLayers(
        sql,
        {...input, snapshotId: input.inheritedSnapshotId},
        authorityToken,
      );
      if (!inherited || inherited.rootId !== root.rootId) return false;
      if (
        inherited.deltaId !== undefined &&
        !(yield* inheritCandidateDelta(sql, input.snapshotId, inherited.deltaId, authorityToken, writer, protector))
      )
        return false;
    }
  }
  return yield* candidateIndexWrite(
    sql,
    writer,
    protector,
    1,
    Buffer.byteLength(JSON.stringify(input)) + 256,
    Effect.gen(function* () {
      const unchanged = yield* sql`SELECT 1 FROM snapshots WHERE id = ${input.snapshotId} AND state = 'ready'
        AND base_snapshot_id IS ${snapshot.base_snapshot_id} AND file_count = ${snapshot.file_count}
        AND extractor_set = ${snapshot.extractor_set} AND graph_content_id = ${snapshot.graph_content_id} LIMIT 1`;
      if (unchanged.length !== 1) return false;
      if (snapshot.base_snapshot_id !== null) {
        const root = yield* resolutionCandidateIndexLayers(
          sql,
          {...input, snapshotId: snapshot.base_snapshot_id},
          authorityToken,
        );
        if (!root || root.deltaId !== undefined) return false;
        if (
          input.inheritedSnapshotId !== undefined &&
          !(yield* resolutionCandidateIndexLayers(
            sql,
            {...input, snapshotId: input.inheritedSnapshotId},
            authorityToken,
          ))
        )
          return false;
      }
      const counts = yield* sql<{
        readonly actual: number;
        readonly indexed: number;
        readonly mismatched: number;
        readonly incomplete: number;
        readonly current_files: number;
        readonly current_sealed: number;
        readonly current_mismatched: number;
      }>`
      SELECT (SELECT COUNT(*) FROM snapshot_candidate_page_files WHERE snapshot_key = ${snapshotKey}) AS current_files,
        (SELECT COUNT(*) FROM snapshot_candidate_page_files WHERE snapshot_key = ${snapshotKey} AND sealed = 1) AS current_sealed,
        (SELECT COUNT(*) FROM snapshot_candidate_page_files AS file LEFT JOIN snapshot_files AS source
          ON source.snapshot_id = ${input.snapshotId} AND source.path = file.path AND source.content_hash = file.content_hash
          WHERE file.snapshot_key = ${snapshotKey} AND source.path IS NULL) AS current_mismatched,
        (SELECT COUNT(*) FROM snapshot_files WHERE snapshot_id = ${input.snapshotId}) AS actual,
        (SELECT COUNT(*) FROM snapshot_candidate_files WHERE snapshot_id = ${input.snapshotId}) AS indexed,
        (SELECT COUNT(*) FROM snapshot_candidate_files AS indexed LEFT JOIN snapshot_files AS source
          ON source.snapshot_id = indexed.snapshot_id AND source.path = indexed.path AND source.content_hash = indexed.content_hash
          WHERE indexed.snapshot_id = ${input.snapshotId} AND source.path IS NULL) AS mismatched,
        (SELECT COUNT(*) FROM snapshot_candidate_files AS file WHERE file.snapshot_id = ${input.snapshotId} AND
          (file.complete <> 1 OR NOT EXISTS (SELECT 1 FROM snapshot_candidate_generations AS generation
            WHERE generation.snapshot_id = file.snapshot_id AND generation.kind = 'file' AND generation.path = file.path
              AND generation.authority_token = ${authorityToken}))) AS incomplete`;
      const count = counts[0];
      if (
        !count ||
        count.incomplete !== 0 ||
        count.mismatched !== 0 ||
        count.actual !== count.indexed ||
        count.current_files !== count.actual ||
        count.current_sealed !== count.actual ||
        count.current_mismatched !== 0 ||
        (snapshot.base_snapshot_id === null && count.actual !== snapshot.file_count)
      )
        return false;
      yield* sql`INSERT INTO snapshot_candidate_generations (snapshot_id, kind, path, authority_token)
        VALUES (${input.snapshotId}, 'receipt', '', ${authorityToken})
        ON CONFLICT(snapshot_id, kind, path) DO UPDATE SET authority_token = excluded.authority_token`;
      yield* sql`INSERT OR REPLACE INTO snapshot_candidate_receipts (
      snapshot_id, version, root_snapshot_id, extractor_set, graph_content_id, workspace_fingerprint, file_set_fingerprint, file_count
    ) VALUES (${input.snapshotId}, ${RESOLUTION_CANDIDATE_INDEX_VERSION}, ${snapshot.base_snapshot_id}, ${snapshot.extractor_set},
      ${snapshot.graph_content_id}, ${input.workspaceFingerprint}, ${input.fileSetFingerprint}, ${snapshot.file_count})`;
      yield* sql`INSERT OR REPLACE INTO snapshot_candidate_page_receipts
        (snapshot_key,format_version,protocol_sha,authority_token,file_count)
        VALUES (${snapshotKey},3,${CANDIDATE_PAGE_PROTOCOL_SHA},${authorityToken},${snapshot.file_count})`;
      return true;
    }),
    authorityToken,
  );
});

export const finishResolutionCandidateIndex = (...args: Parameters<typeof finishResolutionCandidateIndexInternal>) =>
  finishResolutionCandidateIndexInternal(...args).pipe(Effect.catchIf(isAuthorityChanged, () => Effect.succeed(false)));
