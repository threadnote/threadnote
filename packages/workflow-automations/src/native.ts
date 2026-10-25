import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {workflowFamilyStem, workflowTitleSlug} from './naming.js';
import {
  WorkflowAutomationError,
  type WorkflowArtifact,
  type WorkflowEvidenceReference,
  type WorkflowWriteIntent,
} from './contracts.js';

export const nativeWorkflowProtocolVersion = 1 as const;
export const nativeWorkflowExecutorVersion = 1 as const;
export const nativeWorkflowStateVersion = 1 as const;
export const nativeWorkflowOperationLimit = 4096;

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const nonEmpty = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const portableId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  Schema.makeFilter(value =>
    value.includes('..') || value === 'constructor' || value === 'prototype' || value === '__proto__'
      ? 'Reserved identifiers are not allowed.'
      : undefined,
  ),
);
const generation = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.makeFilter(value =>
    [...value].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
      ? 'Generation contains a control character.'
      : undefined,
  ),
);
const uri = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isPattern(/^threadnote:\/\/[^\s]+$/u),
  Schema.makeFilter(value =>
    [...value].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
      ? 'Memory URI contains a control character.'
      : undefined,
  ),
);
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const memoryId = Schema.String.check(Schema.isPattern(/^tn_[A-Za-z0-9_-]{1,128}$/u));
const body = Schema.String.check(
  Schema.makeFilter(value =>
    value.trim().length === 0 || new TextEncoder().encode(value).byteLength > 60_000
      ? 'Body must be nonblank and no larger than 60000 UTF-8 bytes.'
      : undefined,
  ),
);
const evidenceReference = Schema.Struct({uri, memoryId, revision: digest});
const relation = Schema.Struct({
  type: Schema.Literals(['depends_on', 'evidence_for', 'references', 'related_to', 'supersedes']),
  uri,
});
const profile = Schema.Literals(['desktop', 'codex-cloud-personal', 'cursor-cloud-personal']);
const revisions = Schema.NullOr(digest);
const nameFamily = Schema.Struct({policyVersion: Schema.Literal(1), slug: Schema.String, ordinal: Schema.Finite});

const intentFields = {
  operationId: portableId,
  artifactKey: portableId,
  role: portableId,
  nameHint: Schema.optionalKey(nonEmpty(48).check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u))),
  body,
  expectedRevision: revisions,
  uri: Schema.optionalKey(uri),
  storageKind: Schema.optionalKey(Schema.Literals(['durable', 'handoff'])),
  codeRefs: Schema.optionalKey(Schema.Array(nonEmpty(4096)).check(Schema.isMaxLength(8))),
  relations: Schema.optionalKey(Schema.Array(relation).check(Schema.isMaxLength(16))),
  evidenceRefs: Schema.optionalKey(Schema.Array(evidenceReference).check(Schema.isMaxLength(16))),
} as const;

const requestBase = {
  protocolVersion: Schema.Literal(nativeWorkflowProtocolVersion),
  executorVersion: Schema.Literal(nativeWorkflowExecutorVersion),
} as const;
const commonRun = {runId: portableId, generation} as const;
const actionSchemas = [
  Schema.Struct({...requestBase, action: Schema.Literal('capabilities')}),
  Schema.Struct({
    ...requestBase,
    action: Schema.Literal('init'),
    runId: portableId,
    project: portableId,
    featureId: portableId,
    title: Schema.optionalKey(nonEmpty(4096)),
    generation,
    profile: Schema.optionalKey(profile),
    team: Schema.optionalKey(portableId),
  }),
  Schema.Struct({...requestBase, action: Schema.Literal('inspect'), ...commonRun}),
  Schema.Struct({
    ...requestBase,
    action: Schema.Literal('read'),
    ...commonRun,
    uri,
    evidenceRefs: Schema.optionalKey(Schema.Array(evidenceReference).check(Schema.isMaxLength(16))),
  }),
  Schema.Struct({...requestBase, action: Schema.Literal('graph-ready'), ...commonRun}),
  Schema.Struct({...requestBase, action: Schema.Literals(['preflight', 'write']), ...commonRun, ...intentFields}),
  Schema.Struct({...requestBase, action: Schema.Literal('recover'), ...commonRun, operationId: portableId}),
] as const;

export const NativeWorkflowRequestSchema = Schema.Union(actionSchemas);
export type NativeWorkflowRequest = typeof NativeWorkflowRequestSchema.Type;

