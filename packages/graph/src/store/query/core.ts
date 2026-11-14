import {isLexicalV2Snapshot} from '../lexical_projection.js';
import {compareCodeUnits} from '../../ordering.js';
import {Array as EffectArray} from 'effect';
import {Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  codeGraphBlobExtractionReuseClass,
  codeGraphStoredBlobReuseCacheKey,
  type CodeGraphBlobReuseFile,
} from '../../blob_reuse.js';
import {configureConnection} from '../session.js';
import {CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE} from '../cache/authority.js';
import {CODE_GRAPH_STORED_FACT_CODEC, storedCodeGraphFactRawBytesSql} from '../../fact/storage.js';
import {type CodeGraphProvenance, CodeGraphStoreError} from '../../types.js';
import {sqlTextOption} from '../utilities.js';
import {type CodeGraphSqlQueryStatement} from '../visualization_sql.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

/** Direct-column octet_length/typeof use SQLite record metadata before loading an admitted text payload. */
export const taskBoundedText = (column: string, bytes: number) =>
  `CASE WHEN typeof(${column}) = 'text' AND octet_length(${column}) <= ${bytes} THEN ${column} ELSE NULL END`;

/** All input scalars are bounded first; an exact native JSON guard also covers escaping overhead. */
export function taskTransferBounded(
  statement: CodeGraphSqlQueryStatement,
  columns: readonly string[],
  maximumBytes: number,
): CodeGraphSqlQueryStatement {
  const json = `json_object(${EffectArray.join(
    EffectArray.map(columns, column => `'${column}', ${column}`),
    ', ',
  )})`;
  return {
    parameters: statement.parameters,
    text: `WITH task_rows AS MATERIALIZED (${statement.text}),
    task_sized AS MATERIALIZED (SELECT task_rows.*, length(CAST(${json} AS BLOB)) <= ${maximumBytes - 1024} AS transfer_valid FROM task_rows)
    SELECT ${EffectArray.join(
      EffectArray.map(columns, column => `CASE WHEN transfer_valid THEN ${column} ELSE NULL END AS ${column}`),
      ', ',
    )}, transfer_valid FROM task_sized`,
  };
}

export function taskHeaderStatement(snapshotId: string): CodeGraphSqlQueryStatement {
  const v2 = isLexicalV2Snapshot(snapshotId);
  const fields = ['repository_id', 'worktree_id', 'commit_id', 'base_snapshot_id'];
  const layout = (id: string) => `(SELECT json_object(
    'logicalSnapshotId',${taskBoundedText('view.logical_snapshot_id', 128)},
    'mode',${taskBoundedText('view.layout_mode', 16)},
    'baseSnapshotId',${taskBoundedText('view.base_snapshot_id', 128)},
    'forceGeneration',${taskBoundedText('view.force_generation', 16)},
    'orderRevision',CASE WHEN typeof(view.order_revision)='integer' THEN view.order_revision ELSE NULL END)
    FROM lexical_v2_views view WHERE view.snapshot_id=${id}
      AND (typeof(view.base_snapshot_id)='null' OR ${taskBoundedText('view.base_snapshot_id', 128)} IS NOT NULL)
      AND (typeof(view.force_generation)='null' OR ${taskBoundedText('view.force_generation', 16)} IS NOT NULL)
      LIMIT 1)`;
  const extra = v2
    ? [
        `${layout('snapshots.id')} AS layout_current`,
        `${layout(taskBoundedText('snapshots.base_snapshot_id', 128))} AS layout_base`,
      ]
    : [];
  return taskTransferBounded(
    {
      parameters: [snapshotId],
      text: `SELECT
    ${EffectArray.join(
      EffectArray.map(fields, field => `${taskBoundedText(field, 128)} AS ${field}`),
      ', ',
    )}, dirty,${extra.length ? EffectArray.join(extra, ',') + ',' : ''}
    ${v2 ? '2 * EXISTS (SELECT 1 FROM lexical_v2_formats AS format WHERE format.snapshot_id=snapshots.id AND format.format_version=2)' : 'EXISTS (SELECT 1 FROM lexical_storage_formats AS format WHERE format.snapshot_id=snapshots.id AND format.format_version=1)'} AS compact_current,
    ${v2 ? `2 * EXISTS (SELECT 1 FROM lexical_v2_formats AS format WHERE format.snapshot_id=${taskBoundedText('base_snapshot_id', 128)} AND format.format_version=2)` : `EXISTS (SELECT 1 FROM lexical_storage_formats AS format WHERE format.snapshot_id=${taskBoundedText('base_snapshot_id', 128)} AND format.format_version=1)`} AS compact_base,
    (${EffectArray.join(
      EffectArray.map(fields, field =>
        field === 'base_snapshot_id'
          ? `(typeof(${field}) = 'null' OR ${taskBoundedText(field, 128)} IS NOT NULL)`
          : `${taskBoundedText(field, 128)} IS NOT NULL`,
      ),
      ' AND ',
    )}) AS row_valid
    FROM snapshots WHERE id = ? AND state = 'ready' LIMIT 1`,
    },
    [
      ...fields,
      'dirty',
      'compact_current',
      'compact_base',
      'row_valid',
      ...(v2 ? ['layout_current', 'layout_base'] : []),
    ],
    4096,
  );
}

export function taskNodeStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  ids: readonly string[],
): CodeGraphSqlQueryStatement {
  const marks = EffectArray.join(
    EffectArray.map(ids, () => '?'),
    ', ',
  );
  const required = [
    ['id', 128],
    ['content_hash', 64],
    ['kind', 128],
    ['language', 128],
    ['name', 512],
    ['qualified_name', 1024],
    ['path', 4096],
    ['span_json', 256],
  ] as const;
  const optional = [
    ['package_name', 256],
    ['resolution_domain', 128],
    ['resolution_scope_id', 256],
  ] as const;
  const textFields = [...required, ...optional];
  const arityValid = `(CASE typeof(s.arity) WHEN 'null' THEN 1 WHEN 'integer' THEN s.arity BETWEEN 0 AND 9007199254740991 ELSE 0 END)`;
  const columns = `${EffectArray.join(
    EffectArray.map(textFields, ([column, bytes]) => `${taskBoundedText('s.' + column, bytes)} AS ${column}`),
    ', ',
  )},
    CASE WHEN ${arityValid} THEN s.arity ELSE NULL END AS arity, s.exported, NULL AS signature, NULL AS documentation, '[]' AS lookup_keys_json,
    (${arityValid} AND ${EffectArray.join(
      EffectArray.map(required, ([column, bytes]) => `${taskBoundedText('s.' + column, bytes)} IS NOT NULL`),
      ' AND ',
    )}
      AND ${EffectArray.join(
        EffectArray.map(
          optional,
          ([column, bytes]) => `(typeof(s.${column}) = 'null' OR ${taskBoundedText('s.' + column, bytes)} IS NOT NULL)`,
        ),
        ' AND ',
      )}) AS row_valid`;
  const statement = {
    parameters: [snapshotId, ...ids, baseSnapshotId ?? '', ...ids, snapshotId, snapshotId],
    text: `SELECT ${columns} FROM symbols AS s WHERE s.snapshot_id = ? AND s.id IN (${marks})
    UNION ALL SELECT ${columns} FROM symbols AS s WHERE s.snapshot_id = ? AND s.id IN (${marks})
      AND NOT EXISTS (SELECT 1 FROM symbols AS replacement WHERE replacement.snapshot_id = ? AND replacement.id = s.id)
      AND NOT EXISTS (SELECT 1 FROM snapshot_symbol_deletions AS deletion WHERE deletion.snapshot_id = ? AND deletion.symbol_id = s.id)`,
  };
  return taskTransferBounded(
    statement,
    [
      ...EffectArray.map(textFields, ([column]) => column),
      'arity',
      'exported',
      'signature',
      'documentation',
      'lookup_keys_json',
      'row_valid',
    ],
    32768,
  );
}

