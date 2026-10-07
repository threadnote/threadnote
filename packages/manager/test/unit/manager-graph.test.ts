import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS} from '@threadnote/graph/build_status/validation';
import {
  cacheGraphNodeDetail,
  createGraphQueryRequestGate,
  graphAnalysisRequestIsCurrent,
  graphAnalysisCoverageLabel,
  graphAnalysisTopologyAvailable,
  graphAdministrationJobSelection,
  graphAdministrationJobView,
  graphAdministrationTarget,
  graphBuildConcurrencyState,
  graphBuildIsActive,
  graphBuildShouldDisplay,
  graphBuildTarget,
  graphCatalogEmptyState,
  graphCatalogRequiresAuthoritativeRefresh,
  graphCatalogSearchOptions,
  graphConfiguredProjectScopeIds,
  graphCatalogPageOffsets,
  graphCatalogContinuationHasMore,
  graphCompletedBuildResultIdentity,
  graphDiagnosticsRequiresCatalogRefresh,
  graphDisplayEdges,
  graphFocusLayoutTargets,
  graphFocusTarget,
  graphMaintenanceRemainingMilliseconds,
  graphMaintenanceStatusLabel,
  graphNodeDetailRequestIsCurrent,
  graphNodeSizeValues,
  graphOverviewSizeLabel,
  graphQueryRequestIsCurrent,
  graphRelationshipCountLabel,
  graphRelationshipSampleLabel,
  graphRequestIsCurrent,
  graphRepositoryOptionLabel,
  graphRepositoryGroupScopeId,
  graphRepositoryScopeLabel,
  graphStatusPollDelay,
  graphStatusRequiresCatalogRefresh,
  graphViewRemovalTarget,
  graphWaiterCountForBuild,
  graphWheelZoomFactor,
  graphWithNodeNeighborhood,
  GraphWorkspace,
  managerGraphDebouncedQueryCandidate,
  managerGraphQueryCandidate,
  mergeGraphCatalogStatus,
  mergeGraphRepositoryGroups,
  orderGraphBuildStatuses,
  resolveGraphSelection,
  type GraphEdge,
  type GraphAnalysis,
  type GraphRepositoryGroup,
  type GraphQueryVisualization,
} from '@threadnote/manager/graph';
import {GraphSummary} from '@threadnote/manager/graph/panels';

