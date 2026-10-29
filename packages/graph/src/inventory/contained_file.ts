import {Effect, FileSystem, Option, Path} from 'effect';
import {fromPromise} from '@threadnote/platform/errors';
import {
  runtimeFileDescriptorStatSync,
  runtimeLstat,
  SystemInfo,
  type RuntimeBigIntStats,
  type RuntimeNativeFileStat,
} from '@threadnote/platform/system';
import {createCodeGraphCommittedFileContentHasher} from '../content_identity.js';
import {decodeUtf8} from './content.js';
import {CodeGraphInventoryError} from './error.js';
import type {RepositoryIdentity} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const readOptionalText = Effect.fn('codeGraph.readOptionalText')(function* (
  fs: FileSystem.FileSystem,
  target: string,
) {
  const opened = yield* readStableRegularFile(fs, target).pipe(Effect.option);
  return opened._tag === 'Some' ? (decodeUtf8(opened.value.bytes) ?? '') : '';
});

interface StableRegularFile {
  readonly bytes: Uint8Array;
  readonly identity: FileSystem.File.Info;
  readonly nativeIdentity: RuntimeBigIntStats;
  readonly openedPath: Option.Option<string>;
}

export interface ContainedReadInterlock {
  readonly afterOpen?: Effect.Effect<void>;
  readonly beforeOpen?: Effect.Effect<void>;
}

function readStableRegularFile(
  fs: FileSystem.FileSystem,
  target: string,
  interlock?: ContainedReadInterlock,
  maximumBytes?: number,
): Effect.Effect<StableRegularFile, Error, SystemInfo> {
  return Effect.gen(function* () {
    const linkTarget = yield* fs.readLink(target).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isSome(linkTarget)) {
      return yield* CodeGraphInventoryError.make({message: `Refusing to read a symbolic repository file: ${target}`});
    }
    const pathInfoBefore = yield* fs.stat(target);
    const nativePathBefore = yield* nativePathInfo(target);
    if (pathInfoBefore.type !== 'File' || (maximumBytes !== undefined && pathInfoBefore.size > BigInt(maximumBytes))) {
      return yield* CodeGraphInventoryError.make({
        message: `Refusing to read a non-regular or oversized repository file: ${target}`,
      });
    }
    yield* interlock?.beforeOpen ?? Effect.void;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(target, {flag: 'r'});
        yield* interlock?.afterOpen ?? Effect.void;
        const openedInfoBefore = yield* file.stat;
        const nativeOpenedBefore = yield* nativeOpenedFileInfo(file);
        const openedPath = yield* openedFilePath(fs, file);
        const pathInfoOpened = yield* fs.stat(target);
        const nativePathOpened = yield* nativePathInfo(target);
        if (
          !sameRegularFile(pathInfoBefore, pathInfoOpened, openedInfoBefore) ||
          !sameNativeRegularFile(nativePathBefore, nativePathOpened) ||
          !sameNativeRegularFile(nativePathBefore, nativeOpenedBefore)
        ) {
          return yield* CodeGraphInventoryError.make({
            message: `Repository file changed while it was opened: ${target}`,
          });
        }
        const byteLength = Number(openedInfoBefore.size);
        if (
          !Number.isSafeInteger(byteLength) ||
          byteLength < 0 ||
          (maximumBytes !== undefined && byteLength > maximumBytes)
        ) {
          return yield* CodeGraphInventoryError.make({
            message: `Repository file size cannot be represented safely: ${target}`,
          });
        }
        const bytes = new Uint8Array(byteLength + 1);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const read = Number(yield* file.read(bytes.subarray(offset)));
          if (read === 0) break;
          if (!Number.isSafeInteger(read) || read < 0 || read > bytes.byteLength - offset)
            return yield* CodeGraphInventoryError.make({
              message: `Repository file returned an invalid read: ${target}`,
            });
          offset += read;
        }
        const openedInfoAfter = yield* file.stat;
        const nativeOpenedAfter = yield* nativeOpenedFileInfo(file);
        const linkTargetAfter = yield* fs.readLink(target).pipe(
          Effect.asSome,
          Effect.orElseSucceed(() => Option.none<string>()),
        );
        if (Option.isSome(linkTargetAfter)) {
          return yield* CodeGraphInventoryError.make({
            message: `Repository file became a symbolic link while reading: ${target}`,
          });
        }
        const pathInfoAfter = yield* fs.stat(target);
        const nativePathAfter = yield* nativePathInfo(target);
        if (
          !sameRegularFile(pathInfoBefore, pathInfoAfter, openedInfoAfter) ||
          !sameRegularFile(pathInfoBefore, openedInfoBefore, openedInfoAfter) ||
          !sameNativeRegularFile(nativePathBefore, nativePathAfter) ||
          !sameNativeRegularFile(nativePathBefore, nativeOpenedAfter) ||
          openedInfoBefore.size !== openedInfoAfter.size ||
          offset !== byteLength
        ) {
          return yield* CodeGraphInventoryError.make({
            message: `Repository file changed while it was being read: ${target}`,
          });
        }
        return {
          bytes: bytes.slice(0, offset),
          identity: openedInfoAfter,
          nativeIdentity: nativeOpenedAfter,
          openedPath,
        };
      }),
    );
  }).pipe(
    Effect.mapError(cause =>
      CodeGraphInventoryError.make({message: `Could not safely read repository file ${target}.`, cause}),
    ),
  );
}

