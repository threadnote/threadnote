import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  assertAutomaticMaintenanceAssessment,
  assertAutomaticMaintenanceEvidence,
  automaticMaintenanceCapabilities,
  automaticMaintenanceEvidenceId,
  automaticMaintenanceMemoryScope,
  automaticMaintenanceSections,
  type AutomaticMaintenanceAssessmentV1,
  type AutomaticMaintenanceCoverageV1,
  type AutomaticMaintenanceEvidenceV1,
  type AutomaticMaintenanceParagraphV1,
  type AutomaticMaintenanceSourceV1,
  type AutomaticMaintenanceTargetV1,
} from '@threadnote/memory/automatic-maintenance';
import {canonicalMemoryDocumentContent, isAgentArtifactUri, type MemoryRecord} from '@threadnote/memory/document';
import {consolidationRevision} from '@threadnote/memory/consolidation';
import {
  isCodeTopicMaintenanceManifest,
  topicMaintenanceObsidianCitationId,
  validateTopicMaintenanceManifest,
  type TopicMaintenanceClaimRole,
  type TopicMaintenanceSupport,
} from '@threadnote/memory/topic-maintenance';
import {MAX_MEMORY_CODE_CITATIONS} from '@threadnote/memory/code/citation';

export interface MemoryMaintenanceInferenceV1 {
  readonly ordinal: number;
  readonly role: TopicMaintenanceClaimRole | 'unknown';
  readonly support: TopicMaintenanceSupport;
  readonly currentEvidenceIds: readonly string[];
  readonly scope?: string;
  readonly validity?: string;
}
export interface MemoryMaintenancePreparationOptions {
  /** Adapter authority, not inferred/model metadata. Never grants apply or publication. */
  readonly readOnly?: boolean;
  readonly evidence?: readonly AutomaticMaintenanceEvidenceV1[];
  readonly inferences?: readonly MemoryMaintenanceInferenceV1[];
  readonly coverage?: Omit<AutomaticMaintenanceCoverageV1, 'omittedParagraphs'>;
}
export interface MemoryMaintenanceBasisV1 {
  readonly version: 1;
  readonly assessment: AutomaticMaintenanceAssessmentV1;
  /** Exact original envelope, full typed relation prior set and compatibility history; never rewritten here. */
  readonly record: MemoryRecord;
}

function recordedEvidence(source: AutomaticMaintenanceSourceV1): AutomaticMaintenanceEvidenceV1 {
  return {
    id: automaticMaintenanceEvidenceId(source),
    source,
    scope:
      source.kind === 'code'
        ? 'repository'
        : source.kind === 'obsidian'
          ? 'personal'
          : automaticMaintenanceMemoryScope(source.uri),
    authority: 'recorded',
    availability: 'unknown',
  };
}

/**
 * Pure evidence projection for automatic preparation. No discovery, model invocation, pin reads/writes,
 * enrollment or canonical mutation. Source availability must come from the caller's guarded reads.
 */
