import {
  consolidationRevision,
  consolidationSections,
  buildConsolidationProvenanceV2,
  type ConsolidationProvenanceV2,
} from './consolidation.js';
import {
  assertMemoryCodeCitation,
  formatMemoryCodeCitationLines,
  MAX_MEMORY_CODE_CITATIONS,
  MEMORY_SCHEMA_VERSION,
  type MemoryCodeCitationV1,
} from './code/citation.js';
import {
  assertMemoryDocumentSchemaWritable,
  canonicalMemoryDocumentContent,
  parseMemoryDocument,
  type MemoryRecord,
} from './document.js';
import {
  parseTopicMaintenanceDraft,
  topicMaintenanceParagraphCoverage,
  validateTopicMaintenanceReviewPayload,
  type TopicMaintenanceDraftProposalV1,
  type TopicMaintenanceReviewPayloadV1,
} from './topic-maintenance-draft.js';
import {validateTopicMaintenanceManifest, type TopicMaintenanceManifestV2} from './topic-maintenance.js';

const HASH = /^[a-f0-9]{64}$/u;
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const MAX_TOPIC_MAINTENANCE_PREVIEW_BYTES = 256 * 1024;

export interface TopicMaintenanceAcceptanceOptionsV1 {
  readonly reviewId: string;
  readonly approvedAt: string;
  readonly editedDraftJson?: string;
}

export interface TopicMaintenanceAcceptancePreviewV1 {
  readonly version: 1;
  readonly reviewId: string;
  readonly approvedAt: string;
  readonly targetUri: string;
  readonly beforeContent: string;
  readonly beforeContentHash: string;
  readonly content: string;
  readonly contentHash: string;
  readonly approvalDigest: string;
  readonly approvedProposal: TopicMaintenanceDraftProposalV1;
  readonly manifest: TopicMaintenanceManifestV2;
  readonly codeCitations: readonly MemoryCodeCitationV1[];
  readonly consolidation?: ConsolidationProvenanceV2;
  readonly metadataDiff: readonly {readonly field: string; readonly beforeHash: string; readonly afterHash: string}[];
}

export interface TopicMaintenanceApprovalReceiptV1 {
  readonly version: 1;
  readonly reviewRevision: number;
  readonly stage: 'preview' | 'parked' | 'prepared' | 'written' | 'conflict';
  readonly preview: TopicMaintenanceAcceptancePreviewV1;
}

function fail(message: string): never {
  throw new Error(`Topic maintenance acceptance: ${message}`);
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  );
}

function checkedTimestamp(value: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    fail('approval timestamp must be canonical ISO time.');
}

function approvalDigest(preview: Omit<TopicMaintenanceAcceptancePreviewV1, 'approvalDigest'>): string {
  return consolidationRevision(
    JSON.stringify({
      version: preview.version,
      reviewId: preview.reviewId,
      approvedAt: preview.approvedAt,
      targetUri: preview.targetUri,
      beforeContentHash: preview.beforeContentHash,
      contentHash: preview.contentHash,
      approvedProposal: preview.approvedProposal,
      manifest: preview.manifest,
      codeCitations: preview.codeCitations,
      consolidation: preview.consolidation ?? null,
      metadataDiff: preview.metadataDiff,
    }),
  );
}

function rawBodyWithReviewedReplacements(
  rawBody: string,
  acceptedBody: string,
  proposal: TopicMaintenanceDraftProposalV1,
): string {
  if (proposal.body === acceptedBody) return rawBody;
  const chunks: {start: number; end: number; text: string}[] = [];
  let cursor = 0;
  const add = (end: number) => {
    const chunk = rawBody.slice(cursor, end);
    const text = chunk.trim();
    if (text) {
      const start = cursor + chunk.length - chunk.trimStart().length;
      chunks.push({start, end: start + text.length, text});
    }
  };
  for (const match of rawBody.matchAll(/\r?\n[\t ]*\r?\n/gu)) {
    add(match.index);
    cursor = match.index + match[0].length;
  }
  add(rawBody.length);
  const sections = consolidationSections(acceptedBody);
  if (
    chunks.length !== sections.length ||
    chunks.some((chunk, index) => chunk.text.replace(/\r\n/gu, '\n') !== sections[index])
  )
    fail('raw target paragraph geometry differs from the reviewed body.');
  const replacements = new Map(proposal.draft.operations.map(operation => [operation.ordinal, operation.text]));
  let output = '';
  cursor = 0;
  for (const [ordinal, chunk] of chunks.entries()) {
    output += rawBody.slice(cursor, chunk.start);
    output += replacements.get(ordinal) ?? rawBody.slice(chunk.start, chunk.end);
    cursor = chunk.end;
  }
  return output + rawBody.slice(cursor);
}

