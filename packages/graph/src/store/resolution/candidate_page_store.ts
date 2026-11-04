import {candidateSynopsisBinding} from './candidate_synopsis.js';
import {Array as EffectArray, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {CodeGraphStoreError, type CodeGraphReference} from '../../types.js';
import type {ResolutionCandidateIndexStage} from './candidate_index.js';
import {resolutionCandidateFileRepresentable, resolutionCandidateReexportRow} from './candidate_index.js';
import {assertCurrentCandidateCapacity} from './candidate_capacity.js';
import {
  candidateCanonicalSha,
  candidateBytesEqual,
  candidateFilePages,
  canonicalCandidatePairs,
  CANDIDATE_PAGE_PROTOCOL_SHA,
  decodeCandidatePage,
  type CandidatePage,
  type CandidatePair,
} from './candidate_pages.js';

export interface CandidatePreparedFile {
  readonly path: string;
  readonly contentHash: string;
  readonly pairs: readonly CandidatePair[];
  readonly reexports: readonly {readonly id: string; readonly json: string}[];
}
export interface CandidateFileCompletion {
  readonly fileKey: number;
  readonly path: string;
  readonly contentHash: string;
  readonly associations: number;
  readonly reexports: number;
  readonly pages: number;
  readonly originalBytes: number;
  readonly canonicalSha: string;
}
export interface CandidateWriteOperation {
  readonly rows: number;
  /** Logical SQL data cells under the existing8MiB payload guard; source tuple expansion is separately counted. */
  readonly bytes: number;
  /** Conservative payload/metadata reservation, never a smaller source eligibility quota. */
  readonly reservationBytes?: number;
  readonly completion?: () => CandidateFileCompletion | undefined;
  readonly codecBytes: number;
  readonly effect: Effect.Effect<void, unknown>;
}

export const candidateSnapshotKey = Effect.fn('codeGraph.candidateSnapshotKey')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  token: string,
) {
  yield* assertCurrentCandidateCapacity(sql);
  const rows = yield* sql<{
    readonly snapshot_key: number;
  }>`SELECT snapshot_key FROM snapshot_candidate_synopsis_snapshots
    WHERE snapshot_id = ${snapshotId} AND authority_token = ${token} AND protocol_sha = ${CANDIDATE_PAGE_PROTOCOL_SHA}
      AND format_version = 4 LIMIT 1`;
  yield* assertCurrentCandidateCapacity(sql);
  const key = rows[0]?.snapshot_key;
  return typeof key === 'number' && Number.isSafeInteger(key) && key > 0 ? key : undefined;
});

export function prepareCandidateFiles(input: ResolutionCandidateIndexStage): readonly CandidatePreparedFile[] {
  const paths = new Set(EffectArray.map(input.files, file => file.path));
  if (paths.size !== input.files.length || EffectArray.some(input.references, ref => !paths.has(ref.evidencePath)))
    throw new Error('Candidate index evidence is outside its source files.');
  const byPath = new Map<string, CodeGraphReference[]>();
  for (const ref of input.references) {
    const group = byPath.get(ref.evidencePath) ?? [];
    group.push(ref);
    byPath.set(ref.evidencePath, group);
  }
  const files: CandidatePreparedFile[] = [];
  for (const file of input.files) {
    const refs = byPath.get(file.path) ?? [];
    if (!resolutionCandidateFileRepresentable(input.snapshotId, file, refs)) continue;
    function* originalPairs(): Generator<CandidatePair> {
      for (const ref of refs)
        for (const tier of ref.lookupTiers) for (const key of tier) yield [ref.resolutionDomain, key];
    }
    const reexports = new Map<string, string>();
    for (const ref of refs) {
      const row = resolutionCandidateReexportRow(ref);
      if (row) {
        if (reexports.has(row.id)) throw new Error('Candidate hyperedge identity is duplicated.');
        reexports.set(row.id, row.json);
      }
    }
    files.push({
      ...file,
      pairs: canonicalCandidatePairs(originalPairs()),
      reexports: EffectArray.map([...reexports], ([id, json]) => ({id, json})),
    });
  }
  return files;
}

