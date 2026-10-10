import type * as THREE from 'three';
import type {CodeGraphAutomaticCompactionStatus} from '@threadnote/graph/automatic/compaction';
import type {CodeGraphLocalDiagnosticsReport} from '@threadnote/graph/diagnostics';
import type {CodeGraphLocalAssociation} from '@threadnote/graph/local_provenance';
import type {CodeGraphMaintenanceStatus} from '@threadnote/graph/maintenance/gate';
import type {ManagerGraphReconciliationStatus, ManagerGraphStorageSummary} from '@threadnote/graph/manager/status';
import {codeGraphFailedBuildStatusCurrent} from '@threadnote/graph/build_status/validation';
import {compareCodeUnits} from '@threadnote/graph/ordering';
import {
  MANAGER_GRAPH_DEFAULT_EDGE_LIMIT,
  MANAGER_GRAPH_DEFAULT_NODE_LIMIT,
  MANAGER_GRAPH_CATALOG_SCOPE_SEARCH_LIMIT,
  MANAGER_GRAPH_MAX_EDGE_LIMIT,
  MANAGER_GRAPH_MAX_NODE_LIMIT,
} from '@threadnote/graph/visualization/limits';

export interface GraphProject {
  readonly buildSystem?: string;
  readonly fileCount?: number;
  readonly id: string;
  readonly kind?: string;
  readonly label: string;
  readonly model?: 'component' | 'facet' | 'legacy-fallback';
  readonly provenance?: string;
  readonly symbolCount?: number;
  readonly workspaceId?: string;
}

