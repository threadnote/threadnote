import {Array as EffectArray, Option as EffectOption} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  APPROVED_THREADNOTE_5_BASELINE_COMPARISON,
  APPROVED_THREADNOTE_5_METRICS,
  APPROVED_THREADNOTE_5_SCENARIOS,
  THREADNOTE_5_BASELINE_COMPARABLE_METRICS,
  THREADNOTE_5_BASELINE_COMMIT,
  THREADNOTE_5_BASELINE_NOT_APPLICABLE_METRICS,
  parseThreadnote5ReleaseEvidenceV1,
  parseThreadnote5ReleaseReadinessFixtureV1,
  threadnote5CaptureManifestForEvidence,
  threadnote5CaptureManifestHash,
  threadnote5ObservationReceiptHash,
  threadnote5ObservationTranscriptHash,
  parseThreadnote5TrustedSourceV1,
  threadnote5ReleaseEvidenceHash,
  threadnote5ReleaseReadinessFixtureHash,
  threadnote5SourceHash,
  type Threadnote5BaselineV1,
  type Threadnote5EvidenceClass,
  type Threadnote5MeasurementV1,
  type Threadnote5ObservationV1,
  type Threadnote5ReleaseEvidenceV1,
  type Threadnote5ReleaseMetric,
  type Threadnote5SourceV1,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-contract';
