import {providerOutputSource} from './provider-output-source.js';
import {dlopen, ptr} from 'bun:ffi';
import {Array as EffectArray, Record as EffectRecord, String as EffectString, Option} from 'effect';
import {retainNativeArguments} from './native-arguments.js';
import {randomUuidV4} from '../uuid.js';
import {writerFail as fail} from './fault.js';
import {
  windowsAddress,
  windowsHandle,
  windowsKernel,
  windowsProcessIdentity,
  windowsTokenPrincipal,
  windowsWide,
  windowsInvalidHandle,
  windowsWellFormed,
  windowsSystemLibrary,
} from './windows-native.js';
import type {OwnedProviderBackend, RuntimeOwnedProviderLaunch} from './provider-contract.js';

/** Microsoft CRT argv quoting. CreateProcess receives a separate exact application path; no shell participates. */
export function windowsProviderCommandLine(command: string, args: readonly string[]): string {
  const quoted = EffectArray.map([command, ...args], value => {
    windowsWide(value);
    let result = '"',
      slashes = 0;
    for (const char of value) {
      if (char === '\\') {
        slashes++;
        continue;
      }
      result += EffectString.repeat(char === '"' ? slashes * 2 + 1 : slashes)('\\') + char;
      slashes = 0;
    }
    return result + EffectString.repeat(slashes * 2)('\\') + '"';
  });
  const line = EffectArray.join(quoted, ' ');
  if (line.length > 32766) fail('io');
  return line;
}
function environmentBlock(environment: NodeJS.ProcessEnv): Uint16Array {
  const entries = EffectArray.filter(
    EffectRecord.toEntries(environment),
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const seen = new Set<string>();
  for (const [key, value] of entries) {
    if (!key || !/^[\x20-\x7e]+$/u.test(key) || EffectString.includes('=')(key) || EffectString.includes('\0')(value))
      fail('identity');
    const canonical = EffectString.toUpperCase(key);
    if (seen.has(canonical)) fail('identity');
    seen.add(canonical);
  }
  const sorted = EffectArray.sort(
    entries,
    (leftEntry: readonly [string, string], rightEntry: readonly [string, string]) => {
      const left = leftEntry[0],
        right = rightEntry[0];
      const a = EffectString.toUpperCase(left),
        b = EffectString.toUpperCase(right);
      return a < b ? -1 : a > b ? 1 : 0;
    },
  );
  const body =
    EffectArray.join(
      EffectArray.map(sorted, ([key, value]) => `${key}=${value}`),
      '\0',
    ) + '\0';
  // The environment contains separators by design, so encode each code unit without the string-input NUL guard.
  if (body.length > 32766 || !windowsWellFormed(body)) fail('identity');
  const result = new Uint16Array(body.length + 1);
  for (let index = 0; index < body.length; index++)
    result[index] = Option.getOrElse(EffectString.charCodeAt(index)(body), () => fail('identity'));
  return result;
}

function kernel() {
  return dlopen('kernel32.dll', {
    CloseHandle: {args: ['u64'], returns: 'i32'},
    GetLastError: {args: [], returns: 'u32'},
    CreateJobObjectW: {args: ['ptr', 'ptr'], returns: 'u64'},
    SetInformationJobObject: {args: ['u64', 'u32', 'buffer', 'u32'], returns: 'i32'},
    QueryInformationJobObject: {args: ['u64', 'u32', 'buffer', 'u32', 'buffer'], returns: 'i32'},
    TerminateJobObject: {args: ['u64', 'u32'], returns: 'i32'},
    InitializeProcThreadAttributeList: {args: ['ptr', 'u32', 'u32', 'buffer'], returns: 'i32'},
    UpdateProcThreadAttribute: {args: ['buffer', 'u32', 'u64', 'buffer', 'u64', 'ptr', 'ptr'], returns: 'i32'},
    DeleteProcThreadAttributeList: {args: ['buffer'], returns: 'void'},
    CreateProcessW: {
      args: ['buffer', 'buffer', 'ptr', 'ptr', 'i32', 'u32', 'buffer', 'buffer', 'buffer', 'buffer'],
      returns: 'i32',
    },
    CreateNamedPipeW: {args: ['buffer', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'buffer'], returns: 'u64'},
    CreateFileW: {args: ['buffer', 'u32', 'u32', 'buffer', 'u32', 'u32', 'u64'], returns: 'u64'},
    ConnectNamedPipe: {args: ['u64', 'buffer'], returns: 'i32'},
    CreateEventW: {args: ['ptr', 'i32', 'i32', 'ptr'], returns: 'u64'},
    ResetEvent: {args: ['u64'], returns: 'i32'},
    ReadFile: {args: ['u64', 'buffer', 'u32', 'ptr', 'buffer'], returns: 'i32'},
    WriteFile: {args: ['u64', 'buffer', 'u32', 'ptr', 'buffer'], returns: 'i32'},
    GetOverlappedResult: {args: ['u64', 'buffer', 'buffer', 'i32'], returns: 'i32'},
    CancelIoEx: {args: ['u64', 'buffer'], returns: 'i32'},
    GetExitCodeProcess: {args: ['u64', 'buffer'], returns: 'i32'},
    WaitForSingleObject: {args: ['u64', 'u32'], returns: 'u32'},
    IsProcessInJob: {args: ['u64', 'u64', 'buffer'], returns: 'i32'},
  });
}
type Kernel = ReturnType<typeof kernel>;
interface Pipe {
  readonly parent: bigint;
  readonly child: bigint;
  readonly event: bigint;
  readonly overlapped: BigUint64Array;
  closed: boolean;
  busy: boolean;
  childOpen: boolean;
  connectionPending: boolean;
  uncertain: boolean;
  retainedBytes?: Uint8Array;
}
function close(kernel: Kernel, handle: bigint): void {
  if (kernel.symbols.CloseHandle(handle) === 0) fail('io');
}

/** Atomic Job assignment and a restrictive handle allowlist are both creation attributes, never a post-spawn fixup. */
let quarantinedLaunch: (() => boolean) | undefined;
export function spawnWindowsProvider(options: RuntimeOwnedProviderLaunch): OwnedProviderBackend {
  if (quarantinedLaunch) {
    if (!quarantinedLaunch()) return fail('identity');
    quarantinedLaunch = undefined;
  }
  const principal = windowsTokenPrincipal();
  const lib = kernel();
  const security = windowsSystemLibrary('advapi32.dll', {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {args: ['buffer', 'u32', 'buffer', 'buffer'], returns: 'i32'},
  });
  const base = windowsKernel();
  let descriptor = 0n,
    job = 0n,
    processHandle = 0n,
    thread = 0n,
    attributesReady = false,
    transferred = false;
  const pipes: Pipe[] = [];
  const creationBuffers: ArrayBufferView[] = [];
  const releaseArguments = retainNativeArguments(creationBuffers);
  const attributeSize = new BigUint64Array(1);
  let attributes = new Uint8Array(0);
  try {
    if (!/^[A-Za-z]:\\/u.test(options.command) || !/^[A-Za-z]:\\/u.test(options.cwd) || options.args.length > 4096)
      fail('path');
    const sd = new BigUint64Array(1),
      sdLength = new Uint32Array(1);
    if (
      security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        windowsWide(`O:${principal.sid}D:P(A;;GA;;;${principal.sid})`),
        1,
        sd,
        sdLength,
      ) === 0
    )
      fail('identity');
    descriptor = windowsHandle(sd[0]);
    const parentSecurity = new BigUint64Array(3),
      childSecurity = new BigUint64Array(3);
    for (const [bytes, inherit] of [
      [parentSecurity, 0],
      [childSecurity, 1],
    ] as const) {
      const view = new DataView(bytes.buffer);
      view.setUint32(0, 24, true);
      view.setBigUint64(8, descriptor, true);
      view.setUint32(16, inherit, true);
    }
    job = windowsHandle(lib.symbols.CreateJobObjectW(null, null));
    const limits = new BigUint64Array(18);
    new DataView(limits.buffer).setUint32(16, 0x00002000, true); // KILL_ON_JOB_CLOSE, no breakaway flags.
    if (lib.symbols.SetInformationJobObject(job, 9, limits, 144) === 0) fail('unsupported-platform');
    for (let index = 0; index < 3; index++) pipes.push(createPipe(lib, index === 0, parentSecurity, childSecurity));
    if (
      lib.symbols.InitializeProcThreadAttributeList(null, 2, 0, attributeSize) !== 0 ||
      lib.symbols.GetLastError() !== 122 ||
      attributeSize[0] === 0n ||
      attributeSize[0] > 65536n
    )
      fail('unsupported-platform');
    attributes = new Uint8Array(Number(attributeSize[0]));
    if (lib.symbols.InitializeProcThreadAttributeList(ptr(attributes), 2, 0, attributeSize) === 0)
      fail('unsupported-platform');
    attributesReady = true;
    const jobList = new BigUint64Array([job]),
      handles = new BigUint64Array(EffectArray.map(pipes, pipe => pipe.child));
    creationBuffers.push(jobList, handles, attributes);
    if (
      lib.symbols.UpdateProcThreadAttribute(attributes, 0, 0x0002000dn, jobList, 8n, null, null) === 0 ||
      lib.symbols.UpdateProcThreadAttribute(attributes, 0, 0x00020002n, handles, 24n, null, null) === 0
    )
      fail('unsupported-platform');
    const startup = new BigUint64Array(14),
      view = new DataView(startup.buffer);
    view.setUint32(0, 112, true);
    view.setUint32(60, 0x100, true);
    view.setBigUint64(80, pipes[0].child, true);
    view.setBigUint64(88, pipes[1].child, true);
    view.setBigUint64(96, pipes[2].child, true);
    view.setBigUint64(104, windowsAddress(attributes), true);
    const output = new BigUint64Array(3),
      outputView = new DataView(output.buffer);
    if (
      lib.symbols.CreateProcessW(
        windowsWide(options.command),
        windowsWide(windowsProviderCommandLine(options.command, options.args)),
        null,
        null,
        1,
        0x00080000 | 0x00000400 | 0x08000000,
        environmentBlock(options.environment),
        windowsWide(options.cwd),
        startup,
        output,
      ) === 0
    )
      fail('io');
    processHandle = windowsHandle(output[0]);
    thread = windowsHandle(output[1]);
    const pid = outputView.getUint32(16, true),
      inJob = new Int32Array(1);
    if (pid <= 0 || lib.symbols.IsProcessInJob(processHandle, job, inJob) === 0 || inJob[0] !== 1) fail('identity');
    const identity = windowsProcessIdentity(processHandle, pid);
    if (windowsTokenPrincipal(processHandle).sid !== principal.sid) fail('identity');
    close(lib, thread);
    thread = 0n;
    for (const pipe of pipes) {
      close(lib, pipe.child);
      pipe.childOpen = false;
    }
    const owned = makeOwnedWindows({lib, job, processHandle, pid, identity, pipes});
    transferred = true;
    return owned;
  } finally {
    if (attributesReady) lib.symbols.DeleteProcThreadAttributeList(attributes);
    releaseArguments();
    if (descriptor !== 0n) base.symbols.LocalFree(descriptor);
    security.close();
    base.close();
    if (!transferred) {
      // Retain native references until the owned Job is actually empty and pending connection IO has settled.
      // A failed launch cannot release hidden processes into the next admission attempt.
      if (job !== 0n) lib.symbols.TerminateJobObject(job, 1);
      if (thread !== 0n) lib.symbols.CloseHandle(thread);
      for (const pipe of pipes)
        if (pipe.childOpen) {
          lib.symbols.CloseHandle(pipe.child);
          pipe.childOpen = false;
        }
      const cleanup = () => {
        let complete = true;
        for (const pipe of pipes)
          if (pipe.connectionPending) {
            const count = new Uint32Array(1);
            lib.symbols.CancelIoEx(pipe.parent, pipe.overlapped);
            if (lib.symbols.GetOverlappedResult(pipe.parent, pipe.overlapped, count, 0) !== 0)
              pipe.connectionPending = false;
            else {
              const error = lib.symbols.GetLastError();
              if (error === 995 || error === 109 || error === 232) pipe.connectionPending = false;
              else complete = false;
            }
          }
        if (job !== 0n) {
          const info = new Uint8Array(48),
            length = new Uint32Array(1);
          if (
            lib.symbols.QueryInformationJobObject(job, 1, info, 48, length) === 0 ||
            length[0] !== 48 ||
            new DataView(info.buffer).getUint32(40, true) !== 0
          )
            complete = false;
        }
        if (!complete) return false;
        for (const pipe of pipes) {
          if (!pipe.closed) lib.symbols.CloseHandle(pipe.parent);
          lib.symbols.CloseHandle(pipe.event);
        }
        if (processHandle !== 0n) lib.symbols.CloseHandle(processHandle);
        if (job !== 0n) lib.symbols.CloseHandle(job);
        lib.close();
        return true;
      };
      if (!cleanup()) quarantinedLaunch = cleanup;
    }
  }
}
function createPipe(lib: Kernel, input: boolean, parentSecurity: BigUint64Array, childSecurity: BigUint64Array): Pipe {
  const name = windowsWide(`\\\\.\\pipe\\threadnote-provider-${randomUuidV4()}`);
  let parent = 0n,
    child = 0n,
    event = 0n;
  try {
    parent = windowsHandle(
      lib.symbols.CreateNamedPipeW(
        name,
        (input ? 2 : 1) | 0x40000000 | 0x00080000,
        8,
        1,
        65536,
        65536,
        0,
        parentSecurity,
      ),
    );
    event = windowsHandle(lib.symbols.CreateEventW(null, 1, 0, null));
    const overlapped = new BigUint64Array(4);
    overlapped[3] = event;
    child = windowsHandle(
      lib.symbols.CreateFileW(name, input ? 0x80000000 : 0x40000000, 0, childSecurity, 3, 0x80, 0n),
    );
    let connectionPending = false;
    if (lib.symbols.ConnectNamedPipe(parent, overlapped) === 0) {
      const error = lib.symbols.GetLastError();
      if (error === 997) connectionPending = true;
      else if (error !== 535) fail('io');
    }
    // ERROR_PIPE_CONNECTED proves the client connected before ConnectNamedPipe. No pending connection IO remains.
    return {
      parent,
      child,
      event,
      overlapped,
      closed: false,
      busy: false,
      childOpen: true,
      connectionPending,
      uncertain: false,
    };
  } catch (error) {
    if (child !== 0n && child !== windowsInvalidHandle) lib.symbols.CloseHandle(child);
    if (parent !== 0n && parent !== windowsInvalidHandle) lib.symbols.CloseHandle(parent);
    if (event !== 0n) lib.symbols.CloseHandle(event);
    throw error;
  }
}

