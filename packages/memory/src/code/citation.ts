import {Predicate, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';

export const MEMORY_SCHEMA_VERSION = 7 as const;
export const MEMORY_CODE_CITATION_SCHEMA_VERSION = 4 as const;
export const MEMORY_CODE_CITATION_VERSION = 1 as const;
export const MEMORY_CODE_CITATION_HEADER = 'code_citation' as const;
export const MAX_MEMORY_CODE_CITATIONS = 8 as const;
export const MAX_MEMORY_CODE_CITATION_ENTRY_BYTES = 8 * 1_024;
export const MAX_MEMORY_CODE_CITATION_AGGREGATE_BYTES = 64 * 1_024;

export type MemoryCodeCitationRepositoryIdentityKind = 'local' | 'remote';
export type MemoryCodeCitationFragmentCanonicalization = 'utf8-source-span-v1';

export interface MemoryCodeCitationSha256V1 {
  readonly algorithm: 'sha256';
  readonly value: string;
}

export interface MemoryCodeCitationSpanV1 {
  /** One-based UTF-16 column. */
  readonly column: number;
  /** One-based exclusive UTF-16 column. */
  readonly endColumn: number;
  /** One-based line. */
  readonly endLine: number;
  /** One-based line. */
  readonly line: number;
}

export interface MemoryCodeCitationFileTargetV1 {
  readonly kind: 'file';
}

export interface MemoryCodeCitationSymbolTargetV1 {
  readonly fragmentCanonicalization: MemoryCodeCitationFragmentCanonicalization;
  readonly fragmentHash: MemoryCodeCitationSha256V1;
  readonly kind: 'symbol';
  readonly language: string;
  readonly name: string;
  readonly nodeId: string;
  readonly qualifiedName: string;
  readonly signatureHash?: MemoryCodeCitationSha256V1;
  readonly span: MemoryCodeCitationSpanV1;
  readonly symbolKind: string;
}

export type MemoryCodeCitationTargetV1 = MemoryCodeCitationFileTargetV1 | MemoryCodeCitationSymbolTargetV1;

/** Immutable capture-time evidence. Current validation state belongs in a separate receipt. */
export interface MemoryCodeCitationV1 {
  /** Original citation identity, preserved when this logical anchor is replaced. */
  readonly anchorId?: string;
  /** Capture-time diagnostic only: bounded capsules can later expire or be evicted. */
  readonly evidenceRetention?: 'capsule-retained' | 'unavailable';
  readonly extractorSet: string;
  readonly fileContentHash: MemoryCodeCitationSha256V1;
  readonly id: string;
  readonly path: string;
  readonly repositoryId: string;
  readonly repositoryIdentityKind: MemoryCodeCitationRepositoryIdentityKind;
  readonly sourceCommit: string;
  readonly sourceDirty: boolean;
  readonly sourceGraphContentId?: string;
  readonly sourceSnapshotId: string;
  readonly target: MemoryCodeCitationTargetV1;
  readonly version: typeof MEMORY_CODE_CITATION_VERSION;
}

export type MemoryCodeCitationInputV1 = Omit<MemoryCodeCitationV1, 'id'>;

export type MemoryCodeCitationErrorReason =
  | 'aggregate-too-large'
  | 'duplicate-id'
  | 'entry-too-large'
  | 'id-mismatch'
  | 'invalid-json'
  | 'invalid-shape'
  | 'non-canonical'
  | 'schema-version-mismatch'
  | 'too-many-citations'
  | 'unsupported-version';

export interface MemoryCodeCitationError {
  /** Zero-based citation-header ordinal; absent for a document-level error. */
  readonly index?: number;
  readonly reason: MemoryCodeCitationErrorReason;
}

export type MemoryCodeCitationParseResult =
  | {readonly citation: MemoryCodeCitationV1; readonly ok: true}
  | {readonly error: MemoryCodeCitationError; readonly ok: false};

export interface ParsedMemoryCodeCitations {
  readonly citations?: readonly MemoryCodeCitationV1[];
  readonly errors?: readonly MemoryCodeCitationError[];
}

export class MemoryCodeCitationValidationError extends Schema.TaggedError<MemoryCodeCitationValidationError>()(
  'MemoryCodeCitationValidationError',
  {
    message: Schema.String,
    reason: Schema.Literals([
      'aggregate-too-large',
      'duplicate-id',
      'entry-too-large',
      'id-mismatch',
      'invalid-json',
      'invalid-shape',
      'non-canonical',
      'schema-version-mismatch',
      'too-many-citations',
      'unsupported-version',
    ]),
  },
) {
  static of(reason: MemoryCodeCitationErrorReason): MemoryCodeCitationValidationError {
    return MemoryCodeCitationValidationError.make({
      message: CITATION_ERROR_MESSAGES[reason],
      reason,
    });
  }
}

export class UnsupportedMemorySchemaVersionError extends Schema.TaggedError<UnsupportedMemorySchemaVersionError>()(
  'UnsupportedMemorySchemaVersionError',
  {
    message: Schema.String,
    schemaVersion: Schema.Finite,
  },
) {
  static of(schemaVersion: number): UnsupportedMemorySchemaVersionError {
    return UnsupportedMemorySchemaVersionError.make({
      message: `Memory schema version ${schemaVersion} is newer than supported version ${MEMORY_SCHEMA_VERSION}.`,
      schemaVersion,
    });
  }
}

const CITATION_ERROR_MESSAGES: Readonly<Record<MemoryCodeCitationErrorReason, string>> = {
  'aggregate-too-large': 'Memory code-citation metadata exceeds the aggregate byte limit.',
  'duplicate-id': 'Memory code citations must have unique derived identities.',
  'entry-too-large': 'Memory code-citation metadata exceeds the per-entry byte limit.',
  'id-mismatch': 'Memory code-citation identity does not match its canonical evidence.',
  'invalid-json': 'Memory code-citation metadata is not valid JSON.',
  'invalid-shape': 'Memory code-citation metadata has an invalid shape.',
  'non-canonical': 'Memory code-citation metadata is not canonically encoded.',
  'schema-version-mismatch': `Memory code citations require memory schema version ${MEMORY_SCHEMA_VERSION}.`,
  'too-many-citations': `A memory may contain at most ${MAX_MEMORY_CODE_CITATIONS} code citations.`,
  'unsupported-version': 'Memory code-citation metadata uses an unsupported version.',
};

const encoder = new TextEncoder();
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;
const GRAPH_CONTENT_ID = /^(?:cgc_[0-9a-f]{40}|cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?)$/u;
const NODE_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CITATION_ID = /^tncc_[0-9a-f]{40}$/u;
const CODE_CITATION_PREFIX = `${MEMORY_CODE_CITATION_HEADER}: `;

export function canWriteMemorySchemaVersion(schemaVersion: number | undefined): boolean {
  return (
    schemaVersion === undefined ||
    (Number.isSafeInteger(schemaVersion) && schemaVersion > 0 && schemaVersion <= MEMORY_SCHEMA_VERSION)
  );
}

/** Code-citation v1 remains readable across the additive memory-schema v4→v5 migration. */
export function isMemoryCodeCitationSchemaVersion(schemaVersion: number | undefined): boolean {
  return (
    schemaVersion === MEMORY_CODE_CITATION_SCHEMA_VERSION ||
    schemaVersion === 5 ||
    schemaVersion === 6 ||
    schemaVersion === MEMORY_SCHEMA_VERSION
  );
}

/** Writers call this before reformatting an existing record so future fields cannot be dropped. */
export function assertMemorySchemaWritable(schemaVersion: number | undefined): void {
  if (schemaVersion !== undefined && (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0)) {
    throw new Error('Memory schema version must be a positive safe integer.');
  }
  if (schemaVersion !== undefined && schemaVersion > MEMORY_SCHEMA_VERSION) {
    throw UnsupportedMemorySchemaVersionError.of(schemaVersion);
  }
}

export function createMemoryCodeCitation(input: MemoryCodeCitationInputV1): MemoryCodeCitationV1 {
  const validated = validateCitationInput(input);
  const citation = freezeCitation({
    version: MEMORY_CODE_CITATION_VERSION,
    id: deriveCitationIdFromValidatedInput(validated),
    ...(validated.anchorId === undefined ? {} : {anchorId: validated.anchorId}),
    ...(validated.evidenceRetention === undefined ? {} : {evidenceRetention: validated.evidenceRetention}),
    repositoryId: validated.repositoryId,
    repositoryIdentityKind: validated.repositoryIdentityKind,
    sourceCommit: validated.sourceCommit,
    sourceSnapshotId: validated.sourceSnapshotId,
    sourceDirty: validated.sourceDirty,
    ...(validated.sourceGraphContentId === undefined ? {} : {sourceGraphContentId: validated.sourceGraphContentId}),
    extractorSet: validated.extractorSet,
    path: validated.path,
    fileContentHash: validated.fileContentHash,
    target: validated.target,
  });
  if (citationLineBytes(JSON.stringify(citationWire(citation))) > MAX_MEMORY_CODE_CITATION_ENTRY_BYTES) {
    throw citationError('entry-too-large');
  }
  return citation;
}

export function deriveMemoryCodeCitationId(input: MemoryCodeCitationInputV1): string {
  return deriveCitationIdFromValidatedInput(validateCitationInput(input));
}

export function memoryCodeCitationAnchorId(citation: Pick<MemoryCodeCitationV1, 'id' | 'anchorId'>): string {
  return exactString(citation.anchorId ?? citation.id, 45, CITATION_ID);
}

/** Evidence identity stays capture-derived; replacement carries the original logical anchor. */
export function preserveMemoryCodeCitationAnchor(
  current: MemoryCodeCitationV1,
  replacement: MemoryCodeCitationV1,
): MemoryCodeCitationV1 {
  const original = assertMemoryCodeCitation(current);
  const next = assertMemoryCodeCitation(replacement);
  const anchorId = memoryCodeCitationAnchorId(original);
  if (next.anchorId !== undefined && next.anchorId !== anchorId) throw citationError('id-mismatch');
  return assertMemoryCodeCitation({...next, anchorId});
}

export function assertMemoryCodeCitation(value: unknown): MemoryCodeCitationV1 {
  const record = requiredRecord(value);
  assertExactKeys(record, citationRootKeys(record));
  if (record.version !== MEMORY_CODE_CITATION_VERSION) {
    throw citationError('unsupported-version');
  }
  if (typeof record.id !== 'string' || !CITATION_ID.test(record.id)) {
    throw citationError('invalid-shape');
  }
  const input = validateCitationInput({
    version: record.version,
    ...(hasOwn(record, 'anchorId') ? {anchorId: record.anchorId} : {}),
    ...(hasOwn(record, 'evidenceRetention') ? {evidenceRetention: record.evidenceRetention} : {}),
    repositoryId: record.repositoryId,
    repositoryIdentityKind: record.repositoryIdentityKind,
    sourceCommit: record.sourceCommit,
    sourceSnapshotId: record.sourceSnapshotId,
    sourceDirty: record.sourceDirty,
    ...(hasOwn(record, 'sourceGraphContentId') ? {sourceGraphContentId: record.sourceGraphContentId} : {}),
    extractorSet: record.extractorSet,
    path: record.path,
    fileContentHash: record.fileContentHash,
    target: record.target,
  });
  if (record.id !== deriveCitationIdFromValidatedInput(input)) {
    throw citationError('id-mismatch');
  }
  return freezeCitation({
    version: MEMORY_CODE_CITATION_VERSION,
    id: record.id,
    ...(input.anchorId === undefined ? {} : {anchorId: input.anchorId}),
    ...(input.evidenceRetention === undefined ? {} : {evidenceRetention: input.evidenceRetention}),
    repositoryId: input.repositoryId,
    repositoryIdentityKind: input.repositoryIdentityKind,
    sourceCommit: input.sourceCommit,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceDirty: input.sourceDirty,
    ...(input.sourceGraphContentId === undefined ? {} : {sourceGraphContentId: input.sourceGraphContentId}),
    extractorSet: input.extractorSet,
    path: input.path,
    fileContentHash: input.fileContentHash,
    target: input.target,
  });
}

export function formatMemoryCodeCitation(citation: MemoryCodeCitationV1): string {
  const canonical = JSON.stringify(citationWire(assertMemoryCodeCitation(citation)));
  if (citationLineBytes(canonical) > MAX_MEMORY_CODE_CITATION_ENTRY_BYTES) {
    throw citationError('entry-too-large');
  }
  return canonical;
}

export function formatMemoryCodeCitationLines(citations: readonly MemoryCodeCitationV1[]): readonly string[] {
  if (citations.length > MAX_MEMORY_CODE_CITATIONS) {
    throw citationError('too-many-citations');
  }
  const seen = new Set<string>();
  const anchors = new Set<string>();
  const lines = citations.map(citation => {
    const canonical = formatMemoryCodeCitation(citation);
    const id = assertMemoryCodeCitation(citation).id;
    const anchorId = memoryCodeCitationAnchorId(citation);
    if (seen.has(id) || anchors.has(anchorId)) throw citationError('duplicate-id');
    seen.add(id);
    anchors.add(anchorId);
    return `${CODE_CITATION_PREFIX}${canonical}`;
  });
  if (aggregateLineBytes(lines) > MAX_MEMORY_CODE_CITATION_AGGREGATE_BYTES) {
    throw citationError('aggregate-too-large');
  }
  return Object.freeze(lines);
}

export function parseMemoryCodeCitation(value: string): MemoryCodeCitationParseResult {
  if (citationLineBytes(value) > MAX_MEMORY_CODE_CITATION_ENTRY_BYTES) {
    return {error: {reason: 'entry-too-large'}, ok: false};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return {error: {reason: 'invalid-json'}, ok: false};
  }
  if (isPlainObject(parsed) && hasOwn(parsed, 'version') && parsed.version !== MEMORY_CODE_CITATION_VERSION) {
    return {error: {reason: 'unsupported-version'}, ok: false};
  }
  try {
    const citation = assertMemoryCodeCitation(parsed);
    if (formatMemoryCodeCitation(citation) !== value) {
      return {error: {reason: 'non-canonical'}, ok: false};
    }
    return {citation, ok: true};
  } catch (error) {
    return {
      error: {reason: Schema.is(MemoryCodeCitationValidationError)(error) ? error.reason : 'invalid-shape'},
      ok: false,
    };
  }
}

export function parseMemoryCodeCitationHeaders(
  values: readonly string[] | undefined,
  schemaVersion: number | undefined,
): ParsedMemoryCodeCitations {
  if (!values || values.length === 0) return {};
  const citations: MemoryCodeCitationV1[] = [];
  const errors: MemoryCodeCitationError[] = [];
  if (!isMemoryCodeCitationSchemaVersion(schemaVersion)) {
    errors.push({reason: 'schema-version-mismatch'});
  }
  if (values.length > MAX_MEMORY_CODE_CITATIONS) {
    errors.push({index: MAX_MEMORY_CODE_CITATIONS, reason: 'too-many-citations'});
  }
  if (aggregateCitationValueBytes(values) > MAX_MEMORY_CODE_CITATION_AGGREGATE_BYTES) {
    errors.push({reason: 'aggregate-too-large'});
  }
  const seen = new Set<string>();
  const anchors = new Set<string>();
  for (const [index, value] of values.slice(0, MAX_MEMORY_CODE_CITATIONS).entries()) {
    const result = parseMemoryCodeCitation(value);
    if (!result.ok) {
      errors.push({...result.error, index});
      continue;
    }
    const anchorId = memoryCodeCitationAnchorId(result.citation);
    if (seen.has(result.citation.id) || anchors.has(anchorId)) {
      errors.push({index, reason: 'duplicate-id'});
      continue;
    }
    seen.add(result.citation.id);
    anchors.add(anchorId);
    citations.push(result.citation);
  }
  return {
    ...(citations.length === 0 ? {} : {citations: Object.freeze(citations)}),
    ...(errors.length === 0 ? {} : {errors: Object.freeze(errors)}),
  };
}

function validateCitationInput(value: unknown): MemoryCodeCitationInputV1 {
  const record = requiredRecord(value);
  assertExactKeys(record, citationInputKeys(record));
  const anchorId = hasOwn(record, 'anchorId') ? exactString(record.anchorId, 45, CITATION_ID) : undefined;
  const evidenceRetention = !hasOwn(record, 'evidenceRetention')
    ? undefined
    : record.evidenceRetention === 'capsule-retained' || record.evidenceRetention === 'unavailable'
      ? record.evidenceRetention
      : invalidShape();
  if (record.version !== MEMORY_CODE_CITATION_VERSION) throw citationError('unsupported-version');
  const repositoryId = exactString(record.repositoryId, 64, SHA256);
  const repositoryIdentityKind =
    record.repositoryIdentityKind === 'local' || record.repositoryIdentityKind === 'remote'
      ? record.repositoryIdentityKind
      : invalidShape();
  const sourceCommit = exactString(record.sourceCommit, 64, GIT_COMMIT);
  const sourceSnapshotId = exactString(record.sourceSnapshotId, 69, SNAPSHOT_ID);
  if (typeof record.sourceDirty !== 'boolean') throw citationError('invalid-shape');
  const sourceGraphContentId = hasOwn(record, 'sourceGraphContentId')
    ? exactString(record.sourceGraphContentId, 69, GRAPH_CONTENT_ID)
    : undefined;
  const extractorSet = boundedText(record.extractorSet, 4_096);
  const path = repositoryPath(record.path);
  const fileContentHash = sha256(record.fileContentHash);
  const target = citationTarget(record.target);
  return freezeCitationInput({
    version: MEMORY_CODE_CITATION_VERSION,
    ...(anchorId === undefined ? {} : {anchorId}),
    ...(evidenceRetention === undefined ? {} : {evidenceRetention}),
    repositoryId,
    repositoryIdentityKind,
    sourceCommit,
    sourceSnapshotId,
    sourceDirty: record.sourceDirty,
    ...(sourceGraphContentId === undefined ? {} : {sourceGraphContentId}),
    extractorSet,
    path,
    fileContentHash,
    target,
  });
}

function citationTarget(value: unknown): MemoryCodeCitationTargetV1 {
  const record = requiredRecord(value);
  if (record.kind === 'file') {
    assertExactKeys(record, ['kind']);
    return Object.freeze({kind: 'file'});
  }
  if (record.kind !== 'symbol') throw citationError('invalid-shape');
  assertExactKeys(record, symbolTargetKeys(record));
  const nodeId = exactString(record.nodeId, 68, NODE_ID);
  const language = boundedText(record.language, 128);
  const symbolKind = boundedText(record.symbolKind, 128);
  const name = boundedText(record.name, 512);
  const qualifiedName = boundedText(record.qualifiedName, 2_048);
  const signatureHash = hasOwn(record, 'signatureHash') ? sha256(record.signatureHash) : undefined;
  const span = citationSpan(record.span);
  const fragmentHash = sha256(record.fragmentHash);
  if (record.fragmentCanonicalization !== 'utf8-source-span-v1') throw citationError('invalid-shape');
  return Object.freeze({
    kind: 'symbol',
    nodeId,
    language,
    symbolKind,
    name,
    qualifiedName,
    ...(signatureHash === undefined ? {} : {signatureHash}),
    span,
    fragmentHash,
    fragmentCanonicalization: 'utf8-source-span-v1',
  });
}

function citationSpan(value: unknown): MemoryCodeCitationSpanV1 {
  const record = requiredRecord(value);
  assertExactKeys(record, ['line', 'column', 'endLine', 'endColumn']);
  const line = boundedInteger(record.line, 1);
  const column = boundedInteger(record.column, 1);
  const endLine = boundedInteger(record.endLine, 1);
  const endColumn = boundedInteger(record.endColumn, 1);
  if (endLine < line || (endLine === line && endColumn <= column)) throw citationError('invalid-shape');
  return Object.freeze({line, column, endLine, endColumn});
}

function sha256(value: unknown): MemoryCodeCitationSha256V1 {
  const record = requiredRecord(value);
  assertExactKeys(record, ['algorithm', 'value']);
  if (record.algorithm !== 'sha256') throw citationError('invalid-shape');
  return Object.freeze({algorithm: 'sha256', value: exactString(record.value, 64, SHA256)});
}

function citationWire(citation: MemoryCodeCitationV1): Record<string, unknown> {
  return {
    version: citation.version,
    id: citation.id,
    ...(citation.anchorId === undefined ? {} : {anchorId: citation.anchorId}),
    ...(citation.evidenceRetention === undefined ? {} : {evidenceRetention: citation.evidenceRetention}),
    repositoryId: citation.repositoryId,
    repositoryIdentityKind: citation.repositoryIdentityKind,
    sourceCommit: citation.sourceCommit,
    sourceSnapshotId: citation.sourceSnapshotId,
    sourceDirty: citation.sourceDirty,
    ...(citation.sourceGraphContentId === undefined ? {} : {sourceGraphContentId: citation.sourceGraphContentId}),
    extractorSet: citation.extractorSet,
    path: citation.path,
    fileContentHash: hashWire(citation.fileContentHash),
    target: targetWire(citation.target),
  };
}

function citationIdentityWire(input: MemoryCodeCitationInputV1): Record<string, unknown> {
  return {
    version: input.version,
    repositoryId: input.repositoryId,
    repositoryIdentityKind: input.repositoryIdentityKind,
    sourceCommit: input.sourceCommit,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceDirty: input.sourceDirty,
    ...(input.sourceGraphContentId === undefined ? {} : {sourceGraphContentId: input.sourceGraphContentId}),
    extractorSet: input.extractorSet,
    path: input.path,
    fileContentHash: hashWire(input.fileContentHash),
    target: targetWire(input.target),
  };
}

function hashWire(hash: MemoryCodeCitationSha256V1): Record<string, unknown> {
  return {algorithm: hash.algorithm, value: hash.value};
}

function targetWire(target: MemoryCodeCitationTargetV1): Record<string, unknown> {
  if (target.kind === 'file') return {kind: 'file'};
  return {
    kind: 'symbol',
    nodeId: target.nodeId,
    language: target.language,
    symbolKind: target.symbolKind,
    name: target.name,
    qualifiedName: target.qualifiedName,
    ...(target.signatureHash === undefined ? {} : {signatureHash: hashWire(target.signatureHash)}),
    span: {
      line: target.span.line,
      column: target.span.column,
      endLine: target.span.endLine,
      endColumn: target.span.endColumn,
    },
    fragmentHash: hashWire(target.fragmentHash),
    fragmentCanonicalization: target.fragmentCanonicalization,
  };
}

function deriveCitationIdFromValidatedInput(input: MemoryCodeCitationInputV1): string {
  const identity = JSON.stringify(citationIdentityWire(input));
  return `tncc_${sha256HexSync(`threadnote-memory-code-citation-v1\0${identity}`).slice(0, 40)}`;
}

function citationRootKeys(record: Record<string, unknown>): readonly string[] {
  return [
    'version',
    'id',
    ...(hasOwn(record, 'anchorId') ? ['anchorId'] : []),
    ...(hasOwn(record, 'evidenceRetention') ? ['evidenceRetention'] : []),
    'repositoryId',
    'repositoryIdentityKind',
    'sourceCommit',
    'sourceSnapshotId',
    'sourceDirty',
    ...(hasOwn(record, 'sourceGraphContentId') ? ['sourceGraphContentId'] : []),
    'extractorSet',
    'path',
    'fileContentHash',
    'target',
  ];
}

function citationInputKeys(record: Record<string, unknown>): readonly string[] {
  return citationRootKeys(record).filter(key => key !== 'id');
}

function symbolTargetKeys(record: Record<string, unknown>): readonly string[] {
  return [
    'kind',
    'nodeId',
    'language',
    'symbolKind',
    'name',
    'qualifiedName',
    ...(hasOwn(record, 'signatureHash') ? ['signatureHash'] : []),
    'span',
    'fragmentHash',
    'fragmentCanonicalization',
  ];
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Reflect.ownKeys(record);
  if (
    actual.length !== expected.length ||
    actual.some(key => typeof key !== 'string') ||
    expected.some(key => !hasOwn(record, key))
  ) {
    throw citationError('invalid-shape');
  }
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw citationError('invalid-shape');
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!Predicate.isObject(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function exactString(value: unknown, maximumBytes: number, pattern: RegExp): string {
  const text = boundedText(value, maximumBytes);
  if (!pattern.test(text)) throw citationError('invalid-shape');
  return text;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maximumBytes ||
    hasControlCharacter(value)
  ) {
    throw citationError('invalid-shape');
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f || codeUnit === 0x85 || codeUnit === 0x2028 || codeUnit === 0x2029) {
      return true;
    }
  }
  return false;
}

function repositoryPath(value: unknown): string {
  const path = boundedText(value, 4_096);
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw citationError('invalid-shape');
  }
  return path;
}

