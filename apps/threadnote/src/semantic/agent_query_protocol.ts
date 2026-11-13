import {Schema} from 'effect';
import {Counter, Digest, Evidence, Observation, FileUri, Identifier, Position} from '@threadnote/semantic/contracts';
import {Continuation} from '@threadnote/semantic/views';
import {SemanticLanguage, SemanticQuery} from './provider.js';
import {sha256HexSync} from '@threadnote/platform/sha256';

const PathText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8192),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);
const MaxItems = Counter.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000));
const MaxBytes = Counter.check(Schema.isGreaterThanOrEqualTo(1024), Schema.isLessThanOrEqualTo(8 * 1024 * 1024));
const Milliseconds = Counter.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(45000));
const ContextBudget = Counter.check(Schema.isGreaterThanOrEqualTo(800), Schema.isLessThanOrEqualTo(1500));
const Cursor = Schema.Struct({...Continuation.fields, observation: Schema.String.check(Schema.isMaxLength(32768))});
export const SemanticAgentBufferHandle = Schema.Struct({id: Digest, capability: Digest});
export const SemanticReadinessHandle = Schema.Struct({id: Digest, capability: Digest});
export const semanticReadinessLimits = {
  startupMilliseconds: 120000,
  queryMilliseconds: 10000,
  maxQueryMilliseconds: 45000,
  cancelAcknowledgementMilliseconds: 250,
  terminationMilliseconds: 2000,
  maxJobs: 32,
  ttlMilliseconds: 600000,
} as const;
export const SemanticReadinessStage = Schema.Literals([
  'queued',
  'verifying-inputs',
  'preparing-project',
  'acquiring-provider',
  'initializing',
  'synchronizing',
  'checking-ready',
  'finalizing',
]);
export type SemanticReadinessStage = typeof SemanticReadinessStage.Type;
export const SemanticReadinessRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal('start'),
    callerCwd: PathText,
    file: PathText,
    project: Schema.optionalKey(PathText),
    language: Identifier,
    environment: Schema.optionalKey(Identifier),
  }),
  Schema.Struct({action: Schema.Literals(['status', 'cancel']), callerCwd: PathText, job: SemanticReadinessHandle}),
]);
export type SemanticReadinessRequest = typeof SemanticReadinessRequest.Type;
export const SemanticReadinessSource = Schema.Struct({
  worktree: FileUri,
  project: FileUri,
  uri: FileUri,
  language: SemanticLanguage,
  environment: Schema.optionalKey(Identifier),
  profile: Digest,
  principal: Digest,
});
export type SemanticReadinessSource = typeof SemanticReadinessSource.Type;
export const SemanticEndpointReadiness = Schema.Union([
  Schema.Struct({...SemanticReadinessSource.fields, action: Schema.Literal('start')}),
  Schema.Struct({
    action: Schema.Literals(['status', 'cancel']),
    worktree: FileUri,
    profile: Digest,
    principal: Digest,
    job: SemanticReadinessHandle,
  }),
]);
export type SemanticEndpointReadiness = typeof SemanticEndpointReadiness.Type;
export const SemanticReadinessProgress = Schema.Struct({
  state: Schema.Literals(['accepted', 'running', 'cancelling', 'ready', 'failed', 'cancelled', 'stale']),
  stage: SemanticReadinessStage,
  sequence: Counter,
  elapsedMilliseconds: Counter,
  startupMilliseconds: Schema.Literal(120000),
  queryMilliseconds: Schema.Literal(10000),
  maxQueryMilliseconds: Schema.Literal(45000),
  cleanup: Schema.Literals(['not-started', 'pending', 'drained', 'unknown', 'retained']),
  failureOrigin: Schema.optionalKey(
    Schema.Literals(['deadline', 'cancelled', 'source', 'prerequisite', 'capacity', 'cleanup']),
  ),
});
export type SemanticReadinessProgress = typeof SemanticReadinessProgress.Type;
export const SemanticReadinessResult = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal('ok'),
    job: Schema.optionalKey(SemanticReadinessHandle),
    progress: SemanticReadinessProgress,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literals(['invalid-request', 'unavailable', 'stale']),
    reason: Identifier,
  }),
]);
export type SemanticReadinessResult = typeof SemanticReadinessResult.Type;
export const SemanticAgentBufferView = Schema.Struct({
  kind: Schema.Literal('buffer'),
  handle: SemanticAgentBufferHandle,
  documentVersion: Counter.check(Schema.isGreaterThanOrEqualTo(1)),
});
const BufferText = Schema.String.check(Schema.isMaxLength(1024 * 1024));
const ViewScope = {callerCwd: PathText, milliseconds: Schema.optionalKey(Milliseconds)};
export const SemanticAgentViewRequest = Schema.Union([
  Schema.Struct({
    ...ViewScope,
    action: Schema.Literal('open'),
    project: Schema.optionalKey(PathText),
    file: PathText,
    language: Identifier,
    environment: Schema.optionalKey(Identifier),
    text: BufferText,
  }),
  Schema.Struct({
    ...ViewScope,
    action: Schema.Literal('update'),
    handle: SemanticAgentBufferHandle,
    expectedVersion: Counter.check(Schema.isGreaterThanOrEqualTo(1)),
    text: BufferText,
  }),
  Schema.Struct({...ViewScope, action: Schema.Literal('close'), handle: SemanticAgentBufferHandle}),
]);
export type SemanticAgentViewRequest = typeof SemanticAgentViewRequest.Type;
export const SemanticAgentEndpointView = Schema.Struct({
  worktree: FileUri,
  profile: Digest,
  action: Schema.Literals(['open', 'update', 'close']),
  project: Schema.optionalKey(FileUri),
  uri: Schema.optionalKey(FileUri),
  language: Schema.optionalKey(SemanticLanguage),
  environment: Schema.optionalKey(Identifier),
  text: Schema.optionalKey(BufferText),
  handle: Schema.optionalKey(SemanticAgentBufferHandle),
  expectedVersion: Schema.optionalKey(Counter),
  milliseconds: Milliseconds,
});
export type SemanticAgentEndpointView = typeof SemanticAgentEndpointView.Type;
export const semanticAgentBufferLimits = {
  maxTextBytes: 1024 * 1024,
  maxGrants: 16,
  maxRetainedBytes: 8 * 1024 * 1024,
  ttlMilliseconds: 600000,
  maxRequestBytes: 2 * 1024 * 1024,
} as const;
export const SemanticAgentReadOperation = Schema.Literals([...SemanticQuery.literals, 'diagnostics']);

