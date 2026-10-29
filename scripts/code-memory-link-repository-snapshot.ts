import {Array as EffectArray} from 'effect';
/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed evaluation helper owns a disposable filesystem trust boundary. */
import {createHash} from 'node:crypto';
import {chmod, lstat, mkdir, open, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface CodeMemoryLinkRepositorySnapshotV1 {
  readonly repositorySnapshotHash: string;
  readonly root: string;
}

export interface CodeMemoryLinkRepositorySnapshotFileV1 {
  readonly byteCount: number;
  readonly bytes: Uint8Array;
  readonly contentSha256: string;
  readonly relativePath: string;
}

interface SnapshotDirectory {
  readonly relativePath: string;
  readonly type: 'directory';
}

interface SnapshotFile extends CodeMemoryLinkRepositorySnapshotFileV1 {
  readonly type: 'file';
}

interface SnapshotInventory {
  readonly directories: readonly SnapshotDirectory[];
  readonly files: readonly SnapshotFile[];
  readonly repositorySnapshotHash: string;
}

interface SnapshotFileIdentity {
  readonly ctimeMs: bigint | number;
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly mode: bigint | number;
  readonly mtimeMs: bigint | number;
  readonly nlink: bigint | number;
  readonly size: bigint | number;
}

const MAXIMUM_FILE_BYTES = 2 * 1_024 * 1_024;
const MAXIMUM_TOTAL_BYTES = 16 * 1_024 * 1_024;
const FORBIDDEN_PUBLIC_NAMES = new Set([
  '.codex',
  '.claude',
  '.cursor',
  '.git',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'hooks.json',
]);

/** Copy one stable public tree, make it read-only, and return its content-addressed identity. */
export async function createCodeMemoryLinkRepositorySnapshot(input: {
  readonly destinationRoot: string;
  readonly sourceRoot: string;
}): Promise<CodeMemoryLinkRepositorySnapshotV1> {
  const sourceRoot = await canonicalDirectory(input.sourceRoot, 'source repository');
  const requestedDestination = normalizedAbsolute(input.destinationRoot, 'snapshot destination');
  const destinationParent = await canonicalDirectory(dirname(requestedDestination), 'snapshot destination parent');
  const destinationRoot = join(destinationParent, basename(requestedDestination));
  if (destinationRoot !== requestedDestination) {
    throw new Error('Repository snapshot destination parent must be canonical.');
  }
  if (
    destinationRoot === sourceRoot ||
    Effect.pipe(destinationRoot, EffectString.startsWith(`${sourceRoot}${sep}`)) ||
    Effect.pipe(sourceRoot, EffectString.startsWith(`${destinationRoot}${sep}`))
  ) {
    throw new Error('Repository snapshot source and destination must be disjoint.');
  }
  const destinationParentIdentity = await lstat(destinationParent);
  await assertMissing(destinationRoot);
  const captured = await inventory(sourceRoot, false);
  const verifiedSource = await inventory(sourceRoot, false);
  if (verifiedSource.repositorySnapshotHash !== captured.repositorySnapshotHash) {
    throw new Error('Source repository changed while its stable snapshot was captured.');
  }
  let created = false;
  try {
    await mkdir(destinationRoot, {mode: 0o700});
    created = true;
    const parentAfterCreate = await lstat(destinationParent);
    if (
      !sameIdentity(destinationParentIdentity, parentAfterCreate) ||
      (await realpath(destinationParent)) !== destinationParent
    ) {
      throw new Error('Repository snapshot destination parent changed during creation.');
    }
    for (const directory of captured.directories) {
      await mkdir(join(destinationRoot, directory.relativePath), {mode: 0o700});
    }
    for (const file of captured.files) {
      const destination = join(destinationRoot, file.relativePath);
      await mkdir(dirname(destination), {mode: 0o700, recursive: true});
      await writeFile(destination, file.bytes, {flag: 'wx', mode: 0o600});
      await chmod(destination, 0o400);
    }
    for (const directory of [...captured.directories].reverse()) {
      await chmod(join(destinationRoot, directory.relativePath), 0o500);
    }
    await chmod(destinationRoot, 0o500);
    const root = await canonicalDirectory(destinationRoot, 'repository snapshot');
    const snapshot = {repositorySnapshotHash: captured.repositorySnapshotHash, root};
    await assertCodeMemoryLinkRepositorySnapshot(snapshot);
    return snapshot;
  } catch (cause) {
    if (!created) throw cause;
    try {
      await removeSnapshotRoot(destinationRoot);
    } catch {
      throw new Error('Repository snapshot creation and rollback both failed.', {
        cause,
      });
    }
    throw cause;
  }
}

/** Re-read and verify the exact read-only tree before and after every trusted consumer. */
export async function assertCodeMemoryLinkRepositorySnapshot(
  snapshot: CodeMemoryLinkRepositorySnapshotV1,
): Promise<readonly CodeMemoryLinkRepositorySnapshotFileV1[]> {
  const root = await canonicalDirectory(snapshot.root, 'repository snapshot');
  if (root !== snapshot.root) throw new Error('Repository snapshot root is not canonical.');
  const inspected = await inventory(root, true);
  if (inspected.repositorySnapshotHash !== snapshot.repositorySnapshotHash) {
    throw new Error('Repository snapshot changed after it was frozen.');
  }
  return EffectArray.map(inspected.files, ({byteCount, bytes, contentSha256, relativePath}) => ({
    byteCount,
    bytes,
    contentSha256,
    relativePath,
  }));
}

/** Remove the exact disposable snapshot without following attacker-created links. */
export async function removeCodeMemoryLinkRepositorySnapshot(
  snapshot: CodeMemoryLinkRepositorySnapshotV1,
): Promise<void> {
  const root = normalizedAbsolute(snapshot.root, 'repository snapshot cleanup root');
  await removeSnapshotRoot(root);
}

async function removeSnapshotRoot(root: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(root);
  } catch (cause) {
    if (isMissing(cause)) return;
    throw cause;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    await rm(root, {force: true});
    return;
  }
  const makeDirectoriesWritable = async (directory: string): Promise<void> => {
    await chmod(directory, 0o700);
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const entry = await lstat(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await makeDirectoriesWritable(path);
    }
  };
  await makeDirectoriesWritable(root);
  await rm(root, {force: true, maxRetries: 3, recursive: true});
}

