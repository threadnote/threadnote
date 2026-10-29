import {Array as EffectArray} from 'effect';
import {Effect, Path} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {DevSkillsEnsureOptions, DevSkillsEnsureResult, DevSkillsSelector, DevSkillsTarget} from './contract.js';
import {compareWrite, decode, fail, hash, isRecord, json, readOptional, requireValue, stableJson} from './files.js';
import {consumerId, enrollmentContext, parseTarget, readReceipt} from './registry.js';
import {selectDevSkillsTarget} from './plan.js';
import {loadDevSkillsBundle} from './manifest.js';
import {applyCapturedDevSkills} from './mutation.js';
import {disableEnrollment} from './enablement.js';
import {recoverTransaction} from './transaction.js';
import {restoreOwnedProjection} from './maintenance.js';
import {validateLease, withDevSkillsMutationLease, withPhysicalLock, type DevSkillsMutationLease} from './lease.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface Checkpoint {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly home: string;
  readonly installationRoot: string;
  readonly target: DevSkillsTarget;
  readonly bundleDigest: string;
  readonly choice: 'default' | 'disabled';
  readonly createdConsumer: boolean;
  readonly undone: boolean;
}
const checkpointPath = (path: Path.Path, home: string, operationId: string) =>
  path.join(home, 'dev-skills', 'ensure', `${hash(operationId)}.json`);
const validOperationId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  EffectArray.every(
    [...value],
    character =>
      Effect2.pipe(
        character,
        EffectString.charCodeAt(0),
        Effect2.Option.getOrElse(() => NaN),
      ) >= 32,
  );
