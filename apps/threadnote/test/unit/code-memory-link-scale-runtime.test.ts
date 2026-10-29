import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH,
  CODE_MEMORY_LINK_SCALE_SCENARIOS,
} from '@threadnote/threadnote/evaluation/code-memory-link-scale-contract';
import {runCodeMemoryLinkScaleWorkload} from '@threadnote/threadnote/evaluation/code-memory-link-scale';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('code-memory-link inverse-selector scale runtime', () => {
  effectIt.effect('uses the production recall index and canonical reread for a bounded development corpus', () =>
    Effect.gen(function* () {
      const capture = yield* runCodeMemoryLinkScaleWorkload({memoryCandidates: 256, samples: 3, warmups: 1});

      expect(capture.fixtureHash).toBe(CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH);
      expect(capture.corpus).toMatchObject({
        denseBacklinkMemoryCount: 252,
        directBacklinkMemoryCount: 3,
        indexedMemoryCount: 256,
        isolationDecoyMemoryCount: 1,
        materializedMemoryCount: 256,
        noiseMemoryCount: 252,
      });
      expect(capture.corpus.corpusBytes).toBeGreaterThan(0);
      expect(capture.resources.recallDatabaseBytes).toBeGreaterThan(0);
      expect(capture.resources.recallStorageBytes).toBeGreaterThanOrEqual(capture.resources.recallDatabaseBytes);
      expect(EffectArray.map(capture.scenarios, scenario => scenario.id)).toEqual(CODE_MEMORY_LINK_SCALE_SCENARIOS);
      for (const scenario of capture.scenarios) {
        const observations = [scenario.cold, ...scenario.warmups, ...scenario.samples];
        expect(observations).toHaveLength(5);
        expect(EffectArray.every(observations, observation => observation.canonicalMismatchCount === 0)).toBe(true);
        expect(
          EffectArray.every(
            observations,
            observation => observation.truncatedSelectorCount === scenario.expectedTruncatedSelectorCount,
          ),
        ).toBe(true);
        expect(EffectArray.every(observations, observation => observation.returnedUris.length <= 8)).toBe(true);
        expect(
          EffectArray.every(
            observations,
            observation => JSON.stringify(observation.returnedUris) === JSON.stringify(scenario.expectedUris),
          ),
        ).toBe(true);
      }
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(capture.scenarios, scenario => scenario.id === 'file-backlinks'),
        )?.expectedUris,
      ).toHaveLength(2);
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(capture.scenarios, scenario => scenario.id === 'symbol-backlink'),
        )?.expectedUris,
      ).toHaveLength(1);
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(capture.scenarios, scenario => scenario.id === 'dense-shared-selector'),
        )?.expectedUris,
      ).toHaveLength(8);
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(capture.scenarios, scenario => scenario.id === 'no-answer'))
          ?.expectedUris,
      ).toEqual([]);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a corpus too small to contain the frozen sparse controls', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(runCodeMemoryLinkScaleWorkload({memoryCandidates: 3, samples: 1, warmups: 0}));
      expect(String(exit)).toContain('at least 12');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
