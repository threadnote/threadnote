import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphEdgeKey} from './code-graph.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

export const CODE_GRAPH_WORKSET_EVALUATION_VERSION = 1 as const;
export const CODE_GRAPH_WORKSET_BASELINE_VERSION = 1 as const;

export const CODE_GRAPH_WORKSET_EVALUATION_CATEGORIES = [
  'symbol',
  'package',
  'schema',
  'imports',
  'callers',
  'impact',
  'path',
  'concept',
  'no-answer',
] as const;

export const CODE_GRAPH_WORKSET_MEMBER_STATES = ['current', 'stale', 'deferred', 'missing', 'failed'] as const;
export const CODE_GRAPH_WORKSET_WORKTREE_STATES = ['clean', 'dirty'] as const;
export const CODE_GRAPH_WORKSET_FIRST_EVIDENCE_SEMANTICS = ['buffered-response', 'internal-candidate-ready'] as const;

export type CodeGraphWorksetEvaluationCategory = (typeof CODE_GRAPH_WORKSET_EVALUATION_CATEGORIES)[number];
export type CodeGraphWorksetEvaluationOperation = 'impact' | 'path' | 'query';
export type CodeGraphWorksetEvaluationExecution = 'executed' | 'unsupported-operation';
export type CodeGraphWorksetMemberState = (typeof CODE_GRAPH_WORKSET_MEMBER_STATES)[number];
export type CodeGraphWorksetWorktreeState = (typeof CODE_GRAPH_WORKSET_WORKTREE_STATES)[number];
export type CodeGraphWorksetFirstEvidenceSemantics = (typeof CODE_GRAPH_WORKSET_FIRST_EVIDENCE_SEMANTICS)[number];

export interface CodeGraphWorksetSymbolRefV1 {
  readonly repositoryId: string;
  readonly symbol: string;
}

export interface CodeGraphWorksetExpectedEdgeV1 {
  readonly provenance: string;
  readonly relation: string;
  readonly source: CodeGraphWorksetSymbolRefV1;
  readonly target: CodeGraphWorksetSymbolRefV1;
}

export interface CodeGraphWorksetRepositoryMemberV1 {
  readonly archetypeId: string;
  readonly expectedState: CodeGraphWorksetMemberState;
  readonly id: string;
  readonly ordinal: number;
  readonly worktree: {
    readonly isolation?: {
      readonly forbiddenMemberIds: readonly string[];
      readonly key: string;
    };
    readonly state: CodeGraphWorksetWorktreeState;
  };
}

export interface CodeGraphWorksetEvaluationQueryV1 {
  readonly answerable: boolean;
  readonly category: CodeGraphWorksetEvaluationCategory;
  readonly expectedEdges: readonly CodeGraphWorksetExpectedEdgeV1[];
  readonly expectedRepositories: readonly string[];
  readonly expectedSymbols: readonly CodeGraphWorksetSymbolRefV1[];
  readonly id: string;
  readonly operation: CodeGraphWorksetEvaluationOperation;
  readonly query?: string;
  readonly sizes: readonly number[];
}

export interface CodeGraphWorksetEvaluationFixtureV1 {
  readonly allowedAuthoritativeEdges: readonly CodeGraphWorksetExpectedEdgeV1[];
  readonly generator: {
    readonly archetypes: readonly {
      readonly id: string;
      readonly sha256: string;
    }[];
    readonly name: string;
    readonly version: string;
  };
  readonly id: string;
  readonly members: readonly CodeGraphWorksetRepositoryMemberV1[];
  readonly queries: readonly CodeGraphWorksetEvaluationQueryV1[];
  readonly sizes: readonly number[];
  readonly version: typeof CODE_GRAPH_WORKSET_EVALUATION_VERSION;
  readonly worksetId: string;
}

export interface CodeGraphWorksetCoverageObservationV1 {
  readonly repositoryId: string;
  readonly state: CodeGraphWorksetMemberState;
}

export interface CodeGraphWorksetTokenizerCountV1 {
  readonly count: number;
  readonly tokenizer: string;
}

export interface CodeGraphWorksetEvaluationMeasurementV1 {
  readonly catalogBytesRead: number;
  readonly completionMilliseconds: number;
  readonly estimatedTokenCount: number;
  readonly evidenceCardCount: number;
  readonly representativeTokenCounts: readonly CodeGraphWorksetTokenizerCountV1[];
  readonly repositoriesConsidered: number;
  readonly repositoriesDeepQueried: number;
  readonly repositoryDatabasesOpened: number;
  readonly responseUtf8Bytes: number;
  readonly structuredResponseUtf8Bytes: number;
  readonly textResponseUtf8Bytes: number;
  readonly timeToFirstEvidenceCardMilliseconds?: number;
  readonly timeToFirstEvidenceSemantics: CodeGraphWorksetFirstEvidenceSemantics;
}

export interface CodeGraphWorksetEvaluationObservationV1 {
  readonly authoritativeEdges: readonly CodeGraphWorksetExpectedEdgeV1[];
  readonly coverage: readonly CodeGraphWorksetCoverageObservationV1[];
  readonly edges: readonly CodeGraphWorksetExpectedEdgeV1[];
  readonly execution: CodeGraphWorksetEvaluationExecution;
  readonly measurement?: CodeGraphWorksetEvaluationMeasurementV1;
  readonly queryId: string;
  readonly reportedNoAnswer: boolean;
  readonly repositoryHits: readonly string[];
  readonly sampleId: string;
  readonly symbolHits: readonly CodeGraphWorksetSymbolRefV1[];
  readonly version: typeof CODE_GRAPH_WORKSET_EVALUATION_VERSION;
  readonly worksetSize: number;
  readonly worktreeLeakageCount: number;
  readonly worktreeObservationCount: number;
}

export interface CodeGraphWorksetTimingSummary {
  readonly maximum: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly sampleCount: number;
}

