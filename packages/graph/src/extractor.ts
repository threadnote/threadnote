import {
  collectLocalBindings,
  declarationKind,
  expressionName,
  hasExportModifier,
  isTypeScriptCallableImplementation,
  leadingDocumentation,
  propertyName,
  relationshipExpressionName,
  spanFor,
  textSpan,
  typeScriptDeclarationArity,
} from './extractor_syntax.js';
import {Array as EffectArray} from 'effect';
import type ts from 'typescript-compiler';
import {Option, Predicate} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseMarkdownHeadingLine, textLines} from '@threadnote/platform/string-boundaries';
import {compareCodeUnits} from './ordering.js';
import {loadTypeScriptExtractionRuntime, typeScriptKindForPath} from './typescript_runtime.js';
import {documentLookupTiers, resolveLegacyDocumentReference, resolveLookupTiers} from './resolution/lookup.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphReference,
  CodeGraphRelation,
  CodeGraphSymbol,
} from './types.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface ExtractionContext {
  readonly contentHash: string;
  readonly language: string;
  readonly packageName?: string;
  readonly path: string;
}

interface MutableFacts {
  readonly diagnostics: string[];
  readonly edgeIdentities?: Set<string>;
  readonly edges: CodeGraphEdge[];
  readonly references?: CodeGraphReference[];
  readonly symbols: CodeGraphSymbol[];
}

interface SymbolIdentityAllocator {
  readonly groupOccurrences: Map<string, number>;
  readonly signatureOccurrences: Map<string, number>;
}

interface PackageInfo {
  readonly name: string;
  readonly root: string;
}

interface PackageCandidate extends PackageInfo {
  readonly entryPath?: string;
}

interface ResolvablePackageInfo extends PackageInfo {
  readonly entryPath: string;
}

export interface PackageIndex {
  readonly all: readonly PackageInfo[];
  readonly nameByRoot: ReadonlyMap<string, string>;
  readonly uniqueByName: ReadonlyMap<string, ResolvablePackageInfo>;
}

interface ResolutionCache {
  readonly importedSymbols: Map<string, Option.Option<CodeGraphSymbol>>;
  readonly modulePaths: Map<string, Option.Option<string>>;
}

export interface CodeGraphResolutionObserver {
  readonly onAliasScopeScan?: (sourcePath: string) => void;
}

interface ResolutionAliasScope {
  readonly aliases: ReadonlyMap<string, readonly string[]>;
  readonly exclude: readonly RegExp[];
  readonly explicitFiles: boolean;
  readonly files: ReadonlySet<string>;
  readonly include: readonly RegExp[];
  readonly root: string;
}

export interface ResolutionAliasIndex {
  readonly observer: CodeGraphResolutionObserver;
  readonly scopeBySourcePath: Map<string, ResolutionAliasScope | undefined>;
  readonly scopes: readonly ResolutionAliasScope[];
}

const TYPESCRIPT_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
export const TYPESCRIPT_DYNAMIC_RELATIONSHIP_LIMIT = 4_000;
const TYPESCRIPT_FULL_TRAVERSAL_CHARACTER_LIMIT = 2 * 1_024 * 1_024;
// Every compiler-dependent helper is private to extractTypeScript. Loading at
// that boundary keeps attribution and non-TypeScript extraction compiler-free.
let compiler: typeof ts;
let declarationKinds: ReadonlySet<ts.SyntaxKind>;

export function extractRepositoryFacts(
  files: readonly CodeGraphInventoryFile[],
  observer: CodeGraphResolutionObserver = {},
): readonly CodeGraphFileFacts[] {
  return resolveExtractedRepositoryFacts(extractRepositoryFileFacts(files), files, observer);
}

export function extractRepositoryFileFacts(
  files: readonly CodeGraphInventoryFile[],
  acceptedPaths?: ReadonlySet<string>,
): readonly CodeGraphFileFacts[] {
  const packages = discoverPackages(files);
  const output: CodeGraphFileFacts[] = [];
  for (const file of files) {
    if (!(acceptedPaths?.has(file.path) ?? true)) continue;
    const facts = extractFileFacts(file, {packageName: packageForPath(file.path, packages)});
    output.push(facts);
  }
  return output;
}

export function refreshPackageAttribution(
  facts: readonly CodeGraphFileFacts[],
  files: readonly CodeGraphInventoryFile[],
): readonly CodeGraphFileFacts[] {
  const packages = discoverPackages(files);
  return EffectArray.map(facts, file => refreshFilePackageAttribution(file, packages));
}

export function createPackageAttributor(
  files: readonly CodeGraphInventoryFile[],
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  return createPackageAttributorFromIndex(discoverPackages(files));
}

export function createRepositoryFactAttributor(
  files: readonly CodeGraphInventoryFile[],
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  const packages = discoverPackages(files);
  const attributePackages = createPackageAttributorFromIndex(packages);
  const attributeResolution = createResolutionAttributorFromIndex(files, packages);
  return facts => attributeResolution(attributePackages(facts));
}

export function createPackageAttributorFromIndex(
  packages: PackageIndex,
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  return facts => EffectArray.map(facts, file => refreshFilePackageAttribution(file, packages));
}

function refreshFilePackageAttribution(file: CodeGraphFileFacts, packages: PackageIndex): CodeGraphFileFacts {
  return {
    ...file,
    symbols: EffectArray.map(file.symbols, symbol => {
      const {packageName: _stalePackageName, ...withoutPackage} = symbol;
      const packageName = packageForPath(symbol.path, packages);
      return packageName ? {...withoutPackage, packageName} : withoutPackage;
    }),
  };
}

export function createResolutionAttributor(
  files: readonly CodeGraphInventoryFile[],
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  const packages = discoverPackages(files);
  return createResolutionAttributorFromIndex(files, packages);
}

export function createResolutionAttributorFromIndex(
  files: readonly CodeGraphInventoryFile[],
  packages: PackageIndex,
  existingPaths: ReadonlySet<string> = new Set(EffectArray.map(files, file => file.path)),
  aliases: ResolutionAliasIndex = discoverResolutionAliases(files, {}),
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  const packageNameCounts = new Map<string, number>();
  for (const candidate of packages.all) {
    packageNameCounts.set(candidate.name, (packageNameCounts.get(candidate.name) ?? 0) + 1);
  }
  const duplicatePackages = new Set(
    EffectArray.map(
      EffectArray.filter([...packageNameCounts], ([, count]) => count > 1),
      ([name]) => name,
    ),
  );
  const resolutionCache: ResolutionCache = {importedSymbols: new Map(), modulePaths: new Map()};
  return facts => {
    const factsByPath = new Map(EffectArray.map(facts, file => [file.path, file]));
    return EffectArray.map(facts, file => {
      const imports = collectImportBindings([file]).get(file.path);
      const edges = EffectArray.map(file.edges, normalizeLocallyBoundEdge);
      const declaredReferences = new Map(
        Option.getOrElse(
          Option.map(Option.fromNullishOr(file.references), references =>
            EffectArray.map(references, reference => [reference.edgeId, reference]),
          ),
          () => [],
        ),
      );
      const references = EffectArray.flatMap(file.edges, (edge, index) => {
        if (parseLocallyBoundTarget(edge.targetName) !== undefined) return [];
        const declared = declaredReferences.get(edge.id);
        if (declared !== undefined && declared.lookupTiers.length > 0) return [declared];
        return referenceForLegacyEdge(
          edges[index],
          imports,
          existingPaths,
          packages,
          aliases,
          resolutionCache,
          declared?.arity,
          factsByPath,
        );
      });
      return {
        ...file,
        diagnostics: [
          ...file.diagnostics,
          ...EffectArray.map(
            EffectArray.filter(file.symbols, symbol => symbol.kind === 'package' && duplicatePackages.has(symbol.name)),
            symbol => `${file.path}: duplicate workspace package name ${symbol.name}`,
          ),
        ],
        edges,
        references,
        symbols: EffectArray.map(file.symbols, addNormalizedLookupKeys),
      };
    });
  };
}

