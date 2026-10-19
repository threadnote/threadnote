import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Record} from 'effect';
import {expect, it} from 'vitest';
import fc from 'fast-check';
import {
  measureRecallEvaluationSample,
  recallEvaluationScenario,
  writeRecallEvaluationDiagnosticsAndEnforce,
  type RecallEvaluationSample,
  type RecallEvaluationDiagnostics,
} from '../../../../scripts/evaluate-recall-diagnostics.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

const observation = (wallMilliseconds: number): RecallEvaluationSample => ({
  wallMilliseconds,
  cpuUserMilliseconds: 2,
  cpuSystemMilliseconds: 1,
  rssBeforeBytes: 100,
  rssAfterBytes: 120,
});

function diagnostics(durations: readonly number[], limit = 150): RecallEvaluationDiagnostics {
  const measurements = {
    coldDecode: {durations: [1, 2, 3, 4, 5], limit: 1000},
    exactNoHit: {durations: Array<number>(25).fill(3), limit: 150},
    exactSubstring: {durations: Array<number>(25).fill(4), limit: 150},
    hotQuery: {durations, limit},
    incrementalUpdate: {durations: Array<number>(40).fill(600), limit: 2000},
    sourceValidation: {durations: [600, 700, 800], limit: 2000},
  };
  const observations = Record.map(measurements, value => value.durations.map(observation));
  const scenarios = Record.map(measurements, (value, name) =>
    recallEvaluationScenario(observations[name], value.limit),
  );
  return {
    correctnessFailureCount: 0,
    productionBenchmark: {documents: 10000, scenarios, warmups: 5},
    observations,
    source: {before: {commit: 'a'.repeat(40), dirty: false}, after: {commit: 'a'.repeat(40), dirty: false}},
  };
}

effectIt.effect('retains ordered negative evidence before the original strict budget failure', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'recall-diagnostics-'});
    const output = path.join(root, 'artifacts', 'recall.json');
    const durations = [160, ...Array<number>(23).fill(72.060642), 150.876683];
    const evidence = diagnostics(durations);
    const result = yield* writeRecallEvaluationDiagnosticsAndEnforce(output, evidence).pipe(Effect.result);
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure.message).toBe('Recall hotQuery benchmark p95 150.88ms exceeds 150ms.');
    const artifact = JSON.parse(yield* fs.readFileString(output));
    expect(artifact.version).toBe(1);
    expect(artifact.observations.hotQuery.map((sample: RecallEvaluationSample) => sample.wallMilliseconds)).toEqual(
      durations,
    );
    expect(artifact.productionBenchmark.scenarios.hotQuery).toEqual({
      p50Milliseconds: 72.060642,
      p95Milliseconds: 150.876683,
      p95LimitMilliseconds: 150,
      samples: 25,
    });
    expect(artifact.source).toEqual(evidence.source);
  }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
);

effectIt.effect('writes passing and correctness-failed evidence without weakening their outcomes', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'recall-diagnostics-outcomes-'});
    const passing = diagnostics(Array<number>(25).fill(150));
    yield* writeRecallEvaluationDiagnosticsAndEnforce(`${root}/pass.json`, passing);
    expect(
      JSON.parse(yield* fs.readFileString(`${root}/pass.json`)).productionBenchmark.scenarios.hotQuery.p95Milliseconds,
    ).toBe(150);
    const failed = yield* writeRecallEvaluationDiagnosticsAndEnforce(`${root}/correctness.json`, {
      ...passing,
      correctnessFailureCount: 2,
    }).pipe(Effect.result);
    expect(failed._tag).toBe('Failure');
    if (failed._tag === 'Failure') expect(failed.failure.message).toBe('Recall evaluation failed 2 contract check(s).');
    expect(JSON.parse(yield* fs.readFileString(`${root}/correctness.json`)).correctnessFailureCount).toBe(2);
  }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
);

effectIt.effect('observes one effect without changing its result or executing it twice', () =>
  Effect.gen(function* () {
    let calls = 0;
    const measured = yield* measureRecallEvaluationSample(() => Effect.sync(() => ++calls));
    expect(measured.result).toBe(1);
    expect(calls).toBe(1);
    for (const value of Object.values(measured.observation)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  }),
);

it('preserves sample order/input bytes and the existing percentile definition across bounded samples', () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({min: 0, max: 100000}), {minLength: 1, maxLength: 40}),
      fc.integer({min: 0, max: 2000}),
      (durations, limit) => {
        const samples = durations.map(observation);
        const before = JSON.stringify(samples);
        const sorted = [...durations].sort((left, right) => left - right);
        const summary = recallEvaluationScenario(samples, limit);
        expect(summary).toEqual({
          p50Milliseconds: sorted[Math.floor(sorted.length / 2)],
          p95Milliseconds: sorted[Math.floor(sorted.length * 0.95)],
          p95LimitMilliseconds: limit,
          samples: sorted.length,
        });
        expect(JSON.stringify(samples)).toBe(before);
      },
    ),
    {numRuns: 80},
  );
});
