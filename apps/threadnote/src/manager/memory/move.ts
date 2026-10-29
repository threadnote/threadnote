import {Effect, FileSystem, Path} from 'effect';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {withSharedRepositoryLock} from '../../effect/share/lock.js';
import {readMemoryRecordsByUri, storeMemory} from '../../memory/index.js';
import {assertMemoryRecordArchivable, formatMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import type {MemoryRecord} from '@threadnote/memory/hygiene';
import {
  memoryCodeCitationSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {hasDeferredCodeAnchorIntent} from '../../memory/deferred/code_anchor.js';
import {recordMemoryRelocation} from '@threadnote/memory/relocation';
import {
  localMemoryPathForUri,
  MemoryOperationError,
  NATIVE_RESOURCE_BACKEND,
  readTextIfExists,
} from '../../memory/migrations.js';
import {applyScrubber} from '@threadnote/platform/scrubber';
import {
  assertSharedWorktreeFileReady,
  ensureSharedDirectoryChain,
  isInSharedNamespace,
  publishShareGitChange,
  removeMemoryUri,
  resolveTeam,
  resourceUriToWorktreeRelative,
  runSharePublish as runSharePublishUnlocked,
  sharedMemoryUriParts,
  sharedTeamNameForUri,
  sharedUriFor,
  writeMemoryFile,
  writeSharedWorktreeFile,
} from '../../share/index.js';
import type {MemoryKind, MemoryStatus} from '@threadnote/memory/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runCommand} from '../../utils.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface ManagerMemoryMoveTarget {
  readonly kind: MemoryKind;
  readonly project: string;
  readonly sourceAgentClient: string;
  readonly status: MemoryStatus;
  readonly topic: string;
}

/** Reformat a personal destination while retaining immutable citation and source provenance. */
export const storeManagerPersonalMemoryMove = Effect.fn('manager.storePersonalMemoryMove')(function* (
  config: RuntimeConfig,
  sourceUri: string,
  expectedSourceContent: string,
  target: ManagerMemoryMoveTarget,
  removePersonalSource: boolean,
) {
  const source = yield* readExactMoveSource(
    config,
    sourceUri,
    expectedSourceContent,
    'while its move was being prepared',
  );
  yield* validateArchivable(source);
  const metadata: MemoryMetadata = {
    ...source.metadata,
    kind: target.kind,
    project: target.project,
    sourceAgentClient: target.sourceAgentClient,
    status: target.status,
    topic: target.topic,
    visibility: 'personal',
  };
  return yield* storeMemory(config, {
    bodyText: source.body,
    dryRun: false,
    // Pair the canonical parser guard with an exact raw-byte CAS under
    // storeMemory's mutation lock so terminal-newline changes cannot race.
    expectedReplaceContent: source.content,
    expectedReplaceRawContent: expectedSourceContent,
    metadata,
    ...(removePersonalSource ? {replaceUri: sourceUri} : {}),
    title: target.kind === 'handoff' ? 'HANDOFF' : 'MEMORY',
  });
});

/** Move a shared memory within one team while preserving citations and checking both storage copies. */
export const moveManagerSharedMemoryWithinTeam = Effect.fn('manager.moveSharedMemoryWithinTeam')(function* (
  config: RuntimeConfig,
  sourceUri: string,
  targetUri: string,
  expectedSourceContent: string,
  teamName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [sourceUri, targetUri],
    Effect.gen(function* () {
      const source = yield* readExactMoveSource(
        config,
        sourceUri,
        expectedSourceContent,
        'while its move was being prepared',
      );
      yield* validateArchivable(source);
      const content = yield* prepareSharedMoveContent(config, targetUri, source);
      const team = yield* resolveTeam(config, teamName);
      const sourceRelativePath = resourceUriToWorktreeRelative(config, sourceUri, team.name);
      const targetRelativePath = resourceUriToWorktreeRelative(config, targetUri, team.name);
      yield* assertSharedWorktreeFileReady(team.config.worktree, sourceRelativePath, expectedSourceContent);
      yield* assertSharedWorktreeFileReady(team.config.worktree, targetRelativePath, content);
      const existingTarget = yield* readRawMemoryContent(config, targetUri);
      if (existingTarget !== undefined && existingTarget !== content) {
        return yield* MemoryOperationError.make({message: `${targetUri} already exists with different content.`});
      }
      if (existingTarget === undefined) {
        yield* ensureSharedDirectoryChain(config, NATIVE_RESOURCE_BACKEND, targetUri, false);
        yield* writeMemoryFile(config, NATIVE_RESOURCE_BACKEND, targetUri, content, 'create', false);
      }
      const existingWorktreeTarget = yield* readSharedWorktreeFile(team.config.worktree, targetRelativePath);
      if (existingWorktreeTarget !== undefined && existingWorktreeTarget !== content) {
        return yield* MemoryOperationError.make({
          message: `Shared move target ${targetRelativePath} changed while recovery was being prepared.`,
        });
      }
      yield* writeSharedWorktreeFile(team.config.worktree, targetRelativePath, content);

      yield* assertExactSharedSourceOrRecoveryTarget(
        team.config.worktree,
        sourceRelativePath,
        expectedSourceContent,
        targetRelativePath,
        content,
      );
      const sourceWorktreePath = yield* sharedWorktreePath(team.config.worktree, sourceRelativePath);
      if (yield* fs.exists(sourceWorktreePath)) {
        yield* fs.remove(sourceWorktreePath);
      }

      // Stage both sides together so Git records one relocation commit. If a
      // prior attempt committed but failed before canonical cleanup, the source
      // is no longer tracked; publishing the target alone retries the push.
      const sourceTracked = yield* isGitTracked(team.config.worktree, sourceRelativePath);
      yield* publishShareGitChange(
        team.config.worktree,
        sourceTracked ? [sourceRelativePath, targetRelativePath] : targetRelativePath,
        `share: move ${sourceRelativePath} to ${targetRelativePath}`,
      );
      const sourceBeforeRemoval = yield* readExactMoveSource(
        config,
        sourceUri,
        expectedSourceContent,
        'during its move; it was preserved',
      );
      yield* recordMemoryRelocation(config, {
        fromContent: sourceBeforeRemoval.content,
        fromUri: sourceUri,
        toContent: content,
        toUri: targetUri,
      });
      yield* removeMemoryUri(config, NATIVE_RESOURCE_BACKEND, sourceUri, false);
    }),
  );
});

/** Remove a shared source only if it still matches the version copied to a personal destination. */
export const removeManagerSharedMemorySource = Effect.fn('manager.removeSharedMemorySource')(function* (
  config: RuntimeConfig,
  sourceUri: string,
  expectedSourceContent: string,
  targetUri: string,
  expectedTargetContent: string,
) {
  const teamName = sharedTeamNameForUri(config, sourceUri);
  if (!teamName) return yield* MemoryOperationError.make({message: `${sourceUri} is not a shared memory.`});
  const fs = yield* FileSystem.FileSystem;
  return yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [sourceUri, targetUri],
    Effect.gen(function* () {
      const source = yield* readExactMoveSource(
        config,
        sourceUri,
        expectedSourceContent,
        'during its move; it was preserved',
      );
      yield* validateArchivable(source);
      yield* readExactMoveSource(
        config,
        targetUri,
        expectedTargetContent,
        'before shared source removal; the shared source was preserved',
      );
      const team = yield* resolveTeam(config, teamName);
      const relativePath = resourceUriToWorktreeRelative(config, sourceUri, team.name);
      yield* assertSharedWorktreeFileReady(team.config.worktree, relativePath, expectedSourceContent);
      if ((yield* readSharedWorktreeFile(team.config.worktree, relativePath)) !== expectedSourceContent) {
        return yield* MemoryOperationError.make({
          message: `Shared move source ${relativePath} changed before removal; it was preserved.`,
        });
      }
      yield* publishShareGitChange(team.config.worktree, relativePath, `share: remove ${relativePath}`, {verb: 'rm'});
      const target = yield* readExactMoveSource(
        config,
        targetUri,
        expectedTargetContent,
        'during its move; the shared source was preserved',
      );
      yield* recordMemoryRelocation(config, {
        fromContent: source.content,
        fromUri: sourceUri,
        toContent: target.content,
        toUri: targetUri,
      });
      yield* removeMemoryUri(config, NATIVE_RESOURCE_BACKEND, sourceUri, false);
    }),
  );
});