/**
 * Task-only compact lane: admit raw keys before optional dictionary mapping or ranking.
 * Legacy REAL weights cannot be inspected using metadata-only Column operations; the
 * charged header capability check reports that contributor unsupported instead.
 */
export function taskPostingStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  terms: readonly string[],
  limit: number,
): CodeGraphSqlQueryStatement {
  if (isLexicalV2Snapshot(snapshotId)) return taskPostingV2Statement(snapshotId, baseSnapshotId, terms, limit);
  const keys = [...new Set(terms)].slice(0, 32);
  const marks = EffectArray.join(
    EffectArray.map(keys, () => '?'),
    ', ',
  );
  const weight = (column: string) =>
    `CASE WHEN typeof(${column}) IN ('integer','real') THEN CASE WHEN ${column} > 0 AND ${column} <= 5 THEN ${column} ELSE NULL END ELSE NULL END`;
  const branches: string[] = [];
  const parameters: (string | number)[] = [];
  for (const id of [snapshotId, baseSnapshotId ?? '']) {
    // No dictionary join here: even missing/mismatched/invalid keys consume the raw LIMIT.
    branches.push(`SELECT ${taskBoundedText('compact.snapshot_id', 128)} AS snapshot_id,
      compact.snapshot_key, CASE WHEN typeof(posting.symbol_key) = 'integer' THEN posting.symbol_key ELSE NULL END AS symbol_key,
      ${taskBoundedText('terms.term', 256)} AS term, ${weight('posting.weight')} AS weight
      FROM lexical_compact_snapshots AS compact
      JOIN lexical_storage_formats AS format ON format.snapshot_id = compact.snapshot_id AND format.format_version = 1
      JOIN lexical_compact_terms AS terms INDEXED BY sqlite_autoindex_lexical_compact_terms_1
        ON terms.snapshot_key = compact.snapshot_key
      CROSS JOIN lexical_compact_postings AS posting
      WHERE compact.snapshot_id = ? AND terms.term IN (${marks || "''"})
        AND posting.snapshot_key = compact.snapshot_key AND posting.term_key = terms.term_key`);
    parameters.push(id, ...keys);
  }
  parameters.push(
    Math.max(0, Math.min(128, Math.floor(limit))),
    snapshotId,
    snapshotId,
    snapshotId,
    snapshotId,
    baseSnapshotId ?? '',
    snapshotId,
    snapshotId,
  );
  return taskTransferBounded(
    {
      parameters,
      text: `WITH raw AS MATERIALIZED (${EffectArray.join(branches, ' UNION ALL ')} LIMIT ?),
    mapped AS MATERIALIZED (
      SELECT raw.snapshot_id, ${taskBoundedText('dictionary.symbol_id', 128)} AS symbol_id,
        raw.term, raw.weight FROM raw LEFT JOIN lexical_compact_symbols AS dictionary
        ON dictionary.symbol_key = raw.symbol_key AND dictionary.snapshot_key = raw.snapshot_key)
    SELECT mapped.symbol_id AS id, mapped.term, mapped.weight,
      ${taskBoundedText('symbol.path', 4096)} AS path,
      ${taskBoundedText('symbol.package_name', 256)} AS package_name,
      ${taskBoundedText('symbol.content_hash', 64)} AS content_hash,
      (mapped.symbol_id IS NOT NULL AND mapped.term IS NOT NULL AND mapped.weight IS NOT NULL
        AND ${taskBoundedText('symbol.path', 4096)} IS NOT NULL AND ${taskBoundedText('symbol.content_hash', 64)} IS NOT NULL
        AND (typeof(symbol.package_name) = 'null' OR ${taskBoundedText('symbol.package_name', 256)} IS NOT NULL)) AS row_valid,
      CASE WHEN ${taskBoundedText('symbol.path', 4096)} IS NOT NULL AND ${taskBoundedText('symbol.content_hash', 64)} IS NOT NULL THEN
      (symbol.id IS NOT NULL AND (mapped.snapshot_id = ? OR
        (NOT EXISTS (SELECT 1 FROM symbols AS replacement WHERE replacement.snapshot_id = ? AND replacement.id = mapped.symbol_id)
         AND NOT EXISTS (SELECT 1 FROM snapshot_symbol_deletions AS deletion WHERE deletion.snapshot_id = ? AND deletion.symbol_id = mapped.symbol_id)))
       AND (EXISTS (SELECT 1 FROM snapshot_files AS file WHERE file.snapshot_id = ? AND file.path = symbol.path AND file.content_hash = symbol.content_hash)
        OR EXISTS (SELECT 1 FROM snapshot_files AS file WHERE file.snapshot_id = ? AND file.path = symbol.path AND file.content_hash = symbol.content_hash
          AND NOT EXISTS (SELECT 1 FROM snapshot_files AS replacement WHERE replacement.snapshot_id = ? AND replacement.path = file.path)
          AND NOT EXISTS (SELECT 1 FROM snapshot_file_deletions AS deletion WHERE deletion.snapshot_id = ? AND deletion.path = file.path))))
      ELSE 0 END AS eligible
    FROM mapped LEFT JOIN symbols AS symbol ON symbol.snapshot_id = mapped.snapshot_id AND symbol.id = mapped.symbol_id`,
    },
    ['id', 'term', 'weight', 'path', 'package_name', 'content_hash', 'row_valid', 'eligible'],
    32768,
  );
}

