import {Console, Effect, FileSystem, Option, Path} from 'effect';

import {CommandExecutor} from '@threadnote/platform/command';

import {SystemInfo} from '@threadnote/platform/system';

import {canonicalMemoryDocumentContent} from '@threadnote/memory/document';

import {exists, formatShellCommand, isDirectory, isFile, maybeRun, requiredExecutable, runCommand} from '../utils.js';

import type {ChangedFile} from './core.js';

import {
  DEFAULT_GIT_REMOTE_NAME,
  PACK_INDEX_SUFFIX,
  PACK_MANIFEST_SUFFIX,
  SHAREABLE_ARTIFACT_DIR,
  SHAREABLE_ROOT_FILES,
  SHAREABLE_TOP_LEVEL_DIRS,
  ShareOperationError,
  assertSafeShareRelativePath,
  pathIsAbsolute,
  pathJoin,
  pathRelative,
  pathSeparator,
  readdir,
  rm,
} from './core.js';

const stageShareableChanges = Effect.fn('share.stageShareableChanges')(function* (
  dryRun: boolean,
  git: string,
  worktree: string,
) {
  // Stage repo guidance/metadata plus every shareable top-level dir.
  // native canonical store-generated summaries (.abstract.md, .overview.md) are excluded
  // via the repo's .gitignore (ensureSharedGitignore self-heals it on every
  // sync), so they never get staged even by an unscoped `git add`.
  // First drop any incomplete pack orphaned by a killed publish, so the blanket
  // `git add -A` below never commits a pack index without its manifest.
  yield* removeOrphanPackIndexes(dryRun, git, worktree);
  const pathspecs = yield* existingShareablePathspecs(git, worktree);
  if (pathspecs.length === 0) {
    return;
  }
  yield* maybeRun(dryRun, git, ['-C', worktree, 'add', '-A', '--', ...pathspecs], {allowFailure: true});
});

// A pack whose <name>.pack.md index exists but whose <name>.pack.json manifest
// is missing is an incomplete publish (e.g. interrupted by SIGKILL). Discovery
// already skips such packs; this removes the UNTRACKED leftover before staging so
// `git add -A` cannot commit/push it. Tracked trees are never touched.
const removeOrphanPackIndexes = Effect.fn('share.removeOrphanPackIndexes')(function* (
  dryRun: boolean,
  git: string,
  worktree: string,
) {
  const packsRoot = yield* pathJoin(worktree, SHAREABLE_ARTIFACT_DIR, 'packs');
  if (!(yield* isDirectory(packsRoot))) {
    return;
  }
  for (const agentEntry of yield* readdir(packsRoot, {withFileTypes: true})) {
    if (!agentEntry.isDirectory()) {
      continue;
    }
    const agentDir = yield* pathJoin(packsRoot, agentEntry.name);
    for (const nameEntry of yield* readdir(agentDir, {withFileTypes: true})) {
      if (!nameEntry.isDirectory()) {
        continue;
      }
      const packDir = yield* pathJoin(agentDir, nameEntry.name);
      const indexPath = yield* pathJoin(packDir, `${nameEntry.name}${PACK_INDEX_SUFFIX}`);
      const manifestPath = yield* pathJoin(packDir, `${nameEntry.name}${PACK_MANIFEST_SUFFIX}`);
      if (!(yield* isFile(indexPath)) || (yield* isFile(manifestPath))) {
        continue;
      }
      const indexRelative = (yield* pathRelative(worktree, indexPath)).split(yield* pathSeparator).join('/');
      const tracked = yield* runCommand(git, ['-C', worktree, 'ls-files', '--', indexRelative], {allowFailure: true});
      if (tracked.exitCode === 0 && tracked.stdout.trim().length > 0) {
        continue;
      }
      yield* Console.warn(
        `${dryRun ? 'Would remove' : 'Removing'} incomplete shared pack (missing ${nameEntry.name}${PACK_MANIFEST_SUFFIX}): ${indexRelative}`,
      );
      if (!dryRun) {
        yield* rm(packDir, {force: true, recursive: true});
      }
    }
  }
});

