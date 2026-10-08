import {sha256HexSync} from '@threadnote/platform/sha256';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {
  canonicalMemoryDocumentContent,
  isIsoDateOrCanonicalIsoInstant,
  isSharedMemoryUri,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {migrateMemoryDocumentToCurrent} from '../migrations.js';

export const MAINTENANCE_METADATA_VERSION = 1 as const;
const OWNER_MAXIMUM_CHARACTERS = 128;

export interface MaintenanceMetadataPatchV1 {
  /** undefined preserves; null clears. */
  readonly owner?: string | null;
  /** undefined preserves; null clears; strings are ISO calendar dates or canonical ISO instants. */
  readonly reviewAfter?: string | null;
  /** undefined preserves; null clears; strings are canonical ISO instants. */
  readonly validTo?: string | null;
}

export interface MaintenanceMetadataProposalV1 {
  readonly current: {readonly owner?: string; readonly reviewAfter?: string; readonly validTo?: string};
  readonly expectedContentHash: string;
  readonly expectedMemoryId?: string;
  readonly patch: MaintenanceMetadataPatchV1;
  readonly proposalId: string;
  readonly revision: string;
  readonly schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  readonly targetUri: string;
  readonly version: typeof MAINTENANCE_METADATA_VERSION;
}

export type MaintenanceMetadataPreviewV1 =
  | {readonly proposal: MaintenanceMetadataProposalV1; readonly status: 'preview'}
  | {readonly code: string; readonly message: string; readonly status: 'conflict'};

export type MaintenanceMetadataApplyV1 =
  | {readonly content: string; readonly proposal: MaintenanceMetadataProposalV1; readonly status: 'applied'}
  | {readonly proposal: MaintenanceMetadataProposalV1; readonly status: 'already-applied'}
  | {readonly code: string; readonly message: string; readonly status: 'conflict'};

/**
 * Pure exact-target preview. Callers must supply their authorized local record
 * snapshot; shared, non-durable, inactive, ambiguous, and malformed records
 * are deliberately not eligible.
 */
export function previewMaintenanceMetadataV1(
  records: readonly MemoryRecord[],
  selector: string,
  patch: MaintenanceMetadataPatchV1,
): MaintenanceMetadataPreviewV1 {
  const checkedPatch = validatePatch(patch);
  if (checkedPatch !== undefined) return checkedPatch;
  const target = selectTarget(records, selector);
  if ('status' in target) return target;
  if (patch.owner === undefined && patch.reviewAfter === undefined && patch.validTo === undefined) {
    return conflict('empty-patch', 'Select at least one metadata field to set or clear.');
  }
  const current = metadataView(target);
  const base = {
    current,
    expectedContentHash: memoryContentHash(target.content),
    ...(target.metadata.memoryId === undefined ? {} : {expectedMemoryId: target.metadata.memoryId}),
    patch: normalizedPatch(patch),
    proposalId: '',
    targetUri: target.uri,
    version: MAINTENANCE_METADATA_VERSION,
    schemaVersion: MEMORY_SCHEMA_VERSION,
  } satisfies Omit<MaintenanceMetadataProposalV1, 'revision'>;
  const withId = {...base, proposalId: proposalId(base)};
  return {proposal: {...withId, revision: proposalRevision(withId)}, status: 'preview'};
}

/** Apply only the exact proposal observed by preview. It is pure so storage can perform the enclosing URI lock/CAS. */
export function applyMaintenanceMetadataV1(input: {
  readonly approved?: boolean;
  readonly expectedContentHash: string;
  readonly expectedRevision: string;
  readonly proposal: MaintenanceMetadataProposalV1;
  readonly record: MemoryRecord | undefined;
  readonly updatedAt: string;
}): MaintenanceMetadataApplyV1 {
  const {proposal, record} = input;
  if (input.approved !== true)
    return conflict('approval-required', 'Metadata apply requires approved=true after preview.');
  if (proposalId(proposal) !== proposal.proposalId || proposalRevision(proposal) !== proposal.revision)
    return conflict('invalid-proposal', 'The metadata proposal identity or revision is invalid.');
  if (proposal.schemaVersion !== MEMORY_SCHEMA_VERSION)
    return conflict('invalid-proposal', 'The metadata proposal does not target the current memory schema.');
  if (input.expectedRevision !== proposal.revision)
    return conflict('revision-mismatch', 'The metadata proposal revision is not the previewed revision.');
  if (input.expectedContentHash !== proposal.expectedContentHash)
    return conflict('content-hash-mismatch', 'The supplied target content hash is not the previewed hash.');
  if (!isCanonicalIsoInstant(input.updatedAt))
    return conflict('invalid-updated-at', 'updated_at must be a canonical ISO instant.');
  if (record === undefined) return conflict('target-missing', 'The metadata target is no longer readable.');
  const target = eligibleRecord(record);
  if (target === undefined)
    return conflict('target-ineligible', 'Only active personal durable memories can receive maintenance metadata.');
  if (target.uri !== proposal.targetUri || target.metadata.memoryId !== proposal.expectedMemoryId)
    return conflict('identity-mismatch', 'The stable identity no longer matches the previewed target.');
  const observedHash = memoryContentHash(target.content);
  if (observedHash !== proposal.expectedContentHash) {
    if (patchMatches(target, proposal.patch)) return {proposal, status: 'already-applied'};
    return conflict('content-changed', 'Memory content changed after preview; run a new preview.');
  }
  return {
    content: rewriteMaintenanceMetadata(target.content, proposal.patch, input.updatedAt),
    proposal,
    status: 'applied',
  };
}

/** Metadata-only rewriter: all unrelated raw header lines and body bytes survive unchanged. */
export function rewriteMaintenanceMetadata(
  content: string,
  patch: MaintenanceMetadataPatchV1,
  updatedAt: string,
): string {
  const canonical = migrateMemoryDocumentToCurrent(canonicalMemoryDocumentContent(content)).replace(/\r\n?/gu, '\n');
  const separator = canonical.indexOf('\n\n');
  const header = separator === -1 ? canonical : canonical.slice(0, separator);
  const body = separator === -1 ? '' : canonical.slice(separator + 2);
  const desired = new Map<string, string | undefined>([
    ['owner', patch.owner === undefined ? headerValue(header, 'owner') : (patch.owner ?? undefined)],
    [
      'review_after',
      patch.reviewAfter === undefined ? headerValue(header, 'review_after') : (patch.reviewAfter ?? undefined),
    ],
    ['valid_to', patch.validTo === undefined ? headerValue(header, 'valid_to') : (patch.validTo ?? undefined)],
    ['updated_at', updatedAt],
  ]);
  const seen = new Set<string>();
  const lines = header.split('\n').flatMap(line => {
    const key = line.slice(0, line.indexOf(':')).trim();
    if (!desired.has(key)) return [line];
    if (seen.has(key)) return [line]; // malformed duplicates are preserved; eligibility rejects their parsed ambiguity.
    seen.add(key);
    const value = desired.get(key);
    return value === undefined ? [] : [`${key}: ${value}`];
  });
  for (const key of ['owner', 'review_after', 'valid_to', 'updated_at']) {
    if (!seen.has(key) && desired.get(key) !== undefined) lines.push(`${key}: ${desired.get(key)}`);
  }
  return body ? `${lines.join('\n')}\n\n${body}` : lines.join('\n');
}

function selectTarget(records: readonly MemoryRecord[], selector: string): MemoryRecord | MaintenanceMetadataPreviewV1 {
  const identity = memoryIdFromIdentityAlias(selector);
  const matches =
    identity === undefined
      ? records.filter(record => record.uri === selector)
      : records.filter(record => record.metadata.memoryId === identity);
  const eligible = matches.map(eligibleRecord).filter((record): record is MemoryRecord => record !== undefined);
  if (eligible.length !== 1) {
    return conflict(
      eligible.length === 0 ? 'target-ineligible' : 'ambiguous-identity',
      'Target must resolve to one active personal durable memory.',
    );
  }
  return eligible[0];
}

function eligibleRecord(record: MemoryRecord): MemoryRecord | undefined {
  if (isSharedMemoryUri(record.uri) || record.headerTitle !== 'MEMORY') return undefined;
  if (record.metadata.kind !== 'durable' || record.metadata.status !== 'active') return undefined;
  if (!/\/memories\/durable\/projects\//u.test(record.uri)) return undefined;
  if (!metadataDatesAreCanonical(record)) return undefined;
  return record;
}

function metadataDatesAreCanonical(record: MemoryRecord): boolean {
  const header = canonicalMemoryDocumentContent(record.content).split(/\r?\n\r?\n/u, 1)[0] ?? '';
  return ['owner', 'review_after', 'valid_to'].every(key => {
    const values = headerValues(header, key);
    if (values.length > 1) return false;
    const value = values[0];
    if (value === undefined) return true;
    return key === 'owner'
      ? validOwner(value)
      : key === 'review_after'
        ? isIsoDateOrCanonicalIsoInstant(value)
        : isCanonicalIsoInstant(value);
  });
}

function validatePatch(patch: MaintenanceMetadataPatchV1): MaintenanceMetadataPreviewV1 | undefined {
  if (patch.owner !== undefined && patch.owner !== null && !validOwner(patch.owner))
    return conflict('invalid-owner', 'owner must be bounded opaque text without controls or credential-like content.');
  if (
    patch.reviewAfter !== undefined &&
    patch.reviewAfter !== null &&
    !isIsoDateOrCanonicalIsoInstant(patch.reviewAfter)
  )
    return conflict('invalid-date', 'review_after must be an ISO calendar date or canonical ISO instant.');
  if (patch.validTo !== undefined && patch.validTo !== null && !isCanonicalIsoInstant(patch.validTo))
    return conflict('invalid-date', 'valid_to must be a canonical ISO instant.');
  return undefined;
}

function validOwner(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= OWNER_MAXIMUM_CHARACTERS &&
    ![...value].some(character => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    }) &&
    !/\b(?:api[_-]?key|token|secret|password)\b\s*[:=]/iu.test(value) &&
    !/^eyJ[A-Za-z0-9_-]{10,}\./u.test(value)
  );
}

function isCanonicalIsoInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function metadataView(record: MemoryRecord) {
  return {
    ...(record.metadata.owner === undefined ? {} : {owner: record.metadata.owner}),
    ...(headerValue(record.content, 'review_after') === undefined
      ? {}
      : {reviewAfter: headerValue(record.content, 'review_after')}),
    ...(headerValue(record.content, 'valid_to') === undefined
      ? {}
      : {validTo: headerValue(record.content, 'valid_to')}),
  };
}

function patchMatches(record: MemoryRecord, patch: MaintenanceMetadataPatchV1): boolean {
  const current = metadataView(record);
  return (
    (patch.owner === undefined || current.owner === (patch.owner ?? undefined)) &&
    (patch.reviewAfter === undefined || current.reviewAfter === (patch.reviewAfter ?? undefined)) &&
    (patch.validTo === undefined || current.validTo === (patch.validTo ?? undefined))
  );
}

function normalizedPatch(patch: MaintenanceMetadataPatchV1): MaintenanceMetadataPatchV1 {
  return {
    ...(patch.owner === undefined ? {} : {owner: patch.owner === null ? null : patch.owner.trim()}),
    ...(patch.reviewAfter === undefined ? {} : {reviewAfter: patch.reviewAfter}),
    ...(patch.validTo === undefined ? {} : {validTo: patch.validTo}),
  };
}

