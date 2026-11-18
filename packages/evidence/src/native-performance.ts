import {Array as EffectArray, Record as EffectRecord, Schema, Context, Exit, Option, Tracer} from 'effect';
import {parseBenchmarkArtifactV1, type BenchmarkArtifactV1} from './benchmark.js';

/** Native-only vector adoption requires actual native-host captures for every release profile. */
export const NATIVE_VECTOR_PROFILES = [
  {target: 'bun-darwin-arm64', platform: 'darwin', architecture: 'arm64'},
  {target: 'bun-darwin-x64', platform: 'darwin', architecture: 'x64'},
  {target: 'bun-linux-arm64', platform: 'linux', architecture: 'arm64', libc: 'glibc'},
  {target: 'bun-linux-arm64-musl', platform: 'linux', architecture: 'arm64', libc: 'musl'},
  {target: 'bun-linux-x64-baseline', platform: 'linux', architecture: 'x64', libc: 'glibc'},
  {target: 'bun-linux-x64-baseline-musl', platform: 'linux', architecture: 'x64', libc: 'musl'},
  {target: 'bun-windows-arm64', platform: 'win32', architecture: 'arm64'},
  {target: 'bun-windows-x64-baseline', platform: 'win32', architecture: 'x64'},
] as const;

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
  vectorProfiles: EffectArray.map(NATIVE_VECTOR_PROFILES, profile => profile.target),
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

const SourceFence = Schema.Struct({
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  dirty: Schema.Boolean,
  trackedDiffHash: Hash,
  indexHash: Hash,
  statusHash: Hash,
  instrumentationHash: Hash,
});
export type NativePerformanceSourceFence = typeof SourceFence.Type;

export function nativePerformanceSourceChanges(
  opening: NativePerformanceSourceFence,
  closing: NativePerformanceSourceFence,
): readonly string[] {
  return EffectArray.filter(
    ['commit', 'dirty', 'trackedDiffHash', 'indexHash', 'statusHash', 'instrumentationHash'] as const,
    key => opening[key] !== closing[key],
  );
}

const Workload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('vector'),
    documents: Schema.Int,
    dimensions: Schema.Int,
    distribution: NonEmpty,
  }),
  Schema.Struct({kind: Schema.Literal('topology'), nodes: Schema.Int, operation: NonEmpty}),
  Schema.Struct({kind: Schema.Literal('parser'), profile: NonEmpty}),
]);
const Inference = Schema.Union([
  Schema.Struct({kind: Schema.Literals(['none', 'mock'])}),
  Schema.Struct({
    kind: Schema.Literal('real-query'),
    purpose: Schema.Literals(['recall', 'graph']),
    templateIdentity: NonEmpty,
    weightsVerified: Schema.Literal(true),
    model: Schema.Struct({
      id: NonEmpty,
      revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u)),
      sha256: Hash,
      dimensions: Schema.Int.check(Schema.isGreaterThan(0)),
      backend: NonEmpty,
    }),
  }),
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
  // Optional only for legacy diagnostic receipts. Qualification requires these observed declarations.
  platform: Schema.optionalKey(NonEmpty),
  workload: Schema.optionalKey(Workload),
  inference: Schema.optionalKey(Inference),
  sourceFence: Schema.optionalKey(Schema.Struct({opening: SourceFence, closing: SourceFence})),
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
  if (capture.sourceFence) {
    const {opening, closing} = capture.sourceFence;
    if (
      nativePerformanceSourceChanges(opening, closing).length > 0 ||
      opening.commit !== artifact.environment.commit ||
      artifact.environment.dirty !== opening.dirty
    ) {
      throw new Error('Mixed-source capture: source fence does not match the measured source');
    }
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
    for (const key of ['fixture', 'runtime', 'workers', 'grammar', 'boundary', 'method', 'sampler']) {
      if (!capture.identities[key]) throw new Error(`Missing identity: ${key}`);
    }
    validateQualificationDeclarations(capture, artifact);
    Schema.decodeSync(Positive)(requireMeasurement(capture.processTreePeakRssMeasurement, 'bytes').maximum);
  }
  return {artifact, capture};
}

