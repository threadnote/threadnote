import {it as effectIt} from '@effect/vitest';
import {BunCrypto, BunFileSystem, BunPath} from '@effect/platform-bun';
import {Clock, Context, Crypto, Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {CommandExecutor} from '@threadnote/platform/command';
import {sha256Hex} from '@threadnote/platform/digest';
import {HttpService, HttpRequestFailed} from '@threadnote/platform/http';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {CORE_GENERATION_MODEL_ID} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {FileLockTimeout} from '@threadnote/platform/file/lock';
import {LocalModelStore, ModelStoreIoFailed} from '@threadnote/inference/models/store';
import {ModelSetupConflict, modelSetupJob, readModelSetup, updateModelSetup} from '@threadnote/inference/models/setup';
import {
  modelSetupWorkerEnvironment,
  requestModelSetup,
  readModelSetupStatus,
  runModelSetupWorker,
  stopModelSetup,
  parseModelSetupWorkerArguments,
  modelSetupRetryDelay,
  setModelSetupPolicy,
} from '../../src/models/setup.js';

const bytes = new TextEncoder().encode('independent tiny model fixture');
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer);
function provideTestLayer<A, E, R>(layer: Layer.Layer<A, E, R>) {
  return <B, E2, R2>(effect: Effect.Effect<B, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}

interface FixtureOptions {
  readonly failFirst?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly lockTimeoutFirst?: boolean;
  readonly rewriteAfterInstall?: boolean;
  readonly rewriteDuringHash?: boolean;
  readonly corrupt?: boolean;
  readonly short?: boolean;
  readonly memory?: number;
  readonly disk?: number | null;
  readonly beforeStage?: (stage: string) => Effect.Effect<void>;
  readonly transferBarrier?: Deferred.Deferred<void>;
  readonly transferStarted?: Deferred.Deferred<void>;
}
const fixture = (options: FixtureOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-worker-'});
    const root = yield* fs.realPath(temporary);
    const home = path.join(root, 'home');
    yield* fs.makeDirectory(home);
    const manifest: LocalModelManifest = {
      architecture: 'fixture',
      contextLimit: 64,
      file: 'fixture.gguf',
      id: CORE_GENERATION_MODEL_ID,
      license: 'Apache-2.0',
      minimumRamBytes: 8,
      quantization: 'Q4_0',
      repository: 'fixture/model',
      revision: 'a'.repeat(40),
      role: 'generation',
      runtime: {nodeLlamaCpp: '3.22.1'},
      sha256: yield* sha256Hex(bytes),
      size: bytes.length,
      version: 1,
    };
    const launches: Array<readonly string[]> = [];
    const launchEnvironments: Array<NodeJS.ProcessEnv | undefined> = [];
    const offsets: number[] = [];
    const signals: number[] = [];
    const alive = new Map<number, string>([[process.pid, 'parent']]);
    const workers = new Map<number, Fiber.Fiber<void, unknown>>();
    const workerPid = process.pid + 10_000;
    const system = {
      processId: process.pid,
      platform: process.platform,
      architecture: process.arch,
      executablePath: '/fixture/threadnote',
      homeDirectory: root,
      environment: () => options.environment ?? {},
      availableDiskBytes: () => Effect.succeed(options.disk === null ? undefined : (options.disk ?? 1_000_000)),
      hardwareInfo: Effect.succeed({effectiveMemoryBytes: options.memory ?? 1_000_000}),
      canonicalProcessStartIdentity: (pid: number) => Effect.succeed(alive.get(pid)),
      processStartIdentity: (pid: number) => Effect.succeed(alive.get(pid)),
      isProcessRunning: (pid: number) => alive.has(pid),
      signalProcess: (pid: number) => {
        signals.push(pid);
        workers.get(pid)?.interruptUnsafe();
      },
    } as unknown as SystemInfoShape;
    const http = HttpService.of({
      downloadToFile: (_url, target, download) =>
        Effect.gen(function* () {
          offsets.push(download?.offset ?? 0);
          if (options.transferStarted) yield* Deferred.succeed(options.transferStarted, undefined);
          if (options.transferBarrier) yield* Deferred.await(options.transferBarrier);
          if (options.failFirst && offsets.length === 1) {
            yield* fs.writeFile(target, bytes.slice(0, 5));
            return yield* HttpRequestFailed.make({
              cause: 'offline fixture',
              message: 'https://private.example/token secret',
              method: 'GET',
              url: 'https://private.example/token',
            });
          }
          const body = options.corrupt
            ? new Uint8Array(bytes.length)
            : options.short
              ? bytes.slice(0, 5)
              : bytes.slice(download?.offset ?? 0);
          yield* fs.writeFile(target, body, {flag: (download?.offset ?? 0) > 0 ? 'a' : 'w'});
          return {resumed: (download?.offset ?? 0) > 0, status: (download?.offset ?? 0) > 0 ? 206 : 200};
        }).pipe(
          Effect.mapError(cause =>
            HttpRequestFailed.make({
              cause,
              message: 'Fixture HTTP boundary failed',
              method: 'GET',
              url: 'https://fixture.invalid',
            }),
          ),
        ),
      getJson: () => Effect.die('No JSON requests'),
      getStatus: () => Effect.die('No status requests'),
      getText: () => Effect.die('No text requests'),
    });
    const crypto = yield* Crypto.Crypto;
    let rewritten = false;
    const storeFileSystem = options.rewriteDuringHash
      ? {
          ...fs,
          stream: (target: string, streamOptions?: Parameters<FileSystem.FileSystem['stream']>[1]) =>
            fs.stream(target, streamOptions).pipe(
              Stream.tap(() => {
                if (rewritten) return Effect.void;
                rewritten = true;
                return fs.writeFile(target, new Uint8Array(bytes.length));
              }),
            ),
        }
      : fs;
    const context = Context.make(SystemInfo, system).pipe(
      Context.add(FileSystem.FileSystem, storeFileSystem),
      Context.add(Path.Path, path),
      Context.add(Crypto.Crypto, crypto),
      Context.add(HttpService, http),
    );
    const catalogContext = yield* Layer.build(LocalModelCatalog.layer([manifest])).pipe(Effect.provide(context));
    const catalog = Context.get(catalogContext, LocalModelCatalog);
    const storeContext = yield* Layer.build(LocalModelStore.layer).pipe(Effect.provide(context));
    const innerStore = Context.get(storeContext, LocalModelStore);
    let installAttempts = 0;
    const store = LocalModelStore.of({
      ...innerStore,
      install: (selectedHome, selectedManifest, installOptions) =>
        Effect.gen(function* () {
          installAttempts += 1;
          if (options.lockTimeoutFirst && installAttempts === 1)
            return yield* ModelStoreIoFailed.make({
              cause: FileLockTimeout.of('/private/fixture/model.lock'),
              message: 'Model lock timeout',
              modelId: manifest.id,
              operation: 'install',
            });
          const result = yield* innerStore.install(selectedHome, selectedManifest, {
            ...installOptions,
            onStage: (stage, count) =>
              Effect.gen(function* () {
                if (options.beforeStage) yield* options.beforeStage(stage);
                yield* installOptions?.onStage?.(stage, count) ?? Effect.void;
              }),
          });
          if (options.rewriteAfterInstall)
            yield* fs.writeFile(result.path, new Uint8Array(bytes.length)).pipe(Effect.orDie);
          return result;
        }),
    });
    const commands = CommandExecutor.of({
      execute: () => Effect.die('No command execution'),
      executeStreaming: () => Effect.die('No streaming commands'),
      spawnDetached: (_exe, arguments_, spawnOptions) =>
        Effect.sync(() => {
          launches.push(arguments_);
          launchEnvironments.push(spawnOptions?.env);
          return true;
        }),
    });
    const services = Context.add(
      Context.add(Context.add(context, LocalModelCatalog, catalog), LocalModelStore, store),
      CommandExecutor,
      commands,
    );
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(services));
    const worker = (index = launches.length - 1) =>
      Effect.gen(function* () {
        const args = parseModelSetupWorkerArguments(launches[index].slice(1));
        if (!args) return yield* Effect.die('Invalid worker invocation');
        alive.set(workerPid, 'worker');
        yield* runModelSetupWorker(args.home, args.intentEpoch, args.nonce).pipe(
          Effect.provideService(SystemInfo, {...system, processId: workerPid}),
          Effect.ensuring(
            Effect.sync(() => {
              alive.delete(workerPid);
            }),
          ),
        );
      }).pipe(provide);
    const startWorker = Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(worker());
      workers.set(workerPid, fiber);
      return fiber;
    });
    return {
      fs,
      path,
      home,
      root,
      manifest,
      launches,
      launchEnvironments,
      offsets,
      signals,
      alive,
      workerPid,
      provide,
      worker,
      startWorker,
      store,
      installedPath: store.path(home, manifest),
      system,
    };
  });

