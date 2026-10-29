import {
  isSafeInteger as checkedIsSafeInteger,
  isFiniteNumber as checkedIsFiniteNumber,
} from '@threadnote/platform/validation';
import {Array as EffectArray} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  buildContextHealthSchedulePlanV1,
  canonicalContextHealthProjectV1,
  type ContextHealthAggregateV1,
} from '@threadnote/context/health_schedule';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const HOSTED_CONTEXT_HEALTH_VERSION = 1 as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CLAIM_TOKEN = /^[0-9a-f]{32}$/u;
const EVALUATION_AUDIENCE = 'threadnote-hosted-context-health-v1' as const;
const MAXIMUM_COUNT = 1_000_000_000;
const MAXIMUM_CONCURRENCY = 64;
const HOSTED_CONTEXT_HEALTH_SIGNAL_COUNT_KEYS = [
  'citationChanged',
  'citationCurrent',
  'citationMissing',
  'citationUnknown',
  'failedChecks',
  'policyDrift',
  'staleHandoffs',
  'unindexedScope',
] as const;
const HOSTED_CONTEXT_HEALTH_SIGNAL_COUNT_KEY_SET = new Set<string>(HOSTED_CONTEXT_HEALTH_SIGNAL_COUNT_KEYS);

export const HOSTED_CONTEXT_HEALTH_ALERT_KINDS = [
  'backlog',
  'failed-checks',
  'persistent-stale-evidence',
  'scheduler-lag',
  'worker-heartbeat',
] as const;

export type HostedContextHealthAlertKindV1 = (typeof HOSTED_CONTEXT_HEALTH_ALERT_KINDS)[number];

export interface HostedContextHealthPolicyV1 {
  readonly backlogAlertCount: number;
  readonly digest: string;
  readonly persistentStaleRuns: number;
  readonly policyVersion: string;
  readonly schedulerLagMinutes: number;
  readonly supportOwner: string;
  readonly version: typeof HOSTED_CONTEXT_HEALTH_VERSION;
  readonly workerHeartbeatMinutes: number;
}

export interface HostedContextHealthScheduleV1 {
  readonly cadenceMinutes: number;
  readonly execution: {
    readonly memoryMutation: 'forbidden';
    readonly repositorySnapshot: 'immutable';
  };
  readonly policy: HostedContextHealthPolicyV1;
  readonly project: string;
  readonly scheduleId: string;
  readonly shareId: string;
  readonly tenantId: string;
  readonly version: typeof HOSTED_CONTEXT_HEALTH_VERSION;
}

export interface HostedContextHealthScheduleReceiptV1 {
  readonly cadenceMinutes: number;
  readonly labels: HostedContextHealthTargetLabelsV1;
  readonly nextDueAt: string;
  readonly policyDigest: string;
  readonly scheduleId: string;
  readonly status: 'active' | 'paused';
  readonly version: typeof HOSTED_CONTEXT_HEALTH_VERSION;
}

export interface HostedContextHealthSignalCountsV1 {
  readonly citationChanged: number;
  readonly citationCurrent: number;
  readonly citationMissing: number;
  readonly citationUnknown: number;
  readonly failedChecks: number;
  readonly policyDrift: number;
  readonly staleHandoffs: number;
  readonly unindexedScope: number;
}

export interface HostedContextHealthRunInputV1 {
  readonly aggregate: ContextHealthAggregateV1;
  readonly backlogDepth: number;
  readonly dueAt: string;
  readonly evaluationAttestation: HostedContextHealthEvaluationAttestationV1;
  readonly memorySnapshotRevision: string;
  readonly observedAt: string;
  readonly priorConsecutiveStaleRuns: number;
  readonly repositoryCommit: string;
  readonly schedule: HostedContextHealthScheduleV1;
  readonly signals: HostedContextHealthSignalCountsV1;
  readonly version: typeof HOSTED_CONTEXT_HEALTH_VERSION;
  readonly workerHeartbeatAt?: string;
}

export interface HostedContextHealthEvaluationAttestationV1 {
  readonly audience: typeof EVALUATION_AUDIENCE;
  readonly claimGeneration: number;
  readonly claimToken: string;
  readonly signature: string;
  readonly version: typeof HOSTED_CONTEXT_HEALTH_VERSION;
}

export type HostedContextHealthUnsignedRunInputV1 = Omit<HostedContextHealthRunInputV1, 'evaluationAttestation'>;

