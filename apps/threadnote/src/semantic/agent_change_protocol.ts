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
]);
export type SemanticAgentChangeRequest = typeof SemanticAgentChangeRequest.Type;
export const SemanticAgentEndpointChange = Schema.Struct({
  version: Schema.Literal(1),
  worktree: FileUri,
  profile: Digest,
  principal: Digest,
  action: Schema.Literals(['prepare', 'status', 'preflight']),
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
