import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, Fiber, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import type {ReadDeadline} from '@threadnote/platform/read_deadline';
import {compileContextBriefWith} from '../../src/compiler.js';
import {unavailableContextBriefGraphEvidence} from '../../src/graph/evidence.js';
import {projectContextBrief} from '../../src/projector.js';
import type {
  ContextBriefLogicalResultV1,
  ContextBriefMemoryCandidateV1,
  ContextBriefMemoryRetrievalV1,
} from '../../src/types.js';

const candidate: ContextBriefMemoryCandidateV1 = {
  kind: 'durable',
  uri: 'threadnote://user/test/memories/durable/projects/threadnote/deadline.md',
  citationErrorCount: 0,
  codeCitations: [],
  excerpt: 'Keep useful completed memory evidence when graph work expires.',
  rank: 0,
  topic: 'read-deadline',
};
const memory = (value = candidate): ContextBriefMemoryRetrievalV1 => ({
  candidates: [value],
  consideredCandidates: 1,
  gaps: [],
  trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
});
const request = {
  budgetTokens: 1250,
  mode: 'locate',
  responseFormat: 'dual',
  scope: {kind: 'repository', callerCwd: '/workspace/threadnote'},
  task: 'Locate read deadline contracts.',
} as const;

const cited = {
  ...candidate,
  codeCitations: [
    {
      version: 1 as const,
      id: 'citation-test',
      path: 'src/deadline.ts',
      repositoryId: 'repository',
      repositoryIdentityKind: 'remote' as const,
      sourceCommit: 'commit',
      sourceDirty: false,
      sourceSnapshotId: 'snapshot',
      extractorSet: 'extractor',
      fileContentHash: {algorithm: 'sha256' as const, value: EffectString.repeat(64)('a')},
      target: {kind: 'file' as const},
    },
  ],
};

