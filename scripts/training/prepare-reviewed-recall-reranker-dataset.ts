import {Array as EffectArray} from 'effect';
import {ScriptSystemInfoLayer} from '../effect/system-layer.js';
import {provideScriptLayer, ScriptError} from '../effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Layer, Path} from 'effect';

import {atomicWrite, scriptArguments} from '../effect/script.js';
import {serializeRecallRerankerGroupsV1} from './recall-reranker-contract.js';
import {prepareReviewedRecallRerankerDatasetV1} from './recall-reranker-preparation.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = yield* scriptArguments();
  if (args.includes('--help') || args.includes('-h')) {
    yield* Console.log(usage());
    return;
  }
  const options = parseArguments(args, path.resolve);
  const draftContent = yield* fs.readFileString(options.draft);
  const groupContent = yield* fs.readFileString(options.groups);
  const dataset = prepareReviewedRecallRerankerDatasetV1(parseJson(draftContent, options.draft), groupContent);
  const manifestPath = path.join(options.output, 'manifest.json');
  const groupPath = path.join(options.output, dataset.manifest.groupFile);
  yield* atomicWrite(groupPath, serializeRecallRerankerGroupsV1(dataset.groups));
  yield* atomicWrite(manifestPath, `${JSON.stringify(dataset.manifest, undefined, 2)}\n`);
  yield* Console.log(
    `Prepared ${dataset.manifest.name}: ${dataset.manifest.counts.groups} reviewed groups and ` +
      `${dataset.manifest.counts.candidates} reviewed candidates.`,
  );
  yield* Console.log(`Manifest: ${manifestPath}`);
  yield* Console.log(`Next: bun scripts/validate-recall-reranker-dataset.ts --dataset ${options.output}`);
});

interface Options {
  readonly draft: string;
  readonly groups: string;
  readonly output: string;
}

function parseArguments(args: readonly string[], resolve: (value: string) => string): Options {
  let draft: string | undefined;
  let groups: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--draft') draft = resolve(required(args[++index], argument));
    else if (argument === '--groups') groups = resolve(required(args[++index], argument));
    else if (argument === '--output') output = resolve(required(args[++index], argument));
    else throw ScriptError.make({message: `Unknown reviewed-dataset preparation option: ${argument}\n\n${usage()}`});
  }
  if (draft === undefined || groups === undefined || output === undefined) {
    throw ScriptError.make({message: `--draft, --groups, and --output are required.\n\n${usage()}`});
  }
  return {draft, groups, output};
}

function parseJson(content: string, source: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (cause) {
    throw ScriptError.make({message: `Could not parse JSON file: ${source}`, cause});
  }
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

function usage(): string {
  return EffectArray.join(
    [
      'Prepare a Threadnote recall-reranker dataset from already reviewed source rows.',
      '',
      'Usage:',
      '  bun scripts/training/prepare-reviewed-recall-reranker-dataset.ts \\',
      '    --draft <draft.json> --groups <reviewed-groups.jsonl> --output <dataset-directory>',
      '',
      'This command never sets reviewed=true. Every input candidate must already be human-reviewed.',
      'Run scripts/validate-recall-reranker-dataset.ts afterward to emit the training receipt.',
    ],
    '\n',
  );
}

const scriptLayer = Layer.mergeAll(BunServices.layer, ScriptSystemInfoLayer);
BunRuntime.runMain(provideScriptLayer(program, scriptLayer));
