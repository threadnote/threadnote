import type {MemoryKind, MemoryStatus} from './types.js';
import {
  MAX_CONSOLIDATION_BYTES,
  validateConsolidationProvenance,
  type ConsolidationProvenance,
} from './consolidation.js';
import {parseResourceId} from '@threadnote/store/resource-id';
import {
  assertMemorySchemaWritable,
  formatMemoryCodeCitationLines,
  isMemoryCodeCitationSchemaVersion,
  MEMORY_CODE_CITATION_HEADER,
  MEMORY_SCHEMA_VERSION,
  parseMemoryCodeCitationHeaders,
  type MemoryCodeCitationError,
  type MemoryCodeCitationV1,
} from './code/citation.js';

export type MemoryAuthority = 'agent_generated' | 'canonical_repo' | 'external' | 'reviewed_shared' | 'user_approved';

export type MemoryTrust = 'approved' | 'inferred' | 'untrusted';

export type MemoryVisibility = 'external' | 'personal' | 'shared';

export interface MemoryObsidianEvidenceV1 {
  readonly version: 1;
  readonly sourceId: string;
  readonly sourceInstanceId: string;
  readonly vaultHash: string;
  readonly accessHash: string;
  readonly noteId: string;
  readonly relativePath: string;
  readonly revisionHash: string;
  readonly sanitizerVersion: string;
  readonly fragmentHash: string;
  readonly fragmentStart: number;
  readonly fragmentEnd: number;
  readonly pinId: string;
  readonly expiresAt: string;
}

const EVIDENCE_HEADER = 'obsidian_evidence';
const MAX_MEMORY_OBSIDIAN_EVIDENCE_BYTES = 4096;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[a-f0-9-]{36}$/u;

export function validMemoryObsidianEvidence(value: unknown): value is MemoryObsidianEvidenceV1 {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<MemoryObsidianEvidenceV1>;
  return (
    entry.version === 1 &&
    typeof entry.sourceId === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(entry.sourceId) &&
    typeof entry.sourceInstanceId === 'string' &&
    UUID_PATTERN.test(entry.sourceInstanceId) &&
    typeof entry.vaultHash === 'string' &&
    HASH_PATTERN.test(entry.vaultHash) &&
    typeof entry.accessHash === 'string' &&
    HASH_PATTERN.test(entry.accessHash) &&
    typeof entry.noteId === 'string' &&
    UUID_PATTERN.test(entry.noteId) &&
    typeof entry.relativePath === 'string' &&
    entry.relativePath.length > 0 &&
    entry.relativePath.length <= 4096 &&
    !entry.relativePath.startsWith('/') &&
    !entry.relativePath.split('/').some(segment => !segment || segment === '.' || segment === '..') &&
    typeof entry.revisionHash === 'string' &&
    HASH_PATTERN.test(entry.revisionHash) &&
    typeof entry.sanitizerVersion === 'string' &&
    entry.sanitizerVersion === 'scrubber-redact-v1' &&
    typeof entry.fragmentHash === 'string' &&
    HASH_PATTERN.test(entry.fragmentHash) &&
    Number.isSafeInteger(entry.fragmentStart) &&
    entry.fragmentStart! >= 0 &&
    Number.isSafeInteger(entry.fragmentEnd) &&
    entry.fragmentEnd! > entry.fragmentStart! &&
    typeof entry.pinId === 'string' &&
    UUID_PATTERN.test(entry.pinId) &&
    typeof entry.expiresAt === 'string' &&
    Number.isFinite(Date.parse(entry.expiresAt))
  );
}

function serializeMemoryObsidianEvidence(value: unknown): string {
  if (!validMemoryObsidianEvidence(value)) throw new Error('Invalid Obsidian evidence citation metadata.');
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_MEMORY_OBSIDIAN_EVIDENCE_BYTES) {
    throw new Error('Obsidian evidence citation metadata exceeds the 4096-byte limit.');
  }
  return serialized;
}

export const MEMORY_RELATION_TYPES = ['depends_on', 'evidence_for', 'references', 'related_to', 'supersedes'] as const;

export const MAX_MEMORY_RELATIONS = 16;

export type MemoryRelationType = (typeof MEMORY_RELATION_TYPES)[number];

export interface MemoryRelation {
  readonly type: MemoryRelationType;
  readonly uri: string;
}

