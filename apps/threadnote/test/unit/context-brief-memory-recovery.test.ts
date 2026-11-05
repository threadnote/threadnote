import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {Effect, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {beforeEach, describe, expect, vi} from 'vitest';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {DeferredCodeAnchorRouteFinalizationReceiptV1} from '@threadnote/threadnote/memory/deferred/code_anchor';
import type {MemoryRecord} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ContextBriefPlanV1} from '@threadnote/context/types';
import {contextBriefCodeAnchorTelemetryFields} from '@threadnote/threadnote/telemetry/context_brief';
import {TestError} from '@threadnote/testing/test-error';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const mocks = vi.hoisted(() => ({
  captureMemoryCodeCitations: vi.fn(),
  deferRecallReadMaintenance: vi.fn(),
  expireRecallIndexValidation: vi.fn(),
  finalizeDeferredCodeAnchorsForRoute: vi.fn(),
  loadRecallCodeLinks: vi.fn(),
  loadRecallIndexData: vi.fn(),
  loadRecallMemoryIdentities: vi.fn(),
  readMemoryRecordsByUri: vi.fn(),
  resolveRepositoryIdentity: vi.fn(),
  withCodeAnchorFinalizationAnonymousTelemetry: vi.fn(),
}));

vi.mock('@threadnote/context/citation/capture', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/context/citation/capture')>();
  return {...actual, captureMemoryCodeCitations: mocks.captureMemoryCodeCitations};
});

vi.mock('@threadnote/threadnote/memory/index', () => ({readMemoryRecordsByUri: mocks.readMemoryRecordsByUri}));

vi.mock('@threadnote/recall/index', () => ({
  expireRecallIndexValidation: mocks.expireRecallIndexValidation,
  readRecallCodeLinks: mocks.loadRecallCodeLinks,
  readRecallIndexData: mocks.loadRecallIndexData,
  readRecallMemoryIdentities: mocks.loadRecallMemoryIdentities,
}));

vi.mock('../../src/recall/read_maintenance.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/recall/read_maintenance.js')>()),
  deferRecallReadMaintenance: mocks.deferRecallReadMaintenance,
}));

vi.mock('@threadnote/graph/repository', () => ({
  resolveRepositoryIdentity: mocks.resolveRepositoryIdentity,
}));

vi.mock('@threadnote/threadnote/memory/deferred/code_anchor', () => ({
  finalizeDeferredCodeAnchorsForRoute: mocks.finalizeDeferredCodeAnchorsForRoute,
}));

vi.mock('@threadnote/threadnote/telemetry/code_anchor_finalization', () => ({
  withCodeAnchorFinalizationAnonymousTelemetry: mocks.withCodeAnchorFinalizationAnonymousTelemetry,
}));

import {retrieveContextBriefCodeLinkedMemoryEvidence} from '@threadnote/threadnote/context_brief/index';
import {MemoryCodeCitationCaptureError} from '@threadnote/context/citation/capture';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MEMORY_URI = 'threadnote://user/tester/memories/durable/projects/threadnote/recovery.md';
const CONFIG: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/threadnote-home',
  agentId: 'threadnote',
  manifestPath: '/threadnote-home/seed-manifest.yaml',
  user: 'tester',
};

