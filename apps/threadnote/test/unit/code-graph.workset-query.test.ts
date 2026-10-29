import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {describe} from 'vitest';
import {codeGraphWorksetMcpResponse} from '@threadnote/threadnote/mcp/server/index';
import {
  allocateCodeGraphWorksetBudget,
  renderCodeGraphWorksetResult,
  type CodeGraphWorksetQueryResult,
} from '@threadnote/graph/workset/query';
import type {CodeGraphQueryResult} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('bounded code graph workset queries', () => {
  fcProp(
    it,
    'allocates every admitted repository a deterministic fair prefix budget',
    {
      repositories: FC.integer({max: 8, min: 1}),
      surplus: FC.integer({max: 200, min: 0}),
    },
    ({repositories, surplus}) => {
      const total = repositories + surplus;
      const allocation = allocateCodeGraphWorksetBudget(total, repositories);

      expect(allocation).toHaveLength(repositories);
      expect(EffectArray.reduce(allocation, 0, (sum, value) => sum + value)).toBe(total);
      expect(Math.max(...allocation) - Math.min(...allocation)).toBeLessThanOrEqual(1);
      expect(EffectArray.every(allocation, value => value >= 1)).toBe(true);
      expect(allocateCodeGraphWorksetBudget(total, repositories)).toEqual(allocation);
    },
    {fastCheck: {numRuns: 150}},
  );

  it('preserves explicit repository and snapshot provenance in CLI and bounded MCP output', () => {
    const result = worksetResult([
      graphResult('mobile-native', 'repo-mobile', 'a'),
      graphResult('web', 'repo-web', 'b'),
    ]);
    const rendered = renderCodeGraphWorksetResult(result);
    const mcp = codeGraphWorksetMcpResponse(result);
    const encoded = new TextEncoder().encode(JSON.stringify(mcp.structuredContent)).byteLength;

    expect(rendered).toContain('Repository member: mobile-native');
    expect(rendered).toContain('Code graph: mobile-native');
    expect(JSON.stringify(mcp.structuredContent)).toContain('repo-mobile');
    expect(JSON.stringify(mcp.structuredContent)).toContain('repo-web');
    expect(encoded).toBeLessThanOrEqual(24 * 1_024);
  });
});

function worksetResult(graphs: readonly CodeGraphQueryResult[]): CodeGraphWorksetQueryResult {
  return {
    coverage: {
      complete: true,
      queriedRepositories: graphs.length,
      readyRepositories: graphs.length,
      requestedRepositories: graphs.length,
    },
    repositories: EffectArray.map(graphs, graph => ({graph, project: graph.repository.displayName, state: 'ready'})),
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    type: 'code-graph-workset-query',
    version: 1,
    warnings: [],
    workset: {name: 'product'},
  };
}

function graphResult(displayName: string, repositoryId: string, commitCharacter: string): CodeGraphQueryResult {
  const id = `cgs_${Effect.pipe(commitCharacter, EffectString.repeat(32))}`;
  return {
    edges: [],
    freshness: 'current',
    nodes: [
      {
        contentHash: `hash-${displayName}`,
        exported: true,
        id,
        kind: 'method',
        language: 'typescript',
        name: 'clearSession',
        path: 'src/session.ts',
        qualifiedName: 'SessionStore.clearSession',
        score: 1,
        span: {column: 1, endColumn: 2, endLine: 1, line: 1},
      },
    ],
    operation: 'query',
    repository: {displayName, repositoryId},
    snapshot: {
      commit: Effect.pipe(commitCharacter, EffectString.repeat(40)),
      dirty: false,
      id: `cgsn_${Effect.pipe(commitCharacter, EffectString.repeat(40))}`,
      worktreeId: `worktree-${displayName}`,
    },
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    version: 1,
    warnings: [],
  };
}
