import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Option, Tracer} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, it} from 'vitest';
import fc from 'fast-check';
import {
  createRecallEvaluationTracing,
  RECALL_EVALUATION_SPAN_NAMES,
  snapshotRecallEvaluationTracing,
  withRecallEvaluationTracing,
  type RecallEvaluationTracing,
} from '../../../../scripts/evaluate-recall-tracing.js';
import {
  measureRecallEvaluationSample,
  recallEvaluationScenario,
  writeRecallEvaluationDiagnosticsAndEnforce,
  type RecallEvaluationSample,
  type RecallEvaluationDiagnostics,
} from '../../../../scripts/evaluate-recall-diagnostics.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

function span(tracing: RecallEvaluationTracing, name = 'recall.prepareSections', startTime = 0n) {
  return tracing.tracer.span({
    name,
    startTime,
    parent: Option.none(),
    annotations: Context.empty(),
    links: [],
    kind: 'internal',
    root: false,
    sampled: true,
  });
}

effectIt.effect('keeps tracing opt-in and runs the original measured effect exactly once', () =>
  Effect.gen(function* () {
    let calls = 0;
    const original = Effect.sync(() => ++calls);
    expect(withRecallEvaluationTracing(original)).toBe(original);
    const disabled = yield* measureRecallEvaluationSample(() => original);
    expect(disabled.observation).not.toHaveProperty('spans');
    const prepare = Effect.fn('recall.prepareSections')(() => original);
    const enabled = yield* measureRecallEvaluationSample(() => prepare(), {trace: true});
    expect(calls).toBe(2);
    expect(enabled.result).toBe(2);
    expect(enabled.observation.spans?.['recall.prepareSections']?.count).toBe(1);
    for (const value of Object.values(enabled.observation.spans?.['recall.prepareSections'] ?? {})) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  }),
);

effectIt.effect('retains the original clock interval and reports overlapping nested span times', () =>
  Effect.gen(function* () {
    const measured = yield* measureRecallEvaluationSample(
      () =>
        TestClock.adjust('7 millis').pipe(
          Effect.as('original'),
          Effect.withSpan('recall.loadIndexDataBatch'),
          Effect.withSpan('recall.prepareSections'),
        ),
      {trace: true},
    );
    expect(measured.result).toBe('original');
    expect(measured.observation.wallMilliseconds).toBe(7);
    expect(measured.observation.spans?.['recall.prepareSections']?.wallTotalMilliseconds).toBe(7);
    expect(measured.observation.spans?.['recall.loadIndexDataBatch']?.wallTotalMilliseconds).toBe(7);
  }),
);

