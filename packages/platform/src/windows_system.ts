import {dlopen} from 'bun:ffi';
import {Effect, Stream, Schema} from 'effect';
import {WINDOWS_DISK_CAPACITY_WORKER_PROTOCOL_VERSION} from './windows-disk-worker-contract.js';
import {fromPromiseInterruptibleAwaiting} from './errors.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class WindowsSystemError extends Schema.TaggedError<WindowsSystemError, {readonly brand: unique symbol}>()(
  'WindowsSystemError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DOTNET_TICKS_AT_WINDOWS_FILE_TIME_EPOCH = 504_911_232_000_000_000n;
const MEMORY_STATUS_BYTES = 64;
const MEMORY_STATUS_TOTAL_PHYSICAL_OFFSET = 8;
const WINDOWS_VERSION_INFO_BYTES = 276;
const WINDOWS_VERSION_MAJOR_OFFSET = 4;
const WINDOWS_VERSION_MINOR_OFFSET = 8;
const WINDOWS_VERSION_BUILD_OFFSET = 12;
const WINDOWS_PATH_CODE_UNIT_LIMIT = 32_767;
const WINDOWS_DISK_CAPACITY_WORKER_INPUT_LIMIT_BYTES = 256 * 1_024;
const MAXIMUM_SAFE_BYTE_COUNT = BigInt(Number.MAX_SAFE_INTEGER);

export interface WindowsHardwareInfo {
  readonly cpuModel: string;
  readonly effectiveMemoryBytes: number;
  readonly memoryBytes: number;
  readonly operatingSystem: string;
}

/** Convert one native ULARGE_INTEGER observation without losing integer precision. */
export function windowsAvailableDiskBytesFromNative(value: unknown): number | undefined {
  if (typeof value !== 'bigint' || value < 0n) return undefined;
  return Number(value > MAXIMUM_SAFE_BYTE_COUNT ? MAXIMUM_SAFE_BYTE_COUNT : value);
}

/** Encode one NUL-terminated Windows UTF-16 string for a native pointer. */
function windowsWideString(value: string): Uint16Array {
  const wide = new Uint16Array(value.length + 1);
  for (let index = 0; index < value.length; index += 1)
    wide[index] = Effect2.pipe(
      value,
      EffectString.charCodeAt(index),
      Effect2.Option.getOrElse(() => NaN),
    );
  return wide;
}

/**
 * Observe caller-available bytes through the Windows kernel. This synchronous
 * primitive must run only inside the dedicated killable standalone worker.
 */
export function readWindowsAvailableDiskBytesNative(path: string): Effect.Effect<number | undefined> {
  return Effect.sync(() => {
    if (
      path.length === 0 ||
      path.length > WINDOWS_PATH_CODE_UNIT_LIMIT ||
      Effect2.pipe(path, EffectString.includes('\0'))
    )
      return undefined;
    try {
      const kernel = dlopen('kernel32.dll', {
        GetDiskFreeSpaceExW: {
          args: ['buffer', 'buffer', 'buffer', 'buffer'],
          returns: 'i32',
        },
      });
      try {
        const widePath = windowsWideString(path);
        const availableToCaller = new BigUint64Array(1);
        const totalBytes = new BigUint64Array(1);
        const totalFreeBytes = new BigUint64Array(1);
        if (kernel.symbols.GetDiskFreeSpaceExW(widePath, availableToCaller, totalBytes, totalFreeBytes) === 0) {
          return undefined;
        }
        return windowsAvailableDiskBytesFromNative(availableToCaller[0]);
      } finally {
        kernel.close();
      }
    } catch {
      return undefined;
    }
  });
}

interface WindowsDiskCapacityWorkerRequest {
  readonly id: string;
  readonly path: string;
  readonly protocol: typeof WINDOWS_DISK_CAPACITY_WORKER_PROTOCOL_VERSION;
}

