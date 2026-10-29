#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';

import {evaluateContextBriefCitationFixture} from '@threadnote/threadnote/evaluation/context-brief-citations';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface Arguments {
  readonly fixturePath: string;
  readonly outputPath?: string;
}

function usage(): string {
  return EffectArray.join(
    [
      'Usage: bun scripts/evaluate-context-brief-citations.ts --fixture <observations.json> [--output <result.json>]',
      '',
      'Evaluates bounded, offline memory-to-code citation observations.',
      'Exits non-zero when parsing fails or a release gate fails.',
    ],
    '\n',
  );
}

function parseArguments(argv: readonly string[]): Arguments | 'help' {
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return 'help';
    if (argument === '--fixture') {
      fixturePath = argumentValue(argv, index, '--fixture');
      index += 1;
      continue;
    }
    if (argument === '--output') {
      outputPath = argumentValue(argv, index, '--output');
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!fixturePath) throw new Error('--fixture is required.');
  return {...(outputPath === undefined ? {} : {outputPath}), fixturePath};
}

function argumentValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || Effect.pipe(value, EffectString.startsWith('-')))
    throw new Error(`${name} requires a value.`);
  return value;
}

async function main(): Promise<void> {
  const parsed = parseArguments(Bun.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const fixture = JSON.parse(await Bun.file(parsed.fixturePath).text()) as unknown;
  const result = evaluateContextBriefCitationFixture(fixture);
  const output = `${JSON.stringify(result, undefined, 2)}\n`;
  if (parsed.outputPath === undefined) process.stdout.write(output);
  else await Bun.write(parsed.outputPath, output);
  if (!result.gate.passed) process.exitCode = 1;
}

await main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Context Brief citation evaluation failed: ${message}\n${usage()}\n`);
  process.exitCode = 1;
});
