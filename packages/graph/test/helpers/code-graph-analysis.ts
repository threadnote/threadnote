import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import type {
  CodeGraphAnalysisEdgeAggregate,
  CodeGraphAnalysisEdgeAggregatePage,
  CodeGraphAnalysisSymbolAggregatePage,
  CodeGraphEdgeCursor,
  CodeGraphSymbolCursor,
} from '@threadnote/graph/store';
import type {CodeGraphAnalysisStore} from '@threadnote/graph/analysis';
import type {CodeGraphEdge, CodeGraphSnapshot, CodeGraphSymbol} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface AnalysisPagingObservation {
  readonly aggregateEdgePageLimits?: number[];
  readonly aggregateSymbolPageLimits?: number[];
  readonly edgePageLimits: number[];
  readonly symbolPageLimits: number[];
}

export function pagedAnalysisStore(
  inputSymbols: readonly CodeGraphSymbol[],
  inputEdges: readonly CodeGraphEdge[],
  observation: AnalysisPagingObservation = {edgePageLimits: [], symbolPageLimits: []},
): CodeGraphAnalysisStore {
  const symbols = [...inputSymbols].sort(compareSymbols);
  const edges = [...inputEdges].sort(compareEdges);
  const symbolsById = [...inputSymbols].sort((left, right) => compareText(left.id, right.id));
  const edgesById = [...inputEdges].sort((left, right) => compareText(left.id, right.id));
  return {
    loadAnalysisEdgeAggregatePage: (
      _databasePath: string,
      _snapshotId: string,
      cursorId: string | undefined,
      limit: number,
    ) =>
      Effect.sync(() => {
        observation.aggregateEdgePageLimits?.push(limit);
        const page = edgesById.slice(firstIdAfter(edgesById, cursorId), firstIdAfter(edgesById, cursorId) + limit);
        return edgeAggregatePage(page);
      }),
    loadAnalysisSymbolAggregatePage: (
      _databasePath: string,
      _snapshotId: string,
      cursorId: string | undefined,
      limit: number,
    ) =>
      Effect.sync(() => {
        observation.aggregateSymbolPageLimits?.push(limit);
        const page = symbolsById.slice(
          firstIdAfter(symbolsById, cursorId),
          firstIdAfter(symbolsById, cursorId) + limit,
        );
        return symbolAggregatePage(page);
      }),
    loadEdgePage: (
      _databasePath: string,
      _snapshotId: string,
      cursor: CodeGraphEdgeCursor | undefined,
      limit: number,
    ) =>
      Effect.sync(() => {
        observation.edgePageLimits.push(limit);
        return edges.slice(firstEdgeAfter(edges, cursor), firstEdgeAfter(edges, cursor) + limit);
      }),
    loadSymbolPage: (
      _databasePath: string,
      _snapshotId: string,
      cursor: CodeGraphSymbolCursor | undefined,
      limit: number,
    ) =>
      Effect.sync(() => {
        observation.symbolPageLimits.push(limit);
        return symbols.slice(firstSymbolAfter(symbols, cursor), firstSymbolAfter(symbols, cursor) + limit);
      }),
  } satisfies CodeGraphAnalysisStore;
}

function symbolAggregatePage(symbols: readonly CodeGraphSymbol[]): CodeGraphAnalysisSymbolAggregatePage {
  const grouped = new Map<string, {count: number; kind: string; language: string}>();
  for (const symbol of symbols) {
    const key = `${symbol.language}\0${symbol.kind}`;
    const current = grouped.get(key) ?? {count: 0, kind: symbol.kind, language: symbol.language};
    current.count += 1;
    grouped.set(key, current);
  }
  return {
    counts: [...grouped.values()].sort(
      (left, right) => compareText(left.language, right.language) || compareText(left.kind, right.kind),
    ),
    ...(symbols.length === 0 ? {} : {lastId: symbols.at(-1)!.id}),
    rows: symbols.length,
  };
}

function edgeAggregatePage(edges: readonly CodeGraphEdge[]): CodeGraphAnalysisEdgeAggregatePage {
  const grouped = new Map<string, MutableEdgeAggregate>();
  for (const edge of edges) {
    const key = `${edge.provenance}\0${edge.relation}`;
    const confidenceValid = Number.isFinite(edge.confidence) && edge.confidence >= 0 && edge.confidence <= 1;
    const confidence = confidenceValid ? edge.confidence : Math.max(0, Math.min(1, edge.confidence || 0));
    const current =
      grouped.get(key) ??
      ({
        confidenceHigh: 0,
        confidenceInvalid: 0,
        confidenceLow: 0,
        confidenceMedium: 0,
        confidenceTotal: 0,
        count: 0,
        lowestConfidence: confidence,
        provenance: edge.provenance,
        relation: edge.relation,
        reviewFindingCount: 0,
        selfLoopCount: 0,
        unresolvedEndpointCount: 0,
      } satisfies MutableEdgeAggregate);
    current.count += 1;
    current.confidenceTotal += confidence;
    current.lowestConfidence = Math.min(current.lowestConfidence, confidence);
    if (!confidenceValid) current.confidenceInvalid += 1;
    if (edge.confidence >= 0.9) current.confidenceHigh += 1;
    else if (edge.confidence >= 0.6) current.confidenceMedium += 1;
    else current.confidenceLow += 1;
    if (edge.sourceId === undefined || edge.targetId === undefined) current.unresolvedEndpointCount += 1;
    if (edge.sourceId !== undefined && edge.sourceId === edge.targetId) current.selfLoopCount += 1;
    if (!confidenceValid || confidence < minimumExpectedConfidence(edge.provenance)) current.reviewFindingCount += 1;
    grouped.set(key, current);
  }
  return {
    counts: [...grouped.values()].sort(
      (left, right) => compareText(left.provenance, right.provenance) || compareText(left.relation, right.relation),
    ),
    ...(edges.length === 0 ? {} : {lastId: edges.at(-1)!.id}),
    rows: edges.length,
  };
}

