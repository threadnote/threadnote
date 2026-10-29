import {Array as EffectArray} from 'effect';
import {Console, DateTime, Effect, FileSystem, Path, Predicate, Result} from 'effect';

import {SystemInfo} from '@threadnote/platform/system';

import {uriSegment} from '@threadnote/workspace/manifest';

import type {ShareInstallArtifactsOptions, ShareListArtifactsOptions, ShareRuntime} from '../../types.js';

import {
  ensureDirectory,
  exists,
  isDirectory,
  isFile,
  parseJsonConfigObject,
  portablePath,
  readFileIfExists,
  sha256,
} from '../../utils.js';

import {
  collectBundleMemberFiles,
  compareStrings,
  isBundleArtifact,
  isProbablyBinary,
  readFileBytesIfExists,
} from './support.js';

import type {
  BundleMemberFile,
  ShareArtifactMetadata,
  SharedArtifactFile,
  SharedArtifactInstallMetadata,
  SharedArtifactInstallState,
  SharedArtifactInstallStatus,
  SharedArtifactSummary,
} from '../core.js';

import {
  ARTIFACT_INSTALL_METADATA_VERSION,
  BUNDLE_INSTALL_METADATA_FILE,
  BUNDLE_MANIFEST_FILE,
  PACK_FILES_DIR,
  PACK_INDEX_SUFFIX,
  PACK_MANIFEST_SUFFIX,
  PACK_ROOT_TOKEN,
  SHAREABLE_ARTIFACT_DIR,
  ShareOperationError,
  pathDirname,
  pathIsAbsolute,
  pathJoin,
  pathRelative,
  pathSeparator,
  readFile,
  readdir,
  rename,
  resolveTeam,
  rm,
  writeFile,
} from '../core.js';

import {syncSharedReposBeforeAgentRead} from '../sync.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const runShareInstallArtifacts = Effect.fn('share.runShareInstallArtifacts')(function* (
  config: ShareRuntime,
  options: ShareInstallArtifactsOptions,
) {
  const result = yield* installSharedAgentArtifacts(config, options);
  if (result.syncedTeams.length > 0) {
    yield* Console.log(`Synced shared teams: ${EffectArray.join(result.syncedTeams, ', ')}`);
  }
  for (const warning of result.warnings) {
    yield* Console.warn(`Warning: ${warning}`);
  }
  for (const message of result.messages) {
    yield* Console.log(message);
  }
});

export const listSharedAgentArtifacts = Effect.fn('share.listSharedAgentArtifacts')(function* (
  config: ShareRuntime,
  options: ShareListArtifactsOptions = {},
) {
  const syncResult = yield* maybeSyncSharedArtifacts(config, options);
  const team = yield* resolveTeam(config, options.team);
  const artifacts = filterSharedArtifacts(yield* collectSharedArtifacts(team.config.worktree, team.name), options);
  const summaries: SharedArtifactSummary[] = [];
  for (const artifact of artifacts) {
    summaries.push({
      ...artifact,
      installStatus: yield* sharedArtifactInstallStatus(artifact),
      metadataPath: sharedArtifactMetadataPath(artifact),
    });
  }
  return {artifacts: summaries, syncedTeams: syncResult.syncedTeams, team: team.name, warnings: syncResult.warnings};
});

