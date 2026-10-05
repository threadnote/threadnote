import {Clock, Console, DateTime, Effect, FileSystem, Result} from 'effect';

import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {memoryIdentityLockKey} from '@threadnote/memory/identity-alias';
import {SystemInfo} from '@threadnote/platform/system';
import {loadRecallMemoryIdentities} from '@threadnote/recall/index';
import {uriSegment} from '@threadnote/workspace/manifest';

import type {ShareRuntime, ShareSyncOptions, ShareTeamConfig} from '../types.js';

import {
  formatShellCommand,
  maybeRun,
  parseJsonConfigObject,
  readFileIfExists,
  requiredExecutable,
  runCommand,
} from '../utils.js';

import {
  conflictId,
  formatShareConflictNextSteps,
  isShareableMemoryChange,
  listShareConflicts,
  normalizePendingChange,
  teamsForShareQuery,
} from './conflicts.js';

import type {AutoShareState, ChangedFile, ResolvedTeam, ShareFetchReceipt, ShareUpdateStatus} from './core.js';

import {
  AUTO_SHARE_GIT_TIMEOUT_MILLISECONDS,
  DEFAULT_GIT_REMOTE_NAME,
  NATIVE_RESOURCE_BACKEND,
  SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS,
  SHARE_FETCH_RECEIPT_VERSION,
  SHARE_FETCH_WARNING_MAXIMUM_LENGTH,
  SHAREABLE_MEMORY_KIND_DIRS,
  ShareOperationError,
  assertSafeShareRelativePath,
  autoShareState,
  countManagedMemoryFieldsTrailers,
  ensureSharedDirectoryChain,
  ensureSharedGitignore,
  isRegularFileNoSymlink,
  loadPendingReindexes,
  mkdir,
  pathDirname,
  pathJoin,
  prepareSharedInboundContentEffect,
  readMemoryContent,
  readSharedInboundFileContent,
  readTeamsFile,
  removeMemoryUri,
  rename,
  resolveTeam,
  resourceExistsStrict,
  rm,
  sharedMemoryIdentityContinuityIssue,
  shareTeamAccess,
  sharedMemoryContentsEquivalent,
  verifySharedMemoryContentUnchanged,
  verifySharedMemoryIdentityContinuity,
  workfileToResourceUri,
  writeFile,
  writeMemoryFileChecked,
  writePendingReindexes,
} from './core.js';

import {
  gitFileContent,
  gitOutput,
  hasUncommittedChanges,
  isShareGitOperationInProgress,
  listChangedFiles,
  mergeChanges,
  restoreTrackedSharedChanges,
  stageShareableChanges,
} from './git.js';

export const refreshSharedReposInBackground = Effect.fn('share.refreshSharedReposInBackground')(function* (
  config: ShareRuntime,
  force: boolean,
) {
  return yield* refreshShareUpdateState(config, {force});
});

