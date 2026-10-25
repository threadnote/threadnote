import * as BunServices from '@effect/platform-bun/BunServices';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import {it as effectIt} from '@effect/vitest';
import {Context, Deferred, Effect, Exit, FileSystem, Fiber, Layer, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {TestClock} from 'effect/testing';
import {McpSchema, McpServer} from 'effect/ai';
import {expect} from 'vitest';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphIndexer, resumeExistingCodeGraphEmbeddingDemand} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphWatcher} from '@threadnote/graph/watcher';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphEmbeddingWorkerProcess} from '@threadnote/graph/runtime_ports';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphParserPool} from '@threadnote/graph/parser_worker';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import {resolveCodeGraphScopeRoute} from '@threadnote/graph/scope/routing';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {serveCodeGraphDiscoveryRead} from '@threadnote/graph/isolated/impact_query';
import {readCodeGraphEmbeddingDemandPage} from '@threadnote/graph/vector/demand';
import {runCodeGraphEmbeddingWorkerUnit} from '@threadnote/graph/vector/worker';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {EffectMcpServerAdapter, type EffectMcpServer} from '../../src/effect/ai/mcp.js';
import {registerCodeGraphTool} from '../../src/mcp/server/code_graph.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fixtureLayer, manifest} from '../fixtures/code-graph-embedding-worker-child.js';

