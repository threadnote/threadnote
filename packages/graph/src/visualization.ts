import {Array as EffectArray} from 'effect';
import {Clock, Context, Effect, Option, Path, Result, Schema, Semaphore} from 'effect';
import {codeGraphDatabasePaths} from './maintenance.js';
import {CodeGraphEmbeddingIndex} from './embedding.js';
import {codeGraphLayout} from './layout.js';
import {runCodeGraphLifecycleOpportunity} from './lifecycle/opportunity.js';
import {CodeGraphMaintenanceCoordinator} from './maintenance/coordinator.js';
import {observeCodeGraphMaintenanceStatus, type CodeGraphMaintenanceStatus} from './maintenance/gate.js';
import {compareCodeUnits} from './ordering.js';
import {managerGraphCatalogRevision, type ManagerGraphCatalogRevisionDatabase} from './manager/catalog_revision.js';
import {traversalQuery} from './query.js';
import {
  CodeGraphStore,
  type CodeGraphStoreShape,
  type CodeGraphVisualizationCatalog,
  type CodeGraphVisualizationProject,
  type CodeGraphVisualizationScope,
  type CodeGraphVisualizationScopeEdge,
} from './store.js';
import type {
  CodeGraphEdge,
  CodeGraphProvenance,
  CodeGraphQueryNode,
  CodeGraphSnapshot,
  CodeGraphSpan,
  CodeGraphSymbol,
} from './types.js';
import {CodeGraphStoreBusyError} from './types.js';
import {analyzeCodeGraph} from './analysis.js';
import {codeGraphAnalysisLimitsForView} from './analysis/render.js';
import {
  readAllCodeGraphBuildStatuses,
  selectCodeGraphBuildStatuses,
  type ObservedCodeGraphBuildStatus,
} from './build_status.js';
import {readCodeGraphLocalAssociation, type CodeGraphLocalAssociation} from './local_provenance.js';
import {
  MANAGER_GRAPH_CATALOG_SCOPE_SEARCH_LIMIT,
  managerGraphVisualizationLimits,
  type ManagerGraphVisualizationBudget,
  type ManagerGraphVisualizationLimits,
} from './visualization/limits.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export {managerGraphBuildCatalog, type ManagerGraphBuildCatalog} from './manager/status.js';

class CodeGraphVisualizationError extends Schema.TaggedError<
  CodeGraphVisualizationError,
  {readonly brand: unique symbol}
