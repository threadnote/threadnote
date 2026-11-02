import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Context, Crypto, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Queue} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {BackgroundInferenceAdmission, BackgroundInferenceDeferred} from '@threadnote/inference/background/admission';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {readRecallEmbeddingDemand, requestRecallEmbeddings} from '@threadnote/recall/background/demand';
import {loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import {SystemInfo} from '@threadnote/platform/system';
import {runRecallEmbeddingWorker} from '../../src/recall/embedding_worker.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const manifest = {...BUILTIN_MODEL_MANIFESTS[0], role: 'embedding' as const, dimensions: 2};
const base = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, LocalModelCatalog.layer([manifest]));
const immediate = BackgroundInferenceAdmission.of({
  withForeground: (_home, program) => program,
  withExecution: (_authority, program) => program,
  runBatch: (_home, _domain, program) => program.pipe(Effect.map(value => ({state: 'completed' as const, value}))),
});
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-worker-'});
  const config = {account: 'local', agentContextHome: home, user: 'tester'};
  const resource = path.join(home, 'data/local/resources/repos/threadnote/document.md');
  yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
  yield* fs.writeFileString(resource, 'Synthetic resumable worker document.');
  yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
  yield* requestRecallEmbeddings(config);
  const installation = {
    bytes: 1,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: '/fake/model.gguf',
    verified: true,
  };
  const store = LocalModelStore.of({
    install: () => Effect.die('unexpected installation'),
    path: () => installation.path,
    remove: () => Effect.succeed(false),
    status: () => Effect.succeed(installation),
    verify: () => Effect.succeed(installation),
  });
  let calls = 0;
  const runtime = LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 1}),
    embedMany: request =>
      Effect.sync(() => {
        expect(request.inputs).toHaveLength(1);
        calls++;
        return [[1, 0]];
      }),
    generate: () => Effect.die('unexpected generation'),
    rerank: () => Effect.die('unexpected rerank'),
  });
  return {
    config,
    fs,
    resource,
    store,
    runtime,
    calls: () => calls,
    run: runRecallEmbeddingWorker(config).pipe(
      Effect.provideService(LocalModelStore, store),
      Effect.provideService(LocalModelRuntime, runtime),
    ),
  };
});
describe('recall embedding worker', () => {
  effectIt.effect('resumes a persisted request in an independent worker and clears only verified current demand', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect((yield* recallIndexStatus(f.config, false)).ready).toBe(false);
      expect(yield* f.run.pipe(Effect.provideService(BackgroundInferenceAdmission, immediate))).toEqual({
        state: 'complete',
      });
      expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toBeUndefined();
      expect((yield* recallIndexStatus(f.config, false)).ready).toBe(true);
      expect(f.calls()).toBe(1);
      expect(yield* f.run.pipe(Effect.provideService(BackgroundInferenceAdmission, immediate))).toEqual({
        state: 'complete',
      });
      expect(f.calls()).toBe(1);
    }).pipe(TestClock.withLive, provideTestLayer(base)),
  );
  effectIt.effect('does no lexical preparation or inference while foreground capacity denies the first unit', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const denied = yield* Deferred.make<void>();
      const admission = BackgroundInferenceAdmission.of({
        ...immediate,
        runBatch: () =>
          Deferred.succeed(denied, undefined).pipe(
            Effect.as({state: 'deferred' as const, reason: 'foreground' as const}),
          ),
      });
      const worker = yield* f.run.pipe(
        Effect.provideService(BackgroundInferenceAdmission, admission),
        Effect.forkScoped,
      );
      yield* Deferred.await(denied);
      expect((yield* recallIndexStatus(f.config, false)).ready).toBe(false);
      expect(f.calls()).toBe(0);
      expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toBeDefined();
      yield* Fiber.interrupt(worker);
    }).pipe(provideTestLayer(base)),
  );
  effectIt.effect('reconciles repeated canonical changes during inference without exhausting the failure budget', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let changes = 0;
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | SystemInfo | Crypto.Crypto>().pipe(
        Effect.map(Context.pick(FileSystem.FileSystem, Path.Path, SystemInfo, Crypto.Crypto)),
      );
      const runtime = LocalModelRuntime.of({
        ...f.runtime,
        embedMany: request =>
          Effect.gen(function* () {
            if (changes < 12) {
              changes++;
              yield* f.fs.writeFileString(f.resource, 'Current synthetic canonical generation ' + String(changes));
              yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
              yield* requestRecallEmbeddings(f.config, changes <= 10);
            }
            return yield* f.runtime.embedMany(request);
          }).pipe(Effect.provide(context), Effect.orDie),
      });
      expect(
        yield* runRecallEmbeddingWorker(f.config).pipe(
          Effect.provideService(LocalModelStore, f.store),
          Effect.provideService(LocalModelRuntime, runtime),
          Effect.provideService(BackgroundInferenceAdmission, immediate),
        ),
      ).toEqual({state: 'complete'});
      expect(changes).toBe(12);
      expect(f.calls()).toBe(13);
      expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toBeUndefined();
      expect((yield* recallIndexStatus(f.config, false)).ready).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(base)),
  );
  effectIt.effect('keeps native authority deferrals outside the eight-failure retry budget', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const units = yield* Queue.unbounded<boolean>();
      const admission = BackgroundInferenceAdmission.of({
        ...immediate,
        runBatch: (_home, _domain, program) =>
          program.pipe(
            Effect.onExit(exit => Queue.offer(units, Exit.isFailure(exit))),
            Effect.map(value => ({state: 'completed' as const, value})),
          ),
      });
      const runtime = LocalModelRuntime.of({
        ...f.runtime,
        embedMany: () => BackgroundInferenceDeferred.make({message: 'Foreground arrived before native execution.'}),
      });
      const worker = yield* runRecallEmbeddingWorker(f.config).pipe(
        Effect.provideService(LocalModelStore, f.store),
        Effect.provideService(LocalModelRuntime, runtime),
        Effect.provideService(BackgroundInferenceAdmission, admission),
        Effect.forkScoped,
      );
      let deferrals = 0;
      while (deferrals < 12) {
        const failed = yield* Queue.take(units);
        if (failed) deferrals++;
        yield* TestClock.adjust(failed ? 2000 : 50);
      }
      expect(worker.pollUnsafe()).toBeUndefined();
      expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toBeDefined();
      yield* Fiber.interrupt(worker);
    }).pipe(provideTestLayer(base)),
  );
});
