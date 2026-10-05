import {readFile, readdir} from '@threadnote/testing/node-fs-promises';
import {builtinModules} from '@threadnote/testing/node-module';
import {dirname, join, relative} from '@threadnote/testing/node-path';
import {fileURLToPath} from '@threadnote/testing/node-url';
import {describe, expect, it} from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const sourceRoot = join(repoRoot, 'apps', 'threadnote', 'src');
const codeRoots = ['scripts', 'tools', 'infra', 'packages', 'apps'].map(path => join(repoRoot, path));

async function codeFiles(path: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path, {withFileTypes: true})) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory() && !['node_modules', '.bazel-inputs', 'dist'].includes(entry.name)) {
      files.push(...(await codeFiles(entryPath)));
    } else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

const sourceFiles = async () => {
  const packagesRoot = join(repoRoot, 'packages');
  const packageDirectories = (await readdir(packagesRoot, {withFileTypes: true})).filter(
    entry => entry.isDirectory() && entry.name !== 'testing',
  );
  return (
    await Promise.all([
      codeFiles(sourceRoot),
      ...packageDirectories.map(entry => codeFiles(join(packagesRoot, entry.name, 'src'))),
    ])
  ).flat();
};
const nodeBuiltinModules = new Set(
  builtinModules.filter(module => !module.startsWith('bun:')).map(module => module.replace(/^node:/, '')),
);
const moduleSpecifierScanners = {
  js: new Bun.Transpiler({loader: 'js', logLevel: 'error'}),
  jsx: new Bun.Transpiler({loader: 'jsx', logLevel: 'error', tsconfig: {compilerOptions: {jsx: 'react'}}}),
  ts: new Bun.Transpiler({loader: 'ts', logLevel: 'error'}),
  tsx: new Bun.Transpiler({loader: 'tsx', logLevel: 'error', tsconfig: {compilerOptions: {jsx: 'react'}}}),
};

function importedModuleSpecifiers(path: string, source: string): readonly string[] {
  const loader = path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : path.endsWith('.jsx') ? 'jsx' : 'js';
  return moduleSpecifierScanners[loader].scanImports(source).map(imported => imported.path);
}

function isNodeBuiltinSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  const root = specifier.split('/', 1)[0];
  return nodeBuiltinModules.has(specifier) || nodeBuiltinModules.has(root);
}

