import {Effect} from 'effect';
import {uriSegment} from '@threadnote/store/resource-segment';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {normalizeTeamName, readTeamsFile} from '../share/core.js';
import {validateWorkflowInput, workflowError, type WorkflowBinding} from './protocol.js';

/** Read/reference authority only; never adds mutation ownership or changes a binding. */
export const readWorkflowSharedRoots = Effect.fn('workflowMemory.sharedRoots')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
) {
  // Existing desktop bindings intentionally have sharedRoots: []. Resolve their
  // currently configured shares without rebinding; cloud authority stays pinned.
  if (binding.profile !== 'desktop') return binding.sharedRoots;
  const teams = yield* readTeamsFile(config);
  return yield* validateWorkflowInput(() =>
    Object.keys(teams.teams).map(team => {
      if (normalizeTeamName(team) !== team)
        throw workflowError('invalid-share', 'Configured share names must be canonical.');
      return `threadnote://user/${uriSegment(config.user)}/memories/shared/${uriSegment(team)}`;
    }),
  );
});
