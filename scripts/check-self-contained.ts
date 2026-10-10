import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path} from 'effect';
import {sha256FileHex} from '@threadnote/platform/digest';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

const ROOT_URL = new URL('..', import.meta.url);
const EXPECTED_BUN_VERSION = '1.4.2';
const EXPECTED_EFFECT_VERSION = '4.0.0';
const EXPECTED_NODE_LLAMA_CPP_VERSION = '3.21.1';
const EXPECTED_TYPESCRIPT_COMPILER_VERSION = 'npm:typescript@5.9.3';
const EXPECTED_WEB_TREE_SITTER_VERSION = '0.27.0';
const EXPECTED_VSCODE_TREE_SITTER_WASM_VERSION = '0.3.1';
const EXPECTED_REPOMIX_TREE_SITTER_WASMS_VERSION = '0.1.17';
const EXPECTED_TREE_SITTER_HCL_VERSION = '1.2.0';
const EXPECTED_TREE_SITTER_GRAMMAR_PACKAGE_VERSIONS = {
  '@tree-sitter-grammars/tree-sitter-lua': '0.4.1',
  '@tree-sitter-grammars/tree-sitter-svelte': '1.0.2',
  '@tree-sitter-grammars/tree-sitter-zig': '1.1.2',
  'tree-sitter-elixir': '0.3.5',
  'tree-sitter-julia': '0.23.1',
  'tree-sitter-objc': '3.0.2',
  'tree-sitter-scala': '0.24.0',
  'tree-sitter-systemverilog': '0.4.1',
} as const;
const FORBIDDEN_LEGACY_FILES = [
  '.nvmrc',
  'bin/node-warning-filter.cjs',
  'bin/threadnote.cjs',
  'bin/threadnote-mcp-server.cjs',
  'config/ov.conf.template.json',
  'config/ovcli.conf.template.json',
  'scripts/check-node-version.cjs',
  'scripts/local-ai-server.py',
] as const;
const FORBIDDEN_RELEASE_DIRECTORIES = ['apps', 'docs', 'packages', 'training', 'site-dist'] as const;
const REMOTE_MEMORY_MIGRATIONS = [
  '001_initial.sql',
  '002_git_canonical_pointers.sql',
  '003_git_ingest_observations.sql',
  '004_durable_memory_proposals.sql',
  '005_code_link_backlinks.sql',
  '006_identity_client_grant_expiry.sql',
  '007_cloud_admission_profile.sql',
  '008_hosted_context_health.sql',
  '009_hosted_context_ci.sql',
] as const;
const ALLOWED_LEGACY_RUNTIME_SOURCES = new Set([
  'apps/threadnote/src/effect/cli.ts',
  'apps/threadnote/src/lifecycle.ts',
  'apps/threadnote/src/migration/home.ts',
  'apps/threadnote/src/migration/legacy-installations.ts',
  'apps/threadnote/src/migration/legacy-runtime.ts',
  'packages/store/src/layout.ts',
]);
const ALLOWED_LEGACY_IDENTIFIER_SOURCES = new Set([
  'apps/threadnote/src/evaluation/recall-fixture.ts',
  'packages/memory/src/hygiene.ts',
  'apps/threadnote/src/migration/home.ts',
  'apps/threadnote/src/migration/layout.ts',
  'packages/store/src/resource-id.ts',
]);
const ALLOWED_PYTHON_LANGUAGE_METADATA_SOURCES = new Set([
  'packages/graph/src/languages/catalog.generated.ts',
  'packages/graph/src/languages/generic/definitions.ts',
  'packages/graph/src/languages/tree_sitter_assets.ts',
  'packages/manager/src/memory_editor_languages.ts',
]);

