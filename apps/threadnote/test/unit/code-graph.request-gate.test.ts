import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {codeGraphBuildRequestKey} from '@threadnote/graph/indexer/build';
import {withSharedCodeGraphRequestGate} from '@threadnote/graph/indexer/request/gate';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph request gate', () => {
  it('keys dirty requests deterministically by their exact overlay fingerprint (property)', () => {
    const identity = {checkoutId: 'checkout', headCommit: 'commit', repositoryId: 'repository', worktreeId: 'worktree'};
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (first, second) => {
        fc.pre(first !== second);
        const key = (fingerprint: string) =>
          codeGraphBuildRequestKey(
            identity,
            {dirty: true, fingerprint},
            BUILTIN_LANGUAGE_PACK_REGISTRY,
            true,
            false,
            'environment',
          );
        expect(key(first)).toBe(key(first));
        expect(key(first)).not.toBe(key(second));
      }),
      {numRuns: 50},
    );
  });

  effectIt.effect('serializes two identical dirty-overlay requests before the repository lock', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* Effect.acquireRelease(
            fs.makeTempDirectory({prefix: 'threadnote-dirty-request-gate-'}),
            directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.ignore),
          );
          const firstEntered = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const secondEntered = yield* Deferred.make<void>();
          const secondContended = yield* Deferred.make<void>();
          const gate = (
            effect: Effect.Effect<void>,
            onProgress: (progress: {phase: string; reason?: string}) => Effect.Effect<void>,
          ) =>
            withSharedCodeGraphRequestGate({
              checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
              effect,
              fs,
              onProgress,
              path,
              requestedOverlay: {dirty: true, fingerprint: 'same-overlay'},
              requestKey: Effect2.pipe('b', EffectString.repeat(64)),
              threadnoteHome: home,
            });
          const first = yield* Effect.forkScoped(
            gate(
              Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst))),
              () => Effect.void,
            ),
          );
          yield* Deferred.await(firstEntered);
          const second = yield* Effect.forkScoped(
            gate(Deferred.succeed(secondEntered, undefined).pipe(Effect.asVoid), progress =>
              progress.phase === 'waiting' && progress.reason === 'request-lock'
                ? Deferred.succeed(secondContended, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          );
          const observation = yield* Effect.race(
            Deferred.await(secondContended).pipe(Effect.as('contended')),
            Deferred.await(secondEntered).pipe(Effect.as('entered')),
          );
          expect(observation).toBe('contended');
          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          expect(yield* Deferred.isDone(secondEntered)).toBe(true);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    ),
  );
});
