import {Schema} from 'effect';
export type RemoteMemoryErrorCode =
  | 'attestation_required'
  | 'conflict'
  | 'forbidden'
  | 'idempotency_mismatch'
  | 'invalid_request'
  | 'not_found'
  | 'rate_limited'
  | 'service_unavailable'
  | 'unauthorized';

export class RemoteMemoryError extends Schema.TaggedError<RemoteMemoryError, {readonly brand: unique symbol}>()(
  'RemoteMemoryError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    code: Schema.Literals([
      'attestation_required',
      'conflict',
      'forbidden',
      'idempotency_mismatch',
      'invalid_request',
      'not_found',
      'rate_limited',
      'service_unavailable',
      'unauthorized',
    ]),
    details: Schema.Any,
    message: Schema.String,
    status: Schema.Finite,
  },
) {
  static of(
    code: RemoteMemoryErrorCode,
    message: string,
    status: number,
    details: Readonly<Record<string, boolean | number | string>> = {},
    options?: ErrorOptions,
  ): RemoteMemoryError {
    return RemoteMemoryError.make({
      code,
      details,
      message,
      status,
      ...(options?.cause === undefined ? {} : {cause: options.cause}),
    });
  }
}

export function remoteMemoryError(
  code: RemoteMemoryErrorCode,
  message: string,
  details: Readonly<Record<string, boolean | number | string>> = {},
): RemoteMemoryError {
  return RemoteMemoryError.of(code, message, statusForCode(code), details);
}

export function publicRemoteMemoryError(cause: unknown): RemoteMemoryError {
  if (Schema.is(RemoteMemoryError)(cause)) return cause;
  return remoteMemoryError('service_unavailable', 'Remote memory could not complete the request.');
}

function statusForCode(code: RemoteMemoryErrorCode): number {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'attestation_required':
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
    case 'idempotency_mismatch':
      return 409;
    case 'invalid_request':
      return 400;
    case 'rate_limited':
      return 429;
    case 'service_unavailable':
      return 503;
  }
}