const mismatch = () =>
  CodeGraphStoreError.of('Candidate canonical source, exact page prefix or route placement changed.');

/** The page is admitted against the independent canonical producer before any file seal. */
const persistPage = Effect.fn('codeGraph.persistCandidatePage')(function* (
  sql: SqlClient.SqlClient,
  snapshotKey: number,
  fileKey: number,
  page: CandidatePage,
  insert: boolean,
  originalBytes: number,
) {
  yield* assertCurrentCandidateCapacity(sql);
  const synopsis = page.synopsis;
  const synopsisSha = candidateSynopsisBinding(
    snapshotKey,
    fileKey,
    page.ordinal,
    page.rawSha,
    page.storedSha,
    synopsis,
  );
  if (insert)
    yield* sql`INSERT OR IGNORE INTO snapshot_candidate_synopsis_pages
    (snapshot_key,file_key,ordinal,entry_count,raw_bytes,stored_bytes,original_tuple_bytes,raw_sha,stored_sha,codec,synopsis,synopsis_sha,payload,literal_domain,literal_key)
    VALUES (${snapshotKey},${fileKey},${page.ordinal},${page.pairs.length},${page.rawBytes},${page.storedBytes},${originalBytes},
      ${page.rawSha},${page.storedSha},${page.codec},${synopsis},${synopsisSha},${page.payload ?? null},
      ${page.codec === 'literal-pair-v1' ? page.pairs[0][0] : null},${page.codec === 'literal-pair-v1' ? page.pairs[0][1] : null})`;
  yield* assertCurrentCandidateCapacity(sql);
  const rows = yield* sql<{
    readonly synopsis: Uint8Array | null;
    readonly synopsis_sha: Uint8Array | null;
    readonly entry_count: number;
    readonly raw_bytes: number;
    readonly stored_bytes: number;
    readonly original_tuple_bytes: number;
    readonly raw_sha: string;
    readonly stored_sha: string;
    readonly codec: string;
    readonly payload: Uint8Array | null;
    readonly literal_domain: string | null;
    readonly literal_key: string | null;
  }>`
    SELECT entry_count,raw_bytes,stored_bytes,original_tuple_bytes,raw_sha,stored_sha,codec,
      CASE WHEN typeof(synopsis) = 'blob' AND length(synopsis) = 128 THEN synopsis ELSE NULL END AS synopsis,
      CASE WHEN typeof(synopsis_sha) = 'blob' AND length(synopsis_sha) = 32 THEN synopsis_sha ELSE NULL END AS synopsis_sha,
      CASE WHEN typeof(payload) = 'blob' AND length(payload) = ${page.storedBytes} AND length(payload) <= 65536 THEN payload ELSE NULL END AS payload,
      CASE WHEN length(CAST(literal_domain AS BLOB)) + length(CAST(literal_key AS BLOB)) = ${page.storedBytes}
        AND stored_bytes <= 8388608 THEN literal_domain ELSE NULL END AS literal_domain,
      CASE WHEN length(CAST(literal_domain AS BLOB)) + length(CAST(literal_key AS BLOB)) = ${page.storedBytes}
        AND stored_bytes <= 8388608 THEN literal_key ELSE NULL END AS literal_key
    FROM snapshot_candidate_synopsis_pages WHERE snapshot_key = ${snapshotKey} AND file_key = ${fileKey} AND ordinal = ${page.ordinal} LIMIT 1`;
  yield* assertCurrentCandidateCapacity(sql);
  const row = rows[0];
  if (
    !row ||
    row.entry_count !== page.pairs.length ||
    row.raw_bytes !== page.rawBytes ||
    row.stored_bytes !== page.storedBytes ||
    row.original_tuple_bytes !== originalBytes ||
    row.raw_sha !== page.rawSha ||
    row.stored_sha !== page.storedSha ||
    row.codec !== page.codec ||
    !candidateBytesEqual(row.synopsis, synopsis) ||
    !candidateBytesEqual(row.synopsis_sha, synopsisSha)
  )
    return yield* mismatch();
  if (page.codec === 'literal-pair-v1') {
    if (row.payload !== null || row.literal_domain !== page.pairs[0][0] || row.literal_key !== page.pairs[0][1])
      return yield* mismatch();
  } else {
    if (
      row.literal_domain !== null ||
      row.literal_key !== null ||
      !row.payload ||
      !page.payload ||
      !candidateBytesEqual(row.payload, page.payload)
    )
      return yield* mismatch();
    const decoded = yield* Effect.try(() =>
      decodeCandidatePage(row.payload!, {...page, entryCount: page.pairs.length}),
    );
    if (!EffectArray.every(decoded, (pair, i) => pair[0] === page.pairs[i]?.[0] && pair[1] === page.pairs[i]?.[1]))
      return yield* mismatch();
  }
});

