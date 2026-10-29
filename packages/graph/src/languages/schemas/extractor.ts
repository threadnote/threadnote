import {Array as EffectArray} from 'effect';
import * as yaml from 'js-yaml';
import {Option, Predicate} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeGraphExtractionContext} from '../types.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphRelation,
  CodeGraphSymbol,
} from '../../types.js';
import {createSourceLineIndex, sourceSpan, type SourceLineIndex} from '../source_line_index.js';
import {
  isLowSignalStructuredPath,
  isRecognizedStructuredPath,
  isXcodeAssetContentsPath,
  structuredObjectDeclarationBudget,
} from './policy.js';
import {canonicalCodeGraphMonikers, codeGraphProtobufMoniker} from '../../cross_repository/monikers.js';
import type {CodeGraphMonikerV1} from '../../cross_repository/types.js';
import {scanXmlAttributes, scanXmlStartTags} from '../xml_scan.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface MutableStructuredFacts {
  readonly diagnostics: string[];
  readonly edges: CodeGraphEdge[];
  readonly file: CodeGraphInventoryFile;
  readonly identityOccurrences: Map<string, number>;
  readonly lineIndex: SourceLineIndex | undefined;
  readonly module: CodeGraphSymbol;
  readonly monikers: CodeGraphMonikerV1[];
  readonly packageName: string | undefined;
  readonly symbols: CodeGraphSymbol[];
}

const MAX_STRUCTURED_SYMBOLS = 4_000;
const MAX_STRUCTURED_MONIKERS = 4_000;
const MAX_STRUCTURED_IMPORTS = 4_000;
const MAX_FULL_OBJECT_CONFIG_CHARACTERS = 4 * 1_024 * 1_024;
const MAX_RECOGNIZED_FULL_OBJECT_CONFIG_CHARACTERS = 16 * 1_024 * 1_024;
const MAX_SHALLOW_OBJECT_CONFIG_CHARACTERS = 1 * 1_024 * 1_024;
const MAX_SHALLOW_OBJECT_CONFIG_DEPTH = 2;
const MAX_SHALLOW_OBJECT_CONFIG_SYMBOLS = 128;
export function extractStructuredSchemaFacts(
  file: CodeGraphInventoryFile,
  context: CodeGraphExtractionContext,
): CodeGraphFileFacts {
  const omittedLowSignalContent =
    file.content === undefined && file.contentOmittedReason === 'metadata-only' && isLowSignalStructuredPath(file.path);
  if (file.content === undefined && !omittedLowSignalContent)
    throw new Error(`Repository content for ${file.path} was not loaded before extraction.`);
  const objectPolicy = ['json', 'jsonc', 'yaml'].includes(file.language)
    ? omittedLowSignalContent
      ? 'metadata'
      : objectConfigPolicy(file.path, file.content!.length)
    : undefined;
  const facts = createFacts(file, context, objectPolicy === 'metadata');
  try {
    switch (file.language) {
      case 'sql':
        extractSql(facts);
        break;
      case 'json':
      case 'jsonc':
      case 'yaml':
        extractObjectConfig(facts, objectPolicy ?? 'full');
        break;
      case 'toml':
        extractToml(facts);
        break;
      case 'ini':
      case 'properties':
        extractKeyValueConfig(facts);
        break;
      case 'graphql':
        extractGraphql(facts);
        break;
      case 'protobuf':
        extractProtobuf(facts);
        break;
      case 'msbuild':
      case 'xaml':
        extractXml(facts);
        break;
      case 'solution':
        extractSolution(facts);
        break;
      case 'dockerfile':
        extractDockerfile(facts);
        break;
    }
  } catch (cause) {
    facts.diagnostics.push(`${file.path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return {
    diagnostics: facts.diagnostics,
    edges: facts.edges,
    ...(facts.monikers.length === 0 ? {} : {monikers: canonicalCodeGraphMonikers(facts.monikers)}),
    path: file.path,
    symbols: facts.symbols,
  };
}

function createFacts(
  file: CodeGraphInventoryFile,
  context: CodeGraphExtractionContext,
  metadataOnly: boolean,
): MutableStructuredFacts {
  const packageName = Option.getOrUndefined(context.packageName);
  const identityOccurrences = new Map<string, number>();
  const contentLength = file.content?.length ?? 0;
  const lineIndex = metadataOnly ? undefined : createSourceLineIndex(file.content!);
  const module = structuredSymbol(
    file,
    packageName,
    'module',
    file.path,
    file.path,
    0,
    Math.min(contentLength, 1),
    file.path,
    identityOccurrences,
    lineIndex,
  );
  return {
    diagnostics: [],
    edges: [],
    file,
    identityOccurrences,
    lineIndex,
    module,
    monikers: [],
    packageName,
    symbols: [module],
  };
}

function extractObjectConfig(facts: MutableStructuredFacts, policy: ReturnType<typeof objectConfigPolicy>): void {
  const content = facts.file.content!;
  if (policy === 'metadata') {
    facts.diagnostics.push(
      `${facts.file.path}: low-signal or large unknown structured data was indexed as module metadata only`,
    );
    return;
  }
  if (policy === 'shallow') {
    extractShallowObjectConfig(facts);
    return;
  }
  let documents: readonly unknown[];
  if (facts.file.language === 'yaml') {
    documents = [];
    yaml.loadAll(
      content,
      value => {
        documents = [...documents, value];
      },
      {json: true, schema: yaml.FAILSAFE_SCHEMA},
    );
  } else {
    const source = facts.file.language === 'jsonc' ? normalizeJsonc(content) : content;
    documents = [JSON.parse(source) as unknown];
  }
  const seen = new WeakSet<object>();
  const declarationBudget = structuredObjectDeclarationBudget(facts.file.path);
  const maximumSymbols = declarationBudget.maximumDeclarations + 1;
  const locateConfigKey = createConfigKeyLocator(content, facts.file.language);
  const retainResourceValues = isXcodeAssetContentsPath(facts.file.path);
  const visit = (value: unknown, parent: CodeGraphSymbol, path: readonly string[], depth: number): void => {
    if (depth > declarationBudget.maximumDepth || facts.symbols.length >= maximumSymbols) return;
    if (typeof value !== 'object' || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    const addChild = (key: string, child: unknown, item: boolean) => {
      if (facts.symbols.length >= maximumSymbols) return;
      const qualifiedPath = [...path, key];
      const location = locateConfigKey(key);
      const symbol = addDeclaration(
        facts,
        parent,
        item ? 'item' : 'property',
        key,
        structuredPath(facts.file.path, qualifiedPath),
        location.start,
        location.end,
        `${facts.file.path}#${EffectArray.join(qualifiedPath, '.')}`,
      );
      if (retainResourceValues && isResourceScalar(child) && facts.symbols.length < maximumSymbols) {
        addResourceValue(facts, symbol, String(child), qualifiedPath, location.start, location.end);
      }
      visit(child, symbol, qualifiedPath, depth + 1);
    };
    if (EffectArray.isArray(value)) {
      for (let index = 0; index < value.length && facts.symbols.length < maximumSymbols; index += 1) {
        const child = value[index];
        if (typeof child === 'object' && child !== null) addChild(String(index), child, true);
      }
      return;
    }
    if (!Predicate.isObject(value)) return;
    const record = value;
    for (const key in record) {
      if (facts.symbols.length >= maximumSymbols) break;
      if (!EffectRecord.has(record, key)) continue;
      addChild(key, record[key], false);
    }
  };
  EffectArray.forEach(documents, (document, index) =>
    visit(document, facts.module, documents.length > 1 ? [`document-${index + 1}`] : [], 0),
  );
  if (facts.symbols.length >= maximumSymbols) {
    facts.diagnostics.push(
      `${facts.file.path}: ${declarationBudget.policy} structured declarations were bounded at ` +
        `${declarationBudget.maximumDeclarations}`,
    );
  }
}

