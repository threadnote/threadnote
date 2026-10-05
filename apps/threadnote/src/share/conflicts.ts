import {Console, Effect, Result} from 'effect';

import {applyScrubber} from '@threadnote/platform/scrubber';
import {uriSegment} from '@threadnote/workspace/manifest';
import {classifyMemoryIdentityCandidates} from '@threadnote/recall/memory/identity';
import {loadRecallMemoryIdentities} from '@threadnote/recall/index';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {
  memoryCodeCitationContentSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';

import type {
  ShareConflictOptions,
  ShareConflictResolveOptions,
  ShareConflictShowOptions,
  ShareConflictTake,
  ShareRuntime,
} from '../types.js';

import {expandPath} from '@threadnote/platform/paths';
import {portablePath, safeTimestamp} from '../utils.js';

import type {ChangedFile, InspectedShareConflict, ResolvedTeam, ShareConflictSummary} from './core.js';

import {
  NATIVE_RESOURCE_BACKEND,
  SHAREABLE_MEMORY_KIND_DIRS,
  ShareOperationError,
  assertSafeShareRelativePath,
  assertSharedMemoryIdentityContinuity,
  assertShareTeamWritable,
  autoShareState,
  canonicalResourceInput,
  establishedSharedMemoryIdentity,
  ensureSharedDirectoryChain,
  isRegularFileNoSymlink,
  loadPendingReindexes,
  mkdir,
  pathJoin,
  prepareSharedInboundContentEffect,
  readFile,
  readMemoryContent,
  readSharedInboundFileContent,
  readTeamsFile,
  reconcileMissingSharedMemoryIdentity,
  removeMemoryUri,
  resolveTeam,
  resourceExistsStrict,
  resourceUriToWorktreeRelative,
  sharedMemoryIdentityConflict,
  sharedMemoryContentsEquivalent,
  sharedTeamNameForUri,
  stripPersonalProvenanceForSharedPublication,
  verifySharedMemoryIdentityContinuity,
  workfileToResourceUri,
  writeFile,
  writeMemoryFileChecked,
  writePendingReindexes,
} from './core.js';

import {
  assertSharedWorktreeFileReady,
  gitFileContent,
  gitOutput,
  publishShareGitChange,
  writeSharedWorktreeFile,
} from './git.js';

export const runShareConflicts = Effect.fn('share.runShareConflicts')(function* (
  config: ShareRuntime,
  options: ShareConflictOptions,
) {
  const conflicts = yield* listShareConflicts(config, options);
  if (conflicts.length === 0) {
    const team = options.team ? ` for team "${options.team}"` : '';
    yield* Console.log(`No pending shared memory conflicts${team}.`);
    return;
  }
  yield* Console.log(`Pending shared memory conflicts: ${conflicts.length}`);
  for (const conflict of conflicts) {
    yield* Console.log('');
    yield* Console.log(`${conflict.id}`);
    yield* Console.log(`  uri: ${conflict.uri}`);
    yield* Console.log(`  status: ${conflict.status}`);
    yield* Console.log(`  reason: ${conflict.reason}`);
    yield* Console.log(`  show: threadnote share conflict show ${conflict.id}`);
    if (shareConflictCanTakeShared(conflict)) {
      yield* Console.log(`  take shared: threadnote share conflict resolve ${conflict.id} --take shared`);
    }
    yield* Console.log(`  take local: threadnote share conflict resolve ${conflict.id} --take local`);
    yield* Console.log(`  merged file: threadnote share conflict resolve ${conflict.id} --from-file merged.md`);
  }
});

export const runShareConflictShow = Effect.fn('share.runShareConflictShow')(function* (
  config: ShareRuntime,
  reference: string,
  options: ShareConflictShowOptions,
) {
  const detail = yield* showShareConflict(config, reference, options);
  yield* Console.log(`Conflict: ${detail.id}`);
  yield* Console.log(`URI: ${detail.uri}`);
  yield* Console.log(`Status: ${detail.status}`);
  yield* Console.log(`Reason: ${detail.reason}`);
  yield* Console.log('');
  yield* Console.log(detail.diff);
  yield* Console.log('');
  yield* Console.log('Resolve:');
  for (const line of detail.resolutionGuidance) {
    yield* Console.log(`  ${line}`);
  }
});

export const runShareConflictResolve = Effect.fn('share.runShareConflictResolve')(function* (
  config: ShareRuntime,
  reference: string,
  options: ShareConflictResolveOptions,
) {
  const result = yield* resolveShareConflict(config, reference, options);
  for (const message of result.messages) {
    yield* Console.log(message);
  }
  if (result.backupPath) {
    yield* Console.log(`Backup: ${yield* portablePath(result.backupPath)}`);
  }
  for (const message of result.gitMessages) {
    yield* Console.log(message);
  }
  yield* Console.log(
    options.dryRun === true
      ? `Would resolve shared memory conflict: ${result.id}`
      : `Resolved shared memory conflict: ${result.id}`,
  );
});

export const listShareConflicts = Effect.fn('share.listShareConflicts')(function* (
  config: ShareRuntime,
  options: ShareConflictOptions = {},
) {
  const teams = yield* teamsForShareQuery(config, options.team);
  const state = autoShareState(config);
  yield* loadPendingReindexes(config, state);
  const summaries: ShareConflictSummary[] = [];
  for (const team of teams) {
    const pending = state.pendingReindexes.get(team.name) ?? [];
    for (const change of pending) {
      if (!isShareableMemoryChange(change)) {
        continue;
      }
      summaries.push(yield* buildShareConflictSummary(config, team, yield* normalizePendingChange(team, change)));
    }
  }
  return summaries;
});

export const showShareConflict = Effect.fn('share.showShareConflict')(function* (
  config: ShareRuntime,
  reference: string,
  options: ShareConflictShowOptions = {},
) {
  const conflict = yield* readPendingShareConflict(config, reference, options.team);
  const inspected = yield* inspectShareConflict(config, conflict.team, conflict.change);
  return {
    ...inspected,
    diff: formatShareConflictDiff(inspected),
    resolutionGuidance: shareConflictResolutionGuidance(inspected),
  };
});

export const resolveShareConflict = Effect.fn('share.resolveShareConflict')(function* (
  config: ShareRuntime,
  reference: string,
  options: ShareConflictResolveOptions,
) {
  const fromFile = options.fromFile?.trim();
  const mergedContent = options.mergedContent;
  const rawTake = options.take as string | undefined;
  if (rawTake !== undefined && rawTake !== 'shared' && rawTake !== 'local') {
    throw ShareOperationError.make({message: `Unsupported --take value "${rawTake}". Expected "shared" or "local".`});
  }
  const take = rawTake;
  if ((take ? 1 : 0) + (fromFile ? 1 : 0) + (mergedContent !== undefined ? 1 : 0) !== 1) {
    throw ShareOperationError.make({
      message:
        'Choose exactly one resolution: --take shared, --take local, --from-file <path>, or mergedContent via MCP.',
    });
  }
  const conflict = yield* readPendingShareConflict(config, reference, options.team);
  if (take !== 'shared') assertShareTeamWritable(conflict.team, 'publish conflict resolutions');
  const inspected = yield* inspectShareConflict(config, conflict.team, conflict.change);
  const dryRun = options.dryRun === true;
  const ov = NATIVE_RESOURCE_BACKEND;
  const messages: string[] = [];
  const gitMessages: string[] = [];
  const takeSharedPlan =
    take === 'shared' && inspected.status !== 'removed'
      ? yield* prepareTakeSharedPlan(config, conflict.team, inspected, options.push)
      : undefined;
  const backupPath = dryRun ? undefined : yield* backupShareConflict(config, inspected);

  if (take === 'shared') {
    if (inspected.status === 'removed') {
      if (inspected.hasLocalContent) {
        yield* removeMemoryUri(config, ov, inspected.uri, dryRun);
        messages.push(`${dryRun ? 'Would accept' : 'Accepted'} shared deletion for ${inspected.uri}.`);
      } else {
        messages.push(
          `Shared deletion ${dryRun ? 'is' : 'was'} already reflected in native canonical store for ${inspected.uri}.`,
        );
      }
    } else {
      if (!takeSharedPlan) throw ShareOperationError.make({message: `Cannot take shared for ${inspected.id}.`});
      if (takeSharedPlan.writeWorktree) {
        yield* writeSharedConflictFile(conflict.team, inspected, takeSharedPlan.acceptedContent, dryRun);
      }
      yield* ensureSharedDirectoryChain(config, ov, inspected.uri, dryRun);
      yield* writeMemoryFileChecked(
        config,
        ov,
        inspected.uri,
        takeSharedPlan.acceptedContent,
        inspected.hasLocalContent ? 'replace' : 'create',
        dryRun,
        verifySharedMemoryIdentityContinuity(config, inspected.uri, takeSharedPlan.acceptedContent),
      );
      if (takeSharedPlan.publishIdentityRepair) {
        gitMessages.push(
          ...(yield* publishShareGitChange(
            conflict.team.config.worktree,
            inspected.relativePath,
            `share: repair identity ${inspected.relativePath}`,
            {
              dryRun,
              push: options.push,
            },
          )),
        );
      }
      messages.push(`${dryRun ? 'Would accept' : 'Accepted'} shared file content for ${inspected.uri}.`);
    }
  } else {
    const content = yield* conflictResolutionContent(inspected, take, fromFile, mergedContent);
    if (inspected.localContent !== undefined) {
      assertSharedMemoryIdentityContinuity(inspected.uri, inspected.localContent, content);
    }
    yield* writeSharedConflictFile(conflict.team, inspected, content, dryRun);
    yield* ensureSharedDirectoryChain(config, ov, inspected.uri, dryRun);
    yield* writeMemoryFileChecked(
      config,
      ov,
      inspected.uri,
      content,
      inspected.hasLocalContent ? 'replace' : 'create',
      dryRun,
      verifySharedMemoryIdentityContinuity(config, inspected.uri, content),
    );
    const message = options.message ?? `share: resolve ${inspected.relativePath}`;
    gitMessages.push(
      ...(yield* publishShareGitChange(conflict.team.config.worktree, inspected.relativePath, message, {
        dryRun,
        push: options.push,
      })),
    );
    messages.push(
      take === 'local'
        ? `${dryRun ? 'Would publish' : 'Published'} local native canonical store content for ${inspected.uri}.`
        : `${dryRun ? 'Would apply' : 'Applied'} merged content for ${inspected.uri}.`,
    );
  }

  if (!dryRun) {
    yield* clearPendingShareConflict(config, conflict.team.name, inspected.relativePath);
  }
  return {backupPath, gitMessages, id: inspected.id, messages, team: inspected.team, uri: inspected.uri};
});

interface TakeSharedPlan {
  readonly acceptedContent: string;
  readonly publishIdentityRepair: boolean;
  readonly writeWorktree: boolean;
}

const prepareTakeSharedPlan = Effect.fn('share.prepareTakeSharedPlan')(function* (
  config: ShareRuntime,
  team: ResolvedTeam,
  conflict: InspectedShareConflict,
  push: boolean | undefined,
) {
  if (conflict.sharedContent === undefined) {
    throw ShareOperationError.make({message: `Cannot take shared for ${conflict.id}: ${conflict.reason}.`});
  }
  reconcileMissingSharedMemoryIdentity(
    conflict.uri,
    conflict.localContent,
    conflict.sharedContent,
    conflict.previousContent,
  );
  const establishedMemoryId = establishedSharedMemoryIdentity(
    conflict.uri,
    conflict.localContent,
    conflict.previousContent,
  );
  if (establishedMemoryId === undefined) {
    return {
      acceptedContent: conflict.sharedContent,
      publishIdentityRepair: false,
      writeWorktree: false,
    } satisfies TakeSharedPlan;
  }
  const headRawContent = yield* gitFileContent(team.config.worktree, 'HEAD', conflict.relativePath);
  if (headRawContent === undefined) {
    throw ShareOperationError.make({
      message: `Cannot verify committed shared content for ${conflict.id}. Sync the shared worktree and retry.`,
    });
  }
  const headContent = yield* prepareSharedInboundContentEffect(conflict.uri, headRawContent);
  const acceptedContent = reconcileMissingSharedMemoryIdentity(
    conflict.uri,
    conflict.localContent,
    headContent,
    conflict.previousContent,
  );
  const repairsHead = !sharedMemoryContentsEquivalent(headContent, acceptedContent);
  const ahead =
    push === false
      ? 0
      : Number.parseInt(
          (yield* gitOutput(team.config.worktree, ['rev-list', '--count', '@{u}..HEAD'], false)) ?? '',
          10,
        );
  if (push !== false && !Number.isSafeInteger(ahead)) {
    throw ShareOperationError.make({
      message: `Cannot verify unpublished shared commits for ${conflict.id}. Inspect the shared worktree upstream and retry.`,
    });
  }
  const upstreamState =
    !repairsHead && ahead > 0 ? yield* classifyUpstreamIdentityRepair(team, conflict, acceptedContent) : undefined;
  if (upstreamState === 'divergent') {
    throw ShareOperationError.make({
      message: `Refusing shared identity repair for ${conflict.id}: upstream content diverged from the unpublished local repair. Sync or rebase the shared worktree and inspect the conflict again.`,
    });
  }
  const publishIdentityRepair = repairsHead || upstreamState === 'exact-repair-needed';
  if (publishIdentityRepair) {
    assertShareTeamWritable(team, 'repair shared memory identity');
  }
  yield* assertSharedWorktreeFileReady(
    team.config.worktree,
    conflict.relativePath,
    headContent,
    false,
    sharedMemoryContentsEquivalent,
    {
      allowCleanTrackedReplacement: true,
      exactRetryContent: acceptedContent,
    },
  );
  if (publishIdentityRepair) {
    yield* assertSharedMemoryIdentityAvailable(
      config,
      team,
      conflict.uri,
      establishedMemoryId,
      conflict.hasLocalContent,
    );
  }
  return {
    acceptedContent,
    publishIdentityRepair,
    writeWorktree: !sharedMemoryContentsEquivalent(conflict.sharedContent, acceptedContent),
  } satisfies TakeSharedPlan;
});

type UpstreamIdentityRepairState = 'already-repaired' | 'divergent' | 'exact-repair-needed';

const classifyUpstreamIdentityRepair = Effect.fn('share.classifyUpstreamIdentityRepair')(function* (
  team: ResolvedTeam,
  conflict: InspectedShareConflict,
  acceptedContent: string,
) {
  const upstreamRawContent = yield* gitFileContent(team.config.worktree, '@{u}', conflict.relativePath);
  if (upstreamRawContent === undefined) {
    throw ShareOperationError.make({
      message: `Cannot verify unpublished shared identity repair for ${conflict.id}. Inspect the shared worktree upstream and retry.`,
    });
  }
  const upstreamContent = yield* prepareSharedInboundContentEffect(conflict.uri, upstreamRawContent);
  const reconciledUpstream = reconcileMissingSharedMemoryIdentity(
    conflict.uri,
    conflict.localContent,
    upstreamContent,
    conflict.previousContent,
  );
  if (sharedMemoryContentsEquivalent(upstreamContent, acceptedContent)) {
    return 'already-repaired' satisfies UpstreamIdentityRepairState;
  }
  if (
    sharedMemoryContentsEquivalent(acceptedContent, reconciledUpstream) &&
    !sharedMemoryContentsEquivalent(upstreamContent, reconciledUpstream)
  ) {
    return 'exact-repair-needed' satisfies UpstreamIdentityRepairState;
  }
  return 'divergent' satisfies UpstreamIdentityRepairState;
});

const assertSharedMemoryIdentityAvailable = Effect.fn('share.assertSharedMemoryIdentityAvailable')(function* (
  config: ShareRuntime,
  team: ResolvedTeam,
  uri: string,
  memoryId: string,
  hasLocalContent: boolean,
) {
  const scope = `threadnote://user/${uriSegment(config.user)}/memories/shared/${uriSegment(team.name)}/durable/projects`;
  const candidates = yield* loadRecallMemoryIdentities(config, {
    allowedUriScopes: [scope],
    memoryIds: [memoryId],
    validateNow: true,
  });
  const resolution = classifyMemoryIdentityCandidates(candidates, memoryId, [scope]);
  const nativeIdentityAvailable =
    (resolution.state === 'not-found' && !hasLocalContent) ||
    (resolution.state === 'resolved' && resolution.uri === uri);
  if (!nativeIdentityAvailable) {
    throw ShareOperationError.make({
      message: `Refusing shared identity repair for ${uri}: stable memory_id ${memoryId} is already owned or ambiguous in team ${team.name}.`,
    });
  }
  yield* assertSharedGitIdentityAvailable(config, team, uri, memoryId);
});

const assertSharedGitIdentityAvailable = Effect.fn('share.assertSharedGitIdentityAvailable')(function* (
  config: ShareRuntime,
  team: ResolvedTeam,
  uri: string,
  memoryId: string,
) {
  const head = yield* gitOutput(team.config.worktree, ['rev-parse', 'HEAD'], false);
  const listing =
    head === undefined
      ? undefined
      : yield* gitOutput(
          team.config.worktree,
          ['ls-tree', '-r', '--name-only', '-z', head, '--', ...SHAREABLE_MEMORY_KIND_DIRS],
          false,
        );
  if (head === undefined || listing === undefined) {
    throw ShareOperationError.make({
      message: `Cannot verify stable memory_id ownership in shared team ${team.name}. Inspect the shared worktree and retry.`,
    });
  }
  for (const candidate of listing.split('\0').filter(Boolean)) {
    const relativePath = assertSafeShareRelativePath(candidate);
    if (!relativePath.endsWith('.md')) continue;
    const rawContent = yield* gitFileContent(team.config.worktree, head, relativePath);
    if (rawContent === undefined) {
      throw ShareOperationError.make({
        message: `Cannot verify stable memory_id ownership for shared file ${relativePath}. Inspect the shared worktree and retry.`,
      });
    }
    const candidatePath = yield* pathJoin(team.config.worktree, ...relativePath.split('/'));
    const candidateUri = yield* workfileToResourceUri(config, team.config, candidatePath);
    const record = parseMemoryDocument(candidateUri, rawContent);
    if (record?.metadata.status === 'active' && record.metadata.memoryId === memoryId && candidateUri !== uri) {
      throw ShareOperationError.make({
        message: `Refusing shared identity repair for ${uri}: stable memory_id ${memoryId} is already owned by ${candidateUri} in team ${team.name}.`,
      });
    }
  }
});

const teamsForShareQuery = Effect.fn('share.teamsForShareQuery')(function* (
  config: ShareRuntime,
  teamName: string | undefined,
) {
  if (teamName) {
    return [yield* resolveTeam(config, teamName)];
  }
  const teams = yield* readTeamsFile(config);
  const entries = Object.entries(teams.teams);
  if (entries.length === 0) {
    throw ShareOperationError.make({message: 'No shared teams configured. Run: threadnote share init <remote-url>'});
  }
  return entries.map(([name, team]) => ({config: team, name}));
});

const readPendingShareConflict = Effect.fn('share.readPendingShareConflict')(function* (
  config: ShareRuntime,
  reference: string,
  optionTeam: string | undefined,
) {
  const target = yield* parseShareConflictReference(config, reference, optionTeam);
  const state = autoShareState(config);
  yield* loadPendingReindexes(config, state);
  const pending = state.pendingReindexes.get(target.team.name) ?? [];
  const change = pending.find(candidate => candidate.relativePath === target.relativePath);
  if (!change) {
    const available = pending
      .filter(isShareableMemoryChange)
      .map(candidate => conflictId(target.team.name, candidate.relativePath));
    throw ShareOperationError.make({
      message: [
        `No pending shared memory conflict found for ${conflictId(target.team.name, target.relativePath)}.`,
        available.length > 0
          ? `Pending conflicts for this team:\n${available.map(id => `- ${id}`).join('\n')}`
          : `No pending conflicts for team "${target.team.name}".`,
      ].join('\n'),
    });
  }
  return {change: yield* normalizePendingChange(target.team, change), team: target.team};
});

const parseShareConflictReference = Effect.fn('share.parseShareConflictReference')(function* (
  config: ShareRuntime,
  reference: string,
  optionTeam: string | undefined,
) {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw ShareOperationError.make({
      message: 'Provide a conflict id, relative path, or threadnote:// shared memory URI.',
    });
  }
  const canonicalReference = canonicalResourceInput(trimmed);
  if (canonicalReference) {
    const teamName = sharedTeamNameForUri(config, canonicalReference);
    if (!teamName) {
      throw ShareOperationError.make({message: `Shared memory URI does not include a configured team: ${trimmed}`});
    }
    const team = yield* resolveTeam(config, optionTeam ?? teamName);
    return {
      relativePath: assertSafeShareRelativePath(resourceUriToWorktreeRelative(config, canonicalReference, team.name)),
      team,
    };
  }
  const colon = trimmed.indexOf(':');
  if (colon > 0 && !trimmed.slice(0, colon).includes('/')) {
    const team = yield* resolveTeam(config, optionTeam ?? trimmed.slice(0, colon));
    return {relativePath: assertSafeShareRelativePath(trimmed.slice(colon + 1)), team};
  }
  const team = yield* resolveTeam(config, optionTeam);
  return {relativePath: assertSafeShareRelativePath(trimmed), team};
});