function patchHeader(
  header: string,
  replacements: Readonly<Record<string, readonly string[]>>,
  optional: readonly string[],
): string {
  const parts = header.split(/(\r?\n)/u);
  const rows = Array.from({length: Math.ceil(parts.length / 2)}, (_, index) => ({
    text: parts[index * 2] ?? '',
    ending: parts[index * 2 + 1] ?? '',
  }));
  const ending = rows.find(row => row.ending)?.ending ?? '\n';
  const output: typeof rows = [];
  for (const [key, values] of Object.entries(replacements)) {
    const matched = rows.filter(row => /^\s*[^:]+\s*:/u.test(row.text) && row.text.trimStart().startsWith(`${key}:`));
    if (key !== 'code_citation' && matched.length > 1) fail(`duplicate ${key} header.`);
    if (!matched.length && !optional.includes(key)) fail(`missing ${key} header.`);
    if (matched.some(row => !row.text.startsWith(`${key}: `))) fail(`noncanonical ${key} header.`);
    if (values.length === 0 && key !== 'code_citation') fail(`empty ${key} replacement.`);
  }
  const done = new Set<string>();
  for (const row of rows) {
    const key = Object.keys(replacements).find(
      name => /^\s*[^:]+\s*:/u.test(row.text) && row.text.trimStart().startsWith(`${name}:`),
    );
    if (!key) {
      output.push(row);
      continue;
    }
    if (done.has(key)) continue;
    done.add(key);
    const values = replacements[key];
    values.forEach((text, index) => output.push({text, ending: index === values.length - 1 ? row.ending : ending}));
  }
  for (const key of optional) {
    if (done.has(key)) continue;
    const values = replacements[key];
    if (!values?.length) continue;
    if (output.length) output[output.length - 1].ending = ending;
    values.forEach((text, index) => output.push({text, ending: index === values.length - 1 ? '' : ending}));
  }
  return output.map(row => row.text + row.ending).join('');
}

function metadataDiff(before: string, after: string): TopicMaintenanceAcceptancePreviewV1['metadataDiff'] {
  const keys = [
    'schema_version',
    'body',
    'topic_maintenance',
    'code_citation',
    'consolidation',
    'updated_at',
    'last_reviewed',
  ];
  const values = (content: string, key: string) => {
    const boundary = /\r?\n\r?\n/u.exec(content);
    const header = boundary ? content.slice(0, boundary.index) : content;
    if (key === 'body') return boundary ? content.slice(boundary.index + boundary[0].length) : '';
    return header
      .split(/\r?\n/u)
      .filter(line => line.startsWith(`${key}: `))
      .join('\n');
  };
  return keys.flatMap(field => {
    const oldValue = values(before, field);
    const newValue = values(after, field);
    return oldValue === newValue
      ? []
      : [{field, beforeHash: consolidationRevision(oldValue), afterHash: consolidationRevision(newValue)}];
  });
}

export function assertTopicMaintenanceAcceptanceCoverage(
  review: TopicMaintenanceReviewPayloadV1,
  proposal: TopicMaintenanceDraftProposalV1 = review.proposal,
): void {
  if (
    review.generation.origin !== 'manual' &&
    topicMaintenanceParagraphCoverage(review.basis, proposal.draft).status !== 'complete'
  )
    fail(
      'Model paragraph dispositions are incomplete or legacy. Regenerate or explicitly review every eligible paragraph before accepting.',
    );
}

/** Pure reviewed proposal; callers own source fences, locks, and target CAS. */
export function prepareTopicMaintenanceAcceptance(
  record: MemoryRecord,
  review: TopicMaintenanceReviewPayloadV1,
  options: TopicMaintenanceAcceptanceOptionsV1,
): TopicMaintenanceAcceptancePreviewV1 {
  const preview = assembleTopicMaintenanceAcceptance(record, review, options);
  assertTopicMaintenanceAcceptanceCoverage(review, preview.approvedProposal);
  return preview;
}