describe('Context Brief code-linked memory recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deferRecallReadMaintenance.mockReturnValue(Effect.succeed('current'));
    mocks.captureMemoryCodeCitations.mockImplementation(
      (_config: RuntimeConfig, input: {readonly refs?: readonly string[]}) =>
        Effect.succeed(EffectArray.map(input.refs ?? [], codeCitation)),
    );
    mocks.loadRecallCodeLinks.mockReturnValue(Effect.succeed([]));
    mocks.loadRecallMemoryIdentities.mockReturnValue(Effect.succeed([]));
    mocks.readMemoryRecordsByUri.mockReturnValue(Effect.succeed([]));
    mocks.resolveRepositoryIdentity.mockReturnValue(
      Effect.succeed({
        repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
        worktreeId: Effect2.pipe('b', EffectString.repeat(64)),
      }),
    );
    mocks.expireRecallIndexValidation.mockReturnValue(Effect.void);
    mocks.finalizeDeferredCodeAnchorsForRoute.mockReturnValue(Effect.succeed(finalizationReceipt('completed', 0)));
    mocks.withCodeAnchorFinalizationAnonymousTelemetry.mockImplementation(
      (_route: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
    );
  });

  const assertScopedAnchorRetrieval = ({team, topic}: {team: string; topic: string}) =>
    Effect.gen(function* () {
      const root = `threadnote://user/tester/memories/shared/${team}`;
      const inside = `${root}/durable/projects/threadnote/${topic}.md`;
      const outside = [`${root}-other/durable/projects/threadnote/${topic}.md`, MEMORY_URI];
      const citation = codeCitation('src/first.ts');
      mocks.loadRecallCodeLinks.mockReturnValue(
        Effect.succeed(
          EffectArray.map([inside, ...outside], uri => ({
            anchorOrdinal: 0,
            citationId: citation.id,
            matchKind: 'file-path',
            uri,
          })),
        ),
      );
      mocks.readMemoryRecordsByUri.mockImplementation((_config: RuntimeConfig, uris: readonly string[]) =>
        Effect.succeed(EffectArray.map(uris, uri => ({...memoryRecord(citation), uri}))),
      );
      const result = yield* contextBriefRecoveryTestEffect(
        retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(['src/first.ts']), {
          allowedUriScopes: [root],
        }),
      );
      expect(mocks.readMemoryRecordsByUri).toHaveBeenLastCalledWith(CONFIG, [inside]);
      expect(mocks.loadRecallMemoryIdentities).toHaveBeenLastCalledWith(
        CONFIG,
        expect.objectContaining({allowedUriScopes: [root]}),
      );
      expect(EffectArray.map(result.candidates, candidate => candidate.uri)).toEqual([inside]);
      expect(mocks.finalizeDeferredCodeAnchorsForRoute).not.toHaveBeenCalled();
    });

  fcEffectProp(
    effectIt,
    'scoped anchor retrieval excludes sibling shares and personal memory before reading bodies',
    {
      // These fixtures exercise scope isolation with valid cross-platform resource segments.
      team: fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/u).map(value => `team-${value}`),
      topic: fc.stringMatching(/^[a-z]{1,12}$/u).map(value => `topic-${value}`),
    },
    assertScopedAnchorRetrieval,
    {fastCheck: {numRuns: 24}},
  );

  effectIt.effect('keeps scopes isolated when fixture names contain Windows-reserved words', () =>
    Effect.gen(function* () {
      yield* assertScopedAnchorRetrieval({team: 'team-c--j9msw', topic: 'topic-con'});
      yield* assertScopedAnchorRetrieval({team: 'team-con', topic: 'topic-nul'});
    }),
  );

  fcEffectProp(
    effectIt,
    'defers canonical finalization for every bounded anchor set without foreground mutation',
    {
      count: fc.integer({min: 1, max: 8}),
      state: fc.constantFrom('queued', 'current', 'unavailable'),
    },
    ({count, state}) =>
      Effect.gen(function* () {
        mocks.deferRecallReadMaintenance.mockReturnValue(Effect.succeed(state));
        const refs = Array.from({length: count}, (_, i) => `src/target-${i}.ts`);
        const result = yield* contextBriefRecoveryTestEffect(
          retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs)),
        );
        expect(mocks.finalizeDeferredCodeAnchorsForRoute).not.toHaveBeenCalled();
        expect(mocks.expireRecallIndexValidation).not.toHaveBeenCalled();
        expect(mocks.deferRecallReadMaintenance).toHaveBeenLastCalledWith(CONFIG, {
          kind: 'anchors',
          callerCwd: '/workspace/threadnote',
          repositoryId: EffectString.repeat(64)('a'),
          worktreeId: EffectString.repeat(64)('b'),
          codeRefs: refs,
        });
        expect(mocks.loadRecallCodeLinks.mock.lastCall?.[1].forceRefresh).toBeUndefined();
        expect(result.gaps.includes('code-anchor-recall-unavailable')).toBe(state !== 'current');
      }),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect(
    'retains existing backlinks when deferred recovery fails and never presents unknown absence as empty',
    () =>
      Effect.gen(function* () {
        mocks.resolveRepositoryIdentity.mockReturnValue(
          Effect.succeed({
            repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
            worktreeId: Effect2.pipe('b', EffectString.repeat(64)),
          }),
        );
        mocks.deferRecallReadMaintenance.mockReturnValue(Effect.succeed('unavailable'));
        const citation = codeCitation('src/first.ts');
        mocks.loadRecallCodeLinks.mockReturnValue(
          Effect.succeed([{anchorOrdinal: 0, citationId: citation.id, matchKind: 'file-path', uri: MEMORY_URI}]),
        );
        mocks.readMemoryRecordsByUri.mockReturnValue(Effect.succeed([memoryRecord(citation)]));
        const result = yield* contextBriefRecoveryTestEffect(
          retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(['src/first.ts'])),
        );
        expect(EffectArray.map(result.candidates, candidate => candidate.uri)).toEqual([MEMORY_URI]);
        expect(result.gaps).toContain('code-anchor-recall-unavailable');
        expect(result.gaps).not.toContain('code-anchor-recall-no-active-memory');
        mocks.loadRecallCodeLinks.mockReturnValue(Effect.succeed([]));
        mocks.readMemoryRecordsByUri.mockReturnValue(Effect.succeed([]));
        const empty = yield* contextBriefRecoveryTestEffect(
          retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(['src/first.ts'])),
        );
        expect(empty.gaps).toEqual(['code-anchor-recall-unavailable']);
      }),
  );

  effectIt.effect('reports unavailable recovery when repository identity cannot be observed after anchor capture', () =>
    Effect.gen(function* () {
      mocks.resolveRepositoryIdentity.mockReturnValue(Effect.fail(TestError.make({message: 'identity unavailable'})));
      const citation = codeCitation('src/first.ts');
      mocks.loadRecallCodeLinks.mockReturnValue(
        Effect.succeed([{anchorOrdinal: 0, citationId: citation.id, matchKind: 'file-path', uri: MEMORY_URI}]),
      );
      mocks.readMemoryRecordsByUri.mockReturnValue(Effect.succeed([memoryRecord(citation)]));
      const result = yield* contextBriefRecoveryTestEffect(
        retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(['src/first.ts'])),
      );
      expect(result.codeAnchorCoverage).toMatchObject({requested: 1, resolved: 1, matchedMemories: 1});
      expect(EffectArray.map(result.candidates, candidate => candidate.uri)).toEqual([MEMORY_URI]);
      expect(result.gaps).toContain('code-anchor-recall-unavailable');
      expect(mocks.finalizeDeferredCodeAnchorsForRoute).not.toHaveBeenCalled();
      mocks.loadRecallCodeLinks.mockReturnValue(Effect.succeed([]));
      mocks.readMemoryRecordsByUri.mockReturnValue(Effect.succeed([]));
      const empty = yield* contextBriefRecoveryTestEffect(
        retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(['src/first.ts'])),
      );
      expect(empty.gaps).toEqual(['code-anchor-recall-unavailable']);
    }),
  );

  effectIt.effect('preserves resolved anchor ordinals when canonical memory reads fail after capture', () =>
    Effect.gen(function* () {
      const refs = ['src/first.ts', 'src/second.ts'];
      mocks.loadRecallCodeLinks.mockImplementation(
        (_config: RuntimeConfig, input: {readonly anchors: readonly MemoryCodeCitationV1[]}) =>
          Effect.succeed([
            {
              anchorOrdinal: 0,
              citationId: input.anchors[0].id,
              matchKind: 'file-path',
              uri: MEMORY_URI,
            },
          ]),
      );
      mocks.readMemoryRecordsByUri.mockReturnValue(Effect.fail(TestError.make({message: 'canonical read failed'})));

      const result = yield* contextBriefRecoveryTestEffect(
        retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs)),
      );

      expect(result.codeAnchorCoverage).toEqual({complete: true, matchedMemories: 0, requested: 2, resolved: 2});
      expect(result.gaps).toEqual(['code-anchor-recall-unavailable']);
      expect(mocks.captureMemoryCodeCitations).toHaveBeenCalledTimes(1);
    }),
  );

  effectIt.effect('preserves resolved anchors when stable identity lookup fails after canonical reads', () =>
    Effect.gen(function* () {
      const refs = ['src/first.ts'];
      const citation = codeCitation(refs[0], 0);
      mocks.captureMemoryCodeCitations.mockReturnValue(Effect.succeed([citation]));
      mocks.loadRecallCodeLinks.mockReturnValue(
        Effect.succeed([{anchorOrdinal: 0, citationId: citation.id, matchKind: 'file-path', uri: MEMORY_URI}]),
      );
      mocks.readMemoryRecordsByUri.mockReturnValue(Effect.succeed([memoryRecord(citation)]));
      mocks.loadRecallMemoryIdentities.mockReturnValue(Effect.fail(TestError.make({message: 'identity index failed'})));

      const result = yield* contextBriefRecoveryTestEffect(
        retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs)),
      );

      expect(result.codeAnchorCoverage).toEqual({complete: true, matchedMemories: 1, requested: 1, resolved: 1});
      expect(result.gaps).toContain('stable-memory-identity-unavailable');
      expect(result.candidates[0]?.memoryId).toBeUndefined();
    }),
  );

  for (const window of [{validFrom: '2050-01-01T00:00:00Z'}, {validTo: '1960-01-01T00:00:00Z'}])
    effectIt.effect(`rejects a newly ineligible hydrated validity window ${JSON.stringify(window)}`, () =>
      Effect.gen(function* () {
        const citation = codeCitation('src/first.ts');
        mocks.loadRecallCodeLinks.mockReturnValue(
          Effect.succeed([{anchorOrdinal: 0, citationId: citation.id, matchKind: 'file-path', uri: MEMORY_URI}]),
        );
        const record = memoryRecord(citation);
        mocks.readMemoryRecordsByUri.mockReturnValue(
          Effect.succeed([{...record, metadata: {...record.metadata, ...window}}]),
        );
        const result = yield* contextBriefRecoveryTestEffect(
          retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(['src/first.ts'])),
        );
        expect(result.candidates).toEqual([]);
        expect(mocks.loadRecallMemoryIdentities).not.toHaveBeenCalled();
      }),
    );

  effectIt.effect(
    'reports mixed resolved and unresolved anchors as partial without whole-phase resolution failure',
    () =>
      Effect.gen(function* () {
        const refs = ['src/first.ts', 'src/missing.ts', 'src/third.ts'];
        mocks.captureMemoryCodeCitations.mockImplementation(
          (_config: RuntimeConfig, input: {readonly refs?: readonly string[]}) => {
            const requested = input.refs ?? [];
            if (requested.length > 1 || requested[0] === refs[1]) {
              return Effect.fail(unresolvedCaptureError());
            }
            return Effect.succeed([codeCitation(requested[0], refs.indexOf(requested[0]))]);
          },
        );

        const result = yield* contextBriefRecoveryTestEffect(
          retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs)),
        );

        expect(result.codeAnchorCoverage).toEqual({
          complete: false,
          matchedMemories: 0,
          requested: 3,
          resolved: 2,
          unresolvedOrdinals: [1],
        });
        expect(result.gaps).toContain('code-anchors-unresolved');
        expect(result.gaps).not.toContain('code-anchor-resolution-unavailable');
        expect(
          contextBriefCodeAnchorTelemetryFields({
            ...result.codeAnchorCoverage!,
            gaps: result.gaps,
            recoveryPresent: true,
          }),
        ).toMatchObject({
          contextBriefCodeAnchorCoverage: 'partial',
          contextBriefGapClass: 'unresolved',
        });
        expect(mocks.captureMemoryCodeCitations).toHaveBeenCalledTimes(4);
      }),
  );

  effectIt.effect('surfaces an unavailable fallback read without discarding resolved anchor ordinals', () =>
    Effect.gen(function* () {
      const refs = ['src/first.ts', 'src/missing.ts', 'src/unavailable.ts'];
      mocks.captureMemoryCodeCitations.mockImplementation(
        (_config: RuntimeConfig, input: {readonly refs?: readonly string[]}) => {
          const requested = input.refs ?? [];
          if (requested.length > 1 || requested[0] === refs[1]) return Effect.fail(unresolvedCaptureError());
          if (requested[0] === refs[2]) return Effect.fail(MemoryCodeCitationCaptureError.of('permission denied'));
          return Effect.succeed([codeCitation(requested[0], 0)]);
        },
      );

      const result = yield* contextBriefRecoveryTestEffect(
        retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs)),
      );

      expect(result.codeAnchorCoverage).toEqual({
        complete: false,
        matchedMemories: 0,
        requested: 3,
        resolved: 1,
        unresolvedOrdinals: [1, 2],
      });
      expect(result.gaps).toEqual([
        'code-anchor-recall-no-active-memory',
        'code-anchor-resolution-unavailable',
        'code-anchors-unresolved',
      ]);
      expect(
        contextBriefCodeAnchorTelemetryFields({
          ...result.codeAnchorCoverage!,
          gaps: result.gaps,
          recoveryPresent: true,
        }),
      ).toMatchObject({
        contextBriefCodeAnchorCoverage: 'unavailable',
        contextBriefGapClass: 'unavailable',
      });
      expect(mocks.captureMemoryCodeCitations).toHaveBeenCalledTimes(4);
    }),
  );

  effectIt.effect('bounds eight-ref global failures and retries only classified transient capture errors', () =>
    Effect.gen(function* () {
      const refs = Array.from({length: 8}, (_, index) => `src/ref-${index}.ts`);
      const fatalExecutions: string[][] = [];
      mocks.captureMemoryCodeCitations.mockImplementation(
        (_config: RuntimeConfig, input: {readonly refs?: readonly string[]}) =>
          Effect.suspend(() => {
            fatalExecutions.push([...(input.refs ?? [])]);
            return Effect.fail(MemoryCodeCitationCaptureError.of('fatal'));
          }),
      );

      const fatal = yield* Effect.result(
        contextBriefRecoveryTestEffect(retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs))),
      );

      expect(Result.isFailure(fatal)).toBe(true);
      expect(mocks.captureMemoryCodeCitations).toHaveBeenCalledTimes(1);
      expect(fatalExecutions).toEqual([refs]);

      mocks.captureMemoryCodeCitations.mockReset();
      const transientExecutions: string[][] = [];
      mocks.captureMemoryCodeCitations.mockImplementation(
        (_config: RuntimeConfig, input: {readonly refs?: readonly string[]}) =>
          Effect.suspend(() => {
            transientExecutions.push([...(input.refs ?? [])]);
            return Effect.fail(MemoryCodeCitationCaptureError.of('transient', undefined, undefined, true));
          }),
      );

      const transient = yield* Effect.result(
        contextBriefRecoveryTestEffect(retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs))),
      ).pipe(TestClock.withLive);

      expect(Result.isFailure(transient)).toBe(true);
      expect(mocks.captureMemoryCodeCitations).toHaveBeenCalledTimes(1);
      expect(transientExecutions).toEqual([refs, refs, refs]);
    }),
  );
});

