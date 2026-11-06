import {Array as EffectArray, Option} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import fc from 'fast-check';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  linkSync,
  lstatSync,
} from '@threadnote/testing/node-fs';
import {join} from '@threadnote/testing/node-path';
import {tmpdir} from '@threadnote/testing/node-os';
import {describe, expect, it} from 'vitest';
import {
  admitQualification,
  readQualificationResults,
  admitFullShard,
  cancelledChildExit,
  qualificationCommand,
  windowsSmokeFiles,
  windowsShard,
  createQualificationWorkspace,
  finalizeQualificationArtifacts,
  publishQualificationReady,
  qualificationGateReceipt,
  QualificationGateError,
  emitQualificationGateReceipt,
  makeQualificationCollector,
  qualificationBase,
  qualificationCaseId,
  qualificationCases,
  qualificationEdits,
  qualificationFiles,
  qualificationExitCode,
  qualificationJob,
  qualificationLimits,
  resolveQualificationJob,
  summarizeQualification,
} from '../windows-identity-qualification.js';

const env = {
  THREADNOTE_QUALIFICATION_ENABLED: 'true',
  THREADNOTE_QUALIFICATION_STRESS: 'false',
  THREADNOTE_QUALIFICATION_EXPECTED_SHA: qualificationBase,
  GITHUB_SHA: qualificationBase,
  RUNNER_OS: 'Windows',
  GITHUB_REPOSITORY: 'threadnote/threadnote',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '2',
};
const actual = {head: qualificationBase, ancestor: true, changed: [...qualificationEdits], clean: true};
const rawResults = (failed = -1) => ({
  testResults: [
    {
      assertionResults: EffectArray.map(qualificationCases, (test, i) => ({
        fullName: test.fullName,
        status: i === failed ? 'failed' : 'passed',
        duration: i + 0.4,
        failureMessages: i === failed ? ['Test timed out in 60000ms PRIVATE'] : [],
      })),
    },
  ],
});
const job = {
  id: 456,
  name: qualificationJob,
  run_id: 123,
  run_attempt: 2,
  head_sha: qualificationBase,
  status: 'in_progress',
  started_at: '2026-11-05T21:00:00Z',
};

const unknownStage = () => ({started: 0, ended: 0, failed: 0, inclusiveMs: null});
const validStages = () => ({
  schema: unknownStage(),
  identity: unknownStage(),
  refresh: unknownStage(),
  acquire: unknownStage(),
  realPath: unknownStage(),
});
const validInitialization = () => ({
  connection: null,
  acquisition: 1,
  incarnation: null,
  state: 'unknown',
  lifecycle: 'incomplete',
  outcome: 'Success',
  durationMs: 0,
  statements: {count: 0, failed: 0, totalMs: 0, recentMs: []},
});
const validNativeRecord = () => ({
  caseId: 'ordinary-1',
  kind: 'native',
  evaluation: 0,
  occurrence: 1,
  outcome: 'Success',
  complete: false,
  elapsedMs: 1,
  bodyMs: 0,
  cleanupMs: 0,
  initializations: [validInitialization()],
  dropped: 0,
  stages: validStages(),
});