describe('manager graph focus', () => {
  it('carries the complete selected graph identity into administration actions', () => {
    expect(
      graphAdministrationTarget('checkout', {
        repository: {repositoryId: 'repository'},
        worktreeId: 'worktree',
      }),
    ).toEqual({checkoutId: 'checkout', repositoryId: 'repository', worktreeId: 'worktree'});
    expect(
      graphViewRemovalTarget('a'.repeat(64), {
        snapshot: {id: `cgsn_${'c'.repeat(40)}-direct`},
        worktreeId: 'b'.repeat(64),
      }),
    ).toEqual({
      checkoutId: 'a'.repeat(64),
      expectedSnapshotId: `cgsn_${'c'.repeat(40)}-direct`,
      worktreeId: 'b'.repeat(64),
    });
  });

  it('distinguishes stored snapshots from active worktree views without requiring a local folder', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const checkoutId = 'a'.repeat(64);
    const worktreeId = 'b'.repeat(64);
    const snapshotId = `cgsn_${'c'.repeat(40)}-direct`;
    const scopeId = `code-graph-scope:${'d'.repeat(64)}`;
    const docsScopeId = `code-graph-scope:${'e'.repeat(64)}`;
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        administration: {
          databases: [
            {
              builds: [
                {
                  ...graphBuildStatus('running'),
                  buildId: 'build-docs',
                  identity: {
                    checkoutId,
                    commit: 'abcdef01',
                    repositoryId: 'd'.repeat(64),
                    scopeId: docsScopeId,
                    worktreeId,
                  },
                  phase: 'resolving',
                },
              ],
              checkoutId,
              health: {integrity: 'migration-pending', readySnapshots: 3},
              healthState: 'checked',
              issues: [],
              storage: {state: 'available', totalBytes: 0},
              views: [
                {
                  localAssociation: {available: false, state: 'legacy-unknown'},
                  managementAvailable: false,
                  metrics: 'complete',
                  model: 'workspace',
                  projectCount: 0,
                  projectsTruncated: false,
                  repository: {displayName: 'acme/platform', repositoryId: 'd'.repeat(64)},
                  snapshot: {edgeCount: 0, fileCount: 0, id: snapshotId, symbolCount: 0},
                  viewScopeId: scopeId,
                  viewWorktreeId: worktreeId,
                  workspaceCount: 0,
                  workspacesTruncated: false,
                },
                {
                  localAssociation: {
                    available: true,
                    displayPath: '~/docs',
                    path: '/repos/platform/apps/docs',
                    state: 'verified',
                  },
                  managementAvailable: false,
                  metrics: 'complete',
                  model: 'workspace',
                  projectCount: 0,
                  projectsTruncated: false,
                  repository: {displayName: 'acme/platform', repositoryId: 'd'.repeat(64)},
                  snapshot: {
                    edgeCount: 0,
                    fileCount: 0,
                    id: `cgsn_${'e'.repeat(40)}-direct`,
                    symbolCount: 0,
                  },
                  viewScopeId: docsScopeId,
                  viewWorktreeId: worktreeId,
                  workspaceCount: 0,
                  workspacesTruncated: false,
                },
              ],
              waiters: [],
            },
          ],
          generatedAt: '2026-08-08T12:00:00.000Z',
          mode: {analyze: false, deep: false},
          obsoleteStores: {bytes: 0, checkouts: [], fileCount: 0, unsafeEntryCount: 0},
          summary: {databaseCount: 1, readySnapshotCount: 3, viewCount: 2},
          type: 'code-graph-diagnostics',
          version: 2,
        } as never,
        catalog: {
          builds: [],
          configuredProjects: [
            {folder: 'mobile', graphState: 'ready', name: 'mobile', path: '/repos/platform', scopeId},
            {folder: 'docs', graphState: 'ready', name: 'docs', path: '/repos/platform', scopeId: docsScopeId},
          ],
          diagnostics: [],
          repositories: [],
          waiterCount: 0,
          waiters: [],
        },
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onAdministrationAction: () => undefined,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('1 graph database · 3 stored ready snapshots · 2 active worktree views');
    expect(markup).toContain('<details class="graph-administration" open="">');
    expect(markup).toContain('class="graph-administration-caret"');
    expect(markup).toContain('<dt>Stored ready snapshots</dt><dd>3</dd>');
    expect(markup).toContain('<dt>Active worktree views</dt><dd>2</dd>');
    expect(markup).toContain('Snapshot and view counts can differ');
    expect(markup).toContain('<strong>acme/platform: mobile</strong>');
    expect(markup).not.toContain('Active view bbbbbbbb');
    expect(markup.match(/aria-label="Remove active worktree view bbbbbbbb"/g)).toHaveLength(2);
    expect(markup).toContain(
      '<p class="graph-database-job">acme/platform: docs · folder ~/docs · active · resolving · active</p>',
    );
    expect(markup).toContain('title="Remove active worktree view"');
    expect(markup).not.toContain('Preview remove');
    expect(markup).toContain('class="is-migration-pending">migrating</em>');
    expect(markup).not.toContain('>incompatible</em>');
    expect(markup).toContain('Index, reindex, and compact require a verified local worktree path.');
  });

  it('labels graph storage without a folder or ready snapshot as disposable and unassociated', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        administration: {
          databases: [
            {
              builds: [],
              checkoutId: 'a'.repeat(64),
              health: {integrity: 'ok', readySnapshots: 0},
              healthState: 'checked',
              issues: [],
              storage: {state: 'available', totalBytes: 12_000},
              views: [],
              waiters: [],
            },
          ],
          generatedAt: '2026-08-12T12:00:00.000Z',
          mode: {analyze: false, deep: false},
          obsoleteStores: {bytes: 0, checkouts: [], fileCount: 0, unsafeEntryCount: 0},
          summary: {databaseCount: 1, readySnapshotCount: 0, viewCount: 0},
          type: 'code-graph-diagnostics',
          version: 2,
        } as never,
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onAdministrationAction: () => undefined,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('<strong>Unassociated graph storage</strong>');
    expect(markup).toContain('No verified local folder or ready snapshot');
    expect(markup).toContain('This disposable graph has no queryable snapshot.');
    expect(markup).toContain('threadnote graph index --cwd &lt;path&gt;');
    expect(markup).not.toContain('<strong>Indexed repository</strong>');
  });

  it('renders the graph workspace before its first catalog response', () => {
    const neverResolves = () => new Promise<never>(() => undefined);

    expect(() =>
      renderToStaticMarkup(
        createElement(GraphWorkspace, {
          loadAnalysis: neverResolves,
          loadCatalogPage: neverResolves,
          loadGraph: neverResolves,
          loadNodeDetail: neverResolves,
          loadQuery: neverResolves,
          loadViewsPage: neverResolves,
          onRefresh: () => undefined,
        }),
      ),
    ).not.toThrow();
  });

  it('separates the scrollable graph view from status and administration', async () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {builds: [], diagnostics: [], repositories: [], waiterCount: 0, waiters: []},
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );
    const css = await Bun.file(new URL('../../static/app.css', import.meta.url)).text();

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('id="graph-explore-tab"');
    expect(markup).toContain('aria-controls="graph-administration-panel"');
    expect(markup).toMatch(/class="graph-tab-panel graph-administration-tab" hidden=""[^>]*role="tabpanel"/);
    expect(markup).toContain('id="graph-explore-panel" role="tabpanel" tabindex="0"');
    expect(css).toMatch(/\.graph-tab-panel\s*{[^}]*overflow: auto;/s);
    expect(css).toMatch(/\.graph-explorer-tab\s*{[^}]*minmax\(440px, 1fr\)/s);
    expect(css).toMatch(/\.graph-administration-caret\s*{[^}]*transform: rotate\(-90deg\)/s);
    expect(css).toMatch(/\.graph-administration\[open\] \.graph-administration-caret\s*{[^}]*rotate\(0deg\)/s);
  });

  it('offers configured projects for first-time indexing and distinguishes ready snapshots', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {
          builds: [],
          configuredProjects: [
            {
              folder: 'cold-project',
              graphState: 'not-indexed',
              name: 'cold-project',
              path: '/repos/cold-project',
            },
            {
              folder: 'ready-project',
              graphState: 'ready',
              name: 'ready-project',
              path: '/repos/ready-project',
            },
            {
              folder: 'hidden-project',
              graphState: 'unknown',
              name: 'hidden-project',
              path: '/repos/hidden-project',
            },
          ],
          diagnostics: [],
          manifestRevision: 'a'.repeat(64),
          repositories: [],
          waiterCount: 0,
          waiters: [],
        },
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onAdministrationAction: () => undefined,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('<strong>Configured projects</strong>');
    expect(markup).toContain('<option value="cold-project" selected="">cold-project</option>');
    expect(markup).toContain('<option value="ready-project">ready-project</option>');
    expect(markup).toContain('<option value="hidden-project">hidden-project</option>');
    expect(markup).toContain('No ready snapshot · /repos/cold-project');
    expect(markup).toContain('>Index graph</button>');
    expect(markup).toContain('3 configured projects are ready to initialize from Manager.');
    expect(markup).toContain('>Choose a configured project</button>');
    expect(markup).not.toContain('<code>threadnote graph index</code>');

    const emptyMarkup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {
          builds: [],
          configuredProjects: [],
          diagnostics: [],
          manifestRevision: 'a'.repeat(64),
          repositories: [],
          waiterCount: 0,
          waiters: [],
        },
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onAdministrationAction: () => undefined,
        onRefresh: () => undefined,
      }),
    );
    expect(emptyMarkup).toContain('No configured projects');
    expect(emptyMarkup).toMatch(/<button disabled="" type="button">Index graph<\/button>/);
    expect(emptyMarkup).toContain('<code>threadnote graph index</code>');
  });

  it('orders build status banners by stable folder or checkout identity', () => {
    const earlier = {
      ...graphBuildStatus('running'),
      buildId: 'build-z',
      identity: {
        ...graphBuildStatus('running').identity,
        checkoutId: 'checkout-z',
        worktreeId: 'worktree-z',
      },
      managerContext: {worktreePath: '/worktrees/zeta'},
      timestamps: {
        ...graphBuildStatus('running').timestamps,
        lastProgressAt: '2026-07-31T12:00:00.000Z',
      },
    };
    const later = {
      ...graphBuildStatus('running'),
      buildId: 'build-a',
      identity: {
        ...graphBuildStatus('running').identity,
        checkoutId: 'checkout-a',
        worktreeId: 'worktree-a',
      },
      managerContext: {worktreePath: '/worktrees/alpha'},
      timestamps: {
        ...graphBuildStatus('running').timestamps,
        lastProgressAt: '2026-07-31T13:00:00.000Z',
      },
    };

    expect(orderGraphBuildStatuses([earlier, later]).map(build => build.buildId)).toEqual(['build-a', 'build-z']);
    expect(
      orderGraphBuildStatuses([
        {...earlier, managerContext: undefined},
        {...later, managerContext: undefined},
      ]).map(build => build.buildId),
    ).toEqual(['build-a', 'build-z']);
  });

  it('renders selected snapshot purge progress alongside graph build progress', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {
          builds: [],
          diagnostics: [],
          maintenance: {
            checkoutId: 'a'.repeat(64),
            completed: 3,
            operation: 'selected-snapshot-purge',
            phase: 'verifying-graph',
            snapshotId: `cgsn_${'b'.repeat(40)}-direct`,
            startedAt: '2026-08-09T12:00:00.000Z',
            total: 5,
            updatedAt: '2026-08-09T12:00:01.000Z',
          },
          repositories: [],
          waiterCount: 0,
          waiters: [],
        },
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('Selected snapshot purge');
    expect(markup).toContain('rechecking graph safety evidence');
    expect(markup).toContain('3 / 5 safety phases');
    expect(markup).toContain('aria-label="60% complete"');
  });

  it('renders a retry state when the initial catalog request fails', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalogError: 'Graph catalog is temporarily busy.',
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('Indexed repositories unavailable');
    expect(markup).toContain('Graph catalog is temporarily busy.');
    expect(markup).toContain('Try again');
    expect(markup).not.toContain('Loading indexed repositories');
  });

  it('keeps a status-only catalog retry cause-neutral without maintenance evidence', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {builds: [], diagnostics: [], repositories: [], waiterCount: 0, waiters: []},
        catalogError: 'The graph catalog request timed out.',
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(graphCatalogEmptyState({builds: [], catalogError: 'timeout'})).toBe('retrying');
    expect(markup).toContain('Retrying indexed repositories');
    expect(markup).toContain('retrying the indexed repository catalog');
    expect(markup).not.toContain('finishing graph maintenance');
  });

  it('renders stale live owners with a home-abbreviated repository path and status facts', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const baseRepository = repositoryGroup('repository', ['view-a'], 'view-a');
    const repository = {
      ...baseRepository,
      displayName: 'example/repository',
      views: baseRepository.views.map(view => ({
        ...view,
        localAssociation: {
          available: true,
          branch: 'feature/manager-labels',
          displayPath: '~/jobs/repository-task-17',
          path: '/tmp/jobs/repository-task-17',
          state: 'verified' as const,
        },
      })),
    };
    const build = {
      ...graphBuildStatus('running'),
      coordination: {lockVerified: true, progressSilent: true, role: 'owner' as const},
      identity: {
        ...graphBuildStatus('running').identity,
        checkoutId: 'view-a',
        worktreeId: 'view-a',
      },
      managerContext: {worktreePath: '/tmp/jobs/repository-task-17'},
    };
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {builds: [build], diagnostics: [], repositories: [repository], waiterCount: 0, waiters: []},
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('example/repository');
    expect(markup).toContain('~/jobs/repository-task-17');
    expect(markup).not.toContain('/tmp/jobs/repository-task-17');
    expect(markup).toContain('Indexing status is stale');
    expect(markup).toContain('Manager cannot determine whether its current operation is advancing.');
    expect(markup).not.toContain('Phase ETA paused');
    expect(markup).not.toContain('progress is silent');
  });

  it('streams path-free extraction dimensions and slow-file telemetry for active builds', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const build = {
      ...graphBuildStatus('running'),
      activity: {
        batchCompleted: 7,
        batchTotal: 12,
        bytes: 70 * 1_024,
        classifier: 'typescript',
        factsBytes: 18 * 1_024,
        language: 'typescript',
        parseMilliseconds: 1_250,
        relations: 21,
        role: 'source',
        sizeBucket: '64-256KiB' as const,
        stage: 'extracting' as const,
        symbols: 9,
      },
      counters: {completed: 7, total: 12, unit: 'files'},
      extraction: {
        completedFiles: 7,
        slowFiles: 2,
        topSlowFiles: [],
      },
    };
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {builds: [build], diagnostics: [], repositories: [], waiterCount: 0, waiters: []},
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('64-256KiB source bucket');
    expect(markup).toContain('source/typescript');
    expect(markup).toContain('18.0 KiB emitted facts');
    expect(markup).toContain('9 symbols');
    expect(markup).toContain('21 relations');
    expect(markup).toContain('Extraction telemetry: 7 files completed');
    expect(markup).toContain('2 at or above 1.00s');
  });

  it('explains a repository-wide incremental fallback while materialization is active', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const build = {
      ...graphBuildStatus('running'),
      counters: {completed: 37_209, reused: 58_482, total: 59_076, unit: 'files'},
      materialization: {
        metrics: {
          attributedFilesCompleted: 6,
          batchesCompleted: 707,
          batchesTotal: 933,
          cachedFactReplayBytesCompleted: 12_288,
          crossGenerationShardFilesCompleted: 0,
          exactGenerationShardFilesCompleted: 3,
          fallbackReason: 'file-set-changed',
          materializedShardReplayBytesCompleted: 8_192,
          mode: 'full' as const,
          rawFactReplayBytesCompleted: 4_096,
          sourceBytesCompleted: 1,
          sourceBytesTotal: 2,
        },
      },
      phase: 'materializing',
    };
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {builds: [build], diagnostics: [], repositories: [], waiterCount: 0, waiters: []},
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('Full materialization selected');
    expect(markup).toContain('incremental fallback: file set changed');
    expect(markup).toContain('Physical cache replay: 12.0 KiB total decoded');
    expect(markup).toContain('8.00 KiB materialized-shard payloads decoded');
    expect(markup).toContain('4.00 KiB raw parser-fact payloads decoded');
    expect(markup).toContain('6 raw parser-fact files postprocessed and attributed');
    expect(markup).toContain('3 files selected from exact-generation materialized shards');
    expect(markup).toContain('0 files selected from cross-generation materialized shards');
  });

  it('shows the active owner, latest queued target, and stale queryable snapshot without claiming FIFO order', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const baseRepository = repositoryGroup('repository', ['worktree'], 'worktree');
    const repository = {
      ...baseRepository,
      views: baseRepository.views.map(view => ({
        ...view,
        checkoutId: 'checkout',
        snapshot: {...view.snapshot, commit: '1111111111111111111111111111111111111111'},
        worktreeId: 'worktree',
      })),
    };
    const build = {
      ...graphBuildStatus('running'),
      buildId: 'active-build',
      coordination: {lockVerified: true, role: 'owner' as const},
      identity: {...graphBuildStatus('running').identity, commit: '222222222222'},
      owner: {processId: 42, processStartIdentity: 'opaque-process-start-00000042'},
    };
    const waiter = {
      ...graphBuildStatus('queued'),
      buildId: 'latest-waiter',
      identity: {...build.identity, commit: '333333333333'},
      request: {key: 'latest-request'},
      timestamps: {
        ...graphBuildStatus('queued').timestamps,
        startedAt: '2026-07-31T12:01:00.000Z',
      },
    };

    expect(graphBuildConcurrencyState(build, [waiter], [repository])).toEqual({
      activeTargetCommit: '222222222222',
      latestTargetCommit: '333333333333',
      queuedRequests: 1,
      readySnapshotCommit: '1111111111111111111111111111111111111111',
      staleReady: true,
    });
    const otherScopeWaiter = {
      ...waiter,
      buildId: 'other-scope-waiter',
      identity: {...waiter.identity, scopeId: `code-graph-scope:${'a'.repeat(64)}`},
    };
    expect(graphBuildConcurrencyState(build, [waiter, otherScopeWaiter], [repository]).queuedRequests).toBe(1);

    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {builds: [build], diagnostics: [], repositories: [repository], waiterCount: 1, waiters: [waiter]},
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('Active target 222222222222');
    expect(markup).toContain('latest target 333333333333 queued');
    expect(markup).toContain('1 queued request');
    expect(markup).toContain('Ready snapshot 111111111111 remains queryable');
    expect(markup).toContain('stale for latest target 333333333333');
    expect(markup).toContain('Process 42 · owner instance 00000042');
    expect(markup).not.toContain('queue position');
  });

  it('uses catalog fallbacks before either a view or continuation exists', () => {
    expect(graphCatalogContinuationHasMore(undefined, undefined, 'projectHasMore', false)).toBe(false);
    expect(graphCatalogContinuationHasMore(undefined, undefined, 'workspaceHasMore', true)).toBe(true);
    expect(
      graphCatalogContinuationHasMore(
        {
          projectHasMore: true,
          projectOffset: 10,
          viewHasMore: true,
          viewId: 'view-a',
          viewOffset: 4,
          workspaceHasMore: false,
          workspaceOffset: 3,
        },
        'view-b',
        'projectHasMore',
        false,
      ),
    ).toBe(false);
  });

  it('polls active graph builds within the two-second Manager freshness contract', () => {
    expect(graphStatusPollDelay([])).toBe(5_000);
    expect(graphStatusPollDelay([graphBuildStatus('running')])).toBe(1_000);
    expect(graphStatusPollDelay([graphBuildStatus('queued')])).toBe(1_000);
    expect(graphStatusPollDelay([graphBuildStatus('completed')])).toBe(5_000);
    expect(graphStatusPollDelay([], undefined, true)).toBe(1_000);
    expect(
      graphStatusPollDelay([], undefined, false, {startedAt: '2026-08-12T00:00:00.000Z', state: 'inspecting'}),
    ).toBe(1_000);
    const maintenance = {
      checkoutId: 'a'.repeat(64),
      completed: 3,
      operation: 'selected-snapshot-purge' as const,
      phase: 'verifying-graph' as const,
      snapshotId: `cgsn_${'b'.repeat(40)}-direct`,
      total: 5,
    };
    expect(graphStatusPollDelay([], maintenance)).toBe(1_000);
    expect(graphMaintenanceStatusLabel(maintenance)).toBe('Selected snapshot purge · rechecking graph safety evidence');
    expect(
      graphMaintenanceStatusLabel({
        completed: 2,
        operation: 'graph-maintenance',
        phase: 'verifying-graph',
        startedAt: '2026-09-09T00:00:00.000Z',
        total: 4,
      }),
    ).toBe('Graph maintenance · verifying graph store');
    expect(
      graphMaintenanceRemainingMilliseconds(
        {
          completed: 2,
          startedAt: '2026-09-09T00:00:00.000Z',
          total: 4,
        },
        Date.parse('2026-09-09T00:00:10.000Z'),
      ),
    ).toBe(10_000);
    const abandoned = {
      ...graphBuildStatus('running'),
      observation: {heartbeatAgeMilliseconds: 60_000, liveness: 'abandoned' as const},
    };
    expect(graphBuildIsActive(abandoned)).toBe(false);
    expect(graphBuildShouldDisplay(abandoned)).toBe(false);
    expect(graphStatusPollDelay([abandoned])).toBe(5_000);
    const staleOwner = {
      ...graphBuildStatus('running'),
      coordination: {lockVerified: true, progressSilent: true, role: 'owner' as const},
    };
    expect(graphBuildIsActive(staleOwner)).toBe(true);
    expect(graphBuildShouldDisplay(staleOwner)).toBe(true);
    const recentFailed = graphBuildStatus('failed');
    expect(graphBuildShouldDisplay(recentFailed)).toBe(true);
    expect(
      graphBuildShouldDisplay({
        ...recentFailed,
        observation: {
          heartbeatAgeMilliseconds: CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS,
          liveness: 'failed',
        },
      }),
    ).toBe(true);
    expect(
      graphBuildShouldDisplay({
        ...recentFailed,
        observation: {
          heartbeatAgeMilliseconds: CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS + 1,
          liveness: 'failed',
        },
      }),
    ).toBe(false);
    expect(
      graphBuildShouldDisplay({
        ...recentFailed,
        observation: {heartbeatAgeMilliseconds: Number.POSITIVE_INFINITY, liveness: 'failed'},
      }),
    ).toBe(false);
  });

  it('shows live reclaiming status when the full graph catalog is not available yet', () => {
    const reclaiming = {
      ...graphBuildStatus('running'),
      counters: {completed: 0, pagesCompleted: 14, rowsDeleted: 2_048, total: 61, unit: 'snapshots'},
      phase: 'reclaiming',
      subphase: 'superseded-snapshots',
    };

    const merged = mergeGraphCatalogStatus(undefined, {
      automaticCompaction: {
        checkoutId: 'a'.repeat(64),
        opportunityBytes: 19.6 * 1024 ** 3,
        startedAt: '2026-08-12T00:00:00.000Z',
        state: 'running',
      },
      builds: [reclaiming],
      lifecyclePending: false,
      storage: {
        checkout: {
          databaseBytes: 22 * 1024 ** 3,
          pageStorage: {
            allocatedBytes: 22 * 1024 ** 3,
            automaticCompaction: 'eligible',
            inUseBytes: 2.35 * 1024 ** 3,
            reclaimableRatio: 0.893,
            reusableBytes: 19.65 * 1024 ** 3,
            state: 'available',
          },
          physicalBytes: 22 * 1024 ** 3,
          sidecarBytes: 0,
          state: 'available',
        },
      },
      waiterCount: 0,
      waiters: [],
    });

    expect(merged).toMatchObject({builds: [reclaiming], diagnostics: [], repositories: []});
    expect(graphAdministrationJobSelection(merged.builds, merged.waiters).jobs).toEqual([reclaiming]);
    const neverResolves = () => new Promise<never>(() => undefined);
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: merged,
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );
    expect(markup).toContain('reclaiming/superseded-snapshots');
    expect(markup).toContain('2,048 rows reclaimed');
    expect(markup).toContain('22.0 GiB physical SQLite file + sidecars');
    expect(markup).toContain('2.35 GiB pages in use');
    expect(markup).toContain('19.6 GiB reusable inside SQLite');
    expect(markup).toContain('eligible for automatic compaction after retry-cooldown and maintenance safety checks');
    expect(markup).toContain('Automatic graph storage compaction');
    expect(markup).toContain('Compacting Indexed repository in an isolated process without blocking Manager');
    expect(markup).toContain('Refreshing indexed repositories');
    expect(markup).toContain('Existing indexes will return here automatically.');
    expect(markup).not.toContain('No indexed repositories yet');
    expect(markup).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    const previousMaintenance = {
      checkoutId: 'a'.repeat(64),
      completed: 3,
      operation: 'selected-snapshot-purge' as const,
      phase: 'verifying-graph' as const,
      snapshotId: `cgsn_${'b'.repeat(40)}-direct`,
      total: 5,
    };
    const configuredProject = {
      folder: 'cold-project',
      graphState: 'not-indexed' as const,
      name: 'cold-project',
      path: '/repos/cold-project',
    };
    const afterMaintenance = mergeGraphCatalogStatus(
      {
        ...merged,
        catalogRevision: 'visible-revision',
        configuredProjects: [configuredProject],
        maintenance: previousMaintenance,
        manifestRevision: 'manifest-revision',
      },
      {builds: [reclaiming], lifecyclePending: false, waiterCount: 0, waiters: []},
    );
    expect(afterMaintenance.catalogRevision).toBe('visible-revision');
    expect(afterMaintenance.maintenance).toBeUndefined();
    expect(afterMaintenance.automaticCompaction).toEqual(merged.automaticCompaction);
    expect(afterMaintenance.storage).toEqual(merged.storage);
    expect(afterMaintenance.configuredProjects).toEqual([configuredProject]);
    expect(afterMaintenance.manifestRevision).toBe('manifest-revision');
  });

  it('shows only a bounded actionable administration job summary', () => {
    const builds = [
      {...graphBuildStatus('completed'), buildId: 'completed'},
      {...graphBuildStatus('running'), buildId: 'running'},
      {...graphBuildStatus('failed'), buildId: 'failed'},
      {
        ...graphBuildStatus('failed'),
        buildId: 'expired-failed',
        observation: {
          heartbeatAgeMilliseconds: CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS + 1,
          liveness: 'failed' as const,
        },
      },
    ];
    const waiters = Array.from({length: 5}, (_, index) => ({
      ...graphBuildStatus('queued'),
      buildId: `waiter-${index}`,
    }));
    const selected = graphAdministrationJobSelection(builds, waiters);

    expect(selected.jobs).toHaveLength(2);
    expect(selected.total).toBe(2);
    expect(selected.hiddenCount).toBe(0);
    expect(selected.jobs.map(job => job.state)).not.toContain('completed');
    expect(selected.jobs.map(job => job.buildId)).not.toContain('expired-failed');
    expect(selected.jobs[0]?.buildId).toBe('running');

    const neverResolves = () => new Promise<never>(() => undefined);
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {builds, diagnostics: [], repositories: [], waiterCount: waiters.length, waiters},
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );
    expect(markup.match(/class="graph-build-card/g)).toHaveLength(2);
    expect(markup).not.toContain('older build notices are summarized.');
    expect(markup).toContain('aria-label="2 status notices"');
  });

  it('shows one build card when an exact-target request is queued behind its owner', () => {
    const owner = {...graphBuildStatus('queued'), buildId: 'owner', request: {key: 'same-request'}};
    const waiter = {...graphBuildStatus('queued'), buildId: 'waiter', request: {key: 'same-request'}};
    const otherScopeWaiter = {
      ...waiter,
      buildId: 'other-scope-waiter',
      identity: {...waiter.identity, scopeId: `code-graph-scope:${'a'.repeat(64)}`},
    };
    const selection = graphAdministrationJobSelection([owner], [waiter]);

    expect(selection.jobs).toEqual([owner]);
    expect(selection.total).toBe(1);
    expect(graphWaiterCountForBuild(owner, [waiter, otherScopeWaiter])).toBe(1);
    expect(graphWaiterCountForBuild(waiter, [waiter])).toBe(0);
    expect(graphBuildConcurrencyState(owner, [waiter], []).queuedRequests).toBe(1);
  });

  it('refreshes a terminal snapshot missing from the catalog and scopes waiters to their build', () => {
    expect(graphCatalogRequiresAuthoritativeRefresh(false)).toBe(true);
    expect(
      graphCatalogRequiresAuthoritativeRefresh(false, {
        operation: 'selected-snapshot-purge',
        phase: 'waiting-builders',
        startedAt: '2026-08-12T12:00:00.000Z',
        total: 1,
      }),
    ).toBe(false);
    expect(graphCatalogRequiresAuthoritativeRefresh(true)).toBe(false);

    const catalog = {
      builds: [],
      catalogRevision: 'revision-before-removal',
      diagnostics: [],
      repositories: [repositoryGroup('repository', ['known-snapshot'], 'known-snapshot')],
      waiterCount: 0,
      waiters: [],
    };
    expect(graphStatusRequiresCatalogRefresh(catalog, [], new Set(), 'revision-after-removal')).toBe(true);
    expect(graphStatusRequiresCatalogRefresh(catalog, [], new Set(), 'revision-before-removal')).toBe(false);
    expect(
      graphStatusRequiresCatalogRefresh(catalog, [
        {...graphBuildStatus('completed'), result: {snapshotId: 'new-snapshot'}},
      ]),
    ).toBe(true);
    const visibleBuild = {
      ...graphBuildStatus('completed'),
      identity: {
        ...graphBuildStatus('completed').identity,
        checkoutId: 'known-snapshot',
        worktreeId: 'known-snapshot',
      },
      result: {snapshotId: 'snapshot-known-snapshot'},
    };
    expect(graphStatusRequiresCatalogRefresh(catalog, [visibleBuild])).toBe(false);
    expect(
      graphStatusRequiresCatalogRefresh(catalog, [
        {...graphBuildStatus('completed'), result: {snapshotId: 'snapshot-known-snapshot'}},
      ]),
    ).toBe(true);
    const truncatedCatalog = {
      ...catalog,
      repositories: [{...catalog.repositories[0], viewsTruncated: true}],
    };
    const hiddenBuild = {...graphBuildStatus('completed'), result: {snapshotId: 'hidden-snapshot'}};
    expect(graphStatusRequiresCatalogRefresh(truncatedCatalog, [hiddenBuild])).toBe(true);
    expect(
      graphStatusRequiresCatalogRefresh(
        truncatedCatalog,
        [hiddenBuild],
        new Set([graphCompletedBuildResultIdentity(hiddenBuild)!]),
      ),
    ).toBe(false);
    expect(
      graphStatusRequiresCatalogRefresh(
        {
          ...truncatedCatalog,
          repositories: [
            {
              ...truncatedCatalog.repositories[0],
              views: [
                {
                  ...truncatedCatalog.repositories[0].views[0],
                  checkoutId: 'checkout',
                  worktreeId: 'worktree',
                },
              ],
            },
          ],
        },
        [{...graphBuildStatus('completed'), result: {snapshotId: 'promoted-snapshot'}}],
      ),
    ).toBe(true);

    const owner = {...graphBuildStatus('running'), request: {key: 'request-a'}};
    const matching = {...graphBuildStatus('queued'), buildId: 'waiter-a', request: {key: 'request-a'}};
    const otherCheckout = {
      ...graphBuildStatus('queued'),
      buildId: 'waiter-b',
      identity: {...graphBuildStatus('queued').identity, checkoutId: 'other-checkout'},
      request: {key: 'request-a'},
    };
    const otherRequest = {...graphBuildStatus('queued'), buildId: 'waiter-c', request: {key: 'request-b'}};
    expect(graphWaiterCountForBuild(owner, [matching, otherCheckout, otherRequest])).toBe(1);
    expect(graphWaiterCountForBuild(graphBuildStatus('running'), [matching])).toBe(0);
  });

  it('keeps administration diagnostics pending until the exact catalog revision succeeds', () => {
    expect(graphDiagnosticsRequiresCatalogRefresh(undefined, 'revision-after-removal')).toBe(true);
    expect(graphDiagnosticsRequiresCatalogRefresh('revision-before-removal', 'revision-after-removal')).toBe(true);
    expect(graphDiagnosticsRequiresCatalogRefresh('revision-after-removal', 'revision-after-removal')).toBe(false);
    expect(
      graphDiagnosticsRequiresCatalogRefresh('revision-before-removal', 'revision-after-removal', {
        checkoutId: 'a'.repeat(64),
        completed: 0,
        operation: 'graph-maintenance',
        phase: 'working',
        startedAt: '2026-08-10T00:00:00.000Z',
        total: 1,
        updatedAt: '2026-08-10T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('keeps a selected indexed view across refresh and falls back deterministically after removal', () => {
    const groups: readonly GraphRepositoryGroup[] = [repositoryGroup('repo-a', ['view-new', 'view-old'], 'view-new')];
    expect(resolveGraphSelection(groups, 'repo-a', 'view-old')).toEqual({
      repositoryId: 'repo-a',
      viewId: 'view-old',
    });
    expect(resolveGraphSelection([repositoryGroup('repo-a', ['view-new'], 'view-new')], 'repo-a', 'view-old')).toEqual({
      repositoryId: 'repo-a',
      viewId: 'view-new',
    });
    expect(resolveGraphSelection([repositoryGroup('repo-b', ['view-b'], 'view-b')], 'repo-a', 'view-old')).toEqual({
      repositoryId: 'repo-b',
      viewId: 'view-b',
    });
  });

  it('disambiguates distinct logical repositories that share a display name', () => {
    const first = {...repositoryGroup('11111111-logical', ['view-a'], 'view-a'), displayName: 'mobile-native'};
    const second = {...repositoryGroup('22222222-logical', ['view-b'], 'view-b'), displayName: 'mobile-native'};
    expect(graphRepositoryOptionLabel(first, [first, second])).toBe('mobile-native · repository 11111111');
    expect(graphRepositoryOptionLabel(second, [first, second])).toBe('mobile-native · repository 22222222');
  });

  it('uses configured project names for scoped repository labels with a bounded identity fallback', () => {
    const scopeId = `code-graph-scope:${'a'.repeat(64)}`;
    expect(graphRepositoryScopeLabel('acme/platform', scopeId, [{name: 'mobile', scopeId}])).toBe(
      'acme/platform: mobile',
    );
    expect(graphRepositoryScopeLabel('acme/platform', scopeId)).toBe('acme/platform: scope aaaaaaaa');
    expect(graphRepositoryScopeLabel('acme/platform', undefined)).toBe('acme/platform');
    expect(
      graphRepositoryGroupScopeId({
        views: [{scopeId}] as never,
        viewsTruncated: false,
      }),
    ).toBe(scopeId);
    expect(
      graphRepositoryGroupScopeId({
        views: [{scopeId}] as never,
        viewsTruncated: true,
      }),
    ).toBeUndefined();
  });

  it('matches administration jobs to the exact worktree scope', () => {
    const worktreeId = 'b'.repeat(64);
    const firstScope = `code-graph-scope:${'1'.repeat(64)}`;
    const secondScope = `code-graph-scope:${'2'.repeat(64)}`;
    const views = [
      {viewScopeId: firstScope, viewWorktreeId: worktreeId},
      {viewScopeId: secondScope, viewWorktreeId: worktreeId},
    ] as never;
    expect(
      graphAdministrationJobView(views, {
        identity: {
          checkoutId: 'checkout',
          commit: 'commit',
          repositoryId: 'repository',
          scopeId: secondScope,
          worktreeId,
        },
      }),
    ).toMatchObject({viewScopeId: secondScope});
  });

  it('labels build banners with their global repository and home-abbreviated worktree path', () => {
    const baseRepository = repositoryGroup('repo-a', ['view-a'], 'view-a');
    const repository = {
      ...baseRepository,
      views: baseRepository.views.map(view => ({
        ...view,
        localAssociation: {
          available: true,
          branch: 'feature/manager-labels',
          displayPath: '~/jobs/repo-a-task-17',
          path: '/tmp/jobs/repo-a-task-17',
          state: 'verified' as const,
        },
      })),
    };
    const build = {
      ...graphBuildStatus('running'),
      identity: {
        ...graphBuildStatus('running').identity,
        checkoutId: 'view-a',
        displayName: 'example/repo-a',
        repositoryId: 'repo-a',
        worktreeId: 'view-a',
      },
      managerContext: {branch: 'feature/manager-labels', worktreePath: '/tmp/jobs/repo-a-task-17'},
    };
    expect(graphBuildTarget(build, [repository])).toEqual({
      repositoryLabel: 'repo-a',
      worktreeLabel: 'observed worktree branch feature/manager-labels · ~/jobs/repo-a-task-17',
    });
    expect(graphBuildTarget({...build, managerContext: undefined}, [baseRepository])).toEqual({
      repositoryLabel: 'repo-a',
      worktreeLabel: 'view-a',
    });
    const scopeId = `code-graph-scope:${'a'.repeat(64)}`;
    expect(
      graphBuildTarget(
        {...build, identity: {...build.identity, scopeId}},
        [repository],
        [{folder: 'mobile', graphState: 'ready', name: 'mobile', path: '/repos/platform', scopeId}],
      ),
    ).toEqual({
      repositoryLabel: 'repo-a: mobile',
      worktreeLabel: 'build-start branch feature/manager-labels · /tmp/jobs/repo-a-task-17',
    });
    const {managerContext: _managerContext, ...buildWithoutContext} = build;
    expect(graphBuildTarget({...build, identity: {...build.identity, repositoryId: 'missing'}}, [])).toEqual({
      repositoryLabel: 'example/repo-a',
      worktreeLabel: 'build-start branch feature/manager-labels · /tmp/jobs/repo-a-task-17',
    });
    expect(
      graphBuildTarget({...buildWithoutContext, identity: {...build.identity, repositoryId: 'missing'}}, []),
    ).toEqual({
      repositoryLabel: 'example/repo-a',
      worktreeLabel: 'Local folder unavailable · commit abcdef01',
    });
  });

  it('shows graph scope names in first-build progress and indexed snapshot selectors', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const docsScopeId = `code-graph-scope:${'a'.repeat(64)}`;
    const mobileScopeId = `code-graph-scope:${'b'.repeat(64)}`;
    const baseRepository = repositoryGroup('acme/platform', ['docs-view', 'mobile-view'], 'docs-view');
    const repository = {
      ...baseRepository,
      views: baseRepository.views.map((view, index) => ({
        ...view,
        checkoutId: 'checkout',
        scopeId: index === 0 ? docsScopeId : mobileScopeId,
        worktreeId: 'worktree',
      })),
    };
    const build = {
      ...graphBuildStatus('running'),
      identity: {
        ...graphBuildStatus('running').identity,
        displayName: 'acme/platform',
        repositoryId: 'not-ready-yet',
        scopeId: mobileScopeId,
      },
    };
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {
          builds: [build],
          configuredProjects: [
            {folder: 'docs', graphState: 'ready', name: 'docs', path: '/repos/platform', scopeId: docsScopeId},
            {
              folder: 'mobile',
              graphState: 'ready',
              name: 'mobile',
              path: '/repos/platform',
              scopeId: mobileScopeId,
            },
          ],
          diagnostics: [],
          repositories: [repository],
          waiterCount: 0,
          waiters: [],
        },
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('<strong>acme/platform: mobile</strong>');
    expect(markup).toContain('acme/platform: docs · docs-view');
    expect(markup).toContain('acme/platform: mobile · mobile-view');
  });

  it('rejects an analysis response after its repository, snapshot, or request generation changes', () => {
    expect(graphAnalysisRequestIsCurrent(4, 4, 'repo-a:snapshot-1', 'repo-a:snapshot-1')).toBe(true);
    expect(graphAnalysisRequestIsCurrent(5, 4, 'repo-a:snapshot-1', 'repo-a:snapshot-1')).toBe(false);
    expect(graphAnalysisRequestIsCurrent(4, 4, 'repo-b:snapshot-1', 'repo-a:snapshot-1')).toBe(false);
    expect(graphAnalysisRequestIsCurrent(4, 4, 'repo-a:snapshot-2', 'repo-a:snapshot-1')).toBe(false);
  });

  it('rejects stale graph responses after a scope or request generation change', () => {
    expect(graphRequestIsCurrent(7, 7, 'repo:snapshot:component:240', 'repo:snapshot:component:240')).toBe(true);
    expect(graphRequestIsCurrent(8, 7, 'repo:snapshot:component:240', 'repo:snapshot:component:240')).toBe(false);
    expect(graphRequestIsCurrent(7, 7, 'repo:snapshot:other:240', 'repo:snapshot:component:240')).toBe(false);
  });

  it('normalizes explicit queries while debouncing only useful typed graph-query text', () => {
    expect(managerGraphQueryCandidate('  hydration manager  ')).toBe('hydration manager');
    expect(managerGraphQueryCandidate('ab')).toBe('ab');
    expect(managerGraphQueryCandidate('   ')).toBeUndefined();
    expect(managerGraphDebouncedQueryCandidate('ab')).toBeUndefined();
    expect(managerGraphDebouncedQueryCandidate(' api ')).toBe('api');
    expect(managerGraphQueryCandidate('x'.repeat(513))).toBeUndefined();
  });

  it('rejects cancelled or stale code-query responses across rapid input and snapshot changes', () => {
    const result = queryVisualization('hydrate document');
    const controller = new AbortController();
    expect(
      graphQueryRequestIsCurrent(
        false,
        12,
        12,
        'repository:snapshot:hydrate document:240:640',
        'repository:snapshot:hydrate document:240:640',
        result,
        'snapshot',
        'hydrate document',
      ),
    ).toBe(true);
    controller.abort();
    expect(
      graphQueryRequestIsCurrent(
        controller.signal.aborted,
        12,
        12,
        'repository:snapshot:hydrate document:240:640',
        'repository:snapshot:hydrate document:240:640',
        result,
        'snapshot',
        'hydrate document',
      ),
    ).toBe(false);
    expect(
      graphQueryRequestIsCurrent(
        false,
        13,
        12,
        'repository:snapshot:next query:240:640',
        'repository:snapshot:hydrate document:240:640',
        result,
        'snapshot',
        'hydrate document',
      ),
    ).toBe(false);
    expect(
      graphQueryRequestIsCurrent(
        false,
        12,
        12,
        'repository:snapshot:hydrate document:240:640',
        'repository:snapshot:hydrate document:240:640',
        {...result, repository: {...result.repository, snapshot: {...result.repository.snapshot, id: 'promoted'}}},
        'snapshot',
        'hydrate document',
      ),
    ).toBe(false);
    expect(
      graphQueryRequestIsCurrent(
        false,
        12,
        12,
        'repository:snapshot:hydrate document:240:640',
        'repository:snapshot:hydrate document:240:640',
        {...result, query: {...result.query, text: 'next query'}},
        'snapshot',
        'hydrate document',
      ),
    ).toBe(false);
  });

  it('aborts superseded query requests and rejects completed late responses through the workspace gate', async () => {
    const cancellationGate = createGraphQueryRequestGate();
    let cancelledSignal: AbortSignal | undefined;
    const cancelled = cancellationGate.request(
      {expectedQuery: 'first query', expectedSnapshotId: 'snapshot', scope: 'repository:snapshot:first query'},
      signal => {
        cancelledSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Superseded', 'AbortError')), {once: true});
        });
      },
    );
    const acceptedAfterCancellation = cancellationGate.request(
      {expectedQuery: 'second query', expectedSnapshotId: 'snapshot', scope: 'repository:snapshot:second query'},
      () => Promise.resolve(queryVisualization('second query')),
    );
    expect(cancelledSignal?.aborted).toBe(true);
    await expect(cancelled.result).resolves.toEqual({state: 'cancelled'});
    await expect(acceptedAfterCancellation.result).resolves.toMatchObject({state: 'accepted'});

    const staleResponseGate = createGraphQueryRequestGate();
    let lateSignal: AbortSignal | undefined;
    let resolveLate: ((graph: GraphQueryVisualization) => void) | undefined;
    const late = staleResponseGate.request(
      {expectedQuery: 'late query', expectedSnapshotId: 'snapshot', scope: 'repository:snapshot:late query'},
      signal => {
        lateSignal = signal;
        return new Promise(resolve => {
          resolveLate = resolve;
        });
      },
    );
    const acceptedAfterLateResponse = staleResponseGate.request(
      {expectedQuery: 'current query', expectedSnapshotId: 'snapshot', scope: 'repository:snapshot:current query'},
      () => Promise.resolve(queryVisualization('current query')),
    );
    expect(lateSignal?.aborted).toBe(true);
    resolveLate?.(queryVisualization('late query'));
    await expect(late.result).resolves.toMatchObject({state: 'stale'});
    await expect(acceptedAfterLateResponse.result).resolves.toMatchObject({state: 'accepted'});
  });

  it('rejects a late node detail after rapid selection, cancellation, or snapshot promotion', () => {
    const selected = nodeDetail('selected', 'selected', []);
    expect(graphNodeDetailRequestIsCurrent(false, selected, 'snapshot', 'selected')).toBe(true);
    expect(graphNodeDetailRequestIsCurrent(true, selected, 'snapshot', 'selected')).toBe(false);
    expect(graphNodeDetailRequestIsCurrent(false, selected, 'snapshot', 'next-selection')).toBe(false);
    expect(
      graphNodeDetailRequestIsCurrent(false, {...selected, snapshotId: 'previous-snapshot'}, 'snapshot', 'selected'),
    ).toBe(false);
  });

  it('does not present unavailable topology as zero communities, components, or hubs', () => {
    const unavailable = graphAnalysis('unavailable', false);
    expect(graphAnalysisTopologyAvailable(unavailable)).toBe(false);
    expect(graphAnalysisCoverageLabel(unavailable)).toBe('Topology unavailable');
    const partial = graphAnalysis('partial', false, true);
    expect(graphAnalysisTopologyAvailable(partial)).toBe(true);
    expect(graphAnalysisCoverageLabel(partial)).toBe('Topology partial');
    expect(graphAnalysisCoverageLabel(graphAnalysis('partial', false, false))).toBe('Bounded topology');
    expect(graphAnalysisCoverageLabel(graphAnalysis('complete', true))).toBe('Complete');
  });

  it('labels every partial topology as bounded observed evidence in the graph summary', () => {
    const markup = renderToStaticMarkup(
      createElement(GraphSummary, {
        analysis: graphAnalysis('partial', false, true),
        analysisError: '',
        analysisLoading: false,
        graph: queryVisualization('partial analysis'),
        onAnalyze: () => undefined,
        sizeMetric: 'connections',
      }),
    );
    expect(markup).toContain('Bounded graph analysis');
    expect(markup).toContain('Observed communities');
    expect(markup).toContain('Observed components');
    expect(markup).toContain('Observed hubs');
    expect(markup).not.toContain('Whole-graph analysis');
  });

  it('centers a searched detail node and zooms into its labels', () => {
    expect(graphFocusTarget({x: 0, y: 0, zoom: 0.6}, {x: 125, y: -48}, 'detail')).toEqual({
      x: 125,
      y: -48,
      zoom: 2.8,
    });
  });

  it('caps an excessive user zoom while centering the selected node', () => {
    expect(graphFocusTarget({x: 20, y: 30, zoom: 4.5}, {x: -90, y: 12}, 'overview')).toEqual({
      x: -90,
      y: 12,
      zoom: 2.43,
    });
  });

  it('bounds a single wheel event before applying the global camera clamp', () => {
    expect(graphWheelZoomFactor(-1_000_000)).toBe(1.38);
    expect(graphWheelZoomFactor(1_000_000)).toBe(0.72);
    expect(graphWheelZoomFactor(0)).toBe(1);
  });

  it('isolates incoming and outgoing selection neighborhoods after relation filtering', () => {
    const edges: readonly GraphEdge[] = [
      edge('incoming-call', 'source', 'selected', 'calls'),
      edge('outgoing-call', 'selected', 'target', 'calls'),
      edge('outgoing-import', 'selected', 'module', 'imports'),
      edge('unrelated', 'other', 'another', 'calls'),
    ];

    expect(graphDisplayEdges(edges, 'selected', 'incoming', 'all').map(item => item.id)).toEqual(['incoming-call']);
    expect(graphDisplayEdges(edges, 'selected', 'outgoing', 'calls').map(item => item.id)).toEqual(['outgoing-call']);
    expect(graphDisplayEdges(edges, 'selected', 'neighbors', 'all').map(item => item.id)).toEqual([
      'incoming-call',
      'outgoing-call',
      'outgoing-import',
    ]);
    expect(graphDisplayEdges(edges, undefined, 'neighbors', 'imports').map(item => item.id)).toEqual([
      'outgoing-import',
    ]);
  });

  it('sizes nodes by distinct neighbors instead of duplicate relationship edges', () => {
    const edges: readonly GraphEdge[] = [
      edge('a-b-call', 'a', 'b', 'calls'),
      edge('a-b-import', 'a', 'b', 'imports'),
      edge('c-a-call', 'c', 'a', 'calls'),
      edge('a-d-call', 'a', 'd', 'calls'),
    ];

    expect(Object.fromEntries(graphNodeSizeValues(edges, 'connections'))).toEqual({
      a: 3,
      b: 1,
      c: 1,
      d: 1,
    });
    expect(Object.fromEntries(graphNodeSizeValues(edges, 'incoming'))).toEqual({
      a: 1,
      b: 1,
      d: 1,
    });
    expect(Object.fromEntries(graphNodeSizeValues(edges, 'outgoing'))).toEqual({
      a: 2,
      c: 1,
    });
  });

  it('labels overview sizing from the metric that is actually present', () => {
    const base = queryVisualization('overview');
    const overview = {
      ...base,
      mode: 'overview' as const,
      nodes: [{...graphNode('component', 'Component'), symbolCount: 42, type: 'project' as const}],
    };
    expect(graphOverviewSizeLabel(overview)).toBe('Component symbols');
    expect(
      graphOverviewSizeLabel({
        ...overview,
        nodes: overview.nodes.map(({symbolCount: _symbolCount, ...node}) => node),
        repository: {...overview.repository, metrics: 'deferred'},
      }),
    ).toBe('Visible relationship degree');
  });

  it('marks sampled high-degree relationship counts as lower bounds with the sample size', () => {
    const detail = {
      ...nodeDetail('god-node', 'Coordinator', []),
      stats: {
        incoming: 1_500,
        outgoing: 500,
        provenances: [{count: 2_000, provenance: 'resolved'}],
        relations: [{count: 2_000, incoming: 1_500, outgoing: 500, relation: 'calls'}],
        sampledEdges: 2_000,
        summaryTruncated: true,
        truncated: true,
      },
    };
    expect(graphRelationshipCountLabel(detail.stats.incoming, detail.stats.summaryTruncated)).toBe('≥1,500');
    expect(graphRelationshipSampleLabel(detail)).toBe('Counts are lower bounds from a 2,000-edge sample.');
    expect(graphRelationshipCountLabel(12, false)).toBe('12');
  });

  it('merges continuation pages without dropping loaded views or component options', () => {
    const initial = repositoryGroup('repo', ['view-00'], 'view-00');
    const continued = repositoryGroup('repo', ['view-01'], 'view-01');
    const project = {
      id: 'cgp_late_target',
      label: '//apps/late:target',
      model: 'component' as const,
      provenance: 'declared',
    };
    const continuation = {
      ...continued,
      views: [{...continued.views[0], projects: [project], projectsTruncated: false}],
    };
    const merged = mergeGraphRepositoryGroups([{...initial, viewsTruncated: true}], [continuation]);
    expect(merged[0]?.views.map(view => view.id)).toEqual(['view-00', 'view-01']);
    expect(merged[0]?.views.find(view => view.id === 'view-01')?.projects).toContainEqual(project);
    expect(merged[0]?.viewsTruncated).toBe(true);

    const refreshed = repositoryGroup('repo', ['view-00'], 'view-00');
    const stalePage = {
      ...refreshed,
      views: [
        {
          ...refreshed.views[0],
          projects: [project],
          snapshot: {...refreshed.views[0].snapshot, id: 'stale-snapshot'},
        },
      ],
    };
    expect(mergeGraphRepositoryGroups([refreshed], [stalePage])[0]?.views[0]?.projects).toEqual([]);

    const promotedPage = {
      ...refreshed,
      views: [
        {
          ...refreshed.views[0],
          activatedAt: '2026-08-02T12:00:00.000Z',
          projects: [project],
          snapshot: {
            ...refreshed.views[0].snapshot,
            completedAt: '2026-08-02T11:59:00.000Z',
            id: 'promoted-snapshot',
          },
        },
      ],
    };
    const previousPage = {
      ...refreshed,
      views: [
        {
          ...refreshed.views[0],
          activatedAt: '2026-08-01T12:00:00.000Z',
          snapshot: {...refreshed.views[0].snapshot, completedAt: '2026-08-01T11:59:00.000Z'},
        },
      ],
    };
    expect(mergeGraphRepositoryGroups([previousPage], [promotedPage])[0]?.views[0]?.snapshot.id).toBe(
      'promoted-snapshot',
    );
    expect(mergeGraphRepositoryGroups([promotedPage], [previousPage])[0]?.views[0]?.snapshot.id).toBe(
      'promoted-snapshot',
    );
  });

  it('keeps unfiltered catalog cursors independent from merged search hits', () => {
    const initial = repositoryGroup('repo', ['view-00', 'view-01'], 'view-00');
    const baseRepository = {
      ...initial.views[0],
      checkoutId: 'checkout',
      projects: [
        {id: 'cgp_first', label: '//apps:first'},
        {id: 'cgp_second', label: '//apps:second'},
      ],
      workspaces: [
        {buildSystem: 'bazel', id: 'workspace-1', name: 'one', root: 'apps/one'},
        {buildSystem: 'bazel', id: 'workspace-2', name: 'two', root: 'apps/two'},
      ],
    };
    const baseRepositoryGroup = {
      ...initial,
      views: [baseRepository, {...initial.views[1], checkoutId: 'checkout'}],
    };
    const searchResult = {
      ...baseRepository,
      projects: [{id: 'cgp_out_of_prefix', label: '//z:last'}],
      workspaces: [{buildSystem: 'bazel', id: 'workspace-z', name: 'last', root: 'z'}],
    };
    const merged = mergeGraphRepositoryGroups(
      [baseRepositoryGroup],
      [{...baseRepositoryGroup, views: [searchResult]}],
    )[0];
    expect(merged.views[0]?.projects).toHaveLength(3);
    expect(merged.views[0]?.workspaces).toHaveLength(3);
    expect(
      graphCatalogPageOffsets({
        baseRepository,
        baseRepositoryGroup,
        checkoutId: 'checkout',
        viewId: baseRepository.id,
      }),
    ).toEqual({projectOffset: 2, viewOffset: 2, workspaceOffset: 2});
    expect(
      graphCatalogPageOffsets({
        baseRepository,
        baseRepositoryGroup,
        checkoutId: 'checkout',
        continuation: {projectOffset: 64, viewId: baseRepository.id, viewOffset: 32, workspaceOffset: 48},
        viewId: baseRepository.id,
      }),
    ).toEqual({projectOffset: 64, viewOffset: 32, workspaceOffset: 48});
  });

  it('turns catalog search responses into visible actionable component and view options', () => {
    const group = repositoryGroup('repo', ['view-current', 'view-match'], 'view-current');
    const currentView = {
      ...group.views[0],
      projects: [
        {
          buildSystem: 'bazel',
          id: 'cgp_checkout',
          kind: 'target',
          label: '//apps/checkout:library',
          workspaceId: 'cgw_mobile',
        },
      ],
      workspaces: [{buildSystem: 'bazel', id: 'cgw_mobile', name: 'mobile workspace', root: 'apps/mobile'}],
    };
    const matchingView = {
      ...group.views[1],
      label: 'feature/mobile-auth',
      scopeId: `code-graph-scope:${'a'.repeat(64)}`,
      localAssociation: {
        available: true,
        displayPath: '~/src/mobile-auth',
        path: '/home/tester/src/mobile-auth',
        state: 'verified' as const,
      },
    };

    const configuredProjects = [
      {name: 'mobile', scopeId: matchingView.scopeId},
      {name: 'mobile-admin', scopeId: `code-graph-scope:${'b'.repeat(64)}`},
      {name: 'full-repository'},
    ];
    const result = graphCatalogSearchOptions(currentView, [{...group, views: [matchingView]}], configuredProjects);

    expect(result.projects).toEqual([
      expect.objectContaining({
        description: expect.stringContaining('mobile workspace'),
        id: 'cgp_checkout',
        label: '//apps/checkout:library',
        viewId: 'view-current',
      }),
    ]);
    expect(result.views).toEqual([
      expect.objectContaining({
        description: expect.stringContaining('folder ~/src/mobile-auth'),
        id: 'view-match',
        label: 'feature/mobile-auth: mobile',
        repositoryId: 'repo',
      }),
    ]);
    expect(graphConfiguredProjectScopeIds('MOBILE', configuredProjects)).toEqual([
      matchingView.scopeId,
      `code-graph-scope:${'b'.repeat(64)}`,
    ]);
    expect(graphConfiguredProjectScopeIds('full', configuredProjects)).toEqual([]);
    const broadMatches = Array.from({length: 40}, (_, index) => ({
      name: `mobile-${index.toString().padStart(2, '0')}`,
      scopeId: `code-graph-scope:${index.toString(16).padStart(64, '0')}`,
    }));
    expect(graphConfiguredProjectScopeIds('mobile', broadMatches)).toEqual(
      broadMatches.slice(0, 32).map(project => project.scopeId),
    );
  });

  it('keeps the selected node anchored while separating highlighted node labels', () => {
    const nodes = [
      {id: 'selected', label: 'RuntimeConfig', radius: 12, x: 0, y: 0},
      ...Array.from({length: 12}, (_, index) => ({
        id: `neighbor-${index}`,
        label: `src/feature/long-neighbor-${index}.ts`,
        radius: 7,
        x: 2,
        y: 2,
      })),
    ];
    const edges = nodes
      .slice(1)
      .flatMap((node, index) => [
        edge(`edge-${index}`, 'selected', node.id, 'calls'),
        edge(`duplicate-${index}`, 'selected', node.id, 'imports'),
      ]);
    const labelSizes = new Map(nodes.map(node => [node.id, {height: node.id === 'selected' ? 24 : 15, width: 170}]));

    const targets = graphFocusLayoutTargets(nodes, 'selected', edges, labelSizes, 2.8);

    expect(targets.get('selected')).toEqual({x: 0, y: 0});
    expect(targets.size).toBe(nodes.length);
    const targetLabels = nodes.map(node => {
      const position = targets.get(node.id)!;
      const size = labelSizes.get(node.id)!;
      return {
        bottom: position.y + size.height / 2 / 2.8,
        id: node.id,
        left: position.x + (node.radius + 4) / 2.8,
        right: position.x + (node.radius + 4 + size.width) / 2.8,
        top: position.y - size.height / 2 / 2.8,
      };
    });
    for (const [index, left] of targetLabels.entries()) {
      for (const right of targetLabels.slice(index + 1)) {
        const overlaps =
          Math.min(left.right, right.right) > Math.max(left.left, right.left) &&
          Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top);
        expect(overlaps, `${left.id} overlaps ${right.id}`).toBe(false);
      }
    }
  });

  it('does not move nodes when there is no selected focus', () => {
    expect(
      graphFocusLayoutTargets(
        [
          {id: 'a', label: 'a', radius: 6, x: 0, y: 0},
          {id: 'b', label: 'b', radius: 6, x: 1, y: 1},
        ],
        undefined,
        [edge('a-b', 'a', 'b', 'calls')],
      ).size,
    ).toBe(0);
  });

  it('pulls distant highlighted neighbors into a compact local orbit', () => {
    const nodes = [
      {id: 'selected', label: 'selected', radius: 10, x: 0, y: 0},
      ...Array.from({length: 12}, (_, index) => ({
        id: `neighbor-${index}`,
        label: `neighbor-${index}`,
        radius: 6,
        x: 1_000 + index * 100,
        y: -1_000 - index * 100,
      })),
    ];
    const targets = graphFocusLayoutTargets(
      nodes,
      'selected',
      nodes.slice(1).map((node, index) => edge(`edge-${index}`, 'selected', node.id, 'calls')),
    );

    expect(
      Math.max(
        ...nodes
          .slice(1)
          .map(node => targets.get(node.id)!)
          .map(position => Math.hypot(position.x, position.y)),
      ),
    ).toBeLessThan(100);
  });

  it('pushes a visible unhighlighted label away from the anchored selection', () => {
    const nodes = [
      {id: 'selected', label: 'RuntimeConfig', radius: 12, x: 0, y: 0},
      {id: 'neighbor', label: 'apps/threadnote/src/runtime.ts', radius: 7, x: 100, y: 100},
      {id: 'obstacle', label: 'apps/threadnote/src/threadnote.ts', radius: 7, x: 0, y: 0},
    ];
    const labelSizes = new Map([
      ['selected', {height: 24, width: 104}],
      ['neighbor', {height: 15, width: 90}],
      ['obstacle', {height: 15, width: 96}],
    ]);

    const targets = graphFocusLayoutTargets(
      nodes,
      'selected',
      [edge('selected-neighbor', 'selected', 'neighbor', 'calls')],
      labelSizes,
      2.8,
    );

    expect(targets.get('selected')).toEqual({x: 0, y: 0});
    expect(targets.get('obstacle')).not.toEqual({x: 0, y: 0});
  });

  it('adds a replaceable direct neighborhood from lazy node details', () => {
    const graph = {
      edges: [edge('selected-existing', 'selected', 'existing', 'calls')],
      mode: 'detail' as const,
      nodes: [
        graphNode('selected', 'withExclusiveFileLock'),
        graphNode('existing', 'CodeGraphQueryService'),
        graphNode('unrelated', 'unrelated'),
      ],
      paging: {edgeLimit: 640, hasMore: false, nodeLimit: 240},
      projectId: 'package:threadnote',
      repository: {
        accounting: {
          attributedSymbols: 12_000,
          componentSymbols: 12_000,
          fallbackSymbols: 0,
          omittedSymbols: 0,
          totalSymbols: 12_000,
        },
        checkoutId: 'repository',
        displayName: 'threadnote',
        id: 'repository',
        label: 'repository',
        metrics: 'complete' as const,
        model: 'workspace' as const,
        projects: [],
        snapshot: {
          commit: 'commit',
          dirty: true,
          edgeCount: 10_000,
          fileCount: 100,
          id: 'snapshot',
          symbolCount: 12_000,
        },
        worktreeId: 'worktree',
        workspaces: [],
      },
      scope: {id: 'package:threadnote', label: 'threadnote'},
      stats: {
        renderedEdges: 1,
        renderedNodes: 3,
        totalEdges: 10_000,
        totalNodes: 12_000,
      },
      warnings: ['bounded working set'],
    };
    const detail = nodeDetail('selected', 'withExclusiveFileLock', [
      relationship('selected-existing', 'outgoing', 'existing', 'CodeGraphQueryService'),
      relationship('incoming-missing', 'incoming', 'missing-in', 'appendProductionLogs'),
      relationship('outgoing-missing', 'outgoing', 'missing-out', 'ensureCommit'),
    ]);

    const expanded = graphWithNodeNeighborhood(graph, detail);

    expect(expanded.nodes.map(node => node.id)).toEqual([
      'selected',
      'existing',
      'unrelated',
      'missing-in',
      'missing-out',
    ]);
    expect(expanded.edges.map(item => [item.id, item.sourceId, item.targetId])).toEqual([
      ['selected-existing', 'selected', 'existing'],
      ['incoming-missing', 'missing-in', 'selected'],
      ['outgoing-missing', 'selected', 'missing-out'],
    ]);
    expect(expanded.nodes.find(node => node.id === 'selected')?.degree).toBe(3);
    expect(expanded.stats).toMatchObject({renderedEdges: 3, renderedNodes: 5});
    expect(expanded.warnings.at(-1)).toBe('Loaded 2 direct neighbors for withExclusiveFileLock.');
    expect(graph.nodes).toHaveLength(3);
  });

  it('bounds the node-detail cache and evicts the least recently refreshed entry', () => {
    const cache = new Map<string, ReturnType<typeof nodeDetail>>();
    for (let index = 0; index < 130; index += 1) {
      cacheGraphNodeDetail(cache, `node-${index}`, nodeDetail(`node-${index}`, `node-${index}`, []), 128);
    }
    expect(cache.size).toBe(128);
    expect(cache.has('node-0')).toBe(false);
    expect(cache.has('node-1')).toBe(false);
    cacheGraphNodeDetail(cache, 'node-2', cache.get('node-2')!, 128);
    cacheGraphNodeDetail(cache, 'node-130', nodeDetail('node-130', 'node-130', []), 128);
    expect(cache.has('node-2')).toBe(true);
    expect(cache.has('node-3')).toBe(false);
  });
});