/** V2 successor enumeration admits only finite integer keys before hydration. */
export function taskPostingV2Statement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  terms: readonly string[],
  limit: number,
): CodeGraphSqlQueryStatement {
  const body = terms.length > 0 && EffectArray.every(terms, term => EffectString.startsWith('~body:v1:')(term));
  const keys = [...new Set(EffectArray.map(terms, term => (body ? EffectString.slice(9)(term) : term)))]
    .sort(compareCodeUnits)
    .slice(0, 32);
  const positions = EffectArray.flatMap([snapshotId, baseSnapshotId ?? ''], (id, contributor) =>
    EffectArray.map(keys, (term, ordinal) => [contributor * 32 + ordinal, id, term] as const),
  );
  const parameters: (string | number)[] = EffectArray.flatMap(positions, position => [...position]);
  const maximum = Math.max(0, Math.min(128, Math.floor(limit)));
  parameters.push(
    maximum,
    snapshotId,
    snapshotId,
    snapshotId,
    snapshotId,
    baseSnapshotId ?? '',
    snapshotId,
    snapshotId,
  );
  const pack = (scope: string, member: string, weight: string) =>
    `printf('%016d%016d%d',${scope},${member},9-(${weight}))`;
  const typed = (column: string) => `typeof(${column})='integer' AND ${column} BETWEEN 0 AND 9007199254740991`;
  const owner = (mask: number) => `(SELECT CASE WHEN ${typed('o.scope_ordinal')} AND ${typed('o.member_ordinal')}
    AND typeof(o.metadata_weight)='integer' AND ${mask === 2 ? 'o.metadata_weight=0' : 'o.metadata_weight BETWEEN 1 AND 5'}
    AND EXISTS(SELECT 1 FROM lexical_v2_members m WHERE m.snapshot_key=p.snapshot_key
      AND m.scope_ordinal=o.scope_ordinal AND m.member_ordinal=o.member_ordinal)
    THEN ${pack('o.scope_ordinal', 'o.member_ordinal', body ? '1' : 'o.metadata_weight')} ELSE '!' END
    FROM lexical_v2_owners o WHERE o.snapshot_key=p.snapshot_key AND o.term_key=p.term_key
    AND o.origin_mask=${mask} AND (o.scope_ordinal,o.member_ordinal)>(c.scope_ordinal,c.member_ordinal)
    ORDER BY o.scope_ordinal,o.member_ordinal LIMIT 1)`;
  const group = (
    strict: boolean,
  ) => `(SELECT CASE WHEN ${typed('g.scope_ordinal')} THEN g.scope_ordinal ELSE '!' END FROM lexical_v2_shared g
    WHERE g.snapshot_key=p.snapshot_key AND g.term_key=p.term_key
      AND g.scope_ordinal${strict ? '>' : '>='}c.scope_ordinal ORDER BY g.scope_ordinal LIMIT 1)`;
  const nextGroup = group(true);
  const currentGroup = group(false);
  const first = (scope: string) => `(SELECT CASE WHEN ${typed('m.scope_ordinal')} AND ${typed('m.member_ordinal')} THEN
    ${pack('m.scope_ordinal', 'm.member_ordinal', '3')} ELSE '!' END FROM lexical_v2_members m
    WHERE m.snapshot_key=p.snapshot_key AND m.scope_ordinal=${scope}
    ORDER BY m.member_ordinal LIMIT 1)`;
  const shared = `(CASE WHEN ${currentGroup} IS NULL THEN NULL
    WHEN ${currentGroup}=c.scope_ordinal THEN COALESCE(
      (SELECT CASE WHEN ${typed('m.scope_ordinal')} AND ${typed('m.member_ordinal')} THEN ${pack('m.scope_ordinal', 'm.member_ordinal', '3')}
        ELSE '!' END FROM lexical_v2_members m WHERE m.snapshot_key=p.snapshot_key
        AND m.scope_ordinal=c.scope_ordinal AND m.member_ordinal>c.member_ordinal
        ORDER BY m.member_ordinal LIMIT 1),
      CASE WHEN NOT EXISTS(SELECT 1 FROM lexical_v2_members m WHERE m.snapshot_key=p.snapshot_key
        AND m.scope_ordinal=c.scope_ordinal) THEN '!'
        WHEN ${nextGroup} IS NULL THEN NULL ELSE COALESCE(${first(nextGroup)},'!') END)
    ELSE COALESCE(${first(currentGroup)},'!') END)`;
  const next = `min(COALESCE(${owner(body ? 2 : 1)},'~'),COALESCE(${owner(3)},'~')${body ? '' : `,COALESCE(${shared},'~')`})`;
  const advance = `(SELECT MIN(position) FROM positions WHERE position>c.position)`;
  const skipContributor = `(SELECT MIN(position) FROM positions WHERE position>=(c.position/32+1)*32)`;
  const raw = `WITH RECURSIVE input(position,snapshot_id,term) AS (VALUES ${
    positions.length
      ? EffectArray.join(
          EffectArray.map(positions, () => '(?,?,?)'),
          ',',
        )
      : "(0,'','')"
  }),
    positions AS MATERIALIZED (
      SELECT input.*,compact.snapshot_key,dictionary.term_key FROM input
      JOIN lexical_compact_snapshots compact ON compact.snapshot_id=input.snapshot_id
      JOIN lexical_v2_formats format ON format.snapshot_id=input.snapshot_id AND format.format_version=2
      JOIN lexical_compact_terms dictionary ON dictionary.snapshot_key=compact.snapshot_key AND dictionary.term=input.term
    ), bounds AS (SELECT ? AS maximum),
    cursor(position,scope_ordinal,member_ordinal,raw_count,steps,selected_position,selected_scope,selected_member,weight,valid) AS (
      SELECT (SELECT MIN(position) FROM positions),-1,-1,0,0,NULL,NULL,NULL,NULL,0
      UNION ALL
      SELECT CASE WHEN seek.value='~' THEN ${advance} WHEN seek.value='!' THEN ${skipContributor} ELSE c.position END,
        CASE WHEN seek.value IN ('~','!') THEN -1 ELSE CAST(substr(seek.value,1,16) AS INTEGER) END,
        CASE WHEN seek.value IN ('~','!') THEN -1 ELSE CAST(substr(seek.value,17,16) AS INTEGER) END,
        c.raw_count+(seek.value<>'~'),c.steps+1,
        CASE WHEN seek.value='~' THEN NULL ELSE c.position END,
        CASE WHEN seek.value IN ('~','!') THEN NULL ELSE CAST(substr(seek.value,1,16) AS INTEGER) END,
        CASE WHEN seek.value IN ('~','!') THEN NULL ELSE CAST(substr(seek.value,17,16) AS INTEGER) END,
        CASE WHEN seek.value IN ('~','!') THEN NULL ELSE 9-CAST(substr(seek.value,33,1) AS INTEGER) END,
        seek.value NOT IN ('~','!')
      FROM cursor c JOIN positions p ON p.position=c.position
      JOIN json_each(json_array(${next})) seek
      WHERE c.raw_count<(SELECT maximum FROM bounds) AND c.steps<192
    ), raw AS MATERIALIZED (
      SELECT p.snapshot_id,p.snapshot_key,c.selected_scope AS scope_ordinal,c.selected_member AS member_ordinal,
        ${body ? "'~body:v1:'||p.term" : 'p.term'} AS term,c.weight,c.valid
      FROM cursor c JOIN positions p ON p.position=c.selected_position
      WHERE c.selected_position IS NOT NULL LIMIT 128
    ), mapped AS MATERIALIZED (
      SELECT raw.snapshot_id,${taskBoundedText('dictionary.symbol_id', 128)} AS symbol_id,raw.term,
        CASE WHEN raw.valid THEN raw.weight ELSE NULL END AS weight
      FROM raw LEFT JOIN lexical_v2_members dictionary ON dictionary.snapshot_key=raw.snapshot_key
        AND dictionary.scope_ordinal=raw.scope_ordinal AND dictionary.member_ordinal=raw.member_ordinal
    )
    SELECT mapped.symbol_id AS id, mapped.term, mapped.weight,
      ${taskBoundedText('symbol.path', 4096)} AS path,
      ${taskBoundedText('symbol.package_name', 256)} AS package_name,
      ${taskBoundedText('symbol.content_hash', 64)} AS content_hash,
      (mapped.symbol_id IS NOT NULL AND mapped.term IS NOT NULL AND mapped.weight IS NOT NULL
        AND ${taskBoundedText('symbol.path', 4096)} IS NOT NULL AND ${taskBoundedText('symbol.content_hash', 64)} IS NOT NULL
        AND (typeof(symbol.package_name) = 'null' OR ${taskBoundedText('symbol.package_name', 256)} IS NOT NULL)) AS row_valid,
      CASE WHEN ${taskBoundedText('symbol.path', 4096)} IS NOT NULL AND ${taskBoundedText('symbol.content_hash', 64)} IS NOT NULL THEN
      (symbol.id IS NOT NULL AND (mapped.snapshot_id = ? OR
        (NOT EXISTS (SELECT 1 FROM symbols AS replacement WHERE replacement.snapshot_id = ? AND replacement.id = mapped.symbol_id)
         AND NOT EXISTS (SELECT 1 FROM snapshot_symbol_deletions AS deletion WHERE deletion.snapshot_id = ? AND deletion.symbol_id = mapped.symbol_id)))
       AND (EXISTS (SELECT 1 FROM snapshot_files AS file WHERE file.snapshot_id = ? AND file.path = symbol.path AND file.content_hash = symbol.content_hash)
        OR EXISTS (SELECT 1 FROM snapshot_files AS file WHERE file.snapshot_id = ? AND file.path = symbol.path AND file.content_hash = symbol.content_hash
          AND NOT EXISTS (SELECT 1 FROM snapshot_files AS replacement WHERE replacement.snapshot_id = ? AND replacement.path = file.path)
          AND NOT EXISTS (SELECT 1 FROM snapshot_file_deletions AS deletion WHERE deletion.snapshot_id = ? AND deletion.path = file.path))))
      ELSE 0 END AS eligible
    FROM mapped LEFT JOIN symbols AS symbol ON symbol.snapshot_id = mapped.snapshot_id AND symbol.id = mapped.symbol_id`;
  return taskTransferBounded(
    {parameters, text: raw},
    ['id', 'term', 'weight', 'path', 'package_name', 'content_hash', 'row_valid', 'eligible'],
    32768,
  );
}