const normalizePendingChange = Effect.fn('share.normalizePendingChange')(function* (
  team: ResolvedTeam,
  change: ChangedFile,
) {
  const relativePath = assertSafeShareRelativePath(change.relativePath);
  return {
    ...change,
    path: yield* pathJoin(team.config.worktree, ...relativePath.split('/')),
    relativePath,
  };
});

function isShareableMemoryChange(change: ChangedFile): boolean {
  const firstSegment = change.relativePath.split('/')[0];
  return change.relativePath.endsWith('.md') && SHAREABLE_MEMORY_KIND_DIRS.includes(firstSegment);
}

const buildShareConflictSummary = Effect.fn('share.buildShareConflictSummary')(function* (
  config: ShareRuntime,
  team: ResolvedTeam,
  change: ChangedFile,
) {
  const inspected = yield* inspectShareConflict(config, team, change);
  return {
    establishedMemoryId: inspected.establishedMemoryId,
    hasLocalContent: inspected.hasLocalContent,
    hasPreviousContent: inspected.hasPreviousContent,
    hasSharedContent: inspected.hasSharedContent,
    identityConflict: inspected.identityConflict,
    id: inspected.id,
    reason: inspected.reason,
    relativePath: inspected.relativePath,
    status: inspected.status,
    team: inspected.team,
    uri: inspected.uri,
  };
});

