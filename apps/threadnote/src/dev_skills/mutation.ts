import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {DevSkillsAction, DevSkillsBundle, DevSkillsResult, DevSkillsSelector} from './contract.js';
import {planMutation, selectDevSkillsTarget} from './plan.js';
import {disableEnrollment} from './enablement.js';
import {enrollmentContext, readReceipt} from './registry.js';
import {fail, stableJson} from './files.js';
import {commitMutation, readTransactionConsumer, recoverTransaction} from './transaction.js';
import {validateLease, withDevSkillsMutationLease, withPhysicalLock, type DevSkillsMutationLease} from './lease.js';
import {devSkillsReadiness} from './readiness.js';
import * as EffectRecord from 'effect/Record';

export const applyCapturedDevSkills = Effect.fn('devSkills.applyCaptured')(function* (
  config: RuntimeConfig,
  bundle: DevSkillsBundle,
  action: DevSkillsAction,
  selector: DevSkillsSelector,
  options: {
    readonly expectedDigest?: string;
    readonly lease?: DevSkillsMutationLease;
    readonly readiness?: boolean;
    readonly createdBy?: string;
    readonly reinstallMissingStore?: boolean;
  } = {},
) {
  const initial = yield* planMutation(config, bundle, action, selector, options);
  if (options.expectedDigest && initial.plan.previewDigest !== options.expectedDigest)
    return yield* fail('stale-preview', 'Development skills changed since preview. Preview the operation again.');
  if (!initial.plan.canApply && (initial.missingStoreAttempt || initial.plan.installationState !== 'recovery-needed'))
    return yield* fail(
      'installation-conflict',
      EffectArray.join(
        EffectArray.map(initial.plan.issues, issue => issue.message),
        ' ',
      ),
    );
  if (initial.missingStoreReinstall && options.lease)
    return yield* fail('invalid-lease', 'A missing-store install requires its own no-replay mutation lease.');
  if (
    options.reinstallMissingStore &&
    initial.plan.installationState === 'recovery-needed' &&
    !(yield* readReceipt(initial.plan.target)).receipt
  ) {
    const original = yield* readTransactionConsumer(initial.plan.target.skillRoot);
    if (stableJson(original) !== stableJson(initial.consumer))
      return yield* fail(
        'recovery-needed',
        'Resume the original physical transaction from its exact owning home and target.',
      );
  }
  const apply = (lease: DevSkillsMutationLease) =>
    Effect.gen(function* () {
      const held = yield* validateLease(config, lease);
      const target = yield* selectDevSkillsTarget(config, selector);
      if (target.skillRoot !== initial.plan.target.skillRoot)
        return yield* fail('stale-preview', 'The selected physical target changed. Preview again.');
      const context = yield* enrollmentContext(config);
      if (action === 'remove' && context.homeIndex.targets[initial.plan.consumerId]?.state !== 'enrolled') {
        const locked = yield* planMutation(config, bundle, action, selector, options);
        if (locked.consumer.installationRoot !== held.root)
          return yield* fail('invalid-lease', 'Enrollment coordinator changed.');
        if (options.expectedDigest && options.expectedDigest !== locked.plan.previewDigest)
          return yield* fail('stale-preview', 'Enrollment changed since preview.');
        if (!locked.plan.canApply)
          return yield* fail(
            'installation-conflict',
            EffectArray.join(
              EffectArray.map(locked.plan.issues, issue => issue.message),
              ' ',
            ),
          );
        yield* disableEnrollment(config, locked.consumer);
        return {
          ...locked.plan,
          applied: locked.changes.length > 0,
          recovered: false,
          retainedPaths: locked.retainedPaths,
        } satisfies DevSkillsResult;
      }
      return yield* withPhysicalLock(
        target.skillRoot,
        Effect.gen(function* () {
          const locked = yield* planMutation(config, bundle, action, selector, {...options, physicalLockHeld: true});
          if (locked.consumer.installationRoot !== held.root)
            return yield* fail('invalid-lease', 'Enrollment coordinator changed.');
          if (
            locked.missingStoreReinstall !== initial.missingStoreReinstall ||
            (initial.missingStoreReinstall && locked.plan.previewDigest !== initial.plan.previewDigest) ||
            (options.expectedDigest && locked.plan.previewDigest !== options.expectedDigest)
          )
            return yield* fail(
              'stale-preview',
              'Development skills changed while acquiring the mutation lease. Preview again.',
            );
          const recovered = initial.missingStoreReinstall ? false : yield* recoverTransaction(locked.consumer);
          const mutation = recovered
            ? yield* planMutation(config, bundle, action, selector, {
                ...options,
                reinstallMissingStore: false,
                physicalLockHeld: true,
              })
            : locked;
          if (!mutation.plan.canApply)
            return yield* fail(
              'installation-conflict',
              EffectArray.join(
                EffectArray.map(mutation.plan.issues, issue => issue.message),
                ' ',
              ),
            );
          const applied = yield* commitMutation(mutation);
          const receipt = (yield* readReceipt(target)).receipt;
          return {
            ...mutation.plan,
            applied,
            recovered,
            retainedPaths: mutation.retainedPaths,
            readiness: options.readiness
              ? yield* devSkillsReadiness(
                  config,
                  target,
                  receipt && EffectRecord.keys(receipt.consumers).length ? receipt.manifest : undefined,
                )
              : undefined,
          } satisfies DevSkillsResult;
        }),
      );
    });
  return yield* (
    options.lease
      ? apply(options.lease)
      : withDevSkillsMutationLease(config, apply, {replayEnablement: !initial.missingStoreReinstall})
  ).pipe(Effect.map((result): DevSkillsResult => result));
});
