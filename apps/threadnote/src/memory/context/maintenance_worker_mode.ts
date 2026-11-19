import {Context, Effect} from 'effect';

/**
 * Present only around the detached automatic maintenance tick. Its preparation reads ready recall
 * identities and never refreshes the lexical index. Its application layer neither resumes nor wakes
 * embedding workers. Demand that the tick records stays durable for the next ordinary CLI or MCP process.
 */
export class ContextMaintenanceWorkerMode extends Context.Service<
  ContextMaintenanceWorkerMode,
  {readonly enabled: true}
>()('@threadnote/threadnote/memory/context/maintenance_worker_mode/ContextMaintenanceWorkerMode') {}

export const withContextMaintenanceWorkerMode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, ContextMaintenanceWorkerMode, {enabled: true});
