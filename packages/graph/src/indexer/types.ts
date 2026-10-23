import {Crypto, Effect, FileSystem, Option, Path} from 'effect';
import type {SystemInfoShape} from '@threadnote/platform/system';
import type {BoundedCodeGraphFact} from '../fact/budget.js';
import type {CodeGraphDirectPersistentCapacityBoundary} from '../disk/capacity.js';
import type {CodeGraphIncrementalWork, CodeGraphIncrementalWorkObservation} from '../incremental/work.js';
import type {CodeGraphInventoryOptions} from '../inventory.js';
import type {CodeGraphInventory} from '../inventory.js';
import type {MaterializationStorageTelemetry} from './materialization.js';
import type {CodeGraphWorkspace} from '../languages/types.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import type {CodeGraphLayout} from '../layout.js';
import type {CodeGraphBuilderAdmissionClass} from '../builder/admission.js';
import type {CodeGraphEmbeddingIndexShape} from '../embedding.js';
import type {CodeGraphResolutionPublicationAssessment} from '../resolution/surface.js';
import type {CodeGraphMaintenanceCoordinatorShape} from '../maintenance/coordinator.js';
import type {
  CodeGraphLanguagePackProvenance,
  CodeGraphSqliteWriterSettings,
  CodeGraphSqliteWriterTuning,
  CodeGraphStoreShape,
} from '../store.js';
import type {
  CodeGraphFileFacts,
  CodeGraphIndexSummary,
  CodeGraphInventoryFile,
  CodeGraphOverlayFallbackAssessment,
  CodeGraphOverlayFallbackReason,
  CodeGraphProgress,
  CodeGraphSnapshot,
  RepositoryIdentity,
  RepositoryIdentityExpectation,
} from '../types.js';

export type CodeGraphIndexResourceGate = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | unknown, R>;