/** The caller groups these operations under the existing bounded writer/capacity transaction. */
export function* candidateFileOperations(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  snapshotKey: number,
  files: readonly CandidatePreparedFile[],
): Generator<CandidateWriteOperation> {
  for (const file of files) {
    const canonicalSha = candidateCanonicalSha(file.pairs);
    const tuplePrefixBytes = Buffer.byteLength(snapshotId) + Buffer.byteLength(file.path);
    const originalBytes =
      tuplePrefixBytes * file.pairs.length +
      EffectArray.reduce(file.pairs, 0, (n, pair) => n + Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]));
    // Count framing boundaries without encoding or retaining duplicate payloads.
    let pageCount = 0;
    let pageRows = 0;
    let pageBytes = 8;
    for (const pair of file.pairs) {
      const size = 8 + Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]);
      if (pageRows > 0 && (pageRows === 64 || pageBytes + size > 65536)) {
        pageCount += 1;
        pageRows = 0;
        pageBytes = 8;
      }
      if (size + 8 > 65536) pageCount += 1;
      else {
        pageRows += 1;
        pageBytes += size;
      }
    }
    if (pageRows > 0) pageCount += 1;
    let fileKey: number | undefined;
    let alreadySealed = false;
    const identityBytes =
      Buffer.byteLength(snapshotId) + Buffer.byteLength(file.path) + Buffer.byteLength(file.contentHash);
    yield {
      rows: 3,
      bytes: identityBytes,
      reservationBytes: identityBytes + 256,
      codecBytes: 0,
      effect: Effect.gen(function* () {
        yield* assertCurrentCandidateCapacity(sql);
        const source = yield* sql<{readonly content_hash: string}>`SELECT file.content_hash FROM snapshot_files AS file
        JOIN snapshots AS snapshot ON snapshot.id = file.snapshot_id WHERE file.snapshot_id = ${snapshotId} AND file.path = ${file.path}
        AND snapshot.state IN ('building','ready') LIMIT 1`;
        yield* assertCurrentCandidateCapacity(sql);
        if (source[0]?.content_hash !== file.contentHash) return yield* mismatch();
        yield* sql`INSERT OR IGNORE INTO snapshot_candidate_synopsis_files
        (snapshot_key,path,content_hash,association_count,reexport_count,page_count,original_tuple_bytes,canonical_sha,sealed)
        VALUES (${snapshotKey},${file.path},${file.contentHash},${file.pairs.length},${file.reexports.length},${pageCount},${originalBytes},${canonicalSha},0)`;
        yield* assertCurrentCandidateCapacity(sql);
        const prior = yield* sql<{
          readonly file_key: number;
          readonly content_hash: string;
          readonly association_count: number;
          readonly reexport_count: number;
          readonly page_count: number;
          readonly original_tuple_bytes: number;
          readonly canonical_sha: string;
          readonly sealed: number;
        }>`SELECT file_key,content_hash,association_count,reexport_count,page_count,
          original_tuple_bytes,canonical_sha,sealed FROM snapshot_candidate_synopsis_files
        WHERE snapshot_key = ${snapshotKey} AND path = ${file.path} LIMIT 1`;
        yield* assertCurrentCandidateCapacity(sql);
        const row = prior[0];
        if (
          !row ||
          !Number.isSafeInteger(row.file_key) ||
          row.file_key < 1 ||
          row.content_hash !== file.contentHash ||
          row.association_count !== file.pairs.length ||
          row.reexport_count !== file.reexports.length ||
          row.page_count !== pageCount ||
          row.original_tuple_bytes !== originalBytes ||
          row.canonical_sha !== canonicalSha
        )
          return yield* mismatch();
        fileKey = row.file_key;
        alreadySealed = row.sealed === 1;
        // Existing sealed evidence is immutable and was previously fully compared to this same canonical input.
        // Do not INSERT OR IGNORE on sealed pages: BEFORE INSERT deliberately refuses it.
        yield* sql`INSERT INTO snapshot_candidate_files (snapshot_id,path,content_hash,association_count,reexport_count,complete)
        VALUES (${snapshotId},${file.path},${file.contentHash},${file.pairs.length},${file.reexports.length},0)
        ON CONFLICT(snapshot_id,path) DO UPDATE SET complete = 0, association_count = excluded.association_count,
          reexport_count = excluded.reexport_count`;
        yield* assertCurrentCandidateCapacity(sql);
      }),
    };
    for (const page of candidateFilePages(file.pairs)) {
      const bytes =
        tuplePrefixBytes * page.pairs.length +
        EffectArray.reduce(page.pairs, 0, (n, pair) => n + Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]));
      const sqlPayloadBytes = page.storedBytes + 160;
      yield {
        rows: 1,
        bytes: sqlPayloadBytes,
        reservationBytes: Math.max(bytes, page.storedBytes) + 416 + page.pairs.length * 32,
        codecBytes: (page.payload?.byteLength ?? 0) + 128,
        effect: Effect.gen(function* () {
          yield* assertCurrentCandidateCapacity(sql);
          if (fileKey === undefined) return yield* mismatch();
          yield* persistPage(sql, snapshotKey, fileKey, page, !alreadySealed, bytes);
        }),
      };
    }
    for (const row of file.reexports) {
      yield {
        rows: 1,
        bytes:
          Buffer.byteLength(snapshotId) +
          Buffer.byteLength(file.path) +
          Buffer.byteLength(row.json) +
          Buffer.byteLength(row.id),
        reservationBytes:
          Buffer.byteLength(snapshotId) +
          Buffer.byteLength(file.path) +
          Buffer.byteLength(row.json) +
          Buffer.byteLength(row.id) +
          128,
        codecBytes: 0,
        effect: Effect.gen(function* () {
          yield* assertCurrentCandidateCapacity(sql);
          if (!alreadySealed)
            yield* sql`INSERT OR IGNORE INTO snapshot_candidate_reexports (snapshot_id,evidence_path,edge_id,payload_json)
            VALUES (${snapshotId},${file.path},${row.id},${row.json})`;
          yield* assertCurrentCandidateCapacity(sql);
          const actual = yield* sql<{readonly payload_json: string | null}>`SELECT
            CASE WHEN typeof(payload_json) = 'text' AND length(CAST(payload_json AS BLOB)) <= ${Buffer.byteLength(row.json)}
              THEN payload_json ELSE NULL END AS payload_json FROM snapshot_candidate_reexports
            WHERE snapshot_id = ${snapshotId} AND evidence_path = ${file.path} AND edge_id = ${row.id} LIMIT 1`;
          yield* assertCurrentCandidateCapacity(sql);
          if (actual[0]?.payload_json !== row.json) return yield* mismatch();
        }),
      };
    }
    yield {
      rows: 3,
      bytes: identityBytes,
      reservationBytes: identityBytes + 256,
      codecBytes: 0,
      effect: Effect.void,
      completion: () =>
        fileKey === undefined
          ? undefined
          : {
              fileKey,
              path: file.path,
              contentHash: file.contentHash,
              associations: file.pairs.length,
              reexports: file.reexports.length,
              pages: pageCount,
              originalBytes,
              canonicalSha,
            },
    };
  }
}

