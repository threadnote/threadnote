import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import {createHash} from '@threadnote/testing/node-crypto';
import {readFileSync, readdirSync} from '@threadnote/testing/node-fs';
import {join} from '@threadnote/testing/node-path';
import {describe, expect, it} from '@effect/vitest';
import {parseBenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {
  CURRENT_RECALL_BASELINE_PATH,
  exceedsReviewedContractFailureLimit,
  parseRecallEvaluationBaselineV1,
} from '@threadnote/threadnote/evaluation/recall-baseline';
import {
  createRecallEvaluationFixtureV2,
  expandRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '@threadnote/threadnote/evaluation/recall-fixture';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const HISTORICAL_BASELINE_ROOT = 'apps/threadnote/test/evaluation/baselines/threadnote-3.0.3';
const THREADNOTE_427_REFERENCE_ROOT = 'apps/threadnote/test/evaluation/baselines/threadnote-4.2.7';
const CURRENT_QUALITY_BASELINE_ROOT = 'apps/threadnote/test/evaluation/baselines/threadnote-4.2.7-hybrid-v8';
const BENCHMARK_ROOT = join(HISTORICAL_BASELINE_ROOT, 'benchmarks', 'darwin-arm64-m1-max');
const CURRENT_BENCHMARK_ROOT = join(THREADNOTE_427_REFERENCE_ROOT, 'benchmarks', 'darwin-arm64-m1-max');
const CANDIDATE_ROOT = 'apps/threadnote/test/evaluation/candidates/threadnote-4.0.0';
const CURRENT_RANK_CANDIDATE_ROOT =
  'apps/threadnote/test/evaluation/candidates/threadnote-4.2.7-hybrid-v6/benchmarks/darwin-arm64-m1-max';
const CURRENT_BENCHMARK_COMMIT = '6f090189249de0a95c24d3084946f1a94360653e';
const CURRENT_RANK_CANDIDATE_COMMIT = '02b8ff90c57962cc9745f0a52e10759fefcf3664';
const CURRENT_RANK_BENCHMARKS = [
  {
    documents: 200,
    fixtureHash: '3967acf33893251f03126720ebf6fb55f6b6eed62f2c84f768963e9a352e9348',
    name: 'recall-rank-200.json',
    sampleProfile: 'standard',
    samples: 25,
    warmups: 5,
  },
  {
    documents: 1_000,
    fixtureHash: 'dbc8258af5e0e10b99e34eb55f8e5b0b2b992e7f647d5726ace7ae2e12deab74',
    name: 'recall-rank-1000.json',
    sampleProfile: 'standard',
    samples: 25,
    warmups: 5,
  },
  {
    documents: 10_000,
    fixtureHash: '30beea845c4e2052a27bbf27af29f140a3c59ca7357d1dfc2e14363ad647deb0',
    name: 'recall-rank-10000.json',
    sampleProfile: 'standard',
    samples: 25,
    warmups: 5,
  },
  {
    documents: 100_000,
    fixtureHash: '21d54f12a71d06be69e95cfbcc531c50cb8e917a5beb1ddfa12ba8453a254ae6',
    name: 'recall-rank-100000.json',
    sampleProfile: 'scale-boundary',
    samples: 5,
    warmups: 1,
  },
] as const;

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const withRest = <const S extends Schema.StructWithRest.Objects>(schema: S) =>
  Schema.StructWithRest(schema, [JsonRecordSchema]);
const MicroBaselineSchema = withRest(
  Schema.Struct({
    benchmarks: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    environment: Schema.optionalKey(withRest(Schema.Struct({node: Schema.optionalKey(Schema.String)}))),
    fixtures: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    runner: Schema.optionalKey(
      withRest(Schema.Struct({name: Schema.optionalKey(Schema.String), version: Schema.optionalKey(Schema.String)})),
    ),
  }),
);
const IndexedRecallSchema = withRest(
  Schema.Struct({
    fixture: Schema.optionalKey(withRest(Schema.Struct({documents: Schema.optionalKey(Schema.Finite)}))),
    scenarios: Schema.optionalKey(
      Schema.Record(Schema.String, withRest(Schema.Struct({p95Milliseconds: Schema.optionalKey(Schema.Finite)}))),
    ),
  }),
);
const IndexedSqliteSchema = withRest(
  Schema.Struct({
    fixture: Schema.optionalKey(withRest(Schema.Struct({documents: Schema.optionalKey(Schema.Finite)}))),
    scenarios: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        withRest(
          Schema.Struct({
            p95LimitMilliseconds: Schema.optionalKey(Schema.Finite),
            p95Milliseconds: Schema.optionalKey(Schema.Finite),
          }),
        ),
      ),
    ),
    source: Schema.optionalKey(withRest(Schema.Struct({index: Schema.optionalKey(Schema.String)}))),
  }),
);
const VectorStorageSchema = withRest(
  Schema.Struct({
    scales: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        withRest(
          Schema.Struct({
            database: withRest(
              Schema.Struct({
                chunkMappings: Schema.Finite,
                incrementalBytes: Schema.Finite,
                vectorValues: Schema.Finite,
              }),
            ),
            incrementalBuild: withRest(Schema.Struct({embeddedChunks: Schema.Finite, reusedChunks: Schema.Finite})),
            semanticQuery: withRest(Schema.Struct({p95Milliseconds: Schema.Finite})),
          }),
        ),
      ),
    ),
    suite: Schema.optionalKey(Schema.String),
  }),
);
const GraphAuditSchema = withRest(
  Schema.Struct({
    scales: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        withRest(
          Schema.Struct({
            after: withRest(
              Schema.Struct({coldIndexMilliseconds: Schema.Finite, oneFileIncrementalMilliseconds: Schema.Finite}),
            ),
            before: withRest(
              Schema.Struct({coldIndexMilliseconds: Schema.Finite, oneFileIncrementalMilliseconds: Schema.Finite}),
            ),
          }),
        ),
      ),
    ),
    suite: Schema.optionalKey(Schema.String),
  }),
);
const ModelCandidateSummarySchema = withRest(
  Schema.Struct({
    fixture: withRest(Schema.Struct({hash: Schema.String})),
    gate: withRest(Schema.Struct({failures: Schema.Array(Schema.String), passed: Schema.Boolean})),
    models: Schema.Array(withRest(Schema.Struct({sha256: Schema.String}))),
    result: withRest(Schema.Struct({metrics: withRest(Schema.Struct({noAnswerRecall: Schema.Finite}))})),
  }),
);
const decodeMicroBaseline = Schema.decodeUnknownSync(MicroBaselineSchema);
const decodeIndexedRecall = Schema.decodeUnknownSync(IndexedRecallSchema);
const decodeIndexedSqlite = Schema.decodeUnknownSync(IndexedSqliteSchema);
const decodeVectorStorage = Schema.decodeUnknownSync(VectorStorageSchema);
const decodeGraphAudit = Schema.decodeUnknownSync(GraphAuditSchema);
const decodeModelCandidateSummary = Schema.decodeUnknownSync(ModelCandidateSummarySchema);

