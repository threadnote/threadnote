import {it as effectIt} from '@effect/vitest';
import {SecureRandom} from 'effect/crypto';
import {Clock, Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, vi} from 'vitest';
import * as WorkerControl from '@threadnote/inference/background/worker-control';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {SystemInfo} from '@threadnote/platform/system';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {makeBackgroundWorkerLifecycle, wakeBackgroundWorker} from '@threadnote/inference/background/worker-control';
import {
  createLocalBinsWorkerDrains,
  drainLocalBinsWorkers,
  localBinsWorkerOptions,
  localBinsWorkerDrainLayer,
  type LocalBinsPositiveHome,
} from '../helpers/local-bins-worker-drain.js';

const fixture = (positiveHome: LocalBinsPositiveHome = 'main') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const actual = yield* SystemInfo;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'local-bins-drain-'}));
    const home = path.join(root, 'home');
    yield* fs.makeDirectory(home);
    yield* fs.makeDirectory(path.join(root, 'repo'));
    yield* fs.makeDirectory(path.join(root, 'installation'));
    const identities = new Map<number, string | undefined>([[actual.processId, 'fixture-parent']]);
    const system = SystemInfo.of({
      ...actual,
      homeDirectory: home,
      environment: () => ({
        HOME: home,
        USERPROFILE: home,
        THREADNOTE_HOME: home,
        THREADNOTE_INSTALL_ROOT: path.join(root, 'installation'),
      }),
      isProcessRunning: pid => identities.has(pid),
      processStartIdentity: pid => Effect.succeed(identities.get(pid)),
      canonicalProcessStartIdentity: pid => Effect.succeed(identities.get(pid)),
    });
    const run = <A, E, R>(program: Effect.Effect<A, E, R>) => program.pipe(Effect.provideService(SystemInfo, system));
    const capabilities = yield* run(createLocalBinsWorkerDrains(home, root, actual.executablePath, positiveHome));
    const options = localBinsWorkerOptions(path, home, yield* getThreadnoteVersion());
    const register = (index: number, wrongIdentity = false) =>
      Effect.gen(function* () {
        let nonce = '';
        yield* run(
          wakeBackgroundWorker({
            ...options[index],
            launch: value =>
              Effect.sync(() => {
                nonce = value;
                return true;
              }),
          }),
        );
        const pid = 1000000 + index;
        identities.set(pid, 'owned-worker');
        const owner = {
          token: yield* (yield* SecureRandom.SecureRandom).uuidV4(),
          processId: pid,
          processStartIdentity: wrongIdentity ? 'foreign-worker' : 'owned-worker',
        };
        const lifecycle = yield* makeBackgroundWorkerLifecycle(options[index], nonce).pipe(
          Effect.provideService(SystemInfo, SystemInfo.of({...system, processId: pid})),
        );
        yield* lifecycle.register(owner);
        return {pid, owner, lifecycle};
      });
    return {fs, path, root, home, actual, identities, system, run, capabilities, options, register};
  });

for (const domain of [0, 1])
  effectIt.effect(
    `domain${domain} return barrier closes launches and awaits the owned instance after its producer returned`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const child = yield* f.register(domain);
        expect(yield* child.lifecycle.activate(child.owner)).toBe(true);
        // The parent's operation can finish and the worker release its domain lock, while the instance still lives.
        yield* child.lifecycle.afterRelease(false);
        const closed = yield* Deferred.make<void>();
        const observed = FileSystem.FileSystem.of({
          ...f.fs,
          rename: (from, to) =>
            f.fs
              .rename(from, to)
              .pipe(
                Effect.tap(() =>
                  to === f.options[domain].receiptPath + '.launch-v2.json'
                    ? Deferred.succeed(closed, undefined)
                    : Effect.void,
                ),
              ),
        });
        let removed = false;
        const barrier = yield* f.run(
          drainLocalBinsWorkers(f.capabilities, (yield* Clock.currentTimeMillis) + 2000).pipe(
            Effect.andThen(
              Effect.sync(() => {
                removed = true;
              }),
            ),
            Effect.provideService(FileSystem.FileSystem, observed),
            Effect.forkScoped,
          ),
        );
        yield* Deferred.await(closed);
        expect(removed).toBe(false);
        expect(barrier.pollUnsafe()).toBeUndefined();
        expect(yield* f.run(wakeBackgroundWorker(f.options[domain]))).toMatchObject({state: 'deferred'});
        expect(yield* child.lifecycle.shouldDrain).toBe(true);
        f.identities.delete(child.pid);
        const results = yield* Fiber.join(barrier);
        expect(results).toBeUndefined();
        expect(removed).toBe(true);
      }).pipe(TestClock.withLive, provideTestLayer(localBinsWorkerDrainLayer)),
  );

