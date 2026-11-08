import {Array as EffectArray, Record as EffectRecord, Schema} from 'effect';
import {parseBenchmarkArtifactV1, type BenchmarkArtifactV1} from './benchmark.js';

/** Fixed before optimization. Diagnostic or incomplete captures never authorize adoption. */
export const NATIVE_PERFORMANCE_CONTRACT = {
  version: 1,
  primaryP95ImprovementRatio: 0.2,
  secondaryP95RegressionRatio: 0.05,
  secondaryNoiseMilliseconds: 5,
  processTreePeakRssGrowthRatio: 0.1,
  minimumPairedRuns: 3,
  minimumWarmVectorQueries: 30,
  platforms: ['darwin-arm64', 'linux-x64'],
  vectorDocuments: [10_000, 100_000],
  vectorDistributions: ['dense', 'tied'],
  primaryBoundaries: {
    vector: 'complete semantic retrieval including pinned-model inference and authorized SQLite reads',
    parser: 'cold polyglot indexing and whole worker request including serialization and persistence',
    topology: 'each CLI analysis operation including snapshot loading and output projection; more than 100000 nodes',
  },
  controls: ['first-use separately', 'incremental indexing', 'small-scale secondary flows'],
  refresh: 'refresh after separately owned crypto lands; identical configuration apart from candidate change',
} as const;

export const NATIVE_PERFORMANCE_STAGES = [
  'sql-row-transport',
  'validation-scoring-top-k',
  'parse',
  'query',
  'fact-construction',
  'ipc',
  'topology-load',
  'topology-compute',
] as const;

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
const Stage = Schema.Union([
  Schema.Struct({state: Schema.Literal('measured'), measurement: NonEmpty, boundary: NonEmpty}),
  Schema.Struct({state: Schema.Literal('unavailable'), reason: NonEmpty}),
  Schema.Struct({state: Schema.Literal('not-applicable'), reason: NonEmpty}),
]);

export const NativePerformanceCaptureSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(['diagnostic', 'qualification']),
  component: Schema.Literals(['vector', 'parser', 'topology']),
  pair: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  arm: Schema.Literals(['baseline', 'candidate']),
  // Includes fixture, purpose-specific actual model/revision/template, grammars,
  // worker counts, OS/CPU/runtime, query sequence, budgets and sampler settings.
  configurationHash: Hash,
  identities: Schema.Record(NonEmpty, NonEmpty),
  correctnessDigest: Hash,
  firstUseMeasurement: NonEmpty,
  warmMeasurement: NonEmpty,
  processTreePeakRssMeasurement: Schema.optionalKey(NonEmpty),
  cpuMeasurement: Schema.optionalKey(NonEmpty),
  diskMeasurement: Schema.optionalKey(NonEmpty),
  stages: Schema.Record(NonEmpty, Stage),
  limitations: Schema.Array(NonEmpty),
});
export type NativePerformanceCapture = typeof NativePerformanceCaptureSchema.Type;

/** A capture references observed measurements, never inferred differences of totals. */
export function parseNativePerformanceCapture(
  value: unknown,
  input: unknown,
): {
  readonly capture: NativePerformanceCapture;
  readonly artifact: BenchmarkArtifactV1;
} {
  const capture = Schema.decodeUnknownSync(NativePerformanceCaptureSchema)(value);
  const artifact = parseBenchmarkArtifactV1(input);
  const measurements = new Map(EffectArray.map(artifact.measurements, item => [item.name, item] as const));
  const requireMeasurement = (name: string, unit: string) => {
    const measurement = measurements.get(name);
    if (!measurement || measurement.unit !== unit) throw new Error(`Missing ${unit} measurement: ${name}`);
    return measurement;
  };
  if (measurements.size !== artifact.measurements.length) throw new Error('Duplicate measurement names');
  requireMeasurement(capture.firstUseMeasurement, 'milliseconds');
  const warm = requireMeasurement(capture.warmMeasurement, 'milliseconds');
  if (capture.firstUseMeasurement === capture.warmMeasurement) throw new Error('First-use must be separate from warm');
  for (const name of NATIVE_PERFORMANCE_STAGES) {
    const stage = capture.stages[name];
    if (!stage) throw new Error(`Missing stage disclosure: ${name}`);
    if (stage.state === 'measured') requireMeasurement(stage.measurement, 'milliseconds');
  }
  for (const [name, unit] of [
    [capture.processTreePeakRssMeasurement, 'bytes'],
    [capture.cpuMeasurement, 'milliseconds'],
    [capture.diskMeasurement, 'bytes'],
  ] as const) {
    if (name !== undefined) requireMeasurement(name, unit);
  }
  if (capture.kind === 'qualification') {
    if (artifact.environment.dirty || !/^[a-f0-9]{40}$/u.test(artifact.environment.commit)) {
      throw new Error('Qualification requires clean exact source');
    }
    if (capture.component === 'vector' && warm.samples < NATIVE_PERFORMANCE_CONTRACT.minimumWarmVectorQueries) {
      throw new Error('Qualification requires at least 30 warm vector queries');
    }
    if (!capture.processTreePeakRssMeasurement || !capture.cpuMeasurement || !capture.diskMeasurement) {
      throw new Error('Qualification requires process-tree RSS, CPU and disk');
    }
    if (
      capture.limitations.length > 0 ||
      EffectArray.some(EffectRecord.values(capture.stages), stage => stage.state === 'unavailable')
    ) {
      throw new Error('Incomplete captures cannot qualify');
    }
    const requiredStages =
      capture.component === 'vector'
        ? ['sql-row-transport', 'validation-scoring-top-k']
        : capture.component === 'parser'
          ? ['parse', 'query', 'fact-construction', 'ipc']
          : ['topology-load', 'topology-compute'];
    for (const stage of requiredStages) {
      if (capture.stages[stage]?.state !== 'measured') throw new Error(`Qualification requires stage: ${stage}`);
    }
    for (const key of ['fixture', 'runtime', 'workers', 'model', 'grammar', 'boundary', 'sampler']) {
      if (!capture.identities[key]) throw new Error(`Missing identity: ${key}`);
    }
    Schema.decodeSync(Positive)(requireMeasurement(capture.processTreePeakRssMeasurement, 'bytes').maximum);
  }
  return {artifact, capture};
}

