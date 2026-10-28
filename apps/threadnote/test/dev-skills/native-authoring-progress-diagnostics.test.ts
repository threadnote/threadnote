import {it as effectIt} from '@effect/vitest';
import {Cause, Context, Deferred, Effect, Exit, Fiber, Option, Schema, Tracer} from 'effect';
import {readFileSync} from '@threadnote/testing/node-fs';
import {expect} from 'vitest';
import {
  classifyNativeProgress,
  CurrentNativeProgress,
  makeNativeProgressDiagnostics,
  nativeProgressBoundaries,
  nativeProgressFacades,
  nativeProgressMethod,
  nativeProgressSpanLabels,
  observeNativeBody,
  observeNativeBoundary,
  reportNativeFailure,
  type NativeProgressBoundary,
} from './native-authoring-progress-diagnostics.js';
import {closeoutSpanDiagnostics} from './native-closeout-span-diagnostics.js';

const spanOptions = (name: string, parent: Option.Option<Tracer.AnySpan> = Option.none()) => ({
  name,
  parent,
  annotations: Context.empty(),
  links: [],
  startTime: 1_000_000n,
  kind: 'internal' as const,
  root: Option.isNone(parent),
  sampled: true,
});
const make = (options: Parameters<typeof makeNativeProgressDiagnostics>[1] = {}) =>
  makeNativeProgressDiagnostics(Tracer.nativeTracer, {now: () => 0, sink: () => {}, ...options});

effectIt.effect('forwards the original call/read Effects, arguments, options and receivers exactly once', () =>
  Effect.gen(function* () {
    const observer = make();
    const input = {action: 'authoring', command: 'save', body: 'PRIVATE'};
    const config = {private: true};
    const result = {private: true};
    let constructed = 0;
    let executed = 0;
    const service = {
      call(request: unknown, settings: unknown) {
        expect(this).toBe(service);
        expect(request).toBe(input);
        expect(settings).toBe(config);
        constructed++;
        return Effect.sync(() => {
          executed++;
          return result;
        });
      },
    };
    const call = nativeProgressMethod(service, service.call, classifyNativeProgress, observer);
    const program = call(input, config);
    expect(constructed).toBe(1);
    expect(executed).toBe(0);
    expect(yield* program).toBe(result);
    expect(constructed).toBe(1);
    expect(executed).toBe(1);
    const location = {account: 'a', home: 'PRIVATE', user: 'u'};
    const options = {limit: 1};
    let rawCalls = 0;
    let fsCalls = 0;
    const store = {
      read(actualLocation: typeof location, uri: string, actualOptions?: unknown) {
        expect(this).toBe(store);
        expect(actualLocation).toBe(location);
        expect(uri).toBe('PRIVATE');
        expect(actualOptions).toBe(options);
        rawCalls++;
        return Effect.succeed('original bytes');
      },
      remove: () => Effect.succeed('unchanged remove'),
      unexpectedRead: () => {
        throw new Error('Unexpected diagnostic read');
      },
    };
    const fs = {
      readFileString(path: string, encoding?: string) {
        expect(this).toBe(fs);
        expect(['PRIVATE/state', 'PRIVATE/other']).toContain(path);
        expect(encoding).toBe('utf8');
        fsCalls++;
        return Effect.succeed('original state');
      },
      rename: () => Effect.succeed('unchanged rename'),
      stat: () => {
        throw new Error('Unexpected diagnostic stat');
      },
    };
    const returned = nativeProgressFacades(store, fs, 'PRIVATE/state', observer);
    expect(nativeProgressFacades(store, fs, 'PRIVATE/other', observer).store).toBe(returned.store);
    expect(nativeProgressFacades({...store}, fs, 'PRIVATE/state', observer).store).not.toBe(returned.store);
    expect(nativeProgressFacades(store, fs, 'PRIVATE/state', make()).store).not.toBe(returned.store);
    expect(yield* returned.store.read(location, 'PRIVATE', options)).toBe('original bytes');
    expect(yield* returned.fs.readFileString('PRIVATE/state', 'utf8')).toBe('original state');
    expect(yield* returned.fs.readFileString('PRIVATE/other', 'utf8')).toBe('original state');
    expect(yield* returned.store.remove()).toBe('unchanged remove');
    expect(yield* returned.fs.rename()).toBe('unchanged rename');
    expect(returned.store.remove).toBe(store.remove);
    expect(returned.fs.rename).toBe(fs.rename);
    expect(rawCalls).toBe(1);
    expect(fsCalls).toBe(2);
    expect(observer.snapshot().counters['fixture-state-read'].succeeded).toBe(1);
    expect(observer.snapshot().counters['fixture-raw-store-read'].succeeded).toBe(1);
    observer.reportFailure(); // No delegate read/stat is needed to report.
    expect(rawCalls).toBe(1);
    expect(fsCalls).toBe(2);
    const unchanged = nativeProgressFacades(store, fs, 'PRIVATE/state', undefined);
    expect(unchanged.store).toBe(store);
    expect(unchanged.fs).toBe(fs);
    const thrown = new Error('PRIVATE construction failure');
    let throws = 0;
    const throwing = nativeProgressMethod(
      undefined,
      () => {
        throws++;
        throw thrown;
      },
      () => 'other',
      observer,
    );
    expect(() => throwing()).toThrow(thrown);
    expect(throws).toBe(1);
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
  }),
);

