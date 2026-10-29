import {Effect, FileSystem, Option, Path} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MAX_MIGRATION_EVIDENCE_DIRECTORIES = 256;
const OPERATING_SYSTEM_METADATA_FILENAMES = new Set(['.ds_store', 'desktop.ini', 'thumbs.db']);

export function isIgnorableOperatingSystemMetadata(name: string): boolean {
  return (
    OPERATING_SYSTEM_METADATA_FILENAMES.has(Effect2.pipe(name, EffectString.toLowerCase)) ||
    Effect2.pipe(name, EffectString.startsWith('._'))
  );
}

/**
 * Distinguishes an empty directory scaffold from migration-worthy content
 * without allowing eligibility checks to traverse an unbounded tree. Unsafe
 * entries and trees beyond the directory budget are treated conservatively as
 * material so the apply path can validate them properly.
 */
export const hasBoundedMigrationTreeContent = Effect.fn('migration.hasBoundedTreeContent')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  include: (candidate: string, type: string) => boolean = () => true,
) {
  const directories = [root];
  for (let index = 0; index < directories.length; index += 1) {
    if (index >= MAX_MIGRATION_EVIDENCE_DIRECTORIES) return true;
    const directory = directories[index];
    for (const name of yield* fs.readDirectory(directory)) {
      const candidate = path.join(directory, name);
      if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) return true;
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isNone(info)) return true;
      if (!include(candidate, info.value.type)) continue;
      if (info.value.type !== 'Directory') return true;
      directories.push(candidate);
      if (directories.length > MAX_MIGRATION_EVIDENCE_DIRECTORIES) return true;
    }
  }
  return false;
});
