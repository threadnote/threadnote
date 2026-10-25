import {RuntimeEntrypoint} from './runtime-entrypoint.js';
import {Config, Context, Deferred, Effect, Exit, FileSystem, Layer, Option, Ref, Semaphore, Schema} from 'effect';
import {succeedUndefined} from './optional.js';
import {effectiveLinuxMemoryBytes, linuxCgroupMemoryFiles} from './linux_cgroup.js';
import {ChildEnvironmentPolicy, type ChildEnvironmentPolicyShape} from './child-environment-policy.js';
import {readWindowsHardwareInfo, readWindowsProcessStartIdentity} from './windows_system.js';
import {
  WINDOWS_DISK_CAPACITY_WORKER_ARGUMENT,
  WINDOWS_DISK_CAPACITY_WORKER_PROTOCOL_VERSION,
} from './windows-disk-worker-contract.js';

class SystemOperationError extends Schema.TaggedError<SystemOperationError>()('SystemOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

function systemOperationError(cause: unknown): SystemOperationError {
  return Schema.is(SystemOperationError)(cause)
    ? cause
    : SystemOperationError.make({cause, message: cause instanceof Error ? cause.message : String(cause)});
}

export interface PlatformPathShape {
  readonly basename: (path: string) => string;
  readonly dirname: (path: string) => string;
  readonly isAbsolute: (path: string) => boolean;
  readonly join: (...paths: readonly string[]) => string;
  readonly normalize: (path: string) => string;
  readonly relative: (from: string, to: string) => string;
  readonly resolve: (...paths: readonly string[]) => string;
  readonly sep: string;
}

interface NativeFileSystemPromisesShape {
  readonly lstat: (path: string, options: {readonly bigint: true}) => Promise<RuntimeBigIntStats>;
  readonly open: (path: string, flags: number) => Promise<RuntimeFileHandle>;
  readonly opendir: (
    path: string,
    options: {readonly bufferSize: number; readonly encoding: 'buffer' | 'utf8'},
  ) => Promise<RuntimeDirectoryHandle>;
  readonly stat: (path: string, options: {readonly bigint: true}) => Promise<RuntimeBigIntStats>;
  readonly statfs?: (path: string, options: {readonly bigint: true}) => Promise<unknown>;
}

interface RuntimeFileHandle {
  readonly close: () => Promise<void>;
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => Promise<{readonly bytesRead: number}>;
  readonly stat: (options: {readonly bigint: true}) => Promise<RuntimeBigIntStats>;
  readonly utimes: (atime: Date | number | string, mtime: Date | number | string) => Promise<void>;
}

interface NativeFileSystemModuleShape {
  readonly constants: {
    readonly O_NOFOLLOW?: number;
    readonly O_NONBLOCK?: number;
    readonly O_RDONLY: number;
    readonly O_RDWR: number;
  };
  readonly promises: NativeFileSystemPromisesShape;
  readonly fstatSync: (fd: number, options: {readonly bigint: true}) => RuntimeNativeFileStat;
  readonly statSync: (path: string, options: {readonly bigint: true}) => RuntimeNativeFileStat;
}

interface NativePathModuleShape {
  readonly posix: PlatformPathShape;
  readonly win32: PlatformPathShape;
}

interface NativeOperatingSystemModuleShape {
  readonly cpus: () => readonly {readonly model: string}[];
  readonly release: () => string;
  readonly totalmem: () => number;
}

export interface RuntimeBigIntStats {
  readonly birthtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

export interface RuntimeNativeFileStat {
  readonly birthtime: Date;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtime: Date;
  readonly size: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileSystemIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface FileSystemPathAuthority extends FileSystemIdentity {
  readonly birthtimeNs: bigint;
  readonly mode: bigint;
}

interface RuntimeDirectoryEntry {
  readonly isDirectory: () => boolean;
  readonly name: string | Uint8Array;
}

interface RuntimeDirectoryHandle extends AsyncIterable<RuntimeDirectoryEntry | Uint8Array> {
  readonly read: () => Promise<RuntimeDirectoryEntry | null>;
  readonly close: () => Promise<void> | void;
}

export interface RuntimeDirectoryNamePage {
  readonly names: readonly Uint8Array[];
  readonly overflow: boolean;
}

export interface RuntimeTextDirectoryNamePage {
  readonly names: readonly string[];
  readonly overflow: boolean;
}

/** Stream UTF-8 directory names without retaining a corpus-sized listing. */
export async function* runtimeTextDirectoryNames(path: string): AsyncGenerator<string, void, void> {
  const directory = await nativeFileSystemPromises.opendir(path, {
    bufferSize: 32,
    encoding: runtimePlatform === 'win32' ? 'utf8' : 'buffer',
  });
  const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  try {
    for await (const entry of directory) {
      const name = entry instanceof Uint8Array ? entry : entry.name;
      yield typeof name === 'string' ? name : decoder.decode(name);
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // A fully consumed async directory iterator is already closed.
    }
  }
}

/** Host facts and Bun's Node-compatible structural adapters stay inside SystemInfo's runtime boundary. */
export const runtimeArchitecture = process.arch;
export const runtimePlatform = process.platform;
const nativeOperatingSystemModule = process.getBuiltinModule('os') as NativeOperatingSystemModuleShape;
export const runtimeOperatingSystemRelease = nativeOperatingSystemModule.release();
const nativeFileSystemModule = process.getBuiltinModule('fs') as NativeFileSystemModuleShape;
const nativeFileSystemPromises = nativeFileSystemModule.promises;
const nativePathModule = process.getBuiltinModule('path') as NativePathModuleShape;

export function runtimeFileDescriptorStatSync(fd: number): RuntimeNativeFileStat {
  return nativeFileSystemModule.fstatSync(fd, {bigint: true});
}

export function runtimePathStatSync(path: string): RuntimeNativeFileStat {
  return nativeFileSystemModule.statSync(path, {bigint: true});
}

export type ProcessResourceUsageRuntime = 'bun' | 'node';

/**
 * Node exposes process.resourceUsage().maxRSS in KiB on every platform. The
 * release-pinned Bun 1.4.2 exposes KiB on every supported platform. Bun 1.3.x
 * exposed bytes on Darwin, so retain that conversion for older development
 * runtimes.
 */
export function processResourceUsageMaxRssBytes(
  maxRss: number,
  platform: NodeJS.Platform,
  runtime: ProcessResourceUsageRuntime,
  bunVersion?: string,
): number {
  return runtime === 'bun' && platform === 'darwin' && (bunVersion ?? Bun.version).startsWith('1.3.')
    ? maxRss
    : maxRss * 1_024;
}

export function platformPathFor(platform: NodeJS.Platform): PlatformPathShape {
  return platform === 'win32' ? nativePathModule.win32 : nativePathModule.posix;
}

/** Windows stat modes are synthetic; retain structural checks there and enforce POSIX privacy bits elsewhere. */
export function fileSystemModeIsPrivate(platform: NodeJS.Platform, mode: number): boolean {
  return platform === 'win32' || (mode & 0o077) === 0;
}

/** Exact host facts retained by same-machine benchmark provenance. */
export function runtimeHostHardwareInfo(): {
  readonly cpuModel: string;
  readonly logicalCpuCount: number;
  readonly memoryBytes: number;
} {
  const processors = nativeOperatingSystemModule.cpus();
  return {
    cpuModel: processors[0]?.model ?? 'unknown',
    logicalCpuCount: processors.length,
    memoryBytes: nativeOperatingSystemModule.totalmem(),
  };
}

export function runtimeLstat(path: string): Promise<RuntimeBigIntStats> {
  return nativeFileSystemPromises.lstat(path, {bigint: true});
}

/** Read one regular file without following a stable symbolic-link target and reject path/file races. */
export async function runtimeReadBoundedStableRegularFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes >= Number.MAX_SAFE_INTEGER) {
    throw SystemOperationError.make({message: 'Invalid read bound.'});
  }
  const pathBefore = await nativeFileSystemPromises.lstat(path, {bigint: true});
  if (!stableRegularFile(pathBefore) || pathBefore.size > BigInt(maximumBytes)) {
    throw SystemOperationError.make({message: 'Target is not a bounded stable regular file.'});
  }
  const flags =
    nativeFileSystemModule.constants.O_RDONLY |
    (nativeFileSystemModule.constants.O_NONBLOCK ?? 0) |
    (runtimePlatform === 'win32' ? 0 : (nativeFileSystemModule.constants.O_NOFOLLOW ?? 0));
  const opened = await nativeFileSystemPromises.open(path, flags);
  try {
    const [openedBefore, pathOpened] = await Promise.all([
      opened.stat({bigint: true}),
      nativeFileSystemPromises.lstat(path, {bigint: true}),
    ]);
    if (!sameStableRegularFile(pathBefore, openedBefore) || !sameStableRegularFile(pathBefore, pathOpened)) {
      throw SystemOperationError.make({message: 'Target changed while opening.'});
    }
    const bytes = new Uint8Array(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await opened.read(bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - offset) {
        throw SystemOperationError.make({message: 'Target returned an invalid read size.'});
      }
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const [openedAfter, pathAfter] = await Promise.all([
      opened.stat({bigint: true}),
      nativeFileSystemPromises.lstat(path, {bigint: true}),
    ]);
    if (
      !sameStableRegularFile(pathBefore, openedAfter) ||
      !sameStableRegularFile(pathBefore, pathAfter) ||
      offset > maximumBytes ||
      BigInt(offset) !== pathBefore.size
    ) {
      throw SystemOperationError.make({message: 'Target changed during bounded read.'});
    }
    return bytes.slice(0, offset);
  } finally {
    await opened.close();
  }
}

/**
 * Refresh a lease through the verified file handle, never through a path that
 * could be swapped to a symbolic link between validation and the timestamp
 * write. The expected content binds the lease to its current owner token.
 */
export async function runtimeTouchBoundedStableRegularFile(
  path: string,
  maximumBytes: number,
  expectedContent: Uint8Array,
  timestamp: Date,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes >= Number.MAX_SAFE_INTEGER ||
    expectedContent.byteLength > maximumBytes
  ) {
    throw SystemOperationError.make({message: 'Invalid touch bound.'});
  }
  const pathBefore = await nativeFileSystemPromises.lstat(path, {bigint: true});
  if (!stableRegularFile(pathBefore) || pathBefore.size > BigInt(maximumBytes)) return false;
  const flags =
    nativeFileSystemModule.constants.O_RDWR |
    (nativeFileSystemModule.constants.O_NONBLOCK ?? 0) |
    (runtimePlatform === 'win32' ? 0 : (nativeFileSystemModule.constants.O_NOFOLLOW ?? 0));
  const opened = await nativeFileSystemPromises.open(path, flags);
  try {
    const [openedBefore, pathOpened] = await Promise.all([
      opened.stat({bigint: true}),
      nativeFileSystemPromises.lstat(path, {bigint: true}),
    ]);
    if (!sameStableRegularFile(pathBefore, openedBefore) || !sameStableRegularFile(pathBefore, pathOpened))
      return false;
    const bytes = new Uint8Array(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await opened.read(bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - offset) return false;
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const [openedBeforeTouch, pathBeforeTouch] = await Promise.all([
      opened.stat({bigint: true}),
      nativeFileSystemPromises.lstat(path, {bigint: true}),
    ]);
    if (
      !sameStableRegularFile(pathBefore, openedBeforeTouch) ||
      !sameStableRegularFile(pathBefore, pathBeforeTouch) ||
      offset !== expectedContent.byteLength ||
      !bytesEqual(bytes.subarray(0, offset), expectedContent)
    ) {
      return false;
    }
    await opened.utimes(timestamp, timestamp);
    const [openedAfter, pathAfter] = await Promise.all([
      opened.stat({bigint: true}),
      nativeFileSystemPromises.lstat(path, {bigint: true}),
    ]);
    return (
      sameRegularFileIdentity(openedBeforeTouch, openedAfter) && sameRegularFileIdentity(openedBeforeTouch, pathAfter)
    );
  } finally {
    await opened.close();
  }
}

/** Follows links while retaining exact device/inode identity beyond JavaScript's safe-integer range. */
export function runtimeStat(path: string): Promise<RuntimeBigIntStats> {
  return nativeFileSystemPromises.stat(path, {bigint: true});
}

export function resolveFileSystemIdentity(
  dev: number,
  ino: Option.Option<number>,
  exact?: FileSystemIdentity,
): Option.Option<FileSystemIdentity> {
  const observedIno = Option.getOrUndefined(ino);
  return Number.isSafeInteger(dev) && observedIno !== undefined && Number.isSafeInteger(observedIno)
    ? Option.some({dev: BigInt(dev), ino: BigInt(observedIno)})
    : Option.fromNullishOr(exact);
}

export function readPathFileSystemIdentity(
  path: string,
  info: FileSystem.File.Info,
  expectedType: 'Directory' | 'File',
): Effect.Effect<Option.Option<FileSystemIdentity>> {
  if (info.type !== expectedType) return Effect.succeedNone;
  const observed = resolveFileSystemIdentity(info.dev, info.ino);
  if (Option.isSome(observed)) return Effect.succeed(observed);
  return readRuntimePathIdentity(path, expectedType).pipe(
    Effect.map(exact =>
      exact !== undefined && exactIdentityCoheres(info, exact) ? Option.some(exact) : Option.none(),
    ),
    Effect.orElseSucceed(() => Option.none()),
  );
}

/** Native path metadata is sampled twice so callers can retain one coherent authority record. */
export function readPathFileSystemAuthority(
  path: string,
  expectedType: 'Directory' | 'File',
): Effect.Effect<Option.Option<FileSystemPathAuthority>> {
  return Effect.tryPromise(async () => {
    const before = await runtimeLstat(path);
    const after = await runtimeLstat(path);
    const first = runtimePathAuthority(before, expectedType);
    const second = runtimePathAuthority(after, expectedType);
    return first !== undefined &&
      second !== undefined &&
      sameFileSystemIdentity(first, second) &&
      first.mode === second.mode &&
      first.birthtimeNs === second.birthtimeNs
      ? Option.some(first)
      : Option.none();
  }).pipe(Effect.orElseSucceed(() => Option.none()));
}

export function readOpenedFileSystemIdentity(
  file: FileSystem.File,
  info: FileSystem.File.Info,
  expectedType: 'Directory' | 'File',
): Effect.Effect<Option.Option<FileSystemIdentity>> {
  if (info.type !== expectedType) return Effect.succeedNone;
  const observed = resolveFileSystemIdentity(info.dev, info.ino);
  if (Option.isSome(observed)) return Effect.succeed(observed);
  const descriptor = (file as FileSystem.File & {readonly fd?: unknown}).fd;
  if (typeof descriptor !== 'number' || !Number.isSafeInteger(descriptor) || descriptor < 0) {
    return Effect.succeedNone;
  }
  return Effect.try(() => runtimeFileDescriptorStatSync(descriptor)).pipe(
    Effect.map(exact => {
      const identity = runtimeIdentity(exact, expectedType);
      return identity !== undefined && exactIdentityCoheres(info, identity) ? Option.some(identity) : Option.none();
    }),
    Effect.orElseSucceed(() => Option.none()),
  );
}

function exactIdentityCoheres(info: FileSystem.File.Info, exact: FileSystemIdentity): boolean {
  const observedIno = Option.getOrUndefined(info.ino);
  return (
    (!Number.isSafeInteger(info.dev) || exact.dev === BigInt(info.dev)) &&
    (observedIno === undefined || !Number.isSafeInteger(observedIno) || exact.ino === BigInt(observedIno))
  );
}

function readRuntimePathIdentity(
  path: string,
  expectedType: 'Directory' | 'File',
): Effect.Effect<FileSystemIdentity | undefined, unknown> {
  return Effect.tryPromise(async () => {
    const before = runtimeIdentity(await runtimeLstat(path), expectedType);
    const after = runtimeIdentity(await runtimeLstat(path), expectedType);
    return before !== undefined && after !== undefined && sameFileSystemIdentity(before, after) ? before : undefined;
  });
}

export function sameFileSystemIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function runtimeIdentity(
  info: RuntimeBigIntStats | RuntimeNativeFileStat,
  expectedType: 'Directory' | 'File',
): FileSystemIdentity | undefined {
  const matchesType = expectedType === 'Directory' ? info.isDirectory() : info.isFile();
  return matchesType && !info.isSymbolicLink() ? {dev: info.dev, ino: info.ino} : undefined;
}

function runtimePathAuthority(
  info: RuntimeBigIntStats,
  expectedType: 'Directory' | 'File',
): FileSystemPathAuthority | undefined {
  const identity = runtimeIdentity(info, expectedType);
  return identity === undefined ? undefined : {...identity, birthtimeNs: info.birthtimeNs, mode: info.mode};
}

function stableRegularFile(info: RuntimeBigIntStats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.dev !== 0n && info.ino !== 0n;
}

function sameStableRegularFile(left: RuntimeBigIntStats, right: RuntimeBigIntStats): boolean {
  return (
    stableRegularFile(left) &&
    stableRegularFile(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameRegularFileIdentity(left: RuntimeBigIntStats, right: RuntimeBigIntStats): boolean {
  return (
    stableRegularFile(left) &&
    stableRegularFile(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Raw POSIX directory names stay bytes; enumeration stops immediately after the first over-limit entry. */
export async function runtimeDirectoryNamePage(path: string, entryLimit: number): Promise<RuntimeDirectoryNamePage> {
  if (!Number.isSafeInteger(entryLimit) || entryLimit < 0)
    throw SystemOperationError.make({message: 'Runtime directory entry limit is invalid.'});
  const directory = await nativeFileSystemPromises.opendir(path, {
    bufferSize: 32,
    encoding: runtimePlatform === 'win32' ? 'utf8' : 'buffer',
  });
  const names: Uint8Array[] = [];
  try {
    for await (const entry of directory) {
      const name = entry instanceof Uint8Array ? entry : entry.name;
      if (names.length === entryLimit) return {names, overflow: true};
      names.push(typeof name === 'string' ? new TextEncoder().encode(name) : Uint8Array.from(name));
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // A fully consumed async directory iterator is already closed.
    }
  }
  return {names, overflow: false};
}

/** Scoped callers retain this native iterator; every read advances at most 64 directory entries. */
export async function runtimeOpenTextDirectoryNameReader(root: string) {
  const directory = await nativeFileSystemPromises.opendir(root, {bufferSize: 32, encoding: 'utf8'});
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await directory.close();
  };
  return {
    close,
    readPage: async (limit: number) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
        throw SystemOperationError.make({message: 'Runtime directory page limit is invalid.'});
      const names: string[] = [];
      if (closed) return {names, done: true};
      for (let count = 0; count < limit; count++) {
        const entry = await directory.read();
        if (!entry) {
          await close();
          return {names, done: true};
        }
        if (entry.isDirectory())
          names.push(
            typeof entry.name === 'string' ? entry.name : new TextDecoder('utf-8', {fatal: true}).decode(entry.name),
          );
      }
      return {names, done: false};
    },
  };
}

/** Effect-native UTF-8 view for bounded application ledgers that reject non-text names. */
export function runtimeTextDirectoryNamePage(
  path: string,
  entryLimit: number,
): Effect.Effect<RuntimeTextDirectoryNamePage, unknown> {
  return Effect.tryPromise({
    try: () => runtimeDirectoryNamePage(path, entryLimit),
    catch: systemOperationError,
  }).pipe(
    Effect.flatMap(page =>
      Effect.try({
        try: () => {
          const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
          return {names: page.names.map(name => decoder.decode(name)), overflow: page.overflow};
        },
        catch: systemOperationError,
      }),
    ),
  );
}

export interface SystemInfoShape {
  readonly architecture: string;
  readonly availableDiskBytes: (path: string) => Effect.Effect<number | undefined, unknown>;
  /** Versioned cross-observer identity; optional for legacy injected SystemInfo adapters. */
  readonly canonicalProcessStartIdentity?: (processId: number) => Effect.Effect<string | undefined>;
  readonly currentDirectory: () => string;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly developmentEntrypoint: string;
  readonly intendedChildEnvironment: ChildEnvironmentPolicyShape['preserveIntendedChild'];
  readonly executablePath: string;
  readonly homeDirectory: string;
  readonly hardwareInfo: Effect.Effect<SystemHardwareInfo, Error>;
  readonly isProcessRunning: (processId: number) => boolean;
  readonly memoryUsage: () => {
    readonly external: number;
    readonly heapUsed: number;
    /** Peak resident bytes when the runtime exposes a compatible process counter. */
    readonly peakRss?: number;
    readonly rss: number;
  };
  readonly processStartIdentity: (processId: number) => Effect.Effect<string | undefined>;
  readonly runtimeVersion: string;
  readonly pathDelimiter: string;
  readonly platform: NodeJS.Platform;
  readonly processId: number;
  readonly processArguments: readonly string[];
  readonly readLine: (prompt: string, onLine: (line: string) => void) => () => void;
  readonly signalProcess: (processId: number, signal: NodeJS.Signals) => void;
  readonly setExitCode: (code: number) => void;
  readonly setEnvironmentVariable: (name: string, value: string) => void;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY?: boolean;
  readonly tempDirectory: string;
  readonly userId?: number;
  readonly userName: string;
}

export interface SystemHardwareInfo {
  readonly cpuModel: string;
  /** Physical RAM remains the stable benchmark provenance value. */
  readonly memoryBytes: number;
  /** Lower of physical RAM and any visible finite cgroup memory limit. */
  readonly effectiveMemoryBytes: number;
  readonly operatingSystem: string;
}

type ProcessStartIdentityCacheState =
  | {readonly _tag: 'empty'}
  | {readonly _tag: 'pending'; readonly deferred: Deferred.Deferred<ProcessStartIdentityCacheSignal>}
  | {readonly _tag: 'complete'; readonly identity: string | undefined};

type ProcessStartIdentityCacheDecision =
  | {readonly _tag: 'owner'; readonly deferred: Deferred.Deferred<ProcessStartIdentityCacheSignal>}
  | {readonly _tag: 'pending'; readonly deferred: Deferred.Deferred<ProcessStartIdentityCacheSignal>}
  | {readonly _tag: 'complete'; readonly identity: string | undefined};

type ProcessStartIdentityCacheSignal =
  {readonly _tag: 'complete'; readonly identity: string | undefined} | {readonly _tag: 'retry'};

export function makeCachedProcessStartIdentityResolver(
  ownProcessId: number,
  resolve: (processId: number) => Effect.Effect<string | undefined>,
  ownerClaimed?: Effect.Effect<void>,
): Effect.Effect<(processId: number) => Effect.Effect<string | undefined>> {
  return Effect.gen(function* () {
    const state = yield* Ref.make<ProcessStartIdentityCacheState>({_tag: 'empty'});
    const resolveOwnProcessStartIdentity: Effect.Effect<string | undefined> = Effect.suspend(() =>
      Effect.uninterruptibleMask(restore =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<ProcessStartIdentityCacheSignal>();
          const decision = yield* Ref.modify(
            state,
            (current): readonly [ProcessStartIdentityCacheDecision, ProcessStartIdentityCacheState] => {
              if (current._tag === 'complete') {
                return [{_tag: 'complete', identity: current.identity} as const, current];
              }
              if (current._tag === 'pending') {
                return [{_tag: 'pending', deferred: current.deferred} as const, current];
              }
              const pending = {_tag: 'pending', deferred: candidate} as const;
              return [{_tag: 'owner', deferred: candidate} as const, pending];
            },
          );
          if (decision._tag === 'complete') return decision.identity;
          if (decision._tag === 'pending') {
            const signal = yield* restore(Deferred.await(decision.deferred));
            return signal._tag === 'complete' ? signal.identity : yield* restore(resolveOwnProcessStartIdentity);
          }
          if (ownerClaimed !== undefined) yield* ownerClaimed;

          // Cache both a defined identity and completed absence, but never cache
          // an interrupted/defective owner. Pending callers receive a neutral
          // retry signal so exactly one becomes the next owner instead of
          // inheriting another fiber's interruption cause.
          return yield* restore(resolve(ownProcessId)).pipe(
            Effect.onExit(exit =>
              Exit.isSuccess(exit)
                ? Ref.set(state, {_tag: 'complete', identity: exit.value}).pipe(
                    Effect.andThen(Deferred.succeed(decision.deferred, {_tag: 'complete', identity: exit.value})),
                    Effect.asVoid,
                  )
                : Ref.set(state, {_tag: 'empty'}).pipe(
                    Effect.andThen(Deferred.succeed(decision.deferred, {_tag: 'retry'})),
                    Effect.asVoid,
                  ),
            ),
          );
        }),
      ),
    );
    return (processId: number) => (processId === ownProcessId ? resolveOwnProcessStartIdentity : resolve(processId));
  });
}

export class SystemInfo extends Context.Service<SystemInfo, SystemInfoShape>()(
  '@threadnote/platform/system/SystemInfo',
) {
  static readonly layer = Layer.effect(
    SystemInfo,
    Effect.gen(function* () {
      const childEnvironmentPolicy = yield* ChildEnvironmentPolicy;
      const entrypoint = yield* RuntimeEntrypoint;
      const homeDirectory = resolveHomeDirectory(process.env, runtimePlatform);
      const processStartIdentity = yield* makeCachedProcessStartIdentityResolver(process.pid, processId =>
        readProcessStartIdentity(processId, runtimePlatform, process.env, childEnvironmentPolicy.sanitizeExternal),
      );
      const canonicalProcessStartIdentity = yield* makeCachedProcessStartIdentityResolver(process.pid, processId =>
        readCanonicalProcessStartIdentity(
          processId,
          runtimePlatform,
          process.env,
          childEnvironmentPolicy.sanitizeExternal,
        ),
      );
      const windowsAvailableDiskBytes =
        runtimePlatform === 'win32' && runtimeArchitecture === 'arm64'
          ? yield* makePersistentWindowsAvailableDiskBytes({
              developmentEntrypoint: entrypoint.developmentEntrypoint,
              sanitizeExternal: childEnvironmentPolicy.sanitizeExternal,
            })
          : undefined;
      const diskCapacityProbeAdapters: DiskCapacityProbeAdapters = {
        fallback: (path, platform, environment) =>
          legacyAvailableDiskBytes(path, platform, environment, childEnvironmentPolicy.sanitizeExternal),
        statfs: nativeStatfs,
        ...(windowsAvailableDiskBytes === undefined ? {} : {windows: windowsAvailableDiskBytes}),
      };
      const tmpdir = yield* Config.option(Config.String('TMPDIR')).pipe(Effect.orElseSucceed(() => Option.none()));
      const temp = yield* Config.option(Config.String('TEMP')).pipe(Effect.orElseSucceed(() => Option.none()));
      const tmp = yield* Config.option(Config.String('TMP')).pipe(Effect.orElseSucceed(() => Option.none()));
      const user = yield* Config.option(Config.String('USER')).pipe(Effect.orElseSucceed(() => Option.none()));
      const username = yield* Config.option(Config.String('USERNAME')).pipe(Effect.orElseSucceed(() => Option.none()));
      return SystemInfo.of({
        architecture: runtimeArchitecture,
        availableDiskBytes: path => availableDiskBytes(path, runtimePlatform, process.env, diskCapacityProbeAdapters),
        canonicalProcessStartIdentity,
        currentDirectory: () => process.cwd(),
        environment: () => process.env,
        developmentEntrypoint: entrypoint.developmentEntrypoint,
        intendedChildEnvironment: childEnvironmentPolicy.preserveIntendedChild,
        executablePath: process.execPath,
        hardwareInfo: readSystemHardwareInfo(runtimePlatform, process.env, childEnvironmentPolicy.sanitizeExternal),
        homeDirectory,
        isProcessRunning: processId => {
          try {
            process.kill(processId, 0);
            return true;
          } catch (cause: unknown) {
            return !(
              typeof cause === 'object' &&
              cause !== null &&
              'code' in cause &&
              (cause as {readonly code?: unknown}).code === 'ESRCH'
            );
          }
        },
        memoryUsage: () => {
          const usage = process.memoryUsage();
          const runtimePeakRss = process.resourceUsage().maxRSS;
          const runtime: ProcessResourceUsageRuntime = 'bun' in process.versions ? 'bun' : 'node';
          return {
            external: usage.external,
            heapUsed: usage.heapUsed,
            peakRss: processResourceUsageMaxRssBytes(runtimePeakRss, runtimePlatform, runtime),
            rss: usage.rss,
          };
        },
        processStartIdentity,
        runtimeVersion: Bun.version,
        pathDelimiter: runtimePlatform === 'win32' ? ';' : ':',
        platform: runtimePlatform,
        processId: process.pid,
        processArguments: process.argv,
        readLine: (prompt, onLine) => {
          const input = process.stdin;
          let buffered = '';
          let settled = false;
          const cleanup = () => {
            input.off('data', onData);
            input.off('end', onEnd);
            input.pause();
          };
          const finish = (line: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            onLine(line);
          };
          const onData = (chunk: string | Uint8Array) => {
            buffered += String(chunk);
            const newline = buffered.search(/[\r\n]/);
            if (newline >= 0) {
              finish(buffered.slice(0, newline));
            }
          };
          const onEnd = () => finish(buffered);
          process.stdout.write(prompt);
          input.on('data', onData);
          input.once('end', onEnd);
          input.resume();
          return cleanup;
        },
        signalProcess: (processId, signal) => {
          process.kill(processId, signal);
        },
        setExitCode: code => {
          process.exitCode = code;
        },
        setEnvironmentVariable: (name, value) => {
          process.env[name] = value;
        },
        stdinIsTTY: process.stdin.isTTY === true,
        stdoutIsTTY: process.stdout.isTTY === true,
        stderrIsTTY: process.stderr.isTTY === true,
        tempDirectory:
          Option.getOrUndefined(tmpdir) ??
          Option.getOrUndefined(temp) ??
          Option.getOrUndefined(tmp) ??
          (runtimePlatform === 'win32' ? process.cwd() : '/tmp'),
        userId: process.getuid?.(),
        userName: Option.getOrUndefined(user) ?? Option.getOrUndefined(username) ?? 'unknown',
      });
    }),
  );
}

const DISK_QUERY_TIMEOUT_MS = 10_000;
const DISK_QUERY_OUTPUT_LIMIT_BYTES = 64 * 1_024;
const WINDOWS_DISK_CAPACITY_WORKER_RESPONSE_LIMIT_BYTES = 1_024;
const WINDOWS_DISK_CAPACITY_WORKER_SHUTDOWN_TIMEOUT_MS = 1_000;
const KIBIBYTE_BYTES = 1024;
const DARWIN_PROCESS_START_OUTPUT_PATTERN =
  /^ {0,4}((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|[12][0-9]|3[01]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] [0-9]{4}) {0,4}\n?$/;
const PROCESS_IDENTITY_QUERY_OUTPUT_LIMIT_BYTES = 4 * 1_024;
const PROCESS_IDENTITY_QUERY_TIMEOUT_MS = 5_000;
const WINDOWS_PROCESS_START_OUTPUT_PATTERN = /^(0|[1-9][0-9]{0,19})(?:\r?\n)?$/;
const MAXIMUM_SAFE_BYTE_COUNT = BigInt(Number.MAX_SAFE_INTEGER);
const NATIVE_STATFS_UNAVAILABLE_CODES = new Set([
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ERR_METHOD_NOT_IMPLEMENTED',
  'ERR_NOT_IMPLEMENTED',
]);

export interface DiskCapacityProbeAdapters {
  readonly fallback: (
    path: string,
    platform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<number | undefined, unknown>;
  readonly statfs: (path: string) => Effect.Effect<unknown, unknown>;
  readonly windows?: (
    path: string,
    environment: NodeJS.ProcessEnv,
    timeoutMilliseconds?: number,
  ) => Effect.Effect<number | undefined, unknown>;
}

export interface WindowsProcessStartIdentityProbeAdapters {
  readonly fallback: (processId: number, environment: NodeJS.ProcessEnv) => Effect.Effect<string | undefined, unknown>;
  readonly native: (processId: number) => Effect.Effect<string | undefined, unknown>;
}

class NativeStatfsUnavailableError {
  readonly _tag = 'NativeStatfsUnavailableError';
}

function availableDiskBytes(
  path: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  adapters: DiskCapacityProbeAdapters,
) {
  return probeRuntimeAvailableDiskBytes(path, platform, runtimeArchitecture, environment, adapters);
}

export function probeRuntimeAvailableDiskBytes(
  path: string,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  environment: NodeJS.ProcessEnv,
  adapters: DiskCapacityProbeAdapters,
  timeoutMilliseconds = DISK_QUERY_TIMEOUT_MS,
) {
  // Bun 1.3.14's standalone darwin-x64 runtime has produced unusable native
  // statfs observations on the exact Intel release runner. Keep the same
  // bounded, cancellable query contract while using df on that architecture.
  if (platform === 'darwin' && architecture === 'x64') {
    return adapters.fallback(path, platform, environment).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMilliseconds,
        orElse: () => succeedUndefined,
      }),
    );
  }
  // Bun 1.3.14's standalone Windows ARM64 statfs adapter is unusable. Prefer a
  // persistent killable native worker and retain PowerShell as one fallback.
  if (platform === 'win32' && architecture === 'arm64') {
    const nativeTimeoutMilliseconds = Math.max(1, Math.floor(timeoutMilliseconds / 2));
    const native = adapters.windows?.(path, environment, nativeTimeoutMilliseconds) ?? succeedUndefined;
    return native.pipe(
      Effect.matchEffect({
        onFailure: () => adapters.fallback(path, platform, environment),
        onSuccess: available =>
          available === undefined ? adapters.fallback(path, platform, environment) : Effect.succeed(available),
      }),
      Effect.timeoutOrElse({
        duration: timeoutMilliseconds,
        orElse: () => succeedUndefined,
      }),
      Effect.orElseSucceed(() => undefined),
    );
  }
  return probeAvailableDiskBytes(path, platform, environment, adapters, timeoutMilliseconds);
}

export function probeAvailableDiskBytes(
  path: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  adapters: DiskCapacityProbeAdapters,
  timeoutMilliseconds = DISK_QUERY_TIMEOUT_MS,
) {
  return adapters.statfs(path).pipe(
    Effect.matchEffect({
      onFailure: cause =>
        isNativeStatfsUnavailable(cause) ? adapters.fallback(path, platform, environment) : succeedUndefined,
      onSuccess: statistics => Effect.succeed(availableDiskBytesFromStatfs(statistics)),
    }),
    Effect.timeoutOrElse({
      duration: timeoutMilliseconds,
      orElse: () => succeedUndefined,
    }),
  );
}

export function availableDiskBytesFromStatfs(statistics: unknown): number | undefined {
  if (typeof statistics !== 'object' || statistics === null) return undefined;
  const fields = statistics as {readonly bavail?: unknown; readonly bsize?: unknown};
  const availableBlocks = nonNegativeIntegerBigInt(fields.bavail);
  const blockSize = positiveIntegerBigInt(fields.bsize);
  if (availableBlocks === undefined || blockSize === undefined) return undefined;
  const availableBytes = availableBlocks * blockSize;
  return Number(availableBytes > MAXIMUM_SAFE_BYTE_COUNT ? MAXIMUM_SAFE_BYTE_COUNT : availableBytes);
}

function nativeStatfs(path: string) {
  if (typeof nativeFileSystemPromises.statfs !== 'function') {
    return Effect.fail(new NativeStatfsUnavailableError());
  }
  return Effect.tryPromise({
    try: () => nativeFileSystemPromises.statfs!(path, {bigint: true}),
    catch: systemOperationError,
  });
}

/** @internal Exported for a real-process cancellation regression. */
export function legacyAvailableDiskBytes(
  path: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  sanitizeExternal: ChildEnvironmentPolicyShape['sanitizeExternal'],
  posixDiskCommand = '/bin/df',
) {
  const command =
    platform === 'win32'
      ? [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$root=[IO.Path]::GetPathRoot($env:THREADNOTE_DISK_PATH); ' +
            'if (-not $root) { exit 2 }; ' +
            '[Console]::Out.Write((Get-PSDrive -Name $root.Substring(0,1)).Free)',
        ]
      : [posixDiskCommand, '-Pk', path];
  const sanitizedEnvironment = sanitizeExternal(environment);
  const childEnvironment =
    platform === 'win32' ? {...sanitizedEnvironment, THREADNOTE_DISK_PATH: path} : sanitizedEnvironment;
  return Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn({
          cmd: command,
          env: childEnvironment,
          killSignal: 'SIGKILL',
          maxBuffer: DISK_QUERY_OUTPUT_LIMIT_BYTES,
          stderr: 'ignore',
          stdin: 'ignore',
          stdout: 'pipe',
        }),
      catch: systemOperationError,
    }),
    child =>
      Effect.tryPromise({
        try: async () => {
          const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
          if (exitCode !== 0) return undefined;
          const text = output.trim();
          return platform === 'win32' ? parseWindowsAvailableDiskBytes(text) : parsePosixAvailableDiskBytes(text);
        },
        catch: systemOperationError,
      }),
    child =>
      Effect.sync(() => {
        if (child.exitCode !== null) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // The process may exit while its finalizer runs.
        }
      }),
  );
}

