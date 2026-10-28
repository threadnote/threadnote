import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {classifyCodeGraphProductionRatchetScope} from '../code-graph-production-ratchet-scope.js';
import {privateReleaseEvidenceFamilies} from '../private-release-evidence-family.js';

const productCaptureFamily = privateReleaseEvidenceFamilies[0];
const releaseCollectionFamily = privateReleaseEvidenceFamilies[1];

const baseManifest = {
  dependencies: {effect: '4.0.0-rc.112'},
  name: 'threadnote',
  scripts: {test: 'vitest run'},
  version: '4.3.6',
};

function manifest(version: string, overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({...baseManifest, ...overrides, version});
}

function shouldSkipBenchmark(
  changedPaths: readonly string[],
  before = manifest('4.3.6'),
  after = manifest('4.3.7'),
): boolean {
  return (
    classifyCodeGraphProductionRatchetScope({
      afterPackageJson: after,
      beforePackageJson: before,
      changedPaths,
    }).runBenchmark === false
  );
}

const serializedShard = '          bun --bun vitest run --no-file-parallelism --shard=${{ matrix.shard }}';
const windowsDefaultShard = serializedShard.replace(' --shard=', ' --testTimeout=120000 --shard=');
const beforeCiWorkflow = `name: CI
env:
  BUN_VERSION: 1.4.2
jobs:
  linux:
    timeout-minutes: 20
  windows-smoke:
    runs-on: windows-latest
    timeout-minutes: 30
    steps:
      - run: bun run typecheck
      - run: >-
${serializedShard}
          apps/threadnote/test/dev-skills/
  release:
    timeout-minutes: 45
`;
const afterCiWorkflow = beforeCiWorkflow.replace('    timeout-minutes: 30', '    timeout-minutes: 60');
const afterWindowsDefault = beforeCiWorkflow.replace(serializedShard, windowsDefaultShard);

const ciTestPolicyPaths = [
  '.github/workflows/ci.yml',
  'apps/threadnote/test/dev-skills/native-authoring-lifecycle.test.ts',
  'apps/threadnote/test/dev-skills/native-authoring-progress-diagnostics.test.ts',
  'apps/threadnote/test/dev-skills/native-closeout-cloud.test.ts',
  'apps/threadnote/test/dev-skills/native-closeout-lifecycle.test.ts',
  'apps/threadnote/test/dev-skills/native-closeout-recall-batch.test.ts',
  'apps/threadnote/test/dev-skills/native-cycle-lifecycle.test.ts',
  'apps/threadnote/test/dev-skills/native-release-workflows.ts',
  'apps/threadnote/test/dev-skills/release-artifact.test.ts',
  'apps/threadnote/test/dev-skills/release-artifact-preview-fence.test.ts',
  'apps/threadnote/test/e2e/local-bins.e2e.ts',
  'tools/bazel/target-specs.mjs',
  'tools/bazel/test/target-contracts.test.ts',
  'tools/ci/code-graph-production-ratchet-scope.ts',
  'tools/ci/test/ci-workflow.test.ts',
  'tools/ci/test/code-graph.production-ratchet-scope.property.test.ts',
];

function ciTestPolicyScope(changedPaths: readonly string[], after = afterCiWorkflow, before = beforeCiWorkflow) {
  return classifyCodeGraphProductionRatchetScope({afterCiWorkflow: after, beforeCiWorkflow: before, changedPaths});
}