>()('CodeGraphVisualizationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const NODE_DETAIL_EDGE_LIMIT = 160;
const NODE_DETAIL_SUMMARY_LIMIT = 2_000;
const MANAGER_CATALOG_PROJECT_LIMIT = 160;
const MANAGER_OVERVIEW_PROJECT_LIMIT = 500;
const MANAGER_CATALOG_WORKSPACE_LIMIT = 64;
const MANAGER_CATALOG_VIEW_LIMIT = 32;
const MANAGER_CATALOG_SNAPSHOT_LEASE_MILLISECONDS = 60 * 60_000;
const MANAGER_CATALOG_SNAPSHOT_RENEW_MILLISECONDS = MANAGER_CATALOG_SNAPSHOT_LEASE_MILLISECONDS / 2;
const MANAGER_OPERATION_LEASE_MINIMUM_MILLISECONDS = 2 * 60_000;
const MANAGER_LEASE_WRITER_WAIT_MILLISECONDS = 0;
const MANAGER_QUERY_DEFAULT_EDGE_LIMIT = 240;
const MANAGER_QUERY_DEFAULT_NODE_LIMIT = 120;

export interface ManagerGraphQueryLifecycleShape {
  readonly beforeTraversal: Effect.Effect<void>;
}

/** Internal observation boundary used by deterministic cancellation controls. */
export class ManagerGraphQueryLifecycle extends Context.Service<
  ManagerGraphQueryLifecycle,
  ManagerGraphQueryLifecycleShape
>()('@threadnote/graph/visualization/ManagerGraphQueryLifecycle') {}

const MANAGER_QUERY_MAX_EDGE_LIMIT = 500;
const MANAGER_QUERY_MAX_NODE_LIMIT = 200;
const MANAGER_QUERY_MAX_LENGTH = 512;
const MANAGER_QUERY_SEMANTIC_TIME_BUDGET_MILLISECONDS = 750;
const MANAGER_QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS = 1_000;
const managerSnapshotLeases = new Map<
  string,
  {
    readonly database: string;
    readonly expiresAt: number;
    readers: number;
    readonly renewAfter: number;
    readonly token: string;
    readonly worktreeIds: Set<string>;
  }
>();
const managerSnapshotLeaseGates = new Map<string, ReturnType<typeof Semaphore.makeUnsafe>>();
const INDEXED_VIEW_ID = /^[0-9a-f]{64}(?:\.[0-9a-f]{64}(?:\.[0-9a-f]{64})?)?$/;
const GRAPH_SCOPE_ID = /^code-graph-scope:[0-9a-f]{64}$/u;
const NODE_ID_MAX_LENGTH = 512;
const NODE_DETAIL_PROVENANCES: readonly CodeGraphProvenance[] = [
  'declared',
  'resolved',
  'syntactic',
  'heuristic',
  'model',
];

export interface ManagerGraphRepository {
  readonly displayName: string;
  readonly id: string;
  readonly defaultViewId: string;
  readonly repositoryId: string;
  readonly views: readonly ManagerGraphIndexedView[];
  readonly viewsTruncated: boolean;
}

export interface ManagerGraphIndexedView {
  readonly accounting: CodeGraphVisualizationCatalog['accounting'];
  readonly activatedAt?: string;
  readonly checkoutId: string;
  readonly displayName: string;
  readonly id: string;
  readonly label: string;
  readonly localAssociation: CodeGraphLocalAssociation;
  readonly metrics: CodeGraphVisualizationCatalog['metrics'];
  readonly model: CodeGraphVisualizationCatalog['model'];
  readonly projects: readonly {
    readonly buildSystem?: string;
    readonly fileCount?: number;
    readonly id: string;
    readonly kind?: string;
    readonly label: string;
    readonly model: CodeGraphVisualizationProject['model'];
    readonly provenance: string;
    readonly symbolCount?: number;
    readonly workspaceId?: string;
  }[];
  readonly projectCount: number;
  readonly projectsTruncated: boolean;
  readonly snapshot: CodeGraphSnapshot;
  readonly scopeId?: string;
  readonly worktreeId: string;
  readonly workspaces: readonly {
    readonly buildSystem: string;
    readonly id: string;
    readonly name: string;
    readonly root: string;
  }[];
  readonly workspaceCount: number;
  readonly workspacesTruncated: boolean;
}

export interface ManagerGraphCatalogDiagnostic {
  readonly checkoutId: string;
  readonly code: 'lease-deferred' | 'lease-failed' | 'no-ready-snapshot' | 'unreadable-database';
  readonly message: string;
}

export class ManagerGraphBusyError extends Schema.TaggedError<ManagerGraphBusyError, {readonly brand: unique symbol}>()(
  'ManagerGraphBusyError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export class ManagerGraphLeaseError extends Schema.TaggedError<
  ManagerGraphLeaseError,
  {readonly brand: unique symbol}
>()('ManagerGraphLeaseError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export class ManagerGraphViewUnavailableError extends Schema.TaggedError<
  ManagerGraphViewUnavailableError,
  {readonly brand: unique symbol}
>()('ManagerGraphViewUnavailableError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export interface ManagerGraphSnapshotLeaseWarning {
  readonly code: 'manager-snapshot-lease-release-busy' | 'manager-snapshot-lease-release-failed';
  readonly message: string;
  readonly occurrences: 1;
  readonly retryable: true;
}

export interface ManagerGraphCatalog {
  readonly builds: readonly ObservedCodeGraphBuildStatus[];
  readonly catalogRevision: string;
  readonly diagnostics: readonly ManagerGraphCatalogDiagnostic[];
  readonly maintenance?: CodeGraphMaintenanceStatus;
  readonly repositories: readonly ManagerGraphRepository[];
  readonly waiterCount: number;
  readonly waiters: readonly ObservedCodeGraphBuildStatus[];
}

export interface ManagerGraphCatalogPage {
  readonly projectOffset: number;
  readonly query: string;
  readonly repository: ManagerGraphIndexedView;
  readonly workspaceOffset: number;
}

export interface ManagerGraphViewPage {
  readonly hasMore: boolean;
  readonly offset: number;
  readonly query: string;
  readonly repositories: readonly ManagerGraphRepository[];
}

export interface ManagerGraphNode {
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
  readonly score?: number;
  readonly signature?: string;
  readonly symbolCount?: number;
  readonly type: 'project' | 'symbol';
}

export interface ManagerGraphEdge {
  readonly confidence: number;
  readonly count: number;
  readonly id: string;
  readonly provenance:
    CodeGraphEdge['provenance'] | CodeGraphVisualizationProject['dependencies'][number]['provenance'] | 'aggregate';
  readonly relation: CodeGraphEdge['relation'] | 'cross-project';
  readonly sourceId: string;
  readonly targetId: string;
}

export interface ManagerGraphVisualization {
  readonly edges: readonly ManagerGraphEdge[];
  readonly mode: 'detail' | 'overview';
  readonly nodes: readonly ManagerGraphNode[];
  readonly paging: {
    readonly edgeLimit: number;
    readonly hasMore: boolean;
    readonly nodeLimit: number;
  };
  readonly projectId: string;
  readonly query?: {
    readonly matchedNodes: number;
    readonly state: 'ready';
    readonly text: string;
    readonly warnings: readonly string[];
  };
  readonly repository: {
    readonly accounting: CodeGraphVisualizationCatalog['accounting'];
    readonly displayName: string;
    readonly id: string;
    readonly metrics: CodeGraphVisualizationCatalog['metrics'];
    readonly snapshot: CodeGraphSnapshot;
  };
  readonly scope: {readonly id: string; readonly label: string};
  readonly stats: {
    readonly renderedEdges: number;
    readonly renderedNodes: number;
    readonly totalEdges: number;
    readonly totalNodes: number;
  };
  readonly warnings: readonly string[];
}

export interface ManagerGraphNodeDetail {
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
    readonly span: CodeGraphSpan;
  };
  readonly relationships: readonly {
    readonly confidence: number;
    readonly direction: 'incoming' | 'outgoing';
    readonly evidencePath: string;
    readonly evidenceSpan: CodeGraphSpan;
    readonly id: string;
    readonly provenance: CodeGraphEdge['provenance'];
    readonly related: {
      readonly id?: string;
      readonly kind?: string;
      readonly label: string;
      readonly path?: string;
      readonly projectId?: string;
      readonly qualifiedName?: string;
    };
    readonly relation: CodeGraphEdge['relation'];
  }[];
  readonly snapshotId: string;
  readonly stats: {
    readonly incoming: number;
    readonly outgoing: number;
    readonly provenances: readonly {
      readonly count: number;
      readonly provenance: CodeGraphEdge['provenance'];
    }[];
    readonly relations: readonly {
      readonly count: number;
      readonly incoming: number;
      readonly outgoing: number;
      readonly relation: CodeGraphEdge['relation'];
    }[];
    readonly sampledEdges: number;
    readonly summaryTruncated: boolean;
    readonly truncated: boolean;
  };
}

export const managerGraphCatalog = Effect.fn('codeGraph.managerCatalog')(function* (threadnoteHome: string) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const lifecycleMaintenance = yield* Effect.serviceOption(CodeGraphMaintenanceCoordinator);
  const buildSelection = selectCodeGraphBuildStatuses(yield* readAllCodeGraphBuildStatuses(threadnoteHome));
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const entries = yield* Effect.forEach(
    databases,
    database => {
      const checkoutId = path.basename(path.dirname(database));
      return Effect.gen(function* () {
        const catalogs = yield* store.loadVisualizationCatalogs(database, 'deferred', {
          includeDependencies: false,
          projectLimit: MANAGER_CATALOG_PROJECT_LIMIT,
          viewLimit: MANAGER_CATALOG_VIEW_LIMIT + 1,
          workspaceLimit: MANAGER_CATALOG_WORKSPACE_LIMIT,
        });
        if (catalogs.length === 0) {
          return {
            checkoutId,
            databasePath: database,
            diagnostic: {
              checkoutId,
              code: 'no-ready-snapshot',
              message:
                'Stored graph data has no queryable snapshot. Index from its repository folder, or purge it if it is obsolete.',
            } satisfies ManagerGraphCatalogDiagnostic,
          } as const;
        }
        const visible = catalogs.slice(0, MANAGER_CATALOG_VIEW_LIMIT);
        const retention = yield* Effect.forEach(
          visible,
          catalog =>
            retainManagerSnapshot(
              store,
              database,
              catalog.viewWorktreeId,
              catalog.snapshot.id,
              catalog.viewScopeId,
              MANAGER_OPERATION_LEASE_MINIMUM_MILLISECONDS,
            ).pipe(Effect.map(result => ({catalog, result}))),
          {concurrency: 1},
        );
        const current = EffectArray.filter(retention, entry => entry.result.state !== 'view-unavailable');
        if (current.length === 0) {
          return {
            checkoutId,
            databasePath: database,
            diagnostic: {
              checkoutId,
              code: 'no-ready-snapshot',
              message:
                'Stored graph data has no queryable snapshot. Index from its repository folder, or purge it if it is obsolete.',
            } satisfies ManagerGraphCatalogDiagnostic,
          } as const;
        }
        const retained = EffectArray.map(current, entry => entry.result);
        const observedCatalogs = yield* Effect.forEach(
          current,
          ({catalog}) =>
            managerGraphLocalAssociationForCatalog(threadnoteHome, checkoutId, catalog, [
              ...buildSelection.builds,
              ...buildSelection.waiters,
            ]).pipe(Effect.map(localAssociation => ({catalog, localAssociation}))),
          {concurrency: 4},
        );
        const primaryView = observedCatalogs[0];
        const primaryViewPath =
          primaryView && 'displayPath' in primaryView.localAssociation
            ? primaryView.localAssociation.displayPath
            : undefined;
        const viewLabel = primaryView
          ? `${primaryView.catalog.repository.displayName}${primaryViewPath ? ` at ${primaryViewPath}` : ''}`
          : 'The indexed repository';
        return {
          checkoutId,
          catalogs: observedCatalogs,
          databasePath: database,
          ...(EffectArray.every(retained, result => result.state === 'retained')
            ? {}
            : {
                diagnostic: {
                  checkoutId,
                  code: EffectArray.some(retained, result => result.state === 'failed')
                    ? ('lease-failed' as const)
                    : ('lease-deferred' as const),
                  message: EffectArray.some(retained, result => result.state === 'failed')
                    ? `${viewLabel} remains readable. Snapshot retention is temporarily unavailable, and background maintenance will retry.`
                    : `${viewLabel} is readable, but snapshot retention is deferred while another graph writer is active. Retry after the active build completes.`,
                } satisfies ManagerGraphCatalogDiagnostic,
              }),
          viewsTruncated: catalogs.length > MANAGER_CATALOG_VIEW_LIMIT,
        } as const;
      }).pipe(
        Effect.catchCause(cause =>
          Effect.succeed({
            checkoutId,
            databasePath: database,
            diagnostic: {
              checkoutId,
              code: 'unreadable-database',
              message: `An indexed repository graph database is unreadable: ${privacySafeCatalogError(cause)}`,
            } satisfies ManagerGraphCatalogDiagnostic,
          } as const),
        ),
      );
    },
    {concurrency: 2},
  );
  const catalogEntries: Array<{
    catalog: CodeGraphVisualizationCatalog;
    checkoutId: string;
    localAssociation: CodeGraphLocalAssociation;
    viewsTruncated?: boolean;
  }> = [];
  const diagnostics: ManagerGraphCatalogDiagnostic[] = [];
  for (const entry of entries) {
    if ('catalogs' in entry && entry.catalogs) {
      catalogEntries.push(
        ...EffectArray.map(entry.catalogs, observed => ({
          catalog: observed.catalog,
          checkoutId: entry.checkoutId,
          localAssociation: observed.localAssociation,
          viewsTruncated: entry.viewsTruncated,
        })),
      );
    }
    if ('diagnostic' in entry && entry.diagnostic) diagnostics.push(entry.diagnostic);
  }
  if (Option.isSome(lifecycleMaintenance)) {
    yield* runCodeGraphLifecycleOpportunity({
      opportunity: 'catalog',
      targets: EffectArray.map(entries, entry => {
        const association =
          'catalogs' in entry
            ? Option.getOrUndefined(
                EffectArray.findFirst(entry.catalogs, observed => observed.localAssociation.state === 'verified'),
              )?.localAssociation
            : undefined;
        const anchor = association !== undefined && 'path' in association ? association.path : undefined;
        return {
          ...(anchor === undefined ? {} : {anchorPath: anchor}),
          checkoutId: entry.checkoutId,
          databasePath: entry.databasePath,
          reconciliationPending:
            'catalogs' in entry &&
            EffectArray.some(entry.catalogs, observed => observed.localAssociation.state === 'missing'),
        };
      }),
      maintenance: lifecycleMaintenance.value,
      threadnoteHome,
    }).pipe(Effect.catch(() => Effect.void));
  }
  const maintenance = yield* observeCodeGraphMaintenanceStatus(threadnoteHome).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  const catalogRevision = managerGraphCatalogRevision(
    EffectArray.map(entries, entry => {
      const catalogs = 'catalogs' in entry && entry.catalogs ? entry.catalogs : [];
      return {
        checkoutId: entry.checkoutId,
        state:
          'diagnostic' in entry && entry.diagnostic?.code === 'unreadable-database'
            ? ('unavailable' as const)
            : ('ready' as const),
        views: EffectArray.map(catalogs, ({catalog}) => ({
          ...(catalog.activatedAt === undefined ? {} : {activatedAt: catalog.activatedAt}),
          repositoryId: catalog.repository.repositoryId,
          ...(catalog.viewScopeId === undefined ? {} : {scopeId: catalog.viewScopeId}),
          snapshotId: catalog.snapshot.id,
          worktreeId: catalog.viewWorktreeId,
        })),
        viewsTruncated: 'viewsTruncated' in entry && entry.viewsTruncated === true,
      } satisfies ManagerGraphCatalogRevisionDatabase;
    }),
  );
  return {
    builds: buildSelection.builds,
    catalogRevision,
    diagnostics,
    ...(maintenance === undefined ? {} : {maintenance}),
    repositories: groupManagerGraphRepositories(catalogEntries),
    waiterCount: buildSelection.waiters.length,
    waiters: buildSelection.waiters,
  } satisfies ManagerGraphCatalog;
});

const retainManagerSnapshot = Effect.fn('codeGraph.retainManagerSnapshot')(function* (
  store: CodeGraphStoreShape,
  database: string,
  worktreeId: string,
  snapshotId: string,
  scopeId?: string,
  minimumRemainingMilliseconds = 0,
  reader = false,
) {
  const key = `${database}\0${snapshotId}`;
  return yield* managerSnapshotLeaseGate(key).withPermit(
    Effect.gen(function* () {
      const existing = managerSnapshotLeases.get(key);
      const now = yield* Clock.currentTimeMillis;
      const retained = yield* Effect.result(
        store.retainViewSnapshotLease(database, worktreeId, snapshotId, MANAGER_CATALOG_SNAPSHOT_LEASE_MILLISECONDS, {
          ...(existing ? {existingToken: existing.token} : {}),
          minimumRemainingMilliseconds,
          ...(scopeId === undefined ? {} : {scopeId}),
          waitTimeoutMilliseconds: MANAGER_LEASE_WRITER_WAIT_MILLISECONDS,
        }),
      );
      if (Result.isFailure(retained)) {
        if (Schema.is(CodeGraphStoreBusyError)(retained.failure)) {
          // A process-local cache is not cross-process authority. Linearize
          // every new reuse against the exact active pointer, tombstone and
          // still-live token in one read-only SQLite transaction. If another
          // process removed the view first, the stale catalog cannot revive it.
          if (existing?.worktreeIds.has(worktreeId) && existing.expiresAt > now + minimumRemainingMilliseconds) {
            const validation = yield* Effect.result(
              store.validateViewSnapshotLease(
                database,
                worktreeId,
                snapshotId,
                existing.token,
                minimumRemainingMilliseconds,
              ),
            );
            if (Result.isSuccess(validation) && validation.success.state === 'valid') {
              if (reader) existing.readers += 1;
              return {
                release: reader ? finishManagerSnapshotRead(store, database, key) : Effect.void,
                state: 'retained',
              } as const;
            }
          }
          return {state: 'busy'} as const;
        }
        return {error: retained.failure, state: 'failed'} as const;
      }
      if (retained.success.state === 'view-unavailable') {
        existing?.worktreeIds.delete(worktreeId);
        yield* releaseUnusedManagerSnapshotLease(store, database, key).pipe(Effect.ignore);
        return retained.success;
      }
      const worktreeIds = existing?.worktreeIds ?? new Set<string>();
      worktreeIds.add(worktreeId);
      managerSnapshotLeases.set(key, {
        database,
        expiresAt: retained.success.expiresAt,
        readers: (existing?.readers ?? 0) + (reader ? 1 : 0),
        renewAfter:
          existing?.token === retained.success.token && existing.renewAfter > now
            ? existing.renewAfter
            : now + MANAGER_CATALOG_SNAPSHOT_RENEW_MILLISECONDS,
        token: retained.success.token,
        worktreeIds,
      });
      return {
        release: reader ? finishManagerSnapshotRead(store, database, key) : Effect.void,
        state: 'retained',
      } as const;
    }),
  );
});

/**
 * Keeps Manager lease-cache invalidation and the exact view CAS in the same
 * database+snapshot critical section. A last lease with active readers stays
 * live until their operation-scoped references drain; otherwise it is
 * released immediately so ordinary retirement can reclaim the removed view.
 */
export function withManagerGraphSnapshotLeaseInvalidated<A, E, R>(
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
  snapshotId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  {readonly result: A; readonly warnings: readonly ManagerGraphSnapshotLeaseWarning[]},
  E,
  R | Path.Path | CodeGraphStore
> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const store = yield* CodeGraphStore;
    const database = codeGraphLayout(path, threadnoteHome, checkoutId, worktreeId).databasePath;
    const key = `${database}\0${snapshotId}`;
    return yield* managerSnapshotLeaseGate(key).withPermit(
      Effect.gen(function* () {
        const result = yield* effect;
        const existing = managerSnapshotLeases.get(key);
        existing?.worktreeIds.delete(worktreeId);
        const warnings = yield* releaseUnusedManagerSnapshotLease(store, database, key);
        return {result, warnings};
      }),
    );
  });
}