export interface CodeGraphWorksetMeasurementTotals {
  readonly catalogBytesRead: number;
  readonly estimatedTokenCount: number;
  readonly evidenceCardCount: number;
  readonly representativeTokenCounts: readonly CodeGraphWorksetTokenizerCountV1[];
  readonly repositoriesConsidered: number;
  readonly repositoriesDeepQueried: number;
  readonly repositoryDatabasesOpened: number;
  readonly responseUtf8Bytes: number;
  readonly structuredResponseUtf8Bytes: number;
  readonly textResponseUtf8Bytes: number;
}

export interface CodeGraphWorksetEvaluationMetrics {
  readonly aggregate: CodeGraphWorksetEvaluationMetricSet;
  readonly metricsBySize: readonly {
    readonly metrics: CodeGraphWorksetEvaluationMetricSet;
    readonly worksetSize: number;
  }[];
}

export interface CodeGraphWorksetEvaluationMetricSet {
  readonly answerableQueries: number;
  readonly authoritativeFalseEdgeRate: number;
  readonly completionMilliseconds: CodeGraphWorksetTimingSummary;
  readonly executedQueries: number;
  readonly coverageAccuracy: number;
  readonly edgeRecall: number;
  readonly meanReciprocalRank: number;
  readonly noAnswerPrecision: number;
  readonly noAnswerRecall: number;
  readonly queryCount: number;
  readonly repositoryRecallAt1: number;
  readonly repositoryRecallAt3: number;
  readonly repositoryRecallAt5: number;
  readonly symbolRecall: number;
  readonly timeToFirstEvidenceCardMilliseconds: CodeGraphWorksetTimingSummary;
  readonly timeToFirstEvidenceSemantics: CodeGraphWorksetFirstEvidenceSemantics;
  readonly totals: CodeGraphWorksetMeasurementTotals;
  readonly unsupportedOperationQueries: number;
  readonly unsupportedOperations: readonly {
    readonly count: number;
    readonly operation: Exclude<CodeGraphWorksetEvaluationOperation, 'query'>;
  }[];
  readonly worktreeLeakageRate: number;
}

export interface CodeGraphWorksetEvaluationBaselineV1 {
  readonly createdAt: string;
  readonly fixture: {
    readonly hash: string;
    readonly id: string;
    readonly members: number;
    readonly queries: number;
    readonly sizes: readonly number[];
    readonly version: number;
  };
  readonly metrics: CodeGraphWorksetEvaluationMetrics;
  readonly source: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly environment: string;
    readonly name: string;
    readonly version: string;
  };
  readonly version: typeof CODE_GRAPH_WORKSET_BASELINE_VERSION;
}

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Rate = NonNegativeFinite.check(Schema.isLessThanOrEqualTo(1));

const SymbolRefSchema = Schema.Struct({
  repositoryId: NonEmptyString,
  symbol: NonEmptyString,
});

const ExpectedEdgeSchema = Schema.Struct({
  provenance: NonEmptyString,
  relation: NonEmptyString,
  source: SymbolRefSchema,
  target: SymbolRefSchema,
});

const RepositoryMemberSchema = Schema.Struct({
  archetypeId: NonEmptyString,
  expectedState: Schema.Literals(CODE_GRAPH_WORKSET_MEMBER_STATES),
  id: NonEmptyString,
  ordinal: PositiveInteger,
  worktree: Schema.Struct({
    isolation: Schema.optionalKey(
      Schema.Struct({
        forbiddenMemberIds: Schema.Array(NonEmptyString),
        key: NonEmptyString,
      }),
    ),
    state: Schema.Literals(CODE_GRAPH_WORKSET_WORKTREE_STATES),
  }),
});

const QuerySchema = Schema.Struct({
  answerable: Schema.Boolean,
  category: Schema.Literals(CODE_GRAPH_WORKSET_EVALUATION_CATEGORIES),
  expectedEdges: Schema.Array(ExpectedEdgeSchema),
  expectedRepositories: Schema.Array(NonEmptyString),
  expectedSymbols: Schema.Array(SymbolRefSchema),
  id: NonEmptyString,
  operation: Schema.Literals(['impact', 'path', 'query']),
  query: Schema.optionalKey(NonEmptyString),
  sizes: Schema.Array(PositiveInteger),
});

export const CodeGraphWorksetEvaluationFixtureSchemaV1 = Schema.Struct({
  allowedAuthoritativeEdges: Schema.Array(ExpectedEdgeSchema),
  generator: Schema.Struct({
    archetypes: Schema.Array(
      Schema.Struct({
        id: NonEmptyString,
        sha256: NonEmptyString,
      }),
    ),
    name: NonEmptyString,
    version: NonEmptyString,
  }),
  id: NonEmptyString,
  members: Schema.Array(RepositoryMemberSchema),
  queries: Schema.Array(QuerySchema),
  sizes: Schema.Array(PositiveInteger),
  version: Schema.Literal(CODE_GRAPH_WORKSET_EVALUATION_VERSION),
  worksetId: NonEmptyString,
});

const CoverageObservationSchema = Schema.Struct({
  repositoryId: NonEmptyString,
  state: Schema.Literals(CODE_GRAPH_WORKSET_MEMBER_STATES),
});

const TokenizerCountSchema = Schema.Struct({
  count: NonNegativeInteger,
  tokenizer: NonEmptyString,
});

const MeasurementSchema = Schema.Struct({
  catalogBytesRead: NonNegativeInteger,
  completionMilliseconds: NonNegativeFinite,
  estimatedTokenCount: NonNegativeInteger,
  evidenceCardCount: NonNegativeInteger,
  representativeTokenCounts: Schema.Array(TokenizerCountSchema),
  repositoriesConsidered: NonNegativeInteger,
  repositoriesDeepQueried: NonNegativeInteger,
  repositoryDatabasesOpened: NonNegativeInteger,
  responseUtf8Bytes: NonNegativeInteger,
  structuredResponseUtf8Bytes: NonNegativeInteger,
  textResponseUtf8Bytes: NonNegativeInteger,
  timeToFirstEvidenceCardMilliseconds: Schema.optionalKey(NonNegativeFinite),
  timeToFirstEvidenceSemantics: Schema.Literals(CODE_GRAPH_WORKSET_FIRST_EVIDENCE_SEMANTICS),
});

