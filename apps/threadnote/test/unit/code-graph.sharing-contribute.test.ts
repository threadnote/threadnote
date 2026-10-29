import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {it} from 'vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  enqueuePersistedGraphShareContribution,
  acknowledgeGraphShareContributions,
  readGraphShareContributionQueue,
  removeAcknowledgedGraphShareContributions,
  pruneGraphShareContributionQueue,
  GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS,
  GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS,
  GRAPH_SHARE_QUEUE_MAXIMUM_BYTES,
  prunePersistedGraphShareContributionQueue,
  writeGraphShareContributionQueue,
} from '@threadnote/graph/sharing/contribution';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

const sharingLayer = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));

const announcement = {
  actionKey: Effect2.pipe('a', EffectString.repeat(64)),
  attestationDigest: sha256Digest('1'),
  batchId: Effect2.pipe('b', EffectString.repeat(40)),
  resultManifestDigest: sha256Digest('2'),
  semanticDigest: sha256Digest('3'),
};

describe('graph share contribution queue persistence', () => {
  it('bounds metadata retention while preserving the newest unexpired announcements', () => {
    const now = GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS + 1_000;
    const announcements = Array.from({length: GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS + 10}, (_, index) => ({
      ...announcement,
      actionKey: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
    }));
    const queue = {
      announcements,
      mode: 'passive' as const,
      schemaVersion: 1 as const,
      queuedAtMilliseconds: EffectArray.map(announcements, (_, index) => (index < 5 ? 0 : now)),
    };
    const before = JSON.stringify(queue);
    const pruned = pruneGraphShareContributionQueue(queue, now);
    expect(pruned.announcements).toEqual(announcements.slice(-GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS));
    expect(pruneGraphShareContributionQueue(pruned, now)).toEqual(pruned);
    expect(JSON.stringify(queue)).toBe(before);
    expect(
      pruneGraphShareContributionQueue(pruned, now + GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS + 1).announcements,
    ).toEqual([]);
  });

  it('pruning is idempotent, immutable and retains only unexpired entries within count and byte bounds', () => {
    FC.assert(
      FC.property(
        FC.array(FC.integer({min: 0, max: 2 * GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS}), {maxLength: 600}),
        timestamps => {
          const now = GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS + 100;
          const queue = {
            announcements: EffectArray.map(timestamps, (_, index) => ({
              ...announcement,
              batchId: Effect2.pipe(index.toString(16), EffectString.padStart(40, '0')),
            })),
            mode: 'passive' as const,
            schemaVersion: 1 as const,
            queuedAtMilliseconds: timestamps,
          };
          const before = JSON.stringify(queue);
          const pruned = pruneGraphShareContributionQueue(queue, now);
          const expected = EffectArray.filter(
            queue.announcements,
            (_, index) => timestamps[index] >= now - GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS,
          ).slice(-GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS);
          expect(pruned.announcements).toEqual(expected);
          expect(
            EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(pruned.queuedAtMilliseconds), __effectArrayReceiver =>
                EffectArray.every(
                  __effectArrayReceiver,
                  timestamp => timestamp <= now && timestamp >= now - GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS,
                ),
              ),
            ),
          ).toBe(true);
          expect(new TextEncoder().encode(JSON.stringify(pruned)).byteLength).toBeLessThanOrEqual(
            GRAPH_SHARE_QUEUE_MAXIMUM_BYTES,
          );
          expect(pruneGraphShareContributionQueue(pruned, now)).toEqual(pruned);
          expect(JSON.stringify(queue)).toBe(before);
        },
      ),
      {numRuns: 50},
    );
  });

  effectIt.effect('removes aged announcements from disk even when contributions are off', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-queue-retention-'});
        const repositoryId = Effect2.pipe('c', EffectString.repeat(64));
        yield* writeGraphShareContributionQueue(home, repositoryId, {
          announcements: [announcement],
          mode: 'off',
          schemaVersion: 1,
          queuedAtMilliseconds: [0],
        });
        yield* prunePersistedGraphShareContributionQueue(home, repositoryId, 'off');
        expect(
          JSON.parse(yield* fs.readFileString(`${home}/graph-sharing/contribution/${repositoryId}.json`)).announcements,
        ).toEqual([]);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  it('acknowledgement preserves unsent order and is idempotent without mutating its inputs', () => {
    FC.assert(
      FC.property(FC.array(FC.boolean(), {maxLength: 32}), flags => {
        const announcements = EffectArray.map(flags, (_, index) => ({
          ...announcement,
          batchId: Effect2.pipe(index.toString(16), EffectString.padStart(40, '0')),
        }));
        const queue = {
          announcements,
          mode: 'passive' as const,
          schemaVersion: 1 as const,
          queuedAtMilliseconds: EffectArray.map(flags, (_, index) => index * 1_000),
        };
        const sent = EffectArray.filter(announcements, (_, index) => index in announcements && flags[index]);
        const before = JSON.stringify({queue, sent});
        const remaining = removeAcknowledgedGraphShareContributions(queue, sent);
        expect(remaining.announcements).toEqual(EffectArray.filter(announcements, (_, index) => !flags[index]));
        expect(remaining.queuedAtMilliseconds).toEqual(
          EffectArray.filter(queue.queuedAtMilliseconds, (_, index) => !flags[index]),
        );
        expect(removeAcknowledgedGraphShareContributions(remaining, sent)).toEqual(remaining);
        expect(JSON.stringify({queue, sent})).toBe(before);
      }),
      {numRuns: 50},
    );
  });

  effectIt.effect('quarantines an oversized legacy backlog and admits fresh bounded work', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-queue-upgrade-'});
        const repositoryId = Effect2.pipe('c', EffectString.repeat(64));
        const legacy = {
          announcements: Array.from({length: 12_000}, (_, index) => ({
            ...announcement,
            actionKey: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
          })),
          mode: 'passive' as const,
          schemaVersion: 1 as const,
        };
        yield* writeGraphShareContributionQueue(home, repositoryId, legacy);
        const target = `${home}/graph-sharing/contribution/${repositoryId}.json`;
        const oldSize = Number((yield* fs.stat(target)).size);
        expect(oldSize).toBeGreaterThan(4 * 1_024 * 1_024);
        const fresh = {...announcement, actionKey: Effect2.pipe('f', EffectString.repeat(64))};
        expect(
          (yield* enqueuePersistedGraphShareContribution(home, repositoryId, 'join', fresh, 'passive')).queued,
        ).toBe(true);
        expect((yield* readGraphShareContributionQueue(home, repositoryId, 'passive')).announcements).toEqual([fresh]);
        expect(Number((yield* fs.stat(`${target}.oversized`)).size)).toBe(oldSize);
        expect(Number((yield* fs.stat(target)).size)).toBeLessThanOrEqual(GRAPH_SHARE_QUEUE_MAXIMUM_BYTES);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('acknowledges a drained snapshot without dropping contributions queued during upload', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-queue-ack-'});
        const repositoryId = Effect2.pipe('c', EffectString.repeat(64));
        yield* enqueuePersistedGraphShareContribution(home, repositoryId, 'join', announcement, 'passive');
        const snapshot = yield* readGraphShareContributionQueue(home, repositoryId, 'passive');
        const added = {...announcement, actionKey: Effect2.pipe('d', EffectString.repeat(64))};
        yield* enqueuePersistedGraphShareContribution(home, repositoryId, 'join', added, 'passive');
        yield* acknowledgeGraphShareContributions(home, repositoryId, snapshot.announcements, 'passive');
        yield* acknowledgeGraphShareContributions(home, repositoryId, snapshot.announcements, 'passive');
        expect((yield* readGraphShareContributionQueue(home, repositoryId, 'passive')).announcements).toEqual([added]);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('retains every distinct contribution from concurrent producers', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-queue-concurrent-'});
        const repositoryId = Effect2.pipe('c', EffectString.repeat(64));
        const additions = Array.from({length: 12}, (_, index) => ({
          ...announcement,
          actionKey: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
        }));
        yield* Effect.forEach(
          additions,
          item => enqueuePersistedGraphShareContribution(home, repositoryId, 'join', item, 'passive'),
          {concurrency: 12},
        );
        const persisted = yield* readGraphShareContributionQueue(home, repositoryId, 'passive');
        expect(new Set(EffectArray.map(persisted.announcements, item => item.actionKey))).toEqual(
          new Set(EffectArray.map(additions, item => item.actionKey)),
        );
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('queues locally when the coordinator is down and round-trips the queue', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-queue-'});
      const repositoryId = Effect2.pipe('c', EffectString.repeat(64));
      const first = yield* enqueuePersistedGraphShareContribution(home, repositoryId, 'join', announcement, 'passive');
      expect(first.queued).toBe(true);
      if ((yield* SystemInfo).platform !== 'win32') {
        expect((yield* fs.stat(`${home}/graph-sharing/contribution`)).mode & 0o777).toBe(0o700);
      }
      const duplicate = yield* enqueuePersistedGraphShareContribution(
        home,
        repositoryId,
        'join',
        announcement,
        'passive',
      );
      expect(duplicate.queued).toBe(false);
      const loaded = yield* readGraphShareContributionQueue(home, repositoryId, 'passive');
      expect(loaded.announcements).toHaveLength(1);
      const blocked = yield* enqueuePersistedGraphShareContribution(
        home,
        `${Effect2.pipe(repositoryId, EffectString.slice(0, -1))}d`,
        'read-only',
        announcement,
        'passive',
      );
      expect(blocked.queued).toBe(false);
    }).pipe(provideTestLayer(sharingLayer)),
  );
});