function managerSnapshotLeaseGate(key: string): ReturnType<typeof Semaphore.makeUnsafe> {
  const existing = managerSnapshotLeaseGates.get(key);
  if (existing) return existing;
  const created = Semaphore.makeUnsafe(1);
  managerSnapshotLeaseGates.set(key, created);
  return created;
}

/** Releases every catalog lease owned by the current Manager process. */
export const releaseManagerGraphSnapshotLeases = Effect.fn('codeGraph.releaseManagerSnapshotLeases')(function* () {
  const store = yield* CodeGraphStore;
  const leases = [...managerSnapshotLeases.values()];
  managerSnapshotLeases.clear();
  managerSnapshotLeaseGates.clear();
  yield* Effect.forEach(
    leases,
    lease =>
      store
        .releaseSnapshotLease(lease.database, lease.token, {
          waitTimeoutMilliseconds: MANAGER_LEASE_WRITER_WAIT_MILLISECONDS,
        })
        .pipe(Effect.ignore),
    {concurrency: 1, discard: true},
  );
});

export function groupManagerGraphRepositories(
  entries: readonly {
    readonly catalog: CodeGraphVisualizationCatalog;
    readonly checkoutId: string;
    readonly localAssociation?: CodeGraphLocalAssociation;
    readonly viewsTruncated?: boolean;
  }[],
): readonly ManagerGraphRepository[] {
  const groups = new Map<string, {displayName: string; views: ManagerGraphIndexedView[]; viewsTruncated: boolean}>();
  for (const entry of entries) {
    const repositoryId = entry.catalog.repository.repositoryId;
    const group = groups.get(repositoryId) ?? {
      displayName: entry.catalog.repository.displayName,
      views: [],
      viewsTruncated: false,
    };
    group.views.push(repositoryFromCatalog(entry.checkoutId, entry.catalog, entry.localAssociation));
    group.viewsTruncated ||= entry.viewsTruncated === true;
    groups.set(repositoryId, group);
  }
  return EffectArray.map([...groups], ([repositoryId, group]) => {
    const views = group.views.sort(compareIndexedViews);
    return {
      defaultViewId: views[0].id,
      displayName: group.displayName,
      id: repositoryId,
      repositoryId,
      views,
      viewsTruncated: group.viewsTruncated,
    } satisfies ManagerGraphRepository;
  }).sort(
    (left, right) =>
      compareCodeUnits(left.displayName, right.displayName) || compareCodeUnits(left.repositoryId, right.repositoryId),
  );
}

function managerSnapshotLeaseReleaseWarning(failure: unknown): ManagerGraphSnapshotLeaseWarning {
  return Schema.is(CodeGraphStoreBusyError)(failure)
    ? {
        code: 'manager-snapshot-lease-release-busy',
        message: 'Manager snapshot lease release is busy; it will not be renewed and later cleanup will retry.',
        occurrences: 1,
        retryable: true,
      }
    : {
        code: 'manager-snapshot-lease-release-failed',
        message: 'Manager snapshot lease release failed; it will not be renewed and later cleanup will retry.',
        occurrences: 1,
        retryable: true,
      };
}

