/* oxlint-disable effecttsgo/node-builtin-import -- Target discovery runs before the declared Bazel graph exists. */
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {ciLongRunningTestGroups, ciRequiredLongRunningTestGroupNames} from '../ci/vitest-plan.ts';
import {groupApplicationTests} from './application-test-groups.mjs';
import {allowedRepositoryPath, sourceRepositoryPathCandidates} from './repository-inputs.mjs';
import {collectSourceClosure, sourceImports} from './source-closure.mjs';

const root = resolve(import.meta.dir, '../..');
const filesBelow = directory => {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, {withFileTypes: true}).flatMap(entry => {
    if (['.DS_Store', '.git', '.context', 'BUILD', 'BUILD.bazel', 'node_modules'].includes(entry.name)) return [];
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
};
const testFilesBelow = directory =>
  filesBelow(directory)
    .filter(path => /\.test\.tsx?$/u.test(path))
    .sort();
const packageDirectories = readdirSync(join(root, 'packages'))
  .sort()
  .map(name => `packages/${name}`);
const applicationWorkspaceDirectories = [
  ...readdirSync(join(root, 'apps'))
    .sort()
    .map(name => `apps/${name}`),
  ...packageDirectories,
].filter(path => existsSync(join(root, path, 'package.json')));
const applicationWorkspaces = new Map(
  applicationWorkspaceDirectories.map(path => {
    const manifest = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'));
    return [manifest.name, {path, manifest}];
  }),
);
const sourceImportCache = new Map();
const readSource = path => readFileSync(join(root, path), 'utf8');
const applicationSourceImports = path => {
  if (!sourceImportCache.has(path)) sourceImportCache.set(path, sourceImports(path, readSource(path)));
  return sourceImportCache.get(path);
};
const applicationSourceExists = path => {
  const absolute = join(root, path);
  return existsSync(absolute) && statSync(absolute).isFile();
};
const longRunningTests = new Set(Object.values(ciLongRunningTestGroups).flat());
const applicationTests = [...testFilesBelow('apps/threadnote/test')].sort();
const applicationIntegrationTests = applicationTests.filter(path =>
  path.startsWith('apps/threadnote/test/integrations/'),
);
const postgresTests = new Set(
  applicationTests.filter(path => readFileSync(join(root, path), 'utf8').includes('THREADNOTE_TEST_POSTGRES_URL')),
);
const websiteReleaseTests = new Set([
  'apps/website/test/website-release-boundary.test.ts',
  'apps/website/test/website-release-content.test.ts',
]);
const recallQualityEntries = [
  'scripts/evaluate-recall.ts',
  'scripts/evaluate-code-graph.ts',
  'scripts/evaluate-code-graph-workset.ts',
  'scripts/evaluate-context-brief-citations-runtime.ts',
  'scripts/evaluate-code-memory-link-bench.ts',
  'scripts/evaluate-recall-v2.ts',
  'scripts/run-matched-evaluation.ts',
  'scripts/matched-evaluation-codex-adapter.ts',
  'scripts/matched-evaluation-context-proxy.ts',
  'scripts/matched-continuation-runtime-integrity.ts',
  'scripts/prepare-matched-continuation-study.ts',
  'scripts/finalize-matched-continuation-study.ts',
  'scripts/prepare-matched-token-efficiency-study.ts',
];
const windowsSmokeEntries = [
  'apps/threadnote/test/unit/windows-support.test.ts',
  'apps/threadnote/test/unit/command-shim.test.ts',
  'apps/threadnote/test/unit/effect-command.test.ts',
  'apps/threadnote/test/unit/effect-system.test.ts',
  'apps/threadnote/test/unit/standalone-process-lease.test.ts',
  'apps/threadnote/test/unit/process-diagnostics.test.ts',
  'apps/threadnote/test/unit/local-ai.test.ts',
  'apps/threadnote/test/unit/update.test.ts',
  'apps/threadnote/test/unit/mcp.test.ts',
  'apps/threadnote/test/unit/code-graph.maintenance-bounded.test.ts',
];
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const allNpm = Object.keys({...rootManifest.dependencies, ...rootManifest.devDependencies})
  .filter(name => !name.startsWith('@threadnote/'))
  .sort();

const packageDataRoots = {
  'packages/evidence': ['apps/threadnote/test/evaluation'],
  'packages/graph': [
    'assets/code-graph',
    'apps/threadnote/test/evaluation/baselines/code-graph-v1',
    'apps/threadnote/test/evaluation/fixtures/code-graph-v1/repository',
    'packages/graph/src',
  ],
  'packages/recall': ['training/recall-reranker'],
  'packages/manager': ['packages/manager/static'],
  'packages/remote-memory': [
    'deploy/remote-memory',
    'deploy/threadnote-org',
    'deploy/threadnote-org-registry',
    'packages/remote-memory/src/migrations',
  ],
};
const packageData = {
  'packages/evidence': ['.github/workflows/benchmarks.yml'],
  'packages/graph': [
    '.github/actionlint.yml',
    '.github/workflows/code-graph-ready-query-evidence.yml',
    'THIRD_PARTY.md',
    'bun.lock',
    'docs/code-graph-readiness.md',
  ],
  'packages/recall': ['apps/threadnote/test/evaluation/fixtures/recall-v1/fixture.json'],
  'packages/remote-memory': ['scripts/build.ts', 'scripts/check-self-contained.ts'],
};
const packageTestNpm = {
  'packages/graph': [
    '@repomix/tree-sitter-wasms',
    '@tree-sitter-grammars/tree-sitter-hcl',
    '@tree-sitter-grammars/tree-sitter-lua',
    '@tree-sitter-grammars/tree-sitter-svelte',
    '@tree-sitter-grammars/tree-sitter-zig',
    '@vscode/tree-sitter-wasm',
    'tree-sitter-elixir',
    'tree-sitter-julia',
    'tree-sitter-objc',
    'tree-sitter-scala',
    'tree-sitter-systemverilog',
    'web-tree-sitter',
  ],
};
const applicationReferencedInputRoots = [
  '.cursor-plugin',
  '.github',
  '.husky',
  'apps',
  'assets',
  'config',
  'cursor-plugin',
  'deploy',
  'docs',
  'packages',
  'scripts',
  'tools',
  'training',
  '.dockerignore',
  '.gitignore',
  '.oxlintrc.json',
  '.oxlintrc.strict.json',
  '.prettierignore',
  '.prettierrc.json',
  '.threadnoteignore',
  'AGENTS.md',
  'CONTRIBUTION.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY.md',
];
const applicationTestData = ['bun.lock', 'package.json', 'tsconfig.json', 'tsconfig.test.json', 'vitest.config.ts'];
const applicationSourceExtensions = /\.(?:[cm]?[jt]sx?)$/u;
const applicationTestSourceClosure = path => {
  const entries = [path, 'package.json', 'tools/bazel/project-vitest.config.ts'];
  const discoveryEntries = new Set([path]);
  const discoveredSources = new Set();
  const scanned = new Set();
  let closure;
  while (true) {
    closure = collectSourceClosure([...entries, ...discoveredSources], {
      read: readSource,
      exists: applicationSourceExists,
      workspaces: applicationWorkspaces,
      imports: applicationSourceImports,
    });
    const closureFiles = new Set(closure.files);
    let expanded = false;
    for (const source of closure.files) {
      const testSupport = source.includes('/test/') || source.startsWith('packages/testing/');
      if (
        !applicationSourceExtensions.test(source) ||
        scanned.has(source) ||
        (!discoveryEntries.has(source) && !testSupport)
      )
        continue;
      scanned.add(source);
      for (const candidate of sourceRepositoryPathCandidates(source, readSource(source))) {
        if (!allowedRepositoryPath(candidate, applicationReferencedInputRoots)) continue;
        const candidates = [candidate];
        if (/\.[cm]?jsx?$/u.test(candidate)) candidates.push(candidate.replace(/\.[cm]?jsx?$/u, '.ts'));
        if (/\.jsx?$/u.test(candidate)) candidates.push(candidate.replace(/\.jsx?$/u, '.tsx'));
        const referencedSource = candidates.find(applicationSourceExists);
        if (referencedSource) {
          if (
            applicationSourceExtensions.test(referencedSource) &&
            !closureFiles.has(referencedSource) &&
            !discoveredSources.has(referencedSource)
          ) {
            discoveredSources.add(referencedSource);
            expanded = true;
          }
          continue;
        }
        if (existsSync(join(root, candidate)) && statSync(join(root, candidate)).isDirectory()) {
          for (const referencedFile of filesBelow(candidate)) {
            if (
              applicationSourceExtensions.test(referencedFile) &&
              !closureFiles.has(referencedFile) &&
              !discoveredSources.has(referencedFile)
            ) {
              discoveredSources.add(referencedFile);
              expanded = true;
            }
          }
        }
      }
    }
    if (!expanded) return closure;
  }
};
const packageTestClosureEntries = {
  'packages/graph': [
    'apps/threadnote/test/fixtures/code-graph-lazy-extractor.ts',
    'scripts/code-graph-benchmark-sampler.ts',
  ],
};
const packageRuntimeTestEntries = {
  'packages/context': ['apps/threadnote/src/standalone.ts'],
  'packages/graph': ['apps/threadnote/src/standalone.ts'],
  // The lifecycle fixture copies the source application and its real manifest.
  'packages/manager': ['apps/threadnote/src/standalone.ts', 'apps/threadnote/package.json'],
  'packages/memory': ['apps/threadnote/src/standalone.ts'],
  'packages/platform': ['apps/threadnote/src/standalone.ts', 'scripts/remote-memory-canary.ts'],
};
const packageWorkspaceTestEntries = {
  'packages/graph': ['packages/graph/test/unit/code-graph.stage3-gate.test.ts'],
};

export const virtualModules = [
  'virtual:threadnote-performance-evidence',
  'virtual:threadnote-release-notes',
  'virtual:threadnote-latest-release',
  'virtual:threadnote-articles',
];

const toolingTests = [
  ...testFilesBelow('tools/bazel/test'),
  ...testFilesBelow('tools/ci/test'),
  ...testFilesBelow('tools/workspace/test'),
];

const platformBenchmarkPreflightTests = [
  'apps/threadnote/test/integration/code-graph.benchmark-failure.test.ts',
  'apps/threadnote/test/integration/code-graph.benchmark-preflight.test.ts',
  'apps/threadnote/test/unit/code-graph.benchmark-harness.test.ts',
  'apps/threadnote/test/unit/evaluation.recall-benchmark-runners.test.ts',
  'packages/graph/test/unit/code-graph.benchmark-sampler.test.ts',
  'tools/ci/test/benchmark-workflow.test.ts',
  'tools/ci/test/platform-benchmark-scope.test.ts',
];

const packageTests = packageDirectories.flatMap(directory => {
  const entries = testFilesBelow(`${directory}/test`);
  if (entries.length === 0) return [];
  const runtimeEntries = packageRuntimeTestEntries[directory]
    ? entries.filter(path => readFileSync(join(root, path), 'utf8').includes('standalone.ts'))
    : [];
  const workspaceEntries = packageWorkspaceTestEntries[directory] ?? [];
  const standardEntries = entries.filter(path => !runtimeEntries.includes(path) && !workspaceEntries.includes(path));
  const shared = {
    package: directory,
    kind: 'test',
    data: [...new Set([`${directory}/package.json`, ...(packageData[directory] ?? [])])],
    dataRoots: packageDataRoots[directory] ?? [],
    npm: packageTestNpm[directory] ?? [],
  };
  return [
    ...(standardEntries.length
      ? [
          {
            ...shared,
            name: 'test',
            entries: standardEntries,
            closureEntries: packageTestClosureEntries[directory] ?? [],
          },
        ]
      : []),
    ...(runtimeEntries.length
      ? [
          {
            ...shared,
            name: 'test_runtime',
            entries: runtimeEntries,
            closureEntries: packageRuntimeTestEntries[directory],
          },
        ]
      : []),
    ...(workspaceEntries.length
      ? [
          {
            ...shared,
            name: 'test_workspace',
            entries: workspaceEntries,
            workspace: true,
          },
        ]
      : []),
  ];
});

const longRunningTargets = ciRequiredLongRunningTestGroupNames.map(group => ({
  entries: [...ciLongRunningTestGroups[group]],
  package: 'apps/threadnote',
  name: `test_long_${group.replaceAll('-', '_')}`,
  kind: 'test',
  data: applicationTestData,
  referencedInputRoots: applicationReferencedInputRoots,
  env: {THREADNOTE_VITEST_LONG_GROUP: group},
  npm: packageTestNpm['packages/graph'],
  timeout: 'long',
  workspace: true,
}));
const applicationStandardTests = applicationTests.filter(
  path => !longRunningTests.has(path) && !postgresTests.has(path) && !applicationIntegrationTests.includes(path),
);
const integrationPackages = [
  'integration-core',
  'integration-runtime',
  'integration-obsidian',
  'integration-superhuman',
  'integration-pocket',
  'integration-github',
  'integration-linear',
];
const providerPackages = integrationPackages.filter(
  name => !['integration-core', 'integration-runtime'].includes(name),
);
const applicationTestAffinities = Object.fromEntries(
  applicationStandardTests.map(path => {
    const closure = applicationTestSourceClosure(path);
    const dependencies = new Set(
      closure.files
        .map(file => file.match(/^packages\/(integration-[^/]+)\//u)?.[1])
        .filter(name => integrationPackages.includes(name)),
    );
    const providers = providerPackages.filter(name => dependencies.has(name));
    const dependencyNames =
      providers.length === providerPackages.length
        ? ['all']
        : providers.length > 0
          ? providers.map(name => name.slice('integration-'.length))
          : integrationPackages.filter(name => dependencies.has(name)).map(name => name.slice('integration-'.length));
    return [path, dependencyNames.length === 0 ? '' : `integration_${dependencyNames.join('_')}`];
  }),
);
const applicationTestGroups = groupApplicationTests(applicationStandardTests, {
  affinities: applicationTestAffinities,
});
const applicationIntegrationTargets = applicationIntegrationTests.map(path => ({
  package: 'apps/threadnote',
  name: `test_integration_${path
    .split('/')
    .at(-1)
    .replace(/\.test\.tsx?$/u, '')
    .replaceAll(/[^a-zA-Z0-9_]+/gu, '_')}`,
  kind: 'test',
  entries: [path],
  data: applicationTestData,
  referencedInputRoots: applicationReferencedInputRoots,
  npm: packageTestNpm['packages/graph'],
  timeout: 'long',
  workspace: true,
}));

const threadnoteBuild = {
  entries: [
    'tools/bazel/threadnote-build.ts',
    'scripts/build.ts',
    'scripts/check-embedded-core-model.ts',
    'scripts/check-self-contained.ts',
    'scripts/clean.ts',
    'scripts/generate-code-graph-language-catalog.ts',
  ],
  sourceRoots: ['apps/threadnote/src', ...packageDirectories.map(path => `${path}/src`)],
  dataRoots: [
    'assets',
    'config',
    'cursor-plugin',
    'packages/manager/static',
    ...providerPackages.map(name => `packages/${name}/static`),
    'packages/remote-memory/src/migrations',
  ],
  data: ['.threadnoteignore', 'LICENSE', 'THIRD_PARTY.md', 'package.json', 'scripts/native/graph-keychain.m'],
  npm: allNpm,
};

export const targetSpecs = [
  {
    package: '',
    name: 'recall_quality_inputs',
    kind: 'library',
    entries: recallQualityEntries,
    dataRoots: ['apps/threadnote/test/evaluation'],
    data: ['package.json'],
  },
  {
    package: '',
    name: 'windows_smoke_inputs',
    kind: 'library',
    entries: windowsSmokeEntries,
    data: ['package.json', 'vitest.config.ts'],
  },
  {
    package: '',
    name: 'tooling_test',
    kind: 'test',
    entries: toolingTests,
    data: [
      'tools/bazel/runner.mjs',
      'tools/bazel/targets.json',
      'tools/ci/bazel-run-selected.mjs',
      'tools/ci/bazel-select.mjs',
    ],
    dataRoots: ['.github/workflows'],
  },
  {
    package: '',
    name: 'platform_benchmark_preflight',
    kind: 'test',
    workspace: true,
    timeout: 'long',
    entries: platformBenchmarkPreflightTests,
    closureEntries: ['apps/threadnote/src/standalone.ts'],
    data: ['bun.lock', 'package.json'],
    dataRoots: ['.github/workflows', 'apps/threadnote/test/evaluation/baselines/code-graph-v1'],
    npm: packageTestNpm['packages/graph'],
  },
  {
    package: '',
    name: 'workspace_check',
    kind: 'test',
    workspace: true,
    entries: ['tools/workspace/check.ts'],
    dataRoots: ['apps', 'packages', 'scripts', 'tools', 'infra'],
    args: ['tools/workspace/check.ts'],
  },
  {
    package: '',
    name: 'typecheck',
    kind: 'test',
    entries: [],
    sourceRoots: ['apps/threadnote/src', ...packageDirectories.map(path => `${path}/src`)],
    data: ['tsconfig.json', 'package.json'],
    npm: ['typescript', '@types/bun', '@types/react', '@types/react-dom', '@types/three'],
    args: ['--bun', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'],
  },
  {
    package: '',
    name: 'test_typecheck',
    kind: 'test',
    entries: [],
    sourceRoots: [
      'apps/threadnote/src',
      'apps/threadnote/test',
      'apps/website/test',
      ...packageDirectories.flatMap(path => [`${path}/src`, `${path}/test`]),
      'infra/telemetry-gateway/test',
      'tools/bazel/test',
      'tools/ci',
      'tools/workspace',
    ],
    data: ['config/lint/threadnote-plugin.d.ts', 'tsconfig.json', 'tsconfig.test.json', 'package.json'],
    npm: ['typescript', '@types/bun', '@types/react', '@types/react-dom', '@types/three'],
    exclude: path => path.startsWith('apps/threadnote/test/evaluation/fixtures/') && path.includes('/repository/'),
    args: ['--bun', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.test.json'],
  },
  {
    package: '',
    name: 'lint',
    kind: 'test',
    workspace: true,
    entries: ['scripts/lint.ts'],
    dataRoots: ['scripts', 'packages', 'apps', 'tools', 'infra'],
    data: ['.oxlintrc.json', '.oxlintrc.strict.json'],
    npm: allNpm,
    args: ['scripts/lint.ts'],
  },
  {
    package: '',
    name: 'lint_file_length',
    kind: 'test',
    workspace: true,
    entries: ['scripts/lint-file-length.ts'],
    dataRoots: ['packages', 'apps/website/src', 'apps/threadnote/src'],
    data: ['.oxlintrc.max-lines.json'],
    npm: ['@effect/platform-bun', 'effect', 'oxlint'],
    args: ['scripts/lint-file-length.ts'],
  },
  {
    package: '',
    name: 'format',
    kind: 'test',
    entries: [],
    dataRoots: [
      '.github',
      'apps',
      'assets',
      'config',
      'deploy',
      'docs',
      'infra',
      'packages',
      'scripts',
      'tools',
      'training',
    ],
    data: [
      '.prettierignore',
      '.prettierrc.json',
      '.oxlintrc.json',
      '.oxlintrc.strict.json',
      'AGENTS.md',
      'CONTRIBUTION.md',
      'README.md',
      'package.json',
      'tsconfig.json',
      'tsconfig.test.json',
      'vitest.config.ts',
    ],
    npm: ['prettier'],
    args: ['--bun', 'node_modules/prettier/bin/prettier.cjs', '--check', '.', '--ignore-unknown'],
  },
  {
    package: '',
    name: 'threadnote_build',
    kind: 'action',
    local: true,
    ...threadnoteBuild,
    args: ['tools/bazel/threadnote-build.ts', '{output}'],
  },
  {
    package: '',
    name: 'release_check',
    kind: 'test',
    workspace: true,
    ...threadnoteBuild,
    args: ['tools/bazel/threadnote-build.ts', '--verify'],
    timeout: 'long',
  },
  {
    package: 'apps/website',
    name: 'test',
    kind: 'test',
    entries: testFilesBelow('apps/website/test').filter(path => !websiteReleaseTests.has(path)),
    sourceRoots: ['apps/website/src'],
    dataRoots: [
      'apps/website/public',
      'apps/website/articles',
      'apps/website/performance',
      'apps/website/docs',
      'apps/website/agents',
      'apps/website/whats-new',
      'apps/website/pro-tips',
      'apps/website/manager-demo',
      'apps/website/faq',
      'assets/brand',
    ],
    data: ['apps/website/vite.config.ts', 'apps/website/index.html', 'README.md', 'docs/troubleshooting.md'],
    npm: ['happy-dom', '@expo-google-fonts/spline-sans'],
  },
  {
    package: 'apps/website',
    name: 'test_release',
    kind: 'test',
    workspace: true,
    entries: [...websiteReleaseTests],
    sourceRoots: ['apps/website/src'],
    dataRoots: [
      '.github/release-notes',
      'apps/website/public',
      'apps/website/articles',
      'apps/website/performance',
      'apps/website/docs',
      'apps/website/agents',
      'apps/website/whats-new',
      'apps/website/pro-tips',
      'apps/website/manager-demo',
      'apps/website/faq',
      'assets/brand',
      'config/agent-profiles/cursor-cloud-personal',
      'config/agent-profiles/codex-cloud-personal',
    ],
    data: [
      '.github/workflows/ci.yml',
      '.github/workflows/pages.yml',
      'apps/threadnote/src/agent_integration/index.ts',
      'apps/threadnote/src/manager/server.ts',
      'apps/website/vite.config.ts',
      'apps/website/index.html',
      'config/agent-instructions.md',
      'packages/manager/src/navigation.tsx',
      'packages/manager/src/server.ts',
      'scripts/build.ts',
      'scripts/check-self-contained.ts',
      'tools/bazel/target-specs.mjs',
      'README.md',
      'THIRD_PARTY.md',
      'package.json',
    ],
    npm: ['@expo-google-fonts/spline-sans'],
    timeout: 'long',
  },
  {
    package: 'apps/website',
    name: 'typecheck',
    kind: 'test',
    entries: ['apps/website/vite.config.ts'],
    sourceRoots: ['apps/website/src'],
    data: ['apps/website/tsconfig.json', 'apps/website/package.json'],
    npm: ['typescript', '@types/bun', '@types/react', '@types/react-dom', '@types/three'],
    args: ['--bun', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/website/tsconfig.json'],
  },
  {
    package: 'apps/website',
    name: 'build',
    kind: 'action',
    entries: ['tools/bazel/website-build.ts', 'apps/website/vite.config.ts'],
    sourceRoots: ['apps/website/src'],
    dataRoots: [
      'apps/website/public',
      'apps/website/articles',
      'apps/website/performance',
      'apps/website/docs',
      'apps/website/agents',
      'apps/website/whats-new',
      'apps/website/pro-tips',
      'apps/website/manager-demo',
      'apps/website/faq',
    ],
    data: [
      'apps/website/index.html',
      'apps/website/package.json',
      'apps/website/tsconfig.json',
      'apps/website/.bazel-inputs/metadata.json',
    ],
    npm: ['@expo-google-fonts/spline-sans'],
    args: ['tools/bazel/website-build.ts', '{output}'],
    env: {THREADNOTE_SITE_PREPARED_METADATA: 'apps/website/.bazel-inputs/metadata.json', THREADNOTE_SITE_BASE: '/'},
  },
  ...applicationTestGroups.map(({entries, name}) => ({
    package: 'apps/threadnote',
    name,
    kind: 'test',
    entries,
    data: applicationTestData,
    referencedInputRoots: applicationReferencedInputRoots,
    npm: packageTestNpm['packages/graph'],
    timeout: 'long',
    workspace: true,
  })),
  ...applicationIntegrationTargets,
  {
    package: 'apps/threadnote',
    name: 'test_postgres',
    kind: 'test',
    entries: [...postgresTests],
    data: applicationTestData,
    dataRoots: ['packages/remote-memory/src/migrations'],
    referencedInputRoots: applicationReferencedInputRoots,
    env: {THREADNOTE_TEST_POSTGRES_URL: 'postgres://postgres:postgres@127.0.0.1:5432/threadnote_ci'},
    requiresNetwork: true,
  },
  ...longRunningTargets,
  ...packageTests,
  {
    package: '',
    name: 'infra_contract_test',
    kind: 'test',
    entries: testFilesBelow('infra/telemetry-gateway/test'),
    dataRoots: ['infra/telemetry-dashboard', 'infra/telemetry-gateway'],
    data: [
      '.dockerignore',
      '.github/CODEOWNERS',
      '.github/actionlint.yml',
      '.github/workflows/telemetry-dashboard.yml',
      '.github/workflows/telemetry-delivery-canary.yml',
      '.github/workflows/telemetry-gateway.yml',
      'apps/threadnote/src/telemetry/commands.ts',
      'apps/website/src/content/docsTelemetry.ts',
      'docs/operations/telemetry-production.md',
      'docs/telemetry.md',
      'fly.toml',
      'packages/graph/src/disk/capacity.ts',
    ],
  },
];

export const testSuites = [
  {
    package: 'apps/threadnote',
    name: 'test',
    tests: [
      ...applicationTestGroups.map(({name}) => `:${name}`),
      ...applicationIntegrationTargets.map(({name}) => `:${name}`),
    ].sort(),
  },
];

export const staticTargets = [
  {
    label: '//infra/telemetry-gateway:gateway_test',
    kind: 'test',
    inputs: filesBelow('infra/telemetry-gateway').filter(path => !path.includes('/cmd/')),
  },
  {
    label: '//infra/telemetry-gateway/internal/budget:budget_test',
    kind: 'test',
    inputs: filesBelow('infra/telemetry-gateway/internal/budget'),
  },
  {
    label: '//infra/telemetry-gateway/cmd/budget:budget_test',
    kind: 'test',
    inputs: [
      ...filesBelow('infra/telemetry-gateway/cmd/budget'),
      ...filesBelow('infra/telemetry-gateway/internal/budget'),
    ],
  },
  {
    label: '//infra/telemetry-gateway/cmd/canary:canary_test',
    kind: 'test',
    inputs: filesBelow('infra/telemetry-gateway/cmd/canary'),
  },
  {
    label: '//:workflow_validation',
    kind: 'ci',
    lane: 'workflow_validation',
    inputs: filesBelow('.github/workflows'),
  },
  {
    label: '//:bazel_validation',
    kind: 'ci',
    lane: 'bazel_validation',
    inputs: [...filesBelow('tools/bazel'), 'MODULE.bazel', '.bazelrc', '.bazelversion'],
  },
  {
    label: '//:recall_quality',
    kind: 'ci',
    lane: 'recall_quality',
    dependsOn: ['//:recall_quality_inputs'],
    inputs: [
      ...filesBelow('packages/recall/src'),
      ...filesBelow('packages/memory/src'),
      ...filesBelow('packages/graph/src'),
      ...filesBelow('apps/threadnote/src/evaluation'),
      ...filesBelow('apps/threadnote/test/evaluation'),
      ...filesBelow('scripts').filter(path => /(?:evaluate|benchmark|recall|code-memory|context-brief)/u.test(path)),
    ],
  },
  {
    label: '//:windows_smoke',
    kind: 'ci',
    lane: 'windows_smoke',
    dependsOn: ['//:windows_smoke_inputs'],
    inputs: [
      ...filesBelow('packages/platform/src'),
      ...filesBelow('apps/threadnote/src/effect'),
      ...filesBelow('apps/threadnote/src/process'),
      ...filesBelow('apps/threadnote/src/release'),
      ...filesBelow('apps/threadnote/test/unit').filter(path =>
        /(?:windows|command-shim|effect-command|effect-system|standalone-process-lease|process-diagnostics|local-ai|update|mcp|maintenance-bounded)/u.test(
          path,
        ),
      ),
    ],
  },
  {
    label: '//:release_matrix',
    kind: 'ci',
    lane: 'release_matrix',
    dependsOn: ['//:release_check', '//:threadnote_build'],
    inputs: [
      ...filesBelow('apps/threadnote/src'),
      ...filesBelow('packages').filter(path => path.includes('/src/')),
      ...filesBelow('assets'),
      ...filesBelow('config'),
      ...filesBelow('scripts').filter(path => /(?:build|compile|release|self-contained)/u.test(path)),
      'bun.lock',
      'package.json',
    ],
  },
];
