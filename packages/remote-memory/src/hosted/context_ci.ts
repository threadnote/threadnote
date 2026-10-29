import {Array as EffectArray} from 'effect';
import {constantTimeHexEqual} from '@threadnote/platform/hmac';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseContextCheckReportJson, projectContextCheckReportSarif} from '@threadnote/context/check';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface HostedContextCiPolicyV1 {
  readonly version: 1;
  readonly digest: string;
  readonly tenantId: string;
  readonly shareId: string;
  readonly project: string;
  readonly source: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly refs: readonly string[];
  readonly baseRefs: readonly string[];
  readonly readerIdentity: string;
  readonly publisherIdentity: string;
  readonly queueLimit: number;
  readonly requestsPerMinute: number;
  readonly maxAttempts: number;
}

export interface HostedContextCiEventV1 {
  readonly version: 1;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly headRepositoryId: string;
  readonly ref: string;
  readonly baseRef: string;
  readonly headCommit: string;
  readonly baseCommit: string;
  readonly kind: 'push' | 'pull_request' | 'rerun';
  readonly trusted: true;
}

export interface HostedContextCiWebhookV1 {
  readonly source: string;
  readonly deliveryId: string;
  readonly timestamp: string;
  readonly body: string;
  readonly signature: string;
}

export interface HostedContextCiJobV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly inputDigest: string;
  readonly policyDigest: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly event: HostedContextCiEventV1;
}

export function buildHostedContextCiPolicyV1(
  input: Omit<HostedContextCiPolicyV1, 'version' | 'digest'>,
): HostedContextCiPolicyV1 {
  const value = {
    version: 1 as const,
    tenantId: ciIdentifier(input.tenantId),
    shareId: ciIdentifier(input.shareId),
    project: validatePortableSegment(input.project),
    source: ciIdentifier(input.source),
    installationId: ciIdentifier(input.installationId),
    repositoryId: ciIdentifier(input.repositoryId),
    refs: refs(input.refs),
    baseRefs: refs(input.baseRefs),
    readerIdentity: ciIdentifier(input.readerIdentity),
    publisherIdentity: ciIdentifier(input.publisherIdentity),
    queueLimit: ciInteger(input.queueLimit, 1, 10_000),
    requestsPerMinute: ciInteger(input.requestsPerMinute, 1, 1_000),
    maxAttempts: ciInteger(input.maxAttempts, 1, 10),
  };
  if (value.readerIdentity === value.publisherIdentity) throw new Error('Context CI identities must be separate.');
  return {...value, digest: sha256HexSync(canonicalJson(value))};
}

export function parseHostedContextCiPolicyV1(input: HostedContextCiPolicyV1): HostedContextCiPolicyV1 {
  const policy = buildHostedContextCiPolicyV1(input);
  if (input.version !== 1 || input.digest !== policy.digest) throw new Error('Context CI policy digest mismatch.');
  return policy;
}

/** The configured gateway authenticates native provider webhooks, then signs this normalized envelope. */
export function admitHostedContextCiWebhookV1(
  inputPolicy: HostedContextCiPolicyV1,
  envelope: HostedContextCiWebhookV1,
  key: string,
  now: number,
): HostedContextCiJobV1 {
  const policy = parseHostedContextCiPolicyV1(inputPolicy);
  ciInteger(now, 0, Number.MAX_SAFE_INTEGER);
  ciIdentifier(envelope.deliveryId);
  if (
    envelope.source !== policy.source ||
    typeof envelope.body !== 'string' ||
    Buffer.byteLength(envelope.body) > 16_384 ||
    typeof key !== 'string' ||
    Buffer.byteLength(key) < 32 ||
    !/^[0-9]{13}$/u.test(envelope.timestamp) ||
    Math.abs(now - Number(envelope.timestamp)) > 300_000 ||
    !/^[a-f0-9]{64}$/u.test(envelope.signature)
  )
    throw new Error('Context CI webhook rejected.');
  const expected = new Bun.CryptoHasher('sha256', key)
    .update(JSON.stringify([envelope.source, envelope.deliveryId, envelope.timestamp, envelope.body]))
    .digest('hex');
  if (!constantTimeHexEqual(expected, envelope.signature)) throw new Error('Context CI webhook rejected.');
  const value: unknown = JSON.parse(envelope.body);
  if (!isHostedContextCiEvent(value)) throw new Error('Context CI event rejected.');
  const event = value;
  validateEvent(policy, event);
  // Delivery IDs and event kind cannot create duplicate checks for the same immutable comparison.
  const binding = {
    tenantId: policy.tenantId,
    policyDigest: policy.digest,
    installationId: event.installationId,
    repositoryId: event.repositoryId,
    ref: event.ref,
    baseRef: event.baseRef,
    headCommit: event.headCommit,
    baseCommit: event.baseCommit,
  };
  const inputDigest = sha256HexSync(canonicalJson(binding));
  return {
    version: 1,
    jobId: `tnci_${inputDigest}`,
    inputDigest,
    policyDigest: policy.digest,
    tenantId: policy.tenantId,
    repositoryId: policy.repositoryId,
    event,
  };
}

