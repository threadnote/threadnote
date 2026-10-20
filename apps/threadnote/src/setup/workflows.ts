import {findAgentSurface} from '@threadnote/integrations/catalog';
import {resolveDevSkillsTarget} from '../agent_integration/skill_targets.js';
import {Console, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256Hex} from '@threadnote/platform/digest';
import {
  ensureDevSkills,
  listDevSkills,
  previewDevSkills,
  undoDevSkillsEnsure,
  withDevSkillsMutationLease,
} from '../dev_skills/index.js';
import type {DevSkillsMutationLease, DevSkillsSelector} from '../dev_skills/index.js';
import type {DevSkillsEnsureResult} from '../dev_skills/index.js';
import {SetupOperationError} from './contract.js';

/** Native skill scopes are catalog-owned, independently of the core MCP scope. */
export function setupWorkflowSelector(
  agent: string,
  scope?: DevSkillsSelector['scope'],
  cwd?: string,
): DevSkillsSelector {
  const capability = findAgentSurface(agent)?.devSkills;
  const selected =
    capability?.status === 'managed'
      ? scope && capability.scopes.includes(scope)
        ? scope
        : capability.defaultScope
      : scope;
  return {agent, scope: selected, ...(selected !== 'user' && cwd ? {cwd} : {})};
}

export const workflowSetupIdentity = Effect.fn('setup.workflowIdentity')(function* (
  config: RuntimeConfig,
  selector: DevSkillsSelector,
  key: string,
  disabled: boolean,
) {
  const {bundle} = yield* listDevSkills(config);
  const fingerprint = {selector, bundleDigest: bundle.digest, choice: disabled ? 'disabled' : 'default'};
  return {bundleDigest: bundle.digest, operationId: `setup:${yield* sha256Hex(JSON.stringify({key, ...fingerprint}))}`};
});

export const ensureSetupWorkflows = Effect.fn('setup.ensureWorkflows')(function* (
  config: RuntimeConfig,
  selector: DevSkillsSelector,
  key: string,
  disabled: boolean,
  lease: DevSkillsMutationLease,
) {
  const identity = yield* workflowSetupIdentity(config, selector, key, disabled);
  const result = yield* ensureDevSkills(config, selector, {
    mode: 'setup',
    choice: disabled ? 'disabled' : 'default',
    operationId: identity.operationId,
    lease,
  });
  if (result.state === 'pending' || result.state === 'setup-needed')
    return yield* SetupOperationError.make({
      message: `Core setup remains available; development workflows are incomplete. ${result.issues.map(issue => issue.message).join(' ')}`,
    });
  yield* Console.log(`Development workflows: ${result.state}.`);
  return {...result, operationId: identity.operationId};
});

export const maintainPersonalWorkflows = Effect.fn('setup.maintainPersonalWorkflows')(function* (
  config: RuntimeConfig,
  selector: DevSkillsSelector,
) {
  const admission = yield* resolveDevSkillsTarget(config, selector).pipe(Effect.result);
  if (admission._tag === 'Failure') {
    if (admission.failure.code !== 'unsupported-platform') return yield* admission.failure;
    return {
      state: 'setup-needed',
      createdConsumer: false,
      issues: [
        {
          code: 'unsupported-platform',
          message: 'Native personal workflow maintenance is unavailable on this platform; no enrollment was created.',
        },
      ],
    } satisfies DevSkillsEnsureResult;
  }
  return yield* ensureDevSkills(config, selector, {mode: 'maintenance'});
});

/** Public composition only. Nested core/repair calls use their existing setup-lock-held path. */
export function composeWorkflowSetup<A, E, R>(
  config: RuntimeConfig,
  selector: DevSkillsSelector,
  options: {readonly apply: boolean; readonly noDevSkills?: boolean; readonly key: string},
  core: (lease?: DevSkillsMutationLease) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const admission = yield* resolveDevSkillsTarget(config, selector).pipe(Effect.result);
    if (admission._tag === 'Failure') {
      if (
        options.noDevSkills &&
        selector.profile !== undefined &&
        selector.profile !== 'desktop' &&
        admission.failure.code === 'unsupported-platform'
      ) {
        const result = yield* core();
        yield* Console.log(
          'Development workflows are unsupported on this platform; core-only opt-out created no workflow enrollment.',
        );
        return result;
      }
      return yield* admission.failure;
    }
    if (!options.apply) {
      const result = yield* core();
      if (options.noDevSkills) yield* Console.log('Would persist disabled development workflow enrollment.');
      else {
        const preview = yield* previewDevSkills(config, 'install', selector);
        yield* Console.log(`Development workflows: ${preview.installationState}; target ${preview.target.skillRoot}.`);
        for (const issue of preview.issues) yield* Console.log(issue.message);
      }
      return result;
    }
    return yield* withDevSkillsMutationLease(config, lease =>
      Effect.gen(function* () {
        const result = yield* core(lease);
        yield* ensureSetupWorkflows(config, selector, options.key, options.noDevSkills === true, lease);
        return result;
      }),
    );
  });
}