const checkSelfContained = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(ROOT_URL);
  const failures: string[] = [];
  yield* validateCodeGraphAssets(fs, path, path.join(root, 'assets', 'code-graph'), failures, root);
  yield* validateCursorPlugin(fs, path, root, failures);

  for (const file of FORBIDDEN_LEGACY_FILES) {
    if (yield* fs.exists(path.join(root, file))) {
      failures.push(`legacy runtime file remains: ${file}`);
    }
  }

  const runtimeSourceFiles = [...(yield* sourceFiles(fs, path, path.join(root, 'apps', 'threadnote', 'src')))];
  for (const name of yield* fs.readDirectory(path.join(root, 'packages'))) {
    const packageSource = path.join(root, 'packages', name, 'src');
    if (name !== 'testing' && (yield* fs.exists(packageSource)))
      runtimeSourceFiles.push(...(yield* sourceFiles(fs, path, packageSource)));
  }
  for (const file of runtimeSourceFiles) {
    const relativePath = normalizePath(path.relative(root, file));
    const content = yield* fs.readFileString(file);
    if (/\b(?:openviking|pipx)\b/i.test(content) && !ALLOWED_LEGACY_RUNTIME_SOURCES.has(relativePath)) {
      failures.push(`legacy runtime token outside migration boundary: ${relativePath}`);
    }
    if (
      /\bpython\b/i.test(content) &&
      relativePath !== 'apps/threadnote/src/migration/legacy-installations.ts' &&
      !ALLOWED_PYTHON_LANGUAGE_METADATA_SOURCES.has(relativePath)
    ) {
      failures.push(`Python runtime token outside migration or language metadata: ${relativePath}`);
    }
    if (/(?:viking:\/\/|data\/viking)/i.test(content) && !ALLOWED_LEGACY_IDENTIFIER_SOURCES.has(relativePath)) {
      failures.push(`legacy identifier or storage path outside compatibility boundary: ${relativePath}`);
    }
    if (/(?:from\s+['"]node:|import\s*\(\s*['"]node:|require\s*\(\s*['"]node:)/.test(content)) {
      failures.push(`Node built-in import in production source: ${relativePath}`);
    }
    if (/from\s+['"](?:@effect\/platform-node|@effect\/sql-sqlite-node)['"]/.test(content)) {
      failures.push(`Node Effect adapter in production source: ${relativePath}`);
    }
    if (
      /from\s+['"]node-llama-cpp['"]/.test(content) &&
      relativePath !== 'packages/inference/src/engine/node-llama-cpp.ts'
    ) {
      failures.push(`raw node-llama-cpp import outside adapter: ${relativePath}`);
    }
  }

  const manifest = yield* fs.readFileString(path.join(root, 'package.json')).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => JSON.parse(content) as PackageManifest,
        catch: cause => ScriptError.make({message: 'Could not parse package.json.', cause}),
      }),
    ),
  );
  const allDependencies = {...manifest.dependencies, ...manifest.devDependencies};
  if (manifest.packageManager !== `bun@${EXPECTED_BUN_VERSION}`) {
    failures.push(`packageManager must pin bun@${EXPECTED_BUN_VERSION}`);
  }
  if (manifest.dependencies?.['node-llama-cpp'] !== EXPECTED_NODE_LLAMA_CPP_VERSION) {
    failures.push(`node-llama-cpp must be pinned to ${EXPECTED_NODE_LLAMA_CPP_VERSION}`);
  }
  if (manifest.dependencies?.['@effect/sql-sqlite-bun'] !== EXPECTED_EFFECT_VERSION) {
    failures.push(`@effect/sql-sqlite-bun must be pinned to ${EXPECTED_EFFECT_VERSION}`);
  }
  if (manifest.dependencies?.['typescript-compiler'] !== EXPECTED_TYPESCRIPT_COMPILER_VERSION) {
    failures.push(`typescript-compiler must be pinned to ${EXPECTED_TYPESCRIPT_COMPILER_VERSION}`);
  }
  if (manifest.dependencies?.['web-tree-sitter'] !== EXPECTED_WEB_TREE_SITTER_VERSION) {
    failures.push(`web-tree-sitter must be pinned to ${EXPECTED_WEB_TREE_SITTER_VERSION}`);
  }
  if (manifest.dependencies?.['@effect/platform-bun'] !== EXPECTED_EFFECT_VERSION) {
    failures.push(`@effect/platform-bun must be a runtime dependency pinned to ${EXPECTED_EFFECT_VERSION}`);
  }
  if (manifest.devDependencies?.['@vscode/tree-sitter-wasm'] !== EXPECTED_VSCODE_TREE_SITTER_WASM_VERSION) {
    failures.push(`@vscode/tree-sitter-wasm must be pinned to ${EXPECTED_VSCODE_TREE_SITTER_WASM_VERSION}`);
  }
  if (manifest.devDependencies?.['@repomix/tree-sitter-wasms'] !== EXPECTED_REPOMIX_TREE_SITTER_WASMS_VERSION) {
    failures.push(`@repomix/tree-sitter-wasms must be pinned to ${EXPECTED_REPOMIX_TREE_SITTER_WASMS_VERSION}`);
  }
  if (manifest.devDependencies?.['@tree-sitter-grammars/tree-sitter-hcl'] !== EXPECTED_TREE_SITTER_HCL_VERSION) {
    failures.push(`@tree-sitter-grammars/tree-sitter-hcl must be pinned to ${EXPECTED_TREE_SITTER_HCL_VERSION}`);
  }
  for (const [packageName, version] of Object.entries(EXPECTED_TREE_SITTER_GRAMMAR_PACKAGE_VERSIONS)) {
    if (manifest.devDependencies?.[packageName] !== version) {
      failures.push(`${packageName} must be pinned to ${version}`);
    }
  }
  if (allDependencies['@effect/platform-node'] || allDependencies['@effect/sql-sqlite-node']) {
    failures.push('Node Effect runtime adapters must not be dependencies.');
  }
  if (allDependencies.graphify) {
    failures.push('Graphify must not be a runtime or development dependency.');
  }
  const scriptCommands = Object.values(manifest.scripts ?? {}).join('\n');
  if (/\b(?:node|npm|npx|pip|pipx|python|python3)\b/.test(scriptCommands)) {
    failures.push('package scripts must run through Bun only and must not invoke a Python runtime.');
  }

  for (const installer of ['scripts/install.sh', 'scripts/install.ps1'] as const) {
    const content = yield* fs.readFileString(path.join(root, installer));
    if (!content.includes('/releases/download/')) {
      failures.push(`${installer} must install standalone GitHub release artifacts.`);
    }
    if (/\b(?:npm|npx|node_modules)\b/i.test(content)) {
      failures.push(`${installer} still depends on the Node package workflow.`);
    }
  }

  const releaseMetadata = path.join(root, 'dist', 'release.json');
  if (yield* fs.exists(path.join(root, 'dist'))) {
    const canonicalLogo = path.join(root, 'assets', 'brand', 'threadnote-logo.svg');
    const packagedLogo = path.join(root, 'dist', 'assets', 'brand', 'threadnote-logo.svg');
    const canonicalModelLicense = path.join(root, 'assets', 'models', 'licenses', 'bge-small-en-v1.5.LICENSE');
    const packagedModelLicense = path.join(root, 'dist', 'assets', 'models', 'licenses', 'bge-small-en-v1.5.LICENSE');
    for (const directory of FORBIDDEN_RELEASE_DIRECTORIES) {
      if (yield* fs.exists(path.join(root, 'dist', directory))) {
        failures.push(`standalone build output contains website content: dist/${directory}`);
      }
    }
    for (const required of [
      releaseMetadata,
      path.join(root, 'dist', process.platform === 'win32' ? 'threadnote.exe' : 'threadnote'),
      path.join(root, 'dist', 'runtime', 'node-llama-cpp.js'),
      path.join(root, 'dist', 'runtime', 'native'),
      path.join(root, 'dist', 'config', 'agent-instructions.md'),
      path.join(root, 'dist', 'config', 'agent-skills', 'threadnote-context', 'SKILL.md'),
      path.join(root, 'dist', 'config', 'agent-skills', 'threadnote-code-graph', 'SKILL.md'),
      path.join(root, 'dist', 'config', 'agent-skills', 'threadnote-memory', 'SKILL.md'),
      path.join(root, 'dist', 'config', 'agent-skills', 'threadnote-health', 'SKILL.md'),
      path.join(root, 'dist', 'config', 'agent-profiles', 'cursor-cloud-personal', 'agent-instructions.md'),
      path.join(
        root,
        'dist',
        'config',
        'agent-profiles',
        'cursor-cloud-personal',
        'agent-skills',
        'threadnote-context',
        'SKILL.md',
      ),
      path.join(
        root,
        'dist',
        'config',
        'agent-profiles',
        'cursor-cloud-personal',
        'agent-skills',
        'threadnote-memory',
        'SKILL.md',
      ),
      ...[
        'agent-instructions.md',
        'start-skill.md',
        'agent-skills/threadnote-context/SKILL.md',
        'agent-skills/threadnote-memory/SKILL.md',
        'agent-skills/threadnote-code-graph/SKILL.md',
      ].map(file => path.join(root, 'dist', 'config', 'agent-profiles', 'codex-cloud-personal', file)),
      path.join(root, 'dist', 'cursor-plugin', '.cursor-plugin', 'plugin.json'),
      path.join(root, 'dist', 'cursor-plugin', 'assets', 'logo.svg'),
      path.join(root, 'dist', 'cursor-plugin', 'rules', 'threadnote.mdc'),
      path.join(root, 'dist', 'cursor-plugin', 'LICENSE'),
      path.join(root, 'dist', 'manager', 'app.css'),
      path.join(root, 'dist', 'manager', 'app.js'),
      path.join(root, 'dist', 'manager', 'index.html'),
      packagedLogo,
      packagedModelLicense,
      path.join(root, 'dist', 'assets', 'code-graph', 'manifest.json'),
      path.join(root, 'dist', 'assets', 'code-graph', 'runtime', 'web-tree-sitter.wasm'),
      path.join(root, 'dist', 'assets', 'code-graph', 'grammars', 'java.wasm'),
      path.join(root, 'dist', 'assets', 'code-graph', 'grammars', 'kotlin.wasm'),
      path.join(root, 'dist', 'assets', 'code-graph', 'grammars', 'swift.wasm'),
      path.join(root, 'dist', 'assets', 'code-graph', 'licenses', 'tree-sitter-java.LICENSE'),
      path.join(root, 'dist', 'assets', 'code-graph', 'licenses', 'tree-sitter-kotlin.LICENSE'),
      path.join(root, 'dist', 'assets', 'code-graph', 'licenses', 'tree-sitter-swift.LICENSE'),
      path.join(root, 'dist', 'assets', 'code-graph', 'licenses', 'web-tree-sitter.LICENSE'),
      ...REMOTE_MEMORY_MIGRATIONS.map(name => path.join(root, 'dist', 'remote-memory', 'migrations', name)),
    ]) {
      if (!(yield* fs.exists(required))) {
        failures.push(`standalone build output is missing: ${normalizePath(path.relative(root, required))}`);
      }
    }
    const personalCursorGraphSkill = path.join(
      root,
      'dist',
      'config',
      'agent-profiles',
      'cursor-cloud-personal',
      'agent-skills',
      'threadnote-code-graph',
      'SKILL.md',
    );
    if (yield* fs.exists(personalCursorGraphSkill)) {
      failures.push(
        `standalone build output must not contain: ${normalizePath(path.relative(root, personalCursorGraphSkill))}`,
      );
    }
    if (process.platform === 'darwin') {
      const keychainLibrary = path.join(root, 'dist', 'runtime', 'graph-keychain.dylib');
      if (!(yield* fs.exists(keychainLibrary))) {
        failures.push('standalone build output is missing: dist/runtime/graph-keychain.dylib');
      } else {
        const info = yield* fs.stat(keychainLibrary);
        if (info.type !== 'File' || (info.mode & 0o111) === 0) {
          failures.push('standalone build output must contain a loadable library: dist/runtime/graph-keychain.dylib');
        }
      }
    }
    if (
      (yield* fs.exists(canonicalLogo)) &&
      (yield* fs.exists(packagedLogo)) &&
      (yield* sha256FileHex(canonicalLogo)) !== (yield* sha256FileHex(packagedLogo))
    ) {
      failures.push('standalone build output does not contain the canonical Threadnote logo');
    }
    if (
      (yield* fs.exists(canonicalModelLicense)) &&
      (yield* fs.exists(packagedModelLicense)) &&
      (yield* sha256FileHex(canonicalModelLicense)) !== (yield* sha256FileHex(packagedModelLicense))
    ) {
      failures.push('standalone build output does not contain the pinned BGE Small license notice');
    }
    if (yield* fs.exists(path.join(root, 'dist', 'assets', 'code-graph', 'manifest.json'))) {
      yield* validateCodeGraphAssets(fs, path, path.join(root, 'dist', 'assets', 'code-graph'), failures);
    }
    if (yield* fs.exists(releaseMetadata)) {
      const metadata = yield* parseJsonFile(fs, releaseMetadata);
      if (
        !isRecord(metadata) ||
        !isRecord(metadata.codeGraphAssets) ||
        metadata.codeGraphAssets.manifest !== 'assets/code-graph/manifest.json' ||
        metadata.codeGraphAssets.version !== 1
      ) {
        failures.push('dist/release.json does not declare the verified code graph asset manifest');
      }
    }
  }

  if (failures.length > 0) {
    return yield* ScriptError.make({message: failures.map(failure => `- ${failure}`).join('\n')});
  }
  yield* Console.log('Self-contained Bun source and release checks passed.');
});

