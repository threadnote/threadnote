import {Schema} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {readFileSync} from '@threadnote/testing/node-fs';
import {spawnSync} from '@threadnote/testing/node-child-process';
import fc from 'fast-check';
import {expect, it} from 'vitest';
import {parse} from 'yaml';
import {AGENT_CATALOG} from '@threadnote/integrations/catalog';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface Step {
  readonly env?: Readonly<Record<string, string>>;
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly shell?: string;
  readonly 'timeout-minutes'?: number;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface Job {
  readonly name?: string;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly outputs?: Readonly<Record<string, string>>;
  readonly services?: Readonly<Record<string, unknown>>;
  readonly steps?: readonly Step[];
  readonly 'timeout-minutes'?: number;
  readonly strategy?: {
    readonly 'fail-fast'?: boolean;
    readonly matrix?: string | {readonly shard?: readonly string[]; readonly profile?: string};
  };
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface Workflow {
  readonly jobs?: Readonly<Record<string, Job>>;
  readonly on?: {
    readonly pull_request?: {
      readonly branches?: readonly string[];
    };
  };
}
const StepSchema = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  shell: Schema.optionalKey(Schema.String),
  'timeout-minutes': Schema.optionalKey(Schema.Finite),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const JobSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  needs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  services: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  steps: Schema.optionalKey(Schema.Array(StepSchema)),
  'timeout-minutes': Schema.optionalKey(Schema.Finite),
  strategy: Schema.optionalKey(
    Schema.Struct({
      'fail-fast': Schema.optionalKey(Schema.Boolean),
      matrix: Schema.optionalKey(
        Schema.Union([
          Schema.String,
          Schema.Struct({
            shard: Schema.optionalKey(Schema.Array(Schema.String)),
            profile: Schema.optionalKey(Schema.String),
          }),
        ]),
      ),
    }),
  ),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const WorkflowSchema = Schema.Struct({
  jobs: Schema.optionalKey(Schema.Record(Schema.String, JobSchema)),
  on: Schema.optionalKey(
    Schema.Struct({
      pull_request: Schema.optionalKey(Schema.Struct({branches: Schema.optionalKey(Schema.Array(Schema.String))})),
    }),
  ),
});

const workflowPath = '.github/workflows/ci.yml';
const rawWorkflow: unknown = parse(readFileSync(workflowPath, 'utf8'));
if (!Schema.is(WorkflowSchema)(rawWorkflow)) throw new Error('Invalid CI workflow.');
const workflow: Workflow = rawWorkflow;
const jobs = workflow.jobs ?? {};
const releaseWorkflowPath = '.github/workflows/native-release-smoke.yml';
const rawReleaseWorkflow: unknown = parse(readFileSync(releaseWorkflowPath, 'utf8'));
if (!Schema.is(WorkflowSchema)(rawReleaseWorkflow)) throw new Error('Invalid native release workflow.');
const releaseJobs = rawReleaseWorkflow.jobs ?? {};

function step(job: Job | undefined, name: string): Step | undefined {
  return EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(job?.steps), __effectArrayReceiver =>
      EffectOption.getOrUndefined(EffectArray.findFirst(__effectArrayReceiver, candidate => candidate.name === name)),
    ),
  );
}

it('runs affected-target Bazel CI for every maintained pull-request base', () => {
  expect(workflow.on?.pull_request?.branches).toEqual(['main', 'codex/4.0.0', 'release/5.0.0', 'release/5.1.0']);
});

