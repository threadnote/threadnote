import {Array as EffectArray, Clock, Effect, Predicate} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {withFreshCodeGraphReadTransaction} from '../store/session.js';
import {decodeStoredCodeGraphFact} from '../fact/storage.js';
import type {CodeGraphNavigationFacts, CodeGraphQueryResult, CodeGraphSpan} from '../types.js';

export const NAVIGATION_PROOF_CACHE_IDENTITY = '4eed98a2dba4e96718d1da39ca3a568155e7fc3e3f15fa7aeab88e32ee3ea970';
const BYTE_LIMIT = 1024 * 1024;
const FILE_LIMIT = 3;
const OWNER_LIMIT = 24;
const CALL_LIMIT = 64;
const ROW_LIMIT = FILE_LIMIT + OWNER_LIMIT + CALL_LIMIT;
const declaredRawBytesSql = `CASE WHEN json_valid(blob.facts_json) THEN
  CASE WHEN json_extract(blob.facts_json, '$.codec') = 'zlib-base64-v1' THEN
    CASE WHEN typeof(json_extract(blob.facts_json, '$.rawBytes')) = 'integer'
      THEN json_extract(blob.facts_json, '$.rawBytes') ELSE -1 END
    ELSE length(CAST(blob.facts_json AS BLOB)) END ELSE -1 END`;
const HASH = /^[a-f0-9]{64}$/u;
const OWNER_ID = /^cgs_[a-f0-9]{32}$/u;
const CALL_ID = /^cge_[a-f0-9]{32}$/u;
export interface NavigationFactSelector {
  readonly path: string;
  readonly contentHash: string;
}
export interface NavigationFactFile extends NavigationFactSelector {
  readonly state: 'available' | 'unsupported' | 'omitted' | 'conflict' | 'unavailable';
  readonly gap?: string;
  readonly facts?: CodeGraphNavigationFacts;
}
export interface NavigationFactRead {
  readonly gaps: readonly string[];
  readonly observation: Pick<CodeGraphQueryResult, 'repository' | 'snapshot' | 'freshness' | 'projectCoverage'>;
  readonly files: readonly NavigationFactFile[];
  readonly counters: {
    metadataReads: number;
    payloadReads: number;
    payloadRows: number;
    storedBytes: number;
    declaredRawBytes: number;
    decodedBytes: number;
    metadataRows: number;
    ownerRows: number;
    callRows: number;
    setupStatements: number;
    freshReadMilliseconds: number;
    metadataMilliseconds: number;
    payloadMilliseconds: number;
  };
}
interface Metadata {
  readonly kind: 'fact' | 'owner' | 'call';
  readonly path: string;
  readonly content_hash: string;
  readonly id: string;
  readonly cache_identity: string;
  readonly stored_bytes: number;
  readonly raw_bytes: number;
  readonly valid: number;
  readonly capability: number;
  readonly present: number;
  readonly span_json: string;
  readonly source_id: string;
  readonly target_name: string;
}

const effectiveReadyCte = `WITH selected AS MATERIALIZED (
  SELECT current.id, current.base_snapshot_id
  FROM snapshots AS current
  WHERE current.id = ? AND current.state = 'ready' AND current.repository_id = ?
    AND current.worktree_id = ? AND current.commit_id = ? AND current.dirty = ?
    AND NOT EXISTS (SELECT 1 FROM removed_views AS removed
      WHERE removed.worktree_id = current.worktree_id AND removed.expected_snapshot_id = current.id)
    AND (current.base_snapshot_id IS NULL OR EXISTS (
      SELECT 1 FROM snapshots AS base WHERE base.id = current.base_snapshot_id
        AND base.state = 'ready' AND base.base_snapshot_id IS NULL
        AND base.repository_id = current.repository_id AND base.extractor_set = current.extractor_set))
  LIMIT 1
), requested AS (SELECT value FROM json_each(?)), files AS MATERIALIZED (
  SELECT file.path, file.content_hash
  FROM requested CROSS JOIN selected
  CROSS JOIN snapshot_files AS file WHERE file.snapshot_id = selected.id
    AND file.path = json_extract(requested.value, '$.path')
    AND file.content_hash = json_extract(requested.value, '$.contentHash')
  UNION ALL
  SELECT file.path, file.content_hash
  FROM requested CROSS JOIN selected
  CROSS JOIN snapshot_files AS file WHERE file.snapshot_id = selected.base_snapshot_id
    AND file.path = json_extract(requested.value, '$.path')
    AND file.content_hash = json_extract(requested.value, '$.contentHash')
  AND NOT EXISTS (SELECT 1 FROM snapshot_files AS override
      WHERE override.snapshot_id = selected.id AND override.path = file.path)
    AND NOT EXISTS (SELECT 1 FROM snapshot_file_deletions AS deleted
      WHERE deleted.snapshot_id = selected.id AND deleted.path = file.path)
)`;

