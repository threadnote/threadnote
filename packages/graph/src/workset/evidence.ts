import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
  AgentResponseBudgetTooSmallError,
  measureAgentToolResponse,
  type AgentToolResponseMeasurement,
} from '@threadnote/protocol/agent-response';
import {
  CodeGraphProjectCoverageSchema,
  type CodeGraphProjectCoverage,
  type CodeGraphProvenance,
  type CodeGraphRelation,
  type CodeGraphSpan,
} from '../types.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_WORKSET_EVIDENCE_RESULT_VERSION = 2 as const;
export const CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION = 1 as const;
export const CODE_GRAPH_WORKSET_EVIDENCE_DEFAULT_ESTIMATED_TOKENS = 1_250 as const;
export const CODE_GRAPH_WORKSET_EVIDENCE_MINIMUM_ESTIMATED_TOKENS = 1 as const;
export const CODE_GRAPH_WORKSET_EVIDENCE_MAXIMUM_ESTIMATED_TOKENS = 1_500 as const;

export const CODE_GRAPH_WORKSET_EVIDENCE_REPOSITORY_STATES = [
  'current',
  'stale',
  'deferred',
  'missing',
  'failed',
  'excluded',
] as const;
export const CODE_GRAPH_WORKSET_EVIDENCE_STOP_REASONS = [
  'sufficient-evidence',
  'result-budget',
  'work-budget',
  'deadline',
  'exhaustion',
] as const;

const CODE_GRAPH_PROVENANCES = [
  'declared',
  'heuristic',
  'model',
  'resolved',
  'syntactic',
] as const satisfies readonly CodeGraphProvenance[];
const CODE_GRAPH_RELATIONS = [
  'calls',
  'configures',
  'constructs',
  'contains',
  'declares',
  'depends_on',
  'documents',
  'exports',
  'extends',
  'implements',
  'imports',
  'overrides',
  'reads_or_writes',
  'references',
  'reexports',
  'semantic_association',
  'tests',
] as const satisfies readonly CodeGraphRelation[];

const HANDLE_HEX_LENGTH = 40;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const LOCAL_NODE_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;
const QUALIFIED_REF = /^cgr_[0-9a-f]{40}$/u;
const CONTINUATION_HANDLE = /^cgwc_[0-9a-f]{40}$/u;
const GENERATION_ID = /^cgwg_[0-9a-f]{40}$/u;
const CARD_ID = /^cgec_[0-9a-f]{40}$/u;
const CONTINUATION_PLACEHOLDER = `cgwc_${Effect.pipe('0', EffectString.repeat(HANDLE_HEX_LENGTH))}`;

const LIMITS = {
  cards: 512,
  relationshipsPerCard: 32,
  repositories: 4_096,
  reasonSignals: 16,
  warnings: 32,
} as const;

export type CodeGraphWorksetEvidenceRepositoryState = (typeof CODE_GRAPH_WORKSET_EVIDENCE_REPOSITORY_STATES)[number];
export type CodeGraphWorksetEvidenceStopReason = (typeof CODE_GRAPH_WORKSET_EVIDENCE_STOP_REASONS)[number];

export interface QualifiedCodeGraphRefV1 {
  readonly nodeId: string;
  readonly repositoryId: string;
}

export interface CodeGraphWorksetContinuationIdentityV1 {
  /** Random, locally persisted result-set token. It is hashed and never transported. */
  readonly resultSetToken: string;
  readonly generationDigest: string;
  readonly offset: number;
  readonly projectorVersion: typeof CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION;
}

export interface RepositoryEvidenceReceiptV1 {
  readonly projectCoverage?: CodeGraphProjectCoverage;
  readonly considered: boolean;
  readonly deepQueried: boolean;
  readonly repositoryId: string;
  readonly snapshot?: {
    readonly checkoutId: string;
    readonly commit: string;
    readonly digest: string;
    readonly dirty: boolean;
    readonly freshness: 'current' | 'stale';
    readonly id: string;
    readonly projectionDigest: string;
    readonly provenance: 'ready-snapshot';
    readonly worktreeId: string;
  };
  readonly state: CodeGraphWorksetEvidenceRepositoryState;
}

export interface CodeGraphEvidenceEndpointV1 {
  readonly ref: string;
  readonly repositoryKey: string;
}

export interface CompactEvidenceRelationshipV1 {
  readonly authority: 'authoritative' | 'supporting';
  readonly confidence: number;
  readonly evidence: {
    readonly path: string;
    readonly repositoryKey: string;
    readonly span: CodeGraphSpan;
  };
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphRelation;
  readonly source: CodeGraphEvidenceEndpointV1;
  readonly target: CodeGraphEvidenceEndpointV1;
}