it('uses one authoritative Bazel plan and parallel execution matrix', async () => {
  expect(await Bun.file('.github/workflows/bazel.yml').exists()).toBe(false);
  expect(EffectRecord.keys(jobs)).toContain('bazel-plan');
  expect(EffectRecord.keys(jobs)).toContain('bazel-plan-validation');
  expect(EffectRecord.keys(jobs)).toContain('bazel-shards');
  expect(step(jobs['bazel-plan-validation'], 'Verify generated Bazel declarations')?.run).toBe(
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
    compile_targets: '${{ steps.selection.outputs.compile_targets }}',
    execute_bazel: '${{ steps.shards.outputs.execute_bazel }}',
    recall_quality: '${{ steps.selection.outputs.recall_quality }}',
    release_matrix: '${{ steps.selection.outputs.release_matrix }}',
    shard_matrix: '${{ steps.shards.outputs.matrix }}',
    workflow_validation: '${{ steps.selection.outputs.workflow_validation }}',
    windows_smoke: '${{ steps.selection.outputs.windows_smoke }}',
  });
  expect(jobs['recall-quality']?.if).toBe("needs.bazel-plan.outputs.recall_quality == 'true'");
  expect(jobs['windows-smoke']?.if).toBe("needs.bazel-plan.outputs.windows_smoke == 'true'");
  expect(jobs['standalone-targets']?.if).toBe("needs.bazel-plan.outputs.compile_targets == 'true'");
  expect(jobs['self-contained-distribution']?.if).toBe("needs.bazel-plan.outputs.release_matrix == 'true'");
});

it('builds each native release once and fans its archive out to independent required consumers', () => {
  for (const name of ['build', 'installed-e2e', 'extracted-workflows']) {
    const checkout = EffectArray.findFirst(
      releaseJobs[name]?.steps ?? [],
      candidate => candidate.uses === 'actions/checkout@v7',
    );
    expect(EffectOption.getOrUndefined(checkout)?.with?.ref).toBe('${{ github.sha }}');
  }
  expect(jobs['self-contained-distribution']?.uses).toBe('./.github/workflows/native-release-smoke.yml');
  expect(jobs['self-contained-distribution']?.with).toEqual({
    runner: '${{ matrix.os }}',
    target: '${{ matrix.target }}',
  });
  const builds = EffectArray.filter(
    EffectArray.flatMap(EffectRecord.values(releaseJobs), job => job.steps ?? []),
    candidate => candidate.run === 'bun run build',
  );
  expect(builds).toHaveLength(1);
  expect(step(releaseJobs.build, 'Self-contained native smoke')?.run).toBe('bun scripts/smoke-self-contained.ts');
  expect(step(releaseJobs.build, 'Archive the native release')?.env).toEqual({
    THREADNOTE_RELEASE_TARGET: '${{ inputs.target }}',
  });
  for (const name of ['installed-e2e', 'extracted-workflows']) {
    const consumer = releaseJobs[name];
    expect(consumer?.needs).toBe('build');
    expect(consumer?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uses: 'actions/download-artifact@v8',
          with: {
            name: 'native-release-${{ inputs.target }}',
            path: 'artifacts',
          },
        }),
      ]),
    );
    expect(step(consumer, 'Restore the verified native payload')?.run).toContain(
      'tar -xzf artifacts/threadnote-${{ inputs.target }}.tar.gz -C dist',
    );
    expect(
      EffectArray.some(consumer?.steps ?? [], candidate =>
        /bun run (?:build|test:e2e:local-bins|test:smoke:self-contained)/u.test(candidate.run ?? ''),
      ),
    ).toBe(false);
  }
  expect(step(releaseJobs['installed-e2e'], 'Installed release E2E')?.run).toContain('--config vitest.e2e.config.ts');
  expect(step(releaseJobs['installed-e2e'], 'Real predecessor upgrade and model setup admission')?.if).toBe(
    "inputs.runner == 'macos-15'",
  );
  expect(step(releaseJobs['extracted-workflows'], 'Extracted release and installed workflow lifecycle')?.env).toEqual({
    THREADNOTE_RELEASE_ARCHIVE: 'artifacts/threadnote-${{ inputs.target }}.tar.gz',
    THREADNOTE_RELEASE_PROFILE: '${{ matrix.profile }}',
  });
  expect(step(releaseJobs['extracted-workflows'], 'Workflow journal persistence smoke')?.if).toBe(
    "matrix.profile == 'all' || matrix.profile == 'desktop'",
  );
});

it('partitions only catalog-supported macOS profiles while other platforms retain complete qualification', () => {
  const cloudProfiles = EffectArray.flatMap(AGENT_CATALOG, entry => {
    const skills = entry.devSkills;
    return skills.status === 'managed' && skills.profile !== 'desktop' && skills.platforms.includes('darwin')
      ? [skills.profile]
      : [];
  });
  const profiles = ['desktop', ...new Set(cloudProfiles)];
  const matrix = releaseJobs['extracted-workflows']?.strategy?.matrix;
  expect(typeof matrix === 'object' ? matrix.profile : undefined).toBe(
    "${{ fromJSON(inputs.runner == 'macos-15-intel' && '" + JSON.stringify(profiles) + "' || '[\"all\"]') }}",
  );
});

