/* oxlint-disable no-unused-vars, no-empty, effecttsgo/effect-fn-implicit-any, effecttsgo/unknown-in-effect-catch -- Frozen bundled legacy reader must preserve historical code; TypeScript annotations were erased by bundling. */
// Frozen actual candidate reader from HEAD724cc6def34c1fd9630d309e8f9c9e9ff7096814.
// Built from git-archived memory source, never current candidate logic. External platform dependencies are unchanged; envelope rejection executes before payload decoding.
// packages/memory/src/candidate.ts
import {Clock, Crypto, Effect, FileSystem, Option, Path, Schema as Schema4} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {safeChildDirectoryNames, scanFilesWithinBoundary} from '@threadnote/platform/safe_scan';
import {parseMarkdownHeadingLine} from '@threadnote/platform/string-boundaries';
import {uriSegment} from '@threadnote/workspace/manifest';
import {
  canonicalMemoryDocumentContent as canonicalMemoryDocumentContent2,
  parseMemoryDocument as parseMemoryDocument2,
} from '@threadnote/memory/document';
import {
  assertMemoryCodeCitation as assertMemoryCodeCitation2,
  formatMemoryCodeCitationLines as formatMemoryCodeCitationLines2,
} from '@threadnote/memory/code/citation';

// packages/memory/src/topic-maintenance-generation.ts
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
var MAX_TOPIC_GENERATION_RECEIPT_BYTES = 256 * 1024;
var MAX_TOPIC_GENERATION_OUTPUT_BYTES = 32 * 1024;
var TOPIC_GENERATION_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
var Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
var Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
var Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
var TopicGenerationReceiptId = Schema.String.check(Schema.isPattern(/^topic-generation-[a-f0-9]{32}$/u));
var TopicGenerationUsage = Schema.Union([
  Schema.Struct({status: Schema.Literal('unavailable')}),
  Schema.Struct({status: Schema.Literal('measured'), inputTokens: Count, outputTokens: Count}),
]);
var Representation = Schema.Literals(['provider-text', 'decoded-json']);
var Output = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('unavailable'),
    reason: Schema.Literals(['not-returned', 'provider-decode-failed', 'interrupted']),
  }),
  Schema.Struct({status: Schema.Literal('observed'), representation: Representation, hash: Hash, bytes: Count}),
]);
var TopicGenerationAttempt = Schema.Struct({
  ordinal: Schema.Literals([1, 2]),
  promptHash: Hash,
  promptBytes: Count.check(Schema.isLessThanOrEqualTo(80 * 1024)),
  status: Schema.Literals([
    'started',
    'not-dispatched',
    'accepted',
    'draft-invalid',
    'provider-output-invalid',
    'provider-failed',
    'deadline',
    'interrupted',
  ]),
  elapsedMilliseconds: Schema.NullOr(Count),
  usage: TopicGenerationUsage,
  output: Output,
});
var fields = {
  version: Schema.Literal(1),
  receiptId: TopicGenerationReceiptId,
  caseId: Schema.String.check(Schema.isPattern(/^health-case-[a-f0-9]{40}$/u)),
  reviewId: Schema.String.check(Schema.isPattern(/^review-[a-f0-9]{24}$/u)),
  targetHash: Hash,
  observationRevision: Hash,
  packetDigest: Hash,
  agent: Schema.Literals(['local-ai', 'effect-ai']),
  model: Text,
  modelVersion: Schema.optionalKey(Text),
  promptVersion: Text,
  state: Schema.Literals(['started', 'completed', 'failed', 'interrupted']),
  phase: Schema.Literals(['generation', 'validation', 'closing-fence', 'review-save']),
  elapsedMilliseconds: Schema.NullOr(Count),
  promptScope: Schema.Literal('user-prompt-utf8-sha256'),
  attempts: Schema.Array(TopicGenerationAttempt).check(Schema.isMaxLength(2)),
};
var TopicGenerationSummary = Schema.Struct(fields);
var RetainedTopicGenerationOutput = Schema.Struct({
  attempt: Schema.Literals([1, 2]),
  representation: Representation,
  hash: Hash,
  bytes: Count,
  retainedBytes: Count.check(Schema.isLessThanOrEqualTo(MAX_TOPIC_GENERATION_OUTPUT_BYTES)),
  truncated: Schema.Boolean,
  text: Schema.String,
});
var Receipt = Schema.Struct({
  ...fields,
  createdAtMilliseconds: Count,
  firstFailedOutput: Schema.optionalKey(RetainedTopicGenerationOutput),
});
var strict = {onExcessProperty: 'error'};
function validateTopicGenerationSummary(input) {
  const result = Schema.decodeUnknownSync(TopicGenerationSummary, strict)(input);
  if (result.attempts.some((attempt, index) => attempt.ordinal !== index + 1))
    throw new Error('Invalid generation attempt order.');
  if (result.attempts.length === 2 && result.attempts[0].status !== 'draft-invalid')
    throw new Error('Only invalid draft output permits a repair attempt.');
  if (result.state === 'completed' && result.attempts.at(-1)?.status !== 'accepted')
    throw new Error('Completed generation requires an accepted attempt.');
  return result;
}
function topicGenerationUsage(usages) {
  let inputTokens = 0;
  let outputTokens = 0;
  if (!usages.length) return {status: 'unavailable'};
  for (const usage of usages) {
    if (usage.status !== 'measured') return {status: 'unavailable'};
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
  }
  return Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens)
    ? {status: 'measured', inputTokens, outputTokens}
    : {status: 'unavailable'};
}
// packages/memory/src/consolidation.ts
import {sha256HexSync as sha256HexSync3} from '@threadnote/platform/sha256';
import {Schema as Schema3} from 'effect';
import {parseResourceId as parseResourceId2} from '@threadnote/store/resource-id';

// packages/memory/src/code/citation.ts
import {Predicate, Schema as Schema2} from 'effect';
import {sha256HexSync as sha256HexSync2} from '@threadnote/platform/sha256';
var MEMORY_SCHEMA_VERSION = 10;
var MEMORY_CODE_CITATION_SCHEMA_VERSION = 4;
var MEMORY_CODE_CITATION_VERSION = 1;
var MEMORY_CODE_CITATION_HEADER = 'code_citation';
var MAX_MEMORY_CODE_CITATIONS = 8;
var MAX_MEMORY_CODE_CITATION_ENTRY_BYTES = 8 * 1024;
var MAX_MEMORY_CODE_CITATION_AGGREGATE_BYTES = 64 * 1024;

