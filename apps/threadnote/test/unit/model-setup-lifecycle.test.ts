import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {BunCrypto, BunFileSystem, BunPath, BunTerminal} from '@effect/platform-bun';
import {Clock, Context, Crypto, Deferred, Effect, Fiber, FileSystem, Layer, Path, Queue, PlatformError} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {CommandExecutor} from '@threadnote/platform/command';
import {sha256Hex} from '@threadnote/platform/digest';
import {HttpRequestFailed, HttpService} from '@threadnote/platform/http';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {
  CORE_GENERATION_MODEL_ID,
  CORE_EMBEDDING_MODEL_ID,
  BUILTIN_MODEL_MANIFESTS,
} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {CliOutput} from '../../src/effect/cli/output.js';
import {readModelSetup} from '@threadnote/inference/models/setup';
import {
  automaticModelSetupRuntimeAllowed,
  parseModelSetupWorkerArguments,
  readModelSetupStatus,
  requestModelSetup,
  runModelSetupWorker,
  stopModelSetup,
} from '../../src/models/setup.js';
import {
  automaticModelSetupEnvironment,
  captureAutomaticModelSetupHome,
  MODEL_SETUP_REQUEST_ARGUMENT,
  parseAutomaticModelSetupArguments,
  queueAutomaticModelSetup,
  runAutomaticModelSetupChild,
  runAutomaticModelSetupRequest,
  startAutomaticModelSetupScheduler,
} from '../../src/models/setup_lifecycle.js';
import {withSetupMutationLock} from '../../src/setup/lock.js';
import {runInstall} from '../../src/lifecycle.js';
import {threadnoteUpdateCommandMode} from '../../src/release/auto_update.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer, BunTerminal.layer);
function providePlatform<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(Layer.build(platform).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}
const payload = new TextEncoder().encode('lifecycle pinned model fixture');
const fixture = (
  options: {
    readonly barrier?: Deferred.Deferred<void>;
    readonly started?: Deferred.Deferred<void>;
    readonly failFirst?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-lifecycle-'});
    const root = yield* fs.realPath(temporary);
    const home = path.join(root, 'home');
    yield* fs.makeDirectory(home);
    const installRoot = path.join(root, 'install');
    const releaseRoot = (version: string) => path.join(installRoot, 'versions', version);
    const releaseA = releaseRoot('5.3.0-beta.4');
    const releaseB = releaseRoot('5.3.0-beta.5');
    for (const [version, directory] of [
      ['5.3.0-beta.4', releaseA],
      ['5.3.0-beta.5', releaseB],
    ]) {
      yield* fs.makeDirectory(directory, {recursive: true});
      yield* fs.writeFileString(path.join(directory, 'release.json'), JSON.stringify({version}));
    }
    const activate = (version: string) =>
      fs.writeFileString(
        path.join(installRoot, 'active-release.json'),
        JSON.stringify({version, releaseRoot: releaseRoot(version)}),
      );
    yield* activate('5.3.0-beta.4');
    const executable = (directory: string) =>
      path.join(directory, process.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
    const manifest: LocalModelManifest = {
      architecture: 'fixture',
      contextLimit: 64,
      file: 'fixture.gguf',
      id: CORE_GENERATION_MODEL_ID,
      license: 'Apache-2.0',
      minimumRamBytes: 8,
      quantization: 'Q4_0',
      repository: 'fixture/model',
      revision: Effect2.pipe('a', EffectString.repeat(40)),
      role: 'generation',
      runtime: {nodeLlamaCpp: '3.22.1'},
      sha256: yield* sha256Hex(payload),
      size: payload.length,
      version: 1,
    };
    const launches: {executable: string; args: readonly string[]; environment?: NodeJS.ProcessEnv}[] = [];
    const downloads: number[] = [];
    const launched = yield* Queue.unbounded<number>();
    let memory = 1000;
    const systemContext = yield* Layer.build(
      Layer.mock(SystemInfo, {
        processId: process.pid,
        currentDirectory: () => root,
        developmentEntrypoint: executable(releaseA),
        intendedChildEnvironment: environment => environment,
        memoryUsage: () => ({external: 0, heapUsed: 0, rss: 0}),
        pathDelimiter: process.platform === 'win32' ? ';' : ':',
        processArguments: [],
        runtimeVersion: 'test-runtime',
        readLine: () => () => undefined,
        signalProcess: () => undefined,
        setExitCode: () => undefined,
        setEnvironmentVariable: () => undefined,
        stdinIsTTY: false,
        stdoutIsTTY: false,
        tempDirectory: root,
        userName: 'tester',
        platform: process.platform,
        architecture: process.arch,
        executablePath: executable(releaseA),
        homeDirectory: root,
        environment: () => ({THREADNOTE_INSTALL_ROOT: installRoot}),
        hardwareInfo: Effect.sync(() => ({
          cpuModel: 'fixture-cpu',
          effectiveMemoryBytes: memory,
          memoryBytes: memory,
          operatingSystem: process.platform,
        })),
        availableDiskBytes: () => Effect.succeed(1_000_000),
        canonicalProcessStartIdentity: () => Effect.succeed('fixture-process'),
        processStartIdentity: () => Effect.succeed('fixture-process'),
        isProcessRunning: (pid: number) => pid === process.pid,
      }),
    );
    const system = Context.get(systemContext, SystemInfo);
    const http = HttpService.of({
      downloadToFile: (_url, file, transfer) =>
        Effect.gen(function* () {
          downloads.push(transfer?.offset ?? 0);
          if (options.started) yield* Deferred.succeed(options.started, undefined);
          if (options.barrier) yield* Deferred.await(options.barrier);
          if (options.failFirst && downloads.length === 1) {
            yield* fs.writeFile(file, payload.slice(0, 5));
            return yield* HttpRequestFailed.make({
              cause: 'offline',
              message: 'offline',
              method: 'GET',
              url: 'https://fixture.invalid',
            });
          }
          yield* fs.writeFile(file, payload.slice(transfer?.offset ?? 0), {flag: transfer?.offset ? 'a' : 'w'});
          return {resumed: Boolean(transfer?.offset), status: transfer?.offset ? 206 : 200};
        }).pipe(
          Effect.mapError(cause =>
            HttpRequestFailed.make({
              cause,
              message: 'Fixture transfer failed',
              method: 'GET',
              url: 'https://fixture.invalid',
            }),
          ),
        ),
      getJson: () => Effect.die('No JSON'),
      getText: () => Effect.die('No text'),
      getStatus: () => Effect.die('No status'),
    });
    const commands = CommandExecutor.of({
      execute: () => Effect.die('No native or foreground child execution'),
      executeStreaming: () => Effect.die('No streamed child execution'),
      spawnDetached: (executable, args, opts) =>
        Effect.sync(() => {
          launches.push({executable, args, environment: opts?.env});
          return true;
        }).pipe(Effect.tap(() => Queue.offer(launched, launches.length))),
    });
    const context = Context.make(FileSystem.FileSystem, fs).pipe(
      Context.add(Path.Path, path),
      Context.add(Crypto.Crypto, crypto),
      Context.add(SystemInfo, system),
      Context.add(HttpService, http),
      Context.add(CommandExecutor, commands),
      Context.add(
        CliOutput,
        CliOutput.of({
          drain: Effect.void,
          flush: Effect.void,
          enqueueOutput: () => undefined,
          enqueueError: () => undefined,
          writeError: () => Effect.void,
          writeFinal: () => Effect.void,
        }),
      ),
      Context.add(
        LocalModelRuntime,
        LocalModelRuntime.of({
          diagnostics: Effect.die('No native diagnostics during provisioning'),
          embedMany: () => Effect.die('No native embedding during provisioning'),
          generate: () => Effect.die('No generation during provisioning'),
          rerank: () => Effect.die('No reranking during provisioning'),
        }),
      ),
    );
    const catalogContext = yield* Layer.build(LocalModelCatalog.layer([manifest])).pipe(Effect.provide(context));
    const storeContext = yield* Layer.build(LocalModelStore.layer).pipe(Effect.provide(context));
    const services = context.pipe(Context.merge(catalogContext), Context.merge(storeContext));
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(services));
    const worker = (index = launches.length - 1, workerManifest = manifest, workerSystem = system) =>
      Effect.gen(function* () {
        const args = parseModelSetupWorkerArguments(launches[index].args.slice(1));
        if (!args) return yield* Effect.die('Expected worker arguments');
        const catalog = yield* Layer.build(LocalModelCatalog.layer([workerManifest]));
        yield* runModelSetupWorker(args.home, args.intentEpoch, args.nonce).pipe(
          Effect.provide(catalog),
          Effect.provideService(SystemInfo, workerSystem),
          provide,
        );
      });
    return {
      fs,
      path,
      root,
      home,
      manifest,
      system,
      installRoot,
      activate,
      executableB: executable(releaseB),
      launches,
      downloads,
      provide,
      worker,
      installedPath: Context.get(storeContext, LocalModelStore).path(home, manifest),
      awaitLaunch: (count: number) =>
        Effect.gen(function* () {
          while (launches.length < count) yield* Queue.take(launched);
        }),
      setMemory: (value: number) => {
        memory = value;
      },
    };
  });