it('keeps the stable aggregate check and requires the planner plus every selected shard', () => {
  expect(jobs.test?.if).toBe('always()');
  expect(jobs.test?.needs).toEqual([
    'native-workflow-stress',
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

it.each(['success', 'failure', 'cancelled', 'skipped'])(
  'uses a distinct manual qualification context and requires stress result %s to be success',
  stressResult => {
    expect(jobs.test?.name).toContain("'Native workflow stress qualification'");
    expect(jobs.test?.name).toContain("'Unit and integration tests'");
    expect(jobs.test?.name).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.native_workflow_stress == true",
    );
    expect(jobs['native-workflow-stress']?.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.native_workflow_stress == true",
    );
    expect(jobs['native-workflow-stress']?.uses).toBe('./.github/workflows/native-workflow-stress.yml');
    const aggregate = step(jobs.test, 'Require every selected lane');
    expect(aggregate?.env?.NATIVE_WORKFLOW_STRESS_RESULT).toBe('${{ needs.native-workflow-stress.result }}');
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', aggregate?.run ?? 'exit 98'], {
      encoding: 'utf8',
      env: {
        BASH_ENV: '',
        PATH: '',
        MANUAL_STRESS: 'true',
        NATIVE_WORKFLOW_STRESS_RESULT: stressResult,
        BAZEL_PLAN_RESULT: 'skipped',
      },
      timeout: 2_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(stressResult === 'success' ? 0 : 1);
  },
);

it('requires compile and release results independently for every lane-selection combination', () => {
  const aggregate = step(jobs.test, 'Require every selected lane')?.run;
  expect(aggregate).toBeDefined();
  for (const compile of ['true', 'false']) {
    for (const release of ['true', 'false']) {
      for (const compiled of ['success', 'failure', 'cancelled', 'skipped']) {
        for (const released of ['success', 'failure', 'cancelled', 'skipped']) {
          const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', aggregate!], {
            encoding: 'utf8',
            env: {
              BASH_ENV: '',
              PATH: '',
              BAZEL_PLAN_RESULT: 'success',
              BAZEL_PLAN_VALIDATION_RESULT: 'success',
              BAZEL_EXECUTE: 'false',
              BAZEL_SHARDS_RESULT: 'skipped',
              RECALL_SELECTED: 'false',
              WINDOWS_SELECTED: 'false',
              COMPILE_SELECTED: compile,
              RELEASE_SELECTED: release,
              STANDALONE_RESULT: compiled,
              SELF_CONTAINED_RESULT: released,
            },
            timeout: 2_000,
          });
          const accepted =
            (compile === 'false' || compiled === 'success') && (release === 'false' || released === 'success');
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(accepted ? 0 : 1);
        }
      }
    }
  }
});

it('partitions the complete serialized Windows inventory with four balanced shards and its job limit', () => {
  const windows = jobs['windows-smoke'];
  expect(windows?.name).toBe('Bun unit smoke · Windows · ${{ matrix.shard }}');
  expect(windows?.['timeout-minutes']).toBe(60);
  expect(windows?.strategy).toEqual({'fail-fast': false, matrix: {shard: ['1/4', '2/4', '3/4', '4/4']}});
  const steps = windows?.steps;
  const runs = steps
    ? EffectArray.filter(
        steps,
        (candidate, index) =>
          index in steps &&
          Boolean(
            Effect.pipe(candidate.run, effectOptionalString =>
              effectOptionalString == null
                ? undefined
                : Effect.pipe(effectOptionalString, EffectString.includes('vitest run --no-file-parallelism')),
            ),
          ),
      )
    : undefined;
  expect(runs).toHaveLength(1);
  expect(
    Effect.pipe(
      runs?.[0].run,
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.split(/\s+/u)),
    ),
  ).toEqual([
    'bun',
    '--bun',
    'vitest',
    'run',
    '--no-file-parallelism',
    '--testTimeout=120000',
    '--shard=${{',
    'matrix.shard',
    '}}',
    '--config=tools/ci/windows-smoke.config.ts',
    '--reporter=default',
    '--reporter=json',
    '--outputFile=.context/windows-smoke/results.json',
    'apps/threadnote/test/unit/windows-support.test.ts',
    'apps/threadnote/test/unit/command-shim.test.ts',
    'apps/threadnote/test/unit/effect-command.test.ts',
    'apps/threadnote/test/unit/effect-system.test.ts',
    'apps/threadnote/test/unit/standalone-process-lease.test.ts',
    'apps/threadnote/test/unit/process-diagnostics.test.ts',
    'apps/threadnote/test/unit/local-ai.test.ts',
    'apps/threadnote/test/unit/update.test.ts',
    'apps/threadnote/test/unit/mcp.test.ts',
    'apps/threadnote/test/dev-skills/',
    'apps/threadnote/test/integration/cli.dev-skills.test.ts',
    'packages/integrations/test/dev-skills-catalog.test.ts',
  ]);
});