function assembleTopicMaintenanceAcceptance(
  record: MemoryRecord,
  reviewInput: TopicMaintenanceReviewPayloadV1,
  options: TopicMaintenanceAcceptanceOptionsV1,
): TopicMaintenanceAcceptancePreviewV1 {
  const review = validateTopicMaintenanceReviewPayload(reviewInput);
  assertMemoryDocumentSchemaWritable(record.content);
  checkedTimestamp(options.approvedAt);
  if (!/^review-[a-z0-9-]{1,80}$/u.test(options.reviewId)) fail('invalid review identity.');
  const old = record.metadata.topicMaintenance;
  if (!old || record.metadata.topicMaintenanceError || record.metadata.citationErrors?.length)
    fail('target is not a valid enrolled topic.');
  validateTopicMaintenanceManifest(old, record);
  const before = canonicalMemoryDocumentContent(record.content);
  if (
    review.basis.targetUri !== record.uri ||
    review.basis.targetHash !== consolidationRevision(before) ||
    review.basis.body !== record.body ||
    JSON.stringify(review.basis.paragraphs) !== JSON.stringify(old.paragraphs) ||
    JSON.stringify(review.basis.additionalDependencies) !== JSON.stringify(old.additionalDependencies)
  )
    fail('review basis differs from the accepted target.');
  const approvedProposal =
    options.editedDraftJson === undefined
      ? review.proposal
      : parseTopicMaintenanceDraft(review.basis, options.editedDraftJson);
  if (!['propose-update', 'propose-revalidation'].includes(approvedProposal.draft.outcome))
    fail('review outcome has no acceptable update.');
  if (approvedProposal.body !== record.body && (record.metadata.sourceEvidence || record.metadata.obsidianEvidence))
    fail('body-bound imported evidence cannot yet be rebuilt for a changed topic body.');
  const evidence = new Map(review.reviewEvidence.map(item => [item.handleId, item]));
  const paragraphs = old.paragraphs.map((paragraph, ordinal) => {
    const operation = approvedProposal.draft.operations.find(item => item.ordinal === ordinal);
    const revalidation = approvedProposal.draft.paragraphDispositions?.entries.find(
      item => item.ordinal === ordinal && item.disposition === 'revalidate',
    );
    const supportHandles = operation?.supportHandles ?? revalidation?.supportHandles;
    return {
      ...paragraph,
      hash: consolidationRevision(consolidationSections(approvedProposal.body)[ordinal]),
      citationIds: supportHandles
        ? [...new Set(supportHandles.map(handle => evidence.get(handle)!.citation.id))].sort()
        : paragraph.citationIds,
    };
  });
  const declared = new Set([
    ...paragraphs.flatMap(paragraph => paragraph.citationIds),
    ...old.additionalDependencies.map(dependency => dependency.citationId),
  ]);
  const acceptedSources = [...declared].sort().map(citationId => {
    const historical = evidence.get(`historical:${citationId}`);
    const current = evidence.get(`current:${citationId}`);
    const acceptedCitationId = current?.citation.id ?? (historical ? historical.citation.id : citationId);
    return {citationId, acceptedCitationId};
  });
  const manifest: TopicMaintenanceManifestV2 = {
    version: 2,
    memoryId: old.memoryId,
    repositoryId: old.repositoryId,
    bodyHash: consolidationRevision(approvedProposal.body),
    coverage: 'declared-only',
    paragraphs,
    additionalDependencies: old.additionalDependencies,
    originCitationIds:
      old.version === 1
        ? (record.metadata.codeCitations ?? []).map(citation => citation.id).sort()
        : old.originCitationIds,
    acceptedSources,
  };
  const priorAccepted = new Set(old.version === 2 ? old.acceptedSources.map(item => item.acceptedCitationId) : []);
  const preserved = (record.metadata.codeCitations ?? []).filter(
    citation =>
      manifest.originCitationIds.includes(citation.id) || !priorAccepted.has(citation.id) || declared.has(citation.id),
  );
  const citationsById = new Map<string, MemoryCodeCitationV1>(preserved.map(citation => [citation.id, citation]));
  for (const item of review.reviewEvidence)
    citationsById.set(item.citation.id, assertMemoryCodeCitation(item.citation));
  const required = new Set([
    ...manifest.originCitationIds,
    ...declared,
    ...acceptedSources.map(source => source.acceptedCitationId),
  ]);
  const original = record.metadata.consolidation;
  if (original) {
    const origin = original.version === 1 ? original : original.origin;
    for (const source of origin.sources)
      for (const citation of source.codeCitations)
        if (preserved.some(item => item.id === citation.id)) required.add(citation.id);
  }
  for (const citation of preserved) required.add(citation.id);
  const codeCitations = [...required]
    .map(id => citationsById.get(id) ?? fail(`missing reviewed citation ${id}.`))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (codeCitations.length > MAX_MEMORY_CODE_CITATIONS)
    fail(`citation union has ${codeCitations.length} entries; limit is ${MAX_MEMORY_CODE_CITATIONS}.`);
  formatMemoryCodeCitationLines(codeCitations);
  const consolidation = original
    ? buildConsolidationProvenanceV2(original, record.body, approvedProposal.body, manifest, {
        reviewId: options.reviewId,
        targetBeforeHash: review.basis.targetHash,
        packetDigest: review.basis.packetDigest,
        observationRevision: review.basis.observationRevision,
      })
    : undefined;
  const raw = canonicalMemoryDocumentContent(record.content);
  const separator = /\r?\n\r?\n/u.exec(raw);
  if (!separator) fail('target document lacks a canonical header/body boundary.');
  const header = raw.slice(0, separator.index);
  const body = raw.slice(separator.index + separator[0].length);
  const patchedBody = rawBodyWithReviewedReplacements(body, record.body, approvedProposal);
  const replacements = {
    schema_version: [`schema_version: ${MEMORY_SCHEMA_VERSION}`],
    code_citation: formatMemoryCodeCitationLines(codeCitations),
    topic_maintenance: [`topic_maintenance: ${JSON.stringify(manifest)}`],
    ...(consolidation ? {consolidation: [`consolidation: ${JSON.stringify(consolidation)}`]} : {}),
    updated_at: [`updated_at: ${options.approvedAt}`],
    last_reviewed: [`last_reviewed: ${options.approvedAt}`],
  };
  const content = `${patchHeader(header, replacements, ['updated_at', 'last_reviewed'])}${separator[0]}${patchedBody}`;
  const parsed = parseMemoryDocument(record.uri, content);
  if (
    !parsed ||
    parsed.metadata.citationErrors?.length ||
    parsed.metadata.topicMaintenanceError ||
    parsed.metadata.consolidationError ||
    parsed.body !== approvedProposal.body ||
    JSON.stringify(parsed.metadata.topicMaintenance) !== JSON.stringify(manifest)
  )
    fail('prepared document failed exact provenance readback.');
  validateTopicMaintenanceManifest(manifest, parsed);
  const base = {
    version: 1 as const,
    reviewId: options.reviewId,
    approvedAt: options.approvedAt,
    targetUri: record.uri,
    beforeContent: before,
    beforeContentHash: consolidationRevision(before),
    content,
    contentHash: consolidationRevision(content),
    approvedProposal,
    manifest,
    codeCitations,
    ...(consolidation ? {consolidation} : {}),
    metadataDiff: metadataDiff(before, content),
  };
  const preview = {...base, approvalDigest: approvalDigest(base)};
  if (utf8Bytes(JSON.stringify(preview)) > MAX_TOPIC_MAINTENANCE_PREVIEW_BYTES)
    fail('prepared approval preview exceeds the 256 KiB limit.');
  return preview;
}

