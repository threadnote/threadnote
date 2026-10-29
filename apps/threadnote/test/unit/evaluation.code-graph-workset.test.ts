import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_WORKSET_EVALUATION_CATEGORIES,
  CODE_GRAPH_WORKSET_MEMBER_STATES,
  codeGraphWorksetEvaluationFixtureHash,
  evaluateCodeGraphWorksetObservations,
  parseCodeGraphWorksetEvaluationBaselineV1,
  parseCodeGraphWorksetEvaluationFixtureV1,
  serializeCodeGraphWorksetEvaluationFixtureIdentity,
  type CodeGraphWorksetEvaluationFixtureV1,
  type CodeGraphWorksetEvaluationObservationV1,
  type CodeGraphWorksetExpectedEdgeV1,
  type CodeGraphWorksetMemberState,
} from '@threadnote/threadnote/evaluation/code-graph-workset';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const importEdge: CodeGraphWorksetExpectedEdgeV1 = {
  provenance: 'declared',
  relation: 'imports',
  source: {repositoryId: 'consumer', symbol: 'src/client.ts#Client'},
  target: {repositoryId: 'producer', symbol: 'src/api.ts#Api'},
};

const callerEdge: CodeGraphWorksetExpectedEdgeV1 = {
  provenance: 'resolved',
  relation: 'calls',
  source: {repositoryId: 'consumer', symbol: 'src/client.ts#Client.call'},
  target: {repositoryId: 'producer', symbol: 'src/api.ts#Api.handle'},
};

const fixtureInput: CodeGraphWorksetEvaluationFixtureV1 = {
  allowedAuthoritativeEdges: [callerEdge, importEdge],
  generator: {
    archetypes: [
      {id: 'producer-archetype', sha256: Effect.pipe('a', EffectString.repeat(64))},
      {id: 'consumer-archetype', sha256: Effect.pipe('b', EffectString.repeat(64))},
      {id: 'empty-archetype', sha256: Effect.pipe('c', EffectString.repeat(64))},
    ],
    name: 'threadnote-workset-fixture',
    version: '1.0.0',
  },
  id: 'workset-evaluation-v1',
  members: [
    {
      archetypeId: 'producer-archetype',
      expectedState: 'current',
      id: 'producer',
      ordinal: 1,
      worktree: {
        isolation: {forbiddenMemberIds: ['deferred', 'consumer'], key: 'producer-family'},
        state: 'clean',
      },
    },
    {
      archetypeId: 'consumer-archetype',
      expectedState: 'stale',
      id: 'consumer',
      ordinal: 2,
      worktree: {isolation: {forbiddenMemberIds: ['producer'], key: 'producer-family'}, state: 'dirty'},
    },
    {
      archetypeId: 'empty-archetype',
      expectedState: 'deferred',
      id: 'deferred',
      ordinal: 3,
      worktree: {state: 'clean'},
    },
    {
      archetypeId: 'empty-archetype',
      expectedState: 'missing',
      id: 'missing',
      ordinal: 4,
      worktree: {state: 'clean'},
    },
    {
      archetypeId: 'empty-archetype',
      expectedState: 'failed',
      id: 'failed',
      ordinal: 5,
      worktree: {state: 'clean'},
    },
  ],
  queries: [
    query({
      category: 'symbol',
      expectedRepositories: ['producer'],
      expectedSymbols: [{repositoryId: 'producer', symbol: 'src/api.ts#Api'}],
      id: 'symbol-api',
      query: 'Api',
    }),
    query({
      category: 'package',
      expectedRepositories: ['consumer'],
      expectedSymbols: [{repositoryId: 'consumer', symbol: 'package.json#client'}],
      id: 'package-client',
      query: '@example/client',
    }),
    query({
      category: 'schema',
      expectedEdges: [importEdge],
      expectedRepositories: ['consumer', 'producer'],
      expectedSymbols: [
        {repositoryId: 'producer', symbol: 'src/api.ts#Api'},
        {repositoryId: 'consumer', symbol: 'src/client.ts#Client'},
      ],
      id: 'schema-api',
      query: 'Api contract',
    }),
    query({
      category: 'imports',
      expectedEdges: [importEdge],
      expectedRepositories: ['consumer'],
      expectedSymbols: [{repositoryId: 'consumer', symbol: 'src/client.ts#Client'}],
      id: 'imports-api',
      query: 'imports Api',
    }),
    query({
      category: 'callers',
      expectedEdges: [callerEdge],
      expectedRepositories: ['consumer'],
      expectedSymbols: [{repositoryId: 'consumer', symbol: 'src/client.ts#Client.call'}],
      id: 'callers-handle',
      query: 'callers of Api.handle',
    }),
    query({
      category: 'impact',
      expectedEdges: [callerEdge],
      expectedRepositories: ['consumer'],
      expectedSymbols: [{repositoryId: 'consumer', symbol: 'src/client.ts#Client.call'}],
      id: 'impact-handle',
      operation: 'impact',
      query: 'Api.handle',
    }),
    query({
      category: 'path',
      expectedEdges: [callerEdge],
      expectedRepositories: ['consumer', 'producer'],
      expectedSymbols: [
        {repositoryId: 'consumer', symbol: 'src/client.ts#Client.call'},
        {repositoryId: 'producer', symbol: 'src/api.ts#Api.handle'},
      ],
      id: 'path-client-handler',
      operation: 'path',
      query: 'Client.call to Api.handle',
    }),
    query({
      category: 'concept',
      expectedRepositories: ['producer'],
      expectedSymbols: [{repositoryId: 'producer', symbol: 'docs/api.md#retry semantics'}],
      id: 'concept-retries',
      query: 'where are retry semantics explained?',
    }),
    {
      answerable: false,
      category: 'no-answer',
      expectedEdges: [],
      expectedRepositories: [],
      expectedSymbols: [],
      id: 'no-answer-payments',
      operation: 'query',
      query: 'payments settlement implementation',
      sizes: [2, 5],
    },
  ],
  sizes: [5, 2],
  version: 1,
  worksetId: 'fixture-workset',
};