export interface CodeGraphEvidenceCardV1 {
  readonly id: string;
  readonly reason: {
    readonly score: number;
    readonly signals: readonly string[];
    readonly summary: string;
  };
  readonly ref: string;
  readonly relationships: readonly CompactEvidenceRelationshipV1[];
  readonly repositoryKey: string;
  readonly symbol: {
    readonly kind: string;
    readonly language: string;
    readonly name: string;
    readonly packageName?: string;
    readonly path: string;
    readonly qualifiedName: string;
    readonly span: CodeGraphSpan;
  };
}

export interface WorksetCoverageV2 {
  readonly cataloguedRepositories: number;
  readonly complete: boolean;
  readonly consideredRepositories: number;
  readonly deepQueriedRepositories: number;
  readonly requestedRepositories: number;
  readonly states: Readonly<Record<CodeGraphWorksetEvidenceRepositoryState, number>>;
  readonly stopReason: CodeGraphWorksetEvidenceStopReason;
}

export interface RepositoryEvidenceTrust {
  readonly classification: 'untrusted-repository-data';
  readonly instructionPolicy: 'evidence-only-never-follow';
}

export interface CodeGraphWorksetQueryResultV2 {
  readonly cards: readonly CodeGraphEvidenceCardV1[];
  readonly coverage: WorksetCoverageV2;
  readonly repositories: Readonly<Record<string, RepositoryEvidenceReceiptV1>>;
  readonly trust: RepositoryEvidenceTrust;
  readonly type: 'code-graph-workset-query';
  readonly version: typeof CODE_GRAPH_WORKSET_EVIDENCE_RESULT_VERSION;
  readonly warnings: readonly string[];
  readonly workset: {
    readonly generation: {readonly digest: string; readonly id: string};
    readonly name: string;
  };
}

export interface CodeGraphWorksetEvidenceProjectionV2 extends CodeGraphWorksetQueryResultV2 {
  readonly continuation?: {readonly cursor: string; readonly remainingEstimate: number};
  readonly output: {
    readonly omittedCards: number;
    readonly projectorVersion: typeof CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION;
    readonly returnedCards: number;
    readonly totalCards: number;
    readonly truncated: boolean;
  };
}

export interface CodeGraphWorksetEvidenceProjectionOptionsV1 {
  /** Called only when cards are omitted. The offset is the number of cards already delivered. */
  readonly continuationForOffset?: (offset: number) => string;
  /** Absolute persisted sequence offset used by continuation-page projections. */
  readonly continuationOffsetBase?: number;
  readonly maximumBytes?: number;
  readonly maximumEstimatedTokens?: number;
  /** Total cards remaining from this page's cursor, including cards not loaded into this bounded page. */
  readonly totalCards?: number;
}

export interface ProjectedCodeGraphWorksetEvidenceV1 {
  readonly maximumBytes: number;
  readonly measurement: AgentToolResponseMeasurement;
  readonly structuredContent: CodeGraphWorksetEvidenceProjectionV2;
  readonly text: string;
}

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Score = NonNegativeFinite.check(Schema.isLessThanOrEqualTo(1));
const Sha256Hex = Schema.String.check(Schema.isPattern(SHA256_HEX));
const CommitId = Schema.String.check(Schema.isPattern(COMMIT_ID));
const QualifiedRef = Schema.String.check(Schema.isPattern(QUALIFIED_REF));
const GenerationId = Schema.String.check(Schema.isPattern(GENERATION_ID));
const CardId = Schema.String.check(Schema.isPattern(CARD_ID));

const SpanSchema = Schema.Struct({
  column: NonNegativeInteger,
  endColumn: NonNegativeInteger,
  endLine: NonNegativeInteger,
  line: NonNegativeInteger,
});

const SnapshotReceiptSchema = Schema.Struct({
  checkoutId: Sha256Hex,
  commit: CommitId,
  digest: Sha256Hex,
  dirty: Schema.Boolean,
  freshness: Schema.Literals(['current', 'stale']),
  id: NonEmptyString,
  projectionDigest: Sha256Hex,
  provenance: Schema.Literal('ready-snapshot'),
  worktreeId: Sha256Hex,
});

const RepositoryReceiptSchema = Schema.Struct({
  projectCoverage: Schema.optionalKey(CodeGraphProjectCoverageSchema),
  considered: Schema.Boolean,
  deepQueried: Schema.Boolean,
  repositoryId: Sha256Hex,
  snapshot: Schema.optionalKey(SnapshotReceiptSchema),
  state: Schema.Literals(CODE_GRAPH_WORKSET_EVIDENCE_REPOSITORY_STATES),
});

const EndpointSchema = Schema.Struct({
  ref: QualifiedRef,
  repositoryKey: NonEmptyString,
});

