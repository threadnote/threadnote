import type {CodeGraphLeaseTimingObserver} from '../store/lease_timing.js';
import {Effect} from 'effect';
import type {CodeGraphProvenance, CodeGraphSnapshot} from '../types.js';

export interface CodeGraphAnalysisBudget {
  /** Rows grouped by each interruptible aggregate query. */
  readonly aggregatePageSize?: number;
  /** Maximum distinct edge rows considered by the topology pass. */
  readonly maxEdges?: number;
  /** Maximum edge row visits across the topology and scoring passes. */
  readonly maxEdgeVisits?: number;
  readonly maxDurationMilliseconds?: number;
  readonly maxNodes?: number;
  readonly pageSize?: number;
}

export interface CodeGraphAnalysisLimits {
  readonly communities?: number;
  readonly communityMembers?: number;
  readonly components?: number;
  readonly confidenceFindings?: number;
  readonly hubs?: number;
  readonly memberships?: number;
  readonly relationshipGroupMembers?: number;
  readonly relationshipGroups?: number;
  readonly surprisingLinks?: number;
}

export interface CodeGraphAnalysisOptions {
  /** @internal Paired lease substage boundaries for diagnostics only. */
  readonly onLeaseTiming?: (
    operation: 'acquire' | 'release',
    ...event: Parameters<CodeGraphLeaseTimingObserver>
  ) => void;
  /** @internal Optional path-free benchmark observer; returns completion work without owning the analysis. */
  readonly onTiming?: (
    stage: 'lease-acquire' | 'read-session' | 'lease-release',
  ) => Effect.Effect<Effect.Effect<void, unknown>, unknown>;
  readonly allowedProvenances?: readonly CodeGraphProvenance[];
  readonly budget?: CodeGraphAnalysisBudget;
  /** Stable `cgc_…` identifier returned by an earlier analysis. */
  readonly communityId?: string;
  readonly databasePath: string;
  readonly deadlineMilliseconds?: number;
  readonly limits?: CodeGraphAnalysisLimits;
  readonly minimumGodNodeDegree?: number;
  readonly minimumHubDegree?: number;
  readonly snapshot: CodeGraphSnapshot;
}

export function withCodeGraphAnalysisTiming<A, E, R>(
  observer: CodeGraphAnalysisOptions['onTiming'],
  stage: Parameters<NonNullable<CodeGraphAnalysisOptions['onTiming']>>[0],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  if (observer === undefined) return effect;
  return Effect.gen(function* () {
    const complete: Effect.Effect<void, unknown> = yield* Effect.suspend(() => observer(stage)).pipe(
      Effect.catchCause(() => Effect.succeed(Effect.void)),
    );
    return yield* effect.pipe(Effect.ensuring(complete.pipe(Effect.ignoreCause)));
  });
}

export interface ResolvedCodeGraphAnalysisBudget {
  readonly aggregatePageSize: number;
  readonly maxEdges: number;
  readonly maxEdgeVisits: number;
  readonly maxDurationMilliseconds: number;
  readonly maxNodes: number;
  readonly pageSize: number;
}

export interface ResolvedCodeGraphAnalysisLimits {
  readonly communities: number;
  readonly communityMembers: number;
  readonly components: number;
  readonly confidenceFindings: number;
  readonly hubs: number;
  readonly memberships: number;
  readonly relationshipGroupMembers: number;
  readonly relationshipGroups: number;
  readonly surprisingLinks: number;
}

const DEFAULT_BUDGET = {
  aggregatePageSize: 50_000,
  maxDurationMilliseconds: 60_000,
  pageSize: 1_000,
} as const;

const DEFAULT_LIMITS: ResolvedCodeGraphAnalysisLimits = {
  communities: 250,
  communityMembers: 100,
  components: 250,
  confidenceFindings: 50,
  hubs: 50,
  memberships: 25_000,
  relationshipGroupMembers: 20,
  relationshipGroups: 50,
  surprisingLinks: 50,
};

export function resolveBudget(
  input: CodeGraphAnalysisBudget | undefined,
  snapshot: CodeGraphSnapshot,
): ResolvedCodeGraphAnalysisBudget {
  const maxEdges = nonNegativeSafeInteger(input?.maxEdges, snapshot.edgeCount);
  return {
    aggregatePageSize: positiveInteger(input?.aggregatePageSize, DEFAULT_BUDGET.aggregatePageSize, 1, 250_000),
    maxEdges,
    maxEdgeVisits: nonNegativeSafeInteger(input?.maxEdgeVisits, saturatingMultiply(maxEdges, 2)),
    maxDurationMilliseconds: positiveInteger(
      input?.maxDurationMilliseconds,
      DEFAULT_BUDGET.maxDurationMilliseconds,
      1,
      10 * 60_000,
    ),
    maxNodes: nonNegativeSafeInteger(input?.maxNodes, snapshot.symbolCount),
    pageSize: positiveInteger(input?.pageSize, DEFAULT_BUDGET.pageSize, 1, 2_000),
  };
}

export function resolveLimits(input: CodeGraphAnalysisLimits | undefined): ResolvedCodeGraphAnalysisLimits {
  return {
    communities: nonNegativeInteger(input?.communities, DEFAULT_LIMITS.communities, 5_000),
    communityMembers: nonNegativeInteger(input?.communityMembers, DEFAULT_LIMITS.communityMembers, 5_000),
    components: nonNegativeInteger(input?.components, DEFAULT_LIMITS.components, 5_000),
    confidenceFindings: nonNegativeInteger(input?.confidenceFindings, DEFAULT_LIMITS.confidenceFindings, 500),
    hubs: nonNegativeInteger(input?.hubs, DEFAULT_LIMITS.hubs, 500),
    memberships: nonNegativeInteger(input?.memberships, DEFAULT_LIMITS.memberships, 250_000),
    relationshipGroupMembers: nonNegativeInteger(
      input?.relationshipGroupMembers,
      DEFAULT_LIMITS.relationshipGroupMembers,
      500,
    ),
    relationshipGroups: nonNegativeInteger(input?.relationshipGroups, DEFAULT_LIMITS.relationshipGroups, 500),
    surprisingLinks: nonNegativeInteger(input?.surprisingLinks, DEFAULT_LIMITS.surprisingLinks, 500),
  };
}

export function positiveInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value!)) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(maximum, value!)) : fallback;
}

function nonNegativeSafeInteger(value: number | undefined, fallback: number): number {
  const candidate = Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
  return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
}

function saturatingMultiply(value: number, multiplier: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value * multiplier);
}