function graphAnalysis(
  state: GraphAnalysis['coverage']['topology']['state'],
  complete: boolean,
  nodesComplete = state === 'complete',
): GraphAnalysis {
  return {
    communities: [],
    coverage: {complete, nodesComplete, topology: {complete: state === 'complete', state}},
    hubs: [],
    statistics: {
      analyzedEdgeCount: 0,
      analyzedNodeCount: 0,
      communityCount: 0,
      connectedComponentCount: 0,
      maximumDegree: 0,
    },
    surprisingLinks: [],
    warnings: [],
  };
}

function queryVisualization(query: string): GraphQueryVisualization {
  return {
    edges: [],
    mode: 'detail',
    nodes: [],
    paging: {edgeLimit: 640, hasMore: false, nodeLimit: 240},
    projectId: 'query',
    query: {matchedNodes: 0, state: 'ready', text: query, warnings: []},
    repository: {
      accounting: {
        attributedSymbols: 0,
        componentSymbols: 0,
        fallbackSymbols: 0,
        omittedSymbols: 0,
        totalSymbols: 0,
      },
      displayName: 'threadnote',
      id: 'repository',
      metrics: 'complete',
      snapshot: {
        commit: 'commit',
        dirty: false,
        edgeCount: 0,
        fileCount: 0,
        id: 'snapshot',
        symbolCount: 0,
      },
    },
    scope: {id: 'query', label: query},
    stats: {renderedEdges: 0, renderedNodes: 0, totalEdges: 0, totalNodes: 0},
    warnings: [],
  };
}