export function validateTopicMaintenanceAcceptancePreview(
  input: unknown,
  reviewInput: TopicMaintenanceReviewPayloadV1,
): TopicMaintenanceAcceptancePreviewV1 {
  const review = validateTopicMaintenanceReviewPayload(reviewInput);
  if (
    !exactKeys(
      input,
      [
        'version',
        'reviewId',
        'approvedAt',
        'targetUri',
        'beforeContent',
        'beforeContentHash',
        'content',
        'contentHash',
        'approvalDigest',
        'approvedProposal',
        'manifest',
        'codeCitations',
        'metadataDiff',
      ],
      ['consolidation'],
    ) ||
    input.version !== 1 ||
    utf8Bytes(JSON.stringify(input)) > MAX_TOPIC_MAINTENANCE_PREVIEW_BYTES ||
    typeof input.content !== 'string' ||
    typeof input.targetUri !== 'string' ||
    typeof input.beforeContent !== 'string' ||
    typeof input.reviewId !== 'string' ||
    typeof input.approvedAt !== 'string' ||
    typeof input.beforeContentHash !== 'string' ||
    input.beforeContentHash !== consolidationRevision(input.beforeContent) ||
    typeof input.contentHash !== 'string' ||
    input.contentHash !== consolidationRevision(input.content) ||
    typeof input.approvalDigest !== 'string' ||
    !HASH.test(input.approvalDigest) ||
    !Array.isArray(input.codeCitations) ||
    !Array.isArray(input.metadataDiff)
  )
    fail('approval preview is malformed or oversized.');
  checkedTimestamp(input.approvedAt);
  if (!exactKeys(input.approvedProposal, ['version', 'draft', 'body', 'finalBodyHash', 'changedOrdinals']))
    fail('approved proposal is malformed.');
  const proposal = parseTopicMaintenanceDraft(review.basis, JSON.stringify(input.approvedProposal.draft));
  if (JSON.stringify(proposal) !== JSON.stringify(input.approvedProposal))
    fail('approved proposal differs from its reviewed draft.');
  const parsed = parseMemoryDocument(input.targetUri, input.content);
  const prior = parseMemoryDocument(input.targetUri, input.beforeContent);
  if (
    !prior ||
    consolidationRevision(canonicalMemoryDocumentContent(prior.content)) !== review.basis.targetHash ||
    prior.body !== review.basis.body ||
    input.targetUri !== review.basis.targetUri
  )
    fail('approval preview has a stale original target.');
  if (
    !parsed ||
    parsed.metadata.citationErrors?.length ||
    parsed.metadata.topicMaintenance?.version !== 2 ||
    parsed.body !== proposal.body ||
    JSON.stringify(parsed.metadata.topicMaintenance) !== JSON.stringify(input.manifest) ||
    JSON.stringify(parsed.metadata.codeCitations) !== JSON.stringify(input.codeCitations) ||
    JSON.stringify(parsed.metadata.consolidation ?? null) !== JSON.stringify(input.consolidation ?? null)
  )
    fail('approval preview has invalid final document provenance.');
  const preview = input as unknown as TopicMaintenanceAcceptancePreviewV1;
  const {approvalDigest: digest, ...base} = preview;
  if (approvalDigest(base) !== digest) fail('approval preview digest differs from final document.');
  const reproduced = assembleTopicMaintenanceAcceptance(prior, review, {
    reviewId: preview.reviewId,
    approvedAt: preview.approvedAt,
    editedDraftJson: JSON.stringify(preview.approvedProposal.draft),
  });
  if (JSON.stringify(reproduced) !== JSON.stringify(preview))
    fail('approval preview differs from the exact reviewed transformation.');
  return preview;
}

