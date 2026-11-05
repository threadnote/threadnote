import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Console, Deferred, Effect, Fiber, FileSystem, Path, Result} from 'effect';
import type {SecureRandom} from 'effect/crypto';
import * as FC from 'fast-check';
import {describe, expect} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {LocalModelRuntime, type LocalModelRuntimeShape} from '@threadnote/inference/engine/local-model-runtime';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {
  recallIndexMaintenanceShouldRetry,
  RECALL_INDEX_MAINTENANCE_GENERATION_RETRY_LIMIT,
  runDevelopmentInstallIntegrationActivation,
  runDevelopmentInstallRepair,
  runRepair,
  verifyRecallIndexMaintenanceReadiness,
} from '@threadnote/threadnote/lifecycle';
import {
  installAgentIntegration,
  isExactLegacyCopilotInstructionFrontmatter,
} from '@threadnote/threadnote/agent_integration/index';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '@threadnote/inference/models/builtin';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {
  currentRecallCorpusGeneration,
  expireRecallIndexValidation,
  loadRecallIndexData,
  recallIndexStatus,
  type RecallIndexStatus,
} from '@threadnote/recall/index';
import {
  rebuildVectorIndex,
  VectorCorpusGenerationChanged,
  vectorIndexMatchesGeneration,
  vectorIndexGenerationReadiness,
} from '@threadnote/recall/vector-index';
import {readRecallEmbeddingDemand} from '@threadnote/recall/background/demand';
import {writeModelSelection} from '@threadnote/inference/models/selection';
import {InferenceInterrupted} from '@threadnote/inference/engine/errors';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const embeddingManifest = EffectOption.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === CORE_EMBEDDING_MODEL_ID),
)!;
const version = '4.6.7-local.g' + Effect2.pipe('a', EffectString.repeat(40));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-repair-'});
  const user = path.join(root, 'user');
  const home = path.join(user, '.threadnote');
  const installRoot = path.join(root, 'install');
  const releaseRoot = path.join(installRoot, 'versions', version);
  const instruction = path.join(user, '.copilot', 'instructions', 'threadnote.instructions.md');
  const registry = path.join(home, 'integrations', 'agents.json');
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'seed-manifest.yaml'),
    user: 'tester',
  };
  const testSystem = SystemInfo.of({
    ...system,
    homeDirectory: user,
    environment: () => ({
      ...system.environment(),
      THREADNOTE_INSTALL_ROOT: installRoot,
      THREADNOTE_BIN_DIR: path.join(root, 'bin'),
      NVM_DIR: undefined,
      NVM_HOME: undefined,
    }),
  });
  yield* fs.makeDirectory(releaseRoot, {recursive: true});
  yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), JSON.stringify({version}));
  const pointer = JSON.stringify({releaseRoot, version});
  yield* fs.writeFileString(path.join(installRoot, 'active-release.json'), pointer);
  yield* fs.makeDirectory(path.dirname(instruction), {recursive: true});
  yield* fs.writeFileString(instruction, 'Operator-owned instructions. Preserve verbatim.\n');
  yield* fs.makeDirectory(path.dirname(registry), {recursive: true});
  const registryContent = JSON.stringify({
    version: 1,
    legacyInstructionsMigrated: true,
    hosts: {
      copilot: {
        artifactVersion: 1,
        artifacts: {},
        installedVersion: version,
        status: 'pending',
        mcp: {name: 'threadnote', repair: true, toolset: 'core'},
      },
    },
  });
  yield* fs.writeFileString(registry, registryContent);
  const installation = {
    bytes: embeddingManifest.size,
    installed: true,
    modelId: embeddingManifest.id,
    partialBytes: 0,
    path: path.join(home, 'fixture.gguf'),
    verified: true,
  };
  const store = LocalModelStore.of({
    install: () => Effect.succeed({...installation, resumed: false, sourceUrl: 'fixture://embedding'}),
    path: () => installation.path,
    remove: () => Effect.succeed(false),
    status: () => Effect.succeed(installation),
    verify: () => Effect.succeed(installation),
  });
  const runtimeContext = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | SystemInfo | SecureRandom.SecureRandom
  >();
  const embeddingRuntime = (
    beforeEmbedding: () => Effect.Effect<
      void,
      unknown,
      FileSystem.FileSystem | Path.Path | SystemInfo | SecureRandom.SecureRandom
    > = () => Effect.void,
  ): LocalModelRuntimeShape =>
    LocalModelRuntime.of({
      diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
      embedMany: ({inputs, manifest}) =>
        beforeEmbedding().pipe(
          Effect.provide(runtimeContext),
          Effect.orDie,
          Effect.as(EffectArray.map(inputs, () => [1, ...new Array<number>((manifest.dimensions ?? 1) - 1).fill(0)])),
        ),
      generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
      rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
    });
  const provideWithRuntime = <A, E, R>(program: Effect.Effect<A, E, R>, runtime: LocalModelRuntimeShape) =>
    program.pipe(
      Effect.provideService(SystemInfo, testSystem),
      Effect.provideService(LocalModelStore, store),
      Effect.provideService(LocalModelRuntime, runtime),
    );
  const provide = <A, E, R>(program: Effect.Effect<A, E, R>) => provideWithRuntime(program, embeddingRuntime());
  return {
    config,
    embeddingRuntime,
    fs,
    home,
    instruction,
    installRoot,
    path,
    pointer,
    provide,
    provideWithRuntime,
    releaseRoot,
    registry,
    registryContent,
    user,
  };
});

