import {fileURLToPath} from 'node:url';
import {prepareBazelWorkspace} from './prepare.mjs';
import {bazelPath} from './cli-tools.mjs';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const command = EffectOption.getOrUndefined(
  EffectArray.findFirst(args, argument => !Effect.pipe(argument, EffectString.startsWith('-'))),
);
if (command && !['version', 'help', 'shutdown', 'clean'].includes(command)) await prepareBazelWorkspace({root});
const executable = await bazelPath(root);
const child = Bun.spawn([executable, ...args], {
  cwd: root,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exitCode = await child.exited;
