import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Clock, Deferred, Effect, Fiber, Schema} from 'effect';
import {SecureRandom} from 'effect/crypto';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {makeReadDeadline} from '@threadnote/platform/read_deadline';
import type {Observation} from '@threadnote/semantic/contracts';
import {
  SemanticReadinessRequest,
  type SemanticReadinessResult,
  type SemanticReadinessSource,
} from '../../src/semantic/agent_query_protocol.js';
import {makeSemanticReadinessJobs} from '../../src/semantic/readiness_jobs.js';

const source: SemanticReadinessSource = {
  worktree: 'file:///readiness',
  project: 'file:///readiness',
  uri: 'file:///readiness/source.go',
  language: 'go',
  profile: sha256HexSync('profile'),
  principal: sha256HexSync('principal'),
};
const observation: Observation = {
  version: 1,
  repository: 'readiness',
  ...source,
  configuration: sha256HexSync('configuration'),
  toolchain: sha256HexSync('toolchain'),
  provider: {id: 'gopls', version: 'fixture', generation: 1},
  view: {kind: 'disk', id: 'disk', owner: 'host', epoch: 0},
  content: sha256HexSync('source'),
  documentVersion: null,
  projectEpoch: 1,
};
const accepted = (result: SemanticReadinessResult) => {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok' || !result.job) throw new Error('Expected private job');
  return result.job;
};
const progress = (result: SemanticReadinessResult) => {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('Expected progress');
  return result.progress;
};
const scope = [source.profile, source.principal, source.worktree] as const;

