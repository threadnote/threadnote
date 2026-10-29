import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  graphFocusLayoutTargets,
  managerGraphClientRenderProxy,
  type GraphEdge,
  type GraphQueryVisualization,
} from '@threadnote/manager/graph';
import {
  MANAGER_GRAPH_MAX_EDGE_LIMIT,
  MANAGER_GRAPH_MAX_NODE_LIMIT,
  managerGraphVisualizationLimits,
} from '@threadnote/graph/visualization/limits';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

// Istanbul instruments every branch in the layout loop, while hosted CI shares
// cores with parallel Bazel actions. Keep the focused local budget unchanged.
const focusedLayoutBudgetMilliseconds = '__coverage__' in globalThis || process.env.CI ? 350 : 250;

describe('Manager graph production-shaped budgets', () => {
  it('clamps server working sets before querying or serializing them', () => {
    expect(managerGraphVisualizationLimits()).toEqual({edgeLimit: 640, nodeLimit: 240});
    expect(managerGraphVisualizationLimits({edgeLimit: Number.MAX_SAFE_INTEGER, nodeLimit: 50_000})).toEqual({
      edgeLimit: MANAGER_GRAPH_MAX_EDGE_LIMIT,
      nodeLimit: MANAGER_GRAPH_MAX_NODE_LIMIT,
    });
    expect(managerGraphVisualizationLimits({edgeLimit: Number.NaN, nodeLimit: -1})).toEqual({
      edgeLimit: 640,
      nodeLimit: 1,
    });
  });

  it('keeps a maximum code-query working set and deterministic client render latency bounded', () => {
    const graph = maximumGraphFixture();
    const payloadBytes = new TextEncoder().encode(JSON.stringify(graph)).byteLength;
    const startedAt = performance.now();
    let result = managerGraphClientRenderProxy(graph);
    for (let iteration = 1; iteration < 20; iteration += 1) result = managerGraphClientRenderProxy(graph);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(payloadBytes).toBeLessThan(1_250_000);
    expect(graph.query).toEqual({
      matchedNodes: 40,
      state: 'ready',
      text: 'dependency injection boundary',
      warnings: [],
    });
    expect(graph.nodes).toHaveLength(MANAGER_GRAPH_MAX_NODE_LIMIT);
    expect(graph.edges).toHaveLength(MANAGER_GRAPH_MAX_EDGE_LIMIT);
    expect(result).toEqual({labels: expect.any(Number), matchedEdges: 1_500, nodes: 500});
    expect(result.labels).toBeLessThanOrEqual(180);
    expect(elapsedMilliseconds).toBeLessThan(2_000);
  });

  it('lays out a maximum-cardinality focused neighborhood without an all-pairs UI stall', () => {
    const nodes = Array.from({length: MANAGER_GRAPH_MAX_NODE_LIMIT}, (_, index) => ({
      id: `node-${index}`,
      label: `ProductionNode${index}`,
      radius: 7,
      x: (index % 25) * 12,
      y: Math.floor(index / 25) * 12,
    }));
    const edges = EffectArray.map(nodes.slice(1), node => ({sourceId: nodes[0].id, targetId: node.id}));
    const labelSizes = new Map(EffectArray.map(nodes, node => [node.id, {height: 15, width: 120}]));
    graphFocusLayoutTargets(nodes, nodes[0].id, edges, labelSizes, 2.8);

    const startedAt = performance.now();
    let result = graphFocusLayoutTargets(nodes, nodes[0].id, edges, labelSizes, 2.8);
    for (let iteration = 1; iteration < 5; iteration += 1) {
      result = graphFocusLayoutTargets(nodes, nodes[0].id, edges, labelSizes, 2.8);
    }
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(result.size).toBe(MANAGER_GRAPH_MAX_NODE_LIMIT);
    expect(elapsedMilliseconds).toBeLessThan(focusedLayoutBudgetMilliseconds);
  });
});

function maximumGraphFixture(): GraphQueryVisualization {
  const nodes = Array.from({length: MANAGER_GRAPH_MAX_NODE_LIMIT}, (_, index) => {
    const suffix = Effect.pipe(index.toString(), EffectString.padStart(4, '0'));
    return {
      degree: 6,
      exported: true,
      id: `cgs_${suffix}`,
      kind: index % 7 === 0 ? 'class' : 'function',
      label: `productionSymbol${suffix}${Effect.pipe('x', EffectString.repeat(64))}`,
      language: 'typescript',
      path: `apps/production/src/deep/module/${suffix}/${Effect.pipe('segment/', EffectString.repeat(12))}index.ts`,
      projectId: 'cgp_production',
      qualifiedName: `Production.Module.${suffix}.${Effect.pipe('Namespace.', EffectString.repeat(12))}symbol`,
      type: 'symbol' as const,
    };
  });
  const edges: readonly GraphEdge[] = Array.from({length: MANAGER_GRAPH_MAX_EDGE_LIMIT}, (_, index) => ({
    confidence: 1,
    count: 1,
    id: `cge_${Effect.pipe(index.toString(), EffectString.padStart(5, '0'))}`,
    provenance: 'resolved',
    relation: index % 2 === 0 ? 'calls' : 'imports',
    sourceId: nodes[index % nodes.length].id,
    targetId: nodes[(index * 17 + 1) % nodes.length].id,
  }));
  return {
    edges,
    mode: 'detail',
    nodes,
    paging: {
      edgeLimit: MANAGER_GRAPH_MAX_EDGE_LIMIT,
      hasMore: true,
      nodeLimit: MANAGER_GRAPH_MAX_NODE_LIMIT,
    },
    projectId: 'cgp_production',
    query: {matchedNodes: 40, state: 'ready', text: 'dependency injection boundary', warnings: []},
    repository: {
      accounting: {
        attributedSymbols: 0,
        componentSymbols: 0,
        fallbackSymbols: 0,
        omittedSymbols: 2_700_000,
        totalSymbols: 2_700_000,
      },
      displayName: 'public/production-monorepo',
      id: 'checkout.worktree',
      metrics: 'deferred',
      snapshot: {
        commit: Effect.pipe('a', EffectString.repeat(40)),
        dirty: false,
        edgeCount: 8_000_000,
        fileCount: 70_000,
        id: 'snapshot-production',
        symbolCount: 2_700_000,
      },
    },
    scope: {id: 'cgp_production', label: 'production-app'},
    stats: {
      renderedEdges: edges.length,
      renderedNodes: nodes.length,
      totalEdges: 8_000_000,
      totalNodes: 2_700_000,
    },
    warnings: ['Bounded production-shaped working set.'],
  };
}
