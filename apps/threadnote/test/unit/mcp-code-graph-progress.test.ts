import {fcProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {TestError} from '@threadnote/testing/test-error';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {
  codeGraphAnalysisMcpResponse,
  codeGraphAnalysisRefreshResult,
  codeGraphInspectionAllowsStaleReady,
  codeGraphInspectionObservesWorktree,
  codeGraphInspectionObservation,
  codeGraphInspectionRequestsBackgroundRefresh,
  codeGraphInspectionStartsRefresh,
  codeGraphMcpAnalysisBudget,
  codeGraphMcpAnalysisLimits,
  codeGraphMcpResponse,
  codeGraphResultWithRefreshContinuity,
  codeGraphRefreshBlocksReadyInspection,
  codeGraphQueryTimeoutResult,
  codeGraphRetryAfterMilliseconds,
  compactCodeGraphMcpProgress,
  compactCodeGraphMcpResult,
  compactCodeGraphMcpTiming,
  selectCodeGraphReadySnapshotForInspection,
} from '@threadnote/threadnote/mcp/server/index';
import {
  codeGraphQueryExecutionBudget,
  completeCodeGraphReadyReadRefresh,
  codeGraphRefreshBlocksCompletedInspection,
} from '@threadnote/threadnote/mcp/server/code_graph/ready_read';
import {analyzeCodeGraph} from '@threadnote/graph/analysis';
import type {CodeGraphProgress, CodeGraphQueryResult} from '@threadnote/graph/types';
import type {CodeGraphRefreshStatus, CodeGraphWatcherShape} from '@threadnote/graph/watcher';
import {
  codeGraphInspectionNeedsReadyAttachment,
  type CodeGraphStatusObservation,
} from '@threadnote/graph/query/contract';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {formatCodeGraphMcpResponse} from '@threadnote/threadnote/mcp/code_graph_projection';
import {
  analysisEdge,
  analysisSnapshot,
  analysisSymbol,
  pagedAnalysisStore,
} from '@threadnote/graph/test/helpers/code-graph-analysis';
import {
  readAnonymousTelemetryDiagnostic,
  readAnonymousTelemetryReportedOutcome,
} from '@threadnote/threadnote/telemetry/diagnostic';

describe('MCP code graph indexing progress', () => {
  fcProp(
    it,
    'preserves selected evidence without letting fallback observations change an operation freshness contract',
    {
      operation: FC.constantFrom(
        'query' as const,
        'node' as const,
        'neighbors' as const,
        'explain' as const,
        'path' as const,
        'impact' as const,
      ),
      borrowedSnapshotId: FC.option(FC.string({maxLength: 40}), {nil: undefined}),
      dirty: FC.boolean(),
      observed: FC.boolean(),
      fingerprint: FC.string({maxLength: 64}),
    },
    ({operation, borrowedSnapshotId, dirty, observed, fingerprint}) => {
      const observation: CodeGraphStatusObservation = {
        identity: {
          caseMode: 'sensitive',
          checkoutId: 'checkout',
          displayName: 'fixture',
          gitCommonDirectory: '/fixture/.git',
          headCommit: 'head',
          objectFormat: 'sha1',
          repoRoot: '/fixture',
          repositoryId: 'repository',
          worktreeId: 'worktree',
        },
        ...(borrowedSnapshotId === undefined ? {} : {borrowedSnapshotId}),
        projectScope: {
          project: {name: 'fixture-project', uri: 'threadnote://projects/fixture-project'},
        },
        ...(observed ? {overlay: {dirty, fingerprint}} : {}),
      };
      const before = JSON.stringify(observation);
      const projected = codeGraphInspectionObservation(observation, operation);
      expect(projected?.identity).toBe(observation.identity);
      expect(projected?.borrowedSnapshotId).toBe(borrowedSnapshotId);
      expect(projected?.projectScope).toBe(observation.projectScope);
      if (operation === 'path' || operation === 'impact') expect(projected).toBe(observation);
      else expect(projected?.overlay).toBeUndefined();
      expect(codeGraphInspectionObservation(projected, operation)).toEqual(projected);
      expect(JSON.stringify(observation)).toBe(before);
      expect(codeGraphInspectionObservation(undefined, operation)).toBeUndefined();
    },
    {fastCheck: {numRuns: 100}},
  );

  it('allows stale ready evidence for non-strict operations only', () => {
    expect(
      Object.fromEntries(
        (['query', 'node', 'neighbors', 'explain', 'path', 'impact'] as const).map(operation => [
          operation,
          codeGraphInspectionAllowsStaleReady(operation),
        ]),
      ),
    ).toEqual({explain: true, impact: false, neighbors: true, node: true, path: false, query: true});
  });

  it('identifies stale ready evidence that may install background monitoring', () => {
    for (const operation of ['query', 'node', 'neighbors', 'explain', 'path', 'impact'] as const) {
      expect(codeGraphInspectionRequestsBackgroundRefresh({readySnapshot: {id: 'ready'}, stale: true}, operation)).toBe(
        codeGraphInspectionAllowsStaleReady(operation),
      );
      expect(codeGraphInspectionRequestsBackgroundRefresh({stale: true}, operation)).toBe(false);
      expect(
        codeGraphInspectionRequestsBackgroundRefresh({readySnapshot: {id: 'ready'}, stale: false}, operation),
      ).toBe(false);
    }
  });

  effectIt.effect('schedules durable demand off the response path after a stale ready read', () =>
    Effect.gen(function* () {
      let ensured = 0;
      let requested = 0;
      let scheduledRequests = 0;
      let scheduledResumes = 0;
      const watcher = {
        ensure: () =>
          Effect.sync(() => {
            ensured += 1;
          }),
        request: () =>
          Effect.sync(() => {
            requested += 1;
            return {
              refresh: {
                state: 'active' as const,
                type: 'code-graph-refresh-continuity' as const,
                version: 1 as const,
              },
              requestState: 'started' as const,
            };
          }),
        scheduleRequest: () =>
          Effect.sync(() => {
            scheduledRequests += 1;
          }),
        scheduleResume: () =>
          Effect.sync(() => {
            scheduledResumes += 1;
          }),
      } as unknown as CodeGraphWatcherShape;

      const continuity = yield* completeCodeGraphReadyReadRefresh({
        backgroundRefreshRequested: true,
        ensureWatcher: true,
        key: 'worktree',
        target: {cwd: '/fixture/repository', threadnoteHome: '/fixture/home'},
        watcher,
      });

      expect(continuity).toEqual({state: 'deferred', type: 'code-graph-refresh-continuity', version: 1});
      const active = {
        currentTargetToken: `cgdq_${'1'.repeat(32)}`,
        state: 'active' as const,
        type: 'code-graph-refresh-continuity' as const,
        version: 1 as const,
      };
      const preserved = yield* completeCodeGraphReadyReadRefresh({
        backgroundRefreshRequested: true,
        ensureWatcher: true,
        key: 'worktree',
        refresh: active,
        target: {cwd: '/fixture/repository', threadnoteHome: '/fixture/home'},
        watcher,
      });
      expect(preserved).toEqual(active);
      expect(ensured).toBe(2);
      expect(requested).toBe(0);
      expect(scheduledRequests).toBe(2);
      expect(scheduledResumes).toBe(0);

      yield* completeCodeGraphReadyReadRefresh({
        backgroundRefreshRequested: true,
        ensureWatcher: false,
        key: 'worktree',
        refreshStatus: deferredStatus('no-space'),
        target: {cwd: '/fixture/repository', threadnoteHome: '/fixture/home'},
        watcher,
      });
      expect(scheduledRequests).toBe(2);

      yield* completeCodeGraphReadyReadRefresh({
        backgroundRefreshRequested: true,
        ensureWatcher: false,
        key: 'worktree',
        refreshStatus: deferredStatus('transient-io'),
        target: {cwd: '/fixture/repository', threadnoteHome: '/fixture/home'},
        watcher,
      });
      expect(scheduledRequests).toBe(3);
    }),
  );

  fcProp(
    it,
    'observes the worktree only for current-required inspections',
    {
      operation: FC.constantFrom(
        'query' as const,
        'node' as const,
        'neighbors' as const,
        'explain' as const,
        'path' as const,
        'impact' as const,
      ),
    },
    ({operation}) => {
      expect(codeGraphInspectionObservesWorktree(operation)).toBe(operation === 'path' || operation === 'impact');
      expect(codeGraphInspectionObservesWorktree(operation)).toBe(!codeGraphInspectionAllowsStaleReady(operation));
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'starts refresh only for current-required inspections without current evidence',
    {
      operation: FC.constantFrom(
        'query' as const,
        'node' as const,
        'neighbors' as const,
        'explain' as const,
        'path' as const,
        'impact' as const,
      ),
      ready: FC.boolean(),
      stale: FC.boolean(),
    },
    ({operation, ready, stale}) => {
      expect(
        codeGraphInspectionStartsRefresh({readySnapshot: ready ? {id: 'ready'} : undefined, stale}, operation),
      ).toBe((!ready || stale) && (operation === 'path' || operation === 'impact'));
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'attaches a compatible ready snapshot whenever the observed pointer is missing or stale',
    {
      ready: FC.boolean(),
      stale: FC.boolean(),
    },
    ({ready, stale}) => {
      expect(codeGraphInspectionNeedsReadyAttachment({readySnapshot: ready ? {id: 'ready'} : undefined, stale})).toBe(
        !ready || stale,
      );
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'serves a borrowed stale snapshot only for ordinary inspections',
    {
      operation: FC.constantFrom(
        'query' as const,
        'node' as const,
        'neighbors' as const,
        'explain' as const,
        'path' as const,
        'impact' as const,
      ),
    },
    ({operation}) => {
      const borrowed = {id: 'borrowed'};
      const status = {readySnapshot: borrowed, stale: true};
      const allowStale = codeGraphInspectionAllowsStaleReady(operation);
      const indexing = indexingStatus(60_000);

      expect(codeGraphInspectionStartsRefresh(status, operation)).toBe(!allowStale);
      expect(selectCodeGraphReadySnapshotForInspection(status, indexing, allowStale)).toBe(
        allowStale ? borrowed : undefined,
      );
    },
    {fastCheck: {numRuns: 100}},
  );

  it('allows an explicitly safe ready graph to serve while background indexing continues', () => {
    const indexing = indexingStatus(60_000);

    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'ready'}, stale: false}, indexing)).toBe(false);
    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, indexing)).toBe(true);
    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, indexing, true)).toBe(
      false,
    );
    expect(codeGraphRefreshBlocksReadyInspection({stale: true}, indexing)).toBe(true);
    expect(
      codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'ready'}, stale: false}, deferredStatus('busy')),
    ).toBe(false);
    expect(
      codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, deferredStatus('busy')),
    ).toBe(true);
    expect(
      codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, deferredStatus('busy'), true),
    ).toBe(false);
  });

  it('never lets a deferred or active refresh hide a usable ready snapshot', () => {
    const refreshStatuses = [deferredStatus('busy'), indexingStatus(60_000)];
    for (const refresh of refreshStatuses) {
      for (const stale of [false, true]) {
        for (const allowStale of [false, true]) {
          const usable = !stale || allowStale;
          expect(
            codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'ready'}, stale}, refresh, allowStale),
          ).toBe(!usable);
        }
      }
    }
  });

  it('does not block inspection after a shared ready snapshot is attached to the worktree', () => {
    const indexing = indexingStatus(60_000);
    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'cgsn_shared'}, stale: false}, indexing)).toBe(
      false,
    );
  });

  fcProp(
    it,
    'keeps the exact ready snapshot selected until a verified promotion changes the observed pointer',
    {
      allowStale: FC.boolean(),
      failureCode: FC.constantFrom(
        'busy' as const,
        'no-space' as const,
        'permission' as const,
        'transient-io' as const,
      ),
      refreshState: FC.constantFrom('deferred' as const, 'indexing' as const),
      stale: FC.boolean(),
      verifiedPromotion: FC.boolean(),
    },
    ({allowStale, failureCode, refreshState, stale, verifiedPromotion}) => {
      const ready = {id: 'R'};
      const candidate = {id: 'candidate'};
      const observed = verifiedPromotion ? candidate : ready;
      const refresh = refreshState === 'deferred' ? deferredStatus(failureCode) : indexingStatus(60_000);
      const selected = selectCodeGraphReadySnapshotForInspection({readySnapshot: observed, stale}, refresh, allowStale);
      const usable = !stale || allowStale;

      expect(selected).toBe(usable ? observed : undefined);
      expect(codeGraphRefreshBlocksCompletedInspection({readySnapshot: observed, stale}, refresh, allowStale)).toBe(
        !allowStale && !usable,
      );
      if (!verifiedPromotion) expect(selected).not.toBe(candidate);
    },
    {fastCheck: {numRuns: 250}},
  );

  it('serves stale non-strict evidence with one bounded path-free recovery warning', () => {
    const result = {...verboseCodeGraphResult(), freshness: 'stale' as const, warnings: []};
    const deferred = {
      ...deferredStatus('no-space'),
      privateNativeDetail: '/Users/private/graph.sqlite',
    } as unknown as CodeGraphRefreshStatus;
    const continued = codeGraphResultWithRefreshContinuity(result, deferred);

    expect(continued.freshness).toBe('stale');
    expect(continued.snapshot).toBe(result.snapshot);
    expect(continued.warnings).toHaveLength(1);
    expect(continued.warnings[0]).toContain('no-space');
    expect(continued.warnings[0]).toContain('Free storage space');
    expect(continued.warnings[0].length).toBeLessThanOrEqual(320);
    expect(JSON.stringify(continued)).not.toContain('/Users/private');
    expect(codeGraphResultWithRefreshContinuity(continued, deferred)).toBe(continued);
  });

  it('labels stale ready evidence while indexing continues', () => {
    const result = {...verboseCodeGraphResult(), freshness: 'stale' as const, warnings: []};
    const continued = codeGraphResultWithRefreshContinuity(result, indexingStatus(60_000));

    expect(continued.warnings).toEqual([
      'Serving the existing stale ready snapshot while code graph refresh continues in the background.',
    ]);
    expect(codeGraphResultWithRefreshContinuity(continued, indexingStatus(60_000))).toBe(continued);
  });

  it('labels stale ready evidence with bounded background-discovery guidance', () => {
    const result = {...verboseCodeGraphResult(), freshness: 'stale' as const, warnings: []};
    const continued = codeGraphResultWithRefreshContinuity(result, undefined);

    expect(continued.warnings).toEqual([
      'Serving the existing stale ready snapshot while background refresh discovery is pending; continue bounded discovery and use `path` or `impact` when current graph evidence is required.',
    ]);
  });

  fcProp(
    it,
    'keeps optional refresh continuity deterministic, budgeted, and text-dual equivalent',
    {
      state: FC.constantFrom('active' as const, 'queued' as const, 'deferred' as const, 'idle' as const),
      budgetTokens: FC.integer({min: 800, max: 1_500}),
    },
    ({state, budgetTokens}) => {
      const refresh = {
        type: 'code-graph-refresh-continuity' as const,
        version: 1 as const,
        state,
        ...(state === 'idle' ? {} : {queueToken: `cgdq_${'a'.repeat(32)}`}),
        ...(state === 'deferred' ? {retryAfterMilliseconds: 1_000} : {}),
      };
      const result = verboseCodeGraphResult();
      const first = codeGraphMcpResponse(result, budgetTokens, refresh);
      const second = codeGraphMcpResponse(result, budgetTokens, refresh);
      expect(first.structuredContent).toEqual(second.structuredContent);
      expect(first.structuredContent.refresh).toEqual(refresh);
      const text = formatCodeGraphMcpResponse(first, 'text');
      expect(JSON.parse((text.content[0] as {readonly text: string}).text)).toEqual(first.structuredContent);
      expect(measureAgentToolResponse(first).totalBytes).toBeLessThanOrEqual(budgetTokens * 4);
    },
    {fastCheck: {numRuns: 50}},
  );

  it('keeps path, impact, and whole-graph analysis strict when refresh is deferred', () => {
    const deferred = deferredStatus('permission');
    for (const operation of ['path', 'impact'] as const) {
      expect(codeGraphQueryTimeoutResult(operation, deferred)).toMatchObject({
        structuredContent: {
          failure: {code: 'permission', recovery: 'fix-permissions'},
          operation,
          state: 'deferred',
          version: 4,
        },
      });
    }
    expect(codeGraphAnalysisRefreshResult('stats', deferred)).toMatchObject({
      structuredContent: {
        failure: {code: 'permission', recovery: 'fix-permissions'},
        operation: 'stats',
        state: 'deferred',
        type: 'code-graph-analysis-state',
        version: 2,
      },
    });
    expect(readAnonymousTelemetryReportedOutcome(codeGraphAnalysisRefreshResult('stats', deferred))).toBe('failure');
  });

  it('returns a structured reconnect requirement when a newer runtime upgraded graph storage', () => {
    const runtimeSkew = {
      failure: {
        code: 'incompatible-schema',
        operation: 'refresh code graph',
        recovery: 'reconnect-runtime',
        retryable: false,
      },
      state: 'deferred',
    } as const satisfies CodeGraphRefreshStatus;

    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, runtimeSkew, true)).toBe(
      true,
    );
    expect(
      codeGraphRefreshBlocksCompletedInspection({readySnapshot: {id: 'stale'}, stale: true}, runtimeSkew, true),
    ).toBe(false);

    const inspection = codeGraphQueryTimeoutResult('query', runtimeSkew);
    expect(inspection.structuredContent).toMatchObject({
      failure: {code: 'incompatible-schema', recovery: 'reconnect-runtime'},
      operation: 'query',
      state: 'reconnect-required',
      type: 'code-graph-index-state',
    });
    expect(JSON.stringify(inspection)).toMatch(/reconnect/i);

    const analysis = codeGraphAnalysisRefreshResult('stats', runtimeSkew);
    expect(analysis.structuredContent).toMatchObject({
      failure: {code: 'incompatible-schema', recovery: 'reconnect-runtime'},
      operation: 'stats',
      state: 'reconnect-required',
      type: 'code-graph-analysis-state',
    });
    expect(JSON.stringify(analysis)).toMatch(/reconnect/i);
    expect(readAnonymousTelemetryReportedOutcome(analysis)).toBe('failure');
    expect(readAnonymousTelemetryDiagnostic(analysis)).toEqual({
      code: 'incompatible-schema',
      domain: 'code-graph-storage',
      errorType: 'CodeGraphStoreError',
      operation: 'refresh code graph',
      recovery: 'reconnect-runtime',
      retryable: false,
    });
  });

  it('derives a bounded adaptive poll interval from the phase estimate', () => {
    expect(codeGraphRetryAfterMilliseconds(undefined)).toBe(5_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(4_000))).toBe(3_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(60_000))).toBe(15_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(60 * 60_000))).toBe(30_000);
  });

  it('reserves three seconds for query cleanup and response finalization', () => {
    expect(
      [4_000, 4_001, 25_000, 55_000].map(requestBudget => [
        requestBudget,
        codeGraphQueryExecutionBudget(requestBudget),
      ]),
    ).toEqual([
      [4_000, 1_000],
      [4_001, 1_001],
      [25_000, 22_000],
      [55_000, 52_000],
    ]);
  });

  fcProp(
    it,
    'keeps every accepted query budget above the cleanup reserve',
    {requestBudget: FC.integer({min: 4_000, max: 55_000})},
    ({requestBudget}) => {
      const executionBudget = codeGraphQueryExecutionBudget(requestBudget);
      expect(executionBudget).toBeGreaterThanOrEqual(1_000);
      expect(executionBudget).toBeLessThanOrEqual(requestBudget);
      expect(requestBudget - executionBudget).toBe(3_000);
    },
    {fastCheck: {numRuns: 100}},
  );

  it('keeps elapsed query, active indexing, and deferred refresh states explicit', () => {
    const timedOut = codeGraphQueryTimeoutResult('query');
    expect(timedOut.isError).not.toBe(true);
    expect(timedOut.structuredContent).toMatchObject({
      retryAfterMilliseconds: 5_000,
      state: 'timed-out',
      type: 'code-graph-query-state',
      version: 2,
    });
    expect(readAnonymousTelemetryReportedOutcome(timedOut)).toBe('timed-out');

    const readyReadTimedOut = codeGraphQueryTimeoutResult('query', indexingStatus(60_000), true);
    expect(readyReadTimedOut.structuredContent).toMatchObject({
      readySnapshotAvailable: true,
      state: 'timed-out',
      type: 'code-graph-query-state',
    });
    expect(JSON.stringify(readyReadTimedOut.structuredContent)).not.toContain('retryAfterMilliseconds');
    const readyReadTimeoutText = (readyReadTimedOut.content[0] as {readonly text: string}).text;
    expect(readyReadTimeoutText).toContain('55-second MCP budget');
    expect(readyReadTimeoutText).toContain('--freshness ready --read-timeout-ms 120000');
    expect(readAnonymousTelemetryReportedOutcome(readyReadTimedOut)).toBe('timed-out');

    const indexing = codeGraphQueryTimeoutResult('query', indexingStatus(60_000));
    expect(indexing.isError).not.toBe(true);
    expect(indexing.structuredContent).toMatchObject({
      retryAfterMilliseconds: 15_000,
      state: 'indexing',
      type: 'code-graph-index-state',
      version: 3,
    });
    expect(readAnonymousTelemetryReportedOutcome(indexing)).toBe('unavailable');

    const writerWaiting = codeGraphQueryTimeoutResult('query', {
      ...indexingStatus(60_000),
      progress: {phase: 'waiting', reason: 'database-writer'},
    });
    expect(writerWaiting.structuredContent).toMatchObject({
      phase: 'waiting',
      progress: {reason: 'database-writer'},
      state: 'indexing',
    });
    expect(JSON.stringify(writerWaiting.structuredContent)).not.toContain('retryAfterMilliseconds');
    expect((writerWaiting.content[0] as {readonly text: string}).text).toContain('retry after it releases');

    const deferred = codeGraphQueryTimeoutResult('query', deferredStatus('transient-io'));
    expect(deferred.isError).not.toBe(true);
    expect(deferred.structuredContent).toMatchObject({
      failure: {code: 'transient-io', recovery: 'retry-read-only', retryable: true},
      state: 'deferred',
      type: 'code-graph-index-state',
      version: 4,
    });
    expect(readAnonymousTelemetryReportedOutcome(deferred)).toBe('failure');
    expect(readAnonymousTelemetryDiagnostic(deferred)).toEqual({
      code: 'transient-io',
      domain: 'code-graph-storage',
      errorType: 'CodeGraphStoreError',
      operation: 'refresh code graph',
      recovery: 'retry-read-only',
      retryable: true,
    });
    for (const result of [timedOut, indexing, deferred]) {
      expect(JSON.stringify(result)).not.toContain('anonymous-telemetry');
      expect(Object.getOwnPropertySymbols(result)).not.toEqual([]);
    }
  });

  fcProp(
    it,
    'never reports refresh progress after a ready-snapshot read has begun',
    {
      operation: FC.constantFrom('query' as const, 'node' as const, 'neighbors' as const, 'explain' as const),
      refreshState: FC.constantFrom('none' as const, 'indexing' as const, 'deferred' as const),
    },
    ({operation, refreshState}) => {
      const status =
        refreshState === 'indexing'
          ? indexingStatus(60_000)
          : refreshState === 'deferred'
            ? deferredStatus('busy')
            : undefined;
      const result = codeGraphQueryTimeoutResult(operation, status, true);
      expect(result.structuredContent).toMatchObject({readySnapshotAvailable: true, state: 'timed-out'});
      expect(JSON.stringify(result)).not.toContain('Retry this inspect_code_graph call in about');
      expect(JSON.stringify(result)).not.toContain('retryAfterMilliseconds');
    },
    {fastCheck: {numRuns: 60}},
  );

  it('keeps detailed materialization telemetry out of MCP indexing state', () => {
    const progress: CodeGraphProgress = {
      activity: {
        batchCompleted: 17,
        batchTotal: 200,
        cachedFactBytes: 999_999_999,
        elapsedMilliseconds: 12_345,
        rows: {edges: 8_000_000, symbols: 2_000_000, terms: 48_000_000},
        sourceBytes: 123_456_789,
        stage: 'writing-terms',
        transactionMilliseconds: 2_500,
      },
      completed: 2_176,
      metrics: {
        batchesCompleted: 17,
        batchesTotal: 200,
        cachedFactBytesCompleted: 9_999_999,
        cachedFactBytesTotal: 99_999_999,
        rows: {edges: 8_000_000, symbols: 2_000_000, terms: 48_000_000},
        sourceBytesCompleted: 1_000_000,
        sourceBytesTotal: 10_000_000,
        storage: {
          estimatedRequiredBytes: 200_000_000_000,
          temporaryDatabaseBytes: 10_000_000_000,
          temporaryDatabaseHighWaterBytes: 12_000_000_000,
        },
      },
      phase: 'materializing',
      reused: 2_000,
      total: 25_600,
      unit: 'files',
    };
    const compact = compactCodeGraphMcpProgress(progress);
    const serialized = JSON.stringify(compact);

    expect(compact).toEqual({
      activity: {batchCompleted: 17, batchTotal: 200, stage: 'writing-terms'},
      completed: 2_176,
      phase: 'materializing',
      reused: 2_000,
      total: 25_600,
      type: 'code-graph-progress',
      unit: 'files',
      version: 1,
    });
    expect(serialized).not.toContain('storage');
    expect(serialized).not.toContain('cachedFactBytes');
    expect(serialized.length).toBeLessThan(300);
  });

  it('reports the compact reason for a queued graph build', () => {
    expect(compactCodeGraphMcpProgress({phase: 'waiting', reason: 'database-writer'})).toEqual({
      phase: 'waiting',
      reason: 'database-writer',
      type: 'code-graph-progress',
      version: 1,
    });
    const admission = {
      admissionClass: 'background' as const,
      enqueuedAt: '2026-09-17T12:00:00.000Z',
      position: 3,
      size: 4,
    };
    expect(compactCodeGraphMcpProgress({phase: 'waiting', reason: 'home-builder-cap', admission})).toEqual({
      phase: 'waiting',
      reason: 'home-builder-cap',
      admission,
      type: 'code-graph-progress',
      version: 1,
    });
  });

  it('keeps required stale-storage reclamation progress concise', () => {
    expect(
      compactCodeGraphMcpProgress({
        completed: 0,
        pagesCompleted: 42,
        phase: 'reclaiming',
        rowsDeleted: 210_000,
        total: 1,
        unit: 'snapshots',
      }),
    ).toEqual({
      completed: 0,
      pagesCompleted: 42,
      phase: 'reclaiming',
      rowsDeleted: 210_000,
      total: 1,
      type: 'code-graph-progress',
      unit: 'snapshots',
      version: 1,
    });
  });

  it('bounds MCP graph evidence and omits indexing-only symbol fields', () => {
    const result = verboseCodeGraphResult();
    const compact = compactCodeGraphMcpResult(result);
    const serialized = JSON.stringify(compact);

    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(24 * 1_024);
    expect(compact.output.truncated).toBe(true);
    expect(compact).toMatchObject({sourceVersion: 1, type: 'code-graph-inspection', version: 1});
    expect(compact.output.returnedNodes).toBeLessThan(result.nodes.length);
    expect(compact.output.returnedEdges).toBeLessThan(result.edges.length);
    expect(serialized).not.toContain('lookupKeys');
    expect(serialized).not.toContain('documentation');
    expect(serialized).not.toContain('contentHash');
    expect(compact.nodes[0]).toMatchObject({id: 'cgs_0000', name: expect.any(String), path: expect.any(String)});
    expect(compact.warnings.at(-1)).toContain('refine the query');

    const response = codeGraphMcpResponse(result);
    expect(response.text).toContain('MCP output was bounded to');
    expect(new TextEncoder().encode(response.text).byteLength).toBeLessThan(20 * 1_024);
  });

  it('truncates adversarial graph fields before encoding their discarded tails', () => {
    const verbose = verboseCodeGraphResult();
    const result = {
      ...verbose,
      edges: [],
      nodes: [{...verbose.nodes[0], signature: 'x'.repeat(2_000_000)}],
      operation: 'node' as const,
      warnings: [],
    };
    const encode = TextEncoder.prototype.encode;
    let largestEncodedInput = 0;
    TextEncoder.prototype.encode = function (input = '') {
      largestEncodedInput = Math.max(largestEncodedInput, input.length);
      if (input.length > 100_000) throw new Error('discarded source tail reached the UTF-8 encoder');
      return encode.call(this, input);
    };
    try {
      const response = codeGraphMcpResponse(result);
      expect(response.structuredContent.nodes).toHaveLength(1);
      expect(response.structuredContent.nodes[0]?.signature).toMatch(/…$/u);
      expect(largestEncodedInput).toBeLessThan(100_000);
    } finally {
      TextEncoder.prototype.encode = encode;
    }
  });

  it('returns the exact graph projection through one opt-in text channel', () => {
    const response = codeGraphMcpResponse(verboseCodeGraphResult());
    const dual = formatCodeGraphMcpResponse(response);
    const text = formatCodeGraphMcpResponse(response, 'text');

    expect(dual).toEqual({
      content: [{type: 'text', text: response.text}],
      structuredContent: response.structuredContent,
    });
    expect(text).not.toHaveProperty('structuredContent');
    expect(text.content).toHaveLength(1);
    expect(JSON.parse(text.content[0].text)).toEqual(dual.structuredContent);
    expect(text.content[0].text).toBe(JSON.stringify(dual.structuredContent));
    expect(text.content[0].text).toContain('"trust"');
    expect(text.content[0].text).toContain('"snapshot"');
    expect(text.content[0].text).toContain('"output"');
    expect(response.structuredContent).toEqual(dual.structuredContent);
  });

  it('renders a deterministic schema-aware agent receipt without structured duplication', () => {
    const response = codeGraphMcpResponse(
      {...verboseCodeGraphResult(), operation: 'neighbors'},
      1_500,
      undefined,
      'agent',
    );
    const first = formatCodeGraphMcpResponse(response, 'agent');
    const second = formatCodeGraphMcpResponse(response, 'agent');
    const text = first.content[0].text;

    expect(first).toEqual(second);
    expect(first).not.toHaveProperty('structuredContent');
    expect(text.startsWith('TN-GRAPH/1\n')).toBe(true);
    expect(text).toContain('Coverage:');
    expect(text).toContain('n1. ');
    expect(text).toContain(' → ');
    expect(text).not.toContain('\noperation\t');
    expect(text).not.toContain('\nrepository\t');
    expect(text).not.toContain('\nsnapshot\t');
    expect(text).not.toContain('\ntrust\t');
    expect(text).not.toContain('\nsourceVersion\t');
    expect(measureAgentToolResponse({text}).totalBytes).toBeLessThanOrEqual(1_500 * 3);
  });

  it('stops impact projection after a connected behavioral core instead of filling the budget', () => {
    const verbose = verboseCodeGraphResult();
    const nodes = verbose.nodes.slice(0, 6).map((node, index) => ({
      ...node,
      name: `node-${index}`,
      path: `src/node-${index}.ts`,
      qualifiedName: `Fixture.node${index}`,
      signature: `function node${index}(): void`,
    }));
    const edge = (
      index: number,
      sourceIndex: number,
      targetIndex: number,
      relation: CodeGraphQueryResult['edges'][number]['relation'],
    ) => {
      const source = nodes[sourceIndex];
      const target = nodes[targetIndex];
      return {
        ...verbose.edges[index],
        evidencePath: `src/node-${sourceIndex}.ts`,
        id: `cge_core_${index}`,
        relation,
        sourceId: source.id,
        sourceName: source.name,
        targetId: target.id,
        targetName: target.name,
      };
    };
    const result: CodeGraphQueryResult = {
      ...verbose,
      edges: [edge(0, 3, 0, 'imports'), edge(1, 1, 0, 'calls'), edge(2, 2, 1, 'calls'), edge(3, 4, 2, 'contains')],
      nodes,
      operation: 'impact',
      warnings: [],
    };
    const before = JSON.stringify(result);
    const defaultResponse = codeGraphMcpResponse(result, undefined, undefined, 'agent');
    const explicitCore = codeGraphMcpResponse(result, 1_250, undefined, 'agent');
    const largerCeiling = codeGraphMcpResponse(result, 1_500, undefined, 'agent');

    expect(defaultResponse).toEqual(explicitCore);
    expect(largerCeiling).toEqual(explicitCore);
    expect(defaultResponse.structuredContent.nodes.map(node => node.id)).toEqual([
      nodes[1].id,
      nodes[0].id,
      nodes[2].id,
    ]);
    expect(defaultResponse.structuredContent.edges.map(item => item.id)).toEqual(['cge_core_1', 'cge_core_2']);
    expect(defaultResponse.structuredContent.output).toMatchObject({
      returnedEdges: 2,
      returnedNodes: 3,
      totalEdges: 4,
      totalNodes: 6,
      truncated: true,
    });
    const visibleNodeIds = new Set(defaultResponse.structuredContent.nodes.map(node => node.id));
    for (const item of defaultResponse.structuredContent.edges) {
      expect(visibleNodeIds.has(item.sourceId!)).toBe(true);
      expect(visibleNodeIds.has(item.targetId!)).toBe(true);
    }
    const formatted = formatCodeGraphMcpResponse(defaultResponse, 'agent');
    expect(measureAgentToolResponse({text: formatted.content[0].text}).totalBytes).toBeLessThan(1_250 * 3);
    expect(JSON.stringify(result)).toBe(before);

    const dual = codeGraphMcpResponse(result, undefined, undefined, 'dual');
    expect(dual.structuredContent.nodes.map(node => node.id)).toEqual(nodes.map(node => node.id));
    expect(dual.structuredContent.edges.map(item => item.id)).toEqual(result.edges.map(item => item.id));

    const danglingCall = {...edge(0, 1, 0, 'calls'), targetId: 'cgs_missing'};
    const connectedImport = edge(1, 3, 0, 'imports');
    const connectedFallback = codeGraphMcpResponse(
      {...result, edges: [danglingCall, connectedImport]},
      undefined,
      undefined,
      'agent',
    );
    expect(connectedFallback.structuredContent.edges.map(item => item.id)).toEqual([connectedImport.id]);
    expect(connectedFallback.structuredContent.nodes.map(node => node.id)).toEqual([nodes[3].id, nodes[0].id]);
  });

  it('stops default query projection after three ranked nodes while preserving explicit expansion', () => {
    const verbose = verboseCodeGraphResult();
    const nodes = verbose.nodes.slice(0, 6).map((node, index) => ({
      ...node,
      name: `node-${index}`,
      path: `src/node-${index}.ts`,
      qualifiedName: `Fixture.node${index}`,
      signature: `function node${index}(): void`,
    }));
    const edge = (index: number, sourceIndex: number, targetIndex: number) => ({
      ...verbose.edges[index],
      evidencePath: `src/node-${sourceIndex}.ts`,
      id: `cge_query_core_${index}`,
      sourceId: nodes[sourceIndex].id,
      sourceName: nodes[sourceIndex].name,
      targetId: nodes[targetIndex].id,
      targetName: nodes[targetIndex].name,
    });
    const dangling = {...edge(1, 1, 2), sourceId: 'cgs_missing'};
    const result: CodeGraphQueryResult = {
      ...verbose,
      edges: [edge(0, 0, 1), dangling, edge(2, 3, 4)],
      nodes,
      operation: 'query',
      warnings: [],
    };
    const before = JSON.stringify(result);
    const defaultResponse = codeGraphMcpResponse(result, 800, undefined, 'agent');
    const largerCeiling = codeGraphMcpResponse(result, 1_500, undefined, 'agent');

    expect(largerCeiling).toEqual(defaultResponse);
    expect(defaultResponse.structuredContent.nodes.map(node => node.id)).toEqual(
      nodes.slice(0, 3).map(node => node.id),
    );
    expect(defaultResponse.structuredContent.edges.map(item => item.id)).toEqual(['cge_query_core_0']);
    expect(defaultResponse.structuredContent.output).toMatchObject({
      returnedEdges: 1,
      returnedNodes: 3,
      totalEdges: 3,
      totalNodes: 6,
      truncated: true,
    });
    expect(defaultResponse.structuredContent.warnings.at(-1)).toContain('bounded to 3/6 nodes');

    const expanded = codeGraphMcpResponse(result, 1_500, undefined, 'agent', {queryNodeLimit: 5});
    expect(expanded.structuredContent.nodes.map(node => node.id)).toEqual(nodes.slice(0, 5).map(node => node.id));
    expect(expanded.structuredContent.edges.map(item => item.id)).toEqual(['cge_query_core_0', 'cge_query_core_2']);
    const expandedAgent = formatCodeGraphMcpResponse(expanded, 'agent');
    expect(measureAgentToolResponse({text: expandedAgent.content[0].text}).totalBytes).toBeLessThanOrEqual(1_500 * 3);

    const dual = codeGraphMcpResponse(result, undefined, undefined, 'dual', {queryNodeLimit: 3});
    expect(dual.structuredContent.nodes.map(node => node.id)).toEqual(nodes.map(node => node.id));
    expect(dual.structuredContent.edges.map(item => item.id)).toEqual(result.edges.map(item => item.id));
    expect(JSON.stringify(result)).toBe(before);
  });

  it('keeps only actionable stale, dirty, project, and refresh provenance in the agent receipt', () => {
    const source = verboseCodeGraphResult();
    const response = codeGraphMcpResponse(
      {
        ...source,
        edges: [],
        freshness: 'stale',
        nodes: [],
        projectCoverage: {
          completeness: 'partial',
          configuredRoots: ['root-a', 'root-b', 'root-c'],
          dependencyComponents: 2,
          kind: 'project',
          negativeProof: 'selected-graph-only',
          observedWorktreeCommit: 'b'.repeat(40),
          project: 'threadnote-app',
          reusedEquivalentSnapshot: false,
          rootComponents: 1,
        },
        snapshot: {...source.snapshot, commit: 'b'.repeat(40), dirty: true},
        warnings: [],
      },
      1_500,
      {
        failure: {
          code: 'transient-io',
          operation: 'refresh code graph',
          recovery: 'retry-read-only',
          retryable: true,
        },
        retryAfterMilliseconds: 5_000,
        state: 'deferred',
        type: 'code-graph-refresh-continuity',
        version: 1,
      },
      'agent',
    );
    const text = formatCodeGraphMcpResponse(response, 'agent').content[0].text;

    expect(text).toContain('Evidence: freshness stale, dirty worktree, commit bbbbbbbbbbbb, refresh');
    expect(text).toContain(
      'Project scope: threadnote-app, project, partial, negative proof selected-graph-only, roots root-a, root-b, 1 root(s) omitted.',
    );
    expect(text).not.toContain(source.repository.repositoryId);
    expect(text).not.toContain(source.snapshot.id);
  });

  fcProp(
    it,
    'makes clean-current agent receipts invariant to redundant operation and opaque identity metadata',
    {
      commit: FC.stringMatching(/^[a-f0-9]{40}$/u),
      operation: FC.constantFrom('query' as const, 'node' as const, 'neighbors' as const, 'explain' as const),
      repositoryId: FC.string({minLength: 1, maxLength: 64}),
      snapshotId: FC.string({minLength: 1, maxLength: 64}),
      worktreeId: FC.string({minLength: 1, maxLength: 64}),
    },
    ({commit, operation, repositoryId, snapshotId, worktreeId}) => {
      const source = verboseCodeGraphResult();
      const base = {...source, edges: [], nodes: [], warnings: []};
      const expected = formatCodeGraphMcpResponse(codeGraphMcpResponse(base, 1_500, undefined, 'agent'), 'agent');
      const actual = formatCodeGraphMcpResponse(
        codeGraphMcpResponse(
          {
            ...base,
            operation,
            repository: {displayName: `repository-${repositoryId}`, repositoryId},
            snapshot: {commit, dirty: false, id: snapshotId, worktreeId},
          },
          1_500,
          undefined,
          'agent',
        ),
        'agent',
      );
      expect(actual).toEqual(expected);
    },
    {fastCheck: {numRuns: 50}},
  );

  it('admits the advertised minimum budget for every local graph response format', () => {
    for (const responseFormat of ['dual', 'text', 'agent'] as const) {
      const response = codeGraphMcpResponse(verboseCodeGraphResult(), 800, undefined, responseFormat);
      const formatted = formatCodeGraphMcpResponse(response, responseFormat);
      const measurement = measureAgentToolResponse({
        ...(formatted.structuredContent === undefined ? {} : {structuredContent: formatted.structuredContent}),
        text: formatted.content[0].text,
      });
      expect(measurement.estimatedTokens).toBeLessThanOrEqual(800);
      expect(measurement.totalBytes).toBeLessThanOrEqual(800 * 3);
    }
  });

  it('bounds mandatory project metadata at the local minimum budget', () => {
    const result = {
      ...verboseCodeGraphResult(),
      outsideProjectGraph: {
        paths: Array.from({length: 40}, (_, index) => `outside/${'深/'.repeat(200)}${index}.ts`),
        state: 'outside-project-graph' as const,
        suggestedActions: Array.from({length: 20}, (_, index) => `Select ${'根/'.repeat(200)} ${index}.`),
      },
      projectCoverage: {
        completeness: 'partial' as const,
        configuredRoots: Array.from({length: 40}, (_, index) => `apps/${'root/'.repeat(200)}${index}`),
        dependencyComponents: 2,
        kind: 'project' as const,
        negativeProof: 'selected-graph-only' as const,
        observedWorktreeCommit: 'w'.repeat(2_000),
        project: 'project'.repeat(200),
        reusedEquivalentSnapshot: false,
        rootComponents: 3,
        snapshotSourceCommit: 's'.repeat(2_000),
      },
    };
    for (const responseFormat of ['dual', 'text', 'agent'] as const) {
      const response = codeGraphMcpResponse(result, 800, undefined, responseFormat);
      const formatted = formatCodeGraphMcpResponse(response, responseFormat);
      expect(
        measureAgentToolResponse({
          ...(formatted.structuredContent === undefined ? {} : {structuredContent: formatted.structuredContent}),
          text: formatted.content[0].text,
        }).totalBytes,
      ).toBeLessThanOrEqual(800 * 3);
    }
  });

  it('admits an emoji-heavy zero-evidence mandatory receipt at the local minimum', () => {
    const result = mandatoryEmojiGraphResult('😀'.repeat(5_000));
    const refresh = {
      queueToken: '😀'.repeat(5_000),
      state: 'queued' as const,
      type: 'code-graph-refresh-continuity' as const,
      version: 1 as const,
    };
    for (const responseFormat of ['dual', 'text', 'agent'] as const) {
      const response = codeGraphMcpResponse(result, 800, refresh, responseFormat);
      const formatted = formatCodeGraphMcpResponse(response, responseFormat);
      if (responseFormat === 'agent') {
        const structured = response.structuredContent as {
          readonly outsideProjectGraph?: unknown;
          readonly projectCoverage?: unknown;
        };
        expect(response.structuredContent.output).toMatchObject({truncated: false});
        expect(structured.projectCoverage).toMatchObject({configuredRootsOmitted: 48});
        expect(structured.outsideProjectGraph).toMatchObject({
          pathsOmitted: 48,
          suggestedActionsOmitted: 49,
        });
        expect(formatted.content[0].text).toContain('48 root(s) omitted');
        expect(formatted.content[0].text).not.toContain('metadata truncated');
      } else {
        expect(response.structuredContent.output).toMatchObject({metadataTruncated: true, truncated: true});
        expect(response.structuredContent.output).toMatchObject({
          metadataOmissions: {
            outsideProjectGraph: {paths: 50, suggestedActions: 50},
            projectCoverage: {configuredRoots: 50},
            refresh: true,
          },
        });
      }
      expect(
        measureAgentToolResponse({
          ...(formatted.structuredContent === undefined ? {} : {structuredContent: formatted.structuredContent}),
          text: formatted.content[0].text,
        }).totalBytes,
      ).toBeLessThanOrEqual(800 * 3);
    }
  });

  fcProp(
    it,
    'keeps pathological mandatory project metadata inside every accepted local format budget',
    {
      actions: FC.array(FC.string({maxLength: 1_000}), {maxLength: 24}),
      paths: FC.array(FC.string({maxLength: 1_000}), {maxLength: 24}),
      roots: FC.array(FC.string({maxLength: 1_000}), {maxLength: 24}),
    },
    ({actions, paths, roots}) => {
      const result = {
        ...verboseCodeGraphResult(),
        outsideProjectGraph: {paths, state: 'outside-project-graph' as const, suggestedActions: actions},
        projectCoverage: {
          completeness: 'partial' as const,
          configuredRoots: roots,
          dependencyComponents: 2,
          kind: 'project' as const,
          negativeProof: 'selected-graph-only' as const,
          observedWorktreeCommit: 'w'.repeat(2_000),
          project: 'project'.repeat(200),
          reusedEquivalentSnapshot: false,
          rootComponents: 3,
        },
      };
      for (const responseFormat of ['dual', 'text', 'agent'] as const) {
        const response = codeGraphMcpResponse(result, 800, undefined, responseFormat);
        const formatted = formatCodeGraphMcpResponse(response, responseFormat);
        expect(
          measureAgentToolResponse({
            ...(formatted.structuredContent === undefined ? {} : {structuredContent: formatted.structuredContent}),
            text: formatted.content[0].text,
          }).totalBytes,
        ).toBeLessThanOrEqual(800 * 3);
      }
    },
    {fastCheck: {numRuns: 30}},
  );

  fcProp(
    it,
    'keeps multibyte mandatory receipts within every accepted local format budget',
    {emojiCount: FC.integer({min: 1, max: 1_000})},
    ({emojiCount}) => {
      const result = mandatoryEmojiGraphResult('😀'.repeat(emojiCount));
      for (const responseFormat of ['dual', 'text', 'agent'] as const) {
        const response = codeGraphMcpResponse(result, 800, undefined, responseFormat);
        const formatted = formatCodeGraphMcpResponse(response, responseFormat);
        expect(
          measureAgentToolResponse({
            ...(formatted.structuredContent === undefined ? {} : {structuredContent: formatted.structuredContent}),
            text: formatted.content[0].text,
          }).totalBytes,
        ).toBeLessThanOrEqual(800 * 3);
      }
    },
    {fastCheck: {numRuns: 30}},
  );

  it('keeps agent relationship lines readable when endpoints or scalar values are irregular', () => {
    const result = verboseCodeGraphResult();
    const response = codeGraphMcpResponse(
      {
        ...result,
        operation: 'neighbors',
        edges: [
          {
            ...result.edges[0],
            evidencePath: 'src/界\tnewline\nfile\u001b\u2028.ts',
            sourceId: undefined,
            sourceName: 'source\t界\n',
            targetId: undefined,
            targetName: 'target\t界\n',
          },
        ],
        nodes: [],
      },
      800,
      undefined,
      'agent',
    );
    const text = formatCodeGraphMcpResponse(response, 'agent').content[0].text;
    const edge = text.split('\n').find(line => line.includes(' → '));
    expect(edge).toContain('source 界 → target 界:');
    expect(edge).toContain('src/界 newline file .ts');
    expect(edge).not.toContain('\t');
    expect(edge).not.toContain('\n');
    expect(edge).not.toContain('\u001b');
    expect(edge).not.toContain('\u2028');
  });

  fcProp(
    it,
    'preserves every projected graph fact when opting into text-only at supported budgets',
    {
      budgetTokens: FC.option(FC.integer({max: 1_500, min: 800}), {nil: undefined}),
      edgeCount: FC.integer({max: 20, min: 0}),
      nodeCount: FC.integer({max: 20, min: 0}),
      warningCount: FC.integer({max: 5, min: 0}),
    },
    ({budgetTokens, edgeCount, nodeCount, warningCount}) => {
      const verbose = verboseCodeGraphResult();
      const response = codeGraphMcpResponse(
        {
          ...verbose,
          edges: verbose.edges.slice(0, edgeCount),
          nodes: verbose.nodes.slice(0, nodeCount),
          warnings: verbose.warnings.slice(0, warningCount),
        },
        budgetTokens,
      );
      const dual = formatCodeGraphMcpResponse(response, 'dual');
      const text = formatCodeGraphMcpResponse(response, 'text');
      expect(JSON.parse(text.content[0].text)).toEqual(dual.structuredContent);
      expect(text).not.toHaveProperty('structuredContent');
      expect(measureAgentToolResponse({text: text.content[0].text}).totalBytes).toBeLessThanOrEqual(
        measureAgentToolResponse(response).totalBytes,
      );
    },
    {fastCheck: {numRuns: 60}},
  );

  fcProp(
    it,
    'keeps agent graph output deterministic and within each accepted explicit budget',
    {
      budgetTokens: FC.integer({max: 1_500, min: 800}),
      edgeCount: FC.integer({max: 20, min: 0}),
      nodeCount: FC.integer({max: 20, min: 0}),
      operation: FC.constantFrom('query' as const, 'impact' as const),
    },
    ({budgetTokens, edgeCount, nodeCount, operation}) => {
      const verbose = verboseCodeGraphResult();
      const result = {
        ...verbose,
        edges: verbose.edges.slice(0, edgeCount),
        nodes: verbose.nodes.slice(0, nodeCount),
        operation,
      };
      const before = JSON.stringify(result);
      const first = formatCodeGraphMcpResponse(codeGraphMcpResponse(result, budgetTokens, undefined, 'agent'), 'agent');
      const second = formatCodeGraphMcpResponse(
        codeGraphMcpResponse(result, budgetTokens, undefined, 'agent'),
        'agent',
      );
      expect(first).toEqual(second);
      expect(measureAgentToolResponse({text: first.content[0].text}).totalBytes).toBeLessThanOrEqual(budgetTokens * 3);
      expect(JSON.stringify(result)).toBe(before);
      if (operation === 'impact' || operation === 'query') {
        const projected = codeGraphMcpResponse(result, budgetTokens, undefined, 'agent').structuredContent;
        const visibleNodeIds = new Set(projected.nodes.map(node => node.id));
        for (const edge of projected.edges) {
          expect(edge.sourceId === undefined || visibleNodeIds.has(edge.sourceId)).toBe(true);
          expect(edge.targetId === undefined || visibleNodeIds.has(edge.targetId)).toBe(true);
        }
        if (operation === 'query') expect(projected.nodes.length).toBeLessThanOrEqual(Math.min(3, nodeCount));
      }
    },
    {fastCheck: {numRuns: 50}},
  );

  it('keeps bounded path-search coverage distinct from MCP output truncation', () => {
    const result: CodeGraphQueryResult = {
      ...verboseCodeGraphResult(),
      edges: [],
      nodes: [],
      operation: 'path',
      searchCoverage: {
        status: 'bounded',
        limitsReached: ['edge-limit'],
        visitedNodes: 8,
        inspectedEdges: 8,
        directEdgeChecked: true,
      },
      warnings: ['Path search was bounded by edge-limit.'],
    };
    const response = codeGraphMcpResponse(result, 1_500);
    expect(response.structuredContent).toMatchObject({searchCoverage: result.searchCoverage});
    expect(response.structuredContent.output.truncated).toBe(false);
  });

  it('keeps shared graph source fields after compact and a tight token budget', () => {
    const source = {
      deltaCount: 0,
      frontierCommit: 'a'.repeat(40),
      kind: 'shared-base-plus-local-overlay' as const,
      localCommit: 'b'.repeat(40),
      profileDigest: `sha256:${'c'.repeat(64)}`,
    };
    const result = {...verboseCodeGraphResult(), source};
    const compact = compactCodeGraphMcpResult(result);
    expect(compact.source).toEqual(source);
    const response = codeGraphMcpResponse(result, 800);
    expect(response.structuredContent).toMatchObject({source});
  });

  fcProp(
    it,
    'honors explicit local graph response budgets across result cardinalities',
    {
      budgetTokens: FC.integer({max: 1_500, min: 800}),
      edgeCount: FC.integer({max: 200, min: 0}),
      nodeCount: FC.integer({max: 100, min: 0}),
      warningCount: FC.integer({max: 20, min: 0}),
    },
    ({budgetTokens, edgeCount, nodeCount, warningCount}) => {
      const verbose = verboseCodeGraphResult();
      const result = {
        ...verbose,
        edges: verbose.edges.slice(0, edgeCount),
        nodes: verbose.nodes.slice(0, nodeCount),
        warnings: verbose.warnings.slice(0, warningCount),
      };
      const response = codeGraphMcpResponse(result, budgetTokens);
      const measurement = measureAgentToolResponse(response);

      expect(measurement.estimatedTokens).toBeLessThanOrEqual(budgetTokens);
      expect(measurement.totalBytes).toBeLessThanOrEqual(budgetTokens * 3);
      expect(response.structuredContent.output.returnedNodes).toBeLessThanOrEqual(nodeCount);
      expect(response.structuredContent.output.returnedEdges).toBeLessThanOrEqual(edgeCount);
    },
    {fastCheck: {numRuns: 100}},
  );

  it('keeps MCP timing and whole-graph analysis limits context-sized', () => {
    expect(
      compactCodeGraphMcpTiming({
        buildId: 'internal-build-id',
        elapsedMilliseconds: 123_456,
        estimateConfidence: 'medium',
        estimatedPhaseRemainingMilliseconds: 12_345.1,
        estimateScope: 'phase',
        lastProgressAgeMilliseconds: 12.1,
        phaseElapsedMilliseconds: 55_555.1,
        phaseStartedAtMilliseconds: 1,
        startedAtMilliseconds: 1,
        updatedAtMilliseconds: 2,
      }),
    ).toEqual({
      estimateConfidence: 'medium',
      estimatedPhaseRemainingMilliseconds: 12_346,
      estimateScope: 'phase',
      lastProgressAgeMilliseconds: 13,
      phaseElapsedMilliseconds: 55_556,
      type: 'code-graph-progress-timing',
      version: 1,
    });
    expect(codeGraphMcpAnalysisLimits('full', 5_000)).toMatchObject({
      communities: 12,
      communityMembers: 0,
      components: 12,
      confidenceFindings: 12,
      hubs: 12,
      relationshipGroupMembers: 8,
      relationshipGroups: 12,
      surprisingLinks: 12,
    });
    expect(codeGraphMcpAnalysisLimits('community', 5_000).communityMembers).toBe(5_000);
    expect(codeGraphMcpAnalysisBudget()).toEqual({
      maxDurationMilliseconds: 24_000,
      maxEdges: 500_000,
      maxEdgeVisits: 1_000_000,
      maxNodes: 100_000,
    });
  });

  effectIt.effect('marks a small stats projection complete when all stats evidence fits', () =>
    Effect.gen(function* () {
      const first = analysisSymbol('stats-first', '@acme/stats', 'src/stats.ts');
      const second = analysisSymbol('stats-second', '@acme/stats', 'src/stats.ts');
      const edges = [analysisEdge('stats-edge', first, second, 'contains')];
      const analysis = yield* analyzeCodeGraph(pagedAnalysisStore([first, second], edges), {
        databasePath: ':memory:',
        limits: codeGraphMcpAnalysisLimits('stats', 24),
        snapshot: analysisSnapshot([first, second], edges),
      });

      const response = codeGraphAnalysisMcpResponse(analysis, 'stats', {
        displayName: 'Fixture/stats',
        repositoryId: 'repository-id',
      });

      expect(response.structuredContent.output.structuredContent).toEqual({
        budgetBytes: 24 * 1_024,
        byteLength: expect.any(Number),
        complete: true,
        omitted: {},
        truncated: false,
        truncatedStrings: 0,
      });
      expect(response.structuredContent.output.text).toMatchObject({complete: true, truncated: false});
      expect(response.structuredContent.result).toMatchObject({
        communities: [],
        components: [],
        confidenceAudit: {findings: [], provenances: []},
        hubs: [],
        memberships: [],
        relationshipGroups: [],
        surprisingLinks: [],
      });
      expect(response.text).toContain('structured projection complete');
    }),
  );

  effectIt.effect('sanitizes repository controls in MCP analysis text and structured content', () =>
    Effect.gen(function* () {
      const repositoryText = 'danger\u001b\u009b\r\n\u202evalue';
      const source = analysisSymbol('mcp-control-source', repositoryText, 'src/control.ts', {
        name: repositoryText,
        qualifiedName: repositoryText,
      });
      const target = analysisSymbol('mcp-control-target', repositoryText, 'src/control.ts', {
        name: repositoryText,
        qualifiedName: repositoryText,
      });
      const edges = [
        analysisEdge('mcp-control-edge', source, target, 'calls', {
          confidence: 0.1,
          sourceName: repositoryText,
          targetName: repositoryText,
        }),
      ];
      const analysis = yield* analyzeCodeGraph(pagedAnalysisStore([source, target], edges), {
        databasePath: ':memory:',
        minimumHubDegree: 1,
        snapshot: analysisSnapshot([source, target], edges),
      });
      const response = codeGraphAnalysisMcpResponse(analysis, 'full', {
        displayName: repositoryText,
        repositoryId: 'repository-control',
      });

      expect(containsUnsafePresentationText(response.text, true)).toBe(false);
      expect(containsUnsafePresentationText(response.structuredContent, true)).toBe(false);
      expect(response.text).toContain('danger');
      expect(JSON.stringify(response.structuredContent)).toContain('danger');
    }),
  );

  effectIt.effect('excludes unrelated topology arrays before stats truncation and byte accounting', () =>
    Effect.gen(function* () {
      const first = analysisSymbol('scoped-first', '@acme/scoped', 'src/scoped.ts');
      const second = analysisSymbol('scoped-second', '@acme/scoped', 'src/scoped.ts');
      const symbols = [first, second];
      const edges = [analysisEdge('scoped-edge', first, second, 'contains')];
      const store = pagedAnalysisStore(symbols, edges);
      const snapshot = analysisSnapshot(symbols, edges);
      const [stats, topology] = yield* Effect.all(
        [
          analyzeCodeGraph(store, {
            databasePath: ':memory:',
            limits: codeGraphMcpAnalysisLimits('stats', 24),
            snapshot,
          }),
          analyzeCodeGraph(store, {databasePath: ':memory:', snapshot}),
        ],
        {concurrency: 2},
      );
      const community = topology.communities[0];
      const component = topology.components[0];
      const membership = topology.memberships[0];
      expect(community).toBeDefined();
      expect(component).toBeDefined();
      expect(membership).toBeDefined();
      if (!community || !component || !membership) throw TestError.make({message: 'Expected topology fixtures.'});
      const longRepositoryText = '界'.repeat(800);
      const noisyStats = {
        ...stats,
        communities: Array.from({length: 200}, (_, index) => ({
          ...community,
          label: `irrelevant-community-${index}-${longRepositoryText}`,
        })),
        components: Array.from({length: 200}, (_, index) => ({
          ...component,
          label: `irrelevant-component-${index}-${longRepositoryText}`,
        })),
        memberships: Array.from({length: 200}, (_, index) => ({
          ...membership,
          node: {
            ...membership.node,
            path: `src/irrelevant-${index}-${longRepositoryText}.ts`,
          },
        })),
      };
      const repository = {displayName: 'Fixture/scoped-stats', repositoryId: 'repository-id'};

      const clean = codeGraphAnalysisMcpResponse(stats, 'stats', repository);
      const noisy = codeGraphAnalysisMcpResponse(noisyStats, 'stats', repository);

      expect(noisy).toEqual(clean);
      expect(noisy.structuredContent.output.structuredContent).toMatchObject({
        complete: true,
        omitted: {},
        truncated: false,
        truncatedStrings: 0,
      });
      expect(new TextEncoder().encode(JSON.stringify(noisy.structuredContent)).byteLength).toBeLessThanOrEqual(
        24 * 1_024,
      );
    }),
  );

  effectIt.effect('independently bounds deterministic MCP analysis text and structured projections', () =>
    Effect.gen(function* () {
      const path = `src/${'深'.repeat(600)}.ts`;
      const symbols = Array.from({length: 180}, (_, index) =>
        analysisSymbol(`node-${index.toString().padStart(4, '0')}`, '@acme/large', path, {
          name: `node-${index}-${'🙂'.repeat(300)}`,
          qualifiedName: `Fixture.${'Namespace.'.repeat(100)}node${index}`,
        }),
      );
      const edges = symbols.slice(1).map((symbol, index) => analysisEdge(`edge-${index}`, symbols[index], symbol));
      const store = pagedAnalysisStore(symbols, edges);
      const snapshot = analysisSnapshot(symbols, edges);
      const communities = yield* analyzeCodeGraph(store, {
        databasePath: ':memory:',
        limits: codeGraphMcpAnalysisLimits('communities', 24),
        snapshot,
      });
      const communityId = communities.communities[0]?.id;
      expect(communityId).toMatch(/^cgc_[a-f0-9]{32}$/);
      if (!communityId) throw TestError.make({message: 'Expected one deterministic fixture community.'});
      const analysis = yield* analyzeCodeGraph(store, {
        communityId,
        databasePath: ':memory:',
        limits: codeGraphMcpAnalysisLimits('community', 5_000),
        snapshot,
      });
      const verbose = {
        ...analysis,
        warnings: Array.from({length: 5_000}, () => ''),
      };
      const metadata = {
        freshnessPolicy: 'allow-stale' as const,
        freshness: 'stale' as const,
        snapshot: {id: snapshot.id, commit: snapshot.commit, dirty: snapshot.dirty},
      };
      const first = codeGraphAnalysisMcpResponse(
        verbose,
        'community',
        {
          displayName: `Fixture/${'界'.repeat(2_000)}`,
          repositoryId: 'repository-id',
        },
        metadata,
      );
      const second = codeGraphAnalysisMcpResponse(
        verbose,
        'community',
        {
          displayName: `Fixture/${'界'.repeat(2_000)}`,
          repositoryId: 'repository-id',
        },
        metadata,
      );
      expect(first.text.startsWith('Graph analysis:')).toBe(true);
      expect(first.text).not.toContain('Read:');
      expect(first.text).not.toContain(JSON.stringify(metadata));
      const structuredBytes = new TextEncoder().encode(JSON.stringify(first.structuredContent)).byteLength;
      const textBytes = new TextEncoder().encode(first.text).byteLength;

      expect(first).toEqual(second);
      expect(structuredBytes).toBeLessThanOrEqual(24 * 1_024);
      expect(textBytes).toBeLessThanOrEqual(24 * 1_024);
      expect(first.structuredContent).toMatchObject({
        output: {
          analysisCoverage: {topology: analysis.coverage.topology.state},
          structuredContent: {
            budgetBytes: 24 * 1_024,
            byteLength: structuredBytes,
            complete: false,
            omitted: {
              communityMembers: expect.any(Number),
            },
            truncated: true,
            truncatedStrings: expect.any(Number),
          },
          text: {
            budgetBytes: 24 * 1_024,
            byteLength: textBytes,
            complete: false,
            truncated: true,
          },
        },
        sourceVersion: analysis.version,
        type: 'code-graph-analysis',
        version: 1,
      });
      expect(first.text).toContain('MCP text output coverage: truncated');
      expect(first.structuredContent.result.coverage).toEqual(analysis.coverage);
    }),
  );

  effectIt.effect(
    'returns explicitly partial MCP topology above the retained-node cap without changing the analysis defaults',
    () =>
      Effect.gen(function* () {
        const symbols = [analysisSymbol('one', '@acme/capped', 'src/one.ts')];
        const snapshot = {...analysisSnapshot(symbols, []), symbolCount: codeGraphMcpAnalysisBudget().maxNodes! + 1};
        const result = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, []), {
          budget: codeGraphMcpAnalysisBudget(),
          databasePath: ':memory:',
          limits: codeGraphMcpAnalysisLimits('hubs', 24),
          snapshot,
        });

        expect(result.budget).toMatchObject(codeGraphMcpAnalysisBudget());
        expect(result.coverage).toMatchObject({nodesComplete: false, topology: {complete: false, state: 'partial'}});
        expect(result.warnings).toContain(
          `Topology is a bounded path-prefix induced subgraph over 1 of ${snapshot.symbolCount.toLocaleString()} symbols. Connectivity, degree, isolation, hub, component, community, and absence claims apply only to retained nodes.`,
        );
      }),
  );

  fcProp(
    it,
    'never exceeds MCP context budgets across result cardinalities',
    {
      displayNameLength: FC.integer({max: 32_000, min: 0}),
      edgeCount: FC.integer({max: 200, min: 0}),
      nodeCount: FC.integer({max: 100, min: 0}),
    },
    ({displayNameLength, edgeCount, nodeCount}) => {
      const verbose = verboseCodeGraphResult();
      const result = {
        ...verbose,
        edges: verbose.edges.slice(0, edgeCount),
        nodes: verbose.nodes.slice(0, nodeCount),
        repository: {...verbose.repository, displayName: 'r'.repeat(displayNameLength)},
      };
      const response = codeGraphMcpResponse(result);
      const compact = response.structuredContent;

      expect(new TextEncoder().encode(JSON.stringify(compact)).byteLength).toBeLessThanOrEqual(24 * 1_024);
      expect(new TextEncoder().encode(response.text).byteLength).toBeLessThan(20 * 1_024);
      expect(compact.repository.displayName.length).toBeLessThanOrEqual(320);
      expect(compact).toMatchObject({sourceVersion: 1, type: 'code-graph-inspection', version: 1});
      expect(compact.output.returnedNodes).toBeLessThanOrEqual(nodeCount);
      expect(compact.output.returnedEdges).toBeLessThanOrEqual(edgeCount);
      expect(compact.output.truncated).toBe(
        compact.output.returnedNodes < nodeCount ||
          compact.output.returnedEdges < edgeCount ||
          verbose.warnings.length > 5,
      );
    },
    {fastCheck: {numRuns: 50}},
  );
});

