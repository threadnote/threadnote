import {Schema} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {spawnSync} from '@threadnote/testing/node-child-process';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import fc from 'fast-check';
import {expect, it} from 'vitest';
import {parse} from 'yaml';
import {AGENT_CATALOG} from '@threadnote/integrations/catalog';
import {nativeTypeScriptAssetPins} from '@threadnote/graph/typescript_native_asset_pins';
// Statically imported so the hermetic test target carries the release target definitions the step reads.
import {BUN_STANDALONE_TARGETS} from '../../../scripts/release-targets.js';
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
  readonly 'runs-on'?: string;
  readonly services?: Readonly<Record<string, unknown>>;
  readonly steps?: readonly Step[];
  readonly 'timeout-minutes'?: number;
  readonly strategy?: {
    readonly 'fail-fast'?: boolean;
    readonly matrix?: string | {readonly shard?: readonly string[]; readonly profile?: string | readonly string[]};
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
  'runs-on': Schema.optionalKey(Schema.String),
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
            profile: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
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

it('routes native Bun caches through step-scoped runner paths before the first Bun invocation', () => {
  const expectedEnvironment = {
    BUN_INSTALL_CACHE_DIR: '${{ runner.temp }}/threadnote-bun-install',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '${{ runner.temp }}/threadnote-bun-transpiler',
  };
  const setup = step(releaseJobs.build, 'Route Bun caches outside the source checkout');
  for (const name of ['build', 'extracted-workflows']) {
    const job = releaseJobs[name];
    const caches = step(job, 'Route Bun caches outside the source checkout');
    const steps = job?.steps ?? [];
    expect(caches?.env).toEqual(expectedEnvironment);
    expect(caches?.shell).toBe('bash');
    expect(caches?.if).toBeUndefined();
    expect(caches?.run).toBe(setup?.run);
    const setupIndex = steps.indexOf(caches!);
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeLessThan(
      EffectOption.getOrElse(
        EffectArray.findFirstIndex(steps, candidate => candidate.uses === 'oven-sh/setup-bun@v2'),
        () => -1,
      ),
    );
    for (const [index, candidate] of steps.entries()) {
      if (/(?:^|[\s;&|])bun(?:\s|$)/u.test(candidate.run ?? '')) expect(setupIndex).toBeLessThan(index);
      if (candidate === caches) continue;
      expect(candidate.env?.BUN_INSTALL_CACHE_DIR).toBeUndefined();
      expect(candidate.env?.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBeUndefined();
    }
  }

  // Exercise the exact shell boundary with Windows separators, spaces and a literal dollar sign.
  const install = 'D:\\runner temp\\$cache/threadnote-bun-install';
  const transpiler = 'D:\\runner temp\\$cache/threadnote-bun-transpiler';
  const root = mkdtempSync(join(tmpdir(), 'threadnote-bun-cache-routing-'));
  const environmentFile = join(root, 'step env $literal');
  try {
    // GitHub supplies a regular env file. A /dev/stdout proxy also depends on
    // whether the host can reopen the subprocess's captured output descriptor.
    writeFileSync(environmentFile, 'EXISTING=preserved\n');
    const exported = spawnSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', setup?.run ?? 'exit 98'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          BASH_ENV: '',
          PATH: '',
          GITHUB_ENV: environmentFile,
          BUN_INSTALL_CACHE_DIR: install,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpiler,
        },
        timeout: 2_000,
      },
    );
    expect(exported.error).toBeUndefined();
    expect(exported.status, exported.stderr).toBe(0);
    expect(exported.stdout).toBe('');
    expect(readFileSync(environmentFile, 'utf8')).toBe(
      `EXISTING=preserved\nBUN_INSTALL_CACHE_DIR=${install}\nBUN_RUNTIME_TRANSPILER_CACHE_PATH=${transpiler}\n`,
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

const PINNED_RELEASE_LEGS = [
  {target: 'linux-x64', os: 'ubuntu-24.04', asset: 'native-typescript-asset'},
  {target: 'linux-arm64', os: 'ubuntu-24.04-arm', asset: 'native-typescript-asset-linux-arm64'},
  {target: 'darwin-arm64', os: 'macos-15', asset: 'native-typescript-asset-darwin-arm64'},
  {target: 'darwin-x64', os: 'macos-15-intel', asset: 'native-typescript-asset-darwin-x64'},
] as const;

it('runs each native release target exactly once across the unpinned matrix and the pinned legs', () => {
  const rows = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Struct({
        'self-contained-distribution': Schema.Struct({
          strategy: Schema.Struct({
            matrix: Schema.Struct({include: Schema.Array(Schema.Struct({os: Schema.String, target: Schema.String}))}),
          }),
        }),
      }),
    }),
  )(rawWorkflow).jobs['self-contained-distribution'].strategy.matrix.include;
  const targets = [
    ...EffectArray.map(rows, row => row.target),
    ...EffectArray.map(PINNED_RELEASE_LEGS, leg => jobs[`self-contained-distribution-${leg.target}`]?.with?.target),
  ];
  // Duplicate rows fail the bazel-plan coverage check and collide on native-release-<target> artifacts.
  expect(new Set(targets).size).toBe(targets.length);
  expect([...targets].sort()).toEqual([
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-arm64-musl',
    'linux-x64',
    'linux-x64-musl',
    'windows-arm64',
    'windows-x64',
  ]);
});

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
    manager_e2e: '${{ steps.selection.outputs.manager_e2e }}',
    native_typescript: '${{ steps.shards.outputs.native_typescript }}',
    recall_quality: '${{ steps.selection.outputs.recall_quality }}',
    release_matrix: '${{ steps.selection.outputs.release_matrix }}',
    shard_matrix: '${{ steps.shards.outputs.matrix }}',
    workflow_validation: '${{ steps.selection.outputs.workflow_validation }}',
    windows_smoke: '${{ steps.selection.outputs.windows_smoke }}',
  });
  expect(jobs['recall-quality']?.if).toBe("needs.bazel-plan.outputs.recall_quality == 'true'");
  expect(jobs['manager-e2e']?.if).toBe("needs.bazel-plan.outputs.manager_e2e == 'true'");
  expect(jobs['windows-smoke']?.if).toBe("needs.bazel-plan.outputs.windows_smoke == 'true'");
  expect(jobs['standalone-targets']?.if).toBe("needs.bazel-plan.outputs.compile_targets == 'true'");
  expect(jobs['self-contained-distribution']?.if).toBe("needs.bazel-plan.outputs.release_matrix == 'true'");
  for (const leg of PINNED_RELEASE_LEGS)
    expect(jobs[`self-contained-distribution-${leg.target}`]?.if).toBe(
      "needs.bazel-plan.outputs.release_matrix == 'true'",
    );
});

