import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

import {aggregateContextHealthReportsV1} from '@threadnote/context/health_schedule';
import type {ContextHealthReportV1} from '@threadnote/context/health';
import {
  buildHostedContextHealthPolicyV1,
  buildHostedContextHealthReceiptV1,
  buildHostedContextHealthScheduleV1,
  hostedContextHealthBackoffMilliseconds,
  parseHostedContextHealthRunInputV1,
  selectHostedContextHealthJobsV1,
  signHostedContextHealthEvaluationV1,
  verifyHostedContextHealthEvaluationV1,
  type HostedContextHealthRunInputV1,
} from '@threadnote/remote-memory/hosted/context_health';

const policy = buildHostedContextHealthPolicyV1({
  backlogAlertCount: 10,
  persistentStaleRuns: 2,
  policyVersion: 'pilot-health-v1',
  schedulerLagMinutes: 15,
  supportOwner: 'pilot-support-primary',
  workerHeartbeatMinutes: 5,
});
const schedule = buildHostedContextHealthScheduleV1({
  cadenceMinutes: 60,
  policy,
  project: 'threadnote',
  shareId: 'pilot-share-private',
  tenantId: 'pilot-organization-private',
});
const evaluationKey = 'test-context-health-evaluation-key-32-bytes';

describe('hosted organization context health', () => {
  it('derives deterministic content-free receipts from immutable evidence', () => {
    const input = runInput();
    const first = buildHostedContextHealthReceiptV1(input);
    const replay = buildHostedContextHealthReceiptV1(structuredClone(input));

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      memoryMutation: 'none',
      outcome: 'clean',
      reviewRequired: false,
      scheduleId: schedule.scheduleId,
      version: 1,
    });
    const serialized = JSON.stringify(first);
    for (const secretLabel of [schedule.tenantId, schedule.shareId, schedule.project, input.repositoryCommit]) {
      expect(serialized).not.toContain(secretLabel);
    }
    expect(first.labels).toEqual({
      project: expect.stringMatching(/^project-[0-9a-f]{20}$/u),
      share: expect.stringMatching(/^share-[0-9a-f]{20}$/u),
      tenant: expect.stringMatching(/^tenant-[0-9a-f]{20}$/u),
    });
  });

  it('makes stale or unavailable evidence reviewable without describing a mutation', () => {
    const receipt = buildHostedContextHealthReceiptV1({
      ...runInput(),
      aggregate: aggregate('unknown'),
      backlogDepth: 12,
      observedAt: '2026-09-18T12:30:00.000Z',
      priorConsecutiveStaleRuns: 1,
      signals: {
        citationChanged: 1,
        citationCurrent: 3,
        citationMissing: 1,
        citationUnknown: 2,
        failedChecks: 1,
        policyDrift: 1,
        staleHandoffs: 1,
        unindexedScope: 1,
      },
      workerHeartbeatAt: '2026-09-18T12:00:00.000Z',
    });

    expect(receipt).toMatchObject({memoryMutation: 'none', outcome: 'unknown', reviewRequired: true});
    expect(receipt.alerts.filter(alert => alert.state === 'firing').map(alert => alert.kind)).toEqual([
      'backlog',
      'failed-checks',
      'persistent-stale-evidence',
      'scheduler-lag',
      'worker-heartbeat',
    ]);
    expect(
      receipt.alerts.every(
        alert => alert.supportOwner === 'pilot-support-primary' && alert.safeFirstAction && alert.rollback,
      ),
    ).toBe(true);
  });

  it('treats changed, stale, and unknown signals as reviewable without requiring a paging alert', () => {
    for (const signal of ['citationChanged', 'citationMissing', 'policyDrift', 'staleHandoffs'] as const) {
      const receipt = buildHostedContextHealthReceiptV1({
        ...runInput(),
        signals: {...runInput().signals, [signal]: 1},
      });

      expect(receipt).toMatchObject({outcome: 'findings', reviewRequired: true});
      expect(receipt.alerts.every(alert => alert.state === 'clear')).toBe(true);
    }
    for (const signal of ['citationUnknown', 'failedChecks', 'unindexedScope'] as const) {
      const receipt = buildHostedContextHealthReceiptV1({
        ...runInput(),
        signals: {...runInput().signals, [signal]: 1},
      });

      expect(receipt).toMatchObject({outcome: 'unknown', reviewRequired: true});
    }
  });

  it('rotates tenant-first selection so a busy tenant cannot starve another', () => {
    const dueAt = '2026-09-18T12:00:00.000Z';
    const jobs = [
      job('alpha', 1, dueAt),
      job('alpha', 2, dueAt),
      job('alpha', 3, dueAt),
      job('beta', 1, dueAt),
      job('gamma', 1, dueAt),
    ];
    const first = selectHostedContextHealthJobsV1(jobs, {concurrency: 1});
    const second = selectHostedContextHealthJobsV1(jobs, {
      concurrency: 1,
      tenantCursorOrdinal: first.nextTenantOrdinal,
    });
    const round = selectHostedContextHealthJobsV1(jobs, {concurrency: 3});

    expect(first.jobs.map(value => value.tenantId)).toEqual(['alpha']);
    expect(second.jobs.map(value => value.tenantId)).toEqual(['beta']);
    expect(round.jobs.map(value => value.tenantId)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('selects the same fair work regardless of candidate ordering', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.constantFrom('a', 'b', 'c', 'd'), fc.integer({min: 0, max: 20})), {
          maxLength: 40,
          selector: value => `${value[0]}:${value[1]}`,
        }),
        fc.integer({min: 1, max: 16}),
        (candidates, concurrency) => {
          const jobs = candidates.map(([tenant, index]) => job(tenant, index, '2026-09-18T12:00:00.000Z'));
          expect(selectHostedContextHealthJobsV1(jobs, {concurrency})).toEqual(
            selectHostedContextHealthJobsV1([...jobs].reverse(), {concurrency}),
          );
        },
      ),
      {numRuns: 100},
    );
  });

  it('uses deterministic capped retry backoff', () => {
    expect(hostedContextHealthBackoffMilliseconds(1)).toBe(60_000);
    expect(hostedContextHealthBackoffMilliseconds(4)).toBe(480_000);
    expect(hostedContextHealthBackoffMilliseconds(31)).toBe(6 * 60 * 60_000);
  });

  it('rejects mutable, tampered, or early evidence', () => {
    const input = runInput();
    expect(() =>
      buildHostedContextHealthReceiptV1({
        ...input,
        aggregate: {...input.aggregate, knownFindings: 9},
      }),
    ).toThrow(/aggregate digest/i);
    expect(() =>
      buildHostedContextHealthReceiptV1({
        ...input,
        observedAt: '2026-09-18T11:59:59.000Z',
      }),
    ).toThrow(/before it is due/i);
    expect(() => buildHostedContextHealthReceiptV1({...input, repositoryCommit: 'dirty-worktree'})).toThrow(
      /immutable Git commit/i,
    );
    expect(() =>
      buildHostedContextHealthReceiptV1({
        ...input,
        workerHeartbeatAt: '2026-09-18T12:00:01.000Z',
      }),
    ).toThrow(/heartbeat cannot be later/i);
    const personalAggregate = aggregateContextHealthReportsV1({
      personal: {
        evidenceRevision: '3'.repeat(64),
        report: report(),
        scope: 'personal',
        state: 'complete',
      },
      project: 'threadnote',
      teams: [],
    });
    expect(() => buildHostedContextHealthReceiptV1({...input, aggregate: personalAggregate})).toThrow(
      /shared-memory sources only/i,
    );
  });

  it('rejects non-canonical signal fields before receipt persistence or digesting', () => {
    const input = {
      ...runInput(),
      signals: {...runInput().signals, content: 'private-memory-body'},
    };

    expect(() => parseHostedContextHealthRunInputV1(input)).toThrow(/exactly the canonical signals/i);
    expect(() => buildHostedContextHealthReceiptV1(input)).toThrow(/exactly the canonical signals/i);
  });

  it('cryptographically binds results and counts to one claim and audience', () => {
    const input = runInput();
    expect(() => verifyHostedContextHealthEvaluationV1(input, evaluationKey)).not.toThrow();
    expect(() =>
      verifyHostedContextHealthEvaluationV1({...input, signals: {...input.signals, citationCurrent: 3}}, evaluationKey),
    ).not.toThrow();
    fc.assert(
      fc.property(
        fc.constantFrom(...(Object.keys(input.signals) as (keyof typeof input.signals)[])).chain(signal =>
          fc
            .integer({min: 0, max: 10_000})
            .filter(count => count !== input.signals[signal])
            .map(count => [signal, count] as const),
        ),
        ([signal, count]) => {
          expect(() =>
            verifyHostedContextHealthEvaluationV1(
              {...input, signals: {...input.signals, [signal]: count}},
              evaluationKey,
            ),
          ).toThrow(/attestation is invalid/i);
        },
      ),
      {numRuns: 50},
    );
    expect(() =>
      verifyHostedContextHealthEvaluationV1({...input, aggregate: aggregate('unknown')}, evaluationKey),
    ).toThrow(/attestation is invalid/i);
  });

  it('rejects every additional enumerable signal field', () => {
    fc.assert(
      fc.property(
        fc
          .stringMatching(/^[a-z][a-z0-9]{0,15}$/u)
          .filter(
            key =>
              ![
                'citationChanged',
                'citationCurrent',
                'citationMissing',
                'citationUnknown',
                'failedChecks',
                'policyDrift',
                'staleHandoffs',
                'unindexedScope',
              ].includes(key),
          ),
        key => {
          const input = {
            ...runInput(),
            signals: {...runInput().signals, [key]: 'content-bearing-value'},
          };
          expect(() => buildHostedContextHealthReceiptV1(input)).toThrow(/exactly the canonical signals/i);
        },
      ),
      {numRuns: 50},
    );
  });
});