function addNormalizedLookupKeys(symbol: CodeGraphSymbol): CodeGraphSymbol {
  if (symbol.lookupKeys !== undefined && symbol.resolutionDomain !== undefined) {
    return {
      ...symbol,
      lookupKeys: uniqueStrings([...symbol.lookupKeys, ...generatedGlobalLookupKeys(symbol, symbol.resolutionDomain)]),
    };
  }
  const resolutionDomain = TYPESCRIPT_EXTENSIONS.test(symbol.path)
    ? 'typescript'
    : symbol.kind === 'package'
      ? 'workspace'
      : symbol.kind === 'document' || symbol.kind === 'heading'
        ? 'documentation'
        : 'generic';
  const lookupKeys =
    resolutionDomain === 'typescript'
      ? [
          `typescript:path:${lookupComponent(symbol.path)}:qualified:${lookupComponent(symbol.qualifiedName)}`,
          `typescript:path:${lookupComponent(symbol.path)}:name:${lookupComponent(symbol.name)}`,
          ...(symbol.kind === 'module' ? [`typescript:module:${lookupComponent(symbol.path)}`] : []),
        ]
      : resolutionDomain === 'workspace'
        ? [`workspace:package:${lookupComponent(symbol.name)}`]
        : [];
  return {
    ...symbol,
    lookupKeys: uniqueStrings([
      ...(symbol.lookupKeys ?? []),
      ...lookupKeys,
      ...generatedGlobalLookupKeys(symbol, resolutionDomain),
    ]),
    resolutionDomain,
  };
}

function generatedGlobalLookupKeys(symbol: CodeGraphSymbol, resolutionDomain: string | undefined): readonly string[] {
  // TypeScript and JavaScript lookup is path/module scoped. Unscoped global
  // mirrors turn otherwise file-local declarations into active repository-wide
  // endpoints and make a bounded resolver closure impossible to prove. Keep
  // any explicit global keys supplied by an extractor, but do not synthesize
  // them mechanically for this resolver domain.
  if (resolutionDomain === 'typescript') return [];
  // Generic JSON/YAML properties are lexical evidence inside their file, not
  // cross-file resolution targets. Persisting two global lookup rows for
  // every leaf duplicates a large structured-data tail without resolving an
  // edge; the file module remains globally addressable.
  if (
    ['json', 'jsonc', 'yaml'].includes(symbol.language) &&
    ['item', 'property', 'resource-value'].includes(symbol.kind)
  ) {
    return [];
  }
  return [
    `global:qualified:${lookupComponent(symbol.qualifiedName)}`,
    `global:name:${lookupComponent(symbol.name)}`,
    ...(symbol.kind === 'module' || symbol.kind === 'document' ? [`global:path:${lookupComponent(symbol.path)}`] : []),
  ];
}

function normalizeLocallyBoundEdge(edge: CodeGraphEdge): CodeGraphEdge {
  const targetName = parseLocallyBoundTarget(edge.targetName);
  if (targetName === undefined) return edge;
  return {
    ...edge,
    id: edgeId(
      edge.sourceId,
      edge.sourceName,
      edge.relation,
      undefined,
      targetName,
      edge.provenance,
      edge.evidencePath,
    ),
    targetName,
  };
}

function referenceForLegacyEdge(
  edge: CodeGraphEdge,
  imports: ReadonlyMap<string, {readonly imported: string; readonly specifier: string}> | undefined,
  existingPaths: ReadonlySet<string>,
  packages: PackageIndex,
  aliases: ResolutionAliasIndex,
  cache: ResolutionCache,
  arity?: number,
  factsByPath?: ReadonlyMap<string, CodeGraphFileFacts>,
): readonly CodeGraphReference[] {
  if (edge.targetId || parseLocallyBoundTarget(edge.targetName) !== undefined) return [];
  const binding = parseImportBindingTarget(edge.targetName);
  if ((edge.relation === 'imports' || edge.relation === 'reexports') && binding) {
    if (binding.imported === '*' || binding.imported === 'default') return [];
    const targetPath = resolveModulePath(edge.evidencePath, binding.specifier, existingPaths, packages, aliases, cache);
    if (targetPath === undefined) return [];
    const aliasLookupKeys =
      edge.relation === 'reexports'
        ? [
            typescriptCallableKey(edge.evidencePath, binding.local, 'name', 'implementation'),
            typescriptNameKey(edge.evidencePath, binding.local),
          ]
        : undefined;
    return [
      referenceForEdge(
        edge,
        'typescript',
        [
          [typescriptCallableKey(targetPath, binding.imported, 'name', 'implementation')],
          [typescriptNameKey(targetPath, binding.imported)],
        ],
        {aliasLookupKeys, exportedOnly: true},
      ),
    ];
  }
  if (edge.relation === 'imports' || edge.relation === 'reexports') {
    const targetPath = resolveModulePath(edge.evidencePath, edge.targetName, existingPaths, packages, aliases, cache);
    return targetPath === undefined
      ? []
      : [referenceForEdge(edge, 'typescript', [[`typescript:module:${lookupComponent(targetPath)}`]])];
  }
  if (edge.relation === 'depends_on') {
    return [referenceForEdge(edge, 'workspace', [[`workspace:package:${lookupComponent(edge.targetName)}`]])];
  }
  if (edge.relation === 'documents') {
    return [referenceForEdge(edge, 'global', documentLookupTiers(edge.targetName))];
  }
  if (!['calls', 'constructs', 'exports', 'extends', 'implements', 'overrides', 'references'].includes(edge.relation)) {
    return [];
  }
  const imported = imports?.get(edge.targetName);
  if (imported && imported.imported !== '*' && imported.imported !== 'default') {
    const targetPath = resolveModulePath(
      edge.evidencePath,
      imported.specifier,
      existingPaths,
      packages,
      aliases,
      cache,
    );
    return targetPath === undefined
      ? []
      : [
          referenceForEdge(
            edge,
            'typescript',
            typescriptReferenceLookupTiersForTargets(
              factsByPath === undefined
                ? [{name: imported.imported, path: targetPath}]
                : transitiveTypeScriptReexportTargets(
                    targetPath,
                    imported.imported,
                    factsByPath,
                    existingPaths,
                    packages,
                    aliases,
                    cache,
                  ),
              edge.relation,
              arity,
            ),
            {arity, exportedOnly: true},
          ),
        ];
  }
  if (
    Effect.pipe(edge.targetName, EffectString.startsWith('this.')) ||
    Effect.pipe(edge.targetName, EffectString.includes('.'))
  )
    return [];
  return [
    referenceForEdge(
      edge,
      'typescript',
      typescriptReferenceLookupTiers(edge.evidencePath, edge.targetName, 'qualified', edge.relation, arity),
      {arity},
    ),
  ];
}

interface TypeScriptReexportTarget {
  readonly name: string;
  readonly path: string;
}

function transitiveTypeScriptReexportTargets(
  path: string,
  name: string,
  factsByPath: ReadonlyMap<string, CodeGraphFileFacts>,
  existingPaths: ReadonlySet<string>,
  packages: PackageIndex,
  aliases: ResolutionAliasIndex,
  cache: ResolutionCache,
  visited: ReadonlySet<string> = new Set(),
): readonly TypeScriptReexportTarget[] {
  const visitKey = `${path}\0${name}`;
  if (visited.has(visitKey)) return [];
  const nextVisited = new Set(visited);
  nextVisited.add(visitKey);
  const targets = EffectArray.flatMap(factsByPath.get(path)?.edges ?? [], edge => {
    if (edge.relation !== 'reexports') return [];
    const binding = parseImportBindingTarget(edge.targetName);
    if (!binding || binding.local !== name || binding.imported === '*' || binding.imported === 'default') return [];
    const targetPath = resolveModulePath(path, binding.specifier, existingPaths, packages, aliases, cache);
    if (targetPath === undefined) return [];
    return transitiveTypeScriptReexportTargets(
      targetPath,
      binding.imported,
      factsByPath,
      existingPaths,
      packages,
      aliases,
      cache,
      nextVisited,
    );
  });
  if (targets.length === 0) return [{name, path}];
  return uniqueByKey(targets, target => `${target.path}\0${target.name}`);
}

function typescriptReferenceLookupTiersForTargets(
  targets: readonly TypeScriptReexportTarget[],
  relation: CodeGraphRelation,
  arity?: number,
): readonly (readonly string[])[] {
  const perTarget = EffectArray.map(targets, target =>
    typescriptReferenceLookupTiers(target.path, target.name, 'name', relation, arity),
  );
  const tierCount = Math.max(0, ...EffectArray.map(perTarget, tiers => tiers.length));
  return EffectArray.filter(
    Array.from({length: tierCount}, (_, tier) =>
      uniqueStrings(EffectArray.flatMap(perTarget, tiers => tiers[tier] ?? [])),
    ),
    tier => tier.length > 0,
  );
}

function referenceForEdge(
  edge: CodeGraphEdge,
  resolutionDomain: string,
  lookupTiers: readonly (readonly string[])[],
  options: {
    readonly aliasLookupKeys?: readonly string[];
    readonly arity?: number;
    readonly exportedOnly?: boolean;
  } = {},
): CodeGraphReference {
  return {
    aliasLookupKeys: options.aliasLookupKeys,
    ...(options.arity === undefined ? {} : {arity: options.arity}),
    edgeId: edge.id,
    evidencePath: edge.evidencePath,
    evidenceSpan: edge.evidenceSpan,
    exportedOnly: options.exportedOnly,
    lookupTiers,
    provenance: edge.provenance,
    relation: edge.relation,
    resolutionDomain,
    sourceId: edge.sourceId,
    sourceName: edge.sourceName,
    targetName: edge.targetName,
  };
}