const CONSUMER_GUARD = "!cancelled() && steps.restore.outcome == 'success'";
const INLINE_PROFILE = "${{ inputs.runner == 'macos-15-intel' && 'desktop' || 'all' }}";

it('builds each native release once and qualifies its archive on the same runner', () => {
  // Threadnote 6's musl-native job proves native ownership in musl userspace; it never builds a release.
  expect(EffectRecord.keys(releaseJobs)).toEqual(['build', 'extracted-workflows', 'musl-native']);
  for (const name of ['build', 'extracted-workflows', 'musl-native']) {
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
    candidate => candidate.run === 'bun run build:release',
  );
  expect(builds).toHaveLength(1);
  const build = releaseJobs.build;
  const steps = build?.steps ?? [];
  expect(step(build, 'Self-contained native smoke')?.run).toBe('bun scripts/smoke-self-contained.ts');
  expect(step(build, 'Archive the native release')?.env).toEqual({THREADNOTE_RELEASE_TARGET: '${{ inputs.target }}'});

  // Consumers replace the build tree with the archive and still run after one another fails.
  const restore = step(build, 'Restore the verified native payload');
  expect(restore?.id).toBe('restore');
  expect(restore?.run).toContain('rm -rf dist');
  expect(restore?.run).toContain('tar -xzf artifacts/threadnote-${{ inputs.target }}.tar.gz -C dist');
  expect(steps.indexOf(restore!)).toBeGreaterThan(steps.indexOf(step(build, 'Archive the native release')!));
  for (const name of [
    'Real predecessor upgrade and model setup admission',
    'Installed release E2E',
    'Extracted release and installed workflow lifecycle',
    'Workflow journal persistence smoke',
    'Extracted musl release and installed workflow lifecycle',
  ]) {
    const consumer = step(build, name);
    expect(consumer?.if).toContain(CONSUMER_GUARD);
    expect(steps.indexOf(consumer!)).toBeGreaterThan(steps.indexOf(restore!));
  }
  expect(
    EffectArray.some(steps.slice(steps.indexOf(restore!)), candidate =>
      /bun run (?:build|test:e2e:local-bins|test:smoke:self-contained)/u.test(candidate.run ?? ''),
    ),
  ).toBe(false);
  expect(step(build, 'Installed release E2E')?.run).toContain('--config vitest.e2e.config.ts');
  expect(step(build, 'Installed release E2E')?.if).toBe(
    `\${{ ${CONSUMER_GUARD} && !endsWith(inputs.target, '-musl') }}`,
  );
  expect(step(build, 'Real predecessor upgrade and model setup admission')?.if).toBe(
    `\${{ ${CONSUMER_GUARD} && inputs.runner == 'macos-15' }}`,
  );
  expect(step(build, 'Extracted release and installed workflow lifecycle')?.env).toEqual({
    THREADNOTE_RELEASE_ARCHIVE: 'artifacts/threadnote-${{ inputs.target }}.tar.gz',
    THREADNOTE_RELEASE_PROFILE: INLINE_PROFILE,
  });
  expect(step(build, 'Workflow journal persistence smoke')?.if).toBe(
    `\${{ ${CONSUMER_GUARD} && !endsWith(inputs.target, '-musl') }}`,
  );

  const split = releaseJobs['extracted-workflows'];
  expect(split?.needs).toBe('build');
  expect(split?.if).toBe("inputs.runner == 'macos-15-intel'");
  expect(split?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        uses: 'actions/download-artifact@v8',
        with: {name: 'native-release-${{ inputs.target }}', path: 'artifacts'},
      }),
    ]),
  );
  expect(step(split, 'Extracted release and installed workflow lifecycle')?.env).toEqual({
    THREADNOTE_RELEASE_ARCHIVE: 'artifacts/threadnote-${{ inputs.target }}.tar.gz',
    THREADNOTE_RELEASE_PROFILE: '${{ matrix.profile }}',
  });
});

