import {Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {listDevSkillsTargets} from '../agent_integration/skill_targets.js';
import type {DevSkillsAction, DevSkillsPlan, DevSkillsResult, DevSkillsSelector, DevSkillsStatus} from './contract.js';
import {applyCapturedDevSkills} from './mutation.js';
import {loadDevSkillsBundle} from './manifest.js';
import {planMutation} from './plan.js';
import {enrollmentContext, readReceipt} from './registry.js';
import {withDevSkillsMutationLease, type DevSkillsMutationLease} from './lease.js';
import {devSkillsReadiness} from './readiness.js';
import {readDevSkillsRefresh as readRefresh} from './refresh_state.js';
import {installedSummary} from './capabilities.js';
export {readDevSkillsRuntimeCapabilities} from './capabilities.js';

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
  const refresh = yield* readRefresh(config).pipe(Effect.result);
  const targets: DevSkillsStatus[] = [];
  for (const selected of selectors) {
    const mutation = yield* planMutation(config, bundle, 'install', selected);
    const receipt = (yield* readReceipt(mutation.plan.target)).receipt;
    targets.push({
      target: mutation.plan.target,
      consumerId: mutation.plan.consumerId,
      installationState: mutation.plan.installationState,
      enrolled: context.homeIndex.targets[mutation.plan.consumerId]?.state === 'enrolled',
      enrollmentState: context.homeIndex.targets[mutation.plan.consumerId]?.state ?? 'unregistered',
      enabled: context.homeIndex.targets[mutation.plan.consumerId]?.enabled ?? false,
      ...(receipt?.consumers[mutation.plan.consumerId] &&
      !mutation.plan.issues.some(issue =>
        ['generation-conflict', 'historical-ownership-conflict', 'incomplete'].includes(issue.code),
      )
        ? {installed: installedSummary(receipt.manifest)}
        : {}),
      ...(receipt && Object.keys(receipt.consumers).length ? {installedDigest: receipt.manifest.digest} : {}),
      ...(refresh._tag === 'Success' &&
      refresh.success?.targets.find(item => item.consumerId === mutation.plan.consumerId)
        ? {lastRefresh: refresh.success.targets.find(item => item.consumerId === mutation.plan.consumerId)!.outcome}
        : {}),
      issues: [
        ...mutation.plan.issues.filter(issue => issue.code !== 'explicit-update-required'),
        ...(refresh._tag === 'Failure'
          ? [
              {
                code: 'refresh-state-invalid',
                message: 'Installation refresh status could not be read; no success is inferred.',
              },
            ]
          : []),
      ],
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
  const bundle = yield* loadDevSkillsBundle();
  return yield* applyCapturedDevSkills(config, bundle, action, selector, {...options, readiness: true});
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
export {ensureDevSkills, undoDevSkillsEnsure} from './composition.js';
export {
  previewDevSkillsRefresh,
  prepareDevSkillsRefresh,
  runDevSkillsRefresh,
  readDevSkillsRefresh,
} from './refresh.js';
export type {DevSkillsRefreshCandidate} from './refresh.js';