/** Remove a personal move source only when its raw bytes still match the staged copy. */
export const removeManagerPersonalMemorySource = Effect.fn('manager.removePersonalMemorySource')(function* (
  config: RuntimeConfig,
  sourceUri: string,
  expectedSourceContent: string,
) {
  if (isInSharedNamespace(config, sourceUri)) {
    return yield* MemoryOperationError.make({message: `${sourceUri} is not a personal memory.`});
  }
  const fs = yield* FileSystem.FileSystem;
  return yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [sourceUri],
    Effect.gen(function* () {
      const source = yield* readExactMoveSource(
        config,
        sourceUri,
        expectedSourceContent,
        'during its move; it was preserved',
      );
      yield* validateArchivable(source);
      yield* removeMemoryUri(config, NATIVE_RESOURCE_BACKEND, sourceUri, false);
    }),
  );
});

/** Publish a staged personal move while fencing its original and both destinations. */
export const publishStagedManagerPersonalMemoryMove = Effect.fn('manager.publishStagedPersonalMemoryMove')(function* (
  config: RuntimeConfig,
  sourceUri: string,
  expectedSourceContent: string,
  stagedUri: string,
  expectedStagedContent: string,
  teamName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const sharedTargetUri = sharedUriFor(config, stagedUri, teamName);
  return yield* withSharedRepositoryLock(
    config,
    withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [sourceUri, stagedUri, sharedTargetUri],
      Effect.gen(function* () {
        if (yield* hasDeferredCodeAnchorIntent(config, sourceUri)) {
          return yield* MemoryOperationError.make({
            message: `Refusing to publish moved memory ${sourceUri}: code citations are still pending. Finalize or explicitly replace the source without code references before moving it into shared memory.`,
          });
        }
        yield* readExactMoveSource(config, sourceUri, expectedSourceContent, 'before publication; it was preserved');
        yield* readExactMoveSource(config, stagedUri, expectedStagedContent, 'before publication');
        yield* runSharePublishUnlocked(config, stagedUri, {team: teamName});
        const sourceBeforeRemoval = yield* readExactMoveSource(
          config,
          sourceUri,
          expectedSourceContent,
          'during publication; it was preserved',
        );
        const sharedTargetContent = yield* readRawMemoryContent(config, sharedTargetUri);
        if (sharedTargetContent === undefined) {
          return yield* MemoryOperationError.make({
            message: `Published move target ${sharedTargetUri} is missing; source was preserved.`,
          });
        }
        yield* recordMemoryRelocation(config, {
          fromContent: sourceBeforeRemoval.content,
          fromUri: sourceUri,
          toContent: sharedTargetContent,
          toUri: sharedTargetUri,
        });
        yield* removeMemoryUri(config, NATIVE_RESOURCE_BACKEND, sourceUri, false);
      }),
    ),
  );
});

