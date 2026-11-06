/* oxlint-disable effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-record, effecttsgo/prefer-effect-string -- This admission/bootstrap entrypoint runs before frozen dependencies exist; keep it Bun-only. */
export const windowsQualificationEnabled = process.env.THREADNOTE_WINDOWS_IDENTITY_QUALIFICATION === '1';
export const qualificationBase = '4d84b452fd43c518f14f9427b478b7161b4bf6bf';
export const qualificationJob = 'Windows identity qualification';
export const qualificationDirectory = '.context/windows-identity-qualification';
export const qualificationLimits = {totalBytes: 2 * 1024 * 1024, records: 96, recordBytes: 16 * 1024} as const;
export const qualificationFiles = [
  'apps/threadnote/test/dev-skills/native-cycle-ordinary-merge.test.ts',
  'apps/threadnote/test/dev-skills/workflow-shared-context.test.ts',
] as const;
export const qualificationEdits = [
  '.github/workflows/ci.yml',
  'apps/threadnote/test/dev-skills/native-authoring-progress-diagnostics.ts',
  'apps/threadnote/test/dev-skills/native-automation-fixture.ts',
  'apps/threadnote/test/dev-skills/workflow-property-diagnostics.ts',
  'apps/threadnote/test/dev-skills/native-authoring-progress-diagnostics.test.ts',
  'apps/threadnote/test/dev-skills/workflow-property-diagnostics.test.ts',
  'tools/ci/windows-identity-qualification.ts',
  'tools/ci/test/windows-identity-qualification.test.ts',
  'tools/ci/test/ci-workflow.test.ts',
] as const;
/** The existing Windows smoke inventory; selection remains owned by its unchanged sequencer. */
export const windowsSmokeFiles = [
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
] as const;
export function windowsShard(value: string): '1/4' | '2/4' | '3/4' | '4/4' {
  if (value !== '1/4' && value !== '2/4' && value !== '3/4' && value !== '4/4')
    throw new QualificationGateError('unexpected-arguments');
  return value;
}
export function qualificationCommand(executable: string, output: string, shard?: string) {
  return [
    executable,
    '--bun',
    'vitest',
    'run',
    '--no-file-parallelism',
    '--testTimeout=120000',
    ...(shard === undefined ? [] : [`--shard=${windowsShard(shard)}`]),
    '--config=tools/ci/windows-smoke.config.ts',
    ...(shard === undefined ? [] : ['--reporter=default']),
    '--reporter=json',
    `--outputFile=${output}`,
    ...(shard === undefined ? qualificationFiles : windowsSmokeFiles),
  ];
}
const ordinaryNames = [
  'preflights the complete state at the real logical codec boundary before creating any pins',
  'uses the same whole-state preflight for the fixed stored-byte codec ceiling',
  'rolls back only newly created exact refs when failed I/O leaves the original durable state',
  'keeps all pins and returns the admitted receipt when rename committed before reporting an I/O failure',
  'cancels retained-object reads, final source capture and the final fence before any pin or receipt writes',
  'settles an in-flight rename before cancellation can race retention cleanup',
  'retains uncertain evidence when readback is unavailable, changed, or conditional cleanup loses an exact ref',
  'conserves 295=179+116 with a moved same-label base, immutable history and the exact current-base phase patch',
  'rejects unqualified source, forged ownership, missing authority and rebase laundering without writing evidence or refs',
  ...['base', 'head', 'branch', 'tree', 'prior-pin'].map(
    kind => `fences ${kind} drift after proof construction with no new snapshot, journal or pin writes`,
  ),
];
const sharedNames = [
  'resumes an original desktop binding to read and reference configured read-only context',
  'recovers a prepared shared relation only while its original share remains configured',
  'revokes shared reads and references when configuration is removed, without rebinding or mutation',
  'does not give desktop shared context mutation ownership or access to foreign private workflow artifacts',
  'rejects malformed configured team names without changing workflow or context bytes',
  'keeps personal cloud workflows restricted to their bound shares',
  'admits only exact configured desktop team namespaces without mutating reads or preflights',
];
export const qualificationCases = [
  ...ordinaryNames.map((name, i) => ({
    id: `ordinary-${i + 1}`,
    fullName: `ordinary merge native qualification ${name}`,
  })),
  ...sharedNames.map((name, i) => ({id: `shared-${i + 1}`, fullName: `workflow configured shared context ${name}`})),
];
export const qualificationCaseId = (name: string) =>
  qualificationCases.find(test => test.fullName === name.replaceAll(' > ', ' '))?.id;
