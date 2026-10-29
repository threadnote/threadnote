import {Array as EffectArray, Option as EffectOption} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  OPERATIONS_ALERTS,
  OPERATIONS_CHECKS,
  OPERATIONS_CHECK_SPECIFICATIONS,
  OperationsDraftSchema,
  OperationsManifestSchema,
  OperationsEvidenceSchema,
  OperationsReceiptSchema,
  OperationsOpaqueId,
  OperationsTimestamp,
  parseOperations,
  type OperationsCheck,
  type OperationsManifest,
  type OperationsEvidence,
  type OperationsReceipt,
} from './operations/contract.js';
import * as EffectRecord from 'effect/Record';

export function buildOperationsManifest(raw: unknown): OperationsManifest {
  const draft = parseOperations(OperationsDraftSchema, raw);
  requireValid(new Set([draft.deploymentId, ...EffectRecord.values(draft.owners)]).size === 4);
  requireValid(EffectArray.every(draft.alerts, alert => new Set(EffectRecord.values(alert.owners)).size === 3));
  requireValid(draft.backup.retentionSeconds >= draft.backup.scheduleSeconds + draft.backup.rtoSeconds);
  requireValid(draft.backup.retentionSeconds >= draft.backup.rpoSeconds);
  requireValid(new Set(EffectArray.map(draft.alerts, alert => alert.kind)).size === OPERATIONS_ALERTS.length);
  const normalized = {...draft, alerts: [...draft.alerts].sort((a, b) => (a.kind < b.kind ? -1 : 1))};
  return {...normalized, manifestDigest: digest(normalized)};
}

export function parseOperationsManifest(raw: unknown): OperationsManifest {
  const {manifestDigest, ...draft} = parseOperations(OperationsManifestSchema, raw);
  const manifest = buildOperationsManifest(draft);
  requireValid(manifestDigest === manifest.manifestDigest);
  return manifest;
}

export function operationsEvidenceTemplate(
  rawManifest: unknown,
  drillId: string,
  isolatedTargetId: string,
): OperationsEvidence {
  const manifest = parseOperationsManifest(rawManifest);
  parseOperations(OperationsOpaqueId, drillId);
  parseOperations(OperationsOpaqueId, isolatedTargetId);
  requireValid(isolatedTargetId !== manifest.deploymentId);
  return {
    version: 1,
    manifestDigest: manifest.manifestDigest,
    drillId,
    isolatedTargetId,
    checks: EffectArray.map(OPERATIONS_CHECKS, check => ({check, status: 'pending'})),
  };
}

export function verifyOperationsEvidence(
  rawManifest: unknown,
  rawEvidence: unknown,
  checkedAt: string,
): OperationsReceipt {
  const manifest = parseOperationsManifest(rawManifest);
  const evidence = parseEvidence(rawEvidence, manifest);
  parseOperations(OperationsTimestamp, checkedAt);
  const now = Date.parse(checkedAt);
  const plannedAt = Date.parse(manifest.plannedAt);
  const manifestFresh = now >= plannedAt && now - plannedAt <= manifest.maxEvidenceAgeSeconds * 1000;
  const checks = EffectArray.map(evidence.checks, entry => {
    if (!manifestFresh) return {check: entry.check, status: 'blocked' as const};
    if (entry.status === 'pending') return {check: entry.check, status: 'pending' as const};
    const time = Date.parse(entry.observedAt);
    const timely = time >= plannedAt && time <= now && now - time <= manifest.maxEvidenceAgeSeconds * 1000;
    const valid =
      timely &&
      EffectArray.every(EffectRecord.values(entry.facts), Boolean) &&
      metricsPass(entry, manifest) &&
      orderPass(entry, evidence);
    return {check: entry.check, status: valid ? ('verified' as const) : ('blocked' as const)};
  });
  const status: OperationsReceipt['status'] = EffectArray.some(checks, check => check.status === 'blocked')
    ? 'blocked'
    : EffectArray.some(checks, check => check.status === 'pending')
      ? 'pending'
      : 'verified';
  const unsigned = {
    version: 1 as const,
    manifestDigest: manifest.manifestDigest,
    evidenceDigest: digest(evidence),
    checkedAt,
    deploymentId: manifest.deploymentId,
    drillId: evidence.drillId,
    isolatedTargetId: evidence.isolatedTargetId,
    evidenceTrust: 'operator-attested' as const,
    providerActions: 'none' as const,
    status,
    checks,
  };
  return {...unsigned, receiptDigest: digest(unsigned)};
}

