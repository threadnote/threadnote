import {Array as EffectArray} from 'effect';
import {DateTime, Effect, Predicate} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import type {ProjectResolutionLookupKey} from '../../incremental/closure.js';
import {tableExists} from '../session.js';
import type {
  CodeGraphResolutionCandidateIndexState,
  ProjectResolutionCandidateIndex,
  ProjectResolutionCandidateIndexMatches,
  ProjectResolutionReexportKeys,
} from './candidate_closure.js';

/**
 * Persisted reverse resolver evidence for one snapshot under one exact
 * attribution context. The receipt row is written in the same transaction as
 * its runs and paths, so a reader that finds, in one read transaction, a
 * receipt with the expected context fingerprint and a ready owner reads
 * complete evidence. Retired-snapshot cleanup deletes runs, paths and then the
 * receipt across separately committed pages, so a retired owner's receipt
 * certifies nothing. Runs are sorted fingerprint
 * blocks: a lookup reads only the blocks that can hold the requested
 * fingerprints instead of the repository's cached facts.
 */
export const CODE_GRAPH_RESOLUTION_CANDIDATE_INDEX_FORMAT_VERSION = 1;
const REFERENCE_RUN = 0;
const SYMBOL_RUN = 1;
type RunKind = typeof REFERENCE_RUN | typeof SYMBOL_RUN;
const ENTRY_BYTES: Record<RunKind, number> = {[REFERENCE_RUN]: 12, [SYMBOL_RUN]: 8};
const RUN_ENTRIES = 2_048;
const INSERT_ROWS = 256;
const SELECT_PARAMETERS = 500;
/** Run keys drop the low fingerprint bits so SQLite returns them as safe JavaScript integers. */
const RUN_KEY_SHIFT = 12n;

export const CODE_GRAPH_RESOLUTION_CANDIDATE_INDEX_TABLE = 'snapshot_resolution_candidate_indexes';
export const CODE_GRAPH_RESOLUTION_CANDIDATE_PATHS_TABLE = 'snapshot_resolution_candidate_paths';
export const CODE_GRAPH_RESOLUTION_CANDIDATE_RUNS_TABLE = 'snapshot_resolution_candidate_runs';

export const CODE_GRAPH_RESOLUTION_CANDIDATE_INDEX_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS ${CODE_GRAPH_RESOLUTION_CANDIDATE_INDEX_TABLE} (
    snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    format_version INTEGER NOT NULL CHECK (format_version = ${CODE_GRAPH_RESOLUTION_CANDIDATE_INDEX_FORMAT_VERSION}),
    context_fingerprint TEXT NOT NULL CHECK (length(context_fingerprint) = 64),
    path_count INTEGER NOT NULL CHECK (path_count >= 0),
    reference_count INTEGER NOT NULL CHECK (reference_count >= 0),
    symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
    reexports_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS ${CODE_GRAPH_RESOLUTION_CANDIDATE_PATHS_TABLE} (
    snapshot_id TEXT NOT NULL REFERENCES ${CODE_GRAPH_RESOLUTION_CANDIDATE_INDEX_TABLE}(snapshot_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    path TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, ordinal)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS ${CODE_GRAPH_RESOLUTION_CANDIDATE_RUNS_TABLE} (
    snapshot_id TEXT NOT NULL REFERENCES ${CODE_GRAPH_RESOLUTION_CANDIDATE_INDEX_TABLE}(snapshot_id) ON DELETE CASCADE,
    kind INTEGER NOT NULL CHECK (kind IN (${REFERENCE_RUN}, ${SYMBOL_RUN})),
    first_key INTEGER NOT NULL,
    entry_count INTEGER NOT NULL CHECK (entry_count > 0),
    entries BLOB NOT NULL,
    PRIMARY KEY (snapshot_id, kind, first_key)
  ) WITHOUT ROWID`,
] as const;

export const recordResolutionCandidateIndex = Effect.fn('codeGraph.recordResolutionCandidateIndex')(function* (
  snapshotId: string,
  contextFingerprint: string,
  index: ProjectResolutionCandidateIndex,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists(sql, CODE_GRAPH_RESOLUTION_CANDIDATE_RUNS_TABLE))) return false;
  const references = referenceRuns(index);
  const symbols = symbolRuns(index.symbolFingerprints);
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM snapshot_resolution_candidate_runs WHERE snapshot_id = ${snapshotId}`;
      yield* sql`DELETE FROM snapshot_resolution_candidate_paths WHERE snapshot_id = ${snapshotId}`;
      yield* sql`DELETE FROM snapshot_resolution_candidate_indexes WHERE snapshot_id = ${snapshotId}`;
      const owner = yield* sql`SELECT 1 FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1`;
      if (owner.length !== 1) return false;
      yield* sql`
        INSERT INTO snapshot_resolution_candidate_indexes (
          snapshot_id, format_version, context_fingerprint, path_count, reference_count, symbol_count,
          reexports_json, created_at
        ) VALUES (
          ${snapshotId}, ${CODE_GRAPH_RESOLUTION_CANDIDATE_INDEX_FORMAT_VERSION}, ${contextFingerprint},
          ${index.paths.length}, ${index.referenceFingerprints.length}, ${symbols.entries},
          ${JSON.stringify(index.reexports)}, ${createdAt}
        )
      `;
      for (const batch of EffectArray.chunksOf(
        EffectArray.map(index.paths, (path, ordinal) => [snapshotId, ordinal, path] as const),
        INSERT_ROWS,
      )) {
        yield* sql.unsafe(
          `INSERT INTO snapshot_resolution_candidate_paths (snapshot_id, ordinal, path)
           VALUES ${EffectArray.join(
             EffectArray.map(batch, () => '(?, ?, ?)'),
             ', ',
           )}`,
          batch.flat(),
        );
      }
      for (const batch of EffectArray.chunksOf([...references.runs, ...symbols.runs], INSERT_ROWS)) {
        yield* sql.unsafe(
          `INSERT INTO snapshot_resolution_candidate_runs (snapshot_id, kind, first_key, entry_count, entries)
           VALUES ${EffectArray.join(
             EffectArray.map(batch, () => '(?, ?, ?, ?, ?)'),
             ', ',
           )}`,
          EffectArray.flatMap(batch, run => [snapshotId, run.kind, run.firstKey, run.entryCount, run.entries]),
        );
      }
      return true;
    }),
  );
});

