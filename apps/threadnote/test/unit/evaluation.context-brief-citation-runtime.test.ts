import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import fc from 'fast-check';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  finalizeContextBriefCitationRuntimeEvaluation,
  parseContextBriefCitationRuntimeFixtureV1,
} from '@threadnote/threadnote/evaluation/context-brief-citation-runtime-contract';
import {evaluateContextBriefCitationRuntime} from '@threadnote/threadnote/evaluation/context-brief-citation-runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';

const FIXTURE_URL = new URL('../evaluation/fixtures/context-brief-citations-runtime-v1/fixture.json', import.meta.url);

describe('Context Brief citation actual-runtime evaluation', () => {
  effectIt.effect('runs capture, validation, legacy recall, and projection against frozen truth', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixturePath = yield* path.fromFileUrl(FIXTURE_URL);
      const fixture = parseContextBriefCitationRuntimeFixtureV1(
        JSON.parse(yield* fs.readFileString(fixturePath)) as unknown,
      );
      const result = yield* evaluateContextBriefCitationRuntime(fixture);

      expect(result.gate).toEqual({failures: [], passed: true});
      expect(result.contract).toMatchObject({matched: true});
      expect(result.quality).toMatchObject({
        crossRepositoryLeakageCount: 0,
        falseFreshRiskCount: 0,
        incompleteFalseDeletedCount: 0,
        incrementalCleanMismatchCount: 0,
        legacyRecallContinuity: 1,
        scenarioAccuracy: 1,
      });
      expect(new Map(EffectArray.map(result.observations, observation => [observation.id, observation]))).toMatchObject(
        new Map([
          ['exact-across-newer-snapshot', expect.objectContaining({observedStatus: 'exact'})],
          ['exact-incremental-snapshot', expect.objectContaining({observedStatus: 'exact'})],
          ['relocated-file', expect.objectContaining({observedFreshness: 'fresh', observedStatus: 'relocated'})],
          ['changed-file', expect.objectContaining({observedFreshness: 'stale', observedStatus: 'changed'})],
          [
            'deleted-from-complete-inventory',
            expect.objectContaining({observedFreshness: 'stale', observedStatus: 'deleted'}),
          ],
          ['ambiguous-relocation', expect.objectContaining({observedStatus: 'unknown'})],
          [
            'incomplete-graph-abstention',
            expect.objectContaining({observedStatus: 'unknown', validationEvidenceCalls: 0}),
          ],
          [
            'cross-repository-abstention',
            expect.objectContaining({observedStatus: 'unknown', validationEvidenceCalls: 0}),
          ],
          ['legacy-v1-recall-continuity', expect.objectContaining({observedRecallCount: 1})],
        ]),
      );
      expect(result.quality.maximumEstimatedTokens).toBeLessThanOrEqual(1_500);
      expect(result.measurements.validationMilliseconds.p95).toBeLessThanOrEqual(250);
      expect(result.measurements.contextBriefMilliseconds.p95).toBeLessThanOrEqual(1_500);

      fc.assert(
        fc.property(fc.nat({max: result.observations.length - 1}), offset => {
          const reordered = rotate(result.observations, offset);
          expect(finalizeContextBriefCitationRuntimeEvaluation(fixture, reordered)).toEqual(result);
        }),
        {numRuns: 25},
      );

      const unsafe = finalizeContextBriefCitationRuntimeEvaluation(
        fixture,
        EffectArray.map(result.observations, observation =>
          observation.id === 'incomplete-graph-abstention'
            ? {...observation, observedFreshness: 'fresh', observedStatus: 'deleted'}
            : observation,
        ),
      );
      expect(unsafe.gate.passed).toBe(false);
      expect(unsafe.quality).toMatchObject({falseFreshRiskCount: 1, incompleteFalseDeletedCount: 1});
      expect(unsafe.gate.failures).toEqual(
        expect.arrayContaining([
          'false-fresh risk count 1; required 0',
          'deleted statuses from incomplete coverage 1; required 0',
        ]),
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function rotate<T>(values: readonly T[], offset: number): readonly T[] {
  return [...values.slice(offset), ...values.slice(0, offset)];
}
