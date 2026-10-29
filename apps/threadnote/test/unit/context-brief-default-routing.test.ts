import {provideTestLayer} from '../helpers/effect-layer.js';
import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect, vi} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {compileContextBriefWith} from '@threadnote/context/compiler';
import {parseContextBriefV1} from '@threadnote/context/projector';
import type {
  ContextBriefGraphEvidenceV1,
  ContextBriefMemoryRetrievalV1,
  ContextBriefRequestV1,
} from '@threadnote/context/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runContextBrief} from '@threadnote/threadnote/context_brief/commands';
import {managerContextBriefInput, runManagerContextBrief} from '@threadnote/threadnote/manager/context';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const controls = vi.hoisted(() => ({
  empty: false,
  freshness: 'fresh' as 'fresh' | 'stale',
  requests: Array.from<ContextBriefRequestV1>([]),
  output: '',
}));
vi.mock('@threadnote/threadnote/effect/cli/output', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/effect/cli/output')>();
  const {Effect: MockEffect} = await import('effect');
  return {
    ...actual,
    writeFinalCliOutput: (text: string) =>
      MockEffect.sync(() => {
        controls.output = text;
      }),
  };
});
vi.mock('@threadnote/threadnote/context_brief/index', () => ({
  compileContextBrief: (_config: unknown, request: ContextBriefRequestV1) =>
    Effect.gen(function* () {
      controls.requests.push(request);
      return yield* compileContextBriefWith(
        {
          graphEvidence: () => Effect.succeed(graph()),
          memoryEvidence: () => Effect.succeed(memory()),
        },
        request,
      );
    }),
}));
const COMMIT = Effect2.pipe('a', EffectString.repeat(40));
const CWD = '/workspace/pricing';
const TASK = 'Continue pricing input validation and aggregate discount decisions.';
// The command always receives a fixed cwd; the test layer supplies its remaining SystemInfo requirement.
const runFixtureCli = (config: Parameters<typeof runContextBrief>[0], options: Parameters<typeof runContextBrief>[1]) =>
  runContextBrief(config, options).pipe(provideTestLayer(ApplicationLayer));
const runFixtureManager = (...args: Parameters<typeof runManagerContextBrief>) =>
  runManagerContextBrief(...args).pipe(provideTestLayer(ApplicationLayer));
const config = {
  account: 'local',
  agentContextHome: '/unused',
  agentId: 'codex',
  manifestPath: '/unused/manifest.yaml',
  user: 'test',
};
const body = (budgetTokens: number) => ({
  budgetTokens,
  callerCwd: CWD,
  mode: 'resume',
  project: 'pricing',
  task: TASK,
});

const captureCli = (budgetTokens: number, json = false) =>
  Effect.gen(function* () {
    controls.output = '';
    yield* runFixtureCli(config, {
      budgetTokens,
      cwd: CWD,
      json,
      mode: 'resume',
      project: 'pricing',
      task: TASK,
    });
    return controls.output;
  });
const reset = (empty = false, freshness: 'fresh' | 'stale' = 'fresh') => {
  controls.empty = empty;
  controls.freshness = freshness;
  controls.requests = [];
  controls.output = '';
};

