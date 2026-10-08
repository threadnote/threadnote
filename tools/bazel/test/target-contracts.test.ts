import {describe, expect, it} from 'vitest';
import {ciRequiredLongRunningTestGroupNames} from '../../ci/vitest-plan.js';
import {selectTargets} from '../../ci/selection.mjs';
import {createVitestConfig} from '../../../vitest.config.js';

interface TargetInventoryEntry {
  readonly dependsOn?: readonly string[];
  readonly entries: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly inputs: readonly string[];
  readonly kind: string;
  readonly label: string;
  readonly requiresNetwork: boolean;
  readonly timeout: string | null;
  readonly workspace: boolean;
}

const inventory = (await Bun.file('tools/bazel/targets.json').json()) as {
  readonly testSuites: readonly {readonly name: string; readonly package: string; readonly tests: readonly string[]}[];
  readonly targets: readonly TargetInventoryEntry[];
};
const rootManifest = (await Bun.file('package.json').json()) as {readonly version: string};
const target = (label: string) => {
  const found = inventory.targets.find(candidate => candidate.label === label);
  if (!found) throw new Error(`Missing generated target ${label}`);
  return found;
};
const applicationTargets = () =>
  inventory.targets.filter(candidate => candidate.label.startsWith('//apps/threadnote:test_standard_'));
const applicationTargetForEntry = (entry: string) => {
  const found = applicationTargets().find(candidate => candidate.entries.includes(entry));
  if (!found) throw new Error(`Missing generated application target for ${entry}`);
  return found;
};