function isResourceScalar(value: unknown): value is boolean | number | string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function addResourceValue(
  facts: MutableStructuredFacts,
  parent: CodeGraphSymbol,
  value: string,
  path: readonly string[],
  start: number,
  end: number,
): void {
  const symbol = addDeclaration(
    facts,
    parent,
    'resource-value',
    value,
    structuredPath(facts.file.path, [...path, '$value']),
    start,
    end,
    `${facts.file.path}#${EffectArray.join([...path, '$value'], '.')}`,
  );
  const lookupKeys = resourceValueLookupKeys(value);
  if (lookupKeys.length === 0) return;
  facts.symbols[facts.symbols.length - 1] = {...symbol, lookupKeys};
}

function resourceValueLookupKeys(value: string): readonly string[] {
  const expanded = EffectArray.filter(
    EffectArray.map(
      Effect.pipe(value, EffectString.replace(/([a-z0-9])([A-Z])/gu, '$1 $2'), EffectString.split(/[^A-Za-z0-9]+/gu)),
      part => Effect.pipe(part, EffectString.toLowerCase),
    ),
    part => part.length >= 2,
  );
  return [...new Set([value, ...expanded])];
}

interface ConfigKeyLocation {
  readonly end: number;
  readonly key: string;
  readonly start: number;
}

function createConfigKeyLocator(
  content: string,
  language: string,
): (key: string) => {readonly end: number; readonly start: number} {
  const locations = language === 'yaml' ? yamlKeyLocations(content) : jsonKeyLocations(content);
  let cursor = 0;
  return key => {
    for (let index = cursor; index < locations.length; index += 1) {
      const location = locations[index];
      if (location.key !== key) continue;
      cursor = index + 1;
      return {end: location.end, start: location.start};
    }
    cursor = locations.length;
    return {end: content.length, start: content.length};
  };
}

function jsonKeyLocations(content: string): readonly ConfigKeyLocation[] {
  const locations: ConfigKeyLocation[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    if (content[cursor] === '/' && content[cursor + 1] === '/') {
      cursor = skipLine(content, cursor + 2, content.length);
      continue;
    }
    if (content[cursor] === '/' && content[cursor + 1] === '*') {
      cursor = skipBlockComment(content, cursor + 2, content.length);
      continue;
    }
    if (content[cursor] !== '"') {
      cursor += 1;
      continue;
    }
    const token = jsonStringAt(content, cursor, content.length);
    if (token === undefined) break;
    const after = skipJsonTrivia(content, token.end, content.length);
    if (content[after] === ':') locations.push({end: token.end - 1, key: token.value, start: cursor + 1});
    cursor = token.end;
  }
  return locations;
}

function yamlKeyLocations(content: string): readonly ConfigKeyLocation[] {
  const locations: ConfigKeyLocation[] = [];
  for (const line of linesWithOffsets(content)) {
    const match = /^\s*(?:-\s+)?(?:"([^"]+)"|'([^']+)'|([^:#][^:]*?))\s*:(?:\s|$)/.exec(line.text);
    const raw = match?.[1] ?? match?.[2] ?? match?.[3];
    const key = Effect.pipe(raw, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    );
    if (!key) continue;
    const start =
      line.start +
      Math.max(
        0,
        Effect.pipe(
          line.text,
          EffectString.indexOf(raw!),
          Effect.Option.getOrElse(() => -1),
        ),
      );
    locations.push({end: start + raw!.length, key, start});
  }
  return locations;
}

