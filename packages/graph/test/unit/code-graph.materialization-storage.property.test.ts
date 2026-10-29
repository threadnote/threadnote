import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  initialMaterializationStorageTelemetry,
  observeMaterializationStorage,
  type MaterializationStorageFiles,
} from '@threadnote/graph/indexer/materialization';
import * as EffectRecord from 'effect/Record';

const bytes = FC.integer({max: 1_000_000_000, min: 0});
const storageFiles = FC.record({
  databaseBytes: bytes,
  journalBytes: bytes,
  sharedMemoryBytes: bytes,
  sidecarDatabaseBytes: bytes,
  sidecarJournalBytes: bytes,
  sidecarSharedMemoryBytes: bytes,
  sidecarWalBytes: bytes,
  walBytes: bytes,
}).map(
  fields =>
    ({
      ...fields,
      totalBytes: EffectArray.reduce(EffectRecord.values(fields), 0, (total, value) => total + value),
    }) satisfies MaterializationStorageFiles,
);

fcProp(
  it,
  'keeps every physical storage high-water monotone while current bytes follow the latest observation',
  {
    includeSidecar: FC.boolean(),
    observations: FC.array(storageFiles, {maxLength: 20, minLength: 1}),
  },
  ({includeSidecar, observations}) => {
    const original = structuredClone(observations);
    let telemetry = initialMaterializationStorageTelemetry(observations[0], includeSidecar);
    for (const observation of observations.slice(1)) {
      const previous = telemetry;
      telemetry = observeMaterializationStorage(telemetry, observation);
      expect(telemetry.durableDatabaseFileHighWaterBytes).toBeGreaterThanOrEqual(
        previous.durableDatabaseFileHighWaterBytes,
      );
      expect(telemetry.durableFilesystemHighWaterBytes).toBeGreaterThanOrEqual(
        previous.durableFilesystemHighWaterBytes,
      );
      expect(telemetry.durableJournalHighWaterBytes).toBeGreaterThanOrEqual(previous.durableJournalHighWaterBytes);
      expect(telemetry.durableSharedMemoryHighWaterBytes).toBeGreaterThanOrEqual(
        previous.durableSharedMemoryHighWaterBytes,
      );
      expect(telemetry.durableWalHighWaterBytes).toBeGreaterThanOrEqual(previous.durableWalHighWaterBytes);
    }

    const latest = observations.at(-1)!;
    expect(telemetry).toMatchObject({
      durableDatabaseFileBytes: latest.databaseBytes,
      durableDatabaseFileHighWaterBytes: Math.max(...EffectArray.map(observations, value => value.databaseBytes)),
      durableDatabaseGrowthBytes: Math.max(0, latest.databaseBytes - observations[0].databaseBytes),
      durableDatabaseGrowthHighWaterBytes: Math.max(
        ...EffectArray.map(observations, value => Math.max(0, value.databaseBytes - observations[0].databaseBytes)),
      ),
      durableDatabaseStartBytes: observations[0].databaseBytes,
      durableFilesystemBytes: latest.totalBytes,
      durableFilesystemHighWaterBytes: Math.max(...EffectArray.map(observations, value => value.totalBytes)),
      durableJournalBytes: latest.journalBytes,
      durableJournalHighWaterBytes: Math.max(...EffectArray.map(observations, value => value.journalBytes)),
      durableSharedMemoryBytes: latest.sharedMemoryBytes,
      durableSharedMemoryHighWaterBytes: Math.max(...EffectArray.map(observations, value => value.sharedMemoryBytes)),
      durableWalBytes: latest.walBytes,
      durableWalHighWaterBytes: Math.max(...EffectArray.map(observations, value => value.walBytes)),
    });
    if (includeSidecar) {
      expect(telemetry).toMatchObject({
        durableSidecarDatabaseBytes: latest.sidecarDatabaseBytes,
        durableSidecarDatabaseHighWaterBytes: Math.max(
          ...EffectArray.map(observations, value => value.sidecarDatabaseBytes),
        ),
        durableSidecarJournalBytes: latest.sidecarJournalBytes,
        durableSidecarJournalHighWaterBytes: Math.max(
          ...EffectArray.map(observations, value => value.sidecarJournalBytes),
        ),
        durableSidecarWalBytes: latest.sidecarWalBytes,
        durableSidecarWalHighWaterBytes: Math.max(...EffectArray.map(observations, value => value.sidecarWalBytes)),
      });
    } else {
      expect(telemetry.durableSidecarDatabaseBytes).toBeUndefined();
      expect(telemetry.durableSidecarJournalBytes).toBeUndefined();
      expect(telemetry.durableSidecarWalBytes).toBeUndefined();
    }
    expect(observations).toEqual(original);
  },
  {fastCheck: {numRuns: 150}},
);