const inspectShareConflict = Effect.fn('share.inspectShareConflict')(function* (
  config: ShareRuntime,
  team: ResolvedTeam,
  change: ChangedFile,
) {
  const ov = NATIVE_RESOURCE_BACKEND;
  const uri = yield* workfileToResourceUri(config, team.config, change.path);
  const localContent = yield* readOptionalMemoryContent(config, ov, uri);
  const shared = yield* readOptionalSharedConflictContent(uri, change);
  const previous = yield* readOptionalPreviousConflictContent(team.config.worktree, uri, change);
  const establishedMemoryId = establishedSharedMemoryIdentity(uri, localContent, previous.content);
  const identityConflict =
    shared.content !== undefined
      ? sharedMemoryIdentityConflict(uri, localContent, shared.content, previous.content)?.kind
      : undefined;
  const identityIssue =
    shared.content !== undefined
      ? sharedMemoryIdentityConflict(uri, localContent, shared.content, previous.content)?.message
      : undefined;
  return {
    establishedMemoryId,
    hasLocalContent: localContent !== undefined,
    hasPreviousContent: previous.content !== undefined,
    hasSharedContent: shared.content !== undefined,
    identityConflict,
    id: conflictId(team.name, change.relativePath),
    localContent,
    previousContent: previous.content,
    reason:
      identityIssue ??
      shareConflictReason(change, localContent, shared.content, previous.content, shared.error, previous.error),
    relativePath: change.relativePath,
    sharedContent: shared.content,
    status: change.status,
    team: team.name,
    uri,
  };
});