export interface HostedContextHealthAlertV1 {
  readonly evidenceCount: number;
  readonly kind: HostedContextHealthAlertKindV1;
  readonly rollback: string;
  readonly safeFirstAction: string;
  readonly state: 'clear' | 'firing';
  readonly supportOwner: string;
}

export interface HostedContextHealthReceiptV1 {
  readonly aggregateId: string;
  readonly alerts: readonly HostedContextHealthAlertV1[];
  readonly consecutiveStaleRuns: number;
  readonly counts: HostedContextHealthSignalCountsV1;
  readonly evidence: {
    readonly memorySnapshotRevision: string;
    readonly policyDigest: string;
    readonly repositorySnapshotDigest: string;
  };
  readonly inputDigest: string;
  readonly labels: {readonly project: string; readonly share: string; readonly tenant: string};
  readonly memoryMutation: 'none';
  readonly observedAt: string;
  readonly outcome: 'clean' | 'findings' | 'unknown';
  readonly receiptId: string;
  readonly reviewRequired: boolean;
  readonly scheduleId: string;
  readonly version: typeof HOSTED_CONTEXT_HEALTH_VERSION;
}

export interface HostedContextHealthDueJobV1 {
  readonly dueAt: string;
  readonly scheduleId: string;
  readonly tenantId: string;
}

export interface HostedContextHealthSelectionV1 {
  readonly jobs: readonly HostedContextHealthDueJobV1[];
  readonly nextTenantOrdinal: number;
}

export interface HostedContextHealthTargetLabelsV1 {
  readonly project: string;
  readonly share: string;
  readonly tenant: string;
}

export function buildHostedContextHealthPolicyV1(
  input: Omit<HostedContextHealthPolicyV1, 'digest' | 'version'>,
): HostedContextHealthPolicyV1 {
  const unsigned = {
    backlogAlertCount: boundedInteger(input.backlogAlertCount, 1, MAXIMUM_COUNT, 'backlog alert count'),
    persistentStaleRuns: boundedInteger(input.persistentStaleRuns, 1, 100, 'persistent stale run count'),
    policyVersion: identifier(input.policyVersion, 'policy version'),
    schedulerLagMinutes: boundedInteger(input.schedulerLagMinutes, 1, 7 * 24 * 60, 'scheduler lag minutes'),
    supportOwner: identifier(input.supportOwner, 'support owner'),
    version: HOSTED_CONTEXT_HEALTH_VERSION,
    workerHeartbeatMinutes: boundedInteger(input.workerHeartbeatMinutes, 1, 24 * 60, 'worker heartbeat minutes'),
  } as const;
  return {...unsigned, digest: sha256HexSync(canonicalJson(unsigned))};
}

export function buildHostedContextHealthScheduleV1(input: {
  readonly cadenceMinutes: number;
  readonly policy: HostedContextHealthPolicyV1;
  readonly project: string;
  readonly shareId: string;
  readonly tenantId: string;
}): HostedContextHealthScheduleV1 {
  const tenantId = identifier(input.tenantId, 'tenant ID');
  const shareId = identifier(input.shareId, 'share ID');
  const project = canonicalContextHealthProjectV1(input.project);
  const policy = validatePolicy(input.policy);
  const localPlan = buildContextHealthSchedulePlanV1({cadenceMinutes: input.cadenceMinutes, project});
  const unsigned = {
    cadenceMinutes: localPlan.cadenceMinutes,
    execution: {memoryMutation: 'forbidden' as const, repositorySnapshot: 'immutable' as const},
    policy,
    project,
    shareId,
    tenantId,
    version: HOSTED_CONTEXT_HEALTH_VERSION,
  };
  return {
    ...unsigned,
    scheduleId: `tnhs_${Effect.pipe(sha256HexSync(canonicalJson(unsigned)), EffectString.slice(0, 32))}`,
  };
}