describe('fixed Windows identity qualification admission', () => {
  it('admits only exact immutable source and fixed safe environment inputs', () => {
    expect(admitQualification(env, actual)).toEqual({
      expected: qualificationBase,
      repository: 'threadnote/threadnote',
      runId: '123',
      attempt: '2',
    });
    for (const changed of [
      {...env, THREADNOTE_QUALIFICATION_EXPECTED_SHA: EffectString.toUpperCase(qualificationBase)},
      {...env, THREADNOTE_QUALIFICATION_EXPECTED_SHA: '$(PRIVATE)'},
      {...env, THREADNOTE_QUALIFICATION_STRESS: 'true'},
      {...env, GITHUB_SHA: EffectString.repeat(40)('0')},
      {...env, GITHUB_REPOSITORY: '../PRIVATE'},
      {...env, GITHUB_RUN_ATTEMPT: '0'},
      {...env, THREADNOTE_NATIVE_WORKFLOW_LOAD: '1'},
    ])
      expect(() => admitQualification(changed, actual)).toThrow();
    for (const changed of [
      {...actual, clean: false},
      {...actual, ancestor: false},
      {...actual, changed: [...actual.changed, qualificationFiles[0]]},
      {...actual, changed: ['bun.lock']},
      {...actual, head: EffectString.repeat(40)('0')},
    ])
      expect(() => admitQualification(env, changed)).toThrow();
  });
  it('resolves one actual job on this exact run attempt and refuses stale or ambiguous identities', () => {
    const identity = {runId: '123', attempt: '2', sha: qualificationBase, observedAt: '2026-11-05T21:01:00Z'};
    expect(resolveQualificationJob({jobs: [job]}, identity)).toEqual({id: '456', startedAt: job.started_at});
    for (const jobs of [
      [],
      [job, job],
      [{...job, run_attempt: 1}],
      [{...job, head_sha: EffectString.repeat(40)('0')}],
      [{...job, status: 'completed'}],
      [{...job, started_at: 'PRIVATE'}],
      [{...job, started_at: '2026-11-06T21:00:00Z'}],
    ])
      expect(() => resolveQualificationJob({jobs}, identity)).toThrow();
  });
});

it('projects exactly21 statuses without raw messages, paths, stacks or console', () => {
  const summary = summarizeQualification(rawResults(6));
  expect(summary.complete).toBe(true);
  expect(summary.cases).toHaveLength(21);
  expect(summary.cases[6]).toEqual({id: 'ordinary-7', status: 'failed', category: 'timeout', durationMs: 6});
  expect(JSON.stringify(summary)).not.toContain('PRIVATE');
  const short = rawResults();
  short.testResults[0].assertionResults.pop();
  expect(summarizeQualification(short).complete).toBe(false);
  const duplicate = rawResults();
  duplicate.testResults[0].assertionResults.push(duplicate.testResults[0].assertionResults[0]);
  expect(() => summarizeQualification(duplicate)).toThrow();
  expect(
    qualificationCaseId(EffectString.replace('qualification ', 'qualification > ')(qualificationCases[0].fullName)),
  ).toBe('ordinary-1');
  expect(qualificationCaseId('PRIVATE')).toBeUndefined();
});

it('retains unknown lifecycle honestly and enforces record count and byte bounds', () => {
  const collector = makeQualificationCollector();
  const record = JSON.stringify(validNativeRecord());
  for (let i = 0; i < qualificationLimits.records + 1; i++) collector.add(record);
  expect(collector.snapshot().records).toHaveLength(96);
  expect(collector.snapshot().complete).toBe(false);
  const oversized = makeQualificationCollector();
  oversized.add(EffectString.repeat(qualificationLimits.recordBytes + 1)(' '));
  expect(oversized.snapshot()).toMatchObject({complete: false, records: []});
  expect(makeQualificationCollector().snapshot().complete).toBe(false);
});

it('never serializes arbitrary generated private diagnostic payloads', () => {
  fc.assert(
    fc.property(fc.string({maxLength: 500}), payload => {
      const collector = makeQualificationCollector();
      collector.add(JSON.stringify({caseId: 'ordinary-1', complete: false, privatePayload: payload}));
      expect(collector.snapshot()).toMatchObject({complete: false, records: []});
    }),
    {numRuns: 40},
  );
});
it('preserves all generated fixed-case pass/failure statuses independently of diagnostic completeness', () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), {minLength: 21, maxLength: 21}), flags => {
      const raw = rawResults();
      for (let i = 0; i < flags.length; i++)
        raw.testResults[0].assertionResults[i].status = flags[i] ? 'passed' : 'failed';
      const summary = summarizeQualification(raw);
      expect(summary.complete).toBe(true);
      for (let i = 0; i < flags.length; i++) expect(summary.cases[i].status === 'passed').toBe(flags[i]);
      expect(summary.cases).toHaveLength(21);
    }),
    {numRuns: 40},
  );
});

