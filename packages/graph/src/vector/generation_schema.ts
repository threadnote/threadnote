import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

/** The payload filename stays v2: older runtimes must reject the upgraded store. */
export const CODE_GRAPH_VECTOR_DATABASE_VERSION = 3;
export const CODE_GRAPH_VECTOR_DATABASE_FILENAME = 'vectors-v2.sqlite';
export const CODE_GRAPH_VECTOR_PROGRESS_TABLE_SQL = `CREATE TABLE vector_generation_progress (
  generation TEXT PRIMARY KEY NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
  owner_token TEXT NOT NULL CHECK(typeof(owner_token) = 'text' AND length(CAST(owner_token AS BLOB)) BETWEEN 1 AND 256 AND instr(owner_token, char(0)) = 0),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991),
  cursor TEXT CHECK(cursor IS NULL OR (typeof(cursor) = 'text' AND length(CAST(cursor AS BLOB)) <= 16384 AND instr(cursor, char(0)) = 0)),
  array_offset INTEGER NOT NULL DEFAULT 0 CHECK(typeof(array_offset) = 'integer' AND array_offset BETWEEN 0 AND 9007199254740991),
  embedded INTEGER NOT NULL DEFAULT 0 CHECK(typeof(embedded) = 'integer' AND embedded BETWEEN 0 AND 9007199254740991),
  reused INTEGER NOT NULL DEFAULT 0 CHECK(typeof(reused) = 'integer' AND reused BETWEEN 0 AND 9007199254740991),
  reusable_generation TEXT CHECK(reusable_generation IS NULL OR (typeof(reusable_generation) = 'text' AND length(CAST(reusable_generation AS BLOB)) BETWEEN 1 AND 256 AND instr(reusable_generation, char(0)) = 0)),
  request_epoch TEXT NOT NULL CHECK(typeof(request_epoch) = 'text' AND length(CAST(request_epoch AS BLOB)) BETWEEN 1 AND 256 AND instr(request_epoch, char(0)) = 0)
)`;
const liveClaim = `(SELECT 1 FROM vector_generation_progress AS claim
  WHERE (claim.generation = NEW.generation OR claim.reusable_generation = NEW.generation)
    AND claim.expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`;
export const CODE_GRAPH_VECTOR_PROGRESS_TRIGGERS = [
  {
    // A pointer trigger must finish even when its retirement INSERT is deferred.
    // IGNORE skips only that nested INSERT; the pinned payload remains unretired.
    name: 'vector_progress_retirement_insert_guard',
    table: 'vector_generation_retirements',
    sql: `CREATE TRIGGER vector_progress_retirement_insert_guard
BEFORE INSERT ON vector_generation_retirements
WHEN EXISTS ${liveClaim}
BEGIN SELECT RAISE(IGNORE); END`,
  },
  {
    name: 'vector_progress_retirement_update_guard',
    table: 'vector_generation_retirements',
    sql: `CREATE TRIGGER vector_progress_retirement_update_guard
BEFORE UPDATE ON vector_generation_retirements
WHEN EXISTS ${liveClaim}
BEGIN SELECT RAISE(ABORT, 'Code graph vector generation has a live claim'); END`,
  },
  ...EffectArray.map(['INSERT', 'UPDATE', 'DELETE'] as const, operation => ({
    name: `vector_progress_revision_${Effect.pipe(operation, EffectString.toLowerCase)}`,
    table: 'vector_generation_progress',
    sql: `CREATE TRIGGER vector_progress_revision_${Effect.pipe(operation, EffectString.toLowerCase)}
AFTER ${operation} ON vector_generation_progress
BEGIN UPDATE vector_retirement_state SET generation_revision = generation_revision + 1,
  clean_generation_revision = NULL WHERE singleton = 1; END`,
  })),
] as const;
