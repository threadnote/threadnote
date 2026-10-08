import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {DateTime, Effect, FileSystem, Option, Predicate, Result, Schema} from 'effect';
import {
  activePersonalMemoryUrisFromText,
  existingReferencedUris,
  formatReferencedContextPointers,
  recallHygieneNudges,
  referencedUrisFromRecords,
} from '@threadnote/memory/hygiene';
import {applyScrubber} from '../../share/index.js';
import {errorMessage} from '@threadnote/platform/errors';
import {resolveWorkspaceRepoName} from '../../utils.js';
import {
  EffectMcpServerAdapter,
  McpInput,
  type McpProgressUpdate,
  type McpToolProgress,
  withMcpProgressHeartbeat,
} from '../../effect/ai/mcp.js';
import {
  expandWeakRecallQueryEffect,
  limitRecallRewritesForConfidence,
  mergeRecallRewritesForConfidence,
  recallHybridMinimumScore,
  recallRewriteLimitForConfidence,
  shouldExpandRecall,
} from '../../effect/ai/recall.js';
import {sha256Hex} from '@threadnote/platform/digest';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {
  assertMemoryRecordArchivable,
  canonicalMemoryDocumentContent,
  isSharedMemoryUri,
  MEMORY_RELATION_TYPES,
  memoryArchiveBody,
  memoryArchiveMetadata,
  type MemoryMetadata,
} from '@threadnote/memory/document';
import {captureMemoryCodeCitationsForMcp} from '../memory_code_citation.js';
import {makeMcpRecallCandidateSelector} from './recall_selection.js';
import {MAX_MEMORY_CODE_CITATIONS, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {
  MEMORY_READ_MAXIMUM_CONTENT_BYTES,
  MemoryReadProjectionError,
  MemoryReadTooLargeError,
  memoryReadMcpStructuredContent,
  memoryReadMcpText,
  projectMemoryRead,
  type MemoryReadResource,
} from '@threadnote/memory/read/projection';
import {
  buildCandidateReview,
  assessReplacementSafety,
  candidateReviewWithAuditEvent,
  candidateReviewWithApplyStage,
  candidateReviewWithApplying,
  candidateReviewWithState,
  loadCandidateReview,
  readActiveProjectMemories,
  prepareCandidateReplacementRecovery,
  replacementSafetyReviewRequiredWarning,
  replacementSafetyBaseline,
  saveCandidateReview,
  type CandidateReview,
  type CandidateApplyOperation,
  type MemoryCandidate,
  type SessionCloseoutInput,
  structuredCloseoutFromInput,
  validateSessionCloseoutInput,
  withCandidateReviewLock,
} from '@threadnote/memory/candidate';
import {projectKnowledgeDeltaV1, replacementSafetyWarning} from '@threadnote/memory/knowledge_delta';
import {recordRecallFeedback} from '@threadnote/recall/feedback';
import {AgentResponseBudgetTooSmallError} from '@threadnote/protocol/agent-response';
import {
  cursorCloudMemoryScopeReceipt,
  cursorCloudScopeRoots,
  cursorCloudScopeTeams,
  cursorCloudShareForTeam,
  cursorCloudShareForUri,
  cursorCloudUriWithinScope,
  type CursorCloudMemoryScope,
} from '../../cursor/cloud.js';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {memoryReadRecoveryForRequestedUri, memoryReadRecoveryText} from '@threadnote/memory/read/recovery';
import {RECALL_RANKER_VERSION} from '@threadnote/recall/rank';
import {
  parseRecallMemoryConnectionInput,
  type ParsedRecallMemoryConnectionInput,
} from '@threadnote/recall/memory/connections';
import type {MemoryRelationType} from '@threadnote/memory/document';
import {
  projectRecallMcpResponse,
  RECALL_MCP_RESPONSE_MAXIMUM_ESTIMATED_TOKENS,
  RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS,
} from '@threadnote/recall/mcp/response';
import {mergeRecallOperationalWarnings} from '@threadnote/recall/warning';
import {syncSourcesBeforeRecall} from '../../integrations/source.js';
import {withProductionPhaseTiming} from '../../effect/production_log.js';
import {withAnonymousTelemetryPhase} from '../../effect/telemetry.js';
import type {ApplyMemoryCandidateInput} from '../../memory/candidate_apply_contract.js';
import {
  buildRecallIndexSelectionCandidates,
  buildRecallSelectionCandidates,
  createRecallRerankerCache,
  loadRecallExpansionVocabulary,
  loadMcpRecallSemanticScoresResult,
  prepareRecallSections,
  recallSelectionAnchorIds,
  recallSelectionQueries,
  selectedRecallCandidateUris,
  type McpRecallSemanticScoresResult,
} from '@threadnote/recall/runtime';
import {
  McpServerOperationError,
  type RecallProgressTiming,
  type RuntimeConfig,
  argumentError,
  compactPersonalMemoryReferences,
  compactPersonalMemoryStructuredReferences as compactStructuredReferences,
  mcpErrorResult,
  normalizeOptionalMetadata,
  optionalResourceUri,
  requiredResourceUri,
  requiredResourceUriList,
  requiredText,
  uriSegment,
  withStaleVersionNotice,
} from './common.js';
import {
  type WriteDurableMemoryParams,
  forgetResourceWithRetry,
  preparePersonalMemoryWrite,
  readMemoryRecordsByUri,
  removeResourceWithRetry,
  resourceExists,
  runNativeReadTool,
  textFromCallToolResult,
  writeDurableMemory,
} from './memory.js';
import {syncCursorCloudMemoryShares} from './cursor_cloud_memory.js';
import {resolveRecallWorkspaceContext} from './recall_workspace_context.js';
import {resourceIdIsWithin} from '@threadnote/store/resource-id';

function stringList(value: string | readonly string[] | undefined): readonly string[] {
  return typeof value === 'string' ? [value] : (value ?? []);
}

function commonCitationSourceCommit(citations: readonly {readonly sourceCommit: string}[]): string | undefined {
  const commits = new Set(citations.map(citation => citation.sourceCommit));
  return commits.size === 1 ? citations[0]?.sourceCommit : undefined;
}

export function registerCandidateMemoryTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'review_session_context',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'Review an optional five-field Knowledge Delta (decisions + rationale, constraints, verificationPerformed, knowledgeInvalidated, unresolvedRisks); handoff is separate and required. Preview only; explicit approval is required to apply, and nothing is auto-shared.',
      inputSchema: {
        callerCwd: McpInput.string('Absolute cwd'),
        codeRefs: McpInput.stringOrStrings(`Graph-indexed repository-relative path; max ${MAX_MEMORY_CODE_CITATIONS}`, {
          maximumItems: MAX_MEMORY_CODE_CITATIONS,
        }),
        rationale: McpInput.string('Why'),
        constraints: McpInput.stringOrStrings('Limits'),
        verificationPerformed: McpInput.stringOrStrings('Checks'),
        knowledgeInvalidated: McpInput.stringOrStrings('Invalidated'),
        unresolvedRisks: McpInput.stringOrStrings('Risks'),
        decisions: McpInput.stringOrStrings('Decisions'),
        evidence: McpInput.stringOrStrings('Evidence'),
        handoff: McpInput.stringOrStrings('Handoff'),
        invariants: McpInput.stringOrStrings('Invariants'),
        outcome: McpInput.string('Task outcome'),
        preferences: McpInput.stringOrStrings('User preferences'),
        project: McpInput.string('Project; infer from cwd'),
        sourceAgentClient: McpInput.string('Client'),
        sourceCommit: McpInput.string('Commit'),
        sourceSessionId: McpInput.string('Session'),
        task: McpInput.string('Task'),
        topic: McpInput.string('Topic'),
      },
    },
    ({
      callerCwd,
      codeRefs,
      rationale,
      constraints,
      verificationPerformed,
      knowledgeInvalidated,
      unresolvedRisks,
      decisions,
      evidence,
      handoff,
      invariants,
      outcome,
      preferences,
      project,
      sourceAgentClient,
      sourceCommit,
      sourceSessionId,
      task,
      topic,
    }) => {
      const checkedTask = requiredText(task, 'review_session_context', 'task', {
        task: 'Improve recall and memory formation',
      });
      if (!checkedTask.ok) {
        return checkedTask.error;
      }
      const checkedOutcome = requiredText(outcome, 'review_session_context', 'outcome', {
        outcome: 'Implemented candidate review workflow',
      });
      if (!checkedOutcome.ok) {
        return checkedOutcome.error;
      }
      return Effect.gen(function* () {
        const candidatePolicy = parseCandidatePolicy((yield* SystemInfo).environment().THREADNOTE_CANDIDATE_POLICY);
        if (candidatePolicy === 'off') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Session memory suggestions are disabled by THREADNOTE_CANDIDATE_POLICY=off.',
              },
            ],
            structuredContent: {candidates: [], noAction: true},
          };
        }
        const inferredProject =
          normalizeOptionalMetadata(project) ??
          (callerCwd ? yield* resolveWorkspaceRepoName({cwd: callerCwd, includeProcessCwd: false}) : undefined);
        if (!inferredProject) {
          return argumentError(
            'review_session_context requires project or an absolute callerCwd from which the repo can be inferred.',
          );
        }
        const requestedCodeRefs = stringList(codeRefs);
        if (requestedCodeRefs.length > 0 && !callerCwd) {
          return argumentError('review_session_context requires absolute callerCwd when codeRefs are provided.');
        }
        const captured = yield* captureMemoryCodeCitationsForMcp(
          config,
          {callerCwd: callerCwd!, refs: requestedCodeRefs},
          'review_session_context',
        );
        if (!captured.ok) return captured.error;
        const codeCitations = captured.citations;
        const rawCloseout: SessionCloseoutInput = {
          ...(codeCitations.length === 0 ? {} : {codeCitations}),
          ...(candidatePolicy === 'handoff-only' || rationale === undefined ? {} : {rationale}),
          ...(candidatePolicy === 'handoff-only' || constraints === undefined
            ? {}
            : {constraints: stringList(constraints)}),
          decisions: candidatePolicy === 'handoff-only' ? [] : stringList(decisions),
          evidence: stringList(evidence),
          handoff: stringList(handoff),
          invariants: candidatePolicy === 'handoff-only' ? [] : stringList(invariants),
          ...(candidatePolicy === 'handoff-only' || verificationPerformed === undefined
            ? {}
            : {verificationPerformed: stringList(verificationPerformed)}),
          ...(candidatePolicy === 'handoff-only' || knowledgeInvalidated === undefined
            ? {}
            : {knowledgeInvalidated: stringList(knowledgeInvalidated)}),
          outcome: checkedOutcome.value,
          preferences: candidatePolicy === 'handoff-only' ? [] : stringList(preferences),
          project: inferredProject,
          sourceAgentClient: sourceAgentClient?.trim() || 'mcp',
          sourceCommit: normalizeOptionalMetadata(sourceCommit) ?? commonCitationSourceCommit(codeCitations),
          sourceSessionId: normalizeOptionalMetadata(sourceSessionId),
          task: checkedTask.value,
          topic: normalizeOptionalMetadata(topic) ?? uriSegment(checkedTask.value),
          ...(candidatePolicy === 'handoff-only' || unresolvedRisks === undefined
            ? {}
            : {unresolvedRisks: stringList(unresolvedRisks)}),
        };
        const closeoutSizeError = validateSessionCloseoutInput(rawCloseout);
        if (closeoutSizeError) {
          return argumentError(`Refusing session review: ${closeoutSizeError}`);
        }
        const closeout = scrubSessionCloseout(rawCloseout);
        if (!closeout.ok) {
          return argumentError(closeout.error);
        }
        if (sessionCloseoutHasCandidateMaterial(closeout.input) && !sessionCloseoutHasEvidence(closeout.input)) {
          return argumentError(
            'review_session_context requires at least one evidence pointer, sourceSessionId, or sourceCommit before proposing durable memory.',
          );
        }
        const existing = yield* readActiveProjectMemories(config, closeout.input.project);
        const now = yield* DateTime.nowAsDate;
        const review = yield* buildCandidateReview(closeout.input, existing, now);
        yield* saveCandidateReview(config.agentContextHome, review);
        return candidateReviewResult(review);
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );

  server.registerTool(
    'apply_memory_candidates',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: 'Apply an explicit user decision to one pending candidate with revision checking.',
      inputSchema: {
        action: McpInput.literals(['approve', 'defer', 'reject'], 'User decision'),
        allowDestructiveReplacement: McpInput.boolean(
          'Required true only to approve a replacement flagged as destructive content loss',
        ),
        approved: McpInput.boolean('Required true for approved writes'),
        candidateId: McpInput.string('Candidate ID from review'),
        editedText: McpInput.string('User-edited memory text'),
        operation: McpInput.literals(['create', 'replace'], 'Create new memory or replace reviewed target'),
        replaceUri: McpInput.string('Exact reviewed target for replace'),
        reviewId: McpInput.string('Review ID'),
        revision: McpInput.integer('Review revision', {minimum: 1}),
      },
    },
    ({
      action,
      allowDestructiveReplacement,
      approved,
      candidateId,
      editedText,
      operation,
      replaceUri,
      reviewId,
      revision,
    }) =>
      applyMemoryCandidate(config, {
        action,
        allowDestructiveReplacement,
        approved,
        candidateId,
        editedText,
        operation,
        replaceUri,
        reviewId,
        revision,
      }),
  );
}

