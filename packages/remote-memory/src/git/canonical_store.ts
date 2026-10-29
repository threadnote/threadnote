import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import type {GitWorktreeLock} from './worktree_lock.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {assertSafeRelativePath} from '@threadnote/platform/paths';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import {remoteMemoryError} from '../errors.js';
import {randomUuidV4} from '@threadnote/platform/uuid';
import {trimTrailingCharacters} from '@threadnote/platform/string-boundaries';
import {requireGitMemoryBinding, type GitMemoryBinding} from './binding.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const GIT_REF_UPDATE_TIMEOUT_MILLISECONDS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMPOSER_LOCK_NAME = 'threadnote-composer.lock';
const COMPOSER_NAME = 'Threadnote Composer';
const COMPOSER_EMAIL = 'threadnote-composer@invalid';

export interface GitCanonicalMemoryStoreOptions {
  readonly expectedRemoteUrl?: string;
  readonly binding?: GitMemoryBinding;
  readonly worktreeLock?: GitWorktreeLock;
  readonly branch?: string;
  readonly push?: boolean;
  readonly remote?: string;
  readonly worktree: string;
}

export interface GitCanonicalCommitInput {
  /** Revalidates authority immediately before the canonical branch can change. */
  readonly authorizeRefUpdate?: (requiredValidityMilliseconds: number) => Promise<void>;
  readonly content: string;
  readonly expectedContentHash?: string;
  readonly expectedSourceHashes?: readonly {readonly path: string; readonly contentHash: string}[];
  readonly message: string;
  readonly path: string;
}

export interface GitCanonicalCommitResult {
  readonly contentHash: string;
  readonly gitCommit: string;
  readonly gitPath: string;
}

export interface GitCanonicalReadInput {
  readonly commit: string;
  readonly path: string;
}

export interface GitCanonicalCurrentFile extends GitCanonicalCommitResult {
  readonly content: string;
}

export interface GitCanonicalListedPath {
  readonly blobId: string;
  readonly gitCommit: string;
  readonly gitPath: string;
  readonly kind: 'durable' | 'handoff';
  readonly project: string;
  readonly topic: string;
}

export interface GitCanonicalListedFile extends GitCanonicalListedPath {
  readonly content: string;
  readonly contentHash: string;
}

export interface GitCanonicalSnapshot {
  readonly gitCommit: string;
  readonly paths: readonly (GitCanonicalListedPath & {readonly readable: boolean})[];
}

export function gitCanonicalSharePath(kind: 'durable' | 'handoff', project: string, topic: string): string {
  const projectSegment = validatePortableSegment(project);
  const topicSegment = validatePortableSegment(topic);
  if (kind === 'durable') return `durable/projects/${projectSegment}/${topicSegment}.md`;
  return `handoffs/active/${projectSegment}/${topicSegment}.md`;
}

