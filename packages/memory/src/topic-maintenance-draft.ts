export * from './topic-maintenance-generation.js';
import {
  validateTopicGenerationSummary,
  topicGenerationUsage,
  type TopicGenerationSummaryV1,
} from './topic-maintenance-generation.js';
import {consolidationRevision, consolidationSections} from './consolidation.js';
import {assertMemoryCodeCitation, type MemoryCodeCitationV1} from './code/citation.js';
import {
  MAX_TOPIC_MAINTENANCE_BYTES,
  MAX_TOPIC_MAINTENANCE_PARAGRAPHS,
  type TopicMaintenanceDependencyV1,
  type TopicMaintenanceParagraphV1,
} from './topic-maintenance.js';

export const MAX_TOPIC_MAINTENANCE_DRAFT_BYTES = 32 * 1024;
export const MAX_TOPIC_MAINTENANCE_BASIS_BYTES = 64 * 1024;
export const MAX_TOPIC_MAINTENANCE_REVIEW_BYTES = 128 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SNAPSHOT = /^cgsn_[a-f0-9]{40}(?:-direct|-full-[a-f0-9]{16})?$/u;
const CITATION_ID = /^tncc_[a-f0-9]{40}$/u;
const HANDLE_ID = /^(historical|current):(tncc_[a-f0-9]{40})$/u;
const textBytes = (value: string) => new TextEncoder().encode(value).byteLength;
const jsonBytes = (value: unknown): number => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : textBytes(serialized);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export interface TopicMaintenanceEvidenceHandleV1 {
  readonly id: string;
  readonly citationId: string;
  readonly variant: 'historical' | 'current';
}

export interface TopicMaintenanceDraftBasisV1 {
  readonly version: 1;
  readonly targetUri: string;
  readonly targetHash: string;
  readonly observationRevision: string;
  readonly packetDigest: string;
  readonly body: string;
  readonly paragraphs: readonly TopicMaintenanceParagraphV1[];
  readonly additionalDependencies: readonly TopicMaintenanceDependencyV1[];
  readonly handles: readonly TopicMaintenanceEvidenceHandleV1[];
}

export interface TopicMaintenanceReplaceOperationV1 {
  readonly ordinal: number;
  readonly beforeHash: string;
  readonly text: string;
  readonly supportHandles: readonly string[];
  readonly rationale: string;
}

export interface TopicMaintenanceParagraphDispositionV1 {
  readonly ordinal: number;
  readonly beforeHash: string;
  readonly disposition: 'update' | 'revalidate' | 'unresolved';
  readonly supportHandles: readonly string[];
  readonly rationale: string;
}

export interface TopicMaintenanceParagraphCoverageV1 {
  readonly status: 'legacy' | 'complete' | 'incomplete';
  readonly eligibleCount: number;
  readonly dispositionCount: number;
  readonly resolvedCount: number;
  readonly missingOrdinals: readonly number[];
  readonly unresolvedOrdinals: readonly number[];
}

export function topicMaintenanceParagraphEligible(paragraph: TopicMaintenanceParagraphV1): boolean {
  return paragraph.role === 'descriptive' && paragraph.support === 'direct';
}

/** Structural accounting only; declared dispositions are not proof of semantic correctness. */
export function topicMaintenanceParagraphCoverage(
  basis: Pick<TopicMaintenanceDraftBasisV1, 'paragraphs'>,
  draft: TopicMaintenanceDraftV1,
): TopicMaintenanceParagraphCoverageV1 {
  const eligible = basis.paragraphs.filter(topicMaintenanceParagraphEligible);
  const entries = draft.paragraphDispositions?.entries ?? [];
  const missingOrdinals = eligible
    .filter(item => !entries.some(entry => entry.ordinal === item.ordinal))
    .map(item => item.ordinal);
  const unresolvedOrdinals = entries
    .filter(item => item.disposition === 'unresolved')
    .map(item => item.ordinal)
    .sort((a, b) => a - b);
  const resolvedCount = entries.filter(
    item => item.disposition !== 'unresolved' && item.supportHandles.length > 0,
  ).length;
  return {
    status: !draft.paragraphDispositions
      ? 'legacy'
      : missingOrdinals.length ||
          unresolvedOrdinals.length ||
          resolvedCount !== eligible.length ||
          entries.length !== eligible.length
        ? 'incomplete'
        : 'complete',
    eligibleCount: eligible.length,
    dispositionCount: entries.length,
    resolvedCount,
    missingOrdinals,
    unresolvedOrdinals,
  };
}

