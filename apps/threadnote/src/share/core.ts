import {Console, DateTime, Effect, FileSystem, Option, Path, Predicate, Result, Schema} from 'effect';

import {SystemInfo} from '@threadnote/platform/system';
import {assertSafeRelativePath as assertPlatformSafeRelativePath} from '@threadnote/platform/paths';

import {uriSegment} from '@threadnote/workspace/manifest';

import {
  canonicalMemoryDocumentContent,
  parseMemoryDocument,
  parseMemoryRelationValue,
} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {discardMemoryRelocation} from '@threadnote/memory/relocation';
import {
  memoryCodeCitationContentSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {stripGeneratedMemoryHygieneSources} from '@threadnote/memory/hygiene/provenance';

import {ResourceStore} from '@threadnote/store/resource-store';

import {parseResourceId} from '@threadnote/store/resource-id';

import {applyScrubber} from '@threadnote/platform/scrubber';

import type {
  ShareAgentArtifactAgent,
  ShareAgentArtifactKind,
  ShareInitOptions,
  ShareRuntime,
  ShareTeamAccess,
  ShareTeamConfig,
  ShareTeamsFile,
} from '../types.js';

import {errorMessage} from '@threadnote/platform/errors';
import {
  exists,
  isDirectory,
  maybeRun,
  parseJsonConfigObject,
  portablePath,
  readFileIfExists,
  runCommand,
} from '../utils.js';

class ShareOperationError extends Schema.TaggedError<ShareOperationError>()('ShareOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

function shareOperationError(cause: unknown): ShareOperationError {
  return Schema.is(ShareOperationError)(cause)
    ? cause
    : ShareOperationError.make({cause, message: errorMessage(cause)});
}

const NATIVE_RESOURCE_BACKEND = 'threadnote-native';

const TEAMS_FILE_VERSION = 1;

const SHARED_SEGMENT = 'shared';

const SHAREABLE_MEMORY_KIND_DIRS = ['durable'];

const SHAREABLE_ARTIFACT_DIR = 'agent-artifacts';

const SHAREABLE_TOP_LEVEL_DIRS = [...SHAREABLE_MEMORY_KIND_DIRS, SHAREABLE_ARTIFACT_DIR];

const SHAREABLE_ROOT_FILES = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'SKILL.md', '.gitignore'];

const ARTIFACT_INSTALL_METADATA_VERSION = 1;

const BUNDLE_MANIFEST_VERSION = 1;

// A shared skill carries its whole directory. These metadata files describe the
// bundle in the team repo (BUNDLE_MANIFEST_FILE) and track a local install
// (BUNDLE_INSTALL_METADATA_FILE); neither is treated as skill content.
const BUNDLE_MANIFEST_FILE = '.threadnote-bundle.json';

const BUNDLE_INSTALL_METADATA_FILE = '.threadnote-bundle-install.json';

// native canonical store writes these summaries into the worktree; they are gitignored and
// must never be packed as skill members.
const OV_SUMMARY_FILES: readonly string[] = ['.abstract.md', '.overview.md'];

// Directories and files that are skill runtime artifacts or local junk, never
// part of a shared skill bundle. `reviews/` and `repos/` are skill scratch dirs.
const BUNDLE_IGNORE_DIR_NAMES: readonly string[] = ['.git', 'node_modules', 'reviews', 'repos'];

// Constellation packs: multiple skills plus shared code that lives outside any
// single skill directory, published together so relative paths resolve once
// installed under one root. Authored from a `threadnote-bundle.json` manifest.
const PACK_INDEX_SUFFIX = '.pack.md';

const PACK_MANIFEST_SUFFIX = '.pack.json';

const PACK_FILES_DIR = 'files';

// Replaced into the author's absolute repo-root references at publish, expanded
// back to the real install directory at install time so hardcoded paths resolve
// on a teammate's machine.
const PACK_ROOT_TOKEN = '${THREADNOTE_PACK_ROOT}';

const AUTO_SHARE_GIT_TIMEOUT_MILLISECONDS = 5_000;

export const SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS = 5 * 60 * 1000;

const SHARE_FETCH_RECEIPT_VERSION = 1;

const SHARE_FETCH_WARNING_MAXIMUM_LENGTH = 1_000;

export const DEFAULT_GIT_REMOTE_NAME = 'origin';

interface DirectoryEntry {
  readonly name: string;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

interface PathInfo extends DirectoryEntry {
  readonly mtime: Date;
  readonly size: number;
}

const pathJoin = Effect.fn('share.pathJoin')(function* (...parts: readonly string[]) {
  const path = yield* Path.Path;
  return path.join(...parts);
});

const pathDirname = Effect.fn('share.pathDirname')(function* (value: string) {
  const path = yield* Path.Path;
  return path.dirname(value);
});

const pathBasename = Effect.fn('share.pathBasename')(function* (value: string) {
  const path = yield* Path.Path;
  return path.basename(value);
});

const pathIsAbsolute = Effect.fn('share.pathIsAbsolute')(function* (value: string) {
  const path = yield* Path.Path;
  return path.isAbsolute(value);
});

const pathRelative = Effect.fn('share.pathRelative')(function* (from: string, to: string) {
  const path = yield* Path.Path;
  return path.relative(from, to);
});

const pathSeparator = Effect.map(Path.Path, path => path.sep);

function pathInfo(name: string, info: FileSystem.File.Info, symbolicLink: boolean): PathInfo {
  return {
    name,
    isDirectory: () => !symbolicLink && info.type === 'Directory',
    isFile: () => !symbolicLink && info.type === 'File',
    isSymbolicLink: () => symbolicLink,
    mtime: info.mtime._tag === 'Some' ? info.mtime.value : new Date(0),
    size: Number(info.size),
  };
}

const lstat = Effect.fn('share.lstat')(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(target).pipe(Effect.option);
  const info = yield* fs.stat(target);
  const path = yield* Path.Path;
  return pathInfo(path.basename(target), info, link._tag === 'Some');
});

function readFile(target: string): Effect.Effect<Uint8Array, unknown, FileSystem.FileSystem>;
function readFile(target: string, encoding: 'utf8'): Effect.Effect<string, unknown, FileSystem.FileSystem>;
function readFile(
  target: string,
  encoding?: 'utf8',
): Effect.Effect<Uint8Array | string, unknown, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return encoding ? yield* fs.readFileString(target, encoding) : yield* fs.readFile(target);
  });
}

