import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema} from 'effect';
import {McpSchema, McpServer} from 'effect/ai';
import {describe, expect} from 'vitest';
import {
  BackgroundInferenceAdmission,
  backgroundInferenceAdmissionStateSchema,
} from '@threadnote/inference/background/admission';
import {EffectMcpServerRegistry} from '@threadnote/threadnote/effect/ai/mcp';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {withThreadnoteProcessRegistration} from '@threadnote/threadnote/process/diagnostics';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('logical foreground inference admission', () => {
  effectIt.effect('leases one MCP tool/resource request and releases it while the MCP host remains resident', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'mcp-foreground-'});
      const filename = path.join(home, 'locks/inference-idle-v1/state.json');
      const read = fs
        .readFileString(filename)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(backgroundInferenceAdmissionStateSchema))));
      const tools: Array<
        (payload: Record<string, unknown>) => Effect.Effect<unknown, unknown, McpSchema.McpRequestContext>
      > = [];
      const resources: Array<
        (uri: string, parameters: Array<string>) => Effect.Effect<unknown, unknown, McpSchema.McpRequestContext>
      > = [];
      const liveServer = yield* McpServer.McpServer.make;
      const serverLayer = Layer.succeed(McpServer.McpServer, {
        ...liveServer,
        addTool: options =>
          Effect.sync(() => {
            tools.push(options.handle);
          }),
        addResourceTemplate: options =>
          Effect.sync(() => {
            resources.push(options.handle);
          }),
      });
      const registry = new EffectMcpServerRegistry();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      registry.registerTool('held', {inputSchema: {}, description: 'Test logical foreground work.'}, () =>
        Effect.gen(function* () {
          expect((yield* read).foreground).toHaveLength(1);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return {content: [{type: 'text', text: 'complete'}]};
        }),
      );
      registry.registerResourceTemplate(
        {name: 'test', uriTemplate: 'threadnote://test/{name}', routerPath: '/test/:name'},
        () =>
          Effect.gen(function* () {
            expect((yield* read).foreground).toHaveLength(1);
            return {contents: [{uri: 'threadnote://test/example', text: 'complete'}]};
          }).pipe(Effect.orDie),
      );
      yield* Layer.build(registry.registrationLayer({productionLogHome: home}).pipe(Layer.provide(serverLayer)));
      expect(yield* fs.exists(filename)).toBe(false);
      expect(tools).toHaveLength(1);
      const client = McpSchema.McpRequestContext.of({
        clientId: 1,
        protocolVersion: '2025-11-25',
        clientCapabilities: {},
      });
      const request = yield* tools[0]({}).pipe(
        Effect.provideService(McpSchema.McpRequestContext, client),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      const admission = yield* BackgroundInferenceAdmission;
      expect(yield* admission.runBatch(home, 'recall', Effect.die('foreground overlap'))).toEqual({
        state: 'deferred',
        reason: 'foreground',
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(request);
      expect((yield* read).foreground).toEqual([]);
      yield* resources[0]('threadnote://test/example', ['example']).pipe(
        Effect.provideService(McpSchema.McpRequestContext, client),
      );
      expect((yield* read).foreground).toEqual([]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  for (const role of ['cli', 'mcp', 'local-model-worker'] as const)
    effectIt.effect(`classifies ${role} residency without holding a spurious foreground lease`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'cli-foreground-'});
        const filename = path.join(home, 'locks/inference-idle-v1/state.json');
        yield* withThreadnoteProcessRegistration(
          home,
          role,
          Effect.gen(function* () {
            if (role === 'cli') {
              const state = yield* fs
                .readFileString(filename)
                .pipe(
                  Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(backgroundInferenceAdmissionStateSchema))),
                );
              expect(state.foreground).toHaveLength(1);
            } else expect(yield* fs.exists(filename)).toBe(false);
          }),
        );
        if (role === 'cli') {
          const state = yield* fs
            .readFileString(filename)
            .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(backgroundInferenceAdmissionStateSchema))));
          expect(state.foreground).toEqual([]);
        }
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  for (const operation of ['workflow-watch-collector', 'recall-embedding'])
    effectIt.effect(`keeps idle ${operation} orchestration out of foreground admission`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'private-worker-admission-'});
        yield* withThreadnoteProcessRegistration(
          home,
          'cli',
          Effect.gen(function* () {
            expect(yield* fs.exists(path.join(home, 'locks/inference-idle-v1/state.json'))).toBe(false);
          }),
          operation,
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
});
