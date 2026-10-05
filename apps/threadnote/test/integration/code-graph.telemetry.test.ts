import {systemRuntimeBoundaries} from '../helpers/system-runtime-boundaries.js';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import {succeedUndefined} from '@threadnote/platform/optional';
import {it as effectIt} from '@effect/vitest';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Effect, Exit, Layer, Schema, Tracer} from 'effect';
import {TestClock} from 'effect/testing';
import {McpSchema, McpServer} from 'effect/ai';
import {describe, expect} from 'vitest';
import {CodeGraphAnalysis, analyzeCodeGraph} from '@threadnote/graph/analysis';
import {serveCodeGraphAnalysisRead, type CodeGraphAnalysisReadInput} from '@threadnote/graph/isolated/analysis';
import {codeGraphIsolatedQueryTelemetryRecorder} from '@threadnote/graph/isolated/impact_query';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import type {CodeGraphQueryResult, CodeGraphStatus, RepositoryIdentity} from '@threadnote/graph/types';
import {CodeGraphWatcher} from '@threadnote/graph/watcher';
import {EffectMcpServerAdapter, type EffectMcpServer} from '@threadnote/threadnote/effect/ai/mcp';
import {CommandExecutor} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {anonymousTelemetryTestLayer} from '@threadnote/threadnote/effect/telemetry';
import {registerCodeGraphTool} from '@threadnote/threadnote/mcp/server/code_graph';
import type {CommandResult} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {analysisSnapshot, pagedAnalysisStore} from '@threadnote/graph/test/helpers/code-graph-analysis';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('code graph terminal telemetry wiring', () => {
  effectIt.effect('emits complete privacy-safe inspect and analyze lifecycles through the registered MCP tools', () => {
    const capture = capturingTracer();
    let watcherEnsures = 0;
    const harness = registeredTelemetryHarness(capture.tracer, () => watcherEnsures++);
    const privateQuery = 'private telemetry query';

    return Effect.gen(function* () {
      const result = yield* harness.inspect({
        callerCwd: TELEMETRY_REPOSITORY_ROOT,
        nodeLimit: 1,
        operation: 'query',
        query: privateQuery,
      });

      expect(result.isError).not.toBe(true);
      expect(watcherEnsures).toBe(1);
      const spans = capture.spans
        .map(span => Object.fromEntries(span.attributes))
        .filter(attributes => attributes['threadnote.operation'] === 'inspect_code_graph');

      expect(spans).toHaveLength(5);
      expect(spans.map(attributes => attributes['threadnote.phase'])).toEqual([
        'graph.query.status',
        'graph.query.execute',
        'graph.query.execute',
        'graph.query.execute',
        'graph.query.execute',
      ]);
      expect(spans.map(attributes => attributes['threadnote.stage'])).toEqual([
        'query-repository-identity',
        'query-strict-reobservation',
        undefined,
        'query-serialization',
        undefined,
      ]);
      expect(spans[1]).toMatchObject({'threadnote.subphase': 'skipped'});
      for (const attributes of spans) {
        expect(attributes).toMatchObject({
          'threadnote.graph.request_kind': 'inspect.query',
          'threadnote.graph.request_scope': 'local',
        });
      }
      for (const attributes of [spans[0], spans[1], spans[3]]) {
        expect(attributes).not.toHaveProperty('threadnote.graph.snapshot_selection');
      }
      for (const attributes of [spans[2], spans[4]]) {
        expect(attributes).toMatchObject({
          'threadnote.graph.snapshot_edges_bucket': expect.stringMatching(/^(?:0|2\^\d+)$/u),
          'threadnote.graph.snapshot_files_bucket': expect.stringMatching(/^(?:0|2\^\d+)$/u),
          'threadnote.graph.snapshot_freshness': 'deferred',
          'threadnote.graph.snapshot_selection': 'active',
          'threadnote.graph.snapshot_symbols_bucket': expect.stringMatching(/^(?:0|2\^\d+)$/u),
        });
      }
      expect(spans[4]).toMatchObject({
        'threadnote.event': 'completion',
        'threadnote.outcome': 'success',
      });
      const serialized = JSON.stringify(spans);
      expect(serialized).not.toContain(TELEMETRY_REPOSITORY_ROOT);
      expect(serialized).not.toContain(privateQuery);

      const analyzeResult = yield* harness.analyze({
        callerCwd: TELEMETRY_REPOSITORY_ROOT,
        operation: 'stats',
      });

      expect(analyzeResult.isError).not.toBe(true);
      const analyzeSpans = capture.spans
        .map(span => Object.fromEntries(span.attributes))
        .filter(attributes => attributes['threadnote.operation'] === 'analyze_code_graph');
      expect(analyzeSpans).toHaveLength(7);
      expect(analyzeSpans.slice(0, 6).map(attributes => attributes['threadnote.phase'])).toEqual([
        'graph.query.status',
        'graph.query.status',
        'graph.query.status',
        'graph.query.status',
        'graph.query.execute',
        'graph.query.execute',
      ]);
      expect(analyzeSpans.slice(0, 6).map(attributes => attributes['threadnote.stage'])).toEqual([
        'query-repository-identity',
        'query-worktree-observation',
        'query-repository-identity',
        'query-worktree-observation',
        undefined,
        'query-serialization',
      ]);
      for (const attributes of analyzeSpans) {
        expect(attributes).toMatchObject({
          'threadnote.graph.request_kind': 'analyze.stats',
          'threadnote.graph.request_scope': 'local',
        });
      }
      for (const attributes of [...analyzeSpans.slice(0, 4), analyzeSpans[5]]) {
        expect(attributes).not.toHaveProperty('threadnote.graph.snapshot_selection');
      }
      expect(analyzeSpans[4]).toMatchObject({
        'threadnote.graph.snapshot_selection': 'active',
      });
      expect(analyzeSpans[6]).toMatchObject({
        'threadnote.event': 'completion',
        'threadnote.graph.snapshot_selection': 'active',
        'threadnote.outcome': 'success',
      });
      expect(JSON.stringify(analyzeSpans)).not.toContain(TELEMETRY_REPOSITORY_ROOT);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('defaults graph output to agent text and exposes exact JSON with explicit formats', () => {
    const harness = registeredTelemetryHarness(capturingTracer().tracer, () => {});
    return Effect.gen(function* () {
      const args = {callerCwd: TELEMETRY_REPOSITORY_ROOT, operation: 'query', query: 'fixture'};
      const agent = yield* harness.inspect(args);
      const dual = yield* harness.inspect({...args, responseFormat: 'dual'});
      const text = yield* harness.inspect({...args, responseFormat: 'text'});
      const invalid = yield* harness.inspect({...args, responseFormat: 'unknown'});
      const defaultError = yield* harness.inspect({...args, callerCwd: 'relative'});
      const textError = yield* harness.inspect({...args, callerCwd: 'relative', responseFormat: 'text'});

      expect(agent.isError).not.toBe(true);
      expect(agent.structuredContent).toBeUndefined();
      expect(dual.isError).not.toBe(true);
      expect(text.isError).not.toBe(true);
      expect(invalid.isError).toBe(true);
      expect(textError).toEqual(defaultError);
      expect(dual.structuredContent).toBeDefined();
      expect(dual.content[0]?.type).toBe('text');
      expect(text.content).toHaveLength(1);
      expect(text.structuredContent).toBeUndefined();
      const first = text.content[0];
      if (first?.type !== 'text') throw new Error('Missing graph JSON text content');
      expect(JSON.parse(first.text)).toEqual(dual.structuredContent);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('emits a terminal lifecycle surface for a short detached commit build', () => {
    const capture = capturingTracer();
    const layer = Layer.mergeAll(
      ApplicationLayer,
      anonymousTelemetryTestLayer({system: telemetrySystemInfoStub(), tracer: capture.tracer}),
    );

    return Effect.acquireUseRelease(
      Effect.sync(createRepositoryFixture),
      fixture =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const lease = yield* indexer.ensureCommit({
            commit: fixture.commit,
            cwd: fixture.root,
            threadnoteHome: fixture.home,
          });

          expect(lease.snapshot.commit).toBe(fixture.commit);
          const lifecycle = capture.spans
            .map(span => Object.fromEntries(span.attributes))
            .filter(attributes => attributes['threadnote.event'] === 'lifecycle');
          expect(lifecycle).toHaveLength(1);
          expect(lifecycle[0]).toMatchObject({
            'threadnote.component': 'cli',
            'threadnote.duration_ms': expect.any(Number),
            'threadnote.event': 'lifecycle',
            'threadnote.graph.build_kind': 'clean',
            'threadnote.graph.changed_files_bucket': '0',
            'threadnote.graph.deleted_files_bucket': '0',
            'threadnote.graph.efficiency_class': 'expected-full',
            'threadnote.graph.materialization_mode': 'full',
            'threadnote.graph.resolution_closure': 'full',
            'threadnote.operation': 'graph-build',
            'threadnote.outcome': 'success',
          });
          expect(JSON.stringify(lifecycle)).not.toContain(fixture.root);
        }),
      fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
    ).pipe(TestClock.withLive, provideTestLayer(layer));
  });

  effectIt.effect('reports the effective two-file delta for a dirty project-closure overlay exactly once', () => {
    const capture = capturingTracer();
    const layer = Layer.mergeAll(
      ApplicationLayer,
      anonymousTelemetryTestLayer({system: telemetrySystemInfoStub(), tracer: capture.tracer}),
    );

    return Effect.acquireUseRelease(
      Effect.sync(createRepositoryFixture),
      fixture =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});
          yield* Effect.sync(() => {
            writeFileSync(
              join(fixture.root, 'src', 'value.ts'),
              'export function renamedValue(): number { return 1; }\n',
            );
            writeFileSync(
              join(fixture.root, 'src', 'other.ts'),
              'export const other = 2;\nfunction localCallback(): number { return other; }\nlocalCallback();\n',
            );
          });
          const summary = yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});

          expect(summary.materialization).toMatchObject({
            closureProjects: 1,
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
          });
          const lifecycle = capture.spans
            .map(span => Object.fromEntries(span.attributes))
            .filter(attributes => attributes['threadnote.event'] === 'lifecycle');
          expect(lifecycle).toHaveLength(2);
          expect(lifecycle[1]).toMatchObject({
            'threadnote.graph.build_kind': 'dirty',
            'threadnote.graph.changed_fact_bytes_bucket': expect.not.stringMatching(/^0$/u),
            'threadnote.graph.changed_files_bucket': '2^1',
            'threadnote.graph.deleted_files_bucket': '0',
            'threadnote.graph.extracted_files_bucket': '2^1',
            'threadnote.graph.fallback_reason': 'none',
            'threadnote.graph.materialization_mode': 'incremental-overlay',
            'threadnote.graph.resolution_closure': 'project',
            'threadnote.operation': 'graph-build',
            'threadnote.outcome': 'success',
          });
          expect(JSON.stringify(lifecycle[1])).not.toContain(fixture.root);
        }),
      fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
    ).pipe(TestClock.withLive, provideTestLayer(layer));
  });

  effectIt.effect('retains changed-fact bytes when a dirty project-closure overlay reuses cached extraction', () => {
    const capture = capturingTracer();
    const layer = Layer.mergeAll(
      ApplicationLayer,
      anonymousTelemetryTestLayer({system: telemetrySystemInfoStub(), tracer: capture.tracer}),
    );

    return Effect.acquireUseRelease(
      Effect.sync(createRepositoryFixture),
      fixture =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const dirtyContent = 'export function renamedValue(): number { return 1; }\n';
          yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});
          yield* Effect.sync(() => writeFileSync(join(fixture.root, 'src', 'value.ts'), dirtyContent));
          const firstDirty = yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});
          expect(firstDirty.materialization).toMatchObject({
            closureProjects: 1,
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
          });

          yield* Effect.sync(() => {
            git(fixture.root, ['checkout', '--', 'src/value.ts']);
            git(fixture.root, ['commit', '--allow-empty', '-qm', 'new clean graph identity']);
          });
          yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});
          yield* Effect.sync(() => writeFileSync(join(fixture.root, 'src', 'value.ts'), dirtyContent));
          const cachedDirty = yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});

          expect(cachedDirty.materialization).toMatchObject({
            closureProjects: 1,
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
          });
          expect(cachedDirty.reusedFiles).toBe(cachedDirty.materialization?.totalFiles);
          const lifecycle = capture.spans
            .map(span => Object.fromEntries(span.attributes))
            .filter(attributes => attributes['threadnote.event'] === 'lifecycle');
          expect(lifecycle).toHaveLength(4);
          expect(lifecycle.at(-1)).toMatchObject({
            'threadnote.graph.cached_fact_replay_bytes_bucket': '0',
            'threadnote.graph.changed_fact_bytes_bucket': expect.not.stringMatching(/^0$/u),
            'threadnote.graph.changed_files_bucket': '2^0',
            'threadnote.graph.extracted_files_bucket': '0',
            'threadnote.graph.fallback_reason': 'none',
            'threadnote.graph.materialization_mode': 'incremental-overlay',
            'threadnote.graph.resolution_closure': 'project',
            'threadnote.outcome': 'success',
          });
          expect(JSON.stringify(lifecycle.at(-1))).not.toContain(fixture.root);
        }),
      fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
    ).pipe(TestClock.withLive, provideTestLayer(layer));
  });

  effectIt.effect('shares one terminal claim across an automatic worktree-change retry', () => {
    const capture = capturingTracer();
    const layer = Layer.mergeAll(
      ApplicationLayer,
      anonymousTelemetryTestLayer({system: telemetrySystemInfoStub(), tracer: capture.tracer}),
    );

    return Effect.acquireUseRelease(
      Effect.sync(createRepositoryFixture),
      fixture =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          let changedDuringFirstAttempt = false;
          const summary = yield* indexer.index({
            cwd: fixture.root,
            onProgress: progress =>
              progress.phase !== 'materializing' || changedDuringFirstAttempt
                ? Effect.void
                : Effect.sync(() => {
                    changedDuringFirstAttempt = true;
                    writeFileSync(join(fixture.root, 'src', 'other.ts'), 'export const other = 3;\n');
                  }),
            threadnoteHome: fixture.home,
          });

          expect(changedDuringFirstAttempt).toBe(true);
          expect(summary.snapshot.state).toBe('ready');
          const lifecycle = capture.spans
            .map(span => Object.fromEntries(span.attributes))
            .filter(attributes => attributes['threadnote.event'] === 'lifecycle');
          expect(lifecycle).toHaveLength(1);
          expect(lifecycle[0]).toMatchObject({
            'threadnote.event': 'lifecycle',
            'threadnote.operation': 'graph-build',
            'threadnote.outcome': 'success',
          });
        }),
      fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
    ).pipe(TestClock.withLive, provideTestLayer(layer));
  });
});

