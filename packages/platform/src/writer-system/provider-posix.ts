import {providerOutputSource} from './provider-output-source.js';
import {Array as EffectArray, String as EffectString, Record as EffectRecord, Option} from 'effect';
import {dlopen, ptr, read} from 'bun:ffi';
import {withNativeArguments} from './native-arguments.js';
import {writerFail as fail} from './fault.js';
import {linuxRuntimeLibc, readPosixProcessIdentity, requirePosixWriterPlatform} from './posix-native.js';
import type {OwnedProviderBackend, RuntimeOwnedProviderLaunch} from './provider-contract.js';

const fs = process.getBuiltinModule('fs');
const encoder = new TextEncoder();
const pause = () => Bun.sleep(5);
const again = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK' || error.code === 'EINTR');
function text(value: string): Uint8Array {
  if (EffectString.includes('\0')(value) || encoder.encode(value).length > 1_048_576) return fail('path');
  return encoder.encode(`${value}\0`);
}
function pointers(values: readonly Uint8Array[]): BigUint64Array {
  return new BigUint64Array([...EffectArray.map(values, value => BigInt(ptr(value))), 0n]);
}

/**
 * Spawn without a ChildProcess reaper. The unreaped original leader reserves its PID/PGID
 * until the entire original group is observed empty. Signalling never reconstructs ownership
 * from a persisted PID, and never occurs after that reservation is released.
 */
