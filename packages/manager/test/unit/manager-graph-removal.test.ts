import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  graphViewRemovalApprovalDialog,
  graphViewRemovalTargetIsAbsent,
  type ManagerGraphViewRemovalResponse,
  type ManagerGraphViewRemovalState,
  withoutRemovedGraphCatalogView,
  withoutRemovedGraphDiagnosticsView,
} from '@threadnote/manager/graph/removal';
import {managerGraphViewRemovalApprovalDigest} from '@threadnote/manager/graph/removal_digest';
import type {CodeGraphLocalDiagnosticsReport} from '@threadnote/graph/diagnostics';
import type {GraphCatalog, GraphRepository, GraphRepositoryGroup} from '@threadnote/manager/graph';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

describe('Manager graph view removal', () => {
  it('offers destructive approval only for the exact ready preview', () => {
    const preview = response('ready');

    expect(graphViewRemovalApprovalDialog(preview)).toEqual({
      confirmLabel: 'Remove view',
      detail: preview.output,
      message:
        'Review this exact dry-run preview. Threadnote will reject the approval if the target changes before removal.',
      title: 'Remove this indexed view?',
      tone: 'danger',
    });
    for (const state of ['already-removed', 'not-found', 'removed', 'stale-target'] as const) {
      expect(graphViewRemovalApprovalDialog(response(state))).toBeUndefined();
    }
  });

  it('removes a confirmed view from both live Manager projections before an authoritative refresh', () => {
    const target = {
      checkoutId: 'checkout',
      expectedSnapshotId: 'snapshot-worktree-b',
      worktreeId: 'worktree-b',
    };
    const catalog = catalogFixture(['worktree-a', 'worktree-b']);
    const diagnostics = diagnosticsFixture(['worktree-a', 'worktree-b']);

    expect(graphViewRemovalTargetIsAbsent(response('removed'))).toBe(true);
    expect(graphViewRemovalTargetIsAbsent(response('already-removed'))).toBe(true);
    expect(graphViewRemovalTargetIsAbsent(response('not-found'))).toBe(true);
    expect(graphViewRemovalTargetIsAbsent(response('stale-target'))).toBe(false);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(withoutRemovedGraphCatalogView(catalog, target)?.repositories[0]?.views),
          __effectArrayReceiver => EffectArray.map(__effectArrayReceiver, view => view.worktreeId),
        ),
      ),
    ).toEqual(['worktree-a']);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(withoutRemovedGraphDiagnosticsView(diagnostics, target)?.databases[0]?.views),
          __effectArrayReceiver => EffectArray.map(__effectArrayReceiver, view => view.viewWorktreeId),
        ),
      ),
    ).toEqual(['worktree-a']);
    expect(withoutRemovedGraphDiagnosticsView(diagnostics, target)?.summary.viewCount).toBe(1);
  });

  it('removes only the selected scope when full and scoped views share a worktree', () => {
    const worktreeId = 'worktree-a';
    const scopeId = `code-graph-scope:${Effect2.pipe('a', EffectString.repeat(64))}`;
    const full = viewFixture(worktreeId);
    const scoped = {...viewFixture(worktreeId), id: 'view-worktree-a-scope-a', scopeId};
    const catalog: GraphCatalog = {
      ...catalogFixture([]),
      repositories: [
        {
          defaultViewId: full.id,
          displayName: 'Repository',
          id: 'repository-group',
          repositoryId: 'repository',
          views: [full, scoped],
          viewsTruncated: false,
        },
      ],
    };
    const baseDiagnostics = diagnosticsFixture([worktreeId]);
    const diagnostics: CodeGraphLocalDiagnosticsReport = {
      ...baseDiagnostics,
      databases: EffectArray.map(baseDiagnostics.databases, database => ({
        ...database,
        views: [...database.views, {...database.views[0], viewScopeId: scopeId}],
      })),
      summary: {...baseDiagnostics.summary, viewCount: 2},
    };
    const target = {
      checkoutId: 'checkout',
      expectedSnapshotId: scoped.snapshot.id,
      scopeId,
      worktreeId,
    };

    expect(withoutRemovedGraphCatalogView(catalog, target)?.repositories[0]?.views).toEqual([full]);
    expect(withoutRemovedGraphDiagnosticsView(diagnostics, target)?.databases[0]?.views).toEqual([
      diagnostics.databases[0].views[0],
    ]);
  });

  effectIt.effect('binds the selected scope into the destructive approval digest', () =>
    Effect.gen(function* () {
      const target = {
        checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
        snapshotId: `cgsn_${Effect2.pipe('b', EffectString.repeat(40))}-direct`,
        worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
      };
      const full = yield* managerGraphViewRemovalApprovalDigest(target);
      const scoped = yield* managerGraphViewRemovalApprovalDigest({
        ...target,
        scopeId: `code-graph-scope:${Effect2.pipe('d', EffectString.repeat(64))}`,
      });

      expect(scoped).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(scoped).not.toBe(full);
    }),
  );

  it('applies removal projections idempotently for any selected view', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({minLength: 1, maxLength: 12}), {minLength: 1, maxLength: 12}), ids => {
        const worktreeId = ids[0];
        const target = {checkoutId: 'checkout', expectedSnapshotId: `snapshot-${worktreeId}`, worktreeId};
        const catalogOnce = withoutRemovedGraphCatalogView(catalogFixture(ids), target);
        const diagnosticsOnce = withoutRemovedGraphDiagnosticsView(diagnosticsFixture(ids), target);

        expect(withoutRemovedGraphCatalogView(catalogOnce, target)).toEqual(catalogOnce);
        expect(withoutRemovedGraphDiagnosticsView(diagnosticsOnce, target)).toEqual(diagnosticsOnce);
      }),
      {numRuns: 100},
    );
  });
});