it('keeps diagnostic workflow fixed and excludes every raw/intermediate fixture artifact', async () => {
  const source = await Bun.file('.github/workflows/ci.yml').text();
  expect(source).toContain('windows_identity_expected_sha:');
  expect(source).toContain('actions: read');
  expect(source).toContain('persist-credentials: false');
  expect(source).toContain('run: bun tools/ci/windows-identity-qualification.ts admit');
  const upload = EffectString.slice(
    Effect2.pipe(
      source,
      EffectString.indexOf('name: Preserve bounded attempt-bound diagnostics'),
      Option.getOrElse(() => -1),
    ),
    Effect2.pipe(
      source,
      EffectString.indexOf('  bazel-plan:'),
      Option.getOrElse(() => -1),
    ),
  )(source);
  expect(upload).toContain('/manifest.json');
  expect(upload).toContain('/statuses.json');
  expect(upload).toContain('/diagnostics.json');
  expect(upload).toContain("safe_artifacts_ready == 'true'");
  expect(upload).toContain('steps.qualification.outputs.artifact_directory');
  expect(upload).not.toContain('raw-results');
  expect(upload).not.toContain('continue-on-error');
  expect(qualificationFiles).toHaveLength(2);
  expect(qualificationCases).toHaveLength(21);
});

it('keeps child outcomes independent of unknown lifecycle attribution and separate executor gates', () => {
  const collector = makeQualificationCollector();
  collector.add(JSON.stringify(validNativeRecord()));
  expect(collector.snapshot().complete).toBe(false);
  expect(qualificationExitCode(0, true)).toBe(0);
  expect(qualificationExitCode(0, false)).toBe(1);
  expect(qualificationExitCode(undefined, false)).toBe(1);
  expect(qualificationExitCode(undefined, true)).toBe(1);
  fc.assert(
    fc.property(fc.integer({min: 1, max: 255}), fc.boolean(), (code, finalized) => {
      expect(qualificationExitCode(code, finalized)).toBe(code);
    }),
    {numRuns: 40},
  );
});

it('retains the existing closed property phase and evaluation at lifecycle boundaries', () => {
  const collector = makeQualificationCollector();
  collector.add(
    JSON.stringify({
      caseId: 'shared-7',
      kind: 'aborted',
      complete: false,
      elapsedMs: 4,
      phase: 'authorized-preflight',
      phaseElapsedMs: 3,
      evaluation: 11,
      startedEvaluations: 11,
      completedEvaluations: 10,
      successfulEvaluations: 10,
    }),
  );
  expect(collector.snapshot().records).toHaveLength(1);
  expect(collector.snapshot().records[0]).toMatchObject({phase: 'authorized-preflight', evaluation: 11});
});

it('rejects allowed-key type mutations, missing fields and contradictory UNKNOWN completeness', () => {
  const mutations: ((record: Record<string, unknown>) => void)[] = [
    record => {
      delete record.kind;
    },
    record => {
      delete record.complete;
    },
    record => {
      record.complete = true;
    },
    record => {
      record.elapsedMs = 'Success';
    },
    record => {
      record.evaluation = 'Success';
    },
    record => {
      record.durationMs = 'Success';
    },
    record => {
      record.stages = {...validStages(), schema: {started: 1, ended: 0, failed: 0, inclusiveMs: 0}};
    },
    record => {
      record.stages = {...validStages(), schema: {started: 0, ended: 1, failed: 0, inclusiveMs: 0}};
    },
    record => {
      record.initializations = [{...validInitialization(), connection: 1}];
    },
    record => {
      record.initializations = [{...validInitialization(), outcome: 'unknown', durationMs: 0}];
    },
    record => {
      record.initializations = [
        {...validInitialization(), statements: {count: 0, failed: 1, totalMs: 0, recentMs: []}},
      ];
    },
  ];
  for (const mutate of mutations) {
    const record: Record<string, unknown> = validNativeRecord();
    mutate(record);
    const collector = makeQualificationCollector();
    collector.add(JSON.stringify(record));
    expect(collector.snapshot()).toMatchObject({
      complete: false,
      structurallyComplete: false,
      rejectedRecords: 1,
      records: [],
    });
  }
  fc.assert(
    fc.property(fc.integer({min: 0, max: mutations.length - 1}), index => {
      const record: Record<string, unknown> = validNativeRecord();
      mutations[index](record);
      const collector = makeQualificationCollector();
      collector.add(JSON.stringify(record));
      expect(collector.snapshot().records).toHaveLength(0);
      expect(collector.snapshot().rejectedRecords).toBe(1);
    }),
    {numRuns: 40},
  );
});

