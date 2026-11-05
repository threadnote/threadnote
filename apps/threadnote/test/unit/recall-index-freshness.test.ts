import {cryptoLayer} from '@threadnote/platform/crypto';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'fast-check';
import {TestClock} from 'effect/testing';

import {expireRecallIndexValidation, loadRecallIndexData} from '@threadnote/recall/index';
import {
  mergeRecallIndexCanonicalMutationContinuity,
  recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh,
  recallIndexForegroundRefreshRequired,
} from '@threadnote/recall/index/freshness';

const platformServicesLayer = Layer.merge(BunServices.layer, cryptoLayer);

const RecallIndexTestLayer = Layer.merge(platformServicesLayer, TestSystemInfoLayer);

describe('recall index foreground freshness', () => {
  fcEffectProp(
    effectIt,
    'requires refresh exactly for force, initialization, integrity, or generation changes',
    {
      canonicalGeneration: FC.string({maxLength: 48}),
      forceRefresh: FC.boolean(),
      generation: FC.string({maxLength: 48}),
      initialized: FC.boolean(),
      integrityCurrent: FC.boolean(),
    },
    ({canonicalGeneration, forceRefresh, generation, initialized, integrityCurrent}) =>
      Effect.sync(() => {
        const markerCurrent = recallIndexForegroundRefreshRequired({
          forceRefresh,
          initialized,
          integrityCurrent,
          observedCanonicalMutationGeneration: canonicalGeneration,
          observedStaleGeneration: generation,
          persistedCanonicalMutationGeneration: canonicalGeneration,
          persistedStaleGeneration: generation,
        });
        const changed = recallIndexForegroundRefreshRequired({
          forceRefresh: false,
          initialized: true,
          integrityCurrent: true,
          observedCanonicalMutationGeneration: canonicalGeneration,
          observedStaleGeneration: `${generation}:changed`,
          persistedCanonicalMutationGeneration: canonicalGeneration,
          persistedStaleGeneration: generation,
        });
        const canonicalChanged = recallIndexForegroundRefreshRequired({
          forceRefresh: false,
          initialized: true,
          integrityCurrent: true,
          observedCanonicalMutationGeneration: `${canonicalGeneration}:changed`,
          observedStaleGeneration: generation,
          persistedCanonicalMutationGeneration: canonicalGeneration,
          persistedStaleGeneration: generation,
        });

        expect(markerCurrent).toBe(forceRefresh || !initialized || !integrityCurrent);
        expect(changed).toBe(true);
        expect(canonicalChanged).toBe(true);
      }),
    {fastCheck: {numRuns: 100}},
  );

  fcEffectProp(
    effectIt,
    'allows tracked canonical incremental refresh only for an exact end-to-end transition',
    {
      markerCurrent: FC.string({maxLength: 48}),
      markerPrevious: FC.string({maxLength: 48}),
      observed: FC.string({minLength: 1, maxLength: 48}),
      persisted: FC.string({minLength: 1, maxLength: 48}),
    },
    ({markerCurrent, markerPrevious, observed, persisted}) =>
      Effect.sync(() => {
        expect(
          recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh({
            markerCurrentGeneration: markerCurrent,
            markerPreviousGeneration: markerPrevious,
            observedGeneration: observed,
            persistedGeneration: persisted,
          }),
        ).toBe(persisted === observed || (markerPrevious === persisted && markerCurrent === observed));
      }),
    {fastCheck: {numRuns: 100}},
  );

  fcEffectProp(
    effectIt,
    'merges consecutive mutation transitions while preserving their earliest indexed base',
    {
      generations: FC.uniqueArray(FC.string({maxLength: 32}), {maxLength: 12, minLength: 2}),
    },
    ({generations}) =>
      Effect.sync(() => {
        let merged = mergeRecallIndexCanonicalMutationContinuity(undefined, {
          currentGeneration: generations[1],
          previousGeneration: generations[0],
        });
        for (let index = 2; index < generations.length; index += 1) {
          merged = mergeRecallIndexCanonicalMutationContinuity(
            {
              ...(merged.currentGeneration === undefined ? {} : {currentGeneration: merged.currentGeneration}),
              pending: true,
              ...(merged.previousGeneration === undefined ? {} : {previousGeneration: merged.previousGeneration}),
            },
            {
              currentGeneration: generations[index],
              previousGeneration: generations[index - 1],
            },
          );
        }

        expect(merged).toEqual({
          continuous: true,
          currentGeneration: generations.at(-1),
          previousGeneration: generations[0],
        });
        expect(
          mergeRecallIndexCanonicalMutationContinuity(
            {
              currentGeneration: merged.currentGeneration!,
              pending: true,
              previousGeneration: merged.previousGeneration!,
            },
            undefined,
          ),
        ).toEqual(merged);
      }),
    {fastCheck: {numRuns: 100}},
  );

  fcEffectProp(
    effectIt,
    'fails continuity closed when an intervening generation was not linked',
    {generation: FC.string({maxLength: 32})},
    ({generation}) =>
      Effect.sync(() => {
        const base = `${generation}:base`;
        const missing = `${generation}:missing`;
        const current = `${generation}:current`;
        const merged = mergeRecallIndexCanonicalMutationContinuity(
          {
            currentGeneration: base,
            pending: true,
            previousGeneration: `${generation}:indexed`,
          },
          {currentGeneration: current, previousGeneration: missing},
        );

        expect(merged).toEqual({
          continuous: false,
          currentGeneration: current,
          previousGeneration: missing,
        });
      }),
    {fastCheck: {numRuns: 100}},
  );

  effectIt.layer(RecallIndexTestLayer)(layerIt => {
    layerIt.effect('does not rescan an unchanged corpus after the former validation interval', () =>
      withRecallHome((home, fs, path) =>
        Effect.gen(function* () {
          const resourceRoot = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote');
          const resourcePath = path.join(resourceRoot, 'contract.md');
          const config = {account: 'local', agentContextHome: home, user: 'freshness-user'};
          yield* fs.makeDirectory(resourceRoot, {recursive: true});
          yield* fs.writeFileString(resourcePath, '# Contract\n\nfirst-version-anchor\n');
          yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});

          yield* fs.writeFileString(resourcePath, '# Contract\n\nsecond-version-anchor\n');
          yield* TestClock.adjust('31 seconds');
          const foregroundProgress: string[] = [];
          const cached = yield* loadRecallIndexData(config, {
            includeInactive: false,
            onProgress: progress =>
              Effect.sync(() => {
                foregroundProgress.push(progress.phase);
              }),
            query: 'first-version-anchor',
          });

          expect(foregroundProgress).toEqual([]);
          expect(cached.candidates[0]?.text).toContain('first-version-anchor');

          yield* expireRecallIndexValidation(home, false, ['threadnote://resources/repos/threadnote/contract.md']);
          const refreshed = yield* loadRecallIndexData(config, {
            includeInactive: false,
            query: 'second-version-anchor',
          });
          expect(refreshed.candidates[0]?.text).toContain('second-version-anchor');
        }),
      ),
    );
  });
});

function withRecallHome<A, E, R>(
  use: (home: string, fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectory({prefix: 'threadnote-recall-freshness-'});
    return yield* use(home, fs, path).pipe(
      Effect.ensuring(fs.remove(home, {force: true, recursive: true}).pipe(Effect.ignore)),
    );
  });
}
