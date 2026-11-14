import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {statSync} from '@threadnote/testing/node-fs';
import {builtinModules} from '@threadnote/testing/node-module';
import {dirname, join, relative} from '@threadnote/testing/node-path';
import {tmpdir} from '@threadnote/testing/node-os';
import {fileURLToPath} from '@threadnote/testing/node-url';
import {describe, expect, it} from 'vitest';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import * as FC from 'fast-check';
import ts from 'typescript-compiler';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const sourceRoot = join(repoRoot, 'apps', 'threadnote', 'src');
const codeRoots = EffectArray.map(['scripts', 'tools', 'infra', 'packages', 'apps'], path => join(repoRoot, path));
const workspaceManifests = new Bun.Glob('{apps,packages}/*/package.json');

function runtimeSourceRoots(manifestPaths: readonly string[]): readonly string[] {
  return EffectArray.map(
    EffectArray.filter(
      manifestPaths,
      path =>
        workspaceManifests.match(path) &&
        path !== 'apps/website/package.json' &&
        path !== 'packages/testing/package.json',
    ),
    path => join(repoRoot, dirname(path), 'src'),
  ).sort();
}

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

const forbiddenConsoleMethods = ['debug', 'error', 'info', 'log', 'warn'] as const;
type ForbiddenConsoleMethod = (typeof forbiddenConsoleMethods)[number];