/** Seek relation-keyed adjacency. Even suppressed/unresolved rows consume the one raw edge allowance. */
export function taskExpansionStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  ids: readonly string[],
  limit: number,
): CodeGraphSqlQueryStatement {
  const branches: string[] = [];
  const parameters: (string | number)[] = [];
  const snapshots = baseSnapshotId === undefined ? [snapshotId] : [snapshotId, baseSnapshotId];
  for (const relation of ['calls', 'tests', 'imports', 'exports', 'reexports', 'contains']) {
    for (const axis of ['target_id', 'source_id'] as const) {
      for (const id of ids) {
        for (const [origin, snapshot] of snapshots.entries()) {
          branches.push(`SELECT ${origin} AS origin, ${taskBoundedText('edge.id', 128)} AS id
            FROM edges AS edge INDEXED BY ${axis === 'target_id' ? 'edges_target_resolved' : 'edges_source'}
            WHERE edge.snapshot_id = ? AND edge.${axis} = ? AND edge.${axis} IS NOT NULL AND edge.relation = ?`);
          parameters.push(snapshot, id, relation);
        }
      }
    }
  }
  parameters.push(Math.max(0, Math.min(128, Math.floor(limit))), ...snapshots, snapshotId, snapshotId, snapshotId);
  const originSnapshot = baseSnapshotId === undefined ? '?' : 'CASE raw_keys.origin WHEN 0 THEN ? ELSE ? END';
  // Enum membership reads only the admitted, materialized value, never the persisted payload.
  const provenance = `CASE WHEN raw.provenance IN ('declared','resolved','syntactic','heuristic','model') THEN raw.provenance ELSE NULL END`;
  const admittedColumns = [
    'snapshot_id',
    'id',
    'confidence',
    'relation',
    'source_id',
    'target_id',
    'evidence_path',
    'source_name',
    'target_name',
    'evidence_span_json',
  ];
  return taskTransferBounded(
    {
      parameters,
      text: `WITH raw_keys AS MATERIALIZED (${EffectArray.join(branches, ' UNION ALL ')} LIMIT ?),
    admitted_keys AS MATERIALIZED (SELECT raw_keys.id, ${originSnapshot} AS snapshot_id FROM raw_keys),
    raw AS MATERIALIZED (
      SELECT keys.snapshot_id, keys.id, edge.confidence,
        ${taskBoundedText('edge.provenance', 32)} AS provenance,
        ${taskBoundedText('edge.relation', 128)} AS relation,
        ((typeof(edge.source_id) = 'null' OR ${taskBoundedText('edge.source_id', 128)} IS NOT NULL) AND (typeof(edge.target_id) = 'null' OR ${taskBoundedText('edge.target_id', 128)} IS NOT NULL)) AS scalar_valid,
        ${taskBoundedText('edge.source_id', 128)} AS source_id, ${taskBoundedText('edge.target_id', 128)} AS target_id,
        ${taskBoundedText('edge.evidence_path', 4096)} AS evidence_path,
        ${taskBoundedText('edge.source_name', 128)} AS source_name, ${taskBoundedText('edge.target_name', 128)} AS target_name,
        ${taskBoundedText('edge.evidence_span_json', 256)} AS evidence_span_json
      FROM admitted_keys AS keys LEFT JOIN edges AS edge ON edge.snapshot_id = keys.snapshot_id AND edge.id = keys.id)
    SELECT ${EffectArray.join(
      EffectArray.map(admittedColumns, column => 'raw.' + column),
      ', ',
    )}, ${provenance} AS provenance, (raw.scalar_valid = 1 AND raw.id IS NOT NULL AND (${provenance}) IS NOT NULL AND raw.source_name IS NOT NULL AND raw.target_name IS NOT NULL AND raw.evidence_path IS NOT NULL AND raw.evidence_span_json IS NOT NULL) AS row_valid, (raw.snapshot_id = ? OR
      (NOT EXISTS (SELECT 1 FROM edges AS replacement WHERE replacement.snapshot_id = ? AND replacement.id = raw.id)
       AND NOT EXISTS (SELECT 1 FROM snapshot_edge_deletions AS deletion WHERE deletion.snapshot_id = ? AND deletion.edge_id = raw.id))) AS eligible
    FROM raw`,
    },
    [
      'snapshot_id',
      'id',
      'confidence',
      'provenance',
      'relation',
      'source_id',
      'target_id',
      'evidence_path',
      'source_name',
      'target_name',
      'evidence_span_json',
      'row_valid',
      'eligible',
    ],
    32768,
  );
}

function selectFileBlobMetadataBatch(
  sql: SqlClient.SqlClient,
  files: readonly CodeGraphBlobReuseFile[],
  extractorSet: string,
) {
  if (files.length === 0) {
    return Effect.succeed([] as readonly {readonly facts_bytes: number; readonly path_hint: string}[]);
  }
  return sql.unsafe<{readonly facts_bytes: number; readonly path_hint: string}>(
    `SELECT path_hint, ${storedCodeGraphFactRawBytesSql('facts_json')} AS facts_bytes
     FROM file_blobs
     WHERE extractor_set = ?
       AND (${EffectArray.join(
         EffectArray.map(files, () => '(content_hash = ? AND path_hint = ?)'),
         ' OR ',
       )})`,
    [extractorSet, ...EffectArray.flatMap(files, file => [file.contentHash, file.path])],
  );
}

interface ReusableFileBlobRow {
  readonly facts_bytes: number;
  readonly facts_json: string;
  readonly path_hint: string;
  readonly target_path: string;
}

