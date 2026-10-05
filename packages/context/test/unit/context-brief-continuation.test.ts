import fc from 'fast-check';
import {Effect, Schema} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import {compileContextBriefWith} from '../../src/compiler.js';
import {contextBriefResumeTaskAlignmentScore, parseContextBriefContinuationCard} from '../../src/memory-evidence.js';
import {contextBriefResumeFocusUri} from '../../src/memory_projection.js';
import {assembleContextBriefLogicalResult, planContextBrief} from '../../src/planner.js';
import {parseContextBriefJsonText, projectContextBrief, projectContextBriefAgentView} from '../../src/projector.js';
import {
  parseContextBriefRequestV1,
  type ContextBriefGraphEvidenceV1,
  type ContextBriefLogicalMemoryEvidenceV1,
  type ContextBriefLogicalResultV1,
} from '../../src/types.js';

const COMMIT = 'a'.repeat(40);
const REPOSITORY_ID = 'b'.repeat(64);
const REF = `cgs_${'c'.repeat(32)}`;

describe('Context Brief continuation contracts', () => {
  it('accepts resume as a public mode without changing the compact request shape', () => {
    const parsed = parseContextBriefRequestV1(request('resume'));
    expect(parsed.mode).toBe('resume');
    expect(planContextBrief(parsed).mode).toBe('resume');
  });

  effectIt.effect('derives resume graph anchors from the highest-ranked continuation handoff', () =>
    Effect.gen(function* () {
      const citedPath = 'packages/context/src/projector.ts';
      const observedPlans: Array<readonly string[]> = [];
      const memory = {
        ...emptyMemory(),
        candidates: [{...handoff(), codeCitations: [fileCitation(citedPath)]}],
        consideredCandidates: 1,
      };

      yield* compileContextBriefWith(
        {
          graphEvidence: plan =>
            Effect.sync(() => {
              observedPlans.push(plan.codeRefs);
              return graph(true);
            }),
          memoryEvidence: () => Effect.succeed(memory),
        },
        request('resume'),
      );
      yield* compileContextBriefWith(
        {
          graphEvidence: plan =>
            Effect.sync(() => {
              observedPlans.push(plan.codeRefs);
              return graph(true);
            }),
          memoryEvidence: () => Effect.succeed(memory),
        },
        {...request('resume'), codeRefs: [REF]},
      );
      yield* compileContextBriefWith(
        {
          graphEvidence: plan =>
            Effect.sync(() => {
              observedPlans.push(plan.codeRefs);
              return graph(true);
            }),
          memoryEvidence: () => Effect.succeed(memory),
        },
        request('brief'),
      );

      expect(observedPlans).toEqual([[citedPath], [REF], []]);
    }),
  );

  effectIt.effect('uses the task-aligned continuation for resume graph anchors and handoff priority', () =>
    Effect.gen(function* () {
      const obsoletePath = 'infra/telemetry-gateway/cmd/canary/main.go';
      const currentPath = 'studies/automated-context-two-arm/evaluate.ts';
      const obsolete = {
        ...handoff(),
        codeCitations: [fileCitation(obsoletePath)],
        continuationCard: {
          nextStep: 'seal the three-arm harness',
          task: 'Continue the matched-continuation three-arm experiment harness.',
        },
        excerpt: 'task: Continue the matched-continuation three-arm experiment harness.',
        rank: 0,
        topic: 'matched-continuation-three-arm-experiment-harness-map',
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/obsolete.md',
      };
      const current = {
        ...handoff(),
        codeCitations: [fileCitation(currentPath)],
        continuationCard: {
          nextStep: 'continue the two-arm automated-context canary',
          task: 'Continue the automated-context two-arm study with exact-candidate methodology boundaries.',
        },
        excerpt: 'task: Continue the automated-context two-arm study with exact-candidate methodology boundaries.',
        rank: 1,
        topic: 'automated-context-two-arm-study',
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/current.md',
      };
      const observedPlans: Array<readonly string[]> = [];
      const result = yield* compileContextBriefWith(
        {
          graphEvidence: plan =>
            Effect.sync(() => {
              observedPlans.push(plan.codeRefs);
              return graph(true);
            }),
          memoryEvidence: () =>
            Effect.succeed({
              ...emptyMemory(),
              candidates: [obsolete, current],
              consideredCandidates: 2,
            }),
        },
        {
          ...request('resume'),
          task: 'Continue the automated-context experiment from the two-cluster canary while preserving exact-candidate and two-arm methodology boundaries.',
        },
      );

      expect(observedPlans).toEqual([[currentPath]]);
      expect(result.structuredContent.activeHandoffs[0]?.uri).toBe(current.uri);
    }),
  );

  effectIt.effect('anchors the cited fresh continuation selected after citation validation', () =>
    Effect.gen(function* () {
      const citedPath = 'packages/context/src/planner.ts';
      const staleAligned = {
        ...handoff('d'.repeat(40)),
        continuationCard: {
          nextStep: 'continue the two-arm canary',
          task: 'Continue the automated-context two-arm canary.',
        },
        rank: 0,
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/stale-aligned.md',
      };
      const freshCited = {
        ...handoff(),
        codeCitations: [fileCitation(citedPath)],
        continuationCard: {nextStep: 'check the planner', task: 'Continue the verified repair.'},
        rank: 1,
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/fresh-cited.md',
      };
      const observedPlans: Array<readonly string[]> = [];
      let validationCalls = 0;
      const result = yield* compileContextBriefWith(
        {
          graphEvidence: plan =>
            Effect.sync(() => {
              observedPlans.push(plan.codeRefs);
              return {
                ...graphForPath(plan.codeRefs[0] ?? 'apps/threadnote/src/release/check.ts'),
                citationValidationFence: {
                  generation: {digest: 'same-digest', id: 'same-generation'},
                  kind: 'workset' as const,
                  workset: 'threadnote',
                },
              };
            }),
          memoryEvidence: () =>
            Effect.succeed({
              ...emptyMemory(),
              candidates: [staleAligned, freshCited],
              consideredCandidates: 2,
            }),
          citationValidation: () =>
            Effect.sync(() => {
              validationCalls += 1;
              return [exactCitationValidation(freshCited.uri, freshCited.codeCitations[0].id, citedPath)];
            }),
        },
        {...request('resume'), task: 'Continue the automated-context two-arm canary.'},
      );

      expect(result.structuredContent.activeHandoffs[0]?.uri).toBe(freshCited.uri);
      expect(observedPlans.at(-1)).toEqual([citedPath]);
      expect(observedPlans.length).toBeLessThanOrEqual(2);
      expect(validationCalls).toBe(1);
      expect(result.structuredContent.graph.cards[0]?.symbol.path).toBe(citedPath);
      expect(result.structuredContent.graph.contracts[0]?.evidence.path).toBe(citedPath);
      expect(result.structuredContent.graph.sources?.[0]?.path).toBe(citedPath);
    }),
  );

  effectIt.effect.prop(
    'keeps the final fresh cited handoff and resume anchor coherent across recall ranks and cited paths',
    [
      Schema.Literals([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      Schema.Literals(['packages/context/src/compiler.ts', 'packages/context/src/planner.ts']),
    ],
    ([staleRank, citedPath]) =>
      Effect.gen(function* () {
        const stale = {
          ...handoff('d'.repeat(40)),
          continuationCard: {
            nextStep: 'continue the two-arm canary',
            task: 'Continue the automated-context two-arm canary.',
          },
          rank: staleRank,
          uri: 'threadnote://user/test/memories/handoffs/active/threadnote/stale-property.md',
        };
        const fresh = {
          ...handoff(),
          codeCitations: [fileCitation(citedPath)],
          rank: 13,
          uri: 'threadnote://user/test/memories/handoffs/active/threadnote/fresh-property.md',
        };
        const observedPlans: Array<readonly string[]> = [];
        const result = yield* compileContextBriefWith(
          {
            graphEvidence: plan =>
              Effect.sync(() => {
                observedPlans.push(plan.codeRefs);
                return graphForPath(plan.codeRefs[0] ?? 'apps/threadnote/src/release/check.ts');
              }),
            memoryEvidence: () =>
              Effect.succeed({...emptyMemory(), candidates: [stale, fresh], consideredCandidates: 2}),
            citationValidation: () =>
              Effect.succeed([
                {
                  uri: fresh.uri,
                  receipts: [
                    {
                      candidateCount: 1,
                      citationId: fresh.codeCitations[0].id,
                      coverage: 'current-complete' as const,
                      kind: 'file' as const,
                      observedAt: '2026-10-03T00:00:00.000Z',
                      observedPath: citedPath,
                      reason: 'exact' as const,
                      status: 'exact' as const,
                      strategy: 'file-path' as const,
                      validatorVersion: 1 as const,
                    },
                  ],
                },
              ]),
          },
          {...request('resume'), task: 'Continue the automated-context two-arm canary.'},
        );
        expect(result.structuredContent.activeHandoffs[0]?.uri).toBe(fresh.uri);
        expect(observedPlans.at(-1)).toEqual([citedPath]);
        expect(observedPlans.length).toBeLessThanOrEqual(2);
        expect(result.structuredContent.graph.cards[0]?.symbol.path).toBe(citedPath);
        expect(result.structuredContent.graph.contracts[0]?.evidence.path).toBe(citedPath);
        expect(result.structuredContent.graph.sources?.[0]?.path).toBe(citedPath);
      }),
    {arbitrary: {runs: 30}},
  );

  effectIt.effect('withholds anchored cards when a changed citation fence changes the selected handoff', () =>
    Effect.gen(function* () {
      const citedPath = 'packages/context/src/planner.ts';
      const stale = {
        ...handoff('d'.repeat(40)),
        continuationCard: {
          nextStep: 'continue the two-arm canary',
          task: 'Continue the automated-context two-arm canary.',
        },
        rank: 0,
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/stale-fence.md',
      };
      const cited = {
        ...handoff(),
        codeCitations: [fileCitation(citedPath)],
        rank: 1,
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/cited-fence.md',
      };
      const plans: Array<readonly string[]> = [];
      let logicalGaps: readonly string[] = [];
      let validationCalls = 0;
      const result = yield* compileContextBriefWith(
        {
          graphEvidence: plan =>
            Effect.sync(() => {
              plans.push(plan.codeRefs);
              return {
                ...graphForPath(plan.codeRefs[0] ?? 'apps/threadnote/src/release/check.ts'),
                citationValidationFence: {
                  kind: 'repository' as const,
                  repositoryId: REPOSITORY_ID,
                  snapshotId: `cgsn_${plans.length}`,
                },
              };
            }),
          memoryEvidence: () => Effect.succeed({...emptyMemory(), candidates: [stale, cited], consideredCandidates: 2}),
          citationValidation: () =>
            Effect.sync(() => {
              validationCalls += 1;
              return [
                {
                  uri: cited.uri,
                  receipts: [
                    {
                      candidateCount: validationCalls === 1 ? 1 : 0,
                      citationId: cited.codeCitations[0].id,
                      coverage: validationCalls === 1 ? ('current-complete' as const) : ('incomplete' as const),
                      kind: 'file' as const,
                      observedAt: '2026-10-03T00:00:00.000Z',
                      reason: validationCalls === 1 ? ('exact' as const) : ('repository-unavailable' as const),
                      status: validationCalls === 1 ? ('exact' as const) : ('unknown' as const),
                      strategy: validationCalls === 1 ? ('file-path' as const) : ('none' as const),
                      validatorVersion: 1 as const,
                    },
                  ],
                },
              ];
            }),
          projection: (logical, maximumEstimatedTokens, responseFormat) =>
            Effect.sync(() => {
              logicalGaps = logical.coverage.gaps;
              return projectContextBrief(logical, maximumEstimatedTokens, responseFormat);
            }),
        },
        {...request('resume'), task: 'Continue the automated-context two-arm canary.'},
      );
      expect(plans).toEqual([[], [citedPath]]);
      expect(validationCalls).toBe(2);
      expect(result.structuredContent.graph.cards).toEqual([]);
      expect(result.structuredContent.graph.contracts).toEqual([]);
      expect(result.structuredContent.graph.sources).toBeUndefined();
      expect(result.structuredContent.coverage.graph.complete).toBe(false);
      expect(logicalGaps).toContain('resume-anchor-validation-changed');
    }),
  );

  it('never reduces resume task alignment when matching continuation evidence is added', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('legacy', 'harness', 'pilot', 'canary', 'methodology'), {maxLength: 20}),
        filler => {
          const task = 'Continue the automated-context two-arm canary';
          const candidate = {
            continuationCard: {task: filler.join(' ')},
            topic: 'continuation-handoff',
          };
          expect(
            contextBriefResumeTaskAlignmentScore(task, {
              ...candidate,
              continuationCard: {task: `${candidate.continuationCard.task} automated-context`},
            }),
          ).toBeGreaterThanOrEqual(contextBriefResumeTaskAlignmentScore(task, candidate));
        },
      ),
      {numRuns: 50},
    );
  });

  it('does not treat generic resume boilerplate as task alignment', () => {
    expect(
      contextBriefResumeTaskAlignmentScore('Resume the current task from the active handoff and take the next step', {
        continuationCard: {nextStep: 'Take the next step', task: 'Current resume task handoff status'},
        topic: 'current-resume-handoff',
      }),
    ).toBe(0);
    expect(
      contextBriefResumeTaskAlignmentScore('Resume the current identity graph repair', {
        continuationCard: {task: 'Repair the IDENTITY graph'},
        topic: 'identity-graph',
      }),
    ).toBeGreaterThan(0);
  });

  effectIt.effect('does not let generic next-step overlap displace the recall-ranked continuation', () =>
    Effect.gen(function* () {
      const recallSelected = {
        ...handoff(),
        rank: 0,
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/recall-selected.md',
      };
      const boilerplate = {
        ...handoff(),
        continuationCard: {nextStep: 'Take the next step', task: 'Resume the current task'},
        rank: 1,
        topic: 'current-resume-handoff',
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/boilerplate.md',
      };
      const result = yield* compileContextBriefWith(
        {
          graphEvidence: () => Effect.succeed(graph(true)),
          memoryEvidence: () =>
            Effect.succeed({
              ...emptyMemory(),
              candidates: [recallSelected, boilerplate],
              consideredCandidates: 2,
            }),
        },
        {...request('resume'), task: 'Resume the current task and take the next step'},
      );

      expect(result.structuredContent.activeHandoffs[0]?.uri).toBe(recallSelected.uri);
    }),
  );

  effectIt.effect('keeps a fresh actionable continuation ahead of aligned stale and topic-only handoffs', () =>
    Effect.gen(function* () {
      const fresh = {
        ...handoff(),
        continuationCard: {nextStep: 'run the next check', task: 'Continue the verified repair.'},
        rank: 2,
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/fresh.md',
      };
      const staleAligned = {
        ...handoff('d'.repeat(40)),
        continuationCard: {
          nextStep: 'continue automated-context two-arm validation',
          task: 'Continue the automated-context two-arm canary.',
        },
        rank: 0,
        topic: 'automated-context-two-arm-canary',
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/stale.md',
      };
      const topicOnly = {
        ...handoff(),
        continuationCard: undefined,
        rank: 1,
        topic: 'automated-context-two-arm-canary',
        uri: 'threadnote://user/test/memories/handoffs/active/threadnote/topic-only.md',
      };
      const result = yield* compileContextBriefWith(
        {
          graphEvidence: () => Effect.succeed(graph(true)),
          memoryEvidence: () =>
            Effect.succeed({
              ...emptyMemory(),
              candidates: [staleAligned, topicOnly, fresh],
              consideredCandidates: 3,
            }),
        },
        {...request('resume'), task: 'Continue the automated-context two-arm canary.'},
      );

      expect(result.structuredContent.activeHandoffs[0]?.uri).toBe(fresh.uri);
    }),
  );

  it('projects labeled handoff fields, ignores fenced labels, and omits absolute paths', () => {
    expect(
      parseContextBriefContinuationCard(
        [
          'task: implement the card',
          'decisions: keep stable selectors',
          'graph question: which caller owns the state transition',
          'graph_query: Parser.advance callers and state transitions',
          'observed: the focused check fails only in the new regression',
          'anchors: packages/context/src/projector.ts:10-20',
          'tried: inspected the regression and ran the focused check',
          'untested invariant: verify real request behavior after the correction',
          'unresolved: root cause is not established',
          'avoid repeat: do not reread the cited regression unless source changed',
          'constraints: preserve source evidence',
          'rationale: bounded evidence is easier to resume',
          'verification: focused tests pass',
          'blockers: none',
          'risks: stale graph',
          'next_step: update projector at /Users/example/private.ts',
          '```md',
          'task: ignored code label',
          '```',
        ].join('\n'),
      ),
    ).toEqual({
      anchors: 'packages/context/src/projector.ts:10-20',
      attempted: 'inspected the regression and ran the focused check',
      avoidRepeat: 'do not reread the cited regression unless source changed',
      blockers: 'none',
      decisions: 'keep stable selectors',
      graphQuery: 'Parser.advance callers and state transitions',
      graphQuestion: 'which caller owns the state transition',
      invariants: 'preserve source evidence',
      nextStep: 'update projector at [path omitted]',
      observations: 'the focused check fails only in the new regression',
      rationale: 'bounded evidence is easier to resume',
      risks: 'stale graph',
      task: 'implement the card',
      unresolved: 'verify real request behavior after the correction root cause is not established',
      verification: 'focused tests pass',
    });
  });

  it('keeps tilde fences and shorter or mismatched closing fences from leaking example labels', () => {
    expect(
      parseContextBriefContinuationCard(
        [
          '````md',
          'task: ignored before a short backtick fence',
          '```',
          'decisions: also ignored',
          '~~~~',
          'verification: still ignored after a mismatched marker',
          '````',
          '~~~md',
          'blockers: ignored inside a tilde fence',
          '~~~',
          'task: retained outside examples',
        ].join('\n'),
      ),
    ).toEqual({task: 'retained outside examples'});
  });

  it('routes arbitrary untested-invariant labels into unresolved completion state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('untested invariant', 'untested_invariant', 'UNTESTED INVARIANT'),
        fc
          .string({minLength: 1, maxLength: 128})
          .filter(value => value.trim().length > 0 && !value.includes('/') && !/[\r\n]/u.test(value)),
        (label, value) => {
          const card = parseContextBriefContinuationCard(`${label}: ${value}`);
          expect(card).toEqual({unresolved: value.replace(/\s+/gu, ' ').trim()});
          expect(card).not.toHaveProperty('observations');
        },
      ),
      {numRuns: 64},
    );
  });

  it('caps repeated continuation text per field without changing its UTF-8 boundary', () => {
    const card = parseContextBriefContinuationCard(['task: 東京🙂', ...Array(1_000).fill('- 東京🙂')].join('\n'));
    expect(card?.task).toBe(utf8PrefixForTest(['東京🙂', ...Array(1_000).fill('東京🙂')].join(' '), 192));
    expect(new TextEncoder().encode(card?.task).byteLength).toBeLessThanOrEqual(192);
  });

  it('keeps arbitrary repeated continuation values bounded and deterministic', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('ascii', '東京', '🙂', 'a'.repeat(512)), {maxLength: 80}), values => {
        const body = ['task: start', ...values.map(value => `- ${value}`)].join('\n');
        const card = parseContextBriefContinuationCard(body);
        expect(card).toEqual(parseContextBriefContinuationCard(body));
        expect(new TextEncoder().encode(card?.task).byteLength).toBeLessThanOrEqual(192);
      }),
      {numRuns: 50},
    );
  });

  it('keeps arbitrary graph queries UTF-8 bounded and deterministic', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('symbol', '東京', '🙂', '.member', ':scope'), {maxLength: 80}), parts => {
        const body = `graph query: ${parts.join(' ')}`;
        const first = parseContextBriefContinuationCard(body);
        const second = parseContextBriefContinuationCard(body);
        expect(first).toEqual(second);
        expect(new TextEncoder().encode(first?.graphQuery ?? '').byteLength).toBeLessThanOrEqual(256);
      }),
      {numRuns: 50},
    );
  });

  it('marks a complete current resume bundle sufficient and suppresses duplicate source recovery', () => {
    const projected = project('resume', handoff());
    expect(projected.structuredContent.evidenceState).toBe('sufficient');
    expect(projected.structuredContent.recommendedFollowUps).toEqual([]);
    expect(projected.structuredContent.activeHandoffs[0]).toMatchObject({
      continuationCard: {nextStep: 'run focused tests', task: 'implement continuation support'},
      excerpt: '',
    });
    expect(projected.structuredContent.coverage).toMatchObject({
      graph: {
        complete: true,
        consideredRepositories: 1,
        readyRepositories: 1,
        requestedRepositories: 1,
        states: {},
      },
      memory: {
        consideredCandidates: 1,
        durableCandidates: 0,
        fresh: 1,
        handoffCandidates: 1,
        stale: 0,
        unknown: 0,
      },
    });
    expect(projected.measurement.totalBytes).toBeLessThanOrEqual(projected.maximumBytes);
    expect(projectContextBriefAgentView(projected.structuredContent, true).evidenceState).toBe('sufficient');
  });

  it('keeps continuation cards out of non-resume projections without dropping their excerpt', () => {
    const memory = project('brief', handoff()).structuredContent.activeHandoffs[0];
    expect(memory?.continuationCard).toBeUndefined();
    expect(memory?.excerpt).toContain('implement continuation support');
  });

  it('does not treat an absent optional memory lane as incomplete current source evidence', () => {
    const projected = project('brief');
    expect(projected.structuredContent.evidenceState).toBe('sufficient');
    expect(projected.structuredContent.recommendedFollowUps).toEqual([]);
  });

  it('reports an explicit partial resume gap and degrades stale continuation evidence', () => {
    expect(project('resume').structuredContent.evidenceState).toBe('partial');
    expect(project('resume', handoff('d'.repeat(40))).structuredContent.evidenceState).toBe('degraded');
  });

  it('returns executable bounded follow-ups and uses a stable node selector', () => {
    const logical = assembleContextBriefLogicalResult({
      graph: graph(false),
      memory: emptyMemory(),
      observedAt: '2026-09-30T00:00:00.000Z',
      plan: planContextBrief(request('brief', 'compact')),
    });
    expect(logical.recommendedFollowUps).toEqual([
      expect.objectContaining({
        arguments: expect.objectContaining({
          budgetTokens: 800,
          callerCwd: '/repo',
          edgeLimit: 12,
          nodeId: REF,
          nodeLimit: 8,
          operation: 'node',
        }),
        operation: 'inspect-node',
        ref: REF,
        tool: 'inspect_code_graph',
      }),
    ]);
  });

  it('keeps the required graph card when optional handoffs are added at every public budget', () => {
    for (const budgetTokens of [800, 900, 1_000, 1_250, 1_500]) {
      const withoutMemory = project('brief', undefined, budgetTokens).structuredContent.graph.cards.map(
        card => card.id,
      );
      const withMemory = project('brief', handoff(), budgetTokens).structuredContent.graph.cards.map(card => card.id);
      expect(withMemory).toEqual(withoutMemory);
    }
  });

  it('keeps a decision-rich continuation card ahead of optional graph breadth at every public budget', () => {
    for (const budgetTokens of [800, 900, 1_000, 1_250, 1_500]) {
      const projected = project('resume', realisticHandoff(), budgetTokens, denseGraph()).structuredContent;
      expect(projected.activeHandoffs[0]).toMatchObject({
        continuationCard: {
          decisions: expect.stringContaining('_format_marker'),
          invariants: expect.stringContaining('public marker formatting'),
          nextStep: expect.stringContaining('minimal formatter fix'),
          rationale: expect.stringContaining('Marker.__str__'),
          verification: expect.stringContaining('precedence-related tests'),
        },
        excerpt: '',
      });
      expect(projected.graph.cards[0]?.id).toBe('card-1');
    }
  });

  it('keeps the continuation card when noisy detached-worktree graph relationships fill the budget', () => {
    for (const budgetTokens of [800, 1_500]) {
      const projected = project(
        'resume',
        realisticHandoff(),
        budgetTokens,
        noisyDetachedWorktreeGraph(),
      ).structuredContent;
      expect(projected.activeHandoffs[0]?.continuationCard).toBeDefined();
      expect(projected.graph.cards[0]?.id).toBe('card-1');
      expect(projected.coverage.gaps).toContain('graph-evidence-partial');
    }
    expect(
      project('brief', realisticHandoff(), 1_500, noisyDetachedWorktreeGraph()).structuredContent.activeHandoffs.some(
        memory => memory.continuationCard !== undefined,
      ),
    ).toBe(false);
  });

  it('projects an exact current resume with one compact implementation anchor instead of optional graph breadth', () => {
    const projected = projectValidatedResume(1_500);
    const brief = projected.structuredContent;
    const agentView = projectContextBriefAgentView(projected.structuredContent, true);

    expect(brief.activeHandoffs[0]).toMatchObject({
      continuationCard: {
        decisions: expect.stringContaining('after the chunk size and after any chunk extension'),
        invariants: expect.stringContaining('Reject non-whitespace malformed bytes'),
        nextStep: expect.stringContaining('h11/tests/test_io.py'),
      },
      citationSummary: {coverage: 'current-complete', exact: 1, relocated: 0, stale: 0, unknown: 0},
      citationDetailsOmitted: true,
      freshness: 'fresh',
      preciseStatus: 'exact',
    });
    expect(brief.durableDecisions).toEqual([]);
    expect(brief.graph).toEqual({cards: [expect.objectContaining({id: 'card-1', ref: REF})], contracts: []});
    expect(brief.coverage.gaps).toEqual([]);
    expect(brief.coverage.omissions).toMatchObject({
      activeHandoffs: 0,
      durableDecisions: 1,
      graphCards: 15,
      graphContracts: 32,
    });
    expect(brief.evidenceState).toBe('sufficient');
    expect(brief.output.truncated).toBe(true);
    expect(brief.recommendedFollowUps).toEqual([]);
    expect(agentView.answer).toContain('Resume from the exact current handoff.');
    expect(agentView.answer).toContain('Start at graph.cards[0]');
    expect(agentView.answer).toContain('_add_method_dunders');
    expect(agentView.answer).toContain('C.__replace__.__qualname__ ends in C.evolve instead of C.__replace__');
    expect(agentView.activeHandoffs?.[0]?.continuationCard).toBeUndefined();
    expect(projected.text).not.toContain('"continuationCard"');
    expect(agentView.output).toBeUndefined();
    expect(agentView.graph?.cards?.[0]).toMatchObject({ref: REF});
    expect(projected.measurement.totalBytes).toBeLessThan(2_200);
  });

  it('keeps decision-grade diagnosis and the exact graph query in a compact exact resume', () => {
    const logical = validatedResumeLogical('exact', 800);
    const primary = logical.activeHandoffs[0];
    if (primary?.continuationCard === undefined) throw new Error('expected exact continuation card');
    const resumeMarker = 'threadnote-resume-2ef48fa924d2ab2e731d';
    const graphQuery =
      'rest_framework/fields.py Which callers distinguish an empty parsed dictionary from the empty sentinel?';
    const projected = projectContextBrief(
      {
        ...logical,
        activeHandoffs: [
          {
            ...primary,
            continuationCard: {
              ...primary.continuationCard,
              task: `${resumeMarker}. Continue the exact diagnostic checkpoint without repeating discovery.`,
              anchors: 'tests/test_fields.py:2560-2572; rest_framework/fields.py:1749-1754',
              avoidRepeat: 'Do not rerun the sealed failure or reread unchanged cited anchors.',
              graphQuery,
              graphQuestion: 'Which callers distinguish parsed empty dictionaries from the empty sentinel?',
              observations: 'Absent HTML dictionary input is converted to an empty mapping before defaults apply.',
              unresolved: 'Preserve explicit empty input while returning the empty sentinel for absence.',
            },
          },
        ],
      },
      800,
      'agent',
    );
    const view = projectContextBriefAgentView(projected.structuredContent, true);

    expect(view.answer).toContain('Observed: Absent HTML dictionary input');
    expect(view.answer).toContain(`Task: ${resumeMarker}.`);
    expect(view.answer).toContain('Unresolved: Preserve explicit empty input');
    expect(view.answer).toContain(`Graph query: ${graphQuery}`);
    expect(view.answer).toContain('Anchors: tests/test_fields.py:2560-2572');
    expect(view.answer).toContain('Avoid repeat: Do not rerun the sealed failure');
    expect(projected.measurement.totalBytes).toBeLessThanOrEqual(projected.maximumBytes);
  });

  it('does not call an exact current resume sufficient without a fresh implementation anchor', () => {
    const logical = validatedResumeLogical();
    const withoutAnchor = projectContextBrief(
      {...logical, graph: {...logical.graph, cards: []}},
      1_500,
      'agent',
    ).structuredContent;
    const unknownGraph = projectContextBrief(
      {...logical, scope: {...logical.scope, freshness: 'unknown'}},
      1_500,
      'agent',
    ).structuredContent;

    expect(withoutAnchor.graph.cards).toEqual([]);
    expect(withoutAnchor.evidenceState).toBe('partial');
    expect(unknownGraph.graph.cards[0]?.id).toBe('card-1');
    expect(unknownGraph.evidenceState).toBe('degraded');
  });

  it('retains the structured continuation card in the dual text compatibility channel', () => {
    const graphQuery = 'h11/_abnf.py Which callers depend on the chunk-size state transition?';
    const projected = projectContextBrief(validatedResumeLogical(), 1_500, 'dual');

    expect(projected.structuredContent.graph.cards[0]?.id).toBe('card-1');
    expect(projected.text).toContain('"continuationCard"');
    expect(projected.text).toContain('h11/_abnf.py');
    const compatibleAgentView = JSON.parse(projected.text) as {
      activeHandoffs: Array<{continuationCard?: Record<string, string>}>;
    };
    const continuationCard = compatibleAgentView.activeHandoffs[0]?.continuationCard;
    if (continuationCard === undefined) throw new Error('expected dual continuation card');
    continuationCard.graphQuery = graphQuery;
    continuationCard.graphQuestion = 'Which callers depend on the chunk-size state transition?';
    const parsed = parseContextBriefJsonText(JSON.stringify(compatibleAgentView));
    expect(parsed.graph?.cards?.[0]?.ref).toBe(REF);
    expect(parsed.activeHandoffs?.[0]?.continuationCard).toMatchObject({
      graphQuery,
      graphQuestion: 'Which callers depend on the chunk-size state transition?',
    });
  });

  it('keeps graph evidence when resume citations are not exact and current-complete', () => {
    const projected = projectValidatedResume(1_500, 'relocated').structuredContent;
    expect(projected.graph.cards[0]?.id).toBe('card-1');
    expect(projected.coverage.gaps).toContain('graph-evidence-partial');
    expect(projected.activeHandoffs[0]?.preciseStatus).toBe('relocated');
  });

  it('focuses only an unambiguous exact-current continuation', () => {
    const base = validatedResumeLogical();
    const citationSummary = base.activeHandoffs[0].citationSummary;
    if (citationSummary === undefined) throw new Error('expected validated resume citation summary');
    const updatePrimary = (
      logical: ContextBriefLogicalResultV1,
      patch: Partial<ContextBriefLogicalMemoryEvidenceV1>,
    ): ContextBriefLogicalResultV1 => ({
      ...logical,
      activeHandoffs: [{...logical.activeHandoffs[0], ...patch}],
    });
    const cases: readonly [string, ContextBriefLogicalResultV1][] = [
      ['non-resume mode', {...base, mode: 'brief'}],
      ['missing continuation', updatePrimary(base, {continuationCard: undefined})],
      ['stale handoff', updatePrimary(base, {freshness: 'stale'})],
      ['source-commit freshness', updatePrimary(base, {freshnessBasis: 'source-commit'})],
      ['relocated status', updatePrimary(base, {preciseStatus: 'relocated'})],
      ['citation error', updatePrimary(base, {citationErrorCount: 1})],
      ['incomplete coverage', updatePrimary(base, {citationSummary: {...citationSummary, coverage: 'incomplete'}})],
      ['no exact citation', updatePrimary(base, {citationSummary: {...citationSummary, exact: 0}})],
      ['relocated citation', updatePrimary(base, {citationSummary: {...citationSummary, relocated: 1}})],
      ['stale citation', updatePrimary(base, {citationSummary: {...citationSummary, stale: 1}})],
      ['unknown citation', updatePrimary(base, {citationSummary: {...citationSummary, unknown: 1}})],
      [
        'competing handoff',
        {
          ...base,
          activeHandoffs: [
            ...base.activeHandoffs,
            {...base.activeHandoffs[0], uri: `${base.activeHandoffs[0].uri}/other`},
          ],
        },
      ],
      [
        'conflict',
        {
          ...base,
          stalenessAndConflicts: [
            {
              id: 'issue-1',
              kind: 'candidate-conflict',
              rank: 0,
              summary: 'Competing evidence',
              uris: [base.activeHandoffs[0].uri],
            },
          ],
        },
      ],
    ];
    expect(contextBriefResumeFocusUri(base)).toBe(base.activeHandoffs[0]?.uri);
    for (const [label, logical] of cases) expect(contextBriefResumeFocusUri(logical), label).toBeUndefined();
  });

  it('retains non-graph gaps in an otherwise focused resume', () => {
    const logical = validatedResumeLogical();
    const result = projectContextBrief(
      {...logical, coverage: {...logical.coverage, gaps: ['memory-citation-limited']}},
      1_500,
      'agent',
    );
    const projected = result.structuredContent;
    expect(projected.coverage.gaps).toEqual(['memory-citation-limited']);
    expect(projected.evidenceState).toBe('partial');
    expect(projected.graph.cards[0]?.id).toBe('card-1');
    expect(projectContextBriefAgentView(result.structuredContent, true).answer).toContain('Start at graph.cards[0]');
    expect(projectContextBriefAgentView(result.structuredContent, true).answer).not.toContain(
      'orientation is sufficient',
    );
  });

  it('retains the continuation core for arbitrary supported token budgets', () => {
    fc.assert(
      fc.property(fc.integer({min: 800, max: 1_500}), budgetTokens => {
        const projected = project('resume', realisticHandoff(), budgetTokens, noisyDetachedWorktreeGraph());
        expect(projected.structuredContent.activeHandoffs[0]?.continuationCard).toBeDefined();
        expect(projected.structuredContent.graph.cards[0]?.id).toBe('card-1');
        expect(projected.measurement.totalBytes).toBeLessThanOrEqual(projected.maximumBytes);
      }),
      {numRuns: 50},
    );
  });

  it('keeps exact current resume focus bounded for arbitrary supported token budgets', () => {
    fc.assert(
      fc.property(fc.integer({min: 800, max: 1_500}), budgetTokens => {
        const projected = projectValidatedResume(budgetTokens);
        const agentView = projectContextBriefAgentView(projected.structuredContent, true);
        expect(projected.structuredContent.activeHandoffs[0]?.continuationCard?.nextStep).toContain(
          'h11/tests/test_io.py',
        );
        expect(agentView.answer).toContain('C.__replace__.__qualname__ ends in C.evolve instead of C.__replace__');
        expect(new TextEncoder().encode(agentView.answer).byteLength).toBeLessThanOrEqual(1_600);
        expect(projected.structuredContent.graph.cards[0]?.id).toBe('card-1');
        if (projected.structuredContent.evidenceState === 'sufficient') {
          expect(projected.structuredContent.scope.freshness).toBe('fresh');
          expect(projected.structuredContent.coverage.graph.complete).toBe(true);
        }
        expect(projected.measurement.totalBytes).toBeLessThanOrEqual(projected.maximumBytes);
      }),
      {numRuns: 50},
    );
  });

  it('requires fresh complete graph coverage before exact current resume is sufficient', () => {
    fc.assert(
      fc.property(
        fc.record({
          budgetTokens: fc.integer({min: 800, max: 1_500}),
          complete: fc.boolean(),
          freshness: fc.constantFrom('fresh' as const, 'stale' as const, 'unknown' as const),
        }),
        ({budgetTokens, complete, freshness}) => {
          const logical = validatedResumeLogical('exact', budgetTokens);
          const projected = projectContextBrief(
            {
              ...logical,
              coverage: {...logical.coverage, graph: {...logical.coverage.graph, complete}},
              scope: {...logical.scope, freshness},
            },
            budgetTokens,
            'agent',
          ).structuredContent;

          expect(projected.graph.cards[0]?.id).toBe('card-1');
          expect(projected.evidenceState === 'sufficient').toBe(freshness === 'fresh' && complete);
        },
      ),
      {numRuns: 50},
    );
  });

  it('parses continuation labels deterministically under field-order permutations and remains UTF-8 safe', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(
          [
            'task: 東京🙂',
            'decisions: preserve graph',
            'observed: exact failure',
            'anchors: packages/context/src/projector.ts',
            'tried: focused inspection',
            'unresolved: cause unknown',
            'avoid_repeat: repeated broad search',
            'constraints: current source',
            'verification: tests pass',
            'next_step: inspect node',
          ],
          {minLength: 1},
        ),
        lines => {
          const first = parseContextBriefContinuationCard(lines.join('\n'));
          const second = parseContextBriefContinuationCard([...lines].reverse().join('\n'));
          expect(first).toEqual(second);
          expect(JSON.stringify(first)).not.toContain('\ud800');
        },
      ),
      {numRuns: 50},
    );
  });
});

