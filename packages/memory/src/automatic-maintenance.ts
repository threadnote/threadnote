import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseResourceId} from '@threadnote/store/resource-id';
import {
  assertMemoryCodeCitation,
  MAX_MEMORY_CODE_CITATIONS,
  MEMORY_SCHEMA_VERSION,
  type MemoryCodeCitationV1,
} from './code/citation.js';
import {
  canonicalMemoryDocumentContent,
  isAgentArtifactUri,
  isSharedMemoryUri,
  type MemoryObsidianEvidenceV1,
  type MemoryRecord,
} from './document.js';
import {consolidationRevision, consolidationSections} from './consolidation.js';
import {
  assertTopicMaintenanceObsidianEvidence,
  MAX_TOPIC_MAINTENANCE_PARAGRAPHS,
  MAX_TOPIC_MAINTENANCE_BYTES,
  topicMaintenanceObsidianCitationId,
  isCodeTopicMaintenanceManifest,
  topicMaintenanceAcceptedCitation,
  validateTopicMaintenanceManifest,
  type TopicMaintenanceClaimRole,
  type TopicMaintenanceSupport,
} from './topic-maintenance.js';
import {MAX_TOPIC_MAINTENANCE_BASIS_BYTES} from './topic-maintenance-draft.js';
import {memoryCodeCitationSharingBlocker} from './code/citation-policy.js';
import type {MemoryKind, MemoryStatus} from './types.js';

export const AUTOMATIC_MAINTENANCE_VERSION = 1 as const;
export const AUTOMATIC_MAINTENANCE_PREPARATION_VERSION = 1 as const;
export const MAX_AUTOMATIC_MAINTENANCE_BYTES = MAX_TOPIC_MAINTENANCE_BASIS_BYTES;

/** Exact read preconditions, not a semantic truth or publication assertion. */
export type AutomaticMaintenanceSourceV1 =
  | {readonly kind: 'code'; readonly citation: MemoryCodeCitationV1}
  | {readonly kind: 'obsidian'; readonly evidence: MemoryObsidianEvidenceV1}
  | {
      readonly kind: 'memory';
      readonly uri: string;
      readonly memoryId?: string;
      readonly canonicalHash: string;
      readonly fragment: {
        readonly ordinal: number;
        readonly hash: string;
        readonly startOffset: number;
        readonly endOffset: number;
      };
    };
export type AutomaticMaintenanceScope = 'personal' | 'shared' | 'external' | 'repository';
export interface AutomaticMaintenanceEvidenceV1 {
  /** Exact fragment identity. Multiple fragments from one source are allowed. */
  readonly id: string;
  readonly source: AutomaticMaintenanceSourceV1;
  readonly scope: AutomaticMaintenanceScope;
  readonly authority: 'recorded' | 'legacy-approved' | 'provisional';
  readonly availability: 'available' | 'missing' | 'expired' | 'revoked' | 'corrupt' | 'unknown';
}
export interface AutomaticMaintenanceTargetV1 {
  readonly uri: string;
  readonly memoryId?: string;
  readonly kind: MemoryKind;
  readonly status: MemoryStatus;
  readonly schemaVersion?: number;
  readonly canonicalHash: string;
  readonly bodyHash: string;
  readonly paragraphCount: number | null;
  readonly visibility: Exclude<AutomaticMaintenanceScope, 'repository'>;
  readonly readOnly: boolean;
  readonly artifact: boolean;
}
export interface AutomaticMaintenanceParagraphV1 {
  readonly ordinal: number;
  readonly hash: string;
  readonly role: TopicMaintenanceClaimRole | 'unknown';
  readonly roleAuthority: 'legacy-approved' | 'provisional';
  readonly support: TopicMaintenanceSupport;
  readonly supportAuthority: 'legacy-approved' | 'provisional';
  readonly historicalEvidenceIds: readonly string[];
  readonly acceptedEvidenceIds: readonly string[];
  readonly currentEvidenceIds: readonly string[];
  /** Newly mapped current support is provisional even for an approved legacy paragraph. */
  readonly currentSupport: TopicMaintenanceSupport;
  readonly currentSupportAuthority: 'provisional';
  readonly scope?: string;
  readonly validity?: string;
}
export interface AutomaticMaintenanceCoverageV1 {
  /** Structural coverage only; complete does not mean semantically verified. */
  readonly outcome: 'complete' | 'partial' | 'unknown';
  readonly scope: 'recorded-only' | 'bounded-search' | 'none';
  readonly searchedScopes: readonly string[];
  readonly omittedSources: number;
  readonly omittedParagraphs: number | null;
}
export type AutomaticMaintenanceReason =
  | 'inactive'
  | 'artifact'
  | 'missing-id'
  | 'read-only'
  | 'unsupported-schema'
  | 'coverage-gap'
  | 'protected-role'
  | 'evidence-unavailable'
  | 'target-bounds';
