import {Array as EffectArray} from 'effect';
import {Clock, Effect, FileSystem, Option, Path} from 'effect';
import {readSeedManifest, requireWorkset} from '@threadnote/workspace/manifest';
import type {ProjectManifest, ResolvedWorkset, RuntimeConfig, SeedManifest} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';
import {
  CodeGraphQueryService,
  observationFromCodeGraphStatus,
  type CodeGraphQueryTelemetryObserver,
  type CodeGraphStatusOptions,
} from '../query.js';
import type {CodeGraphQueryResult, CodeGraphStatus, RepositoryIdentityExpectation} from '../types.js';
import {
  attachCodeGraphWorksetBridgeRelationships,
  expandCodeGraphWorksetRouterWithBridges,
  materializeCodeGraphWorksetBridgeEndpointCards,
  mergeCodeGraphWorksetBridgeEndpointCards,
  readCodeGraphWorksetQueryBridgeExpansion,
  type CodeGraphWorksetQueryBridgeExpansionV1,
} from '../cross_repository/query_expansion.js';
import type {CodeGraphCrossRepositoryBridgeV1} from '../cross_repository/resolver.js';
import {makeCodeGraphWorksetCatalogCandidateSource} from '../workset_catalog/candidate_source.js';
import {
  readCodeGraphWorksetResultSetPage,
  readPublishedCodeGraphWorksetCatalogGeneration,
  registerCodeGraphQualifiedRef,
  registerCodeGraphWorksetResultSet,
  resolveCodeGraphQualifiedRef,
} from '../workset_catalog/store.js';
import {
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogPublishedGenerationV1,
  type CodeGraphWorksetCatalogPublishedMemberV1,
  type CodeGraphWorksetResultSetRegistrationV1,
} from '../workset_catalog/types.js';
import {codeGraphWorksetCatalogGenerationMatches, codeGraphWorksetManifestDigest} from '../workset_catalog/workset.js';
import {
  CODE_GRAPH_WORKSET_EVIDENCE_DEFAULT_ESTIMATED_TOKENS,
  CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
  codeGraphQualifiedRefHandle,
  isCodeGraphQualifiedRefHandle,
  projectCodeGraphWorksetEvidence,
  type CodeGraphWorksetQueryResultV2,
  type ProjectedCodeGraphWorksetEvidenceV1,
  type QualifiedCodeGraphRefV1,
  type RepositoryEvidenceReceiptV1,
  type WorksetCoverageV2,
} from './evidence.js';
import {CODE_GRAPH_WORKSET_EXPANSION_SCHEDULE, selectCodeGraphWorksetAdaptiveExpansionBatch} from './expansion.js';
import {rankCodeGraphWorksetEvidenceCards} from './rank.js';
import {
  routeCodeGraphWorksetCatalogCandidates,
  type CodeGraphWorksetRouterRepositoryCandidateV1,
  type CodeGraphWorksetRouterResultV1,
} from './router.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_GRAPH_WORKSET_QUERY_V2_VERSION = 1 as const;

/** Qualified-reference routing needs identity and a ready pointer, not exact dirty-overlay evidence. */
export const CODE_GRAPH_QUALIFIED_REF_TARGET_STATUS_OPTIONS = {
  observeWorktree: false,
  requestMaintenance: false,
} as const satisfies CodeGraphStatusOptions;

const DEFAULT_DEADLINE_MILLISECONDS = 5_000;
const MAXIMUM_DEADLINE_MILLISECONDS = 60_000;
// Logical cross-repository breadth is independent of both each repository's
// local node limit and the compact first-page transport projection.
const DEFAULT_EVIDENCE_CARDS = 40;
const MAXIMUM_EVIDENCE_CARDS = 512;
const DEFAULT_LOCAL_NODE_LIMIT = 20;
const DEFAULT_LOCAL_EDGE_LIMIT = 40;

export interface CodeGraphWorksetQueryV2MemberV1 {
  readonly deepQueryEligible: boolean;
  readonly published?: CodeGraphWorksetCatalogPublishedMemberV1;
  readonly receipt: RepositoryEvidenceReceiptV1;
  readonly repositoryKey: string;
}

export interface CodeGraphWorksetQueryV2InputV1 {
  readonly deadlineMilliseconds?: number;
  readonly depth?: number;
  readonly edgeLimit?: number;
  readonly evidenceCards?: number;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly maximumEstimatedTokens?: number;
  readonly members: readonly CodeGraphWorksetQueryV2MemberV1[];
  readonly nodeLimit?: number;
  readonly packageName?: string;
  readonly published: CodeGraphWorksetCatalogPublishedGenerationV1;
  readonly query: string;
  readonly worksetName: string;
}

export interface CodeGraphWorksetQueryV2InstrumentationV1 {
  readonly bridgeEdgesConsidered: number;
  readonly bridgeExpandedRepositories: number;
  readonly bridgeExpansionComplete: boolean;
  readonly cards: number;
  readonly databasesOpened: number;
  readonly deepQueryFailures: number;
  readonly deepQueriedRepositories: number;
  readonly expansionBatches: number;
  readonly relationships: number;
  readonly repositoriesConsidered: number;
  readonly responseStructuredBytes: number;
  readonly responseTextBytes: number;
  readonly responseTotalBytes: number;
  readonly version: typeof CODE_GRAPH_WORKSET_QUERY_V2_VERSION;
}

export interface CodeGraphWorksetQueryV2ExecutionV1 {
  readonly instrumentation: CodeGraphWorksetQueryV2InstrumentationV1;
  readonly logicalResult: CodeGraphWorksetQueryResultV2;
  readonly projected: ProjectedCodeGraphWorksetEvidenceV1;
}