export interface GraphWorkspaceDescriptor {
  readonly buildSystem: string;
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

export interface GraphSnapshot {
  readonly commit: string;
  readonly completedAt?: string;
  readonly dirty: boolean;
  readonly edgeCount: number;
  readonly fileCount: number;
  readonly id: string;
  readonly symbolCount: number;
}

export interface GraphRepository {
  readonly accounting: {
    readonly attributedSymbols: number;
    readonly componentSymbols: number;
    readonly fallbackSymbols: number;
    readonly omittedSymbols: number;
    readonly totalSymbols: number;
  };
  readonly activatedAt?: string;
  readonly checkoutId: string;
  readonly displayName: string;
  readonly id: string;
  readonly label: string;
  readonly localAssociation: CodeGraphLocalAssociation;
  readonly metrics: 'complete' | 'deferred';
  readonly model: 'legacy-fallback' | 'workspace';
  readonly projectCount: number;
  readonly projects: readonly GraphProject[];
  readonly projectsTruncated: boolean;
  readonly scopeId?: string;
  readonly snapshot: GraphSnapshot;
  readonly worktreeId: string;
  readonly workspaceCount: number;
  readonly workspaces: readonly GraphWorkspaceDescriptor[];
  readonly workspacesTruncated: boolean;
}

export interface GraphRepositoryGroup {
  readonly defaultViewId: string;
  readonly displayName: string;
  readonly id: string;
  readonly repositoryId: string;
  readonly views: readonly GraphRepository[];
  readonly viewsTruncated: boolean;
}

export interface GraphCatalogDiagnostic {
  readonly checkoutId: string;
  readonly code: 'lease-deferred' | 'lease-failed' | 'no-ready-snapshot' | 'unreadable-database';
  readonly message: string;
}

export interface GraphConfiguredProject {
  readonly folder: string;
  readonly graphState: 'not-indexed' | 'ready' | 'unknown';
  readonly name: string;
  readonly path: string;
  readonly scopeId?: string;
}

export interface GraphCatalog {
  readonly automaticCompaction?: CodeGraphAutomaticCompactionStatus;
  readonly builds: readonly GraphBuildStatus[];
  readonly catalogRevision?: string;
  readonly configuredProjects?: readonly GraphConfiguredProject[];
  readonly diagnostics: readonly GraphCatalogDiagnostic[];
  readonly lifecyclePending?: boolean;
  readonly reconciliation?: ManagerGraphReconciliationStatus;
  readonly maintenance?: CodeGraphMaintenanceStatus;
  readonly manifestRevision?: string;
  readonly repositories: readonly GraphRepositoryGroup[];
  readonly storage?: Readonly<Record<string, ManagerGraphStorageSummary>>;
  readonly waiterCount: number;
  readonly waiters: readonly GraphBuildStatus[];
}

export type GraphAdministrationAction =
  | {
      readonly action: 'compact' | 'index';
      readonly project?: string;
      readonly expectedRevision?: string;
      readonly checkoutId: string;
      readonly cwd?: string;
      readonly dryRun?: boolean;
      readonly force?: boolean;
      readonly full?: boolean;
      readonly repositoryId: string;
      readonly worktreeId: string;
    }
  | {
      readonly action: 'index-cwd';
      readonly cwd: string;
      readonly full?: boolean;
    }
  | {
      readonly action: 'index-project';
      readonly expectedRevision: string;
      readonly full?: boolean;
      readonly project: string;
    }
  | {
      readonly action: 'purge' | 'purge-obsolete';
      readonly checkoutId: string;
      readonly dryRun?: boolean;
    }
  | {
      readonly action: 'remove-view';
      readonly checkoutId: string;
      readonly dryRun?: boolean;
      readonly expectedSnapshotId: string;
      readonly scopeId?: string;
      readonly worktreeId: string;
    }
  | {readonly action: 'purge-all'; readonly dryRun?: boolean}
  | {readonly action: 'repair'; readonly deep?: boolean; readonly dryRun?: boolean};

export type GraphIndexActionResponse =
  | {readonly output: string}
  | {
      readonly scopeSelection: {
        readonly expectedRevision: string;
        readonly projects: readonly {readonly name: string; readonly roots: readonly string[]}[];
      };
    };

export type GraphWorktreeAdministrationAction = Extract<
  GraphAdministrationAction,
  {readonly action: 'compact' | 'index'}
>;

export function graphAdministrationTarget(
  checkoutId: string,
  view: {readonly repository: {readonly repositoryId: string}; readonly worktreeId: string},
): Pick<GraphWorktreeAdministrationAction, 'checkoutId' | 'repositoryId' | 'worktreeId'> {
  return {checkoutId, repositoryId: view.repository.repositoryId, worktreeId: view.worktreeId};
}

export function graphViewRemovalTarget(
  checkoutId: string,
  view: {readonly scopeId?: string; readonly snapshot: {readonly id: string}; readonly worktreeId: string},
): Pick<
  Extract<GraphAdministrationAction, {readonly action: 'remove-view'}>,
  'checkoutId' | 'expectedSnapshotId' | 'scopeId' | 'worktreeId'
> {
  return {
    checkoutId,
    expectedSnapshotId: view.snapshot.id,
    ...(view.scopeId === undefined ? {} : {scopeId: view.scopeId}),
    worktreeId: view.worktreeId,
  };
}

export interface GraphCatalogPage {
  readonly projectOffset: number;
  readonly query: string;
  readonly repository: GraphRepository;
  readonly workspaceOffset: number;
}

export interface GraphViewPage {
  readonly hasMore: boolean;
  readonly offset: number;
  readonly query: string;
  readonly repositories: readonly GraphRepositoryGroup[];
}

export interface GraphBuildStatus {
  readonly activation?: {
    readonly activity: {
      readonly elapsedMilliseconds: number;
      readonly rows?: number;
      readonly stage: GraphActivationStage;
      readonly stageElapsedMilliseconds: number;
      readonly startedAt: string;
      readonly state: 'completed' | 'progress' | 'started';
      readonly transactionMilliseconds?: number;
    };
  };
  readonly activity?: {
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
    readonly sizeBucket?: '0-16KiB' | '16-64KiB' | '64-256KiB' | '256KiB-1MiB' | '>1MiB';
    readonly stage: 'extracting' | 'persisting' | 'reading';
    readonly symbols?: number;
  };
  readonly buildId: string;
  readonly coordination?: {
    readonly lockVerified: boolean;
    readonly progressSilent?: boolean;
    readonly role: 'history' | 'owner' | 'waiter';
  };
  readonly counters: {
    readonly accepted?: number;
    readonly completed?: number;
    readonly edges?: number;
    readonly excluded?: number;
    readonly pagesCompleted?: number;
    readonly reused?: number;
    readonly resolved?: number;
    readonly rowsDeleted?: number;
    readonly skipped?: number;
    readonly symbols?: number;
    readonly total?: number;
    readonly unit?: string;
  };
  readonly error?: {readonly summary: string};
  readonly eta?: {
    readonly basis?: 'cached-fact-bytes' | 'extraction-work' | 'files' | 'final-fact-bytes' | 'source-bytes';
    readonly confidence: 'high' | 'low' | 'medium';
    readonly remainingMilliseconds: number;
  };
  readonly extraction?: {
    readonly completedFiles: number;
    readonly metrics?: {
      readonly factsBytesCompleted: number;
      readonly sourceBytesCompleted: number;
      readonly sourceBytesTotal: number;
      readonly workUnitsCompleted: number;
      readonly workUnitsTotal: number;
    };
    readonly slowFiles: number;
    readonly topSlowFiles: readonly {
      readonly classifier: string;
      readonly degraded?: boolean;
      readonly durationMilliseconds: number;
      readonly extension: string;
      readonly factsBytes?: number;
      readonly language: string;
      readonly pathHash: string;
      readonly relations?: number;
      readonly role: string;
      readonly sizeBucket: '0-16KiB' | '16-64KiB' | '64-256KiB' | '256KiB-1MiB' | '>1MiB';
      readonly sourceBytes: number;
      readonly symbols?: number;
    }[];
  };
  readonly identity: {
    readonly checkoutId: string;
    readonly commit: string;
    readonly displayName?: string;
    readonly repositoryId: string;
    readonly scopeId?: string;
    readonly worktreeId: string;
  };
  readonly managerContext?: {
    readonly branch?: string;
    readonly worktreePath: string;
  };
  readonly observation: {
    readonly heartbeatAgeMilliseconds: number;
    readonly liveness: 'abandoned' | 'active' | 'completed' | 'failed' | 'stalled';
  };
  readonly materialization?: {
    readonly activity?: {
      readonly batchCompleted: number;
      readonly batchTotal: number;
      readonly cachedFactBytes?: number;
      readonly elapsedMilliseconds?: number;
      readonly factsBytes?: number;
      readonly rows?: GraphMaterializationRows;
      readonly sourceBytes: number;
      readonly stage: GraphMaterializationStage;
      readonly stageElapsedMilliseconds?: number;
      readonly startedAt: string;
      readonly transactionMilliseconds?: number;
    };
    readonly metrics?: {
      readonly attributedFilesCompleted?: number;
      readonly attributionMilliseconds?: number;
      readonly batchesCompleted: number;
      readonly batchesTotal: number;
      readonly cachedFactBytesCompleted?: number;
      readonly cachedFactBytesTotal?: number;
      readonly cachedFactReplayBytesCompleted?: number;
      readonly changedFactBytesCompleted?: number;
      readonly crossGenerationShardFilesCompleted?: number;
      readonly exactGenerationShardFilesCompleted?: number;
      readonly fallbackReason?: string;
      readonly factsBytesCompleted?: number;
      readonly factsBytesTotal?: number;
      readonly loadingMilliseconds?: number;
      readonly materializedShardReplayBytesCompleted?: number;
      readonly mode?: 'full' | 'incremental-clean' | 'incremental-overlay';
      readonly rawFactReplayBytesCompleted?: number;
      readonly rows?: GraphMaterializationRows;
      readonly sourceBytesCompleted: number;
      readonly sourceBytesTotal: number;
      readonly stageMilliseconds?: Readonly<Partial<Record<GraphMaterializationStage, number>>>;
      readonly subphaseMilliseconds?: GraphMaterializationSubphaseMilliseconds;
      readonly storage?: GraphMaterializationStorage;
      readonly transactionMilliseconds?: number;
    };
  };
  readonly owner: {readonly processId: number; readonly processStartIdentity?: string};
  readonly phase: string;
  readonly request?: {readonly key: string};
  readonly resolution?: {
    readonly activity: {
      readonly aliasesDiscovered: number;
      readonly elapsedMilliseconds: number;
      readonly matchingMilliseconds: number;
      readonly pageCompleted: number;
      readonly pageTotal: number;
      readonly pagesCompleted: number;
      readonly pass: number;
      readonly referencesCompleted: number;
      readonly referencesExamined: number;
      readonly referencesTotal: number;
      readonly resolved: number;
      readonly startedAt: string;
      readonly transactionMilliseconds: number;
      readonly transactionStageMilliseconds?: {
        readonly preparingBatch: number;
        readonly retiringReferences: number;
        readonly updatingAnalysis: number;
        readonly writingAliases: number;
        readonly writingEdges: number;
      };
    };
  };
  readonly result?: {readonly snapshotId: string};
  readonly state: 'completed' | 'failed' | 'queued' | 'running';
  readonly subphase?: string;
  readonly timings?: {
    readonly extractionMilliseconds: number;
    readonly persistenceMilliseconds: number;
    readonly readingMilliseconds: number;
    readonly serializationMilliseconds?: number;
  };
  readonly timestamps: {
    readonly heartbeatAt: string;
    readonly lastProgressAt: string;
    readonly startedAt: string;
  };
}

export type GraphActivationStage =
  | 'checkpointing-snapshot'
  | 'committing-snapshot'
  | 'copying-edges'
  | 'copying-files'
  | 'copying-lookup-keys'
  | 'copying-reexports'
  | 'copying-symbols'
  | 'copying-terms'
  | 'copying-workspace'
  | 'recording-completion'
  | 'validating-input';

export type GraphMaterializationStage =
  | 'attributing'
  | 'committing'
  | 'loading-cache'
  | 'preparing-rows'
  | 'restoring-indexes'
  | 'writing-analysis'
  | 'writing-candidates'
  | 'writing-edges'
  | 'writing-facts'
  | 'writing-lookups'
  | 'writing-references'
  | 'writing-receipt'
  | 'writing-symbols'
  | 'writing-terms';

export interface GraphMaterializationRows {
  readonly deduplicatedEdges?: number;
  readonly deduplicatedReferences?: number;
  readonly edges?: number;
  readonly lookupKeys?: number;
  readonly referenceCandidates?: number;
  readonly references?: number;
  readonly reexports?: number;
  readonly symbols?: number;
  readonly terms?: number;
}

export interface GraphMaterializationSubphaseMilliseconds {
  readonly attributionCompute: number;
  readonly factBatchPreparation: number;
  readonly shardAssociation: number;
  readonly shardPersistence: number;
  readonly shardSerialization: number;
}

export interface GraphMaterializationStorage {
  readonly availableBytes?: number;
  readonly durableAvailableBytes?: number;
  readonly durableDatabaseBytes?: number;
  readonly durableDatabaseFileBytes?: number;
  readonly durableDatabaseFileHighWaterBytes?: number;
  readonly durableDatabaseGrowthBytes?: number;
  readonly durableDatabaseGrowthHighWaterBytes?: number;
  readonly durableDatabaseHighWaterBytes?: number;
  readonly durableDatabaseStartBytes?: number;
  readonly durableFilesystemBytes?: number;
  readonly durableFilesystemHighWaterBytes?: number;
  readonly durableJournalBytes?: number;
  readonly durableJournalHighWaterBytes?: number;
  readonly durableSharedMemoryBytes?: number;
  readonly durableSharedMemoryHighWaterBytes?: number;
  readonly durableWalBytes?: number;
  readonly durableWalHighWaterBytes?: number;
  readonly estimateBasis?: 'cached-fact-bytes' | 'final-fact-bytes' | 'source-bytes-fallback';
  readonly estimatedConcurrentBuildBytes?: number;
  readonly estimatedDurableFilesystemRequiredBytes?: number;
  readonly estimatedDurableSnapshotBytes?: number;
  readonly estimatedJournalBytes?: number;
  readonly estimatedRequiredBytes?: number;
  readonly estimatedTemporaryFilesystemRequiredBytes?: number;
  readonly estimatedTemporaryDatabaseBytes?: number;
  readonly filesystemsShared?: boolean;
  readonly materializationMode?: 'direct-persistent' | 'temporary-staged';
  readonly temporaryAvailableBytes?: number;
  readonly temporaryDatabaseBytes: number;
  readonly temporaryDatabaseHighWaterBytes: number;
}

export function graphBuildIsActive(build: GraphBuildStatus): boolean {
  return (
    (build.state === 'queued' || build.state === 'running') &&
    build.observation.liveness === 'active' &&
    build.coordination?.role !== 'history'
  );
}

export function graphBuildShouldDisplay(build: GraphBuildStatus): boolean {
  return (
    graphBuildIsActive(build) ||
    (build.state === 'failed' && codeGraphFailedBuildStatusCurrent(build.observation.heartbeatAgeMilliseconds))
  );
}

/** Keep status banners anchored to a worktree instead of moving as progress timestamps change. */
export function orderGraphBuildStatuses(
  builds: readonly GraphBuildStatus[],
  repositories: readonly GraphRepositoryGroup[] = [],
): readonly GraphBuildStatus[] {
  const location = (build: GraphBuildStatus): string => {
    const repository = repositories.find(candidate => candidate.repositoryId === build.identity.repositoryId);
    const view = repository?.views.find(
      candidate =>
        candidate.checkoutId === build.identity.checkoutId &&
        candidate.scopeId === build.identity.scopeId &&
        candidate.worktreeId === build.identity.worktreeId,
    );
    return view?.localAssociation.displayPath ?? build.managerContext?.worktreePath ?? build.identity.checkoutId;
  };
  return [...builds].sort(
    (left, right) =>
      compareCodeUnits(location(left), location(right)) ||
      compareCodeUnits(left.identity.checkoutId, right.identity.checkoutId) ||
      compareCodeUnits(left.identity.worktreeId, right.identity.worktreeId) ||
      compareCodeUnits(left.buildId, right.buildId),
  );
}

export const GRAPH_ADMINISTRATION_JOB_LIMIT = 4;

export interface GraphAdministrationJobSelection {
  readonly hiddenCount: number;
  readonly jobs: readonly GraphBuildStatus[];
  readonly total: number;
}

/** Keep administration cards focused on bounded, actionable build state. */
export function graphAdministrationJobSelection(
  builds: readonly GraphBuildStatus[],
  _waiters: readonly GraphBuildStatus[],
): GraphAdministrationJobSelection {
  const unique = new Map<string, GraphBuildStatus>();
  for (const job of builds) {
    if (graphBuildShouldDisplay(job) && !unique.has(job.buildId)) unique.set(job.buildId, job);
  }
  const relevant = [...unique.values()].sort(compareGraphAdministrationJob);
  const jobs = relevant.slice(0, GRAPH_ADMINISTRATION_JOB_LIMIT);
  return {hiddenCount: relevant.length - jobs.length, jobs, total: relevant.length};
}

export function compareGraphAdministrationJob(left: GraphBuildStatus, right: GraphBuildStatus): number {
  const priority = (job: GraphBuildStatus) => (job.state === 'running' ? 0 : job.state === 'queued' ? 1 : 2);
  return (
    priority(left) - priority(right) ||
    (Date.parse(right.timestamps.lastProgressAt) || 0) - (Date.parse(left.timestamps.lastProgressAt) || 0) ||
    compareCodeUnits(left.buildId, right.buildId)
  );
}

export function graphAdministrationInventorySummary(
  summary: Pick<CodeGraphLocalDiagnosticsReport['summary'], 'databaseCount' | 'readySnapshotCount' | 'viewCount'>,
): string {
  return [
    graphAdministrationCount(summary.databaseCount, 'graph database'),
    graphAdministrationCount(summary.readySnapshotCount, 'stored ready snapshot'),
    graphAdministrationCount(summary.viewCount, 'active worktree view'),
  ].join(' · ');
}

export function graphAdministrationCount(count: number, singular: string): string {
  return `${count.toLocaleString()} ${singular}${count === 1 ? '' : 's'}`;
}

export interface GraphBuildTarget {
  readonly repositoryLabel: string;
  readonly worktreeLabel: string;
}

export interface GraphBuildConcurrencyState {
  readonly activeTargetCommit?: string;
  readonly latestTargetCommit: string;
  readonly queuedRequests: number;
  readonly readySnapshotCommit?: string;
  readonly staleReady: boolean;
}

export function graphBuildTarget(
  build: GraphBuildStatus,
  repositories: readonly GraphRepositoryGroup[],
  configuredProjects: readonly GraphConfiguredProject[] = [],
): GraphBuildTarget {
  const repository = repositories.find(candidate => candidate.repositoryId === build.identity.repositoryId);
  const view = repository?.views.find(
    candidate =>
      candidate.checkoutId === build.identity.checkoutId &&
      candidate.scopeId === build.identity.scopeId &&
      candidate.worktreeId === build.identity.worktreeId,
  );
  const fallbackName = build.identity.displayName?.trim();
  const repositoryLabel = repository
    ? graphRepositoryOptionLabel(repository, repositories)
    : fallbackName
      ? fallbackName
      : 'Indexed repository';
  const folder = view?.localAssociation.displayPath ?? build.managerContext?.worktreePath;
  const branch = view?.localAssociation.branch
    ? `observed worktree branch ${view.localAssociation.branch}`
    : build.managerContext?.branch
      ? `build-start branch ${build.managerContext.branch}`
      : undefined;
  return {
    repositoryLabel: graphRepositoryScopeLabel(repositoryLabel, build.identity.scopeId, configuredProjects),
    worktreeLabel:
      ([branch, folder].filter((value): value is string => value !== undefined).join(' · ') || view?.label) ??
      `Local folder unavailable · commit ${build.identity.commit.slice(0, 8) || 'unknown'}`,
  };
}

/** Present one opaque graph-scope identity as its configured project name when available. */
export function graphRepositoryScopeLabel(
  repositoryLabel: string,
  scopeId: string | undefined,
  configuredProjects: readonly Pick<GraphConfiguredProject, 'name' | 'scopeId'>[] = [],
): string {
  if (scopeId === undefined) return repositoryLabel;
  const project = configuredProjects.find(candidate => candidate.scopeId === scopeId);
  const fallback = scopeId.startsWith('code-graph-scope:')
    ? `scope ${scopeId.slice('code-graph-scope:'.length, 'code-graph-scope:'.length + 8)}`
    : 'scoped graph';
  return `${repositoryLabel}: ${project?.name ?? fallback}`;
}

/** A repository-level selector can name one scope only when its view inventory is complete. */
export function graphRepositoryGroupScopeId(
  repository: Pick<GraphRepositoryGroup, 'views' | 'viewsTruncated'>,
): string | undefined {
  return repository.views.length === 1 && !repository.viewsTruncated ? repository.views[0]?.scopeId : undefined;
}

/** Resolve project-name catalog searches to their opaque scoped-view identities. */
export function graphConfiguredProjectScopeIds(
  query: string,
  configuredProjects: readonly Pick<GraphConfiguredProject, 'name' | 'scopeId'>[] = [],
): readonly string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  return [
    ...new Set(
      configuredProjects.flatMap(project =>
        project.scopeId !== undefined && project.name.toLowerCase().includes(needle) ? [project.scopeId] : [],
      ),
    ),
  ]
    .sort(compareCodeUnits)
    .slice(0, MANAGER_GRAPH_CATALOG_SCOPE_SEARCH_LIMIT);
}

