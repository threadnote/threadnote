import {Context, Schema} from 'effect';
import type {Effect} from 'effect';
import {assertMemoryCodeCitation, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {MEMORY_RELATION_TYPES} from '@threadnote/memory/document';

const text = Schema.String.check(Schema.isMaxLength(64 * 1024));
const pathText = Schema.String.check(Schema.isMaxLength(4096));
const count = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 4096}));
const strings = Schema.Array(text).check(Schema.isMaxLength(4096));
const optional = Schema.optionalKey;
const projects = Schema.Union([
  Schema.Struct({mode: Schema.Literal('unrestricted')}),
  Schema.Struct({mode: Schema.Literal('projectless-only')}),
  Schema.Struct({mode: Schema.Literal('deny-all')}),
  Schema.Struct({mode: Schema.Literal('allow-projects-and-projectless'), projects: strings}),
]);
const eligibility = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('pinned-hard-uri-bypass'),
    externalResources: optional(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal('candidate-policy'),
    authority: Schema.Literals(['any', 'approved-authoritative']),
    projects,
    externalResources: optional(Schema.Record(Schema.String, Schema.String)),
  }),
]);
const selectionFields = {
  allowedUriScopes: optional(strings),
  eligibility: optional(eligibility),
  limit: optional(count),
  memoryIds: optional(strings),
  project: optional(text),
  query: optional(text),
  recencyIntent: optional(Schema.Boolean),
  requiredUris: optional(strings),
  validateNow: optional(Schema.Boolean),
  workspaceScope: optional(text),
  workspaceScopeMode: optional(Schema.Literals(['hierarchy', 'sibling'])),
};
const selection = Schema.Struct(selectionFields);
const shared = {includeInactive: Schema.Boolean};
const citation = Schema.declare<MemoryCodeCitationV1>((value): value is MemoryCodeCitationV1 => {
  try {
    assertMemoryCodeCitation(value);
    return true;
  } catch {
    return false;
  }
});
const config = Schema.Struct({
  account: pathText,
  agentContextHome: pathText,
  manifestPath: optional(pathText),
  user: pathText,
});
const requestFields = {config};
/** Only embedding-space identity crosses the read boundary, never a model path or runtime. */
const vectorModel = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  dimensions: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 32768})),
  promptPrefixes: optional(Schema.Struct({document: optional(text), query: optional(text)})),
});
export type RecallVectorReadModel = typeof vectorModel.Type;
export const recallVectorReadStateSchema = Schema.Struct({
  chunkCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  generation: text,
  authorizationKey: text,
  corpusGeneration: optional(text),
});
export type RecallVectorReadState = typeof recallVectorReadStateSchema.Type;
export const recallVectorQueryStateSchema = Schema.Union([
  Schema.Struct({readiness: Schema.Literal('current'), corpusGeneration: text, state: recallVectorReadStateSchema}),
  Schema.Struct({
    readiness: Schema.Literals(['missing', 'stale', 'corrupt', 'lexical-unavailable']),
    corpusGeneration: optional(text),
  }),
]);
const statusFields = {
  databasePath: pathText,
  documentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skippedOversizedDocumentCount: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
};
export const recallIndexStatusReadSchema = Schema.Union([
  Schema.Struct({...statusFields, ready: Schema.Literal(true), generation: text, reason: optional(text)}),
  Schema.Struct({...statusFields, ready: Schema.Literal(false), generation: optional(text), reason: text}),
]);
const vectorOptions = {model: vectorModel, corpusGeneration: optional(text)};

