import {Effect, Scope} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {handleManagerActivationRequest} from './activation.js';
import {handleManagerAttentionRequest} from './attention.js';
import {handleManagerAttentionAction} from './attention_actions.js';
import {handleManagerHomeRequest} from './home.js';
import {handleManagerUpdateRequest} from './updates.js';

export const handleManagerWorkflowRequest = Effect.fn('managerWorkflow.handleRequest')(function* (request: {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly config: RuntimeConfig;
  readonly jobContext?: {readonly key: object; readonly scope: Scope.Scope};
  readonly method: string;
  readonly url: URL;
}) {
  const updates = yield* handleManagerUpdateRequest(request);
  if (updates !== undefined) return updates;
  const action = yield* handleManagerAttentionAction(request);
  if (action !== undefined) return action;
  const home = yield* handleManagerHomeRequest(request);
  if (home !== undefined) return home;
  const attention = yield* handleManagerAttentionRequest(request);
  if (attention !== undefined) return attention;
  return yield* handleManagerActivationRequest(request);
});
