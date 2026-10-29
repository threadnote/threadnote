import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {discloseCodeGraphProjectCoverage, outsideCodeGraphProjectPaths} from '@threadnote/graph/query/scope';
import type {ResolvedCodeGraphIndexScope} from '@threadnote/graph/index_scope';
import type {CodeGraphProjectCoverage, CodeGraphQueryResult} from '@threadnote/graph/types';
import {compactCodeGraphMcpResult} from '@threadnote/threadnote/mcp/code_graph_projection';
import {codeGraphIndexScopeMembershipDigest} from '@threadnote/graph/index_scope';
import {
  presentCodeGraphScopedReadyRead,
  selectCodeGraphReadyReadChangedPaths,
} from '@threadnote/threadnote/mcp/server/code_graph/ready_read';
import type {CodeGraphQueryScope} from '@threadnote/graph/query/scope';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const scope: ResolvedCodeGraphIndexScope = {
  admittedPrefixes: ['apps/a', 'shared/core'],
  controlPaths: ['package.json'],
  closureDigest: Effect.pipe('a', EffectString.repeat(64)),
  definitionDigest: Effect.pipe('b', EffectString.repeat(64)),
  completeness: 'partial',
  diagnostics: [],
  includedProjectIds: ['a', 'core'],
  rootProjectIds: ['a'],
  scopeKey: `code-graph-scope:${Effect.pipe('c', EffectString.repeat(64))}`,
};
const coverage: CodeGraphProjectCoverage = {
  project: 'app-a',
  kind: 'project',
  configuredRoots: ['apps/a'],
  rootComponents: 1,
  dependencyComponents: 1,
  completeness: 'partial',
  negativeProof: 'unavailable',
  observedWorktreeCommit: Effect.pipe('d', EffectString.repeat(40)),
  reusedEquivalentSnapshot: false,
};
const result: CodeGraphQueryResult = {
  version: 1,
  edges: [],
  nodes: [],
  freshness: 'current',
  operation: 'path',
  repository: {displayName: 'fixture', repositoryId: Effect.pipe('e', EffectString.repeat(64))},
  snapshot: {
    commit: Effect.pipe('d', EffectString.repeat(40)),
    dirty: false,
    id: 'snapshot',
    worktreeId: Effect.pipe('f', EffectString.repeat(64)),
  },
  searchCoverage: {
    status: 'exhaustive',
    limitsReached: [],
    visitedNodes: 2,
    inspectedEdges: 1,
    directEdgeChecked: true,
  },
  trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
  warnings: [],
};
const identity: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId: 'checkout',
  displayName: 'fixture',
  gitCommonDirectory: '/repo/.git',
  headCommit: Effect.pipe('f', EffectString.repeat(40)),
  objectFormat: 'sha1',
  repoRoot: '/repo',
  repositoryId: result.repository.repositoryId,
  worktreeId: result.snapshot.worktreeId,
};
const projectScope: CodeGraphQueryScope = {
  project: {graph: {closure: 'dependencies', roots: ['apps/a']}, name: 'app-a', uri: 'threadnote://projects/app-a'},
  scope,
  evidence: {
    catalogFingerprint: 'catalog',
    closureDigest: scope.closureDigest,
    definitionDigest: scope.definitionDigest,
    extractorSet: 'extractors',
    inventoryFingerprint: 'inventory',
    observedCommit: identity.headCommit,
    policyFingerprint: 'policy',
    repositoryId: identity.repositoryId,
    scopeKey: scope.scopeKey,
    worktreeId: identity.worktreeId,
  },
};