export function prepareMemoryMaintenanceBasis(
  record: MemoryRecord,
  options: MemoryMaintenancePreparationOptions = {},
): MemoryMaintenanceBasisV1 {
  if (record.metadata.topicMaintenanceError) throw new Error('Malformed legacy maintenance must remain protected.');
  const manifest = record.metadata.topicMaintenance
    ? validateTopicMaintenanceManifest(record.metadata.topicMaintenance, record)
    : undefined;
  const sections = automaticMaintenanceSections(record.body);
  const overflow = sections === undefined;
  const target: AutomaticMaintenanceTargetV1 = {
    uri: record.uri,
    ...(record.metadata.memoryId === undefined ? {} : {memoryId: record.metadata.memoryId}),
    kind: record.metadata.kind,
    status: record.metadata.status,
    ...(record.metadata.schemaVersion === undefined ? {} : {schemaVersion: record.metadata.schemaVersion}),
    canonicalHash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
    bodyHash: consolidationRevision(record.body),
    paragraphCount: sections?.length ?? null,
    visibility: automaticMaintenanceMemoryScope(record.uri),
    readOnly: options.readOnly === true || record.metadata.visibility === 'external',
    artifact: isAgentArtifactUri(record.uri),
  };
  const evidence: AutomaticMaintenanceEvidenceV1[] = [];
  const add = (item: AutomaticMaintenanceEvidenceV1) => {
    assertAutomaticMaintenanceEvidence(item);
    const prior = evidence.findIndex(entry => entry.id === item.id);
    if (prior < 0) evidence.push(item);
    else {
      if (item.authority === 'provisional' && evidence[prior].authority !== 'provisional')
        throw new Error('Inferred evidence cannot replace recorded provenance.');
      evidence[prior] = item;
    }
  };
  for (const citation of record.metadata.codeCitations ?? []) add(recordedEvidence({kind: 'code', citation}));
  if (record.metadata.obsidianEvidence)
    add(recordedEvidence({kind: 'obsidian', evidence: record.metadata.obsidianEvidence}));
  if (manifest && !isCodeTopicMaintenanceManifest(manifest))
    add(recordedEvidence({kind: 'obsidian', evidence: manifest.activeEvidence}));
  for (const item of options.evidence ?? []) add(item);
  if (evidence.length > MAX_MEMORY_CODE_CITATIONS)
    throw new Error('Automatic maintenance evidence exceeds the existing source budget.');
  const byCitationId = new Map(
    evidence.flatMap(item =>
      item.source.kind === 'code'
        ? [[item.source.citation.id, item.id] as const]
        : item.source.kind === 'obsidian'
          ? [[topicMaintenanceObsidianCitationId(item.source.evidence), item.id] as const]
          : [],
    ),
  );
  const resolve = (id: string) => {
    const resolved = byCitationId.get(id);
    if (!resolved) throw new Error('Legacy support has no exact recorded source.');
    return resolved;
  };
  const inferences = options.inferences ?? [];
  if (
    new Set(inferences.map(item => item.ordinal)).size !== inferences.length ||
    inferences.some(
      item => !Number.isSafeInteger(item.ordinal) || item.ordinal < 0 || item.ordinal >= (sections?.length ?? 0),
    )
  )
    throw new Error('Inference paragraph identity is invalid.');
  const paragraphs: AutomaticMaintenanceParagraphV1[] = overflow
    ? []
    : sections.map((section, ordinal) => {
        const inferred = inferences.find(item => item.ordinal === ordinal);
        const approved = manifest?.paragraphs[ordinal];
        const currentEvidenceIds = inferred?.currentEvidenceIds ?? [];
        const currentSupport = inferred?.support ?? 'unresolved';
        if (approved) {
          const historicalEvidenceIds = approved.citationIds.map(resolve);
          const acceptedEvidenceIds = [
            ...new Set(
              approved.citationIds.map(id => {
                if (!isCodeTopicMaintenanceManifest(manifest))
                  return resolve(topicMaintenanceObsidianCitationId(manifest.activeEvidence));
                return resolve(
                  manifest.version === 1
                    ? id
                    : manifest.acceptedSources.find(entry => entry.citationId === id)!.acceptedCitationId,
                );
              }),
            ),
          ];
          return {
            role: approved.role,
            support: approved.support,
            ...(approved.scope === undefined ? {} : {scope: approved.scope}),
            ...(approved.validity === undefined ? {} : {validity: approved.validity}),
            ordinal,
            hash: consolidationRevision(section),
            roleAuthority: 'legacy-approved',
            supportAuthority: 'legacy-approved',
            historicalEvidenceIds,
            acceptedEvidenceIds,
            currentEvidenceIds,
            currentSupport,
            currentSupportAuthority: 'provisional',
          };
        }
        const protectedRole =
          record.metadata.kind === 'preference'
            ? 'normative'
            : record.metadata.kind === 'incident' || record.metadata.kind === 'handoff'
              ? 'historical'
              : undefined;
        return {
          ordinal,
          hash: consolidationRevision(section),
          role: protectedRole ?? inferred?.role ?? 'unknown',
          roleAuthority: 'provisional',
          support: inferred?.support ?? 'unresolved',
          supportAuthority: 'provisional',
          historicalEvidenceIds: [],
          acceptedEvidenceIds: [],
          currentEvidenceIds,
          currentSupport,
          currentSupportAuthority: 'provisional',
          ...(inferred?.scope === undefined ? {} : {scope: inferred.scope}),
          ...(inferred?.validity === undefined ? {} : {validity: inferred.validity}),
        };
      });
  const coverage: AutomaticMaintenanceCoverageV1 = {
    ...(options.coverage ?? {
      outcome: 'unknown',
      scope: evidence.length ? 'recorded-only' : 'none',
      searchedScopes: [],
      omittedSources: 0,
    }),
    omittedParagraphs: overflow ? null : 0,
  };
  if (overflow && coverage.outcome === 'complete')
    throw new Error('An oversized target cannot have complete coverage.');
  const assessment: AutomaticMaintenanceAssessmentV1 = {
    version: 1,
    preparation: manifest
      ? {
          version: 1,
          kind: 'legacy-approved',
          manifestVersion: manifest.version,
          manifestHash: sha256HexSync(JSON.stringify(manifest)),
        }
      : {version: 1, kind: 'derived'},
    target,
    paragraphs,
    evidence,
    dependencies:
      manifest?.additionalDependencies.map(item => ({kind: item.kind, evidenceId: resolve(item.citationId)})) ?? [],
    coverage,
    capabilities: automaticMaintenanceCapabilities(target, paragraphs, evidence, coverage),
  };
  assertAutomaticMaintenanceAssessment(assessment);
  return {version: 1, assessment, record};
}

/** Canonical body offsets are UTF-16, end-exclusive; ordinal disambiguates repeated paragraphs. */
export function memoryMaintenanceFragmentSource(
  record: MemoryRecord,
  ordinal: number,
): Extract<AutomaticMaintenanceSourceV1, {kind: 'memory'}> {
  const sections = automaticMaintenanceSections(record.body);
  if (!sections || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= sections.length)
    throw new Error('Memory fragment is outside canonical paragraph bounds.');
  let startOffset = 0;
  for (let index = 0; index <= ordinal; index++) {
    startOffset = record.body.indexOf(sections[index], startOffset);
    if (startOffset < 0) throw new Error('Memory fragment cannot be located in canonical body.');
    if (index < ordinal) startOffset += sections[index].length;
  }
  return {
    kind: 'memory',
    uri: record.uri,
    ...(record.metadata.memoryId === undefined ? {} : {memoryId: record.metadata.memoryId}),
    canonicalHash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
    fragment: {
      ordinal,
      hash: consolidationRevision(sections[ordinal]),
      startOffset,
      endOffset: startOffset + sections[ordinal].length,
    },
  };
}

/** Guard a cached source descriptor against the exact canonical record used for its read. */
export function assertMemoryMaintenanceFragmentSource(
  source: Extract<AutomaticMaintenanceSourceV1, {kind: 'memory'}>,
  record: MemoryRecord,
): void {
  if (
    automaticMaintenanceEvidenceId(source) !==
    automaticMaintenanceEvidenceId(memoryMaintenanceFragmentSource(record, source.fragment.ordinal))
  )
    throw new Error('Canonical memory source fragment changed.');
}