export interface TopicMaintenanceDraftV1 {
  readonly version: 1;
  readonly targetHash: string;
  readonly observationRevision: string;
  readonly packetDigest: string;
  readonly outcome: 'propose-update' | 'propose-revalidation' | 'policy-conflict' | 'insufficient-evidence';
  readonly operations: readonly TopicMaintenanceReplaceOperationV1[];
  readonly reviewedHandles: readonly string[];
  readonly rationale: string;
  readonly unresolvedQuestions: readonly string[];
  readonly removedClaims: readonly string[];
  readonly paragraphDispositions?: {
    readonly version: 1;
    readonly entries: readonly TopicMaintenanceParagraphDispositionV1[];
  };
}

export interface TopicMaintenanceDraftProposalV1 {
  readonly version: 1;
  readonly draft: TopicMaintenanceDraftV1;
  readonly body: string;
  readonly finalBodyHash: string;
  readonly changedOrdinals: readonly number[];
}

export interface TopicMaintenanceReviewEvidenceV1 {
  readonly handleId: string;
  readonly content: string;
  readonly excerptHash: string;
  readonly fileBytesHash: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly provenance: 'historical-verified' | 'current-verified';
  readonly supportsCitation: true;
  readonly truncated: false;
  /** Excerpt observation; a reused current citation may have an earlier capture commit. */
  readonly source: {
    readonly extractorSet: string;
    readonly fileContentHash: string;
    readonly path: string;
    readonly repositoryId: string;
    readonly sourceCommit: string;
    readonly sourceDirty: boolean;
    readonly sourceSnapshotId: string;
  };
  /** Immutable capture pin, independently checked against the fresh packet on review reuse. */
  readonly citation: MemoryCodeCitationV1;
}

export type TopicMaintenanceGenerationReceiptV1 =
  | {
      readonly origin?: 'model';
      readonly agent: string;
      readonly model: string;
      readonly modelVersion?: string;
      readonly promptVersion: string;
      readonly attempts: 1 | 2;
      readonly observation?: TopicGenerationSummaryV1;
      readonly usage:
        | {readonly status: 'unavailable'}
        | {readonly status: 'measured'; readonly inputTokens: number; readonly outputTokens: number};
    }
  | {
      readonly origin: 'manual';
      readonly agent: 'manual';
      readonly model: 'none';
      readonly modelVersion?: never;
      readonly promptVersion: 'manual-topic-v1';
      readonly attempts: 0;
      readonly usage: {readonly status: 'unavailable'};
    };

/** Private review data; accepted memory metadata never contains this payload. */
export interface TopicMaintenanceReviewPayloadV1 {
  readonly version: 1;
  readonly basis: TopicMaintenanceDraftBasisV1;
  readonly proposal: TopicMaintenanceDraftProposalV1;
  readonly reviewEvidence: readonly TopicMaintenanceReviewEvidenceV1[];
  readonly generation: TopicMaintenanceGenerationReceiptV1;
}

interface ParagraphSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function fail(message: string): never {
  throw new Error(`Topic maintenance draft: ${message}`);
}

function object(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const actual = Object.keys(value);
  return required.every(key => key in value) && actual.every(key => required.includes(key) || optional.includes(key));
}

function boundedText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && textBytes(value) <= maxBytes;
}

function boundedStrings(value: unknown, maxCount: number, maxBytes: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maxCount && value.every(item => boundedText(item, maxBytes));
}

function paragraphSpans(body: string): readonly ParagraphSpan[] {
  const trimmed = body.trim();
  const initial = body.length - body.trimStart().length;
  const result: ParagraphSpan[] = [];
  let cursor = 0;
  const add = (end: number) => {
    const segment = trimmed.slice(cursor, end);
    const text = segment.trim();
    if (text) {
      const start = initial + cursor + segment.length - segment.trimStart().length;
      result.push({start, end: start + text.length, text});
    }
  };
  for (const match of trimmed.matchAll(/\n[\t ]*\n/gu)) {
    add(match.index);
    cursor = match.index + match[0].length;
  }
  add(trimmed.length);
  const sections = consolidationSections(body);
  if (result.length !== sections.length || result.some((span, index) => span.text !== sections[index]))
    fail('accepted paragraph spans are inconsistent.');
  return result;
}

