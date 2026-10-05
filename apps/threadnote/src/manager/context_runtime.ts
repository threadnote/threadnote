import {Effect, Ref} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  runCodeGraphAutomaticCompactionScheduler,
  type CodeGraphAutomaticCompactionStatus,
} from '@threadnote/graph/automatic/compaction';
import {runContextMaintenanceScheduler} from '../memory/context/maintenance.js';

export const startManagerContextSchedulers = Effect.fn('manager.contextSchedulers')(function* (
  config: RuntimeConfig,
  status: Ref.Ref<CodeGraphAutomaticCompactionStatus>,
) {
  yield* Effect.forkScoped(runContextMaintenanceScheduler(config));
  yield* Effect.forkScoped(
    runCodeGraphAutomaticCompactionScheduler(config.agentContextHome, next => Ref.set(status, next)),
  );
});
