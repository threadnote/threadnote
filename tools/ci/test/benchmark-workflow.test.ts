import {Array as EffectArray, Option, Predicate, Schema} from 'effect';
import {readFileSync} from '@threadnote/testing/node-fs';
import fc from 'fast-check';
import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const OpenObject = Schema.Record(Schema.String, Schema.Unknown);
const WorkflowEnvironmentValue = Schema.Union([Schema.Boolean, Schema.Finite, Schema.String]);
const WorkflowStepSchema = Schema.StructWithRest(
  Schema.Struct({
    'continue-on-error': Schema.optionalKey(Schema.Boolean),
    id: Schema.optionalKey(Schema.String),
    if: Schema.optionalKey(Schema.String),
    env: Schema.optionalKey(Schema.Record(Schema.String, WorkflowEnvironmentValue)),
    name: Schema.optionalKey(Schema.String),
    run: Schema.optionalKey(Schema.String),
    'timeout-minutes': Schema.optionalKey(Schema.Finite),
    uses: Schema.optionalKey(Schema.String),
    with: Schema.optionalKey(Schema.Record(Schema.String, WorkflowEnvironmentValue)),
  }),
  [OpenObject],
);
const WorkflowMatrixSchema = Schema.StructWithRest(
  Schema.Struct({
    include: Schema.optionalKey(
      Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({
            hotQuerySamples: Schema.optionalKey(Schema.Finite),
            os: Schema.optionalKey(Schema.String),
          }),
          [OpenObject],
        ),
      ),
    ),
    replica: Schema.optionalKey(Schema.Array(Schema.Finite)),
    scale: Schema.optionalKey(Schema.Array(Schema.Finite)),
  }),
  [OpenObject],
);
const WorkflowJobSchema = Schema.StructWithRest(
  Schema.Struct({
    env: Schema.optionalKey(Schema.Record(Schema.String, WorkflowEnvironmentValue)),
    if: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
    needs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    permissions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    'runs-on': Schema.optionalKey(Schema.String),
    steps: Schema.optionalKey(Schema.Array(WorkflowStepSchema)),
    strategy: Schema.optionalKey(
      Schema.StructWithRest(
        Schema.Struct({
          'fail-fast': Schema.optionalKey(Schema.Boolean),
          'max-parallel': Schema.optionalKey(Schema.Finite),
          matrix: Schema.optionalKey(WorkflowMatrixSchema),
        }),
        [OpenObject],
      ),
    ),
    'timeout-minutes': Schema.optionalKey(Schema.Finite),
    uses: Schema.optionalKey(Schema.String),
    with: Schema.optionalKey(OpenObject),
  }),
  [OpenObject],
);
const WorkflowTriggerSchema = Schema.StructWithRest(
  Schema.Struct({
    push: Schema.optionalKey(
      Schema.NullOr(
        Schema.StructWithRest(Schema.Struct({tags: Schema.optionalKey(Schema.Array(Schema.String))}), [OpenObject]),
      ),
    ),
    pull_request: Schema.optionalKey(
      Schema.NullOr(
        Schema.StructWithRest(Schema.Struct({paths: Schema.optionalKey(Schema.Array(Schema.String))}), [OpenObject]),
      ),
    ),
    workflow_dispatch: Schema.optionalKey(
      Schema.NullOr(Schema.StructWithRest(Schema.Struct({inputs: Schema.optionalKey(OpenObject)}), [OpenObject])),
    ),
    workflow_call: Schema.optionalKey(
      Schema.NullOr(Schema.StructWithRest(Schema.Struct({inputs: Schema.optionalKey(OpenObject)}), [OpenObject])),
    ),
  }),
  [OpenObject],
);
const BenchmarkWorkflowSchema = Schema.StructWithRest(
  Schema.Struct({
    jobs: Schema.Record(Schema.String, WorkflowJobSchema),
    on: WorkflowTriggerSchema,
  }),
  [OpenObject],
);
type BenchmarkWorkflow = typeof BenchmarkWorkflowSchema.Type;
const decodeWorkflowSchema = Schema.decodeUnknownSync(BenchmarkWorkflowSchema);
function decodeWorkflow(value: unknown): BenchmarkWorkflow {
  if (!Predicate.isObject(value) || !Predicate.isObject(value.on)) {
    return decodeWorkflowSchema(value);
  }
  const triggers = value.on;
  return decodeWorkflowSchema({
    ...value,
    on: {
      ...triggers,
      ...(triggers.pull_request === '' ? {pull_request: {}} : {}),
      ...(triggers.workflow_call === '' ? {workflow_call: {}} : {}),
      ...(triggers.workflow_dispatch === '' ? {workflow_dispatch: {}} : {}),
      ...(triggers.push === '' ? {push: {}} : {}),
    },
  });
}