describe('code graph production ratchet diff scope', () => {
  it('records a scoped skip for test and CI selection policy with only a valid Windows timeout change', () => {
    expect(ciTestPolicyScope(ciTestPolicyPaths)).toMatchObject({
      runBenchmark: false,
      skipReason: 'ci-and-test-policy-only',
    });
    expect(ciTestPolicyScope(ciTestPolicyPaths.slice(1)).runBenchmark).toBe(false);
    expect(ciTestPolicyScope(['.github/workflows/ci.yml']).runBenchmark).toBe(false);
    const before20 = beforeCiWorkflow.replace(
      'runs-on: windows-latest\n    timeout-minutes: 30',
      'runs-on: windows-latest\n    timeout-minutes: 20',
    );
    const after45 = before20.replace(
      'runs-on: windows-latest\n    timeout-minutes: 20',
      'runs-on: windows-latest\n    timeout-minutes: 45',
    );
    expect(ciTestPolicyScope(['.github/workflows/ci.yml'], after45, before20).runBenchmark).toBe(false);
    const before359 = beforeCiWorkflow.replace('    timeout-minutes: 30', '    timeout-minutes: 359');
    const after360 = before359.replace('    timeout-minutes: 359', '    timeout-minutes: 360');
    expect(ciTestPolicyScope(['.github/workflows/ci.yml'], after360, before359).runBenchmark).toBe(false);
  });

  it('skips only the exact Windows serialized Vitest 120-second default, alone or with a valid job timeout change', () => {
    expect(ciTestPolicyScope(ciTestPolicyPaths, afterWindowsDefault, beforeCiWorkflow).runBenchmark).toBe(false);
    expect(ciTestPolicyScope(['.github/workflows/ci.yml'], afterWindowsDefault, beforeCiWorkflow).runBenchmark).toBe(
      false,
    );
    expect(
      ciTestPolicyScope(
        ciTestPolicyPaths,
        afterCiWorkflow.replace(serializedShard, windowsDefaultShard),
        beforeCiWorkflow,
      ).runBenchmark,
    ).toBe(false);
  });

  it('runs for other Windows Vitest options, duplicate or invalid timers, and changes to workload or shard', () => {
    for (const after of [
      beforeCiWorkflow.replace(serializedShard, serializedShard.replace(' --shard=', ' --testTimeout=30000 --shard=')),
      beforeCiWorkflow.replace(
        serializedShard,
        windowsDefaultShard.replace(' --shard=', ' --testTimeout=120000 --shard='),
      ),
      beforeCiWorkflow.replace(
        serializedShard,
        windowsDefaultShard.replace('--testTimeout=120000', '--testTimeout 120000'),
      ),
      beforeCiWorkflow.replace(serializedShard, windowsDefaultShard.replace(' --shard=', ' --maxWorkers=2 --shard=')),
      afterWindowsDefault.replace('--shard=${{ matrix.shard }}', '--shard=1/2'),
      afterWindowsDefault.replace('apps/threadnote/test/dev-skills/', 'apps/threadnote/test/unit/'),
      afterWindowsDefault.replace('bun run typecheck', 'bun run test'),
      afterWindowsDefault.replace('BUN_VERSION: 1.4.2', 'BUN_VERSION: 1.4.3'),
    ]) {
      expect(ciTestPolicyScope(ciTestPolicyPaths, after, beforeCiWorkflow).runBenchmark).toBe(true);
    }
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({min: 1, max: 119_999}), fc.integer({min: 120_001, max: 240_000})),
        milliseconds => {
          const after = beforeCiWorkflow.replace(
            serializedShard,
            windowsDefaultShard.replace('120000', String(milliseconds)),
          );
          expect(ciTestPolicyScope(ciTestPolicyPaths, after, beforeCiWorkflow).runBenchmark).toBe(true);
        },
      ),
      {numRuns: 50},
    );
  });

  it('runs when the CI workflow changes anything beyond the Windows job timeout', () => {
    for (const after of [
      afterCiWorkflow.replace('BUN_VERSION: 1.4.2', 'BUN_VERSION: 1.4.3'),
      afterCiWorkflow.replace('bun run typecheck', 'bun run test'),
      afterCiWorkflow.replace('    timeout-minutes: 45', '    timeout-minutes: 60'),
      afterCiWorkflow.replace('    timeout-minutes: 60', '    timeout-minutes: 361'),
      afterCiWorkflow.replace('    timeout-minutes: 60', '    timeout-minutes: 0'),
      afterCiWorkflow.replace('    timeout-minutes: 60', '    timeout-minutes: 060'),
      afterCiWorkflow.replace('    timeout-minutes: 60', ''),
      beforeCiWorkflow,
    ]) {
      expect(ciTestPolicyScope(ciTestPolicyPaths, after).runBenchmark).toBe(true);
    }
    expect(
      classifyCodeGraphProductionRatchetScope({afterCiWorkflow, changedPaths: ciTestPolicyPaths}).runBenchmark,
    ).toBe(true);
    const duplicateBudget = beforeCiWorkflow.replace(
      '    timeout-minutes: 30',
      '    timeout-minutes: 30\n    timeout-minutes: 30',
    );
    expect(
      ciTestPolicyScope(
        ['.github/workflows/ci.yml'],
        duplicateBudget.replace('timeout-minutes: 30', 'timeout-minutes: 60'),
        duplicateBudget,
      ).runBenchmark,
    ).toBe(true);
    expect(
      ciTestPolicyScope(
        ['.github/workflows/ci.yml'],
        afterCiWorkflow,
        beforeCiWorkflow.replace('    timeout-minutes: 30', ''),
      ).runBenchmark,
    ).toBe(true);
    expect(
      ciTestPolicyScope(
        ['.github/workflows/ci.yml'],
        afterCiWorkflow,
        beforeCiWorkflow.replace('    timeout-minutes: 30', '    timeout-minutes: 0'),
      ).runBenchmark,
    ).toBe(true);
  });

  it('runs for protected runtime, parser, dependency, benchmark, gate, baseline, model, and ambiguous mixed diffs', () => {
    for (const path of [
      'packages/graph/src/code-graph.ts',
      'packages/graph/src/parser.ts',
      'apps/threadnote/src/standalone.ts',
      'config/code-graph-model.json',
      'bun.lock',
      'package.json',
      'scripts/benchmark-code-graph.ts',
      'tools/ci/code-graph-production-ratchet-gate.ts',
      '.github/workflows/code-graph-production-ratchet.yml',
      'apps/threadnote/test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
      'apps/threadnote/test/evaluation/fixtures/code-graph-v1/repository/fixture.ts',
      'tools/ci/test/benchmark-workflow.test.ts',
      'apps/threadnote/test/dev-skills/fixture.ts',
      'apps/threadnote/test/dev-skills/other.test.ts',
      'unexpected/path.txt',
    ]) {
      expect(ciTestPolicyScope([...ciTestPolicyPaths, path]).runBenchmark).toBe(true);
    }
  });

  it('keeps the CI and test policy exemption order-invariant and monotonic under protected additions', () => {
    const protectedPath = fc.constantFrom(
      'packages/graph/src/code-graph.ts',
      'scripts/benchmark-code-graph.ts',
      'tools/ci/code-graph-production-ratchet-gate.ts',
      'bun.lock',
      '.github/workflows/code-graph-production-ratchet.yml',
    );
    fc.assert(
      fc.property(fc.shuffledSubarray(ciTestPolicyPaths, {minLength: 1}), protectedPath, (paths, path) => {
        expect(ciTestPolicyScope(paths).runBenchmark).toBe(false);
        expect(ciTestPolicyScope([...paths].reverse()).runBenchmark).toBe(false);
        expect(ciTestPolicyScope([...paths, path]).runBenchmark).toBe(true);
      }),
      {numRuns: 100},
    );
  });

  it('skips a version-only release diff with release notes', () => {
    expect(shouldSkipBenchmark(['package.json', '.github/release-notes/v4.3.7.md'])).toBe(true);
    expect(shouldSkipBenchmark(['package.json'])).toBe(true);
    expect(
      classifyCodeGraphProductionRatchetScope({
        afterPackageJson: manifest('4.3.7'),
        beforePackageJson: manifest('4.3.6'),
        changedPaths: ['package.json'],
      }).skipReason,
    ).toBe('release-metadata-only');
  });

  it('skips unrelated evaluation-only changes, including the PR #568 path set', () => {
    expect(
      shouldSkipBenchmark([
        'apps/threadnote/src/evaluation/context-brief-citation-scale-contract.ts',
        'apps/threadnote/src/evaluation/context-brief-citation-scale-fixture.ts',
        'apps/threadnote/src/evaluation/context-brief-citation-scale.ts',
        'apps/threadnote/test/evaluation/baselines/context-brief-citations-v1/README.md',
        'apps/threadnote/test/unit/context-brief-citation-scale-benchmark.test.ts',
      ]),
    ).toBe(true);
    expect(
      classifyCodeGraphProductionRatchetScope({
        changedPaths: [
          'apps/threadnote/src/evaluation/context-brief-citation-scale-contract.ts',
          'apps/threadnote/src/evaluation/context-brief-citation-scale-fixture.ts',
          'apps/threadnote/src/evaluation/context-brief-citation-scale.ts',
          'apps/threadnote/test/evaluation/baselines/context-brief-citations-v1/README.md',
          'apps/threadnote/test/unit/context-brief-citation-scale-benchmark.test.ts',
        ],
      }).skipReason,
    ).toBe('unrelated-evaluation-only');
  });

  it('skips the governed profile for only exact private release-evidence families', () => {
    for (const family of privateReleaseEvidenceFamilies) {
      const result = classifyCodeGraphProductionRatchetScope({changedPaths: family.paths});
      expect(result).toMatchObject({runBenchmark: false, skipReason: 'private-release-evidence-only'});
    }
    for (const path of [
      'src/evaluation/threadnote-5-product-capture-adjacent.ts',
      'test/unit/evaluation.threadnote-5-product-capture-extra.test.ts',
      'unknown/private-evaluation-payload.bin',
      '',
    ]) {
      expect(shouldSkipBenchmark([...productCaptureFamily.paths, path])).toBe(false);
    }
    expect(shouldSkipBenchmark([...productCaptureFamily.paths, ...releaseCollectionFamily.paths])).toBe(false);
  });

  it('runs for dependency, script, runtime, benchmark harness, code-graph fixture, baseline, ratchet contract, lockfile, and ambiguous changes', () => {
    expect(
      shouldSkipBenchmark(
        ['package.json', '.github/release-notes/v4.3.7.md'],
        manifest('4.3.6'),
        manifest('4.3.7', {dependencies: {effect: '4.0.0-rc.1'}}),
      ),
    ).toBe(false);
    expect(
      shouldSkipBenchmark(
        ['package.json'],
        manifest('4.3.6'),
        manifest('4.3.7', {scripts: {test: 'vitest run --changed'}}),
      ),
    ).toBe(false);

    for (const path of [
      'src/code_graph/index.ts',
      'packages/evidence/src/benchmark.ts',
      'packages/evidence/src/external-evidence.ts',
      'packages/evidence/src/public-controls.ts',
      'apps/threadnote/src/evaluation/code-graph.ts',
      '.github/workflows/code-graph-production-ratchet.yml',
      'apps/threadnote/test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
      'apps/threadnote/test/evaluation/fixtures/code-graph-v1/fixture.ts',
      'tools/ci/test/code-graph.production-ratchet-scope.property.test.ts',
      'tools/ci/test/benchmark-workflow.test.ts',
      'bun.lock',
      '.github/release-notes/../workflows/publish.yml',
      '.github/release-notes/archive/v4.3.7.md',
      '.github/release-notes/v4.3.7.txt',
      '.github/release-notes/notes.md',
    ]) {
      expect(shouldSkipBenchmark(['package.json', '.github/release-notes/v4.3.7.md', path])).toBe(false);
    }
    expect(shouldSkipBenchmark(['.github/release-notes/v4.3.7.md'])).toBe(false);
    expect(shouldSkipBenchmark([])).toBe(false);
    for (const path of [
      'src/evaluation/new-evaluation.ts',
      'apps/threadnote/test/evaluation/baselines/new-evaluation-v1/budget.json',
      'apps/threadnote/test/evaluation/fixtures/new-evaluation-v1/fixture.json',
      'test/unit/new-evaluation.test.ts',
    ]) {
      expect(shouldSkipBenchmark([path])).toBe(false);
    }
    expect(shouldSkipBenchmark(['package.json'], '{', manifest('4.3.7'))).toBe(false);
    expect(shouldSkipBenchmark(['package.json'], manifest('4.3.7'), manifest('4.3.7'))).toBe(false);
    expect(
      classifyCodeGraphProductionRatchetScope({
        changedPaths: [undefined] as unknown as Iterable<string>,
      }).runBenchmark,
    ).toBe(true);
    expect(
      classifyCodeGraphProductionRatchetScope({
        changedPaths: undefined as unknown as Iterable<string>,
      }).runBenchmark,
    ).toBe(true);
  });

  it('compares package objects semantically while preserving nested and array ordering', () => {
    const reordered = JSON.stringify({
      version: '4.3.7',
      scripts: baseManifest.scripts,
      name: baseManifest.name,
      dependencies: baseManifest.dependencies,
    });
    expect(shouldSkipBenchmark(['package.json'], manifest('4.3.6'), reordered)).toBe(true);
    expect(
      shouldSkipBenchmark(
        ['package.json'],
        JSON.stringify({...baseManifest, files: ['dist', 'assets']}),
        JSON.stringify({...baseManifest, files: ['assets', 'dist'], version: '4.3.7'}),
      ),
    ).toBe(false);
  });

  it('is invariant to release-note order and duplicate paths', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,24}$/u), {maxLength: 12}), versions => {
        const paths = ['package.json', ...versions.map(version => `.github/release-notes/v${version}.md`)];
        expect(shouldSkipBenchmark(paths)).toBe(true);
        expect(shouldSkipBenchmark([...paths].reverse())).toBe(true);
        expect(shouldSkipBenchmark([...paths, ...paths])).toBe(true);
      }),
      {numRuns: 200},
    );
  });

  it('is invariant to unrelated evaluation-path order and duplicate paths', () => {
    const evaluationPaths = [
      'apps/threadnote/src/evaluation/context-brief-citation-scale-contract.ts',
      'apps/threadnote/src/evaluation/context-brief-citation-scale-fixture.ts',
      'apps/threadnote/test/evaluation/baselines/context-brief-citations-v1/README.md',
      'apps/threadnote/test/unit/context-brief-citation-scale-benchmark.test.ts',
    ];

    fc.assert(
      fc.property(fc.shuffledSubarray(evaluationPaths, {minLength: 1}), paths => {
        expect(shouldSkipBenchmark(paths, undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths].reverse(), undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths, ...paths], undefined, undefined)).toBe(true);
      }),
      {numRuns: 100},
    );
  });

  it('runs monotonically when a ratchet-relevant path is added to evaluation-only changes', () => {
    const evaluationPaths = [
      'apps/threadnote/src/evaluation/context-brief-citation-scale-contract.ts',
      'apps/threadnote/test/evaluation/baselines/context-brief-citations-v1/README.md',
      'apps/threadnote/test/unit/context-brief-citation-scale-benchmark.test.ts',
    ];
    const relevantPath = fc.constantFrom(
      'packages/evidence/src/benchmark.ts',
      'packages/evidence/src/external-evidence.ts',
      'packages/evidence/src/public-controls.ts',
      'apps/threadnote/src/evaluation/code-graph.ts',
      'scripts/code-graph-fixture.ts',
      'apps/threadnote/test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
      'tools/ci/code-graph-production-ratchet-gate.ts',
    );

    fc.assert(
      fc.property(fc.shuffledSubarray(evaluationPaths, {minLength: 1}), relevantPath, (paths, path) => {
        expect(shouldSkipBenchmark(paths, undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths, path], undefined, undefined)).toBe(false);
      }),
      {numRuns: 100},
    );
  });

  it('keeps private release-evidence exemptions order/duplicate invariant and fails safe for mixed paths', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([...releaseCollectionFamily.paths], {minLength: 1}), paths => {
        expect(shouldSkipBenchmark(paths, undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths].reverse(), undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths, ...paths], undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths, ...productCaptureFamily.paths], undefined, undefined)).toBe(false);
      }),
      {numRuns: 100},
    );
  });

  it('never skips after adding a path outside the release-note directory', () => {
    const repositoryPath = fc
      .tuple(
        fc.constantFrom('src', 'scripts', 'test', '.github/workflows', 'website'),
        fc.stringMatching(/^[a-z][a-z0-9_-]{0,20}$/u),
      )
      .map(([directory, name]) => `${directory}/${name}.ts`);

    fc.assert(
      fc.property(repositoryPath, path => {
        expect(shouldSkipBenchmark(['package.json', '.github/release-notes/v4.3.7.md', path])).toBe(false);
      }),
      {numRuns: 200},
    );
  });

  it('never skips when any non-version package field changes', () => {
    const field = fc
      .stringMatching(/^[a-z][a-z0-9_-]{0,16}$/u)
      .filter(value => value !== 'name' && value !== 'version');
    const changedValues = fc
      .tuple(fc.jsonValue(), fc.jsonValue())
      .filter(([before, after]) => JSON.stringify(before) !== JSON.stringify(after));

    fc.assert(
      fc.property(field, changedValues, (key, [beforeValue, afterValue]) => {
        const before = JSON.stringify({...baseManifest, [key]: beforeValue});
        const after = JSON.stringify({...baseManifest, [key]: afterValue, version: '4.3.7'});
        expect(shouldSkipBenchmark(['package.json', '.github/release-notes/v4.3.7.md'], before, after)).toBe(false);
      }),
      {numRuns: 200},
    );
  });
});