export function buildHostedContextHealthReceiptV1(input: HostedContextHealthRunInputV1): HostedContextHealthReceiptV1 {
  const signals = validateRunInput(input);
  const observedAt = canonicalTimestamp(input.observedAt, 'observed timestamp');
  const dueAt = canonicalTimestamp(input.dueAt, 'due timestamp');
  const heartbeatAt =
    input.workerHeartbeatAt === undefined
      ? undefined
      : canonicalTimestamp(input.workerHeartbeatAt, 'worker heartbeat timestamp');
  const staleCount = signals.citationChanged + signals.citationMissing + signals.staleHandoffs + signals.policyDrift;
  const consecutiveStaleRuns = staleCount === 0 ? 0 : input.priorConsecutiveStaleRuns + 1;
  const observedMilliseconds = Date.parse(observedAt);
  const schedulerLagMinutes = elapsedMinutes(Date.parse(dueAt), observedMilliseconds);
  const heartbeatLagMinutes =
    heartbeatAt === undefined
      ? Number.POSITIVE_INFINITY
      : elapsedMinutes(Date.parse(heartbeatAt), observedMilliseconds);
  const policy = input.schedule.policy;
  const alerts = EffectArray.map(HOSTED_CONTEXT_HEALTH_ALERT_KINDS, kind => {
    const evidenceCount = alertEvidenceCount(kind, {
      backlogDepth: input.backlogDepth,
      consecutiveStaleRuns,
      failedChecks: signals.failedChecks + (input.aggregate.status === 'unknown' ? 1 : 0),
      heartbeatLagMinutes,
      schedulerLagMinutes,
      staleCount,
    });
    return {
      evidenceCount,
      kind,
      ...alertGuidance(kind),
      state: alertFires(kind, evidenceCount, policy) ? ('firing' as const) : ('clear' as const),
      supportOwner: policy.supportOwner,
    };
  });
  const labels = hostedContextHealthTargetLabelsV1(input.schedule);
  const evidence = {
    memorySnapshotRevision: input.memorySnapshotRevision,
    policyDigest: policy.digest,
    repositorySnapshotDigest: sha256HexSync(`git:${input.repositoryCommit}`),
  };
  const counts = signals;
  const unsignedInput = {
    aggregateId: input.aggregate.aggregateId,
    backlogDepth: input.backlogDepth,
    dueAt,
    evidence,
    observedAt,
    priorConsecutiveStaleRuns: input.priorConsecutiveStaleRuns,
    scheduleId: input.schedule.scheduleId,
    signals: counts,
    workerHeartbeatAt: heartbeatAt ?? null,
  };
  const inputDigest = sha256HexSync(canonicalJson(unsignedInput));
  const outcome = contextHealthOutcome(input.aggregate.status, signals);
  const unsignedReceipt = {
    aggregateId: input.aggregate.aggregateId,
    alerts,
    consecutiveStaleRuns,
    counts,
    evidence,
    inputDigest,
    labels,
    memoryMutation: 'none' as const,
    observedAt,
    outcome,
    reviewRequired: outcome !== 'clean' || EffectArray.some(alerts, alert => alert.state === 'firing'),
    scheduleId: input.schedule.scheduleId,
    version: HOSTED_CONTEXT_HEALTH_VERSION,
  };
  return {
    ...unsignedReceipt,
    receiptId: `tnhr_${Effect.pipe(sha256HexSync(canonicalJson(unsignedReceipt)), EffectString.slice(0, 32))}`,
  };
}

/**
 * Select due work in tenant rounds. A persisted cursor rotates the first tenant,
 * so a small concurrency limit cannot repeatedly favor the same tenant.
 */
export function selectHostedContextHealthJobsV1(
  jobs: readonly HostedContextHealthDueJobV1[],
  input: {readonly concurrency: number; readonly tenantCursorOrdinal?: number},
): HostedContextHealthSelectionV1 {
  const concurrency = boundedInteger(input.concurrency, 1, MAXIMUM_CONCURRENCY, 'scheduler concurrency');
  const canonical = EffectArray.map(jobs, job => ({
    dueAt: canonicalTimestamp(job.dueAt, 'job due timestamp'),
    scheduleId: scheduleIdentifier(job.scheduleId),
    tenantId: identifier(job.tenantId, 'job tenant ID'),
  }));
  if (new Set(EffectArray.map(canonical, job => job.scheduleId)).size !== canonical.length) {
    fail('Hosted context health due work contains duplicate schedules.');
  }
  const queues = new Map<string, HostedContextHealthDueJobV1[]>();
  for (const job of canonical.sort(compareJob)) {
    const queue = queues.get(job.tenantId) ?? [];
    queue.push(job);
    queues.set(job.tenantId, queue);
  }
  const tenants = [...queues.keys()].sort(compareText);
  const start =
    tenants.length === 0
      ? 0
      : boundedInteger(input.tenantCursorOrdinal ?? 0, 0, MAXIMUM_COUNT, 'tenant cursor ordinal') % tenants.length;
  const rotated = [...tenants.slice(start), ...tenants.slice(0, start)];
  const selected: HostedContextHealthDueJobV1[] = [];
  while (selected.length < concurrency) {
    let progressed = false;
    for (const tenant of rotated) {
      const job = queues.get(tenant)?.shift();
      if (!job) continue;
      selected.push(job);
      progressed = true;
      if (selected.length === concurrency) break;
    }
    if (!progressed) break;
  }
  const lastTenant = selected.at(-1)?.tenantId;
  const nextTenantOrdinal =
    lastTenant === undefined || tenants.length === 0 ? 0 : (tenants.indexOf(lastTenant) + 1) % tenants.length;
  return {jobs: selected, nextTenantOrdinal};
}

