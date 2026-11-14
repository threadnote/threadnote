import {it as effectIt} from '@effect/vitest';
import {
  Effect,
  Array as EffectArray,
  Option,
  FileSystem,
  Path,
  Layer,
  Result,
  Deferred,
  Fiber,
  Exit,
  Cause,
} from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import * as BunServices from '@effect/platform-bun/BunServices';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {EventEmitter} from 'node:events';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Drain the child pipe callback turn before delivering its later stderr event.
import {setImmediate} from 'node:timers';
import {PassThrough} from '@threadnote/testing/node-stream';
import {expect, it, vi} from 'vitest';
import fc from 'fast-check';
import * as EffectString from 'effect/String';
import {
  fixtureDeadline,
  FixtureProcesses,
  FixtureStdioTransport,
  runFixtureCommand,
  reconcileFixturePipelineReceipts,
  runFixtureEmbeddingExitProbe,
  diagnoseFixtureEmbeddingFailure,
  createFixtureWindowsExitObserver,
  prepareFixtureEmbeddingApiControl,
} from '../../../../scripts/fixture-owned-process.js';
import {
  publishNativeInferenceOverlay,
  nativeInferenceHostTarget,
} from '../../../../scripts/native-inference-payload.js';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';

function commandChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: () => {},
    kill: () => {
      throw new Error('must not signal');
    },
  });
}

function embeddingProbeChild(onWrite: (text: string) => void, onExit: () => void = () => {}) {
  const io = commandChild();
  const stopped = Promise.withResolvers<number>();
  let signal: NodeJS.Signals | number | null = null;
  let kills = 0,
    ends = 0;
  const fixture = {
    io,
    writeBytes: undefined as number | undefined,
    onEnd: (): void | Promise<void> => {},
    get kills() {
      return kills;
    },
    get ends() {
      return ends;
    },
    exit(code: number, exitSignal: NodeJS.Signals | number | null = null) {
      signal = exitSignal;
      io.stdout.end();
      io.stderr.end();
      stopped.resolve(code);
      onExit();
    },
    child: {
      pid: 42,
      stdout: io.stdout,
      stderr: io.stderr,
      exited: stopped.promise,
      get signalCode() {
        return signal;
      },
      stdin: {
        write: (text: string) => {
          onWrite(text);
          return fixture.writeBytes ?? Buffer.byteLength(text);
        },
        flush: () => 0,
        end: () => {
          ends++;
          return fixture.onEnd();
        },
      },
      kill: () => {
        kills++;
        fixture.exit(137, 'SIGKILL');
      },
      unref: () => {},
    },
  };
  return fixture;
}

function debuggerProbeChild() {
  const io = commandChild();
  let finished = false,
    kills = 0;
  const finish = (code = 0, signal: NodeJS.Signals | null = null) => {
    if (finished) return;
    finished = true;
    io.emit('exit', code, signal);
    io.stdout.end();
    io.stderr.end();
    io.emit('close', code, signal);
  };
  const child = Object.assign(io, {
    kill: () => {
      kills++;
      finish(137, 'SIGKILL');
      return true;
    },
    arm: () => {
      setImmediate(() => {
        io.emit('spawn');
        io.stdout.write('THREADNOTE_NATIVE_CDB_ARMED\n');
      });
    },
    finish,
  });
  return {
    child,
    io,
    get kills() {
      return kills;
    },
  };
}

function windowsExitFixture() {
  const handle = 0xfedcba9876543210n;
  const calls: string[] = [];
  const library = {
    symbols: {
      OpenProcess: vi.fn(() => {
        calls.push('open');
        return handle;
      }),
      GetExitCodeProcess: vi.fn((_handle: bigint, output: Uint32Array) => {
        calls.push('query');
        output[0] = 0xc0000409;
        return 1;
      }),
      CloseHandle: vi.fn(() => {
        calls.push('handle-close');
        return 1;
      }),
    },
    close: vi.fn(() => {
      calls.push('library-close');
    }),
  };
  return {library, calls, observer: createFixtureWindowsExitObserver(() => library)!};
}

const probeManifest = Option.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'bge-small-en-v1.5-q8'),
)!;
const probeRequest = {
  inputs: new Array<string>(32).fill(EffectString.repeat(2400)('x')),
  manifest: probeManifest,
  modelPath: 'PRIVATE_MODEL_PATH',
};

const probeSetupLayer = Layer.merge(BunServices.layer, cryptoLayer);