export function validateTopicMaintenanceDraftBasis(input: unknown): TopicMaintenanceDraftBasisV1 {
  if (
    !object(input) ||
    jsonBytes(input) > MAX_TOPIC_MAINTENANCE_BASIS_BYTES ||
    !keys(input, [
      'version',
      'targetUri',
      'targetHash',
      'observationRevision',
      'packetDigest',
      'body',
      'paragraphs',
      'additionalDependencies',
      'handles',
    ]) ||
    input.version !== 1 ||
    !boundedText(input.targetUri, 1024) ||
    typeof input.targetHash !== 'string' ||
    !HASH.test(input.targetHash) ||
    typeof input.observationRevision !== 'string' ||
    !HASH.test(input.observationRevision) ||
    typeof input.packetDigest !== 'string' ||
    !HASH.test(input.packetDigest) ||
    !boundedText(input.body, MAX_TOPIC_MAINTENANCE_BYTES) ||
    !Array.isArray(input.paragraphs) ||
    !Array.isArray(input.additionalDependencies) ||
    !Array.isArray(input.handles)
  )
    fail('invalid basis shape or identity.');
  const spans = paragraphSpans(input.body);
  if (input.paragraphs.length !== spans.length || input.paragraphs.length > MAX_TOPIC_MAINTENANCE_PARAGRAPHS)
    fail('basis paragraph count differs from accepted body.');
  const cited = new Set<string>();
  for (const [ordinal, paragraph] of input.paragraphs.entries()) {
    if (
      !object(paragraph) ||
      !keys(paragraph, ['ordinal', 'hash', 'role', 'support', 'citationIds'], ['scope', 'validity']) ||
      paragraph.ordinal !== ordinal ||
      paragraph.hash !== consolidationRevision(spans[ordinal].text) ||
      !['descriptive', 'normative', 'historical'].includes(paragraph.role as string) ||
      !['direct', 'contextual', 'unresolved'].includes(paragraph.support as string) ||
      !Array.isArray(paragraph.citationIds) ||
      paragraph.citationIds.length > 8 ||
      new Set(paragraph.citationIds).size !== paragraph.citationIds.length ||
      paragraph.citationIds.some((id: unknown) => typeof id !== 'string' || !CITATION_ID.test(id)) ||
      (paragraph.support === 'unresolved') !== (paragraph.citationIds.length === 0) ||
      [paragraph.scope, paragraph.validity].some(
        value =>
          value !== undefined &&
          (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\r\n]/u.test(value)),
      )
    )
      fail(`invalid basis paragraph ${ordinal + 1}.`);
    for (const id of paragraph.citationIds) cited.add(id);
  }
  if (input.additionalDependencies.length > 8) fail('basis additional dependencies exceed citation budget.');
  const dependencies = new Set<string>();
  for (const dependency of input.additionalDependencies) {
    if (
      !object(dependency) ||
      !keys(dependency, ['kind', 'citationId']) ||
      !['configuration', 'dependency'].includes(dependency.kind as string) ||
      typeof dependency.citationId !== 'string' ||
      !CITATION_ID.test(dependency.citationId) ||
      dependencies.has(dependency.citationId)
    )
      fail('invalid or duplicated additional dependency.');
    dependencies.add(dependency.citationId);
    cited.add(dependency.citationId);
  }
  if (cited.size === 0 || cited.size > 8 || input.handles.length !== cited.size * 2)
    fail('basis handles differ from declared evidence.');
  const seen = new Set<string>();
  for (const handle of input.handles) {
    if (
      !object(handle) ||
      !keys(handle, ['id', 'citationId', 'variant']) ||
      typeof handle.id !== 'string' ||
      typeof handle.citationId !== 'string' ||
      !CITATION_ID.test(handle.citationId) ||
      !['historical', 'current'].includes(handle.variant as string) ||
      handle.id !== `${handle.variant}:${handle.citationId}` ||
      !HANDLE_ID.test(handle.id) ||
      seen.has(handle.id)
    )
      fail('basis has unknown or duplicate evidence handles.');
    seen.add(handle.id);
  }
  if ([...cited].some(id => !seen.has(`historical:${id}`) || !seen.has(`current:${id}`)))
    fail('basis omits a declared paragraph citation handle.');
  return input as unknown as TopicMaintenanceDraftBasisV1;
}