const readOptionalSharedConflictContent = Effect.fn('share.readOptionalSharedConflictContent')(function* (
  uri: string,
  change: ChangedFile,
) {
  const result = yield* Effect.result(
    Effect.gen(function* () {
      if (change.status === 'removed' || !(yield* isRegularFileNoSymlink(change.path))) {
        return {content: undefined, error: undefined};
      }
      return {content: yield* readSharedInboundFileContent(uri, change.path), error: undefined};
    }),
  );
  if (Result.isSuccess(result)) {
    return result.success;
  }
  const err = result.failure;
  return {content: undefined, error: err instanceof Error ? err.message : String(err)};
});

const readOptionalPreviousConflictContent = Effect.fn('share.readOptionalPreviousConflictContent')(function* (
  worktree: string,
  uri: string,
  change: ChangedFile,
) {
  const rawContent =
    change.previousContent ??
    (change.previousRevision
      ? yield* gitFileContent(worktree, change.previousRevision, change.relativePath)
      : undefined);
  if (rawContent === undefined) {
    return {content: undefined, error: undefined};
  }
  const result = yield* Effect.result(prepareSharedInboundContentEffect(uri, rawContent));
  if (Result.isSuccess(result)) {
    return {content: result.success, error: undefined};
  }
  const err = result.failure;
  return {content: undefined, error: err instanceof Error ? err.message : String(err)};
});