export function hostedContextHealthBackoffMilliseconds(attempt: number): number {
  const canonicalAttempt = boundedInteger(attempt, 1, 31, 'retry attempt');
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** (canonicalAttempt - 1));
}

/**
 * Signs the exact content-free evaluation produced by the trusted evaluator.
 * The claim binding prevents a valid result from being replayed for another due
 * revision, and the audience prevents reuse by another protocol.
 */
export function signHostedContextHealthEvaluationV1(
  input: HostedContextHealthUnsignedRunInputV1,
  claim: {readonly claimGeneration: number; readonly claimToken: string},
  key: string,
): HostedContextHealthRunInputV1 {
  validateUnsignedRunInput(input);
  const attestation = evaluationAttestation(input, claim, key);
  return {...input, evaluationAttestation: attestation};
}

export function verifyHostedContextHealthEvaluationV1(input: HostedContextHealthRunInputV1, key: string): void {
  const attestation = validateEvaluationAttestation(input.evaluationAttestation);
  const expected = evaluationAttestation(input, attestation, key);
  if (!constantTimeEqual(attestation.signature, expected.signature)) {
    fail('Hosted context health evaluation attestation is invalid.');
  }
}

export function parseHostedContextHealthRunInputV1(value: unknown): HostedContextHealthRunInputV1 {
  if (!isRecord(value)) fail('Hosted context health input must be a JSON object.');
  if (!isHostedContextHealthRunInput(value)) fail('Hosted context health input has an invalid shape.');
  return {...value, signals: validateRunInput(value)};
}

function isHostedContextHealthRunInput(value: unknown): value is HostedContextHealthRunInputV1 {
  if (!isRecord(value)) return false;
  return (
    value.version === HOSTED_CONTEXT_HEALTH_VERSION &&
    typeof value.backlogDepth === 'number' &&
    typeof value.dueAt === 'string' &&
    isHostedContextHealthEvaluationAttestationShape(value.evaluationAttestation) &&
    typeof value.memorySnapshotRevision === 'string' &&
    typeof value.observedAt === 'string' &&
    typeof value.priorConsecutiveStaleRuns === 'number' &&
    typeof value.repositoryCommit === 'string' &&
    isHostedContextHealthScheduleShape(value.schedule) &&
    isHostedContextHealthSignalShape(value.signals) &&
    isContextHealthAggregateShape(value.aggregate) &&
    (value.workerHeartbeatAt === undefined || typeof value.workerHeartbeatAt === 'string')
  );
}

function isHostedContextHealthEvaluationAttestationShape(
  value: unknown,
): value is HostedContextHealthEvaluationAttestationV1 {
  return (
    isRecord(value) &&
    value.audience === EVALUATION_AUDIENCE &&
    typeof value.claimGeneration === 'number' &&
    typeof value.claimToken === 'string' &&
    typeof value.signature === 'string' &&
    value.version === HOSTED_CONTEXT_HEALTH_VERSION
  );
}

function isHostedContextHealthScheduleShape(value: unknown): value is HostedContextHealthScheduleV1 {
  return (
    isRecord(value) &&
    typeof value.cadenceMinutes === 'number' &&
    isRecord(value.execution) &&
    value.execution.memoryMutation === 'forbidden' &&
    value.execution.repositorySnapshot === 'immutable' &&
    isHostedContextHealthPolicy(value.policy) &&
    typeof value.project === 'string' &&
    typeof value.scheduleId === 'string' &&
    typeof value.shareId === 'string' &&
    typeof value.tenantId === 'string' &&
    value.version === HOSTED_CONTEXT_HEALTH_VERSION
  );
}

function isHostedContextHealthSignalShape(value: unknown): value is HostedContextHealthSignalCountsV1 {
  return (
    isRecord(value) &&
    typeof value.citationChanged === 'number' &&
    typeof value.citationCurrent === 'number' &&
    typeof value.citationMissing === 'number' &&
    typeof value.citationUnknown === 'number' &&
    typeof value.failedChecks === 'number' &&
    typeof value.policyDrift === 'number' &&
    typeof value.staleHandoffs === 'number' &&
    typeof value.unindexedScope === 'number'
  );
}

