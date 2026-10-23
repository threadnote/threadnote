import {readFileSync} from '@threadnote/testing/node-fs';
import {spawnSync} from '@threadnote/testing/node-child-process';
import fc from 'fast-check';
import {expect, it} from 'vitest';
import {parse} from 'yaml';

interface Step {
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly shell?: string;
  readonly 'timeout-minutes'?: number;
  readonly uses?: string;
}

interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly outputs?: Readonly<Record<string, string>>;
  readonly services?: Readonly<Record<string, unknown>>;
  readonly steps?: readonly Step[];
  readonly 'timeout-minutes'?: number;
  readonly strategy?: {readonly 'fail-fast'?: boolean};
}

interface Workflow {
  readonly jobs?: Readonly<Record<string, Job>>;
  readonly on?: {
    readonly pull_request?: {
      readonly branches?: readonly string[];
    };
  };
}

const workflowPath = '.github/workflows/ci.yml';
const workflow = parse(readFileSync(workflowPath, 'utf8')) as Workflow;
const jobs = workflow.jobs ?? {};

function step(job: Job | undefined, name: string): Step | undefined {
  return job?.steps?.find(candidate => candidate.name === name);
}

it('runs affected-target Bazel CI for every maintained pull-request base', () => {
  expect(workflow.on?.pull_request?.branches).toEqual(['main', 'codex/4.0.0', 'release/5.0.0', 'release/5.1.0']);
});

it('uses one authoritative Bazel plan and parallel execution matrix', async () => {
  expect(await Bun.file('.github/workflows/bazel.yml').exists()).toBe(false);
  expect(Object.keys(jobs)).toContain('bazel-plan');
  expect(Object.keys(jobs)).toContain('bazel-plan-validation');
  expect(Object.keys(jobs)).toContain('bazel-shards');
  expect(step(jobs['bazel-plan'], 'Verify generated Bazel declarations')?.run).toBe(
    'bun tools/bazel/generate.mjs --check',
  );
  expect(step(jobs['bazel-plan'], 'Select affected Bazel targets')).toMatchObject({
    id: 'selection',
    run: 'bun tools/ci/bazel-select.mjs --base "$BASE_SHA"',
  });
  expect(step(jobs['bazel-plan'], 'Plan parallel Bazel shards')).toMatchObject({
    id: 'shards',
    run: 'bun tools/ci/bazel-plan-shards.mjs',
  });
  expect(step(jobs['bazel-shards'], 'Execute Bazel shard')?.run).toContain('bazel-run-selected.mjs');
  expect(readFileSync('tools/ci/bazel-run-selected.mjs', 'utf8')).toContain("['test', '--local_test_jobs=1'");
  expect(step(jobs['bazel-plan'], 'Verify Bazel selection edge cases')).toBeUndefined();
  expect(step(jobs['bazel-plan-validation'], 'Verify Bazel selection edge cases')?.run).toBe(
    'bun tools/bazel/verify-selection.mjs',
  );
  expect(jobs['bazel-plan']?.services).toBeUndefined();
  expect(jobs['bazel-shards']?.services).toHaveProperty('postgres');

  const source = readFileSync(workflowPath, 'utf8');
  expect(source).not.toContain('ci-scopes.ts');
  expect(source).not.toContain('THREADNOTE_VITEST_SELECTION');
  expect(source).not.toContain('Bazel shadow');
});

it('routes platform and quality lanes from Bazel outputs', () => {
  expect(jobs['bazel-plan']?.outputs).toEqual({
    bazel_validation: '${{ steps.selection.outputs.bazel_validation }}',
    execute_bazel: '${{ steps.shards.outputs.execute_bazel }}',
    recall_quality: '${{ steps.selection.outputs.recall_quality }}',
    release_matrix: '${{ steps.selection.outputs.release_matrix }}',
    shard_matrix: '${{ steps.shards.outputs.matrix }}',
    workflow_validation: '${{ steps.selection.outputs.workflow_validation }}',
    windows_smoke: '${{ steps.selection.outputs.windows_smoke }}',
  });
  expect(jobs['recall-quality']?.if).toBe("needs.bazel-plan.outputs.recall_quality == 'true'");
  expect(jobs['windows-smoke']?.if).toBe("needs.bazel-plan.outputs.windows_smoke == 'true'");
  expect(jobs['standalone-targets']?.if).toBe("needs.bazel-plan.outputs.release_matrix == 'true'");
  expect(jobs['self-contained-distribution']?.if).toBe("needs.bazel-plan.outputs.release_matrix == 'true'");
});

