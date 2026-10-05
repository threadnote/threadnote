import {sha256HexSync} from '@threadnote/platform/sha256';

export const MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION = 1 as const;
export const MATCHED_EVALUATION_VERIFICATION_STATUSES = ['passed', 'task-failed'] as const;
export const MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION = 1 as const;
export const MATCHED_CONTINUATION_PHASE_TWO_CHECK_POLICIES = ['must-pass', 'no-new-failures'] as const;
export const MATCHED_CONTINUATION_PHASE_TWO_DIAGNOSTIC_PARSERS = [
  'pytest-summary-v1',
  'threadnote-verifier-v1',
  'vitest-summary-v1',
] as const;

export type MatchedEvaluationVerificationStatus = (typeof MATCHED_EVALUATION_VERIFICATION_STATUSES)[number];
export type MatchedContinuationPhaseTwoCheckPolicy = (typeof MATCHED_CONTINUATION_PHASE_TWO_CHECK_POLICIES)[number];
export type MatchedContinuationPhaseTwoDiagnosticParser =
  (typeof MATCHED_CONTINUATION_PHASE_TWO_DIAGNOSTIC_PARSERS)[number];

export interface MatchedContinuationPhaseTwoVerificationCheckV1 {
  readonly allowedBaselineFailureIds: readonly string[];
  readonly checkId: string;
  readonly commandTokens: readonly string[];
  readonly diagnosticParser: MatchedContinuationPhaseTwoDiagnosticParser;
  readonly policy: MatchedContinuationPhaseTwoCheckPolicy;
}

export interface MatchedContinuationPhaseTwoVerificationPlanV1 {
  readonly checks: readonly MatchedContinuationPhaseTwoVerificationCheckV1[];
  readonly planHash: string;
  readonly protectedPaths: readonly string[];
  readonly taskId: string;
  readonly version: typeof MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION;
}

export interface MatchedContinuationPhaseTwoVerificationCheckReceiptV1 {
  readonly artifactHash: string;
  readonly checkId: string;
  readonly diagnosticHash: string;
  readonly durationMilliseconds: number;
  readonly exitCode: 0 | 1;
  readonly failureIds: readonly string[];
  readonly planHash: string;
  readonly receiptHash: string;
  readonly status: MatchedEvaluationVerificationStatus;
  readonly version: typeof MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION;
}

export interface MatchedContinuationPhaseTwoVerificationReceiptV1 {
  readonly artifactHash: string;
  readonly checks: readonly MatchedContinuationPhaseTwoVerificationCheckReceiptV1[];
  readonly durationMilliseconds: number;
  readonly planHash: string;
  readonly protectedPathViolations: readonly string[];
  readonly receiptHash: string;
  readonly status: MatchedEvaluationVerificationStatus;
  readonly taskId: string;
  readonly version: typeof MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION;
}

export interface MatchedEvaluationVerificationCalibrationV1 {
  readonly baseDiagnosticHash: string;
  readonly baseExitCode: 1;
  readonly baseRepositoryFixtureHash: string;
  readonly baseRevision: string;
  readonly fixDiagnosticHash: string;
  readonly fixExitCode: 0;
  readonly fixRepositoryFixtureHash: string;
  readonly fixRevision: string;
  readonly receiptHash: string;
}

export interface MatchedEvaluationVerificationTaskV1 {
  readonly calibration: MatchedEvaluationVerificationCalibrationV1;
  readonly selector: string;
  readonly taskId: string;
  readonly verificationId: string;
}

export interface MatchedEvaluationVerificationPlanV1 {
  readonly environmentDirectory: string;
  readonly environmentHash: string;
  readonly interpreter: string;
  readonly interpreterHash: string;
  readonly planHash: string;
  readonly runner: string;
  readonly runnerHash: string;
  readonly sandbox: {
    readonly executable: string;
    readonly executableHash: string;
    readonly policy: 'darwin-seatbelt-v1';
  };
  readonly tasks: readonly MatchedEvaluationVerificationTaskV1[];
  readonly timeoutMilliseconds: number;
  readonly version: typeof MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION;
}

export interface MatchedEvaluationVerificationReceiptV1 {
  readonly artifactHash: string;
  readonly diagnosticHash: string;
  readonly durationMilliseconds: number;
  readonly environmentHash: string;
  readonly exitCode: 0 | 1;
  readonly interpreterHash: string;
  readonly planHash: string;
  readonly receiptHash: string;
  readonly runnerHash: string;
  readonly sandboxExecutableHash: string;
  readonly status: MatchedEvaluationVerificationStatus;
  readonly taskId: string;
  readonly verificationId: string;
  readonly version: typeof MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION;
}

const HASH = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const SELECTOR = /^[a-z][a-z0-9-]{0,63}$/u;