function expectBroadPullRequestTrigger(workflow: BenchmarkWorkflow): void {
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
  expect(Object.hasOwn(workflow.on, 'pull_request')).toBe(true);
  const pullRequest = workflow.on.pull_request;
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
  expect(Object.hasOwn(pullRequest ?? {}, 'paths')).toBe(false);
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
  expect(Object.hasOwn(pullRequest ?? {}, 'paths-ignore')).toBe(false);
}

function captureSteps(workflow: BenchmarkWorkflow): readonly {readonly jobName: string; readonly run: string}[] {
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
  return EffectArray.flatMap(Object.entries(workflow.jobs), ([jobName, job]) =>
    EffectArray.flatMap(job.steps ?? [], step =>
      step.run != null &&
      Boolean(
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional chaining so the matching step narrows `run`.
        EffectArray.some(step.run.split('\n'), line => line.includes('bench:') || line.includes('scripts/benchmark-')),
      )
        ? [{jobName, run: step.run}]
        : [],
    ),
  );
}

describe('platform benchmark workflow', () => {
  it('preserves raw extension fields while normalizing empty YAML triggers and accepting scalar env values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), extra => {
        const workflow = decodeWorkflow({
          jobs: {
            probe: {
              steps: [{env: {BOOLEAN: false, NUMBER: 5, TEXT: 'value'}, extensionStep: extra}],
              strategy: {matrix: {include: [{os: 'ubuntu-latest', extensionMatrix: extra}], extensionMatrix: extra}},
              extensionJob: extra,
            },
          },
          on: {pull_request: '', workflow_dispatch: {inputs: {enabled: {default: false}}}, extensionTrigger: extra},
          extensionWorkflow: extra,
        });
        const job = workflow.jobs.probe;
        const step = job.steps?.[0];
        const matrix = job.strategy?.matrix;
        expect(workflow.extensionWorkflow).toEqual(extra);
        expect(workflow.on.extensionTrigger).toEqual(extra);
        expect(workflow.on.pull_request).toEqual({});
        expect(job.extensionJob).toEqual(extra);
        expect(step?.extensionStep).toEqual(extra);
        expect(step?.env).toEqual({BOOLEAN: false, NUMBER: 5, TEXT: 'value'});
        expect(matrix?.extensionMatrix).toEqual(extra);
        expect(matrix?.include?.[0]?.extensionMatrix).toEqual(extra);
      }),
      {numRuns: 40},
    );
  });

  it('runs a Bazel correctness preflight independently while keeping measured captures as direct Bun commands', () => {
    const workflow = decodeWorkflow(
      load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    const productionLarge = decodeWorkflow(
      load(readFileSync('.github/workflows/production-large-evidence.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    const preflight = workflow.jobs['benchmark-preflight'];
    const preflightRun = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(preflight.steps), effectFindReceiver =>
        Option.getOrUndefined(
          EffectArray.findFirst(
            effectFindReceiver,
            step => step.name === 'Validate declared benchmark harness inputs and contracts',
          ),
        ),
      ),
    )?.run;

    expect(preflight).toMatchObject({
      if: "${{ always() && github.event_name != 'pull_request' }}",
      name: 'Benchmark harness · Bazel preflight',
      needs: 'classify-platform-benchmark',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 10,
    });
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(preflight.steps), effectFindReceiver =>
          Option.getOrUndefined(EffectArray.findFirst(effectFindReceiver, step => step.uses === 'actions/checkout@v7')),
        ),
      )?.with?.['fetch-depth'],
    ).toBe(0);
    expect(preflightRun).toBe(
      'bun run bazel -- test //:platform_benchmark_preflight --test_output=errors --cache_test_results=no',
    );
    expect(
      EffectArray.flatMap(EffectRecord.toEntries(workflow.jobs), ([jobName, job]) =>
        EffectArray.flatMap(job.steps ?? [], step =>
          Effect.pipe(step.run, effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : Effect.pipe(
                  effectOptionalString,
                  EffectString.match(/\bbazel\b/u),
                  Effect.Option.getOrElse(() => null),
                ),
          )
            ? [{jobName, run: step.run}]
            : [],
        ),
      ),
    ).toEqual([
      {jobName: 'benchmark-preflight', run: 'bun tools/bazel/prepare.mjs'},
      {jobName: 'benchmark-preflight', run: preflightRun},
    ]);

    const captures = [...captureSteps(workflow), ...captureSteps(productionLarge)];
    expect(captures.length).toBeGreaterThan(10);
    for (const capture of captures) {
      expect(capture.run).not.toMatch(/\bbazel\b/u);
      const commandLines = EffectArray.filter(
        EffectArray.map(Effect.pipe(capture.run, EffectString.split('\n')), line =>
          Effect.pipe(line, EffectString.trim),
        ),
        line =>
          Effect.pipe(line, EffectString.includes('bench:')) ||
          Effect.pipe(line, EffectString.includes('scripts/benchmark-')),
      );
      expect(commandLines.length).toBeGreaterThan(0);
      expect(EffectArray.every(commandLines, line => /^bun (?:run bench:|scripts\/benchmark-)/u.test(line))).toBe(true);
      const needs = workflow.jobs[capture.jobName]?.needs;
      expect(typeof needs === 'string' ? [needs] : (needs ?? [])).not.toContain('benchmark-preflight');
    }
    const productionLargeNeeds = workflow.jobs['code-graph-production-large'].needs;
    expect(
      typeof productionLargeNeeds === 'string' ? [productionLargeNeeds] : (productionLargeNeeds ?? []),
    ).not.toContain('benchmark-preflight');

    expect(preflight.if).toContain("github.event_name != 'pull_request'");

    expect(
      EffectArray.flatMap(
        EffectRecord.toEntries(productionLarge.jobs),
        ([, job]) =>
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(job.steps), mapReceiver =>
              EffectArray.map(mapReceiver, step => step.run ?? ''),
            ),
          ) ?? [],
      ),
    ).not.toContainEqual(expect.stringMatching(/\bbazel\b/u));
  });

  it('signs the inverse scale capture before independently verifying and retaining release evidence', () => {
    const workflow = decodeWorkflow(
      load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    const job = workflow.jobs['code-memory-link-inverse-scale'];
    const steps = job.steps ?? [];
    const capture = Option.getOrElse(
      EffectArray.findFirstIndex(steps, step =>
        Boolean(
          Effect.pipe(step.run, effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : Effect.pipe(effectOptionalString, EffectString.includes('bench:code-memory-link-scale')),
          ),
        ),
      ),
      () => -1,
    );
    const attest = Option.getOrElse(
      EffectArray.findFirstIndex(steps, step =>
        Boolean(
          Effect.pipe(step.uses, effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : Effect.pipe(effectOptionalString, EffectString.startsWith('actions/attest@')),
          ),
        ),
      ),
      () => -1,
    );
    const verify = Option.getOrElse(
      EffectArray.findFirstIndex(steps, step =>
        Boolean(
          Effect.pipe(step.run, effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : Effect.pipe(effectOptionalString, EffectString.includes('verify-code-memory-link-scale-provenance.ts')),
          ),
        ),
      ),
      () => -1,
    );
    const stage = Option.getOrElse(
      EffectArray.findFirstIndex(steps, step => step.name === 'Stage the exact content-addressed G artifact'),
      () => -1,
    );
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
    expect(
      EffectArray.join(
        EffectArray.map(steps, step => step.run ?? ''),
        '\n',
      ),
    ).not.toContain('--runner-binding');
  });
  it('runs only bounded lexical scale gates for graph and runtime pull requests', () => {
    const workflow = decodeWorkflow(
      load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    expectBroadPullRequestTrigger(workflow);
    const classifier = workflow.jobs['classify-platform-benchmark'];
    const pullRequestJob = workflow.jobs['code-graph-pr-scale'];
    const command =
      Option.getOrUndefined(
        Option.map(
          Option.fromNullishOr(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(pullRequestJob.steps), __effectArrayValues =>
                EffectArray.flatMap(__effectArrayValues, (step, __effectArrayIndex) =>
                  __effectArrayIndex in __effectArrayValues ? (step.run ? [step.run] : []) : [],
                ),
              ),
            ),
          ),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, '\n'),
        ),
      ) ?? '';
    const recallJob = workflow.jobs['recall-pr-10k'];
    const recallCommand =
      Option.getOrUndefined(
        Option.map(
          Option.fromNullishOr(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(recallJob.steps), __effectArrayValues =>
                EffectArray.flatMap(__effectArrayValues, (step, __effectArrayIndex) =>
                  __effectArrayIndex in __effectArrayValues ? (step.run ? [step.run] : []) : [],
                ),
              ),
            ),
          ),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, '\n'),
        ),
      ) ?? '';
    const worksetJob = workflow.jobs['code-graph-workset'];
    const worksetCommand =
      Option.getOrUndefined(
        Option.map(
          Option.fromNullishOr(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(worksetJob.steps), __effectArrayValues =>
                EffectArray.flatMap(__effectArrayValues, (step, __effectArrayIndex) =>
                  __effectArrayIndex in __effectArrayValues ? (step.run ? [step.run] : []) : [],
                ),
              ),
            ),
          ),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, '\n'),
        ),
      ) ?? '';
    const nativeJob = workflow.jobs['code-graph'];
    const nativeCapture = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(nativeJob.steps), findArray =>
        Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.name === 'Capture native graph benchmark')),
      ),
    );
    const windowsReplicas = workflow.jobs['code-graph-windows-replicas'];
    const windowsCapture = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(windowsReplicas.steps), findArray =>
        Option.getOrUndefined(
          EffectArray.findFirst(findArray, step => step.name === 'Capture fixed native graph replica'),
        ),
      ),
    );
    const windowsUpload = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(windowsReplicas.steps), findArray =>
        Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.uses === 'actions/upload-artifact@v7')),
      ),
    );
    const windowsGate = workflow.jobs['code-graph-windows'];
    const windowsDownload = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(windowsGate.steps), findArray =>
        Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.uses === 'actions/download-artifact@v8')),
      ),
    );
    const windowsAdjudication = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(windowsGate.steps), findArray =>
        Option.getOrUndefined(
          EffectArray.findFirst(findArray, step => step.name === 'Adjudicate fixed hosted-runner replicas'),
        ),
      ),
    );

    expect(classifier.if).toBe("github.event_name == 'pull_request'");
    expect(classifier.outputs).toEqual({
      run_code_graph_pr: '${{ steps.scope.outputs.run_code_graph_pr }}',
      run_recall_pr: '${{ steps.scope.outputs.run_recall_pr }}',
    });
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(classifier.steps), effectFindReceiver =>
          Option.getOrUndefined(EffectArray.findFirst(effectFindReceiver, step => step.id === 'scope')),
        ),
      )?.run,
    ).toContain('tools/ci/platform-benchmark-scope.ts --base "$BASE_SHA" --head "$HEAD_SHA"');
    const classifierCheckout = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(classifier.steps), findArray =>
        Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.uses === 'actions/checkout@v7')),
      ),
    );
    expect(classifierCheckout?.with?.['fetch-depth']).toBe(0);
    const classifierScope = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(classifier.steps), findArray =>
        Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.id === 'scope')),
      ),
    );
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
    const recallDiagnosticsStep = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(recallJob.steps), findArray =>
        Option.getOrUndefined(
          EffectArray.findFirst(
            findArray,
            step =>
              step.uses === 'actions/upload-artifact@v7' &&
              step.with?.name === 'recall-production-pr-10000-Linux-${{ runner.arch }}',
          ),
        ),
      ),
    );
    expect(recallDiagnosticsStep?.if).toBe('always()');
    expect(recallDiagnosticsStep?.with?.path).toBe('artifacts/recall-production-10000.json');
    expect(recallDiagnosticsStep?.with?.['if-no-files-found']).toBe('warn');
    expect(recallCommand).toContain('bun run bench:recall:vectors');
    expect(recallCommand).toContain('--documents 10000');
    expect(recallCommand).toContain('--fail-on-budget');
    const recallArtifactStep = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(recallJob.steps), findArray =>
        Option.getOrUndefined(
          EffectArray.findFirst(
            findArray,
            step =>
              step.uses === 'actions/upload-artifact@v7' &&
              step.with?.name === 'recall-vector-benchmark-pr-10000-Linux-${{ runner.arch }}',
          ),
        ),
      ),
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
    expect(windowsUpload?.name).toBe('Upload fixed native graph replica');
    const windowsSelection = Option.getOrUndefined(
      EffectArray.findFirst(windowsGate.steps ?? [], step => step.id === 'windows-replica-artifacts'),
    );
    expect(windowsSelection?.run).toBe('bun tools/ci/select-windows-replica-artifacts.ts');
    expect(windowsSelection?.env).toEqual({GH_TOKEN: '${{ github.token }}'});
    expect(windowsGate.permissions).toEqual({actions: 'read', contents: 'read'});
    expect(windowsDownload?.with?.pattern).toBeUndefined();
    expect(windowsDownload?.with?.['artifact-ids']).toBe('${{ steps.windows-replica-artifacts.outputs.artifact-ids }}');
    expect(windowsDownload?.with?.['github-token']).toBe('${{ github.token }}');
    expect(windowsDownload?.with?.['run-id']).toBe('${{ github.run_id }}');
    expect(windowsDownload?.with?.['digest-mismatch']).toBe('error');
    expect(windowsDownload?.with?.['merge-multiple']).toBe(true);
    expect(windowsAdjudication?.run).toContain('gate:code-graph:windows-replicas');
    expect(windowsAdjudication?.run).toContain('--expected-commit "${{ github.sha }}"');
    expect(windowsAdjudication?.run).toContain('--fail-on-budget');
    expect(
      Effect.pipe(windowsAdjudication?.run, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
      ),
    ).not.toContain('retry');

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
    const loadEvidenceStep = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(loadEvidence.steps), effectFindReceiver =>
        Option.getOrUndefined(
          EffectArray.findFirst(effectFindReceiver, step => Boolean(step.env?.THREADNOTE_VITEST_LONG_GROUP)),
        ),
      ),
    );
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
      const upload = Option.getOrUndefined(
        Option.map(Option.fromNullishOr(workflow.jobs[jobName]?.steps), findArray =>
          Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.uses === 'actions/upload-artifact@v7')),
        ),
      );
      expect(upload?.if).toBe('always()');
    }
  });

  it('runs one reduced production ratchet only for graph-affecting pull requests', () => {
    const ratchetWorkflow = decodeWorkflow(
      load(readFileSync('.github/workflows/code-graph-production-ratchet.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    const classifier = ratchetWorkflow.jobs.classify;
    const job = ratchetWorkflow.jobs.ratchet;
    const command =
      Option.getOrUndefined(
        Option.map(
          Option.fromNullishOr(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(job.steps), __effectArrayValues =>
                EffectArray.flatMap(__effectArrayValues, (step, __effectArrayIndex) =>
                  __effectArrayIndex in __effectArrayValues ? (step.run ? [step.run] : []) : [],
                ),
              ),
            ),
          ),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, '\n'),
        ),
      ) ?? '';

    expectBroadPullRequestTrigger(ratchetWorkflow);
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(40);
    expect(job.needs).toBe('classify');
    expect(job.if).toBe("always() && github.event_name == 'pull_request'");
    expect(classifier.outputs?.run_benchmark).toBe('${{ steps.scope.outputs.run_benchmark }}');
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(classifier.steps), findArray =>
          Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.id === 'scope')),
        ),
      ),
    ).toMatchObject({
      name: 'Classify the production-ratchet diff',
      run: 'bun tools/ci/code-graph-production-ratchet-scope.ts --base "$BASE_SHA" --head "$HEAD_SHA"',
    });
    const guardedSteps = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (step, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues &&
            (step.uses === 'actions/checkout@v7' ||
              step.uses === 'oven-sh/setup-bun@v2' ||
              step.run === 'bun install --frozen-lockfile' ||
              step.name === 'Measure the governed reduced production profile' ||
              step.name === 'Enforce the reviewed static ratchet'),
        ),
      ),
    );
    expect(guardedSteps).toHaveLength(5);
    for (const step of guardedSteps ?? []) {
      expect(step.if).toBe("needs.classify.result != 'success' || needs.classify.outputs.run_benchmark != 'false'");
    }
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(job.steps), effectFindReceiver =>
          Option.getOrUndefined(EffectArray.findFirst(effectFindReceiver, step => step.uses === 'actions/checkout@v7')),
        ),
      )?.with,
    ).toMatchObject({'fetch-depth': '0'});
    const candidateMeasurement = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), findArray =>
        Option.getOrUndefined(
          EffectArray.findFirst(findArray, step => step.name === 'Measure the governed reduced production profile'),
        ),
      ),
    );
    expect(candidateMeasurement?.run).not.toContain('--ratchet');
    expect(candidateMeasurement?.run).toContain('code-graph-production-ratchet-Linux-');
    const staticGate = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), findArray =>
        Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.id === 'static-ratchet')),
      ),
    );
    expect(staticGate).toMatchObject({
      'continue-on-error': true,
      name: 'Enforce the reviewed static ratchet',
    });
    expect(staticGate?.run).toContain('tools/ci/code-graph-production-ratchet-gate.ts');
    const controlMeasurement = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), findArray =>
        Option.getOrUndefined(
          EffectArray.findFirst(
            findArray,
            step => step.name === 'Measure the exact protected-base control on the same runner',
          ),
        ),
      ),
    );
    expect(controlMeasurement?.if).toBe("steps.static-ratchet.outcome == 'failure'");
    expect(controlMeasurement?.run).toContain('git worktree add --detach "$control_root" "$BASE_SHA"');
    expect(controlMeasurement?.run).toContain('GITHUB_WORKSPACE="$control_root" GITHUB_SHA="$BASE_SHA"');
    expect(controlMeasurement?.run).toContain('code-graph-production-ratchet-control-Linux-');
    const pairedCandidateMeasurement = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), findArray =>
        Option.getOrUndefined(
          EffectArray.findFirst(
            findArray,
            step => step.name === 'Remeasure the exact candidate immediately after the control',
          ),
        ),
      ),
    );
    expect(pairedCandidateMeasurement?.if).toBe("steps.static-ratchet.outcome == 'failure'");
    expect(pairedCandidateMeasurement?.run).toContain('code-graph-production-ratchet-paired-candidate-Linux-');
    expect(job.steps?.indexOf(candidateMeasurement!)).toBeLessThan(job.steps?.indexOf(controlMeasurement!) ?? 0);
    expect(job.steps?.indexOf(controlMeasurement!)).toBeLessThan(job.steps?.indexOf(pairedCandidateMeasurement!) ?? 0);
    const pairedGate = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), findArray =>
        Option.getOrUndefined(
          EffectArray.findFirst(
            findArray,
            step => step.name === 'Enforce same-runner confirmatory fallback with bounded wall tail',
          ),
        ),
      ),
    );
    expect(pairedGate?.if).toBe("steps.static-ratchet.outcome == 'failure'");
    expect(pairedGate?.run).toContain('--artifact artifacts/code-graph-production-ratchet-paired-candidate-Linux-');
    expect(pairedGate?.run).toContain('--expected-candidate-commit "$GITHUB_SHA"');
    expect(pairedGate?.run).toContain('--expected-control-commit "$BASE_SHA"');
    expect(pairedGate?.run).toContain('--initial-candidate artifacts/code-graph-production-ratchet-Linux-');
    expect(job.steps?.indexOf(pairedCandidateMeasurement!)).toBeLessThan(job.steps?.indexOf(pairedGate!) ?? 0);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(job.steps), effectFindReceiver =>
          Option.getOrUndefined(
            EffectArray.findFirst(effectFindReceiver, step => step.uses === 'actions/upload-artifact@v7'),
          ),
        ),
      )?.if,
    ).toContain("needs.classify.result != 'success' || needs.classify.outputs.run_benchmark != 'false'");
    expect(
      Effect.pipe(
        command,
        EffectString.match(/--samples 1/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect.pipe(
        command,
        EffectString.match(/--profile production-large/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect.pipe(
        command,
        EffectString.match(/--profile-files 3000/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect.pipe(
        command,
        EffectString.match(/--profile-symbols 110000/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect.pipe(
        command,
        EffectString.match(/--minimum-free-gib 20/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect.pipe(
        command,
        EffectString.match(
          /--ratchet apps\/threadnote\/test\/evaluation\/baselines\/code-graph-v1\/production-ratchet-github-linux-x64.json/g,
        ),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(2);
    expect(command).not.toContain('bench:code-graph:production:ratchet');
    const captureJob = ratchetWorkflow.jobs['capture-baseline'];
    expect(captureJob.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(captureJob['runs-on']).toBe('ubuntu-24.04');
    const capture = Option.getOrUndefined(
      EffectArray.findFirst(
        captureJob.steps ?? [],
        step => step.name === 'Capture three exact-source observations and generate a candidate',
      ),
    );
    expect(capture?.run).toContain('for sample in 1 2 3; do');
    expect(capture?.run).toContain('--profile-files 3000 --profile-symbols 110000');
    expect(capture?.run).toContain('scripts/generate-code-graph-production-ratchet.ts');
    expect(capture?.run).toContain('artifacts/production-ratchet-observation-{1,2,3}.json');
    expect(
      Option.getOrUndefined(
        EffectArray.findFirst(captureJob.steps ?? [], step => step.uses === 'actions/upload-artifact@v7'),
      )?.with,
    ).toMatchObject({
      name: 'production-ratchet-candidate-${{ github.sha }}',
      path: 'artifacts/',
    });
  });

  it('prepares one verified model artifact before every vector benchmark lane', () => {
    const workflow = decodeWorkflow(
      load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    const preparation = workflow.jobs['prepare-code-graph-vector-model'];
    const preparationSteps = preparation.steps ?? [];

    expect(preparation.if).toContain("github.event_name == 'schedule'");
    expect(preparation.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(preparation['timeout-minutes']).toBeLessThanOrEqual(10);
    expect(
      Option.getOrUndefined(EffectArray.findFirst(preparationSteps, step => step.id === 'graph-model-cache'))?.uses,
    ).toBe('actions/cache@v6');
    expect(
      Option.getOrUndefined(
        EffectArray.findFirst(preparationSteps, step =>
          Boolean(
            Effect.pipe(step.run, effectOptionalString =>
              effectOptionalString == null
                ? undefined
                : Effect.pipe(effectOptionalString, EffectString.includes('models install')),
            ),
          ),
        ),
      )?.run,
    ).toContain('${CODE_GRAPH_EMBEDDING_MODEL_ID}');
    expect(
      Option.getOrUndefined(EffectArray.findFirst(preparationSteps, step => step.uses === 'actions/upload-artifact@v7'))
        ?.with,
    ).toMatchObject({
      'if-no-files-found': 'error',
      name: 'code-graph-core-embedding-model',
    });

    for (const jobName of [
      'embedding-runtime-diagnostics',
      'code-graph-vectors',
      'code-graph-vectors-10k',
      'code-graph-vectors-100k',
    ]) {
      const job = workflow.jobs[jobName];
      expect(job.needs).toBe('prepare-code-graph-vector-model');
      const download = Option.getOrUndefined(
        Option.map(Option.fromNullishOr(job.steps), findArray =>
          Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.uses === 'actions/download-artifact@v8')),
        ),
      );
      expect(download?.with).toMatchObject({name: 'code-graph-core-embedding-model'});
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(job.steps), findArray2 =>
            EffectArray.some(findArray2, step => step.uses === 'actions/cache@v6'),
          ),
        ),
      ).toBe(false);
    }

    const vector10k = workflow.jobs['code-graph-vectors-10k'];
    const retainedFailureEvidence = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(vector10k.steps), findArray =>
        Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.uses === 'actions/upload-artifact@v7')),
      ),
    );
    expect(retainedFailureEvidence?.if).toBe('always()');
    expect(retainedFailureEvidence?.with).toMatchObject({
      'if-no-files-found': 'warn',
      name: 'code-graph-vector-benchmark-10k-Linux-${{ runner.arch }}',
      path: 'artifacts/code-graph-vectors-10k-Linux-${{ runner.arch }}.json',
    });

    const vector100k = workflow.jobs['code-graph-vectors-100k'];
    const vector100kCapture = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(vector100k.steps), effectFindReceiver =>
        Option.getOrUndefined(
          EffectArray.findFirst(effectFindReceiver, step =>
            Boolean(
              Effect.pipe(step.run, effectOptionalString =>
                effectOptionalString == null
                  ? undefined
                  : Effect.pipe(effectOptionalString, EffectString.includes('--scale-symbols 100000')),
              ),
            ),
          ),
        ),
      ),
    );
    const vector100kCommand = vector100kCapture?.run;
    const vector100kArtifact = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(vector100k.steps), findArray =>
        Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.uses === 'actions/upload-artifact@v7')),
      ),
    );
    expect(vector100k['runs-on']).toBe('macos-15');
    expect(vector100k['timeout-minutes']).toBe(80);
    expect(vector100k.env).toBeUndefined();
    expect(vector100kCapture?.['timeout-minutes']).toBe(65);
    expect(vector100kCommand).toContain('--vectors');
    expect(vector100kCommand).toContain('--fail-on-budget');
    expect(vector100kCommand).toContain('--samples 3');
    expect(vector100kCommand).toContain('--warmups 1');
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
    const workflow = decodeWorkflow(
      load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    const evidence = decodeWorkflow(
      load(readFileSync('.github/workflows/production-large-evidence.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    const caller = workflow.jobs['code-graph-production-large'];
    const job = evidence.jobs['code-graph-production-large'];
    const command =
      Option.getOrUndefined(
        Option.map(
          Option.fromNullishOr(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(job.steps), __effectArrayValues =>
                EffectArray.flatMap(__effectArrayValues, (step, __effectArrayIndex) =>
                  __effectArrayIndex in __effectArrayValues ? (step.run ? [step.run] : []) : [],
                ),
              ),
            ),
          ),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, '\n'),
        ),
      ) ?? '';
    const capture = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), findArray =>
        Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.id === 'capture_production_large')),
      ),
    );
    const fallback = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), findArray =>
        Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.id === 'capture_hosted_reduced')),
      ),
    );
    const checkout = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), findArray =>
        Option.getOrUndefined(EffectArray.findFirst(findArray, step => step.uses === 'actions/checkout@v7')),
      ),
    );
    const verifyReleaseSource = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), findArray =>
        Option.getOrUndefined(
          EffectArray.findFirst(
            findArray,
            step => step.name === 'Verify the release tag resolves to the measured commit',
          ),
        ),
      ),
    );
    const admission = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), findArray =>
        Option.getOrUndefined(
          EffectArray.findFirst(findArray, step => step.id === 'classify_production_large_admission'),
        ),
      ),
    );
    const upload = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), effectFindReceiver =>
        Option.getOrUndefined(
          EffectArray.findFirst(effectFindReceiver, step =>
            Boolean(
              Effect.pipe(step.uses, effectOptionalString =>
                effectOptionalString == null
                  ? undefined
                  : Effect.pipe(effectOptionalString, EffectString.startsWith('actions/upload-artifact@')),
              ),
            ),
          ),
        ),
      ),
    );
    const summary = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), effectFindReceiver =>
        Option.getOrUndefined(
          EffectArray.findFirst(effectFindReceiver, step =>
            Boolean(
              Effect.pipe(step.run, effectOptionalString =>
                effectOptionalString == null
                  ? undefined
                  : Effect.pipe(effectOptionalString, EffectString.includes('Production-large release evidence')),
              ),
            ),
          ),
        ),
      ),
    );
    const enforcement = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), findArray =>
        Option.getOrUndefined(
          EffectArray.findFirst(findArray, step => step.name === 'Enforce a completed production-shaped observation'),
        ),
      ),
    );
    const productionInputValue = workflow.on.workflow_dispatch?.inputs?.include_production_large;
    const productionInputSchema = Schema.Struct({description: Schema.optionalKey(Schema.String)});
    const productionInput = Schema.is(productionInputSchema)(productionInputValue) ? productionInputValue : undefined;

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
    const workflow = decodeWorkflow(load(readFileSync('.github/workflows/publish.yml', 'utf8'), {schema: JSON_SCHEMA}));
    const releaseEvidence = decodeWorkflow(
      load(readFileSync('.github/workflows/release-evidence.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    const publisher = decodeWorkflow(
      load(readFileSync('.github/workflows/publish-release-assets.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    const evidence = releaseEvidence.jobs['production-large-evidence'];
    const linux = workflow.jobs.linux;
    const macos = workflow.jobs.macos;
    const publish = workflow.jobs['publish-release'];
    const release = publisher.jobs.publish;
    const releaseCommand =
      Option.getOrUndefined(
        Option.map(
          Option.fromNullishOr(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(release.steps), __effectArrayValues =>
                EffectArray.flatMap(__effectArrayValues, (step, __effectArrayIndex) =>
                  __effectArrayIndex in __effectArrayValues ? (step.run ? [step.run] : []) : [],
                ),
              ),
            ),
          ),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, '\n'),
        ),
      ) ?? '';

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
    const evidence = decodeWorkflow(
      load(readFileSync('.github/workflows/production-large-evidence.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    const job = evidence.jobs['code-graph-production-large'];
    const summary = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), effectFindReceiver =>
        Option.getOrUndefined(
          EffectArray.findFirst(effectFindReceiver, step =>
            Boolean(
              Effect.pipe(step.run, effectOptionalString =>
                effectOptionalString == null
                  ? undefined
                  : Effect.pipe(effectOptionalString, EffectString.includes('Production-large release evidence')),
              ),
            ),
          ),
        ),
      ),
    );

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
    const workflow = decodeWorkflow(
      load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {schema: JSON_SCHEMA}),
    );
    const job = workflow.jobs['code-graph-heavy-tail'];
    const capture = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), effectFindReceiver =>
        Option.getOrUndefined(
          EffectArray.findFirst(effectFindReceiver, step =>
            Boolean(
              Effect.pipe(step.run, effectOptionalString =>
                effectOptionalString == null
                  ? undefined
                  : Effect.pipe(effectOptionalString, EffectString.includes('bench:code-graph:heavy-tail')),
              ),
            ),
          ),
        ),
      ),
    );
    const upload = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(job.steps), effectFindReceiver =>
        Option.getOrUndefined(
          EffectArray.findFirst(effectFindReceiver, step =>
            Boolean(
              Effect.pipe(step.uses, effectOptionalString =>
                effectOptionalString == null
                  ? undefined
                  : Effect.pipe(effectOptionalString, EffectString.startsWith('actions/upload-artifact@')),
              ),
            ),
          ),
        ),
      ),
    );

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
