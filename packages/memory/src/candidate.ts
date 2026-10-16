import {Clock, Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {safeChildDirectoryNames, scanFilesWithinBoundary} from '@threadnote/platform/safe_scan';
import {SystemInfo} from '@threadnote/platform/system';
import {parseMarkdownHeadingLine} from '@threadnote/platform/string-boundaries';
import {uriSegment} from '@threadnote/workspace/manifest';
import {canonicalMemoryDocumentContent, parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {
  assertMemoryCodeCitation,
  formatMemoryCodeCitationLines,
  type MemoryCodeCitationV1,
} from '@threadnote/memory/code/citation';
import type {MemoryKind} from '@threadnote/memory/types';
import {
  validateTopicMaintenanceReviewPayload,
  type TopicMaintenanceReviewPayloadV1,
} from './topic-maintenance-draft.js';
import {
  validateTopicMaintenanceApprovalReceipt,
  type TopicMaintenanceApprovalReceiptV1,
} from './topic-maintenance-acceptance.js';

export type CandidateCategory = 'decision' | 'handoff' | 'invariant' | 'preference';
export type CandidateComparison = 'contradiction' | 'duplicate' | 'new' | 'possible_duplicate' | 'replacement';
export type CandidateRecommendation = 'create' | 'manual_review' | 'no_action' | 'replace';
export type CandidateReviewState = 'applied' | 'applying' | 'conflict' | 'deferred' | 'pending' | 'rejected';
export type CandidateApplyOperation = 'create' | 'replace';
export type CandidateApplyStage = 'cleanup_pending' | 'conflict' | 'prepared' | 'written';

export interface SessionCloseoutInput {
  readonly codeCitations?: readonly MemoryCodeCitationV1[];
  readonly constraints?: readonly string[];
  readonly decisions?: readonly string[];
  readonly evidence?: readonly string[];
  readonly handoff?: readonly string[];
  readonly invariants?: readonly string[];
  readonly knowledgeInvalidated?: readonly string[];
  readonly outcome: string;
  readonly preferences?: readonly string[];
  readonly project: string;
  readonly rationale?: string;
  readonly sourceAgentClient: string;
  readonly sourceCommit?: string;
  readonly sourceSessionId?: string;
  readonly task: string;
  readonly topic: string;
  readonly unresolvedRisks?: readonly string[];
  readonly verificationPerformed?: readonly string[];
  readonly structuredCloseout?: StructuredCloseoutV1;
}

/** Versioned, optional closeout context carried with candidate reviews and Knowledge Deltas. */
export interface StructuredCloseoutV1 {
  readonly type: 'structured-closeout';
  readonly version: 1;
  readonly rationale: string;
  readonly constraints: readonly string[];
  readonly verificationPerformed: readonly string[];
  readonly knowledgeInvalidated: readonly string[];
  readonly unresolvedRisks: readonly string[];
}

export interface MemoryCandidate {
  readonly applyAllowDestructiveReplacement?: boolean;
  readonly applyApprovedAt?: string;
  readonly applyBodyText?: string;
  readonly applyContentHash?: string;
  readonly applyOperation?: CandidateApplyOperation;
  readonly applyReplaceUri?: string;
  readonly applyStage?: CandidateApplyStage;
  readonly applyTargetUri?: string;
  readonly candidateId: string;
  readonly categories: readonly CandidateCategory[];
  readonly comparison: CandidateComparison;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly kind: Extract<MemoryKind, 'durable' | 'handoff' | 'preference'>;
  readonly project: string;
  readonly proposedText: string;
  readonly reason: string;
  readonly recommendation: CandidateRecommendation;
  readonly replacementSafetyBaseline?: ReplacementSafetyBaselineV1;
  readonly state: CandidateReviewState;
  readonly targetContentHash?: string;
  readonly targetUri?: string;
  readonly topic: string;
}

export interface ReplacementSafetyBaselineV1 {
  readonly bodyCharacters: number;
  readonly nonEmptyLines: number;
  readonly sectionHeadings: readonly string[];
  readonly sectionListTruncated: boolean;
  readonly version: 1;
}

export interface ReplacementSafetyAssessmentV1 {
  readonly destructiveLossRisk: boolean;
  readonly missingSections: readonly string[];
  readonly proposedBodyCharacters: number;
  readonly proposedNonEmptyLines: number;
  readonly retainedCharacterRatio: number;
  readonly retainedLineRatio: number;
  readonly targetBodyCharacters: number;
  readonly targetNonEmptyLines: number;
}

export interface CandidateReview {
  readonly auditEvents: readonly CandidateAuditEvent[];
  readonly candidates: readonly MemoryCandidate[];
  readonly codeCitations: readonly MemoryCodeCitationV1[];
  readonly createdAt: string;
  readonly outcome: string;
  readonly project: string;
  readonly reviewId: string;
  readonly revision: number;
  readonly sourceAgentClient: string;
  readonly sourceCommit?: string;
  readonly sourceSessionId?: string;
  readonly structuredCloseout?: StructuredCloseoutV1;
  readonly maintenance?: TopicMaintenanceReviewPayloadV1;
  readonly maintenanceApproval?: TopicMaintenanceApprovalReceiptV1;
  readonly maintenanceClosedConflict?: TopicMaintenanceClosedConflictV1;
  readonly task: string;
  readonly topic: string;
  readonly version: 2;
}

/** Bounded identity of the latest explicitly closed topic conflict after its full approval is superseded. */
export interface TopicMaintenanceClosedConflictV1 {
  readonly version: 1;
  readonly reviewRevision: number;
  readonly targetUri: string;
  readonly beforeContentHash: string;
  readonly contentHash: string;
  readonly approvalDigest: string;
}

function validTopicClosedConflict(review: CandidateReview): boolean {
  const closed = review.maintenanceClosedConflict;
  if (closed === undefined) return true;
  if (
    !review.maintenance ||
    typeof closed !== 'object' ||
    closed === null ||
    Object.keys(closed).sort().join(',') !==
      'approvalDigest,beforeContentHash,contentHash,reviewRevision,targetUri,version' ||
    closed.version !== 1 ||
    !Number.isSafeInteger(closed.reviewRevision) ||
    closed.reviewRevision < 1 ||
    closed.reviewRevision > review.revision ||
    closed.targetUri !== review.maintenance.basis.targetUri ||
    ![closed.beforeContentHash, closed.contentHash, closed.approvalDigest].every(value => /^[a-f0-9]{64}$/u.test(value))
  )
    return false;
  const approval = review.maintenanceApproval;
  if (approval === undefined) return true;
  if (approval.reviewRevision > closed.reviewRevision) return true;
  return (
    approval.reviewRevision === closed.reviewRevision &&
    approval.stage === 'conflict' &&
    approval.preview.targetUri === closed.targetUri &&
    approval.preview.beforeContentHash === closed.beforeContentHash &&
    approval.preview.contentHash === closed.contentHash &&
    approval.preview.approvalDigest === closed.approvalDigest
  );
}

export interface CandidateAuditEvent {
  readonly action:
    'apply' | 'begin_apply' | 'conflict' | 'create_review' | 'defer' | 'refresh_safety' | 'reject' | 'resume';
  readonly allowDestructiveReplacement?: boolean;
  readonly at: string;
  readonly candidateId?: string;
  readonly memoryUri?: string;
  readonly reviewId: string;
  readonly revision: number;
}

interface CandidateDraft {
  readonly categories: readonly CandidateCategory[];
  readonly kind: MemoryCandidate['kind'];
  readonly proposedText: string;
}

interface CandidateAuditTransition {
  readonly action: CandidateAuditEvent['action'];
  readonly allowDestructiveReplacement?: boolean;
  readonly at: string;
  readonly memoryUri?: string;
}

class CandidateMemoryError extends Schema.TaggedError<CandidateMemoryError>()('CandidateMemoryError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const MEMORY_READ_CONCURRENCY = 16;
const MAX_CANDIDATE_AUDIT_EVENTS = 5_000;
const MAX_CANDIDATE_REVIEW_AUDIT_EVENTS = 100;
const MAX_CANDIDATE_REVIEW_BYTES = 512 * 1_024;
const MAX_CANDIDATE_REVIEWS = 500;
const MAX_CLOSEOUT_ITEMS_PER_FIELD = 32;
const MAX_CLOSEOUT_ITEM_CHARACTERS = 2_000;
const MAX_CLOSEOUT_SCALAR_CHARACTERS = 4_000;
const MAX_CLOSEOUT_EVIDENCE_POINTERS = 32;
const MAX_CLOSEOUT_TOTAL_BYTES = 64 * 1_024;
const MAX_STRUCTURED_CLOSEOUT_ITEMS = MAX_CLOSEOUT_ITEMS_PER_FIELD;
const MAX_EXACT_DURABLE_CANDIDATE_BYTES = 60 * 1_024;
const MAX_REPLACEMENT_BASELINE_SECTIONS = 32;
const TERMINAL_REVIEW_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const CANDIDATE_LOCK_STALE_MILLISECONDS = 5 * 60 * 1_000;
const CANDIDATE_LOCK_RETRY_MILLISECONDS = 25;
const CANDIDATE_LOCK_WAIT_TIMEOUT_MILLISECONDS = 5_000;
const CANDIDATE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: CANDIDATE_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: CANDIDATE_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: CANDIDATE_LOCK_WAIT_TIMEOUT_MILLISECONDS,
} as const;

export const buildCandidateReview = Effect.fn('candidate.buildReview')(function* (
  input: SessionCloseoutInput,
  existing: readonly MemoryRecord[],
  now: Date,
) {
  return yield* buildCandidateReviewFromDrafts(input, existing, now, candidateDrafts(input));
});

/** Builds one reviewable durable candidate without normalizing its Markdown body. */
export const buildExactDurableCandidateReview = Effect.fn('candidate.buildExactDurableReview')(function* (
  input: SessionCloseoutInput,
  proposedText: string,
  existing: readonly MemoryRecord[],
  now: Date,
) {
  const validationError = validateSessionCloseoutInput(input);
  if (validationError) return yield* CandidateMemoryError.make({message: validationError});
  const text = proposedText.trim();
  if (!text) return yield* CandidateMemoryError.make({message: 'Exact durable candidate text is empty.'});
  if (new TextEncoder().encode(text).byteLength > MAX_EXACT_DURABLE_CANDIDATE_BYTES)
    return yield* CandidateMemoryError.make({
      message: `Exact durable candidate exceeds ${MAX_EXACT_DURABLE_CANDIDATE_BYTES} UTF-8 bytes.`,
    });
  return yield* buildCandidateReviewFromDrafts(input, existing, now, [
    {categories: ['invariant'], kind: 'durable', proposedText: text},
  ]);
});

const buildCandidateReviewFromDrafts = Effect.fn('candidate.buildReviewFromDrafts')(function* (
  input: SessionCloseoutInput,
  existing: readonly MemoryRecord[],
  now: Date,
  drafts: readonly CandidateDraft[],
) {
  const createdAt = now.toISOString();
  const reviewId = `review-${(yield* sha256Hex(
    [input.project, input.topic, input.sourceSessionId ?? '', input.task, createdAt].join('\n'),
  )).slice(0, 16)}`;
  const evidence = candidateEvidence(input);
  const candidates =
    evidence.length === 0
      ? []
      : yield* Effect.forEach(
          drafts.slice(0, 3),
          (draft, index) => compareCandidate(reviewId, index, input, draft, existing, evidence),
          {concurrency: 3},
        );
  const structuredCloseout = structuredCloseoutFromInput(input);
  return {
    auditEvents: [
      {
        action: 'create_review',
        at: createdAt,
        reviewId,
        revision: 1,
      },
    ],
    candidates,
    codeCitations: input.codeCitations ?? [],
    createdAt,
    outcome: input.outcome,
    project: input.project,
    reviewId,
    revision: 1,
    sourceAgentClient: input.sourceAgentClient,
    sourceCommit: input.sourceCommit,
    sourceSessionId: input.sourceSessionId,
    ...(structuredCloseout ? {structuredCloseout} : {}),
    task: input.task,
    topic: input.topic,
    version: 2,
  } satisfies CandidateReview;
});

export function candidateReviewWithState(
  review: CandidateReview,
  candidateId: string,
  state: CandidateReviewState,
  audit?: CandidateAuditTransition,
): CandidateReview {
  if (review.candidates.find(candidate => candidate.candidateId === candidateId)?.state === state) {
    return review;
  }
  const revision = review.revision + 1;
  const updated = {
    ...review,
    candidates: review.candidates.map(candidate =>
      candidate.candidateId === candidateId ? {...candidate, state} : candidate,
    ),
    revision,
  };
  return audit
    ? candidateReviewWithAuditEvent(updated, {
        ...audit,
        candidateId,
        reviewId: review.reviewId,
        revision,
      })
    : updated;
}

export function candidateReviewWithReplacementSafety(
  review: CandidateReview,
  candidateId: string,
  targetBody: string,
  targetContentHash: string,
  at: string,
): CandidateReview | undefined {
  const candidate = review.candidates.find(item => item.candidateId === candidateId);
  if (
    candidate?.state !== 'pending' ||
    candidate.comparison !== 'replacement' ||
    candidate.recommendation !== 'replace' ||
    candidate.targetUri === undefined
  ) {
    return undefined;
  }
  const revision = review.revision + 1;
  return candidateReviewWithAuditEvent(
    {
      ...review,
      candidates: review.candidates.map(item =>
        item.candidateId === candidateId
          ? {
              ...item,
              replacementSafetyBaseline: replacementSafetyBaseline(targetBody),
              targetContentHash,
            }
          : item,
      ),
      revision,
    },
    {
      action: 'refresh_safety',
      at,
      candidateId,
      reviewId: review.reviewId,
      revision,
    },
  );
}

export function candidateReviewWithApplying(
  review: CandidateReview,
  candidateId: string,
  apply: {
    readonly allowDestructiveReplacement: boolean;
    readonly bodyText: string;
    readonly contentHash: string;
    readonly operation: CandidateApplyOperation;
    readonly replaceUri?: string;
    readonly targetUri: string;
  },
  at: string,
): CandidateReview {
  return candidateReviewWithAuditEvent(
    {
      ...review,
      candidates: review.candidates.map(candidate =>
        candidate.candidateId === candidateId
          ? {
              ...candidate,
              ...(apply.allowDestructiveReplacement ? {applyAllowDestructiveReplacement: true} : {}),
              applyApprovedAt: at,
              applyBodyText: apply.bodyText,
              applyContentHash: apply.contentHash,
              applyOperation: apply.operation,
              applyReplaceUri: apply.replaceUri,
              applyStage: 'prepared',
              applyTargetUri: apply.targetUri,
              state: 'applying',
            }
          : candidate,
      ),
    },
    {
      action: 'begin_apply',
      ...(apply.allowDestructiveReplacement ? {allowDestructiveReplacement: true} : {}),
      at,
      candidateId,
      memoryUri: apply.targetUri,
      reviewId: review.reviewId,
      revision: review.revision,
    },
  );
}

function candidateReviewWithRecoveryApproval(
  review: CandidateReview,
  candidateId: string,
  allowDestructiveReplacement: boolean,
  at: string,
): {readonly candidate: MemoryCandidate; readonly review: CandidateReview} | undefined {
  const candidate = review.candidates.find(item => item.candidateId === candidateId);
  if (!candidate) return undefined;
  if (!allowDestructiveReplacement || candidate.applyAllowDestructiveReplacement === true) {
    return {candidate, review};
  }
  if (
    !candidate.applyBodyText ||
    !candidate.applyContentHash ||
    !candidate.applyOperation ||
    !candidate.applyTargetUri
  ) {
    return undefined;
  }
  const updated = candidateReviewWithApplying(
    review,
    candidateId,
    {
      allowDestructiveReplacement: true,
      bodyText: candidate.applyBodyText,
      contentHash: candidate.applyContentHash,
      operation: candidate.applyOperation,
      replaceUri: candidate.applyReplaceUri,
      targetUri: candidate.applyTargetUri,
    },
    at,
  );
  return {
    candidate: updated.candidates.find(item => item.candidateId === candidateId) ?? candidate,
    review: updated,
  };
}

export type CandidateReplacementRecoveryPreparation =
  | {
      readonly assessment: ReplacementSafetyAssessmentV1;
      readonly status: 'destructive-approval-required';
    }
  | {readonly status: 'unavailable'}
  | {
      readonly candidate: MemoryCandidate;
      readonly review: CandidateReview;
      readonly status: 'ready';
    };

export function prepareCandidateReplacementRecovery(
  review: CandidateReview,
  candidateId: string,
  allowDestructiveReplacement: boolean,
  at: string,
  currentTargetBody: string | undefined,
  currentTargetHash: string | undefined,
): CandidateReplacementRecoveryPreparation {
  const candidate = review.candidates.find(item => item.candidateId === candidateId);
  if (!candidate) return {status: 'unavailable'};
  if (allowDestructiveReplacement && candidate.applyOperation !== 'replace') return {status: 'unavailable'};
  const assessment = assessInterruptedReplacementSafety(candidate, currentTargetBody, currentTargetHash);
  if (assessment === 'unavailable') return {status: 'unavailable'};
  if (
    assessment?.destructiveLossRisk &&
    candidate.applyAllowDestructiveReplacement !== true &&
    !allowDestructiveReplacement
  ) {
    return {assessment, status: 'destructive-approval-required'};
  }
  const recovery = candidateReviewWithRecoveryApproval(review, candidateId, allowDestructiveReplacement, at);
  return recovery ? {...recovery, status: 'ready'} : {status: 'unavailable'};
}

export function candidateReviewWithApplyStage(
  review: CandidateReview,
  candidateId: string,
  applyStage: CandidateApplyStage,
): CandidateReview {
  return {
    ...review,
    candidates: review.candidates.map(candidate =>
      candidate.candidateId === candidateId ? {...candidate, applyStage} : candidate,
    ),
  };
}

export function validateSessionCloseoutInput(input: SessionCloseoutInput): string | undefined {
  const scalarFields = [
    ['task', input.task],
    ['outcome', input.outcome],
    ['project', input.project],
    ['topic', input.topic],
    ['sourceAgentClient', input.sourceAgentClient],
    ['sourceCommit', input.sourceCommit],
    ['sourceSessionId', input.sourceSessionId],
    ['rationale', input.rationale],
  ] as const;
  for (const [name, value] of scalarFields) {
    if ((value?.length ?? 0) > MAX_CLOSEOUT_SCALAR_CHARACTERS) {
      return `${name} exceeds ${MAX_CLOSEOUT_SCALAR_CHARACTERS} characters.`;
    }
  }
  const listFields = [
    ['decisions', input.decisions, MAX_CLOSEOUT_ITEMS_PER_FIELD],
    ['evidence', input.evidence, MAX_CLOSEOUT_EVIDENCE_POINTERS],
    ['handoff', input.handoff, MAX_CLOSEOUT_ITEMS_PER_FIELD],
    ['invariants', input.invariants, MAX_CLOSEOUT_ITEMS_PER_FIELD],
    ['preferences', input.preferences, MAX_CLOSEOUT_ITEMS_PER_FIELD],
    ['constraints', input.constraints, MAX_STRUCTURED_CLOSEOUT_ITEMS],
    ['verificationPerformed', input.verificationPerformed, MAX_STRUCTURED_CLOSEOUT_ITEMS],
    ['knowledgeInvalidated', input.knowledgeInvalidated, MAX_STRUCTURED_CLOSEOUT_ITEMS],
    ['unresolvedRisks', input.unresolvedRisks, MAX_STRUCTURED_CLOSEOUT_ITEMS],
  ] as const;
  for (const [name, values, maximumItems] of listFields) {
    if ((values?.length ?? 0) > maximumItems) {
      return `${name} exceeds ${maximumItems} items.`;
    }
    if ((values ?? []).some(value => value.length > MAX_CLOSEOUT_ITEM_CHARACTERS)) {
      return `${name} contains an item exceeding ${MAX_CLOSEOUT_ITEM_CHARACTERS} characters.`;
    }
  }
  if (input.structuredCloseout !== undefined) {
    const structuredError = validateStructuredCloseout(input.structuredCloseout);
    if (structuredError) return structuredError;
  }
  const totalBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  return totalBytes > MAX_CLOSEOUT_TOTAL_BYTES
    ? `session closeout exceeds ${MAX_CLOSEOUT_TOTAL_BYTES} UTF-8 bytes.`
    : undefined;
}

export function structuredCloseoutFromInput(input: SessionCloseoutInput): StructuredCloseoutV1 | undefined {
  const nested = input.structuredCloseout;
  const hasDirectFields =
    input.rationale !== undefined ||
    input.constraints !== undefined ||
    input.verificationPerformed !== undefined ||
    input.knowledgeInvalidated !== undefined ||
    input.unresolvedRisks !== undefined;
  if (!nested && !hasDirectFields) return undefined;
  const structured = {
    type: 'structured-closeout',
    version: 1,
    rationale: (nested?.rationale ?? input.rationale ?? '').trim(),
    constraints: normalizedItems(nested?.constraints ?? input.constraints),
    verificationPerformed: normalizedItems(nested?.verificationPerformed ?? input.verificationPerformed),
    knowledgeInvalidated: normalizedItems(nested?.knowledgeInvalidated ?? input.knowledgeInvalidated),
    unresolvedRisks: normalizedItems(nested?.unresolvedRisks ?? input.unresolvedRisks),
  } satisfies StructuredCloseoutV1;
  return structured.rationale ||
    structured.constraints.length > 0 ||
    structured.verificationPerformed.length > 0 ||
    structured.knowledgeInvalidated.length > 0 ||
    structured.unresolvedRisks.length > 0
    ? structured
    : undefined;
}

function validateStructuredCloseout(value: StructuredCloseoutV1): string | undefined {
  if (value.type !== 'structured-closeout' || value.version !== 1) {
    return 'structuredCloseout has an unsupported type or version.';
  }
  if (value.rationale.length > MAX_CLOSEOUT_SCALAR_CHARACTERS) {
    return `rationale exceeds ${MAX_CLOSEOUT_SCALAR_CHARACTERS} characters.`;
  }
  const lists = [
    ['constraints', value.constraints],
    ['verificationPerformed', value.verificationPerformed],
    ['knowledgeInvalidated', value.knowledgeInvalidated],
    ['unresolvedRisks', value.unresolvedRisks],
  ] as const;
  for (const [name, items] of lists) {
    if (items.length > MAX_STRUCTURED_CLOSEOUT_ITEMS) return `${name} exceeds ${MAX_STRUCTURED_CLOSEOUT_ITEMS} items.`;
    if (items.some(item => item.length > MAX_CLOSEOUT_ITEM_CHARACTERS)) {
      return `${name} contains an item exceeding ${MAX_CLOSEOUT_ITEM_CHARACTERS} characters.`;
    }
  }
  return undefined;
}

export function candidateReviewWithAuditEvent(review: CandidateReview, event: CandidateAuditEvent): CandidateReview {
  const duplicate = review.auditEvents.some(
    item =>
      item.action === event.action &&
      item.allowDestructiveReplacement === event.allowDestructiveReplacement &&
      item.candidateId === event.candidateId &&
      item.reviewId === event.reviewId &&
      item.revision === event.revision,
  );
  if (duplicate) {
    return review;
  }
  const appended = [...review.auditEvents, event];
  const creationEvent = appended.find(item => item.action === 'create_review');
  const recentEvents = appended
    .filter(item => item !== creationEvent)
    .slice(-(MAX_CANDIDATE_REVIEW_AUDIT_EVENTS - (creationEvent ? 1 : 0)));
  return {
    ...review,
    auditEvents: creationEvent ? [creationEvent, ...recentEvents] : recentEvents,
  };
}

export const readActiveProjectMemories = Effect.fn('candidate.readActiveProjectMemories')(function* (
  config: {readonly account: string; readonly agentContextHome: string; readonly user: string},
  project: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const root = pathService.join(
    config.agentContextHome,
    'data',
    config.account,
    'user',
    uriSegment(config.user),
    'memories',
  );
  const projectSegment = uriSegment(project);
  const directDirectories = [
    pathService.join(root, 'durable', 'projects', projectSegment),
    pathService.join(root, 'handoffs', 'active', projectSegment),
  ];
  const paths: string[] = [];
  for (const directory of directDirectories) {
    paths.push(...(yield* markdownFiles(fs, directory, root)));
  }
  paths.push(...(yield* markdownFiles(fs, pathService.join(root, 'preferences'), root, false)));
  const sharedRoot = pathService.join(root, 'shared');
  const teams = yield* safeChildDirectoryNames(fs, sharedRoot, root);
  if (teams.length > 0) {
    const sharedPaths = yield* Effect.forEach(
      teams,
      team => markdownFiles(fs, pathService.join(sharedRoot, team, 'durable', 'projects', projectSegment), root),
      {concurrency: MEMORY_READ_CONCURRENCY},
    );
    paths.push(...sharedPaths.flat());
  }
  const records = yield* Effect.forEach(
    [...new Set(paths)],
    path =>
      Effect.gen(function* () {
        const content = yield* fs.readFileString(path);
        const relative = pathService.relative(root, path).split(pathService.sep).join('/');
        const record = parseMemoryDocument(
          `threadnote://user/${uriSegment(config.user)}/memories/${relative}`,
          content,
        );
        return record?.metadata.status === 'active' &&
          (record.metadata.project === project || record.metadata.kind === 'preference')
          ? record
          : undefined;
      }),
    {concurrency: MEMORY_READ_CONCURRENCY},
  );
  return records.filter((record): record is MemoryRecord => record !== undefined);
});

export const saveCandidateReview = Effect.fn('candidate.saveReview')(function* (
  agentContextHome: string,
  review: CandidateReview,
) {
  if (review.maintenance !== undefined)
    yield* Effect.try({
      try: () => validateTopicMaintenanceReviewPayload(review.maintenance),
      catch: cause => CandidateMemoryError.make({message: errorText(cause)}),
    });
  if (!validTopicClosedConflict(review))
    return yield* CandidateMemoryError.make({message: 'invalid closed topic conflict receipt'});
  if (review.maintenanceApproval !== undefined)
    yield* Effect.try({
      try: () => {
        if (!review.maintenance) throw new Error('Approval requires a maintenance review.');
        validateTopicMaintenanceApprovalReceipt(
          review.maintenanceApproval,
          review.maintenance,
          review.reviewId,
          review.revision,
        );
      },
      catch: cause => CandidateMemoryError.make({message: errorText(cause)}),
    });
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = candidateReviewPath(pathService, agentContextHome, review.reviewId);
  const serialized = `${JSON.stringify(review, undefined, 2)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > MAX_CANDIDATE_REVIEW_BYTES) {
    return yield* CandidateMemoryError.make({
      message: `Candidate review exceeds the ${MAX_CANDIDATE_REVIEW_BYTES}-byte persistence limit.`,
    });
  }
  yield* writePrivateFileAtomically(fs, path, serialized);
  yield* syncCandidateAudit(agentContextHome, review.auditEvents);
  yield* pruneCandidateReviews(fs, pathService.dirname(path), review.reviewId);
  return path;
});

export const loadCandidateReview = Effect.fn('candidate.loadReview')(function* (
  agentContextHome: string,
  reviewId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = candidateReviewPath(pathService, agentContextHome, reviewId);
  const raw = yield* fs.readFileString(path);
  const review = yield* Effect.try({
    try: () => parseCandidateReview(JSON.parse(raw)),
    catch: cause => CandidateMemoryError.make({message: `Invalid candidate review ${reviewId}: ${errorText(cause)}`}),
  });
  yield* syncCandidateAudit(agentContextHome, review.auditEvents);
  return review;
});

/** Missing is optional; malformed or unreadable reviews remain explicit failures. */
export const loadCandidateReviewOptional = Effect.fn('candidate.loadReviewOptional')(function* (
  agentContextHome: string,
  reviewId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = candidateReviewPath(pathService, agentContextHome, reviewId);
  return (yield* fs.exists(path)) ? yield* loadCandidateReview(agentContextHome, reviewId) : undefined;
});

/** Read the bounded private review set for maintenance reporting without mutating retention state. */
export const listCandidateReviews = Effect.fn('candidate.listReviews')(function* (agentContextHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const directory = pathService.join(agentContextHome, 'threadnote', 'candidates', 'v1', 'reviews');
  const entries = yield* fs.readDirectory(directory).pipe(Effect.option);
  if (entries._tag === 'None') return [];
  const reviews = yield* Effect.forEach(
    entries.value
      .filter(name => name.endsWith('.json') && !name.startsWith('.'))
      .sort()
      .slice(-MAX_CANDIDATE_REVIEWS),
    name =>
      Effect.gen(function* () {
        const raw = yield* fs.readFileString(pathService.join(directory, name));
        return yield* Effect.try({
          try: () => parseCandidateReview(JSON.parse(raw)),
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined));
      }),
    {concurrency: MEMORY_READ_CONCURRENCY},
  );
  return reviews
    .filter((review): review is CandidateReview => review !== undefined)
    .sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.reviewId.localeCompare(right.reviewId),
    );
});

export const appendCandidateAudit = Effect.fn('candidate.appendAudit')(function* (
  agentContextHome: string,
  event: CandidateAuditEvent,
) {
  return yield* syncCandidateAudit(agentContextHome, [event]);
});

const syncCandidateAudit = Effect.fn('candidate.syncAudit')(function* (
  agentContextHome: string,
  events: readonly CandidateAuditEvent[],
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = pathService.join(agentContextHome, 'threadnote', 'candidates', 'v1', 'audit.jsonl');
  yield* withExclusiveFileLock(
    fs,
    `${path}.lock`,
    CANDIDATE_LOCK_OPTIONS,
    Effect.gen(function* () {
      const existing = yield* readCandidateAudit(fs, path);
      const eventKeys = new Set(existing.map(candidateAuditEventKey));
      const additions = events.filter(event => {
        const key = candidateAuditEventKey(event);
        if (eventKeys.has(key)) {
          return false;
        }
        eventKeys.add(key);
        return true;
      });
      if (additions.length > 0) {
        const bounded = [...existing, ...additions]
          .sort((left, right) => candidateAuditTimestamp(left) - candidateAuditTimestamp(right))
          .slice(-MAX_CANDIDATE_AUDIT_EVENTS);
        if (bounded.map(candidateAuditEventKey).join('\n') !== existing.map(candidateAuditEventKey).join('\n')) {
          yield* writePrivateFileAtomically(fs, path, `${bounded.map(item => JSON.stringify(item)).join('\n')}\n`);
        }
      }
    }),
  );
  return path;
});

function candidateAuditEventKey(event: CandidateAuditEvent): string {
  return [
    event.action,
    event.allowDestructiveReplacement === true ? 'destructive-approved' : '',
    event.candidateId ?? '',
    event.reviewId,
    event.revision,
  ].join('\n');
}

function candidateAuditTimestamp(event: CandidateAuditEvent): number {
  const timestamp = Date.parse(event.at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function withCandidateReviewLock<A, E, R>(
  agentContextHome: string,
  reviewId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, Crypto.Crypto | R | FileSystem.FileSystem | Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const lockDirectory = pathService.join(agentContextHome, 'threadnote', 'candidates', 'v1', 'locks');
    const lockPath = pathService.join(lockDirectory, `${reviewId.replace(/[^a-zA-Z0-9._-]/g, '')}.lock`);
    return yield* withExclusiveFileLock(fs, lockPath, CANDIDATE_LOCK_OPTIONS, effect);
  });
}

function candidateDrafts(input: SessionCloseoutInput): readonly CandidateDraft[] {
  const decisions = normalizedItems(input.decisions);
  const invariants = normalizedItems(input.invariants);
  const preferences = normalizedItems(input.preferences);
  const handoff = normalizedItems(input.handoff);
  const structuredCloseout = structuredCloseoutFromInput(input);
  const drafts: CandidateDraft[] = [];
  if (decisions.length > 0 || invariants.length > 0 || structuredCloseout !== undefined) {
    drafts.push({
      categories: [
        ...(decisions.length > 0 ? (['decision'] as const) : []),
        ...(invariants.length > 0 || structuredCloseout !== undefined ? (['invariant'] as const) : []),
      ],
      kind: 'durable',
      proposedText: formatSections([
        ['Decisions', decisions],
        ['Invariants', invariants],
        ...(structuredCloseout ? structuredCloseoutSections(structuredCloseout) : []),
      ]),
    });
  }
  if (preferences.length > 0) {
    drafts.push({
      categories: ['preference'],
      kind: 'preference',
      proposedText: formatSections([['Preferences', preferences]]),
    });
  }
  if (handoff.length > 0) {
    drafts.push({
      categories: ['handoff'],
      kind: 'handoff',
      proposedText: formatSections([['Handoff state', handoff]]),
    });
  }
  return drafts;
}

const compareCandidate = Effect.fn('candidate.compare')(function* (
  reviewId: string,
  index: number,
  input: SessionCloseoutInput,
  draft: CandidateDraft,
  existing: readonly MemoryRecord[],
  evidence: readonly string[],
) {
  const sameTarget = existing
    .filter(
      record =>
        record.metadata.kind === draft.kind &&
        (draft.kind === 'preference' || record.metadata.project === input.project) &&
        record.metadata.topic === input.topic,
    )
    .sort((left, right) => right.metadata.timestamp.localeCompare(left.metadata.timestamp))[0];
  const mostSimilar = bestSimilarRecord(draft.proposedText, existing, input.project, draft.kind);
  const comparison = classifyComparison(draft.proposedText, sameTarget, mostSimilar);
  const target = sameTarget ?? (comparison === 'possible_duplicate' ? mostSimilar?.record : undefined);
  const recommendation: CandidateRecommendation =
    comparison === 'duplicate'
      ? 'no_action'
      : comparison === 'replacement'
        ? 'replace'
        : comparison === 'contradiction' || comparison === 'possible_duplicate'
          ? 'manual_review'
          : 'create';
  return {
    candidateId: `${reviewId}-${index + 1}`,
    categories: draft.categories,
    comparison,
    confidence:
      comparison === 'duplicate' ? 0.99 : comparison === 'replacement' ? 0.9 : comparison === 'new' ? 0.82 : 0.65,
    evidence,
    kind: draft.kind,
    project: input.project,
    proposedText: draft.proposedText,
    reason: comparisonReason(comparison),
    recommendation,
    ...(target ? {replacementSafetyBaseline: replacementSafetyBaseline(target.body)} : {}),
    state: 'pending',
    targetContentHash: target ? yield* sha256Hex(canonicalMemoryDocumentContent(target.content)) : undefined,
    targetUri: target?.uri,
    topic: input.topic,
  } satisfies MemoryCandidate;
});

export function replacementSafetyBaseline(body: string): ReplacementSafetyBaselineV1 {
  const normalizedBody = body.trim();
  const sections = sectionHeadings(normalizedBody);
  return {
    bodyCharacters: normalizedBody.length,
    nonEmptyLines: nonEmptyLineCount(normalizedBody),
    sectionHeadings: sections.slice(0, MAX_REPLACEMENT_BASELINE_SECTIONS),
    sectionListTruncated: sections.length > MAX_REPLACEMENT_BASELINE_SECTIONS,
    version: 1,
  };
}

export function replacementSafetyReviewRequiredWarning(candidate: MemoryCandidate): string {
  return (
    `Replacement safety is unavailable for legacy candidate ${candidate.candidateId}. ` +
    'Run review_session_context again before replacing the current target.'
  );
}

export function assessReplacementSafety(
  kind: MemoryCandidate['kind'],
  target: ReplacementSafetyBaselineV1,
  proposedBody: string,
): ReplacementSafetyAssessmentV1 {
  const proposed = replacementSafetyBaseline(proposedBody);
  const retainedCharacterRatio = retainedRatio(proposed.bodyCharacters, target.bodyCharacters);
  const retainedLineRatio = retainedRatio(proposed.nonEmptyLines, target.nonEmptyLines);
  const proposedSections = new Set(proposed.sectionHeadings.map(normalizedSectionKey));
  const missingSections = target.sectionHeadings.filter(
    section => !proposedSections.has(normalizedSectionKey(section)),
  );
  const ratioThreshold = kind === 'handoff' ? 0.7 : 0.5;
  const removedCharacters = Math.max(0, target.bodyCharacters - proposed.bodyCharacters);
  const losesMostCharacters = retainedCharacterRatio < ratioThreshold;
  const losesMostLines = target.nonEmptyLines >= 8 && retainedLineRatio < ratioThreshold;
  const losesMaterialCharacters = target.bodyCharacters >= 256 && losesMostCharacters;
  const losesMaterialLines = target.nonEmptyLines >= 8 && losesMostLines;
  const losesMultipleSections =
    target.sectionHeadings.length >= 2 &&
    missingSections.length >= 2 &&
    (removedCharacters >= 256 || losesMaterialCharacters || losesMaterialLines);
  return {
    destructiveLossRisk: losesMaterialCharacters || losesMaterialLines || losesMultipleSections,
    missingSections,
    proposedBodyCharacters: proposed.bodyCharacters,
    proposedNonEmptyLines: proposed.nonEmptyLines,
    retainedCharacterRatio,
    retainedLineRatio,
    targetBodyCharacters: target.bodyCharacters,
    targetNonEmptyLines: target.nonEmptyLines,
  };
}

function assessInterruptedReplacementSafety(
  candidate: MemoryCandidate,
  currentTargetBody: string | undefined,
  currentTargetHash: string | undefined,
): ReplacementSafetyAssessmentV1 | 'unavailable' | undefined {
  if (
    candidate.applyOperation !== 'replace' ||
    !candidate.applyReplaceUri ||
    !candidate.applyTargetUri ||
    candidate.applyReplaceUri === candidate.applyTargetUri ||
    currentTargetBody === undefined
  ) {
    return undefined;
  }
  if (!candidate.applyBodyText || !candidate.targetContentHash) return 'unavailable';
  if (currentTargetHash !== candidate.targetContentHash) return undefined;
  return assessReplacementSafety(candidate.kind, replacementSafetyBaseline(currentTargetBody), candidate.applyBodyText);
}

function retainedRatio(proposed: number, target: number): number {
  return target === 0 ? 1 : Math.min(1, proposed / target);
}

function sectionHeadings(body: string): readonly string[] {
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const section =
      parseMarkdownHeadingLine(trimmed)?.title ??
      (/^[^\s].{0,118}:$/u.test(trimmed) && !/^[-*+]\s/u.test(trimmed) ? trimmed.slice(0, -1).trim() : undefined);
    if (!section) continue;
    const key = normalizedSectionKey(section);
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push(section);
  }
  return sections;
}

function normalizedSectionKey(section: string): string {
  return section.replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

function nonEmptyLineCount(body: string): number {
  return body.split(/\r?\n/u).filter(line => line.trim().length > 0).length;
}

function classifyComparison(
  proposedText: string,
  sameTarget: MemoryRecord | undefined,
  mostSimilar: {readonly record: MemoryRecord; readonly similarity: number} | undefined,
): CandidateComparison {
  if (sameTarget) {
    if (textSimilarity(proposedText, sameTarget.body) >= 0.92) {
      return 'duplicate';
    }
    return looksContradictory(proposedText, sameTarget.body) ? 'contradiction' : 'replacement';
  }
  if (mostSimilar && mostSimilar.similarity >= 0.82) {
    return 'possible_duplicate';
  }
  return 'new';
}

function bestSimilarRecord(
  proposedText: string,
  existing: readonly MemoryRecord[],
  project: string,
  kind: MemoryCandidate['kind'],
): {readonly record: MemoryRecord; readonly similarity: number} | undefined {
  return existing
    .filter(record => record.metadata.kind === kind && (kind === 'preference' || record.metadata.project === project))
    .map(record => ({record, similarity: textSimilarity(proposedText, record.body)}))
    .sort((left, right) => right.similarity - left.similarity)[0];
}

function textSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function looksContradictory(left: string, right: string): boolean {
  const negative = /\b(?:cannot|disabled|doesn't|do not|must not|never|no|not)\b/i;
  const leftNegative = negative.test(left);
  const rightNegative = negative.test(right);
  if (leftNegative === rightNegative) {
    return false;
  }
  const withoutNegation = (value: string) =>
    value.replace(/\b(?:cannot|disabled|doesn't|do not|must not|never|no|not)\b/gi, '');
  return textSimilarity(withoutNegation(left), withoutNegation(right)) >= 0.55;
}

function comparisonReason(comparison: CandidateComparison): string {
  switch (comparison) {
    case 'duplicate':
      return 'An active memory already contains substantially the same information.';
    case 'replacement':
      return 'An active memory has the same stable project, topic, and kind; replace it to keep one current fact.';
    case 'contradiction':
      return 'The candidate may contradict the active memory for the same stable project and topic.';
    case 'possible_duplicate':
      return 'A similar active memory exists under another topic; review before creating another copy.';
    case 'new':
      return 'No active memory with the same stable identity or substantially similar content was found.';
  }
}

function normalizedItems(items: readonly string[] | undefined): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items ?? []) {
    const normalized = item.replace(/\s+/g, ' ').trim();
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function candidateEvidence(input: SessionCloseoutInput): readonly string[] {
  return normalizedItems([
    ...(input.evidence ?? []),
    ...(input.codeCitations ?? []).map(citation => `code-citation:${citation.id}`),
    ...(input.sourceSessionId ? [`session:${input.sourceSessionId}`] : []),
    ...(input.sourceCommit ? [`commit:${input.sourceCommit}`] : []),
  ]);
}

function formatSections(sections: ReadonlyArray<readonly [string, readonly string[]]>): string {
  return sections
    .filter(([, items]) => items.length > 0)
    .flatMap(([title, items]) => [`## ${title}`, ...items.map(item => `- ${item}`)])
    .join('\n');
}

function structuredCloseoutSections(value: StructuredCloseoutV1): ReadonlyArray<readonly [string, readonly string[]]> {
  return [
    ['Rationale', value.rationale ? [value.rationale] : []],
    ['Constraints', value.constraints],
    ['Verification performed', value.verificationPerformed],
    ['Knowledge invalidated', value.knowledgeInvalidated],
    ['Unresolved risks', value.unresolvedRisks],
  ];
}

function tokens(value: string): readonly string[] {
  return [...value.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)].map(match => match[0]);
}

function candidateReviewPath(pathService: Path.Path, agentContextHome: string, reviewId: string): string {
  const safeReviewId = reviewId.replace(/[^a-zA-Z0-9._-]/g, '');
  return pathService.join(agentContextHome, 'threadnote', 'candidates', 'v1', 'reviews', `${safeReviewId}.json`);
}

function writePrivateFileAtomically(
  fs: FileSystem.FileSystem,
  path: string,
  content: string,
): Effect.Effect<void, unknown, Crypto.Crypto | Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
    const crypto = yield* Crypto.Crypto;
    const temporaryPath = `${path}.${yield* crypto.randomUUIDv4()}.tmp`;
    yield* fs.writeFileString(temporaryPath, content, {mode: 0o600});
    yield* fs
      .rename(temporaryPath, path)
      .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
  });
}

