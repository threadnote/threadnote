import {Schema} from 'effect';
import {Counter, Digest, FileUri, Identifier, Position} from '@threadnote/semantic/contracts';
import {SemanticAgentBufferView} from './agent_query_protocol.js';
import {SemanticLanguage, SemanticRange} from './provider.js';
export const semanticAgentChangeLimits = {
  maxRequestBytes: 65536,
  minPageBytes: 1024,
  maxPageBytes: 8 * 1024 * 1024,
  defaultPageBytes: 8192,
  defaultMilliseconds: 10000,
  maxMilliseconds: 45000,
  maxSourceBytes: 4 * 1024 * 1024,
} as const;
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192));
const Milliseconds = Counter.check(Schema.isBetween({minimum: 1, maximum: semanticAgentChangeLimits.maxMilliseconds}));
export const SemanticProposalHandle = Schema.Struct({id: Digest, capability: Digest, digest: Digest});
export const SemanticWriterHandle = Schema.Struct({operation: Digest, capability: Digest});
export type SemanticWriterHandle = typeof SemanticWriterHandle.Type;
const Common = {
  version: Schema.Literal(1),
  callerCwd: Text,
  milliseconds: Schema.optionalKey(Milliseconds),
  maxBytes: Schema.optionalKey(
    Counter.check(
      Schema.isBetween({
        minimum: semanticAgentChangeLimits.minPageBytes,
        maximum: semanticAgentChangeLimits.maxPageBytes,
      }),
    ),
  ),
};
/** Local command only: intentionally absent from public change/RPC actions. */
export const SemanticWriterAdmissionRequest = Schema.Struct({
  ...Common,
  handle: SemanticProposalHandle,
  taskAuthorization: Identifier,
  diskOwnership: Schema.Literal('closed-disk'),
});
export const SemanticWriterRequest = Schema.Struct({
  ...Common,
  action: Schema.Literals(['apply', 'recover', 'status']),
  writer: SemanticWriterHandle,
});
export type SemanticWriterRequest = typeof SemanticWriterRequest.Type;
export const SemanticWriterRetirementRequest = Schema.Struct({
  ...Common,
  writer: SemanticWriterHandle,
  disposition: Schema.Literals(['terminal', 'discarded']),
  taskAuthorization: Identifier,
});
export const SemanticWriterSession = Schema.Struct({
  processId: Counter.check(Schema.isGreaterThanOrEqualTo(1)),
  processStartIdentity: Identifier,
  boot: Digest,
  runtimeIdentity: Digest,
});
export type SemanticWriterSession = typeof SemanticWriterSession.Type;
export const SemanticWriterProposal = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal('writer-proposal'),
  worktree: FileUri,
  principal: Digest,
  profile: Digest,
  expiresAt: Counter,
  proposal: Schema.Unknown,
  session: SemanticWriterSession,
});
export const SemanticAgentChangeRequest = Schema.Union([
  Schema.Struct({
    ...Common,
    action: Schema.Literal('prepare'),
    operation: Schema.Literals(['rename', 'code-action']),
    project: Schema.optionalKey(Text),
    file: Text,
    language: Identifier,
    position: Schema.optionalKey(Position),
    newName: Schema.optionalKey(Identifier),
    environment: Schema.optionalKey(Identifier),
    view: Schema.optionalKey(Schema.Union([Schema.Literal('disk'), SemanticAgentBufferView])),
    choiceHandle: Schema.optionalKey(Digest),
    diagnosticIds: Schema.optionalKey(Schema.Array(Digest).check(Schema.isMaxLength(128))),
    range: Schema.optionalKey(SemanticRange),
    only: Schema.optionalKey(Schema.Array(Identifier).check(Schema.isMaxLength(16))),
  }),
  Schema.Struct({
    ...Common,
    action: Schema.Literals(['status', 'preflight']),
    handle: SemanticProposalHandle,
    offset: Schema.optionalKey(Counter),
  }),
  SemanticWriterRequest,
]);
export type SemanticAgentChangeRequest = typeof SemanticAgentChangeRequest.Type;
export const SemanticAgentEndpointChange = Schema.Struct({
  version: Schema.Literal(1),
  worktree: FileUri,
  profile: Digest,
  principal: Digest,
  action: Schema.Literals(['prepare', 'status', 'preflight', 'resolve-for-writer', 'invalidate-for-writer']),
  project: Schema.optionalKey(FileUri),
  uri: Schema.optionalKey(FileUri),
  language: Schema.optionalKey(SemanticLanguage),
  position: Schema.optionalKey(Position),
  newName: Schema.optionalKey(Identifier),
  operation: Schema.optionalKey(Schema.Literals(['rename', 'code-action'])),
  choiceHandle: Schema.optionalKey(Digest),
  diagnosticIds: Schema.optionalKey(Schema.Array(Digest).check(Schema.isMaxLength(128))),
  range: Schema.optionalKey(SemanticRange),
  only: Schema.optionalKey(Schema.Array(Identifier).check(Schema.isMaxLength(16))),
  environment: Schema.optionalKey(Identifier),
  view: Schema.optionalKey(SemanticAgentBufferView),
  handle: Schema.optionalKey(SemanticProposalHandle),
  offset: Schema.optionalKey(Counter),
  milliseconds: Milliseconds,
  maxBytes: Counter.check(
    Schema.isBetween({
      minimum: semanticAgentChangeLimits.minPageBytes,
      maximum: semanticAgentChangeLimits.maxPageBytes,
    }),
  ),
});
export type SemanticAgentEndpointChange = typeof SemanticAgentEndpointChange.Type;
export const changeRefusal = (status: string, reason: string) => ({
  version: 1 as const,
  status,
  reason,
  applicable: false as const,
  writerAuthorityRequired: true as const,
});

/** Output-only local deadline attribution; never a writer grant or owned-process cleanup receipt. */
const TimeoutMeasurement = {
  elapsedMilliseconds: Counter,
  phaseElapsedMilliseconds: Counter,
  budgetMilliseconds: Milliseconds,
  remainingMilliseconds: Counter.check(Schema.isLessThanOrEqualTo(semanticAgentChangeLimits.maxMilliseconds)),
  terminal: Schema.Literal('timeout'),
  cleanup: Schema.Literal('unobserved'),
};
export const SemanticChangeTimeoutObservation = Schema.Union([
  Schema.Struct({
    origin: Schema.Literal('host'),
    phase: Schema.Literals([
      'validate-request',
      'host-scope',
      'source-scope',
      'endpoint-connect',
      'endpoint-request',
      'host-publication',
    ]),
    ...TimeoutMeasurement,
  }),
  Schema.Struct({
    origin: Schema.Literal('service'),
    phase: Schema.Literals([
      'scope-check',
      'source-attach',
      'choice-binding',
      'provider-use',
      'source-currentness',
      'retain-result',
      'publication',
      'retained-proposal-check',
    ]),
    ...TimeoutMeasurement,
  }),
]);
export type SemanticChangeTimeoutObservation = typeof SemanticChangeTimeoutObservation.Type;
export const changeTimeoutRefusal = (diagnostic: SemanticChangeTimeoutObservation) => ({
  ...changeRefusal('timeout', 'Proposal deadline expired'),
  diagnostic,
});
