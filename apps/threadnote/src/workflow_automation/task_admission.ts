import {Array as EffectArray, Effect, Schema} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {statusDevSkills} from '../dev_skills/index.js';
import {DevSkillsError, type DevSkillsTarget} from '../dev_skills/contract.js';
import {enrollmentContext} from '../dev_skills/registry.js';
import {fail, inCheckout} from './task_action_helpers.js';

const MAX_TARGET_CHOICES = 5;
const codeOf = (error: unknown) => (Schema.is(DevSkillsError)(error) ? error.code : 'inspection-failed');
const safeName = (value: string) => (/^[A-Za-z0-9._-]{1,128}$/u.test(value) ? value : '<recorded-target>');
const selectorFor = (target: DevSkillsTarget) => ({
  agent: target.surfaceId,
  scope: target.scope,
  profile: target.profile,
  ...(target.cwd === undefined ? {} : {cwd: target.cwd}),
});
const updateCommand = (target: DevSkillsTarget) =>
  `threadnote dev-skills update --agent ${safeName(target.surfaceId)} --scope ${target.scope} --profile ${target.profile}${target.cwd === undefined ? '' : ' --cwd .'}`;

/** Bounded diagnostics from recorded enrollments; one broken target does not hide the others. */
const targetChoices = Effect.fn('workflowTask.targetChoices')(function* (config: RuntimeConfig, checkout: string) {
  const context = yield* enrollmentContext(config).pipe(Effect.result);
  if (context._tag === 'Failure') return `Recorded target inspection failed (${codeOf(context.failure)}).`;
  const targets = EffectRecord.values(context.success.homeIndex.targets).sort((left, right) =>
    EffectString.localeCompare(right.target.surfaceId)(left.target.surfaceId),
  );
  if (targets.length === 0)
    return 'No recorded targets; install one with `threadnote dev-skills install --agent <agent>`, then retry.';
  const choices = yield* Effect.forEach(targets.slice(0, MAX_TARGET_CHOICES), entry =>
    inCheckout(statusDevSkills(config, selectorFor(entry.target)), checkout).pipe(
      Effect.result,
      Effect.map(result => {
        const state =
          result._tag === 'Success'
            ? (result.success.targets[0]?.installationState ?? 'unavailable')
            : `inspection failed (${codeOf(result.failure)})`;
        return `${safeName(entry.target.surfaceId)} [${entry.target.profile}/${entry.target.scope}]: ${state}`;
      }),
    ),
  );
  const remaining = targets.length - choices.length;
  return `Recorded targets: ${EffectArray.join(choices, '; ')}${remaining > 0 ? `; and ${remaining} more` : ''}.`;
});

const targetRecovery = Effect.fn('workflowTask.targetRecovery')(function* (
  config: RuntimeConfig,
  checkout: string,
  target?: DevSkillsTarget,
  reason?: string,
  updateAvailable = false,
) {
  const choices = yield* targetChoices(config, checkout);
  const command =
    updateAvailable && target?.scope && target?.surfaceId && /^[A-Za-z0-9._-]{1,128}$/u.test(target.surfaceId)
      ? ` Run ${updateCommand(target)}${target.cwd === undefined ? '' : ' from the target checkout'} to update this installation, then retry.`
      : '';
  return `Select installationTarget or --installation-target from the recorded targets.${reason ? ` Inspection code: ${reason}.` : ''} ${choices}${command}`;
});

/** The installed selector is checked for start and resume, never treated as actor/publication authority. */
export const readNativeTaskInstalledTarget = (
  config: RuntimeConfig,
  installationTarget: string | undefined,
  checkout: string,
  allowedProfiles: readonly ('desktop' | 'codex-cloud-personal' | 'cursor-cloud-personal')[] = ['desktop'],
) =>
  Effect.gen(function* () {
    if (!installationTarget) return yield* fail('needs-resources', yield* targetRecovery(config, checkout));
    const installed = yield* inCheckout(
      statusDevSkills(config, {agent: installationTarget}).pipe(Effect.result),
      checkout,
    );
    if (installed._tag === 'Failure')
      return yield* fail(
        'needs-resources',
        yield* targetRecovery(config, checkout, undefined, codeOf(installed.failure)),
      );
    if (installed.success.targets.length !== 1)
      return yield* fail('needs-selection', 'Select exactly one installed Threadnote skill target for this task.');
    const target = installed.success.targets[0];
    if (
      !target.enrolled ||
      !target.enabled ||
      target.installationState !== 'current' ||
      !allowedProfiles.includes(target.target.profile) ||
      target.installedDigest !== installed.success.bundle.digest ||
      target.installed?.digest !== installed.success.bundle.digest
    )
      return yield* fail(
        'needs-resources',
        yield* targetRecovery(
          config,
          checkout,
          target.target,
          target.issues[0]?.code,
          target.installationState === 'update-available',
        ),
      );
    return {...target, installedDigest: installed.success.bundle.digest};
  });
