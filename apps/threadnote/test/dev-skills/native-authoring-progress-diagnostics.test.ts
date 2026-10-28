import {it as effectIt} from '@effect/vitest';
import {Cause, Context, Deferred, Effect, Exit, Fiber, Option, Schema, Tracer} from 'effect';
import {createHash} from '@threadnote/testing/node-crypto';
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
  nativeCommandPhases,
  nativeCommandCohorts,
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
  makeNativeProgressDiagnostics(Tracer.nativeTracer, {
    now: () => 0,
    sink: () => {},
    cpuUsage: () => ({user: 0, system: 0}),
    ...options,
  });

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

effectIt.effect('reads worker CPU only at the existing body boundaries and preserves wall-clock ordering', () =>
  Effect.sync(() => {
    const calls: string[] = [];
    const lines: string[] = [];
    const first = {user: 1000, system: 2000, PRIVATE: 'path and ID'};
    const last = {user: 5500, system: 3500, PRIVATE: 'result'};
    let reads = 0;
    const observer = make({
      now: () => {
        calls.push('wall');
        return 0;
      },
      cpuUsage: () => {
        calls.push('cpu');
        return reads++ === 0 ? first : last;
      },
      sink: line => lines.push(line),
    });
    expect(calls).toEqual(['wall']);
    expect(observer.snapshot().bodyCpu).toMatchObject({available: false});
    observer.enterBody();
    first.user = 9000; // The observer copies primitive endpoints instead of retaining the reader's object.
    expect(observer.snapshot().bodyCpu).toMatchObject({available: false});
    observer.exitBody();
    expect(calls).toEqual(['wall', 'wall', 'wall', 'cpu', 'wall', 'wall', 'cpu']);
    const snapshot = observer.snapshot();
    expect(snapshot.bodyCpu).toEqual({
      available: true,
      userMs: 5,
      systemMs: 2,
      scope: 'worker-process-all-threads-excludes-children',
      limits:
        'includes-other-worker-activity-and-boundary-skew;cpu-may-exceed-wall;not-serialization-or-io-attribution',
    });
    expect(snapshot.bodyMs).toBe(0); // CPU is never capped to wall time or reported as exclusive wait.
    if (snapshot.bodyCpu.available) snapshot.bodyCpu.userMs = -1;
    last.user = 0;
    expect(observer.snapshot().bodyCpu).toMatchObject({available: true, userMs: 5, systemMs: 2});
    expect(reads).toBe(2);
    expect(lines).toHaveLength(0);
    observer.reportFailure();
    observer.reportFailure();
    expect(reads).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('PRIVATE');
  }),
);

effectIt.effect.prop(
  'bounds monotonic safe-integer CPU endpoint differences independently of wall time',
  {
    userA: Schema.Literals([0, 499, 500, 1000, 2_147_483_648_000, Number.MAX_SAFE_INTEGER]),
    userB: Schema.Literals([0, 499, 500, 1000, 2_147_483_648_000, Number.MAX_SAFE_INTEGER]),
    systemA: Schema.Literals([0, 499, 500, 1000, 2_147_483_648_000, Number.MAX_SAFE_INTEGER]),
    systemB: Schema.Literals([0, 499, 500, 1000, 2_147_483_648_000, Number.MAX_SAFE_INTEGER]),
  },
  ({userA, userB, systemA, systemB}) =>
    Effect.sync(() => {
      const endpoints = [
        {user: Math.min(userA, userB), system: Math.min(systemA, systemB)},
        {user: Math.max(userA, userB), system: Math.max(systemA, systemB)},
      ];
      let reads = 0;
      const observer = make({cpuUsage: () => endpoints[reads++]});
      observer.enterBody();
      observer.exitBody();
      const cpu = observer.snapshot().bodyCpu;
      expect(cpu).toMatchObject({
        available: true,
        userMs: Math.min(2_147_483_647, Math.round(Math.abs(userA - userB) / 1000)),
        systemMs: Math.min(2_147_483_647, Math.round(Math.abs(systemA - systemB) / 1000)),
      });
      expect(reads).toBe(2);
    }),
  {arbitrary: {runs: 25}},
);