effectIt.effect('the model-load control exits without a reply or stdin EOF after using the exact admitted bundle', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({prefix: 'threadnote-api-control-'});
    let safeToRemove = true;
    yield* Effect.addFinalizer(() =>
      safeToRemove ? fs.remove(root, {recursive: true}).pipe(Effect.orDie) : Effect.void,
    );
    const home = path.join(root, 'home');
    const expectedModelPath = 'PRIVATE_MODEL_PATH';
    const candidate = path.join(root, 'candidate');
    const runtime = path.join(candidate, 'runtime');
    const build = path.join(candidate, 'llama', 'localBuilds', 'fixture', 'Release');
    yield* fs.makeDirectory(home);
    yield* fs.makeDirectory(runtime, {recursive: true});
    yield* fs.makeDirectory(build, {recursive: true});
    yield* fs.writeFileString(
      path.join(runtime, 'node-llama-cpp.js'),
      `export async function getLlama(options) {
      if(options.build !== 'never' || options.debug !== false || options.logLevel !== 'disabled' || options.progressLogs !== false || options.skipDownload !== true || options.usePrebuiltBinaries !== true) throw new Error('options');
      return {
        buildType:'localBuild',gpu:false,supportsGpuOffloading:false,supportsMmap:true,
        dispose:async()=>{},
        loadModel:async options=>{
          if(options.modelPath !== ${JSON.stringify(expectedModelPath)} || options.ignoreMemorySafetyChecks !== false || !options.loadSignal) throw new Error('model-load-options');
          return {dispose:async()=>{}};
        }
      };
    }`,
    );
    yield* fs.writeFileString(path.join(build, 'llama-addon.node'), 'fake setup addon');
    yield* fs.writeFileString(
      path.join(build, '_nlcBuildMetadata.json'),
      JSON.stringify({buildOptions: {gpu: false, arch: process.arch, platform: 'win'}}),
    );
    yield* fs.writeFileString(path.join(path.dirname(build), 'buildDone.status'), 'done');
    yield* publishNativeInferenceOverlay(candidate, {
      bunVersion: '1.4.4',
      bunTarget: nativeInferenceHostTarget(),
      packageVersion: '3.22.2',
      llamaCommit: '1729d2ec2c4846df7754f4ce8f90f75f8a30ca3b',
      sourceInputDigest: EffectString.repeat(64)('0'),
      origin: 'portable-local-build',
      toolchain: {},
    });
    const executable = path.join(candidate, 'threadnote');
    yield* fs.makeDirectory(path.join(candidate, 'bins'));
    expect(
      Result.isFailure(yield* prepareFixtureEmbeddingApiControl(executable, {home, env: {}}).pipe(Effect.result)),
    ).toBe(true);
    expect(yield* fs.exists(path.join(home, '.embedding-api-probe.mjs'))).toBe(false);
    yield* fs.remove(path.join(candidate, 'bins'), {recursive: true});
    yield* fs.writeFileString(path.join(build, 'llama-addon.node'), 'tampered setup addon');
    expect(
      Result.isFailure(yield* prepareFixtureEmbeddingApiControl(executable, {home, env: {}}).pipe(Effect.result)),
    ).toBe(true);
    yield* fs.writeFileString(path.join(build, 'llama-addon.node'), 'fake setup addon');
    const apiControl = yield* prepareFixtureEmbeddingApiControl(executable, {home, env: {}});
    const processes = new FixtureProcesses();
    safeToRemove = false;
    const result = yield* Effect.tryPromise(() =>
      runFixtureEmbeddingExitProbe(
        processes,
        executable,
        {...probeRequest, inputs: ['QZ9 standalone short embedding control.']},
        {cwd: home, env: process.env, deadline: performance.now() + 3000, maxOutputBytes: 512 * 1024, apiControl},
      ),
    );
    const cleanup = yield* Effect.tryPromise(() => processes.closeAndObserve(performance.now() + 1000));
    safeToRemove = cleanup === 'exited';
    expect(cleanup).toBe('exited');
    expect(result.snapshot()).toMatchObject({
      outcome: 'exit',
      reply: 'none',
      firstFault: 'stdout-eof',
      stdoutBytes: 0,
      exitOrigin: 'natural',
      exit: {exitCode: 0, signal: null},
      processClosed: true,
      cleanupRequested: false,
      stdoutRead: 'eof',
      stderrRead: 'eof',
      apiControl: {
        kind: 'direct-model-load',
        runtime: 'source-bun',
        bunVersion: Bun.version,
        phases: [
          'input-ready',
          'runtime-import-start',
          'runtime-import-ready',
          'initialize-start',
          'initialize-ready',
          'model-load-start',
          'model-load-ready',
          'model-dispose-start',
          'model-dispose-ready',
          'runtime-dispose-start',
          'runtime-dispose-ready',
        ],
      },
    });
  }).pipe(provideTestLayer(probeSetupLayer), TestClock.withLive),
);
const probeSetupFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-probe-setup-'});
  const modelPath = path.join(home, 'models', probeManifest.role, probeManifest.id, `${probeManifest.sha256}.gguf`);
  yield* fs.makeDirectory(path.dirname(modelPath), {recursive: true});
  yield* fs.writeFileString(modelPath, 'short');
  return {
    fs,
    modelPath,
    options: {
      home,
      cwd: home,
      env: {},
      deadline: 100,
      bodyDeadline: 200,
      maxOutputBytes: 512 * 1024,
    },
  };
});

it('waits for the owned debugger attach marker before releasing the one model-load request', async () => {
  const debuggerProcess = debuggerProbeChild();
  const native = windowsExitFixture();
  let armedMarkerEmitted = false;
  debuggerProcess.child.arm = () => {
    setImmediate(() => {
      armedMarkerEmitted = true;
      debuggerProcess.io.emit('spawn');
      debuggerProcess.io.stdout.write('THREADNOTE_NATIVE_CDB_ARMED\n');
    });
  };
  const fake = embeddingProbeChild(
    () => {
      expect(armedMarkerEmitted).toBe(true);
      debuggerProcess.io.stdout.write(
        'ExceptionCode: c0000409 (FAIL_FAST_EXCEPTION)\nParameter[0]: 5\nKERNELBASE!RaiseFailFastException+0x1\n' +
          'THREADNOTE_NATIVE_CDB_CAPTURED\nTHREADNOTE_NATIVE_CDB_QUIT_REQUESTED\n',
      );
      fake.exit(0);
    },
    () => debuggerProcess.child.finish(0),
  );
  const processes = new FixtureProcesses((command, args) => {
    expect(command).toBe('PRIVATE_CDB');
    expect(args).toContain('-sins');
    expect(args).toContain('-G');
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('42');
    const startup = args[args.indexOf('-c') + 1];
    expect(startup).toMatch(/^sxe -c "([^"]+)" -c2 "\1" 0xc0000409; /);
    expect(startup).toContain('THREADNOTE_NATIVE_CDB_ARMED');
    expect(startup).toContain('THREADNOTE_NATIVE_CDB_QUIT_REQUESTED');
    debuggerProcess.child.arm();
    return debuggerProcess.child;
  });
  const result = await runFixtureEmbeddingExitProbe(processes, 'PRIVATE_EXECUTABLE', probeRequest, {
    cwd: 'PRIVATE_PATH',
    env: {PRIVATE_ENV: 'PRIVATE_VALUE'},
    deadline: performance.now() + 1000,
    maxOutputBytes: 512 * 1024,
    spawn: () => fake.child,
    nativeExit: native.observer,
    apiControl: {
      command: [process.execPath, 'PRIVATE_SCRIPT'],
      bunVersion: Bun.version,
      debuggerRequired: true,
      debuggerExecutable: 'PRIVATE_CDB',
      debuggerStartupFile: 'PRIVATE_STARTUP_FILE',
      debuggerEnvironment: {PATH: 'PRIVATE_PATH'},
    },
  });
  native.observer.close();
  expect(result.snapshot()).toMatchObject({
    outcome: 'exit',
    write: 'returned',
    reply: 'none',
    exitOrigin: 'debugger-requested',
    processClosed: true,
    cleanupRequested: false,
    rawExitCode: 0xc0000409,
    rawExitCodeOrigin: 'after-debugger-q',
    debugger: {
      kind: 'cdb-arm64',
      armed: true,
      exited: true,
      closed: true,
      exceptionCode: 'c0000409',
      parameterZero: '0x5',
      frames: ['kernelbase!RaiseFailFastException'],
      captureComplete: true,
      quitRequested: true,
    },
  });
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
  expect(JSON.stringify(result.snapshot())).not.toContain('PRIVATE_');
});