interface ApplyMemoryCandidateOptions {
  readonly reviewLockHeld?: boolean;
}

export function applyMemoryCandidate(
  config: RuntimeConfig,
  {
    action,
    allowDestructiveReplacement,
    allowMissingReplacementCreate,
    approved,
    candidateId,
    editedText,
    operation,
    replaceUri,
    reviewId,
    revision,
  }: ApplyMemoryCandidateInput,
  options: ApplyMemoryCandidateOptions = {},
) {
  const checkedReviewId = requiredText(reviewId, 'apply_memory_candidates', 'reviewId', {
    reviewId: 'review-0123456789abcdef',
  });
  if (!checkedReviewId.ok) {
    return Effect.succeed(checkedReviewId.error);
  }
  const checkedCandidateId = requiredText(candidateId, 'apply_memory_candidates', 'candidateId', {
    candidateId: 'review-0123456789abcdef-1',
  });
  if (!checkedCandidateId.ok) {
    return Effect.succeed(checkedCandidateId.error);
  }
  const checkedReplaceUri = optionalResourceUri(replaceUri, 'apply_memory_candidates');
  if (!checkedReplaceUri.ok) {
    return Effect.succeed(checkedReplaceUri.error);
  }
  if (!action) {
    return Effect.succeed(argumentError('apply_memory_candidates requires action: approve, defer, or reject.'));
  }
  if (revision === undefined) {
    return Effect.succeed(argumentError('apply_memory_candidates requires the current review revision.'));
  }
  if (action === 'approve' && approved !== true) {
    return Effect.succeed(argumentError('approve requires approved=true after explicit user approval.'));
  }
  return withOptionalCandidateReviewLock(
    config.agentContextHome,
    checkedReviewId.value,
    options.reviewLockHeld === true,
    Effect.gen(function* () {
      const review = yield* loadCandidateReview(config.agentContextHome, checkedReviewId.value);
      const candidate = review.candidates.find(item => item.candidateId === checkedCandidateId.value);
      if (!candidate) {
        return argumentError(`Candidate ${checkedCandidateId.value} is not part of ${checkedReviewId.value}.`);
      }
      if (
        action === 'approve' &&
        candidate.state === 'applied' &&
        (review.revision === revision || review.revision === revision + 1)
      ) {
        const memoryMessage = candidate.applyTargetUri ? ` at ${candidate.applyTargetUri}` : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Candidate ${candidate.candidateId} was already approved${memoryMessage}.`,
            },
          ],
          structuredContent: candidateReviewStructuredContent(review, {
            action: candidate.applyTargetUri ? 'approve' : 'no_action',
            candidateId: candidate.candidateId,
            memoryUri: candidate.applyTargetUri,
            reviewId: review.reviewId,
            revision: review.revision,
          }),
        };
      }
      if (review.revision !== revision) {
        return argumentError(
          `Candidate review revision changed: expected ${revision}, current ${review.revision}. Review it again before applying.`,
        );
      }
      if (candidate.state === 'applying' && candidate.applyTargetUri) {
        const [appliedRecord] = yield* readMemoryRecordsByUri(config, [candidate?.applyTargetUri]);
        if (appliedRecord?.metadata.candidateId === candidate.candidateId) {
          if (
            !candidate.applyContentHash ||
            (yield* sha256Hex(canonicalMemoryDocumentContent(appliedRecord.content))) !== candidate.applyContentHash
          ) {
            return yield* persistCandidateConflict(
              config,
              review,
              candidate,
              `Candidate ${candidate.candidateId} found mismatched content at ${candidate.applyTargetUri}. The partial apply is recorded as a conflict.`,
            );
          }
          const cleanupTargetUri =
            candidate.applyReplaceUri !== candidate.applyTargetUri ? candidate.applyReplaceUri : undefined;
          const [cleanupTarget] = cleanupTargetUri ? yield* readMemoryRecordsByUri(config, [cleanupTargetUri]) : [];
          const cleanupTargetHash = cleanupTarget
            ? yield* sha256Hex(canonicalMemoryDocumentContent(cleanupTarget.content))
            : undefined;
          const recovery = prepareCandidateReplacementRecovery(
            review,
            candidate.candidateId,
            allowDestructiveReplacement === true,
            candidate.applyApprovedAt ?? appliedRecord.metadata.timestamp,
            cleanupTarget?.body,
            cleanupTargetHash,
          );
          if (recovery.status === 'unavailable') {
            return argumentError(
              `Candidate ${candidate.candidateId} cannot safely recover replacement cleanup because its approved body or target hash is missing. Review both memories before continuing.`,
            );
          }
          if (recovery.status === 'destructive-approval-required') {
            return argumentError(
              `${replacementSafetyWarning(recovery.assessment)} Read ${candidate.applyReplaceUri}, then retry with allowDestructiveReplacement=true after explicit approval.`,
            );
          }
          const {candidate: recoveryCandidate, review: recoveryReview} = recovery;
          if (recoveryReview !== review) {
            yield* saveCandidateReview(config.agentContextHome, recoveryReview);
          }
          const cleanup = yield* reconcileCandidateReplacementCleanup(config, recoveryCandidate);
          if (cleanup === 'conflict') {
            return yield* persistCandidateConflict(
              config,
              recoveryReview,
              recoveryCandidate,
              `Candidate ${candidate.candidateId} was written at ${candidate.applyTargetUri}, but its reviewed replacement target changed before cleanup. The partial apply is recorded as a conflict; review both memories before continuing.`,
            );
          }
          if (cleanup === 'pending') {
            const pendingCleanup = candidateReviewWithApplyStage(
              recoveryReview,
              recoveryCandidate.candidateId,
              'cleanup_pending',
            );
            yield* saveCandidateReview(config.agentContextHome, pendingCleanup);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Candidate ${candidate.candidateId} is stored at ${candidate.applyTargetUri}, but its reviewed replacement still exists. Retry this approval to finish cleanup.`,
                },
              ],
              isError: true,
              structuredContent: candidateReviewStructuredContent(pendingCleanup, {
                action: 'cleanup_pending',
                candidateId: candidate.candidateId,
                memoryUri: candidate.applyTargetUri,
                reviewId: review.reviewId,
                revision: review.revision,
              }),
            };
          }
          const withBeginAudit = candidateReviewWithAuditEvent(recoveryReview, {
            action: 'begin_apply',
            ...(recoveryCandidate.applyAllowDestructiveReplacement ? {allowDestructiveReplacement: true} : {}),
            at: appliedRecord.metadata.timestamp,
            candidateId: recoveryCandidate.candidateId,
            memoryUri: recoveryCandidate.applyTargetUri,
            reviewId: recoveryReview.reviewId,
            revision: recoveryReview.revision,
          });
          const recovered = candidateReviewWithState(withBeginAudit, recoveryCandidate.candidateId, 'applied', {
            action: 'apply',
            ...(recoveryCandidate.applyAllowDestructiveReplacement ? {allowDestructiveReplacement: true} : {}),
            at: appliedRecord.metadata.timestamp,
            memoryUri: recoveryCandidate.applyTargetUri,
          });
          yield* saveCandidateReview(config.agentContextHome, recovered);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Recovered approved candidate ${candidate.candidateId} at ${candidate.applyTargetUri}.`,
              },
            ],
            structuredContent: candidateReviewStructuredContent(recovered, {
              action: 'approve',
              candidateId: candidate.candidateId,
              memoryUri: candidate.applyTargetUri,
              reviewId: review.reviewId,
              revision: recovered.revision,
            }),
          };
        }
      }
      if (candidate.state === 'applied' || candidate.state === 'conflict' || candidate.state === 'rejected') {
        return argumentError(`Candidate ${candidate.candidateId} is already ${candidate.state}.`);
      }
      const at = DateTime.formatIso(yield* DateTime.now);
      if (action === 'defer' || action === 'reject') {
        if (candidate.state === 'applying') {
          return argumentError(
            `Candidate ${candidate.candidateId} has an interrupted approval in progress. Retry approve to recover it before recording another decision.`,
          );
        }
        if (action === 'defer' && candidate.state === 'deferred') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Candidate ${candidate.candidateId} is already deferred in review ${review.reviewId}.`,
              },
            ],
            structuredContent: candidateReviewStructuredContent(review, {
              action,
              candidateId: candidate.candidateId,
              reviewId: review.reviewId,
              revision: review.revision,
            }),
          };
        }
        const updated = candidateReviewWithState(
          review,
          candidate.candidateId,
          action === 'defer' ? 'deferred' : 'rejected',
          {action, at},
        );
        yield* saveCandidateReview(config.agentContextHome, updated);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                action === 'defer'
                  ? `Deferred candidate ${candidate.candidateId}. It remains available in review ${review.reviewId}.`
                  : `Rejected candidate ${candidate.candidateId}. No memory was written.`,
            },
          ],
          structuredContent: candidateReviewStructuredContent(updated, {
            action,
            candidateId: candidate.candidateId,
            reviewId: review.reviewId,
            revision: updated.revision,
          }),
        };
      }
      if (candidate.recommendation === 'no_action') {
        if (!(yield* reviewedCandidateTargetIsCurrent(config, candidate))) {
          return argumentError(
            `Duplicate candidate ${candidate.candidateId} is stale because its reviewed target changed or disappeared. Run review_session_context again.`,
          );
        }
        const updated = candidateReviewWithState(review, candidate.candidateId, 'applied', {
          action: 'apply',
          at,
        });
        yield* saveCandidateReview(config.agentContextHome, updated);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Confirmed no action for duplicate candidate ${candidate.candidateId}. No memory was written.`,
            },
          ],
          structuredContent: candidateReviewStructuredContent(updated, {
            action: 'no_action',
            candidateId: candidate.candidateId,
            reviewId: review.reviewId,
            revision: updated.revision,
          }),
        };
      }
      const text = normalizeOptionalMetadata(editedText) ?? candidate.proposedText;
      const scrub = applyScrubber(text, {redact: true});
      if (scrub.blocker) {
        return argumentError(
          `Refusing to store candidate ${candidate.candidateId}: possible ${scrub.blocker}. Remove the sensitive value first.`,
        );
      }
      const reviewedTargetUri = candidate.targetUri;
      const effectiveOperation = operation ?? candidate.applyOperation;
      const effectiveReplaceUri = checkedReplaceUri.value ?? candidate.applyReplaceUri;
      const requiresExplicitOperation =
        candidate.recommendation === 'replace' || candidate.recommendation === 'manual_review';
      if (requiresExplicitOperation && effectiveOperation === undefined) {
        return argumentError(`Candidate ${candidate.candidateId} requires an explicit operation: create or replace.`);
      }
      if (candidate.applyOperation && operation && operation !== candidate.applyOperation) {
        return argumentError(
          `Candidate ${candidate.candidateId} is recovering an approved ${candidate.applyOperation} operation; the retry cannot change it to ${operation}.`,
        );
      }
      if (
        candidate.applyReplaceUri &&
        checkedReplaceUri.value &&
        checkedReplaceUri.value !== candidate.applyReplaceUri
      ) {
        return argumentError(
          `Candidate ${candidate.candidateId} is recovering approved target ${candidate.applyReplaceUri}; the retry cannot change it.`,
        );
      }
      const reviewedTargetIsShared = reviewedTargetUri !== undefined && isSharedMemoryUri(reviewedTargetUri);
      if (
        effectiveOperation === 'create' &&
        !reviewedTargetIsShared &&
        (candidate.recommendation === 'replace' || candidate.comparison === 'contradiction')
      ) {
        if (!allowMissingReplacementCreate || reviewedTargetUri === undefined) {
          return argumentError(
            `Candidate ${candidate.candidateId} has the same stable identity as active memory and cannot be created separately; choose operation=replace with its reviewed target.`,
          );
        }
        const [currentTarget] = yield* readMemoryRecordsByUri(config, [reviewedTargetUri]);
        if (currentTarget !== undefined) {
          return argumentError(
            `Candidate ${candidate.candidateId} replacement target still exists; refresh replacement safety before applying.`,
          );
        }
      }
      if (effectiveOperation === 'replace' && reviewedTargetUri === undefined) {
        return argumentError(`Candidate ${candidate.candidateId} has no reviewed replacement target.`);
      }
      if (
        effectiveOperation === 'replace' &&
        (effectiveReplaceUri === undefined || effectiveReplaceUri !== reviewedTargetUri)
      ) {
        return argumentError(
          `Candidate ${candidate.candidateId} requires replaceUri=${reviewedTargetUri} for the reviewed replacement.`,
        );
      }
      if (effectiveOperation !== 'replace' && effectiveReplaceUri !== undefined) {
        return argumentError(`Candidate ${candidate.candidateId} cannot use replaceUri without operation=replace.`);
      }
      if (allowDestructiveReplacement === true && effectiveOperation !== 'replace') {
        return argumentError(
          `Candidate ${candidate.candidateId} cannot allow a destructive replacement without operation=replace.`,
        );
      }
      const targetUri = effectiveOperation === 'replace' ? reviewedTargetUri : undefined;
      if (targetUri && isSharedMemoryUri(targetUri)) {
        return argumentError(
          `Candidate ${candidate.candidateId} targets shared memory. Choose operation=create to store the reviewed candidate personally without overwriting the shared source.`,
        );
      }
      if (targetUri) {
        if (!candidate.targetContentHash) {
          return argumentError(`Candidate ${candidate.candidateId} has no reviewed content hash for ${targetUri}.`);
        }
      }
      const destructiveReplacementApproved =
        candidate.applyAllowDestructiveReplacement === true || allowDestructiveReplacement === true;
      if (targetUri && candidate.targetContentHash) {
        if (!candidate.replacementSafetyBaseline) {
          return argumentError(replacementSafetyReviewRequiredWarning(candidate));
        }
        const [currentTarget] = yield* readMemoryRecordsByUri(config, [targetUri]);
        const currentTargetHash = currentTarget
          ? yield* sha256Hex(canonicalMemoryDocumentContent(currentTarget.content))
          : undefined;
        if (!currentTarget || currentTargetHash !== candidate.targetContentHash) {
          return argumentError(
            `Candidate ${candidate.candidateId} replacement target changed or disappeared after review. Review it again before applying.`,
          );
        }
        const replacementSafety = assessReplacementSafety(
          candidate.kind,
          replacementSafetyBaseline(currentTarget.body),
          scrub.cleaned,
        );
        if (replacementSafety.destructiveLossRisk && !destructiveReplacementApproved) {
          return argumentError(
            `${replacementSafetyWarning(replacementSafety)} Read ${targetUri}, then either supply editedText that preserves ` +
              'the needed state or retry with allowDestructiveReplacement=true after explicit approval.',
          );
        }
      }
      const approvedOperation: CandidateApplyOperation = effectiveOperation ?? 'create';
      const approvedAt = candidate.applyApprovedAt ?? at;
      const metadata = approvedCandidateMetadata(review, candidate, approvedAt);
      const writeParams: WriteDurableMemoryParams = {
        bodyText: scrub.cleaned,
        expectedReplaceContentHash: targetUri ? candidate.targetContentHash : undefined,
        metadata,
        operation: approvedOperation,
        replaceUri: targetUri,
      };
      const preparedWrite = yield* preparePersonalMemoryWrite(config, writeParams);
      const intendedMemoryUri = preparedWrite.memoryUri;
      const approvedContentHash = yield* sha256Hex(canonicalMemoryDocumentContent(preparedWrite.memory));
      if (candidate.applyContentHash && candidate.applyContentHash !== approvedContentHash) {
        return argumentError(
          `Candidate ${candidate.candidateId} retry does not match the previously approved content. Retry with the same editedText or start a new review.`,
        );
      }
      const applying =
        candidate.state === 'applying'
          ? review
          : candidateReviewWithApplying(
              review,
              candidate.candidateId,
              {
                allowDestructiveReplacement: destructiveReplacementApproved,
                bodyText: scrub.cleaned,
                contentHash: approvedContentHash,
                operation: approvedOperation,
                replaceUri: targetUri,
                targetUri: intendedMemoryUri,
              },
              approvedAt,
            );
      if (candidate.state !== 'applying') {
        yield* saveCandidateReview(config.agentContextHome, applying);
      }
      const result = yield* writeDurableMemory(config, {
        ...writeParams,
        prepared: preparedWrite,
      });
      if (result.isError === true) {
        const resultText = textFromCallToolResult(result);
        if (resultText.includes('Candidate replacement is stale')) {
          return yield* persistCandidateConflict(
            config,
            applying,
            applying.candidates.find(item => item.candidateId === candidate?.candidateId) ?? candidate,
            `${resultText} The approval is recorded as a conflict; start a new review against the current target.`,
          );
        }
        const [possiblyWritten] = yield* readMemoryRecordsByUri(config, [intendedMemoryUri]);
        const destinationCanConflict = approvedOperation === 'create' || intendedMemoryUri !== targetUri;
        if (
          (destinationCanConflict &&
            possiblyWritten &&
            possiblyWritten.metadata.candidateId !== candidate.candidateId) ||
          resultText.includes('Create conflict')
        ) {
          return yield* persistCandidateConflict(
            config,
            applying,
            applying.candidates.find(item => item.candidateId === candidate?.candidateId) ?? candidate,
            `Candidate ${candidate.candidateId} could not be created because ${intendedMemoryUri} contains another memory. The apply is recorded as a conflict.`,
          );
        }
        return result;
      }
      if (replacementCleanupIsPending(result)) {
        const pendingCleanup = candidateReviewWithApplyStage(applying, candidate.candidateId, 'cleanup_pending');
        yield* saveCandidateReview(config.agentContextHome, pendingCleanup);
        return {
          ...result,
          isError: true,
          structuredContent: candidateReviewStructuredContent(pendingCleanup, {
            action: 'cleanup_pending',
            candidateId: candidate.candidateId,
            memoryUri: intendedMemoryUri,
            reviewId: review.reviewId,
            revision: review.revision,
          }),
        };
      }
      const memoryUri = storedMemoryUri(result) ?? intendedMemoryUri;
      const updated = candidateReviewWithState(applying, candidate.candidateId, 'applied', {
        action: 'apply',
        ...(destructiveReplacementApproved ? {allowDestructiveReplacement: true} : {}),
        at,
        memoryUri,
      });
      yield* saveCandidateReview(config.agentContextHome, updated);
      return {
        ...result,
        structuredContent: candidateReviewStructuredContent(updated, {
          action: 'approve',
          candidateId: candidate.candidateId,
          memoryUri,
          reviewId: review.reviewId,
          revision: updated.revision,
        }),
      };
    }),
  ).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
}

function withOptionalCandidateReviewLock<A, E, R>(
  agentContextHome: string,
  reviewId: string,
  lockHeld: boolean,
  effect: Effect.Effect<A, E, R>,
) {
  const locked = withCandidateReviewLock(agentContextHome, reviewId, effect);
  return lockHeld ? (effect as typeof locked) : locked;
}

export function registerSearchTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
  progressTiming: RecallProgressTiming,
  memoryScope?: CursorCloudMemoryScope,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: `${description} Defaults to compact TN-RECALL/1 text; dual adds structured content.`,
      inputSchema: {
        budgetTokens: McpInput.integer('Response tokens: 700-1500; default 1500', {
          minimum: RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS,
          maximum: RECALL_MCP_RESPONSE_MAXIMUM_ESTIMATED_TOKENS,
        }),
        query: McpInput.string('Task query; optional when memoryRefs supplies explicit navigation seeds'),
        uri: McpInput.string('Scope subtree'),
        callerCwd: McpInput.string('Absolute workspace cwd'),
        project: McpInput.string('Project + projectless; omit for global'),
        nodeLimit: McpInput.integer('Max results', {minimum: 1, maximum: 100}),
        includeArchived: McpInput.boolean('Include archived'),
        memoryRefs: McpInput.stringOrStrings('One-hop memory IDs/URIs', {
          maximumItems: 8,
        }),
        relationTypes: McpInput.literalsOrLiterals(MEMORY_RELATION_TYPES, 'Relation-type filter', {
          maximumItems: 5,
        }),
        responseFormat: McpInput.literals(['dual', 'agent'], 'Default agent; dual adds structured content.'),
        explain: McpInput.boolean('Include reasons and warnings'),
        threshold: McpInput.number('Relevance floor; env or 0.3', {
          minimum: 0,
          maximum: 1,
        }),
        ...(memoryScope ? {team: McpInput.string('Configured Personal Cursor Cloud share')} : {}),
        workset: McpInput.string('Named workset'),
      },
    },
    (
      {
        budgetTokens,
        callerCwd,
        explain,
        includeArchived,
        memoryRefs,
        nodeLimit,
        project,
        query,
        relationTypes,
        responseFormat,
        threshold,
        team,
        uri,
        workset,
      },
      {progress},
    ) => {
      const checkedUri = optionalResourceUri(uri, name);
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      if (workset?.trim() && memoryScope) {
        return argumentError(`${name} does not allow worksets in the Cursor Cloud profile.`);
      }
      let memoryConnections: ParsedRecallMemoryConnectionInput | undefined;
      try {
        const normalizedMemoryRefs = normalizeStringOrStrings(memoryRefs);
        const normalizedRelationTypes = normalizeStringOrStrings(relationTypes);
        if (normalizedRelationTypes.length > 0 && normalizedMemoryRefs.length === 0) {
          return argumentError(`${name} relationTypes requires memoryRefs.`);
        }
        memoryConnections =
          normalizedMemoryRefs.length > 0
            ? parseRecallMemoryConnectionInput({
                memoryRefs: normalizedMemoryRefs,
                relationTypes: normalizedRelationTypes,
              })
            : undefined;
      } catch (error) {
        return argumentError(errorMessage(error));
      }
      const normalizedQuery = query?.trim() ?? '';
      if (!normalizedQuery && memoryConnections === undefined) {
        return argumentError(
          [
            `Threadnote MCP tool "${name}" needs either a non-empty "query" or at least one "memoryRefs" seed.`,
            'Pass JSON arguments to the tool call.',
            `Examples: ${name}({"query":"unity-ui-ccc latest handoff"}) or ${name}({"memoryRefs":["threadnote://memory/tn_example"]})`,
          ].join('\n'),
        );
      }
      const requestedTeam = typeof team === 'string' ? team : undefined;
      let selectedShare;
      try {
        selectedShare =
          memoryScope && requestedTeam?.trim() ? cursorCloudShareForTeam(memoryScope, requestedTeam) : undefined;
      } catch (error) {
        return argumentError(errorMessage(error));
      }
      if (memoryScope && requestedTeam?.trim() && !selectedShare) {
        return argumentError(`${name} team must be one of: ${cursorCloudScopeTeams(memoryScope).join(', ')}.`);
      }
      const uriShare =
        memoryScope && checkedUri.value ? cursorCloudShareForUri(memoryScope, checkedUri.value) : undefined;
      if (memoryScope && checkedUri.value && !uriShare) {
        return argumentError(`${name} uri must stay within a configured Personal Cursor Cloud share.`);
      }
      if (selectedShare && uriShare && selectedShare.team !== uriShare.team) {
        return argumentError(`${name} team must match the share containing uri.`);
      }
      const scopedUri =
        checkedUri.value ??
        selectedShare?.root ??
        (memoryScope?.shares.length === 1 ? memoryScope.shares[0].root : undefined);
      if (scopedUri && memoryScope && !cursorCloudUriWithinScope(memoryScope, scopedUri)) {
        return argumentError(`${name} uri must stay within a configured Personal Cursor Cloud share.`);
      }
      return runRecallTool(
        config,
        {
          budgetTokens,
          callerCwd,
          explain: explain === true,
          project: project?.trim() || undefined,
          query: normalizedQuery,
          pinnedUri: scopedUri,
          nodeLimit,
          includeArchived: includeArchived === true,
          memoryRefs: memoryConnections?.memoryRefs,
          relationTypes: memoryConnections?.relationTypes,
          responseFormat,
          threshold: threshold === undefined ? undefined : String(threshold),
          allowedUriScopes: memoryScope ? (scopedUri ? [scopedUri] : cursorCloudScopeRoots(memoryScope)) : undefined,
          syncTeam: selectedShare?.team ?? uriShare?.team,
          workset: workset?.trim() || undefined,
        },
        progress,
        progressTiming,
        memoryScope,
      ).pipe(
        Effect.flatMap(withStaleVersionNotice),
        Effect.catch(error =>
          Effect.succeed(
            Schema.is(AgentResponseBudgetTooSmallError)(error) ? argumentError(error.message) : mcpErrorResult(error),
          ),
        ),
      );
    },
  );
}

function normalizeStringOrStrings(value: string | readonly string[] | undefined): readonly string[] {
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}

interface RecallToolParams {
  readonly allowedUriScopes: readonly string[] | undefined;
  readonly budgetTokens: number | undefined;
  readonly callerCwd: string | undefined;
  readonly explain: boolean;
  readonly includeArchived: boolean;
  readonly memoryRefs: readonly string[] | undefined;
  readonly nodeLimit: number | undefined;
  readonly pinnedUri: string | undefined;
  readonly project: string | undefined;
  readonly query: string;
  readonly relationTypes: readonly MemoryRelationType[] | undefined;
  readonly responseFormat: 'dual' | 'agent' | undefined;
  readonly threshold: string | undefined;
  readonly syncTeam: string | undefined;
  readonly workset: string | undefined;
}

const RECALL_MCP_PROGRESS = {
  lexicalRanking: {message: 'Ranking recall candidates.', phase: 'recall.lexical-ranking'},
  obsidianSync: {message: 'Refreshing configured sources.', phase: 'recall.obsidian-sync'},
  semanticRetrieval: {message: 'Searching memory indexes.', phase: 'recall.semantic-retrieval'},
  sharedSync: {message: 'Refreshing shared memories.', phase: 'recall.shared-sync'},
  workspaceContext: {message: 'Resolving recall scope.', phase: 'recall.workspace-context'},
} as const satisfies Readonly<Record<string, McpProgressUpdate>>;

function runRecallTool(
  config: RuntimeConfig,
  params: RecallToolParams,
  progress: McpToolProgress,
  progressTiming: RecallProgressTiming,
  memoryScope?: CursorCloudMemoryScope,
) {
  return Effect.gen(function* () {
    const syncWarnings: string[] = [];
    const syncedTeams = yield* withMcpProgressHeartbeat(
      progress,
      RECALL_MCP_PROGRESS.sharedSync,
      withAnonymousTelemetryPhase(
        'recall.shared-sync',
        withProductionPhaseTiming(
          'recall.shared-sync',
          progressTiming.sharedSyncDelayMilliseconds === 0
            ? syncCursorCloudMemoryShares(config, memoryScope, params.syncTeam)
            : Effect.sleep(progressTiming.sharedSyncDelayMilliseconds).pipe(
                Effect.andThen(syncCursorCloudMemoryShares(config, memoryScope, params.syncTeam)),
              ),
        ),
      ),
      progressTiming.heartbeatMilliseconds,
    ).pipe(
      Effect.map(syncResult => {
        syncWarnings.push(...syncResult.warnings);
        return syncResult.syncedTeams;
      }),
      Effect.catch(error => {
        syncWarnings.push(errorMessage(error));
        return Effect.succeed([] as readonly string[]);
      }),
    );
    const sourceSyncWarnings: string[] = [];
    const syncedSources = memoryScope
      ? []
      : yield* withMcpProgressHeartbeat(
          progress,
          RECALL_MCP_PROGRESS.obsidianSync,
          withAnonymousTelemetryPhase(
            'recall.obsidian-sync',
            withProductionPhaseTiming('recall.obsidian-sync', syncSourcesBeforeRecall(config)),
          ),
          progressTiming.heartbeatMilliseconds,
        ).pipe(
          Effect.map(syncResult => {
            sourceSyncWarnings.push(...syncResult.warnings);
            return syncResult.syncedSources;
          }),
          Effect.catch(error => {
            sourceSyncWarnings.push(`Source refresh failed: ${errorMessage(error)}`);
            return Effect.succeed([] as readonly string[]);
          }),
        );
    const workspaceContext = yield* withMcpProgressHeartbeat(
      progress,
      RECALL_MCP_PROGRESS.workspaceContext,
      withProductionPhaseTiming('recall.workspace-context', resolveRecallWorkspaceContext(config, params)),
      progressTiming.heartbeatMilliseconds,
    );
    const query = workspaceContext.query;
    const navigationOnly = workspaceContext.navigationOnly;
    const workspaceComponent = workspaceContext.workspaceComponent;
    const workspaceBranch = workspaceContext.workspaceBranch;
    const recallProjectName = workspaceContext.recallProjectName;
    const threshold = workspaceContext.threshold;
    const thresholdConfigured = workspaceContext.thresholdConfigured;
    const passes = workspaceContext.passes;
    const scopedRecallUris = workspaceContext.scopedRecallUris;
    const seededUri = workspaceContext.seededUri;
    const sections = workspaceContext.sections;
    const eligibility = workspaceContext.eligibility;
    const exactMatches = workspaceContext.exactMatches;
    let operationalWarnings = workspaceContext.operationalWarnings;
    const effectAi = workspaceContext.effectAi;
    const selectRecallCandidates = makeMcpRecallCandidateSelector(config, effectAi, workspaceContext.jev, sections);
    let hybridMinimumScore = recallHybridMinimumScore(Number(threshold));
    const expansionQueries: string[] = [];
    const recallLimit = params.nodeLimit ?? 12;
    const semanticRetrieval: McpRecallSemanticScoresResult = navigationOnly
      ? {
          result: {corpusGeneration: Option.none(), scores: Option.none(), warning: Option.none()},
          status: 'unavailable',
        }
      : yield* withMcpProgressHeartbeat(
          progress,
          RECALL_MCP_PROGRESS.semanticRetrieval,
          withAnonymousTelemetryPhase(
            'recall.semantic-retrieval',
            withProductionPhaseTiming(
              'recall.semantic-retrieval',
              loadMcpRecallSemanticScoresResult(
                config,
                query,
                recallLimit,
                eligibility,
                params.allowedUriScopes ?? (params.pinnedUri ? [params.pinnedUri] : undefined),
              ),
              result =>
                result.status === 'available'
                  ? 'success'
                  : result.status === 'unavailable'
                    ? 'unavailable'
                    : result.status === 'timed-out'
                      ? 'timed-out'
                      : 'failure',
            ),
            result =>
              result.status === 'available'
                ? 'success'
                : result.status === 'unavailable'
                  ? 'unavailable'
                  : result.status === 'timed-out'
                    ? 'timed-out'
                    : 'failure',
          ),
          progressTiming.heartbeatMilliseconds,
        );
    let semanticResult = semanticRetrieval.result;
    const surfacedSemanticWarnings = new Set<string>();
    const appendSemanticWarning = (result: typeof semanticResult) => {
      if (Option.isNone(result.warning) || surfacedSemanticWarnings.has(result.warning.value)) return;
      surfacedSemanticWarnings.add(result.warning.value);
      sections.push(result.warning.value);
    };
    appendSemanticWarning(semanticResult);
    const rerankerCache = createRecallRerankerCache();
    const prepareSections = (candidateUris?: readonly string[]) =>
      withMcpProgressHeartbeat(
        progress,
        RECALL_MCP_PROGRESS.lexicalRanking,
        withAnonymousTelemetryPhase(
          'recall.lexical-ranking',
          withProductionPhaseTiming(
            'recall.lexical-ranking',
            Effect.gen(function* () {
              const prepared = yield* prepareRecallSections(config, {
                allowExactRescue: !thresholdConfigured,
                allowSemanticRescue: !thresholdConfigured,
                allowedUriScopes: params.allowedUriScopes ?? (params.pinnedUri ? [params.pinnedUri] : undefined),
                candidateUris,
                eligibility,
                exactMatches,
                feedbackQuery: params.query,
                includeInactive: params.includeArchived,
                limit: recallLimit,
                memoryRefs: params.memoryRefs,
                minimumScore: hybridMinimumScore,
                passes,
                preferredUriScopes: params.pinnedUri ? undefined : [...scopedRecallUris],
                project: recallProjectName,
                query,
                queryVariants: expansionQueries,
                readRecords: uris => readMemoryRecordsByUri(config, uris),
                relationTypes: params.relationTypes,
                rerankerCache,
                seedUris: [params.pinnedUri, seededUri].filter((uri): uri is string => uri !== undefined),
                semanticGenerationMismatchPolicy: 'fallback',
                semanticResult: Option.some(semanticResult),
                workspaceBranch,
                workspaceScope: workspaceComponent?.scope,
              });
              semanticResult = prepared.semanticResult;
              operationalWarnings = mergeRecallOperationalWarnings(operationalWarnings, prepared.operationalWarnings);
              appendSemanticWarning(semanticResult);
              return prepared;
            }),
          ),
        ),
        progressTiming.heartbeatMilliseconds,
      );
    let recallSections = yield* prepareSections();
    const shouldAttemptAiExpansion = !navigationOnly && shouldExpandRecall(recallSections.confidence);
    const indexSelectionCandidates = shouldAttemptAiExpansion
      ? buildRecallIndexSelectionCandidates(recallSections.expansionCandidates, recallProjectName, 24)
      : [];
    const indexSelectionIds =
      indexSelectionCandidates.length > 0
        ? yield* selectRecallCandidates({candidates: indexSelectionCandidates, query: params.query})
        : undefined;
    const groundedExpansionQueries =
      indexSelectionIds && indexSelectionIds.length > 0
        ? limitRecallRewritesForConfidence(
            recallSections.confidence,
            recallSelectionQueries(
              indexSelectionCandidates,
              recallSections.expansionCandidates,
              indexSelectionIds,
              params.query,
              2,
            ),
          )
        : [];
    const needsFallbackExpansion =
      shouldAttemptAiExpansion &&
      groundedExpansionQueries.length < recallRewriteLimitForConfidence(recallSections.confidence);
    const expansionVocabulary = needsFallbackExpansion
      ? yield* loadRecallExpansionVocabulary(config, {
          allowedUriScopes: params.allowedUriScopes ?? (params.pinnedUri ? [params.pinnedUri] : [...scopedRecallUris]),
          eligibility,
          includeInactive: params.includeArchived,
          project: recallProjectName,
          rankedCandidates: recallSections.expansionCandidates,
        }).pipe(Effect.orElseSucceed(() => []))
      : [];
    const fallbackExpansionQueries = needsFallbackExpansion
      ? yield* expandWeakRecallQueryEffect(
          {
            confidence: recallSections.confidence,
            project: recallProjectName,
            query: params.query,
            vocabulary: expansionVocabulary,
          },
          config,
          effectAi,
        )
      : [];
    const proposedExpansionQueries = mergeRecallRewritesForConfidence(
      recallSections.confidence,
      groundedExpansionQueries,
      fallbackExpansionQueries,
    );
    for (const expansionQuery of proposedExpansionQueries) {
      expansionQueries.push(expansionQuery);
      hybridMinimumScore = recallHybridMinimumScore(Number(threshold));
      recallSections = yield* prepareSections();
    }
    if (expansionQueries.length > 0) {
      sections.push(`Recall query expansion: evaluated ${expansionQueries.length} model rewrite(s).`);
      const selectionCandidates = buildRecallSelectionCandidates(
        recallSections.ranked,
        recallSections.expansionCandidates,
        Math.max(params.nodeLimit ?? 12, 12) * 2,
      );
      const selectedIds = yield* selectRecallCandidates({candidates: selectionCandidates, query: params.query});
      if (selectedIds !== undefined) {
        const selectedUris = selectedRecallCandidateUris(
          selectionCandidates,
          selectedIds,
          recallSelectionAnchorIds(selectionCandidates, recallSections.ranked),
        );
        recallSections = yield* prepareSections(selectedUris);
        sections.push(
          `Recall local AI post-filter: kept ${selectedUris.length} of ${selectionCandidates.length} candidate(s).`,
        );
      }
    }
    const {semanticSection, exactTail} = recallSections;
    if (semanticSection) sections.push(semanticSection);
    if (exactTail) sections.push(exactTail);
    const referencedContext = yield* referencedContextSection(config, semanticSection ?? '', params.allowedUriScopes);
    if (referencedContext) {
      sections.push(referencedContext);
    }
    const hygieneHints = yield* recallHygieneHintsSection(config, semanticSection ?? '');
    if (hygieneHints) {
      sections.push(hygieneHints);
    }
    if (syncedTeams.length > 0) {
      sections.push(`Auto-synced shared memories: ${syncedTeams.join(', ')}`);
    }
    if (syncedSources.length > 0) {
      sections.push(`Auto-synced sources: ${syncedSources.join(', ')}`);
    }
    for (const warning of syncWarnings) {
      sections.push(`Auto-sync warning: ${warning}`);
    }
    for (const warning of sourceSyncWarnings) {
      sections.push(`Auto-sync warning: ${warning}`);
    }
    const rankedResultSections = new Set([semanticSection, exactTail].filter((value): value is string => !!value));
    const responseNotices = sections.filter(section => !rankedResultSections.has(section));
    const projected = yield* Effect.try({
      try: () =>
        projectRecallMcpResponse(
          {
            confidence: recallSections.confidence,
            ...(memoryScope ? {memoryScope: cursorCloudMemoryScopeReceipt(memoryScope)} : {}),
            ...(recallSections.memoryConnections ? {memoryConnections: recallSections.memoryConnections} : {}),
            notices: responseNotices,
            warnings: operationalWarnings,
            queryExpansions: expansionQueries,
            rankerVersion: RECALL_RANKER_VERSION,
            results: recallSections.ranked.slice(0, params.nodeLimit ?? 12),
          },
          params,
        ),
      catch: error =>
        Schema.is(AgentResponseBudgetTooSmallError)(error)
          ? error
          : McpServerOperationError.make({message: 'Recall response projection failed.', cause: error}),
    });
    const text = compactPersonalMemoryReferences(projected.text, config.user);
    return {
      content: [{type: 'text' as const, text}],
      ...(projected.responseFormat === 'dual'
        ? {structuredContent: compactStructuredReferences(projected.structuredContent, config.user)}
        : {}),
    };
  });
}

const recallHygieneHintsSection = Effect.fn('mcpServer.recallHygieneHints')(function* (
  config: RuntimeConfig,
  recallText: string,
) {
  const uris = activePersonalMemoryUrisFromText(recallText, config.user);
  if (uris.length === 0) {
    return undefined;
  }
  const records = yield* readMemoryRecordsByUri(config, uris);
  const nudges = recallHygieneNudges(recallText, {records, user: config.user});
  return nudges.length > 0 ? ['Memory hygiene hints:', ...nudges.map(nudge => `- ${nudge}`)].join('\n') : undefined;
});

const MAX_REFERENCED_CONTEXT = 5;

/**
 * Resolves the one-way `references:` pointers carried by the personal memories
 * recall just surfaced and appends bounded URI-only pointers. The caller can
 * explicitly read a relevant pointer without recall inlining unrelated text.
 */
const referencedContextSection = Effect.fn('mcpServer.referencedContext')(function* (
  config: RuntimeConfig,
  recallText: string,
  allowedUriScopes?: readonly string[],
) {
  const withinAllowedScope = (uri: string) =>
    allowedUriScopes === undefined || allowedUriScopes.some(scope => resourceIdIsWithin(uri, scope));
  const surfacedUris = activePersonalMemoryUrisFromText(recallText, config.user).filter(withinAllowedScope);
  if (surfacedUris.length === 0) {
    return undefined;
  }
  const surfaced = yield* readMemoryRecordsByUri(config, surfacedUris);
  const referenced = referencedUrisFromRecords(surfaced, recallText).filter(withinAllowedScope);
  if (referenced.length === 0) {
    return undefined;
  }
  const candidates = referenced.slice(0, MAX_REFERENCED_CONTEXT);
  const existingRecords = yield* readMemoryRecordsByUri(config, candidates);
  return formatReferencedContextPointers(existingReferencedUris(candidates, existingRecords), MAX_REFERENCED_CONTEXT);
});
export function registerReadTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
  memoryScope?: CursorCloudMemoryScope,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: `${description} Max ${MEMORY_READ_MAXIMUM_CONTENT_BYTES} bytes. Default agent; text=canonical; dual=structured. Oversize: mode=outline or section, or offsetBytes=0.`,
      inputSchema: {
        mode: McpInput.literals(['content', 'outline']),
        offsetBytes: McpInput.integer('UTF-8 byte offset for an explicit bounded page; start at 0', {minimum: 0}),
        responseFormat: McpInput.literals(['agent', 'dual', 'text'], 'Default agent; text=canonical; dual=structured.'),
        section: McpInput.string(),
        sourceHash: McpInput.string('SHA-256 from the first page; required when offsetBytes > 0'),
        uri: McpInput.string('Memory pointer'),
        uris: McpInput.stringOrStrings('Memory pointers'),
      },
    },
    ({mode, offsetBytes, responseFormat, section, sourceHash, uri, uris}) => {
      const requestedUrisResult = requiredResourceUriList(
        uris ?? uri,
        name,
        'threadnote://user/you/memories/.abstract.md',
        {personalMemoryUser: config.user},
      );
      if (!requestedUrisResult.ok) return requestedUrisResult.error;
      const requestedUris = requestedUrisResult.value;
      if ((section !== undefined || offsetBytes !== undefined) && requestedUris.length !== 1) {
        return argumentError(`${name} section and offsetBytes require exactly one uri.`);
      }
      return Effect.gen(function* () {
        const outsideScope = memoryScope
          ? requestedUris.find(
              requestedUri =>
                memoryIdFromIdentityAlias(requestedUri) === undefined &&
                !cursorCloudUriWithinScope(memoryScope, requestedUri),
            )
          : undefined;
        if (outsideScope) {
          return argumentError(`${name} uri must stay within a configured Personal Cursor Cloud share.`);
        }
        const requestedShares = memoryScope
          ? requestedUris.map(requestedUri =>
              memoryIdFromIdentityAlias(requestedUri) === undefined
                ? cursorCloudShareForUri(memoryScope, requestedUri)
                : undefined,
            )
          : [];
        const syncTeams =
          memoryScope && requestedShares.every(share => share !== undefined)
            ? [...new Set(requestedShares.map(share => share.team))]
            : undefined;
        const syncWarnings: string[] = [];
        const syncedTeams = yield* syncCursorCloudMemoryShares(config, memoryScope, syncTeams).pipe(
          Effect.map(result => {
            syncWarnings.push(...result.warnings);
            return result.syncedTeams;
          }),
          Effect.catch(error => {
            syncWarnings.push(error instanceof Error ? error.message : String(error));
            return Effect.succeed([] as readonly string[]);
          }),
        );
        const result = yield* runNativeReadTool(config, requestedUris, {
          allowedUriScopes: memoryScope
            ? cursorCloudScopeRoots(memoryScope)
            : [`threadnote://user/${uriSegment(config.user)}/memories`],
          resolveIdentityAliases: true,
        });
        const scopedResult = memoryScope
          ? {
              ...result,
              _meta: {
                ...result._meta,
                'threadnote.io/memory-scope': cursorCloudMemoryScopeReceipt(memoryScope),
              },
            }
          : result;
        if (result.isError === true) {
          return scopedResult;
        }
        const syncMessages = [
          syncedTeams.length > 0 ? `Auto-synced shared memories: ${syncedTeams.join(', ')}` : undefined,
          ...syncWarnings.map(warning => `Auto-sync warning: ${warning}`),
        ].filter((part): part is string => part !== undefined);
        const resources = memoryReadResourcesFromNativeResult(result, requestedUris);
        if (!resources) return argumentError(`${name} could not project the canonical read response.`);
        const missing = canonicalReadMissing(result);
        const missingWarnings = missing.map(uri => `Missing memory: ${uri}`);
        const missingRecoveries = missing.flatMap(uri => {
          const recovery = memoryReadRecoveryForRequestedUri(uri);
          return recovery === undefined ? [] : [memoryReadRecoveryText(recovery)];
        });
        const canonicalRead = canonicalReadMetadata(result);
        const relocatedOutsideScope = memoryScope
          ? canonicalRead?.resources.find(resource => !cursorCloudUriWithinScope(memoryScope, resource.canonicalUri))
          : undefined;
        if (relocatedOutsideScope) {
          return argumentError(`${name} relocated uri must stay within a configured Personal Cursor Cloud share.`);
        }
        const projected = Result.try(() =>
          projectMemoryRead(resources, {
            mode,
            offsetBytes,
            section,
            sourceHash,
            toolName: name,
            warnings: [...syncMessages, ...missingWarnings],
          }),
        );
        if (Result.isFailure(projected)) {
          const failure = projected.failure;
          if (Schema.is(MemoryReadTooLargeError)(failure) || Schema.is(MemoryReadProjectionError)(failure)) {
            return argumentError(failure.message);
          }
          return argumentError(errorMessage(failure));
        }
        const read = projected.success;
        return {
          _meta: {
            ...(memoryScope ? {'threadnote.io/memory-scope': cursorCloudMemoryScopeReceipt(memoryScope)} : {}),
            'threadnote.io/read': {
              contentIndex: 0,
              resourceCount: read.structuredContent.resourceCount,
              type: 'threadnote-read',
              uri: read.uri,
              ...(read.structuredContent.requestedUri === undefined
                ? {}
                : {requestedUri: read.structuredContent.requestedUri}),
              ...(read.structuredContent.canonicalUri === undefined
                ? {}
                : {canonicalUri: read.structuredContent.canonicalUri}),
              version: 1,
            },
          },
          content: [
            {type: 'text' as const, text: memoryReadMcpText(read, responseFormat)},
            ...(read.continuation === undefined ? [] : [{type: 'text' as const, text: read.continuation}]),
            ...(read.receipt === undefined ? [] : [{type: 'text' as const, text: read.receipt}]),
            ...missingRecoveries.map(text => ({type: 'text' as const, text})),
          ],
          structuredContent: memoryReadMcpStructuredContent(read, responseFormat),
        };
      });
    },
  );
}

