import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdir, mkdtemp, rm, utimes, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {it as effectIt} from '@effect/vitest';
import {Cause, DateTime, Effect, Exit, Fiber, Layer, Option, Semaphore} from 'effect';
import * as FC from 'fast-check';
import {TestClock} from 'effect/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const inference = vi.hoisted(() => ({
  rerank: vi.fn(),
}));
vi.mock('@threadnote/inference/models/inference', () => ({
  rerankWithSelectedLocalModel: inference.rerank,
}));
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {readMemoryRecordsByUri, runRecall} from '@threadnote/threadnote/memory/index';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import {loadRecallIndex, loadRecallIndexData, recallIndexDatabaseFilename} from '@threadnote/recall/index';
import {buildRecallTopicalCorpusStatistics} from '@threadnote/recall/rank';
import {
  boundedRecallSemanticRetrieval,
  createRecallRerankerCache,
  loadRecallExpansionVocabulary,
  mergeRecallCandidateLanes,
  mergeRecallIndexCandidates,
  mergePrioritizedRecallIndexCandidates,
  MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS,
  prepareRecallSections,
  prioritizeCrossScopeRecallCandidates,
  prioritizeWorkspaceRecallCandidates,
  recallCrossScopeFallbackRequired,
  recallCrossScopeLaneBudgets,
} from '@threadnote/recall/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {buildRecallSections} from '@threadnote/recall/results';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('recall runtime orchestration', () => {
  const homes: string[] = [];
  beforeEach(() => {
    inference.rerank.mockReset();
    inference.rerank.mockReturnValue(Effect.succeed([0.8]));
  });
  afterEach(async () => {
    await Promise.all(
      EffectArray.map(homes.splice(0), home =>
        rm(home, {
          force: true,
          recursive: true,
        }),
      ),
    );
  });
  it('preserves a global identity conflict when an earlier scoped lane retained the same URI', () => {
    const scoped = {
      fields: {project: 'threadnote', topic: 'identity-conflict'},
      memoryId: 'tn_identity_conflict',
      text: 'Identity conflict target.',
      uri: 'threadnote://user/test/memories/durable/projects/threadnote/identity-conflict.md',
    };

    expect(mergeRecallIndexCandidates([[scoped], [{...scoped, identityConflict: true}]])).toEqual([
      {...scoped, identityConflict: true},
    ]);
  });
  it('keeps a topical repo-wide result ahead of more than one rank window of scope-only candidates', () => {
    const relevant = {
      fields: {project: 'monorepo', title: 'Search checkout retry contract', topic: 'checkout-retry'},
      text: 'Search checkout retry contract uses bounded attempts.',
      uri: 'threadnote://user/test/memories/durable/projects/monorepo/repo-wide.md',
    };
    const scopeOnly = Array.from({length: 150}, (_unused, index) => ({
      fields: {
        project: 'monorepo',
        title: `Unrelated package note ${index}`,
        topic: `unrelated-${index}`,
        workspaceScope: 'apps/search',
      },
      text: 'Unrelated package-local operational note.',
      uri: `threadnote://user/test/memories/durable/projects/monorepo/scope-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
    }));
    const candidates = mergePrioritizedRecallIndexCandidates([[relevant]], [scopeOnly]);

    expect(candidates[0]?.uri).toBe(relevant.uri);
    expect(buildRecallTopicalCorpusStatistics(candidates).documentFrequency.search).toBe(1);
    const sections = buildRecallSections([], [], 5, {
      indexedCandidates: candidates,
      project: 'monorepo',
      query: 'search checkout retry contract',
      workspaceScope: 'apps/search',
    });
    expect(EffectArray.map(sections.ranked, hit => hit.uri)).toEqual([relevant.uri]);
  });
  it('reserves bounded admission for a current-package match beyond a full topical window', () => {
    const siblingCandidates = Array.from({length: 125}, (_unused, index) => ({
      fields: {
        project: 'monorepo',
        title: 'Checkout retry contract',
        topic: 'checkout-retry',
        workspaceScope: `apps/sibling-${index}`,
      },
      text: 'Checkout retry contract uses bounded attempts.',
      uri: `threadnote://user/test/memories/durable/projects/monorepo/sibling-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
    }));
    const currentPackage = {
      fields: {
        project: 'monorepo',
        title: 'Checkout retry contract',
        topic: 'checkout-retry',
        workspaceScope: 'apps/search',
      },
      text: 'Checkout retry contract uses bounded attempts.',
      uri: 'threadnote://user/test/memories/durable/projects/monorepo/current-package.md',
    };
    const localIrrelevant = Array.from({length: 20}, (_unused, index) => ({
      fields: {
        project: 'monorepo',
        title: `Unrelated local note ${index}`,
        topic: `unrelated-local-${index}`,
        workspaceScope: 'apps/search',
      },
      text: 'Unrelated package-local operational note.',
      uri: `threadnote://user/test/memories/durable/projects/monorepo/local-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
    }));
    const supplementalPool = [...localIrrelevant, currentPackage];
    const prioritizedWorkspace = prioritizeWorkspaceRecallCandidates('checkout retry contract', supplementalPool, {
      project: 'monorepo',
      workspaceScope: 'apps/search',
    });
    const candidates = mergePrioritizedRecallIndexCandidates(
      [[...siblingCandidates, currentPackage]],
      [prioritizedWorkspace],
      {admissionLimit: 100, supplementalReserve: 10},
    );

    expect(supplementalPool.indexOf(currentPackage)).toBeGreaterThan(16);
    expect(prioritizedWorkspace[0]?.uri).toBe(currentPackage.uri);
    expect(EffectArray.map(candidates.slice(0, 100), candidate => candidate.uri)).toContain(currentPackage.uri);
    const sections = buildRecallSections([], [], 5, {
      indexedCandidates: candidates,
      project: 'monorepo',
      query: 'checkout retry contract',
      workspaceScope: 'apps/search',
    });
    expect(sections.ranked[0]?.uri).toBe(currentPackage.uri);
  });
  it('rejects repo-wide, current-hierarchy, and malformed candidates from the cross-scope topical lane', () => {
    const candidate = (workspaceScope: string | undefined, topic: string, project = 'monorepo') => ({
      fields: {project, topic: `${topic}-quasar-rollback-checksum`, workspaceScope},
      text: 'Quasar rollback checksum contract.',
      uri: `threadnote://user/test/memories/durable/projects/monorepo/${topic}.md`,
    });
    const sibling = candidate('apps/billing', 'sibling');
    const descendants = candidate('apps/search/frontend', 'descendant');
    const candidates = prioritizeCrossScopeRecallCandidates(
      'quasar rollback checksum',
      [
        candidate(undefined, 'repo-wide'),
        candidate('apps', 'ancestor'),
        candidate('apps/search', 'exact'),
        candidate('../apps/billing', 'malformed'),
        candidate('apps/payments', 'other-project', 'other'),
        sibling,
        descendants,
      ],
      {project: 'monorepo', workspaceScope: 'apps/search'},
    );

    expect(EffectArray.map(candidates, result => result.uri)).toEqual(
      expect.arrayContaining([descendants.uri, sibling.uri]),
    );
    expect(candidates).toHaveLength(2);
  });
  it('skips the sibling fallback only after the broad topical query proves exhaustive', () => {
    expect(recallCrossScopeFallbackRequired(undefined)).toBe(true);
    expect(recallCrossScopeFallbackRequired(false)).toBe(true);
    expect(recallCrossScopeFallbackRequired(true)).toBe(false);
  });
  it('does not collapse protected and cross-scope reservations across different logical invariants', () => {
    const topical = Array.from({length: 100}, (_unused, index) => ({
      fields: {project: 'monorepo', topic: `topical-${index}`},
      text: 'Topical candidate.',
      uri: `threadnote://user/test/memories/durable/projects/monorepo/topical-${index}.md`,
    }));
    const protectedCandidate = {
      contentHash: 'same-body',
      fields: {project: 'monorepo', topic: 'search-contract', workspaceScope: 'apps/search'},
      kind: 'durable' as const,
      memoryId: 'tn_same_header',
      status: 'active' as const,
      text: 'Shared contract body.',
      uri: 'threadnote://user/test/memories/durable/projects/monorepo/search-contract.md',
    };
    const crossCandidate = {
      ...protectedCandidate,
      fields: {project: 'monorepo', topic: 'billing-contract', workspaceScope: 'apps/billing'},
      uri: 'threadnote://user/test/memories/durable/projects/monorepo/billing-contract.md',
    };
    const budgets = recallCrossScopeLaneBudgets(5);
    const admitted = mergeRecallCandidateLanes([topical], [[protectedCandidate]], [[crossCandidate]], budgets).slice(
      0,
      budgets.admissionLimit,
    );

    expect(EffectArray.map(admitted, candidate => candidate.uri)).toEqual(
      expect.arrayContaining([protectedCandidate.uri, crossCandidate.uri]),
    );
  });
  it('reserves a newest topical memory beyond a stale full window without consuming other lane reserves', () => {
    const staleTopical = Array.from({length: 125}, (_unused, index) => ({
      fields: {project: 'threadnote', title: 'Latest release status', topic: `release-status-${index}`},
      kind: 'handoff' as const,
      status: 'active' as const,
      text: 'Latest release status is complete.',
      timestamp: '2026-08-04T00:00:00.000Z',
      uri: `threadnote://user/test/memories/handoffs/active/threadnote/release-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
    }));
    const latest = {
      fields: {project: 'threadnote', title: 'Latest release status', topic: '4.2.7-release'},
      kind: 'handoff' as const,
      status: 'active' as const,
      text: 'Latest release status is complete.',
      timestamp: '2026-08-20T00:00:00.000Z',
      uri: 'threadnote://user/test/memories/handoffs/active/threadnote/4.2.7-release.md',
    };
    const laneCandidate = (lane: string) => ({
      fields: {project: 'threadnote', topic: `${lane}-operations`},
      text: `${lane} unrelated operations note.`,
      uri: `threadnote://user/test/memories/durable/projects/threadnote/${lane}.md`,
    });
    const protectedCandidate = laneCandidate('protected');
    const crossCandidate = laneCandidate('cross');
    const merged = mergeRecallCandidateLanes([staleTopical], [[protectedCandidate]], [[crossCandidate]], {
      admissionLimit: 100,
      crossScopeReserve: 4,
      protectedReserve: 16,
      recencyCandidateSets: [[latest]],
      recencyReserve: 10,
    });
    const admitted = merged.slice(0, 100);

    expect(EffectArray.map(admitted, candidate => candidate.uri)).toEqual(
      expect.arrayContaining([latest.uri, protectedCandidate.uri, crossCandidate.uri]),
    );
    const sections = buildRecallSections([], [], 10, {
      indexedCandidates: admitted,
      now: new Date('2026-08-20T12:00:00.000Z'),
      project: 'threadnote',
      query: 'latest release status',
    });
    expect(sections.ranked[0]?.uri).toBe(latest.uri);
    expect(
      Option.getOrElse(
        EffectArray.findFirstIndex(sections.ranked, hit => hit.uri === staleTopical[0].uri),
        () => -1,
      ),
    ).toBeGreaterThan(0);
  });
  fcEffectProp(
    effectIt,
    'keeps protected and cross-scope reserves independent throughout the bounded admission window',
    {
      crossCount: FC.integer({max: 12, min: 0}),
      protectedCount: FC.integer({max: 24, min: 0}),
      resultLimit: FC.integer({max: 12, min: 1}),
      topicalCount: FC.integer({max: 140, min: 100}),
    },
    ({crossCount, protectedCount, resultLimit, topicalCount}) =>
      Effect.sync(() => {
        const makeCandidate = (lane: string, index: number) => ({
          fields: {project: 'monorepo', topic: `${lane}-${index}`},
          text: 'Bounded candidate lane contract.',
          uri: `threadnote://user/test/memories/durable/projects/monorepo/${lane}-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
        });
        const topical = Array.from({length: topicalCount}, (_unused, index) => makeCandidate('topical', index));
        const protectedCandidates = Array.from({length: protectedCount}, (_unused, index) =>
          makeCandidate('protected', index),
        );
        const crossCandidates = Array.from({length: crossCount}, (_unused, index) => makeCandidate('cross', index));
        const budgets = recallCrossScopeLaneBudgets(resultLimit);
        const first = mergeRecallCandidateLanes([topical], [protectedCandidates], [crossCandidates], budgets);
        const second = mergeRecallCandidateLanes([topical], [protectedCandidates], [crossCandidates], budgets);
        const admittedUris = new Set(
          EffectArray.map(first.slice(0, budgets.admissionLimit), candidate => candidate.uri),
        );
        const expectedProtected = protectedCandidates.slice(0, budgets.protectedReserve);
        const expectedCross = crossCandidates.slice(0, budgets.crossScopeReserve);

        expect(EffectArray.every(expectedProtected, candidate => admittedUris.has(candidate.uri))).toBe(true);
        expect(EffectArray.every(expectedCross, candidate => admittedUris.has(candidate.uri))).toBe(true);
        expect(first).toEqual(second);
        expect(first.slice(0, budgets.admissionLimit)).toHaveLength(
          Math.min(budgets.admissionLimit, topicalCount + protectedCount + crossCount),
        );
      }),
    {fastCheck: {numRuns: 50}},
  );
  effectIt.effect('bounds one semantic retrieval attempt and interrupts only the timed-out work', () =>
    Effect.gen(function* () {
      let interrupted = 0;
      let invocations = 0;
      const retrieval = Effect.sync(() => {
        invocations += 1;
      }).pipe(
        Effect.andThen(Effect.sleep(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS + 1)),
        Effect.as('semantic-result'),
        Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
      );
      const fiber = yield* boundedRecallSemanticRetrieval(retrieval).pipe(Effect.forkChild);
      yield* TestClock.adjust(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS);
      expect(yield* Fiber.join(fiber)).toEqual({
        status: 'timed-out',
      });
      expect(invocations).toBe(1);
      expect(interrupted).toBe(1);
    }),
  );
  effectIt.effect('reports the first semantic failure without retrying it', () =>
    Effect.gen(function* () {
      const firstFailure = TestError.make({message: 'first semantic failure'});
      let invocations = 0;
      const result = yield* boundedRecallSemanticRetrieval(
        Effect.sync(() => {
          invocations += 1;
        }).pipe(Effect.andThen(Effect.fail(firstFailure))),
      );
      expect(result.status).toBe('failed');
      expect(result.status === 'failed' ? Cause.squash(result.cause) : undefined).toBe(firstFailure);
      expect(invocations).toBe(1);
    }),
  );
  effectIt.effect('preserves external semantic-retrieval cancellation', () =>
    Effect.gen(function* () {
      let invocations = 0;
      const fiber = yield* boundedRecallSemanticRetrieval(
        Effect.sync(() => {
          invocations += 1;
        }).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(invocations).toBe(1);
    }),
  );
  fcEffectProp(
    effectIt,
    'returns semantic work exactly when an arbitrary delay finishes inside the total budget',
    {
      delayMilliseconds: FC.oneof(
        FC.integer({
          max: MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS - 1,
          min: 0,
        }),
        FC.integer({
          max: MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS * 2,
          min: MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS + 1,
        }),
      ),
    },
    ({delayMilliseconds}) =>
      Effect.gen(function* () {
        let interrupted = 0;
        let invocations = 0;
        const retrieval = Effect.sync(() => {
          invocations += 1;
        }).pipe(
          Effect.andThen(Effect.sleep(delayMilliseconds)),
          Effect.as('semantic-result'),
          Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
        );
        const fiber = yield* boundedRecallSemanticRetrieval(retrieval).pipe(Effect.forkChild);
        yield* TestClock.adjust(Math.max(delayMilliseconds, MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS));
        const completedInsideBudget = delayMilliseconds < MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS;
        expect(yield* Fiber.join(fiber)).toEqual(
          completedInsideBudget
            ? {
                status: 'completed',
                value: 'semantic-result',
              }
            : {
                status: 'timed-out',
              },
        );
        expect(invocations).toBe(1);
        expect(interrupted).toBe(completedInsideBudget ? 0 : 1);
      }),
    {
      fastCheck: {
        numRuns: 40,
      },
    },
  );
  effectIt.effect('falls back predictably when serialized model work is contended', () =>
    Effect.gen(function* () {
      const inferencePermit = yield* Semaphore.make(1);
      const retrievalCount = 8;
      const workMilliseconds = 4_000;
      const completedCount = Math.min(
        retrievalCount,
        Math.floor((MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS - 1) / workMilliseconds),
      );
      let interrupted = 0;
      let invocations = 0;
      const retrievals = Array.from(
        {
          length: retrievalCount,
        },
        (_unused, index) =>
          boundedRecallSemanticRetrieval(
            Effect.sync(() => {
              invocations += 1;
            }).pipe(
              Effect.andThen(inferencePermit.withPermit(Effect.sleep(workMilliseconds).pipe(Effect.as(index)))),
              Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
            ),
          ),
      );
      const fiber = yield* Effect.all(retrievals, {
        concurrency: 'unbounded',
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS);
      const results = yield* Fiber.join(fiber);
      expect(EffectArray.filter(results, result => result.status === 'completed')).toHaveLength(completedCount);
      expect(EffectArray.filter(results, result => result.status === 'timed-out')).toHaveLength(
        retrievalCount - completedCount,
      );
      expect(invocations).toBe(retrievalCount);
      expect(interrupted).toBe(retrievalCount - completedCount);
      expect(yield* inferencePermit.withPermit(Effect.succeed('permit-released'))).toBe('permit-released');
    }),
  );
  effectIt.effect('reuses reranker scores across repeated prepare passes in one top-level recall', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-runtime-')));
      homes.push(home);
      const resource = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'runtime.md');
      yield* Effect.promise(() =>
        mkdir(join(resource, '..'), {
          recursive: true,
        }),
      );
      yield* Effect.promise(() => writeFile(resource, '# Runtime\n\nreranker cache anchor'));
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: join(home, 'seed-manifest.yaml'),
        user: 'tester',
      };
      const rerankerCache = createRecallRerankerCache();
      const prepare = () =>
        prepareRecallSections(config, {
          allowExactRescue: false,
          exactMatches: [],
          feedbackQuery: 'reranker cache anchor',
          includeInactive: false,
          limit: 5,
          passes: [],
          query: 'reranker cache anchor',
          readRecords: () => Effect.succeed([]),
          rerankerCache,
          semanticResult: Option.none(),
        });
      yield* Effect.all([prepare(), prepare()], {
        concurrency: 1,
      }).pipe(provideTestLayer(ApplicationLayer));
      expect(inference.rerank).toHaveBeenCalledTimes(1);
    }),
  );
  effectIt.effect('drops stale semantic scores when the ranked lexical snapshot has advanced', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-semantic-generation-')));
      homes.push(home);
      const resource = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'generation.md');
      yield* Effect.promise(() =>
        mkdir(join(resource, '..'), {
          recursive: true,
        }),
      );
      yield* Effect.promise(() => writeFile(resource, '# Generation one\n\nold semantic ranking anchor'));
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: join(home, 'seed-manifest.yaml'),
        user: 'tester',
      };
      const first = yield* loadRecallIndexData(config, {
        forceRefresh: true,
        includeInactive: false,
      }).pipe(provideTestLayer(ApplicationLayer));
      yield* Effect.promise(() => writeFile(resource, '# Generation two\n\ncurrent lexical ranking anchor'));
      const second = yield* loadRecallIndexData(config, {
        forceRefresh: true,
        includeInactive: false,
      }).pipe(provideTestLayer(ApplicationLayer));
      expect(second.generation).not.toBe(first.generation);
      const prepared = yield* prepareRecallSections(config, {
        allowExactRescue: false,
        exactMatches: [],
        feedbackQuery: 'ranking anchor',
        includeInactive: false,
        limit: 5,
        passes: [],
        query: 'ranking anchor',
        readRecords: () => Effect.succeed([]),
        semanticResult: Option.some({
          corpusGeneration: Option.some(first.generation),
          scores: Option.some(new Map([[first.candidates[0].uri, 1]])),
          warning: Option.none(),
        }),
      }).pipe(provideTestLayer(ApplicationLayer));
      expect(Option.isNone(prepared.semanticResult.corpusGeneration)).toBe(true);
      expect(Option.isNone(prepared.semanticResult.scores)).toBe(true);
    }),
  );
  effectIt.effect('keeps top-level lexical recall available when semantic inference dies', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-runtime-')));
      homes.push(home);
      const resource = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'fallback.md');
      yield* Effect.promise(() =>
        mkdir(join(resource, '..'), {
          recursive: true,
        }),
      );
      yield* Effect.promise(() =>
        writeFile(resource, '# Fallback\n\nlexical-fallback-anchor survives semantic failure'),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: join(home, 'seed-manifest.yaml'),
        user: 'tester',
      };
      const embedding = Option.getOrUndefined(
        EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'bge-small-en-v1.5-q8'),
      )!;
      const installation = {
        bytes: embedding.size,
        installed: true,
        modelId: embedding.id,
        partialBytes: 0,
        path: join(home, 'models', 'fake.gguf'),
        verified: true,
      };
      const storeLayer = Layer.succeed(
        LocalModelStore,
        LocalModelStore.of({
          install: () => Effect.die(TestError.make({message: 'Unexpected install'})),
          path: () => installation.path,
          remove: () => Effect.succeed(false),
          status: () => Effect.succeed(installation),
          verify: () => Effect.succeed(installation),
        } satisfies LocalModelStoreShape),
      );
      const failingRuntimeLayer = Layer.succeed(
        LocalModelRuntime,
        LocalModelRuntime.of({
          diagnostics: Effect.succeed({
            backend: 'fake',
            buildType: 'prebuilt',
            cpuMathCores: 4,
          }),
          embedMany: () => Effect.die(TestError.make({message: 'synthetic semantic runtime failure'})),
          generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
          rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
        }),
      );
      const recalled = yield* Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'embedding', embedding.id);
        return yield* captureConsole(
          runRecall(config, {
            inferScope: false,
            query: 'lexical-fallback-anchor',
            threshold: '0.1',
          }),
        );
      }).pipe(provideTestLayer(failingRuntimeLayer), provideTestLayer(storeLayer), provideTestLayer(ApplicationLayer));
      expect(recalled.output).toContain('fallback.md');
      expect(recalled.output).toContain('lexical-fallback-anchor');
      expect(recalled.output).toContain(
        'Local AI recall warning: semantic retrieval failed (SemanticRecallUnavailable)',
      );
    }),
  );
  effectIt.effect('preserves fallback hits and reports a real persistent lexical recovery failure', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-index-warning-')));
      homes.push(home);
      const lexicalRoot = join(home, 'indexes', 'lexical');
      yield* Effect.promise(() => mkdir(lexicalRoot, {recursive: true}));
      yield* Effect.promise(() =>
        writeFile(join(lexicalRoot, recallIndexDatabaseFilename(false)), 'not a sqlite database'),
      );
      yield* Effect.promise(() => writeFile(join(lexicalRoot, 'generations'), 'blocks index recovery'));
      const fallbackUri = 'threadnote://user/tester/memories/durable/projects/threadnote/file-fallback.md';
      const prepared = yield* prepareRecallSections(
        {
          account: 'local',
          agentContextHome: home,
          user: 'tester',
        },
        {
          allowExactRescue: false,
          exactMatches: [],
          feedbackQuery: 'file fallback anchor',
          includeInactive: false,
          limit: 5,
          passes: [
            [
              {
                category: 'memories',
                contextType: 'memory',
                score: 1,
                snippet: 'File fallback anchor remains available.',
                uri: fallbackUri,
              },
            ],
          ],
          query: 'file fallback anchor',
          readRecords: () =>
            Effect.succeed([
              {
                body: 'File fallback anchor remains available.',
                content:
                  'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: file-fallback\n\nFile fallback anchor remains available.',
                headerTitle: 'MEMORY',
                metadata: {
                  kind: 'durable',
                  project: 'threadnote',
                  sourceAgentClient: 'test',
                  status: 'active',
                  timestamp: '2026-07-23T00:00:00.000Z',
                  topic: 'file-fallback',
                },
                uri: fallbackUri,
              },
            ]),
          semanticResult: Option.none(),
        },
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(EffectArray.map(prepared.ranked, hit => hit.uri)).toContain(fallbackUri);
      expect(prepared.operationalWarnings).toEqual([expect.objectContaining({code: 'lexical_index_unavailable'})]);
    }),
  );
  effectIt.effect('distinguishes empty record hydration from a loaded set that omits a memory URI', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-empty-records-')));
      homes.push(home);
      const presentUri = 'threadnote://user/tester/memories/durable/projects/threadnote/present-ranked.md';
      const ghostUri = 'threadnote://user/tester/memories/durable/projects/threadnote/ghost-ranked.md';
      const presentRecord = {
        body: 'Present ranked memory body remains available.',
        content:
          'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: present-ranked\n\nPresent ranked memory body remains available.',
        headerTitle: 'MEMORY' as const,
        metadata: {
          kind: 'durable' as const,
          project: 'threadnote',
          sourceAgentClient: 'test',
          status: 'active' as const,
          timestamp: '2026-07-23T00:00:00.000Z',
          topic: 'present-ranked',
        },
        uri: presentUri,
      };
      const memoryHit = (uri: string) => ({
        category: 'memories' as const,
        contextType: 'memory' as const,
        score: 1,
        snippet: 'Present ranked memory body remains available.',
        uri,
      });
      const config = {
        account: 'local',
        agentContextHome: home,
        user: 'tester',
      };
      const emptyHydration = yield* prepareRecallSections(config, {
        allowExactRescue: false,
        exactMatches: [],
        feedbackQuery: 'Present ranked memory body',
        includeInactive: false,
        limit: 5,
        passes: [[memoryHit(presentUri)]],
        query: 'Present ranked memory body',
        readRecords: () => Effect.succeed([]),
        semanticResult: Option.none(),
      }).pipe(provideTestLayer(ApplicationLayer));
      const loadedMissing = yield* prepareRecallSections(config, {
        allowExactRescue: false,
        exactMatches: [],
        feedbackQuery: 'Present ranked memory body',
        includeInactive: false,
        limit: 5,
        passes: [[memoryHit(ghostUri)]],
        query: 'Present ranked memory body',
        readRecords: () => Effect.succeed([presentRecord]),
        semanticResult: Option.none(),
      }).pipe(provideTestLayer(ApplicationLayer));

      expect(EffectArray.map(emptyHydration.ranked, ranked => ranked.uri)).toContain(presentUri);
      expect(EffectArray.map(loadedMissing.ranked, ranked => ranked.uri)).not.toContain(ghostUri);
    }),
  );
  effectIt.effect('drops an indexed memory when extra record hydration misses an empty store', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-stale-lexical-')));
      homes.push(home);
      const ghostUri = 'threadnote://user/tester/memories/durable/projects/threadnote/stale-lexical-ghost.md';
      const sentinel = 'STALE-LEXICAL-GHOST-847291056';
      const memoryRoot = join(home, 'data', 'local', 'user', 'tester', 'memories', 'durable', 'projects', 'threadnote');
      const ghostPath = join(memoryRoot, 'stale-lexical-ghost.md');
      yield* Effect.promise(() => mkdir(memoryRoot, {recursive: true}));
      yield* Effect.promise(() =>
        writeFile(
          ghostPath,
          EffectArray.join(
            [
              'MEMORY',
              'kind: durable',
              'status: active',
              'project: threadnote',
              'topic: stale-lexical-ghost',
              'source_agent_client: test',
              'timestamp: 2026-07-30T00:00:00.000Z',
              '',
              '# Stale lexical ghost',
              '',
              sentinel,
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: join(home, 'seed-manifest.yaml'),
        user: 'tester',
      };
      yield* loadRecallIndex(config, {
        forceRefresh: true,
        includeInactive: false,
        query: sentinel,
      }).pipe(provideTestLayer(ApplicationLayer));
      yield* Effect.promise(() => rm(ghostPath, {force: true}));
      const prepared = yield* prepareRecallSections(config, {
        allowExactRescue: false,
        exactMatches: [],
        feedbackQuery: sentinel,
        includeInactive: false,
        limit: 5,
        passes: [
          [
            {
              category: 'memories',
              contextType: 'memory',
              score: 1,
              snippet: sentinel,
              uri: ghostUri,
            },
          ],
        ],
        query: sentinel,
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        semanticResult: Option.none(),
      }).pipe(provideTestLayer(ApplicationLayer));

      expect(EffectArray.map(prepared.ranked, ranked => ranked.uri)).not.toContain(ghostUri);
    }),
  );
  effectIt.effect('surfaces one CLI warning when exact and ranked lexical recovery both fail', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-cli-index-warning-')));
      homes.push(home);
      const lexicalRoot = join(home, 'indexes', 'lexical');
      yield* Effect.promise(() => mkdir(lexicalRoot, {recursive: true}));
      yield* Effect.promise(() =>
        writeFile(join(lexicalRoot, recallIndexDatabaseFilename(false)), 'not a sqlite database'),
      );
      yield* Effect.promise(() => writeFile(join(lexicalRoot, 'generations'), 'blocks index recovery'));
      const recalled = yield* captureConsole(
        runRecall(
          {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath: join(home, 'seed-manifest.yaml'),
            user: 'tester',
          },
          {
            inferScope: false,
            query: 'degraded lexical exact anchor 7788',
            threshold: '0.1',
          },
        ),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(
        Effect2.pipe(
          recalled.output,
          EffectString.match(/Recall index warning:/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(1);
      expect(recalled.output).toContain('could not be read or recovered');
      expect(recalled.output).toContain('threadnote doctor --dry-run');
    }),
  );
  effectIt.effect('uses a complete ranked expansion vocabulary without opening the lexical index', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-expansion-ranked-')));
      homes.push(root);
      const blockedHome = join(root, 'not-a-directory');
      yield* Effect.promise(() => writeFile(blockedHome, 'opening the lexical index would fail'));
      const candidates = Array.from(
        {
          length: 50,
        },
        (_unused, index) => ({
          fields: {
            project: 'threadnote',
            topic: `topic-${index}`,
          },
          kind: 'durable' as const,
          text: `description ${index}`,
          uri: `threadnote://user/tester/memories/durable/projects/threadnote/topic-${index}.md`,
        }),
      );
      const vocabulary = yield* loadRecallExpansionVocabulary(
        {
          account: 'local',
          agentContextHome: blockedHome,
          user: 'tester',
        },
        {
          includeInactive: false,
          project: 'threadnote',
          rankedCandidates: candidates,
        },
      ).pipe(provideTestLayer(ApplicationLayer));
      expect(vocabulary).toHaveLength(50);
      expect(vocabulary[0]).toContain('topic-0');
    }),
  );
  effectIt.effect('keeps ranked scope precedence and project fallback deterministic beyond the sample limit', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-expansion-project-sample-')));
      homes.push(home);
      const resourcesRoot = join(home, 'data', 'local', 'resources', 'repos');
      const targetRoot = join(resourcesRoot, 'threadnote');
      const outsideRoot = join(resourcesRoot, 'outside');
      yield* Effect.promise(() =>
        mkdir(targetRoot, {
          recursive: true,
        }),
      );
      yield* Effect.promise(() =>
        mkdir(outsideRoot, {
          recursive: true,
        }),
      );
      const targetPaths = [join(targetRoot, 'target-old-one.md'), join(targetRoot, 'target-old-two.md')];
      yield* Effect.promise(() =>
        Promise.all(EffectArray.map(targetPaths, path => writeFile(path, `# Target\n\n${path}`))),
      );
      yield* Effect.promise(() =>
        Promise.all(
          Array.from(
            {
              length: 225,
            },
            (_unused, index) =>
              writeFile(
                join(outsideRoot, `outside-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`),
                `# Outside ${index}`,
              ),
          ),
        ),
      );
      const oldTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'));
      yield* Effect.promise(() =>
        Promise.all(EffectArray.map(targetPaths, path => utimes(path, oldTimestamp, oldTimestamp))),
      );
      const hiddenMemory = join(
        home,
        'data',
        'local',
        'user',
        'tester',
        'memories',
        'durable',
        'projects',
        'threadnote',
        'hidden-memory.md',
      );
      yield* Effect.promise(() =>
        mkdir(join(hiddenMemory, '..'), {
          recursive: true,
        }),
      );
      yield* Effect.promise(() =>
        writeFile(
          hiddenMemory,
          EffectArray.join(
            [
              'MEMORY',
              'kind: durable',
              'status: active',
              'project: threadnote',
              'topic: hidden-memory-topic',
              'source_agent_client: codex',
              'timestamp: 2026-07-28T00:00:00.000Z',
              '',
              'Must remain outside the resource-only fallback scope.',
            ],
            '\n',
          ),
        ),
      );
      const config = {
        account: 'local',
        agentContextHome: home,
        user: 'tester',
      };
      yield* loadRecallIndex(config, {
        forceRefresh: true,
        includeInactive: false,
      }).pipe(provideTestLayer(ApplicationLayer));
      const input = {
        allowedUriScopes: ['threadnote://resources/repos//#ignored'],
        includeInactive: false,
        project: 'threadnote',
        rankedCandidates: [
          {
            fields: {
              project: 'threadnote',
              topic: 'ranked-priority',
            },
            kind: 'durable' as const,
            text: 'ranked candidate',
            uri: 'threadnote://resources/repos/threadnote/ranked.md#heading',
          },
          {
            fields: {
              project: 'threadnote',
              topic: 'hidden-ranked',
            },
            kind: 'durable' as const,
            text: 'out of scope ranked candidate',
            uri: 'threadnote://user/tester/memories/durable/projects/threadnote/hidden-ranked.md',
          },
        ],
      };
      const first = yield* loadRecallExpansionVocabulary(config, input).pipe(provideTestLayer(ApplicationLayer));
      const second = yield* loadRecallExpansionVocabulary(config, input).pipe(provideTestLayer(ApplicationLayer));
      expect(second).toEqual(first);
      expect(first[0]).toContain('ranked-priority');
      expect(EffectArray.some(first, term => Effect2.pipe(term, EffectString.includes('target-old-one')))).toBe(true);
      expect(EffectArray.some(first, term => Effect2.pipe(term, EffectString.includes('target-old-two')))).toBe(true);
      expect(EffectArray.some(first, term => Effect2.pipe(term, EffectString.includes('outside-')))).toBe(false);
      expect(
        EffectArray.some(
          first,
          term =>
            Effect2.pipe(term, EffectString.includes('hidden-memory-topic')) ||
            Effect2.pipe(term, EffectString.includes('hidden-ranked')),
        ),
      ).toBe(false);
    }),
  );
});
