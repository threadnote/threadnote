import {Array as EffectArray} from 'effect';
import {reviewedSupportSharingBlocker} from '../reviewed-support.js';
import {MEMORY_CODE_CITATION_HEADER} from './citation.js';
import {parseMemoryDocument, type MemoryMetadata} from '../document.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

export type MemoryCodeCitationSharingBlocker =
  | 'dirty-source'
  | 'local-repository-identity'
  | 'malformed-citation'
  | 'private-obsidian-evidence'
  | 'private-source-evidence';

/**
 * Only clean citations backed by a portable remote repository identity may
 * cross a sharing boundary. The immutable citation itself is preserved.
 */
export function memoryCodeCitationSharingBlocker(
  metadata: Pick<
    MemoryMetadata,
    | 'citationErrors'
    | 'codeCitations'
    | 'obsidianEvidence'
    | 'obsidianEvidenceError'
    | 'sourceEvidence'
    | 'sourceEvidenceError'
  > &
    Partial<
      Pick<MemoryMetadata, 'topicMaintenanceError' | 'topicMaintenance' | 'reviewedSupport' | 'reviewedSupportError'>
    >,
): MemoryCodeCitationSharingBlocker | undefined {
  if (metadata.reviewedSupportError) return 'malformed-citation';
  if (metadata.reviewedSupport) {
    const blocker = reviewedSupportSharingBlocker(metadata.reviewedSupport);
    if (blocker) return blocker;
  }
  if (metadata.obsidianEvidenceError || metadata.sourceEvidenceError || metadata.topicMaintenanceError)
    return 'malformed-citation';
  if (metadata.sourceEvidence) return 'private-source-evidence';
  if (
    metadata.obsidianEvidence ||
    (metadata.topicMaintenance?.version === 3 && metadata.topicMaintenance.sourceKind === 'obsidian')
  )
    return 'private-obsidian-evidence';
  if ((metadata.citationErrors?.length ?? 0) > 0) return 'malformed-citation';
  if (
    EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(metadata.codeCitations), __effectArrayReceiver =>
        EffectArray.some(
          __effectArrayReceiver,
          __effectArrayValue => !!(citation => citation.sourceDirty)(__effectArrayValue),
        ),
      ),
    )
  )
    return 'dirty-source';
  if (
    EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(metadata.codeCitations), __effectArrayReceiver =>
        EffectArray.some(__effectArrayReceiver, citation => citation.repositoryIdentityKind !== 'remote'),
      ),
    )
  ) {
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
  const sourceEvidenceHeader = inspectEvidenceHeaderShape(content, 'source_evidence');
  const topicMaintenanceHeader = inspectEvidenceHeaderShape(content, 'topic_maintenance');
  const reviewedSupportHeader = inspectEvidenceHeaderShape(content, 'reviewed_support');
  const parsed = parseMemoryDocument(uri, content);
  if (parsed) {
    const blocker = memoryCodeCitationSharingBlocker(parsed.metadata);
    if (blocker) return blocker;
    return shapedHeader.hasNonCanonical ||
      evidenceHeader.hasNonCanonical ||
      sourceEvidenceHeader.hasNonCanonical ||
      topicMaintenanceHeader.hasNonCanonical ||
      reviewedSupportHeader.hasNonCanonical
      ? 'malformed-citation'
      : sourceEvidenceHeader.hasCitationShape
        ? 'private-source-evidence'
        : evidenceHeader.hasCitationShape
          ? 'private-obsidian-evidence'
          : undefined;
  }
  return shapedHeader.hasCitationShape ||
    evidenceHeader.hasCitationShape ||
    sourceEvidenceHeader.hasCitationShape ||
    topicMaintenanceHeader.hasCitationShape ||
    reviewedSupportHeader.hasCitationShape
    ? 'malformed-citation'
    : undefined;
}

