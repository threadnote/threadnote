import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {scriptError, ScriptError} from '../effect/errors.js';
import {Clock, Effect} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '@threadnote/graph/indexer';
import {
  publishCodeGraphWorksetCatalogGeneration,
  stageCodeGraphWorksetCatalogGenerationFromReceipts,
} from '@threadnote/graph/workset_catalog/store';
import {stageCodeGraphWorksetRoutingProjectionScoped} from '@threadnote/graph/workset_catalog/projection/builder';
import {
  codeGraphWorksetManifestDigest,
  prepareCodeGraphWorksetBridgesForGeneration,
} from '@threadnote/graph/workset_catalog/workset';
import {executeCodeGraphWorksetV2, type CodeGraphWorksetQueryV2ExecutionV1} from '@threadnote/graph/workset/query_v2';
import type {
  CodeGraphEvidenceCardV1,
  CodeGraphWorksetQueryResultV2,
  ProjectedCodeGraphWorksetEvidenceV1,
} from '@threadnote/graph/workset/evidence';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {requireWorkset} from '@threadnote/workspace/manifest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  CODE_GRAPH_WORKSET_EVALUATION_VERSION,
  codeGraphWorksetEdgeKey,
  parseCodeGraphWorksetEvaluationFixtureV1,
  type CodeGraphWorksetCoverageObservationV1,
  type CodeGraphWorksetEvaluationFixtureV1,
  type CodeGraphWorksetEvaluationMeasurementV1,
  type CodeGraphWorksetEvaluationObservationV1,
  type CodeGraphWorksetExpectedEdgeV1,
  type CodeGraphWorksetMemberState,
  type CodeGraphWorksetSymbolRefV1,
} from '@threadnote/threadnote/evaluation/code-graph-workset';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {benchmarkMeasurement, type BenchmarkMeasurementV1} from '@threadnote/evidence/benchmark';
import {
  CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES,
  CODE_GRAPH_WORKSET_FIXTURE_GENERATOR_VERSION,
  establishCodeGraphWorksetStaleReadySnapshot,
  type CodeGraphWorksetFixturePlan,
  type CodeGraphWorksetFixtureSize,
  type MaterializedCodeGraphWorksetFixtureRepository,
  type PreparedCodeGraphWorksetFixture,
} from './code-graph-workset-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

export const CODE_GRAPH_WORKSET_DEFAULT_NODE_LIMIT = 24;
export const CODE_GRAPH_WORKSET_DEFAULT_EVIDENCE_CARDS = 40;
export const CODE_GRAPH_WORKSET_DEFAULT_EDGE_LIMIT = 40;
export const CODE_GRAPH_WORKSET_AGENT_TOKEN_BUDGET = 1_500;
export const CODE_GRAPH_WORKSET_FIFTY_FIRST_EVIDENCE_P95_BUDGET_MS = 1_000;
export const CODE_GRAPH_WORKSET_FIFTY_COMPLETION_P95_BUDGET_MS = 3_000;
export const CODE_GRAPH_WORKSET_128_COMPLETION_P95_BUDGET_MS = 5_000;

export interface CodeGraphWorksetDeliveryMeasurementInput {
  readonly completionMilliseconds: number;
  readonly evidenceItemCount: number;
  readonly repositoriesConsidered: number;
  readonly repositoriesDeepQueried: number;
  readonly repositoryDatabasesOpened: number;
  readonly response: {
    readonly structuredContent?: unknown;
    readonly text?: string;
  };
}

export interface CodeGraphWorksetBenchmarkSample {
  readonly completionMilliseconds: number;
  readonly estimatedTokenCount: number;
  readonly evidenceItemCount: number;
  readonly repositoriesConsidered: number;
  readonly repositoriesDeepQueried: number;
  readonly repositoryDatabasesOpened: number;
  readonly requestedRepositories: number;
  readonly responseUtf8Bytes: number;
  readonly structuredResponseUtf8Bytes: number;
  readonly textResponseUtf8Bytes: number;
  readonly timeToFirstEvidenceMilliseconds: number;
  readonly worksetSize: number;
}

