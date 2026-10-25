/* oxlint-disable effecttsgo/node-builtin-import -- Filesystem directory creation/removal and baseline capability probes are native OS boundaries; file contents use Bun. */
import {existsSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {bazelDiffPath, bazelPath} from '../bazel/cli-tools.mjs';
import {readPreparedInventory} from '../bazel/prepare.mjs';
import {selectTargets} from './selection.mjs';

const root = resolve(import.meta.dir, '../..');
const option = name => process.argv[process.argv.indexOf(name) + 1];
const base = process.argv.includes('--base') ? option('--base') : undefined;
const output = resolve(root, process.argv.includes('--output') ? option('--output') : '.context/bazel-selection');
mkdirSync(output, {recursive: true});
const run = async (args, cwd = root, raw = false) => {
  const child = Bun.spawn(args, {cwd, stdout: 'pipe', stderr: 'pipe'});
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args[0]} ${args[1]} failed (${code}): ${stderr.slice(-1500)}`);
  return raw ? stdout : stdout.trim();
};
// Capture authored paths before preparation publishes generated files.
let revision;
let changeFailure;
let changedFiles = [];
try {
  if (!base || !/^[a-zA-Z0-9_./-]+$/u.test(base)) throw new Error('Missing or invalid baseline revision');
  revision = await run(['git', 'rev-parse', '--verify', `${base}^{commit}`]);
  const tracked = await run(['git', 'diff', '--name-only', '--no-renames', '-z', revision], root, true);
  const untracked = await run(['git', 'ls-files', '--others', '--exclude-standard', '-z'], root, true);
  changedFiles = [...new Set([tracked, untracked].flatMap(value => value.split('\0').filter(Boolean)))].sort();
} catch (error) {
  changeFailure = error instanceof Error ? error.message : String(error);
}
// An invalid head is fatal; only baseline/hash failures may select the valid full head.
const {inventory, generation} = await readPreparedInventory({root});
// Preserve the exact prepared model alongside hashes after outputs leave Git.
await Bun.write(join(output, 'inventory.json'), Bun.file(join(root, 'tools/bazel/targets.json')));
await Bun.write(join(output, 'generation-receipt.json'), Bun.file(join(root, '.context/bazel-generated/receipt.json')));
const prepareBaseline = async cwd => {
  if (await Bun.file(join(cwd, 'tools/bazel/prepare.mjs')).exists()) {
    await run([process.execPath, 'tools/bazel/prepare.mjs'], cwd);
  } else {
    const script = join(cwd, 'apps/website/tools/site-prepared-metadata.ts');
    if (await Bun.file(script).exists())
      await run([process.execPath, script, '--output', join(cwd, 'apps/website/.bazel-inputs/metadata.json')], cwd);
    await run([process.execPath, 'tools/bazel/generate.mjs'], cwd);
  }
};
for (const name of ['base-inventory.json', 'base-generation-receipt.json']) {
  const file = Bun.file(join(output, name));
  if (await file.exists()) await file.delete();
}
let impacted = [];
let failure;
let baseInventory;
let directory;
let executable;
try {
  if (changeFailure) throw new Error(changeFailure);
  directory = mkdtempSync(join(tmpdir(), 'threadnote-bazel-base-'));
  await run(['git', 'worktree', 'add', '--detach', directory, revision]);
  if (
    !existsSync(join(directory, 'MODULE.bazel')) ||
    (!existsSync(join(directory, 'tools/bazel/generate.mjs')) &&
      !existsSync(join(directory, 'tools/bazel/prepare.mjs')))
  )
    throw new Error('Baseline has no modeled Bazel graph');
  executable = await bazelPath(root);
  const diff = await bazelDiffPath(root);
  await run([process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts'], directory);
  await prepareBaseline(directory);
  const baseInventoryFile = Bun.file(join(directory, 'tools/bazel/targets.json'));
  baseInventory = await baseInventoryFile.json();
  await Bun.write(join(output, 'base-inventory.json'), baseInventoryFile);
  const baseReceipt = Bun.file(join(directory, '.context/bazel-generated/receipt.json'));
  if (await baseReceipt.exists()) await Bun.write(join(output, 'base-generation-receipt.json'), baseReceipt);
  for (const [name, cwd] of [
    ['base', directory],
    ['head', root],
  ]) {
    await run([
      diff,
      'generate-hashes',
      '-w',
      cwd,
      '-b',
      executable,
      '--bazelCommandOptions=--noshow_progress --lockfile_mode=off',
      join(output, `${name}.json`),
    ]);
  }
  await run([
    diff,
    'get-impacted-targets',
    '-w',
    root,
    '-b',
    executable,
    '--excludeExternalTargets=true',
    '--startingHashes',
    join(output, 'base.json'),
    '--finalHashes',
    join(output, 'head.json'),
    '-o',
    join(output, 'impacted.txt'),
  ]);
  const impactedText = await Bun.file(join(output, 'impacted.txt')).text();
  impacted = impactedText
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  if (directory) {
    if (executable) {
      try {
        await run([executable, 'shutdown'], directory);
      } catch {
        // Preserve the conservative selection result if the baseline server already exited.
      }
    }
    try {
      await run(['git', 'worktree', 'remove', '--force', directory]);
    } catch {
      rmSync(directory, {recursive: true, force: true});
    }
  }
}
const modeledInputs = [...inventory.targets, ...(baseInventory?.targets ?? [])].flatMap(target => target.inputs);
const declarations = [...inventory.targets, ...(baseInventory?.targets ?? [])].map(target => {
  const packagePath = target.label.slice(2).split(':')[0];
  return packagePath ? `${packagePath}/BUILD.bazel` : 'BUILD.bazel';
});
const result = selectTargets({
  inventory: inventory.targets.map(target => target.label),
  impacted,
  changedFiles,
  knownInputs: [...modeledInputs, ...declarations, 'tools/bazel/targets.json'],
  targetDependencies: Object.fromEntries(inventory.targets.map(target => [target.label, target.dependsOn ?? []])),
  targetInputs: Object.fromEntries(inventory.targets.map(target => [target.label, target.inputs])),
  failure,
});
await Bun.write(
  join(output, 'selection.json'),
  JSON.stringify({...result, base, changedFiles, generation, modeledTargetCount: inventory.targets.length}, null, 2) +
    '\n',
);
await Bun.write(join(output, 'targets.txt'), result.targets.join('\n') + (result.targets.length ? '\n' : ''));
const appendOutput = async text =>
  Bun.write(
    process.env.GITHUB_OUTPUT,
    (await Bun.file(process.env.GITHUB_OUTPUT)
      .text()
      .catch(() => '')) + text,
  );
if (process.env.GITHUB_OUTPUT) {
  const selected = new Set(result.targets);
  const lanes = new Set(
    inventory.targets.flatMap(target => (target.kind === 'ci' && target.lane ? [target.lane] : [])),
  );
  for (const lane of [...lanes].sort()) {
    const enabled = inventory.targets.some(target => target.lane === lane && selected.has(target.label));
    await appendOutput(`${lane}=${enabled}\n`);
  }
  await appendOutput(`targets=${JSON.stringify(result.targets)}\n`);
}
process.stdout.write(
  `${result.mode}: ${result.targets.length}/${inventory.targets.length} modeled targets (${result.reason})\n`,
);
