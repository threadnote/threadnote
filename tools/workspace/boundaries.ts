import {Array as EffectArray} from 'effect';
import ts from 'typescript-compiler';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

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
    if (Effect.pipe(file.content, EffectString.includes('../../../test'))) {
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
  return EffectArray.map(
    EffectArray.filter(sources, source => !gitVisiblePaths.has(source.path)),
    source => `${source.path}: source file is hidden by Git ignore rules`,
  ).sort();
}

const allowedDependencies: Readonly<Record<string, readonly string[]>> = {
  platform: [],
  'workflow-automations': ['platform'],
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
  'integration-runtime': ['integration-core', 'platform', 'store', 'workspace'],
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
      Effect.pipe(statement.name.text, EffectString.startsWith('virtual:'))
    )
      modules.push(statement.name.text);
  }
  return modules.sort();
}

function relativeTarget(source: string, specifier: string): string {
  const segments = Effect.pipe(source, EffectString.split('/')).slice(0, -1);
  for (const segment of Effect.pipe(specifier, EffectString.split('/'))) {
    if (segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return EffectArray.join(segments, '/');
}

function barePackage(specifier: string): string {
  const segments = Effect.pipe(specifier, EffectString.split('/'));
  return EffectArray.join(segments.slice(0, Effect.pipe(specifier, EffectString.startsWith('@')) ? 2 : 1), '/');
}

export function validateWorkspaceBoundaries(
  packages: readonly WorkspacePackage[],
  sources: readonly SourceModule[],
): readonly string[] {
  const errors = new Set<string>();
  const byName = new Map(EffectArray.map(packages, pkg => [pkg.name, pkg]));
  const ownerOf = (path: string) =>
    EffectOption.getOrUndefined(
      EffectArray.findFirst(
        packages,
        __effectArrayValue =>
          !!(pkg => Effect.pipe(path, EffectString.startsWith(`${pkg.directory}/`)))(__effectArrayValue),
      ),
    );
  const edges = new Map<string, Set<string>>();
  for (const pkg of packages) {
    if (!pkg.private) errors.add(`${pkg.name}: workspace packages must be private`);
    if (!Effect.pipe(pkg.name, EffectString.startsWith('@threadnote/')))
      errors.add(`${pkg.directory}: expected an @threadnote package name`);
    if (EffectArray.filter(packages, other => other.name === pkg.name).length !== 1)
      errors.add(`${pkg.name}: duplicate name`);
    for (const [key, value] of EffectRecord.toEntries(pkg.exports)) {
      if (Effect.pipe(key, EffectString.includes('*')) || Effect.pipe(value, EffectString.includes('*')))
        errors.add(`${pkg.name}: exports must name explicit entrypoints`);
      if (
        !Effect.pipe(value, EffectString.startsWith('./')) ||
        Effect.pipe(value, EffectString.split('/')).includes('..')
      )
        errors.add(`${pkg.name}: export escapes package`);
    }
    const dependencies = {...pkg.dependencies, ...pkg.devDependencies};
    const adjacent = new Set<string>();
    edges.set(pkg.name, adjacent);
    for (const [name, version] of EffectRecord.toEntries(dependencies)) {
      if (!Effect.pipe(name, EffectString.startsWith('@threadnote/'))) continue;
      adjacent.add(name);
      if (!byName.has(name)) errors.add(`${pkg.name}: unknown workspace dependency ${name}`);
      if (version !== 'workspace:*') errors.add(`${pkg.name}: ${name} must use workspace:*`);
      if (Effect.pipe(pkg.directory, EffectString.startsWith('packages/')) && pkg.name !== '@threadnote/testing') {
        const allowed = allowedDependencies[Effect.pipe(pkg.name, EffectString.slice('@threadnote/'.length))];
        if (
          !(name === '@threadnote/testing' && !pkg.dependencies[name]) &&
          !allowed?.includes(Effect.pipe(name, EffectString.slice('@threadnote/'.length)))
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
          ...(Effect.pipe(source.path, EffectString.includes('/src/')) &&
          !Effect.pipe(source.path, EffectString.includes('/test/'))
            ? {}
            : owner.devDependencies),
          ...owner.dependencies,
        }
      : {};
    for (const specifier of source.imports) {
      if (Effect.pipe(specifier, EffectString.startsWith('.'))) {
        const target = relativeTarget(source.path, specifier);
        const targetOwner = ownerOf(target);
        const testMayReadRepositorySupport =
          Effect.pipe(source.path, EffectString.includes('/test/')) && owner && !targetOwner;
        if ((owner || targetOwner) && owner !== targetOwner && !testMayReadRepositorySupport) {
          errors.add(`${source.path}: relative import crosses workspace boundary: ${specifier}`);
        }
        continue;
      }
      if (Effect.pipe(specifier, EffectString.startsWith('@threadnote/'))) {
        const name = barePackage(specifier);
        const dependency = byName.get(name);
        if (!dependency) {
          errors.add(`${source.path}: unknown workspace import ${specifier}`);
          continue;
        }
        const subpath = specifier === name ? '.' : `.${Effect.pipe(specifier, EffectString.slice(name.length))}`;
        if (!(subpath in dependency.exports)) errors.add(`${source.path}: unexported entrypoint ${specifier}`);
        if (owner && owner !== dependency && !declared[name]) {
          errors.add(`${source.path}: undeclared dependency ${name}`);
        }
      } else if (
        owner &&
        !Effect.pipe(specifier, EffectString.startsWith('node:')) &&
        !Effect.pipe(specifier, EffectString.startsWith('bun:'))
      ) {
        if (
          Effect.pipe(specifier, EffectString.startsWith('virtual:')) &&
          EffectArray.some(
            sources,
            candidate => ownerOf(candidate.path) === owner && Boolean(candidate.virtualModules?.includes(specifier)),
          )
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
      errors.add(`Workspace cycle: ${EffectArray.join([...path, name], ' -> ')}`);
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