describe('automatic model setup lifecycle', () => {
  effectIt.effect('does not recreate an erased home from a queued automatic request', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const binding = yield* captureAutomaticModelSetupHome(f.home);
      expect(binding).toBeDefined();
      yield* f.fs.remove(f.home, {recursive: true});
      yield* runAutomaticModelSetupRequest(binding!).pipe(f.provide);
      expect(yield* f.fs.exists(f.home)).toBe(false);
      expect(f.launches).toHaveLength(0);
    }).pipe(providePlatform),
  );
  effectIt.effect('direct installation queues after core setup, while dry-run and one-shot skip do not', () =>
    Effect.gen(function* () {
      for (const options of [{start: false}, {modelSetup: false}, {dryRun: true}]) {
        const f = yield* fixture();
        const embedding: LocalModelManifest = {
          ...EffectOption.getOrUndefined(
            EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === CORE_EMBEDDING_MODEL_ID),
          )!,
          file: 'embedding.gguf',
          sha256: f.manifest.sha256,
          size: payload.length,
        };
        const catalog = yield* Layer.build(LocalModelCatalog.layer([f.manifest, embedding]));
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: f.home,
          agentId: 'threadnote',
          manifestPath: f.path.join(f.home, 'seed.yaml'),
          user: 'fixture',
        };
        yield* runInstall(config, {
          ...options,
          skipRecallIndexes: true,
          skipReleaseLifecycle: true,
          printNextSteps: false,
        }).pipe(Effect.provide(catalog), f.provide);
        expect(f.launches).toHaveLength('start' in options ? 1 : 0);
        if ('start' in options) expect(f.launches[0].args).toContain(MODEL_SETUP_REQUEST_ARGUMENT);
      }
    }).pipe(providePlatform),
  );

  effectIt.effect('rechecks the directory after waiting for the uninstall mutation lock', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const binding = (yield* captureAutomaticModelSetupHome(f.home))!;
      const locked = yield* Deferred.make<void>();
      const erase = yield* Deferred.make<void>();
      const prechecked = yield* Deferred.make<void>();
      const holder = yield* withSetupMutationLock(
        f.home,
        Effect.gen(function* () {
          yield* Deferred.succeed(locked, undefined);
          yield* Deferred.await(erase);
          yield* f.fs.remove(f.home, {recursive: true});
        }),
      ).pipe(f.provide, Effect.forkScoped);
      yield* Deferred.await(locked);
      const watching = {
        ...f.fs,
        makeDirectory: (directory: string, options?: Parameters<typeof f.fs.makeDirectory>[1]) =>
          f.fs
            .makeDirectory(directory, options)
            .pipe(Effect.tap(() => (directory === f.root ? Deferred.succeed(prechecked, undefined) : Effect.void))),
      };
      const request = yield* runAutomaticModelSetupRequest(binding).pipe(
        Effect.provideService(FileSystem.FileSystem, watching),
        f.provide,
        Effect.forkScoped,
      );
      yield* Deferred.await(prechecked);
      yield* Deferred.succeed(erase, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(request);
      expect(yield* f.fs.exists(f.home)).toBe(false);
      expect(f.launches).toHaveLength(0);
    }).pipe(TestClock.withLive, providePlatform),
  );

  effectIt.effect('rejects a queued child when the home was replaced at the same path', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* queueAutomaticModelSetup(f.home).pipe(f.provide);
      expect(f.launches).toHaveLength(1);
      yield* f.fs.rename(f.home, `${f.home}-old`);
      yield* f.fs.makeDirectory(f.home);
      yield* runAutomaticModelSetupChild(f.launches[0].args.slice(1)).pipe(f.provide);
      expect(f.launches).toHaveLength(1);
      expect(yield* f.fs.readDirectory(f.home)).toEqual([]);
      expect(f.downloads).toEqual([]);
    }).pipe(providePlatform),
  );

  effectIt.effect('does not initialize absent homes, dry runs, skipped installs or disabled environments', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const absent = f.path.join(f.root, 'absent');
      yield* queueAutomaticModelSetup(absent).pipe(f.provide);
      yield* queueAutomaticModelSetup(f.home, {dryRun: true}).pipe(f.provide);
      yield* queueAutomaticModelSetup(f.home, {modelSetup: false}).pipe(f.provide);
      for (const environment of [
        {CI: 'true'},
        {VITEST: '1'},
        {NODE_ENV: 'test'},
        {THREADNOTE_MODEL_SETUP: 'off'},
        {THREADNOTE_TOOLSET: 'cloud'},
        {THREADNOTE_MCP_TOOLSET: 'cursor-cloud-personal'},
      ]) {
        yield* queueAutomaticModelSetup(f.home).pipe(
          Effect.provideService(SystemInfo, {...f.system, environment: () => environment}),
          f.provide,
        );
      }
      yield* queueAutomaticModelSetup(f.home).pipe(
        Effect.provideService(SystemInfo, {...f.system, executablePath: '/usr/bin/bun'}),
        f.provide,
      );
      expect(yield* f.fs.exists(absent)).toBe(false);
      expect(yield* f.fs.readDirectory(f.home)).toEqual([]);
      expect(f.launches).toHaveLength(0);
    }).pipe(providePlatform),
  );

  effectIt.effect(
    'new-binary requests use the explicit canonical home, preserve choices, and return before download',
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const barrier = yield* Deferred.make<void>();
        const f = yield* fixture({started, barrier});
        const other = f.path.join(f.root, 'other-home');
        yield* f.fs.makeDirectory(other);
        yield* f.fs.makeDirectory(f.path.join(f.home, 'models'));
        const selection = '{"version":1,"roles":{"generation":"different-explicit-model"}}';
        yield* f.fs.writeFileString(f.path.join(f.home, 'models', 'selection.json'), selection);
        yield* queueAutomaticModelSetup(f.home, {executable: '/new-release/threadnote'}).pipe(f.provide);
        const queued = f.launches[0];
        expect(queued.executable).toBe('/new-release/threadnote');
        expect(queued.args[0]).toBe(MODEL_SETUP_REQUEST_ARGUMENT);
        expect(queued.environment?.THREADNOTE_HOME).toBe(f.home);
        expect(f.downloads).toEqual([]);
        yield* runAutomaticModelSetupChild(queued.args.slice(1)).pipe(f.provide);
        expect(f.launches).toHaveLength(2);
        const worker = yield* Effect.forkScoped(f.worker());
        yield* Deferred.await(started);
        expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).phase).toBe('downloading');
        expect(yield* f.fs.readDirectory(other)).toEqual([]);
        yield* Deferred.succeed(barrier, undefined);
        yield* Fiber.join(worker);
        expect(yield* readModelSetupStatus(f.home).pipe(f.provide)).toMatchObject({
          artifactReady: true,
          effectiveDefault: false,
        });
        expect(yield* f.fs.readFileString(f.path.join(f.home, 'models', 'selection.json'))).toBe(selection);
      }).pipe(providePlatform),
  );

  effectIt.effect('persistent off survives duplicate startup requests without a transfer or selection mutation', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* stopModelSetup(f.home).pipe(f.provide);
      const before = yield* f.fs.readFileString(f.path.join(f.home, 'models', 'setup.json'));
      const binding = (yield* captureAutomaticModelSetupHome(f.home))!;
      yield* Effect.forEach([1, 2, 3], () => runAutomaticModelSetupRequest(binding).pipe(f.provide), {
        concurrency: 'unbounded',
      });
      expect(yield* f.fs.readFileString(f.path.join(f.home, 'models', 'setup.json'))).toBe(before);
      expect(f.launches).toHaveLength(0);
      expect(f.downloads).toHaveLength(0);
    }).pipe(TestClock.withLive, providePlatform),
  );

  effectIt.effect('startup retries due work once and stops when its captured home is erased', () =>
    Effect.gen(function* () {
      const f = yield* fixture({failFirst: true});
      yield* startAutomaticModelSetupScheduler(f.home).pipe(f.provide);
      yield* f.awaitLaunch(1);
      expect(f.launches).toHaveLength(1);
      yield* f.worker();
      const failed = yield* readModelSetupStatus(f.home).pipe(f.provide);
      expect(failed.phase).toBe('retry-wait');
      const now = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust(failed.nextAttemptAt! - now + 60_000);
      yield* f.awaitLaunch(2);
      expect(f.launches).toHaveLength(2);
      yield* f.worker();
      expect(f.downloads).toEqual([0, 5]);
      expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).artifactReady).toBe(true);
      yield* f.fs.remove(f.home, {recursive: true});
      yield* TestClock.adjust(120_000);
      expect(yield* f.fs.exists(f.home)).toBe(false);
      expect(f.launches).toHaveLength(2);
    }).pipe(providePlatform),
  );

  effectIt.effect('revalidates a removed artifact while honoring a later persistent opt-out', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const binding = (yield* captureAutomaticModelSetupHome(f.home))!;
      yield* runAutomaticModelSetupRequest(binding).pipe(f.provide);
      yield* f.worker();
      yield* f.fs.remove(f.installedPath);
      yield* runAutomaticModelSetupRequest(binding).pipe(f.provide);
      expect(f.launches).toHaveLength(2);
      yield* f.worker();
      expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).artifactReady).toBe(true);
      yield* stopModelSetup(f.home).pipe(f.provide);
      yield* f.fs.remove(f.installedPath);
      yield* runAutomaticModelSetupRequest(binding).pipe(f.provide);
      expect(f.launches).toHaveLength(2);
      expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).policy).toBe('off');
    }).pipe(providePlatform),
  );

  effectIt.effect('reports resource failures without transferring and permits an explicit remediation retry', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setMemory(1);
      yield* runAutomaticModelSetupRequest((yield* captureAutomaticModelSetupHome(f.home))!).pipe(f.provide);
      expect(yield* readModelSetupStatus(f.home).pipe(f.provide)).toMatchObject({
        phase: 'action-required',
        reason: 'insufficient-memory',
      });
      expect(f.launches).toHaveLength(0);
      f.setMemory(1000);
      yield* requestModelSetup(f.home, {retry: true}).pipe(f.provide);
      yield* f.worker();
      expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).artifactReady).toBe(true);
    }).pipe(providePlatform),
  );

  effectIt.effect('keeps installation usable when child launch fails or the home becomes read-only', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const run = Effect.gen(function* () {
        const commands = yield* CommandExecutor;
        yield* queueAutomaticModelSetup(f.home).pipe(
          Effect.provideService(CommandExecutor, {
            ...commands,
            spawnDetached: () => Effect.succeed(false),
          }),
        );
        const binding = (yield* captureAutomaticModelSetupHome(f.home))!;
        const readonly = {
          ...f.fs,
          makeDirectory: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: 'PermissionDenied',
                module: 'FileSystem',
                method: 'makeDirectory',
              }),
            ),
        };
        yield* runAutomaticModelSetupRequest(binding).pipe(Effect.provideService(FileSystem.FileSystem, readonly));
      });
      yield* run.pipe(f.provide);
      expect(f.launches).toHaveLength(0);
      expect(f.downloads).toHaveLength(0);
      expect(yield* f.fs.readDirectory(f.home)).toEqual([]);
    }).pipe(providePlatform),
  );

  effectIt.effect('rejects unsupported native variants before any transfer', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const binding = (yield* captureAutomaticModelSetupHome(f.home))!;
      yield* runAutomaticModelSetupRequest(binding).pipe(
        Effect.provideService(SystemInfo, {
          ...f.system,
          platform: 'win32',
          architecture: 'arm64',
        }),
        f.provide,
      );
      expect(yield* readModelSetupStatus(f.home).pipe(f.provide)).toMatchObject({
        phase: 'action-required',
        reason: 'unsupported-platform',
      });
      expect(f.launches).toHaveLength(0);
      expect(f.downloads).toHaveLength(0);
    }).pipe(providePlatform),
  );

  effectIt.effect('keeps B ready when the surviving A scheduler ticks after promotion and A queues the B child', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const binding = (yield* captureAutomaticModelSetupHome(f.home))!;
      yield* startAutomaticModelSetupScheduler(f.home).pipe(f.provide);
      yield* f.awaitLaunch(1);
      yield* f.worker();
      yield* f.activate('5.3.0-beta.5');
      const changed = {...f.manifest, revision: Effect2.pipe('b', EffectString.repeat(40))};
      const catalog = yield* Layer.build(LocalModelCatalog.layer([changed]));
      const systemB = {...f.system, executablePath: f.executableB};
      // The updater parent is still A; only the explicitly selected new child owns catalog B.
      yield* queueAutomaticModelSetup(f.home, {executable: f.executableB}).pipe(f.provide);
      expect(f.launches).toHaveLength(2);
      expect(f.launches[1].executable).toBe(f.executableB);
      yield* runAutomaticModelSetupChild(f.launches[1].args.slice(1)).pipe(
        Effect.provide(catalog),
        Effect.provideService(SystemInfo, systemB),
        f.provide,
      );
      expect(f.launches).toHaveLength(3);
      yield* f.worker(2, changed, systemB);
      const before = yield* f.fs.readFileString(f.path.join(f.home, 'models', 'setup.json'));
      expect(JSON.parse(before)).toMatchObject({phase: 'ready', job: {revision: changed.revision}});
      yield* TestClock.adjust(60_000);
      // Also exercise an old tick already dispatched before the scheduler observes promotion.
      yield* runAutomaticModelSetupRequest(binding).pipe(f.provide);
      expect(yield* f.fs.readFileString(f.path.join(f.home, 'models', 'setup.json'))).toBe(before);
      expect(f.launches).toHaveLength(3);
      // Authority, rather than model/version ordering: a later deliberate activation of A may request its own pin.
      yield* f.activate('5.3.0-beta.4');
      yield* runAutomaticModelSetupRequest(binding).pipe(f.provide);
      expect(f.launches).toHaveLength(4);
      const restored = yield* readModelSetup(f.home).pipe(f.provide);
      expect(restored.status === 'valid' && restored.state.job.revision).toBe(f.manifest.revision);
    }).pipe(providePlatform),
  );

  effectIt.effect(
    'rechecks active runtime after old A waits on the home lock while B becomes active and requests its pin',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const binding = (yield* captureAutomaticModelSetupHome(f.home))!;
        const changed = {...f.manifest, revision: Effect2.pipe('b', EffectString.repeat(40))};
        const catalog = yield* Layer.build(LocalModelCatalog.layer([changed]));
        const systemB = {...f.system, executablePath: f.executableB};
        const locked = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<void>();
        const holder = yield* withSetupMutationLock(
          f.home,
          Effect.gen(function* () {
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(waiting);
            yield* f.activate('5.3.0-beta.5');
            // B's accepted mutation already owns the home lock; avoid a nested reentrant request.
            yield* requestModelSetup(f.home, {automatic: true}).pipe(
              Effect.provide(catalog),
              Effect.provideService(SystemInfo, systemB),
              f.provide,
            );
            return yield* f.fs.readFileString(f.path.join(f.home, 'models', 'setup.json'));
          }),
        ).pipe(f.provide, Effect.forkScoped);
        yield* Deferred.await(locked);
        const watching = {
          ...f.fs,
          makeDirectory: (directory: string, options?: Parameters<typeof f.fs.makeDirectory>[1]) =>
            f.fs
              .makeDirectory(directory, options)
              .pipe(Effect.tap(() => (directory === f.root ? Deferred.succeed(waiting, undefined) : Effect.void))),
        };
        const old = yield* runAutomaticModelSetupRequest(binding).pipe(
          Effect.provideService(FileSystem.FileSystem, watching),
          f.provide,
          Effect.forkScoped,
        );
        const before = yield* Fiber.join(holder);
        yield* Fiber.join(old);
        expect(yield* f.fs.readFileString(f.path.join(f.home, 'models', 'setup.json'))).toBe(before);
        expect(f.launches).toHaveLength(1);
      }).pipe(TestClock.withLive, providePlatform),
  );

  effectIt.effect(
    'defers automatic setup when active authority is missing, invalid, or the executable is unmanaged',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const binding = (yield* captureAutomaticModelSetupHome(f.home))!;
        const pointer = f.path.join(f.installRoot, 'active-release.json');
        yield* f.fs.remove(pointer);
        yield* runAutomaticModelSetupRequest(binding).pipe(f.provide);
        yield* f.fs.writeFileString(pointer, '{invalid');
        yield* runAutomaticModelSetupRequest(binding).pipe(f.provide);
        yield* f.activate('5.3.0-beta.4');
        yield* runAutomaticModelSetupRequest(binding).pipe(
          Effect.provideService(SystemInfo, {
            ...f.system,
            executablePath: f.path.join(f.root, 'unmanaged', 'threadnote'),
          }),
          f.provide,
        );
        expect(f.launches).toHaveLength(0);
        expect(yield* f.fs.readDirectory(f.home)).toEqual([]);
        // Explicit setup remains an independent user action even without automatic active-release authority.
        yield* f.fs.remove(pointer);
        yield* requestModelSetup(f.home, {retry: true}).pipe(f.provide);
        yield* f.worker();
        expect((yield* readModelSetupStatus(f.home).pipe(f.provide)).artifactReady).toBe(true);
      }).pipe(providePlatform),
  );

  effectIt.effect('supersedes a queued worker when a new binary changes its pinned manifest', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const binding = (yield* captureAutomaticModelSetupHome(f.home))!;
      yield* runAutomaticModelSetupRequest(binding).pipe(f.provide);
      yield* f.activate('5.3.0-beta.5');
      const changed = {...f.manifest, revision: Effect2.pipe('b', EffectString.repeat(40))};
      const catalog = yield* Layer.build(LocalModelCatalog.layer([changed]));
      yield* runAutomaticModelSetupRequest(binding).pipe(
        Effect.provide(catalog),
        Effect.provideService(SystemInfo, {...f.system, executablePath: f.executableB}),
        f.provide,
      );
      expect(f.launches).toHaveLength(2);
      yield* f.worker(0);
      expect(f.downloads).toHaveLength(0);
      const state = yield* readModelSetup(f.home).pipe(f.provide);
      expect(state.status === 'valid' && state.state.job.revision).toBe(changed.revision);
    }).pipe(providePlatform),
  );
});