it('keeps the stable aggregate check and requires the planner plus every selected shard', () => {
  expect(jobs.test?.if).toBe('always()');
  expect(jobs.test?.needs).toEqual([
    'bazel-plan',
    'bazel-plan-validation',
    'bazel-shards',
    'recall-quality',
    'windows-smoke',
    'standalone-targets',
    'self-contained-distribution',
  ]);
  expect(step(jobs.test, 'Require every selected lane')?.run).toContain('test "$BAZEL_PLAN_RESULT" = success');
  expect(step(jobs.test, 'Require every selected lane')?.run).toContain(
    'test "$BAZEL_PLAN_VALIDATION_RESULT" = success',
  );
  expect(step(jobs.test, 'Require every selected lane')?.run).toContain('test "$BAZEL_SHARDS_RESULT" = success');
});

const prerequisite = step(jobs['bazel-shards'], 'Install workflow inspection prerequisite');

function runPrerequisite(
  initial: 'working' | 'missing' | 'broken',
  failure: 'update' | 'install' | 'verify' = 'verify',
  status = 0,
) {
  const initialCommand = initial === 'missing' ? '' : `rg() { return ${initial === 'working' ? 0 : 13}; }`;
  return spawnSync(
    '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-e',
      '-o',
      'pipefail',
      '-c',
      `
${initialCommand}
sudo() {
  printf '%s\\n' "$*"
  case "$*" in
    'apt-get update') return ${failure === 'update' ? status : 0} ;;
    'apt-get install --yes ripgrep')
      if test ${failure === 'install' ? status : 0} -ne 0; then return ${status}; fi
      rg() { return ${failure === 'verify' ? status : 0}; }
      ;;
    *) return 99 ;;
  esac
}
(
${prerequisite?.run ?? 'exit 98'}
)
printf 'bazel-shard-executed\\n'
`,
    ],
    {encoding: 'utf8', env: {BASH_ENV: '', PATH: ''}, timeout: 2_000},
  );
}

it('uses working runner ripgrep without an external package operation', () => {
  const result = runPrerequisite('working');
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('bazel-shard-executed\n');
});

it.each(['missing', 'broken'] as const)('installs and verifies %s ripgrep before executing the shard', initial => {
  const result = runPrerequisite(initial);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('apt-get update\napt-get install --yes ripgrep\nbazel-shard-executed\n');
});

it('bounds only prerequisite setup while retaining the selected shard and job budget', () => {
  expect(prerequisite).toMatchObject({shell: 'bash', 'timeout-minutes': 5});
  expect(jobs['bazel-shards']?.['timeout-minutes']).toBe(60);
  expect(jobs['bazel-shards']?.strategy?.['fail-fast']).toBe(false);
  expect(step(jobs['bazel-shards'], 'Execute Bazel shard')?.run).toBe(
    'bun tools/ci/bazel-run-selected.mjs ".context/bazel-selection/shards/${{ matrix.id }}.json"',
  );
});

it('preserves every prerequisite failure status and prevents shard execution', () => {
  fc.assert(
    fc.property(fc.constantFrom('update', 'install', 'verify'), fc.integer({min: 1, max: 125}), (failure, status) => {
      const result = runPrerequisite('missing', failure, status);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(status);
      expect(result.stdout).not.toContain('bazel-shard-executed');
      expect(result.stdout).toBe(
        failure === 'update' ? 'apt-get update\n' : 'apt-get update\napt-get install --yes ripgrep\n',
      );
    }),
    {numRuns: 20},
  );
});
