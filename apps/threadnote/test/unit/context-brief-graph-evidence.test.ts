import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CodeGraphQueryService, type CodeGraphInspectOptions} from '@threadnote/graph/query';
import type {CodeGraphEdge, CodeGraphQueryNode, CodeGraphQueryResult, CodeGraphStatus} from '@threadnote/graph/types';
import {CodeGraphStorePermissionError, CodeGraphStoreTransientIoError} from '@threadnote/graph/types';
import {
  assembleContextBriefLogicalResult,
  contextBriefAnchoredRepositoryGraphResultMatches,
  contextBriefAnchoredRepositoryGraphRequests,
  fromRepositoryQuery,
  mergeContextBriefAnchoredRepositoryGraphResults,
  planContextBrief,
  parseContextBriefJsonText,
  projectContextBrief,
  retrieveContextBriefGraphEvidence,
} from '@threadnote/threadnote/context_brief/index';
import type {RuntimeConfig} from '@threadnote/workspace/config';

import {provideTestLayer} from '../helpers/effect-layer.js';

const REPOSITORY_ID = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const SNAPSHOT_ID = `cgsn_${'c'.repeat(40)}`;
const PATH_ANCHOR = 'packages/platform/node/src/NodeHttpClient.ts';
const SYMBOL_ANCHOR = `cgs_${'d'.repeat(32)}`;
const MIGRATION_PATH = 'migration/annotations/effect__platform-node__NodeHttpClient.yaml';
const EFFECT_SOURCE_ANCHORS = [
  PATH_ANCHOR,
  'packages/platform/node/src/Undici.ts',
  'packages/platform/node/src/NodeClusterSocket.ts',
  'packages/platform/node/src/index.ts',
  'packages/platform/node/test/NodeHttpClient.test.ts',
] as const;

