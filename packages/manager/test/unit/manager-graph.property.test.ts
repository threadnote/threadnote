import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  graphAdministrationJobSelection,
  graphBuildConcurrencyState,
  graphFocusTarget,
  graphFocusLayoutTargets,
  graphWheelZoomFactor,
  graphWithNodeNeighborhood,
  orderGraphBuildStatuses,
  type GraphBuildStatus,
  type GraphNodeDetail,
  type GraphVisualization,
} from '@threadnote/manager/graph';
import {
  managerGraphDetailWorkingSet,
  representativeManagerGraphEdges,
  type ManagerGraphEdge,
} from '@threadnote/graph/visualization';
import {managerGraphCatalogRevision} from '@threadnote/graph/manager/catalog_revision';
import type {CodeGraphEdge, CodeGraphSymbol} from '@threadnote/graph/types';
import {
  MANAGER_GRAPH_MAX_EDGE_LIMIT,
  MANAGER_GRAPH_MAX_NODE_LIMIT,
  managerGraphVisualizationLimits,
} from '@threadnote/graph/visualization/limits';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('Manager graph properties', () => {
  it('keeps focused layouts deterministic, finite, and independent of edge order without mutating input', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            label: fc.string({maxLength: 24}),
            radius: fc.integer({min: 1, max: 15}),
            x: fc.integer({min: -100, max: 100}),
            y: fc.integer({min: -100, max: 100}),
          }),
          {minLength: 2, maxLength: 30},
        ),
        values => {
          const nodes = EffectArray.map(values, (node, index) => ({...node, id: 'node-' + index}));
          const edges = EffectArray.map(nodes.slice(1), node => ({sourceId: nodes[0].id, targetId: node.id}));
          const sizes = new Map(EffectArray.map(nodes, node => [node.id, {height: 15, width: 120}]));
          const original = JSON.stringify(nodes);
          const result = graphFocusLayoutTargets(nodes, nodes[0].id, edges, sizes, 2.8);
          expect(result).toEqual(graphFocusLayoutTargets(nodes, nodes[0].id, [...edges].reverse(), sizes, 2.8));
          expect(result.size).toBe(nodes.length);
          expect(result.get(nodes[0].id)).toEqual({x: nodes[0].x, y: nodes[0].y});
          expect(
            EffectArray.every(
              [...result.values()],
              position => Number.isFinite(position.x) && Number.isFinite(position.y),
            ),
          ).toBe(true);
          expect(JSON.stringify(nodes)).toBe(original);
        },
      ),
      {numRuns: 60},
    );
  });

  it('keeps catalog revisions order-independent and sensitive to lifecycle changes', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            checkoutId: fc.uuid(),
            state: fc.constantFrom('ready' as const, 'unavailable' as const),
            views: fc.uniqueArray(
              fc.record({
                activatedAt: fc.integer({min: 0, max: 2_000_000_000}).map(String),
                repositoryId: fc.uuid(),
                scopeId: fc.option(
                  fc.uuid().map(value => `code-graph-scope:${value}`),
                  {nil: undefined},
                ),
                snapshotId: fc.uuid(),
                worktreeId: fc.uuid(),
              }),
              {maxLength: 12, selector: view => `${view.worktreeId}\0${view.scopeId ?? ''}`},
            ),
            viewsTruncated: fc.boolean(),
          }),
          {maxLength: 12, selector: database => database.checkoutId},
        ),
        databases => {
          const reordered = EffectArray.map([...databases].reverse(), database => ({
            ...database,
            views: [...database.views].reverse(),
          }));
          expect(managerGraphCatalogRevision(reordered)).toBe(managerGraphCatalogRevision(databases));

          const changed =
            databases.length === 0
              ? [{checkoutId: 'new', state: 'ready' as const, views: [], viewsTruncated: false}]
              : EffectArray.map(databases, (database, index) =>
                  index === 0 ? {...database, viewsTruncated: !database.viewsTruncated} : database,
                );
          expect(managerGraphCatalogRevision(changed)).not.toBe(managerGraphCatalogRevision(databases));

          const targetDatabaseIndex = EffectOption.getOrElse(
            EffectArray.findFirstIndex(databases, database => database.views.length > 0),
            () => -1,
          );
          if (targetDatabaseIndex >= 0) {
            const scopeChanged = EffectArray.map(databases, (database, databaseIndex) => ({
              ...database,
              views: EffectArray.map(database.views, (candidate, viewIndex) =>
                databaseIndex === targetDatabaseIndex && viewIndex === 0
                  ? {
                      ...candidate,
                      scopeId:
                        candidate.scopeId === 'code-graph-scope:scope-change'
                          ? 'code-graph-scope:scope-change-2'
                          : 'code-graph-scope:scope-change',
                    }
                  : candidate,
              ),
            }));
            expect(managerGraphCatalogRevision(scopeChanged)).not.toBe(managerGraphCatalogRevision(databases));
          }
        },
      ),
      {numRuns: 120},
    );
  });

  it('keeps actionable administration jobs deterministic, unique, and bounded', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            buildNumber: fc.integer({min: 0, max: 1_000_000}),
            startedAt: fc.integer({min: 0, max: 2_000_000_000}),
            state: fc.constantFrom('completed' as const, 'failed' as const, 'queued' as const, 'running' as const),
          }),
          {maxLength: 80, selector: item => item.buildNumber},
        ),
        records => {
          const statuses = EffectArray.map(records, record =>
            graphBuildStatus(
              `build-${record.buildNumber}`,
              Effect.pipe(record.buildNumber.toString(16), EffectString.padStart(12, '0')),
              record.startedAt,
              record.state,
            ),
          );
          const builds = EffectArray.filter(statuses, (_, index) => index % 2 === 0);
          const waiters = EffectArray.filter(statuses, (_, index) => index % 2 === 1);
          const forward = graphAdministrationJobSelection(builds, waiters);
          const reverse = graphAdministrationJobSelection([...builds].reverse(), [...waiters].reverse());
          const expectedTotal = EffectArray.filter(builds, status => status.state !== 'completed').length;

          expect(forward).toEqual(reverse);
          expect(forward.jobs.length).toBeLessThanOrEqual(4);
          expect(forward.jobs.length + forward.hiddenCount).toBe(forward.total);
          expect(forward.total).toBe(expectedTotal);
          expect(new Set(EffectArray.map(forward.jobs, job => job.buildId)).size).toBe(forward.jobs.length);
          expect(
            EffectArray.every(forward.jobs, job => EffectArray.some(builds, build => build.buildId === job.buildId)),
          ).toBe(true);
          expect(EffectArray.every(forward.jobs, job => job.state !== 'completed')).toBe(true);
        },
      ),
      {numRuns: 120},
    );
  });

  it('keeps build banner order invariant across polling order and progress updates', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            buildNumber: fc.integer({min: 0, max: 1_000_000}),
            locationNumber: fc.integer({min: 0, max: 100}),
            progressAt: fc.integer({min: 0, max: 2_000_000_000}),
          }),
          {maxLength: 80, selector: item => item.buildNumber},
        ),
        records => {
          const statuses = EffectArray.map(records, record => ({
            ...graphBuildStatus(
              `build-${record.buildNumber}`,
              Effect.pipe(record.buildNumber.toString(16), EffectString.padStart(12, '0')),
              record.progressAt,
              'running',
            ),
            identity: {
              checkoutId: `checkout-${Effect.pipe(record.buildNumber.toString(), EffectString.padStart(7, '0'))}`,
              commit: Effect.pipe(record.buildNumber.toString(16), EffectString.padStart(12, '0')),
              repositoryId: 'repository',
              worktreeId: `worktree-${Effect.pipe(record.buildNumber.toString(), EffectString.padStart(7, '0'))}`,
            },
            managerContext: {
              worktreePath: `/worktrees/${Effect.pipe(record.locationNumber.toString(), EffectString.padStart(3, '0'))}`,
            },
          }));
          const expected = EffectArray.map(orderGraphBuildStatuses(statuses), status => status.buildId);
          const polled = EffectArray.map([...statuses].reverse(), (status, index) => ({
            ...status,
            timestamps: {
              ...status.timestamps,
              lastProgressAt: new Date(2_000_000_000 - index).toISOString(),
            },
          }));

          expect(EffectArray.map(orderGraphBuildStatuses(polled), status => status.buildId)).toEqual(expected);
          expect(EffectArray.map(statuses, status => status.buildId)).toEqual(
            EffectArray.map(records, record => `build-${record.buildNumber}`),
          );
        },
      ),
      {numRuns: 120},
    );
  });

  it('selects the latest observed queued target independently of waiter order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({min: 1, max: 1_000_000}), {minLength: 1, maxLength: 80}),
        startedAtValues => {
          const owner = graphBuildStatus('owner', '000000000000', 0, 'running');
          const waiters = EffectArray.map(startedAtValues, startedAt =>
            graphBuildStatus(
              `waiter-${Effect.pipe(startedAt.toString(), EffectString.padStart(7, '0'))}`,
              Effect.pipe(startedAt.toString(16), EffectString.padStart(12, '0')),
              startedAt,
              'queued',
            ),
          );
          const unrelated = {
            ...graphBuildStatus('unrelated', 'ffffffffffff', 2_000_000, 'queued'),
            identity: {
              ...owner.identity,
              checkoutId: 'other-checkout',
              worktreeId: 'other-worktree',
            },
          };
          const expected = Effect.pipe(Math.max(...startedAtValues).toString(16), EffectString.padStart(12, '0'));
          const forward = graphBuildConcurrencyState(owner, [...waiters, unrelated], []);
          const reverse = graphBuildConcurrencyState(owner, [unrelated, ...waiters].reverse(), []);

          expect(forward).toEqual(reverse);
          expect(forward).toEqual({
            activeTargetCommit: '000000000000',
            latestTargetCommit: expected,
            queuedRequests: waiters.length,
            staleReady: false,
          });
        },
      ),
      {numRuns: 160},
    );
  });

  it('always normalizes arbitrary requested budgets into positive hard bounds', () => {
    fc.assert(
      fc.property(
        fc.option(fc.double({noDefaultInfinity: false, noNaN: false}), {nil: undefined}),
        fc.option(fc.double({noDefaultInfinity: false, noNaN: false}), {nil: undefined}),
        (edgeLimit, nodeLimit) => {
          const limits = managerGraphVisualizationLimits({
            ...(edgeLimit === undefined ? {} : {edgeLimit}),
            ...(nodeLimit === undefined ? {} : {nodeLimit}),
          });
          expect(Number.isSafeInteger(limits.edgeLimit)).toBe(true);
          expect(Number.isSafeInteger(limits.nodeLimit)).toBe(true);
          expect(limits.edgeLimit).toBeGreaterThanOrEqual(1);
          expect(limits.edgeLimit).toBeLessThanOrEqual(MANAGER_GRAPH_MAX_EDGE_LIMIT);
          expect(limits.nodeLimit).toBeGreaterThanOrEqual(1);
          expect(limits.nodeLimit).toBeLessThanOrEqual(MANAGER_GRAPH_MAX_NODE_LIMIT);
        },
      ),
      {numRuns: 200},
    );
  });

  it('keeps arbitrary focus and wheel inputs finite and within reviewed zoom bounds', () => {
    fc.assert(
      fc.property(
        fc.double({noDefaultInfinity: false, noNaN: false}),
        fc.double({noDefaultInfinity: false, noNaN: false}),
        fc.double({noDefaultInfinity: false, noNaN: false}),
        fc.double({noDefaultInfinity: false, noNaN: false}),
        fc.double({noDefaultInfinity: false, noNaN: false}),
        fc.constantFrom('detail' as const, 'overview' as const),
        (x, y, zoom, nodeX, nodeY, mode) => {
          const target = graphFocusTarget({x, y, zoom}, {x: nodeX, y: nodeY}, mode);
          const minimum = mode === 'detail' ? 2.8 : 1.8;
          expect(Number.isFinite(target.x)).toBe(true);
          expect(Number.isFinite(target.y)).toBe(true);
          expect(Number.isFinite(target.zoom)).toBe(true);
          expect(target.zoom).toBeGreaterThanOrEqual(minimum);
          expect(target.zoom).toBeLessThanOrEqual(minimum * 1.35);

          const factor = graphWheelZoomFactor(zoom);
          expect(Number.isFinite(factor)).toBe(true);
          expect(factor).toBeGreaterThanOrEqual(0.72);
          expect(factor).toBeLessThanOrEqual(1.38);
        },
      ),
      {numRuns: 200},
    );
  });

  it('never duplicates lazy expansion IDs and keeps every edge endpoint present', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            direction: fc.constantFrom('incoming' as const, 'outgoing' as const),
            edgeNumber: fc.integer({min: 0, max: 10_000}),
            relatedNumber: fc.integer({min: 0, max: 100}),
          }),
          {maxLength: 220, selector: item => item.edgeNumber},
        ),
        relationships => {
          const detail = graphNodeDetail(
            EffectArray.map(relationships, item => ({
              confidence: 1,
              direction: item.direction,
              evidencePath: 'src/selected.ts',
              evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
              id: `relationship-${item.edgeNumber}`,
              provenance: 'resolved',
              related: {
                id: `related-${item.relatedNumber}`,
                kind: 'function',
                label: `related-${item.relatedNumber}`,
                path: `src/related-${item.relatedNumber}.ts`,
                projectId: 'cgp_project',
                qualifiedName: `related${item.relatedNumber}`,
              },
              relation: 'calls',
            })),
          );
          const expanded = graphWithNodeNeighborhood(baseGraph(), detail);
          const nodeIds = EffectArray.map(expanded.nodes, node => node.id);
          const edgeIds = EffectArray.map(expanded.edges, edge => edge.id);
          const nodeSet = new Set(nodeIds);
          expect(nodeSet.size).toBe(nodeIds.length);
          expect(new Set(edgeIds).size).toBe(edgeIds.length);
          expect(
            EffectArray.every(expanded.edges, edge => nodeSet.has(edge.sourceId) && nodeSet.has(edge.targetId)),
          ).toBe(true);
          expect(expanded.stats.renderedNodes).toBe(expanded.nodes.length);
          expect(expanded.stats.renderedEdges).toBe(expanded.edges.length);
          expect(expanded.nodes.length).toBeLessThanOrEqual(MANAGER_GRAPH_MAX_NODE_LIMIT);
          expect(expanded.edges.length).toBeLessThanOrEqual(MANAGER_GRAPH_MAX_EDGE_LIMIT);
        },
      ),
      {numRuns: 100},
    );
  });

  it('marks node-budget truncation and preserves the selected unscoped facet on every seed', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 80}), fc.integer({min: 1, max: 24}), (neighborCount, nodeLimit) => {
        const seed = codeGraphSymbol('seed', undefined);
        const neighbors = Array.from({length: neighborCount}, (_, index) =>
          codeGraphSymbol(`neighbor-${index}`, 'cgp_external'),
        );
        const edges = EffectArray.map(neighbors, (neighbor, index) =>
          codeGraphEdge(`edge-${index}`, seed.id, neighbor.id),
        );
        const loadedNeighbors = neighbors.slice(0, Math.max(0, nodeLimit - 1));
        const result = managerGraphDetailWorkingSet([seed], loadedNeighbors, edges, 'facet:unscoped', {
          edgeLimit: 100,
          nodeLimit,
        });
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(result.nodes, node => node.id === seed.id))?.projectId,
        ).toBe('facet:unscoped');
        expect(
          EffectArray.every(
            EffectArray.filter(result.nodes, node => node.id !== seed.id),
            node => node.projectId === 'cgp_external',
          ),
        ).toBe(true);
        expect(result.truncated).toBe(neighborCount > loadedNeighbors.length);
        const visible = new Set(EffectArray.map(result.nodes, node => node.id));
        expect(EffectArray.every(result.edges, edge => visible.has(edge.sourceId) && visible.has(edge.targetId))).toBe(
          true,
        );
      }),
      {numRuns: 120},
    );
  });

  it('gives every connected retained overview node incident evidence when the budget permits', () => {
    fc.assert(
      fc.property(fc.integer({min: 2, max: 120}), nodeCount => {
        const nodeIds = Array.from({length: nodeCount}, (_, index) => `component-${index}`);
        const candidates: ManagerGraphEdge[] = EffectArray.map(nodeIds.slice(1), (nodeId, index) => ({
          confidence: 1,
          count: index + 1,
          id: `edge-${index}`,
          provenance: 'resolved',
          relation: 'imports',
          sourceId: nodeIds[index],
          targetId: nodeId,
        }));
        const selected = representativeManagerGraphEdges(candidates, nodeIds, nodeIds.length);
        expect(selected.length).toBeLessThanOrEqual(nodeIds.length);
        expect(
          EffectArray.every(nodeIds, nodeId =>
            EffectArray.some(selected, edge => edge.sourceId === nodeId || edge.targetId === nodeId),
          ),
        ).toBe(true);
      }),
      {numRuns: 100},
    );
  });
});