export interface CodeGraphWorksetQueryV2DependenciesV1<R = never> {
  readonly deepQuery: (
    repository: CodeGraphWorksetRouterRepositoryCandidateV1,
  ) => Effect.Effect<CodeGraphQueryResult, unknown, R>;
  readonly nowMilliseconds: Effect.Effect<number, unknown, R>;
  readonly persist: (
    result: CodeGraphWorksetQueryResultV2,
    qualifiedRefs: readonly QualifiedCodeGraphRefV1[],
  ) => Effect.Effect<CodeGraphWorksetResultSetRegistrationV1, unknown, R>;
  readonly readBridgeExpansion: (
    router: CodeGraphWorksetRouterResultV1,
  ) => Effect.Effect<CodeGraphWorksetQueryBridgeExpansionV1, unknown, R>;
  readonly route: Effect.Effect<CodeGraphWorksetRouterResultV1, unknown, R>;
}

interface CodeGraphWorksetQueryV2TimingV1 {
  readonly startedAtMilliseconds?: number;
  readonly telemetry?: CodeGraphQueryTelemetryObserver;
}

export interface QueryCodeGraphWorksetV2OptionsV1 {
  readonly deadlineMilliseconds?: number;
  readonly depth?: number;
  readonly edgeLimit?: number;
  readonly evidenceCards?: number;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly maximumEstimatedTokens?: number;
  readonly nodeLimit?: number;
  readonly packageName?: string;
  readonly query: string;
  readonly telemetry?: CodeGraphQueryTelemetryObserver;
  readonly worksetName: string;
}

export interface ContinueCodeGraphWorksetV2OptionsV1 {
  readonly cursor: string;
  readonly maximumEstimatedTokens?: number;
  readonly telemetry?: CodeGraphQueryTelemetryObserver;
}

export interface ResolvedCodeGraphQualifiedRefTargetV1 {
  readonly project?: string;
  readonly cwd: string;
  readonly nodeId: string;
  readonly ref: string;
  readonly repositoryId: string;
  readonly route: {readonly kind: 'caller'} | {readonly kind: 'workset'; readonly name: string};
  readonly status: CodeGraphStatus;
}

/**
 * Run the deterministic Workset Search 2.0 orchestration against injected
 * routing, deep-read, and persistence boundaries. None of these boundaries is
 * allowed to attach, index, or otherwise mutate a repository graph.
 */