/** @internal Re-invoke either the compiled binary or current source entrypoint. */
export function windowsDiskCapacityWorkerInvocation(
  executablePath: string,
  processArguments: readonly string[],
  developmentEntrypoint: string,
): {readonly arguments: readonly string[]; readonly executable: string} {
  const executableName = executablePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  if (executableName !== 'bun' && executableName !== 'bun.exe') {
    return {arguments: [WINDOWS_DISK_CAPACITY_WORKER_ARGUMENT], executable: executablePath};
  }
  const currentScript = processArguments[1];
  const standaloneScript =
    currentScript && /(?:^|[/\\])(?:standalone\.(?:js|ts)|threadnote\.cjs)$/iu.test(currentScript)
      ? currentScript
      : developmentEntrypoint;
  return {
    arguments: [standaloneScript, WINDOWS_DISK_CAPACITY_WORKER_ARGUMENT],
    executable: executablePath,
  };
}

export interface WindowsDiskCapacityWorkerProcess {
  readonly closeInput: () => Promise<void>;
  readonly exited: Promise<number>;
  readonly kill: () => void;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly write: (line: string) => Promise<void>;
}

export interface WindowsDiskCapacityWorkerSpawnOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly invocation: {readonly arguments: readonly string[]; readonly executable: string};
}