function selectReusableFileBlobMetadataBatch(
  sql: SqlClient.SqlClient,
  files: readonly CodeGraphBlobReuseFile[],
  extractorSet: string,
) {
  const targets = reusableFileBlobTargets(files);
  if (targets.length === 0) {
    return Effect.succeed([] as readonly Pick<ReusableFileBlobRow, 'facts_bytes' | 'target_path'>[]);
  }
  return sql.unsafe<Pick<ReusableFileBlobRow, 'facts_bytes' | 'target_path'>>(
    `${reusableFileBlobTargetCte(targets)}
     SELECT requested.target_path,
            CASE
              WHEN json_extract(blob.facts_json, '$.codec') = '${CODE_GRAPH_STORED_FACT_CODEC}'
              THEN MAX(
                ${storedCodeGraphFactRawBytesSql('blob.facts_json')},
                ${storedCodeGraphFactRawBytesSql('blob.facts_json')} +
                  CAST(json_extract(blob.facts_json, '$.pathOccurrences') AS INTEGER) *
                  (length(CAST(substr(json_quote(requested.target_path), 2,
                    length(json_quote(requested.target_path)) - 2) AS BLOB)) -
                   length(CAST(substr(json_quote(blob.path_hint), 2,
                    length(json_quote(blob.path_hint)) - 2) AS BLOB)))
              )
              ELSE MAX(
                length(CAST(blob.facts_json AS BLOB)),
                length(CAST(replace(
                  blob.facts_json,
                  substr(json_quote(blob.path_hint), 2, length(json_quote(blob.path_hint)) - 2),
                  substr(json_quote(requested.target_path), 2, length(json_quote(requested.target_path)) - 2)
                ) AS BLOB))
              )
            END AS facts_bytes
     FROM requested
     JOIN file_blobs AS blob ON ${reusableFileBlobJoin('blob')}
     WHERE blob.extractor_set = ?
       AND blob.path_hint <> requested.target_path
       AND json_valid(blob.facts_json)
       AND json_extract(blob.facts_json, '$.path') = blob.path_hint
       AND blob.path_hint = (${reusableFileBlobFirstDonorSubquery()})`,
    [...reusableFileBlobTargetParameters(targets), extractorSet],
  );
}

function selectReusableFileBlobBatch(
  sql: SqlClient.SqlClient,
  files: readonly CodeGraphBlobReuseFile[],
  extractorSet: string,
) {
  const targets = reusableFileBlobTargets(files);
  if (targets.length === 0) return Effect.succeed([] as readonly ReusableFileBlobRow[]);
  return sql.unsafe<ReusableFileBlobRow>(
    `${reusableFileBlobTargetCte(targets)}
     SELECT requested.target_path, blob.path_hint, blob.facts_json,
            ${storedCodeGraphFactRawBytesSql('blob.facts_json')} AS facts_bytes
     FROM requested
     JOIN file_blobs AS blob ON ${reusableFileBlobJoin('blob')}
     WHERE blob.extractor_set = ?
       AND blob.path_hint <> requested.target_path
       AND json_valid(blob.facts_json)
       AND json_extract(blob.facts_json, '$.path') = blob.path_hint
       AND blob.path_hint = (${reusableFileBlobFirstDonorSubquery()})`,
    [...reusableFileBlobTargetParameters(targets), extractorSet],
  );
}

interface ReusableFileBlobTarget {
  readonly blobId: string;
  readonly contentHash: string;
  readonly language: string;
  readonly path: string;
  readonly reuseClass: string;
}

function reusableFileBlobTargets(files: readonly CodeGraphBlobReuseFile[]): readonly ReusableFileBlobTarget[] {
  return EffectArray.flatMap(files, file => {
    const reuseClass = codeGraphBlobExtractionReuseClass(file);
    return reuseClass === undefined
      ? []
      : [
          {
            blobId: file.blobId!,
            contentHash: file.contentHash,
            language: file.language!,
            path: file.path,
            reuseClass,
          },
        ];
  });
}

function reusableFileBlobTargetCte(targets: readonly ReusableFileBlobTarget[]): string {
  return `WITH requested(target_path, content_hash, blob_id, reuse_class) AS (
    VALUES ${EffectArray.join(
      EffectArray.map(targets, () => '(?, ?, ?, ?)'),
      ', ',
    )}
  )`;
}

function reusableFileBlobTargetParameters(targets: readonly ReusableFileBlobTarget[]): readonly string[] {
  return EffectArray.flatMap(targets, target => [target.path, target.contentHash, target.blobId, target.reuseClass]);
}

function reusableFileBlobJoin(alias: string): string {
  return `${alias}.blob_id = requested.blob_id
    AND ${alias}.content_hash = requested.content_hash
    AND ${alias}.reuse_class = requested.reuse_class`;
}

function reusableFileBlobFirstDonorSubquery(): string {
  return `SELECT MIN(donor.path_hint)
    FROM file_blobs AS donor
    WHERE ${reusableFileBlobJoin('donor')}
      AND donor.extractor_set = blob.extractor_set
      AND donor.path_hint <> requested.target_path
      AND json_valid(donor.facts_json)
      AND json_extract(donor.facts_json, '$.path') = donor.path_hint`;
}

export function codeGraphCachedCommittedFileKeysStatement(
  extractorSet: string,
  files?: readonly {readonly contentHash: string; readonly path: string}[],
): CodeGraphSqlQueryStatement {
  const targetPredicate =
    files === undefined
      ? ''
      : files.length === 0
        ? ' AND 0'
        : ` AND (${EffectArray.join(
            EffectArray.map(files, () => '(path_hint = ? AND content_hash = ?)'),
            ' OR ',
          )})`;
  return {
    parameters: [
      extractorSet,
      ...(Option.getOrUndefined(
        Option.map(Option.fromNullishOr(files), effectFlatMapValues =>
          EffectArray.flatMap(effectFlatMapValues, (file, effectFlatMapIndex) =>
            effectFlatMapIndex in effectFlatMapValues ? [file.path, file.contentHash] : [],
          ),
        ),
      ) ?? []),
    ],
    text: `SELECT
      CASE
        WHEN typeof(blob_id) = 'text' AND length(CAST(blob_id AS BLOB)) IN (40, 64) THEN blob_id
        ELSE NULL
      END AS blob_id,
      content_hash,
      path_hint,
      CASE
        WHEN typeof(reuse_class) = 'text' AND length(CAST(reuse_class AS BLOB)) <= 128 THEN reuse_class
        ELSE NULL
      END AS reuse_class
    FROM ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE}
    WHERE extractor_set = ?${targetPredicate}`,
  };
}

const selectCachedCommittedFileKeys = Effect.fn('codeGraph.selectCachedCommittedFileKeys')(function* (
  extractorSet: string,
  files?: readonly {readonly contentHash: string; readonly path: string}[],
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const statement = codeGraphCachedCommittedFileKeysStatement(extractorSet, files);
  const rows = yield* sql.unsafe<{
    readonly blob_id: unknown;
    readonly content_hash: string;
    readonly path_hint: string;
    readonly reuse_class: unknown;
  }>(statement.text, statement.parameters);
  const keys = new Set(EffectArray.map(rows, row => `${row.path_hint}\0${row.content_hash}\0${extractorSet}`));
  for (const row of rows) {
    if (
      typeof row.blob_id !== 'string' ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(row.blob_id) ||
      typeof row.reuse_class !== 'string' ||
      !/^structured-object-v1:(?:json|jsonc|yaml):full$/u.test(row.reuse_class)
    ) {
      continue;
    }
    keys.add(codeGraphStoredBlobReuseCacheKey(row.blob_id, row.content_hash, extractorSet, row.reuse_class));
  }
  return keys;
});

