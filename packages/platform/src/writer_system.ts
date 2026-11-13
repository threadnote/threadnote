import {runtimeCurrentPlatform, runtimeCurrentUserId, runtimeNativeDescriptorOperations} from './system.js';
import {Array as EffectArray, Schema, String as EffectString} from 'effect';

export {RuntimeWriterFault} from './writer-system/fault.js';
import {RuntimeWriterFault, writerFail as fail} from './writer-system/fault.js';
import {commitWriterTransaction} from './writer-system/writer-transaction.js';
import {
  openWindowsWriterRoot,
  openWindowsPrivateDirectory,
  openWindowsPrivateAuthority,
  provisionWindowsPrivateDirectory,
  type WindowsPrivateDirectory,
  type WindowsPrivateLease,
  type WindowsWriterRoot,
  type WindowsWriterTarget,
  type WindowsSourceWitness,
} from './writer-system/windows-writer.js';
import {
  posixWriterLibrary as library,
  requirePosixWriterPlatform as supported,
  readPosixAccountIdentity,
  assertPosixPrivateAcl,
  readPosixProcessIdentity,
  posixDirectoryFlags,
  posixFileFlags,
} from './writer-system/posix-native.js';
import {
  windowsTokenPrincipal,
  requireWindowsNative,
  readWindowsWriterProcessIdentity,
} from './writer-system/windows-native.js';
export interface RuntimeWindowsStableOsUserIdentity {
  readonly platform: 'win32';
  readonly architecture: 'arm64' | 'x64';
  readonly userId: string;
  readonly accountHome: string;
}
export type RuntimeStableOsUserIdentity = RuntimePosixStableOsUserIdentity | RuntimeWindowsStableOsUserIdentity;
import type {RuntimeStableOsUserIdentity as RuntimePosixStableOsUserIdentity} from './writer-system/posix-native.js';

const native = runtimeNativeDescriptorOperations();
const constants = native.constants;
const maximumFileBytes = 16 * 1024 * 1024;
export function runtimeReadStableOsUserIdentity(): RuntimeStableOsUserIdentity {
  if (runtimeCurrentPlatform() !== 'win32') return readPosixAccountIdentity();
  requireWindowsNative();
  const identity = windowsTokenPrincipal();
  const architecture = process.arch;
  if (architecture !== 'arm64' && architecture !== 'x64') return fail('unsupported-platform');
  return {platform: 'win32', architecture, userId: identity.sid, accountHome: identity.accountHome};
}

const nameBytes = (name: string) => {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[\p{Cc}\\/]/u.test(name) ||
    new TextEncoder().encode(name).length > 255
  )
    fail('path');
  return new TextEncoder().encode(`${name}\0`);
};
const checkBound = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximumFileBytes) fail('io');
};
export type RuntimeWriterIdentity = Pick<
  ReturnType<typeof stat>,
  'dev' | 'ino' | 'birthtimeNs' | 'ctimeNs' | 'mtimeNs' | 'mode' | 'uid' | 'gid' | 'nlink' | 'size'
>;
function stat(fd: number) {
  return native.fstatSync(fd, {bigint: true});
}
const same = (a: RuntimeWriterIdentity, b: RuntimeWriterIdentity) =>
  a.dev === b.dev && a.ino === b.ino && a.ino !== 0n && a.birthtimeNs === b.birthtimeNs;
const sameMetadata = (a: RuntimeWriterIdentity, b: RuntimeWriterIdentity) =>
  same(a, b) && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink && a.size === b.size;
const stable = (a: RuntimeWriterIdentity, b: RuntimeWriterIdentity) =>
  sameMetadata(a, b) && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
class LockTokenTimestampMovement extends Schema.TaggedError<
  LockTokenTimestampMovement,
  {readonly brand: unique symbol}
>()('LockTokenTimestampMovement', {bytes: Schema.UndefinedOr(Schema.Uint8Array)}) {}
function requireStable(
  before: RuntimeWriterIdentity,
  after: RuntimeWriterIdentity,
  reason: RuntimeWriterFault['reason'],
  stabilizeLockToken = false,
  bytes?: Uint8Array,
) {
  if (stable(before, after)) return;
  if (stabilizeLockToken && sameMetadata(before, after)) throw LockTokenTimestampMovement.make({bytes});
  fail(reason);
}