describe('Context Brief surface defaults', () => {
  for (const budget of [800, 1_250, 1_500]) {
    effectIt.effect(`keeps useful default CLI and Manager resume evidence at ${budget} tokens`, () =>
      Effect.gen(function* () {
        reset();
        const text = yield* captureCli(budget);
        const json = parseContextBriefV1(JSON.parse(yield* captureCli(budget, true)));
        const manager = yield* runFixtureManager(config, body(budget));
        expect(EffectArray.map(controls.requests, request => request.responseFormat)).toEqual([
          'agent',
          'agent',
          'agent',
        ]);
        expect(managerContextBriefInput(body(budget)).responseFormat).toBe('agent');
        expect(text).toBe(Effect2.pipe(manager.text, EffectString.trimEnd));
        expect(json).toEqual(manager.structuredContent);
        expect(json.activeHandoffs).toHaveLength(1);
        expect(json.durableDecisions.length).toBeGreaterThan(0);
        expect(json.graph.cards.length).toBeGreaterThan(0);
        expect(json.evidenceState).not.toBe('no-match');
        expect(json.coverage.omissions.graphCards).toBe(graph().cards.length - json.graph.cards.length);
        expect(manager.measurement.textBytes).toBe(Buffer.byteLength(manager.text));
        expect(manager.measurement.totalBytes).toBeLessThanOrEqual(budget * 3);
      }),
    );
  }

  fcEffectProp(
    effectIt,
    'preserves format-specific bounds, honest no-answer and stale state across supported budgets',
    {
      budget: fc.integer({min: 800, max: 1_500}),
      empty: fc.boolean(),
      freshness: fc.constantFrom('fresh' as const, 'stale' as const),
    },
    ({budget, empty, freshness}) =>
      Effect.gen(function* () {
        reset(empty, freshness);
        const manager = yield* runFixtureManager(config, body(budget));
        const input = managerContextBriefInput(body(budget));
        const agent = yield* compileContextBriefWith(
          {
            graphEvidence: () => Effect.succeed(graph()),
            memoryEvidence: () => Effect.succeed(memory()),
          },
          {...input, responseFormat: 'agent'},
        );
        const dual = yield* compileContextBriefWith(
          {
            graphEvidence: () => Effect.succeed(graph()),
            memoryEvidence: () => Effect.succeed(memory()),
          },
          {...input, responseFormat: 'dual'},
        );
        expect(manager).toEqual(agent);
        for (const projected of [agent, dual]) {
          const brief = parseContextBriefV1(projected.structuredContent);
          expect(projected.measurement.totalBytes).toBeLessThanOrEqual(budget * 3);
          expect(brief.coverage.memory.consideredCandidates).toBe(empty ? 0 : 3);
          expect(brief.coverage.omissions.activeHandoffs).toBe(empty ? 0 : 1 - brief.activeHandoffs.length);
          expect(brief.coverage.omissions.durableDecisions).toBe(empty ? 0 : 2 - brief.durableDecisions.length);
          if (empty) expect(brief.evidenceState).toBe('no-match');
          else if (
            freshness === 'stale' &&
            brief.graph.cards.length + brief.activeHandoffs.length + brief.durableDecisions.length > 0
          )
            expect(brief.evidenceState).toBe('degraded');
        }
        expect(JSON.parse(dual.text)).toMatchObject({type: 'context-brief-agent-view'});
        expect(dual.measurement.structuredBytes).toBe(Buffer.byteLength(JSON.stringify(dual.structuredContent)));
      }),
    {fastCheck: {numRuns: 40}},
  );
});

function graph(): ContextBriefGraphEvidenceV1 {
  const empty = controls.empty;
  return {
    cards: empty
      ? []
      : Array.from({length: 3}, (_, rank) => ({
          id: `card-${rank}`,
          rank,
          reason: 'Pricing source match.',
          ref: `cgs_${Effect2.pipe(String(rank + 1), EffectString.repeat(32))}`,
          repositoryKey: 'pricing',
          symbol: {
            kind: 'function',
            language: 'typescript',
            line: 1,
            name: `price${rank}`,
            path: 'src/pricing.ts',
            qualifiedName: `price${rank}`,
          },
        })),
    contracts: [],
    coverage: {
      complete: true,
      consideredRepositories: 1,
      readyRepositories: 1,
      requestedRepositories: 1,
      states: {current: 1},
    },
    gaps: [],
    resolvedSnapshots: [
      {
        commit: COMMIT,
        dirty: false,
        freshness: controls.freshness,
        repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
        repositoryKey: 'pricing',
        snapshotId: 'cgsn_test',
      },
    ],
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    warnings: [],
  };
}
function memory(): ContextBriefMemoryRetrievalV1 {
  return {
    candidates: controls.empty
      ? []
      : EffectArray.map(['handoff', 'durable', 'durable'] as const, (kind, rank) => ({
          citationErrorCount: 0,
          codeCitations: [],
          excerpt: 'Preserve validation; apply aggregate discount once.',
          kind,
          project: 'pricing',
          rank,
          sourceCommit: COMMIT,
          topic: `pricing-${rank}`,
          uri: `threadnote://user/test/memories/${kind === 'handoff' ? 'handoffs/active' : 'durable/projects'}/pricing/decision-${rank}.md`,
          ...(kind === 'handoff'
            ? {
                continuationCard: {
                  task: TASK,
                  decisions: 'Validate inputs and aggregate once.',
                  nextStep: 'Check discount behavior.',
                },
              }
            : {}),
        })),
    consideredCandidates: controls.empty ? 0 : 3,
    gaps: [],
    trust: {
      classification: 'untrusted-memory-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
  };
}
