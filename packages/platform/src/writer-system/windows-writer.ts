import {sha256HexSync} from '../sha256.js';
import {Array as EffectArray, Option, Schema, String as EffectString} from 'effect';
import {runtimeNativeDescriptorOperations} from '../system.js';
import type {RuntimeGuardedDiskObservation, RuntimeWriterIdentity} from '../writer_system.js';
import {RuntimeWriterFault, writerFail as fail} from './fault.js';
import {withNativeArguments} from './native-arguments.js';
import {
  windowsAddress,
  windowsSystemLibrary,
  windowsTokenPrincipal,
  readWindowsWriterProcessIdentity,
  windowsWide,
  type WindowsNativeResourceOwner,
} from './windows-native.js';
import {
  windowsFileLibrary,
  windowsCreatePrivateAt,
  WindowsPrivateCreateBusy,
  assertWindowsProtectedSecurity,
  windowsNativeName,
  type WindowsPrivateCreatedFile,
  windowsFileIdentity,
  windowsVolumeType,
  windowsSecurityLibrary,
  windowsReadFileSecurity,
  windowsPathComponent,
  trustedInstallerOwner,
  type NativeFileIdentity,
  type WindowsFileSecurity,
} from './windows-files.js';
import {commitWriterTransaction, type WriterTransactionResult} from './writer-transaction.js';