function assertPrivateAcl(fd: number, privateObject: boolean, stabilizeLockToken = false): void {
  const before = stat(fd);
  assertPosixPrivateAcl(fd, privateObject, before);
  requireStable(before, stat(fd), 'private-storage', stabilizeLockToken);
}
const physical = (info: RuntimeWriterIdentity) => JSON.stringify([String(info.dev), String(info.ino)]);
const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
function openAt(parent: number, name: string, flags: number, mode = 0): number {
  const lib = library();
  try {
    const fd = lib.symbols.__openat(parent, nameBytes(name), flags, mode);
    if (fd < 0) fail('path');
    return fd;
  } finally {
    lib.close();
  }
}
interface Edge {
  readonly fd: number;
  readonly identity: RuntimeWriterIdentity;
  readonly name: string;
}
interface DirectoryState {
  readonly chain: readonly Edge[];
  readonly path: string;
  closed: boolean;
}
const rootBrand: unique symbol = Symbol('writer-root');
const targetBrand: unique symbol = Symbol('writer-target');
const privateBrand: unique symbol = Symbol('writer-directory');
export interface RuntimeWriterRoot {
  readonly [rootBrand]: true;
  readonly path: string;
}
export interface RuntimeGuardedDiskTarget {
  readonly [targetBrand]: true;
}
export interface RuntimePrivateWriterDirectory {
  readonly [privateBrand]: true;
  readonly path: string;
}
interface TargetState {
  readonly root: DirectoryState;
  readonly parents: readonly Edge[];
  readonly fd: number;
  readonly name: string;
  readonly path: string;
  readonly maximumBytes: number;
  baseline: RuntimeWriterIdentity;
  closed: boolean;
  attempted: boolean;
}
const roots = new WeakMap<RuntimeWriterRoot, DirectoryState>();
const directories = new WeakMap<RuntimePrivateWriterDirectory, DirectoryState>();
const targets = new WeakMap<RuntimeGuardedDiskTarget, TargetState>();
const windowsDirectories = new WeakMap<RuntimePrivateWriterDirectory, WindowsPrivateDirectory>();
const windowsRoots = new WeakMap<RuntimeWriterRoot, WindowsWriterRoot>();
const windowsTargets = new WeakMap<RuntimeGuardedDiskTarget, WindowsWriterTarget>();
const last = (state: DirectoryState) => state.chain[state.chain.length - 1];
function closeEdges(edges: readonly Edge[]) {
  let failed = false;
  for (let i = edges.length - 1; i >= 0; i--) {
    try {
      native.closeSync(edges[i].fd);
    } catch {
      failed = true;
    }
  }
  if (failed) fail('io');
}
function openDirectory(path: string): DirectoryState {
  supported();
  if (!/^\//u.test(path) || native.realpathSync(path) !== path || /[\p{Cc}\\]/u.test(path)) fail('path');
  const parts = path === '/' ? [] : EffectString.split(EffectString.slice(1)(path), '/');
  const chain: Edge[] = [];
  try {
    const fd = native.openSync('/', posixDirectoryFlags);
    chain.push({fd, identity: stat(fd), name: '/'});
    for (const name of parts) {
      const child = openAt(chain[chain.length - 1].fd, name, posixDirectoryFlags);
      const info = stat(child);
      if (!info.isDirectory()) {
        native.closeSync(child);
        fail('path');
      }
      chain.push({fd: child, identity: info, name});
    }
    return {chain, path, closed: false};
  } catch {
    closeEdges(chain);
    return fail('path');
  }
}
function checkEdges(chain: readonly Edge[]) {
  for (let i = 0; i < chain.length; i++) {
    const edge = chain[i];
    const current = stat(edge.fd);
    if (
      !current.isDirectory() ||
      !same(current, edge.identity) ||
      current.uid !== edge.identity.uid ||
      current.gid !== edge.identity.gid ||
      current.mode !== edge.identity.mode
    )
      fail('path');
    if (i > 0) {
      const reopened = openAt(chain[i - 1].fd, edge.name, posixDirectoryFlags);
      try {
        if (!same(stat(reopened), edge.identity)) fail('path');
      } finally {
        native.closeSync(reopened);
      }
    }
  }
}
function checkDirectory(state: DirectoryState) {
  if (state.closed) fail('identity');
  checkEdges(state.chain);
}
// A directory's entries may move ctime/mtime/size/nlink without changing its retained
// identity or security. Recheck the complete ACL and current parent name once; never
// retry a failed ACL/volume proof or a sampled identity/owner/mode change.
function assertPrivateDirectoryAcl(edge: Edge, parent: Edge | undefined, privateObject: boolean): void {
  const sameCritical = (info: ReturnType<typeof stat>) =>
    info.isDirectory() &&
    same(edge.identity, info) &&
    info.uid === edge.identity.uid &&
    info.gid === edge.identity.gid &&
    info.mode === edge.identity.mode;
  const namedStat = () => {
    if (!parent) return stat(edge.fd);
    const reopened = openAt(parent.fd, edge.name, posixDirectoryFlags);
    try {
      return stat(reopened);
    } finally {
      native.closeSync(reopened);
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = stat(edge.fd),
      namedBefore = namedStat();
    if (!sameCritical(before) || !sameCritical(namedBefore)) fail('private-storage');
    assertPosixPrivateAcl(edge.fd, privateObject, before);
    // This fresh nofollow reopen cannot inherit an earlier allowed ACL sample across
    // directory-data movement: incoherence requires another full ACL sample.
    const namedAfter = namedStat(),
      after = stat(edge.fd);
    if (!sameCritical(after) || !sameCritical(namedAfter)) fail('private-storage');
    if (stable(before, namedBefore) && stable(before, namedAfter) && stable(before, after)) return;
    if (attempt !== 0) {
      const error = RuntimeWriterFault.make({reason: 'private-storage'});
      try {
        // Use only these already captured samples. No new native observation or metadata value escapes.
        const changed: string[] = [];
        for (const [name, sample] of [
          ['named-before', namedBefore],
          ['named-after', namedAfter],
          ['retained-after', after],
        ] as const)
          for (const field of ['nlink', 'size', 'ctimeNs', 'mtimeNs'] as const)
            if (before[field] !== sample[field]) changed.push(`${name}.${field}`);
        error.message = `directory-coherence:${EffectArray.join(changed, ',')}`;
      } catch {
        // Diagnostic projection must never replace the original conservative fault.
      }
      throw error;
    }
  }
}
function directoryState(directory: RuntimePrivateWriterDirectory) {
  const state = directories.get(directory);
  if (!state) return fail('identity');
  checkDirectory(state);
  const info = stat(last(state).fd);
  if (info.uid !== BigInt(runtimeCurrentUserId() ?? -1) || (info.mode & 0o077n) !== 0n) fail('private-storage');
  for (let index = 0; index < state.chain.length; index++)
    assertPrivateDirectoryAcl(state.chain[index], state.chain[index - 1], index === state.chain.length - 1);
  return state;
}
function requireFile(info: ReturnType<typeof stat>, bound: number, writable: boolean) {
  if (!info.isFile() || info.ino === 0n || info.nlink !== 1n || info.size < 0n || info.size > BigInt(bound))
    fail('path');
  if (writable && (info.mode & 0o222n) === 0n) fail('readonly');
}
function openWritableAt(parent: number, name: string, maximumBytes: number) {
  const probe = openAt(parent, name, constants.O_RDONLY | posixFileFlags);
  try {
    requireFile(stat(probe), maximumBytes, true);
  } finally {
    native.closeSync(probe);
  }
  try {
    return openAt(parent, name, constants.O_RDWR | posixFileFlags);
  } catch {
    return fail('readonly');
  }
}
function readFd(
  fd: number,
  maximumBytes: number,
  stabilizeLockToken = false,
): {identity: RuntimeWriterIdentity; bytes: Uint8Array} {
  checkBound(maximumBytes);
  const before = stat(fd);
  requireFile(before, maximumBytes, false);
  const bytes = new Uint8Array(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = native.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0 || count > bytes.length - offset) fail('io');
    offset += count;
  }
  requireStable(before, stat(fd), 'source-changed', stabilizeLockToken, bytes);
  return {identity: before, bytes};
}
export function runtimeOpenWriterRoot(
  canonicalRoot: string,
  expected: {readonly dev: bigint; readonly ino: bigint},
): RuntimeWriterRoot {
  if (runtimeCurrentPlatform() === 'win32') {
    const state = openWindowsWriterRoot(canonicalRoot, expected);
    const handle: RuntimeWriterRoot = Object.freeze({[rootBrand]: true as const, path: canonicalRoot});
    windowsRoots.set(handle, state);
    return handle;
  }
  const state = openDirectory(canonicalRoot);
  if (last(state).identity.dev !== expected.dev || last(state).identity.ino !== expected.ino) {
    closeEdges(state.chain);
    return fail('path');
  }
  const handle: RuntimeWriterRoot = Object.freeze({[rootBrand]: true as const, path: canonicalRoot});
  roots.set(handle, state);
  return handle;
}
export function runtimeCloseWriterRoot(root: RuntimeWriterRoot): void {
  const windows = windowsRoots.get(root);
  if (windows) return windows.close();
  const state = roots.get(root);
  if (!state || state.closed) return;
  state.closed = true;
  closeEdges(state.chain);
}
export function runtimeOpenGuardedDiskTarget(
  root: RuntimeWriterRoot,
  relativeSegments: readonly string[],
  expectedPhysicalIdentity: string,
  maximumBytes: number,
): RuntimeGuardedDiskTarget {
  const windows = windowsRoots.get(root);
  if (windows) {
    checkBound(maximumBytes);
    const state = windows.openTarget(relativeSegments, expectedPhysicalIdentity, maximumBytes);
    const handle: RuntimeGuardedDiskTarget = Object.freeze({[targetBrand]: true as const});
    windowsTargets.set(handle, state);
    return handle;
  }
  const state = roots.get(root);
  if (!state || relativeSegments.length === 0 || relativeSegments.length > 256) return fail('path');
  checkBound(maximumBytes);
  checkDirectory(state);
  const parents: Edge[] = [];
  let target = -1;
  try {
    let parent = last(state).fd;
    for (let i = 0; i < relativeSegments.length - 1; i++) {
      const name = relativeSegments[i];
      const fd = openAt(parent, name, posixDirectoryFlags);
      const identity = stat(fd);
      if (!identity.isDirectory()) {
        native.closeSync(fd);
        fail('path');
      }
      parents.push({fd, identity, name});
      parent = fd;
    }
    const name = relativeSegments[relativeSegments.length - 1];
    target = openWritableAt(parent, name, maximumBytes);
    const baseline = stat(target);
    requireFile(baseline, maximumBytes, true);
    if (physical(baseline) !== expectedPhysicalIdentity) fail('source-changed');
    const handle: RuntimeGuardedDiskTarget = Object.freeze({[targetBrand]: true as const});
    targets.set(handle, {
      root: state,
      parents,
      fd: target,
      name,
      path: `${state.path}/${EffectArray.join(relativeSegments, '/')}`,
      baseline,
      maximumBytes,
      closed: false,
      attempted: false,
    });
    runtimeInspectGuardedDiskTarget(handle);
    return handle;
  } catch (error) {
    if (target >= 0) native.closeSync(target);
    closeEdges(parents);
    throw error;
  }
}
function targetState(handle: RuntimeGuardedDiskTarget): TargetState {
  const state = targets.get(handle);
  if (!state || state.closed) return fail('identity');
  if (native.realpathSync(state.path) !== state.path) return fail('path');
  checkDirectory(state.root);
  const rootEdge = last(state.root);
  checkEdges([rootEdge, ...state.parents]);
  const fd = openWritableAt(state.parents[state.parents.length - 1]?.fd ?? rootEdge.fd, state.name, state.maximumBytes);
  try {
    const info = stat(fd);
    requireFile(info, state.maximumBytes, true);
    if (!stable(info, state.baseline) || !stable(stat(state.fd), state.baseline)) fail('source-changed');
  } finally {
    native.closeSync(fd);
  }
  return state;
}
export interface RuntimeGuardedDiskObservation {
  readonly identity: RuntimeWriterIdentity;
  readonly physicalIdentity: string;
  readonly bytes: Uint8Array;
}
export function runtimeInspectGuardedDiskTarget(handle: RuntimeGuardedDiskTarget): RuntimeGuardedDiskObservation {
  const windows = windowsTargets.get(handle);
  if (windows) return windows.inspect();
  const state = targetState(handle);
  const result = readFd(state.fd, state.maximumBytes);
  targetState(handle);
  return {...result, physicalIdentity: physical(result.identity)};
}
/** Compares historical data only; it neither authenticates an envelope nor enrolls a writer.
 * Exact snapshot/before bytes are required here. Recovery cannot opt out of them through this API.
 */
export function runtimeGuardedDiskTargetMatchesWindowsSourceWitness(
  handle: RuntimeGuardedDiskTarget,
  earlier: WindowsSourceWitness,
): boolean {
  const windows = windowsTargets.get(handle);
  if (!windows) return fail('identity');
  return windows.matchesSourceWitness(earlier);
}
export type RuntimeGuardedDiskWriteResult =
  | {readonly status: 'applied'; readonly current: RuntimeGuardedDiskObservation}
  | {readonly status: 'conflict'; readonly reason: 'path' | 'readonly' | 'source-changed'}
  | {readonly status: 'unknown'};
function syncFile(fd: number) {
  native.fsyncSync(fd);
  if (runtimeCurrentPlatform() !== 'darwin') return;
  const lib = library();
  try {
    if (lib.symbols.fcntl(fd, 51) !== 0) fail('io');
  } finally {
    lib.close();
  }
}
export function runtimeCommitGuardedDiskTarget(
  handle: RuntimeGuardedDiskTarget,
  input: {
    readonly before: RuntimeGuardedDiskObservation;
    readonly afterBytes: Uint8Array;
    readonly assertCurrentSync: () => void;
  },
): RuntimeGuardedDiskWriteResult {
  const windows = windowsTargets.get(handle);
  if (windows) return windows.commit(input);
  return commitWriterTransaction(input, () => {
    const state = targetState(handle);
    return {
      maximumBytes: state.maximumBytes,
      get attempted() {
        return state.attempted;
      },
      inspect: () => runtimeInspectGuardedDiskTarget(handle),
      sameIdentity: (current, before) => stable(current.identity, before.identity),
      beginAttempt() {
        state.attempted = true;
      },
      writeAt: (bytes, offset) => native.writeSync(state.fd, bytes, offset, bytes.length - offset, offset),
      truncate: length => native.ftruncateSync(state.fd, length),
      flush: () => syncFile(state.fd),
      refreshBaseline() {
        state.baseline = stat(state.fd);
      },
    };
  });
}
export function runtimeCloseGuardedDiskTarget(handle: RuntimeGuardedDiskTarget): void {
  const windows = windowsTargets.get(handle);
  if (windows) return windows.close();
  const state = targets.get(handle);
  if (!state || state.closed) return;
  state.closed = true;
  try {
    native.closeSync(state.fd);
  } finally {
    closeEdges(state.parents);
  }
}
/** Opens a caller-authorized private directory through identical native guards; useful for narrow dependency injection. */
export function runtimeOpenPrivateWriterDirectory(canonicalPath: string): RuntimePrivateWriterDirectory {
  if (runtimeCurrentPlatform() === 'win32') {
    const windows = openWindowsPrivateDirectory(canonicalPath);
    const handle: RuntimePrivateWriterDirectory = Object.freeze({[privateBrand]: true as const, path: canonicalPath});
    windowsDirectories.set(handle, windows);
    return handle;
  }
  const state = openDirectory(canonicalPath);
  const handle: RuntimePrivateWriterDirectory = Object.freeze({[privateBrand]: true as const, path: canonicalPath});
  directories.set(handle, state);
  try {
    directoryState(handle);
    return handle;
  } catch (error) {
    runtimeClosePrivateWriterDirectory(handle);
    throw error;
  }
}
/** Explicit setup only: missing Windows private children need a strict private parent or the actual account home. */
export function runtimeProvisionPrivateWriterDirectory(canonicalPath: string): RuntimePrivateWriterDirectory {
  if (runtimeCurrentPlatform() !== 'win32') return runtimeOpenPrivateWriterDirectory(canonicalPath);
  const windows = provisionWindowsPrivateDirectory(canonicalPath);
  const handle: RuntimePrivateWriterDirectory = Object.freeze({[privateBrand]: true as const, path: windows.path});
  windowsDirectories.set(handle, windows);
  return handle;
}
export function runtimeOpenPrivateWriterChild(
  directory: RuntimePrivateWriterDirectory,
  name: string,
  create: boolean,
): RuntimePrivateWriterDirectory {
  const windows = windowsDirectories.get(directory);
  if (windows) {
    const child = windows.child(name, create);
    const handle: RuntimePrivateWriterDirectory = Object.freeze({[privateBrand]: true as const, path: child.path});
    windowsDirectories.set(handle, child);
    return handle;
  }
  const state = directoryState(directory);
  const bytes = nameBytes(name);
  if (create) {
    const lib = library();
    try {
      lib.symbols.mkdirat(last(state).fd, bytes, 0o700);
    } finally {
      lib.close();
    }
  }
  const child = openAt(last(state).fd, name, posixDirectoryFlags);
  try {
    const info = stat(child);
    if (!info.isDirectory() || info.uid !== BigInt(runtimeCurrentUserId() ?? -1) || (info.mode & 0o077n) !== 0n)
      fail('private-storage');
    assertPrivateDirectoryAcl({fd: child, identity: info, name}, last(state), true);
  } finally {
    native.closeSync(child);
  }
  const path = `${state.path}/${name}`;
  const result = runtimeOpenPrivateWriterDirectory(path);
  try {
    native.fsyncSync(last(state).fd);
    return result;
  } catch (error) {
    runtimeClosePrivateWriterDirectory(result);
    throw error;
  }
}
export function runtimeOpenPrivateWriterAuthority(
  identity: RuntimeStableOsUserIdentity,
): RuntimePrivateWriterDirectory {
  if (identity.platform === 'win32') {
    if (runtimeCurrentPlatform() !== 'win32') return fail('unsupported-platform');
    const windows = openWindowsPrivateAuthority(identity.accountHome, identity.userId);
    const handle: RuntimePrivateWriterDirectory = Object.freeze({[privateBrand]: true as const, path: windows.path});
    windowsDirectories.set(handle, windows);
    return handle;
  }
  supported();
  if (identity.userId !== runtimeCurrentUserId()) fail('identity');
  const home = openDirectory(identity.accountHome);
  try {
    for (let index = 0; index < home.chain.length; index++)
      assertPrivateDirectoryAcl(home.chain[index], home.chain[index - 1], false);
    if (
      EffectArray.some(
        home.chain,
        edge =>
          (edge.identity.uid !== 0n && edge.identity.uid !== BigInt(identity.userId)) ||
          (edge.identity.mode & 0o022n) !== 0n,
      )
    )
      fail('private-storage');
    const info = stat(last(home).fd);
    if (info.uid !== BigInt(identity.userId) || (info.mode & 0o022n) !== 0n) fail('private-storage');
    const lib = library();
    try {
      lib.symbols.mkdirat(last(home).fd, nameBytes('.threadnote-writer-authority'), 0o700);
    } finally {
      lib.close();
    }
    native.fsyncSync(last(home).fd);
    return runtimeOpenPrivateWriterDirectory(`${identity.accountHome}/.threadnote-writer-authority`);
  } finally {
    home.closed = true;
    closeEdges(home.chain);
  }
}
export function runtimeClosePrivateWriterDirectory(directory: RuntimePrivateWriterDirectory): void {
  const windows = windowsDirectories.get(directory);
  if (windows) return windows.close();
  const state = directories.get(directory);
  if (!state || state.closed) return;
  state.closed = true;
  closeEdges(state.chain);
}
export function runtimeAssertPrivateWriterDirectoryCurrent(directory: RuntimePrivateWriterDirectory): void {
  const windows = windowsDirectories.get(directory);
  if (windows) return windows.assertCurrentSync();
  directoryState(directory);
}
export function runtimeReadPrivateWriterFile(
  directory: RuntimePrivateWriterDirectory,
  name: string,
  maximumBytes: number,
) {
  const windows = windowsDirectories.get(directory);
  if (windows) return windows.read(name, maximumBytes);
  const state = directoryState(directory);
  checkBound(maximumBytes);
  const parent = last(state).fd;
  let fd: number;
  try {
    fd = openAt(parent, name, constants.O_RDONLY | posixFileFlags);
  } catch {
    // Missing alone is absence; permission/symlink/type errors are authoritative failures.
    const nativePath = `${state.path}/${name}`;
    try {
      native.lstatSync(nativePath);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        directoryState(directory);
        return undefined;
      }
    }
    return fail('private-storage');
  }
  try {
    const before = stat(fd);
    if (before.uid !== BigInt(runtimeCurrentUserId() ?? -1) || (before.mode & 0o077n) !== 0n) fail('private-storage');
    assertPrivateAcl(fd, true);
    const result = readFd(fd, maximumBytes);
    if (result.identity.uid !== BigInt(runtimeCurrentUserId() ?? -1) || (result.identity.mode & 0o077n) !== 0n)
      fail('private-storage');
    const reopened = openAt(parent, name, constants.O_RDONLY | posixFileFlags);
    try {
      if (!stable(result.identity, stat(reopened))) fail('private-storage');
    } finally {
      native.closeSync(reopened);
    }
    directoryState(directory);
    return result;
  } finally {
    native.closeSync(fd);
  }
}
export type RuntimePrivatePublishResult =
  {readonly status: 'published'; readonly identity: RuntimeWriterIdentity} | {readonly status: 'unknown'};
