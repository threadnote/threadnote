import {
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_FILES,
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS,
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES,
} from '../../incremental/work.js';
import {Array as EffectArray, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {CodeGraphStoreError} from '../../types.js';
import type {CodeGraphDirectPersistentCapacityProtector} from '../models.js';
import {chunk} from '../utilities.js';
import {
  RESOLUTION_CANDIDATE_INDEX_PAGE_ROWS,
  RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES,
  RESOLUTION_CANDIDATE_INDEX_VERSION,
  resolutionCandidateFileRepresentable,
  resolutionCandidateAuthorityToken,
  resolutionCandidateIndexSchemaReady,
  resolutionCandidateReexportRow,
  type ResolutionCandidateIndexFinish,
  type ResolutionCandidateIndexStage,
} from './candidate_index.js';
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
) {
  const write = writer(
    sql.withTransaction(
      Effect.gen(function* () {
        if (
          authorityToken !== undefined &&
          (!(yield* resolutionCandidateIndexSchemaReady(sql)) ||
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

const stageResolutionCandidateIndexInternal = Effect.fn('codeGraph.stageCandidateIndex')(function* (
  sql: SqlClient.SqlClient,
  input: ResolutionCandidateIndexStage,
  writer: CandidateIndexWriter,
  protector?: CodeGraphDirectPersistentCapacityProtector,
) {
  if (!(yield* resolutionCandidateIndexSchemaReady(sql))) return;
  const authorityToken = yield* resolutionCandidateAuthorityToken(sql);
  if (!authorityToken) return;
  const write = <A, E, R>(rows: number, bytes: number, effect: Effect.Effect<A, E, R>) =>
    candidateIndexWrite(sql, writer, protector, rows, bytes, effect, authorityToken);
  const complete = yield* sql`SELECT 1 FROM snapshot_candidate_receipts AS receipt
    JOIN snapshot_candidate_generations AS generation ON generation.snapshot_id = receipt.snapshot_id
      AND generation.kind = 'receipt' AND generation.path = '' AND generation.authority_token = ${authorityToken}
    JOIN snapshot_candidate_authority AS authority ON authority.singleton = 1 AND authority.state = 'ready' AND authority.token = generation.authority_token
    WHERE receipt.snapshot_id = ${input.snapshotId} LIMIT 1`;
  if (complete.length > 0) return;
  const paths = new Set(EffectArray.map(input.files, file => file.path));
  if (
    paths.size !== input.files.length ||
    EffectArray.some(input.references, reference => !paths.has(reference.evidencePath))
  ) {
    return yield* CodeGraphStoreError.of('Candidate index evidence is outside its source files.');
  }
  const referencesByPath = new Map<string, import('../../types.js').CodeGraphReference[]>();
  for (const reference of input.references) {
    const group = referencesByPath.get(reference.evidencePath) ?? [];
    group.push(reference);
    referencesByPath.set(reference.evidencePath, group);
  }
  const eligibleFiles = EffectArray.filter(input.files, file =>
    resolutionCandidateFileRepresentable(input.snapshotId, file, referencesByPath.get(file.path) ?? []),
  );
  const eligiblePaths = new Set(EffectArray.map(eligibleFiles, file => file.path));
  const associations = new Map<string, readonly [string, string, string]>();
  const reexports: {readonly path: string; readonly id: string; readonly json: string}[] = [];
  for (const reference of input.references) {
    if (!eligiblePaths.has(reference.evidencePath)) continue;
    for (const tier of reference.lookupTiers)
      for (const key of tier) {
        const row = [reference.resolutionDomain, key, reference.evidencePath] as const;
        associations.set(JSON.stringify(row), row);
      }
    const reexport = resolutionCandidateReexportRow(reference);
    if (reexport) reexports.push(reexport);
  }
  const associationCounts = new Map<string, number>();
  const reexportCounts = new Map<string, number>();
  for (const row of associations.values()) associationCounts.set(row[2], (associationCounts.get(row[2]) ?? 0) + 1);
  for (const row of reexports) reexportCounts.set(row.path, (reexportCounts.get(row.path) ?? 0) + 1);
  for (const files of chunk(eligibleFiles, RESOLUTION_CANDIDATE_INDEX_PAGE_ROWS)) {
    yield* write(
      files.length,
      Buffer.byteLength(JSON.stringify(files)),
      Effect.gen(function* () {
        for (const file of files) {
          const actual = yield* sql<{readonly content_hash: string}>`
          SELECT file.content_hash FROM snapshot_files AS file JOIN snapshots AS snapshot ON snapshot.id = file.snapshot_id
          WHERE file.snapshot_id = ${input.snapshotId} AND file.path = ${file.path}
            AND snapshot.state IN ('building', 'ready') LIMIT 1
        `;
          if (actual[0]?.content_hash !== file.contentHash)
            return yield* CodeGraphStoreError.of('Candidate index source identity changed.');
          yield* sql`INSERT INTO snapshot_candidate_files (snapshot_id, path, content_hash, association_count, reexport_count, complete)
          VALUES (${input.snapshotId}, ${file.path}, ${file.contentHash}, ${associationCounts.get(file.path) ?? 0}, ${reexportCounts.get(file.path) ?? 0}, 0)
          ON CONFLICT(snapshot_id, path) DO UPDATE SET complete = 0,
            association_count = excluded.association_count, reexport_count = excluded.reexport_count`;
          const prior = yield* sql<{readonly content_hash: string}>`
          SELECT content_hash FROM snapshot_candidate_files WHERE snapshot_id = ${input.snapshotId} AND path = ${file.path}`;
          if (prior[0]?.content_hash !== file.contentHash)
            return yield* CodeGraphStoreError.of('Candidate index resumed against different source.');
        }
      }),
    );
  }
  for (const page of yield* candidateIndexPages([...associations.values()], row =>
    Buffer.byteLength(JSON.stringify(row)),
  )) {
    yield* write(
      page.length,
      Buffer.byteLength(JSON.stringify(page)),
      sql.unsafe(
        `INSERT OR IGNORE INTO snapshot_candidate_lookup (snapshot_id, resolution_domain, lookup_key, evidence_path)
       VALUES ${EffectArray.join(
         EffectArray.map(page, () => '(?,?,?,?)'),
         ',',
       )}`,
        EffectArray.flatMap(page, row => [input.snapshotId, ...row]),
      ),
    );
  }
  for (const page of yield* candidateIndexPages(reexports, row => Buffer.byteLength(row.json))) {
    yield* write(
      page.length,
      Buffer.byteLength(JSON.stringify(page)),
      sql.unsafe(
        `INSERT INTO snapshot_candidate_reexports (snapshot_id, evidence_path, edge_id, payload_json)
       VALUES ${EffectArray.join(
         EffectArray.map(page, () => '(?,?,?,?)'),
         ',',
       )}
       ON CONFLICT(snapshot_id, evidence_path, edge_id) DO UPDATE SET payload_json = excluded.payload_json`,
        EffectArray.flatMap(page, row => [input.snapshotId, row.path, row.id, row.json]),
      ),
    );
  }
  for (const files of chunk(eligibleFiles, RESOLUTION_CANDIDATE_INDEX_PAGE_ROWS)) {
    yield* write(
      files.length,
      Buffer.byteLength(JSON.stringify(files)) + files.length * 128,
      Effect.gen(function* () {
        const paths = EffectArray.map(files, file => file.path);
        const slots = EffectArray.join(
          EffectArray.map(files, () => '?'),
          ',',
        );
        yield* sql.unsafe(
          `UPDATE snapshot_candidate_files SET complete = 1 WHERE snapshot_id = ? AND path IN (${slots})
        AND association_count = (SELECT COUNT(*) FROM snapshot_candidate_lookup AS candidate
          WHERE candidate.snapshot_id = snapshot_candidate_files.snapshot_id AND candidate.evidence_path = snapshot_candidate_files.path)
        AND reexport_count = (SELECT COUNT(*) FROM snapshot_candidate_reexports AS candidate
          WHERE candidate.snapshot_id = snapshot_candidate_files.snapshot_id AND candidate.evidence_path = snapshot_candidate_files.path)`,
          [input.snapshotId, ...paths],
        );
        yield* sql.unsafe(
          `INSERT INTO snapshot_candidate_generations (snapshot_id, kind, path, authority_token)
        SELECT snapshot_id, 'file', path, ? FROM snapshot_candidate_files
        WHERE snapshot_id = ? AND complete = 1 AND path IN (${slots})
        ON CONFLICT(snapshot_id, kind, path) DO UPDATE SET authority_token = excluded.authority_token`,
          [authorityToken, input.snapshotId, ...paths],
        );
      }),
    );
  }
});

export const stageResolutionCandidateIndex = (...args: Parameters<typeof stageResolutionCandidateIndexInternal>) =>
  stageResolutionCandidateIndexInternal(...args).pipe(Effect.catchIf(isAuthorityChanged, () => Effect.void));

/** Copy only a bounded prior delta, never a repository-sized candidate surface. */
const inheritCandidateDelta = Effect.fn('codeGraph.inheritCandidateDelta')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  inheritedId: string,
  authorityToken: string,
  writer: CandidateIndexWriter,
  protector?: CodeGraphDirectPersistentCapacityProtector,
) {
  const write = <A, E, R>(rows: number, bytes: number, effect: Effect.Effect<A, E, R>) =>
    candidateIndexWrite(sql, writer, protector, rows, bytes, effect, authorityToken);
  const files = yield* sql<{
    readonly path: string;
    readonly content_hash: string;
    readonly association_count: number;
    readonly reexport_count: number;
  }>`
    SELECT prior.path, prior.content_hash, prior.association_count, prior.reexport_count FROM snapshot_candidate_files AS prior
    JOIN snapshot_files AS current ON current.snapshot_id = ${snapshotId} AND current.path = prior.path
      AND current.content_hash = prior.content_hash
    JOIN snapshot_candidate_generations AS generation ON generation.snapshot_id = prior.snapshot_id
      AND generation.kind = 'file' AND generation.path = prior.path AND generation.authority_token = ${authorityToken}
    WHERE prior.snapshot_id = ${inheritedId} AND prior.complete = 1 AND NOT EXISTS (
      SELECT 1 FROM snapshot_candidate_files AS fresh WHERE fresh.snapshot_id = ${snapshotId} AND fresh.path = prior.path
    ) ORDER BY prior.path LIMIT 257`;
  if (files.length > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_FILES) return false;
  let copiedBytes = 0;
  let copiedRows = 0;
  for (const file of files) {
    copiedRows += 2;
    copiedBytes += Buffer.byteLength(JSON.stringify(file)) + 128;
    for (const table of ['snapshot_candidate_lookup', 'snapshot_candidate_reexports'] as const) {
      const columns =
        table === 'snapshot_candidate_lookup'
          ? ['resolution_domain', 'lookup_key', 'evidence_path']
          : ['evidence_path', 'edge_id', 'payload_json'];
      const values = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (
            !(yield* resolutionCandidateIndexSchemaReady(sql)) ||
            (yield* resolutionCandidateAuthorityToken(sql)) !== authorityToken
          )
            return yield* Effect.fail(authorityChanged);
          const metadata = yield* sql.unsafe<{readonly rows: number; readonly bytes: number}>(
            `SELECT COUNT(*) AS rows, COALESCE(SUM(payload_bytes), 0) AS bytes FROM (
          SELECT ${EffectArray.join(
            EffectArray.map(columns, column => `length(CAST(${column} AS BLOB))`),
            ' + ',
          )} AS payload_bytes
          FROM ${table} WHERE snapshot_id = ? AND evidence_path = ? LIMIT ?
        )`,
            [inheritedId, file.path, CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS + 1],
          );
          copiedRows += metadata[0]?.rows ?? 0;
          copiedBytes += metadata[0]?.bytes ?? 0;
          if (
            copiedRows > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS ||
            copiedBytes > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES
          )
            return undefined;
          return yield* sql.unsafe<Readonly<Record<string, string>>>(
            `SELECT ${EffectArray.join(columns, ',')} FROM ${table} WHERE snapshot_id = ? AND evidence_path = ?`,
            [inheritedId, file.path],
          );
        }),
      );
      if (values === undefined) return false;
      for (const page of yield* candidateIndexPages(values, row => Buffer.byteLength(JSON.stringify(row)))) {
        yield* write(
          page.length,
          Buffer.byteLength(JSON.stringify(page)),
          sql.unsafe(
            `INSERT OR IGNORE INTO ${table} (snapshot_id, ${EffectArray.join(columns, ',')})
           VALUES ${EffectArray.join(
             EffectArray.map(
               page,
               () =>
                 `(${EffectArray.join(
                   EffectArray.map([snapshotId, ...columns], () => '?'),
                   ',',
                 )})`,
             ),
             ',',
           )}`,
            EffectArray.flatMap(page, row => [snapshotId, ...EffectArray.map(columns, column => row[column])]),
          ),
        );
      }
    }
    yield* write(
      2,
      Buffer.byteLength(JSON.stringify(file)) + 128,
      Effect.gen(function* () {
        yield* sql`INSERT INTO snapshot_candidate_files (snapshot_id, path, content_hash, association_count, reexport_count, complete)
        VALUES (${snapshotId}, ${file.path}, ${file.content_hash}, ${file.association_count}, ${file.reexport_count}, 1)`;
        yield* sql`INSERT INTO snapshot_candidate_generations (snapshot_id, kind, path, authority_token)
        VALUES (${snapshotId}, 'file', ${file.path}, ${authorityToken})
        ON CONFLICT(snapshot_id, kind, path) DO UPDATE SET authority_token = excluded.authority_token`;
      }),
    );
  }
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
      }>`
      SELECT (SELECT COUNT(*) FROM snapshot_files WHERE snapshot_id = ${input.snapshotId}) AS actual,
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
      return true;
    }),
    authorityToken,
  );
});

export const finishResolutionCandidateIndex = (...args: Parameters<typeof finishResolutionCandidateIndexInternal>) =>
  finishResolutionCandidateIndexInternal(...args).pipe(Effect.catchIf(isAuthorityChanged, () => Effect.succeed(false)));
