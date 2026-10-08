import {Cause, Clock, Crypto, DateTime, Effect, Exit, Fiber, Result, Schema, Scope} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';
import {errorMessage} from '@threadnote/platform/errors';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ManagerCitationRepairJobV1} from '@threadnote/manager/attention/contracts';
import {
  candidateReviewWithReplacementSafety,
  loadCandidateReview,
  saveCandidateReview,
  withCandidateReviewLock,
} from '@threadnote/memory/candidate';
import {canonicalMemoryDocumentContent} from '@threadnote/memory/document';
import {projectKnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import {runCloseoutApply} from '../memory/closeout.js';
import {
  applyContextHealthCitationRepairBatch,
  applyContextHealthRepair,
  previewContextHealthRepairs,
} from '../memory/context/health_repair_commands.js';
import {
  readContextMaintenanceStatus,
  readContextMaintenancePacket,
  runContextMaintenance,
  setContextMaintenancePaused,
  undoContextMaintenance,
} from '../memory/context/maintenance.js';
import {SystemInfo} from '@threadnote/platform/system';
import {readActiveProjectMemoryRecords} from '../memory/maintenance/records.js';
import {normalizeContextHealthSelector} from '../memory/context/health_selector.js';
import {readMemoryRecordsByUri} from '../mcp/server/memory.js';
import {managerAttentionProjectRoot} from './attention.js';
import {runManagerExplicitCwdGraphIndex} from './graph/actions.js';
import type {ContextHealthRepairProposalV1} from '../memory/context/health_repair.js';
import {previewSemanticReview, applySemanticReview} from '../memory/context/semantic_review.js';
import type {ManagerSemanticReviewInputV1} from '@threadnote/manager/attention/contracts';
import {SemanticReviewError} from '../memory/context/semantic_review_state.js';
import {ResourceConflict, ResourceNotFound} from '@threadnote/store/resource-store';

const CITATION_FINDING_CATEGORIES = ['citation-changed', 'citation-missing', 'citation-unknown'] as const;
const MAXIMUM_MANAGER_BULK_CITATION_REPAIRS = 100;
const MAXIMUM_BACKGROUND_CITATION_REPAIR_BATCHES = 25;
const MAXIMUM_BACKGROUND_CITATION_SCAN_RESTARTS = 3;
const STALE_CONTEXT_HEALTH_CURSOR_MESSAGE = 'Context-health continuation cursor is invalid or stale';

interface InternalManagerCitationRepairJob {
  fiber?: Fiber.Fiber<void>;
  job: ManagerCitationRepairJobV1;
}

interface ManagerCitationRepairJobRegistry {
  readonly jobs: Map<string, InternalManagerCitationRepairJob>;
  starting: boolean;
}

const CITATION_REPAIR_JOB_REGISTRIES = new WeakMap<object, ManagerCitationRepairJobRegistry>();

class ManagerCitationRepairJobError extends Schema.TaggedError<ManagerCitationRepairJobError>()(
  'ManagerCitationRepairJobError',
  {message: Schema.String},
) {}

/** Auth is enforced by the Manager router before these revision-bound adapters run. */
export const handleManagerAttentionAction = Effect.fn('managerAttention.action')(function* (request: {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly config: RuntimeConfig;
  readonly jobContext?: {readonly key: object; readonly scope: Scope.Scope};
  readonly method: string;
  readonly url: URL;
}) {
  const route = request.url.pathname;
  if (route === '/api/attention/context-maintenance') {
    if (request.method === 'GET') {
      const project = request.url.searchParams.get('project') ?? undefined;
      if (project !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(project))
        return invalid('Select a valid project.');
      const caseId = request.url.searchParams.get('caseId');
      if (caseId !== null && request.url.searchParams.get('view') !== 'status') {
        if (project !== undefined) yield* readContextMaintenanceStatus(request.config, project, {caseId});
        const startLine = request.url.searchParams.get('startLine');
        const maximumLines = request.url.searchParams.get('maximumLines');
        if (
          (startLine !== null && !/^[1-9][0-9]*$/u.test(startLine)) ||
          (maximumLines !== null && !/^(?:[1-9]|1[0-9]|2[0-4])$/u.test(maximumLines))
        )
          return invalid('Choose a positive source line and 1 to 24 excerpt lines.');
        return {
          status: 200,
          body: yield* readContextMaintenancePacket(request.config, caseId, {
            citationId: request.url.searchParams.get('citationId') ?? undefined,
            memoryUri: request.url.searchParams.get('memoryUri') ?? undefined,
            ...(startLine === null ? {} : {startLine: Number(startLine)}),
            ...(maximumLines === null ? {} : {maximumLines: Number(maximumLines)}),
          }),
        };
      }
      const limitText = request.url.searchParams.get('limit');
      if (limitText !== null && !/^(?:[1-9][0-9]?|100)$/u.test(limitText))
        return invalid('Choose a page limit from 1 to 100.');
      const status = yield* readContextMaintenanceStatus(request.config, project, {
        ...(limitText === null ? {} : {limit: Number(limitText)}),
        caseCursor: request.url.searchParams.get('caseCursor') ?? undefined,
        receiptCursor: request.url.searchParams.get('receiptCursor') ?? undefined,
        caseId: caseId ?? undefined,
        receiptId: request.url.searchParams.get('receiptId') ?? undefined,
      });
      return {status: 200, body: status};
    }
    if (request.method !== 'POST') return undefined;
    const body = yield* request.body;
    if (body.action === 'pause' || body.action === 'resume')
      return {status: 200, body: yield* setContextMaintenancePaused(request.config, body.action === 'pause')};
    if (body.action === 'undo' && typeof body.receiptId === 'string') {
      const result = yield* undoContextMaintenance(request.config, body.receiptId);
      return {status: result.status === 'conflict' ? 409 : 200, body: result};
    }
    if (body.action === 'run-now')
      return {
        status: 200,
        body: yield* runContextMaintenance(request.config, {
          cwd: (yield* SystemInfo).currentDirectory(),
          project: typeof body.project === 'string' ? body.project : undefined,
        }),
      };
    return invalid('Choose run-now, pause, resume, or undo with an exact receipt.');
  }
  if (route === '/api/context-health/citations/jobs' && request.method === 'GET') {
    const project = request.url.searchParams.get('project') ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(project)) return invalid('Select a valid project.');
    return {
      status: 200,
      body: {job: latestCitationRepairJob(citationRepairRegistry(request), project)?.job ?? null},
    };
  }
  if (
    ![
      '/api/reviews/preview',
      '/api/reviews/decide',
      '/api/reviews/refresh-safety',
      '/api/context-health/preview',
      '/api/context-health/apply',
      '/api/context-health/citations/preview',
      '/api/context-health/citations/apply',
      '/api/context-health/citations/rebuild',
      '/api/context-health/citations/jobs',
      '/api/context-health/semantic/preview',
      '/api/context-health/semantic/apply',
    ].includes(route) ||
    request.method !== 'POST'
  )
    return undefined;
  const body = yield* request.body;
  const project = typeof body.project === 'string' ? body.project : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(project)) return invalid('Select a valid project.');
  if (route === '/api/context-health/semantic/preview') {
    if (body.choice !== 'left' && body.choice !== 'right' && body.choice !== 'both')
      return invalid('Choose which memory to keep, or keep both.');
    if (typeof body.contradictionId !== 'string' || !/^[a-f0-9]{64}$/u.test(body.contradictionId))
      return invalid('Select an exact semantic comparison.');
    const sources = [body.left, body.right];
    if (
      !sources.every(
        value =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as Record<string, unknown>).recordUri === 'string' &&
          typeof (value as Record<string, unknown>).recordContentFingerprint === 'string',
      )
    )
      return invalid('Select both source revisions.');
    const result = yield* previewSemanticReview(request.config, {
      project,
      contradictionId: body.contradictionId,
      choice: body.choice,
      left: body.left as ManagerSemanticReviewInputV1['left'],
      right: body.right as ManagerSemanticReviewInputV1['right'],
    }).pipe(Effect.result);
    return Result.isSuccess(result)
      ? {status: 200, body: {preview: result.success}}
      : semanticReviewFailureResponse(result.failure);
  }
  if (route === '/api/context-health/semantic/apply') {
    if (body.approved !== true) return invalid('Explicit approval is required.');
    if (
      typeof body.previewId !== 'string' ||
      !/^semantic-review-[a-f0-9]{40}$/u.test(body.previewId) ||
      typeof body.revision !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(body.revision)
    )
      return invalid('Select an exact saved semantic preview.');
    const result = yield* applySemanticReview(request.config, {
      project,
      previewId: body.previewId,
      revision: body.revision,
      approved: true,
    }).pipe(Effect.result);
    return Result.isSuccess(result)
      ? {status: 200, body: {result: result.success}}
      : semanticReviewFailureResponse(result.failure);
  }
  if (route.startsWith('/api/reviews/')) {
    if (typeof body.reviewId !== 'string' || !/^review-[a-zA-Z0-9_-]+$/u.test(body.reviewId))
      return invalid('Invalid review identifier.');
    if (route.endsWith('/refresh-safety')) {
      if (typeof body.candidateId !== 'string') return invalid('Select a candidate from this review.');
      if (typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision))
        return invalid('Select an exact review revision.');
      const reviewId = body.reviewId;
      const candidateId = body.candidateId;
      const revision = body.revision;
      return yield* withCandidateReviewLock(
        request.config.agentContextHome,
        reviewId,
        Effect.gen(function* () {
          const loaded = yield* loadCandidateReview(request.config.agentContextHome, reviewId).pipe(Effect.result);
          if (Result.isFailure(loaded))
            return conflict('This review is no longer available. Refresh the review inbox.');
          const review = loaded.success;
          if (review.reviewId !== reviewId)
            return conflict('The stored review identity changed. Refresh the review inbox.');
          if (review.project !== project) return invalid('This review belongs to another project.');
          if (review.revision !== revision)
            return conflict('The review changed. Close and reopen it before refreshing replacement safety.');
          const candidate = review.candidates.find(item => item.candidateId === candidateId);
          if (!candidate) return invalid('Select a candidate from this review.');
          if (candidate.state !== 'pending')
            return conflict('This candidate is no longer pending. Refresh the review inbox.');
          if (
            candidate.comparison !== 'replacement' ||
            candidate.recommendation !== 'replace' ||
            candidate.targetUri === undefined
          ) {
            return conflict('This candidate is not a replacement with a current target.');
          }
          if (candidate.project !== project)
            return conflict('This candidate no longer belongs to the selected project.');
          const targetResult = yield* readMemoryRecordsByUri(request.config, [candidate.targetUri]).pipe(Effect.result);
          if (Result.isFailure(targetResult))
            return conflict('The replacement target could not be read. Repair its storage and try again.');
          const target = targetResult.success[0];
          if (!target)
            return conflict(
              'The replacement target no longer exists. You can create the reviewed proposal as the current memory instead.',
              'replacement-target-missing',
            );
          if (
            target.metadata.status !== 'active' ||
            target.metadata.kind !== candidate.kind ||
            target.metadata.topic !== candidate.topic ||
            (candidate.kind !== 'preference' && target.metadata.project !== project)
          ) {
            return conflict('The replacement target no longer matches this candidate. Start a new review.');
          }
          const targetContentHash = yield* sha256Hex(canonicalMemoryDocumentContent(target.content));
          const now = yield* Clock.currentTimeMillis;
          const refreshed = candidateReviewWithReplacementSafety(
            review,
            candidate.candidateId,
            target.body,
            targetContentHash,
            DateTime.formatIso(DateTime.makeUnsafe(now)),
          );
          if (!refreshed) return conflict('This candidate can no longer refresh replacement safety.');
          yield* saveCandidateReview(request.config.agentContextHome, refreshed);
          return {status: 200, body: {review: refreshed, delta: projectKnowledgeDeltaV1(refreshed)}};
        }),
      );
    }
    const loaded = yield* loadCandidateReview(request.config.agentContextHome, body.reviewId).pipe(Effect.result);
    if (Result.isFailure(loaded))
      return {status: 404, body: {error: 'This review is unavailable. Refresh the review inbox.'}};
    const review = loaded.success;
    if (review.project !== project) return invalid('This review belongs to another project.');
    if (route.endsWith('/preview')) return {status: 200, body: {review, delta: projectKnowledgeDeltaV1(review)}};
    if (typeof body.candidateId !== 'string' || !review.candidates.some(item => item.candidateId === body.candidateId))
      return invalid('Select a candidate from this review.');
    if (!Number.isSafeInteger(body.revision) || body.revision !== review.revision)
      return {status: 409, body: {error: 'The review changed. Close and reopen it before deciding.'}};
    if (body.action !== 'approve' && body.action !== 'defer' && body.action !== 'reject')
      return invalid('Choose approve, defer, or reject.');
    if (body.action === 'approve' && body.approved !== true) return invalid('Explicit approval is required.');
    // Reuse the application closeout entrypoint: it owns locking, target hashes, recovery, and revision checks.
    const result = yield* runCloseoutApply(request.config, {
      action: body.action,
      approved: body.approved === true,
      candidateId: body.candidateId,
      reviewId: review.reviewId,
      revision: review.revision,
      allowDestructiveReplacement: body.allowDestructiveReplacement === true,
      allowMissingReplacementCreate: body.allowMissingReplacementCreate === true,
      ...(body.operation === 'create' || body.operation === 'replace'
        ? {
            operation: body.operation,
            ...(body.operation === 'replace'
              ? {replaceUri: review.candidates.find(item => item.candidateId === body.candidateId)?.targetUri}
              : {}),
          }
        : {}),
    });
    const message = result.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n');
    if ('isError' in result && result.isError) return {status: 409, body: {error: message}};
    return {status: 200, body: {message, result: result.structuredContent}};
  }
  const root = yield* managerAttentionProjectRoot(request.config, project);
  if (root.state === 'unavailable') {
    return {
      status: 409,
      body: {
        error: 'Repository evidence is unavailable for this project. Repairs require a configured local checkout.',
      },
    };
  }
  const cwd = root.cwd;
  if (route === '/api/context-health/citations/jobs') {
    return yield* startBackgroundCitationRepair(request, project, cwd);
  }
  if (route === '/api/context-health/citations/rebuild') {
    const result = yield* runManagerExplicitCwdGraphIndex(request.config, {cwd, full: true});
    return {status: 200, body: {output: result.output}};
  }
  if (route === '/api/context-health/citations/preview') {
    if (body.findingCategory !== undefined) {
      if (
        typeof body.findingCategory !== 'string' ||
        !CITATION_FINDING_CATEGORIES.some(category => category === body.findingCategory)
      ) {
        return invalid('Select a citation finding category.');
      }
      const findingCategory = body.findingCategory as (typeof CITATION_FINDING_CATEGORIES)[number];
      const after = typeof body.after === 'string' ? body.after : undefined;
      const plan = yield* previewContextHealthRepairs(request.config, project, cwd, {
        findingCategory,
        ...(after === undefined ? {} : {after}),
      });
      return {
        status: 200,
        body: citationRepairPreviewBody(project, plan.proposals, false, plan.nextCursor),
      };
    }
    const collected = yield* collectCitationRepairProposals(request.config, project, cwd);
    const records = yield* readActiveProjectMemoryRecords(request.config, project);
    return {
      status: 200,
      body: citationRepairPreviewBody(project, collected.proposals, collected.enumerationTruncated, undefined, records),
    };
  }
  if (route === '/api/context-health/citations/apply') {
    if (body.approved !== true || !Array.isArray(body.items)) {
      return invalid('Bulk citation repair requires explicit approval of the previewed items.');
    }
    const items = parseBulkCitationRepairItems(body.items);
    if (items === undefined) return invalid('Bulk citation repair items are invalid or exceed the limit.');
    const collected = yield* collectCitationRepairProposals(request.config, project, cwd);
    const currentByFindingId = new Map(collected.proposals.map(proposal => [proposal.findingId, proposal] as const));
    const matched: ContextHealthRepairProposalV1[] = [];
    const results: Array<{readonly findingId: string; readonly status: string; readonly error?: string}> = [];
    for (const item of items) {
      const current = currentByFindingId.get(item.findingId);
      if (
        current === undefined ||
        current.category !== item.category ||
        current.mutation.kind !== 'replace-citation' ||
        current.mutation.subjectUri !== item.subjectUri ||
        current.mutation.citationId !== item.citationId ||
        current.mutation.replacement.id !== item.replacementId ||
        current.proposalId !== item.proposalId ||
        current.revision !== item.revision
      ) {
        results.push({
          error: 'The citation evidence changed or is no longer repairable. Rebuild or preview again.',
          findingId: item.findingId,
          status: 'conflict',
        });
        continue;
      }
      matched.push(current);
    }
    if (matched.length > 0) {
      results.push(...(yield* applyContextHealthCitationRepairBatch(request.config, {project, proposals: matched})));
    }
    return {
      status: 200,
      body: {
        appliedCount: results.filter(result => result.status === 'applied' || result.status === 'already-applied')
          .length,
        failedCount: results.filter(result => result.status === 'conflict').length,
        project,
        results,
        version: 1,
      },
    };
  }
  const findingCategory = typeof body.findingCategory === 'string' ? body.findingCategory : undefined;
  const after = typeof body.after === 'string' ? body.after : undefined;
  const selector = yield* Effect.try(() =>
    normalizeContextHealthSelector({
      findingCategory,
      after,
      ...(typeof body.topic === 'string' ? {topic: body.topic} : {}),
      ...(typeof body.kind === 'string' ? {kind: body.kind} : {}),
    }),
  ).pipe(Effect.result);
  if (Result.isFailure(selector)) return invalid('Invalid context-health scope. Refresh and select a finding again.');
  if (route.endsWith('/preview')) {
    if (typeof body.findingId !== 'string') return invalid('Select a health finding.');
    const records = yield* readActiveProjectMemoryRecords(request.config, project);
    const subject = records.find(record => record.uri === body.subjectUri);
    const scope = {findingCategory, ...(subject ? {topic: subject.metadata.topic, kind: subject.metadata.kind} : {})};
    let plan = yield* previewContextHealthRepairs(request.config, project, cwd, {...scope, after});
    let proposal = plan.proposals.find(item => item.findingId === body.findingId);
    // A single long memory may produce more than one page of citations or relations.
    for (let page = 1; !proposal && plan.nextCursor && page < 20; page += 1) {
      plan = yield* previewContextHealthRepairs(request.config, project, cwd, {...scope, after: plan.nextCursor});
      proposal = plan.proposals.find(item => item.findingId === body.findingId);
    }
    if (!proposal)
      return {
        status: 409,
        body: {error: 'This finding changed or is outside this page. Refresh context health and review it again.'},
      };
    return {status: 200, body: {proposal}};
  }
  if (
    body.approved !== true ||
    typeof body.proposalId !== 'string' ||
    !/^health-repair-[0-9a-f]{40}$/u.test(body.proposalId) ||
    typeof body.revision !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(body.revision)
  )
    return invalid('Apply requires explicit approval of an exact preview revision.');
  const result = yield* applyContextHealthRepair(request.config, {
    approved: true,
    cwd,
    project,
    proposalId: body.proposalId,
    revision: body.revision,
    findingCategory,
    after,
    ...(typeof body.topic === 'string' ? {topic: body.topic} : {}),
    ...(typeof body.kind === 'string' ? {kind: body.kind} : {}),
  });
  return {
    status: result.status === 'conflict' ? 409 : 200,
    body: result.status === 'conflict' ? {error: result.conflict.message} : result,
  };
});

