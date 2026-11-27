import {describe, expect, it} from '@effect/vitest';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, Fiber} from 'effect';
import * as EffectString from 'effect/String';
import type {CodeGraphQueryResult} from '@threadnote/graph/types';
import {TestClock} from 'effect/testing';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {readDeadlineRemaining} from '@threadnote/platform/read_deadline';
import {assembleNavigationAnswer} from '../../src/navigation/assemble.js';
import {
  decodeNavigationContinuation,
  encodeNavigationContinuation,
  navigationRelativePath,
} from '../../src/navigation/continuation.js';
import {compileContextBriefNavigationWith, type NavigationLaneDependencies} from '../../src/navigation/lane.js';
import type {NavigationInput, NavigationScope} from '../../src/navigation/model.js';
import {admitNavigationRead, type NavigationReadEvidenceV1} from '../../src/navigation/read.js';
import {parseContextBriefNavigationRequestV1} from '../../src/navigation/request.js';
import type {NavigationSemanticRequestV1} from '../../src/navigation/semantic.js';
import {parseContextBriefRequestV1, type ContextBriefMemoryRetrievalV1} from '../../src/types.js';
import {fromRepositoryQuery} from '../../src/graph/evidence.js';

const ENTRY = 'cgs_00000000000000000000000000000001';
const WRITE = 'cgs_00000000000000000000000000000002';
const scope: NavigationScope = {
  repository: 'repository-id',
  worktree: 'worktree-id',
  project: 'repository',
  view: {kind: 'disk', id: 'saved', owner: 'graph', epoch: 0},
};
const identity: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId: 'checkout-id',
  displayName: 'fixture',
  gitCommonDirectory: '/fixture/.git',
  headCommit: EffectString.repeat(40)('a'),
  objectFormat: 'sha1',
  repoRoot: '/fixture',
  repositoryId: 'repository-id',
  worktreeId: 'worktree-id',
};
const observation = {
  repository: {repositoryId: 'repository-id', displayName: 'fixture'},
  snapshot: {id: 'snapshot-id', commit: EffectString.repeat(40)('a'), worktreeId: 'worktree-id', dirty: false},
  freshness: 'current' as const,
};
const span = (line: number) => ({line, column: 1, endLine: line, endColumn: 20});

function input(target = 'path'): NavigationInput {
  const source = {...scope, id: 'store-source', path: 'src/store.ts', contentHash: 'store-hash'};
  return {
    scope,
    target: {kind: 'task'},
    sources: [{...source, freshness: 'verified-current', snapshot: 'snapshot-id'}],
    candidates: [
      {
        id: ENTRY,
        sourceId: 'store-source',
        startLine: 3,
        endLine: 3,
        roles: ['entrypoint'],
        reason: 'Entrypoint.',
        relevance: 1,
        basis: ['structural'],
        support: 'evidenced',
      },
      {
        id: WRITE,
        sourceId: 'store-source',
        startLine: 9,
        endLine: 9,
        roles: ['implementation', 'effects'],
        reason: 'Possible write.',
        relevance: 0.9,
        basis: ['structural', 'inspected-source'],
        support: 'evidenced',
        possibleEffect: {kind: 'durable-write', target, condition: 'then branch of (persist)'},
      },
    ],
    links: [
      {from: ENTRY, to: WRITE, relation: 'calls', basis: 'structural', compatibility: 'verified', reason: 'Call.'},
    ],
    coverage: {status: 'complete', description: 'Fixture.'},
  };
}

const node = (id: string, name: string, line: number) => ({
  id,
  name,
  qualifiedName: name,
  kind: 'function',
  language: 'typescript',
  path: 'src/store.ts',
  contentHash: 'store-hash',
  exported: true,
  span: span(line),
  score: 1,
});
function evidence(target = 'path'): NavigationReadEvidenceV1 {
  return {
    status: 'ok',
    identity,
    observation,
    repositoryIdentityKind: 'local',
    input: input(target),
    proofLocators: [],
    proofContext: {symbols: [], edges: []},
    anchors: [
      {candidateId: ENTRY, path: 'src/store.ts', contentHash: 'store-hash', name: 'save', span: span(3)},
      {candidateId: WRITE, path: 'src/store.ts', contentHash: 'store-hash', name: 'write', span: span(9)},
    ],
    graph: fromRepositoryQuery({
      ...observation,
      version: 1,
      operation: 'query',
      nodes: [node(ENTRY, 'save', 3), node(WRITE, 'write', 9)],
      edges: [],
      trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
      warnings: [],
    } satisfies CodeGraphQueryResult),
  };
}
const memory: ContextBriefMemoryRetrievalV1 = {
  candidates: [],
  consideredCandidates: 0,
  gaps: [],
  trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
};
const request = (extra: Record<string, unknown> = {}) => ({
  mode: 'navigate',
  task: 'Where does save write the store file?',
  scope: {kind: 'repository', callerCwd: '/fixture'},
  budgetTokens: 1250,
  responseFormat: 'dual',
  ...extra,
});
const deps = (overrides: Partial<NavigationLaneDependencies> = {}): NavigationLaneDependencies => ({
  navigationEvidence: () => Effect.succeed(evidence()),
  memoryEvidence: () => Effect.succeed(memory),
  ...overrides,
});

