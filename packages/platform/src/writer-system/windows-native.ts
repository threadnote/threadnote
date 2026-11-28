import {runtimeCurrentPlatform} from '../system.js';
import {dlopen, ptr, read, type FFIFunction} from 'bun:ffi';
import {String as EffectString, Option} from 'effect';
import {writerFail as fail} from './fault.js';

/** Package-private sink used by retained native operations; not an authority or operation-table input. */
export type WindowsNativeResourceOwner = (release: () => boolean) => () => void;
function ownRelease(release: () => boolean, owner?: WindowsNativeResourceOwner): () => void {
  if (owner) return owner(release);
  let state: 'owned' | 'closed' | 'unknown' = 'owned';
  return () => {
    if (state === 'closed') return;
    if (state === 'unknown') return fail('io');
    state = 'unknown';
    if (!release()) return fail('io');
    state = 'closed';
  };
}
export const windowsInvalidHandle = 0xffffffffffffffffn;
export function requireWindowsNative(): void {
  if (runtimeCurrentPlatform() !== 'win32' || (process.arch !== 'arm64' && process.arch !== 'x64'))
    fail('unsupported-platform');
}
export function windowsWide(value: string): Uint16Array {
  if (value.length > 32766 || EffectString.includes('\0')(value) || !windowsWellFormed(value)) return fail('path');
  const result = new Uint16Array(value.length + 1);
  for (let index = 0; index < value.length; index++)
    result[index] = Option.getOrElse(EffectString.charCodeAt(index)(value), () => fail('path'));
  return result;
}
export function windowsAddress(bytes: Uint8Array | Uint16Array | BigUint64Array): bigint {
  const address = ptr(bytes);
  if (!Number.isSafeInteger(address) || address <= 0) return fail('io');
  return BigInt(address);
}
export function windowsHandle(handle: bigint): bigint {
  if (handle === 0n || handle === windowsInvalidHandle) return fail('io');
  return handle;
}
export function windowsKernel(owner?: WindowsNativeResourceOwner) {
  requireWindowsNative();
  const library = dlopen('kernel32.dll', {
    CloseHandle: {args: ['u64'], returns: 'i32'},
    GetLastError: {args: [], returns: 'u32'},
    GetCurrentProcess: {args: [], returns: 'u64'},
    GetCurrentThread: {args: [], returns: 'u64'},
    GetProcessId: {args: ['u64'], returns: 'u32'},
    GetProcessTimes: {args: ['u64', 'buffer', 'buffer', 'buffer', 'buffer'], returns: 'i32'},
    GetExitCodeProcess: {args: ['u64', 'buffer'], returns: 'i32'},
    WaitForSingleObject: {args: ['u64', 'u32'], returns: 'u32'},
    LocalFree: {args: ['u64'], returns: 'u64'},
  });
  const close = ownRelease(() => {
    library.close();
    return true;
  }, owner);
  return {symbols: library.symbols, close};
}
export function windowsProcessIdentity(handle: bigint, expectedPid: number): string {
  const lib = windowsKernel();
  try {
    const creation = new BigUint64Array(1),
      exit = new BigUint64Array(1),
      kernel = new BigUint64Array(1),
      user = new BigUint64Array(1);
    if (
      lib.symbols.GetProcessId(handle) !== expectedPid ||
      lib.symbols.GetProcessTimes(handle, creation, exit, kernel, user) === 0 ||
      creation[0] === 0n
    )
      fail('identity');
    // Compatibility with the established facade's DateTime/.NET tick namespace. No numeric precision loss.
    return `win32:${creation[0] + 504_911_232_000_000_000n}`;
  } finally {
    lib.close();
  }
}

