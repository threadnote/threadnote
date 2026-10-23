import {Clock, Context, Effect, Layer, Option, Schema} from 'effect';
import {CodeGraphStoreBusyError} from './types.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  positiveInteger,
  resolveBudget,
  resolveLimits,
  withCodeGraphAnalysisTiming,
  type CodeGraphAnalysisOptions,
  type ResolvedCodeGraphAnalysisBudget,
  type ResolvedCodeGraphAnalysisLimits,
} from './analysis/configuration.js';
import {compareCodeUnits} from './ordering.js';
import {sanitizeCodeGraphPresentationText} from './presentation_text.js';
import type {CodeGraphEdge, CodeGraphProvenance, CodeGraphRelation, CodeGraphSymbol} from './types.js';
import type {
  CodeGraphAnalysisEdgeAggregate,
  CodeGraphAnalysisEdgeAggregatePage,
  CodeGraphAnalysisSymbolAggregatePage,
  CodeGraphAnalysisSummary,
  CodeGraphEdgeCursor,
  CodeGraphStoreShape,
  CodeGraphSymbolCursor,
} from './store.js';
import {CodeGraphStore} from './store.js';

export const CODE_GRAPH_ANALYSIS_VERSION = 3 as const;

export type {
  CodeGraphAnalysisBudget,
  CodeGraphAnalysisLimits,
  CodeGraphAnalysisOptions,
  ResolvedCodeGraphAnalysisBudget,
  ResolvedCodeGraphAnalysisLimits,
} from './analysis/configuration.js';

export interface CodeGraphAnalysisCount {
  readonly count: number;
  readonly value: string;
}

export interface CodeGraphAnalysisNodeReference {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly path: string;
  readonly qualifiedName: string;
}

export interface CodeGraphConnectedComponent {
  readonly communityCount: number;
  readonly edgeCount: number;
  readonly id: string;
  readonly label: string;
  readonly memberCount: number;
  readonly representative: CodeGraphAnalysisNodeReference;
}

export interface CodeGraphCommunity {
  readonly componentId: string;
  readonly crossCommunityIncoming: number;
  readonly crossCommunityOutgoing: number;
  readonly id: string;
  readonly internalEdgeCount: number;
  readonly label: string;
  readonly memberCount: number;
  readonly representative: CodeGraphAnalysisNodeReference;
}

export interface CodeGraphCommunityMembership {
  readonly communityId: string;
  readonly componentId: string;
  readonly node: CodeGraphAnalysisNodeReference;
}

export type CodeGraphCommunityDrillDown =
  | {
      readonly community: CodeGraphCommunity;
      readonly coverage: {
        readonly complete: boolean;
        readonly shownMemberCount: number;
        readonly totalMemberCount: number;
      };
      readonly members: readonly CodeGraphCommunityMembership[];
      readonly requestedId: string;
      readonly state: 'found';
    }
  | {
      /** A complete analysis proves absence; a partial analysis only reports that the ID was not observed. */
      readonly complete: boolean;
      readonly requestedId: string;
      readonly state: 'not-found';
    };

export interface CodeGraphHub {
  readonly classification: 'god-node' | 'hub';
  readonly communityId: string;
  readonly componentId: string;
  readonly degree: number;
  readonly degreeShare: number;
  readonly incoming: number;
  readonly node: CodeGraphAnalysisNodeReference;
  readonly outgoing: number;
  readonly zScore: number;
}

export interface CodeGraphSurprisingLink {
  readonly confidence: number;
  readonly edgeId: string;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphRelation;
  readonly score: number;
  readonly signals: {
    readonly degreeExpectation: number;
    readonly relationRarity: number;
    readonly structuralScopeBoundary: boolean;
  };
  readonly source: CodeGraphAnalysisNodeReference & {
    readonly communityId: string;
    readonly communityLabel: string;
  };
  readonly target: CodeGraphAnalysisNodeReference & {
    readonly communityId: string;
    readonly communityLabel: string;
  };
}

/**
 * A deterministic n-ary structural relationship derived from high-degree fan-in or fan-out.
 * It is derived evidence rather than a new source fact. Members are a bounded, stable sample;
 * `relationshipCount` remains the exact count from the analyzed topology pass.
 */
export interface CodeGraphStructuralRelationshipGroup {
  readonly center: CodeGraphAnalysisNodeReference;
  readonly direction: 'fan-in' | 'fan-out';
  readonly id: string;
  readonly kind: 'structural-hyperedge';
  readonly members: readonly CodeGraphAnalysisNodeReference[];
  readonly memberSampleComplete: boolean;
  readonly relationshipCount: number;
}

export type CodeGraphConfidenceBandName = 'high' | 'low' | 'medium';

export interface CodeGraphConfidenceBand {
  readonly band: CodeGraphConfidenceBandName;
  readonly count: number;
  readonly share: number;
}

export interface CodeGraphConfidenceProvenanceSummary {
  readonly averageConfidence: number;
  readonly count: number;
  readonly lowestConfidence: number;
  readonly provenance: CodeGraphProvenance;
  readonly share: number;
}

export interface CodeGraphConfidenceFinding {
  readonly confidence: number;
  readonly edgeId: string;
  readonly evidencePath: string;
  readonly expectedMinimumConfidence: number;
  readonly issues: readonly ('below-provenance-baseline' | 'invalid-confidence')[];
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphRelation;
  readonly source: {
    readonly id?: string;
    readonly name: string;
  };
  readonly target: {
    readonly id?: string;
    readonly name: string;
  };
}

export interface CodeGraphConfidenceAudit {
  readonly averageConfidence: number;
  readonly bands: readonly CodeGraphConfidenceBand[];
  readonly complete: boolean;
  readonly findingsComplete: boolean;
  readonly findings: readonly CodeGraphConfidenceFinding[];
  readonly highConfidenceThreshold: number;
  readonly invalidConfidenceEdgeCount: number;
  readonly lowConfidenceThreshold: number;
  readonly provenances: readonly CodeGraphConfidenceProvenanceSummary[];
  readonly reviewThresholds: readonly {
    readonly minimumExpectedConfidence: number;
    readonly provenance: CodeGraphProvenance;
  }[];
  readonly selectedEdgeCount: number;
  readonly summaryComplete: boolean;
  readonly unresolvedEndpointEdgeCount: number;
  readonly unresolvedEndpointShare: number;
}

export interface CodeGraphAnalysisStatistics {
  /** Relationships whose endpoints were both present in the observed topology pass. */
  readonly analyzedEdgeCount: number;
  /** Symbols retained by the observed topology pass. */
  readonly analyzedNodeCount: number;
  /** Edge rows included in the bounded aggregate pass. */
  readonly aggregatedEdgeCount: number;
  /** Symbol rows included in the bounded aggregate pass. */
  readonly aggregatedNodeCount: number;
  readonly averageDegree: number;
  readonly communityCount: number;
  readonly connectedComponentCount: number;
  readonly filteredEdgeCount: number;
  readonly isolatedNodeCount: number;
  readonly kinds: readonly CodeGraphAnalysisCount[];
  readonly languages: readonly CodeGraphAnalysisCount[];
  readonly maximumDegree: number;
  readonly provenances: readonly CodeGraphAnalysisCount[];
  readonly relations: readonly CodeGraphAnalysisCount[];
  readonly scannedEdgeCount: number;
  readonly selectedEdgeCount: number;
  readonly selfLoopCount: number;
  readonly snapshotEdgeCount: number;
  readonly snapshotNodeCount: number;
  readonly unresolvedEndpointEdgeCount: number;
}

export interface CodeGraphAnalysisCoverage {
  readonly aggregates: {
    readonly edges: {
      readonly complete: boolean;
      readonly rows: number;
      readonly source: 'paged-fallback' | 'persisted-summary';
    };
    readonly symbols: {
      readonly complete: boolean;
      readonly rows: number;
      readonly source: 'paged-fallback' | 'persisted-summary';
    };
  };
  readonly complete: boolean;
  readonly edgeMetricsComplete: boolean;
  readonly edgesComplete: boolean;
  /** Every snapshot symbol participated; false means topology is a bounded path-prefix observation. */
  readonly nodesComplete: boolean;
  readonly topology: {
    readonly complete: boolean;
    readonly state: 'complete' | 'not-requested' | 'partial' | 'unavailable';
  };
}

export interface CodeGraphAnalysisUsage {
  readonly aggregateSummaryReads: number;
  readonly aggregateEdgePageReads: number;
  readonly aggregateEdgeRows: number;
  readonly aggregateSymbolPageReads: number;
  readonly aggregateSymbolRows: number;
  readonly durationMilliseconds: number;
  readonly edgePageReads: number;
  readonly edgeVisits: number;
  readonly nodePageReads: number;
}

export class CodeGraphAnalysisDeferred extends Schema.TaggedError<CodeGraphAnalysisDeferred>()(
  'CodeGraphAnalysisDeferred',
  {message: Schema.String, reason: Schema.Literal('writer-contention')},
) {}