export interface MemoryMetadata {
  readonly archivedFrom?: string;
  readonly authority?: MemoryAuthority;
  readonly candidateId?: string;
  /** Immutable capture-time code evidence; validation receipts are never persisted here. */
  readonly codeCitations?: readonly MemoryCodeCitationV1[];
  /** Closed parse/bounds errors that force precise freshness to abstain. */
  readonly citationErrors?: readonly MemoryCodeCitationError[];
  /** Reviewed derivation history; active dependencies remain in codeCitations/relations. */
  readonly consolidation?: ConsolidationProvenance;
  readonly consolidationError?: string;
  readonly createdAt?: string;
  readonly evidence?: readonly string[];
  /** Private, immutable imported-note evidence identity; historical text lives in a bounded pin. */
  readonly obsidianEvidence?: MemoryObsidianEvidenceV1;
  readonly obsidianEvidenceError?: boolean;
  readonly kind: MemoryKind;
  readonly keywords?: readonly string[];
  readonly lastReviewed?: string;
  readonly memoryId?: string;
  /** Opaque maintainer label; it is never an authorization or organization identity. */
  readonly owner?: string;
  readonly project?: string;
  /** Canonical ISO calendar date (legacy) or instant for maintenance review. */
  readonly reviewAfter?: string;
  readonly references?: readonly string[];
  readonly relations?: readonly MemoryRelation[];
  readonly schemaVersion?: number;
  readonly sourceHash?: string;
  readonly sourceAgentClient: string;
  readonly sourceCommit?: string;
  readonly sourceObservedAt?: string;
  readonly sourceSessionId?: string;
  readonly status: MemoryStatus;
  readonly supersedes?: string;
  readonly timestamp: string;
  readonly topic?: string;
  readonly trust?: MemoryTrust;
  readonly updatedAt?: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly visibility?: MemoryVisibility;
  /** POSIX, repo-relative package/app root; absent means repo-wide. */
  readonly workspaceScope?: string;
}

export interface MemoryRecord {
  readonly body: string;
  readonly content: string;
  readonly headerTitle: 'MEMORY' | 'HANDOFF';
  readonly metadata: MemoryMetadata;
  readonly uri: string;
}

const HEADER_LINE_BREAK = /[\r\n]/;
const AUTHORITY_LEVEL: Readonly<Record<MemoryAuthority, number>> = {
  external: 0,
  agent_generated: 1,
  reviewed_shared: 2,
  user_approved: 3,
  canonical_repo: 4,
};
const TRUST_LEVEL: Readonly<Record<MemoryTrust, number>> = {
  untrusted: 0,
  inferred: 1,
  approved: 2,
};