export function createMatchedEvaluationVerificationCalibrationV1(
  input: Omit<MatchedEvaluationVerificationCalibrationV1, 'receiptHash'>,
): MatchedEvaluationVerificationCalibrationV1 {
  const canonical = parseCalibration({...input, receiptHash: '0'.repeat(64)}, false);
  return {...canonical, receiptHash: matchedEvaluationVerificationCalibrationHashV1(canonical)};
}

export function createMatchedEvaluationVerificationPlanV1(
  input: Omit<MatchedEvaluationVerificationPlanV1, 'planHash' | 'version'>,
): MatchedEvaluationVerificationPlanV1 {
  const canonical = parsePlan(
    {
      ...input,
      planHash: '0'.repeat(64),
      tasks: [...input.tasks].sort((left, right) => left.taskId.localeCompare(right.taskId)),
      version: MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION,
    },
    false,
  );
  return {...canonical, planHash: matchedEvaluationVerificationPlanHashV1(canonical)};
}

export function parseMatchedEvaluationVerificationPlanV1(value: unknown): MatchedEvaluationVerificationPlanV1 {
  return parsePlan(value, true);
}

export function createMatchedEvaluationVerificationReceiptV1(
  input: Omit<MatchedEvaluationVerificationReceiptV1, 'receiptHash' | 'version'>,
): MatchedEvaluationVerificationReceiptV1 {
  const canonical = parseReceipt(
    {...input, receiptHash: '0'.repeat(64), version: MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION},
    false,
  );
  return {...canonical, receiptHash: matchedEvaluationVerificationReceiptHashV1(canonical)};
}

export function parseMatchedEvaluationVerificationReceiptV1(value: unknown): MatchedEvaluationVerificationReceiptV1 {
  return parseReceipt(value, true);
}

export function createMatchedContinuationPhaseTwoVerificationPlanV1(input: {
  readonly checks: readonly Omit<MatchedContinuationPhaseTwoVerificationCheckV1, 'checkId'>[];
  readonly protectedPaths: readonly string[];
  readonly taskId: string;
}): MatchedContinuationPhaseTwoVerificationPlanV1 {
  const taskId = matching(input.taskId, TASK_ID, 'continuation verification task id');
  const checks = input.checks
    .map(check => {
      const canonical = parseContinuationCheck({...check, checkId: '0'.repeat(64)}, false);
      return {...canonical, checkId: matchedContinuationPhaseTwoVerificationCheckIdV1(taskId, canonical)};
    })
    .sort((left, right) => left.checkId.localeCompare(right.checkId));
  const canonical = parseContinuationPlan(
    {
      checks,
      planHash: '0'.repeat(64),
      protectedPaths: input.protectedPaths,
      taskId,
      version: MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION,
    },
    false,
  );
  return {...canonical, planHash: matchedContinuationPhaseTwoVerificationPlanHashV1(canonical)};
}

export function parseMatchedContinuationPhaseTwoVerificationPlanV1(
  value: unknown,
): MatchedContinuationPhaseTwoVerificationPlanV1 {
  return parseContinuationPlan(value, true);
}

export function createMatchedContinuationPhaseTwoVerificationCheckReceiptV1(input: {
  readonly artifactHash: string;
  readonly check: MatchedContinuationPhaseTwoVerificationCheckV1;
  readonly diagnosticHash: string;
  readonly durationMilliseconds: number;
  readonly exitCode: 0 | 1;
  readonly failureIds: readonly string[];
  readonly planHash: string;
}): MatchedContinuationPhaseTwoVerificationCheckReceiptV1 {
  const check = parseContinuationCheck(input.check, true);
  const failureIds = canonicalFailureIds(input.failureIds, 'continuation verification observed failures');
  const status = continuationCheckPassed(check, input.exitCode, failureIds) ? 'passed' : 'task-failed';
  const canonical = parseContinuationCheckReceipt(
    {
      artifactHash: input.artifactHash,
      checkId: check.checkId,
      diagnosticHash: input.diagnosticHash,
      durationMilliseconds: input.durationMilliseconds,
      exitCode: input.exitCode,
      failureIds,
      planHash: input.planHash,
      receiptHash: '0'.repeat(64),
      status,
      version: MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION,
    },
    false,
  );
  return {...canonical, receiptHash: matchedContinuationPhaseTwoVerificationCheckReceiptHashV1(canonical)};
}

export function parseMatchedContinuationPhaseTwoVerificationCheckReceiptV1(
  value: unknown,
): MatchedContinuationPhaseTwoVerificationCheckReceiptV1 {
  return parseContinuationCheckReceipt(value, true);
}

