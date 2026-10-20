import {provideScriptLayer, scriptError, ScriptError} from './effect/errors.js';
import {BunRuntime} from '@effect/platform-bun';
import {Clock, Console, DateTime, Effect, FileSystem, Option, Path} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {evaluateRecallFixture, parseRecallEvaluationFixture} from '@threadnote/recall/evaluate';
import {
  clearRecallIndexMemoryCache,
  expireRecallIndexValidation,
  loadRecallExactMatches,
  loadRecallIndex,
} from '@threadnote/recall/index';
import {prepareRecallSections} from '@threadnote/recall/runtime';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  captureRecallEvaluationSource,
  measureRecallEvaluationSample,
  recallEvaluationScenario,
  writeRecallEvaluationDiagnosticsAndEnforce,
  type RecallEvaluationSample,
} from './evaluate-recall-diagnostics.js';

const FIXTURE_PATH = 'apps/threadnote/test/evaluation/fixtures/recall-v1/fixture.json';
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const PRODUCTION_BENCHMARK_DOCUMENT_COUNT = 10_000;
const PRODUCTION_BENCHMARK_WARMUP_COUNT = 5;
const HOT_QUERY_SAMPLE_COUNT = 25;
const COLD_DECODE_SAMPLE_COUNT = 5;
const VALIDATION_SAMPLE_COUNT = 3;
const INCREMENTAL_UPDATE_SAMPLE_COUNT = 40;
const EXACT_SEARCH_SAMPLE_COUNT = 25;
const HOT_QUERY_P95_LIMIT_MILLISECONDS = 150;
const COLD_DECODE_P95_LIMIT_MILLISECONDS = 1_000;
const VALIDATION_P95_LIMIT_MILLISECONDS = 2_000;
const INCREMENTAL_UPDATE_P95_LIMIT_MILLISECONDS = 2_000;
const EXACT_SEARCH_P95_LIMIT_MILLISECONDS = 150;
const PRODUCTION_BENCHMARK_WRITE_CONCURRENCY = 64;
const PRODUCTION_BENCHMARK_QUERY = 'benchmark-anchor-9999';
const PRODUCTION_BENCHMARK_BASE_TIMESTAMP_MILLISECONDS = Date.UTC(2026, 0, 1);

const program = Effect.gen(function* () {
  const sourceBefore = yield* captureRecallEvaluationSource();
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(FIXTURE_PATH);
  const fixture = yield* Effect.try({
    try: () => parseRecallEvaluationFixture(JSON.parse(raw)),
    catch: cause => scriptError(cause),
  });
  const durations: number[] = [];
  for (const query of fixture.queries) {
    const startedAt = yield* Clock.currentTimeNanos;
    evaluateRecallFixture({...fixture, queries: [query]});
    const finishedAt = yield* Clock.currentTimeNanos;
    durations.push(Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND);
  }
  const result = evaluateRecallFixture(fixture);
  const sortedDurations = [...durations].sort((left, right) => left - right);
  const {observations, ...productionBenchmark} = yield* runProductionBenchmark;
  const sourceAfter = yield* captureRecallEvaluationSource();
  const output = {
    ...result,
    latencyMs: {
      p50: percentile(sortedDurations, 0.5),
      p95: percentile(sortedDurations, 0.95),
    },
    productionBenchmark,
  };
  yield* Console.log(JSON.stringify(output, undefined, 2));
  yield* writeRecallEvaluationDiagnosticsAndEnforce('artifacts/recall-production-10000.json', {
    correctnessFailureCount: result.failures.length,
    fixtureSha256: sha256HexSync(raw),
    observations,
    productionBenchmark,
    source: {before: sourceBefore, after: sourceAfter},
  });
});

