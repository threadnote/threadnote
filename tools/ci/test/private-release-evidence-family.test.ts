import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  classifyPurePrivateReleaseEvidenceDiff,
  privateReleaseEvidenceFamilies,
} from '../private-release-evidence-family.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const expectedPrivateReleaseEvidenceFamilies = [
  {
    focusedTestPaths: ['apps/threadnote/test/unit/evaluation.threadnote-5-product-capture.test.ts'],
    name: 'threadnote-5-product-capture',
    paths: [
      'apps/threadnote/src/evaluation/threadnote-5-product-capture-events.ts',
      'apps/threadnote/src/evaluation/threadnote-5-product-capture-sink.ts',
      'apps/threadnote/src/evaluation/threadnote-5-product-capture.ts',
      'apps/threadnote/test/unit/evaluation.threadnote-5-product-capture.test.ts',
    ],
  },
  {
    focusedTestPaths: [
      'apps/threadnote/test/unit/evaluation.threadnote-5-collection-integrity.test.ts',
      'apps/threadnote/test/unit/evaluation.threadnote-5-release-collection.test.ts',
    ],
    name: 'threadnote-5-release-collection',
    paths: [
      'docs/development/threadnote-5-private-collection.md',
      'scripts/collect-threadnote-5-release-readiness.ts',
      'scripts/threadnote-5-collection-process.ts',
      'scripts/threadnote-5-collection-runner.ts',
      'scripts/threadnote-5-collection-transport.ts',
      'apps/threadnote/src/evaluation/threadnote-5-release-collection-envelope.ts',
      'apps/threadnote/src/evaluation/threadnote-5-release-collection.ts',
      'apps/threadnote/test/helpers/threadnote-5-collection-transcripts.ts',
      'apps/threadnote/test/unit/evaluation.threadnote-5-collection-integrity.test.ts',
      'apps/threadnote/test/unit/evaluation.threadnote-5-release-collection.test.ts',
    ],
  },
] as const;

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Effect.pipe(left, EffectString.localeCompare(right)));
}

function expectSelection(
  selection: ReturnType<typeof classifyPurePrivateReleaseEvidenceDiff>,
  expected: (typeof expectedPrivateReleaseEvidenceFamilies)[number],
): void {
  expect(selection).toBeDefined();
  if (!selection) return;
  expect(selection.name).toBe(expected.name);
  expect(sorted(selection.focusedTestPaths)).toEqual(sorted(expected.focusedTestPaths));
}

describe('private release-evidence family registry', () => {
  it('has unique family names and exact paths', () => {
    const names = EffectArray.map(privateReleaseEvidenceFamilies, family => family.name);
    const paths = EffectArray.flatMap(privateReleaseEvidenceFamilies, family => family.paths);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(paths).size).toBe(paths.length);
    expect(sorted(names)).toEqual(
      sorted(EffectArray.map(expectedPrivateReleaseEvidenceFamilies, family => family.name)),
    );
    for (const expectedFamily of expectedPrivateReleaseEvidenceFamilies) {
      const actualFamily = EffectOption.getOrUndefined(
        EffectArray.findFirst(privateReleaseEvidenceFamilies, family => family.name === expectedFamily.name),
      );
      expect(actualFamily).toBeDefined();
      if (!actualFamily) continue;
      expect(sorted(actualFamily.paths)).toEqual(sorted(expectedFamily.paths));
      expect(sorted(actualFamily.focusedTestPaths)).toEqual(sorted(expectedFamily.focusedTestPaths));
    }
    for (const family of privateReleaseEvidenceFamilies) {
      expect(family.paths.length).toBeGreaterThan(0);
      expect(family.focusedTestPaths.length).toBeGreaterThan(0);
      expect(new Set(family.focusedTestPaths).size).toBe(family.focusedTestPaths.length);
      const familyPaths = new Set<string>(family.paths);
      expect(EffectArray.every(family.focusedTestPaths, path => familyPaths.has(path))).toBe(true);
    }
  });

  it('selects one family and its focused-test union for every non-empty subset', () => {
    for (const family of expectedPrivateReleaseEvidenceFamilies) {
      fc.assert(
        fc.property(fc.shuffledSubarray([...family.paths], {minLength: 1}), paths => {
          expectSelection(classifyPurePrivateReleaseEvidenceDiff(paths), family);
        }),
        {numRuns: 100},
      );
    }
  });

  it('is order and duplicate invariant while mixed, adjacent, malformed, and noncanonical paths fail safe', () => {
    for (const family of expectedPrivateReleaseEvidenceFamilies) {
      fc.assert(
        fc.property(fc.shuffledSubarray([...family.paths], {minLength: 1}), paths => {
          const selection = classifyPurePrivateReleaseEvidenceDiff(paths);
          expectSelection(selection, family);
          expectSelection(classifyPurePrivateReleaseEvidenceDiff([...paths].reverse()), family);
          expectSelection(classifyPurePrivateReleaseEvidenceDiff([...paths, ...paths]), family);
          expect(classifyPurePrivateReleaseEvidenceDiff([...paths, 'src/evaluation/not-listed.ts'])).toBeUndefined();
          expect(classifyPurePrivateReleaseEvidenceDiff(EffectArray.map(paths, path => `./${path}`))).toBeUndefined();
          expect(
            classifyPurePrivateReleaseEvidenceDiff(
              EffectArray.map(paths, path => Effect.pipe(path, EffectString.replaceAll('/', '\\'))),
            ),
          ).toBeUndefined();
        }),
        {numRuns: 100},
      );
    }
    const [first, second] = expectedPrivateReleaseEvidenceFamilies;
    expect(classifyPurePrivateReleaseEvidenceDiff([first.paths[0], second.paths[0]])).toBeUndefined();
    expect(
      classifyPurePrivateReleaseEvidenceDiff(['../apps/threadnote/src/evaluation/threadnote-5-product-capture.ts']),
    ).toBeUndefined();
    // @ts-expect-error A malformed iterable item must be rejected without widening the production input type.
    expect(classifyPurePrivateReleaseEvidenceDiff([undefined])).toBeUndefined();
  });
});