it('executes musl extracted archives and their compiled harness inside the native musl container', () => {
  const consumer = releaseJobs.build;
  expect(consumer?.if).toBeUndefined();
  expect(step(consumer, 'Extracted release and installed workflow lifecycle')?.if).toBe(
    `\${{ ${CONSUMER_GUARD} && !endsWith(inputs.target, '-musl') }}`,
  );
  const musl = step(consumer, 'Extracted musl release and installed workflow lifecycle');
  expect(musl?.if).toBe(`\${{ ${CONSUMER_GUARD} && endsWith(inputs.target, '-musl') }}`);
  expect(musl?.env).toEqual({
    THREADNOTE_RELEASE_ARCHIVE: 'artifacts/threadnote-${{ inputs.target }}.tar.gz',
    THREADNOTE_RELEASE_PROFILE: INLINE_PROFILE,
  });
  expect(musl?.run).toContain('assemble-native-inference.ts --musl-container --workflow-runtime');
  const builder = step(releaseJobs.build, 'Build musl payload at the preserved libc floor');
  expect(builder?.run).toContain('--musl-container');
  expect(builder?.run).not.toContain('--workflow-runtime');
  const encoded = /--container-command-json '([^']+)'/u.exec(musl?.run ?? '')?.[1];
  expect(encoded).toBeDefined();
  const command = Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(encoded ?? 'null'));
  expect(command.slice(0, 2)).toEqual(['bash', '-ec']);
  expect(command[2]).toContain('command -v git; command -v rg; command -v bwrap;');
  expect(command[2]).toContain('test -s .context/release-artifact/capabilities.json;');
  expect(command[2]).toContain('bun --bun vitest run apps/threadnote/test/dev-skills/release-artifact.test.ts');
  expect(command[2]).toContain(
    'bun --bun vitest run apps/threadnote/test/dev-skills/workflow-journal-validation.test.ts',
  );
  expect(command[2]).not.toContain('build:release');
});

it('requires native admission tests and isolates the real worker deadline suite on every host', () => {
  const boundary = 'apps/threadnote/test/integration/vector-native-read-boundary.test.ts';
  const admission = 'apps/threadnote/test/integration/recall-admission-budget.test.ts';
  for (const name of [
    'Build GNU payload at the preserved libc floor',
    'Build musl payload at the preserved libc floor',
  ]) {
    const builder = step(releaseJobs.build, name);
    expect(builder?.run).toContain('--container-command-json "$NATIVE_RELEASE_COMMAND_JSON"');
    const command = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
      JSON.parse(builder?.env?.NATIVE_RELEASE_COMMAND_JSON ?? 'null'),
    );
    expect(command.slice(0, 2)).toEqual(['bash', '-ec']);
    expect(command[2]).toContain('THREADNOTE_NATIVE_VECTOR_READER_REQUIRED=1');
    expect(command[2]).toContain(
      'THREADNOTE_NATIVE_VECTOR_READER_MANIFEST="$PWD/dist/runtime/vector-reader/manifest.json"',
    );
    const tests = EffectArray.filter(
      EffectString.split(';')(command[2]),
      value => EffectString.includes('vitest run')(value) && !EffectString.includes('vitest.e2e')(value),
    );
    expect(tests).toHaveLength(2);
    expect(tests[0]).toContain(admission);
    expect(tests[0]).not.toContain(boundary);
    expect(EffectString.trim(tests[1] ?? '')).toBe(
      `bun --bun vitest run --maxWorkers=1 --no-file-parallelism ${boundary}`,
    );
  }
  const callers = step(releaseJobs.build, 'Exercise Rust through the production ready-read worker');
  const child = step(releaseJobs.build, 'Exercise the actual ready-read worker without competing suites');
  expect(callers?.run).toContain(admission);
  expect(callers?.run).not.toContain(boundary);
  expect(child?.run).toBe(`bun --bun vitest run --maxWorkers=1 --no-file-parallelism ${boundary}`);
  for (const candidate of [callers, child]) {
    expect(candidate?.if).toBe("runner.os != 'Linux'");
    expect(candidate?.env?.THREADNOTE_NATIVE_VECTOR_READER_REQUIRED).toBe('1');
    expect(candidate?.env?.THREADNOTE_NATIVE_VECTOR_READER_MANIFEST).toBe(
      '${{ github.workspace }}/dist/runtime/vector-reader/manifest.json',
    );
  }
});