export function parseGitCanonicalSharePath(
  relativePath: string,
): {readonly kind: 'durable' | 'handoff'; readonly project: string; readonly topic: string} | undefined {
  const segments = Effect.pipe(relativePath, EffectString.split('/'));
  if (
    segments.length !== 4 ||
    !Effect.pipe(segments[3], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.endsWith('.md')),
    )
  )
    return undefined;
  const topic = Effect.pipe(segments[3], EffectString.slice(0, -'.md'.length));
  try {
    const project = validatePortableSegment(segments[2]);
    const parsedTopic = validatePortableSegment(topic);
    if (segments[0] === 'durable' && segments[1] === 'projects') {
      return {kind: 'durable', project, topic: parsedTopic};
    }
    if (segments[0] === 'handoffs' && segments[1] === 'active') {
      return {kind: 'handoff', project, topic: parsedTopic};
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function gitIngestProjectsToEnsure(input: {
  readonly allowedProjects: ReadonlySet<string> | 'all';
  readonly gitProjects: Iterable<string>;
  readonly knownProjects: ReadonlySet<string>;
}): readonly string[] {
  const unique = new Set<string>();
  for (const project of input.gitProjects) {
    if (input.knownProjects.has(project)) continue;
    if (input.allowedProjects !== 'all' && !input.allowedProjects.has(project)) continue;
    unique.add(project);
  }
  return [...unique].sort();
}

export function isAbsoluteGitWorktree(path: string): boolean {
  return Effect.pipe(path, EffectString.startsWith('/')) || /^[A-Za-z]:[\\/]/u.test(path);
}

export class GitCanonicalMemoryStore {
  readonly expectedRemoteUrl?: string;
  readonly binding?: GitMemoryBinding;
  readonly worktreeLock?: GitWorktreeLock;
  readonly branch: string;
  readonly push: boolean;
  readonly remote: string;
  readonly worktree: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: GitCanonicalMemoryStoreOptions) {
    this.expectedRemoteUrl = options.expectedRemoteUrl;
    if (options.binding) this.binding = requireGitMemoryBinding(options.binding);
    const worktree = Effect.pipe(options.worktree, EffectString.trim);
    if (!worktree || !isAbsoluteGitWorktree(worktree)) {
      throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE must be an absolute path.');
    }
    this.worktree = trimTrailingCharacters(worktree, '/\\');
    this.branch = requireGitRefName(
      Effect.pipe(options.branch, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      ) || 'main',
      'THREADNOTE_REMOTE_MEMORY_GIT_BRANCH',
    );
    this.remote = requireGitRefName(
      Effect.pipe(options.remote, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      ) || 'origin',
      'THREADNOTE_REMOTE_MEMORY_GIT_REMOTE',
    );
    this.push = options.push !== false;
    this.worktreeLock = options.worktreeLock;
  }

  commit(input: GitCanonicalCommitInput): Promise<GitCanonicalCommitResult> {
    return this.serialize(() => this.commitExclusive(input));
  }

  read(input: GitCanonicalReadInput): Promise<string> {
    return this.serialize(async () => {
      const gitPath = requireSafeGitPath(input.path);
      const commit = requireGitCommit(input.commit);
      const local = await this.git(['show', `${commit}:${gitPath}`], true);
      if (local.exitCode === 0) return local.stdout;
      return this.withLock(async () => {
        await this.refreshExclusive();
        return this.showAtCommit(commit, gitPath);
      });
    });
  }

  readCurrentIfHash(path: string, expectedContentHash: string): Promise<GitCanonicalCurrentFile | undefined> {
    return this.serialize(() =>
      this.withLock(async () => {
        const gitPath = requireSafeGitPath(path);
        await this.refreshExclusive();
        if ((await this.worktreeFileHash(gitPath)) !== expectedContentHash) return undefined;
        const gitCommit = await this.headCommit();
        const content = await this.showAtCommit(gitCommit, gitPath);
        if (sha256HexSync(content) !== expectedContentHash) {
          throw remoteMemoryError('service_unavailable', 'The current canonical Git memory could not be verified.');
        }
        return {content, contentHash: expectedContentHash, gitCommit, gitPath};
      }),
    );
  }

  listCanonicalPaths(): Promise<readonly GitCanonicalListedPath[]> {
    return this.serialize(() => this.withLock(() => this.listCanonicalPathsExclusive()));
  }

  snapshot(): Promise<GitCanonicalSnapshot> {
    return this.serialize(() => this.withLock(() => this.snapshotExclusive()));
  }

  isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return this.serialize(async () => {
      const result = await this.git(
        ['merge-base', '--is-ancestor', requireGitCommit(ancestor), requireGitCommit(descendant)],
        true,
      );
      if (result.exitCode > 1)
        throw remoteMemoryError('service_unavailable', 'Git observation ancestry could not be verified.');
      return result.exitCode === 0;
    });
  }

  listBlobIds(commit: string): Promise<ReadonlyMap<string, string>> {
    return this.serialize(() => this.lsTreeBlobsExclusive(requireGitCommit(commit)));
  }

  listCanonicalFiles(): Promise<readonly GitCanonicalListedFile[]> {
    return this.serialize(() =>
      this.withLock(async () => {
        const paths = await this.listCanonicalPathsExclusive();
        const files: GitCanonicalListedFile[] = [];
        for (const path of paths) {
          const content = await this.showAtCommit(path.gitCommit, path.gitPath);
          files.push({...path, content, contentHash: sha256HexSync(content)});
        }
        return files;
      }),
    );
  }

  refresh(): Promise<void> {
    return this.serialize(() => this.withLock(() => this.refreshExclusive()));
  }

  async assertReady(): Promise<void> {
    const version = await runProcess(['git', '--version'], true, 'git');
    if (version.exitCode !== 0) {
      throw remoteMemoryError('service_unavailable', 'git is not available on the composer.');
    }
    const inside = await this.git(['rev-parse', '--is-inside-work-tree'], true);
    if (inside.exitCode !== 0 || Effect.pipe(inside.stdout, EffectString.trim) !== 'true') {
      throw remoteMemoryError('service_unavailable', 'THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE is not a git worktree.');
    }
    const writable = await runProcess(['test', '-w', this.worktree], true);
    if (writable.exitCode !== 0) {
      throw remoteMemoryError('service_unavailable', 'THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE is not writable.');
    }
    await this.assertExpectedRemote();
  }

  async assertLiveShare(): Promise<void> {
    await this.assertReady();
    const head = await this.git(['rev-parse', '--verify', 'HEAD'], true);
    if (head.exitCode !== 0 || !Effect.pipe(head.stdout, EffectString.trim)) {
      throw remoteMemoryError(
        'service_unavailable',
        'THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE has no commits; clone the live team share.',
      );
    }
  }

  private serialize<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async commitExclusive(input: GitCanonicalCommitInput): Promise<GitCanonicalCommitResult> {
    const gitPath = requireSafeGitPath(input.path);
    const contentHash = sha256HexSync(input.content);
    return this.withLock(async () => {
      await this.refreshExclusive();
      const currentHash = await this.worktreeFileHash(gitPath);
      for (const source of input.expectedSourceHashes ?? []) {
        if (source.path === gitPath && currentHash === contentHash) continue;
        if ((await this.worktreeFileHash(requireSafeGitPath(source.path))) !== source.contentHash) {
          throw remoteMemoryError('conflict', 'A citation source changed in canonical Git; re-read it and retry.', {
            reason: 'citation_source_changed',
          });
        }
      }
      if (currentHash === contentHash) {
        return {contentHash, gitCommit: await this.headCommit(), gitPath};
      }
      if (input.expectedContentHash !== undefined && currentHash !== input.expectedContentHash) {
        throw remoteMemoryError('conflict', 'The shared git memory changed; re-read it and retry.', {
          reason: 'git_cas',
        });
      }
      if (input.expectedContentHash === undefined && currentHash !== undefined) {
        throw remoteMemoryError('conflict', 'The shared git memory already exists; re-read it and retry.', {
          reason: 'git_cas',
        });
      }
      await assertContainedWorktreePath(this.worktree, gitPath);
      const base = await this.headCommit();
      const gitCommit = await this.prepareCommit(base, gitPath, input);
      if (this.push) {
        await input.authorizeRefUpdate?.(GIT_REF_UPDATE_TIMEOUT_MILLISECONDS);
        await this.git(['push', this.remote, `${gitCommit}:refs/heads/${this.branch}`], true);
        // Fetch also resolves a lost push acknowledgement without exposing an unconfirmed local commit.
        await this.refreshExclusive();
        const remoteHas = await this.git(['merge-base', '--is-ancestor', gitCommit, 'HEAD'], true);
        if (remoteHas.exitCode !== 0) {
          if ((await this.headCommit()) !== base) {
            throw remoteMemoryError('conflict', 'The shared git memory changed; re-read it and retry.', {
              reason: 'git_push_rejected',
            });
          }
          throw remoteMemoryError('service_unavailable', 'The shared git commit could not be confirmed upstream.');
        }
      } else {
        await this.assertCleanBranch();
        await input.authorizeRefUpdate?.(GIT_REF_UPDATE_TIMEOUT_MILLISECONDS);
        await this.mergeFastForward(gitCommit);
      }
      return {contentHash, gitCommit, gitPath};
    });
  }

  private async listCanonicalPathsExclusive(): Promise<readonly GitCanonicalListedPath[]> {
    const snapshot = await this.snapshotExclusive();
    return EffectArray.map(
      EffectArrayPipe(snapshot.paths, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (path, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && path.readable,
        ),
      ),
      ({readable: _readable, ...path}) => path,
    );
  }

  private async snapshotExclusive(): Promise<GitCanonicalSnapshot> {
    await this.refreshExclusive();
    const gitCommit = await this.headCommit();
    const listed = await this.git(['ls-tree', '-r', '-z', gitCommit]);
    const blobs = parseLsTreeBlobs(listed.stdout);
    const files: (GitCanonicalListedPath & {readonly readable: boolean})[] = [];
    for (const [gitPath, blobId] of parseLsTreeBlobs(listed.stdout, true)) {
      const parsed = parseGitCanonicalSharePath(gitPath);
      if (!parsed) continue;
      files.push({...parsed, blobId, gitCommit, gitPath, readable: blobs.has(gitPath)});
    }
    return {gitCommit, paths: files};
  }

  private async lsTreeBlobsExclusive(commit: string): Promise<Map<string, string>> {
    const listed = await this.git(['ls-tree', '-r', '-z', commit], true);
    if (listed.exitCode !== 0) {
      throw remoteMemoryError(
        'service_unavailable',
        `git ls-tree failed: ${Effect.pipe(listed.stderr, EffectString.trim) || Effect.pipe(listed.stdout, EffectString.trim) || 'unknown error'}`,
      );
    }
    return parseLsTreeBlobs(listed.stdout);
  }

  private async prepareCommit(base: string, gitPath: string, input: GitCanonicalCommitInput): Promise<string> {
    const temporary = joinAbsolute(await this.absoluteGitDir(), `threadnote-index-${randomUuidV4()}`);
    await runProcess(['mkdir', '-m', '700', temporary], false);
    try {
      const environment = {GIT_INDEX_FILE: joinAbsolute(temporary, 'index')};
      const run = (args: readonly string[], stdin?: string) => runGit(this.worktree, args, false, {environment, stdin});
      await run(['read-tree', base]);
      const blob = Effect.pipe((await run(['hash-object', '-w', '--stdin'], input.content)).stdout, EffectString.trim);
      await run(['update-index', '--add', '--cacheinfo', '100644', blob, gitPath]);
      const tree = Effect.pipe((await run(['write-tree'])).stdout, EffectString.trim);
      return requireGitCommit(
        (
          await run(
            ['-c', `user.name=${COMPOSER_NAME}`, '-c', `user.email=${COMPOSER_EMAIL}`, 'commit-tree', tree, '-p', base],
            input.message,
          )
        ).stdout,
      );
    } finally {
      await runProcess(['rm', '-rf', '--', temporary], true);
    }
  }

  private async assertCleanBranch(): Promise<void> {
    const branch = await this.git(['symbolic-ref', '--quiet', 'HEAD'], true);
    if (branch.exitCode !== 0 || Effect.pipe(branch.stdout, EffectString.trim) !== `refs/heads/${this.branch}`) {
      throw remoteMemoryError('conflict', 'The composer git worktree is not on its configured branch.', {
        reason: 'git_wrong_branch',
      });
    }
    const status = await this.git(['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=all']);
    if (status.stdout.length > 0) {
      throw remoteMemoryError(
        'conflict',
        'The composer git worktree has local changes; preserve and resolve them before retrying.',
        {
          reason: 'git_dirty_worktree',
        },
      );
    }
  }

  private async fastForward(commit: string): Promise<void> {
    await this.assertCleanBranch();
    await this.mergeFastForward(commit);
  }

  private async mergeFastForward(commit: string): Promise<void> {
    const merged = await this.git(['merge', '--ff-only', '--no-overwrite-ignore', commit], true);
    if (merged.exitCode !== 0) {
      throw remoteMemoryError(
        'conflict',
        'The composer git worktree could not fast-forward to the memory repository.',
        {
          reason: 'git_not_fast_forward',
        },
      );
    }
  }

  private async refreshExclusive(): Promise<void> {
    await this.assertExpectedRemote();
    await this.assertCleanBranch();
    const upstream = `refs/remotes/${this.remote}/${this.branch}`;
    const fetched = await this.git(['fetch', '--no-tags', this.remote, `+refs/heads/${this.branch}:${upstream}`], true);
    if (fetched.exitCode !== 0) {
      throw remoteMemoryError('service_unavailable', 'The composer could not fetch the configured memory branch.');
    }
    const hasUpstream = await this.git(['rev-parse', '--verify', `${upstream}^{commit}`], true);
    if (hasUpstream.exitCode !== 0) {
      throw remoteMemoryError('service_unavailable', 'The configured memory branch is missing upstream.');
    }
    const ancestor = await this.git(['merge-base', '--is-ancestor', 'HEAD', upstream], true);
    if (ancestor.exitCode !== 0) {
      if (!this.push && (await this.git(['merge-base', '--is-ancestor', upstream, 'HEAD'], true)).exitCode === 0)
        return;
      throw remoteMemoryError('conflict', 'The composer git worktree has commits not confirmed upstream.', {
        reason: 'git_not_fast_forward',
      });
    }
    await this.fastForward(requireGitCommit(hasUpstream.stdout));
  }

  private async assertExpectedRemote(): Promise<void> {
    if (!this.expectedRemoteUrl) return;
    for (const direction of [[], ['--push']]) {
      const result = await this.git(['remote', 'get-url', '--all', ...direction, this.remote], true);
      const endpoints = Effect.pipe(result.stdout, EffectString.trim, EffectString.split('\n'));
      if (result.exitCode !== 0 || endpoints.length !== 1 || endpoints[0] !== this.expectedRemoteUrl) {
        throw remoteMemoryError(
          'service_unavailable',
          'Git fetch and push must use the exact configured repository URL.',
        );
      }
    }
  }

  private async showAtCommit(commit: string, path: string): Promise<string> {
    const gitPath = requireSafeGitPath(path);
    const shown = await this.git(['show', `${requireGitCommit(commit)}:${gitPath}`], true);
    if (shown.exitCode !== 0) {
      throw remoteMemoryError('not_found', 'The git-canonical memory blob was not found.', {
        reason: 'git_missing_blob',
      });
    }
    return shown.stdout;
  }

  private async worktreeFileHash(gitPath: string): Promise<string | undefined> {
    const shown = await this.git(['show', `HEAD:${gitPath}`], true);
    if (shown.exitCode !== 0) return undefined;
    return sha256HexSync(shown.stdout);
  }

  private async headCommit(): Promise<string> {
    const parsed = await this.git(['rev-parse', 'HEAD'], true);
    const commit = Effect.pipe(parsed.stdout, EffectString.trim);
    if (parsed.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(commit)) {
      throw remoteMemoryError('service_unavailable', 'The composer git HEAD could not be resolved.');
    }
    return commit;
  }

  private async withLock<A>(operation: () => Promise<A>): Promise<A> {
    const gitDir = await this.absoluteGitDir();
    const lockPath = joinAbsolute(gitDir, COMPOSER_LOCK_NAME);
    if (!this.worktreeLock) {
      throw remoteMemoryError(
        'service_unavailable',
        'The composer Git store requires an application-scoped lock service.',
      );
    }
    return this.worktreeLock(lockPath, operation);
  }

  private async absoluteGitDir(): Promise<string> {
    const parsed = await this.git(['rev-parse', '--absolute-git-dir'], true);
    const gitDir = Effect.pipe(parsed.stdout, EffectString.trim);
    if (parsed.exitCode !== 0 || !gitDir || !isAbsoluteGitWorktree(gitDir)) {
      throw remoteMemoryError('service_unavailable', 'The composer git directory could not be resolved.');
    }
    return gitDir;
  }

  private git(
    args: readonly string[],
    allowFailure = false,
  ): Promise<{readonly exitCode: number; readonly stderr: string; readonly stdout: string}> {
    return runGit(this.worktree, args, allowFailure);
  }
}

