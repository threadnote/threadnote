import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {sha256HexSync as hash} from '@threadnote/platform/sha256';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
import {
  claimDraftWork,
  enqueueDraftWork as enqueueQueueWork,
  finishDraftWork,
  markDraftWorkDispatched,
  publishDraftWorkReview,
  readDraftQueueStatus,
  readDraftQueueTarget,
  recordDraftQueueDecision,
  selectDraftQueueTargets,
  setDraftQueuePolicy,
  verifyDraftWorkClaim,
  type DraftQueueClaim,
  type DraftQueueWork,
} from '../../src/memory/context/maintenance_draft_queue.js';
import {AUTOMATIC_DRAFT_PROMPT_VERSION} from '../../src/effect/ai/selected_generation.js';

const layer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);
type Config = {account: string; agentContextHome: string};
const fixture = <A, E, R>(use: (config: Config) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'queue-test-'});
    return yield* use({account: 'queue-tests', agentContextHome: home});
  }).pipe(effect =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context))))),
  );
const work = (target: string, revision = 'one', extra: Partial<DraftQueueWork> = {}): DraftQueueWork => ({
  identity: hash(`${target}/${revision}`),
  targetKey: hash(target),
  targetUri: `threadnote://memory/${target}`,
  materialRevision: hash(revision),
  backend: 'local-ai',
  providerIdentity: hash('local-model'),
  modelId: 'test-model',
  purpose: 'automatic',
  foreground: false,
  expectedContentHash: hash('opening'),
  ...extra,
});
const enqueueDraftWork = (config: Config, w: DraftQueueWork) =>
  readDraftQueueStatus(config).pipe(
    Effect.flatMap(status =>
      enqueueQueueWork(config, {...w, ...(w.foreground ? {} : {policyRevision: status.policyRevision})}),
    ),
  );
const claimed = (config: Config, identity?: string) =>
  Effect.gen(function* () {
    const result = yield* claimDraftWork(config, identity ? {identity} : undefined);
    expect(result.state).toBe('claimed');
    if (result.state !== 'claimed') return yield* Effect.die(new Error(`Expected claim: ${result.reason}`));
    return result.claim;
  });
const complete = (config: Config, claim: DraftQueueClaim) =>
  Effect.gen(function* () {
    yield* markDraftWorkDispatched(config, claim);
    expect(yield* finishDraftWork(config, claim, {state: 'completed'})).toBe(true);
  });
const decision = (w: DraftQueueWork, action: 'reject' | 'defer' | 'resume') => ({
  targetKey: w.targetKey,
  targetUri: w.targetUri,
  materialRevision: w.materialRevision,
  action,
});