export function memoryReadResourcesFromNativeResult(
  result: CallToolResult,
  uris: readonly string[],
): MemoryReadResource[] | undefined {
  const canonicalRead = canonicalReadMetadata(result);
  const mappings = canonicalRead?.resources;
  if (mappings) {
    return projectCanonicalReadResources(result, mappings);
  }
  if (result.content.length !== uris.length) return undefined;
  return projectCanonicalReadResources(
    result,
    uris.map((uri, index) => ({canonicalUri: uri, contentIndex: index, requestedUri: uri})),
  );
}

function projectCanonicalReadResources(
  result: CallToolResult,
  mappings: readonly {readonly canonicalUri: string; readonly contentIndex: number; readonly requestedUri: string}[],
): MemoryReadResource[] | undefined {
  const resources: MemoryReadResource[] = [];
  for (const mapping of mappings) {
    const content = result.content[mapping.contentIndex];
    if (content?.type !== 'text') return undefined;
    const requestedUri = mapping.requestedUri;
    const canonicalUri = mapping.canonicalUri;
    if (memoryIdFromIdentityAlias(requestedUri) !== undefined) {
      resources.push({requestedUri, text: content.text, uri: requestedUri});
      continue;
    }
    resources.push({
      ...(requestedUri === canonicalUri ? {} : {canonicalUri, requestedUri}),
      text: content.text,
      uri: canonicalUri,
    });
  }
  return resources;
}