export interface PersistentWindowsDiskCapacityOptions {
  readonly developmentEntrypoint: string;
  readonly invocation?: {readonly arguments: readonly string[]; readonly executable: string};
  readonly sanitizeExternal: ChildEnvironmentPolicyShape['sanitizeExternal'];
  readonly spawnWorker?: (
    options: WindowsDiskCapacityWorkerSpawnOptions,
  ) => Promise<WindowsDiskCapacityWorkerProcess> | WindowsDiskCapacityWorkerProcess;
}

interface WindowsDiskCapacityWorkerResponse {
  readonly availableBytes: number | null;
  readonly id: string;
  readonly protocol: typeof WINDOWS_DISK_CAPACITY_WORKER_PROTOCOL_VERSION;
}

interface WindowsDiskCapacityPendingResponse {
  readonly id: string;
  readonly reject: (cause: SystemOperationError) => void;
  readonly resolve: (availableBytes: number | undefined) => void;
}

function decodeWindowsDiskCapacityWorkerResponse(line: string): WindowsDiskCapacityWorkerResponse | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('availableBytes' in value) ||
      !('id' in value) ||
      !('protocol' in value) ||
      (value.availableBytes !== null &&
        (typeof value.availableBytes !== 'number' ||
          !Number.isSafeInteger(value.availableBytes) ||
          value.availableBytes < 0)) ||
      typeof value.id !== 'string' ||
      !/^[1-9][0-9]{0,31}$/u.test(value.id) ||
      value.protocol !== WINDOWS_DISK_CAPACITY_WORKER_PROTOCOL_VERSION
    ) {
      return undefined;
    }
    return {
      availableBytes: value.availableBytes,
      id: value.id,
      protocol: WINDOWS_DISK_CAPACITY_WORKER_PROTOCOL_VERSION,
    };
  } catch {
    return undefined;
  }
}

