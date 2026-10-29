import {Array as EffectArray} from 'effect';
import {Effect, Layer} from 'effect';
import {CodeGraphWatcher} from '@threadnote/graph/watcher';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  finalizeDeferredCodeAnchors,
  listDeferredCodeAnchorIntents,
  MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
  type DeferredCodeAnchorIntentV1,
} from './code_anchor.js';
import {isDeferredCodeAnchorFullProjectScope} from './code_anchor_scope.js';
import {
  observeDeferredCodeAnchorCallerCheckout,
  type DeferredCodeAnchorCallerCheckoutObservation,
} from './code_anchor_checkout.js';
import {
  DeferredCodeAnchorRefreshScheduler,
  scheduleDeferredCodeAnchorWorkspaceRefresh,
} from './code_anchor_scheduler.js';

export {
  DeferredCodeAnchorRefreshScheduler,
  scheduleDeferredCodeAnchorWorkspaceRefresh,
} from './code_anchor_scheduler.js';

export interface DeferredCodeAnchorWorkspaceRefreshTarget {
  readonly cwd: string;
  readonly project?: string;
  readonly projectScope?: DeferredCodeAnchorIntentV1['projectScope'];
  readonly repositoryId: string;
  readonly worktreeId: string;
}

export function selectDeferredCodeAnchorWorkspaceRefreshTargets(
  intents: readonly DeferredCodeAnchorIntentV1[],
  observationByCwd: ReadonlyMap<string, DeferredCodeAnchorCallerCheckoutObservation>,
): readonly DeferredCodeAnchorWorkspaceRefreshTarget[] {
  const seen = new Set<string>();
  const targets: DeferredCodeAnchorWorkspaceRefreshTarget[] = [];
  for (const intent of intents) {
    if (intent.recovery.recovery !== 'prepare-current-graph' || intent.recovery.preparation.target === 'workset')
      continue;
    const observation = observationByCwd.get(intent.callerCwd);
    if (
      observation === undefined ||
      observation.state !== 'present' ||
      observation.repositoryId !== intent.repositoryId ||
      observation.worktreeId !== intent.worktreeId
    ) {
      continue;
    }
    const scopeKey =
      intent.projectScope === undefined
        ? (intent.project ?? 'full')
        : isDeferredCodeAnchorFullProjectScope(intent.projectScope)
          ? 'full'
          : intent.projectScope.scopeKey;
    const targetKey = `${intent.repositoryId}\n${intent.worktreeId}\n${scopeKey}`;
    if (seen.has(targetKey)) continue;
    seen.add(targetKey);
    targets.push({
      cwd: intent.callerCwd,
      ...(intent.project === undefined ? {} : {project: intent.project}),
      ...(intent.projectScope === undefined ? {} : {projectScope: intent.projectScope}),
      repositoryId: intent.repositoryId,
      worktreeId: intent.worktreeId,
    });
  }
  return targets;
}

export function selectDeferredCodeAnchorMissingCheckoutIntents(
  intents: readonly DeferredCodeAnchorIntentV1[],
  observationByCwd: ReadonlyMap<string, DeferredCodeAnchorCallerCheckoutObservation>,
): readonly DeferredCodeAnchorIntentV1[] {
  return EffectArray.filter(intents, intent => observationByCwd.get(intent.callerCwd)?.state === 'missing');
}

const observeDeferredCodeAnchorCallerCheckouts = Effect.fn('memoryCodeAnchor.observeCallerCheckouts')(function* (
  intents: readonly DeferredCodeAnchorIntentV1[],
) {
  const observationByCwd = new Map<string, DeferredCodeAnchorCallerCheckoutObservation>();
  for (const cwd of new Set(EffectArray.map(intents, intent => intent.callerCwd))) {
    observationByCwd.set(cwd, yield* observeDeferredCodeAnchorCallerCheckout(cwd));
  }
  return observationByCwd;
});

export const listDeferredCodeAnchorWorkspaceRefreshTargets = Effect.fn('memoryCodeAnchor.listWorkspaceRefreshTargets')(
  function* (config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'manifestPath' | 'user'>) {
    const intents = EffectArray.flatMap(yield* listDeferredCodeAnchorIntents(config), entry =>
      entry.kind === 'valid' ? [entry.intent] : [],
    );
    return selectDeferredCodeAnchorWorkspaceRefreshTargets(
      intents,
      yield* observeDeferredCodeAnchorCallerCheckouts(intents),
    );
  },
);

export const deferredCodeAnchorRefreshSchedulerLayer = Layer.effect(
  DeferredCodeAnchorRefreshScheduler,
  Effect.gen(function* () {
    const watcher = yield* CodeGraphWatcher;
    return DeferredCodeAnchorRefreshScheduler.of({
      schedule: options =>
        watcher
          .refresh({
            admissionClass: 'background',
            cwd: options.cwd,
            key: options.key,
            manifestPath: options.manifestPath,
            threadnoteHome: options.threadnoteHome,
            ...(options.graphProject === undefined ? {} : {project: options.graphProject}),
          })
          .pipe(Effect.asVoid, Effect.ignoreCause),
    });
  }),
);

export const refreshPendingDeferredCodeAnchorWorkspaces = Effect.fn('memoryCodeAnchor.refreshPendingWorkspaces')(
  function* (config: RuntimeConfig) {
    const intents = EffectArray.flatMap(yield* listDeferredCodeAnchorIntents(config), entry =>
      entry.kind === 'valid' ? [entry.intent] : [],
    );
    const observationByCwd = yield* observeDeferredCodeAnchorCallerCheckouts(intents);
    const missingUris = [
      ...new Set(
        EffectArray.map(
          selectDeferredCodeAnchorMissingCheckoutIntents(intents, observationByCwd),
          intent => intent.memoryUri,
        ),
      ),
    ];
    if (missingUris.length > 0) {
      yield* finalizeDeferredCodeAnchors(config, {
        limit: Math.min(missingUris.length, MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT),
        uris: missingUris,
      }).pipe(Effect.ignoreCause);
    }
    yield* Effect.forEach(
      selectDeferredCodeAnchorWorkspaceRefreshTargets(intents, observationByCwd),
      target => scheduleDeferredCodeAnchorWorkspaceRefresh(config, target).pipe(Effect.ignoreCause),
      {concurrency: 1},
    );
  },
);
