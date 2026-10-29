import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {parseBenchmarkArtifactV1, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {createCodeGraphProductionRatchet} from './benchmark-code-graph.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const generate = Effect.gen(function* () {
  const {artifacts, outputPath} = parseArguments(yield* scriptArguments());
  const parsed: BenchmarkArtifactV1[] = [];
  for (const artifactPath of artifacts) {
    parsed.push(parseBenchmarkArtifactV1(yield* readJsonFile(artifactPath)));
  }
  const ratchet = createCodeGraphProductionRatchet(parsed);
  yield* atomicWrite(outputPath, `${JSON.stringify(ratchet, undefined, 2)}\n`);
  yield* printJson(ratchet);
});

function parseArguments(args: readonly string[]): {readonly artifacts: readonly string[]; readonly outputPath: string} {
  const artifacts: string[] = [];
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      const value = args[++index];
      if (
        !Effect2.pipe(value, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        )
      )
        throw ScriptError.make({message: '--output requires a path.'});
      outputPath = value;
    } else if (Effect2.pipe(argument, EffectString.startsWith('-'))) {
      throw ScriptError.make({message: `Unknown production ratchet generator option: ${argument}`});
    } else {
      artifacts.push(argument);
    }
  }
  if (outputPath === undefined) throw ScriptError.make({message: 'Production ratchet generation requires --output.'});
  if (artifacts.length < 3)
    throw ScriptError.make({message: 'Production ratchet generation requires at least three artifacts.'});
  return {artifacts, outputPath};
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(generate, ApplicationLayer));
