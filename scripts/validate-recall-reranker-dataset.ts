import {Array as EffectArray} from 'effect';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Layer, Path} from 'effect';

import {
  createRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '@threadnote/threadnote/evaluation/recall-fixture';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {atomicWrite, scriptArguments} from './effect/script.js';
import {
  createRecallRerankerValidationReceiptV1,
  parseRecallRerankerDatasetManifestV1,
  parseRecallRerankerDatasetV1,
  parseRecallRerankerValidationPolicyV1,
  recallRerankerForbiddenTextsHashV1,
} from './training/recall-reranker-contract.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = yield* scriptArguments();
  if (args.includes('--help') || args.includes('-h')) {
    yield* Console.log(
      'Usage: bun run train:reranker:validate -- [--dataset <dataset-directory>]\n' +
        'Validates the dataset and emits a content-bound validation receipt.',
    );
    return;
  }
  const options = parseArguments(args, path.resolve);
  const manifestPath = path.join(options.dataset, 'manifest.json');
  const manifestContent = yield* fs.readFileString(manifestPath);
  const manifestValue = parseJson(manifestContent, manifestPath);
  const manifest = parseRecallRerankerDatasetManifestV1(manifestValue);
  const groupPath = path.join(options.dataset, manifest.groupFile);
  const groupContent = yield* fs.readFileString(groupPath);
  const policyPath = path.resolve('training/recall-reranker/validation-policy-v1.json');
  const policyContent = yield* fs.readFileString(policyPath);
  const policy = parseRecallRerankerValidationPolicyV1(parseJson(policyContent, policyPath));
  const evaluationFixture = createRecallEvaluationFixtureV2();
  const evaluationHash = sha256HexSync(serializeRecallEvaluationFixtureV2Identity(evaluationFixture));
  const forbiddenTexts = [
    ...EffectArray.map(evaluationFixture.documents, document => document.text),
    ...EffectArray.map(evaluationFixture.queries, query => query.query),
  ];
  const forbiddenTextsHash = recallRerankerForbiddenTextsHashV1(forbiddenTexts);
  if (
    policy.reservedEvaluation.name !== evaluationFixture.metadata.name ||
    policy.reservedEvaluation.sha256 !== evaluationHash ||
    policy.forbiddenTextsSha256 !== forbiddenTextsHash
  ) {
    return yield* ScriptError.make({
      message: 'Recall reranker validation policy does not match the current frozen recall evaluation fixture.',
    });
  }
  if (
    !EffectArray.some(
      manifest.reservedEvaluations,
      candidate => candidate.name === policy.reservedEvaluation.name && candidate.sha256 === evaluationHash,
    )
  ) {
    return yield* ScriptError.make({
      message: 'Dataset manifest does not reserve the current recall evaluation fixture.',
    });
  }
  const dataset = parseRecallRerankerDatasetV1(manifestValue, groupContent, {
    forbiddenTexts,
  });
  const receipt = createRecallRerankerValidationReceiptV1({dataset, manifestContent, policy, policyContent});
  const receiptPath = path.join(options.dataset, policy.receiptFile);
  yield* atomicWrite(receiptPath, `${JSON.stringify(receipt, undefined, 2)}\n`);
  yield* Console.log(
    `Validated ${dataset.manifest.name}: ${dataset.manifest.counts.groups} groups, ` +
      `${dataset.manifest.counts.candidates} candidates, SHA-256 ${dataset.manifest.groupsSha256}.`,
  );
  yield* Console.log(`Validation receipt: ${receiptPath}`);
});

function parseJson(content: string, source: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (cause) {
    throw ScriptError.make({message: `Could not parse JSON file: ${source}`, cause});
  }
}

interface Options {
  readonly dataset: string;
}

function parseArguments(args: readonly string[], resolve: (value: string) => string): Options {
  let dataset = resolve('.artifacts/training/recall-reranker/datasets/smoke-v1');
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dataset') dataset = resolve(required(args[++index], argument));
    else
      throw ScriptError.make({
        message: `Unknown recall reranker validation option: ${argument}. Pass --help for usage.`,
      });
  }
  return {dataset};
}

function required(value: string | undefined, option: string): string {
  if (
    !Effect2.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  )
    throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

const scriptLayer = Layer.mergeAll(BunServices.layer, ScriptSystemInfoLayer);
BunRuntime.runMain(provideScriptLayer(program, scriptLayer));
