import {it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Effect, Fiber, Option, Ref, Schema} from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import {describe, expect} from 'vitest';
import {
  handleManagerHomeRequest,
  collectManagerHomeResponse,
  managerRecentOutcomeCount,
  type ManagerHomeSources,
} from '@threadnote/threadnote/manager/home';
import {aggregateValueReportV1} from '@threadnote/threadnote/value_report/index';
import {buildContextHealthReport} from '@threadnote/context/health';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {TestError} from '@threadnote/testing/test-error';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const config: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-manager-home-test',
  agentId: 'threadnote',
  manifestPath: '/tmp/threadnote-manager-home-test/seed-manifest.yaml',
  user: 'tester',
};

describe('Manager home API', () => {
  effectIt.effect('returns available lanes and interrupts slow health before the transport idle deadline', () =>
    Effect.gen(function* () {
      const interrupted = yield* Ref.make(false);
      const sources = testSources({
        health: () => Effect.never.pipe(Effect.ensuring(Ref.set(interrupted, true))),
      });
      const fiber = yield* homeRequest(sources).pipe(Effect.timeoutOption(5_100), Effect.forkChild);
      yield* TestClock.adjust(5_100);
      const result = yield* Fiber.join(fiber);
      expect(Option.isSome(result)).toBe(true);
      if (Option.isNone(result)) return;
      expect(result.value).toMatchObject({status: 200, body: {stats: {memories: 1, pending: 0, outcomes: 0}}});
      expect(result.value?.body).toHaveProperty('handoffs', [
        {
          timestamp: '2026-10-04T00:00:00.000Z',
          topic: 'synthetic',
          uri: 'threadnote://user/tester/memories/handoff.md',
        },
      ]);
      expect(result.value?.body).not.toHaveProperty('stats.coverage');
      expect(result.value?.body).toHaveProperty(
        'lanes',
        expect.arrayContaining([expect.objectContaining({id: 'health', status: 'unavailable'})]),
      );
      expect(yield* Ref.get(interrupted)).toBe(true);
    }),
  );

  effectIt.effect('bounds the whole landing read when records are slow without blocking independent lanes', () =>
    Effect.gen(function* () {
      const sources = testSources({records: () => Effect.never, root: () => Effect.never});
      const fiber = yield* homeRequest(sources).pipe(Effect.timeoutOption(5_100), Effect.forkChild);
      yield* TestClock.adjust(5_100);
      const result = yield* Fiber.join(fiber);
      expect(Option.isSome(result)).toBe(true);
      if (Option.isNone(result)) return;
      expect(result.value).toMatchObject({status: 200, body: {handoffs: [], stats: {pending: 0, outcomes: 0}}});
      expect(result.value?.body).not.toHaveProperty('stats.memories');
    }),
  );

  effectIt.effect('retains fast health when independent Review and Value observations stall', () =>
    Effect.gen(function* () {
      const sources = testSources({reviews: () => Effect.never, value: () => Effect.never});
      const fiber = yield* homeRequest(sources).pipe(Effect.timeoutOption(5_100), Effect.forkChild);
      yield* TestClock.adjust(5_100);
      const result = yield* Fiber.join(fiber);
      expect(Option.isSome(result)).toBe(true);
      if (Option.isNone(result)) return;
      expect(result.value?.body).toHaveProperty('stats.coverage');
      expect(result.value?.body).not.toHaveProperty('stats.pending');
      expect(result.value?.body).not.toHaveProperty('stats.outcomes');
    }),
  );

  effectIt.effect('interrupts every request-owned observation when the landing request is cancelled', () =>
    Effect.gen(function* () {
      const started = yield* Ref.make(0);
      const interrupted = yield* Ref.make(0);
      const ready = yield* Deferred.make<void>();
      const stalled = Effect.gen(function* () {
        if ((yield* Ref.updateAndGet(started, count => count + 1)) === 4) yield* Deferred.succeed(ready, undefined);
        return yield* Effect.never;
      }).pipe(Effect.ensuring(Ref.update(interrupted, count => count + 1)));
      const fiber = yield* homeRequest(
        testSources({records: () => stalled, root: () => stalled, reviews: () => stalled, value: () => stalled}),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      expect(yield* Ref.get(interrupted)).toBe(4);
    }),
  );

  effectIt.effect('shares one budget across record discovery and dependent health work', () =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      const sources = testSources({
        records: (...args) =>
          testSources()
            .records(...args)
            .pipe(Effect.delay(4_000)),
        health: (...args) =>
          testSources()
            .health(...args)
            .pipe(Effect.delay(4_000)),
      });
      const fiber = yield* homeRequest(sources).pipe(Effect.timeoutOption(5_100), Effect.forkChild);
      yield* TestClock.adjust(4_000);
      yield* TestClock.adjust(1_100);
      const result = yield* Fiber.join(fiber);
      expect(Option.isSome(result)).toBe(true);
      if (Option.isNone(result)) return;
      expect(result.value?.body).toHaveProperty('stats.memories', 1);
      expect(result.value?.body).not.toHaveProperty('stats.coverage');
      expect((yield* Clock.currentTimeMillis) - start).toBe(5_100);
    }),
  );

  effectIt.effect('reads the canonical corpus once and retains out-of-project and inactive relation targets', () =>
    Effect.gen(function* () {
      const personal = parseMemoryDocument(
        'threadnote://user/tester/memories/handoff.md',
        formatMemoryDocument(
          'HANDOFF',
          {
            kind: 'handoff',
            status: 'active',
            sourceAgentClient: 'synthetic',
            timestamp: '2026-10-04T00:00:00.000Z',
            project: 'threadnote',
          },
          'Synthetic current memory.',
        ),
      )!;
      const archived = {
        ...personal,
        uri: 'threadnote://user/tester/memories/archive.md',
        metadata: {...personal.metadata, status: 'archived' as const},
      };
      const other = {
        ...personal,
        uri: 'threadnote://user/tester/memories/other.md',
        metadata: {...personal.metadata, project: 'other'},
      };
      const all = [personal, archived, other];
      let reads = 0;
      let healthObserved = false;
      const defaults = testSources();
      const response = yield* homeRequest(
        testSources({
          records: () =>
            Effect.sync(() => {
              reads += 1;
              return all;
            }),
          health: (...args) =>
            Effect.sync(() => {
              expect(args[2]).toEqual([personal]);
              expect(args[4]?.relationCorpus).toBe(all);
              healthObserved = true;
            }).pipe(Effect.andThen(defaults.health(...args))),
        }),
      );
      expect(response?.body).toHaveProperty('stats.memories', 1);
      expect(reads).toBe(1);
      expect(healthObserved).toBe(true);
    }),
  );

  effectIt.effect.prop(
    'preserves independent observations across bounded source schedules',
    {
      recordsDelay: Schema.Literals([0, 700, 3_100, 6_200]),
      reviewsDelay: Schema.Literals([0, 700, 3_100, 6_200]),
      valueDelay: Schema.Literals([0, 700, 3_100, 6_200]),
      rootDelay: Schema.Literals([0, 700, 3_100, 6_200]),
      healthDelay: Schema.Literals([0, 700, 3_100, 6_200]),
    },
    schedule =>
      Effect.gen(function* () {
        const defaults = testSources();
        const sources = testSources({
          records: (...args) => defaults.records(...args).pipe(Effect.delay(schedule.recordsDelay)),
          reviews: (...args) => defaults.reviews(...args).pipe(Effect.delay(schedule.reviewsDelay)),
          value: (...args) => defaults.value(...args).pipe(Effect.delay(schedule.valueDelay)),
          root: (...args) => defaults.root(...args).pipe(Effect.delay(schedule.rootDelay)),
          health: (...args) => defaults.health(...args).pipe(Effect.delay(schedule.healthDelay)),
        });
        const fiber = yield* homeRequest(sources).pipe(Effect.timeoutOption(5_100), Effect.forkChild);
        yield* TestClock.adjust(5_100);
        const result = yield* Fiber.join(fiber);
        expect(Option.isSome(result)).toBe(true);
        if (Option.isNone(result) || result.value?.status !== 200 || !('stats' in result.value.body)) return;
        const body = result.value.body;
        expect(body.stats.memories).toBe(schedule.recordsDelay < 5_000 ? 1 : undefined);
        expect(body.stats.pending).toBe(schedule.reviewsDelay < 5_000 ? 0 : undefined);
        expect(body.stats.outcomes).toBe(schedule.valueDelay < 5_000 ? 0 : undefined);
        const healthCompletion = Math.max(schedule.recordsDelay, schedule.rootDelay) + schedule.healthDelay;
        expect(body.stats.coverage !== undefined).toBe(healthCompletion < 5_000);
      }),
    {arbitrary: {runs: 32}},
  );

  effectIt.effect(
    'keeps successful lanes when another source fails and does not start health after budget exhaustion',
    () =>
      Effect.gen(function* () {
        const healthStarted = yield* Ref.make(false);
        const sources = testSources({
          records: () => Effect.never,
          reviews: () => Effect.fail(TestError.make({message: 'Synthetic review failure'})),
          health: (...args) => Ref.set(healthStarted, true).pipe(Effect.andThen(testSources().health(...args))),
        });
        const fiber = yield* homeRequest(sources).pipe(Effect.timeoutOption(5_100), Effect.forkChild);
        yield* TestClock.adjust(5_100);
        const result = yield* Fiber.join(fiber);
        expect(Option.isSome(result)).toBe(true);
        if (Option.isNone(result)) return;
        expect(result.value?.body).toHaveProperty('stats.outcomes', 0);
        expect(result.value?.body).not.toHaveProperty('stats.pending');
        expect(yield* Ref.get(healthStarted)).toBe(false);
      }),
  );
  effectIt.effect('counts edited approvals once in recent outcomes', () =>
    Effect.sync(() => {
      expect(
        managerRecentOutcomeCount({
          feedback: {applied: 2, useful: 3},
          knowledgeDelta: {approved: 4},
        }),
      ).toBe(9);
    }),
  );

  effectIt.effect('rejects an invalid project before reading local state', () =>
    Effect.gen(function* () {
      const response = yield* handleManagerHomeRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/home?project=../outside'),
      });
      expect(response).toEqual({
        body: {
          code: 'invalid-project',
          error: 'Select a project with letters, numbers, dots, underscores, or hyphens.',
        },
        status: 400,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function homeRequest(sources: ManagerHomeSources) {
  return collectManagerHomeResponse(
    {config, method: 'GET', url: new URL('http://manager.test/api/home?project=threadnote')},
    sources,
  );
}

function testSources(overrides: Partial<ManagerHomeSources> = {}): ManagerHomeSources {
  const record = parseMemoryDocument(
    'threadnote://user/tester/memories/handoff.md',
    formatMemoryDocument(
      'HANDOFF',
      {
        kind: 'handoff',
        status: 'active',
        sourceAgentClient: 'synthetic',
        timestamp: '2026-10-04T00:00:00.000Z',
        project: 'threadnote',
        topic: 'synthetic',
      },
      'Synthetic handoff.',
    ),
  )!;
  return {
    records: () => Effect.succeed([record]),
    reviews: () => Effect.succeed([]),
    value: () =>
      Effect.succeed(
        aggregateValueReportV1({period: {from: '2026-09-04T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z'}}),
      ),
    root: () => Effect.succeed({state: 'available' as const, cwd: '/synthetic/repository'}),
    health: () =>
      Effect.succeed(
        buildContextHealthReport({project: 'threadnote', records: [], now: new Date('2026-10-04T00:00:00.000Z')}),
      ),
    ...overrides,
  };
}
