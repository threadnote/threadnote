/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Evaluation subprocess provenance boundary. */
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, stat} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import {topicStudyEnvironment} from './topic-maintenance-longitudinal-process.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export async function topicStudyFileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function git(root: string, args: readonly string[]) {
  const child = Bun.spawn(['git', ...args], {
    cwd: root,
    env: topicStudyEnvironment(process.env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Source Git provenance failed: ${Effect.pipe(stderr, EffectString.slice(0, 512))}`);
  return Effect.pipe(stdout, EffectString.trim);
}

export interface TopicStudyRuntimeFingerprint {
  readonly sourceRoot: string;
  readonly sourceHead: string;
  readonly sourceTree: string;
  readonly bunPath: string;
  readonly bunVersion: string;
  readonly bunHash: string;
  readonly lockHash: string;
  readonly dependencyHash: string;
  readonly dependencyStampHash: string;
  readonly bunStamp: string;
  readonly lockStamp: string;
}

/** Hash actual installed JS/native dependency bytes, including resolved symlinks, rather than package labels. */
async function dependencyFingerprint(root: string, hashBytes: boolean) {
  const stamp = createHash('sha256');
  const hash = createHash('sha256');
  const active = new Set<string>();
  const walk = async (path: string, label: string): Promise<void> => {
    const resolved = await realpath(path);
    const info = await lstat(path);
    hash.update(`${label}\0${info.isSymbolicLink() ? resolved : ''}\0`);
    stamp.update(`${label}\0${resolved}\0${await modelStamp(resolved)}\0`);
    if (active.has(resolved)) throw new Error('Dependency tree contains a cyclic symlink.');
    const concrete = await stat(resolved);
    if (concrete.isDirectory()) {
      // Workspace source is pinned by clean Git HEAD; installed dependencies are hashed recursively.
      if (info.isSymbolicLink() && /^(?:packages|apps)\/[^/]+$/u.test(relative(resolve(root, '..'), resolved))) {
        hash.update('workspace-source\0');
        return;
      }
      active.add(resolved);
      for (const name of (await readdir(resolved)).sort()) await walk(join(resolved, name), `${label}/${name}`);
      active.delete(resolved);
    } else if (concrete.isFile()) {
      if (hashBytes) hash.update(`${await topicStudyFileHash(resolved)}\0`);
    } else throw new Error('Unsupported file in dependency boundary.');
  };
  await walk(root, 'node_modules');
  return {hash: hashBytes ? hash.digest('hex') : null, stamp: stamp.digest('hex')};
}

export async function topicStudyDependencyHash(root: string) {
  return (await dependencyFingerprint(root, true)).hash!;
}

export async function captureTopicStudyRuntime(
  root: string,
  expectedHead: string,
): Promise<TopicStudyRuntimeFingerprint> {
  const sourceRoot = await realpath(root);
  const sourceHead = await git(sourceRoot, ['rev-parse', 'HEAD']);
  if (sourceHead !== expectedHead || (await git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=normal'])))
    throw new Error('Execution requires the exact clean committed source HEAD; validation/tests may use dirty source.');
  const bunPath = await realpath(process.execPath);
  const dependency = await dependencyFingerprint(join(sourceRoot, 'node_modules'), true);
  return {
    sourceRoot,
    sourceHead,
    sourceTree: await git(sourceRoot, ['rev-parse', 'HEAD^{tree}']),
    bunPath,
    bunVersion: Bun.version,
    bunHash: await topicStudyFileHash(bunPath),
    lockHash: await topicStudyFileHash(join(sourceRoot, 'bun.lock')),
    dependencyHash: dependency.hash!,
    dependencyStampHash: dependency.stamp,
    bunStamp: await modelStamp(bunPath),
    lockStamp: await modelStamp(join(sourceRoot, 'bun.lock')),
  };
}

export async function assertTopicStudyRuntime(expected: TopicStudyRuntimeFingerprint, hashBytes = false) {
  const sourceHead = await git(expected.sourceRoot, ['rev-parse', 'HEAD']);
  if (
    sourceHead !== expected.sourceHead ||
    (await git(expected.sourceRoot, ['status', '--porcelain=v1', '--untracked-files=normal']))
  )
    throw new Error('Execution requires the exact clean committed source HEAD; validation/tests may use dirty source.');
  const dependency = await dependencyFingerprint(join(expected.sourceRoot, 'node_modules'), hashBytes);
  if (
    (await realpath(process.execPath)) !== expected.bunPath ||
    Bun.version !== expected.bunVersion ||
    (await modelStamp(expected.bunPath)) !== expected.bunStamp ||
    (await modelStamp(join(expected.sourceRoot, 'bun.lock'))) !== expected.lockStamp ||
    dependency.stamp !== expected.dependencyStampHash ||
    (hashBytes &&
      (dependency.hash !== expected.dependencyHash ||
        (await topicStudyFileHash(expected.bunPath)) !== expected.bunHash ||
        (await topicStudyFileHash(join(expected.sourceRoot, 'bun.lock'))) !== expected.lockHash))
  )
    throw new Error('Source/Bun/native dependency runtime drift; study aborted.');
}

export interface TopicStudyVerifiedModel {
  readonly id: string;
  readonly sha256: string;
  readonly size: number;
  readonly path: string;
  readonly stamp: string;
}
const modelStamp = async (path: string) => {
  const info = await stat(path, {bigint: true});
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
};

/** Copy bytes into a private read-only run path; never load mutable caller symlinks. */
export async function prepareTopicStudyModel(
  source: string,
  destination: string,
  expected: {id: string; sha256: string; size: number},
): Promise<TopicStudyVerifiedModel> {
  const resolved = await realpath(source);
  if (Number((await stat(resolved)).size) !== expected.size || (await topicStudyFileHash(resolved)) !== expected.sha256)
    throw new Error('Selected concrete GGUF does not match the required size/SHA.');
  await mkdir(resolve(destination, '..'), {recursive: true, mode: 0o700});
  await copyFile(resolved, destination);
  await chmod(destination, 0o400);
  if (
    Number((await stat(destination)).size) !== expected.size ||
    (await topicStudyFileHash(destination)) !== expected.sha256
  )
    throw new Error('Private GGUF copy did not verify.');
  return {...expected, path: await realpath(destination), stamp: await modelStamp(destination)};
}

export async function assertTopicStudyModel(model: TopicStudyVerifiedModel, hashBytes = false) {
  if (
    (await realpath(model.path)) !== model.path ||
    (await modelStamp(model.path)) !== model.stamp ||
    (hashBytes && (await topicStudyFileHash(model.path)) !== model.sha256)
  )
    throw new Error('Verified private GGUF changed; study aborted.');
}

export async function assertTopicStudySourceAdapter(root: string, adapter: string) {
  const path = relative(root, adapter);
  if (!path || Effect.pipe(path, EffectString.startsWith('..')) || Effect.pipe(path, EffectString.startsWith('/')))
    throw new Error('Adapter must belong to the pinned source checkout.');
  await git(root, ['ls-files', '--error-unmatch', '--', path]);
}

export async function applyTopicStudySourceChanges(
  repository: string,
  changes: readonly {path: string; content: string | null}[],
) {
  const {rm} = await import('node:fs/promises');
  let changed = false;
  for (const change of changes) {
    if (
      !/^[a-zA-Z0-9._/-]+$/u.test(change.path) ||
      Effect.pipe(change.path, EffectString.startsWith('/')) ||
      Effect.pipe(change.path, EffectString.split('/')).includes('..') ||
      Effect.pipe(change.path, EffectString.split('/')).includes('.git')
    )
      throw new Error('Unsafe authored source transition.');
    const target = join(repository, change.path);
    let current: string | null = null;
    try {
      current = await readFile(target, 'utf8');
    } catch (error) {
      if (!errorHasCode(error, 'ENOENT')) throw error;
    }
    if (current === change.content) continue;
    changed = true;
    if (change.content === null) await rm(target, {force: true});
    else {
      await mkdir(resolve(target, '..'), {recursive: true});
      await Bun.write(target, change.content);
    }
  }
  return changed;
}

export async function topicStudySourceTreeHash(repository: string): Promise<string> {
  const hash = createHash('sha256');
  const files: {path: string; label: string}[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === '.git') continue;
      const path = join(directory, name),
        label = `${prefix}${name}`;
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path, `${label}/`);
      else if (info.isFile()) files.push({path, label});
      else throw new Error('Fixture source timeline cannot contain symlinks.');
    }
  };
  await walk(repository, '');
  for (const {path, label} of files.sort((left, right) =>
    left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
  ))
    hash.update(`${label}\0${await topicStudyFileHash(path)}\0`);
  return hash.digest('hex');
}

export function topicStudyExpectedSourceTreeHash(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const [path, content] of [...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
    hash.update(`${path}\0${createHash('sha256').update(content).digest('hex')}\0`);
  return hash.digest('hex');
}