export const runCodeGraphWorksetQueryV2Core = Effect.fn('codeGraphWorksetV2.runCore')(function* <R>(
  dependencies: CodeGraphWorksetQueryV2DependenciesV1<R>,
  input: CodeGraphWorksetQueryV2InputV1,
  timing: CodeGraphWorksetQueryV2TimingV1 = {},
) {
  const prepared = validateCoreInput(input);
  const observedStarted = yield* dependencies.nowMilliseconds;
  const requestedStarted = timing.startedAtMilliseconds;
  if (requestedStarted !== undefined && (!Number.isSafeInteger(requestedStarted) || requestedStarted < 0)) {
    throw new Error('The deadline clock origin is invalid.');
  }
  const started = Math.min(observedStarted, requestedStarted ?? observedStarted);
  const catalogRouter = yield* dependencies.route;
  validateRouterReceipt(prepared, catalogRouter);
  const bridgeExpansion = yield* dependencies.readBridgeExpansion(catalogRouter);
  const router = expandCodeGraphWorksetRouterWithBridges(catalogRouter, prepared.published, bridgeExpansion);

  const membersByKey = new Map(EffectArray.map(prepared.members, member => [member.repositoryKey, member]));
  const selectedRepositoryKeys = new Set<string>();
  const attemptedRepositoryKeys = new Set<string>();
  const failures = new Set<string>();
  const successful = new Map<string, CodeGraphQueryResult>();
  let expansionBatches = 0;
  let phase = 0;
  let stopReason: WorksetCoverageV2['stopReason'] = 'exhaustion';

  for (;;) {
    const now = yield* dependencies.nowMilliseconds;
    const remainingMilliseconds = Math.max(0, prepared.deadlineMilliseconds - Math.max(0, now - started));
    const expansion = selectCodeGraphWorksetAdaptiveExpansionBatch({
      alreadySelectedRepositoryKeys: selectedRepositoryKeys,
      phase,
      remainingMilliseconds,
      repositories: router.repositories,
    });
    if (expansion.stopReason !== 'continue') {
      stopReason =
        expansion.stopReason === 'deadline' || expansion.stopReason === 'cancelled' ? 'deadline' : 'exhaustion';
      break;
    }
    expansionBatches += 1;
    for (const repository of expansion.repositories) selectedRepositoryKeys.add(repository.repositoryKey);
    const outcomes = yield* Effect.forEach(
      expansion.repositories,
      (repository): Effect.Effect<DeepQueryOutcome, unknown, R> => {
        const member = membersByKey.get(repository.repositoryKey);
        if (member === undefined || !member.deepQueryEligible || member.published === undefined) {
          return Effect.succeed({repository, state: 'skipped' as const});
        }
        return Effect.gen(function* () {
          const taskStarted = yield* dependencies.nowMilliseconds;
          const taskRemaining = Math.max(0, prepared.deadlineMilliseconds - Math.max(0, taskStarted - started));
          if (taskRemaining === 0) return {repository, state: 'timed-out' as const};
          attemptedRepositoryKeys.add(repository.repositoryKey);
          return yield* dependencies.deepQuery(repository).pipe(
            Effect.map(graph => ({graph, repository, state: 'ready' as const})),
            Effect.orElseSucceed(() => ({repository, state: 'failed' as const})),
            Effect.timeoutOrElse({
              duration: taskRemaining,
              orElse: () => Effect.succeed({repository, state: 'timed-out' as const}),
            }),
          );
        });
      },
      {concurrency: expansion.concurrency},
    );
    const batchTimedOut = EffectArray.some(outcomes, outcome => outcome.state === 'timed-out');
    for (const outcome of outcomes) {
      if (outcome.state === 'ready') {
        validateDeepQueryResult(membersByKey.get(outcome.repository.repositoryKey), outcome.repository, outcome.graph);
        successful.set(outcome.repository.repositoryKey, outcome.graph);
      } else if (outcome.state === 'failed') {
        failures.add(outcome.repository.repositoryKey);
      }
    }

    if (batchTimedOut) {
      stopReason = 'deadline';
      break;
    }

    const afterBatch = yield* dependencies.nowMilliseconds;
    if (Math.max(0, afterBatch - started) >= prepared.deadlineMilliseconds) {
      stopReason = 'deadline';
      break;
    }

    const cards = rankSuccessfulResults(router, successful, MAXIMUM_EVIDENCE_CARDS);
    const remainingCandidates = router.repositories.length - selectedRepositoryKeys.size;
    if (cards.length > 0) {
      // Ambiguity gets one validation expansion (4 + 4 repositories). That is
      // the default deep-read work budget after evidence exists; only a
      // zero-card route proceeds to the 16-repository exhaustion batch.
      if (
        remainingCandidates > 0 &&
        router.uncertainty.shouldExpand &&
        phase === 0 &&
        CODE_GRAPH_WORKSET_EXPANSION_SCHEDULE.length > 1
      ) {
        phase += 1;
        continue;
      }
      stopReason =
        remainingCandidates > 0 && cards.length >= prepared.evidenceCards
          ? 'result-budget'
          : remainingCandidates > 0 && router.uncertainty.shouldExpand && phase > 0
            ? 'work-budget'
            : 'sufficient-evidence';
      break;
    }
    if (remainingCandidates <= 0) {
      stopReason = 'exhaustion';
      break;
    }
    phase += 1;
  }

  const usableRepositoryKeys = new Set(
    EffectArray.map(
      EffectArray.filter(
        prepared.members,
        member =>
          !failures.has(member.repositoryKey) &&
          (member.receipt.state === 'current' || member.receipt.state === 'stale'),
      ),
      member => member.repositoryKey,
    ),
  );
  const localCards = rankSuccessfulResults(router, successful, MAXIMUM_EVIDENCE_CARDS);
  const bridgeCards = materializeCodeGraphWorksetBridgeEndpointCards(
    prepared.published,
    bridgeExpansion.bridges,
    usableRepositoryKeys,
  );
  const cards = attachCodeGraphWorksetBridgeRelationships(
    mergeCodeGraphWorksetBridgeEndpointCards(localCards, bridgeCards, prepared.evidenceCards),
    bridgeExpansion.bridges,
    usableRepositoryKeys,
  );
  const repositories = materializeRepositoryReceipts(
    prepared.members,
    attemptedRepositoryKeys,
    failures,
    router.coverage.state === 'complete',
  );
  const coverage = materializeCoverage(repositories, stopReason);
  const logicalResult: CodeGraphWorksetQueryResultV2 = {
    cards,
    coverage,
    repositories,
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    type: 'code-graph-workset-query',
    version: 2,
    warnings: worksetWarnings(prepared.members, failures, stopReason, bridgeExpansion.warnings),
    workset: {
      generation: {digest: prepared.published.digest, id: prepared.published.id},
      name: prepared.worksetName,
    },
  };
  const qualifiedRefs = referencedQualifiedRefs(logicalResult, successful, bridgeExpansion.bridges);
  const registration = yield* dependencies.persist(logicalResult, qualifiedRefs);
  const project = Effect.sync(() =>
    projectCodeGraphWorksetEvidence(logicalResult, {
      continuationForOffset: registration.continuationForOffset,
      maximumEstimatedTokens: prepared.maximumEstimatedTokens,
    }),
  );
  const projected = yield* timing.telemetry === undefined
    ? project
    : timing.telemetry.stage('graph.query.execute', 'query-serialization', project);
  return {
    instrumentation: {
      bridgeEdgesConsidered: bridgeExpansion.bridges.length,
      bridgeExpandedRepositories: Math.max(0, router.repositories.length - catalogRouter.repositories.length),
      bridgeExpansionComplete: bridgeExpansion.complete,
      cards: logicalResult.cards.length,
      databasesOpened: attemptedRepositoryKeys.size,
      deepQueryFailures: failures.size,
      deepQueriedRepositories: attemptedRepositoryKeys.size,
      expansionBatches,
      relationships: EffectArray.reduce(logicalResult.cards, 0, (total, card) => total + card.relationships.length),
      repositoriesConsidered: coverage.consideredRepositories,
      responseStructuredBytes: projected.measurement.structuredBytes,
      responseTextBytes: projected.measurement.textBytes,
      responseTotalBytes: projected.measurement.totalBytes,
      version: CODE_GRAPH_WORKSET_QUERY_V2_VERSION,
    },
    logicalResult,
    projected,
  } satisfies CodeGraphWorksetQueryV2ExecutionV1;
});

/**
 * Execute a published-generation query and retain privacy-safe instrumentation
 * for evaluation. This path observes statuses and performs read-only deep
 * queries only.
 */
