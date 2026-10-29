import {Array as EffectArray} from 'effect';
import {Effect, Option} from 'effect';
import {type Node, type QueryMatch} from 'web-tree-sitter';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphReference,
  CodeGraphRelation,
  CodeGraphSpan,
  CodeGraphSymbol,
} from '../types.js';
import {CodeGraphLanguagePackError} from '../languages/types.js';
import type {CodeGraphExtractionContext, VerifiedLanguageAsset} from '../languages/types.js';
import {createSourceLineIndex, sourceSpan} from '../languages/source_line_index.js';
import {TreeSitterRuntime} from './runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface TreeSitterImport {
  readonly alias: Option.Option<string>;
  readonly importedName: Option.Option<string>;
  readonly module: string;
  readonly wildcard: boolean;
}

export interface TreeSitterMetadata {
  readonly imports: readonly TreeSitterImport[];
  readonly namespace: Option.Option<string>;
  readonly projectName: Option.Option<string>;
}

export interface TreeSitterSymbolInput {
  readonly arity: Option.Option<number>;
  readonly kind: string;
  readonly metadata: TreeSitterMetadata;
  readonly name: string;
  readonly qualifiedName: string;
}

export interface TreeSitterReferenceInput {
  readonly arity: Option.Option<number>;
  readonly metadata: TreeSitterMetadata;
  readonly owner: CodeGraphSymbol;
  readonly relation: CodeGraphRelation;
  readonly targetName: string;
}

export const TREE_SITTER_EXTRACTOR_POLICY_VERSION =
  'tree-sitter-extractor-v4-unified-crlf-safe-source-spans-unique-symbol-identities';

type NodeSpan = (node: Node) => CodeGraphSpan;

export interface TreeSitterLanguageDefinition {
  readonly asset: VerifiedLanguageAsset;
  readonly declarationQuery: string;
  readonly declarationKind?: (capture: string, declaration: Node) => string;
  readonly declarationName?: (capture: string, declaration: Node, name: Node) => string;
  readonly exported: (node: Node) => boolean;
  readonly id: string;
  readonly ignoreReference?: (input: TreeSitterReferenceInput) => boolean;
  readonly importFromNode: (node: Node) => Option.Option<TreeSitterImport>;
  readonly lookupTiersForReference: (input: TreeSitterReferenceInput) => readonly (readonly string[])[];
  readonly lookupKeysForSymbol: (input: TreeSitterSymbolInput) => readonly string[];
  readonly metadataQuery: string;
  readonly namespaceFromNode: (node: Node) => Option.Option<string>;
  readonly referenceQuery: string;
  readonly referenceRelation?: (capture: string, node: Node) => CodeGraphRelation;
  readonly referenceTarget?: (capture: string, node: Node) => string;
  readonly resolutionDomain: string;
}

interface Declaration {
  readonly kind: string;
  readonly name: string;
  readonly node: Node;
}

interface MaterializedDeclaration extends Declaration {
  readonly symbol: CodeGraphSymbol;
}

interface DeclarationIntervalGroup {
  readonly declarations: readonly MaterializedDeclaration[];
  readonly endIndex: number;
  readonly startIndex: number;
}

