import {Effect, FileSystem} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256Hex} from '@threadnote/platform/digest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {codexCloudMemoryScope} from '../codex/cloud.js';
import {readCodexCloudProfile, sameCloudIdentity} from '../codex/profile.js';
import {readCursorCloudIdentityProfile} from '../cursor/profile.js';
import {assertCursorCloudMemoryTeamsReady, resolveCursorCloudMemoryScope} from '../cursor/cloud.js';
import {resolveTeam} from '../share/core.js';
import {gitValue} from '../utils.js';
import {
  portableKey,
  requiredText,
  stableJson,
  workflowError,
  validateWorkflowInput,
  type WorkflowBinding,
  type WorkflowRequest,
} from './protocol.js';

/** Resolve authority from configured profiles. A request cannot opt out of a cloud profile. */
export const resolveWorkflowBinding = Effect.fn('workflowMemory.resolveBinding')(function* (
  config: RuntimeConfig,
  request: WorkflowRequest,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const environment = system.environment();
  const mode = environment.THREADNOTE_CURSOR_CLOUD_MODE?.trim();
  const toolset = environment.THREADNOTE_MCP_TOOLSET?.trim();
  if (
    (mode && mode !== 'personal') ||
    environment.THREADNOTE_CURSOR_MEMORY_ENDPOINT ||
    environment.THREADNOTE_CURSOR_MEMORY_SHARE_ID ||
    (toolset && ['cursor-cloud-local', 'org', 'remote-hybrid'].includes(toolset))
  ) {
    return yield* workflowError(
      'unsupported-profile',
      'Development workflows support personal Codex/Cursor cloud profiles only. Corporate and remote-hybrid profiles are unsupported.',
    );
  }
  const codex = yield* readCodexCloudProfile(config.agentContextHome);
  const cursor = yield* readCursorCloudIdentityProfile(config.agentContextHome);
  if ([codex, cursor].some(profile => profile && !sameCloudIdentity(profile, config)))
    return yield* workflowError('identity-drift', 'The configured cloud identity differs from this runtime.');
  const detected =
    codex && cursor ? request.profile : codex ? 'codex-cloud-personal' : cursor ? 'cursor-cloud-personal' : 'desktop';
  if (!detected || (request.profile !== undefined && request.profile !== detected))
    return yield* workflowError(
      'profile-conflict',
      'Select the matching configured workflow profile; existing cloud profiles cannot be interpreted as desktop.',
    );
  if (
    detected === 'desktop' &&
    (codex || cursor || mode || toolset?.startsWith('cursor-cloud') || toolset?.startsWith('codex-cloud'))
  )
    return yield* workflowError(
      'profile-missing',
      'Bootstrap and select the personal cloud profile before creating a workflow.',
    );
  if ((detected === 'codex-cloud-personal' && !codex) || (detected === 'cursor-cloud-personal' && !cursor))
    return yield* workflowError('profile-missing', 'The requested personal cloud profile is not configured.');
  const home = yield* fs.realPath(config.agentContextHome);
  const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel'], system.currentDirectory());
  if (!repoRoot) return yield* workflowError('repository-missing', 'Run the workflow from its Git checkout.');
  const repo = yield* fs.realPath(repoRoot);
  const scope =
    detected === 'codex-cloud-personal'
      ? yield* codexCloudMemoryScope(config)
      : detected === 'cursor-cloud-personal'
        ? yield* resolveCursorCloudMemoryScope(config, environment)
        : undefined;
  if (detected === 'cursor-cloud-personal')
    yield* assertCursorCloudMemoryTeamsReady(
      config,
      scope!.shares.map(share => share.team),
    );
  if (scope && scope.shares.length > 1 && !request.team)
    return yield* workflowError('team-required', 'Select one configured personal share for this workflow.');
  const team = scope ? (request.team ?? scope.shares[0]?.team) : undefined;
  if (scope && (!team || !scope.shares.some(share => share.team === team)))
    return yield* workflowError('team-out-of-scope', 'The selected share is outside the personal profile.');
  if (!scope && request.team)
    return yield* workflowError('team-out-of-scope', 'Desktop private workflow bindings do not select a cloud share.');
  const selected = team ? yield* resolveTeam(config, team) : undefined;
  const branch = selected ? yield* gitValue(['symbolic-ref', '--short', 'HEAD'], selected.config.worktree) : undefined;
  if (selected && !branch)
    return yield* workflowError('share-branch-missing', 'The selected share must have a branch checkout.');
  const identifiers = yield* validateWorkflowInput(() => ({
    workflowRunId: portableKey(request.workflowRunId, 'workflowRunId'),
    project: portableKey(request.project, 'project'),
    featureId: portableKey(request.featureId, 'featureId'),
    generation: requiredText(request.generation, 'generation'),
  }));
  const context = {
    ...identifiers,
    profile: detected,
    home,
    repo,
    account: config.account,
    user: config.user,
    agentId: config.agentId,
    ...(selected ? {team, remote: selected.config.remote, branch} : {}),
    sharedRoots: scope?.shares.map(share => share.root).sort() ?? [],
    artifactLifetime: detected === 'desktop' ? ('local-home' as const) : ('possibly-ephemeral-workspace' as const),
  };
  return {...context, bindingId: yield* sha256Hex(stableJson(context))} satisfies WorkflowBinding;
});

export const verifyWorkflowBinding = Effect.fn('workflowMemory.verifyBinding')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
) {
  const current = yield* resolveWorkflowBinding(config, {protocolVersion: 1, action: 'bind', ...binding});
  if (stableJson(current) !== stableJson(binding))
    return yield* workflowError(
      'binding-drift',
      'Workflow identity, home, checkout, profile or share changed. Resume in the original context.',
    );
});