const releaseUnusedManagerSnapshotLease = Effect.fn('codeGraph.releaseUnusedManagerSnapshotLease')(function* (
  store: CodeGraphStoreShape,
  database: string,
  key: string,
) {
  const existing = managerSnapshotLeases.get(key);
  if (!existing || existing.readers > 0 || existing.worktreeIds.size > 0) return [] as const;
  const released = yield* Effect.result(
    store.releaseSnapshotLease(database, existing.token, {
      waitTimeoutMilliseconds: MANAGER_LEASE_WRITER_WAIT_MILLISECONDS,
    }),
  );
  if (Result.isSuccess(released)) {
    managerSnapshotLeases.delete(key);
    return [] as const;
  }
  return [managerSnapshotLeaseReleaseWarning(released.failure)] as const;
});

const finishManagerSnapshotRead = Effect.fn('codeGraph.finishManagerSnapshotRead')(function* (
  store: CodeGraphStoreShape,
  database: string,
  key: string,
) {
  yield* managerSnapshotLeaseGate(key).withPermit(
    Effect.gen(function* () {
      const existing = managerSnapshotLeases.get(key);
      if (!existing) return;
      existing.readers = Math.max(0, existing.readers - 1);
      yield* releaseUnusedManagerSnapshotLease(store, database, key).pipe(Effect.ignore);
    }),
  );
});

export const managerGraphCatalogPage = Effect.fn('codeGraph.managerCatalogPage')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  expectedSnapshotId: Option.Option<string>,
  request: {readonly offset?: number; readonly query?: string; readonly workspaceOffset?: number} = {},
) {
  if (Option.isNone(expectedSnapshotId)) {
    return yield* CodeGraphVisualizationError.make({
      message: 'Graph catalog continuation requires the selected snapshot identity.',
    });
  }
  const projectOffset = boundedCatalogOffset(request.offset);
  const workspaceOffset = boundedCatalogOffset(request.workspaceOffset);
  const query = boundedCatalogQuery(request.query);
  return yield* Effect.acquireUseRelease(
    resolveManagerGraphView(threadnoteHome, indexedViewId, {
      expectedSnapshotId,
      includeDependencies: false,
      projectLimit: MANAGER_CATALOG_PROJECT_LIMIT,
      projectOffset,
      projectQuery: query.length === 0 ? Option.none() : Option.some(query),
      workspaceOffset,
      workspaceQuery: query.length === 0 ? Option.none() : Option.some(query),
    }),
    ({catalog, checkoutId}) =>
      Effect.gen(function* () {
        const localAssociation = yield* managerGraphLocalAssociationForCatalog(threadnoteHome, checkoutId, catalog);
        return {
          projectOffset,
          query,
          repository: repositoryFromCatalog(checkoutId, catalog, localAssociation),
          workspaceOffset,
        } satisfies ManagerGraphCatalogPage;
      }),
    resolved => resolved.release,
  );
});

export const managerGraphViewsPage = Effect.fn('codeGraph.managerViewsPage')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  request: {readonly offset?: number; readonly query?: string; readonly scopeIds?: readonly string[]} = {},
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId))
    return yield* CodeGraphVisualizationError.make({message: 'Graph view identity is invalid.'});
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  const checkoutId = indexedViewId.split('.', 1)[0];
  if (checkoutId === undefined)
    return yield* CodeGraphVisualizationError.make({message: 'Indexed graph checkout is invalid.'});
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const database = Option.getOrUndefined(
    EffectArray.findFirst(databases, candidate => path.basename(path.dirname(candidate)) === checkoutId),
  );
  if (!database) return yield* CodeGraphVisualizationError.make({message: 'Indexed graph checkout was not found.'});
  const offset = boundedCatalogOffset(request.offset);
  const query = boundedCatalogQuery(request.query);
  const requestedScopeIds = [...new Set(request.scopeIds ?? [])];
  if (
    requestedScopeIds.length > MANAGER_GRAPH_CATALOG_SCOPE_SEARCH_LIMIT ||
    EffectArray.some(requestedScopeIds, scopeId => !GRAPH_SCOPE_ID.test(scopeId))
  ) {
    return yield* CodeGraphVisualizationError.make({message: 'Graph scope selection is invalid.'});
  }
  const scopeIds = requestedScopeIds;
  const catalogs = yield* store.loadVisualizationCatalogs(database, 'deferred', {
    includeDependencies: false,
    projectLimit: MANAGER_CATALOG_PROJECT_LIMIT,
    ...(scopeIds.length === 0 ? {} : {scopeIds}),
    viewLimit: MANAGER_CATALOG_VIEW_LIMIT + 1,
    viewOffset: offset,
    viewQuery: query.length === 0 ? Option.none() : Option.some(query),
    workspaceLimit: MANAGER_CATALOG_WORKSPACE_LIMIT,
  });
  const visible = catalogs.slice(0, MANAGER_CATALOG_VIEW_LIMIT);
  const retention = yield* Effect.forEach(
    visible,
    catalog =>
      retainManagerSnapshot(store, database, catalog.viewWorktreeId, catalog.snapshot.id, catalog.viewScopeId).pipe(
        Effect.map(result => ({catalog, result})),
      ),
    {concurrency: 1},
  );
  const current = EffectArray.filter(retention, entry => entry.result.state !== 'view-unavailable');
  const buildStatuses = yield* readAllCodeGraphBuildStatuses(threadnoteHome);
  const observed = yield* Effect.forEach(
    current,
    ({catalog}) =>
      managerGraphLocalAssociationForCatalog(threadnoteHome, checkoutId, catalog, buildStatuses).pipe(
        Effect.map(localAssociation => ({catalog, checkoutId, localAssociation})),
      ),
    {concurrency: 4},
  );
  return {
    hasMore: catalogs.length > MANAGER_CATALOG_VIEW_LIMIT,
    offset,
    query,
    repositories: groupManagerGraphRepositories(observed),
  } satisfies ManagerGraphViewPage;
});

export const managerGraphAnalysis = Effect.fn('codeGraph.managerAnalysis')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  expectedSnapshotId: Option.Option<string> = Option.none(),
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId))
    return yield* CodeGraphVisualizationError.make({message: 'Graph view identity is invalid.'});
  const store = yield* CodeGraphStore;
  return yield* Effect.acquireUseRelease(
    resolveManagerGraphView(threadnoteHome, indexedViewId, {
      expectedSnapshotId,
      includeDependencies: false,
      projectLimit: 1,
    }),
    ({catalog, database}) =>
      store.withSession(
        database,
        analyzeCodeGraph(store, {
          budget: {maxDurationMilliseconds: 20_000},
          databasePath: database,
          limits: codeGraphAnalysisLimitsForView('full'),
          snapshot: catalog.snapshot,
        }),
        {readOnly: true},
      ),
    resolved => resolved.release,
  );
});

export const managerGraphVisualization = Effect.fn('codeGraph.managerVisualization')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  requestedProjectId: string,
  requestedBudget: ManagerGraphVisualizationBudget = {},
  expectedSnapshotId: Option.Option<string> = Option.none(),
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId))
    return yield* CodeGraphVisualizationError.make({message: 'Graph view identity is invalid.'});
  const store = yield* CodeGraphStore;
  const projectId = Effect2.pipe(requestedProjectId, EffectString.trim) || 'all';
  return yield* Effect.acquireUseRelease(
    resolveManagerGraphView(threadnoteHome, indexedViewId, {
      expectedSnapshotId,
      includeDependencies: projectId === 'all',
      projectId: projectId === 'all' ? Option.none() : Option.some(projectId),
      projectLimit: projectId === 'all' ? MANAGER_OVERVIEW_PROJECT_LIMIT : 1,
    }),
    ({catalog, checkoutId, database}) =>
      Effect.gen(function* () {
        const repository = repositoryFromCatalog(checkoutId, catalog);
        const limits = managerGraphVisualizationLimits(requestedBudget);
        if (projectId === 'all') {
          return yield* overviewVisualization(store, database, repository, catalog, limits);
        }
        const project = Option.getOrUndefined(
          EffectArray.findFirst(catalog.projects, candidate => candidate.id === projectId),
        );
        if (!project) return yield* CodeGraphVisualizationError.make({message: 'Indexed graph project was not found.'});
        return yield* detailVisualization(store, database, repository, project, limits);
      }),
    resolved => resolved.release,
  );
});