class MemoryCodeCitationValidationError extends Schema2.TaggedError()('MemoryCodeCitationValidationError', {
  message: Schema2.String,
  reason: Schema2.Literals([
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
}) {
  static of(reason) {
    return MemoryCodeCitationValidationError.make({
      message: CITATION_ERROR_MESSAGES[reason],
      reason,
    });
  }
}

class UnsupportedMemorySchemaVersionError extends Schema2.TaggedError()('UnsupportedMemorySchemaVersionError', {
  message: Schema2.String,
  schemaVersion: Schema2.Finite,
}) {
  static of(schemaVersion) {
    return UnsupportedMemorySchemaVersionError.make({
      message: `Memory schema version ${schemaVersion} is newer than supported version ${MEMORY_SCHEMA_VERSION}.`,
      schemaVersion,
    });
  }
}
var CITATION_ERROR_MESSAGES = {
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
var encoder = new TextEncoder();
var SHA256 = /^[0-9a-f]{64}$/u;
var GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
var SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;
var GRAPH_CONTENT_ID = /^(?:cgc_[0-9a-f]{40}|cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?)$/u;
var NODE_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;
var CITATION_ID = /^tncc_[0-9a-f]{40}$/u;
var CODE_CITATION_PREFIX = `${MEMORY_CODE_CITATION_HEADER}: `;
function isMemoryCodeCitationSchemaVersion(schemaVersion) {
  return (
    schemaVersion === MEMORY_CODE_CITATION_SCHEMA_VERSION ||
    schemaVersion === 5 ||
    schemaVersion === 6 ||
    schemaVersion === 7 ||
    schemaVersion === 8 ||
    schemaVersion === 9 ||
    schemaVersion === MEMORY_SCHEMA_VERSION
  );
}
function assertMemorySchemaWritable(schemaVersion) {
  if (schemaVersion !== undefined && (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0)) {
    throw new Error('Memory schema version must be a positive safe integer.');
  }
  if (schemaVersion !== undefined && schemaVersion > MEMORY_SCHEMA_VERSION) {
    throw UnsupportedMemorySchemaVersionError.of(schemaVersion);
  }
}
function memoryCodeCitationAnchorId(citation) {
  return exactString(citation.anchorId ?? citation.id, 45, CITATION_ID);
}
function assertMemoryCodeCitation(value) {
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
function formatMemoryCodeCitation(citation) {
  const canonical = JSON.stringify(citationWire(assertMemoryCodeCitation(citation)));
  if (citationLineBytes(canonical) > MAX_MEMORY_CODE_CITATION_ENTRY_BYTES) {
    throw citationError('entry-too-large');
  }
  return canonical;
}
function formatMemoryCodeCitationLines(citations) {
  if (citations.length > MAX_MEMORY_CODE_CITATIONS) {
    throw citationError('too-many-citations');
  }
  const seen = new Set();
  const anchors = new Set();
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
function parseMemoryCodeCitation(value) {
  if (citationLineBytes(value) > MAX_MEMORY_CODE_CITATION_ENTRY_BYTES) {
    return {error: {reason: 'entry-too-large'}, ok: false};
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
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
      error: {reason: Schema2.is(MemoryCodeCitationValidationError)(error) ? error.reason : 'invalid-shape'},
      ok: false,
    };
  }
}
function parseMemoryCodeCitationHeaders(values, schemaVersion) {
  if (!values || values.length === 0) return {};
  const citations = [];
  const errors = [];
  if (!isMemoryCodeCitationSchemaVersion(schemaVersion)) {
    errors.push({reason: 'schema-version-mismatch'});
  }
  if (values.length > MAX_MEMORY_CODE_CITATIONS) {
    errors.push({index: MAX_MEMORY_CODE_CITATIONS, reason: 'too-many-citations'});
  }
  if (aggregateCitationValueBytes(values) > MAX_MEMORY_CODE_CITATION_AGGREGATE_BYTES) {
    errors.push({reason: 'aggregate-too-large'});
  }
  const seen = new Set();
  const anchors = new Set();
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
function validateCitationInput(value) {
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
  const extractorSet = boundedText(record.extractorSet, 4096);
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
function citationTarget(value) {
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
  const qualifiedName = boundedText(record.qualifiedName, 2048);
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
function citationSpan(value) {
  const record = requiredRecord(value);
  assertExactKeys(record, ['line', 'column', 'endLine', 'endColumn']);
  const line = boundedInteger(record.line, 1);
  const column = boundedInteger(record.column, 1);
  const endLine = boundedInteger(record.endLine, 1);
  const endColumn = boundedInteger(record.endColumn, 1);
  if (endLine < line || (endLine === line && endColumn <= column)) throw citationError('invalid-shape');
  return Object.freeze({line, column, endLine, endColumn});
}
function sha256(value) {
  const record = requiredRecord(value);
  assertExactKeys(record, ['algorithm', 'value']);
  if (record.algorithm !== 'sha256') throw citationError('invalid-shape');
  return Object.freeze({algorithm: 'sha256', value: exactString(record.value, 64, SHA256)});
}
function citationWire(citation) {
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
function citationIdentityWire(input) {
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
function hashWire(hash) {
  return {algorithm: hash.algorithm, value: hash.value};
}
function targetWire(target) {
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
function deriveCitationIdFromValidatedInput(input) {
  const identity = JSON.stringify(citationIdentityWire(input));
  return `tncc_${sha256HexSync2(`threadnote-memory-code-citation-v1\x00${identity}`).slice(0, 40)}`;
}
function citationRootKeys(record) {
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
function citationInputKeys(record) {
  return citationRootKeys(record).filter(key => key !== 'id');
}
function symbolTargetKeys(record) {
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
function assertExactKeys(record, expected) {
  const actual = Reflect.ownKeys(record);
  if (
    actual.length !== expected.length ||
    actual.some(key => typeof key !== 'string') ||
    expected.some(key => !hasOwn(record, key))
  ) {
    throw citationError('invalid-shape');
  }
}
function requiredRecord(value) {
  if (!isPlainObject(value)) throw citationError('invalid-shape');
  return value;
}
function isPlainObject(value) {
  if (!Predicate.isObject(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}
function exactString(value, maximumBytes, pattern) {
  const text = boundedText(value, maximumBytes);
  if (!pattern.test(text)) throw citationError('invalid-shape');
  return text;
}
function boundedText(value, maximumBytes) {
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
function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127 || codeUnit === 133 || codeUnit === 8232 || codeUnit === 8233) {
      return true;
    }
  }
  return false;
}
function repositoryPath(value) {
  const path = boundedText(value, 4096);
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw citationError('invalid-shape');
  }
  return path;
}
function boundedInteger(value, minimum) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 1e9) {
    throw citationError('invalid-shape');
  }
  return value;
}
function invalidShape() {
  throw citationError('invalid-shape');
}
function citationError(reason) {
  return MemoryCodeCitationValidationError.of(reason);
}
function citationLineBytes(json) {
  return encoder.encode(`${CODE_CITATION_PREFIX}${json}`).byteLength;
}
function aggregateLineBytes(lines) {
  let bytes = 0;
  for (const [index, line] of lines.entries()) {
    bytes += encoder.encode(line).byteLength + (index === 0 ? 0 : 1);
    if (bytes > MAX_MEMORY_CODE_CITATION_AGGREGATE_BYTES) return bytes;
  }
  return bytes;
}
function aggregateCitationValueBytes(values) {
  let bytes = 0;
  for (const [index, value] of values.entries()) {
    bytes += citationLineBytes(value) + (index === 0 ? 0 : 1);
    if (bytes > MAX_MEMORY_CODE_CITATION_AGGREGATE_BYTES) return bytes;
  }
  return bytes;
}
function freezeCitationInput(input) {
  return Object.freeze(input);
}
function freezeCitation(citation) {
  return Object.freeze(citation);
}

// packages/memory/src/topic-maintenance.ts
var MAX_TOPIC_MAINTENANCE_PARAGRAPHS = 64;
var MAX_TOPIC_MAINTENANCE_BYTES = 32 * 1024;
var HASH = /^[a-f0-9]{64}$/u;
var CITATION_ID2 = /^tncc_[a-f0-9]{40}$/u;
var MEMORY_ID = /^tn_[a-z0-9_]{1,128}$/u;
var encodedBytes = value => new TextEncoder().encode(value).byteLength;
function validateTopicMaintenanceManifest(manifest, record) {
  validEvidence(record);
  if (
    !plainObject(manifest) ||
    !exactKeys(
      manifest,
      ['version', 'memoryId', 'repositoryId', 'bodyHash', 'coverage', 'paragraphs', 'additionalDependencies'],
      manifest.version === 2 ? ['acceptedSources', 'originCitationIds'] : [],
    )
  )
    throw new Error('Topic maintenance manifest has an invalid shape.');
  if (manifest.version !== 1 && manifest.version !== 2)
    throw new Error('Topic maintenance manifest has an unsupported version.');
  if (
    manifest.version === 2 &&
    (!Object.hasOwn(manifest, 'acceptedSources') || !Object.hasOwn(manifest, 'originCitationIds'))
  )
    throw new Error('Topic maintenance accepted source vector is missing.');
  if (manifest.memoryId !== record.metadata.memoryId || !MEMORY_ID.test(manifest.memoryId))
    throw new Error('Topic maintenance memory identity changed.');
  if (manifest.repositoryId !== record.metadata.codeCitations[0].repositoryId)
    throw new Error('Topic maintenance repository identity changed.');
  if (manifest.bodyHash !== consolidationRevision(record.body) || !HASH.test(manifest.bodyHash))
    throw new Error('Topic maintenance body changed after enrollment.');
  if (manifest.coverage !== 'declared-only') throw new Error('Topic maintenance coverage must be declared-only.');
  const sections = consolidationSections(record.body);
  if (
    !Array.isArray(manifest.paragraphs) ||
    manifest.paragraphs.length !== sections.length ||
    manifest.paragraphs.length > MAX_TOPIC_MAINTENANCE_PARAGRAPHS
  )
    throw new Error('Topic maintenance paragraph count exceeds 64 or differs from the body.');
  const citationIds = new Set(record.metadata.codeCitations.map(citation => citation.id));
  manifest.paragraphs.forEach((paragraph, ordinal) => {
    if (
      !plainObject(paragraph) ||
      !exactKeys(paragraph, ['ordinal', 'hash', 'role', 'support', 'citationIds'], ['scope', 'validity'])
    )
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} has an invalid shape.`);
    if (paragraph.ordinal !== ordinal || paragraph.hash !== consolidationRevision(sections[ordinal]))
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} changed after enrollment.`);
    if (
      !['descriptive', 'normative', 'historical'].includes(paragraph.role) ||
      !['direct', 'contextual', 'unresolved'].includes(paragraph.support)
    )
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} has an invalid role or support.`);
    if (
      !Array.isArray(paragraph.citationIds) ||
      paragraph.citationIds.length > MAX_MEMORY_CODE_CITATIONS ||
      new Set(paragraph.citationIds).size !== paragraph.citationIds.length ||
      paragraph.citationIds.some(id => typeof id !== 'string' || !CITATION_ID2.test(id) || !citationIds.has(id))
    )
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} cites an unknown citation.`);
    if ((paragraph.support === 'unresolved') !== (paragraph.citationIds.length === 0))
      throw new Error(`Topic maintenance paragraph ${ordinal + 1} has invalid support coverage.`);
    for (const value of [paragraph.scope, paragraph.validity]) {
      if (
        value !== undefined &&
        (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\r\n]/u.test(value))
      )
        throw new Error(`Topic maintenance paragraph ${ordinal + 1} has invalid scope or validity.`);
    }
  });
  if (
    !Array.isArray(manifest.additionalDependencies) ||
    manifest.additionalDependencies.length > MAX_MEMORY_CODE_CITATIONS
  )
    throw new Error('Topic maintenance additional dependency count exceeds citation budget.');
  const seen = new Set();
  for (const dependency of manifest.additionalDependencies) {
    if (
      !plainObject(dependency) ||
      !exactKeys(dependency, ['kind', 'citationId']) ||
      !['configuration', 'dependency'].includes(dependency.kind) ||
      typeof dependency.citationId !== 'string' ||
      !citationIds.has(dependency.citationId)
    )
      throw new Error('Topic maintenance additional dependency cites an unknown citation.');
    if (seen.has(dependency.citationId)) throw new Error('Topic maintenance additional dependency is duplicated.');
    seen.add(dependency.citationId);
  }
  if (manifest.version === 2) {
    let priorOrigin = '';
    if (
      !Array.isArray(manifest.originCitationIds) ||
      manifest.originCitationIds.length < 1 ||
      manifest.originCitationIds.length > MAX_MEMORY_CODE_CITATIONS
    )
      throw new Error('Topic maintenance original citation lineage is invalid.');
    for (const id of manifest.originCitationIds) {
      if (typeof id !== 'string' || !CITATION_ID2.test(id) || !citationIds.has(id) || id <= priorOrigin)
        throw new Error('Topic maintenance original citation lineage is missing or unordered.');
      priorOrigin = id;
    }
    const declared = new Set([
      ...manifest.paragraphs.flatMap(paragraph => paragraph.citationIds),
      ...manifest.additionalDependencies.map(dependency => dependency.citationId),
    ]);
    const citations = new Map(record.metadata.codeCitations.map(citation => [citation.id, citation]));
    if (
      !Array.isArray(manifest.acceptedSources) ||
      manifest.acceptedSources.length !== declared.size ||
      manifest.acceptedSources.length > MAX_MEMORY_CODE_CITATIONS
    )
      throw new Error('Topic maintenance accepted sources must cover every declared citation exactly once.');
    let previous = '';
    for (const entry of manifest.acceptedSources) {
      if (
        !plainObject(entry) ||
        !exactKeys(entry, ['citationId', 'acceptedCitationId']) ||
        typeof entry.citationId !== 'string' ||
        typeof entry.acceptedCitationId !== 'string' ||
        !CITATION_ID2.test(entry.citationId) ||
        !CITATION_ID2.test(entry.acceptedCitationId) ||
        !declared.has(entry.citationId) ||
        entry.citationId <= previous
      )
        throw new Error('Topic maintenance accepted source vector is malformed or unordered.');
      const original = citations.get(entry.citationId);
      const accepted = citations.get(entry.acceptedCitationId);
      if (
        !original ||
        !accepted ||
        accepted.repositoryId !== original.repositoryId ||
        accepted.target.kind !== original.target.kind
      )
        throw new Error('Topic maintenance accepted source cites unknown or incompatible evidence.');
      previous = entry.citationId;
    }
  }
  if (encodedBytes(JSON.stringify(manifest)) > MAX_TOPIC_MAINTENANCE_BYTES)
    throw new Error('Topic maintenance manifest exceeds the 32 KiB limit.');
  return manifest;
}
function validEvidence(record) {
  const citations = record.metadata.codeCitations ?? [];
  if (!citations.length || citations.length > MAX_MEMORY_CODE_CITATIONS || record.metadata.citationErrors?.length)
    throw new Error('Topic maintenance requires 1\u20138 valid code citations.');
  const repository = citations[0].repositoryId;
  for (const citation of citations) {
    if (citation.sourceDirty) throw new Error('Topic maintenance cannot enroll dirty code evidence.');
    assertMemoryCodeCitation(citation);
    if (citation.repositoryId !== repository) throw new Error('Topic maintenance citations must use one repository.');
    if (citation.evidenceRetention !== 'capsule-retained')
      throw new Error('Topic maintenance requires recoverable code evidence.');
  }
}
function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value, required, optional = []) {
  return (
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  );
}

// packages/memory/src/document.ts
import {parseResourceId} from '@threadnote/store/resource-id';
import {serializeSourceEvidenceCitation} from '@threadnote/store/source-evidence-citation';
var EVIDENCE_HEADER = 'obsidian_evidence';
var SOURCE_EVIDENCE_HEADER = 'source_evidence';
var TOPIC_MAINTENANCE_HEADER = 'topic_maintenance';
var MAX_MEMORY_OBSIDIAN_EVIDENCE_BYTES = 4096;
var HASH_PATTERN = /^[a-f0-9]{64}$/u;
var UUID_PATTERN = /^[a-f0-9-]{36}$/u;
function validMemoryObsidianEvidence(value) {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value;
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
    entry.fragmentStart >= 0 &&
    Number.isSafeInteger(entry.fragmentEnd) &&
    entry.fragmentEnd > entry.fragmentStart &&
    typeof entry.pinId === 'string' &&
    UUID_PATTERN.test(entry.pinId) &&
    typeof entry.expiresAt === 'string' &&
    Number.isFinite(Date.parse(entry.expiresAt))
  );
}
function serializeMemoryObsidianEvidence(value) {
  if (!validMemoryObsidianEvidence(value)) throw new Error('Invalid Obsidian evidence citation metadata.');
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_MEMORY_OBSIDIAN_EVIDENCE_BYTES) {
    throw new Error('Obsidian evidence citation metadata exceeds the 4096-byte limit.');
  }
  return serialized;
}
var MEMORY_RELATION_TYPES = ['depends_on', 'evidence_for', 'references', 'related_to', 'supersedes'];
var MAX_MEMORY_RELATIONS = 16;
function parseMemoryDocument(uri, content) {
  const trimmed = content.trim();
  if (!trimmed) {
    return;
  }
  const parseable = normalizeMemoryDocumentLineEndings(trimmed);
  const separatorIndex = parseable.indexOf(`

`);
  const header = separatorIndex === -1 ? parseable : parseable.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? '' : stripLegacyMemoryFieldsTrailer(parseable.slice(separatorIndex + 2)).trim();
  const lines = header.split(`
`);
  const firstLine = lines[0]?.trim();
  if (firstLine !== 'MEMORY' && firstLine !== 'HANDOFF') {
    return;
  }
  const kind =
    parseMemoryKind(memoryHeaderValueFromLines(lines, 'kind')) ?? (firstLine === 'HANDOFF' ? 'handoff' : undefined);
  if (!kind) {
    return;
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
  let obsidianEvidence;
  if (
    (schemaVersion === 7 || schemaVersion === 8 || schemaVersion === 9 || schemaVersion === MEMORY_SCHEMA_VERSION) &&
    evidenceValue
  ) {
    try {
      const parsed = JSON.parse(evidenceValue);
      if (serializeMemoryObsidianEvidence(parsed) === evidenceValue) {
        obsidianEvidence = parsed;
      }
    } catch {}
  }
  const sourceEvidenceLines = lines.filter(line => /^\s*source_evidence\s*:/u.test(line));
  const sourceEvidenceValue =
    sourceEvidenceLines.length === 1 && sourceEvidenceLines[0]?.startsWith(`${SOURCE_EVIDENCE_HEADER}: `)
      ? sourceEvidenceLines[0].slice(SOURCE_EVIDENCE_HEADER.length + 2)
      : undefined;
  let sourceEvidence;
  if ((schemaVersion === 8 || schemaVersion === 9 || schemaVersion === MEMORY_SCHEMA_VERSION) && sourceEvidenceValue) {
    try {
      const parsed = JSON.parse(sourceEvidenceValue);
      if (serializeSourceEvidenceCitation(parsed) === sourceEvidenceValue) {
        sourceEvidence = parsed;
      }
    } catch {}
  }
  const consolidationLines = lines.filter(line => /^\s*consolidation\s*:/u.test(line));
  const consolidationValues = memoryHeaderValues(lines, 'consolidation') ?? [];
  let consolidation;
  let consolidationError;
  if (consolidationLines.length) {
    try {
      if (
        (schemaVersion !== 6 &&
          schemaVersion !== 7 &&
          schemaVersion !== 8 &&
          schemaVersion !== 9 &&
          schemaVersion !== MEMORY_SCHEMA_VERSION) ||
        consolidationLines.length !== 1 ||
        !consolidationLines[0].startsWith('consolidation: ') ||
        consolidationValues.length !== 1 ||
        new TextEncoder().encode(consolidationValues[0]).byteLength > MAX_CONSOLIDATION_V2_BYTES
      )
        throw new Error('Invalid consolidation schema, duplicate header, or evidence bounds.');
      const parsedConsolidation = JSON.parse(consolidationValues[0]);
      if (
        typeof parsedConsolidation === 'object' &&
        parsedConsolidation !== null &&
        'version' in parsedConsolidation &&
        parsedConsolidation.version === 2
      ) {
        if (schemaVersion !== MEMORY_SCHEMA_VERSION)
          throw new Error('Consolidation V2 requires memory schema version 10.');
        consolidation = validateConsolidationProvenanceV2(parsedConsolidation, body);
      } else {
        if (new TextEncoder().encode(consolidationValues[0]).byteLength > MAX_CONSOLIDATION_BYTES)
          throw new Error('Consolidation provenance exceeds the 60 KiB limit.');
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
      }
    } catch (error) {
      consolidationError = error instanceof Error ? error.message : 'Invalid consolidation evidence.';
      consolidation = undefined;
    }
  }
  const record = {
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
      sourceEvidence,
      sourceEvidenceError: sourceEvidenceLines.length > 0 ? sourceEvidence === undefined : undefined,
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
  const maintenanceLines = lines.filter(line => /^\s*topic_maintenance\s*:/u.test(line));
  if (!maintenanceLines.length) return validateParsedConsolidationV2(record);
  let topicMaintenance;
  let topicMaintenanceError;
  try {
    if (
      (schemaVersion !== 9 && schemaVersion !== MEMORY_SCHEMA_VERSION) ||
      maintenanceLines.length !== 1 ||
      !maintenanceLines[0].startsWith(`${TOPIC_MAINTENANCE_HEADER}: `)
    )
      throw new Error('Topic maintenance requires one canonical schema 9 or 10 header.');
    const raw = maintenanceLines[0].slice(TOPIC_MAINTENANCE_HEADER.length + 2);
    if (new TextEncoder().encode(raw).byteLength > MAX_TOPIC_MAINTENANCE_BYTES)
      throw new Error('Topic maintenance manifest exceeds the 32 KiB limit.');
    const parsed = JSON.parse(raw);
    if (JSON.stringify(parsed) !== raw) throw new Error('Topic maintenance manifest is not canonical JSON.');
    if (
      schemaVersion === 9 &&
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      parsed.version === 2
    )
      throw new Error('Topic maintenance V2 requires memory schema version 10.');
    topicMaintenance = validateTopicMaintenanceManifest(parsed, record);
  } catch (error) {
    topicMaintenanceError = error instanceof Error ? error.message : 'Invalid topic maintenance manifest.';
  }
  return validateParsedConsolidationV2({
    ...record,
    metadata: {
      ...record.metadata,
      citationErrors: topicMaintenanceError
        ? [...(record.metadata.citationErrors ?? []), {reason: 'invalid-shape'}]
        : record.metadata.citationErrors,
      topicMaintenance,
      topicMaintenanceError,
    },
  });
}
function validateParsedConsolidationV2(record) {
  const receipt = record.metadata.consolidation;
  if (receipt?.version !== 2) return record;
  try {
    const manifest = record.metadata.topicMaintenance;
    if (manifest?.version !== 2) throw new Error('Consolidation V2 requires a valid topic maintenance V2 manifest.');
    validateConsolidationV2ActiveEvidence(
      receipt,
      manifest,
      record.metadata.codeCitations ?? [],
      record.metadata.relations ?? [],
    );
    return record;
  } catch (error) {
    return {
      ...record,
      metadata: {
        ...record.metadata,
        citationErrors: [...(record.metadata.citationErrors ?? []), {reason: 'invalid-shape'}],
        consolidation: undefined,
        consolidationError: error instanceof Error ? error.message : 'Invalid consolidated topic evidence.',
      },
    };
  }
}
function canonicalMemoryDocumentContent(content) {
  return stripLegacyMemoryFieldsTrailer(content.trim()).trim();
}
function stripLegacyMemoryFieldsTrailer(content) {
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
function lineBreakStartsAt(value, index) {
  return (
    value[index] ===
      `
` ||
    (value[index] === '\r' &&
      value[index + 1] ===
        `
`)
  );
}
function lineBreakEndsAt(value, index) {
  return (
    index > 0 &&
    value[index - 1] ===
      `
`
  );
}
function previousLineBreakStart(value, index) {
  if (!lineBreakEndsAt(value, index)) return -1;
  return index > 1 && value[index - 2] === '\r' ? index - 2 : index - 1;
}
function assertMemoryDocumentSchemaWritable(content) {
  const canonical = normalizeMemoryDocumentLineEndings(canonicalMemoryDocumentContent(content));
  const separatorIndex = canonical.indexOf(`

`);
  const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
  if (
    header
      .split(
        `
`,
      )
      .some(line => /^\s*consolidation\s*:/u.test(line))
  ) {
    const record = parseMemoryDocument('threadnote://memory/consolidation-check', content);
    if (!record?.metadata.consolidation || record.metadata.consolidationError)
      throw new Error(record?.metadata.consolidationError ?? 'Malformed consolidation provenance.');
  }
  const hasObsidianEvidence = header
    .split(
      `
`,
    )
    .some(line => /^\s*obsidian_evidence\s*:/u.test(line));
  const hasSourceEvidence = header
    .split(
      `
`,
    )
    .some(line => /^\s*source_evidence\s*:/u.test(line));
  const hasTopicMaintenance = header
    .split(
      `
`,
    )
    .some(line => /^\s*topic_maintenance\s*:/u.test(line));
  const schemaLines = header
    .split(
      `
`,
    )
    .filter(line => /^\s*schema_version\s*:/u.test(line));
  if (schemaLines.length === 0) {
    if (hasObsidianEvidence) throw new Error('Malformed Obsidian evidence citation metadata.');
    if (hasSourceEvidence) throw new Error('Malformed source evidence citation metadata.');
    if (hasTopicMaintenance) throw new Error('Malformed topic maintenance metadata.');
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
  if (hasSourceEvidence) {
    const record = parseMemoryDocument('threadnote://memory/evidence-check', content);
    if (!record?.metadata.sourceEvidence || record.metadata.sourceEvidenceError) {
      throw new Error('Malformed source evidence citation metadata.');
    }
  }
  if (hasTopicMaintenance) {
    const record = parseMemoryDocument(
      'threadnote://user/validator/memories/durable/projects/topic/record.md',
      content,
    );
    if (!record?.metadata.topicMaintenance || record.metadata.topicMaintenanceError)
      throw new Error(
        `Malformed topic maintenance metadata: ${record?.metadata.topicMaintenanceError ?? 'invalid header'}`,
      );
  }
}
function canonicalResourceInput(uri) {
  try {
    return parseResourceId(uri).canonicalUri;
  } catch {
    return uri;
  }
}
function normalizeMemoryDocumentLineEndings(content) {
  return content.replace(
    /\r\n?/gu,
    `
`,
  );
}
function memoryHeaderValueFromLines(lines, key) {
  const prefix = `${key}:`;
  return lines
    .find(line => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}
function memoryHeaderValues(lines, key) {
  const prefix = `${key}:`;
  const values = lines
    .filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length).trim())
    .filter(value => value.length > 0);
  return values.length > 0 ? values : undefined;
}
function memoryCodeCitationHeaderValues(lines) {
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
function canonicalCodeCitationSchemaVersion(lines, schemaVersion) {
  if (schemaVersion === undefined) return;
  const schemas = lines.filter(line => line.startsWith('schema_version:'));
  return schemas.length === 1 && schemas[0] === `schema_version: ${schemaVersion}` ? schemaVersion : undefined;
}
function parseMemoryKind(value) {
  return value === 'durable' ||
    value === 'handoff' ||
    value === 'incident' ||
    value === 'preference' ||
    value === 'smoke'
    ? value
    : undefined;
}
function parseMemoryStatus(value) {
  return value === 'active' || value === 'archived' || value === 'expired' || value === 'superseded'
    ? value
    : undefined;
}
function parseMemoryAuthority(value) {
  return value === 'agent_generated' ||
    value === 'canonical_repo' ||
    value === 'external' ||
    value === 'reviewed_shared' ||
    value === 'user_approved'
    ? value
    : undefined;
}
function parseMemoryTrust(value) {
  return value === 'approved' || value === 'inferred' || value === 'untrusted' ? value : undefined;
}
function parseMemoryVisibility(value) {
  return value === 'external' || value === 'personal' || value === 'shared' ? value : undefined;
}
function parseMemoryRelations(values) {
  if (!values) {
    return;
  }
  const relations = values.map(parseMemoryRelationValue).filter(relation => relation !== undefined);
  return relations.length > 0 ? relations : undefined;
}
function parseMemoryRelationValue(value) {
  const separator = value.indexOf(' ');
  if (separator <= 0) {
    return;
  }
  const type = value.slice(0, separator);
  const uri = canonicalOptionalResourceInput(value.slice(separator + 1).trim());
  if (!uri || !uri.startsWith('threadnote://') || !isMemoryRelationType(type)) {
    return;
  }
  return {type, uri};
}
function canonicalOptionalResourceInput(uri) {
  if (!uri) return;
  try {
    return parseResourceId(uri).canonicalUri;
  } catch {
    return uri;
  }
}
function canonicalResourceInputs(values) {
  return values?.map(value => canonicalOptionalResourceInput(value) ?? value);
}
function isMemoryRelationType(value) {
  return MEMORY_RELATION_TYPES.some(type => type === value);
}
function parseSchemaVersion(value) {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    return;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function normalizeOptionalMetadata(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
function isIsoDateOrCanonicalIsoInstant(value) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function parseIsoDate(value) {
  return value !== undefined && isIsoDateOrCanonicalIsoInstant(value) ? value : undefined;
}

// packages/memory/src/consolidation.ts
var MAX_CONSOLIDATION_SOURCES = 16;
var MAX_CONSOLIDATION_BYTES = 60 * 1024;
var MAX_CONSOLIDATION_V2_BYTES = 128 * 1024;
var digest = /^[a-f0-9]{64}$/;
var bytes = text => new TextEncoder().encode(text).byteLength;
function fail(message) {
  throw new Error(`Consolidation review: ${message}`);
}
var strict2 = {onExcessProperty: 'error'};
var CitationSchema = Schema3.declare(value => {
  try {
    assertMemoryCodeCitation(value);
    return true;
  } catch {
    return false;
  }
});
var SourceSchema = Schema3.Struct({
  uri: Schema3.String,
  revision: Schema3.String.check(Schema3.isPattern(digest)),
  memoryId: Schema3.optionalKey(Schema3.String.check(Schema3.isMaxLength(512))),
  fragments: Schema3.Array(Schema3.String).check(Schema3.isMinLength(1), Schema3.isMaxLength(64)),
  codeCitations: Schema3.Array(CitationSchema).check(Schema3.isMaxLength(8)),
  relations: Schema3.Array(
    Schema3.Struct({
      type: Schema3.Literals(['depends_on', 'evidence_for', 'references', 'related_to', 'supersedes']),
      uri: Schema3.String,
    }),
  ).check(Schema3.isMaxLength(16)),
});
var ReviewSchema = Schema3.Struct({
  section: Schema3.String,
  disposition: Schema3.Literals(['direct', 'contextual', 'unsupported', 'unresolved']),
  supports: Schema3.Array(
    Schema3.Struct({
      sourceUri: Schema3.String,
      fragment: Schema3.Int,
      citationIds: Schema3.Array(Schema3.String).check(Schema3.isMaxLength(8)),
      relationIndexes: Schema3.Array(Schema3.Int).check(Schema3.isMaxLength(16)),
    }),
  ).check(Schema3.isMaxLength(16)),
});
var ConsolidationTargetSchema = Schema3.Struct({
  kind: Schema3.Literals(['durable', 'handoff', 'incident', 'preference', 'smoke']),
  status: Schema3.Literals(['active', 'archived', 'expired', 'superseded']),
  project: Schema3.String,
  topic: Schema3.String,
  sourceAgentClient: Schema3.String,
});
var ProvenanceSchema = Schema3.Struct({
  version: Schema3.Literal(1),
  bodyHash: Schema3.String,
  requestHash: Schema3.String,
  operationId: Schema3.String,
  cleanup: Schema3.Literals(['archive', 'forget', 'keep']),
  cleanupShared: Schema3.Boolean,
  target: ConsolidationTargetSchema,
  sources: Schema3.Array(SourceSchema).check(Schema3.isMinLength(1), Schema3.isMaxLength(16)),
  reviews: Schema3.Array(ReviewSchema).check(Schema3.isMaxLength(64)),
});
var ProvenanceV2Schema = Schema3.Struct({
  version: Schema3.Literal(2),
  origin: ProvenanceSchema,
  originBody: Schema3.String,
  bodyHash: Schema3.String,
  requestHash: Schema3.String,
  acceptance: Schema3.Struct({
    reviewId: Schema3.String,
    targetBeforeHash: Schema3.String,
    packetDigest: Schema3.String,
    observationRevision: Schema3.String,
    paragraphs: Schema3.Array(
      Schema3.Struct({
        ordinal: Schema3.Int,
        originOrdinal: Schema3.Int,
        hash: Schema3.String,
        evidence: Schema3.Literals(['origin', 'reviewed-current']),
        citationIds: Schema3.Array(Schema3.String).check(Schema3.isMaxLength(8)),
      }),
    ).check(Schema3.isMinLength(1), Schema3.isMaxLength(64)),
  }),
});
function consolidationSections(body) {
  const sections = body
    .trim()
    .split(/\n[\t ]*\n/)
    .map(section => section.trim())
    .filter(Boolean);
  if (!sections.length || sections.length > 64 || bytes(body) > 32 * 1024)
    fail('draft must contain 1\u201364 paragraphs within 32 KiB.');
  return sections;
}
function consolidationRevision(content) {
  return sha256HexSync3(content);
}
function reviewConsolidation(body, sources, input, options) {
  const sections = consolidationSections(body);
  validateSources(sources);
  validateOptions(options);
  let reviews;
  try {
    reviews = Schema3.decodeUnknownSync(Schema3.Array(ReviewSchema), strict2)(input);
  } catch {
    return fail('invalid paragraph support decisions or evidence selectors.');
  }
  if (reviews.length !== sections.length) fail('every final paragraph needs an explicit evidence review.');
  const citations = new Map();
  const relations = new Map();
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
  const payload = {version: 1, ...options, bodyHash: consolidationRevision(body.trim()), sources, reviews};
  const provenance = {...payload, requestHash: sha256HexSync3(JSON.stringify(payload))};
  if (bytes(JSON.stringify(provenance)) > MAX_CONSOLIDATION_BYTES)
    fail('captured provenance exceeds 60 KiB; use fewer sources or split the draft.');
  return {
    codeCitations: [...citations.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...relations.values()].sort((a, b) => `${a.type} ${a.uri}`.localeCompare(`${b.type} ${b.uri}`)),
    provenance,
  };
}
function validateOptions(options) {
  if (
    !options ||
    typeof options.operationId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(options.operationId) ||
    !['archive', 'forget', 'keep'].includes(options.cleanup) ||
    typeof options.cleanupShared !== 'boolean'
  )
    fail('invalid operation receipt.');
  const t = options.target;
  Schema3.decodeSync(ConsolidationTargetSchema, strict2)(t);
  if ([t.project, t.topic, t.sourceAgentClient].some(value => bytes(value) > 512)) fail('invalid target receipt.');
}
function validateSources(sources) {
  Schema3.decodeSync(Schema3.Array(SourceSchema), strict2)(sources);
  if (
    !Array.isArray(sources) ||
    sources.length < 1 ||
    sources.length > MAX_CONSOLIDATION_SOURCES ||
    new Set(sources.map(s => s.uri)).size !== sources.length
  )
    fail('select 1\u201316 distinct source revisions.');
  for (const source of sources) {
    if (
      !source ||
      typeof source.uri !== 'string' ||
      parseResourceId2(source.uri).canonicalUri !== source.uri ||
      !digest.test(source.revision) ||
      !Array.isArray(source.fragments) ||
      source.fragments.length < 1 ||
      source.fragments.length > 64 ||
      source.fragments.some(
        fragment => typeof fragment !== 'string' || !fragment.trim() || bytes(fragment) > 32 * 1024,
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
        parseResourceId2(relation.uri).canonicalUri !== relation.uri
      )
        fail('invalid captured relation.');
  }
}
function validateConsolidationProvenance(value, body, archived = false) {
  const provenance = Schema3.decodeUnknownSync(ProvenanceSchema, strict2)(value);
  let effectiveBody = body;
  while (
    archived &&
    provenance.bodyHash !== consolidationRevision(effectiveBody.trim()) &&
    effectiveBody.startsWith(`Archived original Threadnote memory.

`)
  ) {
    effectiveBody = effectiveBody.slice(
      `Archived original Threadnote memory.

`.length,
    );
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
function buildConsolidationProvenanceV2(previous, previousBody, body, manifest, acceptance) {
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
        ? 'origin'
        : 'reviewed-current';
    return {
      ordinal,
      originOrdinal: ordinal,
      hash: consolidationRevision(section),
      evidence,
      citationIds,
    };
  });
  const payload = {
    version: 2,
    origin,
    originBody,
    bodyHash: consolidationRevision(body.trim()),
    acceptance: {...acceptance, paragraphs},
  };
  const receipt = {...payload, requestHash: sha256HexSync3(JSON.stringify(payload))};
  validateConsolidationProvenanceV2(receipt, body);
  return receipt;
}
function validateConsolidationProvenanceV2(value, body) {
  const receipt = Schema3.decodeUnknownSync(ProvenanceV2Schema, strict2)(value);
  const stored = value;
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
  if (receipt.requestHash !== sha256HexSync3(JSON.stringify(payload)))
    fail('maintenance receipt differs from reviewed provenance.');
  return stored;
}
function validateConsolidationV2ActiveEvidence(receipt, manifest, citations, relations) {
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

// packages/memory/src/topic-maintenance-draft.ts
var MAX_TOPIC_MAINTENANCE_DRAFT_BYTES = 32 * 1024;
var MAX_TOPIC_MAINTENANCE_BASIS_BYTES = 64 * 1024;
var MAX_TOPIC_MAINTENANCE_REVIEW_BYTES = 128 * 1024;
var HASH2 = /^[a-f0-9]{64}$/u;
var COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
var SNAPSHOT = /^cgsn_[a-f0-9]{40}(?:-direct|-full-[a-f0-9]{16})?$/u;
var CITATION_ID3 = /^tncc_[a-f0-9]{40}$/u;
var HANDLE_ID = /^(historical|current):(tncc_[a-f0-9]{40})$/u;
var textBytes = value => new TextEncoder().encode(value).byteLength;
var jsonBytes = value => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : textBytes(serialized);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};
function topicMaintenanceParagraphEligible(paragraph) {
  return paragraph.role === 'descriptive' && paragraph.support === 'direct';
}
function fail2(message) {
  throw new Error(`Topic maintenance draft: ${message}`);
}
function object(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function keys(value, required, optional = []) {
  const actual = Object.keys(value);
  return required.every(key => key in value) && actual.every(key => required.includes(key) || optional.includes(key));
}
function boundedText2(value, maxBytes, allowEmpty = false) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && textBytes(value) <= maxBytes;
}
function boundedStrings(value, maxCount, maxBytes) {
  return Array.isArray(value) && value.length <= maxCount && value.every(item => boundedText2(item, maxBytes));
}
function paragraphSpans(body) {
  const trimmed = body.trim();
  const initial = body.length - body.trimStart().length;
  const result = [];
  let cursor = 0;
  const add = end => {
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
    fail2('accepted paragraph spans are inconsistent.');
  return result;
}
function validateTopicMaintenanceDraftBasis(input) {
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
    !boundedText2(input.targetUri, 1024) ||
    typeof input.targetHash !== 'string' ||
    !HASH2.test(input.targetHash) ||
    typeof input.observationRevision !== 'string' ||
    !HASH2.test(input.observationRevision) ||
    typeof input.packetDigest !== 'string' ||
    !HASH2.test(input.packetDigest) ||
    !boundedText2(input.body, MAX_TOPIC_MAINTENANCE_BYTES) ||
    !Array.isArray(input.paragraphs) ||
    !Array.isArray(input.additionalDependencies) ||
    !Array.isArray(input.handles)
  )
    fail2('invalid basis shape or identity.');
  const spans = paragraphSpans(input.body);
  if (input.paragraphs.length !== spans.length || input.paragraphs.length > MAX_TOPIC_MAINTENANCE_PARAGRAPHS)
    fail2('basis paragraph count differs from accepted body.');
  const cited = new Set();
  for (const [ordinal, paragraph] of input.paragraphs.entries()) {
    if (
      !object(paragraph) ||
      !keys(paragraph, ['ordinal', 'hash', 'role', 'support', 'citationIds'], ['scope', 'validity']) ||
      paragraph.ordinal !== ordinal ||
      paragraph.hash !== consolidationRevision(spans[ordinal].text) ||
      !['descriptive', 'normative', 'historical'].includes(paragraph.role) ||
      !['direct', 'contextual', 'unresolved'].includes(paragraph.support) ||
      !Array.isArray(paragraph.citationIds) ||
      paragraph.citationIds.length > 8 ||
      new Set(paragraph.citationIds).size !== paragraph.citationIds.length ||
      paragraph.citationIds.some(id => typeof id !== 'string' || !CITATION_ID3.test(id)) ||
      (paragraph.support === 'unresolved') !== (paragraph.citationIds.length === 0) ||
      [paragraph.scope, paragraph.validity].some(
        value =>
          value !== undefined &&
          (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\r\n]/u.test(value)),
      )
    )
      fail2(`invalid basis paragraph ${ordinal + 1}.`);
    for (const id of paragraph.citationIds) cited.add(id);
  }
  if (input.additionalDependencies.length > 8) fail2('basis additional dependencies exceed citation budget.');
  const dependencies = new Set();
  for (const dependency of input.additionalDependencies) {
    if (
      !object(dependency) ||
      !keys(dependency, ['kind', 'citationId']) ||
      !['configuration', 'dependency'].includes(dependency.kind) ||
      typeof dependency.citationId !== 'string' ||
      !CITATION_ID3.test(dependency.citationId) ||
      dependencies.has(dependency.citationId)
    )
      fail2('invalid or duplicated additional dependency.');
    dependencies.add(dependency.citationId);
    cited.add(dependency.citationId);
  }
  if (cited.size === 0 || cited.size > 8 || input.handles.length !== cited.size * 2)
    fail2('basis handles differ from declared evidence.');
  const seen = new Set();
  for (const handle of input.handles) {
    if (
      !object(handle) ||
      !keys(handle, ['id', 'citationId', 'variant']) ||
      typeof handle.id !== 'string' ||
      typeof handle.citationId !== 'string' ||
      !CITATION_ID3.test(handle.citationId) ||
      !['historical', 'current'].includes(handle.variant) ||
      handle.id !== `${handle.variant}:${handle.citationId}` ||
      !HANDLE_ID.test(handle.id) ||
      seen.has(handle.id)
    )
      fail2('basis has unknown or duplicate evidence handles.');
    seen.add(handle.id);
  }
  if ([...cited].some(id => !seen.has(`historical:${id}`) || !seen.has(`current:${id}`)))
    fail2('basis omits a declared paragraph citation handle.');
  return input;
}
function validateDraft(input, basis) {
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
    !['propose-update', 'propose-revalidation', 'policy-conflict', 'insufficient-evidence'].includes(input.outcome) ||
    !Array.isArray(input.operations) ||
    input.operations.length > MAX_TOPIC_MAINTENANCE_PARAGRAPHS ||
    !boundedStrings(input.reviewedHandles, 8, 64) ||
    !boundedText2(input.rationale, 2048) ||
    !boundedStrings(input.unresolvedQuestions, 16, 512) ||
    !boundedStrings(input.removedClaims, 64, 512)
  )
    fail2('invalid draft shape or stale packet identity.');
  const known = new Set(basis.handles.map(handle => handle.id));
  const spans = paragraphSpans(basis.body);
  if (
    new Set(input.reviewedHandles).size !== input.reviewedHandles.length ||
    input.reviewedHandles.some(handle => !known.has(handle) || !handle.startsWith('current:'))
  )
    fail2('reviewed evidence handle is unknown or not current.');
  const seen = new Set();
  for (const operation of input.operations) {
    if (
      !object(operation) ||
      !keys(operation, ['ordinal', 'beforeHash', 'text', 'supportHandles', 'rationale']) ||
      !Number.isSafeInteger(operation.ordinal) ||
      operation.ordinal < 0 ||
      operation.ordinal >= basis.paragraphs.length ||
      seen.has(operation.ordinal) ||
      operation.beforeHash !== basis.paragraphs[operation.ordinal].hash ||
      basis.paragraphs[operation.ordinal].role !== 'descriptive' ||
      !boundedText2(operation.text, MAX_TOPIC_MAINTENANCE_BYTES) ||
      operation.text !== operation.text.trim() ||
      operation.text === spans[operation.ordinal].text ||
      !boundedText2(operation.rationale, 1024) ||
      !boundedStrings(operation.supportHandles, 8, 64) ||
      operation.supportHandles.length === 0 ||
      new Set(operation.supportHandles).size !== operation.supportHandles.length ||
      operation.supportHandles.some(handle => !known.has(handle) || !handle.startsWith('current:'))
    )
      fail2('invalid, overlapping, or unsupported paragraph replacement.');
    try {
      if (consolidationSections(operation.text).length !== 1) fail2('replacement spans multiple paragraphs.');
    } catch {
      fail2('replacement spans multiple paragraphs or exceeds body bounds.');
    }
    seen.add(operation.ordinal);
  }
  if (
    (input.outcome === 'propose-update' && input.operations.length === 0) ||
    (input.outcome !== 'propose-update' && input.operations.length > 0) ||
    (input.outcome === 'propose-revalidation' && input.reviewedHandles.length === 0) ||
    (input.outcome !== 'propose-revalidation' && input.outcome !== 'propose-update' && input.reviewedHandles.length > 0)
  )
    fail2('draft outcome does not match its evidence and paragraph operations.');
  if (input.paragraphDispositions !== undefined) {
    const accounting = input.paragraphDispositions;
    if (
      !object(accounting) ||
      !keys(accounting, ['version', 'entries']) ||
      accounting.version !== 1 ||
      !Array.isArray(accounting.entries) ||
      accounting.entries.length > MAX_TOPIC_MAINTENANCE_PARAGRAPHS
    )
      fail2('invalid paragraph dispositions.');
    const entries = accounting.entries;
    const accounted = new Set();
    for (const entry of entries) {
      if (
        !object(entry) ||
        !keys(entry, ['ordinal', 'beforeHash', 'disposition', 'supportHandles', 'rationale']) ||
        !Number.isSafeInteger(entry.ordinal) ||
        !basis.paragraphs[entry.ordinal] ||
        accounted.has(entry.ordinal)
      )
        fail2('invalid or duplicate paragraph disposition.');
      const paragraph = basis.paragraphs[entry.ordinal];
      const operation = input.operations.find(item => item.ordinal === entry.ordinal);
      const allowed = new Set(
        [...paragraph.citationIds, ...basis.additionalDependencies.map(item => item.citationId)].map(
          id => `current:${id}`,
        ),
      );
      if (
        !topicMaintenanceParagraphEligible(paragraph) ||
        entry.beforeHash !== paragraph.hash ||
        !['update', 'revalidate', 'unresolved'].includes(entry.disposition) ||
        !boundedText2(entry.rationale, 1024) ||
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
        fail2('contradictory or unsupported paragraph disposition.');
      accounted.add(entry.ordinal);
    }
    if (
      input.operations.some(
        operation => !entries.some(entry => entry.ordinal === operation.ordinal && entry.disposition === 'update'),
      )
    )
      fail2('paragraph disposition is missing for a replacement.');
    if (basis.paragraphs.some(item => topicMaintenanceParagraphEligible(item) && !accounted.has(item.ordinal)))
      fail2('paragraph dispositions omit an eligible descriptive paragraph.');
  }
  return input;
}
function assemble(basis, draft) {
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
    fail2('assembled body exceeds bounds or changes paragraph count.');
  return {
    version: 1,
    draft,
    body,
    finalBodyHash: consolidationRevision(body),
    changedOrdinals: [...replacements.keys()].sort((left, right) => left - right),
  };
}
function parseTopicMaintenanceDraft(basisInput, rawJson, options = {}) {
  const basis = validateTopicMaintenanceDraftBasis(basisInput);
  if (!boundedText2(rawJson, MAX_TOPIC_MAINTENANCE_DRAFT_BYTES)) fail2('model output is empty or oversized.');
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    fail2('model output is not closed JSON.');
  }
  const draft = validateDraft(parsed, basis);
  if (options.requireParagraphDispositions && !draft.paragraphDispositions)
    fail2('explicit paragraph dispositions are required.');
  return assemble(basis, draft);
}
function validateTopicMaintenanceReviewEvidence(basisInput, input) {
  const basis = validateTopicMaintenanceDraftBasis(basisInput);
  if (!Array.isArray(input) || input.length > 16 || jsonBytes(input) > MAX_TOPIC_MAINTENANCE_REVIEW_BYTES)
    fail2('invalid or oversized private review evidence.');
  const known = new Set(basis.handles.map(handle => handle.id));
  const evidenceSeen = new Set();
  const citations = new Map();
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
      !boundedText2(evidence.content, 1024) ||
      evidence.excerptHash !== consolidationRevision(evidence.content) ||
      typeof evidence.fileBytesHash !== 'string' ||
      !HASH2.test(evidence.fileBytesHash) ||
      !Number.isSafeInteger(evidence.startLine) ||
      evidence.startLine < 1 ||
      !Number.isSafeInteger(evidence.endLine) ||
      evidence.endLine < evidence.startLine ||
      evidence.endLine - evidence.startLine >= 8 ||
      evidence.content.split(`
`).length !==
        evidence.endLine - evidence.startLine + 1 ||
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
      fail2('private review evidence is unknown, duplicate, or malformed.');
    let citation;
    try {
      citation = assertMemoryCodeCitation(evidence.citation);
    } catch {
      fail2('private review evidence has an invalid code citation.');
    }
    if (citation.sourceDirty || citation.evidenceRetention !== 'capsule-retained')
      fail2('private review code citation is dirty or not retained.');
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
      fail2('private review excerpt source differs from its pinned citation.');
    const handle = basis.handles.find(item => item.id === evidence.handleId);
    if (handle.variant === 'historical' && citation.id !== handle.citationId)
      fail2('historical review evidence changed the original citation.');
    citations.set(evidence.handleId, citation);
    evidenceSeen.add(evidence.handleId);
  }
  if (known.size !== evidenceSeen.size) fail2('private review omitted a packet evidence handle.');
  for (const handle of basis.handles) {
    if (handle.variant !== 'current') continue;
    const original = citations.get(`historical:${handle.citationId}`);
    const current = citations.get(handle.id);
    if (current.repositoryId !== original.repositoryId || current.target.kind !== original.target.kind)
      fail2('current review evidence changed repository or citation kind.');
    if (
      original.target.kind === 'symbol' &&
      current.target.kind === 'symbol' &&
      (current.target.language !== original.target.language ||
        current.target.symbolKind !== original.target.symbolKind ||
        current.target.name !== original.target.name ||
        current.target.qualifiedName !== original.target.qualifiedName)
    )
      fail2('current review evidence changed the declared symbol locator.');
  }
  return input;
}
function validateTopicMaintenanceReviewPayload(input) {
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
    !boundedText2(input.generation.agent, 64) ||
    !boundedText2(input.generation.model, 256) ||
    (input.generation.modelVersion !== undefined && !boundedText2(input.generation.modelVersion, 256)) ||
    !boundedText2(input.generation.promptVersion, 64) ||
    !object(input.generation.usage)
  )
    fail2('invalid or oversized private review payload.');
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
      fail2('Invalid generation observation identity.');
  }
  const usage = input.generation.usage;
  if (
    (usage.status === 'unavailable' && !keys(usage, ['status'])) ||
    (usage.status === 'measured' &&
      (!keys(usage, ['status', 'inputTokens', 'outputTokens']) ||
        ![usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0))) ||
    !['unavailable', 'measured'].includes(usage.status)
  )
    fail2('invalid provider usage receipt.');
  if (input.generation.origin === 'manual') {
    if (
      input.generation.agent !== 'manual' ||
      input.generation.model !== 'none' ||
      input.generation.modelVersion !== undefined ||
      input.generation.promptVersion !== 'manual-topic-v1' ||
      input.generation.attempts !== 0 ||
      usage.status !== 'unavailable'
    )
      fail2('invalid manual review origin receipt.');
  } else if (
    (input.generation.origin !== undefined && input.generation.origin !== 'model') ||
    ![1, 2].includes(input.generation.attempts)
  )
    fail2('invalid model generation receipt.');
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
      fail2('Generation observation differs from its basis or complete usage.');
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
    fail2('private review proposal differs from deterministic assembly.');
  return input;
}

// packages/memory/src/topic-maintenance-acceptance.ts
var HASH3 = /^[a-f0-9]{64}$/u;
var utf8Bytes = value => new TextEncoder().encode(value).byteLength;
var MAX_TOPIC_MAINTENANCE_PREVIEW_BYTES = 256 * 1024;
function fail3(message) {
  throw new Error(`Topic maintenance acceptance: ${message}`);
}
function exactKeys2(value, required, optional = []) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  );
}
function checkedTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    fail3('approval timestamp must be canonical ISO time.');
}
function approvalDigest(preview) {
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
function rawBodyWithReviewedReplacements(rawBody, acceptedBody, proposal) {
  if (proposal.body === acceptedBody) return rawBody;
  const chunks = [];
  let cursor = 0;
  const add = end => {
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
    chunks.some(
      (chunk, index) =>
        chunk.text.replace(
          /\r\n/gu,
          `
`,
        ) !== sections[index],
    )
  )
    fail3('raw target paragraph geometry differs from the reviewed body.');
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
function patchHeader(header, replacements, optional) {
  const parts = header.split(/(\r?\n)/u);
  const rows = Array.from({length: Math.ceil(parts.length / 2)}, (_, index) => ({
    text: parts[index * 2] ?? '',
    ending: parts[index * 2 + 1] ?? '',
  }));
  const ending =
    rows.find(row => row.ending)?.ending ??
    `
`;
  const output = [];
  for (const [key, values] of Object.entries(replacements)) {
    const matched = rows.filter(row => /^\s*[^:]+\s*:/u.test(row.text) && row.text.trimStart().startsWith(`${key}:`));
    if (key !== 'code_citation' && matched.length > 1) fail3(`duplicate ${key} header.`);
    if (!matched.length && !optional.includes(key)) fail3(`missing ${key} header.`);
    if (matched.some(row => !row.text.startsWith(`${key}: `))) fail3(`noncanonical ${key} header.`);
    if (values.length === 0 && key !== 'code_citation') fail3(`empty ${key} replacement.`);
  }
  const done = new Set();
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
function metadataDiff(before, after) {
  const keys = [
    'schema_version',
    'body',
    'topic_maintenance',
    'code_citation',
    'consolidation',
    'updated_at',
    'last_reviewed',
  ];
  const values = (content, key) => {
    const boundary = /\r?\n\r?\n/u.exec(content);
    const header = boundary ? content.slice(0, boundary.index) : content;
    if (key === 'body') return boundary ? content.slice(boundary.index + boundary[0].length) : '';
    return header.split(/\r?\n/u).filter(line => line.startsWith(`${key}: `)).join(`
`);
  };
  return keys.flatMap(field => {
    const oldValue = values(before, field);
    const newValue = values(after, field);
    return oldValue === newValue
      ? []
      : [{field, beforeHash: consolidationRevision(oldValue), afterHash: consolidationRevision(newValue)}];
  });
}
function assembleTopicMaintenanceAcceptance(record, reviewInput, options) {
  const review = validateTopicMaintenanceReviewPayload(reviewInput);
  assertMemoryDocumentSchemaWritable(record.content);
  checkedTimestamp(options.approvedAt);
  if (!/^review-[a-z0-9-]{1,80}$/u.test(options.reviewId)) fail3('invalid review identity.');
  const old = record.metadata.topicMaintenance;
  if (!old || record.metadata.topicMaintenanceError || record.metadata.citationErrors?.length)
    fail3('target is not a valid enrolled topic.');
  validateTopicMaintenanceManifest(old, record);
  const before = canonicalMemoryDocumentContent(record.content);
  if (
    review.basis.targetUri !== record.uri ||
    review.basis.targetHash !== consolidationRevision(before) ||
    review.basis.body !== record.body ||
    JSON.stringify(review.basis.paragraphs) !== JSON.stringify(old.paragraphs) ||
    JSON.stringify(review.basis.additionalDependencies) !== JSON.stringify(old.additionalDependencies)
  )
    fail3('review basis differs from the accepted target.');
  const approvedProposal =
    options.editedDraftJson === undefined
      ? review.proposal
      : parseTopicMaintenanceDraft(review.basis, options.editedDraftJson);
  if (!['propose-update', 'propose-revalidation'].includes(approvedProposal.draft.outcome))
    fail3('review outcome has no acceptable update.');
  if (approvedProposal.body !== record.body && (record.metadata.sourceEvidence || record.metadata.obsidianEvidence))
    fail3('body-bound imported evidence cannot yet be rebuilt for a changed topic body.');
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
        ? [...new Set(supportHandles.map(handle => evidence.get(handle).citation.id))].sort()
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
  const manifest = {
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
  const citationsById = new Map(preserved.map(citation => [citation.id, citation]));
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
    .map(id => citationsById.get(id) ?? fail3(`missing reviewed citation ${id}.`))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (codeCitations.length > MAX_MEMORY_CODE_CITATIONS)
    fail3(`citation union has ${codeCitations.length} entries; limit is ${MAX_MEMORY_CODE_CITATIONS}.`);
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
  if (!separator) fail3('target document lacks a canonical header/body boundary.');
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
    fail3('prepared document failed exact provenance readback.');
  validateTopicMaintenanceManifest(manifest, parsed);
  const base = {
    version: 1,
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
    fail3('prepared approval preview exceeds the 256 KiB limit.');
  return preview;
}
function validateTopicMaintenanceAcceptancePreview(input, reviewInput) {
  const review = validateTopicMaintenanceReviewPayload(reviewInput);
  if (
    !exactKeys2(
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
    !HASH3.test(input.approvalDigest) ||
    !Array.isArray(input.codeCitations) ||
    !Array.isArray(input.metadataDiff)
  )
    fail3('approval preview is malformed or oversized.');
  checkedTimestamp(input.approvedAt);
  if (!exactKeys2(input.approvedProposal, ['version', 'draft', 'body', 'finalBodyHash', 'changedOrdinals']))
    fail3('approved proposal is malformed.');
  const proposal = parseTopicMaintenanceDraft(review.basis, JSON.stringify(input.approvedProposal.draft));
  if (JSON.stringify(proposal) !== JSON.stringify(input.approvedProposal))
    fail3('approved proposal differs from its reviewed draft.');
  const parsed = parseMemoryDocument(input.targetUri, input.content);
  const prior = parseMemoryDocument(input.targetUri, input.beforeContent);
  if (
    !prior ||
    consolidationRevision(canonicalMemoryDocumentContent(prior.content)) !== review.basis.targetHash ||
    prior.body !== review.basis.body ||
    input.targetUri !== review.basis.targetUri
  )
    fail3('approval preview has a stale original target.');
  if (
    !parsed ||
    parsed.metadata.citationErrors?.length ||
    parsed.metadata.topicMaintenance?.version !== 2 ||
    parsed.body !== proposal.body ||
    JSON.stringify(parsed.metadata.topicMaintenance) !== JSON.stringify(input.manifest) ||
    JSON.stringify(parsed.metadata.codeCitations) !== JSON.stringify(input.codeCitations) ||
    JSON.stringify(parsed.metadata.consolidation ?? null) !== JSON.stringify(input.consolidation ?? null)
  )
    fail3('approval preview has invalid final document provenance.');
  const preview = input;
  const {approvalDigest: digest, ...base} = preview;
  if (approvalDigest(base) !== digest) fail3('approval preview digest differs from final document.');
  const reproduced = assembleTopicMaintenanceAcceptance(prior, review, {
    reviewId: preview.reviewId,
    approvedAt: preview.approvedAt,
    editedDraftJson: JSON.stringify(preview.approvedProposal.draft),
  });
  if (JSON.stringify(reproduced) !== JSON.stringify(preview))
    fail3('approval preview differs from the exact reviewed transformation.');
  return preview;
}
function validateTopicMaintenanceApprovalReceipt(input, reviewPayload, reviewId, revision) {
  if (
    !exactKeys2(input, ['version', 'reviewRevision', 'stage', 'preview']) ||
    input.version !== 1 ||
    !Number.isSafeInteger(input.reviewRevision) ||
    input.reviewRevision < 1 ||
    input.reviewRevision > revision ||
    !['preview', 'parked', 'prepared', 'written', 'conflict'].includes(input.stage)
  )
    fail3('approval receipt is malformed.');
  const preview = validateTopicMaintenanceAcceptancePreview(input.preview, reviewPayload);
  if (preview.reviewId !== reviewId || (input.stage === 'preview' && input.reviewRevision !== revision))
    fail3('approval receipt differs from its review identity or revision.');
  return input;
}

// packages/memory/src/candidate.ts
function validTopicClosedConflict(review) {
  const closed = review.maintenanceClosedConflict;
  if (closed === undefined) return true;
  if (
    !review.maintenance ||
    typeof closed !== 'object' ||
    closed === null ||
    Object.keys(closed).sort().join(',') !==
      'approvalDigest,beforeContentHash,contentHash,reviewRevision,targetUri,version' ||
    closed.version !== 1 ||
    !Number.isSafeInteger(closed.reviewRevision) ||
    closed.reviewRevision < 1 ||
    closed.reviewRevision > review.revision ||
    closed.targetUri !== review.maintenance.basis.targetUri ||
    ![closed.beforeContentHash, closed.contentHash, closed.approvalDigest].every(value => /^[a-f0-9]{64}$/u.test(value))
  )
    return false;
  const approval = review.maintenanceApproval;
  if (approval === undefined) return true;
  if (approval.reviewRevision > closed.reviewRevision) return true;
  return (
    approval.reviewRevision === closed.reviewRevision &&
    approval.stage === 'conflict' &&
    approval.preview.targetUri === closed.targetUri &&
    approval.preview.beforeContentHash === closed.beforeContentHash &&
    approval.preview.contentHash === closed.contentHash &&
    approval.preview.approvalDigest === closed.approvalDigest
  );
}

class CandidateMemoryError extends Schema4.TaggedError()('CandidateMemoryError', {
  cause: Schema4.optionalKey(Schema4.Defect()),
  message: Schema4.String,
}) {}
var MEMORY_READ_CONCURRENCY = 16;
var MAX_CANDIDATE_AUDIT_EVENTS = 5000;
var MAX_CANDIDATE_REVIEW_BYTES = 512 * 1024;
var MAX_CANDIDATE_REVIEWS = 500;
var MAX_CLOSEOUT_ITEMS_PER_FIELD = 32;
var MAX_CLOSEOUT_ITEM_CHARACTERS = 2000;
var MAX_CLOSEOUT_SCALAR_CHARACTERS = 4000;
var MAX_CLOSEOUT_EVIDENCE_POINTERS = 32;
var MAX_CLOSEOUT_TOTAL_BYTES = 64 * 1024;
var MAX_STRUCTURED_CLOSEOUT_ITEMS = MAX_CLOSEOUT_ITEMS_PER_FIELD;
var MAX_EXACT_DURABLE_CANDIDATE_BYTES = 60 * 1024;
var MAX_REPLACEMENT_BASELINE_SECTIONS = 32;
var TERMINAL_REVIEW_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
var CANDIDATE_LOCK_STALE_MILLISECONDS = 5 * 60 * 1000;
var CANDIDATE_LOCK_RETRY_MILLISECONDS = 25;
var CANDIDATE_LOCK_WAIT_TIMEOUT_MILLISECONDS = 5000;
var CANDIDATE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: CANDIDATE_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: CANDIDATE_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: CANDIDATE_LOCK_WAIT_TIMEOUT_MILLISECONDS,
};
var buildCandidateReview = Effect.fn('candidate.buildReview')(function* (input, existing, now) {
  return yield* buildCandidateReviewFromDrafts(input, existing, now, candidateDrafts(input));
});
var buildExactDurableCandidateReview = Effect.fn('candidate.buildExactDurableReview')(
  function* (input, proposedText, existing, now) {
    const validationError = validateSessionCloseoutInput(input);
    if (validationError) return yield* CandidateMemoryError.make({message: validationError});
    const text = proposedText.trim();
    if (!text) return yield* CandidateMemoryError.make({message: 'Exact durable candidate text is empty.'});
    if (new TextEncoder().encode(text).byteLength > MAX_EXACT_DURABLE_CANDIDATE_BYTES)
      return yield* CandidateMemoryError.make({
        message: `Exact durable candidate exceeds ${MAX_EXACT_DURABLE_CANDIDATE_BYTES} UTF-8 bytes.`,
      });
    return yield* buildCandidateReviewFromDrafts(input, existing, now, [
      {categories: ['invariant'], kind: 'durable', proposedText: text},
    ]);
  },
);
var buildCandidateReviewFromDrafts = Effect.fn('candidate.buildReviewFromDrafts')(
  function* (input, existing, now, drafts) {
    const createdAt = now.toISOString();
    const reviewId = `review-${(yield* sha256Hex(
      [input.project, input.topic, input.sourceSessionId ?? '', input.task, createdAt].join(`
`),
    )).slice(0, 16)}`;
    const evidence = candidateEvidence(input);
    const candidates =
      evidence.length === 0
        ? []
        : yield* Effect.forEach(
            drafts.slice(0, 3),
            (draft, index) => compareCandidate(reviewId, index, input, draft, existing, evidence),
            {concurrency: 3},
          );
    const structuredCloseout = structuredCloseoutFromInput(input);
    return {
      auditEvents: [
        {
          action: 'create_review',
          at: createdAt,
          reviewId,
          revision: 1,
        },
      ],
      candidates,
      codeCitations: input.codeCitations ?? [],
      createdAt,
      outcome: input.outcome,
      project: input.project,
      reviewId,
      revision: 1,
      sourceAgentClient: input.sourceAgentClient,
      sourceCommit: input.sourceCommit,
      sourceSessionId: input.sourceSessionId,
      ...(structuredCloseout ? {structuredCloseout} : {}),
      task: input.task,
      topic: input.topic,
      version: 2,
    };
  },
);
function validateSessionCloseoutInput(input) {
  const scalarFields = [
    ['task', input.task],
    ['outcome', input.outcome],
    ['project', input.project],
    ['topic', input.topic],
    ['sourceAgentClient', input.sourceAgentClient],
    ['sourceCommit', input.sourceCommit],
    ['sourceSessionId', input.sourceSessionId],
    ['rationale', input.rationale],
  ];
  for (const [name, value] of scalarFields) {
    if ((value?.length ?? 0) > MAX_CLOSEOUT_SCALAR_CHARACTERS) {
      return `${name} exceeds ${MAX_CLOSEOUT_SCALAR_CHARACTERS} characters.`;
    }
  }
  const listFields = [
    ['decisions', input.decisions, MAX_CLOSEOUT_ITEMS_PER_FIELD],
    ['evidence', input.evidence, MAX_CLOSEOUT_EVIDENCE_POINTERS],
    ['handoff', input.handoff, MAX_CLOSEOUT_ITEMS_PER_FIELD],
    ['invariants', input.invariants, MAX_CLOSEOUT_ITEMS_PER_FIELD],
    ['preferences', input.preferences, MAX_CLOSEOUT_ITEMS_PER_FIELD],
    ['constraints', input.constraints, MAX_STRUCTURED_CLOSEOUT_ITEMS],
    ['verificationPerformed', input.verificationPerformed, MAX_STRUCTURED_CLOSEOUT_ITEMS],
    ['knowledgeInvalidated', input.knowledgeInvalidated, MAX_STRUCTURED_CLOSEOUT_ITEMS],
    ['unresolvedRisks', input.unresolvedRisks, MAX_STRUCTURED_CLOSEOUT_ITEMS],
  ];
  for (const [name, values, maximumItems] of listFields) {
    if ((values?.length ?? 0) > maximumItems) {
      return `${name} exceeds ${maximumItems} items.`;
    }
    if ((values ?? []).some(value => value.length > MAX_CLOSEOUT_ITEM_CHARACTERS)) {
      return `${name} contains an item exceeding ${MAX_CLOSEOUT_ITEM_CHARACTERS} characters.`;
    }
  }
  if (input.structuredCloseout !== undefined) {
    const structuredError = validateStructuredCloseout(input.structuredCloseout);
    if (structuredError) return structuredError;
  }
  const totalBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  return totalBytes > MAX_CLOSEOUT_TOTAL_BYTES
    ? `session closeout exceeds ${MAX_CLOSEOUT_TOTAL_BYTES} UTF-8 bytes.`
    : undefined;
}
function structuredCloseoutFromInput(input) {
  const nested = input.structuredCloseout;
  const hasDirectFields =
    input.rationale !== undefined ||
    input.constraints !== undefined ||
    input.verificationPerformed !== undefined ||
    input.knowledgeInvalidated !== undefined ||
    input.unresolvedRisks !== undefined;
  if (!nested && !hasDirectFields) return;
  const structured = {
    type: 'structured-closeout',
    version: 1,
    rationale: (nested?.rationale ?? input.rationale ?? '').trim(),
    constraints: normalizedItems(nested?.constraints ?? input.constraints),
    verificationPerformed: normalizedItems(nested?.verificationPerformed ?? input.verificationPerformed),
    knowledgeInvalidated: normalizedItems(nested?.knowledgeInvalidated ?? input.knowledgeInvalidated),
    unresolvedRisks: normalizedItems(nested?.unresolvedRisks ?? input.unresolvedRisks),
  };
  return structured.rationale ||
    structured.constraints.length > 0 ||
    structured.verificationPerformed.length > 0 ||
    structured.knowledgeInvalidated.length > 0 ||
    structured.unresolvedRisks.length > 0
    ? structured
    : undefined;
}
function validateStructuredCloseout(value) {
  if (value.type !== 'structured-closeout' || value.version !== 1) {
    return 'structuredCloseout has an unsupported type or version.';
  }
  if (value.rationale.length > MAX_CLOSEOUT_SCALAR_CHARACTERS) {
    return `rationale exceeds ${MAX_CLOSEOUT_SCALAR_CHARACTERS} characters.`;
  }
  const lists = [
    ['constraints', value.constraints],
    ['verificationPerformed', value.verificationPerformed],
    ['knowledgeInvalidated', value.knowledgeInvalidated],
    ['unresolvedRisks', value.unresolvedRisks],
  ];
  for (const [name, items] of lists) {
    if (items.length > MAX_STRUCTURED_CLOSEOUT_ITEMS) return `${name} exceeds ${MAX_STRUCTURED_CLOSEOUT_ITEMS} items.`;
    if (items.some(item => item.length > MAX_CLOSEOUT_ITEM_CHARACTERS)) {
      return `${name} contains an item exceeding ${MAX_CLOSEOUT_ITEM_CHARACTERS} characters.`;
    }
  }
  return;
}
var readActiveProjectMemories = Effect.fn('candidate.readActiveProjectMemories')(function* (config, project) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const root = pathService.join(
    config.agentContextHome,
    'data',
    config.account,
    'user',
    uriSegment(config.user),
    'memories',
  );
  const projectSegment = uriSegment(project);
  const directDirectories = [
    pathService.join(root, 'durable', 'projects', projectSegment),
    pathService.join(root, 'handoffs', 'active', projectSegment),
  ];
  const paths = [];
  for (const directory of directDirectories) {
    paths.push(...(yield* markdownFiles(fs, directory, root)));
  }
  paths.push(...(yield* markdownFiles(fs, pathService.join(root, 'preferences'), root, false)));
  const sharedRoot = pathService.join(root, 'shared');
  const teams = yield* safeChildDirectoryNames(fs, sharedRoot, root);
  if (teams.length > 0) {
    const sharedPaths = yield* Effect.forEach(
      teams,
      team => markdownFiles(fs, pathService.join(sharedRoot, team, 'durable', 'projects', projectSegment), root),
      {concurrency: MEMORY_READ_CONCURRENCY},
    );
    paths.push(...sharedPaths.flat());
  }
  const records = yield* Effect.forEach(
    [...new Set(paths)],
    path =>
      Effect.gen(function* () {
        const content = yield* fs.readFileString(path);
        const relative = pathService.relative(root, path).split(pathService.sep).join('/');
        const record = parseMemoryDocument2(
          `threadnote://user/${uriSegment(config.user)}/memories/${relative}`,
          content,
        );
        return record?.metadata.status === 'active' &&
          (record.metadata.project === project || record.metadata.kind === 'preference')
          ? record
          : undefined;
      }),
    {concurrency: MEMORY_READ_CONCURRENCY},
  );
  return records.filter(record => record !== undefined);
});
var saveCandidateReview = Effect.fn('candidate.saveReview')(function* (agentContextHome, review) {
  if (review.maintenance !== undefined)
    yield* Effect.try({
      try: () => validateTopicMaintenanceReviewPayload(review.maintenance),
      catch: cause => CandidateMemoryError.make({message: errorText(cause)}),
    });
  if (!validTopicClosedConflict(review))
    return yield* CandidateMemoryError.make({message: 'invalid closed topic conflict receipt'});
  if (review.maintenanceApproval !== undefined)
    yield* Effect.try({
      try: () => {
        if (!review.maintenance) throw new Error('Approval requires a maintenance review.');
        validateTopicMaintenanceApprovalReceipt(
          review.maintenanceApproval,
          review.maintenance,
          review.reviewId,
          review.revision,
        );
      },
      catch: cause => CandidateMemoryError.make({message: errorText(cause)}),
    });
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = candidateReviewPath(pathService, agentContextHome, review.reviewId);
  const serialized = `${JSON.stringify(review, undefined, 2)}
`;
  if (new TextEncoder().encode(serialized).byteLength > MAX_CANDIDATE_REVIEW_BYTES) {
    return yield* CandidateMemoryError.make({
      message: `Candidate review exceeds the ${MAX_CANDIDATE_REVIEW_BYTES}-byte persistence limit.`,
    });
  }
  yield* writePrivateFileAtomically(fs, path, serialized);
  yield* syncCandidateAudit(agentContextHome, review.auditEvents);
  yield* pruneCandidateReviews(fs, pathService.dirname(path), review.reviewId);
  return path;
});
var loadCandidateReview = Effect.fn('candidate.loadReview')(function* (agentContextHome, reviewId) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = candidateReviewPath(pathService, agentContextHome, reviewId);
  const raw = yield* fs.readFileString(path);
  const review = yield* Effect.try({
    try: () => parseCandidateReview(JSON.parse(raw)),
    catch: cause => CandidateMemoryError.make({message: `Invalid candidate review ${reviewId}: ${errorText(cause)}`}),
  });
  yield* syncCandidateAudit(agentContextHome, review.auditEvents);
  return review;
});
var loadCandidateReviewOptional = Effect.fn('candidate.loadReviewOptional')(function* (agentContextHome, reviewId) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = candidateReviewPath(pathService, agentContextHome, reviewId);
  return (yield* fs.exists(path)) ? yield* loadCandidateReview(agentContextHome, reviewId) : undefined;
});
var listCandidateReviews = Effect.fn('candidate.listReviews')(function* (agentContextHome) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const directory = pathService.join(agentContextHome, 'threadnote', 'candidates', 'v1', 'reviews');
  const entries = yield* fs.readDirectory(directory).pipe(Effect.option);
  if (entries._tag === 'None') return [];
  const reviews = yield* Effect.forEach(
    entries.value
      .filter(name => name.endsWith('.json') && !name.startsWith('.'))
      .sort()
      .slice(-MAX_CANDIDATE_REVIEWS),
    name =>
      Effect.gen(function* () {
        const raw = yield* fs.readFileString(pathService.join(directory, name));
        return yield* Effect.try({
          try: () => parseCandidateReview(JSON.parse(raw)),
          catch: () => {
            return;
          },
        }).pipe(
          Effect.orElseSucceed(() => {
            return;
          }),
        );
      }),
    {concurrency: MEMORY_READ_CONCURRENCY},
  );
  return reviews
    .filter(review => review !== undefined)
    .sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.reviewId.localeCompare(right.reviewId),
    );
});
var appendCandidateAudit = Effect.fn('candidate.appendAudit')(function* (agentContextHome, event) {
  return yield* syncCandidateAudit(agentContextHome, [event]);
});
var syncCandidateAudit = Effect.fn('candidate.syncAudit')(function* (agentContextHome, events) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = pathService.join(agentContextHome, 'threadnote', 'candidates', 'v1', 'audit.jsonl');
  yield* withExclusiveFileLock(
    fs,
    `${path}.lock`,
    CANDIDATE_LOCK_OPTIONS,
    Effect.gen(function* () {
      const existing = yield* readCandidateAudit(fs, path);
      const eventKeys = new Set(existing.map(candidateAuditEventKey));
      const additions = events.filter(event => {
        const key = candidateAuditEventKey(event);
        if (eventKeys.has(key)) {
          return false;
        }
        eventKeys.add(key);
        return true;
      });
      if (additions.length > 0) {
        const bounded = [...existing, ...additions]
          .sort((left, right) => candidateAuditTimestamp(left) - candidateAuditTimestamp(right))
          .slice(-MAX_CANDIDATE_AUDIT_EVENTS);
        if (
          bounded.map(candidateAuditEventKey).join(`
`) !==
          existing.map(candidateAuditEventKey).join(`
`)
        ) {
          yield* writePrivateFileAtomically(
            fs,
            path,
            `${bounded.map(item => JSON.stringify(item)).join(`
`)}
`,
          );
        }
      }
    }),
  );
  return path;
});
function candidateAuditEventKey(event) {
  return [
    event.action,
    event.allowDestructiveReplacement === true ? 'destructive-approved' : '',
    event.candidateId ?? '',
    event.reviewId,
    event.revision,
  ].join(`
`);
}
function candidateAuditTimestamp(event) {
  const timestamp = Date.parse(event.at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
function candidateDrafts(input) {
  const decisions = normalizedItems(input.decisions);
  const invariants = normalizedItems(input.invariants);
  const preferences = normalizedItems(input.preferences);
  const handoff = normalizedItems(input.handoff);
  const structuredCloseout = structuredCloseoutFromInput(input);
  const drafts = [];
  if (decisions.length > 0 || invariants.length > 0 || structuredCloseout !== undefined) {
    drafts.push({
      categories: [
        ...(decisions.length > 0 ? ['decision'] : []),
        ...(invariants.length > 0 || structuredCloseout !== undefined ? ['invariant'] : []),
      ],
      kind: 'durable',
      proposedText: formatSections([
        ['Decisions', decisions],
        ['Invariants', invariants],
        ...(structuredCloseout ? structuredCloseoutSections(structuredCloseout) : []),
      ]),
    });
  }
  if (preferences.length > 0) {
    drafts.push({
      categories: ['preference'],
      kind: 'preference',
      proposedText: formatSections([['Preferences', preferences]]),
    });
  }
  if (handoff.length > 0) {
    drafts.push({
      categories: ['handoff'],
      kind: 'handoff',
      proposedText: formatSections([['Handoff state', handoff]]),
    });
  }
  return drafts;
}
var compareCandidate = Effect.fn('candidate.compare')(function* (reviewId, index, input, draft, existing, evidence) {
  const sameTarget = existing
    .filter(
      record =>
        record.metadata.kind === draft.kind &&
        (draft.kind === 'preference' || record.metadata.project === input.project) &&
        record.metadata.topic === input.topic,
    )
    .sort((left, right) => right.metadata.timestamp.localeCompare(left.metadata.timestamp))[0];
  const mostSimilar = bestSimilarRecord(draft.proposedText, existing, input.project, draft.kind);
  const comparison = classifyComparison(draft.proposedText, sameTarget, mostSimilar);
  const target = sameTarget ?? (comparison === 'possible_duplicate' ? mostSimilar?.record : undefined);
  const recommendation =
    comparison === 'duplicate'
      ? 'no_action'
      : comparison === 'replacement'
        ? 'replace'
        : comparison === 'contradiction' || comparison === 'possible_duplicate'
          ? 'manual_review'
          : 'create';
  return {
    candidateId: `${reviewId}-${index + 1}`,
    categories: draft.categories,
    comparison,
    confidence:
      comparison === 'duplicate' ? 0.99 : comparison === 'replacement' ? 0.9 : comparison === 'new' ? 0.82 : 0.65,
    evidence,
    kind: draft.kind,
    project: input.project,
    proposedText: draft.proposedText,
    reason: comparisonReason(comparison),
    recommendation,
    ...(target ? {replacementSafetyBaseline: replacementSafetyBaseline(target.body)} : {}),
    state: 'pending',
    targetContentHash: target ? yield* sha256Hex(canonicalMemoryDocumentContent2(target.content)) : undefined,
    targetUri: target?.uri,
    topic: input.topic,
  };
});
function replacementSafetyBaseline(body) {
  const normalizedBody = body.trim();
  const sections = sectionHeadings(normalizedBody);
  return {
    bodyCharacters: normalizedBody.length,
    nonEmptyLines: nonEmptyLineCount(normalizedBody),
    sectionHeadings: sections.slice(0, MAX_REPLACEMENT_BASELINE_SECTIONS),
    sectionListTruncated: sections.length > MAX_REPLACEMENT_BASELINE_SECTIONS,
    version: 1,
  };
}
function sectionHeadings(body) {
  const seen = new Set();
  const sections = [];
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const section =
      parseMarkdownHeadingLine(trimmed)?.title ??
      (/^[^\s].{0,118}:$/u.test(trimmed) && !/^[-*+]\s/u.test(trimmed) ? trimmed.slice(0, -1).trim() : undefined);
    if (!section) continue;
    const key = normalizedSectionKey(section);
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push(section);
  }
  return sections;
}
function normalizedSectionKey(section) {
  return section.replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}
function nonEmptyLineCount(body) {
  return body.split(/\r?\n/u).filter(line => line.trim().length > 0).length;
}
function classifyComparison(proposedText, sameTarget, mostSimilar) {
  if (sameTarget) {
    if (textSimilarity(proposedText, sameTarget.body) >= 0.92) {
      return 'duplicate';
    }
    return looksContradictory(proposedText, sameTarget.body) ? 'contradiction' : 'replacement';
  }
  if (mostSimilar && mostSimilar.similarity >= 0.82) {
    return 'possible_duplicate';
  }
  return 'new';
}
function bestSimilarRecord(proposedText, existing, project, kind) {
  return existing
    .filter(record => record.metadata.kind === kind && (kind === 'preference' || record.metadata.project === project))
    .map(record => ({record, similarity: textSimilarity(proposedText, record.body)}))
    .sort((left, right) => right.similarity - left.similarity)[0];
}
function textSimilarity(left, right) {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}
function looksContradictory(left, right) {
  const negative = /\b(?:cannot|disabled|doesn't|do not|must not|never|no|not)\b/i;
  const leftNegative = negative.test(left);
  const rightNegative = negative.test(right);
  if (leftNegative === rightNegative) {
    return false;
  }
  const withoutNegation = value => value.replace(/\b(?:cannot|disabled|doesn't|do not|must not|never|no|not)\b/gi, '');
  return textSimilarity(withoutNegation(left), withoutNegation(right)) >= 0.55;
}
function comparisonReason(comparison) {
  switch (comparison) {
    case 'duplicate':
      return 'An active memory already contains substantially the same information.';
    case 'replacement':
      return 'An active memory has the same stable project, topic, and kind; replace it to keep one current fact.';
    case 'contradiction':
      return 'The candidate may contradict the active memory for the same stable project and topic.';
    case 'possible_duplicate':
      return 'A similar active memory exists under another topic; review before creating another copy.';
    case 'new':
      return 'No active memory with the same stable identity or substantially similar content was found.';
  }
}
function normalizedItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items ?? []) {
    const normalized = item.replace(/\s+/g, ' ').trim();
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}
function candidateEvidence(input) {
  return normalizedItems([
    ...(input.evidence ?? []),
    ...(input.codeCitations ?? []).map(citation => `code-citation:${citation.id}`),
    ...(input.sourceSessionId ? [`session:${input.sourceSessionId}`] : []),
    ...(input.sourceCommit ? [`commit:${input.sourceCommit}`] : []),
  ]);
}
function formatSections(sections) {
  return sections
    .filter(([, items]) => items.length > 0)
    .flatMap(([title, items]) => [`## ${title}`, ...items.map(item => `- ${item}`)]).join(`
`);
}
function structuredCloseoutSections(value) {
  return [
    ['Rationale', value.rationale ? [value.rationale] : []],
    ['Constraints', value.constraints],
    ['Verification performed', value.verificationPerformed],
    ['Knowledge invalidated', value.knowledgeInvalidated],
    ['Unresolved risks', value.unresolvedRisks],
  ];
}
function tokens(value) {
  return [...value.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)].map(match => match[0]);
}
function candidateReviewPath(pathService, agentContextHome, reviewId) {
  const safeReviewId = reviewId.replace(/[^a-zA-Z0-9._-]/g, '');
  return pathService.join(agentContextHome, 'threadnote', 'candidates', 'v1', 'reviews', `${safeReviewId}.json`);
}
function writePrivateFileAtomically(fs, path, content) {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
    const crypto = yield* Crypto.Crypto;
    const temporaryPath = `${path}.${yield* crypto.randomUUIDv4()}.tmp`;
    yield* fs.writeFileString(temporaryPath, content, {mode: 384});
    yield* fs
      .rename(temporaryPath, path)
      .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
  });
}
function markdownFiles(fs, root, boundaryRoot, recursive = true) {
  return scanFilesWithinBoundary(fs, root, boundaryRoot, {
    includeFile: (_path, name) => name.endsWith('.md') && !name.startsWith('.'),
    recursive,
  }).pipe(Effect.map(files => files.map(file => file.path)));
}
function readCandidateAudit(fs, path) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) {
      return [];
    }
    const raw = yield* fs.readFileString(path);
    return raw
      .split(
        `
`,
      )
      .map(line =>
        line.trim() ? Option.getOrUndefined(Option.liftThrowable(content => JSON.parse(content))(line)) : undefined,
      )
      .filter(event => event !== undefined && candidateAuditEventIsValid(event))
      .slice(-MAX_CANDIDATE_AUDIT_EVENTS);
  });
}
function pruneCandidateReviews(fs, reviewDirectory, currentReviewId) {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const reviews = yield* Effect.forEach(
      (yield* fs.readDirectory(reviewDirectory)).filter(name => name.endsWith('.json')),
      name =>
        Effect.gen(function* () {
          const path = pathService.join(reviewDirectory, name);
          const info = yield* fs.stat(path);
          const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime() ?? now;
          const raw = yield* fs.readFileString(path);
          const review = yield* Effect.try({
            try: () => parseCandidateReview(JSON.parse(raw)),
            catch: () => {
              return;
            },
          }).pipe(
            Effect.orElseSucceed(() => {
              return;
            }),
          );
          return {modifiedAt, path, review};
        }),
      {concurrency: MEMORY_READ_CONCURRENCY},
    );
    const removable = reviews
      .filter(item => item.review?.reviewId !== currentReviewId)
      .sort(
        (left, right) =>
          candidateReviewRetentionPriority(left.review) - candidateReviewRetentionPriority(right.review) ||
          left.modifiedAt - right.modifiedAt,
      );
    let remaining = reviews.length;
    for (const item of removable) {
      const expired =
        candidateReviewIsTerminal(item.review) && now - item.modifiedAt > TERMINAL_REVIEW_RETENTION_MILLISECONDS;
      if (!expired && remaining <= MAX_CANDIDATE_REVIEWS) {
        break;
      }
      yield* fs.remove(item.path, {force: true});
      remaining -= 1;
    }
  });
}
function candidateReviewIsTerminal(review) {
  return (
    review?.candidates.every(
      candidate => candidate.state === 'applied' || candidate.state === 'conflict' || candidate.state === 'rejected',
    ) === true
  );
}
function candidateReviewRetentionPriority(review) {
  if (!review || candidateReviewIsTerminal(review)) {
    return 0;
  }
  if (review.candidates.every(candidate => candidate.state === 'deferred')) {
    return 1;
  }
  if (review.candidates.some(candidate => candidate.state === 'applying')) {
    return 3;
  }
  return 2;
}
function parseCandidateReview(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    (value.version !== 1 && value.version !== 2) ||
    !('reviewId' in value) ||
    typeof value.reviewId !== 'string' ||
    !('revision' in value) ||
    typeof value.revision !== 'number' ||
    !('candidates' in value) ||
    !Array.isArray(value.candidates)
  ) {
    throw CandidateMemoryError.make({message: 'unsupported review document'});
  }
  const review = value;
  let codeCitations = [];
  if (review.version !== 2 && (review.maintenance !== undefined || review.maintenanceApproval !== undefined))
    throw CandidateMemoryError.make({message: 'maintenance payload requires a v2 candidate review'});
  if (review.maintenanceApproval !== undefined && review.maintenance === undefined)
    throw CandidateMemoryError.make({message: 'maintenance approval requires a review payload'});
  if (review.version === 2) {
    if (!Array.isArray(review.codeCitations)) throw CandidateMemoryError.make({message: 'invalid v2 code citations'});
    try {
      codeCitations = review.codeCitations.map(assertMemoryCodeCitation2);
      formatMemoryCodeCitationLines2(codeCitations);
    } catch {
      throw CandidateMemoryError.make({message: 'invalid v2 code citations'});
    }
  }
  const parsed = {
    ...review,
    auditEvents: Array.isArray(review.auditEvents)
      ? review.auditEvents.filter(event => candidateAuditEventIsValid(event))
      : [],
    codeCitations,
    ...(review.structuredCloseout === undefined
      ? {}
      : {structuredCloseout: parseStructuredCloseout(review.structuredCloseout)}),
    ...(review.maintenance === undefined
      ? {}
      : {maintenance: validateTopicMaintenanceReviewPayload(review.maintenance)}),
    ...(review.maintenanceApproval === undefined
      ? {}
      : {
          maintenanceApproval: validateTopicMaintenanceApprovalReceipt(
            review.maintenanceApproval,
            review.maintenance,
            review.reviewId,
            review.revision,
          ),
        }),
    version: 2,
  };
  if (!validTopicClosedConflict(parsed))
    throw CandidateMemoryError.make({message: 'invalid closed topic conflict receipt'});
  return parsed;
}
function parseStructuredCloseout(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    value.type !== 'structured-closeout' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('rationale' in value) ||
    typeof value.rationale !== 'string' ||
    !('constraints' in value) ||
    !Array.isArray(value.constraints) ||
    !value.constraints.every(item => typeof item === 'string') ||
    !('verificationPerformed' in value) ||
    !Array.isArray(value.verificationPerformed) ||
    !value.verificationPerformed.every(item => typeof item === 'string') ||
    !('knowledgeInvalidated' in value) ||
    !Array.isArray(value.knowledgeInvalidated) ||
    !value.knowledgeInvalidated.every(item => typeof item === 'string') ||
    !('unresolvedRisks' in value) ||
    !Array.isArray(value.unresolvedRisks) ||
    !value.unresolvedRisks.every(item => typeof item === 'string')
  ) {
    throw CandidateMemoryError.make({message: 'invalid structured closeout'});
  }
  const structured = value;
  const error = validateStructuredCloseout(structured);
  if (error) throw CandidateMemoryError.make({message: error});
  return structured;
}
function candidateAuditEventIsValid(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'action' in value &&
    (value.action === 'apply' ||
      value.action === 'begin_apply' ||
      value.action === 'conflict' ||
      value.action === 'create_review' ||
      value.action === 'defer' ||
      value.action === 'refresh_safety' ||
      value.action === 'reject' ||
      value.action === 'resume') &&
    (!('allowDestructiveReplacement' in value) || typeof value.allowDestructiveReplacement === 'boolean') &&
    'at' in value &&
    typeof value.at === 'string' &&
    'reviewId' in value &&
    typeof value.reviewId === 'string' &&
    'revision' in value &&
    typeof value.revision === 'number'
  );
}
function errorText(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
export {parseCandidateReview};
