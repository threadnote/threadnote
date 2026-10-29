import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_VECTOR_RETIREMENT_PAGE_ROWS = 1_000;
export const CODE_GRAPH_VECTOR_RETIREMENT_PAGE_BYTES = 32 * 1_024 * 1_024;
export const CODE_GRAPH_VECTOR_RETIREMENT_PAGE_FIXED_ROWS = 5;
export const CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_ROWS = 8_192;
export const CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_BYTES = 4 * 1_024 * 1_024;

export const MAXIMUM_SAFE_INTEGER_SQL = '9007199254740991';
export const VECTOR_GENERATION_BYTES = 256;
export const VECTOR_SNAPSHOT_BYTES = 1_024;
export const VECTOR_MODEL_ID_BYTES = 256;
export const VECTOR_MODEL_SHA256_BYTES = 64;
export const VECTOR_CREATED_AT_BYTES = 64;
export const VECTOR_SYMBOL_BYTES = 1_024;
export const VECTOR_FINGERPRINT_BYTES = 1_024;
export const VECTOR_RETIREMENT_TRIGGER_SQL_BYTES = 65_536;
export const VECTOR_CORE_TABLE_NAMES = ['vector_generations', 'vector_pointers', 'vectors'] as const;
export const VECTOR_RETIREMENT_TABLE_NAMES = ['vector_retirement_state', 'vector_generation_retirements'] as const;

export function storedSchemaSql(value: string): string {
  return Effect.pipe(value, EffectString.replace(/^CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS/u, 'CREATE $1'));
}

export function sqliteStringLiteral(value: string): string {
  return `'${Effect.pipe(value, EffectString.replaceAll("'", "''"))}'`;
}

export class CodeGraphVectorRetirementError extends Schema.TaggedError<
  CodeGraphVectorRetirementError,
  {readonly brand: unique symbol}
>()('CodeGraphVectorRetirementError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export function vectorGenerationManifestPredicate(alias: string): string {
  return `typeof(${alias}.generation) = 'text'
    AND length(CAST(${alias}.generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
    AND instr(${alias}.generation, char(0)) = 0
    AND typeof(${alias}.snapshot_id) = 'text'
    AND length(CAST(${alias}.snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
    AND instr(${alias}.snapshot_id, char(0)) = 0
    AND typeof(${alias}.model_id) = 'text'
    AND length(CAST(${alias}.model_id AS BLOB)) BETWEEN 1 AND ${VECTOR_MODEL_ID_BYTES}
    AND instr(${alias}.model_id, char(0)) = 0
    AND typeof(${alias}.model_sha256) = 'text'
    AND length(CAST(${alias}.model_sha256 AS BLOB)) = ${VECTOR_MODEL_SHA256_BYTES}
    AND ${alias}.model_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(${alias}.dimensions) = 'integer'
    AND ${alias}.dimensions BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
    AND typeof(${alias}.template_version) = 'integer'
    AND ${alias}.template_version BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
    AND typeof(${alias}.count) = 'integer'
    AND ${alias}.count BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
    AND typeof(${alias}.state) = 'text'
    AND ${alias}.state IN ('building', 'ready')
    AND typeof(${alias}.created_at) = 'text'
    AND length(CAST(${alias}.created_at AS BLOB)) BETWEEN 1 AND ${VECTOR_CREATED_AT_BYTES}
    AND instr(${alias}.created_at, char(0)) = 0`;
}

export const CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vector_generations (
  generation TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_sha256 TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions > 0),
  template_version INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count >= 0),
  state TEXT NOT NULL CHECK(state IN ('building', 'ready')),
  created_at TEXT NOT NULL
)`;

export const CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vector_pointers (
  worktree_id TEXT PRIMARY KEY,
  generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE
)`;

export const CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS vector_pointer_generation_lookup ON vector_pointers (generation)';