/** Private provenance cannot cross a projection boundary, even when its metadata is malformed. */
export function memoryHasPrivateEvidenceProvenance(uri: string, content: string): boolean {
  if (
    inspectEvidenceHeaderShape(content, 'obsidian_evidence').hasCitationShape ||
    inspectEvidenceHeaderShape(content, 'source_evidence').hasCitationShape
  )
    return true;
  const reviewedHeader = inspectEvidenceHeaderShape(content, 'reviewed_support');
  if (reviewedHeader.hasCitationShape) {
    const record = parseMemoryDocument(uri, content);
    if (
      !record ||
      reviewedHeader.hasNonCanonical ||
      record.metadata.reviewedSupportError ||
      !record.metadata.reviewedSupport ||
      reviewedSupportSharingBlocker(record.metadata.reviewedSupport)
    )
      return true;
  }
  const topicHeader = inspectEvidenceHeaderShape(content, 'topic_maintenance');
  if (!topicHeader.hasCitationShape) return false;
  const parsed = parseMemoryDocument(uri, content);
  return (
    !parsed ||
    topicHeader.hasNonCanonical ||
    !!parsed.metadata.topicMaintenanceError ||
    (parsed.metadata.topicMaintenance?.version === 3 && parsed.metadata.topicMaintenance.sourceKind === 'obsidian')
  );
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
    case 'private-source-evidence':
      return 'memories with private source evidence cannot be shared without an approved evidence publication path';
  }
}

function inspectObsidianEvidenceHeaderShape(content: string): {
  readonly hasCitationShape: boolean;
  readonly hasNonCanonical: boolean;
} {
  return inspectEvidenceHeaderShape(content, 'obsidian_evidence');
}

function inspectEvidenceHeaderShape(
  content: string,
  name: 'obsidian_evidence' | 'source_evidence' | 'topic_maintenance' | 'reviewed_support',
): {
  readonly hasCitationShape: boolean;
  readonly hasNonCanonical: boolean;
} {
  const canonical = Effect.pipe(content, EffectString.trim, EffectString.replace(/\r\n?/gu, '\n'));
  const separatorIndex = Effect.pipe(
    canonical,
    EffectString.indexOf('\n\n'),
    Effect.Option.getOrElse(() => -1),
  );
  const header = separatorIndex === -1 ? canonical : Effect.pipe(canonical, EffectString.slice(0, separatorIndex));
  const lines = EffectArray.filter(
    Effect.pipe(header, EffectString.split('\n')),
    __effectArrayValue2 => !!(line => new RegExp(`^\\s*${name}\\s*:`, 'iu').test(line))(__effectArrayValue2),
  );
  return {
    hasCitationShape: lines.length > 0,
    hasNonCanonical:
      lines.length > 1 || EffectArray.some(lines, line => !Effect.pipe(line, EffectString.startsWith(`${name}: `))),
  };
}

function inspectCodeCitationHeaderShape(content: string): {
  readonly hasCitationShape: boolean;
  readonly hasNonCanonical: boolean;
} {
  const canonical = Effect.pipe(content, EffectString.trim, EffectString.replace(/\r\n?/gu, '\n'));
  const separatorIndex = Effect.pipe(
    canonical,
    EffectString.indexOf('\n\n'),
    Effect.Option.getOrElse(() => -1),
  );
  const header = separatorIndex === -1 ? canonical : Effect.pipe(canonical, EffectString.slice(0, separatorIndex));
  const prefix = `${MEMORY_CODE_CITATION_HEADER}:`;
  let hasCitationShape = false;
  let hasNonCanonical = false;
  for (const line of Effect.pipe(header, EffectString.split('\n'))) {
    if (!/^\s*code_citation\s*:/u.test(line)) continue;
    hasCitationShape = true;
    if (!Effect.pipe(line, EffectString.startsWith(`${prefix} `))) hasNonCanonical = true;
  }
  return {hasCitationShape, hasNonCanonical};
}