class WindowsDiskCapacityWorkerConnection {
  private closed = false;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private pending: WindowsDiskCapacityPendingResponse | undefined;
  private stdoutBuffer = '';
  private stdoutBufferBytes = 0;

  constructor(private readonly process: WindowsDiskCapacityWorkerProcess) {
    void this.consumeStdout();
    void process.exited.then(
      () => this.fail('Windows disk capacity worker exited.'),
      () => this.fail('Windows disk capacity worker exit could not be observed.'),
    );
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.rejectPending('Windows disk capacity worker closed.');
    }
    const closedGracefully = await promiseCompletesBeforeDeadline(
      Promise.resolve()
        .then(() => this.process.closeInput())
        .then(() => this.process.exited),
      WINDOWS_DISK_CAPACITY_WORKER_SHUTDOWN_TIMEOUT_MS,
    );
    if (!closedGracefully) this.kill();
  }

  async request(
    path: string,
    id: string,
    timeoutMilliseconds: number,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    if (this.closed) throw SystemOperationError.make({message: 'Windows disk capacity worker is closed.'});
    if (this.pending !== undefined)
      throw SystemOperationError.make({message: 'Windows disk capacity worker request overlapped.'});
    if (signal.aborted) {
      this.fail('Windows disk capacity worker request was interrupted.');
      throw SystemOperationError.make({message: 'Windows disk capacity worker request was interrupted.'});
    }

    let removeAbortListener = () => {};
    const {promise: response, reject, resolve} = Promise.withResolvers<number | undefined>();
    this.pending = {
      id,
      reject,
      resolve,
    };
    const timeout = setTimeout(
      () => this.fail('Windows disk capacity worker request timed out.'),
      Math.max(1, Math.floor(timeoutMilliseconds)),
    );
    timeout.unref?.();
    const onAbort = () => this.fail('Windows disk capacity worker request was interrupted.');
    signal.addEventListener('abort', onAbort, {once: true});
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    const request = JSON.stringify({
      id,
      path,
      protocol: WINDOWS_DISK_CAPACITY_WORKER_PROTOCOL_VERSION,
    });
    void Promise.resolve(this.process.write(`${request}\n`)).catch(() => {
      this.fail('Could not write Windows disk capacity worker request.');
    });
    return response.finally(() => {
      clearTimeout(timeout);
      removeAbortListener();
    });
  }

  private async consumeStdout(): Promise<void> {
    try {
      for await (const chunk of this.process.stdout) {
        this.stdoutBuffer += this.decoder.decode(chunk, {stream: true});
        this.stdoutBufferBytes += chunk.byteLength;
        if (this.stdoutBufferBytes > WINDOWS_DISK_CAPACITY_WORKER_RESPONSE_LIMIT_BYTES) {
          this.fail('Windows disk capacity worker response exceeded its limit.');
          return;
        }
        this.consumeStdoutLines();
        if (this.closed) return;
        this.stdoutBufferBytes = this.encoder.encode(this.stdoutBuffer).byteLength;
      }
      this.stdoutBuffer += this.decoder.decode();
      this.consumeStdoutLines();
      if (this.stdoutBuffer.trim()) this.fail('Windows disk capacity worker returned an incomplete response.');
      else this.fail('Windows disk capacity worker exited.');
    } catch {
      this.fail('Could not read Windows disk capacity worker response.');
    }
  }

  private consumeStdoutLines(): void {
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const pending = this.pending;
      const response = decodeWindowsDiskCapacityWorkerResponse(line);
      if (pending === undefined || response === undefined || response.id !== pending.id) {
        this.fail('Windows disk capacity worker returned an invalid response.');
        return;
      }
      this.pending = undefined;
      pending.resolve(response.availableBytes ?? undefined);
    }
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(message);
    this.kill();
  }

  private kill(): void {
    try {
      this.process.kill();
    } catch {
      // The worker may exit while the parent handles its response.
    }
  }

  private rejectPending(message: string): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    pending.reject(SystemOperationError.make({message: message}));
  }
}