const runProductionBenchmark = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-eval-'});
    const resourceRoot = pathService.join(agentContextHome, 'data', 'local', 'resources', 'repos', 'threadnote');
    const repoRoot = pathService.join(agentContextHome, 'benchmark-repo');
    const manifestPath = pathService.join(agentContextHome, 'seed-manifest.yaml');
    const seedStatePath = pathService.join(agentContextHome, 'seed-state.json');
    const targetResourcePath = pathService.join(resourceRoot, '09999.md');
    const targetRepoPath = pathService.join(repoRoot, '09999.md');
    yield* fs.makeDirectory(resourceRoot, {recursive: true});
    yield* fs.makeDirectory(repoRoot, {recursive: true});
    yield* Effect.forEach(
      Array.from({length: PRODUCTION_BENCHMARK_DOCUMENT_COUNT}, (_unused, index) => index),
      index =>
        fs.writeFileString(
          pathService.join(resourceRoot, `${String(index).padStart(5, '0')}.md`),
          index === PRODUCTION_BENCHMARK_DOCUMENT_COUNT - 1
            ? '# Production benchmark target\n\ncommon retrieval benchmark-anchor-9999 bounded retrieval'
            : `# Production benchmark ${index}\n\ncommon retrieval document ${index}`,
        ),
      {concurrency: PRODUCTION_BENCHMARK_WRITE_CONCURRENCY},
    );
    const initialTargetContent =
      '# Production benchmark target\n\ncommon retrieval benchmark-anchor-9999 bounded retrieval';
    const initialTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe(PRODUCTION_BENCHMARK_BASE_TIMESTAMP_MILLISECONDS));
    yield* fs.writeFileString(targetRepoPath, initialTargetContent);
    yield* Effect.all([
      fs.utimes(targetResourcePath, initialTimestamp, initialTimestamp),
      fs.utimes(targetRepoPath, initialTimestamp, initialTimestamp),
    ]);
    yield* fs.writeFileString(
      manifestPath,
      `${JSON.stringify({
        projects: [
          {
            name: 'threadnote',
            path: repoRoot,
            seed: ['09999.md'],
            uri: 'threadnote://resources/repos/threadnote',
          },
        ],
        version: 1,
      })}\n`,
    );
    const writeSeedState = Effect.gen(function* () {
      const targetInfo = yield* fs.stat(targetRepoPath);
      const modifiedAt = Option.getOrUndefined(targetInfo.mtime)?.getTime();
      if (modifiedAt === undefined) {
        return yield* ScriptError.make({message: 'Production benchmark target has no modification time.'});
      }
      yield* fs.writeFileString(
        seedStatePath,
        `${JSON.stringify({
          files: {
            'threadnote://resources/repos/threadnote/09999.md': {
              mtimeMs: modifiedAt,
              size: Number(targetInfo.size),
            },
          },
          version: 1,
        })}\n`,
      );
    });
    yield* writeSeedState;
    const config = {account: 'local', agentContextHome, manifestPath, user: 'benchmark'};
    const initialIndex = yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});
    if (
      initialIndex.find(candidate => candidate.uri === 'threadnote://resources/repos/threadnote/09999.md')
        ?.authority !== 'canonical_repo'
    ) {
      return yield* ScriptError.make({message: 'Production benchmark target did not receive verified seed authority.'});
    }
    const prepareForQuery = (query: string) =>
      prepareRecallSections(config, {
        exactMatches: [],
        feedbackQuery: query,
        includeInactive: false,
        limit: 10,
        minimumScore: 0,
        passes: [],
        project: 'threadnote',
        query,
        readRecords: () => Effect.succeed([]),
      });
    const prepare = prepareForQuery(`common retrieval ${PRODUCTION_BENCHMARK_QUERY}`);
    for (let index = 0; index < PRODUCTION_BENCHMARK_WARMUP_COUNT; index += 1) {
      const warmup = yield* prepare;
      if (!warmup.ranked.some(hit => hit.uri === 'threadnote://resources/repos/threadnote/09999.md')) {
        return yield* ScriptError.make({message: 'Production benchmark failed to retrieve its exact target.'});
      }
    }
    const targetUri = 'threadnote://resources/repos/threadnote/09999.md';
    const measure = (
      samples: number,
      p95LimitMilliseconds: number,
      beforeSample: (sample: number) => Effect.Effect<void, unknown, FileSystem.FileSystem>,
      runSample: (sample: number) => ReturnType<typeof prepareForQuery> = () => prepare,
    ) =>
      Effect.gen(function* () {
        const observations: RecallEvaluationSample[] = [];
        for (let sample = 0; sample < samples; sample += 1) {
          yield* beforeSample(sample);
          const measured = yield* measureRecallEvaluationSample(() => runSample(sample));
          const result = measured.result;
          if (!result.ranked.some(hit => hit.uri === targetUri)) {
            return yield* ScriptError.make({message: 'Production benchmark failed to retrieve its target.'});
          }
          observations.push({...measured.observation, resultCount: result.ranked.length});
        }
        return {
          summary: recallEvaluationScenario(observations, p95LimitMilliseconds),
          observations,
        };
      });
    const hotQuery = yield* measure(HOT_QUERY_SAMPLE_COUNT, HOT_QUERY_P95_LIMIT_MILLISECONDS, () => Effect.void);
    const measureExactSearch = (term: string, expected: 'hit' | 'no-hit') =>
      Effect.gen(function* () {
        const observations: RecallEvaluationSample[] = [];
        for (let sample = 0; sample < EXACT_SEARCH_SAMPLE_COUNT; sample += 1) {
          const measured = yield* measureRecallEvaluationSample(() =>
            loadRecallExactMatches(config, {
              includeInactive: false,
              terms: [term],
              uriScopes: ['threadnote://resources/repos/threadnote'],
            }),
          );
          const matches = measured.result;
          const found = matches.some(match => match.uri === targetUri);
          if ((expected === 'hit' && !found) || (expected === 'no-hit' && matches.length > 0)) {
            return yield* ScriptError.make({
              message: `Production exact-search benchmark produced an unexpected ${expected}.`,
            });
          }
          observations.push({...measured.observation, resultCount: matches.length});
        }
        return {
          summary: recallEvaluationScenario(observations, EXACT_SEARCH_P95_LIMIT_MILLISECONDS),
          observations,
        };
      });
    const exactSubstring = yield* measureExactSearch('anchor-9999', 'hit');
    const exactNoHit = yield* measureExactSearch('no-hit-anchor-908172635', 'no-hit');
    const coldDecode = yield* measure(COLD_DECODE_SAMPLE_COUNT, COLD_DECODE_P95_LIMIT_MILLISECONDS, () =>
      clearRecallIndexMemoryCache(),
    );
    const sourceValidation = yield* measure(VALIDATION_SAMPLE_COUNT, VALIDATION_P95_LIMIT_MILLISECONDS, () =>
      expireRecallIndexValidation(agentContextHome, false, []),
    );
    const incrementalUpdate = yield* measure(
      INCREMENTAL_UPDATE_SAMPLE_COUNT,
      INCREMENTAL_UPDATE_P95_LIMIT_MILLISECONDS,
      sample =>
        Effect.gen(function* () {
          const content = `# Production benchmark target\n\ncommon retrieval ${PRODUCTION_BENCHMARK_QUERY} benchmark-update-${String(sample).padStart(3, '0')}`;
          yield* Effect.all([
            fs.writeFileString(targetResourcePath, content),
            fs.writeFileString(targetRepoPath, content),
          ]);
          const timestamp = DateTime.toDateUtc(
            DateTime.makeUnsafe(PRODUCTION_BENCHMARK_BASE_TIMESTAMP_MILLISECONDS + (sample + 1) * 1_000),
          );
          yield* Effect.all([
            fs.utimes(targetResourcePath, timestamp, timestamp),
            fs.utimes(targetRepoPath, timestamp, timestamp),
          ]);
          yield* writeSeedState;
          yield* expireRecallIndexValidation(agentContextHome, false, [targetUri]);
        }),
      sample => prepareForQuery(`benchmark-update-${String(sample).padStart(3, '0')}`),
    );
    const finalUnchangedQuery = yield* prepare;
    if (!finalUnchangedQuery.ranked.some(hit => hit.uri === targetUri)) {
      return yield* ScriptError.make({
        message: 'Production benchmark lost an unchanged-term target after sustained incremental updates.',
      });
    }
    return {
      documents: PRODUCTION_BENCHMARK_DOCUMENT_COUNT,
      scenarios: {
        coldDecode: coldDecode.summary,
        exactNoHit: exactNoHit.summary,
        exactSubstring: exactSubstring.summary,
        hotQuery: hotQuery.summary,
        incrementalUpdate: incrementalUpdate.summary,
        sourceValidation: sourceValidation.summary,
      },
      observations: {
        coldDecode: coldDecode.observations,
        exactNoHit: exactNoHit.observations,
        exactSubstring: exactSubstring.observations,
        hotQuery: hotQuery.observations,
        incrementalUpdate: incrementalUpdate.observations,
        sourceValidation: sourceValidation.observations,
      },
      warmups: PRODUCTION_BENCHMARK_WARMUP_COUNT,
    };
  }),
);

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer), {
  disableErrorReporting: false,
});