function typescriptNameKey(path: string, name: string): string {
  return `typescript:path:${lookupComponent(path)}:name:${lookupComponent(name)}`;
}

function typescriptQualifiedKey(path: string, qualifiedName: string): string {
  return `typescript:path:${lookupComponent(path)}:qualified:${lookupComponent(qualifiedName)}`;
}

function typescriptCallableKey(
  path: string,
  value: string,
  scope: 'name' | 'qualified',
  discriminator: `arity:${number}` | 'implementation',
): string {
  return `${scope === 'name' ? typescriptNameKey(path, value) : typescriptQualifiedKey(path, value)}:${discriminator}`;
}

function typescriptMergeCanonicalKey(path: string, value: string, scope: 'name' | 'qualified'): string {
  return `${scope === 'name' ? typescriptNameKey(path, value) : typescriptQualifiedKey(path, value)}:merge-canonical`;
}

function typescriptReferenceLookupTiers(
  path: string,
  value: string,
  scope: 'name' | 'qualified',
  relation: CodeGraphRelation,
  arity?: number,
): readonly (readonly string[])[] {
  const base = scope === 'name' ? typescriptNameKey(path, value) : typescriptQualifiedKey(path, value);
  return (relation === 'calls' || relation === 'constructs') && arity !== undefined
    ? [
        [typescriptCallableKey(path, value, scope, 'implementation')],
        [typescriptCallableKey(path, value, scope, `arity:${arity}`)],
        [base],
      ]
    : [[typescriptMergeCanonicalKey(path, value, scope)], [base]];
}

