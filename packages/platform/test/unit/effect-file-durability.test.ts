import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, PlatformError} from 'effect';
import {describe, expect} from 'vitest';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';

describe('file durability', () => {
  effectIt.effect('opens files with a writable handle before syncing', () =>
    Effect.gen(function* () {
      const calls: Array<{readonly flag: string; readonly target: string}> = [];
      let synced = false;
      const fs = FileSystem.makeNoop({
        open: (target, options) => {
          calls.push({flag: options?.flag ?? '', target});
          return Effect.succeed(
            fileHandle(
              Effect.asVoid(
                Effect.sync(() => {
                  synced = true;
                }),
              ),
            ),
          );
        },
      });

      yield* Effect.scoped(syncWritableFile(fs, 'state.json'));

      expect(calls).toEqual([{flag: 'r+', target: 'state.json'}]);
      expect(synced).toBe(true);
    }),
  );

  effectIt.effect('keeps directory syncing read-only and best effort', () =>
    Effect.gen(function* () {
      const calls: Array<{readonly flag: string; readonly target: string}> = [];
      const fs = FileSystem.makeNoop({
        open: (target, options) => {
          calls.push({flag: options?.flag ?? '', target});
          return Effect.fail(
            PlatformError.systemError({
              _tag: 'Unknown',
              module: 'FileSystem',
              method: 'open',
              description: 'directory fsync is unsupported',
              pathOrDescriptor: target,
            }),
          );
        },
      });

      yield* syncDirectoryBestEffort(fs, 'parent');
      expect(calls).toEqual([{flag: 'r', target: 'parent'}]);
    }),
  );
});

function fileHandle(sync: Effect.Effect<void, PlatformError.PlatformError>): FileSystem.File {
  return {
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: Effect.die('file metadata is unused in this test'),
    seek: () => Effect.die('file seeking is unused in this test'),
    sync,
    read: () => Effect.die('file reads are unused in this test'),
    readAlloc: () => Effect.die('file reads are unused in this test'),
    truncate: () => Effect.die('file truncation is unused in this test'),
    write: () => Effect.die('file writes are unused in this test'),
    writeAll: () => Effect.die('file writes are unused in this test'),
  };
}
