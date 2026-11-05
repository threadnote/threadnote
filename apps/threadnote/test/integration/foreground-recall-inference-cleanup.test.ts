import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Cause, Clock, Effect, Exit, Fiber, FileSystem, Layer, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {makeReadDeadline, isReadCleanupUnconfirmed} from '@threadnote/platform/read_deadline';
import {SystemInfo} from '@threadnote/platform/system';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  isolatedLocalModelRuntimeLayer,
  type LocalModelWorkerProcess,
} from '../../src/effect/ai/isolated-local-model-runtime.js';
import {ReadyRecallReadDeadline, optionalReadyRecallRead} from '../../src/recall/ready_read_boundary.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const manifest = Option.getOrThrow(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, value => value.id === 'bge-small-en-v1.5-q8'),
);
const request = {inputs: ['PRIVATE_FOREGROUND_QUERY'], manifest, modelPath: '/unused/private-model.gguf'};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-foreground-recall-'});
  const script = path.join(home, 'native-model.ts');
  const pidFile = path.join(home, 'entered.pid');
  yield* fs.writeFileString(
    script,
    `import {Database} from 'bun:sqlite'; import {writeFileSync} from 'node:fs';
    process.stdin.once('data',()=>{const db=new Database(':memory:');db.function('entered',()=>{writeFileSync(${JSON.stringify(pidFile)},String(process.pid));return 1;});
    db.query('WITH RECURSIVE n(x) AS (SELECT entered() UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n').get();});`,
  );
  const flags = {stdinClosed: false, stdoutClosed: false, stderrClosed: false, spawns: 0};
  const observe = async function* (stream: AsyncIterable<Uint8Array>, kind: 'stdoutClosed' | 'stderrClosed') {
    try {
      for await (const chunk of stream) yield chunk;
    } finally {
      flags[kind] = true;
    }
  };
  const spawn = (delayExit = 0): LocalModelWorkerProcess => {
    flags.spawns++;
    const child = Bun.spawn({cmd: [system.executablePath, script], stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
    return {
      closeInput: async () => {
        await child.stdin.end();
        flags.stdinClosed = true;
      },
      exited: child.exited.then(code =>
        delayExit === 0 ? code : new Promise<number>(resolve => setTimeout(() => resolve(code), delayExit)),
      ),
      kill: () => {
        child.kill('SIGKILL');
      },
      stdout: observe(child.stdout, 'stdoutClosed'),
      stderr: observe(child.stderr, 'stderrClosed'),
      write: async line => {
        await child.stdin.write(line);
        await child.stdin.flush();
      },
    };
  };
  const waitEntered = Effect.gen(function* () {
    const end = (yield* Clock.currentTimeMillis) + 700;
    while ((yield* Clock.currentTimeMillis) < end) {
      if (yield* fs.exists(pidFile)) return Number(yield* fs.readFileString(pidFile));
      yield* Effect.sleep(10);
    }
    return yield* Effect.die('Actual foreground native query did not enter.');
  });
  return {system, flags, spawn, waitEntered};
});

describe('foreground recall inference owned cleanup', () => {
  effectIt.effect(
    'interruption waits for actual killed worker exit and all three pipes to close',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const services = yield* Layer.build(
          isolatedLocalModelRuntimeLayer({idleTimeoutMs: 0, spawnWorker: () => f.spawn()}),
        );
        const program = Effect.gen(function* () {
          const child = yield* (yield* LocalModelRuntime).embedMany(request).pipe(Effect.forkScoped);
          const pid = yield* f.waitEntered;
          yield* Fiber.interrupt(child);
          const exit = yield* Fiber.await(child);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(f.system.isProcessRunning(pid)).toBe(false);
          expect(f.flags).toMatchObject({stdinClosed: true, stdoutClosed: true, stderrClosed: true, spawns: 1});
        });
        yield* program.pipe(
          Effect.provide(services),
          Effect.provideService(ReadyRecallReadDeadline, yield* makeReadDeadline(2000)),
        );
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  effectIt.effect(
    'a late exit receipt remains an operational cleanup failure through optional inference timeout',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const services = yield* Layer.build(
          isolatedLocalModelRuntimeLayer({idleTimeoutMs: 0, spawnWorker: () => f.spawn(1500)}),
        );
        const start = yield* Clock.monotonicTimeNanos;
        const exit = yield* optionalReadyRecallRead(
          (yield* LocalModelRuntime.pipe(Effect.provide(services))).embedMany(request),
        ).pipe(Effect.provideService(ReadyRecallReadDeadline, yield* makeReadDeadline(1500)), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(
            EffectArray.some(
              exit.cause.reasons,
              reason => Cause.isDieReason(reason) && isReadCleanupUnconfirmed(reason.defect),
            ),
          ).toBe(true);
        expect(Number((yield* Clock.monotonicTimeNanos) - start) / 1_000_000).toBeLessThan(1500);
        expect(f.flags.spawns).toBe(1);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  effectIt.effect('an already expired read never starts inference or obtains a fresh cleanup allowance', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const services = yield* Layer.build(
        isolatedLocalModelRuntimeLayer({idleTimeoutMs: 0, spawnWorker: () => f.spawn()}),
      );
      const exit = yield* (yield* LocalModelRuntime.pipe(Effect.provide(services)))
        .embedMany(request)
        .pipe(Effect.provideService(ReadyRecallReadDeadline, yield* makeReadDeadline(0)), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(f.flags.spawns).toBe(0);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});