export const managerGraphQuery = Effect.fn('codeGraph.managerQuery')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  requestedQuery: string,
  requestedBudget: ManagerGraphVisualizationBudget = {},
  expectedSnapshotId: Option.Option<string> = Option.none(),
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId))
    return yield* CodeGraphVisualizationError.make({message: 'Graph view identity is invalid.'});
  if (Option.isNone(expectedSnapshotId)) {
    return yield* CodeGraphVisualizationError.make({message: 'Graph queries require the selected snapshot identity.'});
  }
  const query = Effect2.pipe(requestedQuery, EffectString.trim);
  if (query.length === 0 || query.length > MANAGER_QUERY_MAX_LENGTH) {
    return yield* CodeGraphVisualizationError.make({message: 'Graph query must contain between 1 and 512 characters.'});
  }
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const embedding = yield* CodeGraphEmbeddingIndex;
  return yield* Effect.acquireUseRelease(
    resolveManagerGraphView(threadnoteHome, indexedViewId, {
      expectedSnapshotId,
      includeDependencies: false,
      projectLimit: 1,
    }),
    ({catalog, checkoutId, database}) =>
      Effect.gen(function* () {
        const requestedLimits = managerGraphVisualizationLimits({
          edgeLimit: requestedBudget.edgeLimit ?? MANAGER_QUERY_DEFAULT_EDGE_LIMIT,
          nodeLimit: requestedBudget.nodeLimit ?? MANAGER_QUERY_DEFAULT_NODE_LIMIT,
        });
        const limits = {
          edgeLimit: Math.min(MANAGER_QUERY_MAX_EDGE_LIMIT, requestedLimits.edgeLimit),
          nodeLimit: Math.min(MANAGER_QUERY_MAX_NODE_LIMIT, requestedLimits.nodeLimit),
        };
        const layout = codeGraphLayout(path, threadnoteHome, checkoutId, catalog.viewWorktreeId);
        const lifecycle = yield* Effect.serviceOption(ManagerGraphQueryLifecycle);
        yield* Option.match(lifecycle, {onNone: () => Effect.void, onSome: value => value.beforeTraversal});
        const selection = yield* store.withSession(
          database,
          traversalQuery(
            store,
            database,
            catalog.snapshot.id,
            query,
            'both',
            limits.nodeLimit,
            limits.edgeLimit,
            1,
            ['declared', 'resolved', 'syntactic'],
            embedding,
            threadnoteHome,
            layout,
            false,
            undefined,
            undefined,
            {
              semanticMilliseconds: MANAGER_QUERY_SEMANTIC_TIME_BUDGET_MILLISECONDS,
              traversalMilliseconds: MANAGER_QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS,
            },
          ),
          {readOnly: true},
        );
        const workingSet = managerGraphQueryWorkingSet(selection.nodes, selection.edges, limits);
        const {edges: visibleEdges, nodes} = workingSet;
        const warnings = EffectArray.map(selection.warnings, warning => boundedText(warning, 320));
        const truncated =
          workingSet.truncated || EffectArray.some(warnings, warning => /partial|limit|budget/iu.test(warning));
        const repository = repositoryFromCatalog(checkoutId, catalog);
        return {
          edges: visibleEdges,
          mode: 'detail',
          nodes,
          paging: {...limits, hasMore: truncated},
          projectId: 'query',
          query: {
            matchedNodes: nodes.length,
            state: 'ready',
            text: boundedText(query, MANAGER_QUERY_MAX_LENGTH),
            warnings,
          },
          repository: visualizationRepository(repository),
          scope: {id: 'query', label: `Query: ${boundedText(query, 120)}`},
          stats: {
            renderedEdges: visibleEdges.length,
            renderedNodes: nodes.length,
            totalEdges: repository.snapshot.edgeCount,
            totalNodes: repository.snapshot.symbolCount,
          },
          warnings,
        } satisfies ManagerGraphVisualization;
      }),
    resolved => resolved.release,
  );
});

export const managerGraphNodeDetail = Effect.fn('codeGraph.managerNodeDetail')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  requestedNodeId: string,
  expectedSnapshotId: Option.Option<string> = Option.none(),
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId))
    return yield* CodeGraphVisualizationError.make({message: 'Graph view identity is invalid.'});
  const nodeId = Effect2.pipe(requestedNodeId, EffectString.trim);
  if (nodeId.length === 0 || nodeId.length > NODE_ID_MAX_LENGTH) {
    return yield* CodeGraphVisualizationError.make({message: 'Graph node identity is invalid.'});
  }
  const store = yield* CodeGraphStore;
  return yield* Effect.acquireUseRelease(
    resolveManagerGraphView(threadnoteHome, indexedViewId, {
      expectedSnapshotId,
      includeDependencies: false,
      projectLimit: 1,
    }),
    ({catalog, database}) =>
      Effect.gen(function* () {
        const symbols = yield* store.symbolsByIds(database, catalog.snapshot.id, [nodeId]);
        const symbol = Option.getOrUndefined(EffectArray.findFirst(symbols, candidate => candidate.id === nodeId));
        if (!symbol) return yield* CodeGraphVisualizationError.make({message: 'Indexed graph node was not found.'});

        const [edges, summary] = yield* Effect.all([
          store.edgesForNodes(
            database,
            catalog.snapshot.id,
            [nodeId],
            'both',
            NODE_DETAIL_EDGE_LIMIT,
            NODE_DETAIL_PROVENANCES,
          ),
          store.relationshipSummaryForNode(
            database,
            catalog.snapshot.id,
            nodeId,
            NODE_DETAIL_PROVENANCES,
            NODE_DETAIL_SUMMARY_LIMIT,
          ),
        ]);
        const relatedIds = [
          ...new Set(
            EffectArray.filter(
              EffectArray.map(edges, edge => (edge.sourceId === nodeId ? edge.targetId : edge.sourceId)),
              isString,
            ),
          ),
        ];
        const relatedSymbols = yield* store.symbolsByIds(database, catalog.snapshot.id, relatedIds);
        const relatedSymbolsById = new Map(EffectArray.map(relatedSymbols, candidate => [candidate.id, candidate]));
        const relationships = EffectArray.map(edges, edge => {
          const outgoing = edge.sourceId === nodeId;
          const relatedId = outgoing ? edge.targetId : edge.sourceId;
          const relatedSymbol = relatedId ? relatedSymbolsById.get(relatedId) : undefined;
          return {
            confidence: edge.confidence,
            direction: outgoing ? ('outgoing' as const) : ('incoming' as const),
            evidencePath: boundedText(edge.evidencePath, 512),
            evidenceSpan: edge.evidenceSpan,
            id: edge.id,
            provenance: edge.provenance,
            related: {
              id: relatedSymbol?.id ?? relatedId,
              kind: relatedSymbol?.kind,
              label: boundedText(relatedSymbol?.name ?? (outgoing ? edge.targetName : edge.sourceName), 160),
              path: relatedSymbol?.path ? boundedText(relatedSymbol.path, 512) : undefined,
              projectId: relatedSymbol ? projectIdForSymbol(relatedSymbol) : undefined,
              qualifiedName: relatedSymbol?.qualifiedName ? boundedText(relatedSymbol.qualifiedName, 320) : undefined,
            },
            relation: edge.relation,
          };
        });
        return {
          node: {
            documentation: symbol.documentation ? boundedText(symbol.documentation, 4_000) : undefined,
            exported: symbol.exported,
            id: symbol.id,
            kind: symbol.kind,
            label: boundedText(symbol.name, 160),
            language: boundedText(symbol.language, 64),
            packageName: symbol.packageName ? boundedText(symbol.packageName, 256) : undefined,
            path: boundedText(symbol.path, 512),
            projectId: projectIdForSymbol(symbol),
            qualifiedName: boundedText(symbol.qualifiedName, 320),
            signature: symbol.signature ? boundedText(symbol.signature, 2_000) : undefined,
            span: symbol.span,
          },
          relationships,
          snapshotId: catalog.snapshot.id,
          stats: {
            ...summary,
            summaryTruncated: summary.truncated,
            truncated:
              summary.truncated ||
              EffectArray.reduce(summary.provenances, 0, (total, item) => total + item.count) > relationships.length,
          },
        } satisfies ManagerGraphNodeDetail;
      }),
    resolved => resolved.release,
  );
});