export function verifyOperationsReceipt(
  rawManifest: unknown,
  rawEvidence: unknown,
  rawReceipt: unknown,
  asOf: string,
): OperationsReceipt {
  const receipt = parseOperations(OperationsReceiptSchema, rawReceipt);
  const expected = verifyOperationsEvidence(rawManifest, rawEvidence, receipt.checkedAt);
  requireValid(canonicalJson(receipt) === canonicalJson(expected));
  const current = verifyOperationsEvidence(rawManifest, rawEvidence, asOf);
  requireValid(Date.parse(asOf) >= Date.parse(receipt.checkedAt));
  requireValid(current.status === receipt.status && canonicalJson(current.checks) === canonicalJson(receipt.checks));
  return expected;
}

function parseEvidence(raw: unknown, manifest: OperationsManifest): OperationsEvidence {
  const evidence = parseOperations(OperationsEvidenceSchema, raw);
  requireValid(
    evidence.manifestDigest === manifest.manifestDigest && evidence.isolatedTargetId !== manifest.deploymentId,
  );
  requireValid(new Set(EffectArray.map(evidence.checks, check => check.check)).size === OPERATIONS_CHECKS.length);
  for (const entry of evidence.checks) {
    if (entry.status === 'pending') continue;
    const specification = OPERATIONS_CHECK_SPECIFICATIONS[entry.check];
    requireValid(exactKeys(entry.facts, specification.facts) && exactKeys(entry.metrics, specification.metrics));
    requireValid(entry.observerId === manifest.owners.operator);
  }
  return {
    ...evidence,
    checks: EffectArray.map(OPERATIONS_CHECKS, check =>
      EffectOption.getOrUndefined(EffectArray.findFirst(evidence.checks, entry => entry.check === check))!,
    ),
  };
}

type Observation = Extract<OperationsEvidence['checks'][number], {status: 'observed'}>;
function metricsPass(entry: Observation, manifest: OperationsManifest): boolean {
  const metrics = entry.metrics;
  if (entry.check === 'backup') {
    return (
      metrics.backupAgeSeconds <= manifest.backup.scheduleSeconds &&
      metrics.pitrWindowSeconds >= manifest.backup.retentionSeconds &&
      metrics.pitrLagSeconds <= manifest.backup.rpoSeconds
    );
  }
  if (entry.check === 'isolated-restore') {
    return (
      metrics.elapsedSeconds > 0 &&
      metrics.elapsedSeconds <= manifest.backup.rtoSeconds &&
      metrics.recoveryPointLossSeconds <= manifest.backup.rpoSeconds
    );
  }
  if (entry.check === 'readiness') {
    return metrics.recoveryElapsedSeconds > 0 && metrics.recoveryElapsedSeconds <= manifest.backup.rtoSeconds;
  }
  if (entry.check === 'restore-reconciliation' || entry.check === 'post-rollback-reconciliation') {
    return (
      metrics.verifiedRecords === manifest.baseline.expectedRecords &&
      EffectArray.every(EffectRecord.toEntries(metrics), ([key, value]) => key === 'verifiedRecords' || value === 0)
    );
  }
  return true;
}

const PREDECESSORS: Partial<Record<OperationsCheck, OperationsCheck>> = {
  'isolated-restore': 'backup',
  'restore-reconciliation': 'isolated-restore',
  start: 'restore-reconciliation',
  readiness: 'start',
  'write-disable': 'readiness',
  'read-continuity': 'write-disable',
  'route-withdrawal': 'read-continuity',
  'safe-stop': 'route-withdrawal',
  rollback: 'safe-stop',
  'post-rollback-reconciliation': 'rollback',
};
function orderPass(entry: Observation, evidence: OperationsEvidence): boolean {
  const predecessor = PREDECESSORS[entry.check];
  if (!predecessor) return true;
  const previous = EffectOption.getOrUndefined(
    EffectArray.findFirst(evidence.checks, check => check.check === predecessor),
  );
  return previous?.status === 'observed' && Date.parse(previous.observedAt) < Date.parse(entry.observedAt);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = EffectRecord.keys(value);
  return keys.length === expected.length && EffectArray.every(keys, key => expected.includes(key));
}
function requireValid(valid: boolean): asserts valid {
  if (!valid) throw new Error('Invalid operations input.');
}
function digest(value: unknown): string {
  return sha256HexSync(canonicalJson(value));
}
