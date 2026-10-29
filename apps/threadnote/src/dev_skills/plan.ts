import {Effect, Path} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  resolveDevSkillsIdentity,
  resolveDevSkillsTarget,
  listDevSkillsTargets,
} from '../agent_integration/skill_targets.js';
import type {
  DevSkillsAction,
  DevSkillsBundle,
  DevSkillsConsumer,
  DevSkillsInstallationState,
  DevSkillsPlan,
  DevSkillsSelector,
} from './contract.js';
import {
  consumerId,
  enrollmentContext,
  homeIndexPath,
  journalPath,
  readReceipt,
  receiptPath,
  runtimeIndexPath,
  type PhysicalReceipt,
} from './registry.js';
import {restoreJournalPath} from './maintenance.js';
import {enablementJournalPath} from './enablement.js';
import {hash, json, readOptional, statOptional, stableJson} from './files.js';
import {generationRoot, inspectDuplicates, inspectOwned, renderEntrypoints} from './inspection.js';
import {devSkillsCompatibility, devSkillsRuntimeVersion} from './manifest.js';
import {knownStoreEnrollments, missingStoreIsEmpty} from './missing_store.js';

export const selectDevSkillsTarget = Effect.fn('devSkills.selectTarget')(function* (
  config: RuntimeConfig,
  selector: DevSkillsSelector,
) {
  const identity = yield* resolveDevSkillsIdentity(selector);
  const context = yield* enrollmentContext(config);
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const capability = listDevSkillsTargets().find(target => target.surfaceId === identity.surfaceId)!;
  const scope = selector.scope ?? ('defaultScope' in capability ? capability.defaultScope : 'user');
  const cwd = scope === 'user' ? undefined : path.resolve(selector.cwd ?? system.currentDirectory());
  const previous = Object.values(context.homeIndex.targets).find(
    entry =>
      entry.target.surfaceId === identity.surfaceId &&
      entry.target.profile === identity.profile &&
      entry.target.scope === scope &&
      (entry.target.cwd === cwd ||
        (entry.target.cwd !== undefined && cwd !== undefined && path.relative(entry.target.cwd, cwd) === '')),
  );
  return yield* resolveDevSkillsTarget(config, selector, previous?.target);
});
export interface FileChange {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}
export interface PlannedMutation {
  readonly plan: DevSkillsPlan;
  readonly consumer: DevSkillsConsumer;
  readonly changes: readonly FileChange[];
  readonly generation: DevSkillsBundle | null;
  readonly retainedPaths: readonly string[];
  readonly enabled?: boolean;
  readonly createdBy?: string;
  readonly missingStoreAttempt: boolean;
  readonly missingStoreReinstall: boolean;
}
export const planMutation = Effect.fn('devSkills.planMutation')(function* (
  config: RuntimeConfig,
  bundle: DevSkillsBundle,
  action: DevSkillsAction,
  selector: DevSkillsSelector,
  options: {
    readonly createdBy?: string;
    readonly reinstallMissingStore?: boolean;
    readonly physicalLockHeld?: boolean;
  } = {},
) {
  const path = yield* Path.Path;
  const target = yield* selectDevSkillsTarget(config, selector);
  const context = yield* enrollmentContext(config);
  const physical = yield* readReceipt(target);
  const receipt = physical.receipt;
  const consumer: DevSkillsConsumer = {home: context.home, installationRoot: context.root, target};
  const id = consumerId(consumer);
  const createdBy =
    action === 'install'
      ? options.createdBy
      : action === 'update'
        ? context.homeIndex.targets[id]?.createdBy
        : undefined;
  const physicalJournal = yield* readOptional(journalPath(path, target.skillRoot));
  const enablementJournal = yield* readOptional(enablementJournalPath(path, context.home));
  const restoreJournal = yield* readOptional(restoreJournalPath(path, target.skillRoot));
  const pending = physicalJournal ?? enablementJournal ?? restoreJournal;
  const sharing =
    action === 'install' && !receipt && physicalJournal === null ? yield* knownStoreEnrollments(context, target) : [];
  const missingStoreAttempt =
    action === 'install' &&
    !receipt &&
    (context.homeIndex.targets[id]?.state === 'enrolled' ||
      context.runtimeIndex.enrollments[id]?.state === 'enrolled' ||
      sharing.length > 0) &&
    physicalJournal === null;
  const missingStoreReinstall =
    missingStoreAttempt &&
    options.reinstallMissingStore === true &&
    pending === null &&
    (yield* missingStoreIsEmpty(context, consumer, options.physicalLockHeld === true, sharing));
  const inspected = yield* inspectOwned(target, receipt);
  const obsolete = new Set(
    Object.keys(receipt?.entrypoints ?? {}).filter(
      relative =>
        !bundle.manifest.skills.some(
          skill => relative === (target.layout === 'flat' ? `${skill.id}.md` : `${skill.id}/SKILL.md`),
        ),
    ),
  );
  const obsoleteIssue = (issue: {code: string; path?: string}) =>
    action === 'update' &&
    (issue.code === 'modified' || issue.code === 'extra-file') &&
    issue.path !== undefined &&
    [...obsolete].some(relative => {
      const file = path.join(target.skillRoot, relative);
      const nested = path.relative(path.dirname(file), issue.path!);
      return (
        issue.path === file ||
        (target.layout === 'directory' &&
          nested !== '..' &&
          !nested.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(nested))
      );
    });
  const discoveryRoots = [
    ...new Set([
      ...target.discoveryRoots,
      ...Object.values(receipt?.consumers ?? {}).flatMap(item => item.target.discoveryRoots),
    ]),
  ];
  const issues = [
    ...inspected.issues.filter(issue => !obsoleteIssue(issue)),
    ...(yield* inspectDuplicates({...target, discoveryRoots})),
  ];
  const active = receipt && Object.keys(receipt.consumers).length > 0;
  const compatibility = active ? devSkillsCompatibility(receipt.manifest, yield* devSkillsRuntimeVersion()) : [];
  issues.push(
    ...compatibility.filter(issue => action !== 'update' || issue.code !== 'legacy-workflow-update-required'),
  );
  const enrolled = context.homeIndex.targets[id]?.state === 'enrolled';
  if (missingStoreAttempt && !missingStoreReinstall)
    issues.push({
      code: 'incomplete',
      message:
        'A new missing-store install requires matching sole enrollment, no pending transactions and completely absent managed content.',
    });
  if (
    (!missingStoreReinstall && enrolled !== Boolean(receipt?.consumers[id])) ||
    stableJson(context.homeIndex.targets[id]) !== stableJson(context.runtimeIndex.enrollments[id])
  )
    issues.push({
      code: 'incomplete',
      message: 'Home enrollment and physical ownership disagree; preserve state and recover its original transaction.',
    });
  if (pending !== null)
    issues.push({
      code: 'recovery-needed',
      message: 'An interrupted transaction must be resumed from its original Threadnote home.',
      path: journalPath(path, target.skillRoot),
    });
  let state: DevSkillsInstallationState =
    pending !== null
      ? 'recovery-needed'
      : issues.length
        ? issues.some(issue => issue.code === 'modified')
          ? 'modified'
          : 'conflict'
        : !active
          ? 'absent'
          : receipt.manifest.digest === bundle.manifest.digest
            ? 'current'
            : 'update-available';
  if (pending === null && issues.some(issue => issue.code === 'incomplete')) state = 'incomplete';
  else if (pending === null && compatibility.length) state = 'incompatible';
  if (action === 'update' && !enrolled)
    issues.push({code: 'not-installed', message: 'Install this target explicitly before updating it.'});
  if (action === 'install' && active && receipt.manifest.digest !== bundle.manifest.digest)
    issues.push({
      code: 'explicit-update-required',
      message: 'This shared target uses another generation. Use dev-skills update explicitly.',
    });
  const changes: FileChange[] = [];
  const retainedPaths: string[] = [];
  let generation: DevSkillsBundle | null = null;
  const nextConsumers = {...receipt?.consumers};
  if (action === 'remove') delete nextConsumers[id];
  else nextConsumers[id] = consumer;
  const removable = action === 'remove';
  const canApply = removable
    ? pending === null && !issues.some(issue => ['incomplete', 'historical-ownership-conflict'].includes(issue.code))
    : issues.length === 0;
  if (canApply && (action !== 'remove' || enrolled)) {
    let entrypoints = {...receipt?.entrypoints};
    if (action !== 'remove') {
      entrypoints = renderEntrypoints(path, target, bundle);
      generation = bundle;
      for (const relative of obsolete) {
        const file = path.join(target.skillRoot, relative);
        const expected = receipt!.entrypoints[relative];
        if (inspected.contents[relative] === expected) changes.push({path: file, before: expected, after: null});
        else if (inspected.contents[relative] !== null) retainedPaths.push(file);
      }
      for (const issue of inspected.issues) if (obsoleteIssue(issue) && issue.path) retainedPaths.push(issue.path);
      if (
        !receipt?.generations[bundle.manifest.digest] &&
        (yield* statOptional(generationRoot(path, target.skillRoot, bundle.manifest.digest)))
      ) {
        issues.push({
          code: 'unmanaged-generation',
          message: 'A preexisting unowned generation cannot be adopted.',
          path: generationRoot(path, target.skillRoot, bundle.manifest.digest),
        });
      }
    } else if (Object.keys(nextConsumers).length === 0) {
      entrypoints = {};
      for (const [relative, expected] of Object.entries(receipt?.entrypoints ?? {})) {
        if (inspected.contents[relative] === expected)
          changes.push({path: path.join(target.skillRoot, relative), before: expected, after: null});
        else if (inspected.contents[relative] !== null) retainedPaths.push(path.join(target.skillRoot, relative));
      }
      for (const issue of issues) if (issue.path) retainedPaths.push(issue.path);
    }
    if (action !== 'remove')
      for (const [relative, content] of Object.entries(entrypoints))
        if (content !== inspected.contents[relative])
          changes.push({
            path: path.join(target.skillRoot, relative),
            before: inspected.contents[relative],
            after: content,
          });
    if (receipt || action !== 'remove') {
      const updated: PhysicalReceipt = {
        schemaVersion: 1,
        skillRoot: target.skillRoot,
        layout: target.layout,
        manifest: action === 'remove' ? receipt!.manifest : bundle.manifest,
        generations: {
          ...receipt?.generations,
          ...(action === 'remove' ? {} : {[bundle.manifest.digest]: bundle.manifest}),
        },
        entrypoints,
        consumers: Object.fromEntries(Object.entries(nextConsumers).sort(([a], [b]) => a.localeCompare(b))),
      };
      changes.push({path: receiptPath(path, target.skillRoot), before: physical.content, after: json(updated)});
    }
    const entry = {
      ...consumer,
      ...(createdBy ? {createdBy} : {}),
      state: action === 'remove' ? ('removed' as const) : ('enrolled' as const),
      enabled: action === 'install' || (action === 'update' && context.homeIndex.targets[id]?.enabled === true),
    };
    changes.push({
      path: homeIndexPath(path, context.home),
      before: context.homeContent,
      after: json({...context.homeIndex, targets: {...context.homeIndex.targets, [id]: entry}}),
    });
    changes.push({
      path: runtimeIndexPath(path, context.root),
      before: context.runtimeContent,
      after: json({...context.runtimeIndex, enrollments: {...context.runtimeIndex.enrollments, [id]: entry}}),
    });
  }
  if (canApply && action === 'remove' && !enrolled) {
    const entry = {...consumer, state: 'removed' as const, enabled: false};
    changes.push({
      path: homeIndexPath(path, context.home),
      before: context.homeContent,
      after: json({...context.homeIndex, targets: {...context.homeIndex.targets, [id]: entry}}),
    });
    changes.push({
      path: runtimeIndexPath(path, context.root),
      before: context.runtimeContent,
      after: json({...context.runtimeIndex, enrollments: {...context.runtimeIndex.enrollments, [id]: entry}}),
    });
  }
  const effective = changes.filter(change => change.before !== change.after);
  const ownership = changes.find(change => change.path === receiptPath(path, target.skillRoot));
  if (effective.length && ownership && !effective.includes(ownership)) effective.push(ownership);
  const planBase = {
    schemaVersion: 1 as const,
    action,
    target,
    consumerId: id,
    installationState: state,
    bundleDigest: bundle.manifest.digest,
    changes: effective.map(change => ({
      path: change.path,
      beforeHash: change.before === null ? null : hash(change.before),
      afterHash: change.after === null ? null : hash(change.after),
    })),
    consumers: Object.values(receipt?.consumers ?? {}),
    issues,
    canApply: canApply && !issues.some(issue => issue.code === 'unmanaged-generation'),
  };
  // Include unchanged ownership/index images too: equal file edits and enrollment changes invalidate a Manager preview.
  const previewDigest = hash(
    JSON.stringify({
      plan: planBase,
      receipt: physical.content,
      home: context.homeContent,
      runtime: context.runtimeContent,
      observed: inspected.contents,
      journal: pending,
      manualMissingStore: options.reinstallMissingStore === true,
      missingStoreReinstall,
    }),
  );
  return {
    plan: {...planBase, previewDigest},
    consumer,
    changes: effective,
    generation,
    retainedPaths: [...new Set(retainedPaths)],
    enabled: action === 'install' || (action === 'update' && context.homeIndex.targets[id]?.enabled === true),
    createdBy,
    missingStoreAttempt,
    missingStoreReinstall,
  } satisfies PlannedMutation;
});