function graphBuildStatus(
  buildId: string,
  commit: string,
  startedAtMilliseconds: number,
  state: 'completed' | 'failed' | 'queued' | 'running',
): GraphBuildStatus {
  const startedAt = new Date(startedAtMilliseconds).toISOString();
  return {
    buildId,
    counters: {},
    identity: {
      checkoutId: 'checkout',
      commit,
      repositoryId: 'repository',
      worktreeId: 'worktree',
    },
    observation: {
      heartbeatAgeMilliseconds: 0,
      liveness: state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'active',
    },
    owner: {processId: 42},
    phase: state === 'queued' ? 'waiting' : 'scanning',
    state,
    timestamps: {heartbeatAt: startedAt, lastProgressAt: startedAt, startedAt},
  };
}

function codeGraphSymbol(id: string, resolutionScopeId: string | undefined): CodeGraphSymbol {
  return {
    contentHash: id,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [],
    name: id,
    path: `src/${id}.ts`,
    qualifiedName: id,
    resolutionDomain: 'typescript',
    ...(resolutionScopeId ? {resolutionScopeId} : {}),
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function codeGraphEdge(id: string, sourceId: string, targetId: string): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: 'src/seed.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id,
    provenance: 'resolved',
    relation: 'calls',
    sourceId,
    sourceName: sourceId,
    targetId,
    targetName: targetId,
  };
}

