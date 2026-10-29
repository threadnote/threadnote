import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Clock, Effect} from 'effect';
import type {CodeGraphStoreShape} from '../store.js';
import type {CodeGraphEdge, CodeGraphProvenance, CodeGraphQueryNode, CodeGraphQueryResult} from '../types.js';
import {QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS} from './path.js';

type SearchCoverage = NonNullable<CodeGraphQueryResult['searchCoverage']>;

export type CodeGraphExactNodeQueryStore = Pick<CodeGraphStoreShape, 'symbolsByIds'>;
export type CodeGraphNeighborQueryStore = Pick<CodeGraphStoreShape, 'edgesForNodes' | 'symbolsByIds'>;

export function adjacentNodeIds(
  edge: CodeGraphEdge,
  direction: 'both' | 'incoming' | 'outgoing',
  frontier: ReadonlyMap<string, number>,
): readonly string[] {
  if (direction === 'incoming')
    return edge.targetId && frontier.has(edge.targetId) && edge.sourceId ? [edge.sourceId] : [];
  if (direction === 'outgoing')
    return edge.sourceId && frontier.has(edge.sourceId) && edge.targetId ? [edge.targetId] : [];
  const adjacent: string[] = [];
  if (edge.sourceId && frontier.has(edge.sourceId) && edge.targetId) adjacent.push(edge.targetId);
  if (edge.targetId && frontier.has(edge.targetId) && edge.sourceId) adjacent.push(edge.sourceId);
  return adjacent;
}

export const exactNodeQuery = Effect.fn('codeGraph.exactNodeQuery')(function* (
  store: CodeGraphExactNodeQueryStore,
  databasePath: string,
  snapshotId: string,
  nodeId: string,
) {
  const symbols = yield* store.symbolsByIds(databasePath, snapshotId, [nodeId]);
  const symbol = EffectOption.getOrUndefined(EffectArray.findFirst(symbols, candidate => candidate.id === nodeId));
  return symbol
    ? {edges: [], nodes: [{...symbol, score: 1}], warnings: []}
    : {edges: [], nodes: [], warnings: [`Code graph node "${nodeId}" was not found in the selected snapshot.`]};
});

const deadlineReached = Effect.fn('codeGraph.neighborDeadlineReached')(function* (deadline: number) {
  return (yield* Clock.currentTimeMillis) >= deadline;
});

export const neighborQuery = Effect.fn('codeGraph.neighborQuery')(function* (
  store: CodeGraphNeighborQueryStore,
  databasePath: string,
  snapshotId: string,
  nodeId: string,
  direction: 'both' | 'incoming' | 'outgoing',
  nodeLimit: number,
  edgeLimit: number,
  depth: number,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  const deadline = (yield* Clock.currentTimeMillis) + QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS;
  const initial = yield* exactNodeQuery(store, databasePath, snapshotId, nodeId);
  const seed = initial.nodes[0];
  const nodes = new Map<string, CodeGraphQueryNode>(seed ? [[seed.id, seed]] : []);
  const edges = new Map<string, CodeGraphEdge>();
  const visited = new Set(nodes.keys());
  const limitsReached = new Set<SearchCoverage['limitsReached'][number]>();
  let frontier = seed ? [seed.id] : [];
  let inspectedEdges = 0;
  let completedDepth = 0;
  let omittedNodes = 0;
  let missingNodes = seed ? 0 : 1;
  let unresolvedEdges = 0;
  let timedOut = yield* deadlineReached(deadline);

  for (let currentDepth = 0; currentDepth < depth && frontier.length > 0 && !timedOut; currentDepth += 1) {
    const remainingEdges = edgeLimit - inspectedEdges;
    // One lookahead row distinguishes an exactly full result from omitted relationships.
    const fetched = yield* store.edgesForNodes(
      databasePath,
      snapshotId,
      frontier,
      direction,
      remainingEdges + 1,
      allowedProvenances,
    );
    if (fetched.length > remainingEdges) limitsReached.add('edge-limit');
    const adjacent = fetched.slice(0, remainingEdges);
    inspectedEdges += adjacent.length;
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }

    unresolvedEdges += EffectArray.filter(adjacent, edge => !edge.sourceId || !edge.targetId).length;
    const frontierDepths = new Map(EffectArray.map(frontier, id => [id, currentDepth] as const));
    const candidateIds = [
      ...new Set(
        EffectArray.filter(
          EffectArray.flatMap(adjacent, edge => adjacentNodeIds(edge, direction, frontierDepths)),
          id => !visited.has(id),
        ),
      ),
    ];
    const remainingNodes = nodeLimit - nodes.size;
    if (candidateIds.length > remainingNodes) {
      limitsReached.add('node-limit');
      omittedNodes += candidateIds.length - remainingNodes;
    }
    const selectedIds = candidateIds.slice(0, remainingNodes);
    const hydrated = yield* store.symbolsByIds(databasePath, snapshotId, selectedIds);
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }
    const selectedIdSet = new Set(selectedIds);
    const next = EffectArray.filter(
      hydrated,
      (symbol, __effectArrayIndex) =>
        __effectArrayIndex in hydrated && selectedIdSet.has(symbol.id) && !visited.has(symbol.id),
    );
    missingNodes += selectedIds.length - new Set(EffectArray.map(next, symbol => symbol.id)).size;
    for (const symbol of next) {
      visited.add(symbol.id);
      nodes.set(symbol.id, {...symbol, score: 1 / (currentDepth + 2)});
    }
    for (const edge of adjacent) {
      if (edge.sourceId && edge.targetId && nodes.has(edge.sourceId) && nodes.has(edge.targetId))
        edges.set(edge.id, edge);
    }
    if (limitsReached.size || missingNodes || unresolvedEdges) break;
    completedDepth = currentDepth + 1;
    frontier = EffectArray.map(next, symbol => symbol.id);
  }

  if (timedOut) limitsReached.add('time-budget');
  const searchCoverage: SearchCoverage = {
    status: timedOut
      ? 'timed-out'
      : limitsReached.size
        ? 'bounded'
        : missingNodes || unresolvedEdges
          ? 'unresolved'
          : 'exhaustive',
    limitsReached: [...limitsReached],
    visitedNodes: nodes.size,
    inspectedEdges,
    directEdgeChecked: false,
    neighborScope: {
      requestedDepth: depth,
      completedDepth,
      direction,
      nodeLimit,
      edgeLimit,
      allowedProvenances: [...allowedProvenances],
      omittedNodes,
      missingNodes,
      unresolvedEdges,
    },
  };
  return {
    edges: [...edges.values()],
    nodes: [...nodes.values()],
    searchCoverage,
    warnings: [
      ...initial.warnings,
      ...(timedOut
        ? ['Neighbor traversal reached its elapsed-time budget; results are partial.']
        : limitsReached.size
          ? ['Neighbor traversal reached a configured result limit.']
          : []),
      ...(seed && (missingNodes || unresolvedEdges)
        ? ['Neighbor traversal contains unresolved endpoints; results are partial.']
        : []),
    ],
  };
});
