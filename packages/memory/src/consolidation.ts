import {sha256HexSync} from '@threadnote/platform/sha256';
import {Schema} from 'effect';
import {parseResourceId} from '@threadnote/store/resource-id';
import {
  assertMemoryDocumentSchemaWritable,
  declaresReviewedSupportHeader,
  MAX_MEMORY_RELATIONS,
  parseMemoryDocument,
  type MemoryRelation,
} from './document.js';
import {
  assertMemoryCodeCitation,
  formatMemoryCodeCitationLines,
  MAX_MEMORY_CODE_CITATIONS,
  type MemoryCodeCitationV1,
} from './code/citation.js';
import type {MemoryKind, MemoryStatus} from './types.js';
import type {TopicMaintenanceManifestV2, TopicMaintenanceCodeManifestV3} from './topic-maintenance.js';

export interface ConsolidationSource {
  readonly uri: string;
  readonly revision: string;
  readonly memoryId?: string;
  readonly fragments: readonly string[];
  readonly codeCitations: readonly MemoryCodeCitationV1[];
  readonly relations: readonly MemoryRelation[];
}
export interface ConsolidationSupport {
  readonly sourceUri: string;
  readonly fragment: number;
  readonly citationIds: readonly string[];
  readonly relationIndexes: readonly number[];
}
export interface ConsolidationReview {
  /** Exact final paragraph text: editing any paragraph requires a fresh review. */
  readonly section: string;
  readonly disposition: 'direct' | 'contextual' | 'unsupported' | 'unresolved';
  readonly supports: readonly ConsolidationSupport[];
}
export interface ConsolidationTarget {
  readonly kind: MemoryKind;
  readonly status: MemoryStatus;
  readonly project: string;
  readonly topic: string;
  readonly sourceAgentClient: string;
}
export interface ConsolidationOptions {
  readonly operationId: string;
  readonly cleanup: 'archive' | 'forget' | 'keep';
  readonly cleanupShared: boolean;
  readonly target: ConsolidationTarget;
}
export interface ConsolidationProvenance extends ConsolidationOptions {
  readonly version: 1;
  readonly bodyHash: string;
  readonly requestHash: string;
  readonly sources: readonly ConsolidationSource[];
  readonly reviews: readonly ConsolidationReview[];
}

export interface ConsolidationProvenanceV2 {
  readonly version: 2;
  readonly origin: ConsolidationProvenance;
  readonly originBody: string;
  readonly bodyHash: string;
  readonly requestHash: string;
  readonly acceptance: {
    readonly reviewId: string;
    readonly targetBeforeHash: string;
    readonly packetDigest: string;
    readonly observationRevision: string;
    readonly paragraphs: readonly {
      readonly ordinal: number;
      readonly originOrdinal: number;
      readonly hash: string;
      readonly evidence: 'origin' | 'reviewed-current';
      readonly citationIds: readonly string[];
    }[];
  };
}

export type ConsolidationReceipt = ConsolidationProvenance | ConsolidationProvenanceV2;