function startBackgroundCitationRepair(
  request: {
    readonly config: RuntimeConfig;
    readonly jobContext?: {readonly key: object; readonly scope: Scope.Scope};
  },
  project: string,
  cwd: string,
) {
  return Effect.gen(function* () {
    const registry = citationRepairRegistry(request);
    const active = [...registry.jobs.values()].find(entry => entry.job.status === 'running');
    if (active !== undefined) {
      return active.job.project === project
        ? {status: 202, body: {job: active.job}}
        : conflict(`Citation repair is already running for ${active.job.project}.`);
    }
    if (registry.starting) return conflict('Citation repair is already starting.');
    registry.starting = true;
    return yield* Effect.gen(function* () {
      trimCitationRepairJobs(registry);
      const crypto = yield* Crypto.Crypto;
      const createdAt = managerTimestamp(yield* Clock.currentTimeMillis);
      const id = `mcrj_${(yield* crypto.randomUUIDv4).replaceAll('-', '')}`;
      const entry: InternalManagerCitationRepairJob = {
        job: {
          createdAt,
          id,
          progress: {
            batch: 0,
            failedCount: 0,
            message: 'Starting the background citation repair.',
            pagesScanned: 0,
            phase: 'starting',
            repairableCount: 0,
            repairedCount: 0,
            unresolvedCount: 0,
          },
          project,
          status: 'running',
        },
      };
      registry.jobs.set(id, entry);
      const worker = runBackgroundCitationRepair(entry, request.config, project, cwd).pipe(
        Effect.matchCauseEffect({
          onFailure: cause => finishBackgroundCitationRepairFailure(entry, cause),
          onSuccess: outcome => finishBackgroundCitationRepair(entry, outcome),
        }),
      );
      const scope = request.jobContext?.scope ?? (yield* Scope.make());
      entry.fiber = yield* worker.pipe(Effect.forkIn(scope));
      return {status: 202, body: {job: entry.job}};
    }).pipe(Effect.ensuring(Effect.sync(() => (registry.starting = false))));
  });
}