export interface MeasuredCodeGraphWorksetQuery {
  readonly measurement: CodeGraphWorksetEvaluationMeasurementV1;
  readonly response: ProjectedCodeGraphWorksetEvidenceV1;
  readonly result: CodeGraphWorksetQueryResultV2;
}

export function codeGraphWorksetRuntimeConfig(fixture: PreparedCodeGraphWorksetFixture): RuntimeConfig {
  return {
    account: 'evaluation',
    agentContextHome: fixture.home,
    agentId: 'code-graph-workset-harness',
    manifestPath: fixture.manifestPath,
    user: 'evaluation',
  };
}

/**
 * Adapts the path-independent generator plan to the versioned evaluation
 * contract. Impact and path remain typed intent categories, but V1 records
 * their operations as unsupported instead of running a text-query proxy.
 */
export function buildCodeGraphWorksetEvaluationFixture(
  plan: CodeGraphWorksetFixturePlan,
  requestedSizes: readonly CodeGraphWorksetFixtureSize[],
): CodeGraphWorksetEvaluationFixtureV1 {
  const sizes = [...requestedSizes];
  const usedArchetypes = new Set(EffectArray.map(plan.members, member => member.archetypeId));
  const searchableMembers = new Set(
    EffectArray.map(
      EffectArray.filter(
        plan.members,
        member => member.expectedState === 'current' || member.expectedState === 'stale',
      ),
      member => member.id,
    ),
  );
  const queries = EffectArray.flatMap(plan.queries, query => {
    const applicableSizes = EffectArrayPipe(query.sizes, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (size, __effectArrayIndex2) => __effectArrayIndex2 in __effectArrayValues && sizes.includes(size),
      ),
    );
    if (applicableSizes.length === 0) return [];
    const expectedEdges = EffectArrayPipe(query.expectedEdges, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (edge, __effectArrayIndex2) =>
          __effectArrayIndex2 in __effectArrayValues &&
          searchableMembers.has(edge.source.repositoryId) &&
          searchableMembers.has(edge.target.repositoryId),
      ),
    );
    const expectedRepositories = EffectArrayPipe(query.expectedRepositories, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (repositoryId, __effectArrayIndex2) =>
          __effectArrayIndex2 in __effectArrayValues && searchableMembers.has(repositoryId),
      ),
    );
    const expectedSymbols = EffectArrayPipe(query.expectedSymbols, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (symbol, __effectArrayIndex2) =>
          __effectArrayIndex2 in __effectArrayValues && searchableMembers.has(symbol.repositoryId),
      ),
    );
    return [
      {
        answerable: query.answerable,
        category: query.category,
        expectedEdges,
        expectedRepositories,
        expectedSymbols,
        id: query.id,
        operation: query.operation,
        query: query.query,
        sizes: applicableSizes,
      } as const,
    ];
  });
  return parseCodeGraphWorksetEvaluationFixtureV1({
    allowedAuthoritativeEdges: plan.allowedAuthoritativeEdges,
    generator: {
      archetypes: EffectArray.map(
        EffectArray.filter(
          CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES,
          (archetype, __effectArrayIndex) =>
            __effectArrayIndex in CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES && usedArchetypes.has(archetype.id),
        ),
        ({id, sha256}) => ({id, sha256}),
      ),
      name: plan.identity.generator,
      version: String(CODE_GRAPH_WORKSET_FIXTURE_GENERATOR_VERSION),
    },
    id: plan.identity.id,
    members: plan.members,
    queries,
    sizes,
    version: CODE_GRAPH_WORKSET_EVALUATION_VERSION,
    worksetId: plan.identity.worksetName,
  });
}

/** Indexes every materialized member whose fixture state permits a ready snapshot. */
export const indexPreparedCodeGraphWorksetFixture = Effect.fn('codeGraphWorksetHarness.indexFixture')(function* (
  fixture: PreparedCodeGraphWorksetFixture,
) {
  const indexer = yield* CodeGraphIndexer;
  yield* Effect.forEach(fixture.repositories, repository => indexFixtureRepository(indexer, fixture.home, repository), {
    concurrency: 2,
  });
});