const TELEMETRY_HOME = '/threadnote-telemetry-handler-home';
const TELEMETRY_REPOSITORY_ROOT = '/workspace/private-telemetry-repository';

function registeredTelemetryHarness(tracer: Tracer.Tracer, onWatcherEnsure: () => void) {
  const snapshot = {...analysisSnapshot([], []), id: `cgsn_${'1'.repeat(40)}`};
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: 'telemetry-checkout',
    displayName: 'Fixture/telemetry',
    gitCommonDirectory: `${TELEMETRY_REPOSITORY_ROOT}/.git`,
    headCommit: snapshot.commit,
    objectFormat: 'sha1',
    repoRoot: TELEMETRY_REPOSITORY_ROOT,
    repositoryId: snapshot.repositoryId,
    worktreeId: snapshot.worktreeId,
  };
  const status = (observeWorktree: boolean): CodeGraphStatus => ({
    databasePath: `${TELEMETRY_HOME}/graph.sqlite`,
    freshness: observeWorktree ? 'current' : 'deferred',
    identity,
    languagePacks: [],
    readySnapshot: snapshot,
    stale: false,
  });
  const query = CodeGraphQueryService.of({
    attachSharedReadySnapshot: () => Effect.die('Unexpected shared-ready attachment.'),
    inspect: options =>
      Effect.gen(function* () {
        yield* options.telemetry?.skip('graph.query.execute', 'query-strict-reobservation') ?? Effect.void;
        return telemetryQueryResult(status(false));
      }),
    purge: () => Effect.die('Unexpected graph purge.'),
    status: (_threadnoteHome, _cwd, options) =>
      Effect.gen(function* () {
        const observedIdentity = yield* options?.telemetry?.stage(
          'graph.query.status',
          'query-repository-identity',
          Effect.succeed(identity),
        ) ?? Effect.succeed(identity);
        yield* options?.afterIdentityObserved?.(observedIdentity) ?? Effect.void;
        const observesWorktree = options?.observeWorktree !== false;
        if (observesWorktree) {
          yield* options?.telemetry?.stage('graph.query.status', 'query-worktree-observation', Effect.void) ??
            Effect.void;
        } else {
          yield* options?.telemetry?.skip('graph.query.status', 'query-worktree-observation') ?? Effect.void;
        }
        return status(observesWorktree);
      }),
    statusForIdentity: () => Effect.die('Unexpected identity status.'),
    statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
  });
  const watcher = CodeGraphWatcher.of({
    cachedStatus: () => Effect.succeedNone,
    ensure: () => Effect.sync(onWatcherEnsure),
    metrics: Effect.succeed({
      activeRefreshKeys: 0,
      activeWatches: 0,
      executingRefreshes: 0,
      executingRefreshHighWater: 0,
      idleSweepFibers: 0,
      maximumWatchers: 0,
      pendingTrailingRefreshes: 0,
      retainedStatuses: 0,
    }),
    refresh: () => Effect.succeed(false),
    request: () => Effect.die('Unexpected graph request.'),
    status: () => Effect.succeedNone,
    watch: () => Effect.die('Unexpected graph watch.'),
  });
  const store = pagedAnalysisStore([], []);
  const analysis = CodeGraphAnalysis.of({analyze: options => analyzeCodeGraph(store, options)});
  const command = CommandExecutor.of({
    execute: (_executable, arguments_, options) =>
      arguments_.at(-1) === '--threadnote-code-graph-analysis-worker'
        ? Effect.gen(function* () {
            if (options?.input === undefined) throw new Error('Missing isolated graph analysis request.');
            const request = JSON.parse(new TextDecoder().decode(options.input)) as CodeGraphAnalysisReadInput;
            const telemetry: Parameters<typeof codeGraphIsolatedQueryTelemetryRecorder>[0] = [];
            const result = yield* serveCodeGraphAnalysisRead(request, {
              telemetry: codeGraphIsolatedQueryTelemetryRecorder(telemetry),
            }).pipe(
              Effect.provideService(CodeGraphQueryService, query),
              Effect.provideService(CodeGraphAnalysis, analysis),
              Effect.provideService(CodeGraphIndexer, {} as import('@threadnote/graph/indexer').CodeGraphIndexerShape),
              Effect.orDie,
            );
            return commandResult(JSON.stringify({protocol: 1, ok: true, result, telemetry}));
          })
        : Effect.sync(() => {
            if (options?.input === undefined) throw new Error('Missing isolated graph inspection request.');
            const request = JSON.parse(new TextDecoder().decode(options.input)) as {
              readonly operation: CodeGraphQueryResult['operation'];
            };
            return commandResult(
              JSON.stringify({
                ok: true,
                protocol: 1,
                result: {...telemetryQueryResult(status(false)), operation: request.operation},
                status: {
                  stale: false,
                  readySnapshotId: snapshot.id,
                  surface: {
                    freshness: 'deferred',
                    selection: 'active',
                    snapshot: {edgeCount: 0, fileCount: 0, symbolCount: 0},
                  },
                  worktreeId: identity.worktreeId,
                  repoRoot: identity.repoRoot,
                },
                telemetry: [
                  {
                    disposition: 'skipped',
                    durationMilliseconds: 0,
                    outcome: 'success',
                    phase: 'graph.query.execute',
                    stage: 'query-strict-reobservation',
                  },
                ],
              }),
            );
          }),
    executeStreaming: () => Effect.die('Unexpected streaming command.'),
  });
  const server = new EffectMcpServerAdapter('threadnote-graph-telemetry-test', '1.0.0', 'Test server.');
  registerCodeGraphTool(server, runtimeConfig(TELEMETRY_HOME));
  type AddedTool = Parameters<EffectMcpServer['addTool']>[0];
  let analyzeHandle: AddedTool['handle'] | undefined;
  let inspectHandle: AddedTool['handle'] | undefined;
  const mcpLayer = Layer.succeed(McpServer.McpServer, {
    addTool: (options: AddedTool) =>
      Effect.sync(() => {
        if (options.tool.name === 'analyze_code_graph') analyzeHandle = options.handle;
        if (options.tool.name === 'inspect_code_graph') inspectHandle = options.handle;
      }),
  } as unknown as EffectMcpServer);
  const applicationLayer = Layer.mergeAll(
    BunFileSystem.layer,
    BunPath.layer,
    Layer.succeed(CommandExecutor, command),
    Layer.succeed(CodeGraphAnalysis, analysis),
    Layer.succeed(CodeGraphQueryService, query),
    Layer.succeed(CodeGraphWatcher, watcher),
    Layer.succeed(SystemInfo, telemetrySystemInfoStub()),
    anonymousTelemetryTestLayer({system: telemetrySystemInfoStub(), tracer}),
  );
  // The registry contains only the two handlers exercised here. Its production
  // type is conservative because arbitrary registries may capture any service.
  // oxlint-disable effecttsgo/unsafe-effect-type-assertion -- narrow this test-only registry to its actual services
  const registrationLayer = server.registrationLayer() as Layer.Layer<
    never,
    never,
    McpServer.McpServer | Layer.Success<typeof applicationLayer>
  >;
  // oxlint-enable effecttsgo/unsafe-effect-type-assertion
  const layer = registrationLayer.pipe(Layer.provideMerge(mcpLayer), Layer.provideMerge(applicationLayer));
  const invoke = (handle: AddedTool['handle'] | undefined, name: string, arguments_: Record<string, unknown>) =>
    Effect.suspend(() => {
      if (handle === undefined) return Effect.die(`${name} was not registered.`);
      return handle(arguments_).pipe(
        Effect.provideService(McpSchema.McpRequestContext, telemetryMcpClient()),
        Effect.flatMap(Schema.decodeUnknownEffect(McpSchema.CallToolResult)),
      );
    });

  return {
    analyze: (arguments_: Record<string, unknown>) => invoke(analyzeHandle, 'analyze_code_graph', arguments_),
    inspect: (arguments_: Record<string, unknown>) => invoke(inspectHandle, 'inspect_code_graph', arguments_),
    layer,
  };
}