function objectConfigPolicy(path: string, contentLength: number): 'full' | 'metadata' | 'shallow' {
  if (isLowSignalStructuredPath(path)) return 'metadata';
  if (isRecognizedStructuredPath(path)) {
    return contentLength <= MAX_RECOGNIZED_FULL_OBJECT_CONFIG_CHARACTERS ? 'full' : 'shallow';
  }
  return contentLength <= MAX_FULL_OBJECT_CONFIG_CHARACTERS ? 'full' : 'metadata';
}

function extractShallowObjectConfig(facts: MutableStructuredFacts): void {
  if (facts.file.language === 'yaml') extractShallowYaml(facts);
  else extractShallowJson(facts);
  facts.diagnostics.push(
    `${facts.file.path}: large structured ${facts.file.language} used bounded shallow extraction ` +
      `(first ${MAX_SHALLOW_OBJECT_CONFIG_CHARACTERS} characters, depth ${MAX_SHALLOW_OBJECT_CONFIG_DEPTH}, ` +
      `${MAX_SHALLOW_OBJECT_CONFIG_SYMBOLS} declarations); dedicated manifests remain fully extracted`,
  );
}

function extractShallowJson(facts: MutableStructuredFacts): void {
  const content = facts.file.content!;
  const limit = Math.min(content.length, MAX_SHALLOW_OBJECT_CONFIG_CHARACTERS);
  const containers: Array<{
    readonly kind: 'array' | 'object';
    readonly path: readonly string[];
    readonly symbol: CodeGraphSymbol;
    readonly suppressed: boolean;
  }> = [];
  let pending:
    {readonly path: readonly string[]; readonly symbol: CodeGraphSymbol; readonly valuePending: boolean} | undefined;
  let cursor = 0;
  while (cursor < limit && facts.symbols.length - 1 < MAX_SHALLOW_OBJECT_CONFIG_SYMBOLS) {
    const character = content[cursor];
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === '/' && content[cursor + 1] === '/') {
      cursor = skipLine(content, cursor + 2, limit);
      continue;
    }
    if (character === '/' && content[cursor + 1] === '*') {
      cursor = skipBlockComment(content, cursor + 2, limit);
      continue;
    }
    if (character === '"') {
      const token = jsonStringAt(content, cursor, limit);
      if (token === undefined) break;
      const parent = containers.at(-1);
      const after = skipJsonTrivia(content, token.end, limit);
      if (
        parent?.kind === 'object' &&
        !parent.suppressed &&
        parent.path.length < MAX_SHALLOW_OBJECT_CONFIG_DEPTH &&
        content[after] === ':'
      ) {
        const path = [...parent.path, token.value];
        const symbol = addDeclaration(
          facts,
          parent.symbol,
          'property',
          token.value,
          structuredPath(facts.file.path, path),
          cursor,
          token.end,
          `${facts.file.path}#${EffectArray.join(path, '.')}`,
        );
        pending = {path, symbol, valuePending: true};
        cursor = after + 1;
        continue;
      }
      if (pending?.valuePending) pending = undefined;
      cursor = token.end;
      continue;
    }
    if (character === '{' || character === '[') {
      const parent = containers.at(-1);
      const inherited = pending?.valuePending ? pending : undefined;
      containers.push({
        kind: character === '{' ? 'object' : 'array',
        path: inherited?.path ?? parent?.path ?? [],
        suppressed: parent?.suppressed === true || parent?.kind === 'array',
        symbol: inherited?.symbol ?? parent?.symbol ?? facts.module,
      });
      pending = undefined;
      cursor += 1;
      continue;
    }
    if (character === '}' || character === ']') {
      containers.pop();
      pending = undefined;
      cursor += 1;
      continue;
    }
    if (character === ',') pending = undefined;
    else if (pending?.valuePending && character !== ':') pending = undefined;
    cursor += 1;
  }
}

