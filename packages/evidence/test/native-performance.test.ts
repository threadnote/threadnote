import {Array as EffectArray, Record as EffectRecord, String as EffectString} from 'effect';
import {describe, expect, it} from 'vitest';
import {benchmarkMeasurement, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {
  nativePerformanceGates,
  validateNativePerformancePairs,
  NATIVE_PERFORMANCE_STAGES,
  parseNativePerformanceCapture,
  type NativePerformanceCapture,
} from '@threadnote/evidence/native-performance';

const artifact: BenchmarkArtifactV1 = {
  version: 1,
  createdAt: '2026-11-08T00:00:00Z',
  suite: 'contract-test',
  warmups: 1,
  environment: {
    architecture: 'arm64',
    commit: EffectString.repeat(40)('a'),
    cpu: 'test',
    dirty: false,
    fixtureHash: 'fixture',
    memoryBytes: 1024,
    node: 'test',
    operatingSystem: 'darwin',
    packageManager: 'bun',
    runner: 'test',
    runnerVersion: '1',
  },
  metadata: {},
  measurements: [
    benchmarkMeasurement('first', 'milliseconds', [10]),
    benchmarkMeasurement(
      'warm',
      'milliseconds',
      Array.from({length: 30}, () => 5),
    ),
    benchmarkMeasurement('rss', 'bytes', [100]),
    benchmarkMeasurement('cpu', 'milliseconds', [20]),
    benchmarkMeasurement('disk', 'bytes', [100]),
  ],
};
const capture: NativePerformanceCapture = {
  version: 1,
  kind: 'diagnostic',
  component: 'vector',
  pair: 1,
  arm: 'baseline',
  configurationHash: EffectString.repeat(64)('b'),
  correctnessDigest: EffectString.repeat(64)('c'),
  identities: {},
  firstUseMeasurement: 'first',
  warmMeasurement: 'warm',
  stages: EffectRecord.fromEntries(
    EffectArray.map(
      NATIVE_PERFORMANCE_STAGES,
      name => [name, {state: 'unavailable' as const, reason: 'No instrumentation seam'}] as const,
    ),
  ),
  limitations: ['Mock inference'],
};

describe('native performance evidence admission', () => {
  it('retains diagnostic evidence while refusing to qualify missing stages or resources', () => {
    expect(parseNativePerformanceCapture(capture, artifact).capture.kind).toBe('diagnostic');
    expect(() => parseNativePerformanceCapture({...capture, kind: 'qualification'}, artifact)).toThrow('process-tree');
    expect(() =>
      parseNativePerformanceCapture(
        {
          ...capture,
          kind: 'qualification',
          processTreePeakRssMeasurement: 'rss',
          cpuMeasurement: 'cpu',
          diskMeasurement: 'disk',
        },
        artifact,
      ),
    ).toThrow('Incomplete');
  });

  it('requires observed stage measurements, correct units and separate first-use', () => {
    expect(() => parseNativePerformanceCapture({...capture, firstUseMeasurement: 'warm'}, artifact)).toThrow(
      'separate',
    );
    expect(() => parseNativePerformanceCapture({...capture, stages: {}}, artifact)).toThrow('stage disclosure');
    expect(() =>
      parseNativePerformanceCapture(
        {
          ...capture,
          stages: {
            ...capture.stages,
            parse: {state: 'measured', measurement: 'rss', boundary: 'parse'},
          },
        },
        artifact,
      ),
    ).toThrow('milliseconds');
  });

  it('rejects dirty source, insufficient queries and duplicate measurement identities', () => {
    expect(() =>
      parseNativePerformanceCapture(
        {...capture, kind: 'qualification'},
        {
          ...artifact,
          environment: {...artifact.environment, dirty: true},
        },
      ),
    ).toThrow('clean exact source');
    expect(() =>
      parseNativePerformanceCapture(
        {...capture, kind: 'qualification'},
        {
          ...artifact,
          measurements: [artifact.measurements[0], benchmarkMeasurement('warm', 'milliseconds', [1])],
        },
      ),
    ).toThrow('30 warm');
    expect(() =>
      parseNativePerformanceCapture(capture, {
        ...artifact,
        measurements: [...artifact.measurements, artifact.measurements[0]],
      }),
    ).toThrow('Duplicate');
  });

  it('refuses insufficient, diagnostic, duplicated or mismatched comparison arms', () => {
    expect(() => validateNativePerformancePairs([], {baselineCommit: 'base', candidateCommit: 'candidate'})).toThrow(
      'three pairs',
    );
    expect(() =>
      validateNativePerformancePairs(
        Array.from({length: 6}, () => ({capture, artifact})),
        {baselineCommit: artifact.environment.commit, candidateCommit: artifact.environment.commit},
      ),
    ).toThrow('Diagnostic');
    const complete = {
      ...capture,
      kind: 'qualification',
      limitations: [],
      stages: EffectRecord.fromEntries(
        EffectArray.map(
          NATIVE_PERFORMANCE_STAGES,
          stage => [stage, {state: 'measured', measurement: 'warm', boundary: 'contract fixture'}] as const,
        ),
      ),
      identities: {fixture: 'f', runtime: 'r', workers: '1', model: 'm', grammar: 'g', boundary: 'b', sampler: 's'},
      processTreePeakRssMeasurement: 'rss',
      cpuMeasurement: 'cpu',
      diskMeasurement: 'disk',
    };
    const inputs = Array.from({length: 6}, (_, index) => ({
      artifact,
      capture: {...complete, pair: Math.floor(index / 2) + 1, arm: index % 2 === 0 ? 'baseline' : 'candidate'},
    }));
    const expected = {baselineCommit: artifact.environment.commit, candidateCommit: artifact.environment.commit};
    expect(validateNativePerformancePairs(inputs, expected).pairs).toBe(3);
    expect(() => validateNativePerformancePairs([...inputs.slice(0, 5), inputs[0]], expected)).toThrow('Duplicate');
    expect(() =>
      validateNativePerformancePairs(
        [
          ...inputs.slice(0, 5),
          {...inputs[5], capture: {...inputs[5].capture, correctnessDigest: EffectString.repeat(64)('d')}},
        ],
        expected,
      ),
    ).toThrow('mismatch');
  });

  it('applies the fixed improvement, regression/noise and memory gates at their boundaries', () => {
    const input = {
      baselinePrimaryP95: 100,
      candidatePrimaryP95: 80,
      baselineSecondaryP95: 20,
      candidateSecondaryP95: 25,
      baselineProcessTreePeakRss: 1000,
      candidateProcessTreePeakRss: 1100,
    };
    expect(nativePerformanceGates(input)).toEqual({primary: true, secondary: true, memory: true});
    expect(
      nativePerformanceGates({
        ...input,
        candidatePrimaryP95: 80.001,
        candidateSecondaryP95: 25.001,
        candidateProcessTreePeakRss: 1100.001,
      }),
    ).toEqual({primary: false, secondary: false, memory: false});
    expect(nativePerformanceGates({...input, baselineSecondaryP95: 1000, candidateSecondaryP95: 1050})).toMatchObject({
      secondary: true,
    });
    expect(() => nativePerformanceGates({...input, baselinePrimaryP95: 0})).toThrow();
    expect(() => nativePerformanceGates({...input, candidatePrimaryP95: Number.NaN})).toThrow();
  });
});
