import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphReference,
  CodeGraphRelation,
  CodeGraphSymbol,
} from '../../types.js';
import {createSourceLineIndex, sourceSpan, type SourceLineIndex} from '../source_line_index.js';
import type {CodeGraphExtractionContext} from '../types.js';
import {
  bazelAttribute,
  bazelFileLabel,
  bazelPackagePath,
  canonicalBazelLabel,
  parseBazelSyntax,
  type BazelCall,
  type BazelDefinition,
} from './syntax.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface MutableBazelFacts {
  readonly diagnostics: string[];
  readonly edges: CodeGraphEdge[];
  readonly file: CodeGraphInventoryFile;
  readonly identityOccurrences: Map<string, number>;
  readonly lineIndex: SourceLineIndex;
  readonly module: CodeGraphSymbol;
  readonly packageName: string | undefined;
  readonly packagePath: string;
  readonly references: CodeGraphReference[];
  readonly symbols: CodeGraphSymbol[];
  readonly workspaceRoot: string;
}

interface LoadedBinding {
  readonly imported: string;
  readonly label: string;
}

const BAZEL_DEPENDENCY_ATTRIBUTES = new Set([
  'actual',
  'deps',
  'exports',
  'implementation_deps',
  'plugins',
  'runtime_deps',
  'toolchains',
  'tools',
]);
const MAX_BAZEL_SYMBOLS = 4_000;
const MAX_BAZEL_REFERENCES = 8_000;

export function extractBazelFacts(
  file: CodeGraphInventoryFile,
  context: CodeGraphExtractionContext,
): CodeGraphFileFacts {
  if (file.content === undefined)
    throw new Error(`Repository content for ${file.path} was not loaded before extraction.`);
  const workspaceRoot = Option.match(context.project, {
    onNone: () => '',
    onSome: project => project.workspaceRoots[0] ?? project.root,
  });
  const facts = createFacts(file, context, workspaceRoot);
  if (file.language === 'bazelrc') extractBazelRc(facts);
  else extractStarlark(facts);
  return {
    diagnostics: facts.diagnostics,
    edges: facts.edges,
    path: file.path,
    references: facts.references,
    symbols: facts.symbols,
  };
}