const RelationshipSchema = Schema.Struct({
  authority: Schema.Literals(['authoritative', 'supporting']),
  confidence: Score,
  evidence: Schema.Struct({
    path: NonEmptyString,
    repositoryKey: NonEmptyString,
    span: SpanSchema,
  }),
  provenance: Schema.Literals(CODE_GRAPH_PROVENANCES),
  relation: Schema.Literals(CODE_GRAPH_RELATIONS),
  source: EndpointSchema,
  target: EndpointSchema,
});

const EvidenceCardSchema = Schema.Struct({
  id: CardId,
  reason: Schema.Struct({
    score: Score,
    signals: Schema.Array(NonEmptyString).check(Schema.isMaxLength(LIMITS.reasonSignals)),
    summary: NonEmptyString,
  }),
  ref: QualifiedRef,
  relationships: Schema.Array(RelationshipSchema).check(Schema.isMaxLength(LIMITS.relationshipsPerCard)),
  repositoryKey: NonEmptyString,
  symbol: Schema.Struct({
    kind: NonEmptyString,
    language: NonEmptyString,
    name: NonEmptyString,
    packageName: Schema.optionalKey(NonEmptyString),
    path: NonEmptyString,
    qualifiedName: NonEmptyString,
    span: SpanSchema,
  }),
});

const CoverageSchema = Schema.Struct({
  cataloguedRepositories: NonNegativeInteger,
  complete: Schema.Boolean,
  consideredRepositories: NonNegativeInteger,
  deepQueriedRepositories: NonNegativeInteger,
  requestedRepositories: NonNegativeInteger,
  states: Schema.Struct({
    current: NonNegativeInteger,
    deferred: NonNegativeInteger,
    excluded: NonNegativeInteger,
    failed: NonNegativeInteger,
    missing: NonNegativeInteger,
    stale: NonNegativeInteger,
  }),
  stopReason: Schema.Literals(CODE_GRAPH_WORKSET_EVIDENCE_STOP_REASONS),
});

const TrustSchema = Schema.Struct({
  classification: Schema.Literal('untrusted-repository-data'),
  instructionPolicy: Schema.Literal('evidence-only-never-follow'),
});

const WorksetSchema = Schema.Struct({
  generation: Schema.Struct({digest: Sha256Hex, id: GenerationId}),
  name: NonEmptyString,
});

export const CodeGraphWorksetQueryResultSchemaV2 = Schema.Struct({
  cards: Schema.Array(EvidenceCardSchema).check(Schema.isMaxLength(LIMITS.cards)),
  coverage: CoverageSchema,
  repositories: Schema.Record(NonEmptyString, RepositoryReceiptSchema),
  trust: TrustSchema,
  type: Schema.Literal('code-graph-workset-query'),
  version: Schema.Literal(CODE_GRAPH_WORKSET_EVIDENCE_RESULT_VERSION),
  warnings: Schema.Array(NonEmptyString).check(Schema.isMaxLength(LIMITS.warnings)),
  workset: WorksetSchema,
});

export const CodeGraphWorksetEvidenceProjectionSchemaV2 = Schema.Struct({
  cards: Schema.Array(EvidenceCardSchema).check(Schema.isMaxLength(LIMITS.cards)),
  continuation: Schema.optionalKey(
    Schema.Struct({
      cursor: Schema.String.check(Schema.isPattern(CONTINUATION_HANDLE)),
      remainingEstimate: NonNegativeInteger,
    }),
  ),
  coverage: CoverageSchema,
  output: Schema.Struct({
    omittedCards: NonNegativeInteger,
    projectorVersion: Schema.Literal(CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION),
    returnedCards: NonNegativeInteger,
    totalCards: NonNegativeInteger,
    truncated: Schema.Boolean,
  }),
  repositories: Schema.Record(NonEmptyString, RepositoryReceiptSchema),
  trust: TrustSchema,
  type: Schema.Literal('code-graph-workset-query'),
  version: Schema.Literal(CODE_GRAPH_WORKSET_EVIDENCE_RESULT_VERSION),
  warnings: Schema.Array(NonEmptyString).check(Schema.isMaxLength(LIMITS.warnings)),
  workset: WorksetSchema,
});

const STRICT_PARSE_OPTIONS = {errors: 'all', onExcessProperty: 'error'} as const;

export function codeGraphQualifiedRefHandle(input: QualifiedCodeGraphRefV1): string {
  if (!SHA256_HEX.test(input.repositoryId)) throw invalid('Qualified code graph repository identity is invalid.');
  if (!LOCAL_NODE_ID.test(input.nodeId)) throw invalid('Qualified code graph node identity is invalid.');
  return `cgr_${Effect.pipe(sha256HexSync(`threadnote-qualified-code-graph-ref-v1\0${input.repositoryId}\0${input.nodeId}`), EffectString.slice(0, HANDLE_HEX_LENGTH))}`;
}

