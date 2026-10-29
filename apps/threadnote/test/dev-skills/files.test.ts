import * as BunPath from '@effect/platform-bun/BunPath';
import {it as effectIt} from '@effect/vitest';
import {ByteSize, Effect, FileSystem, Layer, Option, Path, PlatformError, Schema} from 'effect';
import {describe, expect} from 'vitest';
import {assertSafePath} from '../../src/dev_skills/files.js';

type Entry = 'File' | 'Directory' | 'link' | 'dangling-link' | 'noncanonical';
const platformError = (method: string, file: string, reason: PlatformError.SystemErrorTag = 'NotFound') =>
  PlatformError.systemError({_tag: reason, module: 'FileSystem', method, pathOrDescriptor: file});
const info = (type: FileSystem.File.Type): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 1n,
  ino: Option.none(),
  mode: 0o600,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(0),
  blksize: Option.none(),
  blocks: Option.none(),
});
const providePath =
  (layer: Layer.Layer<Path.Path>) =>
  <A, E, R>(program: Effect.Effect<A, E, R>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))));
const tree = Effect.fn(function* (root = '/', parts: readonly string[] = ['owned', 'user']) {
  const path = yield* Path.Path;
  const directories = [root];
  for (const part of parts) directories.push(path.join(directories.at(-1), part));
  const leaf = path.join(directories.at(-1), '.threadnote.setup-mutation.lock');
  const entries = new Map<string, Entry>(directories.map(directory => [directory, 'Directory']));
  entries.set(leaf, 'File');
  const reads: string[] = [];
  const fs = FileSystem.makeNoop({
    readLink: file =>
      Effect.suspend(() => {
        reads.push(`readLink:${file}`);
        const entry = entries.get(file);
        return entry === 'link' || entry === 'dangling-link'
          ? Effect.succeed(path.join(root, 'foreign'))
          : Effect.fail(platformError('readLink', file, entry ? 'Unknown' : 'NotFound'));
      }),
    stat: file =>
      Effect.suspend(() => {
        reads.push(`stat:${file}`);
        const entry = entries.get(file);
        return entry && entry !== 'dangling-link'
          ? Effect.succeed(info(entry === 'File' ? 'File' : 'Directory'))
          : Effect.fail(platformError('stat', file));
      }),
    realPath: file =>
      Effect.suspend(() => {
        reads.push(`realPath:${file}`);
        return entries.has(file)
          ? Effect.succeed(entries.get(file) === 'noncanonical' ? path.join(root, 'foreign') : file)
          : Effect.fail(platformError('realPath', file));
      }),
  });
  return {path, directories, leaf, entries, reads, fs};
});