export function validateHostedContextCiJobV1(policy: HostedContextCiPolicyV1, job: HostedContextCiJobV1): void {
  parseHostedContextCiPolicyV1(policy);
  validateEvent(policy, job.event);
  const inputDigest = sha256HexSync(
    canonicalJson({
      tenantId: policy.tenantId,
      policyDigest: policy.digest,
      installationId: job.event.installationId,
      repositoryId: job.event.repositoryId,
      ref: job.event.ref,
      baseRef: job.event.baseRef,
      headCommit: job.event.headCommit,
      baseCommit: job.event.baseCommit,
    }),
  );
  if (
    job.version !== 1 ||
    job.inputDigest !== inputDigest ||
    job.jobId !== `tnci_${inputDigest}` ||
    job.policyDigest !== policy.digest ||
    job.tenantId !== policy.tenantId ||
    job.repositoryId !== policy.repositoryId
  ) {
    throw new Error('Context CI job binding mismatch.');
  }
}

export function hostedContextCiDiagnosticsV1(json: string) {
  if (typeof json !== 'string' || Buffer.byteLength(json) > 262_144) throw new Error('Context CI report is too large.');
  const parsed = parseContextCheckReportJson(json);
  const report = {...parsed, project: 'hosted-context-ci'};
  if (report.omittedFindings > 1_000_000) throw new Error('Context CI report count is invalid.');
  const sarif = projectContextCheckReportSarif(report);
  return {version: 1 as const, report, sarif, digest: sha256HexSync(canonicalJson({report, sarif}))};
}

export function hostedContextCiBackoffMilliseconds(attempt: number): number {
  return Math.min(3_600_000, 30_000 * 2 ** (ciInteger(attempt, 1, 10) - 1));
}

export function ciIdentifier(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new Error('Context CI identifier is invalid.');
  }
  return value;
}

export function ciInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Context CI bound is invalid.');
  return value;
}

function refs(values: readonly string[]): string[] {
  if (!EffectArray.isArray(values) || values.length < 1 || values.length > 100)
    throw new Error('Context CI refs are invalid.');
  return [
    ...new Set(
      EffectArray.map(values, value => {
        if (
          typeof value !== 'string' ||
          value.length > 256 ||
          !/^refs\/heads\/[A-Za-z0-9_./-]+$/u.test(value) ||
          Effect.pipe(value, EffectString.includes('..')) ||
          Effect.pipe(value, EffectString.includes('//')) ||
          Effect.pipe(value, EffectString.endsWith('/')) ||
          Effect.pipe(value, EffectString.endsWith('.lock'))
        ) {
          throw new Error('Context CI ref is invalid.');
        }
        return value;
      }),
    ),
  ].sort();
}

function isHostedContextCiEvent(value: unknown): value is HostedContextCiEventV1 {
  if (!isRecord(value)) return false;
  const keys = EffectRecord.keys(value);
  return (
    keys.length === 10 &&
    EffectArray.every(keys, key =>
      [
        'version',
        'installationId',
        'repositoryId',
        'headRepositoryId',
        'ref',
        'baseRef',
        'headCommit',
        'baseCommit',
        'kind',
        'trusted',
      ].includes(key),
    ) &&
    value.version === 1 &&
    typeof value.installationId === 'string' &&
    typeof value.repositoryId === 'string' &&
    typeof value.headRepositoryId === 'string' &&
    typeof value.ref === 'string' &&
    typeof value.baseRef === 'string' &&
    typeof value.headCommit === 'string' &&
    typeof value.baseCommit === 'string' &&
    (value.kind === 'push' || value.kind === 'pull_request' || value.kind === 'rerun') &&
    value.trusted === true
  );
}

function validateEvent(policy: HostedContextCiPolicyV1, event: HostedContextCiEventV1): void {
  if (
    !event ||
    event.version !== 1 ||
    event.trusted !== true ||
    !['push', 'pull_request', 'rerun'].includes(event.kind) ||
    event.installationId !== policy.installationId ||
    event.repositoryId !== policy.repositoryId ||
    event.headRepositoryId !== policy.repositoryId ||
    !policy.refs.includes(event.ref) ||
    !policy.baseRefs.includes(event.baseRef) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(event.headCommit) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(event.baseCommit)
  )
    throw new Error('Context CI event rejected.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