/** Select the exact scoped diagnostics view for one build or waiter row. */
export function graphAdministrationJobView(
  views: CodeGraphLocalDiagnosticsReport['databases'][number]['views'],
  job: Pick<GraphBuildStatus, 'identity'>,
): CodeGraphLocalDiagnosticsReport['databases'][number]['views'][number] | undefined {
  return views.find(
    candidate => candidate.viewWorktreeId === job.identity.worktreeId && candidate.viewScopeId === job.identity.scopeId,
  );
}

/**
 * Summarize only observed concurrency facts. File locks do not promise FIFO, so
 * waiters are counted without claiming an execution position. The most recent
 * request is the latest requested target, independent of input ordering.
 */
export function graphBuildConcurrencyState(
  build: GraphBuildStatus,
  waiters: readonly GraphBuildStatus[],
  repositories: readonly GraphRepositoryGroup[],
): GraphBuildConcurrencyState {
  const matchingWaiters = waiters.filter(
    waiter =>
      waiter.buildId !== build.buildId &&
      waiter.identity.checkoutId === build.identity.checkoutId &&
      waiter.identity.scopeId === build.identity.scopeId &&
      waiter.identity.worktreeId === build.identity.worktreeId,
  );
  const latest = [build, ...matchingWaiters].sort(compareGraphBuildRequest)[matchingWaiters.length];
  const repository = repositories.find(candidate => candidate.repositoryId === build.identity.repositoryId);
  const ready = repository?.views.find(
    candidate =>
      candidate.checkoutId === build.identity.checkoutId &&
      candidate.scopeId === build.identity.scopeId &&
      candidate.worktreeId === build.identity.worktreeId,
  );
  const queuedRequests = matchingWaiters.length;
  const readySnapshotCommit = ready?.snapshot.commit;
  return {
    ...(build.state === 'running' ? {activeTargetCommit: build.identity.commit} : {}),
    latestTargetCommit: latest.identity.commit,
    queuedRequests,
    ...(readySnapshotCommit === undefined ? {} : {readySnapshotCommit}),
    staleReady: readySnapshotCommit !== undefined && !graphCommitMatches(readySnapshotCommit, latest.identity.commit),
  };
}

