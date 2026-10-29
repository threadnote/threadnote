import {isSafeInteger as checkedIsSafeInteger, isOneOf as checkedIsOneOf} from '@threadnote/platform/validation';
import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseResourceId} from '@threadnote/store/resource-id';
import {
  assertMemoryCodeCitation,
  MAX_MEMORY_CODE_CITATIONS,
  MAX_SUPPORTED_MEMORY_SCHEMA_VERSION,
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
import {reviewedMemorySupportDigest, validateReviewedMemorySupport} from './reviewed-support.js';
import {memoryCodeCitationSharingBlocker} from './code/citation-policy.js';
import type {MemoryKind, MemoryStatus} from './types.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const AUTOMATIC_MAINTENANCE_VERSION = 1 as const;
export const AUTOMATIC_MAINTENANCE_PREPARATION_VERSION = 1 as const;
export const MAX_AUTOMATIC_MAINTENANCE_BYTES = 64 * 1024;
export const MAX_AUTOMATIC_MAINTENANCE_V2_BYTES = 1024 * 1024;
/** Eight immutable roots, eight approved active descriptors and eight current comparison reads. */
export const MAX_AUTOMATIC_MAINTENANCE_V2_EVIDENCE = 24;

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

export interface AutomaticMaintenanceParagraphV2 extends Omit<
  AutomaticMaintenanceParagraphV1,
  'roleAuthority' | 'supportAuthority'
> {
  readonly roleAuthority: 'reviewed';
  readonly supportAuthority: 'reviewed';
}
export interface AutomaticMaintenanceAssessmentV2 extends Omit<
  AutomaticMaintenanceAssessmentV1,
  'version' | 'preparation' | 'paragraphs'
> {
  readonly version: 2;
  readonly preparation: {readonly version: 2; readonly kind: 'reviewed-support'; readonly supportDigest: string};
  readonly paragraphs: readonly AutomaticMaintenanceParagraphV2[];
}
export type AutomaticMaintenanceAssessment = AutomaticMaintenanceAssessmentV1 | AutomaticMaintenanceAssessmentV2;
export type AutomaticMaintenanceParagraph = AutomaticMaintenanceParagraphV1 | AutomaticMaintenanceParagraphV2;

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const withRest = <const S extends Schema.Struct.Fields>(fields: S) =>
  Schema.StructWithRest(Schema.Struct(fields), [JsonRecordSchema]);
const AutomaticMaintenanceTargetSchema = withRest({
  artifact: Schema.Boolean,
  bodyHash: Schema.String,
  canonicalHash: Schema.String,
  kind: Schema.Literals(['durable', 'handoff', 'incident', 'preference', 'smoke']),
  memoryId: Schema.optionalKey(Schema.String),
  paragraphCount: Schema.NullOr(Schema.Finite),
  readOnly: Schema.Boolean,
  schemaVersion: Schema.optionalKey(Schema.Finite),
  status: Schema.Literals(['active', 'archived', 'expired', 'superseded']),
  uri: Schema.String,
  visibility: Schema.Literals(['personal', 'shared', 'external']),
});
const automaticMaintenanceParagraphFields = {
  acceptedEvidenceIds: Schema.Array(Schema.String),
  currentEvidenceIds: Schema.Array(Schema.String),
  currentSupport: Schema.Literals(['direct', 'contextual', 'unresolved']),
  currentSupportAuthority: Schema.Literal('provisional'),
  hash: Schema.String,
  historicalEvidenceIds: Schema.Array(Schema.String),
  ordinal: Schema.Finite,
  role: Schema.Literals(['descriptive', 'normative', 'historical', 'unknown']),
  scope: Schema.optionalKey(Schema.String),
  support: Schema.Literals(['direct', 'contextual', 'unresolved']),
  validity: Schema.optionalKey(Schema.String),
};
const AutomaticMaintenanceParagraphSchema = Schema.Union([
  withRest({
    ...automaticMaintenanceParagraphFields,
    roleAuthority: Schema.Literals(['legacy-approved', 'provisional']),
    supportAuthority: Schema.Literals(['legacy-approved', 'provisional']),
  }),
  withRest({
    ...automaticMaintenanceParagraphFields,
    roleAuthority: Schema.Literal('reviewed'),
    supportAuthority: Schema.Literal('reviewed'),
  }),
]);
const AutomaticMaintenanceCoverageSchema = withRest({
  omittedParagraphs: Schema.NullOr(Schema.Finite),
  omittedSources: Schema.Finite,
  outcome: Schema.Literals(['complete', 'partial', 'unknown']),
  scope: Schema.Literals(['recorded-only', 'bounded-search', 'none']),
  searchedScopes: Schema.Array(Schema.String),
});
function decodeValidated<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S['Type'] {
  try {
    return Schema.decodeUnknownSync(schema)(input);
  } catch {
    return refuse();
  }
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
    refuse();
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): asserts value is T {
  if (typeof value !== 'string' || !EffectArray.some(values, candidate => candidate === value)) refuse();
}
function count(value: unknown): asserts value is number {
  if (!checkedIsSafeInteger(value) || value < 0 || Object.is(value, -0)) refuse();
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) refuse();
}
function text(value: unknown, max = 4096): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    bytes(value) > max ||
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
  if (!EffectArray.isArray(value) || value.length > max) refuse();
}
function uniqueStrings(value: unknown, max: number): asserts value is string[] {
  list(value, max);
  EffectArray.forEach(value, item => text(item));
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

function validatedEvidence(value: unknown): AutomaticMaintenanceEvidenceV1 {
  assertAutomaticMaintenanceEvidence(value);
  return value;
}

/** This eligibility calculation is advisory; later exact review/apply owns all authority checks. */
export function automaticMaintenanceCapabilities(
  target: AutomaticMaintenanceTargetV1,
  paragraphs: readonly AutomaticMaintenanceParagraph[],
  evidence: readonly AutomaticMaintenanceEvidenceV1[],
  coverage: AutomaticMaintenanceCoverageV1,
): AutomaticMaintenanceCapabilitiesV1 {
  const reasons: AutomaticMaintenanceReason[] = [];
  if (target.status !== 'active') reasons.push('inactive');
  if (target.artifact) reasons.push('artifact');
  if (!target.memoryId) reasons.push('missing-id');
  if (target.paragraphCount === null) reasons.push('target-bounds');
  if (target.readOnly || target.visibility === 'external') reasons.push('read-only');
  if ((target.schemaVersion ?? 1) > MAX_SUPPORTED_MEMORY_SCHEMA_VERSION) reasons.push('unsupported-schema');
  if (coverage.outcome !== 'complete' || coverage.omittedParagraphs || coverage.omittedSources)
    reasons.push('coverage-gap');
  const eligible = EffectArray.filter(
    paragraphs,
    paragraph => paragraph.role === 'descriptive' && paragraph.currentSupport === 'direct',
  );
  if (!eligible.length) reasons.push('protected-role');
  const available = new Set(
    EffectArray.map(
      EffectArray.filter(evidence, item => item.availability === 'available'),
      item => item.id,
    ),
  );
  const supported = EffectArray.some(
    eligible,
    paragraph =>
      paragraph.currentEvidenceIds.length > 0 &&
      EffectArray.every(paragraph.currentEvidenceIds, id => available.has(id)),
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

export function assertAutomaticMaintenanceAssessment(value: unknown): asserts value is AutomaticMaintenanceAssessment {
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
  if (
    (value.version !== AUTOMATIC_MAINTENANCE_VERSION && value.version !== 2) ||
    bytes(JSON.stringify(value)) >
      (value.version === 2 ? MAX_AUTOMATIC_MAINTENANCE_V2_BYTES : MAX_AUTOMATIC_MAINTENANCE_BYTES)
  )
    refuse();
  if (value.version === 2) {
    shape(value.preparation, ['version', 'kind', 'supportDigest']);
    if (value.preparation.version !== 2 || value.preparation.kind !== 'reviewed-support') refuse();
    hash(value.preparation.supportDigest);
  } else {
    shape(value.preparation, ['version', 'kind'], ['manifestVersion', 'manifestHash']);
    if (value.preparation.version !== AUTOMATIC_MAINTENANCE_PREPARATION_VERSION) refuse();
    if (value.preparation.kind === 'derived') shape(value.preparation, ['version', 'kind']);
    else if (value.preparation.kind === 'legacy-approved') {
      shape(value.preparation, ['version', 'kind', 'manifestVersion', 'manifestHash']);
      if (!checkedIsOneOf([1, 2, 3], value.preparation.manifestVersion)) refuse();
      hash(value.preparation.manifestHash);
    } else refuse();
  }
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
  list(value.evidence, value.version === 2 ? MAX_AUTOMATIC_MAINTENANCE_V2_EVIDENCE : MAX_MEMORY_CODE_CITATIONS);
  EffectArray.forEach(value.evidence, assertAutomaticMaintenanceEvidence);
  const evidence = EffectArray.map(value.evidence, item => validatedEvidence(item));
  const ids = new Set(EffectArray.map(evidence, item => item.id));
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
    oneOf(paragraph.roleAuthority, value.version === 2 ? ['reviewed'] : ['legacy-approved', 'provisional']);
    oneOf(paragraph.supportAuthority, value.version === 2 ? ['reviewed'] : ['legacy-approved', 'provisional']);
    if (
      EffectArray.some(
        [...paragraph.historicalEvidenceIds, ...paragraph.acceptedEvidenceIds, ...paragraph.currentEvidenceIds],
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
      EffectArray.some(
        [...paragraph.historicalEvidenceIds, ...paragraph.acceptedEvidenceIds],
        id =>
          EffectOption.getOrUndefined(EffectArray.findFirst(evidence, item => item.id === id))!.authority ===
          'provisional',
      )
    )
      refuse();
    const baselineCount =
      paragraph.supportAuthority !== 'provisional'
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
    decodeValidated(AutomaticMaintenanceTargetSchema, target),
    decodeValidated(Schema.Array(AutomaticMaintenanceParagraphSchema), value.paragraphs),
    evidence,
    decodeValidated(AutomaticMaintenanceCoverageSchema, value.coverage),
  );
  if (
    EffectArray.some(
      EffectRecord.keys(expected),
      key => JSON.stringify(capabilities[key]) !== JSON.stringify(expected[key]),
    )
  )
    refuse();
}

export function encodeAutomaticMaintenanceAssessment(value: AutomaticMaintenanceAssessment): string {
  assertAutomaticMaintenanceAssessment(value);
  return JSON.stringify(value);
}
export function parseAutomaticMaintenanceAssessment(encoded: string): AutomaticMaintenanceAssessment {
  if (bytes(encoded) > MAX_AUTOMATIC_MAINTENANCE_V2_BYTES) refuse();
  const value: unknown = JSON.parse(encoded);
  assertAutomaticMaintenanceAssessment(value);
  if (value.version === 1 && bytes(encoded) > MAX_AUTOMATIC_MAINTENANCE_BYTES) refuse();
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
  assessment: AutomaticMaintenanceAssessment,
  record: MemoryRecord,
): void {
  assertAutomaticMaintenanceAssessment(assessment);
  const target = assessment.target;
  const paragraphs: readonly AutomaticMaintenanceParagraph[] = assessment.paragraphs;
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
    EffectArray.some(paragraphs, item => item.hash !== consolidationRevision(sections![item.ordinal]))
  )
    refuse();
  if (record.metadata.reviewedSupportError) refuse();
  if (record.metadata.reviewedSupport) {
    const support = validateReviewedMemorySupport(record.metadata.reviewedSupport, record.body);
    if (assessment.version !== 2 || assessment.preparation.supportDigest !== reviewedMemorySupportDigest(support))
      refuse();
    for (const paragraph of assessment.paragraphs) {
      const approved = support.active.paragraphs[paragraph.ordinal];
      if (
        !approved ||
        paragraph.roleAuthority !== 'reviewed' ||
        paragraph.supportAuthority !== 'reviewed' ||
        paragraph.role !== approved.role ||
        paragraph.support !== approved.support ||
        paragraph.scope !== approved.scope ||
        paragraph.validity !== approved.validity ||
        JSON.stringify(paragraph.acceptedEvidenceIds) !== JSON.stringify(approved.evidenceIds) ||
        paragraph.historicalEvidenceIds.length !== 0
      )
        refuse();
    }
    if (
      assessment.dependencies.length ||
      EffectArray.some(
        support.active.sources,
        source =>
          !EffectArray.some(
            assessment.evidence,
            item =>
              item.id === source.id &&
              item.authority !== 'provisional' &&
              JSON.stringify(item.source) === JSON.stringify(source.source),
          ),
      )
    )
      refuse();
    return;
  }
  if (assessment.version === 2) refuse();
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
      const originalIds = EffectArray.map(approved.citationIds, id => {
        if (isCodeTopicMaintenanceManifest(manifest))
          return automaticMaintenanceEvidenceId({
            kind: 'code',
            citation: EffectOption.getOrUndefined(
              EffectArray.findFirst(record.metadata.codeCitations!, item => item.id === id),
            )!,
          });
        const origin = record.metadata.obsidianEvidence!;
        return automaticMaintenanceEvidenceId({
          kind: 'obsidian',
          evidence: id === topicMaintenanceObsidianCitationId(origin) ? origin : manifest.activeEvidence,
        });
      });
      const acceptedIds = [
        ...new Set(
          EffectArray.map(approved.citationIds, id =>
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
    const expectedDependencies = EffectArray.map(manifest.additionalDependencies, item => ({
      kind: item.kind,
      evidenceId: automaticMaintenanceEvidenceId({
        kind: 'code',
        citation: EffectOption.getOrUndefined(
          EffectArray.findFirst(record.metadata.codeCitations!, citation => citation.id === item.citationId),
        )!,
      }),
    }));
    if (JSON.stringify(assessment.dependencies) !== JSON.stringify(expectedDependencies)) refuse();
    const requiredSources: AutomaticMaintenanceSourceV1[] = EffectArray.map(
      record.metadata.codeCitations ?? [],
      citation => ({
        kind: 'code',
        citation,
      }),
    );
    if (record.metadata.obsidianEvidence)
      requiredSources.push({kind: 'obsidian', evidence: record.metadata.obsidianEvidence});
    if (!isCodeTopicMaintenanceManifest(manifest))
      requiredSources.push({kind: 'obsidian', evidence: manifest.activeEvidence});
    if (
      EffectArray.some(
        requiredSources,
        source =>
          !EffectArray.some(
            assessment.evidence,
            item => item.id === automaticMaintenanceEvidenceId(source) && item.authority !== 'provisional',
          ),
      )
    )
      refuse();
  } else if (assessment.preparation.kind !== 'derived') refuse();
}

/** Whole-value refusal keeps private URI/pin/fragment identities out of shared payloads. */
export function projectShareableAutomaticMaintenanceAssessment(
  assessment: AutomaticMaintenanceAssessment,
): AutomaticMaintenanceAssessment | undefined {
  assertAutomaticMaintenanceAssessment(assessment);
  if (
    assessment.target.visibility !== 'shared' ||
    EffectArray.some(
      assessment.evidence,
      item => item.source.kind === 'obsidian' || item.scope === 'personal' || item.scope === 'external',
    )
  )
    return undefined;
  const codeCitations = EffectArray.flatMap(assessment.evidence, item =>
    item.source.kind === 'code' ? [item.source.citation] : [],
  );
  if (memoryCodeCitationSharingBlocker({codeCitations})) return undefined;
  return parseAutomaticMaintenanceAssessment(encodeAutomaticMaintenanceAssessment(assessment));
}