export function parseMemoryDocument(uri: string, content: string): MemoryRecord | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }
  const parseable = normalizeMemoryDocumentLineEndings(trimmed);
  const separatorIndex = parseable.indexOf('\n\n');
  const header = separatorIndex === -1 ? parseable : parseable.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? '' : stripLegacyMemoryFieldsTrailer(parseable.slice(separatorIndex + 2)).trim();
  const lines = header.split('\n');
  const firstLine = lines[0]?.trim();
  if (firstLine !== 'MEMORY' && firstLine !== 'HANDOFF') {
    return undefined;
  }
  const kind =
    parseMemoryKind(memoryHeaderValueFromLines(lines, 'kind')) ?? (firstLine === 'HANDOFF' ? 'handoff' : undefined);
  if (!kind) {
    return undefined;
  }
  const schemaVersion = parseSchemaVersion(memoryHeaderValueFromLines(lines, 'schema_version'));
  const codeCitationMetadata = parseMemoryCodeCitationHeaders(
    memoryCodeCitationHeaderValues(lines),
    canonicalCodeCitationSchemaVersion(lines, schemaVersion),
  );
  const evidenceLines = lines.filter(line => /^\s*obsidian_evidence\s*:/u.test(line));
  const evidenceValue =
    evidenceLines.length === 1 && evidenceLines[0]?.startsWith(`${EVIDENCE_HEADER}: `)
      ? evidenceLines[0].slice(EVIDENCE_HEADER.length + 2)
      : undefined;
  let obsidianEvidence: MemoryObsidianEvidenceV1 | undefined;
  if (schemaVersion === MEMORY_SCHEMA_VERSION && evidenceValue) {
    try {
      const parsed: unknown = JSON.parse(evidenceValue);
      if (serializeMemoryObsidianEvidence(parsed) === evidenceValue) {
        obsidianEvidence = parsed as MemoryObsidianEvidenceV1;
      }
    } catch {
      // Invalid citation metadata remains visible as an error and blocks rewrites/sharing.
    }
  }
  const consolidationLines = lines.filter(line => /^\s*consolidation\s*:/u.test(line));
  const consolidationValues = memoryHeaderValues(lines, 'consolidation') ?? [];
  let consolidation: ConsolidationProvenance | undefined;
  let consolidationError: string | undefined;
  if (consolidationLines.length) {
    try {
      if (
        (schemaVersion !== 6 && schemaVersion !== MEMORY_SCHEMA_VERSION) ||
        consolidationLines.length !== 1 ||
        !consolidationLines[0].startsWith('consolidation: ') ||
        consolidationValues.length !== 1 ||
        new TextEncoder().encode(consolidationValues[0]).byteLength > MAX_CONSOLIDATION_BYTES
      )
        throw new Error('Invalid consolidation schema, duplicate header, or evidence bounds.');
      const parsedConsolidation: unknown = JSON.parse(consolidationValues[0]);
      const evidence = validateConsolidationProvenance(
        parsedConsolidation,
        body,
        memoryHeaderValueFromLines(lines, 'status') === 'archived',
      );
      consolidation = evidence.provenance;
      if (
        JSON.stringify(evidence.codeCitations) !== JSON.stringify(codeCitationMetadata.citations ?? []) ||
        JSON.stringify(evidence.relations) !==
          JSON.stringify(parseMemoryRelations(memoryHeaderValues(lines, 'relation')) ?? [])
      )
        throw new Error('Active evidence differs from the reviewed consolidation.');
    } catch (error) {
      consolidationError = error instanceof Error ? error.message : 'Invalid consolidation evidence.';
      consolidation = undefined;
    }
  }
  return {
    body,
    content: trimmed,
    headerTitle: firstLine,
    metadata: {
      archivedFrom: canonicalOptionalResourceInput(memoryHeaderValueFromLines(lines, 'archived_from')),
      authority: parseMemoryAuthority(memoryHeaderValueFromLines(lines, 'authority')),
      candidateId: memoryHeaderValueFromLines(lines, 'candidate_id'),
      codeCitations: codeCitationMetadata.citations,
      citationErrors: consolidationError
        ? [...(codeCitationMetadata.errors ?? []), {reason: 'invalid-shape'}]
        : codeCitationMetadata.errors,
      consolidation,
      consolidationError,
      createdAt: memoryHeaderValueFromLines(lines, 'created_at'),
      evidence: canonicalResourceInputs(memoryHeaderValues(lines, 'evidence')),
      obsidianEvidence,
      obsidianEvidenceError: evidenceLines.length > 0 ? obsidianEvidence === undefined : undefined,
      kind,
      keywords: memoryHeaderValues(lines, 'keywords'),
      lastReviewed: memoryHeaderValueFromLines(lines, 'last_reviewed'),
      memoryId: memoryHeaderValueFromLines(lines, 'memory_id'),
      owner: normalizeOptionalMetadata(memoryHeaderValueFromLines(lines, 'owner')),
      project: normalizeOptionalMetadata(
        memoryHeaderValueFromLines(lines, 'project') ?? memoryHeaderValueFromLines(lines, 'repo'),
      ),
      references: canonicalResourceInputs(memoryHeaderValues(lines, 'references')),
      reviewAfter: parseIsoDate(memoryHeaderValueFromLines(lines, 'review_after')),
      relations: parseMemoryRelations(memoryHeaderValues(lines, 'relation')),
      schemaVersion,
      sourceHash: memoryHeaderValueFromLines(lines, 'source_hash'),
      sourceAgentClient: memoryHeaderValueFromLines(lines, 'source_agent_client') ?? 'unknown',
      sourceCommit: memoryHeaderValueFromLines(lines, 'source_commit'),
      sourceObservedAt: memoryHeaderValueFromLines(lines, 'source_observed_at'),
      sourceSessionId: memoryHeaderValueFromLines(lines, 'source_session_id'),
      status: parseMemoryStatus(memoryHeaderValueFromLines(lines, 'status')) ?? 'active',
      supersedes: canonicalOptionalResourceInput(memoryHeaderValueFromLines(lines, 'supersedes')),
      timestamp: memoryHeaderValueFromLines(lines, 'timestamp') ?? new Date(0).toISOString(),
      topic: normalizeOptionalMetadata(memoryHeaderValueFromLines(lines, 'topic')),
      trust: parseMemoryTrust(memoryHeaderValueFromLines(lines, 'trust')),
      updatedAt: memoryHeaderValueFromLines(lines, 'updated_at'),
      validFrom: memoryHeaderValueFromLines(lines, 'valid_from'),
      validTo: memoryHeaderValueFromLines(lines, 'valid_to'),
      visibility: parseMemoryVisibility(memoryHeaderValueFromLines(lines, 'visibility')),
      workspaceScope: normalizeOptionalMetadata(memoryHeaderValueFromLines(lines, 'workspace_scope')),
    },
    uri: canonicalResourceInput(uri),
  };
}