it('keeps fixed gate reason guidance actionable without serializing arbitrary exception data', () => {
  const fixed = qualificationGateReceipt(new QualificationGateError('invalid-expected-sha'), 'admission', undefined);
  expect(fixed.reason).toBe('invalid-expected-sha');
  expect(fixed.guidance).toContain('40-character');
  const hostile = new QualificationGateError('wrong-bun');
  Object.defineProperty(hostile, 'reason', {
    get: () => {
      throw new Error('PRIVATE');
    },
  });
  expect(qualificationGateReceipt(hostile, 'admission', undefined).reason).toBe('admission-failed');
  const arbitrary = qualificationGateReceipt(new Error('PRIVATE path/token/body'), 'finalization', 7);
  expect(arbitrary).toMatchObject({reason: 'finalization-failed', childExit: 7});
  expect(JSON.stringify(arbitrary)).not.toContain('PRIVATE');
  fc.assert(
    fc.property(fc.string({maxLength: 500}), payload => {
      const receipt = qualificationGateReceipt(new Error('PRIVATE' + payload), 'provenance', 1);
      expect(receipt.reason).toBe('provenance-failed');
      expect(receipt.guidance.length).toBeLessThan(180);
      expect(JSON.stringify(receipt)).not.toContain('PRIVATE');
    }),
    {numRuns: 30},
  );
});

const artifactBytes = () => ({
  'manifest.json': '{"version":1}',
  'statuses.json': '{"complete":false,"cases":[]}',
  'diagnostics.json': '{"complete":false,"records":[]}',
});
const artifactName = `windows-identity-123-2-456-${qualificationBase}`;
it('uses fresh owned directories and verifies safe physical bytes before exposing upload readiness', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'threadnote-qualification-artifacts-'));
  try {
    const workspace = await createQualificationWorkspace(repository);
    const second = await createQualificationWorkspace(repository);
    expect(second.root).not.toBe(workspace.root);
    const ready = await finalizeQualificationArtifacts(workspace, artifactBytes());
    const output = join(repository, 'github-output');
    writeFileSync(output, '');
    expect(readFileSync(output, 'utf8')).toBe('');
    for (const name of ['manifest.json', 'statuses.json', 'diagnostics.json'] as const) {
      const file = join(workspace.artifacts, name);
      expect(lstatSync(file).isFile()).toBe(true);
      expect(lstatSync(file).isSymbolicLink()).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(artifactBytes()[name]);
    }
    await publishQualificationReady(output, artifactName, ready);
    expect(readFileSync(output, 'utf8')).toContain('safe_artifacts_ready=true');
    expect(readFileSync(output, 'utf8')).toContain(`artifact_directory=${workspace.relativeArtifacts}`);
    await expect(publishQualificationReady(output, artifactName, ready)).rejects.toThrow();
    // Failed tests may upload the same safe finalized artifact set; their nonzero code remains unchanged.
    expect(qualificationExitCode(7, true)).toBe(7);
  } finally {
    rmSync(repository, {recursive: true, force: true});
  }
});
it('rejects linked parents, stale files and hardlinked outputs without publishing or modifying their targets', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'threadnote-qualification-artifacts-'));
  const outside = mkdtempSync(join(tmpdir(), 'threadnote-qualification-outside-'));
  try {
    symlinkSync(outside, join(repository, '.context'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(createQualificationWorkspace(repository)).rejects.toThrow();
    rmSync(join(repository, '.context'), {force: true});
    for (const hardlink of process.platform === 'win32' ? [true] : [false, true]) {
      const workspace = await createQualificationWorkspace(repository);
      const target = join(outside, hardlink ? 'hardlink-target' : 'symlink-target');
      writeFileSync(target, 'PRIVATE outside bytes');
      if (hardlink) linkSync(target, join(workspace.artifacts, 'manifest.json'));
      else symlinkSync(target, join(workspace.artifacts, 'manifest.json'));
      await expect(finalizeQualificationArtifacts(workspace, artifactBytes())).rejects.toThrow();
      expect(readFileSync(target, 'utf8')).toBe('PRIVATE outside bytes');
    }
    const workspace = await createQualificationWorkspace(repository);
    await expect(
      finalizeQualificationArtifacts(workspace, {
        ...artifactBytes(),
        'manifest.json': EffectString.repeat(qualificationLimits.totalBytes + 1)('x'),
      }),
    ).rejects.toThrow();
  } finally {
    rmSync(repository, {recursive: true, force: true});
    rmSync(outside, {recursive: true, force: true});
  }
});
it('rejects a substituted artifact directory and a forged readiness receipt', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'threadnote-qualification-artifacts-'));
  const outside = mkdtempSync(join(tmpdir(), 'threadnote-qualification-outside-'));
  try {
    const workspace = await createQualificationWorkspace(repository);
    rmSync(workspace.artifacts, {recursive: true});
    symlinkSync(outside, workspace.artifacts, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(finalizeQualificationArtifacts(workspace, artifactBytes())).rejects.toThrow();
    const output = join(repository, 'github-output');
    writeFileSync(output, '');
    await expect(
      publishQualificationReady(output, artifactName, {directory: workspace.relativeArtifacts, totalBytes: 1}),
    ).rejects.toThrow();
    expect(readFileSync(output, 'utf8')).toBe('');
  } finally {
    rmSync(repository, {recursive: true, force: true});
    rmSync(outside, {recursive: true, force: true});
  }
});