describe('Context Brief exact-anchor graph evidence', () => {
  it('preserves project coverage and partial-scope safety in the public agent view', () => {
    const projectCoverage = {
      project: 'app-a',
      kind: 'project' as const,
      configuredRoots: ['apps/a'],
      rootComponents: 1,
      dependencyComponents: 2,
      completeness: 'partial' as const,
      negativeProof: 'unavailable' as const,
      observedWorktreeCommit: COMMIT,
      reusedEquivalentSnapshot: false,
    };
    const graph = fromRepositoryQuery({...queryResult({edges: [], nodes: [], operation: 'query'}), projectCoverage});
    expect(graph.coverage.complete).toBe(false);
    expect(graph.gaps).toContain('graph-project-scope-partial');
    expect(graph.projectCoverage).toEqual(projectCoverage);
    const plan = planContextBrief({
      task: 'Find the selected app',
      scope: {kind: 'repository', callerCwd: '/workspace/fixture', project: 'app-a'},
    });
    const projected = projectContextBrief(
      assembleContextBriefLogicalResult({
        graph,
        plan,
        memory: emptyMemoryEvidence(),
        observedAt: '2026-09-20T00:00:00.000Z',
      }),
      1_500,
    );
    expect(projected.structuredContent.scope.projectCoverage).toEqual(projectCoverage);
    expect(parseContextBriefJsonText(projected.text).scope.projectCoverage).toEqual(projectCoverage);
  });
  effectIt.effect('borrows compatible shared graph evidence before reporting a fresh-worktree gap', () =>
    Effect.gen(function* () {
      const attachOptions: unknown[] = [];
      const missing = {...STATUS, freshness: 'stale' as const, readySnapshot: undefined, stale: true};
      const borrowed = {...STATUS, freshness: 'stale' as const, stale: true};
      const plan = planContextBrief({
        scope: {callerCwd: '/workspace/effect', kind: 'repository', project: 'effect'},
        task: 'Locate the HTTP client from a fresh worktree.',
      });
      const query = CodeGraphQueryService.of({
        attachSharedReadySnapshot: (_home, _identity, _status, options) => {
          attachOptions.push(options);
          return Effect.succeed(borrowed);
        },
        inspect: () =>
          Effect.succeed(
            queryResult({
              edges: [],
              nodes: [sourceNode(stableId(1), PATH_ANCHOR, PATH_ANCHOR, 'module')],
              operation: 'query',
            }),
          ),
        purge: () => Effect.die('Unexpected graph purge.'),
        status: () => Effect.succeed(missing),
        statusForIdentity: () => Effect.die('Unexpected identity status.'),
        statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
      });

      const evidence = yield* retrieveContextBriefGraphEvidence(CONFIG, plan.graph).pipe(
        Effect.provideService(CodeGraphQueryService, query),
        provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
      );

      expect(attachOptions).toEqual([{allowBorrowedStale: true, requestMaintenance: false}]);
      expect(evidence.cards[0]?.symbol.path).toBe(PATH_ANCHOR);
      expect(evidence.gaps).not.toContain('graph-ready-snapshot-missing');
    }),
  );
  effectIt.effect('traces mixed path and cgs anchors in both directions without task-semantic displacement', () =>
    Effect.gen(function* () {
      const calls: CodeGraphInspectOptions[] = [];
      const plan = planContextBrief({
        budgetTokens: 1_500,
        codeRefs: [PATH_ANCHOR, SYMBOL_ANCHOR],
        mode: 'trace',
        scope: {callerCwd: '/workspace/effect', kind: 'repository', project: 'effect'},
        task: 'Find NodeHttpClient Undici migration annotations and options.',
      });
      const pathModuleId = `cgs_${'f'.repeat(32)}`;
      const query = queryService(calls, options => {
        if (options.operation === 'impact') {
          return queryResult({
            edges: [],
            nodes: [
              sourceNode(`cgs_${'e'.repeat(32)}`, 'UndiciRequestOptions', MIGRATION_PATH, 'property', 'yaml'),
              sourceNode(pathModuleId, PATH_ANCHOR, PATH_ANCHOR, 'module'),
            ],
            operation: 'impact',
          });
        }
        return options.nodeId === SYMBOL_ANCHOR
          ? queryResult({
              edges: [],
              nodes: [sourceNode(SYMBOL_ANCHOR, 'makeUndici', 'packages/platform/node/src/Undici.ts', 'function')],
              operation: 'neighbors',
            })
          : queryResult({
              edges: [
                graphEdge('metadata-contains', 'contains', MIGRATION_PATH),
                graphEdge('source-import', 'imports', 'packages/platform/node/src/NodeClusterSocket.ts'),
              ],
              nodes: [
                sourceNode(`cgs_${'e'.repeat(32)}`, 'UndiciRequestOptions', MIGRATION_PATH, 'property', 'yaml'),
                sourceNode(pathModuleId, PATH_ANCHOR, PATH_ANCHOR, 'module'),
              ],
              operation: 'neighbors',
            });
      });

      const evidence = yield* retrieveContextBriefGraphEvidence(CONFIG, plan.graph).pipe(
        Effect.provideService(CodeGraphQueryService, query),
        provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
      );

      expect(calls).toHaveLength(3);
      expect(calls.every(call => call.project === 'effect' && call.manifestPath === CONFIG.manifestPath)).toBe(true);
      expect(calls.find(call => call.operation === 'impact')).toMatchObject({
        depth: 0,
        direction: 'incoming',
        operation: 'impact',
        query: PATH_ANCHOR,
        refresh: false,
        requestMaintenance: false,
        seedQueries: [PATH_ANCHOR],
        seedQueryCount: 1,
      });
      expect(calls.find(call => call.nodeId === pathModuleId)).toMatchObject({
        depth: 1,
        direction: 'both',
        operation: 'neighbors',
      });
      expect(calls.find(call => call.nodeId === SYMBOL_ANCHOR)).toMatchObject({
        depth: 1,
        direction: 'both',
        nodeId: SYMBOL_ANCHOR,
        operation: 'neighbors',
      });
      expect(calls.map(call => call.query)).not.toContain(plan.task);
      expect([PATH_ANCHOR, 'packages/platform/node/src/Undici.ts']).toContain(evidence.cards[0]?.symbol.path);
      expect(evidence.cards[0]?.symbol.kind).not.toBe('property');
      expect(evidence.contracts[0]).toMatchObject({relation: 'imports'});
      expect(evidence.cards[0]?.symbol.path).not.toBe(MIGRATION_PATH);
    }),
  );

  effectIt.effect('uses exact incoming one-hop traversal for every mixed impact anchor', () =>
    Effect.gen(function* () {
      const calls: CodeGraphInspectOptions[] = [];
      const plan = planContextBrief({
        budgetTokens: 1_500,
        codeRefs: [PATH_ANCHOR, SYMBOL_ANCHOR],
        mode: 'impact',
        scope: {callerCwd: '/workspace/effect', kind: 'repository', project: 'effect'},
        task: 'Assess downstream HTTP client impact.',
      });
      const query = queryService(calls, options =>
        queryResult({
          edges: [graphEdge(`import-${String(options.query)}`, 'imports', 'packages/platform/node/src/index.ts')],
          nodes: [
            sourceNode(
              options.query === PATH_ANCHOR ? `cgs_${'1'.repeat(32)}` : `cgs_${'2'.repeat(32)}`,
              'packages/platform/node/src/index.ts',
              'packages/platform/node/src/index.ts',
              'module',
            ),
            sourceNode(
              options.query === PATH_ANCHOR ? `cgs_${'3'.repeat(32)}` : SYMBOL_ANCHOR,
              String(options.query),
              options.query === PATH_ANCHOR ? PATH_ANCHOR : 'packages/platform/node/src/Undici.ts',
              options.query === PATH_ANCHOR ? 'module' : 'function',
            ),
          ],
          operation: 'impact',
        }),
      );

      const evidence = yield* retrieveContextBriefGraphEvidence(CONFIG, plan.graph).pipe(
        Effect.provideService(CodeGraphQueryService, query),
        provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
      );

      expect(calls).toHaveLength(2);
      expect(calls.map(call => call.query)).toEqual([PATH_ANCHOR, SYMBOL_ANCHOR]);
      expect(calls[0]).toMatchObject({
        depth: 1,
        direction: 'incoming',
        operation: 'impact',
        seedQueries: [PATH_ANCHOR],
        seedQueryCount: 1,
      });
      expect(calls[1]).toMatchObject({depth: 1, direction: 'incoming', operation: 'impact'});
      expect(calls[1]).not.toHaveProperty('seedQueries');
      expect(evidence.cards[0]?.symbol.path).toBe('packages/platform/node/src/index.ts');
      expect(evidence.contracts[0]?.relation).toBe('imports');
    }),
  );

  effectIt.effect('keeps five exact source anchors ahead of task-matched metadata in locate mode', () =>
    Effect.gen(function* () {
      const calls: CodeGraphInspectOptions[] = [];
      const plan = planContextBrief({
        budgetTokens: 1_500,
        codeRefs: EFFECT_SOURCE_ANCHORS,
        mode: 'locate',
        scope: {callerCwd: '/workspace/effect', kind: 'repository'},
        task: 'Find NodeHttpClient Undici migration annotations and options.',
      });
      const query = queryService(calls, options => {
        const anchorPath = String(options.query);
        const index = EFFECT_SOURCE_ANCHORS.indexOf(anchorPath as (typeof EFFECT_SOURCE_ANCHORS)[number]);
        return queryResult({
          edges: [graphEdge(`metadata-${index}`, 'contains', MIGRATION_PATH)],
          nodes: [
            sourceNode(stableId(index * 2 + 2), `MigrationProperty${index}`, MIGRATION_PATH, 'property', 'yaml'),
            sourceNode(stableId(index * 2 + 1), anchorPath, anchorPath, 'module'),
          ],
          operation: 'impact',
        });
      });

      const evidence = yield* retrieveContextBriefGraphEvidence(CONFIG, plan.graph).pipe(
        Effect.provideService(CodeGraphQueryService, query),
        provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
      );
      const logical = assembleContextBriefLogicalResult({
        graph: evidence,
        memory: emptyMemoryEvidence(),
        observedAt: '2026-08-31T00:00:00.000Z',
        plan,
      });
      const projected = projectContextBrief(logical, 1_500);
      const recovery = projected.structuredContent.recommendedFollowUps[0];

      expect(calls).toHaveLength(EFFECT_SOURCE_ANCHORS.length);
      expect(calls.every(call => call.operation === 'impact' && call.depth === 0)).toBe(true);
      expect(calls.map(call => call.query)).toEqual(EFFECT_SOURCE_ANCHORS);
      expect(calls.map(call => call.query)).not.toContain(plan.task);
      expect(evidence.cards.map(card => card.symbol.path)).toEqual(EFFECT_SOURCE_ANCHORS);
      expect(evidence.cards.every(card => card.symbol.kind === 'module')).toBe(true);
      expect(evidence.contracts).toEqual([]);
      expect(recovery).toMatchObject({operation: 'inspect-node', ref: stableId(1)});
      expect(parseContextBriefJsonText(projected.text).recommendedFollowUps?.[0]).toEqual(recovery);
      expect(projected.measurement.totalBytes).toBeLessThanOrEqual(1_500 * 3);
    }),
  );

  effectIt.effect('rejects an unrelated result when an exact path trace cannot resolve its seed', () =>
    Effect.gen(function* () {
      const missing = 'packages/platform/node/src/MissingHttpClient.ts';
      const calls: CodeGraphInspectOptions[] = [];
      const plan = planContextBrief({
        budgetTokens: 1_500,
        codeRefs: [missing],
        mode: 'trace',
        scope: {callerCwd: '/workspace/effect', kind: 'repository'},
        task: 'Trace an absent source path.',
      });
      const query = queryService(calls, () =>
        queryResult({
          edges: [graphEdge('unrelated-metadata', 'contains', MIGRATION_PATH)],
          nodes: [sourceNode(`cgs_${'8'.repeat(32)}`, 'UnrelatedMigration', MIGRATION_PATH, 'property', 'yaml')],
          operation: 'impact',
        }),
      );

      const evidence = yield* retrieveContextBriefGraphEvidence(CONFIG, plan.graph).pipe(
        Effect.provideService(CodeGraphQueryService, query),
        provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({seedQueries: [missing], seedQueryCount: 1});
      expect(evidence.cards).toEqual([]);
      expect(evidence.contracts).toEqual([]);
      expect(evidence.gaps).toEqual(['graph-query-unavailable']);
    }),
  );

  effectIt.effect('recovers an exact anchored read after bounded transient failures', () =>
    Effect.gen(function* () {
      let calls = 0;
      const plan = planContextBrief({
        budgetTokens: 1_500,
        codeRefs: [SYMBOL_ANCHOR],
        mode: 'impact',
        scope: {callerCwd: '/workspace/effect', kind: 'repository'},
        task: 'Assess one exact source anchor.',
      });
      const query = queryServiceEffect(() =>
        Effect.suspend(() => {
          calls += 1;
          return calls <= 2
            ? Effect.fail(CodeGraphStoreTransientIoError.of('transient graph read'))
            : Effect.succeed(
                queryResult({
                  edges: [],
                  nodes: [sourceNode(SYMBOL_ANCHOR, 'makeUndici', 'packages/platform/node/src/Undici.ts', 'function')],
                  operation: 'impact',
                }),
              );
        }),
      );

      const evidence = yield* retrieveContextBriefGraphEvidence(CONFIG, plan.graph).pipe(
        Effect.provideService(CodeGraphQueryService, query),
        provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
      );

      expect(calls).toBe(3);
      expect(evidence.cards[0]?.ref).toBe(SYMBOL_ANCHOR);
      expect(evidence.gaps).toEqual([]);
    }).pipe(TestClock.withLive),
  );

  effectIt.effect('preserves ready snapshot coverage when bounded anchored reads keep failing', () =>
    Effect.gen(function* () {
      let calls = 0;
      const plan = planContextBrief({
        budgetTokens: 1_500,
        codeRefs: [SYMBOL_ANCHOR],
        mode: 'impact',
        scope: {callerCwd: '/workspace/effect', kind: 'repository'},
        task: 'Assess one exact source anchor.',
      });
      const query = queryServiceEffect(() =>
        Effect.suspend(() => {
          calls += 1;
          return Effect.fail(CodeGraphStoreTransientIoError.of('persistent graph read'));
        }),
      );

      const evidence = yield* retrieveContextBriefGraphEvidence(CONFIG, plan.graph).pipe(
        Effect.provideService(CodeGraphQueryService, query),
        provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
      );

      expect(calls).toBe(3);
      expect(evidence.coverage).toMatchObject({
        complete: false,
        consideredRepositories: 1,
        readyRepositories: 1,
        requestedRepositories: 1,
        states: {current: 1},
      });
      expect(evidence.resolvedSnapshots).toEqual([
        expect.objectContaining({repositoryId: REPOSITORY_ID, snapshotId: SNAPSHOT_ID}),
      ]);
      expect(evidence.gaps).toEqual(['graph-query-unavailable', 'graph-repository-read-failed']);
      expect(evidence.warnings).toEqual([
        'One or more exact anchored graph reads failed after bounded retry; results are partial.',
      ]);
    }).pipe(TestClock.withLive),
  );

  effectIt.effect('shares two retry attempts across eight anchored graph reads', () =>
    Effect.gen(function* () {
      let calls = 0;
      const plan = planContextBrief({
        budgetTokens: 1_500,
        codeRefs: Array.from({length: 8}, (_, index) => stableId(index + 1)),
        mode: 'impact',
        scope: {callerCwd: '/workspace/effect', kind: 'repository'},
        task: 'Assess eight exact anchors.',
      });
      const query = queryServiceEffect(() =>
        Effect.sync(() => {
          calls += 1;
        }).pipe(Effect.andThen(Effect.fail(CodeGraphStoreTransientIoError.of('transient graph read')))),
      );

      const evidence = yield* retrieveContextBriefGraphEvidence(CONFIG, plan.graph).pipe(
        Effect.provideService(CodeGraphQueryService, query),
        provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
      );

      expect(calls).toBe(10);
      expect(evidence.coverage.readyRepositories).toBe(1);
      expect(evidence.gaps).toEqual(['graph-query-unavailable', 'graph-repository-read-failed']);
    }).pipe(TestClock.withLive),
  );

  effectIt.effect('does not retry non-retryable graph failures across eight anchors', () =>
    Effect.gen(function* () {
      let calls = 0;
      const plan = planContextBrief({
        budgetTokens: 1_500,
        codeRefs: Array.from({length: 8}, (_, index) => stableId(index + 1)),
        mode: 'impact',
        scope: {callerCwd: '/workspace/effect', kind: 'repository'},
        task: 'Assess eight exact anchors.',
      });
      const query = queryServiceEffect(() =>
        Effect.sync(() => {
          calls += 1;
        }).pipe(Effect.andThen(Effect.fail(CodeGraphStorePermissionError.of('permission denied')))),
      );

      const evidence = yield* retrieveContextBriefGraphEvidence(CONFIG, plan.graph).pipe(
        Effect.provideService(CodeGraphQueryService, query),
        provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
      );

      expect(calls).toBe(8);
      expect(evidence.coverage.readyRepositories).toBe(1);
      expect(evidence.gaps).toEqual(['graph-query-unavailable', 'graph-repository-read-failed']);
    }),
  );

  effectIt.effect('retries a generic locate read and preserves the observed ready snapshot on persistent failure', () =>
    Effect.gen(function* () {
      for (const persistent of [false, true]) {
        let calls = 0;
        const plan = planContextBrief({
          budgetTokens: 1_500,
          mode: 'locate',
          scope: {callerCwd: '/workspace/effect', kind: 'repository'},
          task: 'Locate the HTTP client.',
        });
        const query = queryServiceEffect(() =>
          Effect.suspend(() => {
            calls += 1;
            return !persistent && calls === 3
              ? Effect.succeed(
                  queryResult({
                    edges: [],
                    nodes: [sourceNode(stableId(1), PATH_ANCHOR, PATH_ANCHOR, 'module')],
                    operation: 'query',
                  }),
                )
              : Effect.fail(CodeGraphStoreTransientIoError.of('generic graph read'));
          }),
        );

        const evidence = yield* retrieveContextBriefGraphEvidence(CONFIG, plan.graph).pipe(
          Effect.provideService(CodeGraphQueryService, query),
          provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
        );

        expect(calls).toBe(3);
        expect(evidence.coverage.readyRepositories).toBe(1);
        expect(evidence.resolvedSnapshots).toEqual([
          expect.objectContaining({repositoryId: REPOSITORY_ID, snapshotId: SNAPSHOT_ID}),
        ]);
        if (persistent) {
          expect(evidence.gaps).toEqual(['graph-query-unavailable', 'graph-repository-read-failed']);
        } else {
          expect(evidence.cards[0]?.symbol.path).toBe(PATH_ANCHOR);
          expect(evidence.gaps).toEqual([]);
        }
      }
    }).pipe(TestClock.withLive),
  );

  it('protects exact source modules and direct source relations from arbitrary metadata order', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({max: 1_000}), {maxLength: 40}), values => {
        const plan = planContextBrief({
          budgetTokens: 1_500,
          codeRefs: [PATH_ANCHOR],
          mode: 'trace',
          scope: {callerCwd: '/workspace/effect', kind: 'repository'},
          task: 'Trace the selected source.',
        });
        const metadataNodes = values.map((value, index) =>
          sourceNode(
            `cgs_${(index + 10).toString(16).padStart(32, '0')}`,
            `migration-${value}`,
            `${MIGRATION_PATH}#property-${index}`,
            'property',
            'yaml',
          ),
        );
        const metadataEdges = values.map((value, index) =>
          graphEdge(`metadata-${index}-${value}`, 'contains', MIGRATION_PATH),
        );
        const result = queryResult({
          edges: [...metadataEdges, graphEdge('source-reexport', 'reexports', 'packages/platform/node/src/index.ts')],
          nodes: [...metadataNodes, sourceNode(`cgs_${'9'.repeat(32)}`, PATH_ANCHOR, PATH_ANCHOR, 'module')],
          operation: 'query',
        });
        const projected = fromRepositoryQuery(mergeContextBriefAnchoredRepositoryGraphResults(plan.graph, [result]));

        expect(projected.cards[0]?.symbol).toMatchObject({kind: 'module', path: PATH_ANCHOR});
        expect(projected.contracts[0]?.relation).toBe('reexports');
      }),
      {numRuns: 50},
    );
  });

  it('uses resume code anchors as semantic-free path seeds and ranks the cited module first', () => {
    const plan = planContextBrief({
      budgetTokens: 1_500,
      codeRefs: [PATH_ANCHOR],
      mode: 'resume',
      scope: {callerCwd: '/workspace/effect', kind: 'repository'},
      task: 'Continue the implementation from the current handoff.',
    });
    expect(contextBriefAnchoredRepositoryGraphRequests(plan.graph)[0]).toMatchObject({
      operation: 'impact',
      phase: 'path-resolution',
      query: PATH_ANCHOR,
      seedQueries: [PATH_ANCHOR],
    });

    const anchorId = stableId(1);
    const evidence = fromRepositoryQuery(
      mergeContextBriefAnchoredRepositoryGraphResults(plan.graph, [
        queryResult({
          edges: [],
          nodes: [
            sourceNode(stableId(2), 'resume', 'apps/runtime/commands.ts', 'variable'),
            sourceNode(anchorId, PATH_ANCHOR, PATH_ANCHOR, 'module'),
          ],
          operation: 'query',
        }),
      ]),
    );

    expect(evidence.cards[0]).toMatchObject({ref: anchorId, symbol: {kind: 'module', path: PATH_ANCHOR}});
  });

  it.each(['trace', 'impact'] as const)(
    'keeps the five-anchor Effect source neighborhood actionable in %s mode',
    mode => {
      const plan = planContextBrief({
        budgetTokens: 1_500,
        codeRefs: EFFECT_SOURCE_ANCHORS,
        mode,
        scope: {callerCwd: '/workspace/effect', kind: 'repository'},
        task: 'Trace NodeHttpClient, Undici, consumers, re-exports, and tests.',
      });
      const relations = ['imports', 'imports', 'imports', 'reexports', 'tests'] as const;
      const results = EFFECT_SOURCE_ANCHORS.map((anchorPath, index) => {
        const anchorId = stableId(index * 4 + 1);
        const consumerId = stableId(index * 4 + 2);
        const metadataId = stableId(index * 4 + 3);
        const metadataEdge = relationshipEdge(`metadata-${index}`, 'contains', MIGRATION_PATH, metadataId, anchorId);
        const sourceEdge = relationshipEdge(
          `source-${index}`,
          relations[index],
          sourceConsumerPath(index),
          consumerId,
          anchorId,
        );
        return queryResult({
          edges: index === 0 ? [metadataEdge, sourceEdge] : [sourceEdge, metadataEdge],
          nodes: [
            sourceNode(metadataId, `MigrationProperty${index}`, MIGRATION_PATH, 'property', 'yaml'),
            sourceNode(consumerId, `SourceConsumer${index}`, sourceConsumerPath(index), 'function'),
            sourceNode(anchorId, `AnchorSymbol${index}`, anchorPath, 'function'),
          ],
          operation: mode === 'impact' ? 'impact' : 'neighbors',
        });
      });
      const evidence = fromRepositoryQuery(mergeContextBriefAnchoredRepositoryGraphResults(plan.graph, results));
      const logical = assembleContextBriefLogicalResult({
        graph: evidence,
        memory: emptyMemoryEvidence(),
        observedAt: '2026-08-31T00:00:00.000Z',
        plan,
      });
      const projected = projectContextBrief(logical, 1_500);
      const topCardRef = evidence.cards[0].ref;
      const topContract = evidence.contracts[0];
      const selectedContract = projected.structuredContent.graph.contracts[0];
      const selectedAction = projected.structuredContent.recommendedFollowUps[0];

      expect(evidence.cards[0]?.symbol.path).not.toBe(MIGRATION_PATH);
      expect(evidence.cards.some(card => card.symbol.path === MIGRATION_PATH)).toBe(true);
      expect(topContract).toMatchObject({
        evidence: {path: sourceConsumerPath(0)},
        relation: 'imports',
        sourceRef: stableId(2),
        targetRef: stableId(1),
      });
      expect([topContract.sourceRef, topContract.targetRef]).toContain(topCardRef);
      expect(logical.recommendedFollowUps[0]).toMatchObject({
        operation: 'inspect-node',
        ref: topCardRef,
      });
      expect(selectedAction).toMatchObject({operation: 'inspect-node', ref: topCardRef});
      if (selectedAction.operation !== 'inspect-node') throw new Error('Expected an exact graph inspection action.');
      expect([selectedContract.sourceRef, selectedContract.targetRef]).toContain(selectedAction.ref);
      expect(projected.measurement.totalBytes).toBeLessThanOrEqual(1_500 * 3);
    },
  );

  it('prioritizes direct impact consumers over arbitrary structural metadata order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({max: 1_000}), {minLength: 1, maxLength: 40}),
        fc.constantFrom<CodeGraphEdge['relation']>('exports', 'imports', 'reexports', 'tests'),
        (values, relation) => {
          const plan = planContextBrief({
            budgetTokens: 1_500,
            codeRefs: [PATH_ANCHOR],
            mode: 'impact',
            scope: {callerCwd: '/workspace/effect', kind: 'repository'},
            task: 'Assess exact downstream impact.',
          });
          const anchorId = stableId(1);
          const consumerId = stableId(2);
          const metadataNodes = values.map((value, index) =>
            sourceNode(stableId(index + 10), `migration-${value}`, MIGRATION_PATH, 'property', 'yaml'),
          );
          const metadataEdges = metadataNodes.map((node, index) =>
            relationshipEdge(`metadata-${index}`, 'contains', MIGRATION_PATH, node.id, anchorId),
          );
          const result = queryResult({
            edges: [
              ...metadataEdges,
              relationshipEdge('direct-source', relation, 'src/Consumer.ts', consumerId, anchorId),
            ],
            nodes: [
              ...metadataNodes,
              sourceNode(consumerId, 'Consumer', 'src/Consumer.ts', 'function'),
              sourceNode(anchorId, 'Anchor', PATH_ANCHOR, 'function'),
            ],
            operation: 'impact',
          });
          const evidence = fromRepositoryQuery(mergeContextBriefAnchoredRepositoryGraphResults(plan.graph, [result]));

          expect(evidence.cards[0]?.ref).toBe(consumerId);
          expect(evidence.contracts[0]?.relation).toBe(relation);
          expect(evidence.cards.filter(card => card.symbol.path === MIGRATION_PATH)).toHaveLength(values.length);
        },
      ),
      {numRuns: 50},
    );
  });

  it('routes every canonical impact path through exact path seeds while cgs stays a stable selector', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'), {minLength: 1, maxLength: 40}),
        characters => {
          const path = `src/${characters.join('')}.ts`;
          const plan = planContextBrief({
            budgetTokens: 1_500,
            codeRefs: [path, SYMBOL_ANCHOR],
            mode: 'impact',
            scope: {callerCwd: '/workspace/effect', kind: 'repository'},
            task: 'Assess exact downstream impact.',
          });
          const requests = contextBriefAnchoredRepositoryGraphRequests(plan.graph);

          expect(requests[0]).toMatchObject({
            operation: 'impact',
            query: path,
            seedQueries: [path],
            seedQueryCount: 1,
          });
          expect(requests[1]).toMatchObject({operation: 'impact', query: SYMBOL_ANCHOR});
          expect(requests[1]).not.toHaveProperty('seedQueries');
          expect(
            contextBriefAnchoredRepositoryGraphResultMatches(
              {...requests[0], seedQueries: undefined, seedQueryCount: undefined},
              queryResult({
                edges: [],
                nodes: [sourceNode(`cgs_${'4'.repeat(32)}`, 'UnrelatedMigration', MIGRATION_PATH, 'property')],
                operation: 'impact',
              }),
            ),
          ).toBe(false);
        },
      ),
      {numRuns: 50},
    );
  });
});