export interface AutomaticMaintenanceCapabilitiesV1 {
  readonly assess: boolean;
  readonly draft: boolean;
  /** Assessment, including legacy normalization, never grants a write or publish capability. */
  readonly apply: false;
  readonly publish: false;
  readonly reviewRoute: 'personal-review' | 'shared-owner-review' | 'read-only' | 'excluded';
  readonly reasons: readonly AutomaticMaintenanceReason[];
}
export interface AutomaticMaintenanceAssessmentV1 {
  readonly version: typeof AUTOMATIC_MAINTENANCE_VERSION;
  readonly preparation:
    | {readonly version: 1; readonly kind: 'derived'}
    | {
        readonly version: 1;
        readonly kind: 'legacy-approved';
        readonly manifestVersion: 1 | 2 | 3;
        readonly manifestHash: string;
      };
  readonly target: AutomaticMaintenanceTargetV1;
  readonly paragraphs: readonly AutomaticMaintenanceParagraphV1[];
  readonly evidence: readonly AutomaticMaintenanceEvidenceV1[];
  readonly dependencies: readonly {readonly kind: 'configuration' | 'dependency'; readonly evidenceId: string}[];
  readonly coverage: AutomaticMaintenanceCoverageV1;
  readonly capabilities: AutomaticMaintenanceCapabilitiesV1;
}

const HASH = /^[a-f0-9]{64}$/u;
const MEMORY_ID = /^tn_[a-z0-9_]{1,128}$/u;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function refuse(): never {
  throw new Error('Invalid or unsupported automatic memory maintenance assessment.');
}
function shape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !required.every(key => Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      key =>
        (!required.includes(key) && !optional.includes(key)) ||
        (optional.includes(key) && (value as Record<string, unknown>)[key] === undefined),
    )
  )
    refuse();
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): asserts value is T {
  if (typeof value !== 'string' || !values.includes(value as T)) refuse();
}
function count(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) refuse();
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) refuse();
}
function text(value: unknown, max = 4096): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    bytes(value) > max ||
    [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    refuse();
}
function uri(value: unknown): asserts value is string {
  text(value);
  const parsed = parseResourceId(value);
  if (parsed.anchor) refuse();
}
function memoryId(value: unknown): void {
  if (value !== undefined && (typeof value !== 'string' || !MEMORY_ID.test(value))) refuse();
}
function list(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) refuse();
}
function uniqueStrings(value: unknown, max: number): asserts value is string[] {
  list(value, max);
  value.forEach(item => text(item));
  if (new Set(value).size !== value.length) refuse();
}

export function automaticMaintenanceMemoryScope(uriValue: string): 'personal' | 'shared' | 'external' {
  const parsed = parseResourceId(uriValue);
  return isSharedMemoryUri(uriValue)
    ? 'shared'
    : parsed.namespace === 'user' && parsed.segments[1] === 'memories'
      ? 'personal'
      : 'external';
}

