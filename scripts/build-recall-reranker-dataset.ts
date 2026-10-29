import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, Layer, Path} from 'effect';

import {atomicWrite, scriptArguments} from './effect/script.js';
import {serializeRecallRerankerGroupsV1} from './training/recall-reranker-contract.js';
import {createRecallRerankerSmokeDatasetV1} from './training/recall-reranker-smoke.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const args = yield* scriptArguments();
  if (args.includes('--help') || args.includes('-h')) {
    yield* Console.log(
      'Usage: bun run train:reranker:data -- [--output <dataset-directory>]\n' +
        'Builds the deterministic harness_smoke dataset only; it is never release training data.',
    );
    return;
  }
  const options = parseArguments(args, path.resolve);
  const dataset = createRecallRerankerSmokeDatasetV1();
  const manifestPath = path.join(options.output, 'manifest.json');
  const groupPath = path.join(options.output, dataset.manifest.groupFile);
  yield* atomicWrite(groupPath, serializeRecallRerankerGroupsV1(dataset.groups));
  yield* atomicWrite(manifestPath, `${JSON.stringify(dataset.manifest, undefined, 2)}\n`);
  yield* Console.log(
    `Built ${dataset.manifest.purpose} dataset ${dataset.manifest.name}: ` +
      `${dataset.manifest.counts.groups} groups, ${dataset.manifest.counts.candidates} candidates.`,
  );
  yield* Console.log(`Manifest: ${manifestPath}`);
});

interface Options {
  readonly output: string;
}

function parseArguments(args: readonly string[], resolve: (value: string) => string): Options {
  let output = resolve('.artifacts/training/recall-reranker/datasets/smoke-v1');
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') output = resolve(required(args[++index], argument));
    else
      throw ScriptError.make({message: `Unknown recall reranker dataset option: ${argument}. Pass --help for usage.`});
  }
  return {output};
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
