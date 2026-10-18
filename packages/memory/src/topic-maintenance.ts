import {
  assertMemoryCodeCitation,
  MAX_MEMORY_CODE_CITATIONS,
  MEMORY_SCHEMA_VERSION,
  type MemoryCodeCitationV1,
} from './code/citation.js';
import {
  assertMemoryDocumentSchemaWritable,
  canonicalMemoryDocumentContent,
  isSharedMemoryUri,
  type MemoryMetadata,
  type MemoryRecord,
  validMemoryObsidianEvidence,
  type MemoryObsidianEvidenceV1,
} from './document.js';
import {consolidationRevision, consolidationSections} from './consolidation.js';
import {sha256HexSync} from '@threadnote/platform/sha256';

export const TOPIC_MAINTENANCE_VERSION = 1 as const;
export const TOPIC_MAINTENANCE_ACCEPTED_VERSION = 2 as const;
export const MAX_TOPIC_MAINTENANCE_PARAGRAPHS = 64;
export const MAX_TOPIC_MAINTENANCE_BYTES = 32 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const CITATION_ID = /^tncc_[a-f0-9]{40}$/u;
const MEMORY_ID = /^tn_[a-z0-9_]{1,128}$/u;
const encodedBytes = (value: string) => new TextEncoder().encode(value).byteLength;

export type TopicMaintenanceClaimRole = 'descriptive' | 'normative' | 'historical';
export type TopicMaintenanceSupport = 'direct' | 'contextual' | 'unresolved';
export type TopicMaintenanceDependencyKind = 'configuration' | 'dependency';

export interface TopicMaintenanceParagraphInput {
  readonly role: TopicMaintenanceClaimRole;
  readonly support: TopicMaintenanceSupport;
  readonly citationIds: readonly string[];
  readonly scope?: string;
  readonly validity?: string;
}

export interface TopicMaintenanceParagraphV1 extends TopicMaintenanceParagraphInput {
  readonly ordinal: number;
  readonly hash: string;
}

export interface TopicMaintenanceDependencyV1 {
  readonly kind: TopicMaintenanceDependencyKind;
  readonly citationId: string;
}

export interface TopicMaintenanceManifestV1 {
  readonly version: typeof TOPIC_MAINTENANCE_VERSION;
  readonly memoryId: string;
  readonly repositoryId: string;
  readonly bodyHash: string;
  readonly coverage: 'declared-only';
  readonly paragraphs: readonly TopicMaintenanceParagraphV1[];
  readonly additionalDependencies: readonly TopicMaintenanceDependencyV1[];
}

export interface TopicMaintenanceAcceptedSourceV2 {
  readonly citationId: string;
  readonly acceptedCitationId: string;
}

export interface TopicMaintenanceManifestV2 extends Omit<TopicMaintenanceManifestV1, 'version'> {
  readonly version: typeof TOPIC_MAINTENANCE_ACCEPTED_VERSION;
  readonly originCitationIds: readonly string[];
  readonly acceptedSources: readonly TopicMaintenanceAcceptedSourceV2[];
}

export interface TopicMaintenanceCodeManifestV3 extends Omit<TopicMaintenanceManifestV2, 'version'> {
  readonly version: 3;
  readonly sourceKind: 'code';
  readonly dependencyExpansions?: readonly TopicDependencyExpansionReceiptV1[];
}

/** A bounded history of explicit metadata-only extensions; ordinary maintenance never discovers sources. */
export interface TopicDependencyExpansionReceiptV1 {
  readonly version: 1;
  readonly revision: string;
  readonly proofDigest: string;
  readonly requestDigest: string;
  readonly previousManifestHash: string;
  readonly sourceCommit: string;
  readonly citationIds: readonly string[];
}