describe('generated Bazel test contracts', () => {
  it('keeps the inventory byte-stable across filesystem enumeration orders', () => {
    const labels = inventory.targets.map(candidate => candidate.label);
    expect(labels).toEqual([...labels].sort());
  });

  it('excludes ignored install artifacts from generated inputs', () => {
    const inputs = inventory.targets.flatMap(candidate => candidate.inputs);

    expect(inputs.some(input => input.startsWith('.husky/_/'))).toBe(false);
  });

  it('owns every PostgreSQL-gated suite in the localhost-enabled target', () => {
    const expected = [
      'apps/threadnote/test/integration/remote-memory-git-authority.test.ts',
      'apps/threadnote/test/integration/remote-memory-git-binding.test.ts',
      'apps/threadnote/test/integration/remote-memory-git-composer.test.ts',
      'apps/threadnote/test/integration/remote-memory-git-lifecycle.test.ts',
      'apps/threadnote/test/integration/remote-memory-hosted-context-ci.test.ts',
      'apps/threadnote/test/integration/remote-memory-hosted-context-health.test.ts',
      'apps/threadnote/test/integration/remote-memory-oauth-provider.test.ts',
      'apps/threadnote/test/integration/remote-memory-org-cloud.test.ts',
      'apps/threadnote/test/integration/remote-memory-postgres.test.ts',
      'apps/threadnote/test/integration/remote-memory-review-gated.test.ts',
      'apps/threadnote/test/integration/remote-memory-runtime-privileges.test.ts',
    ];
    const postgres = target('//apps/threadnote:test_postgres');
    const standardEntries = applicationTargets().flatMap(candidate => candidate.entries);

    expect(postgres.entries).toEqual(expected);
    expect(postgres.workspace).toBe(false);
    expect(postgres.requiresNetwork).toBe(true);
    expect(postgres.env.THREADNOTE_TEST_POSTGRES_URL).toContain('127.0.0.1:5432');
    expect(postgres.inputs).toContain('packages/remote-memory/src/migrations/001_initial.sql');
    expect(expected.every(entry => !standardEntries.includes(entry))).toBe(true);
  });

  it('keeps the application suite contributor-friendly while generating bounded feature targets', () => {
    const targets = applicationTargets();
    const entries = targets.flatMap(candidate => candidate.entries);
    const suite = inventory.testSuites.find(candidate => candidate.package === 'apps/threadnote');

    expect(targets.length).toBeGreaterThan(8);
    expect(targets.length).toBeLessThan(40);
    expect(targets.every(candidate => candidate.workspace)).toBe(true);
    expect(targets.every(candidate => candidate.entries.length > 0 && candidate.entries.length <= 40)).toBe(true);
    expect(new Set(entries).size).toBe(entries.length);
    expect(suite).toEqual({
      name: 'test',
      package: 'apps/threadnote',
      tests: targets.map(candidate => `:${candidate.label.split(':')[1]}`),
    });
  });

  it('discovers every colocated integration test in Vitest and exactly one Bazel target', () => {
    const pattern = 'apps/threadnote/src/integrations/**/test/**/*.test.ts';
    const entries = [...new Bun.Glob(pattern).scanSync('.')];

    expect(entries.length).toBeGreaterThan(0);
    expect(createVitestConfig().test?.include).toContain(pattern);
    for (const entry of entries) {
      expect(applicationTargets().filter(candidate => candidate.entries.includes(entry))).toHaveLength(1);
    }
  });

  it('infers runtime and repository inputs without coupling every application target to them', () => {
    const runtime = applicationTargetForEntry('apps/threadnote/test/unit/command-shim.test.ts');
    const runtimeOwners = applicationTargets().filter(candidate =>
      candidate.inputs.includes('apps/threadnote/src/standalone.ts'),
    );
    const graphFeatureOwners = applicationTargets().filter(candidate =>
      candidate.inputs.includes('packages/graph/src/git/worktree/registration_worker.ts'),
    );

    expect(runtime.inputs).toContain('apps/threadnote/src/standalone.ts');
    expect(runtimeOwners.length).toBeLessThan(applicationTargets().length);
    expect(graphFeatureOwners.length).toBeGreaterThan(0);
    expect(graphFeatureOwners.length).toBeLessThan(applicationTargets().length);
  });

  it.each([
    ['apps/threadnote/test/unit/publish-workflow.test.ts', `.github/release-notes/v${rootManifest.version}.md`],
    ['apps/threadnote/test/unit/update.test.ts', 'assets/code-graph/runtime/web-tree-sitter.wasm'],
    ['apps/threadnote/test/unit/update.test.ts', 'cursor-plugin/README.md'],
  ])('selects the owning generated target when the dynamic input %s reads changes', (entry, changedFile) => {
    const owner = applicationTargetForEntry(entry);
    const result = selectTargets({
      inventory: inventory.targets.map(candidate => candidate.label),
      impacted: [],
      changedFiles: [changedFile],
      knownInputs: inventory.targets.flatMap(candidate => candidate.inputs),
      targetDependencies: Object.fromEntries(
        inventory.targets.map(candidate => [candidate.label, candidate.dependsOn ?? []]),
      ),
      targetInputs: Object.fromEntries(inventory.targets.map(candidate => [candidate.label, candidate.inputs])),
    });

    expect(owner.inputs).toContain(changedFile);
    expect(result.mode).toBe('selective');
    expect(result.targets).toContain(owner.label);
  });

  it('does not select telemetry or graph suites for a website source change', () => {
    const changedFile = 'apps/website/src/main.tsx';
    const result = selectTargets({
      inventory: inventory.targets.map(candidate => candidate.label),
      impacted: [],
      changedFiles: [changedFile],
      knownInputs: inventory.targets.flatMap(candidate => candidate.inputs),
      targetDependencies: Object.fromEntries(
        inventory.targets.map(candidate => [candidate.label, candidate.dependsOn ?? []]),
      ),
      targetInputs: Object.fromEntries(inventory.targets.map(candidate => [candidate.label, candidate.inputs])),
    });
    const selectedEntries = inventory.targets
      .filter(candidate => result.targets.includes(candidate.label))
      .flatMap(candidate => candidate.entries);

    expect(result.mode).toBe('selective');
    expect(result.targets).not.toContain('//packages/graph:test');
    expect(selectedEntries).not.toContain('apps/threadnote/test/integration/code-graph.telemetry.test.ts');
  });

  it('models required long groups while leaving scheduled load evidence to its dedicated workflow', () => {
    const generatedGroups = inventory.targets
      .filter(candidate => candidate.label.startsWith('//apps/threadnote:test_long_'))
      .map(candidate => candidate.env.THREADNOTE_VITEST_LONG_GROUP)
      .sort();

    expect(generatedGroups).toEqual([...ciRequiredLongRunningTestGroupNames].sort());
    expect(generatedGroups).not.toContain('load-evidence');
    for (const group of generatedGroups) {
      expect(target(`//apps/threadnote:test_long_${group.replaceAll('-', '_')}`).timeout).toBe('long');
      expect(target(`//apps/threadnote:test_long_${group.replaceAll('-', '_')}`).workspace).toBe(true);
    }
  });

  it('propagates modeled build and package impacts into platform CI lanes', () => {
    expect(target('//:release_matrix').dependsOn).toEqual(['//:release_check', '//:threadnote_build']);
    expect(target('//:recall_quality').dependsOn).toEqual(['//:recall_quality_inputs']);
    expect(target('//:windows_smoke').dependsOn).toEqual(['//:windows_smoke_inputs']);
  });

  it('declares the benchmark correctness preflight without treating it as measured execution', () => {
    const preflight = target('//:platform_benchmark_preflight');

    expect(preflight.kind).toBe('test');
    expect(preflight.workspace).toBe(true);
    expect(preflight.timeout).toBe('long');
    expect(preflight.entries).toEqual([
      'apps/threadnote/test/integration/code-graph.benchmark-failure.test.ts',
      'apps/threadnote/test/integration/code-graph.benchmark-preflight.test.ts',
      'apps/threadnote/test/unit/code-graph.benchmark-harness.test.ts',
      'apps/threadnote/test/unit/evaluation.recall-benchmark-runners.test.ts',
      'packages/graph/test/unit/code-graph.benchmark-sampler.test.ts',
      'tools/ci/test/benchmark-workflow.test.ts',
      'tools/ci/test/platform-benchmark-scope.test.ts',
    ]);
    expect(preflight.inputs).toContain('.github/workflows/benchmarks.yml');
    expect(preflight.inputs).toContain('.github/workflows/production-large-evidence.yml');
    expect(preflight.inputs).toContain('scripts/benchmark-code-graph.ts');
    expect(preflight.inputs).toContain('scripts/code-graph-benchmark-sampler.ts');
    expect(preflight.inputs.some(input => input.startsWith('artifacts/'))).toBe(false);
  });

  it('keeps application runtime closure out of ordinary package tests', () => {
    for (const packageName of ['context', 'graph', 'manager', 'memory', 'platform']) {
      const ordinary = target(`//packages/${packageName}:test`);
      const runtime = target(`//packages/${packageName}:test_runtime`);
      expect(ordinary.inputs).not.toContain('apps/threadnote/src/standalone.ts');
      expect(runtime.inputs).toContain('apps/threadnote/src/standalone.ts');
    }
  });

  it.each([
    ['packages/graph/package.json', '//:threadnote_build', '//:release_matrix'],
    [
      'apps/threadnote/embedded/models/bge-small-en-v1.5-q8/f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804.gguf',
      '//:release_check',
      '//:release_matrix',
    ],
    ['packages/inference/src/vector-search.ts', '//packages/inference:test', '//:recall_quality'],
    ['scripts/support/code-graph-workset-fixture.ts', '//:recall_quality_inputs', '//:recall_quality'],
    ['apps/threadnote/test/helpers/runtime-policy.ts', '//:windows_smoke_inputs', '//:windows_smoke'],
  ])('selects %s via the transitive lane contract', (changedFile, impactedTarget, lane) => {
    const result = selectTargets({
      inventory: inventory.targets.map(candidate => candidate.label),
      impacted: [impactedTarget],
      changedFiles: [changedFile],
      knownInputs: inventory.targets.flatMap(candidate => candidate.inputs),
      targetDependencies: Object.fromEntries(
        inventory.targets.map(candidate => [candidate.label, candidate.dependsOn ?? []]),
      ),
      targetInputs: Object.fromEntries(inventory.targets.map(candidate => [candidate.label, candidate.inputs])),
    });

    expect(result.targets).toContain(lane);
  });

  it('keeps lifecycle partitions distinct and preserves long-group timeouts and serialization', () => {
    const examples = {
      'lifecycle-alpha': 'native code graph lifecycle aliases a checkout',
      'lifecycle-beta': 'native code graph lifecycle fails closed',
      'lifecycle-gamma': 'native code graph lifecycle preserves a snapshot',
      'lifecycle-delta': 'native code graph lifecycle reconciles an unknown verb',
    } as const;

    for (const [group, title] of Object.entries(examples)) {
      const config = createVitestConfig(group);
      const pattern = config.test?.testNamePattern;
      expect(pattern).toBeInstanceOf(RegExp);
      expect(Object.entries(examples).filter(([, candidate]) => (pattern as RegExp).test(candidate))).toEqual([
        [group, title],
      ]);
      expect(config.test?.testTimeout).toBe(180_000);
    }

    const serialized = createVitestConfig('heavy-state');
    expect(serialized.test).toMatchObject({fileParallelism: false, maxWorkers: 1, testTimeout: 180_000});
    expect(createVitestConfig('load-evidence').test?.testTimeout).toBe(600_000);
  });
});