export const CodeGraphWorksetEvaluationObservationSchemaV1 = Schema.Struct({
  authoritativeEdges: Schema.Array(ExpectedEdgeSchema),
  coverage: Schema.Array(CoverageObservationSchema),
  edges: Schema.Array(ExpectedEdgeSchema),
  execution: Schema.Literals(['executed', 'unsupported-operation']),
  measurement: Schema.optionalKey(MeasurementSchema),
  queryId: NonEmptyString,
  reportedNoAnswer: Schema.Boolean,
  repositoryHits: Schema.Array(NonEmptyString),
  sampleId: NonEmptyString,
  symbolHits: Schema.Array(SymbolRefSchema),
  version: Schema.Literal(CODE_GRAPH_WORKSET_EVALUATION_VERSION),
  worksetSize: PositiveInteger,
  worktreeLeakageCount: NonNegativeInteger,
  worktreeObservationCount: NonNegativeInteger,
});

const TimingSummarySchema = Schema.Struct({
  maximum: NonNegativeFinite,
  mean: NonNegativeFinite,
  p50: NonNegativeFinite,
  p95: NonNegativeFinite,
  sampleCount: NonNegativeInteger,
});

const MeasurementTotalsSchema = Schema.Struct({
  catalogBytesRead: NonNegativeInteger,
  estimatedTokenCount: NonNegativeInteger,
  evidenceCardCount: NonNegativeInteger,
  representativeTokenCounts: Schema.Array(TokenizerCountSchema),
  repositoriesConsidered: NonNegativeInteger,
  repositoriesDeepQueried: NonNegativeInteger,
  repositoryDatabasesOpened: NonNegativeInteger,
  responseUtf8Bytes: NonNegativeInteger,
  structuredResponseUtf8Bytes: NonNegativeInteger,
  textResponseUtf8Bytes: NonNegativeInteger,
});

export const CodeGraphWorksetEvaluationMetricSetSchema = Schema.Struct({
  answerableQueries: NonNegativeInteger,
  authoritativeFalseEdgeRate: Rate,
  completionMilliseconds: TimingSummarySchema,
  coverageAccuracy: Rate,
  edgeRecall: Rate,
  executedQueries: NonNegativeInteger,
  meanReciprocalRank: Rate,
  noAnswerPrecision: Rate,
  noAnswerRecall: Rate,
  queryCount: NonNegativeInteger,
  repositoryRecallAt1: Rate,
  repositoryRecallAt3: Rate,
  repositoryRecallAt5: Rate,
  symbolRecall: Rate,
  timeToFirstEvidenceCardMilliseconds: TimingSummarySchema,
  timeToFirstEvidenceSemantics: Schema.Literals(CODE_GRAPH_WORKSET_FIRST_EVIDENCE_SEMANTICS),
  totals: MeasurementTotalsSchema,
  unsupportedOperationQueries: NonNegativeInteger,
  unsupportedOperations: Schema.Array(
    Schema.Struct({
      count: NonNegativeInteger,
      operation: Schema.Literals(['impact', 'path']),
    }),
  ),
  worktreeLeakageRate: Rate,
});

export const CodeGraphWorksetEvaluationMetricsSchema = Schema.Struct({
  aggregate: CodeGraphWorksetEvaluationMetricSetSchema,
  metricsBySize: Schema.Array(
    Schema.Struct({
      metrics: CodeGraphWorksetEvaluationMetricSetSchema,
      worksetSize: PositiveInteger,
    }),
  ),
});

export const CodeGraphWorksetEvaluationBaselineSchemaV1 = Schema.Struct({
  createdAt: NonEmptyString,
  fixture: Schema.Struct({
    hash: NonEmptyString,
    id: NonEmptyString,
    members: NonNegativeInteger,
    queries: NonNegativeInteger,
    sizes: Schema.Array(PositiveInteger),
    version: NonNegativeInteger,
  }),
  metrics: CodeGraphWorksetEvaluationMetricsSchema,
  source: Schema.Struct({
    commit: NonEmptyString,
    dirty: Schema.Boolean,
    environment: NonEmptyString,
    name: NonEmptyString,
    version: NonEmptyString,
  }),
  version: Schema.Literal(CODE_GRAPH_WORKSET_BASELINE_VERSION),
});