let quarantinedLaunch: (() => boolean) | undefined;
export function spawnPosixProvider(options: RuntimeOwnedProviderLaunch): OwnedProviderBackend {
  if (quarantinedLaunch) {
    if (!quarantinedLaunch()) return fail('identity');
    quarantinedLaunch = undefined;
  }
  requirePosixWriterPlatform();
  if (
    !EffectString.startsWith('/')(options.command) ||
    !EffectString.startsWith('/')(options.cwd) ||
    options.args.length > 4096
  )
    return fail('path');
  const path = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : linuxRuntimeLibc().library;
  const lib = dlopen(path, {
    posix_spawn: {args: ['buffer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'], returns: 'i32'},
    posix_spawnattr_init: {args: ['buffer'], returns: 'i32'},
    posix_spawnattr_destroy: {args: ['buffer'], returns: 'i32'},
    posix_spawnattr_setflags: {args: ['buffer', 'i16'], returns: 'i32'},
    posix_spawnattr_setpgroup: {args: ['buffer', 'i32'], returns: 'i32'},
    posix_spawn_file_actions_init: {args: ['buffer'], returns: 'i32'},
    posix_spawn_file_actions_destroy: {args: ['buffer'], returns: 'i32'},
    posix_spawn_file_actions_adddup2: {args: ['buffer', 'i32', 'i32'], returns: 'i32'},
    posix_spawn_file_actions_addclose: {args: ['buffer', 'i32'], returns: 'i32'},
    posix_spawn_file_actions_addchdir_np: {args: ['buffer', 'buffer'], returns: 'i32'},
    read: {args: ['i32', 'buffer', 'u64'], returns: 'i64'},
    write: {args: ['i32', 'buffer', 'u64'], returns: 'i64'},
    waitpid: {args: ['i32', 'buffer', 'i32'], returns: 'i32'},
    kill: {args: ['i32', 'i32'], returns: 'i32'},
  });
  const nativeIo = providerIoLibrary(path);
  const fcntl = nativeIo.fcntl;
  const pipes: number[] = [];
  const attr = new BigUint64Array(64),
    actions = new BigUint64Array(16);
  let attrReady = false,
    actionsReady = false,
    transferred = false,
    pid = 0;
  const check = (status: number) => {
    if (status !== 0) fail('io');
  };
  const closeFd = (fd: number) => {
    const index = pipes.indexOf(fd);
    if (index >= 0) pipes.splice(index, 1);
    fs.closeSync(fd);
  };
  try {
    check(lib.symbols.posix_spawnattr_init(attr));
    attrReady = true;
    check(lib.symbols.posix_spawn_file_actions_init(actions));
    actionsReady = true;
    check(lib.symbols.posix_spawnattr_setpgroup(attr, 0));
    // A new session makes the original leader the group/session anchor, matching the prior detached launch.
    check(lib.symbols.posix_spawnattr_setflags(attr, process.platform === 'darwin' ? 0x0400 | 0x4000 : 0x0080));
    check(lib.symbols.posix_spawn_file_actions_addchdir_np(actions, text(options.cwd)));
    for (let i = 0; i < 3; i++) {
      const pair = new Int32Array(2);
      check(nativeIo.pipe(pair));
      if (pair[0] < 3 || pair[1] < 3) {
        for (const fd of pair) if (fd >= 0) fs.closeSync(fd);
        fail('io');
      }
      pipes.push(pair[0], pair[1]);
      for (const fd of pair) if (fcntl(fd, 2, 1) !== 0) fail('io'); // FD_CLOEXEC
      check(lib.symbols.posix_spawn_file_actions_adddup2(actions, pair[i === 0 ? 0 : 1], i));
    }
    for (const fd of pipes) check(lib.symbols.posix_spawn_file_actions_addclose(actions, fd));
    const argv = EffectArray.map([options.command, ...options.args], text);
    const env = EffectArray.map(
      EffectArray.filter(
        EffectRecord.toEntries(options.environment),
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
      ([key, value]) => {
        if (!key || EffectString.includes('=')(key) || EffectString.includes('\0')(key)) return fail('identity');
        return text(`${key}=${value}`);
      },
    );
    const output = new Int32Array(1);
    const argumentPointers = pointers(argv),
      environmentPointers = pointers(env),
      command = text(options.command);
    check(
      withNativeArguments([...argv, ...env, argumentPointers, environmentPointers, command], () =>
        lib.symbols.posix_spawn(output, command, actions, attr, argumentPointers, environmentPointers),
      ),
    );
    pid = output[0];
    if (pid <= 0) fail('identity');
    const [stdinRead, stdinWrite, stdoutRead, stdoutWrite, stderrRead, stderrWrite] = pipes;
    for (const fd of [stdinRead, stdoutWrite, stderrWrite]) closeFd(fd);
    for (const fd of [stdinWrite, stdoutRead, stderrRead]) {
      const flags = fcntl(fd, 3, 0);
      if (
        flags < 0 ||
        fcntl(fd, 4, flags | fs.constants.O_NONBLOCK) !== 0 ||
        (fcntl(fd, 3, 0) & fs.constants.O_NONBLOCK) === 0
      )
        fail('io');
    }
    const identity = readPosixProcessIdentity(pid, true);
    const result = makeOwned({
      pid,
      identity,
      stdinWrite,
      stdoutRead,
      stderrRead,
      lib: {
        symbols: lib.symbols,
        close: () => {
          lib.close();
          nativeIo.close();
        },
      },
      errno: nativeIo.errno,
      closeFd,
    });
    transferred = true;
    return result;
  } catch (error) {
    for (const fd of [...pipes])
      try {
        closeFd(fd);
      } catch {
        // Closing an uncertain descriptor is never retried; preserve the original launch failure.
      }
    if (pid > 0) {
      // The original native child has not been reaped. Signal only this creation-owned group once.
      lib.symbols.kill(-pid, 9);
      let reaped = false;
      const cleanup = () => {
        if (!reaped) {
          const result = lib.symbols.waitpid(pid, new Int32Array(1), 1);
          if (result !== pid) return false;
          reaped = true;
        }
        try {
          process.kill(-pid, 0);
          return false;
        } catch (error) {
          return isMissing(error);
        }
      };
      if (!cleanup()) {
        transferred = true; // The quarantine, rather than the thrown launch, now owns these native libraries.
        quarantinedLaunch = () => {
          if (!cleanup()) return false;
          lib.close();
          nativeIo.close();
          return true;
        };
      }
    }
    throw error;
  } finally {
    // On success the library remains owned by the capability until close.
    if (actionsReady) lib.symbols.posix_spawn_file_actions_destroy(actions);
    if (attrReady) lib.symbols.posix_spawnattr_destroy(attr);
    if (!transferred) {
      lib.close();
      nativeIo.close();
    }
  }
}

function makeOwned(input: {
  pid: number;
  identity: string;
  stdinWrite: number;
  stdoutRead: number;
  stderrRead: number;
  lib: {
    readonly symbols: {
      readonly waitpid: (pid: number, status: Int32Array, flags: number) => number;
      readonly kill: (pid: number, signal: number) => number;
      readonly read: (fd: number, bytes: Uint8Array, size: bigint) => bigint;
      readonly write: (fd: number, bytes: Uint8Array, size: bigint) => bigint;
    };
    readonly close: () => void;
  };
  closeFd: (fd: number) => void;
  errno: () => number;
}): OwnedProviderBackend {
  const {pid, identity, lib, closeFd} = input;
  const retry = () => {
    const errno = input.errno();
    return errno === 4 || errno === (process.platform === 'darwin' ? 35 : 11);
  };
  let inputOpen = true,
    inputClosing = false,
    closed = false,
    unknown = false,
    ioUnknown = false,
    reaped = false,
    groupEmpty = false;
  let leaderExitCode: number | null = null,
    writes = 0,
    writeBytes = 0;
  const eof = [false, false];
  let tail = Promise.resolve();
  const writable = async (bytes: Uint8Array, signal?: AbortSignal) => {
    let offset = 0;
    while (offset < bytes.length) {
      if (signal?.aborted) throw signal.reason ?? new Error('Provider input aborted');
      if (!inputOpen || closed) throw new Error('Provider input closed');
      try {
        const chunk = bytes.subarray(offset, Math.min(offset + 65_536, bytes.length));
        const result = lib.symbols.write(input.stdinWrite, chunk, BigInt(chunk.length));
        if (result === -1n && retry()) {
          await pause();
          continue;
        }
        const count = Number(result);
        if (count < 1) throw new Error('Provider input made no progress');
        offset += count;
        await Bun.sleep(1);
      } catch (error) {
        if (!again(error)) throw error;
        await pause();
      }
    }
  };
  const streams = EffectArray.map([input.stdoutRead, input.stderrRead], (fd, index) => {
    let discarding = false,
      failed = false;
    const pump = async (controller?: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
      try {
        const bytes = new Uint8Array(65_536);
        while (!closed && !eof[index]) {
          try {
            const result = lib.symbols.read(fd, bytes, BigInt(bytes.length));
            if (result === -1n && retry()) {
              await pause();
              continue;
            }
            if (result < 0n || result > BigInt(bytes.length)) throw new Error('Provider output read failed');
            const count = Number(result);
            if (count === 0) {
              eof[index] = true;
              closeFd(fd);
              if (!discarding) controller?.close();
              return;
            }
            await Bun.sleep(1);
            if (!discarding) {
              controller?.enqueue(bytes.subarray(0, count));
              return;
            }
          } catch (error) {
            if (!again(error)) throw error;
            await pause();
          }
        }
      } catch (error) {
        ioUnknown = true;
        failed = true;
        if (!discarding) controller?.error(error);
      }
    };
    return new ReadableStream<Uint8Array>(
      providerOutputSource(
        pump,
        () => {
          discarding = true;
        },
        () => !closed && !eof[index] && !failed,
      ),
      {highWaterMark: 1},
    );
  });
  const observe = () => {
    const stdioClosed = EffectArray.every(eof, Boolean) && writes === 0;
    if (closed) return {state: 'drained' as const, leaderExitCode, stdioClosed};
    if (!unknown && !groupEmpty)
      try {
        if (reaped) {
          // Reaping releases the PID reservation: no further signalling is permitted, even on a new matching PID.
          try {
            process.kill(-pid, 0);
            unknown = true;
          } catch (error) {
            if (isMissing(error)) groupEmpty = true;
            else unknown = true;
          }
        } else {
          const leader = readGroupMember(pid);
          if (leader.identity !== identity || leader.group !== pid || leader.uid !== process.getuid?.()) unknown = true;
          else if (leader.zombie) {
            leaderExitCode = leader.exitCode;
            const members = listGroup(pid);
            if (members === undefined) unknown = true;
            else if (members.length === 1 && members[0].zombie) {
              const status = new Int32Array(1),
                result = lib.symbols.waitpid(pid, status, 1);
              if (result !== pid) unknown = true;
              else {
                reaped = true;
                const raw = status[0];
                leaderExitCode = (raw & 0x7f) === 0 ? (raw >>> 8) & 0xff : 128 + (raw & 0x7f);
                try {
                  process.kill(-pid, 0);
                  unknown = true;
                } catch (error) {
                  if (isMissing(error)) groupEmpty = true;
                  else unknown = true;
                }
              }
            }
          }
        }
      } catch {
        unknown = true;
      }
    return {
      state:
        unknown || ioUnknown
          ? ('unknown' as const)
          : groupEmpty && stdioClosed
            ? ('drained' as const)
            : ('running' as const),
      leaderExitCode,
      stdioClosed,
    };
  };
  return {
    pid,
    identity,
    stdout: streams[0],
    stderr: streams[1],
    observe,
    write(bytes, signal) {
      if (closed || unknown || inputClosing || !inputOpen || signal?.aborted)
        return Promise.reject(new Error('Provider input unavailable'));
      if (writes >= 64 || bytes.byteLength > 32 * 1024 * 1024 - writeBytes)
        return Promise.reject(new Error('Provider input capacity exceeded'));
      const copy = bytes.slice();
      writes++;
      writeBytes += copy.length;
      const accepted = tail.then(() => writable(copy, signal));
      const settled = accepted.finally(() => {
        writes--;
        writeBytes -= copy.length;
      });
      tail = settled.catch(() => undefined);
      return settled;
    },
    closeInput() {
      inputClosing = true;
      return tail.then(() => {
        if (inputOpen) {
          inputOpen = false;
          try {
            closeFd(input.stdinWrite);
          } catch (error) {
            ioUnknown = true;
            throw error;
          }
        }
      });
    },
    terminate(mode) {
      if (closed || groupEmpty) return;
      if (unknown || reaped) return fail('identity');
      const leader = readGroupMember(pid);
      if (leader.identity !== identity || leader.group !== pid || leader.uid !== process.getuid?.()) {
        unknown = true;
        return fail('identity');
      }
      if (lib.symbols.kill(-pid, mode === 'kill' ? 9 : 15) !== 0) {
        unknown = true;
        fail('identity');
      }
    },
    close() {
      if (closed) return;
      if (observe().state !== 'drained') return fail('identity');
      if (inputOpen) {
        inputOpen = false;
        try {
          closeFd(input.stdinWrite);
        } catch (error) {
          ioUnknown = true;
          throw error;
        }
      }
      closed = true;
      lib.close();
    },
  };
}
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}
interface Member {
  readonly group: number;
  readonly uid: number;
  readonly identity: string;
  readonly zombie: boolean;
  readonly exitCode: number | null;
}
function readGroupMember(pid: number): Member {
  const identity = readPosixProcessIdentity(pid, true);
  if (process.platform === 'linux') {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'),
      end = Option.getOrElse(EffectString.lastIndexOf(')')(text), () => -1),
      fields = EffectString.split(EffectString.trim(EffectString.slice(end + 2)(text)), /\s+/u);
    const info = fs.lstatSync(`/proc/${pid}`, {bigint: true});
    if (readPosixProcessIdentity(pid, true) !== identity || fields.length < 20) fail('identity');
    return {identity, uid: Number(info.uid), group: Number(fields[2]), zombie: fields[0] === 'Z', exitCode: null};
  }
  const lib = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: {args: ['i32', 'i32', 'u64', 'buffer', 'i32'], returns: 'i32'},
  });
  try {
    const storage = new BigUint64Array(21),
      bytes = new Uint8Array(storage.buffer);
    bytes.fill(0xa5);
    if (
      lib.symbols.proc_pidinfo(pid, 3, 1n, bytes.subarray(0, 136), 136) !== 136 ||
      !bytes.subarray(136).every(v => v === 0xa5)
    )
      fail('identity');
    const v = new DataView(storage.buffer),
      observed = `darwin-proc-bsd-v1:${v.getBigUint64(120, true)}:${v.getBigUint64(128, true)}`;
    if (v.getUint32(12, true) !== pid || observed !== identity) fail('identity');
    return {
      identity,
      uid: v.getUint32(20, true),
      group: v.getUint32(100, true),
      zombie: v.getUint32(4, true) === 5,
      exitCode: (v.getUint32(8, true) >>> 8) & 0xff,
    };
  } finally {
    lib.close();
  }
}
function listGroup(group: number): readonly Member[] | undefined {
  if (process.platform === 'linux') {
    const names = fs.readdirSync('/proc');
    if (names.length > 65_536) return undefined;
    const members: Member[] = [];
    for (const name of names)
      if (/^[1-9]\d*$/u.test(name))
        try {
          const value = fs.readFileSync(`/proc/${name}/stat`, 'utf8'),
            end = Option.getOrElse(EffectString.lastIndexOf(')')(value), () => -1),
            fields = EffectString.split(EffectString.trim(EffectString.slice(end + 2)(value)), /\s+/u);
          if (Number(fields[2]) === group) members.push(readGroupMember(Number(name)));
        } catch (error) {
          if (!(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ESRCH')
          ))
            return undefined;
        }
    return members;
  }
  const lib = dlopen('/usr/lib/libproc.dylib', {
    proc_listpids: {args: ['u32', 'u32', 'buffer', 'i32'], returns: 'i32'},
  });
  try {
    const storage = new Int32Array(4097);
    storage.fill(-1);
    const count = lib.symbols.proc_listpids(2, group, new Uint8Array(storage.buffer, 0, 4096 * 4), 4096 * 4);
    if (count < 4 || count >= 4096 * 4 || count % 4 !== 0 || storage[4096] !== -1) return undefined;
    const members: Member[] = [];
    for (const pid of storage.subarray(0, count / 4))
      if (pid > 0) {
        try {
          const member = readGroupMember(pid);
          if (member.group !== group) return undefined;
          members.push(member);
        } catch {
          return undefined;
        }
      }
    return members;
  } finally {
    lib.close();
  }
}

