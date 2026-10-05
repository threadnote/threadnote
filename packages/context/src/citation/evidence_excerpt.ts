import {Effect, Option} from 'effect';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {
  createCodeGraphSourceSpanCanonicalizer,
  type CodeGraphEffectiveSnapshotCitationEvidence,
} from '@threadnote/graph/citation/primitives';
import {codeGraphFileContentHashMatchesBytes} from '@threadnote/graph/content_identity';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import type {CodeGraphCitationEvidenceSourceV1} from '@threadnote/graph/citation/capsule';
import {decodeUtf8} from '@threadnote/graph/inventory/content';
import {sha256HexSync} from '@threadnote/platform/sha256';

export interface ContextHealthCitationSourceExcerptV1 {
  readonly content: string;
  readonly endLine: number;
  readonly excerptHash: string;
  readonly fileBytesHash: string;
  readonly provenance: 'current-verified' | 'historical-verified';
  readonly source: CodeGraphCitationEvidenceSourceV1;
  readonly startLine: number;
  readonly supportsCitation: boolean;
  readonly truncated: boolean;
}

export function citationSourceExcerpt(
  bytes: Uint8Array,
  source: CodeGraphCitationEvidenceSourceV1,
  provenance: ContextHealthCitationSourceExcerptV1['provenance'],
  supportsCitation: boolean,
  options: {readonly maximumBytes?: number; readonly maximumLines?: number; readonly startLine?: number},
): ContextHealthCitationSourceExcerptV1 | undefined {
  const content = decodeUtf8(bytes);
  const startLine = options.startLine ?? 1;
  const maximumBytes = Math.min(options.maximumBytes ?? 8_192, 32_768);
  const maximumLines = Math.min(options.maximumLines ?? 24, 64);
  if (
    content === undefined ||
    ![startLine, maximumBytes, maximumLines].every(value => Number.isSafeInteger(value) && value > 0)
  )
    return undefined;
  const lines = content.split(/\r\n|\r|\n|\u2028|\u2029/u).slice(startLine - 1);
  if (lines.length === 0) return undefined;
  const selected: string[] = [];
  let length = 0;
  for (const line of lines.slice(0, maximumLines)) {
    const size = new TextEncoder().encode(line).byteLength + (selected.length === 0 ? 0 : 1);
    if (length + size > maximumBytes) break;
    selected.push(line);
    length += size;
  }
  if (selected.length === 0) return undefined;
  const excerpt = selected.join('\n');
  return {
    content: excerpt,
    endLine: startLine + selected.length - 1,
    excerptHash: sha256HexSync(excerpt),
    fileBytesHash: sha256HexSync(bytes),
    provenance,
    source,
    startLine,
    supportsCitation,
    truncated: selected.length < lines.length,
  };
}

/** Membership is proved by leased snapshot facts, independently of citation-authored hashes. */
export function historicalSnapshotCitationMatches(
  citation: MemoryCodeCitationV1,
  evidence: CodeGraphEffectiveSnapshotCitationEvidence,
): boolean {
  const files = evidence.filesByPaths.filter(observation => observation.path === citation.path);
  const file = files.length === 1 ? files[0].file : undefined;
  if (
    file === undefined ||
    file.path !== citation.path ||
    (file.contentHash !== citation.fileContentHash.value && file.rawContentHash !== citation.fileContentHash.value)
  )
    return false;
  const target = citation.target;
  if (target.kind === 'file') return true;
  const symbols = evidence.symbolsByIds.filter(symbol => symbol.id === target.nodeId);
  if (symbols.length !== 1) return false;
  const symbol = symbols[0];
  return (
    symbol.path === citation.path &&
    symbol.contentHash === file.contentHash &&
    symbol.kind === target.symbolKind &&
    symbol.language === target.language &&
    symbol.name === target.name &&
    symbol.qualifiedName === target.qualifiedName &&
    symbol.span.line === target.span.line &&
    symbol.span.column === target.span.column &&
    symbol.span.endLine === target.span.endLine &&
    symbol.span.endColumn === target.span.endColumn &&
    (target.signatureHash === undefined ||
      (symbol.signature !== undefined && sha256HexSync(symbol.signature) === target.signatureHash.value))
  );
}

export const historicalCitationBytesMatch = Effect.fn('contextHealth.historicalCitationBytesMatch')(function* (
  citation: MemoryCodeCitationV1,
  objectFormat: RepositoryIdentity['objectFormat'],
  bytes: Uint8Array,
) {
  if (!codeGraphFileContentHashMatchesBytes(citation.fileContentHash.value, objectFormat, bytes)) return false;
  const target = citation.target;
  if (target.kind === 'file') return true;
  const source = decodeUtf8(bytes);
  if (source === undefined) return false;
  const fragment = createCodeGraphSourceSpanCanonicalizer(source).fragment(target.span);
  if (!fragment.ok || fragment.fragment.sha256 !== target.fragmentHash.value) return false;
  if (target.signatureHash === undefined) return true;
  const packs = yield* CodeGraphLanguagePackRegistry;
  const runtime = yield* Effect.serviceOption(TreeSitterRuntime);
  if (Option.isNone(runtime)) return false;
  const facts = yield* packs
    .extractFile({
      blobId: '',
      bytes,
      content: source,
      contentHash: citation.fileContentHash.value,
      language: target.language,
      mode: '100644',
      path: citation.path,
      size: bytes.byteLength,
      source: 'commit',
    })
    .pipe(
      Effect.provideService(TreeSitterRuntime, runtime.value),
      Effect.orElseSucceed(() => undefined),
    );
  if (facts === undefined) return false;
  const matches = facts.symbols.filter(
    symbol =>
      symbol.kind === target.symbolKind &&
      symbol.language === target.language &&
      symbol.name === target.name &&
      symbol.qualifiedName === target.qualifiedName &&
      symbol.span.line === target.span.line &&
      symbol.span.column === target.span.column &&
      symbol.span.endLine === target.span.endLine &&
      symbol.span.endColumn === target.span.endColumn &&
      symbol.signature !== undefined &&
      sha256HexSync(symbol.signature) === target.signatureHash!.value,
  );
  return matches.length === 1;
});