function canonicalReadMissing(result: CallToolResult): readonly string[] {
  const value = result._meta?.['threadnote.io/canonical-read'];
  if (!Predicate.isObject(value) || !Array.isArray(value.missing)) return [];
  return value.missing.filter((uri): uri is string => typeof uri === 'string');
}

function canonicalReadMetadata(result: CallToolResult):
  | {
      readonly resources: readonly {
        readonly canonicalUri: string;
        readonly contentIndex: number;
        readonly requestedUri: string;
      }[];
    }
  | undefined {
  const value = result._meta?.['threadnote.io/canonical-read'];
  if (!Predicate.isObject(value)) return undefined;
  const candidate = value;
  if (
    candidate.type !== 'threadnote-canonical-read' ||
    candidate.version !== 1 ||
    !Array.isArray(candidate.resources)
  ) {
    return undefined;
  }
  const resources: {
    canonicalUri: string;
    contentIndex: number;
    requestedUri: string;
  }[] = [];
  for (const resource of candidate.resources) {
    if (!Predicate.isObject(resource)) return undefined;
    const entry = resource;
    const requestedUri =
      typeof entry.requestedUri === 'string'
        ? entry.requestedUri
        : typeof entry.uri === 'string'
          ? entry.uri
          : undefined;
    const canonicalUri = typeof entry.canonicalUri === 'string' ? entry.canonicalUri : requestedUri;
    if (
      typeof entry.contentIndex !== 'number' ||
      !Number.isSafeInteger(entry.contentIndex) ||
      !requestedUri ||
      !canonicalUri
    ) {
      return undefined;
    }
    resources.push({canonicalUri, contentIndex: entry.contentIndex, requestedUri});
  }
  return {resources};
}