export const executeCodeGraphWorksetV2 = Effect.fn('codeGraphWorksetV2.execute')(function* (
  config: RuntimeConfig,
  options: QueryCodeGraphWorksetV2OptionsV1,
) {
  const deadlineStartedAtMilliseconds = yield* Clock.currentTimeMillis;
  const deadlineMilliseconds = validateDeadlineMilliseconds(options.deadlineMilliseconds);
  const queryService = yield* CodeGraphQueryService;
  const runtime = yield* prepareRuntimeQuery(config, {...options, deadlineMilliseconds}, queryService);
  const source = yield* makeCodeGraphWorksetCatalogCandidateSource(config.agentContextHome);
  const execution = yield* runCodeGraphWorksetQueryV2Core(
    {
      deepQuery: repository => {
        const member = runtime.deepMembers.get(repository.repositoryKey);
        if (member === undefined)
          return Effect.fail(
            CodeGraphWorksetCatalogError.of('missing', 'The routed repository has no validated ready snapshot.'),
          );
        return queryService.inspect({
          project: repository.repositoryKey,
          manifestPath: config.manifestPath,
          cwd: member.cwd,
          depth: options.depth,
          edgeLimit: options.edgeLimit ?? DEFAULT_LOCAL_EDGE_LIMIT,
          includeHeuristic: options.includeHeuristic,
          includeModelAssociations: options.includeModelAssociations,
          nodeLimit: options.nodeLimit ?? DEFAULT_LOCAL_NODE_LIMIT,
          operation: 'query',
          packageName: options.packageName,
          query: options.query,
          refresh: false,
          requestMaintenance: false,
          statusObservation: observationFromCodeGraphStatus(member.status),
          strictFreshness: false,
          threadnoteHome: config.agentContextHome,
        });
      },
      nowMilliseconds: Clock.currentTimeMillis,
      persist: (result, qualifiedRefs) =>
        Effect.gen(function* () {
          yield* Effect.forEach(qualifiedRefs, ref => registerCodeGraphQualifiedRef(config.agentContextHome, ref), {
            concurrency: 1,
            discard: true,
          });
          return yield* registerCodeGraphWorksetResultSet(config.agentContextHome, {
            projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
            result,
          });
        }),
      readBridgeExpansion: router =>
        readCodeGraphWorksetQueryBridgeExpansion(config.agentContextHome, runtime.input.published, router).pipe(
          Effect.orElseSucceed(
            () =>
              ({
                bridges: [],
                complete: false,
                seededRepositories: Math.min(16, router.repositories.length),
                warnings: ['Cross-repository contract-neighbor expansion was unavailable for this query.'],
              }) satisfies CodeGraphWorksetQueryBridgeExpansionV1,
          ),
        ),
      route: routeCodeGraphWorksetCatalogCandidates(source, {
        limits: {repositoryLimit: Math.min(512, Math.max(64, runtime.input.members.length))},
        query: options.query,
        worksetName: runtime.input.worksetName,
      }),
    },
    runtime.input,
    {startedAtMilliseconds: deadlineStartedAtMilliseconds, telemetry: options.telemetry},
  );
  return execution;
});

/** Query a published generation through the compact agent transport projection. */
export const queryCodeGraphWorksetV2 = Effect.fn('codeGraphWorksetV2.query')(function* (
  config: RuntimeConfig,
  options: QueryCodeGraphWorksetV2OptionsV1,
) {
  const execution = yield* executeCodeGraphWorksetV2(config, options);
  return execution.projected;
});

/** Continue only from the pinned result sequence; routing and repository reads are deliberately absent. */
export const continueCodeGraphWorksetQueryV2 = Effect.fn('codeGraphWorksetV2.continue')(function* (
  config: RuntimeConfig,
  options: ContinueCodeGraphWorksetV2OptionsV1,
) {
  const page = yield* readCodeGraphWorksetResultSetPage(config.agentContextHome, {
    cursor: options.cursor,
    expectedProjectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
    limit: 128,
  });
  const project = Effect.sync(() =>
    projectCodeGraphWorksetEvidence(page.result, {
      continuationForOffset: page.continuationForOffset,
      continuationOffsetBase: page.offset,
      maximumEstimatedTokens: options.maximumEstimatedTokens,
      totalCards: page.totalCards - page.offset,
    }),
  );
  return yield* options.telemetry === undefined
    ? project
    : options.telemetry.stage('graph.query.execute', 'query-serialization', project);
});

/**
 * Resolve a cgr_ handle to one configured ready worktree without attaching or
 * building a graph. A caller-scoped matching worktree wins; otherwise sibling
 * worktrees remain an explicit ambiguity instead of leaking evidence.
 */
