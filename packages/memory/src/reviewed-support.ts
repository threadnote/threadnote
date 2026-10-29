import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseResourceId} from '@threadnote/store/resource-id';
import {serializeSourceEvidenceCitation, validSourceEvidenceCitation} from '@threadnote/store/source-evidence-citation';
import {
  assertAutomaticMaintenanceSource,
  automaticMaintenanceEvidenceId,
  automaticMaintenanceMemoryScope,
  type AutomaticMaintenanceScope,
  type AutomaticMaintenanceSourceV1,
} from './automatic-maintenance.js';
import {assertMemoryCodeCitation, MAX_MEMORY_CODE_CITATIONS, type MemoryCodeCitationV1} from './code/citation.js';
import {
  consolidationRevision,
  validateConsolidationProvenance,
  validateConsolidationProvenanceV2,
  validateConsolidationV2ActiveEvidence,
  type ConsolidationReceipt,
} from './consolidation.js';
import type {MemoryMetadata, MemoryRecord, MemoryRelation, MemoryObsidianEvidenceV1} from './document.js';
import {
  assertTopicMaintenanceObsidianEvidence,
  isCodeTopicMaintenanceManifest,
  validateTopicMaintenanceManifest,
  type TopicMaintenanceManifest,
  type TopicMaintenanceClaimRole,
  type TopicMaintenanceSupport,
} from './topic-maintenance.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const REVIEWED_MEMORY_SUPPORT_HEADER = 'reviewed_support';
export const MAX_REVIEWED_MEMORY_SUPPORT_BYTES = 384 * 1024;
/** Same paragraph geometry as legacy maintenance, without the automatic drafting size limit. */
export function reviewedSupportSections(body: string): readonly string[] {
  if (body.length > 1_000_000) fail();
  const sections = EffectArray.filter(
    EffectArray.map(Effect.pipe(body, EffectString.trim, EffectString.split(/\n[\t ]*\n/u)), section =>
      Effect.pipe(section, EffectString.trim),
    ),
    Boolean,
  );
  if (!sections.length || sections.length > 4096) fail();
  return sections;
}
export interface ApprovedSourceDescriptorV1 {
  readonly id: string;
  readonly source: AutomaticMaintenanceSourceV1;
  readonly scope: AutomaticMaintenanceScope;
  /** Portable shared-store location; the private read URI alone never authorizes export. */
  readonly locator?: {readonly repositoryId: string; readonly teamId: string; readonly path: string};
}
export interface ReviewedSupportParagraphV1 {
  readonly ordinal: number;
  readonly hash: string;
  readonly role: TopicMaintenanceClaimRole | 'unknown';
  readonly support: TopicMaintenanceSupport;
  readonly evidenceIds: readonly string[];
  readonly scope?: string;
  readonly validity?: string;
}
export interface ReviewedSupportSnapshotV1 {
  readonly bodyHash: string;
  readonly paragraphs: readonly ReviewedSupportParagraphV1[];
  readonly sources: readonly ApprovedSourceDescriptorV1[];
  readonly acceptance: {
    readonly reviewId: string;
    readonly approvedAt: string;
    readonly targetBeforeHash: string;
    readonly preparationDigest: string;
    readonly sourceVectorDigest: string;
  };
  readonly digest: string;
}
export interface ValidatedLegacySupportOriginV1 {
  readonly version: 1;
  readonly revision: string;
  readonly body: string;
  readonly memoryId?: string;
  readonly kind: MemoryMetadata['kind'];
  readonly status: MemoryMetadata['status'];
  readonly headerTitle: MemoryRecord['headerTitle'];
  readonly codeCitations: readonly MemoryCodeCitationV1[];
  readonly relations: readonly MemoryRelation[];
  readonly topicMaintenance?: TopicMaintenanceManifest;
  readonly consolidation?: ConsolidationReceipt;
  readonly obsidianEvidence?: MemoryObsidianEvidenceV1;
  readonly sourceEvidence?: MemoryMetadata['sourceEvidence'];
  readonly digest: string;
}
export interface ReviewedMemorySupportV1 {
  readonly type: 'reviewed-memory-support';
  readonly version: 1;
  readonly active: ReviewedSupportSnapshotV1;
  readonly initialApproval?: ReviewedSupportSnapshotV1;
  readonly legacyOrigin?: ValidatedLegacySupportOriginV1;
}
/** Current citation inputs for readers; canonical root pins remain immutable provenance. */
export function currentMemoryCodeCitations(record: MemoryRecord): readonly MemoryCodeCitationV1[] {
  if (record.metadata.reviewedSupportError !== undefined) fail();
  const support = record.metadata.reviewedSupport;
  if (support === undefined) {
    const header =
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
      Effect.pipe(record.content, EffectString.trim, EffectString.replace(/\r\n?/gu, '\n')).split('\n\n', 1)[0] ?? '';
    if (/^\s*reviewed_support\s*:/imu.test(header)) fail();
    return record.metadata.codeCitations ?? [];
  }
  if (record.metadata.schemaVersion !== 11) fail();
  const active = validateReviewedMemorySupport(support, record.body).active;
  const referenced = new Set(EffectArray.flatMap(active.paragraphs, paragraph => paragraph.evidenceIds));
  return EffectArray.flatMap(active.sources, descriptor =>
    referenced.has(descriptor.id) && descriptor.source.kind === 'code' ? [descriptor.source.citation] : [],
  );
}
const HASH = /^[a-f0-9]{64}$/u;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function fail(): never {
  throw new Error('Reviewed memory support is malformed, unsupported, or bound to a different body.');
}
function shape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    EffectArray.isArray(value) ||
    // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
    !EffectArray.every(required, key => Object.hasOwn(value, key)) ||
    EffectArray.some(
      EffectRecord.keys(value),
      key =>
        (!required.includes(key) && !optional.includes(key)) ||
        (optional.includes(key) && Reflect.get(value, key) === undefined),
    )
  )
    fail();
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) fail();
}
function text(value: unknown, max = 512): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    EffectArray.some(
      [...value],
      character =>
        Effect.pipe(
          character,
          EffectString.charCodeAt(0),
          Effect.Option.getOrElse(() => NaN),
        ) < 32 ||
        Effect.pipe(
          character,
          EffectString.charCodeAt(0),
          Effect.Option.getOrElse(() => NaN),
        ) === 127,
    )
  )
    fail();
}
function list(value: unknown, max: number): asserts value is unknown[] {
  if (!EffectArray.isArray(value) || value.length > max) fail();
}
function payloadDigest(value: {readonly digest?: unknown}): string {
  const {digest: _digest, ...payload} = value;
  return sha256HexSync(JSON.stringify(payload));
}
export function assertApprovedSourceDescriptor(value: unknown): asserts value is ApprovedSourceDescriptorV1 {
  shape(value, ['id', 'source', 'scope'], ['locator']);
  assertAutomaticMaintenanceSource(value.source);
  if (value.id !== automaticMaintenanceEvidenceId(value.source)) fail();
  const scope =
    value.source.kind === 'code'
      ? 'repository'
      : value.source.kind === 'obsidian'
        ? 'personal'
        : automaticMaintenanceMemoryScope(value.source.uri);
  if (value.scope !== scope) fail();
  if (value.source.kind === 'memory' && parseResourceId(value.source.uri).canonicalUri !== value.source.uri) fail();
  if (value.locator !== undefined) {
    if (value.source.kind !== 'memory' || scope !== 'shared' || !value.source.memoryId) fail();
    shape(value.locator, ['repositoryId', 'teamId', 'path']);
    hash(value.locator.repositoryId);
    text(value.locator.teamId, 128);
    text(value.locator.path, 4096);
    const resource = parseResourceId(value.source.uri);
    if (
      decodeURIComponent(resource.segments[3] ?? '') !== value.locator.teamId ||
      EffectArray.join(EffectArray.map(resource.segments.slice(4), decodeURIComponent), '/') !== value.locator.path
    )
      fail();
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value.locator.teamId) ||
      Effect.pipe(value.locator.path, EffectString.startsWith('/')) ||
      Effect.pipe(value.locator.path, EffectString.includes('\\')) ||
      EffectArray.some(
        Effect.pipe(value.locator.path, EffectString.split('/')),
        part => !part || part === '.' || part === '..',
      )
    )
      fail();
  }
}
function validReviewedSupportSnapshot(value: unknown, body?: string): value is ReviewedSupportSnapshotV1 {
  shape(value, ['bodyHash', 'paragraphs', 'sources', 'acceptance', 'digest']);
  hash(value.bodyHash);
  hash(value.digest);
  list(value.sources, MAX_MEMORY_CODE_CITATIONS);
  EffectArray.forEach(value.sources, assertApprovedSourceDescriptor);
  const ids = new Set(
    EffectArray.map(value.sources, source => {
      assertApprovedSourceDescriptor(source);
      return source.id;
    }),
  );
  if (ids.size !== value.sources.length) fail();
  list(value.paragraphs, 4096);
  if (!value.paragraphs.length) fail();
  const sections = body === undefined ? undefined : reviewedSupportSections(body);
  if (
    body !== undefined &&
    (value.bodyHash !== consolidationRevision(body) || sections!.length !== value.paragraphs.length)
  )
    fail();
  for (const [ordinal, paragraph] of value.paragraphs.entries()) {
    shape(paragraph, ['ordinal', 'hash', 'role', 'support', 'evidenceIds'], ['scope', 'validity']);
    hash(paragraph.hash);
    if (
      paragraph.ordinal !== ordinal ||
      (sections && paragraph.hash !== consolidationRevision(sections[ordinal])) ||
      typeof paragraph.role !== 'string' ||
      !['descriptive', 'normative', 'historical', 'unknown'].includes(paragraph.role) ||
      typeof paragraph.support !== 'string' ||
      !['direct', 'contextual', 'unresolved'].includes(paragraph.support)
    )
      fail();
    list(paragraph.evidenceIds, MAX_MEMORY_CODE_CITATIONS);
    if (
      new Set(paragraph.evidenceIds).size !== paragraph.evidenceIds.length ||
      EffectArray.some(paragraph.evidenceIds, id => typeof id !== 'string' || !ids.has(id)) ||
      (paragraph.support === 'unresolved') !== (paragraph.evidenceIds.length === 0)
    )
      fail();
    for (const field of [paragraph.scope, paragraph.validity])
      if (
        field !== undefined &&
        (typeof field !== 'string' || !field.length || field.length > 512 || /[\r\n]/u.test(field))
      )
        fail();
  }
  shape(value.acceptance, ['reviewId', 'approvedAt', 'targetBeforeHash', 'preparationDigest', 'sourceVectorDigest']);
  text(value.acceptance.reviewId, 128);
  if (!/^review-[a-z0-9-]{1,80}$/u.test(value.acceptance.reviewId)) fail();
  if (
    typeof value.acceptance.approvedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.acceptance.approvedAt)) ||
    new Date(value.acceptance.approvedAt).toISOString() !== value.acceptance.approvedAt
  )
    fail();
  for (const key of ['targetBeforeHash', 'preparationDigest', 'sourceVectorDigest']) hash(value.acceptance[key]);
  if (payloadDigest(value) !== value.digest || bytes(JSON.stringify(value)) > 128 * 1024) fail();
  return true;
}
export function validateReviewedSupportSnapshot(value: unknown, body?: string): ReviewedSupportSnapshotV1 {
  if (!validReviewedSupportSnapshot(value, body)) fail();
  return value;
}
export function createReviewedSupportSnapshot(
  input: Omit<ReviewedSupportSnapshotV1, 'digest'>,
): ReviewedSupportSnapshotV1 {
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
  const payload = Object.fromEntries(EffectArray.filter(Object.entries(input), ([key]) => key !== 'digest'));
  const snapshot = {...payload, digest: sha256HexSync(JSON.stringify(payload))};
  validateReviewedSupportSnapshot(snapshot);
  return structuredClone(validateReviewedSupportSnapshot(snapshot));
}
function assertReviewedSupportLegacyOriginShape(value: unknown): asserts value is ValidatedLegacySupportOriginV1 {
  shape(
    value,
    ['version', 'revision', 'body', 'kind', 'status', 'headerTitle', 'codeCitations', 'relations', 'digest'],
    ['memoryId', 'topicMaintenance', 'consolidation', 'obsidianEvidence', 'sourceEvidence'],
  );
  hash(value.revision);
  hash(value.digest);
  if (
    value.version !== 1 ||
    typeof value.body !== 'string' ||
    bytes(value.body) > 32 * 1024 ||
    typeof value.kind !== 'string' ||
    !['durable', 'handoff', 'incident', 'preference', 'smoke'].includes(value.kind) ||
    typeof value.status !== 'string' ||
    !['active', 'archived', 'expired', 'superseded'].includes(value.status) ||
    typeof value.headerTitle !== 'string' ||
    !['MEMORY', 'HANDOFF'].includes(value.headerTitle) ||
    (!value.topicMaintenance && !value.consolidation)
  )
    fail();
  if (
    value.memoryId !== undefined &&
    (typeof value.memoryId !== 'string' || !/^tn_[a-z0-9_]{1,128}$/u.test(value.memoryId))
  )
    fail();
  list(value.codeCitations, MAX_MEMORY_CODE_CITATIONS);
  EffectArray.forEach(value.codeCitations, assertMemoryCodeCitation);
  if (
    new Set(EffectArray.map(value.codeCitations, citation => assertMemoryCodeCitation(citation).id)).size !==
    value.codeCitations.length
  )
    fail();
  list(value.relations, 16);
  for (const relation of value.relations) {
    shape(relation, ['type', 'uri']);
    if (
      !['depends_on', 'evidence_for', 'references', 'related_to', 'supersedes'].includes(String(relation.type)) ||
      typeof relation.uri !== 'string' ||
      parseResourceId(relation.uri).canonicalUri !== relation.uri
    )
      fail();
  }
  if (value.obsidianEvidence !== undefined) assertTopicMaintenanceObsidianEvidence(value.obsidianEvidence);
  if (value.sourceEvidence !== undefined) {
    if (!validSourceEvidenceCitation(value.sourceEvidence)) fail();
    serializeSourceEvidenceCitation(value.sourceEvidence);
  }
}
export function validateReviewedSupportLegacyOrigin(value: unknown): ValidatedLegacySupportOriginV1 {
  assertReviewedSupportLegacyOriginShape(value);
  const origin = value;
  const record: MemoryRecord = {
    uri: 'threadnote://user/validator/memories/durable/projects/topic/record.md',
    content: '',
    body: origin.body,
    headerTitle: origin.headerTitle,
    metadata: {
      kind: origin.kind,
      status: origin.status,
      timestamp: '',
      sourceAgentClient: 'reviewed-support-origin',
      memoryId: origin.memoryId,
      schemaVersion: 10,
      codeCitations: origin.codeCitations,
      relations: origin.relations,
      obsidianEvidence: origin.obsidianEvidence,
      sourceEvidence: origin.sourceEvidence,
    },
  };
  const manifest = origin.topicMaintenance && validateTopicMaintenanceManifest(origin.topicMaintenance, record);
  if (origin.consolidation?.version === 2) {
    const receipt = validateConsolidationProvenanceV2(origin.consolidation, origin.body);
    if (!manifest || !isCodeTopicMaintenanceManifest(manifest) || manifest.version === 1) fail();
    validateConsolidationV2ActiveEvidence(receipt, manifest, origin.codeCitations, origin.relations);
  } else if (origin.consolidation) {
    const reviewed = validateConsolidationProvenance(origin.consolidation, origin.body, origin.status === 'archived');
    if (
      JSON.stringify(reviewed.codeCitations) !== JSON.stringify(origin.codeCitations) ||
      JSON.stringify(reviewed.relations) !== JSON.stringify(origin.relations)
    )
      fail();
  }
  if (payloadDigest(value) !== value.digest || bytes(JSON.stringify(value)) > 160 * 1024) fail();
  return origin;
}
export function captureReviewedSupportLegacyOrigin(record: MemoryRecord): ValidatedLegacySupportOriginV1 | undefined {
  if (record.metadata.reviewedSupport) return record.metadata.reviewedSupport.legacyOrigin;
  if (
    record.metadata.topicMaintenanceError ||
    record.metadata.consolidationError ||
    record.metadata.citationErrors?.length
  )
    fail();
  if (!record.metadata.topicMaintenance && !record.metadata.consolidation) return undefined;
  const payload = {
    version: 1 as const,
    revision: sha256HexSync(Effect.pipe(record.content, EffectString.trim)),
    body: record.body,
    ...(record.metadata.memoryId === undefined ? {} : {memoryId: record.metadata.memoryId}),
    kind: record.metadata.kind,
    status: record.metadata.status,
    headerTitle: record.headerTitle,
    codeCitations: record.metadata.codeCitations ?? [],
    relations: record.metadata.relations ?? [],
    ...(record.metadata.topicMaintenance ? {topicMaintenance: record.metadata.topicMaintenance} : {}),
    ...(record.metadata.consolidation ? {consolidation: record.metadata.consolidation} : {}),
    ...(record.metadata.obsidianEvidence ? {obsidianEvidence: record.metadata.obsidianEvidence} : {}),
    ...(record.metadata.sourceEvidence ? {sourceEvidence: record.metadata.sourceEvidence} : {}),
  };
  return structuredClone(
    validateReviewedSupportLegacyOrigin({...payload, digest: sha256HexSync(JSON.stringify(payload))}),
  );
}
function validReviewedMemorySupport(value: unknown, body: string): value is ReviewedMemorySupportV1 {
  shape(value, ['type', 'version', 'active'], ['initialApproval', 'legacyOrigin']);
  if (
    value.type !== 'reviewed-memory-support' ||
    value.version !== 1 ||
    bytes(JSON.stringify(value)) > MAX_REVIEWED_MEMORY_SUPPORT_BYTES
  )
    fail();
  validateReviewedSupportSnapshot(value.active, body);
  if (value.initialApproval !== undefined) validateReviewedSupportSnapshot(value.initialApproval);
  if (value.legacyOrigin !== undefined) validateReviewedSupportLegacyOrigin(value.legacyOrigin);
  return true;
}
export function validateReviewedMemorySupport(value: unknown, body: string): ReviewedMemorySupportV1 {
  if (!validReviewedMemorySupport(value, body)) fail();
  return value;
}
export function reviewedMemorySupportDigest(value: ReviewedMemorySupportV1): string {
  return sha256HexSync(JSON.stringify(value));
}
export function reviewedSupportReplacementError(
  current: (Pick<MemoryRecord, 'body' | 'metadata'> & Partial<Pick<MemoryRecord, 'content'>>) | undefined,
  next: Pick<MemoryRecord, 'body' | 'metadata'> & Partial<Pick<MemoryRecord, 'content'>>,
): string | undefined {
  if (current?.metadata.reviewedSupportError || next.metadata.reviewedSupportError)
    return 'Reviewed support metadata is malformed or stale; use the maintenance review/manual-preview path before replacement.';
  const previous = current?.metadata.reviewedSupport;
  const proposed = next.metadata.reviewedSupport;
  if (!previous && !proposed) return undefined;
  try {
    if (previous) validateReviewedMemorySupport(previous, current.body);
    if (proposed) validateReviewedMemorySupport(proposed, next.body);
  } catch {
    return 'Reviewed support metadata is malformed or stale; use the maintenance review/manual-preview path before replacement.';
  }
  if (!previous || !proposed || current.body !== next.body || JSON.stringify(previous) !== JSON.stringify(proposed))
    return 'Approved reviewed support cannot be added, changed, or removed by ordinary replacement; use the maintenance review/manual-preview path.';
  if (
    JSON.stringify(current.metadata.codeCitations ?? []) !== JSON.stringify(next.metadata.codeCitations ?? []) ||
    (current.content !== undefined &&
      next.content !== undefined &&
      JSON.stringify(rootCodeCitationLines(current.content)) !== JSON.stringify(rootCodeCitationLines(next.content)))
  )
    return 'Approved root code citations cannot be changed or removed by ordinary replacement; use the maintenance review/manual-preview path.';
  return undefined;
}