function isContextHealthAggregateShape(value: unknown): value is ContextHealthAggregateV1 {
  return (
    isRecord(value) &&
    typeof value.aggregateId === 'string' &&
    typeof value.completeSources === 'number' &&
    (value.exitCode === 0 || value.exitCode === 1 || value.exitCode === 2) &&
    EffectArray.isArray(value.findings) &&
    EffectArray.every(
      value.findings,
      finding => isRecord(finding) && typeof finding.findingId === 'string' && typeof finding.sourceKey === 'string',
    ) &&
    typeof value.knownFindings === 'number' &&
    typeof value.project === 'string' &&
    EffectArray.isArray(value.sources) &&
    EffectArray.every(value.sources, isContextHealthAggregateSourceShape) &&
    (value.status === 'clean' || value.status === 'findings' || value.status === 'unknown') &&
    typeof value.unknownSources === 'number' &&
    value.version === 1
  );
}

function isContextHealthAggregateSourceShape(value: unknown): value is ContextHealthAggregateV1['sources'][number] {
  if (!isRecord(value) || typeof value.sourceKey !== 'string') return false;
  if (value.state === 'complete') {
    return (
      typeof value.evidenceRevision === 'string' &&
      typeof value.findingCount === 'number' &&
      typeof value.recordsScanned === 'number'
    );
  }
  return (
    value.state === 'unknown' &&
    (value.evidenceRevision === undefined || typeof value.evidenceRevision === 'string') &&
    (value.findingCount === undefined || typeof value.findingCount === 'number') &&
    (value.recordsScanned === undefined || typeof value.recordsScanned === 'number') &&
    (value.reason === 'citation-evidence-unavailable' ||
      value.reason === 'configured-teams-invalid' ||
      value.reason === 'evidence-incomplete' ||
      value.reason === 'snapshot-dirty' ||
      value.reason === 'snapshot-missing' ||
      value.reason === 'snapshot-raced' ||
      value.reason === 'snapshot-unreadable' ||
      value.reason === 'team-not-configured')
  );
}

export function parseHostedContextHealthScheduleV1(value: unknown): HostedContextHealthScheduleV1 {
  if (!isRecord(value)) fail('Hosted context health schedule must be a JSON object.');
  const candidate = value;
  if (
    typeof candidate.cadenceMinutes !== 'number' ||
    typeof candidate.project !== 'string' ||
    typeof candidate.shareId !== 'string' ||
    typeof candidate.tenantId !== 'string' ||
    !isHostedContextHealthPolicy(candidate.policy)
  ) {
    fail('Hosted context health schedule is invalid.');
  }
  const rebuilt = buildHostedContextHealthScheduleV1({
    cadenceMinutes: candidate.cadenceMinutes,
    policy: candidate.policy,
    project: candidate.project,
    shareId: candidate.shareId,
    tenantId: candidate.tenantId,
  });
  if (rebuilt.scheduleId !== candidate.scheduleId) fail('Hosted context health schedule digest does not match.');
  return rebuilt;
}

export function hostedContextHealthTargetLabelsV1(
  schedule: Pick<HostedContextHealthScheduleV1, 'project' | 'shareId' | 'tenantId'>,
): HostedContextHealthTargetLabelsV1 {
  return {
    project: opaqueLabel('project', schedule.project),
    share: opaqueLabel('share', schedule.shareId),
    tenant: opaqueLabel('tenant', schedule.tenantId),
  };
}

function validateRunInput(input: HostedContextHealthRunInputV1): HostedContextHealthSignalCountsV1 {
  const signals = validateUnsignedRunInput(input);
  validateEvaluationAttestation(input.evaluationAttestation);
  return signals;
}

function validateUnsignedRunInput(input: HostedContextHealthUnsignedRunInputV1): HostedContextHealthSignalCountsV1 {
  if (!isRecord(input) || input.version !== HOSTED_CONTEXT_HEALTH_VERSION) fail('Unsupported hosted health input.');
  const schedule = buildHostedContextHealthScheduleV1(input.schedule);
  if (schedule.scheduleId !== input.schedule.scheduleId) fail('Hosted context health schedule digest does not match.');
  if (!GIT_COMMIT.test(input.repositoryCommit)) fail('Hosted context health requires an immutable Git commit.');
  if (!SHA256.test(input.memorySnapshotRevision)) fail('Hosted context health memory revision must be SHA-256.');
  canonicalTimestamp(input.observedAt, 'observed timestamp');
  canonicalTimestamp(input.dueAt, 'due timestamp');
  if (Date.parse(input.observedAt) < Date.parse(input.dueAt)) {
    fail('Hosted context health cannot evaluate a schedule before it is due.');
  }
  if (input.workerHeartbeatAt !== undefined) {
    canonicalTimestamp(input.workerHeartbeatAt, 'worker heartbeat timestamp');
    if (Date.parse(input.workerHeartbeatAt) > Date.parse(input.observedAt)) {
      fail('Hosted context health worker heartbeat cannot be later than the observation.');
    }
  }
  boundedInteger(input.backlogDepth, 0, MAXIMUM_COUNT, 'backlog depth');
  boundedInteger(input.priorConsecutiveStaleRuns, 0, MAXIMUM_COUNT, 'prior stale run count');
  validateAggregate(input.aggregate, schedule.project);
  return validateSignals(input.signals);
}