export const selectResolutionCandidateIndex = Effect.fn('codeGraph.selectResolutionCandidateIndex')(function* (
  snapshotId: string,
  contextFingerprint: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const unavailable: CodeGraphResolutionCandidateIndexState = {state: 'unavailable'};
  if (!(yield* tableExists(sql, CODE_GRAPH_RESOLUTION_CANDIDATE_RUNS_TABLE))) return unavailable;
  const rows = yield* sql<{readonly reexports_json: string | null}>`
    SELECT receipt.reexports_json
    FROM snapshots AS snapshot
    LEFT JOIN snapshot_resolution_candidate_indexes AS receipt
      ON receipt.snapshot_id = snapshot.id
      AND receipt.format_version = ${CODE_GRAPH_RESOLUTION_CANDIDATE_INDEX_FORMAT_VERSION}
      AND receipt.context_fingerprint = ${contextFingerprint}
    WHERE snapshot.id = ${snapshotId} AND snapshot.state = 'ready'
    LIMIT 1
  `;
  if (rows.length !== 1) return unavailable;
  const reexports = rows[0].reexports_json === null ? undefined : decodeReexports(rows[0].reexports_json);
  return reexports === undefined
    ? ({state: 'missing'} satisfies CodeGraphResolutionCandidateIndexState)
    : ({reexports, state: 'indexed'} satisfies CodeGraphResolutionCandidateIndexState);
});

