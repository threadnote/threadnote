import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {graphShareContributionFixture} from '@threadnote/graph/test/helpers/graph-share-contribution';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {putCasBytes} from '@threadnote/graph/sharing/cas';
import {
  enqueuePersistedGraphShareContribution,
  readGraphShareContributionQueue,
} from '@threadnote/graph/sharing/contribution';
import {
  readContributionRetryState,
  writeContributionRetryState,
} from '@threadnote/graph/sharing/contribution/retry_state';
import {sha256Digest, sha256HexFromDigest} from '@threadnote/graph/sharing/digest';
import {drainQueuedGraphShareContributions} from '@threadnote/graph/sharing/parse/cache';
import {defaultGraphShareProfile, graphShareProfileDigest} from '@threadnote/graph/sharing/profile';
import {writeGraphShareTrustReceipt} from '@threadnote/graph/sharing/trust';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const layer = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer), Layer.provideMerge(BunHttpClient.layer));

const fixture = Effect.fn('test.contributionDeliveryFixture')(function* (
  reply: (request: Request) => Response | Promise<Response>,
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-contribution-delivery-'});
  const cas = `${home}/cas`;
  const repositoryId = Effect2.pipe('a', EffectString.repeat(64));
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => Bun.serve({hostname: '127.0.0.1', port: 0, fetch: reply})),
    server => Effect.promise(() => server.stop(true)),
  );
  const publisherKeyFingerprint = sha256Digest('publisher');
  const coordinatorUrl = `http://127.0.0.1:${server.port}`;
  const profile = defaultGraphShareProfile({
    branch: 'main',
    canonicalRemote: 'github.com/acme/contribution-delivery',
    coordinatorUrl,
    organization: 'acme',
    publisherKeyFingerprint,
    repositoryId,
  });
  const profileDigest = graphShareProfileDigest(profile);
  yield* putCasBytes(cas, new TextEncoder().encode(canonicalJson(profile)));
  const trust = {
    accessMode: 'join' as const,
    organization: 'acme',
    policyVersion: 1 as const,
    profileDigest,
    publisherKeyFingerprint,
    registryCanonical: 'cas://local',
    repositoryId,
    client: {casRoot: cas, contributionMode: 'passive' as const, coordinatorUrl},
  };
  yield* writeGraphShareTrustReceipt(home, trust);
  const contribution = graphShareContributionFixture(repositoryId);
  yield* putCasBytes(cas, contribution.resultBytes);
  yield* putCasBytes(cas, contribution.attestationBytes);
  yield* enqueuePersistedGraphShareContribution(home, repositoryId, 'join', contribution.announcement, 'passive');
  return {
    home,
    cas,
    repositoryId,
    trust,
    contribution,
    drain: drainQueuedGraphShareContributions({
      identity: {repositoryId},
      threadnoteHome: home,
      propagateUnavailable: true,
    }),
  };
});

describe('automatic contribution delivery boundaries', () => {
  effectIt.effect('persists server backpressure across independent rounds and pauses authorization failures', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        let requests = 0;
        let status = 429;
        const f = yield* fixture(async request => {
          await request.arrayBuffer();
          requests++;
          return Response.json({}, {status, headers: {'Retry-After': '120'}});
        });
        const before = yield* Clock.currentTimeMillis;
        expect(Result.isFailure(yield* f.drain.pipe(Effect.result))).toBe(true);
        const backoff = (yield* readContributionRetryState(f.home, f.repositoryId))!;
        expect(backoff.nextAttempt).toBeGreaterThanOrEqual(before + 120_000);
        expect(yield* drainQueuedGraphShareContributions({identity: f.trust, threadnoteHome: f.home})).toEqual({
          sent: 0,
        });
        expect(requests).toBe(1);
        status = 401;
        yield* writeContributionRetryState(f.home, f.repositoryId, {...backoff, nextAttempt: 0});
        expect(Result.isFailure(yield* f.drain.pipe(Effect.result))).toBe(true);
        expect((yield* readContributionRetryState(f.home, f.repositoryId))?.nextAttempt).toBeGreaterThanOrEqual(
          before + 3_600_000,
        );
        expect((yield* readGraphShareContributionQueue(f.home, f.repositoryId, 'passive')).announcements).toHaveLength(
          1,
        );
        expect(yield* f.drain).toEqual({sent: 0});
        expect(requests).toBe(2);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('refuses corrupted artifact bytes before making any outbound request', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        let requests = 0;
        const f = yield* fixture(() => {
          requests++;
          return Response.json({});
        });
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${f.cas}/sha256/${sha256HexFromDigest(f.contribution.announcement.resultManifestDigest)}`,
          '{"raw":"untrusted content"}',
        );
        expect(yield* f.drain).toEqual({sent: 0});
        expect(requests).toBe(0);
        expect((yield* readGraphShareContributionQueue(f.home, f.repositoryId, 'passive')).announcements).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('discards obsolete local cache references while delivering newer valid work', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        let requests = 0;
        const f = yield* fixture(async request => {
          await request.arrayBuffer();
          requests++;
          return Response.json({});
        });
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(`${f.cas}/sha256/${sha256HexFromDigest(f.contribution.announcement.resultManifestDigest)}`);
        for (let index = 0; index < 8; index++) {
          yield* enqueuePersistedGraphShareContribution(
            f.home,
            f.repositoryId,
            'join',
            {
              ...f.contribution.announcement,
              actionKey: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
            },
            'passive',
          );
        }
        const fresh = graphShareContributionFixture(f.repositoryId, 'src/new.ts');
        yield* putCasBytes(f.cas, fresh.resultBytes);
        yield* putCasBytes(f.cas, fresh.attestationBytes);
        yield* enqueuePersistedGraphShareContribution(f.home, f.repositoryId, 'join', fresh.announcement, 'passive');
        expect(yield* f.drain).toEqual({sent: 0});
        expect(yield* f.drain).toEqual({sent: 1});
        expect(requests).toBe(4);
        expect((yield* readGraphShareContributionQueue(f.home, f.repositoryId, 'passive')).announcements).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('serializes competing delivery rounds without duplicate uploads', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        let requests = 0;
        const f = yield* fixture(async request => {
          await request.arrayBuffer();
          requests++;
          return Response.json({});
        });
        const rounds = yield* Effect.all([f.drain, f.drain, f.drain], {concurrency: 3});
        expect(EffectArray.reduce(rounds, 0, (sum, round) => sum + round.sent)).toBe(1);
        expect(requests).toBe(4);
        expect((yield* readGraphShareContributionQueue(f.home, f.repositoryId, 'passive')).announcements).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('honors off and read-only without sending queued work', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        let requests = 0;
        const f = yield* fixture(() => {
          requests++;
          return Response.json({});
        });
        yield* writeGraphShareTrustReceipt(f.home, {...f.trust, client: {...f.trust.client, contributionMode: 'off'}});
        expect(yield* f.drain).toEqual({sent: 0});
        yield* writeGraphShareTrustReceipt(f.home, {...f.trust, accessMode: 'read-only'});
        expect(yield* f.drain).toEqual({sent: 0});
        expect(requests).toBe(0);
      }).pipe(provideTestLayer(layer)),
    ),
  );
});
