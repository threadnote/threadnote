import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {graphShareContributionFixture} from '@threadnote/graph/test/helpers/graph-share-contribution';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {casBlobPath, putCasBytes} from '@threadnote/graph/sharing/cas';
import {
  runGraphContributeSet,
  runGraphContributeStatus,
  runGraphShareJoin,
  runGraphShareLeave,
} from '@threadnote/graph/sharing/client';
import {casProfilePointer, defaultGraphShareProfile} from '@threadnote/graph/sharing/profile';
import {
  lookupGraphShareTrustReceipt,
  readGraphShareClientState,
  patchGraphShareClientState,
  trustReceiptFromEnrollment,
  writeGraphShareTrustReceipt,
  writeGraphShareRepositoryContributionMode,
} from '@threadnote/graph/sharing/trust';
import {resolveGraphShareRepositoryClient} from '@threadnote/graph/sharing/client/state';
import {drainQueuedGraphShareContributions} from '@threadnote/graph/sharing/parse/cache';
import {
  effectiveGraphShareContributionPolicy,
  enqueuePersistedGraphShareContribution,
  readGraphShareContributionQueue,
} from '@threadnote/graph/sharing/contribution';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {runCommandEffect} from '@threadnote/platform/command';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const layer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer),
);

describe('repository-scoped graph sharing settings', () => {
  fcEffectProp(
    effectIt,
    'lower upload budgets never enable delivery and inactive modes never upload',
    {
      budgets: FC.tuple(FC.constantFrom(0, 0, 1, 1_024), FC.integer({min: 1, max: 1_000_000_000})),
      requested: FC.constantFrom('off', 'passive', 'idle', 'dedicated'),
    },
    ({budgets, requested}) =>
      Effect.sync(() => {
        const lower = Math.min(...budgets);
        const higher = Math.max(...budgets);
        const lowerPolicy = effectiveGraphShareContributionPolicy('join', requested, lower);
        const higherPolicy = effectiveGraphShareContributionPolicy('join', requested, higher);
        expect(lowerPolicy.deliveryPausedReason === undefined && higherPolicy.deliveryPausedReason !== undefined).toBe(
          false,
        );
        if (requested !== 'off' && lower === 0) {
          expect(lowerPolicy.deliveryPausedReason).toBe('organization-upload-disabled');
          expect(higherPolicy.deliveryPausedReason).toBeUndefined();
        }
        if (requested === 'off') expect(higherPolicy.deliveryPausedReason).toBe('mode-off');
        expect(effectiveGraphShareContributionPolicy('read-only', requested, higher).deliveryPausedReason).toBe(
          'mode-off',
        );
      }),
    {fastCheck: {numRuns: 50}},
  );

  fcEffectProp(
    effectIt,
    'updates only the selected repository under arbitrary contribution-mode changes',
    {
      changes: FC.array(FC.tuple(FC.boolean(), FC.constantFrom('off', 'passive', 'idle', 'dedicated')), {
        maxLength: 12,
      }),
    },
    ({changes}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mode-property-'});
        const receipts = EffectArray.map(['a', 'b'], id => ({
          accessMode: 'join' as const,
          client: {
            casRoot: `${home}/${id}`,
            contributionMode: 'passive' as const,
            coordinatorUrl: `https://${id}.example.invalid`,
          },
          organization: 'acme',
          policyVersion: 1 as const,
          profileDigest: sha256Digest(id),
          publisherKeyFingerprint: sha256Digest('publisher'),
          registryCanonical: 'cas://local',
          repositoryId: Effect2.pipe(id, EffectString.repeat(64)),
        }));
        for (const receipt of receipts) yield* writeGraphShareTrustReceipt(home, receipt);
        const expected = ['passive', 'passive'];
        for (const [first, mode] of changes) {
          const index = first ? 0 : 1;
          const receipt = receipts[index];
          yield* writeGraphShareRepositoryContributionMode(home, receipt, receipt.client, mode);
          expected[index] = mode;
          for (const [ordinal, entry] of receipts.entries()) {
            expect(yield* lookupGraphShareTrustReceipt(home, entry.repositoryId)).toEqual({
              ...entry,
              client: {...entry.client, contributionMode: expected[ordinal]},
            });
          }
        }
      }).pipe(provideTestLayer(layer)),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('delivers each queue only to its repository endpoint and safely resolves legacy settings', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-repository-delivery-'});
        const config = runtimeConfig(root);
        const destinations: string[][] = [[], []];
        const servers = yield* Effect.forEach(destinations, requests =>
          Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                hostname: '127.0.0.1',
                port: 0,
                fetch: async request => {
                  requests.push(await request.text());
                  return Response.json({});
                },
              }),
            ),
            server => Effect.promise(() => server.stop(true)),
          ),
        );
        const a = yield* fixture(root, 'a', `http://127.0.0.1:${servers[0].port}`);
        const b = yield* fixture(root, 'b', `http://127.0.0.1:${servers[1].port}`);
        yield* runGraphShareJoin(config, {cwd: a.repo, cas: a.cas});
        yield* runGraphShareJoin(config, {cwd: b.repo, cas: b.cas});
        const {announcement, resultBytes, attestationBytes} = graphShareContributionFixture(a.repositoryId);
        yield* putCasBytes(a.cas, resultBytes);
        yield* putCasBytes(a.cas, attestationBytes);
        const enqueue = enqueuePersistedGraphShareContribution(
          config.agentContextHome,
          a.repositoryId,
          'join',
          announcement,
          'passive',
        );
        const drain = drainQueuedGraphShareContributions({identity: a, threadnoteHome: config.agentContextHome});
        yield* enqueue;
        expect(yield* drain).toEqual({sent: 1});
        expect(destinations[0]).toHaveLength(4);
        expect(destinations[1]).toEqual([]);
        const receipt = (yield* lookupGraphShareTrustReceipt(config.agentContextHome, a.repositoryId))!;
        const {client: _client, ...legacyReceipt} = receipt;
        yield* writeGraphShareTrustReceipt(config.agentContextHome, legacyReceipt);
        yield* patchGraphShareClientState(config.agentContextHome, {
          casRoot: a.cas,
          coordinatorUrl: b.coordinator,
          contributionMode: 'dedicated',
        });
        expect(yield* resolveGraphShareRepositoryClient(config.agentContextHome, legacyReceipt)).toMatchObject({
          coordinatorUrl: a.coordinator,
          contributionMode: 'passive',
        });
        yield* enqueue;
        expect(yield* drain).toEqual({sent: 1});
        expect(destinations[0]).toHaveLength(8);
        expect(destinations[1]).toEqual([]);
        yield* patchGraphShareClientState(config.agentContextHome, {contributionMode: 'off'});
        yield* enqueue;
        expect(yield* drain).toEqual({sent: 0});
        yield* runGraphShareJoin(config, {cwd: a.repo});
        expect((yield* runGraphContributeStatus(config, {cwd: a.repo})).mode).toBe('off');
        expect(yield* drain).toEqual({sent: 0});
        yield* runGraphShareLeave(config, {cwd: a.repo});
        expect(yield* drain).toEqual({sent: 0});
        expect(destinations[0]).toHaveLength(8);
        expect(destinations[1]).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('pauses legacy delivery at a zero profile upload budget without dropping queued results', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-zero-upload-'});
        const requests: string[] = [];
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: '127.0.0.1',
              port: 0,
              fetch: async request => {
                requests.push(request.method);
                return Response.json({});
              },
            }),
          ),
          server => Effect.promise(() => server.stop(true)),
        );
        const item = yield* fixture(root, 'zero', `http://127.0.0.1:${server.port}`, 'passive', 0);
        const config = runtimeConfig(root);
        yield* runGraphShareJoin(config, {cwd: item.repo, cas: item.cas});
        const {announcement, resultBytes, attestationBytes} = graphShareContributionFixture(item.repositoryId);
        yield* putCasBytes(item.cas, resultBytes);
        yield* putCasBytes(item.cas, attestationBytes);
        yield* enqueuePersistedGraphShareContribution(
          config.agentContextHome,
          item.repositoryId,
          'join',
          announcement,
          'passive',
        );
        expect(yield* runGraphContributeStatus(config, {cwd: item.repo})).toMatchObject({
          mode: 'passive',
          resourcePolicy: {
            declaredMaximumUploadBytesPerSecond: 0,
            deliveryPausedReason: 'organization-upload-disabled',
            positiveUploadRateLimitEnforced: false,
          },
        });
        expect(
          yield* drainQueuedGraphShareContributions({identity: item, threadnoteHome: config.agentContextHome}),
        ).toEqual({sent: 0});
        expect(requests).toEqual([]);
        expect(
          (yield* readGraphShareContributionQueue(config.agentContextHome, item.repositoryId, 'passive')).announcements,
        ).toEqual([announcement]);
        yield* fs.remove(yield* casBlobPath(item.cas, item.digest));
        expect(yield* runGraphContributeStatus(config, {cwd: item.repo})).toMatchObject({
          mode: 'passive',
          queued: 1,
          resourcePolicy: {
            deliveryPausedReason: 'profile-unavailable',
            verification: 'unavailable',
          },
        });
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('refuses a legacy profile whose content does not match the repository trust pins', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-legacy-pins-'});
      const a = yield* fixture(root, 'a');
      const b = yield* fixture(root, 'b');
      const config = runtimeConfig(root);
      const receipt = trustReceiptFromEnrollment(
        {
          schemaVersion: 1,
          repositoryId: b.repositoryId,
          profile: casProfilePointer(a.digest),
          publisherKeyFingerprint: a.profile.trust.publisherKeys[0],
        },
        a.profile,
        a.digest,
        'join',
      );
      yield* patchGraphShareClientState(config.agentContextHome, {casRoot: a.cas, coordinatorUrl: b.coordinator});
      expect(
        Result.isFailure(
          yield* resolveGraphShareRepositoryClient(config.agentContextHome, receipt).pipe(Effect.result),
        ),
      ).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('starts unsupported profile contribution modes as passive until explicitly selected', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-idle-profile-'});
      const config = runtimeConfig(root);
      for (const mode of ['idle', 'dedicated'] as const) {
        const repository = yield* fixture(root, mode, undefined, mode);
        yield* runGraphShareJoin(config, {cwd: repository.repo, cas: repository.cas});
        expect(yield* runGraphContributeStatus(config, {cwd: repository.repo})).toMatchObject({
          mode: 'passive',
          requestedMode: 'passive',
        });
        expect(
          (yield* lookupGraphShareTrustReceipt(config.agentContextHome, repository.repositoryId))?.client
            ?.contributionMode,
        ).toBe('passive');
      }
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('keeps joined repositories transport and contribution choices independent', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-repository-settings-'});
        const config = runtimeConfig(root);
        const a = yield* fixture(root, 'a');
        const b = yield* fixture(root, 'b');
        yield* runGraphShareJoin(config, {cwd: a.repo, cas: a.cas});
        yield* runGraphContributeSet(config, {cwd: a.repo, mode: 'off'});
        yield* runGraphShareJoin(config, {cwd: b.repo, cas: b.cas});
        expect((yield* runGraphContributeStatus(config, {cwd: b.repo})).mode).toBe('passive');
        expect((yield* runGraphContributeSet(config, {cwd: b.repo, mode: 'dedicated'})).mode).toBe('passive');
        expect(yield* runGraphContributeStatus(config, {cwd: b.repo})).toMatchObject({
          mode: 'passive',
          requestedMode: 'dedicated',
        });
        expect(
          (yield* lookupGraphShareTrustReceipt(config.agentContextHome, b.repositoryId))?.client?.contributionMode,
        ).toBe('dedicated');
        expect(yield* runGraphContributeSet(config, {cwd: b.repo, mode: 'idle'})).toMatchObject({
          mode: 'passive',
          requestedMode: 'idle',
        });
        expect(yield* runGraphContributeStatus(config, {cwd: b.repo})).toMatchObject({
          mode: 'passive',
          requestedMode: 'idle',
        });
        yield* runGraphShareJoin(config, {cwd: b.repo, cas: b.cas});
        expect(yield* runGraphContributeStatus(config, {cwd: b.repo})).toMatchObject({
          mode: 'passive',
          requestedMode: 'idle',
        });
        expect((yield* runGraphContributeStatus(config, {cwd: a.repo})).mode).toBe('off');
        expect(yield* readGraphShareClientState(config.agentContextHome)).toEqual({schemaVersion: 1});
        for (const item of [a, b]) {
          expect(yield* lookupGraphShareTrustReceipt(config.agentContextHome, item.repositoryId)).toMatchObject({
            profileDigest: item.digest,
            client: {casRoot: item.cas, coordinatorUrl: item.coordinator},
          });
        }
        yield* runGraphShareJoin(config, {cwd: a.repo});
        expect((yield* runGraphContributeStatus(config, {cwd: a.repo})).mode).toBe('off');
        yield* runGraphShareJoin(config, {cwd: b.repo, readOnly: true});
        yield* runGraphContributeSet(config, {cwd: b.repo, mode: 'dedicated'});
        expect((yield* runGraphContributeStatus(config, {cwd: b.repo})).mode).toBe('off');
        yield* runGraphShareLeave(config, {cwd: b.repo});
        yield* runGraphContributeSet(config, {cwd: b.repo, mode: 'passive'});
        expect(yield* lookupGraphShareTrustReceipt(config.agentContextHome, b.repositoryId)).toBeUndefined();
        expect((yield* runGraphContributeStatus(config, {cwd: a.repo})).mode).toBe('off');
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('leaves all existing settings intact when another join fails', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-repository-join-failure-'});
        const config = runtimeConfig(root);
        const a = yield* fixture(root, 'a');
        const b = yield* fixture(root, 'b');
        yield* runGraphShareJoin(config, {cwd: a.repo, cas: a.cas});
        const before = yield* readGraphShareClientState(config.agentContextHome);
        yield* fs.writeFileString(`${b.repo}/.threadnote/graph-share.json`, '{}');
        expect(Result.isFailure(yield* runGraphShareJoin(config, {cwd: b.repo, cas: b.cas}).pipe(Effect.result))).toBe(
          true,
        );
        expect(yield* readGraphShareClientState(config.agentContextHome)).toEqual(before);
        expect((yield* runGraphContributeStatus(config, {cwd: a.repo})).mode).toBe('passive');
      }).pipe(provideTestLayer(layer)),
    ),
  );
});

