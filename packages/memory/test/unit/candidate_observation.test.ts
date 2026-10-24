import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {describe, expect} from 'vitest';
import {candidateReviewObservationPaths} from '@threadnote/memory/candidate';

function provideBun<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Layer.build(BunServices.layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
}

describe('candidateReviewObservationPaths', () => {
  effectIt.effect('selects the same last 500 review names and retains the parent for first creation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'candidate-observation-'});
      const empty = yield* candidateReviewObservationPaths(home);
      expect(empty).toMatchObject({state: 'ready', files: []});
      if (empty.state !== 'ready') return;
      const names = [
        ...Array.from({length: 501}, (_, index) => `${String(index).padStart(3, '0')}.json`),
        '.ignored.json',
        'temporary.tmp',
      ];
      yield* fs.makeDirectory(empty.directory, {recursive: true});
      yield* Effect.forEach(names, name => fs.writeFileString(path.join(empty.directory, name), '{}'), {
        concurrency: 16,
        discard: true,
      });
      const observed = yield* candidateReviewObservationPaths(home);
      expect(observed.state).toBe('ready');
      if (observed.state !== 'ready') return;
      expect(observed.directory).toBe(empty.directory);
      expect(observed.files).toHaveLength(500);
      expect(observed.files[0]).toBe(path.join(empty.directory, '001.json'));
      expect(observed.files.at(-1)).toBe(path.join(empty.directory, '500.json'));
    }).pipe(provideBun),
  );

  effectIt.effect('returns unavailable before per-file work when the directory exceeds its entry cap', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'candidate-observation-cap-'});
      const path = yield* Path.Path;
      const empty = yield* candidateReviewObservationPaths(home);
      if (empty.state !== 'ready') throw new Error('Missing fixture directory');
      yield* fs.makeDirectory(empty.directory, {recursive: true});
      const names = Array.from({length: 1_025}, (_, index) => `${index}.json`);
      yield* Effect.forEach(names, name => fs.writeFileString(path.join(empty.directory, name), '{}'), {
        concurrency: 16,
        discard: true,
      });
      const observed = yield* candidateReviewObservationPaths(home);
      expect(observed).toMatchObject({state: 'unavailable', reason: 'directory-entry-limit'});
    }).pipe(provideBun),
  );
});
