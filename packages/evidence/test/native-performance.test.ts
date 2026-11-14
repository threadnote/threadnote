import * as FC from 'fast-check';
import {Array as EffectArray, Record as EffectRecord, String as EffectString} from 'effect';
import {describe, expect, it} from 'vitest';
import {benchmarkMeasurement, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {
  NATIVE_VECTOR_PROFILES,
  nativePerformanceGates,
  nativeStagePartition,
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

const pinnedModel = {
  id: 'pinned-model',
  revision: EffectString.repeat(40)('e'),
  backend: 'cpu',
  sha256: EffectString.repeat(64)('d'),
  dimensions: 384,
};
const source = {
  commit: artifact.environment.commit,
  dirty: false,
  trackedDiffHash: EffectString.repeat(64)('1'),
  indexHash: EffectString.repeat(64)('2'),
  statusHash: EffectString.repeat(64)('3'),
  instrumentationHash: EffectString.repeat(64)('4'),
};
const qualificationArtifact: BenchmarkArtifactV1 = {
  ...artifact,
  environment: {
    ...artifact.environment,
    model: {id: pinnedModel.id, revision: pinnedModel.revision, backend: pinnedModel.backend},
  },
  metadata: {
    qualification: true,
    inference: 'real-query',
    modelSha256: pinnedModel.sha256,
    modelPurpose: 'recall',
    documents: 10000,
    distribution: 'dense',
  },
};
const complete: NativePerformanceCapture = {
  ...capture,
  kind: 'qualification',
  limitations: [],
  platform: 'darwin-arm64',
  workload: {kind: 'vector', documents: 10000, dimensions: 384, distribution: 'dense'},
  inference: {
    kind: 'real-query',
    purpose: 'recall',
    weightsVerified: true,
    templateIdentity: 'prefix-v1',
    model: pinnedModel,
  },
  sourceFence: {opening: source, closing: source},
  stages: EffectRecord.fromEntries(
    EffectArray.map(
      NATIVE_PERFORMANCE_STAGES,
      stage => [stage, {state: 'measured', measurement: 'warm', boundary: 'contract fixture'}] as const,
    ),
  ),
  identities: {
    fixture: 'fixture',
    platform: 'darwin-arm64',
    runtime: 'r',
    workers: '1',
    model: `${pinnedModel.id}:${pinnedModel.revision}:${pinnedModel.sha256}`,
    purpose: 'recall',
    dimensions: '384',
    template: 'prefix-v1',
    grammar: 'g',
    boundary: 'b',
    method: 'selectedSemanticScores',
    sampler: 's',
  },
  processTreePeakRssMeasurement: 'rss',
  cpuMeasurement: 'cpu',
  diskMeasurement: 'disk',
};
const inputs = Array.from({length: 6}, (_, index) => ({
  artifact: qualificationArtifact,
  capture: {
    ...complete,
    pair: Math.floor(index / 2) + 1,
    arm: index % 2 === 0 ? ('baseline' as const) : ('candidate' as const),
  },
}));
const expected = {baselineCommit: artifact.environment.commit, candidateCommit: artifact.environment.commit};

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

  it('rejects contradictory declared identities and runtimes even with the same configuration hash', () => {
    FC.assert(
      FC.property(
        FC.record({
          identity: FC.constantFrom('workers', 'grammar', 'sampler', 'boundary', 'method', 'runtime'),
          environmentKey: FC.constantFrom('node', 'runner', 'runnerVersion', 'packageManager', 'cpu'),
          suffix: FC.string({maxLength: 12}),
        }),
        ({identity, environmentKey, suffix}) => {
          const changedIdentity = {
            ...inputs[5],
            capture: {...inputs[5].capture, identities: {...complete.identities, [identity]: `changed:${suffix}`}},
          };
          expect(() => validateNativePerformancePairs([...inputs.slice(0, 5), changedIdentity], expected)).toThrow(
            'mismatch',
          );
          const changedRuntime = {
            ...inputs[5],
            artifact: {
              ...qualificationArtifact,
              environment: {...qualificationArtifact.environment, [environmentKey]: `changed:${suffix}`},
            },
          };
          expect(() => validateNativePerformancePairs([...inputs.slice(0, 5), changedRuntime], expected)).toThrow(
            'mismatch',
          );
        },
      ),
      {numRuns: 50},
    );
  });

  it('compares host RAM, suite, warmups and primary sample counts instead of trusting the hash', () => {
    const changedArtifacts = [
      {
        ...qualificationArtifact,
        environment: {
          ...qualificationArtifact.environment,
          memoryBytes: qualificationArtifact.environment.memoryBytes + 1,
        },
      },
      {...qualificationArtifact, suite: 'another-suite'},
      {...qualificationArtifact, warmups: qualificationArtifact.warmups + 1},
      {
        ...qualificationArtifact,
        measurements: EffectArray.map(qualificationArtifact.measurements, measurement =>
          measurement.name === 'warm'
            ? benchmarkMeasurement(
                'warm',
                'milliseconds',
                Array.from({length: 31}, () => 5),
              )
            : measurement,
        ),
      },
      {
        ...qualificationArtifact,
        measurements: EffectArray.map(qualificationArtifact.measurements, measurement =>
          measurement.name === 'first' ? benchmarkMeasurement('first', 'milliseconds', [10, 10]) : measurement,
        ),
      },
    ];
    for (const changed of changedArtifacts) {
      expect(() =>
        validateNativePerformancePairs([...inputs.slice(0, 5), {...inputs[5], artifact: changed}], expected),
      ).toThrow('mismatch');
    }
  });

  it('requires observed pinned real-query evidence and rejects diagnostic contradictions', () => {
    expect(() =>
      parseNativePerformanceCapture(complete, {...qualificationArtifact, environment: artifact.environment}),
    ).toThrow('real-query');
    for (const metadata of [
      {...qualificationArtifact.metadata, qualification: false},
      {...qualificationArtifact.metadata, inference: 'mock'},
    ]) {
      expect(() => parseNativePerformanceCapture(complete, {...qualificationArtifact, metadata})).toThrow();
    }
    expect(() =>
      parseNativePerformanceCapture({...complete, inference: {kind: 'mock'}}, qualificationArtifact),
    ).toThrow('real-query');
    expect(() =>
      parseNativePerformanceCapture(complete, {...qualificationArtifact, suite: 'diagnostic-probe'}),
    ).toThrow('Diagnostic');
    expect(() => parseNativePerformanceCapture({...complete, inference: undefined}, qualificationArtifact)).toThrow();
    const inference = complete.inference;
    if (inference?.kind !== 'real-query') throw new Error('Invalid test fixture');
    expect(() =>
      parseNativePerformanceCapture(
        {...complete, inference: {...inference, model: {...pinnedModel, backend: 'mock'}}},
        {
          ...qualificationArtifact,
          environment: {...qualificationArtifact.environment, model: {...pinnedModel, backend: 'mock'}},
        },
      ),
    ).toThrow('real-query');
  });

  it('admits all eight vector profiles only with matching native architecture, OS and libc', () => {
    for (const profile of NATIVE_VECTOR_PROFILES) {
      const declared = {
        ...complete,
        platform: profile.target,
        identities: {
          ...complete.identities,
          platform: profile.target,
          ...('libc' in profile ? {libc: profile.libc} : {}),
        },
      };
      const observed = {
        ...qualificationArtifact,
        environment: {
          ...qualificationArtifact.environment,
          architecture: profile.architecture,
          operatingSystem: profile.platform,
        },
      };
      expect(parseNativePerformanceCapture(declared, observed).capture.platform).toBe(profile.target);
      expect(() =>
        parseNativePerformanceCapture(declared, {
          ...observed,
          environment: {...observed.environment, architecture: profile.architecture === 'arm64' ? 'x64' : 'arm64'},
        }),
      ).toThrow('platform');
      if ('libc' in profile)
        expect(() =>
          parseNativePerformanceCapture(
            {...declared, identities: {...declared.identities, libc: profile.libc === 'musl' ? 'gnu' : 'musl'}},
            observed,
          ),
        ).toThrow('platform');
      expect(() => parseNativePerformanceCapture({...declared, component: 'topology'}, observed)).toThrow('platform');
    }
  });
  it('enforces the frozen platform and representative workload without requiring a model for topology', () => {
    for (const platform of ['win32-x64', 'linux-arm64', 'darwin-x64'])
      expect(() => parseNativePerformanceCapture({...complete, platform}, qualificationArtifact)).toThrow('platform');
    for (const documents of [1, 9999, 10001, 99999])
      expect(() =>
        parseNativePerformanceCapture(
          {...complete, workload: {kind: 'vector', documents, dimensions: 384, distribution: 'dense'}},
          qualificationArtifact,
        ),
      ).toThrow('Unrepresentative');
    expect(() =>
      parseNativePerformanceCapture(
        {...complete, workload: {kind: 'vector', documents: 10000, dimensions: 384, distribution: 'sparse'}},
        qualificationArtifact,
      ),
    ).toThrow('Unrepresentative');
    const topology: NativePerformanceCapture = {
      ...complete,
      component: 'topology',
      workload: {kind: 'topology', nodes: 100001, operation: 'full'},
      inference: {kind: 'none'},
      identities: {
        fixture: 'fixture',
        platform: 'darwin-arm64',
        runtime: 'r',
        workers: '0',
        grammar: 'not-applicable',
        boundary: 'CLI full analysis',
        method: 'full',
        sampler: 's',
      },
    };
    const topologyArtifact = {...artifact, metadata: {qualification: true, nodes: 100001}};
    expect(parseNativePerformanceCapture(topology, topologyArtifact).capture.component).toBe('topology');
    expect(() =>
      parseNativePerformanceCapture(
        {...topology, workload: {kind: 'topology', nodes: 100000, operation: 'full'}},
        {...topologyArtifact, metadata: {qualification: true, nodes: 100000}},
      ),
    ).toThrow('more than 100000');
  });

  it('refuses a changed tracked tree, index or status when HEAD and instrumentation remain fixed', () => {
    FC.assert(
      FC.property(
        FC.record({
          key: FC.constantFrom('trackedDiffHash', 'indexHash', 'statusHash'),
          hash: FC.array(FC.integer({min: 0, max: 15}), {minLength: 64, maxLength: 64}).map(values =>
            EffectArray.join(
              EffectArray.map(values, value => value.toString(16)),
              '',
            ),
          ),
        }),
        ({key, hash}) => {
          const changed = {...source, [key]: hash === source[key] ? EffectString.repeat(64)('f') : hash};
          expect(() =>
            parseNativePerformanceCapture(
              {...complete, sourceFence: {opening: source, closing: changed}},
              qualificationArtifact,
            ),
          ).toThrow('Mixed-source');
        },
      ),
      {numRuns: 30},
    );
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

describe('exclusive stage interval accounting', () => {
  it('matches independent discrete coverage under permutation, duplication and nesting without mutation', () => {
    FC.assert(
      FC.property(
        FC.array(FC.tuple(FC.integer({min: 0, max: 20}), FC.integer({min: 0, max: 20})), {maxLength: 24}),
        raw => {
          const intervals = EffectArray.map(raw, ([a, b]) => ({
            start: BigInt(Math.min(a, b)) * 1_000_000n,
            end: BigInt(Math.max(a, b)) * 1_000_000n,
          }));
          const original = EffectArray.map(intervals, interval => ({...interval}));
          const expected = new Set<number>();
          for (const [a, b] of raw)
            for (let point = Math.min(a, b); point < Math.max(a, b); point += 1) expected.add(point);
          const envelope = {start: 0n, end: 20_000_000n};
          const first = nativeStagePartition(envelope, intervals);
          const duplicated = nativeStagePartition(
            envelope,
            EffectArray.flatMap([...intervals].reverse(), interval => [interval, interval]),
          );
          expect(intervals).toEqual(original);
          expect(first.available).toBe(true);
          if (!first.available || !duplicated.available) throw new Error('Valid interval fixture');
          expect(first.coveredMilliseconds).toBe(expected.size);
          expect(first.exclusiveResidualMilliseconds).toBe(20 - expected.size);
          expect(duplicated.coveredMilliseconds).toBe(first.coveredMilliseconds);
          expect(duplicated.exclusiveResidualMilliseconds).toBe(first.exclusiveResidualMilliseconds);
        },
      ),
      {numRuns: 100},
    );
  });

  it('keeps empty coverage and inconsistent clocks explicit instead of clamping them', () => {
    expect(nativeStagePartition({start: 0n, end: 10_000_000n}, [])).toMatchObject({
      available: true,
      coveredMilliseconds: 0,
      exclusiveResidualMilliseconds: 10,
    });
    const inconsistent = nativeStagePartition({start: 0n, end: 10_000_000n}, [{start: -1_000_000n, end: 11_000_000n}]);
    expect(inconsistent).toMatchObject({
      available: false,
      errors: ['child-outside-envelope'],
      intervals: [{startMilliseconds: -1, endMilliseconds: 11}],
    });
    expect('exclusiveResidualMilliseconds' in inconsistent).toBe(false);
    expect(nativeStagePartition({start: 2n, end: 1n}, [])).toMatchObject({
      available: false,
      errors: ['negative-envelope'],
    });
  });
});