function extractStarlark(facts: MutableBazelFacts): void {
  const syntax = parseBazelSyntax(facts.file.content!);
  const definitions = new Map<BazelDefinition, CodeGraphSymbol>();
  for (const definition of syntax.definitions) {
    const label = `${bazelFileLabel(facts.file.path, facts.workspaceRoot)}%${definition.name}`;
    definitions.set(
      definition,
      addDeclaration(facts, facts.module, 'function', definition.name, label, definition.start, definition.end, [
        bazelLabelKey(label),
        bazelNameKey(definition.name),
      ]),
    );
  }
  if (facts.file.language === 'starlark') {
    for (const assignment of syntax.assignments) {
      addDeclaration(
        facts,
        facts.module,
        'constant',
        assignment.name,
        `${bazelFileLabel(facts.file.path, facts.workspaceRoot)}%${assignment.name}`,
        assignment.start,
        assignment.end,
        [bazelNameKey(assignment.name)],
      );
    }
  }

  const loadedBindings = new Map<string, LoadedBinding>();
  for (const call of EffectArray.filter(syntax.calls, candidate => normalizedCallee(candidate.callee) === 'load')) {
    const sourceLabel = call.strings[0]?.value;
    if (!sourceLabel) continue;
    const canonical = canonicalBazelLabel(sourceLabel, facts.packagePath);
    if (Option.isNone(canonical)) continue;
    addReference(facts, facts.module, canonical.value, 'imports', 'declared', call.start, call.end, [
      [bazelLabelKey(canonical.value)],
    ]);
    for (const imported of call.strings.slice(1)) {
      loadedBindings.set(imported.value, {imported: imported.value, label: canonical.value});
    }
    for (const attribute of call.attributes) {
      const imported = attribute.strings[0]?.value;
      if (imported) loadedBindings.set(attribute.name, {imported, label: canonical.value});
    }
  }

  const targets: Array<{readonly call: BazelCall; readonly symbol: CodeGraphSymbol}> = [];
  if (facts.file.language === 'bazel-build') {
    for (const call of syntax.calls) {
      if (!call.topLevel || normalizedCallee(call.callee) === 'load') continue;
      const name = Option.flatMap(bazelAttribute(call, 'name'), attribute =>
        Option.fromUndefinedOr(attribute.strings[0]?.value),
      );
      if (Option.isNone(name)) continue;
      const label = Option.getOrElse(canonicalBazelLabel(`:${name.value}`, facts.packagePath), () => `:${name.value}`);
      targets.push({
        call,
        symbol: addDeclaration(
          facts,
          facts.module,
          'target',
          name.value,
          label,
          call.start,
          call.end,
          [bazelLabelKey(label), bazelNameKey(name.value), `bazel:rule:${normalizedCallee(call.callee)}`],
          `${normalizedCallee(call.callee)}(name = ${JSON.stringify(name.value)})`,
        ),
      });
    }
  }

  for (const {call, symbol} of targets) {
    addCallReference(facts, symbol, normalizedCallee(call.callee), loadedBindings, call.start, call.end);
    for (const attribute of call.attributes) {
      if (!BAZEL_DEPENDENCY_ATTRIBUTES.has(attribute.name)) continue;
      for (const literal of attribute.strings) {
        const canonical = canonicalBazelLabel(literal.value, facts.packagePath);
        if (Option.isSome(canonical)) {
          addReference(facts, symbol, canonical.value, 'depends_on', 'declared', literal.start, literal.end, [
            [bazelLabelKey(canonical.value)],
          ]);
        }
      }
    }
  }

  const targetCalls = new Set(EffectArray.map(targets, target => target.call));
  const ownerAt = createOwnerResolver(facts.module, definitions, targets);
  for (const call of syntax.calls) {
    const callee = normalizedCallee(call.callee);
    if (callee === 'load' || targetCalls.has(call)) continue;
    const owner = ownerAt(call.start);
    addCallReference(facts, owner, callee, loadedBindings, call.start, call.end);
  }
  if (syntax.bounded || facts.symbols.length >= MAX_BAZEL_SYMBOLS || facts.references.length >= MAX_BAZEL_REFERENCES) {
    facts.diagnostics.push(`${facts.file.path}: Bazel/Starlark extraction reached its deterministic bound`);
  }
}

function extractBazelRc(facts: MutableBazelFacts): void {
  const configs = new Map<string, CodeGraphSymbol>();
  let offset = 0;
  for (const line of Effect.pipe(facts.file.content!, EffectString.split(/\r?\n/u))) {
    const comment = bazelCommentStart(line);
    const source = Effect.pipe(
      comment < 0 ? line : Effect.pipe(line, EffectString.slice(0, comment)),
      EffectString.trim,
    );
    const end = offset + line.length;
    if (!source) {
      offset = end + 1;
      continue;
    }
    const imported = /^(?:try-)?import\s+(\S+)/u.exec(source);
    if (imported) {
      addReference(facts, facts.module, imported[1], 'imports', 'declared', offset, end, [
        [`bazel:path:${imported[1]}`],
      ]);
      offset = end + 1;
      continue;
    }
    const command = /^([A-Za-z_][\w-]*(?::[A-Za-z_][\w-]*)?)(?:\s+|$)/u.exec(source)?.[1];
    if (!command) {
      offset = end + 1;
      continue;
    }
    let config = configs.get(command);
    if (!config) {
      config = addDeclaration(facts, facts.module, 'config', command, `${facts.file.path}#${command}`, offset, end, [
        `bazel:config:${command}`,
      ]);
      configs.set(command, config);
    }
    for (const match of Effect.pipe(source, EffectString.matchAll(/--config(?:=|\s+)([A-Za-z_][\w-]*)/gu))) {
      addReference(facts, config, match[1], 'configures', 'declared', offset, end, [[`bazel:config:${match[1]}`]]);
    }
    offset = end + 1;
  }
}

