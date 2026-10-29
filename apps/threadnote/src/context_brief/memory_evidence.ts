import {Array as EffectArray} from 'effect';
import {
  contextBriefCodeLinkRecallGaps,
  mapContextBriefCodeLinkMatches,
  unavailableContextBriefCodeLinkedMemoryEvidence,
  unavailableContextBriefCodeLinkedMemoryEvidenceAfterCapture,
  unresolvedContextBriefCodeAnchorOrdinals,
  contextBriefMemoryUriScope,
  contextBriefMemoryRecordIsEligible,
  contextBriefMemoryCandidate,
  stableUnique,
} from '@threadnote/context/memory-evidence';
export * from '@threadnote/context/memory-evidence';
import {Effect, FileSystem, Option, Path, Result, Schedule, Schema} from 'effect';
import {canonicalMemoryDocumentContent, type MemoryRecord} from '@threadnote/memory/document';
import {parseCandidateReview} from '@threadnote/memory/candidate';
import {hasTopicMaintenanceEnrollment} from '@threadnote/memory/topic-maintenance';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {resolveWorkset} from '@threadnote/workspace/manifest';
import {readMemoryRecordsByUri} from '../memory/index.js';
import {captureMemoryCodeCitations, MemoryCodeCitationCaptureError} from '@threadnote/context/citation/capture';
import {
  finalizeDeferredCodeAnchorsForRoute,
  type DeferredCodeAnchorRouteFinalizationReceiptV1,
} from '../memory/deferred/code_anchor.js';

import {isMemoryId} from '@threadnote/memory/identity-alias';
import {resourceIdIsWithin} from '@threadnote/store/resource-id';

import {
  expireRecallIndexValidation,
  loadRecallCodeLinks,
  loadRecallIndexData,
  loadRecallMemoryIdentities,
} from '@threadnote/recall/index';
import {
  deriveRecallEligibilityPolicy,
  normalizeRecallProjectNames,
  type RecallEligibilityPolicy,
} from '@threadnote/recall/eligibility';
import {classifyMemoryIdentityCandidates} from '@threadnote/recall/memory/identity';
import {resolveWorkspaceRepoName} from '../utils.js';
import {withCodeAnchorFinalizationAnonymousTelemetry} from '../telemetry/code_anchor_finalization.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {
  ContextBriefMemoryCandidateV1,
  ContextBriefMemoryRetrievalV1,
  ContextBriefPlanV1,
  ContextBriefScopeV1,
} from '@threadnote/context/types';
const MEMORY_RETRIEVAL_MULTIPLIER = 4;
const CONTEXT_BRIEF_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT = 4;
const CONTEXT_BRIEF_DEFERRED_CODE_ANCHOR_FINALIZE_PASSES = 2;
const CONTEXT_BRIEF_DEFERRED_CODE_ANCHOR_WAIT_MILLISECONDS = 1_000;
const CONTEXT_BRIEF_CODE_ANCHOR_READ_RETRIES = 2;
const CONTEXT_BRIEF_CODE_ANCHOR_RETRY_MILLISECONDS = 25;
import {MEMORY_RECALL_EMPTY_GAP} from '@threadnote/context/memory-evidence';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const THREADNOTE_MEMORY_URI = /^threadnote:\/\/user\/[^/]+\/memories\//u;

type ContextBriefMemoryScopeResolution =
  | {readonly kind: 'repository'; readonly project?: string}
  | {readonly kind: 'workset'; readonly projects?: readonly string[]};