describe('development installer repair isolation', () => {
  effectIt.effect('makes the lexical status the final readiness fence after observing the vector generation', () =>
    Effect.gen(function* () {
      const requestedGeneration = 'requested-generation';
      const observations: string[] = [];
      let lexicalStatus: RecallIndexStatus = {
        databasePath: '/fixture/lexical.sqlite',
        documentCount: 1,
        generation: requestedGeneration,
        ready: true,
      };
      const error = yield* verifyRecallIndexMaintenanceReadiness({
        manifestId: embeddingManifest.id,
        readLexicalStatus: () =>
          Effect.sync(() => {
            observations.push('lexical');
            return lexicalStatus;
          }),
        readVectorReadiness: () =>
          Effect.sync(() => {
            observations.push('vector');
            lexicalStatus = {
              databasePath: '/fixture/lexical.sqlite',
              documentCount: 1,
              generation: requestedGeneration,
              ready: false,
              reason: 'canonical documents changed; run `threadnote repair`',
            };
            return 'current' as const;
          }),
        requestedGeneration,
      }).pipe(Effect.flip);

      expect(observations).toEqual(['vector', 'lexical']);
      expect(error).toBeInstanceOf(VectorCorpusGenerationChanged);
      expect(recallIndexMaintenanceShouldRetry(error, 0)).toBe(true);
    }),
  );

  fcEffectProp(
    effectIt,
    'fails non-current vector readiness without reclassifying it as retryable corpus churn',
    {
      readiness: FC.constantFrom('corrupt' as const, 'missing' as const, 'stale' as const),
    },
    ({readiness}) =>
      Effect.gen(function* () {
        let lexicalReads = 0;
        const error = yield* verifyRecallIndexMaintenanceReadiness({
          manifestId: embeddingManifest.id,
          readLexicalStatus: () =>
            Effect.sync(() => {
              lexicalReads += 1;
              return {
                databasePath: '/fixture/lexical.sqlite',
                documentCount: 1,
                generation: 'requested-generation',
                ready: true,
              } satisfies RecallIndexStatus;
            }),
          readVectorReadiness: () => Effect.succeed(readiness),
          requestedGeneration: 'requested-generation',
        }).pipe(Effect.flip);

        expect(error).toMatchObject({_tag: 'LifecycleOperationError'});
        expect(recallIndexMaintenanceShouldRetry(error, 0)).toBe(false);
        expect(lexicalReads).toBe(0);
      }),
    {fastCheck: {numRuns: 100}},
  );

  fcEffectProp(
    effectIt,
    'retries only bounded lexical corpus generation changes',
    {
      completedRetries: FC.integer({max: RECALL_INDEX_MAINTENANCE_GENERATION_RETRY_LIMIT + 3, min: -2}),
      generationChanged: FC.boolean(),
    },
    ({completedRetries, generationChanged}) =>
      Effect.sync(() => {
        const error = generationChanged
          ? VectorCorpusGenerationChanged.make({
              message: 'The lexical recall corpus changed while vector work was in progress.',
              modelId: embeddingManifest.id,
              requestedGeneration: 'fixture-generation',
            })
          : new Error('unrelated repair failure');
        expect(recallIndexMaintenanceShouldRetry(error, completedRetries)).toBe(
          generationChanged &&
            completedRetries >= 0 &&
            completedRetries < RECALL_INDEX_MAINTENANCE_GENERATION_RETRY_LIMIT,
        );
      }),
    {fastCheck: {numRuns: 100}},
  );

  fcEffectProp(
    effectIt,
    'recognizes only the exact markerless legacy Copilot instructions',
    {
      extraKey: FC.array(FC.constantFrom(...'abcdefghijklmnopqrstuvwxyz'), {maxLength: 16, minLength: 1}).map(chars =>
        EffectArray.join(chars, ''),
      ),
      lineEnding: FC.constantFrom('\n', '\r\n'),
      trailingNewlines: FC.integer({max: 3, min: 1}),
    },
    ({extraKey, lineEnding, trailingNewlines}) =>
      Effect.sync(() => {
        const legacyLines = [
          '---',
          'name: Threadnote',
          'description: Shared local context and handoffs through Threadnote',
          'applyTo: "**"',
          '---',
        ];
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        const exact = `${EffectArray.join(legacyLines, lineEnding)}${lineEnding.repeat(trailingNewlines)}`;
        const customized = EffectArray.join([...legacyLines.slice(0, -1), `${extraKey}: keep-me`, '---'], lineEnding);

        expect(isExactLegacyCopilotInstructionFrontmatter(exact)).toBe(true);
        expect(isExactLegacyCopilotInstructionFrontmatter(customized)).toBe(false);
      }),
    {fastCheck: {numRuns: 100}},
  );

  effectIt.effect('waits for vector repair before the development installer reports recall readiness', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const memoryPath = f.path.join(f.home, 'data/local/resources/repos/demo/document.md');
      yield* f.fs.makeDirectory(f.path.dirname(memoryPath), {recursive: true});
      yield* f.fs.writeFileString(memoryPath, '# Example\n\nInitial canonical body.');
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let embeddingAttempts = 0;
      const runtime = f.embeddingRuntime(() =>
        Effect.sync(() => {
          embeddingAttempts += 1;
        }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Deferred.await(release))),
      );
      const output: string[] = [];
      const fiber = yield* Console.consoleWith(parent =>
        f.provideWithRuntime(runDevelopmentInstallRepair(f.config, version), runtime).pipe(
          Effect.provideService(Console.Console, {
            ...parent,
            log: (...args) => {
              output.push(EffectArray.join(EffectArray.map(args, String), ' '));
            },
          }),
          Effect.forkChild,
        ),
      );
      yield* Deferred.await(started);
      expect(EffectArray.some(output, EffectString.includes('indexes are ready'))).toBe(false);
      expect(embeddingAttempts).toBe(1);
      expect(yield* readRecallEmbeddingDemand(f.config)).toBeUndefined();
      expect((yield* recallIndexStatus(f.config)).ready).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      const lexical = yield* recallIndexStatus(f.config);
      expect(lexical).toMatchObject({ready: true, documentCount: 1});
      expect(yield* vectorIndexGenerationReadiness(f.home, embeddingManifest, lexical.generation!)).toBe('current');
      expect(EffectArray.some(output, EffectString.includes('indexes are ready'))).toBe(true);
      expect(yield* f.fs.readFileString(memoryPath)).toBe('# Example\n\nInitial canonical body.');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.each(['inference', 'corpus', 'selection'] as const)(
    'fails explicit repair on %s failure without claiming readiness',
    failure =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const memoryPath = f.path.join(f.home, 'data/local/resources/repos/demo/document.md');
        yield* f.fs.makeDirectory(f.path.dirname(memoryPath), {recursive: true});
        yield* f.fs.writeFileString(memoryPath, '# Example\n\nInitial canonical body.');
        const runtime =
          failure === 'inference'
            ? LocalModelRuntime.of({
                ...f.embeddingRuntime(),
                embedMany: () =>
                  InferenceInterrupted.make({
                    message: 'Synthetic embedding failure',
                    modelId: embeddingManifest.id,
                    operation: 'embedMany',
                  }),
              })
            : f.embeddingRuntime(() =>
                failure === 'selection'
                  ? writeModelSelection(f.home, {version: 1, roles: {}})
                  : f.fs
                      .writeFileString(memoryPath, '# Changed\n\nConcurrent canonical body.')
                      .pipe(
                        Effect.andThen(
                          expireRecallIndexValidation(f.home, false, ['threadnote://resources/repos/demo/document.md']),
                        ),
                      ),
              );
        const result = yield* f.provideWithRuntime(
          captureConsole(
            runRepair(f.config, {
              coreOnly: true,
              postUpdate: false,
              skipReleaseLifecycle: true,
            }).pipe(Effect.result),
          ),
          runtime,
        );
        expect(Result.isFailure(result.value)).toBe(true);
        if (Result.isFailure(result.value))
          expect(result.value.failure).toMatchObject({
            message: expect.stringContaining('Recall index repair failed'),
          });
        expect(result.output).not.toContain('indexes are ready');
        expect(result.output).not.toContain('Document embeddings queued');
        const lexical = yield* recallIndexStatus(f.config);
        if (lexical.generation)
          expect(yield* vectorIndexMatchesGeneration(f.home, embeddingManifest, lexical.generation)).toBe(false);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('dry-run repair leaves canonical bytes and derived indexes untouched', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const memoryPath = f.path.join(f.home, 'data/local/resources/repos/demo/document.md');
      const canonical = '# Example\n\nPreserve this canonical body.';
      yield* f.fs.makeDirectory(f.path.dirname(memoryPath), {recursive: true});
      yield* f.fs.writeFileString(memoryPath, canonical);
      const selection = f.path.join(f.home, 'models', 'selection.json');
      const result = yield* f.provide(
        captureConsole(
          runRepair(f.config, {
            coreOnly: true,
            dryRun: true,
            postUpdate: false,
            skipReleaseLifecycle: true,
          }),
        ),
      );
      expect(result.output).toContain('Would synchronously rebuild lexical and vector recall indexes');
      expect(result.output).not.toContain('indexes are ready');
      expect(yield* f.fs.readFileString(memoryPath)).toBe(canonical);
      expect(yield* f.fs.exists(f.path.join(f.home, 'indexes'))).toBe(false);
      expect(yield* f.fs.exists(selection)).toBe(false);
      expect(yield* f.fs.readFileString(f.registry)).toBe(f.registryContent);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'repeated repair preserves canonical bytes and maintains current recall generations',
    {
      body: FC.string({minLength: 1, maxLength: 120}),
    },
    ({body}) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const memoryPath = f.path.join(f.home, 'data/local/resources/repos/demo/document.md');
        const canonical = `# Generated\n\n${body}`;
        yield* f.fs.makeDirectory(f.path.dirname(memoryPath), {recursive: true});
        yield* f.fs.writeFileString(memoryPath, canonical);
        let embeddingAttempts = 0;
        const runtime = f.embeddingRuntime(() =>
          Effect.sync(() => {
            embeddingAttempts += 1;
          }),
        );
        yield* f.provideWithRuntime(captureConsole(runDevelopmentInstallRepair(f.config, version)), runtime);
        const previousAttempts = embeddingAttempts;
        yield* f.provideWithRuntime(captureConsole(runDevelopmentInstallRepair(f.config, version)), runtime);
        expect(embeddingAttempts).toBe(previousAttempts);
        expect(yield* f.fs.readFileString(memoryPath)).toBe(canonical);
        const lexical = yield* recallIndexStatus(f.config);
        expect(lexical.ready).toBe(true);
        expect(yield* vectorIndexGenerationReadiness(f.home, embeddingManifest, lexical.generation!)).toBe('current');
      }).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 4}},
  );

  effectIt.effect('rejects an explicit vector rebuild superseded by a canonical write during inference', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const uri = 'threadnote://user/tester/memories/handoffs/active/threadnote/install-repair.md';
        const memoryPath = f.path.join(
          f.home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'handoffs',
          'active',
          'threadnote',
          'install-repair.md',
        );
        yield* f.fs.makeDirectory(f.path.dirname(memoryPath), {recursive: true});
        yield* f.fs.writeFileString(memoryPath, handoffDocument('Initial handoff body.'));
        let embeddingAttempts = 0;
        const runtime = f.embeddingRuntime(() =>
          Effect.gen(function* () {
            embeddingAttempts += 1;
            yield* f.fs.writeFileString(memoryPath, handoffDocument(`Concurrent handoff body ${embeddingAttempts}.`));
            yield* expireRecallIndexValidation(f.home, false, [uri]);
          }),
        );

        const initial = yield* loadRecallIndexData(f.config, {includeInactive: false});
        const error = yield* f
          .provideWithRuntime(
            rebuildVectorIndex(f.config, embeddingManifest, initial.candidates, {
              corpusGeneration: initial.generation,
              currentCorpusGeneration: () => currentRecallCorpusGeneration(f.config),
            }),
            runtime,
          )
          .pipe(Effect.flip);

        expect(error).toMatchObject({_tag: 'VectorCorpusGenerationChanged'});
        expect(embeddingAttempts).toBe(1);
        expect(yield* vectorIndexMatchesGeneration(f.home, embeddingManifest, initial.generation)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('repairs core indexes while preserving unmanaged host instructions and integration receipts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const instruction = yield* f.fs.readFileString(f.instruction);
        const result = yield* f.provide(captureConsole(runDevelopmentInstallRepair(f.config, version)));
        expect(result.output).toContain('Lexical recall prepared: 0 canonical document(s).');
        expect(yield* f.fs.readFileString(f.instruction)).toBe(instruction);
        expect(yield* f.fs.readFileString(f.registry)).toBe(f.registryContent);
        expect(yield* f.fs.readFileString(f.path.join(f.installRoot, 'active-release.json'))).toBe(f.pointer);
        const coreRepair = yield* f.provide(
          captureConsole(
            runRepair(f.config, {
              coreOnly: true,
              mcp: 'none',
              postUpdate: false,
              skipReleaseLifecycle: true,
            }),
          ),
        );
        expect(coreRepair.output).toContain('Lexical recall prepared: 0 canonical document(s).');
        expect(coreRepair.output).toContain('Skipping host instructions, hooks, and MCP client repair');
        expect(yield* f.fs.readFileString(f.instruction)).toBe(instruction);
        expect(yield* f.fs.readFileString(f.registry)).toBe(f.registryContent);
        const explicitRepair = yield* f
          .provide(
            runRepair(f.config, {
              mcp: 'none',
              postUpdate: false,
              skipReleaseLifecycle: true,
            }),
          )
          .pipe(Effect.flip);
        expect(explicitRepair).toMatchObject({message: expect.stringContaining('is not managed by Threadnote')});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('activates and verifies registered agent integration artifacts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.remove(f.instruction, {force: true});
        yield* f.fs.remove(f.registry, {force: true});
        yield* writeAgentIntegrationPayload(f.fs, f.path, f.releaseRoot);
        yield* f.provide(
          installAgentIntegration(f.config, 'copilot', {
            dryRun: false,
            name: 'threadnote',
            toolset: 'core',
          }),
        );
        const skill = f.path.join(f.user, '.copilot', 'skills', 'threadnote-context', 'SKILL.md');
        const expectedInstruction = yield* f.fs.readFileString(f.instruction);
        const expectedSkill = yield* f.fs.readFileString(skill);
        yield* f.fs.writeFileString(
          f.instruction,
          EffectArray.join(
            [
              '---',
              'name: Threadnote',
              'description: Shared local context and handoffs through Threadnote',
              'applyTo: "**"',
              '---',
              '',
            ],
            '\n',
          ),
        );
        yield* f.fs.writeFileString(
          skill,
          Effect2.pipe(expectedSkill, EffectString.replace('Current context skill.', 'Stale context skill.')),
        );
        const registry: unknown = JSON.parse(yield* f.fs.readFileString(f.registry));
        if (!Predicate.isObject(registry)) throw new Error('expected an agent integration registry object');
        registry.surfaces = {
          'historical-agent': {
            adapterVersion: 1,
            agentId: 'historical-agent',
            artifactDescriptors: [],
            artifacts: {},
            installedVersion: version,
            mcp: {
              createdContainer: false,
              createdFile: false,
              hash: Effect2.pipe('a', EffectString.repeat(64)),
              name: 'threadnote',
              path: f.path.join(f.user, '.historical-agent', 'mcp.json'),
              toolset: 'core',
            },
            root: f.path.join(f.user, '.historical-agent'),
            skillRoot: f.path.join(f.user, '.historical-agent', 'skills'),
            status: 'current',
            strategy: {codec: 'json', container: 'mcpServers', kind: 'json'},
            surfaceId: 'historical-agent',
          },
        };
        yield* f.fs.writeFileString(f.registry, JSON.stringify(registry));

        yield* f.provide(runDevelopmentInstallIntegrationActivation(f.config, version));

        expect(yield* f.fs.readFileString(f.instruction)).toBe(expectedInstruction);
        expect(yield* f.fs.readFileString(skill)).toBe(expectedSkill);
        expect(yield* f.fs.readFileString(f.path.join(f.installRoot, 'active-release.json'))).toBe(f.pointer);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves customized markerless Copilot instructions', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.remove(f.instruction, {force: true});
        yield* f.fs.remove(f.registry, {force: true});
        yield* writeAgentIntegrationPayload(f.fs, f.path, f.releaseRoot);
        yield* f.provide(
          installAgentIntegration(f.config, 'copilot', {
            dryRun: false,
            name: 'threadnote',
            toolset: 'core',
          }),
        );
        const customizedInstruction = EffectArray.join(
          [
            '---',
            'name: Threadnote',
            'description: Shared local context and handoffs through Threadnote',
            'applyTo: "**"',
            'custom: keep-me',
            '---',
            '',
          ],
          '\n',
        );
        yield* f.fs.writeFileString(f.instruction, customizedInstruction);

        const error = yield* f.provide(runDevelopmentInstallIntegrationActivation(f.config, version)).pipe(Effect.flip);

        expect(error).toMatchObject({message: expect.stringContaining('is not managed by Threadnote')});
        expect(yield* f.fs.readFileString(f.instruction)).toBe(customizedInstruction);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('still fails when required graph maintenance cannot inspect its derived root', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const repositories = f.path.join(f.home, 'indexes', 'code-graph', 'repositories');
        yield* f.fs.makeDirectory(f.path.dirname(repositories), {recursive: true});
        yield* f.fs.writeFileString(repositories, 'not a directory');
        const error = yield* f.provide(runDevelopmentInstallRepair(f.config, version)).pipe(Effect.flip);
        expect(error).toMatchObject({message: expect.stringContaining('Native code graph repair failed')});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a changed active version before repair', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const error = yield* f.provide(runDevelopmentInstallRepair(f.config, '4.6.7')).pipe(Effect.flip);
        expect(error).toMatchObject({message: 'The active release changed during development installer repair.'});
        expect(yield* f.fs.exists(f.path.join(f.home, 'indexes'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function handoffDocument(body: string): string {
  return EffectArray.join(
    [
      'HANDOFF',
      'kind: handoff',
      'status: active',
      'project: threadnote',
      'topic: install-repair',
      'source_agent_client: codex',
      'timestamp: 2026-09-18T08:00:00.000Z',
      '',
      body,
    ],
    '\n',
  );
}

function writeAgentIntegrationPayload(fs: FileSystem.FileSystem, path: Path.Path, releaseRoot: string) {
  return Effect.gen(function* () {
    const configRoot = path.join(releaseRoot, 'config');
    yield* fs.makeDirectory(path.join(configRoot, 'agent-skills'), {recursive: true});
    yield* fs.writeFileString(path.join(configRoot, 'agent-instructions.md'), 'Current agent instructions.\n');
    for (const skill of ['threadnote-context', 'threadnote-code-graph', 'threadnote-memory'] as const) {
      const skillRoot = path.join(configRoot, 'agent-skills', skill);
      yield* fs.makeDirectory(skillRoot, {recursive: true});
      yield* fs.writeFileString(
        path.join(skillRoot, 'SKILL.md'),
        EffectArray.join(
          [
            '---',
            `name: ${skill}`,
            `description: Current ${skill} fixture.`,
            '---',
            '',
            '<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->',
            skill === 'threadnote-context' ? 'Current context skill.' : `Current ${skill} skill.`,
            '<!-- END THREADNOTE USER INSTRUCTIONS -->',
            '',
          ],
          '\n',
        ),
      );
    }
  });
}