interface BackgroundCitationRepairOutcome {
  readonly initialCitationCount: number;
  readonly unresolvedCount: number;
  readonly warning?: string;
}

const runBackgroundCitationRepair = Effect.fn('managerAttention.runBackgroundCitationRepair')(function* (
  entry: InternalManagerCitationRepairJob,
  config: RuntimeConfig,
  project: string,
  cwd: string,
) {
  let failedCount = 0;
  let initialCitationCount: number | undefined;
  let pagesScanned = 0;
  let repairedCount = 0;
  updateCitationRepairJob(entry, {
    batch: 0,
    failedCount,
    message: 'Preparing current project graph evidence before scanning memories.',
    pagesScanned,
    phase: 'rebuilding',
    repairableCount: 0,
    repairedCount,
    unresolvedCount: 0,
  });
  // Citation capture rejects stale snapshots, but a long paginated scan can
  // outlive the exact snapshot it started from. Establish current evidence
  // before scanning, then bind each write batch to that snapshot below.
  yield* runManagerExplicitCwdGraphIndex(config, {cwd, full: false});
  for (let batch = 1; batch <= MAXIMUM_BACKGROUND_CITATION_REPAIR_BATCHES; batch += 1) {
    const scan = yield* scanBackgroundCitationRepairs(entry, config, project, cwd, {
      batch,
      failedCount,
      ...(initialCitationCount === undefined ? {} : {initialCitationCount}),
      pagesScanned,
      repairedCount,
    });
    initialCitationCount ??= scan.proposals.length;
    pagesScanned = scan.pagesScanned;
    const repairable = uniqueCitationReplacementProposals(scan.proposals);
    if (repairable.length === 0) {
      return {
        initialCitationCount,
        unresolvedCount: scan.unresolvedCount,
        ...(scan.unresolvedCount === 0
          ? {}
          : {
              warning: `${scan.unresolvedCount.toLocaleString()} citation issue${scan.unresolvedCount === 1 ? '' : 's'} still need current graph evidence or manual review. If project source changed while this ran, start repair again after the source is stable.`,
            }),
      };
    }
    const recordCount = new Set(repairable.map(proposal => proposal.mutation.subjectUri)).size;
    updateCitationRepairJob(entry, {
      batch,
      failedCount,
      initialCitationCount,
      message: `Confirming project source is unchanged before applying ${repairable.length.toLocaleString()} citation repair${repairable.length === 1 ? '' : 's'}.`,
      pagesScanned: scan.pagesScanned,
      phase: 'rebuilding',
      repairableCount: repairable.length,
      repairedCount,
      unresolvedCount: scan.unresolvedCount,
    });
    const currentGraph = yield* runManagerExplicitCwdGraphIndex(config, {cwd, full: false});
    const capturedSnapshotIds = new Set(
      repairable.flatMap(proposal =>
        typeof proposal.mutation.replacement.sourceSnapshotId === 'string'
          ? [proposal.mutation.replacement.sourceSnapshotId]
          : [],
      ),
    );
    if (
      'snapshot' in currentGraph &&
      currentGraph.snapshot !== undefined &&
      capturedSnapshotIds.size > 0 &&
      (capturedSnapshotIds.size !== 1 || !capturedSnapshotIds.has(currentGraph.snapshot.id))
    ) {
      updateCitationRepairJob(entry, {
        batch,
        failedCount,
        initialCitationCount,
        message: 'Project source changed during the scan. Refreshing evidence before any memory is changed.',
        pagesScanned: scan.pagesScanned,
        phase: 'rebuilding',
        repairableCount: 0,
        repairedCount,
        unresolvedCount: scan.unresolvedCount + repairable.length,
      });
      continue;
    }
    updateCitationRepairJob(entry, {
      batch,
      failedCount,
      initialCitationCount,
      message: `Applying ${repairable.length.toLocaleString()} citation repair${repairable.length === 1 ? '' : 's'} across ${recordCount.toLocaleString()} memor${recordCount === 1 ? 'y' : 'ies'}.`,
      pagesScanned: scan.pagesScanned,
      phase: 'applying',
      repairableCount: repairable.length,
      repairedCount,
      unresolvedCount: scan.unresolvedCount,
    });
    const results = yield* applyContextHealthCitationRepairBatch(config, {project, proposals: repairable});
    const appliedThisBatch = results.filter(result => result.status === 'applied').length;
    failedCount += results.length - appliedThisBatch;
    repairedCount += appliedThisBatch;
    if (appliedThisBatch === 0) {
      return {
        initialCitationCount,
        unresolvedCount: scan.unresolvedCount + repairable.length,
        warning: 'The remaining citations changed while the worker was running. Review them before retrying.',
      };
    }
  }
  return yield* ManagerCitationRepairJobError.make({
    message: `Citation repair did not converge after ${MAXIMUM_BACKGROUND_CITATION_REPAIR_BATCHES.toLocaleString()} batches.`,
  });
});