function queryService(
  calls: CodeGraphInspectOptions[],
  inspect: (options: CodeGraphInspectOptions) => CodeGraphQueryResult,
) {
  return CodeGraphQueryService.of({
    attachSharedReadySnapshot: () => Effect.die('Unexpected shared snapshot attachment.'),
    inspect: options =>
      Effect.sync(() => {
        calls.push(options);
        return inspect(options);
      }),
    purge: () => Effect.die('Unexpected graph purge.'),
    status: () => Effect.succeed(STATUS),
    statusForIdentity: () => Effect.die('Unexpected identity status.'),
    statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
  });
}

function queryServiceEffect<E>(inspect: (options: CodeGraphInspectOptions) => Effect.Effect<CodeGraphQueryResult, E>) {
  return CodeGraphQueryService.of({
    attachSharedReadySnapshot: () => Effect.die('Unexpected shared snapshot attachment.'),
    inspect,
    purge: () => Effect.die('Unexpected graph purge.'),
    status: () => Effect.succeed(STATUS),
    statusForIdentity: () => Effect.die('Unexpected identity status.'),
    statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
  });
}

function queryResult(input: {
  readonly edges: readonly CodeGraphEdge[];
  readonly nodes: readonly CodeGraphQueryNode[];
  readonly operation: CodeGraphQueryResult['operation'];
}): CodeGraphQueryResult {
  return {
    edges: input.edges,
    freshness: 'current',
    nodes: input.nodes,
    operation: input.operation,
    repository: {displayName: 'Effect-TS/effect', repositoryId: REPOSITORY_ID},
    snapshot: {commit: COMMIT, dirty: false, id: SNAPSHOT_ID, worktreeId: 'effect-worktree'},
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    version: 1,
    warnings: [],
  };
}