/** Exact native token SID. Usernames and numeric/folded SID hashes are never principal identities. */
export function windowsTokenPrincipal(
  processHandle?: bigint,
  owner?: WindowsNativeResourceOwner,
): {readonly sid: string; readonly accountHome: string} {
  const kernel = windowsKernel(owner);
  const security = windowsSystemLibrary(
    'advapi32.dll',
    {
      OpenProcessToken: {args: ['u64', 'u32', 'buffer'], returns: 'i32'},
      OpenThreadToken: {args: ['u64', 'u32', 'i32', 'buffer'], returns: 'i32'},
      GetTokenInformation: {args: ['u64', 'u32', 'ptr', 'u32', 'buffer'], returns: 'i32'},
      IsValidSid: {args: ['u64'], returns: 'i32'},
      GetLengthSid: {args: ['u64'], returns: 'u32'},
      ConvertSidToStringSidW: {args: ['u64', 'buffer'], returns: 'i32'},
    },
    owner,
  );
  const userenv = windowsSystemLibrary(
    'userenv.dll',
    {
      GetUserProfileDirectoryW: {args: ['u64', 'ptr', 'buffer'], returns: 'i32'},
    },
    owner,
  );
  let releaseToken: (() => void) | undefined, releaseSidText: (() => void) | undefined;
  try {
    const threadToken = new BigUint64Array(1);
    if (security.symbols.OpenThreadToken(kernel.symbols.GetCurrentThread(), 8, 1, threadToken) !== 0) {
      const handle = windowsHandle(threadToken[0]);
      ownRelease(() => kernel.symbols.CloseHandle(handle) !== 0, owner)();
      return fail('identity');
    }
    if (kernel.symbols.GetLastError() !== 1008) return fail('identity');
    const output = new BigUint64Array(1);
    if (security.symbols.OpenProcessToken(processHandle ?? kernel.symbols.GetCurrentProcess(), 8, output) === 0)
      fail('identity');
    const token = windowsHandle(output[0]),
      heldToken = token;
    releaseToken = ownRelease(() => kernel.symbols.CloseHandle(heldToken) !== 0, owner);
    const required = new Uint32Array(1);
    if (
      security.symbols.GetTokenInformation(token, 1, null, 0, required) !== 0 ||
      kernel.symbols.GetLastError() !== 122 ||
      required[0] < 16 ||
      required[0] > 65536
    )
      fail('identity');
    const length = required[0],
      // TOKEN_USER contains an absolute SID pointer. Materialize backing/views before native code writes it.
      buffer = new ArrayBuffer(length + 32),
      bytes = new Uint8Array(buffer),
      view = new DataView(buffer),
      canary = bytes.subarray(length);
    bytes.fill(0xa5);
    if (
      security.symbols.GetTokenInformation(token, 1, ptr(bytes), length, required) === 0 ||
      required[0] !== length ||
      !canary.every(v => v === 0xa5)
    )
      fail('identity');
    const sid = view.getBigUint64(0, true),
      start = windowsAddress(bytes);
    if (sid < start || sid + 8n > start + BigInt(length) || security.symbols.IsValidSid(sid) === 0) fail('identity');
    const sidLength = security.symbols.GetLengthSid(sid);
    if (sidLength < 8 || sidLength > 68 || sid + BigInt(sidLength) > start + BigInt(length)) fail('identity');
    const stringOutput = new BigUint64Array(1);
    if (security.symbols.ConvertSidToStringSidW(sid, stringOutput) === 0) fail('identity');
    const sidText = windowsHandle(stringOutput[0]),
      heldSidText = sidText;
    releaseSidText = ownRelease(() => kernel.symbols.LocalFree(heldSidText) === 0n, owner);
    let text = '';
    for (let index = 0; index < 256; index++) {
      const unit = read.u16(sidText + BigInt(index * 2));
      if (unit === 0) break;
      if (index === 255 || unit > 127) fail('identity');
      text += String.fromCharCode(unit);
    }
    if (!/^S-1-[0-9]+(?:-[0-9]+)+$/u.test(text)) fail('identity');
    const homeLength = new Uint32Array(1);
    if (
      userenv.symbols.GetUserProfileDirectoryW(token, null, homeLength) !== 0 ||
      kernel.symbols.GetLastError() !== 122 ||
      homeLength[0] < 4 ||
      homeLength[0] > 32767
    )
      fail('identity');
    const home = new Uint16Array(homeLength[0] + 16);
    home.fill(0xa5a5);
    const bound = homeLength[0];
    if (
      userenv.symbols.GetUserProfileDirectoryW(token, ptr(home), homeLength) === 0 ||
      homeLength[0] > bound ||
      !home.subarray(bound).every(v => v === 0xa5a5)
    )
      fail('identity');
    let accountHome = '';
    let terminated = false;
    for (const unit of home.subarray(0, bound)) {
      if (unit === 0) {
        terminated = true;
        break;
      }
      accountHome += String.fromCharCode(unit);
    }
    if (
      !terminated ||
      !windowsWellFormed(accountHome) ||
      !/^[A-Za-z]:\\/u.test(accountHome) ||
      /[\p{Cc}]/u.test(accountHome)
    )
      fail('identity');
    return {sid: text, accountHome};
  } finally {
    try {
      releaseSidText?.();
    } finally {
      try {
        releaseToken?.();
      } finally {
        try {
          userenv.close();
        } finally {
          try {
            security.close();
          } finally {
            kernel.close();
          }
        }
      }
    }
  }
}

