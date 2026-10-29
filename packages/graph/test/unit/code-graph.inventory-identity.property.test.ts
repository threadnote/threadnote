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
