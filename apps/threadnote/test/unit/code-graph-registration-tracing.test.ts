import {it as effectIt} from '@effect/vitest';
import {Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Option, Tracer} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, it} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {readFileSync} from '@threadnote/testing/node-fs';
import {benchmarkMeasurement, parseBenchmarkArtifactV1, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM} from '@threadnote/graph/materialized_shard_cache_admission';
import {
  createBenchmarkRegistrationTracing,
  BENCHMARK_REGISTRATION_SPAN_NAMES,
  serializeBenchmarkRegistrationTracing,
  enforceCodeGraphBenchmarkRatchet,
  PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS,
  type CodeGraphBenchmarkRatchetV1,
  type BenchmarkRegistrationTracing,
  withBenchmarkRegistrationTracing,
  measureBenchmarkIndex,
} from '../../../../scripts/benchmark-code-graph.js';

effectIt.effect('registration tracing keeps the disabled original Effect and execution identity', () =>
  Effect.gen(function* () {
    const value = {original: true};
    let calls = 0;
    const program = Effect.sync(() => {
      calls++;
      return value;
    });
    expect(withBenchmarkRegistrationTracing(program)).toBe(program);
    const tracing = createBenchmarkRegistrationTracing();
    const measured = yield* measureBenchmarkIndex(() => program, tracing);
    expect(measured.result).toBe(value);
    expect(calls).toBe(1);
  }),
);

effectIt.effect('registration tracing ends its exact window at the existing first scanning timestamp', () =>
  Effect.gen(function* () {
    const tracing = createBenchmarkRegistrationTracing();
    const measured = yield* measureBenchmarkIndex(
      timeline =>
        Effect.gen(function* () {
          const selected = Effect.fn('codeGraph.initializeSchema')(() => TestClock.adjust('3 millis'));
          yield* selected();
          const at = yield* Clock.currentTimeNanos;
          timeline.observe(
            {phase: 'scanning', accepted: 0, completed: 0, excluded: 0, skipped: 0, total: 1, unit: 'files'},
            at,
            {rssBytes: 0, peakRssBytes: 0, cpuUserMicroseconds: 0, cpuSystemMicroseconds: 0},
          );
          yield* selected();
        }),
      tracing,
    );
    expect(Number(measured.finishedAt - measured.startedAt) / 1_000_000).toBe(6);
    expect(tracing.snapshot().spans['codeGraph.initializeSchema']).toMatchObject({count: 1, wallTotalMilliseconds: 3});
    expect(tracing.snapshot().firstScanningObserved).toBe(true);
  }),
);

effectIt.effect('registration tracing adds no clock reads before or after its closed window', () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const reads: number[] = [];
    for (const enabled of [false, true]) {
      let count = 0;
      const now = () => {
        count++;
        return clock.currentTimeNanosUnsafe();
      };
      const tracing = enabled ? createBenchmarkRegistrationTracing() : undefined;
      const result = yield* measureBenchmarkIndex(
        timeline =>
          Effect.gen(function* () {
            const selected = Effect.fn(BENCHMARK_REGISTRATION_SPAN_NAMES[0])(() => Effect.succeed('original'));
            yield* selected();
            timeline.observe(
              {phase: 'scanning', accepted: 0, completed: 0, excluded: 0, skipped: 0, total: 1, unit: 'files'},
              yield* Clock.currentTimeNanos,
              {rssBytes: 0, peakRssBytes: 0, cpuUserMicroseconds: 0, cpuSystemMicroseconds: 0},
            );
            return yield* selected();
          }),
        tracing,
      ).pipe(
        Effect.provideService(Clock.Clock, {...clock, currentTimeNanosUnsafe: now, currentTimeNanos: Effect.sync(now)}),
      );
      expect(result.result).toBe('original');
      if (tracing) expect(tracing.snapshot().spans[BENCHMARK_REGISTRATION_SPAN_NAMES[0]]?.count).toBe(1);
      reads.push(count);
    }
    expect(reads[0]).toBeGreaterThanOrEqual(3);
    expect(reads[1]).toBe(reads[0]);
  }),
);