const scanBackgroundCitationRepairs = Effect.fn('managerAttention.scanBackgroundCitationRepairs')(function* (
  entry: InternalManagerCitationRepairJob,
  config: RuntimeConfig,
  project: string,
  cwd: string,
  current: {
    readonly batch: number;
    readonly failedCount: number;
    readonly initialCitationCount?: number;
    readonly pagesScanned: number;
    readonly repairedCount: number;
  },
) {
  let pagesScanned = current.pagesScanned;
  for (let restartCount = 0; ; restartCount += 1) {
    const proposals: ContextHealthRepairProposalV1[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;
    let batchPagesScanned = 0;
    let restart = false;
    let unresolvedCount = 0;
    do {
      updateCitationRepairJob(entry, {
        batch: current.batch,
        failedCount: current.failedCount,
        ...(current.initialCitationCount === undefined ? {} : {initialCitationCount: current.initialCitationCount}),
        message:
          batchPagesScanned === 0
            ? `Scanning every citation issue for ${project}.`
            : `Scanning citation page ${(batchPagesScanned + 1).toLocaleString()} of batch ${current.batch.toLocaleString()}; ${proposals.length.toLocaleString()} issues checked in this batch.`,
        pagesScanned,
        phase: 'scanning',
        repairableCount: uniqueCitationReplacementProposals(proposals).length,
        repairedCount: current.repairedCount,
        unresolvedCount,
      });
      const planExit = yield* previewContextHealthRepairs(config, project, cwd, {
        ...(after === undefined ? {} : {after}),
        findingCategories: CITATION_FINDING_CATEGORIES,
        limit: 500,
      }).pipe(Effect.exit);
      if (Exit.isFailure(planExit)) {
        if (
          after !== undefined &&
          errorMessage(Cause.squash(planExit.cause)).includes(STALE_CONTEXT_HEALTH_CURSOR_MESSAGE) &&
          restartCount < MAXIMUM_BACKGROUND_CITATION_SCAN_RESTARTS
        ) {
          updateCitationRepairJob(entry, {
            batch: current.batch,
            failedCount: current.failedCount,
            ...(current.initialCitationCount === undefined ? {} : {initialCitationCount: current.initialCitationCount}),
            message: `Context health changed during scanning. Restarting batch ${current.batch.toLocaleString()} from the first page (${(restartCount + 1).toLocaleString()}/${MAXIMUM_BACKGROUND_CITATION_SCAN_RESTARTS.toLocaleString()}).`,
            pagesScanned,
            phase: 'scanning',
            repairableCount: 0,
            repairedCount: current.repairedCount,
            unresolvedCount: 0,
          });
          restart = true;
          break;
        }
        return yield* Effect.failCause(planExit.cause);
      }
      const plan = planExit.value;
      proposals.push(...plan.proposals);
      batchPagesScanned += 1;
      pagesScanned += 1;
      unresolvedCount = proposals.filter(
        proposal => proposal.mutation.kind === 'review-only' && proposal.mutation.repairKind === 'repair-citation',
      ).length;
      updateCitationRepairJob(entry, {
        batch: current.batch,
        failedCount: current.failedCount,
        ...(current.initialCitationCount === undefined ? {} : {initialCitationCount: current.initialCitationCount}),
        message: `Scanned ${proposals.length.toLocaleString()} citation issue${proposals.length === 1 ? '' : 's'} across ${batchPagesScanned.toLocaleString()} page${batchPagesScanned === 1 ? '' : 's'} in batch ${current.batch.toLocaleString()}.`,
        pagesScanned,
        phase: 'scanning',
        repairableCount: uniqueCitationReplacementProposals(proposals).length,
        repairedCount: current.repairedCount,
        unresolvedCount,
      });
      if (plan.nextCursor === undefined) break;
      if (seenCursors.has(plan.nextCursor))
        return yield* ManagerCitationRepairJobError.make({message: 'Citation scan returned a repeated cursor.'});
      seenCursors.add(plan.nextCursor);
      after = plan.nextCursor;
    } while (after !== undefined);
    if (restart) continue;
    return {pagesScanned, proposals, unresolvedCount};
  }
});

type CitationReplacementProposal = ContextHealthRepairProposalV1 & {
  readonly mutation: Extract<ContextHealthRepairProposalV1['mutation'], {readonly kind: 'replace-citation'}>;
};

function uniqueCitationReplacementProposals(
  proposals: readonly ContextHealthRepairProposalV1[],
): readonly CitationReplacementProposal[] {
  const unique = new Map<string, CitationReplacementProposal>();
  for (const proposal of proposals) {
    if (proposal.mutation.kind === 'replace-citation')
      unique.set(proposal.proposalId, proposal as CitationReplacementProposal);
  }
  return [...unique.values()];
}

function finishBackgroundCitationRepair(
  entry: InternalManagerCitationRepairJob,
  outcome: BackgroundCitationRepairOutcome,
) {
  return Clock.currentTimeMillis.pipe(
    Effect.tap(now =>
      Effect.sync(() => {
        const clearedCount = Math.max(0, outcome.initialCitationCount - outcome.unresolvedCount);
        entry.job = {
          ...entry.job,
          finishedAt: managerTimestamp(now),
          progress: {
            ...entry.job.progress,
            message:
              outcome.unresolvedCount === 0
                ? `Cleared ${clearedCount.toLocaleString()} citation issue${clearedCount === 1 ? '' : 's'} after ${entry.job.progress.repairedCount.toLocaleString()} citation update${entry.job.progress.repairedCount === 1 ? '' : 's'}; none remain.`
                : `Cleared ${clearedCount.toLocaleString()} citation issue${clearedCount === 1 ? '' : 's'} after ${entry.job.progress.repairedCount.toLocaleString()} citation update${entry.job.progress.repairedCount === 1 ? '' : 's'}; ${outcome.unresolvedCount.toLocaleString()} remain.`,
            initialCitationCount: outcome.initialCitationCount,
            phase: 'completed',
            unresolvedCount: outcome.unresolvedCount,
          },
          status: 'completed',
          warning: outcome.warning,
        };
      }),
    ),
    Effect.asVoid,
  );
}

function finishBackgroundCitationRepairFailure(entry: InternalManagerCitationRepairJob, cause: Cause.Cause<unknown>) {
  return Clock.currentTimeMillis.pipe(
    Effect.tap(now =>
      Effect.sync(() => {
        const failure = errorMessage(Cause.squash(cause));
        entry.job = {
          ...entry.job,
          error: failure,
          finishedAt: managerTimestamp(now),
          progress: {
            ...entry.job.progress,
            message: 'Background citation repair stopped before the backlog was complete.',
            phase: 'failed',
          },
          status: 'failed',
        };
      }),
    ),
    Effect.asVoid,
  );
}

function updateCitationRepairJob(
  entry: InternalManagerCitationRepairJob,
  progress: ManagerCitationRepairJobV1['progress'],
): void {
  entry.job = {...entry.job, progress};
}

function citationRepairRegistry(request: {
  readonly config: RuntimeConfig;
  readonly jobContext?: {readonly key: object};
}) {
  const key = request.jobContext?.key ?? request.config;
  const current = CITATION_REPAIR_JOB_REGISTRIES.get(key);
  if (current !== undefined) return current;
  const created: ManagerCitationRepairJobRegistry = {jobs: new Map(), starting: false};
  CITATION_REPAIR_JOB_REGISTRIES.set(key, created);
  return created;
}

function latestCitationRepairJob(registry: ManagerCitationRepairJobRegistry, project: string) {
  return [...registry.jobs.values()]
    .filter(entry => entry.job.project === project)
    .sort((left, right) => right.job.createdAt.localeCompare(left.job.createdAt))[0];
}

function trimCitationRepairJobs(registry: ManagerCitationRepairJobRegistry): void {
  const finished = [...registry.jobs.values()]
    .filter(entry => entry.job.status !== 'running')
    .sort((left, right) => left.job.createdAt.localeCompare(right.job.createdAt));
  while (registry.jobs.size >= 16 && finished.length > 0) registry.jobs.delete(finished.shift()!.job.id);
}

function managerTimestamp(epochMilliseconds: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(epochMilliseconds));
}