const sha = (bytes: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value) || Array.isArray(value)) throw new Error('invalid-object');
  return value;
};
const gateGuidance = {
  'invalid-mode': 'Use identity mode alone; leave native stress and unrelated workload modes disabled.',
  'invalid-expected-sha': 'Supply the reviewed lowercase 40-character commit SHA through the fixed expected-SHA input.',
  'expected-sha-mismatch': 'Dispatch the reviewed immutable commit and use that exact SHA as expected input.',
  'source-admission-refused':
    'Use a clean descendant of the pinned base with only the admitted diagnostic paths changed.',
  'runtime-admission-refused': 'Use the fixed Windows lane without unrelated workload environment overrides.',
  'wrong-bun': 'Use the pinned Bun 1.4.4 setup step.',
  'invalid-repository': 'Use the fixed repository workflow context.',
  'invalid-id': 'Use provider-issued run, attempt and actual job identifiers.',
  'git-admission-failed': 'Restore a complete clean checkout of the admitted commit and base.',
  'job-lookup-failed': 'Check read-only Actions access and current run-attempt provenance; do not adopt old artifacts.',
  'job-response-bound': 'The current job lookup exceeded its fixed safe response bound; stop qualification.',
  'invalid-jobs': 'The current job response cannot prove provenance; stop qualification.',
  'ambiguous-job': 'Require one in-progress fixed-name job on this exact run attempt and SHA.',
  'invalid-job-start': 'Require valid provider job timing within the current executor observation.',
  'missing-output': 'Run only inside the supported workflow output channel.',
  'output-bound': 'The workflow output channel exceeded its safe bound; stop qualification.',
  'artifact-bound': 'Keep the three closed artifacts within the fixed combined byte cap.',
  'artifact-path-unsafe': 'Use a fresh owned regular output directory; stop on links or unexpected filesystem types.',
  'artifact-workspace-unowned': 'Finalize only the fresh workspace created by this executor, once.',
  'artifact-readback-mismatch':
    'Do not upload: physical output bytes or ownership differ from the approved closed projection.',
  'artifact-io-failed': 'Artifact filesystem finalization failed; do not upload partial or stale files.',
  'unexpected-arguments': 'Use only the fixed workflow command or its fixed admit preflight.',
  'admission-failed': 'Admission failed without a trusted reason; stop and inspect only bounded executor evidence.',
  'provenance-failed': 'Current provenance could not be established; do not adopt earlier attempt artifacts.',
  'execution-failed': 'The owned workload executor failed; retain its actual child outcome when available.',
  'finalization-failed': 'Safe required artifacts could not be finalized; do not upload partial outputs.',
} as const;
// oxlint-disable-next-line effecttsgo/extends-native-error -- Pre-dependency Bun admission uses a closed OS-boundary error code, outside any Effect failure channel.
export class QualificationGateError extends Error {
  constructor(readonly reason: keyof typeof gateGuidance) {
    super(reason);
  }
}
export const qualificationGateReceipt = (
  error: unknown,
  stage: 'admission' | 'provenance' | 'execution' | 'finalization',
  childExit: number | undefined,
) => {
  let reason: keyof typeof gateGuidance = `${stage}-failed`;
  try {
    if (error instanceof QualificationGateError) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'reason');
      const isReason = (value: unknown): value is keyof typeof gateGuidance =>
        typeof value === 'string' && Object.hasOwn(gateGuidance, value);
      if (descriptor && 'value' in descriptor && isReason(descriptor.value)) reason = descriptor.value;
    }
  } catch {
    /* A hostile exception object cannot replace the fixed fallback or reveal its payload. */
  }
  return {
    kind: 'qualification-executor-gate-failure',
    stage,
    reason,
    guidance: gateGuidance[reason],
    childExit: childExit ?? null,
  };
};
export const emitQualificationGateReceipt = (
  error: unknown,
  stage: 'admission' | 'provenance' | 'execution' | 'finalization',
  childExit: number | undefined,
  write: (line: string) => void = line => {
    process.stderr.write(line);
  },
) => {
  try {
    write(JSON.stringify(qualificationGateReceipt(error, stage, childExit)) + '\n');
  } catch {
    /* A closed diagnostic channel cannot replace the already retained child/gate exit. */
  }
};
const positiveId = (value: string | undefined) => {
  if (!value || !/^[1-9][0-9]{0,19}$/u.test(value)) throw new QualificationGateError('invalid-id');
  return value;
};
export function admitQualification(
  env: NodeJS.ProcessEnv,
  actual: {head: string; ancestor: boolean; changed: string[]; clean: boolean},
) {
  const expected = env.THREADNOTE_QUALIFICATION_EXPECTED_SHA;
  if (env.THREADNOTE_QUALIFICATION_ENABLED !== 'true' || env.THREADNOTE_QUALIFICATION_STRESS !== 'false')
    throw new QualificationGateError('invalid-mode');
  if (!expected || !/^[a-f0-9]{40}$/u.test(expected)) throw new QualificationGateError('invalid-expected-sha');
  if (expected !== env.GITHUB_SHA || expected !== actual.head)
    throw new QualificationGateError('expected-sha-mismatch');
  if (!actual.ancestor || !actual.clean || actual.changed.some(path => !new Set<string>(qualificationEdits).has(path)))
    throw new QualificationGateError('source-admission-refused');
  if (
    env.RUNNER_OS !== 'Windows' ||
    env.THREADNOTE_VITEST_LONG_GROUP ||
    env.THREADNOTE_NATIVE_WORKFLOW_LOAD ||
    env.THREADNOTE_NATIVE_WORKFLOW_CLOUD
  )
    throw new QualificationGateError('runtime-admission-refused');
  if (
    !env.GITHUB_REPOSITORY ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(env.GITHUB_REPOSITORY)
  )
    throw new QualificationGateError('invalid-repository');
  return {
    expected,
    repository: env.GITHUB_REPOSITORY,
    runId: positiveId(env.GITHUB_RUN_ID),
    attempt: positiveId(env.GITHUB_RUN_ATTEMPT),
  };
}
export function summarizeQualification(raw: unknown, fullShard = false) {
  const root = object(raw);
  if (!Array.isArray(root.testResults)) throw new Error('invalid-results');
  const found = new Map<
    string,
    {
      id: string;
      status: 'passed' | 'failed' | 'incomplete';
      category: 'none' | 'timeout' | 'test-failed' | 'not-completed';
      durationMs: number;
    }
  >();
  const workload = {total: 0, passed: 0, failed: 0, incomplete: 0};
  for (const suite of root.testResults) {
    const assertions = object(suite).assertionResults;
    if (!Array.isArray(assertions)) throw new Error('invalid-assertions');
    for (const value of assertions) {
      const test = object(value);
      if (typeof test.fullName !== 'string' || typeof test.status !== 'string') throw new Error('invalid-assertions');
      workload.total++;
      if (test.status === 'passed') workload.passed++;
      else if (test.status === 'failed') workload.failed++;
      else workload.incomplete++;
      const id = typeof test.fullName === 'string' ? qualificationCaseId(test.fullName) : undefined;
      if (!id && fullShard) continue;
      if (!id || found.has(id)) throw new Error('unexpected-or-duplicate-case');
      const status = test.status === 'passed' ? 'passed' : test.status === 'failed' ? 'failed' : 'incomplete';
      const timeout =
        status === 'failed' &&
        Array.isArray(test.failureMessages) &&
        test.failureMessages.some(message => typeof message === 'string' && /(?:Test|Hook) timed out/u.test(message));
      const duration = test.duration;
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)
        throw new Error('invalid-duration');
      found.set(id, {
        id,
        status,
        category:
          status === 'passed'
            ? 'none'
            : status === 'incomplete'
              ? 'not-completed'
              : timeout
                ? 'timeout'
                : 'test-failed',
        durationMs: Math.min(2_147_483_647, Math.round(duration)),
      });
    }
  }
  return {
    complete: found.size === 21 && [...found.values()].every(test => test.status !== 'incomplete'),
    cases: [...found.values()],
    workload,
  };
}