export const CODE_GRAPH_VECTORS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vectors (
  generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
  symbol_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (generation, symbol_id)
) WITHOUT ROWID`;

export const CODE_GRAPH_VECTOR_REUSE_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS vector_reuse_lookup ON vectors (generation, symbol_id, fingerprint)';

export const CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vector_retirement_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (
    typeof(singleton) = 'integer' AND singleton = 1
  ),
  admission_cursor TEXT CHECK (
    admission_cursor IS NULL OR (
      typeof(admission_cursor) = 'text'
      AND length(CAST(admission_cursor AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
      AND instr(admission_cursor, char(0)) = 0
    )
  ),
  generation_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(generation_revision) = 'integer'
    AND generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
  ),
  admission_scan_revision INTEGER CHECK (
    admission_scan_revision IS NULL OR (
      typeof(admission_scan_revision) = 'integer'
      AND admission_scan_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
    )
  ),
  clean_generation_revision INTEGER CHECK (
    clean_generation_revision IS NULL OR (
      typeof(clean_generation_revision) = 'integer'
      AND clean_generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
    )
  ),
  pointer_delete_worktree_id TEXT,
  pointer_delete_generation TEXT,
  pointer_delete_snapshot_id TEXT,
  CHECK ((admission_cursor IS NULL) = (admission_scan_revision IS NULL)),
  CHECK (admission_scan_revision IS NULL OR admission_scan_revision <= generation_revision),
  CHECK (clean_generation_revision IS NULL OR clean_generation_revision <= generation_revision),
  CHECK (
    admission_scan_revision IS NULL
    OR clean_generation_revision IS NULL
    OR clean_generation_revision <= admission_scan_revision
  ),
  CHECK (
    clean_generation_revision IS NULL
    OR clean_generation_revision < generation_revision
    OR (admission_cursor IS NULL AND admission_scan_revision IS NULL)
  ),
  CHECK (
    (
      pointer_delete_worktree_id IS NULL
      AND pointer_delete_generation IS NULL
      AND pointer_delete_snapshot_id IS NULL
    ) OR (
      typeof(pointer_delete_worktree_id) = 'text'
      AND length(CAST(pointer_delete_worktree_id AS BLOB)) = 64
      AND pointer_delete_worktree_id NOT GLOB '*[^0-9a-f]*'
      AND typeof(pointer_delete_generation) = 'text'
      AND length(CAST(pointer_delete_generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
      AND instr(pointer_delete_generation, char(0)) = 0
      AND typeof(pointer_delete_snapshot_id) = 'text'
      AND length(CAST(pointer_delete_snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
      AND instr(pointer_delete_snapshot_id, char(0)) = 0
    )
  )
) WITHOUT ROWID`;

export const CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vector_generation_retirements (
  retirement_id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (
    typeof(retirement_id) = 'integer'
    AND retirement_id BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
  ),
  generation TEXT NOT NULL UNIQUE CHECK (
    typeof(generation) = 'text'
    AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
    AND instr(generation, char(0)) = 0
  ),
  snapshot_id TEXT NOT NULL CHECK (
    typeof(snapshot_id) = 'text'
    AND length(CAST(snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
    AND instr(snapshot_id, char(0)) = 0
  ),
  retired_by_worktree_id TEXT CHECK (
    retired_by_worktree_id IS NULL OR (
      typeof(retired_by_worktree_id) = 'text'
      AND length(CAST(retired_by_worktree_id AS BLOB)) = 64
      AND retired_by_worktree_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  page_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(page_revision) = 'integer'
    AND page_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
  ),
  delete_authorized INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(delete_authorized) = 'integer' AND delete_authorized IN (0, 1)
  )
)`;

export const CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL = `CREATE INDEX IF NOT EXISTS vector_generation_retirement_association
   ON vector_generation_retirements (
     retired_by_worktree_id, snapshot_id, generation, retirement_id
   ) WHERE retired_by_worktree_id IS NOT NULL`;

export const CORE_SCHEMA_TRIGGER_GUARD_SQL = `SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'index'
      AND name = 'vector_pointer_generation_lookup'
      AND tbl_name = 'vector_pointers'
    LIMIT 1
  ) OR (
    SELECT COUNT(*) FROM (
      SELECT seqno, cid, name, "desc", coll, "key"
      FROM pragma_index_xinfo('vector_pointer_generation_lookup')
      LIMIT 3
    )
  ) <> 2 OR (
    SELECT COUNT(*) FROM (
      SELECT seqno, cid, name, "desc", coll, "key"
      FROM pragma_index_xinfo('vector_pointer_generation_lookup')
      LIMIT 3
    ) WHERE (
      seqno = 0 AND name = 'generation' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
    ) OR (
      seqno = 1 AND cid = -1 AND name IS NULL AND "desc" = 0 AND coll = 'BINARY' AND "key" = 0
    )
  ) <> 2 OR NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table'
      AND name = 'vectors'
      AND tbl_name = 'vectors'
    LIMIT 1
  ) OR (
    SELECT COUNT(*) FROM (
      SELECT seqno, cid, name, "desc", coll, "key"
      FROM pragma_index_xinfo('sqlite_autoindex_vectors_1')
      LIMIT 5
    )
  ) <> 4 OR (
    SELECT COUNT(*) FROM (
      SELECT seqno, cid, name, "desc", coll, "key"
      FROM pragma_index_xinfo('sqlite_autoindex_vectors_1')
      LIMIT 5
    ) WHERE (
      seqno = 0 AND name = 'generation' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
    ) OR (
      seqno = 1 AND name = 'symbol_id' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
    ) OR (
      seqno = 2 AND name = 'fingerprint' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 0
    ) OR (
      seqno = 3 AND name = 'vector' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 0
    )
  ) <> 4
  THEN RAISE(ABORT, 'code graph vector retirement authority is incompatible')