function overviewVisualization(
  store: CodeGraphStoreShape,
  database: string,
  repository: ManagerGraphIndexedView,
  catalog: CodeGraphVisualizationCatalog,
  limits: ManagerGraphVisualizationLimits,
): Effect.Effect<ManagerGraphVisualization, unknown> {
  return Effect.gen(function* () {
    const declaredEdgesById = new Map<string, ManagerGraphEdge>();
    for (const project of catalog.projects) {
      for (const dependency of project.dependencies) {
        if (dependency.targetId === project.id) continue;
        const id = `declared-build-dependency\0${project.id}\0${dependency.targetId}\0${dependency.provenance}`;
        const current = declaredEdgesById.get(id);
        declaredEdgesById.set(id, {
          confidence: 1,
          count: (current?.count ?? 0) + 1,
          id,
          provenance: dependency.provenance,
          relation: 'depends_on',
          sourceId: project.id,
          targetId: dependency.targetId,
        });
      }
    }
    const declaredEdges = [...declaredEdgesById.values()];
    const sourceSummary = yield* store.loadVisualizationScopeEdgeSummary(
      database,
      repository.snapshot.id,
      EffectArray.map(repository.projects, project => project.id),
      limits.edgeLimit,
    );
    const sourceEdges = EffectArray.map(sourceSummary.edges, scopeEdgeToManagerEdge);
    const candidates = [...declaredEdges, ...sourceEdges];
    const allConnections = connectionCounts(candidates);
    const projects = [...repository.projects]
      .sort(
        (left, right) =>
          (allConnections.get(right.id) ?? 0) - (allConnections.get(left.id) ?? 0) ||
          compareCodeUnits(left.label, right.label) ||
          compareCodeUnits(left.id, right.id),
      )
      .slice(0, limits.nodeLimit);
    const visibleProjects = new Set(EffectArray.map(projects, project => project.id));
    const visibleCandidates = EffectArray.filter(
      candidates,
      edge => visibleProjects.has(edge.sourceId) && visibleProjects.has(edge.targetId),
    );
    const edges = representativeManagerGraphEdges(visibleCandidates, [...visibleProjects], limits.edgeLimit);
    const connections = connectionCounts(edges);
    const nodes = EffectArray.map(projects, project => ({
      degree: connections.get(project.id) ?? 0,
      ...(project.fileCount === undefined ? {} : {fileCount: project.fileCount}),
      id: project.id,
      kind: 'project',
      label: boundedText(project.label, 160),
      projectId: project.id,
      ...(project.symbolCount === undefined ? {} : {symbolCount: project.symbolCount}),
      type: 'project' as const,
    }));
    const warnings: string[] = [];
    if (repository.model === 'legacy-fallback') {
      warnings.push(
        'This snapshot predates typed workspace catalogs; rebuild it to replace legacy package/folder groups.',
      );
    }
    if (repository.metrics === 'complete' && repository.accounting.omittedSymbols > 0) {
      warnings.push(
        `${repository.accounting.omittedSymbols.toLocaleString()} indexed symbols could not be attributed to an overview scope.`,
      );
    }
    if (repository.model === 'workspace') {
      warnings.push(
        'Overview combines declared dependencies with a deterministic bounded sample of source-derived relationships.',
      );
    }
    if (sourceSummary.truncated) {
      warnings.push('Source-derived overview evidence is sampled fairly across the retained components.');
    }
    const hasMore =
      repository.projectsTruncated ||
      repository.projects.length > projects.length ||
      visibleCandidates.length > edges.length ||
      sourceSummary.truncated;
    if (hasMore) warnings.push('The repository overview is bounded; expand the working set to reveal more components.');
    return {
      edges,
      mode: 'overview',
      nodes,
      paging: {...limits, hasMore},
      projectId: 'all',
      repository: visualizationRepository(repository),
      scope: {id: 'all', label: repository.displayName},
      stats: {
        renderedEdges: edges.length,
        renderedNodes: nodes.length,
        totalEdges: repository.snapshot.edgeCount,
        totalNodes: repository.snapshot.symbolCount,
      },
      warnings,
    };
  });
}

function scopeEdgeToManagerEdge(edge: CodeGraphVisualizationScopeEdge): ManagerGraphEdge {
  return {
    confidence: edge.confidence,
    count: edge.count,
    id: `source-relationship\0${edge.sourceId}\0${edge.targetId}\0${edge.provenance}\0${edge.relation}`,
    provenance: edge.provenance,
    relation: edge.relation,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
  };
}

export function representativeManagerGraphEdges(
  candidates: readonly ManagerGraphEdge[],
  retainedNodeIds: readonly string[],
  limit: number,
): readonly ManagerGraphEdge[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const retained = new Set(retainedNodeIds);
  const eligible = EffectArray.filter(
    candidates,
    edge => edge.sourceId !== edge.targetId && retained.has(edge.sourceId) && retained.has(edge.targetId),
  ).sort(compareManagerGraphEdges);
  const selected = new Map<string, ManagerGraphEdge>();
  for (const nodeId of [...retained].sort(compareCodeUnits)) {
    const representative = Option.getOrUndefined(
      EffectArray.findFirst(eligible, edge => edge.sourceId === nodeId || edge.targetId === nodeId),
    );
    if (representative && !selected.has(representative.id)) selected.set(representative.id, representative);
    if (selected.size >= safeLimit) return [...selected.values()];
  }
  for (const edge of eligible) {
    if (!selected.has(edge.id)) selected.set(edge.id, edge);
    if (selected.size >= safeLimit) break;
  }
  return [...selected.values()];
}

function compareManagerGraphEdges(left: ManagerGraphEdge, right: ManagerGraphEdge): number {
  const provenanceRank = (value: ManagerGraphEdge['provenance']): number =>
    value === 'declared' ? 0 : value === 'resolved' ? 1 : value === 'syntactic' ? 2 : 3;
  return (
    provenanceRank(left.provenance) - provenanceRank(right.provenance) ||
    right.count - left.count ||
    right.confidence - left.confidence ||
    compareCodeUnits(left.sourceId, right.sourceId) ||
    compareCodeUnits(left.targetId, right.targetId) ||
    compareCodeUnits(left.relation, right.relation) ||
    compareCodeUnits(left.id, right.id)
  );
}

function detailVisualization(
  store: CodeGraphStoreShape,
  database: string,
  repository: ManagerGraphIndexedView,
  project: CodeGraphVisualizationProject,
  limits: ManagerGraphVisualizationLimits,
): Effect.Effect<ManagerGraphVisualization, unknown> {
  return Effect.gen(function* () {
    const seedLimit = Math.max(1, Math.min(limits.nodeLimit, Math.floor(limits.nodeLimit * 0.65)));
    const seedPage = yield* store.loadVisualizationSymbols(
      database,
      repository.snapshot.id,
      scopeFromProjectId(project.id),
      seedLimit + 1,
    );
    const seeds = seedPage.slice(0, seedLimit);
    const seedIds = new Set(EffectArray.map(seeds, symbol => symbol.id));
    const adjacentPage = yield* store.representativeEdgesForNodes(
      database,
      repository.snapshot.id,
      [...seedIds],
      'both',
      limits.edgeLimit,
      ['declared', 'resolved', 'syntactic'],
    );
    const adjacent = adjacentPage.edges;
    const neighborIds = EffectArray.filter(
      [
        ...new Set(
          EffectArray.filter(
            EffectArray.flatMap(adjacent, edge => [edge.sourceId, edge.targetId]),
            isString,
          ),
        ),
      ],
      id => !seedIds.has(id),
    );
    const neighborBudget = Math.max(0, limits.nodeLimit - seeds.length);
    const neighborCandidateLimit = Math.min(400, Math.max(neighborBudget, neighborBudget * 4));
    const neighborCandidates = yield* store.symbolsByIds(
      database,
      repository.snapshot.id,
      neighborIds.slice(0, neighborCandidateLimit),
    );
    const neighbors = rankManagerGraphNeighbors(neighborCandidates, adjacent, seeds, project.id).slice(
      0,
      neighborBudget,
    );
    const workingSet = managerGraphDetailWorkingSet(seeds, neighbors, adjacent, project.id, limits);
    const {edges, nodes} = workingSet;
    const warnings: string[] = [];
    if (repository.metrics === 'complete' && project.symbolCount > seeds.length) {
      warnings.push(
        `Showing a connected ${nodes.length.toLocaleString()}-node working set from ${project.symbolCount.toLocaleString()} project symbols.`,
      );
    } else if (seedPage.length > seedLimit) {
      warnings.push(`Showing a connected ${nodes.length.toLocaleString()}-node working set for this component.`);
    }
    if (adjacentPage.truncated) {
      warnings.push('The relationship working set reached its rendering budget.');
    }
    const hasMore =
      adjacentPage.truncated ||
      workingSet.truncated ||
      neighborIds.length > neighborCandidates.length ||
      seedPage.length > seedLimit ||
      (repository.metrics === 'complete' && project.symbolCount > seeds.length);
    return {
      edges,
      mode: 'detail',
      nodes,
      paging: {...limits, hasMore},
      projectId: project.id,
      repository: visualizationRepository(repository),
      scope: {id: project.id, label: project.label},
      stats: {
        renderedEdges: edges.length,
        renderedNodes: nodes.length,
        totalEdges: repository.snapshot.edgeCount,
        totalNodes: repository.snapshot.symbolCount,
      },
      warnings,
    };
  });
}