const sourceFiles = Effect.fn('checkSelfContained.sourceFiles')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
): Effect.fn.Return<readonly string[]> {
  const output: string[] = [];
  for (const name of yield* fs.readDirectory(directory)) {
    const file = path.join(directory, name);
    const info = yield* fs.stat(file);
    if (info.type === 'Directory') {
      output.push(...(yield* sourceFiles(fs, path, file)));
    } else if (info.type === 'File' && /\.(?:[cm]?js|tsx?)$/.test(name)) {
      output.push(file);
    }
  }
  return output;
});

const validateCursorPlugin = Effect.fn('checkSelfContained.validateCursorPlugin')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  failures: string[],
) {
  const instructions = normalizeNewlines(
    yield* fs.readFileString(path.join(root, 'config', 'agent-instructions.md')),
  ).trim();
  const rule = yield* fs.readFileString(path.join(root, 'cursor-plugin', 'rules', 'threadnote.mdc'));
  if (!/^---\r?\n[\s\S]*?^description:\s*\S.+$[\s\S]*?^alwaysApply:\s*true\s*$[\s\S]*?^---$/m.test(rule)) {
    failures.push('Cursor plugin rule must have a description and alwaysApply: true MDC frontmatter');
  }
  const expectedBlock = [
    '<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->',
    instructions,
    '<!-- END THREADNOTE USER INSTRUCTIONS -->',
  ].join('\n');
  if (!normalizeNewlines(rule).includes(expectedBlock)) {
    failures.push('Cursor plugin rule is out of sync with config/agent-instructions.md');
  }
});

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/');
}