export function validateTopicMaintenanceApprovalReceipt(
  input: unknown,
  reviewPayload: TopicMaintenanceReviewPayloadV1,
  reviewId: string,
  revision: number,
): TopicMaintenanceApprovalReceiptV1 {
  if (
    !exactKeys(input, ['version', 'reviewRevision', 'stage', 'preview']) ||
    input.version !== 1 ||
    !Number.isSafeInteger(input.reviewRevision) ||
    (input.reviewRevision as number) < 1 ||
    (input.reviewRevision as number) > revision ||
    !['preview', 'parked', 'prepared', 'written', 'conflict'].includes(input.stage as string)
  )
    fail('approval receipt is malformed.');
  const preview = validateTopicMaintenanceAcceptancePreview(input.preview, reviewPayload);
  if (preview.reviewId !== reviewId || (input.stage === 'preview' && input.reviewRevision !== revision))
    fail('approval receipt differs from its review identity or revision.');
  return input as unknown as TopicMaintenanceApprovalReceiptV1;
}

export function validateApprovedTopicMaintenanceWrite(
  beforeContent: string,
  finalContent: string,
  review: {
    readonly reviewId: string;
    readonly revision: number;
    readonly maintenance?: TopicMaintenanceReviewPayloadV1;
    readonly maintenanceApproval?: TopicMaintenanceApprovalReceiptV1;
  },
): TopicMaintenanceAcceptancePreviewV1 {
  const receipt = review.maintenanceApproval;
  if (
    !review.maintenance ||
    !receipt ||
    receipt.stage !== 'prepared' ||
    receipt.reviewRevision > review.revision ||
    receipt.reviewRevision < 1 ||
    receipt.preview.reviewId !== review.reviewId
  )
    fail('review has no prepared exact approval proof.');
  validateTopicMaintenanceApprovalReceipt(receipt, review.maintenance, review.reviewId, review.revision);
  const preview = receipt.preview;
  assertTopicMaintenanceAcceptanceCoverage(review.maintenance, preview.approvedProposal);
  if (canonicalMemoryDocumentContent(beforeContent) !== preview.beforeContent || finalContent !== preview.content)
    fail('target or proposed bytes differ from prepared approval.');
  return preview;
}
