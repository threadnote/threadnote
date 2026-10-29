import {it as effectIt} from '@effect/vitest';
import {Cause, Context, Deferred, Effect, Exit, Fiber, Option, Schema, Tracer} from 'effect';
import {expect} from 'vitest';
import {closeoutSpanDiagnostics} from './native-closeout-span-diagnostics.js';

const options = (name: string, parent: Option.Option<Tracer.AnySpan> = Option.none()) => ({
  name,
  parent,
  annotations: Context.empty(),
  links: [],
  startTime: 1_000_000n,
  kind: 'internal' as const,
  root: Option.isNone(parent),
  sampled: true,
});

effectIt.effect.prop(
  'omits arbitrary private names and payloads while bounding active and recent records',
  {names: Schema.Array(Schema.String).check(Schema.isMaxLength(80))},
  ({names}) =>
    Effect.sync(() => {
      const observer = closeoutSpanDiagnostics(() => 0);
      for (const name of names) {
        const span = observer.tracer.span(options('private.' + name));
        expect(span).toBeInstanceOf(Tracer.NativeSpan);
        expect(span.end).toBe(Tracer.NativeSpan.prototype.end);
        span.attribute('private', 'must not appear');
        span.event('must not appear', 2n, {private: 'must not appear'});
        span.end(3_000_000n, Exit.succeed('must not appear'));
      }
      expect(observer.snapshot().totals).toEqual({});
      const spans = Array.from({length: 40}, () => observer.tracer.span(options('workflowMemory.persistState')));
      expect(observer.snapshot()).toMatchObject({activeCount: 40, unlistedActiveCount: 32});
      expect(observer.snapshot().active).toHaveLength(8);
      for (const span of spans.reverse()) span.end(3_000_000n, Exit.succeed('must not appear'));
      const report = observer.snapshot();
      expect(report.activeCount).toBe(0);
      expect(report.active).toHaveLength(0);
      expect(report.recent).toHaveLength(32);
      expect(report.recentDropped).toBe(8);
      expect(Object.keys(report.totals)).toEqual(['workflowMemory.persistState']);
      expect(report.totals['workflowMemory.persistState']).toEqual({
        started: 40,
        ended: 40,
        failures: 0,
        inclusiveMs: 80,
      });
      expect(JSON.stringify(report)).not.toContain('must not appear');
      expect(JSON.stringify(report)).not.toContain('private.');
    }),
  {arbitrary: {runs: 20}},
);

effectIt.effect('preserves native parent objects through unknown spans and returns the exact program value', () =>
  Effect.gen(function* () {
    const observer = closeoutSpanDiagnostics();
    const value = {private: 'must not appear'};
    let outer: Tracer.Span | undefined;
    let middle: Tracer.Span | undefined;
    let inner: Tracer.Span | undefined;
    const result = yield* Effect.gen(function* () {
      outer = yield* Effect.currentSpan;
      return yield* Effect.gen(function* () {
        middle = yield* Effect.currentSpan;
        return yield* Effect.gen(function* () {
          inner = yield* Effect.currentSpan;
          return value;
        }).pipe(Effect.withSpan('workflowMemory.writeJournalFile'));
      }).pipe(Effect.withSpan('private.unknown-parent'));
    }).pipe(Effect.withSpan('workflowMemory.persistState'), Effect.withTracer(observer.tracer));
    expect(result).toBe(value);
    expect(inner).toBeInstanceOf(Tracer.NativeSpan);
    expect(Option.getOrUndefined(inner!.parent)).toBe(middle);
    expect(Option.getOrUndefined(middle!.parent)).toBe(outer);
    expect(inner!.traceId).toBe(outer!.traceId);
    const report = observer.snapshot();
    expect(report.totals['workflowMemory.writeJournalFile'].ended).toBe(1);
    expect(report.totals['workflowMemory.persistState'].ended).toBe(1);
    expect(report.activeCount).toBe(0);
    expect(report.recent.find(item => item.stage === 'workflowMemory.writeJournalFile')?.parent).toBe(
      'workflowMemory.persistState',
    );
    expect(JSON.stringify(report)).not.toContain('private.unknown-parent');
    expect(JSON.stringify(report)).not.toContain('must not appear');
    // Inclusive parent and child durations overlap; there is no combined/exclusive total.
    expect(report.timing).toBe('inclusive-span-ms');
  }),
);