/** Every source/page/slot was fully verified before this bounded terminal group. Source CAS and counts are fresh in this transaction. */
export const completeCandidateFiles = Effect.fn('codeGraph.completeCandidateFiles')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  snapshotKey: number,
  token: string,
  files: readonly CandidateFileCompletion[],
) {
  yield* assertCurrentCandidateCapacity(sql);
  if (files.length === 0) return;
  const expected = EffectArray.flatMap(files, file => [
    file.fileKey,
    file.path,
    file.contentHash,
    file.associations,
    file.reexports,
    file.pages,
    file.originalBytes,
    file.canonicalSha,
  ]);
  // Preserve the bounded VALUES stream as the outer loop: SQLite must seek each
  // exact file/source binding, not multiply all retained files by the batch.
  const proof = yield* sql.unsafe<{readonly file_key: number}>(
    `WITH expected(file_key,path,content_hash,associations,reexports,pages,original_bytes,canonical_sha) AS (
    VALUES ${EffectArray.join(
      EffectArray.map(files, () => '(?,?,?,?,?,?,?,?)'),
      ',',
    )})
    SELECT expected.file_key FROM expected
    CROSS JOIN snapshot_candidate_synopsis_files AS file ON file.snapshot_key = ? AND file.file_key = expected.file_key
      AND file.path = expected.path AND file.content_hash = expected.content_hash
      AND file.association_count = expected.associations AND file.reexport_count = expected.reexports
      AND file.page_count = expected.pages AND file.original_tuple_bytes = expected.original_bytes AND file.canonical_sha = expected.canonical_sha
    CROSS JOIN snapshot_files AS source ON source.snapshot_id = ? AND source.path = expected.path AND source.content_hash = expected.content_hash
    CROSS JOIN snapshots AS owner ON owner.id = source.snapshot_id AND owner.state IN ('building','ready')
    CROSS JOIN snapshot_candidate_files AS legacy ON legacy.snapshot_id = source.snapshot_id AND legacy.path = source.path
      AND legacy.content_hash = source.content_hash AND legacy.association_count = expected.associations AND legacy.reexport_count = expected.reexports
    WHERE (SELECT COUNT(*) FROM snapshot_candidate_synopsis_pages WHERE snapshot_key = file.snapshot_key AND file_key = file.file_key) = expected.pages
      AND (SELECT COALESCE(SUM(entry_count),0) FROM snapshot_candidate_synopsis_pages WHERE snapshot_key = file.snapshot_key AND file_key = file.file_key) = expected.associations
      AND (SELECT COUNT(*) FROM snapshot_candidate_reexports WHERE snapshot_id = source.snapshot_id AND evidence_path = source.path) = expected.reexports`,
    [...expected, snapshotKey, snapshotId],
  );
  yield* assertCurrentCandidateCapacity(sql);
  if (proof.length !== files.length) return yield* mismatch();
  // Current generation binding precedes both completeness bits. All statements share the guarded atomic transaction.
  yield* sql.unsafe(
    `INSERT INTO snapshot_candidate_generations(snapshot_id,kind,path,authority_token)
    VALUES ${EffectArray.join(
      EffectArray.map(files, () => "(?,'file',?,?)"),
      ',',
    )}
    ON CONFLICT(snapshot_id,kind,path) DO UPDATE SET authority_token = excluded.authority_token`,
    EffectArray.flatMap(files, file => [snapshotId, file.path, token]),
  );
  yield* assertCurrentCandidateCapacity(sql);
  yield* sql.unsafe(
    `UPDATE snapshot_candidate_synopsis_files SET sealed = 1 WHERE snapshot_key = ? AND file_key IN (
    ${EffectArray.join(
      EffectArray.map(files, () => '?'),
      ',',
    )})`,
    [snapshotKey, ...EffectArray.map(files, file => file.fileKey)],
  );
  yield* assertCurrentCandidateCapacity(sql);
  yield* sql.unsafe(
    `UPDATE snapshot_candidate_files SET complete = 1 WHERE snapshot_id = ? AND path IN (
    ${EffectArray.join(
      EffectArray.map(files, () => '?'),
      ',',
    )})`,
    [snapshotId, ...EffectArray.map(files, file => file.path)],
  );
  yield* assertCurrentCandidateCapacity(sql);
});