const native = runtimeNativeDescriptorOperations();
const maximumBytes = 16 * 1024 * 1024;
const maximumBundles = 64;
const maximumComponents = 256;
const invalid = 0xffffffffffffffffn;
const epoch = 116_444_736_000_000_000n;
const outstanding = new Set<Resources>();
let ownershipUnknown = false;
function assertAcquisitionAvailable(): void {
  if (ownershipUnknown || outstanding.size >= maximumBundles) fail('identity');
}
interface Resource {
  state: 'owned' | 'closed' | 'close-unknown';
  readonly release: () => boolean;
}
interface HandleResource extends Resource {
  readonly handle: bigint;
}
function ntLibrary(owner: WindowsNativeResourceOwner) {
  return windowsSystemLibrary(
    'ntdll.dll',
    {
      NtSetInformationFile: {args: ['u64', 'buffer', 'buffer', 'u32', 'u32'], returns: 'i32'},
      NtCreateFile: {
        args: ['buffer', 'u32', 'buffer', 'buffer', 'ptr', 'u32', 'u32', 'u32', 'u32', 'ptr', 'u32'],
        returns: 'i32',
      },
    },
    owner,
  );
}
/** Fixed local ownership ledger, including acquisitions that never returned a facade handle. */
class Resources {
  readonly kernel: ReturnType<typeof windowsFileLibrary>;
  readonly security: ReturnType<typeof windowsSecurityLibrary>;
  readonly nt: ReturnType<typeof ntLibrary>;
  readonly principal: string;
  readonly servicingOwner: string;
  readonly records = new Set<Resource>();
  readonly pendingBacking = new Set<unknown>();
  active = true;
  closeRequested = false;
  unknown = false;
  constructor() {
    assertAcquisitionAvailable();
    outstanding.add(this);
    try {
      this.kernel = this.module(windowsFileLibrary());
      this.security = windowsSecurityLibrary(this.captureNative);
      this.nt = ntLibrary(this.captureNative);
      this.principal = windowsTokenPrincipal(undefined, this.captureNative).sid;
      this.servicingOwner = trustedInstallerOwner(this.kernel, this.security);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  captureNative: WindowsNativeResourceOwner = release => {
    const record: Resource = {state: 'owned', release};
    this.records.add(record);
    return () => this.release(record);
  };
  module<A extends {close(): void}>(library: A): A {
    this.records.add({
      state: 'owned',
      release: () => {
        library.close();
        return true;
      },
    });
    return library;
  }
  uncertain(backing?: unknown): never {
    this.unknown = true;
    this.active = false;
    ownershipUnknown = true;
    if (backing !== undefined) this.pendingBacking.add(backing);
    return fail('io');
  }
  assertActive(): void {
    if (!this.active || this.unknown || ownershipUnknown) fail('identity');
  }
  own(handle: bigint): HandleResource {
    if (handle === 0n || handle === invalid) return fail('io');
    const record: HandleResource = {
      handle,
      state: 'owned',
      release: () => this.kernel.symbols.CloseHandle(handle) !== 0,
    };
    this.records.add(record);
    return record;
  }
  descriptor = (address: bigint): (() => void) => {
    const record: Resource = {
      state: 'owned',
      release: () => this.kernel.symbols.LocalFree(address) === 0n,
    };
    this.records.add(record);
    return () => this.release(record);
  };
  release(record: Resource): void {
    if (record.state === 'closed') return;
    if (this.unknown) return fail('io');
    if (record.state === 'close-unknown') return this.uncertain();
    record.state = 'close-unknown';
    try {
      if (!record.release()) return this.uncertain();
    } catch {
      return this.uncertain();
    }
    record.state = 'closed';
    this.records.delete(record);
  }
  close(): void {
    if (this.unknown) return fail('io');
    if (this.pendingBacking.size !== 0) return this.uncertain();
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.active = false;
    // Stop on first uncertain release. Its bundle, backing, and remaining resources stay strongly owned.
    for (const record of EffectArray.reverse(Array.from(this.records))) this.release(record);
    outstanding.delete(this);
  }
  securityOf(handle: bigint, servicingOwner: string | undefined): WindowsFileSecurity {
    return windowsReadFileSecurity(handle, this.principal, false, servicingOwner, {
      kernel: this.kernel,
      security: this.security,
      ownDescriptor: this.descriptor,
      uncertain: backing => this.uncertain(backing),
    });
  }
  openAt(
    parent: HandleResource,
    name: string,
    directory: boolean,
    writable = false,
    privateAccess = false,
    allowMissing = false,
  ): HandleResource {
    this.assertActive();
    if (parent.state !== 'owned') return fail('identity');
    const wide = windowsPathComponent(name),
      // Materialize backing before placing its absolute address inside UNICODE_STRING.
      wideBytes = new Uint8Array(wide.buffer),
      string = new BigUint64Array(2),
      stringView = new DataView(string.buffer),
      attributes = new BigUint64Array(6),
      attributesView = new DataView(attributes.buffer),
      output = new BigUint64Array(1),
      guarded = new BigUint64Array(6),
      io = new Uint8Array(guarded.buffer, 0, 16);
    stringView.setUint16(0, wide.byteLength - 2, true);
    stringView.setUint16(2, wide.byteLength, true);
    stringView.setBigUint64(8, windowsAddress(wide), true);
    attributesView.setUint32(0, 48, true);
    attributesView.setBigUint64(8, parent.handle, true);
    attributesView.setBigUint64(16, windowsAddress(string), true);
    attributesView.setUint32(24, 0x40 | 0x1000, true); // CASE_INSENSITIVE | DONT_REPARSE; not kernel-only attributes.
    guarded.fill(0xa5a5a5a5a5a5a5a5n);
    const access = privateAccess
      ? directory
        ? 0xc01000a3
        : 0x00130081
      : directory
        ? 0x001200a1
        : writable
          ? 0x00120183
          : 0x00120081;
    const backing = [wide, wideBytes, string, attributes, output, guarded, io];
    this.pendingBacking.add(backing);
    const status = withNativeArguments(backing, () =>
      this.nt.symbols.NtCreateFile(
        output,
        access,
        attributes,
        io,
        null,
        0,
        writable && !privateAccess ? 1 : 7,
        1, // FILE_OPEN: acquisition never creates, overwrites, or truncates.
        0x00200000 | 0x20 | (directory ? 1 : 0x40),
        null,
        0,
      ),
    );
    if (status !== 0) {
      if (status === 0x103 || output[0] !== 0n) this.uncertain(backing);
      this.pendingBacking.delete(backing);
      if (allowMissing && status >>> 0 === 0xc0000034) throw WindowsPrivateMissing.make({});
      return fail(writable && (status >>> 0 === 0xc0000022 || status >>> 0 === 0xc0000043) ? 'readonly' : 'path');
    }
    const owned = this.own(output[0]); // Register before any status/metadata/security check can fail.
    if (
      !guarded.subarray(2).every(value => value === 0xa5a5a5a5a5a5a5a5n) ||
      new DataView(guarded.buffer).getInt32(0, true) !== 0 ||
      guarded[1] !== 1n
    )
      this.uncertain(backing);
    this.pendingBacking.delete(backing);
    return owned;
  }
}
interface Edge {
  readonly resource: HandleResource;
  readonly identity: NativeFileIdentity;
  readonly security: WindowsFileSecurity;
  readonly name: string;
  readonly path: string;
}
const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const sameObject = (a: NativeFileIdentity, b: NativeFileIdentity) =>
  a.volumeId === b.volumeId &&
  a.fileId === b.fileId &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.birthtime === b.birthtime;
const sameCritical = (a: NativeFileIdentity, b: NativeFileIdentity) =>
  sameObject(a, b) && (a.attributes & ~0x20) === (b.attributes & ~0x20);
const stable = (a: NativeFileIdentity, b: NativeFileIdentity) =>
  sameObject(a, b) &&
  a.attributes === b.attributes &&
  a.changed === b.changed &&
  a.modified === b.modified &&
  a.links === b.links &&
  a.size === b.size;
const sameSecurity = (a: WindowsFileSecurity, b: WindowsFileSecurity) =>
  a.owner === b.owner && equalBytes(a.bytes, b.bytes);
function projected(path: string, id: NativeFileIdentity, directory: boolean): RuntimeWriterIdentity {
  const info = native.lstatSync(path, {bigint: true});
  const fileId = EffectString.split(id.fileId, ',');
  if (
    fileId.length !== 16 ||
    !EffectArray.every(fileId, value => {
      const byte = Number(value);
      return Number.isSafeInteger(byte) && byte >= 0 && byte <= 255 && String(byte) === value;
    })
  ) {
    const error = RuntimeWriterFault.make({reason: 'unsupported-platform'});
    error.message = 'windows-projection:fileIdEncoding';
    throw error;
  }
  const raw = new Uint8Array(EffectArray.map(fileId, value => Number(value))),
    view = new DataView(raw.buffer),
    low = view.getBigUint64(0, true),
    high = view.getBigUint64(8, true);
  // Preserve the original short-circuit predicate order and report only a fixed field name.
  const failed =
    (info.isSymbolicLink() && 'symbolicLink') ||
    (info.isDirectory() !== directory && 'directoryType') ||
    (!directory && !info.isFile() && 'fileType') ||
    ((id.volumeId & 0xffffffffn) !== id.dev && 'volumeLow32') ||
    (info.dev !== id.dev && 'volumeDev') ||
    (high !== 0n && 'fileIdHigh') ||
    (low === 0n && 'fileIdNonzero') ||
    (low !== id.ino && 'fileIdLegacy') ||
    (info.ino !== low && 'fileIdBun') ||
    (info.birthtimeNs !== (id.birthtime - epoch) * 100n && 'birth') ||
    (info.ctimeNs !== (id.changed - epoch) * 100n && 'changed') ||
    (info.mtimeNs !== (id.modified - epoch) * 100n && 'modified') ||
    (info.nlink !== BigInt(id.links) && 'links') ||
    // Bun 1.4.4 pins libuv 8023581113b276e7c1aee3f82da57ca0893faab1: win/fs.c exposes directory st_size as zero.
    (info.size !== (directory ? 0n : id.size) && 'size');
  if (failed) {
    const error = RuntimeWriterFault.make({reason: 'unsupported-platform'});
    error.message = `windows-projection:${failed}`;
    throw error;
  }
  return info; // Actual compatibility observations only; UID/GID/mode never supply native authority.
}
function capture(
  resources: Resources,
  resource: HandleResource,
  name: string,
  path: string,
  directory: boolean,
  compatibility = true,
): Edge {
  const identity = windowsFileIdentity(resources.kernel, resource.handle);
  if (
    ((identity.attributes & 0x10) !== 0) !== directory ||
    windowsVolumeType(resources.kernel, resource.handle) !== 'NTFS'
  )
    return fail('unsupported-platform');
  const security = resources.securityOf(resource.handle, directory ? resources.servicingOwner : undefined);
  const after = windowsFileIdentity(resources.kernel, resource.handle);
  if (!stable(identity, after)) return fail('source-changed');
  if (compatibility) projected(path, after, directory);
  return {resource, identity: after, security, name, path};
}
function checkEdge(resources: Resources, edge: Edge, parent: Edge | undefined, directory: boolean): void {
  resources.assertActive();
  if (edge.resource.state !== 'owned') return fail('identity');
  for (let attempt = 0; attempt < (directory ? 2 : 1); attempt++) {
    const before = windowsFileIdentity(resources.kernel, edge.resource.handle);
    if (!sameCritical(edge.identity, before) || (!directory && before.links !== 1)) return fail('source-changed');
    if (windowsVolumeType(resources.kernel, edge.resource.handle) !== 'NTFS') return fail('unsupported-platform');
    const security = resources.securityOf(edge.resource.handle, directory ? resources.servicingOwner : undefined);
    if (!sameSecurity(edge.security, security)) return fail('source-changed');
    const reopened = parent ? resources.openAt(parent.resource, edge.name, directory) : undefined;
    let named = before;
    try {
      if (reopened) named = windowsFileIdentity(resources.kernel, reopened.handle);
    } finally {
      if (reopened) resources.release(reopened);
    }
    const after = windowsFileIdentity(resources.kernel, edge.resource.handle);
    if (!sameCritical(before, named) || !sameCritical(before, after)) return fail('source-changed');
    if (stable(before, named) && stable(before, after)) return;
    if (!directory || attempt !== 0) return fail('source-changed');
  }
}
interface RootState {
  readonly resources: Resources;
  readonly chain: readonly Edge[];
  readonly path: string;
  active: boolean;
}
export interface WindowsWriterRoot {
  readonly path: string;
  close(): void;
  openTarget(segments: readonly string[], physical: string, bound: number): WindowsWriterTarget;
}
export interface WindowsWriterTarget {
  inspect(): RuntimeGuardedDiskObservation;
  matchesSourceWitness(earlier: WindowsSourceWitness): boolean;
  observesSourceObject(earlier: WindowsSourceWitness): boolean;
  commit(input: {
    readonly before: RuntimeGuardedDiskObservation;
    readonly afterBytes: Uint8Array;
    readonly assertCurrentSync: () => void;
  }): WriterTransactionResult<RuntimeGuardedDiskObservation>;
  close(): void;
}
const childPath = (parent: string, name: string) => parent + (EffectString.endsWith('\\')(parent) ? '' : '\\') + name;
function checkRoot(root: RootState): void {
  if (!root.active || native.realpathSync(root.path) !== root.path) return fail('identity');
  for (let index = 0; index < root.chain.length; index++)
    checkEdge(root.resources, root.chain[index], root.chain[index - 1], true);
}
class WindowsPrivateMissing extends Schema.TaggedError<WindowsPrivateMissing, {readonly brand: unique symbol}>()(
  'WindowsPrivateMissing',
  {},
) {}
function openRootState(
  path: string,
  expected?: {readonly dev: bigint; readonly ino: bigint},
  privateWritable = false,
): RootState {
  assertAcquisitionAvailable();
  if (!/^[A-Za-z]:\\/u.test(path) || /[\p{Cc}]/u.test(path) || native.realpathSync(path) !== path) return fail('path');
  const names = path.length === 3 ? [] : EffectString.split(EffectString.slice(3)(path), '\\');
  if (names.length > maximumComponents) return fail('path');
  for (const name of names) windowsPathComponent(name);
  const resources = new Resources();
  try {
    const drive = EffectString.slice(0, 3)(path);
    if (resources.kernel.symbols.GetDriveTypeW(windowsWide(drive)) !== 3) return fail('unsupported-platform');
    const raw = resources.kernel.symbols.CreateFileW(
      windowsWide(drive),
      0x001200a1,
      7,
      null,
      3,
      0x02000000 | 0x00200000,
      0n,
    );
    const chain: Edge[] = [capture(resources, resources.own(raw), drive, drive, true, expected !== undefined)];
    let prefix = drive;
    for (const name of names) {
      prefix += (prefix.length === 3 ? '' : '\\') + name;
      chain.push(
        capture(
          resources,
          resources.openAt(chain[chain.length - 1].resource, name, true, false, privateWritable && prefix === path),
          name,
          prefix,
          true,
          expected !== undefined,
        ),
      );
    }
    if (expected) {
      const info = projected(path, chain[chain.length - 1].identity, true);
      if (info.dev !== expected.dev || info.ino !== expected.ino) return fail('path');
    }
    const state: RootState = {resources, chain, path, active: true};
    checkRoot(state);
    return state;
  } catch (error) {
    resources.close();
    throw error;
  }
}
export function openWindowsWriterRoot(
  path: string,
  expected: {readonly dev: bigint; readonly ino: bigint},
): WindowsWriterRoot {
  const state = openRootState(path, expected);
  return {
    path,
    close() {
      state.active = false;
      state.resources.close();
    },
    openTarget: (segments, physical, bound) => openTarget(state, segments, physical, bound),
  };
}
const sourceEvidenceBrand: unique symbol = Symbol('windows-source-evidence');
/** Host-private evidence data. It owns no native resource and is never a writer grant. */
export interface WindowsSourceEvidence {
  readonly [sourceEvidenceBrand]: true;
}
/** Historical comparison data, not an authenticated certificate or a writer grant.
 * Persisted callers must authenticate their complete private envelope before using this value.
 */
export interface WindowsSourceWitness {
  readonly object: string;
  readonly snapshot: string;
}
const sourceWitnesses = new WeakMap<WindowsSourceEvidence, WindowsSourceWitness>();
const encodeWitness = (value: unknown) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? String(item) : item));
function witnessEdge(edge: Edge, metadata: boolean) {
  const id = edge.identity;
  return [
    edge.name,
    edge.path,
    id.volumeId,
    id.fileId,
    id.birthtime,
    metadata ? id : id.attributes & ~0x20,
    edge.security.owner,
    Array.from(edge.security.bytes),
  ];
}
function sourceWitness(principal: string, edges: readonly Edge[], bytes: Uint8Array): WindowsSourceWitness {
  return Object.freeze({
    object: encodeWitness([principal, EffectArray.map(edges, edge => witnessEdge(edge, false))]),
    snapshot: encodeWitness([principal, EffectArray.map(edges, edge => witnessEdge(edge, true)), sha256HexSync(bytes)]),
  });
}
/** Only the original issuer object can export its immutable, already captured historical data. */
export function exportWindowsSourceWitness(evidence: WindowsSourceEvidence): WindowsSourceWitness {
  const witness = sourceWitnesses.get(evidence);
  if (!witness) return fail('identity');
  return Object.freeze({object: witness.object, snapshot: witness.snapshot});
}
export function sameWindowsSourceEvidence(
  a: WindowsSourceEvidence,
  b: WindowsSourceEvidence,
  snapshot: boolean,
): boolean {
  const first = sourceWitnesses.get(a),
    second = sourceWitnesses.get(b);
  return (
    first !== undefined &&
    second !== undefined &&
    (snapshot ? first.snapshot === second.snapshot : first.object === second.object)
  );
}
/** One bounded read through retained native ancestry. Source is opened read-only, with no mutation capability. */
export function captureWindowsSource(
  path: string,
  segments: readonly string[],
  bound: number,
): {
  readonly bytes: Uint8Array;
  readonly physicalIdentity: string;
  readonly evidence: WindowsSourceEvidence;
} {
  if (
    !segments.length ||
    segments.length > maximumComponents ||
    !Number.isSafeInteger(bound) ||
    bound < 0 ||
    bound > maximumBytes
  )
    return fail('path');
  for (const name of segments) windowsPathComponent(name);
  const root = openRootState(path),
    resources = root.resources;
  try {
    const edges = [...root.chain];
    let parent = edges[edges.length - 1],
      targetPath = path;
    for (const [index, name] of segments.entries()) {
      targetPath = childPath(targetPath, name);
      const directory = index < segments.length - 1;
      const edge = capture(
        resources,
        resources.openAt(parent.resource, name, directory),
        name,
        targetPath,
        directory,
        false,
      );
      if (edge.identity.volumeId !== parent.identity.volumeId) return fail('path');
      edges.push(edge);
      parent = edge;
    }
    const target = edges[edges.length - 1];
    const check = () => {
      checkRoot(root);
      for (const edge of edges)
        if (!stable(edge.identity, windowsFileIdentity(resources.kernel, edge.resource.handle)))
          return fail('source-changed');
      for (let index = root.chain.length; index < edges.length; index++)
        checkEdge(resources, edges[index], edges[index - 1], index < edges.length - 1);
      const current = windowsFileIdentity(resources.kernel, target.resource.handle);
      if (!stable(target.identity, current)) return fail('source-changed');
    };
    check();
    if (target.identity.links !== 1 || target.identity.size < 0n || target.identity.size > BigInt(bound))
      return fail('path');
    const bytes = new Uint8Array(Number(target.identity.size));
    let offset = 0;
    while (offset < bytes.length) {
      const part = bytes.subarray(offset),
        count = new Uint32Array(9),
        backing = [bytes, part, count];
      count.fill(0xa5a5a5a5);
      resources.pendingBacking.add(backing);
      const ok = resources.kernel.symbols.ReadFile(target.resource.handle, part, part.length, count, null);
      const error = ok === 0 ? resources.kernel.symbols.GetLastError() : 0;
      if (!count.subarray(1).every(value => value === 0xa5a5a5a5) || (ok === 0 && error === 997))
        resources.uncertain(backing);
      resources.pendingBacking.delete(backing);
      if (ok === 0) return fail('io');
      if (!count[0] || count[0] > part.length) return fail('source-changed');
      offset += count[0];
    }
    check();
    // Compatibility metadata is observed only; full native IDs above remain the authority.
    const compatibility = native.lstatSync(targetPath, {bigint: true});
    if (!compatibility.isFile() || compatibility.isSymbolicLink()) return fail('path');
    check();
    const evidence: WindowsSourceEvidence = Object.freeze({[sourceEvidenceBrand]: true as const});
    sourceWitnesses.set(evidence, sourceWitness(resources.principal, edges, bytes));
    return {bytes, evidence, physicalIdentity: JSON.stringify([String(compatibility.dev), String(compatibility.ino)])};
  } finally {
    root.active = false;
    resources.close();
  }
}
function openTarget(
  root: RootState,
  segments: readonly string[],
  physical: string,
  bound: number,
): WindowsWriterTarget {
  assertAcquisitionAvailable();
  checkRoot(root);
  if (
    segments.length === 0 ||
    segments.length > maximumComponents ||
    !Number.isSafeInteger(bound) ||
    bound < 0 ||
    bound > maximumBytes
  )
    return fail('path');
  for (const name of segments) windowsPathComponent(name);
  const resources = new Resources();
  try {
    if (resources.principal !== root.resources.principal || resources.servicingOwner !== root.resources.servicingOwner)
      return fail('identity');
    const parents: Edge[] = [];
    let parent = root.chain[root.chain.length - 1],
      path = root.path;
    for (const name of EffectArray.dropRight(segments, 1)) {
      path = childPath(path, name);
      const edge = capture(resources, resources.openAt(parent.resource, name, true), name, path, true);
      if (edge.identity.volumeId !== parent.identity.volumeId) return fail('path');
      parents.push(edge);
      parent = edge;
    }
    const name = segments[segments.length - 1];
    path = childPath(path, name);
    const edge = capture(resources, resources.openAt(parent.resource, name, false, true), name, path, false);
    if (
      edge.identity.volumeId !== parent.identity.volumeId ||
      edge.identity.links !== 1 ||
      edge.identity.size > BigInt(bound)
    )
      return fail('path');
    if ((edge.identity.attributes & 1) !== 0) return fail('readonly');
    const compatibility = projected(path, edge.identity, false);
    if (JSON.stringify([String(compatibility.dev), String(compatibility.ino)]) !== physical)
      return fail('source-changed');
    let baseline = edge.identity,
      active = true,
      attempted = false,
      stopped = false;
    const snapshots = new WeakMap<RuntimeGuardedDiskObservation, NativeFileIdentity>();
    const assertActive = () => {
      if (!active || stopped || !root.active) return fail('identity');
      resources.assertActive();
    };
    const check = (strict = true) => {
      assertActive();
      checkRoot(root);
      for (let index = 0; index < parents.length; index++)
        checkEdge(
          resources,
          parents[index],
          index === 0 ? root.chain[root.chain.length - 1] : parents[index - 1],
          true,
        );
      checkEdge(resources, edge, parent, false);
      const current = windowsFileIdentity(resources.kernel, edge.resource.handle);
      if (strict && !stable(baseline, current)) return fail('source-changed');
      return current;
    };
    const position = (offset: number) => {
      assertActive();
      const observed = new BigUint64Array(5);
      observed.fill(0xa5a5a5a5a5a5a5a5n);
      const ok = resources.kernel.symbols.SetFilePointerEx(edge.resource.handle, BigInt(offset), observed, 0);
      if (!observed.subarray(1).every(value => value === 0xa5a5a5a5a5a5a5a5n)) resources.uncertain(observed);
      if (ok === 0 || observed[0] !== BigInt(offset)) return fail('io');
    };
    const ioFailure = (error: number, backing?: unknown): never => {
      if (error === 997) resources.uncertain(backing);
      return fail('io');
    };
    const inspect = (): RuntimeGuardedDiskObservation => {
      const before = check();
      if (before.size < 0n || before.size > BigInt(bound)) return fail('path');
      const backing = new ArrayBuffer(Number(before.size)),
        bytes = new Uint8Array(backing);
      let offset = 0;
      position(0);
      while (offset < bytes.length) {
        const count = new Uint32Array(9),
          part = bytes.subarray(offset),
          operationBacking = [backing, part, count];
        count.fill(0xa5a5a5a5);
        resources.pendingBacking.add(operationBacking);
        const ok = resources.kernel.symbols.ReadFile(edge.resource.handle, part, part.length, count, null);
        const error = ok === 0 ? resources.kernel.symbols.GetLastError() : 0;
        if (!count.subarray(1).every(value => value === 0xa5a5a5a5)) resources.uncertain(operationBacking);
        if (ok === 0 && error === 997) resources.uncertain(operationBacking);
        resources.pendingBacking.delete(operationBacking);
        if (ok === 0) ioFailure(error);
        if (count[0] === 0 || count[0] > part.length) return fail('source-changed');
        offset += count[0];
      }
      const after = check();
      if (!stable(before, after)) return fail('source-changed');
      const identity = projected(path, after, false);
      check();
      const observation = {identity, bytes, physicalIdentity: physical};
      snapshots.set(observation, after);
      return observation;
    };
    const compareWitness = (earlier: WindowsSourceWitness, exact: boolean) => {
      // Read historical inputs before touching native state: even a reentrant getter cannot close
      // this owner after our active checks and then turn a stale capability into a positive match.
      const {object, snapshot} = earlier;
      if (typeof object !== 'string' || typeof snapshot !== 'string') return false;
      check();
      const retained = [...root.chain, ...parents, edge],
        opening = EffectArray.map(retained, (current, index) => {
          const before = windowsFileIdentity(resources.kernel, current.resource.handle),
            security = resources.securityOf(
              current.resource.handle,
              index < retained.length - 1 ? resources.servicingOwner : undefined,
            ),
            after = windowsFileIdentity(resources.kernel, current.resource.handle);
          if (!stable(before, after)) return fail('source-changed');
          return {...current, identity: after, security};
        }),
        observed = inspect();
      for (const [index, current] of opening.entries()) {
        const security = resources.securityOf(
            current.resource.handle,
            index < opening.length - 1 ? resources.servicingOwner : undefined,
          ),
          after = windowsFileIdentity(resources.kernel, current.resource.handle);
        if (!stable(current.identity, after) || !sameSecurity(current.security, security))
          return fail('source-changed');
      }
      check();
      const current = sourceWitness(resources.principal, opening, observed.bytes);
      // Compare the same retained root/target, never a fresh replacement capture. A match changes
      // no eligibility state; journal-classified own-write recovery is a separate host boundary.
      return object === current.object && (!exact || snapshot === current.snapshot);
    };
    const target: WindowsWriterTarget = {
      inspect,
      matchesSourceWitness: earlier => compareWitness(earlier, true),
      observesSourceObject: earlier => compareWitness(earlier, false),
      commit(input) {
        const result = commitWriterTransaction(input, () => {
          check();
          return {
            maximumBytes: bound,
            get attempted() {
              return attempted;
            },
            inspect,
            sameIdentity(a, b) {
              const first = snapshots.get(a),
                second = snapshots.get(b);
              return first !== undefined && second !== undefined && stable(first, second);
            },
            beginAttempt() {
              attempted = true;
            },
            writeAt(bytes, offset) {
              check(false);
              position(offset);
              const part = bytes.subarray(offset),
                count = new Uint32Array(9),
                operationBacking = [bytes, part, count];
              count.fill(0xa5a5a5a5);
              resources.pendingBacking.add(operationBacking);
              const ok = resources.kernel.symbols.WriteFile(edge.resource.handle, part, part.length, count, null);
              const error = ok === 0 ? resources.kernel.symbols.GetLastError() : 0;
              if (!count.subarray(1).every(value => value === 0xa5a5a5a5)) resources.uncertain(operationBacking);
              if (ok === 0 && error === 997) resources.uncertain(operationBacking);
              resources.pendingBacking.delete(operationBacking);
              if (ok === 0) ioFailure(error);
              return count[0];
            },
            truncate(length) {
              check(false);
              position(length);
              if (resources.kernel.symbols.SetEndOfFile(edge.resource.handle) === 0)
                ioFailure(resources.kernel.symbols.GetLastError());
            },
            flush() {
              assertActive();
              if (resources.kernel.symbols.FlushFileBuffers(edge.resource.handle) === 0)
                ioFailure(resources.kernel.symbols.GetLastError());
            },
            refreshBaseline() {
              baseline = windowsFileIdentity(resources.kernel, edge.resource.handle);
            },
          };
        });
        if (result.status === 'unknown') stopped = true;
        return result;
      },
      close() {
        active = false;
        resources.close();
      },
    };
    inspect();
    return target;
  } catch (error) {
    resources.close();
    throw error;
  }
}

