import ts from 'typescript-compiler';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
const PYTHON_METADATA_SOURCES = new Set([
  'apps/threadnote/src/migration/legacy-installations.ts',
  'packages/graph/src/languages/catalog.generated.ts',
  'packages/graph/src/languages/generic/definitions.ts',
  'packages/graph/src/languages/tree_sitter_assets.ts',
  'packages/manager/src/memory_editor_languages.ts',
]);
const SEMANTIC_PYTHON_CATALOG_SOURCE = 'apps/threadnote/src/effect/semantic_cli.ts';
const SEMANTIC_PYTHON_HOST_CATALOG_SOURCE = 'apps/threadnote/src/semantic/host_catalog.ts';
const SEMANTIC_PYTHON_METADATA_SOURCES = new Set([
  SEMANTIC_PYTHON_CATALOG_SOURCE,
  SEMANTIC_PYTHON_HOST_CATALOG_SOURCE,
  'apps/threadnote/src/semantic/doctor.ts',
  'apps/threadnote/src/semantic/coordinator.ts',
  'apps/threadnote/src/semantic/provider.ts',
  'apps/threadnote/src/semantic/providers/python.ts',
  'apps/threadnote/src/semantic/providers/python_project.ts',
]);
const PYTHON_PROJECT_SOURCE = 'apps/threadnote/src/semantic/providers/python_project.ts';
const PYTHON_CAPSULE_SHA256 = '7741971d0fcd1dcf7944ddb2dc24346f874f6d7b3e1a58c871baf666fb8d9764';
const PYTHON_IMPORTS = new Set([
  "import {Digest as EffectDigest} from 'effect/crypto';",
  "import {isJsonObject} from '@threadnote/platform/json';",
  "import {sha256HexSync} from '@threadnote/platform/sha256';",
  "import {runtimeCurrentPlatform} from '@threadnote/platform/system';",
  "import * as EffectArray from 'effect/Array';",
  "import * as EffectRecord from 'effect/Record';",
  "import * as EffectString from 'effect/String';",
  "import {Effect, FileSystem, Option, Path, Schema} from 'effect';",
  "import {parse as parseJsonc, type ParseError} from 'jsonc-parser';",
  "import {parse as parseToml} from 'smol-toml';",
  "import {Digest, Identifier} from '@threadnote/semantic/contracts';",
  "import {boundedFileDigest, readBoundedText, semanticTreeDigest} from '../fingerprint.js';",
  "import {LspFault} from '../lsp_transport.js';",
]);

