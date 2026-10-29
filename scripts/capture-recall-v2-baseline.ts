import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  RECALL_BASELINE_VERSION,
  parseRecallEvaluationBaselineV1,
  type RecallEvaluationBaselineV1,
} from '@threadnote/threadnote/evaluation/recall-baseline';
import {
  createRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '@threadnote/threadnote/evaluation/recall-fixture';
import {evaluateRecallRunV2, runLexicalRecallEvaluationV2} from '@threadnote/threadnote/evaluation/recall';
import {RECALL_RANKER_VERSION} from '@threadnote/recall/rank';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {atomicWrite, fixtureHash, printJson, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const captureBaseline = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  const [threadnoteVersion, commit, committedAt, status] = yield* Effect.all(
    [
      getThreadnoteVersion(),
      git(['rev-parse', 'HEAD']),
      git(['show', '-s', '--format=%cI', 'HEAD']),
      git(['status', '--porcelain', '--untracked-files=all']),
    ],
    {concurrency: 'unbounded'},
  );
  if (status.length > 0) {
    return yield* ScriptError.make({
      message: 'Recall baselines must be captured from a clean checkout; commit or stash changes first.',
    });
  }
  const createdAt = options.createdAt ?? sourceDate(committedAt);
  const outputPath = options.outputPath ?? baselinePath(threadnoteVersion);
  const fixture = createRecallEvaluationFixtureV2();
  const hash = yield* fixtureHash(serializeRecallEvaluationFixtureV2Identity(fixture));
  const result = evaluateRecallRunV2(
    fixture,
    runLexicalRecallEvaluationV2(fixture, {
      createdAt,
      fixtureHash: hash,
      pipelineName: `threadnote-${threadnoteVersion}-lexical-only`,
    }),
  );
  const artifact: RecallEvaluationBaselineV1 = {
    createdAt,
    fixture: {
      documents: fixture.documents.length,
      hash,
      queries: fixture.queries.length,
      version: fixture.version,
    },
    knownContractFailures: result.failures.length,
    reviewedContractFailures: [...result.failures].sort(),
    result: {
      categories: result.categories,
      metrics: result.metrics,
      pipeline: result.pipeline,
    },
    source: {
      commit,
      dirty: false,
      openVikingVersion: 'not-applicable',
      rankerVersion: RECALL_RANKER_VERSION,
      threadnoteVersion,
    },
    version: RECALL_BASELINE_VERSION,
  };
  parseRecallEvaluationBaselineV1(artifact);
  const json = `${JSON.stringify(artifact, undefined, 2)}\n`;
  yield* atomicWrite(outputPath, json);
  yield* printJson(artifact);
});

interface Options {
  readonly createdAt?: string;
  readonly outputPath?: string;
}

function parseArguments(args: readonly string[]): Options {
  let createdAt: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--created-at') createdAt = isoDate(requiredValue(args[++index], argument));
    else if (argument === '--output') outputPath = requiredValue(args[++index], argument);
    else throw ScriptError.make({message: `Unknown recall baseline option: ${argument}`});
  }
  return {createdAt, outputPath};
}

function sourceDate(committedAt: string): string {
  const epoch = Bun.env.SOURCE_DATE_EPOCH;
  return epoch ? isoDate(new Date(Number(epoch) * 1_000).toISOString()) : isoDate(committedAt);
}

function baselinePath(threadnoteVersion: string): string {
  return `apps/threadnote/test/evaluation/baselines/threadnote-${threadnoteVersion}-${RECALL_RANKER_VERSION}/recall-v2-lexical.json`;
}

const git = Effect.fn('captureRecallBaseline.git')((arguments_: readonly string[]) =>
  runCommandEffect('git', arguments_, {timeoutMs: 30_000}).pipe(
    Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
  ),
);

function isoDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw ScriptError.make({message: `Invalid ISO timestamp: ${value}`});
  return date.toISOString();
}

function requiredValue(value: string | undefined, option: string): string {
  if (
    !Effect2.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  )
    throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

BunRuntime.runMain(provideScriptLayer(captureBaseline, ApplicationLayer));
