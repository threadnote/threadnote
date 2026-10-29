import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_TELEMETRY_CRITICAL_FACT_REPLAY_BYTES,
  CODE_GRAPH_TELEMETRY_CRITICAL_REWRITE_AMPLIFICATION,
  CODE_GRAPH_TELEMETRY_HIGH_FACT_REPLAY_BYTES,
  CODE_GRAPH_TELEMETRY_HIGH_REWRITE_AMPLIFICATION,
  codeGraphBuildAnonymousTelemetryFields,
  codeGraphPowerOfTwoBucket,
  type CodeGraphBuildAnonymousTelemetryInput,
  type CodeGraphBuildEfficiencyClass,
} from '@threadnote/graph/build/anonymous_telemetry';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('code graph terminal anonymous telemetry', () => {
  it('classifies the ineffective two-file rematerialization incident as critical', () => {
    expect(
      codeGraphBuildAnonymousTelemetryFields({
        buildKind: 'dirty',
        cachedFactReplayBytes: 3.1 * 1_024 * 1_024 * 1_024,
        changedFactBytes: 120 * 1_024,
        changedFiles: 2,
        deletedFiles: 0,
        extractedFiles: 2,
        fallbackReason: 'resolution-surface-changed',
        finalFactBytes: 3.2 * 1_024 * 1_024 * 1_024,
        mode: 'full',
        reusedFiles: 55_057,
        stagedFiles: 55_059,
        totalFiles: 55_059,
      }),
    ).toEqual({
      buildKind: 'dirty',
      cachedFactReplayBytesBucket: '2^31',
      changedFactBytesBucket: '2^16',
      changedFilesBucket: '2^1',
      deletedFilesBucket: '0',
      deltaFilesBucket: '2^1',
      efficiencyClass: 'critical-amplification-full',
      extractedFilesBucket: '2^1',
      factReplayAmplificationBucket: '2^14',
      fallbackReason: 'resolution-surface-changed',
      finalFactBytesBucket: '2^31',
      mode: 'full',
      resolutionClosure: 'full',
      reusedFilesBucket: '2^15',
      rewriteAmplificationBucket: '2^14',
      stagedFilesBucket: '2^15',
      totalFilesBucket: '2^15',
    });
  });

  it('keeps explicit and ordinary full builds distinct from suspicious small deltas', () => {
    const dirtyFull = {
      buildKind: 'dirty',
      cachedFactReplayBytes: 0,
      changedFiles: 1,
      mode: 'full',
      stagedFiles: CODE_GRAPH_TELEMETRY_HIGH_REWRITE_AMPLIFICATION - 1,
    } satisfies CodeGraphBuildAnonymousTelemetryInput;

    expect(codeGraphBuildAnonymousTelemetryFields(dirtyFull).efficiencyClass).toBe('small-delta-full');
    expect(
      codeGraphBuildAnonymousTelemetryFields({
        ...dirtyFull,
        stagedFiles: CODE_GRAPH_TELEMETRY_HIGH_REWRITE_AMPLIFICATION,
      }).efficiencyClass,
    ).toBe('high-amplification-full');
    expect(
      codeGraphBuildAnonymousTelemetryFields({
        ...dirtyFull,
        cachedFactReplayBytes: CODE_GRAPH_TELEMETRY_CRITICAL_FACT_REPLAY_BYTES,
        stagedFiles: CODE_GRAPH_TELEMETRY_CRITICAL_REWRITE_AMPLIFICATION,
      }).efficiencyClass,
    ).toBe('critical-amplification-full');
    expect(
      codeGraphBuildAnonymousTelemetryFields({
        ...dirtyFull,
        cachedFactReplayBytes: CODE_GRAPH_TELEMETRY_CRITICAL_FACT_REPLAY_BYTES - 1,
        stagedFiles: CODE_GRAPH_TELEMETRY_CRITICAL_REWRITE_AMPLIFICATION,
      }).efficiencyClass,
    ).toBe('high-amplification-full');
    expect(
      codeGraphBuildAnonymousTelemetryFields({
        ...dirtyFull,
        cachedFactReplayBytes: CODE_GRAPH_TELEMETRY_HIGH_FACT_REPLAY_BYTES,
      }).efficiencyClass,
    ).toBe('high-amplification-full');
    expect(
      codeGraphBuildAnonymousTelemetryFields({...dirtyFull, fallbackReason: 'forced-full-rebuild'}).efficiencyClass,
    ).toBe('expected-full');
    expect(codeGraphBuildAnonymousTelemetryFields({...dirtyFull, fallbackReason: 'disabled'}).efficiencyClass).toBe(
      'expected-full',
    );
    expect(codeGraphBuildAnonymousTelemetryFields({...dirtyFull, buildKind: 'clean'}).efficiencyClass).toBe(
      'expected-full',
    );
    expect(codeGraphBuildAnonymousTelemetryFields({...dirtyFull, changedFiles: 9}).efficiencyClass).toBe('full');
    expect(codeGraphBuildAnonymousTelemetryFields({...dirtyFull, mode: 'incremental-overlay'}).efficiencyClass).toBe(
      'incremental',
    );
  });

  it('clamps missing denominators to one so observed replay and rewriting remain visible', () => {
    const projected = codeGraphBuildAnonymousTelemetryFields({
      buildKind: 'dirty',
      cachedFactReplayBytes: 1_024,
      mode: 'full',
      stagedFiles: 2_048,
    });

    expect(projected.rewriteAmplificationBucket).toBe('2^11');
    expect(projected.factReplayAmplificationBucket).toBe('2^10');
    expect(projected.changedFactBytesBucket).toBe('0');
    expect(projected.deltaFilesBucket).toBe('0');
  });

  it('is noninterfering under arbitrary repository-derived paths and names', () => {
    fc.assert(
      fc.property(
        buildEvidenceArbitrary,
        privateRepositoryFieldsArbitrary,
        privateRepositoryFieldsArbitrary,
        (evidence, firstPrivate, secondPrivate) => {
          expect(
            codeGraphBuildAnonymousTelemetryFields({
              ...evidence,
              ...firstPrivate,
            }),
          ).toEqual(
            codeGraphBuildAnonymousTelemetryFields({
              ...evidence,
              ...secondPrivate,
            }),
          );
        },
      ),
      {numRuns: 128},
    );
  });

  it('buckets nonnegative quantities monotonically and caps the public vocabulary', () => {
    fc.assert(
      fc.property(fc.nat({max: Number.MAX_SAFE_INTEGER}), fc.nat({max: Number.MAX_SAFE_INTEGER}), (first, second) => {
        const [lower, upper] = first <= second ? [first, second] : [second, first];
        expect(bucketExponent(codeGraphPowerOfTwoBucket(lower))).toBeLessThanOrEqual(
          bucketExponent(codeGraphPowerOfTwoBucket(upper)),
        );
      }),
      {numRuns: 128},
    );
    expect(codeGraphPowerOfTwoBucket(Number.MAX_SAFE_INTEGER)).toBe('2^52');
    expect(codeGraphPowerOfTwoBucket(Number.POSITIVE_INFINITY)).toBe('0');
    expect(codeGraphPowerOfTwoBucket(-1)).toBe('0');
  });

  it('never lowers incident severity as rewrite or replay evidence grows', () => {
    fc.assert(
      fc.property(
        fc.nat({max: 8}),
        fc.nat({max: 4_096}),
        fc.nat({max: 4_096}),
        fc.nat({max: 2 * 1_024 * 1_024 * 1_024}),
        fc.nat({max: 2 * 1_024 * 1_024 * 1_024}),
        (deltaFiles, firstStaged, secondStaged, firstReplay, secondReplay) => {
          const [lowerStaged, upperStaged] =
            firstStaged <= secondStaged ? [firstStaged, secondStaged] : [secondStaged, firstStaged];
          const [lowerReplay, upperReplay] =
            firstReplay <= secondReplay ? [firstReplay, secondReplay] : [secondReplay, firstReplay];
          const project = (stagedFiles: number, cachedFactReplayBytes: number) =>
            codeGraphBuildAnonymousTelemetryFields({
              buildKind: 'dirty',
              cachedFactReplayBytes,
              changedFiles: deltaFiles,
              mode: 'full',
              stagedFiles,
            }).efficiencyClass;

          expect(efficiencyRank(project(lowerStaged, lowerReplay))).toBeLessThanOrEqual(
            efficiencyRank(project(upperStaged, upperReplay)),
          );
        },
      ),
      {numRuns: 128},
    );
  });
});