function response(state: ManagerGraphViewRemovalState): ManagerGraphViewRemovalResponse {
  return {
    approvalDigest: `sha256:${Effect2.pipe('a', EffectString.repeat(64))}`,
    output: 'Would remove exact view and preserve shared snapshot data.',
    result: {state},
  };
}

function catalogFixture(worktreeIds: readonly string[]): GraphCatalog {
  const views = EffectArray.map(worktreeIds, viewFixture);
  return {
    builds: [],
    diagnostics: [],
    repositories:
      views.length === 0
        ? []
        : [
            {
              defaultViewId: views[0].id,
              displayName: 'Repository',
              id: 'repository-group',
              repositoryId: 'repository',
              views,
              viewsTruncated: false,
            } satisfies GraphRepositoryGroup,
          ],
    waiterCount: 0,
    waiters: [],
  };
}

function diagnosticsFixture(worktreeIds: readonly string[]): CodeGraphLocalDiagnosticsReport {
  return {
    databases: [
      {
        builds: [],
        checkoutId: 'checkout',
        healthState: 'checked',
        issues: [],
        lifecycle: [],
        storage: {checkoutId: 'checkout', state: 'missing'},
        views: EffectArray.map(worktreeIds, worktreeId => ({
          localAssociation: {available: false, state: 'missing'},
          managementAvailable: true,
          metrics: 'deferred',
          model: 'workspace',
          projectCount: 0,
          projectsTruncated: false,
          repository: {displayName: 'Repository', repositoryId: 'repository'},
          snapshot: {
            commit: 'commit',
            dirty: false,
            edgeCount: 0,
            extractorSet: 'extractors',
            fileCount: 0,
            graphContentId: `snapshot-${worktreeId}`,
            id: `snapshot-${worktreeId}`,
            repositoryId: 'repository',
            state: 'ready',
            symbolCount: 0,
            worktreeId,
          },
          viewWorktreeId: worktreeId,
          workspaceCount: 0,
          workspacesTruncated: false,
        })),
        waiters: [],
      },
    ],
    generatedAt: '2026-08-10T00:00:00.000Z',
    mode: {analyze: false, deep: false},
    obsoleteStores: {bytes: 0, checkouts: [], fileCount: 0, unsafeEntryCount: 0},
    summary: {
      activeBuildCount: 0,
      analysisCompleteCount: 0,
      analysisPartialCount: 0,
      databaseCount: 1,
      deferredDatabaseCount: 0,
      healthyDatabaseCount: 1,
      migrationPendingDatabaseCount: 0,
      readySnapshotCount: worktreeIds.length,
      totalStorageBytes: 0,
      unhealthyDatabaseCount: 0,
      unreadableDatabaseCount: 0,
      viewCount: worktreeIds.length,
      waiterCount: 0,
    },
    type: 'code-graph-diagnostics',
    version: 2,
  };
}

function viewFixture(worktreeId: string): GraphRepository {
  return {
    accounting: {attributedSymbols: 0, componentSymbols: 0, fallbackSymbols: 0, omittedSymbols: 0, totalSymbols: 0},
    checkoutId: 'checkout',
    displayName: 'Repository',
    id: `view-${worktreeId}`,
    label: worktreeId,
    localAssociation: {available: false, state: 'missing'},
    metrics: 'deferred',
    model: 'workspace',
    projectCount: 0,
    projects: [],
    projectsTruncated: false,
    snapshot: {
      commit: 'commit',
      dirty: false,
      edgeCount: 0,
      fileCount: 0,
      id: `snapshot-${worktreeId}`,
      symbolCount: 0,
    },
    worktreeId,
    workspaceCount: 0,
    workspaces: [],
    workspacesTruncated: false,
  };
}