export function formatMemoryDocument(title: 'MEMORY' | 'HANDOFF', metadata: MemoryMetadata, body: string): string {
  assertMemorySchemaWritable(metadata.schemaVersion);
  if (metadata.consolidationError) throw new Error(metadata.consolidationError);
  if (metadata.consolidation) {
    if (metadata.schemaVersion !== 6 && metadata.schemaVersion !== MEMORY_SCHEMA_VERSION)
      throw new Error('Consolidation provenance requires memory schema version 6 or 7.');
    const reviewed = validateConsolidationProvenance(
      metadata.consolidation,
      body.trim(),
      metadata.status === 'archived',
    );
    if (
      JSON.stringify(reviewed.codeCitations) !== JSON.stringify(metadata.codeCitations ?? []) ||
      JSON.stringify(reviewed.relations) !== JSON.stringify(metadata.relations ?? [])
    )
      throw new Error('Active evidence differs from reviewed consolidation.');
  }
  if (metadata.citationErrors && metadata.citationErrors.length > 0) {
    throw new Error('Cannot format memory metadata with unresolved code-citation errors.');
  }
  if (
    metadata.obsidianEvidenceError ||
    (metadata.obsidianEvidence && !validMemoryObsidianEvidence(metadata.obsidianEvidence))
  ) {
    throw new Error('Invalid Obsidian evidence citation metadata.');
  }
  if (metadata.obsidianEvidence && metadata.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    throw new Error(`Obsidian evidence requires memory schema version ${MEMORY_SCHEMA_VERSION}.`);
  }
  if (
    metadata.codeCitations &&
    metadata.codeCitations.length > 0 &&
    !isMemoryCodeCitationSchemaVersion(metadata.schemaVersion)
  ) {
    throw new Error(`Memory code citations require memory schema version ${MEMORY_SCHEMA_VERSION}.`);
  }
  const codeCitationLines = formatMemoryCodeCitationLines(metadata.codeCitations ?? []);
  const header = [
    title,
    `kind: ${metadata.kind}`,
    `status: ${metadata.status}`,
    memoryHeaderLine('project', metadata.project),
    memoryHeaderLine('topic', metadata.topic),
    memoryHeaderLine('source_agent_client', metadata.sourceAgentClient),
    memoryHeaderLine('timestamp', metadata.timestamp),
    metadata.schemaVersion !== undefined ? `schema_version: ${metadata.schemaVersion}` : undefined,
    memoryHeaderLine('memory_id', metadata.memoryId),
    memoryHeaderLine('owner', normalizeOptionalMetadata(metadata.owner)),
    memoryHeaderLine('created_at', metadata.createdAt),
    memoryHeaderLine('updated_at', metadata.updatedAt),
    memoryHeaderLine('visibility', metadata.visibility),
    memoryHeaderLine('workspace_scope', metadata.workspaceScope),
    memoryHeaderLine('authority', metadata.authority),
    memoryHeaderLine('trust', metadata.trust),
    memoryHeaderLine('valid_from', metadata.validFrom),
    memoryHeaderLine('valid_to', metadata.validTo),
    memoryHeaderLine('last_reviewed', metadata.lastReviewed),
    reviewAfterHeaderLine(metadata.reviewAfter),
    memoryHeaderLine('source_observed_at', metadata.sourceObservedAt),
    memoryHeaderLine('source_session_id', metadata.sourceSessionId),
    memoryHeaderLine('source_commit', metadata.sourceCommit),
    ...codeCitationLines,
    metadata.obsidianEvidence
      ? `${EVIDENCE_HEADER}: ${serializeMemoryObsidianEvidence(metadata.obsidianEvidence)}`
      : undefined,
    metadata.consolidation ? memoryHeaderLine('consolidation', JSON.stringify(metadata.consolidation)) : undefined,
    memoryHeaderLine('candidate_id', metadata.candidateId),
    memoryHeaderLine('source_hash', metadata.sourceHash),
    memoryHeaderLine('supersedes', metadata.supersedes),
    memoryHeaderLine('archived_from', metadata.archivedFrom),
    ...(metadata.references ?? []).map(reference => memoryHeaderLine('references', reference)),
    ...(metadata.evidence ?? []).map(evidence => memoryHeaderLine('evidence', evidence)),
    ...(metadata.relations ?? []).map(relation => memoryHeaderLine('relation', `${relation.type} ${relation.uri}`)),
    ...(metadata.keywords ?? []).map(keyword => memoryHeaderLine('keywords', keyword)),
  ].filter((line): line is string => line !== undefined);
  return [...header, '', body.trim()].join('\n');
}