export const resolveCodeGraphQualifiedRefTargets = Effect.fn('codeGraphWorksetV2.resolveQualifiedRefTargets')(
  function* (config: RuntimeConfig, refs: readonly string[], callerCwd?: string, callerProject?: string) {
    for (const ref of refs) {
      if (!isCodeGraphQualifiedRefHandle(ref)) throw new Error('Qualified code graph reference is invalid.');
    }
    if (refs.length === 0) return [] as readonly ResolvedCodeGraphQualifiedRefTargetV1[];
    const uniqueRefs = [...new Set(refs)];
    const records = yield* Effect.forEach(
      uniqueRefs,
      ref => resolveCodeGraphQualifiedRef(config.agentContextHome, {ref}),
      {concurrency: 4},
    );
    const recordsByRef = new Map(EffectArray.map(records, record => [record.ref, record]));
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const queryService = yield* CodeGraphQueryService;
    const manifest = yield* readSeedManifest(config.manifestPath);
    const caller = callerCwd === undefined ? undefined : yield* expandPath(callerCwd);
    const requestedRepositoryIds = new Set(EffectArray.map(records, record => record.repositoryId));
    const publishedRoutes = yield* Effect.forEach(
      resolveManifestWorksets(manifest),
      workset =>
        Effect.option(readPublishedQualifiedRefRoute(config.agentContextHome, workset.name, fs, path)).pipe(
          Effect.map(published => ({published: Option.getOrUndefined(published), workset})),
        ),
      {concurrency: 4},
    );
    const publishedPaths = EffectArray.flatMap(publishedRoutes, ({published, workset}) => {
      if (
        published === undefined ||
        !codeGraphWorksetCatalogGenerationMatches(workset, codeGraphWorksetManifestDigest(workset), published)
      ) {
        return [];
      }
      const projectsByKey = new Map(EffectArray.map(workset.projects, project => [safeLabel(project.name), project]));
      return EffectArray.flatMap(published.members, member => {
        if (!requestedRepositoryIds.has(member.repositoryId)) return [];
        const project = projectsByKey.get(member.repositoryKey);
        return project === undefined
          ? []
          : [{path: project.path, project: project.name, route: {kind: 'workset' as const, name: workset.name}}];
      });
    });
    const orderedPaths = [
      ...(caller === undefined ? [] : [{path: caller, project: callerProject, route: {kind: 'caller' as const}}]),
      ...publishedPaths,
    ];
    const uniquePaths: {
      readonly cwd: string;
      readonly project?: string;
      readonly route: {readonly kind: 'caller'} | {readonly kind: 'workset'; readonly name: string};
    }[] = [];
    const seenPaths = new Set<string>();
    for (const candidate of orderedPaths) {
      const cwd = yield* expandPath(candidate.path);
      const key = `${cwd}\0${candidate.project ?? ''}`;
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      uniquePaths.push({cwd, project: candidate.project, route: candidate.route});
    }
    const matches = yield* Effect.forEach(
      uniquePaths,
      candidate =>
        Effect.gen(function* () {
          const {cwd} = candidate;
          if (!(yield* fs.exists(cwd))) return undefined;
          const status = yield* queryService.status(config.agentContextHome, cwd, {
            ...CODE_GRAPH_QUALIFIED_REF_TARGET_STATUS_OPTIONS,
            project: candidate.project,
            manifestPath: config.manifestPath,
          });
          return status.readySnapshot === undefined ? undefined : ({...candidate, status} as const);
        }).pipe(Effect.orElseSucceed(() => undefined)),
      {concurrency: 4},
    );
    const available = EffectArray.filter(matches, (value): value is NonNullable<typeof value> => value !== undefined);
    const availableByRepository = new Map<string, typeof available>();
    for (const candidate of available) {
      const repositoryId = candidate.status.identity.repositoryId;
      const group = availableByRepository.get(repositoryId) ?? [];
      group.push(candidate);
      availableByRepository.set(repositoryId, group);
    }
    return EffectArray.map(refs, ref => {
      const record = recordsByRef.get(ref)!;
      const repositoryMatches = availableByRepository.get(record.repositoryId) ?? [];
      const selected =
        Option.getOrUndefined(
          EffectArray.findFirst(
            repositoryMatches,
            candidate => candidate.cwd === caller && candidate.route.kind === 'caller',
          ),
        ) ?? (repositoryMatches.length === 1 ? repositoryMatches[0] : undefined);
      if (selected === undefined) {
        throw new Error(
          repositoryMatches.length === 0
            ? 'The qualified graph reference repository has no caller-scoped or published ready worktree.'
            : 'The qualified graph reference matches multiple worktrees; pass --cwd for the intended sibling.',
        );
      }
      return {
        ...(selected.status.projectCoverage === undefined ? {} : {project: selected.status.projectCoverage.project}),
        cwd: selected.cwd,
        nodeId: record.nodeId,
        ref: record.ref,
        repositoryId: record.repositoryId,
        route: selected.route,
        status: selected.status,
      } satisfies ResolvedCodeGraphQualifiedRefTargetV1;
    });
  },
);

function resolveManifestWorksets(manifest: SeedManifest): readonly ResolvedWorkset[] {
  const projectsByName = new Map(
    EffectArray.map(manifest.projects, project => [Effect2.pipe(project.name, EffectString.toLowerCase), project]),
  );
  return EffectArray.map(manifest.worksets ?? [], workset => {
    const projects: ProjectManifest[] = [];
    const unresolvedProjects: string[] = [];
    for (const name of workset.projects) {
      const project = projectsByName.get(Effect2.pipe(name, EffectString.toLowerCase));
      if (project === undefined) unresolvedProjects.push(name);
      else projects.push(project);
    }
    return {name: workset.name, projects, unresolvedProjects};
  });
}

function readPublishedQualifiedRefRoute(
  threadnoteHome: string,
  worksetName: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<CodeGraphWorksetCatalogPublishedGenerationV1 | undefined, unknown> {
  const captured = readPublishedCodeGraphWorksetCatalogGeneration(threadnoteHome, worksetName).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );
  // The catalog reader's inferred generic environment is intentionally broad;
  // this adapter has captured the only concrete services used by that read.
  return captured;
}

/** Resolve one qualified handle through the same batched routing boundary. */
export const resolveCodeGraphQualifiedRefTarget = Effect.fn('codeGraphWorksetV2.resolveQualifiedRefTarget')(function* (
  config: RuntimeConfig,
  ref: string,
  callerCwd?: string,
  project?: string,
) {
  return (yield* resolveCodeGraphQualifiedRefTargets(config, [ref], callerCwd, project))[0];
});

interface PreparedCoreInput extends CodeGraphWorksetQueryV2InputV1 {
  readonly deadlineMilliseconds: number;
  readonly evidenceCards: number;
  readonly maximumEstimatedTokens: number;
}

type DeepQueryOutcome =
  | {
      readonly graph: CodeGraphQueryResult;
      readonly repository: CodeGraphWorksetRouterRepositoryCandidateV1;
      readonly state: 'ready';
    }
  | {
      readonly repository: CodeGraphWorksetRouterRepositoryCandidateV1;
      readonly state: 'failed' | 'skipped' | 'timed-out';
    };

