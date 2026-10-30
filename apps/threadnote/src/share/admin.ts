import {Array as EffectArray} from 'effect';
import {Console, DateTime, Effect, FileSystem, Option, Path, Result} from 'effect';

import {uriSegment} from '@threadnote/workspace/manifest';

import {ResourceStore} from '@threadnote/store/resource-store';
import {recordMemoryRelocation} from '@threadnote/memory/relocation';

import type {
  ShareInitOptions,
  ShareListOptions,
  ShareRenameOptions,
  ShareRemoveOptions,
  ShareSetAccessOptions,
  ShareSetUrlOptions,
  ShareRuntime,
  ShareStatusOptions,
  ShareTeamConfig,
  ShareTeamsFile,
  ShareUnpublishOptions,
} from '../types.js';

import {
  assertResourceUri,
  ensureDirectory,
  exists,
  formatShellCommand,
  maybeRun,
  portablePath,
  removePath,
  requiredExecutable,
  runCommand,
} from '../utils.js';

import {
  DEFAULT_GIT_REMOTE_NAME,
  NATIVE_RESOURCE_BACKEND,
  SHARED_SEGMENT,
  ShareOperationError,
  TEAMS_FILE_VERSION,
  assertSafeShareRelativePath,
  assertShareTeamWritable,
  assertWorktreeUsable,
  ensureSharedGitignore,
  isInTeamNamespace,
  mkdir,
  normalizeTeamName,
  parentUri,
  pathDirname,
  pathJoin,
  pathRelative,
  pathSeparator,
  personalUriFor,
  readFile,
  readMemoryContent,
  readTeamsFile,
  removeMemoryUri,
  rename,
  resolveTeam,
  resourceExists,
  resourceStoreLocation,
  resourceUriToWorktreeRelative,
  setMemoryVisibility,
  shareTeamAccess,
  sharedMemoryContentsEquivalent,
  shouldSetDefault,
  teamGitdirPath,
  teamWorktreePath,
  teamsFilePath,
  walkMemoryFiles,
  writeFile,
  writeMemoryFile,
  writeTeamsFile,
} from './core.js';

import {gitOutput, publishShareGitChange} from './git.js';
import {ingestSharedWorktree} from './sync.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const runShareInit = Effect.fn('share.runShareInit')(function* (
  config: ShareRuntime,
  remoteUrl: string,
  options: ShareInitOptions,
) {
  if (!Effect2.pipe(remoteUrl, EffectString.trim)) {
    throw ShareOperationError.make({message: 'Provide a git remote URL for the shared memories repo.'});
  }
  const dryRun = options.dryRun === true;
  const teamName = normalizeTeamName(options.team);
  const teamsFile = yield* readTeamsFile(config);
  if (teamsFile.teams[teamName]) {
    throw ShareOperationError.make({
      message: `Team "${teamName}" is already configured (remote ${teamsFile.teams[teamName].remote}). Remove it first with: threadnote share remove --team ${teamName}`,
    });
  }
  const worktree = yield* teamWorktreePath(config, teamName);
  const gitdir = yield* teamGitdirPath(config, teamName);
  yield* assertWorktreeUsable(worktree);
  if (yield* exists(gitdir)) {
    throw ShareOperationError.make({
      message: `Gitdir already exists at ${gitdir}; remove it or pick a different team name.`,
    });
  }

  yield* ensureDirectory(yield* pathDirname(worktree), dryRun);
  yield* ensureDirectory(yield* pathDirname(gitdir), dryRun);

  const git = yield* requiredExecutable('git');
  yield* maybeRun(dryRun, git, [
    'clone',
    '-c',
    'core.symlinks=false',
    `--separate-git-dir=${gitdir}`,
    '--',
    remoteUrl,
    worktree,
  ]);

  const newConfig: ShareTeamConfig = {
    ...(options.readOnly === true ? {access: 'read-only' as const} : {}),
    addedAt: DateTime.formatIso(yield* DateTime.now),
    gitdir,
    name: teamName,
    remote: remoteUrl,
    worktree,
  };
  const updatedTeams: ShareTeamsFile = {
    defaultTeam: shouldSetDefault(options, teamsFile) ? teamName : (teamsFile.defaultTeam ?? teamName),
    teams: {...teamsFile.teams, [teamName]: newConfig},
    version: TEAMS_FILE_VERSION,
  };
  if (dryRun) {
    yield* Console.log(`Would write teams file: ${yield* teamsFilePath(config)}`);
    yield* Console.log(`Would set ${teamName} as default? ${updatedTeams.defaultTeam === teamName}`);
    yield* Console.log(`Would set ${teamName} access: ${shareTeamAccess(newConfig)}`);
  } else {
    yield* writeTeamsFile(config, updatedTeams);
    yield* Console.log(
      `Configured shared team "${teamName}" (${shareTeamAccess(newConfig)}) -> ${yield* portablePath(worktree)}`,
    );
  }

  if (!dryRun) {
    if (shareTeamAccess(newConfig) === 'read-write') {
      yield* ensureSharedGitignore(worktree, git, options.push !== false);
    }
    const ingested = yield* ingestSharedWorktree(config, newConfig);
    yield* Console.log(`Ingested ${ingested} shared file(s) into native canonical store.`);
  }
});