export function readContainedStableRegularFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
  interlock?: ContainedReadInterlock,
): Effect.Effect<Uint8Array, Error, SystemInfo> {
  return readContainedStableRegularFileInternal(fs, path, repositoryRoot, relative, interlock);
}

export function readBoundedContainedStableRegularFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
  maximumBytes: number,
  interlock?: ContainedReadInterlock,
): Effect.Effect<Uint8Array, Error, SystemInfo> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes >= Number.MAX_SAFE_INTEGER)
    return CodeGraphInventoryError.make({message: 'Contained repository read bound is invalid.'});
  return readContainedStableRegularFileInternal(fs, path, repositoryRoot, relative, interlock, maximumBytes);
}

function readContainedStableRegularFileInternal(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
  interlock?: ContainedReadInterlock,
  maximumBytes?: number,
): Effect.Effect<Uint8Array, Error, SystemInfo> {
  const target = path.join(repositoryRoot, ...Effect2.pipe(relative, EffectString.split('/')));
  return Effect.gen(function* () {
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalBefore = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalBefore)) {
      return yield* CodeGraphInventoryError.make({message: `Repository file resolves outside its root: ${relative}`});
    }
    const opened = yield* readStableRegularFile(fs, target, interlock, maximumBytes);
    if (Option.isSome(opened.openedPath) && !isContainedPath(path, repositoryRoot, opened.openedPath.value)) {
      return yield* CodeGraphInventoryError.make({message: `Opened repository file is outside its root: ${relative}`});
    }
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalAfter = yield* fs.realPath(target);
    const finalInfo = yield* fs.stat(target);
    const nativeFinalInfo = yield* nativePathInfo(target);
    if (!isContainedPath(path, repositoryRoot, canonicalAfter)) {
      return yield* CodeGraphInventoryError.make({
        message: `Repository file escaped its root while reading: ${relative}`,
      });
    }
    if (
      !sameRegularFile(opened.identity, finalInfo, opened.identity) ||
      !sameNativeRegularFile(opened.nativeIdentity, nativeFinalInfo)
    ) {
      return yield* CodeGraphInventoryError.make({
        message: `Repository path no longer identifies the opened file: ${relative}`,
      });
    }
    return opened.bytes;
  }).pipe(
    Effect.mapError(cause =>
      CodeGraphInventoryError.make({message: `Could not safely read repository path ${relative}.`, cause}),
    ),
  );
}

interface StableContainedMaterialization {
  readonly bytes?: Uint8Array;
  readonly codeGraphContentHash?: string;
  readonly contentHash: string;
  readonly size: number;
}

export interface StableContainedRegularFileMetadata {
  readonly size: number;
}

/**
 * Inspect only stable, contained path metadata. Admission depends on path and
 * size, so excluded dirty files never need to be opened, read, or hashed.
 */
export function inspectContainedStableRegularFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
): Effect.Effect<StableContainedRegularFileMetadata, Error, SystemInfo> {
  const target = path.join(repositoryRoot, ...Effect2.pipe(relative, EffectString.split('/')));
  return Effect.gen(function* () {
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalBefore = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalBefore)) {
      return yield* CodeGraphInventoryError.make({message: `Repository file resolves outside its root: ${relative}`});
    }
    const linkBefore = yield* fs.readLink(target).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isSome(linkBefore)) {
      return yield* CodeGraphInventoryError.make({
        message: `Refusing to inspect a symbolic repository file: ${relative}`,
      });
    }
    const infoBefore = yield* fs.stat(target);
    const size = Number(infoBefore.size);
    if (infoBefore.type !== 'File' || !Number.isSafeInteger(size) || size < 0) {
      return yield* CodeGraphInventoryError.make({
        message: `Repository file metadata is not safely representable: ${relative}`,
      });
    }
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalAfter = yield* fs.realPath(target);
    const linkAfter = yield* fs.readLink(target).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const infoAfter = yield* fs.stat(target);
    if (
      Option.isSome(linkAfter) ||
      !isContainedPath(path, repositoryRoot, canonicalAfter) ||
      !sameRegularFile(infoBefore, infoAfter, infoBefore) ||
      infoBefore.size !== infoAfter.size
    ) {
      return yield* CodeGraphInventoryError.make({
        message: `Repository file changed while its metadata was inspected: ${relative}`,
      });
    }
    return {size};
  }).pipe(
    Effect.mapError(cause =>
      CodeGraphInventoryError.make({message: `Could not safely inspect repository path ${relative}.`, cause}),
    ),
  );
}