export function runtimePublishPrivateWriterFile(
  directory: RuntimePrivateWriterDirectory,
  name: string,
  bytes: Uint8Array,
  input: {readonly mode: 'exclusive' | 'replace'; readonly assertCurrentSync: () => void; readonly nonce: string},
): RuntimePrivatePublishResult {
  const windows = windowsDirectories.get(directory);
  if (windows) return windows.publish(name, bytes, input);
  checkBound(bytes.byteLength);
  nameBytes(name);
  if (!/^[a-f0-9]{32,64}$/u.test(input.nonce)) fail('private-storage');
  const state = directoryState(directory),
    parent = last(state).fd;
  const temporary = input.mode === 'exclusive' ? name : `.pending-${input.nonce}`;
  let fd = -1,
    published = false;
  let createdIdentity: RuntimeWriterIdentity | undefined;
  try {
    input.assertCurrentSync();
    if (input.mode === 'replace') runtimeReadPrivateWriterFile(directory, name, maximumFileBytes);
    fd = openAt(parent, temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | posixFileFlags, 0o600);
    const created = stat(fd);
    createdIdentity = created;
    requireFile(created, maximumFileBytes, true);
    if (created.uid !== BigInt(runtimeCurrentUserId() ?? -1) || (created.mode & 0o777n) !== 0o600n)
      fail('private-storage');
    assertPrivateAcl(fd, true);
    let offset = 0;
    while (offset < bytes.length) {
      input.assertCurrentSync();
      assertPrivateAcl(fd, true);
      const count = native.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail('io');
      offset += count;
    }
    syncFile(fd);
    directoryState(directory);
    assertPrivateAcl(fd, true);
    input.assertCurrentSync();
    if (input.mode === 'replace') {
      const lib = library();
      try {
        if (lib.symbols.renameat(parent, nameBytes(temporary), parent, nameBytes(name)) !== 0) fail('io');
      } finally {
        lib.close();
      }
    }
    published = true;
    native.fsyncSync(parent);
    const identity = stat(fd);
    const current = runtimeReadPrivateWriterFile(directory, name, bytes.length);
    if (!current || !stable(identity, current.identity) || !equalBytes(bytes, current.bytes)) fail('private-storage');
    return {status: 'published', identity};
  } catch {
    return {status: 'unknown'};
  } finally {
    if (fd >= 0) native.closeSync(fd);
    if (!published && input.mode === 'replace' && createdIdentity) {
      try {
        input.assertCurrentSync();
        const observed = runtimeReadPrivateWriterFile(directory, temporary, maximumFileBytes);
        if (observed && same(createdIdentity, observed.identity)) {
          const lib = library();
          try {
            lib.symbols.unlinkat(parent, nameBytes(temporary), 0);
          } finally {
            lib.close();
          }
          native.fsyncSync(parent);
        }
      } catch {
        // Unconfirmed owned temp remains private and counted; lost owners perform no cleanup mutation.
      }
    }
  }
}
export function runtimeRemovePrivateWriterFile(
  directory: RuntimePrivateWriterDirectory,
  name: string,
  expected: RuntimeWriterIdentity,
  assertCurrentSync: () => void,
): void {
  const windows = windowsDirectories.get(directory);
  if (windows) return windows.remove(name, expected, assertCurrentSync);
  const state = directoryState(directory);
  const observed = runtimeReadPrivateWriterFile(directory, name, maximumFileBytes);
  if (!observed || !stable(expected, observed.identity)) fail('private-storage');
  assertCurrentSync();
  const lib = library();
  try {
    if (lib.symbols.unlinkat(last(state).fd, nameBytes(name), 0) !== 0) fail('io');
  } finally {
    lib.close();
  }
  native.fsyncSync(last(state).fd);
}
/** Bounded synchronous token read for the final lease assertion inside native mutation. */
export function runtimeReadWriterLockToken(path: string): {
  readonly token: string;
  readonly identity: RuntimeWriterIdentity;
} {
  supported();
  const anchor = native.lstatSync(path, {bigint: true});
  let sampledBytes: Uint8Array | undefined;
  // A submitted async heartbeat can complete during this synchronous read. Retry only a
  // timestamp-only incoherent observation, once, with a fresh complete ACL/byte/path proof.
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = attempt === 0 ? anchor : native.lstatSync(path, {bigint: true});
    requireFile(before, 4096, false);
    if (before.isSymbolicLink() || !sameMetadata(anchor, before)) fail('identity');
    const fd = native.openSync(path, constants.O_RDONLY | posixFileFlags);
    try {
      assertPrivateAcl(fd, true, true);
      const result = readFd(fd, 4096, true);
      if (sampledBytes && !equalBytes(sampledBytes, result.bytes)) fail('identity');
      requireStable(before, result.identity, 'identity', true, result.bytes);
      requireStable(before, native.lstatSync(path, {bigint: true}), 'identity', true, result.bytes);
      return {
        token: EffectString.trim(new TextDecoder('utf-8', {fatal: true}).decode(result.bytes)),
        identity: result.identity,
      };
    } catch (error) {
      if (!Schema.is(LockTokenTimestampMovement)(error)) throw error;
      if (attempt !== 0) fail('identity');
      sampledBytes = error.bytes;
    } finally {
      native.closeSync(fd);
    }
  }
  return fail('identity');
}