async function assertContainedWorktreePath(worktree: string, relativePath: string): Promise<void> {
  const segments = Effect.pipe(requireSafeGitPath(relativePath), EffectString.split('/'));
  let current = worktree;
  for (const segment of segments) {
    current = joinAbsolute(current, segment);
    if (await isSymlink(current)) {
      throw remoteMemoryError('invalid_request', 'Refusing to write through a git worktree symbolic link.');
    }
  }
}

async function isSymlink(path: string): Promise<boolean> {
  const result = await runProcess(['test', '-L', path], true);
  return result.exitCode === 0;
}

function parseLsTreeBlobs(stdout: string, includeUnsupported = false): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const record of EffectArray.filter(Effect.pipe(stdout, EffectString.split('\0')), Boolean)) {
    const tab = Effect.pipe(
      record,
      EffectString.indexOf('\t'),
      Effect.Option.getOrElse(() => -1),
    );
    if (tab < 0) continue;
    const meta = Effect.pipe(record, EffectString.slice(0, tab), EffectString.split(' '));
    const gitPath = Effect.pipe(record, EffectString.slice(tab + 1));
    const blobId = meta[2];
    if (
      (!includeUnsupported && (!['100644', '100755'].includes(meta[0] ?? '') || meta[1] !== 'blob')) ||
      !blobId ||
      !/^[0-9a-f]{40,64}$/u.test(blobId)
    )
      continue;
    blobs.set(gitPath, blobId);
  }
  return blobs;
}