export function assertAutomaticMaintenanceSource(value: unknown): asserts value is AutomaticMaintenanceSourceV1 {
  shape(value, ['kind'], ['citation', 'evidence', 'uri', 'memoryId', 'canonicalHash', 'fragment']);
  if (value.kind === 'code') {
    shape(value, ['kind', 'citation']);
    assertMemoryCodeCitation(value.citation);
  } else if (value.kind === 'obsidian') {
    shape(value, ['kind', 'evidence']);
    assertTopicMaintenanceObsidianEvidence(value.evidence);
  } else if (value.kind === 'memory') {
    shape(value, ['kind', 'uri', 'canonicalHash', 'fragment'], ['memoryId']);
    uri(value.uri);
    memoryId(value.memoryId);
    hash(value.canonicalHash);
    shape(value.fragment, ['ordinal', 'hash', 'startOffset', 'endOffset']);
    count(value.fragment.ordinal);
    hash(value.fragment.hash);
    count(value.fragment.startOffset);
    count(value.fragment.endOffset);
    if (
      value.fragment.ordinal >= MAX_TOPIC_MAINTENANCE_PARAGRAPHS ||
      value.fragment.endOffset <= value.fragment.startOffset ||
      value.fragment.endOffset > MAX_TOPIC_MAINTENANCE_BYTES
    )
      refuse();
  } else refuse();
}

/** Stable source grouping differs from exact revision/fragment identity below. */
export function automaticMaintenanceSourceIdentity(source: AutomaticMaintenanceSourceV1): string {
  assertAutomaticMaintenanceSource(source);
  const parts =
    source.kind === 'code'
      ? ['code', source.citation.repositoryId, source.citation.path]
      : source.kind === 'memory'
        ? ['memory', source.uri, source.memoryId ?? null]
        : [
            'obsidian',
            source.evidence.sourceId,
            source.evidence.sourceInstanceId,
            source.evidence.vaultHash,
            source.evidence.accessHash,
            source.evidence.noteId,
          ];
  return `ams_${sha256HexSync(JSON.stringify(parts))}`;
}
export function automaticMaintenanceEvidenceId(source: AutomaticMaintenanceSourceV1): string {
  assertAutomaticMaintenanceSource(source);
  const parts =
    source.kind === 'code'
      ? ['code', source.citation.id]
      : source.kind === 'obsidian'
        ? ['obsidian', topicMaintenanceObsidianCitationId(source.evidence)]
        : [
            'memory',
            source.uri,
            source.memoryId ?? null,
            source.canonicalHash,
            source.fragment.ordinal,
            source.fragment.hash,
            source.fragment.startOffset,
            source.fragment.endOffset,
          ];
  return `ame_${sha256HexSync(JSON.stringify(parts))}`;
}
export function assertAutomaticMaintenanceEvidence(value: unknown): asserts value is AutomaticMaintenanceEvidenceV1 {
  shape(value, ['id', 'source', 'scope', 'authority', 'availability']);
  assertAutomaticMaintenanceSource(value.source);
  if (value.id !== automaticMaintenanceEvidenceId(value.source)) refuse();
  oneOf(value.scope, ['personal', 'shared', 'external', 'repository']);
  oneOf(value.authority, ['recorded', 'legacy-approved', 'provisional']);
  oneOf(value.availability, ['available', 'missing', 'expired', 'revoked', 'corrupt', 'unknown']);
  const scope =
    value.source.kind === 'code'
      ? 'repository'
      : value.source.kind === 'obsidian'
        ? 'personal'
        : automaticMaintenanceMemoryScope(value.source.uri);
  if (value.scope !== scope) refuse();
}

