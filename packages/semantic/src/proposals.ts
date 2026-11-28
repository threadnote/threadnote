import * as EffectArray from 'effect/Array';
import * as EffectOrder from 'effect/Order';
import * as EffectOption from 'effect/Option';
import * as EffectPredicate from 'effect/Predicate';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Schema} from 'effect';
import {Evidence, FileUri, Observation} from './contracts.js';

export const semanticProposalLimits = Object.freeze({
  maxTargets: 1000,
  maxEditsPerTarget: 10000,
  maxProposalBytes: 8 * 1024 * 1024,
  maxPageBytes: 8 * 1024 * 1024,
  pageChunkCodePoints: 512,
});

export interface ProposalTextEdit {
  readonly range: {
    readonly start: {readonly line: number; readonly character: number};
    readonly end: {readonly line: number; readonly character: number};
  };
  readonly newText: string;
  readonly annotationId?: string;
}
export interface ProposalPrecondition {
  readonly sourceKind: 'disk' | 'overlay';
  readonly rawDigest: string;
  readonly encoding: 'utf-8';
  readonly physicalIdentity: string | null;
  readonly owner: string;
  readonly documentVersion: number | null;
}
export interface ProposalTargetInput {
  readonly observation: Observation;
  readonly beforeText: string;
  readonly edits: readonly ProposalTextEdit[];
  readonly precondition: ProposalPrecondition;
}
export interface ProposalInput {
  readonly version: 1;
  readonly operation: 'rename';
  readonly evidence: Evidence;
  readonly targets: readonly ProposalTargetInput[];
}
export interface SemanticProposalTarget extends ProposalTargetInput {
  readonly afterText: string;
}
export interface SemanticProposalV1 {
  readonly version: 1;
  readonly operation: 'rename';
  readonly evidence: Evidence;
  readonly targets: readonly SemanticProposalTarget[];
  readonly digest: string;
}
export interface OrderedProposalTargetInput extends ProposalTargetInput {
  readonly providerDocumentVersion?: number | null;
}
export interface OrderedProposalInput {
  readonly version: 2;
  readonly operation: 'code-action';
  readonly qualification: 'qualified-text-only' | 'unsupported-operation-sequence';
  readonly evidence: Evidence;
  readonly targets: readonly OrderedProposalTargetInput[];
  readonly operations: readonly ProposalOperation[];
  readonly changeAnnotations?: ProposalChangeAnnotations;
}
export interface SemanticProposalV2 extends Omit<OrderedProposalInput, 'targets'> {
  readonly targets: readonly (SemanticProposalTarget & OrderedProposalTargetInput)[];
  readonly digest: string;
}
export type SemanticProposal = SemanticProposalV1 | SemanticProposalV2;
export interface ProposalPageChunk {
  readonly target: number | null;
  readonly kind: 'manifest' | 'before' | 'after';
  readonly text: string;
}
export interface ProposalPage {
  readonly digest: string;
  readonly offset: number;
  readonly chunks: readonly ProposalPageChunk[];
  readonly next: number | null;
  readonly targetCount: number;
  readonly chunkCount: number;
}

const digestSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const positionSchema = Schema.Struct({
  line: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  character: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const editSchema = Schema.Struct({
  range: Schema.Struct({start: positionSchema, end: positionSchema}),
  newText: Schema.String,
});
const preconditionSchema = Schema.Struct({
  sourceKind: Schema.Literals(['disk', 'overlay']),
  rawDigest: digestSchema,
  encoding: Schema.Literal('utf-8'),
  physicalIdentity: Schema.NullOr(Schema.String),
  owner: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  documentVersion: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
});
const targetSchema = Schema.Struct({
  observation: Observation,
  beforeText: Schema.String,
  edits: Schema.Array(editSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(semanticProposalLimits.maxEditsPerTarget),
  ),
  precondition: preconditionSchema,
});
const annotationIdSchema = Schema.String.check(Schema.isMinLength(1));
const annotatedEditSchema = Schema.Struct({...editSchema.fields, annotationId: Schema.optional(annotationIdSchema)});
export const ProposalChangeAnnotations = Schema.Record(
  Schema.String,
  Schema.Struct({
    label: Schema.String,
    needsConfirmation: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.String),
  }),
);
export type ProposalChangeAnnotations = typeof ProposalChangeAnnotations.Type;
const documentVersionSchema = Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));
const resourceOptionsSchema = Schema.Struct({
  overwrite: Schema.optional(Schema.Boolean),
  ignoreIfExists: Schema.optional(Schema.Boolean),
});
export const ProposalOperation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('text'),
    uri: FileUri,
    version: documentVersionSchema,
    edits: Schema.Array(annotatedEditSchema).check(Schema.isMaxLength(semanticProposalLimits.maxEditsPerTarget)),
    target: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    kind: Schema.Literal('create'),
    uri: FileUri,
    options: Schema.optional(resourceOptionsSchema),
    annotationId: Schema.optional(annotationIdSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal('rename'),
    oldUri: FileUri,
    newUri: FileUri,
    options: Schema.optional(resourceOptionsSchema),
    annotationId: Schema.optional(annotationIdSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal('delete'),
    uri: FileUri,
    options: Schema.optional(
      Schema.Struct({recursive: Schema.optional(Schema.Boolean), ignoreIfNotExists: Schema.optional(Schema.Boolean)}),
    ),
    annotationId: Schema.optional(annotationIdSchema),
  }),
]);
export type ProposalOperation = typeof ProposalOperation.Type;
const storedTargetSchema = Schema.Struct({...targetSchema.fields, afterText: Schema.optional(Schema.String)});
const orderedTargetSchema = Schema.Struct({
  ...storedTargetSchema.fields,
  providerDocumentVersion: Schema.optional(documentVersionSchema),
  edits: Schema.Array(annotatedEditSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(semanticProposalLimits.maxEditsPerTarget),
  ),
});
const inputSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    operation: Schema.Literal('rename'),
    evidence: Evidence,
    targets: Schema.Array(storedTargetSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(semanticProposalLimits.maxTargets),
    ),
    digest: Schema.optional(digestSchema),
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    operation: Schema.Literal('code-action'),
    evidence: Evidence,
    qualification: Schema.Literals(['qualified-text-only', 'unsupported-operation-sequence']),
    targets: Schema.Array(orderedTargetSchema).check(Schema.isMaxLength(semanticProposalLimits.maxTargets)),
    operations: Schema.Array(ProposalOperation).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(semanticProposalLimits.maxTargets),
    ),
    changeAnnotations: Schema.optional(ProposalChangeAnnotations),
    digest: Schema.optional(digestSchema),
  }),
]);
const semanticProposalSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    operation: Schema.Literal('rename'),
    evidence: Evidence,
    targets: Schema.Array(Schema.Struct({...targetSchema.fields, afterText: Schema.String})).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(semanticProposalLimits.maxTargets),
    ),
    digest: digestSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    operation: Schema.Literal('code-action'),
    evidence: Evidence,
    qualification: Schema.Literals(['qualified-text-only', 'unsupported-operation-sequence']),
    targets: Schema.Array(Schema.Struct({...orderedTargetSchema.fields, afterText: Schema.String})).check(
      Schema.isMaxLength(semanticProposalLimits.maxTargets),
    ),
    operations: Schema.Array(ProposalOperation).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(semanticProposalLimits.maxTargets),
    ),
    changeAnnotations: Schema.optional(ProposalChangeAnnotations),
    digest: digestSchema,
  }),
]);
const strictDecode = {onExcessProperty: 'error'} as const;
function validateOperations(copy: typeof inputSchema.Type): void {
  if (copy.version === 1) return;
  const textUris = new Set<string>();
  const targetIndexes = new Set<number>();
  let independent = true;
  const annotations = copy.changeAnnotations ?? {};
  const annotation = (id: string | undefined): void => {
    if (id !== undefined && !EffectRecord.has(annotations, id)) fail('unknown change annotation');
  };
  for (const operation of copy.operations) {
    if (operation.kind !== 'text') {
      independent = false;
      annotation(operation.annotationId);
      continue;
    }
    if (textUris.has(operation.uri) || operation.edits.length === 0) independent = false;
    textUris.add(operation.uri);
    for (const edit of operation.edits) {
      annotation(edit.annotationId);
      if (
        edit.range.end.line < edit.range.start.line ||
        (edit.range.end.line === edit.range.start.line && edit.range.end.character < edit.range.start.character)
      )
        fail('edit range is reversed');
    }
  }
  if (copy.qualification === 'unsupported-operation-sequence') {
    if (
      copy.targets.length !== 0 ||
      EffectArray.some(copy.operations, operation => operation.kind === 'text' && operation.target !== null)
    )
      fail('unsupported sequence must not contain qualified targets');
    // Independent text groups require captured sources, never a caller's unsupported downgrade.
    if (independent) fail('independent text sequence requires qualified source targets');
    return;
  }
  if (!independent) fail('operation sequence cannot qualify as independent text');
  for (const operation of copy.operations) {
    if (operation.kind !== 'text' || operation.target === null) fail('qualified operation requires a target');
    const target = copy.targets[operation.target];
    if (
      !target ||
      targetIndexes.has(operation.target) ||
      operation.uri !== target.observation.uri ||
      operation.version !==
        (!('providerDocumentVersion' in target) || target.providerDocumentVersion === undefined
          ? target.observation.documentVersion
          : target.providerDocumentVersion) ||
      canonical(operation.edits) !== canonical(target.edits)
    )
      fail('operation does not match its unique target');
    targetIndexes.add(operation.target);
  }
  if (targetIndexes.size !== copy.targets.length) fail('operations do not cover every target');
}
function fail(message: string): never {
  throw new Error(`Invalid semantic proposal: ${message}`);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of EffectRecord.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (value === undefined) fail('undefined metadata is not representable');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (EffectArray.isArray(value)) return `[${EffectArray.join(EffectArray.map(value, canonical), ',')}]`;
  if (!EffectPredicate.isObject(value)) fail('unsupported canonical value');
  const keys = EffectArray.sort(EffectArray.map(EffectRecord.keys(value), String), EffectOrder.String);
  return `{${EffectArray.join(
    EffectArray.map(keys, key => `${JSON.stringify(key)}:${canonical(value[key])}`),
    ',',
  )}}`;
}
function codeAt(source: string, index: number): number | undefined {
  return EffectOption.getOrUndefined(EffectString.charCodeAt(index)(source));
}
interface SourceLine {
  readonly start: number;
  readonly end: number;
}
function sourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = codeAt(source, index);
    if (character !== 13 && character !== 10) continue;
    lines.push({start, end: index});
    if (character === 13 && codeAt(source, index + 1) === 10) index++;
    start = index + 1;
  }
  lines.push({start, end: source.length});
  return lines;
}
function positionOffset(
  source: string,
  lines: readonly SourceLine[],
  position: {readonly line: number; readonly character: number},
): number {
  const line = lines[position.line];
  if (line === undefined) fail('edit range is outside the source');
  const {start: lineStart, end: lineEnd} = line;
  const offset = lineStart + position.character;
  if (offset > lineEnd) fail('edit range is outside the source line');
  if (offset > lineStart && offset < source.length) {
    const before = codeAt(source, offset - 1)!;
    const after = codeAt(source, offset)!;
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
      fail('edit splits a surrogate pair');
  }
  return offset;
}
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
const PAGE_CHARS = semanticProposalLimits.pageChunkCodePoints;
function* codePointChunks(text: string): Generator<string> {
  let chunk = '';
  let count = 0;
  for (const point of text) {
    chunk += point;
    count++;
    if (count === PAGE_CHARS) {
      yield chunk;
      chunk = '';
      count = 0;
    }
  }
  if (chunk.length > 0 || text.length === 0) yield chunk;
}
function chunkCount(text: string): number {
  let count = 0;
  let points = 0;
  for (const _point of text) {
    points++;
    if (points === PAGE_CHARS) {
      count++;
      points = 0;
    }
  }
  return count + (points > 0 || count === 0 ? 1 : 0);
}