export interface WindowsPrivateLease {
  assertCurrentSync(): void;
  heartbeat(): void;
  close(): void;
}
export interface WindowsPrivateDirectory {
  readonly path: string;
  assertCurrentSync(): void;
  child(name: string, create: boolean): WindowsPrivateDirectory;
  read(name: string, bound: number): {identity: RuntimeWriterIdentity; bytes: Uint8Array} | undefined;
  publish(
    name: string,
    bytes: Uint8Array,
    input: {mode: 'exclusive' | 'replace'; nonce: string; assertCurrentSync(): void},
  ): {status: 'published'; identity: RuntimeWriterIdentity} | {status: 'unknown'};
  remove(name: string, expected: RuntimeWriterIdentity, assertCurrentSync: () => void): void;
  acquireLease(name: string, token: string): WindowsPrivateLease | undefined;
  close(): void;
}
/** Same rooted ledger as source I/O; final private authority is always an exact protected current-SID DACL. */
export function openWindowsPrivateDirectory(path: string): WindowsPrivateDirectory {
  const expected = native.lstatSync(path, {bigint: true});
  return privateDirectory(openRootState(path, expected, true), true);
}
function openWindowsAccountHome(accountHome: string, principal: string): WindowsPrivateDirectory {
  const current = windowsTokenPrincipal();
  if (current.sid !== principal || current.accountHome !== accountHome) return fail('identity');
  const expected = native.lstatSync(accountHome, {bigint: true});
  const state = openRootState(accountHome, expected, true);
  const home = privateDirectory(state, false);
  try {
    if (state.resources.principal !== principal || state.chain[state.chain.length - 1].security.owner !== principal)
      return fail('identity');
    return home;
  } catch (error) {
    home.close();
    throw error;
  }
}
export function openWindowsPrivateAuthority(accountHome: string, principal: string): WindowsPrivateDirectory {
  const home = openWindowsAccountHome(accountHome, principal);
  try {
    return home.child('.threadnote-writer-authority', true);
  } finally {
    home.close();
  }
}
/** Explicit setup: only the actual account home may supply nonprivate ancestor authority. */
export function provisionWindowsPrivateDirectory(path: string): WindowsPrivateDirectory {
  if (!/^[A-Za-z]:\\/u.test(path) || /[\p{Cc}]/u.test(path)) return fail('path');
  const names = EffectString.split(EffectString.slice(3)(path), '\\');
  if (names.length > maximumComponents) return fail('path');
  for (const name of names) windowsPathComponent(name);
  const missing: string[] = [];
  let parent = path;
  while (true) {
    try {
      native.lstatSync(parent, {bigint: true});
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const boundary = Option.getOrElse(EffectString.lastIndexOf('\\')(parent), () => -1);
      if (boundary < 2 || parent.length === 3) return fail('path');
      missing.unshift(EffectString.slice(boundary + 1)(parent));
      parent = EffectString.slice(0, boundary === 2 ? 3 : boundary)(parent);
    }
  }
  // An existing requested object always remains a strict private final object, including the account home.
  if (!missing.length) return openWindowsPrivateDirectory(path);
  const current = windowsTokenPrincipal();
  let retained =
    parent === current.accountHome
      ? openWindowsAccountHome(current.accountHome, current.sid)
      : openWindowsPrivateDirectory(parent);
  try {
    for (const name of missing) {
      const child = retained.child(name, true);
      retained.close();
      retained = child;
    }
    if (retained.path !== path) return fail('path');
    return retained;
  } catch (error) {
    retained.close();
    throw error;
  }
}

