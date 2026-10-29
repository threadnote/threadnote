import {Array as EffectArray} from 'effect';
import {Cause, DateTime, Effect, Schema} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  buildLocalValueReport,
  DEFAULT_VALUE_REPORT_RETENTION_DAYS,
  MAXIMUM_VALUE_REPORT_RETENTION_DAYS,
} from '../value_report/commands.js';
import {deleteValueReportData, pruneValueReportData} from '../value_report/storage.js';
import {handleManagerContextRequest, type ManagerContextApiRequest} from './context.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface ManagerValueApiRequest {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly config: RuntimeConfig;
  readonly deleteData?: typeof deleteManagerValueData;
  readonly method: string;
  readonly report?: typeof runManagerValueReport;
  readonly retention?: typeof runManagerValueRetention;
  readonly url: URL;
}

export interface ManagerValueApiResponse {
  readonly body: unknown;
  readonly status: number;
}

class ManagerValueApiError extends Schema.TaggedError<ManagerValueApiError, {readonly brand: unique symbol}>()(
  'ManagerValueApiError',
  {
    code: Schema.String,
    message: Schema.String,
    status: Schema.Finite,
  },
) {
  static of(code: string, message: string, status: number): ManagerValueApiError {
    return ManagerValueApiError.make({code, message, status});
  }
}

export function isManagerValueApiPath(pathname: string): boolean {
  return pathname === '/api/value/report' || pathname === '/api/value/retention' || pathname === '/api/value/delete';
}

export const handleManagerWorkspaceRequest = Effect.fn('managerWorkspace.handleRequest')(function* (
  request: ManagerContextApiRequest & ManagerValueApiRequest,
) {
  const contextResponse = yield* handleManagerContextRequest(request);
  return contextResponse ?? (yield* handleManagerValueRequest(request));
});

export const handleManagerValueRequest = Effect.fn('managerValue.handleRequest')(function* (
  request: ManagerValueApiRequest,
) {
  if (!isManagerValueApiPath(request.url.pathname)) return yield* succeedUndefined;
  return yield* routeManagerValueRequest(request).pipe(
    Effect.catchCause(cause => {
      const error = Cause.squash(cause);
      return Effect.succeed(
        Schema.is(ManagerValueApiError)(error)
          ? response(error.status, {code: error.code, error: error.message})
          : response(500, {
              code: 'value-operation-failed',
              error: 'Threadnote could not complete this value operation.',
            }),
      );
    }),
  );
});

function routeManagerValueRequest(request: ManagerValueApiRequest) {
  return Effect.gen(function* () {
    if (request.method !== 'POST') return response(404, {error: 'Not found'});
    const body = yield* request.body.pipe(
      Effect.mapError(() => ManagerValueApiError.of('invalid-json', 'Provide a JSON object request body.', 400)),
    );
    switch (request.url.pathname) {
      case '/api/value/report':
        return response(200, yield* (request.report ?? runManagerValueReport)(request.config, body));
      case '/api/value/retention':
        return response(200, yield* (request.retention ?? runManagerValueRetention)(request.config, body));
      case '/api/value/delete':
        return response(200, yield* (request.deleteData ?? deleteManagerValueData)(request.config, body));
      default:
        return response(404, {error: 'Not found'});
    }
  });
}

export const runManagerValueReport = Effect.fn('managerValue.report')(function* (
  config: RuntimeConfig,
  body: Record<string, unknown>,
) {
  exactKeys(body, new Set(['period', 'project']), 'value report request');
  return yield* buildLocalValueReport(config, {
    period: optionalInteger(body.period, 'period', 1, 3_650),
    project: optionalText(body.project, 'project', 256),
  });
});

export const runManagerValueRetention = Effect.fn('managerValue.retention')(function* (
  config: RuntimeConfig,
  body: Record<string, unknown>,
) {
  exactKeys(body, new Set(['apply', 'days']), 'value retention request');
  const retentionDays =
    optionalInteger(body.days, 'days', 1, MAXIMUM_VALUE_REPORT_RETENTION_DAYS) ?? DEFAULT_VALUE_REPORT_RETENTION_DAYS;
  return yield* pruneValueReportData(config.agentContextHome, {
    apply: optionalBoolean(body.apply, 'apply') ?? false,
    now: DateTime.toDateUtc(yield* DateTime.now),
    retentionDays,
  });
});

export const deleteManagerValueData = Effect.fn('managerValue.delete')(function* (
  config: RuntimeConfig,
  body: Record<string, unknown>,
) {
  exactKeys(body, new Set(['apply', 'events', 'exports', 'feedback']), 'value deletion request');
  const selection = {
    exports: optionalBoolean(body.exports, 'exports') ?? false,
    feedback: optionalBoolean(body.feedback, 'feedback') ?? false,
    valueEvents: optionalBoolean(body.events, 'events') ?? false,
  };
  if (!selection.feedback && !selection.valueEvents && !selection.exports) {
    throw ManagerValueApiError.of('value-selection-required', 'Select feedback, value events, or exports.', 400);
  }
  return yield* deleteValueReportData(config.agentContextHome, {
    apply: optionalBoolean(body.apply, 'apply') ?? false,
    ...selection,
  });
});

function response(status: number, body: unknown): ManagerValueApiResponse {
  return {body, status};
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unsupported = EffectArray.filter(EffectRecord.keys(value), key => !allowed.has(key)).sort();
  if (unsupported.length > 0) {
    throw ManagerValueApiError.of('invalid-request', `${label} has unsupported field ${unsupported[0]}.`, 400);
  }
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw ManagerValueApiError.of(
      'invalid-request',
      `${label} must be a whole number from ${minimum} to ${maximum}.`,
      400,
    );
  }
  return Number(value);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw ManagerValueApiError.of('invalid-request', `${label} must be boolean.`, 400);
  }
  return value;
}

function optionalText(value: unknown, label: string, maximumBytes: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw ManagerValueApiError.of('invalid-request', `${label} must be text.`, 400);
  }
  const normalized = Effect2.pipe(
    value,
    EffectString.normalize('NFKC'),
    EffectString.replace(/\s+/gu, ' '),
    EffectString.trim,
  );
  if (!normalized || new TextEncoder().encode(normalized).byteLength > maximumBytes || hasControl(normalized)) {
    throw ManagerValueApiError.of('invalid-request', `${label} must be bounded text without control characters.`, 400);
  }
  return normalized;
}

function hasControl(value: string): boolean {
  return EffectArray.some([...value], character => {
    const code =
      Effect2.pipe(
        character,
        EffectString.codePointAt(0),
        Effect2.Option.getOrElse(() => undefined),
      ) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}
