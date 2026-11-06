import {makeReadyRecallReadWorkerProgram} from '../../src/recall/ready_read_main.js';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {CommandExecutor, CommandSpawnFailed} from '@threadnote/platform/command';
import {makeReadDeadline, ReadDeadlineContext, CallerReadCancellation} from '@threadnote/platform/read_deadline';
import {RecallEmbeddingWakePort} from '@threadnote/recall/background/demand';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {RecallReadyReadBoundary, recallReadyReadRequestSchema} from '@threadnote/recall/read_boundary';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {EffectMcpServerRegistry} from '../../src/effect/ai/mcp.js';
import {captureConsole} from '../../src/effect/console.js';
import {registerSearchTool} from '../../src/mcp/server/recall.js';
import {runRecall} from '../../src/memory/commands.js';
import {withReadyRecallReadBoundary, ReadyRecallReadWorkerAdmission} from '../../src/recall/ready_read_boundary.js';
import {readyRecallReadWorkerLayer, serveRecallReadyRead} from '../../src/recall/ready_read_worker.js';
import {
  RECALL_READY_READ_WORKER_ARGUMENT,
  RECALL_READY_READ_CALLER_CANCELLATION_ARGUMENT,
} from '../../src/worker_protocol.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const query = 'qz-caller-cancellation';
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-caller-'});
  const config = {
    account: 'local',
    user: 'tester',
    agentId: 'test',
    agentContextHome: home,
    manifestPath: path.join(home, 'seed-manifest.yaml'),
  };
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const filename = path.join(home, 'data/local/user/tester/memories/durable/alpha.md');
  yield* fs.makeDirectory(path.dirname(filename), {recursive: true});
  yield* fs.writeFileString(
    filename,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        memoryId: 'tn_caller_alpha',
        topic: query,
        keywords: [query],
        sourceAgentClient: 'test',
        timestamp: '2026-11-05T00:00:00.000Z',
      },
      `${query} current canonical evidence.`,
    ),
  );
  yield* loadRecallIndexData(config, {includeInactive: false});
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const closingStarted = yield* Deferred.make<void>();
  const closingRelease = yield* Deferred.make<void>();
  let holdClosing = false;
  const workerContext = (yield* Effect.context<Effect.Services<ReturnType<typeof serveRecallReadyRead>>>()).pipe(
    Context.omit(RecallReadyReadBoundary, ReadDeadlineContext, ReadyRecallReadWorkerAdmission),
  );
  const parent = yield* CommandExecutor;
  let finalized = 0;
  const windows: number[] = [];
  const commands = CommandExecutor.of({
    ...parent,
    execute: (executable, args, options) => {
      if (!args.includes(RECALL_READY_READ_WORKER_ARGUMENT)) return parent.execute(executable, args, options);
      return Effect.gen(function* () {
        expect(args.at(-1)).toBe(RECALL_READY_READ_CALLER_CANCELLATION_ARGUMENT);
        expect(options?.timeoutMs).toBe(0);
        windows.push(options?.timeoutMs ?? -1);
        const request = yield* Schema.decodeEffect(Schema.fromJsonString(recallReadyReadRequestSchema))(
          new TextDecoder().decode(options?.input),
        );
        if (request.operation === 'sections' && request.options.mode === 'baseline') {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release).pipe(Effect.ensuring(Effect.sync(() => finalized++)));
        }
        if (holdClosing && request.operation === 'sections' && request.options.mode === 'closing') {
          yield* Deferred.succeed(closingStarted, undefined);
          yield* Deferred.await(closingRelease).pipe(Effect.ensuring(Effect.sync(() => finalized++)));
        }
        const response = yield* serveRecallReadyRead(request).pipe(
          Effect.setContext(workerContext),
          Effect.provideService(CallerReadCancellation, true),
        );
        return {exitCode: 0, stdout: JSON.stringify(response), stderr: ''};
      }).pipe(
        Effect.mapError(() =>
          CommandSpawnFailed.make({
            args: [],
            executable: '<fixture>',
            message: 'Fixture native read failed.',
            cause: undefined,
          }),
        ),
      );
    },
  });
  const invoke = (surface: 'cli' | 'mcp') => {
    if (surface === 'cli')
      return captureConsole(runRecall(config, {query, inferScope: false})).pipe(Effect.map(result => result.output));
    const server = new EffectMcpServerRegistry();
    registerSearchTool(server, config, 'recall_context', 'Recall.', {heartbeatMilliseconds: 100});
    return server
      .invokeTool('recall_context', {query, inferScope: false})
      .pipe(Effect.map(result => JSON.stringify(result)));
  };
  const run = (surface: 'cli' | 'mcp') =>
    invoke(surface).pipe(
      Effect.provideService(CommandExecutor, commands),
      Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
      Effect.provideService(RecallEmbeddingWakePort, () => Effect.void),
    );
  return {
    started,
    release,
    closingStarted,
    closingRelease,
    holdClosing: () => {
      holdClosing = true;
    },
    run,
    windows,
    finalized: () => finalized,
  };
});

