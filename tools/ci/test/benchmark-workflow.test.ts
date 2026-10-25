import {readFileSync} from '@threadnote/testing/node-fs';
import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';

interface WorkflowJob {
  readonly env?: Readonly<Record<string, string>>;
  readonly if?: string;
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly outputs?: Readonly<Record<string, string>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly 'runs-on'?: string;
  readonly steps?: readonly {
    readonly 'continue-on-error'?: boolean;
    readonly id?: string;
    readonly if?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly name?: string;
    readonly run?: string;
    readonly 'timeout-minutes'?: number;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, boolean | number | string>>;
  }[];
  readonly strategy?: {
    readonly 'max-parallel'?: number;
    readonly matrix?: {
      readonly include?: readonly {
        readonly hotQuerySamples?: number;
        readonly os?: string;
      }[];
      readonly replica?: readonly number[];
      readonly scale?: readonly number[];
    };
  };
  readonly 'timeout-minutes'?: number;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface BenchmarkWorkflow {
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
  readonly on: {
    readonly push?: {
      readonly tags?: readonly string[];
    };
    readonly pull_request?: {
      readonly paths?: readonly string[];
    };
    readonly workflow_dispatch?: {
      readonly inputs?: Readonly<Record<string, unknown>>;
    };
    readonly workflow_call?: {
      readonly inputs?: Readonly<Record<string, unknown>>;
    };
  };
}

function expectBroadPullRequestTrigger(workflow: BenchmarkWorkflow): void {
  expect(Object.prototype.hasOwnProperty.call(workflow.on, 'pull_request')).toBe(true);
  const pullRequest = workflow.on.pull_request;
  expect(Object.prototype.hasOwnProperty.call(pullRequest ?? {}, 'paths')).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(pullRequest ?? {}, 'paths-ignore')).toBe(false);
}

function captureSteps(workflow: BenchmarkWorkflow): readonly {readonly jobName: string; readonly run: string}[] {
  return Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
    (job.steps ?? []).flatMap(step =>
      step.run?.split('\n').some(line => line.includes('bench:') || line.includes('scripts/benchmark-'))
        ? [{jobName, run: step.run}]
        : [],
    ),
  );
}

