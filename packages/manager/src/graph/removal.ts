import {Array as EffectArray} from 'effect';
import type {ManagerDialogOptions} from '@threadnote/manager/dialog';
import type {CodeGraphLocalDiagnosticsReport} from '@threadnote/graph/diagnostics';
import type {GraphCatalog} from '../graph.js';

export type ManagerGraphViewRemovalState = 'already-removed' | 'not-found' | 'ready' | 'removed' | 'stale-target';

export interface ManagerGraphViewRemovalResponse {
  readonly approvalDigest: string;
  readonly output: string;
  readonly result: {
    readonly state: ManagerGraphViewRemovalState;
  };
}

export interface ManagerGraphViewRemovalTarget {
  readonly checkoutId: string;
  readonly expectedSnapshotId: string;
  readonly scopeId?: string;
  readonly worktreeId: string;
}

/** Only a current dry-run target can become the final destructive approval surface. */
export function graphViewRemovalApprovalDialog(
  preview: ManagerGraphViewRemovalResponse,
): ManagerDialogOptions | undefined {
  if (preview.result.state !== 'ready') return undefined;
  return {
    confirmLabel: 'Remove view',
    detail: preview.output,
    message:
      'Review this exact dry-run preview. Threadnote will reject the approval if the target changes before removal.',
    title: 'Remove this indexed view?',
    tone: 'danger',
  };
}

export function graphViewRemovalTargetIsAbsent(response: ManagerGraphViewRemovalResponse): boolean {
  return ['already-removed', 'not-found', 'removed'].includes(response.result.state);
}

/**
 * Apply the confirmed removal to Manager's current catalog immediately. The
 * server remains authoritative; this closes only the bounded refresh window
 * where maintenance can defer the first post-action catalog read.
 */
export function withoutRemovedGraphCatalogView(
  catalog: GraphCatalog | undefined,
  target: ManagerGraphViewRemovalTarget,
): GraphCatalog | undefined {
  if (!catalog) return catalog;
  let changed = false;
  const repositories = EffectArray.flatMap(catalog.repositories, group => {
    const views = EffectArray.filter(group.views, view => {
      const removed = graphViewMatchesRemovalTarget(view, target);
      changed ||= removed;
      return !removed;
    });
    if (views.length === 0) return [];
    if (views.length === group.views.length) return [group];
    return [
      {
        ...group,
        defaultViewId: EffectArray.some(views, view => view.id === group.defaultViewId)
          ? group.defaultViewId
          : views[0].id,
        views,
      },
    ];
  });
  return changed ? {...catalog, repositories} : catalog;
}

/** Keep the Administration card consistent with a confirmed removal. */
export function withoutRemovedGraphDiagnosticsView(
  report: CodeGraphLocalDiagnosticsReport | undefined,
  target: ManagerGraphViewRemovalTarget,
): CodeGraphLocalDiagnosticsReport | undefined {
  if (!report) return report;
  let removedCount = 0;
  const databases = EffectArray.map(report.databases, database => {
    if (database.checkoutId !== target.checkoutId) return database;
    const views = EffectArray.filter(database.views, view => {
      const removed =
        view.viewWorktreeId === target.worktreeId &&
        view.viewScopeId === target.scopeId &&
        view.snapshot.id === target.expectedSnapshotId;
      if (removed) removedCount += 1;
      return !removed;
    });
    return views.length === database.views.length ? database : {...database, views};
  });
  return removedCount === 0
    ? report
    : {
        ...report,
        databases,
        summary: {...report.summary, viewCount: Math.max(0, report.summary.viewCount - removedCount)},
      };
}

function graphViewMatchesRemovalTarget(
  view: {
    readonly checkoutId: string;
    readonly scopeId?: string;
    readonly snapshot: {readonly id: string};
    readonly worktreeId: string;
  },
  target: ManagerGraphViewRemovalTarget,
): boolean {
  return (
    view.checkoutId === target.checkoutId &&
    view.scopeId === target.scopeId &&
    view.worktreeId === target.worktreeId &&
    view.snapshot.id === target.expectedSnapshotId
  );
}