describe('Effect architecture boundaries', () => {
  it('keeps the CLI free of generic Promise workflow bridges', async () => {
    const cli = await readFile(join(sourceRoot, 'effect', 'cli.ts'), 'utf8');
    expect(cli).not.toContain('withRuntimePromise');
    expect(cli).not.toMatch(/\blegacy\s*\(/);
  });

  it('centralizes application Promise lifting in the Effect error adapter', async () => {
    const declarations: string[] = [];
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      if (/\b(?:const|function)\s+fromPromise\b/.test(source)) {
        declarations.push(relative(repoRoot, path));
      }
    }
    expect(declarations).toEqual(['packages/platform/src/errors.ts']);
  });

  it('keeps raw Promise lifting primitives inside the shared adapters', async () => {
    const allowed = new Set([
      'apps/threadnote/src/effect/archive.ts',
      'apps/threadnote/src/effect/ai/isolated-local-model-runtime.ts',
      'apps/threadnote/src/effect/cli/output.ts',
      'apps/threadnote/src/effect/console.ts',
      'packages/platform/src/errors.ts',
      'apps/threadnote/src/effect/mcp_broker_process.ts',
      'packages/platform/src/system.ts',
      'apps/threadnote/src/mcp/server/index.ts',
    ]);
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      const relativePath = relative(repoRoot, path);
      if (allowed.has(relativePath)) {
        continue;
      }
      expect(source, relativePath).not.toContain('tryPromiseWithConsole');
      expect(source, relativePath).not.toMatch(/\bEffect\.(?:promise|tryPromise)\b/);
    }
  });

  it('does not create internal Effect runtimes in production source', async () => {
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      expect(source, relative(repoRoot, path)).not.toMatch(/Effect\.(?:runPromise|runFork)\s*\(/);
    }
  });

  it('does not import or require Node built-ins in production source', async () => {
    const importShapes = [
      "import '../helpers/node-fs.js';",
      "import {readFile} from 'fs/promises';",
      "export {join} from '../helpers/node-path.js';",
      "void import('../helpers/node-url.js');",
      "const os = require('os');",
      "import fs = require('fs');",
      "import external from 'external-package';",
      "const ignored = `require('fs') ${`nested ${value}`}`;",
      "import '../helpers/node-crypto.js';",
    ].join('\n');
    expect(importedModuleSpecifiers('builtin-shapes.ts', importShapes).filter(isNodeBuiltinSpecifier)).toEqual([
      'fs/promises',
      'os',
      'fs',
    ]);

    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      expect(importedModuleSpecifiers(path, source).filter(isNodeBuiltinSpecifier), relative(repoRoot, path)).toEqual(
        [],
      );
    }
  });

  it('keeps Bun structural built-ins inside the exact SystemInfo adapters', async () => {
    const accesses: {module: string; path: string}[] = [];
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      const relativePath = relative(repoRoot, path);
      const mentions = source.match(/\bgetBuiltinModule\b/g)?.length ?? 0;
      expect(mentions, relativePath).toBe(relativePath === 'packages/platform/src/system.ts' ? 3 : 0);
      const calls = [...source.matchAll(/process\.getBuiltinModule\(\s*['"]([^'"]+)['"]\s*\)/g)];
      accesses.push(...calls.map(match => ({module: match[1], path: relativePath})));
    }
    expect(accesses).toEqual([
      {module: 'os', path: 'packages/platform/src/system.ts'},
      {module: 'fs', path: 'packages/platform/src/system.ts'},
      {module: 'path', path: 'packages/platform/src/system.ts'},
    ]);

    const system = await readFile(join(repoRoot, 'packages', 'platform', 'src', 'system.ts'), 'utf8');
    const nativeStatfsStart = system.indexOf('function nativeStatfs');
    const fallbackStart = system.indexOf('export function legacyAvailableDiskBytes');
    const windowsWorkerAdapterStart = system.indexOf('export interface WindowsDiskCapacityWorkerProcess');
    expect(nativeStatfsStart).toBeGreaterThanOrEqual(0);
    expect(fallbackStart).toBeGreaterThan(nativeStatfsStart);
    expect(windowsWorkerAdapterStart).toBeGreaterThan(fallbackStart);
    const nativeStatfs = system.slice(nativeStatfsStart, fallbackStart);
    const fallback = system.slice(fallbackStart, windowsWorkerAdapterStart);
    expect(nativeStatfs).toContain('Effect.tryPromise({');
    expect(nativeStatfs).toContain('nativeFileSystemPromises.statfs!(path, {bigint: true})');
    expect(nativeStatfs).not.toContain('Effect.try({');
    expect(fallback).toContain('Effect.acquireUseRelease(');
    expect(fallback).toContain('Bun.spawn({');
    expect(fallback).toContain('maxBuffer: DISK_QUERY_OUTPUT_LIMIT_BYTES');
    expect(fallback).toContain("child.kill('SIGKILL')");
    expect(fallback).not.toContain('Bun.spawnSync(');
  });

  it('uses only Bun Effect platform adapters in production source', async () => {
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      expect(source, relative(repoRoot, path)).not.toMatch(
        /@effect\/(?:platform-node|sql-sqlite-node)|\bNode(?:Runtime|Services|HttpClient|HttpServer|Socket|Stdio)\b/,
      );
    }
  });

  it('keeps runtime globals inside the SystemInfo, process-adapter, and executable boundaries', async () => {
    const allowed = new Set([
      'apps/threadnote/src/effect/ai/isolated-local-model-runtime.ts',
      'apps/threadnote/src/effect/mcp_broker_process.ts',
      'packages/platform/src/system.ts',
      'apps/threadnote/src/standalone.ts',
    ]);
    for (const path of await sourceFiles()) {
      const relativePath = relative(repoRoot, path);
      if (allowed.has(relativePath)) {
        continue;
      }
      const source = await readFile(path, 'utf8');
      expect(source, relativePath).not.toMatch(
        /(?<![$\w])process\.(?:argv|cwd|env|execPath|exitCode|getuid|kill|pid|platform|stdin|stdout)/,
      );
    }
  });

  it('routes console output through the Effect Console service', async () => {
    for (const root of codeRoots) {
      for (const path of await codeFiles(root)) {
        const source = await readFile(path, 'utf8');
        expect(source, relative(repoRoot, path)).not.toMatch(/\bconsole\.(?:debug|error|info|log|warn)\s*\(/);
      }
    }
  });

  it('isolates unstable Effect AI imports inside the AI adapter directory', async () => {
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      if (!/['"]effect\/ai(?:\/|['"])/u.test(source)) {
        continue;
      }
      expect(relative(repoRoot, path)).toMatch(
        /^(?:apps\/threadnote\/src\/effect\/ai|packages\/inference\/src\/engine)\//,
      );
    }
  });

  it('isolates node-llama-cpp access inside its native adapter', async () => {
    const allowed = 'packages/inference/src/engine/node-llama-cpp.ts';
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      if (!/(?:from\s+['"]node-llama-cpp['"]|import\s*\(\s*['"]node-llama-cpp['"]\s*\))/.test(source)) {
        continue;
      }
      expect(relative(repoRoot, path)).toBe(allowed);
    }
  });

  it('keeps application inference crash-isolated in source and release executions', async () => {
    const runtime = await readFile(join(sourceRoot, 'effect', 'runtime.ts'), 'utf8');
    expect(runtime).toContain('isolatedLocalModelRuntimeLayer()');
    expect(runtime).not.toContain('LocalModelRuntime.nativeLayer');
    expect(runtime).not.toContain('THREADNOTE_STANDALONE');
  });

  it('keeps Manager graph construction outside the long-lived UI process', async () => {
    const [manager, managerWorksets, worksetCommands, worksetPreparation] = await Promise.all([
      readFile(join(sourceRoot, 'manager', 'server.ts'), 'utf8'),
      readFile(join(sourceRoot, 'manager', 'worksets.ts'), 'utf8'),
      readFile(join(sourceRoot, 'code_graph', 'commands.ts'), 'utf8'),
      readFile(join(repoRoot, 'packages', 'graph', 'src', 'workset_catalog', 'isolated_prepare.ts'), 'utf8'),
    ]);

    expect(manager).toContain('runIsolatedCodeGraphIndexSnapshot({');
    expect(manager).not.toContain('CodeGraphIndexer');
    expect(managerWorksets).toContain('request.prepareWorkset ?? prepareManagerCodeGraphWorksetIsolated');
    expect(managerWorksets).not.toContain('prepareCodeGraphWorkset(');
    expect(worksetPreparation).toContain("'workset',\n      'prepare',\n      '--json'");
    expect(worksetPreparation).toContain("[CODE_GRAPH_MANAGER_WORKSET_ORCHESTRATOR_ENV]: '1'");
    expect(worksetCommands).toContain(
      "const isolateBuilds = system.environment()[CODE_GRAPH_MANAGER_WORKSET_ORCHESTRATOR_ENV] === '1'",
    );
    expect(worksetCommands).toContain('isolateBuilds,');
  });

  it('keeps Manager Context browser paging outside the server runtime graph', async () => {
    const contextView = await readFile(join(repoRoot, 'packages', 'manager', 'src', 'context', 'view.tsx'), 'utf8');
    const paging = await readFile(join(repoRoot, 'packages', 'manager', 'src', 'context', 'paging.ts'), 'utf8');
    const browserRuntimeSource = contextView.replace(
      /import\s+type\s+[^;]+\s+from\s+['"]\.\.\/context\.js['"];\n?/u,
      '',
    );

    expect(importedModuleSpecifiers('context/view.tsx', browserRuntimeSource)).not.toContain('../context.js');
    expect(importedModuleSpecifiers('context/paging.ts', paging)).toEqual([]);
  });

  it('heals deferred code anchors after in-process graph publication', async () => {
    const [runtime, commands] = await Promise.all([
      readFile(join(sourceRoot, 'effect', 'runtime.ts'), 'utf8'),
      readFile(join(sourceRoot, 'code_graph', 'commands.ts'), 'utf8'),
    ]);
    expect(runtime).toContain('withDeferredCodeAnchorIndexHeal');
    expect(runtime).toContain('healAfterPublishedGraphIndex(options.threadnoteHome, options.cwd, summary.identity)');
    expect(commands).not.toContain('healAnchorsAfterGraphIndex');
    expect(commands).toContain('healAnchorsAfterWorksetPrepare');
  });

  it('wakes pending deferred-anchor worktrees only when MCP can read memory and index locally', async () => {
    const mcp = await readFile(join(sourceRoot, 'mcp', 'server', 'index.ts'), 'utf8');
    expect(mcp).toContain('refreshPendingDeferredCodeAnchorWorkspaces');
    expect(mcp).toContain('memoryRead && mcpToolCapabilities(toolset).graphLocal');
  });

  it('keeps standalone worker dispatch independent from application entry modules', async () => {
    const standalone = await readFile(join(sourceRoot, 'standalone.ts'), 'utf8');
    const workerProtocol = await readFile(join(sourceRoot, 'worker_protocol.ts'), 'utf8');
    const processLease = await readFile(join(sourceRoot, 'process', 'standalone_lease.ts'), 'utf8');

    expect(standalone).not.toMatch(
      /from ['"]\.\/(?:code_graph\/parser_worker|effect\/ai\/isolated-local-model-runtime|effect\/cli|effect\/runtime|installations|mcp\/server\/index|process\/diagnostics|threadnote)\.js['"]/,
    );
    expect(standalone).not.toMatch(/from ['"]@threadnote\/graph\/parser_worker['"]/);
    expect(standalone).toContain("import('@threadnote/graph/parser_worker')");
    expect(standalone).toContain("import('./effect/ai/isolated-local-model-runtime.js')");
    expect(standalone).toContain("import('./effect/runtime.js')");
    expect(standalone).toContain("import('./mcp/server/index.js')");
    expect(workerProtocol).not.toMatch(/^import\s/m);
    expect(processLease).not.toContain("from './installations.js'");
    expect(processLease).not.toContain("from './utils.js'");
  });
});
