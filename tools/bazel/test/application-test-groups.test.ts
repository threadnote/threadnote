import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {groupApplicationTests} from '../application-test-groups.mjs';

describe('generated application test groups', () => {
  it('keeps feature families readable and bounds large families', () => {
    const paths = [
      ...Array.from({length: 70}, (_, index) => `apps/threadnote/test/unit/code-graph.case-${index}.test.ts`),
      'apps/threadnote/test/unit/manager-state.test.ts',
      'apps/threadnote/test/integration/manager-runtime.test.ts',
    ];

    const groups = groupApplicationTests(paths, {maxEntries: 8, minFeatureEntries: 2, targetEntries: 4});

    expect(groups.find(group => group.name === 'test_standard_manager')?.entries).toHaveLength(2);
    expect(groups.filter(group => group.name.startsWith('test_standard_code_graph_')).length).toBeGreaterThan(1);
    expect(groups.every(group => group.entries.length <= 8)).toBe(true);
  });

  it('keeps small feature families together while pooling their process overhead', () => {
    const paths = [
      ...Array.from({length: 3}, (_, index) => `apps/threadnote/test/unit/telemetry-case-${index}.test.ts`),
      ...Array.from({length: 3}, (_, index) => `apps/threadnote/test/unit/update-case-${index}.test.ts`),
      ...Array.from({length: 3}, (_, index) => `apps/threadnote/test/unit/windows-case-${index}.test.ts`),
    ];

    const groups = groupApplicationTests(paths, {maxEntries: 6, minFeatureEntries: 4, targetEntries: 4});

    expect(groups.length).toBeGreaterThan(1);
    for (const feature of ['telemetry', 'update', 'windows']) {
      const owners = groups.filter(group => group.entries.some((entry: string) => entry.includes(`/${feature}-`)));
      expect(owners).toHaveLength(1);
    }
  });

  it('keeps tests with different integration source closures in separate targets', () => {
    const paths = [
      'apps/threadnote/test/unit/github-connect.test.ts',
      'apps/threadnote/test/unit/github-refresh.test.ts',
      'apps/threadnote/test/unit/pocket-connect.test.ts',
      'apps/threadnote/test/unit/neutral-config.test.ts',
    ];
    const groups = groupApplicationTests(paths, {
      maxEntries: 4,
      minFeatureEntries: 2,
      targetEntries: 3,
      affinities: {
        [paths[0]]: 'integration_github',
        [paths[1]]: 'integration_github',
        [paths[2]]: 'integration_pocket',
      },
    });

    expect(groups.find(group => group.name === 'test_standard_integration_github_github')?.entries).toEqual([
      paths[0],
      paths[1],
    ]);
    expect(groups.find(group => group.name === 'test_standard_integration_pocket_pooled')?.entries).toEqual([paths[2]]);
    expect(groups.find(group => group.name === 'test_standard_pooled')?.entries).toEqual([paths[3]]);
  });

  it('is deterministic, complete, bounded, and duplicate-free', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 400}), {maxLength: 150}), values => {
        const paths = values.map(
          value =>
            `apps/threadnote/test/unit/${value % 3 === 0 ? 'code-graph' : `feature-${value % 12}`}.case-${value}.test.ts`,
        );
        const first = groupApplicationTests(paths, {maxEntries: 12, minFeatureEntries: 4, targetEntries: 6});
        const second = groupApplicationTests([...paths].reverse(), {
          maxEntries: 12,
          minFeatureEntries: 4,
          targetEntries: 6,
        });
        const grouped = first.flatMap(group => group.entries);

        expect(first).toEqual(second);
        expect(grouped.sort()).toEqual([...paths].sort());
        expect(new Set(grouped).size).toBe(paths.length);
        expect(first.every(group => group.entries.length <= 12)).toBe(true);
        expect(new Set(first.map(group => group.name)).size).toBe(first.length);
      }),
      {numRuns: 100},
    );
  });
});