function sessionCloseoutHasCandidateMaterial(input: SessionCloseoutInput): boolean {
  return (
    [input.decisions, input.handoff, input.invariants, input.preferences].some(items => (items?.length ?? 0) > 0) ||
    structuredCloseoutFromInput(input) !== undefined
  );
}

function sessionCloseoutHasEvidence(input: SessionCloseoutInput): boolean {
  return (
    (input.codeCitations?.length ?? 0) > 0 ||
    (input.evidence?.length ?? 0) > 0 ||
    input.sourceSessionId !== undefined ||
    input.sourceCommit !== undefined
  );
}

function parseCandidatePolicy(value: string | undefined): 'handoff-only' | 'off' | 'suggest' {
  const normalized = value?.trim() || 'suggest';
  if (normalized === 'suggest' || normalized === 'handoff-only' || normalized === 'off') {
    return normalized;
  }
  throw McpServerOperationError.make({
    message: `Invalid THREADNOTE_CANDIDATE_POLICY=${normalized}. Expected suggest, handoff-only, or off.`,
  });
}

function scrubSessionCloseout(
  input: SessionCloseoutInput,
): {readonly input: SessionCloseoutInput; readonly ok: true} | {readonly error: string; readonly ok: false} {
  const scrubText = (value: string): {readonly blocker?: string; readonly cleaned: string} =>
    applyScrubber(value, {redact: true});
  const scalarValues = [
    ['task', input.task],
    ['outcome', input.outcome],
    ['project', input.project],
    ['topic', input.topic],
    ['sourceAgentClient', input.sourceAgentClient],
    ['sourceCommit', input.sourceCommit],
    ['sourceSessionId', input.sourceSessionId],
    ['rationale', input.rationale],
  ] as const;
  const scrubbedScalars = new Map<string, string | undefined>();
  for (const [key, value] of scalarValues) {
    if (value === undefined) {
      scrubbedScalars.set(key, undefined);
      continue;
    }
    const scrubbed = scrubText(value);
    if (scrubbed.blocker) {
      return {error: `Refusing session review: ${key} may contain ${scrubbed.blocker}.`, ok: false};
    }
    scrubbedScalars.set(key, scrubbed.cleaned);
  }
  const scrubList = (key: string, values: readonly string[] | undefined): readonly string[] | undefined => {
    if (!values) {
      return undefined;
    }
    const result: string[] = [];
    for (const value of values) {
      const scrubbed = scrubText(value);
      if (scrubbed.blocker) {
        throw McpServerOperationError.make({message: `${key} may contain ${scrubbed.blocker}`});
      }
      result.push(scrubbed.cleaned);
    }
    return result;
  };
  try {
    const outcome = scrubbedScalars.get('outcome');
    const project = scrubbedScalars.get('project');
    const sourceAgentClient = scrubbedScalars.get('sourceAgentClient');
    const rationale = scrubbedScalars.get('rationale');
    const task = scrubbedScalars.get('task');
    const topic = scrubbedScalars.get('topic');
    if (!outcome || !project || !sourceAgentClient || !task || !topic) {
      return {error: 'Refusing session review: a required scalar was unexpectedly absent after scrubbing.', ok: false};
    }
    return {
      input: {
        codeCitations: input.codeCitations,
        ...(rationale === undefined ? {} : {rationale}),
        constraints: scrubList('constraints', input.constraints),
        decisions: scrubList('decisions', input.decisions),
        evidence: scrubList('evidence', input.evidence),
        handoff: scrubList('handoff', input.handoff),
        invariants: scrubList('invariants', input.invariants),
        knowledgeInvalidated: scrubList('knowledgeInvalidated', input.knowledgeInvalidated),
        outcome,
        preferences: scrubList('preferences', input.preferences),
        project,
        sourceAgentClient,
        sourceCommit: scrubbedScalars.get('sourceCommit'),
        sourceSessionId: scrubbedScalars.get('sourceSessionId'),
        task,
        topic,
        unresolvedRisks: scrubList('unresolvedRisks', input.unresolvedRisks),
        verificationPerformed: scrubList('verificationPerformed', input.verificationPerformed),
      },
      ok: true,
    };
  } catch (cause: unknown) {
    return {error: `Refusing session review: ${errorMessage(cause)}.`, ok: false};
  }
}