function anchorBranches(table: 'symbols' | 'edges', ids: string): string {
  const deletionTable = table === 'symbols' ? 'snapshot_symbol_deletions' : 'snapshot_edge_deletions';
  const deletionId = table === 'symbols' ? 'symbol_id' : 'edge_id';
  const fields =
    table === 'symbols'
      ? 'node.id, node.path, node.content_hash, node.span_json'
      : 'node.id, node.evidence_path AS path, node.source_id, node.target_name, node.evidence_span_json AS span_json';
  const predicate =
    table === 'symbols'
      ? "node.kind = 'function' AND length(CAST(node.span_json AS BLOB)) <= 256"
      : "node.relation = 'calls' AND node.provenance = 'syntactic' AND length(CAST(node.target_name AS BLOB)) <= 1024 AND length(CAST(node.evidence_span_json AS BLOB)) <= 256";
  return `SELECT ${fields} FROM ${ids} AS requested CROSS JOIN selected
    CROSS JOIN ${table} AS node ON node.snapshot_id = selected.id AND node.id = requested.value
    WHERE ${predicate}
    UNION ALL
    SELECT ${fields} FROM ${ids} AS requested CROSS JOIN selected
    CROSS JOIN ${table} AS node ON node.snapshot_id = selected.base_snapshot_id AND node.id = requested.value
    WHERE ${predicate}
      AND NOT EXISTS (SELECT 1 FROM ${table} AS override WHERE override.snapshot_id = selected.id AND override.id = node.id)
      AND NOT EXISTS (SELECT 1 FROM ${deletionTable} AS deleted WHERE deleted.snapshot_id = selected.id AND deleted.${deletionId} = node.id)`;
}