const existingShareablePathspecs = Effect.fn('share.existingShareablePathspecs')(function* (
  git: string,
  worktree: string,
) {
  const rootFiles = yield* Effect.forEach(
    SHAREABLE_ROOT_FILES,
    Effect.fn('share.callback')(function* (file) {
      return (yield* hasWorktreeOrTrackedPath(git, worktree, file)) ? `:(top)${file}` : undefined;
    }),
  );
  const topLevelDirs = yield* Effect.forEach(
    SHAREABLE_TOP_LEVEL_DIRS,
    Effect.fn('share.callback')(function* (dir) {
      return (yield* hasWorktreeOrTrackedPath(git, worktree, dir)) ? `:(top)${dir}` : undefined;
    }),
  );
  return [...rootFiles, ...topLevelDirs].filter((pathspec): pathspec is string => pathspec !== undefined);
});

const hasWorktreeOrTrackedPath = Effect.fn('share.hasWorktreeOrTrackedPath')(function* (
  git: string,
  worktree: string,
  relativePath: string,
) {
  if (yield* exists(yield* pathJoin(worktree, relativePath))) {
    return true;
  }
  const result = yield* runCommand(git, ['-C', worktree, 'ls-files', '--', relativePath], {allowFailure: true});
  return result.exitCode === 0 && result.stdout.trim().length > 0;
});

export const publishShareGitChange = Effect.fn('share.publishShareGitChange')(function* (
  worktree: string,
  relativePath: string | readonly string[],
  commitMessage: string,
  options: {
    readonly dryRun?: boolean;
    readonly ignoreMissingRemovePaths?: boolean;
    readonly push?: boolean;
    readonly verb?: 'add' | 'rm';
  } = {},
) {
  const dryRun = options.dryRun === true;
  const push = options.push !== false;
  const verb = options.verb ?? 'add';
  const git = yield* requiredExecutable('git');
  const messages: string[] = [];
  const paths = typeof relativePath === 'string' ? [relativePath] : [...relativePath];
  const stageArgs =
    verb === 'rm'
      ? [
          '-C',
          worktree,
          'rm',
          ...(options.ignoreMissingRemovePaths === true ? ['--ignore-unmatch'] : []),
          '--',
          ...paths,
        ]
      : ['-C', worktree, 'add', '--', ...paths];
  const stageResult = yield* runGitCommand(dryRun, git, stageArgs, `git ${verb} failed`);
  if (stageResult) {
    messages.push(`git ${verb}: ${stageResult.stdout.trim() || 'ok'}`);
  }

  if (dryRun) {
    yield* Console.log(`Would inspect requested paths staged by the planned git ${verb}.`);
    yield* Console.log(
      `Would commit only concrete staged requested paths with message: ${commitMessage}; would skip the commit when none remain.`,
    );
  } else {
    const staged = yield* runCommand(
      git,
      ['-C', worktree, 'diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD', '--', ...paths],
      {allowFailure: true},
    );
    if (staged.exitCode !== 0) {
      throw ShareOperationError.make({
        message: `Could not inspect staged shared changes: ${staged.stderr.trim() || staged.stdout.trim() || 'git diff failed'}`,
      });
    }
    const commitPaths = staged.stdout.split('\0').filter(Boolean);
    if (commitPaths.length === 0) {
      messages.push('git commit: nothing to commit (requested paths already absent)');
    } else {
      const commitResult = yield* runCommand(
        git,
        ['-C', worktree, 'commit', '-m', commitMessage, '--only', '--', ...commitPaths],
        {allowFailure: true},
      );
      if (commitResult.exitCode !== 0) {
        const detail = commitResult.stdout.trim() || commitResult.stderr.trim();
        if (/nothing to commit|no changes added/i.test(detail)) {
          messages.push('git commit: nothing to commit (file already in tree)');
        } else {
          throw ShareOperationError.make({message: `git commit failed: ${detail || 'unknown error'}`});
        }
      } else {
        messages.push(`git commit: ${commitResult.stdout.trim().split('\n').slice(0, 2).join(' ')}`);
      }
    }
  }

  if (!push) {
    messages.push('git push skipped (push=false)');
    return messages;
  }
  const pushResult = yield* runGitCommand(
    dryRun,
    git,
    ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME],
    'git push failed',
  );
  if (pushResult) {
    messages.push(`git push: ${pushResult.stdout.trim() || pushResult.stderr.trim() || 'ok'}`);
  }
  return messages;
});