function writeFile(
  target: string,
  content: string | Uint8Array,
  options?: 'utf8' | {readonly encoding?: 'utf8'; readonly mode?: number},
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const normalizedOptions = typeof options === 'string' ? undefined : options;
    if (typeof content === 'string') {
      yield* fs.writeFileString(target, content, normalizedOptions);
    } else {
      yield* fs.writeFile(target, content, normalizedOptions);
    }
  });
}

const mkdir = Effect.fn('share.mkdir')(function* (
  target: string,
  options?: {readonly recursive?: boolean; readonly mode?: number},
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(target, options);
});

function readdir(target: string): Effect.Effect<string[], unknown, FileSystem.FileSystem>;
function readdir(
  target: string,
  options: {readonly withFileTypes: true},
): Effect.Effect<DirectoryEntry[], unknown, FileSystem.FileSystem | Path.Path>;
function readdir(
  target: string,
  options?: {readonly withFileTypes?: boolean},
): Effect.Effect<string[] | DirectoryEntry[], unknown, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(target);
    if (options?.withFileTypes !== true) {
      return names;
    }
    return yield* Effect.forEach(names, name =>
      lstat(path.join(target, name)).pipe(
        Effect.map(info => ({
          name,
          isDirectory: info.isDirectory,
          isFile: info.isFile,
          isSymbolicLink: info.isSymbolicLink,
        })),
      ),
    );
  });
}

const rename = Effect.fn('share.rename')(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.rename(from, to);
});

const rm = Effect.fn('share.rm')(function* (
  target: string,
  options?: {readonly force?: boolean; readonly recursive?: boolean},
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(target, options);
});

export interface ShareArtifactMetadata {
  readonly agent: ShareAgentArtifactAgent;
  readonly kind: ShareAgentArtifactKind;
  readonly name: string;
}

export interface ShareArtifactResult {
  readonly artifact: ShareArtifactMetadata;
  readonly gitMessages: readonly string[];
  readonly messages: readonly string[];
  readonly previewContent?: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly targetUri: string;
}

export interface SharedArtifactFile {
  readonly artifact: ShareArtifactMetadata;
  readonly installPath: string;
  // Present for skill artifacts: every file in the shared skill directory,
  // relative to it. A length > 1 means this is a multi-file bundle.
  readonly members?: readonly BundleMemberFile[];
  readonly sourceRelativePath: string;
  readonly sourcePath: string;
  readonly team: string;
}

interface BundleMemberFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export type SharedArtifactInstallStatus =
  'current' | 'local_modified' | 'not_installed' | 'remote_changed_and_local_modified' | 'update_available';

export interface SharedArtifactSummary extends SharedArtifactFile {
  readonly installStatus: SharedArtifactInstallStatus;
  readonly metadataPath: string;
}

export interface SharedArtifactListResult {
  readonly artifacts: readonly SharedArtifactSummary[];
  readonly syncedTeams: readonly string[];
  readonly team: string;
  readonly warnings: readonly string[];
}

export interface SharedArtifactInstallResult {
  readonly installedCount: number;
  readonly messages: readonly string[];
  readonly syncedTeams: readonly string[];
  readonly team: string;
  readonly warnings: readonly string[];
}

interface SharedArtifactInstallMetadata {
  readonly artifact: ShareArtifactMetadata;
  readonly installedAt: string;
  readonly installedSha256: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly team: string;
  readonly version: number;
}

interface SharedArtifactInstallState {
  readonly existingContent?: string;
  readonly existingSha?: string;
  readonly metadata?: SharedArtifactInstallMetadata;
  readonly sourceContent: string;
  readonly sourceSha: string;
  readonly status: SharedArtifactInstallStatus;
}

export interface ResolvedTeam {
  readonly config: ShareTeamConfig;
  readonly name: string;
}

export interface ChangedFile {
  readonly path: string;
  readonly previousContent?: string;
  readonly previousRevision?: string;
  readonly relativePath: string;
  readonly status: 'added' | 'removed' | 'modified';
}

export interface SharedMemoryUriParts {
  readonly kind?: 'durable';
  readonly project?: string;
  readonly team: string;
  readonly topic?: string;
}

interface AutoShareState {
  behindTeams: ReadonlySet<string>;
  checkedAtByTeam: Map<string, number>;
  forceNextCheck: boolean;
  pendingReindexes: Map<string, readonly ChangedFile[]>;
}

const autoShareStates = new Map<string, AutoShareState>();

export interface AutoShareSyncResult {
  readonly syncedTeams: readonly string[];
  readonly warnings: readonly string[];
}

export interface ShareConflictSummary {
  readonly establishedMemoryId?: string;
  readonly hasLocalContent: boolean;
  readonly hasPreviousContent: boolean;
  readonly hasSharedContent: boolean;
  readonly identityConflict?: 'missing' | 'changed';
  readonly id: string;
  readonly reason: string;
  readonly relativePath: string;
  readonly status: ChangedFile['status'];
  readonly team: string;
  readonly uri: string;
}

export interface ShareConflictDetail extends ShareConflictSummary {
  readonly revision: string;
  readonly diff: string;
  readonly localContent?: string;
  readonly previousContent?: string;
  readonly resolutionGuidance: readonly string[];
  readonly sharedContent?: string;
}

export interface ShareConflictResolveResult {
  readonly backupPath?: string;
  readonly gitMessages: readonly string[];
  readonly id: string;
  readonly messages: readonly string[];
  readonly team: string;
  readonly uri: string;
}

type InspectedShareConflict = Omit<ShareConflictDetail, 'diff' | 'resolutionGuidance' | 'revision'>;

interface ShareUpdateStatus {
  readonly behind: number;
  readonly team: string;
  readonly warning?: string;
}