effectIt.effect('retains the single original program, body snapshot and scope owner through interruption', () =>
  Effect.gen(function* () {
    const outer = closeoutSpanDiagnostics();
    const packets: string[] = [];
    let executions = 0;
    let provisions = 0;
    let cleanups = 0;
    let native: ReturnType<typeof make> | undefined;
    const entered = yield* Deferred.make<void>();
    const original = Effect.gen(function* () {
      executions++;
      native = yield* CurrentNativeProgress;
      return yield* observeNativeBoundary(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        native!,
        'authoring-save',
      );
    });
    const child = yield* Effect.gen(function* () {
      const observer = makeNativeProgressDiagnostics(yield* Effect.tracer, {
        sink: line => {
          expect(cleanups).toBe(1);
          packets.push(line);
        },
      });
      const inner = observeNativeBody(original, observer).pipe(Effect.provideService(CurrentNativeProgress, observer));
      // The existing layer owner is represented by its own scope, never by an observer-owned scope.
      const provided = Effect.scoped(
        Effect.gen(function* () {
          provisions++;
          yield* Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              cleanups++;
            }),
          );
          return yield* inner;
        }),
      );
      return yield* reportNativeFailure(provided.pipe(Effect.withTracer(observer.tracer)), observer);
    }).pipe(Effect.withTracer(outer.tracer), Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(child);
    const exit = yield* Fiber.await(child);
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect([executions, provisions, cleanups, packets.length]).toEqual([1, 1, 1, 1]);
    expect(native!.snapshot()).toMatchObject({
      bodyEntered: true,
      bodyExited: true,
      activeCount: 0,
      bodyExitSnapshot: {saveStarted: 1, saveSucceeded: 0, lastBoundary: {label: 'authoring-save', outcome: 'Failure'}},
    });
    expect(outer.snapshot().totals).toEqual({}); // Public wrapper names are intentionally new to the outer allowlist.
    native!.reportFailure();
    expect(packets).toHaveLength(1);
  }),
);

effectIt.effect('reports acquisition and cleanup failures after finalization and emits nothing on success', () =>
  Effect.gen(function* () {
    const value = {private: true};
    const cleanupDefect = {cleanup: true};
    const lines: string[] = [];
    const success = make({sink: line => lines.push(line)});
    expect(yield* reportNativeFailure(observeNativeBody(Effect.succeed(value), success), success)).toBe(value);
    expect(lines).toHaveLength(0);
    const acquisition = make({sink: line => lines.push(line)});
    const notEntered = Effect.fail(value).pipe(Effect.andThen(observeNativeBody(Effect.void, acquisition)));
    const acquisitionExit = yield* reportNativeFailure(notEntered, acquisition).pipe(Effect.exit);
    if (Exit.isFailure(acquisitionExit)) expect(Cause.squash(acquisitionExit.cause)).toBe(value);
    else throw new Error('Expected acquisition failure');
    expect(acquisition.snapshot()).toMatchObject({bodyEntered: false, bodyExited: false});
    const observer = make({sink: line => lines.push(line)});
    const cleanupExit = yield* reportNativeFailure(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.void, () => Effect.die(cleanupDefect));
          return yield* observeNativeBody(Effect.fail(value), observer);
        }),
      ),
      observer,
    ).pipe(Effect.exit);
    if (Exit.isFailure(cleanupExit)) {
      expect(cleanupExit.cause.reasons.some(reason => Cause.isFailReason(reason) && reason.error === value)).toBe(true);
      expect(
        cleanupExit.cause.reasons.some(reason => Cause.isDieReason(reason) && reason.defect === cleanupDefect),
      ).toBe(true);
    } else throw new Error('Expected composed cleanup failure');
    expect(observer.snapshot()).toMatchObject({bodyEntered: true, bodyExited: true});
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1].slice(lines[1].indexOf('{'))).outerFailure).toBe(true);
  }),
);

