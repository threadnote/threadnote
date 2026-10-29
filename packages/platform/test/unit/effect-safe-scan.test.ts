import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {forEachFileWithinBoundary} from '@threadnote/platform/safe_scan';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('bounded live file scanning', () => {
  effectIt.layer(BunServices.layer)(layerIt => {
    layerIt.effect('closes each directory before traversing a deep descendant', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-deep-safe-scan-'});
          let directory = root;
          for (let depth = 0; depth < 300; depth += 1) {
            directory = path.join(directory, 'd');
            yield* fs.makeDirectory(directory);
          }
          const leaf = path.join(directory, 'leaf.md');
          yield* fs.writeFileString(leaf, 'threadnote');
          const visited: string[] = [];

          yield* forEachFileWithinBoundary(
            fs,
            root,
            root,
            {includeFile: candidate => Effect2.pipe(candidate, EffectString.endsWith('.md'))},
            file => Effect.sync(() => visited.push(file.path)),
          );

          expect(visited).toEqual([leaf]);
        }),
      ),
    );

    layerIt.effect('propagates a partial directory enumeration failure', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-failed-safe-scan-'});
          yield* fs.writeFileString(path.join(root, 'visible.md'), 'threadnote');
          const failingNames = async function* () {
            yield 'visible.md';
            throw new Error('injected directory failure');
          };

          const failure = yield* forEachFileWithinBoundary(
            fs,
            root,
            root,
            {includeFile: () => true},
            () => Effect.void,
            failingNames,
          ).pipe(Effect.flip);

          expect(failure).toMatchObject({_tag: 'SafeFileScanError'});
        }),
      ),
    );
  });
});
