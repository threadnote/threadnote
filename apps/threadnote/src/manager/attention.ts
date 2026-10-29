import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {isManagerProjectName} from './project/name.js';
import {CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION} from '@threadnote/context/health_semantic';
import {Effect, Result} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import {listCandidateReviews} from '@threadnote/memory/candidate';
import type {MemoryRecord} from '@threadnote/memory/document';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {expandPath} from '@threadnote/platform/paths';
import type {
  ManagerContextHealthCodePreviewV1,
  ManagerContextHealthRecordPreviewV1,
  ManagerContextHealthResponseV1,
  ManagerRepositoryEvidenceUnavailableReasonV1,
  ManagerReviewInboxResponseV1,
} from '@threadnote/manager/attention/contracts';
import {readMaintenanceMemoryRecords} from '../memory/maintenance/records.js';
import {collectContextHealth} from '../memory/context/health_commands.js';
import {normalizeContextHealthSelector} from '../memory/context/health_selector.js';
import {SystemInfo} from '@threadnote/platform/system';
import {managerProjectPathIsForeign} from './project/roots.js';
import {maintenanceContentHash} from '../memory/context/maintenance_policy.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';
import {readManagerReviewEligibility} from './review_actionability.js';

type ManagerAttentionResponse =
  | {readonly body: ManagerContextHealthResponseV1 | ManagerReviewInboxResponseV1; readonly status: 200}
  | {readonly body: {readonly code: 'invalid-project' | 'invalid-view'; readonly error: string}; readonly status: 400};

export const handleManagerAttentionRequest = Effect.fn('managerAttention.handleRequest')(function* (request: {
  readonly config: RuntimeConfig;
  readonly method: string;
  readonly url: URL;
}) {
  if (request.method !== 'GET') return undefined;
  if (request.url.pathname !== '/api/reviews' && request.url.pathname !== '/api/context-health') return undefined;
  const project =
    Effect2.pipe(request.url.searchParams.get('project'), effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) ?? '';
  if ((!project && request.url.pathname !== '/api/reviews') || (project && !isManagerProjectName(project))) {
    return {
      body: {code: 'invalid-project', error: 'Select a valid project to inspect its attention queue.'},
      status: 400,
    } satisfies ManagerAttentionResponse;
  }

  if (request.url.pathname === '/api/reviews') {
    const view = request.url.searchParams.get('view');
    if (view !== null && !['pending', 'deferred', 'history'].includes(view)) {
      return {
        body: {code: 'invalid-view', error: 'Select Pending, Deferred, or History.'},
        status: 400,
      } satisfies ManagerAttentionResponse;
    }
    const reviews = EffectArray.filter(
      yield* listCandidateReviews(request.config.agentContextHome),
      review => (!project || review.project === project) && !(review.maintenanceCapture && !review.maintenance),
    );
    const eligibility = yield* readManagerReviewEligibility(request.config, reviews);
    const {pendingCount, background} = eligibility;
    const visibleReviews = EffectArray.filter(reviews, review => {
      const queue = eligibility.byReview.get(review.reviewId);
      if (queue === 'assessment' || queue === 'obsolete') return view === 'history';
      if (queue === 'waiting') return false;
      return EffectArray.some(review.candidates, candidate =>
        view === 'history'
          ? !isPending(candidate.state)
          : view === 'deferred'
            ? candidate.state === 'deferred'
            : view === 'pending'
              ? candidate.state === 'pending' || candidate.state === 'applying'
              : isPending(candidate.state),
      );
    });
    // Typed review cards display metadata only. Opening the exact review owns live authorization and source proof.
    const items = EffectArray.filter(
      EffectArray.map(visibleReviews, review => {
        const metadataOnly = review.maintenance?.version === 2 || review.maintenance?.version === 3;
        const queueStatus = eligibility.byReview.get(review.reviewId);
        return {
          ...(queueStatus === 'assessment' || queueStatus === 'obsolete' ? {queueStatus} : {}),
          ...(review.maintenance
            ? {kind: review.maintenance.version === 3 ? ('automatic-memory' as const) : ('topic-maintenance' as const)}
            : {}),
          candidates: EffectArray.map(
            EffectArray.filter(
              review.candidates,
              (candidate, index) =>
                index in review.candidates &&
                (view === 'history'
                  ? ['assessment', 'obsolete'].includes(eligibility.byReview.get(review.reviewId) ?? '') ||
                    !isPending(candidate.state)
                  : view === 'deferred'
                    ? candidate.state === 'deferred'
                    : view === 'pending'
                      ? candidate.state === 'pending' || candidate.state === 'applying'
                      : isPending(candidate.state)),
            ),
            candidate => ({
              candidateId: candidate.candidateId,
              categories: candidate.categories,
              comparison: candidate.comparison,
              confidence: candidate.confidence,
              proposedText: metadataOnly ? '' : candidate.proposedText,
              reason: metadataOnly ? 'Open the exact review to check current source access.' : candidate.reason,
              recommendation: candidate.recommendation,
              state: candidate.state,
              ...(metadataOnly || candidate.targetUri === undefined ? {} : {targetUri: candidate.targetUri}),
            }),
          ),
          createdAt: review.createdAt,
          project: review.project,
          reviewId: review.reviewId,
          revision: review.revision,
          task:
            eligibility.byReview.get(review.reviewId) === 'assessment'
              ? 'Background memory assessment'
              : eligibility.byReview.get(review.reviewId) === 'obsolete'
                ? 'Previous generated memory review'
                : metadataOnly
                  ? 'Prepared memory update'
                  : review.task,
          topic: metadataOnly ? 'Private topic update' : review.topic,
        };
      }),
      review => review.candidates.length > 0,
    ).sort(
      (left, right) =>
        Effect2.pipe(right.createdAt, EffectString.localeCompare(left.createdAt)) ||
        Effect2.pipe(left.reviewId, EffectString.localeCompare(right.reviewId)),
    );
    return {
      body: {
        items,
        ...(background.assessments || background.awaitingSources || background.obsolete ? {background} : {}),
        pendingCount,
        project,
        version: 1,
      },
      status: 200,
    } satisfies ManagerAttentionResponse;
  }

  const selector = normalizeContextHealthSelector({after: request.url.searchParams.get('after') ?? undefined});
  const corpus = yield* readMaintenanceMemoryRecords(request.config);
  const records = EffectArray.filter(
    corpus,
    record => record.metadata.status === 'active' && record.metadata.project === project,
  );
  const root = yield* managerAttentionProjectRoot(request.config, project);
  if (root.state === 'unavailable') {
    return {
      body: unavailableContextHealth(project, records, root.reason),
      status: 200,
    } satisfies ManagerAttentionResponse;
  }
  const report = yield* collectContextHealth(request.config, project, records, root.cwd, {
    after: selector?.after,
    duplicateCorpus: records,
    relationCorpus: corpus,
    liveObservation: selector?.after === undefined,
  });
  return {
    body: {
      ...report,
      recordPreviews: yield* managerContextHealthRecordPreviews(records, report.findings),
      repositoryEvidence: {state: 'available'},
    },
    status: 200,
  } satisfies ManagerAttentionResponse;
});