const readOptionalMemoryContent = Effect.fn('share.readOptionalMemoryContent')(function* (
  config: ShareRuntime,
  ov: string,
  uri: string,
) {
  if (!(yield* resourceExistsStrict(ov, config, uri))) {
    return undefined;
  }
  return yield* readMemoryContent(config, ov, uri, false);
});

function shareConflictReason(
  change: ChangedFile,
  localContent: string | undefined,
  sharedContent: string | undefined,
  previousContent: string | undefined,
  sharedError: string | undefined,
  previousError: string | undefined,
): string {
  if (sharedError) {
    return `shared file is not readable: ${sharedError}`;
  }
  if (previousError && change.status !== 'added') {
    return `previous shared content is not readable: ${previousError}`;
  }
  if (change.status === 'added') {
    if (localContent === undefined) {
      return 'shared file is pending ingestion into native canonical store';
    }
    if (sharedContent === undefined) {
      return 'shared file is missing or not readable';
    }
    return sharedMemoryContentsEquivalent(localContent, sharedContent)
      ? 'pending replay is already reflected in native canonical store'
      : 'local native canonical store content differs from the newly added shared file';
  }
  if (change.status === 'modified') {
    if (localContent === undefined) {
      return 'native canonical store resource is missing while a shared update is pending';
    }
    if (previousContent === undefined) {
      return 'previous shared content is unavailable, so local edits cannot be distinguished from upstream edits';
    }
    return sharedMemoryContentsEquivalent(localContent, previousContent)
      ? 'shared update is pending ingestion into native canonical store'
      : 'local native canonical store content differs from the previous shared version';
  }
  if (localContent === undefined) {
    return 'shared deletion is already reflected in native canonical store';
  }
  if (previousContent === undefined) {
    return 'previous shared content is unavailable, so local deletion cannot be verified safely';
  }
  return sharedMemoryContentsEquivalent(localContent, previousContent)
    ? 'shared deletion is pending removal from native canonical store'
    : 'local native canonical store content differs from the deleted shared version';
}

