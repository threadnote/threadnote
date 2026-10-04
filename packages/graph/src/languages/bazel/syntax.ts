import {Option} from 'effect';
import {trimBoundaryCharacters} from '@threadnote/platform/string-boundaries';

export interface BazelStringLiteral {
  readonly end: number;
  readonly start: number;
  readonly value: string;
}

export interface BazelAttribute {
  readonly end: number;
  readonly name: string;
  readonly start: number;
  readonly strings: readonly BazelStringLiteral[];
}

export interface BazelCall {
  readonly attributes: readonly BazelAttribute[];
  readonly callee: string;
  readonly end: number;
  readonly start: number;
  readonly strings: readonly BazelStringLiteral[];
  readonly topLevel: boolean;
}

export interface BazelDefinition {
  readonly bodyEnd: number;
  readonly end: number;
  readonly name: string;
  readonly start: number;
}

export interface BazelAssignment {
  readonly end: number;
  readonly name: string;
  readonly start: number;
}

export interface BazelSyntax {
  readonly assignments: readonly BazelAssignment[];
  readonly bounded: boolean;
  readonly calls: readonly BazelCall[];
  readonly definitions: readonly BazelDefinition[];
}

const MAX_BAZEL_CALLS = 8_000;
const MAX_BAZEL_DECLARATIONS = 4_000;
const MAX_BAZEL_STRING_LITERALS = 16_000;

export function parseBazelSyntax(content: string): BazelSyntax {
  const masked = maskBazelNonCode(content);
  const definitions = scanDefinitions(masked);
  const assignments = scanAssignments(masked);
  const calls: BazelCall[] = [];
  let stringCount = 0;
  let bounded = definitions.length >= MAX_BAZEL_DECLARATIONS || assignments.length >= MAX_BAZEL_DECLARATIONS;
  const nesting = {braces: 0, brackets: 0, parentheses: 0};
  for (let index = 0; index < masked.length && calls.length < MAX_BAZEL_CALLS; index += 1) {
    const character = masked[index];
    if (isIdentifierStart(character) && !isIdentifierPart(masked[index - 1] ?? '')) {
      const start = index;
      index = scanDottedIdentifier(masked, index);
      const callee = masked.slice(start, index);
      let open = index;
      while (/\s/u.test(masked[open] ?? '')) open += 1;
      if (masked[open] === '(' && !isDefinitionName(masked, start)) {
        const close = findMatchingDelimiter(masked, open, '(', ')');
        if (close !== undefined) {
          const strings = scanStringLiterals(content, open + 1, close, MAX_BAZEL_STRING_LITERALS - stringCount);
          stringCount += strings.length;
          const attributes = scanAttributes(content, masked, open + 1, close);
          calls.push({
            attributes,
            callee,
            end: close + 1,
            start,
            strings,
            topLevel:
              nesting.braces === 0 &&
              nesting.brackets === 0 &&
              nesting.parentheses === 0 &&
              /^\s*$/u.test(masked.slice(lineStart(masked, start), start)),
          });
          if (stringCount >= MAX_BAZEL_STRING_LITERALS) bounded = true;
        }
      }
      index -= 1;
      continue;
    }
    if (character === '{') nesting.braces += 1;
    else if (character === '}') nesting.braces = Math.max(0, nesting.braces - 1);
    else if (character === '[') nesting.brackets += 1;
    else if (character === ']') nesting.brackets = Math.max(0, nesting.brackets - 1);
    else if (character === '(') nesting.parentheses += 1;
    else if (character === ')') nesting.parentheses = Math.max(0, nesting.parentheses - 1);
  }
  if (calls.length >= MAX_BAZEL_CALLS) bounded = true;
  return {
    assignments: assignments.slice(0, MAX_BAZEL_DECLARATIONS),
    bounded,
    calls,
    definitions: definitions.slice(0, MAX_BAZEL_DECLARATIONS),
  };
}

export function bazelAttribute(call: BazelCall, name: string): Option.Option<BazelAttribute> {
  return Option.fromUndefinedOr(call.attributes.find(attribute => attribute.name === name));
}

export function canonicalBazelLabel(raw: string, packagePath: string): Option.Option<string> {
  const label = raw.trim();
  if (!label || /[\s\r\n]/u.test(label)) return Option.none();
  if (label.startsWith(':')) return label.length > 1 ? Option.some(`//${packagePath}${label}`) : Option.none();
  if (!label.startsWith('//') && !label.startsWith('@')) return Option.none();
  const separator = label.indexOf('//');
  if (separator < 0) return Option.none();
  const repository = label.slice(0, separator);
  const body = trimBoundaryCharacters(label.slice(separator + 2), '/');
  const colon = body.indexOf(':');
  const rawPackage = colon >= 0 ? body.slice(0, colon) : body;
  const rawTarget = colon >= 0 ? body.slice(colon + 1) : (rawPackage.split('/').at(-1) ?? '');
  if (rawPackage.split('/').includes('..')) return Option.none();
  const normalizedPackage = normalizeBazelPath(rawPackage);
  const normalizedTarget = rawTarget.trim();
  if (!normalizedTarget || normalizedTarget === '.' || normalizedTarget === '..') return Option.none();
  return Option.some(`${repository}//${normalizedPackage}:${normalizedTarget}`);
}