function candidateReviewResult(review: CandidateReview): CallToolResult {
  const actionable = review.candidates.filter(candidate => candidate.recommendation !== 'no_action');
  const replacementWarnings = new Map(
    projectKnowledgeDeltaV1(review)
      .items.filter(item => item.mutationPreview.replacementSafety?.warning)
      .map(item => [item.candidateId, item.mutationPreview.replacementSafety?.warning]),
  );
  const lines =
    review.candidates.length === 0
      ? ['No additional memory candidates found in this task closeout. No candidate memory was written.']
      : actionable.length === 0
        ? ['No memory update is recommended; every candidate duplicates active memory.']
        : [
            `Review ${review.reviewId} · revision ${review.revision}`,
            'Present these additional recommendations in the current conversation. Do not write these additional candidates until the user decides:',
            ...review.candidates.map(
              (candidate, index) =>
                `${index + 1}. [${candidate.recommendation}] ${candidate.kind}/${candidate.topic} · ${candidate.reason}\n` +
                `   candidate: ${candidate.candidateId}` +
                (candidate.targetUri ? `\n   target: ${candidate.targetUri}` : '') +
                (replacementWarnings.get(candidate.candidateId)
                  ? `\n   WARNING: ${replacementWarnings.get(candidate.candidateId)}`
                  : '') +
                `\n${candidate.proposedText
                  .split('\n')
                  .map(line => `   ${line}`)
                  .join('\n')}`,
            ),
          ];
  return {
    content: [{type: 'text', text: lines.join('\n')}],
    structuredContent: candidateReviewStructuredContent(review, {
      candidates: review.candidates,
      noAction: actionable.length === 0,
      reviewId: review.reviewId,
      revision: review.revision,
    }),
  };
}