/** Reporter availability is separate from an observed empty or partial selected subset. */
export async function readQualificationResults(filename: string, fullShard = false) {
  const unavailable = (reason: 'missing' | 'invalid' | 'oversized' | 'unreadable') => ({
    complete: false,
    cases: [],
    workload: null,
    reporter: {status: 'unavailable', reason},
  });
  try {
    const raw = Bun.file(filename);
    if (!(await raw.exists())) return unavailable('missing');
    if (raw.size > 4 * 1024 * 1024) return unavailable('oversized');
    const text = await raw.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) return unavailable('oversized');
    try {
      return {...summarizeQualification(JSON.parse(text), fullShard), reporter: {status: 'available', reason: null}};
    } catch {
      return unavailable('invalid');
    }
  } catch {
    return unavailable('unreadable');
  }
}
/** Error/close may arrive asynchronously after a write callback; neither owns the test outcome. */
export async function drainQualificationStream(
  stream: ReadableStream<Uint8Array>,
  collector: ReturnType<typeof makeQualificationCollector>,
  sink?: NodeJS.WritableStream,
) {
  let failed = false;
  let waiting: (() => void) | undefined;
  const stop = () => {
    failed = true;
    waiting?.();
  };
  sink?.on('error', stop);
  sink?.on('close', stop);
  const reader = stream.getReader();
  let pending = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (sink && !failed) {
        try {
          await new Promise<void>(resolve => {
            waiting = resolve;
            sink.write(part.value, error => {
              if (error) failed = true;
              resolve();
            });
          });
        } catch {
          failed = true;
        }
        waiting = undefined;
      }
      for (const char of Buffer.from(part.value).toString('utf8')) {
        if (char === '\n') {
          if (pending.startsWith('WINDOWS_IDENTITY_DIAGNOSTIC '))
            collector.add(pending.slice('WINDOWS_IDENTITY_DIAGNOSTIC '.length));
          pending = '';
        } else if (pending.length < qualificationLimits.recordBytes + 100) pending += char;
      }
    }
  } finally {
    reader.releaseLock();
    // Drain the Writable callback/error event turn before retiring its listeners; no elapsed timer.
    await new Promise<void>(resolve => globalThis.setImmediate(resolve));
    sink?.off('error', stop);
    sink?.off('close', stop);
  }
}

const boundedInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
const exactFields = (value: unknown, keys: readonly string[]) => {
  const record = object(value);
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key)))
    throw new Error('invalid-diagnostic-record');
  return record;
};
const nullableDuration = (value: unknown) => value === null || boundedInteger(value);
const isOutcome = (value: unknown): value is 'Success' | 'Failure' => value === 'Success' || value === 'Failure';
const propertyPhases = new Set([
  'between-evaluations',
  'provisioning',
  'fixture',
  'explicit-opt-out',
  'default-setup',
  'status',
  'assertion',
  'create',
  'write-replay',
  'archive',
  'retired-write-replay',
  'archive-replay',
  'read-assertion',
  'configure-shared',
  'seed-source',
  'journal-read',
  'authorized-read',
  'authorized-preflight',
  'denied-read',
  'denied-preflight',
  'teardown',
]);
function validStage(value: unknown) {
  const stage = exactFields(value, ['started', 'ended', 'failed', 'inclusiveMs']);
  if (
    !boundedInteger(stage.started) ||
    !boundedInteger(stage.ended) ||
    !boundedInteger(stage.failed) ||
    stage.ended > stage.started ||
    stage.failed > stage.ended
  )
    return false;
  return stage.started > 0 && stage.started === stage.ended
    ? boundedInteger(stage.inclusiveMs)
    : stage.inclusiveMs === null;
}
function validInitialization(value: unknown) {
  const init = exactFields(value, [
    'connection',
    'acquisition',
    'incarnation',
    'state',
    'lifecycle',
    'outcome',
    'durationMs',
    'statements',
  ]);
  if (
    init.connection !== null ||
    init.incarnation !== null ||
    init.state !== 'unknown' ||
    init.lifecycle !== 'incomplete' ||
    !(init.acquisition === null || (boundedInteger(init.acquisition) && init.acquisition > 0))
  )
    return false;
  if (
    init.outcome === 'unknown' ? init.durationMs !== null : !isOutcome(init.outcome) || !boundedInteger(init.durationMs)
  )
    return false;
  const sql = exactFields(init.statements, ['count', 'failed', 'totalMs', 'recentMs']);
  const totalMs = sql.totalMs;
  const recent = sql.recentMs;
  if (
    !boundedInteger(sql.count) ||
    !boundedInteger(sql.failed) ||
    sql.failed > sql.count ||
    !boundedInteger(totalMs) ||
    !Array.isArray(recent) ||
    !recent.every(boundedInteger)
  )
    return false;
  return (
    recent.length <= 16 &&
    recent.length <= sql.count &&
    recent.every(value => value <= totalMs) &&
    (sql.count !== 0 || totalMs === 0)
  );
}
export function validateQualificationRecord(value: unknown) {
  const record = object(value);
  const caseId = record.caseId;
  if (typeof caseId !== 'string' || !qualificationCases.some(test => test.id === caseId) || record.complete !== false)
    throw new Error('invalid-diagnostic-record');
  if (record.kind === 'native' || record.kind === 'property') {
    exactFields(record, [
      'caseId',
      'kind',
      'evaluation',
      'occurrence',
      'outcome',
      'complete',
      'elapsedMs',
      'bodyMs',
      'cleanupMs',
      'initializations',
      'dropped',
      'stages',
    ]);
    const stages = exactFields(record.stages, ['schema', 'identity', 'refresh', 'acquire', 'realPath']);
    if (
      !boundedInteger(record.evaluation) ||
      !boundedInteger(record.occurrence) ||
      record.occurrence < 1 ||
      !isOutcome(record.outcome) ||
      !boundedInteger(record.elapsedMs) ||
      !nullableDuration(record.bodyMs) ||
      !nullableDuration(record.cleanupMs) ||
      !boundedInteger(record.dropped) ||
      !Array.isArray(record.initializations) ||
      record.initializations.length > 16 ||
      !record.initializations.every(validInitialization) ||
      !Object.values(stages).every(validStage)
    )
      throw new Error('invalid-diagnostic-record');
    if (
      record.kind === 'native'
        ? !caseId.startsWith('ordinary-') || record.evaluation !== 0
        : record.caseId !== 'shared-7' || record.evaluation < 1
    )
      throw new Error('invalid-diagnostic-record');
  } else if (record.kind === 'finished' && caseId.startsWith('ordinary-')) {
    exactFields(record, ['caseId', 'kind', 'complete']);
  } else if ((record.kind === 'finished' || record.kind === 'aborted') && record.caseId === 'shared-7') {
    exactFields(record, [
      'caseId',
      'kind',
      'complete',
      'elapsedMs',
      'phase',
      'phaseElapsedMs',
      'evaluation',
      'startedEvaluations',
      'completedEvaluations',
      'successfulEvaluations',
    ]);
    if (
      !boundedInteger(record.elapsedMs) ||
      typeof record.phase !== 'string' ||
      !propertyPhases.has(record.phase) ||
      !boundedInteger(record.phaseElapsedMs) ||
      !boundedInteger(record.evaluation) ||
      !boundedInteger(record.startedEvaluations) ||
      !boundedInteger(record.completedEvaluations) ||
      !boundedInteger(record.successfulEvaluations) ||
      record.completedEvaluations > record.startedEvaluations ||
      record.successfulEvaluations > record.completedEvaluations ||
      record.evaluation > record.startedEvaluations
    )
      throw new Error('invalid-diagnostic-record');
  } else throw new Error('invalid-diagnostic-record');
  return record;
}
export function makeQualificationCollector() {
  const records: ReturnType<typeof validateQualificationRecord>[] = [];
  let bytes = 0;
  let rejectedRecords = 0;
  return {
    add(line: string) {
      try {
        if (Buffer.byteLength(line) > qualificationLimits.recordBytes || records.length >= qualificationLimits.records)
          throw new Error('record-bound');
        const record = validateQualificationRecord(JSON.parse(line));
        const size = Buffer.byteLength(JSON.stringify(record));
        if (bytes + size > qualificationLimits.totalBytes - 128 * 1024) throw new Error('total-bound');
        bytes += size;
        records.push(record);
      } catch {
        rejectedRecords = Math.min(2_147_483_647, rejectedRecords + 1);
      }
    },
    snapshot: () => ({
      complete: false,
      structurallyComplete: rejectedRecords === 0 && records.length > 0,
      records: records.map(record => structuredClone(record)),
      rejectedRecords,
    }),
  };
}

