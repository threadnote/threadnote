import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, vi} from 'vitest';
import * as EffectString from 'effect/String';
import {
  CommandCleanupUnconfirmed,
  CommandExecutor,
  CommandSpawnFailed,
  CommandTimedOut,
} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {TestError} from '@threadnote/testing/test-error';
import {makeReadDeadline, readDeadlineRemaining, withinReadDeadline} from '@threadnote/platform/read_deadline';
import {ReadDeadlineExceeded, isReadCleanupUnconfirmed} from '@threadnote/platform/read_deadline';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {
  RecallReadyReadBoundary,
  recallReadyReadResponseSchema,
  recallReadyReadRequestSchema,
} from '@threadnote/recall/read_boundary';
import {ensureVectorIndex} from '@threadnote/recall/vector-index';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {withProductionLogging} from '../../src/effect/production_log.js';
import {captureConsole} from '../../src/effect/console.js';
import {EffectMcpServerRegistry} from '../../src/effect/ai/mcp.js';
import {runRecall} from '../../src/memory/commands.js';
import {registerSearchTool} from '../../src/mcp/server/recall.js';
import {runShareInit} from '../../src/effect/share.js';
import {
  optionalReadyRecallRead,
  ReadyRecallReadDeadline,
  ReadyRecallReadWorkerAdmission,
} from '../../src/recall/ready_read_boundary.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  readyRecallReadWorkerLayer,
  serveRecallReadyRead,
  RECALL_READY_READ_INPUT_BYTES,
  RECALL_READY_READ_OUTPUT_BYTES,
} from '../../src/recall/ready_read_worker.js';
import {telemetryChildEnvironmentPolicyLayer} from '../../src/telemetry/session.js';
import {runtimeEntrypointLayer} from '../../src/effect/runtime-entrypoint.js';
import {RECALL_READY_READ_WORKER_ARGUMENT} from '../../src/worker_protocol.js';

const embedding = Option.getOrThrow(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, value => value.id === 'bge-small-en-v1.5-q8'),
);
const operationSchema = Schema.fromJsonString(recallReadyReadRequestSchema);
const confidenceSchema = Schema.Struct({confidence: Schema.Struct({score: Schema.Finite})});
const phaseLogEntrySchema = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.String,
    phaseTimings: Schema.optionalKey(
      Schema.Array(Schema.Struct({phase: Schema.String, durationMilliseconds: Schema.Finite, outcome: Schema.String})),
    ),
  }),
);
const query = 'qz-admission-budget-7788';
const identity = 'tn_admission_budget_alpha';
const unitVector = (dimensions: number) => Array.from({length: dimensions}, (_, index) => (index === 0 ? 1 : 0));
const fastRuntime = LocalModelRuntime.of({
  diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 1}),
  embedMany: ({inputs, manifest}) =>
    Effect.succeed(EffectArray.map(inputs, () => unitVector(manifest.dimensions ?? 0))),
  generate: () => Effect.die('Unexpected generation'),
  rerank: () => Effect.die('Unexpected reranking'),
});

// Compile the current owning worker before admission. This keeps the actual
// authorization/canonical APIs and owned command factory, without making model
// entry depend on cold transpilation of the entire standalone CLI. Standalone
// registration and native cancellation have separate real-entrypoint tests.
const compileFixtureWorker = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const entrypoint = path.join(home, 'admission-worker.ts');
    yield* fs.writeFileString(
      entrypoint,
      `
import {Effect, FileSystem, Layer, Runtime} from ${JSON.stringify(Bun.fileURLToPath(import.meta.resolve('effect')))};
import {CommandExecutor, CommandSpawnFailed} from ${JSON.stringify(Bun.fileURLToPath(import.meta.resolve('@threadnote/platform/command')))};
import {RuntimeEntrypoint} from ${JSON.stringify(Bun.fileURLToPath(import.meta.resolve('@threadnote/platform/runtime-entrypoint')))};
import {recallReadyReadWorkerProgram, readyRecallReadWorkerLayer} from ${JSON.stringify(Bun.fileURLToPath(new URL('../../src/recall/ready_read_worker.ts', import.meta.url)))};
import {telemetryChildEnvironmentPolicyLayer} from ${JSON.stringify(Bun.fileURLToPath(new URL('../../src/telemetry/session.ts', import.meta.url)))};
const commands = CommandExecutor.of({
 execute: () => Effect.fail(CommandSpawnFailed.make({args: [], executable: '<ready-read>', message: 'Ready lexical workers do not launch commands.', cause: undefined})),
 executeStreaming: () => Effect.die('Ready lexical workers do not launch commands.'),
 spawnDetached: () => Effect.succeed(false),
});
const observedProgram = Effect.gen(function* () {
 const fs = yield* FileSystem.FileSystem;
 let first = true;
 const observed = FileSystem.FileSystem.of({...fs, readFileString: (...args) => Effect.gen(function* () {
   if (args[0] === ${JSON.stringify(path.join(home, 'data/local/user/tester/memories/durable/alpha.md'))}) {
     if (first && process.env.THREADNOTE_FIXTURE_HYDRATION === 'hold') {
       first = false;
       yield* fs.writeFileString(${JSON.stringify(path.join(home, 'hydration-held'))}, 'held');
       return yield* Effect.never;
     }
     if (first && process.env.THREADNOTE_FIXTURE_HYDRATION === 'delay') {
       first = false;
       yield* Effect.sleep(650);
     }
     const content = yield* fs.readFileString(...args);
     yield* Effect.sync(() => process.stderr.write('canonical-read\\n'));
     return content;
   }
   return yield* fs.readFileString(...args);
 })});
 return yield* recallReadyReadWorkerProgram.pipe(Effect.provideService(FileSystem.FileSystem, observed));
});
const program = observedProgram.pipe(
 Effect.provideService(CommandExecutor, commands),
 Effect.provide(readyRecallReadWorkerLayer),
 Effect.provide(Layer.merge(telemetryChildEnvironmentPolicyLayer, Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}))),
);
Runtime.makeRunMain(({fiber, teardown}) => fiber.addObserver(exit => teardown(exit, code => {if (code !== 0) process.exit(code);} )))(program, {disableErrorReporting: true});
`,
    );
    const built = yield* Effect.tryPromise({
      try: () =>
        Bun.build({
          entrypoints: [entrypoint],
          outdir: path.join(home, 'worker'),
          target: 'bun',
          format: 'esm',
          minify: true,
        }),
      catch: cause => TestError.make({message: 'Could not compile the current ready-read test worker.', cause}),
    });
    if (!built.success || built.outputs.length !== 1)
      return yield* TestError.make({message: 'Ready-read test worker compilation was incomplete.'});
    return {...system, developmentEntrypoint: built.outputs[0].path};
  });

const fixture = (model: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-admission-budget-'});
    const config = {
      account: 'local',
      user: 'tester',
      agentId: 'test',
      agentContextHome: home,
      manifestPath: path.join(home, 'seed-manifest.yaml'),
    };
    yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
    const filename = path.join(home, 'data/local/user/tester/memories/durable/alpha.md');
    const uri = 'threadnote://user/tester/memories/durable/alpha.md';
    yield* fs.makeDirectory(path.dirname(filename), {recursive: true});
    yield* fs.writeFileString(
      filename,
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          memoryId: identity,
          topic: query,
          keywords: [query],
          sourceAgentClient: 'test',
          timestamp: '2026-11-04T00:00:00.000Z',
        },
        `${query} useful private canonical baseline.`,
      ),
    );
    const foreign = path.join(home, 'data/local/user/other/memories/durable/foreign.md');
    yield* fs.makeDirectory(path.dirname(foreign), {recursive: true});
    yield* fs.writeFileString(
      foreign,
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          memoryId: 'tn_foreign_private',
          sourceAgentClient: 'test',
          timestamp: '2026-11-04T00:00:00.000Z',
        },
        `${query} FOREIGN_PRIVATE_SENTINEL`,
      ),
    );
    const lexical = yield* loadRecallIndexData(config, {includeInactive: false});
    const installation = {
      bytes: embedding.size,
      installed: true,
      modelId: embedding.id,
      partialBytes: 0,
      path: path.join(home, 'fake.gguf'),
      verified: true,
    };
    const store = LocalModelStore.of({
      install: () => Effect.die('Unexpected install'),
      path: () => installation.path,
      remove: () => Effect.succeed(false),
      status: () => Effect.succeed(installation),
      verify: () => Effect.succeed(installation),
    });
    if (model) {
      yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', embedding.id);
      yield* ensureVectorIndex(config, embedding, lexical.candidates, {corpusGeneration: lexical.generation}).pipe(
        Effect.provideService(LocalModelRuntime, fastRuntime),
        Effect.provideService(LocalModelStore, store),
      );
    }
    return {fs, filename, config, uri, store, system: yield* compileFixtureWorker(home)};
  });

