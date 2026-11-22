import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {reusableCleanBaseSlicePaths} from '@threadnote/graph/store/queries';
import {codeGraphExactSymbolQueryStatement} from '@threadnote/graph/store/query/core';
import {Database} from 'bun:sqlite';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('code graph persisted-base slice bounds', () => {
  it('caps exact preview index hits before ranking and base suppression', () => {
    using database = new Database(':memory:');
    database.exec(`CREATE TABLE symbols (
      snapshot_id TEXT, id TEXT, name TEXT, qualified_name TEXT, path TEXT, kind TEXT, exported INTEGER,
      PRIMARY KEY (snapshot_id, id)
    );
    CREATE TABLE snapshot_symbol_deletions (snapshot_id TEXT, symbol_id TEXT, PRIMARY KEY (snapshot_id, symbol_id));
    CREATE INDEX symbols_name_nocase ON symbols(snapshot_id, name COLLATE NOCASE);
    CREATE INDEX symbols_qualified_nocase ON symbols(snapshot_id, qualified_name COLLATE NOCASE);
    CREATE INDEX symbols_path_nocase ON symbols(snapshot_id, path COLLATE NOCASE);
    WITH RECURSIVE duplicates(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM duplicates WHERE n < 999)
    INSERT INTO symbols
    SELECT 'base', printf('%04d', n), 'sharedSymbol', 'scope.sharedSymbol', n || '.ts', 'function', n >= 8
    FROM duplicates;`);
    const preview = codeGraphExactSymbolQueryStatement('current', 'base', 'sharedSymbol', 8, true);
    const strict = codeGraphExactSymbolQueryStatement('current', 'base', 'sharedSymbol', 8);
    const select = (statement: typeof preview) =>
      database.query<{id: string; exported: number}, (number | string)[]>(statement.text).all(...statement.parameters);
    const sample = select(preview);
    expect(sample).toHaveLength(8);
    expect(EffectArray.every(sample, row => row.exported === 0)).toBe(true);
    for (const {id} of sample.slice(0, 4)) {
      database.exec(
        "INSERT INTO symbols VALUES ('current', ?, 'renamed', 'scope.renamed', 'renamed.ts', 'function', 1)",
        [id],
      );
    }
    for (const {id} of sample.slice(4))
      database.exec("INSERT INTO snapshot_symbol_deletions VALUES ('current', ?)", [id]);
    expect(select(preview)).toEqual([]);
    expect(select(strict)).toHaveLength(8);
    expect(EffectArray.every(select(strict), row => row.exported === 1)).toBe(true);
  });

  it('canonicalizes every bounded unique path set without changing membership', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc
            .array(fc.constantFrom(...Effect.pipe('abcdefghijklmnopqrstuvwxyz0123456789_-/', EffectString.split(''))), {
              maxLength: 80,
              minLength: 1,
            })
            .map(parts => EffectArray.join(parts, ''))
            .filter(path =>
              EffectArray.every(Effect.pipe(path, EffectString.split('/')), segment => segment.length > 0),
            ),
          {maxLength: 200, minLength: 1},
        ),
        paths => {
          const canonical = reusableCleanBaseSlicePaths(paths);
          expect(canonical).toBeDefined();
          if (canonical === undefined) throw new Error('Expected a bounded canonical path set.');
          expect(new Set(canonical)).toEqual(new Set(paths));
          expect(canonical).toEqual([...canonical].sort());
          expect(reusableCleanBaseSlicePaths([...paths].reverse())).toEqual(canonical);
        },
      ),
      {numRuns: 250},
    );
  });

  it('fails closed for duplicate, empty, oversized, or NUL-containing requests', () => {
    expect(reusableCleanBaseSlicePaths([])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(['src/a.ts', 'src/a.ts'])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(['src/a\0.ts'])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(['/src/a.ts'])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(['src/../a.ts'])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(['src\\a.ts'])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths([Effect.pipe('x', EffectString.repeat(4_097))])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(Array.from({length: 201}, (_, index) => `src/${index}.ts`))).toBeUndefined();
  });
});