it('partitions only catalog-supported macOS profiles while other platforms retain complete qualification', () => {
  const cloudProfiles = EffectArray.flatMap(AGENT_CATALOG, entry => {
    const skills = entry.devSkills;
    return skills.status === 'managed' && skills.profile !== 'desktop' && skills.platforms.includes('darwin')
      ? [skills.profile]
      : [];
  });
  // The build job qualifies desktop inline on macOS Intel; every other catalog profile gets its own job there.
  expect(INLINE_PROFILE).toContain("'macos-15-intel' && 'desktop'");
  const matrix = releaseJobs['extracted-workflows']?.strategy?.matrix;
  expect(typeof matrix === 'object' ? matrix.profile : undefined).toEqual([...new Set(cloudProfiles)]);
});

it('keeps the stable aggregate check and requires the planner plus every selected shard', () => {
  expect(jobs.test?.if).toBe('always()');
  expect(jobs.test?.needs).toEqual([
    'native-workflow-stress',
    'bazel-plan',
    'bazel-plan-validation',
    'native-typescript-asset',
    'native-typescript-asset-linux-arm64',
    'native-typescript-asset-darwin-arm64',
    'native-typescript-asset-darwin-x64',
    'bazel-shards',
    'manager-e2e',
    'recall-quality',
    'windows-smoke',
    'standalone-targets',
    'self-contained-distribution',
    'self-contained-distribution-linux-x64',
    'self-contained-distribution-linux-arm64',
    'self-contained-distribution-darwin-arm64',
    'self-contained-distribution-darwin-x64',
  ]);
  expect(step(jobs.test, 'Require every selected lane')?.run).toContain('test "$BAZEL_PLAN_RESULT" = success');
  expect(step(jobs.test, 'Require every selected lane')?.run).toContain(
    'test "$BAZEL_PLAN_VALIDATION_RESULT" = success',
  );
  expect(step(jobs.test, 'Require every selected lane')?.run).toContain('test "$BAZEL_SHARDS_RESULT" = success');
  expect(step(jobs.test, 'Require every selected lane')?.env?.MANAGER_E2E_RESULT).toBe(
    '${{ needs.manager-e2e.result }}',
  );
});

it.each(['success', 'failure', 'cancelled', 'skipped'])(
  'requires selected Manager E2E result %s to succeed',
  result => {
    const aggregate = step(jobs.test, 'Require every selected lane');
    const completed = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', aggregate?.run ?? 'exit 98'], {
      env: {
        MANUAL_STRESS: 'false',
        BAZEL_PLAN_RESULT: 'success',
        BAZEL_PLAN_VALIDATION_RESULT: 'success',
        BAZEL_EXECUTE: 'false',
        BAZEL_SHARDS_RESULT: 'skipped',
        MANAGER_E2E_SELECTED: 'true',
        MANAGER_E2E_RESULT: result,
        // The compiled Manager candidate stages the shared asset, so a selected Manager lane also requires it.
        NATIVE_TYPESCRIPT_ASSET_RESULT: 'success',
      },
    });
    expect(completed.status).toBe(result === 'success' ? 0 : 1);
  },
);

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

