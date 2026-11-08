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
} from './windows-native.js';

const fs = process.getBuiltinModule('fs');
const administrativePrincipals = new Set(['S-1-5-18', 'S-1-5-32-544']);
interface NativeFileIdentity {
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
function library() {
  return dlopen('kernel32.dll', {
    CreateFileW: {args: ['buffer', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64'},
    CloseHandle: {args: ['u64'], returns: 'i32'},
    GetFileType: {args: ['u64'], returns: 'u32'},
    GetDriveTypeW: {args: ['buffer'], returns: 'u32'},
    GetFileInformationByHandle: {args: ['u64', 'buffer'], returns: 'i32'},
    GetFileInformationByHandleEx: {args: ['u64', 'u32', 'buffer', 'u32'], returns: 'i32'},
    GetVolumeInformationByHandleW: {
      args: ['u64', 'ptr', 'u32', 'buffer', 'buffer', 'buffer', 'buffer', 'u32'],
      returns: 'i32',
    },
  });
}
type NativeLibrary = ReturnType<typeof library>;
function nativeStat(lib: NativeLibrary, handle: bigint): NativeFileIdentity {
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
function localVolume(lib: NativeLibrary, handle: bigint): void {
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
  if (!end || (type !== 'NTFS' && type !== 'ReFS')) fail('private-storage');
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
/** Strict bounded ACL decoder; callback/object/conditional ACEs and unknown layouts refuse. */
export function assertWindowsDaclBytes(
  bytes: Uint8Array,
  ownerOffset: number,
  daclOffset: number,
  principal: string,
  privateObject: boolean,
): void {
  if (bytes.length < 20 || bytes[0] !== 1) return fail('private-storage');
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
  if (privateObject ? owner !== principal : owner !== principal && !administrativePrincipals.has(owner))
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
function privateAcl(handle: bigint, principal: string, privateObject: boolean): void {
  const lib = windowsSystemLibrary('advapi32.dll', {
    GetSecurityInfo: {args: ['u64', 'u32', 'u32', 'buffer', 'ptr', 'buffer', 'ptr', 'buffer'], returns: 'u32'},
    IsValidSecurityDescriptor: {args: ['u64'], returns: 'i32'},
    GetSecurityDescriptorLength: {args: ['u64'], returns: 'u32'},
  });
  const kernel = windowsKernel();
  let descriptor = 0n;
  try {
    const owner = new BigUint64Array(1),
      dacl = new BigUint64Array(1),
      sd = new BigUint64Array(1);
    if (lib.symbols.GetSecurityInfo(handle, 1, 5, owner, null, dacl, null, sd) !== 0) fail('private-storage');
    descriptor = windowsHandle(sd[0]);
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
    );
  } finally {
    if (descriptor !== 0n) kernel.symbols.LocalFree(descriptor);
    lib.close();
    kernel.close();
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
  const lib = library(),
    chain: {handle: bigint; identity: NativeFileIdentity; name: string; directory: boolean}[] = [];
  try {
    if (lib.symbols.GetDriveTypeW(windowsWide(root)) !== 3) fail('private-storage');
    const handle = windowsHandle(
      lib.symbols.CreateFileW(windowsWide(root), 0x001200a1, 7, null, 3, 0x02000000 | 0x00200000, 0n),
    );
    opened.push(handle);
    chain.push({handle, identity: nativeStat(lib, handle), name: root, directory: true});
    for (let index = 0; index < parts.length; index++) {
      const directory = index < parts.length - 1 || kind === 'directory';
      const child = openAt(chain[chain.length - 1].handle, parts[index], directory);
      opened.push(child);
      const identity = nativeStat(lib, child);
      chain.push({handle: child, identity, name: parts[index], directory});
      if (((identity.attributes & 0x10) !== 0) !== directory || (!directory && identity.links !== 1))
        fail('private-storage');
    }
    for (let index = 0; index < chain.length; index++) {
      const edge = chain[index];
      localVolume(lib, edge.handle);
      privateAcl(edge.handle, principal, index === chain.length - 1);
      if (!same(edge.identity, nativeStat(lib, edge.handle))) fail('private-storage');
      if (index > 0) {
        const reopened = openAt(chain[index - 1].handle, edge.name, edge.directory);
        try {
          if (!same(edge.identity, nativeStat(lib, reopened))) fail('private-storage');
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
