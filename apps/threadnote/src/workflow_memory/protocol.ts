import {Effect, Schema} from 'effect';
import type {MemoryRelation} from '@threadnote/memory/document';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {DeferredCodeAnchorWriteRequest} from '../memory/deferred/code_anchor.js';

export const WORKFLOW_PROTOCOL_VERSION = 1 as const;
export type WorkflowProfile = 'desktop' | 'codex-cloud-personal' | 'cursor-cloud-personal';
export class WorkflowMemoryError extends Schema.TaggedError<WorkflowMemoryError>()('WorkflowMemoryError', {
  code: Schema.String,
  message: Schema.String,
}) {}
export const workflowError = (code: string, message: string) => WorkflowMemoryError.make({code, message});
export const validateWorkflowInput = <A>(validate: () => A) =>
  Effect.try({
    try: validate,
    catch: cause =>
      Schema.is(WorkflowMemoryError)(cause)
        ? cause
        : workflowError('invalid-request', cause instanceof Error ? cause.message : 'Invalid workflow input.'),
  });

const optionalText = Schema.optionalKey(Schema.String);
export const WorkflowRequestSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  action: Schema.Literals(['capabilities', 'bind', 'read', 'preflight', 'create', 'replace', 'archive', 'recover']),
  bindingId: optionalText,
  workflowRunId: optionalText,
  project: optionalText,
  featureId: optionalText,
  generation: optionalText,
  profile: Schema.optionalKey(Schema.Literals(['desktop', 'codex-cloud-personal', 'cursor-cloud-personal'])),
  team: optionalText,
  mutation: Schema.optionalKey(Schema.Literals(['create', 'replace', 'archive'])),
  operationId: optionalText,
  artifactKey: optionalText,
  sourceRunId: optionalText,
  role: optionalText,
  body: optionalText,
  bodySha256: optionalText,
  storageKind: Schema.optionalKey(Schema.Literals(['handoff', 'durable'])),
  uri: optionalText,
  expectedRevision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  relations: Schema.optionalKey(Schema.Array(Schema.Struct({type: Schema.String, uri: Schema.String}))),
  codeRefs: Schema.optionalKey(Schema.Array(Schema.String)),
  citationPolicy: Schema.optionalKey(Schema.Literals(['require-current', 'defer'])),
});
export type WorkflowRequest = typeof WorkflowRequestSchema.Type;

const inspectionDigest = Schema.String.check(Schema.isBetweenLength(64, 64), Schema.isPattern(/^[a-f0-9]{64}$/u));
export const WorkflowOperationInspectionRequestSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  action: Schema.Literal('inspect-operation'),
  bindingId: inspectionDigest,
  generation: Schema.String.check(
    Schema.makeFilter(value => {
      try {
        requiredText(value, 'generation');
      } catch {
        return 'Expected a valid workflow generation.';
      }
    }),
  ),
  bindingHash: inspectionDigest,
  operationId: Schema.String.check(
    Schema.makeFilter(value => {
      try {
        portableKey(value, 'operationId');
      } catch {
        return 'Expected a portable operation identifier.';
      }
    }),
  ),
  intentDigest: inspectionDigest,
});
export type WorkflowOperationInspectionRequest = typeof WorkflowOperationInspectionRequestSchema.Type;

export interface WorkflowBinding {
  readonly bindingId: string;
  readonly workflowRunId: string;
  readonly profile: WorkflowProfile;
  readonly project: string;
  readonly featureId: string;
  readonly generation: string;
  readonly home: string;
  readonly repo: string;
  readonly account: string;
  readonly user: string;
  readonly agentId: string;
  readonly team?: string;
  readonly remote?: string;
  readonly branch?: string;
  readonly sharedRoots: readonly string[];
  readonly artifactLifetime: 'local-home' | 'possibly-ephemeral-workspace';
}
export interface WorkflowArtifact {
  readonly artifactKey: string;
  readonly sourceRunId: string;
  readonly role: string;
  readonly canonicalUri: string;
  readonly memoryId: string;
  readonly revision: string;
  readonly bodySha256: string;
  readonly storageKind: 'handoff' | 'durable';
  readonly state: 'active' | 'archived';
}
export interface WorkflowOperation {
  readonly deferredCodeAnchor?: DeferredCodeAnchorWriteRequest;
  readonly request: WorkflowRequest;
  readonly intentDigest: string;
  readonly desired: string;
  readonly before?: string;
  readonly sourceUri?: string;
  readonly artifact: WorkflowArtifact;
  readonly relations: readonly {
    readonly uri: string;
    readonly content: string;
    readonly memoryId?: string;
    readonly allowedUriScopes?: readonly string[];
  }[];
  readonly status: 'prepared' | 'verified';
}
export interface WorkflowJournal {
  readonly protocolVersion: 1;
  readonly binding: WorkflowBinding;
  readonly artifacts: Readonly<Record<string, WorkflowArtifact>>;
  readonly operations: Readonly<Record<string, WorkflowOperation>>;
  readonly manifestUri: string;
  readonly manifestContent: string;
  readonly previousManifestContent?: string;
  readonly manifestCommitted: boolean;
}
export interface WorkflowReadResult {
  readonly codeCitations: readonly MemoryCodeCitationV1[];
  readonly relations: readonly MemoryRelation[];
  readonly sourceCommit?: string;
  readonly protocolVersion: 1;
  readonly status: 'ok';
  readonly canonicalUri: string;
  readonly memoryId?: string;
  readonly revision: string;
  readonly state: string;
  readonly storageKind: string;
  readonly role?: string;
  readonly artifactKey?: string;
  readonly sourceRunId?: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly verifiedReadback: true;
}
export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}
export function requiredText(value: string | undefined, label: string): string {
  if (!value?.trim() || value.length > 4096 || [...value].some(character => character.charCodeAt(0) < 32))
    throw workflowError('invalid-request', `${label} must be nonempty text without control characters.`);
  return value;
}
export function portableKey(value: string | undefined, label: string): string {
  const key = requiredText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(key) || key === '..')
    throw workflowError('invalid-request', `${label} must be a portable identifier.`);
  return key;
}
export type WorkflowRelation = MemoryRelation;