/** Derive a fail-closed project boundary for Context Brief memory retrieval. */
export function contextBriefMemoryEligibilityPolicy(
  scope: ContextBriefScopeV1,
  query: string,
  resolution: ContextBriefMemoryScopeResolution,
): {readonly gap?: string; readonly policy: RecallEligibilityPolicy} {
  if (scope.kind === 'repository') {
    const project = scope.project ?? (resolution.kind === 'repository' ? resolution.project : undefined);
    const policy = deriveRecallEligibilityPolicy({
      originalQuery: query,
      ...(scope.project === undefined
        ? project === undefined
          ? {}
          : {workspaceProject: project}
        : {explicitProject: scope.project}),
    });
    return project === undefined
      ? {
          gap: 'memory-project-scope-unavailable',
          policy: projectlessOnlyRecallEligibility(policy),
        }
      : {policy};
  }

  if (resolution.kind !== 'workset' || resolution.projects === undefined) {
    return {
      gap: 'memory-workset-scope-unavailable',
      policy: projectlessOnlyRecallEligibility(deriveRecallEligibilityPolicy({originalQuery: query})),
    };
  }
  const members = normalizeRecallProjectNames(resolution.projects);
  const explicitProject = scope.project === undefined ? undefined : normalizeRecallProjectNames([scope.project])[0];
  const selectedMembers =
    explicitProject === undefined ? members : EffectArray.filter(members, project => explicitProject === project);
  return {
    policy: deriveRecallEligibilityPolicy({originalQuery: query, worksetProjectNames: selectedMembers}),
  };
}

const contextBriefMemoryEligibility = Effect.fn('contextBrief.resolveMemoryEligibility')(function* (
  config: RuntimeConfig,
  scope: ContextBriefScopeV1,
  query: string,
) {
  if (scope.kind === 'repository') {
    const project =
      scope.project ??
      (yield* resolveWorkspaceRepoName({cwd: scope.callerCwd, includeProcessCwd: false}).pipe(
        Effect.option,
        Effect.map(Option.getOrUndefined),
      ));
    return contextBriefMemoryEligibilityPolicy(scope, query, {kind: 'repository', project});
  }
  const resolved = yield* resolveWorkset(config.manifestPath, scope.name).pipe(Effect.option);
  const projects =
    resolved._tag === 'Some' && resolved.value !== undefined
      ? EffectArray.map(resolved.value.projects, project => project.name)
      : undefined;
  return contextBriefMemoryEligibilityPolicy(scope, query, {kind: 'workset', projects});
});

function projectlessOnlyRecallEligibility(policy: RecallEligibilityPolicy): RecallEligibilityPolicy {
  return policy.kind === 'candidate-policy' ? {...policy, projects: {mode: 'projectless-only'}} : policy;
}

/** Local lexical retrieval only: no hosted service, model, or interpretation of memory body text. */
export const retrieveContextBriefMemoryEvidence = Effect.fn('contextBrief.retrieveMemoryEvidence')(function* (
  config: RuntimeConfig,
  plan: ContextBriefPlanV1['memory'],
  allowedUriScopes: readonly string[] = [contextBriefMemoryUriScope(config.user)],
) {
  const scopedEligibility = yield* contextBriefMemoryEligibility(config, plan.scope, plan.query);
  const index = yield* loadRecallIndexData(config, {
    allowedUriScopes,
    eligibility: scopedEligibility.policy,
    includeInactive: false,
    limit: Math.max(plan.candidateLimit, plan.candidateLimit * MEMORY_RETRIEVAL_MULTIPLIER),
    query: plan.query,
  });
  const rankedCandidates = index.candidates;
  const rankedUris = EffectArray.map(
    EffectArray.filter(
      rankedCandidates,
      (candidate, __effectArrayIndex) =>
        __effectArrayIndex in rankedCandidates &&
        THREADNOTE_MEMORY_URI.test(candidate.uri) &&
        (candidate.kind === 'durable' || candidate.kind === 'handoff') &&
        candidate.status === 'active',
    ),
    candidate => candidate.uri,
  );
  const read = yield* readContextBriefMemoryCandidates(
    config,
    rankedUris,
    plan.candidateLimit,
    new Map(),
    plan.requireResolvableMemoryIdentity,
    allowedUriScopes,
  );
  const candidates = read.candidates;
  return {
    candidates,
    consideredCandidates: index.candidates.length,
    gaps: [
      ...(candidates.length === 0 ? [MEMORY_RECALL_EMPTY_GAP] : []),
      ...(scopedEligibility.gap === undefined ? [] : [scopedEligibility.gap]),
      ...(read.stableIdentityUnavailable ? ['stable-memory-identity-unavailable'] : []),
    ],
    trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
  } satisfies ContextBriefMemoryRetrievalV1;
});