function privateDirectory(root: RootState, strict: boolean): WindowsPrivateDirectory {
  const resources = root.resources,
    parent = root.chain[root.chain.length - 1];
  const issued = new WeakMap<RuntimeWriterIdentity, NativeFileIdentity>();
  let stopped = false;
  const check = () => {
    checkRoot(root);
    const security = windowsReadFileSecurity(
      parent.resource.handle,
      resources.principal,
      strict,
      strict ? undefined : resources.servicingOwner,
      borrowed,
    );
    if (strict) assertWindowsProtectedSecurity(security.bytes, resources.principal);
    if (!sameSecurity(parent.security, security)) return fail('private-storage');
  };
  const borrowed = {
    kernel: resources.kernel,
    security: resources.security,
    captureNative: resources.captureNative,
    ownDescriptor: resources.descriptor,
    uncertain: (backing: readonly ArrayBufferView[]): never => resources.uncertain(backing),
  };
  const mutation = (assertCurrent: () => void) => {
    if (stopped) return fail('identity');
    check();
    assertCurrent();
  };
  const privateEdge = (resource: HandleResource, name: string): Edge => {
    const edge = capture(resources, resource, name, childPath(root.path, name), false);
    const security = windowsReadFileSecurity(resource.handle, resources.principal, true, undefined, borrowed);
    assertWindowsProtectedSecurity(security.bytes, resources.principal);
    if (!sameSecurity(edge.security, security) || edge.identity.links !== 1) return fail('private-storage');
    return edge;
  };
  const checkFile = (edge: Edge) => {
    check();
    checkEdge(resources, edge, parent, false);
    const security = windowsReadFileSecurity(edge.resource.handle, resources.principal, true, undefined, borrowed);
    assertWindowsProtectedSecurity(security.bytes, resources.principal);
    if (!sameSecurity(edge.security, security)) return fail('private-storage');
    return windowsFileIdentity(resources.kernel, edge.resource.handle);
  };
  const position = (handle: bigint) => {
    const observed = new BigUint64Array(5);
    observed.fill(0xa5a5a5a5a5a5a5a5n);
    let ok: number;
    try {
      ok = resources.kernel.symbols.SetFilePointerEx(handle, 0n, observed, 0);
    } catch {
      return resources.uncertain(observed);
    }
    if (!observed.subarray(1).every(v => v === 0xa5a5a5a5a5a5a5a5n)) return resources.uncertain(observed);
    if (!ok || observed[0] !== 0n) return fail('io');
  };
  const transfer = (handle: bigint, bytes: Uint8Array, write: boolean, assertCurrent: () => void) => {
    position(handle);
    let offset = 0;
    while (offset < bytes.length) {
      assertCurrent();
      const count = new Uint32Array(9),
        part = bytes.subarray(offset),
        backing = [bytes, part, count];
      count.fill(0xa5a5a5a5);
      resources.pendingBacking.add(backing);
      let ok: number;
      try {
        ok = write
          ? resources.kernel.symbols.WriteFile(handle, part, part.length, count, null)
          : resources.kernel.symbols.ReadFile(handle, part, part.length, count, null);
      } catch {
        return resources.uncertain(backing);
      }
      const error = ok === 0 ? resources.kernel.symbols.GetLastError() : 0;
      if (error === 997 || !count.subarray(1).every(v => v === 0xa5a5a5a5)) return resources.uncertain(backing);
      resources.pendingBacking.delete(backing);
      if (ok === 0 || count[0] === 0 || count[0] > part.length) return fail('io');
      offset += count[0];
    }
  };
  const readEdge = (edge: Edge, bound: number) => {
    const before = checkFile(edge);
    if (!Number.isSafeInteger(bound) || bound < 0 || bound > maximumBytes || before.size > BigInt(bound))
      return fail('private-storage');
    const bytes = new Uint8Array(Number(before.size));
    transfer(edge.resource.handle, bytes, false, () => {
      checkFile(edge);
    });
    const after = checkFile(edge);
    if (!stable(before, after)) return fail('private-storage');
    const identity = projected(edge.path, after, false);
    issued.set(identity, after);
    return {identity, bytes};
  };
  const openFile = (name: string, deleteAccess = false): Edge | undefined => {
    windowsPathComponent(name);
    check();
    let owned: HandleResource;
    try {
      owned = resources.openAt(parent.resource, name, false, false, deleteAccess, true);
    } catch (error) {
      if (Schema.is(WindowsPrivateMissing)(error)) {
        check();
        return undefined;
      }
      throw error;
    }
    try {
      return privateEdge(owned, name);
    } catch (error) {
      resources.release(owned);
      throw error;
    }
  };
  const flush = (handle: bigint) => {
    let ok: number;
    try {
      ok = resources.kernel.symbols.FlushFileBuffers(handle);
    } catch {
      return resources.uncertain();
    }
    if (ok === 0) return fail('io');
  };
  const setInformation = (handle: bigint, bytes: Uint8Array, kind: number) => {
    const guarded = new BigUint64Array(6),
      backing = [bytes, guarded];
    guarded.fill(0xa5a5a5a5a5a5a5a5n);
    resources.pendingBacking.add(backing);
    let status: number;
    try {
      status = resources.nt.symbols.NtSetInformationFile(
        handle,
        new Uint8Array(guarded.buffer, 0, 16),
        bytes,
        bytes.length,
        kind,
      );
    } catch {
      return resources.uncertain(backing);
    }
    if (status === 0x103 || !guarded.subarray(2).every(v => v === 0xa5a5a5a5a5a5a5a5n))
      return resources.uncertain(backing);
    resources.pendingBacking.delete(backing);
    if (status !== 0 || new DataView(guarded.buffer).getInt32(0, true) !== 0) return fail('io');
  };
  const create = (name: string, kind: 'file' | 'directory' | 'lease') =>
    windowsCreatePrivateAt(parent.resource.handle, name, kind, borrowed, check);
  const createdEdge = (created: WindowsPrivateCreatedFile, name: string): Edge =>
    privateEdge(
      {
        handle: created.handle,
        state: 'owned',
        release: () => {
          created.close();
          return true;
        },
      },
      name,
    );
  const directory: WindowsPrivateDirectory = {
    path: root.path,
    assertCurrentSync: check,
    child(name, shouldCreate) {
      mutation(() => {});
      windowsPathComponent(name);
      let created: WindowsPrivateCreatedFile | undefined;
      if (shouldCreate) {
        try {
          created = create(name, 'directory');
        } catch (error) {
          if (!Schema.is(WindowsPrivateCreateBusy)(error)) throw error;
        }
      }
      // Release our creation HANDLE before opening the writable child; retain its full identity across that cut.
      const identity = created?.identity;
      created?.close();
      const child = openWindowsPrivateDirectory(childPath(root.path, name));
      try {
        if (identity) {
          const reopened = resources.openAt(parent.resource, name, true);
          try {
            if (!sameCritical(identity, windowsFileIdentity(resources.kernel, reopened.handle)))
              return fail('private-storage');
          } finally {
            resources.release(reopened);
          }
        }
        check();
        child.assertCurrentSync();
        flush(parent.resource.handle);
        return child;
      } catch (error) {
        child.close();
        throw error;
      }
    },
    read(name, bound) {
      const edge = openFile(name);
      if (!edge) return undefined;
      try {
        return readEdge(edge, bound);
      } finally {
        resources.release(edge.resource);
      }
    },
    publish(name, bytes, input) {
      windowsPathComponent(name);
      if (bytes.length > maximumBytes || !/^[a-f0-9]{32,64}$/u.test(input.nonce)) return fail('private-storage');
      mutation(input.assertCurrentSync);
      let prior: Edge | undefined, created: WindowsPrivateCreatedFile | undefined;
      try {
        if (input.mode === 'replace') {
          prior = openFile(name);
          if (prior) readEdge(prior, maximumBytes);
        }
        const temporary = `.pending-${input.nonce}`;
        mutation(input.assertCurrentSync);
        created = create(temporary, 'file');
        let edge = createdEdge(created, temporary);
        transfer(created.handle, bytes, true, () => {
          mutation(input.assertCurrentSync);
          checkFile(edge);
        });
        flush(created.handle);
        if (!equalBytes(readEdge(edge, bytes.length).bytes, bytes)) return fail('private-storage');
        mutation(input.assertCurrentSync);
        if (input.mode === 'replace') {
          if (prior) {
            const current = checkFile(prior);
            if (!stable(prior.identity, current)) return fail('private-storage');
            // Ordinary replacement requires the destination closed. Retain its authenticated data,
            // then rely on the caller's current O→M lease/revision fence across this synchronous cut.
            resources.release(prior.resource);
          } else if (openFile(name)) return fail('private-storage');
        }
        const wide = windowsPathComponent(name),
          rename = new Uint8Array(20 + wide.byteLength - 2),
          view = new DataView(rename.buffer);
        rename[0] = input.mode === 'replace' && prior ? 1 : 0; // Normal rooted rename; no POSIX flags or copy/delete.
        view.setBigUint64(8, parent.resource.handle, true);
        view.setUint32(16, wide.byteLength - 2, true);
        rename.set(new Uint8Array(wide.buffer, 0, wide.byteLength - 2), 20);
        // The caller may require the old digest/presence. Both modes stage privately until this visibility cut.
        input.assertCurrentSync();
        setInformation(created.handle, rename, 10);
        edge = createdEdge(created, name);
        flush(parent.resource.handle);
        const current = readEdge(edge, bytes.length);
        if (!equalBytes(current.bytes, bytes)) return fail('private-storage');
        check();
        const writtenIdentity = windowsFileIdentity(resources.kernel, created.handle);
        created.close();
        created = undefined;
        // Last-writer close may settle native timestamps. Acknowledged identity is observed after that close.
        flush(parent.resource.handle);
        const confirmed = openFile(name);
        if (!confirmed) return fail('private-storage');
        if (!sameCritical(writtenIdentity, confirmed.identity) || !sameSecurity(edge.security, confirmed.security))
          return fail('private-storage');
        const final = readEdge(confirmed, bytes.length);
        if (!equalBytes(final.bytes, bytes)) return fail('private-storage');
        resources.release(confirmed.resource);
        check();
        return {status: 'published', identity: final.identity};
      } catch {
        // Settled failures still may have published bytes. Retain the attempt; never delete or replay it.
        stopped = true;
        return {status: 'unknown'};
      }
    },
    remove(name, expected, assertCurrent) {
      mutation(assertCurrent);
      const witness = issued.get(expected);
      if (!witness) return fail('private-storage');
      const edge = openFile(name, true);
      if (!edge) return fail('private-storage');
      try {
        const current = checkFile(edge);
        if (!stable(witness, current)) return fail('private-storage');
        mutation(assertCurrent);
        setInformation(edge.resource.handle, new Uint8Array([1]), 13);
        resources.release(edge.resource);
        flush(parent.resource.handle);
        check();
      } catch (error) {
        stopped = true;
        throw error;
      }
    },
    acquireLease(name, token) {
      mutation(() => {});
      const owner: unknown = JSON.parse(token);
      if (
        typeof owner !== 'object' ||
        owner === null ||
        !('version' in owner) ||
        owner.version !== 1 ||
        !('token' in owner) ||
        typeof owner.token !== 'string' ||
        owner.token.length === 0 ||
        !('processId' in owner) ||
        owner.processId !== process.pid ||
        !('processStartIdentity' in owner) ||
        owner.processStartIdentity !== readWindowsWriterProcessIdentity(process.pid)
      )
        return fail('identity');
      const bytes = new TextEncoder().encode(`${token}\n`);
      if (bytes.length > 4096) return fail('private-storage');
      let created: WindowsPrivateCreatedFile;
      try {
        created = create(name, 'lease');
      } catch (error) {
        if (Schema.is(WindowsPrivateCreateBusy)(error)) return undefined;
        throw error;
      }
      let active = true,
        lost = false;
      const expectedName = windowsNativeName(resources.kernel, created.handle);
      const verify = () => {
        if (!active || lost) return fail('identity');
        try {
          check();
          const before = windowsFileIdentity(resources.kernel, created.handle);
          const security = windowsReadFileSecurity(created.handle, resources.principal, true, undefined, borrowed);
          assertWindowsProtectedSecurity(security.bytes, resources.principal);
          if (
            !sameCritical(created.identity, before) ||
            before.links !== 1 ||
            before.size !== BigInt(bytes.length) ||
            !sameSecurity(created.security, security) ||
            !equalBytes(expectedName, windowsNativeName(resources.kernel, created.handle))
          )
            return fail('identity');
          const observed = new Uint8Array(bytes.length);
          transfer(created.handle, observed, false, check);
          if (!equalBytes(bytes, observed) || !stable(before, windowsFileIdentity(resources.kernel, created.handle)))
            return fail('identity');
        } catch (error) {
          lost = true;
          throw error;
        }
      };
      try {
        transfer(created.handle, bytes, true, check);
        flush(created.handle);
        verify();
      } catch (error) {
        lost = true;
        stopped = true;
        throw error;
      }
      return {
        assertCurrentSync: verify,
        heartbeat() {
          verify();
          try {
            const basic = new Uint8Array(40),
              view = new DataView(basic.buffer);
            view.setBigInt64(16, BigInt(Date.now()) * 10000n + epoch, true);
            setInformation(created.handle, basic, 4);
            verify();
          } catch (error) {
            lost = true;
            throw error;
          }
        },
        close() {
          active = false;
          created.close(); // The primitive remembers successful close and sticky close-UNKNOWN; one native attempt.
        },
      };
    },
    close() {
      root.active = false;
      resources.close();
    },
  };
  try {
    check();
    return directory;
  } catch (error) {
    resources.close();
    throw error;
  }
}