import {evaluateThreadnote5ReleaseReadiness} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness';
import {
  threadnote5BaselineTrialLedger,
  threadnote5BaselineTrialLedgerHash,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-baseline-ledger';
import {
  THREADNOTE_5_LOCAL_RECEIPT_ADAPTERS,
  verifyThreadnote5LocalSubsystemReceipts,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-receipts';
import * as fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import fixtureJson from '../evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json' with {type: 'json'};
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

function isOneOf<const Values extends readonly string[]>(value: string, values: Values): value is Values[number] {
  for (const candidate of values) {
    if (candidate === value) return true;
  }
  return false;
}

const fixture = parseThreadnote5ReleaseReadinessFixtureV1(fixtureJson);
const CANDIDATE: Threadnote5SourceV1 = {
  commit: Effect.pipe('1', EffectString.repeat(40)),
  executableSha256: Effect.pipe('2', EffectString.repeat(64)),
  id: 'threadnote-5.0.0',
  version: `5.0.0-local.g${Effect.pipe('1', EffectString.repeat(40))}`,
};
const BASELINE: Threadnote5SourceV1 = {
  commit: THREADNOTE_5_BASELINE_COMMIT,
  executableSha256: Effect.pipe('4', EffectString.repeat(64)),
  id: 'threadnote-4.7.x',
  version: '4.7.8',
};

describe('Threadnote 5 release-readiness evidence', () => {
  it('declares Group 1 source adapters and their fail-closed external authority seams', () => {
    expect(THREADNOTE_5_LOCAL_RECEIPT_ADAPTERS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          acceptedScenarios: ['solo', 'output-budgets'],
          kind: 'context-brief',
          requiredAuthority: ['context-brief-plan-citation-authority'],
        }),
        expect.objectContaining({acceptedScenarios: ['dirty-worktree'], kind: 'context-check'}),
        expect.objectContaining({
          acceptedScenarios: ['projection-drift'],
          kind: 'guidance',
          requiredAuthority: ['guidance-stale-precondition-rejection-authority'],
        }),
        expect.objectContaining({
          acceptedScenarios: ['upgrade-downgrade'],
          kind: 'migration',
          requiredAuthority: ['migration-execution-authority'],
        }),
      ]),
    );
    expect(new Set(EffectArray.map(THREADNOTE_5_LOCAL_RECEIPT_ADAPTERS, adapter => adapter.kind)).size).toBe(
      THREADNOTE_5_LOCAL_RECEIPT_ADAPTERS.length,
    );
  });

  it('freezes the complete offline scenario, subsystem, and metric contract', () => {
    expect(fixture.baselineComparison).toEqual(APPROVED_THREADNOTE_5_BASELINE_COMPARISON);
    expect(fixture.networkAllowed).toBe(false);
    expect(fixture.scenarios).toEqual(APPROVED_THREADNOTE_5_SCENARIOS);
    expect(fixture.metrics).toEqual(APPROVED_THREADNOTE_5_METRICS);
    expect(EffectArray.map(fixture.scenarios, item => item.id)).toEqual([
      'solo',
      'two-agent',
      'git-shared',
      'offline',
      'dirty-worktree',
      'interrupted-resumed',
      'upgrade-downgrade',
      'provider-neutral-proposal',
      'verified-procedures',
      'health-maintenance',
      'structured-closeout',
      'stale-citation',
      'contradiction-triage',
      'projection-drift',
      'output-budgets',
    ]);
    expect(() =>
      parseThreadnote5ReleaseReadinessFixtureV1({
        ...fixtureJson,
        baselineComparison: {
          ...fixtureJson.baselineComparison,
          comparableMetricIds: [...fixtureJson.baselineComparison.comparableMetricIds, 'setup-success-rate'],
        },
      }),
    ).toThrow(/baseline comparison policy differs/u);
  });

  it('keeps a trusted sealed replay and absent 4.7.x baseline explicitly unknown', () => {
    const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    const result = evaluate(evidence);

    expect(EffectArray.every(result.scenarios, item => item.state === 'passed')).toBe(true);
    expect(EffectArray.every(result.metrics, item => item.thresholdPassed === true)).toBe(true);
    expect(
      EffectArray.every(
        EffectArray.filter(result.metrics, item => isOneOf(item.id, THREADNOTE_5_BASELINE_COMPARABLE_METRICS)),
        item => item.baseline.state === 'unknown' && item.delta.state === 'unknown',
      ),
    ).toBe(true);
    expect(
      EffectArray.every(
        EffectArray.filter(result.metrics, item => isOneOf(item.id, THREADNOTE_5_BASELINE_NOT_APPLICABLE_METRICS)),
        item => item.baseline.state === 'not-applicable' && item.delta.state === 'not-applicable',
      ),
    ).toBe(true);
    expect(result.evidence.captureManifestTrusted).toBe(true);
    expect(result.gate).toEqual({
      insufficiencies: [
        '4.7.8 baseline is unavailable: not-captured',
        'sealed fixture replay is not production release evidence',
      ],
      qualityFailures: [],
      status: 'unknown',
    });
  });

  it('keeps a passing candidate independent from trusted not-applicable baseline lanes', () => {
    const baseline: Threadnote5BaselineV1 = {
      observations: observationsFor(BASELINE, 'baseline'),
      source: BASELINE,
      state: 'available',
    };
    const evidence = evidenceBundle({baseline, mode: 'fixture-replay'});
    const result = evaluate(evidence, BASELINE);

    expect(result.gate).toEqual({
      insufficiencies: ['sealed fixture replay is not production release evidence'],
      qualityFailures: [],
      status: 'unknown',
    });
    expect(
      EffectArray.map(result.metrics, item => [
        item.id,
        item.delta.state,
        item.delta.state === 'observed' && item.delta.classification,
      ]),
    ).toEqual([
      ['time-to-first-cited-correct-plan', 'observed', 'improved'],
      ['estimated-tokens-to-first-cited-correct-plan', 'observed', 'improved'],
      ['setup-success-rate', 'not-applicable', false],
      ['wrong-memory-rate', 'observed', 'improved'],
      ['second-agent-reuse-rate', 'not-applicable', false],
      ['knowledge-delta-completion-rate', 'not-applicable', false],
      ['health-resolution-rate', 'not-applicable', false],
    ]);
    expect(EffectArray.every(result.metrics, item => item.thresholdPassed === true)).toBe(true);
    expect(result.gate.qualityFailures).toEqual([]);
  });

  it('keeps candidate threshold failures dominant when trusted baseline lanes are not applicable', () => {
    const baseline: Threadnote5BaselineV1 = {
      observations: observationsFor(BASELINE, 'baseline'),
      source: BASELINE,
      state: 'available',
    };
    const failing = rewriteScenarioMeasurements(
      evidenceBundle({baseline, mode: 'fixture-replay'}),
      'solo',
      measurement =>
        measurement.id === 'setup-success-rate' && 'eligibleCount' in measurement
          ? {...measurement, positiveCount: 8}
          : measurement,
    );
    const result = evaluate(failing, BASELINE);

    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.metrics, item => item.id === 'setup-success-rate')),
    ).toMatchObject({
      baseline: {state: 'not-applicable'},
      delta: {state: 'not-applicable'},
      thresholdPassed: false,
    });
    expect(result.gate.status).toBe('failed');
    expect(result.gate.qualityFailures).toContain('candidate metric setup-success-rate misses its minimum threshold');
  });

  it('keeps malformed retained receipt inputs unknown', () => {
    const baseline: Threadnote5BaselineV1 = {
      observations: observationsFor(BASELINE, 'baseline'),
      source: BASELINE,
      state: 'available',
    };
    const evidence = evidenceBundle({baseline, mode: 'release-candidate'});
    const records = [{}];
    const result = evaluateWithManifest(evidence, evidence.capture.manifestHash, BASELINE, records);

    expect(result.gate).toMatchObject({
      insufficiencies: ['production subsystem receipt verification is records-invalid'],
      status: 'failed',
    });
    expect(result.evidence.productionReceiptVerification).toMatchObject({reason: 'records-invalid', state: 'unknown'});

    expect(
      verifyThreadnote5LocalSubsystemReceipts({
        candidate: CANDIDATE,
        observations: evidence.candidateObservations,
        retainedRecords: [...records].reverse(),
      }),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});
  });

  it('requires at least 9 successful activation attempts out of the 10-attempt minimum', () => {
    const sufficient = rewriteScenarioMeasurements(
      evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'}),
      'solo',
      measurement =>
        measurement.id === 'setup-success-rate' && 'eligibleCount' in measurement
          ? {...measurement, positiveCount: 9}
          : measurement,
    );
    const sufficientResult = evaluate(sufficient);

    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(sufficientResult.scenarios, item => item.id === 'solo'))?.state,
    ).toBe('passed');
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(sufficientResult.metrics, item => item.id === 'setup-success-rate'),
      ),
    ).toMatchObject({
      candidate: {state: 'observed', value: 0.9},
      thresholdPassed: true,
    });

    const belowThreshold = rewriteScenarioMeasurements(sufficient, 'solo', measurement =>
      measurement.id === 'setup-success-rate' && 'eligibleCount' in measurement
        ? {...measurement, positiveCount: 8}
        : measurement,
    );
    const belowThresholdResult = evaluate(belowThreshold);

    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(belowThresholdResult.scenarios, item => item.id === 'solo'))
        ?.state,
    ).toBe('passed');
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(belowThresholdResult.metrics, item => item.id === 'setup-success-rate'),
      ),
    ).toMatchObject({
      candidate: {state: 'observed', value: 0.8},
      thresholdPassed: false,
    });
    expect(belowThresholdResult.gate.status).toBe('failed');
  });

  it('keeps every undersized metric contribution unknown even when its apparent value passes', () => {
    fc.assert(
      fc.property(fc.integer({max: 9, min: 1}), eligibleCount => {
        const undersized = rewriteScenarioMeasurements(
          evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'}),
          'solo',
          measurement => {
            if ('sampleCount' in measurement) {
              const perSample = measurement.total / measurement.sampleCount;
              return {...measurement, sampleCount: eligibleCount, total: perSample * eligibleCount};
            }
            return {
              ...measurement,
              eligibleCount,
              positiveCount: measurement.id === 'wrong-memory-rate' ? 0 : eligibleCount,
            };
          },
        );
        const result = evaluate(undersized);
        const soloMetricIds = new Set(
          EffectOption.getOrUndefined(EffectArray.findFirst(fixture.scenarios, item => item.id === 'solo'))!.metricIds,
        );

        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(result.scenarios, item => item.id === 'solo'))?.state,
        ).toBe('unknown');
        expect(
          EffectArray.every(
            EffectArray.filter(result.metrics, metric => soloMetricIds.has(metric.id)),
            metric => metric.candidate.state === 'unknown' && metric.thresholdPassed === null,
          ),
        ).toBe(true);
        expect(result.gate.status).toBe('failed');
        expect(result.gate.qualityFailures).toContain('candidate scenario solo is unknown');
      }),
      {numRuns: 25},
    );
  });

  it('keeps unrelated candidate lanes observed when exactly one scenario lane is undersized', () => {
    const undersized = rewriteScenarioMeasurements(
      evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'}),
      'solo',
      measurement =>
        measurement.id === 'setup-success-rate' && 'eligibleCount' in measurement
          ? {...measurement, eligibleCount: 9, positiveCount: 9}
          : measurement,
    );
    const result = evaluate(undersized);

    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.scenarios, item => item.id === 'solo'))?.state,
    ).toBe('unknown');
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.metrics, item => item.id === 'setup-success-rate')),
    ).toMatchObject({
      candidate: {reason: 'source-incomplete', state: 'unknown'},
      thresholdPassed: null,
    });
    expect(
      EffectArray.every(
        EffectArray.filter(result.metrics, metric =>
          [
            'time-to-first-cited-correct-plan',
            'estimated-tokens-to-first-cited-correct-plan',
            'wrong-memory-rate',
          ].includes(metric.id),
        ),
        metric => metric.candidate.state === 'observed',
      ),
    ).toBe(true);
  });

  it('keeps unrelated trusted-baseline lanes observed when exactly one baseline lane is undersized', () => {
    const baseline: Threadnote5BaselineV1 = {
      observations: observationsFor(BASELINE, 'baseline'),
      source: BASELINE,
      state: 'available',
    };
    const evidence = rewriteBaselineScenarioMeasurements(
      evidenceBundle({baseline, mode: 'fixture-replay'}),
      'solo',
      measurement =>
        measurement.id === 'time-to-first-cited-correct-plan' && 'sampleCount' in measurement
          ? {...measurement, sampleCount: 9, total: (measurement.total / measurement.sampleCount) * 9}
          : measurement,
    );
    const result = evaluate(evidence, BASELINE);

    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(result.metrics, item => item.id === 'time-to-first-cited-correct-plan'),
      ),
    ).toMatchObject({
      baseline: {reason: 'source-incomplete', state: 'unknown'},
      delta: {reason: 'source-incomplete', state: 'unknown'},
    });
    expect(
      EffectArray.every(
        EffectArray.filter(
          result.metrics,
          metric =>
            metric.id !== 'time-to-first-cited-correct-plan' &&
            isOneOf(metric.id, THREADNOTE_5_BASELINE_COMPARABLE_METRICS),
        ),
        metric => metric.baseline.state === 'observed' && metric.delta.state === 'observed',
      ),
    ).toBe(true);
    expect(
      EffectArray.every(
        EffectArray.filter(result.metrics, metric => isOneOf(metric.id, THREADNOTE_5_BASELINE_NOT_APPLICABLE_METRICS)),
        metric => metric.baseline.state === 'not-applicable' && metric.delta.state === 'not-applicable',
      ),
    ).toBe(true);
    expect(result.gate.insufficiencies).toContain('4.7.8 baseline metric is unknown: time-to-first-cited-correct-plan');
  });

  it('withholds every comparison when the baseline identity is absent or mismatched', () => {
    const baseline: Threadnote5BaselineV1 = {
      observations: observationsFor(BASELINE, 'baseline'),
      source: BASELINE,
      state: 'available',
    };
    const evidence = evidenceBundle({baseline, mode: 'fixture-replay'});
    for (const expectedBaselineSource of [
      undefined,
      {...BASELINE, executableSha256: Effect.pipe('9', EffectString.repeat(64))},
    ]) {
      const result = evaluate(evidence, expectedBaselineSource);
      expect(
        EffectArray.every(
          EffectArray.filter(result.metrics, metric => isOneOf(metric.id, THREADNOTE_5_BASELINE_COMPARABLE_METRICS)),
          metric => metric.baseline.state === 'unknown' && metric.delta.state === 'unknown',
        ),
      ).toBe(true);
      expect(result.gate.insufficiencies).toContain(
        '4.7.8 baseline does not match its trusted identity, executable, and ledger',
      );
    }
  });

  it('rejects any baseline release other than exact Threadnote 4.7.8', () => {
    for (const source of [
      {...BASELINE, commit: Effect.pipe('8', EffectString.repeat(40))},
      {...BASELINE, version: '4.7.7'},
      {...BASELINE, version: '4.7.9'},
    ]) {
      expect(() => parseThreadnote5TrustedSourceV1(source, 'baseline')).toThrow(/exact 4\.7\.8 release/u);
    }
  });

  it('requires an independently supplied 4.7 trial-ledger hash when a ledger is requested', () => {
    const baseline: Threadnote5BaselineV1 = {
      observations: observationsFor(BASELINE, 'baseline'),
      source: BASELINE,
      state: 'available',
    };
    const evidence = evidenceBundle({baseline, mode: 'fixture-replay'});
    const ledger = threadnote5BaselineTrialLedger(baseline.source, baseline.observations);
    const trusted = evaluateThreadnote5ReleaseReadiness({
      baselineTrialLedger: ledger,
      evidence,
      expectedBaselineSource: BASELINE,
      expectedBaselineTrialLedgerSha256: threadnote5BaselineTrialLedgerHash(ledger),
      expectedCandidateCommit: CANDIDATE.commit,
      expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
      expectedCaptureManifestSha256: evidence.capture.manifestHash,
      fixture,
    });
    expect(
      EffectArray.every(
        EffectArray.filter(trusted.metrics, metric => isOneOf(metric.id, THREADNOTE_5_BASELINE_COMPARABLE_METRICS)),
        metric => metric.baseline.state === 'observed' && metric.delta.state === 'observed',
      ),
    ).toBe(true);
    expect(
      EffectArray.every(
        EffectArray.filter(trusted.metrics, metric => isOneOf(metric.id, THREADNOTE_5_BASELINE_NOT_APPLICABLE_METRICS)),
        metric => metric.baseline.state === 'not-applicable' && metric.delta.state === 'not-applicable',
      ),
    ).toBe(true);

    const missing = evaluateThreadnote5ReleaseReadiness({
      evidence,
      expectedBaselineSource: BASELINE,
      expectedCandidateCommit: CANDIDATE.commit,
      expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
      expectedCaptureManifestSha256: evidence.capture.manifestHash,
      fixture,
    });
    expect(
      EffectArray.every(
        EffectArray.filter(missing.metrics, metric => isOneOf(metric.id, THREADNOTE_5_BASELINE_COMPARABLE_METRICS)),
        metric => metric.baseline.state === 'unknown',
      ),
    ).toBe(true);

    const untrusted = evaluateThreadnote5ReleaseReadiness({
      baselineTrialLedger: ledger,
      evidence,
      expectedBaselineSource: BASELINE,
      expectedBaselineTrialLedgerSha256: Effect.pipe('f', EffectString.repeat(64)),
      expectedCandidateCommit: CANDIDATE.commit,
      expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
      expectedCaptureManifestSha256: evidence.capture.manifestHash,
      fixture,
    });
    expect(
      EffectArray.every(
        EffectArray.filter(untrusted.metrics, metric => isOneOf(metric.id, THREADNOTE_5_BASELINE_COMPARABLE_METRICS)),
        metric => metric.baseline.state === 'unknown',
      ),
    ).toBe(true);
  });

  it('canonicalizes baseline observation and common-measurement ordering before hashing', () => {
    const observations = observationsFor(BASELINE, 'baseline');
    const expected = threadnote5BaselineTrialLedger(BASELINE, observations);
    const expectedHash = threadnote5BaselineTrialLedgerHash(expected);
    expect(
      new Set(
        EffectArray.flatMap(expected.observations, observation =>
          EffectArray.map(observation.measurements, item => item.id),
        ),
      ),
    ).toEqual(new Set(THREADNOTE_5_BASELINE_COMPARABLE_METRICS));
    expect(
      EffectArray.every(
        EffectArray.filter(
          EffectArray.flatMap(expected.observations, observation => observation.measurements),
          measurement => measurement.id === 'wrong-memory-rate',
        ),
        measurement => 'eligibleCount' in measurement && 'positiveCount' in measurement,
      ),
    ).toBe(true);

    fc.assert(
      fc.property(
        fc.shuffledSubarray([...observations.keys()], {
          minLength: observations.length,
          maxLength: observations.length,
        }),
        fc.boolean(),
        (order, reverseMeasurements) => {
          const reordered = EffectArray.map(order, index => {
            const observation = observations[index];
            return reverseMeasurements
              ? {
                  ...observation,
                  transcript: {
                    ...observation.transcript,
                    measurements: [...observation.transcript.measurements].reverse(),
                  },
                }
              : observation;
          });
          const actual = threadnote5BaselineTrialLedger(BASELINE, reordered);
          expect(actual).toEqual(expected);
          expect(threadnote5BaselineTrialLedgerHash(actual)).toBe(expectedHash);
        },
      ),
      {numRuns: 50},
    );
  });

  it('rejects Threadnote 5-only metrics from an externally supplied baseline ledger', () => {
    const ledger = threadnote5BaselineTrialLedger(BASELINE, observationsFor(BASELINE, 'baseline'));
    const incompatible = {
      ...ledger,
      observations: EffectArray.map(ledger.observations, (observation, index) =>
        index === 0
          ? {
              ...observation,
              measurements: [{eligibleCount: 1, id: 'setup-success-rate', positiveCount: 1}],
            }
          : observation,
      ),
    };

    expect(() => threadnote5BaselineTrialLedgerHash(incompatible)).toThrow(
      /metric is not comparable with Threadnote 4\.7\.8/u,
    );
  });

  it('fails closed when a candidate scenario is missing', () => {
    const original = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    const candidateObservations = rechainObservations(
      EffectArray.filter(original.candidateObservations, item => item.scenario !== 'dirty-worktree'),
    );
    const incomplete = resealEvidence({...withoutEvidenceHash(original), candidateObservations});
    const result = evaluate(incomplete);

    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.scenarios, item => item.id === 'dirty-worktree'))?.state,
    ).toBe('missing');
    expect(result.gate.status).toBe('failed');
    expect(result.gate.qualityFailures).toContain('candidate scenario dirty-worktree is missing');
  });

  it('rejects tampered transcripts, runtime drift, and scenario-mislabeled attestations', () => {
    const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    const first = evidence.candidateObservations[0];
    const tamperedObservation = {
      ...first,
      transcript: {
        ...first.transcript,
        measurements: EffectArray.map(first.transcript.measurements, (measurement, index) =>
          index === 0 && 'total' in measurement ? {...measurement, total: measurement.total + 1} : measurement,
        ),
      },
    };
    expect(() =>
      parseThreadnote5ReleaseEvidenceV1(
        resealEvidence({
          ...withoutEvidenceHash(evidence),
          candidateObservations: [tamperedObservation, ...evidence.candidateObservations.slice(1)],
        }),
        fixture,
      ),
    ).toThrow(/transcript digest does not match/u);

    const driftedBase = {
      ...withoutReceiptHash(first),
      attestation: {
        ...first.attestation,
        postRuntime: {...first.attestation.postRuntime, executableSha256: Effect.pipe('9', EffectString.repeat(64))},
      },
    };
    const drifted = {...driftedBase, receiptHash: threadnote5ObservationReceiptHash(driftedBase)};
    expect(() =>
      parseThreadnote5ReleaseEvidenceV1(
        resealEvidence({
          ...withoutEvidenceHash(evidence),
          candidateObservations: [drifted, ...evidence.candidateObservations.slice(1)],
        }),
        fixture,
      ),
    ).toThrow(/post-run runtime does not match/u);

    const mislabeledBase = {...withoutReceiptHash(first), scenario: 'two-agent' as const};
    const mislabeled = {...mislabeledBase, receiptHash: threadnote5ObservationReceiptHash(mislabeledBase)};
    expect(() =>
      parseThreadnote5ReleaseEvidenceV1(
        resealEvidence({
          ...withoutEvidenceHash(evidence),
          candidateObservations: [mislabeled, ...evidence.candidateObservations.slice(1)],
        }),
        fixture,
      ),
    ).toThrow(/transcript assertions are mislabeled/u);
  });

  it('withholds candidate metrics when a self-consistent rewritten manifest is not independently trusted', () => {
    const original = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    const originalTrustedHash = original.capture.manifestHash;
    const first = original.candidateObservations[0];
    const transcript = {
      ...first.transcript,
      measurements: EffectArray.map(first.transcript.measurements, measurement =>
        'total' in measurement ? {...measurement, total: measurement.total + measurement.sampleCount} : measurement,
      ),
    };
    const transcriptDigest = threadnote5ObservationTranscriptHash(transcript);
    const base = {
      ...withoutReceiptHash(first),
      attestation: {...first.attestation, transcriptDigest},
      transcript,
    };
    const rewritten = {...base, receiptHash: threadnote5ObservationReceiptHash(base)};
    const candidateObservations = rechainObservations([rewritten, ...original.candidateObservations.slice(1)]);
    const relabeled = resealEvidence({...withoutEvidenceHash(original), candidateObservations});
    const result = evaluateWithManifest(relabeled, originalTrustedHash);

    expect(result.evidence.captureManifestTrusted).toBe(false);
    expect(EffectArray.every(result.metrics, metric => metric.candidate.state === 'unknown')).toBe(true);
    expect(
      EffectArray.every(
        EffectArray.filter(result.metrics, metric => isOneOf(metric.id, THREADNOTE_5_BASELINE_COMPARABLE_METRICS)),
        metric => metric.delta.state === 'unknown',
      ),
    ).toBe(true);
    expect(
      EffectArray.every(
        EffectArray.filter(result.metrics, metric => isOneOf(metric.id, THREADNOTE_5_BASELINE_NOT_APPLICABLE_METRICS)),
        metric => metric.delta.state === 'not-applicable',
      ),
    ).toBe(true);
    expect(result.gate.qualityFailures).toContain('capture manifest does not match the trusted expected hash');
  });

  it('rejects content-bearing fields and inexact candidate versions', () => {
    const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    expect(() => parseThreadnote5ReleaseEvidenceV1({...evidence, rawLog: 'forbidden'}, fixture)).toThrow(
      /unsupported or missing fields/u,
    );
    expect(() =>
      parseThreadnote5ReleaseEvidenceV1(
        {
          ...evidence,
          candidate: {...evidence.candidate, version: '5.0.0-local'},
        },
        fixture,
      ),
    ).toThrow(/candidate version is invalid/u);
  });

  it('has order-independent deterministic evidence hashes', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...fixture.scenarios.keys()], {
          minLength: fixture.scenarios.length,
          maxLength: fixture.scenarios.length,
        }),
        order => {
          const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
          const reordered = EffectArray.map(order, index => evidence.candidateObservations[index]);
          expect(
            threadnote5ReleaseEvidenceHash({...withoutEvidenceHash(evidence), candidateObservations: reordered}),
          ).toBe(evidence.evidenceHash);
          expect(parseThreadnote5ReleaseEvidenceV1({...evidence, candidateObservations: reordered}, fixture)).toEqual(
            evidence,
          );
        },
      ),
      {numRuns: 50},
    );
  });

  it('detects bounded numeric tampering for every measured scenario', () => {
    const measuredOrdinals = EffectArray.flatMap(fixture.scenarios, (scenario, index) =>
      scenario.metricIds.length > 0 ? [index] : [],
    );
    fc.assert(
      fc.property(fc.constantFrom(...measuredOrdinals), index => {
        const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
        const selected = evidence.candidateObservations[index];
        const measurement = selected.transcript.measurements[0];
        const changed =
          'total' in measurement
            ? {...measurement, total: measurement.total + 1}
            : {...measurement, positiveCount: measurement.positiveCount === 0 ? 1 : measurement.positiveCount - 1};
        const tampered = {
          ...evidence,
          candidateObservations: EffectArray.map(evidence.candidateObservations, (item, ordinal) =>
            ordinal === index
              ? {
                  ...item,
                  transcript: {...item.transcript, measurements: [changed, ...item.transcript.measurements.slice(1)]},
                }
              : item,
          ),
        };
        expect(() => parseThreadnote5ReleaseEvidenceV1(tampered, fixture)).toThrow(/transcript digest does not match/u);
      }),
      {numRuns: 50},
    );
  });
});

