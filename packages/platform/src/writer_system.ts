import {dlopen, ptr} from 'bun:ffi';
import {Array as EffectArray, Schema, String as EffectString} from 'effect';

export class RuntimeWriterFault extends Schema.TaggedError<RuntimeWriterFault, {readonly brand: unique symbol}>()(
  'RuntimeWriterFault',
  {
    reason: Schema.Literals([
      'unsupported-platform',
      'identity',
      'path',
      'readonly',
      'source-changed',
      'private-storage',
      'io',
    ]),
  },
) {}
const native = process.getBuiltinModule('fs');
const constants = native.constants;
const directoryFlags = constants.O_RDONLY | 0x00100000 | constants.O_NOFOLLOW | 0x01000000;
const fileFlags = constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x01000000;
const maximumFileBytes = 16 * 1024 * 1024;
const fail = (reason: RuntimeWriterFault['reason']): never => {
  throw RuntimeWriterFault.make({reason});
};
export interface RuntimeStableOsUserIdentity {
  readonly platform: 'darwin';
  readonly architecture: 'arm64';
  readonly userId: number;
  readonly accountHome: string;
}

/** Native account database identity; Bun 1.4.4 userInfo().homedir follows HOME. */
export function runtimeReadStableOsUserIdentity(): RuntimeStableOsUserIdentity {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw RuntimeWriterFault.make({reason: 'unsupported-platform'});
  const library = dlopen('/usr/lib/libSystem.B.dylib', {
    getuid: {args: [], returns: 'u32'},
    geteuid: {args: [], returns: 'u32'},
    getpwuid_r: {args: ['u32', 'buffer', 'buffer', 'u64', 'buffer'], returns: 'i32'},
  });
  try {
    const userId = library.symbols.geteuid();
    if (userId !== library.symbols.getuid() || userId !== process.getuid?.()) fail('identity');
    // Darwin arm64 LP64, current pwd.h: uid offset16, pw_dir offset48, size72.
    const storage = new BigUint64Array(32);
    const structure = new Uint8Array(storage.buffer);
    structure.fill(0xa5);
    structure.fill(0, 0, 72);
    const scratch = new Uint8Array(65_536 + 32);
    scratch.fill(0xa5);
    scratch.fill(0, 0, 65_536);
    const result = new BigUint64Array(1);
    const record = structure.subarray(0, 72);
    const buffer = scratch.subarray(0, 65_536);
    const status = library.symbols.getpwuid_r(userId, record, buffer, 65_536n, result);
    const recordAddress = ptr(record),
      bufferAddress = ptr(buffer);
    if (
      status !== 0 ||
      !Number.isSafeInteger(recordAddress) ||
      !Number.isSafeInteger(bufferAddress) ||
      result[0] !== BigInt(recordAddress) ||
      !structure.subarray(72).every(value => value === 0xa5) ||
      !scratch.subarray(65_536).every(value => value === 0xa5)
    )
      fail('identity');
    const view = new DataView(storage.buffer);
    if (view.getUint32(16, true) !== userId) fail('identity');
    const offset = view.getBigUint64(48, true) - BigInt(bufferAddress);
    if (offset < 0n || offset >= 65_536n) fail('identity');
    const start = Number(offset),
      end = buffer.indexOf(0, start);
    if (end <= start) fail('identity');
    const accountHome = new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(start, end));
    if (!/^\//u.test(accountHome) || /[\p{Cc}]/u.test(accountHome)) fail('identity');
    return {platform: 'darwin', architecture: 'arm64', userId, accountHome};
  } catch {
    throw RuntimeWriterFault.make({reason: 'identity'});
  } finally {
    library.close();
  }
}