describe('navigate request', () => {
  it('accepts a continuation only with mode navigate and keeps the other modes strict', () => {
    expect(
      parseContextBriefNavigationRequestV1(request({continuation: {token: 'abc', focus: 'effects'}})),
    ).toMatchObject({mode: 'navigate', continuation: {token: 'abc', focus: 'effects'}, responseFormat: 'dual'});
    expect(() =>
      parseContextBriefRequestV1({...request({continuation: {token: 'abc', focus: 'effects'}}), mode: 'brief'}),
    ).toThrow(/continuation/u);
    for (const extra of [
      {detail: 'source'},
      {surface: 'codex'},
      {continuation: {token: 'abc', focus: 'routes'}},
      {continuation: {token: 'abc', focus: 'effects', extra: 1}},
      {continuation: {token: EffectString.repeat(1025)('a'), focus: 'effects'}},
    ])
      expect(() => parseContextBriefNavigationRequestV1(request(extra))).toThrow(/Invalid Context Brief request/u);
  });
});

describe('navigation continuation token', () => {
  it('round-trips the write boundary and refuses every malformed or escaping token', () => {
    const answer = assembleNavigationAnswer(input());
    const token = encodeNavigationContinuation(answer)!;
    expect(token.length).toBeLessThanOrEqual(1024);
    expect(decodeNavigationContinuation(token)).toEqual({
      summary: expect.objectContaining({status: 'supported'}),
      locators: [{nodeId: WRITE, path: 'src/store.ts'}],
    });
    const wire = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const [, scopeDigest, status, digest] = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    for (const bad of [
      'not base64!',
      wire([1, scopeDigest, status, digest, [[WRITE, 'src/store.ts']], 'extra']),
      wire([2, scopeDigest, status, digest, []]),
      wire([1, scopeDigest, status, digest, [[WRITE, '../outside.ts']]]),
      wire([1, scopeDigest, status, digest, [[WRITE, '/etc/passwd']]]),
      wire([1, scopeDigest, status, digest, [[WRITE, 'src\\store.ts']]]),
      wire([1, scopeDigest, status, digest, [['not-a-node', 'src/store.ts']]]),
      wire([
        1,
        scopeDigest,
        status,
        digest,
        [
          [WRITE, 'src/store.ts'],
          [WRITE, 'src/store.ts'],
        ],
      ]),
      EffectString.repeat(1025)('A'),
    ])
      expect(decodeNavigationContinuation(bad)).toBeUndefined();
    expect(navigationRelativePath('src/./store.ts')).toBe(false);
    expect(navigationRelativePath('src/store.ts')).toBe(true);
  });
});

describe('navigation read admission', () => {
  it('refuses a worker reply whose identity, paths or anchors do not agree', () => {
    expect(admitNavigationRead(evidence())).toEqual(evidence());
    const base = evidence();
    for (const bad of [
      {...base, observation: {...base.observation, repository: {repositoryId: 'other', displayName: 'x'}}},
      {...base, input: {...base.input, scope: {...base.input.scope, worktree: 'other'}}},
      {...base, anchors: [{...base.anchors[0], contentHash: 'other-hash'}]},
      {...base, anchors: [{...base.anchors[0], candidateId: 'cgs_ffffffffffffffffffffffffffffffff'}]},
      {
        ...base,
        input: {...base.input, sources: [{...base.input.sources[0], path: '../escape.ts'}]},
      },
    ] satisfies NavigationReadEvidenceV1[])
      expect(() => admitNavigationRead(bad)).toThrow();
  });
});