export const selectResolutionCandidateIndexMatches = Effect.fn('codeGraph.selectResolutionCandidateIndexMatches')(
  function* (
    snapshotId: string,
    contextFingerprint: string,
    query: {
      readonly maximumReferencePaths: number;
      readonly referenceFingerprints: ReadonlySet<bigint>;
      readonly symbolFingerprints: ReadonlySet<bigint>;
    },
  ) {
    const sql = yield* SqlClient.SqlClient;
    if (!(yield* tableExists(sql, CODE_GRAPH_RESOLUTION_CANDIDATE_RUNS_TABLE))) return undefined;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const receipt = yield* sql`
          SELECT 1 FROM snapshot_resolution_candidate_indexes AS receipt
          JOIN snapshots AS snapshot ON snapshot.id = receipt.snapshot_id AND snapshot.state = 'ready'
          WHERE receipt.snapshot_id = ${snapshotId}
            AND receipt.format_version = ${CODE_GRAPH_RESOLUTION_CANDIDATE_INDEX_FORMAT_VERSION}
            AND receipt.context_fingerprint = ${contextFingerprint}
          LIMIT 1
        `;
        if (receipt.length !== 1) return undefined;
        const referenceEntries = yield* lookupRunEntries(sql, snapshotId, REFERENCE_RUN, query.referenceFingerprints);
        const symbolEntries = yield* lookupRunEntries(sql, snapshotId, SYMBOL_RUN, query.symbolFingerprints);
        if (referenceEntries === undefined || symbolEntries === undefined) return undefined;
        const ordinals = new Set<number>();
        for (const entry of referenceEntries) {
          if (ordinals.size > query.maximumReferencePaths) break;
          ordinals.add(entry.ordinal);
        }
        const referencePaths = new Set<string>();
        for (const batch of EffectArray.chunksOf(
          [...ordinals].sort((left, right) => left - right),
          SELECT_PARAMETERS,
        )) {
          const rows = yield* sql.unsafe<{readonly path: string}>(
            `SELECT path FROM snapshot_resolution_candidate_paths
             WHERE snapshot_id = ? AND ordinal IN (${EffectArray.join(
               EffectArray.map(batch, () => '?'),
               ', ',
             )})`,
            [snapshotId, ...batch],
          );
          if (rows.length !== batch.length) return undefined;
          for (const row of rows) referencePaths.add(row.path);
        }
        return {
          referencePaths,
          symbolFingerprints: new Set(EffectArray.map(symbolEntries, entry => entry.fingerprint)),
        } satisfies ProjectResolutionCandidateIndexMatches;
      }),
    );
  },
);

interface EncodedRun {
  readonly entries: Uint8Array;
  readonly entryCount: number;
  readonly firstKey: number;
  readonly kind: RunKind;
}

function runKey(signedFingerprint: bigint): number {
  return Number(signedFingerprint >> RUN_KEY_SHIFT);
}

function signedCopy(values: BigUint64Array): BigInt64Array {
  return new BigInt64Array(values.buffer, values.byteOffset, values.length).slice();
}

function referenceRuns(index: ProjectResolutionCandidateIndex): {readonly runs: readonly EncodedRun[]} {
  const signed = signedCopy(index.referenceFingerprints);
  const order = Uint32Array.from({length: signed.length}, (_, position) => position).sort((left, right) =>
    signed[left] < signed[right]
      ? -1
      : signed[left] > signed[right]
        ? 1
        : index.referenceOrdinals[left] - index.referenceOrdinals[right],
  );
  return {
    runs: encodeRuns(
      REFERENCE_RUN,
      order.length,
      position => signed[order[position]],
      (view, offset, position) => {
        view.setBigInt64(offset, signed[order[position]], true);
        view.setUint32(offset + 8, index.referenceOrdinals[order[position]], true);
      },
    ),
  };
}

function symbolRuns(fingerprints: BigUint64Array): {readonly entries: number; readonly runs: readonly EncodedRun[]} {
  const sorted = signedCopy(fingerprints).sort();
  let distinct = 0;
  for (let position = 0; position < sorted.length; position += 1) {
    if (position > 0 && sorted[position] === sorted[distinct - 1]) continue;
    sorted[distinct] = sorted[position];
    distinct += 1;
  }
  return {
    entries: distinct,
    runs: encodeRuns(
      SYMBOL_RUN,
      distinct,
      position => sorted[position],
      (view, offset, position) => {
        view.setBigInt64(offset, sorted[position], true);
      },
    ),
  };
}

/** Cut runs only between run keys, so one key never spans two runs. */
function encodeRuns(
  kind: RunKind,
  entries: number,
  fingerprintAt: (position: number) => bigint,
  writeEntry: (view: DataView, offset: number, position: number) => void,
): readonly EncodedRun[] {
  const runs: EncodedRun[] = [];
  let start = 0;
  while (start < entries) {
    let end = Math.min(entries, start + RUN_ENTRIES);
    while (end < entries && runKey(fingerprintAt(end)) === runKey(fingerprintAt(end - 1))) end += 1;
    const bytes = new Uint8Array((end - start) * ENTRY_BYTES[kind]);
    const view = new DataView(bytes.buffer);
    for (let position = start; position < end; position += 1) {
      writeEntry(view, (position - start) * ENTRY_BYTES[kind], position);
    }
    runs.push({entries: bytes, entryCount: end - start, firstKey: runKey(fingerprintAt(start)), kind});
    start = end;
  }
  return runs;
}