describe('development skills destination safety', () => {
  effectIt.effect('rechecks the complete path when a lock disappears between stat and realPath', () =>
    Effect.gen(function* () {
      const f = yield* tree();
      let disappeared = false;
      const fs = FileSystem.FileSystem.of({
        ...f.fs,
        realPath: file =>
          Effect.suspend(() => {
            if (file === f.leaf && !disappeared) {
              expect(f.reads).toContain(`stat:${f.leaf}`);
              f.entries.delete(f.leaf);
              disappeared = true;
            }
            return f.fs.realPath(file);
          }),
      });
      expect(
        yield* assertSafePath(f.leaf).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.result),
      ).toMatchObject({
        _tag: 'Success',
        success: undefined,
      });
      expect(disappeared).toBe(true);
      expect(f.reads.filter(read => read === 'readLink:/')).toHaveLength(2);
      expect(f.entries.has(f.leaf)).toBe(false);
    }).pipe(providePath(BunPath.layerPosix)),
  );

  effectIt.effect('bounds retries when an existing entry repeatedly disappears during realPath', () =>
    Effect.gen(function* () {
      const f = yield* tree();
      const error = platformError('realPath', f.leaf);
      let attempts = 0;
      const fs = FileSystem.FileSystem.of({
        ...f.fs,
        realPath: file =>
          file === f.leaf
            ? Effect.suspend(() => {
                attempts++;
                return Effect.fail(error);
              })
            : f.fs.realPath(file),
      });
      expect(
        yield* assertSafePath(f.leaf).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.result),
      ).toMatchObject({
        _tag: 'Failure',
        failure: error,
      });
      expect(attempts).toBe(2);
    }).pipe(providePath(BunPath.layerPosix)),
  );

  for (const method of ['stat', 'realPath'] as const)
    for (const reason of ['PermissionDenied', 'Unknown'] as const)
      effectIt.effect(`propagates ${method} ${reason} without retrying`, () =>
        Effect.gen(function* () {
          const f = yield* tree();
          const error = platformError(method, f.leaf, reason);
          let attempts = 0;
          const fs = FileSystem.FileSystem.of({
            ...f.fs,
            [method]: (file: string) =>
              file === f.leaf
                ? Effect.suspend(() => {
                    attempts++;
                    return Effect.fail(error);
                  })
                : f.fs[method](file),
          });
          expect(
            yield* assertSafePath(f.leaf).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.result),
          ).toMatchObject({_tag: 'Failure', failure: error});
          expect(attempts).toBe(1);
        }).pipe(providePath(BunPath.layerPosix)),
      );

  effectIt.effect('rejects a noncanonical input before reading the filesystem', () =>
    Effect.gen(function* () {
      const f = yield* tree();
      expect(
        yield* assertSafePath('/owned/../foreign').pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
          Effect.result,
        ),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'unsafe-path'}});
      expect(f.reads).toEqual([]);
    }).pipe(providePath(BunPath.layerPosix)),
  );

  for (const placement of ['leaf', 'ancestor'] as const)
    for (const entry of ['link', 'dangling-link', 'noncanonical'] as const)
      effectIt.effect(`rejects a ${entry} at the ${placement}`, () =>
        Effect.gen(function* () {
          const f = yield* tree();
          f.entries.set(placement === 'leaf' ? f.leaf : f.directories[1], entry);
          const before = [...f.entries];
          expect(
            yield* assertSafePath(f.leaf).pipe(Effect.provideService(FileSystem.FileSystem, f.fs), Effect.result),
          ).toMatchObject({_tag: 'Failure', failure: {code: 'unsafe-path'}});
          expect([...f.entries]).toEqual(before);
        }).pipe(providePath(BunPath.layerPosix)),
      );

  effectIt.effect('rejects a nondirectory ancestor before reading the leaf', () =>
    Effect.gen(function* () {
      const f = yield* tree();
      f.entries.set(f.directories[1], 'File');
      expect(
        yield* assertSafePath(f.leaf).pipe(Effect.provideService(FileSystem.FileSystem, f.fs), Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'unsafe-path'}});
      expect(f.reads).not.toContain(`readLink:${f.leaf}`);
    }).pipe(providePath(BunPath.layerPosix)),
  );

  effectIt.effect('preserves a readLink permission failure without treating it as absence', () =>
    Effect.gen(function* () {
      const f = yield* tree();
      const error = platformError('readLink', f.leaf, 'PermissionDenied');
      const fs = FileSystem.FileSystem.of({
        ...f.fs,
        readLink: file => (file === f.leaf ? Effect.fail(error) : f.fs.readLink(file)),
      });
      expect(
        yield* assertSafePath(f.leaf).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: error});
      expect(f.reads).not.toContain(`stat:${f.leaf}`);
    }).pipe(providePath(BunPath.layerPosix)),
  );

  for (const variant of [
    {name: 'POSIX', root: '/', layer: BunPath.layerPosix},
    {name: 'Windows', root: 'C:\\', layer: BunPath.layerWin32},
  ])
    effectIt.effect.prop(
      `never accepts a newly unsafe ancestor after a transient disappearance on ${variant.name}`,
      {
        parts: Schema.Array(Schema.Literals(['owned', 'nested', 'user'])).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(5),
        ),
        offset: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 10})),
        replacement: Schema.Literals(['link', 'dangling-link', 'File', 'noncanonical']),
      },
      ({parts, offset, replacement}) =>
        Effect.gen(function* () {
          const f = yield* tree(variant.root, parts);
          const ancestor = f.directories[1 + (offset % (f.directories.length - 1))];
          let disappeared = false;
          const fs = FileSystem.FileSystem.of({
            ...f.fs,
            realPath: file =>
              Effect.suspend(() => {
                if (file === f.leaf && !disappeared) {
                  f.entries.delete(f.leaf);
                  f.entries.set(ancestor, replacement);
                  disappeared = true;
                }
                return f.fs.realPath(file);
              }),
          });
          expect(
            yield* assertSafePath(f.leaf).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.result),
          ).toMatchObject({_tag: 'Failure', failure: {code: 'unsafe-path'}});
          expect(disappeared).toBe(true);
          expect([...f.entries]).toEqual(
            f.directories.map(directory => [directory, directory === ancestor ? replacement : 'Directory']),
          );
        }).pipe(providePath(variant.layer)),
      {arbitrary: {runs: 40}},
    );
});