export const MAX_CONSOLIDATION_SOURCES = 16;
export const MAX_CONSOLIDATION_BYTES = 60 * 1024;
export const MAX_CONSOLIDATION_V2_BYTES = 128 * 1024;
const digest = /^[a-f0-9]{64}$/;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function fail(message: string): never {
  throw new Error(`Consolidation review: ${message}`);
}
const strict = {onExcessProperty: 'error'} as const;
const CitationSchema = Schema.declare<MemoryCodeCitationV1>((value): value is MemoryCodeCitationV1 => {
  try {
    assertMemoryCodeCitation(value);
    return true;
  } catch {
    return false;
  }
});
const SourceSchema = Schema.Struct({
  uri: Schema.String,
  revision: Schema.String.check(Schema.isPattern(digest)),
  memoryId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  fragments: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  codeCitations: Schema.Array(CitationSchema).check(Schema.isMaxLength(8)),
  relations: Schema.Array(
    Schema.Struct({
      type: Schema.Literals(['depends_on', 'evidence_for', 'references', 'related_to', 'supersedes']),
      uri: Schema.String,
    }),
  ).check(Schema.isMaxLength(16)),
});
const ReviewSchema = Schema.Struct({
  section: Schema.String,
  disposition: Schema.Literals(['direct', 'contextual', 'unsupported', 'unresolved']),
  supports: Schema.Array(
    Schema.Struct({
      sourceUri: Schema.String,
      fragment: Schema.Int,
      citationIds: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
      relationIndexes: Schema.Array(Schema.Int).check(Schema.isMaxLength(16)),
    }),
  ).check(Schema.isMaxLength(16)),
});
export const ConsolidationTargetSchema = Schema.Struct({
  kind: Schema.Literals(['durable', 'handoff', 'incident', 'preference', 'smoke']),
  status: Schema.Literals(['active', 'archived', 'expired', 'superseded']),
  project: Schema.String,
  topic: Schema.String,
  sourceAgentClient: Schema.String,
});
const ProvenanceSchema = Schema.Struct({
  version: Schema.Literal(1),
  bodyHash: Schema.String,
  requestHash: Schema.String,
  operationId: Schema.String,
  cleanup: Schema.Literals(['archive', 'forget', 'keep']),
  cleanupShared: Schema.Boolean,
  target: ConsolidationTargetSchema,
  sources: Schema.Array(SourceSchema).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  reviews: Schema.Array(ReviewSchema).check(Schema.isMaxLength(64)),
});
const ProvenanceV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  origin: ProvenanceSchema,
  originBody: Schema.String,
  bodyHash: Schema.String,
  requestHash: Schema.String,
  acceptance: Schema.Struct({
    reviewId: Schema.String,
    targetBeforeHash: Schema.String,
    packetDigest: Schema.String,
    observationRevision: Schema.String,
    paragraphs: Schema.Array(
      Schema.Struct({
        ordinal: Schema.Int,
        originOrdinal: Schema.Int,
        hash: Schema.String,
        evidence: Schema.Literals(['origin', 'reviewed-current']),
        citationIds: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  }),
});

/** Blank-line-delimited paragraphs, including Markdown headings and code blocks, are reviewed verbatim. */
export function consolidationSections(body: string): readonly string[] {
  const sections = body
    .trim()
    .split(/\n[\t ]*\n/)
    .map(section => section.trim())
    .filter(Boolean);
  if (!sections.length || sections.length > 64 || bytes(body) > 32 * 1024)
    fail('draft must contain 1–64 paragraphs within 32 KiB.');
  return sections;
}

export function consolidationRevision(content: string): string {
  return sha256HexSync(content);
}

export function captureConsolidationSource(source: {
  readonly uri: string;
  readonly content: string;
}): ConsolidationSource {
  // Legacy capture cannot carry active, initial, or legacy reviewed-support provenance.
  if (declaresReviewedSupportHeader(source.content))
    fail(
      `source ${source.uri} has reviewed support that consolidation cannot preserve yet; use maintenance review/manual-preview instead.`,
    );
  assertMemoryDocumentSchemaWritable(source.content);
  const record = parseMemoryDocument(source.uri, source.content);
  if (!record || record.metadata.citationErrors?.length) fail(`source ${source.uri} has invalid evidence metadata.`);
  if (
    record.metadata.obsidianEvidence ||
    record.metadata.obsidianEvidenceError ||
    record.metadata.sourceEvidence ||
    record.metadata.sourceEvidenceError
  ) {
    fail(`source ${source.uri} has private evidence that consolidation cannot preserve yet.`);
  }
  const relationHeaders = source.content
    .split(/\r?\n\r?\n/, 1)[0]
    .split(/\r?\n/)
    .filter(line => /^\s*relation\s*:/u.test(line));
  if (relationHeaders.length !== (record.metadata.relations?.length ?? 0))
    fail(`source ${source.uri} has invalid relation metadata.`);
  const captured = {
    uri: record.uri,
    revision: consolidationRevision(source.content),
    ...(record.metadata.memoryId ? {memoryId: record.metadata.memoryId} : {}),
    fragments: consolidationSections(record.body),
    codeCitations: record.metadata.codeCitations ?? [],
    relations: record.metadata.relations ?? [],
  };
  validateSources([captured]);
  return captured;
}

export function reviewConsolidation(
  body: string,
  sources: readonly ConsolidationSource[],
  input: unknown,
  options: ConsolidationOptions,
) {
  const sections = consolidationSections(body);
  validateSources(sources);
  validateOptions(options);
  let reviews: readonly ConsolidationReview[];
  try {
    reviews = Schema.decodeUnknownSync(Schema.Array(ReviewSchema), strict)(input);
  } catch {
    return fail('invalid paragraph support decisions or evidence selectors.');
  }
  if (reviews.length !== sections.length) fail('every final paragraph needs an explicit evidence review.');
  const citations = new Map<string, MemoryCodeCitationV1>();
  const relations = new Map<string, MemoryRelation>();
  reviews.forEach((review, index) => {
    if (
      !review ||
      review.section !== sections[index] ||
      !['direct', 'contextual', 'unsupported'].includes(review.disposition) ||
      !Array.isArray(review.supports) ||
      review.supports.length > 16
    )
      fail(`paragraph ${index + 1} has missing or stale review bindings.`);
    if (review.disposition === 'unsupported' ? review.supports.length !== 0 : review.supports.length === 0)
      fail(`paragraph ${index + 1} needs applicable support or an explicit unsupported decision.`);
    for (const support of review.supports) {
      const source = sources.find(source => source.uri === support.sourceUri);
      if (
        !source ||
        !Number.isSafeInteger(support.fragment) ||
        support.fragment < 0 ||
        support.fragment >= source.fragments.length ||
        !Array.isArray(support.citationIds) ||
        support.citationIds.length > 8 ||
        !Array.isArray(support.relationIndexes) ||
        support.relationIndexes.length > 16
      )
        fail(`paragraph ${index + 1} selects invalid source evidence.`);
      for (const id of support.citationIds) {
        const citation = source.codeCitations.find(citation => citation.id === id);
        if (!citation) fail(`paragraph ${index + 1} selects unknown citation ${id}.`);
        if (review.disposition === 'direct') {
          const previous = citations.get(id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(citation))
            fail(`conflicting captured provenance for citation ${id}; review the source anchors.`);
          citations.set(id, citation);
        }
      }
      for (const ordinal of support.relationIndexes) {
        const relation = source.relations[ordinal];
        if (!Number.isSafeInteger(ordinal) || ordinal < 0 || !relation)
          fail(`paragraph ${index + 1} selects unknown relation.`);
        if (review.disposition === 'direct') relations.set(`${relation.type} ${relation.uri}`, relation);
      }
    }
  });
  if (citations.size > MAX_MEMORY_CODE_CITATIONS)
    fail(
      `${citations.size} selected citations exceed the limit of ${MAX_MEMORY_CODE_CITATIONS}; deselect evidence or split the draft. Selected: ${[...citations.values()].map(c => c.path).join(', ')}`,
    );
  if (relations.size > MAX_MEMORY_RELATIONS)
    fail(
      `${relations.size} selected relations exceed the limit of ${MAX_MEMORY_RELATIONS}; deselect evidence or split the draft.`,
    );
  const payload = {version: 1 as const, ...options, bodyHash: consolidationRevision(body.trim()), sources, reviews};
  const provenance: ConsolidationProvenance = {...payload, requestHash: sha256HexSync(JSON.stringify(payload))};
  if (bytes(JSON.stringify(provenance)) > MAX_CONSOLIDATION_BYTES)
    fail('captured provenance exceeds 60 KiB; use fewer sources or split the draft.');
  return {
    codeCitations: [...citations.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...relations.values()].sort((a, b) => `${a.type} ${a.uri}`.localeCompare(`${b.type} ${b.uri}`)),
    provenance,
  };
}

function validateOptions(options: ConsolidationOptions): void {
  if (
    !options ||
    typeof options.operationId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(options.operationId) ||
    !['archive', 'forget', 'keep'].includes(options.cleanup) ||
    typeof options.cleanupShared !== 'boolean'
  )
    fail('invalid operation receipt.');
  const t = options.target;
  Schema.decodeSync(ConsolidationTargetSchema, strict)(t);
  if ([t.project, t.topic, t.sourceAgentClient].some(value => bytes(value) > 512)) fail('invalid target receipt.');
}

function validateSources(sources: readonly ConsolidationSource[]): void {
  Schema.decodeSync(Schema.Array(SourceSchema), strict)(sources);
  if (
    !Array.isArray(sources) ||
    sources.length < 1 ||
    sources.length > MAX_CONSOLIDATION_SOURCES ||
    new Set(sources.map(s => s.uri)).size !== sources.length
  )
    fail('select 1–16 distinct source revisions.');
  for (const source of sources) {
    if (
      !source ||
      typeof source.uri !== 'string' ||
      parseResourceId(source.uri).canonicalUri !== source.uri ||
      !digest.test(source.revision) ||
      !Array.isArray(source.fragments) ||
      source.fragments.length < 1 ||
      source.fragments.length > 64 ||
      source.fragments.some(
        (fragment: unknown) => typeof fragment !== 'string' || !fragment.trim() || bytes(fragment) > 32 * 1024,
      ) ||
      !Array.isArray(source.codeCitations) ||
      !Array.isArray(source.relations) ||
      source.relations.length > 16
    )
      fail('invalid captured source revision.');
    formatMemoryCodeCitationLines(source.codeCitations);
    for (const relation of source.relations)
      if (
        !relation ||
        !['depends_on', 'evidence_for', 'references', 'related_to', 'supersedes'].includes(relation.type) ||
        typeof relation.uri !== 'string' ||
        parseResourceId(relation.uri).canonicalUri !== relation.uri
      )
        fail('invalid captured relation.');
  }
}

/** Derivation is separate from active evidence, but its binding must still describe the stored body. */
export function validateConsolidationProvenance(
  value: unknown,
  body: string,
  archived = false,
): ReturnType<typeof reviewConsolidation> {
  const provenance = Schema.decodeUnknownSync(ProvenanceSchema, strict)(value);
  let effectiveBody = body;
  // Lifecycle archives can themselves be archived; their fixed wrapper adds no reviewed claim.
  while (
    archived &&
    provenance.bodyHash !== consolidationRevision(effectiveBody.trim()) &&
    effectiveBody.startsWith('Archived original Threadnote memory.\n\n')
  ) {
    effectiveBody = effectiveBody.slice('Archived original Threadnote memory.\n\n'.length);
  }
  if (
    !provenance ||
    provenance.version !== 1 ||
    !digest.test(provenance.bodyHash) ||
    !digest.test(provenance.requestHash) ||
    provenance.bodyHash !== consolidationRevision(effectiveBody.trim())
  )
    fail('persisted derivation is malformed or bound to a different body; review the edited draft.');
  const result = reviewConsolidation(effectiveBody, provenance.sources, provenance.reviews, {
    operationId: provenance.operationId,
    cleanup: provenance.cleanup,
    cleanupShared: provenance.cleanupShared,
    target: provenance.target,
  });
  if (result.provenance.requestHash !== provenance.requestHash)
    fail('persisted receipt differs from reviewed provenance.');
  return result;
}

/** Preserve the original note derivation while binding one replaceable reviewed code-support layer. */
export function buildConsolidationProvenanceV2(
  previous: ConsolidationReceipt,
  previousBody: string,
  body: string,
  manifest: TopicMaintenanceManifestV2 | TopicMaintenanceCodeManifestV3,
  acceptance: Omit<ConsolidationProvenanceV2['acceptance'], 'paragraphs'>,
): ConsolidationProvenanceV2 {
  const origin = previous.version === 1 ? previous : previous.origin;
  const originBody = previous.version === 1 ? previousBody : previous.originBody;
  validateConsolidationProvenance(origin, originBody);
  if (previous.version === 2) validateConsolidationProvenanceV2(previous, previousBody);
  const sections = consolidationSections(body);
  const originalSections = consolidationSections(originBody);
  if (sections.length !== originalSections.length || manifest.paragraphs.length !== sections.length)
    fail('maintenance must preserve the original paragraph geometry.');
  const paragraphs = sections.map((section, ordinal) => {
    const review = origin.reviews[ordinal];
    const citationIds = manifest.paragraphs[ordinal].citationIds;
    const oldIds = [...new Set(review.supports.flatMap(support => support.citationIds))].sort();
    const evidence =
      section === review.section && JSON.stringify([...citationIds].sort()) === JSON.stringify(oldIds)
        ? ('origin' as const)
        : ('reviewed-current' as const);
    return {
      ordinal,
      originOrdinal: ordinal,
      hash: consolidationRevision(section),
      evidence,
      citationIds,
    };
  });
  const payload = {
    version: 2 as const,
    origin,
    originBody,
    bodyHash: consolidationRevision(body.trim()),
    acceptance: {...acceptance, paragraphs},
  };
  const receipt: ConsolidationProvenanceV2 = {...payload, requestHash: sha256HexSync(JSON.stringify(payload))};
  validateConsolidationProvenanceV2(receipt, body);
  return receipt;
}

export function validateConsolidationProvenanceV2(value: unknown, body: string): ConsolidationProvenanceV2 {
  const receipt = Schema.decodeUnknownSync(ProvenanceV2Schema, strict)(value);
  const stored = value as ConsolidationProvenanceV2;
  if (bytes(JSON.stringify(receipt)) > MAX_CONSOLIDATION_V2_BYTES)
    fail('maintenance provenance exceeds the 128 KiB limit.');
  if (bytes(receipt.originBody) > 32 * 1024 || receipt.originBody.length === 0)
    fail('maintenance origin body is missing or oversized.');
  validateConsolidationProvenance(receipt.origin, receipt.originBody);
  const sections = consolidationSections(body);
  if (
    sections.length !== consolidationSections(receipt.originBody).length ||
    receipt.bodyHash !== consolidationRevision(body.trim()) ||
    !digest.test(receipt.bodyHash) ||
    !digest.test(receipt.requestHash) ||
    !digest.test(receipt.acceptance.targetBeforeHash) ||
    !digest.test(receipt.acceptance.packetDigest) ||
    !digest.test(receipt.acceptance.observationRevision) ||
    !/^review-[a-z0-9-]{1,80}$/u.test(receipt.acceptance.reviewId) ||
    receipt.acceptance.paragraphs.length !== sections.length
  )
    fail('maintenance derivation is stale or malformed.');
  for (const [ordinal, paragraph] of receipt.acceptance.paragraphs.entries()) {
    const originReview = receipt.origin.reviews[ordinal];
    const oldIds = [...new Set(originReview.supports.flatMap(support => support.citationIds))].sort();
    if (
      paragraph.ordinal !== ordinal ||
      paragraph.originOrdinal !== ordinal ||
      paragraph.hash !== consolidationRevision(sections[ordinal]) ||
      new Set(paragraph.citationIds).size !== paragraph.citationIds.length ||
      paragraph.citationIds.some(id => !/^tncc_[a-f0-9]{40}$/u.test(id)) ||
      (paragraph.evidence === 'origin' &&
        (sections[ordinal] !== originReview.section ||
          JSON.stringify([...paragraph.citationIds].sort()) !== JSON.stringify(oldIds))) ||
      (paragraph.evidence === 'reviewed-current' && paragraph.citationIds.length === 0)
    )
      fail(`maintenance paragraph ${ordinal + 1} has invalid origin or current support.`);
  }
  const payload = {
    version: stored.version,
    origin: stored.origin,
    originBody: stored.originBody,
    bodyHash: stored.bodyHash,
    acceptance: stored.acceptance,
  };
  if (receipt.requestHash !== sha256HexSync(JSON.stringify(payload)))
    fail('maintenance receipt differs from reviewed provenance.');
  return stored;
}

export function validateConsolidationV2ActiveEvidence(
  receipt: ConsolidationProvenanceV2,
  manifest: TopicMaintenanceManifestV2 | TopicMaintenanceCodeManifestV3,
  citations: readonly MemoryCodeCitationV1[],
  relations: readonly MemoryRelation[],
): void {
  const origin = validateConsolidationProvenance(receipt.origin, receipt.originBody);
  if (JSON.stringify(relations) !== JSON.stringify(origin.relations))
    fail('maintenance changed original reviewed relations.');
  if (manifest.paragraphs.length !== receipt.acceptance.paragraphs.length)
    fail('maintenance manifest and derivation paragraph counts differ.');
  for (const [ordinal, paragraph] of receipt.acceptance.paragraphs.entries())
    if (JSON.stringify(paragraph.citationIds) !== JSON.stringify(manifest.paragraphs[ordinal].citationIds))
      fail(`maintenance paragraph ${ordinal + 1} cites different reviewed support.`);
  const required = new Set([
    ...origin.codeCitations.map(citation => citation.id),
    ...manifest.originCitationIds,
    ...manifest.paragraphs.flatMap(paragraph => paragraph.citationIds),
    ...manifest.additionalDependencies.map(dependency => dependency.citationId),
    ...manifest.acceptedSources.map(source => source.acceptedCitationId),
  ]);
  const actual = new Map(citations.map(citation => [citation.id, citation]));
  if (required.size !== citations.length || required.size > MAX_MEMORY_CODE_CITATIONS)
    fail('maintenance active citation union exceeds eight or differs from reviewed support.');
  for (const id of required) if (!actual.has(id)) fail('maintenance omitted a reviewed citation.');
  for (const original of origin.codeCitations)
    if (JSON.stringify(actual.get(original.id)) !== JSON.stringify(original))
      fail('maintenance changed immutable original code evidence.');
}
