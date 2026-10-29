import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {managerGraphQueryWorkingSet} from '@threadnote/graph/visualization';
import type {CodeGraphEdge, CodeGraphQueryNode} from '@threadnote/graph/types';

describe('Manager graph query properties', () => {
  it('keeps randomized query neighborhoods bounded and endpoint-closed', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 250}),
        fc.array(
          fc.record({
            source: fc.integer({min: 0, max: 270}),
            target: fc.integer({min: 0, max: 270}),
          }),
          {maxLength: 600},
        ),
        fc.integer({min: 1, max: 200}),
        fc.integer({min: 1, max: 500}),
        (nodeCount, relationships, nodeLimit, edgeLimit) => {
          const nodes = Array.from({length: nodeCount}, (_, index) => queryNode(index));
          const edges = EffectArray.map(relationships, (relationship, index) =>
            queryEdge(index, relationship.source, relationship.target),
          );
          const result = managerGraphQueryWorkingSet(nodes, edges, {edgeLimit, nodeLimit});
          const visibleIds = new Set(EffectArray.map(result.nodes, node => node.id));

          expect(result.nodes.length).toBeLessThanOrEqual(nodeLimit);
          expect(result.edges.length).toBeLessThanOrEqual(edgeLimit);
          expect(visibleIds.size).toBe(result.nodes.length);
          expect(
            EffectArray.every(result.edges, edge => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)),
          ).toBe(true);
          expect(EffectArray.every(result.edges, edge => edge.sourceId !== edge.targetId)).toBe(true);
          expect(
            EffectArray.every(result.nodes, node => typeof node.score === 'number' && Number.isFinite(node.score)),
          ).toBe(true);
          if (nodeCount > nodeLimit || edges.length > result.edges.length) expect(result.truncated).toBe(true);
        },
      ),
      {numRuns: 120},
    );
  });
});

function queryNode(index: number): CodeGraphQueryNode {
  return {
    contentHash: `hash-${index}`,
    exported: index % 2 === 0,
    id: `node-${index}`,
    kind: index % 5 === 0 ? 'class' : 'function',
    language: 'typescript',
    name: `node${index}`,
    path: `src/node-${index}.ts`,
    qualifiedName: `node${index}`,
    score: 1 / (index + 1),
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function queryEdge(index: number, source: number, target: number): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: `src/node-${source}.ts`,
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id: `edge-${index}`,
    provenance: 'resolved',
    relation: 'calls',
    sourceId: `node-${source}`,
    sourceName: `node${source}`,
    targetId: `node-${target}`,
    targetName: `node${target}`,
  };
}