function commandResult(stdout: string): CommandResult {
  return {exitCode: 0, stderr: '', stdout};
}

function telemetryQueryResult(status: CodeGraphStatus): CodeGraphQueryResult {
  const snapshot = status.readySnapshot!;
  return {
    edges: [],
    freshness: 'deferred',
    nodes: [],
    operation: 'query',
    repository: {displayName: status.identity.displayName, repositoryId: status.identity.repositoryId},
    snapshot: {
      commit: snapshot.commit,
      dirty: snapshot.dirty,
      id: snapshot.id,
      worktreeId: status.identity.worktreeId,
    },
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    version: 1,
    warnings: [],
  };
}

function telemetryMcpClient(): McpSchema.McpServerClient['Service'] {
  return McpSchema.McpServerClient.of({
    clientCapabilities: {},
    clientId: 0,
    clientInfo: {name: 'telemetry-test', version: '1.0.0'},
    getClient: Effect.never,
    initializePayload: {
      capabilities: {},
      clientInfo: {name: 'telemetry-test', version: '1.0.0'},
      protocolVersion: '2025-06-18',
    },
    protocolVersion: '2025-06-18',
  });
}

function createRepositoryFixture(): {commit: string; home: string; root: string} {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-graph-telemetry-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, '.gitignore'), '/.threadnote-test-home/\n');
  writeFileSync(join(root, 'package.json'), '{"name":"graph-telemetry-fixture"}\n');
  writeFileSync(join(root, 'src', 'value.ts'), 'export function value(): number { return 1; }\n');
  writeFileSync(join(root, 'src', 'other.ts'), 'export const other = 2;\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'threadnote@example.test']);
  git(root, ['config', 'user.name', 'Threadnote Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return {
    commit: git(root, ['rev-parse', 'HEAD']).trim(),
    home: join(root, '.threadnote-test-home'),
    root,
  };
}

function runtimeConfig(agentContextHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'telemetry-test',
    manifestPath: join(agentContextHome, 'seed-manifest.yaml'),
    user: 'telemetry-test',
  };
}