function validateDraft(input: unknown, basis: TopicMaintenanceDraftBasisV1): TopicMaintenanceDraftV1 {
  if (
    !object(input) ||
    !keys(
      input,
      [
        'version',
        'targetHash',
        'observationRevision',
        'packetDigest',
        'outcome',
        'operations',
        'reviewedHandles',
        'rationale',
        'unresolvedQuestions',
        'removedClaims',
      ],
      ['paragraphDispositions'],
    ) ||
    input.version !== 1 ||
    input.targetHash !== basis.targetHash ||
    input.observationRevision !== basis.observationRevision ||
    input.packetDigest !== basis.packetDigest ||
    !['propose-update', 'propose-revalidation', 'policy-conflict', 'insufficient-evidence'].includes(
      input.outcome as string,
    ) ||
    !Array.isArray(input.operations) ||
    input.operations.length > MAX_TOPIC_MAINTENANCE_PARAGRAPHS ||
    !boundedStrings(input.reviewedHandles, 8, 64) ||
    !boundedText(input.rationale, 2048) ||
    !boundedStrings(input.unresolvedQuestions, 16, 512) ||
    !boundedStrings(input.removedClaims, 64, 512)
  )
    fail('invalid draft shape or stale packet identity.');
  const known = new Set(basis.handles.map(handle => handle.id));
  const spans = paragraphSpans(basis.body);
  if (
    new Set(input.reviewedHandles).size !== input.reviewedHandles.length ||
    input.reviewedHandles.some(handle => !known.has(handle) || !handle.startsWith('current:'))
  )
    fail('reviewed evidence handle is unknown or not current.');
  const seen = new Set<number>();
  for (const operation of input.operations) {
    if (
      !object(operation) ||
      !keys(operation, ['ordinal', 'beforeHash', 'text', 'supportHandles', 'rationale']) ||
      !Number.isSafeInteger(operation.ordinal) ||
      (operation.ordinal as number) < 0 ||
      (operation.ordinal as number) >= basis.paragraphs.length ||
      seen.has(operation.ordinal as number) ||
      operation.beforeHash !== basis.paragraphs[operation.ordinal as number].hash ||
      basis.paragraphs[operation.ordinal as number].role !== 'descriptive' ||
      !boundedText(operation.text, MAX_TOPIC_MAINTENANCE_BYTES) ||
      operation.text !== operation.text.trim() ||
      operation.text === spans[operation.ordinal as number].text ||
      !boundedText(operation.rationale, 1024) ||
      !boundedStrings(operation.supportHandles, 8, 64) ||
      operation.supportHandles.length === 0 ||
      new Set(operation.supportHandles).size !== operation.supportHandles.length ||
      operation.supportHandles.some((handle: string) => !known.has(handle) || !handle.startsWith('current:'))
    )
      fail('invalid, overlapping, or unsupported paragraph replacement.');
    try {
      if (consolidationSections(operation.text).length !== 1) fail('replacement spans multiple paragraphs.');
    } catch {
      fail('replacement spans multiple paragraphs or exceeds body bounds.');
    }
    seen.add(operation.ordinal as number);
  }
  if (
    (input.outcome === 'propose-update' && input.operations.length === 0) ||
    (input.outcome !== 'propose-update' && input.operations.length > 0) ||
    (input.outcome === 'propose-revalidation' && input.reviewedHandles.length === 0) ||
    (input.outcome !== 'propose-revalidation' && input.outcome !== 'propose-update' && input.reviewedHandles.length > 0)
  )
    fail('draft outcome does not match its evidence and paragraph operations.');
  if (input.paragraphDispositions !== undefined) {
    const accounting = input.paragraphDispositions;
    if (
      !object(accounting) ||
      !keys(accounting, ['version', 'entries']) ||
      accounting.version !== 1 ||
      !Array.isArray(accounting.entries) ||
      accounting.entries.length > MAX_TOPIC_MAINTENANCE_PARAGRAPHS
    )
      fail('invalid paragraph dispositions.');
    const entries = accounting.entries;
    const accounted = new Set<number>();
    for (const entry of entries) {
      if (
        !object(entry) ||
        !keys(entry, ['ordinal', 'beforeHash', 'disposition', 'supportHandles', 'rationale']) ||
        !Number.isSafeInteger(entry.ordinal) ||
        !basis.paragraphs[entry.ordinal as number] ||
        accounted.has(entry.ordinal as number)
      )
        fail('invalid or duplicate paragraph disposition.');
      const paragraph = basis.paragraphs[entry.ordinal as number];
      const operation = input.operations.find(item => item.ordinal === entry.ordinal);
      const allowed = new Set(
        [...paragraph.citationIds, ...basis.additionalDependencies.map(item => item.citationId)].map(
          id => `current:${id}`,
        ),
      );
      if (
        !topicMaintenanceParagraphEligible(paragraph) ||
        entry.beforeHash !== paragraph.hash ||
        !['update', 'revalidate', 'unresolved'].includes(entry.disposition as string) ||
        !boundedText(entry.rationale, 1024) ||
        !boundedStrings(entry.supportHandles, 8, 64) ||
        new Set(entry.supportHandles).size !== entry.supportHandles.length ||
        entry.supportHandles.some(handle => !allowed.has(handle) || !known.has(handle)) ||
        (entry.disposition === 'unresolved' ? entry.supportHandles.length !== 0 : entry.supportHandles.length === 0) ||
        (entry.disposition === 'update'
          ? !operation ||
            entry.supportHandles.length !== operation.supportHandles.length ||
            entry.supportHandles.some(handle => !operation.supportHandles.includes(handle))
          : operation !== undefined)
      )
        fail('contradictory or unsupported paragraph disposition.');
      accounted.add(entry.ordinal as number);
    }
    if (
      input.operations.some(
        operation => !entries.some(entry => entry.ordinal === operation.ordinal && entry.disposition === 'update'),
      )
    )
      fail('paragraph disposition is missing for a replacement.');
    if (basis.paragraphs.some(item => topicMaintenanceParagraphEligible(item) && !accounted.has(item.ordinal)))
      fail('paragraph dispositions omit an eligible descriptive paragraph.');
  }
  return input as unknown as TopicMaintenanceDraftV1;
}

