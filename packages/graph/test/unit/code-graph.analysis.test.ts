import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';
import {CodeGraphStoreBusyError, CodeGraphStoreError} from '@threadnote/graph/types';
import {TestError} from '@threadnote/testing/test-error';
import {Cause, Clock, Deferred, Effect, Exit, Fiber, Layer, Schema} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {SqlError} from 'effect/sql/SqlError';
import {describe, expect, it} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import {
  analyzeCodeGraph,
  analyzeCodeGraphWithLease,
  type CodeGraphAnalysisLeasedStore,
  type CodeGraphAnalysisLimits,
  type CodeGraphAnalysisStore,
} from '@threadnote/graph/analysis';
import type {CodeGraphStoreShape} from '@threadnote/graph/store';
import {
  analysisEdge,
  analysisSnapshot,
  analysisSymbol,
  pagedAnalysisStore,
  type AnalysisPagingObservation,
} from '../helpers/code-graph-analysis.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph analysis', () => {
  it.effect('computes deterministic statistics, components, communities, and cross-community links', () =>
    Effect.gen(function* () {
      const app = analysisSymbol('app-controller', '@acme/app', 'packages/app/src/controller.ts');
      const worker = analysisSymbol('app-worker', '@acme/app', 'packages/app/src/worker.ts');
      const core = analysisSymbol('core-service', '@acme/core', 'packages/core/src/service.ts');
      const repository = analysisSymbol('core-repository', '@acme/core', 'packages/core/src/repository.ts');
      const isolated = analysisSymbol('isolated-doc', undefined, 'docs/standalone.md', {
        kind: 'heading',
        language: 'markdown',
      });
      const symbols = [app, worker, core, repository, isolated];
      const edges = [
        analysisEdge('app-contains-worker', app, worker, 'contains', {provenance: 'declared'}),
        analysisEdge('core-contains-repository', core, repository, 'contains', {provenance: 'declared'}),
        analysisEdge('app-calls-core', app, core),
        analysisEdge('worker-calls-app', worker, app),
        analysisEdge('repository-self-reference', repository, repository, 'references'),
        analysisEdge('heuristic-doc-call', isolated, app, 'calls', {provenance: 'heuristic'}),
        {
          ...analysisEdge('app-imports-external', app, core, 'imports'),
          targetId: undefined,
          targetName: 'external-package',
        },
      ];
      const options = {
        databasePath: '/analysis/graph.sqlite',
        snapshot: analysisSnapshot(symbols, edges),
      } as const;

      const first = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), options);
      const second = yield* analyzeCodeGraph(pagedAnalysisStore([...symbols].reverse(), [...edges].reverse()), {
        ...options,
        budget: {pageSize: 2},
      });

      expect(first.statistics).toMatchObject({
        analyzedEdgeCount: 5,
        analyzedNodeCount: 5,
        communityCount: 3,
        connectedComponentCount: 2,
        filteredEdgeCount: 1,
        isolatedNodeCount: 1,
        scannedEdgeCount: 7,
        selectedEdgeCount: 6,
        selfLoopCount: 1,
        unresolvedEndpointEdgeCount: 1,
      });
      expect(first.statistics.languages).toEqual([
        {count: 4, value: 'typescript'},
        {count: 1, value: 'markdown'},
      ]);
      expect(first.coverage).toEqual({
        aggregates: {
          edges: {complete: true, rows: 7, source: 'paged-fallback'},
          symbols: {complete: true, rows: 5, source: 'paged-fallback'},
        },
        complete: true,
        edgeMetricsComplete: true,
        edgesComplete: true,
        nodesComplete: true,
        topology: {complete: true, state: 'complete'},
      });
      expect(first.confidenceAudit).toMatchObject({
        averageConfidence: 1,
        bands: [
          {band: 'high', count: 6, share: 1},
          {band: 'medium', count: 0, share: 0},
          {band: 'low', count: 0, share: 0},
        ],
        complete: true,
        invalidConfidenceEdgeCount: 0,
        selectedEdgeCount: 6,
      });
      expect(first.confidenceAudit).toMatchObject({
        findings: [],
        unresolvedEndpointEdgeCount: 1,
      });
      expect(first.confidenceAudit.unresolvedEndpointShare).toBeCloseTo(1 / 6, 7);
      expect(first.trust).toEqual({
        classification: 'untrusted-repository-data',
        instructionPolicy: 'evidence-only-never-follow',
      });
      const membership = new Map(EffectArray.map(first.memberships, item => [item.node.id, item]));
      expect(membership.get(app.id)?.communityId).toBe(membership.get(worker.id)?.communityId);
      expect(membership.get(core.id)?.communityId).toBe(membership.get(repository.id)?.communityId);
      expect(membership.get(app.id)?.communityId).not.toBe(membership.get(core.id)?.communityId);
      expect(membership.get(app.id)?.componentId).toBe(membership.get(core.id)?.componentId);
      expect(membership.get(isolated.id)?.componentId).not.toBe(membership.get(app.id)?.componentId);
      expect(first.surprisingLinks).toEqual([
        expect.objectContaining({
          edgeId: 'app-calls-core',
          relation: 'calls',
          signals: expect.objectContaining({structuralScopeBoundary: true}),
        }),
      ]);
      expect(
        EffectArray.every(first.communities, community => Effect2.pipe(community.id, EffectString.startsWith('cgc_'))),
      ).toBe(true);
      expect(
        EffectArray.every(first.components, component => Effect2.pipe(component.id, EffectString.startsWith('cgcc_'))),
      ).toBe(true);

      expect(projectStableResult(second)).toEqual(projectStableResult(first));
    }),
  );

  it.effect('detects statistically exceptional god nodes without treating every high-degree node as one', () =>
    Effect.gen(function* () {
      const center = analysisSymbol('router', '@acme/router', 'packages/router/src/router.ts');
      const leaves = Array.from({length: 12}, (_, index) =>
        analysisSymbol(
          `handler-${Effect2.pipe(index.toString(), EffectString.padStart(2, '0'))}`,
          `@acme/handler-${index}`,
          `handlers/${index}.ts`,
        ),
      );
      const symbols = [center, ...leaves];
      const edges = EffectArray.map(leaves, (leaf, index) =>
        analysisEdge(`route-${Effect2.pipe(index.toString(), EffectString.padStart(2, '0'))}`, center, leaf),
      );

      const result = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
        databasePath: '/analysis/graph.sqlite',
        snapshot: analysisSnapshot(symbols, edges),
      });

      expect(result.hubs).toHaveLength(1);
      expect(result.hubs[0]).toMatchObject({
        classification: 'god-node',
        degree: 12,
        node: {id: center.id},
        outgoing: 12,
      });
      expect(result.hubThresholds.godNode).toBeGreaterThan(result.hubThresholds.hub);
    }),
  );

  it.effect('audits numeric confidence and provenance in the topology pass with bounded deterministic findings', () =>
    Effect.gen(function* () {
      const source = analysisSymbol('source', '@acme/source', 'packages/source/src/index.ts');
      const target = analysisSymbol('target', '@acme/target', 'packages/target/src/index.ts');
      const edges = [
        analysisEdge('low-model', source, target, 'semantic_association', {confidence: 0.25, provenance: 'model'}),
        analysisEdge('medium-heuristic', source, target, 'references', {confidence: 0.75, provenance: 'heuristic'}),
        analysisEdge('high-resolved', source, target, 'calls'),
        analysisEdge('invalid-declared', source, target, 'depends_on', {confidence: 1.2, provenance: 'declared'}),
        analysisEdge('low-resolved', source, target, 'calls', {confidence: 0.5}),
      ];

      const result = yield* analyzeCodeGraph(pagedAnalysisStore([source, target], edges), {
        allowedProvenances: ['declared', 'heuristic', 'model', 'resolved'],
        databasePath: '/analysis/graph.sqlite',
        limits: {confidenceFindings: 2},
        snapshot: analysisSnapshot([source, target], edges),
      });

      expect(result.confidenceAudit).toMatchObject({
        averageConfidence: 0.7,
        bands: [
          {band: 'high', count: 2, share: 0.4},
          {band: 'medium', count: 1, share: 0.2},
          {band: 'low', count: 2, share: 0.4},
        ],
        complete: true,
        highConfidenceThreshold: 0.9,
        invalidConfidenceEdgeCount: 1,
        lowConfidenceThreshold: 0.6,
        selectedEdgeCount: 5,
      });
      expect(result.confidenceAudit.provenances).toEqual([
        expect.objectContaining({averageConfidence: 0.75, count: 2, lowestConfidence: 0.5, provenance: 'resolved'}),
        expect.objectContaining({averageConfidence: 1, count: 1, provenance: 'declared'}),
        expect.objectContaining({averageConfidence: 0.75, count: 1, provenance: 'heuristic'}),
        expect.objectContaining({averageConfidence: 0.25, count: 1, provenance: 'model'}),
      ]);
      expect(EffectArray.map(result.confidenceAudit.findings, finding => finding.edgeId)).toEqual([
        'invalid-declared',
        'low-model',
      ]);
      expect(result.warnings).toContain('Showing 2 of 3 confidence-audit findings.');
    }),
  );

  it.effect('keeps one strongest surprising link per community boundary', () =>
    Effect.gen(function* () {
      const alpha = analysisSymbol('alpha', '@acme/a', 'packages/a/src/index.ts');
      const alphaHelper = analysisSymbol('alpha-helper', '@acme/a', 'packages/a/src/index.ts');
      const beta = analysisSymbol('beta', '@acme/b', 'packages/b/src/index.ts');
      const betaHelper = analysisSymbol('beta-helper', '@acme/b', 'packages/b/src/index.ts');
      const gamma = analysisSymbol('gamma', '@acme/c', 'packages/c/src/index.ts');
      const gammaHelper = analysisSymbol('gamma-helper', '@acme/c', 'packages/c/src/index.ts');
      const symbols = [alpha, alphaHelper, beta, betaHelper, gamma, gammaHelper];
      const edges = [
        analysisEdge('alpha-internal', alpha, alphaHelper),
        analysisEdge('beta-internal', beta, betaHelper),
        analysisEdge('gamma-internal', gamma, gammaHelper),
        analysisEdge('alpha-beta-strong', alpha, beta, 'calls'),
        analysisEdge('alpha-beta-duplicate', alphaHelper, betaHelper, 'references'),
        analysisEdge('alpha-gamma', alpha, gamma, 'calls'),
      ];

      const result = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
        databasePath: '/analysis/graph.sqlite',
        snapshot: analysisSnapshot(symbols, edges),
      });

      expect(result.surprisingLinks).toHaveLength(2);
      const pairs = EffectArray.map(result.surprisingLinks, link =>
        EffectArray.join([link.source.communityId, link.target.communityId].sort(), ':'),
      );
      expect(new Set(pairs).size).toBe(pairs.length);
    }),
  );

  it.effect('drills into a stable community ID with bounded and honest member coverage', () =>
    Effect.gen(function* () {
      const first = analysisSymbol('first', '@acme/app', 'src/app.ts');
      const second = analysisSymbol('second', '@acme/app', 'src/app.ts');
      const outside = analysisSymbol('outside', '@acme/other', 'src/other.ts');
      const symbols = [first, second, outside];
      const edges = [analysisEdge('contains', first, second, 'contains'), analysisEdge('boundary', second, outside)];
      const snapshot = analysisSnapshot(symbols, edges);
      const initial = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
        databasePath: '/analysis/graph.sqlite',
        snapshot,
      });
      const communityId = EffectOption.getOrUndefined(
        EffectArray.findFirst(initial.memberships, item => item.node.id === first.id),
      )!.communityId;

      const selected = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
        communityId,
        databasePath: '/analysis/graph.sqlite',
        limits: analysisLimits({communityMembers: 1}),
        snapshot,
      });
      expect(selected.communityDrillDown).toMatchObject({
        community: {id: communityId, memberCount: 2},
        coverage: {complete: false, shownMemberCount: 1, totalMemberCount: 2},
        requestedId: communityId,
        state: 'found',
      });
      expect(selected.communityDrillDown?.state === 'found' && selected.communityDrillDown.members).toHaveLength(1);
      expect(selected.warnings).toContain(`Showing 1 of 2 members for ${communityId}.`);

      const absent = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
        communityId: `cgc_${Effect2.pipe('0', EffectString.repeat(32))}`,
        databasePath: '/analysis/graph.sqlite',
        limits: analysisLimits({communityMembers: 1}),
        snapshot,
      });
      expect(absent.communityDrillDown).toEqual({
        complete: true,
        requestedId: `cgc_${Effect2.pipe('0', EffectString.repeat(32))}`,
        state: 'not-found',
      });
    }),
  );

  it.effect('derives stable bounded n-ary relationship groups from high-degree fan patterns', () =>
    Effect.gen(function* () {
      const center = analysisSymbol('dispatcher', '@acme/app', 'src/dispatcher.ts');
      const leaves = Array.from({length: 12}, (_, index) =>
        analysisSymbol(
          `handler-${Effect2.pipe(index.toString(), EffectString.padStart(2, '0'))}`,
          '@acme/app',
          `src/handler-${index}.ts`,
        ),
      );
      const symbols = [center, ...leaves];
      const edges = EffectArray.map(leaves, (leaf, index) =>
        analysisEdge(`dispatch-${Effect2.pipe(index.toString(), EffectString.padStart(2, '0'))}`, center, leaf),
      );
      const options = {
        databasePath: '/analysis/graph.sqlite',
        limits: analysisLimits({relationshipGroupMembers: 3, relationshipGroups: 1}),
        snapshot: analysisSnapshot(symbols, edges),
      } as const;

      const first = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), options);
      const second = yield* analyzeCodeGraph(pagedAnalysisStore([...symbols].reverse(), [...edges].reverse()), {
        ...options,
        budget: {pageSize: 2},
      });

      expect(first.relationshipGroups).toEqual([
        expect.objectContaining({
          center: expect.objectContaining({id: center.id}),
          direction: 'fan-out',
          kind: 'structural-hyperedge',
          memberSampleComplete: false,
          relationshipCount: 12,
        }),
      ]);
      expect(first.relationshipGroups[0].id).toMatch(/^cgrg_[a-f0-9]{32}$/);
      expect(first.relationshipGroups[0].members).toHaveLength(3);
      expect(second.relationshipGroups).toEqual(first.relationshipGroups);
      expect(first.suggestedQuestions).toContain(
        'Why does dispatcher fan out across 12 relationships, and which responsibilities can be separated?',
      );
    }),
  );

  it.effect('uses aggregate pages only when every topology and finding output limit is zero', () =>
    Effect.gen(function* () {
      const symbols = Array.from({length: 50}, (_, index) =>
        analysisSymbol(
          `node-${Effect2.pipe(index.toString(), EffectString.padStart(2, '0'))}`,
          '@acme/app',
          `src/${index}.ts`,
        ),
      );
      const edges = EffectArray.map(symbols.slice(1), (symbol, index) =>
        analysisEdge(`edge-${index}`, symbols[0], symbol),
      );
      const observation: AnalysisPagingObservation = {edgePageLimits: [], symbolPageLimits: []};
      const result = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges, observation), {
        budget: {pageSize: 7},
        databasePath: '/analysis/graph.sqlite',
        limits: analysisLimits(),
        snapshot: analysisSnapshot(symbols, edges),
      });

      expect(result.usage.edgeVisits).toBe(0);
      expect(observation.edgePageLimits).toHaveLength(0);
      expect(result.coverage.topology.state).toBe('not-requested');
      expect(result.statistics).toMatchObject({aggregatedEdgeCount: edges.length, aggregatedNodeCount: symbols.length});
      expect(result).toMatchObject({
        communities: [],
        components: [],
        hubs: [],
        memberships: [],
        relationshipGroups: [],
      });
    }),
  );

  it.effect('scales exact whole-graph statistics without hydrating topology when output limits are zero', () =>
    Effect.gen(function* () {
      const symbols = Array.from({length: 10_000}, (_, index) =>
        analysisSymbol(
          `scale-${Effect2.pipe(index.toString(), EffectString.padStart(5, '0'))}`,
          '@acme/scale',
          `src/${index}.ts`,
        ),
      );
      const edges = EffectArray.map(symbols.slice(1), (symbol, index) =>
        analysisEdge(`scale-edge-${Effect2.pipe(index.toString(), EffectString.padStart(5, '0'))}`, symbols[0], symbol),
      );
      const observation: AnalysisPagingObservation = {edgePageLimits: [], symbolPageLimits: []};
      const result = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges, observation), {
        budget: {pageSize: 128},
        databasePath: '/analysis/scale.sqlite',
        limits: analysisLimits(),
        snapshot: analysisSnapshot(symbols, edges),
      });

      expect(result.coverage.complete).toBe(true);
      expect(result.statistics).toMatchObject({
        aggregatedEdgeCount: 9_999,
        aggregatedNodeCount: 10_000,
        analyzedEdgeCount: 0,
        analyzedNodeCount: 0,
      });
      expect(result.usage.edgeVisits).toBe(0);
      expect(result.coverage.topology.state).toBe('not-requested');
      expect(observation.edgePageLimits).toHaveLength(0);
      expect(observation.symbolPageLimits).toHaveLength(0);
    }),
  );

  it.effect('leases the ready snapshot and releases it after success and interruption-safe failure', () =>
    Effect.gen(function* () {
      const symbol = analysisSymbol('leased', '@acme/app', 'src/leased.ts');
      const snapshot = analysisSnapshot([symbol], []);
      const events: string[] = [];
      const successful = leasedAnalysisStore(pagedAnalysisStore([symbol], []), events);
      yield* analyzeCodeGraphWithLease(successful, {
        databasePath: '/analysis/graph.sqlite',
        snapshot,
      });
      expect(events).toEqual(['acquire:analysis-snapshot', 'session', 'release:lease-token']);

      const failedEvents: string[] = [];
      const failed = leasedAnalysisStore(
        {
          ...pagedAnalysisStore([symbol], []),
          loadSymbolPage: () => Effect.fail(CodeGraphStoreError.of('read failed')),
        } satisfies CodeGraphAnalysisStore,
        failedEvents,
      );
      const failure = yield* analyzeCodeGraphWithLease(failed, {
        databasePath: '/analysis/graph.sqlite',
        snapshot,
      }).pipe(Effect.flip);
      expect(failure).toHaveProperty('message', 'read failed');
      expect(failedEvents).toEqual(['acquire:analysis-snapshot', 'session', 'release:lease-token']);
    }),
  );

  it.effect('attributes lease acquisition, read session and release without moving their boundaries', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const base = leasedAnalysisStore(pagedAnalysisStore([], []), events);
      const measured: {stage: string; milliseconds: number}[] = [];
      const store: CodeGraphAnalysisLeasedStore = {
        ...base,
        acquireSnapshotLease: (...args) =>
          TestClock.adjust(11).pipe(Effect.andThen(base.acquireSnapshotLease(...args))),
        withSession: (database, effect, options) =>
          base.withSession(database, TestClock.adjust(17).pipe(Effect.andThen(effect)), options),
        releaseSnapshotLease: (...args) =>
          TestClock.adjust(23).pipe(Effect.andThen(base.releaseSnapshotLease(...args))),
      };
      const result = yield* analyzeCodeGraphWithLease(store, {
        databasePath: '/analysis/graph.sqlite',
        snapshot: analysisSnapshot([], []),
        onTiming: stage =>
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis;
            return yield* Effect.succeed(
              Clock.currentTimeMillis.pipe(
                Effect.tap(finished =>
                  Effect.sync(() => {
                    measured.push({stage, milliseconds: finished - started});
                  }),
                ),
                Effect.asVoid,
              ),
            );
          }),
      });
      expect(measured).toEqual([
        {stage: 'lease-acquire', milliseconds: 11},
        {stage: 'read-session', milliseconds: 17},
        {stage: 'lease-release', milliseconds: 23},
      ]);
      expect(result.leaseCleanup?.state).toBe('released');
      expect(events).toEqual(['acquire:analysis-snapshot', 'session', 'release:lease-token']);
    }),
  );

  fcEffectProp(
    it,
    'optional timing failures preserve analysis outcomes and lease ownership',
    {readFails: fc.boolean(), startFails: fc.boolean(), completionFails: fc.boolean()},
    ({readFails, startFails, completionFails}) =>
      Effect.gen(function* () {
        const events: string[] = [];
        const symbol = analysisSymbol('timed', '@acme/app', 'src/timed.ts');
        const failure = CodeGraphStoreBusyError.of('read failed');
        const base = pagedAnalysisStore([symbol], []);
        const store = leasedAnalysisStore(
          readFails ? {...base, loadSymbolPage: () => Effect.fail(failure)} : base,
          events,
        );
        const options = {databasePath: '/analysis/graph.sqlite', snapshot: analysisSnapshot([symbol], [])};
        const original = yield* analyzeCodeGraphWithLease(store, options).pipe(Effect.exit);
        const observed = yield* analyzeCodeGraphWithLease(store, {
          ...options,
          onTiming: () =>
            startFails
              ? Effect.fail(TestError.make({message: 'observer start failed'}))
              : Effect.succeed(completionFails ? Effect.die('observer completion failed') : Effect.void),
        }).pipe(Effect.exit);
        if (readFails) {
          for (const exit of [original, observed]) {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(exit.cause.reasons).toHaveLength(1);
              const reason = exit.cause.reasons[0];
              expect(Cause.isFailReason(reason) && reason.error === failure).toBe(true);
            }
          }
        } else expect(observed).toEqual(original);
        expect(EffectArray.filter(events, event => event === 'release:lease-token')).toHaveLength(2);
      }),
    {fastCheck: {numRuns: 24}},
  );

  it.effect('never writes a missing summary and bounds both lease writer gates', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const base = leasedAnalysisStore(pagedAnalysisStore([], []), events);
      const waits: number[] = [];
      const store: CodeGraphAnalysisLeasedStore & Pick<CodeGraphStoreShape, 'ensureAnalysisSummary'> = {
        ...base,
        acquireSnapshotLease: (path, snapshot, duration, options) => {
          waits.push(options?.waitTimeoutMilliseconds ?? Infinity);
          return base.acquireSnapshotLease(path, snapshot, duration, options);
        },
        ensureAnalysisSummary: () => Effect.die('Foreground analysis must not backfill summaries'),
        releaseSnapshotLease: (path, token, options) => {
          waits.push(options?.waitTimeoutMilliseconds ?? Infinity);
          return base.releaseSnapshotLease(path, token, options);
        },
      };
      yield* analyzeCodeGraphWithLease(store, {
        databasePath: '/analysis/graph.sqlite',
        snapshot: analysisSnapshot([], []),
      });
      expect(waits).toEqual([0, 0]);
    }),
  );

  it.effect('releases an acquired lease when interrupted before opening the read session', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const events: string[] = [];
      const store: CodeGraphAnalysisLeasedStore = {
        ...leasedAnalysisStore(pagedAnalysisStore([], []), events),
        withSession: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      };
      const fiber = yield* analyzeCodeGraphWithLease(store, {
        databasePath: '/analysis/graph.sqlite',
        snapshot: analysisSnapshot([], []),
        onTiming: () => Effect.succeed(Effect.die('observer cleanup defect')),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(events).toEqual(['acquire:analysis-snapshot', 'release:lease-token']);
    }),
  );

  it.effect('defers lease acquisition on writer contention without opening an unleased session', () =>
    Effect.gen(function* () {
      const store: CodeGraphAnalysisLeasedStore = {
        ...pagedAnalysisStore([], []),
        acquireSnapshotLease: () => Effect.fail(CodeGraphStoreBusyError.of('busy')),
        withSession: () => Effect.die('An unleased read is forbidden'),
        releaseSnapshotLease: () => Effect.die('A lease that was never acquired must not be released'),
      };
      const failure = yield* analyzeCodeGraphWithLease(store, {
        databasePath: '/analysis/graph.sqlite',
        snapshot: analysisSnapshot([], []),
      }).pipe(Effect.flip);
      expect(failure).toMatchObject({_tag: 'CodeGraphAnalysisDeferred', reason: 'writer-contention'});
    }),
  );

  fcEffectProp(
    it,
    'every successful analysis releases its lease or discloses bounded expiry',
    {busyRelease: fc.boolean()},
    ({busyRelease}) =>
      Effect.gen(function* () {
        const events: string[] = [];
        const base = leasedAnalysisStore(pagedAnalysisStore([], []), events);
        const result = yield* analyzeCodeGraphWithLease(
          {
            ...base,
            releaseSnapshotLease: (path, token, options) =>
              busyRelease
                ? Effect.fail(CodeGraphStoreBusyError.of('busy'))
                : base.releaseSnapshotLease(path, token, options),
          },
          {databasePath: '/analysis/graph.sqlite', snapshot: analysisSnapshot([], [])},
        );
        expect(result.leaseCleanup?.state).toBe(busyRelease ? 'expiry' : 'released');
        expect(result.leaseCleanup?.expiresAt).toBeGreaterThan(0);
        expect(result.leaseCleanup?.expiresAt).toBeLessThanOrEqual(120000);
        expect(
          EffectArray.filter(
            events,
            __effectArrayValue =>
              !!(event => Effect2.pipe(event, EffectString.startsWith('release:')))(__effectArrayValue),
          ),
        ).toHaveLength(busyRelease ? 0 : 1);
      }),
    {fastCheck: {numRuns: 10}},
  );

  it.effect('installs release before observing interruption at acquisition completion', () =>
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const events: string[] = [];
      const base = leasedAnalysisStore(pagedAnalysisStore([], []), events);
      const store: CodeGraphAnalysisLeasedStore = {
        ...base,
        acquireSnapshotLease: () =>
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(proceed)), Effect.as('lease-token')),
      };
      const fiber = yield* analyzeCodeGraphWithLease(store, {
        databasePath: '/analysis/graph.sqlite',
        snapshot: analysisSnapshot([], []),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Deferred.succeed(proceed, undefined);
      yield* Fiber.join(interrupted);
      expect(events).toContain('release:lease-token');
    }),
  );

  it.effect('counts each symbol identity once even if a malformed page repeats a row', () =>
    Effect.gen(function* () {
      const first = analysisSymbol('first', '@acme/app', 'src/first.ts');
      const second = analysisSymbol('second', '@acme/app', 'src/second.ts');
      const snapshot = analysisSnapshot([first, second], []);

      const result = yield* analyzeCodeGraph(pagedAnalysisStore([first, first, second], []), {
        budget: {pageSize: 3},
        databasePath: '/analysis/graph.sqlite',
        snapshot,
      });

      expect(result.statistics.analyzedNodeCount).toBe(new Set([first.id, second.id]).size);
      expect(EffectArray.map(result.memberships, item => item.node.id)).toEqual([first.id, second.id]);
    }),
  );

  it.effect('derives omitted graph-size budgets from the snapshot without fixed admission caps', () =>
    Effect.gen(function* () {
      const result = yield* analyzeCodeGraph(pagedAnalysisStore([], []), {
        databasePath: '/analysis/graph.sqlite',
        snapshot: {
          ...analysisSnapshot([], []),
          edgeCount: 30_000_000,
          symbolCount: 8_000_000,
        },
      });

      expect(result.budget).toMatchObject({
        maxEdges: 30_000_000,
        maxEdgeVisits: 60_000_000,
        maxNodes: 8_000_000,
      });
      expect(result.coverage).toMatchObject({complete: false, edgesComplete: false, nodesComplete: false});
    }),
  );

  it.effect('returns honest bounded topology when node, edge, visit, and output limits are exhausted', () =>
    Effect.gen(function* () {
      const symbols = Array.from({length: 8}, (_, index) =>
        analysisSymbol(`node-${index}`, `package-${index % 2}`, `src/${index}.ts`),
      );
      const edges = EffectArray.map(symbols, (symbol, index) =>
        analysisEdge(`edge-${index}`, symbol, symbols[(index + 1) % symbols.length]),
      );
      const observation: AnalysisPagingObservation = {edgePageLimits: [], symbolPageLimits: []};

      const result = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges, observation), {
        budget: {maxEdges: 2, maxEdgeVisits: 3, maxNodes: 3, pageSize: 2},
        databasePath: '/analysis/graph.sqlite',
        limits: {communities: 1, components: 1, hubs: 1, memberships: 1, surprisingLinks: 1},
        snapshot: analysisSnapshot(symbols, edges),
      });

      expect(result.coverage).toEqual({
        aggregates: {
          edges: {complete: false, rows: 2, source: 'paged-fallback'},
          symbols: {complete: false, rows: 3, source: 'paged-fallback'},
        },
        complete: false,
        edgeMetricsComplete: false,
        edgesComplete: false,
        nodesComplete: false,
        topology: {complete: false, state: 'partial'},
      });
      expect(result.statistics.analyzedNodeCount).toBe(3);
      expect(result.statistics.analyzedEdgeCount).toBeLessThanOrEqual(2);
      expect(result.statistics.scannedEdgeCount).toBe(2);
      expect(result.usage.edgeVisits).toBe(3);
      expect(result.memberships).toHaveLength(1);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Symbol aggregates cover 3 of 8'),
          expect.stringContaining('Relationship aggregates cover 2 of 8'),
          expect.stringContaining('bounded observation over a path-prefix node set'),
        ]),
      );
      expect(Math.max(...observation.symbolPageLimits, ...observation.edgePageLimits)).toBeLessThanOrEqual(2);
    }),
  );

  it.effect('checks its elapsed-time budget between bounded pages', () =>
    Effect.gen(function* () {
      const first = analysisSymbol('first', '@acme/app', 'src/first.ts');
      const second = analysisSymbol('second', '@acme/app', 'src/second.ts');
      let page = 0;
      const store: CodeGraphAnalysisStore = {
        ...pagedAnalysisStore([first, second], []),
        loadSymbolPage: () =>
          Effect.gen(function* () {
            page += 1;
            yield* TestClock.adjust(11);
            return page === 1 ? [first] : [second];
          }),
      };

      const result = yield* analyzeCodeGraph(store, {
        budget: {maxDurationMilliseconds: 10, pageSize: 1},
        databasePath: '/analysis/graph.sqlite',
        snapshot: analysisSnapshot([first, second], []),
      });

      expect(result.statistics.analyzedNodeCount).toBe(1);
      expect(result.coverage.nodesComplete).toBe(false);
      expect(result.usage.nodePageReads).toBe(1);
    }),
  );

  it.effect('remains cooperatively cancellable while a page read is pending', () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const store: CodeGraphAnalysisStore = {
        ...pagedAnalysisStore([], []),
        loadSymbolPage: () => Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
      };
      const fiber = yield* analyzeCodeGraph(store, {
        databasePath: '/analysis/graph.sqlite',
        snapshot: {...analysisSnapshot([], []), symbolCount: 1},
      }).pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* Fiber.interrupt(fiber);
    }),
  );
});