function validateEvaluationAttestation(value: unknown): HostedContextHealthEvaluationAttestationV1 {
  if (!isRecord(value)) fail('Hosted context health evaluation attestation is required.');
  const keys = EffectRecord.keys(value);
  if (
    keys.length !== 5 ||
    EffectArray.some(
      keys,
      key => !['audience', 'claimGeneration', 'claimToken', 'signature', 'version'].includes(key),
    ) ||
    value.audience !== EVALUATION_AUDIENCE ||
    value.version !== HOSTED_CONTEXT_HEALTH_VERSION ||
    !checkedIsSafeInteger(value.claimGeneration) ||
    value.claimGeneration < 1 ||
    typeof value.claimToken !== 'string' ||
    !CLAIM_TOKEN.test(value.claimToken) ||
    typeof value.signature !== 'string' ||
    !SHA256.test(value.signature)
  ) {
    fail('Hosted context health evaluation attestation is invalid.');
  }
  return {
    audience: EVALUATION_AUDIENCE,
    claimGeneration: value.claimGeneration,
    claimToken: value.claimToken,
    signature: value.signature,
    version: HOSTED_CONTEXT_HEALTH_VERSION,
  };
}

function evaluationAttestation(
  input: HostedContextHealthUnsignedRunInputV1,
  claim: {readonly claimGeneration: number; readonly claimToken: string},
  key: string,
): HostedContextHealthEvaluationAttestationV1 {
  if (new TextEncoder().encode(key).length < 32) fail('Hosted context health evaluation key is too short.');
  const claimGeneration = boundedInteger(claim.claimGeneration, 1, MAXIMUM_COUNT, 'claim generation');
  const claimToken = typeof claim.claimToken === 'string' && CLAIM_TOKEN.test(claim.claimToken) ? claim.claimToken : '';
  if (!claimToken) fail('Hosted context health claim token is invalid.');
  const payload = {
    aggregate: input.aggregate,
    audience: EVALUATION_AUDIENCE,
    backlogDepth: input.backlogDepth,
    claimGeneration,
    claimToken,
    dueAt: input.dueAt,
    memorySnapshotRevision: input.memorySnapshotRevision,
    observedAt: input.observedAt,
    priorConsecutiveStaleRuns: input.priorConsecutiveStaleRuns,
    repositoryCommit: input.repositoryCommit,
    scheduleId: input.schedule.scheduleId,
    policyDigest: input.schedule.policy.digest,
    signals: input.signals,
    version: HOSTED_CONTEXT_HEALTH_VERSION,
    workerHeartbeatAt: input.workerHeartbeatAt ?? null,
  };
  return {
    audience: EVALUATION_AUDIENCE,
    claimGeneration,
    claimToken,
    signature: hmacSha256Hex(key, canonicalJson(payload)),
    version: HOSTED_CONTEXT_HEALTH_VERSION,
  };
}

function hmacSha256Hex(key: string, message: string): string {
  const encoder = new TextEncoder();
  const rawKeyBytes = encoder.encode(key);
  const keyBytes = rawKeyBytes.length > 64 ? hexBytes(sha256HexSync(rawKeyBytes)) : rawKeyBytes;
  const block = new Uint8Array(64);
  block.set(keyBytes);
  const innerPad = block.map(byte => byte ^ 0x36);
  const outerPad = block.map(byte => byte ^ 0x5c);
  const messageBytes = encoder.encode(message);
  const inner = new Uint8Array(innerPad.length + messageBytes.length);
  inner.set(innerPad);
  inner.set(messageBytes, innerPad.length);
  const innerDigest = hexBytes(sha256HexSync(inner));
  const outer = new Uint8Array(outerPad.length + innerDigest.length);
  outer.set(outerPad);
  outer.set(innerDigest, outerPad.length);
  return sha256HexSync(outer);
}

function hexBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(Effect.pipe(hex, EffectString.slice(index * 2, index * 2 + 2)), 16);
  }
  return result;
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |=
      (Effect.pipe(
        left,
        EffectString.charCodeAt(index),
        Effect.Option.getOrElse(() => NaN),
      ) || 0) ^
      (Effect.pipe(
        right,
        EffectString.charCodeAt(index),
        Effect.Option.getOrElse(() => NaN),
      ) || 0);
  }
  return difference === 0;
}

function isHostedContextHealthPolicy(value: unknown): value is HostedContextHealthPolicyV1 {
  return (
    isRecord(value) &&
    typeof value.backlogAlertCount === 'number' &&
    typeof value.digest === 'string' &&
    typeof value.persistentStaleRuns === 'number' &&
    typeof value.policyVersion === 'string' &&
    typeof value.schedulerLagMinutes === 'number' &&
    typeof value.supportOwner === 'string' &&
    value.version === HOSTED_CONTEXT_HEALTH_VERSION &&
    typeof value.workerHeartbeatMinutes === 'number'
  );
}

function validatePolicy(policy: HostedContextHealthPolicyV1): HostedContextHealthPolicyV1 {
  if (!isRecord(policy) || policy.version !== HOSTED_CONTEXT_HEALTH_VERSION) fail('Unsupported hosted health policy.');
  const rebuilt = buildHostedContextHealthPolicyV1(policy);
  if (rebuilt.digest !== policy.digest) fail('Hosted context health policy digest does not match.');
  return rebuilt;
}

function validateAggregate(aggregate: ContextHealthAggregateV1, project: string): void {
  if (!isRecord(aggregate) || aggregate.version !== 1 || aggregate.project !== project) {
    fail('Hosted context health aggregate does not match the scheduled project.');
  }
  if (!/^context-health-[0-9a-f]{40}$/u.test(aggregate.aggregateId)) {
    fail('Hosted context health aggregate identity is invalid.');
  }
  const {aggregateId: _aggregateId, ...unsigned} = aggregate;
  if (
    `context-health-${Effect.pipe(sha256HexSync(canonicalJson(unsigned)), EffectString.slice(0, 40))}` !==
    aggregate.aggregateId
  ) {
    fail('Hosted context health aggregate digest does not match its evidence.');
  }
  if (!['clean', 'findings', 'unknown'].includes(aggregate.status)) fail('Hosted context health status is invalid.');
  if (
    !EffectArray.isArray(aggregate.sources) ||
    aggregate.sources.length === 0 ||
    EffectArray.some(
      aggregate.sources,
      (source: ContextHealthAggregateV1['sources'][number]) =>
        !Effect.pipe(source.sourceKey, EffectString.startsWith('team:')),
    )
  ) {
    fail('Hosted context health accepts canonical shared-memory sources only.');
  }
}

function validateSignals(signals: unknown): HostedContextHealthSignalCountsV1 {
  if (!isRecord(signals)) fail('Hosted context health signal counts are invalid.');
  const enumerableKeys = EffectArray.filter(Reflect.ownKeys(signals), key =>
    Object.prototype.propertyIsEnumerable.call(signals, key),
  );
  if (
    enumerableKeys.length !== HOSTED_CONTEXT_HEALTH_SIGNAL_COUNT_KEYS.length ||
    EffectArray.some(
      enumerableKeys,
      key => typeof key !== 'string' || !HOSTED_CONTEXT_HEALTH_SIGNAL_COUNT_KEY_SET.has(key),
    )
  ) {
    fail('Hosted context health signal counts must contain exactly the canonical signals.');
  }
  return {
    citationChanged: boundedInteger(signals.citationChanged, 0, MAXIMUM_COUNT, 'signal citationChanged'),
    citationCurrent: boundedInteger(signals.citationCurrent, 0, MAXIMUM_COUNT, 'signal citationCurrent'),
    citationMissing: boundedInteger(signals.citationMissing, 0, MAXIMUM_COUNT, 'signal citationMissing'),
    citationUnknown: boundedInteger(signals.citationUnknown, 0, MAXIMUM_COUNT, 'signal citationUnknown'),
    failedChecks: boundedInteger(signals.failedChecks, 0, MAXIMUM_COUNT, 'signal failedChecks'),
    policyDrift: boundedInteger(signals.policyDrift, 0, MAXIMUM_COUNT, 'signal policyDrift'),
    staleHandoffs: boundedInteger(signals.staleHandoffs, 0, MAXIMUM_COUNT, 'signal staleHandoffs'),
    unindexedScope: boundedInteger(signals.unindexedScope, 0, MAXIMUM_COUNT, 'signal unindexedScope'),
  };
}