function sourceNode(id: string, name: string, path: string, kind: string, language = 'typescript'): CodeGraphQueryNode {
  return {
    contentHash: '0'.repeat(64),
    exported: true,
    id,
    kind,
    language,
    name,
    path,
    qualifiedName: name,
    score: 1,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function graphEdge(id: string, relation: CodeGraphEdge['relation'], evidencePath: string): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath,
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id,
    provenance: 'resolved',
    relation,
    sourceId: `cgs_${'6'.repeat(32)}`,
    sourceName: 'source',
    targetId: `cgs_${'7'.repeat(32)}`,
    targetName: 'target',
  };
}

function relationshipEdge(
  id: string,
  relation: CodeGraphEdge['relation'],
  evidencePath: string,
  sourceId: string,
  targetId: string,
): CodeGraphEdge {
  return {...graphEdge(id, relation, evidencePath), sourceId, targetId};
}

function stableId(value: number): string {
  return `cgs_${value.toString(16).padStart(32, '0')}`;
}

function sourceConsumerPath(index: number): string {
  return index === 0
    ? 'packages/platform/node/src/NodeClusterHttp.ts'
    : index === 3
      ? 'packages/platform/node/src/internal.ts'
      : index === 4
        ? 'packages/platform/node/test/NodeHttpClient.integration.test.ts'
        : `packages/platform/node/src/Consumer${index}.ts`;
}

function emptyMemoryEvidence() {
  return {
    candidates: [],
    consideredCandidates: 0,
    gaps: [],
    trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
  } as const;
}

const STATUS: CodeGraphStatus = {
  databasePath: '/threadnote/graph.sqlite',
  freshness: 'current',
  identity: {
    caseMode: 'sensitive',
    checkoutId: 'effect-checkout',
    displayName: 'Effect-TS/effect',
    gitCommonDirectory: '/workspace/effect/.git',
    headCommit: COMMIT,
    objectFormat: 'sha1',
    repoRoot: '/workspace/effect',
    repositoryId: REPOSITORY_ID,
    worktreeId: 'effect-worktree',
  },
  languagePacks: [],
  readySnapshot: {
    commit: COMMIT,
    dirty: false,
    edgeCount: 4,
    extractorSet: 'test-extractor',
    fileCount: 4,
    id: SNAPSHOT_ID,
    repositoryId: REPOSITORY_ID,
    state: 'ready',
    symbolCount: 4,
    worktreeId: 'effect-worktree',
  },
  stale: false,
};

const CONFIG: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/threadnote',
  agentId: 'test-agent',
  manifestPath: '/threadnote/manifest.yaml',
  user: 'tester',
};
