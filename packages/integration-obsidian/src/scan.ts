import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {runtimeTextDirectoryNames} from '@threadnote/platform/system';
import type {SafeScannedFile} from '@threadnote/platform/safe_scan';

class ObsidianScanError extends Schema.TaggedError<ObsidianScanError>()('ObsidianScanError', {
  message: Schema.String,
}) {}

/** Only the selected page receives filesystem inspection; earlier names are streamed past. */
export const scanObsidianDirectoryPage = Effect.fn('obsidian.directoryPage')(function* (
  fs: FileSystem.FileSystem,
  vault: string,
  relativeDirectory: string,
  offset: number,
) {
  const path = yield* Path.Path;
  const directory = path.join(vault, relativeDirectory);
  const empty = {
    files: [] as SafeScannedFile[],
    directories: [] as string[],
    nextOffset: undefined as number | undefined,
  };
  const actual = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined));
  if (actual !== path.resolve(vault, relativeDirectory)) return empty;
  for (let current = directory; current !== vault; current = path.dirname(current)) {
    if (Option.isSome(yield* fs.readLink(current).pipe(Effect.option))) return empty;
    if (current === path.dirname(current)) return empty;
  }
  const iterator = runtimeTextDirectoryNames(directory)[Symbol.asyncIterator]();
  return yield* Effect.acquireUseRelease(
    Effect.succeed(iterator),
    iterator =>
      Effect.gen(function* () {
        const files: SafeScannedFile[] = [];
        const directories: string[] = [];
        let index = 0;
        let inspected = 0;
        while (true) {
          const entry = yield* fromPromiseInterruptible(
            () => iterator.next(),
            () => ObsidianScanError.make({message: 'Obsidian directory enumeration failed.'}),
          );
          if (entry.done) return {files, directories, nextOffset: undefined};
          if (index++ < offset) continue;
          if (inspected === 64) return {files, directories, nextOffset: offset + inspected};
          inspected++;
          const name = entry.value;
          if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) continue;
          const filename = path.join(directory, name);
          if (Option.isSome(yield* fs.readLink(filename).pipe(Effect.option))) continue;
          const info = yield* fs.stat(filename).pipe(Effect.option);
          if (Option.isNone(info)) continue;
          if (info.value.type === 'Directory') directories.push(filename);
          else if (info.value.type === 'File')
            files.push({
              path: filename,
              size: Number(info.value.size),
              modifiedAt: Option.getOrUndefined(info.value.mtime),
            });
        }
      }),
    iterator =>
      fromPromiseInterruptible(
        async () => {
          await iterator.return?.();
        },
        () => ObsidianScanError.make({message: 'Obsidian directory close failed.'}),
      ).pipe(Effect.ignore),
  );
});

export const inspectObsidianFile = Effect.fn('obsidian.inspectFile')(function* (
  fs: FileSystem.FileSystem,
  vault: string,
  relativePath: string,
) {
  const path = yield* Path.Path;
  const filename = path.join(vault, relativePath);
  const actual = yield* fs.realPath(filename).pipe(Effect.orElseSucceed(() => undefined));
  if (actual !== path.resolve(vault, relativePath)) return undefined;
  if (Option.isSome(yield* fs.readLink(filename).pipe(Effect.option))) return undefined;
  const info = yield* fs.stat(filename).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === 'File' ? info.value : undefined;
});
