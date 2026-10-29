import {Array as EffectArray} from 'effect';
/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This evaluation boundary observes Git and owns local artifact CAS writes. */

import {createHash} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {lstat, mkdir, open, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {captureCodeMemoryLinkProcessGroup} from './code-memory-link-process-boundary.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface MatchedEvaluationRepositoryObservationV1 {
  readonly dirty: boolean;
  readonly fixtureHash: string;
  readonly identityHash: string;
  readonly revision: string;
}

const MAXIMUM_REPOSITORY_FILE_BYTES = 64 * 1_024 * 1_024;
const MAXIMUM_REPOSITORY_FIXTURE_BYTES = 512 * 1_024 * 1_024;
const MAXIMUM_REPOSITORY_PATH_LIST_BYTES = 16 * 1_024 * 1_024;

export async function observeMatchedEvaluationRepositoryV1(
  repositoryDirectory: string,
): Promise<MatchedEvaluationRepositoryObservationV1> {
  const root = await canonicalDirectory(repositoryDirectory, 'runtime repository directory');
  const [rootResult, commonDirectoryResult, remoteResult, initialRevision, initialStatus, pathsResult] =
    await Promise.all([
      captureGit(root, ['rev-parse', '--show-toplevel'], 16 * 1_024),
      captureGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 16 * 1_024),
      captureGit(root, ['remote', 'get-url', 'origin'], 16 * 1_024, true),
      captureGit(root, ['rev-parse', 'HEAD'], 16 * 1_024),
      captureGit(root, repositoryStatusArguments(), MAXIMUM_REPOSITORY_PATH_LIST_BYTES),
      captureGit(root, repositoryFileListArguments(), MAXIMUM_REPOSITORY_PATH_LIST_BYTES),
    ]);
  const observedRoot = await realpath(singleLine(rootResult.stdout, 'repository root'));
  if (observedRoot !== root) throw new Error('Runtime repository directory must be the Git worktree root.');
  const commonDirectory = await realpath(singleLine(commonDirectoryResult.stdout, 'Git common directory'));
  const remoteIdentity =
    remoteResult.exitCode === 0
      ? normalizeCredentialFreeRemote(singleLine(remoteResult.stdout, 'origin remote'))
      : undefined;
  const localIdentity = Effect.pipe(
    commonDirectory,
    EffectString.replaceAll('\\', '/'),
    EffectString.replace(/\/+$/u, ''),
  );
  const repositorySource =
    remoteIdentity ??
    `local:${process.platform === 'win32' ? Effect.pipe(localIdentity, EffectString.toLowerCase) : localIdentity}`;
  const revision = singleLine(initialRevision.stdout, 'repository revision');
  const paths = EffectArray.filter(
    nulRecords(pathsResult.stdout, 'repository file list'),
    path => !hasContextPathSegment(path),
  );
  const fixtureHash = await matchedEvaluationRepositoryFixtureHashV1(root, paths);
  const [finalRevision, finalStatus] = await Promise.all([
    captureGit(root, ['rev-parse', 'HEAD'], 16 * 1_024),
    captureGit(root, repositoryStatusArguments(), MAXIMUM_REPOSITORY_PATH_LIST_BYTES),
  ]);
  if (finalRevision.stdout !== initialRevision.stdout || finalStatus.stdout !== initialStatus.stdout) {
    throw new Error('Runtime repository changed while its evaluation identity was observed.');
  }
  return {
    dirty: initialStatus.stdout.length > 0,
    fixtureHash,
    identityHash: sha256Text(`repository-v1\n${repositorySource}`),
    revision,
  };
}

export async function assertMatchedEvaluationRepositoryV1(
  repositoryDirectory: string,
  expected: MatchedEvaluationRepositoryObservationV1,
): Promise<void> {
  const observed = await observeMatchedEvaluationRepositoryV1(repositoryDirectory);
  for (const field of ['dirty', 'fixtureHash', 'identityHash', 'revision'] as const) {
    if (observed[field] !== expected[field]) {
      throw new Error(`Runtime repository ${field} differs from the content-addressed manifest.`);
    }
  }
}

export async function withMatchedEvaluationArtifactLockV1<A>(
  artifactDirectory: string,
  use: () => Promise<A>,
): Promise<A> {
  const lockDirectory = resolve(artifactDirectory, '.matched-evaluation-runner.lock');
  try {
    await mkdir(lockDirectory, {mode: 0o700});
  } catch (cause) {
    if (isAlreadyExists(cause)) {
      throw new Error('Another matched evaluation runner owns this artifact directory.', {cause});
    }
    throw cause;
  }
  try {
    await writeFile(
      resolve(lockDirectory, 'owner.json'),
      `${JSON.stringify({pid: process.pid, startedAt: new Date().toISOString(), version: 1})}\n`,
      {encoding: 'utf8', flag: 'wx', mode: 0o600},
    );
    return await use();
  } finally {
    await rm(lockDirectory, {force: true, recursive: true});
  }
}