it('keeps the request gated and observes both direct-child cleanups when the debugger never arms', async () => {
  const debuggerProcess = debuggerProbeChild();
  let debuggerSpawned = false;
  debuggerProcess.child.arm = () => {
    setImmediate(() => {
      debuggerSpawned = true;
      debuggerProcess.io.emit('spawn');
      debuggerProcess.io.stdout.write(EffectString.repeat(8192)('PRIVATE_DEBUGGER_OUTPUT'));
    });
  };
  let requestWrites = 0;
  const fake = embeddingProbeChild(() => requestWrites++);
  let targetSpawned = false;
  const processes = new FixtureProcesses((command, args) => {
    expect(command).toBe('PRIVATE_CDB');
    expect(args[args.indexOf('-p') + 1]).toBe('42');
    debuggerProcess.child.arm();
    return debuggerProcess.child;
  });
  const result = await runFixtureEmbeddingExitProbe(
    processes,
    'PRIVATE_EXECUTABLE',
    {...probeRequest, inputs: ['short']},
    {
      cwd: 'PRIVATE_PATH',
      env: {},
      deadline: performance.now() + 1000,
      maxOutputBytes: 4096,
      spawn: () => {
        targetSpawned = true;
        return fake.child;
      },
      apiControl: {
        command: [process.execPath, 'PRIVATE_SCRIPT'],
        bunVersion: Bun.version,
        debuggerRequired: true,
        debuggerExecutable: 'PRIVATE_CDB',
        debuggerStartupFile: 'PRIVATE_STARTUP_FILE',
        debuggerEnvironment: {PATH: 'PRIVATE_PATH'},
      },
    },
  );
  expect(targetSpawned).toBe(true);
  expect(debuggerSpawned).toBe(true);
  expect(requestWrites).toBe(0);
  expect(fake.kills).toBe(1);
  expect(debuggerProcess.kills).toBe(1);
  expect(result.snapshot()).toMatchObject({
    outcome: 'output-overflow',
    write: 'pending',
    cleanupRequested: true,
    exitOrigin: 'cleanup',
    processClosed: true,
    stdoutRead: 'eof',
    stderrRead: 'eof',
    firstFault: 'output-overflow',
    debugger: {kind: 'cdb-arm64', armed: false, exited: true, closed: true},
  });
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
});

it('cleans up a live target when CDB exits before arming without awaiting stdin close', async () => {
  const debuggerProcess = debuggerProbeChild();
  let debuggerSpawned = false;
  debuggerProcess.child.arm = () => {
    setImmediate(() => {
      debuggerSpawned = true;
      debuggerProcess.io.emit('spawn');
      debuggerProcess.child.finish(1);
    });
  };
  let requestWrites = 0;
  const fake = embeddingProbeChild(() => requestWrites++);
  fake.onEnd = () => new Promise<void>(() => {});
  const processes = new FixtureProcesses((command, args) => {
    expect(command).toBe('PRIVATE_CDB');
    expect(args[args.indexOf('-p') + 1]).toBe('42');
    debuggerProcess.child.arm();
    return debuggerProcess.child;
  });
  const result = await runFixtureEmbeddingExitProbe(
    processes,
    'PRIVATE_EXECUTABLE',
    {...probeRequest, inputs: ['short']},
    {
      cwd: 'PRIVATE_PATH',
      env: {},
      deadline: performance.now() + 1000,
      maxOutputBytes: 4096,
      spawn: () => fake.child,
      apiControl: {
        command: [process.execPath, 'PRIVATE_SCRIPT'],
        bunVersion: Bun.version,
        debuggerRequired: true,
        debuggerExecutable: 'PRIVATE_CDB',
        debuggerStartupFile: 'PRIVATE_STARTUP_FILE',
        debuggerEnvironment: {PATH: 'PRIVATE_PATH'},
      },
    },
  );
  expect(debuggerSpawned).toBe(true);
  expect(requestWrites).toBe(0);
  expect(fake.kills).toBe(1);
  expect(debuggerProcess.kills).toBe(0);
  expect(result.snapshot()).toMatchObject({
    outcome: 'debugger-unavailable',
    firstFault: 'debugger',
    write: 'pending',
    cleanupRequested: true,
    exitOrigin: 'cleanup',
    processClosed: true,
    stdoutRead: 'eof',
    stderrRead: 'eof',
    debugger: {kind: 'cdb-arm64', armed: false, exited: true, exitCode: 1, closed: true},
  });
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
});

it('records the exact CDB quit marker even when fail-fast capture is incomplete', async () => {
  const debuggerProcess = debuggerProbeChild();
  const native = windowsExitFixture();
  debuggerProcess.child.arm = () => {
    setImmediate(() => {
      debuggerProcess.io.emit('spawn');
      debuggerProcess.io.stdout.write('THREADNOTE_NATIVE_CDB_ARMED\n');
    });
  };
  const fake = embeddingProbeChild(
    () => {
      debuggerProcess.io.stdout.write(
        'ExceptionCode: c0000409 (FAIL_FAST_EXCEPTION)\nTHREADNOTE_NATIVE_CDB_QUIT_REQUESTED\n',
      );
      fake.exit(0);
    },
    () => debuggerProcess.child.finish(0),
  );
  const processes = new FixtureProcesses(() => {
    debuggerProcess.child.arm();
    return debuggerProcess.child;
  });
  const result = await runFixtureEmbeddingExitProbe(
    processes,
    'PRIVATE_EXECUTABLE',
    {...probeRequest, inputs: ['short']},
    {
      cwd: 'PRIVATE_PATH',
      env: {},
      deadline: performance.now() + 1000,
      maxOutputBytes: 4096,
      spawn: () => fake.child,
      nativeExit: native.observer,
      apiControl: {
        command: [process.execPath, 'PRIVATE_SCRIPT'],
        bunVersion: Bun.version,
        debuggerRequired: true,
        debuggerExecutable: 'PRIVATE_CDB',
        debuggerStartupFile: 'PRIVATE_STARTUP_FILE',
        debuggerEnvironment: {PATH: 'PRIVATE_PATH'},
      },
    },
  );
  native.observer.close();
  expect(result.snapshot()).toMatchObject({
    outcome: 'exit',
    exitOrigin: 'debugger-requested',
    rawExitCodeOrigin: 'after-debugger-q',
    debugger: {
      kind: 'cdb-arm64',
      armed: true,
      exited: true,
      closed: true,
      exceptionCode: 'c0000409',
      captureComplete: false,
      quitRequested: true,
    },
  });
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
});

it('keeps native exit attribution unknown when an incomplete debugger capture has no quit marker', async () => {
  const debuggerProcess = debuggerProbeChild();
  debuggerProcess.child.arm = () => {
    setImmediate(() => {
      debuggerProcess.io.emit('spawn');
      debuggerProcess.io.stdout.write('THREADNOTE_NATIVE_CDB_ARMED\n');
    });
  };
  const native = windowsExitFixture();
  const fake = embeddingProbeChild(
    () => {
      debuggerProcess.io.stdout.write('ExceptionCode: c0000409 (FAIL_FAST_EXCEPTION)\n');
      fake.exit(0xc0000409);
    },
    () => debuggerProcess.child.finish(1),
  );
  const processes = new FixtureProcesses(() => {
    debuggerProcess.child.arm();
    return debuggerProcess.child;
  });
  const result = await runFixtureEmbeddingExitProbe(
    processes,
    'PRIVATE_EXECUTABLE',
    {...probeRequest, inputs: ['short']},
    {
      cwd: 'PRIVATE_PATH',
      env: {},
      deadline: performance.now() + 1000,
      maxOutputBytes: 4096,
      spawn: () => fake.child,
      nativeExit: native.observer,
      apiControl: {
        command: [process.execPath, 'PRIVATE_SCRIPT'],
        bunVersion: Bun.version,
        debuggerRequired: true,
        debuggerExecutable: 'PRIVATE_CDB',
        debuggerStartupFile: 'PRIVATE_STARTUP_FILE',
        debuggerEnvironment: {PATH: 'PRIVATE_PATH'},
      },
    },
  );
  native.observer.close();
  expect(result.snapshot()).toMatchObject({
    outcome: 'exit',
    exitOrigin: 'unknown',
    rawExitCode: 0xc0000409,
    rawExitCodeOrigin: 'mediation-unknown',
    debugger: {
      kind: 'cdb-arm64',
      armed: true,
      exited: true,
      closed: true,
      exceptionCode: 'c0000409',
      captureComplete: false,
      quitRequested: false,
    },
  });
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
});