function assemble(
  basis: TopicMaintenanceDraftBasisV1,
  draft: TopicMaintenanceDraftV1,
): TopicMaintenanceDraftProposalV1 {
  const spans = paragraphSpans(basis.body);
  const replacements = new Map(draft.operations.map(operation => [operation.ordinal, operation.text]));
  let cursor = 0;
  let body = '';
  for (const [ordinal, span] of spans.entries()) {
    body += basis.body.slice(cursor, span.start);
    body += replacements.get(ordinal) ?? basis.body.slice(span.start, span.end);
    cursor = span.end;
  }
  body += basis.body.slice(cursor);
  if (textBytes(body) > MAX_TOPIC_MAINTENANCE_BYTES || consolidationSections(body).length !== spans.length)
    fail('assembled body exceeds bounds or changes paragraph count.');
  return {
    version: 1,
    draft,
    body,
    finalBodyHash: consolidationRevision(body),
    changedOrdinals: [...replacements.keys()].sort((left, right) => left - right),
  };
}

/** Strictly interprets one bounded model proposal; it never mutates accepted memory. */
export function parseTopicMaintenanceDraft(
  basisInput: TopicMaintenanceDraftBasisV1,
  rawJson: string,
  options: {readonly requireParagraphDispositions?: boolean} = {},
): TopicMaintenanceDraftProposalV1 {
  const basis = validateTopicMaintenanceDraftBasis(basisInput);
  if (!boundedText(rawJson, MAX_TOPIC_MAINTENANCE_DRAFT_BYTES)) fail('model output is empty or oversized.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    fail('model output is not closed JSON.');
  }
  const draft = validateDraft(parsed, basis);
  if (options.requireParagraphDispositions && !draft.paragraphDispositions)
    fail('explicit paragraph dispositions are required.');
  return assemble(basis, draft);
}