function markdownFiles(
  fs: FileSystem.FileSystem,
  root: string,
  boundaryRoot: string,
  recursive = true,
): Effect.Effect<readonly string[], unknown, Path.Path> {
  return scanFilesWithinBoundary(fs, root, boundaryRoot, {
    includeFile: (_path, name) => name.endsWith('.md') && !name.startsWith('.'),
    recursive,
  }).pipe(Effect.map(files => files.map(file => file.path)));
}

function readCandidateAudit(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<readonly CandidateAuditEvent[], unknown> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) {
      return [];
    }
    const raw = yield* fs.readFileString(path);
    return raw
      .split('\n')
      .map(line =>
        line.trim()
          ? Option.getOrUndefined(Option.liftThrowable((content: string): unknown => JSON.parse(content))(line))
          : undefined,
      )
      .filter((event): event is CandidateAuditEvent => event !== undefined && candidateAuditEventIsValid(event))
      .slice(-MAX_CANDIDATE_AUDIT_EVENTS);
  });
}

function pruneCandidateReviews(
  fs: FileSystem.FileSystem,
  reviewDirectory: string,
  currentReviewId: string,
): Effect.Effect<void, unknown, Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const reviews = yield* Effect.forEach(
      (yield* fs.readDirectory(reviewDirectory)).filter(name => name.endsWith('.json')),
      name =>
        Effect.gen(function* () {
          const path = pathService.join(reviewDirectory, name);
          const info = yield* fs.stat(path);
          const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime() ?? now;
          const raw = yield* fs.readFileString(path);
          const review = yield* Effect.try({
            try: () => parseCandidateReview(JSON.parse(raw)),
            catch: () => undefined,
          }).pipe(Effect.orElseSucceed(() => undefined));
          return {modifiedAt, path, review};
        }),
      {concurrency: MEMORY_READ_CONCURRENCY},
    );
    const removable = reviews
      .filter(item => item.review?.reviewId !== currentReviewId)
      .sort(
        (left, right) =>
          candidateReviewRetentionPriority(left.review) - candidateReviewRetentionPriority(right.review) ||
          left.modifiedAt - right.modifiedAt,
      );
    let remaining = reviews.length;
    for (const item of removable) {
      const expired =
        candidateReviewIsTerminal(item.review) && now - item.modifiedAt > TERMINAL_REVIEW_RETENTION_MILLISECONDS;
      if (!expired && remaining <= MAX_CANDIDATE_REVIEWS) {
        break;
      }
      yield* fs.remove(item.path, {force: true});
      remaining -= 1;
    }
  });
}

