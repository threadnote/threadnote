import ts from 'typescript-compiler';
import {builtinModules} from 'node:module';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Build declaration generation precedes the Effect dependency graph.
import {posix} from 'node:path';

const builtins = new Set(builtinModules);
const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/u;

export function sourceImports(path, content) {
  if (!sourceExtensions.test(path)) return [];
  const specifiers = ts.preProcessFile(content, true, true).importedFiles.map(item => item.fileName);
  // TypeScript's preprocessor omits namespace re-exports. Read these from the
  // syntax tree while retaining its established import/dynamic-import behavior.
  let namespaceExport = false;
  if (content.includes('export') && content.includes('*')) {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, content);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.ExportKeyword && scanner.scan() === ts.SyntaxKind.AsteriskToken) {
        namespaceExport = true;
        break;
      }
    }
  }
  if (namespaceExport) {
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, false);
    for (const statement of source.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
        specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return [...new Set(specifiers)].sort();
}

/**
 * A supplied graph is a cache for one fixed source snapshot, workspace map,
 * virtual-module set and import reader. Reuse it only within that model; create
 * a fresh Map when any resolver input changes.
 * @param {ReadonlyArray<string>} entries
 * @param {{
 *   read: (path: string) => string,
 *   exists: (path: string) => boolean,
 *   workspaces: ReadonlyMap<string, {path: string, manifest: {exports?: Record<string, unknown>}}>,
 *   virtualModules?: ReadonlyArray<string>,
 *   imports?: (path: string, content: string) => ReadonlyArray<string>,
 *   graph?: Map<string, {files: string[], npm: string[]}>
 * }} options
 */
export function collectSourceClosure(
  entries,
  {read, exists, workspaces, virtualModules = [], imports = sourceImports, graph},
) {
  const files = new Set();
  const npm = new Set();
  const pending = entries.map(path => ({path, resolved: graph?.has(path) ?? false}));
  const resolveFile = path => {
    const normalized = posix.normalize(path);
    if (normalized.startsWith('../') || posix.isAbsolute(normalized))
      throw new Error(`Import escapes repository: ${path}`);
    const candidates = [normalized];
    if (/\.[cm]?jsx?$/u.test(normalized))
      candidates.push(normalized.replace(/\.[cm]?jsx?$/u, '.ts'), normalized.replace(/\.jsx?$/u, '.tsx'));
    if (!posix.extname(normalized))
      candidates.push(
        ...['.ts', '.tsx', '.js', '/index.ts', '/index.tsx', '/index.js'].map(suffix => normalized + suffix),
      );
    const found = candidates.find(exists);
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
    for (const specifier of sourceExtensions.test(path) ? imports(path, read(path)) : []) {
      if (
        specifier.startsWith('node:') ||
        specifier.startsWith('bun:') ||
        builtins.has(specifier) ||
        virtualModules.includes(specifier)
      )
        continue;
      const clean = specifier.split('?')[0];
      if (clean.startsWith('.')) {
        enqueue(posix.join(posix.dirname(path), clean));
        continue;
      }
      const name = clean.startsWith('@') ? clean.split('/').slice(0, 2).join('/') : clean.split('/')[0];
      const workspace = workspaces.get(name);
      if (!workspace) {
        npm.add(name);
        directNpm.add(name);
        continue;
      }
      const subpath = clean === name ? '.' : `.${clean.slice(name.length)}`;
      const destination = workspace.manifest.exports?.[subpath];
      if (typeof destination !== 'string') throw new Error(`Unsupported or missing workspace export ${specifier}`);
      enqueue(posix.join(workspace.path, destination));
      enqueue(`${workspace.path}/package.json`);
    }
    graph?.set(path, {files: [...directFiles].sort(), npm: [...directNpm].sort()});
  }
  return {files: [...files].sort(), npm: [...npm].sort()};
}
