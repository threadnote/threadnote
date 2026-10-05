import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {graphRegistryFixture} from '@threadnote/graph/test/helpers/graph-registry';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {graphShareParseActionKey} from '@threadnote/graph/sharing/action';
import {putCasBytes} from '@threadnote/graph/sharing/cas';
import {monitorGraphShareSignedContributions} from '@threadnote/graph/sharing/contribution/retry';
import {drainQueuedGraphShareSignedContributions} from '@threadnote/graph/sharing/worker/delivery';
import {readContributionRetryState} from '@threadnote/graph/sharing/contribution/retry_state';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphShareParseResultArtifact} from '@threadnote/graph/sharing/parse/result';
import {defaultGraphShareProfile, graphShareProfileDigest} from '@threadnote/graph/sharing/profile';
import {
  listGraphShareSignedCandidatePageIds,
  persistGraphShareSignedCandidates,
} from '@threadnote/graph/sharing/signed/candidate';
import {writeGraphShareTrustReceipt} from '@threadnote/graph/sharing/trust';
import {
  graphWorkerDeliveryScope,
  listGraphWorkerDeliveryOutboxOperations,
} from '@threadnote/graph/sharing/worker/delivery_outbox';
import {writePrivateJsonFile} from '@threadnote/graph/sharing/atomic';
import {CommandExecutor} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';