/** Gate arithmetic is shared so the predeclared 5ms floor cannot be widened by a runner. */
export function nativePerformanceGates(input: {
  readonly baselinePrimaryP95: number;
  readonly candidatePrimaryP95: number;
  readonly baselineSecondaryP95: number;
  readonly candidateSecondaryP95: number;
  readonly baselineProcessTreePeakRss: number;
  readonly candidateProcessTreePeakRss: number;
}) {
  for (const value of EffectRecord.values(input)) Schema.decodeSync(Positive)(value);
  const contract = NATIVE_PERFORMANCE_CONTRACT;
  return {
    primary: input.candidatePrimaryP95 <= input.baselinePrimaryP95 * (1 - contract.primaryP95ImprovementRatio),
    secondary:
      input.candidateSecondaryP95 - input.baselineSecondaryP95 <=
      Math.max(contract.secondaryNoiseMilliseconds, input.baselineSecondaryP95 * contract.secondaryP95RegressionRatio),
    memory:
      input.candidateProcessTreePeakRss <=
      input.baselineProcessTreePeakRss * (1 + contract.processTreePeakRssGrowthRatio),
  };
}

/** Admit one component/platform independently. Callers retain raw serial-run receipts. */
export function validateNativePerformancePairs(
  inputs: readonly {readonly capture: unknown; readonly artifact: unknown}[],
  expected: {readonly baselineCommit: string; readonly candidateCommit: string},
) {
  const runs = EffectArray.map(inputs, input => parseNativePerformanceCapture(input.capture, input.artifact));
  if (runs.length < NATIVE_PERFORMANCE_CONTRACT.minimumPairedRuns * 2) throw new Error('At least three pairs required');
  const first = runs[0];
  const platform = `${first.artifact.environment.operatingSystem}-${first.artifact.environment.architecture}`;
  const pairs = new Map<number, {baseline?: typeof first; candidate?: typeof first}>();
  for (const run of runs) {
    const {capture, artifact} = run;
    if (capture.kind !== 'qualification') throw new Error('Diagnostic evidence cannot qualify a comparison');
    if (
      capture.component !== first.capture.component ||
      capture.configurationHash !== first.capture.configurationHash ||
      capture.correctnessDigest !== first.capture.correctnessDigest ||
      artifact.environment.fixtureHash !== first.artifact.environment.fixtureHash ||
      artifact.environment.cpu !== first.artifact.environment.cpu ||
      artifact.environment.runnerVersion !== first.artifact.environment.runnerVersion ||
      artifact.environment.packageManager !== first.artifact.environment.packageManager ||
      JSON.stringify(artifact.environment.model) !== JSON.stringify(first.artifact.environment.model) ||
      `${artifact.environment.operatingSystem}-${artifact.environment.architecture}` !== platform
    )
      throw new Error('Paired configuration, platform, fixture or correctness mismatch');
    const commit = capture.arm === 'baseline' ? expected.baselineCommit : expected.candidateCommit;
    if (artifact.environment.commit !== commit) throw new Error('Unexpected paired source commit');
    const pair = pairs.get(capture.pair) ?? {};
    if (pair[capture.arm]) throw new Error('Duplicate pair arm');
    pair[capture.arm] = run;
    pairs.set(capture.pair, pair);
  }
  for (const pair of pairs.values()) {
    if (!pair.baseline || !pair.candidate) throw new Error('Incomplete pair');
  }
  return {pairs: pairs.size, platform, component: first.capture.component};
}