function evaluate(evidence: Threadnote5ReleaseEvidenceV1, expectedBaselineSource?: unknown) {
  return evaluateWithManifest(evidence, evidence.capture.manifestHash, expectedBaselineSource);
}

function evaluateWithManifest(
  evidence: Threadnote5ReleaseEvidenceV1,
  expectedCaptureManifestSha256: string,
  expectedBaselineSource?: unknown,
  retainedSubsystemReceiptRecords?: unknown,
) {
  const baselineLedger =
    evidence.baseline.state === 'available'
      ? threadnote5BaselineTrialLedger(evidence.baseline.source, evidence.baseline.observations)
      : undefined;
  return evaluateThreadnote5ReleaseReadiness({
    ...(baselineLedger === undefined
      ? {}
      : {
          baselineTrialLedger: baselineLedger,
          expectedBaselineTrialLedgerSha256: threadnote5BaselineTrialLedgerHash(baselineLedger),
        }),
    evidence,
    expectedBaselineSource,
    expectedCandidateCommit: CANDIDATE.commit,
    expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
    expectedCaptureManifestSha256,
    fixture,
    retainedSubsystemReceiptRecords,
  });
}

function evidenceBundle(input: {
  readonly baseline: Threadnote5BaselineV1;
  readonly mode: Threadnote5EvidenceClass;
}): Threadnote5ReleaseEvidenceV1 {
  const fixtureHash = threadnote5ReleaseReadinessFixtureHash(fixture);
  const candidateObservations = observationsFor(CANDIDATE, 'candidate');
  const adapterId =
    input.mode === 'fixture-replay'
      ? ('sealed-fixture-replay-v1' as const)
      : ('threadnote-5-local-task-loop-adapter-v1' as const);
  const manifest = threadnote5CaptureManifestForEvidence({
    adapterId,
    baseline: input.baseline,
    candidateObservations,
    fixtureHash,
    mode: input.mode,
  });
  return sealEvidence({
    baseline: input.baseline,
    candidate: CANDIDATE,
    candidateObservations,
    capture: {manifest, manifestHash: threadnote5CaptureManifestHash(manifest)},
    fixtureHash,
    suite: 'threadnote-5-release-readiness-evidence',
    version: 1,
  });
}