effectIt.effect('marks missing, throwing, malformed and decreasing CPU readings unavailable without zero values', () =>
  Effect.sync(() => {
    const valid = {user: 1000, system: 1000};
    const malformed: unknown[] = [undefined, null, false, 'PRIVATE', {}, {user: 0}];
    for (const key of ['user', 'system'])
      for (const value of ['PRIVATE', null, false, NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
        malformed.push({...valid, [key]: value});
    malformed.push({
      get user() {
        throw new Error('PRIVATE getter');
      },
    });
    for (const bad of malformed)
      for (const at of [0, 1]) {
        let reads = 0;
        const observer = make({cpuUsage: () => (reads++ === at ? bad : valid)});
        observer.enterBody();
        observer.exitBody();
        expect(observer.snapshot().bodyCpu).toMatchObject({available: false});
        expect(observer.snapshot().bodyCpu).not.toHaveProperty('userMs');
        expect(observer.snapshot().bodyCpu).not.toHaveProperty('systemMs');
        expect(reads).toBeLessThanOrEqual(2);
        expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
      }
    for (const end of [
      {user: 999, system: 1000},
      {user: 1000, system: 999},
    ]) {
      let reads = 0;
      const observer = make({cpuUsage: () => (reads++ === 0 ? valid : end)});
      observer.enterBody();
      observer.exitBody();
      expect(observer.snapshot().bodyCpu).toMatchObject({available: false});
    }
    const deferredAccess = makeNativeProgressDiagnostics(Tracer.nativeTracer, {
      get cpuUsage(): () => unknown {
        throw new Error('PRIVATE API missing');
      },
    });
    deferredAccess.enterBody();
    deferredAccess.exitBody();
    expect(deferredAccess.snapshot().bodyCpu).toMatchObject({available: false});
  }),
);

effectIt.effect('invalidates repeated or out-of-order CPU boundaries without resampling', () =>
  Effect.sync(() => {
    for (const sequence of [
      ['exitBody'],
      ['exitBody', 'enterBody', 'exitBody'],
      ['enterBody', 'enterBody', 'exitBody'],
      ['enterBody', 'exitBody', 'exitBody'],
      ['enterBody', 'exitBody', 'enterBody', 'exitBody'],
    ] as const) {
      let reads = 0;
      const observer = make({cpuUsage: () => ({user: reads++ * 1000, system: 0})});
      for (const boundary of sequence) observer[boundary]();
      expect(observer.snapshot().bodyCpu).toMatchObject({available: false});
      expect(observer.snapshot().bodyCpu).not.toHaveProperty('userMs');
      expect(reads).toBeLessThanOrEqual(2);
    }
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

const identityLabels = [
  'recall.loadIdentityProjection',
  'recall.reconcileIdentityProjection',
  'recall.selectIdentityProjection',
] as const;
const identityAttributes = (forceAllSources = false) => ({
  forceAllSources,
  scannedSources: 8,
  changedSources: 1,
  removedSources: 0,
});
const annotateIdentity = (span: Tracer.Span, attributes: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(attributes)) span.attribute(`recall.identity.${key}`, value);
};

effectIt.effect('retains only the exact existing identity labels and delegates every end unchanged', () =>
  Effect.sync(() => {
    const lines: string[] = [];
    const ends: [Tracer.Span, bigint, Exit.Exit<unknown, unknown>][] = [];
    const created: Tracer.Span[] = [];
    const delegate = Tracer.make({
      span(options) {
        const span = Tracer.nativeTracer.span(options);
        created.push(span);
        const end = span.end.bind(span);
        span.end = (at, exit) => {
          ends.push([span, at, exit]);
          end(at, exit);
        };
        return span;
      },
    });
    const observer = makeNativeProgressDiagnostics(delegate, {now: () => 0, sink: line => lines.push(line)});
    const passed = Exit.succeed({PRIVATE: 'result'});
    const failed = Exit.fail({PRIVATE: 'error'});
    for (const [index, label] of identityLabels.entries()) {
      const options = spanOptions(label);
      const span = observer.tracer.span(options);
      expect(span).toBe(created[index]);
      expect(span.annotations).toBe(options.annotations);
      annotateIdentity(span, {...identityAttributes(), PRIVATE: {PRIVATE: 'paths and IDs'}});
      span.event('PRIVATE', 1n, {PRIVATE: 'event'});
      expect(observer.snapshot().identityReconciliations.observed).toBe(Number(index === 2));
      span.end(3_000_000n, passed);
      span.end(4_000_000n, failed);
      expect(ends.slice(-2)).toEqual([
        [span, 3_000_000n, passed],
        [span, 4_000_000n, failed],
      ]);
      expect(ends.at(-2)![2]).toBe(passed);
      expect(ends.at(-1)![2]).toBe(failed);
      expect(observer.snapshot().totals[label]).toEqual({started: 1, ended: 1, failed: 0, inclusiveMs: 2});
    }
    for (const label of ['recall.identityProjection', ...identityLabels.map(label => `${label}.PRIVATE`)]) {
      const span = observer.tracer.span(spanOptions(label));
      annotateIdentity(span, identityAttributes(true));
      span.end(3_000_000n, failed);
    }
    expect(Object.keys(observer.snapshot().totals)).toEqual(identityLabels);
    expect(observer.snapshot().identityReconciliations).toMatchObject({
      observed: 1,
      incremental: {count: 1, scannedSources: 8, changedSources: 1, removedSources: 0, maxChangedSources: 1},
    });
    expect(observer.snapshot().activeCount).toBe(0);
    expect(lines).toHaveLength(0);
    observer.reportFailure();
    observer.reportFailure();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('PRIVATE');
  }),
);

effectIt.effect.prop(
  'clamps identity source counters and their aggregates without retaining source attributes',
  {
    events: Schema.Array(
      Schema.Struct({
        forceAllSources: Schema.Boolean,
        scannedSources: Schema.Literals([0, 1, 8, 2_147_483_648, Number.MAX_VALUE]),
        changedSources: Schema.Literals([0, 1, 8, 2_147_483_648, Number.MAX_VALUE]),
        removedSources: Schema.Literals([0, 1, 8, 2_147_483_648, Number.MAX_VALUE]),
      }),
    ).check(Schema.isMaxLength(20)),
  },
  ({events}) =>
    Effect.sync(() => {
      const observer = make();
      for (const event of events) {
        const span = observer.tracer.span(spanOptions('recall.reconcileIdentityProjection'));
        annotateIdentity(span, {...event, PRIVATE: {PRIVATE: 'source data'}});
        span.end(3_000_000n, Exit.void);
        span.end(4_000_000n, Exit.fail('PRIVATE'));
      }
      const snapshot = observer.snapshot();
      expect(snapshot.identityReconciliations.observed).toBe(events.length);
      for (const [all, name] of [
        [true, 'allSources'],
        [false, 'incremental'],
      ] as const) {
        const matching = events.filter(event => event.forceAllSources === all);
        const clamp = (value: number) => Math.min(2_147_483_647, value);
        expect(snapshot.identityReconciliations[name]).toEqual({
          count: matching.length,
          scannedSources: clamp(matching.reduce((sum, event) => sum + event.scannedSources, 0)),
          changedSources: clamp(matching.reduce((sum, event) => sum + event.changedSources, 0)),
          removedSources: clamp(matching.reduce((sum, event) => sum + event.removedSources, 0)),
          maxChangedSources: clamp(Math.max(0, ...matching.map(event => event.changedSources))),
        });
        snapshot.identityReconciliations[name].count = -1;
        expect(observer.snapshot().identityReconciliations[name].count).toBe(matching.length);
      }
      expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    }),
  {arbitrary: {runs: 25}},
);

effectIt.effect('refuses malformed identity counters, missing attributes and lexical counter aliases', () =>
  Effect.sync(() => {
    const observer = make();
    const privateValue = {
      get PRIVATE() {
        throw new Error('PRIVATE getter');
      },
    };
    for (const key of Object.keys(identityAttributes())) {
      const invalid: unknown[] = [undefined, null, 'PRIVATE', privateValue, NaN, Infinity, -Infinity, -1, 0.5];
      if (key !== 'forceAllSources') invalid.push(true, false);
      for (const malformed of invalid) {
        const span = observer.tracer.span(spanOptions('recall.reconcileIdentityProjection'));
        annotateIdentity(span, {...identityAttributes(), [key]: malformed});
        span.end(3_000_000n, Exit.fail(privateValue));
      }
    }
    for (const label of identityLabels) {
      const span = observer.tracer.span(spanOptions(label));
      for (const [key, value] of Object.entries(identityAttributes())) span.attribute(`recall.refresh.${key}`, value);
      span.end(3_000_000n, Exit.void);
    }
    expect(observer.snapshot().identityReconciliations.observed).toBe(0);
    expect(observer.snapshot().refreshDecisions.observed).toBe(0);
    expect(observer.snapshot().activeCount).toBe(0);
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
  }),
);

const refreshAttributes = (forceAllSources = false) => ({
  forceAllSources,
  forceRefresh: false,
  forceFromMarker: false,
  canonicalMutationChanged: true,
  continuityAllowed: !forceAllSources,
  scannedSources: 8,
  changedSources: 1,
  removedSources: 0,
});
const annotateRefresh = (span: Tracer.Span, attributes: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(attributes)) span.attribute(`recall.refresh.${key}`, value);
};

effectIt.effect.prop(
  'matches an independent bounded refresh decision model without retaining private attributes',
  {
    events: Schema.Array(
      Schema.Struct({
        forceAllSources: Schema.Boolean,
        forceRefresh: Schema.Boolean,
        forceFromMarker: Schema.Boolean,
        canonicalMutationChanged: Schema.Boolean,
        continuityAllowed: Schema.Boolean,
        scannedSources: Schema.Literals([0, 1, 8, 255, 2_147_483_648]),
        changedSources: Schema.Literals([0, 1, 8, 255, 2_147_483_648]),
        removedSources: Schema.Literals([0, 1, 8, 255, 2_147_483_648]),
      }),
    ).check(Schema.isMaxLength(20)),
  },
  ({events}) =>
    Effect.sync(() => {
      const observer = make();
      for (const event of events) {
        const span = observer.tracer.span(spanOptions('recall.refreshDatabase'));
        annotateRefresh(span, event);
        span.attribute('PRIVATE', {PRIVATE: 'contents and paths'});
        span.event('PRIVATE', 1n, {PRIVATE: 'content'});
        span.end(3_000_000n, Exit.succeed('PRIVATE'));
        span.end(4_000_000n, Exit.fail('PRIVATE'));
      }
      const snapshot = observer.snapshot();
      const clamp = (value: number) => Math.min(2_147_483_647, value);
      const bucket = (all: boolean) => {
        const matching = events.filter(event => event.forceAllSources === all);
        return {
          count: matching.length,
          scannedSources: clamp(matching.reduce((sum, event) => sum + event.scannedSources, 0)),
          changedSources: clamp(matching.reduce((sum, event) => sum + event.changedSources, 0)),
          removedSources: clamp(matching.reduce((sum, event) => sum + event.removedSources, 0)),
          maxChangedSources: clamp(Math.max(0, ...matching.map(event => event.changedSources))),
        };
      };
      expect(snapshot.refreshDecisions).toEqual({
        observed: events.length,
        forceRefresh: events.filter(event => event.forceRefresh).length,
        forceFromMarker: events.filter(event => event.forceFromMarker).length,
        canonicalMutationChanged: events.filter(event => event.canonicalMutationChanged).length,
        continuityMissing: events.filter(event => !event.continuityAllowed).length,
        allSources: bucket(true),
        incremental: bucket(false),
      });
      expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
      snapshot.refreshDecisions.allSources.count = -1;
      expect(observer.snapshot().refreshDecisions.allSources.count).toBe(bucket(true).count);
    }),
  {arbitrary: {runs: 25}},
);

effectIt.effect('rejects incomplete or nonprimitive refresh attributes and attributes on other spans', () =>
  Effect.sync(() => {
    const observer = make();
    const privateValue = {
      get PRIVATE() {
        throw new Error('PRIVATE getter');
      },
    };
    for (const key of Object.keys(refreshAttributes())) {
      for (const malformed of [undefined, null, 'PRIVATE', privateValue, NaN, Infinity, -1, 0.5]) {
        const span = observer.tracer.span(spanOptions('recall.refreshDatabase'));
        annotateRefresh(span, {...refreshAttributes(), [key]: malformed});
        span.end(3_000_000n, Exit.fail(privateValue));
      }
    }
    const other = observer.tracer.span(spanOptions('recall.writeRefresh'));
    annotateRefresh(other, refreshAttributes(true));
    other.end(3_000_000n, Exit.succeed(undefined));
    expect(observer.snapshot().refreshDecisions.observed).toBe(0);
    expect(observer.snapshot().activeCount).toBe(0);
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
  }),
);

effectIt.effect('observes coarse refresh phases and explicit close finalization while keeping success quiet', () =>
  Effect.gen(function* () {
    const lines: string[] = [];
    const observer = make({sink: line => lines.push(line)});
    const value = {PRIVATE: 'original result'};
    let released = 0;
    const result = yield* reportNativeFailure(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              released++;
            }).pipe(Effect.withSpan('recall.closeDatabase')),
          );
          return yield* Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan(
              Object.fromEntries(
                Object.entries(refreshAttributes()).map(([key, item]) => [`recall.refresh.${key}`, item]),
              ),
            );
            yield* Effect.void.pipe(Effect.withSpan('recall.assembleRefreshSources'));
            yield* Effect.void.pipe(Effect.withSpan('recall.hashRefreshGeneration'));
            yield* Effect.all([
              Effect.void.pipe(Effect.withSpan('recall.rebuildIdentityConflicts')),
              Effect.void.pipe(Effect.withSpan('recall.resolveLegacyMemoryLinks')),
            ]).pipe(Effect.withSpan('recall.writeRefresh'));
            return value;
          }).pipe(Effect.withSpan('recall.refreshDatabase'));
        }),
      ).pipe(Effect.withTracer(observer.tracer)),
      observer,
    );
    expect(result).toBe(value);
    expect(released).toBe(1);
    expect(lines).toHaveLength(0);
    for (const label of [
      'recall.assembleRefreshSources',
      'recall.hashRefreshGeneration',
      'recall.writeRefresh',
      'recall.rebuildIdentityConflicts',
      'recall.resolveLegacyMemoryLinks',
      'recall.closeDatabase',
    ])
      expect(observer.snapshot().totals[label]).toMatchObject({started: 1, ended: 1, failed: 0});
    expect(observer.snapshot().refreshDecisions.incremental).toMatchObject({count: 1, changedSources: 1});
    observer.reportFailure();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('PRIVATE');
  }),
);