export function windowsWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = Option.getOrElse(EffectString.charCodeAt(index)(value), () => -1);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = Option.getOrElse(EffectString.charCodeAt(++index)(value), () => -1);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/** Pin secondary system DLLs and their dependencies to the native system directory, independent of cwd/PATH. */
export function windowsSystemLibrary<const Fns extends Record<string, FFIFunction>>(
  name: 'advapi32.dll' | 'userenv.dll' | 'ntdll.dll',
  functions: Fns,
  owner?: WindowsNativeResourceOwner,
) {
  requireWindowsNative();
  const loader = dlopen('kernel32.dll', {
    GetSystemDirectoryW: {args: ['buffer', 'u32'], returns: 'u32'},
    LoadLibraryExW: {args: ['buffer', 'u64', 'u32'], returns: 'u64'},
    FreeLibrary: {args: ['u64'], returns: 'i32'},
  });
  let module = 0n;
  let releaseLibrary: (() => void) | undefined;
  const close = ownRelease(() => {
    releaseLibrary?.();
    if (module !== 0n && loader.symbols.FreeLibrary(module) === 0) return false;
    loader.close();
    return true;
  }, owner);
  try {
    const directory = new Uint16Array(32768),
      length = loader.symbols.GetSystemDirectoryW(directory, directory.length);
    if (length < 3 || length >= directory.length) return fail('unsupported-platform');
    let path = '';
    for (const unit of directory.subarray(0, length)) path += String.fromCharCode(unit);
    if (!/^[A-Za-z]:\\/u.test(path) || /[\p{Cc}]/u.test(path)) return fail('unsupported-platform');
    const absolute = `${path}\\${name}`;
    module = loader.symbols.LoadLibraryExW(windowsWide(absolute), 0n, 0x00000800);
    windowsHandle(module);
    const library = dlopen(absolute, functions);
    releaseLibrary = () => library.close();
    return {symbols: library.symbols, close};
  } catch (error) {
    close();
    throw error;
  }
}

/** Native HANDLE-bound identity for the existing public process-start channel. */
export function readNativeWindowsProcessStartIdentity(processId: number): string | undefined {
  if (
    runtimeCurrentPlatform() !== 'win32' ||
    !Number.isSafeInteger(processId) ||
    processId <= 0 ||
    processId > 0xffffffff
  )
    return undefined;
  const open = dlopen('kernel32.dll', {
    OpenProcess: {args: ['u32', 'i32', 'u32'], returns: 'u64'},
    CloseHandle: {args: ['u64'], returns: 'i32'},
  });
  let handle = 0n;
  try {
    handle = open.symbols.OpenProcess(0x1000, 0, processId);
    if (handle === 0n || handle === windowsInvalidHandle) return undefined;
    return windowsProcessIdentity(handle, processId);
  } catch {
    return undefined;
  } finally {
    if (handle !== 0n && handle !== windowsInvalidHandle) open.symbols.CloseHandle(handle);
    open.close();
  }
}

/** Writer lease identity additionally requires the exact same native account principal. */
export function readWindowsWriterProcessIdentity(processId: number): string {
  requireWindowsNative();
  if (!Number.isSafeInteger(processId) || processId <= 0 || processId > 0xffffffff) return fail('identity');
  const principal = windowsTokenPrincipal().sid;
  const lib = dlopen('kernel32.dll', {
    OpenProcess: {args: ['u32', 'i32', 'u32'], returns: 'u64'},
    CloseHandle: {args: ['u64'], returns: 'i32'},
  });
  let handle = 0n;
  try {
    handle = windowsHandle(lib.symbols.OpenProcess(0x1000, 0, processId));
    if (windowsTokenPrincipal(handle).sid !== principal) return fail('identity');
    return windowsProcessIdentity(handle, processId);
  } finally {
    if (handle !== 0n) lib.symbols.CloseHandle(handle);
    lib.close();
  }
}
