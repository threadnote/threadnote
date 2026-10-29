import {Array as EffectArray, Option as EffectOption} from 'effect';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {DateTime, Effect, FileSystem, Path} from 'effect';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {sha256FileHex} from '@threadnote/platform/digest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  baselineResult,
  CURRENT_RECALL_BASELINE_PATH,
  parseRecallEvaluationBaselineV1,
} from '@threadnote/threadnote/evaluation/recall-baseline';
import {
  createRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '@threadnote/threadnote/evaluation/recall-fixture';
import {evaluateRecallNonInferiority} from '@threadnote/threadnote/evaluation/recall-gate';
import {
  evaluateRecallRunV2,
  runScoredRecallEvaluationV2,
  type RecallEvaluationQueryScores,
} from '@threadnote/threadnote/evaluation/recall';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {parseLocalModelManifest, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {deriveRecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {rankRecallCandidates} from '@threadnote/recall/rank';
import {normalizeRecallRerankerScore} from '@threadnote/recall/reranker-score';
import {normalizeVector} from '@threadnote/inference/vector-search';
import {atomicWrite, fixtureHash, markFailure, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const evaluateModels = Effect.gen(function* () {
  const path = yield* Path.Path;
  const options = parseArguments(yield* scriptArguments(), path.resolve);
  const fixture = createRecallEvaluationFixtureV2();
  const hash = yield* fixtureHash(serializeRecallEvaluationFixtureV2Identity(fixture));
  const baseline = parseRecallEvaluationBaselineV1(yield* readJsonFile(options.baseline));
  if (baseline.fixture.hash !== hash) {
    return yield* ScriptError.make({
      message: `Recall baseline fixture hash ${baseline.fixture.hash} does not match generated fixture hash ${hash}.`,
    });
  }
  const embeddingManifest = options.embedding ? builtinManifest(options.embedding, 'embedding') : undefined;
  const localRerankerManifest = options.rerankerManifest
    ? parseLocalModelManifest(yield* readJsonFile(options.rerankerManifest))
    : undefined;
  if (localRerankerManifest && localRerankerManifest.role !== 'reranker') {
    return yield* ScriptError.make({message: `Local model ${localRerankerManifest.id} is not a reranker.`});
  }
  const rerankerManifest =
    localRerankerManifest ?? (options.reranker ? builtinManifest(options.reranker, 'reranker') : undefined);
  const manifests = EffectArray.filter(
    [embeddingManifest, rerankerManifest],
    (value): value is LocalModelManifest => value !== undefined,
  );
  if (manifests.length === 0) {
    return yield* ScriptError.make({
      message:
        'Pass --embedding <model-id>, --reranker <model-id>, or a local --reranker-manifest/--reranker-path pair.',
    });
  }

  const evaluationArtifact = yield* Effect.scoped(
    Effect.gen(function* () {
      const store = yield* LocalModelStore;
      const runtime = yield* LocalModelRuntime;
      const paths = new Map<string, string>();
      for (const candidate of manifests) {
        if (candidate === localRerankerManifest) {
          yield* verifyLocalModelArtifact(candidate, options.rerankerPath!);
          paths.set(candidate.id, options.rerankerPath!);
          continue;
        }
        const status = options.install
          ? yield* store.install(options.home, candidate)
          : yield* store.verify(options.home, candidate);
        paths.set(candidate.id, status.path);
      }

      const documentVectors = options.embedding
        ? yield* runtime.embedMany({
            inputs: EffectArray.map(
              fixture.documents,
              document => `${embeddingManifest!.promptPrefixes?.document ?? ''}${document.text}`,
            ),
            manifest: embeddingManifest!,
            modelPath: paths.get(options.embedding)!,
          })
        : undefined;
      const normalizedDocuments = EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(documentVectors), documents =>
          EffectArray.map(documents, normalizeVector),
        ),
      );
      const scoresByQuery = new Map<string, RecallEvaluationQueryScores>();
      for (const query of fixture.queries) {
        let semantic: Map<string, number> | undefined;
        if (embeddingManifest && normalizedDocuments) {
          const embedding = embeddingManifest;
          const [queryVector] = yield* runtime.embedMany({
            inputs: [`${embedding.promptPrefixes?.query ?? ''}${query.query}`],
            manifest: embedding,
            modelPath: paths.get(embedding.id)!,
          });
          const normalizedQuery = normalizeVector(queryVector);
          semantic = new Map(
            EffectArray.map(fixture.documents, (document, index) => [
              document.uri,
              Math.max(0, dot(normalizedQuery, normalizedDocuments[index])),
            ]),
          );
        }

        let reranker: Map<string, number> | undefined;
        if (rerankerManifest) {
          const shortlist = rankRecallCandidates(
            query.query,
            EffectArray.map(fixture.documents, document => ({
              ...document,
              semantic: semantic?.get(document.uri) ?? 0,
            })),
            {
              eligibility: deriveRecallEligibilityPolicy({
                explicitProject: query.project,
                originalQuery: query.query,
              }),
              now: query.now ? DateTime.toDateUtc(DateTime.makeUnsafe(query.now)) : undefined,
              project: query.project,
              seedUris: query.seedUris,
            },
          ).results.slice(0, 32);
          const reranking = rerankerManifest;
          const rawScores = yield* runtime.rerank({
            documents: EffectArray.map(shortlist, result =>
              Effect2.pipe(result.candidate.text, EffectString.slice(0, 4_000)),
            ),
            manifest: reranking,
            modelPath: paths.get(reranking.id)!,
            query: query.query,
          });
          reranker = new Map(
            EffectArray.map(shortlist, (result, index) => [
              result.candidate.uri,
              normalizeRecallRerankerScore(rawScores[index] ?? 0),
            ]),
          );
        }
        scoresByQuery.set(query.id, {reranker, semantic});
      }

      const modelIds = EffectArray.join(
        EffectArray.map(manifests, candidate => candidate.id),
        '+',
      );
      const run = runScoredRecallEvaluationV2(fixture, scoresByQuery, {
        fixtureHash: hash,
        model: modelIds,
        pipelineName: rerankerManifest ? 'threadnote-4-native-hybrid-reranked' : 'threadnote-4-native-hybrid',
        revision: EffectArray.join(
          EffectArray.map(manifests, candidate => candidate.revision),
          '+',
        ),
      });
      return {
        fixture: {
          documents: fixture.documents.length,
          hash,
          queries: fixture.queries.length,
          version: fixture.version,
        },
        models: manifests,
        result: evaluateRecallRunV2(fixture, run),
        run,
        version: 1,
      };
    }),
  );
  const gate = evaluateRecallNonInferiority(baselineResult(baseline), evaluationArtifact.result);
  const artifact = {...evaluationArtifact, gate};

  if (options.output) yield* atomicWrite(options.output, `${JSON.stringify(artifact, undefined, 2)}\n`);
  const summary = {
    baseline: {
      fixtureHash: baseline.fixture.hash,
      pipeline: baseline.result.pipeline,
      version: baseline.version,
    },
    fixture: artifact.fixture,
    gate,
    models: EffectArray.map(artifact.models, candidate => ({
      id: candidate.id,
      revision: candidate.revision,
      role: candidate.role,
      sha256: candidate.sha256,
    })),
    result: {
      categories: artifact.result.categories,
      failureCount: artifact.result.failures.length,
      metrics: artifact.result.metrics,
      pipeline: artifact.result.pipeline,
    },
    version: artifact.version,
  };
  if (options.summaryOutput) {
    yield* atomicWrite(options.summaryOutput, `${JSON.stringify(summary, undefined, 2)}\n`);
  }
  yield* printJson(summary);
  if (options.failOnRegression && !gate.passed) yield* markFailure();
});

function builtinManifest(id: string, role: 'embedding' | 'reranker'): LocalModelManifest {
  const candidate = EffectOption.getOrUndefined(
    EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, value => value.id === id),
  );
  if (!candidate || candidate.role !== role) throw ScriptError.make({message: `Unknown ${role} model: ${id}`});
  return candidate;
}

function dot(left: readonly number[], right: readonly number[]): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

interface Options {
  readonly baseline: string;
  readonly embedding?: string;
  readonly failOnRegression: boolean;
  readonly home: string;
  readonly install: boolean;
  readonly output?: string;
  readonly reranker?: string;
  readonly rerankerManifest?: string;
  readonly rerankerPath?: string;
  readonly summaryOutput?: string;
}

function parseArguments(args: readonly string[], resolve: (value: string) => string): Options {
  let baseline = resolve(CURRENT_RECALL_BASELINE_PATH);
  let embedding: string | undefined;
  let failOnRegression = false;
  let home = resolve('.artifacts/model-bakeoff-home');
  let install = false;
  let output: string | undefined;
  let reranker: string | undefined;
  let rerankerManifest: string | undefined;
  let rerankerPath: string | undefined;
  let summaryOutput: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--baseline') baseline = resolve(required(args[++index], argument));
    else if (argument === '--embedding') embedding = required(args[++index], argument);
    else if (argument === '--fail-on-regression') failOnRegression = true;
    else if (argument === '--home') home = resolve(required(args[++index], argument));
    else if (argument === '--install') install = true;
    else if (argument === '--output') output = required(args[++index], argument);
    else if (argument === '--reranker') reranker = required(args[++index], argument);
    else if (argument === '--reranker-manifest') rerankerManifest = resolve(required(args[++index], argument));
    else if (argument === '--reranker-path') rerankerPath = resolve(required(args[++index], argument));
    else if (argument === '--summary-output') summaryOutput = required(args[++index], argument);
    else throw ScriptError.make({message: `Unknown model-evaluation option: ${argument}`});
  }
  if ((rerankerManifest === undefined) !== (rerankerPath === undefined)) {
    throw ScriptError.make({message: '--reranker-manifest and --reranker-path must be passed together.'});
  }
  if (reranker && rerankerManifest) {
    throw ScriptError.make({message: '--reranker cannot be combined with --reranker-manifest.'});
  }
  return {
    baseline,
    embedding,
    failOnRegression,
    home,
    install,
    output,
    reranker,
    rerankerManifest,
    rerankerPath,
    summaryOutput,
  };
}

const verifyLocalModelArtifact = Effect.fn('evaluateRecallModels.verifyLocalModelArtifact')(function* (
  manifest: LocalModelManifest,
  modelPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(modelPath);
  if (info.type !== 'File')
    throw ScriptError.make({message: `Local reranker artifact is not a regular file: ${modelPath}`});
  if (Number(info.size) !== manifest.size) {
    throw ScriptError.make({
      message: `Local reranker size ${info.size} does not match manifest size ${manifest.size}.`,
    });
  }
  const digest = yield* sha256FileHex(modelPath);
  if (digest !== manifest.sha256) {
    throw ScriptError.make({
      message: `Local reranker SHA-256 ${digest} does not match manifest SHA-256 ${manifest.sha256}.`,
    });
  }
});

function required(value: string | undefined, option: string): string {
  if (
    !Effect2.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  )
    throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

BunRuntime.runMain(provideScriptLayer(evaluateModels, ApplicationLayer));