interface WindowsDiskCapacityWorkerResponse {
  readonly availableBytes: number | null;
  readonly id: string;
  readonly protocol: typeof WINDOWS_DISK_CAPACITY_WORKER_PROTOCOL_VERSION;
}

export interface WindowsDiskCapacityWorkerServerIo {
  readonly input: AsyncIterable<string | Uint8Array>;
  readonly writeLine: (line: string) => Promise<void>;
}

function decodeWindowsDiskCapacityWorkerRequest(line: string): WindowsDiskCapacityWorkerRequest | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('id' in value) ||
      !('path' in value) ||
      !('protocol' in value) ||
      typeof value.id !== 'string' ||
      !/^[1-9][0-9]{0,31}$/u.test(value.id) ||
      typeof value.path !== 'string' ||
      value.path.length === 0 ||
      value.path.length > WINDOWS_PATH_CODE_UNIT_LIMIT ||
      Effect2.pipe(value.path, EffectString.includes('\0')) ||
      value.protocol !== WINDOWS_DISK_CAPACITY_WORKER_PROTOCOL_VERSION
    ) {
      return undefined;
    }
    return {id: value.id, path: value.path, protocol: WINDOWS_DISK_CAPACITY_WORKER_PROTOCOL_VERSION};
  } catch {
    return undefined;
  }
}

/** Serve serial, bounded capacity queries until the owning process closes stdin. */
export function serveWindowsDiskCapacityWorker(
  io: WindowsDiskCapacityWorkerServerIo,
  readAvailableBytes: (
    path: string,
  ) => Effect.Effect<number | undefined, unknown> = readWindowsAvailableDiskBytesNative,
): Effect.Effect<void, WindowsSystemError> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  const handleLine = (line: string) =>
    Effect.gen(function* () {
      if (encoder.encode(line).byteLength > WINDOWS_DISK_CAPACITY_WORKER_INPUT_LIMIT_BYTES) {
        return yield* WindowsSystemError.make({message: 'Windows disk capacity worker request exceeded its limit.'});
      }
      const request = decodeWindowsDiskCapacityWorkerRequest(line);
      if (request === undefined) {
        return yield* WindowsSystemError.make({message: 'Windows disk capacity worker request was invalid.'});
      }
      const availableBytes = yield* readAvailableBytes(request.path).pipe(Effect.orElseSucceed(() => undefined));
      const response: WindowsDiskCapacityWorkerResponse = {
        availableBytes: availableBytes ?? null,
        id: request.id,
        protocol: WINDOWS_DISK_CAPACITY_WORKER_PROTOCOL_VERSION,
      };
      yield* fromPromiseInterruptibleAwaiting(
        () => io.writeLine(JSON.stringify(response)),
        cause => WindowsSystemError.make({cause, message: 'Could not write Windows disk capacity worker response.'}),
      );
    });
  const consumeChunk = (chunk: string | Uint8Array) =>
    Effect.gen(function* () {
      buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true});
      for (;;) {
        const newline = Effect2.pipe(
          buffered,
          EffectString.indexOf('\n'),
          Effect2.Option.getOrElse(() => -1),
        );
        if (newline < 0) break;
        const line = Effect2.pipe(buffered, EffectString.slice(0, newline), EffectString.replace(/\r$/u, ''));
        buffered = Effect2.pipe(buffered, EffectString.slice(newline + 1));
        if (line) yield* handleLine(line);
      }
      if (encoder.encode(buffered).byteLength > WINDOWS_DISK_CAPACITY_WORKER_INPUT_LIMIT_BYTES) {
        return yield* WindowsSystemError.make({message: 'Windows disk capacity worker input exceeded its limit.'});
      }
    });
  return Stream.fromAsyncIterable(io.input, cause =>
    WindowsSystemError.make({cause, message: 'Could not read Windows disk capacity worker input.'}),
  ).pipe(
    Stream.runForEach(consumeChunk),
    Effect.andThen(
      Effect.gen(function* () {
        buffered += decoder.decode();
        const finalLine = Effect2.pipe(buffered, EffectString.replace(/\r$/u, ''));
        if (finalLine) yield* handleLine(finalLine);
      }),
    ),
  );
}