function validateCoreInput(input: CodeGraphWorksetQueryV2InputV1): PreparedCoreInput {
  const query = boundedText(input.query, 'query', 4_096);
  const worksetName = boundedText(input.worksetName, 'workset name', 256);
  if (input.published.worksetName !== worksetName) throw new Error('Published generation belongs to another workset.');
  const members = [...input.members].sort((left, right) => compareText(left.repositoryKey, right.repositoryKey));
  const keys = new Set<string>();
  for (const member of members) {
    boundedText(member.repositoryKey, 'repository key', 256);
    if (keys.has(member.repositoryKey)) throw new Error(`Workset member ${member.repositoryKey} is duplicated.`);
    keys.add(member.repositoryKey);
    if (member.published !== undefined && member.published.repositoryKey !== member.repositoryKey) {
      throw new Error('Workset member publication key is inconsistent.');
    }
  }
  return {
    ...input,
    deadlineMilliseconds: validateDeadlineMilliseconds(input.deadlineMilliseconds),
    evidenceCards: boundedInteger(
      input.evidenceCards ?? DEFAULT_EVIDENCE_CARDS,
      'evidence card count',
      1,
      MAXIMUM_EVIDENCE_CARDS,
    ),
    maximumEstimatedTokens: input.maximumEstimatedTokens ?? CODE_GRAPH_WORKSET_EVIDENCE_DEFAULT_ESTIMATED_TOKENS,
    members,
    query,
    worksetName,
  };
}

function validateDeadlineMilliseconds(value: number | undefined): number {
  return boundedInteger(value ?? DEFAULT_DEADLINE_MILLISECONDS, 'deadline', 1, MAXIMUM_DEADLINE_MILLISECONDS);
}

function validateRouterReceipt(input: PreparedCoreInput, router: CodeGraphWorksetRouterResultV1): void {
  if (router.worksetName !== input.worksetName || router.generationId !== input.published.id) {
    throw new Error('Workset router result does not belong to the fenced published generation.');
  }
  if (router.coverage.state !== 'complete') throw new Error('Production workset routing coverage is partial.');
  if (router.coverage.eligibleMemberCount !== input.published.members.length) {
    throw new Error('Workset router eligible-member coverage does not match the published generation.');
  }
}

function validateDeepQueryResult(
  member: CodeGraphWorksetQueryV2MemberV1 | undefined,
  routed: CodeGraphWorksetRouterRepositoryCandidateV1,
  graph: CodeGraphQueryResult,
): void {
  const published = member?.published;
  if (
    member === undefined ||
    published === undefined ||
    graph.repository.repositoryId !== routed.repositoryId ||
    graph.repository.repositoryId !== published.repositoryId ||
    graph.snapshot.id !== routed.snapshotId ||
    graph.snapshot.id !== published.snapshotId ||
    graph.snapshot.worktreeId !== published.worktreeId ||
    graph.snapshot.commit !== published.commitId
  ) {
    throw new Error(`Deep-query provenance for ${routed.repositoryKey} does not match the published generation.`);
  }
}

function rankSuccessfulResults(
  router: CodeGraphWorksetRouterResultV1,
  successful: ReadonlyMap<string, CodeGraphQueryResult>,
  maximumCards: number,
) {
  return rankCodeGraphWorksetEvidenceCards({
    maximumCards,
    repositories: EffectArray.flatMap(router.repositories, repository => {
      const graph = successful.get(repository.repositoryKey);
      return graph === undefined ? [] : [{graph, repositoryKey: repository.repositoryKey}];
    }),
    router,
  });
}

function materializeRepositoryReceipts(
  members: readonly CodeGraphWorksetQueryV2MemberV1[],
  attempted: ReadonlySet<string>,
  failures: ReadonlySet<string>,
  routingComplete: boolean,
): Readonly<Record<string, RepositoryEvidenceReceiptV1>> {
  return EffectRecord.fromEntries(
    EffectArray.map(members, member => {
      const failed = failures.has(member.repositoryKey);
      const snapshot = member.receipt.snapshot;
      const considered = routingComplete && snapshot !== undefined;
      return [
        member.repositoryKey,
        {
          considered,
          deepQueried: attempted.has(member.repositoryKey),
          ...(member.receipt.projectCoverage === undefined ? {} : {projectCoverage: member.receipt.projectCoverage}),
          repositoryId: member.receipt.repositoryId,
          ...(snapshot === undefined ? {} : {snapshot}),
          state: failed ? 'failed' : member.receipt.state,
        } satisfies RepositoryEvidenceReceiptV1,
      ];
    }),
  );
}

function materializeCoverage(
  repositories: Readonly<Record<string, RepositoryEvidenceReceiptV1>>,
  stopReason: WorksetCoverageV2['stopReason'],
): WorksetCoverageV2 {
  const receipts = EffectRecord.values(repositories);
  const states = {
    current: EffectArray.filter(receipts, receipt => receipt.state === 'current').length,
    deferred: EffectArray.filter(receipts, receipt => receipt.state === 'deferred').length,
    excluded: EffectArray.filter(receipts, receipt => receipt.state === 'excluded').length,
    failed: EffectArray.filter(receipts, receipt => receipt.state === 'failed').length,
    missing: EffectArray.filter(receipts, receipt => receipt.state === 'missing').length,
    stale: EffectArray.filter(receipts, receipt => receipt.state === 'stale').length,
  };
  const cataloguedRepositories = EffectArray.filter(receipts, receipt => receipt.snapshot !== undefined).length;
  const consideredRepositories = EffectArray.filter(
    receipts,
    __effectArrayValue => !!(receipt => receipt.considered)(__effectArrayValue),
  ).length;
  return {
    cataloguedRepositories,
    complete:
      cataloguedRepositories === consideredRepositories &&
      EffectArray.every(receipts, receipt => receipt.projectCoverage?.completeness !== 'partial'),
    consideredRepositories,
    deepQueriedRepositories: EffectArray.filter(
      receipts,
      __effectArrayValue => !!(receipt => receipt.deepQueried)(__effectArrayValue),
    ).length,
    requestedRepositories: receipts.length,
    states,
    stopReason,
  };
}