const nativeIntentSchema = Schema.Struct({
  bindingId: digest,
  operationId: portableId,
  artifactKey: portableId,
  sourceRunId: portableId,
  role: portableId,
  nameHint: Schema.optionalKey(nonEmpty(48)),
  body,
  expectedRevision: revisions,
  uri: Schema.optionalKey(uri),
  storageKind: Schema.optionalKey(Schema.Literals(['durable', 'handoff'])),
  codeRefs: Schema.optionalKey(Schema.Array(nonEmpty(4096)).check(Schema.isMaxLength(8))),
  relations: Schema.optionalKey(Schema.Array(relation).check(Schema.isMaxLength(16))),
  evidenceRefs: Schema.optionalKey(Schema.Array(evidenceReference).check(Schema.isMaxLength(16))),
});
const nativeArtifactSchema = Schema.Struct({
  uri,
  memoryId,
  revision: digest,
  body,
  storageKind: Schema.Literals(['durable', 'handoff']),
  state: Schema.Literals(['active', 'archived']),
});
export interface NativeOperation {
  readonly status: 'prepared' | 'verified';
  readonly intent: WorkflowWriteIntent;
  readonly intentDigest: string;
  readonly artifact?: WorkflowArtifact;
}
const nativeOperationSchema = Schema.Struct({
  status: Schema.Literals(['prepared', 'verified']),
  intent: nativeIntentSchema,
  intentDigest: digest,
  artifact: Schema.optionalKey(nativeArtifactSchema),
});
const byteLimit = 64 * 1024 * 1024;
const boundedCount = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({minimum: 0, maximum: nativeWorkflowOperationLimit}),
);
const boundedBytes = Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 0, maximum: byteLimit}));
export const NativeAuthoringSaveReservationSchema = Schema.Struct({
  intentDigest: digest,
  rootUri: Schema.NullOr(uri),
  operationStart: boundedCount,
  operationLimit: boundedCount,
  prefixDigest: digest,
  journalBytesAtStart: boundedBytes,
  stateBytesAtStart: boundedBytes,
  reservedBytes: boundedBytes,
});
export type NativeAuthoringSaveReservation = typeof NativeAuthoringSaveReservationSchema.Type;

const nativeWorkflowStateFields = {
  format: Schema.Literal('threadnote-native-workflow'),
  stateVersion: Schema.Literal(nativeWorkflowStateVersion),
  executorVersion: Schema.Literal(nativeWorkflowExecutorVersion),
  runId: portableId,
  project: portableId,
  featureId: portableId,
  title: Schema.optionalKey(nonEmpty(4096)),
  naming: Schema.optionalKey(nameFamily),
  generation,
  profile,
  team: Schema.optionalKey(portableId),
  bindingId: digest,
  authoringSave: Schema.optionalKey(NativeAuthoringSaveReservationSchema),
} as const;

export const NativeWorkflowStateSchema = Schema.Struct({
  ...nativeWorkflowStateFields,
  operations: Schema.Array(nativeOperationSchema).check(Schema.isMaxLength(nativeWorkflowOperationLimit)),
});
export type NativeWorkflowState = typeof NativeWorkflowStateSchema.Type;

// The private decoder keeps the complete strict outer schema while admitting
// operation objects to its identity cache only after full validation.
const CachedNativeWorkflowStateSchema = Schema.Struct({
  ...nativeWorkflowStateFields,
  operations: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(nativeWorkflowOperationLimit)),
});

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortedJson(item)]),
    );
  return value;
}

export function nativeAuthoringPrefixDigest(operations: readonly {readonly intentDigest: string}[]): string {
  return sha256HexSync(JSON.stringify(operations.map(operation => operation.intentDigest)));
}