/** Preserve source prose in an archive without duplicating machine-readable headers into recall text. */
export function memoryArchiveBody(sourceBody: string): string {
  return ['Archived original Threadnote memory.', '', sourceBody].join('\n');
}

/**
 * Archiving changes a memory's lifecycle and storage location, not its identity
 * or knowledge edges. Keep the source's stable/semantic metadata while making
 * the archival event and personal destination explicit.
 */
export function memoryArchiveMetadata(
  source: MemoryMetadata,
  options: {
    readonly archivedFrom: string;
    readonly kind?: MemoryKind;
    readonly project?: string;
    readonly sourceAgentClient: string;
    readonly timestamp: string;
    readonly topic?: string;
  },
): MemoryMetadata {
  return {
    ...source,
    archivedFrom: options.archivedFrom,
    citationErrors: undefined,
    createdAt: source.createdAt ?? source.timestamp,
    kind: options.kind ?? source.kind,
    project: options.project ?? source.project,
    sourceAgentClient: options.sourceAgentClient,
    status: 'archived',
    timestamp: options.timestamp,
    topic: options.topic ?? source.topic,
    updatedAt: options.timestamp,
    visibility: 'personal',
  };
}

export function formatMemoryDocumentWithKeywords(content: string, keywords: readonly string[]): string {
  assertMemoryDocumentSchemaWritable(content);
  const canonical = normalizeMemoryDocumentLineEndings(canonicalMemoryDocumentContent(content));
  const separatorIndex = canonical.indexOf('\n\n');
  const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? '' : canonical.slice(separatorIndex + 2);
  const headerLines = header.split('\n').filter(line => !line.startsWith('keywords:'));
  const keywordLines = keywords.flatMap(keyword => {
    const line = memoryHeaderLine('keywords', keyword);
    return line === undefined ? [] : [line];
  });
  return [...headerLines, ...keywordLines, '', body].join('\n');
}

/**
 * A legacy indexer appended a managed indexing trailer after writes. It is not part
 * of the user-approved memory payload and must not affect content identity.
 */
export function canonicalMemoryDocumentContent(content: string): string {
  return stripLegacyMemoryFieldsTrailer(content.trim()).trim();
}

function stripLegacyMemoryFieldsTrailer(content: string): string {
  const trimmed = content.trimEnd();
  if (!trimmed.endsWith('-->')) return content;
  const marker = '<!-- MEMORY_FIELDS';
  const markerStart = trimmed.lastIndexOf(marker);
  if (
    markerStart < 0 ||
    !lineBreakEndsAt(trimmed, markerStart) ||
    !lineBreakStartsAt(trimmed, markerStart + marker.length)
  ) {
    return content;
  }
  const precedingBreak = previousLineBreakStart(trimmed, previousLineBreakStart(trimmed, markerStart));
  const closingStart = trimmed.length - '-->'.length;
  if (precedingBreak < 0 || !lineBreakEndsAt(trimmed, closingStart)) return content;
  return trimmed.slice(0, precedingBreak);
}

function lineBreakStartsAt(value: string, index: number): boolean {
  return value[index] === '\n' || (value[index] === '\r' && value[index + 1] === '\n');
}

function lineBreakEndsAt(value: string, index: number): boolean {
  return index > 0 && value[index - 1] === '\n';
}

function previousLineBreakStart(value: string, index: number): number {
  if (!lineBreakEndsAt(value, index)) return -1;
  return index > 1 && value[index - 2] === '\r' ? index - 2 : index - 1;
}

/**
 * Rewriters must inspect the raw header rather than trusting parsed metadata:
 * malformed, unsafe, or duplicate versions otherwise collapse to an absent or
 * older version and make unknown fields look writable.
 */
