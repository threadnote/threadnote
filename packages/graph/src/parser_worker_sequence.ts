import {Option, Predicate, Schema} from 'effect';
import {
  CodeGraphSourceSequenceOutcomeSchema,
  CodeGraphSourceSequenceRequestSchema,
  projectCodeGraphSourceSequence,
  type CodeGraphSourceSequenceOutcome,
  type CodeGraphSourceSequenceRequest,
} from './query/diagram_sequence.js';
import {boundedNativeTypeScriptSession, type NativeTypeScriptExtractionSession} from './typescript_runtime.js';

/** The parser worker line protocol, shared by file extraction and diagram source order. */
export const PARSER_WORKER_PROTOCOL_VERSION = 1;
type Protocol = typeof PARSER_WORKER_PROTOCOL_VERSION;

/** A diagram's source-order projection, run where the worker's borrowed native TypeScript session lives. */
export interface ParserWorkerSourceSequenceRequest {
  readonly id: string;
  readonly protocol: Protocol;
  /** Wall-clock end of the caller's diagram budget; the worker only shortens it. */
  readonly deadline: number;
  readonly sequence: CodeGraphSourceSequenceRequest;
}

export type ParserWorkerSourceSequenceResponse =
  | {readonly error: {readonly summary: string}; readonly id: string; readonly ok: false; readonly protocol: Protocol}
  | {
      readonly id: string;
      readonly ok: true;
      readonly outcome: CodeGraphSourceSequenceOutcome;
      readonly protocol: Protocol;
      readonly recycle: boolean;
    };

export const sourceSequenceUnavailable: CodeGraphSourceSequenceOutcome = {status: 'unavailable'};

/** Projects with the borrowed session until `deadline`; every session failure or refusal is `unavailable`. */
export function projectParserWorkerSourceSequence(
  request: ParserWorkerSourceSequenceRequest,
  session: NativeTypeScriptExtractionSession,
  deadline: number,
  observe: <A>(operation: Promise<A>) => Promise<A>,
): Promise<CodeGraphSourceSequenceOutcome> {
  return projectCodeGraphSourceSequence(
    request.sequence,
    boundedNativeTypeScriptSession(session, Math.min(request.deadline, deadline), observe),
  ).then(
    (sequence): CodeGraphSourceSequenceOutcome =>
      sequence === undefined ? {status: 'projected'} : {status: 'projected', sequence},
    () => sourceSequenceUnavailable,
  );
}

export function decodeSourceSequenceRequest(value: {
  readonly [key: string]: unknown;
}): ParserWorkerSourceSequenceRequest | undefined {
  if (
    value.protocol !== PARSER_WORKER_PROTOCOL_VERSION ||
    typeof value.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(value.id) ||
    typeof value.deadline !== 'number' ||
    !Number.isFinite(value.deadline)
  )
    return undefined;
  const sequence = Schema.decodeUnknownOption(CodeGraphSourceSequenceRequestSchema)(value.sequence);
  return Option.isSome(sequence)
    ? {deadline: value.deadline, id: value.id, protocol: PARSER_WORKER_PROTOCOL_VERSION, sequence: sequence.value}
    : undefined;
}

export function decodeSourceSequenceResponse(
  value: unknown,
  expectedId: string,
): ParserWorkerSourceSequenceResponse | undefined {
  if (
    !Predicate.isObject(value) ||
    value.protocol !== PARSER_WORKER_PROTOCOL_VERSION ||
    value.id !== expectedId ||
    typeof value.ok !== 'boolean'
  )
    return undefined;
  if (!value.ok)
    return Predicate.isObject(value.error) && typeof value.error.summary === 'string'
      ? {error: {summary: value.error.summary}, id: expectedId, ok: false, protocol: PARSER_WORKER_PROTOCOL_VERSION}
      : undefined;
  const outcome = Schema.decodeUnknownOption(CodeGraphSourceSequenceOutcomeSchema)(value.outcome);
  return Option.isSome(outcome) && typeof value.recycle === 'boolean'
    ? {
        id: expectedId,
        ok: true,
        outcome: outcome.value,
        protocol: PARSER_WORKER_PROTOCOL_VERSION,
        recycle: value.recycle,
      }
    : undefined;
}