/** Bound new packed journal/native content, including every growing permission table. */
export function nativeAuthoringSaveByteBudget(input: {
  readonly contentBytes: number;
  readonly evidenceBytes: number;
  readonly plannedOperations: number;
  readonly scopeBytes: number;
  readonly maximumScopeEntryBytes: number;
  readonly requestMetadataBytes: number;
}): number {
  if (
    Object.values(input).some(value => !Number.isSafeInteger(value) || value < 0) ||
    input.plannedOperations < 1 ||
    input.plannedOperations > nativeWorkflowOperationLimit
  )
    throw fail('authoring-capacity', 'Authoring capacity requires bounded nonnegative integer budgets.');
  // A related operation stores one exact scope set, shared by its <=16 targets.
  // Each set can add every planned child and all16 candidate URIs. The fixed
  // allowance covers bounded citations (64KiB), relation/receipt metadata and
  // manifest entries; variable request/binding metadata is charged separately.
  const perOperation =
    512 * 1024 +
    4 * input.requestMetadataBytes +
    input.scopeBytes +
    (input.plannedOperations + 16) * input.maximumScopeEntryBytes;
  const bytes = 4096 + 10 * input.contentBytes + 2 * input.evidenceBytes + input.plannedOperations * perOperation;
  if (!Number.isSafeInteger(bytes)) throw fail('authoring-capacity', 'Authoring capacity exceeds its integer budget.');
  return bytes;
}

/** A retry retains its original admission; completed children never consume headroom twice. */
export function admitNativeAuthoringSave(
  input: {
    readonly intentDigest: string;
    readonly rootUri: string | null;
    readonly operationCount: number;
    readonly plannedOperations: number;
    readonly journalBytes: number;
    readonly stateBytes: number;
    readonly plannedBytes: number;
    readonly prefixDigest: string;
    readonly operationLimit?: number;
  },
  existing?: NativeAuthoringSaveReservation,
): NativeAuthoringSaveReservation {
  if (
    [input.operationCount, input.plannedOperations, input.journalBytes, input.stateBytes, input.plannedBytes].some(
      value => !Number.isSafeInteger(value) || value < 0,
    ) ||
    input.plannedOperations < 1
  )
    throw fail('authoring-capacity', 'Authoring capacity requires bounded nonnegative integer budgets.');
  const limit = Math.min(input.operationLimit ?? nativeWorkflowOperationLimit, nativeWorkflowOperationLimit);
  const reservation = existing ?? {
    intentDigest: input.intentDigest,
    rootUri: input.rootUri,
    operationStart: input.operationCount,
    operationLimit: input.operationCount + input.plannedOperations,
    prefixDigest: input.prefixDigest,
    journalBytesAtStart: input.journalBytes,
    stateBytesAtStart: input.stateBytes,
    reservedBytes: input.plannedBytes,
  };
  try {
    Schema.decodeSync(NativeAuthoringSaveReservationSchema, {onExcessProperty: 'error'})(reservation);
  } catch {
    throw fail('authoring-capacity', 'The authoring save reservation exceeds its bounded schema.');
  }
  if (
    reservation.intentDigest !== input.intentDigest ||
    reservation.rootUri !== input.rootUri ||
    reservation.prefixDigest !== input.prefixDigest ||
    reservation.operationLimit - reservation.operationStart !== input.plannedOperations ||
    reservation.reservedBytes !== input.plannedBytes
  )
    throw fail('pending-operation', 'Resume the exact authoring save admitted by this run.');
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    reservation.operationStart > input.operationCount ||
    input.operationCount > reservation.operationLimit ||
    reservation.operationLimit > limit ||
    reservation.journalBytesAtStart + reservation.reservedBytes > byteLimit ||
    reservation.stateBytesAtStart + reservation.reservedBytes > byteLimit
  )
    throw fail('authoring-capacity', 'This save exceeds the original run’s bounded capacity before new child writes.');
  return reservation;
}

export function nativeWorkflowIntentDigest(
  intent: WorkflowWriteIntent,
  hash: (value: string) => string = sha256HexSync,
): string {
  return hash(`threadnote.native-workflow.intent.v1\n${JSON.stringify(sortedJson({version: 1, intent}))}`);
}

function decode<A>(schema: Schema.ConstraintDecoder<A>, input: unknown, code: string, message: string): A {
  try {
    return Schema.decodeUnknownSync(schema, {onExcessProperty: 'error'})(input);
  } catch {
    throw fail(code, message);
  }
}