effectIt.effect(
  'retains distinct transaction body timing through its unrecorded SQL parent in the failure packet',
  () =>
    Effect.sync(() => {
      const lines: string[] = [];
      const observer = make({sink: line => lines.push(line)});
      const outer = observer.tracer.span(spanOptions('recall.writeRefresh'));
      const transaction = observer.tracer.span(spanOptions('sql.transaction', Option.some(outer)));
      const body = observer.tracer.span({
        ...spanOptions('recall.writeRefreshBody', Option.some(transaction)),
        startTime: 2_000_000n,
      });
      expect(Option.getOrUndefined(body.parent)).toBe(transaction);
      expect(Option.getOrUndefined(transaction.parent)).toBe(outer);
      body.end(6_000_000n, Exit.succeed(undefined));
      transaction.end(9_000_000n, Exit.succeed(undefined));
      outer.end(10_000_000n, Exit.succeed(undefined));
      expect(lines).toHaveLength(0);
      observer.reportFailure();
      expect(lines).toHaveLength(1);
      const packet = JSON.parse(lines[0].slice(lines[0].indexOf('{')));
      expect(packet.totals['recall.writeRefreshBody']).toMatchObject({ended: 1, inclusiveMs: 4});
      expect(packet.totals['recall.writeRefresh']).toMatchObject({ended: 1, inclusiveMs: 9});
      expect(packet.totals).not.toHaveProperty('sql.transaction');
      expect(packet.activeCount).toBe(0);
    }),
);