function invalid(error: string) {
  return {status: 400, body: {error}};
}

export function semanticReviewFailureResponse(error: unknown) {
  if (Schema.is(SemanticReviewError)(error)) {
    return error.reason === 'stale'
      ? conflict('A source memory or the saved preview changed. Reopen the comparison and review your choice again.')
      : {
          status: 422,
          body: {
            error:
              "This decision couldn't be completed safely. Check the source memories and review storage before retrying; preserve existing history.",
          },
        };
  }
  if (Schema.is(ResourceConflict)(error) || Schema.is(ResourceNotFound)(error))
    return conflict('A source memory changed while confirming your choice. Reopen the comparison and review it again.');
  return {
    status: 503,
    body: {
      error:
        "Couldn't confirm completion. Reopen the comparison to check the source memories and preserved history before retrying.",
    },
  };
}

function conflict(error: string, code?: string) {
  return {status: 409, body: {error, ...(code === undefined ? {} : {code})}};
}

function citationRepairPreviewBody(
  project: string,
  proposals: readonly ContextHealthRepairProposalV1[],
  enumerationTruncated: boolean,
  nextCursor?: string,
  records: readonly import('@threadnote/memory/document').MemoryRecord[] = [],
) {
  const recordsByUri = new Map(records.map(record => [record.uri, record] as const));
  const allRepairable = proposals.filter(
    (
      proposal,
    ): proposal is ContextHealthRepairProposalV1 & {
      readonly mutation: Extract<ContextHealthRepairProposalV1['mutation'], {readonly kind: 'replace-citation'}>;
    } => proposal.mutation.kind === 'replace-citation',
  );
  const repairable = allRepairable.slice(0, MAXIMUM_MANAGER_BULK_CITATION_REPAIRS);
  return {
    items: repairable.map(proposal => {
      const record = recordsByUri.get(proposal.mutation.subjectUri);
      return {
        category: proposal.category,
        citationId: proposal.mutation.citationId,
        findingId: proposal.findingId,
        path: proposal.mutation.replacement.path,
        proposalId: proposal.proposalId,
        replacementId: proposal.mutation.replacement.id,
        revision: proposal.revision,
        sourceCommit: proposal.mutation.replacement.sourceCommit,
        ...(record === undefined
          ? {}
          : {
              subjectExcerpt: managerMemoryExcerpt(record.body),
              subjectTitle: managerMemoryTitle(record),
            }),
        subjectUri: proposal.mutation.subjectUri,
        targetKind: proposal.mutation.replacement.target.kind,
      };
    }),
    ...(nextCursor === undefined ? {} : {nextCursor}),
    project,
    repairableCount: repairable.length,
    requiresGraphCount: proposals.filter(
      proposal => proposal.mutation.kind === 'review-only' && proposal.mutation.repairKind === 'repair-citation',
    ).length,
    truncated: enumerationTruncated || repairable.length < allRepairable.length,
    version: 1 as const,
  };
}