function validateNativeWorkflowState(
  state: NativeWorkflowState,
  hash: (value: string) => string,
  isCachedOperation: (operation: NativeOperation) => boolean = () => false,
): void {
  if (state.naming) {
    try {
      workflowFamilyStem(state.naming);
      if (!state.title || workflowTitleSlug(state.title) !== state.naming.slug)
        throw fail('invalid-state', 'The native title differs from its pinned name family.');
    } catch {
      throw fail('invalid-state', 'The native name family is invalid.');
    }
  }
  if (state.authoringSave) {
    const save = state.authoringSave;
    if (
      save.operationStart > state.operations.length ||
      state.operations.length > save.operationLimit ||
      save.operationLimit <= save.operationStart ||
      save.prefixDigest !== nativeAuthoringPrefixDigest(state.operations.slice(0, save.operationStart)) ||
      save.journalBytesAtStart + save.reservedBytes > byteLimit ||
      save.stateBytesAtStart + save.reservedBytes > byteLimit
    )
      throw fail('invalid-state', 'The authoring save reservation differs from its original receipts or capacity.');
  }
  const operationIds = new Set<string>();
  for (const operation of state.operations) {
    const {intent} = operation;
    if (
      operationIds.has(intent.operationId) ||
      intent.bindingId !== state.bindingId ||
      intent.sourceRunId !== state.runId ||
      (!isCachedOperation(operation) && operation.intentDigest !== nativeWorkflowIntentDigest(intent, hash)) ||
      (operation.status === 'prepared' ? operation.artifact !== undefined : operation.artifact === undefined)
    )
      throw fail('invalid-state', 'The native workflow state contains a conflicting operation or intent digest.');
    operationIds.add(intent.operationId);
  }
}

export function decodeNativeWorkflowRequest(input: unknown): NativeWorkflowRequest {
  const request = decode(
    NativeWorkflowRequestSchema,
    input,
    'invalid-request',
    'The native workflow request is malformed or contains unsupported fields.',
  );
  if (request.action === 'init') workflowTitleSlug(request.title ?? request.featureId);
  return request;
}

export function decodeNativeWorkflowState(
  input: unknown,
  hash: (value: string) => string = sha256HexSync,
): NativeWorkflowState {
  const candidate = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : undefined;
  if (
    candidate?.format !== 'threadnote-native-workflow' ||
    candidate.stateVersion !== nativeWorkflowStateVersion ||
    candidate.executorVersion !== nativeWorkflowExecutorVersion
  ) {
    throw fail('unsupported-state', 'This workflow state version is unsupported. Start a fresh native workflow run.');
  }
  const state = decode(NativeWorkflowStateSchema, input, 'invalid-state', 'The native workflow state is malformed.');
  validateNativeWorkflowState(state, hash);
  return state;
}

function deepFreeze<A>(value: A, seen = new WeakSet<object>()): A {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
    Object.freeze(value);
  }
  return value;
}

/**
 * Create a request-local decoder that reuses only previously validated,
 * deeply immutable operation objects. The default exported decoder remains
 * the full-validation boundary for parsed or otherwise uncached state.
 */
export function makeNativeWorkflowStateDecoder(
  hash: (value: string) => string = sha256HexSync,
): (input: unknown) => NativeWorkflowState {
  const validatedOperations = new WeakSet<object>();
  return input => {
    const candidate = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : undefined;
    if (
      candidate?.format !== 'threadnote-native-workflow' ||
      candidate.stateVersion !== nativeWorkflowStateVersion ||
      candidate.executorVersion !== nativeWorkflowExecutorVersion
    ) {
      throw fail('unsupported-state', 'This workflow state version is unsupported. Start a fresh native workflow run.');
    }
    const decoded = decode(
      CachedNativeWorkflowStateSchema,
      input,
      'invalid-state',
      'The native workflow state is malformed.',
    );
    const freshOperations: NativeOperation[] = [];
    const operations = decoded.operations.map(operation => {
      if (typeof operation === 'object' && operation !== null && validatedOperations.has(operation))
        return operation as NativeOperation;
      const validated = decode(
        nativeOperationSchema,
        operation,
        'invalid-state',
        'The native workflow state contains a conflicting operation or intent digest.',
      );
      freshOperations.push(validated);
      return validated;
    });
    const state = {...decoded, operations} as NativeWorkflowState;
    validateNativeWorkflowState(state, hash, operation => validatedOperations.has(operation));
    // Cache only after every state-wide invariant passed. Freezing all nested
    // values prevents a caller from changing a cached operation through an
    // array, relation, evidence reference, intent, or artifact reference.
    for (const operation of freshOperations) {
      deepFreeze(operation);
      validatedOperations.add(operation);
    }
    return state;
  };
}

export type {WorkflowArtifact, WorkflowEvidenceReference, WorkflowWriteIntent};