it('keeps the automatic eligibility truth table closed under environment, source and development exclusions', () => {
  fc.assert(
    fc.property(
      fc.record({
        ci: fc.boolean(),
        test: fc.boolean(),
        vitest: fc.boolean(),
        cloud: fc.boolean(),
        cloudMcp: fc.boolean(),
        off: fc.boolean(),
        executable: fc.constantFrom('threadnote', 'bun', 'bun.exe', 'node', 'node.exe'),
        version: fc.constantFrom(
          '5.3.0-beta.5',
          '5.3.0',
          '5.3.0-beta.5.local.gabc123',
          '5.3.0-local.gabc123',
          'unknown',
        ),
      }),
      input => {
        const environment = {
          CI: input.ci ? '1' : undefined,
          VITEST: input.vitest ? '1' : undefined,
          NODE_ENV: input.test ? 'test' : 'production',
          THREADNOTE_TOOLSET: input.cloud ? 'cloud' : undefined,
          THREADNOTE_MCP_TOOLSET: input.cloudMcp ? 'cursor-cloud' : 'full',
          THREADNOTE_MODEL_SETUP: input.off ? 'off' : undefined,
        };
        const system = {
          environment: () => environment,
          executablePath: `/fixture/${input.executable}`,
        } satisfies Pick<SystemInfoShape, 'environment' | 'executablePath'>;
        const expected =
          !(input.ci || input.test || input.vitest || input.cloud || input.cloudMcp || input.off) &&
          input.executable === 'threadnote' &&
          ['5.3.0-beta.5', '5.3.0'].includes(input.version);
        expect(automaticModelSetupRuntimeAllowed(system, input.version)).toBe(expected);
      },
    ),
    {numRuns: 100},
  );
});