it('runs the original graph repair smoke exactly once without sharding or changing its command', () => {
  const quarantine = step(jobs['windows-smoke'], 'Graph repair quarantine smoke');
  expect(quarantine).toEqual({
    name: 'Graph repair quarantine smoke',
    if: "matrix.shard == '1/4'",
    run: 'bun --bun vitest run apps/threadnote/test/unit/code-graph.maintenance-bounded.test.ts -t "removes a database-less orphan spool"',
  });
  const matrix = jobs['windows-smoke']?.strategy?.matrix;
  const shards = typeof matrix === 'object' ? matrix.shard : undefined;
  expect(
    shards ? EffectArray.filter(shards, (shard, index) => index in shards && shard === '1/4') : undefined,
  ).toHaveLength(1);
});

it.each(['success', 'failure', 'cancelled', 'skipped'])(
  'requires the overall Windows matrix result to be success when it is %s',
  windowsResult => {
    const aggregate = step(jobs.test, 'Require every selected lane')?.run;
    expect(aggregate).toContain('test "$WINDOWS_RESULT" = success');
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', aggregate ?? 'exit 98'], {
      encoding: 'utf8',
      env: {
        BASH_ENV: '',
        PATH: '',
        BAZEL_PLAN_RESULT: 'success',
        BAZEL_PLAN_VALIDATION_RESULT: 'success',
        BAZEL_EXECUTE: 'false',
        BAZEL_SHARDS_RESULT: 'skipped',
        RECALL_SELECTED: 'false',
        RELEASE_SELECTED: 'false',
        WINDOWS_SELECTED: 'true',
        WINDOWS_RESULT: windowsResult,
      },
      timeout: 2_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(windowsResult === 'success' ? 0 : 1);
  },
);

const prerequisite = step(jobs['bazel-shards'], 'Install workflow inspection prerequisite');

it.each(['windows-smoke', 'build', 'installed-e2e', 'extracted-workflows'])(
  'admits %s through the verified Windows prerequisite',
  name => {
    const job = name === 'windows-smoke' ? jobs[name] : releaseJobs[name];
    const setup = step(
      job,
      name === 'windows-smoke' ? 'Install workflow inspection prerequisite' : 'Windows workflow prerequisites',
    );
    expect(setup).toMatchObject({
      shell: 'pwsh',
      'timeout-minutes': 5,
      run: 'bun tools/ci/windows-workflow-prerequisites.ts',
    });
    const steps = job?.steps ?? [];
    expect(steps.indexOf(setup!)).toBeGreaterThan(
      EffectOption.getOrElse(
        EffectArray.findFirstIndex(steps, candidate => candidate.uses === 'oven-sh/setup-bun@v2'),
        () => -1,
      ),
    );
    expect(steps.indexOf(setup!)).toBeGreaterThan(
      EffectOption.getOrElse(
        EffectArray.findFirstIndex(steps, candidate => candidate.run === 'bun install --frozen-lockfile'),
        () => -1,
      ),
    );
    expect(job?.['timeout-minutes']).toBe(name === 'windows-smoke' ? 60 : 45);
    if (job?.strategy) expect(job.strategy['fail-fast']).toBe(false);
  },
);

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