function projectStableResult(result: Effect.Success<ReturnType<typeof runFixtureAnalysis>>) {
  return {
    communities: result.communities,
    components: result.components,
    confidenceAudit: result.confidenceAudit,
    coverage: result.coverage,
    hubThresholds: result.hubThresholds,
    hubs: result.hubs,
    memberships: result.memberships,
    relationshipGroups: result.relationshipGroups,
    statistics: result.statistics,
    suggestedQuestions: result.suggestedQuestions,
    surprisingLinks: result.surprisingLinks,
    warnings: result.warnings,
  };
}

function analysisLimits(overrides: CodeGraphAnalysisLimits = {}) {
  return mergeAnalysisLimits(overrides);
}

function mergeAnalysisLimits(overrides: CodeGraphAnalysisLimits) {
  return {
    communities: 0,
    communityMembers: 0,
    components: 0,
    confidenceFindings: 0,
    hubs: 0,
    memberships: 0,
    relationshipGroupMembers: 0,
    relationshipGroups: 0,
    surprisingLinks: 0,
    ...overrides,
  };
}

function leasedAnalysisStore(base: CodeGraphAnalysisStore, events: string[]): CodeGraphAnalysisLeasedStore {
  return {
    ...base,
    acquireSnapshotLease: (_databasePath, snapshotId) =>
      Effect.sync(() => {
        events.push(`acquire:${snapshotId}`);
        return 'lease-token';
      }),
    releaseSnapshotLease: (_databasePath, token) => Effect.sync(() => void events.push(`release:${token}`)),
    withSession: (_databasePath, effect) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.sync(() => void events.push('session'));
          const context = yield* Layer.build(SqliteClient.layer({filename: ':memory:'}));
          return yield* Effect.provideContext(effect, context);
        }),
      ).pipe(Effect.mapError(error => (Schema.is(SqlError)(error) ? CodeGraphStoreError.of(error.message) : error))),
  };
}

function runFixtureAnalysis() {
  const symbols = [analysisSymbol('placeholder', undefined, 'placeholder.ts')];
  return analyzeCodeGraph(pagedAnalysisStore(symbols, []), {
    databasePath: '/analysis/graph.sqlite',
    snapshot: analysisSnapshot(symbols, []),
  });
}