describe('code graph workset evaluation contract', () => {
  const fixture = parseCodeGraphWorksetEvaluationFixtureV1(fixtureInput);

  it('models every Phase 0 query, availability, worktree, and isolation state without changing code-graph V1', () => {
    expect(new Set(EffectArray.map(fixture.queries, entry => entry.category))).toEqual(
      new Set(CODE_GRAPH_WORKSET_EVALUATION_CATEGORIES),
    );
    expect(new Set(EffectArray.map(fixture.members, member => member.expectedState))).toEqual(
      new Set(CODE_GRAPH_WORKSET_MEMBER_STATES),
    );
    expect(new Set(EffectArray.map(fixture.members, member => member.worktree.state))).toEqual(
      new Set(['clean', 'dirty']),
    );
    expect(
      EffectArray.filter(
        fixture.members,
        (member, index) => index in fixture.members && Boolean(member.worktree.isolation),
      ),
    ).toHaveLength(2);
    expect(codeGraphWorksetEvaluationFixtureHash(fixture)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('scores complete evidence, coverage, safety, timing, byte, repository, card, and token observations', () => {
    const observations = perfectObservations(fixture);
    const metrics = evaluateCodeGraphWorksetObservations(fixture, observations);

    expect(metrics.aggregate).toMatchObject({
      answerableQueries: 12,
      authoritativeFalseEdgeRate: 0,
      coverageAccuracy: 1,
      edgeRecall: 1,
      executedQueries: 14,
      meanReciprocalRank: 1,
      noAnswerPrecision: 1,
      noAnswerRecall: 1,
      queryCount: 18,
      repositoryRecallAt1: 11 / 12,
      repositoryRecallAt3: 1,
      repositoryRecallAt5: 1,
      symbolRecall: 1,
      timeToFirstEvidenceSemantics: 'buffered-response',
      unsupportedOperationQueries: 4,
      unsupportedOperations: [
        {count: 2, operation: 'impact'},
        {count: 2, operation: 'path'},
      ],
      worktreeLeakageRate: 0,
    });
    expect(metrics.aggregate.timeToFirstEvidenceCardMilliseconds).toEqual({
      maximum: 17,
      mean: 154 / 12,
      p50: 12,
      p95: 17,
      sampleCount: 12,
    });
    expect(metrics.aggregate.completionMilliseconds).toEqual({
      maximum: 18,
      mean: 190 / 14,
      p50: 13,
      p95: 18,
      sampleCount: 14,
    });
    expect(metrics.aggregate.totals).toEqual({
      catalogBytesRead: 1_450,
      estimatedTokenCount: 190,
      evidenceCardCount: 12,
      representativeTokenCounts: [
        {count: 162, tokenizer: 'cl100k'},
        {count: 56, tokenizer: 'sentencepiece'},
      ],
      repositoriesConsidered: 49,
      repositoriesDeepQueried: 28,
      repositoryDatabasesOpened: 28,
      responseUtf8Bytes: 750,
      structuredResponseUtf8Bytes: 470,
      textResponseUtf8Bytes: 280,
    });
    expect(EffectArray.map(metrics.metricsBySize, entry => entry.worksetSize)).toEqual([2, 5]);
    expect(EffectArray.map(metrics.metricsBySize, entry => entry.metrics.queryCount)).toEqual([9, 9]);

    const baseline = parseCodeGraphWorksetEvaluationBaselineV1({
      createdAt: '2026-08-11T00:00:00.000Z',
      fixture: {
        hash: codeGraphWorksetEvaluationFixtureHash(fixture),
        id: fixture.id,
        members: fixture.members.length,
        queries: fixture.queries.length,
        sizes: fixture.sizes,
        version: fixture.version,
      },
      metrics,
      source: {commit: 'a0cdb02', dirty: true, environment: 'test', name: 'threadnote', version: '4.1.0'},
      version: 1,
    });
    expect(baseline.metrics).toEqual(metrics);
    expect(baseline.source.dirty).toBe(true);
    expect(() =>
      parseCodeGraphWorksetEvaluationBaselineV1({...baseline, source: {...baseline.source, dirty: undefined}}),
    ).toThrow(/dirty/);
  });

  it('detects a delivered cross-repository authoritative edge outside the reviewed allowlist', () => {
    const observations = perfectObservations(fixture);
    const observationIndex = EffectOption.getOrElse(
      EffectArray.findFirstIndex(observations, observation => observation.execution === 'executed'),
      () => -1,
    );
    const observation = observations[observationIndex];
    const contaminated = EffectArray.map(observations, (candidate, index) =>
      index === observationIndex
        ? {...observation, authoritativeEdges: [...observation.authoritativeEdges, unexpectedEdge]}
        : candidate,
    );

    expect(
      evaluateCodeGraphWorksetObservations(fixture, contaminated).aggregate.authoritativeFalseEdgeRate,
    ).toBeGreaterThan(0);
  });

  it('rejects duplicate identities, dangling expectations, and contradictory no-answer contracts', () => {
    expect(() =>
      parseCodeGraphWorksetEvaluationFixtureV1({
        ...fixtureInput,
        members: [...fixtureInput.members, fixtureInput.members[0]],
      }),
    ).toThrow(/member IDs must be unique/);
    expect(() =>
      parseCodeGraphWorksetEvaluationFixtureV1({
        ...fixtureInput,
        queries: EffectArray.map(fixtureInput.queries, entry =>
          entry.id === 'symbol-api' ? {...entry, expectedRepositories: ['unknown']} : entry,
        ),
      }),
    ).toThrow(/Unknown workset member unknown/);
    expect(() =>
      parseCodeGraphWorksetEvaluationFixtureV1({
        ...fixtureInput,
        queries: EffectArray.map(fixtureInput.queries, entry =>
          entry.id === 'no-answer-payments'
            ? {...entry, expectedRepositories: ['producer'], expectedSymbols: [{repositoryId: 'producer', symbol: 'x'}]}
            : entry,
        ),
      }),
    ).toThrow(/cannot declare expected results/);
    expect(() =>
      parseCodeGraphWorksetEvaluationFixtureV1({
        ...fixtureInput,
        queries: EffectArray.map(fixtureInput.queries, entry =>
          entry.id === 'imports-api'
            ? {
                ...entry,
                expectedEdges: [{...importEdge, relation: 'same-name-only'}],
              }
            : entry,
        ),
      }),
    ).toThrow(/not allowed as authoritative/);
  });

  it('keeps unsupported traversal and buffered delivery evidence explicit', () => {
    const observations = perfectObservations(fixture);
    const unsupportedIndex = EffectOption.getOrElse(
      EffectArray.findFirstIndex(observations, observation => observation.execution === 'unsupported-operation'),
      () => -1,
    );
    const executedIndex = EffectOption.getOrElse(
      EffectArray.findFirstIndex(
        observations,
        observation => observation.execution === 'executed' && Boolean(observation.measurement?.evidenceCardCount),
      ),
      () => -1,
    );
    expect(unsupportedIndex).toBeGreaterThanOrEqual(0);
    expect(executedIndex).toBeGreaterThanOrEqual(0);

    expect(() =>
      evaluateCodeGraphWorksetObservations(fixture, [
        ...observations.slice(0, unsupportedIndex),
        {...observations[unsupportedIndex], edges: [importEdge]},
        ...observations.slice(unsupportedIndex + 1),
      ]),
    ).toThrow(/cannot fabricate execution evidence/);

    const executed = observations[executedIndex];
    expect(() =>
      evaluateCodeGraphWorksetObservations(fixture, [
        ...observations.slice(0, executedIndex),
        {
          ...executed,
          measurement: {
            ...executed.measurement!,
            timeToFirstEvidenceCardMilliseconds: executed.measurement!.completionMilliseconds - 1,
          },
        },
        ...observations.slice(executedIndex + 1),
      ]),
    ).toThrow(/Buffered first-evidence time must equal completion time/);

    expect(() =>
      evaluateCodeGraphWorksetObservations(fixture, [
        ...observations.slice(0, executedIndex),
        {
          ...executed,
          measurement: {
            ...executed.measurement!,
            structuredResponseUtf8Bytes: executed.measurement!.structuredResponseUtf8Bytes + 1,
          },
        },
        ...observations.slice(executedIndex + 1),
      ]),
    ).toThrow(/Structured and text response bytes must sum to total response bytes/);

    expect(() => evaluateCodeGraphWorksetObservations(fixture, [...observations, observations[0]])).toThrow(
      /size\/sample\/query identities must be unique/,
    );
  });

  it('serializes and hashes fixture identity independently of every set-like input order', () => {
    const expectedSerialization = serializeCodeGraphWorksetEvaluationFixtureIdentity(fixture);
    const expectedHash = codeGraphWorksetEvaluationFixtureHash(fixture);
    const before = JSON.stringify(fixture);
    fc.assert(
      fc.property(
        permutation(fixture.allowedAuthoritativeEdges),
        permutation(fixture.generator.archetypes),
        permutation(fixture.members),
        permutation(fixture.queries),
        permutation(fixture.sizes),
        fc.boolean(),
        (allowedAuthoritativeEdges, archetypes, members, queries, sizes, reverseNested) => {
          const reordered: CodeGraphWorksetEvaluationFixtureV1 = {
            ...fixture,
            allowedAuthoritativeEdges,
            generator: {...fixture.generator, archetypes},
            members: EffectArray.map(members, member => ({
              ...member,
              worktree: member.worktree.isolation
                ? {
                    ...member.worktree,
                    isolation: {
                      ...member.worktree.isolation,
                      forbiddenMemberIds: reverseNested
                        ? [...member.worktree.isolation.forbiddenMemberIds].reverse()
                        : member.worktree.isolation.forbiddenMemberIds,
                    },
                  }
                : member.worktree,
            })),
            queries: EffectArray.map(queries, entry => ({
              ...entry,
              expectedEdges: reverseNested ? [...entry.expectedEdges].reverse() : entry.expectedEdges,
              expectedRepositories: reverseNested
                ? [...entry.expectedRepositories].reverse()
                : entry.expectedRepositories,
              expectedSymbols: reverseNested ? [...entry.expectedSymbols].reverse() : entry.expectedSymbols,
              sizes: reverseNested ? [...entry.sizes].reverse() : entry.sizes,
            })),
            sizes,
          };
          expect(serializeCodeGraphWorksetEvaluationFixtureIdentity(reordered)).toBe(expectedSerialization);
          expect(codeGraphWorksetEvaluationFixtureHash(reordered)).toBe(expectedHash);
          expect(JSON.stringify(fixture)).toBe(before);
        },
      ),
      {numRuns: 100},
    );
  });

  it('keeps every quality and safety metric bounded for arbitrary valid observations', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), {maxLength: fixture.queries.length, minLength: fixture.queries.length}),
        fc.array(fc.boolean(), {maxLength: fixture.queries.length, minLength: fixture.queries.length}),
        fc.array(fc.boolean(), {maxLength: fixture.queries.length, minLength: fixture.queries.length}),
        fc.array(fc.boolean(), {maxLength: fixture.queries.length, minLength: fixture.queries.length}),
        fc.array(fc.integer({max: 10_000, min: 0}), {
          maxLength: fixture.queries.length,
          minLength: fixture.queries.length,
        }),
        (repositoryHit, symbolHit, edgeHit, accurateCoverage, completionTimes) => {
          const observations = EffectArray.flatMap(fixture.sizes, worksetSize =>
            EffectArray.map(
              EffectArrayPipe(fixture.queries, __effectArrayValues =>
                EffectArray.filter(
                  __effectArrayValues,
                  (entry, __effectArrayIndex) =>
                    __effectArrayIndex in __effectArrayValues && entry.sizes.includes(worksetSize),
                ),
              ),
              (entry, index) => {
                const coverage = EffectArray.map(
                  EffectArray.filter(fixture.members, member => member.ordinal <= worksetSize),
                  member => ({
                    repositoryId: member.id,
                    state: accurateCoverage[index] ? member.expectedState : differentState(member.expectedState),
                  }),
                );
                if (entry.operation !== 'query') {
                  return {
                    authoritativeEdges: [],
                    coverage,
                    edges: [],
                    execution: 'unsupported-operation',
                    queryId: entry.id,
                    reportedNoAnswer: false,
                    repositoryHits: [],
                    sampleId: 'property-sample',
                    symbolHits: [],
                    version: 1,
                    worksetSize,
                    worktreeLeakageCount: 0,
                    worktreeObservationCount: 0,
                  } satisfies CodeGraphWorksetEvaluationObservationV1;
                }
                const reportedNoAnswer = entry.answerable ? !symbolHit[index] && !edgeHit[index] : repositoryHit[index];
                const returnedSymbol = entry.answerable
                  ? symbolHit[index]
                    ? entry.expectedSymbols
                    : []
                  : reportedNoAnswer
                    ? []
                    : [{repositoryId: 'producer', symbol: 'false-positive'}];
                const returnedEdges = edgeHit[index] ? entry.expectedEdges : [];
                const evidenceCardCount = reportedNoAnswer
                  ? 0
                  : Math.max(1, returnedSymbol.length, returnedEdges.length);
                return {
                  authoritativeEdges: edgeHit[index] ? entry.expectedEdges : [unexpectedEdge],
                  coverage,
                  edges: returnedEdges,
                  execution: 'executed',
                  measurement: {
                    catalogBytesRead: index,
                    completionMilliseconds: completionTimes[index],
                    estimatedTokenCount: index,
                    evidenceCardCount,
                    representativeTokenCounts: [{count: index, tokenizer: 'test'}],
                    repositoriesConsidered: repositoryHit[index] ? worksetSize : 0,
                    repositoriesDeepQueried: repositoryHit[index] ? 1 : 0,
                    repositoryDatabasesOpened: repositoryHit[index] ? 1 : 0,
                    responseUtf8Bytes: index * 3,
                    structuredResponseUtf8Bytes: index,
                    textResponseUtf8Bytes: index * 2,
                    ...(evidenceCardCount > 0 ? {timeToFirstEvidenceCardMilliseconds: completionTimes[index]} : {}),
                    timeToFirstEvidenceSemantics: 'buffered-response',
                  },
                  queryId: entry.id,
                  reportedNoAnswer,
                  repositoryHits: repositoryHit[index] ? entry.expectedRepositories : [],
                  sampleId: 'property-sample',
                  symbolHits: returnedSymbol,
                  version: 1,
                  worksetSize,
                  worktreeLeakageCount: edgeHit[index] ? 1 : 0,
                  worktreeObservationCount: 1,
                } satisfies CodeGraphWorksetEvaluationObservationV1;
              },
            ),
          );
          const metrics = evaluateCodeGraphWorksetObservations(fixture, observations);
          for (const metricSet of [
            metrics.aggregate,
            ...EffectArray.map(metrics.metricsBySize, entry => entry.metrics),
          ]) {
            for (const rate of [
              metricSet.authoritativeFalseEdgeRate,
              metricSet.coverageAccuracy,
              metricSet.edgeRecall,
              metricSet.meanReciprocalRank,
              metricSet.noAnswerPrecision,
              metricSet.noAnswerRecall,
              metricSet.repositoryRecallAt1,
              metricSet.repositoryRecallAt3,
              metricSet.repositoryRecallAt5,
              metricSet.symbolRecall,
              metricSet.worktreeLeakageRate,
            ]) {
              expect(Number.isFinite(rate)).toBe(true);
              expect(rate).toBeGreaterThanOrEqual(0);
              expect(rate).toBeLessThanOrEqual(1);
            }
            for (const timing of [metricSet.completionMilliseconds, metricSet.timeToFirstEvidenceCardMilliseconds]) {
              expect(timing.maximum).toBeGreaterThanOrEqual(0);
              expect(timing.mean).toBeGreaterThanOrEqual(0);
              expect(timing.p50).toBeGreaterThanOrEqual(0);
              expect(timing.p95).toBeGreaterThanOrEqual(0);
            }
          }
        },
      ),
      {numRuns: 100},
    );
  });
});

