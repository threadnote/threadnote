import {Array as EffectArray} from 'effect';

/** Additive family. Retained v1 rows are neither migrated nor new-format proof. */
export const CANDIDATE_PAGE_TABLES = [
  {
    name: 'snapshot_candidate_page_snapshots',
    keyColumns: ['snapshot_key'],
    sql: `CREATE TABLE IF NOT EXISTS snapshot_candidate_page_snapshots (
      snapshot_key INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      authority_token TEXT NOT NULL CHECK(length(authority_token) = 64),
      protocol_sha TEXT NOT NULL CHECK(length(protocol_sha) = 64),
      format_version INTEGER NOT NULL CHECK(format_version = 3),
      UNIQUE(snapshot_id, authority_token, protocol_sha)
    )`,
  },
  {
    name: 'snapshot_candidate_page_files',
    keyColumns: ['snapshot_key', 'file_key'],
    sql: `CREATE TABLE IF NOT EXISTS snapshot_candidate_page_files (
      file_key INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_key INTEGER NOT NULL REFERENCES snapshot_candidate_page_snapshots(snapshot_key),
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      association_count INTEGER NOT NULL CHECK(association_count >= 0),
      reexport_count INTEGER NOT NULL CHECK(reexport_count >= 0),
      page_count INTEGER NOT NULL CHECK(page_count >= 0),
      original_tuple_bytes INTEGER NOT NULL CHECK(original_tuple_bytes >= 0),
      canonical_sha TEXT NOT NULL CHECK(length(canonical_sha) = 64),
      sealed INTEGER NOT NULL CHECK(sealed IN (0,1)),
      UNIQUE(snapshot_key, path),
      UNIQUE(snapshot_key, file_key)
    )`,
  },
  {
    name: 'snapshot_candidate_pages',
    keyColumns: ['snapshot_key', 'file_key', 'ordinal'],
    sql: `CREATE TABLE IF NOT EXISTS snapshot_candidate_pages (
      snapshot_key INTEGER NOT NULL,
      file_key INTEGER NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 1 AND 64),
      raw_bytes INTEGER NOT NULL CHECK(raw_bytes BETWEEN 16 AND 8388608),
      stored_bytes INTEGER NOT NULL CHECK(stored_bytes BETWEEN 1 AND 8388608),
      original_tuple_bytes INTEGER NOT NULL CHECK(original_tuple_bytes >= 0),
      raw_sha TEXT NOT NULL CHECK(length(raw_sha) = 64),
      stored_sha TEXT NOT NULL CHECK(length(stored_sha) = 64),
      codec TEXT NOT NULL CHECK(codec IN ('raw-v1','zlib3-v1','literal-pair-v1')),
      payload BLOB,
      literal_domain TEXT,
      literal_key TEXT,
      PRIMARY KEY(snapshot_key, file_key, ordinal),
      FOREIGN KEY(snapshot_key, file_key) REFERENCES snapshot_candidate_page_files(snapshot_key, file_key),
      CHECK((codec = 'literal-pair-v1' AND entry_count = 1 AND raw_bytes > 65536 AND payload IS NULL
        AND typeof(literal_domain) = 'text' AND typeof(literal_key) = 'text'
        AND stored_bytes = length(CAST(literal_domain AS BLOB)) + length(CAST(literal_key AS BLOB)))
        OR (codec IN ('raw-v1','zlib3-v1') AND raw_bytes <= 65536 AND typeof(payload) = 'blob'
          AND length(payload) = stored_bytes AND literal_domain IS NULL AND literal_key IS NULL)),
      CHECK(codec <> 'raw-v1' OR stored_bytes = raw_bytes),
      CHECK(codec <> 'zlib3-v1' OR stored_bytes < raw_bytes)
    ) WITHOUT ROWID`,
  },
  {
    name: 'snapshot_candidate_page_routes',
    keyColumns: ['snapshot_key', 'file_key', 'ordinal', 'slot'],
    sql: `CREATE TABLE IF NOT EXISTS snapshot_candidate_page_routes (
      snapshot_key INTEGER NOT NULL,
      file_key INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 63),
      hint BLOB NOT NULL CHECK(typeof(hint) = 'blob' AND length(hint) = 16),
      PRIMARY KEY(snapshot_key, file_key, ordinal, slot),
      FOREIGN KEY(snapshot_key, file_key, ordinal) REFERENCES snapshot_candidate_pages(snapshot_key, file_key, ordinal)
    ) WITHOUT ROWID`,
  },
  {
    name: 'snapshot_candidate_page_receipts',
    keyColumns: ['snapshot_key'],
    sql: `CREATE TABLE IF NOT EXISTS snapshot_candidate_page_receipts (
      snapshot_key INTEGER PRIMARY KEY REFERENCES snapshot_candidate_page_snapshots(snapshot_key),
      format_version INTEGER NOT NULL CHECK(format_version = 3),
      protocol_sha TEXT NOT NULL CHECK(length(protocol_sha) = 64),
      authority_token TEXT NOT NULL CHECK(length(authority_token) = 64),
      file_count INTEGER NOT NULL CHECK(file_count >= 0)
    ) WITHOUT ROWID`,
  },
] as const;