/** The root obsidian_evidence is immutable origin; only this active pin advances. */
export interface TopicMaintenanceObsidianManifestV3 {
  readonly version: 3;
  readonly sourceKind: 'obsidian';
  readonly memoryId: string;
  readonly bodyHash: string;
  readonly coverage: 'declared-only';
  readonly paragraphs: readonly TopicMaintenanceParagraphV1[];
  readonly additionalDependencies: readonly [];
  readonly originCitationId: string;
  readonly activeEvidence: MemoryObsidianEvidenceV1;
}

export type TopicMaintenanceCodeManifest =
  TopicMaintenanceManifestV1 | TopicMaintenanceManifestV2 | TopicMaintenanceCodeManifestV3;
export type TopicMaintenanceManifestV3 = TopicMaintenanceCodeManifestV3 | TopicMaintenanceObsidianManifestV3;
export type TopicMaintenanceManifest = TopicMaintenanceCodeManifest | TopicMaintenanceObsidianManifestV3;

export function isCodeTopicMaintenanceManifest(
  manifest: TopicMaintenanceManifest,
): manifest is TopicMaintenanceCodeManifest {
  return manifest.version === 1 || manifest.version === 2 || (manifest.version === 3 && manifest.sourceKind === 'code');
}

/** Opaque immutable provider pin identity, independent of code citation grammar. */
export function topicMaintenanceObsidianCitationId(citation: MemoryObsidianEvidenceV1): string {
  assertTopicMaintenanceObsidianEvidence(citation);
  return `tnob_${sha256HexSync(
    JSON.stringify([
      citation.version,
      citation.sourceId,
      citation.sourceInstanceId,
      citation.vaultHash,
      citation.accessHash,
      citation.noteId,
      citation.relativePath,
      citation.revisionHash,
      citation.sanitizerVersion,
      citation.fragmentHash,
      citation.fragmentStart,
      citation.fragmentEnd,
      citation.pinId,
      citation.expiresAt,
    ]),
  ).slice(0, 40)}`;
}

export function assertTopicMaintenanceObsidianEvidence(value: unknown): asserts value is MemoryObsidianEvidenceV1 {
  if (
    !plainObject(value) ||
    !exactKeys(value, [
      'version',
      'sourceId',
      'sourceInstanceId',
      'vaultHash',
      'accessHash',
      'noteId',
      'relativePath',
      'revisionHash',
      'sanitizerVersion',
      'fragmentHash',
      'fragmentStart',
      'fragmentEnd',
      'pinId',
      'expiresAt',
    ]) ||
    !validMemoryObsidianEvidence(value) ||
    encodedBytes(JSON.stringify(value)) > 4096 ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt
  )
    throw new Error('Topic maintenance has invalid or unsupported Obsidian evidence.');
}

export function assertTopicMaintenanceSameObsidianNote(
  origin: MemoryObsidianEvidenceV1,
  active: MemoryObsidianEvidenceV1,
): void {
  assertTopicMaintenanceObsidianEvidence(origin);
  assertTopicMaintenanceObsidianEvidence(active);
  if (
    (['sourceId', 'sourceInstanceId', 'vaultHash', 'accessHash', 'noteId'] as const).some(
      key => origin[key] !== active[key],
    )
  )
    throw new Error('Topic maintenance Obsidian evidence changed source, access, vault or stable note identity.');
  if (
    origin.pinId === active.pinId &&
    topicMaintenanceObsidianCitationId(origin) !== topicMaintenanceObsidianCitationId(active)
  )
    throw new Error('Topic maintenance cannot rewrite immutable metadata for an existing Obsidian pin.');
}

