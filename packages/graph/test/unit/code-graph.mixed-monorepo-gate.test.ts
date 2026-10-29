import {Array as EffectArray} from 'effect';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import {
  MIXED_NX_BAZEL_FIXTURE_SOURCES,
  parseMixedNxBazelFixtureArguments,
} from '../../../../scripts/generate-mixed-nx-bazel-fixture.js';
import {
  type MixedNxBazelGateBudgets,
  type MixedNxBazelGateEvidence,
  validateMixedNxBazelGate,
} from '../../../../scripts/validate-mixed-nx-bazel-gate.js';

const budgets: MixedNxBazelGateBudgets = {
  maximum: {
    analysisMilliseconds: 15_000,
    analysisPeakRssBytes: 750 * 1_048_576,
    boundedStaleReadMilliseconds: 25_000,
    coldIndexMilliseconds: 287_340,
    crashRecoveryForegroundMilliseconds: 2_000,
    currentQueryMilliseconds: 1_000,
    inventoryMilliseconds: 2_000,
    oneFileIncrementalMilliseconds: 8_000,
    oneFileIncrementalPeakRssBytes: 512 * 1_048_576,
    postChurnStorageGrowthPercent: 10,
    stableNoopMilliseconds: 2_000,
  },
};

const passingEvidence: MixedNxBazelGateEvidence = {
  analysisMilliseconds: 14_999,
  analysisPeakRssBytes: 750 * 1_048_576,
  boundedStaleReadMilliseconds: 24_999,
  coldIndexMilliseconds: 287_340,
  crashRecoveryForegroundMilliseconds: 1_999,
  currentQueryMilliseconds: 999,
  inventoryMilliseconds: 1_999,
  movingTarget: {
    newestRefreshCoalesced: true,
    postTargetMaterializationMode: 'incremental-overlay',
    stagedFiles: 2,
    targetCommitExposed: true,
    totalFiles: 18_510,
  },
  oneFileIncrementalMilliseconds: 7_999,
  oneFileIncrementalPeakRssBytes: 512 * 1_048_576,
  postChurnStorageGrowthPercent: 9.9,
  stableNoopMilliseconds: 1_999,
};

describe('mixed Nx/Bazel release gate', () => {
  it.effect('pins the reviewed public repositories and accepts an explicit output only', () =>
    Effect.sync(() => {
      expect(EffectArray.map(MIXED_NX_BAZEL_FIXTURE_SOURCES, source => `${source.id}@${source.commit}`)).toEqual([
        'nx@2d15c7faa570629657112857a079803897e8e43d',
        'rules-js@0960bdd0f542a73a4a6fa3183d68ef5766cce285',
        'angular@8925a4ee491aebaf6a1a74880c73dfb20e0a4ba1',
      ]);
      expect(parseMixedNxBazelFixtureArguments(['--output', '/tmp/mixed-fixture'])).toEqual({
        output: '/tmp/mixed-fixture',
      });
      expect(() => parseMixedNxBazelFixtureArguments([])).toThrow(/--output/);
    }),
  );

  it.effect('enforces every latency, memory, storage, and moving-target contract', () =>
    Effect.sync(() => {
      expect(() => validateMixedNxBazelGate(passingEvidence, budgets)).not.toThrow();
      expect(() =>
        validateMixedNxBazelGate(
          {
            ...passingEvidence,
            oneFileIncrementalPeakRssBytes: budgets.maximum.oneFileIncrementalPeakRssBytes + 1,
            movingTarget: {...passingEvidence.movingTarget, postTargetMaterializationMode: 'full'},
          },
          budgets,
        ),
      ).toThrow(/oneFileIncrementalPeakRssBytes.*post-target refresh replayed a full graph/);
    }),
  );
});