it('provisions one shared native TypeScript asset job per pinned host and restores it only where needed', () => {
  expect(jobs['native-typescript-asset']).toMatchObject({'runs-on': 'ubuntu-24.04', 'timeout-minutes': 90});
  for (const leg of PINNED_RELEASE_LEGS) {
    const producer = jobs[leg.asset];
    // Every producer exposes the exact key it saved and the commit it checked out.
    expect(producer?.outputs).toEqual({
      cache_key: '${{ steps.asset.outputs.cache_key }}',
      ref: '${{ github.event.pull_request.head.sha || github.sha }}',
    });
    if (leg.asset !== 'native-typescript-asset')
      expect(producer?.if).toBe("needs.bazel-plan.outputs.release_matrix == 'true'");
    const provide = step(producer, 'Restore, construct on a miss and save the verified native TypeScript asset');
    expect(provide).toMatchObject({
      id: 'asset',
      uses: './.github/actions/native-typescript-asset',
      'timeout-minutes': 80,
    });
    expect(provide?.with).toBeUndefined();
    // A pinned release leg runs on its producer's image, needs only that producer and restores by its key.
    expect(producer?.['runs-on']).toBe(leg.os);
    const release = jobs[`self-contained-distribution-${leg.target}`];
    expect(release?.needs).toEqual(['bazel-plan', leg.asset]);
    expect(release?.with).toEqual({
      runner: leg.os,
      target: leg.target,
      'native-asset-key': `\${{ needs.${leg.asset}.outputs.cache_key }}`,
    });
  }
  // Unpinned legs (musl, Windows) never wait on an asset job.
  expect(jobs['self-contained-distribution']?.needs).toBe('bazel-plan');
  for (const [name, budget] of [
    ['bazel-shards', 60],
    ['recall-quality', 360],
    ['manager-e2e', 30],
  ] as const) {
    expect(jobs[name]?.needs).toContain('native-typescript-asset');
    expect(jobs[name]?.['runs-on']).toBe('ubuntu-24.04');
    const restore = step(jobs[name], 'Restore the verified native TypeScript asset');
    expect(restore).toMatchObject({
      uses: './.github/actions/native-typescript-asset',
      with: {'restore-only': 'true', 'cache-key': '${{ needs.native-typescript-asset.outputs.cache_key }}'},
    });
    expect(restore?.['timeout-minutes']).toBeLessThan(jobs[name]?.['timeout-minutes'] ?? budget);
  }
  // recall-quality checks out the producer's commit, not the default merge commit.
  const recallCheckout = EffectArray.findFirst(
    jobs['recall-quality']?.steps ?? [],
    candidate => candidate.uses === 'actions/checkout@v7',
  );
  expect(EffectOption.getOrUndefined(recallCheckout)?.with?.ref).toBe(
    '${{ needs.native-typescript-asset.outputs.ref }}',
  );
  expect(step(jobs['bazel-shards'], 'Restore the verified native TypeScript asset')?.if).toBe(
    'matrix.native_typescript',
  );
  const releaseRestore = step(releaseJobs.build, 'Restore the verified native TypeScript asset');
  expect(releaseRestore).toMatchObject({
    with: {'restore-only': 'true', 'cache-key': '${{ inputs.native-asset-key }}'},
  });
  expect(releaseRestore?.if).toBe("${{ !endsWith(inputs.target, '-musl') && runner.os != 'Windows' }}");
  const steps = releaseJobs.build?.steps ?? [];
  expect(steps.indexOf(releaseRestore!)).toBeLessThan(
    steps.indexOf(step(releaseJobs.build, 'Semantic native ownership and safety components')!),
  );
  // The Darwin signed-compiler identity tests run only on the macOS legs, after the asset is restored.
  const darwinIdentity = step(releaseJobs.build, 'Darwin signed native TypeScript identity components');
  expect(darwinIdentity?.if).toBe(
    "${{ !cancelled() && runner.os == 'macOS' && steps.native-typescript.outcome == 'success' }}",
  );
  expect(steps.indexOf(releaseRestore!)).toBeLessThan(steps.indexOf(darwinIdentity!));
  for (const file of [
    'packages/platform/test/writer-system/provider-darwin-image.test.ts',
    'tools/ci/test/signed-native-typescript.test.ts',
    'packages/graph/test/unit/code-graph.extractor-lazy-loading.test.ts',
    'apps/threadnote/test/unit/semantic-native-image-launch.test.ts',
  ])
    expect(darwinIdentity?.run).toContain(file);
});

it.each(['success', 'failure', 'cancelled', 'skipped'])(
  'requires the shared native TypeScript asset result %s to succeed when a native lane is selected',
  result => {
    const aggregate = step(jobs.test, 'Require every selected lane')?.run;
    for (const selected of ['NATIVE_TYPESCRIPT_SELECTED', 'RECALL_SELECTED', 'MANAGER_E2E_SELECTED']) {
      const completed = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', aggregate ?? 'exit 98'], {
        encoding: 'utf8',
        env: {
          BASH_ENV: '',
          PATH: '',
          BAZEL_PLAN_RESULT: 'success',
          BAZEL_PLAN_VALIDATION_RESULT: 'success',
          BAZEL_EXECUTE: 'false',
          BAZEL_SHARDS_RESULT: 'skipped',
          RECALL_RESULT: 'success',
          MANAGER_E2E_RESULT: 'success',
          [selected]: 'true',
          NATIVE_TYPESCRIPT_ASSET_RESULT: result,
        },
        timeout: 2_000,
      });
      expect(completed.status).toBe(result === 'success' ? 0 : 1);
    }
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
              // One failed or skipped leg among the five release jobs fails the aggregate.
              SELF_CONTAINED_RESULTS: `success success ${released} success success`,
              NATIVE_TYPESCRIPT_ASSET_RESULT: 'success',
              NATIVE_TYPESCRIPT_RELEASE_ASSET_RESULTS: 'success success success',
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

