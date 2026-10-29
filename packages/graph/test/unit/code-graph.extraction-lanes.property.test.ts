import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphExtractionWindowSize,
  createCodeGraphExtractionCostModel,
  planCodeGraphExtractionLanes,
  takeCodeGraphExtractionWindow,
} from '@threadnote/graph/extraction_lanes';

interface TestGroup {
  readonly files: readonly {readonly language: string; readonly path: string; readonly size: number}[];
  readonly id: string;
}

const groupArbitrary = fc.record({
  files: fc.array(
    fc.record({
      language: fc.constantFrom('typescript', 'json', 'yaml', 'python'),
      path: fc.stringMatching(/^src\/[a-z0-9-]{1,16}\.(?:ts|json|yaml|py)$/u),
      size: fc.integer({max: 2 * 1_048_576, min: 0}),
    }),
    {maxLength: 4, minLength: 1},
  ),
  id: fc.uuid(),
});

describe('code graph extraction scheduling', () => {
  it('scales the retained extraction window monotonically within the absolute file bound', () => {
    fc.assert(
      fc.property(fc.integer({max: 8, min: 1}), fc.integer({max: 8, min: 1}), (left, right) => {
        const lower = Math.min(left, right);
        const upper = Math.max(left, right);
        expect(codeGraphExtractionWindowSize(lower)).toBeLessThanOrEqual(codeGraphExtractionWindowSize(upper));
        expect(codeGraphExtractionWindowSize(lower)).toBe(Math.min(96, lower * 36));
        expect(codeGraphExtractionWindowSize(upper)).toBe(Math.min(96, upper * 36));
      }),
      {numRuns: 100},
    );
    expect(() => codeGraphExtractionWindowSize(0)).toThrow(/capacity/u);
  });

  it('preserves every reuse group exactly once in deterministic longest-predicted-time order', () => {
    fc.assert(
      fc.property(fc.array(groupArbitrary, {maxLength: 40}), fc.integer({max: 16, min: 1}), (groups, capacity) => {
        const model = createCodeGraphExtractionCostModel<TestGroup>();
        const first = planCodeGraphExtractionLanes(groups, capacity, model);
        const second = planCodeGraphExtractionLanes(groups, capacity, model);

        expect(first).toEqual(second);
        expect(first).toHaveLength(groups.length === 0 ? 0 : 1);
        const planned = EffectArray.flatMap(first, lane => lane.groups);
        expect(EffectArray.map(planned, group => group.id).sort()).toEqual(
          EffectArray.map(groups, group => group.id).sort(),
        );
        expect(EffectArray.every(first, lane => lane.concurrency === capacity && lane.kind === 'cost-ordered')).toBe(
          true,
        );
        const scores = EffectArray.map(planned, group => model.estimate(group).score);
        expect(scores).toEqual([...scores].sort((left, right) => right - left));
      }),
      {numRuns: 250},
    );
  });

  it('is permutation invariant when group path keys are unique', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(groupArbitrary, {
          comparator: (left, right) => left.files[0].path === right.files[0].path,
          maxLength: 32,
        }),
        fc.integer({max: 16, min: 1}),
        (groups, capacity) => {
          const reversed = [...groups].reverse();
          const planned = EffectArray.flatMap(planCodeGraphExtractionLanes(groups, capacity), lane =>
            EffectArray.map(lane.groups, group => group.id),
          );
          const replanned = EffectArray.flatMap(planCodeGraphExtractionLanes(reversed, capacity), lane =>
            EffectArray.map(lane.groups, group => group.id),
          );
          expect(planned).toEqual(replanned);
        },
      ),
      {numRuns: 150},
    );
  });

  it('learns language/size request and fact cost without depending on observation completion order', () => {
    const typescript = group('typescript', 'src/a.ts', 32 * 1_024);
    const python = group('python', 'src/b.py', 32 * 1_024);
    const observations = [
      {factsBytes: 8 * 1_024, file: typescript.files[0], requestMilliseconds: 2},
      {factsBytes: 512 * 1_024, file: python.files[0], requestMilliseconds: 80},
    ];
    const schedule = (ordered: typeof observations) => {
      const model = createCodeGraphExtractionCostModel<TestGroup>();
      for (const {file, ...observation} of ordered) model.observe(file, observation);
      return {
        estimates: [model.estimate(typescript), model.estimate(python)],
        order: EffectArray.flatMap(planCodeGraphExtractionLanes([typescript, python], 4, model), lane =>
          EffectArray.map(lane.groups, candidate => candidate.id),
        ),
      };
    };

    expect(schedule(observations)).toEqual(schedule([...observations].reverse()));
    expect(schedule(observations).order).toEqual(['src/b.py', 'src/a.ts']);
  });

  it('partitions scheduled files within the exact window bound without loss or duplication', () => {
    fc.assert(
      fc.property(fc.array(groupArbitrary, {maxLength: 80}), fc.integer({max: 32, min: 1}), (groups, maximumFiles) => {
        const remaining = [...groups];
        const selected: TestGroup[] = [];
        while (remaining.length > 0) {
          const [window, rest] = takeCodeGraphExtractionWindow(remaining, maximumFiles);
          expect(window.length).toBeGreaterThan(0);
          const windowFiles = EffectArray.reduce(window, 0, (total, group) => total + group.files.length);
          expect(windowFiles).toBeLessThanOrEqual(maximumFiles);
          selected.push(...window);
          remaining.splice(0, remaining.length, ...rest);
        }
        expect(EffectArray.flatMap(selected, group => group.files)).toEqual(
          EffectArray.flatMap(groups, group => group.files),
        );
      }),
      {numRuns: 200},
    );
  });

  it('balances bounded windows so the final extraction wave is not underfilled', () => {
    fc.assert(
      fc.property(fc.array(groupArbitrary, {maxLength: 160}), fc.integer({max: 64, min: 1}), (groups, maximumFiles) => {
        const remaining = [...groups];
        const windowSizes: number[] = [];
        while (remaining.length > 0) {
          const [window, rest] = takeCodeGraphExtractionWindow(remaining, maximumFiles);
          windowSizes.push(EffectArray.reduce(window, 0, (total, group) => total + group.files.length));
          remaining.splice(0, remaining.length, ...rest);
        }
        if (windowSizes.length > 1) {
          expect(Math.max(...windowSizes) - Math.min(...windowSizes)).toBeLessThanOrEqual(1);
        }
      }),
      {numRuns: 200},
    );

    const heavyTailGroups = Array.from({length: 268}, (_, index) =>
      group('typescript', `src/heavy-tail-${index}.ts`, 1),
    );
    const windowSizes: number[] = [];
    let remaining: readonly TestGroup[] = heavyTailGroups;
    while (remaining.length > 0) {
      const [window, rest] = takeCodeGraphExtractionWindow(remaining, codeGraphExtractionWindowSize(8));
      windowSizes.push(EffectArray.reduce(window, 0, (total, candidate) => total + candidate.files.length));
      remaining = rest;
    }
    expect(windowSizes).toEqual([90, 89, 89]);
  });

  it('rejects empty groups, invalid capacity, and malformed observations', () => {
    const model = createCodeGraphExtractionCostModel<TestGroup>();
    expect(() => planCodeGraphExtractionLanes([group('typescript', 'src/a.ts', 1)], 0, model)).toThrow(/capacity/u);
    expect(() => model.estimate({files: [], id: 'empty'})).toThrow(/empty/u);
    expect(() =>
      model.observe(group('typescript', 'src/a.ts', 1).files[0], {factsBytes: -1, requestMilliseconds: 1}),
    ).toThrow(/observation/u);
  });
});

function group(language: string, path: string, size: number): TestGroup {
  return {files: [{language, path, size}], id: path};
}