function worksetWarnings(
  members: readonly CodeGraphWorksetQueryV2MemberV1[],
  failures: ReadonlySet<string>,
  stopReason: WorksetCoverageV2['stopReason'],
  bridgeWarnings: readonly string[],
): readonly string[] {
  return [
    ...(EffectArray.some(members, member => member.receipt.projectCoverage?.kind === 'project')
      ? ['Workset results cover the configured project graphs; absence does not establish repository-wide absence.']
      : []),
    ...(EffectArray.some(members, member => member.receipt.projectCoverage?.completeness === 'partial')
      ? ['One or more project graphs have partial dependency coverage and cannot provide authoritative negative proof.']
      : []),
    ...(EffectArray.some(members, member => member.receipt.state !== 'current')
      ? ['One or more workset members are not current in the published generation.']
      : []),
    ...(failures.size > 0 ? [`${failures.size} repository deep read${failures.size === 1 ? '' : 's'} failed.`] : []),
    ...(stopReason === 'deadline' ? ['The workset query stopped at its read deadline.'] : []),
    ...(stopReason === 'work-budget'
      ? ['The workset query stopped after its bounded ambiguity-validation work budget.']
      : []),
    ...bridgeWarnings,
  ];
}

function referencedQualifiedRefs(
  result: CodeGraphWorksetQueryResultV2,
  successful: ReadonlyMap<string, CodeGraphQueryResult>,
  bridges: readonly CodeGraphCrossRepositoryBridgeV1[],
): readonly QualifiedCodeGraphRefV1[] {
  const candidates = new Map<string, QualifiedCodeGraphRefV1>();
  for (const graph of successful.values()) {
    const repositoryId = graph.repository.repositoryId;
    for (const node of graph.nodes) registerQualifiedCandidate(candidates, {nodeId: node.id, repositoryId});
    for (const edge of graph.edges) {
      if (edge.sourceId !== undefined) registerQualifiedCandidate(candidates, {nodeId: edge.sourceId, repositoryId});
      if (edge.targetId !== undefined) registerQualifiedCandidate(candidates, {nodeId: edge.targetId, repositoryId});
    }
  }
  const required = new Set<string>();
  const preparedBridgeRefs = new Set(
    EffectArray.flatMap(bridges, bridge =>
      EffectArray.flatMap([bridge.source.reference, bridge.target.reference], reference =>
        reference.kind === 'qualified-ref' ? [reference.ref] : [],
      ),
    ),
  );
  for (const card of result.cards) {
    required.add(card.ref);
    for (const relationship of card.relationships) {
      required.add(relationship.source.ref);
      required.add(relationship.target.ref);
    }
  }
  return EffectArray.flatMap([...required].sort(compareText), ref => {
    const candidate = candidates.get(ref);
    if (candidate !== undefined) return [candidate];
    // Protobuf bridge refs are registered from canonical monikers before the
    // generation pointer is published. Result-set persistence revalidates the
    // registry row; no node identity is reconstructed from an opaque handle.
    if (preparedBridgeRefs.has(ref)) return [];
    throw new Error(`Qualified reference ${ref} lacks exact repository/node evidence.`);
  });
}

function registerQualifiedCandidate(
  candidates: Map<string, QualifiedCodeGraphRefV1>,
  candidate: QualifiedCodeGraphRefV1,
): void {
  const ref = codeGraphQualifiedRefHandle(candidate);
  const existing = candidates.get(ref);
  if (
    existing !== undefined &&
    (existing.repositoryId !== candidate.repositoryId || existing.nodeId !== candidate.nodeId)
  ) {
    throw new Error('Qualified code graph reference collision detected.');
  }
  candidates.set(ref, candidate);
}

interface RuntimeDeepMember {
  readonly cwd: string;
  readonly status: CodeGraphStatus;
}

interface RuntimeQueryStatusService {
  readonly status: (
    threadnoteHome: string,
    cwd: string,
    options?: {readonly requestMaintenance?: boolean; readonly project?: string; readonly manifestPath?: string},
  ) => Effect.Effect<CodeGraphStatus, unknown>;
  readonly statusForPublishedIdentity: (
    threadnoteHome: string,
    cwd: string,
    expected: RepositoryIdentityExpectation,
    options?: {readonly requestMaintenance?: boolean; readonly project?: string; readonly manifestPath?: string},
  ) => Effect.Effect<CodeGraphStatus, unknown>;
}

