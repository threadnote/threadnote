// Frozen schema10 writer oracle, bundled from HEAD724cc6def34c1fd9630d309e8f9c9e9ff7096814 before Phase7 edits.
// Do not rebuild from current source: this fixture tests the old writer contract.
// @bun
// packages/memory/src/code/citation.ts
import {Predicate, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
var MEMORY_SCHEMA_VERSION = 10;
var MEMORY_CODE_CITATION_SCHEMA_VERSION = 4;
var MEMORY_CODE_CITATION_VERSION = 1;
var MEMORY_CODE_CITATION_HEADER = 'code_citation';
var MAX_MEMORY_CODE_CITATIONS = 8;
var MAX_MEMORY_CODE_CITATION_ENTRY_BYTES = 8 * 1024;
var MAX_MEMORY_CODE_CITATION_AGGREGATE_BYTES = 64 * 1024;

class MemoryCodeCitationValidationError extends Schema.TaggedError()('MemoryCodeCitationValidationError', {
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
}) {
  static of(reason) {
    return MemoryCodeCitationValidationError.make({
      message: CITATION_ERROR_MESSAGES[reason],
      reason,
    });
  }
}

class UnsupportedMemorySchemaVersionError extends Schema.TaggedError()('UnsupportedMemorySchemaVersionError', {
  message: Schema.String,
  schemaVersion: Schema.Finite,
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
      error: {reason: Schema.is(MemoryCodeCitationValidationError)(error) ? error.reason : 'invalid-shape'},
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
  return `tncc_${sha256HexSync(`threadnote-memory-code-citation-v1\x00${identity}`).slice(0, 40)}`;
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

// packages/memory/src/consolidation.ts
import {sha256HexSync as sha256HexSync2} from '@threadnote/platform/sha256';
import {Schema as Schema2} from 'effect';
import {parseResourceId} from '@threadnote/store/resource-id';
var MAX_CONSOLIDATION_SOURCES = 16;
var MAX_CONSOLIDATION_BYTES = 60 * 1024;
var MAX_CONSOLIDATION_V2_BYTES = 128 * 1024;
var digest = /^[a-f0-9]{64}$/;
var bytes = text => new TextEncoder().encode(text).byteLength;
function fail(message) {
  throw new Error(`Consolidation review: ${message}`);
}
var strict = {onExcessProperty: 'error'};
var CitationSchema = Schema2.declare(value => {
  try {
    assertMemoryCodeCitation(value);
    return true;
  } catch {
    return false;
  }
});
var SourceSchema = Schema2.Struct({
  uri: Schema2.String,
  revision: Schema2.String.check(Schema2.isPattern(digest)),
  memoryId: Schema2.optionalKey(Schema2.String.check(Schema2.isMaxLength(512))),
  fragments: Schema2.Array(Schema2.String).check(Schema2.isMinLength(1), Schema2.isMaxLength(64)),
  codeCitations: Schema2.Array(CitationSchema).check(Schema2.isMaxLength(8)),
  relations: Schema2.Array(
    Schema2.Struct({
      type: Schema2.Literals(['depends_on', 'evidence_for', 'references', 'related_to', 'supersedes']),
      uri: Schema2.String,
    }),
  ).check(Schema2.isMaxLength(16)),
});
var ReviewSchema = Schema2.Struct({
  section: Schema2.String,
  disposition: Schema2.Literals(['direct', 'contextual', 'unsupported', 'unresolved']),
  supports: Schema2.Array(
    Schema2.Struct({
      sourceUri: Schema2.String,
      fragment: Schema2.Int,
      citationIds: Schema2.Array(Schema2.String).check(Schema2.isMaxLength(8)),
      relationIndexes: Schema2.Array(Schema2.Int).check(Schema2.isMaxLength(16)),
    }),
  ).check(Schema2.isMaxLength(16)),
});
var ConsolidationTargetSchema = Schema2.Struct({
  kind: Schema2.Literals(['durable', 'handoff', 'incident', 'preference', 'smoke']),
  status: Schema2.Literals(['active', 'archived', 'expired', 'superseded']),
  project: Schema2.String,
  topic: Schema2.String,
  sourceAgentClient: Schema2.String,
});
var ProvenanceSchema = Schema2.Struct({
  version: Schema2.Literal(1),
  bodyHash: Schema2.String,
  requestHash: Schema2.String,
  operationId: Schema2.String,
  cleanup: Schema2.Literals(['archive', 'forget', 'keep']),
  cleanupShared: Schema2.Boolean,
  target: ConsolidationTargetSchema,
  sources: Schema2.Array(SourceSchema).check(Schema2.isMinLength(1), Schema2.isMaxLength(16)),
  reviews: Schema2.Array(ReviewSchema).check(Schema2.isMaxLength(64)),
});
var ProvenanceV2Schema = Schema2.Struct({
  version: Schema2.Literal(2),
  origin: ProvenanceSchema,
  originBody: Schema2.String,
  bodyHash: Schema2.String,
  requestHash: Schema2.String,
  acceptance: Schema2.Struct({
    reviewId: Schema2.String,
    targetBeforeHash: Schema2.String,
    packetDigest: Schema2.String,
    observationRevision: Schema2.String,
    paragraphs: Schema2.Array(
      Schema2.Struct({
        ordinal: Schema2.Int,
        originOrdinal: Schema2.Int,
        hash: Schema2.String,
        evidence: Schema2.Literals(['origin', 'reviewed-current']),
        citationIds: Schema2.Array(Schema2.String).check(Schema2.isMaxLength(8)),
      }),
    ).check(Schema2.isMinLength(1), Schema2.isMaxLength(64)),
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
  return sha256HexSync2(content);
}
function reviewConsolidation(body, sources, input, options) {
  const sections = consolidationSections(body);
  validateSources(sources);
  validateOptions(options);
  let reviews;
  try {
    reviews = Schema2.decodeUnknownSync(Schema2.Array(ReviewSchema), strict)(input);
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
  const provenance = {...payload, requestHash: sha256HexSync2(JSON.stringify(payload))};
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
  Schema2.decodeSync(ConsolidationTargetSchema, strict)(t);
  if ([t.project, t.topic, t.sourceAgentClient].some(value => bytes(value) > 512)) fail('invalid target receipt.');
}
function validateSources(sources) {
  Schema2.decodeSync(Schema2.Array(SourceSchema), strict)(sources);
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
      parseResourceId(source.uri).canonicalUri !== source.uri ||
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
        parseResourceId(relation.uri).canonicalUri !== relation.uri
      )
        fail('invalid captured relation.');
  }
}
function validateConsolidationProvenance(value, body, archived = false) {
  const provenance = Schema2.decodeUnknownSync(ProvenanceSchema, strict)(value);
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
function validateConsolidationProvenanceV2(value, body) {
  const receipt = Schema2.decodeUnknownSync(ProvenanceV2Schema, strict)(value);
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
  if (receipt.requestHash !== sha256HexSync2(JSON.stringify(payload)))
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
function topicMaintenanceReplacementError(current, next, enrollment) {
  if (!current) return;
  if (current.metadata.topicMaintenanceError || next.metadata.topicMaintenanceError)
    return 'Topic maintenance metadata is malformed or stale; repair the enrolled topic before replacement.';
  const previous = current.metadata.topicMaintenance;
  const proposed = next.metadata.topicMaintenance;
  if (!previous && !proposed) return;
  const sameEvidence =
    current.body === next.body &&
    JSON.stringify(current.metadata.codeCitations ?? []) === JSON.stringify(next.metadata.codeCitations ?? []) &&
    JSON.stringify(current.metadata.consolidation ?? null) === JSON.stringify(next.metadata.consolidation ?? null);
  if (!previous && proposed && enrollment && sameEvidence && JSON.stringify(enrollment) === JSON.stringify(proposed)) {
    try {
      eligibleRecord(current);
      validateTopicMaintenanceManifest(proposed, {...current, ...next});
      return;
    } catch (error) {
      return error instanceof Error ? error.message : 'Invalid topic enrollment.';
    }
  }
  if (!previous || !proposed) return 'Topic maintenance enrollment or removal requires its dedicated review path.';
  if (!sameEvidence || JSON.stringify(previous) !== JSON.stringify(proposed))
    return 'Topic maintenance body or cited provenance changed; use the reviewed update path.';
  return;
}
function eligibleRecord(record, checkDocument = true) {
  if (checkDocument) assertMemoryDocumentSchemaWritable(record.content);
  if (
    record.headerTitle !== 'MEMORY' ||
    record.metadata.kind !== 'durable' ||
    record.metadata.status !== 'active' ||
    isSharedMemoryUri(record.uri) ||
    !/\/memories\/durable\/projects\//u.test(record.uri)
  )
    throw new Error('Topic maintenance pilot requires one active personal durable record.');
  if (!record.metadata.memoryId || !MEMORY_ID.test(record.metadata.memoryId))
    throw new Error('Topic maintenance requires a stable memory ID.');
  validEvidence(record);
  if (record.metadata.topicMaintenanceError) throw new Error(record.metadata.topicMaintenanceError);
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
import {parseResourceId as parseResourceId2} from '@threadnote/store/resource-id';
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
var HEADER_LINE_BREAK = /[\r\n]/;
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
    } catch {
      // Invalid evidence remains unavailable, as in the frozen source.
    }
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
    } catch {
      // Invalid evidence remains unavailable, as in the frozen source.
    }
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
function formatMemoryDocument(title, metadata, body) {
  assertMemorySchemaWritable(metadata.schemaVersion);
  if (metadata.consolidationError) throw new Error(metadata.consolidationError);
  if (metadata.consolidation) {
    if (
      metadata.schemaVersion !== 6 &&
      metadata.schemaVersion !== 7 &&
      metadata.schemaVersion !== 8 &&
      metadata.schemaVersion !== 9 &&
      metadata.schemaVersion !== MEMORY_SCHEMA_VERSION
    )
      throw new Error('Consolidation provenance requires memory schema version 6 through 10.');
    if (metadata.consolidation.version === 2) {
      if (metadata.schemaVersion !== MEMORY_SCHEMA_VERSION || metadata.topicMaintenance?.version !== 2)
        throw new Error('Consolidation V2 requires schema 10 and a topic maintenance V2 manifest.');
      const receipt = validateConsolidationProvenanceV2(metadata.consolidation, body.trim());
      validateConsolidationV2ActiveEvidence(
        receipt,
        metadata.topicMaintenance,
        metadata.codeCitations ?? [],
        metadata.relations ?? [],
      );
    } else {
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
  if (
    metadata.obsidianEvidence &&
    metadata.schemaVersion !== 7 &&
    metadata.schemaVersion !== 8 &&
    metadata.schemaVersion !== 9 &&
    metadata.schemaVersion !== MEMORY_SCHEMA_VERSION
  ) {
    throw new Error('Obsidian evidence requires memory schema version 7 through 10.');
  }
  if (metadata.sourceEvidenceError) throw new Error('Invalid source evidence citation metadata.');
  if (metadata.sourceEvidence) {
    if (
      metadata.schemaVersion !== 8 &&
      metadata.schemaVersion !== 9 &&
      metadata.schemaVersion !== MEMORY_SCHEMA_VERSION
    )
      throw new Error('Source evidence requires memory schema version 8, 9, or 10.');
    serializeSourceEvidenceCitation(metadata.sourceEvidence);
  }
  if (metadata.topicMaintenanceError) throw new Error(metadata.topicMaintenanceError);
  if (metadata.topicMaintenance) {
    if (metadata.schemaVersion !== 9 && metadata.schemaVersion !== MEMORY_SCHEMA_VERSION)
      throw new Error('Topic maintenance requires memory schema version 9 or 10.');
    if (metadata.topicMaintenance.version === 2 && metadata.schemaVersion !== MEMORY_SCHEMA_VERSION)
      throw new Error('Topic maintenance V2 requires memory schema version 10.');
    validateTopicMaintenanceManifest(metadata.topicMaintenance, {
      uri: 'threadnote://user/formatter/memories/durable/projects/topic/record.md',
      content: '',
      body: body.trim(),
      headerTitle: title,
      metadata,
    });
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
    metadata.sourceEvidence
      ? `${SOURCE_EVIDENCE_HEADER}: ${serializeSourceEvidenceCitation(metadata.sourceEvidence)}`
      : undefined,
    metadata.topicMaintenance ? `${TOPIC_MAINTENANCE_HEADER}: ${JSON.stringify(metadata.topicMaintenance)}` : undefined,
    metadata.consolidation ? memoryHeaderLine('consolidation', JSON.stringify(metadata.consolidation)) : undefined,
    memoryHeaderLine('candidate_id', metadata.candidateId),
    memoryHeaderLine('source_hash', metadata.sourceHash),
    memoryHeaderLine('supersedes', metadata.supersedes),
    memoryHeaderLine('archived_from', metadata.archivedFrom),
    ...(metadata.references ?? []).map(reference => memoryHeaderLine('references', reference)),
    ...(metadata.evidence ?? []).map(evidence => memoryHeaderLine('evidence', evidence)),
    ...(metadata.relations ?? []).map(relation => memoryHeaderLine('relation', `${relation.type} ${relation.uri}`)),
    ...(metadata.keywords ?? []).map(keyword => memoryHeaderLine('keywords', keyword)),
  ].filter(line => line !== undefined);
  return [...header, '', body.trim()].join(`
`);
}
function formatMemoryDocumentWithKeywords(content, keywords) {
  assertMemoryDocumentSchemaWritable(content);
  const canonical = normalizeMemoryDocumentLineEndings(canonicalMemoryDocumentContent(content));
  const separatorIndex = canonical.indexOf(`

`);
  const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? '' : canonical.slice(separatorIndex + 2);
  const headerLines = header
    .split(
      `
`,
    )
    .filter(line => !line.startsWith('keywords:'));
  const keywordLines = keywords.flatMap(keyword => {
    const line = memoryHeaderLine('keywords', keyword);
    return line === undefined ? [] : [line];
  });
  return [...headerLines, ...keywordLines, '', body].join(`
`);
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
function assertMemoryRecordArchivable(record) {
  assertMemoryDocumentSchemaWritable(record.content);
  const citationErrors = record.metadata.citationErrors;
  if (citationErrors && citationErrors.length > 0) {
    const reasons = [...new Set(citationErrors.map(error => error.reason))].sort().join(', ');
    throw new Error(
      `Cannot archive ${record.uri}: malformed code citation metadata (${reasons}) must be repaired or recaptured first.`,
    );
  }
}
function isSharedMemoryUri(uri) {
  return /^threadnote:\/\/user\/[^/]+\/memories\/shared\/[^/]+\//.test(canonicalResourceInput(uri));
}
function canonicalResourceInput(uri) {
  try {
    return parseResourceId2(uri).canonicalUri;
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
    return parseResourceId2(uri).canonicalUri;
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
function memoryHeaderLine(key, value) {
  if (value === undefined) {
    return;
  }
  if (HEADER_LINE_BREAK.test(value)) {
    throw new Error(`Memory metadata ${key} must not contain line breaks.`);
  }
  return `${key}: ${value}`;
}
function reviewAfterHeaderLine(value) {
  if (value === undefined) {
    return;
  }
  if (parseIsoDate(value) === undefined) {
    throw new Error('Memory metadata review_after must be an ISO date or canonical ISO instant.');
  }
  return memoryHeaderLine('review_after', value);
}
export {
  assertMemoryDocumentSchemaWritable,
  assertMemoryRecordArchivable,
  formatMemoryDocument,
  formatMemoryDocumentWithKeywords,
  parseMemoryDocument,
  topicMaintenanceReplacementError,
};