const readExactMoveSource = Effect.fn('manager.readExactMoveSource')(function* (
  config: RuntimeConfig,
  sourceUri: string,
  expectedSourceContent: string,
  phase: string,
) {
  const [source] = yield* readMemoryRecordsByUri(config, [sourceUri]);
  const rawSource = yield* readRawMemoryContent(config, sourceUri);
  if (!source || rawSource !== expectedSourceContent) {
    return yield* MemoryOperationError.make({message: `${sourceUri} changed ${phase}.`});
  }
  return source;
});

const readRawMemoryContent = Effect.fn('manager.readRawMoveMemory')(function* (config: RuntimeConfig, uri: string) {
  const path = yield* localMemoryPathForUri(config, uri);
  return path ? yield* readTextIfExists(path) : undefined;
});

const sharedWorktreePath = Effect.fn('manager.sharedMoveWorktreePath')(function* (
  worktree: string,
  relativePath: string,
) {
  const path = yield* Path.Path;
  return path.join(worktree, ...Effect2.pipe(relativePath, EffectString.split('/')));
});

const readSharedWorktreeFile = Effect.fn('manager.readSharedMoveWorktreeFile')(function* (
  worktree: string,
  relativePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* sharedWorktreePath(worktree, relativePath);
  return (yield* fs.exists(filePath)) ? yield* fs.readFileString(filePath) : undefined;
});