export function codeGraphEvidenceCardId(ref: string, snapshotId: string, worktreeId: string): string {
  assertQualifiedRef(ref);
  boundedText(snapshotId, 'snapshot identity', 256);
  if (!SHA256_HEX.test(worktreeId)) throw invalid('Evidence card worktree identity is invalid.');
  return `cgec_${Effect.pipe(sha256HexSync(`threadnote-code-graph-evidence-card-v1\0${ref}\0${snapshotId}\0${worktreeId}`), EffectString.slice(0, HANDLE_HEX_LENGTH))}`;
}

export function codeGraphWorksetContinuationHandle(input: CodeGraphWorksetContinuationIdentityV1): string {
  if (!SHA256_HEX.test(input.resultSetToken)) throw invalid('Workset result-set token is invalid.');
  if (!SHA256_HEX.test(input.generationDigest)) throw invalid('Workset generation digest is invalid.');
  if (input.projectorVersion !== CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION) {
    throw invalid('Workset continuation projector version is incompatible.');
  }
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw invalid('Workset continuation offset is invalid.');
  }
  return `cgwc_${Effect.pipe(
    sha256HexSync(
      `threadnote-code-graph-workset-continuation-v1\0${input.resultSetToken}\0${input.generationDigest}\0${input.projectorVersion}\0${input.offset}`,
    ),
    EffectString.slice(0, HANDLE_HEX_LENGTH),
  )}`;
}

export function isCodeGraphQualifiedRefHandle(value: string): boolean {
  return QUALIFIED_REF.test(value);
}

export function isCodeGraphWorksetContinuationHandle(value: string): boolean {
  return CONTINUATION_HANDLE.test(value);
}

export function parseCodeGraphWorksetQueryResultV2(value: unknown): CodeGraphWorksetQueryResultV2 {
  const result = Schema.decodeUnknownSync(CodeGraphWorksetQueryResultSchemaV2, STRICT_PARSE_OPTIONS)(value);
  validateCommonResult(result, true);
  validateFullCoverage(result);
  return result;
}

export function parseCodeGraphWorksetEvidenceProjectionV2(value: unknown): CodeGraphWorksetEvidenceProjectionV2 {
  const result = Schema.decodeUnknownSync(CodeGraphWorksetEvidenceProjectionSchemaV2, STRICT_PARSE_OPTIONS)(value);
  validateCommonResult(result, false);
  validateProjection(result);
  return result;
}

/**
 * Projects a globally ranked logical result into one exact MCP response budget.
 * Structured content and terse text are measured independently so duplicate
 * transport bytes cannot hide behind an approximate card count.
 */
export function projectCodeGraphWorksetEvidence(
  input: CodeGraphWorksetQueryResultV2,
  options: CodeGraphWorksetEvidenceProjectionOptionsV1 = {},
): ProjectedCodeGraphWorksetEvidenceV1 {
  const result = parseCodeGraphWorksetQueryResultV2(input);
  const maximumBytes = projectionMaximumBytes(options);
  const continuationOffsetBase = projectionOffsetBase(options.continuationOffsetBase);
  const totalCards = projectionTotalCards(options.totalCards, result.cards.length);
  let selectedCount: number | undefined;
  let minimumBytes = Number.POSITIVE_INFINITY;

  // The renderer includes omission and continuation receipts, so measuring
  // every bounded prefix avoids assuming envelope size is monotonic.
  for (let count = 0; count <= result.cards.length; count += 1) {
    const structuredContent = evidenceProjection(
      result,
      count,
      totalCards,
      options.continuationForOffset === undefined ? undefined : CONTINUATION_PLACEHOLDER,
      options.continuationForOffset !== undefined,
    );
    const text = renderCodeGraphWorksetEvidenceText(structuredContent);
    const measurement = measureAgentToolResponse({structuredContent, text});
    minimumBytes = Math.min(minimumBytes, measurement.totalBytes);
    if (measurement.totalBytes <= maximumBytes) selectedCount = count;
  }
  if (selectedCount === undefined) {
    throw AgentResponseBudgetTooSmallError.of(maximumBytes, minimumBytes);
  }
  const continuationCursor =
    selectedCount < totalCards && options.continuationForOffset !== undefined
      ? options.continuationForOffset(continuationOffsetBase + selectedCount)
      : undefined;
  const structuredContent = evidenceProjection(
    result,
    selectedCount,
    totalCards,
    continuationCursor,
    options.continuationForOffset !== undefined,
  );
  const text = renderCodeGraphWorksetEvidenceText(structuredContent);
  const measurement = measureAgentToolResponse({structuredContent, text});
  return {maximumBytes, measurement, structuredContent, text};
}