effectIt.effect('diagnostic setup guards preserve the original repair failure', () =>
  Effect.gen(function* () {
    const fixture = yield* probeSetupFixture;
    const processes = new FixtureProcesses();
    const remaining = vi.spyOn(processes, 'remaining').mockReturnValue(10000);
    const original = new Error('original repair failure');
    const observed = yield* captureConsole(
      Effect.fail(original).pipe(
        Effect.tapError(() => diagnoseFixtureEmbeddingFailure(processes, 'unused', fixture.options)),
        Effect.result,
      ),
    ).pipe(Effect.ensuring(Effect.sync(() => remaining.mockRestore())));
    expect(Result.isFailure(observed.value)).toBe(true);
    if (Result.isFailure(observed.value)) expect(observed.value.failure).toBe(original);
    expect(observed.output).toBe(
      'Standalone model worker probe: {"sample":"short-single-input-control","outcome":"setup-unavailable"}',
    );
    expect(processes.registry.seal()).toEqual([]);
  }).pipe(provideTestLayer(probeSetupLayer)),
);

effectIt.effect(
  'model setup uses only the remaining original deadline and preserves the repair failure on timeout',
  () =>
    Effect.gen(function* () {
      const fixture = yield* probeSetupFixture;
      const entered = yield* Deferred.make<void>();
      const processes = new FixtureProcesses();
      const remaining = vi.spyOn(processes, 'remaining').mockReturnValue(5);
      const blocked = FileSystem.FileSystem.of({
        ...fixture.fs,
        stat: file =>
          file === fixture.modelPath
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : fixture.fs.stat(file),
      });
      const original = new Error('original repair failure');
      const observed = yield* captureConsole(
        Effect.gen(function* () {
          const reader = yield* Effect.fail(original).pipe(
            Effect.tapError(() => diagnoseFixtureEmbeddingFailure(processes, 'unused', fixture.options)),
            Effect.result,
            Effect.forkScoped,
          );
          yield* Deferred.await(entered);
          yield* TestClock.adjust('4 millis');
          expect(reader.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust('1 millis');
          return yield* Fiber.join(reader);
        }),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, blocked),
        Effect.ensuring(Effect.sync(() => remaining.mockRestore())),
      );
      expect(Result.isFailure(observed.value)).toBe(true);
      if (Result.isFailure(observed.value)) expect(observed.value.failure).toBe(original);
      expect(observed.output).toBe(
        'Standalone model worker probe: {"sample":"short-single-input-control","outcome":"setup-unavailable"}',
      );
      expect(processes.registry.seal()).toEqual([]);
    }).pipe(provideTestLayer(probeSetupLayer)),
);

