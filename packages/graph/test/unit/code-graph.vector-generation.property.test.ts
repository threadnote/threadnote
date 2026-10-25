import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, Layer, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {
  type CodeGraphGenerationStep,
  claimCodeGraphGeneration,
  commitCodeGraphGenerationStep,
  completeCodeGraphGeneration,
  initializeCodeGraphGenerationSchema,
  CODE_GRAPH_GENERATION_LEASE_MILLISECONDS,
} from '../../src/vector/generation.js';
import {
  CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
  CODE_GRAPH_VECTORS_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL,
} from '../../src/vector/retirement.js';

effectIt.layer(BunServices.layer)(it => {
  it.effect.prop(
    'retries and expired-owner resumes produce exactly the independently expected symbol set',
    {
      pageSizes: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 8}))).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(8),
      ),
      resumes: Schema.Array(Schema.Boolean).check(Schema.isMaxLength(8)),
    },
    ({pageSizes, resumes}) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(SqliteClient.layer({filename: ':memory:'}));
        const sql = Context.get(context, SqlClient.SqlClient);
        for (const definition of [
          CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
          CODE_GRAPH_VECTORS_TABLE_SQL,
          CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL,
          CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL,
        ])
          yield* sql.unsafe(definition);
        yield* initializeCodeGraphGenerationSchema(sql);
        yield* sql.unsafe(
          "INSERT INTO vector_generations VALUES ('target', 'snapshot', 'model', ?, 1, 1, 0, 'building', 'now')",
          ['a'.repeat(64)],
        );
        let owner = 'owner-0';
        let offset = 0;
        let cursor: string | null = null;
        yield* claimCodeGraphGeneration(sql, {generation: 'target', ownerToken: owner, requestEpoch: 'epoch'});
        for (const [index, size] of pageSizes.entries()) {
          if (resumes[index]) {
            yield* TestClock.adjust(CODE_GRAPH_GENERATION_LEASE_MILLISECONDS);
            owner = `owner-${index + 1}`;
            yield* claimCodeGraphGeneration(sql, {generation: 'target', ownerToken: owner, requestEpoch: 'epoch'});
          }
          const next = offset + size;
          const rows = Array.from(
            {length: size},
            (_, n) =>
              [
                'target',
                String(offset + n).padStart(4, '0'),
                `fingerprint-${offset + n}`,
                new Uint8Array([offset + n]),
              ] as const,
          );
          const step: CodeGraphGenerationStep = {
            generation: 'target',
            ownerToken: owner,
            expectedCursor: cursor,
            expectedOffset: offset,
            nextCursor: rows.at(-1)![1],
            nextOffset: next,
            embedded: size,
            reused: 0,
            rows,
          };
          yield* commitCodeGraphGenerationStep(sql, step);
          yield* commitCodeGraphGenerationStep(sql, step);
          offset = next;
          cursor = step.nextCursor;
        }
        const expectedCount = pageSizes.reduce((sum, size) => sum + size, 0);
        expect(yield* completeCodeGraphGeneration(sql, 'target', owner)).toBe(expectedCount);
        const rows = yield* sql.unsafe<{symbol_id: string; fingerprint: string; vector: Uint8Array}>(
          'SELECT symbol_id, fingerprint, vector FROM vectors ORDER BY symbol_id',
        );
        expect(
          rows.map(row => ({id: row.symbol_id, fingerprint: row.fingerprint, payload: Array.from(row.vector)})),
        ).toEqual(
          Array.from({length: expectedCount}, (_, n) => ({
            id: String(n).padStart(4, '0'),
            fingerprint: `fingerprint-${n}`,
            payload: [n],
          })),
        );
        expect(yield* sql.unsafe('SELECT array_offset, embedded FROM vector_generation_progress')).toEqual([
          {array_offset: expectedCount, embedded: expectedCount},
        ]);
      }),
    {arbitrary: {runs: 24, seed: 17291}},
  );
});
