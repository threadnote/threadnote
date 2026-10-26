import {Effect, Path} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readWorkflowReadiness} from '../workflow_memory/profile.js';
import {findExecutable} from '../utils.js';
import type {DevSkillsIssue, DevSkillsManifest, DevSkillsReadiness, DevSkillsTarget} from './contract.js';
import {readOptional} from './files.js';
import {
  AGENT_SKILLS,
  CODEX_CLOUD_PERSONAL_AGENT_SKILLS,
  CURSOR_CLOUD_PERSONAL_AGENT_SKILLS,
} from '../agent_integration/skills.js';
import {devSkillsCompatibility, devSkillsRuntimeVersion} from './manifest.js';

/** Configuration/executable probes only; installation never depends on task/share readiness. */
export const devSkillsReadiness = Effect.fn('devSkills.readiness')(function* (
  config: RuntimeConfig,
  target: DevSkillsTarget,
  installed?: DevSkillsManifest,
) {
  const configured = yield* readWorkflowReadiness(config, target.profile);
  const prerequisites: DevSkillsIssue[] = installed
    ? devSkillsCompatibility(installed, yield* devSkillsRuntimeVersion())
    : [];
  for (const command of ['threadnote', 'git', 'rg'])
    if (!(yield* findExecutable([command])))
      prerequisites.push({code: 'missing-command', message: `Install ${command} and expose it in the agent's PATH.`});
  const path = yield* Path.Path;
  const coreSkills =
    target.profile === 'codex-cloud-personal'
      ? CODEX_CLOUD_PERSONAL_AGENT_SKILLS
      : target.profile === 'cursor-cloud-personal'
        ? CURSOR_CLOUD_PERSONAL_AGENT_SKILLS
        : AGENT_SKILLS;
  for (const id of coreSkills) {
    const file = path.join(target.skillRoot, target.layout === 'flat' ? `${id}.md` : `${id}/SKILL.md`);
    const observed = yield* readOptional(file).pipe(Effect.result);
    if (observed._tag === 'Failure' || observed.success === null)
      prerequisites.push({
        code: observed._tag === 'Failure' ? 'core-integration-unreadable' : 'core-integration-missing',
        message: 'Run standard Threadnote agent setup or repair for the core context integration.',
        path: file,
      });
  }
  const gh = yield* findExecutable(['gh']);
  const watchReasons = [
    ...prerequisites,
    ...(configured.planning.state === 'blocked' ? configured.planning.reasons : []),
    ...(gh
      ? []
      : [{code: 'missing-gh', message: 'Install gh and authenticate before watching a GitHub pull request.'}]),
  ];
  return {
    planning: prerequisites.length
      ? {state: 'blocked', reasons: [...prerequisites, ...configured.planning.reasons]}
      : configured.planning,
    publication: prerequisites.length
      ? {state: 'blocked', reasons: [...prerequisites, ...configured.publication.reasons]}
      : configured.publication,
    watch: watchReasons.length
      ? {state: 'blocked', reasons: watchReasons}
      : {
          state: 'unchecked',
          reasons: [
            {
              code: 'pr-auth-unchecked',
              message: 'GitHub authentication and PR permissions are checked when watch-pr starts.',
            },
          ],
        },
  } satisfies DevSkillsReadiness;
});
