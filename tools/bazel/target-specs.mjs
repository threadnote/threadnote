import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {fileURLToPath} from 'node:url';
/* oxlint-disable effecttsgo/node-builtin-import -- Target discovery runs before the declared Bazel graph exists. */
import {existsSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {ciLongRunningTestGroups, ciRequiredLongRunningTestGroupNames} from '../ci/vitest-plan.ts';
import {groupApplicationTests} from './application-test-groups.mjs';
import {allowedRepositoryPath, listRepositoryFiles, sourceRepositoryPathCandidates} from './repository-inputs.mjs';
import {collectSourceClosure, sourceImports} from './source-closure.mjs';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const defaultRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const createTargetSpecs = async (root = defaultRoot) => {
  const repositoryFiles = listRepositoryFiles(root);
  const ignoredNames = new Set([
    '.DS_Store',
    '.git',
    '.context',
    '.bazel-inputs',
    'BUILD',
    'BUILD.bazel',
    'node_modules',
  ]);
  const filesBelow = directory =>
    EffectArray.filter(
      [...repositoryFiles],
      path =>
        Effect.pipe(path, EffectString.startsWith(`${directory}/`)) &&
        !EffectArray.some(Effect.pipe(path, EffectString.split('/')), part => ignoredNames.has(part)) &&
        existsSync(join(root, path)) &&
        statSync(join(root, path)).isFile(),
    );
  const contents = new Map();
  const readable = EffectArray.filter(
    [...repositoryFiles],
    path => (/\.(?:[cm]?[jt]sx?)$/u.test(path) || /(?:^|\/)package\.json$/u.test(path)) && existsSync(join(root, path)),
  );
  for (let offset = 0; offset < readable.length; offset += 64)
    await Promise.all(
      EffectArray.map(readable.slice(offset, offset + 64), async path => {
        contents.set(path, await Bun.file(join(root, path)).text());
      }),
    );
  const readSource = path => {
    if (!contents.has(path)) throw new Error(`Authored source was not preloaded: ${path}`);
    return contents.get(path);
  };
  const testFilesBelow = directory =>
    EffectArrayPipe(filesBelow(directory), __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (path, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && /\.test\.tsx?$/u.test(path),
      ),
    ).sort();
  const packageDirectories = EffectArray.map(
    EffectArray.filter([...repositoryFiles], path => /^packages\/[^/]+\/package\.json$/u.test(path)),
    path => Effect.pipe(path, EffectString.slice(0, -13)),
  ).sort();
  const applicationWorkspaceDirectories = EffectArray.filter(
    [
      ...EffectArray.map(
        EffectArray.filter([...repositoryFiles], path => /^apps\/[^/]+\/package\.json$/u.test(path)),
        path => Effect.pipe(path, EffectString.slice(0, -13)),
      ).sort(),
      ...packageDirectories,
    ],
    path => existsSync(join(root, path, 'package.json')),
  );
  const applicationWorkspaces = new Map(
    EffectArray.map(applicationWorkspaceDirectories, path => {
      const manifest = JSON.parse(readSource(`${path}/package.json`));
      return [manifest.name, {path, manifest}];
    }),
  );
  const sourceImportCache = new Map();
  const applicationSourceImports = path => {
    if (!sourceImportCache.has(path)) sourceImportCache.set(path, sourceImports(path, readSource(path)));
    return sourceImportCache.get(path);
  };
  const applicationSourceExists = path => {
    const absolute = join(root, path);
    return repositoryFiles.has(path) && existsSync(absolute) && statSync(absolute).isFile();
  };
  const longRunningTests = new Set(EffectRecord.values(ciLongRunningTestGroups).flat());
  const applicationTests = [...testFilesBelow('apps/threadnote/test')].sort();
  const applicationIntegrationTests = EffectArray.filter(
    applicationTests,
    (path, __effectArrayIndex) =>
      __effectArrayIndex in applicationTests &&
      Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/integrations/')),
  );
  const postgresTests = new Set(
    EffectArray.filter(
      applicationTests,
      (path, __effectArrayIndex) =>
        __effectArrayIndex in applicationTests && readSource(path).includes('THREADNOTE_TEST_POSTGRES_URL'),
    ),
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
    'apps/threadnote/test/dev-skills/bundle.test.ts',
    'apps/threadnote/test/dev-skills/workflow-memory.test.ts',
    'apps/threadnote/test/dev-skills/workflow-publication.test.ts',
    'apps/threadnote/test/dev-skills/workflow-publication-coordinator.test.ts',
    'apps/threadnote/test/dev-skills/workflow-citation-recovery.test.ts',
    'apps/threadnote/test/dev-skills/workflow-journal-validation.test.ts',
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
  const rootManifest = JSON.parse(readSource('package.json'));
  const allNpm = EffectArray.filter(
    EffectRecord.keys({...rootManifest.dependencies, ...rootManifest.devDependencies}),
    name => !Effect.pipe(name, EffectString.startsWith('@threadnote/')),
  ).sort();

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
    'packages/workflow-automations': ['config/dev-skills.json'],
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
          const referencedSource = EffectOption.getOrUndefined(
            EffectArray.findFirst(candidates, applicationSourceExists),
          );
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

  const virtualModules = [
    'virtual:threadnote-performance-evidence',
    'virtual:threadnote-release-notes',
    'virtual:threadnote-latest-release',
    'virtual:threadnote-articles',
  ];

  const toolingTests = [
    ...testFilesBelow('tools/bazel/test'),
    ...testFilesBelow('tools/ci/test'),
    ...testFilesBelow('tools/diagnostics/test'),
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

  const packageTests = EffectArray.flatMap(packageDirectories, directory => {
    const entries = testFilesBelow(`${directory}/test`);
    if (entries.length === 0) return [];
    const runtimeEntries = packageRuntimeTestEntries[directory]
      ? EffectArray.filter(
          entries,
          (path, __effectArrayIndex) => __effectArrayIndex in entries && readSource(path).includes('standalone.ts'),
        )
      : [];
    const workspaceEntries = packageWorkspaceTestEntries[directory] ?? [];
    const standardEntries = EffectArray.filter(
      entries,
      path => !runtimeEntries.includes(path) && !workspaceEntries.includes(path),
    );
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

  const longRunningTargets = EffectArray.map(ciRequiredLongRunningTestGroupNames, group => ({
    entries: [...ciLongRunningTestGroups[group]],
    package: 'apps/threadnote',
    name: `test_long_${Effect.pipe(group, EffectString.replaceAll('-', '_'))}`,
    kind: 'test',
    data: applicationTestData,
    referencedInputRoots: applicationReferencedInputRoots,
    env: {THREADNOTE_VITEST_LONG_GROUP: group},
    npm: packageTestNpm['packages/graph'],
    timeout: 'long',
    workspace: true,
  }));
  const applicationStandardTests = EffectArray.filter(
    applicationTests,
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
  const providerPackages = EffectArray.filter(
    integrationPackages,
    name => !['integration-core', 'integration-runtime'].includes(name),
  );
  const applicationTestAffinities = EffectRecord.fromEntries(
    EffectArray.map(applicationStandardTests, path => {
      const closure = applicationTestSourceClosure(path);
      const dependencies = new Set(
        EffectArray.filter(
          EffectArray.map(closure.files, file => file.match(/^packages\/(integration-[^/]+)\//u)?.[1]),
          name => integrationPackages.includes(name),
        ),
      );
      const providers = EffectArray.filter(providerPackages, name => dependencies.has(name));
      const dependencyNames =
        providers.length === providerPackages.length
          ? ['all']
          : providers.length > 0
            ? EffectArray.map(providers, name => Effect.pipe(name, EffectString.slice('integration-'.length)))
            : EffectArray.map(
                EffectArray.filter(integrationPackages, name => dependencies.has(name)),
                name => Effect.pipe(name, EffectString.slice('integration-'.length)),
              );
      return [path, dependencyNames.length === 0 ? '' : `integration_${EffectArray.join(dependencyNames, '_')}`];
    }),
  );
  const applicationTestGroups = groupApplicationTests(applicationStandardTests, {
    affinities: applicationTestAffinities,
  });
  const applicationIntegrationTargets = EffectArray.map(applicationIntegrationTests, path => ({
    package: 'apps/threadnote',
    name: `test_integration_${Effect.pipe(
      Effect.pipe(path, EffectString.split('/')).at(-1),
      EffectString.replace(/\.test\.tsx?$/u, ''),
      EffectString.replaceAll(/[^a-zA-Z0-9_]+/gu, '_'),
    )}`,
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
    sourceRoots: ['apps/threadnote/src', ...EffectArray.map(packageDirectories, path => `${path}/src`)],
    dataRoots: [
      'assets',
      'config',
      'cursor-plugin',
      'packages/manager/static',
      ...EffectArray.map(providerPackages, name => `packages/${name}/static`),
      'packages/remote-memory/src/migrations',
    ],
    data: ['.threadnoteignore', 'LICENSE', 'THIRD_PARTY.md', 'package.json', 'scripts/native/graph-keychain.m'],
    npm: allNpm,
  };

  const targetSpecs = [
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
      entries: [
        ...windowsSmokeEntries,
        'tools/ci/windows-smoke.config.ts',
        'apps/threadnote/test/dev-skills/native-closeout-lifecycle.test.ts',
        'apps/threadnote/test/dev-skills/native-cycle-lifecycle.test.ts',
      ],
      data: ['package.json', 'vitest.config.ts'],
    },
    {
      package: '',
      name: 'compile_inputs',
      kind: 'library',
      entries: ['scripts/compile-targets.ts', 'scripts/check-embedded-core-model.ts'],
      closureEntries: ['apps/threadnote/src/standalone.ts'],
      data: ['bun.lock', 'package.json', 'tsconfig.json', 'assets/models/licenses/bge-small-en-v1.5.LICENSE'],
    },
    {
      package: '',
      name: 'release_smoke_inputs',
      kind: 'library',
      entries: [
        'scripts/check-self-contained.ts',
        'scripts/smoke-self-contained.ts',
        'scripts/archive-release.ts',
        'tools/ci/windows-workflow-prerequisites.ts',
        'vitest.config.ts',
        'vitest.e2e.config.ts',
        'apps/threadnote/test/unit/effect-system.test.ts',
        'packages/workflow-automations/test/inventory.test.ts',
        'packages/workflow-automations/test/baseline.test.ts',
        ...EffectArrayPipe(filesBelow('apps/threadnote/test/e2e'), __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (path, __effectArrayIndex) =>
              __effectArrayIndex in __effectArrayValues && Effect.pipe(path, EffectString.endsWith('.e2e.ts')),
          ),
        ),
        'apps/threadnote/test/dev-skills/release-artifact.test.ts',
        'apps/threadnote/test/dev-skills/workflow-journal-validation.test.ts',
        // smoke-self-contained launches this path from a runtime-resolved root.
        'apps/threadnote/test/fixtures/cli-output-consumer.ts',
      ],
      referencedInputRoots: applicationReferencedInputRoots,
      data: applicationTestData,
    },
    {
      package: '',
      name: 'tooling_test',
      kind: 'test',
      entries: toolingTests,
      data: [
        'apps/threadnote/test/evaluation/baselines/context-brief-citations-v1/scale-budgets.json',
        // The consumer subprocess fixture copies these entrypoints by dynamic path.
        'tools/bazel/run.ts',
        'tools/bazel/runner.mjs',
        'tools/bazel/targets.json',
        'tools/ci/bazel-plan-shards.mjs',
        'tools/ci/bazel-shards.mjs',
        'tools/ci/selection.mjs',
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
      sourceRoots: ['apps/threadnote/src', ...EffectArray.map(packageDirectories, path => `${path}/src`)],
      data: ['tsconfig.json', 'package.json'],
      npm: ['@types/bun', '@types/react', '@types/react-dom', '@types/three'],
      args: ['check', '-p', 'tsconfig.json'],
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
        ...EffectArray.flatMap(packageDirectories, path => [`${path}/src`, `${path}/test`]),
        'infra/telemetry-gateway/test',
        'tools/bazel/test',
        'tools/ci',
        'tools/workspace',
      ],
      data: ['config/lint/threadnote-plugin.d.ts', 'tsconfig.json', 'tsconfig.test.json', 'package.json'],
      npm: ['@types/bun', '@types/react', '@types/react-dom', '@types/three'],
      exclude: path => path.startsWith('apps/threadnote/test/evaluation/fixtures/') && path.includes('/repository/'),
      args: ['check', '-p', 'tsconfig.test.json'],
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
      args: ['fmt', '--check', '.', '--ignore-unknown'],
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
      entries: EffectArray.filter(testFilesBelow('apps/website/test'), path => !websiteReleaseTests.has(path)),
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
      npm: ['happy-dom', 'jsdom', '@expo-google-fonts/spline-sans'],
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
      npm: ['@types/bun', '@types/react', '@types/react-dom', '@types/three'],
      args: ['check', '-p', 'apps/website/tsconfig.json'],
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
    ...EffectArray.map(applicationTestGroups, ({entries, name}) => ({
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

  const testSuites = [
    {
      package: 'apps/threadnote',
      name: 'test',
      tests: [
        ...EffectArray.map(applicationTestGroups, ({name}) => `:${name}`),
        ...EffectArray.map(applicationIntegrationTargets, ({name}) => `:${name}`),
      ].sort(),
    },
  ];

  const staticTargets = [
    {
      label: '//infra/telemetry-gateway:gateway_test',
      kind: 'test',
      inputs: EffectArray.filter(
        filesBelow('infra/telemetry-gateway'),
        path => !Effect.pipe(path, EffectString.includes('/cmd/')),
      ),
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
        ...EffectArrayPipe(filesBelow('scripts'), __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (path, __effectArrayIndex) =>
              __effectArrayIndex in __effectArrayValues &&
              /(?:evaluate|benchmark|recall|code-memory|context-brief)/u.test(path),
          ),
        ),
      ],
    },
    {
      label: '//:windows_smoke',
      kind: 'ci',
      lane: 'windows_smoke',
      dependsOn: ['//:windows_smoke_inputs'],
      inputs: [
        '.github/workflows/ci.yml',
        // The workflow runs this entire test directory, including tests outside windows_smoke_inputs.
        ...testFilesBelow('apps/threadnote/test/dev-skills'),
        'apps/threadnote/test/integration/cli.dev-skills.test.ts',
        'packages/integrations/test/dev-skills-catalog.test.ts',
        ...filesBelow('packages/platform/src'),
        ...filesBelow('apps/threadnote/src/effect'),
        ...filesBelow('apps/threadnote/src/process'),
        ...filesBelow('apps/threadnote/src/release'),
        ...EffectArrayPipe(filesBelow('apps/threadnote/test/unit'), __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (path, __effectArrayIndex) =>
              __effectArrayIndex in __effectArrayValues &&
              /(?:windows|command-shim|effect-command|effect-system|standalone-process-lease|process-diagnostics|local-ai|update|mcp|maintenance-bounded)/u.test(
                path,
              ),
          ),
        ),
      ],
    },
    {
      label: '//:compile_targets',
      kind: 'ci',
      lane: 'compile_targets',
      dependsOn: ['//:compile_inputs'],
      inputs: ['.github/workflows/ci.yml'],
    },
    {
      label: '//:release_matrix',
      kind: 'ci',
      lane: 'release_matrix',
      dependsOn: ['//:release_check', '//:threadnote_build', '//:release_smoke_inputs'],
      inputs: ['.github/workflows/ci.yml', '.github/workflows/native-release-smoke.yml'],
    },
  ];

  return {targetSpecs, testSuites, staticTargets, virtualModules};
};
