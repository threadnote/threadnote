import {Effect} from 'effect';
import type {CodeGraphProvenance, CodeGraphRelation} from '../types.js';
import type {CodeGraphStoreShape} from '../store.js';
import type {
  CodeGraphAnalysisOptions,
  ResolvedCodeGraphAnalysisBudget,
  ResolvedCodeGraphAnalysisLimits,
} from './configuration.js';

export const CODE_GRAPH_ANALYSIS_VERSION = 3 as const;

/** Minimal store surface used by paged graph analysis. */
export type CodeGraphAnalysisStore = Pick<CodeGraphStoreShape, 'loadEdgePage' | 'loadSymbolPage'> &
  Partial<
    Pick<
      CodeGraphStoreShape,
      'loadAnalysisEdgeAggregatePage' | 'loadAnalysisSummary' | 'loadAnalysisSymbolAggregatePage'
    >
  >;

/** Minimal store surface for analysis that owns a read session and snapshot lease. */
export type CodeGraphAnalysisLeasedStore = CodeGraphAnalysisStore &
  Pick<CodeGraphStoreShape, 'acquireSnapshotLease' | 'releaseSnapshotLease' | 'withSession'>;

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

export interface CodeGraphAnalysisResult {
  readonly leaseCleanup?: {
    readonly state: 'released' | 'expiry';
    readonly expiresAt: number;
  };
  readonly projectCoverage?: import('../types.js').CodeGraphProjectCoverage;
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