const CURRENT_RANK_MEASUREMENTS = [
  'hybrid-rank-one-query',
  'hybrid-rank-throughput',
  'process-rss',
  'process-external-memory',
  'process-heap-used',
] as const;

describe('frozen Threadnote 3.0.3 baselines', () => {
  it('validates the compact recall-v2 baseline', () => {
    const baseline = parseRecallEvaluationBaselineV1(
      readJson(join(HISTORICAL_BASELINE_ROOT, 'recall-v2-lexical.json')),
    );
    const fixture = createRecallEvaluationFixtureV2();
    const fixtureHash = createHash('sha256').update(serializeRecallEvaluationFixtureV2Identity(fixture)).digest('hex');

    expect(baseline.fixture).toMatchObject({documents: 200, queries: 250, version: 2});
    expect(baseline.fixture.hash).toBe(fixtureHash);
    expect(
      EffectArray.every(fixture.documents, document =>
        Effect.pipe(document.uri, EffectString.startsWith('threadnote://')),
      ),
    ).toBe(true);
    expect(baseline.knownContractFailures).toBe(205);
    expect(baseline.result.pipeline.name).toBe('threadnote-3.0.3-lexical-only');
    expect(baseline.source).toMatchObject({
      openVikingVersion: '0.4.10',
      threadnoteVersion: '3.0.3',
    });
    expect(baseline.source.commit).toBeUndefined();
    expect(baseline.source.dirty).toBeUndefined();
  });

  it('validates every rank benchmark and preserves all scale points', () => {
    const artifacts = EffectArray.map(
      EffectArray.filter(readdirSync(BENCHMARK_ROOT), name => /^recall-rank-\d+\.json$/.test(name)),
      name => parseBenchmarkArtifactV1(readJson(join(BENCHMARK_ROOT, name))),
    );

    expect(
      EffectArray.map(artifacts, artifact => artifact.metadata.documents).sort(
        (left, right) => Number(left) - Number(right),
      ),
    ).toEqual([200, 1_000, 10_000, 100_000]);
    for (const artifact of artifacts) {
      expect(artifact.environment.node).toBe('v22.22.0');
      expect(artifact.environment.fixtureHash).toMatch(/^[a-f0-9]{64}$/);
      expect(EffectArray.some(artifact.measurements, measurement => measurement.name === 'hybrid-rank-one-query')).toBe(
        true,
      );
      expect(EffectArray.some(artifact.measurements, measurement => measurement.name === 'process-rss')).toBe(true);
    }
  });

  it('stores compact Mitata and indexed-recall summaries', () => {
    const micro = decodeMicroBaseline(readJson(join(BENCHMARK_ROOT, 'recall-micro.json')));
    const indexed = decodeIndexedRecall(readJson(join(BENCHMARK_ROOT, 'recall-index-10000.json')));

    expect(micro.environment?.node).toBe('v22.22.0');
    expect(micro.runner).toEqual({name: 'mitata', version: '1.0.34'});
    expect(EffectRecord.keys(micro.fixtures ?? {}).sort()).toEqual(['1000', '10000', '200']);
    expect(micro.benchmarks).toHaveLength(3);
    expect(indexed.fixture?.documents).toBe(10_000);
    expect(EffectRecord.keys(indexed.scenarios ?? {}).sort()).toEqual([
      'coldDecode',
      'hotQuery',
      'incrementalUpdate',
      'sourceValidation',
    ]);
  });

  it('stores the 4.0 SQLite indexed-recall benchmark within every release budget', () => {
    const indexed = decodeIndexedSqlite(
      readJson(join(CANDIDATE_ROOT, 'benchmarks', 'darwin-arm64-m1-max', 'recall-index-sqlite-10000.json')),
    );

    expect(indexed.fixture?.documents).toBe(10_000);
    expect(indexed.source?.index).toContain('@effect/sql-sqlite-bun');
    expect(EffectRecord.keys(indexed.scenarios ?? {}).sort()).toEqual([
      'coldDecode',
      'exactNoHit',
      'exactSubstring',
      'hotQuery',
      'incrementalUpdate',
      'sourceValidation',
    ]);
    for (const scenario of EffectRecord.values(indexed.scenarios ?? {})) {
      expect(scenario.p95Milliseconds).toBeLessThanOrEqual(scenario.p95LimitMilliseconds ?? 0);
    }
  });

  it('stores bounded content-addressed vector results at 10k and 50k', () => {
    const artifact = decodeVectorStorage(
      readJson(join(CANDIDATE_ROOT, 'benchmarks', 'darwin-arm64-m1-max', 'recall-vector-storage-sqlite-v2.json')),
    );

    expect(artifact.suite).toBe('recall-vector-storage-v1');
    expect(EffectRecord.keys(artifact.scales ?? {}).sort()).toEqual(['10000', '50000']);
    for (const [documentsText, result] of EffectRecord.toEntries(artifact.scales ?? {})) {
      const documents = Number(documentsText);
      expect(result.database.chunkMappings).toBe(documents);
      expect(result.database.vectorValues).toBe(documents);
      expect(result.database.incrementalBytes).toBeLessThanOrEqual(64 * 1024);
      expect(result.incrementalBuild.embeddedChunks).toBe(1);
      expect(result.incrementalBuild.reusedChunks).toBe(documents - 1);
      expect(result.semanticQuery.p95Milliseconds).toBeLessThan(1_000);
    }
  });

  it('stores the audited code-graph improvements at 10k and 100k', () => {
    const artifact = decodeGraphAudit(
      readJson(
        join(CANDIDATE_ROOT, 'benchmarks', 'darwin-arm64-m1-max', 'code-graph-performance-audit-2026-07-30.json'),
      ),
    );

    expect(artifact.suite).toBe('code-graph-performance-audit-v1');
    expect(EffectRecord.keys(artifact.scales ?? {}).sort()).toEqual(['10000', '100000']);
    for (const result of EffectRecord.values(artifact.scales ?? {})) {
      expect(result.after.coldIndexMilliseconds).toBeLessThan(result.before.coldIndexMilliseconds);
      expect(result.after.oneFileIncrementalMilliseconds).toBeLessThan(result.before.oneFileIncrementalMilliseconds);
    }
  });

  it('stores the passing 4.0 core embedding result and rejected reranker result', () => {
    const candidates = EffectArray.map(
      EffectArray.filter(readdirSync(CANDIDATE_ROOT), name => Effect.pipe(name, EffectString.endsWith('.json'))),
      name => decodeModelCandidateSummary(readJson(join(CANDIDATE_ROOT, name))),
    );

    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.fixture.hash).toBe('3967acf33893251f03126720ebf6fb55f6b6eed62f2c84f768963e9a352e9348');
      expect(EffectArray.every(candidate.models, model => /^[0-9a-f]{64}$/.test(model.sha256))).toBe(true);
    }
    const coreEmbedding = EffectOption.getOrUndefined(
      EffectArray.findFirst(candidates, candidate => candidate.models.length === 1),
    );
    const withReranker = EffectOption.getOrUndefined(
      EffectArray.findFirst(candidates, candidate => candidate.models.length === 2),
    );
    expect(coreEmbedding?.gate).toEqual(expect.objectContaining({failures: [], passed: true}));
    expect(coreEmbedding?.result.metrics.noAnswerRecall).toBe(1);
    expect(withReranker?.gate.passed).toBe(false);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(withReranker?.gate.failures), __effectArrayReceiver =>
          EffectArray.some(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(failure => Effect.pipe(failure, EffectString.includes('noAnswerRecall')))(__effectArrayValue),
          ),
        ),
      ),
    ).toBe(true);
    expect(withReranker?.result.metrics.noAnswerRecall).toBe(0);
  });
});

