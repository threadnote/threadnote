import {it as effectIt} from '@effect/vitest';
import {BunCrypto, BunFileSystem, BunPath} from '@effect/platform-bun';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import * as FC from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {CORE_GENERATION_MODEL_ID} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {resolveSelectedLocalModel} from '@threadnote/inference/models/inference';
import {inspectModelSelection, readModelSelection} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {
  modelSetupFileIdentity,
  modelSetupJob,
  parseModelSetup,
  readModelSetup,
  updateModelSetup,
  type ModelSetupFence,
} from '@threadnote/inference/models/setup';

const manifest: LocalModelManifest = {
  architecture: 'fixture',
  contextLimit: 32,
  file: 'fixture.gguf',
  id: CORE_GENERATION_MODEL_ID,
  license: 'Apache-2.0',
  minimumRamBytes: 1,
  quantization: 'Q4_0',
  repository: 'fixture/model',
  revision: 'a'.repeat(40),
  role: 'generation',
  runtime: {nodeLlamaCpp: '3.22.1'},
  sha256: 'b'.repeat(64),
  size: 4,
  version: 1,
};
const other = {...manifest, id: 'manual-generation'};
const missing = {...manifest, id: 'manual-missing'};
const reranker = {...manifest, id: 'manual-reranker', role: 'reranker' as const};
const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunCrypto.layer,
  Layer.succeed(SystemInfo, {
    platform: process.platform,
    processId: process.pid,
    isProcessRunning: () => true,
    environment: () => ({}),
    processStartIdentity: () => Effect.succeed('fixture-process'),
    canonicalProcessStartIdentity: () => Effect.succeed('fixture-process'),
  } as unknown as SystemInfoShape),
);
const catalogLayer = LocalModelCatalog.layer([manifest, other, missing, reranker]);

function provideTestLayer<A, E, R>(layer: Layer.Layer<A, E, R>) {
  return <B, E2, R2>(effect: Effect.Effect<B, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-setup-'});
  const home = path.join(yield* fs.realPath(temporary), 'home');
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(path.join(home, 'models'));
  const artifact = path.join(home, 'models', 'fixture.gguf');
  yield* fs.writeFileString(artifact, 'gguf');
  const selectionFile = path.join(home, 'models', 'selection.json');
  const setupFile = path.join(home, 'models', 'setup.json');
  const job = modelSetupJob(home, manifest);
  const owner = {token: 'owner-one', processId: process.pid, processStartIdentity: 'fixture-process'};
  const installed = {bytes: 4, installed: true, modelId: manifest.id, partialBytes: 0, path: artifact, verified: false};
  const store = Layer.succeed(LocalModelStore, {
    path: () => artifact,
    status: (_home, selected) =>
      Effect.succeed({...installed, installed: selected.id !== 'manual-missing', modelId: selected.id}),
    install: () => Effect.die('No download permitted'),
    verify: () => Effect.die('No foreground hash permitted'),
    remove: () => Effect.die('No removal permitted'),
  });
  const resolve = (role: 'generation' | 'reranker' | 'embedding' = 'generation', options = {}) =>
    resolveSelectedLocalModel(home, role, options).pipe(provideTestLayer(Layer.merge(store, catalogLayer)));
  const ready = Effect.gen(function* () {
    const initial = yield* updateModelSetup(home, manifest, {type: 'request', job});
    if (initial.status !== 'valid') return yield* Effect.die('Expected valid initial state');
    const fence: ModelSetupFence = {intentEpoch: initial.state.intentEpoch, job, owner};
    yield* updateModelSetup(home, manifest, {type: 'claim', ...fence});
    yield* updateModelSetup(home, manifest, {type: 'verifying', fence});
    const fileIdentity = yield* modelSetupFileIdentity(artifact);
    if (!fileIdentity) return yield* Effect.die('Expected stat identity');
    yield* updateModelSetup(home, manifest, {type: 'ready', fence, receipt: {sha256: manifest.sha256, fileIdentity}});
    return fence;
  });
  return {fs, home, artifact, selectionFile, setupFile, job, owner, resolve, ready};
});