function requireGitRefName(value: string, name: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
    Effect.pipe(value, EffectString.startsWith('-')) ||
    Effect.pipe(value, EffectString.includes(':')) ||
    Effect.pipe(value, EffectString.includes('..'))
  ) {
    throw remoteMemoryError('invalid_request', `${name} must be a safe git refname.`);
  }
  return value;
}

function requireSafeGitPath(path: string): string {
  try {
    return assertSafeRelativePath(path);
  } catch {
    throw remoteMemoryError('invalid_request', 'The git memory path is outside the share layout.');
  }
}

function requireGitCommit(commit: string): string {
  const value = Effect.pipe(commit, EffectString.trim);
  if (!/^[0-9a-f]{40,64}$/u.test(value)) {
    throw remoteMemoryError('invalid_request', 'The git commit pointer is malformed.');
  }
  return value;
}

function joinAbsolute(root: string, ...segments: string[]): string {
  const trimmed = Effect.pipe(root, EffectString.replace(/[\\/]+$/u, ''));
  const separator =
    Effect.pipe(trimmed, EffectString.includes('\\')) && !Effect.pipe(trimmed, EffectString.includes('/')) ? '\\' : '/';
  return EffectArray.join([trimmed, ...segments], separator);
}

export interface LiveGitShareWorktreeOptions {
  readonly branch?: string;
  readonly cloneUrl: string;
  readonly remoteName?: string;
  readonly requireExactRemote?: boolean;
  readonly worktree: string;
}