function effectiveSymbolsCte(): string {
  return `WITH effective_symbols AS (
    SELECT current_symbols.*
    FROM symbols AS current_symbols
    WHERE current_symbols.snapshot_id = ?
    UNION ALL
    SELECT base_symbols.*
    FROM symbols AS base_symbols
    WHERE base_symbols.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM symbols AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_symbol_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
      )
  )`;
}

function effectiveEdgesCte(): string {
  return `WITH effective_edges AS (
    SELECT current_edges.*
    FROM edges AS current_edges
    WHERE current_edges.snapshot_id = ?
    UNION ALL
    SELECT base_edges.*
    FROM edges AS base_edges
    WHERE base_edges.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM edges AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_edge_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
      )
  )`;
}

function effectiveGraphCtes(): string {
  return `WITH effective_symbols AS (
    SELECT current_symbols.*
    FROM symbols AS current_symbols
    WHERE current_symbols.snapshot_id = ?
    UNION ALL
    SELECT base_symbols.*
    FROM symbols AS base_symbols
    WHERE base_symbols.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM symbols AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_symbol_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
      )
  ), effective_edges AS (
    SELECT current_edges.*
    FROM edges AS current_edges
    WHERE current_edges.snapshot_id = ?
    UNION ALL
    SELECT base_edges.*
    FROM edges AS base_edges
    WHERE base_edges.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM edges AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_edge_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
      )
  )`;
}

function effectiveGraphParameters(snapshotId: string, baseSnapshotId: string | undefined): readonly string[] {
  return [
    ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
    ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  ];
}

function effectiveSnapshotParameters(snapshotId: string, baseSnapshotId: string | undefined): readonly string[] {
  return [snapshotId, baseSnapshotId ?? '', snapshotId, snapshotId];
}

const selectBaseSnapshotId = Effect.fn('codeGraph.selectBaseSnapshotId')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  const rows = yield* sql<{readonly base_snapshot_id: unknown}>`
    SELECT base_snapshot_id FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
  `;
  if (!rows[0]) return yield* CodeGraphStoreError.of(`Ready snapshot ${snapshotId} was not found.`);
  return Option.getOrUndefined(sqlTextOption(rows[0].base_snapshot_id));
});

const EXACT_SYMBOL_FIELDS = [
  {column: 'name', index: 'symbols_name_nocase', insensitiveRank: 4, sensitiveRank: 6},
  {column: 'qualified_name', index: 'symbols_qualified_nocase', insensitiveRank: 3, sensitiveRank: 5},
  {column: 'path', index: 'symbols_path_nocase', insensitiveRank: 1, sensitiveRank: 2},
] as const;

/**
 * Build exact-match candidates with the equality predicate inside every
 * current/base branch. Keeping the predicate outside effectiveSymbolsCte()
 * makes SQLite scan every symbol in a large snapshot before applying LIMIT.
 */
export function codeGraphExactSymbolQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  query: string,
  limit: number,
): CodeGraphSqlQueryStatement {
  const branches: string[] = [];
  const parameters: Array<number | string> = [];
  for (const field of EXACT_SYMBOL_FIELDS) {
    branches.push(`SELECT current_symbols.*,
        CASE WHEN current_symbols.${field.column} = ? THEN ${field.sensitiveRank} ELSE ${field.insensitiveRank} END AS exact_rank
      FROM symbols AS current_symbols INDEXED BY ${field.index}
      WHERE current_symbols.snapshot_id = ?
        AND current_symbols.${field.column} = ? COLLATE NOCASE`);
    parameters.push(query, snapshotId, query);
    branches.push(`SELECT base_symbols.*,
        CASE WHEN base_symbols.${field.column} = ? THEN ${field.sensitiveRank} ELSE ${field.insensitiveRank} END AS exact_rank
      FROM symbols AS base_symbols INDEXED BY ${field.index}
      WHERE base_symbols.snapshot_id = ?
        AND base_symbols.${field.column} = ? COLLATE NOCASE
        AND NOT EXISTS (
          SELECT 1 FROM symbols AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_symbol_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
        )`);
    parameters.push(query, baseSnapshotId ?? '', query, snapshotId, snapshotId);
  }
  parameters.push(Math.max(1, Math.min(500, Math.floor(limit))));
  return {
    parameters,
    text: `WITH exact_candidates AS (
        ${EffectArray.join(branches, '\n        UNION ALL\n        ')}
      ),
      ranked_exact_symbols AS (
        SELECT exact_candidates.*,
          ROW_NUMBER() OVER (PARTITION BY id ORDER BY exact_rank DESC) AS exact_row
        FROM exact_candidates
      )
      SELECT ranked_exact_symbols.*,
        CASE exact_rank
          WHEN 6 THEN 100 WHEN 5 THEN 99 WHEN 4 THEN 98
          WHEN 3 THEN 97 WHEN 2 THEN 90 ELSE 89
        END AS score
      FROM ranked_exact_symbols
      WHERE exact_row = 1
      ORDER BY exact_rank DESC, exported DESC,
        CASE kind
          WHEN 'class' THEN 0 WHEN 'interface' THEN 1 WHEN 'protocol' THEN 2
          WHEN 'struct' THEN 3 WHEN 'enum' THEN 4 WHEN 'type_alias' THEN 5
          WHEN 'function' THEN 6 WHEN 'method' THEN 7 WHEN 'constructor' THEN 8
          WHEN 'module' THEN 9 WHEN 'package' THEN 10 WHEN 'field' THEN 11
          WHEN 'property' THEN 12 ELSE 13
        END,
        name, path, id
      LIMIT ?`,
  };
}

function legacyLexicalTermBranch(alias: string, placeholders: string, base: boolean): string {
  const suppression = base
    ? `AND NOT EXISTS (
         SELECT 1 FROM symbols AS overrides
         WHERE overrides.snapshot_id = ? AND overrides.id = ${alias}.symbol_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM snapshot_symbol_deletions AS deletions
         WHERE deletions.snapshot_id = ? AND deletions.symbol_id = ${alias}.symbol_id
       )`
    : '';
  const termPredicate = placeholders.length === 0 ? '' : `AND ${alias}.term IN (${placeholders})`;
  return `SELECT ${alias}.term, ${alias}.symbol_id, ${alias}.weight
    FROM symbol_terms AS ${alias} INDEXED BY sqlite_autoindex_symbol_terms_1
    WHERE ${alias}.snapshot_id = ?
      ${termPredicate}
      AND NOT EXISTS (
        SELECT 1 FROM lexical_storage_formats AS storage
        WHERE storage.snapshot_id = ${alias}.snapshot_id
      )
      ${suppression}`;
}

export type CodeGraphSymbolPathClass = 'documentation' | 'implementation' | 'test';

/**
 * Product names such as MCP tool identifiers appear verbatim in test fixtures
 * and agent-instruction documents as well as in the code that implements them.
 * Those copies match a bare symbol query just as strongly, so they are demoted
 * unless the query itself asks for a test or a document.
 */
const SYMBOL_PATH_CLASS_SCORE_MULTIPLIERS: Readonly<Record<CodeGraphSymbolPathClass, number>> = {
  documentation: 0.55,
  implementation: 1,
  test: 0.7,
};