function rankManagerGraphNeighbors(
  candidates: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
  seeds: readonly CodeGraphSymbol[],
  selectedProjectId: string,
): readonly CodeGraphSymbol[] {
  const seedById = new Map(EffectArray.map(seeds, seed => [seed.id, seed]));
  const incidentCounts = new Map<string, number>();
  const seedPriorities = new Map<string, number>();
  for (const edge of edges) {
    const sourceSeed = edge.sourceId ? seedById.get(edge.sourceId) : undefined;
    const targetSeed = edge.targetId ? seedById.get(edge.targetId) : undefined;
    if (edge.sourceId && !sourceSeed && targetSeed) {
      incidentCounts.set(edge.sourceId, (incidentCounts.get(edge.sourceId) ?? 0) + 1);
      seedPriorities.set(
        edge.sourceId,
        Math.min(seedPriorities.get(edge.sourceId) ?? Number.POSITIVE_INFINITY, searchKindPriority(targetSeed.kind)),
      );
    }
    if (edge.targetId && !targetSeed && sourceSeed) {
      incidentCounts.set(edge.targetId, (incidentCounts.get(edge.targetId) ?? 0) + 1);
      seedPriorities.set(
        edge.targetId,
        Math.min(seedPriorities.get(edge.targetId) ?? Number.POSITIVE_INFINITY, searchKindPriority(sourceSeed.kind)),
      );
    }
  }
  return [...candidates].sort(
    (left, right) =>
      (seedPriorities.get(left.id) ?? Number.POSITIVE_INFINITY) -
        (seedPriorities.get(right.id) ?? Number.POSITIVE_INFINITY) ||
      Number(projectIdForSymbol(right) !== selectedProjectId) -
        Number(projectIdForSymbol(left) !== selectedProjectId) ||
      (incidentCounts.get(right.id) ?? 0) - (incidentCounts.get(left.id) ?? 0) ||
      searchKindPriority(left.kind) - searchKindPriority(right.kind) ||
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.qualifiedName, right.qualifiedName) ||
      compareCodeUnits(left.id, right.id),
  );
}

function searchKindPriority(kind: string): number {
  switch (kind) {
    case 'package':
      return 0;
    case 'module':
      return 1;
    case 'class':
      return 2;
    case 'interface':
      return 3;
    case 'function':
      return 4;
    case 'method':
      return 5;
    default:
      return 6;
  }
}

export function managerGraphDetailWorkingSet(
  seeds: readonly CodeGraphSymbol[],
  neighbors: readonly CodeGraphSymbol[],
  adjacent: readonly CodeGraphEdge[],
  selectedProjectId: string,
  limits: ManagerGraphVisualizationLimits,
): {
  readonly edges: readonly ManagerGraphEdge[];
  readonly nodes: readonly ManagerGraphNode[];
  readonly truncated: boolean;
} {
  const seedIds = new Set(EffectArray.map(seeds, symbol => symbol.id));
  const symbols = [...seeds, ...neighbors].slice(0, limits.nodeLimit);
  const visibleIds = new Set(EffectArray.map(symbols, symbol => symbol.id));
  const edges = EffectArray.map(
    EffectArray.filter(
      adjacent,
      (edge): edge is CodeGraphEdge & {readonly sourceId: string; readonly targetId: string} =>
        Boolean(
          edge.sourceId &&
          edge.targetId &&
          edge.sourceId !== edge.targetId &&
          visibleIds.has(edge.sourceId) &&
          visibleIds.has(edge.targetId),
        ),
    ).slice(0, limits.edgeLimit),
    edge => ({
      confidence: edge.confidence,
      count: 1,
      id: edge.id,
      provenance: edge.provenance,
      relation: edge.relation,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
    }),
  );
  const connections = connectionCounts(edges);
  return {
    edges,
    nodes: EffectArray.map(symbols, symbol =>
      symbolNode(symbol, connections.get(symbol.id) ?? 0, seedIds.has(symbol.id) ? selectedProjectId : undefined),
    ),
    truncated:
      adjacent.length > edges.length ||
      EffectArray.some(
        [
          ...new Set(
            EffectArray.filter(
              EffectArray.flatMap(adjacent, edge => [edge.sourceId, edge.targetId]),
              isString,
            ),
          ),
        ],
        id => !visibleIds.has(id),
      ),
  };
}

export function managerGraphQueryWorkingSet(
  queryNodes: readonly CodeGraphQueryNode[],
  queryEdges: readonly CodeGraphEdge[],
  limits: ManagerGraphVisualizationLimits,
): {
  readonly edges: readonly ManagerGraphEdge[];
  readonly nodes: readonly ManagerGraphNode[];
  readonly truncated: boolean;
} {
  const visibleNodes = queryNodes.slice(0, limits.nodeLimit);
  const visibleIds = new Set(EffectArray.map(visibleNodes, node => node.id));
  const edges = EffectArray.map(
    EffectArray.filter(
      queryEdges,
      (edge): edge is CodeGraphEdge & {readonly sourceId: string; readonly targetId: string} =>
        Boolean(
          edge.sourceId &&
          edge.targetId &&
          edge.sourceId !== edge.targetId &&
          visibleIds.has(edge.sourceId) &&
          visibleIds.has(edge.targetId),
        ),
    ).slice(0, limits.edgeLimit),
    edge => ({
      confidence: edge.confidence,
      count: 1,
      id: edge.id,
      provenance: edge.provenance,
      relation: edge.relation,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
    }),
  );
  const connections = connectionCounts(edges);
  const nodes = EffectArray.map(visibleNodes, node => ({
    ...symbolNode(node, connections.get(node.id) ?? 0),
    score: node.score,
  }));
  return {
    edges,
    nodes,
    truncated: queryNodes.length > nodes.length || queryEdges.length > edges.length,
  };
}

function repositoryFromCatalog(
  checkoutId: string,
  catalog: CodeGraphVisualizationCatalog,
  localAssociation: CodeGraphLocalAssociation = {available: false, state: 'legacy-unknown'},
): ManagerGraphIndexedView {
  const viewId = managerIndexedViewId(checkoutId, catalog.viewWorktreeId, catalog.viewScopeId);
  return {
    accounting: catalog.accounting,
    ...(catalog.activatedAt ? {activatedAt: catalog.activatedAt} : {}),
    checkoutId,
    displayName: catalog.repository.displayName,
    id: viewId,
    label: indexedViewLabel(catalog),
    localAssociation,
    metrics: catalog.metrics,
    model: catalog.model,
    projectCount: catalog.projectCount,
    projects: EffectArray.map(catalog.projects, project => ({
      ...(project.buildSystem ? {buildSystem: project.buildSystem} : {}),
      ...(catalog.metrics === 'complete' ? {fileCount: project.fileCount} : {}),
      id: project.id,
      ...(project.kind ? {kind: project.kind} : {}),
      label: boundedText(project.label, 160),
      model: project.model,
      provenance: project.provenance,
      ...(catalog.metrics === 'complete' ? {symbolCount: project.symbolCount} : {}),
      ...(project.workspaceId ? {workspaceId: project.workspaceId} : {}),
    })),
    projectsTruncated: catalog.projectsTruncated,
    snapshot: catalog.snapshot,
    ...(catalog.viewScopeId === undefined ? {} : {scopeId: catalog.viewScopeId}),
    worktreeId: catalog.viewWorktreeId,
    workspaceCount: catalog.workspaceCount,
    workspaces: EffectArray.map(catalog.workspaces, workspace => ({
      buildSystem: workspace.buildSystem,
      id: workspace.id,
      name: boundedText(workspace.name, 160),
      root: boundedText(workspace.root, 512),
    })),
    workspacesTruncated: catalog.workspacesTruncated,
  };
}

const managerGraphLocalAssociationForCatalog = Effect.fn('codeGraph.managerLocalAssociationForCatalog')(function* (
  threadnoteHome: string,
  checkoutId: string,
  catalog: CodeGraphVisualizationCatalog,
  knownStatuses?: readonly ObservedCodeGraphBuildStatus[],
) {
  const statuses = knownStatuses ?? (yield* readAllCodeGraphBuildStatuses(threadnoteHome));
  const liveStatus = Option.getOrUndefined(
    EffectArray.findFirst(
      statuses,
      status =>
        status.identity.checkoutId === checkoutId &&
        status.identity.worktreeId === catalog.viewWorktreeId &&
        status.identity.scopeId === catalog.viewScopeId &&
        status.identity.repositoryId === catalog.repository.repositoryId &&
        status.managerContext !== undefined,
    ),
  );
  return yield* readCodeGraphLocalAssociation(
    threadnoteHome,
    {
      checkoutId,
      repositoryId: catalog.repository.repositoryId,
      worktreeId: catalog.viewWorktreeId,
    },
    liveStatus?.managerContext?.worktreePath,
  );
});

function visualizationRepository(repository: ManagerGraphIndexedView): ManagerGraphVisualization['repository'] {
  return {
    accounting: repository.accounting,
    displayName: repository.displayName,
    id: repository.id,
    metrics: repository.metrics,
    snapshot: repository.snapshot,
  };
}

