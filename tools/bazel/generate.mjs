/* oxlint-disable effecttsgo/node-builtin-import -- Build graph generation runs before the dependency graph it declares. */
import {existsSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {bazelSourceLabel, packageExportPatterns, packageOwner} from './declaration-paths.mjs';
import {allowedRepositoryPath, sourceRepositoryPathCandidates} from './repository-inputs.mjs';
import {collectSourceClosure, sourceImports} from './source-closure.mjs';
import {staticTargets, targetSpecs, testSuites, virtualModules} from './target-specs.mjs';

const root = resolve(import.meta.dir, '../..');
const check = process.argv.includes('--check');
const readCache = new Map();
const read = path => {
  if (!readCache.has(path)) readCache.set(path, readFileSync(join(root, path), 'utf8'));
  return readCache.get(path);
};
// Generation reads a fixed input tree; its generated BUILD outputs are excluded.
const statCache = new Map();
const inputStat = path => {
  if (!statCache.has(path)) {
    const absolute = join(root, path);
    statCache.set(path, existsSync(absolute) ? statSync(absolute) : undefined);
  }
  return statCache.get(path);
};
const exists = path => inputStat(path)?.isFile() ?? false;
const isDirectory = path => inputStat(path)?.isDirectory() ?? false;
const repositoryFiles = new Set(
  execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean),
);
const directoryFilesCache = new Map();
const filesBelow = directory => {
  if (directoryFilesCache.has(directory)) return directoryFilesCache.get(directory);
  const absolute = join(root, directory);
  const files = isDirectory(directory)
    ? readdirSync(absolute, {withFileTypes: true}).flatMap(entry => {
        if (['.git', '.DS_Store', '.bazel-inputs', 'BUILD', 'BUILD.bazel', 'node_modules'].includes(entry.name))
          return [];
        const path = `${directory}/${entry.name}`;
        return entry.isDirectory() ? filesBelow(path) : repositoryFiles.has(path) ? [path] : [];
      })
    : [];
  directoryFilesCache.set(directory, files);
  return files;
};
const bazelPackagesBelow = directory => {
  const absolute = join(root, directory);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return [];
  const packages = exists(`${directory}/BUILD.bazel`) || exists(`${directory}/BUILD`) ? [directory] : [];
  for (const entry of readdirSync(absolute, {withFileTypes: true})) {
    if (!entry.isDirectory() || ['.git', '.bazel-inputs', 'node_modules'].includes(entry.name)) continue;
    packages.push(...bazelPackagesBelow(`${directory}/${entry.name}`));
  }
  return packages;
};
const workspaces = new Map();
for (const directory of ['apps', 'packages']) {
  for (const entry of readdirSync(join(root, directory))) {
    const path = `${directory}/${entry}`;
    if (!exists(`${path}/package.json`)) continue;
    const manifest = JSON.parse(read(`${path}/package.json`));
    workspaces.set(manifest.name, {path, manifest});
  }
}
// These trees own hand-written BUILD files. Discover nested Bazel packages so
// generated target labels stop at their real package boundary without rewriting
// those declarations. Extend this list when another hand-written package tree is
// introduced.
const manualPackageTrees = ['assets', 'config', 'infra', 'tools/bazel', 'training'];
const manualPackageRoots = new Set(manualPackageTrees.flatMap(bazelPackagesBelow));
const packageRoots = [...manualPackageRoots, ...[...workspaces.values()].map(workspace => workspace.path)].sort(
  (a, b) => b.length - a.length,
);
const owner = file => packageOwner(file, packageRoots);
const label = file => bazelSourceLabel(file, packageRoots);
const exports = new Map([['', new Set(['bun.lock', 'package.json'])]]);
const targets = new Map();
const suites = new Map();
const inventory = [];
const stringList = (values, indent = '') =>
  '[\n' + values.map(value => `${indent}    ${JSON.stringify(value)},`).join('\n') + `\n${indent}]`;
