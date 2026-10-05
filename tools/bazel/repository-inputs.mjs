/* oxlint-disable effecttsgo/node-builtin-import -- Input discovery runs before the declared Bazel graph exists. */
import ts from 'typescript-compiler';
import {posix} from 'node:path';

const callPathFunctions = new Set([
  'access',
  'accessSync',
  'file',
  'open',
  'openSync',
  'readFile',
  'readFileSync',
  'readProjectFile',
  'readdir',
  'readdirSync',
  'sourceFile',
  'stat',
  'statSync',
]);
const composePathFunctions = new Set(['join', 'resolve']);

const staticText = node =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;

const normalizeCandidate = (path, value, relativeToSource) => {
  const portable = value.replaceAll('\\', '/');
  const rooted = relativeToSource && /^\.\.?\//u.test(portable) ? posix.join(posix.dirname(path), portable) : portable;
  const normalized = posix.normalize(rooted).replace(/^\.\//u, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined;
  if (posix.isAbsolute(normalized) || /^[a-zA-Z]:\//u.test(normalized)) return undefined;
  return normalized;
};

const looksLikePath = value =>
  value.includes('/') || value.startsWith('.') || /(?:^|\.)[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/u.test(value);

const callName = expression => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
};

const isProcessCwd = node =>
  ts.isCallExpression(node) &&
  node.arguments.length === 0 &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === 'process' &&
  node.expression.name.text === 'cwd';

const templateDirectory = node => {
  if (node === undefined || !ts.isTemplateExpression(node)) return undefined;
  const prefix = node.head.text.replaceAll('\\', '/');
  const separator = prefix.lastIndexOf('/');
  return separator < 0 ? undefined : prefix.slice(0, separator);
};

/** Extracts repository-relative path candidates from static source literals. */
export function sourceRepositoryPathCandidates(path, content) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const candidates = new Set();
  const rootDeclarations = new Map();
  const collectRootDeclarations = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const current = rootDeclarations.get(node.name.text) ?? true;
      rootDeclarations.set(node.name.text, current && node.initializer !== undefined && isProcessCwd(node.initializer));
    }
    ts.forEachChild(node, collectRootDeclarations);
  };
  collectRootDeclarations(source);
  const repositoryRoots = new Set(
    [...rootDeclarations].filter(([, repositoryRoot]) => repositoryRoot).map(([name]) => name),
  );
  const isRepositoryRoot = node => isProcessCwd(node) || (ts.isIdentifier(node) && repositoryRoots.has(node.text));
  const add = (value, relativeToSource = true) => {
    const normalized = normalizeCandidate(path, value, relativeToSource);
    if (normalized) candidates.add(normalized);
  };
  const visit = node => {
    const text = staticText(node);
    if (text !== undefined && looksLikePath(text)) add(text);
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (callPathFunctions.has(name)) {
        const directory = templateDirectory(node.arguments[0]);
        if (directory) add(directory);
      }
      if (composePathFunctions.has(name)) {
        const allStatic = node.arguments.every(argument => staticText(argument) !== undefined);
        const rootedStatic =
          node.arguments.length > 1 &&
          isRepositoryRoot(node.arguments[0]) &&
          node.arguments.slice(1).every(argument => staticText(argument) !== undefined);
        if (allStatic || rootedStatic) {
          const start = rootedStatic ? 1 : 0;
          add(posix.join(...node.arguments.slice(start).map(argument => staticText(argument))), false);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...candidates].sort();
}

export function allowedRepositoryPath(path, roots) {
  return roots.some(root => path === root || path.startsWith(`${root}/`));
}