function providerIoLibrary(path: string) {
  if (process.platform === 'darwin') {
    const lib = dlopen(path, {
      __fcntl: {args: ['i32', 'i32', 'i64'], returns: 'i32'},
      pipe: {args: ['buffer'], returns: 'i32'},
      __error: {args: [], returns: 'ptr'},
    });
    return {
      fcntl: (fd: number, command: number, value: number) => lib.symbols.__fcntl(fd, command, BigInt(value)),
      pipe: (pair: Int32Array) => lib.symbols.pipe(pair),
      errno: () => {
        const address = lib.symbols.__error();
        return address === null ? -1 : read.i32(address);
      },
      close: () => lib.close(),
    };
  }
  const lib = dlopen(path, {
    fcntl: {args: ['i32', 'i32', 'i64'], returns: 'i32'},
    pipe2: {args: ['buffer', 'i32'], returns: 'i32'},
    __errno_location: {args: [], returns: 'ptr'},
  });
  return {
    fcntl: (fd: number, command: number, value: number) => lib.symbols.fcntl(fd, command, BigInt(value)),
    pipe: (pair: Int32Array) => lib.symbols.pipe2(pair, 0x00080000),
    errno: () => {
      const address = lib.symbols.__errno_location();
      return address === null ? -1 : read.i32(address);
    },
    close: () => lib.close(),
  };
}

/** A read-only whole-group observation; it never mints the retained-child signalling capability. */
export function probePosixProviderTree(instance: {
  readonly pid: number;
  readonly identity: string;
}): 'present' | 'absent' | 'unknown' {
  if (!Number.isSafeInteger(instance.pid) || instance.pid <= 0 || instance.pid > 0x7fffffff || !instance.identity)
    return 'unknown';
  try {
    process.kill(-instance.pid, 0);
  } catch (error) {
    return isMissing(error) ? 'absent' : 'unknown';
  }
  try {
    const leader = readGroupMember(instance.pid);
    return leader.group === instance.pid && leader.identity === instance.identity && leader.uid === process.getuid?.()
      ? 'present'
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