export function createMatchedContinuationPhaseTwoVerificationReceiptV1(input: {
  readonly artifactHash: string;
  readonly checks: readonly MatchedContinuationPhaseTwoVerificationCheckReceiptV1[];
  readonly durationMilliseconds?: number;
  readonly plan: MatchedContinuationPhaseTwoVerificationPlanV1;
  readonly protectedPathViolations: readonly string[];
}): MatchedContinuationPhaseTwoVerificationReceiptV1 {
  const plan = parseMatchedContinuationPhaseTwoVerificationPlanV1(input.plan);
  const artifactHash = matching(input.artifactHash, HASH, 'continuation verification artifact hash');
  const checks = input.checks
    .map(parseMatchedContinuationPhaseTwoVerificationCheckReceiptV1)
    .sort((left, right) => left.checkId.localeCompare(right.checkId));
  assertContinuationReceiptCoverage(plan, checks, artifactHash);
  const protectedPathViolations = canonicalRepositoryPaths(
    input.protectedPathViolations,
    'continuation verification protected path violations',
    true,
  );
  if (
    protectedPathViolations.some(
      path => !plan.protectedPaths.some(protectedPath => isProtectedRepositoryPath(protectedPath, path)),
    )
  ) {
    invalid('continuation verification reports a path outside the sealed protected paths');
  }
  const checkDurationMilliseconds = checks.reduce((sum, check) => sum + check.durationMilliseconds, 0);
  const canonical = parseContinuationAggregateReceipt(
    {
      artifactHash,
      checks,
      durationMilliseconds: input.durationMilliseconds ?? checkDurationMilliseconds,
      planHash: plan.planHash,
      protectedPathViolations,
      receiptHash: '0'.repeat(64),
      status:
        protectedPathViolations.length === 0 && checks.every(check => check.status === 'passed')
          ? 'passed'
          : 'task-failed',
      taskId: plan.taskId,
      version: MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION,
    },
    false,
  );
  return {...canonical, receiptHash: matchedContinuationPhaseTwoVerificationReceiptHashV1(canonical)};
}

export function parseMatchedContinuationPhaseTwoVerificationReceiptV1(input: {
  readonly artifactHash: string;
  readonly plan: MatchedContinuationPhaseTwoVerificationPlanV1;
  readonly receipt: unknown;
}): MatchedContinuationPhaseTwoVerificationReceiptV1 {
  const plan = parseMatchedContinuationPhaseTwoVerificationPlanV1(input.plan);
  const artifactHash = matching(input.artifactHash, HASH, 'continuation verification artifact hash');
  const receipt = parseContinuationAggregateReceipt(input.receipt, true);
  if (receipt.artifactHash !== artifactHash || receipt.planHash !== plan.planHash || receipt.taskId !== plan.taskId) {
    invalid('continuation verification aggregate identity differs from its sealed plan or artifact');
  }
  assertContinuationReceiptCoverage(plan, receipt.checks, artifactHash);
  if (
    receipt.protectedPathViolations.some(
      path => !plan.protectedPaths.some(protectedPath => isProtectedRepositoryPath(protectedPath, path)),
    )
  ) {
    invalid('continuation verification protected path violations differ from its sealed plan');
  }
  return receipt;
}

function isProtectedRepositoryPath(protectedPath: string, changedPath: string): boolean {
  return changedPath === protectedPath || changedPath.startsWith(`${protectedPath}/`);
}

export function parseMatchedContinuationPytestFailureIdsV1(stdout: string, stderr: string): readonly string[] {
  const failures: string[] = [];
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const payload = diagnosticPayload(trimmed, 'FAILED') ?? diagnosticPayload(trimmed, 'ERROR');
    if (payload === undefined) continue;
    const separator = firstAsciiWhitespaceIndex(payload);
    failures.push(separator === -1 ? payload : payload.slice(0, separator));
  }
  return canonicalFailureIds(failures, 'pytest failure ids');
}

export function parseMatchedContinuationVitestFailureIdsV1(stdout: string, stderr: string): readonly string[] {
  const failures = new Set<string>();
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/u)) {
    const payload = diagnosticPayload(stripAnsiControlSequencesV1(line).trim(), 'FAIL');
    if (payload !== undefined) failures.add(payload);
  }
  return canonicalFailureIds([...failures], 'vitest failure ids');
}

function diagnosticPayload(line: string, marker: string): string | undefined {
  if (!line.startsWith(marker) || !isAsciiWhitespace(line[marker.length])) return undefined;
  let start = marker.length + 1;
  while (start < line.length && isAsciiWhitespace(line[start])) start += 1;
  return start === line.length ? undefined : line.slice(start);
}

function firstAsciiWhitespaceIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (isAsciiWhitespace(value[index])) return index;
  }
  return -1;
}

function isAsciiWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r' || value === '\f' || value === '\v';
}

