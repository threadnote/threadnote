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

const mocks = vi.hoisted(() => ({
  captureMemoryCodeCitations: vi.fn(),
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
  loadRecallCodeLinks: mocks.loadRecallCodeLinks,
  loadRecallIndexData: mocks.loadRecallIndexData,
  loadRecallMemoryIdentities: mocks.loadRecallMemoryIdentities,
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
    mocks.captureMemoryCodeCitations.mockImplementation(
      (_config: RuntimeConfig, input: {readonly refs?: readonly string[]}) =>
        Effect.succeed((input.refs ?? []).map(codeCitation)),
    );
    mocks.loadRecallCodeLinks.mockReturnValue(Effect.succeed([]));
    mocks.loadRecallMemoryIdentities.mockReturnValue(Effect.succeed([]));
    mocks.readMemoryRecordsByUri.mockReturnValue(Effect.succeed([]));
    mocks.resolveRepositoryIdentity.mockReturnValue(
      Effect.succeed({repositoryId: 'a'.repeat(64), worktreeId: 'b'.repeat(64)}),
    );
    mocks.expireRecallIndexValidation.mockReturnValue(Effect.void);
    mocks.finalizeDeferredCodeAnchorsForRoute.mockReturnValue(Effect.succeed(finalizationReceipt('completed', 0)));
    mocks.withCodeAnchorFinalizationAnonymousTelemetry.mockImplementation(
      (_route: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
    );
  });

  fcEffectProp(
    effectIt,
    'bounds contention recovery to two passes and four admissions while retaining unavailable evidence',
    {
      completedBeforeInterruption: fc.integer({min: 0, max: 4}),
      interruptedAdmission: fc.boolean(),
      stillContended: fc.boolean(),
    },
    ({completedBeforeInterruption, interruptedAdmission, stillContended}) =>
      Effect.gen(function* () {
        mocks.resolveRepositoryIdentity.mockReturnValue(
          Effect.succeed({repositoryId: 'a'.repeat(64), worktreeId: 'b'.repeat(64)}),
        );
        const limits: number[] = [];
        let totalAdmissions = 0;
        const firstAdmissions = Math.min(4, completedBeforeInterruption + Number(interruptedAdmission));
        mocks.finalizeDeferredCodeAnchorsForRoute.mockImplementation(
          (
            _config: RuntimeConfig,
            _route: unknown,
            options: {readonly limit: number; readonly onAttemptedUri: (uri: string) => void},
          ) =>
            Effect.sync(() => {
              limits.push(options.limit);
              const admissions = limits.length === 1 ? firstAdmissions : options.limit;
              for (let index = 0; index < admissions; index++) {
                options.onAttemptedUri(MEMORY_URI);
                totalAdmissions++;
              }
              return limits.length === 1
                ? finalizationReceipt('contended', completedBeforeInterruption)
                : finalizationReceipt(stillContended ? 'contended' : 'completed', admissions - Number(stillContended));
            }),
        );
        const receipts: DeferredCodeAnchorRouteFinalizationReceiptV1[] = [];
        const result = yield* contextBriefRecoveryTestEffect(
          retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(['src/first.ts']), {
            onFinalizationReceipt: receipt => {
              receipts.push(receipt);
            },
          }),
        );
        expect(limits).toEqual(firstAdmissions < 4 ? [4, 4 - firstAdmissions] : [4]);
        expect(totalAdmissions).toBeLessThanOrEqual(4);
        expect(receipts.reduce((count, receipt) => count + receipt.scannedCount, 0)).toBeLessThanOrEqual(4);
        expect(result.codeAnchorCoverage).toMatchObject({requested: 1, resolved: 1});
        expect(result.gaps.includes('code-anchor-recall-unavailable')).toBe(firstAdmissions === 4 || stillContended);
        expect(mocks.loadRecallCodeLinks).toHaveBeenLastCalledWith(
          CONFIG,
          expect.objectContaining({
            forceRefresh: true,
          }),
        );
      }),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('does not retry pending graph readiness or a failed finalization and preserves recall', () =>
    Effect.gen(function* () {
      mocks.resolveRepositoryIdentity.mockReturnValue(
        Effect.succeed({repositoryId: 'a'.repeat(64), worktreeId: 'b'.repeat(64)}),
      );
      for (const field of ['pendingCount', 'failedCount'] as const) {
        let passes = 0;
        mocks.finalizeDeferredCodeAnchorsForRoute.mockImplementation(() =>
          Effect.sync(() => {
            passes++;
            return {...finalizationReceipt('contended', 0), [field]: 1, scannedCount: 1};
          }),
        );
        const result = yield* contextBriefRecoveryTestEffect(
          retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(['src/first.ts'])),
        );
        expect(passes).toBe(1);
        expect(result.gaps).toContain('code-anchor-recall-unavailable');
        expect(mocks.loadRecallCodeLinks).toHaveBeenLastCalledWith(
          CONFIG,
          expect.objectContaining({forceRefresh: true}),
        );
      }
      mocks.finalizeDeferredCodeAnchorsForRoute.mockReturnValue(Effect.die('finalizer unavailable'));
      const failed = yield* contextBriefRecoveryTestEffect(
        retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(['src/first.ts'])),
      );
      expect(failed.gaps).toContain('code-anchor-recall-unavailable');
    }),
  );

  effectIt.effect(
    'retains existing backlinks when deferred recovery fails and never presents unknown absence as empty',
    () =>
      Effect.gen(function* () {
        mocks.resolveRepositoryIdentity.mockReturnValue(
          Effect.succeed({repositoryId: 'a'.repeat(64), worktreeId: 'b'.repeat(64)}),
        );
        mocks.finalizeDeferredCodeAnchorsForRoute.mockReturnValue(Effect.succeed(finalizationReceipt('failed', 0)));
        const citation = codeCitation('src/first.ts');
        mocks.loadRecallCodeLinks.mockReturnValue(
          Effect.succeed([{anchorOrdinal: 0, citationId: citation.id, matchKind: 'file-path', uri: MEMORY_URI}]),
        );
        mocks.readMemoryRecordsByUri.mockReturnValue(Effect.succeed([memoryRecord(citation)]));
        const result = yield* contextBriefRecoveryTestEffect(
          retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(['src/first.ts'])),
        );
        expect(result.candidates.map(candidate => candidate.uri)).toEqual([MEMORY_URI]);
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
      expect(result.candidates.map(candidate => candidate.uri)).toEqual([MEMORY_URI]);
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

      expect(result.codeAnchorCoverage).toEqual({complete: true, matchedMemories: 0, requested: 1, resolved: 1});
      expect(result.gaps).toEqual(['code-anchor-recall-unavailable']);
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
    fileContentHash: {algorithm: 'sha256', value: digit.repeat(64)},
    id: `tncc_${digit.repeat(40)}`,
    path,
    repositoryId: 'a'.repeat(64),
    repositoryIdentityKind: 'remote',
    sourceCommit: 'b'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'c'.repeat(40)}`,
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

function contextBriefRecoveryTestEffect<A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> {
  // Every required boundary is replaced above with an Effect that requires no services.
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- fully mocked focused unit boundary
  return effect as Effect.Effect<A, E>;
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