/**
 * Publish prefix workset generations from the fixture's already-indexed ready
 * snapshots. This intentionally does not refresh or attach a repository, so
 * mixed-state evaluation preserves stale, cold, missing, and failed controls.
 */
const publishIndexedCodeGraphWorksetCatalogScoped = Effect.fn('codeGraphWorksetHarness.publishCatalogScoped')(
  function* (fixture: PreparedCodeGraphWorksetFixture, worksetNames: readonly string[]) {
    const query = yield* CodeGraphQueryService;
    const config = codeGraphWorksetRuntimeConfig(fixture);
    const staged = yield* Effect.forEach(
      fixture.repositories,
      repository =>
        query.status(fixture.home, repository.path, {requestMaintenance: false}).pipe(
          Effect.flatMap(status =>
            status.readySnapshot === undefined
              ? succeedUndefined
              : stageCodeGraphWorksetRoutingProjectionScoped({
                  identity: status.identity,
                  snapshotId: status.readySnapshot.id,
                  threadnoteHome: fixture.home,
                }).pipe(Effect.map(built => ({built, identity: status.identity, project: repository.projectName}))),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      {concurrency: 1},
    );
    const stagedByProject = new Map(
      EffectArray.flatMap(staged, value => (value === undefined ? [] : [[value.project, value] as const])),
    );
    for (const worksetName of worksetNames) {
      const workset = yield* requireWorkset(config.manifestPath, worksetName);
      const members = EffectArray.flatMap(workset.projects, project => {
        const stagedMember = stagedByProject.get(project.name);
        return stagedMember === undefined
          ? []
          : [
              {
                projectionDigest: stagedMember.built.receipt.projectionDigest,
                repositoryId: stagedMember.built.receipt.repositoryId,
                repositoryKey: project.name,
                snapshotId: stagedMember.built.receipt.snapshotId,
              },
            ];
      });
      if (members.length === 0) {
        return yield* ScriptError.make({message: `Fixture workset ${worksetName} has no ready routing projections.`});
      }
      const stagedGeneration = yield* stageCodeGraphWorksetCatalogGenerationFromReceipts(fixture.home, {
        manifestDigest: codeGraphWorksetManifestDigest(workset),
        members,
        worksetName,
      });
      const bridgeMembers = EffectArray.flatMap(workset.projects, project => {
        const stagedMember = stagedByProject.get(project.name);
        return stagedMember === undefined
          ? []
          : [
              {
                assertLease: stagedMember.built.assertLease,
                identity: stagedMember.identity,
                project: project.name,
                repositoryId: stagedMember.built.receipt.repositoryId,
                snapshotId: stagedMember.built.receipt.snapshotId,
              },
            ];
      });
      yield* prepareCodeGraphWorksetBridgesForGeneration(config, stagedGeneration.id, bridgeMembers);
      const assertLeases = () =>
        Effect.all(
          EffectArray.flatMap(workset.projects, project => {
            const stagedMember = stagedByProject.get(project.name);
            return stagedMember === undefined ? [] : [stagedMember.built.assertLease];
          }),
          {discard: true},
        );
      yield* publishCodeGraphWorksetCatalogGeneration(fixture.home, {
        beforePointerSwap: assertLeases,
        generationId: stagedGeneration.id,
        worksetName,
      });
    }
  },
);

export const publishIndexedCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetHarness.publishCatalog')(function* (
  fixture: PreparedCodeGraphWorksetFixture,
  worksetNames: readonly string[],
) {
  return yield* publishIndexedCodeGraphWorksetCatalogScoped(fixture, worksetNames).pipe(Effect.scoped);
});