export function parseMatchedContinuationThreadnoteVerifierFailureIdsV1(
  stdout: string,
  stderr: string,
): readonly string[] {
  if (stdout.trim() !== '') return [];
  for (const line of stderr.split(/\r?\n/u)) {
    const match = /^[a-z][a-z0-9-]* verifier failed:\s*(\{.*\})$/u.exec(line.trim());
    if (match?.[1] === undefined) continue;
    try {
      const diagnostic = JSON.parse(match[1]) as {readonly completed?: unknown; readonly failures?: unknown};
      if (diagnostic.completed === true && Array.isArray(diagnostic.failures) && diagnostic.failures.length > 0) {
        return ['sealed-verifier-failure'];
      }
    } catch {
      return [];
    }
  }
  return [];
}

export function parseMatchedContinuationFailureIdsV1(
  diagnosticParser: MatchedContinuationPhaseTwoDiagnosticParser,
  stdout: string,
  stderr: string,
): readonly string[] {
  switch (diagnosticParser) {
    case 'pytest-summary-v1':
      return parseMatchedContinuationPytestFailureIdsV1(stdout, stderr);
    case 'threadnote-verifier-v1':
      return parseMatchedContinuationThreadnoteVerifierFailureIdsV1(stdout, stderr);
    case 'vitest-summary-v1':
      return parseMatchedContinuationVitestFailureIdsV1(stdout, stderr);
  }
}

function stripAnsiControlSequencesV1(value: string): string {
  let stripped = '';
  for (let index = 0; index < value.length;) {
    if (value.charCodeAt(index) !== 0x1b || value[index + 1] !== '[') {
      stripped += value[index];
      index += 1;
      continue;
    }
    index += 2;
    while (index < value.length) {
      const codePoint = value.charCodeAt(index);
      index += 1;
      if (codePoint >= 0x40 && codePoint <= 0x7e) break;
    }
  }
  return stripped;
}

export function matchedEvaluationVerificationIdV1(taskId: string, selector: string): string {
  return digest('matched-evaluation-verification-id-v1', {
    selector: matching(selector, SELECTOR, 'verification selector'),
    taskId: matching(taskId, TASK_ID, 'verification task id'),
  });
}

export function matchedEvaluationVerificationCalibrationHashV1(
  input: Omit<MatchedEvaluationVerificationCalibrationV1, 'receiptHash'>,
): string {
  const {receiptHash: _receiptHash, ...withoutHash} = input as MatchedEvaluationVerificationCalibrationV1;
  return digest('matched-evaluation-verification-calibration-v1', withoutHash);
}

export function matchedEvaluationVerificationPlanHashV1(
  input: Omit<MatchedEvaluationVerificationPlanV1, 'planHash'>,
): string {
  const {planHash: _planHash, ...withoutHash} = input as MatchedEvaluationVerificationPlanV1;
  return digest('matched-evaluation-verification-plan-v1', withoutHash);
}

export function matchedEvaluationVerificationReceiptHashV1(
  input: Omit<MatchedEvaluationVerificationReceiptV1, 'receiptHash'>,
): string {
  const {receiptHash: _receiptHash, ...withoutHash} = input as MatchedEvaluationVerificationReceiptV1;
  return digest('matched-evaluation-verification-receipt-v1', withoutHash);
}

export function matchedContinuationPhaseTwoVerificationCheckIdV1(
  taskId: string,
  input: Omit<MatchedContinuationPhaseTwoVerificationCheckV1, 'checkId'>,
): string {
  const {checkId: _checkId, ...check} = parseContinuationCheck({...input, checkId: '0'.repeat(64)}, false);
  return digest('matched-continuation-phase-two-check-id-v1', {
    ...check,
    taskId: matching(taskId, TASK_ID, 'continuation verification task id'),
  });
}

export function matchedContinuationPhaseTwoVerificationPlanHashV1(
  input: Omit<MatchedContinuationPhaseTwoVerificationPlanV1, 'planHash'>,
): string {
  const {planHash: _planHash, ...withoutHash} = input as MatchedContinuationPhaseTwoVerificationPlanV1;
  return digest('matched-continuation-phase-two-plan-v1', withoutHash);
}

export function matchedContinuationPhaseTwoVerificationCheckReceiptHashV1(
  input: Omit<MatchedContinuationPhaseTwoVerificationCheckReceiptV1, 'receiptHash'>,
): string {
  const {receiptHash: _receiptHash, ...withoutHash} = input as MatchedContinuationPhaseTwoVerificationCheckReceiptV1;
  return digest('matched-continuation-phase-two-check-receipt-v1', withoutHash);
}

export function matchedContinuationPhaseTwoVerificationReceiptHashV1(
  input: Omit<MatchedContinuationPhaseTwoVerificationReceiptV1, 'receiptHash'>,
): string {
  const {receiptHash: _receiptHash, ...withoutHash} = input as MatchedContinuationPhaseTwoVerificationReceiptV1;
  return digest('matched-continuation-phase-two-receipt-v1', withoutHash);
}