function observationsFor(source: Threadnote5SourceV1, variant: 'baseline' | 'candidate'): Threadnote5ObservationV1[] {
  const sourceHash = threadnote5SourceHash(source);
  let previousTranscriptDigest: string | null = null;
  return EffectArray.map(fixture.scenarios, (contract, index) => {
    const transcript = {
      assertionResults: EffectArray.map(contract.requiredAssertions, id => ({id, observed: true})),
      measurements: EffectArray.map(contract.metricIds, id => measurementFor(id, variant)),
      outcome: 'passed' as const,
      reason: null,
    };
    const transcriptDigest = threadnote5ObservationTranscriptHash(transcript);
    const base = {
      attestation: {
        postRuntime: {executableSha256: source.executableSha256, sourceCommit: source.commit},
        preRuntime: {executableSha256: source.executableSha256, sourceCommit: source.commit},
        previousTranscriptDigest,
        subsystemReceipts: EffectArray.map(contract.subsystems, kind => ({
          digest: sha256HexSync(`${sourceHash}\0${contract.id}\0${kind}`),
          kind,
        })),
        transcriptDigest,
      },
      observationId: `obs_${Effect.pipe(sha256HexSync(`${sourceHash}\0${contract.id}\0${index}`), EffectString.slice(0, 32))}`,
      scenario: contract.id,
      sourceHash,
      transcript,
      version: 1 as const,
    };
    previousTranscriptDigest = transcriptDigest;
    return {...base, receiptHash: threadnote5ObservationReceiptHash(base)};
  });
}