function extractShallowYaml(facts: MutableStructuredFacts): void {
  const content = facts.file.content!;
  const limit = Math.min(content.length, MAX_SHALLOW_OBJECT_CONFIG_CHARACTERS);
  const scopes: Array<{readonly indent: number; readonly path: readonly string[]; readonly symbol: CodeGraphSymbol}> = [
    {indent: -1, path: [], symbol: facts.module},
  ];
  let start = 0;
  while (start < limit && facts.symbols.length - 1 < MAX_SHALLOW_OBJECT_CONFIG_SYMBOLS) {
    let end = start;
    while (end < limit && !isLineTerminator(content[end])) end += 1;
    const line = Effect.pipe(content, EffectString.slice(start, end));
    const match = /^(\s*)(?!-\s)(?:["']([^"']+)["']|([^:#][^:]*?))\s*:(?:\s|$)/.exec(line);
    if (match) {
      const indent = yamlIndent(match[1]);
      const key = Effect.pipe(match[2] ?? match[3] ?? '', EffectString.trim);
      while (scopes.length > 1 && scopes.at(-1)!.indent >= indent) scopes.pop();
      const parent = scopes.at(-1)!;
      if (key && parent.path.length < MAX_SHALLOW_OBJECT_CONFIG_DEPTH) {
        const path = [...parent.path, key];
        const keyOffset =
          start +
          Effect.pipe(
            line,
            EffectString.indexOf(match[2] ?? match[3] ?? key),
            Effect.Option.getOrElse(() => -1),
          );
        const symbol = addDeclaration(
          facts,
          parent.symbol,
          'property',
          key,
          structuredPath(facts.file.path, path),
          keyOffset,
          keyOffset + Math.max(1, key.length),
          `${facts.file.path}#${EffectArray.join(path, '.')}`,
        );
        if (/:\s*(?:#.*)?$/.test(line)) scopes.push({indent, path, symbol});
      }
    }
    if (end >= limit) break;
    start = end + lineTerminatorWidth(content, end);
  }
}

function jsonStringAt(
  content: string,
  start: number,
  limit: number,
): {readonly end: number; readonly value: string} | undefined {
  let escaped = false;
  for (let cursor = start + 1; cursor < limit; cursor += 1) {
    const character = content[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    const end = cursor + 1;
    try {
      const value: unknown = JSON.parse(Effect.pipe(content, EffectString.slice(start, end)));
      return typeof value === 'string' ? {end, value} : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function skipJsonTrivia(content: string, offset: number, limit: number): number {
  let cursor = offset;
  while (cursor < limit) {
    if (/\s/u.test(content[cursor])) cursor += 1;
    else if (content[cursor] === '/' && content[cursor + 1] === '/') cursor = skipLine(content, cursor + 2, limit);
    else if (content[cursor] === '/' && content[cursor + 1] === '*')
      cursor = skipBlockComment(content, cursor + 2, limit);
    else break;
  }
  return cursor;
}

function skipLine(content: string, offset: number, limit: number): number {
  let cursor = offset;
  while (cursor < limit && !isLineTerminator(content[cursor])) cursor += 1;
  return cursor;
}

function skipBlockComment(content: string, offset: number, limit: number): number {
  let cursor = offset;
  while (cursor < limit - 1) {
    if (content[cursor] === '*' && content[cursor + 1] === '/') return cursor + 2;
    cursor += 1;
  }
  return limit;
}

function yamlIndent(value: string): number {
  let width = 0;
  for (const character of value) width += character === '\t' ? 2 : 1;
  return width;
}

function extractToml(facts: MutableStructuredFacts): void {
  const content = facts.file.content!;
  let table = facts.module;
  let tableIdentityQualifiedName = facts.file.path;
  for (const line of linesWithOffsets(content)) {
    const tableMatch = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line.text);
    if (tableMatch) {
      const name = Effect.pipe(tableMatch[1], EffectString.trim);
      table = addDeclaration(
        facts,
        facts.module,
        'table',
        name,
        structuredPath(facts.file.path, [name]),
        line.start,
        line.end,
        `${facts.file.path}#${name}`,
      );
      tableIdentityQualifiedName = `${facts.file.path}#${name}`;
      continue;
    }
    const keyMatch = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line.text);
    if (!keyMatch) continue;
    const name = keyMatch[1];
    addDeclaration(
      facts,
      table,
      'property',
      name,
      structuredChild(table.qualifiedName, name),
      line.start,
      line.end,
      `${tableIdentityQualifiedName}.${name}`,
    );
  }
}

function extractKeyValueConfig(facts: MutableStructuredFacts): void {
  let section = facts.module;
  let sectionIdentityQualifiedName = facts.file.path;
  for (const line of linesWithOffsets(facts.file.content!)) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line.text);
    if (sectionMatch) {
      const name = Effect.pipe(sectionMatch[1], EffectString.trim);
      section = addDeclaration(
        facts,
        facts.module,
        'section',
        name,
        structuredPath(facts.file.path, [name]),
        line.start,
        line.end,
        `${facts.file.path}#${name}`,
      );
      sectionIdentityQualifiedName = `${facts.file.path}#${name}`;
      continue;
    }
    const keyMatch = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*(?:=|:)/.exec(line.text);
    if (!keyMatch) continue;
    const name = keyMatch[1];
    addDeclaration(
      facts,
      section,
      'property',
      name,
      structuredChild(section.qualifiedName, name),
      line.start,
      line.end,
      `${sectionIdentityQualifiedName}.${name}`,
    );
  }
}

function extractSql(facts: MutableStructuredFacts): void {
  const content = facts.file.content!;
  const declarations: Array<{readonly offset: number; readonly symbol: CodeGraphSymbol}> = [];
  const declaration =
    /(?:^|[;\r\n])\s*create\s+(?:or\s+replace\s+)?(?:global\s+|local\s+)?(?:temporary\s+|temp\s+)?(materialized\s+view|table|view|index|function|procedure|trigger|type|schema|sequence)\s+(?:if\s+not\s+exists\s+)?([`"[]?[A-Za-z_][\w$.-]*(?:\s*\.\s*[`"[]?[A-Za-z_][\w$-]*[`"\]]?)*[`"\]]?)/gi;
  for (const match of Effect.pipe(content, EffectString.matchAll(declaration))) {
    const kind = Effect.pipe(match[1], EffectString.toLowerCase, EffectString.replace(/\s+/g, '_'));
    const name = normalizeSqlIdentifier(match[2]);
    const offset = match.index ?? 0;
    const symbol = addDeclaration(facts, facts.module, kind, name, name, offset, offset + match[0].length);
    declarations.push({offset, symbol});
  }
  const references =
    /\b(?:references|from|join|update|into)\s+([`"[]?[A-Za-z_][\w$.-]*(?:\s*\.\s*[`"[]?[A-Za-z_][\w$-]*[`"\]]?)*[`"\]]?)/gi;
  for (const match of Effect.pipe(content, EffectString.matchAll(references))) {
    const target = normalizeSqlIdentifier(match[1]);
    if (!target) continue;
    const offset = match.index ?? 0;
    let owner = facts.module;
    for (const candidate of declarations) {
      if (candidate.offset > offset) break;
      owner = candidate.symbol;
    }
    addUnresolvedEdge(facts, owner, target, 'references', 'syntactic', offset, offset + match[0].length);
  }
}

function extractGraphql(facts: MutableStructuredFacts): void {
  const expression =
    /^\s*(extend\s+)?(schema|type|interface|input|enum|scalar|union|directive)\s+@?([_A-Za-z][_0-9A-Za-z]*)/gim;
  for (const match of Effect.pipe(facts.file.content!, EffectString.matchAll(expression))) {
    const kind = `${match[1] ? 'extended_' : ''}${Effect.pipe(match[2], EffectString.toLowerCase)}`;
    const name = match[3];
    const offset = match.index ?? 0;
    addDeclaration(facts, facts.module, kind, name, name, offset, offset + match[0].length);
  }
}

function extractProtobuf(facts: MutableStructuredFacts): void {
  const content = facts.file.content!;
  const declarationsSource = maskCStyleNonCode(content, true);
  const packageMatch = /\bpackage\s+([\w.]+)\s*;/.exec(declarationsSource);
  const namespace = packageMatch?.[1];
  const moduleSpan = facts.module.span;
  let monikersTruncated = false;
  let monikersRejected = false;
  const addMoniker = (create: () => CodeGraphMonikerV1): void => {
    if (facts.monikers.length >= MAX_STRUCTURED_MONIKERS) {
      monikersTruncated = true;
      return;
    }
    try {
      facts.monikers.push(create());
    } catch {
      monikersRejected = true;
    }
  };
  addMoniker(() =>
    codeGraphProtobufMoniker({
      evidence: {path: facts.file.path, span: moduleSpan},
      importPath: facts.file.path,
      kind: 'file',
      role: 'export',
      symbolId: facts.module.id,
    }),
  );
  if (namespace && packageMatch) {
    const offset = packageMatch.index ?? 0;
    addMoniker(() =>
      codeGraphProtobufMoniker({
        evidence: {
          path: facts.file.path,
          span: sourceSpan(requiredLineIndex(facts), offset, offset + packageMatch[0].length),
        },
        kind: 'package',
        packageName: namespace,
        role: 'export',
        symbolId: facts.module.id,
      }),
    );
  }
  const token = /\b(message|enum|service|rpc|oneof)\s+([A-Za-z_]\w*)|[{}]/gi;
  const scopes: Array<CodeGraphSymbol | undefined> = [];
  let pendingScope: CodeGraphSymbol | undefined;
  let declarationsTruncated = false;
  for (const match of Effect.pipe(declarationsSource, EffectString.matchAll(token))) {
    if (facts.symbols.length >= MAX_STRUCTURED_SYMBOLS) {
      declarationsTruncated = true;
      break;
    }
    const text = match[0];
    if (text === '{') {
      scopes.push(pendingScope);
      pendingScope = undefined;
      continue;
    }
    if (text === '}') {
      scopes.pop();
      pendingScope = undefined;
      continue;
    }
    const name = match[2];
    const kind: string = Effect.pipe(match[1], EffectString.toLowerCase);
    const offset = match.index ?? 0;
    const parent =
      Option.getOrUndefined(
        EffectArray.findFirst([...scopes].reverse(), (scope): scope is CodeGraphSymbol => scope !== undefined),
      ) ?? facts.module;
    const parentQualifiedName = parent === facts.module ? namespace : parent.qualifiedName;
    const declaration = addDeclaration(
      facts,
      parent,
      kind,
      name,
      parentQualifiedName ? `${parentQualifiedName}.${name}` : name,
      offset,
      offset + text.length,
    );
    pendingScope = declaration;
    if (kind === 'message' || kind === 'service' || kind === 'rpc') {
      addMoniker(() =>
        codeGraphProtobufMoniker({
          evidence: {path: facts.file.path, span: declaration.span},
          kind,
          ...(namespace === undefined ? {} : {packageName: namespace}),
          qualifiedName: declaration.qualifiedName,
          role: 'export',
          symbolId: declaration.id,
        }),
      );
    }
  }
  if (declarationsTruncated) {
    facts.diagnostics.push(`${facts.file.path}: protobuf declarations were bounded at ${MAX_STRUCTURED_SYMBOLS}`);
  }
  let imports = 0;
  let importsTruncated = false;
  for (const statementSpan of protobufImportStatementSpans(declarationsSource)) {
    if (imports >= MAX_STRUCTURED_IMPORTS) {
      importsTruncated = true;
      break;
    }
    const offset = statementSpan.start;
    const statement = Effect.pipe(content, EffectString.slice(offset, statementSpan.end));
    const importPath = protobufImportPath(statement);
    if (importPath === undefined) continue;
    addMoniker(() =>
      codeGraphProtobufMoniker({
        evidence: {
          path: facts.file.path,
          span: sourceSpan(requiredLineIndex(facts), offset, statementSpan.end),
        },
        importPath,
        kind: 'file',
        role: 'import',
        symbolId: facts.module.id,
      }),
    );
    addUnresolvedEdge(facts, facts.module, importPath, 'imports', 'declared', offset, statementSpan.end);
    imports += 1;
  }
  if (monikersTruncated) {
    facts.diagnostics.push(
      `${facts.file.path}: protobuf monikers exceeded ${MAX_STRUCTURED_MONIKERS} entries and were truncated`,
    );
  }
  if (monikersRejected) {
    facts.diagnostics.push(
      `${facts.file.path}: one or more protobuf declarations or imports could not form scoped cross-repository monikers`,
    );
  }
  if (importsTruncated) {
    facts.diagnostics.push(`${facts.file.path}: protobuf imports were bounded at ${MAX_STRUCTURED_IMPORTS}`);
  }
}

function* protobufImportStatementSpans(
  maskedSource: string,
): IterableIterator<{readonly end: number; readonly start: number}> {
  const keyword = 'import';
  const normalizedSource = Effect.pipe(maskedSource, EffectString.toLowerCase);
  let cursor = 0;
  while (cursor < maskedSource.length) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    const start = normalizedSource.indexOf(keyword, cursor);
    if (start < 0) return;
    const before = maskedSource[start - 1];
    const after = maskedSource[start + keyword.length];
    if ((before && /[A-Za-z0-9_]/u.test(before)) || !after || !/\s/u.test(after)) {
      cursor = start + keyword.length;
      continue;
    }
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    const semicolon = maskedSource.indexOf(';', start + keyword.length);
    if (semicolon < 0) return;
    const modifier = Effect.pipe(
      maskedSource,
      EffectString.slice(start + keyword.length, semicolon),
      EffectString.trim,
      EffectString.toLowerCase,
    );
    if (!modifier || modifier === 'public' || modifier === 'weak') yield {end: semicolon + 1, start};
    cursor = semicolon + 1;
  }
}

function protobufImportPath(statement: string): string | undefined {
  let remainder = Effect.pipe(statement, __effectPipeInput => {
    const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.slice('import'.length));
    const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.trimStart);
    return __effectPipeStage1;
  });
  for (const modifier of ['public', 'weak']) {
    if (Effect.pipe(remainder, EffectString.startsWith(modifier)) && /\s/u.test(remainder[modifier.length] ?? '')) {
      remainder = Effect.pipe(remainder, EffectString.slice(modifier.length), EffectString.trimStart);
      break;
    }
  }
  const quote = remainder[0];
  if (quote !== '"' && quote !== "'") return undefined;
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
  const closing = remainder.indexOf(quote, 1);
  if (closing <= 1 || Effect.pipe(remainder, EffectString.slice(closing + 1), EffectString.trim) !== ';')
    return undefined;
  return Effect.pipe(remainder, EffectString.slice(1, closing));
}

function extractXml(facts: MutableStructuredFacts): void {
  const content = facts.file.content!;
  for (const element of scanXmlStartTags(content)) {
    if (facts.symbols.length >= MAX_STRUCTURED_SYMBOLS) break;
    const tag = element.name;
    const identity = Option.getOrUndefined(
      EffectArray.findFirst(
        [...scanXmlAttributes(element.attributes)],
        __effectArrayValue =>
          !!(attribute => ['x:Class', 'x:Name', 'Name', 'Include', 'Update', 'Remove', 'Id'].includes(attribute.name))(
            __effectArrayValue,
          ),
      ),
    )?.value;
    if (!identity && !/^(?:Project|PackageReference|ProjectReference|Target|PropertyGroup|ItemGroup)$/i.test(tag))
      continue;
    const name = identity ?? tag;
    const offset = element.offset;
    const symbol = addDeclaration(
      facts,
      facts.module,
      Effect.pipe(tag, EffectString.toLowerCase),
      name,
      `${tag}:${name}`,
      offset,
      element.end,
    );
    if (/^(?:PackageReference|ProjectReference)$/i.test(tag) && identity) {
      addUnresolvedEdge(facts, symbol, identity, 'depends_on', 'declared', offset, element.end);
    }
  }
}

function extractSolution(facts: MutableStructuredFacts): void {
  const expression = /^Project\("[^"\r\n]+"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/gim;
  for (const match of Effect.pipe(facts.file.content!, EffectString.matchAll(expression))) {
    const offset = match.index ?? 0;
    const symbol = addDeclaration(facts, facts.module, 'project', match[1], match[1], offset, offset + match[0].length);
    addUnresolvedEdge(facts, symbol, match[2], 'depends_on', 'declared', offset, offset + match[0].length);
  }
}

function extractDockerfile(facts: MutableStructuredFacts): void {
  let stage = facts.module;
  for (const line of linesWithOffsets(facts.file.content!)) {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line.text);
    if (from) {
      const name = from[2] ?? from[1];
      stage = addDeclaration(facts, facts.module, 'stage', name, name, line.start, line.end);
      addUnresolvedEdge(facts, stage, from[1], 'depends_on', 'declared', line.start, line.end);
      continue;
    }
    const copy = /^\s*COPY\s+--from=(\S+)/i.exec(line.text);
    if (copy) addUnresolvedEdge(facts, stage, copy[1], 'depends_on', 'declared', line.start, line.end);
  }
}

function addDeclaration(
  facts: MutableStructuredFacts,
  parent: CodeGraphSymbol,
  kind: string,
  name: string,
  qualifiedName: string,
  start: number,
  end: number,
  identityQualifiedName: string = qualifiedName,
): CodeGraphSymbol {
  const symbol = structuredSymbol(
    facts.file,
    facts.packageName,
    kind,
    name,
    qualifiedName,
    start,
    end,
    identityQualifiedName,
    facts.identityOccurrences,
    requiredLineIndex(facts),
  );
  facts.symbols.push(symbol);
  facts.edges.push(resolvedEdge(facts, parent, symbol, 'contains', 'syntactic', start, end));
  return symbol;
}

function structuredSymbol(
  file: CodeGraphInventoryFile,
  packageName: string | undefined,
  kind: string,
  name: string,
  qualifiedName: string,
  start: number,
  end: number,
  identityQualifiedName: string,
  identityOccurrences: Map<string, number>,
  lineIndex: SourceLineIndex | undefined,
): CodeGraphSymbol {
  const identityKey = `${kind}\n${identityQualifiedName}`;
  const occurrence = identityOccurrences.get(identityKey) ?? 0;
  identityOccurrences.set(identityKey, occurrence + 1);
  return {
    contentHash: file.contentHash,
    exported: true,
    id: structuredSymbolId(file.path, file.language, kind, qualifiedName, identityQualifiedName, occurrence),
    kind,
    language: file.language,
    name,
    packageName,
    path: file.path,
    qualifiedName,
    resolutionDomain: 'structured-schema',
    span:
      lineIndex === undefined
        ? {column: 1, endColumn: Math.max(1, end - start + 1), endLine: 1, line: 1}
        : sourceSpan(lineIndex, start, end),
  };
}

export function relocateStructuredSchemaFacts(
  file: Pick<CodeGraphInventoryFile, 'contentHash' | 'language' | 'path'>,
  facts: CodeGraphFileFacts,
): CodeGraphFileFacts | undefined {
  const sourcePath = facts.path;
  if (
    sourcePath === file.path ||
    (facts.monikers?.length ?? 0) > 0 ||
    facts.references !== undefined ||
    facts.symbols.length === 0 ||
    EffectArray.some(
      facts.symbols,
      symbol =>
        symbol.path !== sourcePath ||
        symbol.contentHash !== file.contentHash ||
        symbol.language !== file.language ||
        symbol.resolutionDomain !== 'structured-schema' ||
        symbol.resolutionScopeId !== undefined ||
        symbol.packageName !== undefined ||
        symbol.lookupKeys !== undefined ||
        symbol.documentation !== undefined ||
        symbol.signature !== undefined,
    ) ||
    EffectArray.some(facts.edges, edge => edge.evidencePath !== sourcePath)
  ) {
    return undefined;
  }

  const occurrences = new Map<string, number>();
  const ids = new Map<string, string>();
  const symbolsByOldId = new Map<string, CodeGraphSymbol>();
  const relocatedSymbols: CodeGraphSymbol[] = [];
  for (const symbol of facts.symbols) {
    if (ids.has(symbol.id)) return undefined;
    const qualifiedName = relocateStructuredPathValue(symbol.qualifiedName, sourcePath, file.path);
    const identityQualifiedName = structuredIdentityQualifiedName(symbol, sourcePath, file.path);
    if (identityQualifiedName === undefined) return undefined;
    const identityKey = `${symbol.kind}\n${identityQualifiedName}`;
    const occurrence = occurrences.get(identityKey) ?? 0;
    occurrences.set(identityKey, occurrence + 1);
    const id = structuredSymbolId(
      file.path,
      file.language,
      symbol.kind,
      qualifiedName,
      identityQualifiedName,
      occurrence,
    );
    const relocated = {
      ...symbol,
      contentHash: file.contentHash,
      id,
      name: symbol.kind === 'module' && symbol.name === sourcePath ? file.path : symbol.name,
      path: file.path,
      qualifiedName,
    } satisfies CodeGraphSymbol;
    ids.set(symbol.id, id);
    symbolsByOldId.set(symbol.id, relocated);
    relocatedSymbols.push(relocated);
  }

  const relocatedEdges: CodeGraphEdge[] = [];
  for (const edge of facts.edges) {
    if (edge.sourceId === undefined) return undefined;
    const sourceId = ids.get(edge.sourceId);
    const targetId = edge.targetId === undefined ? undefined : ids.get(edge.targetId);
    if (sourceId === undefined || (edge.targetId !== undefined && targetId === undefined)) return undefined;
    const sourceName = symbolsByOldId.get(edge.sourceId)?.name;
    const targetName = edge.targetId === undefined ? edge.targetName : symbolsByOldId.get(edge.targetId)?.name;
    if (sourceName === undefined || targetName === undefined) return undefined;
    relocatedEdges.push({
      ...edge,
      evidencePath: file.path,
      id: structuredEdgeId(file.path, sourceId, edge.relation, targetId ?? targetName, edge.provenance),
      sourceId,
      sourceName,
      ...(targetId === undefined ? {} : {targetId}),
      targetName,
    });
  }

  return {
    ...facts,
    diagnostics: EffectArray.map(facts.diagnostics, diagnostic =>
      Effect.pipe(diagnostic, EffectString.startsWith(`${sourcePath}:`))
        ? `${file.path}${Effect.pipe(diagnostic, EffectString.slice(sourcePath.length))}`
        : diagnostic,
    ),
    edges: relocatedEdges,
    path: file.path,
    symbols: relocatedSymbols,
  };
}

function structuredSymbolId(
  path: string,
  language: string,
  kind: string,
  qualifiedName: string,
  identityQualifiedName: string,
  occurrence: number,
): string {
  return occurrence === 0
    ? `cgs_${Effect.pipe(sha256HexSync(`structured-symbol-v1\n${path}\n${language}\n${kind}\n${identityQualifiedName}`), EffectString.slice(0, 32))}`
    : `cgs_${Effect.pipe(
        sha256HexSync(`structured-symbol-v2\n${path}\n${language}\n${kind}\n${qualifiedName}\n${occurrence}`),
        EffectString.slice(0, 32),
      )}`;
}

function relocateStructuredPathValue(value: string, sourcePath: string, targetPath: string): string {
  if (value === sourcePath) return targetPath;
  return Effect.pipe(value, EffectString.startsWith(`${sourcePath}#`))
    ? `${targetPath}${Effect.pipe(value, EffectString.slice(sourcePath.length))}`
    : value;
}

function structuredIdentityQualifiedName(
  symbol: CodeGraphSymbol,
  sourcePath: string,
  targetPath: string,
): string | undefined {
  if (symbol.kind === 'module') return symbol.qualifiedName === sourcePath ? targetPath : undefined;
  const prefix = `${sourcePath}#/`;
  if (!Effect.pipe(symbol.qualifiedName, EffectString.startsWith(prefix))) return undefined;
  const segments = EffectArray.map(
    Effect.pipe(symbol.qualifiedName, EffectString.slice(prefix.length), EffectString.split('/')),
    segment => Effect.pipe(segment, EffectString.replaceAll('~1', '/'), EffectString.replaceAll('~0', '~')),
  );
  return `${targetPath}#${EffectArray.join(segments, '.')}`;
}

function structuredPath(filePath: string, segments: readonly string[]): string {
  return `${filePath}#/${EffectArray.join(EffectArray.map(segments, escapeStructuredSegment), '/')}`;
}

function structuredChild(parent: string, name: string): string {
  return `${parent}/${escapeStructuredSegment(name)}`;
}

function escapeStructuredSegment(value: string): string {
  return Effect.pipe(value, EffectString.replaceAll('~', '~0'), EffectString.replaceAll('/', '~1'));
}

function resolvedEdge(
  facts: MutableStructuredFacts,
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
    evidenceSpan: sourceSpan(requiredLineIndex(facts), start, end),
    id: edgeId(facts.file.path, source.id, relation, target.id, provenance),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
  };
}

function addUnresolvedEdge(
  facts: MutableStructuredFacts,
  source: CodeGraphSymbol,
  targetName: string,
  relation: CodeGraphRelation,
  provenance: CodeGraphProvenance,
  start: number,
  end: number,
): void {
  facts.edges.push({
    confidence: provenance === 'declared' ? 1 : 0.75,
    evidencePath: facts.file.path,
    evidenceSpan: sourceSpan(requiredLineIndex(facts), start, end),
    id: edgeId(facts.file.path, source.id, relation, targetName, provenance),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetName,
  });
}

function edgeId(path: string, source: string, relation: string, target: string, provenance: string): string {
  return structuredEdgeId(path, source, relation, target, provenance);
}

function structuredEdgeId(path: string, source: string, relation: string, target: string, provenance: string): string {
  return `cge_${Effect.pipe(sha256HexSync(`structured-edge-v1\n${path}\n${source}\n${relation}\n${target}\n${provenance}`), EffectString.slice(0, 32))}`;
}

function requiredLineIndex(facts: MutableStructuredFacts): SourceLineIndex {
  if (facts.lineIndex === undefined) throw new Error('structured metadata-only extraction cannot emit source spans');
  return facts.lineIndex;
}

function linesWithOffsets(
  content: string,
): readonly {readonly end: number; readonly start: number; readonly text: string}[] {
  const output: Array<{end: number; start: number; text: string}> = [];
  let start = 0;
  let cursor = 0;
  while (cursor < content.length) {
    const width = lineTerminatorWidth(content, cursor);
    if (width === 0) {
      cursor += 1;
      continue;
    }
    output.push({end: cursor, start, text: Effect.pipe(content, EffectString.slice(start, cursor))});
    cursor += width;
    start = cursor;
  }
  output.push({end: content.length, start, text: Effect.pipe(content, EffectString.slice(start))});
  return output;
}

function lineTerminatorWidth(content: string, offset: number): number {
  const character = content[offset];
  if (character === '\r') return content[offset + 1] === '\n' ? 2 : 1;
  return character === '\n' || character === '\u2028' || character === '\u2029' ? 1 : 0;
}

function stripJsonComments(value: string): string {
  return maskCStyleNonCode(value, false);
}

function normalizeJsonc(value: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
  const output = stripJsonComments(value).split('');
  let escaped = false;
  let inString = false;
  for (let index = 0; index < output.length; index += 1) {
    const current = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      continue;
    }
    if (current !== ',') continue;
    let lookahead = index + 1;
    while (lookahead < output.length && /\s/u.test(output[lookahead])) lookahead += 1;
    if (output[lookahead] === '}' || output[lookahead] === ']') output[index] = ' ';
  }
  if (output[0] === '\uFEFF') output[0] = ' ';
  return EffectArray.join(output, '');
}