export const writeSharedWorktreeFile = Effect.fn('share.writeSharedWorktreeFile')(function* (
  worktree: string,
  relativePath: string,
  content: string,
  dryRun = false,
) {
  const safeRelativePath = assertSafeShareRelativePath(relativePath);
  const targetPath = yield* pathJoin(worktree, ...safeRelativePath.split('/'));
  if (dryRun) {
    yield* Console.log(`Would write shared worktree file: ${targetPath}`);
    return targetPath;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const realWorktree = yield* fs.realPath(worktree);
  let current = path.resolve(worktree);
  for (const segment of safeRelativePath.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    if (Option.isSome(yield* fs.readLink(current).pipe(Effect.option))) {
      return yield* ShareOperationError.make({
        message: `Refusing to write through a shared worktree symbolic link: ${current}`,
      });
    }
    if (yield* fs.exists(current)) {
      const info = yield* fs.stat(current);
      if (info.type !== 'Directory') {
        return yield* ShareOperationError.make({message: `Shared worktree parent is not a directory: ${current}`});
      }
    } else {
      yield* fs.makeDirectory(current, {mode: 0o700});
    }
    const expected = path.resolve(realWorktree, path.relative(path.resolve(worktree), current));
    if ((yield* fs.realPath(current)) !== expected) {
      return yield* ShareOperationError.make({
        message: `Refusing to write through a shared worktree path alias: ${current}`,
      });
    }
  }
  if (Option.isSome(yield* fs.readLink(targetPath).pipe(Effect.option))) {
    return yield* ShareOperationError.make({
      message: `Refusing to replace a shared worktree symbolic link: ${targetPath}`,
    });
  }
  const temporaryPath = `${targetPath}.${system.processId}.tmp`;
  yield* fs.writeFileString(temporaryPath, content, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, targetPath)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
  return targetPath;
});

export function assertSharedWorktreeFileReady(
  worktree: string,
  relativePath: string,
  expectedContent: string | undefined,
  dryRun = false,
  contentEquivalent: (currentContent: string, expectedContent: string) => boolean = (currentContent, expected) =>
    canonicalMemoryDocumentContent(currentContent) === canonicalMemoryDocumentContent(expected),
  options: {
    readonly allowCleanTrackedReplacement?: boolean;
    readonly exactRetryContent?: string;
  } = {},
): Effect.Effect<string | undefined, unknown, CommandExecutor | FileSystem.FileSystem | Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    if (dryRun) return;
    const safeRelativePath = assertSafeShareRelativePath(relativePath);
    const git = yield* requiredExecutable('git');
    const unmerged = yield* runCommand(git, ['-C', worktree, 'ls-files', '-u', '--', safeRelativePath], {
      allowFailure: true,
    });
    if (unmerged.exitCode !== 0) {
      return yield* ShareOperationError.make({
        message: `Could not verify shared worktree state for ${safeRelativePath}: ${unmerged.stderr.trim() || unmerged.stdout.trim() || 'git ls-files failed'}.`,
      });
    }
    if (unmerged.stdout.trim().length > 0) {
      return yield* ShareOperationError.make({
        message: `Refusing to overwrite unmerged shared worktree file: ${safeRelativePath}. Resolve the conflict first.`,
      });
    }
    const fs = yield* FileSystem.FileSystem;
    let tracked = false;
    let dirty = false;
    if (options.allowCleanTrackedReplacement === true) {
      if (yield* isShareGitOperationInProgress(git, worktree)) {
        return yield* ShareOperationError.make({
          message: `Refusing to overwrite shared worktree file during an in-progress Git operation: ${safeRelativePath}. Resolve the operation first.`,
        });
      }
      const trackedResult = yield* runCommand(
        git,
        ['-C', worktree, 'ls-files', '--error-unmatch', '--', safeRelativePath],
        {allowFailure: true},
      );
      tracked = trackedResult.exitCode === 0 && trackedResult.stdout.trim().length > 0;
      const status = yield* runCommand(
        git,
        ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all', '--', safeRelativePath],
        {allowFailure: true},
      );
      if (status.exitCode !== 0) {
        return yield* ShareOperationError.make({
          message: `Could not verify shared worktree state for ${safeRelativePath}: ${status.stderr.trim() || status.stdout.trim() || 'git status failed'}.`,
        });
      }
      dirty = status.stdout.trim().length > 0;
    }
    const targetPath = yield* pathJoin(worktree, ...safeRelativePath.split('/'));
    if (!(yield* fs.exists(targetPath))) {
      if (options.allowCleanTrackedReplacement !== true || (!tracked && !dirty)) return;
      return yield* ShareOperationError.make({
        message: `Refusing to overwrite changed shared worktree file: ${safeRelativePath}. Sync or resolve the worktree conflict first.`,
      });
    }
    if (Option.isSome(yield* fs.readLink(targetPath).pipe(Effect.option))) {
      return yield* ShareOperationError.make({
        message: `Refusing to replace a shared worktree symbolic link: ${targetPath}`,
      });
    }
    const info = yield* fs.stat(targetPath);
    if (info.type !== 'File') {
      return yield* ShareOperationError.make({message: `Shared worktree target is not a regular file: ${targetPath}`});
    }
    const currentContent = yield* fs.readFileString(targetPath);
    if (options.exactRetryContent !== undefined && options.allowCleanTrackedReplacement === true) {
      if (tracked && !dirty) return;
      if (tracked && dirty) {
        const index = yield* runCommand(git, ['-C', worktree, 'show', `:${safeRelativePath}`], {allowFailure: true});
        const allowed = (content: string) =>
          (expectedContent !== undefined && contentEquivalent(content, expectedContent)) ||
          contentEquivalent(content, options.exactRetryContent!);
        if (index.exitCode === 0 && allowed(currentContent) && allowed(index.stdout)) return;
      }
      return yield* ShareOperationError.make({
        message: `Refusing to overwrite changed shared worktree file: ${safeRelativePath}. Sync or resolve the worktree conflict first.`,
      });
    }
    if (expectedContent !== undefined && contentEquivalent(currentContent, expectedContent)) return;
    if (expectedContent === undefined && options.allowCleanTrackedReplacement === true && tracked && !dirty) {
      return currentContent;
    }
    return yield* ShareOperationError.make({
      message: `Refusing to overwrite changed shared worktree file: ${safeRelativePath}. Sync or resolve the worktree conflict first.`,
    });
  });
}