it('keeps the retained child failure independent of a broken gate-receipt sink', () => {
  const childExit = qualificationExitCode(7, false);
  expect(() =>
    emitQualificationGateReceipt(new Error('PRIVATE'), 'finalization', 7, () => {
      throw new Error('PRIVATE sink');
    }),
  ).not.toThrow();
  expect(childExit).toBe(7);
});

it('rejects non-string outcome values at both enum boundaries while retaining valid literal outcomes', () => {
  const collect = (record: Record<string, unknown>) => {
    const collector = makeQualificationCollector();
    collector.add(JSON.stringify(record));
    return collector.snapshot();
  };
  for (const outcome of ['Success', 'Failure']) {
    expect(collect({...validNativeRecord(), outcome}).structurallyComplete).toBe(true);
    expect(
      collect({...validNativeRecord(), initializations: [{...validInitialization(), outcome}]}).structurallyComplete,
    ).toBe(true);
  }
  expect(
    collect({
      ...validNativeRecord(),
      initializations: [{...validInitialization(), outcome: 'unknown', durationMs: null}],
    }).structurallyComplete,
  ).toBe(true);
  for (const outcome of [null, {}, {outcome: 'Success'}, 0, true, ['Success'], [['Failure']], [[['Success']]]]) {
    for (const record of [
      {...validNativeRecord(), outcome},
      {...validNativeRecord(), initializations: [{...validInitialization(), outcome}]},
    ]) {
      expect(collect(record)).toMatchObject({structurallyComplete: false, records: [], rejectedRecords: 1});
    }
  }
  fc.assert(
    fc.property(fc.constantFrom('Success', 'Failure'), fc.integer({min: 1, max: 5}), (literal, depth) => {
      let outcome: unknown = literal;
      for (let i = 0; i < depth; i++) outcome = [outcome];
      expect(collect({...validNativeRecord(), outcome})).toMatchObject({structurallyComplete: false, records: []});
      expect(collect({...validNativeRecord(), initializations: [{...validInitialization(), outcome}]})).toMatchObject({
        structurallyComplete: false,
        records: [],
      });
    }),
    {numRuns: 40},
  );
});