describe('reviewed current recall quality baseline', () => {
  it('uses the clean hybrid-v8 capture as the active quality gate', () => {
    const baselinePath = join(CURRENT_QUALITY_BASELINE_ROOT, 'recall-v2-lexical.json');
    const baseline = parseRecallEvaluationBaselineV1(readJson(baselinePath));
    const fixture = createRecallEvaluationFixtureV2();
    const fixtureHash = createHash('sha256').update(serializeRecallEvaluationFixtureV2Identity(fixture)).digest('hex');

    expect(baselinePath).toBe(CURRENT_RECALL_BASELINE_PATH);
    expect(baseline.createdAt).toBe('2026-08-20T19:07:18.000Z');
    expect(baseline.fixture).toMatchObject({documents: 200, hash: fixtureHash, queries: 250, version: 2});
    expect(baseline.knownContractFailures).toBe(99);
    expect(baseline.reviewedContractFailures).toHaveLength(99);
    expect(new Set(baseline.reviewedContractFailures).size).toBe(99);
    expect(baseline.result.pipeline.name).toBe('threadnote-4.2.7-lexical-only');
    expect(baseline.source).toEqual({
      commit: '6f77ff434b948390f3e1d0afaf7e1e00d359fa89',
      dirty: false,
      openVikingVersion: 'not-applicable',
      rankerVersion: 'hybrid-v8',
      threadnoteVersion: '4.2.7',
    });
  });

  it('keeps the 4.2.7 hybrid-v3 quality artifact as historical evidence', () => {
    const baseline = parseRecallEvaluationBaselineV1(
      readJson(join(THREADNOTE_427_REFERENCE_ROOT, 'recall-v2-lexical.json')),
    );

    expect(baseline.knownContractFailures).toBe(193);
    expect(baseline.reviewedContractFailures).toHaveLength(193);
    expect(baseline.source).toEqual({
      commit: '297cdb92bd164ed2ea58dd6c366c60c67aba97cf',
      dirty: false,
      openVikingVersion: 'not-applicable',
      rankerVersion: 'hybrid-v3',
      threadnoteVersion: '4.2.7',
    });
  });

  it('treats reviewed failures as a ceiling and remains zero-tolerance without a baseline', () => {
    const baseline = parseRecallEvaluationBaselineV1(
      readJson(join(CURRENT_QUALITY_BASELINE_ROOT, 'recall-v2-lexical.json')),
    );

    const reviewed = baseline.reviewedContractFailures ?? [];
    expect(exceedsReviewedContractFailureLimit(reviewed, baseline)).toBe(false);
    expect(exceedsReviewedContractFailureLimit([...reviewed.slice(1), 'new-query: new failure'], baseline)).toBe(true);
    expect(exceedsReviewedContractFailureLimit([...reviewed, reviewed[0]], baseline)).toBe(true);
    expect(exceedsReviewedContractFailureLimit([])).toBe(false);
    expect(exceedsReviewedContractFailureLimit(['new-query: new failure'])).toBe(true);
  });
});