effectIt.effect('preserves typed failures, defects and interruption cleanup with tracing enabled', () =>
  Effect.gen(function* () {
    const tracing = createRecallEvaluationTracing();
    const failure = {private: 'typed-error-body'};
    const failed = yield* withRecallEvaluationTracing(
      Effect.fail(failure).pipe(Effect.withSpan('recall.prepareSections')),
      tracing,
    ).pipe(Effect.result);
    expect(failed._tag).toBe('Failure');
    if (failed._tag === 'Failure') expect(failed.failure).toBe(failure);
    const defect = new Error('private-defect-body');
    const died = yield* withRecallEvaluationTracing(
      Effect.die(defect).pipe(Effect.withSpan('recall.prepareSections')),
      tracing,
    ).pipe(Effect.exit);
    expect(Exit.isFailure(died)).toBe(true);
    if (Exit.isFailure(died)) expect(Cause.squash(died.cause)).toBe(defect);
    const entered = yield* Deferred.make<void>();
    let finalized = 0;
    const child = yield* withRecallEvaluationTracing(
      Effect.acquireUseRelease(
        Effect.void,
        () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        () =>
          Effect.sync(() => {
            finalized += 1;
          }),
      ).pipe(Effect.withSpan('recall.prepareSections')),
      tracing,
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(child);
    expect(finalized).toBe(1);
    expect(tracing.snapshot()['recall.prepareSections']).toMatchObject({count: 3, successCount: 0, failureCount: 3});
    expect(JSON.stringify(tracing.snapshot())).not.toContain('private');
  }),
);

it('drops metadata without inspecting it and ends each span only once', () => {
  const tracing = createRecallEvaluationTracing();
  const poison = new Proxy(
    {},
    {
      get() {
        throw new Error('metadata inspected');
      },
    },
  );
  const options = {
    name: 'recall.prepareSections',
    startTime: 1_000_000n,
    get parent(): never {
      throw new Error('parent inspected');
    },
    get annotations(): never {
      throw new Error('annotations inspected');
    },
    get links(): never {
      throw new Error('links inspected');
    },
    get kind(): never {
      throw new Error('kind inspected');
    },
    get root(): never {
      throw new Error('root inspected');
    },
    get sampled(): never {
      throw new Error('sampled inspected');
    },
  };
  const measured = tracing.tracer.span(options);
  measured.attribute('private-query', poison);
  measured.event('private-path', 0n, {private: poison});
  measured.addLinks([{span: span(tracing, 'private-name'), attributes: {private: poison}}]);
  measured.end(4_000_000n, Exit.fail(poison));
  measured.end(100_000_000n, Exit.succeed(poison));
  expect(measured.status._tag).toBe('Ended');
  if (measured.status._tag === 'Ended') expect(Exit.isFailure(measured.status.exit)).toBe(true);
  expect(tracing.snapshot()).toEqual({
    'recall.prepareSections': {
      count: 1,
      wallTotalMilliseconds: 3,
      wallMaximumMilliseconds: 3,
      successCount: 0,
      failureCount: 1,
    },
  });
  expect(measured.attributes.size).toBe(0);
  expect(measured.links).toEqual([]);
  expect(measured instanceof Tracer.NativeSpan ? measured.events : undefined).toEqual([]);
});

it('ignores unknown labels and invalid times and saturates finite timings', () => {
  const tracing = createRecallEvaluationTracing();
  span(tracing, 'private-query').end(1n, Exit.void);
  span(tracing, '__proto__').end(1n, Exit.void);
  span(tracing, 'recall.prepareSections', -1n).end(1n, Exit.void);
  span(tracing).end(-1n, Exit.void);
  span(tracing).end(10n ** 400n, Exit.void);
  expect(tracing.snapshot()).toEqual({});
  span(tracing).end(10n ** 20n, Exit.void);
  expect(tracing.snapshot()['recall.prepareSections']).toEqual({
    count: 1,
    wallTotalMilliseconds: 86_400_000,
    wallMaximumMilliseconds: 86_400_000,
    successCount: 1,
    failureCount: 0,
  });
});

it('contains observer attachment and snapshot defects without replacing the original effect', () => {
  const original = Effect.succeed('original');
  const broken = {
    get tracer(): never {
      throw new Error('observer setup');
    },
    snapshot(): never {
      throw new Error('observer snapshot');
    },
  };
  expect(withRecallEvaluationTracing(original, broken)).toBe(original);
  expect(snapshotRecallEvaluationTracing(broken)).toBeUndefined();
  expect(snapshotRecallEvaluationTracing()).toBeUndefined();
  const options = {
    name: 'ignored',
    startTime: 0n,
    parent: Option.none(),
    annotations: Context.empty(),
    links: [],
    kind: 'internal' as const,
    root: false,
    sampled: true,
  };
  Object.defineProperty(options, 'name', {
    get() {
      throw new Error('invalid span');
    },
  });
  expect(() => createRecallEvaluationTracing().tracer.span(options).end(0n, Exit.void)).not.toThrow();
  const brokenExit = Exit.fail('private-cause');
  Object.defineProperty(brokenExit, '_tag', {
    get() {
      throw new Error('invalid exit');
    },
  });
  expect(() => span(createRecallEvaluationTracing()).end(0n, brokenExit)).not.toThrow();
});

it('keeps bounded closed aggregates, repeated-end idempotence and detached snapshots for arbitrary outcomes', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          name: fc.oneof(fc.constantFrom(...RECALL_EVALUATION_SPAN_NAMES), fc.string()),
          milliseconds: fc.integer({min: 0, max: 100000}),
          success: fc.boolean(),
        }),
        {maxLength: 40},
      ),
      inputs => {
        const before = JSON.stringify(inputs);
        const tracing = createRecallEvaluationTracing();
        for (const input of inputs) {
          const measured = span(tracing, input.name);
          const exit = input.success ? Exit.succeed('private-result') : Exit.fail('private-cause');
          measured.end(BigInt(input.milliseconds) * 1_000_000n, exit);
          measured.end(0n, exit);
        }
        const snapshot = tracing.snapshot();
        expect(Object.keys(snapshot).length).toBeLessThanOrEqual(12);
        for (const name of RECALL_EVALUATION_SPAN_NAMES) {
          const matching = inputs.filter(input => input.name === name);
          if (matching.length === 0) {
            expect(snapshot[name]).toBeUndefined();
            continue;
          }
          expect(snapshot[name]).toEqual({
            count: matching.length,
            wallTotalMilliseconds: matching.reduce((total, input) => total + input.milliseconds, 0),
            wallMaximumMilliseconds: Math.max(...matching.map(input => input.milliseconds)),
            successCount: matching.filter(input => input.success).length,
            failureCount: matching.filter(input => !input.success).length,
          });
        }
        const serialized = JSON.stringify(snapshot);
        Object.assign(snapshot, {private: 'snapshot-only'});
        const first = Object.values(snapshot)[0];
        if (typeof first === 'object') Object.assign(first, {count: -1});
        expect(JSON.stringify(tracing.snapshot())).toBe(serialized);
        expect(JSON.stringify(inputs)).toBe(before);
        expect(serialized).not.toContain('private');
      },
    ),
    {numRuns: 20},
  );
});

