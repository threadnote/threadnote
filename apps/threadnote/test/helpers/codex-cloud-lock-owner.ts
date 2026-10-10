import * as BunServices from '@effect/platform-bun/BunServices';
import {Clock, Effect, FileSystem, Layer} from 'effect';
import {withSharedRepositoryHomeLock} from '@threadnote/threadnote/effect/share/lock';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from './effect-layer.js';
import {TestSystemInfoLayer} from './system-layer.js';

const [home, ready, release, worktreeFile] = process.argv.slice(2);
if (!home || !ready || !release || !worktreeFile) {
  throw TestError.make({message: 'Expected home, ready, release, and worktree file arguments.'});
}

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* withSharedRepositoryHomeLock(
      home,
      Effect.gen(function* () {
        const original = yield* fs.readFileString(worktreeFile);
        yield* Effect.gen(function* () {
          yield* fs.writeFileString(worktreeFile, `${original}\nConcurrent durable write in progress.\n`);
          yield* fs.writeFileString(ready, 'ready');
          const deadline = (yield* Clock.currentTimeMillis) + 20_000;
          while (!(yield* fs.exists(release))) {
            if ((yield* Clock.currentTimeMillis) >= deadline) {
              return yield* TestError.make({message: 'Timed out waiting to release the shared repository lock.'});
            }
            yield* Effect.sleep(10);
          }
        }).pipe(Effect.ensuring(fs.writeFileString(worktreeFile, original).pipe(Effect.orDie)));
      }),
    );
  }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
);