export interface CodeGraphAnalysisResult {
  readonly leaseCleanup?: {readonly state: 'released' | 'expiry'; readonly expiresAt: number};
  readonly projectCoverage?: import('./types.js').CodeGraphProjectCoverage;
  readonly algorithms: {
    readonly communities: 'structural-connectivity-v1';
    readonly components: 'weak-connectivity-v1';
    readonly confidenceAudit: 'bounded-provenance-confidence-v1';
    readonly hubs: 'degree-outlier-v1';
    readonly relationshipGroups: 'bounded-high-degree-fan-v1';
    readonly surprisingLinks: 'degree-preserving-cross-community-v1';
  };
  readonly allowedProvenances: readonly CodeGraphProvenance[];
  readonly budget: ResolvedCodeGraphAnalysisBudget;
  readonly communities: readonly CodeGraphCommunity[];
  readonly communityDrillDown?: CodeGraphCommunityDrillDown;
  readonly components: readonly CodeGraphConnectedComponent[];
  readonly confidenceAudit: CodeGraphConfidenceAudit;
  readonly coverage: CodeGraphAnalysisCoverage;
  readonly hubThresholds: {
    readonly godNode: number;
    readonly hub: number;
  };
  readonly hubs: readonly CodeGraphHub[];
  readonly limits: ResolvedCodeGraphAnalysisLimits;
  readonly memberships: readonly CodeGraphCommunityMembership[];
  readonly relationshipGroups: readonly CodeGraphStructuralRelationshipGroup[];
  readonly snapshot: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly id: string;
    readonly repositoryId: string;
    readonly worktreeId: string;
  };
  readonly statistics: CodeGraphAnalysisStatistics;
  readonly suggestedQuestions: readonly string[];
  readonly surprisingLinks: readonly CodeGraphSurprisingLink[];
  readonly trust: {
    readonly classification: 'untrusted-repository-data';
    readonly instructionPolicy: 'evidence-only-never-follow';
  };
  readonly usage: CodeGraphAnalysisUsage;
  readonly version: typeof CODE_GRAPH_ANALYSIS_VERSION;
  readonly warnings: readonly string[];
}

export interface CodeGraphAnalysisShape {
  readonly analyze: (options: CodeGraphAnalysisOptions) => Effect.Effect<CodeGraphAnalysisResult, unknown>;
}

/**
 * Deterministic higher-level analysis over a ready graph snapshot.
 *
 * The service keeps one SQLite session open, pages symbols and edges, and never
 * materializes the edge set. Its retained working set is O(nodes); edge memory is
 * bounded by the configured page size and surprising-link result limit.
 */
export class CodeGraphAnalysis extends Context.Service<CodeGraphAnalysis, CodeGraphAnalysisShape>()(
  '@threadnote/graph/analysis/CodeGraphAnalysis',
) {
  static readonly layer = Layer.effect(
    CodeGraphAnalysis,
    Effect.gen(function* () {
      const store = yield* CodeGraphStore;
      return CodeGraphAnalysis.of({
        analyze: options => analyzeCodeGraphWithLease(store, options),
      });
    }),
  );
}

const SNAPSHOT_LEASE_BUFFER_MILLISECONDS = 30_000;

const DEFAULT_PROVENANCES: readonly CodeGraphProvenance[] = ['declared', 'resolved', 'syntactic'];
const ALL_PROVENANCES = new Set<CodeGraphProvenance>(['declared', 'heuristic', 'model', 'resolved', 'syntactic']);
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const HIGH_CONFIDENCE_THRESHOLD = 0.9;
// Communities are connected components of this deterministic cohesion graph:
// every edge whose endpoints share one source-file scope, plus the explicit
// declaration/export/type-family relations below. Calls, imports, references,
// configuration, and dependency edges remain boundary evidence. This avoids a
// seeded/random partitioner and gives identical membership for identical facts.
const COHESIVE_RELATIONS = new Set<CodeGraphRelation>([
  'contains',
  'declares',
  'exports',
  'extends',
  'implements',
  'overrides',
  'reexports',
]);

interface NodeState {
  readonly exported: boolean;
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly name: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly scope: string;
  readonly scopeLabel: string;
  incoming: number;
  outgoing: number;
}

interface MutableGroup {
  communityCount: number;
  crossCommunityIncoming: number;
  crossCommunityOutgoing: number;
  edgeCount: number;
  internalEdgeCount: number;
  memberCount: number;
  minimumNodeId: string;
  representativeIndex: number;
}

interface EdgeScanResult {
  readonly pageReads: number;
  readonly reachedEnd: boolean;
  readonly timedOut: boolean;
  readonly visits: number;
}

interface AggregateScanResult {
  readonly pageReads: number;
  readonly reachedEnd: boolean;
  readonly rows: number;
  readonly timedOut: boolean;
}

interface SymbolAggregateAccumulator {
  readonly kindCounts: Map<string, number>;
  readonly languageCounts: Map<string, number>;
  rows: number;
}

interface EdgeAggregateAccumulator {
  readonly confidenceBands: Map<CodeGraphConfidenceBandName, number>;
  readonly confidenceByProvenance: Map<CodeGraphProvenance, MutableConfidenceSummary>;
  readonly provenanceCounts: Map<string, number>;
  readonly relationCounts: Map<string, number>;
  confidenceTotal: number;
  filteredEdges: number;
  invalidConfidenceEdgeCount: number;
  reviewFindingCount: number;
  rows: number;
  selectedEdges: number;
  selfLoops: number;
  unresolvedEndpointEdges: number;
}

interface AnalysisCounters {
  analyzedEdges: number;
  filteredEdges: number;
  selectedEdges: number;
  selfLoops: number;
  unresolvedEndpointEdges: number;
}

interface MutableConfidenceSummary {
  count: number;
  lowest: number;
  total: number;
}

interface StructuralRelationshipGroupCandidate {
  readonly centerIndex: number;
  readonly direction: CodeGraphStructuralRelationshipGroup['direction'];
  readonly relationshipCount: number;
}

interface MutableStructuralRelationshipGroup extends StructuralRelationshipGroupCandidate {
  readonly members: CodeGraphAnalysisNodeReference[];
}

/**
 * Production analysis entry point. A ready snapshot is leased before opening the
 * paged read session so maintenance cannot prune it while a long analysis is in flight.
 */
export const analyzeCodeGraphWithLease = Effect.fn('codeGraph.analyzeWithSnapshotLease')(function* (
  store: CodeGraphStoreShape,
  options: CodeGraphAnalysisOptions,
) {
  const budget = resolveBudget(options.budget, options.snapshot);
  const leaseDuration = Math.min(
    60 * 60_000,
    Math.max(2 * 60_000, budget.maxDurationMilliseconds + SNAPSHOT_LEASE_BUFFER_MILLISECONDS),
  );
  const startedAt = yield* Clock.currentTimeMillis;
  let released = false;
  let leaseExpiresAt = startedAt + leaseDuration;
  const result = yield* Effect.acquireUseRelease(
    withCodeGraphAnalysisTiming(
      options.onTiming,
      'lease-acquire',
      store.acquireSnapshotLease(options.databasePath, options.snapshot.id, leaseDuration, {
        waitTimeoutMilliseconds: 0,
        ...(options.onLeaseTiming
          ? {onTiming: (stage, boundary) => options.onLeaseTiming!('acquire', stage, boundary)}
          : {}),
      }),
    ).pipe(
      Effect.tap(() =>
        Clock.currentTimeMillis.pipe(
          Effect.tap(now =>
            Effect.sync(() => {
              leaseExpiresAt = now + leaseDuration;
            }),
          ),
        ),
      ),
      Effect.catchIf(Schema.is(CodeGraphStoreBusyError), () =>
        Effect.fail(
          CodeGraphAnalysisDeferred.make({
            message: 'Analysis is deferred because the snapshot lease writer gate is busy. Retry shortly.',
            reason: 'writer-contention',
          }),
        ),
      ),
    ),
    () =>
      withCodeGraphAnalysisTiming(
        options.onTiming,
        'read-session',
        store.withSession(
          options.databasePath,
          analyzeCodeGraph(store, {
            ...options,
            deadlineMilliseconds: options.deadlineMilliseconds ?? startedAt + budget.maxDurationMilliseconds,
          }),
          {readOnly: true},
        ),
      ),
    lease =>
      withCodeGraphAnalysisTiming(
        options.onTiming,
        'lease-release',
        store.releaseSnapshotLease(options.databasePath, lease, {
          waitTimeoutMilliseconds: 0,
          ...(options.onLeaseTiming
            ? {onTiming: (stage, boundary) => options.onLeaseTiming!('release', stage, boundary)}
            : {}),
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            released = true;
          }),
        ),
        Effect.catch(() => Effect.logWarning('Code graph analysis lease cleanup deferred to bounded expiry.')),
      ),
  );
  return {
    ...result,
    leaseCleanup: {state: released ? 'released' : 'expiry', expiresAt: leaseExpiresAt},
  } satisfies CodeGraphAnalysisResult;
});

