import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  baselineResult,
  CURRENT_RECALL_BASELINE_PATH,
  exceedsReviewedContractFailureLimit,
  parseRecallEvaluationBaselineV1,
} from '@threadnote/threadnote/evaluation/recall-baseline';
import {
  createRecallEvaluationFixtureV2,
  expandRecallEvaluationFixtureV2,
  recallEvaluationCategoryCounts,
  serializeRecallEvaluationFixtureV2Identity,
} from '@threadnote/threadnote/evaluation/recall-fixture';
import {evaluateRecallNonInferiority} from '@threadnote/threadnote/evaluation/recall-gate';
import {evaluateRecallRunV2, runLexicalRecallEvaluationV2} from '@threadnote/threadnote/evaluation/recall';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {atomicWrite, fixtureHash, markFailure, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const evaluateRecall = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  const threadnoteVersion = yield* getThreadnoteVersion();
  const baseFixture = createRecallEvaluationFixtureV2();
  const fixture = expandRecallEvaluationFixtureV2(baseFixture, options.documentCount, options.seed);
  const hash = yield* fixtureHash(serializeRecallEvaluationFixtureV2Identity(fixture));
  const run = runLexicalRecallEvaluationV2(fixture, {
    fixtureHash: hash,
    pipelineName: `threadnote-${threadnoteVersion}-${options.globalEligibility ? 'lexical-global' : 'lexical-only'}`,
    projectEligibility: options.globalEligibility ? 'global' : 'explicit',
  });
  const result = evaluateRecallRunV2(fixture, run);
  const baseline = options.baselinePath
    ? parseRecallEvaluationBaselineV1(yield* readJsonFile(options.baselinePath))
    : undefined;
  if (baseline && baseline.fixture.hash !== hash) {
    return yield* ScriptError.make({
      message: `Recall baseline fixture hash ${baseline.fixture.hash} does not match generated fixture hash ${hash}`,
    });
  }
  const gate = baseline ? evaluateRecallNonInferiority(baselineResult(baseline), result) : undefined;
  const artifact = {
    fixture: {
      categories: recallEvaluationCategoryCounts(fixture),
      documents: fixture.documents.length,
      hash,
      metadata: fixture.metadata,
      queries: fixture.queries.length,
      version: fixture.version,
    },
    result,
    run,
    ...(gate ? {gate} : {}),
    version: 1,
  };
  const summary = {
    fixture: artifact.fixture,
    result: {
      categories: result.categories,
      failureCount: result.failures.length,
      failures: result.failures.slice(0, options.maximumPrintedFailures),
      metrics: result.metrics,
      pipeline: result.pipeline,
      version: result.version,
    },
    ...(gate ? {gate} : {}),
    version: artifact.version,
  };

  if (options.outputPath) {
    yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  }
  yield* printJson(options.full ? artifact : summary);
  if (
    (options.failOnContract && exceedsReviewedContractFailureLimit(result.failures, baseline)) ||
    (options.failOnRegression && gate && !gate.passed)
  ) {
    yield* markFailure();
  }
});

interface EvaluationOptions {
  readonly baselinePath?: string;
  readonly documentCount: number;
  readonly failOnContract: boolean;
  readonly failOnRegression: boolean;
  readonly full: boolean;
  readonly globalEligibility: boolean;
  readonly maximumPrintedFailures: number;
  readonly outputPath?: string;
  readonly seed: number;
}

function parseArguments(args: readonly string[]): EvaluationOptions {
  let baselinePath: string | undefined = CURRENT_RECALL_BASELINE_PATH;
  let documentCount = 200;
  let failOnContract = false;
  let failOnRegression = false;
  let full = false;
  let globalEligibility = false;
  let maximumPrintedFailures = 20;
  let outputPath: string | undefined;
  let seed = 0x4_00_00;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--documents') documentCount = positiveInteger(args[++index], '--documents');
    else if (argument === '--baseline') baselinePath = requiredValue(args[++index], '--baseline');
    else if (argument === '--no-baseline') baselinePath = undefined;
    else if (argument === '--fail-on-contract') failOnContract = true;
    else if (argument === '--fail-on-regression') failOnRegression = true;
    else if (argument === '--full') full = true;
    else if (argument === '--global-eligibility') globalEligibility = true;
    else if (argument === '--max-failures') maximumPrintedFailures = positiveInteger(args[++index], '--max-failures');
    else if (argument === '--output') outputPath = requiredValue(args[++index], '--output');
    else if (argument === '--seed') seed = positiveInteger(args[++index], '--seed');
    else throw ScriptError.make({message: `Unknown recall-v2 evaluation option: ${argument}`});
  }
  if (failOnRegression && !baselinePath) {
    throw ScriptError.make({message: '--fail-on-regression cannot be combined with --no-baseline'});
  }
  if (globalEligibility && baselinePath) {
    throw ScriptError.make({
      message: '--global-eligibility requires --no-baseline so retrieval contracts are not conflated',
    });
  }
  return {
    baselinePath,
    documentCount,
    failOnContract,
    failOnRegression,
    full,
    globalEligibility,
    maximumPrintedFailures,
    outputPath,
    seed,
  };
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = Number.parseInt(requiredValue(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw ScriptError.make({message: `${option} requires a positive integer`});
  }
  return parsed;
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

BunRuntime.runMain(provideScriptLayer(evaluateRecall, ApplicationLayer));