function parsePlan(value: unknown, verifyHash: boolean): MatchedEvaluationVerificationPlanV1 {
  const plan = object(value, 'verification plan');
  exactKeys(plan, [
    'environmentDirectory',
    'environmentHash',
    'interpreter',
    'interpreterHash',
    'planHash',
    'runner',
    'runnerHash',
    'sandbox',
    'tasks',
    'timeoutMilliseconds',
    'version',
  ]);
  if (plan.version !== MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION) invalid('verification plan version must be 1');
  const sandbox = object(plan.sandbox, 'verification sandbox');
  exactKeys(sandbox, ['executable', 'executableHash', 'policy']);
  if (sandbox.policy !== 'darwin-seatbelt-v1') invalid('verification sandbox policy is unsupported');
  const tasks = array(plan.tasks, 'verification tasks')
    .map((task, index) => parseTask(task, index))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (tasks.length === 0 || tasks.length > 64) invalid('verification plan must contain 1-64 tasks');
  unique(
    tasks.map(task => task.taskId),
    'verification task ids',
  );
  unique(
    tasks.map(task => task.verificationId),
    'verification ids',
  );
  const withoutHash = {
    environmentDirectory: absolutePath(plan.environmentDirectory, 'verification environment directory'),
    environmentHash: matching(plan.environmentHash, HASH, 'verification environment hash'),
    interpreter: absolutePath(plan.interpreter, 'verification interpreter'),
    interpreterHash: matching(plan.interpreterHash, HASH, 'verification interpreter hash'),
    runner: absolutePath(plan.runner, 'verification runner'),
    runnerHash: matching(plan.runnerHash, HASH, 'verification runner hash'),
    sandbox: {
      executable: absolutePath(sandbox.executable, 'verification sandbox executable'),
      executableHash: matching(sandbox.executableHash, HASH, 'verification sandbox executable hash'),
      policy: 'darwin-seatbelt-v1' as const,
    },
    tasks,
    timeoutMilliseconds: integer(plan.timeoutMilliseconds, 1_000, 600_000, 'verification timeout'),
    version: MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION,
  };
  const planHash = matching(plan.planHash, HASH, 'verification plan hash');
  if (verifyHash && planHash !== matchedEvaluationVerificationPlanHashV1(withoutHash)) {
    invalid('verification plan hash does not match its contents');
  }
  return {...withoutHash, planHash};
}

function parseTask(value: unknown, index: number): MatchedEvaluationVerificationTaskV1 {
  const task = object(value, `verification task ${index}`);
  exactKeys(task, ['calibration', 'selector', 'taskId', 'verificationId']);
  const taskId = matching(task.taskId, TASK_ID, `verification task ${index} id`);
  const selector = matching(task.selector, SELECTOR, `verification task ${index} selector`);
  const verificationId = matching(task.verificationId, HASH, `verification task ${index} verification id`);
  if (verificationId !== matchedEvaluationVerificationIdV1(taskId, selector)) {
    invalid(`verification task ${index} id does not match its task and selector`);
  }
  return {calibration: parseCalibration(task.calibration, true), selector, taskId, verificationId};
}

function parseCalibration(value: unknown, verifyHash: boolean): MatchedEvaluationVerificationCalibrationV1 {
  const calibration = object(value, 'verification calibration');
  exactKeys(calibration, [
    'baseExitCode',
    'baseDiagnosticHash',
    'baseRepositoryFixtureHash',
    'baseRevision',
    'fixExitCode',
    'fixDiagnosticHash',
    'fixRepositoryFixtureHash',
    'fixRevision',
    'receiptHash',
  ]);
  if (calibration.baseExitCode !== 1 || calibration.fixExitCode !== 0) {
    invalid('verification calibration must fail at base and pass at the known fix');
  }
  const withoutHash = {
    baseDiagnosticHash: matching(calibration.baseDiagnosticHash, HASH, 'verification base diagnostic hash'),
    baseExitCode: 1 as const,
    baseRepositoryFixtureHash: matching(
      calibration.baseRepositoryFixtureHash,
      HASH,
      'verification base repository fixture hash',
    ),
    baseRevision: matching(calibration.baseRevision, REVISION, 'verification base revision'),
    fixDiagnosticHash: matching(calibration.fixDiagnosticHash, HASH, 'verification fix diagnostic hash'),
    fixExitCode: 0 as const,
    fixRepositoryFixtureHash: matching(
      calibration.fixRepositoryFixtureHash,
      HASH,
      'verification fix repository fixture hash',
    ),
    fixRevision: matching(calibration.fixRevision, REVISION, 'verification fix revision'),
  };
  const receiptHash = matching(calibration.receiptHash, HASH, 'verification calibration receipt hash');
  if (verifyHash && receiptHash !== matchedEvaluationVerificationCalibrationHashV1(withoutHash)) {
    invalid('verification calibration receipt hash does not match its contents');
  }
  return {...withoutHash, receiptHash};
}