class WindowsDiskCapacityWorkerPool {
  private closed = false;
  private connection: WindowsDiskCapacityWorkerConnection | undefined;
  private sequence = 0;

  constructor(
    private readonly invocation: {readonly arguments: readonly string[]; readonly executable: string},
    private readonly spawnWorker: (
      options: WindowsDiskCapacityWorkerSpawnOptions,
    ) => Promise<WindowsDiskCapacityWorkerProcess> | WindowsDiskCapacityWorkerProcess,
  ) {}

  async close(): Promise<void> {
    this.closed = true;
    const connection = this.connection;
    this.connection = undefined;
    await connection?.close();
  }

  async request(
    path: string,
    environment: NodeJS.ProcessEnv,
    timeoutMilliseconds: number,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    if (this.closed) throw SystemOperationError.make({message: 'Windows disk capacity worker pool is closed.'});
    let connection: WindowsDiskCapacityWorkerConnection | undefined;
    try {
      connection = await this.activeConnection(environment);
      const id = String(++this.sequence);
      return await connection.request(path, id, timeoutMilliseconds, signal);
    } catch (cause: unknown) {
      if (connection !== undefined) await this.discard(connection);
      throw systemOperationError(cause);
    }
  }

  private async activeConnection(environment: NodeJS.ProcessEnv): Promise<WindowsDiskCapacityWorkerConnection> {
    if (this.closed) throw SystemOperationError.make({message: 'Windows disk capacity worker pool is closed.'});
    if (this.connection !== undefined && !this.connection.isClosed) return this.connection;
    const process = await this.spawnWorker({environment, invocation: this.invocation});
    const connection = new WindowsDiskCapacityWorkerConnection(process);
    if (this.closed) {
      await connection.close();
      throw SystemOperationError.make({message: 'Windows disk capacity worker pool closed while starting.'});
    }
    this.connection = connection;
    return connection;
  }