function repositoryGroup(id: string, viewIds: readonly string[], defaultViewId: string): GraphRepositoryGroup {
  return {
    defaultViewId,
    displayName: id,
    id,
    repositoryId: id,
    viewsTruncated: false,
    views: viewIds.map(viewId => ({
      accounting: {
        attributedSymbols: 0,
        componentSymbols: 0,
        fallbackSymbols: 0,
        omittedSymbols: 0,
        totalSymbols: 0,
      },
      checkoutId: viewId,
      displayName: id,
      id: viewId,
      label: viewId,
      localAssociation: {available: false, state: 'legacy-unknown'},
      metrics: 'complete',
      model: 'workspace',
      projectCount: 0,
      projects: [],
      projectsTruncated: false,
      snapshot: {
        commit: 'abcdef01',
        dirty: false,
        edgeCount: 0,
        fileCount: 0,
        id: `snapshot-${viewId}`,
        symbolCount: 0,
      },
      worktreeId: viewId,
      workspaceCount: 0,
      workspaces: [],
      workspacesTruncated: false,
    })),
  };
}

function graphBuildStatus(state: 'completed' | 'failed' | 'queued' | 'running') {
  const timestamp = '2026-07-31T12:00:00.000Z';
  return {
    buildId: `build-${state}`,
    counters: {},
    identity: {
      checkoutId: 'checkout',
      commit: 'abcdef01',
      repositoryId: 'repository',
      worktreeId: 'worktree',
    },
    observation: {
      heartbeatAgeMilliseconds: 0,
      liveness: state === 'completed' ? ('completed' as const) : ('active' as const),
    },
    owner: {processId: 42},
    phase: state === 'queued' ? 'waiting' : 'scanning',
    state,
    timestamps: {heartbeatAt: timestamp, lastProgressAt: timestamp, startedAt: timestamp},
  };
}