effectIt.effect('conserves NativeSpan identity, delegation, context and both composed observers', () =>
  Effect.gen(function* () {
    const outer = closeoutSpanDiagnostics(() => 0);
    const created: Tracer.Span[] = [];
    const ends: [bigint, Exit.Exit<unknown, unknown>][] = [];
    const contextResult = {private: true};
    const contextCalls: unknown[][] = [];
    const delegate: Tracer.Tracer = Tracer.make({
      span(options) {
        expect(this).toBe(delegate);
        const span = outer.tracer.span(options);
        created.push(span);
        const end = span.end.bind(span);
        span.end = (at, exit) => {
          ends.push([at, exit]);
          end(at, exit);
        };
        return span;
      },
      context(...args) {
        expect(this).toBe(delegate);
        contextCalls.push(args);
        return contextResult as never;
      },
    });
    const observer = makeNativeProgressDiagnostics(delegate, {now: () => 0});
    const parent = observer.tracer.span(spanOptions('PRIVATE.parent'));
    const options = spanOptions('workflowMemory.readJournalFile', Option.some(parent));
    const span = observer.tracer.span(options);
    expect(created).toHaveLength(2);
    expect(span).toBe(created[1]);
    expect(span).toBeInstanceOf(Tracer.NativeSpan);
    expect(span.parent).toBe(options.parent);
    expect(span.annotations).toBe(options.annotations);
    expect(span.links).toBe(options.links);
    expect(span.traceId).toBe(parent.traceId);
    const failed = Exit.fail(contextResult);
    const passed = Exit.succeed(contextResult);
    span.end(3_000_000n, failed);
    span.end(4_000_000n, passed);
    expect(ends).toEqual([
      [3_000_000n, failed],
      [4_000_000n, passed],
    ]);
    expect(ends[0][1]).toBe(failed);
    expect(ends[1][1]).toBe(passed);
    if (span.status._tag === 'Ended') {
      expect(span.status.endTime).toBe(4_000_000n);
      expect(span.status.exit).toBe(passed);
    }
    expect(observer.snapshot().totals['workflowMemory.readJournalFile']).toEqual({
      started: 1,
      ended: 1,
      failed: 1,
      inclusiveMs: 2,
    });
    expect(outer.snapshot().totals['workflowMemory.readJournalFile'].ended).toBe(1);
    const primitive = {} as Tracer.EffectPrimitive<unknown>;
    const fiber = yield* Effect.fiber;
    expect(observer.tracer.context!(primitive, fiber)).toBe(contextResult);
    expect(contextCalls[0][0]).toBe(primitive);
    expect(contextCalls[0][1]).toBe(fiber);
    const unknown = make().tracer.span(spanOptions('PRIVATE.unknown'));
    expect(unknown.end).toBe(Tracer.NativeSpan.prototype.end);
  }),
);

