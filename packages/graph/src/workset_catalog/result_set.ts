import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  parseCodeGraphWorksetQueryResultV2,
  type CodeGraphEvidenceCardV1,
  type CodeGraphWorksetQueryResultV2,
  type CompactEvidenceRelationshipV1,
} from '../workset/evidence.js';
import {CODE_GRAPH_WORKSET_CATALOG_LIMITS, CodeGraphWorksetCatalogError} from './types.js';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const CARD_ID = /^cgec_[0-9a-f]{40}$/u;
const QUALIFIED_REF = /^cgr_[0-9a-f]{40}$/u;
const RESULT_SET_TOKEN = /^[0-9a-f]{64}$/u;

const PROVENANCES = ['declared', 'heuristic', 'model', 'resolved', 'syntactic'] as const;
const RELATIONS = [
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
] as const;

export interface PreparedCodeGraphWorksetResultCardV1 {
  readonly bytes: number;
  readonly card: CodeGraphEvidenceCardV1;
  readonly digest: string;
  readonly json: string;
  readonly referencedRepositories: ReadonlyMap<string, readonly string[]>;
}

export interface PreparedCodeGraphWorksetResultSequenceV1 {
  readonly cards: readonly PreparedCodeGraphWorksetResultCardV1[];
  readonly digest: string;
  readonly totalBytes: number;
}

export type CodeGraphWorksetResultEnvelopeV1 = Omit<CodeGraphWorksetQueryResultV2, 'cards'>;

export interface PreparedCodeGraphWorksetResultEnvelopeV1 {
  readonly bytes: number;
  readonly digest: string;
  readonly envelope: CodeGraphWorksetResultEnvelopeV1;
  readonly json: string;
  readonly result: CodeGraphWorksetQueryResultV2;
}

export function prepareCodeGraphWorksetResultEnvelope(
  input: CodeGraphWorksetQueryResultV2,
): PreparedCodeGraphWorksetResultEnvelopeV1 {
  let result: CodeGraphWorksetQueryResultV2;
  try {
    result = parseCodeGraphWorksetQueryResultV2(input);
  } catch (cause) {
    throw invalid('Workset result-set envelope is invalid.', cause);
  }
  const envelope = canonicalEnvelope(result);
  const json = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetBytesMaximum) {
    throw invalid('Workset result-set envelope exceeds the supported byte bound.');
  }
  return {bytes, digest: sha256HexSync(json), envelope, json, result};
}

export function decodeStoredCodeGraphWorksetResultEnvelope(
  json: string,
  expectedBytes: number,
  expectedDigest: string,
): CodeGraphWorksetResultEnvelopeV1 {
  if (
    Buffer.byteLength(json, 'utf8') !== expectedBytes ||
    expectedBytes < 1 ||
    expectedBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetBytesMaximum ||
    sha256HexSync(json) !== expectedDigest
  ) {
    throw corrupt('Stored workset result-set envelope integrity validation failed.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw corrupt('Stored workset result-set envelope JSON is invalid.', cause);
  }
  let result: CodeGraphWorksetQueryResultV2;
  try {
    result = parseCodeGraphWorksetQueryResultV2({...object(parsed, 'result-set envelope', 'corrupt'), cards: []});
  } catch (cause) {
    throw corrupt('Stored workset result-set envelope contract is invalid.', cause);
  }
  const envelope = canonicalEnvelope(result);
  if (JSON.stringify(envelope) !== json) throw corrupt('Stored workset result-set envelope is not canonical.');
  return envelope;
}

export function codeGraphWorksetPersistedResultDigest(envelopeDigest: string, cardsDigest: string): string {
  if (!EffectArray.every([envelopeDigest, cardsDigest], digest => /^[0-9a-f]{64}$/u.test(digest))) {
    throw invalid('Workset persisted result digest input is invalid.');
  }
  return sha256HexSync(`threadnote-code-graph-workset-persisted-result-v1\0${envelopeDigest}\0${cardsDigest}`);
}

export function prepareCodeGraphWorksetResultSequence(
  input: readonly CodeGraphEvidenceCardV1[],
): PreparedCodeGraphWorksetResultSequenceV1 {
  if (!EffectArray.isArray(input) || input.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetCardsMaximum) {
    throw invalid('Workset result-set card count exceeds the supported bound.');
  }
  const cards: PreparedCodeGraphWorksetResultCardV1[] = [];
  const cardIds = new Set<string>();
  let totalBytes = 0;
  for (const value of input) {
    const card = normalizeCard(value, 'invalid-input');
    if (cardIds.has(card.id)) throw invalid(`Workset result-set card ${card.id} is duplicated.`);
    cardIds.add(card.id);
    const referencedRepositories = cardRefOwners(card);
    const json = JSON.stringify(card);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetCardBytesMaximum) {
      throw invalid('A workset result-set card exceeds the supported byte bound.');
    }
    totalBytes += bytes;
    if (totalBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetBytesMaximum) {
      throw invalid('Workset result-set bytes exceed the supported bound.');
    }
    cards.push({bytes, card, digest: sha256HexSync(json), json, referencedRepositories});
  }
  return {
    cards,
    digest: codeGraphWorksetResultSequenceDigest(EffectArray.map(cards, card => card.digest)),
    totalBytes,
  };
}