function indexingStatus(
  estimatedPhaseRemainingMilliseconds: number,
): Extract<CodeGraphRefreshStatus, {readonly state: 'indexing'}> {
  return {
    state: 'indexing',
    timing: {
      buildId: 'test-build',
      elapsedMilliseconds: 2_000,
      estimateConfidence: 'medium',
      estimatedPhaseRemainingMilliseconds,
      estimateScope: 'phase',
      lastProgressAgeMilliseconds: 0,
      phaseElapsedMilliseconds: 2_000,
      phaseStartedAtMilliseconds: 0,
      startedAtMilliseconds: 0,
      updatedAtMilliseconds: 2_000,
    },
  };
}

function deferredStatus(code: 'busy' | 'no-space' | 'permission' | 'transient-io'): CodeGraphRefreshStatus {
  const metadata = {
    busy: {recovery: 'defer' as const, retryable: true},
    'no-space': {recovery: 'free-space' as const, retryable: false},
    permission: {recovery: 'fix-permissions' as const, retryable: false},
    'transient-io': {recovery: 'retry-read-only' as const, retryable: true},
  }[code];
  return {
    failure: {code, operation: 'refresh code graph', ...metadata},
    state: 'deferred',
  };
}

function verboseCodeGraphResult(): CodeGraphQueryResult {
  const span = {column: 1, endColumn: 2, endLine: 1, line: 1};
  return {
    edges: Array.from({length: 200}, (_, index) => ({
      confidence: 1,
      evidencePath: `src/${'deep/'.repeat(100)}edge-${index}.ts`,
      evidenceSpan: span,
      id: `cge_${String(index).padStart(4, '0')}`,
      provenance: 'resolved' as const,
      relation: 'calls' as const,
      sourceId: `cgs_${String(index).padStart(4, '0')}`,
      sourceName: `source-${index}-${'x'.repeat(300)}`,
      targetId: `cgs_${String(index + 1).padStart(4, '0')}`,
      targetName: `target-${index}-${'y'.repeat(300)}`,
    })),
    freshness: 'current',
    nodes: Array.from({length: 100}, (_, index) => ({
      contentHash: 'a'.repeat(64),
      documentation: 'private parser detail '.repeat(200),
      exported: true,
      id: `cgs_${String(index).padStart(4, '0')}`,
      kind: 'function',
      language: 'typescript',
      lookupKeys: Array.from({length: 30}, (_, key) => `typescript:lookup:${index}:${key}`),
      name: `symbol-${index}-${'n'.repeat(300)}`,
      path: `src/${'nested/'.repeat(100)}symbol-${index}.ts`,
      qualifiedName: `Fixture.${'Namespace.'.repeat(50)}symbol${index}`,
      resolutionDomain: 'typescript',
      resolutionScopeId: 'scope-internal',
      score: 1,
      signature: `function symbol${index}(${`argument${index}: string, `.repeat(100)}): string`,
      span,
    })),
    operation: 'query',
    repository: {displayName: 'Fixture/repository', repositoryId: 'repository-id'},
    snapshot: {commit: 'a'.repeat(40), dirty: false, id: 'snapshot-id', worktreeId: 'worktree-id'},
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    version: 1,
    warnings: Array.from({length: 20}, (_, index) => `warning ${index} ${'w'.repeat(500)}`),
  };
}

