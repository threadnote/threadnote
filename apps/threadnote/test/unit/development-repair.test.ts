import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
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
  type RecallIndexStatus,
} from '@threadnote/recall/index';
import {VectorCorpusGenerationChanged, vectorIndexMatchesGeneration} from '@threadnote/recall/vector-index';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';

const embeddingManifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === CORE_EMBEDDING_MODEL_ID)!;
const version = '4.6.7-local.g' + 'a'.repeat(40);

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
  const runtimeContext = yield* Effect.context<FileSystem.FileSystem | Path.Path | SystemInfo>();
  const embeddingRuntime = (
    beforeEmbedding: () => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path | SystemInfo> = () =>
      Effect.void,
  ): LocalModelRuntimeShape =>
    LocalModelRuntime.of({
      diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
      embedMany: ({inputs, manifest}) =>
        beforeEmbedding().pipe(
          Effect.provide(runtimeContext),
          Effect.orDie,
          Effect.as(inputs.map(() => [1, ...new Array<number>((manifest.dimensions ?? 1) - 1).fill(0)])),
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
        chars.join(''),
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
        const exact = `${legacyLines.join(lineEnding)}${lineEnding.repeat(trailingNewlines)}`;
        const customized = [...legacyLines.slice(0, -1), `${extraKey}: keep-me`, '---'].join(lineEnding);

        expect(isExactLegacyCopilotInstructionFrontmatter(exact)).toBe(true);
        expect(isExactLegacyCopilotInstructionFrontmatter(customized)).toBe(false);
      }),
    {fastCheck: {numRuns: 100}},
  );

  effectIt.effect('retries an exact-current recall repair when a concurrent canonical write changes the corpus', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const uri = 'threadnote://user/tester/memories/handoffs/active/threadnote/install-repair.md';
        const memoryRoot = f.path.join(f.home, 'data', 'local', 'user', 'tester', 'memories', 'handoffs', 'active');
        const memoryPath = f.path.join(memoryRoot, 'threadnote', 'install-repair.md');
        yield* f.fs.makeDirectory(f.path.dirname(memoryPath), {recursive: true});
        yield* f.fs.writeFileString(memoryPath, handoffDocument('Initial handoff body.'));
        let embeddingAttempts = 0;
        const runtime = f.embeddingRuntime(() =>
          Effect.gen(function* () {
            embeddingAttempts += 1;
            if (embeddingAttempts !== 1) return;
            yield* f.fs.writeFileString(memoryPath, handoffDocument('Concurrent handoff body.'));
            yield* expireRecallIndexValidation(f.home, false, [uri]);
          }),
        );

        const result = yield* f.provideWithRuntime(
          captureConsole(runDevelopmentInstallRepair(f.config, version)),
          runtime,
        );
        const corpusGeneration = yield* currentRecallCorpusGeneration(f.config);

        expect(result.output).toContain('Rebuilt recall indexes for 1 document(s)');
        expect(embeddingAttempts).toBe(2);
        expect(corpusGeneration._tag).toBe('Some');
        if (corpusGeneration._tag === 'Some') {
          expect(yield* vectorIndexMatchesGeneration(f.home, embeddingManifest, corpusGeneration.value)).toBe(true);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails after a bounded number of recall repair attempts under persistent canonical writes', () =>
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

        const error = yield* f
          .provideWithRuntime(runDevelopmentInstallRepair(f.config, version), runtime)
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          message: expect.stringContaining('lexical recall corpus changed while vector work was in progress'),
        });
        expect(embeddingAttempts).toBe(3);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('repairs core indexes while preserving unmanaged host instructions and integration receipts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const instruction = yield* f.fs.readFileString(f.instruction);
        const result = yield* f.provide(captureConsole(runDevelopmentInstallRepair(f.config, version)));
        expect(result.output).toContain('Rebuilt recall indexes for 0 document(s)');
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
        expect(coreRepair.output).toContain('Rebuilt recall indexes for 0 document(s)');
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
          [
            '---',
            'name: Threadnote',
            'description: Shared local context and handoffs through Threadnote',
            'applyTo: "**"',
            '---',
            '',
          ].join('\n'),
        );
        yield* f.fs.writeFileString(skill, expectedSkill.replace('Current context skill.', 'Stale context skill.'));
        const registry = JSON.parse(yield* f.fs.readFileString(f.registry)) as {surfaces?: Record<string, unknown>};
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
              hash: 'a'.repeat(64),
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
        const customizedInstruction = [
          '---',
          'name: Threadnote',
          'description: Shared local context and handoffs through Threadnote',
          'applyTo: "**"',
          'custom: keep-me',
          '---',
          '',
        ].join('\n');
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
  return [
    'HANDOFF',
    'kind: handoff',
    'status: active',
    'project: threadnote',
    'topic: install-repair',
    'source_agent_client: codex',
    'timestamp: 2026-09-18T08:00:00.000Z',
    '',
    body,
  ].join('\n');
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
        ].join('\n'),
      );
    }
  });
}