const DOCUMENTATION_PATH_DIRECTORIES = new Set(['doc', 'docs', 'documentation']);

const DOCUMENTATION_PATH_EXTENSIONS = new Set(['.adoc', '.markdown', '.md', '.mdx', '.rst', '.txt']);

const TEST_PATH_DIRECTORIES = new Set([
  '__mocks__',
  '__tests__',
  'fixtures',
  'spec',
  'specs',
  'test',
  'testdata',
  'tests',
]);

const DOCUMENTATION_QUERY_TERMS = new Set([
  'adoc',
  'doc',
  'docs',
  'documentation',
  'guide',
  'markdown',
  'md',
  'mdx',
  'readme',
  'rst',
]);

const TEST_QUERY_TERMS = new Set([
  '__mocks__',
  '__tests__',
  'fixture',
  'fixtures',
  'mock',
  'mocks',
  'spec',
  'specs',
  'test',
  'testdata',
  'tests',
]);

const SIDE_EFFECT_OWNER_KINDS = new Set(['constructor', 'function', 'method']);

const SIDE_EFFECT_OWNER_TERMS = new Set([
  'activate',
  'apply',
  'clear',
  'close',
  'delete',
  'dismiss',
  'erase',
  'invalidate',
  'logout',
  'perform',
  'purge',
  'remove',
  'reset',
  'revoke',
  'save',
  'sync',
  'terminate',
  'update',
  'wipe',
]);

const TEST_FILE_NAME_PATTERN = /(?:^|[._-])(?:spec|test)s?\.[^.]+$/;

export function codeGraphSymbolPathClass(path: string): CodeGraphSymbolPathClass {
  const segments = EffectArray.filter(
    Effect2.pipe(path, EffectString.replaceAll('\\', '/'), EffectString.toLowerCase, EffectString.split('/')),
    Boolean,
  );
  const fileName = segments.at(-1) ?? '';
  const directories = segments.slice(0, -1);
  const extensionIndex = Effect2.pipe(
    fileName,
    EffectString.lastIndexOf('.'),
    Effect2.Option.getOrElse(() => -1),
  );
  const extension = extensionIndex === -1 ? '' : Effect2.pipe(fileName, EffectString.slice(extensionIndex));
  if (
    DOCUMENTATION_PATH_EXTENSIONS.has(extension) ||
    EffectArray.some(directories, segment => DOCUMENTATION_PATH_DIRECTORIES.has(segment))
  ) {
    return 'documentation';
  }
  if (
    EffectArray.some(directories, segment => TEST_PATH_DIRECTORIES.has(segment)) ||
    TEST_FILE_NAME_PATTERN.test(fileName)
  ) {
    return 'test';
  }
  return 'implementation';
}

export function codeGraphSymbolPathScoreMultiplier(path: string, queryTerms: readonly string[]): number {
  const pathClass = codeGraphSymbolPathClass(path);
  if (pathClass === 'implementation') return 1;
  const requestedTerms = pathClass === 'test' ? TEST_QUERY_TERMS : DOCUMENTATION_QUERY_TERMS;
  return EffectArray.some(queryTerms, term => requestedTerms.has(term))
    ? 1
    : SYMBOL_PATH_CLASS_SCORE_MULTIPLIERS[pathClass];
}

/** Prefer production methods that own a mutation or lifecycle transition over lexical copies of that behavior. */
export function codeGraphSymbolSearchScoreMultiplier(
  path: string,
  kind: string,
  name: string,
  queryTerms: readonly string[],
): number {
  const pathMultiplier = codeGraphSymbolPathScoreMultiplier(path, queryTerms);
  if (
    codeGraphSymbolPathClass(path) !== 'implementation' ||
    EffectArray.some(queryTerms, term => TEST_QUERY_TERMS.has(term) || DOCUMENTATION_QUERY_TERMS.has(term)) ||
    !SIDE_EFFECT_OWNER_KINDS.has(kind)
  ) {
    return pathMultiplier;
  }
  const nameTerms = EffectArray.filter(
    Effect2.pipe(
      name,
      EffectString.replace(/([a-z0-9])([A-Z])/gu, '$1 $2'),
      EffectString.toLowerCase,
      EffectString.split(/[^a-z0-9]+/gu),
    ),
    Boolean,
  );
  return EffectArray.some(nameTerms, term => SIDE_EFFECT_OWNER_TERMS.has(term))
    ? pathMultiplier * 1.12
    : pathMultiplier;
}

function searchSymbolKindOrder(kind: string): number {
  switch (kind) {
    case 'class':
      return 0;
    case 'interface':
      return 1;
    case 'protocol':
      return 2;
    case 'struct':
      return 3;
    case 'enum':
      return 4;
    case 'type_alias':
      return 5;
    case 'function':
      return 6;
    case 'method':
      return 7;
    case 'constructor':
      return 8;
    case 'module':
      return 9;
    case 'package':
      return 10;
    case 'field':
      return 11;
    case 'property':
      return 12;
    default:
      return 13;
  }
}

export function codeGraphSymbolsByIdsQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  ids: readonly string[],
): CodeGraphSqlQueryStatement {
  const uniqueIds = [...new Set(ids)].slice(0, 400);
  const placeholders = EffectArray.join(
    EffectArray.map(uniqueIds, () => '?'),
    ', ',
  );
  return {
    parameters: [snapshotId, ...uniqueIds, baseSnapshotId ?? '', ...uniqueIds, snapshotId, snapshotId],
    text: `WITH matching_symbols AS (
      SELECT current_symbols.*
      FROM symbols AS current_symbols INDEXED BY sqlite_autoindex_symbols_1
      WHERE current_symbols.snapshot_id = ?
        AND current_symbols.id IN (${placeholders})
      UNION ALL
      SELECT base_symbols.*
      FROM symbols AS base_symbols INDEXED BY sqlite_autoindex_symbols_1
      WHERE base_symbols.snapshot_id = ?
        AND base_symbols.id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM symbols AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_symbol_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
        )
    )
    SELECT * FROM matching_symbols
    ORDER BY path, qualified_name, id`,
  };
}

export function isCanonicalAbsoluteBazelLabel(value: string): boolean {
  return /^(?:@@?[^/\\\s:]+)?\/\/[^\\\s:]*:[^\\\s:]+$/u.test(value);
}

function normalizeExactSearchPath(value: string): string | undefined {
  const trimmed = Effect2.pipe(value, EffectString.trim);
  if (isCanonicalAbsoluteBazelLabel(trimmed)) return undefined;
  const normalized = Effect2.pipe(
    trimmed,
    EffectString.replaceAll('\\', '/'),
    EffectString.replace(/^\.\/+/, ''),
    EffectString.replace(/\/{2,}/g, '/'),
  );
  return Effect2.pipe(normalized, EffectString.includes('/')) ? normalized : undefined;
}

