/* oxlint-disable effecttsgo/node-builtin-import -- Integration test of Bazel's on-disk graph and native diff process. */
import {mkdirSync, mkdtempSync, renameSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {bazelDiffPath, bazelPath} from './cli-tools.mjs';
import {selectTargets} from '../ci/selection.mjs';
import {readPreparedInventory} from './prepare.mjs';
import {buildGenerationModel} from './generation-model.mjs';

const root = resolve(import.meta.dir, '../..');
const {inventory} = await readPreparedInventory({root});
const evidence = resolve(root, '.context/dev-cycle/bazel-spike/selection-regressions');
mkdirSync(evidence, {recursive: true});
const workspace = mkdtempSync(join(evidence, 'fixture-'));
const bazel = await bazelPath(root);
const diff = await bazelDiffPath(root);
const runAt = async (cwd, args) => {
  const child = Bun.spawn(args, {cwd, stdout: 'pipe', stderr: 'pipe'});
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stderr}`);
  return stdout + stderr;
};
const run = args => runAt(workspace, args);
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

// Public library boundaries use the same Bun srcs/deps graph without running
// the product suite. Real executable runfiles are checked separately at rollout.
const verifyFactoredHistories = async () => {
  const layouts = ['flat', 'factored'];
  const directories = new Map();
  const previous = new Map();
  const receipts = [];
  let sharedTarget = false;
  const site = '//apps/website:test';
  const graph = '//packages/graph:test';
  const roots = '//apps/website:roots_test';
  const provider = '//packages/provider-one:test';
  const specs = () => [
    {
      package: 'apps/website',
      name: 'test',
      kind: 'library',
      entries: ['apps/website/page.ts'],
      closureEntries: ['apps/website/runtime.ts'],
      data: ['apps/website/page.txt'],
      dataRoots: ['apps/website/public'],
    },
    {
      package: 'apps/website',
      name: 'roots_test',
      kind: 'library',
      entries: ['apps/website/roots/entry.ts'],
      sourceRoots: ['apps/website/roots'],
      exclude: path => path.endsWith('/excluded.ts'),
    },
    ...['graph', 'provider-one', 'provider-two'].map(name => ({
      package: 'packages/' + name,
      name: 'test',
      kind: 'library',
      entries: ['packages/' + name + '/src/index.ts'],
    })),
    ...(sharedTarget
      ? [{package: 'apps/website', name: 'shared_test', kind: 'library', entries: ['apps/website/page.ts']}]
      : []),
  ];
  const authored = {
    'package.json': '{"name":"factoring-fixture"}',
    'bun.lock': '',
    '.gitignore': '/BUILD.bazel\n/apps/*/BUILD.bazel\n/packages/*/BUILD.bazel\n/tools/bazel/targets.json\n/bazel-*\n',
    'MODULE.bazel': 'module(name = "factoring_fixture")\nbazel_dep(name = "platforms", version = "1.0.0")\n',
    'tools/bazel/BUILD.bazel':
      'exports_files(["bun.bzl", "package_files.bzl", "targets.json"])\ntoolchain_type(name = "toolchain_type")\n',
    'apps/website/package.json': '{"name":"@fixture/website"}',
    'apps/website/page.ts': 'import "./a.js"; import "@fixture/shared"; export const page = 1;',
    'apps/website/a.ts': 'import "./b.js"; export const a = 1;',
    'apps/website/b.ts': 'export const b = 1;',
    'apps/website/runtime.ts': 'export const runtime = 1;',
    'apps/website/page.txt': 'page resource',
    'apps/website/public/asset.svg': '<svg/>',
    'apps/website/roots/entry.ts': 'export const entry = 1;',
    'apps/website/roots/extra.ts': 'export const extra = 1;',
    'apps/website/roots/excluded.ts': 'export const excluded = 1;',
    'packages/shared/package.json': '{"name":"@fixture/shared","exports":{".":"./src/index.ts"}}',
    'packages/shared/src/index.ts': 'export const shared = 1;',
  };
  for (const name of ['graph', 'provider-one', 'provider-two']) {
    authored['packages/' + name + '/package.json'] = JSON.stringify({name: '@fixture/' + name});
    authored['packages/' + name + '/src/index.ts'] = 'export const value = 1;';
  }
  const equal = (actual, expected, name) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(name + ': expected ' + JSON.stringify(expected) + '; got ' + JSON.stringify(actual));
  };
  const mutate = async (path, content) => {
    for (const directory of directories.values()) {
      const absolute = join(directory, path);
      if (content === null) {
        if (await Bun.file(absolute).exists()) await Bun.file(absolute).delete();
      } else await Bun.write(absolute, content);
    }
  };
  const prepareState = async (layout, name) => {
    const directory = directories.get(layout);
    const model = await buildGenerationModel({
      root: directory,
      specs: specs(),
      suites: [],
      statics: [],
      modules: [],
      representation: layout,
    });
    for (const [path, content] of model.output) await Bun.write(join(directory, path), content);
    const hashes = join(evidence, 'paired-' + layout + '-' + name + '.json');
    await runAt(directory, [
      diff,
      'generate-hashes',
      '-w',
      directory,
      '-b',
      bazel,
      '--bazelCommandOptions=--noshow_progress --lockfile_mode=off',
      hashes,
    ]);
    return {model, hashes};
  };
  const step = async (name, changedFiles, expected) => {
    const results = [];
    for (const layout of layouts) {
      const directory = directories.get(layout);
      const before = previous.get(layout);
      const after = await prepareState(layout, name);
      const impactFile = join(evidence, 'paired-' + layout + '-' + name + '.txt');
      await runAt(directory, [
        diff,
        'get-impacted-targets',
        '-w',
        directory,
        '-b',
        bazel,
        '--startingHashes',
        before.hashes,
        '--finalHashes',
        after.hashes,
        '--excludeExternalTargets=true',
        '-o',
        impactFile,
      ]);
      const result = selectTargets({
        inventory: after.model.inventory.map(target => target.label),
        impacted: (await Bun.file(impactFile).text()).split('\n').filter(Boolean),
        changedFiles,
        knownInputs: [...before.model.inventory, ...after.model.inventory].flatMap(target => target.inputs),
      });
      equal(result.targets, [...expected].sort(), layout + ' ' + name);
      results.push(result.targets);
      previous.set(layout, after);
    }
    equal(results[0], results[1], name + ' representation parity');
    receipts.push({name, changedFiles, targets: results[0]});
  };
  try {
    for (const layout of layouts) {
      const directory = mkdtempSync(join(evidence, layout + '-history-'));
      directories.set(layout, directory);
      for (const [path, content] of Object.entries(authored)) await Bun.write(join(directory, path), content);
      for (const path of ['bun.bzl', 'package_files.bzl'])
        await Bun.write(join(directory, 'tools/bazel', path), Bun.file(join(root, 'tools/bazel', path)));
      await runAt(directory, ['git', 'init', '-q']);
      previous.set(layout, await prepareState(layout, 'initial'));
    }
    await mutate('apps/website/page.ts', 'import "./a.js"; import "@fixture/shared"; export const page = 2;');
    await step('edit', ['apps/website/page.ts'], [site]);
    await mutate('apps/website/page.ts', 'import "./a.js"; import "./extra.js"; import "@fixture/shared";');
    await mutate('apps/website/extra.ts', 'export const extra = 1;');
    await step('addition', ['apps/website/page.ts', 'apps/website/extra.ts'], [site]);
    await mutate('apps/website/extra.ts', null);
    await mutate('apps/website/renamed.ts', 'export const extra = 1;');
    await mutate('apps/website/page.ts', 'import "./a.js"; import "./renamed.js"; import "@fixture/shared";');
    await step('rename', ['apps/website/page.ts', 'apps/website/extra.ts', 'apps/website/renamed.ts'], [site]);
    await mutate('apps/website/renamed.ts', null);
    await mutate('apps/website/page.ts', 'import "./a.js"; import "@fixture/shared";');
    await step('deletion', ['apps/website/page.ts', 'apps/website/renamed.ts'], [site]);
    await mutate('apps/website/page.ts', 'import "./a.js"; import "./b.js"; import "@fixture/shared";');
    await step('redundant-edge', ['apps/website/page.ts'], [site]);
    await mutate('apps/website/b.ts', 'import "./a.js"; export const b = 1;');
    await step('scc-merge', ['apps/website/b.ts'], [site]);
    await mutate('apps/website/b.ts', 'export const b = 1;');
    await step('scc-split', ['apps/website/b.ts'], [site]);
    await mutate('packages/graph/src/index.ts', 'import "@fixture/shared"; export const value = 1;');
    await step('edge-add', ['packages/graph/src/index.ts'], [graph]);
    await mutate('packages/shared/src/index.ts', 'export const shared = 2;');
    await step('shared-edit', ['packages/shared/src/index.ts'], [site, graph]);
    await mutate('packages/graph/src/index.ts', 'export const value = 1;');
    await step('edge-remove', ['packages/graph/src/index.ts'], [graph]);
    await mutate(
      'packages/shared/package.json',
      '{"name":"@fixture/shared","description":"updated","exports":{".":"./src/index.ts"}}',
    );
    await step('manifest', ['packages/shared/package.json'], [site]);
    await mutate('apps/website/page.txt', 'updated page resource');
    await step('resource', ['apps/website/page.txt'], [site]);
    await mutate('apps/website/public/asset.svg', '<svg>updated</svg>');
    await step('data-root', ['apps/website/public/asset.svg'], [site]);
    await mutate('apps/website/runtime.ts', 'export const runtime = 2;');
    await step('runtime-entrypoint', ['apps/website/runtime.ts'], [site]);
    await mutate('apps/website/roots/extra.ts', 'export const extra = 2;');
    await step('source-root', ['apps/website/roots/extra.ts'], [roots]);
    await mutate('apps/website/roots/excluded.ts', 'export const excluded = 2;');
    // Authored but intentionally excluded inputs follow the existing unknown-input
    // fallback, equally in both modes.
    await step(
      'excluded-input',
      ['apps/website/roots/excluded.ts'],
      [...previous.get('flat').model.inventory.map(t => t.label)],
    );
    await mutate('apps/website/unused/extra.ts', 'export const unrelated = 1;');
    // Test graph precision independently of unknown-path ownership fallback.
    await step('unrelated-export', [], []);
    await mutate('packages/provider-one/src/index.ts', 'export const value = 2;');
    await step('provider-only', ['packages/provider-one/src/index.ts'], [provider]);
    sharedTarget = true;
    await step('new-target-shares-source', [], ['//apps/website:shared_test']);
    await mutate('MODULE.bazel.lock', '{}');
    await step(
      'module-lock',
      ['MODULE.bazel.lock'],
      previous.get('flat').model.inventory.map(t => t.label),
    );
    await mutate('docs/unmodeled.txt', 'unknown');
    await step(
      'unknown-input',
      ['docs/unmodeled.txt'],
      previous.get('flat').model.inventory.map(t => t.label),
    );
    await Bun.write(
      join(evidence, 'paired-receipt.json'),
      JSON.stringify({version: 1, scenarios: receipts}, null, 2) + '\n',
    );
    process.stdout.write('Flat/factored Bazel-diff histories passed (' + receipts.length + ' scenarios).\n');
  } finally {
    for (const directory of directories.values()) await runAt(directory, [bazel, 'shutdown']);
  }
};
await verifyFactoredHistories();
