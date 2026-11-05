import {it as effectIt} from '@effect/vitest';
import {Effect, Fiber, String as EffectString} from 'effect';
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

describe('Context Brief shared elapsed budgets', () => {
  effectIt.effect('shares the graph deadline with citation validation and preserves unknown proof on expiry', () =>
    Effect.gen(function* () {
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