export const measureCodeGraphWorksetQuery = Effect.fn('codeGraphWorksetHarness.measureQuery')(function* (
  config: RuntimeConfig,
  worksetName: string,
  query: string,
) {
  const started = yield* Clock.currentTimeNanos;
  const execution: CodeGraphWorksetQueryV2ExecutionV1 = yield* executeCodeGraphWorksetV2(config, {
    edgeLimit: CODE_GRAPH_WORKSET_DEFAULT_EDGE_LIMIT,
    evidenceCards: CODE_GRAPH_WORKSET_DEFAULT_EVIDENCE_CARDS,
    maximumEstimatedTokens: CODE_GRAPH_WORKSET_AGENT_TOKEN_BUDGET,
    nodeLimit: CODE_GRAPH_WORKSET_DEFAULT_NODE_LIMIT,
    query,
    worksetName,
  });
  const response = execution.projected;
  const result = execution.logicalResult;
  const finished = yield* Clock.currentTimeNanos;
  const completionMilliseconds = Number(finished - started) / NANOSECONDS_PER_MILLISECOND;
  const evidenceItemCount = returnedEvidenceItemCount(response);
  return {
    measurement: codeGraphWorksetDeliveryMeasurement({
      completionMilliseconds,
      evidenceItemCount,
      repositoriesConsidered: execution.instrumentation.repositoriesConsidered,
      repositoriesDeepQueried: execution.instrumentation.deepQueriedRepositories,
      repositoryDatabasesOpened: execution.instrumentation.databasesOpened,
      response,
    }),
    response,
    result,
  } satisfies MeasuredCodeGraphWorksetQuery;
});

/**
 * Workset Search 2.0 still delivers one complete buffered MCP response.
 * Consequently, when a card is present, delivered time-to-first-evidence
 * equals completion. The card count records only the compact projected cards
 * visible to the agent.
 */
export function codeGraphWorksetDeliveryMeasurement(
  input: CodeGraphWorksetDeliveryMeasurementInput,
): CodeGraphWorksetEvaluationMeasurementV1 {
  assertNonNegativeFinite(input.completionMilliseconds, 'completionMilliseconds');
  assertNonNegativeInteger(input.evidenceItemCount, 'evidenceItemCount');
  assertNonNegativeInteger(input.repositoriesConsidered, 'repositoriesConsidered');
  assertNonNegativeInteger(input.repositoriesDeepQueried, 'repositoriesDeepQueried');
  assertNonNegativeInteger(input.repositoryDatabasesOpened, 'repositoryDatabasesOpened');
  const response = measureAgentToolResponse(input.response);
  return {
    catalogBytesRead: 0,
    completionMilliseconds: input.completionMilliseconds,
    estimatedTokenCount: response.estimatedTokens,
    evidenceCardCount: input.evidenceItemCount,
    representativeTokenCounts: [],
    repositoriesConsidered: input.repositoriesConsidered,
    repositoriesDeepQueried: input.repositoriesDeepQueried,
    repositoryDatabasesOpened: input.repositoryDatabasesOpened,
    responseUtf8Bytes: response.totalBytes,
    structuredResponseUtf8Bytes: response.structuredBytes,
    textResponseUtf8Bytes: response.textBytes,
    ...(input.evidenceItemCount > 0 ? {timeToFirstEvidenceCardMilliseconds: input.completionMilliseconds} : {}),
    timeToFirstEvidenceSemantics: 'buffered-response',
  };
}