function candidateReviewStructuredContent(
  review: CandidateReview,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {...fields, knowledgeDelta: projectKnowledgeDeltaV1(review)};
}

function approvedCandidateMetadata(
  review: CandidateReview,
  candidate: MemoryCandidate,
  approvedAt: string,
): MemoryMetadata {
  return {
    authority: 'user_approved',
    candidateId: candidate.candidateId,
    ...(review.codeCitations.length === 0 ? {} : {codeCitations: review.codeCitations}),
    createdAt: approvedAt,
    evidence: candidate.evidence,
    kind: candidate.kind,
    lastReviewed: approvedAt,
    project: candidate.project,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient: review.sourceAgentClient,
    sourceCommit: review.sourceCommit,
    sourceObservedAt: review.createdAt,
    sourceSessionId: review.sourceSessionId,
    status: 'active',
    timestamp: approvedAt,
    topic: candidate.topic,
    trust: 'approved',
    updatedAt: approvedAt,
    visibility: 'personal',
  };
}

function storedMemoryUri(result: CallToolResult): string | undefined {
  const structuredMemoryUri = result.structuredContent?.memoryUri;
  if (typeof structuredMemoryUri === 'string') {
    return structuredMemoryUri;
  }
  const text = textFromCallToolResult(result);
  return /Stored memory:\s+(threadnote:\/\/\S+)/.exec(text)?.[1];
}

