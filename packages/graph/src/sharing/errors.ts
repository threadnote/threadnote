import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const GRAPH_SHARING_ERROR_KINDS = ['unavailable', 'verification-failed'] as const;
export type GraphSharingErrorKind = (typeof GRAPH_SHARING_ERROR_KINDS)[number];

export class GraphSharingError extends Schema.TaggedError<GraphSharingError, {readonly brand: unique symbol}>()(
  'GraphSharingError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    kind: Schema.Literals(['unavailable', 'verification-failed']),
    message: Schema.String,
    httpStatus: Schema.optionalKey(Schema.Int),
    retryAfterMilliseconds: Schema.optionalKey(Schema.Finite),
  },
) {}

export function graphSharingFailure(
  message: string,
  cause?: unknown,
  kind: GraphSharingErrorKind = 'verification-failed',
): GraphSharingError {
  return cause === undefined ? GraphSharingError.make({kind, message}) : GraphSharingError.make({cause, kind, message});
}

export function graphSharingUnavailable(message: string): GraphSharingError {
  return GraphSharingError.make({kind: 'unavailable', message});
}

export function graphSharingHttpFailure(status: number, retryAfterMilliseconds?: number): GraphSharingError {
  return GraphSharingError.make({
    kind: status === 408 || status === 425 || status === 429 || status >= 500 ? 'unavailable' : 'verification-failed',
    message: `Graph-sharing endpoint returned HTTP ${status}.`,
    httpStatus: status,
    ...(retryAfterMilliseconds === undefined ? {} : {retryAfterMilliseconds}),
  });
}

export function graphShareRetryAfterMilliseconds(
  value: string | undefined,
  nowMilliseconds: number,
): number | undefined {
  if (value === undefined) return undefined;
  const seconds = /^\d+$/u.test(Effect.pipe(value, EffectString.trim))
    ? Number(Effect.pipe(value, EffectString.trim))
    : undefined;
  if (seconds === undefined && !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/iu.test(Effect.pipe(value, EffectString.trim)))
    return undefined;
  const delay = seconds === undefined ? Date.parse(value) - nowMilliseconds : seconds * 1_000;
  return Number.isFinite(delay) && delay >= 0
    ? Math.min(delay, Number.MAX_SAFE_INTEGER - Math.max(0, nowMilliseconds))
    : undefined;
}