export function assertMemoryDocumentSchemaWritable(content: string): void {
  const canonical = normalizeMemoryDocumentLineEndings(canonicalMemoryDocumentContent(content));
  const separatorIndex = canonical.indexOf('\n\n');
  const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
  if (header.split('\n').some(line => /^\s*consolidation\s*:/u.test(line))) {
    const record = parseMemoryDocument('threadnote://memory/consolidation-check', content);
    if (!record?.metadata.consolidation || record.metadata.consolidationError)
      throw new Error(record?.metadata.consolidationError ?? 'Malformed consolidation provenance.');
  }
  const hasObsidianEvidence = header.split('\n').some(line => /^\s*obsidian_evidence\s*:/u.test(line));
  const schemaLines = header.split('\n').filter(line => /^\s*schema_version\s*:/u.test(line));
  if (schemaLines.length === 0) {
    if (hasObsidianEvidence) throw new Error('Malformed Obsidian evidence citation metadata.');
    return;
  }
  if (schemaLines.length !== 1) {
    throw new Error('Memory schema_version header must appear exactly once before rewriting.');
  }
  const line = schemaLines[0];
  const rawVersion = line.slice(line.indexOf(':') + 1).trim();
  const schemaVersion = parseSchemaVersion(rawVersion);
  if (schemaVersion === undefined) {
    throw new Error('Memory schema_version header must be a canonical positive safe integer before rewriting.');
  }
  assertMemorySchemaWritable(schemaVersion);
  if (line !== `schema_version: ${schemaVersion}`) {
    throw new Error('Memory schema_version header must be a canonical positive safe integer before rewriting.');
  }
  if (hasObsidianEvidence) {
    const record = parseMemoryDocument('threadnote://memory/evidence-check', content);
    if (!record?.metadata.obsidianEvidence || record.metadata.obsidianEvidenceError) {
      throw new Error('Malformed Obsidian evidence citation metadata.');
    }
  }
}

export function assertMemoryRecordArchivable(record: Pick<MemoryRecord, 'content' | 'metadata' | 'uri'>): void {
  assertMemoryDocumentSchemaWritable(record.content);
  const citationErrors = record.metadata.citationErrors;
  if (citationErrors && citationErrors.length > 0) {
    const reasons = [...new Set(citationErrors.map(error => error.reason))].sort().join(', ');
    throw new Error(
      `Cannot archive ${record.uri}: malformed code citation metadata (${reasons}) must be repaired or recaptured first.`,
    );
  }
}

/**
 * Content metadata may lower a source's authority, but it cannot claim an
 * authority above the URI boundary. Personal candidate memories receive their
 * higher ceiling only when the complete reviewed-candidate provenance tuple is
 * present.
 */
export function boundedMemoryAuthority(
  uri: string,
  metadata?: Partial<MemoryMetadata>,
  options: {readonly canonicalResource?: boolean} = {},
): MemoryAuthority {
  const reviewedCandidate = isReviewedCandidateMetadata(metadata);
  const canonicalUri = canonicalResourceInput(uri);
  const fallback: MemoryAuthority = options.canonicalResource
    ? 'canonical_repo'
    : canonicalUri.startsWith('threadnote://resources/')
      ? 'external'
      : isSharedMemoryUri(canonicalUri)
        ? 'reviewed_shared'
        : reviewedCandidate
          ? 'user_approved'
          : 'agent_generated';
  const asserted = metadata?.authority;
  return asserted !== undefined && AUTHORITY_LEVEL[asserted] <= AUTHORITY_LEVEL[fallback] ? asserted : fallback;
}

export function boundedMemoryTrust(
  uri: string,
  metadata?: Partial<MemoryMetadata>,
  options: {readonly canonicalResource?: boolean} = {},
): MemoryTrust {
  const reviewedCandidate = isReviewedCandidateMetadata(metadata);
  const canonicalUri = canonicalResourceInput(uri);
  const fallback: MemoryTrust =
    options.canonicalResource || isSharedMemoryUri(canonicalUri) || reviewedCandidate
      ? 'approved'
      : canonicalUri.startsWith('threadnote://resources/')
        ? 'untrusted'
        : 'inferred';
  const asserted = metadata?.trust;
  return asserted !== undefined && TRUST_LEVEL[asserted] <= TRUST_LEVEL[fallback] ? asserted : fallback;
}

export function isSharedMemoryUri(uri: string): boolean {
  return /^threadnote:\/\/user\/[^/]+\/memories\/shared\/[^/]+\//.test(canonicalResourceInput(uri));
}

export function isAgentArtifactPath(segments: readonly string[]): boolean {
  return (
    segments[0] === 'agent-artifacts' ||
    (segments[0] === 'shared' && Boolean(segments[1]) && segments[2] === 'agent-artifacts')
  );
}

/** Reserved personal and team bundle storage contains tooling, not memory records. */
export function isAgentArtifactUri(uri: string): boolean {
  try {
    const {namespace, segments} = parseResourceId(uri);
    return namespace === 'user' && segments[1] === 'memories' && isAgentArtifactPath(segments.slice(2));
  } catch {
    return false;
  }
}

function canonicalResourceInput(uri: string): string {
  try {
    return parseResourceId(uri).canonicalUri;
  } catch {
    return uri;
  }
}

