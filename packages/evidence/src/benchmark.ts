import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';

export const BENCHMARK_ARTIFACT_VERSION = 1 as const;

export interface BenchmarkEnvironmentV1 {
  readonly architecture: string;
  readonly commit: string;
  readonly cpu: string;
  readonly dirty: boolean;
  readonly fixtureHash: string;
  readonly memoryBytes: number;
  readonly model?: {
    readonly backend: string;
    readonly id: string;
    readonly revision: string;
  };
  readonly node: string;
  readonly operatingSystem: string;
  readonly packageManager: string;
  readonly runner: string;
  readonly runnerVersion: string;
}

export interface BenchmarkMeasurementV1 {
  readonly maximum: number;
  readonly mean: number;
  readonly minimum: number;
  readonly name: string;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly samples: number;
  readonly unit: 'bytes' | 'count' | 'milliseconds' | 'operations_per_second' | 'percent';
}

export interface BenchmarkArtifactV1 {
  readonly createdAt: string;
  readonly environment: BenchmarkEnvironmentV1;
  readonly measurements: readonly BenchmarkMeasurementV1[];
  readonly metadata: Readonly<Record<string, boolean | number | string>>;
  readonly suite: string;
  readonly version: typeof BENCHMARK_ARTIFACT_VERSION;
  readonly warmups: number;
}

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const BenchmarkEnvironmentSchemaV1 = Schema.Struct({
  architecture: NonEmptyString,
  commit: NonEmptyString,
  cpu: NonEmptyString,
  dirty: Schema.Boolean,
  fixtureHash: NonEmptyString,
  memoryBytes: NonNegativeFinite,
  model: Schema.optionalKey(
    Schema.Struct({
      backend: NonEmptyString,
      id: NonEmptyString,
      revision: NonEmptyString,
    }),
  ),
  node: NonEmptyString,
  operatingSystem: NonEmptyString,
  packageManager: NonEmptyString,
  runner: NonEmptyString,
  runnerVersion: NonEmptyString,
});

export const BenchmarkMeasurementSchemaV1 = Schema.Struct({
  maximum: NonNegativeFinite,
  mean: NonNegativeFinite,
  minimum: NonNegativeFinite,
  name: NonEmptyString,
  p50: NonNegativeFinite,
  p95: NonNegativeFinite,
  p99: NonNegativeFinite,
  samples: NonNegativeFinite,
  unit: Schema.Literals(['bytes', 'count', 'milliseconds', 'operations_per_second', 'percent']),
});

export const BenchmarkArtifactSchemaV1 = Schema.Struct({
  createdAt: NonEmptyString,
  environment: BenchmarkEnvironmentSchemaV1,
  measurements: Schema.Array(BenchmarkMeasurementSchemaV1),
  metadata: Schema.Record(NonEmptyString, Schema.Union([Schema.Boolean, Schema.Finite, Schema.String])),
  suite: NonEmptyString,
  version: Schema.Literal(BENCHMARK_ARTIFACT_VERSION),
  warmups: NonNegativeFinite,
});

export function parseBenchmarkArtifactV1(value: unknown): BenchmarkArtifactV1 {
  const artifact = Schema.decodeUnknownSync(BenchmarkArtifactSchemaV1)(value);
  for (const measurement of artifact.measurements) {
    if (!Number.isInteger(measurement.samples) || measurement.samples < 1) {
      throw new Error(`Benchmark ${measurement.name} must have at least one integer sample`);
    }
    if (
      measurement.minimum > measurement.p50 ||
      measurement.p50 > measurement.p95 ||
      measurement.p95 > measurement.p99 ||
      measurement.p99 > measurement.maximum
    ) {
      throw new Error(`Benchmark ${measurement.name} percentiles are not monotonically ordered`);
    }
  }
  if (!Number.isInteger(artifact.warmups) || artifact.warmups < 0) {
    throw new Error('Benchmark warmups must be a non-negative integer');
  }
  return artifact;
}

export function benchmarkMeasurement(
  name: string,
  unit: BenchmarkMeasurementV1['unit'],
  values: readonly number[],
): BenchmarkMeasurementV1 {
  if (values.length === 0 || EffectArray.some(values, value => !Number.isFinite(value) || value < 0)) {
    throw new Error(`Benchmark ${name} requires non-negative finite samples`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    maximum: sorted[sorted.length - 1],
    mean: EffectArray.reduce(sorted, 0, (total, value) => total + value) / sorted.length,
    minimum: sorted[0],
    name,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    samples: sorted.length,
    unit,
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}
