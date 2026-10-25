import {Clock, Effect, Schema} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import {CODE_GRAPH_VECTOR_PROGRESS_TABLE_SQL, CODE_GRAPH_VECTOR_PROGRESS_TRIGGERS} from './generation_schema.js';

export class CodeGraphGenerationClaimError extends Schema.TaggedError<CodeGraphGenerationClaimError>()(
  'CodeGraphGenerationClaimError',
  {message: Schema.String},
) {}

export interface CodeGraphGenerationProgress {
  readonly generation: string;
  readonly owner_token: string;
  readonly expires_at: number;
  readonly cursor: string | null;
  readonly array_offset: number;
  readonly embedded: number;
  readonly reused: number;
  readonly reusable_generation: string | null;
  readonly request_epoch: string;
}

export const CODE_GRAPH_GENERATION_LEASE_MILLISECONDS = 5 * 60_000;

/** Exact metadata validation is read-only, including on released v2 databases. */
export const requireCodeGraphGenerationSchema = Effect.fn('codeGraph.requireGenerationSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  const expected = [
    {name: 'vector_generation_progress', type: 'table', sql: CODE_GRAPH_VECTOR_PROGRESS_TABLE_SQL},
    ...CODE_GRAPH_VECTOR_PROGRESS_TRIGGERS.map(trigger => ({...trigger, type: 'trigger'})),
  ];
  for (const definition of expected) {
    const rows = yield* sql.unsafe<{readonly type: string; readonly sql: string}>(
      'SELECT type, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE LIMIT 2',
      [definition.name],
    );
    if (
      rows.length !== 1 ||
      rows[0]?.type !== definition.type ||
      normalize(rows[0].sql) !== normalize(definition.sql)
    ) {
      return yield* CodeGraphGenerationClaimError.make({
        message: 'Code graph vector generation metadata is incompatible.',
      });
    }
  }
  const indexes = yield* sql.unsafe('PRAGMA index_list(vector_generation_progress)');
  const triggers = yield* sql.unsafe(
    "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'vector_generation_progress' LIMIT 4",
  );
  if (indexes.length !== 1 || triggers.length !== 3) {
    return yield* CodeGraphGenerationClaimError.make({
      message: 'Code graph vector generation metadata has unexpected objects.',
    });
  }
});

function normalize(sql: string) {
  return sql.replaceAll(/\s+/gu, ' ').trim().replace(/;$/u, '');
}

export const initializeCodeGraphGenerationSchema = Effect.fn('codeGraph.initializeGenerationSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(CODE_GRAPH_VECTOR_PROGRESS_TABLE_SQL);
  for (const trigger of CODE_GRAPH_VECTOR_PROGRESS_TRIGGERS) yield* sql.unsafe(trigger.sql);
});

export const readCodeGraphGenerationProgress = Effect.fn('codeGraph.readGenerationProgress')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
) {
  const rows = yield* sql.unsafe<CodeGraphGenerationProgress>(
    'SELECT * FROM vector_generation_progress WHERE generation = ?',
    [generation],
  );
  return rows[0];
});