function effectiveAdjacentEdgesCte(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  allowedProvenances: readonly CodeGraphProvenance[],
  branchLimit?: number,
  projection: 'full' | 'traversal' = 'full',
): CodeGraphSqlQueryStatement {
  const ids = [...new Set(nodeIds)].slice(0, 500);
  const provenances = [...new Set(allowedProvenances)];
  const idPlaceholders = EffectArray.join(
    EffectArray.map(ids, () => '?'),
    ', ',
  );
  const provenancePlaceholders = EffectArray.join(
    EffectArray.map(provenances, () => '?'),
    ', ',
  );
  const axes =
    direction === 'incoming'
      ? ([{column: 'target_id', index: 'edges_target_resolved'}] as const)
      : direction === 'outgoing'
        ? ([{column: 'source_id', index: 'edges_source'}] as const)
        : ([
            {column: 'source_id', index: 'edges_source'},
            {column: 'target_id', index: 'edges_target_resolved'},
          ] as const);
  const branches: string[] = [];
  const parameters: Array<number | string> = [];
  const boundedBranchLimit =
    branchLimit === undefined ? undefined : Math.max(1, Math.min(5_000, Math.floor(branchLimit)));
  const columns = (alias: string) =>
    projection === 'full'
      ? `${alias}.*`
      : EffectArray.join(
          EffectArray.map(
            ['id', 'source_id', 'target_id', 'relation', 'provenance', 'confidence', 'source_name', 'target_name'],
            column => `${alias}.${column}`,
          ),
          ', ',
        );
  for (const axis of axes) {
    const currentBranch = `SELECT ${columns('current_edges')}
      FROM edges AS current_edges INDEXED BY ${axis.index}
      WHERE current_edges.snapshot_id = ?
        AND current_edges.${axis.column} IN (${idPlaceholders})
        AND current_edges.${axis.column} IS NOT NULL
        AND current_edges.provenance IN (${provenancePlaceholders})`;
    branches.push(
      boundedBranchLimit === undefined
        ? currentBranch
        : `SELECT * FROM (${currentBranch}
          ORDER BY ${edgePriorityOrder('current_edges')}
          LIMIT ?)`,
    );
    parameters.push(snapshotId, ...ids, ...provenances);
    if (boundedBranchLimit !== undefined) parameters.push(boundedBranchLimit);
    const baseBranch = `SELECT ${columns('base_edges')}
      FROM edges AS base_edges INDEXED BY ${axis.index}
      WHERE base_edges.snapshot_id = ?
        AND base_edges.${axis.column} IN (${idPlaceholders})
        AND base_edges.${axis.column} IS NOT NULL
        AND base_edges.provenance IN (${provenancePlaceholders})
        AND NOT EXISTS (
          SELECT 1 FROM edges AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_edge_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
        )`;
    branches.push(
      boundedBranchLimit === undefined
        ? baseBranch
        : `SELECT * FROM (${baseBranch}
          ORDER BY ${edgePriorityOrder('base_edges')}
          LIMIT ?)`,
    );
    parameters.push(baseSnapshotId ?? '', ...ids, ...provenances, snapshotId, snapshotId);
    if (boundedBranchLimit !== undefined) parameters.push(boundedBranchLimit);
  }
  return {
    parameters,
    // UNION (rather than UNION ALL) is needed only for `both`: a self-loop is
    // found through both directional indexes but remains one logical edge.
    text: `WITH adjacent_edges AS (
      ${EffectArray.join(branches, direction === 'both' ? '\n      UNION\n      ' : '\n      UNION ALL\n      ')}
    )`,
  };
}

function edgePriorityOrder(alias: string): string {
  return `CASE WHEN ${alias}.source_id IS NULL OR ${alias}.target_id IS NULL THEN 1 ELSE 0 END,
    CASE ${alias}.provenance WHEN 'heuristic' THEN 1 WHEN 'model' THEN 1 ELSE 0 END,
    CASE ${alias}.relation
      WHEN 'exports' THEN 0
      WHEN 'imports' THEN 0
      WHEN 'reexports' THEN 0
      WHEN 'tests' THEN 0
      ELSE 1
    END,
    CASE ${alias}.provenance WHEN 'declared' THEN 0 WHEN 'resolved' THEN 1 WHEN 'syntactic' THEN 2 ELSE 3 END,
    ${alias}.confidence DESC, ${alias}.source_name, ${alias}.relation, ${alias}.target_name, ${alias}.id`;
}

/** Build bounded adjacency SQL whose branches seek the directional indexes. */
export function codeGraphAdjacencyQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
): CodeGraphSqlQueryStatement {
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
  const adjacent = effectiveAdjacentEdgesCte(
    snapshotId,
    baseSnapshotId,
    nodeIds,
    direction,
    allowedProvenances,
    safeLimit,
  );
  return {
    parameters: [...adjacent.parameters, safeLimit],
    text: `${adjacent.text}
      SELECT * FROM adjacent_edges
      ORDER BY ${edgePriorityOrder('adjacent_edges')}
      LIMIT ?`,
  };
}

export function codeGraphDirectEdgeQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  sourceId: string,
  targetId: string,
  allowedProvenances: readonly CodeGraphProvenance[],
): CodeGraphSqlQueryStatement {
  const provenances = [...new Set(allowedProvenances)];
  const placeholders = EffectArray.join(
    EffectArray.map(provenances, () => '?'),
    ', ',
  );
  return {
    parameters: [
      snapshotId,
      sourceId,
      targetId,
      ...provenances,
      baseSnapshotId ?? '',
      sourceId,
      targetId,
      ...provenances,
      snapshotId,
      snapshotId,
    ],
    text: `WITH direct_edges AS (
      SELECT current_edges.*
      FROM edges AS current_edges INDEXED BY edges_endpoints
      WHERE current_edges.snapshot_id = ?
        AND current_edges.source_id = ?
        AND current_edges.target_id = ?
        AND current_edges.provenance IN (${placeholders})
      UNION ALL
      SELECT base_edges.*
      FROM edges AS base_edges INDEXED BY edges_endpoints
      WHERE base_edges.snapshot_id = ?
        AND base_edges.source_id = ?
        AND base_edges.target_id = ?
        AND base_edges.provenance IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM edges AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_edge_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
        )
    )
    SELECT * FROM direct_edges
    ORDER BY ${edgePriorityOrder('direct_edges')}
    LIMIT 1`,
  };
}

export {
  selectBaseSnapshotId,
  effectiveSnapshotParameters,
  effectiveSymbolsCte,
  ReusableFileBlobTarget,
  reusableFileBlobTargets,
  reusableFileBlobJoin,
  ReusableFileBlobRow,
  reusableFileBlobTargetCte,
  reusableFileBlobTargetParameters,
  reusableFileBlobFirstDonorSubquery,
  effectiveEdgesCte,
  legacyLexicalTermBranch,
  selectFileBlobMetadataBatch,
  selectReusableFileBlobMetadataBatch,
  selectReusableFileBlobBatch,
  effectiveGraphCtes,
  effectiveGraphParameters,
  EXACT_SYMBOL_FIELDS,
  SYMBOL_PATH_CLASS_SCORE_MULTIPLIERS,
  DOCUMENTATION_PATH_DIRECTORIES,
  DOCUMENTATION_PATH_EXTENSIONS,
  TEST_PATH_DIRECTORIES,
  DOCUMENTATION_QUERY_TERMS,
  TEST_QUERY_TERMS,
  SIDE_EFFECT_OWNER_KINDS,
  SIDE_EFFECT_OWNER_TERMS,
  TEST_FILE_NAME_PATTERN,
  searchSymbolKindOrder,
  normalizeExactSearchPath,
  edgePriorityOrder,
  effectiveAdjacentEdgesCte,
  selectCachedCommittedFileKeys,
};
