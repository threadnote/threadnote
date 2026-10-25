/* oxlint-disable effecttsgo/node-builtin-import -- Integration test of Bazel's on-disk graph and native diff process. */
import {mkdirSync, mkdtempSync, renameSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {bazelDiffPath, bazelPath} from './cli-tools.mjs';
import {selectTargets} from '../ci/selection.mjs';
import {readPreparedInventory} from './prepare.mjs';

const root = resolve(import.meta.dir, '../..');
const {inventory} = await readPreparedInventory({root});
const evidence = resolve(root, '.context/dev-cycle/bazel-spike/selection-regressions');
mkdirSync(evidence, {recursive: true});
const workspace = mkdtempSync(join(evidence, 'fixture-'));
const bazel = await bazelPath(root);
const diff = await bazelDiffPath(root);
const run = async args => {
  const child = Bun.spawn(args, {cwd: workspace, stdout: 'pipe', stderr: 'pipe'});
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stderr}`);
  return stdout + stderr;
};
const write = (path, content) => Bun.write(join(workspace, path), content);
for (const directory of ['website', 'graph']) mkdirSync(join(workspace, directory));
await write('MODULE.bazel', 'module(name = "selection_fixture")\nbazel_dep(name = "platforms", version = "1.0.0")\n');
await write('BUILD.bazel', 'exports_files(["package_files.bzl", "rules.bzl"])\n');
await write('package_files.bzl', await Bun.file(join(root, 'tools/bazel/package_files.bzl')).text());
await write(
  'rules.bzl',
  `def _test(ctx):
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, "#!/bin/sh\\necho " + str(ctx.label) + "\\n", is_executable = True)
    return [DefaultInfo(executable = executable, runfiles = ctx.runfiles(files = ctx.files.srcs))]
fixture_test = rule(implementation = _test, attrs = {"srcs": attr.label_list(allow_files = True)}, test = True)
`,
);
const build = files =>
  `load("//:package_files.bzl", "export_package_files")\nload("//:rules.bzl", "fixture_test")\nexport_package_files(["**"])\nfixture_test(name = "test", srcs = ${JSON.stringify(files)})\n`;
await write('website/BUILD.bazel', build(['page.txt']));
await write('website/page.txt', 'initial\n');
await write('graph/BUILD.bazel', build(['parser.txt']));
await write('graph/parser.txt', 'graph\n');
const hash = async name => {
  const path = join(evidence, `${name}.json`);
  await run([
    diff,
    'generate-hashes',
    '-w',
    workspace,
    '-b',
    bazel,
    '--bazelCommandOptions=--noshow_progress --lockfile_mode=off',
    path,
  ]);
  return path;
};
const compare = async (before, after, name, expected, inventory = ['//website:test', '//graph:test']) => {
  const path = join(evidence, `${name}.txt`);
  await run([
    diff,
    'get-impacted-targets',
    '-w',
    workspace,
    '-b',
    bazel,
    '--startingHashes',
    before,
    '--finalHashes',
    after,
    '--excludeExternalTargets=true',
    '-o',
    path,
  ]);
  const impacted = (await Bun.file(path).text())
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean);
  const result = selectTargets({
    inventory,
    impacted,
    changedFiles: [],
    knownInputs: [],
  });
  if (JSON.stringify(result.targets) !== JSON.stringify(expected))
    throw new Error(`${name}: expected ${expected}; got ${JSON.stringify(result)}`);
  return result;
};
try {
  let previous = await hash('initial');
  await write('website/page.txt', 'updated\n');
  let current = await hash('edit');
  const edit = await compare(previous, current, 'edit', ['//website:test']);
  const coldLog = await run([
    bazel,
    'test',
    ...edit.targets,
    '--disk_cache=',
    '--remote_cache=',
    '--spawn_strategy=sandboxed',
  ]);
  await Bun.write(join(evidence, 'cold-website-only.log'), coldLog);
  if (coldLog.includes('//graph:test')) throw new Error('Website-only cold run included the graph test');
  previous = current;
  await write('website/unrelated.txt', 'exported but not a target input\n');
  current = await hash('unrelated-export');
  await compare(previous, current, 'unrelated-export', []);
  previous = current;
  await write('website/extra.txt', 'addition\n');
  await write('website/BUILD.bazel', build(['page.txt', 'extra.txt']));
  current = await hash('addition');
  await compare(previous, current, 'addition', ['//website:test']);
  previous = current;
  renameSync(join(workspace, 'website/extra.txt'), join(workspace, 'website/renamed.txt'));
  await write('website/BUILD.bazel', build(['page.txt', 'renamed.txt']));
  current = await hash('rename');
  await compare(previous, current, 'rename', ['//website:test']);
  previous = current;
  rmSync(join(workspace, 'website/renamed.txt'));
  await write('website/BUILD.bazel', build(['page.txt']));
  current = await hash('deletion');
  await compare(previous, current, 'deletion', ['//website:test']);
  previous = current;
  await write('website/shared.txt', 'shared\n');
  await write('website/BUILD.bazel', build(['page.txt']));
  await write('graph/BUILD.bazel', build(['parser.txt', '//website:shared.txt']));
  current = await hash('edge');
  await compare(previous, current, 'edge', ['//graph:test']);
  const websiteConfigTargets = inventory.targets.filter(target =>
    ['//apps/website:build', '//apps/website:typecheck'].includes(target.label),
  );
  await write('website/tsconfig.json', '{"compilerOptions":{"useDefineForClassFields":true}}\n');
  await write(
    'website/BUILD.bazel',
    build(['page.txt']) +
      websiteConfigTargets
        .map(target => {
          const inputs = target.inputs
            .filter(input => input === 'apps/website/tsconfig.json')
            .map(() => 'tsconfig.json');
          return `fixture_test(name = ${JSON.stringify(target.label.split(':')[1])}, srcs = ${JSON.stringify(inputs)})\n`;
        })
        .join(''),
  );
  previous = await hash('configuration-base');
  await write('website/tsconfig.json', '{"compilerOptions":{"useDefineForClassFields":false}}\n');
  current = await hash('configuration');
  const configuration = await compare(
    previous,
    current,
    'configuration',
    ['//website:build', '//website:typecheck'],
    ['//website:test', '//website:build', '//website:typecheck', '//graph:test'],
  );
  await Bun.write(
    join(evidence, 'receipt.json'),
    JSON.stringify(
      {
        version: 1,
        scenarios: ['edit', 'unrelated-export', 'addition', 'rename', 'deletion', 'edge', 'configuration'],
        coldWebsiteOnlyTargets: edit.targets,
        configurationOnlyTargets: configuration.targets,
        bazelDiffVersion: '49.1.0',
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(`Bazel-diff graph regressions passed; evidence: ${evidence}\n`);
} finally {
  await run([bazel, 'shutdown']);
}
