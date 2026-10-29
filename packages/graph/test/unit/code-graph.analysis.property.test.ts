import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {analyzeCodeGraph, type CodeGraphAnalysisResult} from '@threadnote/graph/analysis';
import type {CodeGraphEdge} from '@threadnote/graph/types';
import {analysisEdge, analysisSnapshot, analysisSymbol, pagedAnalysisStore} from '../helpers/code-graph-analysis.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const analysisCase = FC.record({
  nodeCount: FC.integer({max: 18, min: 1}),
  packageCount: FC.integer({max: 5, min: 1}),
  rawEdges: FC.array(
    FC.record({
      relation: FC.constantFrom<CodeGraphEdge['relation']>('calls', 'contains', 'extends', 'imports', 'references'),
      source: FC.integer({max: 31, min: 0}),
      target: FC.integer({max: 31, min: 0}),
    }),
    {maxLength: 48},
  ),
});

const boundedAnalysisCase = FC.record({
  nodeCount: FC.integer({max: 18, min: 2}),
  packageCount: FC.integer({max: 5, min: 1}),
  prefixSeed: FC.nat({max: 31}),
  rawEdges: FC.array(
    FC.record({
      relation: FC.constantFrom<CodeGraphEdge['relation']>('calls', 'contains', 'extends', 'imports', 'references'),
      source: FC.integer({max: 31, min: 0}),
      target: FC.integer({max: 31, min: 0}),
    }),
    {maxLength: 48},
  ),
});

describe('code graph analysis properties', () => {
  fcEffectProp(
    it,
    'keeps partitions, identifiers, labels, and ranking stable across input order and page size',
    {fixture: analysisCase},
    ({fixture}) => {
      const symbols = Array.from({length: fixture.nodeCount}, (_, index) =>
        analysisSymbol(
          `node-${Effect2.pipe(index.toString(), EffectString.padStart(2, '0'))}`,
          `package-${index % fixture.packageCount}`,
          `packages/p${index % fixture.packageCount}/src/${index}.ts`,
        ),
      );
      const uniqueEdges = new Map<string, CodeGraphEdge>();
      for (const [index, raw] of fixture.rawEdges.entries()) {
        const source = symbols[raw.source % symbols.length];
        const target = symbols[raw.target % symbols.length];
        const key = `${source.id}:${raw.relation}:${target.id}`;
        if (!uniqueEdges.has(key)) {
          uniqueEdges.set(
            key,
            analysisEdge(
              `edge-${Effect2.pipe(index.toString(), EffectString.padStart(3, '0'))}`,
              source,
              target,
              raw.relation,
            ),
          );
        }
      }
      const edges = [...uniqueEdges.values()];
      const snapshot = analysisSnapshot(symbols, edges);
      return Effect.gen(function* () {
        const first = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
          budget: {aggregatePageSize: 1, pageSize: 1},
          databasePath: '/property/graph.sqlite',
          snapshot,
        });
        const second = yield* analyzeCodeGraph(pagedAnalysisStore([...symbols].reverse(), [...edges].reverse()), {
          budget: {aggregatePageSize: 7, pageSize: 7},
          databasePath: '/property/graph.sqlite',
          snapshot,
        });

        expect(stableProjection(second)).toEqual(stableProjection(first));
        expect(first.coverage.complete).toBe(true);
        expect(new Set(EffectArray.map(first.memberships, item => item.node.id)).size).toBe(first.memberships.length);
        expect(
          isSorted(
            EffectArray.map(first.memberships, item => item.node.id),
            (left, right) => Effect2.pipe(left, EffectString.localeCompare(right)),
          ),
        ).toBe(true);
        expect(isSorted(first.hubs, compareHubOrder)).toBe(true);
        expect(isSorted(first.surprisingLinks, compareSurpriseOrder)).toBe(true);

        const membership = new Map(EffectArray.map(first.memberships, item => [item.node.id, item]));
        for (const edge of edges) {
          expect(membership.get(edge.sourceId!)?.componentId).toBe(membership.get(edge.targetId!)?.componentId);
          const source = EffectOption.getOrUndefined(
            EffectArray.findFirst(symbols, symbol => symbol.id === edge.sourceId),
          )!;
          const target = EffectOption.getOrUndefined(
            EffectArray.findFirst(symbols, symbol => symbol.id === edge.targetId),
          )!;
          if (source.path === target.path || isCohesive(edge.relation)) {
            expect(membership.get(source.id)?.communityId).toBe(membership.get(target.id)?.communityId);
          }
        }
        for (const communityId of new Set(EffectArray.map(first.memberships, item => item.communityId))) {
          const componentIds = new Set(
            EffectArray.map(
              EffectArray.filter(first.memberships, item => item.communityId === communityId),
              item => item.componentId,
            ),
          );
          expect(componentIds.size).toBe(1);
        }
      });
    },
    {fastCheck: {numRuns: 80}},
  );

  fcEffectProp(
    it,
    'keeps bounded induced topology deterministic and excludes relationships to omitted nodes',
    {fixture: boundedAnalysisCase},
    ({fixture}) => {
      const symbols = Array.from({length: fixture.nodeCount}, (_, index) =>
        analysisSymbol(
          `node-${Effect2.pipe(index.toString(), EffectString.padStart(2, '0'))}`,
          `package-${index % fixture.packageCount}`,
          `packages/p${index % fixture.packageCount}/src/${index}.ts`,
        ),
      );
      const uniqueEdges = new Map<string, CodeGraphEdge>();
      for (const [index, raw] of fixture.rawEdges.entries()) {
        const source = symbols[raw.source % symbols.length];
        const target = symbols[raw.target % symbols.length];
        const key = `${source.id}:${raw.relation}:${target.id}`;
        if (!uniqueEdges.has(key)) {
          uniqueEdges.set(
            key,
            analysisEdge(
              `edge-${Effect2.pipe(index.toString(), EffectString.padStart(3, '0'))}`,
              source,
              target,
              raw.relation,
            ),
          );
        }
      }
      const edges = [...uniqueEdges.values()];
      const snapshot = analysisSnapshot(symbols, edges);
      const prefixSize = 1 + (fixture.prefixSeed % (symbols.length - 1));
      const orderedSymbols = [...symbols].sort(
        (left, right) =>
          Effect2.pipe(left.path, EffectString.localeCompare(right.path)) ||
          Effect2.pipe(left.qualifiedName, EffectString.localeCompare(right.qualifiedName)) ||
          Effect2.pipe(left.id, EffectString.localeCompare(right.id)),
      );
      const retainedIds = new Set(EffectArray.map(orderedSymbols.slice(0, prefixSize), symbol => symbol.id));
      const expectedInducedEdges = EffectArray.filter(
        edges,
        __effectArrayValue =>
          !!(edge => retainedIds.has(edge.sourceId!) && retainedIds.has(edge.targetId!))(__effectArrayValue),
      ).length;
      const budget = {
        aggregatePageSize: 1,
        maxEdges: edges.length,
        maxEdgeVisits: edges.length * 2,
        maxNodes: prefixSize,
        pageSize: 1,
      } as const;

      return Effect.gen(function* () {
        const first = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
          budget,
          databasePath: '/property/bounded.sqlite',
          snapshot,
        });
        const second = yield* analyzeCodeGraph(pagedAnalysisStore([...symbols].reverse(), [...edges].reverse()), {
          budget: {...budget, aggregatePageSize: 7, pageSize: 7},
          databasePath: '/property/bounded.sqlite',
          snapshot,
        });

        expect(stableProjection(second)).toEqual(stableProjection(first));
        expect(first.coverage).toMatchObject({
          nodesComplete: false,
          topology: {complete: false, state: 'partial'},
        });
        expect(first.statistics.analyzedNodeCount).toBe(prefixSize);
        expect(first.statistics.analyzedEdgeCount).toBe(expectedInducedEdges);
        expect(new Set(EffectArray.map(first.memberships, item => item.node.id))).toEqual(retainedIds);
        expect(first.warnings).toContainEqual(expect.stringContaining('bounded path-prefix induced subgraph'));
      });
    },
    {fastCheck: {numRuns: 60}},
  );
});