effectIt.effect(
  'keeps native parent objects through unobserved spans and completes interrupted spans after cleanup',
  () =>
    Effect.gen(function* () {
      const outer = closeoutSpanDiagnostics();
      const observer = makeNativeProgressDiagnostics(outer.tracer);
      const entered = yield* Deferred.make<void>();
      let cleaned = 0;
      let root: Tracer.Span | undefined;
      let middle: Tracer.Span | undefined;
      let leaf: Tracer.Span | undefined;
      const child = yield* Effect.gen(function* () {
        root = yield* Effect.currentSpan;
        return yield* Effect.gen(function* () {
          middle = yield* Effect.currentSpan;
          return yield* Effect.acquireUseRelease(
            Effect.void,
            () =>
              Effect.gen(function* () {
                leaf = yield* Effect.currentSpan;
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              }),
            () =>
              Effect.sync(() => {
                cleaned++;
              }),
          ).pipe(Effect.withSpan('workflowMemory.readJournalFile'));
        }).pipe(Effect.withSpan('PRIVATE.unknown'));
      }).pipe(Effect.withSpan('workflowMemory.writeJournalFile'), Effect.withTracer(observer.tracer), Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(child);
      const exit = yield* Fiber.await(child);
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(cleaned).toBe(1);
      expect(Option.getOrUndefined(leaf!.parent)).toBe(middle);
      expect(Option.getOrUndefined(middle!.parent)).toBe(root);
      expect(leaf!.traceId).toBe(root!.traceId);
      expect(leaf!.status._tag).toBe('Ended');
      for (const diagnostic of [observer, outer]) {
        expect(diagnostic.snapshot().activeCount).toBe(0);
        expect(diagnostic.snapshot().totals['workflowMemory.readJournalFile'].ended).toBe(1);
      }
    }),
);

effectIt.effect.prop(
  'matches an independent returned-boundary counter/history model',
  {
    events: Schema.Array(
      Schema.Struct({label: Schema.Literals(nativeProgressBoundaries), success: Schema.Boolean}),
    ).check(Schema.isMaxLength(80)),
  },
  ({events}) =>
    Effect.gen(function* () {
      const observer = make();
      let marker = false;
      let history = 0;
      const returned: {label: NativeProgressBoundary; success: boolean}[] = [];
      for (const event of events) {
        yield* observeNativeBoundary(event.success ? Effect.void : Effect.fail('PRIVATE'), observer, event.label).pipe(
          Effect.exit,
        );
        returned.push(event);
        if (event.label === 'fixture-raw-store-read' && event.success && marker) history++;
        if (event.label === 'fixture-state-read' && event.success) marker = true;
        const snapshot = observer.snapshot();
        for (const label of nativeProgressBoundaries) {
          const matching = returned.filter(entry => entry.label === label);
          expect(snapshot.counters[label]).toEqual({
            started: matching.length,
            succeeded: matching.filter(entry => entry.success).length,
            failed: matching.filter(entry => !entry.success).length,
          });
        }
        expect(snapshot.saveSucceeded).toBe(
          returned.filter(entry => entry.label === 'authoring-save' && entry.success).length,
        );
        expect(snapshot.historyReadsSucceeded).toBe(history);
      }
    }),
  {arbitrary: {runs: 25}},
);

effectIt.effect('counts 100 cheap completed boundaries and preserves ambiguity between successful calls', () =>
  Effect.gen(function* () {
    const observer = make();
    for (let i = 0; i < 100; i++) yield* observeNativeBoundary(Effect.void, observer, 'authoring-save');
    yield* observeNativeBoundary(Effect.void, observer, 'authoring-load-document');
    yield* observeNativeBoundary(Effect.void, observer, 'fixture-raw-store-read');
    yield* observeNativeBoundary(Effect.void, observer, 'authoring-load');
    expect(observer.snapshot().historyReadsSucceeded).toBe(0);
    yield* observeNativeBoundary(Effect.void, observer, 'fixture-state-read');
    for (let i = 0; i < 3; i++) yield* observeNativeBoundary(Effect.void, observer, 'fixture-raw-store-read');
    yield* observeNativeBody(Effect.fail('PRIVATE assertion between calls'), observer).pipe(Effect.exit);
    expect(observer.snapshot()).toMatchObject({
      saveStarted: 100,
      saveSucceeded: 100,
      historyReadsSucceeded: 3,
      bodyExitSnapshot: {lastBoundary: {label: 'fixture-raw-store-read', outcome: 'Success'}},
    });
    expect(observer.snapshot()).not.toHaveProperty('region');
    expect(JSON.stringify(observer.snapshot())).not.toContain('assertion');
  }),
);

effectIt.effect.prop(
  'classifies descriptors without getters and never retains arbitrary private names/payloads',
  {
    payload: Schema.String,
  },
  ({payload}) =>
    Effect.sync(() => {
      const observer = make();
      let getters = 0;
      const privateInput = {
        get action() {
          getters++;
          throw new Error(payload);
        },
      };
      expect(classifyNativeProgress(privateInput)).toBe('other');
      expect(getters).toBe(0);
      expect(
        classifyNativeProgress(
          new Proxy(
            {},
            {
              getOwnPropertyDescriptor() {
                throw new Error(payload);
              },
            },
          ),
        ),
      ).toBe('other');
      for (const request of [null, payload, {action: 'PRIVATE.' + payload}, {action: 'authoring', command: payload}]) {
        const label = classifyNativeProgress(request);
        expect(nativeProgressBoundaries).toContain(label);
      }
      const unknown = observer.tracer.span(spanOptions('PRIVATE.' + payload));
      unknown.attribute('PRIVATE', payload);
      unknown.event(payload, 2n, {PRIVATE: payload});
      unknown.end(3_000_000n, Exit.fail({PRIVATE: payload}));
      const packet = JSON.stringify(observer.snapshot());
      expect(packet).not.toContain('PRIVATE');
      expect(observer.snapshot().totals).toEqual({});
    }),
  {arbitrary: {runs: 25}},
);

effectIt.effect('keeps active ages and facade positions separate from native inclusive durations', () =>
  Effect.sync(() => {
    let milliseconds = 1000;
    const observer = make({now: () => milliseconds});
    const boundary = observer.start('authoring-save');
    const span = observer.tracer.span(spanOptions('workflowAutomation.save'));
    milliseconds = 1010;
    expect(observer.snapshot().active[0].ageMs).toBe(10);
    milliseconds = 1020;
    span.end(3_000_000n, Exit.succeed(undefined));
    observer.end(boundary, 'Success');
    expect(observer.snapshot().lastBoundary?.elapsedMs).toBe(20);
    expect(observer.snapshot().totals['workflowAutomation.save'].inclusiveMs).toBe(2);
    expect(observer.snapshot().historyRule).toBe('inferred-from-fixture-boundaries-after-first-successful-state-read');
  }),
);

effectIt.effect('records database lifetime labels without retaining their private span data or exits', () =>
  Effect.gen(function* () {
    const lines: string[] = [];
    const observer = make({sink: line => lines.push(line)});
    const privateValue = {PRIVATE: 'database path, query and result'};
    let released = 0;
    for (const label of ['recall.acquireDatabase', 'recall.databaseBody'] as const) {
      const exit = yield* Effect.scoped(
        Effect.acquireRelease(Effect.succeed(privateValue), () =>
          Effect.sync(() => {
            released++;
          }),
        ).pipe(
          Effect.flatMap(value =>
            Effect.gen(function* () {
              const span = yield* Effect.currentSpan;
              span.attribute('PRIVATE', value);
              span.event('PRIVATE', 1n, value);
              return yield* Effect.fail(value);
            }),
          ),
          Effect.withSpan(label),
        ),
      ).pipe(Effect.withTracer(observer.tracer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons.some(reason => Cause.isFailReason(reason) && reason.error === privateValue)).toBe(
          true,
        );
      expect(observer.snapshot().totals[label]).toMatchObject({started: 1, ended: 1, failed: 1});
    }
    expect(released).toBe(2);
    expect(observer.snapshot().activeCount).toBe(0);
    expect(lines).toHaveLength(0);
    observer.reportFailure();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('PRIVATE');
  }),
);

effectIt.effect('bounds all active/recent data, clocks, durations, snapshots and the worst-case failure line', () =>
  Effect.sync(() => {
    const readings = [100, 110, NaN, Infinity, -100, 105, 120];
    let clock = 0;
    const lines: string[] = [];
    const observer = make({now: () => readings[clock++] ?? 120, sink: line => lines.push(line)});
    observer.enterBody();
    for (const label of nativeProgressBoundaries) {
      const boundary = observer.start(label);
      observer.end(boundary, 'Success');
    }
    const spans = nativeProgressSpanLabels.flatMap(label =>
      Array.from({length: 2}, () => observer.tracer.span(spanOptions(label))),
    );
    expect(observer.snapshot().active).toHaveLength(8);
    expect(observer.snapshot().unlistedActiveCount).toBe(spans.length - 8);
    for (const span of spans) span.end(10n ** 100n, Exit.succeed('PRIVATE'));
    observer.exitBody();
    const snapshot = observer.snapshot();
    expect(snapshot.recent).toHaveLength(32);
    expect(snapshot.recentDropped).toBe(spans.length - 32);
    expect(snapshot.elapsedMs).toBe(20);
    expect(Object.values(snapshot.totals).every(total => total.inclusiveMs === 2_147_483_647)).toBe(true);
    snapshot.counters.init.started = -1;
    snapshot.recent.length = 0;
    snapshot.bodyExitSnapshot!.counters.init.started = -1;
    expect(observer.snapshot().counters.init.started).toBe(1);
    expect(observer.snapshot().bodyExitSnapshot!.counters.init.started).toBe(1);
    // Keep every label, eight live spans, the full recent ring and body-exit state in the largest shape.
    for (const label of nativeProgressSpanLabels) observer.tracer.span(spanOptions(label));
    const largest = observer.snapshot();
    const saturate = (value: unknown): unknown =>
      typeof value === 'number'
        ? 2_147_483_647
        : Array.isArray(value)
          ? value.map(saturate)
          : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, saturate(child)]))
            : value;
    const saturated = saturate(largest) as typeof largest;
    observer.snapshot = () => saturated;
    observer.reportFailure();
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThanOrEqual(16_384);
    const packet = JSON.parse(lines[0].slice(lines[0].indexOf('{')));
    expect(packet).toMatchObject({
      outerFailure: true,
      clocks: {
        facades: 'diagnostic-monotonic-ms',
        activeAges: 'diagnostic-monotonic-ms',
        completedSpans: 'effect-native-timestamps-ns-to-inclusive-ms',
        spanTotals: 'inclusive-overlapping',
      },
    });
    expect(lines[0]).not.toContain('PRIVATE');
  }),
);

