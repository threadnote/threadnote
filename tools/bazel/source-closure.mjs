import {Array as EffectArray} from 'effect';
import * as ts from 'typescript/ast';
import {builtinModules} from 'node:module';
import {posix} from 'node:path';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const builtins = new Set(builtinModules);
const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/u;

export async function sourceImports(session, path, content) {
  if (!sourceExtensions.test(path)) return [];
  return session.withSourceFile({fileName: path, text: content}, source => {
    const specifiers = new Set();
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.add(node.moduleSpecifier.text);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLikeNode(argument)) specifiers.add(argument.text);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        if (ts.isStringLiteral(node.argument.literal)) specifiers.add(node.argument.literal.text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        specifiers.add(node.moduleReference.expression.text);
      }
      node.forEachChild(visit);
    };
    visit(source);
    return [...specifiers].sort();
  });
}

/**
 * A supplied graph is a cache for one fixed source snapshot, workspace map,
 * virtual/host-module declarations and import reader. Reuse it only within that model; create
 * a fresh Map when any resolver input changes.
 * @param {import('../workspace/typescript-syntax.ts').TypeScriptSyntaxSession} session
 * @param {ReadonlyArray<string>} entries
 * @param {{
 *   read: (path: string) => string,
 *   exists: (path: string) => boolean,
 *   workspaces: ReadonlyMap<string, {path: string, manifest: {exports?: Record<string, unknown>}}>,
 *   virtualModules?: ReadonlyArray<string>,
 *   hostModules?: Readonly<Record<string, ReadonlyArray<string>>>,
 *   imports?: (path: string, content: string) => ReadonlyArray<string> | Promise<ReadonlyArray<string>>,
 *   graph?: Map<string, {files: string[], npm: string[]}>
 * }} options
 */
export async function collectSourceClosure(
  session,
  entries,
  {
    read,
    exists,
    workspaces,
    virtualModules = [],
    hostModules = {},
    imports = (path, content) => sourceImports(session, path, content),
    graph,
  },
) {
  const files = new Set();
  const npm = new Set();
  const pending = EffectArray.map(entries, path => ({path, resolved: graph?.has(path) ?? false}));
  const resolveFile = path => {
    const normalized = posix.normalize(path);
    if (Effect.pipe(normalized, EffectString.startsWith('../')) || posix.isAbsolute(normalized))
      throw new Error(`Import escapes repository: ${path}`);
    const candidates = [normalized];
    if (/\.[cm]?jsx?$/u.test(normalized))
      candidates.push(
        Effect.pipe(normalized, EffectString.replace(/\.[cm]?jsx?$/u, '.ts')),
        Effect.pipe(normalized, EffectString.replace(/\.jsx?$/u, '.tsx')),
      );
    if (!posix.extname(normalized))
      candidates.push(
        ...EffectArray.map(
          ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx', '/index.js'],
          suffix => normalized + suffix,
        ),
      );
    const found = EffectOption.getOrUndefined(EffectArray.findFirst(candidates, exists));
    if (!found) throw new Error(`Unresolved source input: ${path}`);
    return found;
  };
  while (pending.length) {
    const input = pending.pop();
    const path = input.resolved ? input.path : resolveFile(input.path);
    if (files.has(path)) continue;
    files.add(path);
    const cached = graph?.get(path);
    if (cached) {
      for (const child of cached.files) pending.push({path: child, resolved: true});
      for (const name of cached.npm) npm.add(name);
      continue;
    }
    const directFiles = new Set();
    const directNpm = new Set();
    const enqueue = destination => {
      const resolved = graph?.has(destination) ? destination : resolveFile(destination);
      directFiles.add(resolved);
      pending.push({path: resolved, resolved: graph !== undefined});
    };
    for (const specifier of sourceExtensions.test(path) ? await imports(path, read(path)) : []) {
      if (
        Effect.pipe(specifier, EffectString.startsWith('node:')) ||
        Effect.pipe(specifier, EffectString.startsWith('bun:')) ||
        builtins.has(specifier) ||
        virtualModules.includes(specifier) ||
        hostModules[path]?.includes(specifier)
      )
        continue;
      const clean = Effect.pipe(specifier, EffectString.split('?'))[0];
      if (Effect.pipe(clean, EffectString.startsWith('.'))) {
        enqueue(posix.join(posix.dirname(path), clean));
        continue;
      }
      const name = Effect.pipe(clean, EffectString.startsWith('@'))
        ? EffectArray.join(Effect.pipe(clean, EffectString.split('/')).slice(0, 2), '/')
        : Effect.pipe(clean, EffectString.split('/'))[0];
      const workspace = workspaces.get(name);
      if (!workspace) {
        npm.add(name);
        directNpm.add(name);
        continue;
      }
      const subpath = clean === name ? '.' : `.${Effect.pipe(clean, EffectString.slice(name.length))}`;
      const destination = workspace.manifest.exports?.[subpath];
      if (typeof destination !== 'string') throw new Error(`Unsupported or missing workspace export ${specifier}`);
      enqueue(posix.join(workspace.path, destination));
      enqueue(`${workspace.path}/package.json`);
    }
    graph?.set(path, {files: [...directFiles].sort(), npm: [...directNpm].sort()});
  }
  return {files: [...files].sort(), npm: [...npm].sort()};
}