async function pipeOperation(
  lib: Kernel,
  pipe: Pipe,
  bytes: Uint8Array,
  write: boolean,
  signal?: AbortSignal,
): Promise<number | 'eof'> {
  if (pipe.closed || pipe.busy || pipe.uncertain) throw new Error('Provider pipe unavailable');
  if (signal?.aborted) throw signal.reason ?? new Error('Provider write aborted');
  pipe.busy = true;
  const transferred = new Uint32Array(1);
  let pending = false,
    cancelled = false;
  const cancel = () => {
    cancelled = true;
    if (pending) lib.symbols.CancelIoEx(pipe.parent, pipe.overlapped);
  };
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    if (pipe.connectionPending) {
      while (lib.symbols.GetOverlappedResult(pipe.parent, pipe.overlapped, transferred, 0) === 0) {
        if (lib.symbols.GetLastError() !== 996) throw new Error('Provider pipe connection unknown');
        await Bun.sleep(5);
      }
      pipe.connectionPending = false;
    }
    pipe.overlapped.fill(0n);
    pipe.overlapped[3] = pipe.event;
    if (lib.symbols.ResetEvent(pipe.event) === 0) throw new Error('Provider pipe event failed');
    if (cancelled) throw signal?.reason ?? new Error('Provider write aborted');
    const started = write
      ? lib.symbols.WriteFile(pipe.parent, bytes, bytes.length, null, pipe.overlapped)
      : lib.symbols.ReadFile(pipe.parent, bytes, bytes.length, null, pipe.overlapped);
    if (started === 0) {
      const error = lib.symbols.GetLastError();
      if (!write && (error === 109 || error === 232)) return 'eof';
      if (error !== 997) {
        pipe.uncertain = error !== 109 && error !== 232;
        throw new Error('Provider pipe operation failed');
      }
    }
    pending = true;
    if (cancelled) lib.symbols.CancelIoEx(pipe.parent, pipe.overlapped);
    while (true) {
      if (lib.symbols.GetOverlappedResult(pipe.parent, pipe.overlapped, transferred, 0) !== 0) {
        pending = false;
        break;
      }
      const error = lib.symbols.GetLastError();
      if (error === 996) {
        await Bun.sleep(5);
        continue;
      }
      if (!write && (error === 109 || error === 232)) {
        pending = false;
        return 'eof';
      }
      if (error === 995 && cancelled) {
        pending = false;
        throw signal?.reason ?? new Error('Provider write aborted');
      }
      if (error === 109 || error === 232) {
        pending = false;
        throw new Error('Provider input closed');
      }
      pipe.uncertain = true;
      throw new Error('Provider pipe completion unknown');
    }
    if (cancelled) throw signal?.reason ?? new Error('Provider write aborted');
    if (transferred[0] > bytes.length) throw new Error('Provider pipe count invalid');
    // A successful zero-byte pipe read can follow a zero-byte write. Only broken/closing pipe status proves EOF.
    return transferred[0];
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (pending || pipe.uncertain) {
      pipe.uncertain = true;
      pipe.retainedBytes = bytes;
    } else pipe.busy = false;
  }
}
function makeOwnedWindows(input: {
  lib: Kernel;
  job: bigint;
  processHandle: bigint;
  pid: number;
  identity: string;
  pipes: readonly Pipe[];
}): OwnedProviderBackend {
  const {lib, job, processHandle, pid, identity, pipes} = input;
  let closed = false,
    unknown = false,
    closing = false,
    ioUnknown = false,
    inputClosing = false,
    writes = 0,
    writeBytes = 0;
  let tail = Promise.resolve(),
    leaderExitCode: number | null = null;
  const eof = [false, false];
  const stdout = EffectArray.map(pipes.slice(1), (pipe, index) => {
    let discarding = false,
      failed = false;
    const pump = async (controller?: ReadableStreamDefaultController<Uint8Array>) => {
      try {
        while (!closed && !eof[index]) {
          const bytes = new Uint8Array(65536),
            count = await pipeOperation(lib, pipe, bytes, false);
          if (count === 'eof') {
            eof[index] = true;
            close(lib, pipe.parent);
            pipe.closed = true;
            if (!discarding) controller?.close();
            return;
          }
          await Bun.sleep(1);
          if (!discarding) {
            controller?.enqueue(bytes.subarray(0, count));
            return;
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
    if (closing) return {state: 'unknown' as const, leaderExitCode, stdioClosed};
    let active: number | undefined;
    try {
      if (windowsProcessIdentity(processHandle, pid) !== identity) unknown = true;
      const status = lib.symbols.WaitForSingleObject(processHandle, 0);
      if (status === 0) {
        const code = new Uint32Array(1);
        if (lib.symbols.GetExitCodeProcess(processHandle, code) === 0) unknown = true;
        else leaderExitCode = code[0];
      } else if (status !== 258) unknown = true;
      const info = new BigUint64Array(10),
        bytes = new Uint8Array(info.buffer);
      bytes.fill(0xa5);
      const length = new Uint32Array(1);
      if (
        lib.symbols.QueryInformationJobObject(job, 1, bytes.subarray(0, 48), 48, length) === 0 ||
        length[0] !== 48 ||
        !bytes.subarray(48).every(v => v === 0xa5)
      )
        unknown = true;
      else active = new DataView(info.buffer).getUint32(40, true);
    } catch {
      unknown = true;
    }
    return {
      state:
        unknown || ioUnknown || EffectArray.some(pipes, pipe => pipe.uncertain) || active === undefined
          ? ('unknown' as const)
          : active === 0 && stdioClosed
            ? ('drained' as const)
            : ('running' as const),
      leaderExitCode,
      stdioClosed,
    };
  };
  return {
    pid,
    identity,
    stdout: stdout[0],
    stderr: stdout[1],
    observe,
    write(bytes, signal) {
      if (closed || closing || unknown || inputClosing || pipes[0].closed || signal?.aborted)
        return Promise.reject(new Error('Provider input unavailable'));
      if (writes >= 64 || bytes.length > 32 * 1024 * 1024 - writeBytes)
        return Promise.reject(new Error('Provider input capacity exceeded'));
      const copy = bytes.slice();
      writes++;
      writeBytes += copy.length;
      const accepted = tail.then(async () => {
        let offset = 0;
        while (offset < copy.length) {
          const count = await pipeOperation(
            lib,
            pipes[0],
            copy.subarray(offset, Math.min(offset + 65536, copy.length)),
            true,
            signal,
          );
          if (count === 'eof' || count < 1) throw new Error('Provider input made no progress');
          offset += count;
          await Bun.sleep(1);
        }
      });
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
        if (pipes[0].uncertain || pipes[0].busy) return fail('identity');
        if (!pipes[0].closed) {
          pipes[0].closed = true;
          try {
            close(lib, pipes[0].parent);
          } catch (error) {
            pipes[0].uncertain = true;
            throw error;
          }
        }
      });
    },
    terminate(mode) {
      if (mode !== 'terminate' && mode !== 'kill') return fail('identity');
      if (closed) return;
      if (closing || unknown || windowsProcessIdentity(processHandle, pid) !== identity) return fail('identity');
      if (lib.symbols.TerminateJobObject(job, 1) === 0) {
        unknown = true;
        fail('identity');
      }
    },
    close() {
      if (closed) return;
      if (closing || observe().state !== 'drained') return fail('identity');
      closing = true;
      let failed = false;
      const release = (handle: bigint) => {
        if (lib.symbols.CloseHandle(handle) === 0) failed = true;
      };
      for (const pipe of pipes) {
        if (pipe.busy || pipe.uncertain) {
          unknown = true;
          return fail('identity');
        }
        if (!pipe.closed) {
          pipe.closed = true;
          release(pipe.parent);
        }
        release(pipe.event);
      }
      release(processHandle);
      release(job);
      if (failed) {
        unknown = true;
        return fail('io');
      }
      closed = true;
      lib.close();
    },
  };
}
