import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Clock, Effect, Fiber, FileSystem, Option, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {describe, expect} from 'vitest';
import * as EffectString from 'effect/String';
import {CommandCleanupUnconfirmed, CommandExecutor, CommandTimedOut} from '@threadnote/platform/command';
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
import {recallReadyReadRequestSchema} from '@threadnote/recall/read_boundary';
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

const embedding = Option.getOrThrow(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, value => value.id === 'bge-small-en-v1.5-q8'),
);
const operationSchema = Schema.fromJsonString(recallReadyReadRequestSchema);
const confidenceSchema = Schema.Struct({confidence: Schema.Struct({score: Schema.Finite})});
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
import {Effect, Layer, Runtime} from ${JSON.stringify(Bun.fileURLToPath(import.meta.resolve('effect')))};
import {CommandExecutor, CommandSpawnFailed} from ${JSON.stringify(Bun.fileURLToPath(import.meta.resolve('@threadnote/platform/command')))};
import {RuntimeEntrypoint} from ${JSON.stringify(Bun.fileURLToPath(import.meta.resolve('@threadnote/platform/runtime-entrypoint')))};
import {recallReadyReadWorkerProgram, readyRecallReadWorkerLayer} from ${JSON.stringify(Bun.fileURLToPath(new URL('../../src/recall/ready_read_worker.ts', import.meta.url)))};
import {telemetryChildEnvironmentPolicyLayer} from ${JSON.stringify(Bun.fileURLToPath(new URL('../../src/telemetry/session.ts', import.meta.url)))};
const commands = CommandExecutor.of({
 execute: () => Effect.fail(CommandSpawnFailed.make({args: [], executable: '<ready-read>', message: 'Ready lexical workers do not launch commands.', cause: undefined})),
 executeStreaming: () => Effect.die('Ready lexical workers do not launch commands.'),
 spawnDetached: () => Effect.succeed(false),
});
const program = recallReadyReadWorkerProgram.pipe(
 Effect.provideService(CommandExecutor, commands),
 Effect.provide(readyRecallReadWorkerLayer),
 Effect.provide(Layer.merge(telemetryChildEnvironmentPolicyLayer, Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}))),
);
Runtime.makeRunMain(({fiber, teardown}) => fiber.addObserver(exit => teardown(exit, code => {if (code !== 0) process.exit(code);} )))(program, {disableErrorReporting: true});
`,
    );
    const built = yield* Effect.tryPromise({
      try: () => Bun.build({entrypoints: [entrypoint], outdir: path.join(home, 'worker'), target: 'bun'}),
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

describe('production recall admission budget', () => {
  effectIt.effect(
    'MCP production semantic timing excludes reranker and closing proof work',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false);
        const path = yield* Path.Path;
        const liveClock = yield* Clock.Clock;
        const commands = yield* CommandExecutor;
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
                if (reranks > 0 && (request.operation === 'batch' || request.operation === 'memory-connections'))
                  closingReads++;
              }
              return yield* commands.execute(executable, args, options);
            }),
        });
        const result = yield* withProductionLogging(
          f.config.agentContextHome,
          {component: 'mcp', operation: 'recall_context'},
          invoke('mcp', f),
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
        const entrySchema = Schema.fromJsonString(
          Schema.Struct({
            event: Schema.String,
            phaseTimings: Schema.optionalKey(
              Schema.Array(
                Schema.Struct({phase: Schema.String, durationMilliseconds: Schema.Finite, outcome: Schema.String}),
              ),
            ),
          }),
        );
        const entries = yield* Effect.forEach(EffectString.split(EffectString.trim(log), '\n'), line =>
          Schema.decodeEffect(entrySchema)(line),
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
      `${surface} retains completed proof without another native read when optional work was never admitted`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(true);
          const command = yield* CommandExecutor;
          let modelCalls = 0;
          let hydrated = false;
          const operations: string[] = [];
          const fs = {
            ...f.fs,
            readFileString: (...args: Parameters<typeof f.fs.readFileString>) =>
              Effect.gen(function* () {
                const content = yield* f.fs.readFileString(...args);
                if (
                  args[0] === f.filename &&
                  !hydrated &&
                  Option.isSome(yield* Effect.serviceOption(ReadyRecallReadDeadline))
                ) {
                  hydrated = true;
                  yield* Effect.sleep(650);
                }
                return content;
              }),
          };
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
                return yield* command.execute(executable, args, options);
              }),
          });
          const runtime = LocalModelRuntime.of({
            ...fastRuntime,
            embedMany: request =>
              Effect.sync(() => {
                modelCalls++;
              }).pipe(Effect.andThen(fastRuntime.embedMany(request))),
          });
          const started = yield* Clock.monotonicTimeNanos;
          const result = yield* invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(CommandExecutor, observed),
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, f.store),
          );
          expect(hydrated).toBe(true);
          expect(modelCalls).toBe(0);
          expect(operations).toEqual(['exact', 'batch']);
          expect(result.isError, result.output).toBe(false);
          expect(result.output).toContain('memories/durable/alpha.md');
          expect(Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000).toBeLessThan(2000);
        }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
      {timeout: 15000},
    );
    effectIt.effect(
      `${surface} preserves completed reranker scores in model-free final proof`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(false);
          const before = yield* invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
          );
          yield* selectLocalModel(
            f.config.agentContextHome,
            yield* LocalModelCatalog,
            'reranker',
            'jina-reranker-v1-turbo-en-f16',
          );
          let reranks = 0;
          const runtime = LocalModelRuntime.of({
            ...fastRuntime,
            rerank: ({documents}) =>
              Effect.sync(() => {
                reranks++;
                return EffectArray.map(documents, () => 1);
              }),
          });
          const result = yield* invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, f.store),
          );
          expect(reranks).toBe(1);
          expect(result.isError, result.output).toBe(false);
          expect(result.output).toContain('memories/durable/alpha.md');
          expect(result.confidenceScore).toBeGreaterThan(before.confidenceScore ?? 1);
        }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
      {timeout: 15000},
    );
    for (const mutation of [false, true]) {
      effectIt.effect(
        `${surface} closes score-bearing refinement after a later selector returns undefined (${mutation ? 'archived' : 'current'})`,
        () =>
          Effect.gen(function* () {
            const f = yield* fixture(true);
            const lexical = mutation
              ? undefined
              : yield* invoke(surface, {
                  ...f,
                  system: {...f.system, environment: () => ({...f.system.environment(), THREADNOTE_EFFECT_AI: '0'})},
                }).pipe(
                  Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
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
            const command = yield* CommandExecutor;
            let scored = false;
            let refinedBatches = 0;
            let providerCalls = 0;
            let selectorAfterRefinement = false;
            let activeChildren = 0;
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
                  activeChildren++;
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
                        if (scored && request?.operation === 'batch') refinedBatches++;
                      }),
                    ),
                    Effect.ensuring(
                      Effect.sync(() => {
                        activeChildren--;
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
            expect(activeChildren).toBe(0);
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
        `${surface} closes current canonical proof after a reranker ${mutation}s the baseline and stalls`,
        () =>
          Effect.gen(function* () {
            const f = yield* fixture(false);
            yield* selectLocalModel(
              f.config.agentContextHome,
              yield* LocalModelCatalog,
              'reranker',
              'jina-reranker-v1-turbo-en-f16',
            );
            let calls = 0;
            let interrupted = 0;
            let closingReads = 0;
            let activeChildren = 0;
            const deadlines = new Set<bigint>();
            const timeouts: number[] = [];
            const command = yield* CommandExecutor;
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
                  if (interrupted > 0 && input?.operation === 'batch') {
                    closingReads++;
                    expect(input.options.selections).toHaveLength(1);
                    expect(input.options.selections[0]?.query).toBe('');
                    expect(input.options.selections[0]?.limit).toBe(0);
                    expect(input.options.selections[0]?.requiredUris).toContain(f.uri);
                    if (mutation === 'unavailable-closing')
                      return yield* CommandTimedOut.make({
                        executable,
                        args: [...args],
                        timeoutMs: options!.timeoutMs!,
                        message: 'Owned ready read reached its deadline.',
                      });
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
                  return yield* Effect.never.pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        interrupted++;
                      }),
                    ),
                  );
                }).pipe(Effect.orDie),
            });
            const started = yield* Clock.monotonicTimeNanos;
            const result = yield* invoke(surface, f).pipe(
              Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
              Effect.provideService(CommandExecutor, observed),
              Effect.provideService(LocalModelRuntime, runtime),
              Effect.provideService(LocalModelStore, f.store),
            );
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
          }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
        {timeout: 15000},
      );
    }
    effectIt.effect(
      `${surface} closes a successful no-op optional refinement after canonical deletion`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(true);
          const command = yield* CommandExecutor;
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
                if (deleted && input?.operation === 'batch') closingReads++;
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
          const result = yield* invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(CommandExecutor, observed),
            Effect.provideService(LocalModelRuntime, fastRuntime),
            Effect.provideService(LocalModelStore, f.store),
          );
          expect(deleted).toBe(true);
          expect(closingReads).toBeGreaterThan(0);
          expect(result.isError, result.output).toBe(false);
          expect(result.output).not.toContain('memories/durable/alpha.md');
          expect(result.output).not.toContain('useful private canonical baseline');
        }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
      {timeout: 15000},
    );
    effectIt.effect(
      `${surface} preserves unknown vocabulary child cleanup after the lexical baseline`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(false);
          const command = yield* CommandExecutor;
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
                      if (input?.operation === 'batch') completedBaseline++;
                    }),
                  ),
                );
              }),
          });
          const result = yield* invoke(surface, f, {
            query: 'unmatched project issue',
            project: 'budget-fixture',
          }).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(CommandExecutor, observed),
            Effect.result,
          );
          expect(vocabularyRequests).toBe(1);
          if (surface === 'cli') {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') expect(isReadCleanupUnconfirmed(result.failure)).toBe(true);
          } else {
            expect(result._tag).toBe('Success');
            if (result._tag === 'Success') expect(result.success.isError).toBe(true);
          }
        }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
      {timeout: 15000},
    );
    for (const mode of ['absent', 'fast', 'slow'] as const) {
      effectIt.effect(
        `${surface} returns its authorized lexical baseline with ${mode} semantic inference`,
        () =>
          Effect.gen(function* () {
            const f = yield* fixture(mode !== 'absent');
            const command = yield* CommandExecutor;
            const completedReads: number[] = [];
            const starts: number[] = [];
            let activeChildren = 0;
            let modelCalls = 0;
            let interruptedModel = 0;
            let hydrated = 0;
            let lateHydrations = 0;
            const deadlines = new Set<bigint>();
            const observedCommand = CommandExecutor.of({
              ...command,
              execute: (executable, args, options) =>
                Effect.gen(function* () {
                  const admitted = yield* Effect.serviceOption(ReadyRecallReadDeadline);
                  if (options?.sensitiveOutput && options.input) {
                    expect(Option.isSome(admitted)).toBe(true);
                    if (Option.isSome(admitted)) deadlines.add(admitted.value.expiresAtNanos);
                    expect(options.verifyOwnedProcessExit).toBeDefined();
                    expect(options.timeoutMs).toBeGreaterThan(0);
                    starts.push(options.timeoutMs!);
                    activeChildren++;
                    return yield* command.execute(executable, args, options).pipe(
                      Effect.tap(() => Effect.sync(() => completedReads.push(starts.length))),
                      Effect.ensuring(
                        Effect.sync(() => {
                          activeChildren--;
                        }),
                      ),
                    );
                  }
                  return yield* command.execute(executable, args, options);
                }),
            });
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
                  return mode === 'slow'
                    ? yield* Effect.never.pipe(
                        Effect.ensuring(
                          Effect.sync(() => {
                            interruptedModel++;
                          }),
                        ),
                      )
                    : yield* fastRuntime.embedMany(request);
                }),
            });
            const start = yield* Clock.monotonicTimeNanos;
            const result = yield* invoke(surface, f).pipe(
              Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
              Effect.provideService(CommandExecutor, observedCommand),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(LocalModelRuntime, runtime),
              Effect.provideService(LocalModelStore, f.store),
            );
            expect(Number((yield* Clock.monotonicTimeNanos) - start) / 1_000_000).toBeLessThan(2000);
            expect(result.isError, result.output).toBe(false);
            expect(result.output).toContain('memories/durable/alpha.md');
            expect(result.output).not.toContain('FOREIGN_PRIVATE_SENTINEL');
            expect(result.output).not.toContain('tn_foreign_private');
            expect(modelCalls).toBe(mode === 'absent' ? 0 : 1);
            expect(interruptedModel).toBe(mode === 'slow' ? 1 : 0);
            if (mode === 'slow') expect(lateHydrations).toBeGreaterThan(0);
            else expect(lateHydrations).toBe(0);
            expect(activeChildren).toBe(0);
            expect(completedReads.length).toBeGreaterThanOrEqual(2);
            expect(deadlines.size).toBe(1);
            for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeLessThanOrEqual(starts[i - 1]);
          }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
        {timeout: 15000},
      );
    }
    effectIt.effect(
      `${surface} retains its hydrated baseline when the selected native reranker is held`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(false);
          yield* selectLocalModel(
            f.config.agentContextHome,
            yield* LocalModelCatalog,
            'reranker',
            'jina-reranker-v1-turbo-en-f16',
          );
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
          const runtime = LocalModelRuntime.of({
            ...fastRuntime,
            rerank: () =>
              Effect.gen(function* () {
                rerankCalls++;
                hydratedBeforeRerank = hydrated;
                return yield* Effect.never.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      interrupted++;
                    }),
                  ),
                );
              }),
          });
          const started = yield* Clock.monotonicTimeNanos;
          const result = yield* invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, f.store),
          );
          expect(Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000).toBeLessThan(2000);
          expect(result.isError, result.output).toBe(false);
          expect(result.output).toContain('memories/durable/alpha.md');
          expect(result.output).not.toContain('tn_foreign_private');
          expect(rerankCalls).toBe(1);
          expect(hydratedBeforeRerank).toBeGreaterThan(0);
          expect(interrupted).toBe(1);
          expect(lateHydrations).toBeGreaterThan(0);
        }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
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
          const fs = {
            ...f.fs,
            readFileString: (...args: Parameters<typeof f.fs.readFileString>) =>
              Effect.gen(function* () {
                const deadline = yield* Effect.serviceOption(ReadyRecallReadDeadline);
                if (args[0] === f.filename && Option.isSome(deadline)) {
                  held++;
                  deadlines.add(deadline.value.expiresAtNanos);
                  return yield* Effect.never.pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        interrupted++;
                      }),
                    ),
                  );
                }
                return yield* f.fs.readFileString(...args);
              }),
          };
          const result = yield* invoke(surface, f).pipe(
            Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
            Effect.provideService(FileSystem.FileSystem, fs),
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
        expect(readCalls).toBeGreaterThanOrEqual(2);
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
