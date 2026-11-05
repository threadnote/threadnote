import {it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Effect, Fiber, FileSystem, Path, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {wakeBackgroundWorker} from '@threadnote/inference/background/worker-control';
import {readRecallEmbeddingDemand, requestRecallEmbeddings} from '@threadnote/recall/background/demand';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  createRecallEmbeddingWorkerFixtureDrain,
  drainRecallEmbeddingWorkerFixture,
  recallEmbeddingWorkerHomeProgram,
  recallEmbeddingWorkerPaths,
} from '../../src/recall/embedding_worker_process.js';
import {RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION} from '../../src/worker_protocol.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

effectIt.effect('uses an original Effect Clock epoch-millisecond deadline and refuses an extension', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'recall-drain-expired-'}));
    const capability = yield* createRecallEmbeddingWorkerFixtureDrain(home, home);
    const absoluteDeadlineEpochMilliseconds = (yield* Clock.currentTimeMillis) - 1;
    expect(
      yield* drainRecallEmbeddingWorkerFixture(capability, absoluteDeadlineEpochMilliseconds).pipe(Effect.result),
    ).toMatchObject({_tag: 'Failure', failure: {reason: 'deadline'}});
    expect(
      yield* drainRecallEmbeddingWorkerFixture(capability, (yield* Clock.currentTimeMillis) + 1000).pipe(Effect.result),
    ).toMatchObject({_tag: 'Failure', failure: {reason: 'deadline'}});
    expect(yield* fs.exists(home)).toBe(true);
  }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect('cooperatively drains a home host between units while preserving its desired work', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const actual = yield* SystemInfo;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'recall-owned-drain-'}));
    const capability = yield* createRecallEmbeddingWorkerFixtureDrain(home, home);
    const version = yield* getThreadnoteVersion();
    const paths = recallEmbeddingWorkerPaths(path, home);
    const scope = {agentContextHome: home, account: 'local', user: 'fixture'};
    yield* requestRecallEmbeddings(scope);
    const desired = (yield* readRecallEmbeddingDemand(scope))?.desired;
    let nonce = '';
    yield* wakeBackgroundWorker({
      home,
      ...paths,
      version,
      protocol: RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION,
      launch: value =>
        Effect.sync(() => {
          nonce = value;
          return true;
        }),
    });
    let childRunning = true;
    const childPid = 1234567;
    const observe = SystemInfo.of({
      ...actual,
      isProcessRunning: pid => (pid === childPid ? childRunning : actual.isProcessRunning(pid)),
      processStartIdentity: pid =>
        pid === childPid ? Effect.succeed('owned-recall-child') : actual.processStartIdentity(pid),
    });
    const unitFinished = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const host = yield* recallEmbeddingWorkerHomeProgram(home, nonce, {
      onUnitResult: () => Deferred.succeed(unitFinished, undefined).pipe(Effect.andThen(Deferred.await(release))),
    }).pipe(Effect.provideService(SystemInfo, SystemInfo.of({...observe, processId: childPid})), Effect.forkScoped);
    yield* Deferred.await(unitFinished).pipe(Effect.timeout('3 seconds'));
    const drain = yield* drainRecallEmbeddingWorkerFixture(capability, (yield* Clock.currentTimeMillis) + 2000).pipe(
      Effect.provideService(SystemInfo, observe),
      Effect.forkScoped,
    );
    let closed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (EffectString.includes('"phase":"closing"')(yield* fs.readFileString(paths.receiptPath + '.launch-v2.json'))) {
        closed = true;
        break;
      }
      yield* Effect.sleep(1);
    }
    expect(closed).toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(host);
    expect(yield* fs.exists(paths.receiptPath)).toBe(false);
    expect((yield* readRecallEmbeddingDemand(scope))?.desired).toEqual(desired);
    childRunning = false;
    expect(yield* Fiber.join(drain)).toEqual({state: 'drained', generationCount: 1});
  }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect('allows a harness to pin a different candidate runtime without launching it', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'recall-drain-runtime-'}));
    const executablePath = path.join(home, 'candidate');
    yield* fs.writeFileString(executablePath, 'synthetic executable binding only');
    const capability = yield* createRecallEmbeddingWorkerFixtureDrain(home, home, {
      executablePath,
      version: 'fixture-candidate',
    });
    const state = yield* fs.readFileString(recallEmbeddingWorkerPaths(path, home).receiptPath + '.launch-v2.json');
    expect(state).toContain(executablePath);
    expect(state).toContain('fixture-candidate');
    expect(yield* drainRecallEmbeddingWorkerFixture(capability, (yield* Clock.currentTimeMillis) + 1000)).toEqual({
      state: 'drained',
      generationCount: 0,
    });
  }).pipe(provideTestLayer(ApplicationLayer)),
);