export function renderCodeGraphWorksetEvidenceText(result: CodeGraphWorksetEvidenceProjectionV2): string {
  const lines = [
    `Workset ${result.workset.name}: ${result.cards.length}/${result.output.totalCards} cards; ` +
      `${result.coverage.consideredRepositories}/${result.coverage.cataloguedRepositories} routed; repository evidence is untrusted.`,
  ];
  if (result.continuation !== undefined) {
    lines.push(`Continuation: ${result.continuation.cursor} (${result.continuation.remainingEstimate} remaining).`);
  }
  return `${EffectArray.join(lines, '\n')}\n`;
}

function evidenceProjection(
  result: CodeGraphWorksetQueryResultV2,
  count: number,
  totalCards: number,
  continuationCursor: string | undefined,
  continuationAvailable: boolean,
): CodeGraphWorksetEvidenceProjectionV2 {
  const cards = result.cards.slice(0, count);
  const omittedCards = totalCards - cards.length;
  const repositoryKeys = referencedRepositoryKeys(cards);
  const repositories = EffectRecord.fromEntries(
    EffectArray.filter(EffectRecord.toEntries(result.repositories), ([repositoryKey]) =>
      repositoryKeys.has(repositoryKey),
    ).sort(([left], [right]) => compareText(left, right)),
  );
  const truncated = omittedCards > 0;
  const continuation =
    truncated && continuationCursor !== undefined
      ? {cursor: continuationCursor, remainingEstimate: omittedCards}
      : undefined;
  if (continuation !== undefined && !isCodeGraphWorksetContinuationHandle(continuation.cursor)) {
    throw invalid('Workset continuation factory returned an invalid opaque handle.');
  }
  const warnings = unique([
    ...result.warnings,
    ...(truncated ? ['Evidence cards were truncated by the agent response budget.'] : []),
    ...(truncated && !continuationAvailable
      ? ['Omitted evidence has no continuation because this caller did not register a result set.']
      : []),
  ]).slice(0, LIMITS.warnings);
  const projection: CodeGraphWorksetEvidenceProjectionV2 = {
    cards,
    ...(continuation === undefined ? {} : {continuation}),
    coverage: result.coverage,
    output: {
      omittedCards,
      projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
      returnedCards: cards.length,
      totalCards,
      truncated,
    },
    repositories,
    trust: result.trust,
    type: result.type,
    version: result.version,
    warnings,
    workset: result.workset,
  };
  return parseCodeGraphWorksetEvidenceProjectionV2(projection);
}

function validateCommonResult(
  result: Omit<CodeGraphWorksetQueryResultV2, 'repositories'> & {
    readonly repositories: Readonly<Record<string, RepositoryEvidenceReceiptV1>>;
  },
  requireFullReceipts: boolean,
): void {
  boundedText(result.workset.name, 'workset name', 256);
  if (
    result.workset.generation.id !==
    `cgwg_${Effect.pipe(result.workset.generation.digest, EffectString.slice(0, HANDLE_HEX_LENGTH))}`
  ) {
    throw invalid('Workset generation identity does not match its digest.');
  }
  if (EffectRecord.keys(result.repositories).length > LIMITS.repositories) {
    throw invalid('Workset evidence contains too many repository receipts.');
  }
  const cardIds = new Set<string>();
  const refOwners = new Map<string, string>();
  for (const [repositoryKey, receipt] of EffectRecord.toEntries(result.repositories)) {
    boundedText(repositoryKey, 'repository key', 256);
    if (repositoryKey === '__proto__' || repositoryKey === 'constructor' || repositoryKey === 'prototype') {
      throw invalid(`Workset repository key ${repositoryKey} is reserved.`);
    }
    validateRepositoryReceipt(repositoryKey, receipt);
  }
  for (const card of result.cards) {
    if (cardIds.has(card.id)) throw invalid(`Evidence card ${card.id} is duplicated.`);
    cardIds.add(card.id);
    validateCard(card, result.repositories, refOwners);
  }
  for (const warning of result.warnings) boundedText(warning, 'workset warning', 512);
  assertUnique(result.warnings, 'workset warnings');
  validateCoverageBounds(result.coverage);

  if (!requireFullReceipts) {
    const referenced = referencedRepositoryKeys(result.cards);
    const receiptKeys = EffectRecord.keys(result.repositories).sort(compareText);
    if (JSON.stringify(receiptKeys) !== JSON.stringify([...referenced].sort(compareText))) {
      throw invalid('Projected repository receipts must exactly match repositories referenced by retained cards.');
    }
  }
}