function boundedInteger(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 1_000_000_000) {
    throw citationError('invalid-shape');
  }
  return value;
}

function invalidShape(): never {
  throw citationError('invalid-shape');
}

function citationError(reason: MemoryCodeCitationErrorReason): MemoryCodeCitationValidationError {
  return MemoryCodeCitationValidationError.of(reason);
}

function citationLineBytes(json: string): number {
  return encoder.encode(`${CODE_CITATION_PREFIX}${json}`).byteLength;
}

function aggregateLineBytes(lines: readonly string[]): number {
  let bytes = 0;
  for (const [index, line] of lines.entries()) {
    bytes += encoder.encode(line).byteLength + (index === 0 ? 0 : 1);
    if (bytes > MAX_MEMORY_CODE_CITATION_AGGREGATE_BYTES) return bytes;
  }
  return bytes;
}

function aggregateCitationValueBytes(values: readonly string[]): number {
  let bytes = 0;
  for (const [index, value] of values.entries()) {
    bytes += citationLineBytes(value) + (index === 0 ? 0 : 1);
    if (bytes > MAX_MEMORY_CODE_CITATION_AGGREGATE_BYTES) return bytes;
  }
  return bytes;
}

function freezeCitationInput(input: MemoryCodeCitationInputV1): MemoryCodeCitationInputV1 {
  return Object.freeze(input);
}

function freezeCitation(citation: MemoryCodeCitationV1): MemoryCodeCitationV1 {
  return Object.freeze(citation);
}