/** Pure immutable model: validation and image derivation only; no workspace authority or I/O. */
export function createSemanticProposal(input: unknown, digest: (canonicalValue: string) => string): SemanticProposal {
  const decoded = Schema.decodeUnknownSync(inputSchema)(input, strictDecode);
  const copy = structuredClone(decoded);
  validateOperations(copy);
  if (new Set(EffectArray.map(copy.targets, target => target.observation.uri)).size !== copy.targets.length)
    fail('target set is empty or contains duplicate resources');
  const targets = EffectArray.map(copy.targets, target => {
    if (
      target.observation.content !== target.precondition.rawDigest ||
      target.precondition.documentVersion !== target.observation.documentVersion ||
      digest(target.beforeText) !== target.precondition.rawDigest
    )
      fail('source precondition does not match its observation');
    const lines = sourceLines(target.beforeText);
    const edits = EffectArray.map(target.edits, edit => ({
      edit,
      start: positionOffset(target.beforeText, lines, edit.range.start),
      end: positionOffset(target.beforeText, lines, edit.range.end),
    }));
    let previousStart = -1;
    let previousEnd = -1;
    for (const item of edits) {
      if (item.end < item.start) fail('edit range is reversed');
      if (item.start < previousStart || item.start < previousEnd || item.start === previousStart)
        fail('edits overlap or are not in source order');
      previousStart = item.start;
      previousEnd = item.end;
    }
    const descending = EffectArray.reverse(edits);
    let afterText = target.beforeText;
    for (const item of descending)
      afterText =
        EffectString.slice(0, item.start)(afterText) + item.edit.newText + EffectString.slice(item.end)(afterText);
    if (target.afterText !== undefined && target.afterText !== afterText)
      fail('stored after-image does not match derived image');
    return {...target, afterText};
  });
  const unsigned =
    copy.version === 1
      ? {version: 1 as const, operation: copy.operation, evidence: copy.evidence, targets}
      : {
          version: 2 as const,
          operation: copy.operation,
          evidence: copy.evidence,
          targets,
          qualification: copy.qualification,
          operations: copy.operations,
          ...(copy.changeAnnotations === undefined ? {} : {changeAnnotations: copy.changeAnnotations}),
        };
  const canonicalValue = canonical(unsigned);
  if (utf8Bytes(canonicalValue) > semanticProposalLimits.maxProposalBytes) fail('proposal exceeds the 8 MiB limit');
  const calculatedDigest = digest(canonicalValue);
  if (!Schema.is(digestSchema)(calculatedDigest)) fail('digest function returned an invalid digest');
  if (copy.digest !== undefined && copy.digest !== calculatedDigest)
    fail('stored digest does not match canonical proposal');
  const proposal = {...unsigned, digest: calculatedDigest};
  if (utf8Bytes(canonical(proposal)) > semanticProposalLimits.maxProposalBytes)
    fail('proposal exceeds the 8 MiB limit');
  return freeze(proposal);
}