const supported = () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('unsupported-platform');
};
// Darwin openat is variadic: its fixed-arity __openat syscall entry is required on arm64.
// Apple xnu/libsyscall/wrappers/open-base.c declares __openat(fd,path,flags,mode_t).
const library = () => {
  supported();
  return dlopen('/usr/lib/libSystem.B.dylib', {
    __openat: {args: ['i32', 'buffer', 'i32', 'u32'], returns: 'i32'},
    mkdirat: {args: ['i32', 'buffer', 'u32'], returns: 'i32'},
    renameat: {args: ['i32', 'buffer', 'i32', 'buffer'], returns: 'i32'},
    unlinkat: {args: ['i32', 'buffer', 'i32'], returns: 'i32'},
    fcntl: {args: ['i32', 'i32'], returns: 'i32'},
  });
};
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
const stable = (a: RuntimeWriterIdentity, b: RuntimeWriterIdentity) =>
  same(a, b) &&
  a.ctimeNs === b.ctimeNs &&
  a.mtimeNs === b.mtimeNs &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.nlink === b.nlink &&
  a.size === b.size;
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
    const fd = native.openSync('/', directoryFlags);
    chain.push({fd, identity: stat(fd), name: '/'});
    for (const name of parts) {
      const child = openAt(chain[chain.length - 1].fd, name, directoryFlags);
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
      const reopened = openAt(chain[i - 1].fd, edge.name, directoryFlags);
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
function directoryState(directory: RuntimePrivateWriterDirectory) {
  const state = directories.get(directory);
  if (!state) return fail('identity');
  checkDirectory(state);
  const info = stat(last(state).fd);
  if (info.uid !== BigInt(process.getuid?.() ?? -1) || (info.mode & 0o077n) !== 0n) fail('private-storage');
  return state;
}
function requireFile(info: ReturnType<typeof stat>, bound: number, writable: boolean) {
  if (!info.isFile() || info.ino === 0n || info.nlink !== 1n || info.size < 0n || info.size > BigInt(bound))
    fail('path');
  if (writable && (info.mode & 0o222n) === 0n) fail('readonly');
}
function openWritableAt(parent: number, name: string, maximumBytes: number) {
  const probe = openAt(parent, name, constants.O_RDONLY | fileFlags);
  try {
    requireFile(stat(probe), maximumBytes, true);
  } finally {
    native.closeSync(probe);
  }
  try {
    return openAt(parent, name, constants.O_RDWR | fileFlags);
  } catch {
    return fail('readonly');
  }
}
function readFd(fd: number, maximumBytes: number): {identity: RuntimeWriterIdentity; bytes: Uint8Array} {
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
  if (!stable(before, stat(fd))) fail('source-changed');
  return {identity: before, bytes};
}
export function runtimeOpenWriterRoot(
  canonicalRoot: string,
  expected: {readonly dev: bigint; readonly ino: bigint},
): RuntimeWriterRoot {
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
      const fd = openAt(parent, name, directoryFlags);
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
  const state = targetState(handle);
  const result = readFd(state.fd, state.maximumBytes);
  targetState(handle);
  return {...result, physicalIdentity: physical(result.identity)};
}
export type RuntimeGuardedDiskWriteResult =
  | {readonly status: 'applied'; readonly current: RuntimeGuardedDiskObservation}
  | {readonly status: 'conflict'; readonly reason: 'path' | 'readonly' | 'source-changed'}
  | {readonly status: 'unknown'};
function syncFile(fd: number) {
  native.fsyncSync(fd);
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
  let changed = false;
  try {
    checkBound(input.afterBytes.byteLength);
    input.assertCurrentSync();
    const state = targetState(handle);
    if (input.afterBytes.byteLength > state.maximumBytes) fail('io');
    if (state.attempted) fail('source-changed');
    const current = runtimeInspectGuardedDiskTarget(handle);
    if (!stable(current.identity, input.before.identity) || !equalBytes(current.bytes, input.before.bytes))
      return {status: 'conflict', reason: 'source-changed'};
    state.attempted = true;
    let offset = 0;
    while (offset < input.afterBytes.length) {
      input.assertCurrentSync();
      changed = true;
      const count = native.writeSync(state.fd, input.afterBytes, offset, input.afterBytes.length - offset, offset);
      if (count <= 0 || count > input.afterBytes.length - offset) fail('io');
      offset += count;
    }
    input.assertCurrentSync();
    changed = true;
    native.ftruncateSync(state.fd, input.afterBytes.length);
    syncFile(state.fd);
    state.baseline = stat(state.fd);
    const observed = runtimeInspectGuardedDiskTarget(handle);
    if (!equalBytes(observed.bytes, input.afterBytes)) return {status: 'unknown'};
    input.assertCurrentSync();
    return {status: 'applied', current: observed};
  } catch (error) {
    if (changed) return {status: 'unknown'};
    if (
      Schema.is(RuntimeWriterFault)(error) &&
      (error.reason === 'path' || error.reason === 'readonly' || error.reason === 'source-changed')
    )
      return {status: 'conflict', reason: error.reason};
    throw error;
  }
}
export function runtimeCloseGuardedDiskTarget(handle: RuntimeGuardedDiskTarget): void {
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
export function runtimeOpenPrivateWriterChild(
  directory: RuntimePrivateWriterDirectory,
  name: string,
  create: boolean,
): RuntimePrivateWriterDirectory {
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
  const child = openAt(last(state).fd, name, directoryFlags);
  try {
    const info = stat(child);
    if (!info.isDirectory() || info.uid !== BigInt(process.getuid?.() ?? -1) || (info.mode & 0o077n) !== 0n)
      fail('private-storage');
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
  supported();
  if (identity.userId !== process.getuid?.()) fail('identity');
  const home = openDirectory(identity.accountHome);
  try {
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
  const state = directories.get(directory);
  if (!state || state.closed) return;
  state.closed = true;
  closeEdges(state.chain);
}
export function runtimeAssertPrivateWriterDirectoryCurrent(directory: RuntimePrivateWriterDirectory): void {
  directoryState(directory);
}
export function runtimeReadPrivateWriterFile(
  directory: RuntimePrivateWriterDirectory,
  name: string,
  maximumBytes: number,
) {
  const state = directoryState(directory);
  checkBound(maximumBytes);
  const parent = last(state).fd;
  let fd: number;
  try {
    fd = openAt(parent, name, constants.O_RDONLY | fileFlags);
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
    const result = readFd(fd, maximumBytes);
    if (result.identity.uid !== BigInt(process.getuid?.() ?? -1) || (result.identity.mode & 0o077n) !== 0n)
      fail('private-storage');
    const reopened = openAt(parent, name, constants.O_RDONLY | fileFlags);
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
    fd = openAt(parent, temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | fileFlags, 0o600);
    const created = stat(fd);
    createdIdentity = created;
    requireFile(created, maximumFileBytes, true);
    if (created.uid !== BigInt(process.getuid?.() ?? -1) || (created.mode & 0o777n) !== 0o600n) fail('private-storage');
    let offset = 0;
    while (offset < bytes.length) {
      input.assertCurrentSync();
      const count = native.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail('io');
      offset += count;
    }
    syncFile(fd);
    directoryState(directory);
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
  const before = native.lstatSync(path, {bigint: true});
  requireFile(before, 4096, false);
  if (before.isSymbolicLink()) fail('path');
  const fd = native.openSync(path, constants.O_RDONLY | fileFlags);
  try {
    const result = readFd(fd, 4096);
    if (!stable(before, result.identity) || !stable(before, native.lstatSync(path, {bigint: true}))) fail('identity');
    return {
      token: EffectString.trim(new TextDecoder('utf-8', {fatal: true}).decode(result.bytes)),
      identity: result.identity,
    };
  } finally {
    native.closeSync(fd);
  }
}

/** Darwin proc_bsdinfo binds a live process to microsecond start time, not PID alone. */
export function runtimeReadWriterProcessIdentity(processId: number): string {
  supported();
  if (!Number.isSafeInteger(processId) || processId <= 0 || processId > 0x7fffffff) return fail('identity');
  const lib = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: {args: ['i32', 'i32', 'u64', 'buffer', 'i32'], returns: 'i32'},
  });
  try {
    // Current Darwin arm64 proc_info.h: proc_bsdinfo size136, pid12, uid20, start120/128.
    const storage = new BigUint64Array(21);
    const bytes = new Uint8Array(storage.buffer);
    bytes.fill(0xa5);
    const count = lib.symbols.proc_pidinfo(processId, 3, 0n, bytes.subarray(0, 136), 136);
    if (count !== 136 || !bytes.subarray(136).every(value => value === 0xa5)) return fail('identity');
    const view = new DataView(storage.buffer);
    const seconds = view.getBigUint64(120, true),
      micros = view.getBigUint64(128, true);
    if (
      view.getUint32(12, true) !== processId ||
      view.getUint32(20, true) !== process.getuid?.() ||
      seconds === 0n ||
      micros >= 1_000_000n
    )
      return fail('identity');
    return `darwin-proc-bsd-v1:${seconds}:${micros}`;
  } catch {
    return fail('identity');
  } finally {
    lib.close();
  }
}