function contextHealthOutcome(
  aggregateOutcome: HostedContextHealthReceiptV1['outcome'],
  signals: HostedContextHealthSignalCountsV1,
): HostedContextHealthReceiptV1['outcome'] {
  if (signals.citationUnknown > 0 || signals.failedChecks > 0 || signals.unindexedScope > 0) return 'unknown';
  if (
    aggregateOutcome === 'unknown' ||
    signals.citationChanged > 0 ||
    signals.citationMissing > 0 ||
    signals.policyDrift > 0 ||
    signals.staleHandoffs > 0
  ) {
    return aggregateOutcome === 'unknown' ? 'unknown' : 'findings';
  }
  return aggregateOutcome;
}

function alertEvidenceCount(
  kind: HostedContextHealthAlertKindV1,
  evidence: Readonly<{
    backlogDepth: number;
    consecutiveStaleRuns: number;
    failedChecks: number;
    heartbeatLagMinutes: number;
    schedulerLagMinutes: number;
    staleCount: number;
  }>,
): number {
  if (kind === 'backlog') return evidence.backlogDepth;
  if (kind === 'failed-checks') return evidence.failedChecks;
  if (kind === 'persistent-stale-evidence') return evidence.staleCount === 0 ? 0 : evidence.consecutiveStaleRuns;
  if (kind === 'scheduler-lag') return evidence.schedulerLagMinutes;
  return checkedIsFiniteNumber(evidence.heartbeatLagMinutes) ? evidence.heartbeatLagMinutes : MAXIMUM_COUNT;
}

function alertFires(kind: HostedContextHealthAlertKindV1, evidenceCount: number, policy: HostedContextHealthPolicyV1) {
  if (kind === 'backlog') return evidenceCount >= policy.backlogAlertCount;
  if (kind === 'failed-checks') return evidenceCount > 0;
  if (kind === 'persistent-stale-evidence') return evidenceCount >= policy.persistentStaleRuns;
  if (kind === 'scheduler-lag') return evidenceCount >= policy.schedulerLagMinutes;
  return evidenceCount >= policy.workerHeartbeatMinutes;
}

function alertGuidance(kind: HostedContextHealthAlertKindV1): {
  readonly rollback: string;
  readonly safeFirstAction: string;
} {
  if (kind === 'backlog')
    return {rollback: 'pause-schedule-intake', safeFirstAction: 'inspect-oldest-content-free-receipt'};
  if (kind === 'failed-checks')
    return {rollback: 'disable-hosted-health-retain-read-only-memory', safeFirstAction: 'verify-immutable-inputs'};
  if (kind === 'persistent-stale-evidence')
    return {rollback: 'restore-previous-health-policy', safeFirstAction: 'open-review-without-applying-repair'};
  if (kind === 'scheduler-lag') return {rollback: 'pause-schedule-intake', safeFirstAction: 'inspect-worker-capacity'};
  return {rollback: 'stop-health-worker-and-verify-last-receipt', safeFirstAction: 'restart-health-worker'};
}

function opaqueLabel(kind: 'project' | 'share' | 'tenant', value: string): string {
  return `${kind}-${Effect.pipe(sha256HexSync(`threadnote-hosted-health-v1\0${kind}\0${value}`), EffectString.slice(0, 20))}`;
}

function elapsedMinutes(earlier: number, later: number): number {
  return Math.max(0, Math.floor((later - earlier) / 60_000));
}

function compareJob(left: HostedContextHealthDueJobV1, right: HostedContextHealthDueJobV1): number {
  return (
    compareText(left.tenantId, right.tenantId) ||
    compareText(left.dueAt, right.dueAt) ||
    compareText(left.scheduleId, right.scheduleId)
  );
}

function scheduleIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^tnhs_[0-9a-f]{32}$/u.test(value)) fail('Invalid hosted health schedule ID.');
  return value;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 512 || !IDENTIFIER.test(value))
    fail(`Invalid hosted health ${name}.`);
  return value;
}

function canonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string') fail(`Invalid hosted health ${name}.`);
  const milliseconds = Date.parse(value);
  if (!checkedIsFiniteNumber(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(`Invalid hosted health ${name}.`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!checkedIsSafeInteger(value) || value < minimum || value > maximum) {
    fail(`Invalid hosted health ${name}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message: string): never {
  throw new Error(message);
}
