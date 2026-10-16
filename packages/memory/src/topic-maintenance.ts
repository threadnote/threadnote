import {assertMemoryCodeCitation, MAX_MEMORY_CODE_CITATIONS, MEMORY_SCHEMA_VERSION} from './code/citation.js';
import {
  assertMemoryDocumentSchemaWritable,
  canonicalMemoryDocumentContent,
  isSharedMemoryUri,
  type MemoryMetadata,
  type MemoryRecord,
} from './document.js';
import {consolidationRevision, consolidationSections} from './consolidation.js';

export const TOPIC_MAINTENANCE_VERSION = 1 as const;
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

export function validateTopicMaintenanceManifest(manifest: unknown, record: MemoryRecord): TopicMaintenanceManifestV1 {
  validEvidence(record);
  if (
    !plainObject(manifest) ||
    !exactKeys(manifest, [
      'version',
      'memoryId',
      'repositoryId',
      'bodyHash',
      'coverage',
      'paragraphs',
      'additionalDependencies',
    ])
  )
    throw new Error('Topic maintenance manifest has an invalid shape.');
  if (manifest.version !== 1) throw new Error('Topic maintenance manifest has an unsupported version.');
  if (manifest.memoryId !== record.metadata.memoryId || !MEMORY_ID.test(manifest.memoryId as string))
    throw new Error('Topic maintenance memory identity changed.');
  if (manifest.repositoryId !== record.metadata.codeCitations![0].repositoryId)
    throw new Error('Topic maintenance repository identity changed.');
  if (manifest.bodyHash !== consolidationRevision(record.body) || !HASH.test(manifest.bodyHash))
    throw new Error('Topic maintenance body changed after enrollment.');
  if (manifest.coverage !== 'declared-only') throw new Error('Topic maintenance coverage must be declared-only.');
  const sections = consolidationSections(record.body);
  if (
    !Array.isArray(manifest.paragraphs) ||
    manifest.paragraphs.length !== sections.length ||
    manifest.paragraphs.length > MAX_TOPIC_MAINTENANCE_PARAGRAPHS
  )
    throw new Error('Topic maintenance paragraph count exceeds 64 or differs from the body.');
  const citationIds = new Set(record.metadata.codeCitations!.map(citation => citation.id));
  manifest.paragraphs.forEach((paragraph: unknown, ordinal: number) => {
    if (
      !plainObject(paragraph) ||
      !exactKeys(paragraph, ['ordinal', 'hash', 'role', 'support', 'citationIds'], ['scope', 'validity'])
    )
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} has an invalid shape.`);
    if (paragraph.ordinal !== ordinal || paragraph.hash !== consolidationRevision(sections[ordinal]))
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} changed after enrollment.`);
    if (
      !['descriptive', 'normative', 'historical'].includes(paragraph.role as string) ||
      !['direct', 'contextual', 'unresolved'].includes(paragraph.support as string)
    )
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} has an invalid role or support.`);
    if (
      !Array.isArray(paragraph.citationIds) ||
      paragraph.citationIds.length > MAX_MEMORY_CODE_CITATIONS ||
      new Set(paragraph.citationIds).size !== paragraph.citationIds.length ||
      paragraph.citationIds.some(
        (id: unknown) => typeof id !== 'string' || !CITATION_ID.test(id) || !citationIds.has(id),
      )
    )
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} cites an unknown citation.`);
    if ((paragraph.support === 'unresolved') !== (paragraph.citationIds.length === 0))
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} has invalid support coverage.`);
    for (const value of [paragraph.scope, paragraph.validity]) {
      if (
        value !== undefined &&
        (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\r\n]/u.test(value))
      )
        throw new Error(`Topic maintenance paragraph ${ordinal + 1} has invalid scope or validity.`);
    }
  });
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
  if (encodedBytes(JSON.stringify(manifest)) > MAX_TOPIC_MAINTENANCE_BYTES)
    throw new Error('Topic maintenance manifest exceeds the 32 KiB limit.');
  return manifest as unknown as TopicMaintenanceManifestV1;
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
  enrollment?: TopicMaintenanceManifestV1,
): string | undefined {
  if (!current) return undefined;
  if (current.metadata.topicMaintenanceError || next.metadata.topicMaintenanceError)
    return 'Topic maintenance metadata is malformed or stale; repair the enrolled topic before replacement.';
  const previous = current.metadata.topicMaintenance;
  const proposed = next.metadata.topicMaintenance;
  if (!previous && !proposed) return undefined;
  const sameEvidence =
    current.body === next.body &&
    JSON.stringify(current.metadata.codeCitations ?? []) === JSON.stringify(next.metadata.codeCitations ?? []);
  if (!previous && proposed && enrollment && sameEvidence && JSON.stringify(enrollment) === JSON.stringify(proposed)) {
    try {
      eligibleRecord(current);
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

function eligibleRecord(record: MemoryRecord, checkDocument = true): void {
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
  validEvidence(record);
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