function runtimeConfig(root: string) {
  return {
    account: 'local' as const,
    agentContextHome: `${root}/home`,
    agentId: 'threadnote',
    manifestPath: `${root}/home/seed-manifest.yaml`,
    user: 'local',
  };
}

const fixture = Effect.fn('test.sharing.repositoryFixture')(function* (
  root: string,
  name: string,
  endpoint?: string,
  defaultMode: 'dedicated' | 'idle' | 'passive' = 'passive',
  maximumUploadBytesPerSecond = 1_048_576,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = path.join(root, name);
  const cas = path.join(root, `${name}-cas`);
  yield* fs.makeDirectory(path.join(repo, '.threadnote'), {recursive: true});
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
  yield* git(['init', '-q', '--initial-branch=main']);
  yield* git(['remote', 'add', 'origin', `https://github.com/acme/${name}.git`]);
  yield* git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base',
  ]);
  const identity = yield* resolveRepositoryIdentity(repo);
  const coordinator = endpoint ?? `https://${name}.example.invalid`;
  const profile = defaultGraphShareProfile({
    branch: 'main',
    canonicalRemote: `github.com/acme/${name}`,
    coordinatorUrl: coordinator,
    organization: 'acme',
    publisherKeyFingerprint: `sha256:${Effect2.pipe('a', EffectString.repeat(64))}`,
    repositoryId: identity.repositoryId,
  });
  const configuredProfile = {
    ...profile,
    contribution: {...profile.contribution, defaultMode, maximumUploadBytesPerSecond},
  };
  const digest = yield* putCasBytes(cas, new TextEncoder().encode(canonicalJson(configuredProfile)));
  yield* fs.writeFileString(
    path.join(repo, '.threadnote/graph-share.json'),
    JSON.stringify({
      profile: casProfilePointer(digest),
      publisherKeyFingerprint: configuredProfile.trust.publisherKeys[0],
      repositoryId: identity.repositoryId,
      schemaVersion: 1,
    }),
  );
  return {cas, coordinator, digest, profile: configuredProfile, repo, repositoryId: identity.repositoryId};
});