function lookupComponent(value: string): string {
  return encodeURIComponent(value);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniqueByKey<A>(values: readonly A[], key: (value: A) => string): readonly A[] {
  const output = new Map<string, A>();
  for (const value of values) {
    const valueKey = key(value);
    if (!output.has(valueKey)) {
      output.set(valueKey, value);
    }
  }
  return [...output.values()];
}

export function extractFileFacts(
  file: CodeGraphInventoryFile,
  options: {readonly packageName?: string} = {},
): CodeGraphFileFacts {
  if (file.content === undefined) {
    throw new Error(`Repository content for ${file.path} was not loaded before extraction.`);
  }
  const context: ExtractionContext = {
    contentHash: file.contentHash,
    language: file.language,
    packageName: options.packageName,
    path: file.path,
  };
  if (TYPESCRIPT_EXTENSIONS.test(file.path)) return extractTypeScript(file.content, context);
  if (/package\.json$/i.test(file.path)) return extractPackageManifest(file.content, context);
  if (/go\.mod$/i.test(file.path)) return extractGoManifest(file.content, context);
  if (/\.mdx?$/i.test(file.path)) return extractMarkdown(file.content, context);
  return {diagnostics: [], edges: [], path: file.path, symbols: []};
}

function extractTypeScript(content: string, context: ExtractionContext): CodeGraphFileFacts {
  if (compiler === undefined) ({compiler, declarationKinds} = loadTypeScriptExtractionRuntime());
  const sourceFile = compiler.createSourceFile(
    context.path,
    content,
    compiler.ScriptTarget.Latest,
    true,
    typeScriptKindForPath(compiler, context.path),
  );
  const facts: MutableFacts = {
    diagnostics: [],
    edgeIdentities: new Set(),
    edges: [],
    references: [],
    symbols: [],
  };
  const moduleSymbol = makeSymbol(context, sourceFile, 'module', context.path, context.path, true);
  const symbolIdentities: SymbolIdentityAllocator = {
    groupOccurrences: new Map(),
    signatureOccurrences: new Map(),
  };
  facts.symbols.push(moduleSymbol);
  const declarationStack: CodeGraphSymbol[] = [moduleSymbol];
  const declarationByNode = new Map<ts.Node, CodeGraphSymbol>([[sourceFile, moduleSymbol]]);
  const surfaceOnly = content.length > TYPESCRIPT_FULL_TRAVERSAL_CHARACTER_LIMIT;
  const localBindings = surfaceOnly
    ? new Map<ts.Node, ReadonlySet<string>>()
    : collectLocalBindings(compiler, sourceFile);
  let dynamicRelationships = 0;
  let dynamicRelationshipsBounded = surfaceOnly;

  const addDynamicRelationship = (
    node: ts.CallExpression | ts.NewExpression,
    owner: CodeGraphSymbol,
    relation: 'calls' | 'constructs',
  ): void => {
    if (surfaceOnly || dynamicRelationships >= TYPESCRIPT_DYNAMIC_RELATIONSHIP_LIMIT) {
      dynamicRelationshipsBounded = true;
      return;
    }
    const target = relationshipExpressionName(compiler, node.expression, localBindings);
    if (!target) return;
    dynamicRelationships += 1;
    addUnresolvedEdge(facts, context, node, owner, target, relation, 'syntactic', node.arguments?.length ?? 0);
  };

  const visit = (node: ts.Node): void => {
    const declaration = declarationForNode(node, sourceFile, context, declarationStack, symbolIdentities);
    let pushed = false;
    if (declaration) {
      facts.symbols.push(declaration);
      declarationByNode.set(node, declaration);
      addEdge(facts, context, node, declarationStack.at(-1)!, declaration, 'contains', 'syntactic');
      declarationStack.push(declaration);
      pushed = true;
    }

    const owner = declarationStack.at(-1)!;
    if (compiler.isImportDeclaration(node) && compiler.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      addUnresolvedEdge(facts, context, node, owner, specifier, 'imports', 'syntactic');
      const clause = node.importClause;
      if (clause?.name) {
        addUnresolvedEdge(
          facts,
          context,
          clause.name,
          owner,
          importBindingTarget(specifier, 'default', clause.name.text),
          'imports',
          'syntactic',
        );
      }
      if (clause?.namedBindings && compiler.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          addUnresolvedEdge(
            facts,
            context,
            element,
            owner,
            importBindingTarget(specifier, element.propertyName?.text ?? element.name.text, element.name.text),
            'imports',
            'syntactic',
          );
        }
      } else if (clause?.namedBindings && compiler.isNamespaceImport(clause.namedBindings)) {
        addUnresolvedEdge(
          facts,
          context,
          clause.namedBindings,
          owner,
          importBindingTarget(specifier, '*', clause.namedBindings.name.text),
          'imports',
          'syntactic',
        );
      }
    } else if (
      compiler.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      compiler.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      addUnresolvedEdge(facts, context, node, owner, specifier, 'reexports', 'syntactic');
      if (node.exportClause && compiler.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          addUnresolvedEdge(
            facts,
            context,
            element,
            owner,
            importBindingTarget(specifier, element.propertyName?.text ?? element.name.text, element.name.text),
            'reexports',
            'syntactic',
          );
        }
      }
    } else if (compiler.isCallExpression(node)) {
      addDynamicRelationship(node, owner, 'calls');
    } else if (compiler.isNewExpression(node)) {
      addDynamicRelationship(node, owner, 'constructs');
    } else if (compiler.isHeritageClause(node)) {
      const relation: CodeGraphRelation =
        node.token === compiler.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends';
      for (const type of node.types) {
        const target = relationshipExpressionName(compiler, type.expression, localBindings);
        if (target) addUnresolvedEdge(facts, context, type, owner, target, relation, 'syntactic');
      }
    } else if (compiler.isExportAssignment(node)) {
      const target = expressionName(compiler, node.expression);
      if (target) addUnresolvedEdge(facts, context, node, moduleSymbol, target, 'exports', 'syntactic');
    }

    if (surfaceOnly || dynamicRelationshipsBounded) forEachTypeScriptStructuralChild(node, visit);
    else compiler.forEachChild(node, visit);
    if (pushed) declarationStack.pop();
  };
  compiler.forEachChild(sourceFile, visit);

  const parseDiagnostics = (
    sourceFile as ts.SourceFile & {readonly parseDiagnostics?: readonly ts.DiagnosticWithLocation[]}
  ).parseDiagnostics;
  for (const diagnostic of parseDiagnostics ?? []) {
    const position =
      diagnostic.start === undefined ? undefined : sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
    facts.diagnostics.push(
      `${context.path}${position ? `:${position}` : ''}: ${compiler.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  }
  if (dynamicRelationshipsBounded) {
    facts.diagnostics.push(
      surfaceOnly
        ? `${context.path}: large TypeScript/JavaScript source used declaration-surface extraction; ` +
            'module declarations, imports, reexports, and inheritance were preserved while call and construct facts were omitted'
        : `${context.path}: call and construct relationships were bounded at ${TYPESCRIPT_DYNAMIC_RELATIONSHIP_LIMIT}; ` +
            'module declarations, imports, reexports, and inheritance were preserved',
    );
  }
  return {
    diagnostics: facts.diagnostics,
    edges: facts.edges,
    path: context.path,
    references: facts.references,
    symbols: facts.symbols,
  };
}

function forEachTypeScriptStructuralChild(node: ts.Node, visit: (node: ts.Node) => void): void {
  compiler.forEachChild(node, child => {
    if (
      compiler.isExpression(child) &&
      !compiler.isArrowFunction(child) &&
      !compiler.isClassExpression(child) &&
      !compiler.isFunctionExpression(child)
    ) {
      return;
    }
    visit(child);
  });
}

function declarationForNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  context: ExtractionContext,
  stack: readonly CodeGraphSymbol[],
  identities: SymbolIdentityAllocator,
): CodeGraphSymbol | undefined {
  if (declarationKinds.has(node.kind)) {
    const nameNode = namedDeclarationName(node);
    if (!nameNode) return undefined;
    return makeSymbol(
      context,
      sourceFile,
      declarationKind(compiler, node),
      nameNode.text,
      qualify(stack, nameNode.text),
      hasExportModifier(compiler, node),
      node,
      identities,
    );
  }
  if (compiler.isVariableDeclaration(node) && compiler.isIdentifier(node.name)) {
    return makeSymbol(
      context,
      sourceFile,
      'variable',
      node.name.text,
      qualify(stack, node.name.text),
      hasExportModifier(compiler, node.parent.parent),
      node,
      identities,
    );
  }
  if (
    (compiler.isMethodDeclaration(node) ||
      compiler.isMethodSignature(node) ||
      compiler.isGetAccessorDeclaration(node) ||
      compiler.isSetAccessorDeclaration(node)) &&
    node.name
  ) {
    const name = propertyName(compiler, node.name);
    if (!name) return undefined;
    return makeSymbol(context, sourceFile, 'method', name, qualify(stack, name), false, node, identities);
  }
  if (compiler.isConstructorDeclaration(node)) {
    return makeSymbol(
      context,
      sourceFile,
      'constructor',
      'constructor',
      qualify(stack, 'constructor'),
      false,
      node,
      identities,
    );
  }
  return undefined;
}

function namedDeclarationName(node: ts.Node): ts.Identifier | undefined {
  const declaration =
    compiler.isClassDeclaration(node) ||
    compiler.isEnumDeclaration(node) ||
    compiler.isFunctionDeclaration(node) ||
    compiler.isInterfaceDeclaration(node) ||
    compiler.isTypeAliasDeclaration(node)
      ? node
      : undefined;
  return declaration?.name && compiler.isIdentifier(declaration.name) ? declaration.name : undefined;
}

function extractPackageManifest(content: string, context: ExtractionContext): CodeGraphFileFacts {
  const facts: MutableFacts = {diagnostics: [], edges: [], symbols: []};
  let manifest: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(content);
    if (!Predicate.isObject(value)) throw new Error('expected an object');
    manifest = value;
  } catch (cause) {
    return {
      diagnostics: [`${context.path}: invalid package.json (${messageOf(cause)})`],
      edges: [],
      path: context.path,
      symbols: [],
    };
  }
  const name =
    typeof manifest.name === 'string'
      ? manifest.name
      : Effect.pipe(context.path, EffectString.replace(/\/package\.json$/, ''));
  const symbol = makeTextSymbol(context, 'package', name, name, true, content, 0, Math.min(content.length, 1));
  facts.symbols.push(symbol);
  for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const section = manifest[sectionName];
    if (!section || typeof section !== 'object' || EffectArray.isArray(section)) continue;
    for (const dependency of EffectRecord.keys(section).sort()) {
      addTextEdge(facts, context, symbol, dependency, 'depends_on', 'declared', content);
    }
  }
  return {diagnostics: facts.diagnostics, edges: facts.edges, path: context.path, symbols: facts.symbols};
}

function extractGoManifest(content: string, context: ExtractionContext): CodeGraphFileFacts {
  const facts: MutableFacts = {diagnostics: [], edges: [], symbols: []};
  const moduleName = /^module\s+(\S+)/m.exec(content)?.[1];
  if (!moduleName) {
    return {diagnostics: [`${context.path}: module declaration not found`], edges: [], path: context.path, symbols: []};
  }
  const symbol = makeTextSymbol(context, 'package', moduleName, moduleName, true, content, 0, moduleName.length);
  facts.symbols.push(symbol);
  for (const match of Effect.pipe(content, EffectString.matchAll(/^\s*(?:require\s+)?([^\s()]+)\s+v[^\s]+/gm))) {
    if (match[1] && match[1] !== moduleName) {
      addTextEdge(facts, context, symbol, match[1], 'depends_on', 'declared', content);
    }
  }
  return {diagnostics: facts.diagnostics, edges: facts.edges, path: context.path, symbols: facts.symbols};
}

function extractMarkdown(content: string, context: ExtractionContext): CodeGraphFileFacts {
  const facts: MutableFacts = {diagnostics: [], edges: [], symbols: []};
  const document = makeTextSymbol(context, 'document', context.path, context.path, true, content, 0, 1);
  facts.symbols.push(document);
  for (const line of textLines(content)) {
    const heading = parseMarkdownHeadingLine(line.text);
    if (heading) {
      const symbol = makeTextSymbol(
        context,
        'heading',
        heading.title,
        `${context.path}#${slug(heading.title)}`,
        true,
        content,
        line.start,
        line.end,
        boundedMarkdownSection(content, line.start),
      );
      facts.symbols.push(symbol);
      addTextResolvedEdge(facts, context, document, symbol, 'contains', 'syntactic', content, line.start);
    }
  }
  const references = new Set<string>();
  for (const match of Effect.pipe(content, EffectString.matchAll(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)`/g))) {
    references.add(match[1]);
  }
  for (const match of Effect.pipe(
    content,
    EffectString.matchAll(
      /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|mdx?|pdf|docx|pptx|xlsx|od[stp]|png|jpe?g|gif|webp|svg|mp[34]|m4[av]|mov|webm|wav|flac)\b/gi,
    ),
  )) {
    references.add(match[0]);
  }
  for (const target of references) {
    addTextEdge(facts, context, document, target, 'documents', 'syntactic', content);
  }
  return {diagnostics: facts.diagnostics, edges: facts.edges, path: context.path, symbols: facts.symbols};
}

export function resolveExtractedRepositoryFacts(
  facts: readonly CodeGraphFileFacts[],
  files: readonly CodeGraphInventoryFile[],
  observer: CodeGraphResolutionObserver = {},
): readonly CodeGraphFileFacts[] {
  return createRepositoryFactResolver(facts, files, observer).resolve(facts);
}

export interface RepositoryFactResolver {
  readonly resolve: (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[];
  readonly symbols: readonly CodeGraphSymbol[];
}

export function createRepositoryFactResolver(
  indexFacts: readonly CodeGraphFileFacts[],
  files: readonly CodeGraphInventoryFile[],
  observer: CodeGraphResolutionObserver = {},
): RepositoryFactResolver {
  const packages = discoverPackages(files);
  const symbols = uniqueSymbols(EffectArray.flatMap(indexFacts, file => file.symbols));
  // The public helper also accepts raw extracted facts. Build its private
  // resolution indexes from the same normalized keys used by cached/persisted
  // materialization, while returning the caller's facts and symbols unchanged.
  const resolutionSymbols = uniqueSymbols(
    EffectArray.flatMap(createResolutionAttributorFromIndex(files, packages)(indexFacts), file => file.symbols),
  );
  const byPathAndName = groupSymbols(resolutionSymbols, symbol => `${symbol.path}\0${symbol.name}`);
  const byLookupKey = groupSymbolLookupKeys(resolutionSymbols);
  const packageSymbols = groupSymbols(
    EffectArray.filter(
      resolutionSymbols,
      (symbol, __effectArrayIndex) => __effectArrayIndex in resolutionSymbols && symbol.kind === 'package',
    ),
    symbol => symbol.name,
  );
  const moduleSymbols = new Map(
    EffectArray.map(
      EffectArray.filter(
        resolutionSymbols,
        (symbol, __effectArrayIndex) => __effectArrayIndex in resolutionSymbols && symbol.kind === 'module',
      ),
      symbol => [symbol.path, symbol],
    ),
  );
  const existingPaths = new Set(EffectArray.map(files, file => file.path));
  const factsByPath = new Map(EffectArray.map(indexFacts, file => [file.path, file]));
  const aliases = discoverResolutionAliases(files, observer);
  const resolutionCache: ResolutionCache = {importedSymbols: new Map(), modulePaths: new Map()};

  return {
    resolve: facts => {
      const importsByPath = collectImportBindings(facts);
      return EffectArray.map(facts, fileFacts => {
        const declaredReferences = new Map(
          Option.getOrElse(
            Option.map(Option.fromNullishOr(fileFacts.references), references =>
              EffectArray.map(references, reference => [reference.edgeId, reference]),
            ),
            () => [],
          ),
        );
        const imports = importsByPath.get(fileFacts.path);
        return {
          ...fileFacts,
          diagnostics: [
            ...fileFacts.diagnostics,
            ...EffectArray.map(
              EffectArray.filter(
                fileFacts.symbols,
                symbol => symbol.kind === 'package' && (packageSymbols.get(symbol.name)?.length ?? 0) > 1,
              ),
              symbol => `${fileFacts.path}: duplicate workspace package name ${symbol.name}`,
            ),
          ],
          edges: EffectArray.map(fileFacts.edges, edge => {
            if (edge.targetId) return edge;
            const declaredReference = declaredReferences.get(edge.id);
            const typedReference =
              declaredReference !== undefined && declaredReference.lookupTiers.length > 0
                ? declaredReference
                : undefined;
            const locallyBound = parseLocallyBoundTarget(edge.targetName);
            if (locallyBound) {
              return {
                ...edge,
                id: edgeId(
                  edge.sourceId,
                  edge.sourceName,
                  edge.relation,
                  undefined,
                  locallyBound,
                  edge.provenance,
                  edge.evidencePath,
                ),
                targetName: locallyBound,
              };
            }
            const binding = parseImportBindingTarget(edge.targetName);
            const resolved = typedReference
              ? resolveTypedReference(typedReference, byLookupKey)
              : (edge.relation === 'imports' || edge.relation === 'reexports') && binding
                ? resolveImportedSymbol(
                    edge.evidencePath,
                    binding,
                    byPathAndName,
                    factsByPath,
                    existingPaths,
                    packages,
                    aliases,
                    resolutionCache,
                  )
                : edge.relation === 'imports' || edge.relation === 'reexports'
                  ? resolveModuleTarget(
                      edge.evidencePath,
                      edge.targetName,
                      moduleSymbols,
                      existingPaths,
                      packages,
                      aliases,
                      resolutionCache,
                    )
                  : edge.relation === 'depends_on'
                    ? uniqueSymbol(packageSymbols.get(edge.targetName))
                    : edge.relation === 'documents'
                      ? resolveLegacyDocumentReference(edge.targetName, byLookupKey)
                      : resolveSourceRelationshipTarget(
                          edge,
                          byPathAndName,
                          imports,
                          factsByPath,
                          existingPaths,
                          packages,
                          aliases,
                          resolutionCache,
                          declaredReference?.arity,
                        );
            if (!resolved) return edge;
            const provenance: CodeGraphProvenance =
              edge.provenance === 'declared' ? 'declared' : edge.relation === 'documents' ? 'syntactic' : 'resolved';
            const relation =
              edge.relation === 'extends' && ['interface', 'protocol'].includes(resolved.kind)
                ? 'implements'
                : edge.relation;
            return {
              ...edge,
              confidence: provenance === 'declared' || provenance === 'resolved' ? 1 : edge.confidence,
              id: edgeId(
                edge.sourceId,
                edge.sourceName,
                relation,
                resolved.id,
                resolved.name,
                provenance,
                edge.evidencePath,
              ),
              provenance,
              relation,
              targetId: resolved.id,
              targetName: resolved.name,
            };
          }),
        };
      });
    },
    symbols,
  };
}

function groupSymbolLookupKeys(symbols: readonly CodeGraphSymbol[]): ReadonlyMap<string, readonly CodeGraphSymbol[]> {
  const output = new Map<string, CodeGraphSymbol[]>();
  for (const symbol of symbols) {
    for (const key of symbol.lookupKeys ?? []) {
      const values = output.get(key);
      if (values) values.push(symbol);
      else output.set(key, [symbol]);
    }
  }
  return output;
}

function resolveTypedReference(
  reference: CodeGraphReference,
  byLookupKey: ReadonlyMap<string, readonly CodeGraphSymbol[]>,
): CodeGraphSymbol | undefined {
  return resolveLookupTiers(
    reference.lookupTiers,
    reference.resolutionDomain,
    byLookupKey,
    reference.relation,
    reference.sourceId,
    reference.exportedOnly === true,
  );
}

function uniqueSymbols(symbols: readonly CodeGraphSymbol[]): readonly CodeGraphSymbol[] {
  const unique = new Map<string, CodeGraphSymbol>();
  for (const symbol of symbols) {
    if (!unique.has(symbol.id)) unique.set(symbol.id, symbol);
  }
  return [...unique.values()];
}

function collectImportBindings(
  facts: readonly CodeGraphFileFacts[],
): ReadonlyMap<string, ReadonlyMap<string, {readonly imported: string; readonly specifier: string}>> {
  const output = new Map<string, Map<string, {readonly imported: string; readonly specifier: string}>>();
  for (const file of facts) {
    const bindings = new Map<string, {readonly imported: string; readonly specifier: string}>();
    for (const edge of file.edges) {
      if (edge.relation !== 'imports') continue;
      const binding = parseImportBindingTarget(edge.targetName);
      if (binding) bindings.set(binding.local, {imported: binding.imported, specifier: binding.specifier});
    }
    output.set(file.path, bindings);
  }
  return output;
}

function resolveSourceRelationshipTarget(
  edge: CodeGraphEdge,
  byPathAndName: ReadonlyMap<string, readonly CodeGraphSymbol[]>,
  imports: ReadonlyMap<string, {readonly imported: string; readonly specifier: string}> | undefined,
  factsByPath: ReadonlyMap<string, CodeGraphFileFacts>,
  existingPaths: ReadonlySet<string>,
  packages: PackageIndex,
  aliases: ResolutionAliasIndex,
  cache: ResolutionCache,
  arity?: number,
): CodeGraphSymbol | undefined {
  if (!['calls', 'constructs', 'exports', 'extends', 'implements', 'overrides', 'references'].includes(edge.relation)) {
    return undefined;
  }
  const imported = imports?.get(edge.targetName);
  if (imported && imported.imported !== '*') {
    return resolveImportedSymbol(
      edge.evidencePath,
      {...imported, local: edge.targetName},
      byPathAndName,
      factsByPath,
      existingPaths,
      packages,
      aliases,
      cache,
      {arity, relation: edge.relation},
    );
  }
  if (Effect.pipe(edge.targetName, EffectString.startsWith('this.'))) return undefined;
  const localName = edge.targetName;
  if (Effect.pipe(localName, EffectString.includes('.'))) return undefined;
  return selectTypeScriptCallableCandidate(
    EffectArray.filter(
      byPathAndName.get(`${edge.evidencePath}\0${localName}`) ?? [],
      symbol => symbol.qualifiedName === localName,
    ) ?? [],
    {arity, relation: edge.relation},
  );
}

interface TypeScriptCallableResolution {
  readonly arity?: number;
  readonly relation?: CodeGraphRelation;
}

function selectTypeScriptCallableCandidate(
  candidates: readonly CodeGraphSymbol[],
  options: TypeScriptCallableResolution,
): CodeGraphSymbol | undefined {
  if ((options.relation === 'calls' || options.relation === 'constructs') && options.arity !== undefined) {
    const implementations = EffectArray.filter(candidates, symbol =>
      Boolean(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(symbol.lookupKeys), findArray =>
            EffectArray.some(findArray, key => Effect.pipe(key, EffectString.endsWith(':implementation'))),
          ),
        ),
      ),
    );
    if (implementations.length === 1) return implementations[0];
    if (implementations.length > 1) return undefined;
    const matchingArity = EffectArray.filter(
      candidates,
      (symbol, __effectArrayIndex) => __effectArrayIndex in candidates && symbol.arity === options.arity,
    );
    if (matchingArity.length === 1) return matchingArity[0];
    if (matchingArity.length > 1) return undefined;
  }
  return uniqueSymbol(candidates);
}

function resolveImportedSymbol(
  sourcePath: string,
  binding: {readonly imported: string; readonly local: string; readonly specifier: string},
  byPathAndName: ReadonlyMap<string, readonly CodeGraphSymbol[]>,
  factsByPath: ReadonlyMap<string, CodeGraphFileFacts>,
  existingPaths: ReadonlySet<string>,
  packages: PackageIndex,
  aliases: ResolutionAliasIndex,
  cache: ResolutionCache,
  options: TypeScriptCallableResolution = {},
  visited: ReadonlySet<string> = new Set(),
): CodeGraphSymbol | undefined {
  if (binding.imported === '*' || binding.imported === 'default') return undefined;
  const cacheKey = `${sourcePath}\0${binding.specifier}\0${binding.imported}\0${options.relation ?? ''}\0${
    options.arity ?? ''
  }`;
  if (visited.size === 0) {
    const cached = cache.importedSymbols.get(cacheKey);
    if (cached) return Option.getOrUndefined(cached);
  }
  const targetPath = resolveModulePath(sourcePath, binding.specifier, existingPaths, packages, aliases, cache);
  if (!targetPath) {
    if (visited.size === 0) cache.importedSymbols.set(cacheKey, Option.none());
    return undefined;
  }
  const visitKey = `${targetPath}\0${binding.imported}`;
  if (visited.has(visitKey)) return undefined;
  const direct = EffectArray.filter(
    byPathAndName.get(`${targetPath}\0${binding.imported}`) ?? [],
    symbol => symbol.exported,
  );
  if (direct.length > 0) {
    const selected = selectTypeScriptCallableCandidate(direct, options);
    if (visited.size === 0) {
      cache.importedSymbols.set(cacheKey, selected === undefined ? Option.none() : Option.some(selected));
    }
    return selected;
  }
  const nextVisited = new Set(visited);
  nextVisited.add(visitKey);
  for (const edge of factsByPath.get(targetPath)?.edges ?? []) {
    if (edge.relation !== 'reexports') continue;
    const reexport = parseImportBindingTarget(edge.targetName);
    if (!reexport || reexport.local !== binding.imported) continue;
    const resolved = resolveImportedSymbol(
      targetPath,
      reexport,
      byPathAndName,
      factsByPath,
      existingPaths,
      packages,
      aliases,
      cache,
      options,
      nextVisited,
    );
    if (resolved) {
      if (visited.size === 0) cache.importedSymbols.set(cacheKey, Option.some(resolved));
      return resolved;
    }
  }
  if (visited.size === 0) cache.importedSymbols.set(cacheKey, Option.none());
  return undefined;
}

function importBindingTarget(specifier: string, imported: string, local: string): string {
  return `import:${encodeURIComponent(specifier)}:${encodeURIComponent(imported)}:${encodeURIComponent(local)}`;
}

function parseImportBindingTarget(
  value: string,
): {readonly imported: string; readonly local: string; readonly specifier: string} | undefined {
  const match = /^import:([^:]*):([^:]*):([^:]*)$/.exec(value);
  if (!match) return undefined;
  try {
    return {
      imported: decodeURIComponent(match[2]),
      local: decodeURIComponent(match[3]),
      specifier: decodeURIComponent(match[1]),
    };
  } catch {
    return undefined;
  }
}

function resolveModuleTarget(
  sourcePath: string,
  target: string,
  modules: ReadonlyMap<string, CodeGraphSymbol>,
  existingPaths: ReadonlySet<string>,
  packages: PackageIndex,
  aliases: ResolutionAliasIndex,
  cache: ResolutionCache,
): CodeGraphSymbol | undefined {
  const targetPath = resolveModulePath(sourcePath, target, existingPaths, packages, aliases, cache);
  return targetPath ? modules.get(targetPath) : undefined;
}

function resolveModulePath(
  sourcePath: string,
  target: string,
  existingPaths: ReadonlySet<string>,
  packages: PackageIndex,
  aliases: ResolutionAliasIndex,
  cache: ResolutionCache,
): string | undefined {
  const cacheKey = `${sourcePath}\0${target}`;
  const cached = cache.modulePaths.get(cacheKey);
  if (cached) return Option.getOrUndefined(cached);
  const bases: string[] = [];
  if (Effect.pipe(target, EffectString.startsWith('.'))) {
    const relative = normalizeContainedSegments([
      ...Effect.pipe(sourcePath, EffectString.split('/')).slice(0, -1),
      ...Effect.pipe(target, EffectString.split('/')),
    ]);
    if (relative !== undefined) bases.push(relative);
  } else {
    for (const candidate of aliasCandidates(sourcePath, target, aliases)) bases.push(candidate);
    const packageInfo = packages.uniqueByName.get(target);
    if (packageInfo) bases.push(packageInfo.entryPath);
  }
  for (const base of bases) {
    for (const candidate of moduleCandidates(base)) {
      if (existingPaths.has(candidate)) {
        cache.modulePaths.set(cacheKey, Option.some(candidate));
        return candidate;
      }
    }
  }
  cache.modulePaths.set(cacheKey, Option.none());
  return undefined;
}

export function discoverPackages(files: readonly CodeGraphInventoryFile[]): PackageIndex {
  const candidates = new Map<string, PackageCandidate[]>();
  for (const file of files) {
    if (!/package\.json$/i.test(file.path)) continue;
    try {
      if (file.content === undefined) continue;
      const parsed: unknown = JSON.parse(file.content);
      if (!Predicate.isObject(parsed)) continue;
      if (typeof parsed.name === 'string') {
        const root = Effect.pipe(file.path, EffectString.replace(/(?:^|\/)package\.json$/, ''));
        const declaredEntry = packageEntry(parsed.exports, parsed.main);
        const entryPath =
          declaredEntry === undefined
            ? undefined
            : normalizeContainedSegments([root, Effect.pipe(declaredEntry, EffectString.replace(/^\.\//, ''))]);
        const values = candidates.get(parsed.name) ?? [];
        values.push(entryPath === undefined ? {name: parsed.name, root} : {entryPath, name: parsed.name, root});
        candidates.set(parsed.name, values);
      }
    } catch {
      // Diagnostics are emitted by the manifest extractor.
    }
  }
  const all = [...candidates.values()].flat();
  return {
    all,
    nameByRoot: new Map(EffectArray.map(all, candidate => [candidate.root, candidate.name])),
    uniqueByName: new Map(
      EffectArray.flatMap([...candidates], ([name, values]) => {
        const value = values[0];
        if (values.length !== 1 || value?.entryPath === undefined) return [];
        return [[name, {entryPath: value.entryPath, name: value.name, root: value.root}] as const];
      }),
    ),
  };
}

function packageForPath(path: string, packages: PackageIndex): string | undefined {
  let directory = Effect.pipe(path, EffectString.includes('/'))
    ? Effect.pipe(
        path,
        EffectString.slice(
          0,
          Effect.pipe(
            path,
            EffectString.lastIndexOf('/'),
            Effect.Option.getOrElse(() => -1),
          ),
        ),
      )
    : '';
  while (true) {
    const packageName = packages.nameByRoot.get(directory);
    if (packageName !== undefined) return packageName;
    if (directory === '') return undefined;
    const separator = Effect.pipe(
      directory,
      EffectString.lastIndexOf('/'),
      Effect.Option.getOrElse(() => -1),
    );
    directory = separator < 0 ? '' : Effect.pipe(directory, EffectString.slice(0, separator));
  }
}

export function discoverResolutionAliases(
  files: readonly CodeGraphInventoryFile[],
  observer: CodeGraphResolutionObserver,
): ResolutionAliasIndex {
  const scopes: ResolutionAliasScope[] = [];
  for (const file of Effect.pipe(files, values =>
    EffectArray.filter(
      values,
      (candidate, __filterIndex) => __filterIndex in values && /(?:^|\/)tsconfig\.json$/i.test(candidate.path),
    ),
  )) {
    try {
      if (file.content === undefined) continue;
      const parsed: unknown = JSON.parse(file.content);
      if (!Predicate.isObject(parsed)) continue;
      const compilerOptions = Predicate.isObject(parsed.compilerOptions) ? parsed.compilerOptions : undefined;
      const configRoot = Effect.pipe(file.path, EffectString.replace(/(?:^|\/)tsconfig\.json$/, ''));
      const baseUrl = typeof compilerOptions?.baseUrl === 'string' ? compilerOptions.baseUrl : '.';
      const base = normalizeContainedSegments([configRoot, baseUrl]);
      if (base === undefined) continue;
      const aliases = new Map<string, string[]>();
      const paths = compilerOptions?.paths;
      if (Predicate.isObject(paths)) {
        for (const [alias, targets] of EffectRecord.toEntries(paths)) {
          if (!EffectArray.isArray(targets)) continue;
          const safeTargets = EffectArray.flatMap(
            EffectArray.filter<unknown, string>(
              targets,
              (target: unknown): target is string => typeof target === 'string',
            ),
            target => {
              const candidate = normalizeContainedSegments([base, target]);
              return candidate === undefined ? [] : [candidate];
            },
          );
          if (safeTargets.length > 0) aliases.set(alias, safeTargets);
        }
      }
      const explicitFiles = EffectRecord.has(parsed, 'files');
      const projectFiles = normalizedProjectPaths(configRoot, parsed.files);
      const include = explicitFiles
        ? []
        : compileProjectPatterns(
            normalizedProjectPatterns(configRoot, EffectArray.isArray(parsed.include) ? parsed.include : ['**/*']),
          );
      const exclude = compileProjectPatterns(
        normalizedProjectPatterns(configRoot, [
          ...(EffectArray.isArray(parsed.exclude) ? parsed.exclude : []),
          ...(typeof compilerOptions?.outDir === 'string' ? [compilerOptions.outDir] : []),
        ]),
      );
      scopes.push({aliases, exclude, explicitFiles, files: projectFiles, include, root: configRoot});
    } catch {
      // The manifest extractor records invalid JSON diagnostics.
    }
  }
  return {
    observer,
    scopeBySourcePath: new Map(),
    scopes: scopes.sort(
      (left, right) => right.root.length - left.root.length || compareCodeUnits(left.root, right.root),
    ),
  };
}

function aliasCandidates(sourcePath: string, target: string, index: ResolutionAliasIndex): readonly string[] {
  const scope = index.scopeBySourcePath.has(sourcePath)
    ? index.scopeBySourcePath.get(sourcePath)
    : Option.getOrUndefined(EffectArray.findFirst(index.scopes, candidate => projectIncludes(candidate, sourcePath)));
  if (!index.scopeBySourcePath.has(sourcePath)) {
    index.observer.onAliasScopeScan?.(sourcePath);
    index.scopeBySourcePath.set(sourcePath, scope);
  }
  if (!scope) return [];
  const matches: Array<{
    readonly candidates: readonly string[];
    readonly exact: boolean;
    readonly specificity: number;
  }> = [];
  for (const [alias, candidates] of scope.aliases) {
    const wildcard = Effect.pipe(
      alias,
      EffectString.indexOf('*'),
      Effect.Option.getOrElse(() => -1),
    );
    if (wildcard < 0) {
      if (alias === target) matches.push({candidates, exact: true, specificity: alias.length});
      continue;
    }
    const prefix = Effect.pipe(alias, EffectString.slice(0, wildcard));
    const suffix = Effect.pipe(alias, EffectString.slice(wildcard + 1));
    if (!Effect.pipe(target, EffectString.startsWith(prefix)) || !Effect.pipe(target, EffectString.endsWith(suffix)))
      continue;
    const substitution = Effect.pipe(target, EffectString.slice(prefix.length, target.length - suffix.length));
    matches.push({
      candidates: EffectArray.map(candidates, candidate =>
        Effect.pipe(candidate, EffectString.replaceAll('*', substitution)),
      ),
      exact: false,
      specificity: prefix.length + suffix.length,
    });
  }
  if (matches.length === 0) return [];
  const bestSpecificity = Math.max(
    ...EffectArray.map(matches, match => (match.exact ? Number.MAX_SAFE_INTEGER : match.specificity)),
  );
  const best = EffectArray.filter(
    matches,
    match => (match.exact ? Number.MAX_SAFE_INTEGER : match.specificity) === bestSpecificity,
  );
  return best.length === 1 ? best[0].candidates : [];
}

function packageEntry(exportsValue: unknown, mainValue: unknown): string | undefined {
  if (exportsValue === undefined) return typeof mainValue === 'string' ? mainValue : undefined;
  const root =
    Predicate.isObject(exportsValue) &&
    EffectArray.some(EffectRecord.keys(exportsValue), key => Effect.pipe(key, EffectString.startsWith('.')))
      ? exportsValue['.']
      : exportsValue;
  const targets = new Set(collectExportTargets(root));
  return targets.size === 1 ? [...targets][0] : undefined;
}

function collectExportTargets(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (EffectArray.isArray(value)) return EffectArray.flatMap(value, collectExportTargets);
  if (!Predicate.isObject(value)) return [];
  return EffectArray.flatMap(EffectRecord.values(value), collectExportTargets);
}

function normalizedProjectPaths(root: string, value: unknown): ReadonlySet<string> {
  if (!EffectArray.isArray(value)) return new Set();
  return new Set(
    EffectArray.flatMap(value, entry => {
      if (typeof entry !== 'string') return [];
      const normalized = normalizeContainedSegments([root, entry]);
      return normalized === undefined ? [] : [normalized];
    }),
  );
}

function normalizedProjectPatterns(root: string, values: readonly unknown[]): readonly string[] {
  return EffectArray.flatMap(values, value => {
    if (typeof value !== 'string') return [];
    const normalized = normalizeContainedSegments([root, value]);
    return normalized === undefined ? [] : [normalized];
  });
}

function projectIncludes(scope: ResolutionAliasScope, sourcePath: string): boolean {
  if (scope.root !== '' && !Effect.pipe(sourcePath, EffectString.startsWith(`${scope.root}/`))) return false;
  const included = scope.explicitFiles
    ? scope.files.has(sourcePath)
    : EffectArray.some(scope.include, pattern => pattern.test(sourcePath));
  return included && !EffectArray.some(scope.exclude, pattern => pattern.test(sourcePath));
}

function compileProjectPatterns(patterns: readonly string[]): readonly RegExp[] {
  return EffectArray.map(patterns, compileProjectPattern);
}

function compileProjectPattern(pattern: string): RegExp {
  if (!/[*?]/.test(pattern)) {
    const exact = Effect.pipe(pattern, EffectString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${exact}(?:/|$)`);
  }
  const expression = Effect.pipe(
    pattern,
    EffectString.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    EffectString.replaceAll('**/', '\u0000'),
    EffectString.replaceAll('**', '\u0001'),
    EffectString.replaceAll('*', '[^/]*'),
    EffectString.replaceAll('?', '[^/]'),
    EffectString.replaceAll('\u0000', '(?:.*/)?'),
    EffectString.replaceAll('\u0001', '.*'),
  );
  return new RegExp(`^${expression}$`);
}