/** Closed private transport. No refresh, authorization-defer marker or executable callback is representable. */
export const recallReadyReadRequestSchema = Schema.Union([
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal('memory-connections'),
    options: Schema.Struct({
      allowedUriScopes: strings,
      eligibility: optional(eligibility),
      includeHistorical: optional(Schema.Boolean),
      limit: optional(count),
      memoryRefs: Schema.Array(text).check(Schema.isMaxLength(8), Schema.isMinLength(1)),
      relationTypes: optional(Schema.Array(Schema.Literals(MEMORY_RELATION_TYPES))),
      now: text,
    }),
  }),
  Schema.Struct({...requestFields, operation: Schema.Literal('status'), options: Schema.Struct(shared)}),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal('generation'),
    options: Schema.Struct({includeInactive: Schema.Literal(false)}),
  }),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal('vector-readiness'),
    options: Schema.Struct({
      model: vectorModel,
      corpusGeneration: text,
      authorizationKey: optional(text),
    }),
  }),
  Schema.Struct({...requestFields, operation: Schema.Literal('vector-state'), options: Schema.Struct(vectorOptions)}),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal('vector-scores'),
    options: Schema.Struct({
      ...vectorOptions,
      state: recallVectorReadStateSchema,
      queryVector: optional(Schema.Array(Schema.Finite).check(Schema.isMaxLength(32768))),
      allowedUriScopes: optional(strings),
      eligibility: optional(eligibility),
      limit: optional(count),
    }),
  }),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal('data'),
    options: Schema.Struct({...shared, ...selectionFields}),
  }),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal('batch'),
    options: Schema.Struct({...shared, selections: Schema.Array(selection).check(Schema.isMaxLength(128))}),
  }),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal('exact'),
    options: Schema.Struct({
      ...shared,
      eligibility: optional(eligibility),
      limitPerTerm: optional(count),
      terms: strings,
      uriScopes: strings,
    }),
  }),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal('code-links'),
    options: Schema.Struct({
      ...shared,
      allowedUriScopes: optional(strings),
      anchors: Schema.Array(citation).check(Schema.isMaxLength(8)),
      eligibility: optional(eligibility),
      limit: optional(count),
      project: optional(text),
      workspaceScope: optional(text),
      workspaceScopeMode: optional(Schema.Literals(['hierarchy', 'sibling'])),
    }),
  }),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal('memory-links'),
    options: Schema.Struct({
      ...shared,
      allowedUriScopes: optional(strings),
      directions: optional(Schema.Array(Schema.Literals(['incoming', 'outgoing']))),
      eligibility: optional(eligibility),
      limit: optional(count),
      limitPerSeed: optional(count),
      memorySeeds: Schema.Array(Schema.Struct({memoryId: text, requestedOrdinal: count})),
      relationTypes: optional(Schema.Array(Schema.Literals(MEMORY_RELATION_TYPES))),
      sourceCurrentAt: optional(text),
      witnessedSources: optional(Schema.Array(Schema.Struct({memoryId: text, requestedOrdinal: count, uri: text}))),
    }),
  }),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal('identities'),
    options: Schema.Struct({allowedUriScopes: strings, memoryIds: strings, validateNow: optional(Schema.Boolean)}),
  }),
]);
export type RecallReadyReadRequest = typeof recallReadyReadRequestSchema.Type;

const observation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('state'),
    value: Schema.Struct({
      freshness: Schema.Literals(['current', 'stale']),
      maintenance: Schema.Literals(['unneeded', 'queued', 'unavailable']),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal('query'),
    selectionOrdinal: optional(count),
    value: Schema.Struct({postingRows: Schema.Int, postingStatements: Schema.Int, queryTerms: Schema.Int}),
  }),
  Schema.Struct({kind: Schema.Literals(['mismatch', 'code-truncated', 'reread', 'rows']), value: Schema.Int}),
  Schema.Struct({kind: Schema.Literal('memory-truncated'), value: Schema.Array(count)}),
  Schema.Struct({
    kind: Schema.Literal('records'),
    value: Schema.Array(Schema.Struct({uri: text, content: Schema.String})).check(Schema.isMaxLength(4096)),
  }),
]);
export type RecallReadyReadObservation = typeof observation.Type;
export const recallReadyReadResponseSchema = Schema.Struct({
  protocol: Schema.Literal(1),
  binding: Schema.String,
  operation: Schema.Literals([
    'data',
    'batch',
    'exact',
    'code-links',
    'memory-links',
    'memory-connections',
    'identities',
    'status',
    'generation',
    'vector-readiness',
    'vector-state',
    'vector-scores',
  ]),
  outcome: Schema.Literals(['success', 'unavailable', 'failed']),
  maintenanceRequested: Schema.Boolean,
  observations: Schema.Array(observation).check(Schema.isMaxLength(1024)),
  value: optional(Schema.Unknown),
});
export type RecallReadyReadResponse = typeof recallReadyReadResponseSchema.Type;

/** Transport failures contain enums only; private request/stdout/stderr never become errors or diagnostics. */
export class RecallReadyReadBoundaryError extends Schema.TaggedError<
  RecallReadyReadBoundaryError,
  {readonly brand: unique symbol}
>()('RecallReadyReadBoundaryError', {
  reason: Schema.Literals(['budget-exhausted', 'invalid-protocol', 'worker-failed', 'cleanup-unconfirmed']),
}) {}

/** Optional application port: maintenance and the worker itself keep the direct implementation. */
export class RecallReadyReadBoundary extends Context.Service<
  RecallReadyReadBoundary,
  {
    readonly read: (
      request: RecallReadyReadRequest,
    ) => Effect.Effect<RecallReadyReadResponse, RecallReadyReadBoundaryError>;
  }
>()('@threadnote/recall/read_boundary/RecallReadyReadBoundary') {}
