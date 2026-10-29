import {Array as EffectArray, Option as EffectOption} from 'effect';
import operationsExample from '../../../../docs/examples/org-operations.v1.json' with {type: 'json'};
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  buildOperationsManifest,
  operationsEvidenceTemplate,
  verifyOperationsEvidence,
  verifyOperationsReceipt,
} from '@threadnote/remote-memory/operations';
import {
  OPERATIONS_ALERTS,
  OPERATIONS_CHECKS,
  OPERATIONS_CHECK_SPECIFICATIONS,
} from '@threadnote/remote-memory/operations/contract';
import {operationsDraft, observedOperationsEvidence, checkedAt} from '../helpers/operations-fixtures.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('operations evidence boundary', () => {
  it('keeps external actions pending and fails closed until every observation passes', () => {
    const manifest = buildOperationsManifest(operationsDraft());
    const evidence = operationsEvidenceTemplate(
      manifest,
      Effect.pipe('b', EffectString.repeat(32)),
      Effect.pipe('c', EffectString.repeat(32)),
    );
    const receipt = verifyOperationsEvidence(manifest, evidence, checkedAt);
    expect(receipt.status).toBe('pending');
    expect(receipt.checks).toHaveLength(OPERATIONS_CHECKS.length);
    expect(EffectArray.every(receipt.checks, check => check.status === 'pending')).toBe(true);
    expect(receipt.providerActions).toBe('none');
    expect(verifyOperationsReceipt(manifest, evidence, receipt, checkedAt)).toEqual(receipt);
  });

  it('verifies complete observed drill evidence without claiming to authenticate provider actions', () => {
    const manifest = buildOperationsManifest(operationsDraft());
    const receipt = verifyOperationsEvidence(manifest, observedOperationsEvidence(manifest), checkedAt);
    expect(receipt.status).toBe('verified');
    expect(receipt.evidenceTrust).toBe('operator-attested');
    expect(receipt.providerActions).toBe('none');
  });

  it('rejects deployment/owner collisions and duplicate alert roles', () => {
    const draft = operationsDraft();
    const ids = ['deploymentId', 'operator', 'support', 'escalation'] as const;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const duplicate = structuredClone(draft);
        const first = ids[i];
        const second = ids[j];
        if (first === undefined || second === undefined) continue;
        const source = first === 'deploymentId' ? draft.deploymentId : draft.owners[first];
        if (second === 'deploymentId') duplicate.deploymentId = source;
        else duplicate.owners[second] = source;
        expect(() => buildOperationsManifest(duplicate)).toThrow('Invalid operations input.');
      }
    }
    for (const kind of OPERATIONS_ALERTS) {
      for (const [first, second] of [
        ['operator', 'support'],
        ['operator', 'escalation'],
        ['support', 'escalation'],
      ] as const) {
        const duplicate = structuredClone(draft);
        const alert = EffectOption.getOrUndefined(
          EffectArray.findFirst(duplicate.alerts, alert => alert.kind === kind),
        )!;
        alert.owners[second] = alert.owners[first];
        expect(() => buildOperationsManifest(duplicate)).toThrow('Invalid operations input.');
      }
    }
  });

  it('blocks future and expired manifests even with pending or freshly observed evidence', () => {
    const draft = operationsDraft();
    const manifest = buildOperationsManifest(draft);
    for (const at of ['2026-09-17T23:59:59.999Z', '2026-09-19T00:00:00.001Z']) {
      const pending = operationsEvidenceTemplate(
        manifest,
        Effect.pipe('b', EffectString.repeat(32)),
        Effect.pipe('c', EffectString.repeat(32)),
      );
      expect(
        EffectArray.every(verifyOperationsEvidence(manifest, pending, at).checks, check => check.status === 'blocked'),
      ).toBe(true);
    }
    const refreshed = observedOperationsEvidence(manifest);
    for (const entry of refreshed.checks)
      entry.observedAt = Effect.pipe(entry.observedAt, EffectString.replace('2026-09-18', '2026-09-19'));
    expect(verifyOperationsEvidence(manifest, refreshed, '2026-09-19T01:00:00.000Z').status).toBe('blocked');
  });

  it('bounds the reviewed manifest window inclusively for any verification instant', () => {
    const manifest = buildOperationsManifest(operationsDraft());
    const pending = operationsEvidenceTemplate(
      manifest,
      Effect.pipe('b', EffectString.repeat(32)),
      Effect.pipe('c', EffectString.repeat(32)),
    );
    const window = manifest.maxEvidenceAgeSeconds * 1000;
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(-1, 0, window, window + 1), fc.integer({min: -window, max: 2 * window})),
        offset => {
          const at = new Date(Date.parse(manifest.plannedAt) + offset).toISOString();
          expect(verifyOperationsEvidence(manifest, pending, at).status).toBe(
            offset >= 0 && offset <= window ? 'pending' : 'blocked',
          );
        },
      ),
      {numRuns: 40},
    );
  });

  it('requires strictly ordered recovery observations', () => {
    const manifest = buildOperationsManifest(operationsDraft());
    const pairs = [
      ['backup', 'isolated-restore'],
      ['isolated-restore', 'restore-reconciliation'],
      ['restore-reconciliation', 'start'],
      ['start', 'readiness'],
      ['readiness', 'write-disable'],
      ['write-disable', 'read-continuity'],
      ['read-continuity', 'route-withdrawal'],
      ['route-withdrawal', 'safe-stop'],
      ['safe-stop', 'rollback'],
      ['rollback', 'post-rollback-reconciliation'],
    ];
    for (const [before, after] of pairs) {
      const evidence = observedOperationsEvidence(manifest);
      EffectOption.getOrUndefined(EffectArray.findFirst(evidence.checks, entry => entry.check === after))!.observedAt =
        EffectOption.getOrUndefined(
          EffectArray.findFirst(evidence.checks, entry => entry.check === before),
        )!.observedAt;
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            verifyOperationsEvidence(manifest, evidence, checkedAt).checks,
            entry => entry.check === after,
          ),
        )?.status,
      ).toBe('blocked');
    }
  });

  it('requires approved rotation overlap/handoff and uninterrupted authenticated service and reads', () => {
    const manifest = buildOperationsManifest(operationsDraft());
    for (const check of ['jwks-rotation', 'workload-credential-rotation'] as const) {
      for (const fact of [
        'approvedOverlapHandoffVerified',
        'authenticatedServiceContinuous',
        'authenticatedReadsContinuous',
      ]) {
        const evidence = observedOperationsEvidence(manifest);
        const entry = EffectOption.getOrUndefined(
          EffectArray.findFirst(evidence.checks, entry => entry.check === check),
        )!;
        expect(entry.facts[fact]).toBe(true);
        entry.facts[fact] = false;
        expect(verifyOperationsEvidence(manifest, evidence, checkedAt).status).toBe('blocked');
      }
    }
  });

  it('requires the full service alert catalog and per-alert delivery proof', () => {
    expect(OPERATIONS_ALERTS).toEqual(
      expect.arrayContaining([
        'auth',
        'recall',
        'read',
        'write',
        'cas',
        'git-synchronization',
        'registry-publication',
        'database-saturation',
        'canary',
      ]),
    );
    const draft = operationsDraft();
    const manifest = buildOperationsManifest(draft);
    const example = buildOperationsManifest(operationsExample);
    expect(EffectArray.map(example.alerts, alert => alert.kind)).toEqual(
      EffectArray.map(manifest.alerts, alert => alert.kind),
    );
    for (const kind of OPERATIONS_ALERTS) {
      expect(() =>
        buildOperationsManifest({...draft, alerts: EffectArray.filter(draft.alerts, alert => alert.kind !== kind)}),
      ).toThrow();
      for (const fact of [
        'namedOwnersResolved',
        'operatorAcknowledged',
        'supportAcknowledged',
        'escalationTested',
        'safeActionTested',
        'rollbackTested',
      ]) {
        const evidence = observedOperationsEvidence(manifest);
        const entry = EffectOption.getOrUndefined(
          EffectArray.findFirst(evidence.checks, entry => entry.check === 'alert-delivery'),
        )!;
        const key = `${kind}:${fact}`;
        expect(entry.facts[key]).toBe(true);
        entry.facts[key] = false;
        expect(verifyOperationsEvidence(manifest, evidence, checkedAt).status).toBe('blocked');
        delete entry.facts[key];
        expect(() => verifyOperationsEvidence(manifest, evidence, checkedAt)).toThrow('Invalid operations input.');
      }
    }
  });

  it('rejects missing, duplicate, unrelated, and cross-deployment evidence', () => {
    const manifest = buildOperationsManifest(operationsDraft());
    const evidence = observedOperationsEvidence(manifest);
    for (const invalid of [
      {...evidence, checks: evidence.checks.slice(1)},
      {...evidence, checks: [...evidence.checks.slice(1), evidence.checks[1]]},
      {...evidence, manifestDigest: Effect.pipe('f', EffectString.repeat(64))},
      {...evidence, isolatedTargetId: manifest.deploymentId},
      {...evidence, checks: [...evidence.checks, {check: 'unknown', status: 'pending'}]},
    ])
      expect(() => verifyOperationsEvidence(manifest, invalid, checkedAt)).toThrow('Invalid operations input.');
  });

  it('every required fact fails closed and reconciliation discrepancies block readiness', () => {
    const manifest = buildOperationsManifest(operationsDraft());
    for (const check of OPERATIONS_CHECKS) {
      for (const fact of OPERATIONS_CHECK_SPECIFICATIONS[check].facts) {
        const evidence = observedOperationsEvidence(manifest);
        const entry = EffectOption.getOrUndefined(
          EffectArray.findFirst(evidence.checks, entry => entry.check === check),
        )!;
        entry.facts[fact] = false;
        expect(verifyOperationsEvidence(manifest, evidence, checkedAt).status).toBe('blocked');
      }
    }
    const evidence = observedOperationsEvidence(manifest);
    EffectOption.getOrUndefined(
      EffectArray.findFirst(evidence.checks, entry => entry.check === 'restore-reconciliation'),
    )!.metrics.hashMismatches = 1;
    expect(verifyOperationsEvidence(manifest, evidence, checkedAt).status).toBe('blocked');
  });

  it('enforces RPO, RTO, retention, evidence age, chronological drill order, and fresh receipt verification', () => {
    const manifest = buildOperationsManifest(operationsDraft());
    for (const metric of ['recoveryPointLossSeconds', 'elapsedSeconds']) {
      const evidence = observedOperationsEvidence(manifest);
      EffectOption.getOrUndefined(
        EffectArray.findFirst(evidence.checks, entry => entry.check === 'isolated-restore'),
      )!.metrics[metric] = 100_000;
      expect(verifyOperationsEvidence(manifest, evidence, checkedAt).status).toBe('blocked');
    }
    const overdue = observedOperationsEvidence(manifest);
    EffectOption.getOrUndefined(
      EffectArray.findFirst(overdue.checks, entry => entry.check === 'readiness'),
    )!.metrics.recoveryElapsedSeconds = manifest.backup.rtoSeconds + 1;
    expect(verifyOperationsEvidence(manifest, overdue, checkedAt).status).toBe('blocked');
    const evidence = observedOperationsEvidence(manifest);
    const receipt = verifyOperationsEvidence(manifest, evidence, checkedAt);
    expect(verifyOperationsEvidence(manifest, evidence, '2026-09-20T00:00:00.000Z').status).toBe('blocked');
    expect(verifyOperationsEvidence(manifest, evidence, '2026-09-17T00:00:00.000Z').status).toBe('blocked');
    expect(() => verifyOperationsReceipt(manifest, evidence, receipt, '2026-09-20T00:00:00.000Z')).toThrow();
    EffectOption.getOrUndefined(
      EffectArray.findFirst(evidence.checks, entry => entry.check === 'rollback'),
    )!.observedAt = '2026-09-18T00:00:00.000Z';
    expect(verifyOperationsEvidence(manifest, evidence, checkedAt).status).toBe('blocked');
    const draft = operationsDraft();
    draft.backup.retentionSeconds = 1;
    expect(() => buildOperationsManifest(draft)).toThrow();
  });

  it('rejects free text, raw identities, unknown nested properties and non-canonical input without echoing it', () => {
    const manifest = buildOperationsManifest(operationsDraft());
    for (const secret of ['user@example.invalid', '/private/repository', 'secret-token', 'raw log\nquery']) {
      const evidence = observedOperationsEvidence(manifest);
      for (const invalid of [
        {...evidence, content: secret},
        {...evidence, drillId: secret},
        {
          ...evidence,
          checks: EffectArray.map(evidence.checks, (entry, i) => (i === 0 ? {...entry, observerId: secret} : entry)),
        },
        {
          ...evidence,
          checks: EffectArray.map(evidence.checks, (entry, i) =>
            i === 0 ? {...entry, facts: {...entry.facts, [secret]: true}} : entry,
          ),
        },
      ])
        expect(() => verifyOperationsEvidence(manifest, invalid, checkedAt)).toThrow(/^Invalid operations input\.$/u);
    }
    expect(() => buildOperationsManifest({...operationsDraft(), unexpected: 'sensitive'})).toThrow(
      /^Invalid operations input\.$/u,
    );
  });

  it('requires complete alert ownership and reconciliation coverage', () => {
    const draft = operationsDraft();
    expect(() => buildOperationsManifest({...draft, alerts: draft.alerts.slice(1)})).toThrow();
    expect(() => buildOperationsManifest({...draft, alerts: [...draft.alerts.slice(1), draft.alerts[1]]})).toThrow();
    expect(() =>
      buildOperationsManifest({...draft, owners: {...draft.owners, operator: 'operator@example.invalid'}}),
    ).toThrow(/^Invalid operations input\.$/u);
    const manifest = buildOperationsManifest(draft);
    for (const name of ['restore-reconciliation', 'post-rollback-reconciliation']) {
      for (const metric of [
        'verifiedRecords',
        'hashMismatches',
        'aliasMismatches',
        'grantMismatches',
        'indexMismatches',
        'unresolvedWrites',
      ]) {
        const evidence = observedOperationsEvidence(manifest);
        EffectOption.getOrUndefined(EffectArray.findFirst(evidence.checks, entry => entry.check === name))!.metrics[
          metric
        ] = metric === 'verifiedRecords' ? 0 : 1;
        expect(verifyOperationsEvidence(manifest, evidence, checkedAt).status).toBe('blocked');
      }
    }
    for (const metric of ['backupAgeSeconds', 'pitrWindowSeconds', 'pitrLagSeconds']) {
      const evidence = observedOperationsEvidence(manifest);
      EffectOption.getOrUndefined(EffectArray.findFirst(evidence.checks, entry => entry.check === 'backup'))!.metrics[
        metric
      ] = metric === 'pitrWindowSeconds' ? 0 : 1_000_000;
      expect(verifyOperationsEvidence(manifest, evidence, checkedAt).status).toBe('blocked');
    }
  });

  it('rejects tampered manifests and receipts, including forged success over pending observations', () => {
    const manifest = buildOperationsManifest(operationsDraft());
    const evidence = operationsEvidenceTemplate(
      manifest,
      Effect.pipe('b', EffectString.repeat(32)),
      Effect.pipe('c', EffectString.repeat(32)),
    );
    const receipt = verifyOperationsEvidence(manifest, evidence, checkedAt);
    expect(() =>
      verifyOperationsEvidence(
        {...manifest, manifestDigest: Effect.pipe('f', EffectString.repeat(64))},
        evidence,
        checkedAt,
      ),
    ).toThrow();
    expect(() => verifyOperationsReceipt(manifest, evidence, {...receipt, status: 'verified'}, checkedAt)).toThrow();
    expect(() => verifyOperationsReceipt(manifest, evidence, {...receipt, raw: 'private'}, checkedAt)).toThrow();
  });

  it('is deterministic, idempotent and non-mutating across key and checklist permutations', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...OPERATIONS_CHECKS], {
          minLength: OPERATIONS_CHECKS.length,
          maxLength: OPERATIONS_CHECKS.length,
        }),
        order => {
          const draft = operationsDraft();
          const manifest = buildOperationsManifest(draft);
          const reordered = EffectRecord.fromEntries(EffectRecord.toEntries(draft).reverse());
          expect(buildOperationsManifest(reordered)).toEqual(manifest);
          const evidence = observedOperationsEvidence(manifest);
          const reorderedChecks = EffectArray.map(order, check => {
            const entry = EffectOption.getOrUndefined(
              EffectArray.findFirst(evidence.checks, candidate => candidate.check === check),
            );
            if (entry === undefined) throw new Error(`Missing operations check ${check}.`);
            return entry;
          });
          const [firstCheck, ...remainingChecks] = reorderedChecks;
          if (firstCheck === undefined) throw new Error('Operations checklist cannot be empty.');
          evidence.checks = [firstCheck, ...remainingChecks];
          const before = JSON.stringify(evidence);
          const receipt = verifyOperationsEvidence(manifest, evidence, checkedAt);
          expect(receipt).toEqual(verifyOperationsEvidence(manifest, observedOperationsEvidence(manifest), checkedAt));
          expect(verifyOperationsReceipt(manifest, evidence, receipt, checkedAt)).toEqual(receipt);
          expect(JSON.stringify(evidence)).toBe(before);
        },
      ),
      {numRuns: 30},
    );
  });
});
