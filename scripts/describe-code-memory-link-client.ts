#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {codeMemoryLinkClientImplementationDescriptorHash} from '@threadnote/threadnote/evaluation/code-memory-link-client-descriptor';
import {collectCodeMemoryLinkClientImplementation} from './code-memory-link-client-implementation.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const program = Effect.gen(function* () {
  const input = parseArguments(yield* scriptArguments());
  const {descriptor} = yield* collectCodeMemoryLinkClientImplementation(input);
  yield* atomicWrite(input.outputPath, `${JSON.stringify(descriptor, undefined, 2)}\n`);
  yield* Console.log(
    JSON.stringify({
      implementationDescriptorHash: codeMemoryLinkClientImplementationDescriptorHash(descriptor),
      output: input.outputPath,
    }),
  );
});

function parseArguments(args: readonly string[]) {
  const values: Record<string, string | undefined> = {};
  const clientArtifactBindings: Array<{path: string; role: string}> = [];
  const clientBinaryBindings: Array<{path: string; role: string}> = [];
  const clientArguments: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--client-arg') clientArguments.push(required(args[++index], argument));
    else if (argument === '--client-artifact-binding') {
      clientArtifactBindings.push(parseBinding(required(args[++index], argument), argument));
    } else if (argument === '--client-binary-binding') {
      clientBinaryBindings.push(parseBinding(required(args[++index], argument), argument));
    } else if (
      [
        '--client-command',
        '--client-config',
        '--client-config-projection',
        '--client-dependencies-lock',
        '--output',
      ].includes(argument)
    ) {
      values[argument] = required(args[++index], argument);
    } else throw ScriptError.make({message: `Unknown Code Memory Link client descriptor option: ${argument}`});
  }
  return {
    clientArtifactBindings,
    clientArguments,
    clientBinaryBindings,
    clientCommand: required(values['--client-command'], '--client-command'),
    clientConfigurationPath: required(values['--client-config'], '--client-config'),
    clientConfigurationProjectionPath: required(values['--client-config-projection'], '--client-config-projection'),
    clientDependenciesLockPath: required(values['--client-dependencies-lock'], '--client-dependencies-lock'),
    outputPath: required(values['--output'], '--output'),
  };
}

function parseBinding(value: string, option: string): {readonly path: string; readonly role: string} {
  const separator = Effect2.pipe(
    value,
    EffectString.indexOf('='),
    Effect2.Option.getOrElse(() => -1),
  );
  if (separator < 1) throw ScriptError.make({message: `${option} requires role=/absolute/path.`});
  return {
    path: Effect2.pipe(value, EffectString.slice(separator + 1)),
    role: Effect2.pipe(value, EffectString.slice(0, separator)),
  };
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

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