export const syncSharedReposBeforeAgentRead = Effect.fn('share.syncSharedReposBeforeAgentRead')(function* (
  config: ShareRuntime,
  teamSelector?: string | readonly string[],
) {
  const selectedTeams =
    teamSelector === undefined ? undefined : new Set(typeof teamSelector === 'string' ? [teamSelector] : teamSelector);
  const state = autoShareState(config);
  return yield* enqueueShareOperation(
    state,
    Effect.fn('share.callback')(function* () {
      yield* loadPendingReindexes(config, state);
      const warnings = yield* refreshShareUpdateStateLocked(config, state, {force: false, teams: selectedTeams});
      const syncTeams = new Set(
        [...state.behindTeams, ...state.pendingReindexes.keys()].filter(
          team => !selectedTeams || selectedTeams.has(team),
        ),
      );
      if (syncTeams.size === 0) {
        return {syncedTeams: [], warnings};
      }

      const syncedTeams: string[] = [];
      const remainingBehind = new Set(state.behindTeams);
      for (const team of syncTeams) {
        const syncResult = yield* Effect.result(runShareSyncQuiet(config, state, {team}));
        if (Result.isSuccess(syncResult)) {
          warnings.push(...syncResult.success.warnings);
          if (syncResult.success.synced) {
            if (remainingBehind.has(team)) yield* recordShareTeamSynced(config, team);
            remainingBehind.delete(team);
            syncedTeams.push(team);
          }
        } else {
          const err = syncResult.failure;
          warnings.push(
            `Auto-sync for shared team "${team}" failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      state.behindTeams = remainingBehind;
      return {syncedTeams, warnings};
    }),
  );
});

const refreshShareUpdateState = Effect.fn('share.refreshShareUpdateState')(function* (
  config: ShareRuntime,
  options: {readonly force: boolean},
) {
  const state = autoShareState(config);
  const warnings = yield* enqueueShareOperation(
    state,
    Effect.fn('share.callback')(function* () {
      return yield* refreshShareUpdateStateLocked(config, state, options);
    }),
  );
  for (const warning of warnings) {
    yield* Console.error(warning);
  }
});

const refreshShareUpdateStateLocked = Effect.fn('share.refreshShareUpdateStateLocked')(function* (
  config: ShareRuntime,
  state: AutoShareState,
  options: {readonly force: boolean; readonly teams?: ReadonlySet<string>},
) {
  const now = yield* Clock.currentTimeMillis;
  const teamsFile = yield* readTeamsFile(config);
  const configuredTeams = Object.keys(teamsFile.teams).filter(team => !options.teams || options.teams.has(team));
  const teamsToCheck = new Set(
    configuredTeams.filter(
      team =>
        options.force ||
        state.forceNextCheck ||
        now - (state.checkedAtByTeam.get(team) ?? 0) >= SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS,
    ),
  );
  if (teamsToCheck.size === 0) {
    return [];
  }
  state.forceNextCheck = false;
  return yield* Effect.gen(function* () {
    const statuses = yield* fetchShareUpdateStatuses(config, teamsToCheck);
    const nextBehindTeams = new Set(state.behindTeams);
    for (const status of statuses) {
      if (!status.warning) {
        if (status.behind > 0) {
          nextBehindTeams.add(status.team);
        } else {
          nextBehindTeams.delete(status.team);
        }
      }
    }
    state.behindTeams = nextBehindTeams;
    return statuses.flatMap(status => (status.warning ? [status.warning] : []));
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const checkedAt = yield* Clock.currentTimeMillis;
        for (const team of teamsToCheck) state.checkedAtByTeam.set(team, checkedAt);
      }),
    ),
  );
});

function enqueueShareOperation<A, E, R>(
  _state: AutoShareState,
  action: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return action();
}

const fetchShareUpdateStatuses = Effect.fn('share.fetchShareUpdateStatuses')(function* (
  config: ShareRuntime,
  selectedTeams?: ReadonlySet<string>,
) {
  const teamsFile = yield* readTeamsFile(config);
  const teams = Object.entries(teamsFile.teams).filter(([name]) => !selectedTeams || selectedTeams.has(name));
  if (teams.length === 0) {
    return [];
  }
  let git: string | undefined;
  const statuses: ShareUpdateStatus[] = [];
  for (const [name, team] of teams) {
    const receipt = yield* readFreshShareFetchReceipt(config, name, team);
    if (receipt) {
      statuses.push({
        behind: receipt.behind,
        team: name,
        ...(receipt.warning ? {warning: receipt.warning} : {}),
      });
      continue;
    }
    git ??= yield* requiredExecutable('git');
    const fetchResult = yield* runCommand(git, ['-C', team.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME], {
      allowFailure: true,
      timeoutMs: AUTO_SHARE_GIT_TIMEOUT_MILLISECONDS,
    });
    if (fetchResult.exitCode !== 0) {
      const warning = boundedShareFetchWarning(
        `Auto-sync check for shared team "${name}" failed: ${
          fetchResult.stderr.trim() || fetchResult.stdout.trim() || 'unknown git fetch error'
        }`,
      );
      yield* persistShareFetchReceipt(config, {
        behind: 0,
        checkedAt: yield* Clock.currentTimeMillis,
        remote: team.remote,
        succeeded: false,
        team: name,
        version: SHARE_FETCH_RECEIPT_VERSION,
        warning,
        worktree: team.worktree,
      });
      statuses.push({behind: 0, team: name, warning});
      continue;
    }
    const behind = yield* gitOutput(
      team.worktree,
      ['rev-list', '--count', 'HEAD..@{u}'],
      false,
      AUTO_SHARE_GIT_TIMEOUT_MILLISECONDS,
    );
    if (behind === undefined) {
      const warning = `Auto-sync check for shared team "${name}" failed: could not read upstream behind count.`;
      yield* persistShareFetchReceipt(config, {
        behind: 0,
        checkedAt: yield* Clock.currentTimeMillis,
        remote: team.remote,
        succeeded: false,
        team: name,
        version: SHARE_FETCH_RECEIPT_VERSION,
        warning,
        worktree: team.worktree,
      });
      statuses.push({behind: 0, team: name, warning});
      continue;
    }
    const behindCount = Number.parseInt(behind, 10) || 0;
    yield* persistShareFetchReceipt(config, {
      behind: behindCount,
      checkedAt: yield* Clock.currentTimeMillis,
      remote: team.remote,
      succeeded: true,
      team: name,
      version: SHARE_FETCH_RECEIPT_VERSION,
      worktree: team.worktree,
    });
    statuses.push({behind: behindCount, team: name});
  }
  return statuses;
});

const shareFetchReceiptPath = Effect.fn('share.fetchReceiptPath')(function* (config: ShareRuntime, team: string) {
  return yield* pathJoin(config.agentContextHome, 'share', 'fetch-receipts', `${team}.json`);
});

const readFreshShareFetchReceipt = Effect.fn('share.readFreshFetchReceipt')(function* (
  config: ShareRuntime,
  teamName: string,
  team: ShareTeamConfig,
) {
  const raw = yield* readFileIfExists(yield* shareFetchReceiptPath(config, teamName));
  if (!raw) return undefined;
  return parseFreshShareFetchReceipt(raw, teamName, team, yield* Clock.currentTimeMillis);
});

const persistShareFetchReceipt = Effect.fn('share.persistFetchReceipt')(function* (
  config: ShareRuntime,
  receipt: ShareFetchReceipt,
) {
  const target = yield* shareFetchReceiptPath(config, receipt.team);
  const parent = yield* pathDirname(target);
  const system = yield* SystemInfo;
  const temporary = `${target}.${system.processId}.tmp`;
  const write = Effect.gen(function* () {
    yield* mkdir(parent, {mode: 0o700, recursive: true});
    yield* writeFile(temporary, `${JSON.stringify(receipt)}\n`, {encoding: 'utf8', mode: 0o600});
    yield* rename(temporary, target);
  }).pipe(Effect.ensuring(rm(temporary, {force: true}).pipe(Effect.ignore)));
  yield* write.pipe(
    Effect.catch(error =>
      Console.error(
        `Could not persist the shared fetch receipt for team "${receipt.team}"; another process may fetch again: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    ),
  );
});

const recordShareTeamSynced = Effect.fn('share.recordTeamSynced')(function* (config: ShareRuntime, teamName: string) {
  const team = yield* resolveTeam(config, teamName);
  yield* persistShareFetchReceipt(config, {
    behind: 0,
    checkedAt: yield* Clock.currentTimeMillis,
    remote: team.config.remote,
    succeeded: true,
    team: team.name,
    version: SHARE_FETCH_RECEIPT_VERSION,
    worktree: team.config.worktree,
  });
});

function parseFreshShareFetchReceipt(
  raw: string,
  teamName: string,
  team: ShareTeamConfig,
  now: number,
): ShareFetchReceipt | undefined {
  const parsed = parseJsonConfigObject(raw);
  if (
    !parsed ||
    parsed.version !== SHARE_FETCH_RECEIPT_VERSION ||
    parsed.team !== teamName ||
    parsed.remote !== team.remote ||
    parsed.worktree !== team.worktree ||
    typeof parsed.behind !== 'number' ||
    !Number.isSafeInteger(parsed.behind) ||
    parsed.behind < 0 ||
    typeof parsed.checkedAt !== 'number' ||
    !Number.isSafeInteger(parsed.checkedAt) ||
    parsed.checkedAt <= 0 ||
    parsed.checkedAt > now ||
    now - parsed.checkedAt >= SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS ||
    typeof parsed.succeeded !== 'boolean' ||
    (parsed.succeeded === false && typeof parsed.warning !== 'string')
  ) {
    return undefined;
  }
  return {
    behind: parsed.behind,
    checkedAt: parsed.checkedAt,
    remote: parsed.remote,
    succeeded: parsed.succeeded,
    team: parsed.team,
    version: parsed.version,
    ...(typeof parsed.warning === 'string' ? {warning: boundedShareFetchWarning(parsed.warning)} : {}),
    worktree: parsed.worktree,
  };
}

function boundedShareFetchWarning(warning: string): string {
  return warning.length <= SHARE_FETCH_WARNING_MAXIMUM_LENGTH
    ? warning
    : `${warning.slice(0, SHARE_FETCH_WARNING_MAXIMUM_LENGTH - 1)}…`;
}

export const runShareSync = Effect.fn('share.runShareSync')(function* (
  config: ShareRuntime,
  options: ShareSyncOptions,
) {
  const teams = yield* teamsForShareQuery(config, options.team);

  if (options.team) {
    const team = teams[0];
    if (!team) {
      throw ShareOperationError.make({message: 'No shared teams configured. Run: threadnote share init <remote-url>'});
    }
    yield* runShareSyncForTeam(config, team, options);
    return;
  }

  const failures: string[] = [];
  for (const [index, team] of teams.entries()) {
    if (teams.length > 1) {
      yield* Console.log(`Syncing shared team "${team.name}" (${index + 1}/${teams.length})...`);
    }
    const syncResult = yield* Effect.result(runShareSyncForTeam(config, team, options));
    if (Result.isFailure(syncResult)) {
      const error = syncResult.failure;
      failures.push(`${team.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw ShareOperationError.make({
      message: [
        `share sync failed for ${failures.length} shared team(s):`,
        ...failures.map(failure => `- ${failure}`),
      ].join('\n'),
    });
  }
});

const runShareSyncForTeam = Effect.fn('share.runShareSyncForTeam')(function* (
  config: ShareRuntime,
  team: ResolvedTeam,
  options: ShareSyncOptions,
) {
  const dryRun = options.dryRun === true;
  const git = yield* requiredExecutable('git');
  const worktree = team.config.worktree;
  const readOnly = shareTeamAccess(team.config) === 'read-only';

  if (!dryRun && !readOnly) {
    // Don't push here — sync's final push step (below) will deliver any
    // .gitignore housekeeping commit, avoiding a double-push round trip.
    yield* ensureSharedGitignore(worktree, git, false);
  }

  if (yield* hasUncommittedChanges(worktree)) {
    if (readOnly) {
      throw ShareOperationError.make({
        message: `Shared team "${team.name}" is read-only and has local worktree changes. Discard or move them before syncing; Threadnote will not auto-commit read-only teams.`,
      });
    }
    if (options.autoCommit === false) {
      throw ShareOperationError.make({
        message: `Worktree ${worktree} has uncommitted changes. Commit them yourself or rerun without --no-auto-commit.`,
      });
    }
    const message = options.message ?? `share: sync ${DateTime.formatIso(yield* DateTime.now)}`;
    yield* stageShareableChanges(dryRun, git, worktree);
    const commitResult = yield* maybeRun(dryRun, git, ['-C', worktree, 'commit', '-m', message], {allowFailure: true});
    if (!dryRun && commitResult && commitResult.exitCode !== 0) {
      if (yield* hasUncommittedChanges(worktree)) {
        throw ShareOperationError.make({
          message: `Worktree ${worktree} has uncommitted changes that Threadnote did not auto-commit. Commit, remove, or ignore the remaining files, then rerun \`threadnote share sync\`.\nGit said: ${
            commitResult.stderr.trim() || commitResult.stdout.trim() || 'unknown git commit error'
          }`,
        });
      }
      throw ShareOperationError.make({
        message: `Could not auto-commit share worktree changes in ${worktree}: ${
          commitResult.stderr.trim() || commitResult.stdout.trim() || 'unknown git commit error'
        }`,
      });
    }
    if (!dryRun && (yield* hasUncommittedChanges(worktree))) {
      throw ShareOperationError.make({
        message: `Worktree ${worktree} still has uncommitted changes after staging Threadnote shareable files. Commit, remove, or ignore the remaining files, then rerun \`threadnote share sync\`.`,
      });
    }
  }

  if (readOnly) {
    const ahead = yield* gitOutput(worktree, ['rev-list', '--count', '@{u}..HEAD'], dryRun);
    if ((Number.parseInt(ahead ?? '0', 10) || 0) > 0) {
      throw ShareOperationError.make({
        message: `Shared team "${team.name}" is read-only but has local commits ahead of upstream. Move those commits to a writable clone before syncing.`,
      });
    }
  }

  const beforeRev = yield* gitOutput(worktree, ['rev-parse', 'HEAD'], dryRun);
  yield* maybeRun(dryRun, git, ['-C', worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME]);
  const pullResult = dryRun
    ? undefined
    : yield* runCommand(git, ['-C', worktree, 'rebase', '@{u}'], {allowFailure: true});
  if (dryRun) {
    yield* Console.log(`Would run: ${formatShellCommand(git, ['-C', worktree, 'rebase', '@{u}'])}`);
  } else if (pullResult && pullResult.exitCode !== 0) {
    // Detect mid-rebase state via Git-resolved filesystem markers rather than
    // parsing localized human-readable output.
    if (yield* isShareGitOperationInProgress(git, worktree)) {
      throw ShareOperationError.make({
        message: `git pull --rebase reported conflicts in ${worktree}. The worktree is in a rebase-in-progress state.\nResolve the conflicts in-place, run \`git -C ${worktree} rebase --continue\` (or --abort), then re-run \`threadnote share sync\`.`,
      });
    }
    throw ShareOperationError.make({
      message: `git rebase @{u} failed in ${worktree}: ${pullResult.stderr.trim() || pullResult.stdout.trim() || 'unknown error'}`,
    });
  }
  const afterRev = yield* gitOutput(worktree, ['rev-parse', 'HEAD'], dryRun);

  if (!dryRun) {
    const state = autoShareState(config);
    yield* loadPendingReindexes(config, state);
    const previouslyPending = state.pendingReindexes.get(team.name) ?? [];
    const newChanges =
      beforeRev && afterRev && beforeRev !== afterRev ? yield* listChangedFiles(worktree, beforeRev, afterRev) : [];
    const combined = mergeChanges(previouslyPending, newChanges);
    if (combined.length === 0) {
      yield* Console.log('No upstream changes to reindex.');
    } else {
      const result = yield* applyAndPersistChanges(config, team.config, state, combined);
      const succeeded = combined.length - result.failed.length;
      yield* Console.log(`Reindexed ${succeeded} file change(s) into native canonical store.`);
      if (result.failed.length > 0) {
        yield* Console.warn(
          `share sync: ${result.failed.length} file(s) could not be ingested on this run; they are persisted and will be retried on the next sync or agent recall/read.`,
        );
        const conflicts = yield* listShareConflicts(config, {team: team.name});
        yield* Console.warn(formatShareConflictNextSteps(team.name, conflicts));
      }
    }
  }

  if (readOnly) {
    yield* Console.log(`Read-only shared team "${team.name}": push disabled.`);
  } else if (options.push !== false) {
    const pushResult = dryRun
      ? undefined
      : yield* runCommand(git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME], {allowFailure: true});
    if (dryRun) {
      yield* Console.log(`Would run: ${formatShellCommand(git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME])}`);
    } else if (pushResult && pushResult.exitCode !== 0) {
      throw ShareOperationError.make({
        message: `git push failed in ${worktree}: ${pushResult.stderr.trim() || pushResult.stdout.trim() || 'unknown error'}`,
      });
    }
  }
});

const runShareSyncQuiet = Effect.fn('share.runShareSyncQuiet')(function* (
  config: ShareRuntime,
  state: AutoShareState,
  options: {readonly team: string},
) {
  const team = yield* resolveTeam(config, options.team);
  const git = yield* requiredExecutable('git');
  const worktree = team.config.worktree;

  const pendingChanges = state.pendingReindexes.get(team.name) ?? [];

  if (yield* isShareGitOperationInProgress(git, worktree)) {
    return {
      synced: false,
      warnings: [
        ...pendingMemoryIngestWarnings(state, team.name),
        `Shared team "${team.name}" has a Git operation already in progress; automatic sync left its index and worktree untouched. Finish or abort the operation, then rerun recall/read.`,
      ],
    };
  }

  const ahead = yield* gitOutput(worktree, ['rev-list', '--count', '@{u}..HEAD'], false);
  if (ahead === undefined) {
    return {
      synced: false,
      warnings: [
        ...pendingMemoryIngestWarnings(state, team.name),
        `Shared team "${team.name}" upstream status is unknown; skipped automatic sync. Run \`threadnote share sync --team ${team.name}\` to inspect and resolve it.`,
      ],
    };
  }
  if ((Number.parseInt(ahead, 10) || 0) > 0) {
    return {
      synced: false,
      warnings: [
        ...pendingMemoryIngestWarnings(state, team.name),
        shareTeamAccess(team.config) === 'read-only'
          ? `Shared team "${team.name}" is read-only and has local commits ahead of upstream; skipped automatic sync. Move those commits to a writable clone before syncing.`
          : `Shared team "${team.name}" has local commits ahead of upstream; skipped automatic sync. Run \`threadnote share sync --team ${team.name}\` to publish or reconcile them.`,
      ],
    };
  }

  const restoredPaths = yield* restoreTrackedSharedChanges(git, worktree);
  const restoreWarnings =
    restoredPaths.length > 0
      ? [
          `Shared team "${team.name}" restored ${restoredPaths.length} tracked shared file change(s) from git before automatic sync because the remote is authoritative.`,
        ]
      : [];
  if (yield* hasUncommittedChanges(worktree)) {
    return {
      synced: false,
      warnings: [
        ...pendingMemoryIngestWarnings(state, team.name),
        ...restoreWarnings,
        `Shared team "${team.name}" still has untracked or unmanaged changes; Threadnote left them untouched and skipped automatic sync. Run \`threadnote share sync --team ${team.name}\` to inspect and resolve them.`,
      ],
    };
  }

  const beforeRev = yield* gitOutput(worktree, ['rev-parse', 'HEAD'], false);
  const pullResult = yield* runCommand(git, ['-C', worktree, 'rebase', '@{u}'], {allowFailure: true});
  if (pullResult.exitCode !== 0) {
    if (yield* isShareGitOperationInProgress(git, worktree)) {
      throw ShareOperationError.make({
        message: `Automatic share sync hit git conflicts in ${worktree}. Resolve them in-place, run \`git -C ${worktree} rebase --continue\` (or --abort), then rerun recall/read.`,
      });
    }
    throw ShareOperationError.make({
      message: `Automatic share sync failed in ${worktree}: ${pullResult.stderr.trim() || pullResult.stdout.trim() || 'unknown error'}`,
    });
  }
  const afterRev = yield* gitOutput(worktree, ['rev-parse', 'HEAD'], false);
  let pulledChanges: readonly ChangedFile[] = [];
  if (beforeRev && afterRev && beforeRev !== afterRev) {
    pulledChanges = yield* listChangedFiles(worktree, beforeRev, afterRev);
  }
  const combined = mergeChanges(pendingChanges, pulledChanges);
  if (combined.length > 0) {
    yield* applyAndPersistChanges(config, team.config, state, combined, {quiet: true});
  }
  return {
    synced: true,
    warnings: [...restoreWarnings, ...pendingMemoryIngestWarnings(state, team.name, true)],
  };
});

function pendingMemoryIngestWarnings(
  state: AutoShareState,
  teamName: string,
  continuedForOtherChanges = false,
): readonly string[] {
  const count = state.pendingReindexes.get(teamName)?.length ?? 0;
  if (count === 0) {
    return [];
  }
  return [
    `Shared team "${teamName}" has ${count} pending shared memory ingest failure(s).${continuedForOtherChanges ? ' Automatic sync continued for other remote changes.' : ''} Run \`threadnote share conflicts --team ${teamName}\` to inspect them.`,
  ];
}

// applyChangesToCanonicalStore only reflects changes to files under shareable
// top-level directories. For renames that cross those directories
// (e.g., handoffs/x.md -> durable/y.md), listChangedFiles emits a
// 'removed' for the old path and an 'added' for the new path; both are
// processed independently here. The 'removed' entry for a non-shareable path
// is filtered out by the firstSegment check, which is the desired outcome
// because non-shareable files are never reflected into the shared subtree.
//
// Per-change failures are non-fatal: we log a warning and continue with the
// other changes, returning the failed list so the caller can re-persist them
// to pendingReindexes for the next sync attempt. A single stuck URI (e.g.,
// a per-resource lock being held longer than our retry window) must not
// cause a whole sync to lose all the other files it could have applied.
const applyChangesToCanonicalStore = Effect.fn('share.applyChangesToCanonicalStore')(function* (
  config: ShareRuntime,
  team: ShareTeamConfig,
  changes: readonly ChangedFile[],
  options: {readonly quiet?: boolean} = {},
) {
  const ov = NATIVE_RESOURCE_BACKEND;
  const failed: ChangedFile[] = [];
  for (const change of changes) {
    if (!isShareableMemoryChange(change)) {
      continue;
    }
    let normalizedChange = change;
    let changeLabel = conflictId(team.name, change.relativePath);
    const applyResult = yield* Effect.result(
      Effect.gen(function* () {
        normalizedChange = yield* normalizePendingChange({config: team, name: team.name}, change);
        const uri = yield* workfileToResourceUri(config, team, normalizedChange.path);
        changeLabel = uri;
        const fs = yield* FileSystem.FileSystem;
        const identityLockPlan = yield* sharedIdentityLockPlan(config, ov, uri, normalizedChange);
        return yield* withMemoryUriLocks(
          fs,
          config.agentContextHome,
          [uri, ...identityLockPlan.lockKeys],
          Effect.gen(function* () {
            if (normalizedChange.status === 'removed') {
              const currentContent = yield* readExistingMemoryContent(config, ov, uri);
              if (currentContent === undefined) {
                return;
              }
              yield* removeMemoryUri(config, ov, uri, false, options);
              return;
            }
            if (!(yield* isRegularFileNoSymlink(normalizedChange.path))) {
              return;
            }
            // Either 'modified' or 'added' from git's perspective; the file on disk
            // was just rewritten by the pull-rebase and OV's index needs to catch up.
            // Both cases collapse to the same OV-side rule: if the URI already exists,
            // we must write with 'replace' (the create path's retry loop snapshots
            // existedBeforeWrite=true and would burn every attempt against an
            // ALREADY_EXISTS error). 'added' lands here when OV has the URI from an
            // earlier path — a prior share init/sync, or a local publish that wrote
            // the URI before the corresponding upstream commit landed in this clone.
            const content = yield* readSharedInboundFileContent(uri, normalizedChange.path);
            const currentContent = yield* readExistingMemoryContent(config, ov, uri);
            let restoredIdentity = false;
            if (currentContent !== undefined) {
              const identityIssue = sharedMemoryIdentityContinuityIssue(uri, currentContent, content);
              if (identityIssue !== undefined) {
                if (
                  identityLockPlan.currentContent === undefined ||
                  identityLockPlan.incomingContent === undefined ||
                  !sharedMemoryContentsEquivalent(currentContent, identityLockPlan.currentContent) ||
                  !sharedMemoryContentsEquivalent(content, identityLockPlan.incomingContent)
                ) {
                  return yield* ShareOperationError.make({
                    message: `Refusing shared update for ${uri}: memory identity changed while acquiring update locks.`,
                  });
                }
                restoredIdentity = yield* isHistoricalSharedIdentityRestoration(
                  team.worktree,
                  normalizedChange,
                  uri,
                  currentContent,
                  content,
                );
                if (!restoredIdentity) return yield* ShareOperationError.make({message: identityIssue});
                yield* assertRestoredSharedMemoryIdentityAvailable(config, team, uri, content);
              }
              if (
                sharedMemoryContentsEquivalent(currentContent, content) &&
                countManagedMemoryFieldsTrailers(currentContent) <= 1
              ) {
                return;
              }
              if (options.quiet !== true) {
                yield* Console.warn(
                  `share sync: ${uri}: replacing local shared cache content with the remote version.`,
                );
              }
            }
            yield* ensureSharedDirectoryChain(config, ov, uri, false, options);
            const writeMode: 'create' | 'replace' = currentContent !== undefined ? 'replace' : 'create';
            const writeCheck =
              restoredIdentity && currentContent !== undefined
                ? verifySharedMemoryContentUnchanged(config, uri, currentContent)
                : verifySharedMemoryIdentityContinuity(config, uri, content);
            yield* writeMemoryFileChecked(config, ov, uri, content, writeMode, false, writeCheck, options);
          }),
        );
      }),
    );
    if (Result.isFailure(applyResult)) {
      const err = applyResult.failure;
      const message = err instanceof Error ? err.message : String(err);
      if (options.quiet !== true) {
        yield* Console.warn(`share sync: ${changeLabel}: ingest failed — will retry on the next sync. ${message}`);
      }
      failed.push(normalizedChange);
    }
  }
  return {failed};
});

const sharedIdentityLockPlan = Effect.fn('share.identityLockPlan')(function* (
  config: ShareRuntime,
  ov: string,
  uri: string,
  change: ChangedFile,
) {
  if (change.status === 'removed' || !(yield* isRegularFileNoSymlink(change.path))) {
    return {currentContent: undefined, incomingContent: undefined, lockKeys: [] as string[]};
  }
  const incomingContent = yield* readSharedInboundFileContent(uri, change.path);
  const currentContent = yield* readExistingMemoryContent(config, ov, uri);
  const currentMemoryId =
    currentContent === undefined ? undefined : parseMemoryDocument(uri, currentContent)?.metadata.memoryId;
  const incomingMemoryId = parseMemoryDocument(uri, incomingContent)?.metadata.memoryId;
  return {
    currentContent,
    incomingContent,
    lockKeys: [memoryIdentityLockKey(currentMemoryId), memoryIdentityLockKey(incomingMemoryId)].filter(
      (key): key is string => key !== undefined,
    ),
  };
});

const MAX_SHARED_IDENTITY_HISTORY_COMMITS = 64;

const isHistoricalSharedIdentityRestoration = Effect.fn('share.isHistoricalIdentityRestoration')(function* (
  worktree: string,
  change: ChangedFile,
  uri: string,
  currentContent: string,
  incomingContent: string,
) {
  const previousContent =
    change.previousContent ??
    (change.previousRevision
      ? yield* gitFileContent(worktree, change.previousRevision, change.relativePath)
      : undefined);
  if (previousContent === undefined || !sharedMemoryContentsEquivalent(currentContent, previousContent)) return false;
  const currentMemoryId = parseMemoryDocument(uri, currentContent)?.metadata.memoryId;
  const incomingMemoryId = parseMemoryDocument(uri, incomingContent)?.metadata.memoryId;
  if (currentMemoryId === undefined || incomingMemoryId === undefined || currentMemoryId === incomingMemoryId) {
    return false;
  }
  const headRawContent = yield* gitFileContent(worktree, 'HEAD', change.relativePath);
  if (headRawContent === undefined) return false;
  const headContent = yield* prepareSharedInboundContentEffect(uri, headRawContent);
  if (!sharedMemoryContentsEquivalent(incomingContent, headContent)) return false;
  const history = yield* runCommand(
    'git',
    [
      '-C',
      worktree,
      'log',
      `--max-count=${MAX_SHARED_IDENTITY_HISTORY_COMMITS}`,
      '--format=%H',
      '--follow',
      '--',
      change.relativePath,
    ],
    {allowFailure: true},
  );
  if (history.exitCode !== 0) return false;
  const historyMemoryIds = yield* Effect.forEach(
    history.stdout.split('\n').filter(Boolean),
    Effect.fn('share.callback')(function* (revision) {
      const historyContent = yield* gitFileContent(worktree, revision, change.relativePath);
      return historyContent === undefined ? undefined : parseMemoryDocument(uri, historyContent)?.metadata.memoryId;
    }),
  );
  return isRestoredSharedMemoryIdentityHistory(historyMemoryIds, currentMemoryId, incomingMemoryId);
});

const assertRestoredSharedMemoryIdentityAvailable = Effect.fn('share.assertRestoredIdentityAvailable')(function* (
  config: ShareRuntime,
  team: ShareTeamConfig,
  uri: string,
  incomingContent: string,
) {
  const memoryId = parseMemoryDocument(uri, incomingContent)?.metadata.memoryId;
  if (memoryId === undefined) {
    return yield* ShareOperationError.make({
      message: `Refusing shared identity restoration for ${uri}: incoming content has no stable memory_id.`,
    });
  }
  const scope = `threadnote://user/${uriSegment(config.user)}/memories/shared/${uriSegment(team.name)}/durable/projects`;
  const candidates = yield* loadRecallMemoryIdentities(config, {
    allowedUriScopes: [scope],
    memoryIds: [memoryId],
    validateNow: true,
  });
  if (
    candidates.some(
      candidate => candidate.memoryId === memoryId && (candidate.identityConflict === true || candidate.uri !== uri),
    )
  ) {
    return yield* ShareOperationError.make({
      message: `Refusing shared identity restoration for ${uri}: stable memory_id ${memoryId} is already owned or ambiguous in team ${team.name}.`,
    });
  }

  const head = yield* gitOutput(team.worktree, ['rev-parse', 'HEAD'], false);
  const listing =
    head === undefined
      ? undefined
      : yield* gitOutput(
          team.worktree,
          ['ls-tree', '-r', '--name-only', '-z', head, '--', ...SHAREABLE_MEMORY_KIND_DIRS],
          false,
        );
  if (head === undefined || listing === undefined) {
    return yield* ShareOperationError.make({
      message: `Cannot verify stable memory_id ownership in shared team ${team.name}. Inspect the shared worktree and retry.`,
    });
  }
  for (const candidate of listing.split('\0').filter(Boolean)) {
    const relativePath = assertSafeShareRelativePath(candidate);
    if (!relativePath.endsWith('.md')) continue;
    const rawContent = yield* gitFileContent(team.worktree, head, relativePath);
    if (rawContent === undefined) {
      return yield* ShareOperationError.make({
        message: `Cannot verify stable memory_id ownership for shared file ${relativePath}. Inspect the shared worktree and retry.`,
      });
    }
    const candidatePath = yield* pathJoin(team.worktree, ...relativePath.split('/'));
    const candidateUri = yield* workfileToResourceUri(config, team, candidatePath);
    const record = parseMemoryDocument(candidateUri, rawContent);
    if (record?.metadata.status === 'active' && record.metadata.memoryId === memoryId && candidateUri !== uri) {
      return yield* ShareOperationError.make({
        message: `Refusing shared identity restoration for ${uri}: stable memory_id ${memoryId} is already owned by ${candidateUri} in team ${team.name}.`,
      });
    }
  }
});

export function isRestoredSharedMemoryIdentityHistory(
  historyMemoryIds: readonly (string | undefined)[],
  currentMemoryId: string,
  incomingMemoryId: string,
): boolean {
  const distinctIdentities: string[] = [];
  for (const memoryId of historyMemoryIds) {
    if (memoryId !== undefined && distinctIdentities.at(-1) !== memoryId) distinctIdentities.push(memoryId);
  }
  return (
    distinctIdentities[0] === incomingMemoryId &&
    distinctIdentities[1] === currentMemoryId &&
    distinctIdentities[2] === incomingMemoryId
  );
}

const readExistingMemoryContent = Effect.fn('share.readExistingMemoryContent')(function* (
  config: ShareRuntime,
  ov: string,
  uri: string,
) {
  if (!(yield* resourceExistsStrict(ov, config, uri))) {
    return undefined;
  }
  return yield* readMemoryContent(config, ov, uri, false);
});

const applyAndPersistChanges = Effect.fn('share.applyAndPersistChanges')(function* (
  config: ShareRuntime,
  team: ShareTeamConfig,
  state: AutoShareState,
  changes: readonly ChangedFile[],
  options: {readonly quiet?: boolean} = {},
) {
  if (changes.length === 0) {
    return {failed: []};
  }
  // Persist intent BEFORE applying so a crash mid-apply doesn't lose state.
  state.pendingReindexes.set(team.name, changes);
  yield* writePendingReindexes(config, state);
  const result = yield* applyChangesToCanonicalStore(config, team, changes, options);
  if (result.failed.length > 0) {
    const failed = yield* Effect.forEach(result.failed, change =>
      materializePreviousContentForPendingConflict(team.worktree, change),
    );
    state.pendingReindexes.set(team.name, failed);
  } else {
    state.pendingReindexes.delete(team.name);
  }
  yield* writePendingReindexes(config, state);
  return result;
});

const materializePreviousContentForPendingConflict = Effect.fn('share.materializePreviousContentForPendingConflict')(
  function* (worktree: string, change: ChangedFile) {
    if (change.previousContent !== undefined || change.previousRevision === undefined) {
      return change;
    }
    const previousContent = yield* gitFileContent(worktree, change.previousRevision, change.relativePath);
    return previousContent === undefined ? change : {...change, previousContent, previousRevision: undefined};
  },
);
