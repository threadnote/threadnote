import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Schema} from 'effect';
import {expect} from 'vitest';
import {makeCodeGraphWatcher, type CodeGraphWatchOptions} from '../../src/watcher.js';

effectIt.effect.prop(
  'structural-only refresh bursts never replace an independent normal refresh',
  {
    anchorFirst: Schema.Boolean,
    duplicates: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 6})),
    scoped: Schema.Boolean,
  },
  ({anchorFirst, duplicates, scoped}) =>
    Effect.gen(function* () {
      const normalStarted = yield* Deferred.make<void>();
      const anchorStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const normalDone = yield* Deferred.make<void>();
      const anchorDone = yield* Deferred.make<void>();
      const observed: Array<{readonly cwd: string; readonly policy: string}> = [];
      const watcher = yield* makeCodeGraphWatcher(
        () => Effect.never,
        options =>
          Effect.gen(function* () {
            const off = options.vectorPolicy === 'off';
            observed.push({cwd: options.cwd, policy: off ? 'off' : 'background'});
            yield* Deferred.succeed(off ? anchorStarted : normalStarted, undefined);
            yield* Deferred.await(release);
            yield* Deferred.succeed(off ? anchorDone : normalDone, undefined);
          }),
      );
      const base: CodeGraphWatchOptions = {
        admissionClass: 'background',
        cwd: '/normal',
        key: 'same-worktree',
        threadnoteHome: '/home',
        ...(scoped
          ? {
              project: {
                name: 'web',
                uri: 'threadnote://resources/web',
                graph: {roots: ['src'], closure: 'dependencies', include: []},
              },
            }
          : {}),
      };
      const normal = Object.freeze({...base});
      const anchor = Object.freeze({...base, cwd: '/anchor', vectorPolicy: 'off' as const});
      yield* watcher.refresh(anchorFirst ? anchor : normal);
      yield* Deferred.await(anchorFirst ? anchorStarted : normalStarted);
      yield* watcher.refresh(anchorFirst ? normal : anchor);
      yield* Deferred.await(anchorFirst ? normalStarted : anchorStarted);
      for (let n = 0; n < duplicates; n++) yield* watcher.refresh(anchor);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(normalDone);
      yield* Deferred.await(anchorDone);
      expect(observed).toHaveLength(2);
      expect(observed).toEqual(
        expect.arrayContaining([
          {cwd: '/normal', policy: 'background'},
          {cwd: '/anchor', policy: 'off'},
        ]),
      );
      expect(normal.key).toBe('same-worktree');
      expect(anchor.key).toBe('same-worktree');
    }),
  {arbitrary: {runs: 16, seed: 90123}},
);