const lookupRunEntries = Effect.fn('codeGraph.lookupResolutionCandidateRunEntries')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  kind: RunKind,
  fingerprints: ReadonlySet<bigint>,
) {
  if (fingerprints.size === 0) return [];
  const wanted = EffectArray.map([...fingerprints], fingerprint => BigInt.asIntN(64, fingerprint)).sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  );
  const boundaries = EffectArray.map(
    yield* sql<{readonly first_key: number}>`
      SELECT first_key FROM snapshot_resolution_candidate_runs
      WHERE snapshot_id = ${snapshotId} AND kind = ${kind}
      ORDER BY first_key
    `,
    row => row.first_key,
  );
  // A run holds every entry whose key is at least its first key and below the next run's first key.
  const wantedByRun = new Map<number, bigint[]>();
  for (const fingerprint of wanted) {
    const boundary = lastAtMost(boundaries, runKey(fingerprint));
    if (boundary === undefined) continue;
    const group = wantedByRun.get(boundary) ?? [];
    group.push(fingerprint);
    wantedByRun.set(boundary, group);
  }
  const width = ENTRY_BYTES[kind];
  const entries: {readonly fingerprint: bigint; readonly ordinal: number}[] = [];
  for (const batch of EffectArray.chunksOf([...wantedByRun.keys()], SELECT_PARAMETERS)) {
    const rows = yield* sql.unsafe<{
      readonly entries: Uint8Array;
      readonly entry_count: number;
      readonly first_key: number;
    }>(
      `SELECT first_key, entry_count, entries FROM snapshot_resolution_candidate_runs
       WHERE snapshot_id = ? AND kind = ? AND first_key IN (${EffectArray.join(
         EffectArray.map(batch, () => '?'),
         ', ',
       )})
       ORDER BY first_key`,
      [snapshotId, kind, ...batch],
    );
    if (rows.length !== batch.length) return undefined;
    for (const row of rows) {
      if (!(row.entries instanceof Uint8Array) || row.entries.byteLength !== row.entry_count * width) return undefined;
      const view = new DataView(row.entries.buffer, row.entries.byteOffset, row.entries.byteLength);
      for (const fingerprint of wantedByRun.get(row.first_key) ?? []) {
        for (let position = firstAtLeast(view, width, row.entry_count, fingerprint); position < row.entry_count;) {
          if (view.getBigInt64(position * width, true) !== fingerprint) break;
          entries.push({
            fingerprint: BigInt.asUintN(64, fingerprint),
            ordinal: kind === REFERENCE_RUN ? view.getUint32(position * width + 8, true) : -1,
          });
          position += 1;
        }
      }
    }
  }
  return entries;
});

function lastAtMost(sorted: readonly number[], value: number): number | undefined {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? undefined : sorted[low - 1];
}

function firstAtLeast(view: DataView, width: number, entries: number, fingerprint: bigint): number {
  let low = 0;
  let high = entries;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (view.getBigInt64(middle * width, true) < fingerprint) low = middle + 1;
    else high = middle;
  }
  return low;
}

function decodeReexports(json: string): readonly ProjectResolutionReexportKeys[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!EffectArray.isArray(value)) return undefined;
  const reexports: ProjectResolutionReexportKeys[] = [];
  for (const entry of value) {
    if (
      !Predicate.isObject(entry) ||
      !Predicate.isString(entry.sourcePath) ||
      !lookupKeys(entry.aliases) ||
      !lookupKeys(entry.candidates)
    ) {
      return undefined;
    }
    reexports.push({aliases: entry.aliases, candidates: entry.candidates, sourcePath: entry.sourcePath});
  }
  return reexports;
}

function lookupKeys(value: unknown): value is readonly ProjectResolutionLookupKey[] {
  return (
    EffectArray.isArray(value) &&
    EffectArray.every(
      value,
      key => Predicate.isObject(key) && Predicate.isString(key.key) && Predicate.isString(key.resolutionDomain),
    )
  );
}