effectIt.effect('external interruption of setup is not swallowed as a diagnostic setup failure', () =>
  Effect.gen(function* () {
    const fixture = yield* probeSetupFixture;
    const entered = yield* Deferred.make<void>();
    const processes = new FixtureProcesses();
    const remaining = vi.spyOn(processes, 'remaining').mockReturnValue(10000);
    const blocked = FileSystem.FileSystem.of({
      ...fixture.fs,
      stat: file =>
        file === fixture.modelPath
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          : fixture.fs.stat(file),
    });
    const observed = yield* captureConsole(
      Effect.gen(function* () {
        const reader = yield* diagnoseFixtureEmbeddingFailure(processes, 'unused', fixture.options).pipe(
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(reader);
        return yield* Fiber.await(reader);
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, blocked),
      Effect.ensuring(Effect.sync(() => remaining.mockRestore())),
    );
    expect(Exit.isFailure(observed.value)).toBe(true);
    if (Exit.isFailure(observed.value)) expect(Cause.hasInterruptsOnly(observed.value.cause)).toBe(true);
    expect(observed.output).toBe('');
    expect(processes.registry.seal()).toEqual([]);
  }).pipe(provideTestLayer(probeSetupLayer)),
);

it('basic probe setup binds one reply and labels exit after requested stdin close', async () => {
  let spawns = 0;
  const fake = embeddingProbeChild(text => {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || !('id' in value)) throw new Error('Invalid test request');
    fake.io.stdout.end(
      `${JSON.stringify({
        id: value.id,
        protocol: 1,
        ok: true,
        result: EffectArray.map(probeRequest.inputs, () => new Array<number>(384).fill(0)),
      })}\n`,
    );
    fake.io.stderr.end();
  });
  fake.onEnd = () => fake.exit(0);
  const processes = new FixtureProcesses();
  const result = await runFixtureEmbeddingExitProbe(processes, 'PRIVATE_EXECUTABLE', probeRequest, {
    cwd: 'PRIVATE_PATH',
    env: {PRIVATE_ENV: 'PRIVATE_VALUE'},
    deadline: performance.now() + 1000,
    maxOutputBytes: 512 * 1024,
    spawn: () => {
      spawns++;
      return fake.child;
    },
  });
  expect(result.snapshot()).toMatchObject({
    outcome: 'reply',
    reply: 'valid',
    write: 'returned',
    flush: 'complete',
    exitOrigin: 'stdin-close-requested',
    exit: {exitCode: 0, signal: null},
    processClosed: true,
    cleanupRequested: false,
  });
  expect(spawns).toBe(1);
  expect(fake.kills).toBe(0);
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
  expect(JSON.stringify(result.snapshot())).not.toContain('PRIVATE_');
});

it('projects only complete closed API phase tags without retaining unknown native output', async () => {
  const fake = embeddingProbeChild(() => {
    fake.io.stderr.write('PRIVATE_NATIVE_OUTPUT\nTHREADNOTE_NATIVE_PHASE:model-load-st');
    fake.io.stderr.end('art\nTHREADNOTE_NATIVE_PHASE:PRIVATE_UNKNOWN_PHASE\n');
    fake.exit(9);
  });
  const processes = new FixtureProcesses();
  const result = await runFixtureEmbeddingExitProbe(processes, 'PRIVATE_EXECUTABLE', probeRequest, {
    cwd: 'PRIVATE_PATH',
    env: {},
    deadline: performance.now() + 1000,
    maxOutputBytes: 512 * 1024,
    apiControl: {command: [process.execPath, 'PRIVATE_SCRIPT'], bunVersion: Bun.version},
    spawn: () => fake.child,
  });
  expect(result.snapshot()).toMatchObject({
    outcome: 'exit',
    stdoutRead: 'eof',
    stderrRead: 'eof',
    processClosed: true,
    cleanupRequested: false,
    apiControl: {
      kind: 'direct-model-load',
      runtime: 'source-bun',
      bunVersion: Bun.version,
      phases: ['model-load-start'],
    },
  });
  expect(result.snapshot().stderrBytes).toBeGreaterThan(0);
  expect(JSON.stringify(result.snapshot())).not.toContain('PRIVATE_');
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
});

it('holds stdin open after EOF and retains independently observed natural exit and sink facts', async () => {
  const sent = Promise.withResolvers<void>();
  const native = windowsExitFixture();
  const fake = embeddingProbeChild(() => {
    native.calls.push('write');
    fake.io.stdout.end();
    fake.io.stderr.end();
    sent.resolve();
  });
  fake.writeBytes = 65_536;
  const processes = new FixtureProcesses();
  const pending = runFixtureEmbeddingExitProbe(processes, 'PRIVATE_EXECUTABLE', probeRequest, {
    cwd: 'PRIVATE_PATH',
    env: {},
    deadline: performance.now() + 1000,
    maxOutputBytes: 512 * 1024,
    spawn: () => fake.child,
    nativeExit: native.observer,
  });
  await sent.promise;
  await Promise.resolve();
  expect(fake.ends).toBe(0);
  expect(fake.kills).toBe(0);
  fake.exit(9);
  const result = await pending;
  native.observer.close();
  native.observer.close();
  expect(result.snapshot()).toMatchObject({
    outcome: 'exit',
    firstFault: 'stdout-eof',
    reply: 'none',
    write: 'returned',
    writeBytes: 65_536,
    flush: 'complete',
    flushBytes: 0,
    stdoutRead: 'eof',
    stderrRead: 'eof',
    exitOrigin: 'natural',
    exit: {exitCode: 9, signal: null},
    rawExitCode: 0xc0000409,
    processClosed: true,
    cleanupRequested: false,
  });
  expect(result.snapshot().requestBytes).toBeGreaterThan(65_536);
  expect(native.calls).toEqual(['open', 'write', 'query', 'handle-close', 'library-close']);
  expect(native.library.symbols.OpenProcess).toHaveBeenCalledWith(0x1000, 0, 42);
  expect(native.observer.read()).toBeUndefined();
  expect(JSON.stringify(result.snapshot())).not.toContain('fedcba');
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
});

it('joins stderr delivered after natural exit before marking the probe closed', async () => {
  const stopped = Promise.withResolvers<number>();
  const fake = embeddingProbeChild(() => {});
  const processes = new FixtureProcesses();
  let completed = false;
  const pending = runFixtureEmbeddingExitProbe(processes, 'PRIVATE_EXECUTABLE', probeRequest, {
    cwd: 'PRIVATE_PATH',
    env: {},
    deadline: performance.now() + 1000,
    maxOutputBytes: 512 * 1024,
    spawn: () => ({...fake.child, exited: stopped.promise}),
  }).then(result => {
    completed = true;
    return result;
  });
  fake.io.stdout.end();
  stopped.resolve(9);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(completed).toBe(false);
  expect(fake.ends).toBe(0);
  expect(fake.kills).toBe(0);
  const delayed = 'PRIVATE_DELAYED_STDERR';
  fake.io.stderr.end(delayed);
  const result = await pending;
  expect(result.snapshot()).toMatchObject({
    outcome: 'exit',
    firstFault: 'stdout-eof',
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(delayed),
    stdoutRead: 'eof',
    stderrRead: 'eof',
    exitOrigin: 'natural',
    exit: {exitCode: 9, signal: null},
    processClosed: true,
    cleanupRequested: false,
  });
  expect(fake.kills).toBe(0);
  expect(JSON.stringify(result.snapshot())).not.toContain('PRIVATE_');
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
});

it('retains a later stderr read failure independently of the first stdout EOF fault', async () => {
  const stopped = Promise.withResolvers<number>();
  const fake = embeddingProbeChild(() => {});
  const processes = new FixtureProcesses();
  const pending = runFixtureEmbeddingExitProbe(processes, 'PRIVATE_EXECUTABLE', probeRequest, {
    cwd: 'PRIVATE_PATH',
    env: {},
    deadline: performance.now() + 1000,
    maxOutputBytes: 512 * 1024,
    spawn: () => ({...fake.child, exited: stopped.promise}),
  });
  fake.io.stdout.end();
  stopped.resolve(9);
  await new Promise<void>(resolve => setImmediate(resolve));
  fake.io.stderr.destroy(new Error('PRIVATE_STDERR_READ_FAILURE'));
  const result = await pending;
  expect(result.snapshot()).toMatchObject({
    outcome: 'exit',
    firstFault: 'stdout-eof',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutRead: 'eof',
    stderrRead: 'failed',
    exitOrigin: 'natural',
    exit: {exitCode: 9, signal: null},
    processClosed: true,
    cleanupRequested: false,
  });
  expect(fake.kills).toBe(0);
  expect(JSON.stringify(result.snapshot())).not.toContain('PRIVATE_');
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
});

it('keeps deadline cleanup exit separate from natural exit after EOF', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
  try {
    const native = windowsExitFixture();
    const fake = embeddingProbeChild(() => {
      fake.io.stdout.end();
      fake.io.stderr.end();
    });
    const processes = new FixtureProcesses();
    const pending = runFixtureEmbeddingExitProbe(processes, 'PRIVATE_EXECUTABLE', probeRequest, {
      cwd: 'PRIVATE_PATH',
      env: {},
      deadline: performance.now() + 10,
      maxOutputBytes: 512 * 1024,
      spawn: () => fake.child,
      nativeExit: native.observer,
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    native.observer.close();
    expect(await processes.closeAndObserve(performance.now() + 100)).toBe('exited');
    expect(result.snapshot()).toMatchObject({
      outcome: 'deadline',
      firstFault: 'stdout-eof',
      cleanupRequested: true,
      exitOrigin: 'cleanup',
      exit: {exitCode: 137, signal: 'SIGKILL'},
      processClosed: true,
    });
    expect(fake.kills).toBe(1);
    expect(result.snapshot().rawExitCode).toBeUndefined();
    expect(native.calls).toEqual(['open', 'handle-close', 'library-close']);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps unavailable native observations unknown and closes the library despite handle-close failure', () => {
  const sensitive = 'PRIVATE_NATIVE_ERROR_HANDLE_ENV_PATH';
  expect(
    createFixtureWindowsExitObserver(() => {
      throw new Error(sensitive);
    }),
  ).toBeUndefined();
  const native = windowsExitFixture();
  native.library.symbols.GetExitCodeProcess.mockImplementation(() => {
    throw new Error(sensitive);
  });
  native.library.symbols.CloseHandle.mockImplementation(() => {
    throw new Error(sensitive);
  });
  native.observer.pin(42);
  expect(native.observer.read()).toBeUndefined();
  expect(native.observer.read()).toBeUndefined();
  expect(() => native.observer.close()).not.toThrow();
  native.observer.close();
  native.observer.pin(42);
  expect(native.observer.read()).toBeUndefined();
  expect(native.library.symbols.OpenProcess).toHaveBeenCalledTimes(1);
  expect(native.library.symbols.GetExitCodeProcess).toHaveBeenCalledTimes(1);
  expect(native.library.symbols.CloseHandle).toHaveBeenCalledTimes(1);
  expect(native.library.close).toHaveBeenCalledTimes(1);
});

it('closes an unused native library without querying or closing a missing handle', () => {
  const native = windowsExitFixture();
  native.library.symbols.OpenProcess.mockReturnValue(0n);
  native.observer.pin(42);
  expect(native.observer.read()).toBeUndefined();
  native.observer.close();
  expect(native.calls).toEqual(['library-close']);
  expect(native.library.symbols.OpenProcess).toHaveBeenCalledWith(0x1000, 0, 42);
  expect(native.library.symbols.CloseHandle).not.toHaveBeenCalled();
});

it('bounds probe output, preserves privacy and confirms the registered producer after cleanup', async () => {
  const fake = embeddingProbeChild(() => fake.io.stdout.write(EffectString.repeat(40_000)('PRIVATE_OUTPUT')));
  const processes = new FixtureProcesses();
  const result = await runFixtureEmbeddingExitProbe(processes, 'PRIVATE_EXECUTABLE', probeRequest, {
    cwd: 'PRIVATE_PATH',
    env: {},
    deadline: performance.now() + 1000,
    maxOutputBytes: 512 * 1024,
    spawn: () => fake.child,
  });
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
  expect(result.snapshot()).toMatchObject({
    outcome: 'output-overflow',
    firstFault: 'output-overflow',
    stdoutBytes: 512 * 1024 + 1,
    cleanupRequested: true,
    exitOrigin: 'cleanup',
    processClosed: true,
  });
  expect(JSON.stringify(result.snapshot())).not.toContain('PRIVATE_');
});

function commandFailureDetails(outcome: unknown): unknown {
  if (!(outcome instanceof Error)) throw new Error('Expected a fixture command failure.');
  const prefix = 'Fixture command failed or output exceeded limit: ';
  expect(EffectString.startsWith(prefix)(outcome.message)).toBe(true);
  return JSON.parse(EffectString.slice(prefix.length)(outcome.message));
}

it.each(['nonzero-exit', 'missing-exit-code', 'signal', 'child-error', 'spawn-error', 'output-overflow'] as const)(
  'reports %s only after the owned command closes',
  async scenario => {
    const reason = scenario === 'spawn-error' ? 'child-error' : scenario;
    const stage =
      scenario === 'nonzero-exit' || scenario === 'signal' || scenario === 'output-overflow' ? 'repair' : 'recall';
    const child = commandChild();
    const processes = new FixtureProcesses(() => child);
    let settled = false;
    const command = runFixtureCommand(processes, 'PRIVATE_COMMAND', ['PRIVATE_ARGUMENT'], {
      stage,
      cwd: 'PRIVATE_PATH',
      env: {PRIVATE_ENV: 'PRIVATE_VALUE'},
      deadline: performance.now() + 1000,
      maxOutputBytes: 4,
    })
      .catch((cause: unknown) => cause)
      .finally(() => {
        settled = true;
      });
    if (scenario !== 'spawn-error') child.emit('spawn');
    child.stdout.write('out');
    if (reason === 'output-overflow') child.stderr.write('PRIVATE_OUTPUT');
    if (reason === 'child-error') child.emit('error', new Error('PRIVATE_ERROR'));
    if (reason !== 'missing-exit-code')
      child.emit('exit', reason === 'nonzero-exit' ? 7 : 0, reason === 'signal' ? 'SIGTERM' : null);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close');
    const details = commandFailureDetails(await command);
    expect(details).toEqual({
      stage,
      observed: 'owned-close',
      reason,
      spawned: scenario !== 'spawn-error',
      exited: reason !== 'missing-exit-code',
      childError: reason === 'child-error',
      exitCode: reason === 'missing-exit-code' ? null : reason === 'nonzero-exit' ? 7 : 0,
      signal: reason === 'signal' ? 'SIGTERM' : null,
      stdoutBytes: 3,
      stderrBytes: reason === 'output-overflow' ? 5 : 0,
      totalBytes: reason === 'output-overflow' ? 5 : 3,
      maxOutputBytes: 4,
      overflow: reason === 'output-overflow',
      ...(reason === 'nonzero-exit' ? {repair: {milestones: [], errorCategories: ['unknown']}} : {}),
    });
    expect(JSON.stringify(details)).not.toContain('PRIVATE_');
  },
);

it.each(['recognized', 'unknown'] as const)('reports only closed repair markers for %s output', async scenario => {
  const child = commandChild();
  const processes = new FixtureProcesses(() => child);
  let settled = false;
  const command = runFixtureCommand(processes, 'PRIVATE_COMMAND', ['PRIVATE_ARGUMENT'], {
    stage: 'repair',
    cwd: 'PRIVATE_PATH',
    env: {PRIVATE_ENV: 'PRIVATE_VALUE'},
    deadline: performance.now() + 1000,
    maxOutputBytes: 1024,
  })
    .catch((cause: unknown) => cause)
    .finally(() => {
      settled = true;
    });
  child.emit('spawn');
  child.stdout.write(
    scenario === 'recognized'
      ? 'Repairing the self-contained Threadnote home.\nPreparing lexical recall from canonical documents.\n' +
          'Lexical recall prepared: 1 canonical document(s).\nEmbedding 1 canonical document(s) with PRIVATE_MODEL.\nPRIVATE_BODY'
      : 'PRIVATE_BODY ModelLoadFailed_PRIVATE',
  );
  child.stderr.write(
    scenario === 'recognized'
      ? 'Recall index repair failed: ModelLoadFailed PRIVATE_ERROR PRIVATE_PATH PRIVATE_TOKEN'
      : 'PRIVATE_ERROR ModelLoadFailed_PRIVATE',
  );
  child.emit('exit', 7, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit('close');
  const details = commandFailureDetails(await command);
  expect(details).toMatchObject({
    stage: 'repair',
    observed: 'owned-close',
    reason: 'nonzero-exit',
    exitCode: 7,
    overflow: false,
    repair: {
      milestones:
        scenario === 'recognized' ? ['started', 'lexical-started', 'lexical-prepared', 'embedding-started'] : [],
      errorCategories: scenario === 'recognized' ? ['recall-index', 'model-load'] : ['unknown'],
    },
  });
  expect(JSON.stringify(details)).not.toContain('PRIVATE_');
  expect(JSON.stringify(details).length).toBeLessThan(700);
});

it('preserves deadline failure without claiming an observed close', async () => {
  const child = commandChild();
  const processes = new FixtureProcesses(() => child);
  const command = runFixtureCommand(processes, 'fixture', [], {
    stage: 'version',
    cwd: '.',
    env: {},
    deadline: performance.now() + 5,
    maxOutputBytes: 4,
  });
  child.emit('spawn');
  child.emit('exit', 0, null);
  await expect(command).rejects.toThrow('Fixture deadline expired');
});

it.each([
  [
    {
      errorType: 'EmbeddingFailed',
      domain: 'model-worker',
      operation: 'embed-many',
      reason: 'exit',
      exitObservation: {stage: 'process-exit', exitCode: 3221225477, signal: 'SIGABRT', stderr: 'PRIVATE_STDERR'},
    },
    {
      errorType: 'EmbeddingFailed',
      domain: 'model-worker',
      operation: 'embed-many',
      reason: 'exit',
      exitObservation: {stage: 'process-exit', exitCode: 3221225477, signal: 'SIGABRT'},
    },
  ],
  [
    {
      errorType: 'EmbeddingFailed',
      domain: 'model-worker',
      operation: 'embed-many',
      reason: 'exit',
      exitObservation: {stage: 'PRIVATE_STAGE', exitCode: 4294967296, signal: 'PRIVATE_SIGNAL'},
    },
    {errorType: 'EmbeddingFailed', domain: 'model-worker', operation: 'embed-many', reason: 'exit'},
  ],
  [{errorType: 'ModelLoadFailed', message: 'PRIVATE_MESSAGE', path: 'PRIVATE_PATH'}, {errorType: 'ModelLoadFailed'}],
  [
    {
      errorType: 'EmbeddingFailed',
      domain: 'model-worker',
      operation: 'embed-many',
      reason: 'crash',
      stack: 'PRIVATE_STACK',
    },
    {errorType: 'EmbeddingFailed', domain: 'model-worker', operation: 'embed-many', reason: 'crash'},
  ],
  [
    {
      errorType: 'SqlError',
      sqlReason: 'LockTimeoutError',
      sqliteCode: 'SQLITE_BUSY',
      sql: 'PRIVATE_SQL',
      body: 'PRIVATE_BODY',
    },
    {errorType: 'SqlError', sqlReason: 'LockTimeoutError', sqliteCode: 'SQLITE_BUSY'},
  ],
  [
    {errorType: 'SqlError', sqlReason: 'PRIVATE_REASON', sqliteCode: 'SQLITE_BUSY_PRIVATE', token: 'PRIVATE_TOKEN'},
    {errorType: 'SqlError', sqlReason: 'UnknownError'},
  ],
  [
    {errorType: 'PRIVATE_TYPE', domain: 'model-worker', operation: 'PRIVATE_OPERATION', reason: 'PRIVATE_REASON'},
    {errorType: 'UnknownError'},
  ],
] as const)('retains only the exact closed repair failure fields for %j', async (input, expected) => {
  const child = commandChild();
  const processes = new FixtureProcesses(() => child);
  const command = runFixtureCommand(processes, 'PRIVATE_COMMAND', ['PRIVATE_ARGUMENT'], {
    stage: 'repair',
    cwd: 'PRIVATE_PATH',
    env: {PRIVATE_ENV: 'PRIVATE_VALUE'},
    deadline: performance.now() + 1000,
    maxOutputBytes: 1024,
  }).catch((cause: unknown) => cause);
  child.emit('spawn');
  child.stderr.write(
    `Recall repair failure diagnostic: ${JSON.stringify(input)}\nRecall index repair failed: PRIVATE_ERROR\n`,
  );
  child.emit('exit', 7, null);
  child.emit('close');
  const details = commandFailureDetails(await command);
  expect(details).toMatchObject({
    stage: 'repair',
    observed: 'owned-close',
    reason: 'nonzero-exit',
    exitCode: 7,
    overflow: false,
    repair: {typedFailure: expected},
  });
  expect(JSON.stringify(details)).not.toContain('PRIVATE_');
});

it('keeps command acceptance and private failure projection invariant under output chunking', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({min: 0, max: 128}),
      fc.integer({min: 0, max: 128}),
      fc.integer({min: 1, max: 128}),
      fc.integer({min: 1, max: 32}),
      fc.integer({min: 0, max: 3}),
      fc.constantFrom(null, 'SIGTERM', 'PRIVATE_SIGNAL'),
      fc.boolean(),
      async (outBytes, errBytes, cap, width, code, signal, childError) => {
        const capture = async (chunkWidth: number) => {
          const child = commandChild();
          const processes = new FixtureProcesses(() => child);
          const options = {
            stage: 'recall' as const,
            cwd: 'PRIVATE_PATH',
            env: {PRIVATE_ENV: 'PRIVATE_VALUE'},
            deadline: performance.now() + 1000,
            maxOutputBytes: cap,
          };
          // Runtime callers cannot turn the stage identifier into an arbitrary payload.
          Reflect.set(options, 'stage', 'PRIVATE_STAGE');
          const command = runFixtureCommand(processes, 'PRIVATE_COMMAND', ['PRIVATE_ARGUMENT'], options).catch(
            (cause: unknown) => cause,
          );
          child.emit('spawn');
          for (const [stream, count, character] of [
            [child.stdout, outBytes, 'x'],
            [child.stderr, errBytes, 'y'],
          ] as const) {
            for (let emitted = 0; emitted < count; emitted += chunkWidth)
              stream.write(EffectString.repeat(Math.min(chunkWidth, count - emitted))(character));
          }
          if (childError) child.emit('error', new Error('PRIVATE_ERROR'));
          child.emit('exit', code, signal);
          child.emit('close');
          const outcome = await command;
          if (outBytes + errBytes <= cap && code === 0 && signal === null && !childError) {
            expect(outcome).toEqual({
              stdout: EffectString.repeat(outBytes)('x'),
              stderr: EffectString.repeat(errBytes)('y'),
            });
            return outcome;
          }
          const details = commandFailureDetails(outcome);
          expect(details).toMatchObject({
            stage: 'unspecified',
            observed: 'owned-close',
            stdoutBytes: Math.min(outBytes, cap + 1),
            stderrBytes: Math.min(errBytes, cap + 1),
            totalBytes: Math.min(outBytes + errBytes, cap + 1),
            maxOutputBytes: cap,
            overflow: outBytes + errBytes > cap,
            signal: signal === 'PRIVATE_SIGNAL' ? 'other' : signal,
          });
          expect(JSON.stringify(details)).not.toContain('PRIVATE_');
          return details;
        };
        expect(await capture(width)).toEqual(await capture(256));
      },
    ),
    {
      numRuns: 24,
      examples: [
        [2, 2, 4, 1, 0, null, false],
        [2, 3, 4, 1, 0, null, false],
      ],
    },
  );
});

it('requests EOF and waits for the owned MCP child exit and close', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: () => {},
    kill: () => {
      throw new Error('must not signal');
    },
  });
  const processes = new FixtureProcesses(() => child);
  const transport = new FixtureStdioTransport(processes, {
    command: 'fixture',
    args: [],
    cwd: '.',
    env: {},
    deadline: performance.now() + 1000,
  });
  const started = transport.start();
  child.emit('spawn');
  await started;
  let closed = false;
  const close = transport.close().then(() => {
    closed = true;
  });
  expect(child.stdin.writableEnded).toBe(true);
  child.emit('exit', 0, null);
  await Promise.resolve();
  expect(closed).toBe(false);
  child.emit('close', 0, null);
  await close;
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
});