/** An index binds every legacy/new checkpoint to this core setup identity, not arbitrary operation IDs. */
interface WorkflowCheckpoint {
  readonly operationId: string;
  readonly bundleDigest: string;
  readonly choice: 'default' | 'disabled';
}
interface WorkflowCheckpointOwner {
  readonly selector: DevSkillsSelector;
  readonly key: string;
}
const readWorkflowCheckpoints = Effect.fn('setup.readWorkflowCheckpoints')(function* (
  file: string,
  owner: WorkflowCheckpointOwner,
) {
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(file).pipe(Effect.option);
  if (Option.isSome(link))
    return yield* SetupOperationError.make({message: 'Workflow checkpoint index is a symlink; preserved.'});
  if (!(yield* fs.exists(file))) return [] as WorkflowCheckpoint[];
  const stat = yield* fs.stat(file);
  if (Option.isSome(link) || stat.type !== 'File' || Number(stat.size) > 100_000)
    return yield* SetupOperationError.make({message: 'Invalid workflow setup checkpoint index; preserved.'});
  const raw = yield* fs.readFileString(file);
  const entries = yield* Effect.try({
    try: () => {
      const value: unknown = JSON.parse(raw);
      if (
        !Array.isArray(value) ||
        value.length > 512 ||
        !value.every(
          item =>
            typeof item === 'object' &&
            item !== null &&
            Object.keys(item).sort().join(',') === 'bundleDigest,choice,operationId' &&
            /^setup:[a-f0-9]{64}$/u.test(item.operationId) &&
            /^[a-f0-9]{64}$/u.test(item.bundleDigest) &&
            ['default', 'disabled'].includes(item.choice),
        )
      )
        throw new Error('invalid');
      return value as WorkflowCheckpoint[];
    },
    catch: () => SetupOperationError.make({message: 'Invalid workflow setup checkpoint index; preserved.'}),
  });
  for (const entry of entries) {
    const expected = `setup:${yield* sha256Hex(JSON.stringify({key: owner.key, selector: owner.selector, bundleDigest: entry.bundleDigest, choice: entry.choice}))}`;
    if (entry.operationId !== expected)
      return yield* SetupOperationError.make({message: 'Workflow checkpoint belongs to another setup; preserved.'});
  }
  return entries;
});
export const recordSetupWorkflowCheckpoint = Effect.fn('setup.recordWorkflowCheckpoint')(function* (
  file: string,
  identity: {readonly operationId: string; readonly bundleDigest: string},
  owner: WorkflowCheckpointOwner,
  disabled: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prior = yield* readWorkflowCheckpoints(file, owner);
  if (prior.some(entry => entry.operationId === identity.operationId)) return;
  if (prior.length >= 512)
    return yield* SetupOperationError.make({message: 'Workflow setup history limit reached; preserve checkpoints.'});
  const crypto = yield* Crypto.Crypto;
  const temporary = `${file}.${yield* crypto.randomUUIDv4()}.tmp`;
  yield* fs.makeDirectory(path.dirname(file), {recursive: true});
  const content = JSON.stringify([...prior, {...identity, choice: disabled ? 'disabled' : 'default'}]) + '\n';
  yield* fs.writeFileString(temporary, content, {mode: 0o600, flag: 'wx'});
  yield* fs.rename(temporary, file).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  if ((yield* fs.readFileString(file)) !== content)
    return yield* SetupOperationError.make({message: 'Workflow setup checkpoint readback differs; preserve state.'});
});
export const undoSetupWorkflows = Effect.fn('setup.undoWorkflows')(function* (
  config: RuntimeConfig,
  file: string,
  owner: WorkflowCheckpointOwner,
  lease: DevSkillsMutationLease,
  required = false,
) {
  const entries = yield* readWorkflowCheckpoints(file, owner);
  if (required && entries.length === 0)
    return yield* SetupOperationError.make({
      message: 'Workflow setup checkpoint is missing; preserve ownership and recover it before undo.',
    });
  for (const entry of [...entries].reverse()) yield* undoDevSkillsEnsure(config, entry.operationId, {lease});
});