describe('project graph retrieval coverage', () => {
  it('treats project membership as an order-independent set identity', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({minLength: 1, maxLength: 24}), {maxLength: 40}),
        fc.uniqueArray(fc.string({minLength: 1, maxLength: 24}), {maxLength: 8}),
        (includedProjectIds, rootProjectIds) => {
          const expected = codeGraphIndexScopeMembershipDigest({
            completeness: 'complete',
            includedProjectIds,
            rootProjectIds,
          });
          expect(
            codeGraphIndexScopeMembershipDigest({
              completeness: 'complete',
              includedProjectIds: [...includedProjectIds].reverse(),
              rootProjectIds: [...rootProjectIds].reverse(),
            }),
          ).toBe(expected);
          expect(
            codeGraphIndexScopeMembershipDigest({
              completeness: 'partial',
              includedProjectIds,
              rootProjectIds,
            }),
          ).not.toBe(expected);
        },
      ),
      {numRuns: 50},
    );
  });

  it('returns typed outside-project-graph paths and preserves disclosure in MCP output', () => {
    const outside = outsideCodeGraphProjectPaths(
      {cwd: '/repo', operation: 'path', from: 'apps/a/index.ts#start', to: 'apps/b/index.ts#target'},
      scope,
    );
    expect(outside).toEqual(['apps/b/index.ts']);
    const disclosed = discloseCodeGraphProjectCoverage(result, coverage, outside);
    expect(disclosed.outsideProjectGraph?.state).toBe('outside-project-graph');
    expect(disclosed.searchCoverage?.status).toBe('bounded');
    expect(compactCodeGraphMcpResult(disclosed)).toMatchObject({
      projectCoverage: coverage,
      outsideProjectGraph: {paths: outside},
    });
  });

  it('never reports exhaustive negative proof for any partial scope', () => {
    fc.assert(
      fc.property(fc.array(fc.string({maxLength: 24}), {maxLength: 6}), warnings => {
        const input = {...result, warnings};
        const disclosed = discloseCodeGraphProjectCoverage(input, coverage);
        expect(disclosed.searchCoverage?.status).not.toBe('exhaustive');
        expect(disclosed.warnings.slice(0, warnings.length)).toEqual(warnings);
        expect(input.searchCoverage?.status).toBe('exhaustive');
      }),
      {numRuns: 40},
    );
  });

  it('preserves unscoped results and does not interpret text concepts as paths', () => {
    expect(discloseCodeGraphProjectCoverage(result, undefined)).toBe(result);
    expect(
      outsideCodeGraphProjectPaths({cwd: '/repo', operation: 'query', query: 'parse module dependencies'}, scope),
    ).toEqual([]);
    expect(outsideCodeGraphProjectPaths({cwd: '/repo', operation: 'query', query: 'package.json'}, scope)).toEqual([]);
  });

  it('removes worker evidence for an outside-project selector and presents the snapshot actually read', () => {
    const workerResult: CodeGraphQueryResult = {
      ...result,
      edges: [
        {
          confidence: 1,
          evidencePath: 'apps/a/index.ts',
          evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
          id: 'edge',
          provenance: 'resolved',
          relation: 'calls',
          sourceName: 'inside',
          targetName: 'target',
        },
      ],
      nodes: [
        {
          contentHash: 'content',
          exported: true,
          id: 'node',
          kind: 'function',
          language: 'typescript',
          name: 'inside',
          path: 'apps/a/index.ts',
          qualifiedName: 'inside',
          score: 1,
          span: {column: 1, endColumn: 2, endLine: 1, line: 1},
        },
      ],
      snapshot: {...result.snapshot, commit: Effect.pipe('a', EffectString.repeat(40))},
      warnings: ['Selector did not resolve.'],
    };
    const presented = presentCodeGraphScopedReadyRead({
      identity,
      options: {cwd: '/repo', operation: 'query', query: 'apps/b/index.ts'},
      projectScope,
      result: workerResult,
      snapshot: workerResult.snapshot,
    });

    expect(presented.nodes).toEqual([]);
    expect(presented.edges).toEqual([]);
    expect(presented.searchCoverage).toBeUndefined();
    expect(presented.outsideProjectGraph?.paths).toEqual(['apps/b/index.ts']);
    expect(presented.warnings).not.toContain('Selector did not resolve.');
    expect(presented.projectCoverage?.snapshotSourceCommit).toBe(workerResult.snapshot.commit);
    expect(workerResult.nodes).toHaveLength(1);
  });

  it('counts only selected changed paths for the worker while retaining parent-side outside coverage', () => {
    const selected = selectCodeGraphReadyReadChangedPaths(projectScope, [
      'apps/a/index.ts',
      ...Array.from({length: 299}, (_, index) => `apps/b/file-${index}.ts`),
    ]);
    const presented = presentCodeGraphScopedReadyRead({
      identity,
      options: {cwd: '/repo', operation: 'impact', query: 'changed paths'},
      projectScope,
      result,
      selectedChangedPathCount: selected?.length,
      snapshot: result.snapshot,
      totalChangedPathCount: 300,
    });

    expect(selected).toEqual(['apps/a/index.ts']);
    expect(presented.outsideScopeChangedPaths).toBe(299);
  });
});