export const analyzeCodeGraph = Effect.fn('codeGraph.analyze')(function* (
  store: CodeGraphStoreShape,
  options: CodeGraphAnalysisOptions,
) {
  const budget = resolveBudget(options.budget, options.snapshot);
  const limits = resolveLimits(options.limits);
  const allowedProvenances = resolveProvenances(options.allowedProvenances);
  const allowed = new Set(allowedProvenances);
  const startedAt = yield* Clock.currentTimeMillis;
  const deadline = Math.min(options.deadlineMilliseconds ?? Infinity, startedAt + budget.maxDurationMilliseconds);
  const symbolAggregates = makeSymbolAggregateAccumulator();
  const edgeAggregates = makeEdgeAggregateAccumulator();
  const persistedSummary =
    typeof store.loadAnalysisSummary === 'function'
      ? yield* store.loadAnalysisSummary(options.databasePath, options.snapshot.id)
      : Option.none<CodeGraphAnalysisSummary>();
  if (Option.isSome(persistedSummary)) {
    mergePersistedAnalysisSummary(symbolAggregates, edgeAggregates, persistedSummary.value, allowed);
  }
  const persistedAggregateSource = Option.isSome(persistedSummary);
  const symbolPageAggregateSupported = typeof store.loadAnalysisSymbolAggregatePage === 'function';
  const edgePageAggregateSupported = typeof store.loadAnalysisEdgeAggregatePage === 'function';
  const symbolAggregateSupported = persistedAggregateSource || symbolPageAggregateSupported;
  const edgeAggregateSupported = persistedAggregateSource || edgePageAggregateSupported;
  const symbolAggregateScan = persistedAggregateSource
    ? completeAggregateScan(persistedSummary.value.symbolCount)
    : symbolPageAggregateSupported
      ? yield* scanSymbolAggregatePages(
          store,
          options,
          budget.aggregatePageSize,
          Math.min(budget.maxNodes, options.snapshot.symbolCount),
          deadline,
          symbolAggregates,
        )
      : emptyAggregateScan(false);
  const edgeAggregateScan = persistedAggregateSource
    ? completeAggregateScan(persistedSummary.value.edgeCount)
    : edgePageAggregateSupported
      ? yield* scanEdgeAggregatePages(
          store,
          options,
          budget.aggregatePageSize,
          Math.min(budget.maxEdges, options.snapshot.edgeCount),
          deadline,
          allowed,
          edgeAggregates,
        )
      : emptyAggregateScan(false);
  const needsTopology =
    limits.communities > 0 ||
    limits.components > 0 ||
    limits.hubs > 0 ||
    limits.memberships > 0 ||
    limits.relationshipGroups > 0 ||
    limits.surprisingLinks > 0 ||
    options.communityId !== undefined;
  const needsConfidenceFindingScan = limits.confidenceFindings > 0;
  const aggregateFinishedAt = yield* Clock.currentTimeMillis;
  const topologyNodeDeadline = needsTopology
    ? aggregateFinishedAt + Math.floor(Math.max(0, deadline - aggregateFinishedAt) / 2)
    : aggregateFinishedAt;
  const nodes: NodeState[] = [];
  const nodeIndex = new Map<string, number>();
  const topologyLanguageCounts = new Map<string, number>();
  const topologyKindCounts = new Map<string, number>();
  const componentSets = new DisjointSets();
  const communitySets = new DisjointSets();
  let nodePageReads = 0;
  let symbolCursor: CodeGraphSymbolCursor | undefined;

  while (needsTopology && nodes.length < budget.maxNodes) {
    if (yield* deadlineReached(topologyNodeDeadline)) {
      break;
    }
    const remaining = budget.maxNodes - nodes.length;
    const requested = Math.min(budget.pageSize, remaining);
    const page = yield* store.loadSymbolPage(options.databasePath, options.snapshot.id, symbolCursor, requested);
    nodePageReads += 1;
    if (page.length === 0) {
      break;
    }
    for (const symbol of page) {
      if (nodeIndex.has(symbol.id)) continue;
      const index = nodes.length;
      nodeIndex.set(symbol.id, index);
      nodes.push(nodeState(symbol));
      componentSets.add();
      communitySets.add();
      increment(topologyLanguageCounts, symbol.language);
      increment(topologyKindCounts, symbol.kind);
      if (nodes.length >= budget.maxNodes) break;
    }
    const last = page.at(-1)!;
    symbolCursor = {id: last.id, path: last.path, qualifiedName: last.qualifiedName};
    yield* Effect.yieldNow;
    if (page.length < requested) {
      break;
    }
  }

  const nodesComplete = needsTopology && nodes.length >= options.snapshot.symbolCount;
  const relationCounts = edgeAggregateSupported ? new Map(edgeAggregates.relationCounts) : new Map<string, number>();
  const provenanceCounts = edgeAggregateSupported
    ? new Map(edgeAggregates.provenanceCounts)
    : new Map<string, number>();
  const counters: AnalysisCounters = {
    analyzedEdges: 0,
    filteredEdges: edgeAggregateSupported ? edgeAggregates.filteredEdges : 0,
    selectedEdges: edgeAggregateSupported ? edgeAggregates.selectedEdges : 0,
    selfLoops: edgeAggregateSupported ? edgeAggregates.selfLoops : 0,
    unresolvedEndpointEdges: edgeAggregateSupported ? edgeAggregates.unresolvedEndpointEdges : 0,
  };
  const confidenceBands = edgeAggregateSupported ? new Map(edgeAggregates.confidenceBands) : emptyConfidenceBands();
  const confidenceByProvenance = edgeAggregateSupported
    ? cloneConfidenceSummaries(edgeAggregates.confidenceByProvenance)
    : new Map<CodeGraphProvenance, MutableConfidenceSummary>();
  const confidenceFindings: CodeGraphConfidenceFinding[] = [];
  let confidenceFindingCandidateCount = edgeAggregateSupported ? edgeAggregates.reviewFindingCount : 0;
  let confidenceTotal = edgeAggregateSupported ? edgeAggregates.confidenceTotal : 0;
  let invalidConfidenceEdgeCount = edgeAggregateSupported ? edgeAggregates.invalidConfidenceEdgeCount : 0;
  const firstEdgeBudget = Math.min(budget.maxEdges, budget.maxEdgeVisits);
  // A non-empty bounded node prefix can still support an honest partial topology
  // observation. Coverage keeps nodesComplete=false, so none of its connectivity
  // or degree observations can be mistaken for whole-graph conclusions.
  const topologyEnabled = needsTopology && (nodesComplete || nodes.length > 0);
  const needsPrimaryEdgeScan = topologyEnabled || needsConfidenceFindingScan;
  const topologyScan = !needsPrimaryEdgeScan
    ? emptyEdgeScan(false)
    : yield* scanEdgePages(store, options, budget.pageSize, firstEdgeBudget, deadline, edge => {
        if (!allowed.has(edge.provenance)) {
          if (!edgeAggregateSupported) counters.filteredEdges += 1;
          return;
        }
        if (!edgeAggregateSupported) {
          counters.selectedEdges += 1;
          increment(provenanceCounts, edge.provenance);
          increment(relationCounts, edge.relation);
        }
        const sourceIndex = edge.sourceId === undefined ? undefined : nodeIndex.get(edge.sourceId);
        const targetIndex = edge.targetId === undefined ? undefined : nodeIndex.get(edge.targetId);
        const confidenceValid = Number.isFinite(edge.confidence) && edge.confidence >= 0 && edge.confidence <= 1;
        const confidence = confidenceValid ? edge.confidence : Math.max(0, Math.min(1, edge.confidence || 0));
        if (!edgeAggregateSupported) {
          if (!confidenceValid) invalidConfidenceEdgeCount += 1;
          confidenceTotal += confidence;
          increment(confidenceBands, confidenceBand(confidence));
          const provenanceSummary = confidenceByProvenance.get(edge.provenance) ?? {
            count: 0,
            lowest: confidence,
            total: 0,
          };
          provenanceSummary.count += 1;
          provenanceSummary.lowest = Math.min(provenanceSummary.lowest, confidence);
          provenanceSummary.total += confidence;
          confidenceByProvenance.set(edge.provenance, provenanceSummary);
        }
        const expectedMinimumConfidence = minimumExpectedConfidence(edge.provenance);
        const confidenceIssues: CodeGraphConfidenceFinding['issues'][number][] = [];
        if (!confidenceValid) confidenceIssues.push('invalid-confidence');
        if (confidence < expectedMinimumConfidence) confidenceIssues.push('below-provenance-baseline');
        if (confidenceIssues.length > 0) {
          if (!edgeAggregateSupported) confidenceFindingCandidateCount += 1;
          retainBestDistinct(
            confidenceFindings,
            {
              confidence,
              edgeId: edge.id,
              evidencePath: edge.evidencePath,
              expectedMinimumConfidence,
              issues: confidenceIssues,
              provenance: edge.provenance,
              relation: edge.relation,
              source: {
                ...(edge.sourceId === undefined ? {} : {id: sanitizeCodeGraphPresentationText(edge.sourceId)}),
                name: sanitizeCodeGraphPresentationText(edge.sourceName),
              },
              target: {
                ...(edge.targetId === undefined ? {} : {id: sanitizeCodeGraphPresentationText(edge.targetId)}),
                name: sanitizeCodeGraphPresentationText(edge.targetName),
              },
            },
            limits.confidenceFindings,
            compareConfidenceFindings,
            finding => finding.edgeId,
          );
        }
        if (!topologyEnabled) return;
        if (sourceIndex === undefined || targetIndex === undefined) {
          if (!edgeAggregateSupported) counters.unresolvedEndpointEdges += 1;
          return;
        }
        counters.analyzedEdges += 1;
        const source = nodes[sourceIndex];
        const target = nodes[targetIndex];
        source.outgoing += 1;
        target.incoming += 1;
        componentSets.union(sourceIndex, targetIndex);
        if (source.scope === target.scope || COHESIVE_RELATIONS.has(edge.relation)) {
          communitySets.union(sourceIndex, targetIndex);
        }
        if (!edgeAggregateSupported && sourceIndex === targetIndex) counters.selfLoops += 1;
      });
  const edgesComplete =
    topologyEnabled && (topologyScan.visits >= options.snapshot.edgeCount || options.snapshot.edgeCount === 0);
  const confidenceFindingsComplete =
    !needsConfidenceFindingScan ||
    topologyScan.reachedEnd ||
    topologyScan.visits >= options.snapshot.edgeCount ||
    options.snapshot.edgeCount === 0;
  const observedTopologyNodeCount = nodes.length;

  const componentGroups = new Map<number, MutableGroup>();
  const communityGroups = new Map<number, MutableGroup>();
  const componentRootByNode = new Array<number>(nodes.length);
  const communityRootByNode = new Array<number>(nodes.length);
  let postprocessIndex: number;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    componentRootByNode[index] = componentSets.find(index);
    communityRootByNode[index] = communitySets.find(index);
    updateGroup(componentGroups, componentRootByNode[index], node, index, nodes);
    updateGroup(communityGroups, communityRootByNode[index], node, index, nodes);
    if (isCooperativeCheckpoint(index)) yield* Effect.yieldNow;
  }
  postprocessIndex = 0;
  for (const group of communityGroups.values()) {
    const componentRoot = componentRootByNode[group.representativeIndex];
    componentGroups.get(componentRoot)!.communityCount += 1;
    if (isCooperativeCheckpoint(postprocessIndex++)) yield* Effect.yieldNow;
  }

  const componentIds = new Map<number, string>();
  const communityLabels = new Map<number, string>();
  const componentLabels = new Map<number, string>();
  const needsComponentIds =
    limits.components > 0 ||
    limits.communities > 0 ||
    limits.hubs > 0 ||
    limits.memberships > 0 ||
    limits.surprisingLinks > 0 ||
    options.communityId !== undefined;
  const needsCommunityIds =
    limits.communities > 0 ||
    limits.hubs > 0 ||
    limits.memberships > 0 ||
    limits.surprisingLinks > 0 ||
    options.communityId !== undefined;
  if (needsComponentIds) {
    postprocessIndex = 0;
    for (const [root, group] of componentGroups) {
      componentIds.set(root, groupId(group, 'connected-component-v1', 'cgcc'));
      if (limits.components > 0) {
        componentLabels.set(root, componentLabel(nodes[group.representativeIndex], group.memberCount));
      }
      if (isCooperativeCheckpoint(postprocessIndex++)) yield* Effect.yieldNow;
    }
  }
  const communityIds = new Map<number, string>();
  if (needsCommunityIds) {
    postprocessIndex = 0;
    for (const [root, group] of communityGroups) {
      communityIds.set(root, groupId(group, 'community-v1', 'cgc'));
      if (limits.communities > 0 || limits.surprisingLinks > 0 || options.communityId !== undefined) {
        communityLabels.set(root, communityLabel(nodes[group.representativeIndex], group.memberCount));
      }
      if (isCooperativeCheckpoint(postprocessIndex++)) yield* Effect.yieldNow;
    }
  }

  const averageDegree = nodes.length === 0 ? 0 : (counters.analyzedEdges * 2) / nodes.length;
  let degreeVarianceTotal = 0;
  let isolatedNodeCount = 0;
  let maximumDegree = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const degree = nodes[index].incoming + nodes[index].outgoing;
    degreeVarianceTotal += (degree - averageDegree) ** 2;
    maximumDegree = Math.max(maximumDegree, degree);
    if (degree === 0) isolatedNodeCount += 1;
    if (isCooperativeCheckpoint(index)) yield* Effect.yieldNow;
  }
  const standardDeviation = Math.sqrt(nodes.length === 0 ? 0 : degreeVarianceTotal / nodes.length);
  const hubThreshold = Math.max(
    positiveInteger(options.minimumHubDegree, 2, 1, 1_000_000),
    Math.ceil(averageDegree + standardDeviation * 1.5),
  );
  const godNodeThreshold = Math.max(
    positiveInteger(options.minimumGodNodeDegree, 6, 1, 1_000_000),
    hubThreshold + 1,
    Math.ceil(averageDegree + standardDeviation * 3),
  );
  const hubs: CodeGraphHub[] = [];
  const relationshipGroupCandidates: StructuralRelationshipGroupCandidate[] = [];
  let hubCandidateCount = 0;
  let relationshipGroupCandidateCount = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const degree = node.incoming + node.outgoing;
    if (degree >= hubThreshold) {
      if (limits.hubs > 0) {
        hubCandidateCount += 1;
        retainBest(
          hubs,
          {
            classification: degree >= godNodeThreshold ? 'god-node' : 'hub',
            communityId: communityIds.get(communityRootByNode[index])!,
            componentId: componentIds.get(componentRootByNode[index])!,
            degree,
            degreeShare: stableNumber(degree / Math.max(1, counters.analyzedEdges * 2)),
            incoming: node.incoming,
            node: nodeReference(node),
            outgoing: node.outgoing,
            zScore: stableNumber(standardDeviation === 0 ? 0 : (degree - averageDegree) / standardDeviation),
          },
          limits.hubs,
          compareHubs,
        );
      }
    }
    if (limits.relationshipGroups > 0 && node.incoming >= hubThreshold) {
      relationshipGroupCandidateCount += 1;
      retainBest(
        relationshipGroupCandidates,
        {
          centerIndex: index,
          direction: 'fan-in',
          relationshipCount: node.incoming,
        } satisfies StructuralRelationshipGroupCandidate,
        limits.relationshipGroups,
        (left, right) => compareStructuralGroupCandidates(left, right, nodes),
      );
    }
    if (limits.relationshipGroups > 0 && node.outgoing >= hubThreshold) {
      relationshipGroupCandidateCount += 1;
      retainBest(
        relationshipGroupCandidates,
        {
          centerIndex: index,
          direction: 'fan-out',
          relationshipCount: node.outgoing,
        } satisfies StructuralRelationshipGroupCandidate,
        limits.relationshipGroups,
        (left, right) => compareStructuralGroupCandidates(left, right, nodes),
      );
    }
    if (isCooperativeCheckpoint(index)) yield* Effect.yieldNow;
  }

  const mutableRelationshipGroups: MutableStructuralRelationshipGroup[] = relationshipGroupCandidates.map(
    candidate => ({...candidate, members: []}),
  );
  const fanInGroups = new Map<number, MutableStructuralRelationshipGroup>();
  const fanOutGroups = new Map<number, MutableStructuralRelationshipGroup>();
  for (const group of mutableRelationshipGroups) {
    (group.direction === 'fan-in' ? fanInGroups : fanOutGroups).set(group.centerIndex, group);
  }

  const remainingEdgeVisits = Math.max(0, budget.maxEdgeVisits - topologyScan.visits);
  const metricScanLimit = Math.min(topologyScan.visits, remainingEdgeVisits);
  const surprisingLinks: CodeGraphSurprisingLink[] = [];
  const needsMetricScan =
    limits.communities > 0 ||
    limits.components > 0 ||
    mutableRelationshipGroups.length > 0 ||
    limits.surprisingLinks > 0 ||
    options.communityId !== undefined;
  const metricScan =
    !needsMetricScan || !topologyEnabled || metricScanLimit === 0
      ? emptyEdgeScan(false)
      : yield* scanEdgePages(store, options, budget.pageSize, metricScanLimit, deadline, edge => {
          if (!allowed.has(edge.provenance)) return;
          const sourceIndex = edge.sourceId === undefined ? undefined : nodeIndex.get(edge.sourceId);
          const targetIndex = edge.targetId === undefined ? undefined : nodeIndex.get(edge.targetId);
          if (sourceIndex === undefined || targetIndex === undefined) return;
          const componentRoot = componentRootByNode[sourceIndex];
          componentGroups.get(componentRoot)!.edgeCount += 1;
          const sourceCommunityRoot = communityRootByNode[sourceIndex];
          const targetCommunityRoot = communityRootByNode[targetIndex];
          const fanOutGroup = fanOutGroups.get(sourceIndex);
          if (fanOutGroup && sourceIndex !== targetIndex) {
            retainBestDistinct(
              fanOutGroup.members,
              nodeReference(nodes[targetIndex]),
              limits.relationshipGroupMembers,
              compareNodeReferences,
              member => member.id,
            );
          }
          const fanInGroup = fanInGroups.get(targetIndex);
          if (fanInGroup && sourceIndex !== targetIndex) {
            retainBestDistinct(
              fanInGroup.members,
              nodeReference(nodes[sourceIndex]),
              limits.relationshipGroupMembers,
              compareNodeReferences,
              member => member.id,
            );
          }
          if (sourceCommunityRoot === targetCommunityRoot) {
            communityGroups.get(sourceCommunityRoot)!.internalEdgeCount += 1;
            return;
          }
          communityGroups.get(sourceCommunityRoot)!.crossCommunityOutgoing += 1;
          communityGroups.get(targetCommunityRoot)!.crossCommunityIncoming += 1;
          if (limits.surprisingLinks === 0) return;
          const source = nodes[sourceIndex];
          const target = nodes[targetIndex];
          const relationCount = relationCounts.get(edge.relation) ?? 1;
          const relationRarity = Math.log1p(counters.analyzedEdges / relationCount);
          const sourceDegree = source.incoming + source.outgoing;
          const targetDegree = target.incoming + target.outgoing;
          const degreeExpectation = Math.log1p(
            Math.max(1, counters.analyzedEdges * 2) / Math.max(1, sourceDegree * targetDegree),
          );
          const scopeBoundary = source.scope !== target.scope;
          const score = stableNumber(
            edge.confidence *
              provenanceWeight(edge.provenance) *
              relationWeight(edge.relation) *
              relationRarity *
              degreeExpectation *
              (scopeBoundary ? 1.25 : 1),
          );
          retainBestDistinct(
            surprisingLinks,
            {
              confidence: edge.confidence,
              edgeId: edge.id,
              provenance: edge.provenance,
              relation: edge.relation,
              score,
              signals: {
                degreeExpectation: stableNumber(degreeExpectation),
                relationRarity: stableNumber(relationRarity),
                structuralScopeBoundary: scopeBoundary,
              },
              source: {
                ...nodeReference(source),
                communityId: communityIds.get(sourceCommunityRoot)!,
                communityLabel: communityLabels.get(sourceCommunityRoot)!,
              },
              target: {
                ...nodeReference(target),
                communityId: communityIds.get(targetCommunityRoot)!,
                communityLabel: communityLabels.get(targetCommunityRoot)!,
              },
            },
            limits.surprisingLinks,
            compareSurprisingLinks,
            surprisingCommunityPair,
          );
        });

  const edgeMetricsComplete =
    !needsMetricScan ||
    (edgesComplete &&
      metricScanLimit >= topologyScan.visits &&
      (metricScan.reachedEnd || metricScan.visits >= topologyScan.visits));
  const aggregatedNodeCount = symbolAggregateSupported ? symbolAggregateScan.rows : observedTopologyNodeCount;
  const aggregatedEdgeCount = edgeAggregateSupported ? edgeAggregateScan.rows : topologyScan.visits;
  const symbolAggregatesComplete = symbolAggregateSupported
    ? aggregatedNodeCount >= options.snapshot.symbolCount || options.snapshot.symbolCount === 0
    : nodesComplete;
  const edgeAggregatesComplete = edgeAggregateSupported
    ? aggregatedEdgeCount >= options.snapshot.edgeCount || options.snapshot.edgeCount === 0
    : edgesComplete;
  const topologyComplete = !needsTopology || (nodesComplete && edgesComplete && edgeMetricsComplete);
  const topologyState: CodeGraphAnalysisCoverage['topology']['state'] = !needsTopology
    ? 'not-requested'
    : !topologyEnabled
      ? 'unavailable'
      : topologyComplete
        ? 'complete'
        : 'partial';

  const components: CodeGraphConnectedComponent[] = [];
  if (limits.components > 0) {
    postprocessIndex = 0;
    for (const [root, group] of componentGroups) {
      retainBest(
        components,
        componentResult(root, group, componentIds, componentLabels, nodes),
        limits.components,
        compareGroups,
      );
      if (isCooperativeCheckpoint(postprocessIndex++)) yield* Effect.yieldNow;
    }
  }
  const communities: CodeGraphCommunity[] = [];
  let requestedCommunityRoot: number | undefined;
  if (limits.communities > 0 || options.communityId !== undefined) {
    postprocessIndex = 0;
    for (const [root, group] of communityGroups) {
      const id = communityIds.get(root)!;
      if (id === options.communityId) requestedCommunityRoot = root;
      if (limits.communities > 0) {
        retainBest(
          communities,
          communityResult(root, group, componentRootByNode, componentIds, communityIds, communityLabels, nodes),
          limits.communities,
          compareGroups,
        );
      }
      if (isCooperativeCheckpoint(postprocessIndex++)) yield* Effect.yieldNow;
    }
  }

  const memberships: CodeGraphCommunityMembership[] = [];
  const requestedMembers: CodeGraphCommunityMembership[] = [];
  if (limits.memberships > 0 || requestedCommunityRoot !== undefined) {
    for (let index = 0; index < nodes.length; index += 1) {
      const membership = communityMembership(
        index,
        nodes,
        componentRootByNode,
        communityRootByNode,
        componentIds,
        communityIds,
      );
      retainBest(memberships, membership, limits.memberships, compareMemberships);
      if (communityRootByNode[index] === requestedCommunityRoot) {
        retainBest(requestedMembers, membership, limits.communityMembers, compareMemberships);
      }
      if (isCooperativeCheckpoint(index)) yield* Effect.yieldNow;
    }
  }

  const communityDrillDown =
    options.communityId === undefined
      ? undefined
      : requestedCommunityRoot === undefined
        ? ({
            complete: nodesComplete && edgesComplete,
            requestedId: options.communityId,
            state: 'not-found',
          } satisfies CodeGraphCommunityDrillDown)
        : ({
            community: communityResult(
              requestedCommunityRoot,
              communityGroups.get(requestedCommunityRoot)!,
              componentRootByNode,
              componentIds,
              communityIds,
              communityLabels,
              nodes,
            ),
            coverage: {
              complete:
                nodesComplete &&
                edgesComplete &&
                requestedMembers.length === communityGroups.get(requestedCommunityRoot)!.memberCount,
              shownMemberCount: requestedMembers.length,
              totalMemberCount: communityGroups.get(requestedCommunityRoot)!.memberCount,
            },
            members: requestedMembers,
            requestedId: options.communityId,
            state: 'found',
          } satisfies CodeGraphCommunityDrillDown);

  const relationshipGroups: CodeGraphStructuralRelationshipGroup[] = mutableRelationshipGroups.map(group => ({
    center: nodeReference(nodes[group.centerIndex]),
    direction: group.direction,
    id: structuralRelationshipGroupId(nodes[group.centerIndex], group.direction),
    kind: 'structural-hyperedge',
    members: group.members,
    memberSampleComplete: edgeMetricsComplete && group.relationshipCount <= limits.relationshipGroupMembers,
    relationshipCount: group.relationshipCount,
  }));

  const finishedAt = yield* Clock.currentTimeMillis;
  const warnings: string[] = [];
  if (!persistedAggregateSource && (symbolPageAggregateSupported || edgePageAggregateSupported)) {
    warnings.push(
      'Whole-graph counts used the bounded legacy page fallback; run graph index once to persist the fast summary.',
    );
  }
  if (!symbolAggregatesComplete) {
    warnings.push(
      `Symbol aggregates cover ${aggregatedNodeCount.toLocaleString()} of ${options.snapshot.symbolCount.toLocaleString()} rows; counts are observed, not whole-graph totals.`,
    );
  }
  if (!edgeAggregatesComplete) {
    warnings.push(
      `Relationship aggregates cover ${aggregatedEdgeCount.toLocaleString()} of ${options.snapshot.edgeCount.toLocaleString()} rows; counts are observed, not whole-graph totals.`,
    );
  }
  if (needsTopology && !nodesComplete) {
    warnings.push(
      topologyEnabled
        ? edgesComplete
          ? `Topology is a bounded path-prefix induced subgraph over ${observedTopologyNodeCount.toLocaleString()} of ${options.snapshot.symbolCount.toLocaleString()} symbols. Connectivity, degree, isolation, hub, component, community, and absence claims apply only to retained nodes.`
          : `Topology is a bounded observation over a path-prefix node set (${observedTopologyNodeCount.toLocaleString()} of ${options.snapshot.symbolCount.toLocaleString()} symbols) and the relationship rows that fit the edge/time budget. Connectivity, degree, isolation, hub, component, community, and absence claims are not whole-graph conclusions.`
        : `Topology was not derived because none of ${options.snapshot.symbolCount.toLocaleString()} symbols fit the node/time budget.`,
    );
  }
  if (needsTopology && topologyEnabled && !edgesComplete)
    warnings.push(
      'Topology relationship analysis reached its configured edge or elapsed-time budget; topology is partial.',
    );
  if (needsTopology && topologyEnabled && !edgeMetricsComplete) {
    warnings.push(
      'Community edge metrics, structural relationship groups, and surprising links reached their configured visit or elapsed-time budget.',
    );
  }
  if (!confidenceFindingsComplete) {
    warnings.push(
      'Confidence summary counts are aggregate-backed, but individual review findings are a bounded sample.',
    );
  }
  if (limits.components > 0 && componentGroups.size > limits.components) {
    warnings.push(`Showing ${limits.components} of ${componentGroups.size} connected components.`);
  }
  if (limits.communities > 0 && communityGroups.size > limits.communities) {
    warnings.push(`Showing ${limits.communities} of ${communityGroups.size} communities.`);
  }
  if (limits.memberships > 0 && nodes.length > limits.memberships) {
    warnings.push(`Showing ${limits.memberships} of ${nodes.length} community memberships.`);
  }
  if (limits.confidenceFindings > 0 && confidenceFindingCandidateCount > limits.confidenceFindings) {
    warnings.push(
      `Showing ${limits.confidenceFindings} of ${confidenceFindingCandidateCount} confidence-audit findings.`,
    );
  }
  if (limits.hubs > 0 && hubCandidateCount > limits.hubs) {
    warnings.push(`Showing ${limits.hubs} of ${hubCandidateCount} hubs.`);
  }
  if (limits.relationshipGroups > 0 && relationshipGroupCandidateCount > limits.relationshipGroups) {
    warnings.push(
      `Showing ${limits.relationshipGroups} of ${relationshipGroupCandidateCount} structural relationship groups.`,
    );
  }
  if (relationshipGroups.some(group => !group.memberSampleComplete)) {
    warnings.push('Structural relationship-group members are bounded samples; relationship counts remain exact.');
  }
  if (communityDrillDown?.state === 'not-found' && !communityDrillDown.complete) {
    warnings.push(
      `Community ${communityDrillDown.requestedId} was not observed in this partial analysis; retry with a larger time or scan budget.`,
    );
  }
  if (communityDrillDown?.state === 'found' && !communityDrillDown.coverage.complete) {
    warnings.push(
      `Showing ${communityDrillDown.coverage.shownMemberCount} of ${communityDrillDown.coverage.totalMemberCount} members for ${communityDrillDown.requestedId}.`,
    );
  }

  const confidenceAudit: CodeGraphConfidenceAudit = {
    averageConfidence: stableNumber(confidenceTotal / Math.max(1, counters.selectedEdges)),
    bands: (['high', 'medium', 'low'] as const).map(band => ({
      band,
      count: confidenceBands.get(band) ?? 0,
      share: stableNumber((confidenceBands.get(band) ?? 0) / Math.max(1, counters.selectedEdges)),
    })),
    complete: edgeAggregatesComplete && confidenceFindingsComplete,
    findingsComplete: confidenceFindingsComplete,
    findings: confidenceFindings,
    highConfidenceThreshold: HIGH_CONFIDENCE_THRESHOLD,
    invalidConfidenceEdgeCount,
    lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
    provenances: [...confidenceByProvenance]
      .map(([provenance, summary]): CodeGraphConfidenceProvenanceSummary => ({
        averageConfidence: stableNumber(summary.total / summary.count),
        count: summary.count,
        lowestConfidence: stableNumber(summary.lowest),
        provenance,
        share: stableNumber(summary.count / Math.max(1, counters.selectedEdges)),
      }))
      .sort((left, right) => right.count - left.count || compareCodeUnits(left.provenance, right.provenance)),
    reviewThresholds: allowedProvenances.map(provenance => ({
      minimumExpectedConfidence: minimumExpectedConfidence(provenance),
      provenance,
    })),
    selectedEdgeCount: counters.selectedEdges,
    summaryComplete: edgeAggregatesComplete,
    unresolvedEndpointEdgeCount: counters.unresolvedEndpointEdges,
    unresolvedEndpointShare: stableNumber(counters.unresolvedEndpointEdges / Math.max(1, counters.selectedEdges)),
  };
  const suggestedQuestions = architectureQuestions({
    communities,
    communityDrillDown,
    hubs,
    relationshipGroups,
    surprisingLinks,
  });

  return {
    algorithms: {
      communities: 'structural-connectivity-v1',
      components: 'weak-connectivity-v1',
      confidenceAudit: 'bounded-provenance-confidence-v1',
      hubs: 'degree-outlier-v1',
      relationshipGroups: 'bounded-high-degree-fan-v1',
      surprisingLinks: 'degree-preserving-cross-community-v1',
    },
    allowedProvenances,
    budget,
    communities,
    ...(communityDrillDown === undefined ? {} : {communityDrillDown}),
    components,
    confidenceAudit,
    coverage: {
      aggregates: {
        edges: {
          complete: edgeAggregatesComplete,
          rows: aggregatedEdgeCount,
          source: persistedAggregateSource ? 'persisted-summary' : 'paged-fallback',
        },
        symbols: {
          complete: symbolAggregatesComplete,
          rows: aggregatedNodeCount,
          source: persistedAggregateSource ? 'persisted-summary' : 'paged-fallback',
        },
      },
      complete: symbolAggregatesComplete && edgeAggregatesComplete && topologyComplete && confidenceFindingsComplete,
      edgeMetricsComplete,
      edgesComplete,
      nodesComplete,
      topology: {complete: topologyComplete, state: topologyState},
    },
    hubThresholds: {godNode: godNodeThreshold, hub: hubThreshold},
    hubs,
    limits,
    memberships,
    relationshipGroups,
    snapshot: {
      commit: options.snapshot.commit,
      dirty: options.snapshot.dirty,
      id: options.snapshot.id,
      repositoryId: options.snapshot.repositoryId,
      worktreeId: options.snapshot.worktreeId,
    },
    statistics: {
      analyzedEdgeCount: counters.analyzedEdges,
      analyzedNodeCount: observedTopologyNodeCount,
      aggregatedEdgeCount,
      aggregatedNodeCount,
      averageDegree: stableNumber(averageDegree),
      communityCount: communityGroups.size,
      connectedComponentCount: componentGroups.size,
      filteredEdgeCount: counters.filteredEdges,
      isolatedNodeCount,
      kinds: orderedCounts(symbolAggregateSupported ? symbolAggregates.kindCounts : topologyKindCounts),
      languages: orderedCounts(symbolAggregateSupported ? symbolAggregates.languageCounts : topologyLanguageCounts),
      maximumDegree,
      provenances: orderedCounts(provenanceCounts),
      relations: orderedCounts(relationCounts),
      scannedEdgeCount: topologyScan.visits,
      selectedEdgeCount: counters.selectedEdges,
      selfLoopCount: counters.selfLoops,
      snapshotEdgeCount: options.snapshot.edgeCount,
      snapshotNodeCount: options.snapshot.symbolCount,
      unresolvedEndpointEdgeCount: counters.unresolvedEndpointEdges,
    },
    suggestedQuestions,
    surprisingLinks,
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    usage: {
      aggregateEdgePageReads: edgeAggregateScan.pageReads,
      aggregateEdgeRows: edgeAggregateScan.rows,
      aggregateSummaryReads: persistedAggregateSource ? 1 : 0,
      aggregateSymbolPageReads: symbolAggregateScan.pageReads,
      aggregateSymbolRows: symbolAggregateScan.rows,
      durationMilliseconds: Math.max(0, finishedAt - startedAt),
      edgePageReads: topologyScan.pageReads + metricScan.pageReads,
      edgeVisits: topologyScan.visits + metricScan.visits,
      nodePageReads,
    },
    version: CODE_GRAPH_ANALYSIS_VERSION,
    warnings,
  } satisfies CodeGraphAnalysisResult;
});