function request(mode: 'brief' | 'resume', detail: 'compact' | 'source' = 'source', budgetTokens = 1_500) {
  return {
    budgetTokens,
    detail,
    mode,
    responseFormat: 'agent' as const,
    scope: {callerCwd: '/repo', kind: 'repository' as const},
    task: 'resume current implementation',
  };
}

function project(
  mode: 'brief' | 'resume',
  candidate?: ReturnType<typeof handoff>,
  budgetTokens = 1_500,
  graphEvidence = graph(true),
) {
  return projectContextBrief(
    assembleContextBriefLogicalResult({
      graph: graphEvidence,
      memory: {
        ...emptyMemory(),
        candidates: candidate === undefined ? [] : [candidate],
        consideredCandidates: candidate === undefined ? 0 : 1,
      },
      observedAt: '2026-09-30T00:00:00.000Z',
      plan: planContextBrief(request(mode, 'source', budgetTokens)),
    }),
    budgetTokens,
    'agent',
  );
}

function projectValidatedResume(budgetTokens: number, status: 'exact' | 'relocated' = 'exact') {
  return projectContextBrief(validatedResumeLogical(status, budgetTokens), budgetTokens, 'agent');
}

function validatedResumeLogical(status: 'exact' | 'relocated' = 'exact', budgetTokens = 1_500) {
  const uri = 'threadnote://user/test/memories/handoffs/active/h11/resume.md';
  const citation = {
    extractorSet: 'native-code-graph-13',
    fileContentHash: {algorithm: 'sha256' as const, value: 'd'.repeat(64)},
    id: 'citation-h11-abnf',
    path: 'h11/_abnf.py',
    repositoryId: REPOSITORY_ID,
    repositoryIdentityKind: 'remote' as const,
    sourceCommit: COMMIT,
    sourceDirty: false,
    sourceSnapshotId: 'cgsn_test',
    target: {kind: 'file' as const},
    version: 1 as const,
  };
  const candidate = {
    ...realisticHandoff(),
    codeCitations: [citation],
    continuationCard: {
      ...realisticHandoff().continuationCard,
      decisions:
        'Allow horizontal optional whitespace after the chunk size and after any chunk extension, immediately before CRLF.',
      invariants:
        'Reject non-whitespace malformed bytes and preserve full-match validation, payload boundaries, and the size limit.',
      nextStep:
        'Update h11/_abnf.py and add size, extension, and strict-rejection regressions in h11/tests/test_io.py.',
      rationale:
        'The regression exposes the boundary between class-specific generated metadata and a process-wide shared callable without prescribing an implementation. The frozen source attaches shared evolve through _add_method_dunders, after which C.__replace__.__qualname__ ends in C.evolve instead of C.__replace__.',
    },
    uri,
  };
  return assembleContextBriefLogicalResult({
    graph: noisyDetachedWorktreeGraph(),
    memory: {
      ...emptyMemory(),
      candidates: [
        candidate,
        {
          citationErrorCount: 0,
          codeCitations: [],
          excerpt: 'Secondary durable subsystem detail that is optional for the exact continuation.',
          kind: 'durable' as const,
          rank: 1,
          sourceCommit: COMMIT,
          uri: 'threadnote://user/test/memories/durable/projects/h11/subsystem.md',
        },
      ],
      citationValidations: [
        {
          receipts: [
            {
              candidateCount: 1,
              citationId: citation.id,
              coverage: 'current-complete' as const,
              kind: 'file' as const,
              observedAt: '2026-09-30T00:00:00.000Z',
              observedPath: citation.path,
              reason: status,
              status,
              strategy: 'file-path' as const,
              validatorVersion: 1 as const,
            },
          ],
          uri,
        },
      ],
      consideredCandidates: 2,
    },
    observedAt: '2026-09-30T00:00:00.000Z',
    plan: planContextBrief(request('resume', 'source', budgetTokens)),
  });
}

