import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Clock, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, PlatformError} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import fc from 'fast-check';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {RecallEmbeddingWakePort} from '@threadnote/recall/background/demand';
import {
  completeRecallLexicalRefresh,
  readRecallLexicalDemand,
  recallLexicalDemandKey,
  RECALL_LEXICAL_DEMAND_DIRECTORY,
  requestRecallLexicalRefresh,
} from '@threadnote/recall/background/lexical-demand';
import {deferRecallReadMaintenance} from '../../src/recall/read_maintenance.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

// Real filesystem/durable writes, with no process-identity commands or worker launch.
const system = Layer.effect(
  SystemInfo,
  Effect.map(SystemInfo, value => ({
    ...value,
    processStartIdentity: () => Effect.succeed('fixture-start'),
    canonicalProcessStartIdentity: () => Effect.succeed('fixture-start'),
  })),
).pipe(Layer.provide(TestSystemInfoLayer));
const platform = Layer.mergeAll(BunServices.layer, cryptoLayer, system);
// oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow scoped test entry; no application/model/command services.
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(platform));
const work = {kind: 'synchronize', sources: true} as const;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-maintenance-ack-'});
  const config = {
    account: 'local',
    user: 'tester',
    agentId: 'test',
    agentContextHome: home,
    manifestPath: path.join(home, 'manifest.yaml'),
  };
  const scope = {...config, includeInactive: false, work};
  const key = recallLexicalDemandKey(scope);
  const root = path.join(home, 'recall', RECALL_LEXICAL_DEMAND_DIRECTORY);
  return {fs, path, config, scope, state: path.join(root, key + '.json'), lock: path.join(root, key + '.lock')};
});
const assertPersistedBeforeWake = (f: Effect.Success<typeof fixture>, home: string) =>
  Effect.gen(function* () {
    expect(home).toBe(f.config.agentContextHome);
    const demand = yield* readRecallLexicalDemand(f.scope);
    expect(demand?.revision).toBeDefined();
    expect(demand?.work).toEqual(work);
    expect(demand?.account).toBe(f.config.account);
    expect(demand?.user).toBe(f.config.user);
    expect(demand?.manifestPath).toBe(f.config.manifestPath);
    expect(yield* f.fs.exists(f.lock)).toBe(false);
    return demand?.revision;
  }).pipe(Effect.provideService(FileSystem.FileSystem, f.fs), Effect.provideService(Path.Path, f.path), Effect.orDie);

effectIt.effect(
  'retains the durable queue acknowledgement when its post-commit wake reaches the original100ms limit',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const waking = yield* Deferred.make<void>();
      let finalized = 0;
      const started = yield* Clock.monotonicTimeNanos;
      const reader = yield* deferRecallReadMaintenance(f.config, work).pipe(
        Effect.provideService(RecallEmbeddingWakePort, home =>
          assertPersistedBeforeWake(f, home).pipe(
            Effect.andThen(Deferred.succeed(waking, undefined)),
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized++;
              }),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(waking);
      const revision = (yield* readRecallLexicalDemand(f.scope))?.revision;
      yield* TestClock.adjust(100);
      expect(yield* Fiber.join(reader)).toBe('queued');
      expect((yield* readRecallLexicalDemand(f.scope))?.revision).toBe(revision);
      expect(finalized).toBe(1);
      expect((yield* Clock.monotonicTimeNanos) - started).toBe(100_000_000n);
    }).pipe(provide),
);

for (const oldPending of [false, true]) {
  effectIt.effect(
    `a pre-commit timeout cannot acknowledge ${oldPending ? 'an older pending' : 'a missing'} revision`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        if (oldPending) yield* requestRecallLexicalRefresh(f.scope);
        const previous = yield* readRecallLexicalDemand(f.scope);
        const writing = yield* Deferred.make<void>();
        let wakes = 0;
        const fs = FileSystem.FileSystem.of({
          ...f.fs,
          rename: (from, to) =>
            to === f.state
              ? Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never))
              : f.fs.rename(from, to),
        });
        const reader = yield* deferRecallReadMaintenance(f.config, work).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(RecallEmbeddingWakePort, () =>
            Effect.sync(() => {
              wakes++;
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(writing);
        yield* TestClock.adjust(100);
        expect(yield* Fiber.join(reader)).toBe('unavailable');
        expect(yield* readRecallLexicalDemand(f.scope)).toEqual(previous);
        expect(wakes).toBe(0);
        expect(yield* f.fs.exists(f.lock)).toBe(false);
      }).pipe(provide),
  );
}