/** This eligibility calculation is advisory; later exact review/apply owns all authority checks. */
export function automaticMaintenanceCapabilities(
  target: AutomaticMaintenanceTargetV1,
  paragraphs: readonly AutomaticMaintenanceParagraphV1[],
  evidence: readonly AutomaticMaintenanceEvidenceV1[],
  coverage: AutomaticMaintenanceCoverageV1,
): AutomaticMaintenanceCapabilitiesV1 {
  const reasons: AutomaticMaintenanceReason[] = [];
  if (target.status !== 'active') reasons.push('inactive');
  if (target.artifact) reasons.push('artifact');
  if (!target.memoryId) reasons.push('missing-id');
  if (target.paragraphCount === null) reasons.push('target-bounds');
  if (target.readOnly || target.visibility === 'external') reasons.push('read-only');
  if ((target.schemaVersion ?? 1) > MEMORY_SCHEMA_VERSION) reasons.push('unsupported-schema');
  if (coverage.outcome !== 'complete' || coverage.omittedParagraphs || coverage.omittedSources)
    reasons.push('coverage-gap');
  const eligible = paragraphs.filter(
    paragraph => paragraph.role === 'descriptive' && paragraph.currentSupport === 'direct',
  );
  if (!eligible.length) reasons.push('protected-role');
  const available = new Set(evidence.filter(item => item.availability === 'available').map(item => item.id));
  const supported = eligible.some(
    paragraph => paragraph.currentEvidenceIds.length > 0 && paragraph.currentEvidenceIds.every(id => available.has(id)),
  );
  if (!supported) reasons.push('evidence-unavailable');
  const assess = target.status === 'active' && !target.artifact;
  return {
    assess,
    draft:
      assess &&
      Boolean(target.memoryId) &&
      !reasons.includes('unsupported-schema') &&
      coverage.omittedParagraphs === 0 &&
      supported,
    apply: false,
    publish: false,
    reviewRoute: !assess
      ? 'excluded'
      : target.readOnly || target.visibility === 'external'
        ? 'read-only'
        : target.visibility === 'shared'
          ? 'shared-owner-review'
          : 'personal-review',
    reasons,
  };
}