export async function compareAndSwapMatchedEvaluationLedgerV1(
  path: string,
  expectedText: string,
  replacementText: string,
): Promise<void> {
  const current = await readOptionalText(path, 16 * 1_024 * 1_024);
  if (current !== expectedText) throw new Error('Outcome ledger changed while the runner was active.');
  await atomicWrite(path, replacementText);
}

export async function assertMatchedEvaluationPinnedFileV1(
  path: string,
  expectedHash: string,
  executable: boolean,
  label: string,
): Promise<void> {
  const canonical = await optionalCanonicalRegularFile(path, executable);
  if (canonical === null || (await sha256File(canonical)) !== expectedHash) {
    throw new Error(`${label} differs from its pinned manifest identity.`);
  }
}

export async function stageMatchedEvaluationPinnedFileV1(
  sourcePath: string,
  targetPath: string,
  expectedHash: string,
  executable: boolean,
  label: string,
): Promise<string> {
  const source = await optionalCanonicalRegularFile(sourcePath, executable);
  if (source === null) throw new Error(`${label} is missing.`);
  const handle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (executable && (before.mode & 0o111) === 0)) {
      throw new Error(`${label} changed before it could be staged.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileObservation(before, after) || sha256Bytes(bytes) !== expectedHash) {
      throw new Error(`${label} differs from its pinned manifest identity.`);
    }
    await writeFile(targetPath, bytes, {flag: 'wx', mode: executable ? 0o500 : 0o400});
    await assertMatchedEvaluationPinnedFileV1(targetPath, expectedHash, executable, `staged ${label}`);
    return targetPath;
  } finally {
    await handle.close();
  }
}

async function matchedEvaluationRepositoryFixtureHashV1(root: string, inputPaths: readonly string[]): Promise<string> {
  const paths = [...new Set(inputPaths)].sort(compareText);
  const entries: Array<{
    readonly hash?: string;
    readonly mode?: number;
    readonly path: string;
    readonly type: 'file' | 'missing';
  }> = [];
  let retainedBytes = 0;
  for (const path of paths) {
    const absolute = containedRepositoryPath(root, path);
    let before;
    try {
      before = await lstat(absolute);
    } catch (cause) {
      if (isMissing(cause)) {
        entries.push({path, type: 'missing'});
        continue;
      }
      throw cause;
    }
    if (before.isSymbolicLink()) {
      const after = await lstat(absolute);
      if (!sameFileObservation(before, after)) throw new Error(`Repository fixture path changed while read: ${path}`);
      throw new Error(`Repository fixture path must not be symbolic link: ${path}`);
    }
    if (!before.isFile() || before.nlink !== 1 || before.size > MAXIMUM_REPOSITORY_FILE_BYTES) {
      throw new Error(`Repository fixture path is not one bounded regular file: ${path}`);
    }
    retainedBytes += before.size;
    if (retainedBytes > MAXIMUM_REPOSITORY_FIXTURE_BYTES) {
      throw new Error('Repository fixture exceeds the evaluation byte limit.');
    }
    const bytes = await readFile(absolute);
    const after = await lstat(absolute);
    if (bytes.byteLength !== before.size || !sameFileObservation(before, after)) {
      throw new Error(`Repository fixture path changed while read: ${path}`);
    }
    entries.push({hash: sha256Bytes(bytes), mode: before.mode & 0o777, path, type: 'file'});
  }
  return sha256Text(`matched-evaluation-repository-fixture-v1\n${JSON.stringify(entries)}`);
}

function containedRepositoryPath(root: string, path: string): string {
  if (!path || Effect.pipe(path, EffectString.includes('\0')) || isAbsolute(path))
    throw new Error('Repository fixture path is invalid.');
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (
    !fromRoot ||
    fromRoot === '..' ||
    Effect.pipe(fromRoot, EffectString.startsWith(`..${sep}`)) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error('Repository fixture path escapes the repository root.');
  }
  return absolute;
}

function repositoryStatusArguments(): readonly string[] {
  return [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
    ':(exclude).context/**',
    ':(exclude)**/.context/**',
  ];
}

function repositoryFileListArguments(): readonly string[] {
  return [
    'ls-files',
    '-co',
    '--exclude-standard',
    '-z',
    '--',
    '.',
    ':(exclude).context/**',
    ':(exclude)**/.context/**',
  ];
}

async function captureGit(
  root: string,
  arguments_: readonly string[],
  maximumOutputBytes: number,
  allowFailure = false,
) {
  return await captureCodeMemoryLinkProcessGroup({
    allowFailure,
    arguments: ['-C', root, ...arguments_],
    command: 'git',
    cwd: root,
    environment: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
    label: 'Matched evaluation repository observation',
    maxOutputBytes: maximumOutputBytes,
    timeoutMilliseconds: 30_000,
  });
}

function normalizeCredentialFreeRemote(value: string): string | undefined {
  const trimmed = Effect.pipe(value, EffectString.trim);
  if (!trimmed || Effect.pipe(trimmed, EffectString.includes('\0')) || /[\r\n]/u.test(trimmed)) return undefined;
  const scp = Effect.pipe(trimmed, EffectString.includes('://'))
    ? undefined
    : /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(trimmed);
  if (scp && !/^[A-Za-z]:[\\/]/u.test(trimmed)) return normalizeRemoteParts(scp[1], scp[2]);
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'file:') return undefined;
    return normalizeRemoteParts(url.hostname, url.pathname);
  } catch {
    return undefined;
  }
}

function normalizeRemoteParts(host: string, pathname: string): string | undefined {
  const safeHost = Effect.pipe(
    host,
    EffectString.trim,
    EffectString.toLowerCase,
    EffectString.replace(/^\[|\]$/gu, ''),
  );
  const safePath = Effect.pipe(
    pathname,
    EffectString.replaceAll('\\', '/'),
    EffectString.replace(/^\/+/, ''),
    EffectString.replace(/\/+$/, ''),
    EffectString.replace(/\.git$/iu, ''),
  );
  if (!safeHost || !safePath || Effect.pipe(safePath, EffectString.includes('..'))) return undefined;
  return `${safeHost}/${safePath}`;
}

function nulRecords(value: string, label: string): readonly string[] {
  if (!value) return [];
  if (!Effect.pipe(value, EffectString.endsWith('\0'))) throw new Error(`${label} is not NUL terminated.`);
  const records = Effect.pipe(value, __effectPipeInput => {
    const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.slice(0, -1));
    const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.split('\0'));
    return __effectPipeStage1;
  });
  if (
    EffectArray.some(
      records,
      record =>
        !record || Effect.pipe(record, EffectString.includes('\r')) || Effect.pipe(record, EffectString.includes('\n')),
    )
  ) {
    throw new Error(`${label} contains an invalid path.`);
  }
  return records;
}

function singleLine(value: string, label: string): string {
  if (!Effect.pipe(value, EffectString.endsWith('\n'))) throw new Error(`${label} is incomplete.`);
  const line = Effect.pipe(value, EffectString.slice(0, -1));
  if (
    !line ||
    Effect.pipe(line, EffectString.includes('\n')) ||
    Effect.pipe(line, EffectString.includes('\r')) ||
    Effect.pipe(line, EffectString.includes('\0'))
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return line;
}

function hasContextPathSegment(path: string): boolean {
  return Effect.pipe(path, EffectString.split('/')).includes('.context');
}

function sameFileObservation(
  left: {
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly mtimeMs: number;
    readonly size: number;
  },
  right: {
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly mtimeMs: number;
    readonly size: number;
  },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} must use its canonical path.`);
  return canonical;
}

async function optionalCanonicalRegularFile(path: string, executable: boolean): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${path} must be one regular non-linked file.`);
  }
  if (executable && (metadata.mode & 0o111) === 0) throw new Error(`${path} must be executable.`);
  const canonical = await realpath(path);
  const current = await lstat(canonical);
  if (canonical !== path || current.dev !== metadata.dev || current.ino !== metadata.ino) {
    throw new Error(`${path} changed or is not canonical.`);
  }
  return canonical;
}

async function readOptionalText(path: string, maximumBytes: number): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) return '';
    throw cause;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
    throw new Error(`${path} is not one bounded regular file.`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) throw new Error(`${path} changed while it was read.`);
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(resolve(path, '..'), {recursive: true, mode: 0o700});
  try {
    await rm(temporary, {force: true});
    await writeFile(temporary, content, {encoding: 'utf8', flag: 'wx', mode: 0o600});
    await rename(temporary, path);
  } finally {
    await rm(temporary, {force: true});
  }
}

async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

function sha256Text(value: string): string {
  return sha256Bytes(new TextEncoder().encode(value));
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

function isAlreadyExists(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST';
}