it('does not accept a close without observed exit', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: () => {},
    kill: () => {
      throw new Error('must not signal');
    },
  });
  const processes = new FixtureProcesses(() => child);
  const transport = new FixtureStdioTransport(processes, {
    command: 'fixture',
    args: [],
    cwd: '.',
    env: {},
    deadline: performance.now() + 1000,
  });
  const started = transport.start();
  child.emit('spawn');
  await started;
  const close = transport.close();
  child.emit('close', null, null);
  await expect(close).rejects.toThrow('did not exit cleanly');
  expect(await processes.closeAndObserve(performance.now() + 5)).toBe('unknown');
});

it('does not launch a new producer after either original clock budget expires', async () => {
  let launches = 0;
  const launch = () => {
    launches++;
    throw new Error('unexpected launch');
  };
  for (const [epoch, monotonic] of [
    [Date.now() - 1, performance.now() + 1000],
    [Date.now() + 1000, performance.now() - 1],
  ]) {
    const processes = new FixtureProcesses(launch, epoch, monotonic);
    const transport = new FixtureStdioTransport(processes, {
      command: 'fixture',
      args: [],
      cwd: '.',
      env: {},
      deadline: monotonic,
    });
    await expect(transport.start()).rejects.toThrow('deadline');
  }
  expect(launches).toBe(0);
});