export function extractTreeSitterFacts(
  definition: TreeSitterLanguageDefinition,
  file: CodeGraphInventoryFile,
  context: CodeGraphExtractionContext,
): Effect.Effect<CodeGraphFileFacts, CodeGraphLanguagePackError, TreeSitterRuntime> {
  if (file.content === undefined) {
    return Effect.fail(languageError(`Repository content for ${file.path} was not loaded before extraction.`));
  }
  return Effect.gen(function* () {
    const runtime = yield* TreeSitterRuntime;
    return yield* runtime
      .withParsedSource(definition.asset, file.content!, parsed => {
        const spanForNode = createNodeSpan(file.content!);
        const queries = [
          parsed.query(definition.metadataQuery),
          parsed.query(definition.declarationQuery),
          parsed.query(definition.referenceQuery),
        ] as const;
        const metadata = extractMetadata(definition, queries[0].matches(parsed.root), context);
        const moduleSymbol = makeModuleSymbol(file, definition, metadata);
        const declarations = materializeDeclarations(
          definition,
          file,
          metadata,
          declarationMatches(definition, queries[1].matches(parsed.root)),
          spanForNode,
        );
        const owners = createDeclarationOwnerIndex(declarations);
        const symbols = [moduleSymbol, ...EffectArray.map(declarations, declaration => declaration.symbol)];
        const edges: CodeGraphEdge[] = [];
        const references: CodeGraphReference[] = [];
        for (const declaration of declarations) {
          const parent = owners.find(declaration.node, declaration.symbol.id)?.symbol ?? moduleSymbol;
          edges.push(resolvedEdge(parent, declaration.symbol, 'contains', declaration.node, file.path, spanForNode));
        }
        for (const match of queries[2].matches(parsed.root)) {
          const capture = Option.getOrUndefined(
            EffectArray.findFirst(
              match.captures,
              __effectArrayValue =>
                !!(candidate => Effect2.pipe(candidate.name, EffectString.startsWith('reference.')))(
                  __effectArrayValue,
                ),
            ),
          );
          if (!capture) continue;
          const targetName = Effect2.pipe(
            definition.referenceTarget?.(capture.name, capture.node) ?? capture.node.text,
            EffectString.trim,
          );
          if (!targetName) continue;
          const relation =
            definition.referenceRelation?.(capture.name, capture.node) ??
            relationForCapture(Effect2.pipe(capture.name, EffectString.replace(/^reference\./, '')));
          const owner = owners.find(capture.node)?.symbol ?? moduleSymbol;
          const arity = referenceArity(capture.node);
          const input: TreeSitterReferenceInput = {
            arity,
            metadata,
            owner,
            relation,
            targetName,
          };
          if (definition.ignoreReference?.(input) === true) continue;
          const edge = unresolvedEdge(owner, targetName, relation, capture.node, file.path, spanForNode, arity);
          edges.push(edge);
          references.push({
            arity: Option.getOrUndefined(arity),
            edgeId: edge.id,
            evidencePath: edge.evidencePath,
            evidenceSpan: edge.evidenceSpan,
            lookupTiers: definition.lookupTiersForReference(input),
            provenance: edge.provenance,
            relation,
            resolutionDomain: definition.resolutionDomain,
            sourceId: edge.sourceId,
            sourceName: edge.sourceName,
            targetName,
          });
        }
        const diagnostics = parsed.root.hasError
          ? [`${file.path}: ${definition.id} parser recovered from one or more syntax errors`]
          : [];
        return {diagnostics, edges, path: file.path, references, symbols} satisfies CodeGraphFileFacts;
      })
      .pipe(Effect.mapError(cause => languageError(`${file.path}: ${cause.message}`, cause)));
  });
}

function extractMetadata(
  definition: TreeSitterLanguageDefinition,
  matches: readonly QueryMatch[],
  context: CodeGraphExtractionContext,
): TreeSitterMetadata {
  let namespace = Option.none<string>();
  const imports: TreeSitterImport[] = [];
  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === 'metadata.namespace' && Option.isNone(namespace)) {
        namespace = definition.namespaceFromNode(capture.node);
      } else if (capture.name === 'metadata.import') {
        const parsed = definition.importFromNode(capture.node);
        if (Option.isSome(parsed)) imports.push(parsed.value);
      }
    }
  }
  return {
    imports,
    namespace,
    projectName: Option.map(context.project, project => project.name),
  };
}

function declarationMatches(
  language: TreeSitterLanguageDefinition,
  matches: readonly QueryMatch[],
): readonly Declaration[] {
  const declarations: Declaration[] = [];
  for (const match of matches) {
    const definition = Option.getOrUndefined(
      EffectArray.findFirst(
        match.captures,
        __effectArrayValue =>
          !!(capture => Effect2.pipe(capture.name, EffectString.startsWith('definition.')))(__effectArrayValue),
      ),
    );
    const name = Option.getOrUndefined(EffectArray.findFirst(match.captures, capture => capture.name === 'name'));
    if (!definition || !name) continue;
    const value = Effect2.pipe(
      language.declarationName?.(definition.name, definition.node, name.node) ?? name.node.text,
      EffectString.trim,
    );
    if (!value) continue;
    declarations.push({
      kind:
        language.declarationKind?.(definition.name, definition.node) ??
        Effect2.pipe(definition.name, EffectString.replace(/^definition\./, '')),
      name: value,
      node: definition.node,
    });
  }
  return [...deduplicateDeclarations(declarations)].sort(
    (left, right) => left.node.startIndex - right.node.startIndex || right.node.endIndex - left.node.endIndex,
  );
}

