import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {describe, expect, it} from 'vitest';

const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const GitCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u));

const HistoricalObservation = Schema.Struct({
  archiveSha256: Sha256,
  artifactId: PositiveInteger,
  hotExactLexicalQueryP95Milliseconds: PositiveFinite,
  runId: PositiveInteger,
});

const SequenceObservation = Schema.Struct({
  createdAt: IsoInstant,
  hotExactLexicalQueryP95Milliseconds: PositiveFinite,
  hotQueryProcessCpuP95Milliseconds: PositiveFinite,
  mcpImpactP95Milliseconds: PositiveFinite,
  oneFileReindexMaterializationP95Milliseconds: PositiveFinite,
  payloadSha256: Sha256,
  role: Schema.Union([
    Schema.Literal('screening-candidate'),
    Schema.Literal('protected-base-control'),
    Schema.Literal('confirmatory-candidate'),
  ]),
});

const calibration = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      artifact: Schema.Struct({
        archiveSha256: Sha256,
        id: PositiveInteger,
        jobId: PositiveInteger,
        name: Schema.Literal('code-graph-production-ratchet-Linux-X64'),
        runId: PositiveInteger,
      }),
      candidate: Schema.Struct({
        headCommit: GitCommit,
        measuredMergeCommit: GitCommit,
        protectedBaseCommit: GitCommit,
      }),
      historicalHostedObservations: Schema.Array(HistoricalObservation),
      historicalHostedSummary: Schema.Struct({
        count: PositiveInteger,
        maximumMilliseconds: PositiveFinite,
        minimumMilliseconds: PositiveFinite,
        upperMiddleMilliseconds: PositiveFinite,
      }),
      observations: Schema.Array(SequenceObservation),
      policy: Schema.Struct({
        absoluteToleranceMillisecondsMaximum: PositiveFinite,
        confirmatoryObservedExcessMilliseconds: PositiveFinite,
        confirmatoryObservedExcessRatio: PositiveFinite,
        confirmatoryTailAllowancesMaximum: Schema.Literal(1),
        hardObjectivesEligible: Schema.Literal(false),
        relativeToleranceRatioMaximum: PositiveFinite,
        staticHotExactLexicalQueryP95MillisecondsMaximum: PositiveFinite,
        staticHotQueryProcessCpuP95MillisecondsMaximum: PositiveFinite,
        staticMcpImpactP95MillisecondsMaximum: PositiveFinite,
        staticOneFileReindexMaterializationP95MillisecondsMaximum: PositiveFinite,
      }),
      priorDiscriminatingFailure: Schema.Struct({
        archiveSha256: Sha256,
        artifactId: PositiveInteger,
        confirmatoryExcessMilliseconds: PositiveFinite,
        confirmatoryExcessRatio: PositiveFinite,
        confirmatoryHotExactLexicalQueryP95Milliseconds: PositiveFinite,
        controlHotExactLexicalQueryP95Milliseconds: PositiveFinite,
        jobId: PositiveInteger,
        runId: PositiveInteger,
        screeningHotExactLexicalQueryP95Milliseconds: PositiveFinite,
      }),
      runner: Schema.Struct({
        architecture: Schema.Literal('x64'),
        class: Schema.Literal('github-hosted-linux-x64'),
        identity: Schema.String,
        sameRunnerComparisonKey: Schema.String,
      }),
      type: Schema.Literal('code-graph-production-ratchet-paired-wall-calibration'),
      version: Schema.Literal(1),
    }),
  ),
)(
  await Bun.file(
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/production-ratchet-linux-paired-wall-calibration-v1.json',
  ).text(),
);

describe('hosted Linux production-ratchet paired-wall calibration', () => {
  it('retains reproducible historical and candidate-control-candidate evidence', () => {
    const historical = calibration.historicalHostedObservations;
    const values = EffectArray.map(historical, observation => observation.hotExactLexicalQueryP95Milliseconds).sort(
      (a, b) => a - b,
    );

    expect(historical).toHaveLength(calibration.historicalHostedSummary.count);
    expect(new Set(EffectArray.map(historical, observation => observation.runId)).size).toBe(historical.length);
    expect(new Set(EffectArray.map(historical, observation => observation.artifactId)).size).toBe(historical.length);
    expect(new Set(EffectArray.map(historical, observation => observation.archiveSha256)).size).toBe(historical.length);
    expect(Math.min(...values)).toBe(calibration.historicalHostedSummary.minimumMilliseconds);
    expect(Math.max(...values)).toBe(calibration.historicalHostedSummary.maximumMilliseconds);
    expect(values[Math.floor(values.length / 2)]).toBe(calibration.historicalHostedSummary.upperMiddleMilliseconds);
    expect(EffectArray.map(calibration.observations, observation => observation.role)).toEqual([
      'screening-candidate',
      'protected-base-control',
      'confirmatory-candidate',
    ]);
  });

  it('admits only the observed tiny confirmatory tail and rejects the discriminating prior failure', () => {
    const [screening, control, confirmatory] = calibration.observations;
    expect(screening).toBeDefined();
    expect(control).toBeDefined();
    expect(confirmatory).toBeDefined();
    if (screening === undefined || control === undefined || confirmatory === undefined) return;

    const policy = calibration.policy;
    const tolerance = Math.min(
      policy.staticHotExactLexicalQueryP95MillisecondsMaximum * policy.relativeToleranceRatioMaximum,
      policy.absoluteToleranceMillisecondsMaximum,
    );
    const toleratedMaximum = policy.staticHotExactLexicalQueryP95MillisecondsMaximum + tolerance;

    expect(screening.mcpImpactP95Milliseconds).toBeGreaterThan(policy.staticMcpImpactP95MillisecondsMaximum);
    expect(control.mcpImpactP95Milliseconds).toBeLessThan(policy.staticMcpImpactP95MillisecondsMaximum);
    expect(confirmatory.mcpImpactP95Milliseconds).toBeLessThan(policy.staticMcpImpactP95MillisecondsMaximum);
    expect(screening.oneFileReindexMaterializationP95Milliseconds).toBeGreaterThan(
      policy.staticOneFileReindexMaterializationP95MillisecondsMaximum,
    );
    expect(control.oneFileReindexMaterializationP95Milliseconds).toBeLessThan(
      policy.staticOneFileReindexMaterializationP95MillisecondsMaximum,
    );
    expect(confirmatory.oneFileReindexMaterializationP95Milliseconds).toBeLessThan(
      policy.staticOneFileReindexMaterializationP95MillisecondsMaximum,
    );
    expect(confirmatory.hotExactLexicalQueryP95Milliseconds).toBeLessThanOrEqual(toleratedMaximum);
    expect(confirmatory.hotQueryProcessCpuP95Milliseconds).toBeLessThan(
      policy.staticHotQueryProcessCpuP95MillisecondsMaximum,
    );
    expect(calibration.priorDiscriminatingFailure.confirmatoryHotExactLexicalQueryP95Milliseconds).toBeGreaterThan(
      toleratedMaximum,
    );
    expect(policy.confirmatoryTailAllowancesMaximum).toBe(1);
    expect(policy.hardObjectivesEligible).toBe(false);
  });
});
