import {Array as EffectArray} from 'effect';
import {Cause, Effect, Schema} from 'effect';
import {
  readManageableThreadnoteProcessDiagnostics,
  terminateThreadnoteProcess,
  ThreadnoteProcessTerminationError,
} from '../process/diagnostics.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface ManagerProcessApiResponse {
  readonly body: unknown;
  readonly status: number;
}

export interface ManagerProcessApiRequest {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly config: RuntimeConfig;
  readonly method: string;
  readonly url: URL;
}

class ManagerProcessApiError extends Schema.TaggedError<ManagerProcessApiError, {readonly brand: unique symbol}>()(
  'ManagerProcessApiError',
  {
    code: Schema.String,
    message: Schema.String,
    status: Schema.Finite,
  },
) {
  static of(code: string, message: string, status: number): ManagerProcessApiError {
    return ManagerProcessApiError.make({code, message, status});
  }
}

export function isManagerProcessApiPath(pathname: string): boolean {
  return pathname === '/api/processes' || Effect2.pipe(pathname, EffectString.startsWith('/api/processes/'));
}

export const handleManagerProcessRequest = Effect.fn('managerProcesses.handleRequest')(function* (
  request: ManagerProcessApiRequest,
) {
  if (!isManagerProcessApiPath(request.url.pathname)) return undefined;
  return yield* routeManagerProcessRequest(request).pipe(
    Effect.catchCause(cause => Effect.succeed(managerProcessErrorResponse(Cause.squash(cause)))),
  );
});

function routeManagerProcessRequest(request: ManagerProcessApiRequest) {
  return Effect.gen(function* () {
    if (request.method === 'GET' && request.url.pathname === '/api/processes') {
      return response(200, yield* readManageableThreadnoteProcessDiagnostics(request.config));
    }
    if (request.method !== 'POST' || request.url.pathname !== '/api/processes/terminate') {
      return response(404, {error: 'Not found'});
    }
    const body = yield* request.body.pipe(
      Effect.mapError(() => ManagerProcessApiError.of('invalid-json', 'Provide a JSON object request body.', 400)),
    );
    if (typeof body !== 'object' || body === null || EffectArray.isArray(body)) {
      throw ManagerProcessApiError.of('invalid-json', 'Provide a JSON object request body.', 400);
    }
    if (body.confirm !== true) {
      throw ManagerProcessApiError.of(
        'confirmation-required',
        'Confirm termination of the selected Threadnote process.',
        400,
      );
    }
    if (!Number.isSafeInteger(body.processId) || Number(body.processId) <= 0 || typeof body.processRef !== 'string') {
      throw ManagerProcessApiError.of('invalid-process-target', 'The process target is invalid.', 400);
    }
    return response(
      200,
      yield* terminateThreadnoteProcess(request.config, {
        processId: Number(body.processId),
        processRef: body.processRef,
      }),
    );
  });
}

function managerProcessErrorResponse(error: unknown): ManagerProcessApiResponse {
  if (Schema.is(ManagerProcessApiError)(error)) {
    return response(error.status, {code: error.code, error: error.message, retryAfterMilliseconds: 0});
  }
  if (Schema.is(ThreadnoteProcessTerminationError)(error)) {
    const status =
      error.code === 'invalid-process-target'
        ? 400
        : error.code === 'process-permission-denied'
          ? 403
          : error.code === 'process-not-found'
            ? 404
            : error.code === 'process-signal-failed'
              ? 500
              : 409;
    return response(status, {code: error.code, error: error.message, retryAfterMilliseconds: 0});
  }
  return response(500, {
    code: 'process-operation-failed',
    error: 'The Threadnote process operation failed.',
    retryAfterMilliseconds: 0,
  });
}

function response(status: number, body: unknown): ManagerProcessApiResponse {
  return {body, status};
}