/** Rejects incompatible packet evidence before generation; payload loading uses the same checks. */
export function validateTopicMaintenanceReviewEvidence(
  basisInput: TopicMaintenanceDraftBasisV1,
  input: unknown,
): readonly TopicMaintenanceReviewEvidenceV1[] {
  const basis = validateTopicMaintenanceDraftBasis(basisInput);
  if (!Array.isArray(input) || input.length > 16 || jsonBytes(input) > MAX_TOPIC_MAINTENANCE_REVIEW_BYTES)
    fail('invalid or oversized private review evidence.');
  const known = new Set(basis.handles.map(handle => handle.id));
  const evidenceSeen = new Set<string>();
  const citations = new Map<string, MemoryCodeCitationV1>();
  for (const evidence of input) {
    if (
      !object(evidence) ||
      !keys(evidence, [
        'handleId',
        'content',
        'excerptHash',
        'fileBytesHash',
        'startLine',
        'endLine',
        'provenance',
        'supportsCitation',
        'truncated',
        'source',
        'citation',
      ]) ||
      typeof evidence.handleId !== 'string' ||
      !known.has(evidence.handleId) ||
      evidenceSeen.has(evidence.handleId) ||
      !boundedText(evidence.content, 1024) ||
      evidence.excerptHash !== consolidationRevision(evidence.content) ||
      typeof evidence.fileBytesHash !== 'string' ||
      !HASH.test(evidence.fileBytesHash) ||
      !Number.isSafeInteger(evidence.startLine) ||
      (evidence.startLine as number) < 1 ||
      !Number.isSafeInteger(evidence.endLine) ||
      (evidence.endLine as number) < (evidence.startLine as number) ||
      (evidence.endLine as number) - (evidence.startLine as number) >= 8 ||
      evidence.content.split('\n').length !== (evidence.endLine as number) - (evidence.startLine as number) + 1 ||
      evidence.provenance !==
        (evidence.handleId.startsWith('historical:') ? 'historical-verified' : 'current-verified') ||
      evidence.supportsCitation !== true ||
      evidence.truncated !== false ||
      !object(evidence.source) ||
      !keys(evidence.source, [
        'extractorSet',
        'fileContentHash',
        'path',
        'repositoryId',
        'sourceCommit',
        'sourceDirty',
        'sourceSnapshotId',
      ])
    )
      fail('private review evidence is unknown, duplicate, or malformed.');
    let citation: MemoryCodeCitationV1;
    try {
      citation = assertMemoryCodeCitation(evidence.citation);
    } catch {
      fail('private review evidence has an invalid code citation.');
    }
    if (citation.sourceDirty || citation.evidenceRetention !== 'capsule-retained')
      fail('private review code citation is dirty or not retained.');
    const source = evidence.source;
    if (
      source.extractorSet !== citation.extractorSet ||
      source.fileContentHash !== citation.fileContentHash.value ||
      source.path !== citation.path ||
      source.repositoryId !== citation.repositoryId ||
      source.sourceDirty !== citation.sourceDirty ||
      typeof source.sourceCommit !== 'string' ||
      !COMMIT.test(source.sourceCommit) ||
      typeof source.sourceSnapshotId !== 'string' ||
      !SNAPSHOT.test(source.sourceSnapshotId) ||
      (evidence.handleId.startsWith('historical:') &&
        (source.sourceCommit !== citation.sourceCommit || source.sourceSnapshotId !== citation.sourceSnapshotId))
    )
      fail('private review excerpt source differs from its pinned citation.');
    const handle = basis.handles.find(item => item.id === evidence.handleId)!;
    if (handle.variant === 'historical' && citation.id !== handle.citationId)
      fail('historical review evidence changed the original citation.');
    citations.set(evidence.handleId, citation);
    evidenceSeen.add(evidence.handleId);
  }
  if (known.size !== evidenceSeen.size) fail('private review omitted a packet evidence handle.');
  for (const handle of basis.handles) {
    if (handle.variant !== 'current') continue;
    const original = citations.get(`historical:${handle.citationId}`)!;
    const current = citations.get(handle.id)!;
    if (current.repositoryId !== original.repositoryId || current.target.kind !== original.target.kind)
      fail('current review evidence changed repository or citation kind.');
    if (
      original.target.kind === 'symbol' &&
      current.target.kind === 'symbol' &&
      (current.target.language !== original.target.language ||
        current.target.symbolKind !== original.target.symbolKind ||
        current.target.name !== original.target.name ||
        current.target.qualifiedName !== original.target.qualifiedName)
    )
      fail('current review evidence changed the declared symbol locator.');
  }
  return input as readonly TopicMaintenanceReviewEvidenceV1[];
}