export const recoverShareInit = Effect.fn('share.recoverShareInit')(function* (
  config: ShareRuntime,
  remoteUrl: string,
  options: Pick<ShareInitOptions, 'push' | 'setDefault' | 'team'>,
) {
  const teamName = normalizeTeamName(options.team);
  const teamsFile = yield* readTeamsFile(config);
  if (teamsFile.teams[teamName] !== undefined) return false;
  const worktree = yield* teamWorktreePath(config, teamName);
  const gitdir = yield* teamGitdirPath(config, teamName);
  const worktreeExists = yield* exists(worktree);
  const gitdirExists = yield* exists(gitdir);
  if (!worktreeExists && !gitdirExists) return false;
  if (!worktreeExists || !gitdirExists) {
    throw ShareOperationError.make({message: `Partial shared checkout for team "${teamName}" is incomplete.`});
  }
  const git = yield* requiredExecutable('git');
  const actualGitdir = yield* runCommand(git, ['-C', worktree, 'rev-parse', '--absolute-git-dir'], {
    allowFailure: true,
  });
  const remote = yield* runCommand(git, ['-C', worktree, 'remote', 'get-url', DEFAULT_GIT_REMOTE_NAME], {
    allowFailure: true,
  });
  const status = yield* runCommand(git, ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all'], {
    allowFailure: true,
  });
  const divergence = yield* runCommand(git, ['-C', worktree, 'rev-list', '--count', 'HEAD...@{upstream}'], {
    allowFailure: true,
  });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [expectedGitdir, observedGitdir] = yield* Effect.all([
    fs.realPath(gitdir),
    actualGitdir.exitCode === 0
      ? fs.realPath(Effect2.pipe(actualGitdir.stdout, EffectString.trim))
      : Effect.succeed(''),
  ]);
  const observedRemote = Effect2.pipe(remote.stdout, EffectString.trim);
  const observedRemotePath = Effect2.pipe(observedRemote, EffectString.startsWith('file://'))
    ? yield* Effect.try({
        catch: () => '',
        try: () => decodeURIComponent(new URL(observedRemote).pathname),
      })
    : observedRemote;
  const requestedRemotePath = Effect2.pipe(remoteUrl, EffectString.startsWith('file://'))
    ? yield* Effect.try({
        catch: () => '',
        try: () => decodeURIComponent(new URL(remoteUrl).pathname),
      })
    : remoteUrl;
  const remoteMatches =
    observedRemote === remoteUrl ||
    (path.isAbsolute(observedRemotePath) && path.isAbsolute(requestedRemotePath)
      ? yield* Effect.all([fs.realPath(observedRemotePath), fs.realPath(requestedRemotePath)]).pipe(
          Effect.map(([left, right]) => left === right),
          Effect.orElseSucceed(() => false),
        )
      : false);
  if (
    actualGitdir.exitCode !== 0 ||
    expectedGitdir !== observedGitdir ||
    remote.exitCode !== 0 ||
    !remoteMatches ||
    status.exitCode !== 0 ||
    status.stdout.length > 0 ||
    divergence.exitCode !== 0 ||
    Effect2.pipe(divergence.stdout, EffectString.trim) !== '0'
  ) {
    const mismatches = [
      ...(actualGitdir.exitCode !== 0 || expectedGitdir !== observedGitdir ? ['gitdir'] : []),
      ...(remote.exitCode !== 0 || !remoteMatches ? ['remote'] : []),
      ...(status.exitCode !== 0 || status.stdout.length > 0 ? ['worktree'] : []),
      ...(divergence.exitCode !== 0 || Effect2.pipe(divergence.stdout, EffectString.trim) !== '0' ? ['upstream'] : []),
    ];
    throw ShareOperationError.make({
      message: `Existing shared checkout for team "${teamName}" does not exactly match the interrupted initialization (${EffectArray.join(mismatches, ', ')}).`,
    });
  }
  const newConfig: ShareTeamConfig = {
    addedAt: DateTime.formatIso(yield* DateTime.now),
    gitdir,
    name: teamName,
    remote: remoteUrl,
    worktree,
  };
  yield* writeTeamsFile(config, {
    defaultTeam: shouldSetDefault(options, teamsFile) ? teamName : (teamsFile.defaultTeam ?? teamName),
    teams: {...teamsFile.teams, [teamName]: newConfig},
    version: TEAMS_FILE_VERSION,
  });
  yield* ensureSharedGitignore(worktree, git, options.push !== false);
  const ingested = yield* ingestSharedWorktree(config, newConfig);
  yield* Console.log(`Recovered shared team "${teamName}" and ingested ${ingested} shared file(s).`);
  return true;
});