export function codeGraphWorksetObservationFromQuery(
  fixture: CodeGraphWorksetEvaluationFixtureV1,
  worksetSize: number,
  sampleId: string,
  queryId: string,
  measured: MeasuredCodeGraphWorksetQuery,
  worktree: {readonly leakageCount: number; readonly observationCount: number} = {
    leakageCount: 0,
    observationCount: 0,
  },
): CodeGraphWorksetEvaluationObservationV1 {
  const repositoryHits: string[] = [];
  const symbolHits: CodeGraphWorksetSymbolRefV1[] = [];
  const edges: CodeGraphWorksetExpectedEdgeV1[] = [];
  const cardsByRef = new Map(EffectArray.map(measured.result.cards, card => [card.ref, card] as const));
  // Relevance is scored over the persisted globally ranked sequence; response
  // bytes and delivered-card count are measured separately on the compact
  // first page. This keeps breadth quality independent from token envelope.
  for (const card of measured.result.cards) {
    const repositoryId = fixtureRepositoryId(fixture, card.repositoryKey);
    if (!repositoryId) continue;
    repositoryHits.push(repositoryId);
    symbolHits.push({repositoryId, symbol: `${card.symbol.path}#${card.symbol.name}`});
    for (const relationship of card.relationships) {
      const source = deliveredRelationshipEndpoint(
        relationship.source.repositoryKey,
        relationship.source.ref,
        cardsByRef,
        fixture,
      );
      const target = deliveredRelationshipEndpoint(
        relationship.target.repositoryKey,
        relationship.target.ref,
        cardsByRef,
        fixture,
      );
      if (source === undefined || target === undefined) continue;
      edges.push({
        provenance: relationship.provenance,
        relation: relationship.relation,
        source,
        target,
      });
    }
  }
  const deliveredEdges = uniqueEdges(edges);
  return {
    authoritativeEdges: EffectArray.filter(
      deliveredEdges,
      edge => edge.provenance === 'declared' || edge.provenance === 'resolved',
    ),
    coverage: codeGraphWorksetCoverage(fixture, worksetSize, measured.result),
    edges: deliveredEdges,
    execution: 'executed',
    measurement: measured.measurement,
    queryId,
    reportedNoAnswer: measured.result.cards.length === 0,
    repositoryHits: [...new Set(repositoryHits)],
    sampleId,
    symbolHits: uniqueSymbols(symbolHits),
    version: CODE_GRAPH_WORKSET_EVALUATION_VERSION,
    worksetSize,
    worktreeLeakageCount: worktree.leakageCount,
    worktreeObservationCount: worktree.observationCount,
  };
}

export function unsupportedCodeGraphWorksetObservation(
  fixture: CodeGraphWorksetEvaluationFixtureV1,
  worksetSize: number,
  sampleId: string,
  queryId: string,
  coverage: readonly CodeGraphWorksetCoverageObservationV1[],
): CodeGraphWorksetEvaluationObservationV1 {
  return {
    authoritativeEdges: [],
    coverage,
    edges: [],
    execution: 'unsupported-operation',
    queryId,
    reportedNoAnswer: false,
    repositoryHits: [],
    sampleId,
    symbolHits: [],
    version: CODE_GRAPH_WORKSET_EVALUATION_VERSION,
    worksetSize,
    worktreeLeakageCount: 0,
    worktreeObservationCount: 0,
  };
}

export type CodeGraphWorksetCoverageResult = Pick<CodeGraphWorksetQueryResultV2, 'repositories'>;

export function codeGraphWorksetCoverage(
  fixture: CodeGraphWorksetEvaluationFixtureV1,
  worksetSize: number,
  result: CodeGraphWorksetCoverageResult,
): readonly CodeGraphWorksetCoverageObservationV1[] {
  const activeMembers = EffectArray.filter(fixture.members, member => member.ordinal <= worksetSize);
  return EffectArray.flatMap(activeMembers, member => {
    const project = `workset-${member.id}`;
    const observed = result.repositories[project];
    return observed === undefined ? [] : [{repositoryId: member.id, state: memberState(observed.state)}];
  });
}