const conflictResolutionContent = Effect.fn('share.conflictResolutionContent')(function* (
  conflict: InspectedShareConflict,
  take: ShareConflictTake | undefined,
  fromFile: string | undefined,
  mergedContent: string | undefined,
) {
  const raw =
    fromFile !== undefined
      ? yield* readFile(yield* expandPath(fromFile), 'utf8')
      : mergedContent !== undefined
        ? mergedContent
        : take === 'local'
          ? conflict.localContent
          : undefined;
  if (raw === undefined) {
    throw ShareOperationError.make({
      message: `Cannot resolve ${conflict.id}: local native canonical store content is unavailable.`,
    });
  }
  const scrub = applyScrubber(stripPersonalProvenanceForSharedPublication(raw), {redact: false});
  if (scrub.blocker) {
    throw ShareOperationError.make({
      message: `Refusing to resolve ${conflict.id}: possible ${scrub.blocker}. Strip the sensitive value before writing it to shared memory.`,
    });
  }
  const citationBlocker = memoryCodeCitationContentSharingBlocker(conflict.uri, scrub.cleaned);
  if (citationBlocker) {
    throw ShareOperationError.make({
      message: `Refusing to resolve ${conflict.id}: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
    });
  }
  return scrub.cleaned;
});

const writeSharedConflictFile = Effect.fn('share.writeSharedConflictFile')(function* (
  team: ResolvedTeam,
  conflict: InspectedShareConflict,
  content: string,
  dryRun: boolean,
) {
  const filePath = yield* pathJoin(team.config.worktree, conflict.relativePath);
  if (dryRun) {
    yield* Console.log(`Would write shared file: ${yield* portablePath(filePath)}`);
    return;
  }
  yield* writeSharedWorktreeFile(team.config.worktree, conflict.relativePath, content);
});

const backupShareConflict = Effect.fn('share.backupShareConflict')(function* (
  config: ShareRuntime,
  conflict: InspectedShareConflict,
) {
  const backupDir = yield* pathJoin(
    config.agentContextHome,
    'share',
    'conflict-backups',
    safeTimestamp(),
    conflict.team,
    ...conflict.relativePath.split('/'),
  );
  yield* mkdir(backupDir, {recursive: true});
  const metadata = {
    id: conflict.id,
    reason: conflict.reason,
    relativePath: conflict.relativePath,
    status: conflict.status,
    team: conflict.team,
    uri: conflict.uri,
  };
  yield* writeFile(yield* pathJoin(backupDir, 'metadata.json'), `${JSON.stringify(metadata, undefined, 2)}\n`, 'utf8');
  if (conflict.localContent !== undefined) {
    yield* writeFile(yield* pathJoin(backupDir, 'local.md'), conflict.localContent, 'utf8');
  }
  if (conflict.sharedContent !== undefined) {
    yield* writeFile(yield* pathJoin(backupDir, 'shared.md'), conflict.sharedContent, 'utf8');
  }
  if (conflict.previousContent !== undefined) {
    yield* writeFile(yield* pathJoin(backupDir, 'previous.md'), conflict.previousContent, 'utf8');
  }
  return backupDir;
});

const clearPendingShareConflict = Effect.fn('share.clearPendingShareConflict')(function* (
  config: ShareRuntime,
  teamName: string,
  relativePath: string,
) {
  const state = autoShareState(config);
  yield* loadPendingReindexes(config, state);
  const pending = state.pendingReindexes.get(teamName) ?? [];
  const remaining = pending.filter(change => change.relativePath !== relativePath);
  if (remaining.length > 0) {
    state.pendingReindexes.set(teamName, remaining);
  } else {
    state.pendingReindexes.delete(teamName);
  }
  yield* writePendingReindexes(config, state);
});

function conflictId(team: string, relativePath: string): string {
  return `${team}:${relativePath}`;
}

function shareConflictResolutionGuidance(conflict: ShareConflictSummary): readonly string[] {
  return [
    ...(shareConflictCanTakeShared(conflict) ? [`threadnote share conflict resolve ${conflict.id} --take shared`] : []),
    `threadnote share conflict resolve ${conflict.id} --take local`,
    `threadnote share conflict resolve ${conflict.id} --from-file merged.md`,
  ];
}

function shareConflictCanTakeShared(
  conflict: Pick<ShareConflictSummary, 'hasSharedContent' | 'identityConflict' | 'status'>,
): boolean {
  return conflict.identityConflict !== 'changed' && (conflict.status === 'removed' || conflict.hasSharedContent);
}

function formatShareConflictNextSteps(teamName: string, conflicts: readonly ShareConflictSummary[]): string {
  const entries = conflicts.map(conflict => ({conflict, id: conflictId(teamName, conflict.relativePath)}));
  const ids = entries.map(({id}) => id);
  if (ids.length === 0) {
    return `Run \`threadnote share conflicts --team ${teamName}\` to inspect pending reindexes.`;
  }
  return [
    `Resolve pending shared memory conflicts with:`,
    `  threadnote share conflicts --team ${teamName}`,
    ...entries.flatMap(({conflict, id}) => [
      `  threadnote share conflict show ${id}`,
      ...(shareConflictCanTakeShared(conflict) ? [`  threadnote share conflict resolve ${id} --take shared`] : []),
      `  threadnote share conflict resolve ${id} --take local`,
      `  threadnote share conflict resolve ${id} --from-file merged.md`,
    ]),
  ].join('\n');
}

function formatShareConflictDiff(conflict: InspectedShareConflict): string {
  const parts: string[] = [];
  if (conflict.previousContent !== undefined) {
    parts.push(
      formatTwoWayDiff(
        'previous shared',
        conflict.previousContent,
        'local native canonical store',
        conflict.localContent,
      ),
    );
  }
  parts.push(
    formatTwoWayDiff('local native canonical store', conflict.localContent, 'shared file', conflict.sharedContent),
  );
  return parts.join('\n\n');
}

function formatTwoWayDiff(
  leftLabel: string,
  leftContent: string | undefined,
  rightLabel: string,
  rightContent: string | undefined,
): string {
  if (leftContent === undefined && rightContent === undefined) {
    return `${leftLabel} and ${rightLabel} are both unavailable.`;
  }
  if (leftContent === rightContent) {
    return `${leftLabel} and ${rightLabel} are identical.`;
  }
  const leftLines = splitDiffLines(leftContent);
  const rightLines = splitDiffLines(rightContent);
  const lines = [`--- ${leftLabel}`, `+++ ${rightLabel}`];
  for (const line of leftLines) {
    lines.push(`-${line}`);
  }
  for (const line of rightLines) {
    lines.push(`+${line}`);
  }
  return lines.join('\n');
}

function splitDiffLines(content: string | undefined): readonly string[] {
  if (content === undefined) {
    return ['<missing>'];
  }
  const lines = content.split(/\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }
  return lines;
}

export {
  conflictId,
  formatShareConflictNextSteps,
  isShareableMemoryChange,
  normalizePendingChange,
  shareConflictCanTakeShared,
  teamsForShareQuery,
};
