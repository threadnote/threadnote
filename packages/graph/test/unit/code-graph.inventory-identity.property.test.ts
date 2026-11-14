import * as EffectString from 'effect/String';
import {
  projectLexicalSymbols,
  lexicalFileOrdinals,
  lexicalPhysicalSnapshotIdentity,
  lexicalViewBindingMatches,
  parseLexicalViewBinding,
} from '@threadnote/graph/store/utilities';
import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphContentIdentity, createCodeGraphContentIdentityAccumulator} from '@threadnote/graph/graph_identity';
import {codeGraphInventorySha256Hex} from '@threadnote/graph/inventory/identity';
import {compareCodeUnits} from '@threadnote/graph/ordering';

describe('code graph inventory identity', () => {
  it('matches the canonical one-shot digest for arbitrary ordering and Unicode without mutating input', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            contentHash: fc.string({maxLength: 32}),
            path: fc.string({maxLength: 64}),
            source: fc.string({maxLength: 16}),
          }),
          {maxLength: 200},
        ),
        fc.string({maxLength: 64}),
        (files, prefix) => {
          const before = EffectArray.map(files, file => ({...file}));
          const line = (file: (typeof files)[number]) => `${file.path}\0${file.contentHash}\0${file.source}`;
          const canonicalRows = EffectArray.map(files, line).sort();

          expect(codeGraphInventorySha256Hex(prefix, files, line)).toBe(
            sha256HexSync(`${prefix}${EffectArray.join(canonicalRows, '\n')}`),
          );
          expect(files).toEqual(before);
        },
      ),
      {numRuns: 150},
    );
  });

  it('matches bounded streaming graph identity across UTF-16 and UTF-8 order boundaries', () => {
    const path = fc
      .array(fc.constantFrom('a', 'z', '\ud7ff', '\ue000', '\uffff', '🙂', '𐀀'), {maxLength: 12, minLength: 1})
      .map(parts => `src/${EffectArray.join(parts, '')}.ts`);
    fc.assert(
      fc.property(fc.uniqueArray(path, {maxLength: 100}), paths => {
        const files = EffectArray.map(paths, (value, index) => ({
          contentHash: sha256HexSync(`content-${index}`),
          language: 'typescript',
          mode: '100644',
          path: value,
        }));
        const accumulator = createCodeGraphContentIdentityAccumulator('extractor-set');
        for (const file of [...files].sort((left, right) => compareCodeUnits(left.path, right.path))) {
          accumulator.update(file);
        }
        expect(accumulator.digest()).toBe(codeGraphContentIdentity('extractor-set', [...files].reverse()));
      }),
      {numRuns: 100},
    );
  });
});

it('keeps contributor keys and physical categories invariant under whole-file batch repartition', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.constantFrom('src/a.ts', 'src/𐀀.ts', 'src/\ue000.ts', 'src/empty.ts'), {
        minLength: 1,
        maxLength: 4,
      }),
      fc.integer({min: 1, max: 4}),
      (paths, width) => {
        const files = lexicalFileOrdinals(paths);
        const groups = EffectArray.map(paths, (path, index) =>
          EffectArray.map(EffectArray.range(0, index + 1), ordinal => ({
            id: `cgs_${EffectString.padStart(32, '0')((index * 100 + ordinal).toString(16))}`,
            path,
            contentHash: sha256HexSync(path),
            name: 'sharedPending',
            qualifiedName: 'Owner.sharedPending',
            kind: 'function',
            language: 'typescript',
            exported: true,
            packageName: ordinal % 2 === 0 ? 'package/shared' : undefined,
            span: {line: ordinal + 1, column: 1, endLine: ordinal + 1, endColumn: 2},
          })),
        );
        const complete = projectLexicalSymbols(EffectArray.flatten(groups), [], files);
        const batches = [];
        for (let start = 0; start < groups.length; start += width)
          batches.push(projectLexicalSymbols(EffectArray.flatten(groups.slice(start, start + width)), [], files));
        const roleRows = (projection: ReturnType<typeof projectLexicalSymbols>) => [
          ...EffectArray.map(projection.scopes, row => JSON.stringify(['scope', row])),
          ...EffectArray.map(projection.members, row => JSON.stringify(['member', row])),
          ...EffectArray.map(projection.owners, ({termOrdinal, ...row}) =>
            JSON.stringify(['owner', projection.terms[termOrdinal], row]),
          ),
          ...EffectArray.map(projection.shared, ({termOrdinal, ...row}) =>
            JSON.stringify(['shared', projection.terms[termOrdinal], row]),
          ),
        ];
        expect(EffectArray.flatMap(batches, roleRows).sort()).toEqual(roleRows(complete).sort());
        const dictionary = new Set(EffectArray.flatMap(batches, batch => batch.terms));
        expect(
          EffectArray.reduce(batches, 0, (total, batch) => total + batch.physicalRowCount - batch.terms.length) +
            dictionary.size,
        ).toBe(complete.physicalRowCount);
        expect(EffectArray.reduce(batches, 0, (total, batch) => total + batch.logicalPostingCount)).toBe(
          complete.logicalPostingCount,
        );
      },
    ),
    {numRuns: 40},
  );
});

it('binds actual view identity to exact logical identity, layout, base and generation', () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(...'0123456789abcdef'), {minLength: 40, maxLength: 40})
        .map(parts => EffectArray.join(parts, '')),
      fc
        .array(fc.constantFrom(...'0123456789abcdef'), {minLength: 40, maxLength: 40})
        .map(parts => EffectArray.join(parts, '')),
      (digest, baseDigest) => {
        const logical = `cgsn_${digest}`;
        const base = lexicalPhysicalSnapshotIdentity(`cgsn_${baseDigest}`, 'full');
        const binding = {
          logicalSnapshotId: logical,
          mode: 'overlay' as const,
          baseSnapshotId: base,
          orderRevision: 1 as const,
        };
        const actual = lexicalPhysicalSnapshotIdentity(logical, 'overlay', base);
        expect(lexicalViewBindingMatches(actual, logical, binding)).toBe(true);
        expect(parseLexicalViewBinding(JSON.stringify(binding))).toEqual(binding);
        expect(lexicalViewBindingMatches(actual, logical, {...binding, mode: 'alias'})).toBe(false);
        expect(lexicalViewBindingMatches(actual, logical, {...binding, forceGeneration: '0123456789abcdef'})).toBe(
          false,
        );
        expect(lexicalViewBindingMatches(actual, base, binding)).toBe(false);
        expect(parseLexicalViewBinding(JSON.stringify({...binding, extra: 'ignored'}))).toBeUndefined();
        expect(parseLexicalViewBinding(JSON.stringify({...binding, mode: 'other'}))).toBeUndefined();
      },
    ),
    {numRuns: 40},
  );
});