export function parseCodeGraphWorksetEvaluationFixtureV1(value: unknown): CodeGraphWorksetEvaluationFixtureV1 {
  const fixture = Schema.decodeUnknownSync(CodeGraphWorksetEvaluationFixtureSchemaV1)(value);
  assertUnique(
    EffectArray.map(fixture.generator.archetypes, archetype => archetype.id),
    'workset archetype IDs',
  );
  assertUnique(
    EffectArray.map(fixture.members, member => member.id),
    'workset member IDs',
  );
  assertUnique(
    EffectArray.map(fixture.members, member => member.ordinal),
    'workset member ordinals',
  );
  assertUnique(
    EffectArray.map(fixture.queries, query => query.id),
    'workset query IDs',
  );
  assertUnique(fixture.sizes, 'workset fixture sizes');

  const archetypeIds = new Set(EffectArray.map(fixture.generator.archetypes, archetype => archetype.id));
  const memberIds = new Set(EffectArray.map(fixture.members, member => member.id));
  const memberOrdinals = new Map(EffectArray.map(fixture.members, member => [member.id, member.ordinal]));
  const sortedOrdinals = EffectArray.map(fixture.members, member => member.ordinal).sort((left, right) => left - right);
  if (EffectArray.some(sortedOrdinals, (ordinal, index) => ordinal !== index + 1)) {
    throw new Error('Workset member ordinals must form the contiguous range 1..members.length.');
  }
  for (const size of fixture.sizes) {
    if (size > fixture.members.length) {
      throw new Error(`Workset fixture size ${size} exceeds its ${fixture.members.length} members.`);
    }
  }
  for (const member of fixture.members) {
    if (!archetypeIds.has(member.archetypeId)) {
      throw new Error(`Workset member ${member.id} references unknown archetype ${member.archetypeId}.`);
    }
    const forbidden = member.worktree.isolation?.forbiddenMemberIds ?? [];
    assertUnique(forbidden, `forbidden member IDs for ${member.id}`);
    for (const forbiddenMemberId of forbidden) {
      if (forbiddenMemberId === member.id) {
        throw new Error(`Workset member ${member.id} cannot forbid itself in its isolation contract.`);
      }
      assertKnownMember(forbiddenMemberId, memberIds, `isolation contract for ${member.id}`);
    }
  }

  const allowedEdgeKeys = new Set<string>();
  for (const edge of fixture.allowedAuthoritativeEdges) {
    assertEdgeMembers(edge, memberIds, 'allowed authoritative edge');
    const key = codeGraphWorksetEdgeKey(edge);
    if (allowedEdgeKeys.has(key)) throw new Error(`Duplicate allowed authoritative workset edge: ${key}.`);
    allowedEdgeKeys.add(key);
  }

  for (const query of fixture.queries) {
    if (!query.query) {
      throw new Error(`Workset query ${query.id} requires query text.`);
    }
    if (query.category === 'no-answer' && query.answerable) {
      throw new Error(`No-answer workset query ${query.id} cannot be answerable.`);
    }
    if (!query.answerable && query.category !== 'no-answer') {
      throw new Error(`Unanswerable workset query ${query.id} must use the no-answer category.`);
    }
    assertUnique(query.expectedRepositories, `expected repositories for ${query.id}`);
    assertUnique(query.sizes, `fixture sizes for ${query.id}`);
    if (query.sizes.length === 0) throw new Error(`Workset query ${query.id} must apply to at least one fixture size.`);
    for (const size of query.sizes) {
      if (!fixture.sizes.includes(size)) {
        throw new Error(`Workset query ${query.id} references undeclared fixture size ${size}.`);
      }
    }
    assertUnique(EffectArray.map(query.expectedSymbols, codeGraphWorksetSymbolKey), `expected symbols for ${query.id}`);
    assertUnique(EffectArray.map(query.expectedEdges, codeGraphWorksetEdgeKey), `expected edges for ${query.id}`);
    for (const repositoryId of query.expectedRepositories) {
      assertKnownMember(repositoryId, memberIds, `query ${query.id}`);
      for (const size of query.sizes) {
        if (memberOrdinals.get(repositoryId)! > size) {
          throw new Error(`Expected repository ${repositoryId} is absent from size ${size} for query ${query.id}.`);
        }
      }
    }
    for (const symbol of query.expectedSymbols) {
      assertKnownMember(symbol.repositoryId, memberIds, `query ${query.id} symbol expectation`);
      assertMemberPresentAtSizes(
        symbol.repositoryId,
        query.sizes,
        memberOrdinals,
        `query ${query.id} symbol expectation`,
      );
    }
    for (const edge of query.expectedEdges) {
      assertEdgeMembers(edge, memberIds, `query ${query.id}`);
      assertMemberPresentAtSizes(
        edge.source.repositoryId,
        query.sizes,
        memberOrdinals,
        `query ${query.id} edge source`,
      );
      assertMemberPresentAtSizes(
        edge.target.repositoryId,
        query.sizes,
        memberOrdinals,
        `query ${query.id} edge target`,
      );
      if (!allowedEdgeKeys.has(codeGraphWorksetEdgeKey(edge))) {
        throw new Error(`Expected workset edge for ${query.id} is not allowed as authoritative.`);
      }
    }
    if (
      !query.answerable &&
      (query.expectedRepositories.length > 0 || query.expectedSymbols.length > 0 || query.expectedEdges.length > 0)
    ) {
      throw new Error(`No-answer workset query ${query.id} cannot declare expected results.`);
    }
    if (query.answerable && query.expectedRepositories.length === 0) {
      throw new Error(`Answerable workset query ${query.id} must declare at least one expected repository.`);
    }
  }
  for (const size of fixture.sizes) {
    if (!EffectArray.some(fixture.queries, query => query.operation === 'query' && query.sizes.includes(size))) {
      throw new Error(`Workset fixture size ${size} requires at least one currently executable query operation.`);
    }
  }
  return fixture;
}