/** Claim only extant, unretired work. An expired owner can never renew itself. */
export const claimCodeGraphGeneration = Effect.fn('codeGraph.claimGeneration')(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly generation: string;
    readonly ownerToken: string;
    readonly requestEpoch: string;
    readonly reusableGeneration?: string;
  },
) {
  const now = yield* Clock.currentTimeMillis;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const valid = yield* sql.unsafe<{readonly state: string}>(
        `SELECT state FROM vector_generations WHERE generation = ?
      AND NOT EXISTS (SELECT 1 FROM vector_generation_retirements WHERE generation = ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM vector_generations AS reusable WHERE reusable.generation = ? AND reusable.state = 'ready'
        AND NOT EXISTS (SELECT 1 FROM vector_generation_retirements WHERE generation = reusable.generation)))`,
        [input.generation, input.generation, input.reusableGeneration ?? null, input.reusableGeneration ?? null],
      );
      if (valid.length !== 1) return undefined;
      const prior = yield* readCodeGraphGenerationProgress(sql, input.generation);
      if (prior && prior.expires_at > now) {
        if (prior.owner_token !== input.ownerToken) return undefined;
        yield* requireCodeGraphGenerationClaim(sql, input.generation, input.ownerToken);
        return prior;
      }
      // Revalidate the persisted input too; a reclaimed input invalidates resumability.
      if (prior?.owner_token === input.ownerToken && prior.expires_at <= now) return undefined;
      const ready = valid[0]?.state === 'ready';
      if (!ready && prior?.reusable_generation) {
        const reusable = yield* sql.unsafe(
          `SELECT 1 FROM vector_generations WHERE generation = ? AND state = 'ready'
        AND NOT EXISTS (SELECT 1 FROM vector_generation_retirements WHERE generation = ?)`,
          [prior.reusable_generation, prior.reusable_generation],
        );
        if (reusable.length !== 1) return undefined;
      }
      yield* sql.unsafe(
        `INSERT INTO vector_generation_progress
      (generation, owner_token, expires_at, reusable_generation, request_epoch) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(generation) DO UPDATE SET owner_token = excluded.owner_token, expires_at = excluded.expires_at,
        reusable_generation = CASE WHEN ? THEN NULL ELSE vector_generation_progress.reusable_generation END`,
        [
          input.generation,
          input.ownerToken,
          now + CODE_GRAPH_GENERATION_LEASE_MILLISECONDS,
          ready ? null : (input.reusableGeneration ?? null),
          input.requestEpoch,
          ready ? 1 : 0,
        ],
      );
      return yield* readCodeGraphGenerationProgress(sql, input.generation);
    }),
  );
});

export const requireCodeGraphGenerationClaim = Effect.fn('codeGraph.requireGenerationClaim')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  ownerToken: string,
) {
  const now = yield* Clock.currentTimeMillis;
  const progress = yield* readCodeGraphGenerationProgress(sql, generation);
  const valid = yield* sql.unsafe(
    `SELECT 1 FROM vector_generations WHERE generation = ?
    AND NOT EXISTS (SELECT 1 FROM vector_generation_retirements WHERE generation = ?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM vector_generations WHERE generation = ? AND state = 'ready'
      AND NOT EXISTS (SELECT 1 FROM vector_generation_retirements WHERE generation = ?)))`,
    [
      generation,
      generation,
      progress?.reusable_generation ?? null,
      progress?.reusable_generation ?? null,
      progress?.reusable_generation ?? null,
    ],
  );
  if (!progress || progress.owner_token !== ownerToken || progress.expires_at <= now || valid.length !== 1) {
    return yield* CodeGraphGenerationClaimError.make({
      message: 'Code graph vector generation claim expired or changed.',
    });
  }
  return progress;
});

export const renewCodeGraphGenerationClaim = Effect.fn('codeGraph.renewGenerationClaim')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  ownerToken: string,
) {
  yield* requireCodeGraphGenerationClaim(sql, generation, ownerToken);
  const now = yield* Clock.currentTimeMillis;
  yield* sql.unsafe(
    'UPDATE vector_generation_progress SET expires_at = ? WHERE generation = ? AND owner_token = ? AND expires_at > ?',
    [now + CODE_GRAPH_GENERATION_LEASE_MILLISECONDS, generation, ownerToken, now],
  );
});

export interface CodeGraphGenerationStep {
  readonly generation: string;
  readonly ownerToken: string;
  readonly expectedCursor: string | null;
  readonly expectedOffset: number;
  readonly nextCursor: string;
  readonly nextOffset: number;
  readonly embedded: number;
  readonly reused: number;
  readonly rows: readonly (readonly [string, string, string, Uint8Array])[];
}