const scanSymbolAggregatePages = Effect.fn('codeGraph.scanAnalysisSymbolAggregates')(function* (
  store: CodeGraphStoreShape,
  options: CodeGraphAnalysisOptions,
  pageSize: number,
  rowLimit: number,
  deadline: number,
  accumulator: SymbolAggregateAccumulator,
) {
  let cursorId: string | undefined;
  let pageReads = 0;
  let rows = 0;
  let reachedEnd = false;
  let timedOut = false;
  while (rows < rowLimit) {
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }
    const requested = Math.min(pageSize, rowLimit - rows);
    const page = yield* store.loadAnalysisSymbolAggregatePage(
      options.databasePath,
      options.snapshot.id,
      cursorId,
      requested,
    );
    pageReads += 1;
    validateAggregatePage(page, requested, cursorId, 'symbol');
    if (page.rows === 0) {
      reachedEnd = true;
      break;
    }
    mergeSymbolAggregatePage(accumulator, page);
    rows += page.rows;
    cursorId = page.lastId;
    yield* Effect.yieldNow;
    if (page.rows < requested) {
      reachedEnd = true;
      break;
    }
  }
  return {pageReads, reachedEnd, rows, timedOut} satisfies AggregateScanResult;
});

const scanEdgeAggregatePages = Effect.fn('codeGraph.scanAnalysisEdgeAggregates')(function* (
  store: CodeGraphStoreShape,
  options: CodeGraphAnalysisOptions,
  pageSize: number,
  rowLimit: number,
  deadline: number,
  allowed: ReadonlySet<CodeGraphProvenance>,
  accumulator: EdgeAggregateAccumulator,
) {
  let cursorId: string | undefined;
  let pageReads = 0;
  let rows = 0;
  let reachedEnd = false;
  let timedOut = false;
  while (rows < rowLimit) {
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }
    const requested = Math.min(pageSize, rowLimit - rows);
    const page = yield* store.loadAnalysisEdgeAggregatePage(
      options.databasePath,
      options.snapshot.id,
      cursorId,
      requested,
    );
    pageReads += 1;
    validateAggregatePage(page, requested, cursorId, 'relationship');
    if (page.rows === 0) {
      reachedEnd = true;
      break;
    }
    mergeEdgeAggregatePage(accumulator, page, allowed);
    rows += page.rows;
    cursorId = page.lastId;
    yield* Effect.yieldNow;
    if (page.rows < requested) {
      reachedEnd = true;
      break;
    }
  }
  return {pageReads, reachedEnd, rows, timedOut} satisfies AggregateScanResult;
});

