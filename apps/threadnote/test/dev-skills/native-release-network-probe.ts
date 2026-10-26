/** Test-only raw POSIX socket boundary: Bun's socket APIs replace denial errno with ECONNREFUSED. */
// Bun's standalone compiler cannot bundle the testing builtin export-star wrappers.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import {constants as filesystemConstants} from 'node:fs';
import {constants as systemConstants} from 'node:os';

export const NETWORK_PROBE_TIMEOUT_MS = 2000;
const errno = systemConstants.errno;
export interface NativeCallResult {
  value: number;
  errno: number;
}
export interface NativeSocketApi {
  socket(): NativeCallResult;
  flags(descriptor: number): NativeCallResult;
  setFlags(descriptor: number, flags: number): NativeCallResult;
  connect(descriptor: number, address: Uint8Array): NativeCallResult;
  poll(descriptor: number, timeoutMs: number): NativeCallResult;
  socketError(descriptor: number): NativeCallResult & {socketError: number};
  close(descriptor: number): NativeCallResult;
  nonblocking: number;
}
export interface NativeConnectResult {
  errno: number;
  syscall: 'connect' | 'getsockopt' | 'poll';
  elapsedMs: number;
}

/** sockaddr_in uses BSD's length/family bytes on macOS and native sa_family_t on Linux. */
export function nativeSocketAddress(
  platform: NodeJS.Platform,
  address: '192.0.2.1' | '127.0.0.1',
  port: number,
): Uint8Array {
  if (platform !== 'darwin' && platform !== 'linux')
    throw new Error('Raw socket isolation probes require macOS or Linux');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid socket probe port');
  const bytes = new Uint8Array(16);
  if (platform === 'darwin') {
    bytes[0] = 16;
    bytes[1] = 2;
  } else new Uint16Array(bytes.buffer, 0, 1)[0] = 2; // AF_INET, native byte order.
  bytes[2] = port >> 8;
  bytes[3] = port & 255;
  bytes.set(address === '192.0.2.1' ? [192, 0, 2, 1] : [127, 0, 0, 1], 4);
  return bytes;
}

/** Injectable syscall boundary for bounded timeout/error regressions, with no actual network in unit controls. */
export function connectNativeSocket(
  api: NativeSocketApi,
  address: Uint8Array,
  options: {now?: () => number; startedAt?: number} = {},
): NativeConnectResult {
  const now = options.now ?? (() => performance.now());
  const began = options.startedAt ?? now();
  const deadline = began + NETWORK_PROBE_TIMEOUT_MS;
  const remaining = () => Math.min(NETWORK_PROBE_TIMEOUT_MS, Math.ceil(deadline - now()));
  const setup = <T extends NativeCallResult>(syscall: string, call: () => T): T => {
    while (true) {
      if (remaining() <= 0) throw new Error(`Native socket probe timed out during ${syscall}`);
      const result = call();
      if (result.value >= 0) return result;
      if (result.errno !== errno.EINTR) throw new Error(`Native socket probe ${syscall} failed: errno ${result.errno}`);
    }
  };
  const descriptor = setup('socket', () => api.socket()).value;
  let bodyFailed = false;
  const result = (connectErrno: number, syscall: NativeConnectResult['syscall']): NativeConnectResult => ({
    errno: connectErrno,
    syscall,
    elapsedMs: now() - began,
  });
  const close = () => {
    try {
      const closed = api.close(descriptor);
      if (closed.value < 0 && !bodyFailed) throw new Error(`Native socket probe close failed: errno ${closed.errno}`);
    } catch (error) {
      if (!bodyFailed) throw error;
    }
  };
  try {
    const flags = setup('fcntl(F_GETFL)', () => api.flags(descriptor)).value;
    setup('fcntl(F_SETFL)', () => api.setFlags(descriptor, flags | api.nonblocking));
    if (remaining() <= 0) return result(errno.ETIMEDOUT, 'poll');
    const connected = api.connect(descriptor, address);
    if (remaining() <= 0) return result(errno.ETIMEDOUT, 'poll');
    if (connected.value === 0) return result(0, 'connect');
    if (![errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR].includes(connected.errno))
      return result(connected.errno, 'connect');
    while (true) {
      const budget = remaining();
      if (budget <= 0) return result(errno.ETIMEDOUT, 'poll');
      const ready = api.poll(descriptor, budget);
      if (ready.value < 0) {
        if (ready.errno === errno.EINTR) continue;
        throw new Error(`Native socket probe poll failed: errno ${ready.errno}`);
      }
      if (ready.value === 0 || remaining() <= 0) return result(errno.ETIMEDOUT, 'poll');
      const observed = setup('getsockopt(SO_ERROR)', () => api.socketError(descriptor));
      if (remaining() <= 0) return result(errno.ETIMEDOUT, 'poll');
      return result(observed.socketError, 'getsockopt');
    }
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    close();
  }
}

export function requireNativeNetworkDenial(result: NativeConnectResult): number {
  if (result.syscall === 'poll' || ![errno.EPERM, errno.EACCES, errno.ENETUNREACH].includes(result.errno)) {
    throw new Error(`Outbound network was not denied by the OS: errno ${result.errno} (${result.syscall})`);
  }
  return result.errno;
}