effectIt.effect('broken clocks, sink, serialization, snapshots and bookkeeping cannot replace any exit', () =>
  Effect.gen(function* () {
    const value = {PRIVATE: true};
    for (const broken of ['clock', 'sink', 'serialize', 'snapshot', 'start', 'end', 'enterBody', 'exitBody'] as const) {
      for (const outcome of ['success', 'failure', 'defect', 'interruption'] as const) {
        const crash = () => {
          throw new Error('PRIVATE diagnostic failure');
        };
        const observer = make({
          now: broken === 'clock' ? crash : () => 0,
          sink: broken === 'sink' ? crash : () => {},
          serialize: broken === 'serialize' ? crash : JSON.stringify,
        });
        if (broken === 'snapshot') observer.snapshot = crash;
        if (broken === 'start') observer.start = crash;
        if (broken === 'end') observer.end = crash;
        if (broken === 'enterBody') observer.enterBody = crash;
        if (broken === 'exitBody') observer.exitBody = crash;
        const original =
          outcome === 'success'
            ? Effect.succeed(value)
            : outcome === 'failure'
              ? Effect.fail(value)
              : outcome === 'defect'
                ? Effect.die(value)
                : Effect.interrupt;
        const exit = yield* reportNativeFailure(
          observeNativeBody(observeNativeBoundary(original, observer, 'other'), observer).pipe(
            Effect.withTracer(observer.tracer),
          ),
          observer,
        ).pipe(Effect.exit);
        if (outcome === 'success') {
          expect(Exit.isSuccess(exit)).toBe(true);
          if (Exit.isSuccess(exit)) expect(exit.value).toBe(value);
        } else if (outcome === 'interruption') expect(Exit.hasInterrupts(exit)).toBe(true);
        else {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(value);
        }
      }
    }
  }),
);

effectIt.effect('preserves existing layer ownership wiring', () =>
  Effect.sync(() => {
    const fixture = readFileSync(new URL('./native-automation-fixture.ts', import.meta.url), 'utf8');
    expect(fixture.match(/provideTestLayer\(ApplicationLayer\)/gu)).toHaveLength(1);
    expect(fixture.match(/observeNativeBody\(program, observer\)/gu)).toHaveLength(1);
    expect(fixture).toContain('makeNativeProgressDiagnostics(yield* Effect.tracer)');
    expect(fixture).toContain('nativeProgressFacades(store, fs, statePath(), observer)');
    expect(fixture).toContain('fs: returned.fs');
    expect(fixture).toContain('store: returned.store');
  }),
);
