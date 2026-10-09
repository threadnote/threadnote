import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {graphAdministrationBusyLabel, mergeGraphCatalogStatus, type GraphCatalog} from '@threadnote/manager/graph';
import {GraphAdministration, GraphReconciliationProgress} from '@threadnote/manager/graph/panels';
import type {CodeGraphLocalDiagnosticsReport} from '@threadnote/graph/diagnostics';

const observed = {
  blockedRepositories: 1,
  checkedAt: '2026-10-09T09:30:00.000Z',
  pendingRepositories: 2,
  viewCleanupAdvanced: true,
  repositoryCount: 3,
  state: 'observed' as const,
  unavailableRepositories: 0,
  viewsTruncated: false,
};

describe('Manager reconciliation visibility', () => {
  it('keeps pending reconciliation separate from exclusive administration work', () => {
    const catalog = {...emptyCatalog(), lifecyclePending: true, reconciliation: observed};
    expect(graphAdministrationBusyLabel(undefined, catalog)).toBeUndefined();
    expect(graphAdministrationBusyLabel('Previewing purge', catalog)).toBe('Previewing purge');
    expect(
      graphAdministrationBusyLabel(undefined, {
        ...catalog,
        maintenance: {operation: 'graph-maintenance', phase: 'working'},
      }),
    ).toContain('Graph maintenance');
    const markup = renderToStaticMarkup(
      createElement(GraphAdministration, {
        busy: graphAdministrationBusyLabel(undefined, catalog),
        onAction: () => {
          throw new Error('Render must not dispatch actions');
        },
        onDiagnostics: () => {
          throw new Error('Render must not dispatch diagnostics');
        },
        report: reportFixture(),
        reconciliation: observed,
      }),
    );
    expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*>Diagnose all<\/button>/);
    expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*>Index<\/button>/);
    expect(markup.indexOf('Reconciliation pending')).toBeLessThan(markup.indexOf('graph-database-grid'));
    const busyMarkup = renderToStaticMarkup(
      createElement(GraphAdministration, {
        busy: 'Previewing purge',
        onAction: () => undefined,
        onDiagnostics: () => undefined,
        report: reportFixture(),
        reconciliation: observed,
      }),
    );
    expect(busyMarkup).toMatch(/<button[^>]*disabled[^>]*>Diagnose all<\/button>/);
  });

  it('shows observed counts, cleanup progress and the last check without claiming a running job', () => {
    const markup = renderToStaticMarkup(createElement(GraphReconciliationProgress, {status: observed}));
    expect(markup).toContain('Reconciliation pending');
    expect(markup).toContain('2 repositories pending');
    expect(markup).toContain('1 needs a verified local folder');
    expect(markup).toContain('Worktree cleanup advanced on the last check');
    expect(markup).toContain('dateTime="2026-10-09T09:30:00.000Z"');
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('Reconciling indexed views');
    expect(markup).not.toContain('progressbar');
    expect(markup).not.toContain('view removed');
  });

  it('explains blocked, deferred, unavailable, completed and bounded observations', () => {
    const render = (status: Parameters<typeof GraphReconciliationProgress>[0]['status']) =>
      renderToStaticMarkup(createElement(GraphReconciliationProgress, {status}));
    expect(render({...observed, pendingRepositories: 1})).toContain('Reconciliation blocked');
    expect(render({...observed, pendingRepositories: 0, blockedRepositories: 0})).toContain('Reconciliation checked');
    expect(render({...observed, pendingRepositories: 0, blockedRepositories: 0, unavailableRepositories: 1})).toContain(
      'Reconciliation partially checked',
    );
    expect(render({...observed, viewsTruncated: true})).toContain('first 32 active views per repository');
    expect(render({state: 'deferred', reason: 'active-build'})).toContain('Waiting for active graph builds');
    expect(render({state: 'deferred', reason: 'maintenance'})).toContain('Waiting for graph maintenance');
    expect(render({state: 'unavailable'})).toContain('Reconciliation status unavailable');
  });

  it('replaces an old observation instead of leaving stale progress after a status update', () => {
    const catalog = {...emptyCatalog(), reconciliation: observed};
    const next = mergeGraphCatalogStatus(catalog, {
      builds: [],
      lifecyclePending: false,
      reconciliation: {state: 'deferred', reason: 'active-build'},
      waiterCount: 0,
      waiters: [],
    });
    expect(next.reconciliation).toEqual({state: 'deferred', reason: 'active-build'});
    const legacy = mergeGraphCatalogStatus(next, {builds: [], lifecyclePending: false, waiterCount: 0, waiters: []});
    expect(legacy.reconciliation).toBeUndefined();
  });

  it('labels a retained snapshot with a missing folder without treating database health as checkout readiness', () => {
    const markup = renderToStaticMarkup(
      createElement(GraphAdministration, {
        onAction: () => undefined,
        onDiagnostics: () => undefined,
        report: reportFixture(),
      }),
    );
    expect(markup).toContain('Retained snapshot');
    expect(markup).toContain('recorded folder is missing');
    expect(markup).toContain('another checkout');
  });
});

function emptyCatalog(): GraphCatalog {
  return {builds: [], diagnostics: [], repositories: [], waiterCount: 0, waiters: []};
}

function reportFixture(): CodeGraphLocalDiagnosticsReport {
  return {
    databases: [
      {
        builds: [],
        checkoutId: 'checkout',
        healthState: 'checked',
        issues: [],
        lifecycle: [],
        storage: {checkoutId: 'checkout', state: 'missing'},
        waiters: [],
        views: [
          {
            localAssociation: {available: false, displayPath: '/synthetic/removed', state: 'missing'},
            managementAvailable: false,
            metrics: 'deferred',
            model: 'workspace',
            projectCount: 0,
            projectsTruncated: false,
            repository: {displayName: 'synthetic/retained', repositoryId: 'repository'},
            snapshot: {
              commit: 'commit',
              dirty: false,
              edgeCount: 0,
              extractorSet: 'extractors',
              fileCount: 0,
              graphContentId: 'snapshot',
              id: 'snapshot',
              repositoryId: 'repository',
              state: 'ready',
              symbolCount: 0,
              worktreeId: 'worktree',
            },
            viewWorktreeId: 'worktree',
            workspaceCount: 0,
            workspacesTruncated: false,
          },
        ],
      },
    ],
    generatedAt: observed.checkedAt,
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
      readySnapshotCount: 1,
      totalStorageBytes: 0,
      unhealthyDatabaseCount: 0,
      unreadableDatabaseCount: 0,
      viewCount: 1,
      waiterCount: 0,
    },
    type: 'code-graph-diagnostics',
    version: 2,
  };
}
