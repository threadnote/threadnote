import {Effect, FileSystem, Option, Path, Stream, Schema} from 'effect';
import {runtimeTextDirectoryNames} from './system.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

export interface SafeScannedFile {
  readonly modifiedAt?: Date;
  readonly path: string;
  readonly size: number;
}

export interface SafeFileScanOptions {
  readonly includeDirectory?: (path: string) => boolean;
  readonly includeFile: (path: string, name: string) => boolean;
  readonly recursive?: boolean;
}

const SAFE_SCAN_ENTRY_CONCURRENCY = 64;
const SAFE_SCAN_INSPECTION_PAGE_SIZE = 256;
const SAFE_SCAN_DIRECTORY_RECORD_BYTES_MAXIMUM = 1_048_576;

class SafeFileScanError extends Schema.TaggedError<SafeFileScanError, {readonly brand: unique symbol}>()(
  'SafeFileScanError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

/** Visit live-runtime files in bounded directory pages without retaining the corpus. */
export function forEachFileWithinBoundary<A, E, R>(
  fs: FileSystem.FileSystem,
  scanRoot: string,
  boundaryRoot: string,
  options: SafeFileScanOptions,
  visitFile: (file: SafeScannedFile) => Effect.Effect<A, E, R>,
  directoryNames: (path: string) => AsyncIterable<string> = runtimeTextDirectoryNames,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fsQueuePath = yield* fs.makeTempFileScoped({prefix: 'threadnote-safe-scan-', suffix: '.queue'});
      const directoryQueue = yield* fs.open(fsQueuePath, {flag: 'w+'});
      const encoder = new TextEncoder();
      const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
      let readOffset = 0;
      let writeOffset = 0;
      const enqueueDirectory = (directory: string) =>
        Effect.gen(function* () {
          const bytes = encoder.encode(directory);
          if (bytes.length === 0 || bytes.length > SAFE_SCAN_DIRECTORY_RECORD_BYTES_MAXIMUM) {
            return yield* SafeFileScanError.make({message: 'Safe scan directory path is invalid.'});
          }
          const header = new Uint8Array(4);
          new DataView(header.buffer).setUint32(0, bytes.length);
          yield* directoryQueue.seek(BigInt(writeOffset), 'start');
          yield* directoryQueue.writeAll(header);
          yield* directoryQueue.writeAll(bytes);
          writeOffset += header.length + bytes.length;
        });
      const dequeueDirectory = () =>
        Effect.gen(function* () {
          if (readOffset >= writeOffset) return undefined;
          yield* directoryQueue.seek(BigInt(readOffset), 'start');
          const header = yield* readFileBytesExactly(directoryQueue, 4);
          const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
          if (length === 0 || length > SAFE_SCAN_DIRECTORY_RECORD_BYTES_MAXIMUM) {
            return yield* SafeFileScanError.make({message: 'Safe scan directory queue is invalid.'});
          }
          const bytes = yield* readFileBytesExactly(directoryQueue, length);
          readOffset += header.length + bytes.length;
          return yield* Effect.try({
            try: () => decoder.decode(bytes),
            catch: cause => SafeFileScanError.make({cause, message: 'Safe scan directory queue is invalid.'}),
          });
        });
      const pathService = yield* Path.Path;
      const roots = yield* resolveScanRoots(fs, scanRoot, boundaryRoot);
      if (!roots) return;
      yield* enqueueDirectory(scanRoot);
      while (true) {
        const logicalDirectory = yield* dequeueDirectory();
        if (logicalDirectory === undefined) break;
        const inspectedDirectory = yield* inspectMappedPath(fs, logicalDirectory, roots);
        if (!inspectedDirectory || inspectedDirectory.type !== 'Directory') continue;
        const names = Stream.fromAsyncIterable(directoryNames(logicalDirectory), cause =>
          SafeFileScanError.make({cause, message: 'Safe scan directory enumeration failed.'}),
        ).pipe(Stream.grouped(SAFE_SCAN_INSPECTION_PAGE_SIZE));
        yield* Stream.runForEach(names, page =>
          Effect.gen(function* () {
            const entries = yield* Effect.forEach(
              page,
              name => {
                const path = pathService.join(logicalDirectory, name);
                return inspectMappedPath(fs, path, roots).pipe(Effect.map(inspected => ({inspected, name, path})));
              },
              {concurrency: SAFE_SCAN_ENTRY_CONCURRENCY},
            );
            for (const {inspected, name, path} of entries) {
              if (!inspected) continue;
              if (
                inspected.type === 'Directory' &&
                options.recursive !== false &&
                (options.includeDirectory?.(path) ?? true)
              ) {
                yield* enqueueDirectory(path);
              } else if (inspected.type === 'File' && options.includeFile(path, name)) {
                yield* visitFile({modifiedAt: inspected.modifiedAt, path, size: inspected.size});
              }
            }
          }),
        );
      }
    }),
  );
}

/**
 * Walks only real files and directories beneath a canonicalized boundary.
 * Every recursively discovered child is rejected if it is a symlink, so its
 * expected real path can be derived from the already-verified parent without
 * resolving the entire ancestor chain for every file. The visited set remains
 * a second guard against directory cycles.
 */