function baseGraph(): GraphVisualization {
  return {
    edges: [],
    mode: 'detail',
    nodes: [
      {
        degree: 0,
        id: 'selected',
        kind: 'function',
        label: 'selected',
        path: 'src/selected.ts',
        projectId: 'cgp_project',
        type: 'symbol',
      },
    ],
    paging: {edgeLimit: 640, hasMore: false, nodeLimit: 240},
    projectId: 'cgp_project',
    repository: {
      accounting: {
        attributedSymbols: 1,
        componentSymbols: 1,
        fallbackSymbols: 0,
        omittedSymbols: 0,
        totalSymbols: 1,
      },
      displayName: 'fixture',
      id: 'checkout.worktree',
      metrics: 'complete',
      snapshot: {
        commit: 'abcdef01',
        dirty: false,
        edgeCount: 0,
        fileCount: 1,
        id: 'snapshot',
        symbolCount: 1,
      },
    },
    scope: {id: 'cgp_project', label: 'project'},
    stats: {renderedEdges: 0, renderedNodes: 1, totalEdges: 0, totalNodes: 1},
    warnings: [],
  };
}

function graphNodeDetail(relationships: GraphNodeDetail['relationships']): GraphNodeDetail {
  return {
    node: {
      exported: true,
      id: 'selected',
      kind: 'function',
      label: 'selected',
      language: 'typescript',
      path: 'src/selected.ts',
      projectId: 'cgp_project',
      qualifiedName: 'selected',
      span: {column: 1, endColumn: 2, endLine: 1, line: 1},
    },
    relationships,
    snapshotId: 'snapshot',
    stats: {incoming: 0, outgoing: 0, provenances: [], relations: [], truncated: false},
  };
}
