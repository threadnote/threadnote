import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeGraphInventoryFile, CodeGraphSpan, CodeGraphSymbol} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_CITATION_QUERY_MAX_TARGETS = 400 as const;
export const CODE_GRAPH_CITATION_QUERY_MAX_MATCHES_PER_TARGET = 64 as const;
export const CODE_GRAPH_SOURCE_SPAN_CANONICALIZATION_V1 = 'utf8-source-span-v1' as const;

export interface CodeGraphEffectiveFilePathObservation {
  readonly file?: CodeGraphInventoryFile;
  readonly path: string;
}

export interface CodeGraphEffectiveFileHashMatches {
  readonly contentHash: string;
  readonly files: readonly CodeGraphInventoryFile[];
  /** More effective files matched than the requested per-hash result bound. */
  readonly truncated: boolean;
}

/**
 * Exact, path-independent identity used only to retrieve bounded relocation
 * candidates. A caller may apply stronger versioned evidence (for example a
 * signature or source-fragment hash) to the returned symbols.
 */
export interface CodeGraphSymbolSemanticLocatorV1 {
  readonly kind: string;
  readonly language: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly version: 1;
}

export interface CodeGraphEffectiveSymbolLocatorMatches {
  readonly locator: CodeGraphSymbolSemanticLocatorV1;
  readonly symbols: readonly CodeGraphSymbol[];
  /** More effective symbols matched than the requested per-locator result bound. */
  readonly truncated: boolean;
}

export interface CodeGraphCitationFileRelocationFallbackV1 {
  readonly contentHash: string;
  readonly path: string;
}

/** Select eager hashes plus fallbacks whose original path is absent. */
export function selectCodeGraphCitationContentHashTargets(
  eagerContentHashes: readonly string[],
  fileRelocationFallbacks: readonly CodeGraphCitationFileRelocationFallbackV1[],
  presentPaths: ReadonlySet<string>,
): readonly string[] {
  const requestedContentHashes = new Set(eagerContentHashes);
  for (const fallback of fileRelocationFallbacks) {
    if (!presentPaths.has(fallback.path)) requestedContentHashes.add(fallback.contentHash);
  }
  return [...requestedContentHashes];
}

export interface CodeGraphEffectiveSnapshotCitationEvidenceRequest {
  readonly contentHashes?: readonly string[];
  /**
   * Query a content hash only when its paired original path is absent from the
   * effective snapshot. This keeps the common exact/changed path proof inside
   * the same database session without paying for an unused relocation scan.
   */
  readonly fileRelocationFallbacks?: readonly CodeGraphCitationFileRelocationFallbackV1[];
  /** Defaults to 2 and is capped by CODE_GRAPH_CITATION_QUERY_MAX_MATCHES_PER_TARGET. */
  readonly limitPerContentHash?: number;
  /** Defaults to 2 and is capped by CODE_GRAPH_CITATION_QUERY_MAX_MATCHES_PER_TARGET. */
  readonly limitPerSemanticLocator?: number;
  readonly paths?: readonly string[];
  readonly semanticLocators?: readonly CodeGraphSymbolSemanticLocatorV1[];
  readonly symbolIds?: readonly string[];
}

export interface CodeGraphEffectiveSnapshotCitationEvidence {
  /**
   * `complete` is deliberately rare: the ready snapshot is a clean root and
   * its persisted inventory receipt proves that no repository files were
   * excluded or skipped. Only this state can turn total file absence into a
   * deletion result; every missing or partial proof must remain `incomplete`.
   */
  readonly fileInventoryCoverage: 'complete' | 'incomplete';
  /** Eager hashes plus fallback hashes whose paired original path was absent. */
  readonly filesByContentHashes: readonly CodeGraphEffectiveFileHashMatches[];
  readonly filesByPaths: readonly CodeGraphEffectiveFilePathObservation[];
  readonly symbolsByIds: readonly CodeGraphSymbol[];
  readonly symbolsBySemanticLocators: readonly CodeGraphEffectiveSymbolLocatorMatches[];
}

export type CodeGraphSourceSpanFragmentFailureReason = 'invalid-coordinate' | 'out-of-range' | 'split-surrogate';

export interface CodeGraphSourceSpanFragmentV1 {
  readonly bytes: Uint8Array;
  readonly canonicalization: typeof CODE_GRAPH_SOURCE_SPAN_CANONICALIZATION_V1;
  /** Exclusive UTF-16 offset in the original, non-normalized source string. */
  readonly endOffset: number;
  /** Lower-case SHA-256 of `bytes`. */
  readonly sha256: string;
  /** Inclusive UTF-16 offset in the original, non-normalized source string. */
  readonly startOffset: number;
  /** Canonical UTF-8 input. Line endings are LF; Unicode scalar sequences are otherwise unchanged. */
  readonly text: string;
}