function validateAggregatePage(
  page: {readonly lastId?: string; readonly rows: number},
  requested: number,
  previousCursor: string | undefined,
  label: string,
): void {
  if (!Number.isSafeInteger(page.rows) || page.rows < 0 || page.rows > requested) {
    throw new Error(`Code graph ${label} aggregate page returned an invalid row count.`);
  }
  if (page.rows === 0) return;
  if (
    page.lastId === undefined ||
    (previousCursor !== undefined && compareCodeUnits(page.lastId, previousCursor) <= 0)
  ) {
    throw new Error(`Code graph ${label} aggregate page did not advance its cursor.`);
  }
}

function makeSymbolAggregateAccumulator(): SymbolAggregateAccumulator {
  return {kindCounts: new Map(), languageCounts: new Map(), rows: 0};
}

function makeEdgeAggregateAccumulator(): EdgeAggregateAccumulator {
  return {
    confidenceBands: emptyConfidenceBands(),
    confidenceByProvenance: new Map(),
    confidenceTotal: 0,
    filteredEdges: 0,
    invalidConfidenceEdgeCount: 0,
    provenanceCounts: new Map(),
    relationCounts: new Map(),
    reviewFindingCount: 0,
    rows: 0,
    selectedEdges: 0,
    selfLoops: 0,
    unresolvedEndpointEdges: 0,
  };
}

