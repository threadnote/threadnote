import {Array as EffectArray} from 'effect';
/* oxlint-disable effecttsgo/node-builtin-import -- Dependency bootstrap cannot import packages before installing them. */
import {existsSync, readFileSync, readdirSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {dependencyClosure} from './dependency-closure.mjs';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const root = process.cwd();
const run = args => {
  const result = Bun.spawnSync([process.execPath, ...args], {
    env: {
      HOME: join(root, '.home'),
      BUN_INSTALL_CACHE_DIR: join(root, '.cache'),
      BUN_INSTALL_NO_TRACK: '1',
      DO_NOT_TRACK: '1',
      NO_COLOR: '1',
      PATH: '/usr/bin:/bin',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) throw new Error(`Bun installation command failed: ${args.join(' ')}`);
};
run(['install', '--frozen-lockfile', '--ignore-scripts', '--linker=hoisted', '--no-progress']);
// Match the repository's prepare contract without running Husky or arbitrary lifecycle scripts.
run(['--bun', 'node_modules/@effect/tsgo/dist/effect-tsgo.cjs', 'patch', '--no-typescript', '--oxlint']);

const packages = new Map();
const visit = directory => {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    if (Effect.pipe(entry.name, EffectString.startsWith('.'))) continue;
    const path = join(directory, entry.name);
    if (Effect.pipe(entry.name, EffectString.startsWith('@'))) {
      visit(path);
      continue;
    }
    if (!existsSync(join(path, 'package.json'))) continue;
    // Workspace sources belong to workspace BUILD targets, not the fetched npm repository.
    if (!Effect.pipe(realpathSync(path), EffectString.startsWith(join(root, 'node_modules') + '/'))) continue;
    const key = relative(root, path);
    packages.set(key, JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')));
    visit(join(path, 'node_modules'));
  }
};
visit(join(root, 'node_modules'));

const resolvePackage = (name, from) => {
  let directory = resolve(root, from);
  while (Effect.pipe(directory, EffectString.startsWith(root))) {
    const candidate = relative(root, join(directory, 'node_modules', name));
    if (packages.has(candidate)) return candidate;
    if (directory === root) break;
    directory = dirname(directory);
  }
};
const closure = start =>
  dependencyClosure(start, key => {
    const dependencies = [];
    const pkg = packages.get(key);
    for (const name of EffectRecord.keys({...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies})) {
      const found = resolvePackage(name, key);
      if (found) dependencies.push(found);
      else if (pkg.dependencies?.[name] && !pkg.optionalDependencies?.[name]) {
        throw new Error(`Missing installed dependency ${name} required by ${key}`);
      }
    }
    return dependencies;
  });
const lines = ['package(default_visibility = ["//visibility:public"])'];
for (const key of [...packages.keys()].sort()) {
  if (key.slice('node_modules/'.length).includes('/node_modules/')) continue;
  const name = key.slice('node_modules/'.length);
  const patterns = EffectArray.map(closure(key), path => `${path}/**`);
  lines.push(
    `filegroup(name = ${JSON.stringify(name)}, srcs = glob(${JSON.stringify(patterns)}, exclude = ["**/BUILD", "**/BUILD.bazel"]))`,
  );
}
writeFileSync('BUILD.bazel', `${EffectArray.join(lines, '\n')}\n`);