async function inventory(root: string, requireImmutable: boolean): Promise<SnapshotInventory> {
  const directories: SnapshotDirectory[] = [];
  const files: SnapshotFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error('Repository snapshot contains a non-directory traversal node.');
    }
    if (requireImmutable && (directoryMetadata.mode & 0o222) !== 0) {
      throw new Error('Repository snapshot directory is mutable.');
    }
    if ((await realpath(directory)) !== directory) throw new Error('Repository snapshot directory is not canonical.');
    for (const name of (await readdir(directory)).sort()) {
      if (directory === root && name === '.git') continue;
      if (FORBIDDEN_PUBLIC_NAMES.has(name)) throw new Error('Repository snapshot contains a forbidden control file.');
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error('Repository snapshot symlinks are forbidden.');
      const relativePath = Effect.pipe(relative(root, path), EffectString.replaceAll('\\', '/'));
      if (!relativePath || Effect.pipe(relativePath, EffectString.startsWith('../')) || isAbsolute(relativePath)) {
        throw new Error('Repository snapshot entry escaped its root.');
      }
      if (metadata.isDirectory()) {
        directories.push({relativePath, type: 'directory'});
        await visit(path);
        continue;
      }
      if (!metadata.isFile()) throw new Error('Repository snapshot contains a non-regular entry.');
      if (metadata.nlink !== 1) throw new Error('Repository snapshot hardlinks are forbidden.');
      if (requireImmutable && (metadata.mode & 0o222) !== 0) {
        throw new Error('Repository snapshot file is mutable.');
      }
      const bytes = await stableRead(path, metadata);
      if (bytes.byteLength > MAXIMUM_FILE_BYTES) throw new Error('Repository snapshot file exceeds its byte limit.');
      totalBytes += bytes.byteLength;
      if (totalBytes > MAXIMUM_TOTAL_BYTES) throw new Error('Repository snapshot exceeds its aggregate byte limit.');
      files.push({
        byteCount: bytes.byteLength,
        bytes,
        contentSha256: sha256(bytes),
        relativePath,
        type: 'file',
      });
    }
  };
  await visit(root);
  const hashInput = [
    ...EffectArray.map(directories, entry => ({path: entry.relativePath, type: entry.type})),
    ...EffectArray.map(files, entry => ({
      byteCount: entry.byteCount,
      contentSha256: entry.contentSha256,
      path: entry.relativePath,
      type: entry.type,
    })),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    directories,
    files,
    repositorySnapshotHash: sha256(
      `threadnote-code-memory-link-repository-snapshot-v1\0${JSON.stringify(hashInput)}\n`,
    ),
  };
}

async function stableRead(path: string, initial: Awaited<ReturnType<typeof lstat>>): Promise<Uint8Array> {
  if ((await realpath(path)) !== path) throw new Error('Repository snapshot file is not canonical.');
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!sameFile(initial, before) || !before.isFile() || before.nlink !== 1) {
      throw new Error('Repository snapshot file changed before it was read.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const final = await lstat(path);
    if (!sameFile(before, after) || !sameFile(after, final) || bytes.byteLength !== after.size) {
      throw new Error('Repository snapshot file changed while it was read.');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameFile(left: SnapshotFileIdentity, right: SnapshotFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameIdentity(left: SnapshotFileIdentity, right: SnapshotFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const normalized = normalizedAbsolute(path, label);
  const metadata = await lstat(normalized);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`${label} must be a non-symlink directory.`);
  const canonical = await realpath(normalized);
  if (canonical !== normalized) throw new Error(`${label} must be canonical.`);
  return canonical;
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) return;
    throw cause;
  }
  throw new Error('Repository snapshot destination already exists.');
}

function normalizedAbsolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || Effect.pipe(path, EffectString.includes('\0'))) {
    throw new Error(`${label} must be normalized and absolute.`);
  }
  return path;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}