/** Resolve health evidence from the selected project rather than Manager's launch directory. */
export const managerAttentionProjectRoot = Effect.fn('managerAttention.projectRoot')(function* (
  config: RuntimeConfig,
  projectName: string,
) {
  const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.result);
  if (Result.isFailure(manifest)) return unavailableRoot('manifest-unavailable');
  const project = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      manifest.success.projects,
      candidate =>
        Effect2.pipe(candidate.name, EffectString.toLowerCase) === Effect2.pipe(projectName, EffectString.toLowerCase),
    ),
  );
  if (project === undefined) return unavailableRoot('project-not-configured');
  const system = yield* SystemInfo;
  if (managerProjectPathIsForeign(project.path, system.platform)) return unavailableRoot('foreign-host');
  const path = yield* expandPath(project.path).pipe(Effect.result);
  if (Result.isFailure(path)) return unavailableRoot('repository-unavailable');
  const identity = yield* resolveRepositoryIdentity(path.success).pipe(Effect.result);
  return Result.isFailure(identity)
    ? unavailableRoot('repository-unavailable')
    : ({cwd: identity.success.repoRoot, state: 'available'} as const);
});

function unavailableRoot(reason: ManagerRepositoryEvidenceUnavailableReasonV1) {
  return {reason, state: 'unavailable'} as const;
}

