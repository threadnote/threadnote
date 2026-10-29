import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {analyzeCodeGraph} from '@threadnote/graph/analysis';
import type {CodeGraphEdge, CodeGraphSymbol} from '@threadnote/graph/types';
import {
  analysisEdge,
  analysisSnapshot,
  analysisSymbol,
  pagedAnalysisStore,
  type AnalysisPagingObservation,
} from '../helpers/code-graph-analysis.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph analysis scaling', () => {
  effectIt.effect(
    'analyzes a production-shaped graph through bounded pages without hydrating the edge set',
    () =>
      Effect.gen(function* () {
        const nodeCount = 20_000;
        const packageSize = 100;
        const symbols: CodeGraphSymbol[] = Array.from({length: nodeCount}, (_, index) => {
          const padded = Effect2.pipe(index.toString(), EffectString.padStart(5, '0'));
          const packageIndex = Effect2.pipe(Math.floor(index / packageSize).toString(), EffectString.padStart(3, '0'));
          return analysisSymbol(`node-${padded}`, `package-${packageIndex}`, `packages/p${packageIndex}/src/index.ts`);
        });
        const edges: CodeGraphEdge[] = [];
        for (let index = 0; index < symbols.length; index += 1) {
          const source = symbols[index];
          const next = symbols[(index + 1) % symbols.length];
          edges.push(
            analysisEdge(`next-${Effect2.pipe(index.toString(), EffectString.padStart(5, '0'))}`, source, next),
          );
          if (index % 2 === 0) {
            const secondary = symbols[(index + 17) % symbols.length];
            edges.push(
              analysisEdge(
                `secondary-${Effect2.pipe(index.toString(), EffectString.padStart(5, '0'))}`,
                source,
                secondary,
                'references',
              ),
            );
          }
        }
        const observation: AnalysisPagingObservation = {edgePageLimits: [], symbolPageLimits: []};
        const startedAt = performance.now();

        const result = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges, observation), {
          budget: {
            maxEdges: edges.length,
            maxEdgeVisits: edges.length * 2,
            maxNodes: symbols.length,
            pageSize: 257,
          },
          databasePath: '/scale/graph.sqlite',
          limits: {communities: 50, components: 10, hubs: 10, memberships: 100, surprisingLinks: 10},
          snapshot: analysisSnapshot(symbols, edges),
        });
        const duration = performance.now() - startedAt;

        expect(result.coverage.complete).toBe(true);
        expect(result.statistics).toMatchObject({
          analyzedEdgeCount: edges.length,
          analyzedNodeCount: symbols.length,
          connectedComponentCount: 1,
          snapshotEdgeCount: edges.length,
          snapshotNodeCount: symbols.length,
        });
        expect(result.usage.edgeVisits).toBe(edges.length * 2);
        expect(result.memberships).toHaveLength(100);
        expect(result.communities.length).toBeLessThanOrEqual(50);
        expect(result.surprisingLinks.length).toBeLessThanOrEqual(10);
        expect(Math.max(...observation.symbolPageLimits, ...observation.edgePageLimits)).toBe(257);
        expect(observation.symbolPageLimits.length).toBeGreaterThan(50);
        expect(observation.edgePageLimits.length).toBeGreaterThan(200);
        expect(duration).toBeLessThan(10_000);
      }),
    20_000,
  );
});
