import {cryptoLayer} from '@threadnote/platform/crypto';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Context, Effect, FileSystem, Layer, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {describe, expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {CodeGraphParserPool, codeGraphParserPoolLayer, type ParserWorkerProcess} from '../../src/parser_worker.js';

const platformServicesLayer = Layer.merge(BunServices.layer, cryptoLayer);

const TestLayer = Layer.merge(
  platformServicesLayer,
  Layer.succeed(
    SystemInfo,
    SystemInfo.of({
      architecture: 'x64',
      availableDiskBytes: () => Effect.die('unexpected disk capacity query'),
      currentDirectory: () => process.cwd(),
      developmentEntrypoint: '/unused/threadnote.ts',
      environment: () => ({}),
      executablePath: process.execPath,
      hardwareInfo: Effect.die('explicit capacity must not query hardware'),
      homeDirectory: '/unused',
      intendedChildEnvironment: environment => environment,
      isProcessRunning: pid => pid === process.pid,
      memoryUsage: () => ({external: 0, heapUsed: 0, rss: 0}),
      pathDelimiter: process.platform === 'win32' ? ';' : ':',
      platform: process.platform,
      processArguments: process.argv,
      processId: process.pid,
      processStartIdentity: () => Effect.succeed('fixture-process-start'),
      readLine: () => () => undefined,
      runtimeVersion: Bun.version,
      setEnvironmentVariable: () => undefined,
      setExitCode: () => undefined,
      signalProcess: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      tempDirectory: '/tmp',
      userName: 'fixture',
    }),
  ),
);

describe('parser worker shutdown', () => {
  effectIt.layer(TestLayer)(it => {
    it.effect.each(['sync', 'async'] as const)('terminates a live worker when stdin close fails %s', mode =>
      checkShutdown([mode]),
    );

    it.effect('keeps successful stdin close and exit graceful', () => checkShutdown(['graceful']));

    fcEffectProp(
      it,
      'isolates shutdown failures across mixed owned workers',
      {modes: FC.array(FC.constantFrom<CloseMode>('sync', 'async', 'graceful'), {minLength: 1, maxLength: 4})},
      ({modes}) => checkShutdown(modes),
      {fastCheck: {numRuns: 16, seed: 20261101}},
    );
  });
});

type CloseMode = 'sync' | 'async' | 'graceful';

function checkShutdown(modes: readonly CloseMode[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'parser-worker-close-failure-'});
    yield* Effect.acquireUseRelease(
      Effect.sync(() => EffectArray.map(modes, mode => new ClosingWorker(mode))),
      workers =>
        Effect.gen(function* () {
          let nextWorker = 0;
          const poolLayer = codeGraphParserPoolLayer({
            capacity: workers.length,
            spawnWorker: () => {
              const worker = workers[nextWorker++];
              if (worker === undefined) throw new Error('unexpected parser worker spawn');
              return worker;
            },
          }).pipe(Layer.provide(TestLayer));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(poolLayer);
              const pool = Context.get(context, CodeGraphParserPool);
              yield* pool.warm(home, workers.length);
              expect(nextWorker).toBe(workers.length);
              expect(EffectArray.map(workers, worker => worker.closeInputCalls)).toEqual(
                EffectArray.map(modes, () => 0),
              );
              expect(EffectArray.map(workers, worker => worker.killCalls)).toEqual(EffectArray.map(modes, () => 0));
            }),
          );
          expect(nextWorker).toBe(workers.length);
          expect(EffectArray.map(workers, worker => worker.closeInputCalls)).toEqual(EffectArray.map(modes, () => 1));
          expect(EffectArray.map(workers, worker => worker.killCalls)).toEqual(
            EffectArray.map(modes, mode => (mode === 'graceful' ? 0 : 1)),
          );
          expect(yield* Effect.promise(() => Promise.all(EffectArray.map(workers, worker => worker.exited)))).toEqual(
            EffectArray.map(modes, mode => (mode === 'graceful' ? 0 : 137)),
          );
        }),
      workers =>
        Effect.sync(() => {
          for (const worker of workers) worker.kill();
        }),
    );
  }).pipe(TestClock.withLive);
}

const requestSchema = Schema.Struct({
  file: Schema.Struct({path: Schema.String}),
  id: Schema.String,
  protocol: Schema.Finite,
});

class ClosingWorker implements ParserWorkerProcess {
  readonly stdout = new Feed();
  readonly stderr = new Feed();
  private readonly exit = Promise.withResolvers<number>();
  readonly exited = this.exit.promise;
  closeInputCalls = 0;
  killCalls = 0;
  private stopped = false;

  constructor(private readonly mode: CloseMode) {}

  closeInput(): Promise<void> | void {
    this.closeInputCalls += 1;
    if (this.mode === 'graceful') {
      this.finish(0);
      return;
    }
    const failure = new Error('synthetic stdin close failure');
    if (this.mode === 'sync') throw failure;
    return Promise.reject(failure);
  }

  kill(): void {
    if (this.stopped) return;
    this.killCalls += 1;
    this.finish(137);
  }

  private finish(code: number): void {
    this.stopped = true;
    this.stdout.end();
    this.stderr.end();
    this.exit.resolve(code);
  }

  write(line: string): void {
    const request = Schema.decodeUnknownSync(requestSchema)(JSON.parse(line));
    this.stdout.push(
      `${JSON.stringify({
        degraded: false,
        facts: {diagnostics: [], edges: [], path: request.file.path, symbols: []},
        id: request.id,
        ok: true,
        parseMilliseconds: 1,
        protocol: request.protocol,
        recycle: false,
      })}\n`,
    );
  }
}

class Feed implements AsyncIterable<string> {
  private readonly queued: string[] = [];
  private readonly waiting: Array<(result: IteratorResult<string>) => void> = [];
  private ended = false;

  push(value: string): void {
    if (this.ended) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({done: false, value});
    else this.queued.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) waiter({done: true, value: undefined});
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const value = this.queued.shift();
        if (value !== undefined) return Promise.resolve({done: false, value});
        if (this.ended) return Promise.resolve({done: true, value: undefined});
        return new Promise(resolve => this.waiting.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({done: true, value: undefined});
      },
    };
  }
}
