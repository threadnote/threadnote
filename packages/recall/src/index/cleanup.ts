import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path, Predicate} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const removeLegacyRecallIndexArtifacts = Effect.fn('recall.removeLegacyIndexArtifacts')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  currentVersion: number,
) {
  const cacheRoot = path.join(home, 'cache');
  if (yield* fs.exists(cacheRoot)) {
    const entries = yield* fs.readDirectory(cacheRoot);
    for (const entry of entries) {
      if (/^recall-index-v[0-9]+(?:-with-inactive)?\.json(?:\.stale)?$/.test(entry)) {
        yield* fs.remove(path.join(cacheRoot, entry), {force: true});
      }
    }
  }

  const lexicalRoot = path.join(home, 'indexes', 'lexical');
  if (!(yield* fs.exists(lexicalRoot))) return;
  const entries = yield* fs.readDirectory(lexicalRoot);
  const retainedGenerationPaths = new Set<string>();
  const currentPointerPattern = new RegExp(`^(?:active|with-inactive)-v${currentVersion}\\.pointer\\.json$`);
  for (const entry of EffectArray.filter(
    entries,
    __effectArrayValue => !!(name => currentPointerPattern.test(name))(__effectArrayValue),
  )) {
    const relative = yield* recallPointerDatabaseRelativePath(fs, path.join(lexicalRoot, entry));
    if (relative)
      retainedGenerationPaths.add(path.join(lexicalRoot, ...Effect2.pipe(relative, EffectString.split('/'))));
  }
  for (const entry of entries) {
    const version = /^(?:active|with-inactive)-v([0-9]+)(?:\.sqlite(?:-(?:shm|wal)|\.stale)?|\.pointer\.json)$/.exec(
      entry,
    )?.[1];
    if (!version || Number(version) >= currentVersion) continue;
    const target = path.join(lexicalRoot, entry);
    if (Effect2.pipe(entry, EffectString.endsWith('.pointer.json'))) {
      const relative = yield* recallPointerDatabaseRelativePath(fs, target);
      if (relative) {
        const generationPath = path.join(lexicalRoot, ...Effect2.pipe(relative, EffectString.split('/')));
        if (!retainedGenerationPaths.has(generationPath)) {
          yield* removeDatabaseFiles(fs, generationPath);
        }
      }
    }
    yield* fs.remove(target, {force: true});
  }
});

function recallPointerDatabaseRelativePath(fs: FileSystem.FileSystem, pointerPath: string) {
  return fs.readFileString(pointerPath).pipe(
    Effect.map(raw => {
      try {
        const pointer: unknown = JSON.parse(raw);
        if (!Predicate.isObject(pointer) || typeof pointer.database !== 'string') return undefined;
        const relative = Effect2.pipe(pointer.database, EffectString.replaceAll('\\', '/'));
        return relative &&
          Effect2.pipe(relative, EffectString.startsWith('generations/')) &&
          Effect2.pipe(relative, EffectString.endsWith('.sqlite')) &&
          !EffectArray.some(
            Effect2.pipe(relative, EffectString.split('/')),
            segment => segment === '' || segment === '.' || segment === '..',
          )
          ? relative
          : undefined;
      } catch {
        return undefined;
      }
    }),
    Effect.orElseSucceed(() => undefined),
  );
}

function removeDatabaseFiles(fs: FileSystem.FileSystem, databasePath: string) {
  return Effect.forEach(
    [databasePath, `${databasePath}-shm`, `${databasePath}-wal`],
    target => fs.remove(target, {force: true}),
    {concurrency: 1, discard: true},
  );
}
