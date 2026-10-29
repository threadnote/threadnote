import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, Exit, FileSystem, Layer, Path, Schema, Scope} from 'effect';
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
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

effectIt.layer(BunServices.layer)(it => {
  it.effect.prop(
    'disk reopen, retries and expired-owner resumes preserve exactly the independently expected symbol set',
    {
      pageSizes: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 8}))).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(8),
      ),
      resumes: Schema.Array(Schema.Boolean).check(Schema.isMaxLength(8)),
    },
    ({pageSizes, resumes}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-generation-property-'});
        const filename = path.join(root, 'graph.sqlite');
        const open = Effect.gen(function* () {
          const scope = yield* Effect.acquireRelease(Scope.make(), scope => Scope.close(scope, Exit.void));
          const context = yield* Layer.buildWithScope(SqliteClient.layer({filename}), scope);
          return {scope, sql: Context.get(context, SqlClient.SqlClient)};
        });
        let connection = yield* open;
        let sql = connection.sql;
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
          [Effect2.pipe('a', EffectString.repeat(64))],
        );
        let owner = 'owner-0';
        let offset = 0;
        let cursor: string | null = null;
        yield* claimCodeGraphGeneration(sql, {generation: 'target', ownerToken: owner, requestEpoch: 'epoch'});
        for (const [index, size] of pageSizes.entries()) {
          // Close the previous client completely: a second live connection would not
          // exercise recovery from a persisted checkpoint.
          yield* Scope.close(connection.scope, Exit.void);
          connection = yield* open;
          sql = connection.sql;
          expect(yield* sql.unsafe('SELECT cursor, array_offset, embedded FROM vector_generation_progress')).toEqual([
            {cursor, array_offset: offset, embedded: offset},
          ]);
          const previousOwner = owner;
          const reclaimed = index === 0 || resumes[index];
          if (reclaimed) {
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
                Effect2.pipe(String(offset + n), EffectString.padStart(4, '0')),
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
          if (reclaimed) {
            expect(
              (yield* commitCodeGraphGenerationStep(sql, {...step, ownerToken: previousOwner}).pipe(Effect.result))
                ._tag,
            ).toBe('Failure');
            expect((yield* completeCodeGraphGeneration(sql, 'target', previousOwner).pipe(Effect.result))._tag).toBe(
              'Failure',
            );
            expect(yield* sql.unsafe('SELECT state FROM vector_generations')).toEqual([{state: 'building'}]);
          }
          yield* commitCodeGraphGenerationStep(sql, step);
          yield* commitCodeGraphGenerationStep(sql, step);
          offset = next;
          cursor = step.nextCursor;
        }
        yield* Scope.close(connection.scope, Exit.void);
        connection = yield* open;
        sql = connection.sql;
        const expectedCount = EffectArray.reduce(pageSizes, 0, (sum, size) => sum + size);
        expect(yield* completeCodeGraphGeneration(sql, 'target', owner)).toBe(expectedCount);
        const rows = yield* sql.unsafe<{symbol_id: string; fingerprint: string; vector: Uint8Array}>(
          'SELECT symbol_id, fingerprint, vector FROM vectors ORDER BY symbol_id',
        );
        expect(
          EffectArray.map(rows, row => ({
            id: row.symbol_id,
            fingerprint: row.fingerprint,
            payload: Array.from(row.vector),
          })),
        ).toEqual(
          Array.from({length: expectedCount}, (_, n) => ({
            id: Effect2.pipe(String(n), EffectString.padStart(4, '0')),
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
