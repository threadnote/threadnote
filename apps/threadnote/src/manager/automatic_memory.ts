import {Effect, Result, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {isAgentArtifactUri, parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {loadCandidateReviewOptional, type CandidateReview} from '@threadnote/memory/candidate';
import type {
  ManagerAutomaticMemoryItem,
  ManagerAutomaticMemoryStatus,
  ManagerAutomaticReview,
  ManagerAutomaticReviewResponse,
} from '@threadnote/manager/attention/topic-contracts';
import {
  contextMaintenanceInventoryAuthorityLimits,
  readContextMaintenanceCanonicalRecord,
  readContextMaintenanceInventoryPage,
} from '../memory/context/maintenance_inventory.js';
import {maintenanceContentHash} from '../memory/context/maintenance_policy.js';
import {readPreparedMemory} from '../memory/context/maintenance_preparation_state.js';
import {readDraftQueueTarget} from '../memory/context/maintenance_draft_queue.js';
import {
  readAutomaticDraftBackgroundStatus,
  readTopicMaintenanceDraft,
  requestAutomaticMemoryReview,
  requestAutomaticMemoryDraft,
} from '../memory/context/maintenance_draft.js';
import {
  applyTopicMaintenanceReview,
  prepareTopicMaintenanceReview,
  decideTopicMaintenanceReview,
  TopicReviewError,
} from '../memory/context/maintenance_review.js';
import {
  projectAutomaticMemoryReview,
  projectTopicReviewRecovery,
  projectTopicReviewDecisionAcknowledgement,
} from '../memory/context/maintenance_review_projection.js';
import {isManagerProjectName} from './project/name.js';
import {ManagerConsumerClockHints} from './live_consumer_sources.js';

const HASH = /^[a-f0-9]{64}$/u;
const REVIEW = /^review-[a-f0-9]{24}$/u;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const invalid = () => ({status: 400, body: {error: 'Select an exact project, memory, and supported review action.'}});
const unavailable = () => ({
  status: 409,
  body: {error: 'The target or source access changed. Reload the memory and its exact review before continuing.'},
});
const exactKeys = (body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(body, key)) &&
  Object.keys(body).every(key => required.includes(key) || optional.includes(key));
const projectOf = (record: MemoryRecord) => record.metadata.project ?? 'unscoped';
const normalizedHeader = (content: string) =>
  content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n\n', 1)[0];
const reviewIdFor = (uri: string) => `review-${sha256HexSync(`topic-maintenance\0${uri}`).slice(0, 24)}`;

const selectedAutomaticReview = Effect.fn('managerAutomaticMemory.selectedReview')(function* (
  config: RuntimeConfig,
  project: string,
  reviewId: string,
) {
  const review = yield* loadCandidateReviewOptional(config.agentContextHome, reviewId);
  return review?.reviewId === reviewId &&
    review.project === project &&
    review.maintenance?.version === 3 &&
    review.candidates.length === 1
    ? review
    : undefined;
});

function automaticRecovery(review: CandidateReview) {
  const recovery = projectTopicReviewRecovery(review);
  if (!recovery) return undefined;
  const approval = review.maintenanceApproval;
  const canReject =
    (recovery.state === 'pending' && (!approval || approval.stage === 'preview' || approval.stage === 'parked')) ||
    (recovery.state === 'conflict' && approval?.stage === 'conflict');
  return {...recovery, ...(canReject ? {recovery: {action: 'reject' as const}} : {})};
}

/** Metadata recovery never depends on source prose access; only full reads do. */
const readAutomaticReviewResponse = Effect.fn('managerAutomaticMemory.reviewResponse')(function* (
  config: RuntimeConfig,
  project: string,
  reviewId: string,
) {
  const selected = yield* selectedAutomaticReview(config, project, reviewId);
  if (!selected) return undefined;
  const authorized = yield* readManagerAutomaticReview(config, project, reviewId).pipe(Effect.result);
  return (
    Result.isSuccess(authorized) && authorized.success ? authorized.success : automaticRecovery(selected)
  ) satisfies ManagerAutomaticReviewResponse | undefined;
});

/** Reuses the public V3 projection only after live source authorization and canonical target readback. */
export const readManagerAutomaticReview = Effect.fn('managerAutomaticMemory.review')(function* (
  config: RuntimeConfig,
  project: string,
  reviewId: string,
) {
  const checked = yield* readTopicMaintenanceDraft(config, reviewId);
  if (checked.project !== project || checked.maintenance?.version !== 3) return undefined;
  const base = projectAutomaticMemoryReview(checked);
  if (!base) return undefined;
  const target = yield* readContextMaintenanceCanonicalRecord(config, base.targetUri);
  if (projectOf(target.record) !== project) return undefined;
  const approval = checked.maintenanceApproval;
  const matches =
    approval?.version === 3 &&
    target.record.content === approval.preview.content &&
    maintenanceContentHash(target.record.content) === approval.preview.contentHash;
  const verified = matches && checked.candidates[0].state === 'applied' && approval.stage === 'written';
  const canFinishVerification = matches && checked.candidates[0].state === 'applying' && approval.stage === 'prepared';
  const current = maintenanceContentHash(target.record.content) === checked.maintenance.basis.targetHash;
  return {
    ...base,
    project,
    evidenceRevision: checked.maintenance.basis.observationRevision,
    canApply:
      !base.ownerProposal &&
      !checked.maintenance.basis.assessment.target.readOnly &&
      base.canApply &&
      (current || canFinishVerification),
    canFinishVerification,
    verified,
  } satisfies ManagerAutomaticReview;
});

const automaticStatus = Effect.fn('managerAutomaticMemory.status')(function* (
  config: RuntimeConfig,
  project: string,
  selectedUri?: string,
  afterUri?: string,
) {
  const page = selectedUri
    ? {uris: [selectedUri], total: 1, omitted: 0, incomplete: false, nextCursor: undefined}
    : yield* readContextMaintenanceInventoryPage(config, project, {afterUri});
  const background = yield* readAutomaticDraftBackgroundStatus(config);
  yield* (yield* ManagerConsumerClockHints).register('automatic-memory', project, background.nextEligibleAt);
  const items: ManagerAutomaticMemoryItem[] = [];
  let remainingBytes: number = contextMaintenanceInventoryAuthorityLimits.canonicalBytes;
  let lastUri: string | undefined;
  let processed = 0;
  let unavailableRecords = 0;
  for (const uri of page.uris) {
    if (remainingBytes < 1) break;
    const maxBytes = Math.min(remainingBytes, contextMaintenanceInventoryAuthorityLimits.recordBytes);
    const read = yield* readContextMaintenanceCanonicalRecord(config, uri, {maxBytes}).pipe(Effect.result);
    remainingBytes -= Result.isSuccess(read) ? read.success.bytes : maxBytes;
    lastUri = uri;
    processed++;
    if (Result.isFailure(read)) {
      unavailableRecords++;
      continue;
    }
    const record = read.success.record;
    if (
      projectOf(record) !== project ||
      record.metadata.status !== 'active' ||
      isAgentArtifactUri(record.uri) ||
      (record.metadata.topicMaintenance && !record.metadata.reviewedSupport)
    )
      continue;
    const targetHash = maintenanceContentHash(record.content);
    const cached = yield* readPreparedMemory(config, record.uri);
    const prepared = cached?.assessment.target.canonicalHash === targetHash ? cached : undefined;
    const checkpoint = yield* readDraftQueueTarget(config, sha256HexSync(record.uri));
    const cp = checkpoint?.materialRevision === prepared?.relevantRevision ? checkpoint : undefined;
    const pending = background.queued.find(work => work.targetUri === record.uri);
    const active = background.active?.targetUri === record.uri;
    const loaded = yield* selectedAutomaticReview(config, project, reviewIdFor(record.uri)).pipe(Effect.result);
    const prior =
      Result.isSuccess(loaded) && loaded.success?.maintenance?.basis.targetUri === record.uri
        ? loaded.success
        : undefined;
    // Status exposes journal state only, never proposal/source prose or freshness authority.
    const approval = prior?.maintenanceApproval;
    const written =
      approval?.version === 3 &&
      targetHash === approval.preview.contentHash &&
      record.content === approval.preview.content;
    const review =
      prior && prior.candidates[0].state !== 'rejected'
        ? {
            reviewId: prior.reviewId,
            state: prior.candidates[0].state,
            evidenceRevision: prior.maintenance!.basis.observationRevision,
            verified: written && prior.candidates[0].state === 'applied' && approval.stage === 'written',
            canFinishVerification: written && prior.candidates[0].state === 'applying' && approval.stage === 'prepared',
          }
        : undefined;
    let state: ManagerAutomaticMemoryItem['state'] = !prepared
      ? 'preparing'
      : record.metadata.reviewedSupport
        ? 'reviewed'
        : 'unknown';
    let reason: string | undefined = prepared?.omissions.join(', ') || undefined;
    if (review?.verified && !active && !pending) state = 'reviewed';
    else if (review && !review.verified && ['pending', 'applying', 'deferred', 'conflict'].includes(review.state)) {
      state =
        review.canFinishVerification || review.state === 'applying'
          ? 'verification'
          : review.state === 'deferred'
            ? 'deferred'
            : review.state === 'conflict'
              ? 'failed'
              : 'ready';
    } else if (active) state = 'generating';
    else if (background.allMaintenancePaused || background.policy.paused) state = 'paused';
    else if (cp?.decision) {
      state = 'policy';
      reason = `Review ${cp.decision === 'defer' ? 'deferred' : 'rejected'} for unchanged evidence`;
    } else if (pending?.waitingReason === 'hourly-budget' || pending?.waitingReason === 'remote-budget')
      state = 'waiting-budget';
    else if (background.provider.state === 'waiting') {
      state = 'waiting-model';
      reason =
        'Set up the selected generation model in Runtime Health. Automatic preparation resumes when it is available.';
    } else if (background.waitingReason) {
      state = 'policy';
      reason = background.waitingReason;
    } else if (cp?.state === 'failed') {
      state = 'failed';
      reason = cp.reason;
    } else if (cp?.nextEligibleAt !== undefined && cp.state === 'waiting') {
      state = 'retry';
      reason = cp.reason;
    } else if (pending) {
      state = pending.waitingReason ? 'policy' : 'queued';
      reason = pending.waitingReason ?? reason;
    }
    const assessment = prepared?.assessment;
    const accepted = record.metadata.reviewedSupport?.active;
    const item: ManagerAutomaticMemoryItem = {
      uri: record.uri,
      title:
        record.body.match(/^#{1,6}\s+(.+)$/mu)?.[1] ??
        record.metadata.topic ??
        record.uri.split('/').at(-1) ??
        'Memory',
      targetHash,
      state,
      ...(reason ? {reason} : {}),
      ...(cp?.nextEligibleAt !== undefined
        ? {nextEligibleAt: cp.nextEligibleAt, retryCount: cp.retryCount}
        : state === 'waiting-budget' && background.nextEligibleAt !== undefined
          ? {nextEligibleAt: background.nextEligibleAt}
          : {}),
      ...(review && !review.verified ? {reviewId: review.reviewId, evidenceRevision: review.evidenceRevision} : {}),
      coverage: assessment?.coverage ?? {
        outcome: 'unknown',
        scope: 'none',
        searchedScopes: [],
        omittedSources: 0,
        omittedParagraphs: null,
      },
      paragraphs:
        assessment?.paragraphs.map(p => ({
          ordinal: p.ordinal,
          role: p.role,
          authority: p.roleAuthority,
          support: p.support,
        })) ??
        accepted?.paragraphs.map(p => ({
          ordinal: p.ordinal,
          role: p.role,
          authority: 'reviewed',
          support: p.support,
        })) ??
        [],
      route:
        assessment?.capabilities.reviewRoute ??
        (record.uri.includes('/shared/')
          ? 'shared-owner-review'
          : record.metadata.visibility === 'external'
            ? 'read-only'
            : 'personal-review'),
      canGenerate:
        assessment?.capabilities.draft === true &&
        !prior &&
        !cp?.decision &&
        cp?.state !== 'failed' &&
        !background.allMaintenancePaused,
      legacyUncited:
        !record.metadata.reviewedSupport &&
        !record.metadata.codeCitations?.length &&
        !record.metadata.relations?.length &&
        !record.metadata.sourceEvidence &&
        !record.metadata.obsidianEvidence,
    };
    if (selectedUri || state !== 'reviewed') items.push(item);
  }
  return {
    version: 1,
    project,
    items,
    omitted: page.omitted + unavailableRecords + page.uris.length - processed,
    incomplete: page.incomplete || unavailableRecords > 0 || lastUri !== page.uris.at(-1),
    ...(unavailableRecords ? {unavailableRecords} : {}),
    ...(!selectedUri && lastUri && (lastUri !== page.uris.at(-1) || page.nextCursor) ? {nextCursor: lastUri} : {}),
  } satisfies ManagerAutomaticMemoryStatus;
});

/** HTTP is a Manager adapter; it owns no writer, provider registry or scheduling state. */
export const handleManagerAutomaticMemory = Effect.fn('managerAutomaticMemory.handle')(function* (request: {
  readonly config: RuntimeConfig;
  readonly method: string;
  readonly url: URL;
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
}) {
  const route = request.url.pathname;
  if (route !== '/api/attention/automatic-memory' && route !== '/api/attention/automatic-review') return undefined;
  if (request.method === 'GET') {
    const project = request.url.searchParams.get('project') ?? '';
    if (!isManagerProjectName(project)) return invalid();
    if (route === '/api/attention/automatic-memory') {
      const uri = request.url.searchParams.get('uri') ?? undefined;
      const afterUri = request.url.searchParams.get('afterUri') ?? undefined;
      if (
        [...request.url.searchParams.keys()].some(key => !['project', 'uri', 'afterUri'].includes(key)) ||
        [uri, afterUri].some(
          value => value !== undefined && (value.length > 4096 || !value.startsWith(`threadnote://user/`)),
        ) ||
        (uri !== undefined && afterUri !== undefined)
      )
        return invalid();
      return {status: 200, body: yield* automaticStatus(request.config, project, uri, afterUri)};
    }
    const reviewId = request.url.searchParams.get('reviewId') ?? '';
    if (
      !REVIEW.test(reviewId) ||
      [...request.url.searchParams.keys()].some(key => !['project', 'reviewId'].includes(key))
    )
      return invalid();
    const read = yield* readAutomaticReviewResponse(request.config, project, reviewId).pipe(Effect.result);
    return Result.isSuccess(read) && read.success ? {status: 200, body: read.success} : unavailable();
  }
  if (request.method !== 'POST' || route !== '/api/attention/automatic-review') return invalid();
  const body = yield* request.body;
  if (
    bytes(JSON.stringify(body)) > 1200 * 1024 ||
    typeof body.project !== 'string' ||
    !isManagerProjectName(body.project)
  )
    return invalid();
  const project = body.project;
  if (body.action === 'manual-preview' || body.action === 'generate') {
    const manual = body.action === 'manual-preview';
    if (
      !exactKeys(
        body,
        manual
          ? ['action', 'project', 'uri', 'expectedContentHash', 'desiredContent']
          : ['action', 'project', 'uri', 'expectedContentHash', 'backend', 'modelId'],
        manual ? ['reviewId', 'revision'] : [],
      ) ||
      typeof body.uri !== 'string' ||
      body.uri.length > 4096 ||
      typeof body.expectedContentHash !== 'string' ||
      !HASH.test(body.expectedContentHash)
    )
      return invalid();
    const target = yield* readContextMaintenanceCanonicalRecord(request.config, body.uri).pipe(Effect.result);
    if (
      Result.isFailure(target) ||
      projectOf(target.success.record) !== project ||
      maintenanceContentHash(target.success.record.content) !== body.expectedContentHash
    )
      return unavailable();
    let result: CandidateReview;
    if (manual) {
      if (
        typeof body.desiredContent !== 'string' ||
        bytes(body.desiredContent) > 1100 * 1024 ||
        (body.reviewId !== undefined &&
          (typeof body.reviewId !== 'string' || !REVIEW.test(body.reviewId) || !Number.isSafeInteger(body.revision)))
      )
        return invalid();
      const desired = parseMemoryDocument(body.uri, body.desiredContent);
      const original = target.success.record;
      if (!desired || normalizedHeader(body.desiredContent) !== normalizedHeader(original.content))
        return {
          status: 409,
          body: {
            error:
              'Support-aware edits preserve the original metadata. Edit the memory body, then preview again; the approval preview shows all resulting support metadata.',
          },
        };
      const created = yield* requestAutomaticMemoryReview(request.config, {
        uri: body.uri,
        expectedContentHash: body.expectedContentHash,
        desiredBody: desired.body,
        ...(body.reviewId !== undefined ? {reviewId: body.reviewId, revision: body.revision as number} : {}),
      }).pipe(Effect.result);
      if (Result.isFailure(created) || !('reviewId' in created.success))
        return {
          status: 409,
          body: {
            error:
              'An existing review or changed source blocks this edit. Open the current prepared update before editing its approved support.',
          },
        };
      const prepared = yield* prepareTopicMaintenanceReview(request.config, {
        reviewId: created.success.reviewId,
        revision: created.success.revision,
      }).pipe(Effect.result);
      if (Result.isFailure(prepared)) return unavailable();
      result = prepared.success;
    } else {
      if (
        (body.backend !== 'local-ai' && body.backend !== 'effect-ai') ||
        typeof body.modelId !== 'string' ||
        !body.modelId.trim() ||
        bytes(body.modelId) > 256 ||
        [...body.modelId].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      )
        return invalid();
      const generated = yield* requestAutomaticMemoryDraft(request.config, {
        uri: body.uri,
        expectedContentHash: body.expectedContentHash,
        backend: body.backend,
        modelId: body.modelId,
      }).pipe(Effect.result);
      if (Result.isFailure(generated))
        return {
          status: 409,
          body: {
            error:
              'Generation could not produce a bounded review. Check model setup and exact source coverage; an existing review must be resolved first.',
          },
        };
      result = generated.success;
    }
    const read = yield* readManagerAutomaticReview(request.config, project, result.reviewId).pipe(Effect.result);
    return Result.isSuccess(read) && read.success ? {status: 200, body: read.success} : unavailable();
  }
  const action = body.action;
  if (
    typeof action !== 'string' ||
    !['preview', 'apply', 'reject', 'defer', 'resume'].includes(action) ||
    !exactKeys(body, [
      'action',
      'project',
      'reviewId',
      'revision',
      ...(action === 'apply' ? ['approvalDigest', 'approved'] : []),
    ]) ||
    typeof body.reviewId !== 'string' ||
    !REVIEW.test(body.reviewId) ||
    typeof body.revision !== 'number' ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 1 ||
    (action === 'apply' &&
      (body.approved !== true || typeof body.approvalDigest !== 'string' || !HASH.test(body.approvalDigest)))
  )
    return invalid();
  const checked = yield* selectedAutomaticReview(request.config, project, body.reviewId).pipe(Effect.result);
  if (Result.isFailure(checked) || !checked.success || checked.success.revision !== body.revision) return unavailable();
  let approvalRevision = body.revision;
  if (action === 'apply') {
    const authorized = yield* readManagerAutomaticReview(request.config, project, body.reviewId).pipe(Effect.result);
    if (Result.isFailure(authorized) || !authorized.success || authorized.success.revision !== body.revision)
      return unavailable();
    if (
      action === 'apply' &&
      authorized.success.approval &&
      ['preview', 'prepared'].includes(authorized.success.approval.stage)
    )
      approvalRevision = authorized.success.approval.reviewRevision;
  }
  const selected = {reviewId: body.reviewId, revision: body.revision};
  const outcome =
    action === 'preview'
      ? yield* prepareTopicMaintenanceReview(request.config, selected).pipe(Effect.result)
      : action === 'apply'
        ? yield* applyTopicMaintenanceReview(request.config, {
            ...selected,
            revision: approvalRevision,
            approvalDigest: body.approvalDigest as string,
            approved: true,
          }).pipe(Effect.result)
        : yield* decideTopicMaintenanceReview(request.config, {
            ...selected,
            action: action as 'reject' | 'defer' | 'resume',
          }).pipe(Effect.result);
  if (Result.isFailure(outcome))
    return {
      status: 409,
      body: {
        error: Schema.is(TopicReviewError)(outcome.failure)
          ? outcome.failure.message
          : 'The exact review changed. Reload the target and preview again.',
      },
    };
  const acknowledgement = projectTopicReviewDecisionAcknowledgement(outcome.success, action);
  if (acknowledgement) return {status: 200, body: acknowledgement};
  const read = yield* readAutomaticReviewResponse(request.config, project, outcome.success.reviewId).pipe(
    Effect.result,
  );
  return Result.isSuccess(read) && read.success ? {status: 200, body: read.success} : unavailable();
});