describe('passive signed graph delivery monitor', () => {
  effectIt.effect('keeps signed candidates queued when the organization disables uploads', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-signed-zero-upload-'});
        const cas = `${home}/cas`;
        const repositoryId = 'a'.repeat(64);
        const publisherKeyFingerprint = sha256Digest('publisher');
        const base = defaultGraphShareProfile({
          branch: 'main',
          canonicalRemote: 'github.com/acme/signed-zero-upload',
          organization: 'acme',
          publisherKeyFingerprint,
          repositoryId,
        });
        const profile = {
          ...base,
          contribution: {
            ...base.contribution,
            maximumUploadBytesPerSecond: 0,
          },
          coordinator: {url: 'https://control.example.test'},
          registry: {
            canonical: 'oci://registry.example.test/acme/canonical',
            worker: 'oci://registry.example.test/acme/worker',
          },
        };
        const profileDigest = graphShareProfileDigest(profile);
        yield* putCasBytes(cas, new TextEncoder().encode(canonicalJson(profile)));
        yield* writeGraphShareTrustReceipt(home, {
          accessMode: 'join',
          client: {casRoot: cas, contributionMode: 'passive', coordinatorUrl: profile.coordinator.url},
          organization: 'acme',
          policyVersion: 1,
          profileDigest,
          publisherKeyFingerprint,
          registryCanonical: profile.registry.canonical,
          repositoryId,
        });
        yield* persistGraphShareSignedCandidates(home, repositoryId, [
          {
            actionKey: 'a'.repeat(64),
            batchId: '1'.repeat(40),
            casRoot: cas,
            extractorSet: 'b'.repeat(64),
            graphAbi: 'e'.repeat(64),
            organization: 'acme',
            partialCoverage: false,
            platform: {architecture: 'x64', os: 'linux'},
            profileDigest,
            queuedAtMilliseconds: yield* Clock.currentTimeMillis,
            releaseIdentity: '4.6.12-local.gfixture',
            resourceLimits: [],
            resultDigest: sha256Digest('result'),
            resultSize: 6,
            semanticDigest: sha256Digest('semantic'),
            snapshotId: `cgsn_${'f'.repeat(40)}`,
            sourceCommit: '1'.repeat(40),
          },
        ]);
        const pages = yield* listGraphShareSignedCandidatePageIds(home, repositoryId);
        expect(pages.length).toBeGreaterThan(0);
        expect(yield* drainQueuedGraphShareSignedContributions({repositoryId, threadnoteHome: home})).toEqual({
          sent: 0,
        });
        expect(yield* listGraphShareSignedCandidatePageIds(home, repositoryId)).toEqual(pages);
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect(
    'retries source-unavailable promptly and replays the exact prepared operation after monitor restart',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const command = yield* CommandExecutor;
          const registry = yield* graphRegistryFixture();
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-signed-passive-monitor-'});
          const cas = path.join(home, 'cas');
          const repositoryId = 'a'.repeat(64);
          const publisherKeyFingerprint = sha256Digest('publisher key');
          const coordinatorUrl = 'https://control.example.test';
          const issuer = 'https://identity.example.test/';
          const audience = 'https://control.example.test/';
          const subject = 'passive-worker';
          const profile = {
            ...defaultGraphShareProfile({
              branch: 'main',
              canonicalRemote: 'github.com/acme/signed-passive-monitor',
              organization: 'acme',
              publisherKeyFingerprint,
              repositoryId,
            }),
            coordinator: {url: coordinatorUrl},
            registry: {
              canonical: 'oci://registry.example.test/acme/canonical',
              worker: 'oci://registry.example.test/acme/worker',
            },
          };
          const profileDigest = graphShareProfileDigest(profile);
          expect(yield* putCasBytes(cas, new TextEncoder().encode(canonicalJson(profile)))).toBe(profileDigest);
          yield* writeGraphShareTrustReceipt(home, {
            accessMode: 'join',
            client: {casRoot: cas, contributionMode: 'passive', coordinatorUrl},
            organization: 'acme',
            policyVersion: 1,
            profileDigest,
            publisherKeyFingerprint,
            registryCanonical: profile.registry.canonical,
            repositoryId,
          });
          yield* writePrivateJsonFile(path.join(home, 'graph-sharing', 'control-credentials.json'), {
            bindings: [{audience, coordinatorUrl, helper: 'fixture', issuer, organization: 'acme'}],
            schemaVersion: 1,
          });
          const sourceCommit = '1'.repeat(40);
          const action = {
            contentHash: 'b'.repeat(64),
            extractorSet: 'c'.repeat(64),
            languageAndRole: 'typescript:source',
            normalizedPath: 'src/index.ts',
            repositoryId,
          };
          const parsed = graphShareParseResultArtifact({
            ...action,
            actionKey: graphShareParseActionKey(action),
            facts: {path: action.normalizedPath, diagnostics: [], edges: [], symbols: []},
            gitBlobId: 'd'.repeat(40),
          });
          const resultBytes = new TextEncoder().encode(canonicalJson(parsed));
          const resultDigest = yield* putCasBytes(cas, resultBytes);
          yield* persistGraphShareSignedCandidates(home, repositoryId, [
            {
              actionKey: parsed.actionKey,
              batchId: sourceCommit,
              casRoot: cas,
              extractorSet: action.extractorSet,
              graphAbi: 'e'.repeat(64),
              organization: 'acme',
              partialCoverage: false,
              platform: {architecture: 'x64', os: 'linux'},
              profileDigest,
              queuedAtMilliseconds: yield* Clock.currentTimeMillis,
              releaseIdentity: '4.6.11-local.gfixture',
              resourceLimits: [],
              resultDigest,
              resultSize: resultBytes.byteLength,
              semanticDigest: parsed.semanticDigest,
              snapshotId: `cgsn_${'f'.repeat(40)}`,
              sourceCommit,
            },
          ]);

          let healthy = false;
          const submittedIds: string[] = [];
          let enrolledWorker:
            | {
                expiresAt: number;
                principalId: string;
                profileDigest: string;
                repositoryId: string;
                schemaVersion: 1;
                signingPublicKey: string;
                workerId: string;
              }
            | undefined;
          const fetch = Object.assign(
            async (input: string | URL | Request, init?: RequestInit) => {
              const url = new URL(String(input));
              if (url.origin === 'https://registry.example.test') return registry.fetch(input, init);
              expect(url.origin).toBe('https://control.example.test');
              expect(init?.method).toBe('POST');
              const body = (await new Response(init?.body).json()) as {
                body?: {idempotencyKey?: string};
                idempotencyKey?: string;
                signingPublicKey?: string;
              };
              if (url.pathname === '/v1/enroll') {
                enrolledWorker = {
                  expiresAt: Math.floor(Date.now() / 1000) + 3600,
                  principalId: sha256Digest(JSON.stringify([issuer, subject])),
                  profileDigest,
                  repositoryId,
                  schemaVersion: 1,
                  signingPublicKey: body.signingPublicKey!,
                  workerId: `gw_${'1'.repeat(32)}`,
                };
                return Response.json(enrolledWorker, {status: 201});
              }
              expect(url.pathname).toBe('/v1/results');
              submittedIds.push(body.body!.idempotencyKey!);
              return healthy
                ? Response.json({idempotencyKey: body.body!.idempotencyKey, status: 'accepted'}, {status: 201})
                : Response.json({error: 'source-unavailable'}, {status: 425});
            },
            {preconnect: () => undefined},
          ) as typeof globalThis.fetch;
          const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(FetchHttpClient.Fetch, fetch),
              Effect.provideService(SystemInfo, {
                ...system,
                environment: () => ({...system.environment(), DOCKER_CONFIG: registry.docker}),
              }),
              Effect.provideService(CommandExecutor, {
                ...command,
                execute: (executable, args, options) =>
                  executable === 'threadnote-credential-fixture'
                    ? Effect.succeed({
                        exitCode: 0,
                        stderr: '',
                        stdout: JSON.stringify({
                          accessToken: 'synthetic-token',
                          audience,
                          expiresAt: Math.floor(Date.now() / 1000) + 600,
                          issuer,
                          schemaVersion: 1,
                          subject,
                        }),
                      })
                    : executable === 'docker-credential-fixture'
                      ? Effect.succeed({
                          exitCode: 0,
                          stderr: '',
                          stdout: JSON.stringify({Username: 'synthetic-publisher', Secret: 'fixture-only'}),
                        })
                      : command.execute(executable, args, options),
              }),
            );
          const firstMonitor = yield* Effect.forkScoped(services(monitorGraphShareSignedContributions(home)));
          yield* waitFor(() => submittedIds.length === 1);
          yield* waitForEffect(readContributionRetryState(home, repositoryId, 'signed').pipe(Effect.map(Boolean)));
          yield* Fiber.interrupt(firstMonitor);
          expect((yield* listGraphShareSignedCandidatePageIds(home, repositoryId)).length).toBeGreaterThan(0);
          expect(enrolledWorker).toBeDefined();
          const scope = graphWorkerDeliveryScope({...enrolledWorker!, graphAbi: '0'.repeat(64)}, 'acme');
          const beforeRestart = yield* listGraphWorkerDeliveryOutboxOperations(home, scope);
          expect(beforeRestart).toHaveLength(1);
          expect(beforeRestart[0].state).toBe('prepared');
          expect(beforeRestart[0].operationId).toBe(submittedIds[0]);
          const retry = (yield* readContributionRetryState(home, repositoryId, 'signed'))!;
          expect(retry.nextAttempt - (yield* Clock.currentTimeMillis)).toBeLessThanOrEqual(2_000);
          yield* Effect.sleep(Math.max(0, retry.nextAttempt - (yield* Clock.currentTimeMillis)) + 100);
          healthy = true;
          const secondMonitor = yield* Effect.forkScoped(services(monitorGraphShareSignedContributions(home)));
          yield* waitFor(() => submittedIds.length === 2);
          yield* waitForEffect(
            listGraphWorkerDeliveryOutboxOperations(home, scope).pipe(Effect.map(items => items.length === 0)),
          );
          yield* Fiber.interrupt(secondMonitor);
          expect(submittedIds).toEqual([beforeRestart[0].operationId, beforeRestart[0].operationId]);
          expect(yield* listGraphShareSignedCandidatePageIds(home, repositoryId)).toEqual([]);
          expect(registry.workerManifests.size).toBeGreaterThan(0);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    90_000,
  );
});

const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) return;
      yield* Effect.sleep(100);
    }
    throw new Error('Timed out waiting for signed monitor progress.');
  });

const waitForEffect = (predicate: Effect.Effect<boolean, unknown, FileSystem.FileSystem | Path.Path>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (yield* predicate) return;
      yield* Effect.sleep(100);
    }
    throw new Error('Timed out waiting for signed monitor state.');
  });