describe('private durable draft queue', () => {
  fcEffectProp(
    effectIt,
    'preserves consumed prompt identities and material decisions across prompt-version rotations',
    [
      fc.array(fc.integer({min: 3, max: 12}), {minLength: 1, maxLength: 6}),
      fc.constantFrom('reject' as const, 'defer' as const),
    ],
    ([versions, action]) =>
      fixture(config =>
        Effect.gen(function* () {
          const old = work('prompt-version', 'same-material', {identity: hash('automatic-memory-v1')});
          const current = {...old, identity: hash(AUTOMATIC_DRAFT_PROMPT_VERSION)};
          for (const candidate of [old, current]) {
            expect(yield* enqueueDraftWork(config, candidate)).toEqual({state: 'queued'});
            const claim = yield* claimed(config);
            yield* markDraftWorkDispatched(config, claim);
            yield* finishDraftWork(config, claim, {state: 'failed'});
          }
          expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(2);
          for (const candidate of [old, current, old])
            expect(yield* enqueueDraftWork(config, candidate)).toEqual({state: 'suppressed', reason: 'failed'});
          yield* recordDraftQueueDecision(config, decision(current, action));
          for (const version of [1, 2, ...versions]) {
            const next = {...old, identity: hash(`automatic-memory-v${version}`)};
            expect(yield* enqueueDraftWork({...config}, next)).toEqual({
              state: 'suppressed',
              reason: 'material-decision',
            });
            expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(2);
            expect((yield* readDraftQueueTarget(config, old.targetKey))?.decision).toBe(action);
          }
        }),
      ),
    {fastCheck: {numRuns: 4, seed: 20402}},
  );
  fcEffectProp(
    effectIt,
    'keeps a committed publication consumed and terminal through policy rotation, cleanup failure and restart',
    [
      fc.array(
        fc.record({
          paused: fc.boolean(),
          remote: fc.boolean(),
          advance: fc.integer({min: 0, max: 60_000}),
          finish: fc.boolean(),
        }),
        {minLength: 1, maxLength: 6},
      ),
    ],
    ([steps]) =>
      fixture(config =>
        Effect.gen(function* () {
          const item = work('publication-sequence');
          yield* enqueueDraftWork(config, item);
          const claim = yield* claimed(config);
          yield* markDraftWorkDispatched(config, claim);
          let publications = 0;
          const publish = Effect.sync(() => {
            publications++;
          });
          yield* publishDraftWorkReview(config, claim, publish);
          let elapsed = 0;
          let closed = false;
          for (const step of steps) {
            yield* setDraftQueuePolicy(config, {paused: step.paused, provider: step.remote ? 'effect-ai' : 'local-ai'});
            yield* TestClock.adjust(step.advance);
            elapsed += step.advance;
            if (step.finish) yield* finishDraftWork(config, claim, {state: 'failed', reason: 'cleanup-failed'});
            closed ||= step.finish || elapsed >= 120_000;
            const restarted = {...config};
            const status = yield* readDraftQueueStatus(restarted);
            expect(status.backgroundReservations).toHaveLength(1);
            if (closed) {
              expect(status.active).toBeUndefined();
              expect((yield* readDraftQueueTarget(restarted, item.targetKey))?.state).toBe('completed');
            } else expect(status.active).toMatchObject({token: claim.token});
            expect(Exit.isFailure(yield* Effect.exit(publishDraftWorkReview(restarted, claim, publish)))).toBe(true);
            expect(publications).toBe(1);
          }
          yield* finishDraftWork(config, claim, {state: 'failed', reason: 'cleanup-failed'});
          expect((yield* readDraftQueueTarget(config, item.targetKey))?.state).toBe('completed');
          expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(1);
        }),
      ),
    {fastCheck: {numRuns: 6, seed: 27183}},
  );

  for (const fault of ['none', 'before-marker', 'after-marker'] as const) {
    effectIt.effect(`recovers publication ${fault} without duplicate save or refunding dispatched inference`, () =>
      fixture(config =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const item = work('published');
          yield* enqueueDraftWork(config, item);
          const claim = yield* claimed(config);
          yield* markDraftWorkDispatched(config, claim);
          let publications = 0;
          let injected = false;
          const faulty = FileSystem.FileSystem.of({
            ...fs,
            rename: (from, to) =>
              Effect.gen(function* () {
                if (fault !== 'none' && !injected && to.endsWith('/queue.json')) {
                  injected = true;
                  if (fault === 'after-marker') yield* fs.rename(from, to);
                  return yield* fs.rename(`${from}.missing`, to);
                }
                return yield* fs.rename(from, to);
              }),
          });
          const publish = Effect.sync(() => {
            publications++;
          });
          const saved = yield* publishDraftWorkReview(config, claim, publish).pipe(
            Effect.provideService(FileSystem.FileSystem, faulty),
            Effect.exit,
          );
          expect(Exit.isSuccess(saved)).toBe(fault === 'none');
          expect(injected).toBe(fault !== 'none');
          expect(publications).toBe(1);
          if (fault !== 'before-marker') {
            // A policy change after a committed save does not un-publish it.
            yield* setDraftQueuePolicy(config, {paused: true});
          }
          yield* TestClock.adjust(120_000);
          const restarted = {...config};
          const state = yield* readDraftQueueStatus(restarted);
          expect(state.active).toBeUndefined();
          expect(state.backgroundReservations).toHaveLength(1);
          expect((yield* readDraftQueueTarget(restarted, item.targetKey))?.state).toBe(
            fault === 'before-marker' ? 'failed' : 'completed',
          );
          expect((yield* enqueueDraftWork(restarted, item)).state).toBe('suppressed');
          expect(Exit.isFailure(yield* Effect.exit(publishDraftWorkReview(restarted, claim, publish)))).toBe(true);
          expect(publications).toBe(1);
        }),
      ),
    );
  }
  effectIt.effect('never invokes publication after a completed queue policy invalidation', () =>
    fixture(config =>
      Effect.gen(function* () {
        yield* enqueueDraftWork(config, work('invalidated'));
        const claim = yield* claimed(config);
        let publications = 0;
        const publish = Effect.sync(() => {
          publications++;
        });
        expect(Exit.isFailure(yield* Effect.exit(publishDraftWorkReview(config, claim, publish)))).toBe(true);
        expect(publications).toBe(0);
        yield* markDraftWorkDispatched(config, claim);
        yield* setDraftQueuePolicy(config, {paused: true});
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              publishDraftWorkReview(
                config,
                claim,
                Effect.sync(() => {
                  publications++;
                }),
              ),
            ),
          ),
        ).toBe(true);
        expect(publications).toBe(0);
        expect(yield* finishDraftWork(config, claim, {state: 'failed'})).toBe(false);
        expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect('does not republish unchanged reads but persists initialization, recovery and quota pruning', () =>
    fixture(config =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.join(
          yield* fs.realPath(config.agentContextHome),
          'threadnote',
          'draft-queue',
          'v1',
          hash(config.account),
        );
        const ledger = path.join(root, 'queue.json');
        yield* readDraftQueueStatus(config);
        expect(yield* fs.exists(ledger)).toBe(true);
        yield* enqueueDraftWork(config, work('read-only'));
        const claim = yield* claimed(config);
        yield* markDraftWorkDispatched(config, claim);
        const original = yield* fs.readFileString(ledger);
        let publications = 0;
        let synchronizations = 0;
        const observed = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            fs.rename(from, to).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (to === ledger) publications++;
                }),
              ),
            ),
          open: (file, options) =>
            fs.open(file, options).pipe(
              Effect.map(handle =>
                file.startsWith(root)
                  ? new Proxy(handle, {
                      get: (target, key) =>
                        key === 'sync'
                          ? target.sync.pipe(
                              Effect.tap(() =>
                                Effect.sync(() => {
                                  synchronizations++;
                                }),
                              ),
                            )
                          : Reflect.get(target, key, target),
                    })
                  : handle,
              ),
            ),
        });
        yield* Effect.gen(function* () {
          for (let i = 0; i < 10; i++) {
            expect((yield* readDraftQueueStatus(config)).active?.token).toBe(claim.token);
            yield* verifyDraftWorkClaim(config, claim);
          }
          expect(publications).toBe(0);
          expect(synchronizations).toBe(0);
          expect(yield* fs.readFileString(ledger)).toBe(original);
          yield* TestClock.adjust(120_000);
          expect((yield* readDraftQueueStatus(config)).active).toBeUndefined();
          expect(publications).toBeGreaterThan(0);
          expect(synchronizations).toBeGreaterThan(0);
          expect(yield* readDraftQueueTarget(config, claim.work.targetKey)).toMatchObject({
            state: 'failed',
            reason: 'dispatch-outcome-unknown',
          });
          expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(1);
          const beforePrune = publications;
          yield* TestClock.adjust(3_600_000);
          expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(0);
          expect(publications).toBeGreaterThan(beforePrune);
          const afterPrune = publications;
          yield* readDraftQueueStatus(config);
          expect(publications).toBe(afterPrune);
        }).pipe(Effect.provideService(FileSystem.FileSystem, observed));
      }),
    ),
  );

  effectIt.effect('reserves four rolling-hour units before dispatch and prioritizes explicit work above the cap', () =>
    fixture(config =>
      Effect.gen(function* () {
        for (let i = 0; i < 4; i++) {
          yield* enqueueDraftWork(config, work(`done-${i}`));
          const claim = yield* claimed(config);
          expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(i + 1);
          yield* complete(config, claim);
        }
        yield* enqueueDraftWork(config, work('background'));
        expect(yield* claimDraftWork(config)).toMatchObject({state: 'waiting', reason: 'hourly-budget'});
        const explicit = work('explicit', 'one', {foreground: true});
        yield* enqueueDraftWork(config, explicit);
        const front = yield* claimed(config, explicit.identity);
        expect(front.work.identity).toBe(explicit.identity);
        yield* complete(config, front);
        expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(4);
        yield* TestClock.adjust(3_600_000);
        expect((yield* claimed(config)).work.targetKey).toBe(hash('background'));
      }),
    ),
  );

  effectIt.effect(
    'retains terminal full identities through same-material provider rotation without silent eviction',
    () =>
      fixture(config =>
        Effect.gen(function* () {
          const a = work('history', 'material', {identity: hash('provider-a')});
          const b = {...a, identity: hash('provider-b')};
          yield* enqueueDraftWork(config, a);
          yield* complete(config, yield* claimed(config));
          yield* enqueueDraftWork(config, b);
          const failed = yield* claimed(config);
          yield* markDraftWorkDispatched(config, failed);
          yield* finishDraftWork(config, failed, {state: 'failed'});
          expect(yield* enqueueDraftWork(config, a)).toMatchObject({state: 'suppressed', reason: 'completed'});
          expect(yield* enqueueDraftWork(config, b)).toMatchObject({state: 'suppressed', reason: 'failed'});
          for (let i = 2; i < 16; i++) {
            if (i % 4 === 0) yield* TestClock.adjust(3_600_000);
            yield* enqueueDraftWork(config, {...a, identity: hash(`provider-${i}`)});
            yield* complete(config, yield* claimed(config));
          }
          expect(yield* enqueueDraftWork(config, {...a, identity: hash('provider-overflow')})).toEqual({
            state: 'waiting',
            reason: 'identity-history-capacity',
          });
          expect((yield* readDraftQueueStatus(config)).waiting).toContainEqual({
            targetKey: a.targetKey,
            identity: hash('provider-overflow'),
            reason: 'identity-history-capacity',
          });
          expect(yield* enqueueDraftWork(config, a)).toMatchObject({state: 'suppressed', reason: 'completed'});
          yield* TestClock.adjust(3_600_000);
          const fresh = work('history', 'new-material');
          expect(yield* enqueueDraftWork(config, fresh)).toEqual({state: 'queued'});
          expect((yield* readDraftQueueTarget(config, a.targetKey))?.materialRevision).toBe(fresh.materialRevision);
        }),
      ),
  );

  fcEffectProp(
    effectIt,
    'matches independent same-material terminal history through A to B to A sequences',
    [
      fc.array(fc.record({identity: fc.integer({min: 0, max: 19}), failed: fc.boolean()}), {
        minLength: 3,
        maxLength: 16,
      }),
    ],
    ([sequence]) =>
      fixture(config =>
        Effect.gen(function* () {
          const terminal = new Map<number, 'completed' | 'failed'>();
          let reservations = 0;
          for (const item of [
            {identity: 0, failed: false},
            {identity: 1, failed: true},
            {identity: 0, failed: true},
            ...Array.from({length: 17}, (_, identity) => ({identity, failed: identity % 2 === 0})),
            ...sequence,
          ]) {
            const candidate = work('sequence', 'material', {identity: hash(`identity-${item.identity}`)});
            const prior = terminal.get(item.identity);
            const result = yield* enqueueDraftWork(config, candidate);
            if (prior) {
              expect(result).toEqual({state: 'suppressed', reason: prior});
            } else if (terminal.size === 16) {
              expect(result).toEqual({state: 'waiting', reason: 'identity-history-capacity'});
            } else {
              if (reservations === 4) {
                yield* TestClock.adjust(3_600_000);
                reservations = 0;
              }
              const claim = yield* claimed(config);
              yield* markDraftWorkDispatched(config, claim);
              const state = item.failed ? ('failed' as const) : ('completed' as const);
              expect(yield* finishDraftWork(config, claim, {state})).toBe(true);
              terminal.set(item.identity, state);
              reservations++;
            }
            expect((yield* readDraftQueueTarget(config, candidate.targetKey))?.materialRevision).toBe(
              candidate.materialRevision,
            );
            expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(reservations);
          }
        }),
      ),
    {fastCheck: {numRuns: 8, seed: 41901}},
  );

  effectIt.effect('retains the one transient retry and delay through same-material provider rotation', () =>
    fixture(config =>
      Effect.gen(function* () {
        const a = work('rotated-retry', 'material', {identity: hash('a')});
        const b = {...a, identity: hash('b')};
        yield* enqueueDraftWork(config, a);
        const first = yield* claimed(config);
        yield* markDraftWorkDispatched(config, first);
        yield* finishDraftWork(config, first, {state: 'failed', transient: true});
        const next = (yield* Clock.currentTimeMillis) + 300_000;
        yield* enqueueDraftWork(config, b);
        yield* complete(config, yield* claimed(config));
        yield* enqueueDraftWork(config, a);
        expect(yield* readDraftQueueTarget(config, a.targetKey)).toMatchObject({retryCount: 1, nextEligibleAt: next});
        expect(yield* claimDraftWork(config)).toMatchObject({state: 'waiting', reason: 'retry-delay'});
        yield* TestClock.adjust(300_000);
        const retry = yield* claimed(config);
        yield* markDraftWorkDispatched(config, retry);
        yield* finishDraftWork(config, retry, {state: 'failed', transient: true});
        expect(yield* readDraftQueueTarget(config, a.targetKey)).toMatchObject({state: 'failed', retryCount: 1});
        expect(yield* enqueueDraftWork(config, a)).toEqual({state: 'suppressed', reason: 'failed'});
      }),
    ),
  );

  effectIt.effect('retains a superseded dispatched identity without replacing newer same-material work', () =>
    fixture(config =>
      Effect.gen(function* () {
        const a = work('superseded', 'material', {identity: hash('a')});
        const b = {...a, identity: hash('b')};
        yield* enqueueDraftWork(config, a);
        const active = yield* claimed(config);
        yield* markDraftWorkDispatched(config, active);
        yield* enqueueDraftWork(config, b);
        expect(yield* finishDraftWork(config, active, {state: 'completed'})).toBe(false);
        expect((yield* readDraftQueueTarget(config, a.targetKey))?.identity).toBe(b.identity);
        yield* complete(config, yield* claimed(config));
        expect(yield* enqueueDraftWork(config, a)).toEqual({state: 'suppressed', reason: 'failed'});
        expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(2);
      }),
    ),
  );

  effectIt.effect(
    'admits a distinct explicit regeneration above the background cap while retaining autonomous dedupe and decisions',
    () =>
      fixture(config =>
        Effect.gen(function* () {
          for (let i = 0; i < 4; i++) {
            yield* enqueueDraftWork(config, work(`quota-${i}`));
            yield* complete(config, yield* claimed(config));
          }
          const base = work('regenerate', 'material', {purpose: 'topic', foreground: true});
          yield* enqueueDraftWork(config, base);
          yield* complete(config, yield* claimed(config));
          const explicit = {
            ...base,
            identity: hash('explicit-revision-2'),
            regenerate: true,
            dedupeIdentity: base.identity,
          };
          expect(yield* enqueueDraftWork(config, explicit)).toEqual({state: 'queued'});
          yield* complete(config, yield* claimed(config));
          expect(yield* enqueueDraftWork(config, explicit)).toEqual({state: 'suppressed', reason: 'completed'});
          expect(yield* enqueueDraftWork(config, {...base, foreground: false})).toEqual({
            state: 'suppressed',
            reason: 'completed',
          });
          expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(4);
          const next = {...explicit, identity: hash('explicit-revision-3')};
          yield* recordDraftQueueDecision(config, decision(base, 'defer'));
          expect(yield* enqueueDraftWork(config, next)).toMatchObject({
            state: 'suppressed',
            reason: 'material-decision',
          });
          yield* recordDraftQueueDecision(config, decision(base, 'resume'));
          expect(yield* enqueueDraftWork(config, next)).toEqual({state: 'queued'});
        }),
      ),
  );

  effectIt.effect(
    'coalesces latest material without losing target rotation and upgrades the same queued identity',
    () =>
      fixture(config =>
        Effect.gen(function* () {
          yield* enqueueDraftWork(config, work('a'));
          yield* enqueueDraftWork(config, work('b'));
          yield* enqueueDraftWork(config, work('a', 'two'));
          const a = yield* claimed(config);
          expect(a.work.identity).toBe(work('a', 'two').identity);
          yield* complete(config, a);
          yield* enqueueDraftWork(config, work('a', 'three'));
          const b = yield* claimed(config);
          expect(b.work.targetKey).toBe(hash('b'));
          yield* complete(config, b);
          yield* enqueueDraftWork(config, work('a', 'three', {foreground: true}));
          expect((yield* claimed(config)).work.foreground).toBe(true);
        }),
      ),
  );

  effectIt.effect('keeps one durable owner across concurrent contenders without holding a lock during model work', () =>
    TestClock.withLive(
      fixture(config =>
        Effect.gen(function* () {
          yield* enqueueDraftWork(config, work('a'));
          yield* enqueueDraftWork(config, work('b'));
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const owner = yield* Effect.gen(function* () {
            const claim = yield* claimed(config);
            yield* markDraftWorkDispatched(config, claim);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return yield* finishDraftWork(config, claim, {state: 'completed'});
          }).pipe(Effect.forkChild({startImmediately: true}));
          yield* Deferred.await(started);
          const contenders = yield* Effect.all([claimDraftWork(config), claimDraftWork(config)], {concurrency: 2});
          expect(contenders.every(result => result.state === 'waiting' && result.reason === 'active')).toBe(true);
          expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(1);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(owner)).toBe(true);
          expect((yield* claimed(config)).work.targetKey).toBe(hash('b'));
        }),
      ),
    ),
  );

  effectIt.effect('recovers a known unused lease but never refunds or rerolls dispatched unknown usage', () =>
    fixture(config =>
      Effect.gen(function* () {
        const a = work('a');
        yield* enqueueDraftWork(config, a);
        const unused = yield* claimed(config);
        yield* TestClock.adjust(120_000);
        const replacement = yield* claimed(config);
        expect(replacement.token).not.toBe(unused.token);
        expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(1);
        expect(yield* finishDraftWork(config, unused, {state: 'completed'})).toBe(false);
        yield* markDraftWorkDispatched(config, replacement);
        yield* TestClock.adjust(120_000);
        expect((yield* readDraftQueueStatus(config)).active).toBeUndefined();
        expect(yield* readDraftQueueTarget(config, a.targetKey)).toMatchObject({
          state: 'failed',
          reason: 'dispatch-outcome-unknown',
        });
        expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(1);
        expect(yield* enqueueDraftWork(config, a)).toMatchObject({state: 'suppressed'});
        expect(yield* finishDraftWork(config, replacement, {state: 'completed'})).toBe(false);
      }),
    ),
  );

  effectIt.effect('allows exactly one proven transient retry after five minutes, reserving another unit', () =>
    fixture(config =>
      Effect.gen(function* () {
        const a = work('a');
        yield* enqueueDraftWork(config, a);
        const first = yield* claimed(config);
        yield* markDraftWorkDispatched(config, first);
        yield* finishDraftWork(config, first, {state: 'failed', transient: true, reason: 'typed-transient'});
        expect(yield* claimDraftWork(config)).toMatchObject({
          state: 'waiting',
          reason: 'retry-delay',
          nextEligibleAt: (yield* Clock.currentTimeMillis) + 300_000,
        });
        yield* TestClock.adjust(299_999);
        expect((yield* claimDraftWork(config)).state).toBe('waiting');
        yield* TestClock.adjust(1);
        const second = yield* claimed(config);
        yield* markDraftWorkDispatched(config, second);
        yield* finishDraftWork(config, second, {state: 'failed', transient: true});
        expect(yield* enqueueDraftWork(config, a)).toMatchObject({state: 'suppressed', reason: 'failed'});
        expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(2);
        expect(yield* readDraftQueueTarget(config, a.targetKey)).toMatchObject({state: 'failed', retryCount: 1});
        yield* enqueueDraftWork(config, {...a, foreground: true});
        yield* complete(config, yield* claimed(config));
        expect(yield* enqueueDraftWork(config, {...a, foreground: true})).toMatchObject({
          state: 'suppressed',
          reason: 'completed',
        });
      }),
    ),
  );

  effectIt.effect('retains reject/defer across provider drift, availability, restart, and review/cache pruning', () =>
    fixture(config =>
      Effect.gen(function* () {
        const a = work('a');
        yield* enqueueDraftWork(config, a);
        const active = yield* claimed(config);
        yield* markDraftWorkDispatched(config, active);
        yield* recordDraftQueueDecision(config, decision(a, 'reject'));
        expect(yield* finishDraftWork(config, active, {state: 'completed'})).toBe(false);
        yield* recordDraftQueueDecision(config, decision(a, 'resume'));
        yield* setDraftQueuePolicy(config, {paused: true});
        const drift = {
          ...a,
          identity: hash('new-provider-identity'),
          providerIdentity: hash('other-provider'),
          foreground: true,
        };
        expect(yield* enqueueDraftWork(config, drift)).toMatchObject({state: 'suppressed'});
        expect((yield* readDraftQueueTarget({...config}, a.targetKey))?.decision).toBe('reject');
        const fresh = work('a', 'new-material');
        yield* recordDraftQueueDecision(config, decision(fresh, 'defer'));
        expect(yield* enqueueDraftWork(config, fresh)).toMatchObject({state: 'suppressed'});
        yield* recordDraftQueueDecision(config, decision(a, 'resume'));
        expect((yield* readDraftQueueTarget(config, a.targetKey))?.decision).toBe('defer');
        yield* recordDraftQueueDecision(config, decision(fresh, 'resume'));
        expect(yield* enqueueDraftWork(config, fresh)).toMatchObject({state: 'waiting', reason: 'background-paused'});
        expect((yield* readDraftQueueTarget(config, a.targetKey))?.decision).toBeUndefined();
      }),
    ),
  );

  effectIt.effect('fences superseded material and fabricated claim fields', () =>
    fixture(config =>
      Effect.gen(function* () {
        const old = work('a');
        yield* enqueueDraftWork(config, old);
        const first = yield* claimed(config);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              verifyDraftWorkClaim(config, {...first, work: {...first.work, expectedContentHash: hash('forged')}}),
            ),
          ),
        ).toBe(true);
        yield* markDraftWorkDispatched(config, first);
        yield* enqueueDraftWork(config, work('a', 'new'));
        expect(Exit.isFailure(yield* Effect.exit(verifyDraftWorkClaim(config, first)))).toBe(true);
        expect(yield* finishDraftWork(config, first, {state: 'completed'})).toBe(false);
        const next = yield* claimed(config);
        expect(next.work.materialRevision).toBe(hash('new'));
        expect(yield* finishDraftWork(config, first, {state: 'failed'})).toBe(false);
        yield* complete(config, next);
      }),
    ),
  );

  effectIt.effect('requires an exact finite remote grant and keeps remote selection after revocation', () =>
    fixture(config =>
      Effect.gen(function* () {
        const remote = work('remote', 'one', {backend: 'effect-ai', providerIdentity: hash('remote')});
        const initial = yield* readDraftQueueStatus(config);
        expect(initial.policy).toEqual({paused: false, provider: 'local-ai'});
        yield* setDraftQueuePolicy(config, {provider: 'effect-ai'});
        expect(yield* enqueueDraftWork(config, remote)).toMatchObject({
          state: 'waiting',
          reason: 'remote-grant-required',
        });
        for (const unitsPerHour of [0, 5, 1.5, Infinity, NaN])
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                setDraftQueuePolicy(config, {remoteGrant: {providerIdentity: remote.providerIdentity, unitsPerHour}}),
              ),
            ),
          ).toBe(true);
        yield* setDraftQueuePolicy(config, {remoteGrant: {providerIdentity: hash('other'), unitsPerHour: 1}});
        expect(yield* claimDraftWork(config)).toMatchObject({reason: 'remote-grant-required'});
        yield* setDraftQueuePolicy(config, {remoteGrant: {providerIdentity: remote.providerIdentity, unitsPerHour: 1}});
        yield* enqueueDraftWork(config, remote);
        yield* complete(config, yield* claimed(config));
        yield* enqueueDraftWork(
          config,
          work('remote-two', 'one', {backend: 'effect-ai', providerIdentity: remote.providerIdentity}),
        );
        expect(yield* claimDraftWork(config)).toMatchObject({reason: 'remote-budget'});
        const revoked = yield* setDraftQueuePolicy(config, {remoteGrant: null});
        expect(revoked.policy).toEqual({paused: false, provider: 'effect-ai'});
        expect(revoked.policyRevision).not.toBe(initial.policyRevision);
        expect(yield* claimDraftWork(config)).toMatchObject({reason: 'remote-grant-required'});
      }),
    ),
  );

  effectIt.effect('keeps background pause separate from explicit admission and honors all-maintenance pause', () =>
    fixture(config =>
      Effect.gen(function* () {
        yield* setDraftQueuePolicy(config, {paused: true});
        const a = work('a');
        yield* enqueueDraftWork(config, a);
        expect(yield* claimDraftWork(config)).toMatchObject({reason: 'background-paused'});
        const explicit = work('b', 'one', {foreground: true});
        yield* enqueueDraftWork(config, explicit);
        expect(yield* claimDraftWork(config, {identity: explicit.identity, allPaused: true})).toMatchObject({
          reason: 'all-maintenance-paused',
        });
        expect(yield* claimDraftWork(config, {identity: a.identity})).toMatchObject({reason: 'foreground-priority'});
        const claim = yield* claimed(config, explicit.identity);
        yield* setDraftQueuePolicy(config, {paused: false});
        yield* complete(config, claim);
      }),
    ),
  );

  effectIt.effect('persists sorted independent discovery rotation across calls and account-isolates state', () =>
    fixture(config =>
      Effect.gen(function* () {
        expect(yield* selectDraftQueueTargets(config, ['e', 'd', 'c', 'b', 'a', 'a'])).toEqual(['a', 'b', 'c', 'd']);
        expect(yield* selectDraftQueueTargets({...config}, ['a', 'b', 'c', 'd', 'e'], 2)).toEqual(['e', 'a']);
        expect(yield* selectDraftQueueTargets(config, ['a', 'b', 'c', 'd', 'e'], 100)).toEqual(['b', 'c', 'd', 'e']);
        yield* enqueueDraftWork(config, work('a'));
        expect((yield* readDraftQueueStatus({...config, account: 'other'})).queued).toEqual([]);
      }),
    ),
  );

  effectIt.effect('bounds backlog explicitly without evicting current decisions', () =>
    fixture(config =>
      Effect.gen(function* () {
        const rejected = work('rejected');
        yield* recordDraftQueueDecision(config, decision(rejected, 'reject'));
        for (let i = 0; i < 128; i++) yield* enqueueDraftWork(config, work(`target-${i}`));
        expect(yield* enqueueDraftWork(config, work('overflow'))).toEqual({state: 'waiting', reason: 'queue-capacity'});
        expect(yield* enqueueDraftWork(config, work('target-0', 'changed'))).toEqual({state: 'queued'});
        expect((yield* readDraftQueueStatus(config)).queued).toHaveLength(128);
        expect(yield* enqueueDraftWork(config, rejected)).toMatchObject({state: 'suppressed'});
      }),
    ),
  );

  effectIt.effect('preserves malformed ledgers and checkpoints and uses private filesystem modes', () =>
    fixture(config =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const a = work('a');
        yield* enqueueDraftWork(config, a);
        const root = path.join(config.agentContextHome, 'threadnote', 'draft-queue', 'v1', hash(config.account));
        expect((yield* fs.stat(root)).mode & 0o777).toBe(0o700);
        const ledger = path.join(root, 'queue.json');
        expect((yield* fs.stat(ledger)).mode & 0o777).toBe(0o600);
        const original = yield* fs.readFileString(ledger);
        yield* fs.writeFileString(ledger, '{broken');
        expect(Exit.isFailure(yield* Effect.exit(readDraftQueueStatus(config)))).toBe(true);
        expect(yield* fs.readFileString(ledger)).toBe('{broken');
        yield* fs.writeFileString(ledger, original);
        const checkpoint = path.join(root, `target-${a.targetKey}.json`);
        yield* fs.writeFileString(checkpoint, '{}');
        expect(Exit.isFailure(yield* Effect.exit(enqueueDraftWork(config, a)))).toBe(true);
        expect(yield* fs.readFileString(checkpoint)).toBe('{}');
      }),
    ),
  );

  effectIt.effect(
    'requires background policy provenance and fences policy drift while preserving explicit admission',
    () =>
      fixture(config =>
        Effect.gen(function* () {
          const a = work('policy');
          expect(yield* enqueueQueueWork(config, a)).toMatchObject({state: 'waiting', reason: 'policy-revision-drift'});
          expect(yield* claimDraftWork(config)).toMatchObject({reason: 'policy-revision-drift'});
          yield* enqueueDraftWork(config, a);
          const claim = yield* claimed(config);
          yield* setDraftQueuePolicy(config, {paused: true});
          expect(Exit.isFailure(yield* Effect.exit(markDraftWorkDispatched(config, claim)))).toBe(true);
          expect(yield* finishDraftWork(config, claim, {state: 'completed'})).toBe(false);
          expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(0);
          yield* enqueueDraftWork(config, {...a, foreground: true});
          const explicit = yield* claimed(config);
          yield* setDraftQueuePolicy(config, {provider: 'effect-ai'});
          yield* complete(config, explicit);
        }),
      ),
  );

  fcEffectProp(
    effectIt,
    'matches an independent target FIFO and global reservation model through material updates',
    [
      fc.array(fc.record({target: fc.integer({min: 0, max: 4}), revision: fc.integer({min: 0, max: 20})}), {
        minLength: 1,
        maxLength: 16,
      }),
    ],
    ([updates]) =>
      fixture(config =>
        Effect.gen(function* () {
          const fifo: number[] = [];
          const latest = new Map<number, number>();
          for (const update of updates) {
            if (!latest.has(update.target)) fifo.push(update.target);
            latest.set(update.target, update.revision);
            yield* enqueueDraftWork(config, work(`p${update.target}`, `${update.revision}`));
          }
          let admitted = 0;
          for (const target of fifo) {
            if (admitted === 4) {
              expect(yield* claimDraftWork(config)).toMatchObject({reason: 'hourly-budget'});
              yield* TestClock.adjust(3_600_000);
              admitted = 0;
            }
            const claim = yield* claimed(config);
            expect(claim.work.identity).toBe(work(`p${target}`, `${latest.get(target)}`).identity);
            expect((yield* claimDraftWork(config)).state).toBe('waiting');
            yield* complete(config, claim);
            admitted++;
            expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(admitted);
            expect(yield* enqueueDraftWork(config, claim.work)).toMatchObject({
              state: 'suppressed',
              reason: 'completed',
            });
          }
          expect((yield* readDraftQueueStatus(config)).queued).toEqual([]);
        }),
      ),
    {fastCheck: {numRuns: 12, seed: 19101}},
  );
  effectIt.effect(
    'replays checkpoint WAL after publication faults without refunding dispatched use or losing terminal identity',
    () =>
      fixture(config =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const a = work('wal');
          const file = `target-${a.targetKey}.json`;
          let injected = false;
          const faulty = FileSystem.FileSystem.of({
            ...fs,
            rename: (from, to) =>
              Effect.gen(function* () {
                if (!injected && path.basename(to) === file) {
                  injected = true;
                  return yield* fs.rename(`${from}.missing`, to);
                }
                return yield* fs.rename(from, to);
              }),
          });
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                enqueueDraftWork(config, a).pipe(Effect.provideService(FileSystem.FileSystem, faulty)),
              ),
            ),
          ).toBe(true);
          expect(injected).toBe(true);
          expect((yield* readDraftQueueTarget({...config}, a.targetKey))?.identity).toBe(a.identity);
          const active = yield* claimed(config);
          yield* markDraftWorkDispatched(config, active);
          injected = false;
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                finishDraftWork(config, active, {state: 'completed'}).pipe(
                  Effect.provideService(FileSystem.FileSystem, faulty),
                ),
              ),
            ),
          ).toBe(true);
          expect(injected).toBe(true);
          const recovered = yield* readDraftQueueStatus({...config});
          expect(recovered.active).toBeUndefined();
          expect(recovered.backgroundReservations).toHaveLength(1);
          expect((yield* readDraftQueueTarget(config, a.targetKey))?.state).toBe('completed');
          expect(yield* enqueueDraftWork(config, a)).toEqual({state: 'suppressed', reason: 'completed'});
          expect(yield* finishDraftWork(config, active, {state: 'failed'})).toBe(false);
        }),
      ),
  );
  effectIt.effect('serializes actual independent processes on the same canonical home and account', () =>
    TestClock.withLive(
      fixture(config =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const harness = path.join(config.agentContextHome, 'queue-process.mjs');
          const release = path.join(config.agentContextHome, 'release');
          const started = path.join(config.agentContextHome, 'started');
          const waiting = path.join(config.agentContextHome, 'waiting');
          const module = (relative: string) => JSON.stringify(path.resolve(relative));
          yield* fs.writeFileString(
            harness,
            `
import {Clock, Effect, FileSystem, Layer} from ${module('node_modules/effect/dist/index.js')};
import * as BunServices from ${module('node_modules/@effect/platform-bun/dist/BunServices.js')};
import {TestSystemInfoLayer} from ${module('apps/threadnote/test/helpers/system-layer.ts')};
import {enqueueDraftWork, readDraftQueueStatus, claimDraftWork, markDraftWorkDispatched, finishDraftWork}
  from ${module('apps/threadnote/src/memory/context/maintenance_draft_queue.ts')};
const config = ${JSON.stringify(config)};
const work = ${JSON.stringify(work('process'))};
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const status = yield* readDraftQueueStatus(config);
  yield* enqueueDraftWork(config, {...work, policyRevision: status.policyRevision});
  const admitted = yield* claimDraftWork(config);
  if (admitted.state === 'claimed') {
    yield* markDraftWorkDispatched(config, admitted.claim);
    yield* fs.writeFileString(${JSON.stringify(started)}, 'claimed');
    const deadline = (yield* Clock.currentTimeMillis) + 10000;
    while (!(yield* fs.exists(${JSON.stringify(release)}))) {
      if ((yield* Clock.currentTimeMillis) >= deadline) throw new Error('Missing test owner release.');
      yield* Effect.sleep(20);
    }
    if (!(yield* finishDraftWork(config, admitted.claim, {state: 'completed'}))) throw new Error('Lost owner.');
  }
  if (admitted.state === 'waiting') yield* fs.writeFileString(${JSON.stringify(waiting)}, admitted.reason);
  return {state: admitted.state, reason: admitted.reason};
});
console.log(JSON.stringify(await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer))))))));
`,
          );
          const contender = runCommandEffect(system.executablePath, [harness], {allowFailure: true, timeoutMs: 15_000});
          const outputs: unknown[] = [];
          const contenders = yield* Effect.forEach(
            [contender, contender],
            child =>
              child.pipe(
                Effect.tap(result =>
                  Effect.sync(() => {
                    outputs.push(result);
                  }),
                ),
              ),
            {concurrency: 2},
          ).pipe(Effect.forkChild());
          const deadline = (yield* Clock.currentTimeMillis) + 10_000;
          while (!(yield* fs.exists(started)) && (yield* Clock.currentTimeMillis) < deadline) yield* Effect.sleep(20);
          expect(yield* fs.exists(started), JSON.stringify(outputs)).toBe(true);
          const active = yield* readDraftQueueStatus(config);
          expect(active.active?.work.targetKey).toBe(hash('process'));
          expect(active.backgroundReservations).toHaveLength(1);
          while (!(yield* fs.exists(waiting)) && outputs.length === 0 && (yield* Clock.currentTimeMillis) < deadline)
            yield* Effect.sleep(20);
          const waited = yield* fs.exists(waiting);
          yield* fs.writeFileString(release, 'release');
          const results = yield* Fiber.join(contenders);
          for (const result of results) expect(result.exitCode, result.stdout + result.stderr).toBe(0);
          expect(waited, JSON.stringify(results)).toBe(true);
          expect(yield* fs.readFileString(waiting)).toBe('active');
          const states = results.map(result => JSON.parse(result.stdout.trim()) as {state: string; reason?: string});
          expect(states.filter(result => result.state === 'claimed')).toHaveLength(1);
          expect(states.filter(result => result.state === 'waiting')).toHaveLength(1);
          expect((yield* readDraftQueueStatus(config)).backgroundReservations).toHaveLength(1);
          expect((yield* readDraftQueueTarget(config, hash('process')))?.state).toBe('completed');
        }),
      ),
    ),
  );
  effectIt.effect('tolerates another process creating a private directory between existence check and mkdir', () =>
    fixture(config =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let raced = false;
        const racing = FileSystem.FileSystem.of({
          ...fs,
          makeDirectory: (directory, options) =>
            Effect.gen(function* () {
              if (!raced && directory.endsWith('threadnote')) {
                raced = true;
                yield* fs.makeDirectory(directory, options);
              }
              return yield* fs.makeDirectory(directory, options);
            }),
        });
        expect(
          yield* enqueueDraftWork(config, work('mkdir-race')).pipe(
            Effect.provideService(FileSystem.FileSystem, racing),
          ),
        ).toEqual({state: 'queued'});
        expect(raced).toBe(true);
        expect((yield* readDraftQueueStatus(config)).queued).toHaveLength(1);
      }),
    ),
  );
});