export function parseCodeGraphWorksetEvaluationObservationV1(value: unknown): CodeGraphWorksetEvaluationObservationV1 {
  const observation = Schema.decodeUnknownSync(CodeGraphWorksetEvaluationObservationSchemaV1)(value);
  assertUnique(observation.repositoryHits, `repository hits for ${observation.queryId}`);
  assertUnique(
    EffectArray.map(observation.symbolHits, codeGraphWorksetSymbolKey),
    `symbol hits for ${observation.queryId}`,
  );
  assertUnique(
    EffectArray.map(observation.coverage, entry => entry.repositoryId),
    `coverage entries for ${observation.queryId}`,
  );
  for (const edge of observation.authoritativeEdges) {
    if (edge.provenance !== 'declared' && edge.provenance !== 'resolved') {
      throw new Error(
        `Authoritative workset edge for ${observation.queryId} must use declared or resolved provenance.`,
      );
    }
  }
  if (observation.execution === 'executed' && !observation.measurement) {
    throw new Error(`Executed workset observation ${observation.queryId} requires a measurement.`);
  }
  if (observation.execution === 'unsupported-operation' && observation.measurement) {
    throw new Error(`Unsupported workset observation ${observation.queryId} cannot contain a measurement.`);
  }
  if (observation.measurement) {
    assertUnique(
      EffectArray.map(observation.measurement.representativeTokenCounts, entry => entry.tokenizer),
      `representative tokenizers for ${observation.queryId}`,
    );
    const firstEvidence = observation.measurement.timeToFirstEvidenceCardMilliseconds;
    if (
      observation.measurement.structuredResponseUtf8Bytes + observation.measurement.textResponseUtf8Bytes !==
      observation.measurement.responseUtf8Bytes
    ) {
      throw new Error(
        `Structured and text response bytes must sum to total response bytes for ${observation.queryId}.`,
      );
    }
    if (observation.measurement.evidenceCardCount > 0 && firstEvidence === undefined) {
      throw new Error(`Evidence-producing observation ${observation.queryId} requires a first-evidence time.`);
    }
    if (firstEvidence !== undefined && firstEvidence > observation.measurement.completionMilliseconds) {
      throw new Error(`First-evidence time exceeds completion time for ${observation.queryId}.`);
    }
    if (
      firstEvidence !== undefined &&
      observation.measurement.timeToFirstEvidenceSemantics === 'buffered-response' &&
      firstEvidence !== observation.measurement.completionMilliseconds
    ) {
      throw new Error(`Buffered first-evidence time must equal completion time for ${observation.queryId}.`);
    }
  }
  if (observation.worktreeLeakageCount > observation.worktreeObservationCount) {
    throw new Error(`Worktree leakage count exceeds observations for ${observation.queryId}.`);
  }
  if (
    observation.reportedNoAnswer &&
    (observation.symbolHits.length > 0 ||
      observation.edges.length > 0 ||
      (observation.measurement?.evidenceCardCount ?? 0) > 0)
  ) {
    throw new Error(`No-answer observation ${observation.queryId} cannot contain returned evidence.`);
  }
  if (
    observation.execution === 'unsupported-operation' &&
    (observation.authoritativeEdges.length > 0 ||
      observation.edges.length > 0 ||
      observation.repositoryHits.length > 0 ||
      observation.symbolHits.length > 0 ||
      observation.reportedNoAnswer ||
      observation.worktreeLeakageCount > 0 ||
      observation.worktreeObservationCount > 0)
  ) {
    throw new Error(`Unsupported workset observation ${observation.queryId} cannot fabricate execution evidence.`);
  }
  return observation;
}

export function parseCodeGraphWorksetEvaluationBaselineV1(value: unknown): CodeGraphWorksetEvaluationBaselineV1 {
  const baseline = Schema.decodeUnknownSync(CodeGraphWorksetEvaluationBaselineSchemaV1)(value);
  assertUnique(baseline.fixture.sizes, 'baseline fixture sizes');
  assertUnique(
    EffectArray.map(baseline.metrics.metricsBySize, entry => entry.worksetSize),
    'baseline metric sizes',
  );
  const fixtureSizes = [...baseline.fixture.sizes].sort((left, right) => left - right);
  const metricSizes = EffectArray.map(baseline.metrics.metricsBySize, entry => entry.worksetSize).sort(
    (left, right) => left - right,
  );
  if (JSON.stringify(metricSizes) !== JSON.stringify(fixtureSizes)) {
    throw new Error('Baseline metric sizes must exactly match its fixture sizes.');
  }
  for (const metricSet of [
    baseline.metrics.aggregate,
    ...EffectArray.map(baseline.metrics.metricsBySize, entry => entry.metrics),
  ]) {
    assertUnique(
      EffectArray.map(metricSet.unsupportedOperations, entry => entry.operation),
      'baseline unsupported operations',
    );
  }
  return baseline;
}

export function serializeCodeGraphWorksetEvaluationFixtureIdentity(
  fixture: CodeGraphWorksetEvaluationFixtureV1,
): string {
  const canonical = {
    allowedAuthoritativeEdges: EffectArray.map(fixture.allowedAuthoritativeEdges, canonicalEdge).sort(compareEdge),
    generator: {
      archetypes: EffectArray.map(fixture.generator.archetypes, archetype => ({
        id: archetype.id,
        sha256: archetype.sha256,
      })).sort(compareJson),
      name: fixture.generator.name,
      version: fixture.generator.version,
    },
    id: fixture.id,
    members: EffectArray.map([...fixture.members], member => ({
      archetypeId: member.archetypeId,
      expectedState: member.expectedState,
      id: member.id,
      ordinal: member.ordinal,
      worktree: {
        ...(member.worktree.isolation
          ? {
              isolation: {
                forbiddenMemberIds: [...member.worktree.isolation.forbiddenMemberIds].sort(),
                key: member.worktree.isolation.key,
              },
            }
          : {}),
        state: member.worktree.state,
      },
    })).sort((left, right) => Effect.pipe(left.id, EffectString.localeCompare(right.id))),
    queries: EffectArray.map([...fixture.queries], query => ({
      answerable: query.answerable,
      category: query.category,
      expectedEdges: EffectArray.map(query.expectedEdges, canonicalEdge).sort(compareEdge),
      expectedRepositories: [...query.expectedRepositories].sort(),
      expectedSymbols: EffectArray.map(query.expectedSymbols, canonicalSymbol).sort(compareSymbol),
      id: query.id,
      operation: query.operation,
      ...(query.query ? {query: query.query} : {}),
      sizes: [...query.sizes].sort((left, right) => left - right),
    })).sort((left, right) => Effect.pipe(left.id, EffectString.localeCompare(right.id))),
    sizes: [...fixture.sizes].sort((left, right) => left - right),
    version: fixture.version,
    worksetId: fixture.worksetId,
  };
  return `${JSON.stringify(canonical, undefined, 2)}\n`;
}

export function codeGraphWorksetEvaluationFixtureHash(fixture: CodeGraphWorksetEvaluationFixtureV1): string {
  return sha256HexSync(serializeCodeGraphWorksetEvaluationFixtureIdentity(fixture));
}