  private async discard(connection: WindowsDiskCapacityWorkerConnection): Promise<void> {
    if (this.connection === connection) this.connection = undefined;
    await connection.close();
  }
}

/** One killable worker process, with one fresh kernel observation per request. */
export function makePersistentWindowsAvailableDiskBytes(options: PersistentWindowsDiskCapacityOptions) {
  const invocation =
    options.invocation ??
    windowsDiskCapacityWorkerInvocation(process.execPath, process.argv, options.developmentEntrypoint);
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(1);
      const pool = new WindowsDiskCapacityWorkerPool(
        invocation,
        options.spawnWorker ?? (input => spawnWindowsDiskCapacityWorker(input, options.sanitizeExternal)),
      );
      return {permits, pool};
    }),
    ({pool}) => Effect.promise(() => pool.close()),
  ).pipe(
    Effect.map(
      ({permits, pool}) =>
        (path: string, environment: NodeJS.ProcessEnv, timeoutMilliseconds = DISK_QUERY_TIMEOUT_MS / 2) =>
          permits.withPermit(
            Effect.tryPromise({
              try: signal => pool.request(path, environment, timeoutMilliseconds, signal),
              catch: systemOperationError,
            }),
          ),
    ),
  );
}

function spawnWindowsDiskCapacityWorker(
  options: WindowsDiskCapacityWorkerSpawnOptions,
  sanitizeExternal: ChildEnvironmentPolicyShape['sanitizeExternal'],
): WindowsDiskCapacityWorkerProcess {
  const child = Bun.spawn({
    cmd: [options.invocation.executable, ...options.invocation.arguments],
    env: sanitizeExternal(options.environment),
    killSignal: 'SIGKILL',
    stderr: 'ignore',
    stdin: 'pipe',
    stdout: 'pipe',
  });
  const input = child.stdin;
  return {
    closeInput: async () => {
      await input.end();
    },
    exited: child.exited,
    kill: () => child.kill('SIGKILL'),
    stdout: child.stdout,
    write: async line => {
      await input.write(line);
      await input.flush();
    },
  };
}

