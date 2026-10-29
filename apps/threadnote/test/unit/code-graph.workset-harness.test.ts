import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import * as EffectString from 'effect/String';
import {parseCodeGraphWorksetBenchmarkArguments} from '../../../../scripts/benchmark-code-graph-workset.js';
import {
  codeGraphWorksetEvaluationSafetyFailures,
  parseCodeGraphWorksetEvaluationArguments,
} from '../../../../scripts/evaluate-code-graph-workset.js';
import {
  CODE_GRAPH_WORKSET_AGENT_TOKEN_BUDGET,
  codeGraphWorksetBenchmarkBudgetFailures,
  codeGraphWorksetBenchmarkMeasurements,
  codeGraphWorksetCoverage,
  type CodeGraphWorksetCoverageResult,
  codeGraphWorksetDeliveryMeasurement,
  codeGraphWorksetObservationFromQuery,
  buildCodeGraphWorksetEvaluationFixture,
  type CodeGraphWorksetBenchmarkSample,
  type MeasuredCodeGraphWorksetQuery,
} from '../../../../scripts/support/code-graph-workset-harness.js';
import {createCodeGraphWorksetFixturePlan} from '../../../../scripts/support/code-graph-workset-fixture.js';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {
  codeGraphEvidenceCardId,
  projectCodeGraphWorksetEvidence,
  type CodeGraphEvidenceCardV1,
  type CompactEvidenceRelationshipV1,
} from '@threadnote/graph/workset/evidence';
import {sha256HexSync} from '@threadnote/platform/sha256';

describe('code graph workset runner arguments', () => {
  it('defaults evaluation to the required matrix and supports a bounded smoke subset', () => {
    const defaults = {environment: {}, now: new Date('2026-08-11T10:00:00.000Z')};
    expect(parseCodeGraphWorksetEvaluationArguments([], defaults)).toEqual({
      createdAt: '2026-08-11T10:00:00.000Z',
      outputPath: undefined,
      sizes: [1, 8, 32, 64, 128],
      smoke: false,
    });
    expect(parseCodeGraphWorksetEvaluationArguments(['--smoke'], defaults).sizes).toEqual([1, 8]);
  });

  it('parses explicit evaluation provenance and rejects benchmark-only or ambiguous sizes', () => {
    expect(
      parseCodeGraphWorksetEvaluationArguments(
        ['--sizes', '64,1', '--created-at', '2026-08-11T12:34:56+02:00', '--output', 'artifacts/workset.json'],
        {environment: {}, now: new Date(0)},
      ),
    ).toEqual({
      createdAt: '2026-08-11T10:34:56.000Z',
      outputPath: 'artifacts/workset.json',
      sizes: [1, 64],
      smoke: false,
    });
    expect(() =>
      parseCodeGraphWorksetEvaluationArguments(['--sizes', '50'], {
        environment: {},
        now: new Date(0),
      }),
    ).toThrow(/only accepts evaluation sizes/i);
    expect(() =>
      parseCodeGraphWorksetEvaluationArguments(['--sizes', '8,8'], {
        environment: {},
        now: new Date(0),
      }),
    ).toThrow(/unique/i);
  });

  it('supports the direct 50-repository benchmark gate and bounded sample controls', () => {
    expect(parseCodeGraphWorksetBenchmarkArguments([])).toEqual({
      failOnBudget: false,
      outputPath: undefined,
      samples: 5,
      sizes: [1, 8, 32, 50, 64, 128],
      warmups: 1,
    });
    expect(
      parseCodeGraphWorksetBenchmarkArguments([
        '--sizes',
        '128,50',
        '--samples',
        '7',
        '--warmups',
        '0',
        '--output',
        'bench.json',
        '--fail-on-budget',
      ]),
    ).toEqual({
      failOnBudget: true,
      outputPath: 'bench.json',
      samples: 7,
      sizes: [50, 128],
      warmups: 0,
    });
    expect(() => parseCodeGraphWorksetBenchmarkArguments(['--sizes', '16'])).toThrow(/only accepts benchmark sizes/i);
    expect(() => parseCodeGraphWorksetBenchmarkArguments(['--samples', '1.5'])).toThrow(/integer/i);
  });

  it('keeps the evaluation safety invariants as hard runner gates', () => {
    const aggregate = {
      authoritativeFalseEdgeRate: 0,
      noAnswerPrecision: 1,
      noAnswerRecall: 1,
      worktreeLeakageRate: 0,
    };
    expect(codeGraphWorksetEvaluationSafetyFailures({aggregate})).toEqual([]);
    expect(
      codeGraphWorksetEvaluationSafetyFailures({
        aggregate: {
          ...aggregate,
          authoritativeFalseEdgeRate: 0.1,
          noAnswerPrecision: 0.5,
          noAnswerRecall: 0,
          worktreeLeakageRate: 0.25,
        },
      }),
    ).toEqual([
      'authoritative false-edge rate must be zero',
      'worktree leakage rate must be zero',
      'no-answer precision must be one',
      'no-answer recall must be one',
    ]);
  });
});