/** Resolve explicit local anchors against ready-current code and retrieve their private citation backlinks. */
export const retrieveContextBriefCodeLinkedMemoryEvidence = Effect.fn('contextBrief.retrieveCodeLinkedMemoryEvidence')(
  function* (
    config: RuntimeConfig,
    plan: ContextBriefPlanV1['codeAnchors'],
    options: {
      readonly allowedUriScopes?: readonly string[];
      /** @internal Privacy-safe receipts for diagnosing first-read recovery. */
      readonly onFinalizationReceipt?: (receipt: DeferredCodeAnchorRouteFinalizationReceiptV1) => void;
    } = {},
  ) {
    const requested = plan.codeRefs.length;
    if (requested === 0) {
      return {
        codeAnchorCoverage: {complete: true, matchedMemories: 0, requested: 0, resolved: 0},
        candidates: [],
        consideredCandidates: 0,
        gaps: [],
        trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
      } satisfies ContextBriefMemoryRetrievalV1;
    }
    if (plan.scope.kind !== 'repository') {
      return unavailableContextBriefCodeLinkedMemoryEvidence(requested, 'code-anchor-scope-unsupported');
    }
    const scopedEligibility = yield* contextBriefMemoryEligibility(config, plan.scope, plan.query);
    const callerCwd = plan.scope.callerCwd;
    if (EffectArray.some(plan.codeRefs, ref => Effect2.pipe(ref, EffectString.startsWith('cgr_')))) {
      return unavailableContextBriefCodeLinkedMemoryEvidence(requested, 'code-anchor-ref-unsupported');
    }
    const retryBudget = {remaining: CONTEXT_BRIEF_CODE_ANCHOR_READ_RETRIES};
    const capturedBatch = yield* Effect.result(
      retryContextBriefCodeAnchorRead(
        captureMemoryCodeCitations(config, {
          callerCwd,
          project: plan.scope.project,
          refs: plan.codeRefs,
        }),
        retryBudget,
      ),
    );
    if (
      Result.isFailure(capturedBatch) &&
      Schema.is(MemoryCodeCitationCaptureError)(capturedBatch.failure) &&
      capturedBatch.failure.recovery !== undefined
    ) {
      return unavailableContextBriefCodeLinkedMemoryEvidence(requested, 'code-anchor-resolution-unavailable');
    }
    const fallbackAttempts =
      Result.isSuccess(capturedBatch) && capturedBatch.success.length === requested
        ? undefined
        : Result.isSuccess(capturedBatch) || isUnresolvedContextBriefCodeAnchorFailure(capturedBatch.failure)
          ? yield* Effect.forEach(
              plan.codeRefs,
              ref =>
                Effect.result(
                  retryContextBriefCodeAnchorRead(
                    captureMemoryCodeCitations(config, {
                      callerCwd,
                      project: plan.scope.project,
                      refs: [ref],
                    }),
                    retryBudget,
                  ),
                ),
              // A deterministic unresolved member is isolated serially; a
              // global or non-retryable batch failure never fans out 8x.
              {concurrency: 1},
            )
          : undefined;
    const resolvedAnchors =
      Result.isSuccess(capturedBatch) && capturedBatch.success.length === requested
        ? EffectArray.map(capturedBatch.success, (anchor, anchorOrdinal) => ({anchor, anchorOrdinal}))
        : EffectArray.flatMap(fallbackAttempts ?? [], (attempt, anchorOrdinal) => {
            const anchor = Result.isSuccess(attempt) ? attempt.success[0] : undefined;
            return anchor === undefined ? [] : [{anchor, anchorOrdinal}];
          });
    const unresolvedCaptureFailures = EffectArray.flatMap(fallbackAttempts ?? [], attempt =>
      Result.isFailure(attempt) ? [attempt.failure] : [],
    );
    const captureFailures = [
      ...(Result.isFailure(capturedBatch) ? [capturedBatch.failure] : []),
      ...unresolvedCaptureFailures,
    ];
    const captureUnavailable = EffectArray.some(
      captureFailures,
      failure => !isUnresolvedContextBriefCodeAnchorFailure(failure),
    );
    if (resolvedAnchors.length === 0) {
      const unexpected = Option.getOrUndefined(
        EffectArray.findFirst(captureFailures, isUnexpectedContextBriefCodeAnchorFailure),
      );
      if (unexpected !== undefined) return yield* unexpected;
      return unavailableContextBriefCodeLinkedMemoryEvidence(requested, 'code-anchor-resolution-unavailable');
    }
    const resolvedOrdinals = EffectArray.map(resolvedAnchors, anchor => anchor.anchorOrdinal);
    const identity = yield* resolveRepositoryIdentity(callerCwd).pipe(Effect.option);
    const attemptedUris: string[] = [];
    // Scoped cloud reads must not finalize pending memories outside their share boundary.
    let finalizationUnavailable = options.allowedUriScopes === undefined && identity._tag === 'None';
    let refreshAfterContention = false;
    if (identity._tag === 'Some' && options.allowedUriScopes === undefined) {
      let remainingLimit = CONTEXT_BRIEF_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT;
      for (let pass = 0; pass < CONTEXT_BRIEF_DEFERRED_CODE_ANCHOR_FINALIZE_PASSES; pass++) {
        const previousAttemptCount = attemptedUris.length;
        const receipt = yield* withCodeAnchorFinalizationAnonymousTelemetry(
          'context-brief',
          finalizeDeferredCodeAnchorsForRoute(
            config,
            {
              callerCwd,
              kind: 'repository',
              repositoryId: identity.value.repositoryId,
              worktreeId: identity.value.worktreeId,
            },
            {
              limit: remainingLimit,
              onAttemptedUri: uri => {
                attemptedUris.push(uri);
              },
              preferredCodeRefs: plan.codeRefs,
              waitTimeoutMilliseconds: CONTEXT_BRIEF_DEFERRED_CODE_ANCHOR_WAIT_MILLISECONDS,
            },
          ),
        ).pipe(
          Effect.asSome,
          Effect.catchCause(() => Effect.succeedNone),
        );
        finalizationUnavailable = receipt._tag === 'None' || receipt.value.state !== 'completed';
        if (receipt._tag === 'None') break;
        yield* Effect.sync(() => options.onFinalizationReceipt?.(receipt.value)).pipe(Effect.ignoreCause);
        // Admission is counted even if the deadline interrupted the attempt
        // before it produced a completed-item receipt.
        remainingLimit -= Math.max(receipt.value.scannedCount, attemptedUris.length - previousAttemptCount);
        // Another owner can commit without invoking our attempted-URI hook.
        refreshAfterContention ||= receipt.value.state === 'contended';
        // Retry a deadline before admission or a contended route once, with
        // the same per-pass deadline and remaining admitted-memory budget.
        if (
          receipt.value.state !== 'contended' ||
          receipt.value.pendingCount > 0 ||
          receipt.value.failedCount > 0 ||
          remainingLimit <= 0
        )
          break;
      }
    }
    const invalidationFailed =
      attemptedUris.length === 0
        ? false
        : yield* expireRecallIndexValidation(config.agentContextHome, false, attemptedUris).pipe(
            Effect.as(false),
            Effect.catchCause(() => Effect.succeed(true)),
          );
    const forceRecallRefresh = refreshAfterContention || invalidationFailed;
    let truncatedSelectorCount = 0;
    const linked = yield* loadRecallCodeLinks(config, {
      allowedUriScopes: options.allowedUriScopes ?? [contextBriefMemoryUriScope(config.user)],
      anchors: EffectArray.map(resolvedAnchors, resolved => resolved.anchor),
      eligibility: scopedEligibility.policy,
      ...(forceRecallRefresh ? {forceRefresh: true} : {}),
      includeInactive: false,
      limit: plan.candidateLimit,
      onSearchTruncated: count => {
        truncatedSelectorCount += count;
      },
    }).pipe(Effect.option);
    if (linked._tag === 'None') {
      return unavailableContextBriefCodeLinkedMemoryEvidenceAfterCapture(
        requested,
        resolvedOrdinals,
        'code-anchor-recall-unavailable',
        captureUnavailable ? ['code-anchor-resolution-unavailable'] : [],
      );
    }
    const matchesByUri = mapContextBriefCodeLinkMatches(
      linked.value,
      EffectArray.map(resolvedAnchors, resolved => ({
        ...(resolved.anchor.target.kind === 'symbol' ? {anchorNodeId: resolved.anchor.target.nodeId} : {}),
        anchorOrdinal: resolved.anchorOrdinal,
        anchorPath: resolved.anchor.path,
      })),
    );
    const rankedUris = [...matchesByUri.keys()];
    const readCandidatesResult = yield* Effect.result(
      readContextBriefMemoryCandidates(
        config,
        rankedUris,
        plan.candidateLimit,
        matchesByUri,
        true,
        options.allowedUriScopes,
      ),
    );
    if (Result.isFailure(readCandidatesResult)) {
      return unavailableContextBriefCodeLinkedMemoryEvidenceAfterCapture(
        requested,
        resolvedOrdinals,
        'code-anchor-recall-unavailable',
        captureUnavailable ? ['code-anchor-resolution-unavailable'] : [],
      );
    }
    const readCandidates = readCandidatesResult.success;
    const candidates = EffectArray.filter(
      readCandidates.candidates,
      candidate => (candidate.codeLinkMatches?.length ?? 0) > 0,
    );
    const complete = resolvedAnchors.length === requested;
    const unresolvedOrdinals = unresolvedContextBriefCodeAnchorOrdinals(requested, resolvedOrdinals);
    return {
      codeAnchorCoverage: {
        complete,
        matchedMemories: candidates.length,
        requested,
        resolved: resolvedAnchors.length,
        ...(unresolvedOrdinals.length === 0 ? {} : {unresolvedOrdinals}),
      },
      candidates,
      consideredCandidates: linked.value.length,
      gaps: stableUnique([
        ...EffectArray.filter(
          contextBriefCodeLinkRecallGaps(complete, candidates.length, truncatedSelectorCount),
          gap => !finalizationUnavailable || gap !== 'code-anchor-recall-no-active-memory',
        ),
        ...(finalizationUnavailable ? ['code-anchor-recall-unavailable'] : []),
        ...(captureUnavailable ? ['code-anchor-resolution-unavailable'] : []),
        ...(scopedEligibility.gap === undefined ? [] : [scopedEligibility.gap]),
        ...(readCandidates.stableIdentityUnavailable ? ['stable-memory-identity-unavailable'] : []),
      ]),
      trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
    } satisfies ContextBriefMemoryRetrievalV1;
  },
);