export function inferMemoryMetadata(memory: string): Partial<MemoryMetadata> {
  const parseable = normalizeMemoryDocumentLineEndings(memory);
  const header = parseable.slice(0, Math.max(0, parseable.indexOf('\n\n')) || parseable.length);
  const lines = header.split('\n');
  const parsedRecord = lines.some(line => /^\s*consolidation\s*:/u.test(line))
    ? parseMemoryDocument('threadnote://memory/inferred', memory)
    : undefined;
  const firstLine = lines[0]?.trim();
  const schemaVersion = parseSchemaVersion(memoryHeaderValueFromLines(lines, 'schema_version'));
  const codeCitationMetadata = parseMemoryCodeCitationHeaders(
    memoryCodeCitationHeaderValues(lines),
    canonicalCodeCitationSchemaVersion(lines, schemaVersion),
  );
  return {
    archivedFrom: canonicalOptionalResourceInput(memoryHeaderValueFromLines(lines, 'archived_from')),
    authority: parseMemoryAuthority(memoryHeaderValueFromLines(lines, 'authority')),
    candidateId: memoryHeaderValueFromLines(lines, 'candidate_id'),
    codeCitations: codeCitationMetadata.citations,
    citationErrors: parsedRecord?.metadata.citationErrors ?? codeCitationMetadata.errors,
    consolidation: parsedRecord?.metadata.consolidation,
    consolidationError: parsedRecord?.metadata.consolidationError,
    createdAt: memoryHeaderValueFromLines(lines, 'created_at'),
    evidence: canonicalResourceInputs(memoryHeaderValues(lines, 'evidence')),
    kind:
      parseMemoryKind(memoryHeaderValueFromLines(lines, 'kind')) ?? (firstLine === 'HANDOFF' ? 'handoff' : undefined),
    keywords: memoryHeaderValues(lines, 'keywords'),
    lastReviewed: memoryHeaderValueFromLines(lines, 'last_reviewed'),
    memoryId: memoryHeaderValueFromLines(lines, 'memory_id'),
    owner: normalizeOptionalMetadata(memoryHeaderValueFromLines(lines, 'owner')),
    project: normalizeOptionalMetadata(
      memoryHeaderValueFromLines(lines, 'project') ??
        memoryHeaderValueFromLines(lines, 'repo') ??
        memoryHeaderValueFromLines(lines, 'repo_path'),
    ),
    references: canonicalResourceInputs(memoryHeaderValues(lines, 'references')),
    reviewAfter: parseIsoDate(memoryHeaderValueFromLines(lines, 'review_after')),
    relations: parseMemoryRelations(memoryHeaderValues(lines, 'relation')),
    schemaVersion,
    sourceHash: memoryHeaderValueFromLines(lines, 'source_hash'),
    sourceAgentClient: memoryHeaderValueFromLines(lines, 'source_agent_client'),
    sourceCommit: memoryHeaderValueFromLines(lines, 'source_commit'),
    sourceObservedAt: memoryHeaderValueFromLines(lines, 'source_observed_at'),
    sourceSessionId: memoryHeaderValueFromLines(lines, 'source_session_id'),
    status: parseMemoryStatus(memoryHeaderValueFromLines(lines, 'status')),
    supersedes: canonicalOptionalResourceInput(memoryHeaderValueFromLines(lines, 'supersedes')),
    timestamp: memoryHeaderValueFromLines(lines, 'timestamp'),
    topic: normalizeOptionalMetadata(
      memoryHeaderValueFromLines(lines, 'topic') ?? memoryHeaderValueFromLines(lines, 'task'),
    ),
    trust: parseMemoryTrust(memoryHeaderValueFromLines(lines, 'trust')),
    updatedAt: memoryHeaderValueFromLines(lines, 'updated_at'),
    validFrom: memoryHeaderValueFromLines(lines, 'valid_from'),
    validTo: memoryHeaderValueFromLines(lines, 'valid_to'),
    visibility: parseMemoryVisibility(memoryHeaderValueFromLines(lines, 'visibility')),
    workspaceScope: normalizeOptionalMetadata(memoryHeaderValueFromLines(lines, 'workspace_scope')),
  };
}

function normalizeMemoryDocumentLineEndings(content: string): string {
  return content.replace(/\r\n?/gu, '\n');
}

export function memoryHeaderValue(header: string, key: string): string | undefined {
  return memoryHeaderValueFromLines(header.split('\n'), key);
}

function memoryHeaderValueFromLines(lines: readonly string[], key: string): string | undefined {
  const prefix = `${key}:`;
  return lines
    .find(line => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function memoryHeaderValues(lines: readonly string[], key: string): readonly string[] | undefined {
  const prefix = `${key}:`;
  const values = lines
    .filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length).trim())
    .filter(value => value.length > 0);
  return values.length > 0 ? values : undefined;
}