export function codeGraphWorksetBenchmarkSample(
  worksetSize: number,
  measured: MeasuredCodeGraphWorksetQuery,
): CodeGraphWorksetBenchmarkSample {
  const measurement = measured.measurement;
  if (measurement.evidenceCardCount === 0 || measurement.timeToFirstEvidenceCardMilliseconds === undefined) {
    throw ScriptError.make({message: `Workset benchmark control returned no evidence at size ${worksetSize}.`});
  }
  return {
    completionMilliseconds: measurement.completionMilliseconds,
    estimatedTokenCount: measurement.estimatedTokenCount,
    evidenceItemCount: measurement.evidenceCardCount,
    repositoriesConsidered: measurement.repositoriesConsidered,
    repositoriesDeepQueried: measurement.repositoriesDeepQueried,
    repositoryDatabasesOpened: measurement.repositoryDatabasesOpened,
    requestedRepositories: measured.result.coverage.requestedRepositories,
    responseUtf8Bytes: measurement.responseUtf8Bytes,
    structuredResponseUtf8Bytes: measurement.structuredResponseUtf8Bytes,
    textResponseUtf8Bytes: measurement.textResponseUtf8Bytes,
    timeToFirstEvidenceMilliseconds: measurement.timeToFirstEvidenceCardMilliseconds,
    worksetSize,
  };
}

export function codeGraphWorksetBenchmarkMeasurements(
  samples: readonly CodeGraphWorksetBenchmarkSample[],
): readonly BenchmarkMeasurementV1[] {
  const sizes = [...new Set(EffectArray.map(samples, sample => sample.worksetSize))].sort(
    (left, right) => left - right,
  );
  const measurements: BenchmarkMeasurementV1[] = [benchmarkMeasurement('workset-current-repository-cap', 'count', [0])];
  for (const size of sizes) {
    const selected = EffectArray.filter(samples, sample => sample.worksetSize === size);
    const prefix = `workset-${size}`;
    measurements.push(
      benchmarkMeasurement(
        `${prefix}-completion`,
        'milliseconds',
        EffectArray.map(selected, value => value.completionMilliseconds),
      ),
      benchmarkMeasurement(
        `${prefix}-delivered-time-to-first-evidence-buffered`,
        'milliseconds',
        EffectArray.map(selected, value => value.timeToFirstEvidenceMilliseconds),
      ),
      benchmarkMeasurement(
        `${prefix}-mcp-structured-response`,
        'bytes',
        EffectArray.map(selected, value => value.structuredResponseUtf8Bytes),
      ),
      benchmarkMeasurement(
        `${prefix}-mcp-text-response`,
        'bytes',
        EffectArray.map(selected, value => value.textResponseUtf8Bytes),
      ),
      benchmarkMeasurement(
        `${prefix}-total-agent-output`,
        'bytes',
        EffectArray.map(selected, value => value.responseUtf8Bytes),
      ),
      benchmarkMeasurement(
        `${prefix}-estimated-agent-tokens`,
        'count',
        EffectArray.map(selected, value => value.estimatedTokenCount),
      ),
      benchmarkMeasurement(
        `${prefix}-requested-repositories`,
        'count',
        EffectArray.map(selected, value => value.requestedRepositories),
      ),
      benchmarkMeasurement(
        `${prefix}-considered-repositories`,
        'count',
        EffectArray.map(selected, value => value.repositoriesConsidered),
      ),
      benchmarkMeasurement(
        `${prefix}-deep-queried-repositories`,
        'count',
        EffectArray.map(selected, value => value.repositoriesDeepQueried),
      ),
      benchmarkMeasurement(
        `${prefix}-opened-repository-databases`,
        'count',
        EffectArray.map(selected, value => value.repositoryDatabasesOpened),
      ),
      benchmarkMeasurement(
        `${prefix}-delivered-v2-evidence-cards`,
        'count',
        EffectArray.map(selected, value => value.evidenceItemCount),
      ),
    );
  }
  return measurements;
}