function makeSymbol(
  context: ExtractionContext,
  sourceFile: ts.SourceFile,
  kind: string,
  name: string,
  qualifiedName: string,
  exported: boolean,
  node: ts.Node = sourceFile,
  identities?: SymbolIdentityAllocator,
): CodeGraphSymbol {
  const start = node.getStart(sourceFile, false);
  const end = node.getEnd();
  const arity = typeScriptDeclarationArity(compiler, node);
  const signature = Effect.pipe(
    Effect.pipe(sourceFile.text, EffectString.slice(start, Math.min(end, start + 300)))
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
      .split(/[{\n]/, 1)[0],
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  const identity =
    identities === undefined
      ? {groupOccurrence: 0, id: symbolId(context.path, context.language, kind, qualifiedName)}
      : allocateSymbolIdentity(context.path, context.language, kind, qualifiedName, signature ?? '', identities);
  const lookupKeys = typeScriptSymbolLookupKeys(
    context.path,
    kind,
    name,
    qualifiedName,
    arity,
    isTypeScriptCallableImplementation(compiler, node),
    identity.groupOccurrence === 0 && isTypeScriptMergeableKind(kind),
  );
  return {
    ...(arity === undefined ? {} : {arity}),
    contentHash: context.contentHash,
    documentation: leadingDocumentation(compiler, sourceFile, node),
    exported,
    id: identity.id,
    kind,
    language: context.language,
    lookupKeys,
    name,
    packageName: context.packageName,
    path: context.path,
    qualifiedName,
    resolutionDomain: 'typescript',
    signature: signature || undefined,
    span: spanFor(sourceFile, start, end),
  };
}

function typeScriptSymbolLookupKeys(
  path: string,
  kind: string,
  name: string,
  qualifiedName: string,
  arity: number | undefined,
  implementation: boolean,
  mergeCanonical: boolean,
): readonly string[] {
  const keys = [typescriptNameKey(path, name), typescriptQualifiedKey(path, qualifiedName)];
  if (kind === 'module') keys.push(`typescript:module:${lookupComponent(path)}`);
  if (arity !== undefined) {
    keys.push(
      typescriptCallableKey(path, name, 'name', `arity:${arity}`),
      typescriptCallableKey(path, qualifiedName, 'qualified', `arity:${arity}`),
    );
  }
  if (implementation) {
    keys.push(
      typescriptCallableKey(path, name, 'name', 'implementation'),
      typescriptCallableKey(path, qualifiedName, 'qualified', 'implementation'),
    );
  }
  if (mergeCanonical) {
    keys.push(
      typescriptMergeCanonicalKey(path, name, 'name'),
      typescriptMergeCanonicalKey(path, qualifiedName, 'qualified'),
    );
  }
  return uniqueStrings(keys);
}

function isTypeScriptMergeableKind(kind: string): boolean {
  return kind === 'interface' || kind === 'enum';
}

function makeTextSymbol(
  context: ExtractionContext,
  kind: string,
  name: string,
  qualifiedName: string,
  exported: boolean,
  content: string,
  start: number,
  end: number,
  documentation?: string,
): CodeGraphSymbol {
  return {
    contentHash: context.contentHash,
    documentation,
    exported,
    id: symbolId(context.path, context.language, kind, qualifiedName),
    kind,
    language: context.language,
    name,
    packageName: context.packageName,
    path: context.path,
    qualifiedName,
    span: textSpan(content, start, end),
  };
}

function addEdge(
  facts: MutableFacts,
  context: ExtractionContext,
  node: ts.Node,
  source: CodeGraphSymbol,
  target: CodeGraphSymbol,
  relation: CodeGraphRelation,
  provenance: CodeGraphProvenance,
): void {
  const sourceFile = node.getSourceFile();
  const evidenceSpan = spanFor(sourceFile, node.getStart(sourceFile, false), node.getEnd());
  facts.edges.push({
    confidence: provenance === 'declared' || provenance === 'resolved' ? 1 : 0.75,
    evidencePath: context.path,
    evidenceSpan,
    id: edgeId(source.id, source.name, relation, target.id, target.name, provenance, context.path),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
  });
}

function addUnresolvedEdge(
  facts: MutableFacts,
  context: ExtractionContext,
  node: ts.Node,
  source: CodeGraphSymbol,
  targetName: string,
  relation: CodeGraphRelation,
  provenance: CodeGraphProvenance,
  arity?: number,
): void {
  const sourceFile = node.getSourceFile();
  const evidenceSpan = spanFor(sourceFile, node.getStart(sourceFile, false), node.getEnd());
  const edge: CodeGraphEdge = {
    confidence: 0.75,
    evidencePath: context.path,
    evidenceSpan,
    id: edgeId(
      source.id,
      source.name,
      relation,
      undefined,
      targetName,
      provenance,
      context.path,
      arity === undefined ? undefined : `arity:${arity}`,
    ),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetName,
  };
  if (facts.edgeIdentities?.has(edge.id)) return;
  facts.edgeIdentities?.add(edge.id);
  facts.edges.push(edge);
  if (arity !== undefined) {
    facts.references?.push({
      arity,
      edgeId: edge.id,
      evidencePath: edge.evidencePath,
      evidenceSpan: edge.evidenceSpan,
      lookupTiers: [],
      provenance: edge.provenance,
      relation: edge.relation,
      resolutionDomain: 'typescript',
      sourceId: edge.sourceId,
      sourceName: edge.sourceName,
      targetName: edge.targetName,
    });
  }
}

function addTextEdge(
  facts: MutableFacts,
  context: ExtractionContext,
  source: CodeGraphSymbol,
  targetName: string,
  relation: CodeGraphRelation,
  provenance: CodeGraphProvenance,
  content: string,
): void {
  facts.edges.push({
    confidence: provenance === 'declared' ? 1 : 0.75,
    evidencePath: context.path,
    evidenceSpan: textSpan(content, 0, Math.min(content.length, 1)),
    id: edgeId(source.id, source.name, relation, undefined, targetName, provenance, context.path),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetName,
  });
}

function addTextResolvedEdge(
  facts: MutableFacts,
  context: ExtractionContext,
  source: CodeGraphSymbol,
  target: CodeGraphSymbol,
  relation: CodeGraphRelation,
  provenance: CodeGraphProvenance,
  content: string,
  start: number,
): void {
  facts.edges.push({
    confidence: 0.75,
    evidencePath: context.path,
    evidenceSpan: textSpan(content, start, start + 1),
    id: edgeId(source.id, source.name, relation, target.id, target.name, provenance, context.path),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
  });
}

function symbolId(path: string, language: string, kind: string, qualifiedName: string): string {
  return `cgs_${Effect.pipe(sha256HexSync(`symbol-v1\n${path}\n${language}\n${kind}\n${qualifiedName}`), EffectString.slice(0, 32))}`;
}

function allocateSymbolIdentity(
  path: string,
  language: string,
  kind: string,
  qualifiedName: string,
  signature: string,
  identities: SymbolIdentityAllocator,
): {readonly groupOccurrence: number; readonly id: string} {
  const groupKey = `${kind}\n${qualifiedName}`;
  const groupOccurrence = identities.groupOccurrences.get(groupKey) ?? 0;
  identities.groupOccurrences.set(groupKey, groupOccurrence + 1);
  const signatureKey = `${groupKey}\n${signature}`;
  const signatureOccurrence = identities.signatureOccurrences.get(signatureKey) ?? 0;
  identities.signatureOccurrences.set(signatureKey, signatureOccurrence + 1);
  if (groupOccurrence === 0) {
    return {groupOccurrence, id: symbolId(path, language, kind, qualifiedName)};
  }
  return {
    groupOccurrence,
    id: `cgs_${Effect.pipe(
      sha256HexSync(`symbol-v2\n${path}\n${language}\n${kind}\n${qualifiedName}\n${signature}\n${signatureOccurrence}`),
      EffectString.slice(0, 32),
    )}`,
  };
}

function edgeId(
  sourceId: string | undefined,
  sourceName: string,
  relation: string,
  targetId: string | undefined,
  targetName: string,
  provenance: string,
  path: string,
  discriminator?: string,
): string {
  return `cge_${Effect.pipe(
    sha256HexSync(
      `edge-v1\n${sourceId ?? sourceName}\n${relation}\n${targetId ?? targetName}\n${provenance}\n${path}${
        discriminator === undefined ? '' : `\n${discriminator}`
      }`,
    ),
    EffectString.slice(0, 32),
  )}`;
}

function qualify(stack: readonly CodeGraphSymbol[], name: string): string {
  const parent = stack.at(-1);
  return parent?.kind === 'module'
    ? name
    : Effect.pipe(`${parent?.qualifiedName ?? ''}.${name}`, EffectString.replace(/^\./, ''));
}

function parseLocallyBoundTarget(value: string): string | undefined {
  const match = /^local:(.+)$/.exec(value);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function groupSymbols(
  symbols: readonly CodeGraphSymbol[],
  key: (symbol: CodeGraphSymbol) => string,
): ReadonlyMap<string, readonly CodeGraphSymbol[]> {
  const result = new Map<string, CodeGraphSymbol[]>();
  for (const symbol of symbols) {
    const value = key(symbol);
    const existing = result.get(value);
    if (existing) existing.push(symbol);
    else result.set(value, [symbol]);
  }
  return result;
}

function uniqueSymbol(symbols: readonly CodeGraphSymbol[] | undefined): CodeGraphSymbol | undefined {
  return symbols?.length === 1 ? symbols[0] : undefined;
}

function moduleCandidates(base: string): readonly string[] {
  const withoutRuntimeExtension = Effect.pipe(base, EffectString.replace(/\.(?:mjs|cjs|js|jsx)$/i, ''));
  return [
    base,
    withoutRuntimeExtension,
    `${withoutRuntimeExtension}.ts`,
    `${withoutRuntimeExtension}.tsx`,
    `${withoutRuntimeExtension}.mts`,
    `${withoutRuntimeExtension}.cts`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
}

function normalizeContainedSegments(segments: readonly string[]): string | undefined {
  const output: string[] = [];
  for (const segment of EffectArray.flatMap(segments, value => Effect.pipe(value, EffectString.split('/')))) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (output.length === 0) return undefined;
      output.pop();
    } else output.push(segment);
  }
  return EffectArray.join(output, '/');
}

function boundedMarkdownSection(content: string, start: number): string {
  const rest = Effect.pipe(content, EffectString.slice(start));
  const nextHeading = Effect.pipe(rest, __effectPipeInput => {
    const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.slice(1));
    const __effectPipeStage1 = Effect.pipe(
      __effectPipeStage0,
      EffectString.search(/^#{1,6}\s+/m),
      Effect.Option.getOrElse(() => -1),
    );
    return __effectPipeStage1;
  });
  return Effect.pipe(rest, __effectPipeInput => {
    const __effectPipeStage0 = Effect.pipe(
      __effectPipeInput,
      EffectString.slice(0, nextHeading < 0 ? 1_024 : Math.min(1_024, nextHeading + 1)),
    );
    const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.trim);
    return __effectPipeStage1;
  });
}

function slug(value: string): string {
  return Effect.pipe(
    value,
    EffectString.toLowerCase,
    EffectString.replace(/[^\p{L}\p{N}]+/gu, '-'),
    EffectString.replace(/^-|-$/g, ''),
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