export function resolveQualificationJob(
  raw: unknown,
  expected: {runId: string; attempt: string; sha: string; observedAt: string; jobName?: string},
) {
  const jobs = object(raw).jobs;
  if (!Array.isArray(jobs)) throw new QualificationGateError('invalid-jobs');
  const matches = jobs
    .map(object)
    .filter(
      job =>
        job.name === (expected.jobName ?? qualificationJob) &&
        String(job.run_id) === expected.runId &&
        String(job.run_attempt) === expected.attempt &&
        job.head_sha === expected.sha &&
        job.status === 'in_progress',
    );
  if (matches.length !== 1) throw new QualificationGateError('ambiguous-job');
  const startedAt = matches[0].started_at;
  if (
    typeof startedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(startedAt) ||
    !Number.isFinite(Date.parse(startedAt)) ||
    !Number.isFinite(Date.parse(expected.observedAt)) ||
    Date.parse(startedAt) > Date.parse(expected.observedAt)
  )
    throw new QualificationGateError('invalid-job-start');
  return {id: positiveId(String(matches[0].id)), startedAt};
}

type QualificationWorkspace = Readonly<{
  repository: string;
  root: string;
  artifacts: string;
  work: string;
  relativeArtifacts: string;
}>;
const ownedWorkspaces = new WeakSet<QualificationWorkspace>();
type SafeQualificationArtifacts = Readonly<{directory: string; totalBytes: number}>;
const finalizedArtifacts = new WeakSet<SafeQualificationArtifacts>();
async function artifactFileSystem() {
  // oxlint-disable-next-line threadnote/no-node-runtime -- Bun-only bootstrap has no dependency services; secure artifact boundaries require lstat, exclusive descriptors and physical readback.
  return await import('node:fs/promises');
}
async function artifactPath() {
  // oxlint-disable-next-line threadnote/no-node-runtime -- Platform-native canonical artifact paths, without dependency loading in pre-install admission.
  return await import('node:path');
}
export async function createQualificationWorkspace(repository = process.cwd()): Promise<QualificationWorkspace> {
  try {
    const fs = await artifactFileSystem();
    const path = await artifactPath();
    const canonical = await fs.realpath(repository);
    const directory = async (target: string) => {
      let info;
      try {
        info = await fs.lstat(target);
      } catch {
        await fs.mkdir(target, {mode: 0o700});
        info = await fs.lstat(target);
      }
      if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(target)) !== target)
        throw new QualificationGateError('artifact-path-unsafe');
    };
    const context = path.join(canonical, '.context');
    await directory(context);
    const parent = path.join(context, 'windows-identity-qualification');
    await directory(parent);
    const root = await fs.mkdtemp(path.join(parent, 'q-'));
    await fs.chmod(root, 0o700);
    const artifacts = path.join(root, 'artifacts');
    const work = path.join(root, 'work');
    await fs.mkdir(artifacts, {mode: 0o700});
    await fs.mkdir(work, {mode: 0o700});
    const relativeArtifacts = path.relative(canonical, artifacts).split(path.sep).join('/');
    if (!/^\.context\/windows-identity-qualification\/q-[A-Za-z0-9]{6,16}\/artifacts$/u.test(relativeArtifacts))
      throw new QualificationGateError('artifact-path-unsafe');
    const owned = Object.freeze({repository: canonical, root, artifacts, work, relativeArtifacts});
    ownedWorkspaces.add(owned);
    return owned;
  } catch (error) {
    if (error instanceof QualificationGateError) throw error;
    throw new QualificationGateError('artifact-io-failed');
  }
}
export async function finalizeQualificationArtifacts(
  workspace: QualificationWorkspace,
  files: {'manifest.json': string; 'statuses.json': string; 'diagnostics.json': string},
) {
  if (!ownedWorkspaces.delete(workspace)) throw new QualificationGateError('artifact-workspace-unowned');
  try {
    const fs = await artifactFileSystem();
    const path = await artifactPath();
    const verifyDirectories = async () => {
      for (const directory of [
        path.join(workspace.repository, '.context'),
        path.dirname(workspace.root),
        workspace.root,
        workspace.artifacts,
      ]) {
        const info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
          throw new QualificationGateError('artifact-path-unsafe');
      }
    };
    await verifyDirectories();
    const names = ['manifest.json', 'statuses.json', 'diagnostics.json'] as const;
    if (
      Object.keys(files).length !== 3 ||
      Object.keys(files).some(name => !names.some(expected => name === expected)) ||
      (await fs.readdir(workspace.artifacts)).length !== 0
    )
      throw new QualificationGateError('artifact-path-unsafe');
    const approved = names.map(name => ({name, bytes: Buffer.from(files[name]), sha256: sha(files[name])}));
    if (
      approved.some(file => file.bytes.byteLength === 0) ||
      approved.reduce((total, file) => total + file.bytes.byteLength, 0) > qualificationLimits.totalBytes
    )
      throw new QualificationGateError('artifact-bound');
    const identities = new Map<string, {dev: number; ino: number}>();
    for (const file of approved) {
      const target = path.join(workspace.artifacts, file.name);
      const descriptor = await fs.open(target, 'wx+', 0o600);
      try {
        await descriptor.writeFile(file.bytes);
        await descriptor.sync();
        const opened = await descriptor.stat();
        identities.set(file.name, {dev: opened.dev, ino: opened.ino});
        const physical = await fs.lstat(target);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          !physical.isFile() ||
          physical.isSymbolicLink() ||
          physical.nlink !== 1 ||
          opened.dev !== physical.dev ||
          opened.ino !== physical.ino ||
          opened.size !== file.bytes.byteLength ||
          physical.size !== file.bytes.byteLength ||
          (await fs.realpath(target)) !== target
        )
          throw new QualificationGateError('artifact-readback-mismatch');
        const bytes = Buffer.alloc(file.bytes.byteLength);
        let position = 0;
        while (position < bytes.byteLength) {
          const read = await descriptor.read(bytes, position, bytes.byteLength - position, position);
          if (read.bytesRead === 0) throw new QualificationGateError('artifact-readback-mismatch');
          position += read.bytesRead;
        }
        if (sha(bytes) !== file.sha256) throw new QualificationGateError('artifact-readback-mismatch');
      } finally {
        await descriptor.close();
      }
    }
    await verifyDirectories();
    const actualNames = await fs.readdir(workspace.artifacts);
    if (actualNames.length !== names.length || actualNames.some(name => !names.some(expected => name === expected)))
      throw new QualificationGateError('artifact-path-unsafe');
    let totalBytes = 0;
    for (const file of approved) {
      const target = path.join(workspace.artifacts, file.name);
      const info = await fs.lstat(target);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size !== file.bytes.byteLength ||
        (await fs.realpath(target)) !== target
      )
        throw new QualificationGateError('artifact-readback-mismatch');
      const descriptor = await fs.open(target, 'r');
      try {
        const opened = await descriptor.stat();
        const identity = identities.get(file.name);
        if (
          !identity ||
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.dev !== identity.dev ||
          opened.ino !== identity.ino ||
          opened.size !== file.bytes.byteLength
        )
          throw new QualificationGateError('artifact-readback-mismatch');
        const bytes = Buffer.alloc(file.bytes.byteLength);
        let position = 0;
        while (position < bytes.byteLength) {
          const read = await descriptor.read(bytes, position, bytes.byteLength - position, position);
          if (read.bytesRead === 0) throw new QualificationGateError('artifact-readback-mismatch');
          position += read.bytesRead;
        }
        totalBytes += bytes.byteLength;
        const after = await fs.lstat(target);
        if (
          !after.isFile() ||
          after.isSymbolicLink() ||
          after.nlink !== 1 ||
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.size !== bytes.byteLength ||
          sha(bytes) !== file.sha256 ||
          totalBytes > qualificationLimits.totalBytes
        )
          throw new QualificationGateError('artifact-readback-mismatch');
      } finally {
        await descriptor.close();
      }
    }
    await verifyDirectories();
    const ready = Object.freeze({directory: workspace.relativeArtifacts, totalBytes});
    finalizedArtifacts.add(ready);
    return ready;
  } catch (error) {
    if (error instanceof QualificationGateError) throw error;
    throw new QualificationGateError('artifact-io-failed');
  }
}
export async function publishQualificationReady(
  outputPath: string,
  artifactName: string,
  ready: SafeQualificationArtifacts,
) {
  if (!finalizedArtifacts.delete(ready)) throw new QualificationGateError('artifact-workspace-unowned');
  const directory = ready.directory;
  if (
    !/^windows-identity-[1-9][0-9]*-[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{40}$/u.test(artifactName) ||
    !/^\.context\/windows-identity-qualification\/q-[A-Za-z0-9]{6,16}\/artifacts$/u.test(directory)
  )
    throw new QualificationGateError('artifact-path-unsafe');
  try {
    const fs = await artifactFileSystem();
    const info = await fs.lstat(outputPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024)
      throw new QualificationGateError('output-bound');
    const descriptor = await fs.open(outputPath, 'a');
    try {
      const opened = await descriptor.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino)
        throw new QualificationGateError('artifact-readback-mismatch');
      await descriptor.writeFile(
        `artifact_name=${artifactName}\nartifact_directory=${directory}\nsafe_artifacts_ready=true\n`,
      );
    } finally {
      await descriptor.close();
    }
  } catch (error) {
    if (error instanceof QualificationGateError) throw error;
    throw new QualificationGateError('artifact-io-failed');
  }
}