const runGitCommand = Effect.fn('share.runGitCommand')(function* (
  dryRun: boolean,
  git: string,
  args: readonly string[],
  failureLabel: string,
) {
  if (dryRun) {
    yield* Console.log(`Would run: ${formatShellCommand(git, args)}`);
    return undefined;
  }
  const result = yield* runCommand(git, args, {allowFailure: true});
  if (result.exitCode !== 0) {
    throw ShareOperationError.make({
      message: `${failureLabel}: ${result.stderr.trim() || result.stdout.trim() || 'unknown error'}`,
    });
  }
  return result;
});

const hasUncommittedChanges = Effect.fn('share.hasUncommittedChanges')(function* (worktree: string) {
  // Read-only check; always run, even in dry-run, so the preamble reflects
  // what a non-dry-run sync would actually have to commit.
  const result = yield* runCommand('git', ['-C', worktree, 'status', '--porcelain'], {allowFailure: true});
  return result.stdout.trim().length > 0;
});

const restoreTrackedSharedChanges = Effect.fn('share.restoreTrackedSharedChanges')(function* (
  git: string,
  worktree: string,
) {
  const pathspecs = yield* existingShareablePathspecs(git, worktree);
  if (pathspecs.length === 0) {
    return [];
  }
  const changed = yield* runCommand(
    git,
    ['-C', worktree, 'diff', '--name-only', '--no-renames', '-z', 'HEAD', '--', ...pathspecs],
    {allowFailure: true},
  );
  if (changed.exitCode !== 0) {
    throw ShareOperationError.make({
      message: `Could not inspect tracked shared changes in ${worktree}: ${changed.stderr.trim() || changed.stdout.trim() || 'unknown git diff error'}`,
    });
  }
  const relativePaths = [...new Set(changed.stdout.split('\0').filter(Boolean))];
  if (relativePaths.length === 0) {
    return [];
  }
  const restored = yield* runCommand(
    git,
    ['-C', worktree, 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...pathspecs],
    {allowFailure: true},
  );
  if (restored.exitCode !== 0) {
    throw ShareOperationError.make({
      message: `Could not restore tracked shared changes in ${worktree}: ${restored.stderr.trim() || restored.stdout.trim() || 'unknown git restore error'}`,
    });
  }
  return relativePaths;
});

const SHARE_GIT_OPERATION_MARKERS = [
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'sequencer',
] as const;

