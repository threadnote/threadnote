import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Path} from 'effect';
import {expect} from 'vitest';
import {fromPromise} from '../src/errors.js';
import {runtimeLstat, runtimeReadBoundedStableRegularFile} from '../src/system.js';

effectIt.layer(BunServices.layer)(it => {
  it.effect('binds a bounded read to its earlier file proof despite restored size and mtime', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({prefix: 'stable-read-proof-'});
      const filename = path.join(directory, 'source.md');
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T00:00:00.000Z'));
      yield* fs.writeFileString(filename, 'old');
      yield* fs.utimes(filename, timestamp, timestamp);
      const before = yield* fromPromise('before', () => runtimeLstat(filename));
      const read = (expected: typeof before) =>
        fromPromise('read', () => runtimeReadBoundedStableRegularFile(filename, 3, expected));
      expect(new TextDecoder().decode(yield* read(before))).toBe('old');
      yield* fs.writeFileString(filename, 'new');
      yield* fs.utimes(filename, timestamp, timestamp);
      const after = yield* fromPromise('after', () => runtimeLstat(filename));
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(yield* read(before).pipe(Effect.flip)).toMatchObject({
        cause: {_tag: 'SystemOperationError', message: 'Target changed since preparation.'},
      });
      expect(new TextDecoder().decode(yield* read(after))).toBe('new');
    }),
  );
});
