import {describe, expect, it} from '@effect/vitest';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, Fiber} from 'effect';
import * as EffectString from 'effect/String';
import {TestClock} from 'effect/testing';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
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
import {parseContextBriefRequestV1, type ContextBriefMemoryCandidateV1} from '../../src/types.js';

const ENTRY = 'cgs_00000000000000000000000000000001';
const WRITE = 'cgs_00000000000000000000000000000002';
/** Canonical memory citations need a SHA-256 repository id. */
const REPOSITORY = EffectString.repeat(64)('c');
const scope: NavigationScope = {
  repository: REPOSITORY,
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
  repositoryId: REPOSITORY,
  worktreeId: 'worktree-id',
};
const observation = {
  repository: {repositoryId: REPOSITORY, displayName: 'fixture'},
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
  };
}
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
      {continuation: {token: 'abc', focus: 'effects'}, surface: 'x'},
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
      wire([1, scopeDigest, status, digest, []]),
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
      expect(structuredContent).toMatchObject({
        type: 'context-brief-navigation',
        version: 1,
        gaps: ['navigation-memory-not-read'],
      });
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
      const followUp = (target: string) =>
        deps({
          navigationEvidence: read =>
            Effect.sync(() => {
              seen.push(read.followUp);
              return evidence(target);
            }),
        });
      const continuation = {token, focus: 'effects'};
      const unchanged = yield* compileContextBriefNavigationWith(followUp('path'), request({continuation}));
      expect(unchanged.structuredContent).toMatchObject({
        outcome: 'follow-up',
        followUp: {status: 'unchanged', effects: []},
      });
      expect(seen).toEqual([[{nodeId: WRITE, path: 'src/store.ts'}]]);
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

  effectIt.effect('keeps the structural answer when the semantic step drops structural evidence', () =>
    Effect.gen(function* () {
      const projected = yield* compileContextBriefNavigationWith(
        deps({navigationSemantic: semantic => Effect.succeed({...semantic.input, candidates: []})}),
        request(),
      );
      expect(projected.structuredContent.navigation?.gaps).toContain('semantic-structural-evidence-dropped');
      expect(projected.structuredContent.navigation?.nodes.length).toBeGreaterThan(0);
    }),
  );

  effectIt.effect('keeps the whole response, envelope and continuation included, inside every budget', () =>
    Effect.gen(function* () {
      for (const budgetTokens of [800, 1000, 1250, 1500])
        for (const responseFormat of ['agent', 'dual'] as const) {
          const projected = yield* compileContextBriefNavigationWith(deps(), request({budgetTokens, responseFormat}));
          expect(projected.measurement.totalBytes).toBeLessThanOrEqual(projected.maximumBytes);
          expect(projected.structuredContent.navigation).toBeDefined();
        }
    }),
  );

  effectIt.effect('carries applicable code-linked memory and reports a failed memory step as a lane gap', () =>
    Effect.gen(function* () {
      const hash = EffectString.repeat(64)('b');
      const pin = (nodeId: string) =>
        createMemoryCodeCitation({
          version: 1,
          extractorSet: 'fixture',
          repositoryId: REPOSITORY,
          repositoryIdentityKind: 'local',
          path: 'src/store.ts',
          target: {
            kind: 'symbol',
            nodeId,
            language: 'typescript',
            name: 'write',
            qualifiedName: 'write',
            symbolKind: 'function',
            span: span(9),
            fragmentCanonicalization: 'utf8-source-span-v1',
            fragmentHash: {algorithm: 'sha256', value: hash},
          },
          fileContentHash: {algorithm: 'sha256', value: hash},
          sourceCommit: observation.snapshot.commit,
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${EffectString.repeat(40)('d')}`,
        });
      const memory = (name: string, nodeId: string): ContextBriefMemoryCandidateV1 => {
        const citation = pin(nodeId);
        return {
          uri: `threadnote://memory/tn_${name}`,
          kind: 'durable',
          rank: 0,
          excerpt: name,
          citationErrorCount: 0,
          codeCitations: [citation],
          codeLinkMatches: [
            {
              anchorNodeId: nodeId,
              anchorPath: 'src/store.ts',
              anchorOrdinal: 0,
              citationId: citation.id,
              matchKind: 'symbol-node',
            },
          ],
        };
      };
      const candidates = [memory('applicable', WRITE), memory('unrelated', 'cgs_0000000000000000000000000000000f')];
      const withMemory = (read: NavigationReadEvidenceV1['memory']) =>
        deps({navigationEvidence: () => Effect.succeed({...evidence(), memory: read})});
      const projected = yield* compileContextBriefNavigationWith(
        withMemory({
          status: 'ok',
          observedAt: '2026-11-27T00:00:00.000Z',
          memoryProjects: {mode: 'projectless-only'},
          memory: {
            candidates,
            consideredCandidates: candidates.length,
            gaps: [],
            trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
            citationValidations: EffectArray.map(candidates, candidate => ({
              uri: candidate.uri,
              receipts: EffectArray.map(candidate.codeCitations, citation => ({
                citationId: citation.id,
                candidateCount: 1,
                coverage: 'current-complete' as const,
                kind: citation.target.kind,
                observedAt: '2026-11-27T00:00:00.000Z',
                observedPath: 'src/store.ts',
                observedNodeId: WRITE,
                reason: 'exact' as const,
                status: 'exact' as const,
                strategy: 'node-id' as const,
                validatorVersion: 1 as const,
              })),
            })),
          },
        }),
        request({budgetTokens: 1500}),
      );
      expect(projected.structuredContent.gaps).toEqual([]);
      const navigation = projected.structuredContent.navigation!;
      expect(EffectArray.map(navigation.memory, entry => [entry.uri, entry.freshness])).toEqual([
        ['threadnote://memory/tn_applicable', 'fresh'],
      ]);
      expect(navigation.gaps).toContain('navigation-memory-coverage-incomplete');
      for (const budgetTokens of [800, 1500]) {
        const bounded = yield* compileContextBriefNavigationWith(
          withMemory({status: 'unavailable', gaps: ['navigation-memory-budget-exhausted']}),
          request({budgetTokens}),
        );
        expect(bounded.structuredContent.gaps).toEqual(['navigation-memory-budget-exhausted']);
        expect(bounded.structuredContent.navigation?.memory).toEqual([]);
        expect(bounded.measurement.totalBytes).toBeLessThanOrEqual(bounded.maximumBytes);
      }
    }),
  );

  effectIt.effect('invalidates a workset follow-up and accepts the default compact detail', () =>
    Effect.gen(function* () {
      const workset = yield* compileContextBriefNavigationWith(
        deps(),
        request({scope: {kind: 'workset', name: 'team'}, continuation: {token: 'AAAA', focus: 'effects'}}),
      );
      expect(workset.structuredContent.followUp).toMatchObject({
        status: 'invalidated',
        reason: 'navigation-workset-unsupported',
      });
      const compact = yield* compileContextBriefNavigationWith(deps(), request({detail: 'compact'}));
      expect(compact.structuredContent.navigation).toBeDefined();
    }),
  );
});