effectIt.layer(cryptoLayer, {buildPerTest: true})(layerIt => {
  layerIt.effect('retains the real prepared observation and refuses changed source without another preparation', () =>
    Effect.gen(function* () {
      const prepared = yield* Deferred.make<void>();
      let current = true;
      let preparations = 0;
      let currentChecks = 0;
      const jobs = yield* makeSemanticReadinessJobs({
        worktree: source.worktree,
        prepare: (_, content, control) =>
          Effect.gen(function* () {
            expect(content).toBe(observation.content);
            preparations++;
            yield* control.stage('synchronizing');
            yield* Deferred.succeed(prepared, undefined);
            return observation;
          }),
        current: () =>
          Effect.sync(() => {
            currentChecks++;
            return current;
          }),
        close: () => Effect.void,
      });
      const job = accepted(yield* jobs.start(source, observation.content));
      yield* Deferred.await(prepared);
      yield* Effect.yieldNow;
      expect(progress(yield* jobs.status(job, ...scope)).state).toBe('ready');
      expect(progress(yield* jobs.status(job, ...scope)).cleanup).toBe('retained');
      current = false;
      const stale = progress(yield* jobs.status(job, ...scope));
      expect(stale.state).toBe('stale');
      current = true;
      const checks = currentChecks;
      expect(progress(yield* jobs.status(job, ...scope))).toMatchObject({state: 'stale', sequence: stale.sequence});
      expect(currentChecks).toBe(checks);
      expect(preparations).toBe(1);
      expect(yield* jobs.idle).toBe(false);
      yield* TestClock.adjust(600000);
      expect(yield* jobs.idle).toBe(true);
    }),
  );

  layerIt.effect(
    'retains termination and unknown cleanup when failed or interrupted preparation returns no observation',
    () =>
      Effect.gen(function* () {
        for (const cancel of [false, true]) {
          const entered = yield* Deferred.make<void>();
          let terminations = 0;
          let closes = 0;
          const jobs = yield* makeSemanticReadinessJobs({
            worktree: source.worktree,
            prepare: (_, __, control) =>
              Effect.gen(function* () {
                control.termination(
                  Effect.sync(() => {
                    terminations++;
                    control.cleanup('unknown');
                  }),
                );
                yield* Deferred.succeed(entered, undefined);
                return yield* cancel ? Effect.never : Effect.fail('before-observation');
              }),
            current: () => Effect.succeed(true),
            close: () =>
              Effect.sync(() => {
                closes++;
              }),
          });
          const job = accepted(yield* jobs.start(source, observation.content));
          yield* Deferred.await(entered);
          if (cancel) yield* jobs.cancel(job, ...scope);
          yield* Effect.yieldNow;
          expect(progress(yield* jobs.status(job, ...scope))).toMatchObject({
            state: cancel ? 'cancelled' : 'failed',
            cleanup: 'pending',
          });
          expect(closes).toBe(0);
          yield* TestClock.adjust(2000);
          expect(terminations).toBe(1);
          expect(progress(yield* jobs.status(job, ...scope)).cleanup).toBe('unknown');
          yield* jobs.cancel(job, ...scope);
          yield* TestClock.adjust(2000);
          expect(terminations).toBe(1);
        }
      }),
  );

  layerIt.effect('atomically admits at most32 concurrent starts when entropy acquisition yields', () =>
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const blocked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let entropyRequests = 0;
      const jobs = yield* makeSemanticReadinessJobs({
        worktree: source.worktree,
        prepare: () => Effect.never,
        current: () => Effect.succeed(true),
        close: () => Effect.void,
      }).pipe(
        Effect.provideService(SecureRandom.SecureRandom, {
          ...random,
          randomBytes: size =>
            Effect.gen(function* () {
              entropyRequests++;
              if (entropyRequests === 33) yield* Deferred.succeed(blocked, undefined);
              yield* Deferred.await(release);
              return yield* random.randomBytes(size);
            }),
        }),
      );
      const requests = yield* Effect.forEach(Array.from({length: 33}), () => jobs.start(source, observation.content), {
        concurrency: 'unbounded',
      }).pipe(Effect.forkChild);
      yield* Deferred.await(blocked);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Fiber.join(requests);
      expect(EffectArray.filter(results, result => result.status === 'ok')).toHaveLength(32);
      expect(EffectArray.filter(results, result => result.status === 'unavailable')).toHaveLength(1);
    }),
  );

  layerIt.effect(
    'acknowledges cancellation before cleanup and uses the retained termination capability at two seconds',
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const closing = yield* Deferred.make<void>();
        const terminated = yield* Deferred.make<void>();
        let terminations = 0;
        const jobs = yield* makeSemanticReadinessJobs({
          worktree: source.worktree,
          prepare: (_, __, control) =>
            Effect.gen(function* () {
              control.termination(
                Effect.gen(function* () {
                  terminations++;
                  yield* Deferred.succeed(terminated, undefined);
                }),
              );
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never.pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    yield* Deferred.succeed(closing, undefined);
                    yield* Deferred.await(terminated);
                    control.cleanup('drained');
                  }),
                ),
              );
            }),
          current: () => Effect.succeed(true),
          close: () => Effect.void,
        });
        const job = accepted(yield* jobs.start(source, observation.content));
        yield* Deferred.await(entered);
        const before = yield* Clock.monotonicTimeNanos;
        expect(progress(yield* jobs.cancel(job, ...scope)).state).toBe('cancelling');
        expect(yield* Clock.monotonicTimeNanos).toBe(before);
        yield* Deferred.await(closing);
        expect(progress(yield* jobs.status(job, ...scope)).cleanup).toBe('pending');
        yield* TestClock.adjust(1999);
        expect(terminations).toBe(0);
        yield* TestClock.adjust(1);
        yield* Deferred.await(terminated);
        yield* Effect.yieldNow;
        expect(progress(yield* jobs.status(job, ...scope)).state).toBe('cancelled');
        yield* jobs.cancel(job, ...scope);
        expect(terminations).toBe(1);
      }),
  );

  layerIt.effect('includes input capture elapsed time in the one startup deadline and preserves unknown cleanup', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const deadline = yield* makeReadDeadline(120000);
      yield* TestClock.adjust(30000);
      const jobs = yield* makeSemanticReadinessJobs({
        worktree: source.worktree,
        prepare: (_, __, control) =>
          Effect.gen(function* () {
            expect(yield* control.remaining).toBe(88000);
            control.cleanup('unknown');
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        current: () => Effect.succeed(true),
        close: () => Effect.void,
      });
      const job = accepted(yield* jobs.start(source, observation.content, deadline));
      yield* Deferred.await(entered);
      expect(progress(yield* jobs.status(job, ...scope)).elapsedMilliseconds).toBe(30000);
      yield* TestClock.adjust(90000);
      yield* Effect.yieldNow;
      const result = progress(yield* jobs.status(job, ...scope));
      expect(result.state).toBe('failed');
      expect(result.failureOrigin).toBe('deadline');
      expect(result.cleanup).toBe('unknown');
    }),
  );

  layerIt.effect.prop(
    'scope and capability mutations never cancel or disclose another job',
    {
      field: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 4})),
      mutation: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
    },
    ({field, mutation}) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const jobs = yield* makeSemanticReadinessJobs({
          worktree: source.worktree,
          prepare: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          current: () => Effect.succeed(true),
          close: () => Effect.void,
        });
        const job = accepted(yield* jobs.start(source, observation.content));
        yield* Deferred.await(entered);
        const handle = {...job};
        const identity = [...scope];
        if (field === 0) handle.id += mutation;
        else if (field === 1) handle.capability += mutation;
        else identity[field - 2] += mutation;
        const result = yield* jobs.cancel(handle, identity[0], identity[1], identity[2]);
        expect(result.status).toBe('unavailable');
        expect(JSON.stringify(result)).not.toContain(job.id);
        expect(progress(yield* jobs.status(job, ...scope)).state).not.toBe('cancelling');
      }),
    {arbitrary: {runs: 24}},
  );

  layerIt.effect('reserves finite volatile job capacity and refuses public budget or authority fields', () =>
    Effect.gen(function* () {
      const jobs = yield* makeSemanticReadinessJobs({
        worktree: source.worktree,
        prepare: () => Effect.never,
        current: () => Effect.succeed(true),
        close: () => Effect.void,
      });
      for (let index = 0; index < 32; index++) accepted(yield* jobs.start(source, observation.content));
      expect((yield* jobs.start(source, observation.content)).status).toBe('unavailable');
      for (const extra of [{milliseconds: 300000}, {command: 'foreign'}, {source: observation}]) {
        const parsed = yield* Schema.decodeEffect(SemanticReadinessRequest, {onExcessProperty: 'error'})({
          action: 'start',
          callerCwd: '/readiness',
          file: 'source.go',
          language: 'go',
          ...extra,
        }).pipe(Effect.result);
        expect(parsed._tag).toBe('Failure');
      }
    }),
  );
  layerIt.effect('claims one prepared buffer without replay and binds every claim field before publication', () =>
    Effect.gen(function* () {
      const buffer = {...source, buffer: {kind: 'buffer' as const, content: sha256HexSync('unsaved')}};
      const entered = yield* Deferred.make<void>();
      let preparations = 0,
        publications = 0,
        closes = 0;
      const jobs = yield* makeSemanticReadinessJobs({
        worktree: source.worktree,
        reserve: () => Effect.succeed(observation),
        prepare: (_, text, control) =>
          Effect.gen(function* () {
            preparations++;
            expect(text).toBe('unsaved');
            expect(yield* control.remaining).toBe(118000);
            yield* Deferred.succeed(entered, undefined);
            return observation;
          }),
        current: () => Effect.succeed(true),
        close: () =>
          Effect.sync(() => {
            closes++;
          }),
      });
      const job = accepted(yield* jobs.start(buffer, 'unsaved'));
      yield* Deferred.await(entered);
      yield* Effect.yieldNow;
      expect(progress(yield* jobs.status(job, ...scope)).state).toBe('ready');
      const publish = (actual: Observation) => {
        publications++;
        return actual;
      };
      for (const changed of [
        {...buffer, buffer: {...buffer.buffer, content: sha256HexSync('other')}},
        {...buffer, environment: 'other'},
        {...buffer, project: 'file:///other'},
        {...buffer, uri: 'file:///readiness/other.go'},
        {...buffer, language: 'java' as const},
        {...buffer, principal: sha256HexSync('foreign')},
        {...buffer, profile: sha256HexSync('foreign')},
      ])
        expect((yield* jobs.claim(job, changed, publish).pipe(Effect.result))._tag).toBe('Failure');
      expect(publications).toBe(0);
      expect(closes).toBe(0);
      expect(yield* jobs.claim(job, buffer, publish)).toEqual(observation);
      expect(yield* jobs.claim(job, buffer, publish)).toEqual(observation);
      yield* jobs.cancel(job, ...scope);
      yield* TestClock.adjust(600001);
      yield* Effect.yieldNow;
      expect(preparations).toBe(1);
      expect(closes).toBe(0); // Published views are closed by their original view handle, not a spent startup job.
    }),
  );

  layerIt.effect('cancellation wins during asynchronous buffer claim proof and cannot publish a late observation', () =>
    Effect.gen(function* () {
      const buffer = {...source, buffer: {kind: 'buffer' as const, content: sha256HexSync('unsaved')}};
      const prepared = yield* Deferred.make<void>();
      const checking = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let block = false,
        publications = 0,
        closes = 0;
      const jobs = yield* makeSemanticReadinessJobs({
        worktree: source.worktree,
        reserve: () => Effect.succeed(observation),
        prepare: () => Deferred.succeed(prepared, undefined).pipe(Effect.as(observation)),
        current: () =>
          block
            ? Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(true))
            : Effect.succeed(true),
        close: () =>
          Effect.sync(() => {
            closes++;
          }),
      });
      const job = accepted(yield* jobs.start(buffer, 'unsaved'));
      yield* Deferred.await(prepared);
      yield* Effect.yieldNow;
      block = true;
      const claim = yield* jobs
        .claim(job, buffer, () => {
          publications++;
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(checking);
      const cancelled = progress(yield* jobs.cancel(job, ...scope));
      expect(['cancelling', 'cancelled']).toContain(cancelled.state);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(claim))._tag).toBe('Failure');
      yield* Effect.yieldNow;
      expect(closes).toBe(1);
      expect(publications).toBe(0);
      expect((yield* jobs.claim(job, buffer, () => undefined).pipe(Effect.result))._tag).toBe('Failure');
    }),
  );

  layerIt.effect('expires unclaimed ready buffers through original close and retains unknown cleanup admission', () =>
    Effect.gen(function* () {
      for (const disposition of ['drained', 'close-failure', 'original-unknown'] as const) {
        const entered = yield* Deferred.make<void>();
        let closes = 0;
        const jobs = yield* makeSemanticReadinessJobs({
          worktree: source.worktree,
          reserve: () => Effect.succeed(observation),
          prepare: (_, __, control) =>
            Effect.sync(() => {
              if (disposition === 'original-unknown') control.cleanup('unknown');
            }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.as(observation)),
          current: () => Effect.succeed(true),
          close: () =>
            Effect.sync(() => {
              closes++;
            }).pipe(
              Effect.andThen(disposition === 'close-failure' ? Effect.fail('original-close-unknown') : Effect.void),
            ),
        });
        const buffer = {...source, buffer: {kind: 'buffer' as const, content: sha256HexSync('unsaved')}};
        const job = accepted(yield* jobs.start(buffer, 'unsaved'));
        yield* Deferred.await(entered);
        yield* Effect.yieldNow;
        if (disposition === 'original-unknown') {
          expect(progress(yield* jobs.status(job, ...scope))).toMatchObject({state: 'failed', cleanup: 'unknown'});
          expect((yield* jobs.claim(job, buffer, () => 'must-not-publish').pipe(Effect.result))._tag).toBe('Failure');
        }
        yield* TestClock.adjust(600001);
        yield* Effect.yieldNow;
        expect(closes).toBe(1);
        expect(yield* jobs.idle).toBe(disposition === 'drained');
      }
    }),
  );

  layerIt.effect('a failed closing buffer proof is sticky and cannot be revived by a later good observation', () =>
    Effect.gen(function* () {
      const buffer = {...source, buffer: {kind: 'buffer' as const, content: sha256HexSync('unsaved')}};
      const prepared = yield* Deferred.make<void>();
      let current = true,
        closes = 0,
        publications = 0;
      const jobs = yield* makeSemanticReadinessJobs({
        worktree: source.worktree,
        reserve: () => Effect.succeed(observation),
        prepare: () => Deferred.succeed(prepared, undefined).pipe(Effect.as(observation)),
        current: () => Effect.succeed(current),
        close: () =>
          Effect.sync(() => {
            closes++;
          }),
      });
      const job = accepted(yield* jobs.start(buffer, 'unsaved'));
      yield* Deferred.await(prepared);
      yield* Effect.yieldNow;
      current = false;
      expect(
        (yield* jobs
          .claim(job, buffer, () => {
            publications++;
          })
          .pipe(Effect.result))._tag,
      ).toBe('Failure');
      current = true;
      expect(
        (yield* jobs
          .claim(job, buffer, () => {
            publications++;
          })
          .pipe(Effect.result))._tag,
      ).toBe('Failure');
      yield* Effect.yieldNow;
      expect(publications).toBe(0);
      expect(closes).toBe(1);
    }),
  );
  layerIt.effect('closing the owner Scope joins pending buffer work and cancels its expiry and deadline fibers', () =>
    Effect.gen(function* () {
      let active = 0,
        closes = 0;
      const entered = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeSemanticReadinessJobs({
            worktree: source.worktree,
            reserve: () => Effect.succeed(observation),
            prepare: () =>
              Effect.gen(function* () {
                active++;
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    active--;
                  }),
                ),
              ),
            current: () => Effect.succeed(true),
            close: () =>
              Effect.sync(() => {
                closes++;
              }),
          });
          accepted(
            yield* jobs.start({...source, buffer: {kind: 'buffer', content: sha256HexSync('unsaved')}}, 'unsaved'),
          );
          yield* Deferred.await(entered);
          expect(active).toBe(1);
        }),
      );
      expect(active).toBe(0);
      expect(closes).toBe(1);
      yield* TestClock.adjust(600001);
      yield* Effect.yieldNow;
      expect(active).toBe(0);
      expect(closes).toBe(1);
    }),
  );
  layerIt.effect('releases the original buffer reservation when concurrent job admission fills the registry', () =>
    Effect.gen(function* () {
      const reserving = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let closes = 0,
        bufferPreparations = 0;
      const jobs = yield* makeSemanticReadinessJobs({
        worktree: source.worktree,
        reserve: () =>
          Deferred.succeed(reserving, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(observation)),
        prepare: actual => {
          if (actual.buffer) bufferPreparations++;
          return Effect.never;
        },
        current: () => Effect.succeed(true),
        close: () =>
          Effect.sync(() => {
            closes++;
          }),
      });
      const pending = yield* jobs
        .start({...source, buffer: {kind: 'buffer', content: sha256HexSync('reserved')}}, 'reserved')
        .pipe(Effect.forkChild);
      yield* Deferred.await(reserving);
      for (let index = 0; index < 32; index++) accepted(yield* jobs.start(source, observation.content));
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(pending)).status).toBe('unavailable');
      expect(closes).toBe(1);
      expect(bufferPreparations).toBe(0);
    }),
  );
});