export async function ensureLiveGitShareWorktree(options: LiveGitShareWorktreeOptions): Promise<string> {
  const worktree = trimTrailingCharacters(Effect.pipe(options.worktree, EffectString.trim), '/\\');
  if (!worktree || !isAbsoluteGitWorktree(worktree)) {
    throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE must be an absolute path.');
  }
  const branch = requireGitRefName(
    Effect.pipe(options.branch, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) || 'main',
    'THREADNOTE_REMOTE_MEMORY_GIT_BRANCH',
  );
  const remoteName = requireGitRefName(
    Effect.pipe(options.remoteName, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) || 'origin',
    'THREADNOTE_REMOTE_MEMORY_GIT_REMOTE',
  );
  const cloneUrl = Effect.pipe(options.cloneUrl, EffectString.trim);
  if (!cloneUrl) {
    throw remoteMemoryError('invalid_request', 'The live team git remote is required.');
  }
  const exists = (await runProcess(['test', '-d', worktree], true)).exitCode === 0;
  if (!exists || (await isEmptyDirectory(worktree))) {
    await cloneLiveShare(cloneUrl, worktree, branch, remoteName);
  }
  const store = new GitCanonicalMemoryStore({
    branch,
    remote: remoteName,
    worktree,
    ...(options.requireExactRemote ? {expectedRemoteUrl: cloneUrl} : {}),
  });
  await store.assertLiveShare();
  await assertWorktreeRemoteMatches(worktree, remoteName, cloneUrl);
  return worktree;
}