it('a wall clock rollback cannot extend the original monotonic deadline', () => {
  const epoch = Date.now();
  const monotonic = performance.now();
  const processes = new FixtureProcesses(undefined, epoch + 1000, monotonic + 1000);
  const wallClock = vi.spyOn(Date, 'now').mockReturnValue(epoch - 60_000);
  try {
    expect(processes.remaining(monotonic + 1000)).toBeLessThanOrEqual(1000);
    wallClock.mockReturnValue(epoch + 2000);
    expect(processes.remaining(monotonic + 1000)).toBeLessThanOrEqual(0);
  } finally {
    wallClock.mockRestore();
  }
});

it('rejects an operation that completes after its original deadline before a timer fires', async () => {
  let remaining = 10;
  const operation = Promise.resolve().then(() => {
    remaining = 0;
  });
  await expect(fixtureDeadline(() => remaining, operation)).rejects.toThrow('deadline');
});

it('preserves a child operation failure when it wins the deadline race', async () => {
  const original = new Error('child failed');
  await expect(fixtureDeadline(() => 10, Promise.reject(original))).rejects.toBe(original);
});

it.each([7, 'SIGTERM'] as const)('records both endpoint exits before reporting failed producer %s', failure => {
  const processes = new FixtureProcesses();
  const outcomes = reconcileFixturePipelineReceipts([
    {
      role: 'producer',
      token: 'producer-secret',
      text: JSON.stringify({
        version: 1,
        token: 'producer-secret',
        code: typeof failure === 'number' ? failure : null,
        signal: typeof failure === 'string' ? failure : null,
      }),
      observation: processes.registry.register(),
    },
    {
      role: 'consumer',
      token: 'consumer-secret',
      text: JSON.stringify({version: 1, token: 'consumer-secret', code: 0, signal: null}),
      observation: processes.registry.register(),
    },
  ]);
  expect(outcomes).toEqual([
    {
      role: 'producer',
      state: 'exited',
      exitCode: typeof failure === 'number' ? failure : null,
      signal: typeof failure === 'string' ? failure : null,
    },
    {role: 'consumer', state: 'exited', exitCode: 0, signal: null},
  ]);
  expect(EffectArray.every(processes.registry.seal(), result => result.state === 'exited')).toBe(true);
  expect(JSON.stringify(outcomes)).not.toContain('secret');
});