const refreshTransactionSpans = (observer: ReturnType<typeof make>, bodyStart = 3_000_000n) => {
  const outer = observer.tracer.span(spanOptions('recall.writeRefresh'));
  const transaction = observer.tracer.span(spanOptions('sql.transaction', Option.some(outer)));
  const body = observer.tracer.span({
    ...spanOptions('recall.writeRefreshBody', Option.some(transaction)),
    startTime: bodyStart,
  });
  return {outer, transaction, body};
};

effectIt.effect.prop(
  'accounts for fixed commit-event intervals without retaining events, attributes or SQL',
  {
    acquireAndBeginMs: Schema.Literals([0, 1, 7, 255]),
    bodyMs: Schema.Literals([0, 1, 7, 255]),
    preCommitMs: Schema.Literals([0, 1, 7, 255]),
    commitAndReleaseMs: Schema.Literals([0, 1, 7, 255]),
  },
  intervals =>
    Effect.sync(() => {
      const lines: string[] = [];
      const observer = make({sink: line => lines.push(line)});
      const bodyStart = 1_000_000n + BigInt(intervals.acquireAndBeginMs) * 1_000_000n;
      const {outer, transaction, body} = refreshTransactionSpans(observer, bodyStart);
      const bodyEnd = bodyStart + BigInt(intervals.bodyMs) * 1_000_000n;
      const commit = bodyEnd + BigInt(intervals.preCommitMs) * 1_000_000n;
      const end = commit + BigInt(intervals.commitAndReleaseMs) * 1_000_000n;
      let privateReads = 0;
      const attributes = {
        get PRIVATE() {
          privateReads++;
          throw new Error('PRIVATE');
        },
      };
      transaction.attribute('db.query.text', 'PRIVATE SQL');
      transaction.event('effect.sql.transaction.commit', commit, attributes);
      body.end(bodyEnd, Exit.succeed('PRIVATE'));
      transaction.end(end, Exit.succeed('PRIVATE'));
      transaction.end(end + 1n, Exit.fail('PRIVATE'));
      outer.end(end, Exit.succeed('PRIVATE'));
      expect(observer.snapshot().transactionBoundaries).toEqual({observed: 1, rejected: 0, ...intervals});
      expect(privateReads).toBe(0);
      expect(observer.snapshot().totals['recall.writeRefreshBody'].ended).toBe(1);
      expect(observer.snapshot().totals).not.toHaveProperty('sql.transaction');
      expect(lines).toHaveLength(0);
      const snapshot = observer.snapshot();
      snapshot.transactionBoundaries.bodyMs = -1;
      expect(observer.snapshot().transactionBoundaries.bodyMs).toBe(intervals.bodyMs);
      observer.reportFailure();
      expect(lines).toHaveLength(1);
      expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
      expect(lines[0]).not.toContain('PRIVATE');
      expect(JSON.parse(lines[0].slice(lines[0].indexOf('{'))).transactionBoundaries).toEqual({
        observed: 1,
        rejected: 0,
        ...intervals,
      });
    }),
  {arbitrary: {runs: 25}},
);