function materializeDeclarations(
  definition: TreeSitterLanguageDefinition,
  file: CodeGraphInventoryFile,
  metadata: TreeSitterMetadata,
  declarations: readonly Declaration[],
  spanForNode: NodeSpan,
): readonly MaterializedDeclaration[] {
  const output: MaterializedDeclaration[] = [];
  const open: MaterializedDeclaration[] = [];
  const identityOccurrences = new Map<string, number>();
  for (const declaration of declarations) {
    while (open.length > 0 && !containsNode(open.at(-1)!.node, declaration.node)) {
      open.pop();
    }
    const parent = open.at(-1);
    const namespace = Option.getOrUndefined(metadata.namespace);
    const qualifiedName = EffectArray.join(
      EffectArray.map(
        EffectArray.filter(
          [
            namespace,
            Effect2.pipe(parent?.symbol.qualifiedName, effectOptionalString =>
              effectOptionalString == null
                ? undefined
                : Effect2.pipe(effectOptionalString, EffectString.replace(`${namespace}.`, '')),
            ),
            declaration.name,
          ],
          Boolean,
        ),
        item => (item === null || item === undefined ? '' : String(item)),
      ),
      '.',
    );
    const arity = declarationArity(declaration.node, declaration.kind);
    const signature = boundedSignature(declaration.node.text);
    const lookupKeys = definition.lookupKeysForSymbol({
      arity,
      kind: declaration.kind,
      metadata,
      name: declaration.name,
      qualifiedName,
    });
    const discriminator =
      declaration.kind === 'method' ||
      declaration.kind === 'function' ||
      declaration.kind === 'constructor' ||
      declaration.kind === 'initializer' ||
      declaration.kind === 'subscript'
        ? `${Option.getOrElse(arity, () => -1)}:${Effect2.pipe(sha256HexSync(signature), EffectString.slice(0, 12))}`
        : '';
    const identityKey = `${declaration.kind}\0${qualifiedName}\0${discriminator}`;
    const occurrence = identityOccurrences.get(identityKey) ?? 0;
    identityOccurrences.set(identityKey, occurrence + 1);
    const symbol: CodeGraphSymbol = {
      arity: Option.getOrUndefined(arity),
      contentHash: file.contentHash,
      documentation: leadingDocumentation(declaration.node),
      exported: definition.exported(declaration.node),
      id: allocatedTreeSitterSymbolId(
        file.path,
        file.language,
        declaration.kind,
        qualifiedName,
        discriminator,
        occurrence,
      ),
      kind: declaration.kind,
      language: file.language,
      lookupKeys,
      name: declaration.name,
      packageName: Option.getOrUndefined(metadata.projectName),
      path: file.path,
      qualifiedName,
      resolutionDomain: definition.resolutionDomain,
      signature: signature || undefined,
      span: spanForNode(declaration.node),
    };
    const materialized = {...declaration, symbol};
    output.push(materialized);
    const current = open.at(-1);
    if (
      current === undefined ||
      current.node.startIndex !== declaration.node.startIndex ||
      current.node.endIndex !== declaration.node.endIndex
    ) {
      open.push(materialized);
    }
  }
  return output;
}

function makeModuleSymbol(
  file: CodeGraphInventoryFile,
  definition: TreeSitterLanguageDefinition,
  metadata: TreeSitterMetadata,
): CodeGraphSymbol {
  return {
    contentHash: file.contentHash,
    exported: true,
    id: treeSitterSymbolId(file.path, file.language, 'module', file.path, ''),
    kind: 'module',
    language: file.language,
    lookupKeys: [],
    name: file.path,
    packageName: Option.getOrUndefined(metadata.projectName),
    path: file.path,
    qualifiedName: file.path,
    resolutionDomain: definition.resolutionDomain,
    span: {column: 1, endColumn: 1, endLine: 1, line: 1},
  };
}