export function bazelLabelPackage(label: string): Option.Option<{
  readonly external: boolean;
  readonly packagePath: string;
  readonly target: string;
}> {
  const separator = label.indexOf('//');
  const colon = label.indexOf(':', separator + 2);
  if (separator < 0 || colon < 0) return Option.none();
  return Option.some({
    external: separator > 0,
    packagePath: label.slice(separator + 2, colon),
    target: label.slice(colon + 1),
  });
}

export function bazelPackagePath(filePath: string, workspaceRoot: string): string {
  const root = dirname(filePath);
  if (!workspaceRoot) return root;
  if (root === workspaceRoot) return '';
  return root.startsWith(`${workspaceRoot}/`) ? root.slice(workspaceRoot.length + 1) : root;
}

export function bazelFileLabel(filePath: string, workspaceRoot: string): string {
  const packagePath = bazelPackagePath(filePath, workspaceRoot);
  return `//${packagePath}:${basename(filePath)}`;
}

function scanDefinitions(masked: string): BazelDefinition[] {
  const output: BazelDefinition[] = [];
  const expression = /^(\s*)def\s+([A-Za-z_]\w*)\s*\(/gmu;
  for (const match of masked.matchAll(expression)) {
    if (output.length >= MAX_BAZEL_DECLARATIONS) break;
    const start = match.index ?? 0;
    const indent = indentationWidth(match[1] ?? '');
    output.push({
      bodyEnd: definitionBodyEnd(masked, endOfLine(masked, start), indent),
      end: endOfLine(masked, start),
      name: match[2],
      start,
    });
  }
  return output;
}

function scanAssignments(masked: string): BazelAssignment[] {
  const output: BazelAssignment[] = [];
  const expression = /^([A-Za-z_]\w*)\s*=(?!=)/gmu;
  for (const match of masked.matchAll(expression)) {
    if (output.length >= MAX_BAZEL_DECLARATIONS) break;
    const start = match.index ?? 0;
    output.push({end: endOfLine(masked, start), name: match[1], start});
  }
  return output;
}

function scanAttributes(content: string, masked: string, start: number, end: number): BazelAttribute[] {
  const output: BazelAttribute[] = [];
  let cursor = start;
  while (cursor < end) {
    while (cursor < end && /[\s,]/u.test(masked[cursor] ?? '')) cursor += 1;
    if (!isIdentifierStart(masked[cursor] ?? '')) {
      cursor = nextTopLevelComma(masked, cursor, end) + 1;
      continue;
    }
    const nameStart = cursor;
    cursor = scanIdentifier(masked, cursor);
    const name = masked.slice(nameStart, cursor);
    while (/\s/u.test(masked[cursor] ?? '')) cursor += 1;
    if (masked[cursor] !== '=') {
      cursor = nextTopLevelComma(masked, cursor, end) + 1;
      continue;
    }
    const valueStart = cursor + 1;
    const valueEnd = nextTopLevelComma(masked, valueStart, end);
    output.push({
      end: valueEnd,
      name,
      start: valueStart,
      strings: scanStringLiterals(content, valueStart, valueEnd, MAX_BAZEL_STRING_LITERALS),
    });
    cursor = valueEnd + 1;
  }
  return output;
}

function scanStringLiterals(content: string, start: number, end: number, limit: number): BazelStringLiteral[] {
  const output: BazelStringLiteral[] = [];
  let comment = false;
  for (let index = start; index < end && output.length < limit; index += 1) {
    const character = content[index];
    if (comment) {
      if (isLineTerminator(character)) comment = false;
      continue;
    }
    if (character === '#') {
      comment = true;
      continue;
    }
    const prefix = stringPrefixAt(content, index, end);
    if (Option.isNone(prefix)) continue;
    const literal = readStringLiteral(content, prefix.value.quoteStart, end, prefix.value.raw);
    if (Option.isNone(literal)) continue;
    output.push(literal.value);
    index = literal.value.end - 1;
  }
  return output;
}

function stringPrefixAt(
  content: string,
  index: number,
  end: number,
): Option.Option<{readonly quoteStart: number; readonly raw: boolean}> {
  const character = content[index];
  if (character === '"' || character === "'") return Option.some({quoteStart: index, raw: false});
  if (!/[rRbBuUfF]/u.test(character ?? '') || !isTokenBoundary(content[index - 1] ?? '')) return Option.none();
  let cursor = index;
  while (cursor < end && /[rRbBuUfF]/u.test(content[cursor] ?? '') && cursor - index < 3) cursor += 1;
  if (content[cursor] !== '"' && content[cursor] !== "'") return Option.none();
  return Option.some({quoteStart: cursor, raw: /r/iu.test(content.slice(index, cursor))});
}

function readStringLiteral(
  content: string,
  quoteStart: number,
  end: number,
  raw: boolean,
): Option.Option<BazelStringLiteral> {
  const literalEnd = stringLiteralEnd(content, quoteStart, end, raw);
  if (literalEnd === undefined) return Option.none();
  const width = content.startsWith(content[quoteStart].repeat(3), quoteStart) ? 3 : 1;
  const value = content.slice(quoteStart + width, literalEnd - width);
  return Option.some({
    end: literalEnd,
    start: quoteStart,
    value: raw
      ? value
      : value.replace(/\\([\s\S])/gu, (_, escaped: string) =>
          escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped,
        ),
  });
}

function stringLiteralEnd(content: string, quoteStart: number, end: number, raw: boolean): number | undefined {
  const quote = content[quoteStart];
  const triple = content.startsWith(quote.repeat(3), quoteStart);
  const width = triple ? 3 : 1;
  const delimiter = quote.repeat(width);
  for (let cursor = quoteStart + width; cursor < end; cursor += 1) {
    if (content.startsWith(delimiter, cursor)) return cursor + width;
    if (!raw && content[cursor] === '\\' && cursor + 1 < end) cursor += 1;
  }
  return undefined;
}

function maskBazelNonCode(content: string): string {
  const output: string[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    let end: number | undefined;
    if (content[index] === '#') {
      end = index + 1;
      while (end < content.length && !isLineTerminator(content[end])) end += 1;
    } else {
      const prefix = stringPrefixAt(content, index, content.length);
      if (Option.isSome(prefix))
        end = stringLiteralEnd(content, prefix.value.quoteStart, content.length, prefix.value.raw);
    }
    if (end === undefined) continue;
    output.push(
      content.slice(start, index),
      content.slice(index, end).replace(/[^\r\n\u2028\u2029]+/gu, value => ' '.repeat(value.length)),
    );
    start = end;
    index = end - 1;
  }
  output.push(content.slice(start));
  return output.join('');
}

function nextTopLevelComma(masked: string, start: number, end: number): number {
  const nesting = {braces: 0, brackets: 0, parentheses: 0};
  for (let cursor = start; cursor < end; cursor += 1) {
    const character = masked[cursor];
    if (character === '{') nesting.braces += 1;
    else if (character === '}') nesting.braces = Math.max(0, nesting.braces - 1);
    else if (character === '[') nesting.brackets += 1;
    else if (character === ']') nesting.brackets = Math.max(0, nesting.brackets - 1);
    else if (character === '(') nesting.parentheses += 1;
    else if (character === ')') nesting.parentheses = Math.max(0, nesting.parentheses - 1);
    else if (character === ',' && nesting.braces === 0 && nesting.brackets === 0 && nesting.parentheses === 0) {
      return cursor;
    }
  }
  return end;
}

function findMatchingDelimiter(source: string, start: number, open: string, close: string): number | undefined {
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (source[cursor] === open) depth += 1;
    else if (source[cursor] === close) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return undefined;
}

function isDefinitionName(source: string, start: number): boolean {
  return /\bdef\s*$/u.test(source.slice(lineStart(source, start), start));
}

function definitionBodyEnd(source: string, afterHeader: number, declarationIndent: number): number {
  let cursor = afterHeader;
  while (cursor < source.length) {
    const next = endOfLine(source, cursor + 1);
    const line = source.slice(cursor + 1, next);
    if (line.trim() && indentationWidth(/^\s*/u.exec(line)?.[0] ?? '') <= declarationIndent) return cursor;
    cursor = next;
  }
  return source.length;
}

function scanDottedIdentifier(source: string, start: number): number {
  let cursor = scanIdentifier(source, start);
  for (;;) {
    const dot = cursor;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== '.') return dot;
    cursor += 1;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    if (!isIdentifierStart(source[cursor] ?? '')) return dot;
    cursor = scanIdentifier(source, cursor);
  }
}

function scanIdentifier(source: string, start: number): number {
  let cursor = start + 1;
  while (isIdentifierPart(source[cursor] ?? '')) cursor += 1;
  return cursor;
}

function lineStart(source: string, offset: number): number {
  return Math.max(source.lastIndexOf('\n', offset - 1), source.lastIndexOf('\r', offset - 1)) + 1;
}

function endOfLine(source: string, offset: number): number {
  const lineFeed = source.indexOf('\n', offset);
  const carriageReturn = source.indexOf('\r', offset);
  if (lineFeed < 0) return carriageReturn < 0 ? source.length : carriageReturn;
  if (carriageReturn < 0) return lineFeed;
  return Math.min(lineFeed, carriageReturn);
}

function indentationWidth(value: string): number {
  return [...value].reduce((total, character) => total + (character === '\t' ? 8 - (total % 8) : 1), 0);
}

function normalizeBazelPath(value: string): string {
  const output: string[] = [];
  for (const segment of value.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return '';
    output.push(segment);
  }
  return output.join('/');
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function dirname(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/u.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_]/u.test(character);
}

function isTokenBoundary(character: string): boolean {
  return !isIdentifierPart(character);
}

function isLineTerminator(character: string): boolean {
  return character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029';
}
