import {systemRuntimeBoundaries} from '../helpers/system-runtime-boundaries.js';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {succeedUndefined} from '@threadnote/platform/optional';
import {CodeGraphQueryService, type CodeGraphInspectOptions} from '@threadnote/graph/query';
import {codeGraphQueryScopeReceipt, type CodeGraphQueryScope} from '@threadnote/graph/query/scope';
import {decodeImpactQueryRequest, IsolatedCodeGraphImpactQueryError} from '@threadnote/graph/isolated/impact_query';
import type {CodeGraphQueryResult, RepositoryIdentity} from '@threadnote/graph/types';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import type {CommandResult} from '@threadnote/platform/command';
import {
  withIsolatedContextBriefGraphReads,
  CONTEXT_BRIEF_GRAPH_ISOLATED_READ_TIMEOUT_MILLISECONDS,
} from '@threadnote/context/graph/isolated_inspect';

const REPOSITORY_ID = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const SNAPSHOT_ID = `cgsn_${'c'.repeat(40)}`;
const WORKTREE_ID = 'd'.repeat(64);

const projectScope: CodeGraphQueryScope = {
  project: {
    graph: {closure: 'dependencies', include: [], roots: ['apps/web']},
    name: 'web',
    uri: 'threadnote://projects/web',
  },
  scope: {
    admittedPrefixes: ['apps/web'],
    closureDigest: 'closure-digest',
    completeness: 'partial',
    controlPaths: [],
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
    observedCommit: COMMIT,
    policyFingerprint: 'policy-fingerprint',
    repositoryId: REPOSITORY_ID,
    scopeKey: 'code-graph-scope:web',
    worktreeId: WORKTREE_ID,
  },
};

const identity: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId: 'checkout-id',
  displayName: 'acme/repository',
  gitCommonDirectory: '/workspace/repository/.git',
  headCommit: COMMIT,
  objectFormat: 'sha1',
  repoRoot: '/workspace/repository',
  repositoryId: REPOSITORY_ID,
  worktreeId: WORKTREE_ID,
};

const observation = {
  borrowedSnapshotId: SNAPSHOT_ID,
  identity,
  overlay: {dirty: false},
  projectScope,
} as const;

function queryResult(operation: CodeGraphQueryResult['operation']): CodeGraphQueryResult {
  return {
    edges: [],
    freshness: 'current',
    nodes: [],
    operation,
    repository: {displayName: 'acme/repository', repositoryId: REPOSITORY_ID},
    snapshot: {commit: COMMIT, dirty: false, id: SNAPSHOT_ID, worktreeId: WORKTREE_ID},
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    version: 1,
    warnings: [],
  };
}

function baseService(
  inspect: (options: CodeGraphInspectOptions) => Effect.Effect<CodeGraphQueryResult, unknown>,
): Parameters<typeof CodeGraphQueryService.of>[0] {
  return CodeGraphQueryService.of({
    attachSharedReadySnapshot: () => Effect.die('Unexpected shared attach.'),
    inspect,
    purge: () => Effect.die('Unexpected graph purge.'),
    status: () => Effect.die('Unexpected graph status.'),
    statusForIdentity: () => Effect.die('Unexpected identity status.'),
    statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
  });
}

function workerCommand(canned: CodeGraphQueryResult, seen: {input?: Uint8Array}) {
  return CommandExecutor.of({
    execute: (_executable, _arguments, options) =>
      Effect.sync(() => {
        seen.input = options?.input;
        return commandResult(JSON.stringify({ok: true, protocol: 1, result: canned}));
      }),
    executeStreaming: () => Effect.die('unused'),
  });
}

function isolatedService(
  inspect: (options: CodeGraphInspectOptions) => Effect.Effect<CodeGraphQueryResult, unknown>,
  canned: CodeGraphQueryResult,
  seen: {input?: Uint8Array},
) {
  return withIsolatedContextBriefGraphReads(baseService(inspect)).pipe(
    Effect.provideService(CommandExecutor, workerCommand(canned, seen)),
    Effect.provideService(SystemInfo, systemInfoStub()),
  );
}