describe('background model setup worker', () => {
  effectIt.effect('simultaneous unguarded triggers return one job without exposing internal conflicts', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const allEntered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let entered = 0;
      const system = {
        ...f.system,
        hardwareInfo: Effect.gen(function* () {
          entered += 1;
          if (entered === 4) yield* Deferred.succeed(allEntered, undefined);
          yield* Deferred.await(release);
          return yield* f.system.hardwareInfo;
        }),
      };
      const requests = yield* Effect.forEach(
        [1, 2, 3, 4],
        () => requestModelSetup(f.home).pipe(Effect.provideService(SystemInfo, system), f.provide, Effect.result),
        {concurrency: 'unbounded'},
      ).pipe(TestClock.withLive, Effect.forkScoped);
      yield* Deferred.await(allEntered);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Fiber.join(requests);
      expect(results.every(result => result._tag === 'Success')).toBe(true);
      expect(f.launches).toHaveLength(1);
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect(
    'an explicit action superseded during eligibility reports conflict without reserving or spawning',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const system = {
          ...f.system,
          hardwareInfo: Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* f.system.hardwareInfo;
          }),
        };
        const request = yield* requestModelSetup(f.home, {expectedEpoch: 0}).pipe(
          Effect.provideService(SystemInfo, system),
          f.provide,
          Effect.result,
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        yield* stopModelSetup(f.home).pipe(f.provide);
        const file = f.path.join(f.home, 'models', 'setup.json');
        const before = yield* f.fs.readFileString(file);
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(request);
        expect(result._tag === 'Failure' && Schema.is(ModelSetupConflict)(result.failure)).toBe(true);
        expect(yield* f.fs.readFileString(file)).toBe(before);
        expect(f.launches).toEqual([]);
        expect(f.signals).toEqual([]);
        expect(f.offsets).toEqual([]);
      }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('stale public actions cannot stop, drain, reserve or spawn even when policy already matches', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const initial = yield* readModelSetupStatus(f.home).pipe(f.provide);
      expect(initial.intentEpoch).toBe(0);
      const accepted = yield* requestModelSetup(f.home, {expectedEpoch: 0}).pipe(f.provide);
      expect(accepted.intentEpoch).toBeGreaterThan(0);
      const current = yield* readModelSetup(f.home).pipe(f.provide);
      if (current.status !== 'valid') return yield* Effect.die('Expected reserved state');
      yield* updateModelSetup(f.home, f.manifest, {
        type: 'claim',
        intentEpoch: current.state.intentEpoch,
        job: current.state.job,
        owner: {token: 'current-owner', processId: process.pid, processStartIdentity: 'parent'},
        nonce: current.state.reservation?.nonce,
        now: yield* Clock.currentTimeMillis,
      }).pipe(f.provide);
      const stateFile = f.path.join(f.home, 'models', 'setup.json');
      const before = yield* f.fs.readFileString(stateFile);
      for (const action of [
        requestModelSetup(f.home, {retry: true, expectedEpoch: 0}),
        setModelSetupPolicy(f.home, false, {expectedEpoch: 0}),
        setModelSetupPolicy(f.home, true, {expectedEpoch: 0}),
      ]) {
        const result = yield* action.pipe(f.provide, Effect.result);
        expect(result._tag === 'Failure' && Schema.is(ModelSetupConflict)(result.failure)).toBe(true);
        expect(yield* f.fs.readFileString(stateFile)).toBe(before);
      }
      expect(f.launches).toHaveLength(1);
      expect(f.signals).toEqual([]);
      expect(f.offsets).toEqual([]);
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect(
    'suppresses duplicate canonical-home/symlink triggers, isolates homes, and keeps requests responsive',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const alias = f.path.join(f.root, 'alias');
        yield* f.fs.symlink(f.home, alias);
        yield* Effect.forEach([f.home, alias, f.home, alias], home => requestModelSetup(home).pipe(f.provide), {
          concurrency: 'unbounded',
        }).pipe(TestClock.withLive);
        expect(f.launches).toHaveLength(1);
        expect(f.offsets).toHaveLength(0);
        expect((yield* readModelSetupStatus(alias).pipe(f.provide)).phase).toBe('pending');
        const other = f.path.join(f.root, 'other');
        yield* requestModelSetup(other).pipe(f.provide);
        expect(f.launches).toHaveLength(2);
        expect(f.launches[0][2]).not.toBe(f.launches[1][2]);
      }).pipe(provideTestLayer(platform)),
  );

  it('F001 excludes arbitrary unrelated environment keys without mutating its input', () => {
    FC.assert(
      FC.property(FC.dictionary(FC.string({minLength: 1, maxLength: 20}), FC.string({maxLength: 40})), extras => {
        const environment = {
          ...Object.fromEntries(Object.entries(extras).map(([key, value]) => [`UNRELATED_${key}`, value])),
          PATH: '/bin',
          THREADNOTE_HOME: '/old',
        };
        const before = {...environment};
        expect(modelSetupWorkerEnvironment(environment, '/new')).toEqual({PATH: '/bin', THREADNOTE_HOME: '/new'});
        expect(environment).toEqual(before);
      }),
      {numRuns: 100},
    );
  });

  effectIt.effect('F001 excludes unrelated provider credentials while retaining OS proxy and TLS settings', () =>
    Effect.gen(function* () {
      const environment = {
        OPENAI_API_KEY: 'dummy-openai',
        ANTHROPIC_API_KEY: 'dummy-anthropic',
        UNRELATED_SECRET: 'dummy',
        PATH: '/fixture/bin',
        SystemRoot: 'C:/Windows',
        TEMP: '/fixture/tmp',
        HOME: '/fixture/user',
        HTTPS_PROXY: 'http://fixture.proxy',
        NODE_EXTRA_CA_CERTS: '/fixture/ca.pem',
        THREADNOTE_INSTALL_ROOT: '/fixture/install',
      };
      const before = {...environment};
      const f = yield* fixture({environment});
      yield* requestModelSetup(f.home).pipe(f.provide);
      expect(f.launchEnvironments[0]).toEqual({
        PATH: environment.PATH,
        SystemRoot: environment.SystemRoot,
        TEMP: environment.TEMP,
        HOME: environment.HOME,
        HTTPS_PROXY: environment.HTTPS_PROXY,
        NODE_EXTRA_CA_CERTS: environment.NODE_EXTRA_CA_CERTS,
        THREADNOTE_INSTALL_ROOT: environment.THREADNOTE_INSTALL_ROOT,
        THREADNOTE_HOME: f.home,
      });
      expect(environment).toEqual(before);
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect(
    'F003 treats a store-wrapped model lock timeout as retryable and later adopts manual bytes without HTTP',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({lockTimeoutFirst: true});
        yield* requestModelSetup(f.home).pipe(f.provide);
        yield* f.worker();
        const waiting = yield* readModelSetupStatus(f.home).pipe(f.provide);
        expect(waiting).toMatchObject({phase: 'retry-wait', reason: 'model-busy', attempts: 1});
        yield* f.fs.makeDirectory(f.path.dirname(f.installedPath), {recursive: true});
        yield* f.fs.writeFile(f.installedPath, bytes);
        yield* TestClock.adjust(66_001);
        yield* requestModelSetup(f.home).pipe(f.provide);
        yield* f.worker();
        expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).artifactReady).toBe(true);
        expect(f.offsets).toEqual([]);
      }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('F004 never blesses a same-length rewrite after verified store install returns', () =>
    Effect.gen(function* () {
      const f = yield* fixture({rewriteAfterInstall: true});
      yield* requestModelSetup(f.home).pipe(f.provide);
      yield* f.worker();
      expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).artifactReady).toBe(false);
      const state = yield* readModelSetup(f.home).pipe(f.provide);
      expect(state.status === 'valid' && state.state.phase).not.toBe('ready');
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('F004 rejects a file changed while its original bytes are being hashed', () =>
    Effect.gen(function* () {
      const f = yield* fixture({rewriteDuringHash: true});
      yield* f.fs.makeDirectory(f.path.dirname(f.installedPath), {recursive: true});
      yield* f.fs.writeFile(f.installedPath, bytes);
      yield* requestModelSetup(f.home).pipe(f.provide);
      yield* f.worker();
      expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).artifactReady).toBe(false);
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('adopts installed good bytes without HTTP and preserves explicit selection', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.makeDirectory(f.path.dirname(f.installedPath), {recursive: true});
      yield* f.fs.writeFile(f.installedPath, bytes);
      const selection = '{"version":1,"roles":{"generation":"different-explicit-model"}}';
      yield* f.fs.writeFileString(f.path.join(f.home, 'models', 'selection.json'), selection);
      yield* requestModelSetup(f.home).pipe(f.provide);
      yield* f.worker();
      const status = yield* readModelSetupStatus(f.home).pipe(f.provide);
      expect(status).toMatchObject({phase: 'ready', artifactReady: true, effectiveDefault: false});
      expect(f.offsets).toEqual([]);
      expect(yield* f.fs.readFileString(f.path.join(f.home, 'models', 'selection.json'))).toBe(selection);
      yield* requestModelSetup(f.home).pipe(f.provide);
      expect(f.launches).toHaveLength(1);
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('persists bounded retry, resumes partial bytes and verifies one final artifact', () =>
    Effect.gen(function* () {
      const f = yield* fixture({failFirst: true});
      yield* requestModelSetup(f.home).pipe(f.provide);
      yield* f.worker();
      const failed = yield* readModelSetupStatus(f.home).pipe(f.provide);
      expect(failed).toMatchObject({phase: 'retry-wait', reason: 'download-failed', attempts: 1, artifactReady: false});
      expect(JSON.stringify(failed)).not.toMatch(/private|secret|token|https|home/);
      yield* requestModelSetup(f.home).pipe(f.provide);
      expect(f.launches).toHaveLength(1);
      yield* requestModelSetup(f.home, {retry: true}).pipe(f.provide);
      yield* f.worker();
      expect(f.offsets).toEqual([0, 5]);
      expect(Array.from(yield* f.fs.readFile(f.installedPath))).toEqual(Array.from(bytes));
      expect(yield* readModelSetupStatus(f.home).pipe(f.provide)).toMatchObject({
        phase: 'ready',
        attempts: 2,
        artifactReady: true,
      });
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect(
    'rejects wrong checksum and length, keeps native inference absent and resource failures actionable',
    () =>
      Effect.gen(function* () {
        for (const options of [{corrupt: true}, {short: true}, {memory: 1}, {disk: 0}, {disk: null}]) {
          const f = yield* fixture(options);
          yield* requestModelSetup(f.home).pipe(f.provide);
          if (f.launches.length) yield* f.worker();
          const status = yield* readModelSetupStatus(f.home).pipe(f.provide);
          expect(status.artifactReady).toBe(false);
          expect(status.phase).toBe(options.short ? 'retry-wait' : 'action-required');
          expect(status.reason).toBe(
            options.corrupt
              ? 'checksum-mismatch'
              : options.short
                ? 'download-failed'
                : options.memory
                  ? 'insufficient-memory'
                  : options.disk === null
                    ? 'unknown-disk'
                    : 'insufficient-disk',
          );
          expect(yield* f.fs.exists(f.installedPath)).toBe(false);
        }
      }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('an active manual install and background request share one transfer and verified publication', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const barrier = yield* Deferred.make<void>();
      const f = yield* fixture({transferStarted: entered, transferBarrier: barrier});
      const manual = yield* Effect.forkScoped(f.store.install(f.home, f.manifest));
      yield* Deferred.await(entered);
      yield* requestModelSetup(f.home).pipe(f.provide);
      const background = yield* Effect.forkScoped(f.worker());
      yield* Deferred.succeed(barrier, undefined);
      yield* Fiber.join(manual);
      yield* TestClock.adjust(1000);
      yield* Fiber.join(background);
      expect(f.offsets).toEqual([0]);
      expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).artifactReady).toBe(true);
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect(
    'retains the displaced identity when stopping fails so a second stop cannot erase a running worker',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* requestModelSetup(f.home).pipe(f.provide);
        const pending = yield* readModelSetup(f.home).pipe(f.provide);
        if (pending.status !== 'valid') return yield* Effect.die('Expected pending state');
        const owner = {token: pending.state.reservation!.nonce, processId: f.workerPid, processStartIdentity: 'worker'};
        f.alive.set(f.workerPid, 'worker');
        yield* updateModelSetup(f.home, f.manifest, {
          type: 'claim',
          intentEpoch: pending.state.intentEpoch,
          job: pending.state.job,
          owner,
          nonce: owner.token,
          now: yield* Clock.currentTimeMillis,
        }).pipe(f.provide);
        const result = yield* stopModelSetup(f.home).pipe(
          Effect.provideService(SystemInfo, {
            ...f.system,
            signalProcess: () => {
              throw new Error('Private fixture signal error');
            },
          }),
          f.provide,
          Effect.result,
        );
        expect(result._tag).toBe('Failure');
        const blocked = yield* readModelSetup(f.home).pipe(f.provide);
        expect(blocked.status === 'valid' && blocked.state.drainingOwner).toEqual(owner);
        f.alive.delete(f.workerPid);
        yield* stopModelSetup(f.home).pipe(f.provide);
        const drained = yield* readModelSetup(f.home).pipe(f.provide);
        expect(drained.status === 'valid' && drained.state.drainingOwner).toBeUndefined();
      }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect('a later request recovers a crashed claimed owner and publishes only the new epoch', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* requestModelSetup(f.home).pipe(f.provide);
      const pending = yield* readModelSetup(f.home).pipe(f.provide);
      if (pending.status !== 'valid') return yield* Effect.die('Expected pending state');
      const owner = {
        token: pending.state.reservation!.nonce,
        processId: f.workerPid,
        processStartIdentity: 'dead-worker',
      };
      yield* updateModelSetup(f.home, f.manifest, {
        type: 'claim',
        intentEpoch: pending.state.intentEpoch,
        job: pending.state.job,
        owner,
        nonce: owner.token,
        now: yield* Clock.currentTimeMillis,
      }).pipe(f.provide);
      yield* requestModelSetup(f.home).pipe(f.provide);
      expect(f.launches).toHaveLength(2);
      yield* f.worker(0);
      expect(f.offsets).toHaveLength(0);
      yield* f.worker(1);
      expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).artifactReady).toBe(true);
      expect(f.offsets).toEqual([0]);
    }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect(
    'off cancels a blocked transfer, drains its exact process and prevents queued children from recreating erased home',
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const barrier = yield* Deferred.make<void>();
        const f = yield* fixture({transferStarted: entered, transferBarrier: barrier});
        yield* requestModelSetup(f.home).pipe(f.provide);
        const fiber = yield* f.startWorker;
        yield* Deferred.await(entered);
        expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).phase).toBe('downloading');
        yield* stopModelSetup(f.home).pipe(f.provide, TestClock.withLive);
        yield* Fiber.await(fiber);
        expect(f.signals).toEqual([f.workerPid]);
        expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).phase).toBe('off');
        yield* f.fs.remove(f.home, {recursive: true});
        yield* f.worker();
        expect(yield* f.fs.exists(f.home)).toBe(false);
        expect(f.offsets).toHaveLength(1);
      }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect(
    'off during verification/publication cannot publish readiness or resurrect an explicitly removed artifact',
    () =>
      Effect.gen(function* () {
        for (const blockedStage of ['verifying', 'publishing']) {
          const entered = yield* Deferred.make<void>();
          const barrier = yield* Deferred.make<void>();
          const f = yield* fixture({
            beforeStage: stage =>
              stage === blockedStage
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(barrier)))
                : Effect.void,
          });
          yield* requestModelSetup(f.home).pipe(f.provide);
          const fiber = yield* f.startWorker;
          yield* Deferred.await(entered);
          yield* stopModelSetup(f.home).pipe(f.provide, TestClock.withLive);
          yield* Fiber.await(fiber);
          yield* f.store.remove(f.home, f.manifest);
          expect(yield* f.fs.exists(f.installedPath)).toBe(false);
          expect(yield* readModelSetupStatus(f.home).pipe(f.provide)).toMatchObject({
            phase: 'off',
            effectiveDefault: false,
          });
        }
      }).pipe(provideTestLayer(platform)),
  );

  effectIt.effect(
    'reclaims crashed owners but never signals a reused PID, and recovers an expired startup reservation',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* requestModelSetup(f.home).pipe(f.provide);
        yield* TestClock.adjust(30_001);
        yield* requestModelSetup(f.home).pipe(f.provide);
        expect(f.launches).toHaveLength(2);
        yield* f.worker(0);
        expect(f.offsets).toHaveLength(0);
        const current = yield* readModelSetup(f.home).pipe(f.provide);
        if (current.status !== 'valid') return yield* Effect.die('Expected pending state');
        const dead = {
          token: current.state.reservation!.nonce,
          processId: f.workerPid,
          processStartIdentity: 'old-instance',
        };
        yield* updateModelSetup(f.home, f.manifest, {
          type: 'claim',
          intentEpoch: current.state.intentEpoch,
          job: modelSetupJob(f.home, f.manifest),
          owner: dead,
          nonce: dead.token,
          now: yield* Clock.currentTimeMillis,
        }).pipe(f.provide);
        f.alive.set(f.workerPid, 'unrelated-reused-pid');
        yield* stopModelSetup(f.home).pipe(f.provide);
        expect(f.signals).toEqual([]);
        expect((yield* readModelSetup(f.home).pipe(f.provide)).status).toBe('valid');
        yield* setModelSetupPolicy(f.home, true).pipe(f.provide);
        yield* f.worker();
        expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).artifactReady).toBe(true);
      }).pipe(provideTestLayer(platform)),
  );

  it('keeps retry delays bounded and finite and rejects malformed private worker arguments', () => {
    FC.assert(
      FC.property(FC.integer({min: 1, max: 1_000}), FC.double({min: 0, max: 1, noNaN: true}), (attempt, jitter) => {
        const delay = modelSetupRetryDelay(attempt, jitter);
        expect(delay).toBeGreaterThanOrEqual(54_000);
        expect(delay).toBeLessThanOrEqual(6 * 60 * 60_000);
        expect(modelSetupRetryDelay(attempt + 1, jitter)).toBeGreaterThanOrEqual(delay);
      }),
      {numRuns: 100},
    );
    for (const args of [
      [],
      ['--home', '/home'],
      ['--home', '/home', '--epoch', '-1', '--nonce', 'one'],
      ['--home', '/home', '--epoch', '1', '--nonce', 'bad/value'],
    ])
      expect(parseModelSetupWorkerArguments(args)).toBeUndefined();
  });
});