effectIt.effect(
  'retains the actual 162.324678ms failure and optional spans before refusing the original 150ms gate',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'recall-trace-gate-'});
      const durations = [
        145.04362, 146.132058, 154.207252, 156.819808, 162.324678, 140.073942, 157.62149, 155.149894, 151.513034,
        151.830672, 180.148153, 146.172096, 147.116702, 143.614352, 141.36229, 147.417291, 143.427085, 135.353378,
        139.832157, 150.637828, 148.031868, 155.348908, 143.776632, 147.447875, 147.304673,
      ];
      const tracing = createRecallEvaluationTracing();
      span(tracing).end(1_000_000n, Exit.void);
      const observation = (wallMilliseconds: number): RecallEvaluationSample => ({
        wallMilliseconds,
        cpuUserMilliseconds: 0,
        cpuSystemMilliseconds: 0,
        rssBeforeBytes: 0,
        rssAfterBytes: 0,
        spans: tracing.snapshot(),
      });
      const observations = {
        coldDecode: [observation(0)],
        exactNoHit: [observation(0)],
        exactSubstring: [observation(0)],
        hotQuery: durations.map(observation),
        incrementalUpdate: [observation(0)],
        sourceValidation: [observation(0)],
      };
      const evidence: RecallEvaluationDiagnostics = {
        correctnessFailureCount: 0,
        productionBenchmark: {
          documents: 10000,
          warmups: 5,
          scenarios: {
            coldDecode: recallEvaluationScenario(observations.coldDecode, 1000),
            exactNoHit: recallEvaluationScenario(observations.exactNoHit, 150),
            exactSubstring: recallEvaluationScenario(observations.exactSubstring, 150),
            hotQuery: recallEvaluationScenario(observations.hotQuery, 150),
            incrementalUpdate: recallEvaluationScenario(observations.incrementalUpdate, 2000),
            sourceValidation: recallEvaluationScenario(observations.sourceValidation, 2000),
          },
        },
        observations,
        source: {before: {}, after: {}},
      };
      const before = JSON.stringify(evidence);
      const result = yield* writeRecallEvaluationDiagnosticsAndEnforce(`${root}/failure.json`, evidence).pipe(
        Effect.result,
      );
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure')
        expect(result.failure.message).toBe('Recall hotQuery benchmark p95 162.32ms exceeds 150ms.');
      const artifact = JSON.parse(yield* fs.readFileString(`${root}/failure.json`));
      expect(artifact.observations).toEqual(observations);
      expect(artifact.productionBenchmark.scenarios.hotQuery.p95Milliseconds).toBe(162.324678);
      expect(artifact.productionBenchmark.scenarios.hotQuery.p95LimitMilliseconds).toBe(150);
      expect(artifact.version).toBe(1);
      expect(JSON.stringify(evidence)).toBe(before);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
);
