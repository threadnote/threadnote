import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {describe, expect} from 'vitest';
import {scanObsidianDirectoryPage} from '../src/scan.js';

describe('Obsidian directory pages', () => {
  effectIt.effect(
    'inspects at most 64 entries and resumes a large flat directory without materializing its listing',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const vault = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        yield* Effect.forEach(
          Array.from({length: 130}, (_, index) => index),
          index => fs.writeFileString(path.join(vault, `note-${index}.md`), '# Public'),
          {concurrency: 8},
        );
        let inspections = 0;
        const counted = {
          ...fs,
          stat: (filename: string) =>
            Effect.suspend(() => {
              inspections++;
              return fs.stat(filename);
            }),
          readDirectory: () => Effect.die('must stream directory names'),
        };
        const first = yield* scanObsidianDirectoryPage(counted, vault, '', 0);
        expect(inspections).toBe(64);
        expect(first.files).toHaveLength(64);
        expect(first.nextOffset).toBe(64);
        inspections = 0;
        const second = yield* scanObsidianDirectoryPage(counted, vault, '', first.nextOffset!);
        expect(inspections).toBe(64);
        expect(second.files).toHaveLength(64);
        inspections = 0;
        const last = yield* scanObsidianDirectoryPage(counted, vault, '', second.nextOffset!);
        expect(inspections).toBe(2);
        expect(last.files).toHaveLength(2);
        expect(last.nextOffset).toBeUndefined();
        expect(new Set([...first.files, ...second.files, ...last.files].map(file => file.path)).size).toBe(130);
      }).pipe(effect =>
        Effect.scoped(
          Layer.build(BunServices.layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
        ),
      ),
  );
});