export function gitRemoteUrlsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeGitRemoteUrl(left);
  return normalizedLeft.length > 0 && normalizedLeft === normalizeGitRemoteUrl(right);
}

export function normalizeGitRemoteUrl(value: string): string {
  const trimmed = Effect.pipe(value, EffectString.trim, EffectString.replaceAll('\\', '/'));
  if (!trimmed) return '';
  const stripped = Effect.pipe(trimmed, EffectString.replace(/\.git$/u, ''), EffectString.replace(/\/+$/u, ''));
  if (Effect.pipe(stripped, EffectString.startsWith('/')) || /^[A-Za-z]:\//u.test(stripped)) {
    return Effect.pipe(stripped, EffectString.toLowerCase);
  }
  const scp = /^[^:/]+@([^:]+):(.+)$/u.exec(stripped);
  if (scp && !Effect.pipe(stripped, EffectString.includes('://'))) {
    return `${Effect.pipe(scp[1], EffectString.toLowerCase)}/${Effect.pipe(scp[2], EffectString.replace(/^\/+/u, ''))}`;
  }
  try {
    const parsed = new URL(stripped);
    if (parsed.protocol === 'file:') {
      return Effect.pipe(
        decodeURIComponent(parsed.pathname),
        EffectString.replace(/\/+$/u, ''),
        EffectString.toLowerCase,
      );
    }
    const host = Effect.pipe(parsed.hostname, EffectString.toLowerCase);
    const path = Effect.pipe(
      parsed.pathname,
      EffectString.replace(/^\/+/u, ''),
      EffectString.replace(/\/+$/u, ''),
      EffectString.replace(/\.git$/u, ''),
    );
    return path ? `${host}/${path}` : host;
  } catch {
    return Effect.pipe(stripped, EffectString.toLowerCase);
  }
}