effectIt.effect('rejects absent, duplicate, out-of-order and oversized commit events without changing span exits', () =>
  Effect.sync(() => {
    const cases: readonly (readonly (readonly [string, bigint])[])[] = [
      [],
      [['PRIVATE', 9_000_000n]],
      [
        ['effect.sql.transaction.commit', 9_000_000n],
        ['effect.sql.transaction.commit', 9_000_000n],
      ],
      [['effect.sql.transaction.commit', 6_000_000n]],
      [['effect.sql.transaction.commit', 13_000_000n]],
      Array.from({length: 5}, () => ['effect.sql.transaction.commit', 9_000_000n] as const),
    ];
    const observer = make();
    for (const events of cases) {
      const {outer, transaction, body} = refreshTransactionSpans(observer);
      for (const [name, at] of events) transaction.event(name, at, {PRIVATE: 'ignored'});
      const exit = Exit.succeed({PRIVATE: 'original value'});
      body.end(7_000_000n, exit);
      transaction.end(12_000_000n, exit);
      outer.end(13_000_000n, exit);
      if (transaction.status._tag === 'Ended') expect(transaction.status.exit).toBe(exit);
      else throw new Error('Expected delegated transaction end');
    }
    expect(observer.snapshot().transactionBoundaries).toMatchObject({observed: 0, rejected: cases.length});
    expect(observer.snapshot().totals['recall.writeRefreshBody']).toMatchObject({
      started: cases.length,
      ended: cases.length,
      failed: 0,
    });
    expect(observer.snapshot().activeCount).toBe(0);
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
  }),
);

