import {Context} from 'effect';

/**
 * True only inside the detached automatic maintenance tick. That tick never refreshes the lexical index and never
 * resumes or wakes embedding workers. Demand it records stays durable for the next ordinary CLI or MCP process.
 */
export const ContextMaintenanceWorkerMode = Context.Reference<boolean>(
  '@threadnote/threadnote/memory/context/maintenance_worker_mode/ContextMaintenanceWorkerMode',
  {defaultValue: () => false},
);