async function assertWorktreeRemoteMatches(worktree: string, remoteName: string, cloneUrl: string): Promise<void> {
  const result = await runGit(worktree, ['remote', 'get-url', remoteName], true);
  if (result.exitCode !== 0 || !gitRemoteUrlsMatch(Effect.pipe(result.stdout, EffectString.trim), cloneUrl)) {
    throw remoteMemoryError('invalid_request', 'The existing git worktree remote does not match the live team share.');
  }
}

async function cloneLiveShare(cloneUrl: string, worktree: string, branch: string, remoteName: string): Promise<void> {
  const parent = parentDirectory(worktree);
  const created = await runProcess(['mkdir', '-p', parent], true, 'mkdir');
  if (created.exitCode !== 0) {
    throw remoteMemoryError('service_unavailable', 'The composer git worktree parent could not be created.');
  }
  const cloned = await runProcess(
    ['git', 'clone', '--branch', branch, '--origin', remoteName, '--', cloneUrl, worktree],
    true,
    'git clone',
  );
  if (cloned.exitCode !== 0) {
    throw remoteMemoryError('service_unavailable', 'Could not clone the live team git share.');
  }
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  const listing = await runProcess(['ls', '-A', path], true, 'ls');
  return listing.exitCode === 0 && Effect.pipe(listing.stdout, EffectString.trim).length === 0;
}

function parentDirectory(path: string): string {
  const index = Math.max(
    Effect.pipe(
      path,
      EffectString.lastIndexOf('/'),
      Effect.Option.getOrElse(() => -1),
    ),
    Effect.pipe(
      path,
      EffectString.lastIndexOf('\\'),
      Effect.Option.getOrElse(() => -1),
    ),
  );
  return index <= 0 ? path : Effect.pipe(path, EffectString.slice(0, index));
}

function runGit(
  worktree: string,
  args: readonly string[],
  allowFailure: boolean,
  options?: GitProcessOptions,
): Promise<{readonly exitCode: number; readonly stderr: string; readonly stdout: string}> {
  return runProcess(['git', '-C', worktree, ...args], allowFailure, `git ${args[0] ?? 'command'}`, options);
}

interface GitProcessOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

async function runProcess(
  command: readonly string[],
  allowFailure: boolean,
  label = command[0] ?? 'command',
  options?: GitProcessOptions,
): Promise<{readonly exitCode: number; readonly stderr: string; readonly stdout: string}> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({
      cmd: options?.environment
        ? [
            'env',
            ...EffectArray.map(EffectRecord.toEntries(options.environment), ([key, value]) => `${key}=${value}`),
            ...command,
          ]
        : [...command],
      stderr: 'pipe',
      stdin: options?.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
      stdout: 'pipe',
    });
  } catch {
    throw remoteMemoryError('service_unavailable', `${label} is not available on the composer.`);
  }
  const timeout = setTimeout(() => {
    child.kill();
  }, GIT_REF_UPDATE_TIMEOUT_MILLISECONDS);
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (typeof stdoutStream === 'number' || stdoutStream === undefined) {
    clearTimeout(timeout);
    child.kill();
    throw remoteMemoryError('service_unavailable', `${label} did not expose stdout.`);
  }
  if (typeof stderrStream === 'number' || stderrStream === undefined) {
    clearTimeout(timeout);
    child.kill();
    throw remoteMemoryError('service_unavailable', `${label} did not expose stderr.`);
  }
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedOutput(stdoutStream),
      readBoundedOutput(stderrStream),
      child.exited,
    ]);
    if (!allowFailure && exitCode !== 0) {
      throw remoteMemoryError(
        'service_unavailable',
        `${label} failed: ${Effect.pipe(stderr || stdout, EffectString.trim) || 'unknown error'}`,
      );
    }
    return {exitCode, stderr, stdout};
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const text = await new Response(stream).text();
  if (new TextEncoder().encode(text).byteLength > GIT_MAX_OUTPUT_BYTES) {
    throw remoteMemoryError('service_unavailable', 'Command output exceeded the composer limit.');
  }
  return text;
}