effectIt.effect('requires exact observed immediate parents and one successful body for transaction intervals', () =>
  Effect.sync(() => {
    const observer = make();
    const unrelated = Tracer.nativeTracer.span(spanOptions('recall.writeRefresh'));
    const transaction = observer.tracer.span(spanOptions('sql.transaction', Option.some(unrelated)));
    const body = observer.tracer.span(spanOptions('recall.writeRefreshBody', Option.some(transaction)));
    transaction.event('effect.sql.transaction.commit', 9_000_000n);
    body.end(7_000_000n, Exit.void);
    transaction.end(12_000_000n, Exit.void);
    expect(observer.snapshot().transactionBoundaries).toMatchObject({observed: 0, rejected: 0});
    for (const invalid of [
      'missing-body',
      'wrong-parent',
      'duplicate-body',
      'failed-body',
      'failed-transaction',
    ] as const) {
      const outer = observer.tracer.span(spanOptions('recall.writeRefresh'));
      const tx = observer.tracer.span(spanOptions('sql.transaction', Option.some(outer)));
      if (invalid !== 'missing-body') {
        const child = observer.tracer.span(
          spanOptions('recall.writeRefreshBody', Option.some(invalid === 'wrong-parent' ? outer : tx)),
        );
        child.end(7_000_000n, invalid === 'failed-body' ? Exit.fail('PRIVATE') : Exit.void);
        if (invalid === 'duplicate-body')
          observer.tracer.span(spanOptions('recall.writeRefreshBody', Option.some(tx))).end(7_000_000n, Exit.void);
      }
      tx.event('effect.sql.transaction.commit', 9_000_000n);
      tx.end(12_000_000n, invalid === 'failed-transaction' ? Exit.fail('PRIVATE') : Exit.void);
      outer.end(13_000_000n, Exit.void);
    }
    expect(observer.snapshot().transactionBoundaries).toMatchObject({observed: 0, rejected: 5});
    expect(observer.snapshot().activeCount).toBe(0);
  }),
);

const commandFrame = (
  observer: ReturnType<typeof make>,
  phase: (typeof nativeCommandPhases)[number],
  cohort: (typeof nativeCommandCohorts)[number],
) => {
  const labels = {
    projection: [
      'workflowAutomation.projectCloseoutKnowledge',
      'workflowMemory.prepareOperation',
      'memoryCodeCitation.captureRepositoryGroup',
    ],
    'native-preflight': [
      'workflowAutomation.save',
      'workflowMemory.prepareOperation',
      'memoryCodeCitation.captureRepositoryGroup',
    ],
    'lower-prepare': [
      'workflowAutomation.save',
      'workflowMemory.executeOperation',
      'workflowMemory.prepareOperation',
      'memoryCodeCitation.captureRepositoryGroup',
    ],
    execute: ['workflowMemory.executeOperation'],
    binding: ['workflowAutomation.projectCloseoutKnowledge', 'workflowMemory.verifyBinding', 'utils.gitValue'],
    capture: ['memoryCodeCitation.captureRepositoryGroup'],
    OTHER: ['PRIVATE.unrecognized'],
  };
  const parents: Tracer.Span[] = [];
  for (const label of [`closeout.stage.${phase}`, ...labels[cohort], 'PRIVATE.middle', 'runCommandEffect']) {
    parents.push(observer.tracer.span(spanOptions(label, Option.fromUndefinedOr(parents.at(-1)))));
  }
  return {
    command: () => observer.tracer.span(spanOptions('CommandExecutor.execute', Option.some(parents.at(-1)!))),
    close: () => {
      for (const parent of [...parents].reverse()) parent.end(3_000_000n, Exit.void);
    },
  };
};

effectIt.effect.prop(
  'conserves command counts and inclusive durations across closed phase and ancestry cohorts',
  {
    events: Schema.Array(
      Schema.Struct({
        phase: Schema.Literals(nativeCommandPhases),
        cohort: Schema.Literals(nativeCommandCohorts),
        milliseconds: Schema.Literals([0, 1, 7, 255]),
        failed: Schema.Boolean,
      }),
    ).check(Schema.isMaxLength(40)),
  },
  ({events}) =>
    Effect.sync(() => {
      const observer = make();
      for (const event of events) {
        const frame = commandFrame(observer, event.phase, event.cohort);
        const command = frame.command();
        const at = 1_000_000n + BigInt(event.milliseconds) * 1_000_000n;
        const exit = event.failed ? Exit.fail('PRIVATE') : Exit.void;
        command.end(at, exit);
        command.end(at + 1n, exit);
        frame.close();
      }
      const cohorts = observer.snapshot().commandCohorts;
      for (const phase of nativeCommandPhases)
        for (const cohort of nativeCommandCohorts) {
          const matching = events.filter(event => event.phase === phase && event.cohort === cohort);
          expect(cohorts[phase][cohort]).toEqual({
            started: matching.length,
            ended: matching.length,
            failed: matching.filter(event => event.failed).length,
            inclusiveMs: matching.reduce((total, event) => total + event.milliseconds, 0),
          });
        }
      expect(observer.snapshot().activeCount).toBe(0);
      expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
    }),
  {arbitrary: {runs: 25}},
);

