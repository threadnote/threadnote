import {Array as EffectArray} from 'effect';
import {Clock, Effect, Schema} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import {CODE_GRAPH_VECTOR_PROGRESS_TABLE_SQL, CODE_GRAPH_VECTOR_PROGRESS_TRIGGERS} from './generation_schema.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export class CodeGraphGenerationClaimError extends Schema.TaggedError<
  CodeGraphGenerationClaimError,
  {readonly brand: unique symbol}
>()('CodeGraphGenerationClaimError', {message: Schema.String}) {}

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
    ...EffectArray.map(CODE_GRAPH_VECTOR_PROGRESS_TRIGGERS, trigger => ({...trigger, type: 'trigger'})),
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
  return Effect2.pipe(sql, EffectString.replaceAll(/\s+/gu, ' '), EffectString.trim, EffectString.replace(/;$/u, ''));
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
        EffectArray.some(step.rows, row => row[0] !== step.generation) ||
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
        VALUES ${EffectArray.join(
          EffectArray.map(batch, () => '(?, ?, ?, ?)'),
          ', ',
        )} ON CONFLICT(generation, symbol_id) DO NOTHING`,
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

export const CODE_GRAPH_REUSE_POINTER_WINDOW = 16;
export const CODE_GRAPH_REUSE_GENERATION_WINDOW = 32;
export const CODE_GRAPH_REUSE_CANDIDATES = 8;
export const CODE_GRAPH_REUSE_BYTE_LIMIT = 4 * 1024 * 1024;
export const CODE_GRAPH_REUSE_PAYLOAD_ROWS = 400;

export function estimateCodeGraphCompatibleCopyBytes(
  raw: readonly {id: string; fingerprint?: string; cursor: string}[],
  dimensions: number,
): number {
  const utf8 = new TextEncoder();
  return (
    EffectArray.reduce(
      raw,
      4096,
      (sum, row) => sum + utf8.encode(row.id).byteLength + utf8.encode(row.fingerprint ?? '').byteLength + 256,
    ) +
    utf8.encode(raw.at(-1)?.cursor ?? '').byteLength +
    Math.min(CODE_GRAPH_REUSE_BYTE_LIMIT, raw.length * dimensions * 4)
  );
}

/** Source selection, payload validation and destination ownership share one writer transaction. */
export const copyCodeGraphCompatiblePrefix = Effect.fn('codeGraph.copyCompatiblePrefix')(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly generation: string;
    readonly ownerToken: string;
    readonly worktreeId: string;
    readonly expectedCursor: string | null;
    readonly expectedOffset: number;
    readonly modelId: string;
    readonly modelSha256: string;
    readonly dimensions: number;
    readonly templateVersion: number;
    readonly raw: readonly {readonly id: string; readonly fingerprint?: string; readonly cursor: string}[];
    readonly decode: (value: unknown) => Uint8Array | undefined;
  },
) {
  if (input.raw.length > 400 || !Number.isSafeInteger(input.dimensions) || input.dimensions < 1)
    return yield* CodeGraphGenerationClaimError.make({message: 'Compatible vector copy exceeds its bounds.'});
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const progress = yield* requireCodeGraphGenerationClaim(sql, input.generation, input.ownerToken);
      if (progress.cursor !== input.expectedCursor || progress.array_offset !== input.expectedOffset)
        return yield* CodeGraphGenerationClaimError.make({message: 'Compatible vector copy cursor changed.'});
      const own = yield* sql.unsafe<{readonly generation: string}>(
        'SELECT generation FROM vector_pointers WHERE worktree_id = ?',
        [input.worktreeId],
      );
      // Bounds apply to raw indexed metadata BEFORE compatibility filtering.
      const pointers = yield* sql.unsafe<{readonly generation: string}>(
        'SELECT generation FROM vector_pointers ORDER BY worktree_id LIMIT ?',
        [CODE_GRAPH_REUSE_POINTER_WINDOW],
      );
      const generations = yield* sql.unsafe<{readonly generation: string}>(
        'SELECT generation FROM vector_generations ORDER BY generation LIMIT ?',
        [CODE_GRAPH_REUSE_GENERATION_WINDOW],
      );
      const candidates: string[] = [];
      const inspected = new Set<string>();
      for (const reference of [...own, ...pointers, ...generations]) {
        if (inspected.has(reference.generation)) continue;
        inspected.add(reference.generation);
        const compatible = yield* sql.unsafe(
          `SELECT 1 FROM vector_generations WHERE generation = ? AND state = 'ready'
          AND model_id = ? AND model_sha256 = ? AND dimensions = ? AND template_version = ?
          AND NOT EXISTS (SELECT 1 FROM vector_generation_retirements WHERE generation = ?)`,
          [
            reference.generation,
            input.modelId,
            input.modelSha256,
            input.dimensions,
            input.templateVersion,
            reference.generation,
          ],
        );
        if (compatible.length === 1) candidates.push(reference.generation);
        if (candidates.length === CODE_GRAPH_REUSE_CANDIDATES) break;
      }
      const rows: Array<readonly [string, string, string, Uint8Array]> = [];
      const seen = new Set<string>();
      let consumed = 0;
      let copiedBytes = 0;
      let transportedBytes = 0;
      let transportedRows = 0;
      let probes = 0;
      for (const item of input.raw) {
        if (item.fingerprint === undefined || seen.has(item.id)) {
          consumed++;
          continue;
        }
        const existing = yield* sql.unsafe<{readonly fingerprint: string}>(
          'SELECT fingerprint FROM vectors WHERE generation = ? AND symbol_id = ?',
          [input.generation, item.id],
        );
        if (existing.length) {
          if (existing[0]?.fingerprint !== item.fingerprint)
            return yield* CodeGraphGenerationClaimError.make({message: 'Destination vector identity changed.'});
          seen.add(item.id);
          consumed++;
          continue;
        }
        if (copiedBytes + input.dimensions * 4 > CODE_GRAPH_REUSE_BYTE_LIMIT) break;
        let bytes: Uint8Array | undefined;
        for (const source of candidates) {
          if (
            transportedRows === CODE_GRAPH_REUSE_PAYLOAD_ROWS ||
            transportedBytes + input.dimensions * 4 > CODE_GRAPH_REUSE_BYTE_LIMIT
          )
            break;
          probes++;
          // The existing generation/symbol/fingerprint index gives one bounded point probe.
          // length() rejects oversized blobs before SQLite transports their payload.
          const matching = yield* sql.unsafe<{readonly vector: unknown}>(
            `SELECT vector FROM vectors WHERE generation = ? AND symbol_id = ? AND fingerprint = ?
            AND typeof(vector) = 'blob' AND length(vector) = ? LIMIT 1`,
            [source, item.id, item.fingerprint, input.dimensions * 4],
          );
          if (matching[0]) {
            transportedRows++;
            transportedBytes += input.dimensions * 4;
            bytes = input.decode(matching[0].vector);
          }
          if (bytes?.byteLength === input.dimensions * 4) break;
          bytes = undefined;
        }
        if (!bytes) break;
        rows.push([input.generation, item.id, item.fingerprint, bytes]);
        seen.add(item.id);
        copiedBytes += bytes.byteLength;
        consumed++;
      }
      const next =
        consumed === 0
          ? progress
          : yield* commitCodeGraphGenerationStep(sql, {
              generation: input.generation,
              ownerToken: input.ownerToken,
              expectedCursor: input.expectedCursor,
              expectedOffset: input.expectedOffset,
              nextCursor: input.raw[consumed - 1].cursor,
              nextOffset: input.expectedOffset + consumed,
              embedded: 0,
              reused: rows.length,
              rows,
            });
      // No source vector payload escapes this transaction; only the destination checkpoint does.
      return {
        progress: next,
        consumed,
        copiedBytes,
        transportedBytes,
        transportedRows,
        probes,
        candidates: candidates.length,
        rawPointerReferences: pointers.length,
        rawGenerationReferences: generations.length,
      };
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
