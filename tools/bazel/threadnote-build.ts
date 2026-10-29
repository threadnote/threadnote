import {Array as EffectArray} from 'effect';
/* oxlint-disable effecttsgo/node-builtin-import -- This file is the Bazel build process boundary. */
import {cpSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';

function run(arguments_: readonly string[]): void {
  const result = Bun.spawnSync([process.execPath, ...arguments_], {stderr: 'inherit', stdout: 'inherit'});
  if (result.exitCode !== 0) throw new Error(`${EffectArray.join(arguments_, ' ')} exited with ${result.exitCode}`);
}

run(['scripts/check-embedded-core-model.ts']);
run(['scripts/generate-code-graph-language-catalog.ts']);
run(['scripts/clean.ts']);
run(['scripts/build.ts']);

if (process.argv[2] === '--verify') {
  run(['scripts/check-self-contained.ts']);
} else {
  const output = process.argv[2];
  if (!output) throw new Error('Expected a declared Bazel output directory');
  if (!existsSync('dist')) throw new Error('Threadnote build did not create dist');
  cpSync('dist', resolve(output), {recursive: true});
}