function candidateReviewIsTerminal(review: CandidateReview | undefined): boolean {
  return (
    review?.candidates.every(
      candidate => candidate.state === 'applied' || candidate.state === 'conflict' || candidate.state === 'rejected',
    ) === true
  );
}

function candidateReviewRetentionPriority(review: CandidateReview | undefined): number {
  if (!review || candidateReviewIsTerminal(review)) {
    return 0;
  }
  if (review.candidates.every(candidate => candidate.state === 'deferred')) {
    return 1;
  }
  if (review.candidates.some(candidate => candidate.state === 'applying')) {
    return 3;
  }
  return 2;
}

export function parseCandidateReview(value: unknown): CandidateReview {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    (value.version !== 1 && value.version !== 2) ||
    !('reviewId' in value) ||
    typeof value.reviewId !== 'string' ||
    !('revision' in value) ||
    typeof value.revision !== 'number' ||
    !('candidates' in value) ||
    !Array.isArray(value.candidates)
  ) {
    throw CandidateMemoryError.make({message: 'unsupported review document'});
  }
  const review = value as Omit<CandidateReview, 'codeCitations' | 'version'> & {
    readonly codeCitations?: readonly MemoryCodeCitationV1[];
    readonly maintenance?: unknown;
    readonly maintenanceApproval?: unknown;
    readonly maintenanceClosedConflict?: unknown;
    readonly structuredCloseout?: unknown;
    readonly version: 1 | 2;
  };
  let codeCitations: readonly MemoryCodeCitationV1[] = [];
  if (review.version !== 2 && (review.maintenance !== undefined || review.maintenanceApproval !== undefined))
    throw CandidateMemoryError.make({message: 'maintenance payload requires a v2 candidate review'});
  if (review.maintenanceApproval !== undefined && review.maintenance === undefined)
    throw CandidateMemoryError.make({message: 'maintenance approval requires a review payload'});
  if (review.version === 2) {
    if (!Array.isArray(review.codeCitations)) throw CandidateMemoryError.make({message: 'invalid v2 code citations'});
    try {
      codeCitations = review.codeCitations.map(assertMemoryCodeCitation);
      formatMemoryCodeCitationLines(codeCitations);
    } catch {
      throw CandidateMemoryError.make({message: 'invalid v2 code citations'});
    }
  }
  const parsed: CandidateReview = {
    ...review,
    auditEvents: Array.isArray(review.auditEvents)
      ? review.auditEvents.filter(event => candidateAuditEventIsValid(event))
      : [],
    codeCitations,
    ...(review.structuredCloseout === undefined
      ? {}
      : {structuredCloseout: parseStructuredCloseout(review.structuredCloseout)}),
    ...(review.maintenance === undefined
      ? {}
      : {maintenance: validateTopicMaintenanceReviewPayload(review.maintenance)}),
    ...(review.maintenanceApproval === undefined
      ? {}
      : {
          maintenanceApproval: validateTopicMaintenanceApprovalReceipt(
            review.maintenanceApproval,
            review.maintenance!,
            review.reviewId,
            review.revision,
          ),
        }),
    version: 2,
  };
  if (!validTopicClosedConflict(parsed))
    throw CandidateMemoryError.make({message: 'invalid closed topic conflict receipt'});
  return parsed;
}