function edge(id: string, sourceId: string, targetId: string, relation: string): GraphEdge {
  return {
    confidence: 1,
    count: 1,
    id,
    provenance: 'resolved',
    relation,
    sourceId,
    targetId,
  };
}

function graphNode(id: string, label: string) {
  return {
    degree: 1,
    id,
    kind: 'function',
    label,
    path: `src/${label}.ts`,
    projectId: 'package:threadnote',
    type: 'symbol' as const,
  };
}

function nodeDetail(id: string, label: string, relationships: ReturnType<typeof relationship>[]) {
  return {
    node: {
      exported: true,
      id,
      kind: 'function',
      label,
      language: 'typescript',
      path: `src/${label}.ts`,
      projectId: 'package:threadnote',
      qualifiedName: label,
      span: {column: 1, endColumn: 10, endLine: 1, line: 1},
    },
    relationships,
    snapshotId: 'snapshot',
    stats: {
      incoming: relationships.filter(item => item.direction === 'incoming').length,
      outgoing: relationships.filter(item => item.direction === 'outgoing').length,
      provenances: [{count: relationships.length, provenance: 'resolved'}],
      relations: [
        {
          count: relationships.length,
          incoming: relationships.filter(item => item.direction === 'incoming').length,
          outgoing: relationships.filter(item => item.direction === 'outgoing').length,
          relation: 'calls',
        },
      ],
      truncated: false,
    },
  };
}

function relationship(id: string, direction: 'incoming' | 'outgoing', relatedId: string, label: string) {
  return {
    confidence: 1,
    direction,
    evidencePath: `src/${label}.ts`,
    evidenceSpan: {column: 1, endColumn: 10, endLine: 1, line: 1},
    id,
    provenance: 'resolved',
    related: {
      id: relatedId,
      kind: 'function',
      label,
      path: `src/${label}.ts`,
      projectId: 'package:threadnote',
      qualifiedName: label,
    },
    relation: 'calls',
  } as const;
}