function validateQualificationDeclarations(capture: NativePerformanceCapture, artifact: BenchmarkArtifactV1): void {
  if (artifact.metadata.qualification !== true || /diagnostic/iu.test(artifact.suite)) {
    throw new Error('Diagnostic or unclassified artifact cannot qualify');
  }
  if (!capture.sourceFence) throw new Error('Qualification requires opening and closing source fences');
  const vectorProfile =
    capture.component === 'vector'
      ? Option.getOrUndefined(
          EffectArray.findFirst(NATIVE_VECTOR_PROFILES, profile => profile.target === capture.platform),
        )
      : undefined;
  const historicalPlatform = EffectArray.some(
    NATIVE_PERFORMANCE_CONTRACT.platforms,
    platform => platform === capture.platform,
  );
  if (!historicalPlatform && !vectorProfile) throw new Error('Unsupported qualification platform');
  const environment = artifact.environment;
  const platformMatches = vectorProfile
    ? environment.architecture === vectorProfile.architecture &&
      (vectorProfile.platform === 'darwin'
        ? /darwin|macos/iu
        : vectorProfile.platform === 'win32'
          ? /windows|win32/iu
          : /linux/iu
      ).test(environment.operatingSystem) &&
      (!('libc' in vectorProfile) || capture.identities.libc === vectorProfile.libc)
    : capture.platform === 'darwin-arm64'
      ? environment.architecture === 'arm64' && /darwin|macos/iu.test(environment.operatingSystem)
      : environment.architecture === 'x64' && /linux/iu.test(environment.operatingSystem);
  if (!platformMatches || capture.identities.platform !== capture.platform)
    throw new Error('Contradictory platform identity');
  if (capture.identities.fixture !== environment.fixtureHash) throw new Error('Contradictory fixture identity');
  const workload = capture.workload;
  if (!workload || workload.kind !== capture.component) throw new Error('Missing representative workload');
  if (workload.kind === 'vector') {
    if (
      !EffectArray.some(NATIVE_PERFORMANCE_CONTRACT.vectorDocuments, count => count === workload.documents) ||
      !EffectArray.some(
        NATIVE_PERFORMANCE_CONTRACT.vectorDistributions,
        distribution => distribution === workload.distribution,
      )
    ) {
      throw new Error('Unrepresentative vector workload');
    }
    const inference = capture.inference;
    const model = environment.model;
    if (
      !inference ||
      inference.kind !== 'real-query' ||
      !model ||
      artifact.metadata.inference !== 'real-query' ||
      /mock|fake|diagnostic/iu.test(model.backend) ||
      /mock|fake|diagnostic/iu.test(inference.model.backend) ||
      model.id !== inference.model.id ||
      model.revision !== inference.model.revision ||
      model.backend !== inference.model.backend ||
      artifact.metadata.modelSha256 !== inference.model.sha256 ||
      artifact.metadata.modelPurpose !== inference.purpose ||
      workload.dimensions !== inference.model.dimensions ||
      artifact.metadata.documents !== workload.documents ||
      artifact.metadata.distribution !== workload.distribution ||
      capture.identities.model !== `${model.id}:${model.revision}:${inference.model.sha256}` ||
      capture.identities.purpose !== inference.purpose ||
      capture.identities.dimensions !== String(workload.dimensions) ||
      capture.identities.template !== inference.templateIdentity
    ) {
      throw new Error('Vector qualification requires consistent pinned real-query inference evidence');
    }
  } else if (workload.kind === 'topology') {
    if (
      workload.nodes <= 100_000 ||
      artifact.metadata.nodes !== workload.nodes ||
      capture.identities.method !== workload.operation
    ) {
      throw new Error('Topology qualification requires an identified operation over more than 100000 nodes');
    }
  } else if (workload.profile !== 'reduced-polyglot' && workload.profile !== 'heavy-tail') {
    throw new Error('Unrepresentative parser workload');
  }
}