interface MutableEdgeAggregate extends CodeGraphAnalysisEdgeAggregate {
  confidenceHigh: number;
  confidenceInvalid: number;
  confidenceLow: number;
  confidenceMedium: number;
  confidenceTotal: number;
  count: number;
  lowestConfidence: number;
  reviewFindingCount: number;
  selfLoopCount: number;
  unresolvedEndpointCount: number;
}

function minimumExpectedConfidence(provenance: CodeGraphEdge['provenance']): number {
  switch (provenance) {
    case 'declared':
    case 'resolved':
      return 0.9;
    case 'syntactic':
      return 0.7;
    case 'heuristic':
      return 0.45;
    case 'model':
      return 0.35;
  }
}

function firstIdAfter<Value extends {readonly id: string}>(values: readonly Value[], cursorId: string | undefined) {
  return cursorId === undefined ? 0 : firstAfter(values, value => compareText(value.id, cursorId));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function analysisSnapshot(
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
): CodeGraphSnapshot {
  return {
    commit: Effect2.pipe('1', EffectString.repeat(40)),
    completedAt: '2026-07-31T00:00:00.000Z',
    dirty: false,
    edgeCount: edges.length,
    extractorSet: 'analysis-fixture',
    fileCount: new Set(EffectArray.map(symbols, symbol => symbol.path)).size,
    id: 'analysis-snapshot',
    repositoryId: 'analysis-repository',
    state: 'ready',
    symbolCount: symbols.length,
    worktreeId: 'analysis-worktree',
  };
}

export function analysisSymbol(
  id: string,
  packageName: string | undefined,
  path: string,
  overrides: Partial<CodeGraphSymbol> = {},
): CodeGraphSymbol {
  return {
    contentHash: `hash-${id}`,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    name: id,
    packageName,
    path,
    qualifiedName: id,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
    ...overrides,
  };
}

export function analysisEdge(
  id: string,
  source: CodeGraphSymbol,
  target: CodeGraphSymbol,
  relation: CodeGraphEdge['relation'] = 'calls',
  overrides: Partial<CodeGraphEdge> = {},
): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: source.path,
    evidenceSpan: source.span,
    id,
    provenance: 'resolved',
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
    ...overrides,
  };
}

function firstSymbolAfter(symbols: readonly CodeGraphSymbol[], cursor: CodeGraphSymbolCursor | undefined): number {
  return cursor === undefined ? 0 : firstAfter(symbols, symbol => compareSymbolToCursor(symbol, cursor));
}

function firstEdgeAfter(edges: readonly CodeGraphEdge[], cursor: CodeGraphEdgeCursor | undefined): number {
  return cursor === undefined ? 0 : firstAfter(edges, edge => compareEdgeToCursor(edge, cursor));
}

function firstAfter<Value>(values: readonly Value[], compareToCursor: (value: Value) => number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareToCursor(values[middle]) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function compareSymbols(left: CodeGraphSymbol, right: CodeGraphSymbol): number {
  return (
    Effect2.pipe(left.path, EffectString.localeCompare(right.path)) ||
    Effect2.pipe(left.qualifiedName, EffectString.localeCompare(right.qualifiedName)) ||
    Effect2.pipe(left.id, EffectString.localeCompare(right.id))
  );
}

function compareSymbolToCursor(symbol: CodeGraphSymbol, cursor: CodeGraphSymbolCursor): number {
  return (
    Effect2.pipe(symbol.path, EffectString.localeCompare(cursor.path)) ||
    Effect2.pipe(symbol.qualifiedName, EffectString.localeCompare(cursor.qualifiedName)) ||
    Effect2.pipe(symbol.id, EffectString.localeCompare(cursor.id))
  );
}

function compareEdges(left: CodeGraphEdge, right: CodeGraphEdge): number {
  return (
    Effect2.pipe(left.sourceName, EffectString.localeCompare(right.sourceName)) ||
    Effect2.pipe(left.relation, EffectString.localeCompare(right.relation)) ||
    Effect2.pipe(left.targetName, EffectString.localeCompare(right.targetName)) ||
    Effect2.pipe(left.id, EffectString.localeCompare(right.id))
  );
}

function compareEdgeToCursor(edge: CodeGraphEdge, cursor: CodeGraphEdgeCursor): number {
  return (
    Effect2.pipe(edge.sourceName, EffectString.localeCompare(cursor.sourceName)) ||
    Effect2.pipe(edge.relation, EffectString.localeCompare(cursor.relation)) ||
    Effect2.pipe(edge.targetName, EffectString.localeCompare(cursor.targetName)) ||
    Effect2.pipe(edge.id, EffectString.localeCompare(cursor.id))
  );
}