function createDeclarationOwnerIndex(declarations: readonly MaterializedDeclaration[]): {
  readonly find: (node: Node, excludedSymbolId?: string) => MaterializedDeclaration | undefined;
} {
  const groups: Array<{
    declarations: MaterializedDeclaration[];
    endIndex: number;
    startIndex: number;
  }> = [];
  for (const declaration of declarations) {
    const previous = groups.at(-1);
    if (previous?.startIndex === declaration.node.startIndex && previous.endIndex === declaration.node.endIndex) {
      previous.declarations.push(declaration);
    } else {
      groups.push({
        declarations: [declaration],
        endIndex: declaration.node.endIndex,
        startIndex: declaration.node.startIndex,
      });
    }
  }
  if (groups.length === 0) return {find: () => undefined};

  const intervalGroups: readonly DeclarationIntervalGroup[] = groups;
  let leafCount = 1;
  while (leafCount < intervalGroups.length) leafCount *= 2;
  const maximumEnds = new Float64Array(leafCount * 2);
  maximumEnds.fill(Number.NEGATIVE_INFINITY);
  for (let index = 0; index < intervalGroups.length; index += 1) {
    maximumEnds[leafCount + index] = intervalGroups[index].endIndex;
  }
  for (let index = leafCount - 1; index > 0; index -= 1) {
    maximumEnds[index] = Math.max(maximumEnds[index * 2], maximumEnds[index * 2 + 1]);
  }

  return {
    find: (node, excludedSymbolId) => {
      let maximumGroupIndex = lastGroupStartingBefore(intervalGroups, node.startIndex);
      while (maximumGroupIndex >= 0) {
        const groupIndex = rightmostContainingGroup(
          maximumEnds,
          leafCount,
          intervalGroups.length,
          maximumGroupIndex,
          node.endIndex,
        );
        if (groupIndex < 0) return undefined;
        const owner = Option.getOrUndefined(
          EffectArray.findFirst(
            intervalGroups[groupIndex].declarations,
            declaration => declaration.symbol.id !== excludedSymbolId,
          ),
        );
        if (owner) return owner;
        maximumGroupIndex = groupIndex - 1;
      }
      return undefined;
    },
  };
}

function lastGroupStartingBefore(groups: readonly DeclarationIntervalGroup[], startIndex: number): number {
  let lower = 0;
  let upper = groups.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (groups[middle].startIndex <= startIndex) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return lower - 1;
}

function rightmostContainingGroup(
  maximumEnds: Float64Array,
  leafCount: number,
  groupCount: number,
  maximumGroupIndex: number,
  requiredEndIndex: number,
): number {
  const visit = (treeIndex: number, lower: number, upper: number): number => {
    if (lower > maximumGroupIndex || maximumEnds[treeIndex] < requiredEndIndex) return -1;
    if (lower === upper) return lower < groupCount ? lower : -1;
    const middle = lower + Math.floor((upper - lower) / 2);
    const right = visit(treeIndex * 2 + 1, middle + 1, upper);
    return right >= 0 ? right : visit(treeIndex * 2, lower, middle);
  };
  return visit(1, 0, leafCount - 1);
}

function containsNode(container: Node, candidate: Node): boolean {
  return container.startIndex <= candidate.startIndex && container.endIndex >= candidate.endIndex;
}

function deduplicateDeclarations(declarations: readonly Declaration[]): readonly Declaration[] {
  const unique = new Map<string, Declaration>();
  for (const declaration of declarations) {
    const key = `${declaration.kind}\0${declaration.name}\0${declaration.node.startIndex}\0${declaration.node.endIndex}`;
    if (!unique.has(key)) unique.set(key, declaration);
  }
  return [...unique.values()];
}

function declarationArity(node: Node, kind: string): Option.Option<number> {
  if (!['constructor', 'function', 'initializer', 'method', 'subscript'].includes(kind)) return Option.none();
  const parameters = findFirstDescendant(node, candidate =>
    /^(?:formal_parameters|function_value_parameters|parameter_clause)$/.test(candidate.type),
  );
  if (!parameters) return Option.some(0);
  return Option.some(
    EffectArray.filter(parameters.namedChildren, child =>
      /^(?:class_parameter|formal_parameter|parameter|receiver_parameter|spread_parameter|variable_arity_parameter)$/.test(
        child.type,
      ),
    ).length,
  );
}

function referenceArity(node: Node): Option.Option<number> {
  for (let current: Node | null = node; current; current = current.parent) {
    if (/^(?:argument_list|call_suffix|value_arguments)$/.test(current.type)) {
      const argumentsNode =
        current.type === 'call_suffix'
          ? Option.getOrUndefined(
              EffectArray.findFirst(
                current.namedChildren,
                __effectArrayValue =>
                  !!(child => /^(?:argument_list|value_arguments)$/.test(child.type))(__effectArrayValue),
              ),
            )
          : current;
      return Option.some(argumentsNode?.namedChildren.length ?? 0);
    }
    if (/^(?:call_expression|method_invocation|object_creation_expression)$/.test(current.type)) {
      const argumentsNode = findFirstDescendant(current, candidate =>
        /^(?:argument_list|value_arguments)$/.test(candidate.type),
      );
      if (argumentsNode) return Option.some(argumentsNode.namedChildren.length);
    }
    if (/declaration$/.test(current.type)) break;
  }
  return Option.none();
}

function findFirstDescendant(node: Node, predicate: (candidate: Node) => boolean): Node | undefined {
  const queue = [...node.namedChildren];
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    if (predicate(candidate)) return candidate;
    queue.push(...candidate.namedChildren);
  }
  return undefined;
}

