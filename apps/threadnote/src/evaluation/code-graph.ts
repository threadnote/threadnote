import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

export const CODE_GRAPH_EVALUATION_VERSION = 1 as const;
export const CODE_GRAPH_BASELINE_VERSION = 1 as const;

export const CODE_GRAPH_EVALUATION_CATEGORIES = ['definition', 'documentation', 'impact', 'no-answer', 'path'] as const;

export type CodeGraphEvaluationCategory = (typeof CODE_GRAPH_EVALUATION_CATEGORIES)[number];
export type CodeGraphEvaluationOperation = 'impact' | 'path' | 'query';

export interface CodeGraphExpectedSymbol {
  readonly kind: string;
  readonly name: string;
  readonly path: string;
}

export interface CodeGraphExpectedEdge {
  readonly provenance: string;
  readonly relation: string;
  readonly source: string;
  readonly target: string;
}

export interface CodeGraphEvaluationQuery {
  readonly answerable: boolean;
  readonly category: CodeGraphEvaluationCategory;
  readonly from?: string;
  readonly id: string;
  readonly operation: CodeGraphEvaluationOperation;
  readonly query?: string;
  readonly relevantPaths?: readonly string[];
  readonly relevantSymbols: readonly string[];
  readonly to?: string;
}

export interface CodeGraphEvaluationFixtureV1 {
  readonly allowedAuthoritativeEdges: readonly CodeGraphExpectedEdge[];
  readonly expectedEdges: readonly CodeGraphExpectedEdge[];
  readonly expectedSymbols: readonly CodeGraphExpectedSymbol[];
  readonly id: string;
  readonly languages: readonly string[];
  readonly queries: readonly CodeGraphEvaluationQuery[];
  readonly repositoryRoot: string;
  readonly version: typeof CODE_GRAPH_EVALUATION_VERSION;
  readonly worktreeContracts: readonly {
    readonly basePath: string;
    readonly baseSymbol: string;
    readonly branchAReplacement: string;
    readonly branchBReplacement: string;
    readonly forbiddenCrossBranch: boolean;
  }[];
}

export interface CodeGraphEvaluationObservation {
  readonly answerable: boolean;
  readonly edgeKeys: readonly string[];
  readonly pathHits: readonly string[];
  readonly queryId: string;
  readonly symbolHits: readonly string[];
}

export interface CodeGraphEvaluationMetrics {
  readonly answerableQueries: number;
  readonly authoritativeFalseEdgeRate: number;
  readonly edgeRecall: number;
  readonly meanReciprocalRank: number;
  readonly noAnswerPrecision: number;
  readonly noAnswerRecall: number;
  readonly queryCount: number;
  readonly symbolRecall: number;
  readonly worktreeLeakageRate: number;
}

export interface CodeGraphEvaluationBaselineV1 {
  readonly createdAt: string;
  readonly fixture: {
    readonly hash: string;
    readonly id: string;
    readonly queries: number;
    readonly version: number;
  };
  readonly metrics: CodeGraphEvaluationMetrics;
  readonly source: {
    readonly name: string;
    readonly version: string;
  };
  readonly version: typeof CODE_GRAPH_BASELINE_VERSION;
}

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const Rate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const ExpectedSymbolSchema = Schema.Struct({
  kind: NonEmptyString,
  name: NonEmptyString,
  path: NonEmptyString,
});
const ExpectedEdgeSchema = Schema.Struct({
  provenance: NonEmptyString,
  relation: NonEmptyString,
  source: NonEmptyString,
  target: NonEmptyString,
});
const QuerySchema = Schema.Struct({
  answerable: Schema.Boolean,
  category: Schema.Literals(CODE_GRAPH_EVALUATION_CATEGORIES),
  from: Schema.optionalKey(NonEmptyString),
  id: NonEmptyString,
  operation: Schema.Literals(['impact', 'path', 'query']),
  query: Schema.optionalKey(NonEmptyString),
  relevantPaths: Schema.optionalKey(Schema.Array(NonEmptyString)),
  relevantSymbols: Schema.Array(NonEmptyString),
  to: Schema.optionalKey(NonEmptyString),
});