function stableProjection(result: CodeGraphAnalysisResult) {
  return {
    algorithms: result.algorithms,
    allowedProvenances: result.allowedProvenances,
    communities: result.communities,
    components: result.components,
    confidenceAudit: result.confidenceAudit,
    coverage: result.coverage,
    hubThresholds: result.hubThresholds,
    hubs: result.hubs,
    memberships: result.memberships,
    relationshipGroups: result.relationshipGroups,
    statistics: result.statistics,
    suggestedQuestions: result.suggestedQuestions,
    surprisingLinks: result.surprisingLinks,
    trust: result.trust,
    warnings: result.warnings,
  };
}

function isCohesive(relation: CodeGraphEdge['relation']): boolean {
  return ['contains', 'declares', 'exports', 'extends', 'implements', 'overrides', 'reexports'].includes(relation);
}

function isSorted<Value>(values: readonly Value[], compare: (left: Value, right: Value) => number): boolean {
  return EffectArray.every(values, (value, index) => index === 0 || compare(values[index - 1], value) <= 0);
}

function compareHubOrder(
  left: CodeGraphAnalysisResult['hubs'][number],
  right: CodeGraphAnalysisResult['hubs'][number],
) {
  return (
    right.degree - left.degree ||
    right.incoming - left.incoming ||
    Effect2.pipe(left.node.qualifiedName, EffectString.localeCompare(right.node.qualifiedName)) ||
    Effect2.pipe(left.node.id, EffectString.localeCompare(right.node.id))
  );
}

function compareSurpriseOrder(
  left: CodeGraphAnalysisResult['surprisingLinks'][number],
  right: CodeGraphAnalysisResult['surprisingLinks'][number],
) {
  return (
    right.score - left.score ||
    right.confidence - left.confidence ||
    Effect2.pipe(left.source.qualifiedName, EffectString.localeCompare(right.source.qualifiedName)) ||
    Effect2.pipe(left.relation, EffectString.localeCompare(right.relation)) ||
    Effect2.pipe(left.target.qualifiedName, EffectString.localeCompare(right.target.qualifiedName)) ||
    Effect2.pipe(left.edgeId, EffectString.localeCompare(right.edgeId))
  );
}
