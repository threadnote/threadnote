import {SecureRandom} from 'effect/crypto';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, PlatformError} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {BackgroundInferenceAdmission, BackgroundInferenceDeferred} from '@threadnote/inference/background/admission';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {EmbeddingFailed} from '@threadnote/inference/engine/errors';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {
  readRecallEmbeddingDemand,
  recallEmbeddingDemandKey,
  requestRecallEmbeddings,
} from '@threadnote/recall/background/demand';
import {loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import {vectorIndexGenerationReadiness} from '@threadnote/recall/vector-index';
import {scheduleMcpRecallBackgroundRefresh} from '@threadnote/recall/mcp/refresh';
import {SystemInfo} from '@threadnote/platform/system';
import {
  makeRecallEmbeddingWorker,
  RecallEmbeddingWorkerControlUnavailable,
  runRecallEmbeddingWorker,
} from '../../src/recall/embedding_worker.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const manifest = {...BUILTIN_MODEL_MANIFESTS[0], role: 'embedding' as const, dimensions: 2};
const switchedManifest = {
  ...manifest,
  id: 'bge-small-en-v1.5-q8-switch-test',
  sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
};
const base = Layer.mergeAll(
  BunServices.layer,
  TestSystemInfoLayer,
  LocalModelCatalog.layer([manifest, switchedManifest]),
);
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
  effectIt.effect('does not clear a same-token event arriving after the final source fence but before completion', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const initial = (yield* readRecallEmbeddingDemand(f.config))!.desired!;
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | SystemInfo | SecureRandom.SecureRandom
      >().pipe(Effect.map(Context.pick(FileSystem.FileSystem, Path.Path, SystemInfo, SecureRandom.SecureRandom)));
      let raced = false;
      const admission = BackgroundInferenceAdmission.of({
        ...immediate,
        runBatch: (_home, _domain, program) =>
          program.pipe(
            Effect.tap(value =>
              Effect.gen(function* () {
                if (
                  raced ||
                  typeof value !== 'object' ||
                  value === null ||
                  !('state' in value) ||
                  value.state !== 'current'
                )
                  return;
                raced = true;
                yield* f.fs.writeFileString(
                  f.resource,
                  'New canonical body arriving after the completed source fence.',
                );
                yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
                expect(yield* requestRecallEmbeddings(f.config, true)).toBe(initial.token);
                expect((yield* readRecallEmbeddingDemand(f.config))!.desired!.revision).not.toBe(initial.revision);
              }).pipe(Effect.provide(context), Effect.orDie),
            ),
            Effect.map(value => ({state: 'completed' as const, value})),
          ),
      });
      expect(yield* f.run.pipe(Effect.provideService(BackgroundInferenceAdmission, admission))).toEqual({
        state: 'complete',
      });
      expect(raced).toBe(true);
      expect(f.calls()).toBe(2);
      expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toBeUndefined();
      const lexical = yield* loadRecallIndexData(f.config, {includeInactive: false});
      expect(lexical.candidates[0]?.text).toContain('New canonical body arriving after the completed source fence.');
      expect(yield* vectorIndexGenerationReadiness(f.config.agentContextHome, manifest, lexical.generation)).toBe(
        'current',
      );
    }).pipe(TestClock.withLive, provideTestLayer(base)),
  );
  effectIt.effect(
    'preserves a coalesced model switch after the old model final fence with the same lexical generation',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const initial = (yield* readRecallEmbeddingDemand(f.config))!.desired!;
        const catalog = yield* LocalModelCatalog;
        const context = yield* Effect.context<
          FileSystem.FileSystem | Path.Path | SystemInfo | SecureRandom.SecureRandom
        >().pipe(Effect.map(Context.pick(FileSystem.FileSystem, Path.Path, SystemInfo, SecureRandom.SecureRandom)));
        let switched = false;
        const admission = BackgroundInferenceAdmission.of({
          ...immediate,
          runBatch: (_home, _domain, program) =>
            program.pipe(
              Effect.tap(value =>
                Effect.gen(function* () {
                  if (
                    switched ||
                    typeof value !== 'object' ||
                    value === null ||
                    !('state' in value) ||
                    value.state !== 'current'
                  )
                    return;
                  switched = true;
                  const before = yield* recallIndexStatus(f.config, false);
                  yield* selectLocalModel(f.config.agentContextHome, catalog, 'embedding', switchedManifest.id);
                  yield* scheduleMcpRecallBackgroundRefresh(f.config, switchedManifest);
                  expect((yield* recallIndexStatus(f.config, false)).generation).toBe(before.generation);
                  const demand = (yield* readRecallEmbeddingDemand(f.config))!.desired!;
                  expect(demand.token).toBe(initial.token);
                  expect(demand.revision).not.toBe(initial.revision);
                }).pipe(Effect.provide(context), Effect.orDie),
              ),
              Effect.map(value => ({state: 'completed' as const, value})),
            ),
        });
        expect(yield* f.run.pipe(Effect.provideService(BackgroundInferenceAdmission, admission))).toEqual({
          state: 'complete',
        });
        expect(switched).toBe(true);
        expect(f.calls()).toBe(2);
        const lexical = yield* recallIndexStatus(f.config, false);
        expect(
          yield* vectorIndexGenerationReadiness(f.config.agentContextHome, switchedManifest, lexical.generation!),
        ).toBe('current');
        expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toBeUndefined();
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
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | SystemInfo | SecureRandom.SecureRandom
      >().pipe(Effect.map(Context.pick(FileSystem.FileSystem, Path.Path, SystemInfo, SecureRandom.SecureRandom)));
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
      const runtime = LocalModelRuntime.of({
        ...f.runtime,
        embedMany: () => BackgroundInferenceDeferred.make({message: 'Foreground arrived before native execution.'}),
      });
      const unit = yield* makeRecallEmbeddingWorker().pipe(
        Effect.provideService(LocalModelStore, f.store),
        Effect.provideService(LocalModelRuntime, runtime),
        Effect.provideService(BackgroundInferenceAdmission, immediate),
      );
      let deferrals = 0;
      while (deferrals < 12) {
        const result = yield* unit(f.config);
        expect(result.state).not.toBe('blocked');
        if (result.reason === 'native-authority-deferred') deferrals++;
      }
      const demand = yield* readRecallEmbeddingDemand(f.config);
      expect(demand?.desired).toBeDefined();
      expect(demand?.observation).toMatchObject({state: 'deferred-foreground', failures: 0});
    }).pipe(provideTestLayer(base)),
  );

  effectIt.effect('stops after a failed inference when retry metadata cannot be persisted', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = yield* Path.Path;
      const statePath = path.join(
        f.config.agentContextHome,
        'recall',
        'embedding-demand-v1',
        recallEmbeddingDemandKey(f.config) + '.json',
      );
      let refused = 0;
      const fs = {
        ...f.fs,
        rename: (from: string, to: string) =>
          Effect.gen(function* () {
            if (to === statePath) {
              const state = JSON.parse(yield* f.fs.readFileString(from));
              if (state.observation?.failures > 0) {
                refused++;
                return yield* PlatformError.systemError({_tag: 'Busy', module: 'FileSystem', method: 'rename'});
              }
            }
            return yield* f.fs.rename(from, to);
          }),
      };
      const runtime = LocalModelRuntime.of({
        ...f.runtime,
        embedMany: request =>
          f.runtime
            .embedMany(request)
            .pipe(
              Effect.andThen(
                EmbeddingFailed.make({modelId: manifest.id, message: 'Synthetic inference failure.', cause: undefined}),
              ),
            ),
      });
      const result = yield* runRecallEmbeddingWorker(f.config).pipe(
        Effect.provideService(LocalModelStore, f.store),
        Effect.provideService(LocalModelRuntime, runtime),
        Effect.provideService(BackgroundInferenceAdmission, immediate),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.result,
      );
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') expect(result.failure).toBeInstanceOf(RecallEmbeddingWorkerControlUnavailable);
      expect(refused).toBe(1);
      expect(f.calls()).toBe(1);
      expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toBeDefined();
      expect((yield* readRecallEmbeddingDemand(f.config))?.observation?.failures).toBe(0);
    }).pipe(TestClock.withLive, provideTestLayer(base)),
  );
});