function scriptKindForPath(path: string): ts.ScriptKind {
  if (Effect.pipe(path, EffectString.endsWith('.tsx'))) return ts.ScriptKind.TSX;
  if (Effect.pipe(path, EffectString.endsWith('.jsx'))) return ts.ScriptKind.JSX;
  if (
    Effect.pipe(path, EffectString.endsWith('.js')) ||
    Effect.pipe(path, EffectString.endsWith('.mjs')) ||
    Effect.pipe(path, EffectString.endsWith('.cjs'))
  )
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isForbiddenConsoleMethod(method: string): method is ForbiddenConsoleMethod {
  return method === 'debug' || method === 'error' || method === 'info' || method === 'log' || method === 'warn';
}

function inertTemplateText(value: string): string {
  return Effect.pipe(
    value,
    EffectString.replaceAll('\\', '\\\\'),
    EffectString.replaceAll('`', '\\`'),
    EffectString.replaceAll('${', '\\${'),
  );
}

function inertCommentText(value: string): string {
  return Effect.pipe(
    JSON.stringify(value),
    EffectString.slice(1, -1),
    EffectString.replaceAll('*/', '*\\/'),
    EffectString.replaceAll('\u2028', '\\u2028'),
    EffectString.replaceAll('\u2029', '\\u2029'),
  );
}

function rawConsoleCalls(
  source: string,
  path = 'source.ts',
): readonly {method: ForbiddenConsoleMethod; position: number}[] | undefined {
  let calls: readonly {method: ForbiddenConsoleMethod; position: number}[] | undefined;
  try {
    const parsed = ts.transpileModule(source, {
      fileName: Effect.pipe(path, EffectString.endsWith('.d.ts'))
        ? `${Effect.pipe(path, EffectString.slice(0, -5))}.ts`
        : path,
      reportDiagnostics: true,
      compilerOptions: {jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest},
      transformers: {
        before: [
          () => file => {
            // Inspect the original parsed tree before emit erases types or rewrites calls.
            calls = consoleCallsInFile(file);
            return file;
          },
        ],
      },
    });
    if (
      parsed.diagnostics &&
      EffectArray.some(parsed.diagnostics, diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    )
      return undefined;
  } catch {
    return undefined;
  }

  return calls;
}

function consoleCallsInFile(file: ts.SourceFile): readonly {method: ForbiddenConsoleMethod; position: number}[] {
  const calls: {method: ForbiddenConsoleMethod; position: number}[] = [];
  const unwrap = (expression: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)
      ? unwrap(expression.expression)
      : expression;
  const propertyName = (expression: ts.Expression): string | undefined => {
    const node = unwrap(expression);
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression)
    )
      return node.argumentExpression.text;
    return undefined;
  };
  const hasConsoleReceiver = (expression: ts.Expression): boolean => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return node.text === 'console';
    if (ts.isPropertyAccessExpression(node)) return node.name.text === 'console' || hasConsoleReceiver(node.expression);
    if (ts.isElementAccessExpression(node))
      return propertyName(node) === 'console' || hasConsoleReceiver(node.expression);
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        hasConsoleReceiver(callee.expression)
      ) {
        const method = propertyName(callee);
        if (method && isForbiddenConsoleMethod(method)) {
          calls.push({method, position: node.getStart(file)});
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

const sourceFiles = async () => {
  // Workspace manifests are authoritative; retired or generated directories are not workspaces.
  const roots = runtimeSourceRoots([...workspaceManifests.scanSync(repoRoot)]);
  return EffectArray.filter(
    (await Promise.all(EffectArray.map(roots, root => codeFiles(root)))).flat(),
    path => !Effect.pipe(relative(repoRoot, path), EffectString.split(/[\\/]/)).includes('test'),
  );
};

async function packageSourceRoots(packagesRoot: string): Promise<readonly string[]> {
  const packageDirectories = EffectArrayPipe(await readdir(packagesRoot, {withFileTypes: true}), __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (__effectArrayValue, __effectArrayIndex) =>
        (__effectArrayIndex in __effectArrayValues &&
          __effectArrayValue.isDirectory() &&
          __effectArrayValue.name !== 'testing' &&
          statSync(join(packagesRoot, __effectArrayValue.name, 'package.json'), {throwIfNoEntry: false})?.isFile()) ??
        false,
    ),
  );
  return EffectArray.map(packageDirectories, entry => join(packagesRoot, entry.name, 'src'));
}

async function scanSourceFiles(appSourceRoot: string, packagesRoot: string): Promise<readonly string[]> {
  const packageRoots = await packageSourceRoots(packagesRoot);
  return (await Promise.all([codeFiles(appSourceRoot), ...EffectArray.map(packageRoots, codeFiles)])).flat();
}

const nodeBuiltinModules = new Set(
  EffectArray.map(
    EffectArray.filter(builtinModules, module => !Effect.pipe(module, EffectString.startsWith('bun:'))),
    module => Effect.pipe(module, EffectString.replace(/^node:/, '')),
  ),
);
const moduleSpecifierScanners = {
  js: new Bun.Transpiler({loader: 'js', logLevel: 'error'}),
  jsx: new Bun.Transpiler({loader: 'jsx', logLevel: 'error', tsconfig: {compilerOptions: {jsx: 'react'}}}),
  ts: new Bun.Transpiler({loader: 'ts', logLevel: 'error'}),
  tsx: new Bun.Transpiler({loader: 'tsx', logLevel: 'error', tsconfig: {compilerOptions: {jsx: 'react'}}}),
};

function importedModuleSpecifiers(path: string, source: string): readonly string[] {
  const loader = Effect.pipe(path, EffectString.endsWith('.tsx'))
    ? 'tsx'
    : Effect.pipe(path, EffectString.endsWith('.ts'))
      ? 'ts'
      : Effect.pipe(path, EffectString.endsWith('.jsx'))
        ? 'jsx'
        : 'js';
  return EffectArray.map(moduleSpecifierScanners[loader].scanImports(source), imported => imported.path);
}

function isNodeBuiltinSpecifier(specifier: string): boolean {
  if (Effect.pipe(specifier, EffectString.startsWith('node:'))) return true;
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  const root = specifier.split('/', 1)[0];
  return nodeBuiltinModules.has(specifier) || nodeBuiltinModules.has(root);
}

describe('Effect architecture boundaries', () => {
  it('finds raw console calls in syntax rather than inert source text', () => {
    const inert = EffectArray.join(
      [
        'const text = "console.info(\\\"fixture\\\")";',
        'const text = `console.log(1)`;',
        '// console.warn(1)\n/* console.error(1) */',
        'const pattern = /console.info\\(\\)/u;',
        'const nested = "\\\'/* `console.log(1)` */\\\'";',
      ],
      '\n',
    );
    expect(rawConsoleCalls(inert)).toEqual([]);
    for (const method of forbiddenConsoleMethods) {
      expect(rawConsoleCalls(`function run() { if (true) console.${method}("sentinel"); }`)).toEqual([
        expect.objectContaining({method}),
      ]);
    }
    expect(rawConsoleCalls('const value = `data ${console.info("interpolation")} tail`;')).toHaveLength(1);
    expect(rawConsoleCalls('globalThis.console.log(1);')).toHaveLength(1);
    expect(rawConsoleCalls('console?.warn?.(1);')).toHaveLength(1);
    expect(rawConsoleCalls('(console["debug"])(1);')).toHaveLength(1);
    expect(rawConsoleCalls('const broken = ;')).toBeUndefined();
    expect(rawConsoleCalls('declare const node: JSX.Element;', 'fixture.d.ts')).toEqual([]);
    expect(rawConsoleCalls('const view = <div />;', 'fixture.tsx')).toEqual([]);
    for (const text of ['`', '*/', '${console.log(1)}', '"\\', '\u2028', '\u2029']) {
      const escapedComment = inertCommentText(text);
      const spelling = `console.info(${escapedComment})`;
      const inertSources = [
        `const data = \`${inertTemplateText(`console.info(${JSON.stringify(text)})`)}\`;`,
        `/* ${spelling} */`,
      ];
      for (const inertSource of inertSources) {
        const combined = `${inertSource}\nconsole.info(${JSON.stringify(text)});`;
        expect(EffectArray.map(rawConsoleCalls(combined) ?? [], call => call.method)).toEqual(['info']);
      }
    }
  });

  it('keeps inert console spellings independent from real calls across bounded generated syntax', () => {
    const methods = FC.constantFrom(...forbiddenConsoleMethods);
    const payload = FC.string({maxLength: 24});
    const dataContainer = FC.constantFrom('string', 'template', 'comment', 'regex');
    const callWrapper = FC.constantFrom('plain', 'nested', 'template');
    FC.assert(
      FC.property(methods, payload, dataContainer, callWrapper, (method, text, container, wrapper) => {
        const spelling = `console.${method}(${JSON.stringify(text)})`;
        const commentSpelling = `console.${method}(${inertCommentText(text)})`;
        const inert =
          container === 'string'
            ? `const data = ${JSON.stringify(spelling)};`
            : container === 'template'
              ? `const data = \`${inertTemplateText(spelling)}\`;`
              : container === 'comment'
                ? `/* ${commentSpelling} */`
                : `const data = /console\\.${method}\\(.*\\)/u;`;
        expect(rawConsoleCalls(inert)).toEqual([]);
        const actual =
          wrapper === 'nested'
            ? `function run() { if (true) ${spelling}; }`
            : wrapper === 'template'
              ? `const value = \`prefix \${${spelling}} suffix\`;`
              : `${spelling};`;
        const combined = `${inert}\n${actual}`;
        expect(EffectArray.map(rawConsoleCalls(combined) ?? [], call => call.method)).toEqual([method]);
        expect(combined).toContain(spelling);
      }),
      {numRuns: 32, seed: 424242},
    );
  });

  it('conserves the independent reparse oracle, diagnostics and original positions across source kinds', () => {
    // Keep the former parse boundary as the comparison oracle. The unchanged
    // walker isolates original-AST reuse from receiver classification behavior.
    const reparsed = (source: string, path: string) => {
      try {
        const parsed = ts.transpileModule(source, {
          fileName: EffectString.endsWith('.d.ts')(path) ? EffectString.slice(0, -5)(path) + '.ts' : path,
          reportDiagnostics: true,
          compilerOptions: {jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest},
        });
        if (
          EffectArray.some(parsed.diagnostics ?? [], diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
        )
          return undefined;
      } catch {
        return undefined;
      }
      return consoleCallsInFile(
        ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindForPath(path)),
      );
    };
    FC.assert(
      FC.property(
        FC.constantFrom('ts', 'tsx', 'd.ts', 'js', 'jsx', 'mjs', 'cjs'),
        FC.constantFrom(
          'console.info(1)',
          'globalThis.console["warn"](1)',
          'globalThis["console"]?.error?.(1)',
          '(console["debug"])(1)',
          'conso\\u006ce.log(1)',
          '(console as Console)!.log(1)',
        ),
        FC.string({maxLength: 24}),
        FC.boolean(),
        (extension, call, text, broken) => {
          const prefix = `const inert = ${JSON.stringify(text)};\n`;
          const source = prefix + call + (broken ? '; const invalid = ;' : ';');
          const path = 'fixture.' + extension;
          const before = source;
          expect(rawConsoleCalls(source, path)).toEqual(reparsed(source, path));
          if (!broken) {
            const calls = rawConsoleCalls(source, path);
            if (calls !== undefined)
              expect(calls).toEqual([
                {method: /(?:info|warn|error|debug|log)/u.exec(call)![0], position: prefix.length},
              ]);
          } else expect(rawConsoleCalls(source, path)).toBeUndefined();
          expect(source).toBe(before);
        },
      ),
      {numRuns: 40, seed: 424243},
    );
  });

  it('covers every declared runtime workspace without treating artifacts, tests, or the website as runtime roots', () => {
    FC.assert(
      FC.property(FC.uniqueArray(FC.nat(1000), {maxLength: 12}), names => {
        const packages = EffectArray.map(names, name => `packages/runtime-${name}`);
        const applications = EffectArray.map(names, name => `apps/runtime-${name}`);
        const runtimeDirectories = ['apps/threadnote', 'packages/inference', ...packages, ...applications];
        const manifests = EffectArray.map(runtimeDirectories, directory => `${directory}/package.json`);
        expect(
          runtimeSourceRoots([
            ...manifests,
            'apps/website/package.json',
            'packages/testing/package.json',
            'packages/semantic',
            'packages/semantic/src',
            'packages/recall/test/fixture/package.json',
            'apps/threadnote/test/fixture/package.json',
            'artifacts/runtime/package.json',
          ]),
        ).toEqual(EffectArray.map(runtimeDirectories, directory => join(repoRoot, directory, 'src')).sort());
      }),
      {numRuns: 32},
    );
  });

  it('scans workspace packages, ignores empty leftovers, and fails for a package without src', async () => {
    const root = await mkdtemp(join(tmpdir(), 'effect-architecture-scan-'));
    const appSource = join(root, 'app', 'src');
    const packagesRoot = join(root, 'packages');
    const packageRoot = join(packagesRoot, 'valid');
    const leftoverRoot = join(packagesRoot, 'leftover');
    const missingSourceRoot = join(packagesRoot, 'broken');

    try {
      await mkdir(appSource, {recursive: true});
      await mkdir(join(packageRoot, 'src'), {recursive: true});
      await mkdir(leftoverRoot, {recursive: true});
      await writeFile(join(appSource, 'app.ts'), 'export {};');
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({name: 'valid'}));
      await writeFile(join(packageRoot, 'src', 'index.ts'), 'export {};');

      expect([...(await scanSourceFiles(appSource, packagesRoot))].sort()).toEqual(
        [join(appSource, 'app.ts'), join(packageRoot, 'src', 'index.ts')].sort(),
      );

      await mkdir(missingSourceRoot, {recursive: true});
      await writeFile(join(missingSourceRoot, 'package.json'), JSON.stringify({name: 'broken'}));
      await expect(scanSourceFiles(appSource, packagesRoot)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
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

  it('confines Node built-in imports to the declared stdio boundary', async () => {
    const importShapes = EffectArray.join(
      [
        "import '../helpers/node-fs.js';",
        "import {readFile} from 'fs/promises';",
        "export {join} from '../helpers/node-path.js';",
        "void import('../helpers/node-url.js');",
        "const os = require('os');",
        "import fs = require('fs');",
        "import external from 'external-package';",
        "const ignored = `require('fs') ${`nested ${value}`}`;",
        "import '../helpers/node-crypto.js';",
      ],
      '\n',
    );
    expect(
      EffectArrayPipe(importedModuleSpecifiers('builtin-shapes.ts', importShapes), __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (__effectArrayValue, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues && isNodeBuiltinSpecifier(__effectArrayValue),
        ),
      ),
    ).toEqual(['fs/promises', 'os', 'fs']);

    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      const relativePath = Effect.pipe(relative(repoRoot, path), EffectString.replaceAll('\\', '/'));
      expect(
        EffectArrayPipe(importedModuleSpecifiers(path, source), __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (__effectArrayValue, __effectArrayIndex) =>
              __effectArrayIndex in __effectArrayValues && isNodeBuiltinSpecifier(__effectArrayValue),
          ),
        ),
        relativePath,
      ).toEqual([]);
    }
  });

  it('keeps Bun structural built-ins inside the exact SystemInfo adapters', async () => {
    const accesses: {module: string; path: string}[] = [];
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      const relativePath = relative(repoRoot, path);
      const mentions =
        Effect.pipe(
          source,
          EffectString.match(/\bgetBuiltinModule\b/g),
          Effect.Option.getOrElse(() => null),
        )?.length ?? 0;
      expect(mentions, relativePath).toBe(relativePath === 'packages/platform/src/system.ts' ? 4 : 0);
      const calls = [
        ...Effect.pipe(source, EffectString.matchAll(/process\.getBuiltinModule\(\s*['"]([^'"]+)['"]\s*\)/g)),
      ];
      accesses.push(...EffectArray.map(calls, match => ({module: match[1], path: relativePath})));
    }
    expect(accesses).toEqual([
      {module: 'os', path: 'packages/platform/src/system.ts'},
      {module: 'fs', path: 'packages/platform/src/system.ts'},
      {module: 'path', path: 'packages/platform/src/system.ts'},
      {module: 'util', path: 'packages/platform/src/system.ts'},
    ]);

    const system = await readFile(join(repoRoot, 'packages', 'platform', 'src', 'system.ts'), 'utf8');
    const nativeStatfsStart = Effect.pipe(
      system,
      EffectString.indexOf('function nativeStatfs'),
      Effect.Option.getOrElse(() => -1),
    );
    const fallbackStart = Effect.pipe(
      system,
      EffectString.indexOf('export function legacyAvailableDiskBytes'),
      Effect.Option.getOrElse(() => -1),
    );
    const windowsWorkerAdapterStart = Effect.pipe(
      system,
      EffectString.indexOf('export interface WindowsDiskCapacityWorkerProcess'),
      Effect.Option.getOrElse(() => -1),
    );
    expect(nativeStatfsStart).toBeGreaterThanOrEqual(0);
    expect(fallbackStart).toBeGreaterThan(nativeStatfsStart);
    expect(windowsWorkerAdapterStart).toBeGreaterThan(fallbackStart);
    const nativeStatfs = Effect.pipe(system, EffectString.slice(nativeStatfsStart, fallbackStart));
    const fallback = Effect.pipe(system, EffectString.slice(fallbackStart, windowsWorkerAdapterStart));
    expect(nativeStatfs).toContain('Effect.tryPromise({');
    expect(nativeStatfs).toContain('nativeFileSystemPromises.statfs(path, {bigint: true})');
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

  it('keeps runtime globals inside declared adapters and exact semantic boundaries', async () => {
    const allowed = new Set([
      'apps/threadnote/src/effect/ai/isolated-local-model-runtime.ts',
      'apps/threadnote/src/effect/mcp_broker_process.ts',
      'packages/platform/src/system.ts',
      'apps/threadnote/src/standalone.ts',
      'apps/threadnote/src/recall/ready_read_entry.ts',
    ]);
    const semanticExpressions = new Map([
      // The POSIX transport/admission adapters own these process-group probes and signals.
      [
        'apps/threadnote/src/semantic/lsp_transport.ts',
        ["process.platform === 'win32'", 'process.kill(-child.pid, 0);', 'process.kill(-child!.pid!, signal);'],
      ],
      ['apps/threadnote/src/semantic/coordinator.ts', ['process.kill(-pid, 0);']],
      // Qualification requires the exact host OS/architecture before inspecting pinned SDKs.
      ['apps/threadnote/src/semantic/providers/java_runtime.ts', ['`${process.platform}-${process.arch}`']],
      // These expressions are inside the generated external Node metadata responder.
      [
        'apps/threadnote/src/semantic/providers/python_project.ts',
        [
          'const a=process.argv.slice(2), m=${JSON.stringify(metadata)};',
          'process.stdout.write(JSON.stringify(value));',
        ],
      ],
      // This expression is inside the generated external Node launcher attestation.
      [
        'apps/threadnote/src/semantic/providers/typescript_runtime.ts',
        ['pid: process.pid, instance, challenge: args.challenge, locked});'],
      ],
    ]);
    for (const path of await sourceFiles()) {
      const relativePath = Effect.pipe(relative(repoRoot, path), EffectString.replaceAll('\\', '/'));
      if (allowed.has(relativePath)) {
        continue;
      }
      let source = await readFile(path, 'utf8');
      for (const expression of semanticExpressions.get(relativePath) ?? [])
        source = Effect.pipe(source, EffectString.replace(expression, ''));
      expect(source, relativePath).not.toMatch(
        /(?<![$\w])process\.(?:argv|cwd|env|execPath|exitCode|getuid|kill|pid|platform|stdin|stdout)/,
      );
    }
  });

  it('routes console output through the Effect Console service', async () => {
    for (const root of codeRoots) {
      for (const path of await codeFiles(root)) {
        const source = await readFile(path, 'utf8');
        const calls = rawConsoleCalls(source, path);
        expect(calls, relative(repoRoot, path)).not.toBeUndefined();
        expect(calls, relative(repoRoot, path)).toEqual([]);
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
    const browserRuntimeSource = Effect.pipe(
      contextView,
      EffectString.replace(/import\s+type\s+[^;]+\s+from\s+['"]\.\.\/context\.js['"];\n?/u, ''),
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