effectIt.effect('retains command aggregates after thousands of earlier records leave the bounded history', () =>
  Effect.sync(() => {
    const lines: string[] = [];
    const observer = make({sink: line => lines.push(line)});
    const early = commandFrame(observer, 'prepare', 'projection');
    for (let index = 0; index < 100; index++) early.command().end(3_000_000n, Exit.void);
    early.close();
    const late = commandFrame(observer, 'finish', 'binding');
    for (let index = 0; index < 4000; index++) late.command().end(4_000_000n, Exit.void);
    late.close();
    const snapshot = observer.snapshot();
    expect(snapshot.recent).toHaveLength(32);
    expect(snapshot.recentDropped).toBeGreaterThan(4000);
    expect(snapshot.commandCohorts.prepare.projection).toEqual({started: 100, ended: 100, failed: 0, inclusiveMs: 200});
    expect(snapshot.commandCohorts.finish.binding).toEqual({started: 4000, ended: 4000, failed: 0, inclusiveMs: 12000});
    snapshot.commandCohorts.prepare.projection.ended = -1;
    expect(observer.snapshot().commandCohorts.prepare.projection.ended).toBe(100);
    expect(lines).toHaveLength(0);
    observer.reportFailure();
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThanOrEqual(16_384);
    const packet = JSON.parse(lines[0].slice(lines[0].indexOf('{')));
    expect(packet.commandCohorts.prepare.projection.inclusiveMs).toBe(200);
    expect(packet.commandCohorts.finish.binding.ended).toBe(4000);
    expect(lines[0]).not.toContain('PRIVATE');
  }),
);

effectIt.effect('uses each concurrent command ancestry rather than a mutable current closeout phase', () =>
  Effect.gen(function* () {
    const observer = make();
    const first = yield* Deferred.make<void>();
    const second = yield* Deferred.make<void>();
    yield* Effect.all(
      [
        Deferred.succeed(first, undefined).pipe(
          Effect.andThen(Deferred.await(second)),
          Effect.andThen(Effect.void.pipe(Effect.withSpan('CommandExecutor.execute'))),
          Effect.withSpan('workflowAutomation.projectCloseoutKnowledge'),
          Effect.withSpan('closeout.stage.prepare'),
        ),
        Deferred.await(first).pipe(
          Effect.andThen(Deferred.succeed(second, undefined)),
          Effect.andThen(
            Effect.void.pipe(
              Effect.withSpan('CommandExecutor.execute'),
              Effect.withSpan('workflowMemory.prepareOperation'),
            ),
          ),
          Effect.withSpan('workflowMemory.executeOperation'),
          Effect.withSpan('workflowAutomation.save'),
          Effect.withSpan('closeout.stage.finish'),
        ),
      ],
      {concurrency: 'unbounded'},
    ).pipe(Effect.withTracer(observer.tracer));
    const cohorts = observer.snapshot().commandCohorts;
    expect(cohorts.prepare.projection.ended).toBe(1);
    expect(cohorts.finish['lower-prepare'].ended).toBe(1);
    expect(cohorts.finish.projection.ended).toBe(0);
    expect(cohorts.prepare['lower-prepare'].ended).toBe(0);
  }),
);