function validateFullCoverage(result: CodeGraphWorksetQueryResultV2): void {
  const receipts = EffectRecord.values(result.repositories);
  if (receipts.length !== result.coverage.requestedRepositories) {
    throw invalid('Workset requested repository count must equal its complete receipt dictionary.');
  }
  const catalogued = EffectArray.filter(receipts, receipt => receipt.snapshot !== undefined).length;
  const considered = EffectArray.filter(
    receipts,
    __effectArrayValue => !!(receipt => receipt.considered)(__effectArrayValue),
  ).length;
  const deepQueried = EffectArray.filter(
    receipts,
    __effectArrayValue => !!(receipt => receipt.deepQueried)(__effectArrayValue),
  ).length;
  if (catalogued !== result.coverage.cataloguedRepositories) {
    throw invalid('Workset catalogued repository count does not match snapshot receipts.');
  }
  if (considered !== result.coverage.consideredRepositories) {
    throw invalid('Workset considered repository count does not match member receipts.');
  }
  if (deepQueried !== result.coverage.deepQueriedRepositories) {
    throw invalid('Workset deep-query count does not match member receipts.');
  }
  for (const state of CODE_GRAPH_WORKSET_EVIDENCE_REPOSITORY_STATES) {
    const actual = EffectArray.filter(receipts, receipt => receipt.state === state).length;
    if (actual !== result.coverage.states[state]) {
      throw invalid(`Workset ${state} repository count does not match member receipts.`);
    }
  }
  if (
    result.coverage.complete !==
    (considered === catalogued &&
      EffectArray.every(receipts, receipt => receipt.projectCoverage?.completeness !== 'partial'))
  ) {
    throw invalid('Workset completeness must report full consideration without partial project coverage.');
  }
}

function validateProjection(result: CodeGraphWorksetEvidenceProjectionV2): void {
  const output = result.output;
  if (output.returnedCards !== result.cards.length) {
    throw invalid('Evidence projection returned-card count does not match its cards.');
  }
  if (output.returnedCards + output.omittedCards !== output.totalCards) {
    throw invalid('Evidence projection returned and omitted cards must sum to its total.');
  }
  if (output.truncated !== output.omittedCards > 0) {
    throw invalid('Evidence projection truncation does not match its omitted-card count.');
  }
  if (result.continuation !== undefined) {
    if (!output.truncated) throw invalid('A complete evidence projection cannot contain a continuation.');
    if (result.continuation.remainingEstimate < output.omittedCards) {
      throw invalid('Continuation remaining estimate cannot understate omitted evidence cards.');
    }
  }
}

function validateRepositoryReceipt(repositoryKey: string, receipt: RepositoryEvidenceReceiptV1): void {
  if (receipt.deepQueried && !receipt.considered) {
    throw invalid(`Repository ${repositoryKey} cannot be deep-queried without being considered.`);
  }
  const requiresSnapshot = receipt.state === 'current' || receipt.state === 'stale';
  if (requiresSnapshot && receipt.snapshot === undefined) {
    throw invalid(`Repository ${repositoryKey} requires exact snapshot provenance.`);
  }
  if (
    receipt.snapshot !== undefined &&
    receipt.state !== 'current' &&
    receipt.state !== 'stale' &&
    receipt.state !== 'failed'
  ) {
    throw invalid(`Repository ${repositoryKey} cannot attach snapshot provenance in state ${receipt.state}.`);
  }
  if (receipt.snapshot !== undefined) {
    boundedText(receipt.snapshot.id, 'snapshot identity', 256);
    if ((receipt.state === 'current' || receipt.state === 'stale') && receipt.snapshot.freshness !== receipt.state) {
      throw invalid(`Repository ${repositoryKey} snapshot freshness does not match its member state.`);
    }
  }
}