function graph(withSource: boolean): ContextBriefGraphEvidenceV1 {
  return {
    cards: [
      {
        id: 'card-1',
        rank: 0,
        reason: 'implementation',
        ref: REF,
        repositoryKey: 'threadnote',
        symbol: {
          kind: 'function',
          language: 'typescript',
          line: 1,
          name: 'compile',
          path: 'packages/context/src/compiler.ts',
          qualifiedName: 'compile',
        },
      },
    ],
    contracts: [],
    coverage: {complete: true, consideredRepositories: 1, readyRepositories: 1, requestedRepositories: 1, states: {}},
    gaps: [],
    resolvedSnapshots: [
      {
        commit: COMMIT,
        dirty: false,
        freshness: 'fresh',
        repositoryId: REPOSITORY_ID,
        repositoryKey: 'threadnote',
        snapshotId: 'cgsn_test',
      },
    ],
    ...(withSource
      ? {
          sourceExcerpts: [
            {
              content: 'export const compile = () => undefined;',
              coveredGraphRefs: [REF],
              endLine: 1,
              evidenceKind: 'graph-snapshot' as const,
              freshness: 'fresh' as const,
              id: 'source-1',
              path: 'packages/context/src/compiler.ts',
              repositoryKey: 'threadnote',
              snapshotIdentity: 'current-clean' as const,
              startLine: 1,
              truncated: false,
            },
          ],
        }
      : {}),
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    warnings: [],
  };
}