describe('reviewed Threadnote 4.2.7 performance baseline', () => {
  it('stores exactly the clean hybrid-v3 M1 Max rank captures at every reviewed scale', () => {
    const names = EffectArray.filter(readdirSync(CURRENT_BENCHMARK_ROOT), name =>
      /^recall-rank-\d+\.json$/u.test(name),
    ).sort();
    expect(names).toEqual(EffectArray.map(CURRENT_RANK_BENCHMARKS, benchmark => benchmark.name).sort());

    for (const expected of CURRENT_RANK_BENCHMARKS) {
      const artifact = parseBenchmarkArtifactV1(readJson(join(CURRENT_BENCHMARK_ROOT, expected.name)));
      const fixture = expandRecallEvaluationFixtureV2(createRecallEvaluationFixtureV2(), expected.documents, 262_144);
      const fixtureHash = createHash('sha256')
        .update(serializeRecallEvaluationFixtureV2Identity(fixture))
        .digest('hex');

      expect(fixtureHash).toBe(expected.fixtureHash);
      expect(artifact.environment).toEqual({
        architecture: 'arm64',
        commit: CURRENT_BENCHMARK_COMMIT,
        cpu: 'Apple M1 Max',
        dirty: false,
        fixtureHash: expected.fixtureHash,
        memoryBytes: 68_719_476_736,
        node: 'bun/1.3.14',
        operatingSystem: 'macOS 27.0',
        packageManager: 'bun/1.3.14',
        runner: 'threadnote-recall-e2e',
        runnerVersion: '2',
      });
      expect(artifact.environment.commit).toMatch(/^[0-9a-f]{40}$/u);
      expect(artifact.metadata).toEqual({
        documents: expected.documents,
        homeRedacted: true,
        queries: 250,
        rankerVersion: 'hybrid-v3',
        sampleProfile: expected.sampleProfile,
        seed: 262_144,
        sourceVersion: 'threadnote-4.2.7',
      });
      expect(EffectArray.map(artifact.measurements, measurement => measurement.name)).toEqual(
        CURRENT_RANK_MEASUREMENTS,
      );
      expect(EffectArray.map(artifact.measurements, measurement => measurement.samples)).toEqual(
        EffectArray.map(CURRENT_RANK_MEASUREMENTS, () => expected.samples),
      );
      expect(artifact.suite).toBe('recall-v2');
      expect(artifact.version).toBe(1);
      expect(artifact.warmups).toBe(expected.warmups);
    }
  });
});