/** Shared geometry/support validation; admission is decided by the source-specific contract. */
export function validateTopicMaintenanceParagraphs(
  body: string,
  paragraphs: unknown,
  admittedIds: ReadonlySet<string>,
): asserts paragraphs is readonly TopicMaintenanceParagraphV1[] {
  const sections = consolidationSections(body);
  if (
    !Array.isArray(paragraphs) ||
    paragraphs.length !== sections.length ||
    paragraphs.length > MAX_TOPIC_MAINTENANCE_PARAGRAPHS
  )
    throw new Error('Topic maintenance paragraph count exceeds 64 or differs from the body.');
  paragraphs.forEach((paragraph: unknown, ordinal: number) => {
    if (
      !plainObject(paragraph) ||
      !exactKeys(paragraph, ['ordinal', 'hash', 'role', 'support', 'citationIds'], ['scope', 'validity'])
    )
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} has an invalid shape.`);
    if (paragraph.ordinal !== ordinal || paragraph.hash !== consolidationRevision(sections[ordinal]))
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} changed after enrollment.`);
    if (
      typeof paragraph.role !== 'string' ||
      !['descriptive', 'normative', 'historical'].includes(paragraph.role) ||
      typeof paragraph.support !== 'string' ||
      !['direct', 'contextual', 'unresolved'].includes(paragraph.support)
    )
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} has an invalid role or support.`);
    if (
      !Array.isArray(paragraph.citationIds) ||
      paragraph.citationIds.length > MAX_MEMORY_CODE_CITATIONS ||
      new Set(paragraph.citationIds).size !== paragraph.citationIds.length ||
      paragraph.citationIds.some((id: unknown) => typeof id !== 'string' || !admittedIds.has(id))
    )
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} cites an unknown citation.`);
    if ((paragraph.support === 'unresolved') !== (paragraph.citationIds.length === 0))
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} has invalid support coverage.`);
    for (const value of [paragraph.scope, paragraph.validity])
      if (
        value !== undefined &&
        (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\r\n]/u.test(value))
      )
        throw new Error(`Topic maintenance paragraph ${ordinal + 1} has invalid scope or validity.`);
  });
}

function validateObsidianManifest(
  manifest: Record<string, unknown>,
  record: MemoryRecord,
): asserts manifest is Record<string, unknown> & TopicMaintenanceObsidianManifestV3 {
  if (
    !exactKeys(manifest, [
      'version',
      'sourceKind',
      'memoryId',
      'bodyHash',
      'coverage',
      'paragraphs',
      'additionalDependencies',
      'originCitationId',
      'activeEvidence',
    ]) ||
    manifest.version !== 3 ||
    manifest.sourceKind !== 'obsidian'
  )
    throw new Error('Topic maintenance imported manifest has an invalid shape.');
  eligibleRecord(record, false, false);
  const origin = record.metadata.obsidianEvidence;
  if (
    !/^threadnote:\/\/user\/[^/]+\/memories\/durable\/projects\//u.test(record.uri) ||
    record.metadata.visibility === 'shared' ||
    !origin ||
    record.metadata.obsidianEvidenceError ||
    record.metadata.sourceEvidence ||
    record.metadata.sourceEvidenceError ||
    record.metadata.codeCitations?.length ||
    record.metadata.consolidation ||
    record.metadata.consolidationError ||
    record.metadata.citationErrors?.length
  )
    throw new Error(
      'Topic maintenance imported evidence requires exactly one private Obsidian origin and no mixed provenance.',
    );
  assertTopicMaintenanceObsidianEvidence(origin);
  assertTopicMaintenanceObsidianEvidence(manifest.activeEvidence);
  assertTopicMaintenanceSameObsidianNote(origin, manifest.activeEvidence);
  if (
    manifest.memoryId !== record.metadata.memoryId ||
    manifest.originCitationId !== topicMaintenanceObsidianCitationId(origin) ||
    manifest.bodyHash !== consolidationRevision(record.body) ||
    manifest.coverage !== 'declared-only' ||
    !Array.isArray(manifest.additionalDependencies) ||
    manifest.additionalDependencies.length
  )
    throw new Error('Topic maintenance imported identity, body, or declared scope changed.');
  validateTopicMaintenanceParagraphs(
    record.body,
    manifest.paragraphs,
    new Set([topicMaintenanceObsidianCitationId(origin), topicMaintenanceObsidianCitationId(manifest.activeEvidence)]),
  );
  if (encodedBytes(JSON.stringify(manifest)) > MAX_TOPIC_MAINTENANCE_BYTES)
    throw new Error('Topic maintenance manifest exceeds the 32 KiB limit.');
}

/** Pure enrollment for an already-derived record. Runtime access/retention checks belong to the adapter. */
export function buildTopicMaintenanceObsidianManifest(
  record: MemoryRecord,
  input: TopicMaintenanceEnrollmentInput,
): TopicMaintenanceObsidianManifestV3 {
  input = validateTopicMaintenanceEnrollmentInput(input);
  eligibleRecord(record, true, false);
  if (input.additionalDependencies?.length) throw new Error('Imported topic dependencies are unsupported.');
  if (hasTopicMaintenanceEnrollment(record)) throw new Error('Topic maintenance is already enrolled.');
  const origin = record.metadata.obsidianEvidence;
  if (!origin) throw new Error('Imported topic requires an existing Obsidian origin pin.');
  const manifest: TopicMaintenanceObsidianManifestV3 = {
    version: 3,
    sourceKind: 'obsidian',
    memoryId: record.metadata.memoryId!,
    bodyHash: consolidationRevision(record.body),
    coverage: 'declared-only',
    paragraphs: consolidationSections(record.body).map((section, ordinal) => ({
      ...input.paragraphs[ordinal],
      ordinal,
      hash: consolidationRevision(section),
    })),
    additionalDependencies: [],
    originCitationId: topicMaintenanceObsidianCitationId(origin),
    activeEvidence: origin,
  };
  if (manifest.paragraphs.length !== input.paragraphs.length)
    throw new Error('Topic maintenance needs one support decision per exact paragraph.');
  validateTopicMaintenanceManifest(manifest, record);
  return manifest;
}

export interface TopicMaintenanceEnrollmentInput {
  readonly paragraphs: readonly TopicMaintenanceParagraphInput[];
  readonly additionalDependencies?: readonly TopicMaintenanceDependencyV1[];
}

/** Malformed enrollment still protects the topic from unrelated automatic lifecycle changes. */
export function hasTopicMaintenanceEnrollment(record: Pick<MemoryRecord, 'metadata'>): boolean {
  return record.metadata.topicMaintenance !== undefined || record.metadata.topicMaintenanceError !== undefined;
}

/** Closed boundary for JSON callers; annotations are supplied by the author. */
export function validateTopicMaintenanceEnrollmentInput(input: unknown): TopicMaintenanceEnrollmentInput {
  if (
    !plainObject(input) ||
    !exactKeys(input, ['paragraphs'], ['additionalDependencies']) ||
    !Array.isArray(input.paragraphs) ||
    !input.paragraphs.length ||
    input.paragraphs.length > MAX_TOPIC_MAINTENANCE_PARAGRAPHS
  )
    throw new Error('Topic maintenance input needs 1–64 paragraph decisions.');
  for (const paragraph of input.paragraphs) {
    if (!plainObject(paragraph) || !exactKeys(paragraph, ['role', 'support', 'citationIds'], ['scope', 'validity']))
      throw new Error('Topic maintenance paragraph input has unknown or missing fields.');
    if (
      !['descriptive', 'normative', 'historical'].includes(paragraph.role as string) ||
      !['direct', 'contextual', 'unresolved'].includes(paragraph.support as string) ||
      !Array.isArray(paragraph.citationIds)
    )
      throw new Error('Topic maintenance paragraph input has an invalid role or support.');
  }
  if (
    input.additionalDependencies !== undefined &&
    (!Array.isArray(input.additionalDependencies) ||
      input.additionalDependencies.length > MAX_MEMORY_CODE_CITATIONS ||
      input.additionalDependencies.some(
        (dependency: unknown) => !plainObject(dependency) || !exactKeys(dependency, ['kind', 'citationId']),
      ))
  )
    throw new Error('Topic maintenance dependency input has unknown fields or exceeds citation budget.');
  return input as unknown as TopicMaintenanceEnrollmentInput;
}

export function buildTopicMaintenanceManifest(
  record: MemoryRecord,
  input: TopicMaintenanceEnrollmentInput,
): TopicMaintenanceManifestV1 {
  input = validateTopicMaintenanceEnrollmentInput(input);
  eligibleRecord(record);
  const sections = consolidationSections(record.body);
  if (sections.length !== input.paragraphs.length)
    throw new Error('Topic maintenance needs one support decision per exact paragraph.');
  const manifest: TopicMaintenanceManifestV1 = {
    version: TOPIC_MAINTENANCE_VERSION,
    memoryId: record.metadata.memoryId!,
    repositoryId: record.metadata.codeCitations![0].repositoryId,
    bodyHash: consolidationRevision(record.body),
    coverage: 'declared-only',
    paragraphs: sections.map((section, ordinal) => {
      const decision = input.paragraphs[ordinal];
      return {
        ordinal,
        hash: consolidationRevision(section),
        role: decision.role,
        support: decision.support,
        citationIds: decision.citationIds,
        ...(decision.scope === undefined ? {} : {scope: decision.scope}),
        ...(decision.validity === undefined ? {} : {validity: decision.validity}),
      };
    }),
    additionalDependencies: input.additionalDependencies ?? [],
  };
  validateTopicMaintenanceManifest(manifest, record);
  return manifest;
}

function assertCodeManifestV3(
  manifest: Record<string, unknown>,
  record: MemoryRecord,
): asserts manifest is Record<string, unknown> & TopicMaintenanceCodeManifestV3 {
  if (manifest.sourceKind !== 'code') throw new Error('Topic maintenance source kind is unsupported.');
  if (
    !exactKeys(
      manifest,
      [
        'version',
        'sourceKind',
        'memoryId',
        'repositoryId',
        'bodyHash',
        'coverage',
        'paragraphs',
        'additionalDependencies',
        'acceptedSources',
        'originCitationIds',
      ],
      ['dependencyExpansions'],
    )
  )
    throw new Error('Topic maintenance code manifest has an invalid shape.');
  const {sourceKind: _sourceKind, dependencyExpansions, ...legacy} = manifest;
  validateTopicMaintenanceManifest({...legacy, version: 2}, record);
  if (dependencyExpansions !== undefined) {
    if (!Array.isArray(dependencyExpansions) || !dependencyExpansions.length || dependencyExpansions.length > 8)
      throw new Error('Topic maintenance expansion history is invalid.');
    const known = new Set(record.metadata.codeCitations!.map(citation => citation.id));
    for (const receipt of dependencyExpansions) {
      if (
        !plainObject(receipt) ||
        !exactKeys(receipt, [
          'version',
          'revision',
          'proofDigest',
          'requestDigest',
          'previousManifestHash',
          'sourceCommit',
          'citationIds',
        ]) ||
        receipt.version !== 1 ||
        ![receipt.revision, receipt.proofDigest, receipt.requestDigest, receipt.previousManifestHash].every(
          value => typeof value === 'string' && HASH.test(value),
        ) ||
        typeof receipt.sourceCommit !== 'string' ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(receipt.sourceCommit) ||
        !Array.isArray(receipt.citationIds) ||
        !receipt.citationIds.length ||
        receipt.citationIds.length > 8 ||
        receipt.citationIds.some(
          (id, index, ids) => typeof id !== 'string' || !known.has(id) || (index > 0 && id <= ids[index - 1]),
        )
      )
        throw new Error('Topic maintenance expansion receipt is malformed or has missing evidence.');
    }
  }
  if (encodedBytes(JSON.stringify(manifest)) > MAX_TOPIC_MAINTENANCE_BYTES)
    throw new Error('Topic maintenance manifest exceeds the 32 KiB limit.');
}

export function validateTopicMaintenanceManifest(manifest: unknown, record: MemoryRecord): TopicMaintenanceManifest {
  if (plainObject(manifest) && manifest.version === 3) {
    if (manifest.sourceKind === 'obsidian') validateObsidianManifest(manifest, record);
    else assertCodeManifestV3(manifest, record);
    return manifest;
  }
  validEvidence(record);
  if (
    !plainObject(manifest) ||
    !exactKeys(
      manifest,
      ['version', 'memoryId', 'repositoryId', 'bodyHash', 'coverage', 'paragraphs', 'additionalDependencies'],
      manifest.version === 2 ? ['acceptedSources', 'originCitationIds'] : [],
    )
  )
    throw new Error('Topic maintenance manifest has an invalid shape.');
  if (manifest.version !== 1 && manifest.version !== 2)
    throw new Error('Topic maintenance manifest has an unsupported version.');
  if (
    manifest.version === 2 &&
    (!Object.hasOwn(manifest, 'acceptedSources') || !Object.hasOwn(manifest, 'originCitationIds'))
  )
    throw new Error('Topic maintenance accepted source vector is missing.');
  if (manifest.memoryId !== record.metadata.memoryId || !MEMORY_ID.test(manifest.memoryId as string))
    throw new Error('Topic maintenance memory identity changed.');
  if (manifest.repositoryId !== record.metadata.codeCitations![0].repositoryId)
    throw new Error('Topic maintenance repository identity changed.');
  if (manifest.bodyHash !== consolidationRevision(record.body) || !HASH.test(manifest.bodyHash))
    throw new Error('Topic maintenance body changed after enrollment.');
  if (manifest.coverage !== 'declared-only') throw new Error('Topic maintenance coverage must be declared-only.');
  const citationIds = new Set(record.metadata.codeCitations!.map(citation => citation.id));
  validateTopicMaintenanceParagraphs(record.body, manifest.paragraphs, citationIds);
  if (
    !Array.isArray(manifest.additionalDependencies) ||
    manifest.additionalDependencies.length > MAX_MEMORY_CODE_CITATIONS
  )
    throw new Error('Topic maintenance additional dependency count exceeds citation budget.');
  const seen = new Set<string>();
  for (const dependency of manifest.additionalDependencies) {
    if (
      !plainObject(dependency) ||
      !exactKeys(dependency, ['kind', 'citationId']) ||
      !['configuration', 'dependency'].includes(dependency.kind as string) ||
      typeof dependency.citationId !== 'string' ||
      !citationIds.has(dependency.citationId)
    )
      throw new Error('Topic maintenance additional dependency cites an unknown citation.');
    if (seen.has(dependency.citationId)) throw new Error('Topic maintenance additional dependency is duplicated.');
    seen.add(dependency.citationId);
  }
  if (manifest.version === 2) {
    let priorOrigin = '';
    if (
      !Array.isArray(manifest.originCitationIds) ||
      manifest.originCitationIds.length < 1 ||
      manifest.originCitationIds.length > MAX_MEMORY_CODE_CITATIONS
    )
      throw new Error('Topic maintenance original citation lineage is invalid.');
    for (const id of manifest.originCitationIds) {
      if (typeof id !== 'string' || !CITATION_ID.test(id) || !citationIds.has(id) || id <= priorOrigin)
        throw new Error('Topic maintenance original citation lineage is missing or unordered.');
      priorOrigin = id;
    }
    const declared = new Set<string>([
      ...manifest.paragraphs.flatMap(paragraph => paragraph.citationIds),
      ...manifest.additionalDependencies.map(dependency => dependency.citationId),
    ]);
    const citations = new Map(record.metadata.codeCitations!.map(citation => [citation.id, citation]));
    if (
      !Array.isArray(manifest.acceptedSources) ||
      manifest.acceptedSources.length !== declared.size ||
      manifest.acceptedSources.length > MAX_MEMORY_CODE_CITATIONS
    )
      throw new Error('Topic maintenance accepted sources must cover every declared citation exactly once.');
    let previous = '';
    for (const entry of manifest.acceptedSources) {
      if (
        !plainObject(entry) ||
        !exactKeys(entry, ['citationId', 'acceptedCitationId']) ||
        typeof entry.citationId !== 'string' ||
        typeof entry.acceptedCitationId !== 'string' ||
        !CITATION_ID.test(entry.citationId) ||
        !CITATION_ID.test(entry.acceptedCitationId) ||
        !declared.has(entry.citationId) ||
        entry.citationId <= previous
      )
        throw new Error('Topic maintenance accepted source vector is malformed or unordered.');
      const original = citations.get(entry.citationId);
      const accepted = citations.get(entry.acceptedCitationId);
      if (
        !original ||
        !accepted ||
        accepted.repositoryId !== original.repositoryId ||
        accepted.target.kind !== original.target.kind
      )
        throw new Error('Topic maintenance accepted source cites unknown or incompatible evidence.');
      previous = entry.citationId;
    }
  }
  if (encodedBytes(JSON.stringify(manifest)) > MAX_TOPIC_MAINTENANCE_BYTES)
    throw new Error('Topic maintenance manifest exceeds the 32 KiB limit.');
  return manifest as unknown as TopicMaintenanceManifest;
}

/** Resolve the accepted comparison pin without changing the paragraph's historical support citation. */
export function topicMaintenanceAcceptedCitation(record: MemoryRecord, citationId: string): MemoryCodeCitationV1 {
  const manifest = record.metadata.topicMaintenance;
  if (!manifest) throw new Error('Topic maintenance is not enrolled.');
  const validated = validateTopicMaintenanceManifest(manifest, record);
  if (!isCodeTopicMaintenanceManifest(validated)) throw new Error('Imported evidence cannot be read as code.');
  const declared = new Set([
    ...validated.paragraphs.flatMap(paragraph => paragraph.citationIds),
    ...validated.additionalDependencies.map(dependency => dependency.citationId),
  ]);
  if (!declared.has(citationId)) throw new Error('Topic maintenance citation is not declared.');
  const acceptedId =
    validated.version !== 1
      ? validated.acceptedSources.find(source => source.citationId === citationId)!.acceptedCitationId
      : citationId;
  return record.metadata.codeCitations!.find(citation => citation.id === acceptedId)!;
}

/** A pure proposal; the application owns exact-target CAS and the approved write. */
export function proposeTopicMaintenanceEnrollment(
  record: MemoryRecord,
  input: TopicMaintenanceEnrollmentInput,
): {
  readonly manifest: TopicMaintenanceManifestV1;
  readonly metadata: MemoryMetadata;
  readonly content: string;
} {
  const manifest = buildTopicMaintenanceManifest(record, input);
  return proposeEnrollmentWithManifest(record, manifest);
}

export function proposeTopicMaintenanceObsidianEnrollment(
  record: MemoryRecord,
  input: TopicMaintenanceEnrollmentInput,
) {
  return proposeEnrollmentWithManifest(record, buildTopicMaintenanceObsidianManifest(record, input));
}

function proposeEnrollmentWithManifest<M extends TopicMaintenanceManifest>(record: MemoryRecord, manifest: M) {
  const raw = canonicalMemoryDocumentContent(record.content);
  const separator = /\r?\n\r?\n/u.exec(raw);
  const header = separator ? raw.slice(0, separator.index) : raw;
  const body = separator ? raw.slice(separator.index + separator[0].length) : '';
  if (header.split(/\r?\n/u).some(line => /^\s*topic_maintenance\s*:/u.test(line)))
    throw new Error('Topic maintenance is already enrolled; use an accepted update proposal.');
  const ending = header.includes('\r\n') ? '\r\n' : '\n';
  const versioned =
    record.metadata.schemaVersion === undefined
      ? `${header}${ending}schema_version: ${MEMORY_SCHEMA_VERSION}`
      : header.replace(/^schema_version: [1-9][0-9]*(?=\r?$)/mu, `schema_version: ${MEMORY_SCHEMA_VERSION}`);
  const updatedHeader = `${versioned}${ending}topic_maintenance: ${JSON.stringify(manifest)}`;
  return {
    manifest,
    metadata: {...record.metadata, schemaVersion: MEMORY_SCHEMA_VERSION, topicMaintenance: manifest},
    content: `${updatedHeader}${separator?.[0] ?? `${ending}${ending}`}${body}`,
  };
}

export function topicMaintenanceReplacementError(
  current: MemoryRecord | undefined,
  next: Pick<MemoryRecord, 'body' | 'metadata'>,
  enrollment?: TopicMaintenanceManifestV1 | TopicMaintenanceObsidianManifestV3,
): string | undefined {
  if (!current) return undefined;
  if (current.metadata.topicMaintenanceError || next.metadata.topicMaintenanceError)
    return 'Topic maintenance metadata is malformed or stale; repair the enrolled topic before replacement.';
  const previous = current.metadata.topicMaintenance;
  const proposed = next.metadata.topicMaintenance;
  if (!previous && !proposed) return undefined;
  const sameEvidence =
    current.body === next.body &&
    JSON.stringify(current.metadata.codeCitations ?? []) === JSON.stringify(next.metadata.codeCitations ?? []) &&
    JSON.stringify(current.metadata.obsidianEvidence ?? null) ===
      JSON.stringify(next.metadata.obsidianEvidence ?? null) &&
    JSON.stringify(current.metadata.sourceEvidence ?? null) === JSON.stringify(next.metadata.sourceEvidence ?? null) &&
    JSON.stringify(current.metadata.consolidation ?? null) === JSON.stringify(next.metadata.consolidation ?? null);
  if (!previous && proposed && enrollment && sameEvidence && JSON.stringify(enrollment) === JSON.stringify(proposed)) {
    try {
      eligibleRecord(current, true, isCodeTopicMaintenanceManifest(enrollment));
      validateTopicMaintenanceManifest(proposed, {...current, ...next});
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : 'Invalid topic enrollment.';
    }
  }
  if (!previous || !proposed) return 'Topic maintenance enrollment or removal requires its dedicated review path.';
  if (!sameEvidence || JSON.stringify(previous) !== JSON.stringify(proposed))
    return 'Topic maintenance body or cited provenance changed; use the reviewed update path.';
  return undefined;
}

function eligibleRecord(record: MemoryRecord, checkDocument = true, code = true): void {
  if (checkDocument) assertMemoryDocumentSchemaWritable(record.content);
  if (
    record.headerTitle !== 'MEMORY' ||
    record.metadata.kind !== 'durable' ||
    record.metadata.status !== 'active' ||
    isSharedMemoryUri(record.uri) ||
    !/\/memories\/durable\/projects\//u.test(record.uri)
  )
    throw new Error('Topic maintenance pilot requires one active personal durable record.');
  if (!record.metadata.memoryId || !MEMORY_ID.test(record.metadata.memoryId))
    throw new Error('Topic maintenance requires a stable memory ID.');
  if (code) validEvidence(record);
  if (record.metadata.topicMaintenanceError) throw new Error(record.metadata.topicMaintenanceError);
}

function validEvidence(record: MemoryRecord): void {
  const citations = record.metadata.codeCitations ?? [];
  if (!citations.length || citations.length > MAX_MEMORY_CODE_CITATIONS || record.metadata.citationErrors?.length)
    throw new Error('Topic maintenance requires 1–8 valid code citations.');
  const repository = citations[0].repositoryId;
  for (const citation of citations) {
    if (citation.sourceDirty) throw new Error('Topic maintenance cannot enroll dirty code evidence.');
    assertMemoryCodeCitation(citation);
    if (citation.repositoryId !== repository) throw new Error('Topic maintenance citations must use one repository.');
    if (citation.evidenceRetention !== 'capsule-retained')
      throw new Error('Topic maintenance requires recoverable code evidence.');
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  );
}