export const managerContextHealthRecordPreviews = Effect.fn('managerAttention.recordPreviews')(
  (records: readonly MemoryRecord[], findings: ManagerContextHealthResponseV1['findings']) =>
    Effect.sync(() => {
      const recordsByUri = new Map(EffectArray.map(records, record => [record.uri, record] as const));
      const findingsByRecord = new Map<string, typeof findings>();
      for (const finding of findings) {
        const uri = finding.repair.subjectUri ?? finding.uris[0];
        if (uri === undefined || !recordsByUri.has(uri)) continue;
        findingsByRecord.set(uri, [...(findingsByRecord.get(uri) ?? []), finding]);
      }
      return EffectArray.flatMap([...findingsByRecord.entries()], ([uri, recordFindings]) => {
        const record = recordsByUri.get(uri);
        if (record === undefined) return [];
        const citationFindings = new Map<string, string[]>();
        for (const finding of recordFindings) {
          const citationId = citationIdFromFinding(finding.repair.targetUri);
          if (citationId === undefined) continue;
          citationFindings.set(citationId, [...(citationFindings.get(citationId) ?? []), finding.id]);
        }
        const code = EffectArray.map(
          EffectArrayPipe(record.metadata.codeCitations ?? [], __effectArrayValues =>
            EffectArray.filter(
              __effectArrayValues,
              (citation, __effectArrayIndex) =>
                __effectArrayIndex in __effectArrayValues && citationFindings.has(citation.id),
            ),
          ),
          citation =>
            ({
              citationId: citation.id,
              findingIds: citationFindings.get(citation.id) ?? [],
              ...(citation.target.kind === 'symbol' ? {line: citation.target.span.line} : {}),
              path: citation.path,
              ...(citation.target.kind === 'symbol' ? {targetLabel: citation.target.qualifiedName} : {}),
            }) satisfies ManagerContextHealthCodePreviewV1,
        );
        return [
          {
            contentHash: maintenanceContentHash(record.content),
            code,
            excerpt: memoryExcerpt(record.body),
            kind: record.metadata.kind,
            title: memoryTitle(record),
            ...(record.metadata.topic === undefined ? {} : {topic: record.metadata.topic}),
            uri,
          } satisfies ManagerContextHealthRecordPreviewV1,
        ];
      });
    }),
);

function citationIdFromFinding(targetUri: string | undefined): string | undefined {
  if (targetUri === undefined) return undefined;
  const value = Effect2.pipe(
    targetUri,
    EffectString.slice(
      Effect2.pipe(
        targetUri,
        EffectString.lastIndexOf('#'),
        Effect2.Option.getOrElse(() => -1),
      ) + 1,
    ),
  );
  return value !== undefined && /^tncc_[0-9a-f]{40}$/u.test(value) ? value : undefined;
}

function memoryTitle(record: MemoryRecord): string {
  const heading = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      Effect2.pipe(record.body, EffectString.split(/\r?\n/u)),
      __effectArrayValue => !!(line => /^#{1,6}\s+\S/u.test(line))(__effectArrayValue),
    ),
  );
  return (
    Effect2.pipe(
      heading,
      effectOptionalString =>
        effectOptionalString == null
          ? undefined
          : Effect2.pipe(effectOptionalString, EffectString.replace(/^#{1,6}\s+/u, '')),
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) ??
    record.metadata.topic ??
    memorySlug(record.uri)
  );
}

function memoryExcerpt(body: string): string {
  const plain = Effect2.pipe(
    body,
    EffectString.replace(/^#{1,6}\s+.*$/gmu, ''),
    EffectString.replace(/```[\s\S]*?```/gu, ''),
    EffectString.replace(/\s+/gu, ' '),
    EffectString.trim,
  );
  return plain.length > 360 ? `${Effect2.pipe(plain, EffectString.slice(0, 357), EffectString.trimEnd)}…` : plain;
}

function memorySlug(uri: string): string {
  const value = Effect2.pipe(uri, __effectPipeInput => {
    const __effectPipeStage0 = Effect2.pipe(
      __effectPipeInput,
      EffectString.slice(
        Effect2.pipe(
          uri,
          EffectString.lastIndexOf('/'),
          Effect2.Option.getOrElse(() => -1),
        ) + 1,
      ),
    );
    const __effectPipeStage1 = Effect2.pipe(__effectPipeStage0, EffectString.replace(/\.md$/u, ''));
    const __effectPipeStage2 = Effect2.pipe(__effectPipeStage1, EffectString.replaceAll('-', ' '));
    return __effectPipeStage2;
  });
  return value || 'Untitled memory';
}

function unavailableContextHealth(
  project: string,
  records: readonly MemoryRecord[],
  reason: ManagerRepositoryEvidenceUnavailableReasonV1,
): ManagerContextHealthResponseV1 {
  const eligibleRecords = EffectArray.filter(
    records,
    record =>
      record.metadata.kind === 'durable' && record.metadata.status === 'active' && record.metadata.project === project,
  ).length;
  return {
    findings: [],
    limit: 100,
    omittedFindings: 0,
    project,
    recordPreviews: [],
    recordsScanned: records.length,
    repositoryEvidence: {reason, state: 'unavailable'},
    semanticCompleteness: {
      analyzedRecords: 0,
      claimsAnalyzed: 0,
      supportedClaims: 0,
      unsupportedClaims: 0,
      coverage: 'bounded-English-extraction',
      contradictionCount: 0,
      eligibleRecords,
      omittedContradictions: 0,
      pairsCompared: 0,
      state: eligibleRecords === 0 ? 'complete' : 'unavailable',
      unknownReasons: [],
      unknownRecords: eligibleRecords,
      version: CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION,
    },
    status: 'unknown',
    version: 1,
  };
}

function isPending(state: string): boolean {
  return state === 'pending' || state === 'deferred' || state === 'applying';
}