export function runtimeReadWriterProcessIdentity(processId: number): string {
  if (runtimeCurrentPlatform() !== 'win32') return readPosixProcessIdentity(processId);
  return readWindowsWriterProcessIdentity(processId);
}

/** Writer-only selection requires an issued native directory, never a path or native HANDLE grant. */
export function runtimeAcquirePrivateWriterLease(
  directory: RuntimePrivateWriterDirectory,
  path: string,
  token: string,
): WindowsPrivateLease | undefined {
  const windows = windowsDirectories.get(directory);
  if (!windows || runtimeCurrentPlatform() !== 'win32') return fail('identity');
  const prefix = windows.path + '\\';
  if (!EffectString.startsWith(prefix)(path)) return fail('path');
  return windows.acquireLease(EffectString.slice(prefix.length)(path), token);
}
// Host-only read evidence is exported through the platform facade, never a writable target.
export {
  captureWindowsSource as runtimeCaptureWindowsSource,
  sameWindowsSourceEvidence as runtimeSameWindowsSourceEvidence,
  exportWindowsSourceWitness as runtimeExportWindowsSourceWitness,
  type WindowsSourceEvidence as RuntimeWindowsSourceEvidence,
  type WindowsSourceWitness as RuntimeWindowsSourceWitness,
} from './writer-system/windows-writer.js';

/** Historical object comparison for authenticated journal observation only; never initial write eligibility. */
export function runtimeGuardedDiskTargetObservesWindowsSourceObject(
  handle: RuntimeGuardedDiskTarget,
  earlier: WindowsSourceWitness,
): boolean {
  const windows = windowsTargets.get(handle);
  if (!windows) return fail('identity');
  return windows.observesSourceObject(earlier);
}