it('runs the complete fixed original Windows inventory for each unchanged shard, without a case-name filter', () => {
  for (const shard of ['1/4', '2/4', '3/4', '4/4']) {
    const args = qualificationCommand('bun', '.context/windows-smoke/results.json', shard);
    expect(args).toEqual([
      'bun',
      '--bun',
      'vitest',
      'run',
      '--no-file-parallelism',
      '--testTimeout=120000',
      `--shard=${shard}`,
      '--config=tools/ci/windows-smoke.config.ts',
      '--reporter=default',
      '--reporter=json',
      '--outputFile=.context/windows-smoke/results.json',
      ...windowsSmokeFiles,
    ]);
    expect(args).not.toContain('--testNamePattern');
    expect(args).not.toContain('-t');
    expect(args).toContain('apps/threadnote/test/unit/local-ai.test.ts');
  }
  expect(() => windowsShard('1/1')).toThrow();
  expect(() => windowsShard('1/4 --testNamePattern unsafe')).toThrow();
});
it('binds full-shard checkout source independently of provider head, preserving manual source restrictions', () => {
  const merge = EffectString.repeat(40)('a');
  const full = {...env, GITHUB_SHA: merge, THREADNOTE_WINDOWS_PROVIDER_HEAD_SHA: qualificationBase};
  expect(admitFullShard(full, {head: merge, clean: true}, '1/4').expected).toBe(merge);
  expect(() => admitFullShard(full, {head: qualificationBase, clean: true}, '1/4')).toThrow();
  expect(() => admitFullShard(full, {head: merge, clean: false}, '1/4')).toThrow();
  expect(() => admitQualification(env, {...actual, changed: ['production.ts']})).toThrow();
  expect(
    resolveQualificationJob(
      {jobs: [{...job, name: 'Bun unit smoke · Windows · 1/4'}]},
      {
        runId: '123',
        attempt: '2',
        sha: qualificationBase,
        observedAt: '2026-11-05T21:01:00Z',
        jobName: 'Bun unit smoke · Windows · 1/4',
      },
    ),
  ).toEqual({id: '456', startedAt: job.started_at});
});
it('retains non-selected workload failures while exporting only fixed selected case identities', () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), {minLength: 1, maxLength: 40}), flags => {
      const raw = rawResults();
      raw.testResults[0].assertionResults.push(
        ...EffectArray.map(flags, passed => ({
          fullName: 'PRIVATE other test',
          status: passed ? 'passed' : 'failed',
          duration: 1,
          failureMessages: [],
        })),
      );
      const summary = summarizeQualification(raw, true);
      expect(summary.cases).toHaveLength(21);
      expect(summary.workload.total).toBe(21 + flags.length);
      expect(summary.workload.failed).toBe(EffectArray.filter(flags, passed => !passed).length);
      expect(JSON.stringify(summary)).not.toContain('PRIVATE');
      expect(qualificationExitCode(7, true)).toBe(7);
      expect(qualificationExitCode(7, false)).toBe(7);
      expect(() => summarizeQualification(raw)).toThrow();
    }),
    {numRuns: 40},
  );
  const raw = rawResults();
  raw.testResults[0].assertionResults = raw.testResults[0].assertionResults.slice(0, 2);
  expect(summarizeQualification(raw, true)).toMatchObject({complete: false, workload: {total: 2}});
});

it('retains genuine child failure under cancellation and never relabels cancelled success as a pass', () => {
  fc.assert(
    fc.property(fc.integer({min: 1, max: 255}), code => {
      for (const signal of [undefined, 'SIGINT', 'SIGTERM'] as const) {
        expect(cancelledChildExit(code, signal)).toBe(code);
        expect(qualificationExitCode(cancelledChildExit(code, signal), false)).toBe(code);
      }
    }),
    {numRuns: 40},
  );
  expect(cancelledChildExit(0, undefined)).toBe(0);
  expect(cancelledChildExit(0, 'SIGINT')).toBe(130);
  expect(cancelledChildExit(0, 'SIGTERM')).toBe(143);
});