export const installSharedAgentArtifacts = Effect.fn('share.installSharedAgentArtifacts')(function* (
  config: ShareRuntime,
  options: ShareInstallArtifactsOptions,
) {
  const syncResult = yield* maybeSyncSharedArtifacts(config, options);
  const team = yield* resolveTeam(config, options.team);
  const dryRun = options.dryRun === true || options.apply !== true;
  const allArtifacts = yield* collectSharedArtifacts(team.config.worktree, team.name);
  const artifacts = filterSharedArtifacts(allArtifacts, options);
  const messages: string[] = [];
  if (artifacts.length === 0) {
    const filters = sharedArtifactFilterLabel(options);
    if (filters) {
      throw ShareOperationError.make({
        message: `No shared agent artifacts found for team "${team.name}" matching ${filters}.`,
      });
    }
    return {
      installedCount: 0,
      messages: [`No shared agent artifacts found for team "${team.name}".`],
      syncedTeams: syncResult.syncedTeams,
      team: team.name,
      warnings: syncResult.warnings,
    };
  }
  if (
    options.name !== undefined &&
    artifacts.length > 1 &&
    (options.agent === undefined || options.kind === undefined)
  ) {
    throw ShareOperationError.make({
      message: `Shared artifact "${options.name}" is ambiguous. Specify agent and kind. Matches: ${EffectArray.join(
        EffectArray.map(artifacts, artifact => sharedArtifactLabel(artifact.artifact)),
        ', ',
      )}`,
    });
  }
  let installedCount = 0;
  for (const artifact of artifacts) {
    if (isBundleArtifact(artifact)) {
      installedCount += yield* installBundleArtifact(artifact, options, dryRun, messages);
      continue;
    }
    const label = sharedArtifactLabel(artifact.artifact);
    const state = yield* sharedArtifactInstallState(artifact);
    if (dryRun) {
      const verb = sharedArtifactDryRunVerb(state.status, options.force === true);
      const suffix = sharedArtifactDryRunSuffix(state.status, options.force === true);
      messages.push(`${verb} ${label}: ${yield* portablePath(artifact.installPath)}${suffix}`);
      continue;
    }
    if (
      (state.status === 'local_modified' || state.status === 'remote_changed_and_local_modified') &&
      options.force !== true
    ) {
      throw ShareOperationError.make({
        message: `Refusing to overwrite ${yield* portablePath(artifact.installPath)}. Pass force=true or --force.`,
      });
    }
    if (state.status === 'current') {
      yield* writeSharedArtifactMetadata(artifact, state.sourceSha);
      messages.push(`Already installed ${label}: ${yield* portablePath(artifact.installPath)}`);
      continue;
    }
    yield* ensureDirectory(yield* pathDirname(artifact.installPath), false);
    yield* writeFile(artifact.installPath, state.sourceContent, {encoding: 'utf8', mode: 0o600});
    yield* writeSharedArtifactMetadata(artifact, state.sourceSha);
    installedCount += 1;
    messages.push(
      `${sharedArtifactInstallVerb(state.status, options.force === true)} ${label}: ${yield* portablePath(artifact.installPath)}`,
    );
  }
  return {
    installedCount,
    messages,
    syncedTeams: syncResult.syncedTeams,
    team: team.name,
    warnings: syncResult.warnings,
  };
});

function sharedArtifactFromRelativePath(relativePath: string): ShareArtifactMetadata | undefined {
  const parts = Effect2.pipe(relativePath, EffectString.split('/'));
  if (parts[0] !== SHAREABLE_ARTIFACT_DIR) {
    return undefined;
  }
  if (
    parts.length === 5 &&
    parts[1] === 'skills' &&
    (parts[2] === 'codex' || parts[2] === 'claude' || parts[2] === 'cursor') &&
    parts[4] === 'SKILL.md'
  ) {
    return {agent: parts[2], kind: 'skill', name: parts[3]};
  }
  if (
    parts.length === 4 &&
    parts[1] === 'commands' &&
    parts[2] === 'claude' &&
    Effect2.pipe(parts[3], EffectString.endsWith('.md'))
  ) {
    return {agent: 'claude', kind: 'command', name: Effect2.pipe(parts[3], EffectString.slice(0, -'.md'.length))};
  }
  if (
    parts.length === 5 &&
    parts[1] === 'packs' &&
    (parts[2] === 'codex' || parts[2] === 'claude' || parts[2] === 'cursor') &&
    parts[4] === `${parts[3]}${PACK_INDEX_SUFFIX}`
  ) {
    return {agent: parts[2], kind: 'pack', name: parts[3]};
  }
  return undefined;
}

