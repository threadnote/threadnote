import {Clock, Effect, Fiber, Result} from 'effect';
import {managerHomeLanes, type ManagerHomeLane} from '@threadnote/manager/home';
import {listCandidateReviews} from '@threadnote/memory/candidate';
import {readMaintenanceMemoryRecords} from '../memory/maintenance/records.js';
import {collectContextHealth} from '../memory/context/health_commands.js';
import {readContextMaintenanceStatus} from '../memory/context/maintenance.js';
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
    readonly decisionMemories?: number;
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

const homeSources = {
  records: readMaintenanceMemoryRecords,
  reviews: listCandidateReviews,
  value: buildLocalValueReport,
  root: managerAttentionProjectRoot,
  health: collectContextHealth,
  maintenance: readContextMaintenanceStatus,
};

export type ManagerHomeSources<R = never> = {
  readonly [K in keyof typeof homeSources]: (
    ...args: Parameters<(typeof homeSources)[K]>
  ) => Effect.Effect<Effect.Success<ReturnType<(typeof homeSources)[K]>>, unknown, R>;
};

const HOME_FOREGROUND_BUDGET_MILLISECONDS = 5_000;

/** A read-only, independently failing landing projection. It never builds a graph or changes memory state. */
export const handleManagerHomeRequest = Effect.fn('managerHome.handleRequest')(function (
  request: ManagerHomeApiRequest,
) {
  return collectManagerHomeResponse(request, homeSources);
});

export const collectManagerHomeResponse = Effect.fn('managerHome.collectResponse')(function* <R>(
  request: ManagerHomeApiRequest,
  sources: ManagerHomeSources<R>,
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

  const deadline = (yield* Clock.currentTimeMillis) + HOME_FOREGROUND_BUDGET_MILLISECONDS;
  const observe = <A, E, R>(operation: Effect.Effect<A, E, R>) => observeHomeSource(operation, deadline);
  const corpusFiber = yield* observe(sources.records(request.config)).pipe(Effect.forkChild);
  const rootFiber = yield* observe(sources.root(request.config, project)).pipe(Effect.forkChild);
  const healthObservation = Effect.gen(function* () {
    const corpus = yield* Fiber.join(corpusFiber);
    const root = yield* Fiber.join(rootFiber);
    if (Result.isFailure(corpus) || Result.isFailure(root) || root.success.state !== 'available') return undefined;
    return yield* observe(
      sources.health(request.config, project, activeProjectRecords(corpus.success, project), root.success.cwd, {
        relationCorpus: corpus.success,
      }),
    );
  });
  const [corpusResult, reviewsResult, valueResult, healthResult, maintenanceResult] = yield* Effect.all(
    [
      Fiber.join(corpusFiber),
      observe(sources.reviews(request.config.agentContextHome)),
      observe(sources.value(request.config, {period: 30, project})),
      healthObservation,
      observe(sources.maintenance(request.config, project)),
    ],
    {concurrency: 5},
  );
  const recordsResult = Result.map(corpusResult, records => activeProjectRecords(records, project));
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
  const healthReport = healthResult && Result.isSuccess(healthResult) ? healthResult.success : undefined;
  const retainedDecisions = Result.isSuccess(maintenanceResult)
    ? maintenanceResult.success.counts?.decisionMemories
    : undefined;
  const reportDecisions = healthReport?.maintenance?.affectedMemories;
  const decisionMemories =
    retainedDecisions === undefined ? reportDecisions : Math.max(retainedDecisions, reportDecisions ?? 0);
  const health =
    healthReport || decisionMemories !== undefined
      ? {
          findingCount: healthReport ? healthReport.findings.length + healthReport.omittedFindings : 0,
          decisionMemories,
          automaticCount: healthReport?.maintenance?.automaticallyManagedFindings,
          coverage: healthReport?.maintenance?.citationCoverage.state,
          status: healthReport?.status ?? ('unknown' as const),
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
              healthCoverage: healthResult.success.maintenance?.citationCoverage.state,
            }
          : {}),
        ...(decisionMemories === undefined ? {} : {decisionMemories}),
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

function observeHomeSource<A, E, R>(
  operation: Effect.Effect<A, E, R>,
  deadline: number,
): Effect.Effect<Result.Result<A, unknown>, never, R> {
  return Effect.gen(function* () {
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) return Result.fail('Home foreground budget exhausted.');
    return yield* operation.pipe(Effect.timeout(remaining), Effect.result);
  });
}

function isProject(project: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(project);
}

function activeProjectRecords(records: Effect.Success<ReturnType<typeof homeSources.records>>, project: string) {
  return records.filter(record => record.metadata.status === 'active' && record.metadata.project === project);
}

export function managerRecentOutcomeCount(value: {
  readonly feedback: {readonly applied: number; readonly useful: number};
  readonly knowledgeDelta: {readonly approved: number};
}): number {
  return value.feedback.applied + value.feedback.useful + value.knowledgeDelta.approved;
}