it('marks missing, invalid and oversized reporter files unavailable, without inventing zero workload counts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-reporter-'));
  const file = join(root, 'report.json');
  try {
    expect(await readQualificationResults(file, true)).toMatchObject({
      workload: null,
      reporter: {status: 'unavailable', reason: 'missing'},
    });
    for (const contents of ['{', '{}', JSON.stringify({testResults: [{assertionResults: [{}]}]})]) {
      writeFileSync(file, contents);
      expect(await readQualificationResults(file, true)).toMatchObject({
        workload: null,
        reporter: {status: 'unavailable', reason: 'invalid'},
      });
    }
    const duplicate = rawResults();
    duplicate.testResults[0].assertionResults.push(duplicate.testResults[0].assertionResults[0]);
    writeFileSync(file, JSON.stringify(duplicate));
    expect(await readQualificationResults(file, true)).toMatchObject({workload: null, reporter: {reason: 'invalid'}});
    writeFileSync(file, EffectString.repeat(4 * 1024 * 1024 + 1)(' '));
    expect(await readQualificationResults(file, true)).toMatchObject({workload: null, reporter: {reason: 'oversized'}});
    writeFileSync(file, JSON.stringify({testResults: []}));
    expect(await readQualificationResults(file, true)).toMatchObject({
      workload: {total: 0},
      reporter: {status: 'available', reason: null},
    });
    const subset = rawResults();
    subset.testResults[0].assertionResults = subset.testResults[0].assertionResults.slice(0, 2);
    writeFileSync(file, JSON.stringify(subset));
    expect(await readQualificationResults(file, true)).toMatchObject({
      complete: false,
      workload: {total: 2},
      reporter: {status: 'available'},
    });
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

it('drains a real child after a closed console without replacing child0, child7 or cancellation outcome', async () => {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-console-'));
  const home = join(root, 'home'),
    repository = join(root, 'repo'),
    installation = join(root, 'installation');
  for (const dir of [home, repository, installation]) mkdirSync(dir);
  const moduleUrl = new URL('../windows-identity-qualification.ts', import.meta.url).href;
  try {
    for (const [childExit, signal, expected] of [
      [0, null, 0],
      [7, null, 7],
      [0, 'SIGTERM', 143],
    ] as const) {
      const source = `import {drainQualificationStream, makeQualificationCollector, cancelledChildExit} from ${JSON.stringify(moduleUrl)};
        await Bun.stdin.text();
        const before=process.stdout.listenerCount('error');
        const collector=makeQualificationCollector();
        const child=Bun.spawn([process.execPath,'-e',${JSON.stringify('process.stdout.write(' + JSON.stringify('WINDOWS_IDENTITY_DIAGNOSTIC ' + JSON.stringify(validNativeRecord()) + '\n') + ');process.exit(' + childExit + ');')}],{stdout:'pipe',stderr:'ignore'});
        await drainQualificationStream(child.stdout,collector,process.stdout);
        const code=await child.exited;
        process.stderr.write(JSON.stringify({code,records:collector.snapshot().records.length,listenersRetired:process.stdout.listenerCount('error')===before}));
        process.exitCode=cancelledChildExit(code,${JSON.stringify(signal)}??undefined);`;
      const wrapper = Bun.spawn([process.execPath, '-e', source], {
        cwd: repository,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: home,
          THREADNOTE_HOME: home,
          THREADNOTE_INSTALL_ROOT: installation,
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      try {
        await wrapper.stdout.cancel();
        await wrapper.stdin.write('go');
        await wrapper.stdin.end();
        const stderr = await new Response(wrapper.stderr).text();
        expect(await wrapper.exited).toBe(expected);
        expect(JSON.parse(stderr)).toEqual({code: childExit, records: 1, listenersRetired: true});
      } finally {
        wrapper.kill();
        await wrapper.exited;
      }
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