export function assertAutomaticMaintenanceAssessment(
  value: unknown,
): asserts value is AutomaticMaintenanceAssessmentV1 {
  shape(value, [
    'version',
    'preparation',
    'target',
    'paragraphs',
    'evidence',
    'dependencies',
    'coverage',
    'capabilities',
  ]);
  if (value.version !== AUTOMATIC_MAINTENANCE_VERSION || bytes(JSON.stringify(value)) > MAX_AUTOMATIC_MAINTENANCE_BYTES)
    refuse();
  shape(value.preparation, ['version', 'kind'], ['manifestVersion', 'manifestHash']);
  if (value.preparation.version !== AUTOMATIC_MAINTENANCE_PREPARATION_VERSION) refuse();
  if (value.preparation.kind === 'derived') shape(value.preparation, ['version', 'kind']);
  else if (value.preparation.kind === 'legacy-approved') {
    shape(value.preparation, ['version', 'kind', 'manifestVersion', 'manifestHash']);
    if (![1, 2, 3].includes(value.preparation.manifestVersion as number)) refuse();
    hash(value.preparation.manifestHash);
  } else refuse();
  const target = value.target;
  shape(
    target,
    ['uri', 'kind', 'status', 'canonicalHash', 'bodyHash', 'paragraphCount', 'visibility', 'readOnly', 'artifact'],
    ['memoryId', 'schemaVersion'],
  );
  uri(target.uri);
  memoryId(target.memoryId);
  hash(target.canonicalHash);
  hash(target.bodyHash);
  if (target.paragraphCount !== null) {
    count(target.paragraphCount);
    if (target.paragraphCount > MAX_TOPIC_MAINTENANCE_PARAGRAPHS) refuse();
  }
  oneOf(target.kind, ['durable', 'handoff', 'incident', 'preference', 'smoke']);
  oneOf(target.status, ['active', 'archived', 'expired', 'superseded']);
  if (
    target.visibility !== automaticMaintenanceMemoryScope(target.uri) ||
    typeof target.readOnly !== 'boolean' ||
    typeof target.artifact !== 'boolean' ||
    target.artifact !== isAgentArtifactUri(target.uri)
  )
    refuse();
  if (target.schemaVersion !== undefined) {
    count(target.schemaVersion);
    if (!target.schemaVersion) refuse();
  }
  list(value.evidence, MAX_MEMORY_CODE_CITATIONS);
  value.evidence.forEach(assertAutomaticMaintenanceEvidence);
  const evidence = value.evidence as AutomaticMaintenanceEvidenceV1[];
  const ids = new Set(evidence.map(item => item.id));
  if (ids.size !== evidence.length) refuse();
  list(value.paragraphs, MAX_TOPIC_MAINTENANCE_PARAGRAPHS);
  let previous = -1;
  for (const paragraph of value.paragraphs) {
    shape(
      paragraph,
      [
        'ordinal',
        'hash',
        'role',
        'roleAuthority',
        'support',
        'supportAuthority',
        'historicalEvidenceIds',
        'acceptedEvidenceIds',
        'currentEvidenceIds',
        'currentSupport',
        'currentSupportAuthority',
      ],
      ['scope', 'validity'],
    );
    count(paragraph.ordinal);
    hash(paragraph.hash);
    if (paragraph.ordinal <= previous || target.paragraphCount === null || paragraph.ordinal >= target.paragraphCount)
      refuse();
    previous = paragraph.ordinal;
    oneOf(paragraph.role, ['descriptive', 'normative', 'historical', 'unknown']);
    oneOf(paragraph.support, ['direct', 'contextual', 'unresolved']);
    oneOf(paragraph.currentSupport, ['direct', 'contextual', 'unresolved']);
    if (paragraph.currentSupportAuthority !== 'provisional') refuse();
    uniqueStrings(paragraph.historicalEvidenceIds, MAX_MEMORY_CODE_CITATIONS);
    uniqueStrings(paragraph.acceptedEvidenceIds, MAX_MEMORY_CODE_CITATIONS);
    uniqueStrings(paragraph.currentEvidenceIds, MAX_MEMORY_CODE_CITATIONS);
    oneOf(paragraph.roleAuthority, ['legacy-approved', 'provisional']);
    oneOf(paragraph.supportAuthority, ['legacy-approved', 'provisional']);
    if (
      [...paragraph.historicalEvidenceIds, ...paragraph.acceptedEvidenceIds, ...paragraph.currentEvidenceIds].some(
        id => !ids.has(id),
      )
    )
      refuse();
    if (
      value.preparation.kind === 'derived' &&
      (paragraph.roleAuthority !== 'provisional' || paragraph.supportAuthority !== 'provisional')
    )
      refuse();
    if (
      paragraph.supportAuthority === 'provisional' &&
      (paragraph.historicalEvidenceIds.length || paragraph.acceptedEvidenceIds.length)
    )
      refuse();
    if (
      [...paragraph.historicalEvidenceIds, ...paragraph.acceptedEvidenceIds].some(
        id => evidence.find(item => item.id === id)!.authority === 'provisional',
      )
    )
      refuse();
    const baselineCount =
      paragraph.supportAuthority === 'legacy-approved'
        ? paragraph.historicalEvidenceIds.length + paragraph.acceptedEvidenceIds.length
        : paragraph.currentEvidenceIds.length;
    if (
      (paragraph.support === 'unresolved') !== (baselineCount === 0) ||
      (paragraph.currentSupport === 'unresolved') !== (paragraph.currentEvidenceIds.length === 0)
    )
      refuse();
    if (
      paragraph.roleAuthority === 'provisional' &&
      ((target.kind === 'preference' && paragraph.role !== 'normative') ||
        ((target.kind === 'incident' || target.kind === 'handoff') && paragraph.role !== 'historical'))
    )
      refuse();
    // Match the existing approved-manifest contract exactly (UTF-16 length, tabs allowed).
    for (const field of [paragraph.scope, paragraph.validity])
      if (
        field !== undefined &&
        (typeof field !== 'string' || field.length === 0 || field.length > 512 || /[\r\n]/u.test(field))
      )
        refuse();
  }
  list(value.dependencies, MAX_MEMORY_CODE_CITATIONS);
  const dependencyIds = new Set<string>();
  for (const dependency of value.dependencies) {
    shape(dependency, ['kind', 'evidenceId']);
    oneOf(dependency.kind, ['configuration', 'dependency']);
    text(dependency.evidenceId);
    if (!ids.has(dependency.evidenceId) || dependencyIds.has(dependency.evidenceId)) refuse();
    dependencyIds.add(dependency.evidenceId);
  }
  shape(value.coverage, ['outcome', 'scope', 'searchedScopes', 'omittedSources', 'omittedParagraphs']);
  oneOf(value.coverage.outcome, ['complete', 'partial', 'unknown']);
  oneOf(value.coverage.scope, ['recorded-only', 'bounded-search', 'none']);
  uniqueStrings(value.coverage.searchedScopes, MAX_MEMORY_CODE_CITATIONS);
  count(value.coverage.omittedSources);
  if (value.coverage.omittedParagraphs !== null) count(value.coverage.omittedParagraphs);
  if (
    value.coverage.omittedParagraphs !==
      (target.paragraphCount === null ? null : target.paragraphCount - value.paragraphs.length) ||
    (value.coverage.outcome === 'complete' &&
      (value.coverage.omittedSources !== 0 || value.coverage.omittedParagraphs !== 0)) ||
    (value.coverage.scope === 'none' && value.coverage.searchedScopes.length)
  )
    refuse();
  const capabilities = value.capabilities;
  shape(capabilities, ['assess', 'draft', 'apply', 'publish', 'reviewRoute', 'reasons']);
  const expected = automaticMaintenanceCapabilities(
    target as unknown as AutomaticMaintenanceTargetV1,
    value.paragraphs as AutomaticMaintenanceParagraphV1[],
    evidence,
    value.coverage as unknown as AutomaticMaintenanceCoverageV1,
  );
  if (
    Object.keys(expected).some(
      key => JSON.stringify(capabilities[key]) !== JSON.stringify(expected[key as keyof typeof expected]),
    )
  )
    refuse();
}