function validateCard(
  card: CodeGraphEvidenceCardV1,
  repositories: Readonly<Record<string, RepositoryEvidenceReceiptV1>>,
  refOwners: Map<string, string>,
): void {
  const receipt = evidenceRepository(repositories, card.repositoryKey, `card ${card.id}`);
  if (receipt.state !== 'current' && receipt.state !== 'stale') {
    throw invalid(`Evidence card ${card.id} references repository state ${receipt.state}.`);
  }
  if (
    receipt.snapshot === undefined ||
    card.id !== codeGraphEvidenceCardId(card.ref, receipt.snapshot.id, receipt.snapshot.worktreeId)
  ) {
    throw invalid(`Evidence card ${card.id} does not match its qualified reference and evidence snapshot.`);
  }
  ownRef(refOwners, card.ref, receipt.repositoryId);
  boundedText(card.symbol.name, 'symbol name', 512);
  boundedText(card.symbol.qualifiedName, 'qualified symbol name', 2_048);
  boundedText(card.symbol.kind, 'symbol kind', 128);
  boundedText(card.symbol.language, 'symbol language', 128);
  if (card.symbol.packageName !== undefined) boundedText(card.symbol.packageName, 'package name', 512);
  repositoryRelativePath(card.symbol.path, 'symbol path');
  validateSpan(card.symbol.span, `symbol ${card.symbol.qualifiedName}`);
  boundedText(card.reason.summary, 'evidence reason summary', 512);
  for (const signal of card.reason.signals) boundedText(signal, 'evidence reason signal', 128);
  assertUnique(card.reason.signals, `evidence reason signals for ${card.id}`);

  const relationshipKeys = new Set<string>();
  for (const relationship of card.relationships) {
    validateRelationship(card, relationship, repositories, refOwners);
    const key = relationshipKey(relationship);
    if (relationshipKeys.has(key)) throw invalid(`Evidence card ${card.id} contains a duplicate relationship.`);
    relationshipKeys.add(key);
  }
}

function validateRelationship(
  card: CodeGraphEvidenceCardV1,
  relationship: CompactEvidenceRelationshipV1,
  repositories: Readonly<Record<string, RepositoryEvidenceReceiptV1>>,
  refOwners: Map<string, string>,
): void {
  const authoritative = relationship.provenance === 'declared' || relationship.provenance === 'resolved';
  if ((relationship.authority === 'authoritative') !== authoritative) {
    throw invalid('Relationship authority must be authoritative exactly for declared or resolved provenance.');
  }
  if (relationship.source.ref !== card.ref && relationship.target.ref !== card.ref) {
    throw invalid(`Evidence card ${card.id} contains a relationship that is not adjacent to the card.`);
  }
  for (const endpoint of [relationship.source, relationship.target]) {
    const endpointReceipt = evidenceRepository(repositories, endpoint.repositoryKey, `relationship on card ${card.id}`);
    if (
      (endpointReceipt.state !== 'current' && endpointReceipt.state !== 'stale') ||
      endpointReceipt.snapshot === undefined
    ) {
      throw invalid(`Relationship endpoint ${endpoint.repositoryKey} on card ${card.id} has no usable snapshot.`);
    }
    ownRef(refOwners, endpoint.ref, endpointReceipt.repositoryId);
  }
  if (
    (relationship.source.ref === card.ref && relationship.source.repositoryKey !== card.repositoryKey) ||
    (relationship.target.ref === card.ref && relationship.target.repositoryKey !== card.repositoryKey)
  ) {
    throw invalid(`Evidence card ${card.id} reassigns its qualified reference to another repository.`);
  }
  const evidenceReceipt = evidenceRepository(
    repositories,
    relationship.evidence.repositoryKey,
    `relationship evidence on card ${card.id}`,
  );
  if (evidenceReceipt.state !== 'current' && evidenceReceipt.state !== 'stale') {
    throw invalid(`Relationship evidence on card ${card.id} does not name a usable snapshot.`);
  }
  if (
    relationship.evidence.repositoryKey !== relationship.source.repositoryKey &&
    relationship.evidence.repositoryKey !== relationship.target.repositoryKey
  ) {
    throw invalid(`Relationship evidence on card ${card.id} must belong to one endpoint repository.`);
  }
  repositoryRelativePath(relationship.evidence.path, 'relationship evidence path');
  validateSpan(relationship.evidence.span, `relationship on card ${card.id}`);
}

function validateCoverageBounds(coverage: WorksetCoverageV2): void {
  if (coverage.cataloguedRepositories > coverage.requestedRepositories) {
    throw invalid('Catalogued repositories cannot exceed requested repositories.');
  }
  if (coverage.consideredRepositories > coverage.cataloguedRepositories) {
    throw invalid('Considered repositories cannot exceed catalogued repositories.');
  }
  if (coverage.deepQueriedRepositories > coverage.consideredRepositories) {
    throw invalid('Deep-queried repositories cannot exceed considered repositories.');
  }
  const stateTotal = EffectArray.reduce(
    CODE_GRAPH_WORKSET_EVIDENCE_REPOSITORY_STATES,
    0,
    (total, state) => total + coverage.states[state],
  );
  if (stateTotal !== coverage.requestedRepositories) {
    throw invalid('Workset member-state counts must sum to requested repositories.');
  }
}

function referencedRepositoryKeys(cards: readonly CodeGraphEvidenceCardV1[]): Set<string> {
  const keys = new Set<string>();
  for (const card of cards) {
    keys.add(card.repositoryKey);
    for (const relationship of card.relationships) {
      keys.add(relationship.source.repositoryKey);
      keys.add(relationship.target.repositoryKey);
      keys.add(relationship.evidence.repositoryKey);
    }
  }
  return keys;
}