function managerMemoryTitle(record: import('@threadnote/memory/document').MemoryRecord): string {
  const heading = record.body.split(/\r?\n/u).find(line => /^#{1,6}\s+\S/u.test(line));
  return (
    heading?.replace(/^#{1,6}\s+/u, '').trim() ??
    record.metadata.topic ??
    record.uri
      .slice(record.uri.lastIndexOf('/') + 1)
      .replace(/\.md$/u, '')
      .replaceAll('-', ' ')
  );
}

function managerMemoryExcerpt(body: string): string {
  const plain = body
    .replace(/^#{1,6}\s+.*$/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return plain.length > 220 ? `${plain.slice(0, 217).trimEnd()}…` : plain;
}

const collectCitationRepairProposals = Effect.fn('managerAttention.collectCitationRepairs')(function* (
  config: RuntimeConfig,
  project: string,
  cwd: string,
) {
  const plan = yield* previewContextHealthRepairs(config, project, cwd, {
    findingCategories: CITATION_FINDING_CATEGORIES,
    limit: 500,
  });
  return {
    enumerationTruncated: plan.nextCursor !== undefined || plan.omittedProposals > 0 || plan.sourceOmittedFindings > 0,
    proposals: plan.proposals,
  };
});

function parseBulkCitationRepairItems(values: readonly unknown[]) {
  if (values.length === 0 || values.length > MAXIMUM_MANAGER_BULK_CITATION_REPAIRS) return undefined;
  const parsed: Array<{
    readonly category: (typeof CITATION_FINDING_CATEGORIES)[number];
    readonly citationId: string;
    readonly findingId: string;
    readonly proposalId: string;
    readonly replacementId: string;
    readonly revision: string;
    readonly subjectUri: string;
  }> = [];
  for (const value of values) {
    if (typeof value !== 'object' || value === null) return undefined;
    const item = value as Record<string, unknown>;
    if (
      !CITATION_FINDING_CATEGORIES.some(category => category === item.category) ||
      typeof item.findingId !== 'string' ||
      item.findingId.length === 0 ||
      typeof item.proposalId !== 'string' ||
      !/^health-repair-[0-9a-f]{40}$/u.test(item.proposalId) ||
      typeof item.revision !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(item.revision) ||
      typeof item.subjectUri !== 'string' ||
      !item.subjectUri.startsWith('threadnote://') ||
      typeof item.citationId !== 'string' ||
      !/^tncc_[0-9a-f]{40}$/u.test(item.citationId) ||
      typeof item.replacementId !== 'string' ||
      !/^tncc_[0-9a-f]{40}$/u.test(item.replacementId)
    ) {
      return undefined;
    }
    parsed.push({
      category: item.category as (typeof CITATION_FINDING_CATEGORIES)[number],
      citationId: item.citationId,
      findingId: item.findingId,
      proposalId: item.proposalId,
      replacementId: item.replacementId,
      revision: item.revision,
      subjectUri: item.subjectUri,
    });
  }
  return parsed;
}