function graphForPath(path: string): ContextBriefGraphEvidenceV1 {
  const base = graph(true);
  const discriminator = path.includes('planner') ? '2' : path.includes('release/check') ? '3' : '1';
  const ref = `cgs_${discriminator.repeat(32)}`;
  return {
    ...base,
    cards: [
      {
        ...base.cards[0],
        id: `card-${discriminator}`,
        ref,
        symbol: {
          ...base.cards[0].symbol,
          name: `symbol-${discriminator}`,
          path,
          qualifiedName: `symbol-${discriminator}`,
        },
      },
    ],
    contracts: [
      {
        authority: 'authoritative',
        evidence: {line: 1, path, repositoryKey: 'threadnote'},
        id: `contract-${discriminator}`,
        provenance: 'resolved',
        rank: 0,
        relation: 'references',
        sourceRef: ref,
        targetRef: ref,
      },
    ],
    sourceExcerpts: [
      {
        ...base.sourceExcerpts![0],
        content: `export const symbol${discriminator} = () => undefined;`,
        coveredGraphRefs: [ref],
        id: `source-${discriminator}`,
        path,
      },
    ],
  };
}

function exactCitationValidation(uri: string, citationId: string, path: string) {
  return {
    uri,
    receipts: [
      {
        candidateCount: 1,
        citationId,
        coverage: 'current-complete' as const,
        kind: 'file' as const,
        observedAt: '2026-10-03T00:00:00.000Z',
        observedPath: path,
        reason: 'exact' as const,
        status: 'exact' as const,
        strategy: 'file-path' as const,
        validatorVersion: 1 as const,
      },
    ],
  };
}