interface ShareFetchReceipt {
  readonly behind: number;
  readonly checkedAt: number;
  readonly remote: string;
  readonly succeeded: boolean;
  readonly team: string;
  readonly version: number;
  readonly warning?: string;
  readonly worktree: string;
}

interface PendingReindexFile {
  readonly teams: Readonly<Record<string, readonly ChangedFile[]>>;
  readonly version: number;
}

export function clearAutoShareStateForTest(): void {
  autoShareStates.clear();
}

export function markSharedAutoSyncDeferred(config: ShareRuntime): void {
  autoShareState(config).forceNextCheck = true;
}

const SHARED_GITIGNORE_PATTERNS = ['**/.abstract.md', '**/.overview.md'];

const SHARED_GITIGNORE_HEADER = '# Threadnote: ignore native canonical store-generated directory summaries.';

const ensureSharedGitignore = Effect.fn('share.ensureSharedGitignore')(function* (
  worktree: string,
  git: string,
  push: boolean,
) {
  // Idempotently ensure the native canonical store-summary patterns are in the worktree's
  // .gitignore. There's no opt-out: these two patterns describe files that OV
  // writes into every shared directory on every mkdir, are not memories, and
  // would only pollute git history if tracked. Users who insist on tracking
  // them can `git update-index --skip-worktree .gitignore` to suppress this.
  const gitignorePath = yield* pathJoin(worktree, '.gitignore');
  const existing = (yield* readFileIfExists(gitignorePath)) ?? '';
  const lines = existing.split('\n').map(line => line.trim());
  const missingPatterns = SHARED_GITIGNORE_PATTERNS.filter(pattern => !lines.includes(pattern));
  if (missingPatterns.length === 0) {
    return;
  }
  // Reuse the existing header if one is already in the file; only add a fresh
  // header on the first run so repeated calls don't accumulate duplicate
  // comment lines.
  const hasHeader = lines.includes(SHARED_GITIGNORE_HEADER);
  const segments: string[] = [];
  if (existing.length > 0 && !existing.endsWith('\n')) {
    segments.push('\n');
  }
  if (existing.length > 0) {
    segments.push('\n');
  }
  if (!hasHeader) {
    segments.push(SHARED_GITIGNORE_HEADER, '\n');
  }
  segments.push(missingPatterns.join('\n'), '\n');
  yield* writeFile(gitignorePath, `${existing}${segments.join('')}`, {encoding: 'utf8'});
  yield* Console.log(`Added ${missingPatterns.join(', ')} to ${yield* portablePath(gitignorePath)}`);
  yield* maybeRun(false, git, ['-C', worktree, 'add', '.gitignore']);
  const commitResult = yield* runCommand(
    git,
    ['-C', worktree, 'commit', '-m', 'share: ignore native canonical store directory summaries'],
    {allowFailure: true},
  );
  if (commitResult.exitCode !== 0) {
    const detail = commitResult.stderr.trim() || commitResult.stdout.trim();
    if (!/nothing to commit|no changes added/i.test(detail)) {
      yield* Console.warn(
        `.gitignore housekeeping commit was rejected (${detail || 'unknown'}); it will be retried on the next share sync.`,
      );
      return;
    }
  }
  if (push) {
    yield* maybeRun(false, git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME], {allowFailure: true});
  }
});

function autoShareState(config: ShareRuntime): AutoShareState {
  const key = `${config.agentContextHome}:${config.account}:${config.user}`;
  let state = autoShareStates.get(key);
  if (!state) {
    state = {
      behindTeams: new Set(),
      checkedAtByTeam: new Map(),
      forceNextCheck: false,
      pendingReindexes: new Map(),
    };
    autoShareStates.set(key, state);
  }
  return state;
}

const pendingReindexesPath = Effect.fn('share.pendingReindexesPath')(function* (config: ShareRuntime) {
  return yield* pathJoin(config.agentContextHome, 'share', 'auto-sync-pending-reindexes.json');
});

const loadPendingReindexes = Effect.fn('share.loadPendingReindexes')(function* (
  config: ShareRuntime,
  state: AutoShareState,
) {
  const raw = yield* readFileIfExists(yield* pendingReindexesPath(config));
  if (!raw) {
    state.pendingReindexes = new Map();
    return;
  }
  const parsed = parseJsonConfigObject(raw);
  if (!parsed || typeof parsed.teams !== 'object' || parsed.teams === null || Array.isArray(parsed.teams)) {
    state.pendingReindexes = new Map();
    return;
  }
  const pending = new Map<string, readonly ChangedFile[]>();
  for (const [team, value] of Object.entries(parsed.teams)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const changes: ChangedFile[] = [];
    for (const item of value) {
      if (!Predicate.isObject(item)) {
        continue;
      }
      const entry = item;
      if (
        typeof entry.path === 'string' &&
        typeof entry.relativePath === 'string' &&
        (entry.status === 'added' || entry.status === 'removed' || entry.status === 'modified')
      ) {
        changes.push({
          path: entry.path,
          previousContent: typeof entry.previousContent === 'string' ? entry.previousContent : undefined,
          previousRevision: typeof entry.previousRevision === 'string' ? entry.previousRevision : undefined,
          relativePath: entry.relativePath,
          status: entry.status,
        });
      }
    }
    if (changes.length > 0) {
      pending.set(team, changes);
    }
  }
  state.pendingReindexes = pending;
});

