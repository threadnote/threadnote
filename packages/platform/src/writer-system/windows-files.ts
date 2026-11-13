import {runtimeNativeDescriptorOperations} from '../system.js';
import {dlopen, toArrayBuffer} from 'bun:ffi';
import {Array as EffectArray, String as EffectString} from 'effect';
import {withNativeArguments} from './native-arguments.js';
import {writerFail as fail} from './fault.js';
import {
  windowsAddress,
  windowsHandle,
  windowsKernel,
  windowsSystemLibrary,
  windowsTokenPrincipal,
  windowsWide,
  type WindowsNativeResourceOwner,
} from './windows-native.js';

const fs = runtimeNativeDescriptorOperations();
const administrativePrincipals = new Set(['S-1-5-18', 'S-1-5-32-544']);
export interface NativeFileIdentity {
  readonly fileId: string;
  readonly volumeId: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtime: bigint;
  readonly changed: bigint;
  readonly modified: bigint;
  readonly attributes: number;
  readonly links: number;
  readonly size: bigint;
}
export function windowsFileLibrary() {
  return dlopen('kernel32.dll', {
    CreateFileW: {args: ['buffer', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64'},
    CloseHandle: {args: ['u64'], returns: 'i32'},
    GetFileType: {args: ['u64'], returns: 'u32'},
    GetLastError: {args: [], returns: 'u32'},
    LocalFree: {args: ['u64'], returns: 'u64'},
    ReadFile: {args: ['u64', 'buffer', 'u32', 'buffer', 'ptr'], returns: 'i32'},
    WriteFile: {args: ['u64', 'buffer', 'u32', 'buffer', 'ptr'], returns: 'i32'},
    SetFilePointerEx: {args: ['u64', 'i64', 'buffer', 'u32'], returns: 'i32'},
    SetEndOfFile: {args: ['u64'], returns: 'i32'},
    FlushFileBuffers: {args: ['u64'], returns: 'i32'},
    GetComputerNameW: {args: ['buffer', 'buffer'], returns: 'i32'},
    GetDriveTypeW: {args: ['buffer'], returns: 'u32'},
    GetFileInformationByHandle: {args: ['u64', 'buffer'], returns: 'i32'},
    GetFileInformationByHandleEx: {args: ['u64', 'u32', 'buffer', 'u32'], returns: 'i32'},
    GetVolumeInformationByHandleW: {
      args: ['u64', 'ptr', 'u32', 'buffer', 'buffer', 'buffer', 'buffer', 'u32'],
      returns: 'i32',
    },
  });
}
export type NativeLibrary = ReturnType<typeof windowsFileLibrary>;
export function windowsFileIdentity(lib: NativeLibrary, handle: bigint): NativeFileIdentity {
  if (lib.symbols.GetFileType(handle) !== 1) return fail('path');
  const info = new Uint8Array(52 + 32),
    basic = new Uint8Array(40 + 32);
  info.fill(0xa5);
  basic.fill(0xa5);
  if (
    lib.symbols.GetFileInformationByHandle(handle, info.subarray(0, 52)) === 0 ||
    lib.symbols.GetFileInformationByHandleEx(handle, 0, basic.subarray(0, 40), 40) === 0 ||
    !info.subarray(52).every(v => v === 0xa5) ||
    !basic.subarray(40).every(v => v === 0xa5)
  )
    return fail('path');
  const identity = new Uint8Array(24 + 32);
  identity.fill(0xa5);
  if (
    lib.symbols.GetFileInformationByHandleEx(handle, 18, identity.subarray(0, 24), 24) === 0 ||
    !identity.subarray(24).every(v => v === 0xa5)
  )
    return fail('path');
  const nativeId = new DataView(identity.buffer);
  const fileId = EffectArray.join(Array.from(identity.subarray(8, 24), String), ',');
  if (identity.subarray(8, 24).every(v => v === 0)) return fail('path');
  const view = new DataView(info.buffer),
    times = new DataView(basic.buffer),
    attributes = view.getUint32(0, true);
  const ino = (BigInt(view.getUint32(44, true)) << 32n) | BigInt(view.getUint32(48, true));
  if (ino === 0n || (attributes & 0x400) !== 0 || attributes !== times.getUint32(32, true)) return fail('path');
  if ((attributes & 0x10) !== 0) {
    const casing = new Uint8Array(4 + 32);
    casing.fill(0xa5);
    if (
      lib.symbols.GetFileInformationByHandleEx(handle, 23, casing.subarray(0, 4), 4) === 0 ||
      !casing.subarray(4).every(v => v === 0xa5) ||
      new DataView(casing.buffer).getUint32(0, true) !== 0
    )
      fail('path');
  }
  return {
    fileId,
    volumeId: nativeId.getBigUint64(0, true),
    dev: BigInt(view.getUint32(28, true)),
    ino,
    birthtime: times.getBigInt64(0, true),
    changed: times.getBigInt64(24, true),
    modified: times.getBigInt64(16, true),
    attributes,
    links: view.getUint32(40, true),
    size: (BigInt(view.getUint32(32, true)) << 32n) | BigInt(view.getUint32(36, true)),
  };
}
function same(a: NativeFileIdentity, b: NativeFileIdentity): boolean {
  return (
    a.fileId === b.fileId &&
    a.volumeId === b.volumeId &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtime === b.birthtime &&
    a.changed === b.changed &&
    a.modified === b.modified &&
    a.attributes === b.attributes &&
    a.links === b.links &&
    a.size === b.size
  );
}
export function windowsVolumeType(lib: NativeLibrary, handle: bigint) {
  const serial = new Uint32Array(1),
    maximum = new Uint32Array(1),
    flags = new Uint32Array(1),
    name = new Uint16Array(64);
  name.fill(0xa5a5);
  if (
    lib.symbols.GetVolumeInformationByHandleW(handle, null, 0, serial, maximum, flags, name, 48) === 0 ||
    !name.subarray(48).every(v => v === 0xa5a5) ||
    (flags[0] & 8) === 0 ||
    (flags[0] & 0x00080000) !== 0 ||
    maximum[0] < 1 ||
    maximum[0] > 255
  )
    fail('private-storage');
  let type = '';
  let end = false;
  for (const unit of name.subarray(0, 48)) {
    if (unit === 0) {
      end = true;
      break;
    }
    type += String.fromCharCode(unit);
  }
  if (!end || (type !== 'NTFS' && type !== 'ReFS')) return fail('private-storage');
  return type;
}
export function windowsPathComponent(name: string): Uint16Array {
  if (
    !name ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    /[\p{Cc}\\/:<>"|?*]/u.test(name) ||
    /[. ]$/u.test(name) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(name)
  )
    return fail('path');
  return windowsWide(name);
}
function openAt(parent: bigint, name: string, directory: boolean): bigint {
  const lib = dlopen('ntdll.dll', {
    NtCreateFile: {
      args: ['buffer', 'u32', 'buffer', 'buffer', 'ptr', 'u32', 'u32', 'u32', 'u32', 'ptr', 'u32'],
      returns: 'i32',
    },
  });
  try {
    const wide = windowsPathComponent(name),
      string = new BigUint64Array(2),
      stringView = new DataView(string.buffer);
    stringView.setUint16(0, wide.byteLength - 2, true);
    stringView.setUint16(2, wide.byteLength, true);
    stringView.setBigUint64(8, windowsAddress(wide), true);
    const attributes = new BigUint64Array(6),
      view = new DataView(attributes.buffer);
    view.setUint32(0, 48, true);
    view.setBigUint64(8, parent, true);
    view.setBigUint64(16, windowsAddress(string), true);
    view.setUint32(24, 0x40 | 0x1000, true);
    const result = new BigUint64Array(1),
      status = new BigUint64Array(2);
    // Root-relative native open; no Win32 path re-resolution and no reparse traversal.
    if (
      withNativeArguments([wide, string, attributes], () =>
        lib.symbols.NtCreateFile(
          result,
          0x00120080 | (directory ? 0x21 : 0),
          attributes,
          status,
          null,
          0,
          7,
          1,
          0x00200000 | 0x20 | (directory ? 1 : 0x40),
          null,
          0,
        ),
      ) < 0
    )
      fail('path');
    return windowsHandle(result[0]);
  } finally {
    lib.close();
  }
}
interface Sid {
  readonly text: string;
  readonly bytes: number;
}
function sidAt(bytes: Uint8Array, offset: number, bound: number): Sid {
  if (offset < 0 || offset + 8 > bound || bytes[offset] !== 1 || bytes[offset + 1] > 15) return fail('private-storage');
  const count = bytes[offset + 1],
    length = 8 + count * 4;
  if (offset + length > bound) return fail('private-storage');
  let authority = 0n;
  for (let index = 2; index < 8; index++) authority = (authority << 8n) | BigInt(bytes[offset + index]);
  let text = `S-1-${authority}`;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index++) text += `-${view.getUint32(offset + 8 + index * 4, true)}`;
  return {text, bytes: length};
}
export function windowsSecurityLibrary(owner?: WindowsNativeResourceOwner) {
  return windowsSystemLibrary(
    'advapi32.dll',
    {
      LookupAccountNameW: {
        args: ['buffer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'],
        returns: 'i32',
      },
      IsValidSid: {args: ['u64'], returns: 'i32'},
      GetLengthSid: {args: ['u64'], returns: 'u32'},
      GetSecurityInfo: {args: ['u64', 'u32', 'u32', 'buffer', 'ptr', 'buffer', 'ptr', 'buffer'], returns: 'u32'},
      IsValidSecurityDescriptor: {args: ['u64'], returns: 'i32'},
      GetSecurityDescriptorLength: {args: ['u64'], returns: 'u32'},
      ConvertStringSecurityDescriptorToSecurityDescriptorW: {
        args: ['buffer', 'u32', 'buffer', 'buffer'],
        returns: 'i32',
      },
    },
    owner,
  );
}
/** Resolve only the native local servicing identity; no account-name or cached SID grants authority. */
export function trustedInstallerOwner(
  kernel: NativeLibrary,
  borrowedSecurity?: ReturnType<typeof windowsSecurityLibrary>,
): string {
  const security = borrowedSecurity ?? windowsSecurityLibrary();
  try {
    const computer = new Uint16Array(256),
      computerLength = new Uint32Array([computer.length]),
      backing = new ArrayBuffer(68 + 32),
      bytes = new Uint8Array(backing, 0, 68),
      canary = new Uint8Array(backing, 68),
      capacity = new Uint32Array([bytes.length]),
      domain = new Uint16Array(256),
      domainLength = new Uint32Array([domain.length]),
      kind = new Uint32Array(1),
      address = windowsAddress(bytes);
    canary.fill(0xa5);
    if (
      kernel.symbols.GetComputerNameW(computer, computerLength) === 0 ||
      computerLength[0] === 0 ||
      computerLength[0] >= computer.length ||
      computer[computerLength[0]] !== 0 ||
      security.symbols.LookupAccountNameW(
        computer,
        windowsWide('NT SERVICE\\TrustedInstaller'),
        bytes,
        capacity,
        domain,
        domainLength,
        kind,
      ) === 0 ||
      !canary.every(value => value === 0xa5)
    )
      return fail('private-storage');
    // Successful cbSid is not a returned length. Bound the actual header before native SID readers.
    const sid = sidAt(bytes, 0, bytes.length);
    if (
      !/^S-1-5-80-(?:[0-9]+-){4}[0-9]+$/u.test(sid.text) ||
      security.symbols.IsValidSid(address) === 0 ||
      security.symbols.GetLengthSid(address) !== sid.bytes
    )
      return fail('private-storage');
    return sid.text;
  } finally {
    if (!borrowedSecurity) security.close();
  }
}
/** Strict bounded ACL decoder; the optional ancestor owner must come from the fixed native resolver above.
 * Callback/object/conditional ACEs and unknown layouts refuse; servicing identity never privileges ACE grants.
 */
export function assertWindowsDaclBytes(
  bytes: Uint8Array,
  ownerOffset: number,
  daclOffset: number,
  principal: string,
  privateObject: boolean,
  nativeTrustedInstallerOwner?: string,
): void {
  if (
    bytes.length < 20 ||
    bytes[0] !== 1 ||
    (nativeTrustedInstallerOwner !== undefined && !/^S-1-5-80-(?:[0-9]+-){4}[0-9]+$/u.test(nativeTrustedInstallerOwner))
  )
    return fail('private-storage');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    control = view.getUint16(2, true);
  if (
    view.getUint32(4, true) !== ownerOffset ||
    view.getUint32(16, true) !== daclOffset ||
    (control & 0x8004) !== 0x8004 ||
    ownerOffset < 20 ||
    daclOffset < 20 ||
    daclOffset + 8 > bytes.length
  )
    fail('private-storage');
  const owner = sidAt(bytes, ownerOffset, bytes.length).text;
  if (
    privateObject
      ? owner !== principal
      : owner !== principal &&
        !administrativePrincipals.has(owner) &&
        (nativeTrustedInstallerOwner === undefined || owner !== nativeTrustedInstallerOwner)
  )
    fail('private-storage');
  const revision = bytes[daclOffset],
    length = view.getUint16(daclOffset + 2, true),
    count = view.getUint16(daclOffset + 4, true);
  if (
    (revision !== 2 && revision !== 4) ||
    bytes[daclOffset + 1] !== 0 ||
    view.getUint16(daclOffset + 6, true) !== 0 ||
    length < 8 ||
    daclOffset + length > bytes.length ||
    count > 128
  )
    fail('private-storage');
  let cursor = daclOffset + 8;
  for (let index = 0; index < count; index++) {
    if (cursor + 8 > daclOffset + length) fail('private-storage');
    const kind = bytes[cursor],
      flags = bytes[cursor + 1],
      size = view.getUint16(cursor + 2, true),
      rights = view.getUint32(cursor + 4, true);
    if (
      (kind !== 0 && kind !== 1) ||
      (flags & ~0x1f) !== 0 ||
      size < 16 ||
      size % 4 !== 0 ||
      cursor + size > daclOffset + length
    )
      fail('private-storage');
    const sid = sidAt(bytes, cursor + 8, cursor + size);
    if (size !== 8 + sid.bytes) fail('private-storage');
    if (kind === 0 && rights !== 0 && sid.text !== principal && !administrativePrincipals.has(sid.text)) {
      if (privateObject || ((flags & 8) === 0 && (rights & 0x500d0040) !== 0)) fail('private-storage');
    }
    cursor += size;
  }
  // ACL slack is not an omitted ACE: every declared ACE was bounded and consumed above.
  if (cursor > daclOffset + length) fail('private-storage');
}
export interface WindowsFileSecurity {
  readonly owner: string;
  readonly bytes: Uint8Array;
}
interface BorrowedSecurityResources {
  readonly security: ReturnType<typeof windowsSecurityLibrary>;
  readonly kernel: NativeLibrary;
  readonly ownDescriptor: (descriptor: bigint) => () => void;
  readonly uncertain: (backing: readonly ArrayBufferView[]) => never;
}

/** Borrow the caller's bounded native ledger. Uncertain operations must poison it and retain their backing. */
export interface WindowsPrivateCreateResources extends BorrowedSecurityResources {
  readonly captureNative: WindowsNativeResourceOwner;
}
export interface WindowsPrivateCreatedFile {
  readonly handle: bigint;
  readonly identity: NativeFileIdentity;
  readonly security: WindowsFileSecurity;
  close(): void;
}
function protectedSecurity(bytes: Uint8Array, principal: string): void {
  if (bytes.length < 20) return fail('private-storage');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    owner = view.getUint32(4, true),
    dacl = view.getUint32(16, true);
  assertWindowsDaclBytes(bytes, owner, dacl, principal, true);
  // Exactly one noninheriting current-user full-control ACE, protected from broad ancestor inheritance.
  if (
    (view.getUint16(2, true) & 0x1000) === 0 ||
    view.getUint16(dacl + 4, true) !== 1 ||
    bytes[dacl + 8] !== 0 ||
    bytes[dacl + 9] !== 0 ||
    view.getUint32(dacl + 12, true) !== 0x001f01ff ||
    sidAt(bytes, dacl + 16, bytes.length).text !== principal
  )
    fail('private-storage');
}
function nativeName(kernel: NativeLibrary, handle: bigint): Uint8Array {
  const backing = new Uint8Array(65536 + 32);
  backing.fill(0xa5);
  if (
    kernel.symbols.GetFileInformationByHandleEx(handle, 2, backing.subarray(0, 65536), 65536) === 0 ||
    !backing.subarray(65536).every(value => value === 0xa5)
  )
    return fail('path');
  const length = new DataView(backing.buffer).getUint32(0, true);
  if (length < 2 || length > 65532 || length % 2 !== 0) return fail('path');
  return backing.slice(4, 4 + length);
}
const equalNativeBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Fixed package-private primitive, not a writer grant. The caller retains/authenticates the full parent ancestry.
 * FILE_CREATE never opens a collision. A lease owns its one exclusive delete-on-close HANDLE; it is not reopened.
 * Persistent children are incomplete until their caller writes, verifies and durably publishes them.
 */
export function windowsCreatePrivateAt(
  parent: bigint,
  name: string,
  kind: 'file' | 'directory' | 'lease',
  resources: WindowsPrivateCreateResources,
  assertParentCurrentSync: () => void,
): WindowsPrivateCreatedFile {
  const wide = windowsPathComponent(name),
    principal = windowsTokenPrincipal(undefined, resources.captureNative).sid;
  assertParentCurrentSync();
  const parentIdentity = windowsFileIdentity(resources.kernel, parent),
    parentName = nativeName(resources.kernel, parent);
  if ((parentIdentity.attributes & 0x10) === 0 || windowsVolumeType(resources.kernel, parent) !== 'NTFS')
    return fail('private-storage');
  const security = resources.security,
    nt = windowsSystemLibrary(
      'ntdll.dll',
      {
        NtCreateFile: {
          args: ['buffer', 'u32', 'buffer', 'buffer', 'ptr', 'u32', 'u32', 'u32', 'u32', 'ptr', 'u32'],
          returns: 'i32',
        },
      },
      resources.captureNative,
    );
  let releaseDescriptor: (() => void) | undefined, releaseHandle: (() => void) | undefined;
  let settled = true;
  try {
    const sddl = windowsWide(`O:${principal}D:P(A;;FA;;;${principal})`),
      descriptor = new BigUint64Array(1),
      length = new Uint32Array(1);
    settled = false;
    let converted: number;
    try {
      converted = security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, descriptor, length);
    } catch {
      return resources.uncertain([sddl, descriptor, length]);
    }
    if (converted === 0) {
      if (descriptor[0] !== 0n) return resources.uncertain([sddl, descriptor, length]);
      settled = true;
      return fail('private-storage');
    }
    if (descriptor[0] === 0n || descriptor[0] === 0xffffffffffffffffn)
      return resources.uncertain([sddl, descriptor, length]);
    const address = descriptor[0];
    releaseDescriptor = resources.ownDescriptor(address);
    settled = true;
    if (
      length[0] < 20 ||
      length[0] > 65536 ||
      security.symbols.IsValidSecurityDescriptor(address) === 0 ||
      security.symbols.GetSecurityDescriptorLength(address) !== length[0]
    )
      return fail('private-storage');
    protectedSecurity(new Uint8Array(toArrayBuffer(address, 0, length[0])).slice(), principal);
    const string = new BigUint64Array(2),
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
    attributesView.setBigUint64(8, parent, true);
    attributesView.setBigUint64(16, windowsAddress(string), true);
    attributesView.setUint32(24, 0x40 | 0x1000, true);
    attributesView.setBigUint64(32, address, true);
    guarded.fill(0xa5a5a5a5a5a5a5a5n);
    const backing = [wide, sddl, descriptor, length, string, attributes, output, guarded, io];
    assertParentCurrentSync();
    settled = false;
    let status: number;
    try {
      status = withNativeArguments(backing, () =>
        nt.symbols.NtCreateFile(
          output,
          kind === 'directory' ? 0x001201a3 : 0x00130183,
          attributes,
          io,
          null,
          0x80,
          kind === 'lease' ? 0 : 1,
          2, // FILE_CREATE, never OPEN_IF/OVERWRITE/SUPERSEDE.
          0x00200000 | 0x20 | (kind === 'directory' ? 1 : 0x40) | (kind === 'lease' ? 0x1000 : 0),
          null,
          0,
        ),
      );
    } catch {
      return resources.uncertain(backing);
    }
    if (status !== 0) {
      if (status === 0x103 || output[0] !== 0n || !guarded.subarray(2).every(v => v === 0xa5a5a5a5a5a5a5a5n))
        return resources.uncertain(backing);
      settled = true;
      return fail('private-storage'); // Collision/sharing/delete-pending is refusal, never absence or ownership.
    }
    if (output[0] === 0n || output[0] === 0xffffffffffffffffn) return resources.uncertain(backing);
    const handle = output[0],
      release = resources.captureNative(() => resources.kernel.symbols.CloseHandle(handle) !== 0);
    let handleState: 'owned' | 'closed' | 'unknown' = 'owned';
    releaseHandle = () => {
      if (handleState === 'closed') return;
      if (handleState === 'unknown') return resources.uncertain([]);
      handleState = 'unknown';
      try {
        release();
      } catch {
        return resources.uncertain([]);
      }
      handleState = 'closed';
    };
    if (
      !guarded.subarray(2).every(v => v === 0xa5a5a5a5a5a5a5a5n) ||
      new DataView(guarded.buffer).getInt32(0, true) !== 0 ||
      guarded[1] !== 2n
    )
      return resources.uncertain(backing);
    settled = true;
    const identity = windowsFileIdentity(resources.kernel, handle),
      actualSecurity = windowsReadFileSecurity(handle, principal, true, undefined, resources),
      after = windowsFileIdentity(resources.kernel, handle);
    protectedSecurity(actualSecurity.bytes, principal);
    if (
      !same(identity, after) ||
      identity.volumeId !== parentIdentity.volumeId ||
      ((identity.attributes & 0x10) !== 0) !== (kind === 'directory') ||
      (kind !== 'directory' && (identity.links !== 1 || identity.size !== 0n)) ||
      windowsVolumeType(resources.kernel, handle) !== 'NTFS'
    )
      return fail('private-storage');
    // Query the same exclusive HANDLE. Reopening the lease name would conflict with our own share0.
    const separator = parentName.length === 2 && parentName[0] === 92 && parentName[1] === 0 ? 0 : 2,
      expectedName = new Uint8Array(parentName.length + separator + wide.byteLength - 2);
    expectedName.set(parentName);
    if (separator) expectedName[parentName.length] = 92;
    expectedName.set(new Uint8Array(wide.buffer, 0, wide.byteLength - 2), parentName.length + separator);
    if (!equalNativeBytes(nativeName(resources.kernel, handle), expectedName)) return fail('path');
    assertParentCurrentSync(); // Own namespace writes may change parent data epochs; never normalize that identity.
    const currentParent = windowsFileIdentity(resources.kernel, parent);
    if (
      currentParent.volumeId !== parentIdentity.volumeId ||
      currentParent.fileId !== parentIdentity.fileId ||
      currentParent.dev !== parentIdentity.dev ||
      currentParent.ino !== parentIdentity.ino ||
      currentParent.birthtime !== parentIdentity.birthtime ||
      currentParent.attributes !== parentIdentity.attributes ||
      !equalNativeBytes(nativeName(resources.kernel, parent), parentName)
    )
      return fail('path');
    return {handle, identity: after, security: actualSecurity, close: releaseHandle};
  } catch (error) {
    if (settled) releaseHandle?.();
    throw error;
  } finally {
    if (settled) {
      releaseDescriptor?.();
      nt.close();
    }
  }
}
export function windowsReadFileSecurity(
  handle: bigint,
  principal: string,
  privateObject: boolean,
  servicingOwner: string | undefined,
  borrowed?: BorrowedSecurityResources,
): WindowsFileSecurity {
  const lib = borrowed?.security ?? windowsSecurityLibrary();
  const kernel = borrowed?.kernel ?? windowsKernel();
  let descriptor = 0n;
  let releaseDescriptor: (() => void) | undefined;
  try {
    const owner = new BigUint64Array(1),
      dacl = new BigUint64Array(1),
      sd = new BigUint64Array(1);
    const code = lib.symbols.GetSecurityInfo(handle, 1, 5, owner, null, dacl, null, sd);
    if (code !== 0) {
      // Failure does not authenticate an output allocation. Retain unexpected outputs without freeing them.
      if (borrowed && sd[0] !== 0n) borrowed.uncertain([owner, dacl, sd]);
      return fail('private-storage');
    }
    descriptor = windowsHandle(sd[0]);
    releaseDescriptor = borrowed?.ownDescriptor(descriptor);
    if (lib.symbols.IsValidSecurityDescriptor(descriptor) === 0) fail('private-storage');
    const length = lib.symbols.GetSecurityDescriptorLength(descriptor);
    if (
      length < 20 ||
      length > 65536 ||
      owner[0] < descriptor ||
      owner[0] + 8n > descriptor + BigInt(length) ||
      dacl[0] < descriptor ||
      dacl[0] + 8n > descriptor + BigInt(length)
    )
      fail('private-storage');
    const bytes = new Uint8Array(toArrayBuffer(descriptor, 0, length)).slice();
    assertWindowsDaclBytes(
      bytes,
      Number(owner[0] - descriptor),
      Number(dacl[0] - descriptor),
      principal,
      privateObject,
      privateObject ? undefined : servicingOwner,
    );
    return {owner: sidAt(bytes, Number(owner[0] - descriptor), bytes.length).text, bytes};
  } finally {
    if (releaseDescriptor) releaseDescriptor();
    else if (descriptor !== 0n) kernel.symbols.LocalFree(descriptor);
    if (!borrowed) {
      lib.close();
      kernel.close();
    }
  }
}

/** HANDLE-rooted ancestry and native owner/DACL/volume proof, independent of the source writer. */
export function assertWindowsPrivateProviderPath(path: string, kind: 'file' | 'directory'): void {
  const principal = windowsTokenPrincipal().sid;
  if (!/^[A-Za-z]:\\/u.test(path) || /[\p{Cc}]/u.test(path) || fs.realpathSync(path) !== path) fail('private-storage');
  const root = EffectString.slice(0, 3)(path),
    parts = EffectString.split(EffectString.slice(3)(path), '\\');
  if (EffectArray.some(parts, part => !part)) fail('private-storage');
  const opened: bigint[] = [];
  const lib = windowsFileLibrary(),
    chain: {handle: bigint; identity: NativeFileIdentity; name: string; directory: boolean}[] = [];
  try {
    const servicingOwner = trustedInstallerOwner(lib);
    if (lib.symbols.GetDriveTypeW(windowsWide(root)) !== 3) fail('private-storage');
    const handle = windowsHandle(
      lib.symbols.CreateFileW(windowsWide(root), 0x001200a1, 7, null, 3, 0x02000000 | 0x00200000, 0n),
    );
    opened.push(handle);
    chain.push({handle, identity: windowsFileIdentity(lib, handle), name: root, directory: true});
    for (let index = 0; index < parts.length; index++) {
      const directory = index < parts.length - 1 || kind === 'directory';
      const child = openAt(chain[chain.length - 1].handle, parts[index], directory);
      opened.push(child);
      const identity = windowsFileIdentity(lib, child);
      chain.push({handle: child, identity, name: parts[index], directory});
      if (((identity.attributes & 0x10) !== 0) !== directory || (!directory && identity.links !== 1))
        fail('private-storage');
    }
    for (let index = 0; index < chain.length; index++) {
      const edge = chain[index];
      windowsVolumeType(lib, edge.handle);
      windowsReadFileSecurity(edge.handle, principal, index === chain.length - 1, servicingOwner);
      if (!same(edge.identity, windowsFileIdentity(lib, edge.handle))) fail('private-storage');
      if (index > 0) {
        const reopened = openAt(chain[index - 1].handle, edge.name, edge.directory);
        try {
          if (!same(edge.identity, windowsFileIdentity(lib, reopened))) fail('private-storage');
        } finally {
          if (lib.symbols.CloseHandle(reopened) === 0) fail('io');
        }
      }
    }
  } finally {
    let failed = false;
    for (const handle of opened.reverse()) if (lib.symbols.CloseHandle(handle) === 0) failed = true;
    lib.close();
    if (failed) fail('io');
  }
}