/** Preserve citation whitespace so a non-canonical header cannot become authoritative after trimming. */
function memoryCodeCitationHeaderValues(lines: readonly string[]): readonly string[] | undefined {
  const prefix = `${MEMORY_CODE_CITATION_HEADER}:`;
  const values = lines
    .filter(line => line.trimStart().startsWith(prefix))
    .map(line => {
      const trimmedStart = line.trimStart();
      const suffix = trimmedStart.slice(prefix.length);
      const value = suffix.startsWith(' ') ? suffix.slice(1) : ` ${suffix}`;
      return line === trimmedStart ? value : ` ${value}`;
    });
  return values.length > 0 ? values : undefined;
}

function canonicalCodeCitationSchemaVersion(
  lines: readonly string[],
  schemaVersion: number | undefined,
): number | undefined {
  if (schemaVersion === undefined) return undefined;
  const schemas = lines.filter(line => line.startsWith('schema_version:'));
  return schemas.length === 1 && schemas[0] === `schema_version: ${schemaVersion}` ? schemaVersion : undefined;
}

function parseMemoryKind(value: string | undefined): MemoryKind | undefined {
  return value === 'durable' ||
    value === 'handoff' ||
    value === 'incident' ||
    value === 'preference' ||
    value === 'smoke'
    ? value
    : undefined;
}

function parseMemoryStatus(value: string | undefined): MemoryStatus | undefined {
  return value === 'active' || value === 'archived' || value === 'expired' || value === 'superseded'
    ? value
    : undefined;
}

function parseMemoryAuthority(value: string | undefined): MemoryAuthority | undefined {
  return value === 'agent_generated' ||
    value === 'canonical_repo' ||
    value === 'external' ||
    value === 'reviewed_shared' ||
    value === 'user_approved'
    ? value
    : undefined;
}

function parseMemoryTrust(value: string | undefined): MemoryTrust | undefined {
  return value === 'approved' || value === 'inferred' || value === 'untrusted' ? value : undefined;
}

function parseMemoryVisibility(value: string | undefined): MemoryVisibility | undefined {
  return value === 'external' || value === 'personal' || value === 'shared' ? value : undefined;
}

function parseMemoryRelations(values: readonly string[] | undefined): readonly MemoryRelation[] | undefined {
  if (!values) {
    return undefined;
  }
  const relations = values
    .map(parseMemoryRelationValue)
    .filter((relation): relation is MemoryRelation => relation !== undefined);
  return relations.length > 0 ? relations : undefined;
}

/** Tolerant legacy decoder; strict authoring validation lives in memory/relations.ts. */
export function parseMemoryRelationValue(value: string): MemoryRelation | undefined {
  const separator = value.indexOf(' ');
  if (separator <= 0) {
    return undefined;
  }
  const type = value.slice(0, separator);
  const uri = canonicalOptionalResourceInput(value.slice(separator + 1).trim());
  if (!uri || !uri.startsWith('threadnote://') || !isMemoryRelationType(type)) {
    return undefined;
  }
  return {type, uri};
}

function canonicalOptionalResourceInput(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  try {
    return parseResourceId(uri).canonicalUri;
  } catch {
    return uri;
  }
}

function canonicalResourceInputs(values: readonly string[] | undefined): readonly string[] | undefined {
  return values?.map(value => canonicalOptionalResourceInput(value) ?? value);
}

export function isMemoryRelationType(value: string): value is MemoryRelationType {
  return MEMORY_RELATION_TYPES.some(type => type === value);
}

function parseSchemaVersion(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isIsoDateOrCanonicalIsoInstant(value: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseIsoDate(value: string | undefined): string | undefined {
  return value !== undefined && isIsoDateOrCanonicalIsoInstant(value) ? value : undefined;
}

function isReviewedCandidateMetadata(metadata: Partial<MemoryMetadata> | undefined): boolean {
  return (
    metadata?.authority === 'user_approved' &&
    metadata.trust === 'approved' &&
    metadata.candidateId !== undefined &&
    metadata.lastReviewed !== undefined &&
    metadata.sourceObservedAt !== undefined
  );
}

function memoryHeaderLine(key: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (HEADER_LINE_BREAK.test(value)) {
    throw new Error(`Memory metadata ${key} must not contain line breaks.`);
  }
  return `${key}: ${value}`;
}

function reviewAfterHeaderLine(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (parseIsoDate(value) === undefined) {
    throw new Error('Memory metadata review_after must be an ISO date or canonical ISO instant.');
  }
  return memoryHeaderLine('review_after', value);
}
