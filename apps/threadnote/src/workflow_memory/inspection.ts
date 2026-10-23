import {Effect} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {stableJson, workflowError, type WorkflowJournal, type WorkflowOperationInspectionRequest} from './protocol.js';

/** The caller must validate this journal under its workflow lock with manifest recovery disabled. */
export const inspectWorkflowOperation = Effect.fn('workflowMemory.inspectOperation')(function* (
  state: WorkflowJournal,
  request: WorkflowOperationInspectionRequest,
) {
  const bindingHash = sha256HexSync(stableJson(state.binding));
  if (
    state.binding.bindingId !== request.bindingId ||
    state.binding.generation !== request.generation ||
    bindingHash !== request.bindingHash
  )
    return yield* workflowError(
      'binding-drift',
      'The expected workflow binding or generation differs from native state.',
    );
  const operation = Object.hasOwn(state.operations, request.operationId)
    ? state.operations[request.operationId]
    : undefined;
  if (operation && operation.intentDigest !== request.intentDigest)
    return yield* workflowError('operation-intent-conflict', 'The operation identifier has a different native intent.');
  return {
    protocolVersion: 1 as const,
    status: 'ok' as const,
    bindingId: state.binding.bindingId,
    generation: state.binding.generation,
    bindingHash,
    operationId: request.operationId,
    intentDigest: request.intentDigest,
    operationState: operation?.status ?? 'absent',
  };
});