export function compareGraphBuildRequest(left: GraphBuildStatus, right: GraphBuildStatus): number {
  const leftStartedAt = Date.parse(left.timestamps.startedAt) || 0;
  const rightStartedAt = Date.parse(right.timestamps.startedAt) || 0;
  return leftStartedAt - rightStartedAt || compareCodeUnits(left.buildId, right.buildId);
}

export function graphCommitMatches(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

export function graphStatusPollDelay(
  builds: readonly GraphBuildStatus[],
  maintenance?: CodeGraphMaintenanceStatus,
  lifecyclePending = false,
  automaticCompaction?: CodeGraphAutomaticCompactionStatus,
): number {
  return builds.some(graphBuildIsActive) ||
    maintenance !== undefined ||
    lifecyclePending ||
    automaticCompaction?.state === 'inspecting' ||
    automaticCompaction?.state === 'running'
    ? 1_000
    : 5_000;
}

/** Keep live build activity visible even when the full catalog request has not completed. */
export function mergeGraphCatalogStatus(
  catalog: GraphCatalog | undefined,
  status: Pick<
    GraphCatalog,
    | 'automaticCompaction'
    | 'builds'
    | 'catalogRevision'
    | 'lifecyclePending'
    | 'reconciliation'
    | 'maintenance'
    | 'storage'
    | 'waiterCount'
    | 'waiters'
  >,
): GraphCatalog {
  const base = catalog ?? {
    builds: [],
    diagnostics: [],
    repositories: [],
    waiterCount: 0,
    waiters: [],
  };
  const {
    maintenance: _previousMaintenance,
    reconciliation: _previousReconciliation,
    ...catalogWithoutMaintenance
  } = base;
  return {
    ...catalogWithoutMaintenance,
    ...status,
    ...(status.catalogRevision === undefined && base.catalogRevision !== undefined
      ? {catalogRevision: base.catalogRevision}
      : {}),
    ...(status.storage === undefined && base.storage !== undefined ? {storage: base.storage} : {}),
    ...(status.automaticCompaction === undefined && base.automaticCompaction !== undefined
      ? {automaticCompaction: base.automaticCompaction}
      : {}),
  };
}

export type GraphStorageSummary = ManagerGraphStorageSummary;

export function graphAdministrationBusyLabel(
  busy: string | undefined,
  catalog: GraphCatalog | undefined,
): string | undefined {
  return busy ?? (catalog?.maintenance ? graphMaintenanceStatusLabel(catalog.maintenance) : undefined);
}

export function graphMaintenanceStatusLabel(status: CodeGraphMaintenanceStatus): string {
  const operation = status.operation === 'selected-snapshot-purge' ? 'Selected snapshot purge' : 'Graph maintenance';
  const phases: Record<CodeGraphMaintenanceStatus['phase'], string> = {
    'acquiring-gates': status.operation === 'selected-snapshot-purge' ? 'acquiring safety gates' : 'acquiring locks',
    'retiring-and-cleaning':
      status.operation === 'selected-snapshot-purge'
        ? 'retiring snapshot and advancing cleanup'
        : 'cleaning derived state',
    'status-unavailable': 'working; detailed status unavailable',
    'verifying-graph':
      status.operation === 'selected-snapshot-purge' ? 'rechecking graph safety evidence' : 'verifying graph store',
    'verifying-vectors':
      status.operation === 'selected-snapshot-purge' ? 'rechecking vector safety evidence' : 'verifying related files',
    'waiting-builders': 'waiting for graph builders',
    working: 'working',
  };
  return `${operation} · ${phases[status.phase]}`;
}

export function graphMaintenanceRemainingMilliseconds(
  status: Pick<CodeGraphMaintenanceStatus, 'completed' | 'startedAt' | 'total'>,
  nowMilliseconds: number,
): number | undefined {
  if (
    status.completed === undefined ||
    status.total === undefined ||
    status.startedAt === undefined ||
    status.total <= 0 ||
    status.completed <= 0 ||
    status.completed > status.total
  ) {
    return undefined;
  }
  if (status.completed === status.total) return 0;
  const elapsed = nowMilliseconds - Date.parse(status.startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  return Math.round((elapsed / status.completed) * (status.total - status.completed));
}

export function graphCompletedBuildResultIdentity(build: GraphBuildStatus): string | undefined {
  return build.state === 'completed' && build.result !== undefined
    ? `${build.buildId}:${build.result.snapshotId}`
    : undefined;
}

/**
 * A status-only catalog keeps progress visible while the authoritative catalog
 * is maintenance-busy. Once maintenance releases, it must never become the
 * terminal empty state: the next poll retries the full catalog automatically.
 */
export function graphCatalogRequiresAuthoritativeRefresh(
  authoritativeCatalogLoaded: boolean,
  maintenance?: CodeGraphMaintenanceStatus,
): boolean {
  return !authoritativeCatalogLoaded && maintenance === undefined;
}

export type GraphCatalogEmptyState = 'building' | 'empty' | 'recovering' | 'retrying';

/** Keep maintenance evidence separate from cause-neutral catalog retry failures. */
export function graphCatalogEmptyState(input: {
  readonly automaticCompaction?: CodeGraphAutomaticCompactionStatus;
  readonly builds: readonly GraphBuildStatus[];
  readonly catalogError?: string;
  readonly lifecyclePending?: boolean;
  readonly maintenance?: CodeGraphMaintenanceStatus;
}): GraphCatalogEmptyState {
  if (
    input.maintenance !== undefined ||
    input.lifecyclePending === true ||
    input.automaticCompaction?.state === 'inspecting' ||
    input.automaticCompaction?.state === 'running'
  ) {
    return 'recovering';
  }
  if (input.builds.some(graphBuildIsActive)) return 'building';
  return input.catalogError ? 'retrying' : 'empty';
}

export function graphStatusRequiresCatalogRefresh(
  catalog: GraphCatalog | undefined,
  builds: readonly GraphBuildStatus[],
  acknowledgedResults: ReadonlySet<string> = new Set(),
  observedCatalogRevision?: string,
): boolean {
  if (
    catalog !== undefined &&
    observedCatalogRevision !== undefined &&
    catalog.catalogRevision !== observedCatalogRevision
  ) {
    return true;
  }
  if (!catalog) {
    return builds.some(build => {
      const identity = graphCompletedBuildResultIdentity(build);
      return identity !== undefined && !acknowledgedResults.has(identity);
    });
  }
  return builds.some(build => {
    const identity = graphCompletedBuildResultIdentity(build);
    const resultVisible = catalog.repositories.some(
      repository =>
        repository.repositoryId === build.identity.repositoryId &&
        repository.views.some(
          view =>
            view.checkoutId === build.identity.checkoutId &&
            view.scopeId === build.identity.scopeId &&
            view.worktreeId === build.identity.worktreeId &&
            view.snapshot.id === build.result?.snapshotId,
        ),
    );
    return identity !== undefined && !acknowledgedResults.has(identity) && !resultVisible;
  });
}

export function graphDiagnosticsRequiresCatalogRefresh(
  diagnosticsCatalogRevision: string | undefined,
  observedCatalogRevision: string | undefined,
  maintenance?: CodeGraphMaintenanceStatus,
): boolean {
  return (
    maintenance === undefined &&
    observedCatalogRevision !== undefined &&
    diagnosticsCatalogRevision !== observedCatalogRevision
  );
}

export function graphWaiterCountForBuild(build: GraphBuildStatus, waiters: readonly GraphBuildStatus[]): number {
  return waiters.filter(
    waiter =>
      waiter.buildId !== build.buildId &&
      waiter.identity.checkoutId === build.identity.checkoutId &&
      waiter.identity.scopeId === build.identity.scopeId &&
      waiter.identity.worktreeId === build.identity.worktreeId &&
      waiter.request?.key === build.request?.key,
  ).length;
}

export function resolveGraphSelection(
  repositories: readonly GraphRepositoryGroup[],
  currentRepositoryId: string,
  currentViewId: string,
): {readonly repositoryId: string; readonly viewId: string} {
  const repository = repositories.find(candidate => candidate.id === currentRepositoryId) ?? repositories[0];
  if (!repository) return {repositoryId: '', viewId: ''};
  const view = repository.views.find(candidate => candidate.id === currentViewId);
  return {
    repositoryId: repository.id,
    viewId: view?.id ?? repository.defaultViewId ?? repository.views[0]?.id ?? '',
  };
}

export function graphRepositoryOptionLabel(
  repository: GraphRepositoryGroup,
  repositories: readonly GraphRepositoryGroup[],
): string {
  const collides = repositories.some(
    candidate => candidate.id !== repository.id && candidate.displayName === repository.displayName,
  );
  if (!collides) return repository.displayName;
  const folder = repository.views.find(view => view.localAssociation.displayPath)?.localAssociation.displayPath;
  return `${repository.displayName} · ${folder ?? `repository ${repository.id.slice(0, 8)}`}`;
}

export function shortGraphIdentity(value: string): string {
  return value.slice(-8) || 'unknown';
}

export function mergeGraphRepositoryGroups(
  current: readonly GraphRepositoryGroup[],
  additions: readonly GraphRepositoryGroup[],
): readonly GraphRepositoryGroup[] {
  const groups = new Map(current.map(group => [group.id, {...group, views: [...group.views]}]));
  for (const addition of additions) {
    const existing = groups.get(addition.id);
    if (!existing) {
      groups.set(addition.id, {...addition, views: [...addition.views]});
      continue;
    }
    const views = new Map(existing.views.map(view => [view.id, view]));
    for (const view of addition.views) {
      const currentView = views.get(view.id);
      views.set(view.id, currentView ? mergeGraphRepository(currentView, view) : view);
    }
    groups.set(addition.id, {
      ...existing,
      defaultViewId: existing.defaultViewId || addition.defaultViewId,
      views: [...views.values()],
      viewsTruncated: existing.viewsTruncated || addition.viewsTruncated,
    });
  }
  return [...groups.values()].sort(
    (left, right) => compareCodeUnits(left.displayName, right.displayName) || compareCodeUnits(left.id, right.id),
  );
}

export function graphCatalogPageOffsets(input: {
  readonly baseRepository?: GraphRepository;
  readonly baseRepositoryGroup?: GraphRepositoryGroup;
  readonly checkoutId: string;
  readonly continuation?: {
    readonly projectOffset: number;
    readonly viewId: string;
    readonly viewOffset: number;
    readonly workspaceOffset: number;
  };
  readonly viewId: string;
}): {readonly projectOffset: number; readonly viewOffset: number; readonly workspaceOffset: number} {
  const continuation = input.continuation?.viewId === input.viewId ? input.continuation : undefined;
  return {
    projectOffset:
      continuation?.projectOffset ??
      input.baseRepository?.projects.filter(project => project.id.startsWith('cgp_')).length ??
      0,
    viewOffset:
      continuation?.viewOffset ??
      input.baseRepositoryGroup?.views.filter(view => view.checkoutId === input.checkoutId).length ??
      0,
    workspaceOffset: continuation?.workspaceOffset ?? input.baseRepository?.workspaces.length ?? 0,
  };
}

export function mergeGraphRepository(current: GraphRepository, addition: GraphRepository): GraphRepository {
  if (current.snapshot.id !== addition.snapshot.id) {
    const currentTime = Date.parse(current.activatedAt ?? current.snapshot.completedAt ?? '') || 0;
    const additionTime = Date.parse(addition.activatedAt ?? addition.snapshot.completedAt ?? '') || 0;
    return additionTime > currentTime ? addition : current;
  }
  const projects = new Map(current.projects.map(project => [project.id, project]));
  for (const project of addition.projects) projects.set(project.id, project);
  const workspaces = new Map(current.workspaces.map(workspace => [workspace.id, workspace]));
  for (const workspace of addition.workspaces) workspaces.set(workspace.id, workspace);
  return {
    ...current,
    ...addition,
    projectCount: Math.max(current.projectCount, addition.projectCount),
    projects: [...projects.values()],
    projectsTruncated: current.projectsTruncated || addition.projectsTruncated,
    workspaceCount: Math.max(current.workspaceCount, addition.workspaceCount),
    workspaces: [...workspaces.values()],
    workspacesTruncated: current.workspacesTruncated || addition.workspacesTruncated,
  };
}

export interface GraphNode {
  readonly degree: number;
  readonly exported?: boolean;
  readonly fileCount?: number;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly language?: string;
  readonly packageName?: string;
  readonly path?: string;
  readonly projectId: string;
  readonly qualifiedName?: string;
  readonly signature?: string;
  readonly symbolCount?: number;
  readonly type: 'project' | 'symbol';
}

export interface GraphEdge {
  readonly confidence: number;
  readonly count: number;
  readonly id: string;
  readonly provenance: string;
  readonly relation: string;
  readonly sourceId: string;
  readonly targetId: string;
}

export interface GraphSpan {
  readonly column: number;
  readonly endColumn: number;
  readonly endLine: number;
  readonly line: number;
}

export interface GraphNodeDetail {
  readonly node: {
    readonly documentation?: string;
    readonly exported: boolean;
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly language: string;
    readonly packageName?: string;
    readonly path: string;
    readonly projectId: string;
    readonly qualifiedName: string;
    readonly signature?: string;
    readonly span: GraphSpan;
  };
  readonly relationships: readonly {
    readonly confidence: number;
    readonly direction: 'incoming' | 'outgoing';
    readonly evidencePath: string;
    readonly evidenceSpan: GraphSpan;
    readonly id: string;
    readonly provenance: string;
    readonly related: {
      readonly id?: string;
      readonly kind?: string;
      readonly label: string;
      readonly path?: string;
      readonly projectId?: string;
      readonly qualifiedName?: string;
    };
    readonly relation: string;
  }[];
  readonly snapshotId: string;
  readonly stats: {
    readonly incoming: number;
    readonly outgoing: number;
    readonly sampledEdges?: number;
    readonly summaryTruncated?: boolean;
    readonly provenances: readonly {readonly count: number; readonly provenance: string}[];
    readonly relations: readonly {
      readonly count: number;
      readonly incoming: number;
      readonly outgoing: number;
      readonly relation: string;
    }[];
    readonly truncated: boolean;
  };
}

export function graphRelationshipCountLabel(count: number, sampled: boolean): string {
  return `${sampled ? '≥' : ''}${Math.max(0, count).toLocaleString()}`;
}

export function graphRelationshipSampleLabel(detail: GraphNodeDetail): string | undefined {
  if (detail.stats.summaryTruncated !== true) return undefined;
  const sampledEdges = detail.stats.sampledEdges ?? detail.stats.incoming + detail.stats.outgoing;
  return `Counts are lower bounds from a ${sampledEdges.toLocaleString()}-edge sample.`;
}

export function graphDisplayEdges(
  edges: readonly GraphEdge[],
  selectedNodeId: string | undefined,
  focusMode: GraphFocusMode,
  relationFilter: string,
): readonly GraphEdge[] {
  const related = relationFilter === 'all' ? edges : edges.filter(edge => edge.relation === relationFilter);
  if (!selectedNodeId || focusMode === 'all') return related;
  return related.filter(edge => {
    if (focusMode === 'incoming') return edge.targetId === selectedNodeId;
    if (focusMode === 'outgoing') return edge.sourceId === selectedNodeId;
    return edge.sourceId === selectedNodeId || edge.targetId === selectedNodeId;
  });
}

export function graphAnalysisRequestIsCurrent(
  currentSequence: number,
  requestedSequence: number,
  currentScope: string,
  requestedScope: string,
): boolean {
  return currentSequence === requestedSequence && currentScope === requestedScope;
}

export function graphRequestIsCurrent(
  currentSequence: number,
  requestedSequence: number,
  currentScope: string,
  requestedScope: string,
): boolean {
  return currentSequence === requestedSequence && currentScope === requestedScope;
}

export function graphQueryRequestIsCurrent(
  aborted: boolean,
  currentSequence: number,
  requestedSequence: number,
  currentScope: string,
  requestedScope: string,
  graph: GraphQueryVisualization,
  expectedSnapshotId: string,
  expectedQuery: string,
): boolean {
  return (
    !aborted &&
    graphRequestIsCurrent(currentSequence, requestedSequence, currentScope, requestedScope) &&
    graph.repository.snapshot.id === expectedSnapshotId &&
    graph.query.state === 'ready' &&
    graph.query.text.trim() === expectedQuery
  );
}

export interface GraphQueryRequestInput {
  readonly expectedQuery: string;
  readonly expectedSnapshotId: string;
  readonly scope: string;
}

export type GraphQueryRequestOutcome =
  | {readonly graph: GraphQueryVisualization; readonly state: 'accepted'}
  | {readonly cause: unknown; readonly state: 'failed'}
  | {readonly state: 'cancelled'}
  | {readonly graph: GraphQueryVisualization; readonly state: 'stale'};

export interface GraphQueryRequestHandle {
  readonly cancel: () => void;
  readonly isCurrent: () => boolean;
  readonly result: Promise<GraphQueryRequestOutcome>;
}

export interface GraphQueryRequestGate {
  readonly cancelCurrent: () => void;
  readonly request: (
    input: GraphQueryRequestInput,
    load: (signal: AbortSignal) => Promise<GraphQueryVisualization>,
  ) => GraphQueryRequestHandle;
}

/**
 * Owns the same supersession boundary used by the Manager graph-query UI.
 *
 * A new request aborts the previous signal. The sequence, scope, snapshot, and
 * query checks remain mandatory even when a loader ignores cancellation and
 * eventually delivers a late response.
 */
export function createGraphQueryRequestGate(): GraphQueryRequestGate {
  let currentController: AbortController | undefined;
  let currentScope = '';
  let currentSequence = 0;

  const cancelCurrent = (): void => {
    currentController?.abort();
    currentController = undefined;
    currentScope = '';
    currentSequence += 1;
  };

  return {
    cancelCurrent,
    request: (input, load) => {
      currentController?.abort();
      const controller = new AbortController();
      const requestedSequence = currentSequence + 1;
      currentController = controller;
      currentScope = input.scope;
      currentSequence = requestedSequence;
      const isCurrent = (): boolean =>
        currentController === controller &&
        graphRequestIsCurrent(currentSequence, requestedSequence, currentScope, input.scope);
      const cancel = (): void => {
        if (!isCurrent()) return;
        cancelCurrent();
      };
      let pending: Promise<GraphQueryVisualization>;
      try {
        pending = load(controller.signal);
      } catch (cause) {
        pending = Promise.reject(cause);
      }
      const result = pending.then<GraphQueryRequestOutcome, GraphQueryRequestOutcome>(
        graph =>
          graphQueryRequestIsCurrent(
            controller.signal.aborted,
            currentSequence,
            requestedSequence,
            currentScope,
            input.scope,
            graph,
            input.expectedSnapshotId,
            input.expectedQuery,
          )
            ? {graph, state: 'accepted'}
            : {graph, state: 'stale'},
        cause =>
          controller.signal.aborted || isAbortError(cause)
            ? {state: 'cancelled'}
            : isCurrent()
              ? {cause, state: 'failed'}
              : {state: 'cancelled'},
      );
      return {cancel, isCurrent, result};
    },
  };
}

export function graphNodeDetailRequestIsCurrent(
  aborted: boolean,
  detail: Pick<GraphNodeDetail, 'node' | 'snapshotId'>,
  expectedSnapshotId: string,
  expectedNodeId: string,
): boolean {
  return !aborted && detail.snapshotId === expectedSnapshotId && detail.node.id === expectedNodeId;
}

export function cacheGraphNodeDetail(
  cache: Map<string, GraphNodeDetail>,
  key: string,
  detail: GraphNodeDetail,
  limit = 128,
): void {
  cache.delete(key);
  cache.set(key, detail);
  while (cache.size > Math.max(1, limit)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function graphWithNodeNeighborhood(graph: GraphVisualization, detail: GraphNodeDetail): GraphVisualization {
  if (graph.mode !== 'detail') return graph;
  const nodesById = new Map(graph.nodes.slice(0, MANAGER_GRAPH_MAX_NODE_LIMIT).map(node => [node.id, node]));
  const existingRoot = nodesById.get(detail.node.id);
  if (existingRoot || nodesById.size < MANAGER_GRAPH_MAX_NODE_LIMIT) {
    nodesById.set(detail.node.id, {
      ...existingRoot,
      degree: existingRoot?.degree ?? 0,
      exported: detail.node.exported,
      id: detail.node.id,
      kind: detail.node.kind,
      label: detail.node.label,
      language: detail.node.language,
      packageName: detail.node.packageName,
      path: detail.node.path,
      projectId: detail.node.projectId,
      qualifiedName: detail.node.qualifiedName,
      signature: detail.node.signature,
      type: 'symbol',
    });
  }

  const edgesById = new Map(graph.edges.slice(0, MANAGER_GRAPH_MAX_EDGE_LIMIT).map(edge => [edge.id, edge]));
  let truncated = graph.nodes.length > nodesById.size || graph.edges.length > edgesById.size;
  for (const relationship of detail.relationships.slice(0, MAX_EXPANDED_NEIGHBOR_EDGES)) {
    const relatedId = relationship.related.id;
    if (!relatedId || relatedId === detail.node.id) continue;
    if (!nodesById.has(relatedId)) {
      if (nodesById.size >= MANAGER_GRAPH_MAX_NODE_LIMIT) {
        truncated = true;
        continue;
      }
      nodesById.set(relatedId, {
        degree: 0,
        id: relatedId,
        kind: relationship.related.kind ?? 'symbol',
        label: relationship.related.label,
        path: relationship.related.path,
        projectId: relationship.related.projectId ?? detail.node.projectId,
        qualifiedName: relationship.related.qualifiedName,
        type: 'symbol',
      });
    }
    if (!edgesById.has(relationship.id)) {
      if (edgesById.size >= MANAGER_GRAPH_MAX_EDGE_LIMIT || !nodesById.has(detail.node.id)) {
        truncated = true;
        continue;
      }
      const outgoing = relationship.direction === 'outgoing';
      edgesById.set(relationship.id, {
        confidence: relationship.confidence,
        count: 1,
        id: relationship.id,
        provenance: relationship.provenance,
        relation: relationship.relation,
        sourceId: outgoing ? detail.node.id : relatedId,
        targetId: outgoing ? relatedId : detail.node.id,
      });
    }
  }

  const edges = [...edgesById.values()];
  const degrees = graphNodeSizeValues(edges, 'connections');
  const nodes = [...nodesById.values()].map(node => ({...node, degree: degrees.get(node.id) ?? 0}));
  const addedNodes = nodes.length - graph.nodes.length;
  return {
    ...graph,
    edges,
    nodes,
    stats: {
      ...graph.stats,
      renderedEdges: edges.length,
      renderedNodes: nodes.length,
    },
    paging: {...graph.paging, hasMore: graph.paging.hasMore || truncated || detail.stats.truncated},
    warnings: [
      ...graph.warnings,
      ...(addedNodes > 0 ? [`Loaded ${addedNodes.toLocaleString()} direct neighbors for ${detail.node.label}.`] : []),
      ...(truncated ? ['Direct-neighbor expansion reached the global Manager graph budget.'] : []),
    ],
  };
}

export interface GraphVisualization {
  readonly edges: readonly GraphEdge[];
  readonly mode: 'detail' | 'overview';
  readonly nodes: readonly GraphNode[];
  readonly paging: {
    readonly edgeLimit: number;
    readonly hasMore: boolean;
    readonly nodeLimit: number;
  };
  readonly projectId: string;
  readonly query?: GraphQueryMetadata;
  readonly repository: Pick<GraphRepository, 'accounting' | 'displayName' | 'id' | 'metrics' | 'snapshot'>;
  readonly scope: {readonly id: string; readonly label: string};
  readonly stats: {
    readonly renderedEdges: number;
    readonly renderedNodes: number;
    readonly totalEdges: number;
    readonly totalNodes: number;
  };
  readonly warnings: readonly string[];
}

export interface GraphQueryMetadata {
  readonly matchedNodes: number;
  readonly state: 'ready';
  readonly text: string;
  readonly warnings: readonly string[];
}

export interface GraphQueryVisualization extends GraphVisualization {
  readonly query: GraphQueryMetadata;
}

export interface GraphCatalogContinuation {
  readonly projectOffset: number;
  readonly projectHasMore: boolean;
  readonly viewOffset: number;
  readonly viewHasMore: boolean;
  readonly viewId: string;
  readonly workspaceOffset: number;
  readonly workspaceHasMore: boolean;
}

export interface GraphCatalogSearchOptions {
  readonly projects: readonly {
    readonly description: string;
    readonly id: string;
    readonly label: string;
    readonly viewId: string;
  }[];
  readonly views: readonly {
    readonly description: string;
    readonly id: string;
    readonly label: string;
    readonly repositoryId: string;
  }[];
}

export function graphCatalogSearchOptions(
  repository: GraphRepository,
  repositories: readonly GraphRepositoryGroup[],
  configuredProjects: readonly Pick<GraphConfiguredProject, 'name' | 'scopeId'>[] = [],
): GraphCatalogSearchOptions {
  const workspaces = new Map(repository.workspaces.map(workspace => [workspace.id, workspace]));
  const projects = repository.projects
    .map(project => {
      const workspace = project.workspaceId ? workspaces.get(project.workspaceId) : undefined;
      return {
        description: [workspace?.name, graphProjectBadge(project)].filter(Boolean).join(' · '),
        id: project.id,
        label: project.label,
        viewId: repository.id,
      };
    })
    .sort((left, right) => compareCodeUnits(left.label, right.label) || compareCodeUnits(left.id, right.id));
  const viewsById = new Map<
    string,
    {readonly description: string; readonly id: string; readonly label: string; readonly repositoryId: string}
  >();
  for (const group of repositories) {
    for (const view of group.views) {
      viewsById.set(view.id, {
        description: `${group.displayName} · ${view.snapshot.commit.slice(0, 8)}${view.snapshot.dirty ? ' · dirty' : ''}${view.localAssociation.branch ? ` · observed branch ${view.localAssociation.branch}` : ''} · folder ${graphLocalAssociationText(view.localAssociation)}`,
        id: view.id,
        label: graphRepositoryScopeLabel(view.label, view.scopeId, configuredProjects),
        repositoryId: group.id,
      });
    }
  }
  return {
    projects,
    views: [...viewsById.values()].sort(
      (left, right) => compareCodeUnits(left.label, right.label) || compareCodeUnits(left.id, right.id),
    ),
  };
}

export function graphCatalogContinuationHasMore(
  continuation: GraphCatalogContinuation | undefined,
  viewId: string | undefined,
  field: 'projectHasMore' | 'viewHasMore' | 'workspaceHasMore',
  fallback: boolean,
): boolean {
  return continuation !== undefined && continuation.viewId === viewId ? continuation[field] : fallback;
}

export interface GraphAnalysis {
  readonly communities: readonly {
    readonly id: string;
    readonly label: string;
    readonly memberCount: number;
  }[];
  readonly coverage: {
    readonly complete: boolean;
    readonly nodesComplete: boolean;
    readonly topology: {
      readonly complete: boolean;
      readonly state: 'complete' | 'not-requested' | 'partial' | 'unavailable';
    };
  };
  readonly hubs: readonly {
    readonly classification: 'god-node' | 'hub';
    readonly degree: number;
    readonly node: {readonly label: string; readonly path: string};
  }[];
  readonly statistics: {
    readonly analyzedEdgeCount: number;
    readonly analyzedNodeCount: number;
    readonly communityCount: number;
    readonly connectedComponentCount: number;
    readonly maximumDegree: number;
  };
  readonly surprisingLinks: readonly {
    readonly relation: string;
    readonly score: number;
    readonly source: {readonly label: string};
    readonly target: {readonly label: string};
  }[];
  readonly warnings: readonly string[];
}

export function graphAnalysisTopologyAvailable(analysis: GraphAnalysis): boolean {
  return analysis.coverage.topology.state === 'complete' || analysis.coverage.topology.state === 'partial';
}

export function graphAnalysisCoverageLabel(analysis: GraphAnalysis): string {
  switch (analysis.coverage.topology.state) {
    case 'complete':
      return analysis.coverage.complete ? 'Complete' : 'Topology complete';
    case 'partial':
      return analysis.coverage.nodesComplete ? 'Topology partial' : 'Bounded topology';
    case 'not-requested':
      return 'Topology not requested';
    case 'unavailable':
      return 'Topology unavailable';
  }
}

export interface PositionedNode extends GraphNode {
  readonly color: THREE.Color;
  readonly radius: number;
  readonly x: number;
  readonly y: number;
}

export interface GraphLayout {
  readonly bounds: {readonly height: number; readonly width: number};
  readonly nodes: readonly PositionedNode[];
  readonly nodesById: ReadonlyMap<string, PositionedNode>;
}

export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

export interface GraphLabelSize {
  readonly height: number;
  readonly width: number;
}

export interface GraphRuntime {
  readonly camera: THREE.OrthographicCamera;
  readonly edgePosition: THREE.BufferAttribute;
  readonly edges: readonly GraphEdge[];
  readonly highlightPosition?: THREE.BufferAttribute;
  readonly highlightedEdges: readonly GraphEdge[];
  readonly nodeIds: readonly string[];
  readonly nodePosition: THREE.BufferAttribute;
  readonly pointMaterials: readonly THREE.ShaderMaterial[];
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly selectedNodeId?: string;
  readonly selectedPosition?: THREE.BufferAttribute;
}

export interface ViewState {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export type GraphFocusMode = 'all' | 'incoming' | 'neighbors' | 'outgoing';
export type GraphSizeMetric = 'connections' | 'incoming' | 'outgoing';

export const GRAPH_PALETTE = ['#67e8c7', '#7aa2ff', '#c08cff', '#ff9f7a', '#f7d56b', '#75d8ff', '#ef88b7', '#9be27d'];
export const SELECTED_NODE_COLOR = '#ff4fd8';
export const MIN_ZOOM = 0.32;
export const MAX_ZOOM = 8;
export const DEFAULT_WORKING_SET = {
  edgeLimit: MANAGER_GRAPH_DEFAULT_EDGE_LIMIT,
  nodeLimit: MANAGER_GRAPH_DEFAULT_NODE_LIMIT,
} as const;
export const MAX_WORKING_SET = {
  edgeLimit: MANAGER_GRAPH_MAX_EDGE_LIMIT,
  nodeLimit: MANAGER_GRAPH_MAX_NODE_LIMIT,
} as const;
export const MAX_ANIMATED_NEIGHBOR_EDGES = 120;
export const MAX_EXPANDED_NEIGHBOR_EDGES = 160;
export const MAX_FOCUSED_LABELS = 24;
export const FOCUS_LAYOUT_ZOOM = 2.8;
export const SEARCH_FOCUS_ZOOM = {
  detail: 2.8,
  overview: 1.8,
} as const;
export const GRAPH_QUERY_DEBOUNCE_MILLISECONDS = 450;
export const GRAPH_QUERY_MINIMUM_LENGTH = 3;
export const GRAPH_QUERY_MAXIMUM_LENGTH = 512;
export const DEFAULT_QUERY_WORKING_SET = {edgeLimit: 240, nodeLimit: 120} as const;
export const MAX_QUERY_WORKING_SET = {edgeLimit: 500, nodeLimit: 200} as const;

export function managerGraphQueryCandidate(input: string): string | undefined {
  const candidate = input.trim();
  return candidate.length > 0 && candidate.length <= GRAPH_QUERY_MAXIMUM_LENGTH ? candidate : undefined;
}

export function managerGraphDebouncedQueryCandidate(input: string): string | undefined {
  const candidate = managerGraphQueryCandidate(input);
  return candidate && candidate.length >= GRAPH_QUERY_MINIMUM_LENGTH ? candidate : undefined;
}

export function graphOverviewSizeLabel(graph: GraphVisualization): string {
  return graph.repository.metrics === 'complete' && graph.nodes.some(node => node.symbolCount !== undefined)
    ? 'Component symbols'
    : 'Visible relationship degree';
}
export function graphLocalAssociationText(association: CodeGraphLocalAssociation): string {
  return association.displayPath ?? association.state.replaceAll('-', ' ');
}
export function graphNodeSizeValues(
  edges: readonly Pick<GraphEdge, 'sourceId' | 'targetId'>[],
  metric: GraphSizeMetric,
): ReadonlyMap<string, number> {
  const connected = new Map<string, Set<string>>();
  const add = (nodeId: string, neighborId: string): void => {
    const neighbors = connected.get(nodeId) ?? new Set<string>();
    neighbors.add(neighborId);
    connected.set(nodeId, neighbors);
  };
  for (const edge of edges) {
    if (edge.sourceId === edge.targetId) continue;
    if (metric !== 'incoming') add(edge.sourceId, edge.targetId);
    if (metric !== 'outgoing') add(edge.targetId, edge.sourceId);
  }
  return new Map([...connected].map(([nodeId, neighbors]) => [nodeId, neighbors.size]));
}
export function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException
    ? cause.name === 'AbortError'
    : cause instanceof Error && cause.name === 'AbortError';
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {maximumFractionDigits: 1, notation: 'compact'}).format(value);
}

export function graphProjectBadge(project: GraphProject): string {
  if (project.model === 'legacy-fallback') return 'legacy group';
  if (project.model === 'facet') return 'facet';
  return project.buildSystem ? `${project.buildSystem} ${project.kind ?? 'component'}` : (project.kind ?? 'component');
}

export function relationLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function sizeMetricLabel(metric: GraphSizeMetric): string {
  switch (metric) {
    case 'incoming':
      return 'Distinct incoming neighbors';
    case 'outgoing':
      return 'Distinct outgoing neighbors';
    default:
      return 'Distinct connections';
  }
}

export function sourceBreadcrumb(projectId: string, path: string): readonly string[] {
  const project = projectId.replace(/^[^:]+:/, '');
  const parts = path.split('/').filter(Boolean);
  const compactPath = parts.length > 4 ? [...parts.slice(0, 2), '…', ...parts.slice(-2)] : parts;
  return [project, ...compactPath.filter((part, index) => index > 0 || part !== project)];
}