const writePendingReindexes = Effect.fn('share.writePendingReindexes')(function* (
  config: ShareRuntime,
  state: AutoShareState,
) {
  const path = yield* pendingReindexesPath(config);
  if (state.pendingReindexes.size === 0) {
    yield* rm(path, {force: true});
    return;
  }
  const contents: PendingReindexFile = {
    teams: Object.fromEntries(state.pendingReindexes),
    version: 1,
  };
  yield* mkdir(yield* pathDirname(path), {recursive: true});
  const system = yield* SystemInfo;
  const tempPath = `${path}.${system.processId}.tmp`;
  yield* writeFile(tempPath, `${JSON.stringify(contents, undefined, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  yield* rename(tempPath, path);
});

function assertSafeShareRelativePath(relativePath: string): string {
  try {
    return assertPlatformSafeRelativePath(relativePath);
  } catch {
    throw ShareOperationError.make({message: `Invalid shared relative path: ${relativePath}`});
  }
}

function normalizeTeamName(input: string | undefined): string {
  const candidate = (input ?? 'default').trim();
  if (!candidate) {
    return 'default';
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(candidate) || /^\.+$/.test(candidate)) {
    throw ShareOperationError.make({
      message: `Invalid team name "${input}". Team names must start with a lowercase letter or digit and contain only [a-z0-9._-]. Single-dot or dot-only names are rejected so they don't collapse to the shared-root or parent directory.`,
    });
  }
  return candidate;
}

const teamsFilePath = Effect.fn('share.teamsFilePath')(function* (config: ShareRuntime) {
  return yield* pathJoin(config.agentContextHome, 'share', 'teams.json');
});

const teamWorktreePath = Effect.fn('share.teamWorktreePath')(function* (config: ShareRuntime, team: string) {
  return yield* pathJoin(config.agentContextHome, 'share', 'worktrees', team);
});

const teamGitdirPath = Effect.fn('share.teamGitdirPath')(function* (config: ShareRuntime, team: string) {
  return yield* pathJoin(config.agentContextHome, 'share', 'teams', `${team}.gitdir`);
});

export const readTeamsFile = Effect.fn('share.readTeamsFile')(function* (config: ShareRuntime) {
  const path = yield* teamsFilePath(config);
  const raw = yield* readFileIfExists(path);
  if (!raw) {
    const empty: ShareTeamsFile = {teams: {}, version: TEAMS_FILE_VERSION};
    return empty;
  }
  const parsed = parseJsonConfigObject(raw);
  if (!parsed) {
    throw ShareOperationError.make({message: `Could not parse teams file ${path}`});
  }
  if (typeof parsed.version === 'number' && parsed.version > TEAMS_FILE_VERSION) {
    throw ShareOperationError.make({
      message: `Teams file ${path} was written with version ${parsed.version}; this Threadnote binary understands up to version ${TEAMS_FILE_VERSION}. Upgrade Threadnote (\`threadnote update\`) before continuing.`,
    });
  }
  const teams: Record<string, ShareTeamConfig> = {};
  if (typeof parsed.teams === 'object' && parsed.teams !== null && !Array.isArray(parsed.teams)) {
    for (const [name, value] of Object.entries(parsed.teams)) {
      if (!Predicate.isObject(value)) {
        yield* Console.warn(`Skipping non-object team entry "${name}" in ${path}.`);
        continue;
      }
      const entry = value;
      if (typeof entry.remote !== 'string' || entry.remote.length === 0) {
        yield* Console.warn(`Skipping team entry "${name}" in ${path}: missing or empty "remote" field.`);
        continue;
      }
      if (entry.access !== undefined && entry.access !== 'read-only' && entry.access !== 'read-write') {
        yield* Console.warn(`Skipping team entry "${name}" in ${path}: invalid "access" field.`);
        continue;
      }
      teams[name] = {
        ...(entry.access === 'read-only' || entry.access === 'read-write' ? {access: entry.access} : {}),
        addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : DateTime.formatIso(DateTime.makeUnsafe(0)),
        gitdir: typeof entry.gitdir === 'string' ? entry.gitdir : yield* teamGitdirPath(config, name),
        name,
        remote: entry.remote,
        worktree: typeof entry.worktree === 'string' ? entry.worktree : yield* teamWorktreePath(config, name),
      };
    }
  }
  const defaultTeam = typeof parsed.defaultTeam === 'string' ? parsed.defaultTeam : undefined;
  const teamsFile: ShareTeamsFile = {defaultTeam, teams, version: TEAMS_FILE_VERSION};
  return teamsFile;
});

export function shareTeamAccess(team: ShareTeamConfig): ShareTeamAccess {
  return team.access === 'read-only' ? 'read-only' : 'read-write';
}

const writeTeamsFile = Effect.fn('share.writeTeamsFile')(function* (config: ShareRuntime, contents: ShareTeamsFile) {
  const path = yield* teamsFilePath(config);
  yield* mkdir(yield* pathDirname(path), {recursive: true});
  const serializable = {
    defaultTeam: contents.defaultTeam,
    teams: contents.teams,
    version: contents.version,
  };
  yield* writeFile(path, `${JSON.stringify(serializable, undefined, 2)}\n`, {encoding: 'utf8', mode: 0o600});
});

export const resolveTeam = Effect.fn('share.resolveTeam')(function* (
  config: ShareRuntime,
  requested: string | undefined,
) {
  const teamsFile = yield* readTeamsFile(config);
  const entries = Object.entries(teamsFile.teams);
  if (entries.length === 0) {
    throw ShareOperationError.make({message: 'No shared teams configured. Run: threadnote share init <remote-url>'});
  }
  const wantName = requested ? normalizeTeamName(requested) : (teamsFile.defaultTeam ?? entries[0][0]);
  const found = teamsFile.teams[wantName];
  if (!found) {
    const known = entries.map(([name]) => name).join(', ');
    throw ShareOperationError.make({message: `Team "${wantName}" is not configured. Known teams: ${known}`});
  }
  return {config: found, name: wantName};
});

function assertShareTeamWritable(team: ResolvedTeam, operation: string): void {
  if (shareTeamAccess(team.config) === 'read-only') {
    throw ShareOperationError.make({
      message: `Shared team "${team.name}" is read-only; cannot ${operation}. Change it with: threadnote share set-access --team ${team.name} --mode read-write`,
    });
  }
}

function shouldSetDefault(options: ShareInitOptions, existing: ShareTeamsFile): boolean {
  if (options.setDefault === true) {
    return true;
  }
  return existing.defaultTeam === undefined;
}

