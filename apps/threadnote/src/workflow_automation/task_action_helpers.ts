import {SystemInfo} from '@threadnote/platform/system';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {Effect, Predicate} from 'effect';
import type {readNativeWorkflowState} from './store.js';

export type NativeTaskStoredState = NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>;
export type NativeTaskCycleRuntime = NonNullable<NativeTaskStoredState['state']['cycle']>;
export const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});

export const inCheckout = <A, E, R>(program: Effect.Effect<A, E, R>, checkout: string) =>
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    return yield* program.pipe(Effect.provideService(SystemInfo, {...system, currentDirectory: () => checkout}));
  });

export const cycleRequest = (
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  request: object,
) => ({
  protocolVersion: 1,
  executorVersion: 1,
  action: 'cycle',
  runId: stored.state.runId,
  generation: stored.state.generation,
  ...request,
});

export const unwrapCycle = (result: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(result) || result.status !== 'ok' || !Predicate.isObject(result.cycle))
    throw fail(
      Predicate.isObject(result) && typeof result.code === 'string' ? result.code : 'task-action-failed',
      Predicate.isObject(result) && Predicate.isObject(result.cycle) && typeof result.cycle.message === 'string'
        ? result.cycle.message
        : 'The native cycle action did not return an admitted result.',
    );
  return result.cycle;
};