function measurementFor(id: Threadnote5ReleaseMetric, variant: 'baseline' | 'candidate'): Threadnote5MeasurementV1 {
  if (id === 'time-to-first-cited-correct-plan') {
    return {id, sampleCount: 10, total: variant === 'candidate' ? 300_000 : 600_000};
  }
  if (id === 'estimated-tokens-to-first-cited-correct-plan') {
    return {id, sampleCount: 10, total: variant === 'candidate' ? 10_000 : 14_000};
  }
  const positiveCount =
    id === 'wrong-memory-rate'
      ? variant === 'candidate'
        ? 0
        : 1
      : variant === 'candidate'
        ? 10
        : id === 'second-agent-reuse-rate'
          ? 5
          : 8;
  return {eligibleCount: 10, id, positiveCount};
}

function unavailableBaseline(): Threadnote5BaselineV1 {
  return {reason: 'not-captured', sourceFamily: '4.7.x', state: 'unavailable'};
}

function resealEvidence(evidence: Omit<Threadnote5ReleaseEvidenceV1, 'evidenceHash'>): Threadnote5ReleaseEvidenceV1 {
  const manifest = threadnote5CaptureManifestForEvidence({
    adapterId: evidence.capture.manifest.adapterId,
    baseline: evidence.baseline,
    candidateObservations: evidence.candidateObservations,
    fixtureHash: evidence.fixtureHash,
    mode: evidence.capture.manifest.mode,
  });
  return sealEvidence({
    ...evidence,
    capture: {manifest, manifestHash: threadnote5CaptureManifestHash(manifest)},
  });
}