export type CodeGraphSourceSpanFragmentResult =
  | {readonly fragment: CodeGraphSourceSpanFragmentV1; readonly ok: true}
  | {readonly ok: false; readonly reason: CodeGraphSourceSpanFragmentFailureReason};

export interface CodeGraphSourceSpanCanonicalizerV1 {
  readonly canonicalization: typeof CODE_GRAPH_SOURCE_SPAN_CANONICALIZATION_V1;
  readonly fragment: (span: CodeGraphSpan) => CodeGraphSourceSpanFragmentResult;
}

interface SourceLogicalLine {
  readonly contentEnd: number;
  readonly start: number;
}

/**
 * Extract and hash a graph span without depending on a parser runtime.
 *
 * Graph positions are one-based UTF-16 coordinates and the end position is
 * exclusive. Newline spelling is intentionally excluded from the identity:
 * CRLF, CR, LF, U+2028, and U+2029 canonicalize to LF. No Unicode
 * normalization is applied, because canonically equivalent code-point
 * sequences are still different source evidence.
 */
export function codeGraphSourceSpanFragment(source: string, span: CodeGraphSpan): CodeGraphSourceSpanFragmentResult {
  return createCodeGraphSourceSpanCanonicalizer(source).fragment(span);
}

/** Build the source line index once when several cited symbols share a file. */
export function createCodeGraphSourceSpanCanonicalizer(source: string): CodeGraphSourceSpanCanonicalizerV1 {
  const lines = sourceLogicalLines(source);
  return {
    canonicalization: CODE_GRAPH_SOURCE_SPAN_CANONICALIZATION_V1,
    fragment: span => codeGraphSourceSpanFragmentWithLines(source, lines, span),
  };
}

function codeGraphSourceSpanFragmentWithLines(
  source: string,
  lines: readonly SourceLogicalLine[],
  span: CodeGraphSpan,
): CodeGraphSourceSpanFragmentResult {
  if (
    !Number.isSafeInteger(span.line) ||
    !Number.isSafeInteger(span.column) ||
    !Number.isSafeInteger(span.endLine) ||
    !Number.isSafeInteger(span.endColumn) ||
    span.line < 1 ||
    span.column < 1 ||
    span.endLine < 1 ||
    span.endColumn < 1
  ) {
    return {ok: false, reason: 'invalid-coordinate'};
  }
  const start = sourceOffsetAt(lines, source, span.line, span.column);
  const end = sourceOffsetAt(lines, source, span.endLine, span.endColumn);
  if (start === undefined || end === undefined) return {ok: false, reason: 'out-of-range'};
  if (end < start) return {ok: false, reason: 'invalid-coordinate'};
  if (splitsSurrogatePair(source, start) || splitsSurrogatePair(source, end)) {
    return {ok: false, reason: 'split-surrogate'};
  }

  const text = Effect.pipe(
    source,
    EffectString.slice(start, end),
    EffectString.replace(/\r\n|\r|\u2028|\u2029/gu, '\n'),
  );
  const bytes = new TextEncoder().encode(text);
  return {
    fragment: {
      bytes,
      canonicalization: CODE_GRAPH_SOURCE_SPAN_CANONICALIZATION_V1,
      endOffset: end,
      sha256: sha256HexSync(bytes),
      startOffset: start,
      text,
    },
    ok: true,
  };
}

function sourceLogicalLines(source: string): readonly SourceLogicalLine[] {
  const lines: SourceLogicalLine[] = [];
  let start = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\r') {
      lines.push({contentEnd: cursor, start});
      cursor += source[cursor + 1] === '\n' ? 2 : 1;
      start = cursor;
      continue;
    }
    if (character === '\n' || character === '\u2028' || character === '\u2029') {
      lines.push({contentEnd: cursor, start});
      cursor += 1;
      start = cursor;
      continue;
    }
    cursor += 1;
  }
  lines.push({contentEnd: source.length, start});
  return lines;
}

function sourceOffsetAt(
  lines: readonly SourceLogicalLine[],
  source: string,
  lineNumber: number,
  columnNumber: number,
): number | undefined {
  const line = lines[lineNumber - 1];
  if (line === undefined) return undefined;
  const offset = line.start + columnNumber - 1;
  if (offset < line.start || offset > line.contentEnd || offset > source.length) return undefined;
  return offset;
}

function splitsSurrogatePair(source: string, offset: number): boolean {
  if (offset <= 0 || offset >= source.length) return false;
  const previous = Effect.pipe(
    source,
    EffectString.charCodeAt(offset - 1),
    Effect.Option.getOrElse(() => NaN),
  );
  const current = Effect.pipe(
    source,
    EffectString.charCodeAt(offset),
    Effect.Option.getOrElse(() => NaN),
  );
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}