function normalizeNewlines(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

const validateCodeGraphAssets = Effect.fn('checkSelfContained.validateCodeGraphAssets')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  failures: string[],
  packageRoot?: string,
) {
  const manifestPath = path.join(root, 'manifest.json');
  if (!(yield* fs.exists(manifestPath))) {
    failures.push(`code graph asset manifest is missing: ${manifestPath}`);
    return;
  }
  const manifest = yield* parseJsonFile(fs, manifestPath);
  if (!isRecord(manifest) || manifest.version !== 1 || !isRecord(manifest.runtime) || !isRecord(manifest.grammars)) {
    failures.push(`code graph asset manifest is invalid: ${manifestPath}`);
    return;
  }
  const expected = [
    {id: 'web-tree-sitter', metadata: manifest.runtime, runtime: true},
    ...Object.entries(manifest.grammars)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, metadata]) => ({id, metadata, runtime: false})),
  ];
  for (const asset of expected) {
    if (
      !isRecord(asset.metadata) ||
      typeof asset.metadata.path !== 'string' ||
      typeof asset.metadata.version !== 'string' ||
      typeof asset.metadata.source !== 'string' ||
      !asset.metadata.source.startsWith('https://github.com/') ||
      typeof asset.metadata.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(asset.metadata.sha256) ||
      (!asset.runtime && (!Number.isInteger(asset.metadata.abi) || Number(asset.metadata.abi) <= 0))
    ) {
      failures.push(`code graph asset metadata is invalid for ${asset.id}`);
      continue;
    }
    const assetPath = path.join(root, ...asset.metadata.path.split('/'));
    const packagePath =
      !asset.runtime && packageRoot !== undefined && typeof asset.metadata.packagePath === 'string'
        ? path.join(packageRoot, ...asset.metadata.packagePath.split('/'))
        : undefined;
    const verifiablePath = (yield* fs.exists(assetPath)) ? assetPath : packagePath;
    if (verifiablePath === undefined || !(yield* fs.exists(verifiablePath))) {
      failures.push(`code graph asset is missing: ${asset.metadata.path}`);
      continue;
    }
    if ((yield* sha256FileHex(verifiablePath)) !== asset.metadata.sha256) {
      failures.push(`code graph asset checksum does not match: ${asset.metadata.path}`);
    }
    if (!asset.runtime) {
      if (typeof asset.metadata.license !== 'string') {
        failures.push(`code graph asset license metadata is missing for ${asset.id}`);
      } else {
        const bundledLicense = path.join(root, ...asset.metadata.license.split('/'));
        const packageLicense =
          packageRoot !== undefined && typeof asset.metadata.licensePackagePath === 'string'
            ? path.join(packageRoot, ...asset.metadata.licensePackagePath.split('/'))
            : undefined;
        const licensePath = (yield* fs.exists(bundledLicense)) ? bundledLicense : packageLicense;
        if (licensePath === undefined || !(yield* fs.exists(licensePath)) || (yield* fs.stat(licensePath)).size <= 0) {
          failures.push(`code graph asset license is missing: ${asset.metadata.license}`);
        }
      }
      if (typeof asset.metadata.builderLicense === 'string') {
        const builderLicense = path.join(root, ...asset.metadata.builderLicense.split('/'));
        if (!(yield* fs.exists(builderLicense)) || (yield* fs.stat(builderLicense)).size <= 0) {
          failures.push(`code graph asset builder license is missing: ${asset.metadata.builderLicense}`);
        }
      }
    }
  }
  const runtimeLicense = path.join(root, 'licenses', 'web-tree-sitter.LICENSE');
  if (!(yield* fs.exists(runtimeLicense)) || (yield* fs.stat(runtimeLicense)).size <= 0) {
    failures.push('code graph asset license is missing: licenses/web-tree-sitter.LICENSE');
  }
});

function parseJsonFile(fs: FileSystem.FileSystem, path: string): Effect.Effect<unknown> {
  return fs.readFileString(path).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: cause => ScriptError.make({message: `Could not parse JSON file ${path}.`, cause}),
      }),
    ),
    Effect.orElseSucceed(() => undefined),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

BunRuntime.runMain(provideScriptLayer(checkSelfContained, BunServices.layer));