/** Transport-neutral public input. There are deliberately no executable, setup or arbitrary command fields. */
export const SemanticAgentQuery = Schema.Struct({
  callerCwd: PathText,
  file: PathText,
  project: Schema.optionalKey(PathText),
  language: Identifier,
  operation: Identifier,
  position: Schema.optionalKey(Position),
  environment: Schema.optionalKey(Identifier),
  view: Schema.optionalKey(Schema.Union([Schema.Literal('disk'), SemanticAgentBufferView])),
  maxItems: Schema.optionalKey(MaxItems),
  maxBytes: Schema.optionalKey(MaxBytes),
  milliseconds: Schema.optionalKey(Milliseconds),
  cursor: Schema.optionalKey(Cursor),
  task: Schema.optionalKey(PathText.check(Schema.isMaxLength(4096))),
  budgetTokens: Schema.optionalKey(ContextBudget),
});
export type SemanticAgentQuery = typeof SemanticAgentQuery.Type;

/** Authenticated application-to-coordinator request; never decoded as public host authority. */
export const SemanticAgentEndpointQuery = Schema.Struct({
  worktree: FileUri,
  project: FileUri,
  uri: FileUri,
  language: SemanticLanguage,
  operation: SemanticAgentReadOperation,
  position: Schema.optionalKey(Position),
  environment: Schema.optionalKey(Identifier),
  profile: Digest,
  view: Schema.optionalKey(SemanticAgentBufferView),
  query: Digest,
  maxItems: MaxItems,
  maxBytes: MaxBytes,
  milliseconds: Milliseconds,
  cursor: Schema.optionalKey(Cursor),
});
export type SemanticAgentEndpointQuery = typeof SemanticAgentEndpointQuery.Type;
export function semanticAgentQueryKey(
  runtimeIdentity: string,
  profile: string,
  request: {
    readonly worktree: string;
    readonly project: string;
    readonly uri: string;
    readonly language: string;
    readonly operation: string;
    readonly position?: {readonly line: number; readonly character: number};
    readonly environment?: string;
    readonly view?: {readonly kind: 'buffer'; readonly handle: {readonly id: string}; readonly documentVersion: number};
  },
) {
  return sha256HexSync(
    JSON.stringify([
      runtimeIdentity,
      profile,
      request.worktree,
      request.project,
      request.uri,
      request.language,
      request.operation,
      request.position ?? null,
      request.environment ?? null,
      ...(request.view ? [[request.view.handle.id, request.view.documentVersion]] : []),
    ]),
  );
}
export const SemanticAgentQueryResult = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal('ok'),
    evidence: Evidence,
    items: Schema.Array(Schema.Json).check(Schema.isMaxLength(1000)),
    offset: Counter,
    remaining: Counter,
    next: Schema.NullOr(Cursor),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literals([
      'unsupported',
      'unavailable',
      'timeout',
      'cancelled',
      'stale',
      'conflict',
      'invalid-request',
      'invalid-cursor',
      'budget-exceeded',
    ]),
    reason: Identifier,
    evidence: Schema.NullOr(Evidence),
  }),
]);
export const SemanticAgentViewSuccess = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal('ok'),
    action: Schema.Literal('open'),
    handle: SemanticAgentBufferHandle,
    observation: Observation,
    expiresAt: Counter,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal('ok'),
    action: Schema.Literal('update'),
    observation: Observation,
    expiresAt: Counter,
  }),
  Schema.Struct({version: Schema.Literal(1), status: Schema.Literal('ok'), action: Schema.Literal('close')}),
]);
export type SemanticAgentQueryResult = typeof SemanticAgentQueryResult.Type;

export function formatSemanticAgentQuery(result: SemanticAgentQueryResult): string {
  // Canonical compact JSON preserves all outcomes, provenance and continuations without a second lossy projection.
  return JSON.stringify(result);
}

/** Internal selected-verifier reply; never a public permission or caller input. */
export const SemanticVerificationReply = Schema.Struct({
  version: Schema.Literal(1),
  provider: Schema.Literals(['typescript-language-server', 'basedpyright', 'gopls', 'rust-analyzer', 'jdtls']),
  candidate: Digest,
  mode: Schema.Literals(['candidate', 'configuration']),
  digest: Digest,
  runtimeVersion: Schema.Boolean,
});