function headerValue(headerOrContent: string, key: string): string | undefined {
  const header = headerOrContent.split(/\r?\n\r?\n/u, 1)[0] ?? '';
  const values = headerValues(header, key);
  return values.length === 1 && values[0] ? values[0] : undefined;
}

function headerValues(header: string, key: string): readonly string[] {
  return header.split(/\r?\n/u).flatMap(line => {
    const match = new RegExp(`^${key}:\\s*(.*)$`, 'u').exec(line);
    return match ? [match[1]?.trim() ?? ''] : [];
  });
}

function memoryContentHash(content: string): string {
  return sha256HexSync(canonicalMemoryDocumentContent(content));
}

function proposalId(
  proposal: Omit<MaintenanceMetadataProposalV1, 'proposalId' | 'revision'> | MaintenanceMetadataProposalV1,
) {
  const {proposalId: _proposalId, revision: _revision, ...payload} = proposal as MaintenanceMetadataProposalV1;
  return `maintenance-metadata-${sha256HexSync(JSON.stringify(payload)).slice(0, 40)}`;
}

function proposalRevision(proposal: Omit<MaintenanceMetadataProposalV1, 'revision'> | MaintenanceMetadataProposalV1) {
  const {revision: _revision, ...payload} = proposal as MaintenanceMetadataProposalV1;
  return sha256HexSync(JSON.stringify(payload));
}

function conflict(
  code: string,
  message: string,
): {readonly code: string; readonly message: string; readonly status: 'conflict'} {
  return {code, message, status: 'conflict'};
}
