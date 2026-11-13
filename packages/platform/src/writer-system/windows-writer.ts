import {Array as EffectArray, String as EffectString} from 'effect';
import {runtimeNativeDescriptorOperations} from '../system.js';
import type {RuntimeGuardedDiskObservation, RuntimeWriterIdentity} from '../writer_system.js';
import {writerFail as fail} from './fault.js';
import {withNativeArguments} from './native-arguments.js';
import {
  windowsAddress,
  windowsSystemLibrary,
  windowsTokenPrincipal,
  windowsWide,
  type WindowsNativeResourceOwner,
} from './windows-native.js';
import {
  windowsFileLibrary,
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
  openAt(parent: HandleResource, name: string, directory: boolean, writable = false): HandleResource {
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
    const access = directory ? 0x001200a1 : writable ? 0x00120183 : 0x00120081;
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
        writable ? 1 : 7,
        1, // FILE_OPEN: acquisition never creates, overwrites, or truncates.
        0x00200000 | 0x20 | (directory ? 1 : 0x40),
        null,
        0,
      ),
    );
    if (status !== 0) {
      if (status === 0x103 || output[0] !== 0n) this.uncertain(backing);
      this.pendingBacking.delete(backing);
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
  )
    return fail('unsupported-platform');
  const raw = new Uint8Array(EffectArray.map(fileId, value => Number(value))),
    view = new DataView(raw.buffer),
    low = view.getBigUint64(0, true),
    high = view.getBigUint64(8, true);
  if (
    info.isSymbolicLink() ||
    info.isDirectory() !== directory ||
    (!directory && !info.isFile()) ||
    (id.volumeId & 0xffffffffn) !== id.dev ||
    info.dev !== id.dev ||
    high !== 0n ||
    low === 0n ||
    low !== id.ino ||
    info.ino !== low ||
    info.birthtimeNs !== (id.birthtime - epoch) * 100n ||
    info.ctimeNs !== (id.changed - epoch) * 100n ||
    info.mtimeNs !== (id.modified - epoch) * 100n ||
    info.nlink !== BigInt(id.links) ||
    info.size !== id.size
  )
    return fail('unsupported-platform');
  return info; // Actual compatibility observations only; UID/GID/mode never supply native authority.
}
function capture(resources: Resources, resource: HandleResource, name: string, path: string, directory: boolean): Edge {
  const identity = windowsFileIdentity(resources.kernel, resource.handle);
  if (
    ((identity.attributes & 0x10) !== 0) !== directory ||
    windowsVolumeType(resources.kernel, resource.handle) !== 'NTFS'
  )
    return fail('unsupported-platform');
  const security = resources.securityOf(resource.handle, directory ? resources.servicingOwner : undefined);
  const after = windowsFileIdentity(resources.kernel, resource.handle);
  if (!stable(identity, after)) return fail('source-changed');
  projected(path, after, directory);
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
export function openWindowsWriterRoot(
  path: string,
  expected: {readonly dev: bigint; readonly ino: bigint},
): WindowsWriterRoot {
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
    const chain: Edge[] = [capture(resources, resources.own(raw), drive, drive, true)];
    let prefix = drive;
    for (const name of names) {
      prefix += (prefix.length === 3 ? '' : '\\') + name;
      chain.push(
        capture(resources, resources.openAt(chain[chain.length - 1].resource, name, true), name, prefix, true),
      );
    }
    const final = chain[chain.length - 1],
      info = projected(path, final.identity, true);
    if (info.dev !== expected.dev || info.ino !== expected.ino) return fail('path');
    const state: RootState = {resources, chain, path, active: true};
    checkRoot(state);
    return {
      path,
      close() {
        state.active = false;
        resources.close();
      },
      openTarget: (segments, physical, bound) => openTarget(state, segments, physical, bound),
    };
  } catch (error) {
    resources.close();
    throw error;
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
    const target: WindowsWriterTarget = {
      inspect,
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
