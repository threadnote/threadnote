import {fcProp} from '@threadnote/testing/fast-check-property';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {describe, expect, it} from '@effect/vitest';
import {Effect, Result} from 'effect';
import * as FC from 'fast-check';
import * as SqlClient from 'effect/sql/SqlClient';
import {inspectCodeGraphQueryIndexes} from '@threadnote/graph/store/query/indexes';
import {normalizeSchemaDefinition} from '@threadnote/graph/store/schema/normalization';
import {normalizeSchemaDefinition as normalizeUncachedVectorSchema} from '@threadnote/graph/vector/retirement/inspection';
import {provideTestLayer} from '../helpers/effect-layer.js';

const literal = FC.array(FC.constantFrom('A', 'a', ' ', '\n', "'", '"', '`', '[', ']', ',', 'İ', '😀'), {
  maxLength: 40,
}).map(characters => characters.join(''));
const definition = FC.record({
  identifierQuote: FC.constantFrom('"', '`', '['),
  literal,
  optional: FC.boolean(),
  space: FC.constantFrom(' ', '\n', '\t', '  \n  '),
  suffix: FC.nat(100_000),
});

describe('bounded pure schema normalization', () => {
  fcProp(
    it,
    'preserves the SQL grammar model and quoted bytes across changed inputs and repetition',
    {definitions: FC.array(definition, {maxLength: 30, minLength: 1})},
    ({definitions}) => {
      for (const item of [...definitions, ...definitions.slice().reverse()]) {
        const quote = item.identifierQuote;
        const identifier = `${quote}Mixed_${item.suffix}${quote === '[' ? ']' : quote}`;
        const quotedLiteral = `'${item.literal.replaceAll("'", "''")}'`;
        const s = item.space;
        const input = `${s}CREATE${s}TABLE${s}${item.optional ? `IF NOT EXISTS${s}` : ''}${identifier}${s}(${s}value${s}TEXT${s}CHECK${s}(${s}value${s}=${s}${quotedLiteral}${s})${s})${s}`;
        const expected = `create table ${identifier}(value text check(value = ${quotedLiteral}))`;
        expect(normalizeSchemaDefinition(input)).toBe(expected);
        expect(normalizeSchemaDefinition(input)).toBe(expected);
      }
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'retains byte parity with the independent uncached vector-schema normalizer',
    {
      inputs: FC.array(
        FC.array(
          FC.constantFrom(
            'CREATE ',
            'IF NOT EXISTS',
            'Ab',
            '\u0000',
            '\n',
            'İ',
            '😀',
            "'",
            '"',
            '`',
            '[',
            ']',
            '(',
            ')',
            ',',
          ),
          {
            maxLength: 40,
          },
        ).map(parts => parts.join('')),
        {maxLength: 15, minLength: 1},
      ),
    },
    ({inputs}) => {
      for (const value of [...inputs, ...inputs.slice().reverse()]) {
        expect(normalizeSchemaDefinition(value)).toBe(normalizeUncachedVectorSchema(value));
      }
    },
    {fastCheck: {numRuns: 100}},
  );

  it('keeps results stable under entry churn, byte-budget pressure and oversized inputs', () => {
    const inputs = [
      '',
      ...Array.from({length: 160}, (_, index) => `CREATE TABLE short_${index}(value TEXT)`),
      ...Array.from(
        {length: 160},
        (_, index) => `CREATE TABLE churn_${index}(value TEXT DEFAULT '${'A'.repeat(4_000)}')`,
      ),
      `CREATE TABLE oversized(value TEXT DEFAULT '${'Q'.repeat(100_000)}')`,
    ];
    const expected = inputs.map(normalizeUncachedVectorSchema);
    for (const order of [inputs.map((_, index) => index), inputs.map((_, index) => index).reverse()]) {
      for (const index of order) expect(normalizeSchemaDefinition(inputs[index])).toBe(expected[index]);
    }
  });

  it.effect('rereads removed, corrupt and restored index definitions after warming normalization', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const definition = {
        createSql: 'CREATE INDEX IF NOT EXISTS symbols_path ON symbols(snapshot_id, path)',
        name: 'symbols_path',
        table: 'symbols' as const,
      };
      const inspect = () => inspectCodeGraphQueryIndexes(sql, [definition]);
      yield* sql.unsafe('CREATE TABLE symbols(snapshot_id TEXT, path TEXT)');
      yield* sql.unsafe(definition.createSql);
      expect(yield* inspect()).toEqual({missing: []});
      expect(yield* inspect()).toEqual({missing: []});
      yield* sql.unsafe('DROP INDEX symbols_path');
      expect(yield* inspect()).toEqual({missing: [definition]});
      yield* sql.unsafe('CREATE INDEX symbols_path ON symbols(path, snapshot_id)');
      expect(Result.isFailure(yield* inspect().pipe(Effect.result))).toBe(true);
      yield* sql.unsafe('DROP INDEX symbols_path');
      yield* sql.unsafe(definition.createSql);
      expect(yield* inspect()).toEqual({missing: []});
      yield* sql.unsafe('DROP INDEX symbols_path');
      yield* sql.unsafe('CREATE INDEX symbols_path ON symbols(snapshot_id, path COLLATE NOCASE)');
      expect(Result.isFailure(yield* inspect().pipe(Effect.result))).toBe(true);
    }).pipe(provideTestLayer(SqliteClient.layer({disableWAL: true, filename: ':memory:'}))),
  );
});