function rootCodeCitationLines(content: string): readonly string[] {
  // Browser newline normalization does not change the retained citation header bytes.
  const header =
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
    Effect.pipe(content, EffectString.trim, EffectString.replace(/\r\n?/gu, '\n')).split('\n\n', 1)[0] ?? '';
  return EffectArray.filter(
    Effect.pipe(header, EffectString.split('\n')),
    __effectArrayValue => !!(line => /^\s*code_citation\s*:/iu.test(line))(__effectArrayValue),
  );
}

export type ReviewedSupportSharingBlocker =
  | 'dirty-source'
  | 'local-repository-identity'
  | 'malformed-citation'
  | 'private-obsidian-evidence'
  | 'private-source-evidence';
/** Inspect the complete retained value, including unreferenced baseline/origin evidence. */
export function reviewedSupportSharingBlocker(
  value: ReviewedMemorySupportV1,
): ReviewedSupportSharingBlocker | undefined {
  try {
    shape(value, ['type', 'version', 'active'], ['initialApproval', 'legacyOrigin']);
    if (
      value.type !== 'reviewed-memory-support' ||
      value.version !== 1 ||
      bytes(JSON.stringify(value)) > MAX_REVIEWED_MEMORY_SUPPORT_BYTES
    )
      fail();
    validateReviewedSupportSnapshot(value.active);
    if (value.initialApproval) validateReviewedSupportSnapshot(value.initialApproval);
    if (value.legacyOrigin) validateReviewedSupportLegacyOrigin(value.legacyOrigin);
  } catch {
    return 'malformed-citation';
  }
  const citation = (entry: MemoryCodeCitationV1): ReviewedSupportSharingBlocker | undefined =>
    entry.sourceDirty
      ? 'dirty-source'
      : entry.repositoryIdentityKind !== 'remote'
        ? 'local-repository-identity'
        : undefined;
  const memoryUri = (uri: string): ReviewedSupportSharingBlocker | undefined =>
    automaticMaintenanceMemoryScope(uri) === 'shared' ? undefined : 'private-source-evidence';
  for (const snapshot of [value.active, value.initialApproval])
    for (const descriptor of snapshot?.sources ?? []) {
      if (descriptor.source.kind === 'obsidian') return 'private-obsidian-evidence';
      if (descriptor.source.kind === 'code') {
        const blocker = citation(descriptor.source.citation);
        if (blocker) return blocker;
      } else if (
        memoryUri(descriptor.source.uri) ||
        descriptor.scope !== 'shared' ||
        !descriptor.source.memoryId ||
        !descriptor.locator
      )
        return 'private-source-evidence';
    }
  const origin = value.legacyOrigin;
  if (origin) {
    if (origin.sourceEvidence) return 'private-source-evidence';
    if (
      origin.obsidianEvidence ||
      (origin.topicMaintenance && !isCodeTopicMaintenanceManifest(origin.topicMaintenance))
    )
      return 'private-obsidian-evidence';
    for (const entry of origin.codeCitations) {
      const blocker = citation(entry);
      if (blocker) return blocker;
    }
    for (const relation of origin.relations) if (memoryUri(relation.uri)) return 'private-source-evidence';
    const receipt = origin.consolidation?.version === 2 ? origin.consolidation.origin : origin.consolidation;
    for (const source of receipt?.sources ?? []) {
      if (memoryUri(source.uri)) return 'private-source-evidence';
      for (const entry of source.codeCitations) {
        const blocker = citation(entry);
        if (blocker) return blocker;
      }
      for (const relation of source.relations) if (memoryUri(relation.uri)) return 'private-source-evidence';
    }
  }
  return undefined;
}