function prepareRuntimeQuery(
  config: RuntimeConfig,
  options: QueryCodeGraphWorksetV2OptionsV1,
  queryService: RuntimeQueryStatusService,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workset = yield* requireWorkset(config.manifestPath, options.worksetName);
    const manifestDigest = codeGraphWorksetManifestDigest(workset);
    const published = yield* readPublishedCodeGraphWorksetCatalogGeneration(config.agentContextHome, workset.name);
    if (published === undefined) {
      return yield* CodeGraphWorksetCatalogError.of(
        'missing',
        `No published routing catalog exists for ${workset.name}; run \`threadnote workset prepare ${workset.name}\`.`,
      );
    }
    if (!codeGraphWorksetCatalogGenerationMatches(workset, manifestDigest, published)) {
      return yield* CodeGraphWorksetCatalogError.of(
        'stale',
        `The published routing catalog for ${workset.name} is stale; run \`threadnote workset prepare ${workset.name}\`.`,
      );
    }
    const publishedByKey = new Map(EffectArray.map(published.members, member => [member.repositoryKey, member]));
    const observed = yield* Effect.forEach(
      workset.projects,
      project => observeRuntimeMember(config, project, publishedByKey.get(safeLabel(project.name)), fs, queryService),
      {concurrency: 8},
    );
    const members = EffectArray.map(observed, value => value.member);
    const deepMembers = new Map(
      EffectArray.flatMap(observed, value =>
        'deep' in value && value.deep !== undefined ? [[value.member.repositoryKey, value.deep] as const] : [],
      ),
    );
    return {
      deepMembers,
      input: {
        deadlineMilliseconds: options.deadlineMilliseconds,
        depth: options.depth,
        edgeLimit: options.edgeLimit,
        evidenceCards: options.evidenceCards,
        includeHeuristic: options.includeHeuristic,
        includeModelAssociations: options.includeModelAssociations,
        maximumEstimatedTokens: options.maximumEstimatedTokens,
        members,
        nodeLimit: options.nodeLimit,
        packageName: options.packageName,
        published,
        query: options.query,
        worksetName: workset.name,
      } satisfies CodeGraphWorksetQueryV2InputV1,
    };
  });
}

function observeRuntimeMember(
  config: RuntimeConfig,
  project: ProjectManifest,
  published: CodeGraphWorksetCatalogPublishedMemberV1 | undefined,
  fs: FileSystem.FileSystem,
  queryService: RuntimeQueryStatusService,
) {
  const repositoryKey = safeLabel(project.name);
  const fallbackRepositoryId = published?.repositoryId ?? Effect2.pipe('0', EffectString.repeat(64));
  return Effect.gen(function* () {
    const cwd = yield* expandPath(project.path);
    if (!(yield* fs.exists(cwd))) {
      return {
        member: {
          deepQueryEligible: false,
          receipt: {
            considered: false,
            deepQueried: false,
            repositoryId: fallbackRepositoryId,
            state: 'missing',
          },
          repositoryKey,
        } satisfies CodeGraphWorksetQueryV2MemberV1,
      };
    }
    const status = yield* published === undefined
      ? queryService.status(config.agentContextHome, cwd, {
          requestMaintenance: false,
          project: project.name,
          manifestPath: config.manifestPath,
        })
      : queryService.statusForPublishedIdentity(config.agentContextHome, cwd, published, {
          project: project.name,
          manifestPath: config.manifestPath,
          requestMaintenance: false,
        });
    const ready = status.readySnapshot;
    if (published === undefined) {
      return {
        member: {
          deepQueryEligible: false,
          receipt: {
            considered: false,
            deepQueried: false,
            repositoryId: status.identity.repositoryId,
            state: ready === undefined ? 'deferred' : 'excluded',
          },
          repositoryKey,
        } satisfies CodeGraphWorksetQueryV2MemberV1,
      };
    }
    const matches =
      ready !== undefined &&
      status.identity.repositoryId === published.repositoryId &&
      status.identity.checkoutId === published.checkoutId &&
      status.identity.worktreeId === published.worktreeId &&
      ready.id === published.snapshotId &&
      ready.commit === published.commitId;
    if (!matches || ready === undefined) {
      return {
        member: {
          deepQueryEligible: false,
          published,
          receipt: {
            considered: false,
            deepQueried: false,
            repositoryId: published.repositoryId,
            state: 'failed',
          },
          repositoryKey,
        } satisfies CodeGraphWorksetQueryV2MemberV1,
      };
    }
    const freshness = status.stale ? 'stale' : 'current';
    return {
      deep: {cwd, status} satisfies RuntimeDeepMember,
      member: {
        deepQueryEligible: true,
        published,
        receipt: {
          considered: true,
          ...(status.projectCoverage === undefined ? {} : {projectCoverage: status.projectCoverage}),
          deepQueried: false,
          repositoryId: published.repositoryId,
          snapshot: {
            checkoutId: published.checkoutId,
            commit: published.commitId,
            digest: published.snapshotDigest,
            dirty: ready.dirty,
            freshness,
            id: published.snapshotId,
            projectionDigest: published.projectionDigest,
            provenance: 'ready-snapshot',
            worktreeId: published.worktreeId,
          },
          state: freshness,
        },
        repositoryKey,
      } satisfies CodeGraphWorksetQueryV2MemberV1,
    };
  }).pipe(
    Effect.orElseSucceed(() => ({
      member: {
        deepQueryEligible: false,
        ...(published === undefined ? {} : {published}),
        receipt: {
          considered: false,
          deepQueried: false,
          repositoryId: fallbackRepositoryId,
          state: 'failed',
        },
        repositoryKey,
      } satisfies CodeGraphWorksetQueryV2MemberV1,
    })),
  );
}

function safeLabel(value: string): string {
  return Effect2.pipe(
    EffectArray.join(
      EffectArray.filter(
        [...value],
        character =>
          (Effect2.pipe(
            character,
            EffectString.codePointAt(0),
            Effect2.Option.getOrElse(() => undefined),
          ) ?? 0) > 0x1f,
      ),
      '',
    ),
    EffectString.slice(0, 256),
  );
}

function boundedText(value: string, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    Effect2.pipe(value, EffectString.trim).length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new Error(`Workset ${label} is invalid.`);
  }
  return Effect2.pipe(value, EffectString.trim);
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Workset ${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
