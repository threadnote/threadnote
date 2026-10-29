import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Cause, Effect, Exit, Fiber, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import {describe} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {
  boundedRecallCandidateSelection,
  boundedRecallExpansionScopes,
  expandRecallQueryEffect,
  expandWeakRecallQueryEffect,
  isLoopbackAiEndpoint,
  limitRecallRewritesForConfidence,
  mergeRecallRewritesForConfidence,
  normalizeRecallCandidateSelection,
  normalizeRecallRewrites,
  RecallCandidateSelector,
  RECALL_SELECTION_TIMEOUT_MILLISECONDS,
  recallHybridMinimumScore,
  RecallQueryExpander,
  selectRecallCandidatesWithJev,
  selectRecallCandidatesEffect,
  selectExpandedRecallCandidatesEffect,
  shouldExpandRecall,
} from '@threadnote/threadnote/effect/ai/recall';
import {
  jevConfiguration,
  runJevRecallCandidateSelection,
  type JevTransport,
} from '@threadnote/threadnote/effect/ai/jev';
import {selectedRecallCandidateUris} from '@threadnote/recall/runtime';
import {recallScoreThresholdPolicy, validatedRecallScoreThreshold} from '@threadnote/recall/threshold';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('Effect AI recall expansion', () => {
  const enforcedJev = jevConfiguration({
    THREADNOTE_DECISION_PROVIDER: 'jev',
    THREADNOTE_JEV_MODE: 'enforced',
    THREADNOTE_JEV_MODEL: 'jev-1.13.0',
    TYPESAFE_API_KEY: 'test-key',
  });
  if (!enforcedJev) throw new Error('The enforced Jev fixture configuration was not accepted.');

  it('only expands weak deterministic recalls', () => {
    expect(shouldExpandRecall({level: 'no_answer'})).toBe(true);
    expect(shouldExpandRecall({level: 'low'})).toBe(true);
    expect(shouldExpandRecall({level: 'medium'})).toBe(true);
    expect(shouldExpandRecall({level: 'high'})).toBe(false);
    expect(shouldExpandRecall(undefined)).toBe(false);
  });

  it('keeps at most two unique, bounded rewrites and drops the original query', () => {
    expect(
      normalizeRecallRewrites('where is the QX7 lease handled', [
        ' QX7 worker lease coordinator ',
        'where is the QX7 lease handled',
        'qx7 worker lease coordinator',
        'heartbeat renewal configuration',
        'ignored third rewrite',
        Effect2.pipe('x', EffectString.repeat(700)),
      ]),
    ).toEqual(['QX7 worker lease coordinator', 'heartbeat renewal configuration']);
  });

  it('drops locally grounded rewrites that ignore the supplied project vocabulary', () => {
    expect(
      normalizeRecallRewrites(
        'How do preview builds get upgraded?',
        [
          'upgrade-preview-builds-threadnote',
          'beta-update-channel prerelease upgrades',
          'release-process :: stable release workflow',
        ],
        ['beta-update-channel :: beta update and prerelease contract', 'release-process :: stable release workflow'],
      ),
    ).toEqual(['beta-update-channel', 'release-process']);
  });

  it('does not accept a vocabulary term embedded in a different word', () => {
    expect(normalizeRecallRewrites('share behavior', ['shared repository'], ['share'])).toEqual([]);
  });

  it('uses only the first search scope for expansion', () => {
    expect(
      boundedRecallExpansionScopes([
        undefined,
        'threadnote://user/me/memories/durable/projects/threadnote',
        undefined,
        'threadnote://resources/repos/threadnote',
        'threadnote://resources/repos/atlas-cache',
      ]),
    ).toEqual([undefined]);
  });

  it('uses one rewrite for medium confidence and two for weaker recall', () => {
    const rewrites = ['first', 'second'];
    expect(limitRecallRewritesForConfidence({level: 'medium'}, rewrites)).toEqual(['first']);
    expect(limitRecallRewritesForConfidence({level: 'low'}, rewrites)).toEqual(rewrites);
    expect(limitRecallRewritesForConfidence({level: 'no_answer'}, rewrites)).toEqual(rewrites);
    expect(mergeRecallRewritesForConfidence({level: 'low'}, ['grounded'], [' Grounded ', 'fallback'])).toEqual([
      'grounded',
      'fallback',
    ]);
  });

  it('uses the resolved default, environment, or explicit threshold without a hidden hybrid override', () => {
    expect(recallHybridMinimumScore(0.3)).toBe(0.3);
    expect(recallHybridMinimumScore(0.45)).toBe(0.45);
    expect(recallHybridMinimumScore(0.9)).toBe(0.9);
  });

  it('validates explicit recall thresholds on the same 0-1 scale', () => {
    expect(validatedRecallScoreThreshold(' 0.45 ', '--threshold')).toBe('0.45');
    expect(() => validatedRecallScoreThreshold('NaN', '--threshold')).toThrow(
      '--threshold must be a number from 0 to 1',
    );
    expect(() => validatedRecallScoreThreshold('1.1', '--threshold')).toThrow(
      '--threshold must be a number from 0 to 1',
    );
  });

  it.effect('honors a valid environment threshold and rejects an invalid one', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const configuredSystem = SystemInfo.of({
        ...system,
        environment: () => ({...system.environment(), THREADNOTE_RECALL_THRESHOLD: '0.67'}),
      });
      expect(yield* recallScoreThresholdPolicy().pipe(Effect.provideService(SystemInfo, configuredSystem))).toEqual({
        source: 'environment',
        value: '0.67',
      });

      const invalidSystem = SystemInfo.of({
        ...system,
        environment: () => ({...system.environment(), THREADNOTE_RECALL_THRESHOLD: 'not-a-number'}),
      });
      const error = yield* recallScoreThresholdPolicy().pipe(
        Effect.provideService(SystemInfo, invalidSystem),
        Effect.flip,
      );
      expect(error.message).toContain('THREADNOTE_RECALL_THRESHOLD must be a number from 0 to 1');
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  it('only treats explicit loopback Effect AI endpoints as local', () => {
    expect(isLoopbackAiEndpoint('http://127.0.0.1:8081/v1')).toBe(true);
    expect(isLoopbackAiEndpoint('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackAiEndpoint('https://models.example.com/v1')).toBe(false);
    expect(isLoopbackAiEndpoint(undefined)).toBe(false);
  });

  it('keeps only known, unique candidate IDs and supports a confident empty selection', () => {
    const candidates = [
      {id: 'c1', summary: 'first', uri: 'threadnote://first'},
      {id: 'c2', summary: 'second', uri: 'threadnote://second'},
    ];
    expect(
      normalizeRecallCandidateSelection({candidateIds: ['c2', 'unknown', 'c2'], relevant: true}, candidates),
    ).toEqual(['c2']);
    expect(normalizeRecallCandidateSelection({candidateIds: [], relevant: false}, candidates)).toEqual([]);
    expect(() => normalizeRecallCandidateSelection({candidateIds: ['unknown'], relevant: true}, candidates)).toThrow(
      'no known candidate IDs',
    );
    const manyCandidates = Array.from({length: 12}, (_unused, index) => ({
      id: `c${index + 1}`,
      summary: `candidate ${index + 1}`,
      uri: `threadnote://candidate-${index + 1}`,
    }));
    expect(
      normalizeRecallCandidateSelection(
        {candidateIds: EffectArray.map(manyCandidates, candidate => candidate.id), relevant: true},
        manyCandidates,
      ),
    ).toHaveLength(8);
  });

  it.effect('keeps application code provider-independent', () =>
    expandRecallQueryEffect({project: 'threadnote', query: 'how do beta updates differ'}).pipe(
      provideTestLayer(
        Layer.succeed(RecallQueryExpander, {
          expand: ({query}) => Effect.succeed([`rewrite:${query}`]),
        }),
      ),
      Effect.tap(rewrites => Effect.sync(() => expect(rewrites).toEqual(['rewrite:how do beta updates differ']))),
    ),
  );

  it.effect('keeps candidate selection provider-independent', () =>
    selectRecallCandidatesEffect({
      candidates: [{id: 'c1', summary: 'release channel', uri: 'threadnote://release'}],
      query: 'preview release updates',
    }).pipe(
      provideTestLayer(
        Layer.succeed(RecallCandidateSelector, {
          select: () => Effect.succeed(['c1']),
        }),
      ),
      Effect.tap(selected => Effect.sync(() => expect(selected).toEqual(['c1']))),
    ),
  );

  it.effect('does not auto-load an optional generation model for ordinary recall', () =>
    Effect.gen(function* () {
      expect(
        yield* expandWeakRecallQueryEffect(
          {confidence: {level: 'no_answer'}, query: 'missing memory'},
          {agentContextHome: '/unused'},
          undefined,
        ),
      ).toEqual([]);
      expect(
        yield* selectExpandedRecallCandidatesEffect(
          {
            candidates: [{id: 'c1', summary: 'candidate', uri: 'threadnote://candidate'}],
            query: 'missing memory',
          },
          {agentContextHome: '/unused'},
          undefined,
        ),
      ).toBeUndefined();
    }),
  );

  it.effect('enforces a valid empty Jev decision while downstream anchors stay protected', () =>
    selectRecallCandidatesWithJev(
      Effect.succeed(['a']),
      {candidates: [{id: 'a', summary: 'anchor', uri: 'threadnote://a'}], query: 'query'},
      enforcedJev,
      undefined,
      () =>
        Effect.succeed({
          receipt: {
            candidateCount: 1,
            fallback: 'none',
            mode: 'enforced',
            model: 'jev-1.13.0',
            outcome: 'empty',
            selectedCount: 0,
          },
          selectedIds: [],
        }),
    ).pipe(
      Effect.tap(selected =>
        Effect.sync(() => {
          expect(selected).toEqual([]);
          expect(
            selectedRecallCandidateUris([{id: 'a', summary: 'anchor', uri: 'threadnote://a'}], selected ?? [], ['a']),
          ).toEqual(['threadnote://a']);
          expect(
            selectedRecallCandidateUris([{id: 'a', summary: 'anchor', uri: 'threadnote://a'}], selected ?? []),
          ).toEqual([]);
        }),
      ),
    ),
  );

  it.effect('uses one shared Jev deadline, keeps a completed baseline, and emits one timeout receipt', () =>
    Effect.gen(function* () {
      let interrupted = 0;
      const receipts: unknown[] = [];
      const selection = selectRecallCandidatesWithJev(
        Effect.sleep(4_000).pipe(Effect.as(['baseline'])),
        {candidates: [{id: 'a', summary: 'candidate', uri: 'threadnote://a'}], query: 'query'},
        enforcedJev,
        receipt => Effect.sync(() => receipts.push(receipt)),
        () =>
          Effect.sleep(2_000).pipe(
            Effect.as({
              receipt: {
                candidateCount: 1,
                fallback: 'none',
                mode: 'enforced',
                model: 'jev-1.13.0',
                outcome: 'accepted',
                selectedCount: 1,
              } as const,
              selectedIds: ['a'] as const,
            }),
            Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
          ),
      );
      const fiber = yield* selection.pipe(Effect.forkChild);
      yield* TestClock.adjust(RECALL_SELECTION_TIMEOUT_MILLISECONDS);
      expect(yield* Fiber.join(fiber)).toEqual(['baseline']);
      expect(interrupted).toBe(1);
      expect(receipts).toEqual([
        expect.objectContaining({fallback: 'timeout', outcome: 'provider-failure', selectedCount: 0}),
      ]);
    }),
  );

  it.effect('fails open with one receipt when a 2xx Jev response is malformed', () => {
    const receipts: unknown[] = [];
    const transport: JevTransport = {
      post: () =>
        Effect.succeed({
          body: {answers: {}, model: 'jev-1.13.0', usage: {input_tokens: 1, output_tokens: 1}},
          status: 200,
        }),
    };
    return selectRecallCandidatesWithJev(
      Effect.succeed(['baseline']),
      {candidates: [{id: 'a', summary: 'candidate', uri: 'threadnote://a'}], query: 'query'},
      enforcedJev,
      receipt => Effect.sync(() => receipts.push(receipt)),
      (input, config) => runJevRecallCandidateSelection(input, config, transport),
    ).pipe(
      Effect.tap(selected =>
        Effect.sync(() => {
          expect(selected).toEqual(['baseline']);
          expect(receipts).toEqual([
            expect.objectContaining({fallback: 'provider-failure', outcome: 'provider-failure', selectedCount: 0}),
          ]);
        }),
      ),
    );
  });

  it.effect('preserves external interruption of the shared Jev selection', () =>
    Effect.gen(function* () {
      const fiber = yield* selectRecallCandidatesWithJev(
        Effect.succeed(['baseline']),
        {candidates: [{id: 'a', summary: 'candidate', uri: 'threadnote://a'}], query: 'query'},
        enforcedJev,
        undefined,
        () => Effect.never,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }),
  );

  it.effect('bounds the actual candidate selection and invokes it only once', () =>
    Effect.gen(function* () {
      let interrupted = 0;
      let invocations = 0;
      const selection = Effect.sync(() => {
        invocations += 1;
      }).pipe(
        Effect.andThen(Effect.sleep(RECALL_SELECTION_TIMEOUT_MILLISECONDS + 1)),
        Effect.as(['c1'] as const),
        Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
      );
      const fiber = yield* boundedRecallCandidateSelection(selection).pipe(Effect.forkChild);

      yield* TestClock.adjust(RECALL_SELECTION_TIMEOUT_MILLISECONDS);

      expect(yield* Fiber.join(fiber)).toBeUndefined();
      expect(invocations).toBe(1);
      expect(interrupted).toBe(1);
    }),
  );

  it.effect('preserves external cancellation instead of treating it as a selection timeout', () =>
    Effect.gen(function* () {
      let invocations = 0;
      const selection = Effect.sync(() => {
        invocations += 1;
      }).pipe(Effect.andThen(Effect.never));
      const fiber = yield* boundedRecallCandidateSelection(selection).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(invocations).toBe(1);
    }),
  );

  fcEffectProp(
    it,
    'returns a candidate selection exactly when arbitrary work finishes inside the budget',
    {
      delayMilliseconds: FC.oneof(
        FC.integer({max: RECALL_SELECTION_TIMEOUT_MILLISECONDS - 1, min: 0}),
        FC.integer({
          max: RECALL_SELECTION_TIMEOUT_MILLISECONDS * 2,
          min: RECALL_SELECTION_TIMEOUT_MILLISECONDS + 1,
        }),
      ),
    },
    ({delayMilliseconds}) =>
      Effect.gen(function* () {
        let interrupted = 0;
        let invocations = 0;
        const selection = Effect.sync(() => {
          invocations += 1;
        }).pipe(
          Effect.andThen(Effect.sleep(delayMilliseconds)),
          Effect.as(['c1'] as const),
          Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
        );
        const fiber = yield* boundedRecallCandidateSelection(selection).pipe(Effect.forkChild);

        yield* TestClock.adjust(Math.max(delayMilliseconds, RECALL_SELECTION_TIMEOUT_MILLISECONDS));

        const completedInsideBudget = delayMilliseconds < RECALL_SELECTION_TIMEOUT_MILLISECONDS;
        expect(yield* Fiber.join(fiber)).toEqual(completedInsideBudget ? ['c1'] : undefined);
        expect(invocations).toBe(1);
        expect(interrupted).toBe(completedInsideBudget ? 0 : 1);
      }),
    {fastCheck: {numRuns: 40}},
  );
});