describe('reviewed Threadnote 4.2.7 hybrid-v6 performance candidate', () => {
  it('matches the hybrid-v3 fixture and host contract at every reviewed scale', () => {
    const names = EffectArray.filter(readdirSync(CURRENT_RANK_CANDIDATE_ROOT), name =>
      /^recall-rank-\d+\.json$/u.test(name),
    ).sort();
    expect(names).toEqual(EffectArray.map(CURRENT_RANK_BENCHMARKS, benchmark => benchmark.name).sort());

    for (const expected of CURRENT_RANK_BENCHMARKS) {
      const artifact = parseBenchmarkArtifactV1(readJson(join(CURRENT_RANK_CANDIDATE_ROOT, expected.name)));

      expect(artifact.environment).toEqual({
        architecture: 'arm64',
        commit: CURRENT_RANK_CANDIDATE_COMMIT,
        cpu: 'Apple M1 Max',
        dirty: false,
        fixtureHash: expected.fixtureHash,
        memoryBytes: 68_719_476_736,
        node: 'bun/1.3.14',
        operatingSystem: 'macOS 27.0',
        packageManager: 'bun/1.3.14',
        runner: 'threadnote-recall-e2e',
        runnerVersion: '2',
      });
      expect(artifact.metadata).toEqual({
        documents: expected.documents,
        homeRedacted: true,
        queries: 250,
        rankerVersion: 'hybrid-v6',
        sampleProfile: expected.sampleProfile,
        seed: 262_144,
        sourceVersion: 'threadnote-4.2.7',
      });
      expect(EffectArray.map(artifact.measurements, measurement => measurement.name)).toEqual(
        CURRENT_RANK_MEASUREMENTS,
      );
      expect(EffectArray.map(artifact.measurements, measurement => measurement.samples)).toEqual(
        EffectArray.map(CURRENT_RANK_MEASUREMENTS, () => expected.samples),
      );
      expect(artifact.suite).toBe('recall-v2');
      expect(artifact.version).toBe(1);
      expect(artifact.warmups).toBe(expected.warmups);
    }
  });
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
