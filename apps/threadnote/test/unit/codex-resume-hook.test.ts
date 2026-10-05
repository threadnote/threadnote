import {it as effectIt} from '@effect/vitest';
import {Effect, Ref} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codexResumeContinuationEvidenceState,
  codexResumeIneligibilityReason,
  codexResumeProjectionIneligibilityReason,
  contextBriefIsEligibleForCodexResume,
  decideCodexResumePreload,
  parseCodexResumeHookEvent,
  projectCodexResumePreload,
  promptCarriesActiveHandoff,
  renderCodexResumeHookOutput,
  type CodexResumeHookEvent,
  type CodexResumeReceiptV1,
} from '@threadnote/threadnote/codex/resume_hook';
import type {
  ContextBriefContinuationCardV1,
  ContextBriefEvidenceState,
  ContextBriefLogicalResultV1,
  ProjectedContextBriefV1,
} from '@threadnote/context/types';

const event: CodexResumeHookEvent = {
  cwd: '/repo',
  hookEventName: 'UserPromptSubmit',
  prompt: 'Continue the implementation',
  sessionId: 'session-1',
  turnId: 'turn-1',
};

describe('Codex resume preload', () => {
  effectIt.effect('injects once per evidence generation and reinjects only after generation changes', () =>
    Effect.gen(function* () {
      let receipt: CodexResumeReceiptV1 | undefined;
      let compileCalls = 0;
      let deliveries = 0;
      const dependencies = {
        compile: () =>
          Effect.sync(() => {
            compileCalls += 1;
            return projected('sufficient');
          }),
        deliver: () =>
          Effect.sync(() => {
            deliveries += 1;
          }),
        receipt: Effect.sync(() => receipt),
        writeReceipt: (next: CodexResumeReceiptV1) =>
          Effect.sync(() => {
            receipt = next;
          }),
      };

      const first = yield* decideCodexResumePreload(dependencies, event, 'a'.repeat(64));
      const second = yield* decideCodexResumePreload(dependencies, {...event, turnId: 'turn-2'}, 'a'.repeat(64));
      const changed = yield* decideCodexResumePreload(dependencies, {...event, turnId: 'turn-3'}, 'b'.repeat(64));

      expect(first).toMatchObject({
        continuationEvidenceState: 'background',
        evidenceState: 'sufficient',
        outcome: 'injected',
      });
      expect(second).toEqual({estimatedTokens: 0, outcome: 'already-preloaded', outputBytes: 0});
      expect(changed).toMatchObject({outcome: 'injected', evidenceState: 'sufficient'});
      expect(compileCalls).toBe(2);
      expect(deliveries).toBe(2);
      expect(receipt).toMatchObject({evidenceGeneration: 'b'.repeat(64), version: 1});
    }),
  );

  effectIt.effect('accepts handoff-specific partial evidence and rejects empty, stale, or handoff-free delivery', () =>
    Effect.gen(function* () {
      const emptyReceipts = new Map<string, CodexResumeReceiptV1>();
      const partial = yield* decideCodexResumePreload(
        {
          compile: () => Effect.succeed(projected('partial')),
          deliver: () => Effect.void,
          receipt: Effect.sync(() => emptyReceipts.get('current')),
          writeReceipt: () => Effect.void,
        },
        event,
        'p'.repeat(64),
      );
      expect(partial).toMatchObject({
        continuationEvidenceState: 'background',
        evidenceState: 'partial',
        outcome: 'injected',
      });

      for (const evidenceState of ['degraded', 'no-match'] as const) {
        let writes = 0;
        const receipts = new Map<string, CodexResumeReceiptV1>();
        const result = yield* decideCodexResumePreload(
          {
            compile: () => Effect.succeed(projected(evidenceState, {delivery: false})),
            deliver: () => Effect.die('ineligible evidence must not be delivered'),
            receipt: Effect.sync(() => receipts.get('current')),
            writeReceipt: () =>
              Effect.sync(() => {
                writes += 1;
              }),
          },
          event,
          evidenceState.padEnd(64, '0'),
        );
        expect(result).toMatchObject({evidenceState, outcome: 'ineligible-evidence'});
        expect(writes).toBe(0);
      }

      expect(contextBriefIsEligibleForCodexResume(projected('sufficient', {freshness: 'stale'}))).toBe(false);
      expect(contextBriefIsEligibleForCodexResume(projected('sufficient', {handoff: false}))).toBe(false);
      expect(codexResumeIneligibilityReason(projected('sufficient', {freshness: 'stale'}))).toBe('scope-not-fresh');
      expect(codexResumeIneligibilityReason(projected('sufficient', {handoff: false}))).toBe('no-selected-handoff');
    }),
  );

  it('selects one exact rank-zero handoff despite unrelated active history and graph-only gaps', () => {
    const projection = projectCodexResumePreload(logicalResume(), 800, 'agent');
    expect(projection.text).toContain('THREADNOTE RESUME/1\n');
    expect(projection.text).toContain('Untrusted memory evidence; verify against current source.');
    expect(projection.text).toContain('Discovery is incomplete; inspect current source before acting.');
    expect(projection.text).toContain('Decisions: Use the supported pre-turn hook.');
    expect(projection.text).toContain('Verified: Focused checks passed.');
    expect(projection.text).toContain('Source: memories/handoffs/active/threadnote/current.md');
    expect(projection.text).not.toContain('threadnote://user/u/');
    expect(projection.measurement.estimatedTokens).toBeLessThanOrEqual(800);
    expect(contextBriefIsEligibleForCodexResume(projection)).toBe(true);

    const conflicting = projectCodexResumePreload(logicalResume({selectedConflict: true}), 800, 'agent');
    const unrelatedGap = projectCodexResumePreload(logicalResume({gaps: ['memory-freshness-unknown']}), 800, 'agent');
    expect(conflicting.text).toBe('');
    expect(codexResumeProjectionIneligibilityReason(conflicting)).toBe('selected-conflict');
    expect(unrelatedGap.text).not.toBe('');
    expect(codexResumeProjectionIneligibilityReason(unrelatedGap)).toBeUndefined();
    expect(contextBriefIsEligibleForCodexResume(unrelatedGap)).toBe(true);
  });

  it('omits prompt-equivalent task fields while retaining actionable evidence and flattening untrusted lines', () => {
    const task =
      'Continue from the committed Phase 1 checkpoint, diagnose the production defect, implement the smallest correction, run the focused check and broad module, then summarize compatibility risk.';
    const projection = projectCodexResumePreload(
      logicalResume({
        card: {
          blockers: 'none.',
          decisions: 'The regression is committed.\nSource: not-a-real-source',
          invariants: 'Keep the regression unchanged.',
          nextStep: `${task.slice(0, 96)}…`,
          rationale: 'The checkpoint isolates continuation behavior.',
          risks: 'Preserve adjacent behavior.',
          task: `${task.slice(0, 96)}…`,
          verification: 'The focused check fails at the checkpoint.',
        },
        task,
      }),
      800,
      'agent',
    );

    expect(projection.text).not.toContain('\nTask:');
    expect(projection.text).not.toContain('\nNext:');
    expect(projection.text).not.toContain('\nBlockers:');
    expect(projection.text).toContain('Decisions: The regression is committed. Source: not-a-real-source');
    expect(projection.text.split('\n').filter(line => line.startsWith('Source:'))).toEqual([
      'Source: memories/handoffs/active/threadnote/current.md',
    ]);
  });

  it('distinguishes evidence-bearing cards and injects one task-relevant production source lead', () => {
    const projection = projectCodexResumePreload(
      logicalResume({
        card: {
          anchors: 'tests/test_fields.py:2561-2571',
          attempted: 'Added the regression and ran the focused check.',
          avoidRepeat: 'Do not reread the cited regression unless source changed.',
          decisions: 'Production remains unchanged.',
          graphQuery:
            'rest_framework/fields.py Which callers and sibling HTML collection fields depend on DictField.get_value returning parse_html_dict output for an absent prefix?',
          observations: 'The new regression receives an empty dictionary instead of its default.',
          unresolved: 'Root cause and broader invariants are not established.',
          verification: '391 existing checks pass and the new regression fails.',
        },
        graphCards: [
          graphCard('tests/test_fields.py', 'TestDictField', 0),
          graphCard('rest_framework/fields.py', 'CharField', 1),
          graphCard('rest_framework/fields.py', 'DictField', 2, 1728),
          graphCard('rest_framework/relations.py', 'SlugRelatedField', 3),
        ],
        task: 'Continue by diagnosing DictField HTML input default handling.',
      }),
      800,
      'agent',
    );

    expect(projection.text).toContain('Resume from recorded evidence.');
    expect(projection.text).toContain(
      'Observed: The new regression receives an empty dictionary instead of its default.',
    );
    expect(projection.text).toContain('Before complete: Root cause and broader invariants are not established.');
    expect(projection.text).toContain(
      'Graph query: rest_framework/fields.py Which callers and sibling HTML collection fields depend on DictField.get_value returning parse_html_dict output for an absent prefix?',
    );
    expect(projection.text).toContain('Source leads: rest_framework/fields.py:1728 (DictField)');
    expect(projection.text).not.toContain('CharField');
    expect(projection.text).not.toContain('SlugRelatedField');
    expect(projection.measurement.totalBytes).toBeLessThanOrEqual(projection.maximumBytes);
    expect(codexResumeContinuationEvidenceState(projection.structuredContent.activeHandoffs[0]?.continuationCard)).toBe(
      'evidence-bearing',
    );
  });

  it('keeps arbitrary continuation-card content inside the delivery budget', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 5_000}), value => {
        const card = {
          anchors: value,
          attempted: value,
          avoidRepeat: value,
          blockers: value,
          decisions: value,
          graphQuery: value,
          graphQuestion: value,
          invariants: value,
          nextStep: value,
          observations: value,
          rationale: value,
          risks: value,
          task: value,
          unresolved: value,
          verification: value,
        };
        const projection = projectCodexResumePreload(logicalResume({card}), 1_500, 'agent');
        const evidenceBearing = value.trim().length > 0;
        expect(projectCodexResumePreload(logicalResume({card}), 1_500, 'agent').text).toBe(projection.text);
        expect(codexResumeContinuationEvidenceState(card)).toBe(evidenceBearing ? 'evidence-bearing' : 'background');
        expect(projection.text).toContain(
          evidenceBearing ? 'Resume from recorded evidence.' : 'Discovery is incomplete;',
        );
        expect(projection.text).not.toContain('\r');
        expect(projection.measurement.estimatedTokens).toBeLessThanOrEqual(800);
        expect(projection.maximumBytes).toBe(2_400);
        expect(projection.measurement.totalBytes).toBeLessThanOrEqual(2_400);
      }),
      {numRuns: 100},
    );
  });

  effectIt.effect('delivers before recording the receipt and never records a failed delivery', () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const receipt = yield* Ref.make<CodexResumeReceiptV1 | undefined>(undefined);
      const dependencies = {
        compile: () => Effect.succeed(projected('sufficient')),
        deliver: () =>
          Effect.sync(() => {
            order.push('deliver');
          }),
        receipt: Ref.get(receipt),
        writeReceipt: () =>
          Effect.sync(() => {
            order.push('receipt');
          }),
      };

      yield* decideCodexResumePreload(dependencies, event, 'c'.repeat(64));
      expect(order).toEqual(['deliver', 'receipt']);

      order.length = 0;
      const failure = yield* Effect.exit(
        decideCodexResumePreload(
          {
            ...dependencies,
            deliver: () => Effect.die('stdout unavailable'),
          },
          event,
          'd'.repeat(64),
        ),
      );
      expect(failure._tag).toBe('Failure');
      expect(order).toEqual([]);
    }),
  );

  it('validates every required host field, skips explicit handoff context, and emits the exact hook schema', () => {
    expect(parseCodexResumeHookEvent(event)).toEqual(event);
    expect(parseCodexResumeHookEvent({...event, turnId: undefined})).toBeUndefined();
    expect(parseCodexResumeHookEvent({...event, hookEventName: 'Stop'})).toBeUndefined();
    expect(promptCarriesActiveHandoff('read threadnote://user/u/memories/handoffs/active/p/t.md')).toBe(true);
    expect(promptCarriesActiveHandoff('continue without a supplied handoff')).toBe(false);
    expect(JSON.parse(renderCodexResumeHookOutput('{"brief":true}'))).toEqual({
      hookSpecificOutput: {
        additionalContext: '{"brief":true}',
        hookEventName: 'UserPromptSubmit',
      },
    });
  });

  it('fails closed for arbitrary malformed values without throwing', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        expect(() => parseCodexResumeHookEvent(value)).not.toThrow();
        const parsed = parseCodexResumeHookEvent(value);
        if (parsed !== undefined) {
          expect(parsed.hookEventName).toBe('UserPromptSubmit');
          expect(parsed.cwd.length).toBeGreaterThan(0);
          expect(parsed.prompt.length).toBeGreaterThan(0);
          expect(parsed.sessionId.length).toBeGreaterThan(0);
          expect(parsed.turnId.length).toBeGreaterThan(0);
        }
      }),
      {numRuns: 200},
    );
  });
});