function isSetupCheckpoint(
  value: unknown,
): value is Record<string, unknown> & Omit<Checkpoint, 'target'> & {readonly target: unknown} {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    validOperationId(value.operationId) &&
    typeof value.home === 'string' &&
    typeof value.installationRoot === 'string' &&
    typeof value.bundleDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.bundleDigest) &&
    (value.choice === 'default' || value.choice === 'disabled') &&
    typeof value.createdConsumer === 'boolean' &&
    typeof value.undone === 'boolean' &&
    (value.choice !== 'disabled' || !value.createdConsumer)
  );
}
function parseCheckpoint(value: unknown): Checkpoint {
  requireValue(isSetupCheckpoint(value), 'Invalid setup workflow checkpoint.');
  return {...value, target: parseTarget(value.target)};
}
export const ensureDevSkills = Effect.fn('devSkills.ensure')(function* (
  config: RuntimeConfig,
  selector: DevSkillsSelector,
  options: DevSkillsEnsureOptions,
) {
  if (options.mode === 'setup' && !validOperationId(options.operationId))
    return yield* fail('invalid-operation', 'Setup requires a bounded stable operation identifier.');
  // Complete source validation and target admission before creating mutation locks.
  const bundle = yield* loadDevSkillsBundle();
  yield* selectDevSkillsTarget(config, selector);
  const run = (lease: DevSkillsMutationLease) =>
    Effect.gen(function* () {
      const held = yield* validateLease(config, lease);
      const path = yield* Path.Path;
      const context = yield* enrollmentContext(config);
      if (context.root !== held.root) return yield* fail('enrollment-conflict', 'Setup runtime identity changed.');
      const target = yield* selectDevSkillsTarget(config, selector);
      const consumer = {home: held.home, installationRoot: held.root, target};
      const id = consumerId(consumer);
      const entry = context.homeIndex.targets[id];
      let checkpoint: Checkpoint | undefined;
      if (options.mode === 'setup') {
        const file = checkpointPath(path, held.home, options.operationId);
        const existing = yield* readOptional(file);
        const request = {
          schemaVersion: 1 as const,
          operationId: options.operationId,
          home: held.home,
          installationRoot: held.root,
          target,
          bundleDigest: bundle.manifest.digest,
          choice: options.choice,
        };
        checkpoint =
          existing === null
            ? {...request, createdConsumer: options.choice === 'default' && entry === undefined, undone: false}
            : yield* decode(existing, parseCheckpoint);
        const {createdConsumer: _created, undone: _undone, ...prior} = checkpoint;
        if (stableJson(prior) !== stableJson(request))
          return yield* fail('checkpoint-conflict', 'Setup operation was already bound to another workflow request.');
        if (existing === null) yield* compareWrite(file, null, json(checkpoint));
        if (checkpoint.undone)
          return {
            state: 'disabled',
            createdConsumer: false,
            operationId: options.operationId,
            issues: [],
          } satisfies DevSkillsEnsureResult;
      }
      const facts = {
        createdConsumer: checkpoint?.createdConsumer ?? false,
        ...(checkpoint ? {operationId: checkpoint.operationId} : {}),
      };
      if (options.mode === 'setup' && options.choice === 'disabled') {
        yield* disableEnrollment(config, consumer);
        return {state: 'disabled', ...facts, issues: []} satisfies DevSkillsEnsureResult;
      }
      if (entry && (!entry.enabled || entry.state === 'removed'))
        return {state: 'disabled', ...facts, issues: []} satisfies DevSkillsEnsureResult;
      if (!entry && options.mode === 'maintenance')
        return {
          state: 'setup-needed',
          ...facts,
          issues: [{code: 'setup-needed', message: 'Run explicit agent setup to enroll development skills.'}],
        } satisfies DevSkillsEnsureResult;
      const outcome = yield* Effect.gen(function* () {
        let restored = false;
        if (entry) restored = yield* withPhysicalLock(target.skillRoot, restoreOwnedProjection(config, consumer));
        const result = yield* applyCapturedDevSkills(config, bundle, entry ? 'update' : 'install', selector, {
          lease,
          ...(checkpoint?.createdConsumer ? {createdBy: hash(checkpoint.operationId)} : {}),
        });
        return {
          state: result.applied || restored ? 'installed' : 'current',
          ...facts,
          result,
          issues: result.issues,
        } satisfies DevSkillsEnsureResult;
      }).pipe(Effect.result);
      if (outcome._tag === 'Success') return outcome.success;
      return {
        state:
          options.mode === 'maintenance' && isRecord(outcome.failure) && outcome.failure.code === 'enrollment-conflict'
            ? 'setup-needed'
            : 'pending',
        ...facts,
        issues: [{code: 'setup-pending', message: String(outcome.failure)}],
      } satisfies DevSkillsEnsureResult;
    });
  return yield* (options.lease ? run(options.lease) : withDevSkillsMutationLease(config, run)).pipe(
    Effect.map((result): DevSkillsEnsureResult => result),
  );
});
export const undoDevSkillsEnsure = Effect.fn('devSkills.undoEnsure')(function* (
  config: RuntimeConfig,
  operationId: string,
  options: {readonly lease?: DevSkillsMutationLease} = {},
) {
  if (!validOperationId(operationId)) return yield* fail('invalid-operation', 'Invalid setup operation identifier.');
  const run = (lease: DevSkillsMutationLease) =>
    Effect.gen(function* () {
      const held = yield* validateLease(config, lease);
      const path = yield* Path.Path;
      const file = checkpointPath(path, held.home, operationId);
      const content = yield* readOptional(file);
      if (content === null)
        return {state: 'setup-needed', createdConsumer: false, operationId, issues: []} satisfies DevSkillsEnsureResult;
      const checkpoint = yield* decode(content, parseCheckpoint);
      if (
        checkpoint.operationId !== operationId ||
        checkpoint.home !== held.home ||
        checkpoint.installationRoot !== held.root
      )
        return yield* fail('checkpoint-conflict', 'Setup undo belongs to another home or runtime.');
      if (!checkpoint.createdConsumer || checkpoint.undone)
        return {state: 'current', createdConsumer: false, operationId, issues: []} satisfies DevSkillsEnsureResult;
      const selector = {
        agent: checkpoint.target.surfaceId,
        profile: checkpoint.target.profile,
        scope: checkpoint.target.scope,
        cwd: checkpoint.target.cwd,
      };
      const target = yield* selectDevSkillsTarget(config, selector);
      if (stableJson(target) !== stableJson(checkpoint.target))
        return yield* fail('checkpoint-conflict', 'Setup undo target changed.');
      const consumer = {home: held.home, installationRoot: held.root, target};
      yield* withPhysicalLock(target.skillRoot, recoverTransaction(consumer));
      const context = yield* enrollmentContext(config);
      const id = consumerId(consumer);
      const entry = context.homeIndex.targets[id];
      const receipt = (yield* readReceipt(target)).receipt;
      if ((entry?.state === 'enrolled' || receipt?.consumers[id]) && entry?.createdBy === hash(operationId)) {
        const bundle = yield* loadDevSkillsBundle();
        yield* applyCapturedDevSkills(config, bundle, 'remove', selector, {lease});
      }
      yield* compareWrite(file, content, json({...checkpoint, undone: true}));
      return {state: 'disabled', createdConsumer: false, operationId, issues: []} satisfies DevSkillsEnsureResult;
    });
  return yield* (options.lease ? run(options.lease) : withDevSkillsMutationLease(config, run)).pipe(
    Effect.map((result): DevSkillsEnsureResult => result),
  );
});
