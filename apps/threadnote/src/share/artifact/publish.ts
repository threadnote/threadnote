import {Console, Effect, FileSystem, Path, Predicate, Result} from 'effect';

import {CommandExecutor} from '@threadnote/platform/command';

import {SystemInfo} from '@threadnote/platform/system';

import {uriSegment} from '@threadnote/workspace/manifest';

import {canonicalMemoryDocumentContent} from '@threadnote/memory/document';
import {
  memoryCodeCitationContentSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {discardDeferredCodeAnchorIntent, hasDeferredCodeAnchorIntent} from '../../memory/deferred/code_anchor.js';
import {recordMemoryRelocation} from '@threadnote/memory/relocation';

import {ResourceStore} from '@threadnote/store/resource-store';

import {applyScrubber} from '@threadnote/platform/scrubber';
import {sharePublishEligibilityError, sharePublishRelationWarnings} from '../publish_policy.js';

import type {
  ShareAgentArtifactAgent,
  ShareAgentArtifactKind,
  SharePublishArtifactOptions,
  SharePublishOptions,
  ShareRuntime,
} from '../../types.js';

import {
  assertResourceUri,
  ensureDirectory,
  isDirectory,
  isFile,
  parseJsonConfigObject,
  portablePath,
  readFileIfExists,
  requiredExecutable,
  runCommand,
  sha256,
} from '../../utils.js';
import {expandPath} from '@threadnote/platform/paths';

import {
  collectBundleMemberFiles,
  compareStrings,
  detectBinaryCredential,
  detectBinaryLocalPath,
  isProbablyBinary,
  readFileBytesIfExists,
} from './support.js';

import type {BundleMemberFile, ResolvedTeam, ShareArtifactMetadata, ShareArtifactResult} from '../core.js';

import {
  BUNDLE_MANIFEST_FILE,
  BUNDLE_MANIFEST_VERSION,
  NATIVE_RESOURCE_BACKEND,
  PACK_FILES_DIR,
  PACK_INDEX_SUFFIX,
  PACK_MANIFEST_SUFFIX,
  PACK_ROOT_TOKEN,
  SHAREABLE_ARTIFACT_DIR,
  ShareOperationError,
  assertShareTeamWritable,
  ensureSharedDirectoryChain,
  isInSharedNamespace,
  isRegularFileNoSymlink,
  parentUri,
  pathBasename,
  pathDirname,
  pathIsAbsolute,
  pathJoin,
  pathRelative,
  pathSeparator,
  readFile,
  readMemoryContent,
  removeMemoryUri,
  resolveTeam,
  resourceExists,
  resourceUriToWorktreeRelative,
  rm,
  setMemoryVisibility,
  sharedMemoryIdentityContinuityIssue,
  sharedUriFor,
  stripPersonalProvenanceForSharedPublication,
  workfileToResourceUri,
  writeFile,
  writeMemoryFile,
} from '../core.js';

import {assertSharedWorktreeFileReady, publishShareGitChange, writeSharedWorktreeFile} from '../git.js';

export const runSharePublish = Effect.fn('share.runSharePublish')(function* (
  config: ShareRuntime,
  sourceUri: string,
  options: SharePublishOptions,
) {
  assertResourceUri(sourceUri);
  const team = yield* resolveTeam(config, options.team);
  assertShareTeamWritable(team, 'publish memories');
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  if (isInSharedNamespace(config, sourceUri)) {
    throw ShareOperationError.make({message: `Memory ${sourceUri} is already in the shared namespace.`});
  }
  const hasPendingCodeRefs = yield* hasDeferredCodeAnchorIntent(config, sourceUri);
  if (hasPendingCodeRefs && options.allowUncitedPendingCodeRefs !== true) {
    throw ShareOperationError.make({
      message: `Refusing to publish ${sourceUri}: code citations are still pending. Prepare the graph and run \`threadnote finalize-code-refs --uri ${sourceUri}\`, or explicitly pass --allow-uncited-pending-code-refs to publish without them and discard the private intent.`,
    });
  }
  const ov = NATIVE_RESOURCE_BACKEND;
  const rawContent = yield* readMemoryContent(config, ov, sourceUri, false);
  const eligibilityError = sharePublishEligibilityError(config, sourceUri, rawContent);
  if (eligibilityError) {
    throw ShareOperationError.make({message: eligibilityError});
  }
  const citationBlocker = memoryCodeCitationContentSharingBlocker(sourceUri, rawContent);
  if (citationBlocker) {
    throw ShareOperationError.make({
      message: `Refusing to publish ${sourceUri}: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
    });
  }
  const stripped = setMemoryVisibility(stripPersonalProvenanceForSharedPublication(rawContent), 'shared');
  const scrub = applyScrubber(stripped, {redact: options.redact === true});
  const targetUri = sharedUriFor(config, sourceUri, team.name);

  if (preview) {
    yield* Console.log(`PREVIEW source: ${sourceUri}`);
    yield* Console.log(`PREVIEW destination: ${targetUri}`);
    if (scrub.blocker) {
      yield* Console.log(
        `PREVIEW BLOCKED: ${scrub.blocker}. Strip the sensitive value or rerun with --redact for soft-leak patterns.`,
      );
      return;
    }
    for (const redaction of scrub.redactions) {
      yield* Console.log(`PREVIEW redact: ${redaction.count}× ${redaction.name}`);
    }
    for (const warning of yield* sharePublishRelationWarnings(config, sourceUri, scrub.cleaned, team.name)) {
      yield* Console.log(warning);
    }
    yield* Console.log('-----BEGIN PREVIEW-----');
    yield* Console.log(scrub.cleaned);
    yield* Console.log('-----END PREVIEW-----');
    return;
  }

  if (scrub.blocker) {
    throw ShareOperationError.make({
      message: `Refusing to publish ${sourceUri}: possible ${scrub.blocker}. Strip the sensitive value or pass --redact for soft-leak patterns.`,
    });
  }
  const worktree = team.config.worktree;
  const relativePath = resourceUriToWorktreeRelative(config, targetUri, team.name);
  const message = options.message ?? `share: publish ${relativePath}`;
  const publish = Effect.fn('share.callback')(function* () {
    const currentRawContent = dryRun ? rawContent : yield* readMemoryContent(config, ov, sourceUri, false);
    const currentEligibilityError = sharePublishEligibilityError(config, sourceUri, currentRawContent);
    if (currentEligibilityError) {
      throw ShareOperationError.make({message: currentEligibilityError});
    }
    const currentCitationBlocker = memoryCodeCitationContentSharingBlocker(sourceUri, currentRawContent);
    if (currentCitationBlocker) {
      throw ShareOperationError.make({
        message: `Refusing to publish ${sourceUri}: ${memoryCodeCitationSharingBlockerMessage(currentCitationBlocker)}.`,
      });
    }
    const currentScrub = applyScrubber(
      setMemoryVisibility(stripPersonalProvenanceForSharedPublication(currentRawContent), 'shared'),
      {
        redact: options.redact === true,
      },
    );
    if (currentScrub.blocker) {
      throw ShareOperationError.make({
        message: `Refusing to publish ${sourceUri}: possible ${currentScrub.blocker}. Strip the sensitive value or pass --redact for soft-leak patterns.`,
      });
    }
    const existingTarget =
      !dryRun && (yield* resourceExists(ov, config, targetUri))
        ? yield* readMemoryContent(config, ov, targetUri, false)
        : undefined;
    if (
      existingTarget !== undefined &&
      canonicalMemoryDocumentContent(setMemoryVisibility(existingTarget, 'shared')) !==
        canonicalMemoryDocumentContent(currentScrub.cleaned)
    ) {
      throw ShareOperationError.make({
        message: `Refusing to publish: ${targetUri} already exists with different content. Inspect it via threadnote read and resolve the conflict explicitly.`,
      });
    }
    const establishedWorktreeContent = yield* assertSharedWorktreeFileReady(
      worktree,
      relativePath,
      existingTarget,
      dryRun,
      undefined,
      {
        allowCleanTrackedReplacement: existingTarget === undefined,
      },
    );
    if (existingTarget === undefined && establishedWorktreeContent !== undefined) {
      const identityIssue = sharedMemoryIdentityContinuityIssue(
        targetUri,
        establishedWorktreeContent,
        currentScrub.cleaned,
      );
      if (identityIssue !== undefined) throw ShareOperationError.make({message: identityIssue});
    }
    yield* ensureSharedDirectoryChain(config, ov, targetUri, dryRun);
    yield* writeMemoryFile(
      config,
      ov,
      targetUri,
      currentScrub.cleaned,
      existingTarget === undefined ? 'create' : 'replace',
      dryRun,
    );
    if (!dryRun) {
      const storedTarget = yield* readMemoryContent(config, ov, targetUri, false);
      if (canonicalMemoryDocumentContent(storedTarget) !== canonicalMemoryDocumentContent(currentScrub.cleaned)) {
        throw ShareOperationError.make({
          message: `Shared target verification failed after writing ${targetUri}; personal source preserved.`,
        });
      }
    }
    yield* writeSharedWorktreeFile(worktree, relativePath, currentScrub.cleaned, dryRun);
    const gitMessages = yield* publishShareGitChange(worktree, relativePath, message, {
      dryRun,
      push: options.push,
    });
    if (!dryRun) {
      const sourceBeforeRemoval = yield* readMemoryContent(config, ov, sourceUri, false);
      if (sourceBeforeRemoval.trim() !== currentRawContent.trim()) {
        throw ShareOperationError.make({
          message: `Memory ${sourceUri} changed during publication; personal source preserved.`,
        });
      }
      yield* recordMemoryRelocation(config, {
        fromContent: sourceBeforeRemoval,
        fromUri: sourceUri,
        toContent: currentScrub.cleaned,
        toUri: targetUri,
      });
    }
    yield* removeMemoryUri(config, ov, sourceUri, dryRun);
    if (!dryRun && hasPendingCodeRefs) {
      yield* discardDeferredCodeAnchorIntent(config, sourceUri);
    }
    return {gitMessages, redactions: currentScrub.redactions};
  });
  const published = yield* publish();
  for (const redaction of published.redactions) {
    yield* Console.log(`Redacted ${redaction.count}× ${redaction.name} before publish.`);
  }
  const gitMessages = published.gitMessages;
  for (const gitMessage of gitMessages) {
    yield* Console.log(gitMessage);
  }
  yield* Console.log(`Published ${sourceUri} -> ${targetUri}`);
});

export const runSharePublishArtifact = Effect.fn('share.runSharePublishArtifact')(function* (
  config: ShareRuntime,
  sourcePath: string,
  options: SharePublishArtifactOptions,
) {
  const result = yield* shareAgentArtifact(config, sourcePath, options);
  yield* printShareArtifactResult(result, options.preview === true);
});

export const shareAgentArtifact = Effect.fn('share.shareAgentArtifact')(function* (
  config: ShareRuntime,
  sourcePath: string,
  options: SharePublishArtifactOptions,
) {
  const team = yield* resolveTeam(config, options.team);
  assertShareTeamWritable(team, 'publish agent artifacts');
  const resolvedSourcePath = yield* expandPath(sourcePath);
  if (!(yield* isRegularFileNoSymlink(resolvedSourcePath))) {
    throw ShareOperationError.make({message: `Agent artifact source is not a regular file: ${resolvedSourcePath}`});
  }

  const artifact = yield* inferShareArtifact(resolvedSourcePath, options);
  // A skill carries its whole directory. When companion files sit beside the
  // SKILL.md it is shared as a multi-file bundle; a lone SKILL.md takes the same
  // single-file path as before, byte-for-byte.
  if (artifact.kind === 'skill') {
    const skillDir = yield* pathDirname(resolvedSourcePath);
    const members = yield* collectBundleMemberFiles(skillDir);
    if (members.length > 1) {
      return yield* shareBundleArtifact(config, team, artifact, skillDir, members, options);
    }
  }
  return yield* shareSingleArtifact(config, team, resolvedSourcePath, artifact, options);
});

type ResolvedShareTeam = ResolvedTeam;

const shareSingleArtifact = Effect.fn('share.shareSingleArtifact')(function* (
  config: ShareRuntime,
  team: ResolvedShareTeam,
  resolvedSourcePath: string,
  artifact: ShareArtifactMetadata,
  options: SharePublishArtifactOptions,
) {
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  const rawContent = yield* readFile(resolvedSourcePath, 'utf8');
  if (!rawContent.trim()) {
    throw ShareOperationError.make({message: `Refusing to share empty agent artifact: ${resolvedSourcePath}`});
  }
  // Agent artifacts are published byte-for-byte. The memory-share scrubber stays
  // on durable `share publish`; --redact is ignored here.
  const content = rawContent;
  const relativePath = sharedArtifactRelativePath(artifact);
  const targetPath = yield* pathJoin(team.config.worktree, ...relativePath.split('/'));
  const targetUri = yield* workfileToResourceUri(config, team.config, targetPath);
  const messages: string[] = [
    `${preview ? 'Previewing' : dryRun ? 'Would share' : 'Sharing'} ${artifact.kind} ${artifact.agent}/${artifact.name}`,
    `Source: ${yield* portablePath(resolvedSourcePath)}`,
    `Destination: ${targetUri}`,
  ];
  appendIgnoredArtifactRedactNote(messages, options);

  if (preview) {
    return {
      artifact,
      gitMessages: [],
      messages,
      previewContent: content,
      sourcePath: resolvedSourcePath,
      targetPath,
      targetUri,
    };
  }
  const existingContent = (yield* readFileIfExists(targetPath)) ?? undefined;
  if (existingContent !== undefined && existingContent !== content && options.force !== true) {
    throw ShareOperationError.make({
      message: `Shared artifact already exists with different content: ${yield* portablePath(targetPath)}. Pass --force to replace it.`,
    });
  }

  if (dryRun) {
    messages.push(`Would write shared artifact: ${yield* portablePath(targetPath)}`);
  }

  const ov = NATIVE_RESOURCE_BACKEND;
  const ovHasResource = !dryRun && (yield* resourceExists(ov, config, targetUri));
  yield* ensureSharedDirectoryChain(config, ov, targetUri, dryRun, {quiet: true});
  yield* writeMemoryFile(config, ov, targetUri, content, ovHasResource ? 'replace' : 'create', dryRun, {quiet: true});
  yield* writeSharedWorktreeFile(team.config.worktree, relativePath, content, dryRun);

  const message = options.message ?? `share: publish ${relativePath}`;
  const gitMessages = yield* publishShareGitChange(team.config.worktree, relativePath, message, {
    dryRun,
    push: options.push,
  });
  return {artifact, gitMessages, messages, sourcePath: resolvedSourcePath, targetPath, targetUri};
});

interface PreparedBundleMember {
  readonly binary: boolean;
  readonly blocker?: string;
  readonly content: Uint8Array | string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly targetPath: string;
  readonly targetUri: string;
}

function bundleTextContent(member: PreparedBundleMember): string | undefined {
  return member.binary || typeof member.content !== 'string' ? undefined : member.content;
}

function appendIgnoredArtifactRedactNote(messages: string[], options: SharePublishArtifactOptions): void {
  if (options.redact === true) {
    messages.push('Note: --redact is ignored for agent artifacts; content is published unchanged.');
  }
}

const shareBundleArtifact = Effect.fn('share.shareBundleArtifact')(function* (
  config: ShareRuntime,
  team: ResolvedShareTeam,
  artifact: ShareArtifactMetadata,
  skillDir: string,
  members: readonly BundleMemberFile[],
  options: SharePublishArtifactOptions,
) {
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  const skillRootRelative = `${SHAREABLE_ARTIFACT_DIR}/skills/${artifact.agent}/${artifact.name}`;
  const skillRootTargetDir = yield* pathJoin(team.config.worktree, ...skillRootRelative.split('/'));
  const skillMdTargetPath = yield* pathJoin(skillRootTargetDir, 'SKILL.md');
  const skillMdTargetUri = yield* workfileToResourceUri(config, team.config, skillMdTargetPath);
  const skillRootTargetUri = parentUri(skillMdTargetUri);
  const skillMdSourcePath = yield* pathJoin(skillDir, 'SKILL.md');

  const prepared = yield* Effect.forEach(members, member =>
    prepareBundleMember(config, team, member, skillRootTargetDir, options),
  );
  const skillMd = prepared.find(entry => entry.relativePath === 'SKILL.md');
  if (skillMd === undefined) {
    throw ShareOperationError.make({message: `Skill bundle ${artifact.agent}/${artifact.name} is missing SKILL.md.`});
  }
  if (!skillMd.binary && typeof skillMd.content === 'string' && !skillMd.content.trim()) {
    throw ShareOperationError.make({message: `Refusing to share empty agent artifact: ${skillMdSourcePath}`});
  }

  const messages: string[] = [
    `${preview ? 'Previewing' : dryRun ? 'Would share' : 'Sharing'} skill ${artifact.agent}/${artifact.name} bundle (${prepared.length} files)`,
    `Source: ${yield* portablePath(skillDir)}`,
    `Destination: ${skillRootTargetUri}/`,
  ];
  appendIgnoredArtifactRedactNote(messages, options);

  const blockers = prepared.filter(entry => entry.blocker !== undefined);
  if (preview) {
    for (const entry of prepared) {
      const flags = entry.binary ? ['binary'] : [];
      const note = entry.blocker !== undefined ? ` BLOCKED: ${entry.blocker}` : '';
      messages.push(`  ${entry.relativePath}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}${note}`);
    }
    return {
      artifact,
      gitMessages: [],
      messages,
      previewContent: bundleTextContent(skillMd),
      sourcePath: skillMdSourcePath,
      targetPath: skillMdTargetPath,
      targetUri: skillMdTargetUri,
    };
  }

  if (blockers.length > 0) {
    throw ShareOperationError.make({
      message: `Refusing to share skill ${artifact.agent}/${artifact.name}: ${blockers
        .map(entry => `${entry.relativePath} (${entry.blocker})`)
        .join('; ')}. Strip the value or pass --allow-binary for binary files.`,
    });
  }

  for (const entry of prepared) {
    const existing = yield* readFileBytesIfExists(entry.targetPath);
    if (existing !== undefined && (yield* sha256(existing)) !== entry.sha256 && options.force !== true) {
      throw ShareOperationError.make({
        message: `Shared artifact already exists with different content: ${yield* portablePath(entry.targetPath)}. Pass --force to replace it.`,
      });
    }
  }

  if (dryRun) {
    messages.push(`Would write ${prepared.length} files under ${yield* portablePath(skillRootTargetDir)}`);
    return {
      artifact,
      gitMessages: [],
      messages,
      sourcePath: skillMdSourcePath,
      targetPath: skillMdTargetPath,
      targetUri: skillMdTargetUri,
    };
  }

  // Safety invariant: native canonical store-managed markdown is written first (SKILL.md
  // leading), so a failed OV write never leaves a worktree tree that a later
  // share sync would auto-commit without ingestion. Companion files and the
  // manifest are materialized only after every markdown write succeeds.
  const ov = NATIVE_RESOURCE_BACKEND;
  const markdownMembers = orderSkillMdFirst(prepared.filter(entry => entry.relativePath.endsWith('.md')));
  const otherMembers = prepared.filter(entry => !entry.relativePath.endsWith('.md'));
  for (const entry of markdownMembers) {
    const content = bundleTextContent(entry);
    if (content === undefined) {
      throw ShareOperationError.make({message: `Refusing binary markdown bundle member: ${entry.relativePath}`});
    }
    const ovHasResource = yield* resourceExists(ov, config, entry.targetUri);
    yield* ensureSharedDirectoryChain(config, ov, entry.targetUri, dryRun, {quiet: true});
    yield* writeMemoryFile(config, ov, entry.targetUri, content, ovHasResource ? 'replace' : 'create', dryRun, {
      quiet: true,
    });
    yield* writeSharedWorktreeFile(team.config.worktree, `${skillRootRelative}/${entry.relativePath}`, content, dryRun);
  }
  yield* ensureDirectory(skillRootTargetDir, false);
  for (const entry of otherMembers) {
    yield* ensureDirectory(yield* pathDirname(entry.targetPath), false);
    yield* writeFile(entry.targetPath, entry.content, entry.binary ? {mode: 0o600} : {encoding: 'utf8', mode: 0o600});
  }
  yield* writeFile(yield* pathJoin(skillRootTargetDir, BUNDLE_MANIFEST_FILE), buildBundleManifest(artifact, prepared), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const stagedPaths = [
    ...prepared.map(entry => `${skillRootRelative}/${entry.relativePath}`),
    `${skillRootRelative}/${BUNDLE_MANIFEST_FILE}`,
  ];
  const message =
    options.message ?? `share: publish skill ${artifact.agent}/${artifact.name} (${prepared.length} files)`;
  const gitMessages = yield* publishShareGitChange(team.config.worktree, stagedPaths, message, {
    dryRun,
    push: options.push,
  });
  return {
    artifact,
    gitMessages,
    messages,
    sourcePath: skillMdSourcePath,
    targetPath: skillMdTargetPath,
    targetUri: skillMdTargetUri,
  };
});

const prepareBundleMember = Effect.fn('share.prepareBundleMember')(function* (
  config: ShareRuntime,
  team: ResolvedShareTeam,
  member: BundleMemberFile,
  skillRootTargetDir: string,
  options: SharePublishArtifactOptions,
) {
  const buffer = yield* readFile(member.absolutePath);
  const targetPath = yield* pathJoin(skillRootTargetDir, ...member.relativePath.split('/'));
  const targetUri = yield* workfileToResourceUri(config, team.config, targetPath);
  if (isProbablyBinary(buffer)) {
    const credential = detectBinaryCredential(buffer);
    const blocker =
      credential !== undefined
        ? `possible ${credential} embedded in binary file`
        : options.allowBinary === true
          ? undefined
          : 'binary file (pass --allow-binary to include it unscanned)';
    return {
      binary: true,
      blocker,
      content: buffer,
      relativePath: member.relativePath,
      sha256: yield* sha256(buffer),
      targetPath,
      targetUri,
    };
  }
  const text = new TextDecoder().decode(buffer);
  return {
    binary: false,
    content: text,
    relativePath: member.relativePath,
    sha256: yield* sha256(text),
    targetPath,
    targetUri,
  };
});

function orderSkillMdFirst(entries: readonly PreparedBundleMember[]): readonly PreparedBundleMember[] {
  return [...entries].sort((a, b) => {
    if (a.relativePath === 'SKILL.md') {
      return -1;
    }
    if (b.relativePath === 'SKILL.md') {
      return 1;
    }
    return compareStrings(a.relativePath, b.relativePath);
  });
}

function buildBundleManifest(artifact: ShareArtifactMetadata, prepared: readonly PreparedBundleMember[]): string {
  const manifest = {
    artifact,
    members: prepared
      .map(entry => ({binary: entry.binary, path: entry.relativePath, sha256: entry.sha256}))
      .sort((a, b) => compareStrings(a.path, b.path)),
    version: BUNDLE_MANIFEST_VERSION,
  };
  return `${JSON.stringify(manifest, undefined, 2)}\n`;
}

interface PackManifest {
  readonly agent: ShareAgentArtifactAgent;
  readonly deps: {
    readonly cli: readonly string[];
    readonly mcp: readonly string[];
    readonly os: readonly string[];
    readonly runtime: readonly string[];
  };
  readonly description?: string;
  readonly include: readonly string[];
  readonly name: string;
  readonly pathRewrites: readonly string[];
  readonly skills: readonly string[];
}

export const runSharePublishBundle = Effect.fn('share.runSharePublishBundle')(function* (
  config: ShareRuntime,
  manifestPath: string,
  options: SharePublishArtifactOptions,
) {
  const result = yield* shareBundlePack(config, manifestPath, options);
  yield* printShareArtifactResult(result, options.preview === true);
});

const parsePackManifest = Effect.fn('share.parsePackManifest')(function* (raw: string, manifestPath: string) {
  const parsed = parseJsonConfigObject(raw);
  if (parsed === undefined) {
    throw ShareOperationError.make({message: `Invalid pack manifest (not a JSON object): ${manifestPath}`});
  }
  const name = parsed.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw ShareOperationError.make({message: `Pack manifest must set a non-empty "name": ${manifestPath}`});
  }
  const agent = parsed.agent;
  if (agent !== 'codex' && agent !== 'claude' && agent !== 'cursor') {
    throw ShareOperationError.make({
      message: `Pack manifest "agent" must be "codex", "claude", or "cursor": ${manifestPath}`,
    });
  }
  const stringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const skills = stringArray(parsed.skills);
  if (skills.length === 0) {
    throw ShareOperationError.make({
      message: `Pack manifest must list at least one skill in "skills": ${manifestPath}`,
    });
  }
  const depsValue = Predicate.isObject(parsed.deps) ? parsed.deps : {};
  const pathRewrites = Array.isArray(parsed.pathRewrites)
    ? parsed.pathRewrites
        .map(entry => (typeof entry === 'string' ? entry : Predicate.isObject(entry) ? entry.from : undefined))
        .filter((item): item is string => typeof item === 'string')
        // Strip trailing slashes so a declared "/repo/" still matches a bare
        // "/repo" reference (otherwise the slash-suffixed root never appears and
        // the path leaks past tokenize + the residual check).
        .map(rewrite => rewrite.replace(/\/+$/, ''))
    : [];
  // pathRewrites are matched as whole repo-root prefixes; a short or relative
  // value would corrupt unrelated content via substring replacement.
  for (const rewrite of pathRewrites) {
    if (!(yield* pathIsAbsolute(rewrite)) || rewrite.split('/').filter(Boolean).length < 2) {
      throw ShareOperationError.make({
        message: `Pack manifest pathRewrites entry must be an absolute repo-root path (got "${rewrite}"): ${manifestPath}`,
      });
    }
  }
  const manifest: PackManifest = {
    agent,
    deps: {
      cli: stringArray(depsValue.cli),
      mcp: stringArray(depsValue.mcp),
      os: stringArray(depsValue.os),
      runtime: stringArray(depsValue.runtime),
    },
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    include: stringArray(parsed.include),
    name,
    pathRewrites,
    skills,
  };
  return manifest;
});

// Resolves manifest skill + include entries into a flat, deduplicated member
// list whose relative paths preserve the author's repo layout so relative
// imports and CWD-relative invocations resolve once installed under one root.
const collectPackMembers = Effect.fn('share.collectPackMembers')(function* (
  manifestDir: string,
  manifest: PackManifest,
) {
  const members = new Map<string, BundleMemberFile>();
  const addEntry = Effect.fn('share.callback')(function* (entry: string) {
    const normalized = entry.split('/').filter(Boolean).join('/');
    if (normalized.split('/').includes('..')) {
      throw ShareOperationError.make({
        message: `Pack manifest entries must stay within the pack root (got "${entry}").`,
      });
    }
    const absolute = yield* pathJoin(manifestDir, ...normalized.split('/'));
    if (absolute !== manifestDir && !absolute.startsWith(manifestDir + (yield* pathSeparator))) {
      throw ShareOperationError.make({message: `Pack manifest entry escapes the pack root: ${entry}`});
    }
    if (yield* isDirectory(absolute)) {
      for (const member of yield* collectBundleMemberFiles(absolute)) {
        const relativePath = `${normalized}/${member.relativePath}`;
        members.set(relativePath, {absolutePath: member.absolutePath, relativePath});
      }
      return;
    }
    if (yield* isRegularFileNoSymlink(absolute)) {
      members.set(normalized, {absolutePath: absolute, relativePath: normalized});
      return;
    }
    throw ShareOperationError.make({message: `Pack manifest references a missing path: ${entry}`});
  });
  for (const skill of manifest.skills) {
    // Accept either a skill directory or a path to its SKILL.md.
    const skillRel = skill.replace(/\/SKILL\.md$/i, '');
    const skillDir = yield* pathJoin(manifestDir, ...skillRel.split('/'));
    if (!(yield* isFile(yield* pathJoin(skillDir, 'SKILL.md')))) {
      throw ShareOperationError.make({message: `Pack skill "${skill}" must be a directory containing SKILL.md.`});
    }
    yield* addEntry(skillRel);
  }
  for (const include of manifest.include) {
    yield* addEntry(include);
  }
  return [...members.values()].sort((a, b) => compareStrings(a.relativePath, b.relativePath));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replaces each repo-root prefix with the portable token, anchored on BOTH
// sides to a path boundary: the left lookbehind stops a root from matching when
// it is embedded as a path-segment suffix of a longer path (e.g. inside
// "/backup/Users/alice/reviewer"); the right lookahead stops it from matching a
// longer token ("/repo" must not rewrite inside "/repository") and accepts the
// common path terminators (`/ \\ " ' ` whitespace ) , > : ] } ; =`).
function tokenizePackPaths(text: string, rewriteRoots: readonly string[]): string {
  let out = text;
  for (const root of rewriteRoots) {
    if (root.length > 0) {
      out = out.replace(
        new RegExp(`(?<![A-Za-z0-9/._~-])${escapeRegExp(root)}(?=[/\\\\]|["'\`\\s),>:\\]};=]|$)`, 'g'),
        PACK_ROOT_TOKEN,
      );
    }
  }
  return out;
}

// Absolute path prefixes that are portable across machines (system/tool paths),
// so a surviving reference to them is not flagged as a machine-local leak.
const PORTABLE_PATH_PREFIXES: readonly string[] = [
  '/usr/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib64/',
  '/etc/',
  '/opt/homebrew/',
  '/tmp/',
  '/var/',
  '/private/var/',
  '/dev/',
  '/proc/',
  '/run/',
  '/sys/',
  '/Library/',
  '/System/',
  '/Applications/',
];

// Advisory leftover-path detector after tokenization. /Users and /home are not
// portable prefixes, so they warn here. PORTABLE_PATH_PREFIXES (/tmp, /usr, …)
// are skipped. Never blocks — many remaining absolute paths are still portable.
function unportableAbsolutePaths(content: string): readonly string[] {
  // Drop the portable pack-root token (and the path that follows it) so paths
  // anchored to the install root are not mistaken for machine-local leaks.
  const scan = content.split(`${PACK_ROOT_TOKEN}/`).join('').split(PACK_ROOT_TOKEN).join('');
  const found = new Set<string>();
  for (const path of scan.match(/(?<![A-Za-z0-9._~$-])\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g) ?? []) {
    if (!PORTABLE_PATH_PREFIXES.some(prefix => path.startsWith(prefix))) {
      found.add(path);
    }
  }
  for (const path of scan.match(/[A-Za-z]:\\[^\s"']+/g) ?? []) {
    found.add(path);
  }
  return [...found].sort((a, b) => compareStrings(a, b));
}

const preparePackMember = Effect.fn('share.preparePackMember')(function* (
  config: ShareRuntime,
  team: ResolvedShareTeam,
  member: BundleMemberFile,
  filesTargetDir: string,
  rewriteRoots: readonly string[],
  options: SharePublishArtifactOptions,
) {
  const buffer = yield* readFile(member.absolutePath);
  const targetPath = yield* pathJoin(filesTargetDir, ...member.relativePath.split('/'));
  const targetUri = yield* workfileToResourceUri(config, team.config, targetPath);
  if (isProbablyBinary(buffer)) {
    // Binary members cannot be tokenized or scrubbed, so an embedded credential
    // or machine-local path can never be neutralized — block rather than ship it
    // silently, even with --allow-binary.
    const credential = detectBinaryCredential(buffer);
    const localPath = credential === undefined ? detectBinaryLocalPath(buffer, rewriteRoots) : undefined;
    let blocker: string | undefined;
    if (credential !== undefined) {
      blocker = `possible ${credential} embedded in binary file`;
    } else if (options.allowBinary !== true) {
      blocker = 'binary file (pass --allow-binary to include it unscanned)';
    } else if (localPath !== undefined) {
      blocker = `possible ${localPath} embedded in binary file (cannot be rewritten)`;
    }
    return {
      binary: true,
      blocker,
      content: buffer,
      relativePath: member.relativePath,
      sha256: yield* sha256(buffer),
      targetPath,
      targetUri,
    };
  }
  const text = new TextDecoder().decode(buffer);
  // A member that already contains the reserved token would have it expanded to
  // the installer's absolute path at install — block it as an authoring error.
  if (text.includes(PACK_ROOT_TOKEN)) {
    return {
      binary: false,
      blocker: `contains the reserved ${PACK_ROOT_TOKEN} token`,
      content: text,
      relativePath: member.relativePath,
      sha256: yield* sha256(text),
      targetPath,
      targetUri,
    };
  }
  // Declared/auto rewrite roots become the portable pack token. The memory-share
  // scrubber and residual rewrite-root blocking do not run on pack members;
  // leftover machine-local paths are advisory only.
  const tokenized = tokenizePackPaths(text, rewriteRoots);
  return {
    binary: false,
    content: tokenized,
    relativePath: member.relativePath,
    sha256: yield* sha256(tokenized),
    targetPath,
    targetUri,
  };
});

function buildPackIndex(
  artifact: ShareArtifactMetadata,
  manifest: PackManifest,
  skillNames: readonly string[],
  memberCount: number,
): string {
  const lines = [
    '---',
    `name: ${artifact.name}`,
    `agent: ${artifact.agent}`,
    'kind: pack',
    `skills: [${skillNames.join(', ')}]`,
    '---',
    '',
    `# ${artifact.name} (skill pack)`,
    '',
    manifest.description ??
      `A Threadnote skill pack bundling ${skillNames.length} skill(s) and their shared support files (${memberCount} files total).`,
    '',
    '## Skills',
    ...skillNames.map(skill => `- ${skill}`),
    '',
    '## Requirements',
    'Threadnote installs files only. Ensure these exist on the target machine before running:',
  ];
  if (manifest.deps.runtime.length > 0) {
    lines.push(`- runtime: ${manifest.deps.runtime.join(', ')}`);
  }
  if (manifest.deps.cli.length > 0) {
    lines.push(`- CLI: ${manifest.deps.cli.join(', ')}`);
  }
  if (manifest.deps.os.length > 0) {
    lines.push(`- OS: ${manifest.deps.os.join(', ')}`);
  }
  if (manifest.deps.mcp.length > 0) {
    lines.push(`- MCP (configure separately): ${manifest.deps.mcp.join(', ')}`);
  }
  lines.push('', `Install: threadnote share install-artifacts --kind pack --name ${artifact.name} --apply`, '');
  return lines.join('\n');
}

function buildPackManifestJson(
  artifact: ShareArtifactMetadata,
  manifest: PackManifest,
  prepared: readonly PreparedBundleMember[],
): string {
  const data = {
    artifact,
    deps: manifest.deps,
    members: prepared
      .map(entry => ({binary: entry.binary, path: entry.relativePath, sha256: entry.sha256}))
      .sort((a, b) => compareStrings(a.path, b.path)),
    version: BUNDLE_MANIFEST_VERSION,
  };
  return `${JSON.stringify(data, undefined, 2)}\n`;
}

const packSkillName = Effect.fn('share.packSkillName')(function* (skillEntry: string) {
  const trimmed = skillEntry.replace(/\/SKILL\.md$/i, '');
  return yield* pathBasename(trimmed);
});

export const shareBundlePack = Effect.fn('share.shareBundlePack')(function* (
  config: ShareRuntime,
  manifestPath: string,
  options: SharePublishArtifactOptions,
) {
  const team = yield* resolveTeam(config, options.team);
  assertShareTeamWritable(team, 'publish agent artifact bundles');
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  const resolvedManifest = yield* expandPath(manifestPath);
  if (!(yield* isRegularFileNoSymlink(resolvedManifest))) {
    throw ShareOperationError.make({message: `Pack manifest is not a regular file: ${resolvedManifest}`});
  }
  const manifest = yield* parsePackManifest(yield* readFile(resolvedManifest, 'utf8'), resolvedManifest);
  const manifestDir = yield* pathDirname(resolvedManifest);
  const artifact: ShareArtifactMetadata = {agent: manifest.agent, kind: 'pack', name: uriSegment(manifest.name)};
  const skillNames = yield* Effect.forEach(manifest.skills, packSkillName);

  const members = yield* collectPackMembers(manifestDir, manifest);
  // Auto-derive the manifest dir as a rewrite root only when it is a plausible
  // repo root (>= 2 path segments); a short top-level dir like /tmp would
  // substring-corrupt unrelated paths. Declared pathRewrites are already guarded.
  const autoRoots = manifestDir.split('/').filter(Boolean).length >= 2 ? [manifestDir] : [];
  // Longest-first so a nested declared root rewrites before its parent.
  const rewriteRoots = [...new Set([...autoRoots, ...manifest.pathRewrites])].sort((a, b) => b.length - a.length);

  const packRootRelative = `${SHAREABLE_ARTIFACT_DIR}/packs/${artifact.agent}/${artifact.name}`;
  const filesRelative = `${packRootRelative}/${PACK_FILES_DIR}`;
  const indexRelative = `${packRootRelative}/${artifact.name}${PACK_INDEX_SUFFIX}`;
  const manifestRelative = `${packRootRelative}/${artifact.name}${PACK_MANIFEST_SUFFIX}`;
  const filesTargetDir = yield* pathJoin(team.config.worktree, ...filesRelative.split('/'));
  const packRootTargetDir = yield* pathJoin(team.config.worktree, ...packRootRelative.split('/'));
  const indexTargetPath = yield* pathJoin(team.config.worktree, ...indexRelative.split('/'));
  const indexTargetUri = yield* workfileToResourceUri(config, team.config, indexTargetPath);

  const prepared = yield* Effect.forEach(members, member =>
    preparePackMember(config, team, member, filesTargetDir, rewriteRoots, options),
  );
  // Tokenize the generated index + manifest too (not just member files) so an
  // author repo-root path embedded in description/deps is normalized to the
  // portable token. The memory-share scrubber does not run on these files.
  const indexContent = tokenizePackPaths(buildPackIndex(artifact, manifest, skillNames, prepared.length), rewriteRoots);

  const messages: string[] = [
    `${preview ? 'Previewing' : dryRun ? 'Would share' : 'Sharing'} pack ${artifact.agent}/${artifact.name} (${prepared.length} files, ${skillNames.length} skills)`,
    `Source: ${yield* portablePath(manifestDir)}`,
    `Destination: ${indexTargetUri}`,
  ];
  appendIgnoredArtifactRedactNote(messages, options);

  const blockers = prepared.filter(entry => entry.blocker !== undefined);
  if (preview) {
    for (const entry of prepared) {
      const flags = entry.binary ? ['binary'] : [];
      const note = entry.blocker !== undefined ? ` BLOCKED: ${entry.blocker}` : '';
      messages.push(`  ${entry.relativePath}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}${note}`);
    }
    return {
      artifact,
      gitMessages: [],
      messages,
      previewContent: indexContent,
      sourcePath: resolvedManifest,
      targetPath: indexTargetPath,
      targetUri: indexTargetUri,
    };
  }

  if (blockers.length > 0) {
    throw ShareOperationError.make({
      message: `Refusing to share pack ${artifact.agent}/${artifact.name}: ${blockers
        .map(entry => `${entry.relativePath} (${entry.blocker})`)
        .join('; ')}. Strip the value or pass --allow-binary for binary files.`,
    });
  }
  const packJson = tokenizePackPaths(buildPackManifestJson(artifact, manifest, prepared), rewriteRoots);
  // Advisory: surface machine-local absolute paths that pathRewrites did not
  // tokenize (e.g. /opt, /srv, /Volumes, Windows C:\) so the author can add a
  // rewrite or strip them. Non-blocking — many absolute paths are portable.
  const unportable = new Set<string>();
  for (const entry of prepared) {
    if (!entry.binary && typeof entry.content === 'string') {
      for (const path of unportableAbsolutePaths(entry.content)) {
        unportable.add(`${entry.relativePath}: ${path}`);
      }
    }
  }
  for (const path of unportableAbsolutePaths(indexContent)) {
    unportable.add(`${artifact.name}${PACK_INDEX_SUFFIX}: ${path}`);
  }
  for (const path of unportableAbsolutePaths(packJson)) {
    unportable.add(`${artifact.name}${PACK_MANIFEST_SUFFIX}: ${path}`);
  }
  if (unportable.size > 0) {
    messages.push(
      `Warning: possible machine-local absolute path(s) that will not resolve on a teammate's machine (declare in pathRewrites or strip if not portable): ${[...unportable].join('; ')}`,
    );
  }
  for (const entry of prepared) {
    const existing = yield* readFileBytesIfExists(entry.targetPath);
    if (existing !== undefined && (yield* sha256(existing)) !== entry.sha256 && options.force !== true) {
      throw ShareOperationError.make({
        message: `Shared pack file already exists with different content: ${yield* portablePath(entry.targetPath)}. Pass --force to replace it.`,
      });
    }
  }

  if (dryRun) {
    messages.push(`Would write ${prepared.length} files under ${yield* portablePath(packRootTargetDir)}`);
    return {
      artifact,
      gitMessages: [],
      messages,
      sourcePath: resolvedManifest,
      targetPath: indexTargetPath,
      targetUri: indexTargetUri,
    };
  }

  // Safety invariant: native canonical store-managed markdown is written first (the index
  // leads), so a failed OV write never leaves a worktree tree that a later share
  // sync would auto-commit without ingestion.
  const ov = NATIVE_RESOURCE_BACKEND;
  // Restore-capable rollback: before overwriting any resource, snapshot its prior
  // bytes; on a mid-publish failure, undo in reverse — newly-created resources are
  // removed and replaced ones (a --force re-publish) are restored to their prior
  // content. This leaves the previously-published pack intact and nothing
  // inconsistent for a later share sync to auto-commit.
  const rollbacks: Array<
    () => Effect.Effect<void, unknown, CommandExecutor | FileSystem.FileSystem | Path.Path | ResourceStore | SystemInfo>
  > = [];
  const manifestTargetPath = yield* pathJoin(team.config.worktree, ...manifestRelative.split('/'));
  const publishResult = yield* Effect.result(
    Effect.gen(function* () {
      const writeMarkdownMember = Effect.fn('share.callback')(function* (
        uri: string,
        content: string,
        worktreePath: string,
      ) {
        const priorBytes = yield* readFileBytesIfExists(worktreePath);
        const hadResource = yield* resourceExists(ov, config, uri);
        const worktreeRelativePath = (yield* pathRelative(team.config.worktree, worktreePath))
          .split(yield* pathSeparator)
          .join('/');
        yield* ensureSharedDirectoryChain(config, ov, uri, dryRun, {quiet: true});
        yield* writeMemoryFile(config, ov, uri, content, hadResource ? 'replace' : 'create', dryRun, {quiet: true});
        yield* writeSharedWorktreeFile(team.config.worktree, worktreeRelativePath, content, dryRun);
        rollbacks.push(
          Effect.fn('share.callback')(function* () {
            if (priorBytes !== undefined) {
              yield* writeMemoryFile(config, ov, uri, new TextDecoder().decode(priorBytes), 'replace', false, {
                quiet: true,
              });
              yield* writeSharedWorktreeFile(
                team.config.worktree,
                worktreeRelativePath,
                new TextDecoder().decode(priorBytes),
                false,
              );
            } else {
              if (yield* resourceExists(ov, config, uri)) {
                yield* removeMemoryUri(config, ov, uri, false, {quiet: true});
              }
              yield* rm(worktreePath, {force: true});
            }
          }),
        );
      });
      yield* writeMarkdownMember(indexTargetUri, indexContent, indexTargetPath);
      for (const entry of prepared.filter(member => member.relativePath.endsWith('.md'))) {
        const content = bundleTextContent(entry);
        if (content === undefined) {
          throw ShareOperationError.make({message: `Refusing binary markdown pack member: ${entry.relativePath}`});
        }
        yield* writeMarkdownMember(entry.targetUri, content, entry.targetPath);
      }
      yield* ensureDirectory(filesTargetDir, false);
      for (const entry of prepared.filter(member => !member.relativePath.endsWith('.md'))) {
        const priorBytes = yield* readFileBytesIfExists(entry.targetPath);
        yield* ensureDirectory(yield* pathDirname(entry.targetPath), false);
        yield* writeFile(
          entry.targetPath,
          entry.content,
          entry.binary ? {mode: 0o600} : {encoding: 'utf8', mode: 0o600},
        );
        rollbacks.push(
          Effect.fn('share.callback')(function* () {
            if (priorBytes !== undefined) {
              yield* writeFile(entry.targetPath, priorBytes, {mode: 0o600});
            } else {
              yield* rm(entry.targetPath, {force: true});
            }
          }),
        );
      }
      yield* ensureDirectory(packRootTargetDir, false);
      const priorManifest = yield* readFileBytesIfExists(manifestTargetPath);
      yield* writeFile(manifestTargetPath, packJson, {encoding: 'utf8', mode: 0o600});
      rollbacks.push(
        Effect.fn('share.callback')(function* () {
          if (priorManifest !== undefined) {
            yield* writeFile(manifestTargetPath, priorManifest, {mode: 0o600});
          } else {
            yield* rm(manifestTargetPath, {force: true});
          }
        }),
      );

      // Prune files orphaned by a re-publish (members dropped from the manifest) so
      // stale code is neither carried in the shared repo nor installed by teammates.
      const currentFiles = new Set(prepared.map(entry => `${filesRelative}/${entry.relativePath}`));
      const git = yield* requiredExecutable('git');
      const tracked = yield* runCommand(git, ['-C', team.config.worktree, 'ls-files', '--', filesRelative], {
        allowFailure: true,
      });
      const stalePaths =
        tracked.exitCode === 0
          ? tracked.stdout
              .split('\n')
              .map(line => line.trim())
              .filter(line => line.length > 0 && !currentFiles.has(line))
          : [];
      for (const stale of stalePaths) {
        yield* runCommand(git, ['-C', team.config.worktree, 'rm', '-f', '--ignore-unmatch', '--', stale], {
          allowFailure: true,
        });
        // Nested .md members are OV-ingested, so drop their resource too — keep the
        // native canonical store index and the git tree in lockstep on the publisher's machine.
        // Best-effort: the `git rm` deletion is already staged, so a single OV
        // removal failure must not abort the publish (which would leave a staged
        // deletion behind for a later sync); surface it as a warning instead.
        if (stale.endsWith('.md')) {
          const staleUri = yield* workfileToResourceUri(
            config,
            team.config,
            yield* pathJoin(team.config.worktree, ...stale.split('/')),
          );
          const pruneResult = yield* Effect.result(
            Effect.gen(function* () {
              if (yield* resourceExists(ov, config, staleUri)) {
                yield* removeMemoryUri(config, ov, staleUri, dryRun, {quiet: true});
              }
            }),
          );
          if (Result.isFailure(pruneResult)) {
            const pruneErr = pruneResult.failure;
            messages.push(
              `Warning: could not remove stale native canonical store resource ${staleUri}: ${pruneErr instanceof Error ? pruneErr.message : String(pruneErr)}`,
            );
          }
        }
      }
    }),
  );
  if (Result.isFailure(publishResult)) {
    for (const undo of rollbacks.reverse()) {
      // Best-effort rollback; surface the original failure regardless.
      yield* undo().pipe(Effect.ignore);
    }
    return yield* publishResult.failure;
  }

  const stagedPaths = [
    indexRelative,
    manifestRelative,
    ...prepared.map(entry => `${filesRelative}/${entry.relativePath}`),
  ];
  const message =
    options.message ?? `share: publish pack ${artifact.agent}/${artifact.name} (${prepared.length} files)`;
  const gitMessages = yield* publishShareGitChange(team.config.worktree, stagedPaths, message, {
    dryRun,
    push: options.push,
  });
  return {
    artifact,
    gitMessages,
    messages,
    sourcePath: resolvedManifest,
    targetPath: indexTargetPath,
    targetUri: indexTargetUri,
  };
});

const inferShareArtifact = Effect.fn('share.inferShareArtifact')(function* (
  path: string,
  options: SharePublishArtifactOptions,
) {
  const normalizedPath = path.split(yield* pathSeparator).join('/');
  const fileName = yield* pathBasename(path);
  const lowerFileName = fileName.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();
  const inferredKind: ShareAgentArtifactKind | undefined =
    lowerFileName === 'skill.md'
      ? 'skill'
      : lowerPath.includes('/.claude/commands/') && lowerFileName.endsWith('.md')
        ? 'command'
        : undefined;
  const inferredAgent: ShareAgentArtifactAgent | undefined = lowerPath.includes('/.codex/skills/')
    ? 'codex'
    : lowerPath.includes('/.claude/skills/') || lowerPath.includes('/.claude/commands/')
      ? 'claude'
      : lowerPath.includes('/.cursor/skills/')
        ? 'cursor'
        : undefined;
  const extensionIndex = fileName.lastIndexOf('.');
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  const inferredName = lowerFileName === 'skill.md' ? yield* pathBasename(yield* pathDirname(path)) : stem;
  const kind = options.kind ?? inferredKind;
  const agent = options.agent ?? inferredAgent;
  const name = options.name ?? inferredName;

  if (kind !== 'skill' && kind !== 'command') {
    throw ShareOperationError.make({message: 'Could not infer artifact kind. Pass --kind skill or --kind command.'});
  }
  if (agent !== 'codex' && agent !== 'claude' && agent !== 'cursor') {
    throw ShareOperationError.make({
      message: 'Could not infer artifact agent. Pass --agent codex, --agent claude, or --agent cursor.',
    });
  }
  if (kind === 'skill' && lowerFileName !== 'skill.md') {
    throw ShareOperationError.make({message: 'Skill artifacts must point at a SKILL.md file.'});
  }
  if (kind === 'command' && !lowerFileName.endsWith('.md')) {
    throw ShareOperationError.make({message: 'Command artifacts must be Markdown files.'});
  }
  if (kind === 'command' && agent !== 'claude') {
    throw ShareOperationError.make({message: 'Only Claude command artifacts are supported.'});
  }
  if (name.trim().length === 0) {
    throw ShareOperationError.make({message: 'Artifact name cannot be empty.'});
  }
  return {agent, kind, name: uriSegment(name)};
});

function sharedArtifactRelativePath(artifact: ShareArtifactMetadata): string {
  if (artifact.kind === 'skill') {
    return `${SHAREABLE_ARTIFACT_DIR}/skills/${artifact.agent}/${artifact.name}/SKILL.md`;
  }
  return `${SHAREABLE_ARTIFACT_DIR}/commands/${artifact.agent}/${artifact.name}.md`;
}

const printShareArtifactResult = Effect.fn('share.printShareArtifactResult')(function* (
  result: ShareArtifactResult,
  preview: boolean,
) {
  for (const message of result.messages) {
    yield* Console.log(message);
  }
  for (const gitMessage of result.gitMessages) {
    yield* Console.log(gitMessage);
  }
  if (preview && result.previewContent !== undefined) {
    yield* Console.log('-----BEGIN PREVIEW-----');
    yield* Console.log(result.previewContent);
    yield* Console.log('-----END PREVIEW-----');
  }
});
