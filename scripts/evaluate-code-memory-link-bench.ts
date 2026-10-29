#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, Path} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {evaluateCodeMemoryLinkBenchRuntime} from '@threadnote/threadnote/evaluation/code-memory-link-bench';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFAULT_FIXTURE = new URL(
  '../apps/threadnote/test/evaluation/fixtures/code-memory-link-bench-v1/fixture.json',
  import.meta.url,
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const options = parseArguments(yield* scriptArguments());
    const fixturePath = options.fixturePath ?? (yield* path.fromFileUrl(DEFAULT_FIXTURE));
    const result = yield* evaluateCodeMemoryLinkBenchRuntime(yield* readJsonFile(fixturePath));
    if (options.outputPath !== undefined) {
      yield* atomicWrite(options.outputPath, `${JSON.stringify(result, undefined, 2)}\n`);
    }
    yield* printJson(result);
    if (!result.gate.passed) return yield* ScriptError.make({message: EffectArray.join(result.gate.failures, '\n')});
  }),
);

function parseArguments(args: readonly string[]): {readonly fixturePath?: string; readonly outputPath?: string} {
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--fixture') fixturePath = required(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else throw ScriptError.make({message: `Unknown CodeMemoryLinkBench option: ${argument}`});
  }
  return {
    ...(fixturePath === undefined ? {} : {fixturePath}),
    ...(outputPath === undefined ? {} : {outputPath}),
  };
}

function required(value: string | undefined, option: string): string {
  if (
    !Effect2.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  )
    throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