const isShareGitOperationInProgress = Effect.fn('share.isShareGitOperationInProgress')(function* (
  git: string,
  worktree: string,
) {
  const args = ['-C', worktree, 'rev-parse', ...SHARE_GIT_OPERATION_MARKERS.flatMap(marker => ['--git-path', marker])];
  const result = yield* runCommand(git, args, {allowFailure: true});
  if (result.exitCode !== 0) {
    return yield* ShareOperationError.make({
      message: `Could not inspect Git operation state in ${worktree}: ${result.stderr.trim() || result.stdout.trim() || 'unknown git rev-parse error'}`,
    });
  }
  const markerPaths = result.stdout.split(/\r?\n/).filter(Boolean);
  if (markerPaths.length !== SHARE_GIT_OPERATION_MARKERS.length) {
    return yield* ShareOperationError.make({
      message: `Could not inspect Git operation state in ${worktree}: git returned incomplete marker paths.`,
    });
  }
  for (const markerPath of markerPaths) {
    const absolutePath = (yield* pathIsAbsolute(markerPath)) ? markerPath : yield* pathJoin(worktree, markerPath);
    if (yield* exists(absolutePath)) {
      return true;
    }
  }
  return false;
});

/** Returns the trimmed stdout of `git -C <worktree> <args>` on success, or `undefined` on dry-run / non-zero exit. */
const gitOutput = Effect.fn('share.gitOutput')(function* (
  worktree: string,
  args: readonly string[],
  dryRun: boolean,
  timeoutMs?: number,
) {
  if (dryRun) {
    return undefined;
  }
  const result = yield* runCommand('git', ['-C', worktree, ...args], {
    allowFailure: true,
    ...(timeoutMs === undefined ? {} : {timeoutMs}),
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.trim();
});

const GIT_MODE_ABSENT = '000000';

// Git records symbolic links as mode 120000.
const GIT_MODE_SYMLINK = '120000';

export const listChangedFiles = Effect.fn('share.listChangedFiles')(function* (
  worktree: string,
  beforeRev: string,
  afterRev: string,
) {
  const result = yield* runCommand('git', ['-C', worktree, 'diff', '--raw', '-z', `${beforeRev}..${afterRev}`], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  const entries = result.stdout.split('\0').filter(part => part.length > 0);
  const changes: ChangedFile[] = [];
  for (let index = 0; index < entries.length;) {
    const raw = entries[index++];
    const match = raw.match(/^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*/);
    if (!match) {
      continue;
    }
    const [, oldMode, newMode, head] = match;
    if (head === 'R' || head === 'C') {
      const oldRel = entries[index];
      const newRel = entries[index + 1];
      if (oldRel) {
        changes.push({
          path: yield* pathJoin(worktree, oldRel),
          previousRevision: oldMode === GIT_MODE_SYMLINK ? undefined : beforeRev,
          relativePath: oldRel,
          status: 'removed',
        });
      }
      if (newRel && newMode !== GIT_MODE_SYMLINK) {
        changes.push({path: yield* pathJoin(worktree, newRel), relativePath: newRel, status: 'added'});
      }
      index += 2;
      continue;
    }
    const rel = entries[index];
    if (rel) {
      if (head === 'D') {
        changes.push({
          path: yield* pathJoin(worktree, rel),
          previousRevision: oldMode === GIT_MODE_SYMLINK ? undefined : beforeRev,
          relativePath: rel,
          status: 'removed',
        });
      } else if (newMode === GIT_MODE_SYMLINK) {
        if (oldMode !== GIT_MODE_ABSENT) {
          changes.push({
            path: yield* pathJoin(worktree, rel),
            previousRevision: oldMode === GIT_MODE_SYMLINK ? undefined : beforeRev,
            relativePath: rel,
            status: 'removed',
          });
        }
      } else {
        const status = head === 'A' ? 'added' : 'modified';
        changes.push({
          path: yield* pathJoin(worktree, rel),
          previousRevision: oldMode === GIT_MODE_ABSENT || oldMode === GIT_MODE_SYMLINK ? undefined : beforeRev,
          relativePath: rel,
          status,
        });
      }
    }
    index += 1;
  }
  return changes;
});

const gitFileContent = Effect.fn('share.gitFileContent')(function* (
  worktree: string,
  rev: string,
  relativePath: string,
) {
  const result = yield* runCommand('git', ['-C', worktree, 'show', `${rev}:${relativePath}`], {allowFailure: true});
  return result.exitCode === 0 ? result.stdout : undefined;
});

export function mergeChanges(...lists: ReadonlyArray<readonly ChangedFile[]>): readonly ChangedFile[] {
  const map = new Map<string, ChangedFile>();
  for (const list of lists) {
    for (const change of list) {
      map.set(change.relativePath, change);
    }
  }
  return [...map.values()];
}

export {
  gitFileContent,
  gitOutput,
  hasUncommittedChanges,
  isShareGitOperationInProgress,
  restoreTrackedSharedChanges,
  stageShareableChanges,
};