describe('home-scoped model setup policy', () => {
  effectIt.effect('distinguishes absent, empty and malformed selection while preserving the legacy reader', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(yield* inspectModelSelection(f.home)).toEqual({status: 'missing'});
      for (const raw of [
        '{',
        '{"version":2,"roles":{}}',
        '{"version":1,"roles":[]}',
        '{"version":1,"roles":{"unknown":"model"}}',
      ]) {
        yield* f.fs.writeFileString(f.selectionFile, raw);
        expect(yield* inspectModelSelection(f.home)).toEqual({status: 'malformed'});
        expect(yield* readModelSelection(f.home)).toEqual({version: 1, roles: {}});
        expect(yield* f.fs.readFileString(f.selectionFile)).toBe(raw);
      }
      yield* f.fs.writeFileString(f.selectionFile, '{"version":1,"roles":{}}');
      expect(yield* inspectModelSelection(f.home)).toEqual({status: 'valid', selection: {version: 1, roles: {}}});
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('preserves malformed/unknown-version state on mutation and never permits fallback', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const raw of ['{', '{"version":99}', '[]', 'null']) {
        yield* f.fs.writeFileString(f.setupFile, raw);
        const inspection = yield* updateModelSetup(f.home, manifest, {type: 'policy', policy: 'automatic'});
        expect(inspection).toMatchObject({status: 'malformed', phase: 'action-required'});
        expect(yield* f.resolve()).toBeUndefined();
        expect(yield* f.fs.readFileString(f.setupFile)).toBe(raw);
      }
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect(
    'publishes a private atomic receipt and rejects a completion after disabling during verification',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const fence = yield* f.ready;
        expect((yield* f.resolve())?.manifest.id).toBe(CORE_GENERATION_MODEL_ID);
        expect(yield* f.resolve('embedding')).toBeUndefined();
        expect(yield* f.resolve('reranker')).toBeUndefined();
        if (process.platform !== 'win32') expect((yield* f.fs.stat(f.setupFile)).mode & 0o777).toBe(0o600);
        yield* updateModelSetup(f.home, manifest, {type: 'request', job: f.job, restart: true});
        const pending = yield* readModelSetup(f.home);
        if (pending.status !== 'valid') return yield* Effect.die('Expected state');
        const currentFence = {...fence, intentEpoch: pending.state.intentEpoch};
        yield* updateModelSetup(f.home, manifest, {type: 'claim', ...currentFence});
        yield* updateModelSetup(f.home, manifest, {type: 'verifying', fence: currentFence});
        const before = yield* f.fs.readFileString(f.setupFile);
        const current = parseModelSetup(before);
        if (current.status !== 'valid') return yield* Effect.die('Expected state');
        const disabled = yield* updateModelSetup(f.home, manifest, {type: 'policy', policy: 'off'});
        const receipt = {sha256: manifest.sha256, fileIdentity: (yield* modelSetupFileIdentity(f.artifact))!};
        const stale = yield* updateModelSetup(f.home, manifest, {type: 'ready', fence: currentFence, receipt});
        expect(stale.status === 'valid' && stale.state).toEqual(disabled.status === 'valid' && disabled.state);
        expect(disabled.status === 'valid' && disabled.supersededOwner).toEqual(f.owner);
        expect(disabled.status === 'valid' && disabled.state.drainingOwner).toEqual(f.owner);
        expect(stale.status === 'valid' && stale.state.intentEpoch).toBe(current.state.intentEpoch + 1);
        expect(yield* f.resolve()).toBeUndefined();
      }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('resolves manual selections and request choices without any setup receipt', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.selectionFile,
        '{"version":1,"roles":{"generation":"manual-generation","reranker":"manual-reranker"}}',
      );
      expect((yield* f.resolve())?.manifest.id).toBe(other.id);
      expect((yield* f.resolve('generation', {modelId: manifest.id}))?.manifest.id).toBe(manifest.id);
      expect((yield* f.resolve('reranker'))?.manifest.id).toBe(reranker.id);
      expect(yield* f.resolve('generation', {provider: 'remote'})).toBeUndefined();
      expect(yield* f.resolve('generation', {modelId: missing.id})).toBeUndefined();
      expect((yield* f.resolve('generation', {provider: 'local-ai'}))?.manifest.id).toBe(other.id);
      expect(yield* readModelSetup(f.home)).toEqual({status: 'missing'});
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('rejects absent or changed artifacts and stale digest/revision/home receipts without hashing', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.ready;
      const raw = yield* f.fs.readFileString(f.setupFile);
      const parsed = parseModelSetup(raw);
      if (parsed.status !== 'valid') return yield* Effect.die('Expected ready state');
      for (const patch of [
        {job: {...parsed.state.job, revision: 'c'.repeat(40)}},
        {job: {...parsed.state.job, home: `${f.home}-other`}},
        {receipt: {...parsed.state.receipt!, sha256: 'c'.repeat(64)}},
        {receipt: {...parsed.state.receipt!, fileIdentity: {...parsed.state.receipt!.fileIdentity, inode: '0'}}},
      ]) {
        yield* f.fs.writeFileString(f.setupFile, JSON.stringify({...parsed.state, ...patch}));
        expect(yield* f.resolve()).toBeUndefined();
      }
      yield* f.fs.writeFileString(f.setupFile, raw);
      yield* f.fs.writeFileString(f.artifact, 'changed artifact');
      expect(yield* f.resolve()).toBeUndefined();
      yield* f.fs.remove(f.artifact);
      expect(yield* f.resolve()).toBeUndefined();
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('keeps ready Gemma separate from changing unrelated roles and unavailable explicit generation', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.ready;
      for (const roles of [{}, {embedding: 'some-embedding'}, {reranker: reranker.id}]) {
        const raw = JSON.stringify({version: 1, roles});
        yield* f.fs.writeFileString(f.selectionFile, raw);
        expect((yield* f.resolve())?.manifest.id).toBe(manifest.id);
        expect(yield* f.fs.readFileString(f.selectionFile)).toBe(raw);
      }
      for (const generation of [missing.id, reranker.id]) {
        const raw = JSON.stringify({version: 1, roles: {generation}});
        yield* f.fs.writeFileString(f.selectionFile, raw);
        expect(yield* f.resolve()).toBeUndefined();
        expect(yield* f.fs.readFileString(f.selectionFile)).toBe(raw);
      }
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('invalidates a same-length rewrite even when its original modification time is restored', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      // Use an exactly representable whole-second mtime before capturing the verified receipt.
      const originalTime = 1_577_836_800;
      yield* f.fs.utimes(f.artifact, originalTime, originalTime);
      yield* f.ready;
      const before = yield* modelSetupFileIdentity(f.artifact);
      yield* f.fs.writeFileString(f.artifact, 'evil');
      yield* f.fs.utimes(f.artifact, originalTime, originalTime);
      const after = yield* modelSetupFileIdentity(f.artifact);
      expect(after?.size).toBe(before?.size);
      expect(after?.inode).toBe(before?.inode);
      expect(after?.modifiedAtNs).toBe(before?.modifiedAtNs);
      expect(after?.changedAtNs).not.toBe(before?.changedAtNs);
      expect(yield* f.resolve()).toBeUndefined();
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('never initializes state or recreates an absent home from a stale worker completion', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fence = {intentEpoch: 0, job: f.job, owner: f.owner};
      const receipt = {sha256: manifest.sha256, fileIdentity: (yield* modelSetupFileIdentity(f.artifact))!};
      expect(yield* updateModelSetup(f.home, manifest, {type: 'ready', fence, receipt})).toEqual({status: 'missing'});
      expect(yield* f.fs.exists(f.setupFile)).toBe(false);
      yield* f.fs.remove(f.home, {recursive: true});
      expect(yield* updateModelSetup(f.home, manifest, {type: 'ready', fence, receipt})).toEqual({status: 'missing'});
      expect(yield* f.fs.exists(f.home)).toBe(false);
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('does not recreate a home erased between the worker precheck and state-lock acquisition', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* updateModelSetup(f.home, manifest, {type: 'request', job: f.job});
      const fs = {
        ...f.fs,
        realPath: (target: string) =>
          f.fs.realPath(target).pipe(Effect.tap(() => f.fs.remove(f.home, {recursive: true}))),
      };
      yield* updateModelSetup(f.home, manifest, {type: 'claim', intentEpoch: 0, job: f.job, owner: f.owner}).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.result,
      );
      expect(yield* f.fs.exists(f.home)).toBe(false);
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('serializes concurrent short state mutations without losing intent epochs', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* updateModelSetup(f.home, manifest, {type: 'request', job: f.job});
      yield* Effect.forEach(
        Array.from({length: 8}),
        () => updateModelSetup(f.home, manifest, {type: 'request', job: f.job, restart: true}),
        {concurrency: 'unbounded'},
      ).pipe(TestClock.withLive);
      const inspection = yield* readModelSetup(f.home);
      expect(inspection.status === 'valid' && inspection.state.intentEpoch).toBe(8);
      if (process.platform !== 'win32') expect((yield* f.fs.stat(`${f.home}/models`)).mode & 0o777).toBe(0o700);
      expect(yield* f.fs.readDirectory(`${f.home}/models`)).toEqual(expect.not.arrayContaining(['setup.lock']));
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect(
    'environment force-off suspends automatic readiness without changing explicit choices or durable policy',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.ready;
        const system = yield* SystemInfo;
        const envOff = Layer.succeed(SystemInfo, {...system, environment: () => ({THREADNOTE_MODEL_SETUP: 'off'})});
        const before = yield* f.fs.readFileString(f.setupFile);
        expect(yield* f.resolve().pipe(provideTestLayer(envOff))).toBeUndefined();
        expect((yield* f.resolve('generation', {modelId: other.id}).pipe(provideTestLayer(envOff)))?.manifest.id).toBe(
          other.id,
        );
        expect(yield* f.fs.readFileString(f.setupFile)).toBe(before);
      }).pipe(provideTestLayer(platform)),
  );

  fcEffectProp(
    effectIt,
    'automatic readiness preserves every explicit choice and unrelated role byte for byte',
    {
      choice: FC.constantFrom('missing', 'unset', 'manual', 'unknown', 'malformed'),
      policyOff: FC.boolean(),
      environmentOff: FC.boolean(),
      unrelated: FC.constantFrom({}, {embedding: 'an-embedding'}, {reranker: 'manual-reranker'}),
    },
    ({choice, policyOff, environmentOff, unrelated}) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const raw =
          choice === 'missing'
            ? undefined
            : choice === 'malformed'
              ? '{bad'
              : JSON.stringify({
                  version: 1,
                  roles: {
                    ...unrelated,
                    ...(choice === 'manual'
                      ? {generation: other.id}
                      : choice === 'unknown'
                        ? {generation: 'unknown-explicit'}
                        : {}),
                  },
                });
        if (raw !== undefined) yield* f.fs.writeFileString(f.selectionFile, raw);
        yield* f.ready;
        if (policyOff) yield* updateModelSetup(f.home, manifest, {type: 'policy', policy: 'off'});
        const result = yield* f.resolve('generation', {automaticSetup: !environmentOff}).pipe(Effect.result);
        if (choice === 'unknown') expect(result._tag).toBe('Failure');
        else if (result._tag === 'Success') {
          const expected =
            choice === 'manual'
              ? other.id
              : choice === 'malformed' || policyOff || environmentOff
                ? undefined
                : manifest.id;
          expect(result.success?.manifest.id).toBe(expected);
        } else expect.fail('Unexpected resolver failure');
        expect(yield* f.fs.exists(f.selectionFile)).toBe(raw !== undefined);
        if (raw !== undefined) expect(yield* f.fs.readFileString(f.selectionFile)).toBe(raw);
      }).pipe(provideTestLayer(platform)),
    {fastCheck: {numRuns: 40}},
  );
});