it.each([undefined, '{', JSON.stringify({version: 1, token: 'foreign-secret', code: 0, signal: null})])(
  'retains unknown endpoint proof without skipping the later valid receipt',
  text => {
    const processes = new FixtureProcesses();
    const outcomes = reconcileFixturePipelineReceipts([
      {role: 'producer', token: 'producer-secret', text, observation: processes.registry.register()},
      {
        role: 'consumer',
        token: 'consumer-secret',
        text: JSON.stringify({version: 1, token: 'consumer-secret', code: 0, signal: null}),
        observation: processes.registry.register(),
      },
    ]);
    expect(EffectArray.map(outcomes, outcome => outcome.state)).toEqual(['unknown', 'exited']);
    expect(EffectArray.map(processes.registry.seal(), outcome => outcome.state)).toEqual(['unknown', 'exited']);
    expect(JSON.stringify(outcomes)).not.toContain('secret');
  },
);

effectIt.effect('preserves the original shell failure together with endpoint failure after reconciliation', () =>
  Effect.gen(function* () {
    const original = new Error('Owned shell failed');
    const endpointFailure = new Error('Endpoint failed');
    const processes = new FixtureProcesses();
    const outcome = yield* Effect.fail(original).pipe(
      Effect.onExit(() =>
        Effect.gen(function* () {
          const results = reconcileFixturePipelineReceipts([
            {
              role: 'producer',
              token: 'p',
              text: JSON.stringify({version: 1, token: 'p', code: 7, signal: null}),
              observation: processes.registry.register(),
            },
            {
              role: 'consumer',
              token: 'c',
              text: JSON.stringify({version: 1, token: 'c', code: 0, signal: null}),
              observation: processes.registry.register(),
            },
          ]);
          expect(results[1].state).toBe('exited');
          return yield* Effect.fail(endpointFailure);
        }),
      ),
      Effect.exit,
    );
    expect(outcome._tag).toBe('Failure');
    if (outcome._tag === 'Failure')
      expect(
        EffectArray.map(outcome.cause.reasons, reason => (reason._tag === 'Fail' ? reason.error : undefined)),
      ).toEqual([original, endpointFailure]);
  }),
);

it('endpoint receipts cannot supply missing parent-shell exit proof', () => {
  const processes = new FixtureProcesses();
  processes.registry.register();
  const outcomes = reconcileFixturePipelineReceipts(
    EffectArray.map(['producer', 'consumer'] as const, role => ({
      role,
      token: role,
      text: JSON.stringify({version: 1, token: role, code: 0, signal: null}),
      observation: processes.registry.register(),
    })),
  );
  expect(EffectArray.map(outcomes, outcome => outcome.state)).toEqual(['exited', 'exited']);
  expect(EffectArray.map(processes.registry.seal(), outcome => outcome.state)).toEqual(['unknown', 'exited', 'exited']);
});
