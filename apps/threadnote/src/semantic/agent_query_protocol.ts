import {Schema} from 'effect';
import {Counter, Digest, Evidence, FileUri, Identifier, Position} from '@threadnote/semantic/contracts';
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
const Cursor = Schema.Struct({...Continuation.fields, observation: Schema.String.check(Schema.isMaxLength(32768))});
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
  view: Schema.optionalKey(Schema.Literal('disk')),
  maxItems: Schema.optionalKey(MaxItems),
  maxBytes: Schema.optionalKey(MaxBytes),
  milliseconds: Schema.optionalKey(Milliseconds),
  cursor: Schema.optionalKey(Cursor),
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
export type SemanticAgentQueryResult = typeof SemanticAgentQueryResult.Type;

export function formatSemanticAgentQuery(result: SemanticAgentQueryResult): string {
  // Canonical compact JSON preserves all outcomes, provenance and continuations without a second lossy projection.
  return JSON.stringify(result);
}
