import {Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {statusDevSkills} from '../dev_skills/index.js';
import {fail, inCheckout} from './task_action_helpers.js';

/** The installed selector is checked for start and resume, never treated as actor/publication authority. */
export const readNativeTaskInstalledTarget = (
  config: RuntimeConfig,
  installationTarget: string | undefined,
  checkout: string,
  allowedProfiles: readonly ('desktop' | 'codex-cloud-personal' | 'cursor-cloud-personal')[] = ['desktop'],
) =>
  Effect.gen(function* () {
    if (!installationTarget)
      return yield* fail(
        'needs-resources',
        'Select an installed Threadnote skill target. It must have the current verified workflow bundle before a task can start or resume.',
      );
    const installed = yield* inCheckout(
      statusDevSkills(config, {agent: installationTarget}).pipe(
        Effect.mapError(() =>
          fail('needs-resources', 'The selected skill target could not verify an installed workflow bundle.'),
        ),
      ),
      checkout,
    );
    if (installed.targets.length !== 1)
      return yield* fail('needs-selection', 'Select exactly one installed Threadnote skill target for this task.');
    const target = installed.targets[0];
    if (
      !target.enrolled ||
      !target.enabled ||
      target.installationState !== 'current' ||
      !allowedProfiles.includes(target.target.profile) ||
      target.installedDigest !== installed.bundle.digest ||
      target.installed?.digest !== installed.bundle.digest
    )
      return yield* fail(
        'needs-resources',
        'The selected target does not have the current verified Threadnote workflow generation enabled. Update or repair that installation, then retry.',
      );
    return {...target, installedDigest: installed.bundle.digest};
  });