function parseReceipt(value: unknown, verifyHash: boolean): MatchedEvaluationVerificationReceiptV1 {
  const receipt = object(value, 'verification receipt');
  exactKeys(receipt, [
    'artifactHash',
    'diagnosticHash',
    'durationMilliseconds',
    'environmentHash',
    'exitCode',
    'interpreterHash',
    'planHash',
    'receiptHash',
    'runnerHash',
    'sandboxExecutableHash',
    'status',
    'taskId',
    'verificationId',
    'version',
  ]);
  if (receipt.version !== MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION) {
    invalid('verification receipt version must be 1');
  }
  const status = literal(receipt.status, MATCHED_EVALUATION_VERIFICATION_STATUSES, 'verification receipt status');
  const exitCode: 0 | 1 =
    receipt.exitCode === 0 ? 0 : receipt.exitCode === 1 ? 1 : invalid('verification exit code is invalid');
  if ((status === 'passed') !== (exitCode === 0)) invalid('verification status and exit code disagree');
  const withoutHash = {
    artifactHash: matching(receipt.artifactHash, HASH, 'verification artifact hash'),
    diagnosticHash: matching(receipt.diagnosticHash, HASH, 'verification diagnostic hash'),
    durationMilliseconds: integer(receipt.durationMilliseconds, 0, 600_000, 'verification duration'),
    environmentHash: matching(receipt.environmentHash, HASH, 'verification environment hash'),
    exitCode,
    interpreterHash: matching(receipt.interpreterHash, HASH, 'verification interpreter hash'),
    planHash: matching(receipt.planHash, HASH, 'verification plan hash'),
    runnerHash: matching(receipt.runnerHash, HASH, 'verification runner hash'),
    sandboxExecutableHash: matching(receipt.sandboxExecutableHash, HASH, 'verification sandbox executable hash'),
    status,
    taskId: matching(receipt.taskId, TASK_ID, 'verification receipt task id'),
    verificationId: matching(receipt.verificationId, HASH, 'verification receipt verification id'),
    version: MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION,
  };
  const receiptHash = matching(receipt.receiptHash, HASH, 'verification receipt hash');
  if (verifyHash && receiptHash !== matchedEvaluationVerificationReceiptHashV1(withoutHash)) {
    invalid('verification receipt hash does not match its contents');
  }
  return {...withoutHash, receiptHash};
}

function parseContinuationPlan(value: unknown, verifyHash: boolean): MatchedContinuationPhaseTwoVerificationPlanV1 {
  const plan = object(value, 'continuation verification plan');
  exactKeys(plan, ['checks', 'planHash', 'protectedPaths', 'taskId', 'version']);
  if (plan.version !== MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION) {
    invalid('continuation verification plan version must be 1');
  }
  const taskId = matching(plan.taskId, TASK_ID, 'continuation verification task id');
  const checks = array(plan.checks, 'continuation verification checks')
    .map((check, index) => parseContinuationCheck(check, true, `continuation verification check ${index}`))
    .sort((left, right) => left.checkId.localeCompare(right.checkId));
  if (checks.length === 0 || checks.length > 8) {
    invalid('continuation verification plan must contain 1-8 checks');
  }
  unique(
    checks.map(check => check.checkId),
    'continuation verification check ids',
  );
  for (const check of checks) {
    if (check.checkId !== matchedContinuationPhaseTwoVerificationCheckIdV1(taskId, check)) {
      invalid('continuation verification check id does not match its contents');
    }
  }
  const withoutHash = {
    checks,
    protectedPaths: canonicalRepositoryPaths(
      array(plan.protectedPaths, 'continuation verification protected paths').map((entry, index) =>
        boundedText(entry, 1, 4_096, `continuation verification protected path ${index}`),
      ),
      'continuation verification protected paths',
    ),
    taskId,
    version: MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION,
  };
  const planHash = matching(plan.planHash, HASH, 'continuation verification plan hash');
  if (verifyHash && planHash !== matchedContinuationPhaseTwoVerificationPlanHashV1(withoutHash)) {
    invalid('continuation verification plan hash does not match its contents');
  }
  return {...withoutHash, planHash};
}