type Surface = 'cli' | 'mcp';
function invoke(
  surface: Surface,
  f: Effect.Success<ReturnType<typeof fixture>>,
  options: {readonly query?: string; readonly project?: string} = {},
) {
  const config = f.config;
  if (surface === 'cli')
    return captureConsole(runRecall(config, {query, inferScope: false, ...options})).pipe(
      Effect.map(result => ({output: result.output, isError: false, confidenceScore: result.value.confidence?.score})),
      Effect.provideService(SystemInfo, f.system),
    );
  const server = new EffectMcpServerRegistry();
  registerSearchTool(server, config, 'recall_context', 'Recall.', {heartbeatMilliseconds: 100});
  return server.invokeTool('recall_context', {query, inferScope: false, responseFormat: 'dual', ...options}).pipe(
    Effect.map(result => ({
      output: JSON.stringify(result),
      isError: result.isError === true,
      confidenceScore: Schema.is(confidenceSchema)(result.structuredContent)
        ? result.structuredContent.confidence.score
        : undefined,
    })),
    Effect.provideService(SystemInfo, f.system),
  );
}

// Selector continuation and deterministic mutation/currentness composition cases use this source-authority seam.
// The caller still creates its real boundary/deadline and validates the protocol.
// Separate examples retain native child and admission-property coverage.
const selectorCompositionCommands = (system: SystemInfo['Service'], workerFileSystem?: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    const parent = yield* CommandExecutor;
    const rejected = () =>
      CommandSpawnFailed.make({
        args: [],
        executable: '<ready-read>',
        message: 'Invalid composition read.',
        cause: undefined,
      });
    const noChildren = CommandExecutor.of({
      execute: () => Effect.fail(rejected()),
      executeStreaming: () => Effect.die('Ready lexical workers do not launch commands.'),
      spawnDetached: () => Effect.succeed(false),
    });
    const workerContext = (yield* Layer.build(
      Layer.fresh(
        readyRecallReadWorkerLayer.pipe(
          Layer.provideMerge(Layer.merge(telemetryChildEnvironmentPolicyLayer, runtimeEntrypointLayer)),
          Layer.provideMerge(Layer.succeed(CommandExecutor, noChildren)),
        ),
      ),
    )).pipe(Context.omit(RecallReadyReadBoundary, ReadyRecallReadDeadline, ReadyRecallReadWorkerAdmission));
    const executionContext = workerFileSystem
      ? Context.add(workerContext, FileSystem.FileSystem, workerFileSystem)
      : workerContext;
    return CommandExecutor.of({
      ...parent,
      execute: (executable, args, options) => {
        if (!args.includes(RECALL_READY_READ_WORKER_ARGUMENT)) return parent.execute(executable, args, options);
        return Effect.gen(function* () {
          if (
            executable !== system.executablePath ||
            args.length !== 2 ||
            args[0] !== system.developmentEntrypoint ||
            args[1] !== RECALL_READY_READ_WORKER_ARGUMENT ||
            !options?.sensitiveOutput ||
            !options.input ||
            options.input.byteLength > RECALL_READY_READ_INPUT_BYTES ||
            options.timeoutMs === undefined ||
            options.timeoutMs <= 0
          )
            return yield* rejected();
          const request = yield* Schema.decodeEffect(operationSchema, {onExcessProperty: 'error'})(
            new TextDecoder().decode(options.input),
          );
          const timeoutMs = options.timeoutMs;
          const response = yield* serveRecallReadyRead(request).pipe(
            Effect.setContext(executionContext),
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () =>
                Effect.fail(
                  CommandTimedOut.make({
                    executable,
                    args: [...args],
                    timeoutMs,
                    message: 'Composition ready read timed out.',
                  }),
                ),
            }),
          );
          yield* Schema.decodeEffect(recallReadyReadResponseSchema)(response);
          const stdout = `${JSON.stringify(response)}\n`;
          if (new TextEncoder().encode(stdout).byteLength > RECALL_READY_READ_OUTPUT_BYTES) return yield* rejected();
          return {exitCode: 0, stdout, stderr: ''};
        }).pipe(Effect.mapError(error => (Schema.is(CommandTimedOut)(error) ? error : rejected())));
      },
    });
  });

// Fix observed read cost with test-clock barriers; the real gate and canonical APIs still run.
// This coordinates source-composition examples, never physical child cancellation evidence.
const controlledCompositionReads = (
  system: SystemInfo['Service'],
  workerFileSystem?: FileSystem.FileSystem,
  baselineMilliseconds = 100,
) =>
  Effect.gen(function* () {
    const command = yield* selectorCompositionCommands(system, workerFileSystem);
    const baselineStarted = yield* Deferred.make<void>();
    const releaseBaseline = yield* Deferred.make<void>();
    const closingStarted = yield* Deferred.make<void>();
    const releaseClosing = yield* Deferred.make<void>();
    const beforeClosing = Deferred.succeed(closingStarted, undefined).pipe(
      Effect.andThen(Deferred.await(releaseClosing)),
    );
    const observed = CommandExecutor.of({
      ...command,
      execute: (executable, args, options) =>
        Effect.gen(function* () {
          const request =
            options?.sensitiveOutput && options.input
              ? yield* Schema.decodeEffect(operationSchema)(new TextDecoder().decode(options.input)).pipe(Effect.orDie)
              : undefined;
          if (
            request?.operation === 'sections' &&
            (request.options.mode === 'baseline' || request.options.mode === 'closing')
          ) {
            const baseline = request.options.mode === 'baseline';
            yield* Deferred.succeed(baseline ? baselineStarted : closingStarted, undefined);
            yield* Deferred.await(baseline ? releaseBaseline : releaseClosing);
          }
          return yield* command.execute(executable, args, options);
        }),
    });
    const run = <A, E, R>(
      program: Effect.Effect<A, E, R>,
      options?: {
        readonly closing?: boolean;
        readonly held?: {readonly entered: Deferred.Deferred<void>; readonly interrupted: Deferred.Deferred<void>};
      },
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* program.pipe(Effect.forkScoped);
          yield* Deferred.await(baselineStarted);
          yield* TestClock.adjust(baselineMilliseconds);
          yield* Deferred.succeed(releaseBaseline, undefined);
          if (options?.held) {
            yield* Deferred.await(options.held.entered);
            yield* TestClock.adjust(600);
            yield* Deferred.await(options.held.interrupted);
          }
          if (options?.closing !== false) {
            yield* Deferred.await(closingStarted);
            yield* TestClock.adjust(100);
            yield* Deferred.succeed(releaseClosing, undefined);
          }
          return yield* Fiber.join(reader);
        }),
      );
    return {command: observed, run, beforeClosing};
  });