export const runShareStatus = Effect.fn('share.runShareStatus')(function* (
  config: ShareRuntime,
  options: ShareStatusOptions,
) {
  const team = yield* resolveTeam(config, options.team);
  const git = yield* requiredExecutable('git');
  yield* Console.log(`Team: ${team.name}`);
  yield* Console.log(`Access: ${shareTeamAccess(team.config)}`);
  yield* Console.log(`Remote: ${team.config.remote}`);
  yield* Console.log(`Worktree: ${yield* portablePath(team.config.worktree)}`);
  yield* Console.log(`Gitdir: ${yield* portablePath(team.config.gitdir)}`);
  yield* maybeRun(options.dryRun === true, git, ['-C', team.config.worktree, 'status', '--short', '--branch']);
  yield* maybeRun(options.dryRun === true, git, ['-C', team.config.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME], {
    allowFailure: true,
  });
  const ahead = yield* gitOutput(team.config.worktree, ['rev-list', '--count', '@{u}..HEAD'], options.dryRun === true);
  const behind = yield* gitOutput(team.config.worktree, ['rev-list', '--count', 'HEAD..@{u}'], options.dryRun === true);
  if (ahead !== undefined) {
    yield* Console.log(`Ahead of upstream: ${ahead}`);
  }
  if (behind !== undefined) {
    yield* Console.log(`Behind upstream: ${behind}`);
  }
});