function replacementCleanupIsPending(result: CallToolResult): boolean {
  return result.structuredContent?.replacementCleanupPending === true;
}

function reviewedCandidateTargetIsCurrent(config: RuntimeConfig, candidate: MemoryCandidate) {
  const targetUri = candidate.targetUri;
  if (!targetUri || !candidate.targetContentHash) {
    return Effect.succeed(false);
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [targetUri],
      Effect.gen(function* () {
        const [target] = yield* readMemoryRecordsByUri(config, [targetUri]);
        return (
          target !== undefined &&
          (yield* sha256Hex(canonicalMemoryDocumentContent(target.content))) === candidate.targetContentHash
        );
      }),
    );
  });
}

function persistCandidateConflict(
  config: RuntimeConfig,
  review: CandidateReview,
  candidate: MemoryCandidate,
  message: string,
) {
  return Effect.gen(function* () {
    const conflicted = candidateReviewWithState(
      candidateReviewWithApplyStage(review, candidate.candidateId, 'conflict'),
      candidate.candidateId,
      'conflict',
      {
        action: 'conflict',
        at: DateTime.formatIso(yield* DateTime.now),
        memoryUri: candidate.applyTargetUri,
      },
    );
    yield* saveCandidateReview(config.agentContextHome, conflicted);
    return argumentError(message);
  });
}

function reconcileCandidateReplacementCleanup(config: RuntimeConfig, candidate: MemoryCandidate) {
  const replacementUri = candidate.applyReplaceUri;
  const targetUri = candidate.applyTargetUri;
  if (candidate.applyOperation !== 'replace' || !replacementUri || !targetUri || replacementUri === targetUri) {
    return Effect.succeed('complete');
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [replacementUri, targetUri],
      Effect.gen(function* () {
        const [currentTarget] = yield* readMemoryRecordsByUri(config, [replacementUri]);
        if (!currentTarget) {
          return 'complete' as const;
        }
        if (
          !candidate.targetContentHash ||
          (yield* sha256Hex(canonicalMemoryDocumentContent(currentTarget.content))) !== candidate.targetContentHash
        ) {
          return 'conflict' as const;
        }
        const removed = yield* removeResourceWithRetry('threadnote-native', config, replacementUri);
        if (!removed) {
          return 'pending' as const;
        }
        const stillExists = yield* resourceExists('threadnote-native', config, replacementUri);
        return stillExists ? ('pending' as const) : ('complete' as const);
      }),
    );
  });
}

export function registerRecallFeedbackTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'recall_feedback',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'Record bounded local feedback for one recall result. Applied means the item materially informed a plan or change and is distinct from useful. Stores a query fingerprint, never the full query. Feedback cannot bypass topical relevance and decays over time.',
      inputSchema: {
        action: McpInput.literals(['dismiss', 'pin', 'useful', 'wrong', 'applied']),
        project: McpInput.string('Optional project scope; pin is never global'),
        query: McpInput.string('The recall query; only its SHA-256 fingerprint is stored'),
        uri: McpInput.string('The threadnote:// result URI receiving feedback'),
      },
    },
    ({action, project, query, uri}) => {
      const checkedQuery = requiredText(query, 'recall_feedback', 'query', {query: 'threadnote recall quality'});
      if (!checkedQuery.ok) {
        return checkedQuery.error;
      }
      const checkedUri = requiredResourceUri(
        uri,
        'recall_feedback',
        'threadnote://user/example/memories/durable/projects/threadnote/recall.md',
      );
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      if (!action) {
        return argumentError('recall_feedback requires action: useful, wrong, pin, dismiss, or applied.');
      }
      const normalizedProject = normalizeOptionalMetadata(project);
      if (action === 'pin' && normalizedProject === undefined) {
        return argumentError('recall_feedback requires project when action is pin; pins are never global.');
      }
      return Effect.gen(function* () {
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        const result = yield* recordRecallFeedback(config.agentContextHome, {
          action,
          project: normalizedProject,
          query: checkedQuery.value,
          timestamp,
          uri: checkedUri.value,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: result.recorded
                ? `Recorded ${action} feedback for ${checkedUri.value}.`
                : `Equivalent recent ${action} feedback already exists for ${checkedUri.value}; no duplicate was added.`,
            },
          ],
        };
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );
}

export function registerArchiveTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `${description} The archive is written before the original URI is removed.`,
      inputSchema: {
        kind: McpInput.literals(['durable', 'handoff', 'incident', 'preference', 'smoke']),
        project: McpInput.string('Project/repo namespace for the archived copy'),
        topic: McpInput.string('Topic for the archived copy'),
        uri: McpInput.string('Required threadnote:// memory URI to archive'),
      },
    },
    ({kind, project, topic, uri}) => {
      const checkedUri = requiredResourceUri(
        uri,
        name,
        'threadnote://user/example/memories/handoffs/active/repo/topic.md',
      );
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return Effect.gen(function* () {
        const [sourceRecord] = yield* readMemoryRecordsByUri(config, [checkedUri.value]);
        if (!sourceRecord) {
          return argumentError(`Could not resolve local memory content for ${checkedUri.value} before archiving.`);
        }
        const sourceContent = sourceRecord.content;
        yield* Effect.try({
          catch: error => McpServerOperationError.make({message: errorMessage(error)}),
          try: () => assertMemoryRecordArchivable(sourceRecord),
        });
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        const archiveResult = yield* writeDurableMemory(config, {
          bodyText: memoryArchiveBody(sourceRecord.body),
          expectedSourceContent: [{content: sourceContent, uri: checkedUri.value}],
          metadata: memoryArchiveMetadata(sourceRecord.metadata, {
            archivedFrom: checkedUri.value,
            kind: kind ?? 'handoff',
            project: normalizeOptionalMetadata(project),
            sourceAgentClient: 'mcp',
            timestamp,
            topic: normalizeOptionalMetadata(topic),
          }),
        });
        if (archiveResult.isError === true) {
          return archiveResult;
        }
        const removedOriginal = yield* forgetResourceWithRetry(config, checkedUri.value, false, sourceContent);
        const [content] = archiveResult.content;
        const text = content?.type === 'text' ? content.text : 'Archived memory stored.';
        return {
          content: [
            {
              type: 'text',
              text: removedOriginal
                ? `${text}\nArchived original memory: ${checkedUri.value}`
                : `${text}\nArchive stored, but original memory is still processing. Retry later with forget: ${checkedUri.value}`,
            },
          ],
        };
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );
}