const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/u;
const sourceImportCache = new Map();
const imports = (path, content) => {
  if (!sourceImportCache.has(path)) sourceImportCache.set(path, sourceImports(path, content));
  return sourceImportCache.get(path);
};
const repositoryPathCandidateCache = new Map();
const repositoryPathCandidates = path => {
  if (!repositoryPathCandidateCache.has(path))
    repositoryPathCandidateCache.set(path, sourceRepositoryPathCandidates(path, read(path)));
  return repositoryPathCandidateCache.get(path);
};
const referencedFile = path => {
  const candidates = [path];
  if (/\.[cm]?jsx?$/u.test(path))
    candidates.push(path.replace(/\.[cm]?jsx?$/u, '.ts'), path.replace(/\.jsx?$/u, '.tsx'));
  return candidates.find(candidate => repositoryFiles.has(candidate) && exists(candidate));
};
const collectTargetClosure = (target, config, directoryFiles) => {
  const entries = [...target.entries, ...(target.closureEntries ?? []), ...config, ...directoryFiles];
  const discoveryEntries = new Set(target.entries);
  const discoveredSources = new Set();
  const discoveredData = new Set();
  const scanned = new Set();
  let closure;
  while (true) {
    closure = collectSourceClosure([...entries, ...discoveredSources], {
      read,
      exists,
      workspaces,
      virtualModules,
      imports,
    });
    const closureFiles = new Set(closure.files);
    let expanded = false;
    for (const path of closure.files) {
      const testSupport = path.includes('/test/') || path.startsWith('packages/testing/');
      if (!sourceExtensions.test(path) || scanned.has(path) || (!discoveryEntries.has(path) && !testSupport)) continue;
      scanned.add(path);
      for (const candidate of repositoryPathCandidates(path)) {
        if (!allowedRepositoryPath(candidate, target.referencedInputRoots ?? [])) continue;
        const source = referencedFile(candidate);
        if (source) {
          if (sourceExtensions.test(source) && !closureFiles.has(source) && !discoveredSources.has(source)) {
            discoveredSources.add(source);
            expanded = true;
          } else if (!sourceExtensions.test(source)) discoveredData.add(source);
          continue;
        }
        if (isDirectory(candidate)) for (const file of filesBelow(candidate)) discoveredData.add(file);
      }
    }
    if (!expanded) return {closure, discoveredData: [...discoveredData]};
  }
};
for (const workspace of workspaces.values()) exports.set(workspace.path, new Set(['package.json']));
for (const target of targetSpecs) {
  const config = target.kind === 'test' ? ['package.json', 'tools/bazel/project-vitest.config.ts'] : [];
  const included = path => !target.exclude || !target.exclude(path);
  const missingData = (target.data ?? []).filter(path => !exists(path));
  if (missingData.length > 0)
    throw new Error(`${target.package || '//'}:${target.name} declares missing data: ${missingData.join(', ')}`);
  const directoryFiles = (target.sourceRoots ?? []).flatMap(filesBelow).filter(included);
  const {closure, discoveredData} = collectTargetClosure(target, config, directoryFiles);
  const files = [
    ...new Set(
      [
        ...closure.files,
        ...discoveredData,
        ...(target.data ?? []),
        ...(target.dataRoots ?? []).flatMap(filesBelow),
      ].filter(included),
    ),
  ].sort();
  for (const file of files) {
    const path = owner(file);
    if (manualPackageRoots.has(path)) continue;
    if (!exports.has(path)) exports.set(path, new Set());
    exports.get(path).add(path ? file.slice(path.length + 1) : file);
  }
  const npm = [
    ...new Set([...closure.npm, ...(target.npm ?? []), ...(target.kind === 'test' ? ['vitest'] : [])]),
  ].sort();
  const commonDefinition = [
    `    name = ${JSON.stringify(target.name)},`,
    `    srcs = ${stringList(files.map(label), '    ')},`,
    `    deps = ${stringList(
      npm.map(name => `@npm//:${name}`),
      '    ',
    )},`,
  ];
  const definition =
    target.kind === 'library'
      ? ['bun_library(', ...commonDefinition, ')'].join('\n')
      : (() => {
          const args = target.args ?? [
            '--bun',
            'node_modules/vitest/vitest.mjs',
            'run',
            '--config',
            'tools/bazel/project-vitest.config.ts',
            ...target.entries,
          ];
          return [
            `${target.kind === 'test' ? (target.workspace ? 'bun_workspace_test' : 'bun_test') : 'bun_action'}(`,
            ...commonDefinition,
            `    ${target.kind === 'test' ? 'runner_args' : 'args'} = ${stringList(args, '    ')},`,
            ...(target.env ? [`    env = ${JSON.stringify(target.env)},`] : []),
            ...(target.local ? ['    local = True,'] : []),
            ...(target.workspace
              ? ['    tags = ["local", "no-cache", "no-sandbox"],']
              : target.requiresNetwork
                ? ['    tags = ["requires-network"],']
                : []),
            ...(target.kind === 'test' && target.timeout ? [`    timeout = ${JSON.stringify(target.timeout)},`] : []),
            ')',
          ].join('\n');
        })();
  if (!targets.has(target.package)) targets.set(target.package, []);
  targets.get(target.package).push(definition);
  inventory.push({
    label: `//${target.package}:${target.name}`,
    kind: target.kind,
    inputs: files,
    npm,
    entries: [...target.entries],
    env: target.env ?? {},
    timeout: target.timeout ?? null,
    workspace: target.workspace ?? false,
    requiresNetwork: target.requiresNetwork ?? false,
  });
}
for (const suite of testSuites) {
  if (!suites.has(suite.package)) suites.set(suite.package, []);
  suites
    .get(suite.package)
    .push(
      [
        'test_suite(',
        `    name = ${JSON.stringify(suite.name)},`,
        `    tests = ${stringList(suite.tests, '    ')},`,
        ')',
      ].join('\n'),
    );
}
for (const target of staticTargets) {
  if (inventory.some(candidate => candidate.label === target.label))
    throw new Error(`Duplicate Bazel target inventory label: ${target.label}`);
  inventory.push({...target, inputs: [...new Set(target.inputs)].sort(), npm: []});
}
inventory.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
const write = (path, content) => {
  if (check) {
    if (!exists(path) || read(path) !== content)
      throw new Error(`Stale Bazel declarations: ${path}; run bun tools/bazel/generate.mjs`);
  } else writeFileSync(join(root, path), content);
};
for (const [path, files] of exports) {
  if (manualPackageRoots.has(path)) continue;
  const definitions = targets.get(path) ?? [];
  const suiteDefinitions = suites.get(path) ?? [];
  const content =
    [
      '# Generated by tools/bazel/generate.mjs. Run with --check to verify.',
      'load("//tools/bazel:package_files.bzl", "export_package_files")',
      ...(definitions.length
        ? ['load("//tools/bazel:bun.bzl", "bun_action", "bun_library", "bun_test", "bun_workspace_test")']
        : []),
      '',
      'package(default_visibility = ["//:__subpackages__"])',
      `export_package_files(${stringList(packageExportPatterns([...files]))})`,
      '',
      ...definitions.flatMap(value => [value, '']),
      ...suiteDefinitions.flatMap(value => [value, '']),
    ]
      .join('\n')
      .trimEnd() + '\n';
  write(path ? `${path}/BUILD.bazel` : 'BUILD.bazel', content);
}
write('tools/bazel/targets.json', JSON.stringify({version: 1, testSuites, targets: inventory}, null, 2) + '\n');
