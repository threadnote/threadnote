import {SecureRandom} from 'effect/crypto';
import {Array as EffectArray} from 'effect';
import {Clock, Effect, FileSystem, Layer, Option, Path, Schema} from 'effect';
import {CodeGraphWatcher} from '@threadnote/graph/watcher';
import {sha256Hex} from '@threadnote/platform/digest';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
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
            vectorPolicy: 'off',
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

/** MCP respawns inside this window skip the workspace refresh while the selected target set is unchanged. */
const DEFERRED_CODE_ANCHOR_STARTUP_REFRESH_WINDOW_MILLISECONDS = 10 * 60 * 1_000;
const STARTUP_REFRESH_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 2_000,
} as const;
const StartupRefreshStamp = Schema.fromJsonString(
  Schema.Struct({fingerprint: Schema.String, startedAtMilliseconds: Schema.Finite, version: Schema.Literal(1)}),
);

/**
 * Claims the per-home startup refresh for one refresh-target fingerprint. Concurrent starts serialize on the lock, so
 * one writes the stamp and the others read it. Lock contention skips; any other stamp failure runs the refresh.
 */
const claimStartupWorkspaceRefresh = Effect.fn('memoryCodeAnchor.claimStartupWorkspaceRefresh')(function* (
  home: string,
  fingerprint: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  const directory = path.join(home, 'locks', 'deferred-code-anchors');
  const stampPath = path.join(directory, 'startup-refresh-v1.json');
  return yield* withExclusiveFileLock(
    fs,
    path.join(directory, 'startup-refresh.lock'),
    STARTUP_REFRESH_LOCK_OPTIONS,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const previous = yield* fs.readFileString(stampPath).pipe(
        Effect.map(content => Schema.decodeOption(StartupRefreshStamp)(content)),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (
        Option.isSome(previous) &&
        previous.value.fingerprint === fingerprint &&
        now >= previous.value.startedAtMilliseconds &&
        now - previous.value.startedAtMilliseconds < DEFERRED_CODE_ANCHOR_STARTUP_REFRESH_WINDOW_MILLISECONDS
      ) {
        return false;
      }
      const temporary = `${stampPath}.${yield* crypto.uuidV4()}.tmp`;
      yield* fs
        .writeFileString(temporary, `${JSON.stringify({fingerprint, startedAtMilliseconds: now, version: 1})}\n`, {
          flag: 'wx',
          mode: 0o600,
        })
        .pipe(
          Effect.andThen(fs.rename(temporary, stampPath)),
          Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
        );
      return true;
    }),
  ).pipe(Effect.catch(error => Effect.succeed(!isFileLockTimeout(error))));
});

/**
 * MCP startup pass. Missing-checkout finalization runs on every start so a deleted checkout is discarded promptly.
 * Only the costly workspace-refresh scheduling is throttled, keyed on the targets this pass selects.
 */
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
    const targets = selectDeferredCodeAnchorWorkspaceRefreshTargets(intents, observationByCwd);
    if (targets.length === 0) return;
    const fingerprint = yield* sha256Hex(
      JSON.stringify([
        config.account,
        config.user,
        ...EffectArray.map(targets, target => JSON.stringify(target)).sort(),
      ]),
    );
    if (!(yield* claimStartupWorkspaceRefresh(config.agentContextHome, fingerprint))) return;
    yield* Effect.forEach(
      targets,
      target => scheduleDeferredCodeAnchorWorkspaceRefresh(config, target).pipe(Effect.ignoreCause),
      {concurrency: 1},
    );
  },
);