it.each(['windows-smoke', 'build'])('admits %s through the verified Windows prerequisite', name => {
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
  expect(job?.['timeout-minutes']).toBe(name === 'windows-smoke' ? 60 : 90);
  if (job?.strategy) expect(job.strategy['fail-fast']).toBe(false);
});

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

it('confirms only Recall with always-retained attempt evidence', () => {
  const workflow = Schema.decodeUnknownSync(WorkflowSchema)(parse(readFileSync('.github/workflows/ci.yml', 'utf8')));
  const steps = workflow.jobs?.['recall-quality']?.steps ?? [];
  expect(EffectArray.some(steps, step => step.run === 'bun tools/ci/recall-confirmation.ts')).toBe(true);
  const upload = EffectOption.getOrUndefined(
    EffectArray.findFirst(steps, step => step.with?.name === 'recall-quality-production-10000'),
  );
  expect(upload?.if).toBe('always()');
  expect(upload?.with?.path).toBe('artifacts/recall-production-10000.json\nartifacts/recall-confirmation/\n');
});

// Only the fields this cross-workflow check reads; every other key in a workflow is left unvalidated.
const AssetFlowWorkflowSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      needs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
      outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      steps: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            id: Schema.optionalKey(Schema.String),
            uses: Schema.optionalKey(Schema.String),
            with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
          }),
        ),
      ),
    }),
  ),
});

it('restores every native TypeScript asset with the exact key its producer job saved', () => {
  const restoreOnly = (candidate: Pick<Step, 'uses' | 'with'>) =>
    candidate.uses === './.github/actions/native-typescript-asset' && candidate.with?.['restore-only'] === 'true';
  let consumers = 0;
  for (const file of [
    '.github/workflows/ci.yml',
    '.github/workflows/benchmarks.yml',
    '.github/workflows/code-graph-production-ratchet.yml',
    '.github/workflows/production-large-evidence.yml',
  ]) {
    const fileJobs = Schema.decodeUnknownSync(AssetFlowWorkflowSchema)(parse(readFileSync(file, 'utf8'))).jobs;
    for (const [name, job] of EffectRecord.toEntries(fileJobs)) {
      for (const restore of EffectArray.filter(job.steps ?? [], restoreOnly)) {
        consumers++;
        const key = String(restore.with?.['cache-key'] ?? '');
        const producers = EffectArray.map(
          [...Effect.pipe(key, EffectString.matchAll(/needs\.([\w-]+)\.outputs\.cache_key/gu))],
          match => match[1] ?? '',
        );
        expect(producers.length, `${file} ${name}`).toBeGreaterThan(0);
        const needs = typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []);
        for (const producer of producers) {
          expect(needs, `${file} ${name}`).toContain(producer);
          expect(fileJobs[producer]?.outputs?.cache_key, `${file} ${producer}`).toBe(
            '${{ steps.asset.outputs.cache_key }}',
          );
          const provide = EffectArray.findFirst(
            fileJobs[producer]?.steps ?? [],
            candidate => candidate.uses === './.github/actions/native-typescript-asset',
          );
          expect(EffectOption.getOrUndefined(provide)?.id, `${file} ${producer}`).toBe('asset');
        }
      }
    }
  }
  // The reusable release smoke takes the key from its caller instead of re-deriving it from its own checkout.
  const releaseRestore = EffectArray.filter(releaseJobs.build?.steps ?? [], restoreOnly);
  expect(EffectArray.map(releaseRestore, candidate => candidate.with?.['cache-key'])).toEqual([
    '${{ inputs.native-asset-key }}',
  ]);
  expect(consumers).toBeGreaterThanOrEqual(15);
});

const CompiledBuildWorkflowSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            // Every workflow file is scanned; some env values are numbers or booleans.
            env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
            id: Schema.optionalKey(Schema.String),
            if: Schema.optionalKey(Schema.String),
            name: Schema.optionalKey(Schema.String),
            run: Schema.optionalKey(Schema.String),
            uses: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    }),
  ),
});
const COMPILED_BUILD =
  /\bbun run (?:build|build:release|test:e2e:manager)\b|assemble-native-inference\.ts --gnu-container/u;
