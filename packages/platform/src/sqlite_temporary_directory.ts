import {Effect, FileSystem, Option} from 'effect';

/**
 * The directory where SQLite puts temporary files such as a VACUUM copy or a sorter spill. On Unix it follows the
 * VFS search order; on Windows SQLite asks the process temporary directory. Undefined means no usable directory.
 */
export function sqliteTemporaryDirectory(
  input: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly platform: string;
    readonly temporaryDirectory: string;
  },
  usable: (directory: string) => Effect.Effect<boolean, never>,
): Effect.Effect<string | undefined> {
  if (input.platform === 'win32') return Effect.succeed(input.temporaryDirectory);
  return Effect.gen(function* () {
    const candidates = [input.environment.SQLITE_TMPDIR, input.environment.TMPDIR, '/var/tmp', '/usr/tmp', '/tmp', '.'];
    for (const directory of candidates) {
      if (directory && (yield* usable(directory))) return directory;
    }
    return undefined;
  });
}

/** SQLite skips a candidate it cannot search and write. */
export function sqliteTemporaryDirectoryUsable(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    const info = yield* fs.stat(directory).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== 'Directory') return false;
    // Looking up "/." requires search permission on the directory itself.
    const searchable = yield* fs.stat(`${directory}/.`).pipe(Effect.option);
    const writable = yield* fs.access(directory, {writable: true}).pipe(Effect.option);
    return Option.isSome(searchable) && Option.isSome(writable);
  });
}