export function readWindowsHardwareInfo(environment: NodeJS.ProcessEnv) {
  return Effect.try({
    try: () => {
      const kernel = dlopen('kernel32.dll', {
        GlobalMemoryStatusEx: {
          args: ['buffer'],
          returns: 'i32',
        },
      });
      const native = dlopen('ntdll.dll', {
        RtlGetVersion: {
          args: ['buffer'],
          returns: 'i32',
        },
      });
      try {
        const memoryStatus = new Uint8Array(MEMORY_STATUS_BYTES);
        const memoryView = new DataView(memoryStatus.buffer);
        memoryView.setUint32(0, MEMORY_STATUS_BYTES, true);
        if (kernel.symbols.GlobalMemoryStatusEx(memoryStatus) === 0) {
          throw WindowsSystemError.make({message: 'GlobalMemoryStatusEx failed.'});
        }

        const versionInfo = new Uint8Array(WINDOWS_VERSION_INFO_BYTES);
        const versionView = new DataView(versionInfo.buffer);
        versionView.setUint32(0, WINDOWS_VERSION_INFO_BYTES, true);
        if (native.symbols.RtlGetVersion(versionInfo) !== 0) {
          throw WindowsSystemError.make({message: 'RtlGetVersion failed.'});
        }

        const memoryBytes = Number(memoryView.getBigUint64(MEMORY_STATUS_TOTAL_PHYSICAL_OFFSET, true));
        const cpuModel =
          Effect2.pipe(environment.PROCESSOR_IDENTIFIER, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
          ) ||
          Effect2.pipe(environment.PROCESSOR_ARCHITECTURE, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
          ) ||
          'Windows processor';
        const operatingSystem = `Windows ${versionView.getUint32(WINDOWS_VERSION_MAJOR_OFFSET, true)}.${versionView.getUint32(
          WINDOWS_VERSION_MINOR_OFFSET,
          true,
        )}.${versionView.getUint32(WINDOWS_VERSION_BUILD_OFFSET, true)}`;
        if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) {
          throw WindowsSystemError.make({message: 'Windows memory metadata is invalid.'});
        }
        return {
          cpuModel,
          effectiveMemoryBytes: memoryBytes,
          memoryBytes,
          operatingSystem,
        } satisfies WindowsHardwareInfo;
      } finally {
        native.close();
        kernel.close();
      }
    },
    catch: cause => WindowsSystemError.make({cause, message: 'Could not read native Windows hardware metadata.'}),
  });
}

export function readWindowsProcessStartIdentity(processId: number): Effect.Effect<string | undefined> {
  return Effect.sync(() => {
    try {
      const kernel = dlopen('kernel32.dll', {
        CloseHandle: {
          args: ['ptr'],
          returns: 'i32',
        },
        GetProcessTimes: {
          args: ['ptr', 'buffer', 'buffer', 'buffer', 'buffer'],
          returns: 'i32',
        },
        OpenProcess: {
          args: ['u32', 'i32', 'u32'],
          returns: 'ptr',
        },
      });
      try {
        const handle = kernel.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, processId);
        if (handle === null) return undefined;
        try {
          const creationTime = new BigUint64Array(1);
          const exitTime = new BigUint64Array(1);
          const kernelTime = new BigUint64Array(1);
          const userTime = new BigUint64Array(1);
          if (kernel.symbols.GetProcessTimes(handle, creationTime, exitTime, kernelTime, userTime) === 0) {
            return undefined;
          }
          return `win32:${creationTime[0] + DOTNET_TICKS_AT_WINDOWS_FILE_TIME_EPOCH}`;
        } finally {
          kernel.symbols.CloseHandle(handle);
        }
      } finally {
        kernel.close();
      }
    } catch {
      return undefined;
    }
  });
}