function bazelCommentStart(line: string): number {
  let cursor = Effect.pipe(
    line,
    EffectString.indexOf('#'),
    Effect.Option.getOrElse(() => -1),
  );
  while (cursor >= 0) {
    if (cursor > 0 && /\s/u.test(line[cursor - 1])) return cursor;
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    cursor = line.indexOf('#', cursor + 1);
  }
  return -1;
}

function createFacts(
  file: CodeGraphInventoryFile,
  context: CodeGraphExtractionContext,
  workspaceRoot: string,
): MutableBazelFacts {
  const packageName = Option.getOrUndefined(context.packageName);
  const identityOccurrences = new Map<string, number>();
  const lineIndex = createSourceLineIndex(file.content!);
  const fileLabel = file.language === 'bazelrc' ? file.path : bazelFileLabel(file.path, workspaceRoot);
  const module = bazelSymbol(
    file,
    packageName,
    identityOccurrences,
    lineIndex,
    'module',
    fileLabel,
    fileLabel,
    0,
    Math.min(file.content!.length, 1),
    file.language === 'bazelrc' ? [`bazel:path:${file.path}`] : [bazelLabelKey(fileLabel)],
  );
  return {
    diagnostics: [],
    edges: [],
    file,
    identityOccurrences,
    lineIndex,
    module,
    packageName,
    packagePath: bazelPackagePath(file.path, workspaceRoot),
    references: [],
    symbols: [module],
    workspaceRoot,
  };
}

function addDeclaration(
  facts: MutableBazelFacts,
  parent: CodeGraphSymbol,
  kind: string,
  name: string,
  qualifiedName: string,
  start: number,
  end: number,
  lookupKeys: readonly string[],
  signature?: string,
): CodeGraphSymbol {
  if (facts.symbols.length >= MAX_BAZEL_SYMBOLS) return parent;
  const symbol = bazelSymbol(
    facts.file,
    facts.packageName,
    facts.identityOccurrences,
    facts.lineIndex,
    kind,
    name,
    qualifiedName,
    start,
    end,
    lookupKeys,
    signature,
  );
  facts.symbols.push(symbol);
  facts.edges.push(resolvedEdge(facts, parent, symbol, 'contains', 'syntactic', start, end));
  return symbol;
}

function bazelSymbol(
  file: CodeGraphInventoryFile,
  packageName: string | undefined,
  identityOccurrences: Map<string, number>,
  lineIndex: SourceLineIndex,
  kind: string,
  name: string,
  qualifiedName: string,
  start: number,
  end: number,
  lookupKeys: readonly string[],
  signature?: string,
): CodeGraphSymbol {
  const identity = `${kind}\n${qualifiedName}`;
  const occurrence = identityOccurrences.get(identity) ?? 0;
  identityOccurrences.set(identity, occurrence + 1);
  return {
    contentHash: file.contentHash,
    exported: !Effect.pipe(name, EffectString.startsWith('_')),
    id: `cgs_${Effect.pipe(
      sha256HexSync(`bazel-symbol-v1\n${file.path}\n${file.language}\n${kind}\n${qualifiedName}\n${occurrence}`),
      EffectString.slice(0, 32),
    )}`,
    kind,
    language: file.language,
    lookupKeys,
    name,
    packageName,
    path: file.path,
    qualifiedName,
    resolutionDomain: 'bazel',
    signature,
    span: sourceSpan(lineIndex, start, end),
  };
}

function addCallReference(
  facts: MutableBazelFacts,
  source: CodeGraphSymbol,
  callee: string,
  loadedBindings: ReadonlyMap<string, LoadedBinding>,
  start: number,
  end: number,
): void {
  if (!callee || BAZEL_NON_CALL_KEYWORDS.has(callee)) return;
  const local = Effect.pipe(callee, EffectString.split('.'))[0];
  const loaded = loadedBindings.get(local);
  const importedName = loaded ? `${loaded.label}%${loaded.imported}` : undefined;
  addReference(facts, source, callee, 'calls', 'syntactic', start, end, [
    ...(importedName ? [[bazelLabelKey(importedName)]] : []),
    [bazelNameKey(callee)],
    ...(Effect.pipe(callee, EffectString.includes('.'))
      ? [[bazelNameKey(Effect.pipe(callee, EffectString.split('.')).at(-1)!)]]
      : []),
  ]);
}