function evidenceRepository(
  repositories: Readonly<Record<string, RepositoryEvidenceReceiptV1>>,
  repositoryKey: string,
  context: string,
): RepositoryEvidenceReceiptV1 {
  if (!EffectRecord.has(repositories, repositoryKey)) {
    throw invalid(`Unknown repository key ${repositoryKey} referenced by ${context}.`);
  }
  const receipt = repositories[repositoryKey];
  if (receipt === undefined) throw invalid(`Unknown repository key ${repositoryKey} referenced by ${context}.`);
  return receipt;
}

function ownRef(owners: Map<string, string>, ref: string, repositoryId: string): void {
  const owner = owners.get(ref);
  if (owner !== undefined && owner !== repositoryId) {
    throw invalid(`Qualified reference ${ref} cannot belong to multiple repository identities.`);
  }
  owners.set(ref, repositoryId);
}

function relationshipKey(relationship: CompactEvidenceRelationshipV1): string {
  return EffectArray.join(
    EffectArray.map(
      [
        relationship.source.repositoryKey,
        relationship.source.ref,
        relationship.relation,
        relationship.target.repositoryKey,
        relationship.target.ref,
        relationship.provenance,
        relationship.evidence.repositoryKey,
        relationship.evidence.path,
        relationship.evidence.span.line,
        relationship.evidence.span.column,
      ],
      item => (item === null || item === undefined ? '' : String(item)),
    ),
    '\0',
  );
}

function projectionMaximumBytes(options: CodeGraphWorksetEvidenceProjectionOptionsV1): number {
  const tokens = options.maximumEstimatedTokens ?? CODE_GRAPH_WORKSET_EVIDENCE_DEFAULT_ESTIMATED_TOKENS;
  if (
    !Number.isSafeInteger(tokens) ||
    tokens < CODE_GRAPH_WORKSET_EVIDENCE_MINIMUM_ESTIMATED_TOKENS ||
    tokens > CODE_GRAPH_WORKSET_EVIDENCE_MAXIMUM_ESTIMATED_TOKENS
  ) {
    throw invalid(
      `Workset evidence token budget must be an integer from ${CODE_GRAPH_WORKSET_EVIDENCE_MINIMUM_ESTIMATED_TOKENS} to ${CODE_GRAPH_WORKSET_EVIDENCE_MAXIMUM_ESTIMATED_TOKENS}.`,
    );
  }
  const tokenBytes = tokens * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN;
  if (options.maximumBytes === undefined) return tokenBytes;
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1) {
    throw invalid('Workset evidence byte budget must be a positive safe integer.');
  }
  return Math.min(tokenBytes, options.maximumBytes);
}

function projectionOffsetBase(value: number | undefined): number {
  const offset = value ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > LIMITS.cards) {
    throw invalid('Workset evidence continuation offset is invalid.');
  }
  return offset;
}

function projectionTotalCards(value: number | undefined, loadedCards: number): number {
  const total = value ?? loadedCards;
  if (!Number.isSafeInteger(total) || total < loadedCards || total > LIMITS.cards) {
    throw invalid('Workset evidence total card count is invalid.');
  }
  return total;
}

function validateSpan(span: CodeGraphSpan, context: string): void {
  if (span.endLine < span.line || (span.endLine === span.line && span.endColumn < span.column)) {
    throw invalid(`Evidence span is reversed for ${context}.`);
  }
}

function repositoryRelativePath(value: string, label: string): string {
  const path = boundedText(value, label, 4_096);
  if (
    Effect.pipe(path, EffectString.startsWith('/')) ||
    Effect.pipe(path, EffectString.includes('\\')) ||
    /^[A-Za-z]:/u.test(path) ||
    EffectArray.some(
      Effect.pipe(path, EffectString.split('/')),
      segment => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw invalid(`Workset ${label} must be repository-relative and slash-normalized.`);
  }
  return path;
}

function boundedText(value: string, label: string, maximumBytes: number): string {
  if (
    EffectArray.some([...value], character => {
      const codePoint =
        Effect.pipe(
          character,
          EffectString.codePointAt(0),
          Effect.Option.getOrElse(() => undefined),
        ) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw invalid(`Workset ${label} is invalid or exceeds ${maximumBytes} UTF-8 bytes.`);
  }
  return value;
}

function assertQualifiedRef(value: string): void {
  if (!isCodeGraphQualifiedRefHandle(value)) throw invalid('Qualified code graph reference is invalid.');
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw invalid(`Duplicate ${label}.`);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): Error {
  return new Error(message);
}