describe('code graph workset delivery measurement', () => {
  it('counts the actual MCP envelope, leaves tokenizer counts unclaimed, and labels buffered first evidence', () => {
    const response = {structuredContent: {cards: ['alpha']}, text: 'alpha'};
    const actual = measureAgentToolResponse(response);
    expect(
      codeGraphWorksetDeliveryMeasurement({
        completionMilliseconds: 42,
        evidenceItemCount: 1,
        repositoriesConsidered: 8,
        repositoriesDeepQueried: 7,
        repositoryDatabasesOpened: 7,
        response,
      }),
    ).toEqual({
      catalogBytesRead: 0,
      completionMilliseconds: 42,
      estimatedTokenCount: actual.estimatedTokens,
      evidenceCardCount: 1,
      representativeTokenCounts: [],
      repositoriesConsidered: 8,
      repositoriesDeepQueried: 7,
      repositoryDatabasesOpened: 7,
      responseUtf8Bytes: actual.totalBytes,
      structuredResponseUtf8Bytes: actual.structuredBytes,
      textResponseUtf8Bytes: actual.textBytes,
      timeToFirstEvidenceCardMilliseconds: 42,
      timeToFirstEvidenceSemantics: 'buffered-response',
    });
  });

  it('does not claim a first-evidence delivery time when no evidence was returned', () => {
    const measurement = codeGraphWorksetDeliveryMeasurement({
      completionMilliseconds: 12,
      evidenceItemCount: 0,
      repositoriesConsidered: 1,
      repositoriesDeepQueried: 1,
      repositoryDatabasesOpened: 1,
      response: {structuredContent: {cards: []}, text: ''},
    });
    expect(measurement.timeToFirstEvidenceCardMilliseconds).toBeUndefined();
    expect(measurement.representativeTokenCounts).toEqual([]);
  });

  it('maps arbitrary buffered responses to exact bytes and completion-equal first evidence', () => {
    fc.assert(
      fc.property(
        fc.string({maxLength: 100}),
        fc.integer({min: 0, max: 100}),
        fc.integer({min: 0, max: 10_000}),
        (text, evidenceItemCount, completionMilliseconds) => {
          const response = {structuredContent: {text}, text};
          const expected = measureAgentToolResponse(response);
          const measurement = codeGraphWorksetDeliveryMeasurement({
            completionMilliseconds,
            evidenceItemCount,
            repositoriesConsidered: 8,
            repositoriesDeepQueried: 8,
            repositoryDatabasesOpened: 8,
            response,
          });
          expect(measurement.responseUtf8Bytes).toBe(expected.totalBytes);
          expect(measurement.structuredResponseUtf8Bytes).toBe(expected.structuredBytes);
          expect(measurement.textResponseUtf8Bytes).toBe(expected.textBytes);
          expect(measurement.estimatedTokenCount).toBe(expected.estimatedTokens);
          expect(measurement.timeToFirstEvidenceCardMilliseconds).toBe(
            evidenceItemCount > 0 ? completionMilliseconds : undefined,
          );
        },
      ),
      {numRuns: 100},
    );
  });
});