function sealEvidence(evidence: Omit<Threadnote5ReleaseEvidenceV1, 'evidenceHash'>): Threadnote5ReleaseEvidenceV1 {
  return {...evidence, evidenceHash: threadnote5ReleaseEvidenceHash(evidence)};
}

function withoutEvidenceHash(
  evidence: Threadnote5ReleaseEvidenceV1,
): Omit<Threadnote5ReleaseEvidenceV1, 'evidenceHash'> {
  const {evidenceHash: _, ...rest} = evidence;
  return rest;
}

function withoutReceiptHash(observation: Threadnote5ObservationV1): Omit<Threadnote5ObservationV1, 'receiptHash'> {
  const {receiptHash: _, ...rest} = observation;
  return rest;
}

function rewriteScenarioMeasurements(
  evidence: Threadnote5ReleaseEvidenceV1,
  scenario: Threadnote5ObservationV1['scenario'],
  rewrite: (measurement: Threadnote5MeasurementV1) => Threadnote5MeasurementV1,
): Threadnote5ReleaseEvidenceV1 {
  const candidateObservations = rewriteObservationMeasurements(evidence.candidateObservations, scenario, rewrite);
  return resealEvidence({...withoutEvidenceHash(evidence), candidateObservations});
}

function rewriteBaselineScenarioMeasurements(
  evidence: Threadnote5ReleaseEvidenceV1,
  scenario: Threadnote5ObservationV1['scenario'],
  rewrite: (measurement: Threadnote5MeasurementV1) => Threadnote5MeasurementV1,
): Threadnote5ReleaseEvidenceV1 {
  if (evidence.baseline.state !== 'available') throw new Error('test baseline must be available');
  const baseline = {
    ...evidence.baseline,
    observations: rewriteObservationMeasurements(evidence.baseline.observations, scenario, rewrite),
  };
  return resealEvidence({...withoutEvidenceHash(evidence), baseline});
}