const assertWorktreeUsable = Effect.fn('share.assertWorktreeUsable')(function* (worktree: string) {
  if (!(yield* exists(worktree))) {
    return;
  }
  if (!(yield* isDirectory(worktree))) {
    throw ShareOperationError.make({message: `Cannot use ${worktree} as a worktree: not a directory.`});
  }
  const entries = yield* readdir(worktree);
  if (entries.length > 0) {
    const preview = entries.slice(0, 5).join(', ');
    const suffix = entries.length > 5 ? `, +${entries.length - 5} more` : '';
    throw ShareOperationError.make({
      message: `Worktree ${worktree} is not empty (contains: ${preview}${suffix}). Move or remove its contents, then retry threadnote share init.`,
    });
  }
});

const walkMemoryFiles = Effect.fn('share.walkMemoryFiles')(function* (root: string) {
  const out: string[] = [];
  const visit: (path: string, depth: number) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =
    Effect.fn('share.visit')(function* (path: string, depth: number) {
      const entriesResult = yield* Effect.result(readdir(path, {withFileTypes: true}));
      if (Result.isFailure(entriesResult)) {
        const err = entriesResult.failure;
        yield* Console.warn(
          `Skipping ${path} during shared-tree walk: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      const entries = entriesResult.success;
      for (const entry of entries) {
        if (entry.name === '.git') {
          continue;
        }
        const full = yield* pathJoin(path, entry.name);
        if (entry.isDirectory()) {
          if (depth === 0 && !SHAREABLE_TOP_LEVEL_DIRS.includes(entry.name)) {
            continue;
          }
          yield* visit(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (depth === 0) {
          continue;
        }
        if (!entry.name.endsWith('.md') || OV_SUMMARY_FILES.includes(entry.name)) {
          continue;
        }
        out.push(full);
      }
    });
  yield* visit(root, 0);
  return out;
});

const workfileToResourceUri = Effect.fn('share.workfileToResourceUri')(function* (
  config: ShareRuntime,
  team: ShareTeamConfig,
  filePath: string,
) {
  const rel = (yield* pathRelative(team.worktree, filePath)).split(yield* pathSeparator).join('/');
  return `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team.name}/${rel}`;
});

export function isInSharedNamespace(config: ShareRuntime, uri: string): boolean {
  return sharedTeamNameForUri(config, uri) !== undefined;
}

export function sharedTeamNameForUri(config: ShareRuntime, uri: string): string | undefined {
  const canonicalUri = canonicalResourceInput(uri);
  if (!canonicalUri) return undefined;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/`;
  if (!canonicalUri.startsWith(prefix)) {
    return undefined;
  }
  const [team] = canonicalUri.slice(prefix.length).split('/');
  return team || undefined;
}

export function sharedMemoryUriParts(config: ShareRuntime, uri: string): SharedMemoryUriParts | undefined {
  const canonicalUri = canonicalResourceInput(uri);
  if (!canonicalUri) return undefined;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/`;
  if (!canonicalUri.startsWith(prefix)) {
    return undefined;
  }
  const [team, kind, scope, project, ...topicParts] = canonicalUri.slice(prefix.length).split('/');
  if (!team) {
    return undefined;
  }
  if (kind !== 'durable' || scope !== 'projects' || !project || topicParts.length === 0) {
    return {team};
  }
  const topicPath = topicParts.join('/');
  return {
    kind,
    project,
    team,
    topic: topicPath.endsWith('.md') ? topicPath.slice(0, -'.md'.length) : topicPath,
  };
}

function isInTeamNamespace(config: ShareRuntime, uri: string, team: string): boolean {
  return (
    canonicalResourceInput(uri)?.startsWith(
      `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team}/`,
    ) === true
  );
}

export function sharedUriFor(config: ShareRuntime, personalUri: string, team: string): string {
  const resource = parseResourceId(personalUri);
  if (resource.anchor !== undefined) {
    throw ShareOperationError.make({message: `Refusing to share anchored memory URI: ${personalUri}`});
  }
  const canonicalUri = resource.canonicalUri;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/`;
  if (!canonicalUri.startsWith(prefix)) {
    throw ShareOperationError.make({
      message: `Refusing to publish memory outside the current user namespace: ${personalUri}`,
    });
  }
  const rest = canonicalUri.slice(prefix.length);
  if (!rest.startsWith('durable/projects/')) {
    throw ShareOperationError.make({
      message: `Refusing to share ${personalUri}: only personal durable memories under durable/projects can enter a shared team.`,
    });
  }
  return `${prefix}${SHARED_SEGMENT}/${team}/${rest}`;
}

export function personalUriFor(config: ShareRuntime, sharedUri: string, team: string): string {
  const canonicalUri = parseResourceId(sharedUri).canonicalUri;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team}/`;
  if (!canonicalUri.startsWith(prefix)) {
    throw ShareOperationError.make({
      message: `Refusing to unpublish a URI outside team "${team}" shared namespace: ${sharedUri}`,
    });
  }
  const rest = canonicalUri.slice(prefix.length);
  return `threadnote://user/${uriSegment(config.user)}/memories/${rest}`;
}

export function resourceUriToWorktreeRelative(config: ShareRuntime, uri: string, team: string): string {
  const canonicalUri = parseResourceId(uri).canonicalUri;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team}/`;
  if (!canonicalUri.startsWith(prefix)) {
    throw ShareOperationError.make({message: `URI ${uri} is not inside team "${team}" shared subtree.`});
  }
  return canonicalUri.slice(prefix.length);
}

const isRegularFileNoSymlink = Effect.fn('share.isRegularFileNoSymlink')(function* (path: string) {
  const stat = yield* lstat(path).pipe(Effect.option);
  return Option.isSome(stat) && stat.value.isFile();
});

/**
 * Removes personal lifecycle, candidate, session, evidence, and relation
 * provenance from the header block before a memory is published to a team's
 * shared git repo. Shared writers must call
 * `stripPersonalProvenanceForSharedPublication` so already-valid
 * `threadnote://memory/tn_...` relation headers survive. Personal
 * `threadnote://user/...` URIs do not resolve for teammates, and
 * candidate/session IDs are local workflow state. Defence-in-depth: even if a
 * producer accidentally retains local provenance, it stops here.
 *
 * Operates only on the contiguous header block (everything up to the first
 * blank line). Prose mentions of "supersedes:" elsewhere in the body are
 * untouched.
 */
export function stripPersonalProvenance(
  content: string,
  options: {readonly preserveStableMemoryRelations?: boolean} = {},
): string {
  const lines = content.split('\n');
  let headerEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '') {
      headerEnd = index;
      break;
    }
  }
  const cleaned: string[] = [];
  for (let index = 0; index < headerEnd; index += 1) {
    const line = lines[index];
    const stableRelation = options.preserveStableMemoryRelations === true && isStableMemoryRelationHeader(line);
    if (
      !stableRelation &&
      /^\s*(?:archived_from|candidate_id|consolidation|evidence|references|relation|source_session_id|supersedes):/.test(
        line,
      )
    ) {
      continue;
    }
    cleaned.push(line);
  }
  for (let index = headerEnd; index < lines.length; index += 1) {
    cleaned.push(lines[index]);
  }
  return stripGeneratedMemoryHygieneSources(cleaned.join('\n'));
}

