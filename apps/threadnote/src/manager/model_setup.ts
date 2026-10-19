import {Effect, Stream} from 'effect';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';
import {ManagerRequestError, type ManagerHttpRequest} from '@threadnote/manager/server';
import type {ModelSetupAction, ModelSetupStatus} from '@threadnote/manager/model-setup-contracts';
import {readModelSetupStatus, requestModelSetup, setModelSetupPolicy} from '../models/setup.js';

const invalidRequest = {status: 400, body: {error: 'Choose a valid model setup action and confirm it.'}} as const;

/** Bound the raw stream before JSON parsing; Bun's request.json does not honor MaxBodySize. */
export const readManagerModelSetupBody = Effect.fn('manager.modelSetup.body')(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  yield* request.stream.pipe(
    Stream.runForEach(chunk => {
      size += chunk.byteLength;
      if (size > 4096) return Effect.fail(ManagerRequestError.make({message: 'Model setup request is too large.'}));
      chunks.push(chunk);
      return Effect.void;
    }),
  );
  return yield* Effect.try({
    try: () => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
      return value as Record<string, unknown>;
    },
    catch: () => ManagerRequestError.make({message: 'Expected a model setup JSON object.'}),
  });
});

function parseAction(body: Record<string, unknown>): ModelSetupAction | undefined {
  if (
    body.confirm !== true ||
    !Number.isSafeInteger(body.expectedEpoch) ||
    (body.expectedEpoch as number) < 0 ||
    Object.keys(body).some(key => !['action', 'confirm', 'policy', 'expectedEpoch'].includes(key))
  )
    return undefined;
  if (body.action === 'policy') {
    if (body.policy !== 'automatic' && body.policy !== 'off') return undefined;
    return {action: 'policy', confirm: true, policy: body.policy, expectedEpoch: body.expectedEpoch as number};
  }
  if ((body.action === 'setup' || body.action === 'retry') && body.policy === undefined)
    return {action: body.action, confirm: true, expectedEpoch: body.expectedEpoch as number};
  return undefined;
}

/** Authentication is checked before the lazy request body or any setup service is evaluated. */
export const handleManagerModelSetupRequest = Effect.fn('manager.modelSetup')(
  function* (home: string, request: ManagerHttpRequest, authorized: boolean) {
    if (!authorized) return {status: 401, body: {error: 'Unauthorized'}};
    if (request.method === 'GET') {
      const status: ModelSetupStatus = yield* readModelSetupStatus(home);
      return {status: 200, body: status};
    }
    if (request.method !== 'POST') return {status: 405, body: {error: 'Method not allowed'}};
    const body = yield* request.body.pipe(Effect.orElseSucceed(() => undefined));
    const action = body && parseAction(body);
    if (!action) return invalidRequest;
    const current = yield* readModelSetupStatus(home);
    if (current.environmentOff)
      return {
        status: 409,
        body: {error: 'Model setup is controlled by the THREADNOTE_MODEL_SETUP environment setting.'},
      };
    if (current.intentEpoch !== action.expectedEpoch)
      return {status: 409, body: {error: 'Model setup changed. Refresh its status before trying again.'}};
    const status: ModelSetupStatus =
      action.action === 'policy'
        ? yield* setModelSetupPolicy(home, action.policy === 'automatic', {expectedEpoch: action.expectedEpoch})
        : yield* requestModelSetup(home, {retry: action.action === 'retry', expectedEpoch: action.expectedEpoch});
    return {status: 200, body: status};
  },
  Effect.orElseSucceed(() => ({
    status: 409,
    body: {error: 'Model setup could not apply this action. Refresh its status and retry.'},
  })),
);