effectIt.effect('a persistence failure remains unavailable and never wakes', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let wakes = 0;
    const fs = FileSystem.FileSystem.of({
      ...f.fs,
      rename: (from, to) =>
        to === f.state
          ? Effect.fail(PlatformError.systemError({_tag: 'PermissionDenied', module: 'FileSystem', method: 'rename'}))
          : f.fs.rename(from, to),
    });
    expect(
      yield* deferRecallReadMaintenance(f.config, work).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(RecallEmbeddingWakePort, () =>
          Effect.sync(() => {
            wakes++;
          }),
        ),
      ),
    ).toBe('unavailable');
    expect(yield* readRecallLexicalDemand(f.scope)).toBeUndefined();
    expect(wakes).toBe(0);
    expect(yield* f.fs.exists(f.lock)).toBe(false);
  }).pipe(provide),
);

effectIt.effect('external cancellation stays interrupted after durable acceptance and finalizes its wake', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const waking = yield* Deferred.make<void>();
    let finalized = 0;
    const reader = yield* deferRecallReadMaintenance(f.config, work).pipe(
      Effect.provideService(RecallEmbeddingWakePort, home =>
        assertPersistedBeforeWake(f, home).pipe(
          Effect.andThen(Deferred.succeed(waking, undefined)),
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized++;
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(waking);
    const revision = (yield* readRecallLexicalDemand(f.scope))?.revision;
    yield* Fiber.interrupt(reader);
    const exit = yield* Fiber.await(reader);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(finalized).toBe(1);
    expect((yield* readRecallLexicalDemand(f.scope))?.revision).toBe(revision);
  }).pipe(provide),
);

effectIt.effect('recent completed synchronization remains current without another wake', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const revision = yield* requestRecallLexicalRefresh(f.scope);
    yield* completeRecallLexicalRefresh(f.scope, revision);
    let wakes = 0;
    expect(
      yield* deferRecallReadMaintenance(f.config, work).pipe(
        Effect.provideService(RecallEmbeddingWakePort, () =>
          Effect.sync(() => {
            wakes++;
          }),
        ),
      ),
    ).toBe('current');
    expect(wakes).toBe(0);
  }).pipe(provide),
);

fcEffectProp(
  effectIt,
  'durable acknowledgement survives every remaining wake window without resetting the100ms budget',
  [fc.integer({min: 1, max: 99})],
  ([persistenceMilliseconds]) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const writing = yield* Deferred.make<void>();
      const waking = yield* Deferred.make<void>();
      const fs = FileSystem.FileSystem.of({
        ...f.fs,
        rename: (from, to) =>
          to === f.state
            ? Deferred.succeed(writing, undefined).pipe(
                Effect.andThen(Effect.sleep(persistenceMilliseconds)),
                Effect.andThen(f.fs.rename(from, to)),
              )
            : f.fs.rename(from, to),
      });
      const started = yield* Clock.monotonicTimeNanos;
      const reader = yield* deferRecallReadMaintenance(f.config, work).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(RecallEmbeddingWakePort, home =>
          assertPersistedBeforeWake(f, home).pipe(
            Effect.andThen(Deferred.succeed(waking, undefined)),
            Effect.andThen(Effect.never),
          ),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(writing);
      yield* TestClock.adjust(persistenceMilliseconds);
      yield* Deferred.await(waking);
      yield* TestClock.adjust(100 - persistenceMilliseconds);
      expect(yield* Fiber.join(reader)).toBe('queued');
      expect((yield* Clock.monotonicTimeNanos) - started).toBe(100_000_000n);
      expect((yield* readRecallLexicalDemand(f.scope))?.revision).toBeDefined();
    }).pipe(provide),
  {fastCheck: {numRuns: 8}},
);
