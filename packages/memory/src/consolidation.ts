import {sha256HexSync} from '@threadnote/platform/sha256';
import {Schema} from 'effect';
import {parseResourceId} from '@threadnote/store/resource-id';
import {
  assertMemoryDocumentSchemaWritable,
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

export const MAX_CONSOLIDATION_SOURCES = 16;
export const MAX_CONSOLIDATION_BYTES = 60 * 1024;
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
