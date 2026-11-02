import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {expect} from 'vitest';
import {runtimeOpenTextDirectoryNameReader} from '../src/system.js';

effectIt.layer(BunServices.layer)(it => {
  for (const entryKind of ['directory', 'file'] as const)
    it.effect(`pages physical entries while selecting only regular ${entryKind} names`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'bounded-directory-names-'});
        const expected: string[] = [];
        for (let index = 0; index < 66; index++) {
          yield* fs.makeDirectory(path.join(root, 'directory-' + String(index)));
          yield* fs.writeFileString(path.join(root, 'file-' + String(index)), '');
          expected.push(entryKind + '-' + String(index));
        }
        yield* fs.symlink(path.join(root, 'file-0'), path.join(root, 'symbolic-link'));
        const reader = yield* Effect.acquireRelease(
          Effect.promise(() =>
            runtimeOpenTextDirectoryNameReader(root, entryKind === 'file' ? {entryKind} : undefined),
          ),
          value => Effect.promise(() => value.close()),
        );
        const names: string[] = [];
        let pages = 0;
        for (;;) {
          const page = yield* Effect.promise(() => reader.readPage(64));
          expect(page.names.length).toBeLessThanOrEqual(64);
          names.push(...page.names);
          pages++;
          if (page.done) break;
        }
        expect(pages).toBeGreaterThanOrEqual(3);
        expect(names.sort()).toEqual(expected.sort());
      }),
    );
});
