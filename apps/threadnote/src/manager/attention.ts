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
  const project = request.url.searchParams.get('project')?.trim() ?? '';
  if (!isProject(project)) {
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
    const reviews = (yield* listCandidateReviews(request.config.agentContextHome)).filter(
      review => review.project === project,
    );
    const pendingCount = reviews.reduce(
      (count, review) => count + review.candidates.filter(candidate => isPending(candidate.state)).length,
      0,
    );
    const items = reviews
      .map(review => ({
        candidates: review.candidates
          .filter(candidate =>
            view === 'history'
              ? !isPending(candidate.state)
              : view === 'deferred'
                ? candidate.state === 'deferred'
                : view === 'pending'
                  ? candidate.state === 'pending' || candidate.state === 'applying'
                  : isPending(candidate.state),
          )
          .map(candidate => ({
            candidateId: candidate.candidateId,
            categories: candidate.categories,
            comparison: candidate.comparison,
            confidence: candidate.confidence,
            proposedText: candidate.proposedText,
            reason: candidate.reason,
            recommendation: candidate.recommendation,
            state: candidate.state,
            ...(candidate.targetUri === undefined ? {} : {targetUri: candidate.targetUri}),
          })),
        createdAt: review.createdAt,
        project: review.project,
        reviewId: review.reviewId,
        revision: review.revision,
        task: review.task,
        topic: review.topic,
      }))
      .filter(review => review.candidates.length > 0)
      .sort(
        (left, right) => right.createdAt.localeCompare(left.createdAt) || left.reviewId.localeCompare(right.reviewId),
      );
    return {
      body: {
        items,
        pendingCount,
        project,
        version: 1,
      },
      status: 200,
    } satisfies ManagerAttentionResponse;
  }

  const selector = normalizeContextHealthSelector({after: request.url.searchParams.get('after') ?? undefined});
  const corpus = yield* readMaintenanceMemoryRecords(request.config);
  const records = corpus.filter(record => record.metadata.status === 'active' && record.metadata.project === project);
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
  const project = manifest.success.projects.find(
    candidate => candidate.name.toLowerCase() === projectName.toLowerCase(),
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
      const recordsByUri = new Map(records.map(record => [record.uri, record] as const));
      const findingsByRecord = new Map<string, typeof findings>();
      for (const finding of findings) {
        const uri = finding.repair.subjectUri ?? finding.uris[0];
        if (uri === undefined || !recordsByUri.has(uri)) continue;
        findingsByRecord.set(uri, [...(findingsByRecord.get(uri) ?? []), finding]);
      }
      return [...findingsByRecord.entries()].flatMap(([uri, recordFindings]) => {
        const record = recordsByUri.get(uri);
        if (record === undefined) return [];
        const citationFindings = new Map<string, string[]>();
        for (const finding of recordFindings) {
          const citationId = citationIdFromFinding(finding.repair.targetUri);
          if (citationId === undefined) continue;
          citationFindings.set(citationId, [...(citationFindings.get(citationId) ?? []), finding.id]);
        }
        const code = (record.metadata.codeCitations ?? [])
          .filter(citation => citationFindings.has(citation.id))
          .map(
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
  const value = targetUri.slice(targetUri.lastIndexOf('#') + 1);
  return value !== undefined && /^tncc_[0-9a-f]{40}$/u.test(value) ? value : undefined;
}

function memoryTitle(record: MemoryRecord): string {
  const heading = record.body.split(/\r?\n/u).find(line => /^#{1,6}\s+\S/u.test(line));
  return heading?.replace(/^#{1,6}\s+/u, '').trim() ?? record.metadata.topic ?? memorySlug(record.uri);
}

function memoryExcerpt(body: string): string {
  const plain = body
    .replace(/^#{1,6}\s+.*$/gmu, '')
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return plain.length > 360 ? `${plain.slice(0, 357).trimEnd()}…` : plain;
}

function memorySlug(uri: string): string {
  const value = uri
    .slice(uri.lastIndexOf('/') + 1)
    .replace(/\.md$/u, '')
    .replaceAll('-', ' ');
  return value || 'Untitled memory';
}

function unavailableContextHealth(
  project: string,
  records: readonly MemoryRecord[],
  reason: ManagerRepositoryEvidenceUnavailableReasonV1,
): ManagerContextHealthResponseV1 {
  const eligibleRecords = records.filter(
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
      contradictionCount: 0,
      eligibleRecords,
      omittedContradictions: 0,
      pairsCompared: 0,
      state: eligibleRecords === 0 ? 'complete' : 'unavailable',
      unknownReasons: [],
      unknownRecords: eligibleRecords,
      version: 1,
    },
    status: 'unknown',
    version: 1,
  };
}

function isPending(state: string): boolean {
  return state === 'pending' || state === 'deferred' || state === 'applying';
}

function isProject(project: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(project);
}