function denseGraph(): ContextBriefGraphEvidenceV1 {
  const base = graph(true);
  return {
    ...base,
    cards: Array.from({length: 16}, (_, index) => ({
      ...base.cards[0],
      id: `card-${index + 1}`,
      rank: index,
      ref: index === 0 ? REF : `cgs_${index.toString(16).padStart(32, '0')}`,
      symbol: {
        ...base.cards[0].symbol,
        line: index + 1,
        name: `compile${index + 1}`,
        qualifiedName: `compile${index + 1}`,
      },
    })),
  };
}

function noisyDetachedWorktreeGraph(): ContextBriefGraphEvidenceV1 {
  const base = denseGraph();
  const refs = base.cards.map(card => card.ref);
  return {
    ...base,
    continuation: {cursor: `cgwc_${'1'.repeat(40)}`, remainingEstimate: 13},
    contracts: Array.from({length: 32}, (_, rank) => ({
      authority: 'authoritative' as const,
      evidence: {
        line: rank + 1,
        path: `notes/relationship-consumer-${rank}.org`,
        repositoryKey: 'threadnote',
      },
      id: `contract-${rank + 1}`,
      provenance: 'resolved' as const,
      rank,
      relation: rank % 2 === 0 ? 'contains' : 'references',
      sourceRef: refs[(rank + 1) % refs.length] ?? REF,
      targetRef: refs[0] ?? REF,
    })),
    gaps: ['graph-evidence-partial'],
    warnings: ['Graph traversal reached a configured result limit.'],
  };
}