describe('navigate lane', () => {
  effectIt.effect('returns a structural answer, enriches it once and offers a bounded continuation', () =>
    Effect.gen(function* () {
      const calls: NavigationSemanticRequestV1[] = [];
      let remaining = 0;
      const projected = yield* compileContextBriefNavigationWith(
        deps({
          navigationSemantic: semantic =>
            Effect.gen(function* () {
              calls.push(semantic);
              remaining = yield* readDeadlineRemaining(semantic.deadline);
              return {...semantic.input, gaps: ['semantic-provider-unqualified']};
            }),
        }),
        request(),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({callerCwd: '/fixture', identity, observation, scope});
      expect(EffectArray.map(calls[0]?.anchors ?? [], anchor => anchor.candidateId)).toEqual([ENTRY, WRITE]);
      expect(remaining).toBeLessThanOrEqual(1500);
      const {structuredContent} = projected;
      expect(structuredContent).toMatchObject({type: 'context-brief-navigation', version: 1, gaps: []});
      expect(structuredContent.navigation?.gaps).toContain('semantic-provider-unqualified');
      expect(structuredContent.continuation).toBe(encodeNavigationContinuation(assembleNavigationAnswer(input())));
      expect(projected.measurement.totalBytes).toBeLessThanOrEqual(projected.maximumBytes);
    }),
  );

  effectIt.effect('skips semantic work below the 500 ms floor and keeps the structural answer', () =>
    Effect.gen(function* () {
      let called = false;
      const projected = yield* compileContextBriefNavigationWith(
        deps({
          navigationEvidence: () => TestClock.adjust('1100 millis').pipe(Effect.as(evidence())),
          navigationSemantic: semantic =>
            Effect.sync(() => {
              called = true;
              return semantic.input;
            }),
        }),
        request(),
      );
      expect(called).toBe(false);
      expect(projected.structuredContent.navigation?.gaps).toContain('semantic-enrichment-budget-exhausted');
      expect(projected.structuredContent.navigation?.roles.length).toBeGreaterThan(0);
    }),
  );

  effectIt.effect('stops a slow semantic step at the sub-deadline by interruption', () =>
    Effect.gen(function* () {
      const fiber = yield* compileContextBriefNavigationWith(
        deps({navigationSemantic: () => Effect.never}),
        request(),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust('1600 millis');
      const projected = yield* Fiber.join(fiber);
      expect(projected.structuredContent.navigation?.gaps).toContain('semantic-enrichment-budget-exhausted');
    }),
  );

  effectIt.effect('drops a semantic result that changes the requested scope', () =>
    Effect.gen(function* () {
      const projected = yield* compileContextBriefNavigationWith(
        deps({
          navigationSemantic: semantic =>
            Effect.succeed({...semantic.input, scope: {...semantic.input.scope, worktree: 'other'}}),
        }),
        request(),
      );
      expect(projected.structuredContent.navigation?.gaps).toContain('semantic-scope-changed');
    }),
  );

  effectIt.effect('answers a write-boundary follow-up from the token alone and invalidates a bad token', () =>
    Effect.gen(function* () {
      const token = encodeNavigationContinuation(assembleNavigationAnswer(input()))!;
      const seen: unknown[] = [];
      let memoryCalls = 0;
      const followUp = (target: string) =>
        deps({
          navigationEvidence: read =>
            Effect.sync(() => {
              seen.push(read.followUp);
              return evidence(target);
            }),
          memoryEvidence: () =>
            Effect.sync(() => {
              memoryCalls += 1;
              return memory;
            }),
        });
      const continuation = {token, focus: 'effects'};
      const unchanged = yield* compileContextBriefNavigationWith(followUp('path'), request({continuation}));
      expect(unchanged.structuredContent).toMatchObject({
        outcome: 'follow-up',
        followUp: {status: 'unchanged', effects: []},
      });
      expect(seen).toEqual([[{nodeId: WRITE, path: 'src/store.ts'}]]);
      expect(memoryCalls).toBe(0);
      const changed = yield* compileContextBriefNavigationWith(followUp('backup-path'), request({continuation}));
      expect(changed.structuredContent.followUp).toMatchObject({status: 'changed'});
      expect(changed.structuredContent.followUp?.effects[0]?.[5]).toEqual([
        'durable-write',
        'backup-path',
        'then branch of (persist)',
      ]);
      let read = false;
      const invalid = yield* compileContextBriefNavigationWith(
        deps({navigationEvidence: () => Effect.sync(() => ((read = true), evidence()))}),
        request({continuation: {token: 'AAAA', focus: 'effects'}}),
      );
      expect(read).toBe(false);
      expect(invalid.structuredContent.followUp).toMatchObject({
        status: 'invalidated',
        reason: 'navigation-continuation-invalid',
      });
    }),
  );

  effectIt.effect('reports an unavailable read and an unsupported workset without an answer', () =>
    Effect.gen(function* () {
      const missing = yield* compileContextBriefNavigationWith(
        deps({
          navigationEvidence: () =>
            Effect.succeed({status: 'unavailable', gaps: ['navigation-graph-ready-snapshot-missing']} as const),
        }),
        request(),
      );
      expect(missing.structuredContent).toMatchObject({
        outcome: 'unavailable',
        gaps: ['navigation-graph-ready-snapshot-missing'],
      });
      expect(missing.structuredContent.navigation).toBeUndefined();
      const workset = yield* compileContextBriefNavigationWith(
        deps(),
        request({scope: {kind: 'workset', name: 'team'}}),
      );
      expect(workset.structuredContent.gaps).toEqual(['navigation-workset-unsupported']);
    }),
  );
});
