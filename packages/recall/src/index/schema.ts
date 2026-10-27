import {Effect, Schema} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import * as RecallIndexIdentity from './identity.js';

export const RECALL_INDEX_DATABASE_VERSION = 14;

export interface RecallMetadataRow {
  readonly key: string;
  readonly value: string;
}

export class RecallIndexSchemaIncompatible extends Schema.TaggedError<RecallIndexSchemaIncompatible>()(
  'RecallIndexSchemaIncompatible',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const initializeRecallSchema = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      uri TEXT UNIQUE NOT NULL,
      project TEXT,
      approved_authoritative INTEGER NOT NULL CHECK (approved_authoritative IN (0, 1)),
      workspace_scope TEXT,
      source_path TEXT NOT NULL,
      source_modified_at TEXT,
      recorded_at TEXT,
      source_size INTEGER NOT NULL CHECK (source_size >= 0),
      authority_policy_key TEXT,
      candidate_json TEXT NOT NULL,
      logical_key TEXT NOT NULL,
      document_length INTEGER NOT NULL CHECK (document_length >= 0),
      memory_links_truncated INTEGER NOT NULL CHECK (memory_links_truncated IN (0, 1))
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS identity_documents (
      id INTEGER PRIMARY KEY, uri TEXT UNIQUE NOT NULL, project TEXT,
      approved_authoritative INTEGER NOT NULL CHECK (approved_authoritative IN (0, 1)),
      workspace_scope TEXT, source_path TEXT NOT NULL, source_modified_at TEXT, recorded_at TEXT,
      source_size INTEGER NOT NULL CHECK (source_size >= 0), authority_policy_key TEXT,
      candidate_json TEXT NOT NULL, logical_key TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS identity_memory_conflicts (
    memory_id TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID`);
  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS identity_documents_memory_identity
    ON identity_documents(json_extract(candidate_json, '$.memoryId'), json_extract(candidate_json, '$.contentHash'))`);
  yield* sql`INSERT INTO metadata (key, value) VALUES ('identity_mutation_sequence', '0') ON CONFLICT(key) DO NOTHING`;
  for (const table of ['identity_documents', 'identity_memory_conflicts'] as const) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      yield* sql.unsafe(`CREATE TRIGGER IF NOT EXISTS ${table}_integrity_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} BEGIN
          UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'identity_mutation_sequence';
        END`);
    }
  }
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS postings (
      term TEXT NOT NULL,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      field_weight REAL NOT NULL CHECK (field_weight >= 0),
      term_frequency INTEGER NOT NULL CHECK (term_frequency > 0),
      PRIMARY KEY (term, document_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS code_links (
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      document_uri TEXT NOT NULL,
      citation_ordinal INTEGER NOT NULL CHECK (citation_ordinal >= 0),
      selector_kind TEXT NOT NULL CHECK (
        selector_kind IN ('symbol-node', 'symbol-locator', 'file-path', 'file-content')
      ),
      selector_digest TEXT NOT NULL CHECK (
        length(selector_digest) = 64 AND selector_digest NOT GLOB '*[^0-9a-f]*'
      ),
      PRIMARY KEY (document_id, citation_ordinal, selector_kind, selector_digest)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS memory_links (
      source_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      source_uri TEXT NOT NULL,
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      target_locator_digest TEXT NOT NULL CHECK (
        target_locator_digest = '' OR (
          length(target_locator_digest) = 64 AND target_locator_digest NOT GLOB '*[^0-9a-f]*'
        )
      ),
      relation_type TEXT NOT NULL CHECK (
        relation_type IN ('depends_on', 'evidence_for', 'references', 'related_to', 'supersedes')
      ),
      relation_origin TEXT NOT NULL CHECK (
        relation_origin IN ('relation', 'references', 'evidence', 'supersedes')
      ),
      relation_ordinal INTEGER NOT NULL CHECK (relation_ordinal >= 0),
      CHECK (target_memory_id <> '' OR target_locator_digest <> ''),
      PRIMARY KEY (
        source_document_id,
        relation_origin,
        relation_ordinal,
        relation_type,
        target_memory_id,
        target_locator_digest
      )
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS term_statistics (
      term TEXT PRIMARY KEY NOT NULL,
      document_frequency INTEGER NOT NULL CHECK (document_frequency > 0)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS exact_search USING fts5(
      content,
      content = '',
      contentless_delete = 1,
      tokenize = 'trigram'
    )
  `);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_uri ON documents(uri)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_logical_key ON documents(logical_key)');
  yield* RecallIndexIdentity.initializeRecallIdentityIndex(sql);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_modified_uri ON documents(source_modified_at DESC, uri)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS documents_project_modified_uri ON documents(project, source_modified_at DESC, uri)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS documents_eligibility_uri ON documents(project, approved_authoritative, uri)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS documents_authority_project_uri ON documents(approved_authoritative, project, uri)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_workspace_scope_uri ON documents(workspace_scope, uri)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS postings_document_id ON postings(document_id)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS code_links_selector_document ON code_links(selector_kind, selector_digest, document_id, citation_ordinal)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS code_links_selector_uri ON code_links(selector_kind, selector_digest, document_uri COLLATE BINARY, citation_ordinal, document_id)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS memory_links_source ON memory_links(source_memory_id, relation_type, source_uri COLLATE BINARY, relation_origin, relation_ordinal, target_memory_id, target_locator_digest, source_document_id)',
  );
  yield* sql.unsafe(
    "CREATE INDEX IF NOT EXISTS memory_links_target ON memory_links(target_memory_id, relation_type, source_uri COLLATE BINARY, relation_origin, relation_ordinal, target_locator_digest, source_document_id) WHERE target_memory_id <> ''",
  );
  yield* sql.unsafe(
    "CREATE INDEX IF NOT EXISTS memory_links_locator ON memory_links(target_locator_digest, relation_type, source_document_id, relation_origin, relation_ordinal) WHERE target_locator_digest <> ''",
  );
  yield* sql`
    INSERT INTO metadata (key, value)
    VALUES ('schema_version', ${String(RECALL_INDEX_DATABASE_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  yield* sql`INSERT INTO metadata (key, value) VALUES ('mutation_sequence', '0') ON CONFLICT(key) DO NOTHING`;
  for (const table of [
    'documents',
    'postings',
    'term_statistics',
    'code_links',
    'memory_links',
    'memory_identity_conflicts',
  ] as const) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      yield* sql.unsafe(`
        CREATE TRIGGER IF NOT EXISTS ${table}_integrity_${operation.toLowerCase()}
        AFTER ${operation} ON ${table}
        BEGIN
          UPDATE metadata
          SET value = CAST(value AS INTEGER) + 1
          WHERE key = 'mutation_sequence';
        END
      `);
    }
  }
  const rows = yield* sql<RecallMetadataRow>`SELECT key, value FROM metadata WHERE key = 'schema_version'`;
  if (rows[0]?.value !== String(RECALL_INDEX_DATABASE_VERSION)) {
    return yield* RecallIndexSchemaIncompatible.make({
      message: `Unsupported lexical index schema ${rows[0]?.value ?? 'unknown'}; expected ${RECALL_INDEX_DATABASE_VERSION}.`,
    });
  }
});