export function admitFullShard(env: NodeJS.ProcessEnv, actual: {head: string; clean: boolean}, shard: string) {
  windowsShard(shard);
  if (!env.THREADNOTE_WINDOWS_PROVIDER_HEAD_SHA || !/^[a-f0-9]{40}$/u.test(env.THREADNOTE_WINDOWS_PROVIDER_HEAD_SHA))
    throw new QualificationGateError('invalid-expected-sha');
  // Full PR CI intentionally includes the complete current source, including provider merge commits.
  // The manual diagnostic's narrow changed-path/base policy remains separate.
  return admitQualification(
    {
      ...env,
      THREADNOTE_QUALIFICATION_ENABLED: 'true',
      THREADNOTE_QUALIFICATION_STRESS: 'false',
      THREADNOTE_QUALIFICATION_EXPECTED_SHA: env.GITHUB_SHA,
    },
    {...actual, ancestor: true, changed: []},
  );
}
function sourceAdmission(shard?: string) {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {stdout: 'pipe', stderr: 'ignore', maxBuffer: 1024 * 1024});
    if (result.exitCode !== 0 || result.stdout.byteLength > 1024 * 1024)
      throw new QualificationGateError('git-admission-failed');
    return new TextDecoder().decode(result.stdout).trim();
  };
  const admission =
    shard === undefined
      ? admitQualification(process.env, {
          head: git('rev-parse', 'HEAD'),
          ancestor: (() => {
            try {
              git('merge-base', '--is-ancestor', qualificationBase, 'HEAD');
              return true;
            } catch {
              return false;
            }
          })(),
          changed: git('diff', '--name-only', qualificationBase, 'HEAD').split('\n').filter(Boolean),
          clean: git('status', '--porcelain').length === 0,
        })
      : admitFullShard(
          process.env,
          {head: git('rev-parse', 'HEAD'), clean: git('status', '--porcelain').length === 0},
          shard,
        );
  if (Bun.version !== '1.4.4') throw new QualificationGateError('wrong-bun');
  return {git, admission};
}