const PAYLOAD_REFERENCE = /^\$\{\{ steps\.([\w-]+)\.outputs\.payload \}\}$/u;
// Compiled builds that need no native TypeScript asset, keyed `workflow job step`, each with its reason.
const UNSTAGED_COMPILED_BUILDS = new Map([
  ['publish.yml windows-build bun run build:release', 'Windows has no reviewed native TypeScript pin'],
  ['benchmarks.yml recall-pr-10k Assemble the required source benchmark reader', 'assembles only the vector reader'],
  ['benchmarks.yml recall-vector-native Prepare one serial native-host capture driver', 'recall vector capture only'],
  [
    'benchmarks.yml recall-vector-native Capture in the pinned native GNU compatibility environment',
    'recall vector capture only',
  ],
  ['publish-v4.6.0-recovery.yml linux bun run build', 'rebuilds the v4.6.0 tag, which predates the native asset'],
]);
// Musl has no reviewed pin, so its container builds never stage the asset.
const MUSL_BUILD = /--musl-container/u;
// The release-smoke restore runs on every reviewed-pin leg; it skips only musl and Windows, which have no pin.
const PINNED_HOST_ASSET_GUARD = "${{ !endsWith(inputs.target, '-musl') && runner.os != 'Windows' }}";

it('stages the native TypeScript payload in every compiled build on a reviewed-pin host', () => {
  // Every workflow file: a new compiled build must either stage the payload or be listed above with its reason.
  const files = EffectArray.filter(readdirSync('.github/workflows'), file => /\.ya?ml$/u.test(file));
  const unstaged = new Set<string>();
  let staged = 0;
  for (const file of files) {
    const fileJobs = Schema.decodeUnknownSync(CompiledBuildWorkflowSchema)(
      parse(readFileSync(`.github/workflows/${file}`, 'utf8')),
    ).jobs;
    for (const [name, job] of EffectRecord.toEntries(fileJobs)) {
      const steps = job.steps ?? [];
      for (const [index, build] of steps.entries()) {
        if (!COMPILED_BUILD.test(build.run ?? '') || MUSL_BUILD.test(build.run ?? '')) continue;
        const key = `${file} ${name} ${build.name ?? build.run}`;
        const payload = build.env?.THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DIR;
        if (UNSTAGED_COMPILED_BUILDS.has(key)) {
          unstaged.add(key);
          expect(payload, key).toBeUndefined();
          continue;
        }
        const provider = EffectOption.getOrUndefined(EffectString.match(PAYLOAD_REFERENCE)(String(payload ?? '')))?.[1];
        expect(provider, key).toBeDefined();
        const providerIndex = EffectOption.getOrElse(
          EffectArray.findFirstIndex(steps, candidate => candidate.id === provider),
          () => -1,
        );
        expect(providerIndex, key).toBeGreaterThanOrEqual(0);
        expect(providerIndex, key).toBeLessThan(index);
        const asset = steps[providerIndex];
        expect(asset?.uses, key).toBe('./.github/actions/native-typescript-asset');
        // The asset step runs whenever the build does on a reviewed-pin host.
        expect([undefined, build.if, PINNED_HOST_ASSET_GUARD], key).toContain(asset?.if);
        staged++;
      }
    }
  }
  // Manager E2E, the non-Linux and GNU release-smoke builds, and the publish GNU and macOS builds.
  expect(staged).toBe(5);
  // A stale allowlist entry fails, so the list stays exact.
  expect([...unstaged].sort()).toEqual([...UNSTAGED_COMPILED_BUILDS.keys()].sort());
});

it('stages native TypeScript on the host after each GNU container build and before the payload is used', () => {
  const HOST_STAGE = 'bun scripts/stage-native-typescript-release.ts';
  for (const [file, jobName, container, consumers] of [
    [releaseWorkflowPath, 'build', 'Build GNU payload at the preserved libc floor', ['Self-contained native smoke']],
    [
      '.github/workflows/publish.yml',
      'linux',
      'Build GNU release at the preserved libc floor',
      ['./dist/threadnote --version', 'Verify release with strict read-only doctor', 'bun run archive:release'],
    ],
  ] as const) {
    const steps =
      Schema.decodeUnknownSync(CompiledBuildWorkflowSchema)(parse(readFileSync(file, 'utf8'))).jobs[jobName]?.steps ??
      [];
    const index = (name: string) =>
      EffectOption.getOrElse(
        EffectArray.findFirstIndex(steps, candidate => candidate.name === name || candidate.run === name),
        () => -1,
      );
    const build = steps[index(container)];
    const stages = EffectArray.filter(steps, candidate => candidate.run === HOST_STAGE);
    expect(stages, file).toHaveLength(1);
    const stage = stages[0];
    // The container only defers staging; the host stages the same payload under the same condition right after it.
    expect(index(stage?.name ?? HOST_STAGE), file).toBe(index(container) + 1);
    expect(stage?.if, file).toBe(build?.if);
    expect(stage?.env?.THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DIR, file).toBe(
      build?.env?.THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DIR,
    );
    expect(String(build?.env?.NATIVE_RELEASE_COMMAND_JSON ?? ''), file).not.toContain(HOST_STAGE);
    for (const consumer of consumers) {
      expect(index(consumer), `${file} ${consumer}`).toBeGreaterThan(index(container) + 1);
    }
  }
});