function mergeSymbolAggregatePage(
  accumulator: SymbolAggregateAccumulator,
  page: CodeGraphAnalysisSymbolAggregatePage,
): void {
  accumulator.rows += page.rows;
  for (const row of page.counts) {
    incrementBy(accumulator.kindCounts, row.kind, row.count);
    incrementBy(accumulator.languageCounts, row.language, row.count);
  }
}

function mergePersistedAnalysisSummary(
  symbols: SymbolAggregateAccumulator,
  edges: EdgeAggregateAccumulator,
  summary: CodeGraphAnalysisSummary,
  allowed: ReadonlySet<CodeGraphProvenance>,
): void {
  symbols.rows = summary.symbolCount;
  for (const row of summary.symbols) {
    incrementBy(symbols.kindCounts, row.kind, row.count);
    incrementBy(symbols.languageCounts, row.language, row.count);
  }
  edges.rows = summary.edgeCount;
  for (const row of summary.edges) mergeEdgeAggregate(edges, row, allowed);
}

function mergeEdgeAggregatePage(
  accumulator: EdgeAggregateAccumulator,
  page: CodeGraphAnalysisEdgeAggregatePage,
  allowed: ReadonlySet<CodeGraphProvenance>,
): void {
  accumulator.rows += page.rows;
  for (const row of page.counts) mergeEdgeAggregate(accumulator, row, allowed);
}

