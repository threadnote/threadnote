import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  WorkflowAutomationError,
  type WorkflowArtifact,
  type WorkflowEvidenceReference,
  type WorkflowWriteIntent,
} from './contracts.js';

export const nativeWorkflowProtocolVersion = 1 as const;
export const nativeWorkflowExecutorVersion = 1 as const;
export const nativeWorkflowStateVersion = 1 as const;

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

const intentFields = {
  operationId: portableId,
  artifactKey: portableId,
  role: portableId,
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
export const NativeWorkflowStateSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-workflow'),
  stateVersion: Schema.Literal(nativeWorkflowStateVersion),
  executorVersion: Schema.Literal(nativeWorkflowExecutorVersion),
  runId: portableId,
  project: portableId,
  featureId: portableId,
  generation,
  profile,
  team: Schema.optionalKey(portableId),
  bindingId: digest,
  operations: Schema.Array(nativeOperationSchema).check(Schema.isMaxLength(512)),
});
export type NativeWorkflowState = typeof NativeWorkflowStateSchema.Type;

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

export function nativeWorkflowIntentDigest(intent: WorkflowWriteIntent): string {
  return sha256HexSync(`threadnote.native-workflow.intent.v1\n${JSON.stringify(sortedJson({version: 1, intent}))}`);
}

function decode<A>(schema: Schema.ConstraintDecoder<A>, input: unknown, code: string, message: string): A {
  try {
    return Schema.decodeUnknownSync(schema, {onExcessProperty: 'error'})(input);
  } catch {
    throw fail(code, message);
  }
}

export function decodeNativeWorkflowRequest(input: unknown): NativeWorkflowRequest {
  return decode(
    NativeWorkflowRequestSchema,
    input,
    'invalid-request',
    'The native workflow request is malformed or contains unsupported fields.',
  );
}

export function decodeNativeWorkflowState(input: unknown): NativeWorkflowState {
  const candidate = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : undefined;
  if (
    candidate?.format !== 'threadnote-native-workflow' ||
    candidate.stateVersion !== nativeWorkflowStateVersion ||
    candidate.executorVersion !== nativeWorkflowExecutorVersion
  ) {
    throw fail('unsupported-state', 'This workflow state version is unsupported. Start a fresh native workflow run.');
  }
  const state = decode(NativeWorkflowStateSchema, input, 'invalid-state', 'The native workflow state is malformed.');
  const operationIds = new Set<string>();
  for (const operation of state.operations) {
    const {intent} = operation;
    if (
      operationIds.has(intent.operationId) ||
      intent.bindingId !== state.bindingId ||
      intent.sourceRunId !== state.runId ||
      operation.intentDigest !== nativeWorkflowIntentDigest(intent) ||
      (operation.status === 'prepared' ? operation.artifact !== undefined : operation.artifact === undefined)
    )
      throw fail('invalid-state', 'The native workflow state contains a conflicting operation or intent digest.');
    operationIds.add(intent.operationId);
  }
  return state;
}

export type {WorkflowArtifact, WorkflowEvidenceReference, WorkflowWriteIntent};
