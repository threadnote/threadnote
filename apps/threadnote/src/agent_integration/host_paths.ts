import {Effect, Path} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import type {AgentClient} from '../types.js';
import {expandPath} from '@threadnote/platform/paths';

export interface AgentHostPaths {
  readonly agentRoot: string;
  readonly hookPath: string;
  readonly instructionPath: string;
  readonly mcpConfigPath: string;
  readonly skillRoot: string;
}

/** Resolves host-owned locations for agent clients with relocatable roots. */
export const resolveAgentHostPaths = Effect.fn('agentIntegrations.resolveHostPaths')(function* (
  agent: AgentClient,
  hostRoot?: string,
) {
  if (agent !== 'omp') return undefined;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const environment = system.environment();
  const profile = environment.OMP_PROFILE ?? environment.PI_PROFILE;
  const agentRoot =
    hostRoot ??
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves TypeScript narrowing across this conditional.
    (profile?.trim()
      ? // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The branch uses the value narrowed by the optional-chain condition.
        path.join(system.homeDirectory, '.omp', 'profiles', profile.trim(), 'agent')
      : // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves TypeScript narrowing across this conditional.
        environment.PI_CODING_AGENT_DIR?.trim()
        ? yield* expandPath(environment.PI_CODING_AGENT_DIR)
        : yield* expandPath('~/.omp/agent'));
  return {
    agentRoot,
    hookPath: path.join(agentRoot, 'hooks', 'pre', 'threadnote.ts'),
    instructionPath: path.join(agentRoot, 'AGENTS.md'),
    mcpConfigPath: path.join(agentRoot, 'mcp.json'),
    skillRoot: path.join(agentRoot, 'skills'),
  } satisfies AgentHostPaths;
});