for (const surface of ['cli', 'mcp'] as const) {
  effectIt.effect(`${surface} awaits baseline and closing proof beyond every former query cutoff`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const reader = yield* f.run(surface).pipe(Effect.forkScoped);
      yield* Deferred.await(f.started);
      yield* TestClock.adjust(600_001);
      expect(reader.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(f.release, undefined);
      expect(yield* Fiber.join(reader)).toContain('alpha.md');
      expect(EffectArray.every(f.windows, window => window === 0)).toBe(true);
      expect(f.finalized()).toBe(1);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    `${surface} waits for current closing proof and caller cancellation cannot return a late result`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.holdClosing();
        let returned = false;
        const reader = yield* f.run(surface).pipe(
          Effect.tap(() => Effect.sync(() => (returned = true))),
          Effect.forkScoped,
        );
        yield* Deferred.await(f.started);
        yield* Deferred.succeed(f.release, undefined);
        yield* Deferred.await(f.closingStarted);
        yield* TestClock.adjust(600_001);
        expect(reader.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(reader);
        yield* Deferred.succeed(f.closingRelease, undefined);
        expect(Exit.isFailure(yield* Fiber.await(reader))).toBe(true);
        expect(returned).toBe(false);
        expect(f.finalized()).toBe(2);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(`${surface} honors an explicit caller deadline independently of query policy`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let returned = false;
      const reader = yield* f.run(surface).pipe(
        Effect.tap(() => Effect.sync(() => (returned = true))),
        Effect.provideService(ReadDeadlineContext, yield* makeReadDeadline(500)),
        Effect.forkScoped,
      );
      yield* Deferred.await(f.started);
      yield* TestClock.adjust(500);
      const exit = yield* Fiber.await(reader);
      // MCP intentionally renders a typed genuine failure; CLI fails its Effect.
      if (surface === 'cli') expect(Exit.isFailure(exit)).toBe(true);
      else if (Exit.isSuccess(exit)) expect(exit.value).toContain('read time budget');
      expect(f.finalized()).toBe(1);
      yield* Deferred.succeed(f.release, undefined);
      yield* TestClock.adjust(600_001);
      if (surface === 'cli') expect(returned).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
}

fcEffectProp(
  effectIt,
  'caller cancellation wins without a late public success, or completed evidence wins once',
  [fc.boolean(), fc.integer({min: 2001, max: 600_001}), fc.boolean()],
  ([cancelFirst, elapsed, closing]) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (closing) f.holdClosing();
      let successes = 0;
      const reader = yield* f.run('cli').pipe(
        Effect.tap(() => Effect.sync(() => successes++)),
        Effect.forkScoped,
      );
      yield* Deferred.await(f.started);
      if (closing) {
        yield* Deferred.succeed(f.release, undefined);
        yield* Deferred.await(f.closingStarted);
      }
      const release = closing ? f.closingRelease : f.release;
      yield* TestClock.adjust(elapsed);
      if (cancelFirst) {
        yield* Fiber.interrupt(reader);
        yield* Deferred.succeed(release, undefined);
        expect(Exit.isFailure(yield* Fiber.await(reader))).toBe(true);
      } else {
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(reader)).toContain('alpha.md');
        yield* Fiber.interrupt(reader);
      }
      expect(successes).toBe(cancelFirst ? 0 : 1);
      expect(f.finalized()).toBe(closing ? 2 : 1);
    }).pipe(provideTestLayer(ApplicationLayer)),
  {fastCheck: {numRuns: 12}},
);

for (const callerCancellation of [false, true])
  effectIt.effect(
    `metadata Git wrapper preserves non-query policies and injected methods (caller: ${callerCancellation})`,
    () =>
      Effect.gen(function* () {
        const seen: (number | undefined)[] = [];
        let streamed = false,
          detached = false;
        const commands = CommandExecutor.of({
          execute: (_executable, _args, options) =>
            Effect.sync(() => {
              seen.push(options?.timeoutMs);
              return {exitCode: 0, stdout: '', stderr: ''};
            }),
          executeBytes: (_executable, _args, options) =>
            Effect.sync(() => {
              seen.push(options?.timeoutMs);
              return {exitCode: 0, stdout: new Uint8Array(), stderr: ''};
            }),
          executeStreaming: () =>
            Effect.sync(() => {
              streamed = true;
              return {exitCode: 0, stdout: '', stderr: ''};
            }),
          spawnDetached: () =>
            Effect.sync(() => {
              detached = true;
              return true;
            }),
        });
        yield* withReadyRecallReadBoundary(
          Effect.gen(function* () {
            const selected = yield* CommandExecutor;
            yield* selected.execute('git', ['rev-parse', '--show-toplevel'], {timeoutMs: 5000});
            yield* selected.execute('git', ['commit'], {timeoutMs: 71});
            yield* selected.execute('git', ['remote', 'set-url', 'origin', 'fixture'], {timeoutMs: 79});
            yield* selected.execute('other', ['remote'], {timeoutMs: 73});
            if (selected.executeBytes)
              yield* selected.executeBytes('git', ['-C', '/fixture', 'rev-parse'], {timeoutMs: 5000});
            yield* selected.executeStreaming('other', []);
            if (selected.spawnDetached) yield* selected.spawnDetached('other', []);
          }),
          {callerCancellation},
        ).pipe(Effect.provideService(CommandExecutor, commands));
        expect(seen).toEqual([callerCancellation ? 0 : 5000, 71, 79, 73, callerCancellation ? 0 : 5000]);
        expect(streamed && detached).toBe(true);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

effectIt.effect('private worker policy rejects unknown or extra selectors before reading a request', () =>
  Effect.gen(function* () {
    const workerContext = yield* Layer.build(readyRecallReadWorkerLayer);
    for (const args of [
      [RECALL_READY_READ_WORKER_ARGUMENT, '--unknown-policy'],
      [RECALL_READY_READ_WORKER_ARGUMENT, RECALL_READY_READ_CALLER_CANCELLATION_ARGUMENT, '--extra'],
      ['--wrong-role'],
    ]) {
      const exit = yield* makeReadyRecallReadWorkerProgram(args, {}).pipe(Effect.provide(workerContext), Effect.result);
      expect(exit).toMatchObject({_tag: 'Failure', failure: {reason: 'invalid-protocol'}});
    }
  }).pipe(provideTestLayer(ApplicationLayer)),
);