export type CodeGraphPreparedSpoolBudgetGate = <A, E, R>(
  bytes: number,
  snapshotId: string,
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | unknown, R>;

export interface CodeGraphIndexOptions extends CodeGraphInventoryOptions {
  /** @internal Optional path-free benchmark observation; never owns the observed operation. */
  readonly onTiming?: CodeGraphIndexTimingObserver;
  /** @internal Home-global builder admission priority. CLI defaults to current-required. */
  readonly admissionClass?: CodeGraphBuilderAdmissionClass;
  readonly cwd: string;
  /** When false, skip blocking vector materialization after a ready structural snapshot. */
  readonly ensureVectors?: boolean;
  /** Exact graph target supplied by a trusted local administration surface. */
  readonly expectedIdentity?: RepositoryIdentityExpectation;
  readonly force?: boolean;
  /** @internal Disable graph sharing import, hydration, enqueue and drain for source-only verification. */
  readonly sourceOnly?: boolean;
  /** @internal Fail-closed hooks for a fresh, clean, forced source-only publication attempt. */
  readonly sourceVerification?: CodeGraphSourceVerification;
  /** Internal benchmark/correctness escape hatch; normal indexing keeps this enabled. */
  readonly incrementalOverlay?: boolean;
  /** @internal Records read-back PRAGMA values for controlled benchmark evidence. */
  readonly onSqliteWriterConfigured?: (settings: CodeGraphSqliteWriterSettings) => Effect.Effect<void, never>;
  /** @internal Opaque background-demand claim for in-process watcher refreshes. */
  readonly refreshDemandToken?: string;
  /** @internal Benchmark-only physical transaction grouping; normal indexing uses four logical receipts. */
  readonly persistentMaterializationTransactionBatchLimit?: 1 | 4;
  /** @internal Benchmark-only SQLite writer candidate; normal indexing leaves this unset. */
  readonly sqliteWriterTuning?: CodeGraphSqliteWriterTuning;
  /** @internal Deterministic fresh-capacity probe used by lifecycle fault tests. */
  readonly diskCapacityAvailableBytes?: (
    path: string,
    boundary: CodeGraphDirectPersistentCapacityBoundary,
  ) => Effect.Effect<number | undefined, unknown>;
  readonly threadnoteHome: string;
}

export type CodeGraphIndexTimingStage =
  | 'admission'
  | 'database-session'
  | 'database-session-body'
  | 'index-scope'
  | 'index-scope-body'
  | 'lifecycle-opportunity'
  | 'reporter-completion'
  | 'share-drain'
  | 'snapshot-lease-release';

/** Starts an observation and returns its completion effect; no paths or lease tokens enter the observer. */
export type CodeGraphIndexTimingObserver = (
  stage: CodeGraphIndexTimingStage,
) => Effect.Effect<Effect.Effect<void, unknown>, unknown>;

export function withCodeGraphIndexTiming<A, E, R>(
  observer: CodeGraphIndexTimingObserver | undefined,
  stage: CodeGraphIndexTimingStage,
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

/** Preserve the original store and session context; observe even repeated scoped releases without changing ownership. */
export function codeGraphIndexTimingStore(
  store: CodeGraphStoreShape,
  observer: CodeGraphIndexTimingObserver | undefined,
): CodeGraphStoreShape {
  if (observer === undefined) return store;
  return {
    ...store,
    releaseSnapshotLease: (...args) =>
      withCodeGraphIndexTiming(observer, 'snapshot-lease-release', store.releaseSnapshotLease(...args)),
    withSession: (databasePath, effect, options) =>
      withCodeGraphIndexTiming(
        observer,
        'database-session',
        store.withSession(databasePath, withCodeGraphIndexTiming(observer, 'database-session-body', effect), options),
      ),
  };
}

export interface CodeGraphSourceVerification {
  readonly observeParserBatch: (group: {
    readonly cacheIdentity: string;
    readonly facts: readonly BoundedCodeGraphFact[];
    readonly files: readonly CodeGraphInventoryFile[];
  }) => Effect.Effect<void, unknown>;
  /** Returned facts flow directly into postprocessing and attribution for this assembly batch. */
  readonly materializeFacts: (batch: {
    readonly facts: ReadonlyMap<string, CodeGraphFileFacts>;
    readonly files: readonly CodeGraphInventoryFile[];
  }) => Effect.Effect<ReadonlyMap<string, CodeGraphFileFacts>, unknown>;
}

export interface DirectPersistentCapacityProtection {
  readonly availableDiskBytes: (
    path: string,
    boundary: CodeGraphDirectPersistentCapacityBoundary,
  ) => Effect.Effect<number | undefined, unknown>;
  readonly crypto: Crypto.Crypto;
  readonly maintenance: CodeGraphMaintenanceCoordinatorShape;
  readonly path: Path.Path;
  readonly system: SystemInfoShape;
  readonly temporaryDirectory: string;
  readonly walAutoCheckpointPages: number;
}

export interface CodeGraphBuildAndActivateInput {
  readonly activatePointer: boolean;
  readonly building: CodeGraphSnapshot;
  readonly capacityProtection: DirectPersistentCapacityProtection;
  readonly committedBase?: CommittedBaseResult;
  readonly existing?: CodeGraphSnapshot;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly ensureVectors: boolean;
  readonly force: boolean;
  readonly sourceVerification?: CodeGraphSourceVerification;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly inventory: CodeGraphInventory;
  readonly incrementalAssessment?: IncrementalOverlayAssessment;
  readonly incrementalMaterializationStorageTelemetry?: MaterializationStorageTelemetry;
  readonly incrementalOverlayEnabled?: boolean;
  readonly incrementalPrepared?: boolean;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly legacyBuildAdmission?: CodeGraphIndexResourceGate;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly persistentMaterializationTransactionBatchLimit?: 1 | 4;
  readonly persistentOwnerToken?: string;
  readonly preparationGate?: CodeGraphIndexResourceGate;
  readonly preparedSpoolBudgetGate?: CodeGraphPreparedSpoolBudgetGate;
  readonly requestedOverlay?: {readonly dirty: boolean; readonly fingerprint?: string};
  readonly sparseProjection?: {
    readonly packProvenance: readonly CodeGraphLanguagePackProvenance[];
    readonly totalFiles: number;
  };
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
  readonly workspace?: CodeGraphWorkspace;
}

export function codeGraphIndexEnsuresVectors(options: {readonly ensureVectors?: boolean}): boolean {
  return options.ensureVectors !== false;
}

export interface CommittedBaseResult {
  readonly additionalLeaseTokens?: readonly string[];
  readonly diagnostics: readonly string[];
  readonly foldForward?: {
    readonly logicalSnapshotId: string;
    readonly priorDeltaPaths: readonly string[];
    readonly priorStagedPayloadBytes: number;
    readonly priorStagedRows: number;
  };
  readonly leaseToken: Option.Option<string>;
  readonly snapshot: CodeGraphSnapshot;
  readonly stagingReusable: boolean;
  /** Present when this call performed or observed the committed-base build. */
  readonly summary?: CodeGraphIndexSummary;
}

export type IncrementalOverlayAssessment =
  | {
      readonly facts: readonly CodeGraphFileFacts[];
      readonly files: readonly CodeGraphInventoryFile[];
      readonly closureProjects?: number;
      readonly mode: 'eligible';
      readonly deletedPaths?: readonly string[];
      readonly resolutionClosure?: 'changed' | 'full' | 'project';
      readonly resolutionPublicationAssessment?: CodeGraphResolutionPublicationAssessment;
      readonly extractorTransition?: true;
      readonly reuse: 'persisted-base' | 'staged-base';
      readonly work: CodeGraphIncrementalWork;
    }
  | {
      readonly fallbackAssessment?: CodeGraphOverlayFallbackAssessment;
      readonly fallbackBoundary?: import('../types.js').CodeGraphOverlayFallbackBoundary;
      readonly mode: 'fallback';
      readonly reason: CodeGraphOverlayFallbackReason;
      readonly resolutionPublicationAssessment?: CodeGraphResolutionPublicationAssessment;
    };

export type IncrementalOverlayPreassessment =
  | {
      readonly baseFileSetFingerprint: string;
      readonly committedWorkspace: CodeGraphWorkspace;
      readonly facts: readonly CodeGraphFileFacts[];
      readonly files: readonly CodeGraphInventoryFile[];
      readonly closureProjects?: number;
      readonly mode: 'compatible';
      readonly proportionalWork?: CodeGraphIncrementalWorkObservation;
      readonly deletedPaths?: readonly string[];
      readonly resolutionClosure?: 'changed' | 'full' | 'project';
      readonly resolutionPublicationAssessment?: CodeGraphResolutionPublicationAssessment;
      readonly extractorTransition?: true;
    }
  | {
      readonly fallbackAssessment?: CodeGraphOverlayFallbackAssessment;
      readonly fallbackBoundary?: import('../types.js').CodeGraphOverlayFallbackBoundary;
      readonly mode: 'fallback';
      readonly reason: CodeGraphOverlayFallbackReason;
      readonly resolutionPublicationAssessment?: CodeGraphResolutionPublicationAssessment;
    };

export type ReusableCleanSnapshotAttempt =
  | {
      readonly mode: 'complete';
      readonly summary: CodeGraphIndexSummary;
    }
  | Extract<IncrementalOverlayAssessment, {readonly mode: 'fallback'}>;

export interface CodeGraphCommitLease {
  readonly leaseToken: string;
  readonly snapshot: CodeGraphSnapshot;
}

export interface CodeGraphIndexerShape {
  readonly ensureCommit: (
    options: Omit<CodeGraphIndexOptions, 'force' | 'includeOverlay' | 'sourceVerification'> & {readonly commit: string},
  ) => Effect.Effect<CodeGraphCommitLease, unknown>;
  readonly index: (options: CodeGraphIndexOptions) => Effect.Effect<CodeGraphIndexSummary, unknown>;
}