export const CodeGraphEvaluationFixtureSchemaV1 = Schema.Struct({
  allowedAuthoritativeEdges: Schema.Array(ExpectedEdgeSchema),
  expectedEdges: Schema.Array(ExpectedEdgeSchema),
  expectedSymbols: Schema.Array(ExpectedSymbolSchema),
  id: NonEmptyString,
  languages: Schema.Array(NonEmptyString),
  queries: Schema.Array(QuerySchema),
  repositoryRoot: NonEmptyString,
  version: Schema.Literal(CODE_GRAPH_EVALUATION_VERSION),
  worktreeContracts: Schema.Array(
    Schema.Struct({
      basePath: NonEmptyString,
      baseSymbol: NonEmptyString,
      branchAReplacement: NonEmptyString,
      branchBReplacement: NonEmptyString,
      forbiddenCrossBranch: Schema.Boolean,
    }),
  ),
});

const MetricsSchema = Schema.Struct({
  answerableQueries: NonNegativeInteger,
  authoritativeFalseEdgeRate: Rate,
  edgeRecall: Rate,
  meanReciprocalRank: Rate,
  noAnswerPrecision: Rate,
  noAnswerRecall: Rate,
  queryCount: NonNegativeInteger,
  symbolRecall: Rate,
  worktreeLeakageRate: Rate,
});

export const CodeGraphEvaluationBaselineSchemaV1 = Schema.Struct({
  createdAt: NonEmptyString,
  fixture: Schema.Struct({
    hash: NonEmptyString,
    id: NonEmptyString,
    queries: NonNegativeInteger,
    version: NonNegativeInteger,
  }),
  metrics: MetricsSchema,
  source: Schema.Struct({
    name: NonEmptyString,
    version: NonEmptyString,
  }),
  version: Schema.Literal(CODE_GRAPH_BASELINE_VERSION),
});

export function parseCodeGraphEvaluationFixtureV1(value: unknown): CodeGraphEvaluationFixtureV1 {
  const fixture = Schema.decodeUnknownSync(CodeGraphEvaluationFixtureSchemaV1)(value);
  const ids = EffectArray.map(fixture.queries, query => query.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Code graph evaluation query IDs must be unique.');
  }
  for (const query of fixture.queries) {
    if (query.operation === 'path' && (!query.from || !query.to)) {
      throw new Error(`Code graph path query ${query.id} requires from and to.`);
    }
    if (query.operation !== 'path' && !query.query) {
      throw new Error(`Code graph query ${query.id} requires query text.`);
    }
    if (!query.answerable && (query.relevantSymbols.length > 0 || (query.relevantPaths?.length ?? 0) > 0)) {
      throw new Error(`No-answer code graph query ${query.id} cannot declare relevant results.`);
    }
  }
  const allowedEdges = new Set(EffectArray.map(fixture.allowedAuthoritativeEdges, codeGraphEdgeKey));
  for (const edge of fixture.expectedEdges) {
    if (!allowedEdges.has(codeGraphEdgeKey(edge))) {
      throw new Error('Every expected code graph edge must also appear in allowedAuthoritativeEdges.');
    }
  }
  return fixture;
}

export function parseCodeGraphEvaluationBaselineV1(value: unknown): CodeGraphEvaluationBaselineV1 {
  return Schema.decodeUnknownSync(CodeGraphEvaluationBaselineSchemaV1)(value);
}

export function serializeCodeGraphEvaluationFixtureIdentity(fixture: CodeGraphEvaluationFixtureV1): string {
  return `${JSON.stringify(
    {
      expectedEdges: [...fixture.expectedEdges].sort(compareJson),
      allowedAuthoritativeEdges: [...fixture.allowedAuthoritativeEdges].sort(compareJson),
      expectedSymbols: [...fixture.expectedSymbols].sort(compareJson),
      id: fixture.id,
      languages: [...fixture.languages].sort(),
      queries: [...fixture.queries].sort((left, right) => Effect.pipe(left.id, EffectString.localeCompare(right.id))),
      repositoryRoot: fixture.repositoryRoot,
      version: fixture.version,
      worktreeContracts: [...fixture.worktreeContracts].sort(compareJson),
    },
    undefined,
    2,
  )}\n`;
}

export function codeGraphEvaluationFixtureHash(fixture: CodeGraphEvaluationFixtureV1): string {
  return sha256HexSync(serializeCodeGraphEvaluationFixtureIdentity(fixture));
}