/** No libc is loaded on the explicit Windows functional-only path. No external compiler or interpreter is used. */
export async function nativeSocketConnect(
  address: '192.0.2.1' | '127.0.0.1' = '192.0.2.1',
  port = 443,
): Promise<NativeConnectResult> {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('Raw socket isolation probes require macOS or Linux');
  const began = performance.now();
  const {dlopen, toArrayBuffer} = await import('bun:ffi');
  const darwin = process.platform === 'darwin';
  const stackVarargs = darwin && process.arch === 'arm64';
  // macOS SDK sys/{socket,fcntl,poll}.h; Linux UAPI asm-generic/{socket,poll}.h and linux/in.h.
  // glibc nfds_t is unsigned long (64-bit on supported Linux targets); macOS nfds_t is unsigned int.
  const libraryName = darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
  const library = dlopen(libraryName, {
    socket: {args: ['i32', 'i32', 'i32'], returns: 'i32'},
    // Apple ARM64 puts variadic arguments on the stack, even with unused argument registers.
    // Bun FFI lacks a variadic signature: eight integer slots place the ninth flags value at sp.
    // https://developer.apple.com/documentation/xcode/writing-arm64-code-for-apple-platforms
    fcntl: {
      args: stackVarargs ? ['i32', 'i32', 'i32', 'i32', 'i32', 'i32', 'i32', 'i32', 'i32'] : ['i32', 'i32', 'i32'],
      returns: 'i32',
    },
    connect: {args: ['i32', 'ptr', 'u32'], returns: 'i32'},
    poll: {args: ['ptr', darwin ? 'u32' : 'u64', 'i32'], returns: 'i32'},
    getsockopt: {args: ['i32', 'i32', 'i32', 'ptr', 'ptr'], returns: 'i32'},
    close: {args: ['i32'], returns: 'i32'},
  });
  try {
    const errnoLibrary = darwin
      ? dlopen(libraryName, {__error: {args: [], returns: 'ptr'}})
      : dlopen(libraryName, {__errno_location: {args: [], returns: 'ptr'}});
    try {
      const pointer =
        '__error' in errnoLibrary.symbols ? errnoLibrary.symbols.__error() : errnoLibrary.symbols.__errno_location();
      if (pointer === null) throw new Error('Native errno pointer is unavailable');
      // Cache the thread-local errno view BEFORE every socket operation. Its direct read performs no syscall.
      const errnoView = new Int32Array(toArrayBuffer(pointer, 0, 4));
      const call = (native: () => number): NativeCallResult => {
        const value = native();
        const savedErrno = errnoView[0];
        return {value, errno: savedErrno};
      };
      const symbols = library.symbols;
      const fcntl = (descriptor: number, command: number, flags: number) =>
        stackVarargs
          ? symbols.fcntl(descriptor, command, 0, 0, 0, 0, 0, 0, flags)
          : symbols.fcntl(descriptor, command, flags);
      return connectNativeSocket(
        {
          nonblocking: filesystemConstants.O_NONBLOCK,
          socket: () => call(() => symbols.socket(2, 1, 0)), // AF_INET, SOCK_STREAM.
          flags: descriptor => call(() => fcntl(descriptor, 3, 0)), // F_GETFL.
          setFlags: (descriptor, flags) => {
            const changed = call(() => fcntl(descriptor, 4, flags)); // F_SETFL.
            if (changed.value >= 0) {
              const observed = call(() => fcntl(descriptor, 3, 0));
              if (observed.value < 0) return observed;
              if (!(observed.value & filesystemConstants.O_NONBLOCK))
                throw new Error('Native socket did not enter nonblocking mode');
            }
            return changed;
          },
          connect: (descriptor, socketAddress) =>
            call(() => symbols.connect(descriptor, socketAddress, socketAddress.byteLength)),
          poll: (descriptor, timeoutMs) => {
            const pollfd = new Int32Array(2);
            pollfd[0] = descriptor;
            new Int16Array(pollfd.buffer)[2] = 4; // POLLOUT; struct pollfd is int, short, short.
            return call(() => symbols.poll(pollfd, 1, timeoutMs));
          },
          socketError: descriptor => {
            const value = new Int32Array(1);
            const length = new Uint32Array([4]);
            const observed = call(() =>
              symbols.getsockopt(descriptor, darwin ? 0xffff : 1, darwin ? 0x1007 : 4, value, length),
            );
            if (observed.value >= 0 && length[0] !== 4)
              throw new Error('Native SO_ERROR returned an unexpected length');
            return {...observed, socketError: value[0]};
          },
          close: descriptor => call(() => symbols.close(descriptor)),
        },
        nativeSocketAddress(process.platform, address, port),
        {startedAt: began},
      );
    } finally {
      errnoLibrary.close();
    }
  } finally {
    library.close();
  }
}

// Compiled test-only entry exercises the same controller guard and native boundary without running workflows.
if (import.meta.main) {
  if (process.argv[2] === '--loopback') {
    const result = await nativeSocketConnect('127.0.0.1', Number(process.argv[3]));
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    const {verifyIsolation} = await import('./release-artifact.js');
    process.stdout.write(JSON.stringify(await verifyIsolation(process.argv[2] ?? '', true)) + '\n');
  }
}