const assertExactSharedSourceOrRecoveryTarget = Effect.fn('manager.assertExactSharedMoveSource')(function* (
  worktree: string,
  sourceRelativePath: string,
  expectedSourceContent: string,
  targetRelativePath: string,
  expectedTargetContent: string,
) {
  const source = yield* readSharedWorktreeFile(worktree, sourceRelativePath);
  if (source !== undefined && source !== expectedSourceContent) {
    return yield* MemoryOperationError.make({
      message: `Shared move source ${sourceRelativePath} changed before removal; it was preserved.`,
    });
  }
  if (source === undefined && (yield* readSharedWorktreeFile(worktree, targetRelativePath)) !== expectedTargetContent) {
    return yield* MemoryOperationError.make({
      message: `Shared move source ${sourceRelativePath} disappeared before its target was durable.`,
    });
  }
});

const isGitTracked = Effect.fn('manager.isSharedMovePathTracked')(function* (worktree: string, relativePath: string) {
  const result = yield* runCommand('git', ['-C', worktree, 'ls-files', '--error-unmatch', '--', relativePath], {
    allowFailure: true,
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return yield* MemoryOperationError.make({
    message: `Could not inspect shared move source ${relativePath}: ${Effect2.pipe(result.stderr, EffectString.trim) || Effect2.pipe(result.stdout, EffectString.trim) || 'git ls-files failed'}.`,
  });
});

const validateArchivable = Effect.fn('manager.validateMoveSource')(function* (source: MemoryRecord) {
  return yield* Effect.try({
    catch: cause => MemoryOperationError.make({message: cause instanceof Error ? cause.message : String(cause)}),
    try: () => assertMemoryRecordArchivable(source),
  });
});

const prepareSharedMoveContent = Effect.fn('manager.prepareSharedMoveContent')(function* (
  config: RuntimeConfig,
  targetUri: string,
  source: MemoryRecord,
) {
  const address = sharedMemoryUriParts(config, targetUri);
  if (address?.kind !== 'durable' || !address.project || !address.topic) {
    return yield* MemoryOperationError.make({message: `${targetUri} is not a canonical shared durable memory URI.`});
  }
  const metadata: MemoryMetadata = {
    ...source.metadata,
    kind: 'durable',
    project: address.project,
    topic: address.topic,
    visibility: 'shared',
  };
  const citationBlocker = memoryCodeCitationSharingBlocker(metadata);
  if (citationBlocker) {
    return yield* MemoryOperationError.make({
      message: `Refusing to move shared memory ${targetUri}: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
    });
  }
  const scrub = applyScrubber(formatMemoryDocument('MEMORY', metadata, source.body), {redact: false});
  if (scrub.blocker) {
    return yield* MemoryOperationError.make({
      message: `Refusing to move shared memory ${targetUri}: possible ${scrub.blocker}.`,
    });
  }
  return scrub.cleaned;
});
