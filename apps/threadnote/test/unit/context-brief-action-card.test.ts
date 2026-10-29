import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {parseMemoryActionCard} from '@threadnote/context/memory-evidence';
import {parseContextBriefV1} from '@threadnote/context/projector';
import {
  classifyCodeBriefEditDelivery,
  renderCodeBriefEditContext,
} from '@threadnote/threadnote/context_brief/edit_hook';
import type {ContextBriefMemoryEvidenceV1, ContextBriefV1} from '@threadnote/context/types';
import {Array as EffectArray} from 'effect';

const memory = {
  actionCard: {
    appliesTo: 'Catalog edits',
    invariant: 'Keep the stable key.',
    verify: 'Run the focused catalog test.',
  },
  codeRelations: [{anchorOrdinal: 0, citationId: 'tncc_test', kind: 'file', status: 'exact'}],
  excerpt: 'Catalog identity is stable.',
  freshness: 'fresh',
  freshnessBasis: 'code-citations',
  kind: 'durable',
  preciseStatus: 'exact',
  rank: 0,
  selectionBasis: 'code-citation',
  uri: 'threadnote://memory/tn_test',
} as ContextBriefMemoryEvidenceV1;

function briefWith(memoryEvidence: ContextBriefMemoryEvidenceV1): ContextBriefV1 {
  const brief = {
    activeHandoffs: [],
    coverage: {
      gaps: [],
      graph: {
        complete: true,
        consideredRepositories: 1,
        readyRepositories: 1,
        requestedRepositories: 1,
        states: {current: 1},
      },
      memory: {
        codeAnchors: {complete: true, matchedMemories: 1, requested: 1, resolved: 1},
        consideredCandidates: 1,
        durableCandidates: 1,
        fresh: memoryEvidence.freshness === 'fresh' ? 1 : 0,
        handoffCandidates: 0,
        stale: memoryEvidence.freshness === 'stale' ? 1 : 0,
        unknown: memoryEvidence.freshness === 'unknown' ? 1 : 0,
      },
      omissions: {
        activeHandoffs: 0,
        coverageGaps: 0,
        durableDecisions: 0,
        graphCards: 0,
        graphContracts: 0,
        recommendedFollowUps: 0,
        stalenessAndConflicts: 0,
      },
    },
    durableDecisions: [memoryEvidence],
    evidenceState: 'sufficient',
    graph: {cards: [], contracts: []},
    mode: 'brief',
    output: {omittedItems: 0, projectorVersion: 3, returnedItems: 1, truncated: false},
    recommendedFollowUps: [],
    scope: {
      freshness: 'fresh',
      kind: 'repository',
      name: 'action-card-fixture',
      readyRepositories: 1,
      requestedRepositories: 1,
    },
    stalenessAndConflicts: [],
    task: {summary: 'Action card test', truncated: false},
    trust: {
      compiler: {modelsRequired: false, queryPlanExposed: false},
      graph: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
      memory: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
    },
    type: 'context-brief',
    version: 3,
  } satisfies ContextBriefV1;
  // Model the wire's omission of optional undefined fields before validating the response.
  return parseContextBriefV1(JSON.parse(JSON.stringify(brief)));
}

describe('Context Brief action cards', () => {
  it('extracts only explicit bounded fields', () => {
    expect(
      parseMemoryActionCard(
        'A narrative line.\n## Applies to: Catalog edits\n## Invariant: Keep the stable key.\nAvoid: Resetting identity.\nVerify: Run focused tests.',
      ),
    ).toEqual({
      appliesTo: 'Catalog edits',
      invariant: 'Keep the stable key.',
      avoid: 'Resetting identity.',
      verify: 'Run focused tests.',
    });
    expect(parseMemoryActionCard('## Applies to: Catalog edits\nA vague story without an invariant.')).toBeUndefined();
    expect(
      parseMemoryActionCard('```text\nApplies to: sample\nInvariant: quoted code\n```\nA narrative line.'),
    ).toBeUndefined();
    expect(
      parseMemoryActionCard('````text\n~~~\nApplies to: sample\nInvariant: quoted code\n```\n````'),
    ).toBeUndefined();
    expect(parseMemoryActionCard('~~~text\n```\nApplies to: sample\nInvariant: quoted code\n~~~')).toBeUndefined();
    expect(parseMemoryActionCard('- ```text\n  Applies to: sample\n  Invariant: quoted code\n  ```')).toBeUndefined();
    expect(parseMemoryActionCard('> ```text\n> Applies to: sample\n  Invariant: quoted code\n> ```')).toBeUndefined();
  });

  it('delivers only current direct evidence and includes a validation hint', () => {
    expect(renderCodeBriefEditContext(briefWith(memory))).toContain(
      'Verify after the edit: Run the focused catalog test.',
    );
    expect(renderCodeBriefEditContext(briefWith({...memory, freshness: 'stale'}))).toBeUndefined();
    expect(renderCodeBriefEditContext(briefWith({...memory, preciseStatus: 'relocated'}))).toBeUndefined();
    expect(renderCodeBriefEditContext(briefWith({...memory, preciseStatus: undefined}))).toContain(
      'Verify after the edit: Run the focused catalog test.',
    );
    expect(renderCodeBriefEditContext(briefWith({...memory, selectionBasis: undefined}))).toBeUndefined();
    expect(renderCodeBriefEditContext(briefWith({...memory, codeRelations: []}))).toBeUndefined();
    expect(classifyCodeBriefEditDelivery(briefWith(memory)).status).toBe('delivered');
    expect(classifyCodeBriefEditDelivery(briefWith({...memory, freshness: 'stale'})).status).toBe('unsafe-link');
    expect(classifyCodeBriefEditDelivery(briefWith({...memory, preciseStatus: undefined})).status).toBe('delivered');
    expect(classifyCodeBriefEditDelivery(briefWith({...memory, codeRelations: []})).status).toBe('unsafe-link');
    expect(classifyCodeBriefEditDelivery(briefWith({...memory, selectionBasis: undefined})).status).toBe(
      'evidence-omitted',
    );
  });

  it('keeps parsed fields bounded for arbitrary Unicode content', () => {
    const unicodeField = fc
      .tuple(
        fc.constantFrom('a', 'é', '🚀', '文', '🧪'),
        fc.array(fc.constantFrom('a', 'é', '🚀', '文', '🧪', ' '), {maxLength: 200}),
      )
      .map(([first, rest]) => first + EffectArray.join(rest, ''));
    fc.assert(
      fc.property(unicodeField, value => {
        const card = parseMemoryActionCard(`Applies to: target\nInvariant: ${value}\nVerify: ${value}`);
        expect(card).toBeDefined();
        if (card === undefined) throw new Error('A valid Unicode card was rejected.');
        expect(new TextEncoder().encode(card.invariant).byteLength).toBeLessThanOrEqual(96);
        expect(new TextEncoder().encode(card.verify).byteLength).toBeLessThanOrEqual(96);
      }),
      {numRuns: 100},
    );
  });
});