/** One bounded durable checkpoint: payload rows and cursor either both commit or neither does. */
export const commitCodeGraphGenerationStep = Effect.fn('codeGraph.commitGenerationStep')(function* (
  sql: SqlClient.SqlClient,
  step: CodeGraphGenerationStep,
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const progress = yield* requireCodeGraphGenerationClaim(sql, step.generation, step.ownerToken);
      if (progress.cursor !== step.expectedCursor || progress.array_offset !== step.expectedOffset) {
        // A replay after an acknowledged commit is idempotent; every other stale cursor fails.
        if (progress.cursor === step.nextCursor && progress.array_offset === step.nextOffset) return progress;
        return yield* CodeGraphGenerationClaimError.make({message: 'Code graph generation cursor changed.'});
      }
      if (
        step.rows.length > 400 ||
        step.nextOffset <= step.expectedOffset ||
        step.nextOffset - step.expectedOffset > 400 ||
        !Number.isSafeInteger(step.nextOffset) ||
        !Number.isSafeInteger(step.embedded) ||
        !Number.isSafeInteger(step.reused) ||
        step.embedded < 0 ||
        step.reused < 0 ||
        step.rows.some(row => row[0] !== step.generation) ||
        step.embedded + step.reused !== step.rows.length
      ) {
        return yield* CodeGraphGenerationClaimError.make({message: 'Code graph generation checkpoint is invalid.'});
      }
      const ready = yield* sql.unsafe("SELECT 1 FROM vector_generations WHERE generation = ? AND state = 'building'", [
        step.generation,
      ]);
      if (ready.length !== 1)
        return yield* CodeGraphGenerationClaimError.make({message: 'Code graph generation is already complete.'});
      for (let offset = 0; offset < step.rows.length; offset += 100) {
        const batch = step.rows.slice(offset, offset + 100);
        yield* sql.unsafe(
          `INSERT INTO vectors (generation, symbol_id, fingerprint, vector)
        VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')} ON CONFLICT(generation, symbol_id) DO NOTHING`,
          batch.flat(),
        );
      }
      yield* sql.unsafe(
        `UPDATE vector_generation_progress SET cursor = ?, array_offset = ?, embedded = embedded + ?, reused = reused + ?
      WHERE generation = ? AND owner_token = ?`,
        [step.nextCursor, step.nextOffset, step.embedded, step.reused, step.generation, step.ownerToken],
      );
      yield* renewCodeGraphGenerationClaim(sql, step.generation, step.ownerToken);
      return yield* readCodeGraphGenerationProgress(sql, step.generation);
    }),
  );
});

/** Ready is an immutable, all-or-nothing visibility boundary. Ownership is retained for attachment. */
export const completeCodeGraphGeneration = Effect.fn('codeGraph.completeGeneration')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  ownerToken: string,
  expectedCount?: number,
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const progress = yield* requireCodeGraphGenerationClaim(sql, generation, ownerToken);
      const counts = yield* sql.unsafe<{readonly count: number}>(
        'SELECT COUNT(*) AS count FROM vectors WHERE generation = ?',
        [generation],
      );
      const count = Number(counts[0]?.count ?? 0);
      if ((expectedCount !== undefined && count !== expectedCount) || count !== progress.embedded + progress.reused) {
        return yield* CodeGraphGenerationClaimError.make({
          message: 'Code graph vector generation coverage is incomplete.',
        });
      }
      yield* sql.unsafe(
        "UPDATE vector_generations SET count = ?, state = 'ready' WHERE generation = ? AND state = 'building'",
        [count, generation],
      );
      yield* renewCodeGraphGenerationClaim(sql, generation, ownerToken);
      return count;
    }),
  );
});

/** Terminal abandonment releases pins while preserving a resumable cursor for a fresh validated claim. */
export const releaseCodeGraphGenerationClaim = Effect.fn('codeGraph.releaseGenerationClaim')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  ownerToken: string,
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* requireCodeGraphGenerationClaim(sql, generation, ownerToken);
      yield* sql.unsafe(
        'UPDATE vector_generation_progress SET expires_at = 0 WHERE generation = ? AND owner_token = ?',
        [generation, ownerToken],
      );
    }),
  );
});