export const CANDIDATE_PAGE_INDEXES = [
  {
    name: 'snapshot_candidate_page_snapshots_path',
    table: 'snapshot_candidate_page_snapshots',
    sql: `CREATE INDEX IF NOT EXISTS snapshot_candidate_page_snapshots_path
      ON snapshot_candidate_page_snapshots(snapshot_id, snapshot_key)`,
  },
  {
    name: 'snapshot_candidate_page_routes_hint',
    table: 'snapshot_candidate_page_routes',
    sql: `CREATE INDEX IF NOT EXISTS snapshot_candidate_page_routes_hint
      ON snapshot_candidate_page_routes(snapshot_key, hint, file_key, ordinal, slot)`,
  },
] as const;

const invalidation = (reference: 'OLD' | 'NEW', fileColumn = 'file_key') => `
  DELETE FROM snapshot_candidate_page_receipts WHERE snapshot_key = ${reference}.snapshot_key;
  DELETE FROM snapshot_candidate_receipts WHERE snapshot_id IN (
    SELECT snapshot_id FROM snapshot_candidate_page_snapshots WHERE snapshot_key = ${reference}.snapshot_key);
  UPDATE snapshot_candidate_files SET complete = 0 WHERE (snapshot_id, path) IN (
    SELECT snapshot.snapshot_id, file.path FROM snapshot_candidate_page_files AS file
    JOIN snapshot_candidate_page_snapshots AS snapshot ON snapshot.snapshot_key = file.snapshot_key
    WHERE file.snapshot_key = ${reference}.snapshot_key AND file.file_key = ${reference}.${fileColumn});`;