export function codeGraphWorksetResultSequenceDigest(cardDigests: readonly string[]): string {
  if (EffectArray.some(cardDigests, digest => !/^[0-9a-f]{64}$/u.test(digest))) {
    throw invalid('Workset result-set card digest is invalid.');
  }
  return sha256HexSync(`threadnote-code-graph-workset-result-sequence-v1\0${EffectArray.join(cardDigests, '\0')}`);
}

export function decodeStoredCodeGraphWorksetResultCard(
  json: string,
  expectedBytes: number,
  expectedDigest: string,
): CodeGraphEvidenceCardV1 {
  if (
    Buffer.byteLength(json, 'utf8') !== expectedBytes ||
    expectedBytes < 1 ||
    expectedBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetCardBytesMaximum ||
    sha256HexSync(json) !== expectedDigest
  ) {
    throw corrupt('Stored workset result-set card integrity validation failed.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw corrupt('Stored workset result-set card JSON is invalid.', cause);
  }
  const card = normalizeCard(parsed, 'corrupt');
  if (JSON.stringify(card) !== json) {
    throw corrupt('Stored workset result-set card is not canonical.');
  }
  return card;
}

export function codeGraphWorksetResultSetId(resultSetToken: string): string {
  if (!RESULT_SET_TOKEN.test(resultSetToken)) throw invalid('Workset result-set token is invalid.');
  return `cgwrs_${Effect.pipe(sha256HexSync(`threadnote-code-graph-workset-result-set-v1\0${resultSetToken}`), EffectString.slice(0, 40))}`;
}

function canonicalEnvelope(result: CodeGraphWorksetQueryResultV2): CodeGraphWorksetResultEnvelopeV1 {
  const repositories = EffectRecord.fromEntries(
    EffectArray.map(
      EffectRecord.toEntries(result.repositories).sort(([left], [right]) => compareText(left, right)),
      ([repositoryKey, receipt]) => [
        repositoryKey,
        {
          considered: receipt.considered,
          deepQueried: receipt.deepQueried,
          repositoryId: receipt.repositoryId,
          ...(receipt.snapshot === undefined
            ? {}
            : {
                snapshot: {
                  checkoutId: receipt.snapshot.checkoutId,
                  commit: receipt.snapshot.commit,
                  digest: receipt.snapshot.digest,
                  dirty: receipt.snapshot.dirty,
                  freshness: receipt.snapshot.freshness,
                  id: receipt.snapshot.id,
                  projectionDigest: receipt.snapshot.projectionDigest,
                  provenance: receipt.snapshot.provenance,
                  worktreeId: receipt.snapshot.worktreeId,
                },
              }),
          state: receipt.state,
        },
      ],
    ),
  );
  return {
    coverage: {
      cataloguedRepositories: result.coverage.cataloguedRepositories,
      complete: result.coverage.complete,
      consideredRepositories: result.coverage.consideredRepositories,
      deepQueriedRepositories: result.coverage.deepQueriedRepositories,
      requestedRepositories: result.coverage.requestedRepositories,
      states: {
        current: result.coverage.states.current,
        deferred: result.coverage.states.deferred,
        excluded: result.coverage.states.excluded,
        failed: result.coverage.states.failed,
        missing: result.coverage.states.missing,
        stale: result.coverage.states.stale,
      },
      stopReason: result.coverage.stopReason,
    },
    repositories,
    trust: {
      classification: result.trust.classification,
      instructionPolicy: result.trust.instructionPolicy,
    },
    type: result.type,
    version: result.version,
    warnings: [...result.warnings],
    workset: {
      generation: {digest: result.workset.generation.digest, id: result.workset.generation.id},
      name: result.workset.name,
    },
  };
}

function normalizeCard(value: unknown, reason: 'corrupt' | 'invalid-input'): CodeGraphEvidenceCardV1 {
  const card = object(value, 'workset result-set card', reason);
  exactKeys(card, ['id', 'reason', 'ref', 'relationships', 'repositoryKey', 'symbol'], [], reason);
  const id = patternText(card.id, 'card identity', CARD_ID, 45, reason);
  const ref = patternText(card.ref, 'qualified reference', QUALIFIED_REF, 44, reason);
  const repositoryKey = repositoryKeyText(card.repositoryKey, reason);
  const symbol = object(card.symbol, 'card symbol', reason);
  exactKeys(symbol, ['kind', 'language', 'name', 'path', 'qualifiedName', 'span'], ['packageName'], reason);
  const normalizedSymbol = {
    kind: boundedText(symbol.kind, 'symbol kind', 128, reason),
    language: boundedText(symbol.language, 'symbol language', 128, reason),
    name: boundedText(symbol.name, 'symbol name', 512, reason),
    ...(symbol.packageName === undefined
      ? {}
      : {packageName: boundedText(symbol.packageName, 'package name', 512, reason)}),
    path: repositoryPath(symbol.path, 'symbol path', reason),
    qualifiedName: boundedText(symbol.qualifiedName, 'qualified symbol name', 2_048, reason),
    span: normalizeSpan(symbol.span, 'symbol span', reason),
  };
  const cardReason = object(card.reason, 'card reason', reason);
  exactKeys(cardReason, ['score', 'signals', 'summary'], [], reason);
  const signals = EffectArray.map(array(cardReason.signals, 'card reason signals', 16, reason), signal =>
    boundedText(signal, 'card reason signal', 128, reason),
  );
  if (new Set(signals).size !== signals.length) fail(reason, 'Workset result-set card reason signals are duplicated.');
  const relationships = EffectArray.map(array(card.relationships, 'card relationships', 32, reason), relationship =>
    normalizeRelationship(relationship, ref, repositoryKey, reason),
  );
  const relationshipKeys = EffectArray.map(relationships, relationshipKey);
  if (new Set(relationshipKeys).size !== relationshipKeys.length) {
    fail(reason, 'Workset result-set card relationships are duplicated.');
  }
  return {
    id,
    reason: {
      score: score(cardReason.score, 'card reason score', reason),
      signals,
      summary: boundedText(cardReason.summary, 'card reason summary', 512, reason),
    },
    ref,
    relationships,
    repositoryKey,
    symbol: normalizedSymbol,
  };
}

function normalizeRelationship(
  value: unknown,
  cardRef: string,
  cardRepositoryKey: string,
  reason: 'corrupt' | 'invalid-input',
): CompactEvidenceRelationshipV1 {
  const relationship = object(value, 'card relationship', reason);
  exactKeys(
    relationship,
    ['authority', 'confidence', 'evidence', 'provenance', 'relation', 'source', 'target'],
    [],
    reason,
  );
  const authority = literal(relationship.authority, ['authoritative', 'supporting'], 'relationship authority', reason);
  const provenance = literal(relationship.provenance, PROVENANCES, 'relationship provenance', reason);
  const authoritative = provenance === 'declared' || provenance === 'resolved';
  if ((authority === 'authoritative') !== authoritative) {
    fail(reason, 'Workset result-set relationship authority does not match provenance.');
  }
  const source = normalizeEndpoint(relationship.source, reason);
  const target = normalizeEndpoint(relationship.target, reason);
  if (source.ref !== cardRef && target.ref !== cardRef) {
    fail(reason, 'Workset result-set relationship is not adjacent to its card.');
  }
  if (
    (source.ref === cardRef && source.repositoryKey !== cardRepositoryKey) ||
    (target.ref === cardRef && target.repositoryKey !== cardRepositoryKey)
  ) {
    fail(reason, 'Workset result-set relationship reassigns its card reference.');
  }
  const evidence = object(relationship.evidence, 'relationship evidence', reason);
  exactKeys(evidence, ['path', 'repositoryKey', 'span'], [], reason);
  const evidenceRepositoryKey = repositoryKeyText(evidence.repositoryKey, reason);
  if (evidenceRepositoryKey !== source.repositoryKey && evidenceRepositoryKey !== target.repositoryKey) {
    fail(reason, 'Workset result-set relationship evidence does not belong to an endpoint repository.');
  }
  return {
    authority,
    confidence: score(relationship.confidence, 'relationship confidence', reason),
    evidence: {
      path: repositoryPath(evidence.path, 'relationship evidence path', reason),
      repositoryKey: evidenceRepositoryKey,
      span: normalizeSpan(evidence.span, 'relationship evidence span', reason),
    },
    provenance,
    relation: literal(relationship.relation, RELATIONS, 'relationship relation', reason),
    source,
    target,
  };
}

function normalizeEndpoint(value: unknown, reason: 'corrupt' | 'invalid-input') {
  const endpoint = object(value, 'relationship endpoint', reason);
  exactKeys(endpoint, ['ref', 'repositoryKey'], [], reason);
  return {
    ref: patternText(endpoint.ref, 'qualified reference', QUALIFIED_REF, 44, reason),
    repositoryKey: repositoryKeyText(endpoint.repositoryKey, reason),
  };
}

function normalizeSpan(value: unknown, label: string, reason: 'corrupt' | 'invalid-input') {
  const span = object(value, label, reason);
  exactKeys(span, ['column', 'endColumn', 'endLine', 'line'], [], reason);
  const normalized = {
    column: nonNegativeInteger(span.column, `${label} column`, reason),
    endColumn: nonNegativeInteger(span.endColumn, `${label} end column`, reason),
    endLine: nonNegativeInteger(span.endLine, `${label} end line`, reason),
    line: nonNegativeInteger(span.line, `${label} line`, reason),
  };
  if (
    normalized.endLine < normalized.line ||
    (normalized.endLine === normalized.line && normalized.endColumn < normalized.column)
  ) {
    fail(reason, `Workset result-set ${label} is reversed.`);
  }
  return normalized;
}

function cardRefOwners(card: CodeGraphEvidenceCardV1): ReadonlyMap<string, readonly string[]> {
  const owners = new Map<string, Set<string>>();
  addRefOwner(owners, card.ref, card.repositoryKey);
  for (const relationship of card.relationships) {
    addRefOwner(owners, relationship.source.ref, relationship.source.repositoryKey);
    addRefOwner(owners, relationship.target.ref, relationship.target.repositoryKey);
  }
  return new Map(EffectArray.map([...owners], ([ref, keys]) => [ref, [...keys].sort(compareText)] as const));
}

function addRefOwner(owners: Map<string, Set<string>>, ref: string, repositoryKey: string): void {
  const existing = owners.get(ref) ?? new Set<string>();
  existing.add(repositoryKey);
  owners.set(ref, existing);
}

function relationshipKey(relationship: CompactEvidenceRelationshipV1): string {
  return EffectArray.join(
    EffectArray.map(
      [
        relationship.source.ref,
        relationship.source.repositoryKey,
        relationship.relation,
        relationship.target.ref,
        relationship.target.repositoryKey,
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

function repositoryKeyText(value: unknown, reason: 'corrupt' | 'invalid-input'): string {
  const key = boundedText(value, 'repository key', 256, reason);
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    fail(reason, 'Workset result-set repository key is reserved.');
  }
  return key;
}

function repositoryPath(value: unknown, label: string, reason: 'corrupt' | 'invalid-input'): string {
  const path = boundedText(value, label, 4_096, reason);
  if (
    Effect.pipe(path, EffectString.startsWith('/')) ||
    Effect.pipe(path, EffectString.includes('\\')) ||
    /^[A-Za-z]:/u.test(path) ||
    EffectArray.some(
      Effect.pipe(path, EffectString.split('/')),
      segment => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    fail(reason, `Workset result-set ${label} is not repository-relative.`);
  }
  return path;
}

function boundedText(value: unknown, label: string, maximumBytes: number, reason: 'corrupt' | 'invalid-input'): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    EffectArray.some([...value], character => {
      const point =
        Effect.pipe(
          character,
          EffectString.codePointAt(0),
          Effect.Option.getOrElse(() => undefined),
        ) ?? 0;
      return point <= 0x1f || point === 0x7f;
    })
  ) {
    fail(reason, `Workset result-set ${label} is invalid.`);
  }
  return value;
}

function patternText(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximumBytes: number,
  reason: 'corrupt' | 'invalid-input',
): string {
  const text = boundedText(value, label, maximumBytes, reason);
  if (!pattern.test(text)) fail(reason, `Workset result-set ${label} is invalid.`);
  return text;
}

function nonNegativeInteger(value: unknown, label: string, reason: 'corrupt' | 'invalid-input'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(reason, `Workset result-set ${label} is invalid.`);
  }
  return value;
}

function score(value: unknown, label: string, reason: 'corrupt' | 'invalid-input'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(reason, `Workset result-set ${label} is invalid.`);
  }
  return value;
}

function literal<const T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
  reason: 'corrupt' | 'invalid-input',
): T {
  if (typeof value !== 'string') {
    fail(reason, `Workset result-set ${label} is invalid.`);
  }
  for (const candidate of values) {
    if (value === candidate) return candidate;
  }
  fail(reason, `Workset result-set ${label} is invalid.`);
}

function array(
  value: unknown,
  label: string,
  maximumLength: number,
  reason: 'corrupt' | 'invalid-input',
): readonly unknown[] {
  if (!EffectArray.isArray(value) || value.length > maximumLength) {
    fail(reason, `Workset result-set ${label} is invalid.`);
  }
  return value;
}

function object(value: unknown, label: string, reason: 'corrupt' | 'invalid-input'): Record<string, unknown> {
  if (!Predicate.isObject(value)) {
    fail(reason, `Workset result-set ${label} is invalid.`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  reason: 'corrupt' | 'invalid-input',
): void {
  const keys = EffectRecord.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    EffectArray.some(required, key => !EffectRecord.has(value, key)) ||
    EffectArray.some(keys, key => !allowed.has(key))
  ) {
    fail(reason, 'Workset result-set card contains missing or unsupported fields.');
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(reason: 'corrupt' | 'invalid-input', message: string): never {
  throw CodeGraphWorksetCatalogError.of(reason, message);
}

function invalid(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('invalid-input', message, cause === undefined ? undefined : {cause});
}

function corrupt(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('corrupt', message, cause === undefined ? undefined : {cause});
}
