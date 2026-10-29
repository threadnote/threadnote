import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, Layer} from 'effect';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {CodeGraphAnalysis, analyzeCodeGraph} from '@threadnote/graph/analysis';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '@threadnote/graph/indexer';
import {serveCodeGraphAnalysisRead} from '@threadnote/graph/isolated/analysis';
import {CodeGraphQueryService, type CodeGraphStatusOptions} from '@threadnote/graph/query';
import {CodeGraphDiskCapacityPressureError, type CodeGraphStatus} from '@threadnote/graph/types';
import {analysisSnapshot, pagedAnalysisStore} from '@threadnote/graph/test/helpers/code-graph-analysis';

const snapshot = analysisSnapshot([], []);
const status: CodeGraphStatus = {
  databasePath: '/fixture/graph.sqlite',
  freshness: 'current',
  stale: false,
  readySnapshot: snapshot,
  languagePacks: [],
  identity: {
    caseMode: 'sensitive',
    checkoutId: 'checkout',
    displayName: 'fixture',
    gitCommonDirectory: '/fixture/.git',
    headCommit: snapshot.commit,
    objectFormat: 'sha1',
    repoRoot: '/fixture',
    repositoryId: snapshot.repositoryId,
    worktreeId: snapshot.worktreeId,
  },
};
const project = {
  name: 'web',
  uri: 'threadnote://projects/web',
  graph: {roots: ['apps/web'], closure: 'dependencies' as const},
};

function harness(input: {ready: boolean; stale: boolean; failRefresh?: boolean; changesDuringAnalysis?: boolean}) {
  let selected = {
    ...status,
    readySnapshot: input.ready ? snapshot : undefined,
    stale: input.stale,
    freshness: input.stale ? ('stale' as const) : ('current' as const),
  };
  const calls = {analysis: 0, attaches: 0, refreshes: 0, status: 0};
  const query = CodeGraphQueryService.of({
    status: (_home, _cwd, options?: CodeGraphStatusOptions) =>
      Effect.gen(function* () {
        calls.status += 1;
        if (options?.afterIdentityObserved) yield* options.afterIdentityObserved(status.identity, project);
        return selected;
      }),
    attachSharedReadySnapshot: () =>
      Effect.sync(() => {
        calls.attaches += 1;
        return selected;
      }),
    inspect: () => Effect.die('unused'),
    purge: () => Effect.die('unused'),
    statusForIdentity: () => Effect.die('unused'),
    statusForPublishedIdentity: () => Effect.die('unused'),
  });
  const indexer = {
    index: (options: Parameters<CodeGraphIndexerShape['index']>[0]) =>
      Effect.gen(function* () {
        calls.refreshes += 1;
        expect(options.project).toEqual(project);
        if (input.failRefresh) return yield* CodeGraphDiskCapacityPressureError.of('reserve graph write');
        selected = {...selected, readySnapshot: snapshot, freshness: 'current', stale: false};
        return {
          diagnostics: [],
          durationMs: 0,
          identity: status.identity,
          reusedFiles: 0,
          skippedFiles: 0,
          snapshot,
        };
      }),
  };
  const analysis = CodeGraphAnalysis.of({
    analyze: options =>
      Effect.gen(function* () {
        calls.analysis += 1;
        if (input.changesDuringAnalysis) selected = {...selected, freshness: 'stale', stale: true};
        return yield* analyzeCodeGraph(pagedAnalysisStore([], []), options);
      }),
  });
  return {
    calls,
    layer: Layer.mergeAll(
      Layer.succeed(CodeGraphQueryService, query),
      Layer.succeed(CodeGraphAnalysis, analysis),
      Layer.mock(CodeGraphIndexer, {index: indexer.index}),
    ),
  };
}

const request = {
  cwd: '/fixture/apps/web',
  threadnoteHome: '/home',
  manifestPath: '/manifest',
  operation: 'stats' as const,
  deadlineMilliseconds: 25000,
  refresh: true,
};

describe('CLI analysis uses the same isolated selection contract as MCP', () => {
  fcEffectProp(
    effectIt,
    'refreshes exactly when policy requires it and never upgrades accepted stale evidence',
    {
      freshness: fc.constantFrom('current' as const, 'ready' as const, 'allow-stale' as const),
      ready: fc.boolean(),
      stale: fc.boolean(),
    },
    ({freshness, ready, stale}) => {
      const test = harness({ready, stale});
      return Effect.gen(function* () {
        const result = yield* serveCodeGraphAnalysisRead({...request, freshness});
        const shouldRefresh = freshness !== 'allow-stale' && (!ready || (freshness === 'current' && stale));
        expect(test.calls.refreshes).toBe(Number(shouldRefresh));
        expect(test.calls.analysis).toBe(Number(ready || shouldRefresh));
        if (result.state === 'ready')
          expect(result.status.freshness).toBe(shouldRefresh ? 'current' : stale ? 'stale' : 'current');
        if (freshness === 'allow-stale') expect(test.calls.attaches).toBe(0);
      }).pipe(provideTestLayer(test.layer));
    },
    {fastCheck: {numRuns: 30}},
  );

  effectIt.effect('returns a typed refresh failure immediately instead of exhausting the deadline', () => {
    const test = harness({ready: false, stale: true, failRefresh: true});
    return Effect.gen(function* () {
      const result = yield* serveCodeGraphAnalysisRead({...request, freshness: 'ready'});
      expect(result).toMatchObject({
        state: 'failed',
        failure: {code: 'no-space', recovery: 'free-space', retryable: false},
      });
      expect(test.calls.analysis).toBe(0);
      expect(yield* Clock.currentTimeMillis).toBe(0);
    }).pipe(provideTestLayer(test.layer));
  });

  effectIt.effect('rejects a current result if the worktree changes during analysis', () => {
    const test = harness({ready: true, stale: false, changesDuringAnalysis: true});
    return Effect.gen(function* () {
      const result = yield* serveCodeGraphAnalysisRead({...request, freshness: 'current'});
      expect(result).toMatchObject({
        state: 'unavailable',
        reason: 'current-snapshot-unavailable',
        status: {freshness: 'stale'},
      });
      expect(test.calls.status).toBe(2);
    }).pipe(provideTestLayer(test.layer));
  });
});