function mandatoryEmojiGraphResult(value: string): CodeGraphQueryResult {
  const result = verboseCodeGraphResult();
  return {
    ...result,
    edges: [],
    nodes: [],
    outsideProjectGraph: {
      paths: Array.from({length: 50}, () => value),
      state: 'outside-project-graph',
      suggestedActions: Array.from({length: 50}, () => value),
    },
    projectCoverage: {
      completeness: 'partial',
      configuredRoots: Array.from({length: 50}, () => value),
      dependencyComponents: 1,
      kind: 'project',
      negativeProof: 'selected-graph-only',
      observedWorktreeCommit: value,
      project: value,
      reusedEquivalentSnapshot: false,
      rootComponents: 1,
      snapshotSourceCommit: value,
    },
    repository: {displayName: value, repositoryId: value},
    outsideScopeChangedPaths: 50,
    searchCoverage: {
      directEdgeChecked: true,
      inspectedEdges: 50,
      limitsReached: ['depth', 'edge-limit', 'node-limit', 'time-budget'],
      status: 'bounded',
      visitedNodes: 50,
    },
    scope: {
      evidence: 'bounded-lexical-observation',
      lexicalCandidatesExamined: 1,
      lexicalMatches: 1,
      packageName: value,
      type: 'package',
    },
    snapshot: {commit: value, dirty: false, id: value, worktreeId: value},
    source: {
      deltaCount: 1,
      frontierCommit: value,
      kind: 'shared-base-plus-local-overlay',
      localCommit: value,
      profileDigest: value,
    },
    warnings: [],
  };
}

function containsUnsafePresentationText(value: unknown, allowLineFeed = false): boolean {
  if (typeof value === 'string') {
    return Array.from(value).some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        !(allowLineFeed && codePoint === 0x0a) &&
        (codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          (codePoint >= 0x202a && codePoint <= 0x202e) ||
          (codePoint >= 0x2066 && codePoint <= 0x2069))
      );
    });
  }
  if (Array.isArray(value)) return value.some(item => containsUnsafePresentationText(item, allowLineFeed));
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some(item => containsUnsafePresentationText(item, allowLineFeed));
}
