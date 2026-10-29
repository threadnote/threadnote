import type {CodeGraphBuildOwnerIdentity} from '../build/owner.js';
import type {
  CodeGraphDiskCapacityFailureEvidence,
  CodeGraphIndexSummary,
  CodeGraphActivationActivity,
  CodeGraphMaterializationActivity,
  CodeGraphMaterializationMetrics,
  CodeGraphRegistrationActivity,
  CodeGraphResolutionActivity,
} from '../types.js';
import type {
  CodeGraphScanningMetrics,
  CodeGraphSlowFileTelemetry,
  CodeGraphSourceSizeBucket,
} from '../progress/telemetry.js';
import {Effect} from 'effect';
import type {CodeGraphBuilderAdmissionQueue} from '../builder/admission_scheduler.js';
import type {CodeGraphCapacityFailureOperation} from '../disk/capacity.js';
import type {CodeGraphBuildScheduling} from './scheduling.js';
import type {CodeGraphOverlayFallbackReason, CodeGraphProgress, CodeGraphSnapshot} from '../types.js';

export interface CodeGraphBuildCounters {
  readonly accepted?: number;
  readonly completed?: number;
  readonly edges?: number;
  readonly embedded?: number;
  readonly excluded?: number;
  readonly pagesCompleted?: number;
  readonly reused?: number;
  readonly resolved?: number;
  readonly rowsDeleted?: number;
  readonly skipped?: number;
  readonly symbols?: number;
  readonly total?: number;
  readonly unit?: 'files' | 'references' | 'snapshots' | 'symbols';
}

export type CodeGraphBuildState = 'completed' | 'failed' | 'queued' | 'running';
export type CodeGraphBuildLiveness = 'abandoned' | 'active' | 'completed' | 'failed' | 'stalled';

export interface CodeGraphBuildActivity {
  readonly batchCompleted: number;
  readonly batchTotal: number;
  readonly bytes: number;
  readonly classifier?: string;
  readonly degraded?: boolean;
  readonly factsBytes?: number;
  readonly language: string;
  readonly parseMilliseconds?: number;
  readonly persistMilliseconds?: number;
  readonly relations?: number;
  readonly role?: string;
  readonly sizeBucket?: CodeGraphSourceSizeBucket;
  readonly stage: 'extracting' | 'persisting' | 'reading';
  readonly symbols?: number;
}

export interface CodeGraphBuildExtraction {
  readonly completedFiles: number;
  readonly metrics?: CodeGraphScanningMetrics;
  readonly slowFiles: number;
  readonly topSlowFiles: readonly CodeGraphSlowFileTelemetry[];
}

export interface CodeGraphBuildTimings {
  readonly extractionMilliseconds: number;
  readonly persistenceMilliseconds: number;
  readonly readingMilliseconds: number;
  readonly serializationMilliseconds?: number;
}

export interface CodeGraphBuildMaterialization {
  readonly activity?: CodeGraphMaterializationActivity & {
    readonly startedAt: string;
  };
  readonly metrics?: CodeGraphMaterializationMetrics;
}

export interface CodeGraphBuildCapacityFailure {
  readonly code: 'no-space' | 'transient-io';
  readonly evidence: CodeGraphDiskCapacityFailureEvidence;
  readonly operation: CodeGraphCapacityFailureOperation;
}

export interface CodeGraphBuildError {
  readonly capacity?: CodeGraphBuildCapacityFailure;
  readonly summary: string;
}

export interface CodeGraphBuildActivation {
  readonly activity: CodeGraphActivationActivity & {
    readonly startedAt: string;
  };
}

export interface CodeGraphBuildResolution {
  readonly activity: CodeGraphResolutionActivity & {
    readonly startedAt: string;
  };
}

export interface CodeGraphBuildRegistration {
  readonly activity: CodeGraphRegistrationActivity;
}

