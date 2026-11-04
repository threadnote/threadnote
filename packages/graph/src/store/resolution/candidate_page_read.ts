import {Array as EffectArray, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import type {ProjectResolutionLookupKey} from '../../incremental/closure.js';
import {candidateSnapshotKey} from './candidate_page_store.js';
import {
  candidateCanonicalSha,
  candidateBytesEqual,
  compareCandidatePair,
  candidateFilePages,
  candidatePairHint,
  decodeCandidatePage,
  type CandidatePageCodec,
  type CandidatePair,
} from './candidate_pages.js';

export interface CandidatePageWork {
  readonly paths: readonly string[];
  readonly associations: number;
  readonly bytes: number;
  readonly exceeded?: 'rows' | 'bytes' | 'files';
}
interface PageMetadata {
  readonly eligible: number;
  readonly file_key: number;
  readonly ordinal: number;
  readonly slot: number;
  readonly entry_count: number;
  readonly raw_bytes: number;
  readonly stored_bytes: number;
  readonly original_tuple_bytes: number;
  readonly path_bytes: number;
  readonly codec: CandidatePageCodec;
}

/** A digest is only an indexed accelerator: all collisions receive full exact-value validation.
 * Scalar metadata and the remaining shared work budget are admitted before any BLOB or literal hydration.
 */
export const readCandidateKeyPages = Effect.fn('codeGraph.readCandidateKeyPages')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  mask: string | undefined,
  key: ProjectResolutionLookupKey,
  maximumAssociations: number,
  maximumBytes: number,
  maximumFiles: number,
  token: string,
) {
  const paths = new Set<string>();
  let associations = 0;
  let bytes = 0;
  const result = (exceeded?: CandidatePageWork['exceeded']): CandidatePageWork => ({
    paths: [...paths],
    associations,
    bytes,
    ...(exceeded ? {exceeded} : {}),
  });
  // The already exhausted case does no metadata scan and hydrates no payload.
  if (maximumAssociations <= 0) {
    associations = 1;
    return result('rows');
  }
  if (maximumBytes <= 0) {
    bytes = 1;
    return result('bytes');
  }
  const snapshotKey = yield* candidateSnapshotKey(sql, snapshotId, token);
  if (snapshotKey === undefined) return undefined;
  const hint = candidatePairHint([key.resolutionDomain, key.key]);
  let after: readonly [number, number, number] = [-1, -1, -1];
  const seen = new Set<string>();
  for (;;) {
    if (bytes + 128 > maximumBytes) {
      bytes += 128;
      return result('bytes');
    }
    if (associations >= maximumAssociations) {
      associations += 1;
      return result('rows');
    }
    bytes += 128; // Fixed query/scalar admission work, including a charged terminal sentinel.
    const metadata = yield* sql<PageMetadata>`SELECT route.file_key,route.ordinal,route.slot,
      page.entry_count,page.raw_bytes,page.stored_bytes,page.original_tuple_bytes,page.codec,
      length(CAST(file.path AS BLOB)) AS path_bytes,
      CASE WHEN file.sealed = 1
        AND NOT EXISTS (SELECT 1 FROM snapshot_files AS replacement WHERE replacement.snapshot_id = ${mask ?? null} AND replacement.path = file.path)
        AND NOT EXISTS (SELECT 1 FROM snapshot_file_deletions AS deletion WHERE deletion.snapshot_id = ${mask ?? null} AND deletion.path = file.path)
        THEN 1 ELSE 0 END AS eligible
      FROM snapshot_candidate_page_routes AS route INDEXED BY snapshot_candidate_page_routes_hint
      JOIN snapshot_candidate_pages AS page ON page.snapshot_key = route.snapshot_key AND page.file_key = route.file_key AND page.ordinal = route.ordinal
      JOIN snapshot_candidate_page_files AS file ON file.snapshot_key = route.snapshot_key AND file.file_key = route.file_key
      WHERE route.snapshot_key = ${snapshotKey} AND route.hint = ${hint}
        AND (route.file_key,route.ordinal,route.slot) > (${after[0]},${after[1]},${after[2]})
      ORDER BY route.file_key,route.ordinal,route.slot LIMIT 1`;
    if (metadata.length === 0) return result();
    associations += 1;
    const row = metadata[0];
    if (
      !Number.isSafeInteger(row.file_key) ||
      row.file_key < 1 ||
      !Number.isSafeInteger(row.ordinal) ||
      row.ordinal < 0 ||
      !Number.isSafeInteger(row.slot) ||
      row.slot < 0
    )
      return undefined;
    after = [row.file_key, row.ordinal, row.slot];
    // Every indexed candidate consumed scalar/query work even when a later
    // replacement/deletion mask makes its page ineligible. Never hydrate it.
    if (row.eligible !== 0 && row.eligible !== 1) return undefined;
    if (row.eligible === 0) continue;
    const id = `${row.file_key}/${row.ordinal}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (
      !Number.isSafeInteger(row.entry_count) ||
      row.entry_count < 1 ||
      row.entry_count > 64 ||
      row.slot < 0 ||
      row.slot >= row.entry_count ||
      !Number.isSafeInteger(row.raw_bytes) ||
      row.raw_bytes < 16 ||
      !Number.isSafeInteger(row.stored_bytes) ||
      row.stored_bytes < 1 ||
      row.stored_bytes > 8388608 ||
      !Number.isSafeInteger(row.original_tuple_bytes) ||
      row.original_tuple_bytes < 0 ||
      !Number.isSafeInteger(row.path_bytes) ||
      row.path_bytes < 0 ||
      (row.codec === 'literal-pair-v1'
        ? row.entry_count !== 1 || row.raw_bytes <= 65536 || row.raw_bytes > 8388608
        : row.raw_bytes > 65536 || row.stored_bytes > 65536)
    )
      return undefined;
    if (associations + row.entry_count > maximumAssociations) {
      associations += row.entry_count;
      return result('rows');
    }
    const cost = row.raw_bytes + row.stored_bytes + row.original_tuple_bytes + row.path_bytes;
    if (!Number.isSafeInteger(cost)) return undefined;
    if (bytes + cost > maximumBytes) {
      bytes += cost;
      return result('bytes');
    }
    associations += row.entry_count;
    bytes += cost;
    const payloads = yield* sql<{
      readonly payload: Uint8Array | null;
      readonly literal_domain: string | null;
      readonly literal_key: string | null;
      readonly raw_sha: string;
      readonly stored_sha: string;
      readonly path: string | null;
    }>`
      SELECT CASE WHEN typeof(page.payload) = 'blob' AND length(page.payload) = ${row.stored_bytes}
        AND page.stored_bytes <= 65536 THEN page.payload ELSE NULL END AS payload,
        CASE WHEN length(CAST(page.literal_domain AS BLOB)) + length(CAST(page.literal_key AS BLOB)) = ${row.stored_bytes}
          AND page.stored_bytes <= 8388608 THEN page.literal_domain ELSE NULL END AS literal_domain,
        CASE WHEN length(CAST(page.literal_domain AS BLOB)) + length(CAST(page.literal_key AS BLOB)) = ${row.stored_bytes}
          AND page.stored_bytes <= 8388608 THEN page.literal_key ELSE NULL END AS literal_key,
        page.raw_sha,page.stored_sha,
        CASE WHEN length(CAST(file.path AS BLOB)) = ${row.path_bytes} THEN file.path ELSE NULL END AS path
      FROM snapshot_candidate_pages AS page JOIN snapshot_candidate_page_files AS file
        ON file.snapshot_key = page.snapshot_key AND file.file_key = page.file_key
      WHERE page.snapshot_key = ${snapshotKey} AND page.file_key = ${row.file_key} AND page.ordinal = ${row.ordinal}
        AND file.sealed = 1 AND page.entry_count = ${row.entry_count} AND page.raw_bytes = ${row.raw_bytes}
        AND page.stored_bytes = ${row.stored_bytes} AND page.codec = ${row.codec} LIMIT 1`;
    const payload = payloads[0];
    if (!payload || payload.path === null) return undefined;
    let pairs: readonly CandidatePair[];
    if (row.codec === 'literal-pair-v1') {
      if (payload.payload !== null || payload.literal_domain === null || payload.literal_key === null) return undefined;
      pairs = [[payload.literal_domain, payload.literal_key]];
      const expected = candidateFilePages(pairs).next().value;
      if (
        !expected ||
        expected.rawSha !== payload.raw_sha ||
        expected.storedSha !== payload.stored_sha ||
        expected.rawBytes !== row.raw_bytes ||
        expected.storedBytes !== row.stored_bytes
      )
        return undefined;
    } else {
      if (!payload.payload || payload.literal_domain !== null || payload.literal_key !== null) return undefined;
      const decoded = yield* Effect.try(() =>
        decodeCandidatePage(payload.payload!, {
          codec: row.codec,
          entryCount: row.entry_count,
          rawBytes: row.raw_bytes,
          rawSha: payload.raw_sha,
          storedBytes: row.stored_bytes,
          storedSha: payload.stored_sha,
        }),
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (!decoded) return undefined;
      pairs = decoded;
    }
    if (EffectArray.some(pairs, pair => pair[0] === key.resolutionDomain && pair[1] === key.key))
      paths.add(payload.path);
    if (paths.size > maximumFiles) return result('files');
  }
});

/** Whole-file carry uses the same fixed page framing; no selected-key-only fold is permitted. */
export const readCandidateFileProjection = Effect.fn('codeGraph.readCandidateFileProjection')(function* (
  sql: SqlClient.SqlClient,
  snapshotKey: number,
  fileKey: number,
  path: string,
  associationCount: number,
  pageCount: number,
  canonicalSha: string,
) {
  const pairs: CandidatePair[] = [];
  let ordinal = 0;
  for (;;) {
    const rows = yield* sql<{
      readonly ordinal: number;
      readonly entry_count: number;
      readonly codec: CandidatePageCodec;
      readonly raw_bytes: number;
      readonly stored_bytes: number;
      readonly raw_sha: string;
      readonly stored_sha: string;
      readonly payload: Uint8Array | null;
      readonly literal_domain: string | null;
      readonly literal_key: string | null;
    }>`
      SELECT ordinal,entry_count,codec,raw_bytes,stored_bytes,raw_sha,stored_sha,
        CASE WHEN typeof(payload) = 'blob' AND length(payload) = stored_bytes AND stored_bytes <= 65536 THEN payload ELSE NULL END AS payload,
        CASE WHEN stored_bytes <= 8388608 AND length(CAST(literal_domain AS BLOB)) + length(CAST(literal_key AS BLOB)) = stored_bytes
          THEN literal_domain ELSE NULL END AS literal_domain,
        CASE WHEN stored_bytes <= 8388608 AND length(CAST(literal_domain AS BLOB)) + length(CAST(literal_key AS BLOB)) = stored_bytes
          THEN literal_key ELSE NULL END AS literal_key
      FROM snapshot_candidate_pages WHERE snapshot_key = ${snapshotKey} AND file_key = ${fileKey}
        AND ordinal >= ${ordinal} ORDER BY ordinal LIMIT 1`;
    if (rows.length === 0) break;
    const row = rows[0];
    if (
      row.ordinal !== ordinal ||
      ordinal >= pageCount ||
      row.entry_count < 1 ||
      row.entry_count > 64 ||
      pairs.length + row.entry_count > associationCount
    )
      return undefined;
    let values: readonly CandidatePair[];
    if (row.codec === 'literal-pair-v1') {
      if (row.literal_domain === null || row.literal_key === null || row.payload !== null) return undefined;
      values = [[row.literal_domain, row.literal_key]];
      const encoded = candidateFilePages(values).next().value;
      if (
        !encoded ||
        encoded.rawSha !== row.raw_sha ||
        encoded.storedSha !== row.stored_sha ||
        encoded.rawBytes !== row.raw_bytes ||
        encoded.storedBytes !== row.stored_bytes
      )
        return undefined;
    } else {
      if (!row.payload) return undefined;
      const decoded = yield* Effect.try(() =>
        decodeCandidatePage(row.payload!, {
          codec: row.codec,
          entryCount: row.entry_count,
          rawBytes: row.raw_bytes,
          storedBytes: row.stored_bytes,
          rawSha: row.raw_sha,
          storedSha: row.stored_sha,
        }),
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (!decoded) return undefined;
      values = decoded;
    }
    const routes = yield* sql<{readonly slot: number; readonly hint: Uint8Array | null}>`SELECT slot,
      CASE WHEN typeof(hint) = 'blob' AND length(hint) = 16 THEN hint ELSE NULL END AS hint
      FROM snapshot_candidate_page_routes WHERE snapshot_key = ${snapshotKey} AND file_key = ${fileKey} AND ordinal = ${ordinal}
      ORDER BY slot LIMIT 65`;
    if (
      routes.length !== values.length ||
      !EffectArray.every(
        routes,
        (route, i) =>
          route.slot === i && route.hint !== null && candidateBytesEqual(route.hint, candidatePairHint(values[i])),
      )
    )
      return undefined;
    pairs.push(...values);
    ordinal += 1;
  }
  if (
    ordinal !== pageCount ||
    pairs.length !== associationCount ||
    candidateCanonicalSha(pairs) !== canonicalSha ||
    EffectArray.some(pairs, (pair, i) => i > 0 && compareCandidatePair(pairs[i - 1], pair) >= 0)
  )
    return undefined;
  // Page ordinals/boundaries must be the exact greedy canonical packing, not an arbitrary partition of an equal set.
  let expectedPages = 0;
  for (const expected of candidateFilePages(pairs)) {
    const actual = yield* sql<{readonly raw_sha: string; readonly stored_sha: string}>`SELECT raw_sha,stored_sha
      FROM snapshot_candidate_pages WHERE snapshot_key = ${snapshotKey} AND file_key = ${fileKey} AND ordinal = ${expected.ordinal} LIMIT 1`;
    if (actual[0]?.raw_sha !== expected.rawSha || actual[0]?.stored_sha !== expected.storedSha) return undefined;
    expectedPages += 1;
  }
  return expectedPages === pageCount ? {path, pairs} : undefined;
});