function resolvedEdge(
  source: CodeGraphSymbol,
  target: CodeGraphSymbol,
  relation: CodeGraphRelation,
  evidence: Node,
  path: string,
  spanForNode: NodeSpan,
): CodeGraphEdge {
  const provenance: CodeGraphProvenance = 'syntactic';
  return {
    confidence: 0.75,
    evidencePath: path,
    evidenceSpan: spanForNode(evidence),
    id: treeSitterEdgeId(source.id, source.name, relation, target.id, target.name, provenance, path),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
  };
}

function unresolvedEdge(
  source: CodeGraphSymbol,
  targetName: string,
  relation: CodeGraphRelation,
  evidence: Node,
  path: string,
  spanForNode: NodeSpan,
  arity: Option.Option<number>,
): CodeGraphEdge {
  const provenance: CodeGraphProvenance = 'syntactic';
  return {
    confidence: 0.75,
    evidencePath: path,
    evidenceSpan: spanForNode(evidence),
    id: treeSitterEdgeId(
      source.id,
      source.name,
      relation,
      undefined,
      targetName,
      provenance,
      path,
      Option.isSome(arity) ? `arity:${arity.value}` : undefined,
    ),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetName,
  };
}

function relationForCapture(value: string): CodeGraphRelation {
  if (value === 'call') return 'calls';
  if (value === 'construct') return 'constructs';
  if (value === 'extend') return 'extends';
  if (value === 'implement') return 'implements';
  if (value === 'override') return 'overrides';
  if (value === 'import') return 'imports';
  if (value === 'annotation') return 'references';
  return 'references';
}

function boundedSignature(value: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  return Effect2.pipe(value.split(/[{\n]/, 1)[0] ?? '', EffectString.trim, EffectString.slice(0, 300));
}

function leadingDocumentation(node: Node): string | undefined {
  const comments: string[] = [];
  for (
    let previous = node.previousNamedSibling;
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Keep native optional chaining so the loop body narrows `previous`.
    previous?.type.includes('comment');
    previous = previous.previousNamedSibling
  ) {
    if (node.startPosition.row - previous.endPosition.row > 2) break;
    comments.unshift(previous.text);
  }
  const documentation = Effect2.pipe(
    EffectArray.join(comments, '\n'),
    EffectString.replace(/^\/\*\*?|\*\/$/g, ''),
    EffectString.replace(/^\s*(?:\/\/\/?|#|\*)\s?/gm, ''),
    EffectString.trim,
  );
  return documentation ? Effect2.pipe(documentation, EffectString.slice(0, 1_024)) : undefined;
}

function createNodeSpan(content: string): NodeSpan {
  const lineIndex = createSourceLineIndex(content);
  return node => sourceSpan(lineIndex, node.startIndex, node.endIndex);
}

function treeSitterSymbolId(
  path: string,
  language: string,
  kind: string,
  qualifiedName: string,
  discriminator: string,
): string {
  return `cgs_${Effect2.pipe(sha256HexSync(`symbol-v2\n${path}\n${language}\n${kind}\n${qualifiedName}\n${discriminator}`), EffectString.slice(0, 32))}`;
}

function allocatedTreeSitterSymbolId(
  path: string,
  language: string,
  kind: string,
  qualifiedName: string,
  discriminator: string,
  occurrence: number,
): string {
  if (occurrence === 0) return treeSitterSymbolId(path, language, kind, qualifiedName, discriminator);
  return `cgs_${Effect2.pipe(
    sha256HexSync(
      `symbol-v3\n${path}\n${language}\n${kind}\n${qualifiedName}\n${discriminator}\noccurrence:${occurrence}`,
    ),
    EffectString.slice(0, 32),
  )}`;
}

function treeSitterEdgeId(
  sourceId: string | undefined,
  sourceName: string,
  relation: string,
  targetId: string | undefined,
  targetName: string,
  provenance: string,
  path: string,
  discriminator?: string,
): string {
  return `cge_${Effect2.pipe(
    sha256HexSync(
      `edge-v1\n${sourceId ?? sourceName}\n${relation}\n${targetId ?? targetName}\n${provenance}\n${path}${
        discriminator === undefined ? '' : `\n${discriminator}`
      }`,
    ),
    EffectString.slice(0, 32),
  )}`;
}

function languageError(message: string, cause?: unknown): CodeGraphLanguagePackError {
  return CodeGraphLanguagePackError.make({message: message, cause: cause === undefined ? undefined : {cause}});
}