/** Shared publication, ingest, and replace: keep identity-alias relations, drop local projection URIs. */
export function stripPersonalProvenanceForSharedPublication(content: string): string {
  return stripPersonalProvenance(content, {preserveStableMemoryRelations: true});
}

function isStableMemoryRelationHeader(line: string): boolean {
  if (!line.startsWith('relation:')) return false;
  const relation = parseMemoryRelationValue(line.slice('relation:'.length).trimStart());
  return relation !== undefined && memoryIdFromIdentityAlias(relation.uri) !== undefined;
}

export function setMemoryVisibility(content: string, visibility: 'personal' | 'shared'): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== 'MEMORY' && lines[0]?.trim() !== 'HANDOFF') {
    return content;
  }
  const headerEnd = lines.findIndex(line => line.trim() === '');
  if (headerEnd === -1) {
    return content;
  }
  const visibilityIndex = lines.slice(1, headerEnd).findIndex(line => line.startsWith('visibility:'));
  if (visibilityIndex >= 0) {
    lines[visibilityIndex + 1] = `visibility: ${visibility}`;
    return lines.join('\n');
  }
  let insertionIndex = headerEnd;
  for (let index = 1; index < headerEnd; index += 1) {
    if (/^(?:created_at|timestamp|updated_at):/.test(lines[index] ?? '')) {
      insertionIndex = index + 1;
    }
  }
  lines.splice(insertionIndex, 0, `visibility: ${visibility}`);
  return lines.join('\n');
}

const readMemoryContent = Effect.fn('share.readMemoryContent')(function* (
  config: ShareRuntime,
  _ov: string,
  uri: string,
  dryRun: boolean,
) {
  if (dryRun) {
    yield* Console.log(`Would read native resource: ${uri}`);
    return '<dry-run memory body>';
  }
  const store = yield* ResourceStore;
  const content = yield* store.read(resourceStoreLocation(config), uri);
  if (!content.trim()) {
    throw ShareOperationError.make({message: `Refusing to publish empty memory at ${uri}`});
  }
  return content;
});

export const ensureSharedDirectoryChain = Effect.fn('share.ensureSharedDirectoryChain')(function* (
  config: ShareRuntime,
  _ov: string,
  memoryUri: string,
  dryRun: boolean,
  options: {readonly quiet?: boolean} = {},
) {
  const directoryUri = parentUri(memoryUri);
  const store = yield* ResourceStore;
  for (const uri of sharedDirectoryChain(config, directoryUri)) {
    if (dryRun) {
      if (options.quiet !== true) {
        yield* Console.log(`Would create native resource directory if missing: ${uri}`);
      }
      continue;
    }
    yield* store.makeDirectory(resourceStoreLocation(config), uri);
  }
});

export function parentUri(uri: string): string {
  const lastSlash = uri.lastIndexOf('/');
  return lastSlash === -1 ? uri : uri.slice(0, lastSlash);
}