function maskCStyleNonCode(value: string, maskStrings: boolean): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
  const output = value.split('');
  let mode: 'block-comment' | 'code' | 'line-comment' | 'string' = 'code';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];
    if (mode === 'line-comment') {
      if (isLineTerminator(current)) mode = 'code';
      else output[index] = ' ';
      continue;
    }
    if (mode === 'block-comment') {
      if (current === '*' && next === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        mode = 'code';
      } else if (!isLineTerminator(current)) output[index] = ' ';
      continue;
    }
    if (mode === 'string') {
      if (maskStrings && !isLineTerminator(current)) output[index] = ' ';
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) mode = 'code';
      continue;
    }
    if (current === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      mode = 'line-comment';
    } else if (current === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      mode = 'block-comment';
    } else if (current === '"' || current === "'") {
      if (maskStrings) output[index] = ' ';
      quote = current;
      escaped = false;
      mode = 'string';
    }
  }
  return EffectArray.join(output, '');
}

function isLineTerminator(character: string): boolean {
  return character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029';
}

function normalizeSqlIdentifier(value: string): string {
  return Effect.pipe(
    value,
    EffectString.replace(/[\s`"[\]]/g, ''),
    EffectString.replace(/\.+/g, '.'),
    EffectString.replace(/^\.|\.$/g, ''),
  );
}