describe('platform benchmark workflow', () => {
  it('runs a Bazel correctness preflight independently while keeping measured captures as direct Bun commands', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const productionLarge = load(readFileSync('.github/workflows/production-large-evidence.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const preflight = workflow.jobs['benchmark-preflight'];
    const preflightRun = preflight.steps?.find(
      step => step.name === 'Validate declared benchmark harness inputs and contracts',
    )?.run;

    expect(preflight).toMatchObject({
      if: "${{ always() && github.event_name != 'pull_request' }}",
      name: 'Benchmark harness · Bazel preflight',
      needs: 'classify-platform-benchmark',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 10,
    });
    expect(preflight.steps?.find(step => step.uses === 'actions/checkout@v7')?.with?.['fetch-depth']).toBe(0);
    expect(preflightRun).toBe(
      'bun run bazel -- test //:platform_benchmark_preflight --test_output=errors --cache_test_results=no',
    );
    expect(
      Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
        (job.steps ?? []).flatMap(step => (step.run?.match(/\bbazel\b/u) ? [{jobName, run: step.run}] : [])),
      ),
    ).toEqual([
      {jobName: 'benchmark-preflight', run: 'bun tools/bazel/prepare.mjs'},
      {jobName: 'benchmark-preflight', run: preflightRun},
    ]);

    const captures = [...captureSteps(workflow), ...captureSteps(productionLarge)];
    expect(captures.length).toBeGreaterThan(10);
    for (const capture of captures) {
      expect(capture.run).not.toMatch(/\bbazel\b/u);
      const commandLines = capture.run
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.includes('bench:') || line.includes('scripts/benchmark-'));
      expect(commandLines.length).toBeGreaterThan(0);
      expect(commandLines.every(line => /^bun (?:run bench:|scripts\/benchmark-)/u.test(line))).toBe(true);
      const needs = workflow.jobs[capture.jobName]?.needs;
      expect(typeof needs === 'string' ? [needs] : (needs ?? [])).not.toContain('benchmark-preflight');
    }
    const productionLargeNeeds = workflow.jobs['code-graph-production-large'].needs;
    expect(
      typeof productionLargeNeeds === 'string' ? [productionLargeNeeds] : (productionLargeNeeds ?? []),
    ).not.toContain('benchmark-preflight');

    expect(preflight.if).toContain("github.event_name != 'pull_request'");

    expect(
      Object.entries(productionLarge.jobs).flatMap(([, job]) => job.steps?.map(step => step.run ?? '') ?? []),
    ).not.toContainEqual(expect.stringMatching(/\bbazel\b/u));
  });

  it('signs the inverse scale capture before independently verifying and retaining release evidence', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const job = workflow.jobs['code-memory-link-inverse-scale'];
    const steps = job.steps ?? [];
    const capture = steps.findIndex(step => step.run?.includes('bench:code-memory-link-scale'));
    const attest = steps.findIndex(step => step.uses?.startsWith('actions/attest@'));
    const verify = steps.findIndex(step => step.run?.includes('verify-code-memory-link-scale-provenance.ts'));
    const stage = steps.findIndex(step => step.name === 'Stage the exact content-addressed G artifact');
    expect(job.permissions).toMatchObject({
      'id-token': 'write',
      attestations: 'write',
      actions: 'read',
      contents: 'read',
    });
    expect(attest).toBeGreaterThan(capture);
    expect(verify).toBeGreaterThan(attest);
    expect(stage).toBeGreaterThan(verify);
    expect(steps[attest].with?.['subject-path']).toContain('.subject.json');
    expect(steps[verify].env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(steps[verify].run).toContain('--candidate-commit');
    expect(steps.map(step => step.run ?? '').join('\n')).not.toContain('--runner-binding');
  });
  it('runs only bounded lexical scale gates for graph and runtime pull requests', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    expectBroadPullRequestTrigger(workflow);
    const classifier = workflow.jobs['classify-platform-benchmark'];
    const pullRequestJob = workflow.jobs['code-graph-pr-scale'];
    const command = pullRequestJob.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';
    const recallJob = workflow.jobs['recall-pr-10k'];
    const recallCommand = recallJob.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';
    const worksetJob = workflow.jobs['code-graph-workset'];
    const worksetCommand = worksetJob.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';
    const nativeJob = workflow.jobs['code-graph'];
    const nativeCapture = nativeJob.steps?.find(step => step.name === 'Capture native graph benchmark');
    const windowsReplicas = workflow.jobs['code-graph-windows-replicas'];
    const windowsCapture = windowsReplicas.steps?.find(step => step.name === 'Capture fixed native graph replica');
    const windowsUpload = windowsReplicas.steps?.find(step => step.uses === 'actions/upload-artifact@v7');
    const windowsGate = workflow.jobs['code-graph-windows'];
    const windowsDownload = windowsGate.steps?.find(step => step.uses === 'actions/download-artifact@v8');
    const windowsAdjudication = windowsGate.steps?.find(
      step => step.name === 'Adjudicate fixed hosted-runner replicas',
    );

    expect(classifier.if).toBe("github.event_name == 'pull_request'");
    expect(classifier.outputs).toEqual({
      run_code_graph_pr: '${{ steps.scope.outputs.run_code_graph_pr }}',
      run_recall_pr: '${{ steps.scope.outputs.run_recall_pr }}',
    });
    expect(classifier.steps?.find(step => step.id === 'scope')?.run).toContain(
      'tools/ci/platform-benchmark-scope.ts --base "$BASE_SHA" --head "$HEAD_SHA"',
    );
    const classifierCheckout = classifier.steps?.find(step => step.uses === 'actions/checkout@v7');
    expect(classifierCheckout?.with?.['fetch-depth']).toBe(0);
    const classifierScope = classifier.steps?.find(step => step.id === 'scope');
    expect(classifierScope?.env).toEqual({
      BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
    });
    expect(pullRequestJob.needs).toBe('classify-platform-benchmark');
    expect(pullRequestJob.if).toBe(
      "${{ always() && github.event_name == 'pull_request' && (needs.classify-platform-benchmark.result != 'success' || needs.classify-platform-benchmark.outputs.run_code_graph_pr != 'false') }}",
    );
    expect(pullRequestJob['runs-on']).toBe('ubuntu-latest');
    expect(pullRequestJob['timeout-minutes']).toBe(20);
    expect(pullRequestJob.strategy?.matrix?.scale).toEqual([10_000, 100_000]);
    expect(command).toContain('--scale-symbols ${{ matrix.scale }}');
    expect(command).toContain('--fail-on-budget');
    expect(command).not.toContain('--vectors');
    expect(recallJob.needs).toBe('classify-platform-benchmark');
    expect(recallJob.if).toBe(
      "${{ always() && github.event_name == 'pull_request' && (needs.classify-platform-benchmark.result != 'success' || needs.classify-platform-benchmark.outputs.run_recall_pr != 'false') }}",
    );
    expect(recallJob['runs-on']).toBe('ubuntu-latest');
    expect(recallJob['timeout-minutes']).toBeLessThanOrEqual(15);
    expect(recallCommand).toContain('bun run eval:recall');
    const recallDiagnosticsStep = recallJob.steps?.find(
      step =>
        step.uses === 'actions/upload-artifact@v7' &&
        step.with?.name === 'recall-production-pr-10000-Linux-${{ runner.arch }}',
    );
    expect(recallDiagnosticsStep?.if).toBe('always()');
    expect(recallDiagnosticsStep?.with?.path).toBe('artifacts/recall-production-10000.json');
    expect(recallDiagnosticsStep?.with?.['if-no-files-found']).toBe('warn');
    expect(recallCommand).toContain('bun run bench:recall:vectors');
    expect(recallCommand).toContain('--documents 10000');
    expect(recallCommand).toContain('--fail-on-budget');
    const recallArtifactStep = recallJob.steps?.find(
      step =>
        step.uses === 'actions/upload-artifact@v7' &&
        step.with?.name === 'recall-vector-benchmark-pr-10000-Linux-${{ runner.arch }}',
    );
    expect(recallArtifactStep?.if).toBe('always()');
    expect(recallArtifactStep?.with?.['if-no-files-found']).toBe('warn');
    expect(recallArtifactStep?.with?.path).toBe('artifacts/recall-vectors-pr-10000-Linux-${{ runner.arch }}.json');
    expect(worksetJob.if).toContain("github.event_name == 'schedule'");
    expect(worksetJob.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(worksetJob['runs-on']).toBe('ubuntu-24.04');
    expect(worksetCommand).toContain('--sizes 1,8,32,64,128');
    expect(worksetCommand).toContain('--sizes 32,50,64,128');
    expect(worksetCommand).toContain('--samples 25');
    expect(worksetCommand).toContain('--warmups 5');
    expect(worksetCommand).not.toContain('--fail-on-budget');
    expect(nativeCapture?.env).toEqual({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-${{ matrix.os }}-${{ runner.arch }}',
      THREADNOTE_BENCHMARK_RUNNER_ID: '${{ runner.name }}',
    });
    expect(nativeJob.strategy?.matrix?.include).toEqual([
      {hotQuerySamples: 25, os: 'ubuntu-latest'},
      {hotQuerySamples: 25, os: 'macos-latest'},
    ]);
    expect(nativeCapture?.run).toContain('--samples ${{ matrix.hotQuerySamples }}');
    expect(windowsReplicas.name).toBe('Code graph Windows replica ${{ matrix.replica }} · windows-latest');
    expect(windowsReplicas.strategy?.['max-parallel']).toBe(3);
    expect(windowsReplicas.strategy?.matrix?.replica).toEqual([1, 2, 3]);
    expect(windowsCapture?.run).toContain('--samples 100');
    expect(windowsCapture?.run).toContain('--warmups 5');
    expect(windowsCapture?.run).toContain('replica-${{ matrix.replica }}.json');
    expect(windowsCapture?.run).not.toContain('--fail-on-budget');
    expect(windowsCapture?.env).toEqual({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-windows-latest-${{ runner.arch }}',
      THREADNOTE_BENCHMARK_RUNNER_ID: '${{ runner.name }}',
    });
    expect(windowsUpload?.if).toBe('always()');
    expect(windowsUpload?.with?.name).toContain('${{ matrix.replica }}-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(windowsGate.name).toBe('Code graph · windows-latest');
    expect(windowsGate.needs).toBe('code-graph-windows-replicas');
    expect(windowsGate.if).toContain('always()');
    expect(windowsDownload?.with?.pattern).toContain(
      'Windows-X64-replica-*-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(windowsDownload?.with?.['merge-multiple']).toBe(true);
    expect(windowsAdjudication?.run).toContain('gate:code-graph:windows-replicas');
    expect(windowsAdjudication?.run).toContain('--expected-commit "${{ github.sha }}"');
    expect(windowsAdjudication?.run).toContain('--fail-on-budget');
    expect(windowsAdjudication?.run?.toLowerCase()).not.toContain('retry');

    for (const jobName of [
      'code-graph',
      'code-graph-windows-replicas',
      'code-graph-windows',
      'code-graph-10k',
      'code-graph-load-evidence',
      'code-graph-vectors',
      'code-graph-vectors-10k',
      'recall-10k',
    ]) {
      expect(workflow.jobs[jobName]?.if).toContain("github.event_name == 'schedule'");
      expect(workflow.jobs[jobName]?.if).toContain("github.event_name == 'workflow_dispatch'");
      expect(workflow.jobs[jobName]?.if).not.toContain('refs/tags/');
    }

    const loadEvidence = workflow.jobs['code-graph-load-evidence'];
    const loadEvidenceStep = loadEvidence.steps?.find(step => step.env?.THREADNOTE_VITEST_LONG_GROUP);
    expect(loadEvidence['runs-on']).toBe('ubuntu-latest');
    expect(loadEvidence['timeout-minutes']).toBe(30);
    expect(loadEvidenceStep).toMatchObject({
      env: {THREADNOTE_VITEST_LONG_GROUP: 'load-evidence'},
      run: 'bun --bun vitest run',
    });
    for (const jobName of ['code-graph-100k', 'code-graph-vectors-100k', 'recall-100k']) {
      expect(workflow.jobs[jobName]?.if).toContain("github.event_name == 'schedule'");
    }
    for (const jobName of [
      'code-graph-pr-scale',
      'code-graph',
      'code-graph-windows-replicas',
      'code-graph-windows',
      'code-graph-10k',
      'code-graph-vectors',
      'code-graph-vectors-10k',
      'code-graph-100k',
      'code-graph-vectors-100k',
    ]) {
      const upload = workflow.jobs[jobName]?.steps?.find(step => step.uses === 'actions/upload-artifact@v7');
      expect(upload?.if).toBe('always()');
    }
  });

  it('runs one reduced production ratchet only for graph-affecting pull requests', () => {
    const ratchetWorkflow = load(readFileSync('.github/workflows/code-graph-production-ratchet.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const classifier = ratchetWorkflow.jobs.classify;
    const job = ratchetWorkflow.jobs.ratchet;
    const command = job.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';

    expectBroadPullRequestTrigger(ratchetWorkflow);
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(40);
    expect(job.needs).toBe('classify');
    expect(job.if).toBe('always()');
    expect(classifier.outputs?.run_benchmark).toBe('${{ steps.scope.outputs.run_benchmark }}');
    expect(classifier.steps?.find(step => step.id === 'scope')).toMatchObject({
      name: 'Classify the production-ratchet diff',
      run: 'bun tools/ci/code-graph-production-ratchet-scope.ts --base "$BASE_SHA" --head "$HEAD_SHA"',
    });
    const guardedSteps = job.steps?.filter(
      step =>
        step.uses === 'actions/checkout@v7' ||
        step.uses === 'oven-sh/setup-bun@v2' ||
        step.run === 'bun install --frozen-lockfile' ||
        step.name === 'Measure the governed reduced production profile' ||
        step.name === 'Enforce the reviewed static ratchet',
    );
    expect(guardedSteps).toHaveLength(5);
    for (const step of guardedSteps ?? []) {
      expect(step.if).toBe("needs.classify.result != 'success' || needs.classify.outputs.run_benchmark != 'false'");
    }
    expect(job.steps?.find(step => step.uses === 'actions/checkout@v7')?.with).toMatchObject({'fetch-depth': '0'});
    const candidateMeasurement = job.steps?.find(
      step => step.name === 'Measure the governed reduced production profile',
    );
    expect(candidateMeasurement?.run).not.toContain('--ratchet');
    expect(candidateMeasurement?.run).toContain('code-graph-production-ratchet-Linux-');
    const staticGate = job.steps?.find(step => step.id === 'static-ratchet');
    expect(staticGate).toMatchObject({
      'continue-on-error': true,
      name: 'Enforce the reviewed static ratchet',
    });
    expect(staticGate?.run).toContain('tools/ci/code-graph-production-ratchet-gate.ts');
    const controlMeasurement = job.steps?.find(
      step => step.name === 'Measure the exact protected-base control on the same runner',
    );
    expect(controlMeasurement?.if).toBe("steps.static-ratchet.outcome == 'failure'");
    expect(controlMeasurement?.run).toContain('git worktree add --detach "$control_root" "$BASE_SHA"');
    expect(controlMeasurement?.run).toContain('GITHUB_WORKSPACE="$control_root" GITHUB_SHA="$BASE_SHA"');
    expect(controlMeasurement?.run).toContain('code-graph-production-ratchet-control-Linux-');
    const pairedCandidateMeasurement = job.steps?.find(
      step => step.name === 'Remeasure the exact candidate immediately after the control',
    );
    expect(pairedCandidateMeasurement?.if).toBe("steps.static-ratchet.outcome == 'failure'");
    expect(pairedCandidateMeasurement?.run).toContain('code-graph-production-ratchet-paired-candidate-Linux-');
    expect(job.steps?.indexOf(candidateMeasurement!)).toBeLessThan(job.steps?.indexOf(controlMeasurement!) ?? 0);
    expect(job.steps?.indexOf(controlMeasurement!)).toBeLessThan(job.steps?.indexOf(pairedCandidateMeasurement!) ?? 0);
    const pairedGate = job.steps?.find(
      step => step.name === 'Enforce same-runner confirmatory fallback with bounded wall tail',
    );
    expect(pairedGate?.if).toBe("steps.static-ratchet.outcome == 'failure'");
    expect(pairedGate?.run).toContain('--artifact artifacts/code-graph-production-ratchet-paired-candidate-Linux-');
    expect(pairedGate?.run).toContain('--expected-candidate-commit "$GITHUB_SHA"');
    expect(pairedGate?.run).toContain('--expected-control-commit "$BASE_SHA"');
    expect(pairedGate?.run).toContain('--initial-candidate artifacts/code-graph-production-ratchet-Linux-');
    expect(job.steps?.indexOf(pairedCandidateMeasurement!)).toBeLessThan(job.steps?.indexOf(pairedGate!) ?? 0);
    expect(job.steps?.find(step => step.uses === 'actions/upload-artifact@v7')?.if).toContain(
      "needs.classify.result != 'success' || needs.classify.outputs.run_benchmark != 'false'",
    );
    expect(command.match(/--samples 1/g)).toHaveLength(3);
    expect(command.match(/--profile production-large/g)).toHaveLength(3);
    expect(command.match(/--profile-files 3000/g)).toHaveLength(3);
    expect(command.match(/--profile-symbols 110000/g)).toHaveLength(3);
    expect(command.match(/--minimum-free-gib 20/g)).toHaveLength(3);
    expect(
      command.match(
        /--ratchet apps\/threadnote\/test\/evaluation\/baselines\/code-graph-v1\/production-ratchet-github-linux-x64.json/g,
      ),
    ).toHaveLength(2);
    expect(command).not.toContain('bench:code-graph:production:ratchet');
  });

  it('prepares one verified model artifact before every vector benchmark lane', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const preparation = workflow.jobs['prepare-code-graph-vector-model'];
    const preparationSteps = preparation.steps ?? [];

    expect(preparation.if).toContain("github.event_name == 'schedule'");
    expect(preparation.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(preparation['timeout-minutes']).toBeLessThanOrEqual(10);
    expect(preparationSteps.find(step => step.id === 'graph-model-cache')?.uses).toBe('actions/cache@v6');
    expect(preparationSteps.find(step => step.run?.includes('models install'))?.run).toContain(
      '${CODE_GRAPH_EMBEDDING_MODEL_ID}',
    );
    expect(preparationSteps.find(step => step.uses === 'actions/upload-artifact@v7')?.with).toMatchObject({
      'if-no-files-found': 'error',
      name: 'code-graph-core-embedding-model',
    });

    for (const jobName of ['code-graph-vectors', 'code-graph-vectors-10k', 'code-graph-vectors-100k']) {
      const job = workflow.jobs[jobName];
      expect(job.needs).toBe('prepare-code-graph-vector-model');
      const download = job.steps?.find(step => step.uses === 'actions/download-artifact@v8');
      expect(download?.with).toMatchObject({name: 'code-graph-core-embedding-model'});
      expect(job.steps?.some(step => step.uses === 'actions/cache@v6')).toBe(false);
    }

    const vector10k = workflow.jobs['code-graph-vectors-10k'];
    const retainedFailureEvidence = vector10k.steps?.find(step => step.uses === 'actions/upload-artifact@v7');
    expect(retainedFailureEvidence?.if).toBe('always()');
    expect(retainedFailureEvidence?.with).toMatchObject({
      'if-no-files-found': 'warn',
      name: 'code-graph-vector-benchmark-10k-Linux-${{ runner.arch }}',
      path: 'artifacts/code-graph-vectors-10k-Linux-${{ runner.arch }}.json',
    });

    const vector100k = workflow.jobs['code-graph-vectors-100k'];
    const vector100kCapture = vector100k.steps?.find(step => step.run?.includes('--scale-symbols 100000'));
    const vector100kCommand = vector100kCapture?.run;
    const vector100kArtifact = vector100k.steps?.find(step => step.uses === 'actions/upload-artifact@v7');
    expect(vector100k['runs-on']).toBe('macos-15');
    expect(vector100k['timeout-minutes']).toBe(60);
    expect(vector100k.env).toBeUndefined();
    expect(vector100kCapture?.['timeout-minutes']).toBe(50);
    expect(vector100kCapture?.env).toEqual({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-macos-15-ARM64',
      THREADNOTE_BENCHMARK_RUNNER_ID: '${{ runner.name }}',
    });
    expect(vector100kCommand).toContain(
      '--output artifacts/code-graph-vectors-100k-${{ runner.os }}-${{ runner.arch }}.json',
    );
    expect(vector100kArtifact?.with).toMatchObject({
      'if-no-files-found': 'error',
      name: 'code-graph-vector-benchmark-100k-${{ runner.os }}-${{ runner.arch }}',
      path: 'artifacts/code-graph-vectors-100k-${{ runner.os }}-${{ runner.arch }}.json*',
    });
    expect(vector100kArtifact?.if).toBe('always()');
    expect(vector100kArtifact?.['timeout-minutes']).toBe(5);
  });

  it('bounds the shared production-large n=1 workflow for schedule, opt-in, and release evidence', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const evidence = load(readFileSync('.github/workflows/production-large-evidence.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const caller = workflow.jobs['code-graph-production-large'];
    const job = evidence.jobs['code-graph-production-large'];
    const command = job.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';
    const capture = job.steps?.find(step => step.id === 'capture_production_large');
    const fallback = job.steps?.find(step => step.id === 'capture_hosted_reduced');
    const checkout = job.steps?.find(step => step.uses === 'actions/checkout@v7');
    const verifyReleaseSource = job.steps?.find(
      step => step.name === 'Verify the release tag resolves to the measured commit',
    );
    const admission = job.steps?.find(step => step.id === 'classify_production_large_admission');
    const upload = job.steps?.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    const summary = job.steps?.find(step => step.run?.includes('Production-large release evidence'));
    const enforcement = job.steps?.find(step => step.name === 'Enforce a completed production-shaped observation');
    const productionInput = workflow.on.workflow_dispatch?.inputs?.include_production_large as
      {readonly description?: string} | undefined;

    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('include_production_large');
    expect(productionInput?.description).toContain('73k-repository/59,936-eligible');
    expect(productionInput?.description).toContain('profile target');
    expect(productionInput?.description).toContain('4.1 beta surrogate');
    expect(caller.if).toContain("github.event_name == 'schedule'");
    expect(caller.if).toContain('inputs.include_production_large');
    expect(caller.uses).toBe('./.github/workflows/production-large-evidence.yml');
    expect(evidence.on.workflow_call?.inputs?.strict).toBeUndefined();
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(30);
    expect(checkout?.with?.ref).toBe('${{ inputs.release_ref || github.sha }}');
    expect(verifyReleaseSource?.if).toBe("inputs.release_ref != ''");
    expect(verifyReleaseSource?.run).toContain('test "$resolved" = "$RELEASE_SHA"');
    expect(command).toContain('--profile production-large');
    expect(command).toContain('--minimum-free-gib 120');
    expect(command).toContain('--samples 1');
    expect(command).toContain('--warmups 0');
    expect(command).toContain('code-graph-production-large-n1-');
    expect(job.env).toBeUndefined();
    expect(admission?.run).toContain('MINIMUM_FREE_GIB * 1024 * 1024 * 1024');
    expect(admission?.run).toContain('df -Pk "$RUNNER_TEMP/threadnote-production-large-admission"');
    expect(admission?.run).toContain('threadnote-production-large-admission');
    expect(admission?.run).toContain('not-admitted-insufficient-capacity');
    expect(admission?.run).toContain('available_bytes >= required_bytes');
    expect(admission?.run).toContain('available_bytes >= reduced_required_bytes');
    expect(admission?.run).toContain('governed-reduced-production');
    expect(admission?.env).toMatchObject({
      MINIMUM_FREE_GIB: 120,
      REDUCED_MINIMUM_FREE_GIB: 20,
      SOURCE_REF: '${{ inputs.release_ref || github.ref }}',
      SOURCE_SHA: '${{ inputs.release_sha || github.sha }}',
    });
    expect(job.steps?.indexOf(admission!)).toBeLessThan(job.steps?.indexOf(capture!) ?? 0);
    expect(capture?.if).toContain("steps.classify_production_large_admission.outputs.admitted == 'true'");
    expect(capture?.env).toMatchObject({
      SQLITE_TMPDIR: '${{ runner.temp }}',
      TMPDIR: '${{ runner.temp }}',
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-ubuntu-24.04-${{ runner.arch }}',
      THREADNOTE_BENCHMARK_RUNNER_ID: '${{ runner.name }}',
      THREADNOTE_BENCHMARK_RELEASE_REF: '${{ inputs.release_ref }}',
      THREADNOTE_BENCHMARK_RELEASE_SHA: '${{ inputs.release_sha }}',
    });
    const captureTimeout = capture?.['timeout-minutes'];
    expect(captureTimeout).toBe(20);
    expect(capture?.['continue-on-error']).toBe(true);
    expect(job['timeout-minutes']! - (captureTimeout ?? 0)).toBeGreaterThanOrEqual(10);
    expect(fallback?.if).toContain("outputs.admitted != 'true'");
    expect(fallback?.if).toContain("outputs.reduced_admitted == 'true'");
    expect(fallback?.run).toContain('--profile-files 3000');
    expect(fallback?.run).toContain('--profile-symbols 110000');
    expect(fallback?.run).toContain('--minimum-free-gib 20');
    expect(fallback?.run).toContain('code-graph-production-reduced-n1-');
    expect(fallback?.['timeout-minutes']).toBe(20);
    expect(fallback?.['continue-on-error']).toBe(true);
    expect(upload?.uses).toBe('actions/upload-artifact@v7');
    expect(upload?.if).toBe('always()');
    expect(upload?.['timeout-minutes']).toBeLessThanOrEqual(5);
    expect(upload?.with?.path).toContain('artifacts/code-graph-production-large-admission-*.json');
    expect(upload?.with?.path).toContain('artifacts/code-graph-production-large-n1-*.json');
    expect(upload?.with?.path).toContain('artifacts/code-graph-production-reduced-n1-*.json');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(upload?.with?.['retention-days']).toBe(90);
    expect(enforcement?.if).toContain('always()');
    expect(enforcement?.if).toContain("steps.capture_production_large.outcome != 'success'");
    expect(enforcement?.if).toContain("steps.capture_hosted_reduced.outcome != 'success'");
    expect(enforcement?.run).toContain('exit 1');
    expect(job.steps?.indexOf(enforcement!)).toBeGreaterThan(job.steps?.indexOf(upload!) ?? -1);
    expect(job.steps?.indexOf(enforcement!)).toBeGreaterThan(job.steps?.indexOf(summary!) ?? -1);
    expect(summary?.run).toContain('six declared linked-worktree churn scenarios');
    expect(summary?.run).toContain('actual-versus-target counts');
    expect(summary?.run).toContain('package-manager exclusion never removes active source');
  });

  it('publishes every channel after platform artifacts while retaining independent exact-commit evidence', () => {
    const workflow = load(readFileSync('.github/workflows/publish.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const releaseEvidence = load(readFileSync('.github/workflows/release-evidence.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const publisher = load(readFileSync('.github/workflows/publish-release-assets.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const evidence = releaseEvidence.jobs['production-large-evidence'];
    const linux = workflow.jobs.linux;
    const macos = workflow.jobs.macos;
    const publish = workflow.jobs['publish-release'];
    const release = publisher.jobs.publish;
    const releaseCommand = release.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';

    expect(evidence.needs).toBeUndefined();
    expect(releaseEvidence.on.push?.tags).toEqual(['v4.*', 'v5.*']);
    expect(evidence.uses).toBe('./.github/workflows/production-large-evidence.yml');
    expect(evidence.with).toMatchObject({
      release_ref: '${{ github.ref }}',
      release_sha: '${{ github.sha }}',
    });
    expect(linux.needs).toBe('verify');
    expect(macos.needs).toBe('verify');

    expect(publish.needs).toEqual(['verify', 'linux', 'macos', 'windows-build']);
    expect(publish.if).toContain("needs.verify.result == 'success'");
    expect(publish.if).toContain("needs.linux.result == 'success'");
    expect(publish.if).toContain("needs.macos.result == 'success'");
    expect(publish.if).toContain("needs.windows-build.result == 'success'");
    expect(publish.if).not.toContain('needs.windows-sign');
    expect(publish.if).not.toContain('needs.production-large-evidence');
    expect(publish.uses).toBe('./.github/workflows/publish-release-assets.yml');
    expect(publish.permissions).toEqual({contents: 'write'});
    expect(workflow.jobs['publish-beta']).toBeUndefined();
    expect(workflow.jobs['publish-evidence-gated']).toBeUndefined();
    expect(workflow.jobs['production-large-evidence']).toBeUndefined();

    expect(release['runs-on']).toBe('ubuntu-latest');
    expect(release.permissions).toEqual({contents: 'write'});
    expect(releaseCommand).toContain('gh release create');
    expect(releaseCommand).toContain('--json isImmutable');
  });

  it('reports bounded evidence outcomes without coupling them to publication', () => {
    const evidence = load(readFileSync('.github/workflows/production-large-evidence.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const job = evidence.jobs['code-graph-production-large'];
    const summary = job.steps?.find(step => step.run?.includes('Production-large release evidence'));

    expect(summary?.env).toMatchObject({
      ADMISSION_CLASSIFICATION: '${{ steps.classify_production_large_admission.outputs.classification }}',
      MEASUREMENT_OUTCOME: '${{ steps.capture_production_large.outcome }}',
      REDUCED_MEASUREMENT_OUTCOME: '${{ steps.capture_hosted_reduced.outcome }}',
    });
    expect(summary?.run).toContain('must complete for this evidence workflow to pass');
    expect(summary?.run).toContain('governed 3k-file/110k-symbol profile must complete');
    expect(summary?.run).toContain('Admission classification');
    expect(summary?.run).toContain('does not claim full-target attainment');
  });

  it('runs the large-monorepo heavy-tail regression only by schedule or explicit opt-in', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const job = workflow.jobs['code-graph-heavy-tail'];
    const capture = job.steps?.find(step => step.run?.includes('bench:code-graph:heavy-tail'));
    const upload = job.steps?.find(step => step.uses?.startsWith('actions/upload-artifact@'));

    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('include_heavy_tail');
    expect(job.if).toContain("github.event_name == 'schedule'");
    expect(job.if).toContain('inputs.include_heavy_tail');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(180);
    expect(capture?.run).toContain('bench:code-graph:heavy-tail');
    expect(capture?.env).toMatchObject({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-ubuntu-24.04-${{ runner.arch }}',
      THREADNOTE_BENCHMARK_RUNNER_ID: '${{ runner.name }}',
    });
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.path).toBe('artifacts/code-graph-heavy-tail-*.json');
    expect(upload?.with?.['if-no-files-found']).toBe('warn');
  });
});