function git(cwd: string, arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, {cwd, encoding: 'utf8'});
}

function capturingTracer(): {readonly spans: readonly Tracer.NativeSpan[]; readonly tracer: Tracer.Tracer} {
  const spans: Tracer.NativeSpan[] = [];
  return {
    spans,
    tracer: Tracer.make({
      span(options) {
        return new (class extends Tracer.NativeSpan {
          override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
            super.end(endTime, exit);
            spans.push(this);
          }
        })(options);
      },
    }),
  };
}

function telemetrySystemInfoStub(): SystemInfoShape {
  return {
    ...systemRuntimeBoundaries,
    architecture: 'arm64',
    availableDiskBytes: () => succeedUndefined,
    currentDirectory: () => '/',
    environment: () => ({}),
    executablePath: '/opt/threadnote/bin/threadnote',
    hardwareInfo: Effect.succeed({
      cpuModel: 'test',
      effectiveMemoryBytes: 1,
      memoryBytes: 1,
      operatingSystem: 'test',
    }),
    homeDirectory: '/home/test',
    isProcessRunning: () => false,
    memoryUsage: () => ({external: 0, heapUsed: 0, rss: 0}),
    pathDelimiter: ':',
    platform: 'darwin',
    processArguments: ['/opt/threadnote/bin/threadnote'],
    processId: 1,
    processStartIdentity: () => succeedUndefined,
    readLine: () => () => undefined,
    runtimeVersion: 'test',
    setEnvironmentVariable: () => undefined,
    setExitCode: () => undefined,
    signalProcess: () => undefined,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    tempDirectory: '/tmp',
    userName: 'test',
  };
}