function retryContextBriefCodeAnchorRead<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  budget: {remaining: number},
): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.retry({
      schedule: Schedule.spaced(CONTEXT_BRIEF_CODE_ANCHOR_RETRY_MILLISECONDS),
      times: CONTEXT_BRIEF_CODE_ANCHOR_READ_RETRIES,
      while: error => {
        if (!Schema.is(MemoryCodeCitationCaptureError)(error) || !error.retryable || budget.remaining === 0) {
          return false;
        }
        budget.remaining -= 1;
        return true;
      },
    }),
  );
}

function isUnresolvedContextBriefCodeAnchorFailure(error: unknown): boolean {
  return (
    Schema.is(MemoryCodeCitationCaptureError)(error) &&
    (error.failureCode === 'code-reference-unresolved' || error.failureCode === 'outside-project-graph')
  );
}

function isUnexpectedContextBriefCodeAnchorFailure(error: unknown): boolean {
  return (
    !Schema.is(MemoryCodeCitationCaptureError)(error) ||
    (error.failureCode === undefined && error.recovery === undefined)
  );
}

const readContextBriefMemoryCandidates = Effect.fn('contextBrief.readMemoryCandidates')(function* (
  config: RuntimeConfig,
  rankedUris: readonly string[],
  limit: number,
  codeLinkMatchesByUri: ReadonlyMap<string, NonNullable<ContextBriefMemoryCandidateV1['codeLinkMatches']>> = new Map(),
  requireResolvableMemoryIdentity = false,
  allowedUriScopes: readonly string[] = [contextBriefMemoryUriScope(config.user)],
) {
  const scopedUris = EffectArray.filter(
    rankedUris,
    __effectArrayValue =>
      !!(uri => EffectArray.some(allowedUriScopes, scope => resourceIdIsWithin(uri, scope)))(__effectArrayValue),
  );
  const records = yield* readMemoryRecordsByUri(config, scopedUris);
  const recordsByUri = new Map(EffectArray.map(records, record => [record.uri, record]));
  const memoryIds = [
    ...new Set(
      EffectArray.flatMap(records, record =>
        record.metadata.memoryId !== undefined && isMemoryId(record.metadata.memoryId)
          ? [record.metadata.memoryId]
          : [],
      ),
    ),
  ];
  const identityCandidates =
    requireResolvableMemoryIdentity && memoryIds.length > 0
      ? yield* loadRecallMemoryIdentities(config, {allowedUriScopes, memoryIds})
      : [];
  const resolvableMemoryIds = new Set(
    EffectArray.filter(
      memoryIds,
      memoryId => classifyMemoryIdentityCandidates(identityCandidates, memoryId, allowedUriScopes).state === 'resolved',
    ),
  );
  const candidates: ContextBriefMemoryCandidateV1[] = [];
  const seen = new Set<string>();
  let stableIdentityUnavailable = false;
  for (const uri of scopedUris) {
    if (seen.has(uri)) continue;
    seen.add(uri);
    const record = recordsByUri.get(uri);
    if (!contextBriefMemoryRecordIsEligible(record)) continue;
    const memoryId = record.metadata.memoryId;
    const identityResolvable =
      !requireResolvableMemoryIdentity ||
      (memoryId !== undefined && isMemoryId(memoryId) && resolvableMemoryIds.has(memoryId));
    if (!identityResolvable) stableIdentityUnavailable = true;
    const attention = hasTopicMaintenanceEnrollment(record)
      ? yield* readTopicReviewAttention(config, record)
      : {attention: 'none' as const};
    candidates.push(
      contextBriefMemoryCandidate(
        record,
        candidates.length,
        codeLinkMatchesByUri.get(uri),
        identityResolvable,
        attention,
      ),
    );
    if (candidates.length >= limit) break;
  }
  return {candidates, stableIdentityUnavailable};
});

/** Private bounded state read: the ordinary review loader synchronizes audit files. */
const readTopicReviewAttention = Effect.fn('contextBrief.readTopicReviewAttention')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
) {
  const reviewId = `review-${Effect2.pipe(sha256HexSync(`topic-maintenance\0${record.uri}`), EffectString.slice(0, 24))}`;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(config.agentContextHome, 'threadnote', 'candidates', 'v1', 'reviews', `${reviewId}.json`);
  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return {attention: 'none' as const};
  const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
  if (raw === undefined) return {attention: 'review-unavailable' as const};
  const review = yield* Effect.try(() => parseCandidateReview(JSON.parse(raw))).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (
    review === undefined ||
    review.reviewId !== reviewId ||
    review.maintenance?.basis.targetUri !== record.uri ||
    review.maintenance.basis.targetHash !== sha256HexSync(canonicalMemoryDocumentContent(record.content))
  )
    return {attention: 'review-unavailable' as const};
  return review.candidates[0]?.state === 'pending'
    ? {attention: 'pending-review' as const, reviewId}
    : {attention: 'none' as const};
});