describe('production recall admission budget', () => {
  for (const [surface, preflightTimeout] of [
    ['cli', false],
    ['mcp', false],
    ['mcp', true],
  ] as const) {
    effectIt.effect(
      `${surface} ${preflightTimeout ? 'falls back after controlled metadata timeout' : 'omits only the stale semantic worker'} and still closes current proof`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(true);
          yield* f.fs.writeFileString(f.filename, `${yield* f.fs.readFileString(f.filename)}\nchanged generation\n`);
          yield* loadRecallIndexData(f.config, {includeInactive: false, forceRefresh: true});
          const commands = yield* selectorCompositionCommands(f.system);
          const entered = yield* Deferred.make<void>();
          let finalized = 0;
          let first = true;
          const selectionFs = FileSystem.FileSystem.of({
            ...f.fs,
            open: (...args) =>
              f.fs.open(...args).pipe(
                Effect.flatMap(file =>
                  Effect.gen(function* () {
                    if (!preflightTimeout || !first || args[0] !== `${f.config.agentContextHome}/models/selection.json`)
                      return file;
                    first = false;
                    const spy = vi
                      .spyOn(file, 'readAlloc')
                      .mockImplementation(() =>
                        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                      );
                    yield* Effect.addFinalizer(() =>
                      Effect.sync(() => {
                        finalized++;
                        spy.mockRestore();
                      }),
                    );
                    return file;
                  }),
                ),
              ),
          });
          const operations: string[] = [];
          const deadlines = new Set<bigint>();
          const observed = CommandExecutor.of({
            ...commands,
            execute: (executable, args, options) =>
              Effect.gen(function* () {
                if (options?.sensitiveOutput && options.input) {
                  const request = yield* Schema.decodeEffect(operationSchema)(
                    new TextDecoder().decode(options.input),
                  ).pipe(Effect.orDie);
                  operations.push(
                    request.operation === 'sections' ? `sections:${request.options.mode}` : request.operation,
                  );
                  const deadline = yield* Effect.serviceOption(ReadyRecallReadDeadline);
                  if (Option.isSome(deadline)) deadlines.add(deadline.value.expiresAtNanos);
                }
                return yield* commands.execute(executable, args, options);
              }),
          });
          const response = invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(CommandExecutor, observed),
            Effect.provideService(FileSystem.FileSystem, selectionFs),
            Effect.provideService(LocalModelStore, f.store),
            Effect.provideService(LocalModelRuntime, fastRuntime),
          );
          const reader = yield* response.pipe(Effect.forkChild);
          if (preflightTimeout) {
            yield* Deferred.await(entered);
            yield* TestClock.adjust(25);
          }
          const result = yield* Fiber.join(reader);
          expect(finalized).toBe(preflightTimeout ? 1 : 0);
          expect(result.isError, result.output).toBe(false);
          expect(result.output).toContain('memories/durable/alpha.md');
          expect(EffectArray.filter(operations, value => value === 'vector-state')).toHaveLength(
            preflightTimeout ? 1 : 0,
          );
          expect(EffectArray.filter(operations, value => value === 'sections:baseline')).toHaveLength(1);
          expect(EffectArray.filter(operations, value => value === 'sections:closing')).toHaveLength(1);
          expect(deadlines.size).toBe(1);
        }).pipe(provideTestLayer(ApplicationLayer)),
      {timeout: 15000},
    );
  }

  effectIt.effect('MCP closing reserve excludes workspace resolution without resetting the request deadline', () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      yield* selectLocalModel(
        f.config.agentContextHome,
        yield* LocalModelCatalog,
        'reranker',
        'jina-reranker-v1-turbo-en-f16',
      );
      const clock = yield* Clock.Clock;
      const workspace = yield* Deferred.make<void>();
      const baseline = yield* Deferred.make<void>();
      const reranker = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const command = yield* selectorCompositionCommands(f.system);
      const deadlines = new Set<bigint>();
      const windows: number[] = [];
      let interrupted = 0;
      let calls = 0;
      const observed = CommandExecutor.of({
        ...command,
        execute: (executable, args, options) =>
          Effect.gen(function* () {
            const deadline = yield* Effect.serviceOption(ReadyRecallReadDeadline);
            if (Option.isSome(deadline)) deadlines.add(deadline.value.expiresAtNanos);
            const input = options?.input
              ? yield* Schema.decodeEffect(operationSchema)(new TextDecoder().decode(options.input)).pipe(Effect.orDie)
              : undefined;
            if (input?.operation === 'sections') {
              windows.push(options!.timeoutMs!);
              yield* Deferred.succeed(input.options.mode === 'baseline' ? baseline : closing, undefined);
              yield* Effect.sleep(100);
            }
            return yield* command.execute(executable, args, options);
          }),
      });
      const runtime = LocalModelRuntime.of({
        ...fastRuntime,
        rerank: () =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(reranker, undefined);
            return yield* Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  interrupted++;
                }),
              ),
            );
          }),
      });
      const system = {
        ...f.system,
        environment: () => ({
          ...f.system.environment(),
          NODE_ENV: 'test',
          THREADNOTE_TEST_MCP_PROGRESS_WORKSPACE_DELAY_MILLISECONDS: '350',
        }),
      };
      const started = yield* Clock.monotonicTimeNanos;
      // This new composition regression controls only elapsed orchestration time.
      // All existing real-process deadline, cancellation and currentness tests remain unchanged.
      const reader = yield* invoke('mcp', {...f, system}).pipe(
        Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
        Effect.provideService(CommandExecutor, observed),
        Effect.provideService(LocalModelRuntime, runtime),
        Effect.provideService(LocalModelStore, f.store),
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: duration =>
            Duration.toMillis(duration) === 350
              ? Deferred.succeed(workspace, undefined).pipe(Effect.andThen(clock.sleep(duration)))
              : clock.sleep(duration),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(workspace);
      yield* TestClock.adjust(350);
      yield* Deferred.await(baseline);
      yield* TestClock.adjust(100);
      const admission = yield* Effect.raceFirst(
        Deferred.await(reranker).pipe(Effect.as('entered')),
        Fiber.join(reader).pipe(Effect.as('completed')),
      );
      expect(admission).toBe('entered');
      yield* TestClock.adjust(250);
      yield* Deferred.await(closing);
      yield* TestClock.adjust(100);
      const result = yield* Fiber.join(reader);
      expect(result.isError, result.output).toBe(false);
      expect(result.output).toContain('memories/durable/alpha.md');
      expect(calls).toBe(1);
      expect(interrupted).toBe(1);
      expect(windows).toEqual([550, 200]);
      expect([...deadlines]).toEqual([started + 2_000_000_000n]);
      expect((yield* Clock.monotonicTimeNanos) - started).toBe(800_000_000n);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  for (const surface of ['mcp', 'cli'] as const) {
    effectIt.effect(
      `${surface === 'mcp' ? 'MCP' : 'CLI composition'} production semantic timing excludes reranker and closing proof work`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(false);
          const path = yield* Path.Path;
          const liveClock = yield* Clock.Clock;
          const commands = surface === 'mcp' ? yield* CommandExecutor : yield* selectorCompositionCommands(f.system);
          const diagnosticEpoch = yield* Clock.currentTimeMillis;
          yield* f.fs.writeFileString(
            path.join(f.config.agentContextHome, 'layout.json'),
            `${JSON.stringify({createdBy: 'threadnote', version: 2})}\n`,
            {mode: 0o600},
          );
          let diagnosticElapsed = 0;
          let reranks = 0;
          let closingReads = 0;
          yield* selectLocalModel(
            f.config.agentContextHome,
            yield* LocalModelCatalog,
            'reranker',
            'jina-reranker-v1-turbo-en-f16',
          );
          const runtime = LocalModelRuntime.of({
            ...fastRuntime,
            rerank: ({documents}) =>
              Effect.sync(() => {
                reranks++;
                // Mark later work on the diagnostic wall clock only. Native admission,
                // cancellation, sleeps and the original deadline retain the live clock.
                diagnosticElapsed = 137;
                return EffectArray.map(documents, () => 1);
              }),
          });
          const observed = CommandExecutor.of({
            ...commands,
            execute: (executable, args, options) =>
              Effect.gen(function* () {
                if (options?.sensitiveOutput && options.input) {
                  const request = yield* Schema.decodeEffect(operationSchema)(
                    new TextDecoder().decode(options.input),
                  ).pipe(Effect.orDie);
                  if (
                    reranks > 0 &&
                    (request.operation === 'batch' ||
                      request.operation === 'memory-connections' ||
                      (request.operation === 'sections' && request.options.mode === 'closing'))
                  )
                    closingReads++;
                }
                return yield* commands.execute(executable, args, options);
              }),
          });
          const result = yield* withProductionLogging(
            f.config.agentContextHome,
            {component: surface, operation: surface === 'mcp' ? 'recall_context' : 'recall'},
            invoke(surface, f),
          ).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, f.store),
            Effect.provideService(CommandExecutor, observed),
            Effect.provideService(Clock.Clock, {
              currentTimeNanos: liveClock.currentTimeNanos,
              currentTimeNanosUnsafe: () => liveClock.currentTimeNanosUnsafe(),
              monotonicTimeNanos: liveClock.monotonicTimeNanos,
              monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
              sleep: duration => liveClock.sleep(duration),
              currentTimeMillis: Effect.sync(() => diagnosticEpoch + diagnosticElapsed),
              currentTimeMillisUnsafe: () => diagnosticEpoch + diagnosticElapsed,
            }),
          );
          expect(reranks).toBe(1);
          expect(closingReads).toBeGreaterThan(0);
          expect(result.isError, result.output).toBe(false);
          expect(result.output).toContain('memories/durable/alpha.md');
          const log = yield* f.fs.readFileString(path.join(f.config.agentContextHome, 'logs', 'threadnote.log'));
          const entries = yield* Effect.forEach(EffectString.split(EffectString.trim(log), '\n'), line =>
            Schema.decodeEffect(phaseLogEntrySchema)(line),
          );
          const finished = Option.getOrUndefined(
            EffectArray.findFirst(entries, entry => entry.event === 'invocation.finished'),
          );
          const semantic = finished?.phaseTimings
            ? EffectArray.filter(finished.phaseTimings, timing => timing.phase === 'recall.semantic-retrieval')
            : undefined;
          expect(semantic).toEqual([
            {phase: 'recall.semantic-retrieval', durationMilliseconds: 0, outcome: 'unavailable'},
          ]);
          expect(log).not.toContain(query);
          expect(log).not.toContain(f.uri);
          expect(log).not.toContain('FOREIGN_PRIVATE_SENTINEL');
        }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
      {timeout: 15000},
    );
  }
  fcEffectProp(
    effectIt,
    'refinement reserves closing proof or rejects optional work without entering it',
    [fc.integer({min: 0, max: 899}), fc.integer({min: 1, max: 900})],
    ([elapsed, closingReadMilliseconds]) =>
      Effect.gen(function* () {
        const started = yield* Clock.monotonicTimeNanos;
        const deadline = yield* makeReadDeadline(2000);
        yield* TestClock.adjust(elapsed);
        let entered = false;
        const optional = yield* optionalReadyRecallRead(
          Effect.sync(() => {
            entered = true;
          }).pipe(Effect.andThen(Effect.never)),
          {closingReadMilliseconds},
        ).pipe(Effect.provideService(ReadyRecallReadDeadline, deadline), Effect.forkScoped);
        const canEnter = 900 - elapsed - closingReadMilliseconds > 0;
        yield* TestClock.adjust(Math.max(0, 900 - elapsed - closingReadMilliseconds));
        expect(Option.isNone(yield* Fiber.join(optional))).toBe(true);
        expect(entered).toBe(canEnter);
        expect(deadline.expiresAtNanos).toBe(started + 2_000_000_000n);
        if (!canEnter) {
          expect(yield* readDeadlineRemaining(deadline)).toBe(2000 - elapsed);
          return;
        }
        expect(yield* readDeadlineRemaining(deadline)).toBeGreaterThanOrEqual(1100 + closingReadMilliseconds);
        const closing = yield* withinReadDeadline(
          deadline,
          Effect.sleep(closingReadMilliseconds).pipe(Effect.as('verified')),
        ).pipe(Effect.forkScoped);
        yield* TestClock.adjust(closingReadMilliseconds);
        expect(yield* Fiber.join(closing)).toBe('verified');
        expect(yield* readDeadlineRemaining(deadline)).toBeGreaterThanOrEqual(1100);
        expect(deadline.expiresAtNanos).toBe(started + 2_000_000_000n);
      }),
    {fastCheck: {numRuns: 12}},
  );
  for (const surface of ['cli', 'mcp'] as const) {
    effectIt.effect(
      `${surface} composition retains completed proof without another native read when optional work was never admitted`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(true);
          let modelCalls = 0;
          let hydrated = false;
          const workerFs = FileSystem.FileSystem.of({
            ...f.fs,
            readFileString: (...args) =>
              f.fs.readFileString(...args).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (args[0] === f.filename) hydrated = true;
                  }),
                ),
              ),
          });
          // A completed 650ms baseline deterministically rejects optional admission:
          // 900 compute - 650 baseline - 2 * 650 closing reservation is negative.
          const controlled = yield* controlledCompositionReads(f.system, workerFs, 650);
          const command = controlled.command;
          const operations: string[] = [];
          const observed = CommandExecutor.of({
            ...command,
            execute: (executable, args, options) =>
              Effect.gen(function* () {
                if (options?.sensitiveOutput && options.input)
                  operations.push(
                    (yield* Schema.decodeEffect(operationSchema)(new TextDecoder().decode(options.input)).pipe(
                      Effect.orDie,
                    )).operation,
                  );
                return yield* command.execute(executable, args, options).pipe(
                  Effect.tap(result =>
                    Effect.sync(() => {
                      hydrated ||= EffectString.includes('canonical-read')(result.stderr);
                    }),
                  ),
                );
              }),
          });
          const runtime = LocalModelRuntime.of({
            ...fastRuntime,
            embedMany: request =>
              Effect.sync(() => {
                modelCalls++;
              }).pipe(Effect.andThen(fastRuntime.embedMany(request))),
          });
          const path = yield* Path.Path;
          yield* f.fs.writeFileString(
            path.join(f.config.agentContextHome, 'layout.json'),
            JSON.stringify({createdBy: 'threadnote', version: 2}),
          );
          const started = yield* Clock.monotonicTimeNanos;
          const response = withProductionLogging(
            f.config.agentContextHome,
            {component: surface, operation: 'recall_context'},
            invoke(surface, f),
          ).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(CommandExecutor, observed),
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, f.store),
          );
          const result = yield* controlled.run(response, {closing: false});
          if (surface === 'mcp') {
            const log = yield* f.fs.readFileString(path.join(f.config.agentContextHome, 'logs', 'threadnote.log'));
            const entries = yield* Effect.forEach(EffectString.split(EffectString.trim(log), '\n'), line =>
              Schema.decodeEffect(phaseLogEntrySchema)(line),
            );
            const finished = Option.getOrThrow(
              EffectArray.findFirst(entries, entry => entry.event === 'invocation.finished'),
            );
            expect(
              EffectArray.filter(finished.phaseTimings ?? [], phase => phase.phase === 'recall.semantic-retrieval'),
            ).toEqual([{phase: 'recall.semantic-retrieval', durationMilliseconds: 0, outcome: 'unavailable'}]);
          }
          expect(hydrated).toBe(true);
          expect(modelCalls).toBe(0);
          expect(operations).toEqual(['sections']);
          expect(result.isError, result.output).toBe(false);
          expect(result.output).toContain('memories/durable/alpha.md');
          expect(Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000).toBeLessThan(2000);
        }).pipe(provideTestLayer(ApplicationLayer)),
      {timeout: 15000},
    );
    effectIt.effect(
      `${surface} composition preserves completed reranker scores in model-free final proof`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(false);
          const command = yield* selectorCompositionCommands(f.system);
          const before = yield* invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(CommandExecutor, command),
            Effect.provideService(LocalModelStore, f.store),
          );
          yield* selectLocalModel(
            f.config.agentContextHome,
            yield* LocalModelCatalog,
            'reranker',
            'jina-reranker-v1-turbo-en-f16',
          );
          let reranks = 0;
          let completedRerankerScores: readonly number[] | undefined;
          const runtime = LocalModelRuntime.of({
            ...fastRuntime,
            rerank: ({documents}) =>
              Effect.sync(() => {
                reranks++;
                return EffectArray.map(documents, () => 1);
              }).pipe(
                Effect.tap(scores =>
                  Effect.sync(() => {
                    completedRerankerScores = scores;
                  }),
                ),
              ),
          });
          const result = yield* invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(CommandExecutor, command),
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, f.store),
          );
          expect(reranks).toBe(1);
          expect(completedRerankerScores).toBeDefined();
          expect(completedRerankerScores?.length).toBeGreaterThan(0);
          expect(EffectArray.every(completedRerankerScores ?? [], score => score === 1)).toBe(true);
          expect(result.isError, result.output).toBe(false);
          expect(result.output).toContain('memories/durable/alpha.md');
          expect(result.confidenceScore).toBeGreaterThan(before.confidenceScore ?? 1);
        }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
      {timeout: 15000},
    );
    for (const mutation of [false, true]) {
      effectIt.effect(
        `${surface} composes source-authorized score-bearing refinement after a later selector returns undefined (${mutation ? 'archived' : 'current'})`,
        () =>
          Effect.gen(function* () {
            const f = yield* fixture(true);
            const command = yield* selectorCompositionCommands(f.system);
            const lexical = mutation
              ? undefined
              : yield* invoke(surface, {
                  ...f,
                  system: {...f.system, environment: () => ({...f.system.environment(), THREADNOTE_EFFECT_AI: '0'})},
                }).pipe(
                  Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
                  Effect.provideService(CommandExecutor, command),
                  Effect.provideService(LocalModelRuntime, {
                    ...fastRuntime,
                    embedMany: ({inputs, manifest}) =>
                      Effect.succeed(
                        EffectArray.map(inputs, () =>
                          Array.from({length: manifest.dimensions ?? 0}, (_, index) => (index === 1 ? 1 : 0)),
                        ),
                      ),
                  }),
                  Effect.provideService(LocalModelStore, f.store),
                );
            let scored = false;
            let refinedBatches = 0;
            let providerCalls = 0;
            let selectorAfterRefinement = false;
            let inFlightReadyReads = 0;
            const deadlines = new Set<bigint>();
            const observed = CommandExecutor.of({
              ...command,
              execute: (executable, args, options) =>
                Effect.gen(function* () {
                  const request =
                    options?.sensitiveOutput && options.input
                      ? yield* Schema.decodeEffect(operationSchema)(new TextDecoder().decode(options.input)).pipe(
                          Effect.orDie,
                        )
                      : undefined;
                  const deadline = yield* Effect.serviceOption(ReadyRecallReadDeadline);
                  if (Option.isSome(deadline)) deadlines.add(deadline.value.expiresAtNanos);
                  inFlightReadyReads++;
                  return yield* command.execute(executable, args, options).pipe(
                    Effect.tap(result =>
                      Effect.gen(function* () {
                        if (request?.operation === 'vector-scores') {
                          const reply = yield* Schema.decodeEffect(
                            Schema.fromJsonString(
                              Schema.Struct({value: Schema.Array(Schema.Tuple([Schema.String, Schema.Finite]))}),
                            ),
                          )(result.stdout).pipe(Effect.orDie);
                          scored = EffectArray.some(reply.value, ([uri, score]) => uri === f.uri && score > 0);
                        }
                        if (
                          scored &&
                          (request?.operation === 'batch' ||
                            (request?.operation === 'sections' && request.options.mode === 'closing'))
                        )
                          refinedBatches++;
                      }),
                    ),
                    Effect.ensuring(
                      Effect.sync(() => {
                        inFlightReadyReads--;
                      }),
                    ),
                  );
                }),
            });
            const archivedContent = EffectString.replace(
              'status: active',
              'status: archived',
            )(yield* f.fs.readFileString(f.filename));
            const server = yield* Effect.acquireRelease(
              Effect.sync(() =>
                Bun.serve({
                  hostname: '127.0.0.1',
                  port: 0,
                  fetch: async () => {
                    providerCalls++;
                    if (providerCalls === 1) {
                      selectorAfterRefinement = scored && refinedBatches > 0;
                      if (mutation) await Bun.write(f.filename, archivedContent);
                      return Response.json(
                        {error: {message: 'Fixture selector unavailable.', type: 'invalid_request_error'}},
                        {status: 400},
                      );
                    }
                    return Response.json({
                      id: 'fixture',
                      object: 'chat.completion',
                      created: 0,
                      model: 'fixture',
                      choices: [
                        {
                          index: 0,
                          finish_reason: 'stop',
                          message: {role: 'assistant', content: JSON.stringify({queries: [query]})},
                        },
                      ],
                      usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0},
                    });
                  },
                }),
              ),
              value => Effect.promise(() => value.stop(true)),
            );
            const system = {
              ...f.system,
              environment: () => ({
                ...f.system.environment(),
                THREADNOTE_EFFECT_AI: '1',
                THREADNOTE_EFFECT_AI_MODEL: 'fixture',
                THREADNOTE_EFFECT_AI_API_KEY: 'fixture-not-secret',
                THREADNOTE_EFFECT_AI_API_URL: `http://127.0.0.1:${server.port}/v1`,
              }),
            };
            const queryRuntime = LocalModelRuntime.of({
              ...fastRuntime,
              embedMany: ({inputs, manifest}) =>
                Effect.succeed(
                  EffectArray.map(inputs, () =>
                    Array.from({length: manifest.dimensions ?? 0}, (_, index) =>
                      index === 0 ? 0.25 : index === 1 ? Math.sqrt(1 - 0.25 ** 2) : 0,
                    ),
                  ),
                ),
            });
            const started = yield* Clock.monotonicTimeNanos;
            const result = yield* invoke(surface, {...f, system}).pipe(
              Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
              Effect.provideService(CommandExecutor, observed),
              Effect.provideService(LocalModelRuntime, queryRuntime),
              Effect.provideService(LocalModelStore, f.store),
            );
            expect(scored).toBe(true);
            expect(selectorAfterRefinement).toBe(true);
            expect(providerCalls).toBeGreaterThanOrEqual(2);
            expect(inFlightReadyReads).toBe(0);
            expect(deadlines.size).toBe(1);
            expect(Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000).toBeLessThan(2000);
            expect(result.isError, result.output).toBe(false);
            if (mutation) {
              expect(result.output).not.toContain('memories/durable/alpha.md');
              expect(result.output).not.toContain('useful private canonical baseline');
            } else {
              expect(result.output).toContain('memories/durable/alpha.md');
              expect(result.confidenceScore).toBeGreaterThan(lexical?.confidenceScore ?? 1);
            }
          }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
        {timeout: 15000},
      );
    }
    for (const mutation of ['archive', 'delete', 'unavailable-closing'] as const) {
      effectIt.effect(
        `${surface} ${(surface === 'cli' && mutation === 'archive') || (surface === 'mcp' && mutation !== 'archive') ? 'composition ' : ''}closes current canonical proof after a reranker ${mutation}s the baseline and stalls`,
        () =>
          Effect.gen(function* () {
            const f = yield* fixture(false);
            yield* selectLocalModel(
              f.config.agentContextHome,
              yield* LocalModelCatalog,
              'reranker',
              'jina-reranker-v1-turbo-en-f16',
            );
            const entered = yield* Deferred.make<void>();
            const stopped = yield* Deferred.make<void>();
            const controlled =
              surface === 'mcp' && mutation !== 'archive' ? yield* controlledCompositionReads(f.system) : undefined;
            let calls = 0;
            let interrupted = 0;
            let closingReads = 0;
            let activeChildren = 0;
            const deadlines = new Set<bigint>();
            const timeouts: number[] = [];
            // This source-composition case proves mutation and closing-currentness behavior deterministically.
            // Real native child startup/cancellation remains covered by the neighboring boundary tests.
            const command =
              controlled?.command ??
              (surface === 'cli' && mutation === 'archive'
                ? yield* selectorCompositionCommands(f.system)
                : yield* CommandExecutor);
            const observed = CommandExecutor.of({
              ...command,
              execute: (executable, args, options) =>
                Effect.gen(function* () {
                  const deadline = yield* Effect.serviceOption(ReadyRecallReadDeadline);
                  if (Option.isSome(deadline)) deadlines.add(deadline.value.expiresAtNanos);
                  const input =
                    options?.sensitiveOutput && options.input
                      ? yield* Schema.decodeEffect(operationSchema)(new TextDecoder().decode(options.input)).pipe(
                          Effect.orDie,
                        )
                      : undefined;
                  if (input) timeouts.push(options!.timeoutMs!);
                  if (interrupted > 0 && input?.operation === 'sections' && input.options.mode === 'closing') {
                    closingReads++;
                    expect(input.options.candidateUris).toContain(f.uri);
                    expect(input.options.mode).toBe('closing');
                    if (mutation === 'unavailable-closing') {
                      if (controlled) yield* controlled.beforeClosing;
                      return yield* CommandTimedOut.make({
                        executable,
                        args: [...args],
                        timeoutMs: options!.timeoutMs!,
                        message: 'Owned ready read reached its deadline.',
                      });
                    }
                  }
                  activeChildren++;
                  return yield* command.execute(executable, args, options).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        activeChildren--;
                      }),
                    ),
                  );
                }),
            });
            const runtime = LocalModelRuntime.of({
              ...fastRuntime,
              rerank: () =>
                Effect.gen(function* () {
                  calls++;
                  if (mutation === 'delete') yield* f.fs.remove(f.filename);
                  else if (mutation === 'archive')
                    yield* f.fs.writeFileString(
                      f.filename,
                      EffectString.replace(
                        'status: active',
                        'status: archived',
                      )(yield* f.fs.readFileString(f.filename)),
                    );
                  yield* Deferred.succeed(entered, undefined);
                  return yield* Effect.never.pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        interrupted++;
                      }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined))),
                    ),
                  );
                }).pipe(Effect.orDie),
            });
            const started = yield* Clock.monotonicTimeNanos;
            const response = invoke(surface, f).pipe(
              Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
              Effect.provideService(CommandExecutor, observed),
              Effect.provideService(LocalModelRuntime, runtime),
              Effect.provideService(LocalModelStore, f.store),
            );
            const result = yield* controlled
              ? controlled.run(response, {held: {entered, interrupted: stopped}})
              : response;
            expect(calls).toBe(1);
            expect(interrupted).toBe(1);
            expect(closingReads).toBe(1);
            expect(activeChildren).toBe(0);
            expect(deadlines.size).toBe(1);
            for (let i = 1; i < timeouts.length; i++) expect(timeouts[i]).toBeLessThanOrEqual(timeouts[i - 1]);
            expect(Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000).toBeLessThan(2000);
            expect(result.isError, result.output).toBe(false);
            expect(result.output).not.toContain('memories/durable/alpha.md');
            expect(result.output).not.toContain('useful private canonical baseline');
            if (mutation === 'unavailable-closing') expect(result.output).toContain('time budget');
          }).pipe(provideTestLayer(ApplicationLayer), effect =>
            surface === 'mcp' && mutation !== 'archive' ? effect : TestClock.withLive(effect),
          ),
        {timeout: 15000},
      );
    }
    effectIt.effect(
      `${surface} composition closes a successful no-op optional refinement after canonical deletion`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(true);
          // This source-composition case proves deletion and closing-currentness behavior deterministically.
          // Real native child startup/cancellation remains covered by the neighboring boundary tests.
          const controlled = surface === 'cli' ? yield* controlledCompositionReads(f.system) : undefined;
          const command = controlled?.command ?? (yield* selectorCompositionCommands(f.system));
          let deleted = false;
          let closingReads = 0;
          const observed = CommandExecutor.of({
            ...command,
            execute: (executable, args, options) =>
              Effect.gen(function* () {
                const input =
                  options?.sensitiveOutput && options.input
                    ? yield* Schema.decodeEffect(operationSchema)(new TextDecoder().decode(options.input)).pipe(
                        Effect.orDie,
                      )
                    : undefined;
                if (deleted && input?.operation === 'sections' && input.options.mode === 'closing') closingReads++;
                return yield* command.execute(executable, args, options).pipe(
                  Effect.tap(() =>
                    input?.operation === 'vector-state'
                      ? f.fs.remove(f.filename).pipe(
                          Effect.orDie,
                          Effect.tap(() =>
                            Effect.sync(() => {
                              deleted = true;
                            }),
                          ),
                        )
                      : Effect.void,
                  ),
                );
              }),
          });
          const response = invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(CommandExecutor, observed),
            Effect.provideService(LocalModelRuntime, fastRuntime),
            Effect.provideService(LocalModelStore, f.store),
          );
          const result = yield* controlled ? controlled.run(response) : response;
          expect(deleted).toBe(true);
          expect(closingReads).toBeGreaterThan(0);
          expect(result.isError, result.output).toBe(false);
          expect(result.output).not.toContain('memories/durable/alpha.md');
          expect(result.output).not.toContain('useful private canonical baseline');
        }).pipe(provideTestLayer(ApplicationLayer), effect =>
          surface === 'mcp' ? TestClock.withLive(effect) : effect,
        ),
      {timeout: 15000},
    );
    effectIt.effect(
      `${surface} ${surface === 'mcp' ? 'composition ' : ''}preserves unknown vocabulary child cleanup after the lexical baseline`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(false);
          const controlled = surface === 'mcp' ? yield* controlledCompositionReads(f.system) : undefined;
          const command = controlled?.command ?? (yield* CommandExecutor);
          let completedBaseline = 0;
          let vocabularyRequests = 0;
          const observed = CommandExecutor.of({
            ...command,
            execute: (executable, args, options) =>
              Effect.gen(function* () {
                const input =
                  options?.sensitiveOutput && options.input
                    ? yield* Schema.decodeEffect(operationSchema)(new TextDecoder().decode(options.input)).pipe(
                        Effect.orDie,
                      )
                    : undefined;
                if (input?.operation === 'data') {
                  vocabularyRequests++;
                  expect(completedBaseline).toBeGreaterThan(0);
                  return yield* CommandCleanupUnconfirmed.make({
                    executable,
                    args: [...args],
                    message: 'Owned read cleanup was not confirmed.',
                  });
                }
                return yield* command.execute(executable, args, options).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (input?.operation === 'sections' && input.options.mode === 'baseline') completedBaseline++;
                    }),
                  ),
                );
              }),
          });
          const response = invoke(surface, f, {
            query: 'unmatched project issue',
            project: 'budget-fixture',
          }).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(CommandExecutor, observed),
            Effect.result,
          );
          const result = yield* controlled ? controlled.run(response, {closing: false}) : response;
          expect(vocabularyRequests).toBe(1);
          if (surface === 'cli') {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') expect(isReadCleanupUnconfirmed(result.failure)).toBe(true);
          } else {
            expect(result._tag).toBe('Success');
            if (result._tag === 'Success') expect(result.success.isError).toBe(true);
          }
        }).pipe(provideTestLayer(ApplicationLayer), effect =>
          surface === 'mcp' ? effect : TestClock.withLive(effect),
        ),
      {timeout: 15000},
    );
    for (const mode of ['absent', 'fast', 'slow'] as const) {
      effectIt.effect(
        `${surface} ${surface === 'mcp' || mode !== 'absent' ? 'composition ' : ''}returns its authorized lexical baseline with ${mode} semantic inference`,
        () =>
          Effect.gen(function* () {
            const f = yield* fixture(mode !== 'absent');
            const deterministicSlowComposition = mode === 'slow';
            const baselineReadStarted = yield* Deferred.make<void>();
            const baselineReadCompleted = yield* Deferred.make<void>();
            const slowInferenceStarted = yield* Deferred.make<void>();
            const slowInferenceInterrupted = yield* Deferred.make<void>();
            const closingReadStarted = yield* Deferred.make<void>();
            const closingReadCompleted = yield* Deferred.make<void>();
            const completedReads: number[] = [];
            const starts: number[] = [];
            let activeReads = 0;
            let modelCalls = 0;
            let interruptedModel = 0;
            let enteredSlowCallback = false;
            let completedFastCallback = false;
            let hydrated = 0;
            let lateHydrations = 0;
            let baselineReadStartedAt: bigint | undefined;
            let baselineReadCompletedAt: bigint | undefined;
            let closingReadStartedAt: bigint | undefined;
            let closingReadCompletedAt: bigint | undefined;
            const deadlines = new Set<bigint>();
            const fs = {
              ...f.fs,
              readFileString: (...args: Parameters<typeof f.fs.readFileString>) =>
                Effect.gen(function* () {
                  if (args[0] === f.filename && Option.isSome(yield* Effect.serviceOption(ReadyRecallReadDeadline))) {
                    hydrated++;
                    if (interruptedModel > 0) lateHydrations++;
                  }
                  return yield* f.fs.readFileString(...args);
                }),
            };
            const observedWorkerFileSystem = FileSystem.FileSystem.of({
              ...f.fs,
              readFileString: (...args) =>
                Effect.gen(function* () {
                  if (args[0] === f.filename) {
                    hydrated++;
                    if (interruptedModel > 0) lateHydrations++;
                  }
                  return yield* f.fs.readFileString(...args);
                }),
            });
            const controlled =
              (surface === 'mcp' && mode === 'absent') || (surface === 'cli' && mode === 'fast')
                ? yield* controlledCompositionReads(f.system, observedWorkerFileSystem)
                : undefined;
            // The source seam observes canonical reads through this fixture service; it does not emit the
            // compiled child's stderr marker or prove native process behavior.
            const command =
              controlled?.command ??
              ((surface === 'mcp' && mode !== 'absent') || deterministicSlowComposition
                ? yield* selectorCompositionCommands(f.system, observedWorkerFileSystem)
                : yield* CommandExecutor);
            const observedCommand = CommandExecutor.of({
              ...command,
              execute: (executable, args, options) =>
                Effect.gen(function* () {
                  const request =
                    deterministicSlowComposition && options?.sensitiveOutput && options.input
                      ? yield* Schema.decodeEffect(operationSchema)(new TextDecoder().decode(options.input)).pipe(
                          Effect.orDie,
                        )
                      : undefined;
                  const admitted = yield* Effect.serviceOption(ReadyRecallReadDeadline);
                  if (options?.sensitiveOutput && options.input) {
                    expect(Option.isSome(admitted)).toBe(true);
                    if (Option.isSome(admitted)) deadlines.add(admitted.value.expiresAtNanos);
                    expect(options.verifyOwnedProcessExit).toBeDefined();
                    expect(options.timeoutMs).toBeGreaterThan(0);
                    starts.push(options.timeoutMs!);
                    activeReads++;
                    const readMode = request?.operation === 'sections' ? request.options.mode : undefined;
                    if (deterministicSlowComposition && (readMode === 'baseline' || readMode === 'closing')) {
                      const startedAt = yield* Clock.monotonicTimeNanos;
                      if (readMode === 'baseline') baselineReadStartedAt = startedAt;
                      else closingReadStartedAt = startedAt;
                      yield* Deferred.succeed(
                        readMode === 'baseline' ? baselineReadStarted : closingReadStarted,
                        undefined,
                      );
                      // Hold the real composition behind the test clock for one fixed observed read cost.
                      yield* Effect.sleep(Duration.millis(100));
                    }
                    const result = yield* command.execute(executable, args, options).pipe(
                      Effect.tap(result =>
                        Effect.sync(() => {
                          completedReads.push(starts.length);
                          const reads = EffectString.split(result.stderr, 'canonical-read').length - 1;
                          hydrated += reads;
                          if (interruptedModel > 0) lateHydrations += reads;
                        }),
                      ),
                      Effect.ensuring(
                        Effect.sync(() => {
                          activeReads--;
                        }),
                      ),
                    );
                    if (deterministicSlowComposition && readMode === 'baseline') {
                      baselineReadCompletedAt = yield* Clock.monotonicTimeNanos;
                      yield* Deferred.succeed(baselineReadCompleted, undefined);
                    }
                    if (deterministicSlowComposition && readMode === 'closing') {
                      closingReadCompletedAt = yield* Clock.monotonicTimeNanos;
                      yield* Deferred.succeed(closingReadCompleted, undefined);
                    }
                    return result;
                  }
                  return yield* command.execute(executable, args, options);
                }),
            });
            const runtime = LocalModelRuntime.of({
              ...fastRuntime,
              embedMany: request =>
                Effect.gen(function* () {
                  modelCalls++;
                  expect(completedReads.length).toBeGreaterThanOrEqual(2);
                  expect(hydrated).toBeGreaterThan(0);
                  const deadline = yield* Effect.serviceOption(ReadyRecallReadDeadline);
                  expect(Option.isSome(deadline)).toBe(true);
                  if (Option.isSome(deadline)) {
                    deadlines.add(deadline.value.expiresAtNanos);
                    expect(yield* readDeadlineRemaining(deadline.value, 1100)).toBeGreaterThan(0);
                  }
                  if (mode === 'slow') {
                    enteredSlowCallback = true;
                    if (deterministicSlowComposition) yield* Deferred.succeed(slowInferenceStarted, undefined);
                    return yield* Effect.never.pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          interruptedModel++;
                        }).pipe(
                          Effect.andThen(
                            deterministicSlowComposition
                              ? Deferred.succeed(slowInferenceInterrupted, undefined)
                              : Effect.void,
                          ),
                        ),
                      ),
                    );
                  }
                  const result = yield* fastRuntime.embedMany(request);
                  completedFastCallback = true;
                  return result;
                }),
            });
            const start = yield* Clock.monotonicTimeNanos;
            const responseEffect = invoke(surface, f).pipe(
              Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
              Effect.provideService(CommandExecutor, observedCommand),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(LocalModelRuntime, runtime),
              Effect.provideService(LocalModelStore, f.store),
            );
            let result: {
              readonly output: string;
              readonly isError: boolean;
              readonly confidenceScore: number | undefined;
            };
            if (deterministicSlowComposition) {
              const reader = yield* responseEffect.pipe(Effect.forkScoped);
              yield* Deferred.await(baselineReadStarted);
              yield* TestClock.adjust(100);
              yield* Deferred.await(baselineReadCompleted);
              yield* Deferred.await(slowInferenceStarted);
              // 900 compute - 100 baseline - 2 * 100 closing reservation = 600 optional.
              // Stop exactly at interruption: adjust also advances newly registered sleeps,
              // so overshooting would spend closing time while real SQLite I/O is suspended.
              yield* TestClock.adjust(600);
              yield* Deferred.await(slowInferenceInterrupted);
              yield* Deferred.await(closingReadStarted);
              yield* TestClock.adjust(100);
              yield* Deferred.await(closingReadCompleted);
              result = yield* Fiber.join(reader);
              expect(baselineReadCompletedAt! - baselineReadStartedAt!).toBe(100_000_000n);
              expect(closingReadCompletedAt! - closingReadStartedAt!).toBe(100_000_000n);
              expect(baselineReadStartedAt! - start).toBe(0n);
              expect(closingReadStartedAt! - start).toBe(700_000_000n);
              expect((yield* Clock.monotonicTimeNanos) - start).toBe(800_000_000n);
            } else {
              result = yield* controlled ? controlled.run(responseEffect) : responseEffect;
            }
            expect(Number((yield* Clock.monotonicTimeNanos) - start) / 1_000_000).toBeLessThan(2000);
            expect(result.isError, result.output).toBe(false);
            expect(result.output).toContain('memories/durable/alpha.md');
            expect(result.output).not.toContain('FOREIGN_PRIVATE_SENTINEL');
            expect(result.output).not.toContain('tn_foreign_private');
            expect(modelCalls).toBe(mode === 'absent' ? 0 : 1);
            if (mode === 'fast') expect(completedFastCallback).toBe(true);
            if (mode === 'slow') expect(enteredSlowCallback).toBe(true);
            expect(interruptedModel).toBe(mode === 'slow' ? 1 : 0);
            if (mode === 'slow') expect(lateHydrations).toBeGreaterThan(0);
            else expect(lateHydrations).toBe(0);
            expect(activeReads).toBe(0);
            expect(completedReads.length).toBeGreaterThanOrEqual(2);
            expect(deadlines.size).toBe(1);
            if (deterministicSlowComposition) expect([...deadlines]).toEqual([start + 2_000_000_000n]);
            if (deterministicSlowComposition) expect(starts).toEqual([900, 800, 200]);
            for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeLessThanOrEqual(starts[i - 1]);
          }).pipe(provideTestLayer(ApplicationLayer), effect =>
            (surface === 'mcp' && mode !== 'fast') || (surface === 'cli' && mode !== 'absent')
              ? effect
              : TestClock.withLive(effect),
          ),
        {timeout: 15000},
      );
    }
    effectIt.effect(
      `${surface} ${surface === 'mcp' ? 'composition ' : ''}retains its hydrated baseline when the selected native reranker is held`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(false);
          yield* selectLocalModel(
            f.config.agentContextHome,
            yield* LocalModelCatalog,
            'reranker',
            'jina-reranker-v1-turbo-en-f16',
          );
          const entered = yield* Deferred.make<void>();
          const stopped = yield* Deferred.make<void>();
          let hydrated = 0;
          let hydratedBeforeRerank = 0;
          let rerankCalls = 0;
          let interrupted = 0;
          let lateHydrations = 0;
          const fs = {
            ...f.fs,
            readFileString: (...args: Parameters<typeof f.fs.readFileString>) =>
              Effect.gen(function* () {
                if (args[0] === f.filename) {
                  hydrated++;
                  if (interrupted > 0) lateHydrations++;
                }
                return yield* f.fs.readFileString(...args);
              }),
          };
          const controlled =
            surface === 'mcp' ? yield* controlledCompositionReads(f.system, FileSystem.FileSystem.of(fs)) : undefined;
          const command = controlled?.command ?? (yield* CommandExecutor);
          const observed = CommandExecutor.of({
            ...command,
            execute: (executable, args, options) =>
              command.execute(executable, args, options).pipe(
                Effect.tap(result =>
                  Effect.sync(() => {
                    const reads = EffectString.split(result.stderr, 'canonical-read').length - 1;
                    hydrated += reads;
                    if (interrupted > 0) lateHydrations += reads;
                  }),
                ),
              ),
          });
          const runtime = LocalModelRuntime.of({
            ...fastRuntime,
            rerank: () =>
              Effect.gen(function* () {
                rerankCalls++;
                hydratedBeforeRerank = hydrated;
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      interrupted++;
                    }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined))),
                  ),
                );
              }),
          });
          const started = yield* Clock.monotonicTimeNanos;
          const response = invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(CommandExecutor, observed),
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, f.store),
          );
          const result = yield* controlled
            ? controlled.run(response, {held: {entered, interrupted: stopped}})
            : response;
          expect(Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000).toBeLessThan(2000);
          expect(result.isError, result.output).toBe(false);
          expect(result.output).toContain('memories/durable/alpha.md');
          expect(result.output).not.toContain('tn_foreign_private');
          expect(rerankCalls).toBe(1);
          expect(hydratedBeforeRerank).toBeGreaterThan(0);
          expect(interrupted).toBe(1);
          expect(lateHydrations).toBeGreaterThan(0);
        }).pipe(provideTestLayer(ApplicationLayer), effect =>
          surface === 'mcp' ? effect : TestClock.withLive(effect),
        ),
      {timeout: 15000},
    );
    effectIt.effect(
      `${surface} includes required canonical hydration in the original admission deadline`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(false);
          let held = 0;
          let interrupted = 0;
          const deadlines = new Set<bigint>();
          const heldMarker = (yield* Path.Path).join(f.config.agentContextHome, 'hydration-held');
          const command = yield* CommandExecutor;
          const observed = CommandExecutor.of({
            ...command,
            execute: (executable, args, options) =>
              Effect.gen(function* () {
                const deadline = yield* Effect.serviceOption(ReadyRecallReadDeadline);
                if (options?.sensitiveOutput && Option.isSome(deadline)) deadlines.add(deadline.value.expiresAtNanos);
                return yield* command
                  .execute(executable, args, {...options, env: {...options?.env, THREADNOTE_FIXTURE_HYDRATION: 'hold'}})
                  .pipe(
                    Effect.tapError(error =>
                      Effect.gen(function* () {
                        if (Schema.is(CommandTimedOut)(error) && (yield* f.fs.exists(heldMarker).pipe(Effect.orDie))) {
                          held++;
                          interrupted++;
                        }
                      }),
                    ),
                  );
              }),
          });
          const result = yield* invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(CommandExecutor, observed),
            Effect.result,
          );
          expect(held).toBeGreaterThan(0);
          expect(interrupted).toBe(held);
          expect(deadlines.size).toBe(1);
          if (surface === 'cli') {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') expect(result.failure).toBeInstanceOf(ReadDeadlineExceeded);
          } else {
            expect(result._tag).toBe('Success');
            if (result._tag === 'Success') {
              expect(result.success.isError).toBe(true);
              expect(result.success.output).not.toContain('memories/durable/alpha.md');
            }
          }
        }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
      {timeout: 15000},
    );
  }
  effectIt.effect(
    'MCP completes an explicitly selected real Git share sync before admitting lexical reads',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false);
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const seed = path.join(f.config.agentContextHome, 'seed');
        const remote = path.join(f.config.agentContextHome, 'remote.git');
        const git = (args: readonly string[], cwd?: string) => command.execute('git', args, {cwd});
        yield* git(['init', '--bare', '--initial-branch=main', remote]);
        yield* git(['init', '--initial-branch=main', seed]);
        const filename = path.join(seed, 'durable/alpha.md');
        yield* f.fs.makeDirectory(path.dirname(filename), {recursive: true});
        yield* f.fs.writeFileString(
          filename,
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'active',
              visibility: 'shared',
              memoryId: 'tn_shared_admission',
              topic: query,
              keywords: [query],
              sourceAgentClient: 'test',
              timestamp: '2026-11-04T00:00:00.000Z',
            },
            `${query} explicitly synchronized shared baseline.`,
          ),
        );
        yield* git(['add', '.'], seed);
        yield* git(
          ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'seed'],
          seed,
        );
        yield* git(['remote', 'add', 'origin', remote], seed);
        yield* git(['push', 'origin', 'main'], seed);
        yield* runShareInit(f.config, remote, {team: 'engineering', push: false});
        yield* loadRecallIndexData(f.config, {includeInactive: false, validateNow: true});
        const root = 'threadnote://user/tester/memories/shared/engineering';
        const server = new EffectMcpServerRegistry();
        registerSearchTool(
          server,
          f.config,
          'recall_context',
          'Recall.',
          {heartbeatMilliseconds: 100},
          {
            mode: 'shared-read-write',
            shares: [{root, team: 'engineering'}],
          },
        );
        let syncCalls = 0;
        let syncFinished = 0n;
        let readCalls = 0;
        let baselineComposites = 0;
        let activeChildren = 0;
        const observed = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) =>
            Effect.gen(function* () {
              const deadline = yield* Effect.serviceOption(ReadyRecallReadDeadline);
              const sync = args.includes('fetch');
              if (sync) {
                syncCalls++;
                expect(Option.isNone(deadline)).toBe(true);
                expect(readCalls).toBe(0);
              }
              if (options?.sensitiveOutput && options.input) {
                readCalls++;
                const request = yield* Schema.decodeEffect(operationSchema)(
                  new TextDecoder().decode(options.input),
                ).pipe(Effect.orDie);
                if (request.operation === 'sections' && request.options.mode === 'baseline') {
                  baselineComposites++;
                  expect(request.options.exact?.terms.length).toBeGreaterThan(0);
                }
                expect(syncCalls).toBeGreaterThan(0);
                expect(Option.isSome(deadline)).toBe(true);
                if (Option.isSome(deadline))
                  expect(deadline.value.expiresAtNanos - 2_000_000_000n).toBeGreaterThanOrEqual(syncFinished);
                expect(options.verifyOwnedProcessExit).toBeDefined();
              }
              activeChildren++;
              return yield* command.execute(executable, args, options).pipe(
                Effect.tap(() =>
                  sync
                    ? Clock.monotonicTimeNanos.pipe(
                        Effect.tap(now =>
                          Effect.sync(() => {
                            syncFinished = now;
                          }),
                        ),
                      )
                    : Effect.void,
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    activeChildren--;
                  }),
                ),
              );
            }),
        });
        const result = yield* server
          .invokeTool('recall_context', {
            query,
            inferScope: false,
            team: 'engineering',
            responseFormat: 'dual',
          })
          .pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(CommandExecutor, observed),
          );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(JSON.stringify(result)).toContain('memories/shared/engineering/durable/alpha.md');
        expect(JSON.stringify(result)).not.toContain('memories/durable/alpha.md');
        expect(syncCalls).toBeGreaterThan(0);
        expect(baselineComposites).toBe(1);
        expect(readCalls).toBeGreaterThanOrEqual(baselineComposites);
        expect(activeChildren).toBe(0);
        expect(
          JSON.parse(
            yield* f.fs.readFileString(path.join(f.config.agentContextHome, 'share/fetch-receipts/engineering.json')),
          ),
        ).toMatchObject({
          succeeded: true,
          behind: 0,
        });
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 15000},
  );
});
