import {DateTime, Effect, FileSystem, Result, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {
  assertTopicMaintenanceAcceptanceCoverage,
  prepareTopicMaintenanceAcceptance,
} from '@threadnote/memory/topic-maintenance-acceptance';
import {
  candidateReviewWithState,
  loadCandidateReview,
  saveCandidateReview,
  withCandidateReviewLock,
  type CandidateReview,
} from '@threadnote/memory/candidate';
import {readMemoryRecordsByUri, writeApprovedTopicMaintenanceContent} from '../../mcp/server/memory.js';
import {maintenanceContentHash} from './maintenance_policy.js';
import {verifyTopicMaintenanceReviewSource} from './maintenance_review_source.js';
import {readContextMaintenanceStatus, recordTopicMaintenanceReviewDecision} from './maintenance.js';

export class TopicReviewError extends Schema.TaggedError<TopicReviewError>()('TopicReviewError', {
  message: Schema.String,
}) {}
const fail = (message: string) => TopicReviewError.make({message});

export interface TopicReviewDecisionInput {
  readonly reviewId: string;
  readonly revision: number;
  readonly action: 'reject' | 'defer' | 'resume';
  readonly caseId?: string;
}

export interface TopicReviewPrepareInput {
  readonly reviewId: string;
  readonly revision: number;
  readonly sourceCwd: string;
  readonly editedDraftJson?: string;
}

export interface TopicReviewApplyInput {
  readonly reviewId: string;
  readonly revision: number;
  readonly sourceCwd: string;
  readonly approvalDigest: string;
  readonly approved: boolean;
}

function validSelection(reviewId: string, revision: number) {
  return /^review-[0-9a-f]{24}$/u.test(reviewId) && Number.isSafeInteger(revision) && revision > 0;
}

function selectedReview(review: CandidateReview, revision: number) {
  return review.maintenance !== undefined && review.candidates.length === 1 && review.revision === revision;
}

/** Rebuild a complete private preview from one exact accepted baseline and pinned review evidence. */
export const prepareTopicMaintenanceReview = Effect.fn('topicMaintenance.prepareReview')(function* (
  config: RuntimeConfig,
  input: TopicReviewPrepareInput,
  suppliedTarget?: MemoryRecord,
) {
  if (!validSelection(input.reviewId, input.revision)) return yield* fail('Select an exact topic review and revision.');
  return yield* withCandidateReviewLock(
    config.agentContextHome,
    input.reviewId,
    Effect.gen(function* () {
      const review = yield* loadCandidateReview(config.agentContextHome, input.reviewId);
      if (
        !selectedReview(review, input.revision) ||
        review.candidates[0]?.state !== 'pending' ||
        review.maintenanceApproval?.stage === 'prepared' ||
        review.maintenanceApproval?.stage === 'written' ||
        review.maintenanceApproval?.stage === 'conflict'
      )
        return yield* fail('The selected topic review changed or is not pending. Read its current revision.');
      const payload = review.maintenance!;
      const [local] = suppliedTarget ? [] : yield* readMemoryRecordsByUri(config, [payload.basis.targetUri]);
      const target = suppliedTarget ?? local;
      if (
        !target ||
        target.uri !== payload.basis.targetUri ||
        maintenanceContentHash(target.content) !== payload.basis.targetHash
      )
        return yield* fail('The accepted topic changed before approval preview.');
      yield* verifyTopicMaintenanceReviewSource(config, target, payload, input.sourceCwd);
      const approvedAt = DateTime.formatIso(yield* DateTime.now);
      const preview = yield* Effect.try({
        try: () =>
          prepareTopicMaintenanceAcceptance(target, payload, {
            reviewId: review.reviewId,
            approvedAt,
            editedDraftJson:
              input.editedDraftJson ??
              (review.maintenanceApproval?.stage === 'parked'
                ? JSON.stringify(review.maintenanceApproval.preview.approvedProposal.draft)
                : undefined),
          }),
        catch: cause => fail(cause instanceof Error ? cause.message : 'The reviewed topic cannot be prepared.'),
      });
      const updated: CandidateReview = {
        ...review,
        revision: review.revision + 1,
        maintenanceApproval: {version: 1, reviewRevision: review.revision + 1, stage: 'preview', preview},
      };
      yield* saveCandidateReview(config.agentContextHome, updated);
      return updated;
    }),
  );
});

/** Applies only the exact prepared document; a persisted prepare receipt makes retries crash-safe. */
export const applyTopicMaintenanceReview = Effect.fn('topicMaintenance.applyReview')(function* (
  config: RuntimeConfig,
  input: TopicReviewApplyInput,
) {
  if (
    !validSelection(input.reviewId, input.revision) ||
    !/^[a-f0-9]{64}$/u.test(input.approvalDigest) ||
    input.approved !== true
  )
    return yield* fail('Apply requires an exact review revision, digest, and approved=true.');
  return yield* withCandidateReviewLock(
    config.agentContextHome,
    input.reviewId,
    Effect.gen(function* () {
      let review = yield* loadCandidateReview(config.agentContextHome, input.reviewId);
      const approval = review.maintenanceApproval;
      const payload = review.maintenance;
      if (
        !approval ||
        !payload ||
        review.candidates.length !== 1 ||
        approval.reviewRevision !== input.revision ||
        approval.preview.approvalDigest !== input.approvalDigest ||
        approval.preview.targetUri !== payload.basis.targetUri
      )
        return yield* fail('The approval revision or digest changed. Read the current preview.');
      const uri = approval.preview.targetUri;
      if (!uri.startsWith(`threadnote://user/${config.user}/memories/durable/`))
        return yield* fail('Only personal durable topics can be applied here.');
      const fs = yield* FileSystem.FileSystem;
      return yield* withMemoryUriLocks(
        fs,
        config.agentContextHome,
        [uri],
        Effect.gen(function* () {
          const preview = approval.preview;
          const original = parseMemoryDocument(uri, preview.beforeContent);
          if (!original || maintenanceContentHash(original.content) !== preview.beforeContentHash)
            return yield* fail('The prepared target baseline is unavailable.');
          const sourceCheck = verifyTopicMaintenanceReviewSource(config, original, payload, input.sourceCwd);
          const readTarget = () => readMemoryRecordsByUri(config, [uri]).pipe(Effect.map(records => records[0]));
          let current = yield* readTarget();
          if (!current) return yield* fail('The accepted topic disappeared before application.');
          if (approval.stage === 'conflict' || review.candidates[0]?.state === 'conflict')
            return yield* fail('The topic review has a recorded conflict. Resolve it before applying again.');
          if (approval.stage === 'written') {
            if (review.candidates[0]?.state !== 'applied' || current.content !== preview.content)
              return yield* fail('The written topic receipt no longer matches the accepted document.');
            yield* sourceCheck;
            return review;
          }
          if (current.content !== original.content && current.content !== preview.content)
            return yield* fail('The accepted topic changed after approval preview.');
          if (current.content === original.content)
            yield* Effect.try({
              try: () => assertTopicMaintenanceAcceptanceCoverage(payload, preview.approvedProposal),
              catch: cause => fail(cause instanceof Error ? cause.message : 'Paragraph review is incomplete.'),
            });
          if (approval.stage === 'preview') {
            if (
              review.revision !== input.revision ||
              review.candidates[0]?.state !== 'pending' ||
              current.content !== original.content
            )
              return yield* fail('The pending topic preview changed. Read its current revision.');
            yield* sourceCheck;
            review = candidateReviewWithState(review, review.candidates[0].candidateId, 'applying', {
              action: 'begin_apply',
              at: DateTime.formatIso(yield* DateTime.now),
            });
            review = {...review, maintenanceApproval: {...approval, stage: 'prepared'}};
            yield* saveCandidateReview(config.agentContextHome, review);
          } else if (approval.stage !== 'prepared' || review.candidates[0]?.state !== 'applying') {
            return yield* fail('The topic review is not in a recoverable prepared state.');
          }
          if (current.content === original.content) {
            const wrote = yield* writeApprovedTopicMaintenanceContent(
              config,
              review,
              original.content,
              sourceCheck,
            ).pipe(Effect.result);
            if (Result.isFailure(wrote)) {
              current = yield* readTarget();
              if (current?.content !== preview.content) {
                if (current?.content !== original.content) {
                  const conflicted = candidateReviewWithState(review, review.candidates[0].candidateId, 'conflict', {
                    action: 'conflict',
                    at: DateTime.formatIso(yield* DateTime.now),
                  });
                  yield* saveCandidateReview(config.agentContextHome, {
                    ...conflicted,
                    maintenanceApproval: {...approval, stage: 'conflict'},
                  });
                }
                return yield* fail(
                  'The approved topic write did not complete; its prepared receipt remains retryable.',
                );
              }
            }
          }
          current = yield* readTarget();
          const close = yield* Effect.gen(function* () {
            if (current?.content !== preview.content) return yield* fail('Approved write readback differs.');
            return yield* sourceCheck;
          }).pipe(Effect.result);
          if (Result.isFailure(close)) {
            const conflicted = candidateReviewWithState(review, review.candidates[0].candidateId, 'conflict', {
              action: 'conflict',
              at: DateTime.formatIso(yield* DateTime.now),
            });
            yield* saveCandidateReview(config.agentContextHome, {
              ...conflicted,
              maintenanceApproval: {...approval, stage: 'conflict'},
            });
            return yield* fail(
              'The approved write completed, but exact readback or source freshness failed. Review the conflict.',
            );
          }
          const applied = candidateReviewWithState(review, review.candidates[0].candidateId, 'applied', {
            action: 'apply',
            at: DateTime.formatIso(yield* DateTime.now),
            memoryUri: uri,
          });
          const completed = {...applied, maintenanceApproval: {...approval, stage: 'written' as const}};
          yield* saveCandidateReview(config.agentContextHome, completed);
          return completed;
        }),
      );
    }),
  );
});

/** Decisions are revision-bound and use the same private review lock as preparation and application. */
export const decideTopicMaintenanceReview = Effect.fn('topicMaintenance.decideReview')(function* (
  config: RuntimeConfig,
  input: TopicReviewDecisionInput,
  reconcile: typeof recordTopicMaintenanceReviewDecision = recordTopicMaintenanceReviewDecision,
) {
  if (!/^review-[0-9a-f]{24}$/u.test(input.reviewId) || !Number.isSafeInteger(input.revision) || input.revision < 1)
    return yield* fail('Select an exact topic review and revision.');
  return yield* withCandidateReviewLock(
    config.agentContextHome,
    input.reviewId,
    Effect.gen(function* () {
      const review = yield* loadCandidateReview(config.agentContextHome, input.reviewId);
      const candidate = review.candidates[0];
      if (!review.maintenance || !candidate)
        return yield* fail('The selected topic review changed. Read its current revision.');
      const nextState = input.action === 'resume' ? 'pending' : input.action === 'reject' ? 'rejected' : 'deferred';
      const replay =
        review.revision === input.revision + 1 &&
        candidate.state === nextState &&
        review.auditEvents.at(-1)?.action === input.action &&
        review.auditEvents.at(-1)?.revision === review.revision;
      if (review.maintenance.generation.origin !== 'manual') {
        if (!input.caseId) return yield* fail('Select the exact topic maintenance case for this review decision.');
        const status = yield* readContextMaintenanceStatus(config, undefined, {caseId: input.caseId});
        const item = status.cases[0];
        if (
          item?.family !== 'topic-maintenance' ||
          item.project !== review.project ||
          item.slot !== 'declared-support' ||
          item.subjectUri !== review.maintenance.basis.targetUri ||
          (input.action === 'resume' &&
            !replay &&
            item.evidenceRevision !== review.maintenance.basis.observationRevision)
        )
          return yield* fail('The selected topic case no longer matches this review.');
      }
      if (replay) {
        if (review.maintenance.generation.origin !== 'manual')
          yield* reconcile(config, {
            caseId: input.caseId!,
            observationRevision: review.maintenance.basis.observationRevision,
            action: input.action,
            onStale: 'ignore',
          });
        return review;
      }
      if (review.revision !== input.revision)
        return yield* fail('The selected topic review changed. Read its current revision.');
      const closingConflict =
        input.action === 'reject' && candidate.state === 'conflict' && review.maintenanceApproval?.stage === 'conflict';
      if (
        review.maintenanceApproval &&
        review.maintenanceApproval.stage !== 'preview' &&
        review.maintenanceApproval.stage !== 'parked' &&
        !closingConflict
      )
        return yield* fail('The topic approval is already applying or recorded as a conflict.');
      const expected = input.action === 'resume' ? 'deferred' : 'pending';
      if (candidate.state !== expected && !closingConflict)
        return yield* fail(`A ${input.action} decision requires a ${expected} topic review.`);
      const at = DateTime.formatIso(yield* DateTime.now);
      const updated = candidateReviewWithState(review, candidate.candidateId, nextState, {action: input.action, at});
      const decided = closingConflict
        ? {
            ...updated,
            maintenanceClosedConflict: {
              version: 1 as const,
              reviewRevision: review.maintenanceApproval.reviewRevision,
              targetUri: review.maintenanceApproval.preview.targetUri,
              beforeContentHash: review.maintenanceApproval.preview.beforeContentHash,
              contentHash: review.maintenanceApproval.preview.contentHash,
              approvalDigest: review.maintenanceApproval.preview.approvalDigest,
            },
          }
        : {
            ...updated,
            maintenanceApproval:
              input.action === 'reject' || !review.maintenanceApproval
                ? undefined
                : {...review.maintenanceApproval, stage: 'parked' as const},
          };
      yield* saveCandidateReview(config.agentContextHome, decided);
      if (decided.maintenance!.generation.origin !== 'manual')
        yield* reconcile(config, {
          caseId: input.caseId!,
          observationRevision: decided.maintenance!.basis.observationRevision,
          action: input.action,
          ...(input.action === 'resume' ? {} : {onStale: 'ignore' as const}),
        });
      return decided;
    }),
  );
});