export function codeGraphEdgeKey(edge: {
  readonly provenance: string;
  readonly relation: string;
  readonly source: string;
  readonly target: string;
}): string {
  return `${edge.source}\u0000${edge.relation}\u0000${edge.target}\u0000${edge.provenance}`;
}

export function evaluateCodeGraphObservations(
  fixture: CodeGraphEvaluationFixtureV1,
  observations: readonly CodeGraphEvaluationObservation[],
  options: {
    readonly actualAuthoritativeEdges?: readonly string[];
    readonly allowedAuthoritativeEdgeKeys?: readonly string[];
    readonly extractedEdgeKeys?: readonly string[];
    readonly worktreeLeakageCount: number;
    readonly worktreeObservationCount: number;
  },
): CodeGraphEvaluationMetrics {
  const byQuery = new Map(EffectArray.map(observations, observation => [observation.queryId, observation]));
  let reciprocalRank = 0;
  let relevantSymbols = 0;
  let hitSymbols = 0;
  let predictedNoAnswer = 0;
  let expectedNoAnswer = 0;
  let trueNoAnswer = 0;
  for (const query of fixture.queries) {
    const observation = byQuery.get(query.id);
    if (!observation) throw new Error(`Missing code graph observation for ${query.id}.`);
    const orderedHits = [...observation.symbolHits, ...observation.pathHits];
    const relevant = new Set([...(query.relevantSymbols ?? []), ...(query.relevantPaths ?? [])]);
    relevantSymbols += relevant.size;
    hitSymbols += EffectArray.filter([...relevant], expected =>
      EffectArray.some(orderedHits, hit => matchesExpected(hit, expected)),
    ).length;
    const firstRelevant = EffectOption.getOrElse(
      EffectArray.findFirstIndex(
        orderedHits,
        __effectArrayValue =>
          !!(hit => EffectArray.some([...relevant], expected => matchesExpected(hit, expected)))(__effectArrayValue),
      ),
      () => -1,
    );
    if (query.answerable && firstRelevant >= 0) reciprocalRank += 1 / (firstRelevant + 1);
    const noAnswer = orderedHits.length === 0;
    if (noAnswer) predictedNoAnswer += 1;
    if (!query.answerable) {
      expectedNoAnswer += 1;
      if (noAnswer) trueNoAnswer += 1;
    }
  }

  const expectedEdgeKeys = new Set(EffectArray.map(fixture.expectedEdges, codeGraphEdgeKey));
  const observedEdgeKeys = new Set(
    options.extractedEdgeKeys ?? EffectArray.flatMap(observations, observation => observation.edgeKeys),
  );
  const edgeHits = EffectArray.filter([...expectedEdgeKeys], key => observedEdgeKeys.has(key)).length;
  const actualAuthoritative = options.actualAuthoritativeEdges ?? [...observedEdgeKeys];
  const allowedAuthoritative = new Set(options.allowedAuthoritativeEdgeKeys ?? expectedEdgeKeys);
  const falseAuthoritativeEdges = EffectArray.filter(actualAuthoritative, key => !allowedAuthoritative.has(key)).length;
  const answerableQueries = EffectArrayPipe(fixture.queries, __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (query, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && query.answerable,
    ),
  ).length;
  return {
    answerableQueries,
    authoritativeFalseEdgeRate: failureRate(falseAuthoritativeEdges, actualAuthoritative.length),
    edgeRecall: ratio(edgeHits, expectedEdgeKeys.size),
    meanReciprocalRank: ratio(reciprocalRank, answerableQueries),
    noAnswerPrecision: ratio(trueNoAnswer, predictedNoAnswer),
    noAnswerRecall: ratio(trueNoAnswer, expectedNoAnswer),
    queryCount: fixture.queries.length,
    symbolRecall: ratio(hitSymbols, relevantSymbols),
    worktreeLeakageRate: failureRate(options.worktreeLeakageCount, options.worktreeObservationCount),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function failureRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function matchesExpected(actual: string, expected: string): boolean {
  return (
    actual === expected ||
    Effect.pipe(actual, EffectString.endsWith(`/${expected}`)) ||
    Effect.pipe(actual, EffectString.includes(expected))
  );
}

function compareJson(left: unknown, right: unknown): number {
  return Effect.pipe(JSON.stringify(left), EffectString.localeCompare(JSON.stringify(right)));
}