const unexpectedEdge: CodeGraphWorksetExpectedEdgeV1 = {
  provenance: 'declared',
  relation: 'same-name-only',
  source: {repositoryId: 'producer', symbol: 'SharedName'},
  target: {repositoryId: 'consumer', symbol: 'SharedName'},
};

function query(
  input: Omit<
    CodeGraphWorksetEvaluationFixtureV1['queries'][number],
    'answerable' | 'expectedEdges' | 'operation' | 'sizes'
  > & {
    readonly expectedEdges?: readonly CodeGraphWorksetExpectedEdgeV1[];
    readonly operation?: 'impact' | 'path' | 'query';
    readonly sizes?: readonly number[];
  },
): CodeGraphWorksetEvaluationFixtureV1['queries'][number] {
  const {expectedEdges = [], operation = 'query', sizes = [2, 5], ...expectation} = input;
  return {answerable: true, expectedEdges, operation, sizes, ...expectation};
}

function perfectObservations(
  fixture: CodeGraphWorksetEvaluationFixtureV1,
): readonly CodeGraphWorksetEvaluationObservationV1[] {
  return EffectArray.flatMap(fixture.sizes, worksetSize =>
    EffectArray.map(
      EffectArrayPipe(fixture.queries, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (entry, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && entry.sizes.includes(worksetSize),
        ),
      ),
      (entry, index) => {
        const coverage = EffectArray.map(
          EffectArray.filter(fixture.members, member => member.ordinal <= worksetSize),
          member => ({repositoryId: member.id, state: member.expectedState}),
        );
        if (entry.operation !== 'query') {
          return {
            authoritativeEdges: [],
            coverage,
            edges: [],
            execution: 'unsupported-operation',
            queryId: entry.id,
            reportedNoAnswer: false,
            repositoryHits: [],
            sampleId: 'sample-1',
            symbolHits: [],
            version: 1,
            worksetSize,
            worktreeLeakageCount: 0,
            worktreeObservationCount: 0,
          } satisfies CodeGraphWorksetEvaluationObservationV1;
        }
        const completionMilliseconds = 10 + index;
        return {
          authoritativeEdges: entry.expectedEdges,
          coverage,
          edges: entry.expectedEdges,
          execution: 'executed',
          measurement: {
            catalogBytesRead: 100 + index,
            completionMilliseconds,
            estimatedTokenCount: 10 + index,
            evidenceCardCount: entry.answerable ? 1 : 0,
            representativeTokenCounts: [
              {count: 8 + index, tokenizer: 'cl100k'},
              {count: 4, tokenizer: 'sentencepiece'},
            ],
            repositoriesConsidered: worksetSize,
            repositoriesDeepQueried: 2,
            repositoryDatabasesOpened: 2,
            responseUtf8Bytes: 50 + index,
            structuredResponseUtf8Bytes: 30 + index,
            textResponseUtf8Bytes: 20,
            ...(entry.answerable ? {timeToFirstEvidenceCardMilliseconds: completionMilliseconds} : {}),
            timeToFirstEvidenceSemantics: 'buffered-response',
          },
          queryId: entry.id,
          reportedNoAnswer: !entry.answerable,
          repositoryHits: entry.expectedRepositories,
          sampleId: 'sample-1',
          symbolHits: entry.expectedSymbols,
          version: 1,
          worksetSize,
          worktreeLeakageCount: 0,
          worktreeObservationCount: 2,
        } satisfies CodeGraphWorksetEvaluationObservationV1;
      },
    ),
  );
}

function permutation<T>(values: readonly T[]): fc.Arbitrary<T[]> {
  return fc.shuffledSubarray([...values], {maxLength: values.length, minLength: values.length});
}

function differentState(state: CodeGraphWorksetMemberState): CodeGraphWorksetMemberState {
  return state === 'failed' ? 'current' : 'failed';
}