/** One reviewed generated program, not an exception for arbitrary code in this module. */
function pythonResidualSource(source: string): string | undefined {
  const parsed = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext},
  });
  if (parsed.diagnostics && EffectArray.some(parsed.diagnostics, item => item.category === ts.DiagnosticCategory.Error))
    return undefined;
  const file = ts.createSourceFile(PYTHON_PROJECT_SOURCE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const variables: ts.VariableDeclaration[] = [],
    functions: ts.FunctionDeclaration[] = [],
    calls: ts.CallExpression[] = [],
    runtimeArguments: ts.PropertyAssignment[] = [];
  let invalid = false;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.push(node);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'pythonProviderBootstrap') functions.push(node);
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'runtimeArguments') runtimeArguments.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const named = (name: string) =>
    EffectArray.filter(variables, node => ts.isIdentifier(node.name) && node.name.text === name);
  const path = named('pathProbe'),
    version = named('versionProbe');
  if (path.length !== 1 || version.length !== 1 || functions.length !== 1) return undefined;
  const pathStatement = path[0].parent.parent,
    versionStatement = version[0].parent.parent,
    generator = functions[0];
  const position = EffectOption.getOrElse(
    EffectArray.findFirstIndex(file.statements, statement => statement === pathStatement),
    () => -1,
  );
  if (
    !ts.isVariableStatement(pathStatement) ||
    !ts.isVariableStatement(versionStatement) ||
    position < 0 ||
    file.statements[position + 1] !== versionStatement ||
    file.statements[position + 2] !== generator ||
    !(path[0].parent.flags & ts.NodeFlags.Const) ||
    !(version[0].parent.flags & ts.NodeFlags.Const)
  )
    return undefined;
  // AST .end excludes the final newline; CRLF was normalized once by the caller.
  const start = pathStatement.getStart(file),
    end = generator.end;
  if (sha256HexSync(EffectString.slice(start, end)(source)) !== PYTHON_CAPSULE_SHA256) return undefined;
  const make = named('makePythonProject');
  if (make.length !== 1 || !make[0].initializer || !ts.isCallExpression(make[0].initializer)) return undefined;
  const makeStatement = make[0].parent.parent;
  if (
    !ts.isVariableStatement(makeStatement) ||
    makeStatement.parent !== file ||
    !(make[0].parent.flags & ts.NodeFlags.Const) ||
    !EffectArray.some(makeStatement.modifiers ?? [], modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    make[0].initializer.expression.getText(file) !== "Effect.fn('semantic.makePythonProject')" ||
    make[0].initializer.arguments.length !== 1
  )
    return undefined;
  const program = make[0].initializer.arguments[0];
  if (
    !program ||
    !ts.isFunctionExpression(program) ||
    !program.asteriskToken ||
    !program.body ||
    program.parameters.length !== 1 ||
    program.parameters[0].name.getText(file) !== 'options'
  )
    return undefined;
  const generated = named('source'),
    payload = named('payload');
  if (
    generated.length !== 1 ||
    payload.length !== 1 ||
    !generated[0].initializer ||
    !payload[0].initializer ||
    payload[0].initializer.getText(file) !== '{path: roots, prefix: metadata.prefix, version: metadata.version}'
  )
    return undefined;
  const directConst = (node: ts.VariableDeclaration) =>
    ts.isVariableStatement(node.parent.parent) &&
    node.parent.parent.parent === program.body &&
    !!(node.parent.flags & ts.NodeFlags.Const);
  if (!directConst(generated[0]) || !directConst(payload[0])) return undefined;
  const generation = EffectArray.filter(calls, node => node.expression.getText(file) === 'pythonProviderBootstrap');
  if (
    generation.length !== 1 ||
    generation[0] !== generated[0].initializer ||
    generation[0].getText(file) !== 'pythonProviderBootstrap(payload, launcher, directory)'
  )
    return undefined;
  const publications = EffectArray.filter(
    calls,
    node => ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'writeFileString',
  );
  if (
    publications.length !== 1 ||
    publications[0].getText(file) !== "fs.writeFileString(bootstrap, source, {flag: 'wx', mode: 0o600})" ||
    !ts.isYieldExpression(publications[0].parent) ||
    !ts.isExpressionStatement(publications[0].parent.parent) ||
    publications[0].parent.parent.parent !== program.body
  )
    return undefined;
  if (
    runtimeArguments.length !== 1 ||
    runtimeArguments[0].initializer.getText(file) !== "['--require', bootstrap]" ||
    !ts.isObjectLiteralExpression(runtimeArguments[0].parent) ||
    !ts.isReturnStatement(runtimeArguments[0].parent.parent) ||
    runtimeArguments[0].parent.parent.parent !== program.body
  )
    return undefined;
  const statementPosition = (node: ts.Node) =>
    EffectOption.getOrElse(
      EffectArray.findFirstIndex(program.body.statements, statement => statement === node),
      () => -1,
    );
  const sourcePosition = statementPosition(generated[0].parent.parent),
    publicationPosition = statementPosition(publications[0].parent.parent),
    returnPosition = statementPosition(runtimeArguments[0].parent.parent);
  if (sourcePosition < 0 || publicationPosition <= sourcePosition || returnPosition <= publicationPosition)
    return undefined;
  const concreteName = (expression: ts.Expression): string | undefined => {
    if (ts.isParenthesizedExpression(expression)) return concreteName(expression.expression);
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) {
      const parent = concreteName(expression.expression);
      return parent === undefined ? undefined : parent + '.' + expression.name.text;
    }
    return undefined;
  };
  const checkResidual = (node: ts.Node): void => {
    if (node.pos >= start && node.end <= end) return;
    if (ts.isImportDeclaration(node) && !PYTHON_IMPORTS.has(node.getText(file))) invalid = true;
    // Close only the reviewed generator/JSON dependencies. No alternative binding or alias is admitted.
    if (ts.isIdentifier(node)) {
      if (node.text === 'pythonProviderBootstrap' && node !== generator.name && node !== generation[0].expression)
        invalid = true;
      // This closed owner has no global-object dependency outside the pinned capsule.
      // Reject aliases as well as direct replacement of its JSON intrinsic.
      if (['globalThis', 'global', 'self', 'window'].includes(node.text)) invalid = true;
      if (node.text === 'makePythonProject' && node !== make[0].name) invalid = true;
      if (node.text === 'pathProbe' || node.text === 'versionProbe') invalid = true;
      if (node.text === 'JSON') {
        const member = node.parent;
        if (
          !ts.isPropertyAccessExpression(member) ||
          member.expression !== node ||
          member.questionDotToken ||
          !['parse', 'stringify'].includes(member.name.text) ||
          !ts.isCallExpression(member.parent) ||
          member.parent.expression !== member ||
          member.parent.questionDotToken
        )
          invalid = true;
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
      const expression = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
      const name = concreteName(expression) ?? '';
      // Concrete declared negative forms only; this is not a JavaScript sandbox.
      if (
        expression.kind === ts.SyntaxKind.ImportKeyword ||
        [
          'require',
          'eval',
          'Function',
          'Bun.spawn',
          'Bun.spawnSync',
          'Bun.$',
          'globalThis.eval',
          'globalThis.Function',
        ].includes(name) ||
        EffectString.startsWith('process.')(name) ||
        EffectString.startsWith('globalThis.process.')(name) ||
        EffectString.startsWith('module.require')(name) ||
        EffectString.startsWith('require.')(name)
      )
        invalid = true;
    }
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      ['source', 'pythonProviderBootstrap', 'pathProbe', 'versionProbe'].includes(node.left.text) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      invalid = true;
    ts.forEachChild(node, checkResidual);
  };
  checkResidual(file);
  return invalid ? undefined : EffectString.slice(0, start)(source) + EffectString.slice(end)(source);
}

