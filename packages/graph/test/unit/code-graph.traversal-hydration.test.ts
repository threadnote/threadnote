import {expect, it} from '@effect/vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe} from 'vitest';
import {pathQuery} from '../../src/query/path.js';
import type {CodeGraphStoreShape} from '../../src/store.js';
import type {CodeGraphEdge, CodeGraphQueryNode} from '../../src/types.js';

const node = (id: string): CodeGraphQueryNode => ({
  contentHash: id,
  exported: true,
  id,
  kind: 'function',
  language: 'typescript',
  name: id,
  path: `src/${id}.ts`,
  qualifiedName: id,
  score: 1,
  span: {column: 1, endColumn: 2, endLine: 1, line: 1},
});

const edge = (sourceId: string, targetId: string): CodeGraphEdge => ({
  confidence: 1,
  evidencePath: `src/${sourceId}.ts`,
  evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
  id: `${sourceId}-${targetId}`,
  provenance: 'resolved',
  relation: 'calls',
  sourceId,
  sourceName: sourceId,
  targetId,
  targetName: targetId,
});

function fixture(edges: readonly CodeGraphEdge[], expiredAt?: 'adjacency' | 'symbols' | 'evidence') {
  const evidenceRequests: Array<{ids: readonly string[]; snapshotId: string}> = [];
  const nodes = [...new Set(['start', 'target', ...edges.flatMap(edge => [edge.sourceId!, edge.targetId!])])].map(node);
  const store = {
    directEdgeBetweenNodes: () => Effect.void,
    edgesByIds: (_databasePath: string, snapshotId: string, ids: readonly string[]) =>
      Effect.gen(function* () {
        evidenceRequests.push({ids: [...ids], snapshotId});
        if (expiredAt === 'evidence') yield* TestClock.adjust(2_001);
        return ids.map(id => edges.find(edge => edge.id === id)!);
      }),
    searchSymbols: (_databasePath: string, _snapshotId: string, query: string) =>
      Effect.succeed(nodes.filter(node => node.id === query)),
    symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
      Effect.gen(function* () {
        if (expiredAt === 'symbols') yield* TestClock.adjust(2_001);
        return nodes.filter(node => ids.includes(node.id));
      }),
    traversalEdgesForNodes: (
      _databasePath: string,
      _snapshotId: string,
      ids: readonly string[],
      direction: 'incoming' | 'outgoing' | 'both',
      limit: number,
    ) =>
      Effect.gen(function* () {
        if (expiredAt === 'adjacency') yield* TestClock.adjust(2_001);
        return edges
          .filter(
            edge =>
              (direction !== 'incoming' && ids.includes(edge.sourceId!)) ||
              (direction !== 'outgoing' && ids.includes(edge.targetId!)),
          )
          .slice(0, limit)
          .map(({id, sourceId, targetId, relation, provenance, confidence}) => ({
            confidence,
            id,
            provenance,
            relation,
            sourceId,
            targetId,
          }));
      }),
  } as unknown as CodeGraphStoreShape;
  return {evidenceRequests, store};
}

const path = (store: CodeGraphStoreShape) =>
  pathQuery(store, '/fixture/graph.sqlite', 'leased-snapshot', 'start', 'target', 100, 200, 3, ['resolved']);

describe('traversal evidence hydration', () => {
  it.effect('does not hydrate evidence when no path exists', () =>
    Effect.gen(function* () {
      const {store, evidenceRequests} = fixture([edge('start', 'dead-end')]);
      const result = yield* path(store);
      expect(result.edges).toEqual([]);
      expect(result.searchCoverage.status).toBe('exhaustive');
      expect(evidenceRequests).toEqual([]);
    }),
  );

  fcEffectProp(
    it,
    'hydrates only the ordered selected path, independently of discarded branches',
    {noise: fc.uniqueArray(fc.integer({min: 0, max: 40}), {maxLength: 20})},
    ({noise}) =>
      Effect.gen(function* () {
        const expected = [edge('start', 'middle'), edge('middle', 'target')];
        const discarded = noise.map(id => edge('start', `noise-${id}`));
        const {store, evidenceRequests} = fixture([...discarded, ...expected]);
        const result = yield* path(store);
        expect(result.edges).toEqual(expected);
        expect(result.nodes.map(node => node.id)).toEqual(['start', 'middle', 'target']);
        expect(result.searchCoverage.status).toBe('found');
        expect(evidenceRequests).toEqual([{ids: expected.map(edge => edge.id), snapshotId: 'leased-snapshot'}]);
      }),
    {fastCheck: {numRuns: 30, seed: 741}},
  );

  for (const expiredAt of ['adjacency', 'symbols', 'evidence'] as const) {
    it.effect(`reports a path timeout after ${expiredAt}`, () =>
      Effect.gen(function* () {
        const {store, evidenceRequests} = fixture([edge('start', 'middle'), edge('middle', 'target')], expiredAt);
        const result = yield* path(store);
        expect(result.edges).toEqual([]);
        expect(result.searchCoverage).toMatchObject({status: 'timed-out', limitsReached: ['time-budget']});
        expect(evidenceRequests).toHaveLength(expiredAt === 'evidence' ? 1 : 0);
      }),
    );
  }
});