it('smokes GNU payloads on the host after the root build container returns them to the runner user', () => {
  const build = releaseJobs.build;
  const container = step(build, 'Build GNU payload at the preserved libc floor');
  expect(container?.env?.NATIVE_RELEASE_COMMAND_JSON).toBeDefined();
  expect(container?.env?.NATIVE_RELEASE_COMMAND_JSON).not.toContain('smoke-self-contained');
  const smoke = step(build, 'Self-contained native smoke');
  expect(smoke?.if).toBe("${{ !endsWith(inputs.target, '-musl') }}");
  const steps = build?.steps ?? [];
  expect(steps.indexOf(smoke!)).toBeGreaterThan(steps.indexOf(container!));
});

const ConstructionWorkflowSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      strategy: Schema.optionalKey(
        Schema.Struct({
          matrix: Schema.optionalKey(
            Schema.Struct({
              include: Schema.optionalKey(Schema.Array(Schema.Struct({os: Schema.String, host: Schema.String}))),
            }),
          ),
        }),
      ),
    }),
  ),
});

it('constructs every reviewed binary pin on the runner image its CI producer uses', () => {
  // The binary links its runner image's C toolchain (cgo): a pin reviewed on another image never matches CI's build.
  const construction = Schema.decodeUnknownSync(ConstructionWorkflowSchema)(
    parse(readFileSync('.github/workflows/native-typescript-construction.yml', 'utf8')),
  );
  const images = new Map(
    EffectArray.flatMap(EffectRecord.values(construction.jobs), job =>
      EffectArray.map(job.strategy?.matrix?.include ?? [], row => [row.host, row.os] as const),
    ),
  );
  const pinnedHosts = EffectArray.map(nativeTypeScriptAssetPins.reviewedHostBinaries, pin => pin.host);
  expect([...pinnedHosts].sort()).toEqual(EffectArray.map(PINNED_RELEASE_LEGS, leg => leg.target).sort());
  for (const leg of PINNED_RELEASE_LEGS) {
    expect(images.get(leg.target), leg.target).toBe(leg.os);
    expect(jobs[leg.asset]?.['runs-on'], leg.target).toBe(images.get(leg.target));
  }
});

it('executes the release matrix coverage step against every native release-smoke leg', () => {
  const coverage = step(jobs['bazel-plan'], 'Verify native release matrix coverage')?.run;
  expect(coverage).toBeDefined();
  const run = (cwd: string) =>
    spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', coverage ?? 'exit 98'], {cwd, encoding: 'utf8'});
  // The exact step text accepts the real workflow, whose legs are split across matrix and single-target jobs.
  const actual = run(process.cwd());
  expect(actual.status, actual.stderr).toBe(0);
  // Dropping any one single-target leg must fail the same text.
  const root = mkdtempSync(join(tmpdir(), 'threadnote-release-coverage-'));
  try {
    const legs = EffectArray.filter(
      EffectRecord.keys(jobs),
      name => jobs[name]?.uses === './.github/workflows/native-release-smoke.yml' && jobs[name]?.strategy === undefined,
    );
    expect(legs.length).toBeGreaterThan(0);
    expect(BUN_STANDALONE_TARGETS.length).toBeGreaterThan(legs.length);
    const reduced = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    Reflect.deleteProperty(reduced.jobs, legs[0]);
    spawnSync('mkdir', ['-p', join(root, '.github/workflows'), join(root, 'scripts')]);
    writeFileSync(join(root, '.github/workflows/ci.yml'), JSON.stringify(reduced));
    writeFileSync(join(root, 'scripts/release-targets.ts'), readFileSync('scripts/release-targets.ts', 'utf8'));
    spawnSync('ln', ['-s', join(process.cwd(), 'node_modules'), join(root, 'node_modules')]);
    const missing = run(root);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('Native execution matrix must cover the exact release target definitions');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