export const cancelledChildExit = (exited: number, signal: 'SIGINT' | 'SIGTERM' | undefined) =>
  exited !== 0 || signal === undefined ? exited : signal === 'SIGINT' ? 130 : 143;
export const qualificationExitCode = (childExit: number | undefined, safelyFinalized: boolean) =>
  childExit === undefined ? 1 : childExit !== 0 ? childExit : safelyFinalized ? 0 : 1;
let actualChildExit: number | undefined;
let executorStage: 'admission' | 'provenance' | 'execution' | 'finalization' = 'admission';

async function runQualification(shard?: string) {
  const {git, admission} = sourceAdmission(shard);
  executorStage = 'provenance';
  const startedAt = new Date().toISOString();
  const response = await fetch(
    `https://api.github.com/repos/${admission.repository}/actions/runs/${admission.runId}/attempts/${admission.attempt}/jobs?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ''}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok || !response.body) throw new QualificationGateError('job-lookup-failed');
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    received += part.value.byteLength;
    if (received > 256 * 1024) {
      await reader.cancel();
      throw new QualificationGateError('job-response-bound');
    }
    chunks.push(part.value);
  }
  const job = resolveQualificationJob(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
    ...admission,
    sha: shard === undefined ? admission.expected : process.env.THREADNOTE_WINDOWS_PROVIDER_HEAD_SHA!,
    observedAt: startedAt,
    ...(shard === undefined ? {} : {jobName: `Bun unit smoke · Windows · ${shard}`}),
  });
  const jobId = job.id;
  const artifactName = `windows-identity-${admission.runId}-${admission.attempt}-${jobId}-${admission.expected}`;
  if (!process.env.GITHUB_OUTPUT) throw new QualificationGateError('missing-output');
  const workspace = await createQualificationWorkspace();
  const sourcePaths = [
    ...qualificationEdits,
    ...qualificationFiles,
    'bun.lock',
    'vitest.config.ts',
    'tools/ci/windows-smoke.config.ts',
    'apps/threadnote/test/dev-skills/native-cycle-lifecycle-fixture.ts',
    'node_modules/effect/src/sql/Statement.ts',
    'node_modules/@effect/sql-sqlite-bun/src/SqliteClient.ts',
  ];
  const source = Object.fromEntries(
    await Promise.all(sourcePaths.map(async path => [path, sha(await Bun.file(path).bytes())] as const)),
  );
  const collector = makeQualificationCollector();
  executorStage = 'execution';
  const child = Bun.spawn(
    qualificationCommand(
      process.execPath,
      shard === undefined ? `${workspace.work}/raw-results.json` : '.context/windows-smoke/results.json',
      shard,
    ),
    {
      env: {...process.env, THREADNOTE_WINDOWS_IDENTITY_QUALIFICATION: '1'},
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let cancelled: 'SIGINT' | 'SIGTERM' | undefined;
  const interrupt = () => {
    cancelled ??= 'SIGINT';
    child.kill('SIGINT');
  };
  const terminate = () => {
    cancelled ??= 'SIGTERM';
    child.kill('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  let streamIncomplete = false;
  const readers = Promise.all(
    [
      drainQualificationStream(child.stdout, collector, shard === undefined ? undefined : process.stdout),
      drainQualificationStream(child.stderr, collector, shard === undefined ? undefined : process.stderr),
    ].map(read =>
      read.catch(() => {
        streamIncomplete = true;
      }),
    ),
  );
  const exited = await child.exited;
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  const code = cancelledChildExit(exited, cancelled);
  actualChildExit = code;
  process.exitCode = code;
  await readers;
  executorStage = 'finalization';
  const results = await readQualificationResults(
    shard === undefined ? `${workspace.work}/raw-results.json` : '.context/windows-smoke/results.json',
    shard !== undefined,
  );
  const captured = collector.snapshot();
  const diagnostic = {...captured, complete: captured.complete && !streamIncomplete, streamIncomplete};
  const files = {'statuses.json': JSON.stringify(results), 'diagnostics.json': JSON.stringify(diagnostic)};
  const manifest = {
    version: 1,
    runId: admission.runId,
    attempt: admission.attempt,
    jobId,
    sha: admission.expected,
    providerHeadSha: shard === undefined ? admission.expected : process.env.THREADNOTE_WINDOWS_PROVIDER_HEAD_SHA,
    tree: git('rev-parse', 'HEAD^{tree}'),
    base: qualificationBase,
    bun: Bun.version,
    os: process.platform,
    arch: process.arch,
    jobStartedAt: job.startedAt,
    startedAt,
    endedAt: new Date().toISOString(),
    artifactName,
    source,
    childExit: exited,
    cancellationSignal: cancelled ?? null,
    childSignalled: child.signalCode !== null,
    clocks: {
      spanDurations: 'inclusive-overlapping-native-nanoseconds-to-rounded-ms',
      boundaryDurations: 'diagnostic-monotonic-ms',
    },
    coverage: {
      configuredNativeCaseObservers: 14,
      configuredSharedPropertyObservers: 1,
      sharedCasesWithSetupUnobserved: 6,
      observedRecordCount: diagnostic.records.length,
      physicalDatabaseLifecycle: 'unknown',
      attributionComplete: false,
    },
    complete: results.complete && diagnostic.complete,
    scope: shard === undefined ? 'targeted-only-not-full-ci' : 'full-windows-shard-selected-diagnostics',
    shard: shard ?? null,
    selectedCaseStatusesOnly: true,
    files: Object.fromEntries(
      Object.entries(files).map(([name, data]) => [name, {bytes: Buffer.byteLength(data), sha256: sha(data)}] as const),
    ),
  };
  const manifestBytes = JSON.stringify(manifest);
  if (
    Buffer.byteLength(manifestBytes) + Object.values(files).reduce((sum, data) => sum + Buffer.byteLength(data), 0) >
    qualificationLimits.totalBytes
  )
    throw new QualificationGateError('artifact-bound');
  const ready = await finalizeQualificationArtifacts(workspace, {'manifest.json': manifestBytes, ...files});
  await publishQualificationReady(process.env.GITHUB_OUTPUT, artifactName, ready);
  process.exitCode = qualificationExitCode(code, true);
}
if (import.meta.main) {
  try {
    if (process.argv.length === 3 && process.argv[2] === 'admit') sourceAdmission();
    else if (process.argv.length === 4 && process.argv[2] === 'full-shard')
      await runQualification(windowsShard(process.argv[3]));
    else if (process.argv.length !== 2) throw new QualificationGateError('unexpected-arguments');
    else await runQualification();
  } catch (error) {
    process.exitCode = qualificationExitCode(actualChildExit, false);
    emitQualificationGateReceipt(error, executorStage, actualChildExit);
  }
}
