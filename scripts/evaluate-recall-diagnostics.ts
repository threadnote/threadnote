import {Array as EffectArray} from 'effect';
import {Clock, DateTime, Effect, FileSystem, Option} from 'effect';
import {benchmarkMeasurement} from '@threadnote/evidence/benchmark';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {ScriptError} from './effect/errors.js';
import {atomicWrite} from './effect/script.js';
import {
  createRecallEvaluationTracing,
  snapshotRecallEvaluationTracing,
  withRecallEvaluationTracing,
  type RecallEvaluationSpans,
} from './evaluate-recall-tracing.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export interface RecallEvaluationSample {
  readonly wallMilliseconds: number;
  readonly cpuUserMilliseconds: number;
  readonly cpuSystemMilliseconds: number;
  readonly rssBeforeBytes: number;
  readonly rssAfterBytes: number;
  readonly resultCount?: number;
  readonly spans?: RecallEvaluationSpans;
}

type ScenarioName =
  'coldDecode' | 'exactNoHit' | 'exactSubstring' | 'hotQuery' | 'incrementalUpdate' | 'sourceValidation';

interface ScenarioSummary {
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly p95LimitMilliseconds: number;
  readonly samples: number;
}

interface SourceObservation {
  readonly commit?: string;
  readonly dirty?: boolean;
  readonly lockfileSha256?: string;
  readonly packageManifestSha256?: string;
}

export interface RecallEvaluationDiagnostics {
  readonly correctnessFailureCount: number;
  readonly fixtureSha256?: string;
  readonly productionBenchmark: {
    readonly documents: number;
    readonly scenarios: Readonly<Record<ScenarioName, ScenarioSummary>>;
    readonly warmups: number;
  };
  readonly observations: Readonly<Record<ScenarioName, readonly RecallEvaluationSample[]>>;
  readonly source: {readonly before: SourceObservation; readonly after: SourceObservation};
}

export const captureRecallEvaluationSource = Effect.fn('recallEvaluation.captureSource')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const [commit, dirty, lockfile, manifest] = yield* Effect.all(
    [
      runCommandEffect('git', ['rev-parse', 'HEAD'], {maxOutputBytes: 128, timeoutMs: 5000}).pipe(Effect.option),
      runCommandEffect('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], {
        maxOutputBytes: 1048576,
        timeoutMs: 5000,
      }).pipe(Effect.option),
      fs.readFileString('bun.lock').pipe(Effect.option),
      fs.readFileString('package.json').pipe(Effect.option),
    ],
    {concurrency: 4},
  );
  const sha = Option.isSome(commit) ? Effect2.pipe(commit.value.stdout, EffectString.trim) : undefined;
  return {
    commit: sha && COMMIT_PATTERN.test(sha) ? sha : undefined,
    dirty: Option.isSome(dirty) ? dirty.value.stdout.length > 0 : undefined,
    lockfileSha256: Option.isSome(lockfile) ? sha256HexSync(lockfile.value) : undefined,
    packageManifestSha256: Option.isSome(manifest) ? sha256HexSync(manifest.value) : undefined,
  } satisfies SourceObservation;
});

export function measureRecallEvaluationSample<A, E, R>(
  run: () => Effect.Effect<A, E, R>,
  options?: {readonly trace?: boolean},
): Effect.Effect<{readonly result: A; readonly observation: RecallEvaluationSample}, E, R> {
  return Effect.gen(function* () {
    const tracing = options?.trace ? createRecallEvaluationTracing() : undefined;
    const rssBeforeBytes = process.memoryUsage().rss;
    const cpuStarted = process.cpuUsage();
    const startedAt = yield* Clock.currentTimeNanos;
    const result = yield* withRecallEvaluationTracing(run(), tracing);
    const finishedAt = yield* Clock.currentTimeNanos;
    const cpu = process.cpuUsage(cpuStarted);
    const observation = {
      wallMilliseconds: Number(finishedAt - startedAt) / 1_000_000,
      cpuUserMilliseconds: cpu.user / 1000,
      cpuSystemMilliseconds: cpu.system / 1000,
      rssBeforeBytes,
      rssAfterBytes: process.memoryUsage().rss,
    } satisfies RecallEvaluationSample;
    const spans = snapshotRecallEvaluationTracing(tracing);
    return {result, observation: spans ? {...observation, spans} : observation};
  });
}

export function recallEvaluationScenario(
  observations: readonly RecallEvaluationSample[],
  limit: number,
): ScenarioSummary {
  const measured = benchmarkMeasurement(
    'recall',
    'milliseconds',
    EffectArray.map(observations, sample => sample.wallMilliseconds),
  );
  return {
    p50Milliseconds: measured.p50,
    p95LimitMilliseconds: limit,
    p95Milliseconds: measured.p95,
    samples: measured.samples,
  };
}

export const writeRecallEvaluationDiagnosticsAndEnforce = Effect.fn('recallEvaluation.writeAndEnforce')(function* (
  file: string,
  diagnostics: RecallEvaluationDiagnostics,
) {
  const system = yield* SystemInfo;
  const expectedCommit = system.environment().GITHUB_SHA;
  const artifact = {
    correctnessFailureCount: diagnostics.correctnessFailureCount,
    fixtureSha256: diagnostics.fixtureSha256,
    productionBenchmark: diagnostics.productionBenchmark,
    observations: diagnostics.observations,
    source: diagnostics.source,
    createdAt: DateTime.formatIso(yield* DateTime.now),
    runtime: {architecture: system.architecture, platform: system.platform, version: system.runtimeVersion},
    expectedCiCommit: expectedCommit && COMMIT_PATTERN.test(expectedCommit) ? expectedCommit : undefined,
    observationPolicy:
      'Ordered wall samples; process CPU counters and boundary RSS observed outside the wall interval. CPU includes concurrent work in this process, excludes children; boundary RSS is not a phase peak. Source observations bracket the evaluation. Optional completed-span aggregates are inclusive and overlap; span lifecycle overhead remains inside the original measurement interval, while collector construction and snapshotting occur outside its counters. Counts saturate at one million and times at 24 hours. No queries, memory bodies, paths or exception bodies retained.',
    version: 1,
  };
  yield* atomicWrite(file, `${JSON.stringify(artifact, undefined, 2)}\n`);
  if (diagnostics.correctnessFailureCount > 0) {
    return yield* ScriptError.make({
      message: `Recall evaluation failed ${diagnostics.correctnessFailureCount} contract check(s).`,
    });
  }
  for (const [name, benchmark] of EffectRecord.toEntries(diagnostics.productionBenchmark.scenarios)) {
    if (benchmark.p95Milliseconds > benchmark.p95LimitMilliseconds) {
      return yield* ScriptError.make({
        message: `Recall ${name} benchmark p95 ${benchmark.p95Milliseconds.toFixed(2)}ms exceeds ${benchmark.p95LimitMilliseconds}ms.`,
      });
    }
  }
});