export const navigationFactMetadataSql = `${effectiveReadyCte},
  owner_ids AS (SELECT value FROM json_each(?)), call_ids AS (SELECT value FROM json_each(?)),
  owners AS MATERIALIZED (${anchorBranches('symbols', 'owner_ids')}),
  calls AS MATERIALIZED (${anchorBranches('edges', 'call_ids')}),
  pack AS MATERIALIZED (
    SELECT provenance.cache_identity FROM selected
    CROSS JOIN snapshot_pack_provenance AS provenance ON provenance.snapshot_id = selected.id AND provenance.pack_id = 'typescript'
    CROSS JOIN snapshot_extractor_generations AS generation ON generation.snapshot_id = selected.id AND generation.generation = 14
    WHERE provenance.cache_identity = '${NAVIGATION_PROOF_CACHE_IDENTITY}'
      AND provenance.resolution_domain = 'typescript'
      AND provenance.resolution_version = 'typescript-modules-v2-published-surface'
      AND (SELECT COUNT(*) FROM snapshot_pack_provenance AS duplicate
        WHERE duplicate.snapshot_id = selected.id AND duplicate.pack_id = 'typescript') = 1
    LIMIT 1
  )
  SELECT 'fact' AS kind, effective_file.path, effective_file.content_hash, NULL AS id, pack.cache_identity,
    length(CAST(blob.facts_json AS BLOB)) AS stored_bytes,
    CASE WHEN length(CAST(blob.facts_json AS BLOB)) <= ${BYTE_LIMIT}
      THEN ${declaredRawBytesSql} ELSE 0 END AS raw_bytes,
    CASE WHEN length(CAST(blob.facts_json AS BLOB)) > ${BYTE_LIMIT} THEN 0
      ELSE CASE WHEN json_valid(blob.facts_json) THEN
        CASE WHEN EXISTS (SELECT COUNT(*) FROM json_each(blob.facts_json) AS header
          WHERE instr(header.key, char(0)) > 0
            OR header.key IN ('codec', 'rawBytes', 'path', 'pathOccurrences', 'payload', 'sha256', 'type', 'version')
          HAVING COUNT(*) > COUNT(DISTINCT CASE WHEN instr(header.key, char(0)) > 0 THEN NULL ELSE header.key END)) THEN 0 ELSE
        json_extract(blob.facts_json, '$.path') = effective_file.path AND
        CASE WHEN json_extract(blob.facts_json, '$.codec') = 'zlib-base64-v1' THEN
          typeof(json_extract(blob.facts_json, '$.rawBytes')) = 'integer' AND json_extract(blob.facts_json, '$.rawBytes') BETWEEN 1024 AND ${BYTE_LIMIT}
          AND typeof(json_extract(blob.facts_json, '$.payload')) = 'text' AND length(json_extract(blob.facts_json, '$.payload')) > 0
          AND typeof(json_extract(blob.facts_json, '$.sha256')) = 'text' AND length(json_extract(blob.facts_json, '$.sha256')) = 64
          AND typeof(json_extract(blob.facts_json, '$.pathOccurrences')) = 'integer' AND json_extract(blob.facts_json, '$.pathOccurrences') > 0
        ELSE 1 END END ELSE 0 END END AS valid,
    pack.cache_identity IS NOT NULL AS capability, blob.path_hint IS NOT NULL AS present,
    NULL AS span_json, NULL AS source_id, NULL AS target_name
  FROM files AS effective_file LEFT JOIN pack ON 1
  LEFT JOIN file_blobs AS blob ON blob.path_hint = effective_file.path AND blob.content_hash = effective_file.content_hash AND blob.extractor_set = pack.cache_identity
    AND EXISTS (SELECT 1 FROM file_blob_authority AS authority WHERE authority.extractor_set = blob.extractor_set
      AND authority.path_hint = effective_file.path AND authority.content_hash = effective_file.content_hash)
  UNION ALL
  SELECT 'owner', owner.path, owner.content_hash, owner.id, NULL, NULL, NULL, NULL, NULL, NULL, owner.span_json, NULL, NULL
  FROM owners AS owner JOIN files AS effective_file ON effective_file.path = owner.path AND effective_file.content_hash = owner.content_hash
  UNION ALL
  SELECT 'call', call.path, effective_file.content_hash, call.id, NULL, NULL, NULL, NULL, NULL, NULL, call.span_json, call.source_id, call.target_name
  FROM calls AS call JOIN owners AS owner ON owner.id = call.source_id AND owner.path = call.path
  JOIN files AS effective_file ON effective_file.path = owner.path AND effective_file.content_hash = owner.content_hash
  LIMIT ${ROW_LIMIT + 1}`;