export function validateTopicMaintenanceReviewPayload(input: unknown): TopicMaintenanceReviewPayloadV1 {
  if (
    !object(input) ||
    jsonBytes(input) > MAX_TOPIC_MAINTENANCE_REVIEW_BYTES ||
    !keys(input, ['version', 'basis', 'proposal', 'reviewEvidence', 'generation']) ||
    input.version !== 1 ||
    !object(input.proposal) ||
    !keys(input.proposal, ['version', 'draft', 'body', 'finalBodyHash', 'changedOrdinals']) ||
    input.proposal.version !== 1 ||
    !object(input.generation) ||
    !keys(
      input.generation,
      ['agent', 'model', 'promptVersion', 'attempts', 'usage'],
      ['modelVersion', 'origin', 'observation'],
    ) ||
    !boundedText(input.generation.agent, 64) ||
    !boundedText(input.generation.model, 256) ||
    (input.generation.modelVersion !== undefined && !boundedText(input.generation.modelVersion, 256)) ||
    !boundedText(input.generation.promptVersion, 64) ||
    !object(input.generation.usage)
  )
    fail('invalid or oversized private review payload.');
  const observation =
    input.generation.observation === undefined
      ? undefined
      : validateTopicGenerationSummary(input.generation.observation);
  if (observation !== undefined) {
    if (
      observation.state !== 'completed' ||
      observation.agent !== input.generation.agent ||
      observation.model !== input.generation.model ||
      observation.attempts.length !== input.generation.attempts ||
      observation.promptVersion !== input.generation.promptVersion
    )
      fail('Invalid generation observation identity.');
  }
  const usage = input.generation.usage;
  if (
    (usage.status === 'unavailable' && !keys(usage, ['status'])) ||
    (usage.status === 'measured' &&
      (!keys(usage, ['status', 'inputTokens', 'outputTokens']) ||
        ![usage.inputTokens, usage.outputTokens].every(
          value => Number.isSafeInteger(value) && (value as number) >= 0,
        ))) ||
    !['unavailable', 'measured'].includes(usage.status as string)
  )
    fail('invalid provider usage receipt.');
  if (input.generation.origin === 'manual') {
    if (
      input.generation.agent !== 'manual' ||
      input.generation.model !== 'none' ||
      input.generation.modelVersion !== undefined ||
      input.generation.promptVersion !== 'manual-topic-v1' ||
      input.generation.attempts !== 0 ||
      usage.status !== 'unavailable'
    )
      fail('invalid manual review origin receipt.');
  } else if (
    (input.generation.origin !== undefined && input.generation.origin !== 'model') ||
    ![1, 2].includes(input.generation.attempts as number)
  )
    fail('invalid model generation receipt.');
  const basis = validateTopicMaintenanceDraftBasis(input.basis);
  if (observation) {
    const measured = topicGenerationUsage(observation.attempts.map(attempt => attempt.usage));
    if (
      observation.targetHash !== basis.targetHash ||
      observation.observationRevision !== basis.observationRevision ||
      observation.packetDigest !== basis.packetDigest ||
      usage.status !== measured.status ||
      (measured.status === 'measured' &&
        (usage.inputTokens !== measured.inputTokens || usage.outputTokens !== measured.outputTokens))
    )
      fail('Generation observation differs from its basis or complete usage.');
  }
  validateTopicMaintenanceReviewEvidence(basis, input.reviewEvidence);
  const proposal = assemble(basis, validateDraft(input.proposal.draft, basis));
  if (
    input.proposal.body !== proposal.body ||
    input.proposal.finalBodyHash !== proposal.finalBodyHash ||
    !Array.isArray(input.proposal.changedOrdinals) ||
    input.proposal.changedOrdinals.length !== proposal.changedOrdinals.length ||
    input.proposal.changedOrdinals.some((ordinal, index) => ordinal !== proposal.changedOrdinals[index])
  )
    fail('private review proposal differs from deterministic assembly.');
  return input as unknown as TopicMaintenanceReviewPayloadV1;
}
