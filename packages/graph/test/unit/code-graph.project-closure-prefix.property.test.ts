import {Array as EffectArray, Predicate} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  boundedSnapshotProjectPrefixes,
  codeGraphSnapshotProjectClosureStatement,
} from '@threadnote/graph/store/project_closure';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('bounded snapshot project prefixes', () => {
  fcProp(
    it,
    'is permutation-invariant and preserves exactly the same descendant coverage',
    {
      reverse: FC.boolean(),
      roots: FC.uniqueArray(
        FC.tuple(FC.stringMatching(/^[a-z][a-z0-9]{0,8}$/), FC.stringMatching(/^[a-z][a-z0-9]{0,8}$/)).map(
          ([parent, child]) => `packages/${parent}/${child}`,
        ),
        {maxLength: 40, minLength: 1},
      ),
    },
    ({reverse, roots}) => {
      const withAncestors = EffectArray.flatMap(roots, (root, index) =>
        index % 3 === 0
          ? [
              root,
              Effect.pipe(
                root,
                EffectString.slice(
                  0,
                  Effect.pipe(
                    root,
                    EffectString.lastIndexOf('/'),
                    Effect.Option.getOrElse(() => -1),
                  ),
                ),
              ),
            ]
          : [root],
      );
      const input = reverse ? [...withAncestors].reverse() : withAncestors;
      const canonical = boundedSnapshotProjectPrefixes(input);
      const repeated = boundedSnapshotProjectPrefixes([...(canonical ?? [])].reverse());

      expect(canonical).toBeDefined();
      if (canonical === undefined) return;
      expect(repeated).toEqual(canonical);
      for (const root of roots) {
        expect(
          EffectArray.some(
            canonical,
            prefix => root === prefix || Effect.pipe(root, EffectString.startsWith(`${prefix}/`)),
          ),
        ).toBe(true);
      }
      expect(
        EffectArray.some(canonical, (prefix, index) =>
          EffectArray.some(
            canonical,
            (other, otherIndex) => otherIndex !== index && Effect.pipe(prefix, EffectString.startsWith(`${other}/`)),
          ),
        ),
      ).toBe(false);
    },
    {fastCheck: {numRuns: 250}},
  );

  it('rejects roots that could select the repository or escape canonical path bounds', () => {
    expect(boundedSnapshotProjectPrefixes([''])).toBeUndefined();
    expect(boundedSnapshotProjectPrefixes(['/absolute'])).toBeUndefined();
    expect(boundedSnapshotProjectPrefixes(['packages/../outside'])).toBeUndefined();
    expect(boundedSnapshotProjectPrefixes(['packages\\outside'])).toBeUndefined();
  });

  it('probes every project prefix through the snapshot primary key without a TEMP sort', () => {
    const database = new Database(':memory:');
    try {
      database.run(`CREATE TABLE snapshot_files (
        snapshot_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        language TEXT NOT NULL,
        mode TEXT NOT NULL,
        size INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, path)
      ) WITHOUT ROWID`);
      const statement = codeGraphSnapshotProjectClosureStatement('snapshot', ['packages/app', 'packages/core']);
      const plan = EffectArray.map(
        database.query(`EXPLAIN QUERY PLAN ${statement.text}`).all(...statement.parameters),
        row => {
          if (!Predicate.isObject(row) || typeof row.detail !== 'string')
            throw new Error('SQLite query plan row is missing its detail.');
          return row.detail;
        },
      );

      expect(plan).toContain('SEARCH file USING PRIMARY KEY (snapshot_id=? AND path>? AND path<?)');
      expect(EffectArray.some(plan, detail => Effect.pipe(detail, EffectString.includes('USE TEMP B-TREE')))).toBe(
        false,
      );
    } finally {
      database.close(false);
    }
  });
});