export function sharedDirectoryChain(config: ShareRuntime, directoryUri: string): readonly string[] {
  const canonicalUri = parseResourceId(directoryUri).canonicalUri;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/`;
  if (!canonicalUri.startsWith(prefix)) {
    return [canonicalUri];
  }
  const parts = canonicalUri.slice(prefix.length).split('/').filter(Boolean);
  const chain: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) {
    chain.push(`${prefix}${parts.slice(0, index).join('/')}`);
  }
  return chain;
}

function canonicalResourceInput(uri: string): string | undefined {
  try {
    return parseResourceId(uri).canonicalUri;
  } catch {
    return undefined;
  }
}

export const writeMemoryFile = Effect.fn('share.writeMemoryFile')(function* (
  config: ShareRuntime,
  _ov: string,
  uri: string,
  content: string,
  initialMode: 'create' | 'replace',
  dryRun: boolean,
  options: {readonly quiet?: boolean} = {},
) {
  if (dryRun) {
    if (options.quiet !== true) {
      yield* Console.log(`Would write native resource: ${uri} --mode ${initialMode}`);
    }
    return;
  }
  const store = yield* ResourceStore;
  yield* store.write(resourceStoreLocation(config), uri, content, {
    mode: initialMode === 'replace' ? 'upsert' : 'create',
  });
  // A live memory always wins over an older relocation from the same URI.
  // Clear that receipt now so deleting a later, unrelated reuse cannot revive
  // the stale destination.
  yield* discardMemoryRelocation(config, uri);
});

/**
 * Commit a memory only after a read-only invariant check succeeds under the
 * ResourceStore account mutation lock. The check must not mutate ResourceStore.
 */
export function writeMemoryFileChecked<E, R>(
  config: ShareRuntime,
  _ov: string,
  uri: string,
  content: string,
  initialMode: 'create' | 'replace',
  dryRun: boolean,
  check: Effect.Effect<void, E, R>,
  options: {readonly quiet?: boolean} = {},
) {
  return Effect.gen(function* () {
    if (dryRun) {
      if (options.quiet !== true) {
        yield* Console.log(`Would write native resource: ${uri} --mode ${initialMode}`);
      }
      return;
    }
    const store = yield* ResourceStore;
    yield* store.writeChecked(
      resourceStoreLocation(config),
      uri,
      content,
      {mode: initialMode === 'replace' ? 'upsert' : 'create'},
      check,
    );
    yield* discardMemoryRelocation(config, uri);
  });
}

function resourceStoreLocation(config: ShareRuntime) {
  return {
    account: config.account,
    home: config.agentContextHome,
    user: config.user,
  };
}

const ingestSingleFile = Effect.fn('share.ingestSingleFile')(function* (
  ov: string,
  config: ShareRuntime,
  uri: string,
  filePath: string,
  initialMode: 'create' | 'replace',
  options: {readonly quiet?: boolean} = {},
) {
  const content = yield* readSharedInboundFileContent(uri, filePath);
  yield* writeMemoryFile(config, ov, uri, content, initialMode, false, options);
});

const readSharedInboundFileContent = Effect.fn('share.readSharedInboundFileContent')(function* (
  uri: string,
  filePath: string,
) {
  if (!(yield* isRegularFileNoSymlink(filePath))) {
    return yield* ShareOperationError.make({message: `Refusing to ingest non-regular shared file: ${filePath}`});
  }
  return yield* prepareSharedInboundContentEffect(uri, yield* readFile(filePath, 'utf8'));
});

const prepareSharedInboundContentEffect = Effect.fn('share.prepareSharedInboundContent')(function* (
  uri: string,
  rawContent: string,
) {
  return yield* Effect.try({
    catch: shareOperationError,
    try: () => prepareSharedInboundContent(uri, rawContent),
  });
});

function prepareSharedInboundContent(uri: string, rawContent: string): string {
  const stripped = stripPersonalProvenanceForSharedPublication(canonicalMemoryDocumentContent(rawContent));
  const citationBlocker = memoryCodeCitationContentSharingBlocker(uri, stripped);
  if (citationBlocker) {
    throw ShareOperationError.make({
      message: `Refusing to ingest ${uri}: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
    });
  }
  const scrub = applyScrubber(stripped, {redact: false});
  if (scrub.blocker) {
    throw ShareOperationError.make({
      message: `Refusing to ingest ${uri}: possible ${scrub.blocker}. Strip the sensitive value upstream first.`,
    });
  }
  return scrub.cleaned;
}

export const removeMemoryUri = Effect.fn('share.removeMemoryUri')(function* (
  config: ShareRuntime,
  _ov: string,
  uri: string,
  dryRun: boolean,
  options: {readonly quiet?: boolean; readonly recursive?: boolean} = {},
) {
  if (dryRun) {
    if (options.quiet !== true) {
      yield* Console.log(
        options.recursive === true
          ? `Would remove native resource subtree: ${uri}`
          : `Would remove native resource: ${uri}`,
      );
    }
    return;
  }
  const store = yield* ResourceStore;
  yield* store
    .remove(resourceStoreLocation(config), uri, {recursive: options.recursive === true})
    .pipe(Effect.catchTag('ResourceNotFound', () => Effect.void));
});

export const resourceExists = Effect.fn('share.resourceExists')(function* (
  _ov: string,
  config: ShareRuntime,
  uri: string,
) {
  const store = yield* ResourceStore;
  return yield* store.stat(resourceStoreLocation(config), uri).pipe(
    Effect.as(true),
    Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)),
  );
});

const resourceExistsStrict = Effect.fn('share.resourceExistsStrict')(function* (
  _ov: string,
  config: ShareRuntime,
  uri: string,
) {
  const store = yield* ResourceStore;
  return yield* store.stat(resourceStoreLocation(config), uri).pipe(
    Effect.as(true),
    Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)),
  );
});

function sharedMemoryContentsEquivalent(left: string, right: string): boolean {
  return normalizeSharedMemoryComparisonContent(left) === normalizeSharedMemoryComparisonContent(right);
}

/** Remote shared edits may add an identity to a legacy record, but never drop or replace an established one. */
function assertSharedMemoryIdentityContinuity(uri: string, currentContent: string, incomingContent: string): void {
  const issue = sharedMemoryIdentityContinuityIssue(uri, currentContent, incomingContent);
  if (issue !== undefined) throw ShareOperationError.make({message: issue});
}

function sharedMemoryIdentityContinuityIssue(
  uri: string,
  currentContent: string,
  incomingContent: string,
): string | undefined {
  return sharedMemoryIdentityConflict(uri, currentContent, incomingContent)?.message;
}

export function sharedMemoryIdentityConflict(
  uri: string,
  currentContent: string | undefined,
  incomingContent: string,
  previousContent?: string,
): {readonly kind: 'missing' | 'changed'; readonly message: string} | undefined {
  const currentMemoryId = currentContent ? parseMemoryDocument(uri, currentContent)?.metadata.memoryId : undefined;
  const previousMemoryId = previousContent ? parseMemoryDocument(uri, previousContent)?.metadata.memoryId : undefined;
  if (currentMemoryId !== undefined && previousMemoryId !== undefined && currentMemoryId !== previousMemoryId) {
    return {
      kind: 'changed',
      message: `Refusing shared update for ${uri}: local stable memory_id ${currentMemoryId} differs from previous shared memory_id ${previousMemoryId}.`,
    };
  }
  const establishedMemoryId = previousMemoryId ?? currentMemoryId;
  if (establishedMemoryId === undefined) return;
  const incomingMemoryId = parseMemoryDocument(uri, incomingContent)?.metadata.memoryId;
  if (incomingMemoryId === undefined) {
    return {
      kind: 'missing',
      message: `Refusing shared update for ${uri}: remote content is missing established stable memory_id ${establishedMemoryId}.`,
    };
  }
  if (incomingMemoryId !== establishedMemoryId) {
    return {
      kind: 'changed',
      message: `Refusing shared update for ${uri}: remote content cannot drop or change stable memory_id ${establishedMemoryId}; incoming content changed stable memory_id to ${incomingMemoryId}.`,
    };
  }
}