/**
 * Safely materialize a worktree file, or hash it through a fixed-size buffer when
 * policy says its content should remain metadata-only. This keeps dirty large
 * corpus artifacts from allocating their full size while preserving an exact
 * content fingerprint and the same symlink/race interlocks as ordinary reads.
 */
export function materializeContainedStableRegularFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
  omitContent: (size: number) => boolean,
  expectedSize?: number,
  objectFormat?: RepositoryIdentity['objectFormat'],
): Effect.Effect<StableContainedMaterialization, Error, SystemInfo> {
  const target = path.join(repositoryRoot, ...Effect2.pipe(relative, EffectString.split('/')));
  return Effect.gen(function* () {
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalBefore = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalBefore)) {
      return yield* CodeGraphInventoryError.make({message: `Repository file resolves outside its root: ${relative}`});
    }
    const linkTarget = yield* fs.readLink(target).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isSome(linkTarget)) {
      return yield* CodeGraphInventoryError.make({message: `Refusing to read a symbolic repository file: ${relative}`});
    }
    const pathInfoBefore = yield* fs.stat(target);
    if (pathInfoBefore.type !== 'File') {
      return yield* CodeGraphInventoryError.make({
        message: `Refusing to read a non-regular repository file: ${relative}`,
      });
    }
    const materialized = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(target, {flag: 'r'});
        const openedInfoBefore = yield* file.stat;
        const openedPath = yield* openedFilePath(fs, file);
        const pathInfoOpened = yield* fs.stat(target);
        if (!sameRegularFile(pathInfoBefore, pathInfoOpened, openedInfoBefore)) {
          return yield* CodeGraphInventoryError.make({
            message: `Repository file changed while it was opened: ${relative}`,
          });
        }
        if (Option.isSome(openedPath) && !isContainedPath(path, repositoryRoot, openedPath.value)) {
          return yield* CodeGraphInventoryError.make({
            message: `Opened repository file is outside its root: ${relative}`,
          });
        }
        const size = Number(openedInfoBefore.size);
        if (!Number.isSafeInteger(size) || size < 0) {
          return yield* CodeGraphInventoryError.make({
            message: `Repository file size cannot be represented safely: ${relative}`,
          });
        }
        if (expectedSize !== undefined && size !== expectedSize) {
          return yield* CodeGraphInventoryError.make({
            message: `Repository file size changed before it was read: ${relative}`,
          });
        }
        const hasher = new Bun.CryptoHasher('sha256');
        const codeGraphHasher =
          objectFormat === undefined ? undefined : createCodeGraphCommittedFileContentHasher(objectFormat, size);
        const bytes = omitContent(size) ? undefined : new Uint8Array(size);
        const buffer = bytes ?? new Uint8Array(Math.min(1_048_576, Math.max(1, size)));
        let offset = 0;
        while (offset < size) {
          const view = bytes ? bytes.subarray(offset) : buffer.subarray(0, Math.min(buffer.byteLength, size - offset));
          const read = Number(yield* file.read(view));
          if (read <= 0) {
            return yield* CodeGraphInventoryError.make({
              message: `Repository file ended while it was being read: ${relative}`,
            });
          }
          hasher.update(view.subarray(0, read));
          codeGraphHasher?.update(view.subarray(0, read));
          offset += read;
        }
        const openedInfoAfter = yield* file.stat;
        const linkTargetAfter = yield* fs.readLink(target).pipe(
          Effect.asSome,
          Effect.orElseSucceed(() => Option.none<string>()),
        );
        const pathInfoAfter = yield* fs.stat(target);
        if (
          Option.isSome(linkTargetAfter) ||
          !sameRegularFile(pathInfoBefore, pathInfoAfter, openedInfoAfter) ||
          openedInfoBefore.size !== openedInfoAfter.size
        ) {
          return yield* CodeGraphInventoryError.make({
            message: `Repository file changed while it was being read: ${relative}`,
          });
        }
        return {
          bytes,
          ...(codeGraphHasher === undefined ? {} : {codeGraphContentHash: codeGraphHasher.digest()}),
          contentHash: hasher.digest('hex'),
          size,
        } satisfies StableContainedMaterialization;
      }),
    );
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalAfter = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalAfter)) {
      return yield* CodeGraphInventoryError.make({
        message: `Repository file escaped its root while reading: ${relative}`,
      });
    }
    return materialized;
  }).pipe(
    Effect.mapError(cause =>
      CodeGraphInventoryError.make({message: `Could not safely materialize repository path ${relative}.`, cause}),
    ),
  );
}