function runInput(): HostedContextHealthRunInputV1 {
  return signHostedContextHealthEvaluationV1(
    {
      aggregate: aggregate('clean'),
      backlogDepth: 0,
      dueAt: '2026-09-18T12:00:00.000Z',
      memorySnapshotRevision: '2'.repeat(64),
      observedAt: '2026-09-18T12:00:00.000Z',
      priorConsecutiveStaleRuns: 0,
      repositoryCommit: '1'.repeat(40),
      schedule,
      signals: {
        citationChanged: 0,
        citationCurrent: 3,
        citationMissing: 0,
        citationUnknown: 0,
        failedChecks: 0,
        policyDrift: 0,
        staleHandoffs: 0,
        unindexedScope: 0,
      },
      version: 1,
      workerHeartbeatAt: '2026-09-18T12:00:00.000Z',
    },
    {claimGeneration: 1, claimToken: 'a'.repeat(32)},
    evaluationKey,
  );
}

function aggregate(status: 'clean' | 'unknown') {
  return aggregateContextHealthReportsV1({
    project: 'threadnote',
    teams: [
      status === 'unknown'
        ? {reason: 'evidence-incomplete', scope: 'team' as const, state: 'unknown' as const, team: 'canonical'}
        : {
            evidenceRevision: '3'.repeat(64),
            report: report(),
            scope: 'team' as const,
            state: 'complete' as const,
            team: 'canonical',
          },
    ],
  });
}

function report(): ContextHealthReportV1 {
  return {
    findings: [],
    limit: 100,
    omittedFindings: 0,
    project: 'threadnote',
    recordsScanned: 1,
    semanticCompleteness: {
      analyzedRecords: 1,
      claimsAnalyzed: 1,
      supportedClaims: 1,
      unsupportedClaims: 0,
      coverage: 'bounded-English-extraction',
      contradictionCount: 0,
      eligibleRecords: 1,
      omittedContradictions: 0,
      pairsCompared: 0,
      state: 'complete',
      unknownReasons: [],
      unknownRecords: 0,
      version: 2,
    },
    status: 'clean',
    version: 1,
  };
}

function job(tenantId: string, ordinal: number, dueAt: string) {
  const suffix = `${tenantId.charCodeAt(0).toString(16)}${ordinal.toString(16)}`.padStart(32, '0');
  return {dueAt, scheduleId: `tnhs_${suffix}`, tenantId};
}