const resolveManagerGraphView = Effect.fn('codeGraph.resolveManagerGraphView')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  options: {
    readonly expectedSnapshotId: Option.Option<string>;
    readonly includeDependencies: boolean;
    readonly projectOffset?: number;
    readonly projectId?: Option.Option<string>;
    readonly projectLimit: number;
    readonly projectQuery?: Option.Option<string>;
    readonly workspaceOffset?: number;
    readonly workspaceQuery?: Option.Option<string>;
  },
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const parsedView = parseManagerIndexedViewId(indexedViewId);
  if (parsedView === undefined)
    return yield* CodeGraphVisualizationError.make({message: 'Indexed graph checkout is invalid.'});
  const {checkoutId, scopeId, worktreeId} = parsedView;
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const database = Option.getOrUndefined(
    EffectArray.findFirst(databases, candidate => path.basename(path.dirname(candidate)) === checkoutId),
  );
  if (!database) return yield* CodeGraphVisualizationError.make({message: 'Indexed graph checkout was not found.'});
  const catalogOptions = {
    includeDependencies: options.includeDependencies,
    projectOffset: options.projectOffset,
    projectId: options.projectId ?? Option.none(),
    projectLimit: options.projectLimit,
    projectQuery: options.projectQuery ?? Option.none(),
    snapshotId: options.expectedSnapshotId,
    ...(scopeId === undefined ? {} : {scopeId}),
    workspaceLimit: MANAGER_CATALOG_WORKSPACE_LIMIT,
    workspaceOffset: options.workspaceOffset,
    workspaceQuery: options.workspaceQuery ?? Option.none(),
  };
  const catalog = Option.isSome(options.expectedSnapshotId)
    ? yield* store.loadVisualizationCatalog(database, 'deferred', catalogOptions)
    : worktreeId
      ? Option.getOrUndefined(
          EffectArray.findFirst(
            yield* store.loadVisualizationCatalogs(database, 'deferred', catalogOptions),
            candidate => candidate.viewWorktreeId === worktreeId && candidate.viewScopeId === scopeId,
          ),
        )
      : yield* store.loadVisualizationCatalog(database, 'deferred', catalogOptions);
  if (!catalog) {
    return yield* Option.isSome(options.expectedSnapshotId)
      ? ManagerGraphViewUnavailableError.make({
          message: 'The selected graph view changed or was removed. Refresh the graph catalog.',
        })
      : CodeGraphVisualizationError.make({message: 'Indexed graph view has no ready snapshot.'});
  }
  if (worktreeId && catalog.viewWorktreeId !== worktreeId) {
    return yield* CodeGraphVisualizationError.make({
      message: 'Indexed graph snapshot does not belong to the requested view.',
    });
  }
  const retention = yield* retainManagerSnapshot(
    store,
    database,
    catalog.viewWorktreeId,
    catalog.snapshot.id,
    catalog.viewScopeId,
    MANAGER_OPERATION_LEASE_MINIMUM_MILLISECONDS,
    true,
  );
  if (retention.state === 'view-unavailable') {
    return yield* ManagerGraphViewUnavailableError.make({
      message: 'The selected graph view changed or was removed. Refresh the graph catalog.',
    });
  }
  if (retention.state === 'busy') {
    return yield* ManagerGraphBusyError.make({
      message: 'The selected graph is temporarily busy with an active build. Retry after the writer completes.',
    });
  }
  if (retention.state === 'failed') {
    return yield* ManagerGraphLeaseError.make({
      message: 'The selected graph could not be retained safely. Run threadnote doctor --dry-run and retry.',
    });
  }
  return {catalog, checkoutId, database, release: retention.release};
});

function boundedCatalogOffset(value: number | undefined): number {
  return value === undefined || !Number.isSafeInteger(value) ? 0 : Math.max(0, Math.min(1_000_000, Math.floor(value)));
}

function boundedCatalogQuery(value: string | undefined): string {
  return Effect2.pipe(value ?? '', EffectString.trim, EffectString.slice(0, 256));
}

function scopeFromProjectId(projectId: string): CodeGraphVisualizationScope {
  if (Effect2.pipe(projectId, EffectString.startsWith('cgp_'))) return {type: 'component', value: projectId};
  if (projectId === 'facet:repository') return {type: 'all'};
  if (projectId === 'facet:unscoped') return {type: 'unscoped'};
  if (projectId === 'facet:unscoped-documentation') return {type: 'documentation-facet'};
  if (Effect2.pipe(projectId, EffectString.startsWith('package:')))
    return {type: 'package', value: Effect2.pipe(projectId, EffectString.slice('package:'.length))};
  if (Effect2.pipe(projectId, EffectString.startsWith('path:')))
    return {type: 'path', value: Effect2.pipe(projectId, EffectString.slice('path:'.length))};
  return {type: 'all'};
}

function projectIdForSymbol(symbol: CodeGraphSymbol): string {
  if (symbol.resolutionScopeId) return symbol.resolutionScopeId;
  if (symbol.language === 'markdown' || ['document', 'heading', 'section'].includes(symbol.kind)) {
    return 'facet:unscoped-documentation';
  }
  const packageName = Effect2.pipe(symbol.packageName, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (packageName) return `package:${packageName}`;
  return `path:${Effect2.pipe(symbol.path, EffectString.split('/'))[0] || '(root)'}`;
}

function symbolNode(symbol: CodeGraphSymbol, degree: number, projectId?: string): ManagerGraphNode {
  return {
    degree,
    exported: symbol.exported,
    id: symbol.id,
    kind: symbol.kind,
    label: boundedText(symbol.name, 160),
    language: symbol.language,
    path: boundedText(symbol.path, 512),
    projectId: projectId ?? projectIdForSymbol(symbol),
    qualifiedName: boundedText(symbol.qualifiedName, 320),
    type: 'symbol',
  };
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${Effect2.pipe(value, EffectString.slice(0, Math.max(1, maximum - 1)))}…`;
}

function connectionCounts(edges: readonly Pick<ManagerGraphEdge, 'sourceId' | 'targetId'>[]): Map<string, number> {
  const neighbors = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.sourceId === edge.targetId) continue;
    const sourceNeighbors = neighbors.get(edge.sourceId) ?? new Set<string>();
    sourceNeighbors.add(edge.targetId);
    neighbors.set(edge.sourceId, sourceNeighbors);
    const targetNeighbors = neighbors.get(edge.targetId) ?? new Set<string>();
    targetNeighbors.add(edge.sourceId);
    neighbors.set(edge.targetId, targetNeighbors);
  }
  return new Map(EffectArray.map([...neighbors], ([id, connected]) => [id, connected.size]));
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}

function compareIndexedViews(left: ManagerGraphIndexedView, right: ManagerGraphIndexedView): number {
  const leftTime = Date.parse(left.activatedAt ?? left.snapshot.completedAt ?? '') || 0;
  const rightTime = Date.parse(right.activatedAt ?? right.snapshot.completedAt ?? '') || 0;
  return (
    rightTime - leftTime || compareCodeUnits(right.snapshot.id, left.snapshot.id) || compareCodeUnits(left.id, right.id)
  );
}

function indexedViewLabel(catalog: CodeGraphVisualizationCatalog): string {
  const commit = Effect2.pipe(catalog.snapshot.commit, EffectString.slice(0, 8)) || 'no-commit';
  const state = catalog.snapshot.dirty ? 'dirty' : 'clean';
  const indexed = catalog.activatedAt ?? catalog.snapshot.completedAt;
  const indexedLabel = indexed
    ? Effect2.pipe(new Date(indexed).toISOString(), EffectString.slice(0, 16), EffectString.replace('T', ' ')) + 'Z'
    : 'time unknown';
  return `${commit} · ${state}${catalog.viewScopeId === undefined ? '' : ' · scoped graph'} · indexed ${indexedLabel}`;
}

function managerIndexedViewId(checkoutId: string, worktreeId: string, scopeId?: string): string {
  return `${checkoutId}.${worktreeId}${scopeId === undefined ? '' : `.${Effect2.pipe(scopeId, EffectString.slice('code-graph-scope:'.length))}`}`;
}

function parseManagerIndexedViewId(
  indexedViewId: string,
): {readonly checkoutId: string; readonly scopeId?: string; readonly worktreeId?: string} | undefined {
  if (!INDEXED_VIEW_ID.test(indexedViewId)) return undefined;
  const [checkoutId, worktreeId, scopeDigest] = Effect2.pipe(indexedViewId, EffectString.split('.'));
  return {
    checkoutId,
    ...(scopeDigest === undefined ? {} : {scopeId: `code-graph-scope:${scopeDigest}`}),
    ...(worktreeId === undefined ? {} : {worktreeId}),
  };
}

function privacySafeCatalogError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    Effect2.pipe(
      message,
      EffectString.replaceAll(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"`<>]|\\ )+/g, '<local-path>'),
      EffectString.replaceAll(/\s+/g, ' '),
      EffectString.trim,
      EffectString.slice(0, 240),
    ) || 'unknown database error'
  );
}
