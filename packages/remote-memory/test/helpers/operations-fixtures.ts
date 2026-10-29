import {Array as EffectArray} from 'effect';
import {
  OPERATIONS_ALERTS,
  OPERATIONS_CHECKS,
  OPERATIONS_CHECK_SPECIFICATIONS,
  type OperationsManifest,
} from '@threadnote/remote-memory/operations/contract';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const checkedAt = '2026-09-18T01:00:00.000Z';
export function operationsDraft() {
  const owners = {
    operator: Effect.pipe('1', EffectString.repeat(32)),
    support: Effect.pipe('2', EffectString.repeat(32)),
    escalation: Effect.pipe('3', EffectString.repeat(32)),
  };
  return {
    version: 1,
    deploymentId: Effect.pipe('a', EffectString.repeat(32)),
    plannedAt: '2026-09-18T00:00:00.000Z',
    maxEvidenceAgeSeconds: 86_400,
    owners,
    ownerRosterDigest: Effect.pipe('7', EffectString.repeat(64)),
    authority: 'git',
    backup: {
      method: 'snapshot-and-pitr',
      scheduleSeconds: 3600,
      retentionSeconds: 604800,
      rpoSeconds: 300,
      rtoSeconds: 1800,
    },
    baseline: {
      expectedRecords: 1,
      gitAuthorityDigest: Effect.pipe('1', EffectString.repeat(64)),
      databaseCheckpointDigest: Effect.pipe('2', EffectString.repeat(64)),
      aliasCatalogDigest: Effect.pipe('3', EffectString.repeat(64)),
      grantPolicyDigest: Effect.pipe('4', EffectString.repeat(64)),
      runtimeArtifactDigest: Effect.pipe('5', EffectString.repeat(64)),
      rollbackArtifactDigest: Effect.pipe('6', EffectString.repeat(64)),
    },
    alerts: EffectArray.map(OPERATIONS_ALERTS, kind => ({
      kind,
      owners: {...owners},
      safeFirstAction: 'disable-writes',
      rollback: 'keep-writes-disabled-restore-reviewed-baseline',
    })),
  };
}

export function observedOperationsEvidence(manifest: OperationsManifest) {
  return {
    version: 1 as const,
    manifestDigest: manifest.manifestDigest,
    drillId: Effect.pipe('b', EffectString.repeat(32)),
    isolatedTargetId: Effect.pipe('c', EffectString.repeat(32)),
    checks: EffectArray.map(OPERATIONS_CHECKS, (check, index) => {
      const spec = OPERATIONS_CHECK_SPECIFICATIONS[check];
      const metrics: Record<string, number> = EffectRecord.fromEntries(EffectArray.map(spec.metrics, key => [key, 0]));
      if (check === 'backup') metrics.pitrWindowSeconds = manifest.backup.retentionSeconds;
      if (check === 'isolated-restore') metrics.elapsedSeconds = 60;
      if (check === 'readiness') metrics.recoveryElapsedSeconds = 600;
      if (check === 'restore-reconciliation' || check === 'post-rollback-reconciliation') metrics.verifiedRecords = 1;
      return {
        check,
        status: 'observed' as const,
        observedAt: new Date(Date.parse(manifest.plannedAt) + index * 60_000).toISOString(),
        observerId: manifest.owners.operator,
        evidenceDigest: Effect.pipe('d', EffectString.repeat(64)),
        facts: EffectRecord.fromEntries(EffectArray.map(spec.facts, key => [key, true])),
        metrics,
      };
    }),
  };
}