function sameRecord(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean {
  const keys = EffectRecord.keys(left);
  return keys.length === EffectRecord.keys(right).length && EffectArray.every(keys, key => left[key] === right[key]);
}

function sameInference(
  left: NativePerformanceCapture['inference'],
  right: NativePerformanceCapture['inference'],
): boolean {
  if (left?.kind !== right?.kind) return false;
  if (left?.kind === 'real-query' && right?.kind === 'real-query') {
    return (
      sameRecord(left.model, right.model) &&
      left.purpose === right.purpose &&
      left.templateIdentity === right.templateIdentity &&
      left.weightsVerified === right.weightsVerified
    );
  }
  return true;
}

function sameStages(left: NativePerformanceCapture['stages'], right: NativePerformanceCapture['stages']): boolean {
  const keys = EffectRecord.keys(left);
  return (
    keys.length === EffectRecord.keys(right).length &&
    EffectArray.every(keys, key => sameRecord(left[key], right[key] ?? {}))
  );
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

function measurementSamples(artifact: BenchmarkArtifactV1, name: string): number | undefined {
  for (const measurement of artifact.measurements) if (measurement.name === name) return measurement.samples;
  return undefined;
}

/** Admit one component/platform independently. Callers retain raw serial-run receipts. */
export function validateNativePerformancePairs(
  inputs: readonly {readonly capture: unknown; readonly artifact: unknown}[],
  expected: {readonly baselineCommit: string; readonly candidateCommit: string},
) {
  const runs = EffectArray.map(inputs, input => parseNativePerformanceCapture(input.capture, input.artifact));
  if (runs.length < NATIVE_PERFORMANCE_CONTRACT.minimumPairedRuns * 2) throw new Error('At least three pairs required');
  const first = runs[0];
  const platform = first.capture.platform;
  const pairs = new Map<number, {baseline?: typeof first; candidate?: typeof first}>();
  for (const run of runs) {
    const {capture, artifact} = run;
    if (capture.kind !== 'qualification') throw new Error('Diagnostic evidence cannot qualify a comparison');
    if (
      capture.component !== first.capture.component ||
      artifact.suite !== first.artifact.suite ||
      artifact.warmups !== first.artifact.warmups ||
      measurementSamples(artifact, capture.warmMeasurement) !==
        measurementSamples(first.artifact, first.capture.warmMeasurement) ||
      measurementSamples(artifact, capture.firstUseMeasurement) !==
        measurementSamples(first.artifact, first.capture.firstUseMeasurement) ||
      capture.configurationHash !== first.capture.configurationHash ||
      !sameRecord(capture.identities, first.capture.identities) ||
      !sameStages(capture.stages, first.capture.stages) ||
      EffectArray.some(
        [
          'firstUseMeasurement',
          'warmMeasurement',
          'cpuMeasurement',
          'diskMeasurement',
          'processTreePeakRssMeasurement',
        ] as const,
        key => capture[key] !== first.capture[key],
      ) ||
      capture.sourceFence?.opening.instrumentationHash !== first.capture.sourceFence?.opening.instrumentationHash ||
      capture.platform !== first.capture.platform ||
      !sameRecord(capture.workload ?? {}, first.capture.workload ?? {}) ||
      !sameInference(capture.inference, first.capture.inference) ||
      capture.correctnessDigest !== first.capture.correctnessDigest ||
      artifact.environment.fixtureHash !== first.artifact.environment.fixtureHash ||
      artifact.environment.cpu !== first.artifact.environment.cpu ||
      artifact.environment.memoryBytes !== first.artifact.environment.memoryBytes ||
      artifact.environment.runnerVersion !== first.artifact.environment.runnerVersion ||
      artifact.environment.node !== first.artifact.environment.node ||
      artifact.environment.runner !== first.artifact.environment.runner ||
      artifact.environment.packageManager !== first.artifact.environment.packageManager ||
      !sameRecord(artifact.environment.model ?? {}, first.artifact.environment.model ?? {}) ||
      artifact.environment.operatingSystem !== first.artifact.environment.operatingSystem ||
      artifact.environment.architecture !== first.artifact.environment.architecture
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

export interface NativeStageInterval {
  readonly start: bigint;
  readonly end: bigint;
}
export interface NativeStageSpan extends NativeStageInterval {
  readonly name: string;
  readonly success: boolean;
}

/** Exclusive wall accounting: union overlapping children; never clamp inconsistent observations. */
export function nativeStagePartition(envelope: NativeStageInterval, children: readonly NativeStageInterval[]) {
  const errors: string[] = [];
  if (envelope.end < envelope.start) errors.push('negative-envelope');
  for (const child of children) {
    if (child.end < child.start) errors.push('negative-child');
    if (child.start < envelope.start || child.end > envelope.end) errors.push('child-outside-envelope');
  }
  const intervals = EffectArray.map(children, child => ({
    startMilliseconds: Number(child.start - envelope.start) / 1_000_000,
    endMilliseconds: Number(child.end - envelope.start) / 1_000_000,
  }));
  const envelopeMilliseconds = Number(envelope.end - envelope.start) / 1_000_000;
  if (errors.length > 0) return {available: false as const, errors, envelopeMilliseconds, intervals};
  const sorted = [...children].sort((left, right) =>
    left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
  );
  let covered = 0n;
  let start: bigint | undefined;
  let end = 0n;
  for (const interval of sorted) {
    if (start === undefined) {
      start = interval.start;
      end = interval.end;
    } else if (interval.start <= end) {
      if (interval.end > end) end = interval.end;
    } else {
      covered += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  if (start !== undefined) covered += end - start;
  return {
    available: true as const,
    errors,
    envelopeMilliseconds,
    intervals,
    coveredMilliseconds: Number(covered) / 1_000_000,
    exclusiveResidualMilliseconds: Number(envelope.end - envelope.start - covered) / 1_000_000,
  };
}

class NativeStageTraceSpan extends Tracer.NativeSpan {
  constructor(
    private readonly selected: string | undefined,
    start: bigint,
    private readonly record: (span: NativeStageSpan) => void,
  ) {
    super({
      name: selected ?? 'ignored',
      startTime: start,
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      kind: 'internal',
      sampled: true,
    });
  }
  override end(at: bigint, exit: Exit.Exit<unknown, unknown>) {
    if (this.status._tag === 'Ended') return;
    if (this.selected)
      this.record({name: this.selected, start: this.startTime, end: at, success: Exit.isSuccess(exit)});
    super.end(at, exit);
  }
  // SQL statement text/bindings and arbitrary attributes must never be retained.
  override attribute() {}
  override event() {}
  override addLinks() {}
}

/** Per-operation bounded observer; it records only caller-selected static span names and clocks. */
export function createNativeStageTracing(names: readonly string[], maximumSpans = 4096) {
  const selected = new Set(names);
  const spans: NativeStageSpan[] = [];
  let overflow = false;
  const record = (span: NativeStageSpan) => {
    if (spans.length >= maximumSpans) {
      overflow = true;
      return;
    }
    spans.push(span);
  };
  return {
    tracer: Tracer.make({
      span: options =>
        new NativeStageTraceSpan(selected.has(options.name) ? options.name : undefined, options.startTime, record),
    }),
    snapshot: () => ({spans: [...spans], overflow}),
  };
}