describe('context brief isolated graph reads', () => {
  effectIt.effect('reads scoped neighbors in the worker and keeps the partial-scope signal', () =>
    Effect.gen(function* () {
      const seen: {input?: Uint8Array} = {};
      const service = yield* isolatedService(
        () => Effect.die('Scoped reads must stay off the MCP thread.'),
        queryResult('neighbors'),
        seen,
      );

      const actual = yield* service.inspect({
        cwd: '/workspace/repository',
        edgeLimit: 40,
        nodeId: `cgs_${'e'.repeat(32)}`,
        nodeLimit: 20,
        operation: 'neighbors',
        project: 'web',
        refresh: false,
        requestMaintenance: false,
        statusObservation: observation,
        strictFreshness: false,
        threadnoteHome: '/threadnote-home',
      });

      expect(seen.input).toBeDefined();
      const request = decodeImpactQueryRequest(new TextDecoder().decode(seen.input));
      expect(request).toMatchObject({
        borrowedSnapshotId: SNAPSHOT_ID,
        nodeId: `cgs_${'e'.repeat(32)}`,
        operation: 'neighbors',
        overlay: {dirty: false},
        project: 'web',
        projectScopeReceipt: codeGraphQueryScopeReceipt(projectScope),
        strictFreshness: false,
      });
      expect(actual.nodes).toEqual([]);
      expect(actual.projectCoverage).toMatchObject({
        completeness: 'partial',
        negativeProof: 'unavailable',
        project: 'web',
      });
      expect(actual.warnings.join('\n')).toContain('Results cover the selected project graph (web)');
    }),
  );

  effectIt.effect('pins the parent local ready snapshot and clean overlay in the worker', () =>
    Effect.gen(function* () {
      const seen: {input?: Uint8Array} = {};
      const service = yield* isolatedService(
        () => Effect.die('Local ready reads must stay off the MCP thread.'),
        queryResult('query'),
        seen,
      );

      yield* service.inspect({
        cwd: '/workspace/repository',
        edgeLimit: 40,
        nodeLimit: 20,
        operation: 'query',
        query: 'native union',
        refresh: false,
        requestMaintenance: false,
        statusObservation: {identity, overlay: {dirty: false}, readySnapshotId: SNAPSHOT_ID},
        strictFreshness: false,
        threadnoteHome: '/threadnote-home',
      });

      const request = decodeImpactQueryRequest(new TextDecoder().decode(seen.input));
      expect(request).toMatchObject({
        operation: 'query',
        overlay: {dirty: false},
        query: 'native union',
        readySnapshotId: SNAPSHOT_ID,
        strictFreshness: false,
      });
    }),
  );

  effectIt.effect('keeps in-scope impact seeds and reports no outside-scope drift', () =>
    Effect.gen(function* () {
      const seen: {input?: Uint8Array} = {};
      const service = yield* isolatedService(
        () => Effect.die('Scoped reads must stay off the MCP thread.'),
        queryResult('impact'),
        seen,
      );

      const actual = yield* service.inspect({
        cwd: '/workspace/repository',
        depth: 0,
        direction: 'incoming',
        edgeLimit: 1,
        nodeLimit: 20,
        operation: 'impact',
        project: 'web',
        query: 'apps/web/a.ts',
        refresh: false,
        requestMaintenance: false,
        seedQueries: ['apps/web/a.ts'],
        seedQueryCount: 1,
        statusObservation: observation,
        strictFreshness: false,
        threadnoteHome: '/threadnote-home',
      });

      const request = decodeImpactQueryRequest(new TextDecoder().decode(seen.input));
      expect(request?.seedQueries).toEqual(['apps/web/a.ts']);
      expect(actual.nodes).toEqual([]);
      expect(actual).toMatchObject({outsideScopeChangedPaths: 0});
      expect(actual.projectCoverage?.project).toBe('web');
    }),
  );

  effectIt.effect('drops out-of-scope impact seeds instead of reading outside the project graph', () =>
    Effect.gen(function* () {
      const seen: {input?: Uint8Array} = {};
      const canned: CodeGraphQueryResult = {
        ...queryResult('impact'),
        nodes: [
          {
            arity: 0,
            contentHash: 'h'.repeat(64),
            exported: false,
            id: `cgs_${'f'.repeat(32)}`,
            kind: 'function',
            language: 'typescript',
            name: 'elsewhere',
            path: 'other/a.ts',
            qualifiedName: 'elsewhere',
            score: 0.5,
            span: {column: 1, endColumn: 2, endLine: 3, line: 1},
          },
        ],
      };
      const service = yield* isolatedService(
        () => Effect.die('Scoped reads must stay off the MCP thread.'),
        canned,
        seen,
      );

      const actual = yield* service.inspect({
        cwd: '/workspace/repository',
        depth: 0,
        direction: 'incoming',
        edgeLimit: 1,
        nodeLimit: 20,
        operation: 'impact',
        project: 'web',
        query: 'other/a.ts',
        refresh: false,
        requestMaintenance: false,
        seedQueries: ['other/a.ts'],
        seedQueryCount: 1,
        statusObservation: observation,
        strictFreshness: false,
        threadnoteHome: '/threadnote-home',
      });

      expect(actual.nodes).toEqual([]);
      expect(actual.edges).toEqual([]);
      expect(actual.outsideProjectGraph).toMatchObject({paths: ['other/a.ts']});
      expect(actual).toMatchObject({outsideScopeChangedPaths: 1});
    }),
  );

  effectIt.effect('leaves unscoped reads untouched without inventing coverage', () =>
    Effect.gen(function* () {
      const seen: {input?: Uint8Array} = {};
      const canned = queryResult('query');
      const service = yield* isolatedService(() => Effect.die('Reads must stay off the MCP thread.'), canned, seen);

      const actual = yield* service.inspect({
        cwd: '/workspace/repository',
        edgeLimit: 40,
        nodeLimit: 20,
        operation: 'query',
        query: 'table',
        refresh: false,
        requestMaintenance: false,
        statusObservation: {identity},
        strictFreshness: false,
        threadnoteHome: '/threadnote-home',
      });

      const request = decodeImpactQueryRequest(new TextDecoder().decode(seen.input));
      expect(request).toMatchObject({operation: 'query', query: 'table', strictFreshness: false});
      expect(request?.projectScopeReceipt).toBeUndefined();
      expect(actual).toEqual(canned);
    }),
  );

  effectIt.effect('surfaces worker failures instead of masking them as empty evidence', () =>
    Effect.gen(function* () {
      const command = CommandExecutor.of({
        execute: () => Effect.succeed(commandResult(JSON.stringify({ok: false, protocol: 1, telemetry: []}))),
        executeStreaming: () => Effect.die('unused'),
      });
      const service = yield* withIsolatedContextBriefGraphReads(
        baseService(() => Effect.die('Reads must stay off the MCP thread.')),
      ).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, systemInfoStub()));

      const failure = yield* service
        .inspect({
          cwd: '/workspace/repository',
          edgeLimit: 40,
          nodeLimit: 20,
          operation: 'query',
          query: 'table',
          refresh: false,
          requestMaintenance: false,
          statusObservation: {identity},
          strictFreshness: false,
          threadnoteHome: '/threadnote-home',
        })
        .pipe(Effect.flip);

      expect(failure).toBeInstanceOf(IsolatedCodeGraphImpactQueryError);
    }),
  );

  effectIt.effect('keeps strict reads on the in-process path', () =>
    Effect.gen(function* () {
      const seen: {input?: Uint8Array} = {};
      const fallback = queryResult('impact');
      const service = yield* isolatedService(() => Effect.succeed(fallback), queryResult('impact'), seen);

      const actual = yield* service.inspect({
        cwd: '/workspace/repository',
        edgeLimit: 1,
        nodeLimit: 20,
        operation: 'impact',
        query: 'apps/web/a.ts',
        refresh: false,
        requestMaintenance: false,
        statusObservation: observation,
        strictFreshness: true,
        threadnoteHome: '/threadnote-home',
      });

      expect(seen.input).toBeUndefined();
      expect(actual).toEqual(fallback);
    }),
  );

  effectIt.effect('keeps refreshable and maintenance reads on the in-process path', () =>
    Effect.gen(function* () {
      const seen: {input?: Uint8Array} = {};
      const fallback = queryResult('query');
      const refreshing = yield* isolatedService(() => Effect.succeed(fallback), queryResult('query'), seen);

      const refreshed = yield* refreshing.inspect({
        cwd: '/workspace/repository',
        edgeLimit: 40,
        nodeLimit: 20,
        operation: 'query',
        query: 'table',
        refresh: true,
        requestMaintenance: false,
        strictFreshness: false,
        threadnoteHome: '/threadnote-home',
      });
      expect(seen.input).toBeUndefined();
      expect(refreshed).toEqual(fallback);

      const maintaining = yield* isolatedService(() => Effect.succeed(fallback), queryResult('query'), seen);
      const maintained = yield* maintaining.inspect({
        cwd: '/workspace/repository',
        edgeLimit: 40,
        nodeLimit: 20,
        operation: 'query',
        query: 'table',
        refresh: false,
        strictFreshness: false,
        threadnoteHome: '/threadnote-home',
      });
      expect(seen.input).toBeUndefined();
      expect(maintained).toEqual(fallback);
    }),
  );

  effectIt.effect('keeps interlocked and progress reads on the in-process path', () =>
    Effect.gen(function* () {
      const seen: {input?: Uint8Array} = {};
      const fallback = queryResult('neighbors');
      const interlocked = yield* isolatedService(() => Effect.succeed(fallback), queryResult('neighbors'), seen);

      const locked = yield* interlocked.inspect({
        cwd: '/workspace/repository',
        edgeLimit: 40,
        interlock: {},
        nodeId: `cgs_${'e'.repeat(32)}`,
        nodeLimit: 20,
        operation: 'neighbors',
        refresh: false,
        requestMaintenance: false,
        strictFreshness: false,
        threadnoteHome: '/threadnote-home',
      });
      expect(seen.input).toBeUndefined();
      expect(locked).toEqual(fallback);

      const progressive = yield* isolatedService(() => Effect.succeed(fallback), queryResult('neighbors'), seen);
      const progressed = yield* progressive.inspect({
        cwd: '/workspace/repository',
        edgeLimit: 40,
        nodeId: `cgs_${'e'.repeat(32)}`,
        nodeLimit: 20,
        onProgress: () => Effect.void,
        operation: 'neighbors',
        refresh: false,
        requestMaintenance: false,
        strictFreshness: false,
        threadnoteHome: '/threadnote-home',
      });
      expect(seen.input).toBeUndefined();
      expect(progressed).toEqual(fallback);
    }),
  );

  it('bounds each isolated brief read well inside the MCP query budget', () => {
    expect(CONTEXT_BRIEF_GRAPH_ISOLATED_READ_TIMEOUT_MILLISECONDS).toBeLessThanOrEqual(50_000);
    expect(CONTEXT_BRIEF_GRAPH_ISOLATED_READ_TIMEOUT_MILLISECONDS).toBeGreaterThan(0);
  });
});

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
