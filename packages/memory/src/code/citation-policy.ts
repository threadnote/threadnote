import {MEMORY_CODE_CITATION_HEADER} from './citation.js';
import {parseMemoryDocument, type MemoryMetadata} from '../document.js';

export type MemoryCodeCitationSharingBlocker =
  'dirty-source' | 'local-repository-identity' | 'malformed-citation' | 'private-obsidian-evidence';

/**
 * Only clean citations backed by a portable remote repository identity may
 * cross a sharing boundary. The immutable citation itself is preserved.
 */
export function memoryCodeCitationSharingBlocker(
  metadata: Pick<MemoryMetadata, 'citationErrors' | 'codeCitations' | 'obsidianEvidence' | 'obsidianEvidenceError'>,
): MemoryCodeCitationSharingBlocker | undefined {
  if (metadata.obsidianEvidenceError) return 'malformed-citation';
  if (metadata.obsidianEvidence) return 'private-obsidian-evidence';
  if ((metadata.citationErrors?.length ?? 0) > 0) return 'malformed-citation';
  if (metadata.codeCitations?.some(citation => citation.sourceDirty)) return 'dirty-source';
  if (metadata.codeCitations?.some(citation => citation.repositoryIdentityKind !== 'remote')) {
    return 'local-repository-identity';
  }
  return undefined;
}

/** Fail closed when an otherwise-unparseable memory still declares citation metadata. */
export function memoryCodeCitationContentSharingBlocker(
  uri: string,
  content: string,
): MemoryCodeCitationSharingBlocker | undefined {
  const shapedHeader = inspectCodeCitationHeaderShape(content);
  const evidenceHeader = inspectObsidianEvidenceHeaderShape(content);
  const parsed = parseMemoryDocument(uri, content);
  if (parsed) {
    const blocker = memoryCodeCitationSharingBlocker(parsed.metadata);
    if (blocker) return blocker;
    return shapedHeader.hasNonCanonical || evidenceHeader.hasNonCanonical
      ? 'malformed-citation'
      : evidenceHeader.hasCitationShape
        ? 'private-obsidian-evidence'
        : undefined;
  }
  return shapedHeader.hasCitationShape || evidenceHeader.hasCitationShape ? 'malformed-citation' : undefined;
}

export function memoryCodeCitationSharingBlockerMessage(blocker: MemoryCodeCitationSharingBlocker): string {
  switch (blocker) {
    case 'dirty-source':
      return 'code citations captured from a dirty worktree cannot be shared; commit the cited source and recapture';
    case 'local-repository-identity':
      return 'code citations without a portable remote repository identity cannot be shared';
    case 'malformed-citation':
      return 'malformed code citation metadata must be repaired or recaptured before sharing';
    case 'private-obsidian-evidence':
      return 'memories with private Obsidian evidence cannot be shared without an approved evidence publication path';
  }
}

function inspectObsidianEvidenceHeaderShape(content: string): {
  readonly hasCitationShape: boolean;
  readonly hasNonCanonical: boolean;
} {
  const canonical = content.trim().replace(/\r\n?/gu, '\n');
  const separatorIndex = canonical.indexOf('\n\n');
  const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
  const lines = header.split('\n').filter(line => /^\s*obsidian_evidence\s*:/u.test(line));
  return {
    hasCitationShape: lines.length > 0,
    hasNonCanonical: lines.length > 1 || lines.some(line => !line.startsWith('obsidian_evidence: ')),
  };
}

function inspectCodeCitationHeaderShape(content: string): {
  readonly hasCitationShape: boolean;
  readonly hasNonCanonical: boolean;
} {
  const canonical = content.trim().replace(/\r\n?/gu, '\n');
  const separatorIndex = canonical.indexOf('\n\n');
  const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
  const prefix = `${MEMORY_CODE_CITATION_HEADER}:`;
  let hasCitationShape = false;
  let hasNonCanonical = false;
  for (const line of header.split('\n')) {
    if (!/^\s*code_citation\s*:/u.test(line)) continue;
    hasCitationShape = true;
    if (!line.startsWith(`${prefix} `)) hasNonCanonical = true;
  }
  return {hasCitationShape, hasNonCanonical};
}