const validateRepositoryAncestors = Effect.fn('codeGraph.validateRepositoryAncestors')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
) {
  let current = repositoryRoot;
  for (const segment of Effect2.pipe(relative, EffectString.split('/')).slice(0, -1)) {
    current = path.join(current, segment);
    const link = yield* fs.readLink(current).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isSome(link)) {
      return yield* CodeGraphInventoryError.make({message: `Repository path has a symbolic ancestor: ${relative}`});
    }
    const canonical = yield* fs.realPath(current);
    const info = yield* fs.stat(current);
    if (info.type !== 'Directory' || !isContainedPath(path, repositoryRoot, canonical)) {
      return yield* CodeGraphInventoryError.make({message: `Repository path has an unsafe ancestor: ${relative}`});
    }
  }
});

function isContainedPath(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '..' && !Effect2.pipe(relative, EffectString.startsWith(`..${path.sep}`)) && !path.isAbsolute(relative)
  );
}

function sameRegularFile(
  before: FileSystem.File.Info,
  current: FileSystem.File.Info,
  opened: FileSystem.File.Info,
): boolean {
  const beforeInode = Option.getOrUndefined(before.ino);
  const currentInode = Option.getOrUndefined(current.ino);
  const openedInode = Option.getOrUndefined(opened.ino);
  const beforeModified = Option.getOrUndefined(before.mtime)?.getTime();
  const currentModified = Option.getOrUndefined(current.mtime)?.getTime();
  const openedModified = Option.getOrUndefined(opened.mtime)?.getTime();
  return (
    before.type === 'File' &&
    current.type === 'File' &&
    opened.type === 'File' &&
    before.dev === current.dev &&
    current.dev === opened.dev &&
    beforeInode !== undefined &&
    currentInode !== undefined &&
    openedInode !== undefined &&
    beforeInode === currentInode &&
    currentInode === openedInode &&
    before.mode === current.mode &&
    current.mode === opened.mode &&
    before.size === current.size &&
    current.size === opened.size &&
    beforeModified !== undefined &&
    currentModified !== undefined &&
    openedModified !== undefined &&
    beforeModified === currentModified &&
    currentModified === openedModified
  );
}

function nativePathInfo(target: string): Effect.Effect<RuntimeBigIntStats, CodeGraphInventoryError> {
  return fromPromise('codeGraph.inventory.lstat', () => runtimeLstat(target)).pipe(
    Effect.mapError(cause =>
      CodeGraphInventoryError.make({cause, message: `Could not inspect repository path: ${target}`}),
    ),
  );
}

function nativeOpenedFileInfo(file: FileSystem.File): Effect.Effect<RuntimeNativeFileStat, CodeGraphInventoryError> {
  const descriptor = fileDescriptor(file);
  if (descriptor === undefined)
    return CodeGraphInventoryError.make({message: 'Opened repository file descriptor is unavailable.'});
  return Effect.try({
    try: () => runtimeFileDescriptorStatSync(descriptor),
    catch: cause => CodeGraphInventoryError.make({cause, message: 'Could not inspect opened repository file.'}),
  });
}

function sameNativeRegularFile(left: RuntimeBigIntStats, right: RuntimeBigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev !== 0n &&
    right.dev !== 0n &&
    left.ino !== 0n &&
    right.ino !== 0n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function fileDescriptor(file: FileSystem.File): number | undefined {
  const descriptor = (file as FileSystem.File & {readonly fd?: unknown}).fd;
  return typeof descriptor === 'number' && Number.isSafeInteger(descriptor) && descriptor >= 0 ? descriptor : undefined;
}

function openedFilePath(
  fs: FileSystem.FileSystem,
  file: FileSystem.File,
): Effect.Effect<Option.Option<string>, never, SystemInfo> {
  const descriptor = fileDescriptor(file);
  if (descriptor === undefined) return Effect.succeedNone;
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const descriptorPath =
      system.platform === 'linux'
        ? `/proc/self/fd/${descriptor}`
        : system.platform === 'darwin'
          ? `/dev/fd/${descriptor}`
          : undefined;
    if (!descriptorPath) return Option.none<string>();
    const resolved = yield* fs.realPath(descriptorPath).pipe(Effect.option);
    return Option.isSome(resolved) && resolved.value !== descriptorPath
      ? Option.some(resolved.value)
      : Option.none<string>();
  });
}