/** Pages a deterministic manifest/before/after chunk stream within a serialized UTF-8 JSON byte budget. */
export function proposalPage(
  proposalInput: unknown,
  options: {readonly offset?: number; readonly maxBytes: number},
): ProposalPage {
  const proposal = Schema.decodeUnknownSync(semanticProposalSchema)(proposalInput, strictDecode);
  const offset = options.offset ?? 0;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0 ||
    options.maxBytes > semanticProposalLimits.maxPageBytes
  )
    fail('invalid page offset or byte budget');
  if (!Schema.is(digestSchema)(proposal.digest) || proposal.targets.length > semanticProposalLimits.maxTargets)
    fail('invalid proposal');
  const manifestValue = {
    version: proposal.version,
    operation: proposal.operation,
    evidence: proposal.evidence,
    ...(proposal.version === 2
      ? {
          qualification: proposal.qualification,
          operations: proposal.operations,
          ...(proposal.changeAnnotations === undefined ? {} : {changeAnnotations: proposal.changeAnnotations}),
        }
      : {}),
    targets: EffectArray.map(proposal.targets, target => ({
      observation: target.observation,
      ...('providerDocumentVersion' in target ? {providerDocumentVersion: target.providerDocumentVersion} : {}),
      precondition: target.precondition,
      edits: target.edits,
    })),
  };
  const manifest = canonical(manifestValue);
  let totalChunks = chunkCount(manifest);
  for (const target of proposal.targets) totalChunks += chunkCount(target.beforeText) + chunkCount(target.afterText);
  if (offset >= totalChunks) fail('page offset is outside the proposal');
  const base = {
    digest: proposal.digest,
    offset,
    chunks: [] as ProposalPageChunk[],
    next: null as number | null,
    targetCount: proposal.targets.length,
    chunkCount: totalChunks,
  };
  const emptyBytes = utf8Bytes(JSON.stringify(base));
  if (emptyBytes > options.maxBytes) fail('byte budget is too small for page metadata');
  const selected: ProposalPageChunk[] = [];
  let selectedBytes = 0;
  let globalIndex = 0;
  let stopped = false;
  const consume = (kind: ProposalPageChunk['kind'], target: number | null, text: string): void => {
    if (stopped) return;
    for (const part of codePointChunks(text)) {
      if (globalIndex++ < offset) continue;
      const chunk = {target, kind, text: part};
      const candidateCount = selected.length + 1;
      const candidateNext = offset + candidateCount < totalChunks ? offset + candidateCount : null;
      const chunkBytes = utf8Bytes(JSON.stringify(chunk));
      const candidateBytes =
        emptyBytes -
        4 +
        utf8Bytes(JSON.stringify(candidateNext)) +
        selectedBytes +
        (selected.length === 0 ? 0 : 1) +
        chunkBytes;
      if (candidateBytes > options.maxBytes) {
        if (selected.length === 0) fail('byte budget is too small for the next proposal chunk');
        stopped = true;
        return;
      }
      selected.push(chunk);
      selectedBytes += (selected.length === 1 ? 0 : 1) + chunkBytes;
    }
  };
  consume('manifest', null, manifest);
  for (let i = 0; i < proposal.targets.length && !stopped; i++) {
    consume('before', i, proposal.targets[i].beforeText);
    consume('after', i, proposal.targets[i].afterText);
  }
  const next = offset + selected.length < totalChunks ? offset + selected.length : null;
  return freeze({...base, chunks: selected, next});
}