export const runShareUnpublish = Effect.fn('share.runShareUnpublish')(function* (
  config: ShareRuntime,
  sourceUri: string,
  options: ShareUnpublishOptions,
) {
  assertResourceUri(sourceUri);
  const team = yield* resolveTeam(config, options.team);
  assertShareTeamWritable(team, 'unpublish memories');
  const dryRun = options.dryRun === true;
  if (!isInTeamNamespace(config, sourceUri, team.name)) {
    throw ShareOperationError.make({message: `Memory ${sourceUri} is not in team "${team.name}" shared namespace.`});
  }
  const ov = NATIVE_RESOURCE_BACKEND;
  const targetUri = personalUriFor(config, sourceUri, team.name);
  const worktree = team.config.worktree;
  const relativePath = resourceUriToWorktreeRelative(config, sourceUri, team.name);
  const preflight = yield* preflightShareUnpublish(config, ov, sourceUri, targetUri, worktree, relativePath);
  if (preflight.disposition === 'create') {
    yield* writeMemoryFile(config, ov, targetUri, preflight.personalContent, 'create', dryRun);
  } else {
    yield* Console.log(
      `${dryRun ? 'Would resume' : 'Resuming'} unpublish with byte-identical personal memory: ${targetUri}`,
    );
  }
  if (preflight.worktreeState === 'already-removed') {
    yield* Console.log(
      `Shared Git path is already removed; ${dryRun ? 'would continue' : 'continuing'} cleanup: ${relativePath}`,
    );
  }

  const message = options.message ?? `share: unpublish ${relativePath}`;
  const gitMessages = yield* publishShareGitChange(worktree, relativePath, message, {
    dryRun,
    ignoreMissingRemovePaths: preflight.disposition === 'resume',
    push: options.push,
    verb: 'rm',
  });
  for (const gitMessage of gitMessages) {
    yield* Console.log(gitMessage);
  }
  if (!dryRun) {
    const currentTarget = yield* readMemoryContent(config, ov, targetUri, false);
    if (currentTarget !== preflight.personalContent) {
      throw ShareOperationError.make({
        message: `Personal target ${targetUri} changed during unpublish; shared canonical source preserved.`,
      });
    }
    const currentSource = yield* readMemoryContent(config, ov, sourceUri, false);
    if (currentSource !== preflight.sharedContent) {
      throw ShareOperationError.make({
        message: `Shared source ${sourceUri} changed during unpublish; shared canonical source preserved.`,
      });
    }
    yield* recordMemoryRelocation(config, {
      fromContent: currentSource,
      fromUri: sourceUri,
      toContent: currentTarget,
      toUri: targetUri,
    });
  }
  const removeResult = yield* Effect.result(removeMemoryUri(config, ov, sourceUri, dryRun));
  if (Result.isFailure(removeResult)) {
    const err = removeResult.failure;
    return yield* ShareOperationError.make({
      message: `Unpublished ${sourceUri} -> ${targetUri}, but could not remove the shared native canonical store source. Retry cleanup later with: threadnote forget ${sourceUri}\n${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }
  yield* Console.log(
    `${dryRun ? 'Would unpublish' : 'Unpublished'} ${sourceUri} -> ${targetUri} --mode ${preflight.disposition}`,
  );
});

type ShareUnpublishDisposition = 'create' | 'resume';

export function shareUnpublishTargetDisposition(
  existingTarget: string | undefined,
  expectedTarget: string,
): ShareUnpublishDisposition | 'conflict' {
  if (existingTarget === undefined) return 'create';
  return existingTarget === expectedTarget ? 'resume' : 'conflict';
}

const preflightShareUnpublish = Effect.fn('share.preflightShareUnpublish')(function* (
  config: ShareRuntime,
  ov: string,
  sourceUri: string,
  targetUri: string,
  worktree: string,
  relativePath: string,
) {
  const sharedContent = yield* readMemoryContent(config, ov, sourceUri, false);
  const personalContent = setMemoryVisibility(sharedContent, 'personal');
  const existingTarget = (yield* resourceExists(ov, config, targetUri))
    ? yield* readMemoryContent(config, ov, targetUri, false)
    : undefined;
  const disposition = shareUnpublishTargetDisposition(existingTarget, personalContent);
  if (disposition === 'conflict') {
    return yield* ShareOperationError.make({
      message: `Refusing to unpublish: a personal memory already exists at ${targetUri} with different content. Move or forget it first, then retry.`,
    });
  }
  const worktreeState = yield* preflightSharedWorktreeRemoval(
    worktree,
    relativePath,
    sharedContent,
    disposition === 'resume',
  );
  return {disposition, personalContent, sharedContent, worktreeState};
});

const preflightSharedWorktreeRemoval = Effect.fn('share.preflightSharedWorktreeRemoval')(function* (
  worktree: string,
  relativePath: string,
  canonicalContent: string,
  allowAlreadyRemoved: boolean,
) {
  const safeRelativePath = assertSafeShareRelativePath(relativePath);
  const git = yield* requiredExecutable('git');
  const unmerged = yield* runCommand(git, ['-C', worktree, 'ls-files', '-u', '--', safeRelativePath], {
    allowFailure: true,
  });
  if (unmerged.exitCode !== 0) {
    return yield* ShareOperationError.make({
      message: `Could not verify shared worktree state for ${safeRelativePath}: ${Effect2.pipe(unmerged.stderr, EffectString.trim) || Effect2.pipe(unmerged.stdout, EffectString.trim) || 'git ls-files failed'}.`,
    });
  }
  if (Effect2.pipe(unmerged.stdout, EffectString.trim).length > 0) {
    return yield* ShareOperationError.make({
      message: `Refusing to unpublish unmerged shared worktree file: ${safeRelativePath}. Resolve the conflict first.`,
    });
  }

  const trackedResult = yield* runCommand(git, ['-C', worktree, 'ls-files', '--', safeRelativePath], {
    allowFailure: true,
  });
  if (trackedResult.exitCode !== 0) {
    return yield* ShareOperationError.make({
      message: `Could not inspect shared worktree tracking for ${safeRelativePath}: ${Effect2.pipe(trackedResult.stderr, EffectString.trim) || Effect2.pipe(trackedResult.stdout, EffectString.trim) || 'git ls-files failed'}.`,
    });
  }
  const tracked = EffectArray.some(
    Effect2.pipe(trackedResult.stdout, EffectString.split(/\r?\n/)),
    path => path === safeRelativePath,
  );
  if (tracked) {
    const indexed = yield* runCommand(git, ['-C', worktree, 'show', `:${safeRelativePath}`], {allowFailure: true});
    if (indexed.exitCode !== 0) {
      return yield* ShareOperationError.make({
        message: `Could not verify shared worktree file ${safeRelativePath} against the Git index: ${Effect2.pipe(indexed.stderr, EffectString.trim) || Effect2.pipe(indexed.stdout, EffectString.trim) || 'git show failed'}.`,
      });
    }
    if (!sharedMemoryContentsEquivalent(indexed.stdout, canonicalContent)) {
      return yield* ShareOperationError.make({
        message: `Refusing to unpublish: shared canonical source does not match tracked Git content for ${safeRelativePath}. Sync or resolve the worktree conflict first.`,
      });
    }
  }
  const fs = yield* FileSystem.FileSystem;
  const targetPath = yield* pathJoin(worktree, ...Effect2.pipe(safeRelativePath, EffectString.split('/')));
  if (yield* fs.exists(targetPath)) {
    if (!tracked) {
      return yield* ShareOperationError.make({
        message: `Refusing to unpublish untracked shared worktree file: ${safeRelativePath}.`,
      });
    }
    if (Option.isSome(yield* fs.readLink(targetPath).pipe(Effect.option))) {
      return yield* ShareOperationError.make({
        message: `Refusing to unpublish shared worktree symbolic link: ${targetPath}`,
      });
    }
    const info = yield* fs.stat(targetPath);
    if (info.type !== 'File') {
      return yield* ShareOperationError.make({message: `Shared worktree source is not a regular file: ${targetPath}`});
    }
    const worktreeContent = yield* fs.readFileString(targetPath);
    if (!sharedMemoryContentsEquivalent(worktreeContent, canonicalContent)) {
      return yield* ShareOperationError.make({
        message: `Refusing to unpublish: shared canonical source does not match worktree file ${safeRelativePath}. Sync or resolve the worktree conflict first.`,
      });
    }
    return 'present' as const;
  }

  if (tracked) return 'tracked-missing' as const;

  if (allowAlreadyRemoved) return 'already-removed' as const;
  return yield* ShareOperationError.make({
    message: `Refusing to unpublish: shared worktree file ${safeRelativePath} is already removed, but no byte-identical personal target exists to resume cleanup.`,
  });
});

export const runShareList = Effect.fn('share.runShareList')(function* (
  config: ShareRuntime,
  _options: ShareListOptions,
) {
  const teams = yield* readTeamsFile(config);
  const entries = EffectRecord.values(teams.teams);
  if (entries.length === 0) {
    yield* Console.log('No shared teams configured. Run: threadnote share init <remote-url>');
    return;
  }
  for (const team of entries) {
    const marker = team.name === teams.defaultTeam ? ' (default)' : '';
    yield* Console.log(`- ${team.name}${marker}`);
    yield* Console.log(`    remote: ${team.remote}`);
    yield* Console.log(`    access: ${shareTeamAccess(team)}`);
    yield* Console.log(`    worktree: ${yield* portablePath(team.worktree)}`);
    yield* Console.log(`    gitdir: ${yield* portablePath(team.gitdir)}`);
    yield* Console.log(`    added: ${team.addedAt}`);
  }
});

export const runShareRename = Effect.fn('share.runShareRename')(function* (
  config: ShareRuntime,
  options: ShareRenameOptions,
) {
  const oldTeam = yield* resolveTeam(config, options.team);
  const newName = normalizeTeamName(options.to);
  if (newName === oldTeam.name) {
    throw ShareOperationError.make({message: `Team is already named "${newName}".`});
  }
  const dryRun = options.dryRun === true;
  const teamsFile = yield* readTeamsFile(config);
  if (teamsFile.teams[newName]) {
    throw ShareOperationError.make({message: `Team "${newName}" is already configured.`});
  }

  const newWorktree = yield* teamWorktreePath(config, newName);
  const newGitdir = yield* teamGitdirPath(config, newName);
  yield* assertDestinationAbsent(newWorktree, 'worktree');
  yield* assertDestinationAbsent(newGitdir, 'gitdir');
  const updatedTeam: ShareTeamConfig = {
    ...oldTeam.config,
    gitdir: newGitdir,
    name: newName,
    worktree: newWorktree,
  };
  const updatedTeams: Record<string, ShareTeamConfig> = {};
  for (const [name, value] of EffectRecord.toEntries(teamsFile.teams)) {
    if (name === oldTeam.name) {
      updatedTeams[newName] = updatedTeam;
    } else {
      updatedTeams[name] = value;
    }
  }
  const updatedFile: ShareTeamsFile = {
    defaultTeam: teamsFile.defaultTeam === oldTeam.name ? newName : teamsFile.defaultTeam,
    teams: updatedTeams,
    version: TEAMS_FILE_VERSION,
  };

  if (dryRun) {
    yield* Console.log(
      `Would rename worktree: ${yield* portablePath(oldTeam.config.worktree)} -> ${yield* portablePath(newWorktree)}`,
    );
    yield* Console.log(
      `Would rename gitdir: ${yield* portablePath(oldTeam.config.gitdir)} -> ${yield* portablePath(newGitdir)}`,
    );
    yield* Console.log(`Would update git core.worktree and the worktree .git pointer for team "${newName}".`);
    yield* Console.log(`Would reindex shared context under team "${newName}" and remove old shared URI tree.`);
    yield* Console.log(`Would write teams file: ${yield* teamsFilePath(config)}`);
    return;
  }

  const git = yield* requiredExecutable('git');
  yield* mkdir(yield* pathDirname(newWorktree), {recursive: true});
  yield* mkdir(yield* pathDirname(newGitdir), {recursive: true});
  // A clone made with --separate-git-dir has a .git file in the worktree that
  // points at the external gitdir. Moving both paths first leaves that pointer
  // aimed at the old location, so `git -C <new-worktree>` can no longer open
  // the repository. Update the gitdir config before moving it, then rewrite
  // the pointer after both renames. Roll back the filesystem pair if any of
  // those steps fail so teams.json never advertises a half-renamed checkout.
  yield* runCommand(git, ['--git-dir', oldTeam.config.gitdir, 'config', 'core.worktree', newWorktree]);
  let movedWorktree = false;
  let movedGitdir = false;
  const renameResult = yield* Effect.result(
    Effect.gen(function* () {
      yield* rename(oldTeam.config.worktree, newWorktree);
      movedWorktree = true;
      yield* rename(oldTeam.config.gitdir, newGitdir);
      movedGitdir = true;
      yield* writeFile(yield* pathJoin(newWorktree, '.git'), `gitdir: ${newGitdir}\n`, 'utf8');
      yield* runCommand(git, ['--git-dir', newGitdir, '--work-tree', newWorktree, 'rev-parse', '--show-toplevel']);
      yield* writeTeamsFile(config, updatedFile);
    }),
  );
  if (Result.isFailure(renameResult)) {
    if (movedGitdir && (yield* exists(newGitdir))) {
      yield* rename(newGitdir, oldTeam.config.gitdir).pipe(Effect.ignore);
    }
    if (movedWorktree && (yield* exists(newWorktree))) {
      yield* writeFile(yield* pathJoin(newWorktree, '.git'), `gitdir: ${oldTeam.config.gitdir}\n`, 'utf8').pipe(
        Effect.ignore,
      );
      yield* rename(newWorktree, oldTeam.config.worktree).pipe(Effect.ignore);
    }
    if (yield* exists(oldTeam.config.gitdir)) {
      yield* runCommand(git, ['--git-dir', oldTeam.config.gitdir, 'config', 'core.worktree', oldTeam.config.worktree], {
        allowFailure: true,
      });
    }
    return yield* renameResult.failure;
  }
  const ov = NATIVE_RESOURCE_BACKEND;
  const oldSharedRoot = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${oldTeam.name}`;
  yield* Console.log(`Renamed shared team "${oldTeam.name}" -> "${newName}".`);
  const ingestResult = yield* Effect.result(ingestSharedWorktree(config, updatedTeam));
  if (Result.isFailure(ingestResult)) {
    yield* Console.warn(
      `The rename is committed, but shared-context reindex did not complete. The old namespace was retained. Retry: threadnote share sync --team ${newName}`,
    );
    return;
  }
  yield* Console.log(`Reindexed ${ingestResult.success} shared file(s).`);
  const cleanupResult = yield* Effect.result(removeMemoryUri(config, ov, oldSharedRoot, false, {recursive: true}));
  if (Result.isFailure(cleanupResult)) {
    yield* Console.warn(
      `The rename is committed and the new namespace is ready, but old shared-context cleanup did not complete. Retry: threadnote forget ${oldSharedRoot}`,
    );
  }
});

export const runShareSetUrl = Effect.fn('share.runShareSetUrl')(function* (
  config: ShareRuntime,
  remoteUrl: string,
  options: ShareSetUrlOptions,
) {
  if (!Effect2.pipe(remoteUrl, EffectString.trim)) {
    throw ShareOperationError.make({message: 'Provide a git remote URL.'});
  }
  const team = yield* resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  const git = yield* requiredExecutable('git');
  if (dryRun) {
    yield* Console.log(
      `Would run: ${formatShellCommand(git, ['-C', team.config.worktree, 'remote', 'set-url', DEFAULT_GIT_REMOTE_NAME, '--', remoteUrl])}`,
    );
    yield* Console.log(
      `Would run: ${formatShellCommand(git, ['-C', team.config.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME])}`,
    );
    yield* Console.log(`Would write teams file: ${teamsFilePath(config)}`);
    return;
  }
  yield* runCommand(git, ['-C', team.config.worktree, 'remote', 'set-url', DEFAULT_GIT_REMOTE_NAME, '--', remoteUrl]);
  yield* runCommand(git, ['-C', team.config.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME]);
  const teamsFile = yield* readTeamsFile(config);
  const updatedTeam: ShareTeamConfig = {...team.config, remote: remoteUrl};
  yield* writeTeamsFile(config, {
    ...teamsFile,
    teams: {...teamsFile.teams, [team.name]: updatedTeam},
  });
  yield* Console.log(`Updated shared team "${team.name}" remote: ${remoteUrl}`);
});

export const runShareSetAccess = Effect.fn('share.runShareSetAccess')(function* (
  config: ShareRuntime,
  options: ShareSetAccessOptions,
) {
  const team = yield* resolveTeam(config, options.team);
  const mode = options.mode;
  if (mode !== 'read-only' && mode !== 'read-write') {
    throw ShareOperationError.make({message: 'Choose a shared-team access mode: read-only or read-write.'});
  }
  const current = shareTeamAccess(team.config);
  if (current === mode) {
    yield* Console.log(`Shared team "${team.name}" is already ${mode}.`);
    return;
  }
  if (options.dryRun === true) {
    yield* Console.log(`Would set shared team "${team.name}" access: ${current} -> ${mode}`);
    return;
  }
  const teamsFile = yield* readTeamsFile(config);
  yield* writeTeamsFile(config, {
    ...teamsFile,
    teams: {...teamsFile.teams, [team.name]: {...team.config, access: mode}},
  });
  yield* Console.log(`Set shared team "${team.name}" access: ${mode}`);
});

export const runShareRemove = Effect.fn('share.runShareRemove')(function* (
  config: ShareRuntime,
  options: ShareRemoveOptions,
) {
  const team = yield* resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  const sharedRoot = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team.name}`;
  if (options.preserveLocal === true) {
    const preserved = yield* preserveSharedMemoriesLocally(config, team.config, dryRun);
    yield* Console.log(
      `${dryRun ? 'Would preserve' : 'Preserved'} ${preserved} shared durable memory file(s) locally.`,
    );
  }
  const teamsFile = yield* readTeamsFile(config);
  const remaining: Record<string, ShareTeamConfig> = {};
  for (const [name, value] of EffectRecord.toEntries(teamsFile.teams)) {
    if (name !== team.name) {
      remaining[name] = value;
    }
  }
  const remainingNames = EffectRecord.keys(remaining);
  const nextDefault = teamsFile.defaultTeam === team.name ? remainingNames[0] : teamsFile.defaultTeam;
  const updated: ShareTeamsFile = {defaultTeam: nextDefault, teams: remaining, version: TEAMS_FILE_VERSION};
  if (dryRun) {
    yield* Console.log(`Would update teams file: ${teamsFilePath(config)}`);
    yield* removeMemoryUri(config, NATIVE_RESOURCE_BACKEND, sharedRoot, true, {recursive: true});
  } else {
    yield* writeTeamsFile(config, updated);
    yield* Console.log(`Removed team "${team.name}" from teams.json.`);
    const cleanupResult = yield* Effect.result(
      removeMemoryUri(config, NATIVE_RESOURCE_BACKEND, sharedRoot, false, {recursive: true}),
    );
    if (Result.isFailure(cleanupResult)) {
      yield* Console.warn(
        `Team "${team.name}" is removed from configuration, but its canonical shared-context cleanup did not complete. Retry: threadnote forget ${sharedRoot}`,
      );
    }
  }
  if (options.keepFiles !== true) {
    if (dryRun) {
      yield* removePath(team.config.worktree, 'shared worktree', true);
      yield* removePath(team.config.gitdir, 'shared gitdir', true);
    } else {
      const worktreeCleanup = yield* Effect.result(removePath(team.config.worktree, 'shared worktree', false));
      if (Result.isFailure(worktreeCleanup)) {
        yield* Console.warn(
          `Team "${team.name}" is removed from configuration, but its shared worktree cleanup did not complete. Remove it manually after confirming no work is needed.`,
        );
      }
      const gitdirCleanup = yield* Effect.result(removePath(team.config.gitdir, 'shared gitdir', false));
      if (Result.isFailure(gitdirCleanup)) {
        yield* Console.warn(
          `Team "${team.name}" is removed from configuration, but its shared gitdir cleanup did not complete. Remove it manually after confirming no work is needed.`,
        );
      }
    }
  } else {
    yield* Console.log(
      `Keeping files at ${yield* portablePath(team.config.worktree)} and ${yield* portablePath(team.config.gitdir)}`,
    );
  }
});

const assertDestinationAbsent = Effect.fn('share.assertDestinationAbsent')(function* (path: string, label: string) {
  if (yield* exists(path)) {
    throw ShareOperationError.make({message: `Cannot rename share: destination ${label} already exists at ${path}.`});
  }
});

const preserveSharedMemoriesLocally = Effect.fn('share.preserveSharedMemoriesLocally')(function* (
  config: ShareRuntime,
  team: ShareTeamConfig,
  dryRun: boolean,
) {
  const ov = NATIVE_RESOURCE_BACKEND;
  const files = yield* walkMemoryFiles(team.worktree);
  const store = yield* ResourceStore;
  const planned: Array<{
    readonly content: string;
    readonly disposition: 'create' | 'resume';
    readonly rel: string;
    readonly targetUri: string;
  }> = [];
  for (const file of files) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
    const rel = EffectArray.join((yield* pathRelative(team.worktree, file)).split(yield* pathSeparator), '/');
    if (!Effect2.pipe(rel, EffectString.startsWith('durable/'))) {
      continue;
    }
    const targetUri = `threadnote://user/${uriSegment(config.user)}/memories/${rel}`;
    const content = setMemoryVisibility(yield* readFile(file, 'utf8'), 'personal');
    const existing = yield* store.read(resourceStoreLocation(config), targetUri).pipe(
      Effect.asSome,
      Effect.catchTag('ResourceNotFound', () => Effect.succeedNone),
    );
    if (Option.isSome(existing) && !sharedMemoryContentsEquivalent(existing.value, content)) {
      return yield* ShareOperationError.make({
        message: `Refusing to remove share: a different personal memory already exists at ${targetUri}. Move or forget it first, then retry.`,
      });
    }
    planned.push({
      content,
      disposition: Option.isSome(existing) ? 'resume' : 'create',
      rel,
      targetUri,
    });
  }
  for (const item of planned) {
    if (dryRun) {
      yield* Console.log(`Would preserve ${item.rel} -> ${item.targetUri} --mode ${item.disposition}`);
    } else if (item.disposition === 'create') {
      yield* ensurePersonalDirectoryChain(config, ov, parentUri(item.targetUri));
      yield* writeMemoryFile(config, ov, item.targetUri, item.content, 'create', false);
    } else {
      yield* Console.log(`Personal memory already preserved: ${item.targetUri}`);
    }
  }
  return planned.length;
});

const ensurePersonalDirectoryChain = Effect.fn('share.ensurePersonalDirectoryChain')(function* (
  config: ShareRuntime,
  _ov: string,
  directoryUri: string,
) {
  const store = yield* ResourceStore;
  const prefix = 'threadnote://';
  const parts = Effect2.pipe(directoryUri, EffectString.startsWith(prefix))
    ? EffectArray.filter(
        Effect2.pipe(directoryUri, EffectString.slice(prefix.length), EffectString.split('/')),
        Boolean,
      )
    : [];
  const startIndex = parts[0] === 'user' && parts.length > 2 ? 3 : 1;
  for (let index = startIndex; index <= parts.length; index += 1) {
    const uri = `${prefix}${EffectArray.join(parts.slice(0, index), '/')}`;
    yield* store.makeDirectory(resourceStoreLocation(config), uri);
  }
});