export function encodeAutomaticMaintenanceAssessment(value: AutomaticMaintenanceAssessmentV1): string {
  assertAutomaticMaintenanceAssessment(value);
  return JSON.stringify(value);
}
export function parseAutomaticMaintenanceAssessment(encoded: string): AutomaticMaintenanceAssessmentV1 {
  if (bytes(encoded) > MAX_AUTOMATIC_MAINTENANCE_BYTES) refuse();
  const value: unknown = JSON.parse(encoded);
  assertAutomaticMaintenanceAssessment(value);
  return value;
}

/** Reuse canonical paragraph geometry and its fixed bounds; unavailable never means zero paragraphs. */
export function automaticMaintenanceSections(body: string): readonly string[] | undefined {
  try {
    return consolidationSections(body);
  } catch {
    return undefined;
  }
}

/** Must be repeated at consumption: a cache read is never authority over canonical content. */
export function assertAutomaticMaintenanceTarget(
  assessment: AutomaticMaintenanceAssessmentV1,
  record: MemoryRecord,
): void {
  assertAutomaticMaintenanceAssessment(assessment);
  const target = assessment.target;
  const sections = automaticMaintenanceSections(record.body);
  if (
    target.uri !== record.uri ||
    target.memoryId !== record.metadata.memoryId ||
    target.kind !== record.metadata.kind ||
    target.status !== record.metadata.status ||
    target.schemaVersion !== record.metadata.schemaVersion ||
    target.canonicalHash !== sha256HexSync(canonicalMemoryDocumentContent(record.content)) ||
    target.bodyHash !== consolidationRevision(record.body) ||
    target.paragraphCount !== (sections?.length ?? null) ||
    assessment.paragraphs.some(item => item.hash !== consolidationRevision(sections![item.ordinal]))
  )
    refuse();
  if (
    assessment.preparation.kind === 'legacy-approved' &&
    (!record.metadata.topicMaintenance ||
      assessment.preparation.manifestHash !== sha256HexSync(JSON.stringify(record.metadata.topicMaintenance)) ||
      assessment.preparation.manifestVersion !== record.metadata.topicMaintenance.version)
  )
    refuse();
  if (record.metadata.topicMaintenanceError) refuse();
  const manifest = record.metadata.topicMaintenance;
  if (manifest) {
    validateTopicMaintenanceManifest(manifest, record);
    if (assessment.preparation.kind !== 'legacy-approved') refuse();
    for (const paragraph of assessment.paragraphs) {
      const approved = manifest.paragraphs[paragraph.ordinal];
      if (
        paragraph.roleAuthority !== 'legacy-approved' ||
        paragraph.supportAuthority !== 'legacy-approved' ||
        paragraph.role !== approved.role ||
        paragraph.support !== approved.support ||
        paragraph.scope !== approved.scope ||
        paragraph.validity !== approved.validity
      )
        refuse();
      const originalIds = approved.citationIds.map(id => {
        if (isCodeTopicMaintenanceManifest(manifest))
          return automaticMaintenanceEvidenceId({
            kind: 'code',
            citation: record.metadata.codeCitations!.find(item => item.id === id)!,
          });
        const origin = record.metadata.obsidianEvidence!;
        return automaticMaintenanceEvidenceId({
          kind: 'obsidian',
          evidence: id === topicMaintenanceObsidianCitationId(origin) ? origin : manifest.activeEvidence,
        });
      });
      const acceptedIds = [
        ...new Set(
          approved.citationIds.map(id =>
            isCodeTopicMaintenanceManifest(manifest)
              ? automaticMaintenanceEvidenceId({kind: 'code', citation: topicMaintenanceAcceptedCitation(record, id)})
              : automaticMaintenanceEvidenceId({kind: 'obsidian', evidence: manifest.activeEvidence}),
          ),
        ),
      ];
      if (
        JSON.stringify(paragraph.historicalEvidenceIds) !== JSON.stringify(originalIds) ||
        JSON.stringify(paragraph.acceptedEvidenceIds) !== JSON.stringify(acceptedIds)
      )
        refuse();
    }
    const expectedDependencies = manifest.additionalDependencies.map(item => ({
      kind: item.kind,
      evidenceId: automaticMaintenanceEvidenceId({
        kind: 'code',
        citation: record.metadata.codeCitations!.find(citation => citation.id === item.citationId)!,
      }),
    }));
    if (JSON.stringify(assessment.dependencies) !== JSON.stringify(expectedDependencies)) refuse();
    const requiredSources: AutomaticMaintenanceSourceV1[] = (record.metadata.codeCitations ?? []).map(citation => ({
      kind: 'code',
      citation,
    }));
    if (record.metadata.obsidianEvidence)
      requiredSources.push({kind: 'obsidian', evidence: record.metadata.obsidianEvidence});
    if (!isCodeTopicMaintenanceManifest(manifest))
      requiredSources.push({kind: 'obsidian', evidence: manifest.activeEvidence});
    if (
      requiredSources.some(
        source =>
          !assessment.evidence.some(
            item => item.id === automaticMaintenanceEvidenceId(source) && item.authority !== 'provisional',
          ),
      )
    )
      refuse();
  } else if (assessment.preparation.kind !== 'derived') refuse();
}

/** Whole-value refusal keeps private URI/pin/fragment identities out of shared payloads. */
export function projectShareableAutomaticMaintenanceAssessment(
  assessment: AutomaticMaintenanceAssessmentV1,
): AutomaticMaintenanceAssessmentV1 | undefined {
  assertAutomaticMaintenanceAssessment(assessment);
  if (
    assessment.target.visibility !== 'shared' ||
    assessment.evidence.some(
      item => item.source.kind === 'obsidian' || item.scope === 'personal' || item.scope === 'external',
    )
  )
    return undefined;
  const codeCitations = assessment.evidence.flatMap(item =>
    item.source.kind === 'code' ? [item.source.citation] : [],
  );
  if (memoryCodeCitationSharingBlocker({codeCitations})) return undefined;
  return parseAutomaticMaintenanceAssessment(encodeAutomaticMaintenanceAssessment(assessment));
}