const BAZEL_NON_CALL_KEYWORDS = new Set(['def', 'for', 'if', 'lambda', 'load']);

function addReference(
  facts: MutableBazelFacts,
  source: CodeGraphSymbol,
  targetName: string,
  relation: CodeGraphRelation,
  provenance: CodeGraphProvenance,
  start: number,
  end: number,
  lookupTiers: readonly (readonly string[])[],
): void {
  if (facts.references.length >= MAX_BAZEL_REFERENCES) return;
  const id = `cge_${Effect.pipe(
    sha256HexSync(`bazel-edge-v1\n${facts.file.path}\n${source.id}\n${relation}\n${targetName}\n${provenance}`),
    EffectString.slice(0, 32),
  )}`;
  if (EffectArray.some(facts.edges, edge => edge.id === id)) return;
  const span = sourceSpan(facts.lineIndex, start, end);
  const edge: CodeGraphEdge = {
    confidence: provenance === 'declared' ? 1 : 0.75,
    evidencePath: facts.file.path,
    evidenceSpan: span,
    id,
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetName,
  };
  facts.edges.push(edge);
  facts.references.push({
    edgeId: id,
    evidencePath: facts.file.path,
    evidenceSpan: span,
    lookupTiers,
    provenance,
    relation,
    resolutionDomain: 'bazel',
    sourceId: source.id,
    sourceName: source.name,
    targetName,
  });
}

function resolvedEdge(
  facts: MutableBazelFacts,
  source: CodeGraphSymbol,
  target: CodeGraphSymbol,
  relation: CodeGraphRelation,
  provenance: CodeGraphProvenance,
  start: number,
  end: number,
): CodeGraphEdge {
  return {
    confidence: provenance === 'declared' ? 1 : 0.75,
    evidencePath: facts.file.path,
    evidenceSpan: sourceSpan(facts.lineIndex, start, end),
    id: `cge_${Effect.pipe(
      sha256HexSync(`bazel-edge-v1\n${facts.file.path}\n${source.id}\n${relation}\n${target.id}\n${provenance}`),
      EffectString.slice(0, 32),
    )}`,
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
  };
}

function createOwnerResolver(
  module: CodeGraphSymbol,
  definitions: ReadonlyMap<BazelDefinition, CodeGraphSymbol>,
  targets: readonly {readonly call: BazelCall; readonly symbol: CodeGraphSymbol}[],
): (offset: number) => CodeGraphSymbol {
  const intervals = [
    ...EffectArray.map([...definitions], ([definition, symbol]) => ({
      end: definition.bodyEnd,
      start: definition.start,
      symbol,
    })),
    ...EffectArray.map(targets, target => ({end: target.call.end, start: target.call.start, symbol: target.symbol})),
  ].sort((left, right) => left.start - right.start || right.end - left.end);
  let active: typeof intervals = [];
  let cursor = 0;
  let previousOffset = -1;
  return offset => {
    // Syntax calls arrive in source order. Reset defensively for a future parser
    // that does not preserve that contract.
    if (offset < previousOffset) {
      active = [];
      cursor = 0;
    }
    previousOffset = offset;
    active = EffectArray.filter(active, interval => interval.end >= offset);
    while (cursor < intervals.length && intervals[cursor].start <= offset) {
      const interval = intervals[cursor];
      if (interval.end >= offset) active.push(interval);
      cursor += 1;
    }
    let owner = module;
    let ownerStart = -1;
    let ownerEnd = Number.POSITIVE_INFINITY;
    for (const interval of active) {
      if (interval.start > ownerStart || (interval.start === ownerStart && interval.end < ownerEnd)) {
        owner = interval.symbol;
        ownerStart = interval.start;
        ownerEnd = interval.end;
      }
    }
    return owner;
  };
}

function bazelLabelKey(label: string): string {
  return `bazel:label:${label}`;
}

function bazelNameKey(name: string): string {
  return `bazel:name:${name}`;
}

function normalizedCallee(value: string): string {
  return Effect.pipe(value, EffectString.replace(/\s+/gu, ''));
}