export const scanFilesWithinBoundary = Effect.fn('filesystem.scanFilesWithinBoundary')(function* (
  fs: FileSystem.FileSystem,
  scanRoot: string,
  boundaryRoot: string,
  options: SafeFileScanOptions,
) {
  const pathService = yield* Path.Path;
  const roots = yield* resolveScanRoots(fs, scanRoot, boundaryRoot);
  if (!roots) return [];
  const visitedRealDirectories = new Set<string>();
  const visit = (logicalDirectory: string): Effect.Effect<readonly SafeScannedFile[], never> =>
    Effect.gen(function* () {
      const inspectedDirectory = yield* inspectMappedPath(fs, logicalDirectory, roots);
      if (
        !inspectedDirectory ||
        inspectedDirectory.type !== 'Directory' ||
        visitedRealDirectories.has(inspectedDirectory.realPath)
      ) {
        return [];
      }
      visitedRealDirectories.add(inspectedDirectory.realPath);
      const files: SafeScannedFile[] = [];
      const names = yield* fs.readDirectory(logicalDirectory).pipe(Effect.orElseSucceed(() => []));
      const entries = yield* Effect.forEach(
        [...names].sort(),
        name => {
          const path = pathService.join(logicalDirectory, name);
          return inspectMappedPath(fs, path, roots).pipe(Effect.map(inspected => ({inspected, name, path})));
        },
        {concurrency: SAFE_SCAN_ENTRY_CONCURRENCY},
      );
      for (const {inspected, name, path} of entries) {
        if (!inspected) continue;
        if (
          inspected.type === 'Directory' &&
          options.recursive !== false &&
          (options.includeDirectory?.(path) ?? true)
        ) {
          files.push(...(yield* visit(path)));
        } else if (inspected.type === 'File' && options.includeFile(path, name)) {
          files.push({modifiedAt: inspected.modifiedAt, path, size: inspected.size});
        }
      }
      return files;
    });
  return yield* visit(scanRoot);
});

export const safeChildDirectoryNames = Effect.fn('filesystem.safeChildDirectoryNames')(function* (
  fs: FileSystem.FileSystem,
  root: string,
  boundaryRoot: string,
) {
  const pathService = yield* Path.Path;
  const roots = yield* resolveScanRoots(fs, root, boundaryRoot);
  if (!roots) {
    return [];
  }
  const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
  const entries = yield* Effect.forEach(
    [...names].sort(),
    name =>
      inspectMappedPath(fs, pathService.join(root, name), roots).pipe(Effect.map(inspected => ({inspected, name}))),
    {concurrency: SAFE_SCAN_ENTRY_CONCURRENCY},
  );
  return EffectArray.map(
    EffectArray.filter(entries, entry => entry.inspected?.type === 'Directory'),
    entry => entry.name,
  );
});

interface ScanRoots {
  readonly boundaryRoot: string;
  readonly pathService: Path.Path;
  readonly realBoundaryRoot: string;
}

interface InspectedMappedPath {
  readonly modifiedAt?: Date;
  readonly realPath: string;
  readonly size: number;
  readonly type: 'Directory' | 'File' | 'Other';
}

function resolveScanRoots(
  fs: FileSystem.FileSystem,
  scanRoot: string,
  boundaryRoot: string,
): Effect.Effect<ScanRoots | undefined, never, Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const realBoundaryRoot = yield* fs.realPath(boundaryRoot);
    const roots = {boundaryRoot: pathService.resolve(boundaryRoot), pathService, realBoundaryRoot};
    const inspectedRoot = yield* inspectMappedPath(fs, scanRoot, roots);
    return inspectedRoot?.type === 'Directory' ? roots : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function inspectMappedPath(
  fs: FileSystem.FileSystem,
  path: string,
  roots: ScanRoots,
): Effect.Effect<InspectedMappedPath | undefined, never> {
  return Effect.gen(function* () {
    const relativePath = roots.pathService.relative(roots.boundaryRoot, roots.pathService.resolve(path));
    if (pathEscapesBoundary(relativePath, roots.pathService)) {
      return undefined;
    }
    if (Option.isSome(yield* fs.readLink(path).pipe(Effect.option))) {
      return undefined;
    }
    const info = yield* fs.stat(path);
    const type: InspectedMappedPath['type'] =
      info.type === 'Directory' ? 'Directory' : info.type === 'File' ? 'File' : 'Other';
    return {
      modifiedAt: Option.getOrUndefined(info.mtime),
      realPath: roots.pathService.resolve(roots.realBoundaryRoot, relativePath),
      size: Number(info.size),
      type,
    };
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function pathEscapesBoundary(relativePath: string, pathService: Path.Path): boolean {
  return (
    relativePath === '..' ||
    Effect2.pipe(relativePath, EffectString.startsWith(`..${pathService.sep}`)) ||
    pathService.isAbsolute(relativePath)
  );
}

const readFileBytesExactly = Effect.fn('filesystem.readFileBytesExactly')(function* (
  file: FileSystem.File,
  length: number,
) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const read = Number(yield* file.read(bytes.subarray(offset)));
    if (read <= 0) return yield* SafeFileScanError.make({message: 'Safe scan directory queue is truncated.'});
    offset += read;
  }
  return bytes;
});