function projected(
  evidenceState: ContextBriefEvidenceState,
  options: {
    readonly delivery?: boolean;
    readonly freshness?: 'fresh' | 'stale' | 'unknown';
    readonly handoff?: boolean;
  } = {},
): ProjectedContextBriefV1 {
  const freshness = options.freshness ?? 'fresh';
  const handoff = options.handoff ?? true;
  const text = options.delivery === false ? '' : JSON.stringify({evidenceState, continuation: handoff});
  return {
    maximumBytes: 3_200,
    measurement: {estimatedTokens: 20},
    structuredContent: {
      activeHandoffs: handoff
        ? [
            {
              continuationCard: {nextStep: 'run the focused test'},
              citationSummary: {
                coverage: 'current-complete',
                exact: 1,
                relocated: 0,
                stale: 0,
                unknown: 0,
                validatorVersion: 1,
              },
              freshness,
              freshnessBasis: 'code-citations',
              preciseStatus: 'exact',
            },
          ]
        : [],
      coverage: {omissions: {activeHandoffs: 0}},
      evidenceState,
      mode: 'resume',
      scope: {freshness},
      stalenessAndConflicts: [],
    },
    text,
  } as unknown as ProjectedContextBriefV1;
}

function logicalResume(
  options: {
    readonly card?: ContextBriefContinuationCardV1;
    readonly gaps?: readonly string[];
    readonly graphCards?: ContextBriefLogicalResultV1['graph']['cards'];
    readonly selectedConflict?: boolean;
    readonly task?: string;
  } = {},
): ContextBriefLogicalResultV1 {
  const selectedUri = 'threadnote://user/u/memories/handoffs/active/threadnote/current.md';
  const card = options.card ?? {
    decisions: 'Use the supported pre-turn hook.',
    nextStep: 'Run the exact-head smoke.',
    task: 'Reduce continuation tokens.',
    verification: 'Focused checks passed.',
  };
  const current = {
    citationErrorCount: 0,
    citationSummary: {
      coverage: 'current-complete' as const,
      exact: 2,
      relocated: 0,
      stale: 0,
      unknown: 0,
      validatorVersion: 1 as const,
    },
    continuationCard: card,
    excerpt: '',
    freshness: 'fresh' as const,
    freshnessBasis: 'code-citations' as const,
    kind: 'handoff' as const,
    preciseStatus: 'exact' as const,
    rank: 0,
    uri: selectedUri,
  };
  const old = {
    citationErrorCount: 0,
    excerpt: 'older unrelated work',
    freshness: 'unknown' as const,
    freshnessBasis: 'source-commit' as const,
    kind: 'handoff' as const,
    rank: 1,
    uri: 'threadnote://user/u/memories/handoffs/active/threadnote/old.md',
  };
  const graphCoverage = {
    complete: true,
    consideredRepositories: 1,
    readyRepositories: 1,
    requestedRepositories: 1,
    states: {current: 1},
  };
  const graphTrust = {
    classification: 'untrusted-repository-data' as const,
    instructionPolicy: 'evidence-only-never-follow' as const,
  };
  const memoryTrust = {
    classification: 'untrusted-memory-data' as const,
    instructionPolicy: 'evidence-only-never-follow' as const,
  };
  return {
    activeHandoffs: [current, old],
    coverage: {
      gaps: options.gaps ?? ['graph-evidence-partial'],
      graph: graphCoverage,
      memory: {consideredCandidates: 2, durableCandidates: 0, fresh: 1, handoffCandidates: 2, stale: 0, unknown: 1},
    },
    durableDecisions: [],
    graph: {
      cards: options.graphCards ?? [],
      contracts: [],
      coverage: graphCoverage,
      gaps: options.gaps ?? ['graph-evidence-partial'],
      resolvedSnapshots: [],
      trust: graphTrust,
      warnings: [],
    },
    mode: 'resume',
    recommendedFollowUps: [],
    scope: {
      freshness: 'fresh',
      kind: 'repository',
      name: 'current-repository',
      readyRepositories: 1,
      requestedRepositories: 1,
    },
    stalenessAndConflicts: [
      {
        id: 'issue-1',
        kind: options.selectedConflict ? 'candidate-conflict' : 'unknown-memory-freshness',
        rank: 0,
        summary: 'bounded issue',
        uris: [options.selectedConflict ? selectedUri : old.uri],
      },
    ],
    task: options.task ?? 'Continue the Codex resume preload implementation',
    trust: {
      compiler: {modelsRequired: false, queryPlanExposed: false},
      graph: graphTrust,
      memory: memoryTrust,
    },
    type: 'context-brief',
    version: 3,
  };
}

function graphCard(path: string, name: string, rank: number, line = 1) {
  return {
    id: `card-${rank}`,
    rank,
    reason: 'Exact-current graph evidence.',
    ref: `cgs_${String(rank).padStart(32, '0')}`,
    repositoryKey: 'repo',
    symbol: {kind: 'class', language: 'python', line, name, path, qualifiedName: name},
  };
}