function mergeEdgeAggregate(
  accumulator: EdgeAggregateAccumulator,
  row: CodeGraphAnalysisEdgeAggregate,
  allowed: ReadonlySet<CodeGraphProvenance>,
): void {
  if (!allowed.has(row.provenance)) {
    accumulator.filteredEdges += row.count;
    return;
  }
  accumulator.selectedEdges += row.count;
  accumulator.selfLoops += row.selfLoopCount;
  accumulator.unresolvedEndpointEdges += row.unresolvedEndpointCount;
  accumulator.confidenceTotal += row.confidenceTotal;
  accumulator.invalidConfidenceEdgeCount += row.confidenceInvalid;
  accumulator.reviewFindingCount += row.reviewFindingCount;
  incrementBy(accumulator.provenanceCounts, row.provenance, row.count);
  incrementBy(accumulator.relationCounts, row.relation, row.count);
  incrementBy(accumulator.confidenceBands, 'high', row.confidenceHigh);
  incrementBy(accumulator.confidenceBands, 'medium', row.confidenceMedium);
  incrementBy(accumulator.confidenceBands, 'low', row.confidenceLow);
  const summary = accumulator.confidenceByProvenance.get(row.provenance) ?? {
    count: 0,
    lowest: row.lowestConfidence,
    total: 0,
  };
  summary.count += row.count;
  summary.lowest = Math.min(summary.lowest, row.lowestConfidence);
  summary.total += row.confidenceTotal;
  accumulator.confidenceByProvenance.set(row.provenance, summary);
}

function emptyConfidenceBands(): Map<CodeGraphConfidenceBandName, number> {
  return new Map<CodeGraphConfidenceBandName, number>([
    ['high', 0],
    ['medium', 0],
    ['low', 0],
  ]);
}

function cloneConfidenceSummaries(
  values: ReadonlyMap<CodeGraphProvenance, MutableConfidenceSummary>,
): Map<CodeGraphProvenance, MutableConfidenceSummary> {
  return new Map([...values].map(([key, value]) => [key, {...value}]));
}

const scanEdgePages = Effect.fn('codeGraph.scanAnalysisEdges')(function* (
  store: CodeGraphStoreShape,
  options: CodeGraphAnalysisOptions,
  pageSize: number,
  visitLimit: number,
  deadline: number,
  visit: (edge: CodeGraphEdge) => void,
) {
  let cursor: CodeGraphEdgeCursor | undefined;
  let pageReads = 0;
  let visits = 0;
  let reachedEnd = false;
  let timedOut = false;
  while (visits < visitLimit) {
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }
    const requested = Math.min(pageSize, visitLimit - visits);
    const page = yield* store.loadEdgePage(options.databasePath, options.snapshot.id, cursor, requested);
    pageReads += 1;
    if (page.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const edge of page) {
      visit(edge);
      visits += 1;
      if (visits >= visitLimit) break;
    }
    const last = page.at(-1)!;
    cursor = {id: last.id, relation: last.relation, sourceName: last.sourceName, targetName: last.targetName};
    yield* Effect.yieldNow;
    if (page.length < requested) {
      reachedEnd = true;
      break;
    }
  }
  return {pageReads, reachedEnd, timedOut, visits} satisfies EdgeScanResult;
});

class DisjointSets {
  readonly #parents: number[] = [];
  readonly #ranks: number[] = [];

  add(): number {
    const index = this.#parents.length;
    this.#parents.push(index);
    this.#ranks.push(0);
    return index;
  }

  find(index: number): number {
    let root = index;
    while (this.#parents[root] !== root) root = this.#parents[root]!;
    while (this.#parents[index] !== index) {
      const parent = this.#parents[index];
      this.#parents[index] = root;
      index = parent;
    }
    return root;
  }

  union(left: number, right: number): void {
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const leftRank = this.#ranks[leftRoot];
    const rightRank = this.#ranks[rightRoot];
    if (leftRank < rightRank || (leftRank === rightRank && leftRoot > rightRoot)) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    this.#parents[rightRoot] = leftRoot;
    if (leftRank === rightRank) this.#ranks[leftRoot] = leftRank + 1;
  }
}

function updateGroup(
  groups: Map<number, MutableGroup>,
  root: number,
  node: NodeState,
  index: number,
  nodes: readonly NodeState[],
): void {
  const group = groups.get(root);
  if (!group) {
    groups.set(root, {
      communityCount: 0,
      crossCommunityIncoming: 0,
      crossCommunityOutgoing: 0,
      edgeCount: 0,
      internalEdgeCount: 0,
      memberCount: 1,
      minimumNodeId: node.id,
      representativeIndex: index,
    });
    return;
  }
  group.memberCount += 1;
  if (compareCodeUnits(node.id, group.minimumNodeId) < 0) group.minimumNodeId = node.id;
  if (compareRepresentatives(node, nodes[group.representativeIndex]) < 0) group.representativeIndex = index;
}

function groupId(group: MutableGroup, recipe: string, prefix: string): string {
  return `${prefix}_${sha256HexSync(`${recipe}\n${group.minimumNodeId}`).slice(0, 32)}`;
}

function nodeState(symbol: CodeGraphSymbol): NodeState {
  return {
    exported: symbol.exported,
    id: sanitizeCodeGraphPresentationText(symbol.id),
    incoming: 0,
    kind: sanitizeCodeGraphPresentationText(symbol.kind),
    language: sanitizeCodeGraphPresentationText(symbol.language),
    name: sanitizeCodeGraphPresentationText(symbol.name),
    outgoing: 0,
    path: sanitizeCodeGraphPresentationText(symbol.path),
    qualifiedName: sanitizeCodeGraphPresentationText(symbol.qualifiedName),
    scope: structuralScope(symbol),
    scopeLabel: sanitizeCodeGraphPresentationText(structuralScopeLabel(symbol)),
  };
}

function nodeReference(node: NodeState): CodeGraphAnalysisNodeReference {
  return {id: node.id, kind: node.kind, label: node.name, path: node.path, qualifiedName: node.qualifiedName};
}

function structuralScope(symbol: CodeGraphSymbol): string {
  const packageName = symbol.packageName?.trim();
  const normalizedPath = normalizeGraphPath(symbol.path).toLowerCase();
  return `${packageName ? `package:${packageName.normalize('NFKC').toLowerCase()}\0` : ''}file:${normalizedPath}`;
}

function displayScope(node: NodeState): string {
  return node.scopeLabel;
}

function structuralScopeLabel(symbol: CodeGraphSymbol): string {
  const path = normalizeGraphPath(symbol.path);
  const basename = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const packageName = symbol.packageName?.trim();
  return packageName ? `${packageName}/${basename}` : path;
}

function normalizeGraphPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function communityLabel(representative: NodeState, memberCount: number): string {
  return memberCount === 1 ? representative.qualifiedName : `${displayScope(representative)} · ${representative.name}`;
}

function componentLabel(representative: NodeState, memberCount: number): string {
  return memberCount === 1 ? representative.qualifiedName : `${representative.name} connected component`;
}

function compareRepresentatives(left: NodeState, right: NodeState): number {
  const leftDegree = left.incoming + left.outgoing;
  const rightDegree = right.incoming + right.outgoing;
  return (
    rightDegree - leftDegree ||
    Number(right.exported) - Number(left.exported) ||
    compareCodeUnits(left.qualifiedName, right.qualifiedName) ||
    compareCodeUnits(left.id, right.id)
  );
}

function compareGroups(
  left: {readonly id: string; readonly label: string; readonly memberCount: number},
  right: {readonly id: string; readonly label: string; readonly memberCount: number},
): number {
  return (
    right.memberCount - left.memberCount ||
    compareCodeUnits(left.label, right.label) ||
    compareCodeUnits(left.id, right.id)
  );
}

function componentResult(
  root: number,
  group: MutableGroup,
  componentIds: ReadonlyMap<number, string>,
  componentLabels: ReadonlyMap<number, string>,
  nodes: readonly NodeState[],
): CodeGraphConnectedComponent {
  return {
    communityCount: group.communityCount,
    edgeCount: group.edgeCount,
    id: componentIds.get(root)!,
    label: componentLabels.get(root)!,
    memberCount: group.memberCount,
    representative: nodeReference(nodes[group.representativeIndex]),
  };
}

function communityResult(
  root: number,
  group: MutableGroup,
  componentRootByNode: readonly number[],
  componentIds: ReadonlyMap<number, string>,
  communityIds: ReadonlyMap<number, string>,
  communityLabels: ReadonlyMap<number, string>,
  nodes: readonly NodeState[],
): CodeGraphCommunity {
  return {
    componentId: componentIds.get(componentRootByNode[group.representativeIndex])!,
    crossCommunityIncoming: group.crossCommunityIncoming,
    crossCommunityOutgoing: group.crossCommunityOutgoing,
    id: communityIds.get(root)!,
    internalEdgeCount: group.internalEdgeCount,
    label: communityLabels.get(root)!,
    memberCount: group.memberCount,
    representative: nodeReference(nodes[group.representativeIndex]),
  };
}

function communityMembership(
  index: number,
  nodes: readonly NodeState[],
  componentRootByNode: readonly number[],
  communityRootByNode: readonly number[],
  componentIds: ReadonlyMap<number, string>,
  communityIds: ReadonlyMap<number, string>,
): CodeGraphCommunityMembership {
  return {
    communityId: communityIds.get(communityRootByNode[index])!,
    componentId: componentIds.get(componentRootByNode[index])!,
    node: nodeReference(nodes[index]),
  };
}

function compareMemberships(left: CodeGraphCommunityMembership, right: CodeGraphCommunityMembership): number {
  return compareNodeReferences(left.node, right.node);
}

function compareNodeReferences(left: CodeGraphAnalysisNodeReference, right: CodeGraphAnalysisNodeReference): number {
  return compareCodeUnits(left.id, right.id);
}

function compareHubs(left: CodeGraphHub, right: CodeGraphHub): number {
  return (
    right.degree - left.degree ||
    right.incoming - left.incoming ||
    compareCodeUnits(left.node.qualifiedName, right.node.qualifiedName) ||
    compareCodeUnits(left.node.id, right.node.id)
  );
}

function compareStructuralGroupCandidates(
  left: StructuralRelationshipGroupCandidate,
  right: StructuralRelationshipGroupCandidate,
  nodes: readonly NodeState[],
): number {
  const leftNode = nodes[left.centerIndex];
  const rightNode = nodes[right.centerIndex];
  return (
    right.relationshipCount - left.relationshipCount ||
    compareCodeUnits(leftNode.qualifiedName, rightNode.qualifiedName) ||
    compareCodeUnits(leftNode.id, rightNode.id) ||
    compareCodeUnits(left.direction, right.direction)
  );
}

function structuralRelationshipGroupId(
  center: NodeState,
  direction: CodeGraphStructuralRelationshipGroup['direction'],
): string {
  return `cgrg_${sha256HexSync(`structural-relationship-group-v1\n${direction}\n${center.id}`).slice(0, 32)}`;
}

function compareSurprisingLinks(left: CodeGraphSurprisingLink, right: CodeGraphSurprisingLink): number {
  return (
    right.score - left.score ||
    right.confidence - left.confidence ||
    compareCodeUnits(left.source.qualifiedName, right.source.qualifiedName) ||
    compareCodeUnits(left.relation, right.relation) ||
    compareCodeUnits(left.target.qualifiedName, right.target.qualifiedName) ||
    compareCodeUnits(left.edgeId, right.edgeId)
  );
}

function compareConfidenceFindings(left: CodeGraphConfidenceFinding, right: CodeGraphConfidenceFinding): number {
  return (
    Number(right.issues.includes('invalid-confidence')) - Number(left.issues.includes('invalid-confidence')) ||
    left.confidence - right.confidence ||
    provenanceWeight(left.provenance) - provenanceWeight(right.provenance) ||
    compareCodeUnits(left.evidencePath, right.evidencePath) ||
    compareCodeUnits(left.edgeId, right.edgeId)
  );
}

function confidenceBand(confidence: number): CodeGraphConfidenceBandName {
  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) return 'high';
  return confidence >= LOW_CONFIDENCE_THRESHOLD ? 'medium' : 'low';
}