/** Only the exact reviewed Node preload is removed before checking residual runtime imports. */
export function hasUndeclaredNodeBuiltinImport(relativePath: string, content: string): boolean {
  let source = Effect.pipe(content, EffectString.replaceAll('\r\n', '\n'));
  if (relativePath === PYTHON_PROJECT_SOURCE) {
    const residual = pythonResidualSource(source);
    if (residual === undefined) return true;
    source = residual;
  }
  return /(?:from\s+['"]node:|import\s+['"]node:|import\s*\(\s*['"]node:|require\s*\(\s*['"]node:)/u.test(source);
}

// Retained ownership metadata permits explicit replacement of installed old packs.
// Native workflows must never probe or execute an interpreter.
const HISTORICAL_WORKFLOW_PREREQUISITES =
  "const historicalPrerequisites = {python: '>=3.10', commands: ['threadnote', 'git', 'rg'], prCommands: ['gh']};";
const HISTORICAL_WORKFLOW_DIAGNOSTIC =
  "'Retained Python workflow ownership is recognized. Explicitly update or repair these workflows before running them.'";

export function hasUndeclaredPythonRuntimeReference(relativePath: string, content: string): boolean {
  if (PYTHON_METADATA_SOURCES.has(relativePath)) return false;
  let source = Effect.pipe(content, EffectString.replaceAll('\r\n', '\n'));
  if (relativePath === PYTHON_PROJECT_SOURCE) {
    const residual = pythonResidualSource(source);
    if (residual === undefined) return true;
    source = residual;
  }
  if (SEMANTIC_PYTHON_METADATA_SOURCES.has(relativePath)) {
    // These modules describe a language served by pinned Node, not an interpreter dependency.
    // Consume only the existing protocol literals; added interpreter command literals still fail.
    source =
      relativePath === SEMANTIC_PYTHON_CATALOG_SOURCE
        ? EffectString.replace("languages: ['python']", '')(source)
        : relativePath === SEMANTIC_PYTHON_HOST_CATALOG_SOURCE
          ? EffectString.replace("slot: 'python'", '')(source)
          : Effect.pipe(
              source,
              EffectString.replaceAll(/\b(?:language|l)\s*===\s*'python'/gu, ''),
              EffectString.replaceAll(/\blanguage:\s*'python'/gu, ''),
              EffectString.replace("'candidate' | 'python' |", ''),
              EffectString.replace("  'python',", ''),
              EffectString.replace("'Experimental Python static-environment profile'", ''),
            );
    return /['"`][^'"`\r\n]*\bpython(?:\d+(?:\.\d+)*)?(?:\.exe)?(?=\s|['"`;&|<>])/iu.test(source);
  }
  if (relativePath === 'apps/threadnote/src/dev_skills/manifest.ts') {
    source = Effect.pipe(
      source,
      EffectString.replace(HISTORICAL_WORKFLOW_PREREQUISITES, ''),
      EffectString.replace(HISTORICAL_WORKFLOW_DIAGNOSTIC, ''),
    );
  }
  return /\bpython(?:\d+(?:\.\d+)*)?\b/i.test(source);
}
