import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {EffectMcpServerRegistry} from '@threadnote/threadnote/effect/ai/mcp';
import {describe, expect} from 'vitest';
import {TestError} from '@threadnote/testing/test-error';
import {LocalModelRuntime, type LocalEmbeddingError} from '@threadnote/inference/engine/local-model-runtime';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {registerCompactTool} from '@threadnote/threadnote/mcp/server/memory';
import {runCompact} from '@threadnote/threadnote/memory/commands';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import {loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import {ensureVectorIndex, vectorIndexGenerationReadiness} from '@threadnote/recall/vector-index';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const manifest = EffectOption.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'bge-small-en-v1.5-q8'),
)!;

describe('composite memory mutation recall refresh', () => {
  it.effect('restores lexical and already-built selected vector readiness after CLI and MCP compact mutations', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runtime = fakeRuntime((inputs, dimensions) =>
          Effect.succeed(EffectArray.map(inputs, () => unitVector(dimensions))),
        );

        yield* Effect.forEach(['cli', 'mcp'] as const, surface =>
          Effect.gen(function* () {
            const home = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-${surface}-compact-index-refresh-`});
            const config: RuntimeConfig = {
              account: 'local',
              agentContextHome: home,
              agentId: 'test',
              manifestPath: path.join(home, 'seed-manifest.yaml'),
              user: 'tester',
            };
            yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
            yield* writeCompositeFixture(config);

            const catalog = yield* LocalModelCatalog;
            yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
            const initial = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
            yield* ensureVectorIndex(config, manifest, initial.candidates, {corpusGeneration: initial.generation});

            if (surface === 'cli') {
              yield* runCompact(config, {apply: true, project: 'threadnote'});
            } else {
              const result = yield* invokeCompactContext(config);
              expect(result.isError).not.toBe(true);
            }

            const refreshed = yield* recallIndexStatus(config);
            expect(refreshed.ready).toBe(true);
            expect(refreshed.generation).not.toBe(initial.generation);
            expect(yield* vectorIndexGenerationReadiness(home, manifest, refreshed.generation!)).toBe('current');
            const candidates = yield* loadRecallIndexData(config, {includeInactive: false});
            expect(candidates.candidates).toHaveLength(1);
            expect(candidates.candidates[0]?.uri).toContain('/durable/projects/threadnote/');
          }).pipe(
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, installedModelStore()),
          ),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const writeCompositeFixture = Effect.fn('test.writeCompositeFixture')(function* (config: RuntimeConfig) {
  const store = yield* ResourceStore;
  const location = {account: config.account, home: config.agentContextHome, user: config.user};
  const duplicate = formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-18T00:00:00.000Z',
      topic: 'duplicate',
    },
    'Synthetic exact duplicate retained by composite compaction.',
  );
  const archived = formatMemoryDocument(
    'HANDOFF',
    {
      kind: 'handoff',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-07-01T00:00:00.000Z',
      topic: 'expired-handoff',
    },
    'Status: complete. Synthetic archival candidate.',
  );
  yield* store.write(
    location,
    'threadnote://user/tester/memories/durable/projects/threadnote/duplicate-a.md',
    duplicate,
    {mode: 'create'},
  );
  yield* store.write(
    location,
    'threadnote://user/tester/memories/durable/projects/threadnote/duplicate-b.md',
    duplicate,
    {mode: 'create'},
  );
  yield* store.write(
    location,
    'threadnote://user/tester/memories/handoffs/active/threadnote/expired-handoff.md',
    archived,
    {mode: 'create'},
  );
});

function invokeCompactContext(config: RuntimeConfig) {
  const server = new EffectMcpServerRegistry();
  registerCompactTool(server, config);
  return server.invokeTool('compact_context', {apply: true, dryRun: false, project: 'threadnote'});
}

function fakeRuntime(
  embed: (
    inputs: readonly string[],
    dimensions: number,
  ) => Effect.Effect<readonly (readonly number[])[], LocalEmbeddingError>,
) {
  return LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
    embedMany: ({inputs, manifest: requested}) => embed(inputs, requested.dimensions ?? 0),
    generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
    rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
  });
}

function installedModelStore(): LocalModelStoreShape {
  const installation = {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: '/tmp/threadnote-test-model.gguf',
    verified: true,
  };
  return LocalModelStore.of({
    install: () => Effect.die(TestError.make({message: 'Unexpected install'})),
    path: () => installation.path,
    remove: () => Effect.succeed(false),
    status: () => Effect.succeed(installation),
    verify: () => Effect.succeed(installation),
  });
}

function unitVector(dimensions: number): readonly number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[0] = 1;
  return vector;
}