function retainBest<T>(values: T[], candidate: T, limit: number, compare: (left: T, right: T) => number): void {
  if (limit <= 0) return;
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(candidate, values[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  values.splice(low, 0, candidate);
  if (values.length > limit) values.pop();
}

function retainBestDistinct<T>(
  values: T[],
  candidate: T,
  limit: number,
  compare: (left: T, right: T) => number,
  key: (value: T) => string,
): void {
  const candidateKey = key(candidate);
  const duplicate = values.findIndex(value => key(value) === candidateKey);
  if (duplicate >= 0) {
    if (compare(candidate, values[duplicate]) >= 0) return;
    values.splice(duplicate, 1);
  }
  retainBest(values, candidate, limit, compare);
}

function surprisingCommunityPair(link: CodeGraphSurprisingLink): string {
  return [link.source.communityId, link.target.communityId].sort().join('\0');
}

function provenanceWeight(provenance: CodeGraphProvenance): number {
  switch (provenance) {
    case 'declared':
      return 1;
    case 'resolved':
      return 0.95;
    case 'syntactic':
      return 0.85;
    case 'heuristic':
      return 0.55;
    case 'model':
      return 0.4;
  }
}

function minimumExpectedConfidence(provenance: CodeGraphProvenance): number {
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

function relationWeight(relation: CodeGraphRelation): number {
  switch (relation) {
    case 'calls':
    case 'configures':
    case 'constructs':
    case 'tests':
      return 1.3;
    case 'extends':
    case 'implements':
    case 'overrides':
    case 'reads_or_writes':
      return 1.2;
    case 'documents':
    case 'semantic_association':
      return 1.1;
    case 'depends_on':
    case 'imports':
    case 'references':
      return 1;
    case 'contains':
    case 'declares':
    case 'exports':
    case 'reexports':
      return 0.6;
  }
}

function orderedCounts(counts: ReadonlyMap<string, number>): readonly CodeGraphAnalysisCount[] {
  return [...counts]
    .map(([value, count]) => ({count, value}))
    .sort((left, right) => right.count - left.count || compareCodeUnits(left.value, right.value));
}

function architectureQuestions(input: {
  readonly communities: readonly CodeGraphCommunity[];
  readonly communityDrillDown: CodeGraphCommunityDrillDown | undefined;
  readonly hubs: readonly CodeGraphHub[];
  readonly relationshipGroups: readonly CodeGraphStructuralRelationshipGroup[];
  readonly surprisingLinks: readonly CodeGraphSurprisingLink[];
}): readonly string[] {
  const questions: string[] = [];
  const godNode = input.hubs.find(hub => hub.classification === 'god-node') ?? input.hubs[0];
  if (godNode) {
    questions.push(`What responsibilities converge on ${godNode.node.label}, and which callers are most exposed?`);
  }
  const group = input.relationshipGroups[0];
  if (group) {
    questions.push(
      group.direction === 'fan-in'
        ? `Why do ${group.relationshipCount} relationships converge on ${group.center.label}, and can that dependency surface be narrowed?`
        : `Why does ${group.center.label} fan out across ${group.relationshipCount} relationships, and which responsibilities can be separated?`,
    );
  }
  const surprise = input.surprisingLinks[0];
  if (surprise) {
    questions.push(
      `Why does ${surprise.source.label} ${surprise.relation} ${surprise.target.label} across structural communities?`,
    );
  }
  const selectedCommunity =
    input.communityDrillDown?.state === 'found' ? input.communityDrillDown.community : undefined;
  if (selectedCommunity) {
    questions.push(
      `Which boundaries and responsibilities define ${selectedCommunity.label}, and where does it couple to other communities?`,
    );
  } else if (input.communities.length >= 2) {
    questions.push(
      `Where do ${input.communities[0].label} and ${input.communities[1].label} exchange data or control?`,
    );
  }
  questions.push('Which current-source relationships have the highest reverse-impact risk for the next change?');
  questions.push(
    'Which rationale nodes explain non-obvious architectural constraints, and what code do they document?',
  );
  return [...new Set(questions)].slice(0, 6);
}

function increment(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function incrementBy(counts: Map<string, number>, value: string, amount: number): void {
  counts.set(value, (counts.get(value) ?? 0) + amount);
}

function stableNumber(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(8)) : 0;
}

function isCooperativeCheckpoint(index: number): boolean {
  return index > 0 && index % 1_024 === 0;
}

function deadlineReached(deadline: number): Effect.Effect<boolean> {
  return Clock.currentTimeMillis.pipe(Effect.map(now => now >= deadline));
}

function emptyEdgeScan(timedOut: boolean): EdgeScanResult {
  return {pageReads: 0, reachedEnd: false, timedOut, visits: 0};
}

function emptyAggregateScan(timedOut: boolean): AggregateScanResult {
  return {pageReads: 0, reachedEnd: false, rows: 0, timedOut};
}

function completeAggregateScan(rows: number): AggregateScanResult {
  return {pageReads: 0, reachedEnd: true, rows, timedOut: false};
}

function resolveProvenances(values: readonly CodeGraphProvenance[] | undefined): readonly CodeGraphProvenance[] {
  const requested = values ?? DEFAULT_PROVENANCES;
  return [...new Set(requested.filter(value => ALL_PROVENANCES.has(value)))].sort();
}