export function codeGraphWorksetBenchmarkBudgetFailures(
  measurements: readonly BenchmarkMeasurementV1[],
  requestedSizes: readonly number[],
): readonly string[] {
  const byName = new Map(EffectArray.map(measurements, measurement => [measurement.name, measurement]));
  const failures: string[] = [];
  const p95 = (name: string, maximum: number) => {
    const measurement = byName.get(name);
    if (measurement && measurement.p95 > maximum) {
      failures.push(`${name} p95 ${measurement.p95.toFixed(2)}ms exceeds ${maximum}ms`);
    }
  };
  if (requestedSizes.includes(50)) {
    p95('workset-50-delivered-time-to-first-evidence-buffered', CODE_GRAPH_WORKSET_FIFTY_FIRST_EVIDENCE_P95_BUDGET_MS);
    p95('workset-50-completion', CODE_GRAPH_WORKSET_FIFTY_COMPLETION_P95_BUDGET_MS);
  }
  if (requestedSizes.includes(128)) {
    p95('workset-128-completion', CODE_GRAPH_WORKSET_128_COMPLETION_P95_BUDGET_MS);
  }
  for (const size of requestedSizes) {
    const tokens = byName.get(`workset-${size}-estimated-agent-tokens`);
    if (tokens && tokens.maximum > CODE_GRAPH_WORKSET_AGENT_TOKEN_BUDGET) {
      failures.push(
        `workset-${size}-estimated-agent-tokens maximum ${tokens.maximum} exceeds ${CODE_GRAPH_WORKSET_AGENT_TOKEN_BUDGET}`,
      );
    }
  }
  return failures;
}

function indexFixtureRepository(
  indexer: CodeGraphIndexerShape,
  home: string,
  repository: MaterializedCodeGraphWorksetFixtureRepository,
) {
  if (!repository.exists || repository.state === 'cold' || repository.state === 'failed') return Effect.void;
  const index = (cwd: string) => indexer.index({cwd, threadnoteHome: home});
  if (repository.state === 'stale') {
    return Effect.tryPromise({
      try: () => establishCodeGraphWorksetStaleReadySnapshot(repository, cwd => Effect.runPromise(index(cwd))),
      catch: cause => scriptError(cause),
    }).pipe(Effect.asVoid);
  }
  return index(repository.path).pipe(
    Effect.andThen(
      repository.siblingWorktreePath ? index(repository.siblingWorktreePath).pipe(Effect.asVoid) : Effect.void,
    ),
    Effect.asVoid,
  );
}

function memberState(
  state: CodeGraphWorksetQueryResultV2['repositories'][string]['state'],
): CodeGraphWorksetMemberState {
  return state === 'excluded' ? 'failed' : state;
}

function returnedEvidenceItemCount(response: ProjectedCodeGraphWorksetEvidenceV1): number {
  return response.structuredContent.output.returnedCards;
}

function uniqueSymbols(symbols: readonly CodeGraphWorksetSymbolRefV1[]): readonly CodeGraphWorksetSymbolRefV1[] {
  const seen = new Set<string>();
  return EffectArray.filter(symbols, symbol => {
    const key = `${symbol.repositoryId}\u0000${symbol.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueEdges(edges: readonly CodeGraphWorksetExpectedEdgeV1[]): readonly CodeGraphWorksetExpectedEdgeV1[] {
  const seen = new Set<string>();
  return EffectArray.filter(edges, edge => {
    const key = codeGraphWorksetEdgeKey(edge);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deliveredRelationshipEndpoint(
  repositoryKey: string,
  ref: string,
  cardsByRef: ReadonlyMap<string, CodeGraphEvidenceCardV1>,
  fixture: CodeGraphWorksetEvaluationFixtureV1,
): CodeGraphWorksetSymbolRefV1 | undefined {
  const card = cardsByRef.get(ref);
  const repositoryId = fixtureRepositoryId(fixture, repositoryKey);
  return card === undefined || repositoryId === undefined
    ? undefined
    : {repositoryId, symbol: `${card.symbol.path}#${card.symbol.name}`};
}

function fixtureRepositoryId(fixture: CodeGraphWorksetEvaluationFixtureV1, repositoryKey: string): string | undefined {
  const id = Effect2.pipe(repositoryKey, EffectString.startsWith('workset-'))
    ? Effect2.pipe(repositoryKey, EffectString.slice('workset-'.length))
    : '';
  return EffectArray.some(fixture.members, member => member.id === id) ? id : undefined;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw ScriptError.make({message: `${label} must be a non-negative safe integer.`});
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0)
    throw ScriptError.make({message: `${label} must be a non-negative finite number.`});
}