export function establishedSharedMemoryIdentity(
  uri: string,
  currentContent: string | undefined,
  previousContent?: string,
): string | undefined {
  const currentMemoryId = currentContent ? parseMemoryDocument(uri, currentContent)?.metadata.memoryId : undefined;
  const previousMemoryId = previousContent ? parseMemoryDocument(uri, previousContent)?.metadata.memoryId : undefined;
  if (currentMemoryId !== undefined && previousMemoryId !== undefined && currentMemoryId !== previousMemoryId) {
    return undefined;
  }
  return previousMemoryId ?? currentMemoryId;
}

/** Keep an established identity when an explicit conflict resolution accepts a legacy shared document. */
export function reconcileMissingSharedMemoryIdentity(
  uri: string,
  localContent: string | undefined,
  sharedContent: string,
  previousContent?: string,
): string {
  const identityConflict = sharedMemoryIdentityConflict(uri, localContent, sharedContent, previousContent);
  if (identityConflict?.kind === 'changed') {
    throw ShareOperationError.make({message: identityConflict.message});
  }
  if (identityConflict === undefined) return sharedContent;
  const establishedMemoryId = establishedSharedMemoryIdentity(uri, localContent, previousContent);
  if (establishedMemoryId === undefined) return sharedContent;
  const sharedRecord = parseMemoryDocument(uri, sharedContent);
  if (sharedRecord === undefined) {
    throw ShareOperationError.make({message: `Cannot preserve stable memory_id for unreadable shared memory ${uri}.`});
  }
  const separator = /\r?\n\r?\n/.exec(sharedContent);
  if (!separator || separator.index === undefined) {
    throw ShareOperationError.make({message: `Cannot preserve stable memory_id for unreadable shared memory ${uri}.`});
  }
  const newline = separator[0].startsWith('\r') ? '\r\n' : '\n';
  return `${sharedContent.slice(0, separator.index)}${newline}memory_id: ${establishedMemoryId}${sharedContent.slice(separator.index)}`;
}

/** Re-read the live canonical bytes while ResourceStore holds its mutation lock. */
export const verifySharedMemoryIdentityContinuity = Effect.fn('share.verifyMemoryIdentityContinuity')(function* (
  config: ShareRuntime,
  uri: string,
  incomingContent: string,
) {
  const store = yield* ResourceStore;
  const currentContent = yield* store.read(resourceStoreLocation(config), uri).pipe(
    Effect.asSome,
    Effect.catchTag('ResourceNotFound', () => Effect.succeedNone),
  );
  if (Option.isSome(currentContent)) {
    assertSharedMemoryIdentityContinuity(uri, currentContent.value, incomingContent);
  }
});

/** Re-read the live canonical bytes while ResourceStore holds its mutation lock. */
export const verifySharedMemoryContentUnchanged = Effect.fn('share.verifyMemoryContentUnchanged')(function* (
  config: ShareRuntime,
  uri: string,
  expectedContent: string,
) {
  const store = yield* ResourceStore;
  const currentContent = yield* store.read(resourceStoreLocation(config), uri);
  if (!sharedMemoryContentsEquivalent(currentContent, expectedContent)) {
    throw ShareOperationError.make({
      message: `Refusing shared update for ${uri}: native canonical content changed while applying the remote update.`,
    });
  }
});

function normalizeSharedMemoryComparisonContent(content: string): string {
  return canonicalMemoryDocumentContent(content.replace(/\r\n?/g, '\n'));
}

function countManagedMemoryFieldsTrailers(content: string): number {
  return content.match(/<!-- MEMORY_FIELDS\r?\n/g)?.length ?? 0;
}

export type {
  AutoShareState,
  BundleMemberFile,
  InspectedShareConflict,
  ShareFetchReceipt,
  ShareUpdateStatus,
  SharedArtifactInstallMetadata,
  SharedArtifactInstallState,
};

export {
  ARTIFACT_INSTALL_METADATA_VERSION,
  AUTO_SHARE_GIT_TIMEOUT_MILLISECONDS,
  BUNDLE_IGNORE_DIR_NAMES,
  BUNDLE_INSTALL_METADATA_FILE,
  BUNDLE_MANIFEST_FILE,
  BUNDLE_MANIFEST_VERSION,
  NATIVE_RESOURCE_BACKEND,
  OV_SUMMARY_FILES,
  PACK_FILES_DIR,
  PACK_INDEX_SUFFIX,
  PACK_MANIFEST_SUFFIX,
  PACK_ROOT_TOKEN,
  SHAREABLE_ARTIFACT_DIR,
  SHAREABLE_MEMORY_KIND_DIRS,
  SHAREABLE_ROOT_FILES,
  SHAREABLE_TOP_LEVEL_DIRS,
  SHARED_SEGMENT,
  SHARE_FETCH_RECEIPT_VERSION,
  SHARE_FETCH_WARNING_MAXIMUM_LENGTH,
  ShareOperationError,
  TEAMS_FILE_VERSION,
  assertSafeShareRelativePath,
  assertSharedMemoryIdentityContinuity,
  assertShareTeamWritable,
  assertWorktreeUsable,
  autoShareState,
  canonicalResourceInput,
  countManagedMemoryFieldsTrailers,
  ensureSharedGitignore,
  ingestSingleFile,
  isInTeamNamespace,
  isRegularFileNoSymlink,
  loadPendingReindexes,
  mkdir,
  normalizeTeamName,
  pathBasename,
  pathDirname,
  pathInfo,
  pathIsAbsolute,
  pathJoin,
  pathRelative,
  pathSeparator,
  prepareSharedInboundContentEffect,
  readFile,
  readMemoryContent,
  readSharedInboundFileContent,
  readdir,
  rename,
  resourceExistsStrict,
  resourceStoreLocation,
  rm,
  sharedMemoryIdentityContinuityIssue,
  sharedMemoryContentsEquivalent,
  shouldSetDefault,
  teamGitdirPath,
  teamWorktreePath,
  teamsFilePath,
  walkMemoryFiles,
  workfileToResourceUri,
  writeFile,
  writePendingReindexes,
  writeTeamsFile,
};