describe('code graph workset ranked-sequence observation mapping', () => {
  it('scores the materialized sequence while measuring only the compact transport', () => {
    const fixture = buildCodeGraphWorksetEvaluationFixture(createCodeGraphWorksetFixturePlan(1), [1]);
    const sourceRef = `cgr_${EffectString.repeat(40)('1')}`;
    const targetRef = `cgr_${EffectString.repeat(40)('2')}`;
    const repositoryId = sha256HexSync('repository-000');
    const snapshotId = `cgsn_${EffectString.slice(0, 40)(sha256HexSync('snapshot-000'))}`;
    const worktreeId = sha256HexSync('worktree-000');
    const source = {
      id: codeGraphEvidenceCardId(sourceRef, snapshotId, worktreeId),
      reason: {score: 1, signals: ['exact'], summary: 'Exact match.'},
      ref: sourceRef,
      relationships: [],
      repositoryKey: 'workset-repo-000',
      symbol: {
        kind: 'function',
        language: 'typescript',
        name: 'sourceSymbol',
        path: 'src/source.ts',
        qualifiedName: 'sourceSymbol',
        span: {column: 0, endColumn: 1, endLine: 1, line: 1},
      },
    } satisfies CodeGraphEvidenceCardV1;
    const target = {
      ...source,
      id: codeGraphEvidenceCardId(targetRef, snapshotId, worktreeId),
      ref: targetRef,
      symbol: {...source.symbol, name: 'targetSymbol', path: 'src/target.ts', qualifiedName: 'targetSymbol'},
    } satisfies CodeGraphEvidenceCardV1;
    const relationship = {
      authority: 'authoritative',
      confidence: 1,
      evidence: {
        path: 'src/source.ts',
        repositoryKey: 'workset-repo-000',
        span: {column: 0, endColumn: 1, endLine: 1, line: 1},
      },
      provenance: 'resolved',
      relation: 'calls',
      source: {ref: source.ref, repositoryKey: 'workset-repo-000'},
      target: {ref: target.ref, repositoryKey: 'workset-repo-000'},
    } satisfies CompactEvidenceRelationshipV1;
    const deliveredSource = {...source, relationships: [relationship]};
    const generationDigest = sha256HexSync('generation');
    const result = {
      cards: [deliveredSource, target],
      coverage: {
        cataloguedRepositories: 1,
        complete: true,
        consideredRepositories: 1,
        deepQueriedRepositories: 1,
        requestedRepositories: 1,
        states: {current: 1, deferred: 0, excluded: 0, failed: 0, missing: 0, stale: 0},
        stopReason: 'exhaustion',
      },
      repositories: {
        'workset-repo-000': {
          considered: true,
          deepQueried: true,
          repositoryId,
          snapshot: {
            checkoutId: sha256HexSync('checkout-000'),
            commit: EffectString.slice(0, 40)(sha256HexSync('commit-000')),
            digest: sha256HexSync('snapshot-digest-000'),
            dirty: false,
            freshness: 'current',
            id: snapshotId,
            projectionDigest: sha256HexSync('projection-000'),
            provenance: 'ready-snapshot',
            worktreeId,
          },
          state: 'current',
        },
      },
      trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
      type: 'code-graph-workset-query',
      version: 2,
      warnings: [],
      workset: {
        generation: {digest: generationDigest, id: 'cgwg_e661f4c935e8a5a83349afb5e347695c2e972e96'},
        name: 'code-graph-workset-1',
      },
    } satisfies MeasuredCodeGraphWorksetQuery['result'];
    const response = projectCodeGraphWorksetEvidence(result);
    const measured = {
      measurement: codeGraphWorksetDeliveryMeasurement({
        completionMilliseconds: 5,
        evidenceItemCount: 2,
        repositoriesConsidered: 1,
        repositoriesDeepQueried: 1,
        repositoryDatabasesOpened: 1,
        response,
      }),
      response,
      result,
    } satisfies MeasuredCodeGraphWorksetQuery;

    const observation = codeGraphWorksetObservationFromQuery(fixture, 1, 'sample-1', fixture.queries[0].id, measured);

    expect(observation.symbolHits).toEqual([
      {repositoryId: 'repo-000', symbol: 'src/source.ts#sourceSymbol'},
      {repositoryId: 'repo-000', symbol: 'src/target.ts#targetSymbol'},
    ]);
    expect(observation.edges).toEqual([
      {
        provenance: 'resolved',
        relation: 'calls',
        source: {repositoryId: 'repo-000', symbol: 'src/source.ts#sourceSymbol'},
        target: {repositoryId: 'repo-000', symbol: 'src/target.ts#targetSymbol'},
      },
    ]);
    expect(observation.authoritativeEdges).toEqual(observation.edges);
  });

  it('retains explicit mixed-state receipts without fabricating omitted members', () => {
    const fixture = buildCodeGraphWorksetEvaluationFixture(
      createCodeGraphWorksetFixturePlan(32, {stateProfile: 'mixed'}),
      [32],
    );
    const result = {
      repositories: {
        'workset-repo-000': {
          considered: true,
          deepQueried: true,
          repositoryId: sha256HexSync('repo-000'),
          state: 'current',
        },
        'workset-repo-006': {
          considered: true,
          deepQueried: false,
          repositoryId: sha256HexSync('repo-006'),
          state: 'deferred',
        },
      },
    } satisfies CodeGraphWorksetCoverageResult;

    expect(codeGraphWorksetCoverage(fixture, 32, result)).toEqual([
      {repositoryId: 'repo-000', state: 'current'},
      {repositoryId: 'repo-006', state: 'deferred'},
    ]);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(fixture.members, member => member.id === 'repo-014'))
        ?.expectedState,
    ).toBe('deferred');
  });

  it('retains the exact Protobuf bridge expectation in the mixed size-eight evaluator', () => {
    const plan = createCodeGraphWorksetFixturePlan(8, {stateProfile: 'mixed'});
    const fixture = buildCodeGraphWorksetEvaluationFixture(plan, [1, 8]);

    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(plan.repositories, repository => repository.repositoryKey === 'repo-002'),
      )?.state,
    ).toBe('missing');
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(plan.repositories, repository => repository.repositoryKey === 'repo-003'),
      )?.state,
    ).toBe('stale');
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(fixture.queries, query => query.id === 'protobuf-session-directory'),
      )?.expectedEdges,
    ).toEqual([
      {
        provenance: 'declared',
        relation: 'imports',
        source: {repositoryId: 'repo-003', symbol: 'proto/session_client.proto#session.proto'},
        target: {repositoryId: 'repo-000', symbol: 'threadnote/session/v1/session.proto#session.proto'},
      },
    ]);
  });
});