effectIt.effect('bounds hostile ancestry and preserves the exact delegated parent, timestamps and exits', () =>
  Effect.sync(() => {
    const ends: [bigint, Exit.Exit<unknown, unknown>][] = [];
    const created: Tracer.Span[] = [];
    const delegate = Tracer.make({
      span(options) {
        const span = Tracer.nativeTracer.span(options);
        created.push(span);
        const end = span.end.bind(span);
        span.end = (at, exit) => {
          ends.push([at, exit]);
          end(at, exit);
        };
        return span;
      },
    });
    const observer = makeNativeProgressDiagnostics(delegate, {now: () => 0, sink: () => {}});
    let nameReads = 0;
    let parentReads = 0;
    const hostile = new Proxy(Tracer.nativeTracer.span(spanOptions('PRIVATE.parent')), {
      get(target, key, receiver) {
        if (key === 'name') {
          nameReads++;
          throw new Error('PRIVATE');
        }
        if (key === 'parent') {
          parentReads++;
          throw new Error('PRIVATE');
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const options = spanOptions('CommandExecutor.execute', Option.some(hostile));
    const command = observer.tracer.span(options);
    const failure = Exit.fail({PRIVATE: 'original error'});
    command.attribute('PRIVATE', {PRIVATE: 'arguments and paths'});
    command.event('PRIVATE', 1n, {PRIVATE: 'query'});
    command.end(3_000_000n, failure);
    command.end(4_000_000n, failure);
    expect(command).toBe(created[0]);
    expect(command.parent).toBe(options.parent);
    expect(ends).toEqual([
      [3_000_000n, failure],
      [4_000_000n, failure],
    ]);
    expect(nameReads).toBe(0);
    expect(parentReads).toBe(1);
    const external = Tracer.nativeTracer.span(spanOptions('closeout.stage.finish'));
    observer.tracer.span(spanOptions('CommandExecutor.execute', Option.some(external))).end(3_000_000n, Exit.void);
    let traversals = 0;
    const cycle = {
      _tag: 'Span',
      get parent(): Option.Option<Tracer.AnySpan> {
        traversals++;
        return Option.some(cycle as unknown as Tracer.Span);
      },
    };
    observer.tracer
      .span(spanOptions('CommandExecutor.execute', Option.some(cycle as unknown as Tracer.Span)))
      .end(3_000_000n, Exit.void);
    expect(traversals).toBe(64);
    expect(observer.snapshot().commandCohorts.OTHER.OTHER).toEqual({started: 3, ended: 3, failed: 1, inclusiveMs: 6});
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
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
    for (const broken of [
      'clock',
      'cpu',
      'sink',
      'serialize',
      'snapshot',
      'start',
      'end',
      'enterBody',
      'exitBody',
    ] as const) {
      for (const outcome of ['success', 'failure', 'defect', 'interruption'] as const) {
        const crash = () => {
          throw new Error('PRIVATE diagnostic failure');
        };
        const observer = make({
          now: broken === 'clock' ? crash : () => 0,
          cpuUsage: broken === 'cpu' ? crash : () => ({user: 0, system: 0}),
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

effectIt.effect('conserves the whole original lifecycle file and the existing layer ownership wiring', () =>
  Effect.sync(() => {
    // Git may check out this unchanged text file with CRLF on Windows.
    const original = Buffer.from(
      readFileSync(new URL('./native-authoring-lifecycle.test.ts', import.meta.url), 'utf8').replace(/\r\n/gu, '\n'),
    );
    expect(original.byteLength).toBe(80683);
    expect(createHash('sha256').update(original).digest('hex')).toBe(
      'd354d96e996d7b514d0a242b9b9901adb2151a017480e9db479bb5c35179bb1d',
    );
    const fixture = readFileSync(new URL('./native-automation-fixture.ts', import.meta.url), 'utf8');
    expect(fixture.match(/provideTestLayer\(ApplicationLayer\)/gu)).toHaveLength(1);
    expect(fixture.match(/observeNativeBody\(program, observer\)/gu)).toHaveLength(1);
    expect(fixture).toContain('makeNativeProgressDiagnostics(yield* Effect.tracer)');
    expect(fixture).toContain('nativeProgressFacades(store, fs, statePath(), observer)');
    expect(fixture).toContain('fs: returned.fs');
    expect(fixture).toContain('store: returned.store');
  }),
);

effectIt.effect(
  'keeps optional CPU observation outside the original provided Effect and preserves sink failure exits',
  () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      const observer = make({sink: line => lines.push(line)});
      const original = {exact: true};
      const exit = yield* reportNativeFailure(Effect.fail(original), observer, {
        enabled: true,
        load: async () => async done => {
          await done();
          return {functions: '', bytecodes: '', stackTraces: {traces: [], sources: [], interval: 0.01}};
        },
      }).pipe(Effect.exit);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(original);
      else throw new Error('original failure lost');
      expect(lines.filter(line => line.startsWith('NATIVE_AUTHORING_PROGRESS_DIAGNOSTICS '))).toHaveLength(1);
      expect(lines.filter(line => line.startsWith('NATIVE_AUTHORING_CPU_DIAGNOSTICS '))).toHaveLength(1);
      observer.reportCpu = () => {
        throw new Error('observer');
      };
      expect(
        yield* reportNativeFailure(Effect.succeed(original), observer, {
          enabled: true,
          load: async () => {
            throw new Error('unavailable');
          },
        }),
      ).toBe(original);
      let loads = 0;
      yield* reportNativeFailure(Effect.void, observer, {
        enabled: false,
        load: async () => {
          loads++;
          throw new Error('off');
        },
      });
      expect(loads).toBe(0);
    }),
);

effectIt.effect('conserves every mandatory workflow job byte alongside the temporary diagnostic lane', () =>
  Effect.sync(() => {
    const workflow = readFileSync(new URL('../../../../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(
      /\r\n/gu,
      '\n',
    );
    const baseline = workflow.split('\n  # Temporary D17 attribution lane;')[0];
    expect(createHash('sha256').update(baseline).digest('hex')).toBe(
      'ca1f6db4f2298362c8f5119192e5351e4378d985f2fb13c9a5dffdf5e09e0eb4',
    );
  }),
);