const collectSharedArtifacts = Effect.fn('share.collectSharedArtifacts')(function* (worktree: string, team: string) {
  const root = yield* pathJoin(worktree, SHAREABLE_ARTIFACT_DIR);
  if (!(yield* isDirectory(root))) {
    return [];
  }
  const out: SharedArtifactFile[] = [];
  const visit: (path: string) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path | SystemInfo> =
    Effect.fn('share.visit')(function* (path: string) {
      const entries = yield* readdir(path, {withFileTypes: true});
      for (const entry of entries) {
        const full = yield* pathJoin(path, entry.name);
        if (entry.isDirectory()) {
          yield* visit(full);
          continue;
        }
        if (!entry.isFile() || !Effect2.pipe(entry.name, EffectString.endsWith('.md'))) {
          continue;
        }
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
        const relativePath = EffectArray.join((yield* pathRelative(worktree, full)).split(yield* pathSeparator), '/');
        const artifact = sharedArtifactFromRelativePath(relativePath);
        if (artifact === undefined) {
          continue;
        }
        const artifactDir = yield* pathDirname(full);
        // An orphaned pack index without its .pack.json is an incomplete/partial
        // publish; skip it so it neither pollutes the catalog nor breaks discovery.
        if (
          artifact.kind === 'pack' &&
          !(yield* isFile(yield* pathJoin(artifactDir, `${artifact.name}${PACK_MANIFEST_SUFFIX}`)))
        ) {
          yield* Console.warn(
            `Skipping incomplete shared pack (missing ${artifact.name}${PACK_MANIFEST_SUFFIX}): ${relativePath}`,
          );
          continue;
        }
        // Isolate per-artifact discovery failures so one malformed artifact never
        // denies listing/install of the rest of the team's catalog.
        const artifactResult = yield* Effect.result(
          Effect.gen(function* () {
            return {
              artifact,
              installPath: yield* sharedArtifactInstallPath(team, artifact),
              members: yield* collectArtifactMembers(artifact, artifactDir),
              sourcePath: full,
              sourceRelativePath: relativePath,
              team,
            } satisfies SharedArtifactFile;
          }),
        );
        if (Result.isSuccess(artifactResult)) {
          out.push(artifactResult.success);
        } else {
          const err = artifactResult.failure;
          yield* Console.warn(
            `Skipping shared artifact ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
  yield* visit(root);
  return out.sort((a, b) => Effect2.pipe(a.sourcePath, EffectString.localeCompare(b.sourcePath)));
});

const collectArtifactMembers = Effect.fn('share.collectArtifactMembers')(function* (
  artifact: ShareArtifactMetadata,
  artifactDir: string,
) {
  if (artifact.kind === 'skill') {
    return yield* collectSharedBundleMembers(artifactDir);
  }
  if (artifact.kind === 'pack') {
    return yield* collectSharedPackMembers(artifact, artifactDir);
  }
  return undefined;
});

// A pack's installable members come from its published .pack.json (the
// authoritative list), so files orphaned in files/ by a removal are not
// installed. Falls back to walking files/ when the manifest is missing.
// A manifest member path must stay within its base directory: the .pack.json /
// bundle manifest is git-carried (not scrubbed), so a malicious or corrupted
// shared repo could otherwise use `..` or an absolute path to read/write outside
// the install root.
const isContainedMemberPath = Effect.fn('share.isContainedMemberPath')(function* (
  baseDir: string,
  relativePath: string,
) {
  if ((yield* pathIsAbsolute(relativePath)) || Effect2.pipe(relativePath, EffectString.split('/')).includes('..')) {
    return false;
  }
  const resolved = yield* pathJoin(baseDir, ...Effect2.pipe(relativePath, EffectString.split('/')));
  return resolved === baseDir || Effect2.pipe(resolved, EffectString.startsWith(baseDir + (yield* pathSeparator)));
});

const collectSharedPackMembers = Effect.fn('share.collectSharedPackMembers')(function* (
  artifact: ShareArtifactMetadata,
  packDir: string,
) {
  const filesDir = yield* pathJoin(packDir, PACK_FILES_DIR);
  if (!(yield* isDirectory(filesDir))) {
    return [];
  }
  const manifestRaw = yield* readFileIfExists(yield* pathJoin(packDir, `${artifact.name}${PACK_MANIFEST_SUFFIX}`));
  if (manifestRaw !== undefined) {
    const rawMembers = parseJsonConfigObject(manifestRaw)?.members;
    if (EffectArray.isArray(rawMembers)) {
      const fromManifest: BundleMemberFile[] = [];
      for (const entry of rawMembers) {
        const path = memberPath(entry);
        if (typeof path === 'string' && path.length > 0) {
          if (!(yield* isContainedMemberPath(filesDir, path))) {
            return yield* ShareOperationError.make({
              message: `Refusing pack member with an unsafe path that escapes the pack root: ${path}`,
            });
          }
          fromManifest.push({
            absolutePath: yield* pathJoin(filesDir, ...Effect2.pipe(path, EffectString.split('/'))),
            relativePath: path,
          });
        }
      }
      if (fromManifest.length > 0) {
        return fromManifest.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
      }
    }
  }
  return yield* collectBundleMemberFiles(filesDir);
});

// Members of a shared skill directory. Prefers the published manifest as the
// authoritative member list; falls back to walking the directory when it is a
// legacy single-file skill or the manifest is unreadable.
const collectSharedBundleMembers = Effect.fn('share.collectSharedBundleMembers')(function* (skillDir: string) {
  const manifestRaw = yield* readFileIfExists(yield* pathJoin(skillDir, BUNDLE_MANIFEST_FILE));
  if (manifestRaw !== undefined) {
    const parsed = parseJsonConfigObject(manifestRaw);
    const rawMembers = parsed?.members;
    if (EffectArray.isArray(rawMembers)) {
      const fromManifest: BundleMemberFile[] = [];
      for (const entry of rawMembers) {
        const path = memberPath(entry);
        if (typeof path === 'string' && path.length > 0) {
          if (!(yield* isContainedMemberPath(skillDir, path))) {
            return yield* ShareOperationError.make({
              message: `Refusing skill member with an unsafe path that escapes the skill root: ${path}`,
            });
          }
          fromManifest.push({
            absolutePath: yield* pathJoin(skillDir, ...Effect2.pipe(path, EffectString.split('/'))),
            relativePath: path,
          });
        }
      }
      if (fromManifest.length > 0) {
        return fromManifest.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
      }
    }
  }
  return yield* collectBundleMemberFiles(skillDir);
});

function filterSharedArtifacts(
  artifacts: readonly SharedArtifactFile[],
  options: ShareInstallArtifactsOptions | ShareListArtifactsOptions,
): readonly SharedArtifactFile[] {
  const name = options.name === undefined ? undefined : uriSegment(options.name);
  return EffectArray.filter(artifacts, artifact => {
    if (options.agent !== undefined && artifact.artifact.agent !== options.agent) {
      return false;
    }
    if (options.kind !== undefined && artifact.artifact.kind !== options.kind) {
      return false;
    }
    if (name !== undefined && artifact.artifact.name !== name) {
      return false;
    }
    return true;
  });
}

const maybeSyncSharedArtifacts = Effect.fn('share.maybeSyncSharedArtifacts')(function* (
  config: ShareRuntime,
  options: ShareInstallArtifactsOptions | ShareListArtifactsOptions,
) {
  if (options.sync === false) {
    return {syncedTeams: [], warnings: []};
  }
  return yield* syncSharedReposBeforeAgentRead(config);
});

const sharedArtifactInstallStatus = Effect.fn('share.sharedArtifactInstallStatus')(function* (
  artifact: SharedArtifactFile,
) {
  if (isBundleArtifact(artifact)) {
    return yield* sharedBundleInstallStatus(artifact);
  }
  return (yield* sharedArtifactInstallState(artifact)).status;
});

interface BundleInstallMemberMetadata {
  readonly installedSha256: string;
  readonly sourceSha256: string;
}

const bundleInstallRoot = Effect.fn('share.bundleInstallRoot')(function* (artifact: SharedArtifactFile) {
  // A pack installs as a whole tree, so its installPath is already the root; a
  // skill bundle's installPath is the SKILL.md, so the root is its parent.
  return artifact.artifact.kind === 'pack' ? artifact.installPath : yield* pathDirname(artifact.installPath);
});

const bundleInstallMetadataPath = Effect.fn('share.bundleInstallMetadataPath')(function* (
  artifact: SharedArtifactFile,
) {
  return yield* pathJoin(yield* bundleInstallRoot(artifact), BUNDLE_INSTALL_METADATA_FILE);
});

const readBundleInstallMetadata = Effect.fn('share.readBundleInstallMetadata')(function* (
  artifact: SharedArtifactFile,
) {
  const raw = yield* readFileIfExists(yield* bundleInstallMetadataPath(artifact));
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseJsonConfigObject(raw);
  if (
    parsed === undefined ||
    parsed.version !== ARTIFACT_INSTALL_METADATA_VERSION ||
    !EffectArray.isArray(parsed.members)
  ) {
    return undefined;
  }
  // Only trust metadata this artifact wrote for itself; a file left by a
  // different artifact sharing the install root must not be read as our state.
  if (!artifactMetadataMatches(parsed.artifact, artifact.artifact) || parsed.team !== artifact.team) {
    return undefined;
  }
  const map = new Map<string, BundleInstallMemberMetadata>();
  for (const entry of parsed.members) {
    const path = memberPath(entry);
    const sourceSha256 = memberString(entry, 'sourceSha256');
    const installedSha256 = memberString(entry, 'installedSha256');
    if (typeof path === 'string' && typeof sourceSha256 === 'string' && typeof installedSha256 === 'string') {
      map.set(path, {installedSha256, sourceSha256});
    }
  }
  return map;
});

// Folds per-member 3-way comparison (source vs installed vs recorded) into one
// bundle status. A local edit to one member and an upstream change to a
// different member both surface as remote_changed_and_local_modified so install
// refuses to silently clobber local work.
const sharedBundleInstallStatus = Effect.fn('share.sharedBundleInstallStatus')(function* (
  artifact: SharedArtifactFile,
) {
  const members = artifact.members ?? [];
  const installRoot = yield* bundleInstallRoot(artifact);
  const metadata = yield* readBundleInstallMetadata(artifact);
  // Expected on-disk bytes after the same transform install applies, so the
  // no-metadata fallback can recognize a pristine (token-expanded) install as
  // current instead of misreading it as a local modification.
  const expanded = yield* prepareInstallMembers(members, installRoot, artifact.artifact.kind === 'pack');
  const expectedByPath = new Map(EffectArray.map(expanded, entry => [entry.relativePath, entry]));
  let installedCount = 0;
  let localChanged = false;
  let remoteChanged = false;
  const memberPaths = new Set<string>();
  for (const member of members) {
    memberPaths.add(member.relativePath);
    const expected = expectedByPath.get(member.relativePath);
    if (expected === undefined) {
      // Shared source is missing (partial sync / corrupt repo): not pristine, so
      // surface it as an available update rather than crashing the whole listing.
      remoteChanged = true;
      continue;
    }
    const installedBytes = yield* readFileBytesIfExists(
      yield* pathJoin(installRoot, ...Effect2.pipe(member.relativePath, EffectString.split('/'))),
    );
    if (installedBytes === undefined) {
      remoteChanged = true;
      continue;
    }
    installedCount += 1;
    const installedSha = yield* sha256(installedBytes);
    const recorded = metadata?.get(member.relativePath);
    if (recorded === undefined) {
      // No recorded baseline (sidecar lost or a future-version sidecar): a byte
      // mismatch is ambiguous (local edit vs upstream change). Treat it as a
      // local modification — like the single-file path — so install blocks until
      // --force rather than silently clobbering possible local work. A pristine
      // install still matches expected.installedSha256, so it stays `current`.
      if (installedSha !== expected?.installedSha256) {
        localChanged = true;
      }
      continue;
    }
    if (installedSha !== recorded.installedSha256) {
      localChanged = true;
    }
    if (expected?.sourceSha256 !== recorded.sourceSha256) {
      remoteChanged = true;
    }
  }
  if (metadata !== undefined) {
    for (const [recordedPath, recorded] of metadata) {
      if (memberPaths.has(recordedPath)) {
        continue;
      }
      remoteChanged = true;
      // The member was dropped upstream; if the user edited the now-orphaned
      // local copy, flag it so the install refuses to delete it without --force.
      const installedBytes = yield* readFileBytesIfExists(
        yield* pathJoin(installRoot, ...Effect2.pipe(recordedPath, EffectString.split('/'))),
      );
      if (installedBytes !== undefined && (yield* sha256(installedBytes)) !== recorded.installedSha256) {
        localChanged = true;
      }
    }
  }
  if (installedCount === 0 && metadata === undefined) {
    return 'not_installed';
  }
  if (localChanged && remoteChanged) {
    return 'remote_changed_and_local_modified';
  }
  if (remoteChanged) {
    return 'update_available';
  }
  if (localChanged) {
    return 'local_modified';
  }
  return 'current';
});

interface PreparedInstallMember {
  readonly installedBytes: Buffer;
  readonly installedSha256: string;
  readonly relativePath: string;
  readonly sourceSha256: string;
}

function expandPackRoot(text: string, installRoot: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
  return EffectArray.join(text.split(PACK_ROOT_TOKEN), installRoot);
}

// Resolves what each member will actually look like on disk. Pack-root token
// expansion applies ONLY to packs (the kinds that tokenize at publish); skill
// bundles are copied byte-for-byte so a literal token in skill content is never
// rewritten. installedSha256 is the on-disk sha (post-expansion), sourceSha256
// the shared-repo sha — the split keeps update vs local-edit detection correct
// even when expansion changes the bytes.
const prepareInstallMembers = Effect.fn('share.prepareInstallMembers')(function* (
  members: readonly BundleMemberFile[],
  installRoot: string,
  expandTokens: boolean,
) {
  const prepared = yield* Effect.forEach(
    members,
    Effect.fn('share.callback')(function* (member) {
      // A member declared in the manifest but absent from files/ (partial sync /
      // corrupt repo) is skipped rather than crashing the whole list/install.
      const sourceBytes = yield* readFileBytesIfExists(member.absolutePath);
      if (sourceBytes === undefined) {
        return undefined;
      }
      const installedBytes =
        expandTokens && !isProbablyBinary(sourceBytes)
          ? new TextEncoder().encode(expandPackRoot(new TextDecoder().decode(sourceBytes), installRoot))
          : sourceBytes;
      return {
        installedBytes,
        installedSha256: yield* sha256(installedBytes),
        relativePath: member.relativePath,
        sourceSha256: yield* sha256(sourceBytes),
      };
    }),
  );
  return EffectArray.filter(prepared, (member): member is PreparedInstallMember => member !== undefined);
});

function serializeInstallMetadata(artifact: SharedArtifactFile, prepared: readonly PreparedInstallMember[]): string {
  const metadata = {
    artifact: artifact.artifact,
    installedAt: new Date().toISOString(),
    members: EffectArray.map(prepared, entry => ({
      installedSha256: entry.installedSha256,
      path: entry.relativePath,
      sourceSha256: entry.sourceSha256,
    })).sort((a, b) => compareStrings(a.path, b.path)),
    team: artifact.team,
    version: ARTIFACT_INSTALL_METADATA_VERSION,
  };
  return `${JSON.stringify(metadata, undefined, 2)}\n`;
}

const installBundleArtifact = Effect.fn('share.installBundleArtifact')(function* (
  artifact: SharedArtifactFile,
  options: ShareInstallArtifactsOptions,
  dryRun: boolean,
  messages: string[],
) {
  const members = artifact.members ?? [];
  const installRoot = yield* bundleInstallRoot(artifact);
  const kindLabel = artifact.artifact.kind === 'pack' ? 'pack' : 'bundle';
  const label = `${sharedArtifactLabel(artifact.artifact)} ${kindLabel} (${members.length} files)`;
  const status = yield* sharedBundleInstallStatus(artifact);
  if (dryRun) {
    const verb = sharedArtifactDryRunVerb(status, options.force === true);
    const suffix = sharedArtifactDryRunSuffix(status, options.force === true);
    messages.push(`${verb} ${label}: ${yield* portablePath(installRoot)}${suffix}`);
    return 0;
  }
  if ((status === 'local_modified' || status === 'remote_changed_and_local_modified') && options.force !== true) {
    throw ShareOperationError.make({
      message: `Refusing to overwrite ${yield* portablePath(installRoot)}. Pass force=true or --force.`,
    });
  }
  const prepared = yield* prepareInstallMembers(members, installRoot, artifact.artifact.kind === 'pack');
  // A declared member whose shared source is unreadable (partial sync / corrupt
  // repo) must not silently drop from the install — that would delete the prior
  // installed copy on a routine update. Refuse unless forced.
  if (prepared.length < members.length && options.force !== true) {
    throw ShareOperationError.make({
      message: `Refusing to install ${yield* portablePath(installRoot)}: ${members.length - prepared.length} declared member(s) are unreadable in the shared pack (the shared worktree may be mid-sync). Retry after sync, or pass force=true / --force.`,
    });
  }
  if (status === 'current') {
    yield* writeFile(yield* bundleInstallMetadataPath(artifact), serializeInstallMetadata(artifact, prepared), {
      mode: 0o600,
    });
    messages.push(`Already installed ${label}: ${yield* portablePath(installRoot)}`);
    yield* surfacePackRequirements(artifact, messages);
    return 0;
  }

  // Materialize into a sibling staging directory, then swap atomically so an
  // interrupted install can never leave a half-written, mixed-version tree.
  const stagingRoot = `${installRoot}.threadnote-staging`;
  yield* rm(stagingRoot, {force: true, recursive: true});
  for (const entry of prepared) {
    const dest = yield* pathJoin(stagingRoot, ...Effect2.pipe(entry.relativePath, EffectString.split('/')));
    yield* ensureDirectory(yield* pathDirname(dest), false);
    yield* writeFile(dest, entry.installedBytes, {mode: 0o600});
  }
  yield* writeFile(
    yield* pathJoin(stagingRoot, BUNDLE_INSTALL_METADATA_FILE),
    serializeInstallMetadata(artifact, prepared),
    {
      mode: 0o600,
    },
  );
  // Swap via a backup rename so the prior install is never lost: if the final
  // rename fails (or the process dies mid-swap), the old tree is either still in
  // place or recoverable from the backup, never gone with nothing to replace it.
  yield* ensureDirectory(yield* pathDirname(installRoot), false);
  const backupRoot = `${installRoot}.threadnote-old`;
  yield* rm(backupRoot, {force: true, recursive: true});
  const hadPriorInstall = yield* exists(installRoot);
  if (hadPriorInstall) {
    yield* rename(installRoot, backupRoot);
  }
  const swapResult = yield* Effect.result(rename(stagingRoot, installRoot));
  if (Result.isFailure(swapResult)) {
    if (hadPriorInstall) {
      yield* rename(backupRoot, installRoot);
    }
    return yield* swapResult.failure;
  }
  yield* rm(backupRoot, {force: true, recursive: true});
  messages.push(
    `${sharedArtifactInstallVerb(status, options.force === true)} ${label}: ${yield* portablePath(installRoot)}`,
  );
  yield* surfacePackRequirements(artifact, messages);
  return 1;
});

// Threadnote ships files, not runtimes or MCP servers. After installing a pack,
// surface its declared external dependencies so the teammate knows what they
// must provision before it will actually run.
const surfacePackRequirements = Effect.fn('share.surfacePackRequirements')(function* (
  artifact: SharedArtifactFile,
  messages: string[],
) {
  if (artifact.artifact.kind !== 'pack') {
    return;
  }
  const raw = yield* readFileIfExists(
    yield* pathJoin(yield* pathDirname(artifact.sourcePath), `${artifact.artifact.name}${PACK_MANIFEST_SUFFIX}`),
  );
  if (raw === undefined) {
    return;
  }
  const deps = parseJsonConfigObject(raw)?.deps;
  if (!Predicate.isObject(deps)) {
    return;
  }
  const stringList = (value: unknown): string[] =>
    EffectArray.isArray(value) ? EffectArray.filter(value, (item): item is string => typeof item === 'string') : [];
  const tooling = [...stringList(deps.runtime), ...stringList(deps.cli), ...stringList(deps.os)];
  const mcp = stringList(deps.mcp);
  if (tooling.length > 0) {
    messages.push(
      `This pack will NOT run until these exist (Threadnote installs files only): ${EffectArray.join(tooling, ', ')}.`,
    );
  }
  if (mcp.length > 0) {
    messages.push(`Configure these MCP server(s) separately: ${EffectArray.join(mcp, ', ')}.`);
  }
});

function artifactMetadataMatches(value: unknown, artifact: ShareArtifactMetadata): boolean {
  return (
    Predicate.isObject(value) &&
    value.agent === artifact.agent &&
    value.kind === artifact.kind &&
    value.name === artifact.name
  );
}

function memberPath(value: unknown): string | undefined {
  return memberString(value, 'path');
}

function memberString(value: unknown, key: string): string | undefined {
  return Predicate.isObject(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

const sharedArtifactInstallState = Effect.fn('share.sharedArtifactInstallState')(function* (
  artifact: SharedArtifactFile,
) {
  const sourceContent = yield* readFile(artifact.sourcePath, 'utf8');
  const sourceSha = yield* sha256(sourceContent);
  const existingContent = (yield* readFileIfExists(artifact.installPath)) ?? undefined;
  if (existingContent === undefined) {
    const state: SharedArtifactInstallState = {sourceContent, sourceSha, status: 'not_installed'};
    return state;
  }
  const existingSha = yield* sha256(existingContent);
  const metadata = yield* readSharedArtifactMetadata(artifact);
  if (existingSha === sourceSha) {
    const state: SharedArtifactInstallState = {
      existingContent,
      existingSha,
      metadata,
      sourceContent,
      sourceSha,
      status: 'current',
    };
    return state;
  }
  if (metadata === undefined) {
    const state: SharedArtifactInstallState = {
      existingContent,
      existingSha,
      sourceContent,
      sourceSha,
      status: 'local_modified',
    };
    return state;
  }
  const remoteChanged = metadata.sourceSha256 !== sourceSha;
  const localChanged = metadata.installedSha256 !== existingSha;
  if (remoteChanged && localChanged) {
    const state: SharedArtifactInstallState = {
      existingContent,
      existingSha,
      metadata,
      sourceContent,
      sourceSha,
      status: 'remote_changed_and_local_modified',
    };
    return state;
  }
  if (remoteChanged) {
    const state: SharedArtifactInstallState = {
      existingContent,
      existingSha,
      metadata,
      sourceContent,
      sourceSha,
      status: 'update_available',
    };
    return state;
  }
  const state: SharedArtifactInstallState = {
    existingContent,
    existingSha,
    metadata,
    sourceContent,
    sourceSha,
    status: 'local_modified',
  };
  return state;
});

const readSharedArtifactMetadata = Effect.fn('share.readSharedArtifactMetadata')(function* (
  artifact: SharedArtifactFile,
) {
  const raw = yield* readFileIfExists(sharedArtifactMetadataPath(artifact));
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseJsonConfigObject(raw);
  if (parsed === undefined || parsed.version !== ARTIFACT_INSTALL_METADATA_VERSION) {
    return undefined;
  }
  const artifactValue = parsed.artifact;
  if (
    typeof parsed.team !== 'string' ||
    typeof parsed.source !== 'string' ||
    typeof parsed.sourceSha256 !== 'string' ||
    typeof parsed.installedSha256 !== 'string' ||
    typeof parsed.installedAt !== 'string' ||
    typeof artifactValue !== 'object' ||
    artifactValue === null ||
    EffectArray.isArray(artifactValue)
  ) {
    return undefined;
  }
  const metadataArtifact = artifactValue as Partial<ShareArtifactMetadata>;
  if (
    metadataArtifact.agent !== artifact.artifact.agent ||
    metadataArtifact.kind !== artifact.artifact.kind ||
    metadataArtifact.name !== artifact.artifact.name
  ) {
    return undefined;
  }
  return {
    artifact: artifact.artifact,
    installedAt: parsed.installedAt,
    installedSha256: parsed.installedSha256,
    source: parsed.source,
    sourceSha256: parsed.sourceSha256,
    team: parsed.team,
    version: ARTIFACT_INSTALL_METADATA_VERSION,
  };
});

const writeSharedArtifactMetadata = Effect.fn('share.writeSharedArtifactMetadata')(function* (
  artifact: SharedArtifactFile,
  sourceSha: string,
) {
  const metadata: SharedArtifactInstallMetadata = {
    artifact: artifact.artifact,
    installedAt: DateTime.formatIso(yield* DateTime.now),
    installedSha256: sourceSha,
    source: artifact.sourceRelativePath,
    sourceSha256: sourceSha,
    team: artifact.team,
    version: ARTIFACT_INSTALL_METADATA_VERSION,
  };
  const metadataPath = sharedArtifactMetadataPath(artifact);
  yield* ensureDirectory(yield* pathDirname(metadataPath), false);
  yield* writeFile(metadataPath, `${JSON.stringify(metadata, undefined, 2)}\n`, {encoding: 'utf8', mode: 0o600});
});

function sharedArtifactMetadataPath(artifact: SharedArtifactFile): string {
  return `${artifact.installPath}.threadnote-install.json`;
}

function sharedArtifactDryRunVerb(status: SharedArtifactInstallStatus, force: boolean): string {
  switch (status) {
    case 'not_installed':
      return 'Would install';
    case 'current':
      return 'Already installed';
    case 'update_available':
      return 'Would update';
    case 'local_modified':
    case 'remote_changed_and_local_modified':
      return force ? 'Would replace' : 'Would skip modified';
  }
}

function sharedArtifactDryRunSuffix(status: SharedArtifactInstallStatus, force: boolean): string {
  if ((status === 'local_modified' || status === 'remote_changed_and_local_modified') && !force) {
    return ' (pass --force to replace local changes)';
  }
  return '';
}

function sharedArtifactInstallVerb(status: SharedArtifactInstallStatus, force: boolean): string {
  if (force && (status === 'local_modified' || status === 'remote_changed_and_local_modified')) {
    return 'Replaced';
  }
  if (status === 'update_available') {
    return 'Updated';
  }
  return 'Installed';
}

function sharedArtifactFilterLabel(options: ShareInstallArtifactsOptions | ShareListArtifactsOptions): string {
  const filters: string[] = [];
  if (options.kind !== undefined) {
    filters.push(`kind=${options.kind}`);
  }
  if (options.agent !== undefined) {
    filters.push(`agent=${options.agent}`);
  }
  if (options.name !== undefined) {
    filters.push(`name=${uriSegment(options.name)}`);
  }
  return EffectArray.join(filters, ', ');
}

function sharedArtifactLabel(artifact: ShareArtifactMetadata): string {
  return `${artifact.kind} ${artifact.agent}/${artifact.name}`;
}

const sharedArtifactInstallPath = Effect.fn('share.sharedArtifactInstallPath')(function* (
  team: string,
  artifact: ShareArtifactMetadata,
) {
  const system = yield* SystemInfo;
  const agentDir = artifact.agent === 'codex' ? '.codex' : artifact.agent === 'claude' ? '.claude' : '.cursor';
  if (artifact.kind === 'pack') {
    // Packs install under a dedicated `threadnote-packs` namespace so a pack and
    // a same-named skill can never share an install root or metadata file. The
    // `threadnote`/`threadnote-packs` segment is Threadnote-controlled, never a
    // user skill name, so the two trees are structurally disjoint.
    return yield* pathJoin(system.homeDirectory, agentDir, 'skills', 'threadnote-packs', team, artifact.name);
  }
  if (artifact.kind === 'skill') {
    return yield* pathJoin(system.homeDirectory, agentDir, 'skills', 'threadnote', team, artifact.name, 'SKILL.md');
  }
  return yield* pathJoin(system.homeDirectory, '.claude', 'commands', 'threadnote', team, `${artifact.name}.md`);
});
