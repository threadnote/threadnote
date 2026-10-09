import {Effect, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphDatabasePaths} from '../maintenance.js';
import {readCodeGraphLocalAssociation} from '../local_provenance.js';
import {compareCodeUnits} from '../ordering.js';
import {CodeGraphStore} from '../store.js';
import {type CodeGraphActiveViewIdentity} from '../store/models.js';
import type {CodeGraphLifecycleOpportunityTarget} from '../lifecycle/opportunity.js';
import {CODE_GRAPH_MANAGER_CATALOG_REVISION_VERSION} from '../store/schema/revision.js';

export const MANAGER_CATALOG_REVISION_VISIBLE_VIEW_LIMIT = 32;

export interface ManagerGraphCatalogRevisionDatabase {
  readonly checkoutId: string;
  readonly state: 'ready' | 'unavailable';
  readonly views: readonly CodeGraphActiveViewIdentity[];
  readonly viewsTruncated: boolean;
}

export interface ManagerGraphCatalogStatusObservation {
  readonly catalogRevision: string;
  readonly lifecyclePending: boolean;
  readonly lifecycleTargets: readonly CodeGraphLifecycleOpportunityTarget[];
  readonly repositoryCount: number;
  readonly unavailableRepositories: number;
  readonly viewsTruncated: boolean;
}

/** Stable, path-free and order-independent revision for visible active pointers. */
export function managerGraphCatalogRevision(databases: readonly ManagerGraphCatalogRevisionDatabase[]): string {
  const canonical = databases
    .map(database => ({
      checkoutId: database.checkoutId,
      state: database.state,
      views: database.views
        .map(view => ({
          activatedAt: view.activatedAt ?? '',
          repositoryId: view.repositoryId,
          scopeId: view.scopeId ?? '',
          snapshotId: view.snapshotId,
          worktreeId: view.worktreeId,
        }))
        .sort(compareRevisionViews),
      viewsTruncated: database.viewsTruncated,
    }))
    .sort((left, right) => compareCodeUnits(left.checkoutId, right.checkoutId));
  return sha256HexSync(
    `threadnote-manager-graph-catalog-revision-v${CODE_GRAPH_MANAGER_CATALOG_REVISION_VERSION}\n${JSON.stringify(canonical)}`,
  );
}

/** Read the visible active pointers and path-free missing-view status in one bounded pass. */
export const observeManagerGraphCatalogStatus = Effect.fn('codeGraph.observeManagerCatalogStatus')(function* (
  threadnoteHome: string,
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const observations = yield* Effect.forEach(
    databases,
    database =>
      Effect.gen(function* () {
        const checkoutId = path.basename(path.dirname(database));
        const loaded = yield* store
          .loadActiveViewIdentities(database, MANAGER_CATALOG_REVISION_VISIBLE_VIEW_LIMIT + 1)
          .pipe(Effect.option);
        if (loaded._tag === 'None') {
          return {
            database: {
              checkoutId,
              state: 'unavailable' as const,
              views: [],
              viewsTruncated: false,
            },
          };
        }
        const views = loaded.value.slice(0, MANAGER_CATALOG_REVISION_VISIBLE_VIEW_LIMIT);
        const associations = yield* Effect.forEach(
          views,
          view =>
            readCodeGraphLocalAssociation(threadnoteHome, {
              checkoutId,
              repositoryId: view.repositoryId,
              worktreeId: view.worktreeId,
            }),
          {concurrency: 2},
        );
        const anchor = associations.find(association => association.state === 'verified' && 'path' in association);
        const anchorPath = anchor !== undefined && 'path' in anchor ? anchor.path : undefined;
        const reconciliationPending = associations.some(association => association.state === 'missing');
        return {
          database: {
            checkoutId,
            state: 'ready' as const,
            views,
            viewsTruncated: loaded.value.length > MANAGER_CATALOG_REVISION_VISIBLE_VIEW_LIMIT,
          },
          target: {
            ...(anchorPath === undefined ? {} : {anchorPath}),
            checkoutId,
            databasePath: database,
            reconciliationPending,
          } satisfies CodeGraphLifecycleOpportunityTarget,
        };
      }),
    {concurrency: 2},
  );
  const lifecycleTargets = observations.flatMap(observation =>
    observation.target === undefined ? [] : [observation.target],
  );
  return {
    catalogRevision: managerGraphCatalogRevision(observations.map(observation => observation.database)),
    lifecyclePending: lifecycleTargets.some(target => target.reconciliationPending === true),
    lifecycleTargets,
    repositoryCount: databases.length,
    unavailableRepositories: observations.filter(observation => observation.database.state === 'unavailable').length,
    viewsTruncated: observations.some(observation => observation.database.viewsTruncated),
  } satisfies ManagerGraphCatalogStatusObservation;
});

/** Read only the first visible active-pointer identities from each local graph. */
export const observeManagerGraphCatalogRevision = Effect.fn('codeGraph.observeManagerCatalogRevision')(function* (
  threadnoteHome: string,
) {
  return (yield* observeManagerGraphCatalogStatus(threadnoteHome)).catalogRevision;
});

function compareRevisionViews(
  left: {
    readonly activatedAt: string;
    readonly repositoryId: string;
    readonly scopeId: string;
    readonly snapshotId: string;
    readonly worktreeId: string;
  },
  right: {
    readonly activatedAt: string;
    readonly repositoryId: string;
    readonly scopeId: string;
    readonly snapshotId: string;
    readonly worktreeId: string;
  },
): number {
  return (
    compareCodeUnits(left.repositoryId, right.repositoryId) ||
    compareCodeUnits(left.worktreeId, right.worktreeId) ||
    compareCodeUnits(left.scopeId, right.scopeId) ||
    compareCodeUnits(left.snapshotId, right.snapshotId) ||
    compareCodeUnits(left.activatedAt, right.activatedAt)
  );
}