export function codeGraphWorksetSymbolKey(symbol: CodeGraphWorksetSymbolRefV1): string {
  return `${symbol.repositoryId}\u0000${symbol.symbol}`;
}

export function codeGraphWorksetEdgeKey(edge: CodeGraphWorksetExpectedEdgeV1): string {
  return codeGraphEdgeKey({
    provenance: edge.provenance,
    relation: edge.relation,
    source: codeGraphWorksetSymbolKey(edge.source),
    target: codeGraphWorksetSymbolKey(edge.target),
  });
}

export function evaluateCodeGraphWorksetObservations(
  fixture: CodeGraphWorksetEvaluationFixtureV1,
  input: readonly CodeGraphWorksetEvaluationObservationV1[],
): CodeGraphWorksetEvaluationMetrics {
  const observations = EffectArray.map(input, parseCodeGraphWorksetEvaluationObservationV1);
  assertUnique(
    EffectArray.map(
      observations,
      observation => `${observation.worksetSize}\u0000${observation.sampleId}\u0000${observation.queryId}`,
    ),
    'workset observation size/sample/query identities',
  );
  const fixtureSizes = new Set(fixture.sizes);
  const queryById = new Map(EffectArray.map(fixture.queries, query => [query.id, query]));
  const memberOrdinals = new Map(EffectArray.map(fixture.members, member => [member.id, member.ordinal]));
  const groups = new Map<string, CodeGraphWorksetEvaluationObservationV1[]>();
  for (const observation of observations) {
    if (!fixtureSizes.has(observation.worksetSize)) {
      throw new Error(`Unknown workset observation size: ${observation.worksetSize}.`);
    }
    const query = queryById.get(observation.queryId);
    if (!query) {
      throw new Error(`Unknown workset observation query ID: ${observation.queryId}.`);
    }
    if (!query.sizes.includes(observation.worksetSize)) {
      throw new Error(`Workset query ${query.id} does not apply at size ${observation.worksetSize}.`);
    }
    if (query.operation === 'query' && observation.execution === 'unsupported-operation') {
      throw new Error(`Supported workset query operation ${query.id} cannot be recorded as unsupported.`);
    }
    const activeMemberIds = new Set(
      EffectArray.map(
        EffectArray.filter(fixture.members, member => member.ordinal <= observation.worksetSize),
        member => member.id,
      ),
    );
    for (const repositoryId of observation.repositoryHits) {
      assertKnownMember(
        repositoryId,
        activeMemberIds,
        `repository hits for ${query.id} at size ${observation.worksetSize}`,
      );
    }
    for (const symbol of observation.symbolHits) {
      assertKnownMember(
        symbol.repositoryId,
        activeMemberIds,
        `symbol hits for ${query.id} at size ${observation.worksetSize}`,
      );
    }
    for (const edge of [...observation.edges, ...observation.authoritativeEdges]) {
      assertEdgeMembers(edge, activeMemberIds, `edge observation for ${query.id} at size ${observation.worksetSize}`);
    }
    for (const coverage of observation.coverage) {
      assertKnownMember(
        coverage.repositoryId,
        activeMemberIds,
        `coverage for ${query.id} at size ${observation.worksetSize}`,
      );
    }
    const groupKey = `${observation.worksetSize}\u0000${observation.sampleId}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), observation]);
  }
  for (const size of fixture.sizes) {
    if (!EffectArray.some([...groups.values()], group => group[0]?.worksetSize === size)) {
      throw new Error(`Missing workset observations for fixture size ${size}.`);
    }
  }
  for (const [groupKey, group] of groups) {
    const size = group[0].worksetSize;
    const expectedQueryIds = new Set(
      EffectArray.map(
        EffectArrayPipe(fixture.queries, __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (query, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && query.sizes.includes(size),
          ),
        ),
        query => query.id,
      ),
    );
    const observedQueryIds = new Set(EffectArray.map(group, observation => observation.queryId));
    for (const queryId of expectedQueryIds) {
      if (!observedQueryIds.has(queryId)) throw new Error(`Missing workset observation for ${queryId} in ${groupKey}.`);
    }
    for (const queryId of observedQueryIds) {
      if (!expectedQueryIds.has(queryId))
        throw new Error(`Unexpected workset observation for ${queryId} in ${groupKey}.`);
    }
  }

  return {
    aggregate: evaluateCodeGraphWorksetMetricSet(fixture, observations, queryById, memberOrdinals),
    metricsBySize: EffectArray.map(
      [...fixture.sizes].sort((left, right) => left - right),
      worksetSize => ({
        metrics: evaluateCodeGraphWorksetMetricSet(
          fixture,
          EffectArray.filter(observations, observation => observation.worksetSize === worksetSize),
          queryById,
          memberOrdinals,
        ),
        worksetSize,
      }),
    ),
  };
}

function evaluateCodeGraphWorksetMetricSet(
  fixture: CodeGraphWorksetEvaluationFixtureV1,
  observations: readonly CodeGraphWorksetEvaluationObservationV1[],
  queryById: ReadonlyMap<string, CodeGraphWorksetEvaluationQueryV1>,
  memberOrdinals: ReadonlyMap<string, number>,
): CodeGraphWorksetEvaluationMetricSet {
  const expectedMemberStates = new Map(EffectArray.map(fixture.members, member => [member.id, member.expectedState]));
  const allowedAuthoritativeEdgeKeys = new Set(
    EffectArray.map(fixture.allowedAuthoritativeEdges, codeGraphWorksetEdgeKey),
  );
  let answerableQueries = 0;
  let repositoryRecallAt1 = 0;
  let repositoryRecallAt3 = 0;
  let repositoryRecallAt5 = 0;
  let reciprocalRank = 0;
  let expectedSymbolCount = 0;
  let hitSymbolCount = 0;
  let expectedEdgeCount = 0;
  let hitEdgeCount = 0;
  let predictedNoAnswer = 0;
  let expectedNoAnswer = 0;
  let trueNoAnswer = 0;
  let falseAuthoritativeEdges = 0;
  let authoritativeEdges = 0;
  let correctCoverageStates = 0;
  let expectedCoverageStates = 0;
  let worktreeLeakageCount = 0;
  let worktreeObservationCount = 0;
  const unsupportedOperations = new Map<'impact' | 'path', number>();

  for (const observation of observations) {
    const query = queryById.get(observation.queryId)!;
    const activeMembers = EffectArray.filter(
      fixture.members,
      member => (memberOrdinals.get(member.id) ?? Infinity) <= observation.worksetSize,
    );
    const observedCoverage = new Map(EffectArray.map(observation.coverage, entry => [entry.repositoryId, entry.state]));
    expectedCoverageStates += activeMembers.length;
    correctCoverageStates += EffectArray.filter(
      activeMembers,
      member => observedCoverage.get(member.id) === expectedMemberStates.get(member.id),
    ).length;

    if (observation.execution === 'unsupported-operation') {
      if (query.operation === 'query') throw new Error(`Query operation ${query.id} cannot be unsupported.`);
      unsupportedOperations.set(query.operation, (unsupportedOperations.get(query.operation) ?? 0) + 1);
      continue;
    }

    if (query.answerable) {
      answerableQueries += 1;
      const expectedRepositories = new Set(query.expectedRepositories);
      repositoryRecallAt1 += recallAt(observation.repositoryHits, expectedRepositories, 1);
      repositoryRecallAt3 += recallAt(observation.repositoryHits, expectedRepositories, 3);
      repositoryRecallAt5 += recallAt(observation.repositoryHits, expectedRepositories, 5);
      const expectedSymbols = new Set(EffectArray.map(query.expectedSymbols, codeGraphWorksetSymbolKey));
      const firstRelevantSymbol = EffectOption.getOrElse(
        EffectArray.findFirstIndex(
          observation.symbolHits,
          __effectArrayValue =>
            !!(symbol => expectedSymbols.has(codeGraphWorksetSymbolKey(symbol)))(__effectArrayValue),
        ),
        () => -1,
      );
      const firstRelevantRepository = EffectOption.getOrElse(
        EffectArray.findFirstIndex(
          observation.repositoryHits,
          __effectArrayValue => !!(repositoryId => expectedRepositories.has(repositoryId))(__effectArrayValue),
        ),
        () => -1,
      );
      const rank = expectedSymbols.size > 0 ? firstRelevantSymbol : firstRelevantRepository;
      if (rank >= 0) reciprocalRank += 1 / (rank + 1);
    }

    const expectedSymbols = new Set(EffectArray.map(query.expectedSymbols, codeGraphWorksetSymbolKey));
    const observedSymbols = new Set(EffectArray.map(observation.symbolHits, codeGraphWorksetSymbolKey));
    expectedSymbolCount += expectedSymbols.size;
    hitSymbolCount += countIntersection(expectedSymbols, observedSymbols);

    const expectedEdges = new Set(EffectArray.map(query.expectedEdges, codeGraphWorksetEdgeKey));
    const observedEdges = new Set(EffectArray.map(observation.edges, codeGraphWorksetEdgeKey));
    expectedEdgeCount += expectedEdges.size;
    hitEdgeCount += countIntersection(expectedEdges, observedEdges);

    // This evaluator's false-edge contract is specifically cross-repository.
    // Repository-local declared/resolved edges remain useful recall evidence,
    // but they are governed by the existing single-repository graph suite.
    const actualAuthoritativeEdges = new Set(
      EffectArray.map(
        EffectArray.filter(
          observation.authoritativeEdges,
          edge => edge.source.repositoryId !== edge.target.repositoryId,
        ),
        codeGraphWorksetEdgeKey,
      ),
    );
    authoritativeEdges += actualAuthoritativeEdges.size;
    falseAuthoritativeEdges += EffectArray.filter(
      [...actualAuthoritativeEdges],
      edge => !allowedAuthoritativeEdgeKeys.has(edge),
    ).length;

    if (observation.reportedNoAnswer) predictedNoAnswer += 1;
    if (!query.answerable) {
      expectedNoAnswer += 1;
      if (observation.reportedNoAnswer) trueNoAnswer += 1;
    }

    worktreeLeakageCount += observation.worktreeLeakageCount;
    worktreeObservationCount += observation.worktreeObservationCount;
  }

  const executed = EffectArray.filter(observations, observation => observation.execution === 'executed');
  const measurements = EffectArray.map(executed, observation => observation.measurement!);
  const firstEvidenceSemantics = new Set(
    EffectArray.map(measurements, measurement => measurement.timeToFirstEvidenceSemantics),
  );
  if (firstEvidenceSemantics.size !== 1) {
    throw new Error('A workset metric set requires exactly one first-evidence timing semantic.');
  }
  return {
    answerableQueries,
    authoritativeFalseEdgeRate: failureRate(falseAuthoritativeEdges, authoritativeEdges),
    completionMilliseconds: summarizeTimings(
      EffectArray.map(measurements, measurement => measurement.completionMilliseconds),
    ),
    coverageAccuracy: ratio(correctCoverageStates, expectedCoverageStates),
    edgeRecall: ratio(hitEdgeCount, expectedEdgeCount),
    executedQueries: executed.length,
    meanReciprocalRank: ratio(reciprocalRank, answerableQueries),
    noAnswerPrecision: ratio(trueNoAnswer, predictedNoAnswer),
    noAnswerRecall: ratio(trueNoAnswer, expectedNoAnswer),
    queryCount: observations.length,
    repositoryRecallAt1: ratio(repositoryRecallAt1, answerableQueries),
    repositoryRecallAt3: ratio(repositoryRecallAt3, answerableQueries),
    repositoryRecallAt5: ratio(repositoryRecallAt5, answerableQueries),
    symbolRecall: ratio(hitSymbolCount, expectedSymbolCount),
    timeToFirstEvidenceCardMilliseconds: summarizeTimings(
      EffectArray.flatMap(measurements, measurement =>
        measurement.timeToFirstEvidenceCardMilliseconds === undefined
          ? []
          : [measurement.timeToFirstEvidenceCardMilliseconds],
      ),
    ),
    timeToFirstEvidenceSemantics: [...firstEvidenceSemantics][0],
    totals: totalMeasurements(measurements),
    unsupportedOperationQueries: observations.length - executed.length,
    unsupportedOperations: EffectArray.map([...unsupportedOperations], ([operation, count]) => ({
      count,
      operation,
    })).sort((left, right) => Effect.pipe(left.operation, EffectString.localeCompare(right.operation))),
    worktreeLeakageRate: failureRate(worktreeLeakageCount, worktreeObservationCount),
  };
}

function totalMeasurements(
  measurements: readonly CodeGraphWorksetEvaluationMeasurementV1[],
): CodeGraphWorksetMeasurementTotals {
  const tokenCounts = new Map<string, number>();
  const totals = {
    catalogBytesRead: 0,
    estimatedTokenCount: 0,
    evidenceCardCount: 0,
    repositoriesConsidered: 0,
    repositoriesDeepQueried: 0,
    repositoryDatabasesOpened: 0,
    responseUtf8Bytes: 0,
    structuredResponseUtf8Bytes: 0,
    textResponseUtf8Bytes: 0,
  };
  for (const measurement of measurements) {
    totals.catalogBytesRead += measurement.catalogBytesRead;
    totals.estimatedTokenCount += measurement.estimatedTokenCount;
    totals.evidenceCardCount += measurement.evidenceCardCount;
    totals.repositoriesConsidered += measurement.repositoriesConsidered;
    totals.repositoriesDeepQueried += measurement.repositoriesDeepQueried;
    totals.repositoryDatabasesOpened += measurement.repositoryDatabasesOpened;
    totals.responseUtf8Bytes += measurement.responseUtf8Bytes;
    totals.structuredResponseUtf8Bytes += measurement.structuredResponseUtf8Bytes;
    totals.textResponseUtf8Bytes += measurement.textResponseUtf8Bytes;
    for (const entry of measurement.representativeTokenCounts) {
      tokenCounts.set(entry.tokenizer, (tokenCounts.get(entry.tokenizer) ?? 0) + entry.count);
    }
  }
  return {
    ...totals,
    representativeTokenCounts: EffectArray.map([...tokenCounts], ([tokenizer, count]) => ({count, tokenizer})).sort(
      (left, right) => Effect.pipe(left.tokenizer, EffectString.localeCompare(right.tokenizer)),
    ),
  };
}

function summarizeTimings(values: readonly number[]): CodeGraphWorksetTimingSummary {
  if (values.length === 0) return {maximum: 0, mean: 0, p50: 0, p95: 0, sampleCount: 0};
  const sorted = [...values].sort((left, right) => left - right);
  return {
    maximum: sorted.at(-1)!,
    mean: EffectArray.reduce(sorted, 0, (total, value) => total + value) / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    sampleCount: sorted.length,
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function recallAt(hits: readonly string[], expected: ReadonlySet<string>, limit: number): number {
  const selectedHits = hits.slice(0, limit);
  return ratio(
    new Set(EffectArray.filter(selectedHits, (hit, index) => index in selectedHits && expected.has(hit))).size,
    expected.size,
  );
}

function countIntersection(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  return EffectArray.filter([...left], value => right.has(value)).length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function failureRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function assertUnique(values: readonly (number | string)[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

function assertKnownMember(memberId: string, memberIds: ReadonlySet<string>, context: string): void {
  if (!memberIds.has(memberId)) throw new Error(`Unknown workset member ${memberId} in ${context}.`);
}

function assertEdgeMembers(
  edge: CodeGraphWorksetExpectedEdgeV1,
  memberIds: ReadonlySet<string>,
  context: string,
): void {
  assertKnownMember(edge.source.repositoryId, memberIds, `${context} source`);
  assertKnownMember(edge.target.repositoryId, memberIds, `${context} target`);
}

function assertMemberPresentAtSizes(
  memberId: string,
  sizes: readonly number[],
  memberOrdinals: ReadonlyMap<string, number>,
  context: string,
): void {
  for (const size of sizes) {
    if ((memberOrdinals.get(memberId) ?? Infinity) > size) {
      throw new Error(`Workset member ${memberId} is absent from size ${size} in ${context}.`);
    }
  }
}

function compareSymbol(left: CodeGraphWorksetSymbolRefV1, right: CodeGraphWorksetSymbolRefV1): number {
  return Effect.pipe(codeGraphWorksetSymbolKey(left), EffectString.localeCompare(codeGraphWorksetSymbolKey(right)));
}

function canonicalSymbol(symbol: CodeGraphWorksetSymbolRefV1): CodeGraphWorksetSymbolRefV1 {
  return {repositoryId: symbol.repositoryId, symbol: symbol.symbol};
}

function canonicalEdge(edge: CodeGraphWorksetExpectedEdgeV1): CodeGraphWorksetExpectedEdgeV1 {
  return {
    provenance: edge.provenance,
    relation: edge.relation,
    source: canonicalSymbol(edge.source),
    target: canonicalSymbol(edge.target),
  };
}

function compareEdge(left: CodeGraphWorksetExpectedEdgeV1, right: CodeGraphWorksetExpectedEdgeV1): number {
  return Effect.pipe(codeGraphWorksetEdgeKey(left), EffectString.localeCompare(codeGraphWorksetEdgeKey(right)));
}

function compareJson(left: unknown, right: unknown): number {
  return Effect.pipe(JSON.stringify(left), EffectString.localeCompare(JSON.stringify(right)));
}
