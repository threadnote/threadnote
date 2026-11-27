import {Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runWorkflowAutomation} from './index.js';
import {nativeWorkflowError} from './memory.js';
import {cycleRequest, inCheckout, unwrapCycle, type NativeTaskStoredState} from './task_action_helpers.js';

/**
 * Returns a freshly invalidated phase to pending so the task card stays on it. A refused resume (another phase awaits
 * delivery, or its parents are not accepted) leaves the phase stale, which is the earlier reopen behavior.
 */
export const resumeReopenedNativeTaskPhase = (
  config: RuntimeConfig,
  stored: NativeTaskStoredState,
  invalidatedRevision: unknown,
  {phaseId, reason}: {readonly phaseId: string; readonly reason: string},
  checkout: string,
) =>
  typeof invalidatedRevision !== 'string'
    ? Effect.void
    : inCheckout(
        runWorkflowAutomation(
          config,
          cycleRequest(stored, {command: 'resume-phase', phaseId, reason, expectedRevision: invalidatedRevision}),
        ),
        checkout,
      ).pipe(
        Effect.flatMap(result => Effect.try({try: () => unwrapCycle(result), catch: nativeWorkflowError})),
        Effect.catchIf(
          error => ['delivery-pending', 'dependency-stale'].includes(nativeWorkflowError(error).code),
          () => Effect.void,
        ),
      );