function span(
  tracing: BenchmarkRegistrationTracing,
  name: string = BENCHMARK_REGISTRATION_SPAN_NAMES[0],
  startTime = 0n,
) {
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

it('registration tracing excludes outside-window spans and drops rather than clips crossing spans', () => {
  const tracing = createBenchmarkRegistrationTracing();
  span(tracing).end(1n, Exit.void);
  tracing.begin(10n);
  span(tracing, 'private/path/body', 11n).end(12n, Exit.void);
  span(tracing, BENCHMARK_REGISTRATION_SPAN_NAMES[0], 9n).end(11n, Exit.void);
  const complete = span(tracing, BENCHMARK_REGISTRATION_SPAN_NAMES[0], 11n);
  const partial = span(tracing, BENCHMARK_REGISTRATION_SPAN_NAMES[0], 12n);
  complete.end(15n, Exit.void);
  complete.end(16n, Exit.fail('private'));
  tracing.close(16n);
  tracing.close(100n);
  partial.end(17n, Exit.void);
  span(tracing, BENCHMARK_REGISTRATION_SPAN_NAMES[0], 18n).end(19n, Exit.void);
  expect(tracing.snapshot()).toMatchObject({
    started: true,
    firstScanningObserved: true,
    partialSpans: 1,
    invalidSpans: 0,
    spans: {
      [BENCHMARK_REGISTRATION_SPAN_NAMES[0]]: {
        count: 1,
        successCount: 1,
        failureCount: 0,
        wallTotalMilliseconds: 0.000004,
      },
    },
  });
});

it('registration tracing reads no new span fields or exits after closure and retains no post-window records', () => {
  const tracing = createBenchmarkRegistrationTracing();
  tracing.begin(0n);
  tracing.close(1n);
  const before = tracing.snapshot();
  let reads = 0;
  const poison = new Proxy({} as Parameters<Tracer.Tracer['span']>[0], {
    get() {
      reads++;
      throw new Error('/private/body/token');
    },
  });
  const exit = new Proxy(Exit.void, {
    get() {
      reads++;
      throw new Error('/private/exit');
    },
  });
  for (let index = 0; index < 100; index++) {
    const ignored = tracing.tracer.span(poison);
    ignored.attribute('/private', poison);
    ignored.event('/private', 0n, {body: poison});
    ignored.end(2n, exit);
  }
  expect(reads).toBe(0);
  expect(tracing.snapshot()).toEqual(before);
});

it('registration tracing drops arbitrary metadata and invalid observations while bounding finite time and count', () => {
  const tracing = createBenchmarkRegistrationTracing();
  tracing.begin(0n);
  const poison = new Proxy(
    {},
    {
      get() {
        throw new Error('private metadata inspected');
      },
    },
  );
  const options = {
    name: BENCHMARK_REGISTRATION_SPAN_NAMES[0],
    startTime: 0n,
    get parent(): never {
      throw new Error('parent');
    },
    get annotations(): never {
      throw new Error('annotations');
    },
    get links(): never {
      throw new Error('links');
    },
    get kind(): never {
      throw new Error('kind');
    },
    get root(): never {
      throw new Error('root');
    },
    get sampled(): never {
      throw new Error('sampled');
    },
  };
  const measured = tracing.tracer.span(options);
  measured.attribute('private/path', poison);
  measured.event('private/body', 0n, {token: poison});
  measured.addLinks([{span: span(tracing, 'private'), attributes: {token: poison}}]);
  measured.end(10n ** 400n, Exit.fail(poison));
  span(tracing).end(-1n, Exit.void);
  expect(measured.attributes.size).toBe(0);
  expect(measured.links).toEqual([]);
  expect(measured instanceof Tracer.NativeSpan ? measured.events : []).toEqual([]);
  expect(tracing.snapshot()).toMatchObject({
    overflow: true,
    invalidSpans: 1,
    spans: {
      [BENCHMARK_REGISTRATION_SPAN_NAMES[0]]: {
        count: 1,
        wallTotalMilliseconds: 86_400_000,
        wallMaximumMilliseconds: 86_400_000,
      },
    },
  });
  for (let index = 0; index < 1_000_000; index++) span(tracing).end(0n, Exit.void);
  expect(tracing.snapshot().spans[BENCHMARK_REGISTRATION_SPAN_NAMES[0]]?.count).toBe(1_000_000);
  expect(serializeBenchmarkRegistrationTracing(tracing)!.length).toBeLessThanOrEqual(8192);
  expect(serializeBenchmarkRegistrationTracing(tracing)).not.toContain('private');
});

effectIt.effect('registration tracing preserves typed failure, defect and interruption finalizers', () =>
  Effect.gen(function* () {
    const tracing = createBenchmarkRegistrationTracing();
    tracing.begin(0n);
    const failure = {private: 'typed-body'};
    const defect = new Error('private defect');
    const failed = yield* withBenchmarkRegistrationTracing(
      Effect.fail(failure).pipe(Effect.withSpan(BENCHMARK_REGISTRATION_SPAN_NAMES[0])),
      tracing,
    ).pipe(Effect.result);
    expect(failed._tag === 'Failure' ? failed.failure : undefined).toBe(failure);
    const died = yield* withBenchmarkRegistrationTracing(
      Effect.die(defect).pipe(Effect.withSpan(BENCHMARK_REGISTRATION_SPAN_NAMES[0])),
      tracing,
    ).pipe(Effect.exit);
    expect(Exit.isFailure(died) ? Cause.squash(died.cause) : undefined).toBe(defect);
    const entered = yield* Deferred.make<void>();
    let finalized = 0;
    const child = yield* withBenchmarkRegistrationTracing(
      Effect.acquireUseRelease(
        Effect.void,
        () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        () =>
          Effect.sync(() => {
            finalized++;
          }),
      ).pipe(Effect.withSpan(BENCHMARK_REGISTRATION_SPAN_NAMES[0])),
      tracing,
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(child);
    expect(finalized).toBe(1);
    expect(tracing.snapshot().spans[BENCHMARK_REGISTRATION_SPAN_NAMES[0]]?.failureCount).toBe(3);
    tracing.close(yield* Clock.currentTimeNanos);
    const closed = tracing.snapshot();
    const afterClosure = yield* withBenchmarkRegistrationTracing(
      Effect.fail(failure).pipe(
        Effect.ensuring(Effect.sync(() => finalized++)),
        Effect.withSpan(BENCHMARK_REGISTRATION_SPAN_NAMES[0]),
      ),
      tracing,
    ).pipe(Effect.result);
    expect(afterClosure._tag === 'Failure' ? afterClosure.failure : undefined).toBe(failure);
    expect(finalized).toBe(2);
    expect(tracing.snapshot()).toEqual(closed);
    expect(serializeBenchmarkRegistrationTracing(tracing)).not.toContain('private');
  }),
);

effectIt.effect('registration bookkeeping failures cannot change original work or measurement completion', () =>
  Effect.gen(function* () {
    const tracing = createBenchmarkRegistrationTracing();
    const original = {result: true};
    let calls = 0;
    const broken = {
      ...tracing,
      begin() {
        throw new Error('begin');
      },
      close() {
        throw new Error('close');
      },
    };
    const measured = yield* measureBenchmarkIndex(
      timeline =>
        Effect.gen(function* () {
          calls++;
          timeline.observe(
            {phase: 'scanning', accepted: 0, completed: 0, excluded: 0, skipped: 0, total: 1, unit: 'files'},
            yield* Clock.currentTimeNanos,
            {rssBytes: 0, peakRssBytes: 0, cpuUserMicroseconds: 0, cpuSystemMicroseconds: 0},
          );
          return original;
        }),
      broken,
    );
    expect(measured.result).toBe(original);
    expect(calls).toBe(1);
    const attach = {
      ...tracing,
      get tracer(): never {
        throw new Error('attach');
      },
      snapshot(): never {
        throw new Error('snapshot');
      },
    };
    const program = Effect.succeed(original);
    expect(withBenchmarkRegistrationTracing(program, attach)).toBe(program);
    expect(serializeBenchmarkRegistrationTracing(attach)).toBeUndefined();
    const badOptions = {
      name: '',
      startTime: 0n,
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      kind: 'internal' as const,
      root: false,
      sampled: true,
    };
    Object.defineProperty(badOptions, 'name', {
      get() {
        throw new Error('span startup');
      },
    });
    expect(() => tracing.tracer.span(badOptions).end(0n, Exit.void)).not.toThrow();
    const badExit = Exit.fail('private');
    Object.defineProperty(badExit, '_tag', {
      get() {
        throw new Error('completion');
      },
    });
    expect(() => span(tracing).end(0n, badExit)).not.toThrow();
  }),
);

fcEffectProp(
  effectIt,
  'registration window summaries agree with an independent bounded event model and never mutate inputs',
  {
    events: fc.array(
      fc.record({
        name: fc.constantFrom(...BENCHMARK_REGISTRATION_SPAN_NAMES, '/private/body/token'),
        start: fc.integer({min: -5, max: 20}),
        duration: fc.integer({min: -3, max: 25}),
        success: fc.boolean(),
      }),
      {maxLength: 40},
    ),
    closed: fc.boolean(),
  },
  input =>
    Effect.sync(() => {
      const before = structuredClone(input);
      const tracing = createBenchmarkRegistrationTracing();
      tracing.begin(0n);
      const initial = tracing.snapshot();
      const pending = input.events.map(event => ({
        event,
        measured: span(tracing, event.name, BigInt(event.start) * 1_000_000n),
      }));
      if (input.closed) tracing.close(20_000_000n);
      const model: Record<
        string,
        {
          count: number;
          successCount: number;
          failureCount: number;
          wallTotalMilliseconds: number;
          wallMaximumMilliseconds: number;
        }
      > = {};
      let partialSpans = 0;
      let invalidSpans = 0;
      for (const {event, measured} of pending) {
        measured.end(
          BigInt(event.start + event.duration) * 1_000_000n,
          event.success ? Exit.void : Exit.fail('/private/body'),
        );
        measured.end(1_000_000_000n, Exit.void);
        if (!BENCHMARK_REGISTRATION_SPAN_NAMES.some(name => name === event.name) || event.start < 0) continue;
        if (event.duration < 0) {
          invalidSpans++;
          continue;
        }
        if (input.closed && event.start + event.duration > 20) {
          partialSpans++;
          continue;
        }
        const value = model[event.name] ?? {
          count: 0,
          successCount: 0,
          failureCount: 0,
          wallTotalMilliseconds: 0,
          wallMaximumMilliseconds: 0,
        };
        value.count++;
        value.successCount += Number(event.success);
        value.failureCount += Number(!event.success);
        value.wallTotalMilliseconds += event.duration;
        value.wallMaximumMilliseconds = Math.max(value.wallMaximumMilliseconds, event.duration);
        model[event.name] = value;
      }
      expect(tracing.snapshot()).toEqual({
        version: 1,
        started: true,
        firstScanningObserved: input.closed,
        partialSpans,
        invalidSpans,
        overflow: false,
        spans: model,
      });
      expect(initial.spans).toEqual({});
      expect(input).toEqual(before);
      const copied = tracing.snapshot();
      const first = Object.values(copied.spans)[0];
      if (first) Object.assign(first, {count: -1});
      expect(tracing.snapshot().spans).toEqual(model);
      const json = serializeBenchmarkRegistrationTracing(tracing)!;
      expect(json.length).toBeLessThanOrEqual(8192);
      expect(json).not.toContain('/private');
    }),
  {fastCheck: {numRuns: 20}},
);

it('registration diagnostic metadata preserves artifact fields and the original hard objective and closed assessment', () => {
  const ratchet = JSON.parse(
    readFileSync(
      'apps/threadnote/test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
      'utf8',
    ),
  ) as CodeGraphBenchmarkRatchetV1;
  const name = 'cold-registration-lock-and-database-setup';
  const required = new Map<string, BenchmarkArtifactV1['measurements'][number]['unit']>(
    PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS.map(item => [item.name, item.unit]),
  );
  for (const [key, limit] of Object.entries(ratchet.measurements)) required.set(key, limit.unit);
  const candidateCommit = 'b'.repeat(40);
  const controlCommit = 'a'.repeat(40);
  const evidenceValue = (key: string) => {
    if (key === 'cold-activation-observed-stages-n1') return 3;
    if (key.endsWith('-materialization-cached-fact-replay-bytes-n1'))
      return CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 2;
    if (
      key.endsWith('-materialization-cached-fact-bytes-total-n1') ||
      key.endsWith('-materialization-raw-fact-replay-bytes-n1') ||
      key.endsWith('-materialized-shard-cache-deferred-raw-fact-bytes-n1')
    )
      return CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 1;
    if (
      /-materialization-subphase-shard-(?:association|persistence|serialization)-n1$/u.test(key) ||
      key.endsWith('-materialization-sidecar-wal-high-water-n1') ||
      key.includes('failures-n1') ||
      (key.startsWith('cold-activation-copying-') && key.endsWith('-observed-n1')) ||
      key === 'one-file-reindex-materialization-stage-restoring-indexes-n1'
    )
      return 0;
    if (key.endsWith('sampler-version-n1')) return 4;
    if (key.startsWith('production-shape-')) return 100;
    if (key.endsWith('activation-observed-stages-n1')) return 32;
    return ratchet.measurements[key]?.minimum ?? 1;
  };
  const artifact = (commit: string, registration: number, minute: number): BenchmarkArtifactV1 => ({
    version: 1,
    suite: ratchet.suite,
    warmups: 0,
    createdAt: `2026-10-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
    environment: {
      architecture: 'x64',
      commit,
      cpu: 'synthetic',
      dirty: false,
      fixtureHash: String(ratchet.environment.fixtureHash),
      memoryBytes: 16_000_000_000,
      node: 'bun/1.4.2',
      operatingSystem: 'Linux',
      packageManager: 'bun/1.4.2',
      runner: 'threadnote-code-graph-e2e',
      runnerVersion: '1',
    },
    metadata: {
      ...ratchet.metadata,
      benchmarkDiskMedium: 'virtual-or-network',
      benchmarkReferenceDiskMedium: 'virtual-or-network',
      benchmarkMeasuredExecutionMode: 'local-source-application-layer',
      benchmarkMeasuredSourceCommit: commit,
      benchmarkMeasuredSourceLockfileSha256: 'a'.repeat(64),
      benchmarkMeasuredSourcePackageManifestSha256: 'b'.repeat(64),
      benchmarkValidatedManagedPayload: 'not-applicable-github-actions-clean-source',
      benchmarkPrimaryAvailableBytesAtStart: 100_000_000_000,
      benchmarkReferenceAvailableBytesAtStart: 100_000_000_000,
      runnerIdentity: 'synthetic-runner',
      sameRunnerComparisonKey: 'synthetic-same-runner',
    },
    measurements: [...required].map(([key, unit]) =>
      benchmarkMeasurement(key, unit, [key === name ? registration : evidenceValue(key)]),
    ),
  });
  const initial = artifact(candidateCommit, 6243.82131, 0);
  const control = artifact(controlCommit, 446.739343, 1);
  const candidate = artifact(candidateCommit, 426.954365, 2);
  const tracing = createBenchmarkRegistrationTracing();
  tracing.begin(0n);
  span(tracing).end(1n, Exit.void);
  tracing.close(2n);
  const before = structuredClone(initial);
  const withDiagnostics = (value: BenchmarkArtifactV1): BenchmarkArtifactV1 => ({
    ...value,
    metadata: {...value.metadata, coldRegistrationExistingSpans: serializeBenchmarkRegistrationTracing(tracing)!},
  });
  const observed = withDiagnostics(initial);
  expect(parseBenchmarkArtifactV1(observed).measurements).toEqual(initial.measurements);
  expect(initial).toEqual(before);
  expect(() =>
    enforceCodeGraphBenchmarkRatchet(candidate, ratchet, {
      artifact: control,
      expectedCandidateCommit: candidateCommit,
      expectedCommit: controlCommit,
      initialCandidateArtifact: initial,
    }),
  ).toThrow(
    /initial candidate production ratchet objective cold-registration-lock-and-database-setup has not been attained: p95 6243\.82131 exceeds 4999/u,
  );
  expect(() =>
    enforceCodeGraphBenchmarkRatchet(withDiagnostics(candidate), ratchet, {
      artifact: withDiagnostics(control),
      expectedCandidateCommit: candidateCommit,
      expectedCommit: controlCommit,
      initialCandidateArtifact: observed,
    }),
  ).toThrow(
    /initial candidate production ratchet objective cold-registration-lock-and-database-setup has not been attained: p95 6243\.82131 exceeds 4999/u,
  );
  expect(() =>
    enforceCodeGraphBenchmarkRatchet(
      {
        ...candidate,
        measurements: [
          ...candidate.measurements,
          benchmarkMeasurement('unknown-registration-stage', 'milliseconds', [1]),
        ],
      },
      ratchet,
    ),
  ).toThrow(/ungoverned/u);
  expect(() =>
    enforceCodeGraphBenchmarkRatchet(
      {...candidate, measurements: [...candidate.measurements, candidate.measurements[0]]},
      ratchet,
    ),
  ).toThrow(/unique assessed measurement names/u);
});