describe('Context Brief shared elapsed budgets', () => {
  effectIt.effect('shares the graph deadline with citation validation and preserves unknown proof on expiry', () =>
    Effect.gen(function* () {
      let graphDeadline: ReadDeadline | undefined;
      let citationDeadline: ReadDeadline | undefined;
      let completed = false;
      let logical: ContextBriefLogicalResultV1 | undefined;
      const fiber = yield* compileContextBriefWith(
        {
          graphEvidence: (_plan, budget) =>
            Effect.gen(function* () {
              graphDeadline = budget?.deadline;
              yield* Effect.sleep(4000);
              return unavailableContextBriefGraphEvidence('graph-ready-snapshot-missing', 1);
            }),
          memoryEvidence: () => Effect.succeed(memory(cited)),
          citationValidation: (_scope, _candidates, _fence, deadline) =>
            Effect.gen(function* () {
              citationDeadline = deadline;
              yield* Effect.sleep(2000);
              completed = true;
              return [];
            }),
          projection: (value, budget, format) =>
            Effect.sync(() => {
              logical = value;
              return projectContextBrief(value, budget, format);
            }),
        },
        request,
      ).pipe(Effect.forkScoped);
      yield* TestClock.adjust(5000);
      yield* Fiber.join(fiber);
      expect(graphDeadline).toBeDefined();
      expect(citationDeadline).toBe(graphDeadline);
      expect(completed).toBe(false);
      expect(logical?.durableDecisions[0]?.citationSummary).toMatchObject({
        coverage: 'incomplete',
        exact: 0,
        unknown: 1,
      });
      expect(logical?.durableDecisions[0]?.citationReceipts?.[0]?.reason).toBe('citation-limit');
    }),
  );

  effectIt.effect('runs one postgraph memory read bound to completed lexical evidence and the original deadline', () =>
    Effect.gen(function* () {
      const fence = {kind: 'repository' as const, repositoryId: 'repository', snapshotId: 'snapshot'};
      const lexical = memory();
      const merged = {...lexical, citationValidations: []};
      let graphDeadline: ReadDeadline | undefined;
      let compositeCalls = 0;
      yield* compileContextBriefWith(
        {
          graphEvidence: (_plan, budget) =>
            Effect.sync(() => {
              graphDeadline = budget?.deadline;
              return {
                ...unavailableContextBriefGraphEvidence('graph-ready-snapshot-missing', 1),
                citationValidationFence: fence,
              };
            }),
          memoryEvidence: () => Effect.succeed(lexical),
          codeLinkedMemoryEvidence: () => Effect.die('Must not start a separate linked read'),
          citationValidation: () => Effect.die('Must not validate the same set twice'),
          memoryEvidenceAfterGraph: (plan, actualLexical, actualFence, deadline) =>
            Effect.sync(() => {
              compositeCalls += 1;
              expect(plan.codeAnchors.codeRefs).toEqual(['src/deadline.ts']);
              expect(actualLexical).toBe(lexical);
              expect(actualFence).toBe(fence);
              expect(deadline).toBe(graphDeadline);
              return merged;
            }),
        },
        {...request, codeRefs: ['src/deadline.ts']},
      );
      expect(compositeCalls).toBe(1);
    }),
  );

  effectIt.effect(
    'postgraph expiry retains completed graph and lexical evidence within the original five seconds',
    () =>
      Effect.gen(function* () {
        let graphDeadline: ReadDeadline | undefined;
        let logical: ContextBriefLogicalResultV1 | undefined;
        let completed = false;
        const fiber = yield* compileContextBriefWith(
          {
            graphEvidence: (_plan, budget) =>
              Effect.gen(function* () {
                graphDeadline = budget?.deadline;
                yield* Effect.sleep(4000);
                return unavailableContextBriefGraphEvidence('retained-completed-graph', 1);
              }),
            memoryEvidence: () => Effect.succeed(memory()),
            codeLinkedMemoryEvidence: () => Effect.die('Must not start a separate linked read'),
            citationValidation: () => Effect.die('Expired composite cannot start another citation worker'),
            memoryEvidenceAfterGraph: (_plan, _lexical, _fence, deadline) =>
              Effect.gen(function* () {
                expect(deadline).toBe(graphDeadline);
                yield* Effect.sleep(2000);
                completed = true;
                return memory({...candidate, uri: 'threadnote://late-worker-result'});
              }),
            projection: (value, budget, format) =>
              Effect.sync(() => {
                logical = value;
                return projectContextBrief(value, budget, format);
              }),
          },
          {...request, codeRefs: ['src/deadline.ts']},
        ).pipe(Effect.forkScoped);
        yield* TestClock.adjust(5000);
        yield* Fiber.join(fiber);
        expect(completed).toBe(false);
        expect(logical?.durableDecisions[0]?.uri).toBe(candidate.uri);
        expect(logical?.coverage.gaps).toContain('retained-completed-graph');
        expect(logical?.coverage.gaps).toContain('code-anchor-read-budget-exhausted');
      }),
  );

  effectIt.effect('a changed postgraph fence revalidates the exact merged candidate set', () =>
    Effect.gen(function* () {
      const fences = [
        {kind: 'repository' as const, repositoryId: 'repository', snapshotId: 'before'},
        {kind: 'repository' as const, repositoryId: 'repository', snapshotId: 'after'},
      ];
      const merged = {...memory(cited), citationValidations: []};
      let graphReads = 0;
      let validations = 0;
      yield* compileContextBriefWith(
        {
          graphEvidence: plan =>
            Effect.sync(() => {
              const fence = fences[graphReads++];
              return {
                ...unavailableContextBriefGraphEvidence('fixture', 1),
                citationValidationFence: fence,
                resolvedSnapshots: [
                  {
                    commit: 'commit',
                    dirty: false,
                    freshness: 'fresh' as const,
                    repositoryId: 'repository',
                    repositoryKey: 'repo',
                    snapshotId: fence.snapshotId,
                  },
                ],
                cards: EffectArray.map(plan.codeRefs, (path, rank) => ({
                  id: 'card',
                  rank,
                  reason: 'fixture',
                  ref: path,
                  repositoryKey: 'repo',
                  symbol: {kind: 'module', language: 'typescript', line: 1, name: path, path, qualifiedName: path},
                })),
              };
            }),
          memoryEvidence: () => Effect.succeed(memory(cited)),
          memoryEvidenceAfterGraph: (_plan, _lexical, fence) =>
            Effect.sync(() => {
              expect(fence).toBe(fences[0]);
              return merged;
            }),
          citationValidation: (_scope, candidates, fence) =>
            Effect.sync(() => {
              validations += 1;
              expect(candidates).toBe(merged.candidates);
              expect(fence).toBe(fences[1]);
              return [];
            }),
        },
        {...request, mode: 'brief', task: 'read deadline'},
      );
      expect(graphReads).toBe(2);
      expect(validations).toBe(1);
    }),
  );

  effectIt.effect('a workset graph cannot erase completed memory evidence after the same five second deadline', () =>
    Effect.gen(function* () {
      let logical: ContextBriefLogicalResultV1 | undefined;
      const fiber = yield* compileContextBriefWith(
        {
          graphEvidence: () => Effect.never,
          memoryEvidence: () => Effect.sleep(1000).pipe(Effect.as(memory())),
          projection: (value, budget, format) =>
            Effect.sync(() => {
              logical = value;
              return projectContextBrief(value, budget, format);
            }),
        },
        {...request, scope: {kind: 'workset', name: 'linked-worktrees'}},
      ).pipe(Effect.forkScoped);
      yield* TestClock.adjust(5000);
      yield* Fiber.join(fiber);
      expect(logical?.coverage.gaps).toContain('graph-read-budget-exhausted');
      expect(logical?.durableDecisions[0]?.uri).toBe(candidate.uri);
    }),
  );

  effectIt.effect('lexical expiration does not cancel useful graph evidence or gain a new two second window', () =>
    Effect.gen(function* () {
      let completed = false;
      let logical: ContextBriefLogicalResultV1 | undefined;
      const fiber = yield* compileContextBriefWith(
        {
          graphEvidence: () =>
            Effect.sleep(2500).pipe(Effect.as(unavailableContextBriefGraphEvidence('graph-ready-snapshot-missing', 1))),
          memoryEvidence: () =>
            Effect.sleep(3000).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  completed = true;
                }),
              ),
              Effect.as(memory()),
            ),
          projection: (value, budget, format) =>
            Effect.sync(() => {
              logical = value;
              return projectContextBrief(value, budget, format);
            }),
        },
        request,
      ).pipe(Effect.forkScoped);
      yield* TestClock.adjust(2500);
      yield* Fiber.join(fiber);
      expect(completed).toBe(false);
      expect(logical?.coverage.gaps).toContain('memory-recall-budget-exhausted');
      expect(logical?.durableDecisions).toEqual([]);
    }),
  );
});