function parseContinuationCheck(
  value: unknown,
  verifyShape: boolean,
  label = 'continuation verification check',
): MatchedContinuationPhaseTwoVerificationCheckV1 {
  const check = object(value, label);
  exactKeys(check, ['allowedBaselineFailureIds', 'checkId', 'commandTokens', 'diagnosticParser', 'policy']);
  const policy = literal(check.policy, MATCHED_CONTINUATION_PHASE_TWO_CHECK_POLICIES, `${label} policy`);
  const allowedBaselineFailureIds = canonicalFailureIds(
    array(check.allowedBaselineFailureIds, `${label} allowed baseline failures`).map((entry, index) =>
      boundedText(entry, 1, 1_024, `${label} allowed baseline failure ${index}`),
    ),
    `${label} allowed baseline failures`,
  );
  if (policy === 'must-pass' && allowedBaselineFailureIds.length !== 0) {
    invalid(`${label} must-pass policy cannot allow baseline failures`);
  }
  const commandTokens = array(check.commandTokens, `${label} command tokens`).map((entry, index) =>
    boundedText(entry, 1, 4_096, `${label} command token ${index}`),
  );
  if (commandTokens.length === 0 || commandTokens.length > 64) {
    invalid(`${label} must contain 1-64 command tokens`);
  }
  if (commandTokens.some(token => token.includes('\0'))) invalid(`${label} command tokens cannot contain null bytes`);
  const parsed = {
    allowedBaselineFailureIds,
    checkId: matching(check.checkId, HASH, `${label} id`),
    commandTokens,
    diagnosticParser: literal(
      check.diagnosticParser,
      MATCHED_CONTINUATION_PHASE_TWO_DIAGNOSTIC_PARSERS,
      `${label} diagnostic parser`,
    ),
    policy,
  };
  if (verifyShape && parsed.checkId === '0'.repeat(64)) invalid(`${label} id is not sealed`);
  return parsed;
}

function parseContinuationCheckReceipt(
  value: unknown,
  verifyHash: boolean,
): MatchedContinuationPhaseTwoVerificationCheckReceiptV1 {
  const receipt = object(value, 'continuation verification check receipt');
  exactKeys(receipt, [
    'artifactHash',
    'checkId',
    'diagnosticHash',
    'durationMilliseconds',
    'exitCode',
    'failureIds',
    'planHash',
    'receiptHash',
    'status',
    'version',
  ]);
  if (receipt.version !== MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION) {
    invalid('continuation verification check receipt version must be 1');
  }
  const withoutHash = {
    artifactHash: matching(receipt.artifactHash, HASH, 'continuation verification check artifact hash'),
    checkId: matching(receipt.checkId, HASH, 'continuation verification check id'),
    diagnosticHash: matching(receipt.diagnosticHash, HASH, 'continuation verification check diagnostic hash'),
    durationMilliseconds: integer(
      receipt.durationMilliseconds,
      0,
      3_600_000,
      'continuation verification check duration',
    ),
    exitCode:
      receipt.exitCode === 0
        ? (0 as const)
        : receipt.exitCode === 1
          ? (1 as const)
          : invalid('continuation verification check exit code is invalid'),
    failureIds: canonicalFailureIds(
      array(receipt.failureIds, 'continuation verification check failures').map((entry, index) =>
        boundedText(entry, 1, 1_024, `continuation verification check failure ${index}`),
      ),
      'continuation verification check failures',
    ),
    planHash: matching(receipt.planHash, HASH, 'continuation verification check plan hash'),
    status: literal(receipt.status, MATCHED_EVALUATION_VERIFICATION_STATUSES, 'continuation verification check status'),
    version: MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION,
  };
  const receiptHash = matching(receipt.receiptHash, HASH, 'continuation verification check receipt hash');
  if (verifyHash && receiptHash !== matchedContinuationPhaseTwoVerificationCheckReceiptHashV1(withoutHash)) {
    invalid('continuation verification check receipt hash does not match its contents');
  }
  return {...withoutHash, receiptHash};
}