function parseStructuredCloseout(value: unknown): StructuredCloseoutV1 {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    value.type !== 'structured-closeout' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('rationale' in value) ||
    typeof value.rationale !== 'string' ||
    !('constraints' in value) ||
    !Array.isArray(value.constraints) ||
    !value.constraints.every(item => typeof item === 'string') ||
    !('verificationPerformed' in value) ||
    !Array.isArray(value.verificationPerformed) ||
    !value.verificationPerformed.every(item => typeof item === 'string') ||
    !('knowledgeInvalidated' in value) ||
    !Array.isArray(value.knowledgeInvalidated) ||
    !value.knowledgeInvalidated.every(item => typeof item === 'string') ||
    !('unresolvedRisks' in value) ||
    !Array.isArray(value.unresolvedRisks) ||
    !value.unresolvedRisks.every(item => typeof item === 'string')
  ) {
    throw CandidateMemoryError.make({message: 'invalid structured closeout'});
  }
  const structured = value as StructuredCloseoutV1;
  const error = validateStructuredCloseout(structured);
  if (error) throw CandidateMemoryError.make({message: error});
  return structured;
}

function candidateAuditEventIsValid(value: unknown): value is CandidateAuditEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'action' in value &&
    (value.action === 'apply' ||
      value.action === 'begin_apply' ||
      value.action === 'conflict' ||
      value.action === 'create_review' ||
      value.action === 'defer' ||
      value.action === 'refresh_safety' ||
      value.action === 'reject' ||
      value.action === 'resume') &&
    (!('allowDestructiveReplacement' in value) || typeof value.allowDestructiveReplacement === 'boolean') &&
    'at' in value &&
    typeof value.at === 'string' &&
    'reviewId' in value &&
    typeof value.reviewId === 'string' &&
    'revision' in value &&
    typeof value.revision === 'number'
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