effectIt.effect(
  'refuses a wrong registered worker identity and a reused creator instead of treating either as empty',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* f.register(0, true).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {reason: 'ownership'},
      });
      expect(
        yield* f
          .run(drainLocalBinsWorkers(f.capabilities, (yield* Clock.currentTimeMillis) + 1000))
          .pipe(Effect.result),
      ).toMatchObject({_tag: 'Failure'});
      expect(yield* f.fs.exists(f.home)).toBe(true);
      const other = yield* fixture();
      other.identities.set(other.actual.processId, 'reused-parent');
      expect(
        yield* other
          .run(drainLocalBinsWorkers(other.capabilities, (yield* Clock.currentTimeMillis) + 1000))
          .pipe(Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: {reason: 'ownership'}});
    }).pipe(provideTestLayer(localBinsWorkerDrainLayer)),
);

effectIt.effect('missing control evidence is unobserved, and an absent negative home is never created', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const absent = f.path.join(f.root, 'absent');
    expect(
      yield* f.run(createLocalBinsWorkerDrains(absent, f.root, f.actual.executablePath, 'main')).pipe(Effect.result),
    ).toMatchObject({_tag: 'Failure'});
    expect(yield* f.fs.exists(absent)).toBe(false);
    yield* f.fs.remove(f.options[0].receiptPath + '.launch-v2.json');
    expect(
      yield* f.run(drainLocalBinsWorkers(f.capabilities, (yield* Clock.currentTimeMillis) + 1000)).pipe(Effect.result),
    ).toMatchObject({_tag: 'Failure', failure: {reason: 'ownership'}});
  }).pipe(provideTestLayer(localBinsWorkerDrainLayer)),
);

fcEffectProp(
  effectIt,
  'empty registered domains drain in either order without treating foreign creator identity as exit',
  [fc.boolean(), fc.boolean()],
  ([reverse, reused]) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const capabilities = reverse ? [...f.capabilities].reverse() : f.capabilities;
      if (reused) f.identities.set(f.actual.processId, 'different-process-instance');
      const result = yield* f
        .run(drainLocalBinsWorkers(capabilities, (yield* Clock.currentTimeMillis) + 1000))
        .pipe(Effect.result);
      if (reused) expect(result).toMatchObject({_tag: 'Failure', failure: {reason: 'ownership'}});
      else
        expect(result).toMatchObject({
          _tag: 'Success',
          success: [
            {state: 'drained', generationCount: 0},
            {state: 'drained', generationCount: 0},
          ],
        });
    }).pipe(provideTestLayer(localBinsWorkerDrainLayer)),
  {fastCheck: {numRuns: 8}},
);

effectIt.effect('identifies two fixed positive-home/domain drain boundaries and retains their original failure', () =>
  Effect.gen(function* () {
    const messages: string[] = [];
    for (const [positiveHome, index, domain] of [
      ['main', 0, 'recall'],
      ['migration-partial-share', 1, 'graph'],
    ] as const) {
      const f = yield* fixture(positiveHome);
      const original = WorkerControl.BackgroundWorkerFixtureDrainUnavailable.make({reason: 'deadline'});
      const deadline = (yield* Clock.currentTimeMillis) + 1000;
      const error = yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(WorkerControl, 'drainBackgroundWorkerFixture').mockImplementation((_capability, actualDeadline) => {
            expect(actualDeadline).toBe(deadline);
            return Effect.fail(original);
          }),
        ),
        () => f.run(drainLocalBinsWorkers([f.capabilities[index]], deadline)).pipe(Effect.flip),
        spy => Effect.sync(() => spy.mockRestore()),
      );
      expect(error).toMatchObject({positiveHome, domain, stage: 'drain', reason: 'deadline'});
      expect(error.cause).toBe(original);
      expect(error.cause).toMatchObject({_tag: 'BackgroundWorkerFixtureDrainUnavailable', reason: 'deadline'});
      expect(error.message).toBe(`Local-bins ${positiveHome} ${domain} drain failed: deadline.`);
      expect(error.message).not.toContain(f.home);
      expect(error.message).not.toContain(String(f.actual.processId));
      messages.push(error.message);
    }
    expect(messages[0]).not.toBe(messages[1]);
  }).pipe(provideTestLayer(localBinsWorkerDrainLayer)),
);

effectIt.effect('identifies fixed enrollment context without replacing the original tagged cause', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const original = WorkerControl.BackgroundWorkerFixtureDrainUnavailable.make({reason: 'identity-unknown'});
    const error = yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(WorkerControl, 'createBackgroundWorkerFixtureDrain').mockImplementation(() => Effect.fail(original)),
      ),
      () =>
        f.run(createLocalBinsWorkerDrains(f.home, f.root, f.actual.executablePath, 'report-preview')).pipe(Effect.flip),
      spy => Effect.sync(() => spy.mockRestore()),
    );
    expect(error).toMatchObject({
      positiveHome: 'report-preview',
      domain: 'recall',
      stage: 'enrollment',
      reason: 'identity-unknown',
    });
    expect(error.cause).toBe(original);
    expect(error.message).toBe('Local-bins report-preview recall enrollment failed: identity-unknown.');
    expect(error.message).not.toContain(f.home);
  }).pipe(provideTestLayer(localBinsWorkerDrainLayer)),
);