describe('code graph workset benchmark mapping', () => {
  it('emits versioned measurements, records the removed cap, and enforces selected budgets', () => {
    const samples: CodeGraphWorksetBenchmarkSample[] = [
      benchmarkSample(50, {completionMilliseconds: 900, timeToFirstEvidenceMilliseconds: 800}),
      benchmarkSample(50, {completionMilliseconds: 1_200, timeToFirstEvidenceMilliseconds: 1_100}),
      benchmarkSample(128, {completionMilliseconds: 5_100, timeToFirstEvidenceMilliseconds: 5_100}),
    ];
    const measurements = codeGraphWorksetBenchmarkMeasurements(samples);
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(measurements, measurement => measurement.name === 'workset-current-repository-cap'),
      ),
    ).toMatchObject({
      maximum: 0,
      minimum: 0,
      unit: 'count',
    });
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          measurements,
          measurement => measurement.name === 'workset-50-delivered-time-to-first-evidence-buffered',
        ),
      ),
    ).toMatchObject({p95: 1_100, samples: 2, unit: 'milliseconds'});
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(measurements, measurement => measurement.name === 'workset-50-total-agent-output'),
      ),
    ).toMatchObject({
      maximum: 300,
      unit: 'bytes',
    });
    expect(codeGraphWorksetBenchmarkBudgetFailures(measurements, [50, 128])).toEqual([
      'workset-50-delivered-time-to-first-evidence-buffered p95 1100.00ms exceeds 1000ms',
      'workset-128-completion p95 5100.00ms exceeds 5000ms',
    ]);
  });

  it('fails the fixed agent token envelope without inventing a tokenizer gate', () => {
    const measurements = codeGraphWorksetBenchmarkMeasurements([
      benchmarkSample(1, {estimatedTokenCount: CODE_GRAPH_WORKSET_AGENT_TOKEN_BUDGET + 1}),
    ]);
    expect(codeGraphWorksetBenchmarkBudgetFailures(measurements, [1])).toEqual([
      `workset-1-estimated-agent-tokens maximum ${CODE_GRAPH_WORKSET_AGENT_TOKEN_BUDGET + 1} exceeds ${CODE_GRAPH_WORKSET_AGENT_TOKEN_BUDGET}`,
    ]);
  });
});

function benchmarkSample(
  worksetSize: number,
  overrides: Partial<CodeGraphWorksetBenchmarkSample> = {},
): CodeGraphWorksetBenchmarkSample {
  return {
    completionMilliseconds: 500,
    estimatedTokenCount: 100,
    evidenceItemCount: 2,
    repositoriesConsidered: Math.min(8, worksetSize),
    repositoriesDeepQueried: Math.min(8, worksetSize),
    repositoryDatabasesOpened: Math.min(8, worksetSize),
    requestedRepositories: worksetSize,
    responseUtf8Bytes: 300,
    structuredResponseUtf8Bytes: 200,
    textResponseUtf8Bytes: 100,
    timeToFirstEvidenceMilliseconds: 500,
    worksetSize,
    ...overrides,
  };
}
