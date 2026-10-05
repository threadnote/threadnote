import {serveCodeGraphAnalysisRead, type CodeGraphAnalysisReadInput} from '@threadnote/graph/isolated/analysis';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {systemRuntimeBoundaries} from '../helpers/system-runtime-boundaries.js';
import {BunFileSystem} from '@effect/platform-bun';
import * as BunPath from '@effect/platform-bun/BunPath';
import {it as effectIt} from '@effect/vitest';
import fc from 'fast-check';
import {Deferred, Effect, FileSystem, Fiber, Layer, Option, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {McpSchema, McpServer} from 'effect/ai';
import {describe, expect, it} from 'vitest';
import {CodeGraphAnalysis, analyzeCodeGraph} from '@threadnote/graph/analysis';
import {CommandExecutor} from '@threadnote/platform/command';
import {succeedUndefined} from '@threadnote/platform/optional';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {
  CodeGraphQueryService,
  type CodeGraphSharedReadyAttachInterlock,
  type CodeGraphStatusOptions,
} from '@threadnote/graph/query';
import type {CodeGraphQueryScope} from '@threadnote/graph/query/scope';
import {attachCodeGraphStatusObservation} from '@threadnote/graph/query/contract';
import type {CodeGraphQueryResult, CodeGraphStatus, RepositoryIdentity} from '@threadnote/graph/types';
import {
  CodeGraphWatcher,
  type CodeGraphRefreshStatus,
  type CodeGraphWatcherShape,
  type CodeGraphWatchOptions,
} from '@threadnote/graph/watcher';
import {EffectMcpServerAdapter, type EffectMcpServer} from '@threadnote/threadnote/effect/ai/mcp';
import {codeGraphMcpRequestDefaults, registerCodeGraphTool} from '@threadnote/threadnote/mcp/server/code_graph';
import type {CommandResult} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {analysisSnapshot, pagedAnalysisStore} from '@threadnote/graph/test/helpers/code-graph-analysis';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('registered analyze_code_graph snapshot resolution', () => {
  it('keeps explicit graph limits and budgets while compacting only omitted local query values', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('explain', 'impact', 'neighbors', 'node', 'path', 'query', 'topology'),
        fc.option(fc.constant('prepared-workset'), {nil: undefined}),
        fc.option(fc.integer({min: 1, max: 1_500}), {nil: undefined}),
        fc.option(fc.integer({min: 1, max: 200}), {nil: undefined}),
        fc.option(fc.integer({min: 1, max: 500}), {nil: undefined}),
        (operation, workset, budgetTokens, nodeLimit, edgeLimit) => {
          const defaults = codeGraphMcpRequestDefaults(operation, {budgetTokens, edgeLimit, nodeLimit, workset});
          const localQuery = operation === 'query' && workset === undefined;

          expect(defaults).toEqual({
            budgetTokens: localQuery ? (budgetTokens ?? 800) : budgetTokens,
            edgeLimit: localQuery ? (edgeLimit ?? 12) : (edgeLimit ?? 40),
            nodeLimit: localQuery ? (nodeLimit ?? 8) : (nodeLimit ?? 20),
          });
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('propagates the explicit project selector to graph status', () => {
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [ready]});
    return Effect.gen(function* () {
      const result = yield* harness.invoke({callerCwd: ready.identity.repoRoot, operation: 'stats', project: 'app-a'});
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(harness.observation.statusOptions[0]).toMatchObject({project: 'app-a'});
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('infers one configured project before selecting an inspect ready snapshot', () => {
    const manifestPath = '/tmp/threadnote-mcp-code-graph-routing-unique.yaml';
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({
      attachResults: [],
      manifestPath,
      refresh: false,
      statuses: [ready],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(manifestPath, graphManifest(['web']));
      const result = yield* harness.invokeInspect({
        callerCwd: ready.identity.repoRoot,
        operation: 'query',
        query: 'value',
      });

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(harness.observation.isolatedRequests).toEqual([
        expect.objectContaining({operation: 'query', project: 'web', discover: true}),
      ]);
      const [inferred] = harness.observation.isolatedRequests;
      expect(inferred).not.toHaveProperty('readySnapshotId');
      expect(inferred).not.toHaveProperty('projectScopeReceipt');
    }).pipe(
      Effect.ensuring(FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.remove(manifestPath).pipe(Effect.ignore)))),
      provideTestLayer(harness.layer),
    );
  });

  effectIt.effect('rejects ambiguous configured inspect scope before graph status selection', () => {
    const manifestPath = '/tmp/threadnote-mcp-code-graph-routing-ambiguous.yaml';
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({
      attachResults: [],
      manifestPath,
      refresh: false,
      statuses: [ready],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(manifestPath, graphManifest(['web', 'api']));
      const result = yield* harness.invokeInspect({
        callerCwd: ready.identity.repoRoot,
        operation: 'query',
        query: 'value',
      });

      expect(result.isError).toBe(true);
      const message = JSON.stringify(result.content);
      expect(message).toContain('2 configured scopes match');
      expect(message).toContain('Set project (or CLI --project)');
      expect(message).toContain('- api: src');
      expect(message).toContain('- web: src');
      expect(harness.observation.statusOptions).toHaveLength(0);
    }).pipe(
      Effect.ensuring(FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.remove(manifestPath).pipe(Effect.ignore)))),
      provideTestLayer(harness.layer),
    );
  });
  effectIt.effect('rejects missing operation at the adapter boundary for both code-graph tools', () => {
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [ready]});

    return Effect.gen(function* () {
      const analyzeResult = yield* harness.invoke({callerCwd: ready.identity.repoRoot});
      const inspectResult = yield* harness.invokeInspect({callerCwd: ready.identity.repoRoot});

      expect(analyzeResult.isError).toBe(true);
      expect(inspectResult.isError).toBe(true);
      expect(harness.observation.analysisCalls).toBe(0);
      expect(harness.observation.statusOptions).toHaveLength(0);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect(
    'uses compact defaults only for local graph queries and preserves explicit and non-query limits',
    () => {
      const ready = codeGraphStatus({ready: true, stale: false});
      const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [ready]});

      return Effect.gen(function* () {
        for (const request of [
          {operation: 'query' as const, query: 'value'},
          {edgeLimit: 17, nodeLimit: 9, operation: 'query' as const, query: 'value'},
          {nodeId: `cgs_${'a'.repeat(32)}`, operation: 'neighbors' as const},
        ]) {
          const result = yield* harness.invokeInspect({
            callerCwd: ready.identity.repoRoot,
            responseFormat: 'dual',
            ...request,
          });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
        }

        expect(harness.observation.isolatedRequests).toEqual([
          expect.objectContaining({edgeLimit: 12, nodeLimit: 8, operation: 'query'}),
          expect.objectContaining({edgeLimit: 17, nodeLimit: 9, operation: 'query'}),
          expect.objectContaining({edgeLimit: 40, nodeLimit: 20, operation: 'neighbors'}),
        ]);
      }).pipe(provideTestLayer(harness.layer));
    },
  );

  effectIt.effect(
    'directs explicit configured-project topology requests to scoped analysis or a prepared workset',
    () => {
      const manifestPath = '/tmp/threadnote-mcp-code-graph-topology-explicit.yaml';
      const repositoryRoot = process.cwd();
      const ready = codeGraphStatus({ready: true, stale: false});
      const harness = analyzeHandlerHarness({
        attachResults: [],
        liveGit: true,
        manifestPath,
        refresh: false,
        statuses: [ready],
      });

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(manifestPath, graphManifest(['web'], repositoryRoot));
        const result = yield* harness.invokeInspect({
          callerCwd: repositoryRoot,
          operation: 'topology',
          project: 'web',
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('analyze_code_graph');
        expect(JSON.stringify(result.content)).toContain('project');
        expect(JSON.stringify(result.content)).toContain('workset prepare');
        expect(harness.observation.statusOptions).toHaveLength(0);
      }).pipe(
        Effect.ensuring(FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.remove(manifestPath).pipe(Effect.ignore)))),
        provideTestLayer(harness.layer),
      );
    },
  );

  effectIt.effect('infers configured-project topology guidance and rejects unknown selectors', () => {
    const manifestPath = '/tmp/threadnote-mcp-code-graph-topology-routing.yaml';
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({attachResults: [], manifestPath, refresh: false, statuses: [ready]});

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(manifestPath, graphManifest(['web']));

      const inferred = yield* harness.invokeInspect({callerCwd: ready.identity.repoRoot, operation: 'topology'});
      expect(inferred.isError).toBe(true);
      expect(JSON.stringify(inferred.content)).toContain('configured project \\"web\\"');
      expect(JSON.stringify(inferred.content)).toContain('analyze_code_graph');

      const unknown = yield* harness.invokeInspect({
        callerCwd: ready.identity.repoRoot,
        operation: 'topology',
        project: 'unknown',
      });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown.content)).toContain('No configured graph project named');
      expect(JSON.stringify(unknown.content)).toContain('threadnote project create <name> --path <repository>');
      expect(JSON.stringify(unknown.content)).not.toContain('configured project \\"unknown\\"');
      expect(harness.observation.statusOptions).toHaveLength(0);
    }).pipe(
      Effect.ensuring(FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.remove(manifestPath).pipe(Effect.ignore)))),
      provideTestLayer(harness.layer),
    );
  });

  effectIt.effect('uses the 55-second default budget for ready query and exact-node reads', () => {
    const ready = codeGraphStatus({ready: true, stale: true});
    const harness = analyzeHandlerHarness({
      allowBackgroundRequest: true,
      attachResults: [ready, ready],
      inspectDelayMilliseconds: 30_000,
      refresh: false,
      statuses: [ready, ready],
    });

    return Effect.gen(function* () {
      for (const request of [
        {operation: 'query' as const, query: 'value'},
        {nodeId: `cgs_${'a'.repeat(32)}`, operation: 'node' as const},
      ]) {
        const started = harness.awaitIsolatedInspectCall(harness.observation.isolatedInspectCalls + 1);
        const fiber = yield* harness
          .invokeInspect({
            callerCwd: ready.identity.repoRoot,
            responseFormat: 'dual',
            ...request,
          })
          .pipe(Effect.forkChild({startImmediately: true}));
        yield* started;
        yield* TestClock.adjust('30 seconds');
        const result = yield* Fiber.join(fiber);

        expect(result.structuredContent, JSON.stringify(result)).toMatchObject({
          operation: request.operation,
          type: 'code-graph-inspection',
        });
      }
      expect(harness.observation.isolatedInspectCalls).toBe(2);
      expect(harness.observation.isolatedRequests).toEqual([
        expect.objectContaining({operation: 'query', discover: true}),
        expect.objectContaining({operation: 'node', discover: true}),
      ]);
      for (const request of harness.observation.isolatedRequests) {
        expect(request).not.toHaveProperty('readySnapshotId');
        expect(request).not.toHaveProperty('projectScopeReceipt');
      }
      expect(harness.observation.lifecycleEvents).toEqual([
        'isolated-read-start',
        'isolated-read-complete',
        'watcher-ensure',
        'isolated-read-start',
        'isolated-read-complete',
        'watcher-ensure',
      ]);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('rejects unsafe short budgets and preserves one second for the accepted minimum', () => {
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({
      attachResults: [],
      inspectDelayMilliseconds: 999,
      refresh: false,
      statuses: [ready],
    });

    return Effect.gen(function* () {
      for (const readTimeoutMilliseconds of [1_000, 2_999, 3_000, 3_999]) {
        const rejected = yield* harness.invokeInspect({
          callerCwd: ready.identity.repoRoot,
          operation: 'query',
          query: 'value',
          readTimeoutMilliseconds,
        });
        expect(rejected.isError).toBe(true);
      }
      expect(harness.observation.isolatedInspectCalls).toBe(0);

      const started = harness.awaitIsolatedInspectCall(1);
      const fiber = yield* harness
        .invokeInspect({
          callerCwd: ready.identity.repoRoot,
          operation: 'query',
          query: 'value',
          readTimeoutMilliseconds: 4_000,
          responseFormat: 'dual',
        })
        .pipe(Effect.forkChild({startImmediately: true}));
      yield* started;
      yield* TestClock.adjust('999 millis');
      const accepted = yield* Fiber.join(fiber);

      expect(accepted.structuredContent, JSON.stringify(accepted)).toMatchObject({
        operation: 'query',
        type: 'code-graph-inspection',
      });
      expect(harness.observation.isolatedInspectCalls).toBe(1);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('serves stale ready evidence for every ordinary inspection operation', () => {
    const stale = codeGraphStatus({ready: true, stale: true});
    const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [stale]});
    const requests = [
      {operation: 'query' as const, query: 'value'},
      {nodeId: `cgs_${'a'.repeat(32)}`, operation: 'node' as const},
      {nodeId: `cgs_${'a'.repeat(32)}`, operation: 'neighbors' as const},
      {operation: 'explain' as const, symbol: 'value'},
    ];

    return Effect.gen(function* () {
      for (const request of requests) {
        const result = yield* harness.invokeInspect({
          callerCwd: stale.identity.repoRoot,
          responseFormat: 'dual',
          ...request,
        });

        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.structuredContent, JSON.stringify(result)).toMatchObject({
          freshness: 'stale',
          operation: request.operation,
          snapshot: {id: stale.readySnapshot!.id},
          type: 'code-graph-inspection',
        });
      }
      expect(harness.observation.isolatedInspectCalls).toBe(requests.length);
      expect(harness.observation.refreshOptions).toEqual([]);
      expect(harness.observation.watcherStatusTargets).toEqual(
        requests.map(() => ({cwd: stale.identity.repoRoot, threadnoteHome: TEST_HOME})),
      );
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('does not put completed ready reads behind persisted watcher discovery', () => {
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({
      attachResults: [],
      refresh: false,
      rejectTargetedWatcherStatus: true,
      statuses: [ready],
    });

    return Effect.gen(function* () {
      const result = yield* harness.invokeInspect({
        callerCwd: ready.identity.repoRoot,
        operation: 'query',
        query: 'value',
        responseFormat: 'dual',
      });

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({operation: 'query', type: 'code-graph-inspection'});
      expect(harness.observation.watcherStatusTargets).toEqual([
        {cwd: ready.identity.repoRoot, threadnoteHome: TEST_HOME},
      ]);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('returns a cold ordinary inspection after one read without starting indexing', () => {
    const cold = codeGraphStatus({ready: false, stale: true});
    const harness = analyzeHandlerHarness({attachResults: [], refresh: true, statuses: [cold]});
    const requests = [
      {operation: 'query' as const, query: 'value'},
      {nodeId: `cgs_${'a'.repeat(32)}`, operation: 'node' as const},
      {nodeId: `cgs_${'a'.repeat(32)}`, operation: 'neighbors' as const},
      {operation: 'explain' as const, symbol: 'value'},
    ];

    return Effect.gen(function* () {
      for (const request of requests) {
        const result = yield* harness.invokeInspect({
          callerCwd: cold.identity.repoRoot,
          responseFormat: 'dual',
          ...request,
        });

        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.structuredContent, JSON.stringify(result)).toMatchObject({
          operation: request.operation,
          reason: 'no-ready-snapshot',
          state: 'unavailable',
          type: 'code-graph-query-state',
        });
      }
      expect(harness.observation.isolatedInspectCalls).toBe(requests.length);
      expect(harness.observation.ensureOptions).toEqual([]);
      expect(harness.observation.refreshOptions).toEqual([]);
      expect(harness.observation.watcherStatusCalls).toBe(0);
      expect(harness.observation.lifecycleEvents).toEqual(
        requests.flatMap(() => ['isolated-read-start', 'isolated-read-complete']),
      );
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('rediscovers the resolved project scope in the isolated worker', () => {
    const projectScope = scopedProjectObservation();
    const base = codeGraphStatus({ready: true, stale: false});
    const ready = attachCodeGraphStatusObservation(
      {
        ...base,
        projectCoverage: {
          project: 'web',
          kind: 'project',
          configuredRoots: ['apps/web'],
          rootComponents: 1,
          dependencyComponents: 1,
          completeness: 'complete',
          negativeProof: 'selected-graph-only',
          observedWorktreeCommit: base.identity.headCommit,
          reusedEquivalentSnapshot: false,
          snapshotSourceCommit: base.readySnapshot!.commit,
        },
      },
      {identity: base.identity, projectScope},
    );
    const harness = analyzeHandlerHarness({
      attachResults: [],
      refresh: false,
      statuses: [ready],
    });

    return Effect.gen(function* () {
      const result = yield* harness.invokeInspect({
        callerCwd: ready.identity.repoRoot,
        operation: 'query',
        project: 'web',
        query: 'value',
        responseFormat: 'dual',
      });

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent, JSON.stringify(result)).toMatchObject({
        projectCoverage: {
          completeness: 'complete',
          configuredRoots: ['apps/web'],
          dependencyComponents: 1,
          kind: 'project',
          project: 'web',
          rootComponents: 1,
        },
      });
      expect(harness.observation.isolatedRequests).toEqual([
        expect.objectContaining({
          discover: true,
          operation: 'query',
          project: 'web',
        }),
      ]);
      const [discovery] = harness.observation.isolatedRequests;
      expect(discovery).not.toHaveProperty('readySnapshotId');
      expect(discovery).not.toHaveProperty('projectScopeReceipt');
    }).pipe(provideTestLayer(harness.layer));
  });

  for (const [refreshState, refreshStatus] of [
    ['active', indexingRefreshStatus()],
    ['deferred', deferredRefreshStatus()],
  ] as const) {
    effectIt.effect(`preserves cached scoped ${refreshState} refresh state after a completed ready read`, () => {
      const manifestPath = `/tmp/threadnote-mcp-code-graph-cached-${refreshState}.yaml`;
      const stale = codeGraphStatus({ready: true, stale: true});
      const harness = analyzeHandlerHarness({
        attachResults: [],
        liveGit: true,
        manifestPath,
        refresh: false,
        refreshStatus,
        statuses: [stale],
      });

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(manifestPath, graphManifest(['web'], stale.identity.repoRoot));
        const result = yield* harness.invokeInspect({
          callerCwd: stale.identity.repoRoot,
          operation: 'query',
          project: 'web',
          query: 'value',
          responseFormat: 'dual',
        });

        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          freshness: 'stale',
          refresh: {
            state: refreshState,
            ...(refreshStatus.state === 'deferred' ? {failure: refreshStatus.failure} : {}),
          },
          type: 'code-graph-inspection',
        });
        expect(harness.observation.watcherStatusCalls).toBe(0);
        expect(harness.observation.watcherStatusTargets).toEqual([
          expect.objectContaining({
            cwd: stale.identity.repoRoot,
            project: expect.objectContaining({
              graph: {closure: 'dependencies', roots: ['src']},
              uri: 'threadnote://resources/repos/web',
            }),
            threadnoteHome: TEST_HOME,
          }),
        ]);
      }).pipe(
        Effect.ensuring(FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.remove(manifestPath).pipe(Effect.ignore)))),
        provideTestLayer(harness.layer),
      );
    });
  }

  effectIt.effect('serves stale ready evidence with reconnect recovery and skips resume discovery', () => {
    const stale = codeGraphStatus({ready: true, stale: true});
    const refreshStatus = reconnectRefreshStatus();
    const harness = analyzeHandlerHarness({
      attachResults: [],
      refresh: false,
      refreshStatus,
      statuses: [stale],
    });

    return Effect.gen(function* () {
      const result = yield* harness.invokeInspect({
        callerCwd: stale.identity.repoRoot,
        operation: 'query',
        query: 'value',
        responseFormat: 'dual',
      });

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        freshness: 'stale',
        refresh: {failure: refreshStatus.failure, state: 'deferred'},
        type: 'code-graph-inspection',
      });
      expect(JSON.stringify(result.structuredContent)).toMatch(/reconnect/i);
      expect(harness.observation.scheduledResumeOptions).toEqual([]);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('reserves finalization time without scheduling a hidden stale-ready rebuild', () => {
    const ready = codeGraphStatus({ready: true, stale: true});
    const harness = analyzeHandlerHarness({
      allowBackgroundRequest: true,
      attachResults: [ready],
      inspectDelayMilliseconds: 60_000,
      refresh: false,
      statuses: [ready],
    });

    return Effect.gen(function* () {
      const started = harness.awaitIsolatedInspectCall(1);
      const fiber = yield* harness
        .invokeInspect({callerCwd: ready.identity.repoRoot, operation: 'query', query: 'value'})
        .pipe(Effect.forkChild({startImmediately: true}));
      yield* started;
      yield* TestClock.adjust('52 seconds');
      const result = yield* Fiber.join(fiber);

      expect(result.structuredContent, JSON.stringify(result)).toMatchObject({
        operation: 'query',
        state: 'timed-out',
        type: 'code-graph-query-state',
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain('readySnapshotAvailable');
      expect(JSON.stringify(result.content)).not.toContain('before the MCP client timeout');
      expect(harness.observation.isolatedInspectCalls).toBe(1);
      expect(harness.observation.lifecycleEvents).toEqual(['isolated-read-start']);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('reads a hot snapshot without attaching watcher work before the accepted analysis', () => {
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [ready]});

    return Effect.gen(function* () {
      const result = yield* harness.invoke({callerCwd: ready.identity.repoRoot, operation: 'stats'});

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content).toEqual([
        expect.objectContaining({type: 'text', text: expect.stringContaining('Graph analysis:')}),
      ]);
      const text = (result.content[0] as {readonly text: string}).text;
      expect(text).not.toContain('Read:');
      expect(text).not.toContain(ready.identity.repositoryId);
      expect(text).not.toContain(ready.readySnapshot!.id);
      expect(harness.observation.ensureOptions).toEqual([]);
      expect(harness.observation.refreshOptions).toEqual([]);
      expect(harness.observation.watcherStatusCalls).toBe(0);
      expect(harness.observation.analysisCalls).toBe(1);
      expect(harness.observation.statusOptions).toHaveLength(2);
      expect(harness.observation.statusOptions[0]).toMatchObject({requestMaintenance: false});
      expect(harness.observation.attachOptions).toEqual([]);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect(
    'retains stale analysis provenance without repeating opaque repository or snapshot identities',
    () => {
      const stale = codeGraphStatus({ready: true, stale: true});
      const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [stale]});

      return Effect.gen(function* () {
        const result = yield* harness.invoke({
          callerCwd: stale.identity.repoRoot,
          freshness: 'ready',
          operation: 'stats',
        });
        const text = (result.content[0] as {readonly text: string}).text;

        expect(text).toContain(`Evidence: freshness stale, commit ${stale.readySnapshot!.commit.slice(0, 12)}.`);
        expect(text).not.toContain('Read:');
        expect(text).not.toContain(stale.identity.repositoryId);
        expect(text).not.toContain(stale.readySnapshot!.id);
      }).pipe(provideTestLayer(harness.layer));
    },
  );

  effectIt.effect('retains actionable partial project scope in the default analysis projection', () => {
    const base = codeGraphStatus({ready: true, stale: false});
    const ready: CodeGraphStatus = {
      ...base,
      projectCoverage: {
        completeness: 'partial',
        configuredRoots: ['root-a', 'root-b', 'root-c'],
        dependencyComponents: 2,
        kind: 'project',
        negativeProof: 'selected-graph-only',
        observedWorktreeCommit: base.identity.headCommit,
        project: 'threadnote-app',
        reusedEquivalentSnapshot: false,
        rootComponents: 1,
      },
    };
    const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [ready]});

    return Effect.gen(function* () {
      const result = yield* harness.invoke({
        callerCwd: ready.identity.repoRoot,
        operation: 'stats',
        project: 'threadnote-app',
      });
      const text = (result.content[0] as {readonly text: string}).text;

      expect(text).toContain(
        'Project scope: threadnote-app, project, partial, negative proof selected-graph-only, roots root-a, root-b, 1 root(s) omitted.',
      );
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect(
    'keeps canonical analysis structured content behind explicit dual format without duplicating metadata in text',
    () => {
      const ready = codeGraphStatus({ready: true, stale: false});
      const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [ready]});

      return Effect.gen(function* () {
        const result = yield* harness.invoke({
          callerCwd: ready.identity.repoRoot,
          operation: 'stats',
          responseFormat: 'dual',
        });

        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({operation: 'stats', type: 'code-graph-analysis'});
        const text = (result.content[0] as {readonly text: string}).text;
        expect(text).toContain('Graph analysis:');
        expect(text).not.toContain('Read:');
        expect(text).not.toContain(ready.identity.repositoryId);
        expect(text).not.toContain(ready.readySnapshot!.id);
      }).pipe(provideTestLayer(harness.layer));
    },
  );

  for (const freshness of ['ready', 'allow-stale'] as const) {
    effectIt.effect(`analyzes the selected stale snapshot with ${freshness} and starts no watcher`, () => {
      const stale = codeGraphStatus({ready: true, stale: true});
      const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [stale]});
      return Effect.gen(function* () {
        const result = yield* harness.invoke({
          callerCwd: stale.identity.repoRoot,
          operation: 'groups',
          freshness,
          responseFormat: 'dual',
        });
        expect(result.structuredContent).toMatchObject({
          freshnessPolicy: freshness,
          freshness: 'stale',
          snapshot: {id: stale.readySnapshot!.id},
          type: 'code-graph-analysis',
        });
        expect(harness.observation.analysisCalls).toBe(1);
        expect(harness.observation.ensureOptions).toEqual([]);
        expect(harness.observation.refreshOptions).toEqual([]);
        expect(harness.observation.attachOptions).toEqual([]);
      }).pipe(provideTestLayer(harness.layer));
    });
  }

  effectIt.effect('reports a cold allow-stale scope without starting refresh or attaching another graph', () => {
    const cold = codeGraphStatus({ready: false, stale: true});
    const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [cold]});
    return Effect.gen(function* () {
      const result = yield* harness.invoke({
        callerCwd: cold.identity.repoRoot,
        operation: 'stats',
        freshness: 'allow-stale',
        responseFormat: 'dual',
      });
      expect(result.structuredContent).toMatchObject({
        freshnessPolicy: 'allow-stale',
        state: 'unavailable',
        reason: 'no-ready-snapshot',
      });
      expect(harness.observation.analysisCalls).toBe(0);
      expect(harness.observation.ensureOptions).toEqual([]);
      expect(harness.observation.refreshOptions).toEqual([]);
      expect(harness.observation.attachOptions).toEqual([]);
    }).pipe(provideTestLayer(harness.layer));
  });

  for (const freshness of ['current', 'ready', 'allow-stale'] as const) {
    effectIt.effect(`preserves known cold capacity failure evidence for ${freshness} without retrying it`, () => {
      const cold = codeGraphStatus({ready: false, stale: true});
      const failure = {
        code: 'no-space' as const,
        operation: 'refresh code graph' as const,
        recovery: 'free-space' as const,
        retryable: false,
        evidence: {
          activeReservations: [],
          calibrationIdentity: 'fixture-v1',
          decisionLayer: 'bounded-write-reservation' as const,
          estimateBasis: 'final-fact-bytes-and-row-count' as const,
          filesystems: [{availableBytes: 1, requiredBytes: 2, role: 'durable' as const}],
          modelVersion: 2,
          recovery: 'free-space' as const,
          retryable: false,
        },
      };
      const harness = analyzeHandlerHarness({
        attachResults: freshness === 'current' ? [cold] : [],
        refresh: false,
        statuses: [cold],
        refreshStatus: {state: 'deferred', failure},
      });
      return Effect.gen(function* () {
        const result = yield* harness.invoke({
          callerCwd: cold.identity.repoRoot,
          operation: 'groups',
          freshness,
          responseFormat: 'dual',
        });
        expect(result.structuredContent).toMatchObject({
          freshnessPolicy: freshness,
          failure,
          type: 'code-graph-analysis-state',
        });
        expect(harness.observation.refreshOptions).toEqual([]);
        expect(harness.observation.analysisCalls).toBe(0);
        if (freshness === 'allow-stale') expect(harness.observation.ensureOptions).toEqual([]);
      }).pipe(provideTestLayer(harness.layer));
    });
  }

  effectIt.effect('keeps stale and no-ready recovery on watcher-owned maintenance', () => {
    const unavailable = codeGraphStatus({ready: false, stale: true});
    const harness = analyzeHandlerHarness({
      attachResults: [unavailable, unavailable],
      refresh: true,
      statuses: [unavailable, unavailable],
    });

    return Effect.gen(function* () {
      const result = yield* harness.invoke({
        callerCwd: unavailable.identity.repoRoot,
        operation: 'stats',
        responseFormat: 'dual',
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({state: 'deferred', type: 'code-graph-analysis-state'});
      expect(harness.observation.ensureOptions).toEqual([
        {
          cwd: unavailable.identity.repoRoot,
          key: unavailable.identity.worktreeId,
          threadnoteHome: TEST_HOME,
        },
      ]);
      expect(harness.observation.refreshOptions).toEqual([
        {
          cwd: unavailable.identity.repoRoot,
          key: unavailable.identity.worktreeId,
          threadnoteHome: TEST_HOME,
        },
      ]);
      expect(harness.observation.analysisCalls).toBe(0);
      expect(harness.observation.statusOptions).toHaveLength(1);
      expect(harness.observation.attachOptions).toEqual([{allowBorrowedStale: false, requestMaintenance: false}]);
    }).pipe(provideTestLayer(harness.layer));
  });
});

const TEST_HOME = '/threadnote-analysis-handler-home';

interface AnalyzeHandlerHarnessInput {
  readonly allowBackgroundRequest?: boolean;
  readonly attachResults: readonly CodeGraphStatus[];
  readonly inspectDelayMilliseconds?: number;
  readonly liveGit?: boolean;
  readonly manifestPath?: string;
  readonly refresh: boolean;
  readonly refreshStatus?: CodeGraphRefreshStatus;
  readonly rejectTargetedWatcherStatus?: boolean;
  readonly statuses: readonly CodeGraphStatus[];
}

function analyzeHandlerHarness(input: AnalyzeHandlerHarnessInput) {
  const statusOptions: Array<CodeGraphStatusOptions | undefined> = [];
  const attachOptions: Array<CodeGraphSharedReadyAttachInterlock | undefined> = [];
  const ensureOptions: CodeGraphWatchOptions[] = [];
  const refreshOptions: CodeGraphWatchOptions[] = [];
  const lifecycleEvents: string[] = [];
  const isolatedInspectStartSignals: Array<Deferred.Deferred<void>> = [];
  let analysisCalls = 0;
  let isolatedInspectCalls = 0;
  const isolatedRequests: Array<Record<string, unknown>> = [];
  const watcherStatusTargets: Array<Parameters<CodeGraphWatcherShape['cachedStatus']>[1]> = [];
  const scheduledResumeOptions: CodeGraphWatchOptions[] = [];
  let watcherStatusCalls = 0;
  let statusIndex = 0;
  let attachIndex = 0;
  const isolatedInspectStartSignal = (call: number) => {
    const existing = isolatedInspectStartSignals[call - 1];
    if (existing !== undefined) return existing;
    const signal = Deferred.makeUnsafe<void>();
    isolatedInspectStartSignals[call - 1] = signal;
    return signal;
  };
  const query = CodeGraphQueryService.of({
    attachSharedReadySnapshot: (_threadnoteHome, _identity, _observedStatus, options) =>
      Effect.sync(() => {
        attachOptions.push(options);
        const result = input.attachResults[attachIndex];
        attachIndex += 1;
        if (result === undefined) throw new Error(`Unexpected shared-ready attachment ${attachIndex}.`);
        return result;
      }),
    inspect: () => Effect.die('Unexpected in-process graph inspection.'),
    purge: () => Effect.die('Unexpected graph purge.'),
    status: (_threadnoteHome, _cwd, options) =>
      Effect.gen(function* () {
        statusOptions.push(options);
        const result = input.statuses[statusIndex] ?? input.statuses.at(-1);
        statusIndex += 1;
        if (result === undefined) return yield* Effect.die(`Unexpected graph status ${statusIndex}.`);
        if (options?.afterIdentityObserved !== undefined) yield* options.afterIdentityObserved(result.identity);
        return result;
      }),
    statusForIdentity: () => Effect.die('Unexpected identity status.'),
    statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
  });
  const watcher = CodeGraphWatcher.of({
    cachedStatus: (_key, target) =>
      Effect.sync(() => {
        watcherStatusTargets.push(target);
        return Option.some(input.refreshStatus ?? deferredRefreshStatus());
      }),
    ensure: options =>
      Effect.sync(() => {
        lifecycleEvents.push('watcher-ensure');
        ensureOptions.push(options);
      }),
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
    refresh: options =>
      Effect.sync(() => {
        refreshOptions.push(options);
        return input.refresh;
      }),
    request: () => {
      lifecycleEvents.push('background-refresh-request');
      return input.allowBackgroundRequest
        ? Effect.succeed({
            requestState: 'started',
            refresh: {state: 'active', type: 'code-graph-refresh-continuity', version: 1},
          })
        : Effect.die('Unexpected graph request.');
    },
    scheduleResume: options =>
      Effect.sync(() => {
        scheduledResumeOptions.push(options);
      }),
    status: (_key, target) =>
      Effect.sync(() => {
        watcherStatusCalls += 1;
        if (input.rejectTargetedWatcherStatus && target !== undefined) {
          throw new Error('Completed ready evidence must not wait for persisted watcher discovery.');
        }
        return Option.some(input.refreshStatus ?? deferredRefreshStatus());
      }),
    watch: () => Effect.die('Unexpected graph watch.'),
  });
  const store = pagedAnalysisStore([], []);
  const analysis = CodeGraphAnalysis.of({
    analyze: options =>
      Effect.sync(() => {
        analysisCalls += 1;
      }).pipe(Effect.andThen(analyzeCodeGraph(store, options))),
  });
  const command = CommandExecutor.of({
    execute: (executable, arguments_, options) =>
      input.liveGit === true && executable === 'git'
        ? Effect.sync(() => {
            const result = Bun.spawnSync([executable, ...arguments_], {
              cwd: options?.cwd,
              stderr: 'pipe',
              stdout: 'pipe',
            });
            return {
              exitCode: result.exitCode,
              stderr: new TextDecoder().decode(result.stderr),
              stdout: new TextDecoder().decode(result.stdout),
            };
          })
        : arguments_.at(-1) === '--threadnote-code-graph-analysis-worker'
          ? Effect.gen(function* () {
              const request = JSON.parse(new TextDecoder().decode(options?.input)) as CodeGraphAnalysisReadInput;
              const result = yield* serveCodeGraphAnalysisRead(request).pipe(
                Effect.provideService(CodeGraphQueryService, query),
                Effect.provideService(CodeGraphAnalysis, analysis),
                Effect.provideService(
                  CodeGraphIndexer,
                  {} as import('@threadnote/graph/indexer').CodeGraphIndexerShape,
                ),
                Effect.orDie,
              );
              return commandResult(JSON.stringify({protocol: 1, ok: true, result}));
            })
          : Effect.gen(function* () {
              isolatedInspectCalls += 1;
              yield* Deferred.succeed(isolatedInspectStartSignal(isolatedInspectCalls), undefined);
              const status = input.statuses[0];
              if (status === undefined || options?.input === undefined) {
                return yield* Effect.die('Unexpected isolated graph inspection.');
              }
              const request = JSON.parse(new TextDecoder().decode(options.input)) as Record<string, unknown> & {
                readonly operation: CodeGraphQueryResult['operation'];
              };
              lifecycleEvents.push('isolated-read-start');
              isolatedRequests.push(request);
              if (input.inspectDelayMilliseconds !== undefined) yield* Effect.sleep(input.inspectDelayMilliseconds);
              lifecycleEvents.push('isolated-read-complete');
              if (status.readySnapshot === undefined) {
                return commandResult(
                  JSON.stringify({
                    identity: {repoRoot: status.identity.repoRoot, worktreeId: status.identity.worktreeId},
                    ok: false,
                    protocol: 1,
                    telemetry: [],
                    unavailable: 'no-ready-snapshot',
                  }),
                );
              }
              return commandResult(
                JSON.stringify({
                  ok: true,
                  protocol: 1,
                  result: {
                    ...codeGraphInspectionResult(status, request.operation),
                    ...(status.projectCoverage === undefined ? {} : {projectCoverage: status.projectCoverage}),
                  },
                  status: {
                    stale: status.stale,
                    ...(status.readySnapshot === undefined ? {} : {readySnapshotId: status.readySnapshot.id}),
                    surface: {
                      freshness: status.freshness,
                      selection: 'active',
                      snapshot: {edgeCount: 0, fileCount: 0, symbolCount: 0},
                    },
                    worktreeId: status.identity.worktreeId,
                    repoRoot: status.identity.repoRoot,
                  },
                  telemetry: [],
                }),
              );
            }),
    executeBytes: (executable, arguments_, options) =>
      input.liveGit === true && executable === 'git'
        ? Effect.sync(() => {
            const result = Bun.spawnSync([executable, ...arguments_], {
              cwd: options?.cwd,
              stderr: 'pipe',
              stdout: 'pipe',
            });
            return {
              exitCode: result.exitCode,
              stderr: new TextDecoder().decode(result.stderr),
              stdout: new Uint8Array(result.stdout),
            };
          })
        : Effect.die('Unexpected binary command.'),
    executeStreaming: () => Effect.die('Unexpected streaming command.'),
  });
  const server = new EffectMcpServerAdapter('threadnote-analysis-handler-test', '1.0.0', 'Test server.');
  registerCodeGraphTool(server, runtimeConfig(input.manifestPath));
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
    Layer.succeed(SystemInfo, systemInfoStub()),
  );
  // This registry contains only the code-graph handlers audited above. The
  // production registry type is deliberately conservative because arbitrary
  // registries may capture any ApplicationServices member.
  // oxlint-disable effecttsgo/unsafe-effect-type-assertion -- narrow this test-only registry to its actual services
  const registrationLayer = server.registrationLayer() as Layer.Layer<
    never,
    never,
    McpServer.McpServer | Layer.Success<typeof applicationLayer>
  >;
  // oxlint-enable effecttsgo/unsafe-effect-type-assertion
  const layer = registrationLayer.pipe(Layer.provideMerge(mcpLayer), Layer.provideMerge(applicationLayer));

  return {
    awaitIsolatedInspectCall: (call: number) => Deferred.await(isolatedInspectStartSignal(call)),
    invoke: (arguments_: Record<string, unknown>) =>
      Effect.suspend(() => {
        const handle = analyzeHandle;
        if (handle === undefined) return Effect.die('analyze_code_graph was not registered.');
        return handle(arguments_).pipe(
          Effect.provideService(McpSchema.McpRequestContext, mcpServerClient()),
          Effect.flatMap(Schema.decodeUnknownEffect(McpSchema.CallToolResult)),
        );
      }),
    invokeInspect: (arguments_: Record<string, unknown>) =>
      Effect.suspend(() => {
        const handle = inspectHandle;
        if (handle === undefined) return Effect.die('inspect_code_graph was not registered.');
        return handle(arguments_).pipe(
          Effect.provideService(McpSchema.McpRequestContext, mcpServerClient()),
          Effect.flatMap(Schema.decodeUnknownEffect(McpSchema.CallToolResult)),
        );
      }),
    layer,
    observation: {
      attachOptions,
      ensureOptions,
      get analysisCalls() {
        return analysisCalls;
      },
      get isolatedInspectCalls() {
        return isolatedInspectCalls;
      },
      isolatedRequests,
      lifecycleEvents,
      refreshOptions,
      scheduledResumeOptions,
      statusOptions,
      get watcherStatusCalls() {
        return watcherStatusCalls;
      },
      watcherStatusTargets,
    },
  };
}

function scopedProjectObservation(): CodeGraphQueryScope {
  return {
    project: {
      graph: {closure: 'dependencies', roots: ['apps/web']},
      name: 'web',
      uri: 'threadnote://projects/web',
    },
    scope: {
      admittedPrefixes: ['apps/web', 'packages/shared'],
      closureDigest: 'closure-digest',
      completeness: 'complete',
      controlPaths: ['package.json'],
      definitionDigest: 'definition-digest',
      diagnostics: [],
      includedProjectIds: ['web', 'shared'],
      rootProjectIds: ['web'],
      scopeKey: 'code-graph-scope:web',
    },
    evidence: {
      catalogFingerprint: 'catalog-fingerprint',
      closureDigest: 'closure-digest',
      definitionDigest: 'definition-digest',
      extractorSet: 'extractor-set',
      inventoryFingerprint: 'inventory-fingerprint',
      observedCommit: 'b'.repeat(40),
      policyFingerprint: 'policy-fingerprint',
      repositoryId: analysisSnapshot([], []).repositoryId,
      scopeKey: 'code-graph-scope:web',
      worktreeId: analysisSnapshot([], []).worktreeId,
    },
  };
}

function commandResult(stdout: string): CommandResult {
  return {exitCode: 0, stderr: '', stdout};
}

function systemInfoStub(): SystemInfoShape {
  return {
    ...systemRuntimeBoundaries,
    architecture: 'arm64',
    availableDiskBytes: () => succeedUndefined,
    currentDirectory: () => '/',
    environment: () => ({HOME: '/bootstrap-home', PATH: '/bootstrap-bin'}),
    executablePath: '/opt/bin/bun',
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
    processArguments: ['/opt/bin/bun', '/apps/threadnote/src/standalone.ts', 'mcp-server'],
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

function codeGraphStatus(options: {readonly ready: boolean; readonly stale: boolean}): CodeGraphStatus {
  const readySnapshot = {...analysisSnapshot([], []), id: `cgsn_${'c'.repeat(40)}`};
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: 'analysis-checkout',
    displayName: 'Fixture/analysis',
    gitCommonDirectory: '/workspace/repository/.git',
    headCommit: readySnapshot.commit,
    objectFormat: 'sha1',
    repoRoot: '/workspace/repository',
    repositoryId: readySnapshot.repositoryId,
    worktreeId: readySnapshot.worktreeId,
  };
  return {
    databasePath: '/threadnote-analysis-handler-home/graph.sqlite',
    freshness: options.stale ? 'stale' : 'current',
    identity,
    languagePacks: [],
    ...(options.ready ? {readySnapshot} : {}),
    stale: options.stale,
  };
}

function codeGraphInspectionResult(
  status: CodeGraphStatus,
  operation: CodeGraphQueryResult['operation'],
): CodeGraphQueryResult {
  const snapshot = status.readySnapshot!;
  return {
    edges: [],
    freshness: status.stale ? 'stale' : 'current',
    nodes: [],
    operation,
    repository: {displayName: status.identity.displayName, repositoryId: status.identity.repositoryId},
    snapshot: {
      commit: snapshot.commit,
      dirty: snapshot.dirty,
      id: snapshot.id,
      worktreeId: status.identity.worktreeId,
    },
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    version: 1,
    warnings: [],
  };
}

function deferredRefreshStatus(): Extract<CodeGraphRefreshStatus, {readonly state: 'deferred'}> {
  return {
    failure: {
      code: 'busy',
      operation: 'refresh code graph',
      recovery: 'defer',
      retryable: true,
    },
    state: 'deferred',
  };
}

function indexingRefreshStatus(): Extract<CodeGraphRefreshStatus, {readonly state: 'indexing'}> {
  return {
    state: 'indexing',
    timing: {
      buildId: 'fixture-build',
      elapsedMilliseconds: 1_000,
      lastProgressAgeMilliseconds: 100,
      phaseElapsedMilliseconds: 1_000,
      phaseStartedAtMilliseconds: 1,
      startedAtMilliseconds: 1,
      updatedAtMilliseconds: 1_001,
    },
  };
}

function reconnectRefreshStatus(): Extract<CodeGraphRefreshStatus, {readonly state: 'deferred'}> {
  return {
    failure: {
      code: 'incompatible-schema',
      operation: 'refresh code graph',
      recovery: 'reconnect-runtime',
      retryable: false,
    },
    state: 'deferred',
  };
}

function runtimeConfig(manifestPath = `${TEST_HOME}/seed-manifest.yaml`): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: TEST_HOME,
    agentId: 'analysis-handler-test',
    manifestPath,
    user: 'analysis-handler-test',
  };
}

function graphManifest(projects: readonly string[], projectPath = '/workspace/repository'): string {
  return [
    'version: 1',
    'projects:',
    ...projects.flatMap(name => [
      `  - name: ${name}`,
      `    path: ${projectPath}`,
      '    seed: []',
      `    uri: threadnote://resources/repos/${name}`,
      '    graph:',
      '      closure: dependencies',
      '      roots: [src]',
    ]),
    '',
  ].join('\n');
}

function mcpServerClient(): McpSchema.McpServerClient['Service'] {
  return McpSchema.McpServerClient.of({
    clientCapabilities: {},
    clientId: 0,
    clientInfo: {name: 'analysis-handler-test', version: '1.0.0'},
    getClient: Effect.never,
    initializePayload: {
      capabilities: {},
      clientInfo: {name: 'analysis-handler-test', version: '1.0.0'},
      protocolVersion: '2025-06-18',
    },
    protocolVersion: '2025-06-18',
  });
}