function codeAnchorPlan(codeRefs: readonly string[]): ContextBriefPlanV1['codeAnchors'] {
  return {
    candidateLimit: 24,
    codeRefs,
    project: 'threadnote',
    query: 'retry the documented contract',
    scope: {callerCwd: '/workspace/threadnote', kind: 'repository', project: 'threadnote'},
  };
}

function codeCitation(path: string, ordinal = 0): MemoryCodeCitationV1 {
  const digit = ((Math.max(ordinal, 0) % 15) + 1).toString(16);
  return {
    extractorSet: 'fixture-extractor',
    fileContentHash: {algorithm: 'sha256', value: Effect2.pipe(digit, EffectString.repeat(64))},
    id: `tncc_${Effect2.pipe(digit, EffectString.repeat(40))}`,
    path,
    repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
    repositoryIdentityKind: 'remote',
    sourceCommit: Effect2.pipe('b', EffectString.repeat(40)),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}`,
    target: {kind: 'file'},
    version: 1,
  };
}

function memoryRecord(citation: MemoryCodeCitationV1): MemoryRecord {
  return {
    body: 'The recovered memory remains bounded.',
    content: 'fixture',
    headerTitle: 'MEMORY',
    metadata: {
      codeCitations: [citation],
      kind: 'durable',
      memoryId: 'tn_context_brief_recovery',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-08-31T00:00:00.000Z',
      topic: 'context-brief-recovery',
    },
    uri: MEMORY_URI,
  };
}

function unresolvedCaptureError(): MemoryCodeCitationCaptureError {
  return MemoryCodeCitationCaptureError.of('unresolved', undefined, 'code-reference-unresolved');
}

function contextBriefRecoveryTestEffect<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return provideTestLayer(ApplicationLayer)(effect);
}

function finalizationReceipt(
  state: DeferredCodeAnchorRouteFinalizationReceiptV1['state'],
  finalizedCount: number,
): DeferredCodeAnchorRouteFinalizationReceiptV1 {
  return {
    conflictCount: 0,
    failedCount: 0,
    finalizedCount,
    matchedCount: state === 'contended' ? finalizedCount + 1 : finalizedCount,
    pendingCount: 0,
    scannedCount: finalizedCount,
    state,
    type: 'threadnote-deferred-code-anchor-route-finalization',
    version: 1,
  };
}