const buildEvidenceArbitrary = fc.record({
  buildKind: fc.constantFrom('clean' as const, 'dirty' as const),
  cachedFactReplayBytes: fc.nat({max: Number.MAX_SAFE_INTEGER}),
  changedFactBytes: fc.nat({max: Number.MAX_SAFE_INTEGER}),
  changedFiles: fc.nat({max: 1_000_000}),
  deletedFiles: fc.nat({max: 1_000_000}),
  extractedFiles: fc.nat({max: 1_000_000}),
  fallbackReason: fc.constantFrom('resolution-surface-changed' as const, 'forced-full-rebuild' as const, undefined),
  finalFactBytes: fc.nat({max: Number.MAX_SAFE_INTEGER}),
  mode: fc.constantFrom('full' as const, 'incremental-clean' as const, 'incremental-overlay' as const),
  resolutionClosure: fc.constantFrom('changed' as const, 'full' as const, 'project' as const, undefined),
  reusedFiles: fc.nat({max: 1_000_000}),
  stagedFiles: fc.nat({max: 1_000_000}),
  totalFiles: fc.nat({max: 1_000_000}),
});

const privateRepositoryFieldsArbitrary = fc.record({
  alias: fc.string(),
  path: fc.string(),
  projectName: fc.string(),
  repositoryName: fc.string(),
  symbolName: fc.string(),
});

function bucketExponent(bucket: ReturnType<typeof codeGraphPowerOfTwoBucket>): number {
  return bucket === '0' ? -1 : Number(Effect.pipe(bucket, EffectString.slice(2)));
}

function efficiencyRank(value: CodeGraphBuildEfficiencyClass): number {
  switch (value) {
    case 'small-delta-full':
      return 0;
    case 'high-amplification-full':
      return 1;
    case 'critical-amplification-full':
      return 2;
    case 'expected-full':
    case 'full':
    case 'incremental':
      throw new Error(`Unexpected efficiency class in monotonicity property: ${value}`);
  }
}
