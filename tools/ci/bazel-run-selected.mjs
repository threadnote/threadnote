import {Array as EffectArray} from 'effect';
/* oxlint-disable effecttsgo/node-builtin-import -- CI artifact and Bazel subprocess boundary. */
import {readPreparedInventory} from '../bazel/prepare.mjs';
import {resolve} from 'node:path';
import {bazelPath} from '../bazel/cli-tools.mjs';

const root = resolve(import.meta.dir, '../..');
const selection = await Bun.file(resolve(root, process.argv[2] ?? '.context/bazel-selection/selection.json')).json();
if (!selection.generation) throw new Error('Selection is missing its prepared generation');
const {inventory} = await readPreparedInventory({root, expectedGeneration: selection.generation});
const allowed = new Set(inventory.targets.map(target => target.label));
if (!EffectArray.isArray(selection.targets) || selection.targets.some(label => !allowed.has(label)))
  throw new Error('Invalid modeled target selection');
const executable = await bazelPath(root);
for (const kind of ['test', 'action']) {
  const targets = selection.targets.filter(label =>
    inventory.targets.some(target => target.label === label && target.kind === kind),
  );
  if (!targets.length) continue;
  const command = kind === 'test' ? ['test', '--local_test_jobs=1', ...targets] : ['build', ...targets];
  const child = Bun.spawn([executable, ...command], {
    cwd: root,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
process.stdout.write(`Validated ${selection.targets.length} selected modeled targets.\n`);
