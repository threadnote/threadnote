import {Array as EffectArray} from 'effect';
import {Clock, Effect} from 'effect';
import type {CodeGraphStoreShape} from '../store.js';
import type {CodeGraphTraversalEdge} from '../store/internal_models.js';
import {codeGraphEndpointMatches, parseCodeGraphEndpointSelector, selectCodeGraphEndpoint} from './selector.js';
import type {CodeGraphProvenance, CodeGraphQueryNode, CodeGraphQueryResult} from '../types.js';

export const QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS = 2_000;

export type CodeGraphPathQueryStore = Pick<
  CodeGraphStoreShape,
  | 'directEdgeBetweenNodes'
  | 'edgesByIds'
  | 'findSymbolsByPathAndName'
  | 'searchSymbols'
  | 'symbolsByIds'
  | 'traversalEdgesForNodes'
>;

const deadlineReached = Effect.fn('codeGraph.pathDeadlineReached')(function* (deadline: number) {
  return (yield* Clock.currentTimeMillis) >= deadline;
});

export const pathQuery = Effect.fn('codeGraph.pathQuery')(function* (
  store: CodeGraphPathQueryStore,
  databasePath: string,
  snapshotId: string,
  from: string,
  to: string,
  nodeLimit: number,
  edgeLimit: number,
  depth: number,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  const deadline = (yield* Clock.currentTimeMillis) + QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS;
  const coverage = (
    status: NonNullable<CodeGraphQueryResult['searchCoverage']>['status'],
    limitsReached: NonNullable<CodeGraphQueryResult['searchCoverage']>['limitsReached'],
    visitedNodes: number,
    inspectedEdges: number,
    directEdgeChecked: boolean,
  ) => ({status, limitsReached, visitedNodes, inspectedEdges, directEdgeChecked});
  const fromSelector = parseCodeGraphEndpointSelector(from);
  const toSelector = parseCodeGraphEndpointSelector(to);
  const fromMatches = yield* codeGraphEndpointMatches(store, databasePath, snapshotId, fromSelector);
  if (yield* deadlineReached(deadline)) {
    return {
      edges: [],
      nodes: [],
      searchCoverage: coverage('timed-out', ['time-budget'], 0, 0, false),
      warnings: ['Path search reached its elapsed-time budget; results are partial.'],
    };
  }
  const toMatches = yield* codeGraphEndpointMatches(store, databasePath, snapshotId, toSelector);
  if (yield* deadlineReached(deadline)) {
    return {
      edges: [],
      nodes: fromMatches.slice(0, nodeLimit),
      searchCoverage: coverage('timed-out', ['time-budget'], 0, 0, false),
      warnings: ['Path search reached its elapsed-time budget; results are partial.'],
    };
  }
  const startSelection = selectCodeGraphEndpoint(fromMatches, fromSelector);
  const targetSelection = selectCodeGraphEndpoint(toMatches, toSelector);
  const start = startSelection.node;
  const target = targetSelection.node;
  const selectorWarnings = [...startSelection.warnings, ...targetSelection.warnings];
  if (!start || !target) {
    return {
      edges: [],
      nodes: [...fromMatches, ...toMatches].slice(0, nodeLimit),
      searchCoverage: coverage('unresolved', [], 0, 0, false),
      warnings:
        selectorWarnings.length > 0
          ? selectorWarnings
          : ['One or both path endpoints could not be resolved unambiguously.'],
    };
  }
  if (start.id === target.id) {
    return {edges: [], nodes: [start], searchCoverage: coverage('found', [], 1, 0, false), warnings: []};
  }
  if (depth === 0) {
    return {
      edges: [],
      nodes: [start, target],
      searchCoverage: coverage('bounded', ['depth'], 1, 0, false),
      warnings: [
        'No authoritative path was found; search coverage was bounded by depth. Widen the traversal limits or inspect endpoint neighbors.',
      ],
    };
  }
  const direct = yield* store.directEdgeBetweenNodes(databasePath, snapshotId, start.id, target.id, allowedProvenances);
  if (yield* deadlineReached(deadline)) {
    return {
      edges: [],
      nodes: [start, target],
      searchCoverage: coverage('timed-out', ['time-budget'], 1, 0, true),
      warnings: ['Path search reached its elapsed-time budget; results are partial.'],
    };
  }
  if (direct) {
    return {
      edges: [direct],
      nodes: [start, target],
      searchCoverage: coverage('found', [], 2, 1, true),
      warnings: [],
    };
  }
  let frontier = [start.id];
  const visited = new Set([start.id]);
  const parent = new Map<string, {readonly edge: CodeGraphTraversalEdge; readonly previous: string}>();
  let found = false;
  let inspectedEdges = 0;
  let timedOut = false;
  let exhaustedByDepth = false;
  let adjacencyBounded = false;
  let nodeBounded = false;
  for (
    let currentDepth = 0;
    currentDepth < depth && frontier.length > 0 && visited.size < nodeLimit && inspectedEdges < edgeLimit;
    currentDepth += 1
  ) {
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      timedOut = true;
      break;
    }
    const remainingEdges = edgeLimit - inspectedEdges;
    const outgoing = yield* store.traversalEdgesForNodes(
      databasePath,
      snapshotId,
      frontier,
      'outgoing',
      remainingEdges + 1,
      allowedProvenances,
    );
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }
    adjacencyBounded ||= outgoing.length > remainingEdges;
    const next: string[] = [];
    for (const edge of outgoing.slice(0, remainingEdges)) {
      inspectedEdges += 1;
      if (!edge.sourceId || !edge.targetId || visited.has(edge.targetId)) continue;
      if (visited.size >= nodeLimit) {
        nodeBounded = true;
        continue;
      }
      visited.add(edge.targetId);
      parent.set(edge.targetId, {edge, previous: edge.sourceId});
      if (edge.targetId === target.id) {
        found = true;
        break;
      }
      if (visited.size < nodeLimit) next.push(edge.targetId);
      else nodeBounded = true;
    }
    if (found) break;
    frontier = next;
    exhaustedByDepth = currentDepth + 1 >= depth && frontier.length > 0;
  }
  if (!found) {
    const limitsReached: Array<'depth' | 'node-limit' | 'edge-limit' | 'time-budget'> = [];
    if (timedOut) limitsReached.push('time-budget');
    if (nodeBounded || (frontier.length > 0 && visited.size >= nodeLimit)) limitsReached.push('node-limit');
    if (adjacencyBounded || (frontier.length > 0 && inspectedEdges >= edgeLimit)) limitsReached.push('edge-limit');
    if (exhaustedByDepth) limitsReached.push('depth');
    const status = timedOut ? 'timed-out' : limitsReached.length > 0 ? 'bounded' : 'exhaustive';
    return {
      edges: [],
      nodes: [start, target],
      searchCoverage: coverage(status, limitsReached, visited.size, inspectedEdges, true),
      warnings: [
        timedOut
          ? 'Path search reached its elapsed-time budget; results are partial.'
          : limitsReached.length > 0
            ? `No authoritative path was found; search coverage was bounded by ${EffectArray.join(limitsReached, ', ')}. Widen the traversal limits or inspect endpoint neighbors.`
            : 'No authoritative path exists in the searched graph for the selected provenance filters.',
      ],
    };
  }
  const pathEdges: CodeGraphTraversalEdge[] = [];
  const pathIds = new Set<string>([target.id]);
  let current = target.id;
  while (current !== start.id) {
    const step = parent.get(current);
    if (!step) break;
    pathEdges.unshift(step.edge);
    pathIds.add(step.previous);
    current = step.previous;
  }
  const symbols = yield* store.symbolsByIds(databasePath, snapshotId, [...pathIds]);
  if (yield* deadlineReached(deadline)) {
    return {
      edges: [],
      nodes: [start, target],
      searchCoverage: coverage('timed-out', ['time-budget'], visited.size, inspectedEdges, true),
      warnings: ['Path search reached its elapsed-time budget; results are partial.'],
    };
  }
  const hydratedEdges = yield* store.edgesByIds(
    databasePath,
    snapshotId,
    EffectArray.map(pathEdges, edge => edge.id),
  );
  if (yield* deadlineReached(deadline)) {
    return {
      edges: [],
      nodes: [start, target],
      searchCoverage: coverage('timed-out', ['time-budget'], visited.size, inspectedEdges, true),
      warnings: ['Path search reached its elapsed-time budget; results are partial.'],
    };
  }
  const byId = new Map(EffectArray.map(symbols, symbol => [symbol.id, symbol]));
  const orderedIds = [
    start.id,
    ...EffectArray.filter(
      EffectArray.map(pathEdges, edge => edge.targetId!),
      Boolean,
    ),
  ];
  return {
    edges: hydratedEdges,
    nodes: EffectArray.filter(
      EffectArray.map(orderedIds, (id, index) => {
        const symbol = byId.get(id);
        return symbol ? {...symbol, score: 1 / (index + 1)} : undefined;
      }),
      (node): node is CodeGraphQueryNode => node !== undefined,
    ),
    searchCoverage: coverage('found', [], visited.size, inspectedEdges, true),
    warnings: [],
  };
});