function promiseCompletesBeforeDeadline(promise: Promise<unknown>, timeoutMilliseconds: number): Promise<boolean> {
  const {promise: result, resolve} = Promise.withResolvers<boolean>();
  let settled = false;
  const finish = (completed: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve(completed);
  };
  const timeout = setTimeout(() => finish(false), timeoutMilliseconds);
  timeout.unref?.();
  void promise.then(
    () => finish(true),
    () => finish(false),
  );
  return result;
}

function isNativeStatfsUnavailable(cause: unknown): boolean {
  const underlying = Schema.is(SystemOperationError)(cause) ? cause.cause : cause;
  if (underlying instanceof NativeStatfsUnavailableError) return true;
  if (typeof underlying !== 'object' || underlying === null || !('code' in underlying)) return false;
  const code = (underlying as {readonly code?: unknown}).code;
  return typeof code === 'string' && NATIVE_STATFS_UNAVAILABLE_CODES.has(code);
}

function nonNegativeIntegerBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value >= 0n ? value : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
}

function positiveIntegerBigInt(value: unknown): bigint | undefined {
  const integer = nonNegativeIntegerBigInt(value);
  return integer !== undefined && integer > 0n ? integer : undefined;
}

export function parsePosixAvailableDiskBytes(output: string): number | undefined {
  const lastLine = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!lastLine) return undefined;
  const fields = lastLine.trim().split(/\s+/);
  const availableKibibytes = Number(fields.at(-3));
  return Number.isSafeInteger(availableKibibytes) && availableKibibytes >= 0
    ? availableKibibytes * KIBIBYTE_BYTES
    : undefined;
}

export function parseWindowsAvailableDiskBytes(output: string): number | undefined {
  const bytes = Number(output.trim());
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

export function parseLinuxHardwareInfo(
  cpuInfo: string,
  memoryInfo: string,
  architecture: string,
): Pick<SystemHardwareInfo, 'cpuModel' | 'memoryBytes'> {
  const cpuModel = /^(?:model name|Hardware)[\t ]*:[\t ]*(\S[^\r\n]*)/m.exec(cpuInfo)?.[1]?.trim();
  const memoryKibibytes = Number(/^MemTotal:[\t ]+(\d+)[\t ]+kB[\t ]*\r?$/m.exec(memoryInfo)?.[1]);
  const memoryBytes = memoryKibibytes * KIBIBYTE_BYTES;
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) {
    throw SystemOperationError.make({message: 'Linux memory metadata is invalid.'});
  }
  return {cpuModel: cpuModel ?? `unknown (${architecture})`, memoryBytes};
}

function readSystemHardwareInfo(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  sanitizeExternal: ChildEnvironmentPolicyShape['sanitizeExternal'],
) {
  if (platform === 'linux') {
    return Effect.tryPromise({
      try: async () => {
        const [cpuInfo, memoryInfo] = await Promise.all([
          Bun.file('/proc/cpuinfo').text(),
          Bun.file('/proc/meminfo').text(),
        ]);
        const {cpuModel, memoryBytes} = parseLinuxHardwareInfo(cpuInfo, memoryInfo, runtimeArchitecture);
        const effectiveMemoryBytes = await readLinuxEffectiveMemoryBytes(memoryBytes);
        const operatingSystem = spawnText(['uname', '-sr'], environment, sanitizeExternal);
        return {cpuModel, effectiveMemoryBytes, memoryBytes, operatingSystem};
      },
      catch: cause => SystemOperationError.make({cause, message: 'Could not read Linux hardware metadata.'}),
    });
  }
  if (platform === 'darwin') {
    return Effect.try({
      try: () => {
        const cpuModel = spawnText(['sysctl', '-n', 'machdep.cpu.brand_string'], environment, sanitizeExternal);
        const memoryBytes = Number(spawnText(['sysctl', '-n', 'hw.memsize'], environment, sanitizeExternal));
        const version = spawnText(['sw_vers', '-productVersion'], environment, sanitizeExternal);
        if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) {
          throw SystemOperationError.make({message: 'macOS memory metadata is invalid.'});
        }
        return {cpuModel, effectiveMemoryBytes: memoryBytes, memoryBytes, operatingSystem: `macOS ${version}`};
      },
      catch: cause => SystemOperationError.make({cause, message: 'Could not read macOS hardware metadata.'}),
    });
  }
  if (platform === 'win32') {
    return readWindowsHardwareInfo(environment);
  }
  return Effect.fail(SystemOperationError.make({message: `Hardware metadata is not supported on ${platform}.`}));
}

async function readLinuxEffectiveMemoryBytes(physicalMemoryBytes: number): Promise<number> {
  const [processCgroup, processMountInfo] = await Promise.all([
    readOptionalBunFile('/proc/self/cgroup'),
    readOptionalBunFile('/proc/self/mountinfo'),
  ]);
  if (processCgroup === undefined || processMountInfo === undefined) return physicalMemoryBytes;
  const files = linuxCgroupMemoryFiles(processCgroup, processMountInfo);
  const limits = await Promise.all(files.map(file => readOptionalBunFile(file.path)));
  return effectiveLinuxMemoryBytes(physicalMemoryBytes, limits);
}

async function readOptionalBunFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch {
    return undefined;
  }
}