export const readCodeGraphNavigationFacts = Effect.fn('codeGraph.readNavigationFacts')(function* (input: {
  readonly databasePath: string;
  readonly result: CodeGraphQueryResult;
  readonly selectors: readonly NavigationFactSelector[];
  readonly acquireRead: Effect.Effect<boolean>;
}) {
  const counters = {
    metadataReads: 0,
    payloadReads: 0,
    payloadRows: 0,
    storedBytes: 0,
    declaredRawBytes: 0,
    decodedBytes: 0,
    metadataRows: 0,
    ownerRows: 0,
    callRows: 0,
    setupStatements: 0,
    freshReadMilliseconds: 0,
    metadataMilliseconds: 0,
    payloadMilliseconds: 0,
  };
  const observation = {
    repository: input.result.repository,
    snapshot: input.result.snapshot,
    freshness: input.result.freshness,
    ...(input.result.projectCoverage === undefined ? {} : {projectCoverage: input.result.projectCoverage}),
  };
  const byPath = new Map<string, NavigationFactFile>();
  const output = (): NavigationFactRead => ({observation, files: [...byPath.values()], counters, gaps: []});
  if (input.selectors.length > OWNER_LIMIT) return {...output(), gaps: ['navigation-selector-budget']};
  if (input.result.nodes.length > OWNER_LIMIT || input.result.edges.length > CALL_LIMIT)
    return {...output(), gaps: ['navigation-anchor-budget']};
  for (const selector of input.selectors) {
    if (!byPath.has(selector.path) && byPath.size === FILE_LIMIT)
      return {...output(), files: [], gaps: ['navigation-selector-budget']};
    const previous = byPath.get(selector.path);
    const admitted =
      HASH.test(selector.contentHash) &&
      selector.path.length > 0 &&
      selector.path.length <= 4096 &&
      !/(?:^|\/)\.\.?\/|^\/|[\0\r\n\\]|(?:^|\/)\.\.?$/u.test(selector.path) &&
      EffectArray.some(
        input.result.nodes,
        node => node.path === selector.path && node.contentHash === selector.contentHash,
      );
    byPath.set(selector.path, {
      ...selector,
      state:
        !admitted ||
        input.result.freshness !== 'current' ||
        (previous !== undefined && previous.contentHash !== selector.contentHash) ||
        previous?.state === 'conflict'
          ? 'conflict'
          : 'unavailable',
      gap: 'navigation-facts-unavailable',
    });
  }
  const selectors = EffectArray.filter([...byPath.values()], file => file.state !== 'conflict');
  if (selectors.length === 0) return output();
  if (!(yield* input.acquireRead)) {
    for (const selector of selectors)
      byPath.set(selector.path, {...selector, state: 'omitted', gap: 'navigation-read-budget-exhausted'});
    return output();
  }
  const owners = [
    ...new Set(EffectArray.flatMap(input.result.nodes, node => (OWNER_ID.test(node.id) ? [node.id] : []))),
  ];
  const calls = [...new Set(EffectArray.flatMap(input.result.edges, edge => (CALL_ID.test(edge.id) ? [edge.id] : [])))];
  const {snapshot, repository} = input.result;
  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe('PRAGMA busy_timeout = 0');
    counters.setupStatements++;
    counters.metadataReads++;
    const started = yield* Clock.currentTimeMillis;
    const rows = yield* sql.unsafe<Metadata>(navigationFactMetadataSql, [
      snapshot.id,
      repository.repositoryId,
      snapshot.worktreeId,
      snapshot.commit,
      snapshot.dirty ? 1 : 0,
      JSON.stringify(selectors),
      JSON.stringify(owners),
      JSON.stringify(calls),
    ]);
    counters.metadataMilliseconds = (yield* Clock.currentTimeMillis) - started;
    counters.metadataRows = rows.length;
    if (rows.length > ROW_LIMIT) {
      for (const selector of selectors)
        byPath.set(selector.path, {...selector, state: 'conflict', gap: 'navigation-ready-closure-overflow'});
      return;
    }
    const readyOwners = EffectArray.filter(rows, row => row.kind === 'owner');
    const readyCalls = EffectArray.filter(rows, row => row.kind === 'call');
    counters.ownerRows = readyOwners.length;
    counters.callRows = readyCalls.length;
    const reservations: Metadata[] = [];
    let stored = 0;
    let raw = 0;
    for (const selector of selectors) {
      const matches = EffectArray.filter(rows, row => row.kind === 'fact' && row.path === selector.path);
      if (matches.length !== 1) continue;
      const row = matches[0];
      if (row.capability !== 1) {
        byPath.set(row.path, {...selector, state: 'unsupported', gap: 'navigation-proof-policy-unsupported'});
        continue;
      }
      if (row.present !== 1) continue;
      if (
        row.stored_bytes > BYTE_LIMIT ||
        row.raw_bytes > BYTE_LIMIT ||
        stored + row.stored_bytes > BYTE_LIMIT ||
        raw + row.raw_bytes > BYTE_LIMIT
      ) {
        byPath.set(row.path, {...selector, state: 'omitted', gap: 'navigation-fact-byte-budget'});
        continue;
      }
      if (
        row.valid !== 1 ||
        !Number.isSafeInteger(row.stored_bytes) ||
        row.stored_bytes <= 0 ||
        !Number.isSafeInteger(row.raw_bytes) ||
        row.raw_bytes <= 0
      ) {
        byPath.set(row.path, {...selector, state: 'conflict', gap: 'navigation-fact-metadata-invalid'});
        continue;
      }
      stored += row.stored_bytes;
      raw += row.raw_bytes;
      reservations.push(row);
    }
    if (reservations.length === 0) return;
    if (!(yield* input.acquireRead)) {
      for (const row of reservations)
        byPath.set(row.path, {
          path: row.path,
          contentHash: row.content_hash,
          state: 'omitted',
          gap: 'navigation-read-budget-exhausted',
        });
      return;
    }
    counters.payloadReads++;
    const payloadStarted = yield* Clock.currentTimeMillis;
    const payloads = yield* sql.unsafe<Metadata & {readonly facts_json: string}>(
      `
      SELECT blob.path_hint AS path, blob.content_hash, blob.facts_json,
        length(CAST(blob.facts_json AS BLOB)) AS stored_bytes, ${declaredRawBytesSql} AS raw_bytes
      FROM json_each(?) AS reservation
      JOIN file_blobs AS blob ON blob.path_hint = json_extract(reservation.value, '$.path') AND blob.content_hash = json_extract(reservation.value, '$.content_hash')
        AND blob.extractor_set = json_extract(reservation.value, '$.cache_identity')
      WHERE length(CAST(blob.facts_json AS BLOB)) = json_extract(reservation.value, '$.stored_bytes')
        AND ${declaredRawBytesSql} = json_extract(reservation.value, '$.raw_bytes')
      LIMIT 3`,
      [JSON.stringify(reservations)],
    );
    counters.payloadMilliseconds = (yield* Clock.currentTimeMillis) - payloadStarted;
    for (const row of payloads) {
      counters.payloadRows++;
      counters.storedBytes += Buffer.byteLength(row.facts_json, 'utf8');
      counters.declaredRawBytes += row.raw_bytes;
      const selector = {path: row.path, contentHash: row.content_hash};
      const decoded = yield* Effect.try(() => {
        const value = decodeStoredCodeGraphFact(row.facts_json, row.path);
        if (
          value.bytes > row.raw_bytes ||
          !EffectArray.every(
            value.facts.symbols,
            symbol => symbol.path === row.path && symbol.contentHash === row.content_hash,
          )
        )
          throw new Error('Fact observation changed.');
        return value;
      }).pipe(Effect.option);
      if (decoded._tag === 'None') {
        byPath.set(row.path, {...selector, state: 'conflict', gap: 'navigation-fact-integrity-conflict'});
        continue;
      }
      counters.decodedBytes += decoded.value.bytes;
      const facts = decoded.value.facts.navigationFacts;
      if (facts === undefined) {
        byPath.set(row.path, {...selector, state: 'unsupported', gap: 'navigation-fact-capability-missing'});
        continue;
      }
      const proofs = EffectArray.filter(facts.proofs, proof => {
        const owners = EffectArray.filter(
          readyOwners,
          owner => owner.id === proof.ownerId && owner.path === row.path && owner.content_hash === row.content_hash,
        );
        const calls = EffectArray.filter(
          readyCalls,
          call => call.id === proof.callEdgeId && call.path === row.path && call.content_hash === row.content_hash,
        );
        return (
          owners.length === 1 &&
          calls.length === 1 &&
          calls[0].source_id === proof.ownerId &&
          calls[0].target_name === proof.local &&
          spanMatches(owners[0].span_json, proof.ownerSpan) &&
          spanMatches(calls[0].span_json, proof.callSpan)
        );
      });
      const complete = proofs.length === facts.proofs.length;
      byPath.set(row.path, {
        ...selector,
        state: complete ? 'available' : 'omitted',
        facts: {...facts, proofs, omitted: facts.omitted || !complete},
        ...(!complete
          ? {gap: 'navigation-ready-closure-missing'}
          : facts.omitted
            ? {gap: 'navigation-fact-collection-omitted'}
            : {}),
      });
    }
  });
  const freshStarted = yield* Clock.currentTimeMillis;
  yield* withFreshCodeGraphReadTransaction(input.databasePath, program).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.ensuring(
      Effect.gen(function* () {
        counters.freshReadMilliseconds = (yield* Clock.currentTimeMillis) - freshStarted;
      }),
    ),
  );
  return output();
});

function spanMatches(json: string, span: CodeGraphSpan): boolean {
  try {
    const value: unknown = JSON.parse(json);
    if (!Predicate.isObject(value)) return false;
    return (
      value.line === span.line &&
      value.column === span.column &&
      value.endLine === span.endLine &&
      value.endColumn === span.endColumn
    );
  } catch {
    return false;
  }
}
