import {Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {listDevSkillsTargets} from '../agent_integration/skill_targets.js';
import type {DevSkillsAction, DevSkillsPlan, DevSkillsResult, DevSkillsSelector, DevSkillsStatus} from './contract.js';
import {loadDevSkillsBundle} from './manifest.js';
import {planMutation, selectDevSkillsTarget} from './plan.js';
import {enrollmentContext, readReceipt} from './registry.js';
import {fail} from './files.js';
import {commitMutation, recoverTransaction} from './transaction.js';
import {validateLease, withDevSkillsMutationLease, withPhysicalLock, type DevSkillsMutationLease} from './lease.js';
import {devSkillsReadiness} from './readiness.js';

export {withDevSkillsMutationLease};
export type {DevSkillsMutationLease};
export * from './contract.js';
export const listDevSkills = Effect.fn('devSkills.list')(function* (_config: RuntimeConfig) {
  const bundle = yield* loadDevSkillsBundle();
  return {schemaVersion: 1 as const, bundle: bundle.manifest, surfaces: listDevSkillsTargets()};
});
export const previewDevSkills = Effect.fn('devSkills.preview')(function* (
  config: RuntimeConfig,
  action: DevSkillsAction,
  selector: DevSkillsSelector,
) {
  const bundle = yield* loadDevSkillsBundle();
  const mutation = yield* planMutation(config, bundle, action, selector);
  const receipt = (yield* readReceipt(mutation.plan.target)).receipt;
  return {
    ...mutation.plan,
    readiness: yield* devSkillsReadiness(
      config,
      mutation.plan.target,
      receipt && Object.keys(receipt.consumers).length ? receipt.manifest : undefined,
    ),
  } satisfies DevSkillsPlan;
});
export const statusDevSkills = Effect.fn('devSkills.status')(function* (
  config: RuntimeConfig,
  selector?: DevSkillsSelector,
) {
  const bundle = yield* loadDevSkillsBundle();
  const context = yield* enrollmentContext(config);
  const selectors: DevSkillsSelector[] = selector
    ? [selector]
    : Object.values(context.homeIndex.targets).map(entry => ({
        agent: entry.target.surfaceId,
        profile: entry.target.profile,
        scope: entry.target.scope,
        cwd: entry.target.cwd,
      }));
  const targets: DevSkillsStatus[] = [];
  for (const selected of selectors) {
    const mutation = yield* planMutation(config, bundle, 'install', selected);
    const receipt = (yield* readReceipt(mutation.plan.target)).receipt;
    targets.push({
      target: mutation.plan.target,
      consumerId: mutation.plan.consumerId,
      installationState: mutation.plan.installationState,
      enrolled: context.homeIndex.targets[mutation.plan.consumerId]?.state === 'enrolled',
      ...(receipt && Object.keys(receipt.consumers).length ? {installedDigest: receipt.manifest.digest} : {}),
      issues: mutation.plan.issues.filter(issue => issue.code !== 'explicit-update-required'),
      consumers: mutation.plan.consumers,
      readiness: yield* devSkillsReadiness(
        config,
        mutation.plan.target,
        receipt && Object.keys(receipt.consumers).length ? receipt.manifest : undefined,
      ),
    });
  }
  return {schemaVersion: 1 as const, bundle: bundle.manifest, targets};
});
export const applyDevSkills = Effect.fn('devSkills.apply')(function* (
  config: RuntimeConfig,
  action: DevSkillsAction,
  selector: DevSkillsSelector,
  options: {readonly expectedDigest?: string; readonly lease?: DevSkillsMutationLease} = {},
) {
  // Capture the complete release before acquiring mutation locks. Staging never reopens release files.
  const bundle = yield* loadDevSkillsBundle();
  const initial = yield* planMutation(config, bundle, action, selector);
  if (options.expectedDigest && initial.plan.previewDigest !== options.expectedDigest)
    return yield* fail('stale-preview', 'Development skills changed since preview. Preview the operation again.');
  if (!initial.plan.canApply && initial.plan.installationState !== 'recovery-needed')
    return yield* fail('installation-conflict', initial.plan.issues.map(issue => issue.message).join(' '));
  const apply = (lease: DevSkillsMutationLease) =>
    Effect.gen(function* () {
      const held = yield* validateLease(config, lease);
      const target = yield* selectDevSkillsTarget(config, selector);
      if (target.skillRoot !== initial.plan.target.skillRoot)
        return yield* fail('stale-preview', 'The selected physical target changed. Preview again.');
      return yield* withPhysicalLock(
        target.skillRoot,
        Effect.gen(function* () {
          const locked = yield* planMutation(config, bundle, action, selector);
          if (locked.consumer.installationRoot !== held.root)
            return yield* fail('invalid-lease', 'Enrollment coordinator changed.');
          if (options.expectedDigest && locked.plan.previewDigest !== options.expectedDigest)
            return yield* fail(
              'stale-preview',
              'Development skills changed while acquiring the mutation lease. Preview again.',
            );
          const recovered = yield* recoverTransaction(locked.consumer);
          const mutation = recovered ? yield* planMutation(config, bundle, action, selector) : locked;
          if (!mutation.plan.canApply)
            return yield* fail('installation-conflict', mutation.plan.issues.map(issue => issue.message).join(' '));
          const applied = yield* commitMutation(mutation);
          const receipt = (yield* readReceipt(target)).receipt;
          return {
            ...mutation.plan,
            applied,
            recovered,
            retainedPaths: mutation.retainedPaths,
            readiness: yield* devSkillsReadiness(
              config,
              target,
              receipt && Object.keys(receipt.consumers).length ? receipt.manifest : undefined,
            ),
          } satisfies DevSkillsResult;
        }),
      );
    });
  return yield* options.lease ? apply(options.lease) : withDevSkillsMutationLease(config, apply);
});
export const removeOwnedDevSkills = Effect.fn('devSkills.removeOwned')(function* (
  config: RuntimeConfig,
  options: {readonly dryRun: boolean; readonly lease?: DevSkillsMutationLease},
) {
  const context = yield* enrollmentContext(config);
  const entries = Object.values(context.homeIndex.targets)
    .filter(entry => entry.state === 'enrolled')
    .sort((a, b) => a.target.skillRoot.localeCompare(b.target.skillRoot));
  const results: (DevSkillsPlan | DevSkillsResult)[] = [];
  for (const entry of entries) {
    const selector = {
      agent: entry.target.surfaceId,
      scope: entry.target.scope,
      profile: entry.target.profile,
      cwd: entry.target.cwd,
    };
    results.push(
      options.dryRun
        ? yield* previewDevSkills(config, 'remove', selector)
        : yield* applyDevSkills(config, 'remove', selector, {lease: options.lease}),
    );
  }
  return results;
});