function spawnText(
  command: readonly string[],
  environment: NodeJS.ProcessEnv,
  sanitizeExternal: ChildEnvironmentPolicyShape['sanitizeExternal'],
): string {
  const result = Bun.spawnSync({
    cmd: [...command],
    env: sanitizeExternal(environment),
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: DISK_QUERY_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw SystemOperationError.make({
      message: `${command[0]} exited with ${result.exitCode}: ${result.stderr.toString().trim()}`,
    });
  }
  const output = result.stdout.toString().trim();
  if (!output) throw SystemOperationError.make({message: `${command[0]} returned no hardware metadata.`});
  return output;
}

/** @internal Exported for real-process deadline and cancellation regressions. */
export function readProcessStartIdentity(
  processId: number,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  sanitizeExternal: ChildEnvironmentPolicyShape['sanitizeExternal'],
  timeoutMilliseconds = PROCESS_IDENTITY_QUERY_TIMEOUT_MS,
  darwinProcessCommand = '/bin/ps',
): Effect.Effect<string | undefined> {
  if (!Number.isSafeInteger(processId) || processId <= 0) return succeedUndefined;
  if (platform === 'linux') {
    return Effect.tryPromise({
      try: () => Bun.file(`/proc/${processId}/stat`).text(),
      catch: () => undefined,
    }).pipe(
      Effect.map(parseLinuxProcessStartIdentity),
      Effect.orElseSucceed(() => undefined),
    );
  }
  if (platform === 'win32') {
    return probeWindowsProcessStartIdentity(
      processId,
      environment,
      {
        fallback: (candidate, candidateEnvironment) =>
          readWindowsProcessStartIdentityFallback(
            candidate,
            candidateEnvironment,
            sanitizeExternal,
            timeoutMilliseconds,
          ),
        native: readWindowsProcessStartIdentity,
      },
      timeoutMilliseconds,
    );
  }
  if (platform !== 'darwin') return succeedUndefined;
  return readDarwinProcessStartIdentity(
    processId,
    environment,
    sanitizeExternal,
    timeoutMilliseconds,
    darwinProcessCommand,
    output => parseProcessStartIdentityOutput('darwin', output),
  );
}

/** @internal Exported for the canonical channel's real-process regressions. */
export function readCanonicalProcessStartIdentity(
  processId: number,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  sanitizeExternal: ChildEnvironmentPolicyShape['sanitizeExternal'],
  timeoutMilliseconds = PROCESS_IDENTITY_QUERY_TIMEOUT_MS,
  darwinProcessCommand = '/bin/ps',
): Effect.Effect<string | undefined> {
  if (platform !== 'darwin') {
    return readProcessStartIdentity(
      processId,
      platform,
      environment,
      sanitizeExternal,
      timeoutMilliseconds,
      darwinProcessCommand,
    );
  }
  if (!Number.isSafeInteger(processId) || processId <= 0) return succeedUndefined;
  return readDarwinProcessStartIdentity(
    processId,
    {...environment, LANG: 'C', LC_ALL: 'C', TZ: 'UTC'},
    sanitizeExternal,
    timeoutMilliseconds,
    darwinProcessCommand,
    output => parseCanonicalProcessStartIdentityOutput('darwin', output),
  );
}

function readDarwinProcessStartIdentity(
  processId: number,
  environment: NodeJS.ProcessEnv,
  sanitizeExternal: ChildEnvironmentPolicyShape['sanitizeExternal'],
  timeoutMilliseconds: number,
  command: string,
  parseOutput: (output: string) => string | undefined,
): Effect.Effect<string | undefined> {
  return readProcessStartIdentityCommand(
    [command, '-o', 'lstart=', '-p', String(processId)],
    environment,
    sanitizeExternal,
    timeoutMilliseconds,
    parseOutput,
  );
}

export function probeWindowsProcessStartIdentity(
  processId: number,
  environment: NodeJS.ProcessEnv,
  adapters: WindowsProcessStartIdentityProbeAdapters,
  timeoutMilliseconds = PROCESS_IDENTITY_QUERY_TIMEOUT_MS,
): Effect.Effect<string | undefined> {
  return adapters.native(processId).pipe(
    Effect.filterOrElse(
      (identity): identity is string => identity !== undefined,
      () => adapters.fallback(processId, environment),
    ),
    Effect.timeoutOrElse({duration: timeoutMilliseconds, orElse: () => succeedUndefined}),
    Effect.orElseSucceed(() => undefined),
  );
}

function readWindowsProcessStartIdentityFallback(
  processId: number,
  environment: NodeJS.ProcessEnv,
  sanitizeExternal: ChildEnvironmentPolicyShape['sanitizeExternal'],
  timeoutMilliseconds: number,
): Effect.Effect<string | undefined> {
  return readProcessStartIdentityCommand(
    [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$process=Get-Process -Id $env:THREADNOTE_PROCESS_ID -ErrorAction SilentlyContinue; ' +
        'if (-not $process) { exit 3 }; ' +
        '[Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)',
    ],
    {...environment, THREADNOTE_PROCESS_ID: String(processId)},
    sanitizeExternal,
    timeoutMilliseconds,
    output => parseCanonicalProcessStartIdentityOutput('win32', output),
  );
}

function readProcessStartIdentityCommand(
  command: readonly string[],
  environment: NodeJS.ProcessEnv,
  sanitizeExternal: ChildEnvironmentPolicyShape['sanitizeExternal'],
  timeoutMilliseconds: number,
  parseOutput: (output: string) => string | undefined,
): Effect.Effect<string | undefined> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn({
          cmd: [...command],
          env: sanitizeExternal(environment),
          killSignal: 'SIGKILL',
          maxBuffer: PROCESS_IDENTITY_QUERY_OUTPUT_LIMIT_BYTES,
          stderr: 'ignore',
          stdin: 'ignore',
          stdout: 'pipe',
        }),
      catch: systemOperationError,
    }),
    child =>
      Effect.tryPromise({
        try: async () => {
          const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
          return exitCode === 0 ? parseOutput(output) : undefined;
        },
        catch: systemOperationError,
      }),
    child =>
      Effect.sync(() => {
        if (child.exitCode !== null) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // The process may exit while its finalizer runs.
        }
      }),
  ).pipe(
    Effect.timeoutOrElse({duration: timeoutMilliseconds, orElse: () => succeedUndefined}),
    Effect.orElseSucceed(() => undefined),
  );
}

export function parseLinuxProcessStartIdentity(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return undefined;
  const fieldsAfterCommand = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startClockTick = fieldsAfterCommand[19];
  return startClockTick && /^[0-9]+$/.test(startClockTick) ? `linux:${startClockTick}` : undefined;
}

export function parseProcessStartIdentityOutput(platform: NodeJS.Platform, output: string): string | undefined {
  if (platform !== 'darwin' && platform !== 'win32') return undefined;
  const identity = output.trim();
  return identity ? `${platform}:${identity}` : undefined;
}

export function parseCanonicalProcessStartIdentityOutput(
  platform: NodeJS.Platform,
  output: string,
): string | undefined {
  if (platform === 'darwin') {
    const identity = DARWIN_PROCESS_START_OUTPUT_PATTERN.exec(output)?.[1];
    return identity ? `darwin-v2:${identity}` : undefined;
  }
  if (platform === 'win32') {
    const identity = WINDOWS_PROCESS_START_OUTPUT_PATTERN.exec(output)?.[1];
    return identity ? `win32:${identity}` : undefined;
  }
  return undefined;
}

export function resolveHomeDirectory(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = nonEmptyEnvironmentValue(environment.HOME);
  const userProfile = nonEmptyEnvironmentValue(environment.USERPROFILE);
  const homeDrive = nonEmptyEnvironmentValue(environment.HOMEDRIVE);
  const homePath = nonEmptyEnvironmentValue(environment.HOMEPATH);
  const windowsHome = userProfile ?? (homeDrive && homePath ? `${homeDrive}${homePath}` : undefined);
  const resolved = platform === 'win32' ? (windowsHome ?? home) : (home ?? windowsHome);
  if (!resolved) {
    throw SystemOperationError.make({
      message: 'Could not determine the current user home directory from the environment.',
    });
  }
  return resolved;
}

function nonEmptyEnvironmentValue(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
