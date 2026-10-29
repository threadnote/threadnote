import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {expect, it} from 'vitest';
import {selectTargets} from '../../ci/selection.mjs';

const inventory = ['//:graph_test', '//apps/website:build', '//apps/website:content_test'];
const select = (impacted: string[], changedFiles = ['apps/website/src/page.tsx'], failure?: string) =>
  selectTargets({
    inventory,
    impacted,
    changedFiles,
    knownInputs: ['apps/website/src/page.tsx'],
    targetInputs: {'//apps/website:build': ['apps/website/src/page.tsx']},
    failure,
  });

it('selects no graph target for website-only graph impact, independent of cache state', () => {
  expect(select(['//apps/website:content_test', '//apps/website:build']).targets).toEqual([
    '//apps/website:build',
    '//apps/website:content_test',
  ]);
});

it('falls back to every modeled target for absent evidence and unknown inputs', () => {
  expect(select([], [], 'missing baseline').targets).toEqual([...inventory].sort());
  expect(select([], ['new/unmodeled.ts']).mode).toBe('fallback');
  expect(select([], ['new/unmodeled.ts']).targets).toEqual([...inventory].sort());
});

it('selects inventory-only CI and native targets from their declared inputs', () => {
  const result = selectTargets({
    inventory: ['//:workflow_validation', '//infra/gateway:go_test'],
    impacted: [],
    changedFiles: ['.github/workflows/ci.yml'],
    knownInputs: ['.github/workflows/ci.yml', 'infra/gateway/main.go'],
    targetInputs: {
      '//:workflow_validation': ['.github/workflows/ci.yml'],
      '//infra/gateway:go_test': ['infra/gateway/main.go'],
    },
  });
  expect(result).toMatchObject({mode: 'selective', targets: ['//:workflow_validation']});
});

it('propagates impacted Bazel targets into dependent CI lanes', () => {
  const result = selectTargets({
    inventory: ['//:recall_quality', '//:release_matrix', '//:threadnote_build', '//packages/inference:test'],
    impacted: ['//:threadnote_build', '//packages/inference:test'],
    changedFiles: ['packages/inference/src/provider.ts'],
    knownInputs: ['packages/inference/src/provider.ts'],
    targetDependencies: {
      '//:recall_quality': ['//packages/inference:test'],
      '//:release_matrix': ['//:threadnote_build'],
    },
  });

  expect(result.targets).toEqual([
    '//:recall_quality',
    '//:release_matrix',
    '//:threadnote_build',
    '//packages/inference:test',
  ]);
});

it('is deterministic and monotone as additional impacted targets are discovered', () => {
  fc.assert(
    fc.property(fc.subarray(inventory), fc.subarray(inventory), (first, second) => {
      const result = select([...first, ...second], []).targets;
      expect(result).toEqual([...new Set([...first, ...second])].sort());
      expect(result).toEqual(select([...second, ...first, ...first], []).targets);
      expect(EffectArray.every(select(first, []).targets, target => result.includes(target))).toBe(true);
    }),
    {numRuns: 50},
  );
});

it('models the module lockfile as a global input even when target hashes report no impact', () => {
  for (const changedFiles of [['MODULE.bazel.lock'], ['apps/website/src/page.tsx', 'MODULE.bazel.lock']]) {
    expect(select([], changedFiles)).toEqual({
      mode: 'fallback',
      reason: 'global-inputs',
      unknown: [],
      targets: [...inventory].sort(),
    });
  }
});

it('preserves analysis failure and genuinely unknown input diagnostics with a module lock change', () => {
  expect(select([], ['MODULE.bazel.lock'], 'missing baseline')).toMatchObject({
    reason: 'missing baseline',
    unknown: [],
    targets: [...inventory].sort(),
  });
  expect(select([], ['MODULE.bazel.lock', 'new/unmodeled.ts'])).toMatchObject({
    reason: 'unmodeled-inputs',
    unknown: ['new/unmodeled.ts'],
    targets: [...inventory].sort(),
  });
  for (const path of ['nested/MODULE.bazel.lock', 'MODULE.bazel.lock.backup']) {
    expect(select([], [path])).toMatchObject({reason: 'unmodeled-inputs', unknown: [path]});
  }
});

it('keeps global lock coverage complete and deterministic across mixed changes and duplicate inventory', () => {
  fc.assert(
    fc.property(
      fc.subarray(inventory, {minLength: 1}),
      fc.subarray(inventory),
      fc.array(fc.constantFrom('apps/website/src/page.tsx', 'new/unmodeled.ts', 'MODULE.bazel.lock'), {maxLength: 8}),
      (labels, impacted, changedFiles) => {
        const input = {
          inventory: [...labels, ...labels].reverse(),
          impacted,
          changedFiles,
          knownInputs: ['apps/website/src/page.tsx'],
        };
        const before = selectTargets(input);
        const withLock = selectTargets({...input, changedFiles: [...changedFiles, 'MODULE.bazel.lock']});
        expect(withLock.targets).toEqual([...labels].sort());
        expect(EffectArray.every(before.targets, label => withLock.targets.includes(label))).toBe(true);
        expect(withLock).toEqual(
          selectTargets({
            ...input,
            inventory: labels,
            impacted: [...impacted].reverse(),
            changedFiles: ['MODULE.bazel.lock', ...changedFiles].reverse(),
          }),
        );
      },
    ),
    {numRuns: 50},
  );
});
