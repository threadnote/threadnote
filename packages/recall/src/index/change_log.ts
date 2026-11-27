import {Array as EffectArray, Clock, Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {recallIndexMetadataIsCurrent} from './identity.js';

/**
 * Bounded change log of lexical publications. Each publication that advances `content_generation`
 * writes one header and one entry for each memory that was added, removed, or really changed.
 * Readers trust the log only when the headers chain without a gap to the current generation.
 *
 * The log lists memories whose candidate record or `project`, `approved_authoritative`,
 * `workspace_scope` or `logical_key` changed. It does not list changes of code links, identity
 * conflicts or link targets; a generation can advance with zero entries when only those change.
 */

const PUBLICATION_TABLE = 'recall_change_publications';
const ENTRY_TABLE = 'recall_change_entries';
/** Maximum retained publication headers. */
export const RECALL_CHANGE_LOG_MAX_PUBLICATIONS = 256;
/** Maximum retained entries summed over the retained headers. */
const MAX_ENTRIES = 50_000;

export type RecallChangeKind = 'added' | 'changed' | 'removed';

export interface RecallChangeEntry {
  readonly uri: string;
  readonly kind: RecallChangeKind;
  readonly beforeMemoryId: string | null;
  readonly beforeContentHash: string | null;
  readonly afterMemoryId: string | null;
  readonly afterContentHash: string | null;
}

export type RecallChangeSet =
  | {
      readonly state: 'known';
      /** The `content_generation` the set was checked against; callers can fence on it. */
      readonly contentGeneration: string;
      readonly changed: readonly RecallChangeEntry[];
    }
  | {readonly state: 'unknown'};

/** Created lazily in the publish transaction, so opening a database never takes the write lock. */
const createRecallChangeLogTables = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${PUBLICATION_TABLE} (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        previous_generation TEXT,
        content_generation TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        entry_count INTEGER NOT NULL CHECK (entry_count >= 0)
      )
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ENTRY_TABLE} (
        publication_sequence INTEGER NOT NULL
          REFERENCES ${PUBLICATION_TABLE}(sequence) ON DELETE CASCADE,
        uri TEXT NOT NULL,
        change_kind TEXT NOT NULL CHECK (change_kind IN ('added', 'changed', 'removed')),
        before_memory_id TEXT,
        before_content_hash TEXT,
        after_memory_id TEXT,
        after_content_hash TEXT,
        PRIMARY KEY (publication_sequence, uri)
      ) WITHOUT ROWID
    `);
  });

/**
 * Runs inside the publish transaction before replaced documents are deleted. `replacedTable` holds
 * ids of old rows that are re-indexed or removed; `indexedTable` holds the new rows.
 *
 * When the generation does not advance, no header is written: the latest header still names the
 * current generation, so the chain holds. Such a publication has no replaced rows by construction;
 * if it ever had real changes, the log is cleared so readers get `unknown` instead of a wrong set.
 */
export const recordRecallChangeLog = Effect.fn('recall.recordChangeLog')(function* (
  sql: SqlClient.SqlClient,
  tables: {readonly indexedTable: string; readonly replacedTable: string},
  contentGeneration: string,
) {
  yield* createRecallChangeLogTables(sql);
  const metadataRows = yield* sql<{readonly key: string; readonly value: string}>`
    SELECT key, value FROM metadata`;
  const metadata = new Map(EffectArray.map(metadataRows, row => [row.key, row.value] as const));
  // Read from this database file: a fresh recovery file has no previous generation, so its chain starts here.
  // A change of the main tables outside a publication also breaks the chain (previous NULL gives unknown).
  const storedGeneration = metadata.get('content_generation') ?? null;
  const previousGeneration = recallIndexMetadataIsCurrent(metadata) ? storedGeneration : null;
  const changedSelect = `
    SELECT n.uri AS uri, CASE WHEN o.id IS NULL THEN 'added' ELSE 'changed' END AS change_kind,
      o.memory_id AS before_memory_id, o.content_hash AS before_content_hash,
      n.memory_id AS after_memory_id, n.content_hash AS after_content_hash
    FROM temp.${tables.indexedTable} AS n
    LEFT JOIN documents AS o ON o.uri = n.uri
    WHERE o.id IS NULL
      OR o.candidate_json IS NOT n.candidate_json
      OR o.project IS NOT n.project
      OR o.approved_authoritative IS NOT n.approved_authoritative
      OR o.workspace_scope IS NOT n.workspace_scope
      OR o.logical_key IS NOT n.logical_key
    UNION ALL
    SELECT o.uri, 'removed', o.memory_id, o.content_hash, NULL, NULL
    FROM documents AS o
    WHERE o.id IN (SELECT document_id FROM temp.${tables.replacedTable})
      AND o.uri NOT IN (SELECT uri FROM temp.${tables.indexedTable})`;
  if (storedGeneration === contentGeneration) {
    const pending = yield* sql.unsafe<{readonly present: number}>(`SELECT EXISTS (${changedSelect}) AS present`);
    if (pending[0]?.present === 1) yield* sql.unsafe(`DELETE FROM ${PUBLICATION_TABLE}`);
    return;
  }
  const publishedAt = yield* Clock.currentTimeMillis;
  const header = yield* sql.unsafe<{readonly sequence: number}>(
    `INSERT INTO ${PUBLICATION_TABLE}
       (previous_generation, content_generation, published_at, entry_count)
     VALUES (?, ?, ?, 0) RETURNING sequence`,
    [previousGeneration, contentGeneration, publishedAt],
  );
  const sequence = header[0]?.sequence;
  if (sequence === undefined) return yield* Effect.die('recall change log header insert returned no sequence');
  yield* sql.unsafe(
    `INSERT INTO ${ENTRY_TABLE} (publication_sequence, uri, change_kind,
       before_memory_id, before_content_hash, after_memory_id, after_content_hash)
     SELECT ?, uri, change_kind, before_memory_id, before_content_hash, after_memory_id, after_content_hash
     FROM (${changedSelect})`,
    [sequence],
  );
  yield* sql.unsafe(
    `UPDATE ${PUBLICATION_TABLE}
     SET entry_count = (SELECT COUNT(*) FROM ${ENTRY_TABLE} WHERE publication_sequence = ?)
     WHERE sequence = ?`,
    [sequence, sequence],
  );
  // Prune oldest headers beyond either limit; a single oversized publication prunes itself (reads give unknown).
  yield* sql.unsafe(
    `DELETE FROM ${PUBLICATION_TABLE} WHERE sequence IN (
       SELECT sequence FROM (
         SELECT sequence,
           ROW_NUMBER() OVER (ORDER BY sequence DESC) AS position,
           SUM(entry_count) OVER (ORDER BY sequence DESC) AS running_entries
         FROM ${PUBLICATION_TABLE})
       WHERE position > ? OR running_entries > ?)`,
    [RECALL_CHANGE_LOG_MAX_PUBLICATIONS, MAX_ENTRIES],
  );
  // Entries of pruned headers go through ON DELETE CASCADE (initializeRecallDatabase sets foreign_keys = ON).
});

interface HeaderRow {
  readonly sequence: number;
  readonly previous_generation: string | null;
  readonly content_generation: string;
  readonly published_at: number;
}

/** Headers after `fromGeneration` up to the current generation, oldest first, or none when the chain has a gap. */
const recallChangeChain = (
  sql: SqlClient.SqlClient,
  fromGeneration: string,
): Effect.Effect<Option.Option<{readonly current: string; readonly headers: readonly HeaderRow[]}>, unknown> =>
  Effect.gen(function* () {
    const present = yield* sql<{readonly name: string}>`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN (${PUBLICATION_TABLE}, ${ENTRY_TABLE})`;
    if (present.length !== 2) return Option.none();
    const current = (yield* sql<{readonly value: string}>`
      SELECT value FROM metadata WHERE key = 'content_generation'`)[0]?.value;
    if (current === undefined) return Option.none();
    if (current === fromGeneration) return Option.some({current, headers: []});
    const headers = yield* sql.unsafe<HeaderRow>(
      `SELECT sequence, previous_generation, content_generation, published_at
       FROM ${PUBLICATION_TABLE} ORDER BY sequence DESC`,
    );
    const chain: HeaderRow[] = [];
    let expected: string = current;
    for (const header of headers) {
      if (header.content_generation !== expected || header.previous_generation === null) break;
      chain.push(header);
      if (header.previous_generation === fromGeneration) return Option.some({current, headers: chain.reverse()});
      expected = header.previous_generation;
    }
    return Option.none();
  });

interface EntryRow {
  readonly uri: string;
  readonly change_kind: RecallChangeKind;
  readonly before_memory_id: string | null;
  readonly before_content_hash: string | null;
  readonly after_memory_id: string | null;
  readonly after_content_hash: string | null;
}

const unknownChangeSet: RecallChangeSet = {state: 'unknown'};
const knownChangeSet = (contentGeneration: string, changed: readonly RecallChangeEntry[]): RecallChangeSet => ({
  state: 'known',
  contentGeneration,
  changed,
});

/**
 * Changes after `fromGeneration` up to the current generation. Safe without a caller snapshot: after
 * the entries are read, the first chain header must still exist and `content_generation` must be the
 * one the chain was checked against; otherwise a concurrent publication or prune ran and the result is
 * `unknown`, never a short `known`.
 */
export const readRecallChangesSince = Effect.fn('recall.readChangesSince')(function* (
  sql: SqlClient.SqlClient,
  fromGeneration: string,
) {
  const chain = yield* recallChangeChain(sql, fromGeneration);
  if (Option.isNone(chain)) return unknownChangeSet;
  const {current, headers} = chain.value;
  const first = headers[0];
  if (first === undefined) return knownChangeSet(current, []);
  const rows = yield* sql.unsafe<EntryRow>(
    `SELECT uri, change_kind, before_memory_id, before_content_hash, after_memory_id, after_content_hash
     FROM ${ENTRY_TABLE}
     WHERE publication_sequence >= ? ORDER BY publication_sequence, uri COLLATE BINARY`,
    [first.sequence],
  );
  const still = yield* sql.unsafe<{readonly generation: string | null; readonly present: number}>(
    `SELECT (SELECT value FROM metadata WHERE key = 'content_generation') AS generation,
       EXISTS (SELECT 1 FROM ${PUBLICATION_TABLE} WHERE sequence = ?) AS present`,
    [first.sequence],
  );
  if (still[0]?.generation !== current || still[0]?.present !== 1) return unknownChangeSet;
  const merged = new Map<string, {first: EntryRow; last: EntryRow}>();
  for (const row of rows) {
    const existing = merged.get(row.uri);
    if (existing === undefined) merged.set(row.uri, {first: row, last: row});
    else existing.last = row;
  }
  const changed: RecallChangeEntry[] = [];
  for (const [uri, {first: earliest, last}] of merged) {
    const existedBefore = earliest.change_kind !== 'added';
    const existsAfter = last.change_kind !== 'removed';
    changed.push({
      uri,
      kind: !existsAfter ? 'removed' : !existedBefore ? 'added' : 'changed',
      beforeMemoryId: earliest.before_memory_id,
      beforeContentHash: earliest.before_content_hash,
      afterMemoryId: last.after_memory_id,
      afterContentHash: last.after_content_hash,
    });
  }
  return knownChangeSet(current, changed);
});

/** `publishedAtMillis` (epoch ms) of the first publication after `fromGeneration`; none when unknown or current. */
export const readRecallFirstPublicationAfter = Effect.fn('recall.readFirstPublicationAfter')(function* (
  sql: SqlClient.SqlClient,
  fromGeneration: string,
) {
  const chain = yield* recallChangeChain(sql, fromGeneration);
  return Option.flatMap(chain, ({headers}) =>
    Option.map(Option.fromNullishOr(headers[0]?.published_at), publishedAtMillis => ({publishedAtMillis})),
  );
});
