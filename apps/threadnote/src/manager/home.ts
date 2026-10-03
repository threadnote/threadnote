import {Effect, Result} from 'effect';
import {managerHomeLanes, type ManagerHomeLane} from '@threadnote/manager/home';
import {listCandidateReviews} from '@threadnote/memory/candidate';
import {readActiveProjectMemoryRecords} from '../memory/maintenance/records.js';
import {collectContextHealth} from '../memory/context/health_commands.js';
import {buildLocalValueReport} from '../value_report/commands.js';
import {managerAttentionProjectRoot} from './attention.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';

export interface ManagerHomeHandoffV1 {
  readonly timestamp: string;
  readonly topic?: string;
  readonly uri: string;
}

export interface ManagerHomeResponseV1 {
  readonly handoffs: readonly ManagerHomeHandoffV1[];
  readonly stats: {
    readonly memories?: number;
    readonly coverage?: string;
    readonly scanned?: number;
    readonly pending?: number;
    readonly outcomes?: number;
  };
  readonly lanes: readonly ManagerHomeLane[];
  readonly project: string;
  readonly version: 1;
}

export interface ManagerHomeApiRequest {
  readonly config: RuntimeConfig;
  readonly method: string;
  readonly url: URL;
}

export interface ManagerHomeApiResponse {
  readonly body: ManagerHomeResponseV1 | {readonly code: 'invalid-project'; readonly error: string};
  readonly status: 200 | 400;
}

/** A read-only, independently failing landing projection. It never builds a graph or changes memory state. */
export const handleManagerHomeRequest = Effect.fn('managerHome.handleRequest')(function* (
  request: ManagerHomeApiRequest,
) {
  if (request.url.pathname !== '/api/home') return undefined;
  if (request.method !== 'GET') return undefined;
  const project = request.url.searchParams.get('project')?.trim() ?? '';
  if (!isProject(project)) {
    return {
      body: {code: 'invalid-project', error: 'Select a project with letters, numbers, dots, underscores, or hyphens.'},
      status: 400,
    } satisfies ManagerHomeApiResponse;
  }

  const recordsResult = yield* readActiveProjectMemoryRecords(request.config, project).pipe(Effect.result);
  const reviewsResult = yield* listCandidateReviews(request.config.agentContextHome).pipe(Effect.result);
  const valueResult = yield* buildLocalValueReport(request.config, {period: 30, project}).pipe(Effect.result);
  const root = yield* managerAttentionProjectRoot(request.config, project);
  const healthResult =
    Result.isSuccess(recordsResult) && root.state === 'available'
      ? yield* collectContextHealth(request.config, project, recordsResult.success, root.cwd).pipe(Effect.result)
      : undefined;
  const handoffs = Result.isSuccess(recordsResult)
    ? recordsResult.success
        .filter(record => record.metadata.kind === 'handoff')
        .sort(
          (left, right) =>
            right.metadata.timestamp.localeCompare(left.metadata.timestamp) || left.uri.localeCompare(right.uri),
        )
        .slice(0, 5)
        .map(record => ({
          timestamp: record.metadata.timestamp,
          ...(record.metadata.topic ? {topic: record.metadata.topic} : {}),
          uri: record.uri,
        }))
    : [];
  const pendingCount = Result.isSuccess(reviewsResult)
    ? reviewsResult.success
        .filter(review => review.project === project)
        .flatMap(review => review.candidates)
        .filter(
          candidate =>
            candidate.state === 'pending' || candidate.state === 'deferred' || candidate.state === 'applying',
        ).length
    : undefined;
  const health =
    healthResult && Result.isSuccess(healthResult)
      ? {
          findingCount: healthResult.success.findings.length + healthResult.success.omittedFindings,
          decisionMemories: healthResult.success.maintenance?.affectedMemories,
          automaticCount: healthResult.success.maintenance?.automaticallyManagedFindings,
          coverage: healthResult.success.maintenance?.citationCoverage.state,
          status: healthResult.success.status,
        }
      : undefined;
  const value = Result.isSuccess(valueResult) ? valueResult.success : undefined;
  return {
    body: {
      handoffs,
      stats: {
        ...(Result.isSuccess(recordsResult) ? {memories: recordsResult.success.length} : {}),
        ...(healthResult && Result.isSuccess(healthResult)
          ? {
              coverage: healthResult.success.semanticCompleteness.state,
              scanned: healthResult.success.recordsScanned,
              decisionMemories: healthResult.success.maintenance?.affectedMemories,
              healthCoverage: healthResult.success.maintenance?.citationCoverage.state,
            }
          : {}),
        ...(pendingCount === undefined ? {} : {pending: pendingCount}),
        ...(value
          ? {
              outcomes: managerRecentOutcomeCount(value),
            }
          : {}),
      },
      lanes: managerHomeLanes({
        ...(pendingCount === undefined ? {} : {reviews: {pendingCount}}),
        ...(health === undefined ? {} : {health}),
        ...(value === undefined
          ? {}
          : {
              value: {
                applied: value.feedback.applied,
                reviewed: value.knowledgeDelta.approved,
                useful: value.feedback.useful,
              },
            }),
      }),
      project,
      version: 1,
    },
    status: 200,
  } satisfies ManagerHomeApiResponse;
});

function isProject(project: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(project);
}

export function managerRecentOutcomeCount(value: {
  readonly feedback: {readonly applied: number; readonly useful: number};
  readonly knowledgeDelta: {readonly approved: number};
}): number {
  return value.feedback.applied + value.feedback.useful + value.knowledgeDelta.approved;
}
