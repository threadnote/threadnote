/* oxlint-disable effecttsgo/node-builtin-import -- Directory creation and removal are native OS primitives; artifact contents use Bun. */
import {mkdirSync, rmSync} from 'node:fs';
import {readPreparedInventory} from '../bazel/prepare.mjs';
import {resolve} from 'node:path';
import {planBazelShards} from './bazel-shards.mjs';

const root = resolve(import.meta.dir, '../..');
const output = resolve(root, process.argv[2] ?? '.context/bazel-selection');
const selection = await Bun.file(resolve(output, 'selection.json')).json();
if (!selection.generation) throw new Error('Selection is missing its prepared generation');
const {inventory} = await readPreparedInventory({root, expectedGeneration: selection.generation});
const known = new Set(inventory.targets.map(target => target.label));
if (!Array.isArray(selection.targets) || selection.targets.some(label => !known.has(label)))
  throw new Error('Invalid modeled target selection');

const shards = planBazelShards({inventory: inventory.targets, selected: selection.targets});
const shardDirectory = resolve(output, 'shards');
rmSync(shardDirectory, {recursive: true, force: true});
mkdirSync(shardDirectory, {recursive: true});
for (const shard of shards) {
  await Bun.write(
    resolve(shardDirectory, `${shard.id}.json`),
    JSON.stringify({...selection, shard, targets: shard.targets}, null, 2) + '\n',
  );
}
await Bun.write(resolve(output, 'shards.json'), JSON.stringify({shards}, null, 2) + '\n');

const matrix = {include: shards.map(({id, name, postgres}) => ({id, name, postgres}))};
if (process.env.GITHUB_OUTPUT) {
  const previous = await Bun.file(process.env.GITHUB_OUTPUT)
    .text()
    .catch(() => '');
  await Bun.write(
    process.env.GITHUB_OUTPUT,
    previous +
      `matrix=${JSON.stringify(matrix)}\nexecute_bazel=${shards.length > 0}\n` +
      `executable_targets=${shards.reduce((count, shard) => count + shard.targets.length, 0)}\n`,
  );
}
process.stdout.write(
  `Planned ${shards.reduce((count, shard) => count + shard.targets.length, 0)} executable targets across ${shards.length} shard(s).\n`,
);
