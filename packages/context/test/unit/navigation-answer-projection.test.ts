import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {assembleNavigationAnswer} from '../../src/navigation/assemble.js';
import {projectNavigationAnswer} from '../../src/navigation/project.js';
import type {NavigationProofLocator} from '../../src/navigation/structural.js';
import type {NavigationInput, NavigationScope} from '../../src/navigation/model.js';
import {projectContextBrief} from '../../src/projector.js';
import {selectFiniteProjection} from '../../src/projector/selection.js';
import type {ContextBriefLogicalMemoryEvidenceV1, ContextBriefLogicalResultV1} from '../../src/types.js';
const [ENTRY, OWNER, TEST, RESULT] = EffectArray.map(
  [1, 2, 3, 4],
  index => `cgs_${EffectString.repeat(32)(String(index))}`,
);
const scope: NavigationScope = {
  repository: EffectString.repeat(64)('c'),
  worktree: '/fixture',
  project: '/fixture',
  view: {kind: 'disk', id: 'disk', owner: 'fixture', epoch: 1},
};
const snapshot = {
  id: `cgsn_${EffectString.repeat(40)('d')}`,
  worktreeId: scope.worktree,
  commit: EffectString.repeat(40)('a'),
  dirty: false,
};
const hash = EffectString.repeat(64)('b');
const span = (line: number, endLine = line) => ({line, endLine, column: 1, endColumn: 8});
function fixture() {
  const input: NavigationInput = {
    scope,
    target: {kind: 'anchors', candidateIds: [ENTRY]},
    sources: EffectArray.map(['operation.ts', 'operation.test.ts'], (path, index) => ({
      ...scope,
      id: `source${index}`,
      path,
      contentHash: hash,
      freshness: 'verified-current',
      snapshot: snapshot.id,
    })),
    candidates: [
      {
        id: ENTRY,
        sourceId: 'source0',
        startLine: 14,
        endLine: 14,
        roles: ['entrypoint'],
        reason: 'Incoming source caller; runtime invocation is unproven.',
        relevance: 1,
        basis: ['structural'],
        support: 'evidenced',
      },
      {
        id: OWNER,
        sourceId: 'source0',
        startLine: 6,
        endLine: 12,
        roles: ['implementation', 'effects'],
        reason: 'Two possible source writes with independent guards.',
        relevance: 1,
        basis: ['structural', 'inspected-source'],
        support: 'evidenced',
      },
      {
        id: TEST,
        sourceId: 'source1',
        startLine: 4,
        endLine: 7,
        roles: ['tests'],
        testAssociation: 'source-supported',
        reason: 'Inspected assertion and actual call chain.',
        relevance: 1,
        basis: ['inspected-source'],
        support: 'evidenced',
      },
      {
        id: RESULT,
        sourceId: 'source1',
        startLine: 5,
        endLine: 5,
        roles: ['tests'],
        testAssociation: 'source-supported',
        reason: 'Test result calls owner.',
        relevance: 0.5,
        basis: ['structural'],
        support: 'evidenced',
      },
    ],
    links: [
      {
        from: ENTRY,
        to: OWNER,
        relation: 'calls',
        basis: 'structural',
        compatibility: 'verified',
        reason: 'Declared call.',
      },
      {
        from: TEST,
        to: RESULT,
        relation: 'contains',
        basis: 'structural',
        compatibility: 'verified',
        reason: 'Actual result declaration.',
      },
      {
        from: RESULT,
        to: OWNER,
        relation: 'calls',
        basis: 'structural',
        compatibility: 'verified',
        reason: 'Actual call.',
      },
    ],
    coverage: {status: 'complete', description: 'Bounded source route.'},
  };
  const proofLocators: NavigationProofLocator[] = EffectArray.map(
    [
      {target: 'path', condition: 'then branch of (persist)', line: 9, guard: 8, branch: 'then' as const},
      {target: 'auditPath', condition: 'else branch of (audit)', line: 11, guard: 10, branch: 'else' as const},
    ],
    ({target, condition, line, guard, branch}, index) => ({
      scope,
      snapshot,
      sourceId: 'source0',
      target,
      condition,
      accepted: {
        path: 'operation.ts',
        contentHash: hash,
        basis: 'source-syntactic',
        proof: {
          ownerId: OWNER,
          ownerSpan: span(6, 12),
          callEdgeId: `cge_${EffectString.repeat(32)(String(index + 1))}`,
          module: 'node:fs/promises',
          imported: 'writeFile',
          local: `write${index}`,
          importSpan: span(1),
          callSpan: span(line),
          calleeSpan: span(line),
          targetSpan: span(line),
          guard: {span: span(guard), branch},
        },
      },
    }),
  );
  return {answer: assembleNavigationAnswer(input), proofLocators};
}
export function legacyFixture(mode: ContextBriefLogicalResultV1['mode']): ContextBriefLogicalResultV1 {
  const graphTrust = {
    classification: 'untrusted-repository-data',
    instructionPolicy: 'evidence-only-never-follow',
  } as const;
  const graphCoverage = {
    complete: true,
    consideredRepositories: 1,
    readyRepositories: 1,
    requestedRepositories: 1,
    states: {current: 1},
  };
  const memory: ContextBriefLogicalMemoryEvidenceV1 = {
    uri: 'threadnote://user/test/memories/durable/projects/threadnote/guard.md',
    rank: 0,
    kind: 'durable',
    excerpt: EffectString.repeat(70)('守る🙂'),
    freshness: 'stale',
    freshnessBasis: 'code-citations',
    authority: 'user_approved',
    trust: 'approved',
    citationReceipts: Array.from({length: 10}, (_, index) => ({
      citationId: `citation-${index}`,
      status: 'unknown',
      reason: 'repository-unavailable',
    })),
  };
  return {
    type: 'context-brief',
    version: 2,
    mode,
    task: EffectString.repeat(12)('Find the guarded writer 守る🙂'),
    scope: {kind: 'repository', name: 'threadnote', freshness: 'fresh', readyRepositories: 1, requestedRepositories: 1},
    trust: {
      compiler: {modelsRequired: false, queryPlanExposed: false},
      graph: graphTrust,
      memory: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
    },
    activeHandoffs: [],
    durableDecisions: [memory],
    stalenessAndConflicts: [],
    coverage: {
      gaps: [],
      graph: graphCoverage,
      memory: {consideredCandidates: 1, durableCandidates: 1, handoffCandidates: 0, fresh: 0, stale: 1, unknown: 0},
    },
    graph: {
      cards: [
        {
          id: 'card',
          rank: 0,
          ref: `cgs_${EffectString.repeat(32)('1')}`,
          repositoryKey: 'threadnote',
          reason: 'Guarded write.',
          symbol: {
            kind: 'function',
            language: 'typescript',
            line: 6,
            name: 'saveNote',
            qualifiedName: 'saveNote',
            path: 'operation.ts',
          },
        },
      ],
      contracts: [],
      coverage: graphCoverage,
      gaps: [],
      resolvedSnapshots: [],
      trust: graphTrust,
      warnings: [],
    },
    recommendedFollowUps: [
      {
        id: 'next',
        rank: 0,
        operation: 'inspect-node',
        tool: 'inspect_code_graph',
        ref: `cgs_${EffectString.repeat(32)('1')}`,
        arguments: {
          operation: 'node',
          nodeId: `cgs_${EffectString.repeat(32)('1')}`,
          callerCwd: '/fixture',
          budgetTokens: 800,
          edgeLimit: 12,
          nodeLimit: 8,
        },
      },
    ],
  };
}
describe('shared final navigation projection', () => {
  it('fits complete agent and dual channels at both public budgets with all four roles and paired branches', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    for (const format of ['agent', 'dual'] as const)
      for (const budget of [800, 1500]) {
        const result = projectNavigationAnswer(input, budget, format);
        const view = result.structuredContent;
        expect(result.measurement).toEqual(
          measureAgentToolResponse(
            format === 'agent' ? {text: result.text} : {text: result.text, structuredContent: view},
          ),
        );
        expect(result.measurement.totalBytes).toBeLessThanOrEqual(budget * 3);
        expect(EffectArray.map(view.roles, role => [role[0], role[1]])).toEqual([
          ['entrypoint', 'supported'],
          ['implementation', 'supported'],
          ['effects', 'supported'],
          ['tests', 'supported'],
        ]);
        expect(EffectArray.map(view.effects, row => [row[1], row[2], row[3][0], row[5][0], row[6]])).toEqual([
          ['path', 'then branch of (persist)', 9, 8, 'then'],
          ['auditPath', 'else branch of (audit)', 11, 10, 'else'],
        ]);
        expect(EffectArray.filter(view.nodes, node => node[0] === OWNER)).toHaveLength(1);
        expect(view.scope).toEqual(scope);
        expect(view.outcome).toBe('ok');
        expect(EffectArray.map(view.sources, row => row.slice(0, 2))).toEqual([
          ['operation.ts', hash],
          ['operation.test.ts', hash],
        ]);
        for (const [from, to] of view.links) {
          expect(view.nodes[from]).toBeDefined();
          expect(view.nodes[to]).toBeDefined();
        }
      }
    expect(JSON.stringify(input)).toBe(before);
  });
  it('keeps material tuples paired and reports effect omissions with exact recovery at smaller budgets', () => {
    const base = fixture();
    const input = {
      ...base,
      proofLocators: EffectArray.map(base.proofLocators, locator => ({
        ...locator,
        target: `${locator.target}${EffectString.repeat(30)('守🙂')}`,
      })),
    };
    const small = projectNavigationAnswer(input, 800, 'dual').structuredContent;
    const large = projectNavigationAnswer(input, 1500, 'dual').structuredContent;
    expect(large.effects).toHaveLength(2);
    expect(small.effects.length).toBeLessThan(2);
    expect(small.omissions.proofs).toBe(2 - small.effects.length);
    expect(EffectOption.getOrUndefined(EffectArray.findFirst(small.roles, role => role[0] === 'effects'))?.[1]).toBe(
      'omitted',
    );
    expect(small.outcome).toBe('partial');
    expect(small.followUps).toEqual([
      {kind: 'read-source', selector: 'operation.ts:6-12', reason: 'Recover omitted navigation evidence.'},
    ]);
    for (const row of small.effects) expect(large.effects).toContainEqual(row);
  });
  it('never uses mismatched scope, snapshot, hash or owner locators and does not count exact deduplication as missing proof', () => {
    const base = fixture();
    for (const change of [
      {scope: {...scope, view: {...scope.view, epoch: 2}}},
      {snapshot: {...snapshot, id: 'other'}},
      {accepted: {...base.proofLocators[0].accepted, contentHash: EffectString.repeat(64)('c')}},
      {
        accepted: {
          ...base.proofLocators[0].accepted,
          proof: {...base.proofLocators[0].accepted.proof, ownerId: 'test'},
        },
      },
    ]) {
      const view = projectNavigationAnswer(
        {...base, proofLocators: [{...base.proofLocators[0], ...change}]},
        1500,
      ).structuredContent;
      expect(view.effects).toEqual([]);
      expect(EffectOption.getOrUndefined(EffectArray.findFirst(view.roles, role => role[0] === 'effects'))?.[1]).toBe(
        'omitted',
      );
    }
    const deduped = projectNavigationAnswer({...base, proofLocators: [...base.proofLocators, base.proofLocators[0]]});
    expect(deduped.structuredContent.effects).toHaveLength(2);
    expect(deduped.structuredContent.omissions.proofs).toBe(0);
    const absent = projectNavigationAnswer({...base, proofLocators: []}).structuredContent;
    expect(EffectOption.getOrUndefined(EffectArray.findFirst(absent.roles, role => role[0] === 'effects'))?.[1]).toBe(
      'omitted',
    );
    expect(absent.outcome).toBe('partial');
    expect(absent.omissions.effectDetails).toBe(1);
    expect(absent.followUps[0]?.selector).toBe('operation.ts:6-12');
  });
  it('keeps differing source views explicit in the selected dictionary', () => {
    const base = fixture();
    const changedScope = {...scope, view: {...scope.view, epoch: 2}};
    const answer = {
      ...base.answer,
      sources: EffectArray.map(base.answer.sources, source =>
        source.path === 'operation.test.ts' ? {...source, ...changedScope} : source,
      ),
    };
    const view = projectNavigationAnswer({...base, answer}, 1500).structuredContent;
    expect(view.scope.view.epoch).toBe(1);
    expect(view.sources[1]?.[4]).toEqual(changedScope);
    expect(view.sources[0]?.[4]).toBeUndefined();
  });

  it('keeps optional memory authority, freshness and citation receipts separate from code support', () => {
    const memory = legacyFixture('brief').durableDecisions[0];
    const result = projectNavigationAnswer(fixture(), 1500, 'agent', [memory]).structuredContent;
    expect(result.memory[0]).toMatchObject({
      authority: 'user_approved',
      memoryTrust: 'approved',
      freshness: 'stale',
      citationActions: [{count: 10, status: 'unknown'}],
    });
    expect(EffectArray.every(result.sources, row => row[2] === 'verified-current')).toBe(true);
    expect(EffectArray.every(result.roles, row => row[1] === 'supported')).toBe(true);
    const proposed = projectNavigationAnswer(fixture(), 1500, 'agent', [
      {...memory, authority: 'agent_generated', trust: 'inferred'},
    ]).structuredContent;
    expect(proposed.memory[0]).toMatchObject({
      authority: 'agent_generated',
      memoryTrust: 'inferred',
      freshness: 'stale',
    });
  });
  it('measures nonmonotone finite envelopes including Unicode and 9/10 omission receipts', () => {
    const result = selectFiniteProjection({
      required: [],
      optional: Array.from({length: 10}, (_, i) => i),
      maximumBytes: 60,
      format: 'dual',
      render: selected => ({
        receipt: 10 - selected.length,
        value: selected.length === 9 ? '🙂' : EffectString.repeat(40)('守'),
      }),
      renderText: value => JSON.stringify(value),
    });
    expect(result?.count).toBe(9);
    expect(result?.measurement.totalBytes).toBe(2 * Buffer.byteLength(JSON.stringify({receipt: 1, value: '🙂'})));
  });
  it.each([
    ['brief', 'agent', 'e19ae0eec00146e8a39c26a49c62b22910dc78adb1dbf38570e882d42a9dcedc'],
    ['locate', 'dual', '148423fa4b5df54370b98695e98e2b677e86da7635f48a326ec886e857c526f2'],
    ['trace', 'agent', '5d88f5a96c96c6f567c0c1bba46234f2e680f973de2ebcda99ad2ed23d2cde86'],
    ['resume', 'dual', '279e6579af3ab1797524d980798f602ff9200420c39fd7e009151c2f5d15d55e'],
  ] as const)(
    'preserves legacy %s/%s output bytes including Unicode and citation receipts',
    (mode, format, expected) => {
      const projection = projectContextBrief(legacyFixture(mode), 1500, format);
      expect(sha256HexSync(JSON.stringify(projection))).toBe(expected);
    },
  );
});