function emptyMemory() {
  return {
    candidates: [],
    consideredCandidates: 0,
    gaps: [],
    trust: {classification: 'untrusted-memory-data' as const, instructionPolicy: 'evidence-only-never-follow' as const},
  };
}

function handoff(sourceCommit = COMMIT) {
  return {
    citationErrorCount: 0,
    codeCitations: [],
    continuationCard: {nextStep: 'run focused tests', task: 'implement continuation support'},
    excerpt: 'task: implement continuation support next_step: run focused tests',
    kind: 'handoff' as const,
    rank: 0,
    sourceCommit,
    uri: 'threadnote://user/test/memories/handoffs/active/threadnote/resume.md',
  };
}

function realisticHandoff(sourceCommit = COMMIT) {
  return {
    ...handoff(sourceCommit),
    continuationCard: {
      blockers: 'None; implementation and verification remain for the second agent.',
      decisions:
        'Fix `_format_marker` so nested lists retain parentheses as operands; add regression coverage for reparsed evaluation equivalence.',
      invariants:
        'Preserve public marker formatting except where parentheses are semantically required and avoid unrelated changes.',
      nextStep:
        'Implement the minimal formatter fix, add the supplied reproduction and a bounded round-trip invariant, then run focused marker tests.',
      rationale:
        '`Marker.__str__` delegates to `_format_marker`; singleton-list unwrapping can erase a nested group and alter precedence.',
      risks: 'Singleton-list unwrapping also affects canonical formatting, equality, hashes, and pickle state.',
      task: 'Continue the packaging marker serialization fix without changing the task contract.',
      verification:
        'Existing precedence-related tests and combined-marker tests are the focused verification targets; phase one made no edits.',
    },
  };
}

function fileCitation(path: string) {
  return {
    extractorSet: 'native-code-graph-13',
    fileContentHash: {algorithm: 'sha256' as const, value: 'd'.repeat(64)},
    id: `citation-${path}`,
    path,
    repositoryId: REPOSITORY_ID,
    repositoryIdentityKind: 'remote' as const,
    sourceCommit: COMMIT,
    sourceDirty: false,
    sourceSnapshotId: 'cgsn_test',
    target: {kind: 'file' as const},
    version: 1 as const,
  };
}

function utf8PrefixForTest(value: string, maximumBytes: number): string {
  if (new TextEncoder().encode(value).byteLength <= maximumBytes) return value;
  let output = '';
  for (const character of value) {
    if (new TextEncoder().encode(`${output}${character}…`).byteLength > maximumBytes) break;
    output += character;
  }
  return `${output}…`;
}