function parseContinuationAggregateReceipt(
  value: unknown,
  verifyHash: boolean,
): MatchedContinuationPhaseTwoVerificationReceiptV1 {
  const receipt = object(value, 'continuation verification aggregate receipt');
  exactKeys(receipt, [
    'artifactHash',
    'checks',
    'durationMilliseconds',
    'planHash',
    'protectedPathViolations',
    'receiptHash',
    'status',
    'taskId',
    'version',
  ]);
  if (receipt.version !== MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION) {
    invalid('continuation verification aggregate receipt version must be 1');
  }
  const checks = array(receipt.checks, 'continuation verification aggregate checks')
    .map(parseMatchedContinuationPhaseTwoVerificationCheckReceiptV1)
    .sort((left, right) => left.checkId.localeCompare(right.checkId));
  if (checks.length === 0 || checks.length > 8) {
    invalid('continuation verification aggregate must contain 1-8 checks');
  }
  unique(
    checks.map(check => check.checkId),
    'continuation verification aggregate check ids',
  );
  const durationMilliseconds = integer(
    receipt.durationMilliseconds,
    0,
    8 * 3_600_000,
    'continuation verification aggregate duration',
  );
  if (durationMilliseconds < checks.reduce((sum, check) => sum + check.durationMilliseconds, 0)) {
    invalid('continuation verification aggregate duration is shorter than its checks');
  }
  const status = literal(
    receipt.status,
    MATCHED_EVALUATION_VERIFICATION_STATUSES,
    'continuation verification aggregate status',
  );
  const protectedPathViolations = canonicalRepositoryPaths(
    array(receipt.protectedPathViolations, 'continuation verification protected path violations').map((entry, index) =>
      boundedText(entry, 1, 4_096, `continuation verification protected path violation ${index}`),
    ),
    'continuation verification protected path violations',
    true,
  );
  if (
    (status === 'passed') !==
    (protectedPathViolations.length === 0 && checks.every(check => check.status === 'passed'))
  ) {
    invalid('continuation verification aggregate status differs from its checks');
  }
  const withoutHash = {
    artifactHash: matching(receipt.artifactHash, HASH, 'continuation verification aggregate artifact hash'),
    checks,
    durationMilliseconds,
    planHash: matching(receipt.planHash, HASH, 'continuation verification aggregate plan hash'),
    protectedPathViolations,
    status,
    taskId: matching(receipt.taskId, TASK_ID, 'continuation verification aggregate task id'),
    version: MATCHED_CONTINUATION_PHASE_TWO_VERIFICATION_VERSION,
  };
  const receiptHash = matching(receipt.receiptHash, HASH, 'continuation verification aggregate receipt hash');
  if (verifyHash && receiptHash !== matchedContinuationPhaseTwoVerificationReceiptHashV1(withoutHash)) {
    invalid('continuation verification aggregate receipt hash does not match its contents');
  }
  return {...withoutHash, receiptHash};
}

function assertContinuationReceiptCoverage(
  plan: MatchedContinuationPhaseTwoVerificationPlanV1,
  receipts: readonly MatchedContinuationPhaseTwoVerificationCheckReceiptV1[],
  artifactHash: string,
): void {
  if (receipts.length !== plan.checks.length) invalid('continuation verification receipt coverage is incomplete');
  const receiptByCheck = new Map(receipts.map(receipt => [receipt.checkId, receipt]));
  if (receiptByCheck.size !== receipts.length) invalid('continuation verification receipt contains duplicate checks');
  for (const check of plan.checks) {
    const receipt = receiptByCheck.get(check.checkId);
    if (receipt === undefined) invalid('continuation verification receipt coverage differs from its sealed plan');
    if (receipt.artifactHash !== artifactHash || receipt.planHash !== plan.planHash) {
      invalid('continuation verification check receipt identity differs from its plan or artifact');
    }
    const expectedStatus = continuationCheckPassed(check, receipt.exitCode, receipt.failureIds)
      ? 'passed'
      : 'task-failed';
    if (receipt.status !== expectedStatus) {
      invalid('continuation verification check status differs from its sealed policy');
    }
  }
}

function continuationCheckPassed(
  check: MatchedContinuationPhaseTwoVerificationCheckV1,
  exitCode: 0 | 1,
  failureIds: readonly string[],
): boolean {
  if (check.policy === 'must-pass') return exitCode === 0 && failureIds.length === 0;
  if (exitCode === 0) return failureIds.length === 0;
  return failureIds.length > 0 && failureIds.every(failure => check.allowedBaselineFailureIds.includes(failure));
}

function canonicalFailureIds(values: readonly string[], label: string): readonly string[] {
  const canonical = values.map(value => boundedText(value, 1, 1_024, label)).sort();
  unique(canonical, label);
  if (canonical.length > 256) invalid(`${label} must contain at most 256 entries`);
  return canonical;
}

function canonicalRepositoryPaths(values: readonly string[], label: string, allowEmpty = false): readonly string[] {
  const canonical = values.map(value => boundedText(value, 1, 4_096, label)).sort();
  unique(canonical, label);
  if (
    (!allowEmpty && canonical.length === 0) ||
    canonical.length > 64 ||
    canonical.some(path => path.startsWith('/') || path.startsWith('.') || path.split('/').some(part => part === '..'))
  ) {
    invalid(`${label} must contain 1-64 safe repository-relative paths`);
  }
  return canonical;
}

function digest(domain: string, value: unknown): string {
  return sha256HexSync(`${domain}\0${JSON.stringify(value)}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    invalid('verification object has unsupported or missing fields');
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  const text = boundedText(value, 1, 4_096, label);
  if (!pattern.test(text)) invalid(`${label} is invalid`);
  return text;
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) invalid(`${label} is invalid`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = boundedText(value, 1, 4_096, label);
  if (!path.startsWith('/')) invalid(`${label} must be absolute`);
  return path;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    invalid(`${label} is invalid`);
  return Number(value);
}

function literal<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (!values.includes(value as T[number])) invalid(`${label} is invalid`);
  return value as T[number];
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function invalid(message: string): never {
  throw new Error(`Invalid matched evaluation verification: ${message}.`);
}