effectIt.effect('preserves native timestamps, Exit identities and repeated end semantics, counting once', () =>
  Effect.sync(() => {
    const observer = closeoutSpanDiagnostics(() => 0);
    const parent = observer.tracer.span(options('private.parent'));
    const spanOptions = options('workflowMemory.persistState', Option.some(parent));
    const span = observer.tracer.span(spanOptions);
    const native = new Tracer.NativeSpan(spanOptions);
    expect(span).toBeInstanceOf(Tracer.NativeSpan);
    expect(span.parent).toBe(spanOptions.parent);
    expect(span.annotations).toBe(spanOptions.annotations);
    expect(span.links).toBe(spanOptions.links);
    const failure = Exit.fail({private: 'must not appear'});
    span.end(3_000_000n, failure);
    native.end(3_000_000n, failure);
    expect(span.status).toEqual({
      _tag: 'Ended',
      startTime: spanOptions.startTime,
      endTime: 3_000_000n,
      exit: failure,
    });
    if (span.status._tag === 'Ended') expect(span.status.exit).toBe(failure);
    const repeated = Exit.succeed({private: 'must not appear'});
    span.end(4_000_000n, repeated);
    native.end(4_000_000n, repeated);
    expect(span.status).toEqual(native.status);
    if (span.status._tag === 'Ended') expect(span.status.exit).toBe(failure);
    expect(observer.snapshot().totals['workflowMemory.persistState']).toEqual({
      started: 1,
      ended: 1,
      failures: 1,
      inclusiveMs: 2,
    });
    expect(JSON.stringify(observer.snapshot())).not.toContain('must not appear');
  }),
);

effectIt.effect('observes actual fiber interruption after cleanup without replacing its Exit', () =>
  Effect.gen(function* () {
    const observer = closeoutSpanDiagnostics();
    const entered = yield* Deferred.make<void>();
    let cleaned = 0;
    let span: Tracer.Span | undefined;
    const child = yield* Effect.acquireUseRelease(
      Effect.void,
      () =>
        Effect.gen(function* () {
          span = yield* Effect.currentSpan;
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }),
      () =>
        Effect.sync(() => {
          cleaned++;
        }),
    ).pipe(Effect.withSpan('workflowMemory.persistState'), Effect.withTracer(observer.tracer), Effect.forkChild);
    yield* Deferred.await(entered);
    expect(observer.snapshot().activeCount).toBe(1);
    yield* Fiber.interrupt(child);
    const exit = yield* Fiber.await(child);
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(cleaned).toBe(1);
    expect(span!.status._tag).toBe('Ended');
    // Fiber completion can construct a distinct Exit; native end argument
    // identity is covered separately at the exact delegation boundary above.
    if (span!.status._tag === 'Ended') expect(span!.status.exit).toStrictEqual(exit);
    expect(observer.snapshot()).toMatchObject({
      activeCount: 0,
      unlistedActiveCount: 0,
      active: [],
      totals: {'workflowMemory.persistState': {started: 1, ended: 1, failures: 1}},
      recent: [{outcome: 'Failure'}],
    });
  }),
);

effectIt.effect('a throwing diagnostic clock cannot replace success, typed failure, defect or interruption', () =>
  Effect.gen(function* () {
    const observer = closeoutSpanDiagnostics(() => {
      throw new Error('private clock failure');
    });
    const observe = <A, E, R>(program: Effect.Effect<A, E, R>) =>
      program.pipe(Effect.withSpan('workflowMemory.persistState'), Effect.withTracer(observer.tracer));
    const value = {private: 'must not appear'};
    expect(yield* observe(Effect.succeed(value))).toBe(value);
    const failure = yield* observe(Effect.fail(value)).pipe(Effect.exit);
    if (failure._tag === 'Failure') expect(Cause.squash(failure.cause)).toBe(value);
    else throw new Error('Expected original failure.');
    const defect = yield* observe(Effect.die(value)).pipe(Effect.exit);
    if (defect._tag === 'Failure') expect(Cause.squash(defect.cause)).toBe(value);
    else throw new Error('Expected original defect.');
    expect(Exit.hasInterrupts(yield* observe(Effect.interrupt).pipe(Effect.exit))).toBe(true);
    expect(observer.snapshot()).toMatchObject({
      activeCount: 0,
      active: [],
      totals: {'workflowMemory.persistState': {started: 4, ended: 4, failures: 3}},
    });
    expect(JSON.stringify(observer.snapshot())).not.toContain('private clock failure');
    expect(JSON.stringify(observer.snapshot())).not.toContain('must not appear');
  }),
);