END;`;

export const RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL = `${CORE_SCHEMA_TRIGGER_GUARD_SQL}
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table'
      AND name = 'vector_retirement_state'
      AND tbl_name = 'vector_retirement_state'
      AND sql = ${sqliteStringLiteral(storedSchemaSql(CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL))}
    LIMIT 1
  ) OR NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table'
      AND name = 'vector_generation_retirements'
      AND tbl_name = 'vector_generation_retirements'
      AND sql = ${sqliteStringLiteral(storedSchemaSql(CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL))}
    LIMIT 1
  ) OR NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'index'
      AND name = 'vector_generation_retirement_association'
      AND tbl_name = 'vector_generation_retirements'
      AND sql = ${sqliteStringLiteral(storedSchemaSql(CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL))}
    LIMIT 1
  ) OR (
    SELECT COUNT(*) FROM (
      SELECT name, typeof(seq) AS seq_type, seq
      FROM sqlite_sequence
      WHERE name = 'vector_generation_retirements' COLLATE NOCASE
      LIMIT 2
    )
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM sqlite_sequence
    WHERE name = 'vector_generation_retirements'
      AND typeof(seq) = 'integer'
      AND seq BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
      AND seq >= COALESCE((
        SELECT retirement_id
        FROM vector_generation_retirements
        ORDER BY retirement_id DESC
        LIMIT 1
      ), 0)
    LIMIT 1
  ) OR (
    SELECT COUNT(*) FROM (SELECT singleton FROM vector_retirement_state LIMIT 2)
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM vector_retirement_state
    WHERE singleton = 1
      AND typeof(generation_revision) = 'integer'
      AND generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
      AND (
        (
          admission_cursor IS NULL
          AND admission_scan_revision IS NULL
        ) OR (
          typeof(admission_cursor) = 'text'
          AND length(CAST(admission_cursor AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
          AND instr(admission_cursor, char(0)) = 0
          AND typeof(admission_scan_revision) = 'integer'
          AND admission_scan_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
          AND admission_scan_revision <= generation_revision
        )
      )
      AND (
        clean_generation_revision IS NULL OR (
          typeof(clean_generation_revision) = 'integer'
          AND clean_generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
          AND clean_generation_revision <= generation_revision
        )
      )
      AND (
        admission_scan_revision IS NULL
        OR clean_generation_revision IS NULL
        OR clean_generation_revision <= admission_scan_revision
      )
      AND (
        clean_generation_revision IS NULL
        OR clean_generation_revision < generation_revision
        OR (admission_cursor IS NULL AND admission_scan_revision IS NULL)
      )
      AND (
        (
          pointer_delete_worktree_id IS NULL
          AND pointer_delete_generation IS NULL
          AND pointer_delete_snapshot_id IS NULL
        ) OR (
          typeof(pointer_delete_worktree_id) = 'text'
          AND length(CAST(pointer_delete_worktree_id AS BLOB)) = 64
          AND pointer_delete_worktree_id NOT GLOB '*[^0-9a-f]*'
          AND typeof(pointer_delete_generation) = 'text'
          AND length(CAST(pointer_delete_generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
          AND instr(pointer_delete_generation, char(0)) = 0
          AND typeof(pointer_delete_snapshot_id) = 'text'
          AND length(CAST(pointer_delete_snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
          AND instr(pointer_delete_snapshot_id, char(0)) = 0
        )
      )
    LIMIT 1
  )
  THEN RAISE(ABORT, 'code graph vector retirement marker authority is incompatible')
END;`;

export const VECTOR_RETIREMENT_MARKER_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_marker_insert_guard
  BEFORE INSERT ON vector_generation_retirements
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT CASE
      WHEN NEW.retirement_id <> -1
        OR NEW.page_revision <> 0
        OR NEW.delete_authorized <> 0
        OR NOT EXISTS (
          SELECT 1 FROM vector_generations AS generation
          WHERE generation.generation = NEW.generation
            AND generation.snapshot_id = NEW.snapshot_id
            AND ${vectorGenerationManifestPredicate('generation')}
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
          WHERE generation = NEW.generation LIMIT 1
        )
      THEN RAISE(ABORT, 'code graph vector retirement marker is invalid')
    END;
  END`;

export const VECTOR_RETIREMENT_MARKER_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_marker_update_guard
  BEFORE UPDATE ON vector_generation_retirements
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT CASE
      WHEN NEW.retirement_id <> OLD.retirement_id
        OR NEW.generation <> OLD.generation
        OR NEW.snapshot_id <> OLD.snapshot_id
        OR NEW.retired_by_worktree_id IS NOT OLD.retired_by_worktree_id
        OR NOT EXISTS (
          SELECT 1 FROM vector_generations AS generation
          WHERE generation.generation = OLD.generation
            AND generation.snapshot_id = OLD.snapshot_id
            AND ${vectorGenerationManifestPredicate('generation')}
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
          WHERE generation = OLD.generation LIMIT 1
        )
        OR NOT (
          (
            OLD.delete_authorized = 0
            AND NEW.delete_authorized = 0
            AND OLD.page_revision < ${MAXIMUM_SAFE_INTEGER_SQL}
            AND NEW.page_revision = OLD.page_revision + 1
          ) OR (
            OLD.delete_authorized = 0
            AND NEW.delete_authorized = 1
            AND NEW.page_revision = OLD.page_revision
            AND NOT EXISTS (
              SELECT 1 FROM vectors INDEXED BY sqlite_autoindex_vectors_1
              WHERE generation = OLD.generation LIMIT 1
            )
          )
        )
      THEN RAISE(ABORT, 'code graph vector retirement marker update is invalid')
    END;
  END`;

export const VECTOR_RETIREMENT_MARKER_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_marker_delete_guard
  BEFORE DELETE ON vector_generation_retirements
  WHEN EXISTS (
    SELECT 1 FROM vector_generations WHERE generation = OLD.generation LIMIT 1
  )
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT RAISE(ABORT, 'code graph vector retirement marker is still authoritative');
  END`;

export const POINTER_MANIFEST_TRIGGER_GUARD_SQL = `SELECT CASE
  WHEN typeof(NEW.worktree_id) <> 'text'
    OR length(CAST(NEW.worktree_id AS BLOB)) <> 64
    OR NEW.worktree_id GLOB '*[^0-9a-f]*'
    OR typeof(NEW.generation) <> 'text'
    OR length(CAST(NEW.generation AS BLOB)) NOT BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
    OR instr(NEW.generation, char(0)) <> 0
    OR NOT EXISTS (
      SELECT 1 FROM vector_generations AS generation
      WHERE generation.generation = NEW.generation
        AND ${vectorGenerationManifestPredicate('generation')}
      LIMIT 1
    )
  THEN RAISE(ABORT, 'code graph vector pointer manifest is invalid')
END;`;

export const OLD_POINTER_MANIFEST_TRIGGER_GUARD_SQL = Effect.pipe(
  POINTER_MANIFEST_TRIGGER_GUARD_SQL,
  EffectString.replaceAll('NEW.', 'OLD.'),
);

export const VECTOR_RETIREMENT_POINTER_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_pointer_insert_guard
  BEFORE INSERT ON vector_pointers
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    ${POINTER_MANIFEST_TRIGGER_GUARD_SQL}
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM vector_generation_retirements
        INDEXED BY sqlite_autoindex_vector_generation_retirements_1
      WHERE generation = NEW.generation LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation is retiring') END;
  END`;

export const VECTOR_RETIREMENT_POINTER_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_pointer_update_guard
  BEFORE UPDATE ON vector_pointers
  WHEN NEW.worktree_id <> OLD.worktree_id OR NEW.generation <> OLD.generation
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    ${OLD_POINTER_MANIFEST_TRIGGER_GUARD_SQL}
    ${POINTER_MANIFEST_TRIGGER_GUARD_SQL}
    SELECT CASE WHEN NEW.worktree_id <> OLD.worktree_id
      THEN RAISE(ABORT, 'code graph vector pointer identity is immutable') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM vector_generation_retirements
        INDEXED BY sqlite_autoindex_vector_generation_retirements_1
      WHERE generation = NEW.generation LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation is retiring') END;
  END`;

export const VECTOR_RETIREMENT_POINTER_DELETE_GUARD_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_pointer_delete_guard
  BEFORE DELETE ON vector_pointers
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    ${OLD_POINTER_MANIFEST_TRIGGER_GUARD_SQL}
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1
      FROM vector_retirement_state AS authority
      JOIN vector_generations AS generation
        ON generation.generation = OLD.generation
       AND generation.snapshot_id = authority.pointer_delete_snapshot_id
      WHERE authority.singleton = 1
        AND authority.pointer_delete_worktree_id = OLD.worktree_id
        AND authority.pointer_delete_generation = OLD.generation
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector pointer deletion is unauthorized') END;
  END`;

export const VECTOR_RETIREMENT_POINTER_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_pointer_delete_mark
  AFTER DELETE ON vector_pointers
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    INSERT INTO vector_generation_retirements (
      generation, snapshot_id, retired_by_worktree_id
    )
    SELECT generation, snapshot_id, OLD.worktree_id
    FROM vector_generations
    WHERE generation = OLD.generation
      AND NOT EXISTS (
        SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
        WHERE generation = OLD.generation LIMIT 1
      );
    UPDATE vector_retirement_state
    SET pointer_delete_worktree_id = NULL,
        pointer_delete_generation = NULL,
        pointer_delete_snapshot_id = NULL
    WHERE singleton = 1
      AND pointer_delete_worktree_id = OLD.worktree_id
      AND pointer_delete_generation = OLD.generation;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM vector_retirement_state
      WHERE singleton = 1 AND pointer_delete_worktree_id IS NOT NULL
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector pointer deletion authority was not consumed') END;
  END`;

export const VECTOR_RETIREMENT_POINTER_CHANGED_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_pointer_update_mark
  AFTER UPDATE OF generation ON vector_pointers
  WHEN NEW.generation <> OLD.generation AND NOT EXISTS (
    SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
    WHERE generation = OLD.generation LIMIT 1
  )
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    INSERT INTO vector_generation_retirements (
      generation, snapshot_id, retired_by_worktree_id
    )
    SELECT generation, snapshot_id, OLD.worktree_id
    FROM vector_generations
    WHERE generation = OLD.generation;
  END`;

export const VECTOR_RETIREMENT_VECTOR_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_vector_insert_guard
  BEFORE INSERT ON vectors
  WHEN EXISTS (
    SELECT 1 FROM vector_generation_retirements
      INDEXED BY sqlite_autoindex_vector_generation_retirements_1
    WHERE generation = NEW.generation LIMIT 1
  )
  BEGIN
    SELECT RAISE(ABORT, 'code graph vector generation is retiring');
  END`;

export const VECTOR_RETIREMENT_VECTOR_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_vector_update_guard
  BEFORE UPDATE ON vectors
  WHEN EXISTS (
    SELECT 1 FROM vector_generation_retirements
      INDEXED BY sqlite_autoindex_vector_generation_retirements_1
    WHERE generation = OLD.generation OR generation = NEW.generation
    LIMIT 1
  )
  BEGIN
    SELECT RAISE(ABORT, 'code graph vector generation is retiring');
  END`;

export const VECTOR_RETIREMENT_GENERATION_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_generation_insert_guard
  BEFORE INSERT ON vector_generations
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM vector_generation_retirements WHERE generation = NEW.generation LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation is retiring') END;
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM vector_retirement_state
      WHERE singleton = 1 AND generation_revision < ${MAXIMUM_SAFE_INTEGER_SQL}
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation revision is exhausted') END;
    UPDATE vector_retirement_state
    SET generation_revision = generation_revision + 1
    WHERE singleton = 1;
  END`;

export const VECTOR_RETIREMENT_GENERATION_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_generation_update_guard
  BEFORE UPDATE ON vector_generations
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM vector_generation_retirements
      WHERE generation = OLD.generation OR generation = NEW.generation
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation is retiring') END;
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM vector_retirement_state
      WHERE singleton = 1 AND generation_revision < ${MAXIMUM_SAFE_INTEGER_SQL}
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation revision is exhausted') END;
    UPDATE vector_retirement_state
    SET generation_revision = generation_revision + 1
    WHERE singleton = 1;
  END`;

export const VECTOR_RETIREMENT_GENERATION_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_generation_delete_guard
  BEFORE DELETE ON vector_generations
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM vector_generation_retirements
        WHERE generation = OLD.generation AND delete_authorized = 1
        LIMIT 1
      ) OR EXISTS (
        SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
        WHERE generation = OLD.generation LIMIT 1
      ) OR EXISTS (
        SELECT 1 FROM vectors INDEXED BY sqlite_autoindex_vectors_1
        WHERE generation = OLD.generation LIMIT 1
      )
      THEN RAISE(ABORT, 'code graph vector generation deletion is unauthorized')
    END;
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM vector_retirement_state
      WHERE singleton = 1 AND generation_revision < ${MAXIMUM_SAFE_INTEGER_SQL}
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation revision is exhausted') END;
    UPDATE vector_retirement_state
    SET generation_revision = generation_revision + 1
    WHERE singleton = 1;
  END`;

export const VECTOR_RETIREMENT_GENERATION_DELETED_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_generation_deleted_clear
  AFTER DELETE ON vector_generations
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    DELETE FROM vector_generation_retirements
    WHERE generation = OLD.generation AND delete_authorized = 1;
  END`;

export const CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS = [
  {name: 'vector_retirement_marker_insert_guard', sql: VECTOR_RETIREMENT_MARKER_INSERT_TRIGGER_SQL},
  {name: 'vector_retirement_marker_update_guard', sql: VECTOR_RETIREMENT_MARKER_UPDATE_TRIGGER_SQL},
  {name: 'vector_retirement_marker_delete_guard', sql: VECTOR_RETIREMENT_MARKER_DELETE_TRIGGER_SQL},
  {name: 'vector_retirement_pointer_insert_guard', sql: VECTOR_RETIREMENT_POINTER_INSERT_TRIGGER_SQL},
  {name: 'vector_retirement_pointer_update_guard', sql: VECTOR_RETIREMENT_POINTER_UPDATE_TRIGGER_SQL},
  {name: 'vector_retirement_pointer_delete_guard', sql: VECTOR_RETIREMENT_POINTER_DELETE_GUARD_TRIGGER_SQL},
  {name: 'vector_retirement_pointer_delete_mark', sql: VECTOR_RETIREMENT_POINTER_DELETE_TRIGGER_SQL},
  {name: 'vector_retirement_pointer_update_mark', sql: VECTOR_RETIREMENT_POINTER_CHANGED_TRIGGER_SQL},
  {name: 'vector_retirement_vector_insert_guard', sql: VECTOR_RETIREMENT_VECTOR_INSERT_TRIGGER_SQL},
  {name: 'vector_retirement_vector_update_guard', sql: VECTOR_RETIREMENT_VECTOR_UPDATE_TRIGGER_SQL},
  {name: 'vector_retirement_generation_insert_guard', sql: VECTOR_RETIREMENT_GENERATION_INSERT_TRIGGER_SQL},
  {name: 'vector_retirement_generation_update_guard', sql: VECTOR_RETIREMENT_GENERATION_UPDATE_TRIGGER_SQL},
  {name: 'vector_retirement_generation_delete_guard', sql: VECTOR_RETIREMENT_GENERATION_DELETE_TRIGGER_SQL},
  {name: 'vector_retirement_generation_deleted_clear', sql: VECTOR_RETIREMENT_GENERATION_DELETED_TRIGGER_SQL},
] as const;

// sqlite_schema rows (tables, implicit/explicit indexes, triggers), the
// singleton state row, and sqlite_sequence authority published by r1. The
// fixed conservative count is versioned by the exact SQL byte constant below.
export const CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_ROWS = 24;
export const CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_BYTES = EffectArray.reduce(
  [
    CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL,
    CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL,
    CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL,
    ...EffectArray.map(CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS, trigger => trigger.sql),
  ],
  256,
  (total, sql) => total + new TextEncoder().encode(storedSchemaSql(sql)).byteLength,
);