it('preserves exclusion flags in the new child environment without inheriting provider credentials', () => {
  const environment = automaticModelSetupEnvironment(
    {
      CI: '1',
      VITEST: '1',
      NODE_ENV: 'test',
      THREADNOTE_MCP_TOOLSET: 'cursor-cloud',
      THREADNOTE_TOOLSET: 'cloud',
      OPENAI_API_KEY: 'private',
      ANTHROPIC_API_KEY: 'private',
      HTTPS_PROXY: 'https://proxy.invalid',
    },
    '/bound/home',
  );
  expect(environment).toEqual({
    CI: '1',
    VITEST: '1',
    NODE_ENV: 'test',
    THREADNOTE_MCP_TOOLSET: 'cursor-cloud',
    THREADNOTE_TOOLSET: 'cloud',
    HTTPS_PROXY: 'https://proxy.invalid',
    THREADNOTE_HOME: '/bound/home',
  });
});

it.each(
  EffectArray.map(
    [[], ['--home', '/home'], ['--home', '/home', '--identity', 'bad'], ['--identity', '1:2:3', '--home', '/home']],
    args => ({args}),
  ),
)('rejects malformed internal automatic request arguments $args', ({args}) =>
  expect(parseAutomaticModelSetupArguments(args)).toBeUndefined(),
);

it('treats a model-setup opt-out as a release option while retaining explicit status-mode validation', () => {
  expect(threadnoteUpdateCommandMode({modelSetup: false})).toBe('release');
  expect(threadnoteUpdateCommandMode({modelSetup: false, json: true})).toBe('release');
  expect(threadnoteUpdateCommandMode({modelSetup: false, status: true})).toBe('invalid');
});