/** Real registered route, real discovery/index/query/storage; only model and process boundaries are held in-process. */
for (const scoped of [false, true])
  effectIt.effect(
    `registered ${scoped ? 'scoped monorepo' : 'full-repository'} automatic index returns structure while inference is held, then semantic-only evidence without reindex`,
    () => {
      const inferenceStarted = Deferred.makeUnsafe<void>();
      const releaseInference = Deferred.makeUnsafe<void>();
      let inference = 0;
      let wakes = 0;
      let runRead: (input: string) => Effect.Effect<string, unknown> = () => Effect.die('read adapter not initialized');
      let wake: (home: string) => Effect.Effect<boolean, unknown> = () => Effect.succeed(false);
      const runtime = Layer.succeed(
        LocalModelRuntime,
        LocalModelRuntime.of({
          diagnostics: Effect.succeed({backend: 'fixture', buildType: 'prebuilt', cpuMathCores: 1}),
          embedMany: ({inputs}) =>
            Effect.gen(function* () {
              inference++;
              yield* Deferred.succeed(inferenceStarted, undefined);
              yield* Deferred.await(releaseInference);
              return inputs.map(input =>
                input.includes('alpha') || input.includes('celestial orchard') ? [1, 0] : [0, 1],
              );
            }),
          generate: () => Effect.die('unexpected generation'),
          rerank: () => Effect.die('unexpected reranking'),
        }),
      );
      const command = Layer.effect(
        CommandExecutor,
        Effect.gen(function* () {
          const actual = yield* CommandExecutor;
          return CommandExecutor.of({
            ...actual,
            execute: (executable, args, options) =>
              args.at(-1) === '--threadnote-code-graph-impact-query-worker'
                ? runRead(new TextDecoder().decode(options?.input)).pipe(
                    Effect.orDie,
                    Effect.map(stdout => ({exitCode: 0, stderr: '', stdout})),
                  )
                : actual.execute(executable, args, options),
          });
        }),
      ).pipe(Layer.provide(fixtureLayer));
      const base = Layer.mergeAll(
        fixtureLayer,
        BunServices.layer,
        BunHttpClient.layer,
        runtime,
        command,
        CodeGraphLanguagePackRegistry.layer,
        Layer.succeed(CodeGraphEmbeddingWorkerProcess, {
          wake: home => {
            wakes++;
            return wake(home);
          },
        }),
      );
      const graphBase = Layer.mergeAll(
        CodeGraphEmbeddingIndex.layer,
        CodeGraphParserPool.layer,
        TreeSitterRuntime.layer,
        CodeGraphMaintenanceCoordinator.layer,
      ).pipe(Layer.provideMerge(base));
      const indexed = CodeGraphIndexer.layer.pipe(Layer.provideMerge(graphBase));
      const graph = Layer.mergeAll(CodeGraphQueryService.layer, CodeGraphWatcher.layer).pipe(
        Layer.provideMerge(indexed),
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'registered-graph-embedding-'});
        const repository = path.join(home, 'repo');
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        yield* fs.makeDirectory(repository);
        yield* fs.writeFileString(
          manifestPath,
          scoped
            ? [
                'version: 1',
                'projects:',
                '  - name: web',
                `    path: ${repository}`,
                '    seed: []',
                '    uri: threadnote://resources/repos/web',
                '    graph:',
                '      closure: dependencies',
                '      roots: [apps/web]',
                '',
              ].join('\n')
            : 'version: 1\nprojects: []\n',
        );
        if (scoped) {
          yield* fs.makeDirectory(path.join(repository, 'apps/web'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"fixture","private":true,"workspaces":["apps/*"]}',
          );
          yield* fs.writeFileString(
            path.join(repository, 'apps/web/package.json'),
            '{"name":"fixture-web","version":"1.0.0"}',
          );
        }

        yield* fs.writeFileString(
          path.join(repository, scoped ? 'apps/web/value.ts' : 'value.ts'),
          'export function alpha() { return 42; }\nexport function beta() { return alpha(); }\n',
        );
        for (const args of [
          ['init', '-q'],
          ['add', '.'],
          ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'],
        ])
          yield* command.execute('git', args, {cwd: repository});
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
        const query = yield* CodeGraphQueryService;
        const store = yield* CodeGraphStore;
        const indexer = yield* CodeGraphIndexer;
        const system = yield* SystemInfo;
        const context = yield* Effect.context<Layer.Success<typeof graph>>();
        runRead = raw =>
          serveCodeGraphDiscoveryRead(JSON.parse(raw)).pipe(
            Effect.provide(context),
            Effect.map(served =>
              JSON.stringify(
                'unavailable' in served
                  ? {protocol: 1, ok: false, telemetry: [], ...served}
                  : {protocol: 1, ok: true, telemetry: [], ...served},
              ),
            ),
          );
        const scope = yield* Effect.scope;
        let worker: Fiber.Fiber<unknown, unknown> | undefined;
        wake = selectedHome =>
          Effect.gen(function* () {
            const status = yield* query.status(selectedHome, repository, {manifestPath, requestMaintenance: false});
            const layout = codeGraphLayout(
              path,
              selectedHome,
              status.identity.checkoutId,
              status.identity.worktreeId,
              status.readySnapshot?.scopeId,
            );
            const lanes = yield* store.withSession(
              layout.databasePath,
              Effect.gen(function* () {
                return yield* readCodeGraphEmbeddingDemandPage(yield* SqlClient.SqlClient);
              }),
              {readOnly: true},
            );
            if (!lanes[0]) return false;
            worker = yield* runCodeGraphEmbeddingWorkerUnit({
              home: selectedHome,
              layout,
              lane: lanes[0],
              owner: {
                token: 'registered-route-owner',
                processId: process.pid,
                processStartIdentity: (yield* system.processStartIdentity(process.pid)) ?? 'fixture-process',
              },
            }).pipe(Effect.provide(context), Effect.forkIn(scope, {startImmediately: true}));
            return true;
          }).pipe(Effect.provide(context));
        // An empty startup probe must not create storage or wake the process adapter.
        yield* resumeExistingCodeGraphEmbeddingDemand(home);
        expect(wakes).toBe(0);
        const server = new EffectMcpServerAdapter('background-embedding-test', '1', 'fixture');
        registerCodeGraphTool(server, {
          account: 'local',
          agentContextHome: home,
          agentId: 'fixture',
          manifestPath,
          user: 'fixture',
        });
        type AddedTool = Parameters<EffectMcpServer['addTool']>[0];
        let handler: AddedTool['handle'] | undefined;
        const mcp = Layer.succeed(McpServer.McpServer, {
          addTool: (tool: AddedTool) =>
            Effect.sync(() => {
              if (tool.tool.name === 'inspect_code_graph') handler = tool.handle;
            }),
        } as unknown as EffectMcpServer);
        // The registry's application-wide requirement is conservative; these registered handlers use the supplied graph context.
        // oxlint-disable effecttsgo/unsafe-effect-type-assertion -- registered graph-only test handlers use the actual supplied graph services
        const registration = server.registrationLayer() as Layer.Layer<
          never,
          never,
          McpServer.McpServer | Layer.Success<typeof graph>
        >;
        // oxlint-enable effecttsgo/unsafe-effect-type-assertion
        yield* Layer.build(registration.pipe(Layer.provide(mcp), Layer.provide(Layer.succeedContext(context))));
        const client = McpSchema.McpServerClient.of({
          clientCapabilities: {},
          clientId: 0,
          clientInfo: {name: 'fixture', version: '1'},
          getClient: Effect.never,
          initializePayload: {
            capabilities: {},
            clientInfo: {name: 'fixture', version: '1'},
            protocolVersion: '2025-06-18',
          },
          protocolVersion: '2025-06-18',
        });
        const invoke = (args: Record<string, unknown>) =>
          Effect.suspend(() => {
            if (!handler) return Effect.die('inspect_code_graph not registered');
            return handler({callerCwd: repository, responseFormat: 'dual', ...args}).pipe(
              Effect.provideService(McpSchema.McpRequestContext, client),
              Effect.flatMap(Schema.decodeUnknownEffect(McpSchema.CallToolResult)),
            );
          });
        // Strict path inspection takes the real registered cold-refresh route through the watcher/indexer.
        const initial = yield* invoke({operation: 'path', from: 'beta', to: 'alpha'});
        expect(initial.isError, JSON.stringify(initial)).not.toBe(true);
        yield* Deferred.await(inferenceStarted).pipe(Effect.timeout(10000));
        const pending = yield* query.status(home, repository, {manifestPath, requestMaintenance: false});
        expect(pending.readySnapshot).toBeDefined();
        expect(pending.readySnapshot?.scopeId !== undefined).toBe(scoped);
        expect(pending.semantic?.state).toBe('embedding');
        const route = yield* resolveCodeGraphScopeRoute(manifestPath, repository);
        const heldLayout = codeGraphLayout(
          path,
          home,
          pending.identity.checkoutId,
          pending.identity.worktreeId,
          pending.readySnapshot?.scopeId,
        );
        const heldLanes = store.withSession(
          heldLayout.databasePath,
          Effect.gen(function* () {
            return yield* readCodeGraphEmbeddingDemandPage(yield* SqlClient.SqlClient);
          }),
          {readOnly: true},
        );
        const beforeHeldNoop = yield* heldLanes;
        yield* indexer.index({
          cwd: repository,
          threadnoteHome: home,
          vectorPolicy: 'background',
          ...(route.state === 'selected' ? {project: route.project} : {}),
        });
        expect(yield* heldLanes).toEqual(beforeHeldNoop);
        const afterHeldNoop = yield* query.status(home, repository, {manifestPath, requestMaintenance: false});
        expect(afterHeldNoop.semantic?.state, 'no-op must preserve the active embedding claim epoch').toBe('embedding');
        expect(afterHeldNoop.readySnapshot?.id).toBe(pending.readySnapshot?.id);

        const lexical = yield* invoke({operation: 'query', query: 'alpha'});
        expect(JSON.stringify(lexical)).toContain('alpha');
        const lexicalResult = lexical.structuredContent as {nodes: {id: string; name: string}[]};
        const alpha = lexicalResult.nodes.find(node => node.name === 'alpha');
        expect(alpha).toBeDefined();
        const neighbors = yield* invoke({operation: 'neighbors', nodeId: alpha!.id});
        expect(JSON.stringify(neighbors)).toContain('beta');
        const before = yield* invoke({
          operation: 'query',
          query: 'celestial orchard',
          nodeLimit: 20,
          budgetTokens: 1500,
        });
        expect((before.structuredContent as {nodes: unknown[]}).nodes).toEqual([]);
        const beforeInference = inference;
        const beforeWakes = wakes;
        yield* Deferred.succeed(releaseInference, undefined);
        if (!worker) return yield* Effect.die('automatic embedding worker was not woken');
        yield* Fiber.join(worker);
        const completed = yield* query.status(home, repository, {manifestPath, requestMaintenance: false});
        expect(completed.semantic?.state).toBe('ready');
        expect(completed.readySnapshot?.id).toBe(pending.readySnapshot?.id);
        const modelStore = yield* LocalModelStore;
        let verificationCalls = 0;
        const readOnlyStore = {
          ...modelStore,
          verify: () =>
            Effect.sync(() => {
              verificationCalls++;
            }).pipe(Effect.andThen(Effect.die('status must not verify model artifacts'))),
        };
        let catalogReads = 0;
        const racingCatalog = {
          ...catalog,
          get: (id: string) =>
            catalog
              .get(id)
              .pipe(Effect.map(value => (++catalogReads === 1 ? value : {...value, sha256: 'f'.repeat(64)}))),
        };
        const checkContext = yield* Layer.build(Layer.fresh(CodeGraphEmbeddingIndex.layer)).pipe(
          Effect.provideService(LocalModelStore, readOnlyStore),
          Effect.provideService(LocalModelCatalog, racingCatalog),
        );
        const check = Context.get(checkContext, CodeGraphEmbeddingIndex);
        const layout = codeGraphLayout(
          path,
          home,
          completed.identity.checkoutId,
          completed.identity.worktreeId,
          completed.readySnapshot?.scopeId,
        );
        const graphBeforeMetadata = yield* fs.readFile(layout.databasePath);
        const modelRoot = path.join(layout.vectorRoot, manifest.id);
        const vectorFiles = yield* fs.readDirectory(modelRoot);
        const vectorBeforeMetadata = yield* Effect.forEach(vectorFiles, file =>
          fs.readFile(path.join(modelRoot, file)),
        );

        expect(yield* check.check(home, layout, completed.readySnapshot!.id, {metadataOnly: true})).toMatchObject({
          state: 'stale',
        });
        expect(verificationCalls).toBe(0);
        expect(yield* fs.readFile(layout.databasePath)).toEqual(graphBeforeMetadata);
        expect(yield* fs.readDirectory(modelRoot)).toEqual(vectorFiles);
        expect(yield* Effect.forEach(vectorFiles, file => fs.readFile(path.join(modelRoot, file)))).toEqual(
          vectorBeforeMetadata,
        );
        // Ordinary explicit checks retain full artifact verification; metadata observation alone opts out.
        expect(Exit.isFailure(yield* check.check(home, layout, completed.readySnapshot!.id).pipe(Effect.exit))).toBe(
          true,
        );
        expect(verificationCalls).toBe(1);

        const semantic = yield* invoke({
          operation: 'query',
          query: 'celestial orchard',
          nodeLimit: 20,
          budgetTokens: 1500,
        });
        expect(
          (semantic.structuredContent as {nodes: {name: string}[]}).nodes.some(node => node.name === 'alpha'),
          JSON.stringify(semantic),
        ).toBe(true);
        expect(inference).toBeGreaterThan(beforeInference);
        expect(wakes).toBe(beforeWakes);
        const readOriginalLanes = store.withSession(
          layout.databasePath,
          Effect.gen(function* () {
            return yield* readCodeGraphEmbeddingDemandPage(yield* SqlClient.SqlClient);
          }),
          {readOnly: true},
        );
        expect(
          (yield* readOriginalLanes).map(lane => lane.state),
          'after worker before no-op',
        ).toEqual(['ready']);

        const noop = yield* indexer.index({
          cwd: repository,
          threadnoteHome: home,
          vectorPolicy: 'background',
          ...(route.state === 'selected' ? {project: route.project} : {}),
        });
        expect(noop.snapshot.id).toBe(pending.readySnapshot?.id);
        expect(
          (yield* readOriginalLanes).map(lane => lane.state),
          'after no-op',
        ).toEqual(['ready']);
        expect(wakes).toBe(beforeWakes);
        // A preexisting no-vector view stays structural through startup, reads, and a no-op automatic index.
        const structuralRepository = path.join(home, 'structural-repo');
        yield* fs.makeDirectory(structuralRepository);
        yield* fs.writeFileString(
          path.join(structuralRepository, 'plain.ts'),
          'export function structuralOnly() { return 7; }\n',
        );
        for (const args of [
          ['init', '-q'],
          ['add', '.'],
          ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'],
        ])
          yield* command.execute('git', args, {cwd: structuralRepository});
        const beforeOffInference = inference;
        const structural = yield* indexer.index({cwd: structuralRepository, threadnoteHome: home, vectorPolicy: 'off'});
        expect(structural.semantic?.state).toBe('not-requested');
        expect(wakes, 'explicit off').toBe(beforeWakes);
        const structuralStatus = yield* query.status(home, structuralRepository, {
          manifestPath,
          requestMaintenance: false,
        });
        expect(structuralStatus.semantic?.state).toBe('not-requested');
        const structuralRead = yield* invoke({
          callerCwd: structuralRepository,
          operation: 'query',
          query: 'structuralOnly',
        });
        expect(structuralRead.isError, JSON.stringify(structuralRead)).not.toBe(true);
        const read = structuralRead.structuredContent as {nodes: {name: string; id: string}[]};
        expect(read.nodes.some(node => node.name === 'structuralOnly')).toBe(true);
        const node = read.nodes.find(node => node.name === 'structuralOnly')!;
        const structuralNode = yield* invoke({callerCwd: structuralRepository, operation: 'node', nodeId: node.id});
        expect(structuralNode.isError, JSON.stringify(structuralNode)).not.toBe(true);
        const linked = path.join(home, 'structural-linked');
        yield* command.execute('git', ['worktree', 'add', '--detach', linked, 'HEAD'], {cwd: structuralRepository});
        const linkedStatus = yield* query.status(home, linked, {manifestPath, requestMaintenance: false});
        const attached = yield* query.attachSharedReadySnapshot(home, linkedStatus.identity, linkedStatus);
        expect(attached.readySnapshot?.id).toBe(structural.snapshot.id);
        expect(attached.semantic?.state).toBe('not-requested');
        yield* indexer.index({cwd: structuralRepository, threadnoteHome: home, vectorPolicy: 'background'});
        expect(wakes, 'preexisting no-op background index').toBe(beforeWakes);
        const originalLanes = yield* store.withSession(
          layout.databasePath,
          Effect.gen(function* () {
            return yield* readCodeGraphEmbeddingDemandPage(yield* SqlClient.SqlClient);
          }),
          {readOnly: true},
        );
        expect(originalLanes.map(lane => ({state: lane.state, reason: lane.reason}))).toEqual([
          {state: 'ready', reason: undefined},
        ]);
        yield* resumeExistingCodeGraphEmbeddingDemand(home);
        expect(wakes).toBe(beforeWakes);
        expect(inference).toBe(beforeOffInference);
      }).pipe(provideTestLayer(graph), TestClock.withLive);
    },
    60000,
  );
