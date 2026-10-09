import ts from 'typescript-compiler';

export interface WorkspacePackage {
  readonly name: string;
  readonly directory: string;
  readonly private: boolean;
  readonly exports: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export interface SourceModule {
  readonly path: string;
  readonly imports: readonly string[];
  readonly virtualModules?: readonly string[];
}

export function validateRelocatedTestPaths(
  files: readonly {readonly content: string; readonly path: string}[],
): readonly string[] {
  const errors: string[] = [];
  for (const file of files) {
    if (!/^(?:apps|packages)\/[^/]+\/test\//.test(file.path)) continue;
    if (file.content.includes('../../../test')) {
      errors.push(`${file.path}: contains a corrupted parent segment from the test-root migration`);
    }
    if (/join\((?:process\.cwd\(\)|repoRoot),\s*['"]src['"],\s*['"]standalone\.ts['"]\)/u.test(file.content)) {
      errors.push(`${file.path}: launches the retired root src/standalone.ts entrypoint`);
    }
  }
  return errors.sort();
}

export function validateSourceVisibility(
  sources: readonly SourceModule[],
  gitVisiblePaths: ReadonlySet<string>,
): readonly string[] {
  return sources
    .filter(source => !gitVisiblePaths.has(source.path))
    .map(source => `${source.path}: source file is hidden by Git ignore rules`)
    .sort();
}

const allowedDependencies: Readonly<Record<string, readonly string[]>> = {
  platform: [],
  store: ['platform'],
  memory: ['platform', 'store', 'workspace'],
  evidence: ['platform'],
  integrations: [],
  protocol: [],
  manager: [
    'platform',
    'store',
    'memory',
    'inference',
    'workspace',
    'recall',
    'graph',
    'context',
    'protocol',
    'integrations',
    'integration-core',
  ],
  workspace: ['platform', 'store'],
  inference: ['platform', 'store'],
  recall: ['platform', 'store', 'memory', 'inference', 'workspace', 'protocol'],
  graph: ['platform', 'store', 'workspace', 'inference', 'protocol'],
  context: ['platform', 'store', 'memory', 'inference', 'recall', 'graph', 'workspace', 'protocol', 'integrations'],
  'remote-memory': ['platform', 'store', 'memory', 'protocol', 'recall', 'workspace', 'context', 'graph'],
  'integration-core': ['platform', 'store', 'workspace'],
  'integration-runtime': ['integration-core', 'platform', 'store'],
  'integration-obsidian': [
    'integration-core',
    'integration-runtime',
    'memory',
    'platform',
    'store',
    'workspace',
    'manager',
  ],
  'integration-superhuman': [
    'integration-core',
    'integration-runtime',
    'platform',
    'store',
    'workspace',
    'recall',
    'manager',
  ],
  'integration-pocket': [
    'integration-core',
    'integration-runtime',
    'platform',
    'store',
    'workspace',
    'recall',
    'manager',
  ],
  'integration-github': ['integration-core', 'integration-runtime', 'platform', 'store', 'workspace', 'manager'],
  'integration-linear': ['integration-core', 'integration-runtime', 'platform', 'store', 'workspace', 'manager'],
};

export function moduleSpecifiers(path: string, content: string): readonly string[] {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>();
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) imports.add(argument.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (ts.isStringLiteral(node.argument.literal)) imports.add(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...imports].sort();
}

export function declaredVirtualModules(path: string, content: string): readonly string[] {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const modules: string[] = [];
  for (const statement of source.statements) {
    if (
      ts.isModuleDeclaration(statement) &&
      ts.isStringLiteral(statement.name) &&
      statement.name.text.startsWith('virtual:')
    )
      modules.push(statement.name.text);
  }
  return modules.sort();
}

function relativeTarget(source: string, specifier: string): string {
  const segments = source.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

function barePackage(specifier: string): string {
  const segments = specifier.split('/');
  return segments.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
}

export function validateWorkspaceBoundaries(
  packages: readonly WorkspacePackage[],
  sources: readonly SourceModule[],
): readonly string[] {
  const errors = new Set<string>();
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
  const ownerOf = (path: string) => packages.find(pkg => path.startsWith(`${pkg.directory}/`));
  const edges = new Map<string, Set<string>>();
  for (const pkg of packages) {
    if (!pkg.private) errors.add(`${pkg.name}: workspace packages must be private`);
    if (!pkg.name.startsWith('@threadnote/')) errors.add(`${pkg.directory}: expected an @threadnote package name`);
    if (packages.filter(other => other.name === pkg.name).length !== 1) errors.add(`${pkg.name}: duplicate name`);
    for (const [key, value] of Object.entries(pkg.exports)) {
      if (key.includes('*') || value.includes('*')) errors.add(`${pkg.name}: exports must name explicit entrypoints`);
      if (!value.startsWith('./') || value.split('/').includes('..')) errors.add(`${pkg.name}: export escapes package`);
    }
    const dependencies = {...pkg.dependencies, ...pkg.devDependencies};
    const adjacent = new Set<string>();
    edges.set(pkg.name, adjacent);
    for (const [name, version] of Object.entries(dependencies)) {
      if (!name.startsWith('@threadnote/')) continue;
      adjacent.add(name);
      if (!byName.has(name)) errors.add(`${pkg.name}: unknown workspace dependency ${name}`);
      if (version !== 'workspace:*') errors.add(`${pkg.name}: ${name} must use workspace:*`);
      if (pkg.directory.startsWith('packages/') && pkg.name !== '@threadnote/testing') {
        const allowed = allowedDependencies[pkg.name.slice('@threadnote/'.length)];
        if (
          !(name === '@threadnote/testing' && !pkg.dependencies[name]) &&
          !allowed?.includes(name.slice('@threadnote/'.length))
        ) {
          errors.add(`${pkg.name}: forbidden dependency on ${name}`);
        }
      }
    }
  }
  for (const source of sources) {
    const owner = ownerOf(source.path);
    const declared = owner
      ? {
          ...(source.path.includes('/src/') && !source.path.includes('/test/') ? {} : owner.devDependencies),
          ...owner.dependencies,
        }
      : {};
    for (const specifier of source.imports) {
      if (specifier.startsWith('.')) {
        const target = relativeTarget(source.path, specifier);
        const targetOwner = ownerOf(target);
        const testMayReadRepositorySupport = source.path.includes('/test/') && owner && !targetOwner;
        if ((owner || targetOwner) && owner !== targetOwner && !testMayReadRepositorySupport) {
          errors.add(`${source.path}: relative import crosses workspace boundary: ${specifier}`);
        }
        continue;
      }
      if (specifier.startsWith('@threadnote/')) {
        const name = barePackage(specifier);
        const dependency = byName.get(name);
        if (!dependency) {
          errors.add(`${source.path}: unknown workspace import ${specifier}`);
          continue;
        }
        const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
        if (!(subpath in dependency.exports)) errors.add(`${source.path}: unexported entrypoint ${specifier}`);
        if (owner && owner !== dependency && !declared[name]) {
          errors.add(`${source.path}: undeclared dependency ${name}`);
        }
      } else if (owner && !specifier.startsWith('node:') && !specifier.startsWith('bun:')) {
        if (
          specifier.startsWith('virtual:') &&
          sources.some(candidate => ownerOf(candidate.path) === owner && candidate.virtualModules?.includes(specifier))
        )
          continue;
        const name = barePackage(specifier);
        if (!declared[name]) {
          errors.add(`${source.path}: undeclared dependency ${name}`);
        }
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(name: string, path: readonly string[]): void {
    if (visiting.has(name)) {
      errors.add(`Workspace cycle: ${[...path, name].join(' -> ')}`);
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of [...(edges.get(name) ?? [])].sort()) visit(dependency, [...path, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of [...byName.keys()].sort()) visit(name, []);
  return [...errors].sort();
}