function rewriteObservationMeasurements(
  observations: readonly Threadnote5ObservationV1[],
  scenario: Threadnote5ObservationV1['scenario'],
  rewrite: (measurement: Threadnote5MeasurementV1) => Threadnote5MeasurementV1,
): Threadnote5ObservationV1[] {
  return rechainObservations(
    EffectArray.map(observations, observation => {
      if (observation.scenario !== scenario) return observation;
      const transcript = {
        ...observation.transcript,
        measurements: EffectArray.map(observation.transcript.measurements, rewrite),
      };
      const base = {
        ...withoutReceiptHash(observation),
        attestation: {
          ...observation.attestation,
          transcriptDigest: threadnote5ObservationTranscriptHash(transcript),
        },
        transcript,
      };
      return {...base, receiptHash: threadnote5ObservationReceiptHash(base)};
    }),
  );
}

function rechainObservations(observations: readonly Threadnote5ObservationV1[]): Threadnote5ObservationV1[] {
  let previousTranscriptDigest: string | null = null;
  return EffectArray.map(observations, observation => {
    const base = {
      ...withoutReceiptHash(observation),
      attestation: {...observation.attestation, previousTranscriptDigest},
    };
    previousTranscriptDigest = observation.attestation.transcriptDigest;
    return {...base, receiptHash: threadnote5ObservationReceiptHash(base)};
  });
}
