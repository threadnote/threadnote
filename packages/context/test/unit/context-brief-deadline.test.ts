import {it as effectIt} from '@effect/vitest';
import {Effect, Fiber, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import type {ReadDeadline} from '@threadnote/platform/read_deadline';
import {compileContextBriefWith, type ContextBriefCompilerDependencies} from '../../src/compiler.js';
import {unavailableContextBriefGraphEvidence} from '../../src/graph/evidence.js';
import {projectContextBrief} from '../../src/projector.js';
import type {
  ContextBriefGraphEvidenceV1,
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

  effectIt.effect('an agent locate brief without graph evidence keeps retrieved memory within its budget', () =>
    Effect.gen(function* () {
      const readyWithoutEvidence: ContextBriefGraphEvidenceV1 = {
        ...unavailableContextBriefGraphEvidence('graph-query-unavailable', 1),
        coverage: {
          complete: true,
          consideredRepositories: 1,
          readyRepositories: 1,
          requestedRepositories: 1,
          states: {},
        },
        gaps: [],
      };
      const contractsWithoutCards: ContextBriefGraphEvidenceV1 = {
        ...readyWithoutEvidence,
        contracts: [
          {
            authority: 'supporting',
            evidence: {line: 1, path: 'src/deadline.ts', repositoryKey: 'threadnote'},
            id: 'contract-1',
            provenance: 'resolved',
            rank: 0,
            relation: 'calls',
            sourceRef: 'n1',
            targetRef: 'n2',
          },
        ],
      };
      const graphReads: ReadonlyArray<Effect.Effect<ContextBriefGraphEvidenceV1>> = [
        Effect.never,
        Effect.succeed(unavailableContextBriefGraphEvidence('graph-ready-snapshot-missing', 1, {missing: 1})),
        Effect.succeed(readyWithoutEvidence),
        Effect.succeed(contractsWithoutCards),
      ];
      for (const graphRead of graphReads) {
        const fiber = yield* compileContextBriefWith(
          {graphEvidence: () => graphRead, memoryEvidence: () => Effect.succeed(memory())},
          {...request, responseFormat: 'agent'},
        ).pipe(Effect.forkScoped);
        yield* TestClock.adjust(5000);
        const result = yield* Fiber.join(fiber);
        expect(result.structuredContent.durableDecisions[0]?.uri).toBe(candidate.uri);
        expect(result.measurement.totalBytes).toBeLessThanOrEqual(result.maximumBytes);
      }
    }),
  );

  effectIt.effect('names the status phase only when the deadline expires before graph status completes', () =>
    Effect.gen(function* () {
      const gapsFor = (graphEvidence: ContextBriefCompilerDependencies['graphEvidence']) =>
        Effect.gen(function* () {
          let logical: ContextBriefLogicalResultV1 | undefined;
          const fiber = yield* compileContextBriefWith(
            {
              graphEvidence,
              memoryEvidence: () => Effect.succeed(memory()),
              projection: (value, budget, format) =>
                Effect.sync(() => {
                  logical = value;
                  return projectContextBrief(value, budget, format);
                }),
            },
            request,
          ).pipe(Effect.forkScoped);
          yield* TestClock.adjust(5000);
          const result = yield* Fiber.join(fiber);
          return {gaps: logical?.coverage.gaps ?? [], projected: result.structuredContent.coverage.gaps};
        });
      const slowStatus = yield* gapsFor(() => Effect.never);
      expect(slowStatus.gaps).toContain('graph-status-deadline-exceeded');
      expect(slowStatus.gaps).not.toContain('graph-read-budget-exhausted');
      expect(slowStatus.projected).toContain('graph-status-deadline-exceeded');
      const slowInspection = yield* gapsFor((_plan, budget) =>
        Effect.andThen(
          Effect.sync(() => {
            if (budget) budget.statusObserved = true;
          }),
          Effect.never,
        ),
      );
      expect(slowInspection.gaps).toContain('graph-read-budget-exhausted');
      expect(slowInspection.gaps).not.toContain('graph-status-deadline-exceeded');
    }),
  );

  effectIt.effect('a later resume graph read after a completed first read does not report the status gap', () =>
    Effect.gen(function* () {
      const commit = EffectString.repeat(40)('a');
      const citedPath = 'packages/context/src/planner.ts';
      const handoff = {
        citationErrorCount: 0,
        codeCitations: [],
        continuationCard: {nextStep: 'run focused tests', task: 'implement continuation support'},
        excerpt: 'task: implement continuation support',
        kind: 'handoff' as const,
        rank: 0,
        sourceCommit: commit,
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/cited.md',
      };
      // The task-aligned stale handoff anchors the first read; the fresh cited one anchors the second.
      const stale = {
        ...handoff,
        continuationCard: {nextStep: 'continue the canary', task: 'Continue the automated-context two-arm canary.'},
        sourceCommit: EffectString.repeat(40)('d'),
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/stale.md',
      };
      const cited = {
        ...handoff,
        codeCitations: [
          {
            extractorSet: 'extractor',
            fileContentHash: {algorithm: 'sha256' as const, value: EffectString.repeat(64)('d')},
            id: 'citation-planner',
            path: citedPath,
            repositoryId: 'repository',
            repositoryIdentityKind: 'remote' as const,
            sourceCommit: commit,
            sourceDirty: false,
            sourceSnapshotId: 'snapshot',
            target: {kind: 'file' as const},
            version: 1 as const,
          },
        ],
        rank: 1,
      };
      const firstRead: ContextBriefGraphEvidenceV1 = {
        ...unavailableContextBriefGraphEvidence('graph-query-unavailable', 1),
        coverage: {
          complete: true,
          consideredRepositories: 1,
          readyRepositories: 1,
          requestedRepositories: 1,
          states: {},
        },
        gaps: [],
        resolvedSnapshots: [
          {
            commit,
            dirty: false,
            freshness: 'fresh',
            repositoryId: 'repository',
            repositoryKey: 'threadnote',
            snapshotId: 'snapshot',
          },
        ],
      };
      const plans: Array<readonly string[]> = [];
      let logical: ContextBriefLogicalResultV1 | undefined;
      const fiber = yield* compileContextBriefWith(
        {
          graphEvidence: (plan, budget) => {
            plans.push(plan.codeRefs);
            return plans.length === 1
              ? Effect.sync(() => {
                  if (budget) budget.statusObserved = true;
                  return firstRead;
                })
              : Effect.never;
          },
          memoryEvidence: () => Effect.succeed({...memory(), candidates: [stale, cited], consideredCandidates: 2}),
          citationValidation: () =>
            Effect.succeed([
              {
                uri: cited.uri,
                receipts: [
                  {
                    candidateCount: 1,
                    citationId: cited.codeCitations[0].id,
                    coverage: 'current-complete' as const,
                    kind: 'file' as const,
                    observedAt: '2026-10-03T00:00:00.000Z',
                    reason: 'exact' as const,
                    status: 'exact' as const,
                    strategy: 'file-path' as const,
                    validatorVersion: 1 as const,
                  },
                ],
              },
            ]),
          projection: (value, budget, format) =>
            Effect.sync(() => {
              logical = value;
              return projectContextBrief(value, budget, format);
            }),
        },
        {...request, mode: 'resume', task: 'Continue the automated-context two-arm canary.'},
      ).pipe(Effect.forkScoped);
      yield* TestClock.adjust(5000);
      yield* Fiber.join(fiber);
      expect(plans).toEqual([[], [citedPath]]);
      expect(logical?.coverage.gaps).toContain('graph-read-budget-exhausted');
      expect(logical?.coverage.gaps).not.toContain('graph-status-deadline-exceeded');
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