export const CANDIDATE_PAGE_TRIGGERS = [
  {
    name: 'snapshot_candidate_page_snapshot_immutable',
    sql: `CREATE TRIGGER IF NOT EXISTS snapshot_candidate_page_snapshot_immutable
      BEFORE UPDATE ON snapshot_candidate_page_snapshots
      BEGIN SELECT RAISE(ABORT, 'Candidate format/source generation is immutable.'); END`,
  },
  {
    name: 'snapshot_candidate_page_file_immutable',
    sql: `CREATE TRIGGER IF NOT EXISTS snapshot_candidate_page_file_immutable
      BEFORE UPDATE ON snapshot_candidate_page_files WHEN
        NEW.file_key IS NOT OLD.file_key OR NEW.snapshot_key IS NOT OLD.snapshot_key OR NEW.path IS NOT OLD.path
        OR NEW.content_hash IS NOT OLD.content_hash OR NEW.association_count IS NOT OLD.association_count
        OR NEW.reexport_count IS NOT OLD.reexport_count OR NEW.page_count IS NOT OLD.page_count
        OR NEW.original_tuple_bytes IS NOT OLD.original_tuple_bytes OR NEW.canonical_sha IS NOT OLD.canonical_sha
      BEGIN SELECT RAISE(ABORT, 'Candidate canonical file input is immutable.'); END`,
  },
  ...EffectArray.flatMap(['snapshot_candidate_pages', 'snapshot_candidate_page_routes'] as const, table => [
    {
      name: `${table}_immutable`,
      sql: `CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'Candidate page/slot is immutable.'); END`,
    },
    {
      name: `${table}_sealed_insert`,
      sql: `CREATE TRIGGER IF NOT EXISTS ${table}_sealed_insert BEFORE INSERT ON ${table}
        WHEN EXISTS (SELECT 1 FROM snapshot_candidate_page_files
          WHERE snapshot_key = NEW.snapshot_key AND file_key = NEW.file_key AND sealed = 1)
        BEGIN SELECT RAISE(ABORT, 'Candidate file must not gain slots after its full seal.'); END`,
    },
    {
      name: `${table}_invalidate_delete`,
      sql: `CREATE TRIGGER IF NOT EXISTS ${table}_invalidate_delete BEFORE DELETE ON ${table}
        WHEN EXISTS (SELECT 1 FROM snapshot_candidate_page_files
          WHERE snapshot_key = OLD.snapshot_key AND file_key = OLD.file_key AND sealed = 1)
        BEGIN ${invalidation('OLD')}
          UPDATE snapshot_candidate_page_files SET sealed = 0
          WHERE snapshot_key = OLD.snapshot_key AND file_key = OLD.file_key;
        END`,
    },
  ]),
  {
    name: 'snapshot_candidate_page_file_invalidate_delete',
    sql: `CREATE TRIGGER IF NOT EXISTS snapshot_candidate_page_file_invalidate_delete
      BEFORE DELETE ON snapshot_candidate_page_files BEGIN ${invalidation('OLD')} END`,
  },
  {
    name: 'snapshot_candidate_page_file_unseal',
    sql: `CREATE TRIGGER IF NOT EXISTS snapshot_candidate_page_file_unseal AFTER UPDATE OF sealed ON snapshot_candidate_page_files
      WHEN NEW.sealed = 0 AND OLD.sealed = 1 BEGIN ${invalidation('NEW')} END`,
  },
  {
    name: 'snapshot_candidate_page_receipt_immutable',
    sql: `CREATE TRIGGER IF NOT EXISTS snapshot_candidate_page_receipt_immutable
      BEFORE UPDATE ON snapshot_candidate_page_receipts
      BEGIN SELECT RAISE(ABORT, 'Candidate receipt must be republished from full current proof.'); END`,
  },
  {
    name: 'snapshot_candidate_page_route_slot',
    sql: `CREATE TRIGGER IF NOT EXISTS snapshot_candidate_page_route_slot BEFORE INSERT ON snapshot_candidate_page_routes
      WHEN NOT EXISTS (SELECT 1 FROM snapshot_candidate_pages WHERE snapshot_key = NEW.snapshot_key
        AND file_key = NEW.file_key AND ordinal = NEW.ordinal AND entry_count > NEW.slot)
      BEGIN SELECT RAISE(ABORT, 'Candidate route is outside its immutable page.'); END`,
  },
] as const;

/** Every DELETE owns one indexed, snapshot-key-prefixed page; retain v1 cleanup separately. */
export const CANDIDATE_PAGE_CLEANUP_TABLES = [
  CANDIDATE_PAGE_TABLES[4],
  CANDIDATE_PAGE_TABLES[3],
  CANDIDATE_PAGE_TABLES[2],
  CANDIDATE_PAGE_TABLES[1],
  CANDIDATE_PAGE_TABLES[0],
] as const;

export const CANDIDATE_PAGE_OBJECTS = [...CANDIDATE_PAGE_TABLES, ...CANDIDATE_PAGE_INDEXES, ...CANDIDATE_PAGE_TRIGGERS];