export interface CodeGraphBuildStatus {
  readonly activation?: CodeGraphBuildActivation;
  /** Privacy-safe in-flight activity; repository paths and content are intentionally omitted. */
  readonly activity?: CodeGraphBuildActivity;
  readonly buildId: string;
  readonly counters: CodeGraphBuildCounters;
  readonly error?: CodeGraphBuildError;
  readonly eta?: {
    readonly basis?: 'cached-fact-bytes' | 'extraction-work' | 'files' | 'final-fact-bytes' | 'source-bytes';
    readonly confidence: 'high' | 'low' | 'medium';
    readonly remainingMilliseconds: number;
    readonly scope: 'phase';
  };
  readonly extraction?: CodeGraphBuildExtraction;
  readonly identity: {
    readonly checkoutId: string;
    readonly commit: string;
    readonly displayName?: string;
    readonly repositoryId: string;
    /** Opaque configured-view key; absent is the legacy complete repository view. */
    readonly scopeId?: string;
    readonly worktreeId: string;
  };
  readonly materialization?: CodeGraphBuildMaterialization;
  readonly owner: {
    readonly processId: number;
    readonly processStartIdentity?: string;
    readonly runtime: 'bun';
    readonly runtimeVersion: string;
  };
  readonly phase: CodeGraphProgress['phase'];
  readonly request?: {
    /** Privacy-safe identity for callers waiting on the same source and extraction pipeline. */
    readonly key: string;
  };
  readonly registration?: CodeGraphBuildRegistration;
  readonly resolution?: CodeGraphBuildResolution;
  readonly result?: {
    readonly dirty: boolean;
    readonly edges: number;
    readonly files: number;
    readonly snapshotId: string;
    readonly symbols: number;
    readonly overlayAssessment?: {
      readonly outcome: 'overlay-success' | CodeGraphOverlayFallbackReason;
    };
  };
  readonly schemaVersion: typeof import('./validation.js').CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION;
  readonly scheduling?: CodeGraphBuildScheduling;
  readonly state: CodeGraphBuildState;
  readonly subphase?: string;
  readonly timings?: CodeGraphBuildTimings;
  readonly worktreeLockHeld?: boolean;
  readonly timestamps: {
    readonly completedAt?: string;
    readonly heartbeatAt: string;
    readonly lastProgressAt: string;
    readonly phaseStartedAt: string;
    readonly startedAt: string;
    readonly updatedAt: string;
  };
}

export interface ObservedCodeGraphBuildStatus extends CodeGraphBuildStatus {
  readonly coordination?: {
    readonly lockVerified: boolean;
    readonly progressSilent?: boolean;
    readonly role: 'history' | 'owner' | 'waiter';
  };
  /** Local-only Manager context. Never written into the privacy-safe build status document. */
  readonly managerContext?: {
    readonly branch?: string;
    readonly worktreePath: string;
  };
  readonly observation: {
    readonly heartbeatAgeMilliseconds: number;
    readonly liveness: CodeGraphBuildLiveness;
    readonly reason?: 'heartbeat-stale' | 'owner-exited' | 'pid-reused';
  };
}

export interface CodeGraphBuildStatusSelection {
  /** One authoritative owner or most useful terminal status per worktree. */
  readonly builds: readonly ObservedCodeGraphBuildStatus[];
  /** Live lock contenders, retained separately from the authoritative owner. */
  readonly waiters: readonly ObservedCodeGraphBuildStatus[];
}

export interface CodeGraphBuildReporter {
  readonly admission: (queue?: CodeGraphBuilderAdmissionQueue) => Effect.Effect<void, never>;
  readonly complete: (summary: CodeGraphIndexSummary) => Effect.Effect<void, never>;
  readonly completeSnapshot: (snapshot: CodeGraphSnapshot) => Effect.Effect<void, never>;
  readonly fail: (cause: unknown) => Effect.Effect<void, never>;
  readonly heartbeat: Effect.Effect<void, never>;
  /** Exact privacy-safe owner instance persisted with resumable build state. */
  readonly ownerIdentity: CodeGraphBuildOwnerIdentity;
  readonly progress: (progress: CodeGraphProgress) => Effect.Effect<void, never>;
  readonly resource: (
    resource: import('../build/resources.js').CodeGraphBuildResource | undefined,
  ) => Effect.Effect<void, never>;
  readonly markWorktreeLockHeld: (held: boolean) => Effect.Effect<void, never>;
}

export type CodeGraphBuildOwnerStatusCorroboration = 'absent' | 'matches' | 'mismatch';

export type CodeGraphBuildHistoryPruneResult =
  | {readonly state: 'complete'}
  | {
      readonly cursorToken: string;
      readonly removedAbandoned?: true;
      readonly state: 'progress';
    }
  | {
      readonly blockedCode: 'invalid-sidecar' | 'io-error' | 'permission-denied';
      readonly retryAfterMilliseconds: number;
      readonly state: 'deferred';
    };

export interface CodeGraphBuildHistoryPruneOptions {
  /** @internal Deterministic replacement seam before exact pair removal. */
  readonly beforeFinalStatusObservation?: () => Effect.Effect<void, unknown>;
  /** @internal Deterministic interruption seam after context removal. */
  readonly afterManagerContextRemoval?: () => Effect.Effect<void, unknown>;
  /** @internal Deterministic directory replacement seam after cursor authority freezes. */
  readonly beforeCursorRecovery?: () => Effect.Effect<void, unknown>;
  /** @internal Deterministic directory replacement seam before cursor state changes. */
  readonly beforeCursorMutation?: () => Effect.Effect<void, unknown>;
}
