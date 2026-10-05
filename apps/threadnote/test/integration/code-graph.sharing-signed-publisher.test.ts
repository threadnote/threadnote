import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import {exportJWK, generateKeyPair, SignJWT} from 'jose';
import {graphRegistryFixture} from '@threadnote/graph/test/helpers/graph-registry';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {codeGraphCheckpointAbiInputV1} from '@threadnote/graph/checkpoint/compatibility';
import {codeGraphCheckpointAbiDigestV1} from '@threadnote/graph/checkpoint/pack';
import {graphShareLanguageAndRole, graphShareParseActionKey} from '@threadnote/graph/sharing/action';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import {maybeImportSharedGraphBase, runGraphShareJoin} from '@threadnote/graph/sharing/client';
import {putCasBytes, readVerifiedCasBlob} from '@threadnote/graph/sharing/cas';
import {
  decodeJsonBytes,
  readJsonFile,
  writeDurablePrivateJsonFile,
  writePrivateJsonFile,
} from '@threadnote/graph/sharing/atomic';
import {loadGraphShareCoordinatorState} from '@threadnote/graph/sharing/control/server';
import {enrollGraphControlWorker} from '@threadnote/graph/sharing/control/enrollment';
import {
  graphWorkerAdmissionStatePath,
  readGraphWorkerAdmissionStore,
} from '@threadnote/graph/sharing/control/result_admission';
import {parseSha256Digest, sha256Digest, type Sha256Digest} from '@threadnote/graph/sharing/digest';
import {
  parkGraphWorkerAdmissionReceipts,
  readGraphWorkerAdmissionArchive,
} from '@threadnote/graph/sharing/worker/admission_archive';
import {graphShareEnrollmentPath, graphSharingLayout} from '@threadnote/graph/sharing/layout';
import {
  casProfilePointer,
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  enrolledProfileBodyDigest,
} from '@threadnote/graph/sharing/profile';
import {advanceGraphPublisherFrontier} from '@threadnote/graph/sharing/publisher/cycle';
import {readGraphPublisherEvidenceRecord} from '@threadnote/graph/sharing/publisher/evidence_record';
import {readGraphPublisherRegistryStatus} from '@threadnote/graph/sharing/publisher/registry';
import {
  runGraphPublisherBootstrap,
  runGraphPublisherListen,
  runGraphShareInit,
} from '@threadnote/threadnote/code_graph/sharing/publisher';
import {graphShareParseResultArtifact, type GraphShareParseResultV1} from '@threadnote/graph/sharing/parse/result';
import {announceGraphShareResult} from '@threadnote/graph/sharing/receipts';
import {signGraphWorkerResultAnnouncement} from '@threadnote/graph/sharing/worker/announcement';
import {createGraphWorkerResultArtifact} from '@threadnote/graph/sharing/worker/result';
import {makeGraphWorkerSigner} from '@threadnote/graph/sharing/worker/signing';
import {
  admitGraphWorkerAnnouncement,
  emptyGraphWorkerAdmissionStore,
} from '@threadnote/graph/sharing/worker/admission_state';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

describe('signed worker publisher', () => {
  for (const publicationMode of ['controlled', 'listener'] as const)
    effectIt.effect(
      publicationMode === 'listener'
        ? 'automatically source-uses a signed result and retains its evidence after listener restart'
        : 'admits signed results through the authenticated publisher listener and source-verifies canonical publication',
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const registry = yield* graphRegistryFixture();
            const indexer = yield* CodeGraphIndexer;
            const store = yield* CodeGraphStore;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-signed-publisher-valid-'});
            const repository = path.join(root, 'repository');
            const contributor = path.join(root, 'contributor');
            const cas = path.join(root, 'cas');
            const home = path.join(root, 'home');
            const policyFile = path.join(root, 'policy.json');
            yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
            yield* fs.writeFileString(
              path.join(repository, 'package.json'),
              '{"name":"signed-publisher-test","private":true,"type":"module"}\n',
            );
            yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const original = 1;\n');
            yield* git(repository, ['init', '-q', '--initial-branch=main']);
            yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/signed-publisher-test.git']);
            yield* git(repository, ['add', '.']);
            yield* commit(repository, 'base');
            yield* runGraphShareInit(config(home), {cas, cwd: repository, organization: 'acme', writeConfig: true});
            const enrollmentPath = graphShareEnrollmentPath(path, repository);
            const enrollment = parseGraphShareEnrollment(yield* readJsonFile(enrollmentPath));
            const original = parseGraphShareProfile(
              yield* decodeJsonBytes(yield* readVerifiedCasBlob(cas, enrolledProfileBodyDigest(enrollment))),
            );
            const profile = parseGraphShareProfile({
              ...original,
              frontier: {...original.frontier, batchMaximumAgeSeconds: 1},
              registry: {
                canonical: 'oci://registry.example.test/acme/canonical',
                worker: 'oci://registry.example.test/acme/worker',
              },
            });
            const profileDigest = yield* putCasBytes(cas, new TextEncoder().encode(canonicalJson(profile)));
            yield* writePrivateJsonFile(enrollmentPath, {...enrollment, profile: casProfilePointer(profileDigest)});
            yield* git(repository, ['add', '.threadnote/graph-share.json']);
            yield* commit(repository, 'enroll');
            const identity = yield* resolveRepositoryIdentity(repository);
            const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
            const policy = {
              audience: 'https://graph.example',
              grants: [{expiresAt: nowSeconds + 3600, scopes: ['graph:contribute' as const], subject: 'test-worker'}],
              issuer: 'https://auth.example.test/',
              jwksUrl: 'https://auth.example.test/.well-known/jwks.json',
              organization: 'acme',
              profileDigest,
              repositoryId: identity.repositoryId,
              schemaVersion: 1 as const,
            };
            yield* writePrivateJsonFile(policyFile, policy);
            const signer = yield* makeGraphWorkerSigner(home, sha256Digest('test credential identity'));
            const worker = yield* enrollGraphControlWorker({
              home,
              initialPolicy: policy,
              principal: {
                expiresAt: nowSeconds + 3600,
                issuer: policy.issuer,
                scopes: new Set(['graph:contribute']),
                subject: 'test-worker',
              },
              readCurrentPolicy: Effect.succeed(policy),
              request: {
                idempotencyKey: 'signed-publisher-valid',
                profileDigest,
                repositoryId: identity.repositoryId,
                signingPublicKey: signer.publicKey,
              },
            });
            yield* indexer.index({cwd: repository, ensureVectors: false, force: true, threadnoteHome: home});
            yield* registry.provide(runGraphPublisherBootstrap(config(home), {cas, cwd: repository}));
            yield* git(root, ['clone', '-q', repository, contributor]);
            yield* git(contributor, [
              'remote',
              'set-url',
              'origin',
              'https://github.com/acme/signed-publisher-test.git',
            ]);
            yield* fs.writeFileString(path.join(contributor, 'src', 'next.ts'), 'export const next = 2;\n');
            yield* git(contributor, ['add', 'src/next.ts']);
            yield* commit(contributor, 'advance');
            const nextIdentity = yield* resolveRepositoryIdentity(contributor);
            let parsed: GraphShareParseResultV1 | undefined;
            const source = yield* indexer.index({
              cwd: contributor,
              ensureVectors: false,
              force: true,
              includeOverlay: false,
              sourceOnly: true,
              sourceVerification: {
                observeParserBatch: group =>
                  Effect.sync(() => {
                    const file = group.files.find(item => item.path === 'src/next.ts');
                    const facts = group.facts.find(item => item.facts.path === file?.path);
                    if (file === undefined || facts === undefined) return;
                    const action = {
                      contentHash: file.contentHash,
                      extractorSet: group.cacheIdentity,
                      languageAndRole: graphShareLanguageAndRole(file.language, 'source'),
                      normalizedPath: file.path,
                      repositoryId: identity.repositoryId,
                    };
                    parsed = graphShareParseResultArtifact({
                      ...action,
                      actionKey: graphShareParseActionKey(action),
                      facts: facts.facts,
                      gitBlobId: file.blobId,
                    });
                  }),
                materializeFacts: batch => Effect.succeed(batch.facts),
              },
              threadnoteHome: home,
            });
            if (parsed === undefined) return yield* Effect.die('Fresh source parser result was not captured');
            const graphLayout = codeGraphLayout(path, home, nextIdentity.checkoutId, nextIdentity.worktreeId);
            const packs = yield* store.snapshotPackProvenance(graphLayout.databasePath, source.snapshot.id);
            if (packs === undefined) return yield* Effect.die('Fresh source pack provenance is unavailable');
            const targetAbi = codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(packs)).digest;
            const authority = {
              expiresAt: worker.body.expiresAt,
              graphAbi: targetAbi,
              principalId: worker.body.principalId,
              profileDigest,
              repositoryId: identity.repositoryId,
              signingPublicKey: signer.publicKey,
              workerId: worker.body.workerId,
            };
            const artifact = yield* createGraphWorkerResultArtifact({
              metadata: {
                batchId: nextIdentity.headCommit.slice(0, 40),
                graphAbi: targetAbi,
                identityClass: 'oauth-principal',
                issuedAt: nowSeconds,
                partialCoverage: false,
                platform: {architecture: 'x64', os: 'linux'},
                principalId: authority.principalId,
                profileDigest,
                releaseIdentity: '4.6.11-local.gsynthetic',
                repositoryId: identity.repositoryId,
                resourceLimits: [],
                sourceCommit: nextIdentity.headCommit,
                workerId: authority.workerId,
              },
              resultBytes: new TextEncoder().encode(canonicalJson(parsed)),
              signer,
            });
            const announcement = yield* signGraphWorkerResultAnnouncement({artifact, expected: authority, signer});
            const absentAction = {
              contentHash: 'f'.repeat(64),
              extractorSet: parsed.extractorSet,
              languageAndRole: 'typescript:source',
              normalizedPath: 'src/absent.ts',
              repositoryId: identity.repositoryId,
            };
            const absentParsed = graphShareParseResultArtifact({
              ...absentAction,
              actionKey: graphShareParseActionKey(absentAction),
              facts: {path: absentAction.normalizedPath, diagnostics: [], edges: [], symbols: []},
              gitBlobId: 'f'.repeat(40),
            });
            const absentArtifact = yield* createGraphWorkerResultArtifact({
              metadata: {
                batchId: nextIdentity.headCommit.slice(0, 40),
                graphAbi: targetAbi,
                identityClass: 'oauth-principal',
                issuedAt: nowSeconds,
                partialCoverage: false,
                platform: {architecture: 'x64', os: 'linux'},
                principalId: authority.principalId,
                profileDigest,
                releaseIdentity: '4.6.11-local.gsynthetic',
                repositoryId: identity.repositoryId,
                resourceLimits: [],
                sourceCommit: nextIdentity.headCommit,
                workerId: authority.workerId,
              },
              resultBytes: new TextEncoder().encode(canonicalJson(absentParsed)),
              signer,
            });
            const absentAnnouncement = yield* signGraphWorkerResultAnnouncement({
              artifact: absentArtifact,
              expected: authority,
              signer,
            });
            for (const item of [artifact, absentArtifact]) {
              registry.workerManifests.set(item.manifestDigest, item.manifestBytes);
              for (const bytes of [new TextEncoder().encode('{}'), item.resultBytes, item.attestationBytes])
                registry.workerBlobs.set(sha256Digest(bytes), bytes);
            }
            const jwtKey = yield* Effect.promise(() => generateKeyPair('RS256'));
            const jwk = {...(yield* Effect.promise(() => exportJWK(jwtKey.publicKey))), alg: 'RS256', kid: 'fixture'};
            const nativeFetch = globalThis.fetch;
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
                  String(input) === policy.jwksUrl
                    ? Promise.resolve(new Response(JSON.stringify({keys: [jwk]}), {status: 200}))
                    : nativeFetch(input, init)) as typeof globalThis.fetch;
              }),
              () =>
                Effect.sync(() => {
                  globalThis.fetch = nativeFetch;
                }),
            );
            const token = yield* Effect.promise(() =>
              new SignJWT({scope: 'graph:contribute'})
                .setProtectedHeader({alg: 'RS256', kid: 'fixture'})
                .setIssuer(policy.issuer)
                .setAudience(policy.audience)
                .setSubject('test-worker')
                .setIssuedAt(nowSeconds)
                .setExpirationTime(nowSeconds + 600)
                .sign(jwtKey.privateKey),
            );
            const ready = yield* Deferred.make<string>();
            const holdWatch = yield* Deferred.make<void>();
            const listener = yield* Effect.forkScoped(
              registry.provide(
                runGraphPublisherListen(config(home), {
                  authorizationPolicy: policyFile,
                  cas,
                  cwd: repository,
                  listen: '127.0.0.1:0',
                  // The server is live before onReady completes; hold its watch until admissions are settled.
                  onReady: output =>
                    Deferred.succeed(ready, output.coordinatorUrl).pipe(Effect.andThen(Deferred.await(holdWatch))),
                }),
              ),
            );
            const coordinatorUrl = yield* Deferred.await(ready);
            yield* git(repository, ['fetch', '-q', contributor, 'main']);
            yield* git(repository, ['merge', '-q', '--ff-only', 'FETCH_HEAD']);
            const post = (body: unknown, bearer = token) =>
              Effect.gen(function* () {
                const client = yield* HttpClient.HttpClient;
                const request = HttpClientRequest.post(`${coordinatorUrl}/v1/results`).pipe(
                  HttpClientRequest.setHeaders({
                    authorization: `Bearer ${bearer}`,
                    'x-threadnote-profile-digest': profileDigest,
                    'x-threadnote-repository-id': identity.repositoryId,
                  }),
                  request =>
                    HttpClientRequest.bodyUint8Array(
                      request,
                      new TextEncoder().encode(JSON.stringify(body)),
                      'application/json',
                    ),
                );
                const response = yield* client.execute(request);
                return {body: yield* response.json, status: response.status};
              });
            expect(yield* post(announcement, 'invalid')).toEqual({body: {error: 'unauthorized'}, status: 401});
            expect(yield* post(announcement)).toEqual({
              body: {idempotencyKey: announcement.body.idempotencyKey, status: 'accepted'},
              status: 201,
            });
            expect(yield* post(absentAnnouncement)).toEqual({
              body: {idempotencyKey: absentAnnouncement.body.idempotencyKey, status: 'accepted'},
              status: 201,
            });
            expect((yield* readGraphWorkerAdmissionStore(home, policy)).receipts).toHaveLength(2);
            const admissionPath = yield* graphWorkerAdmissionStatePath(home, policy);
            let result: {
              readonly contributionEvidence?: unknown;
              readonly generation: number;
              readonly manifestDigest: Sha256Digest;
              readonly published: boolean;
              readonly sourceCommit: string;
            };
            if (publicationMode === 'controlled') {
              yield* Fiber.interrupt(listener);
              yield* git(repository, ['checkout', '-qb', 'diversion']);
              yield* fs.writeFileString(path.join(repository, 'src', 'diversion.ts'), 'export const diversion = 3;\n');
              yield* git(repository, ['add', 'src/diversion.ts']);
              yield* commit(repository, 'diversion');
              const beforeParking = yield* readGraphWorkerAdmissionStore(home, policy);
              const archive = yield* readGraphWorkerAdmissionArchive(admissionPath, policy);
              expect(
                (yield* parkGraphWorkerAdmissionReceipts(
                  admissionPath,
                  policy,
                  archive,
                  nextIdentity.headCommit,
                  beforeParking.receipts,
                )).status,
              ).toBe('parked');
              yield* writeDurablePrivateJsonFile(admissionPath, emptyGraphWorkerAdmissionStore());
              yield* git(repository, ['checkout', '-q', 'main']);
              result = yield* registry.provide(
                advanceGraphPublisherFrontier(config(home), {
                  authorizationPolicy: policyFile,
                  cas,
                  cwd: repository,
                  forceFreeze: true,
                }),
              );
            } else {
              yield* Deferred.succeed(holdWatch, undefined);
              let watched: Effect.Success<ReturnType<typeof readGraphPublisherRegistryStatus>> | undefined;
              for (let attempt = 0; attempt < 150; attempt++) {
                watched = yield* registry.provide(
                  readGraphPublisherRegistryStatus(config(home), {cas, cwd: repository}),
                );
                if (
                  watched.localCandidate?.sourceCommit === nextIdentity.headCommit &&
                  watched.contributionEvidence !== undefined
                )
                  break;
                yield* Effect.sleep(200);
              }
              yield* Fiber.interrupt(listener);
              if (
                watched?.localCandidate?.sourceCommit !== nextIdentity.headCommit ||
                watched.contributionEvidence === undefined
              )
                return yield* Effect.die('Listener did not publish the signed target');
              result = {
                contributionEvidence: watched.contributionEvidence.contributionEvidence,
                generation: watched.localCandidate.generation,
                manifestDigest: parseSha256Digest(watched.localCandidate.manifestDigest),
                published: true,
                sourceCommit: watched.localCandidate.sourceCommit,
              };
            }
            expect(result.published).toBe(true);
            expect(result.sourceCommit).toBe(nextIdentity.headCommit);
            expect(result.contributionEvidence).toMatchObject({
              selectedResults: 1,
              verifiedResults: 1,
              sourceUse: {consumedActions: 1, consumedResultManifestDigests: [artifact.manifestDigest]},
            });
            expect(
              yield* readGraphPublisherEvidenceRecord({
                manifestDigest: result.manifestDigest,
                repositoryId: identity.repositoryId,
                threadnoteHome: home,
              }),
            ).toMatchObject({
              generation: result.generation,
              sourceCommit: nextIdentity.headCommit,
              contributionEvidence: {
                selectedResults: 1,
                sourceUse: {consumedActions: 1, consumedResultManifestDigests: [artifact.manifestDigest]},
              },
            });
            const localStatus = yield* registry.provide(
              readGraphPublisherRegistryStatus(config(home), {cas, cwd: repository}),
            );
            expect(localStatus.contributionEvidence?.contributionEvidence.sourceUse.consumedActions).toBe(1);
            if (publicationMode === 'listener') {
              const restarted = yield* Deferred.make<void>();
              const nextListener = yield* Effect.forkScoped(
                registry.provide(
                  runGraphPublisherListen(config(home), {
                    authorizationPolicy: policyFile,
                    cas,
                    cwd: repository,
                    listen: '127.0.0.1:0',
                    onReady: () => Deferred.succeed(restarted, undefined),
                  }),
                ),
              );
              yield* Deferred.await(restarted);
              const afterRestart = yield* registry.provide(
                readGraphPublisherRegistryStatus(config(home), {cas, cwd: repository}),
              );
              expect(afterRestart.contributionEvidence).toEqual(localStatus.contributionEvidence);
              yield* Fiber.interrupt(nextListener);
            }
            expect(
              registry.requests.some(
                request =>
                  request.method === 'GET' &&
                  request.pathname === `/v2/acme/worker/manifests/${artifact.manifestDigest}`,
              ),
            ).toBe(true);
            expect(registry.manifests.size).toBeGreaterThan(0);
            expect((yield* readGraphWorkerAdmissionStore(home, policy)).receipts).toHaveLength(0);
            expect((yield* readGraphWorkerAdmissionArchive(admissionPath, policy)).receipts).toHaveLength(0);
            const clientRepo = path.join(root, 'client');
            const clientHome = path.join(root, 'client-home');
            const clientCas = path.join(root, 'client-cas');
            yield* git(root, ['clone', '-q', repository, clientRepo]);
            yield* git(clientRepo, [
              'remote',
              'set-url',
              'origin',
              'https://github.com/acme/signed-publisher-test.git',
            ]);
            yield* putCasBytes(clientCas, new TextEncoder().encode(canonicalJson(profile)));
            yield* runGraphShareJoin(config(clientHome), {cas: clientCas, cwd: clientRepo, readOnly: true});
            const clientIdentity = yield* resolveRepositoryIdentity(clientRepo);
            const imported = yield* registry.provide(
              maybeImportSharedGraphBase({cwd: clientRepo, identity: clientIdentity, threadnoteHome: clientHome}),
            );
            expect(imported).toMatchObject({imported: true, atGeneration: result.generation});
          }).pipe(provideTestLayer(ApplicationLayer)),
        ),
      180_000,
    );

  effectIt.effect(
    'ignores legacy, quarantined, and revoked receipts for an OCI-worker profile',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-signed-publisher-'});
          const repository = path.join(root, 'repository');
          const cas = path.join(root, 'cas');
          const home = path.join(root, 'home');
          const policyFile = path.join(root, 'policy.json');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"signed-publisher-test","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const original = 1;\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/signed-publisher-test.git']);
          yield* git(repository, ['add', '.']);
          yield* commit(repository, 'base');
          yield* runGraphShareInit(config(home), {cas, cwd: repository, organization: 'acme', writeConfig: true});
          const enrollmentPath = graphShareEnrollmentPath(path, repository);
          const enrollment = parseGraphShareEnrollment(yield* readJsonFile(enrollmentPath));
          const original = parseGraphShareProfile(
            yield* decodeJsonBytes(yield* readVerifiedCasBlob(cas, enrolledProfileBodyDigest(enrollment))),
          );
          const profile = {...original, registry: {...original.registry, worker: 'oci://registry.example/acme/work'}};
          const profileDigest = yield* putCasBytes(cas, new TextEncoder().encode(canonicalJson(profile)));
          yield* writePrivateJsonFile(enrollmentPath, {...enrollment, profile: casProfilePointer(profileDigest)});
          yield* git(repository, ['add', '.threadnote/graph-share.json']);
          yield* commit(repository, 'enroll');
          const identity = yield* resolveRepositoryIdentity(repository);
          const policy = {
            audience: 'https://graph.example',
            grants: [],
            issuer: 'https://auth.example',
            jwksUrl: 'https://auth.example/.well-known/jwks.json',
            organization: 'acme',
            profileDigest,
            repositoryId: identity.repositoryId,
            schemaVersion: 1 as const,
          };
          yield* writePrivateJsonFile(policyFile, policy);
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, force: true, threadnoteHome: home});
          yield* runGraphPublisherBootstrap(config(home), {cas, cwd: repository});
          yield* fs.writeFileString(path.join(repository, 'src', 'next.ts'), 'export const next = 2;\n');
          yield* git(repository, ['add', 'src/next.ts']);
          yield* commit(repository, 'advance');
          const nextIdentity = yield* resolveRepositoryIdentity(repository);
          const source = yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            includeOverlay: false,
            sourceOnly: true,
            threadnoteHome: home,
          });
          const store = yield* CodeGraphStore;
          const graphLayout = codeGraphLayout(path, home, nextIdentity.checkoutId, nextIdentity.worktreeId);
          const packs = yield* store.snapshotPackProvenance(graphLayout.databasePath, source.snapshot.id);
          expect(packs).toBeDefined();
          const targetAbi = codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(packs!)).digest;
          const coordinatorOptions = {organization: 'acme', repositoryId: identity.repositoryId, threadnoteHome: home};
          const coordinator = yield* loadGraphShareCoordinatorState(coordinatorOptions);
          const receipts = announceGraphShareResult(coordinator.receipts, {
            actionKey: 'a'.repeat(64),
            attestationDigest: sha256Digest('legacy-attestation'),
            batchId: nextIdentity.headCommit,
            resultManifestDigest: sha256Digest('untrusted-legacy-result'),
            semanticDigest: sha256Digest('legacy-semantic'),
          }).store;
          yield* writePrivateJsonFile(graphSharingLayout(path, home).coordinatorStatePath, {...coordinator, receipts});
          const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
          const worker = {
            expiresAt: nowSeconds + 3600,
            graphAbi: targetAbi,
            principalId: sha256Digest('revoked-principal'),
            profileDigest,
            repositoryId: identity.repositoryId,
            signingPublicKey: 'f'.repeat(64),
            workerId: `gw_${'1'.repeat(32)}`,
          };
          const signed = [
            signedAnnouncement(1, '1'.repeat(64), nextIdentity.headCommit, worker),
            signedAnnouncement(2, '1'.repeat(64), nextIdentity.headCommit, worker),
            signedAnnouncement(3, '2'.repeat(64), nextIdentity.headCommit, worker),
          ];
          const admissions = signed.reduce(
            (store, announcement) =>
              admitGraphWorkerAnnouncement(store, {
                announcement,
                authority: worker,
                nowSeconds,
                sourceCommit: nextIdentity.headCommit,
              }).store,
            emptyGraphWorkerAdmissionStore(),
          );
          expect(admissions.quarantine).toHaveLength(1);
          const admissionPath = yield* graphWorkerAdmissionStatePath(home, policy);
          yield* fs.makeDirectory(path.dirname(admissionPath), {recursive: true});
          yield* writePrivateJsonFile(admissionPath, admissions);
          const result = yield* advanceGraphPublisherFrontier(config(home), {
            authorizationPolicy: policyFile,
            cas,
            cwd: repository,
            forceFreeze: true,
          });
          expect(result.published).toBe(true);
          expect(result.contributionEvidence?.selectedResults).toBe(0);
          expect(result.contributionEvidence?.verifiedResults).toBe(0);
          expect(result.sourceCommit).toBe(nextIdentity.headCommit);
          expect((yield* readGraphWorkerAdmissionStore(home, policy)).receipts).toHaveLength(0);
          yield* writePrivateJsonFile(admissionPath, admissions);
          yield* writePrivateJsonFile(graphSharingLayout(path, home).coordinatorStatePath, coordinator);
          const reconciled = yield* advanceGraphPublisherFrontier(config(home), {
            authorizationPolicy: policyFile,
            cas,
            cwd: repository,
            forceFreeze: true,
          });
          expect(reconciled.published).toBe(false);
          expect(reconciled.manifestDigest).toBe(result.manifestDigest);
          expect((yield* readGraphWorkerAdmissionStore(home, policy)).receipts).toHaveLength(0);
          const latestCoordinator = yield* loadGraphShareCoordinatorState(coordinatorOptions);
          expect(latestCoordinator.machine.generation).toBe(result.generation);
          expect(latestCoordinator.machine.publishedFrontier).toBe(nextIdentity.headCommit);

          // Crash after the durable B pointer write but before admission cleanup, then
          // resume with HEAD at C. B is covered; C must remain available to publish.
          yield* fs.writeFileString(path.join(repository, 'src', 'later.ts'), 'export const later = 3;\n');
          yield* git(repository, ['add', 'src/later.ts']);
          yield* commit(repository, 'later');
          const laterIdentity = yield* resolveRepositoryIdentity(repository);
          const laterAdmission = admitGraphWorkerAnnouncement(admissions, {
            announcement: signedAnnouncement(4, '3'.repeat(64), laterIdentity.headCommit, worker),
            authority: worker,
            nowSeconds,
            sourceCommit: laterIdentity.headCommit,
          }).store;
          yield* writePrivateJsonFile(admissionPath, laterAdmission);
          yield* writePrivateJsonFile(graphSharingLayout(path, home).coordinatorStatePath, coordinator);
          const afterRestart = yield* advanceGraphPublisherFrontier(config(home), {
            authorizationPolicy: policyFile,
            cas,
            cwd: repository,
          });
          expect(afterRestart.published).toBe(false);
          expect(afterRestart.manifestDigest).toBe(result.manifestDigest);
          expect(
            (yield* readGraphWorkerAdmissionStore(home, policy)).receipts.map(receipt => receipt.sourceCommit),
          ).toEqual([laterIdentity.headCommit]);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    180_000,
  );
});

const config = (agentContextHome: string) => ({agentContextHome}) as Parameters<typeof runGraphShareInit>[0];
const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', args, {cwd}).pipe(Effect.asVoid);
const commit = (cwd: string, message: string) =>
  git(cwd, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', message]);

function signedAnnouncement(
  seed: number,
  actionKey: string,
  sourceCommit: string,
  worker: {
    readonly principalId: string;
    readonly profileDigest: string;
    readonly repositoryId: string;
    readonly signingPublicKey: string;
    readonly workerId: string;
  },
) {
  const fields = {
    actionKey,
    attestationDigest: sha256Digest(`attestation-${seed}`),
    batchId: sourceCommit.slice(0, 40),
    principalId: worker.principalId,
    profileDigest: worker.profileDigest,
    repositoryId: worker.repositoryId,
    resultManifestDigest: sha256Digest(`result-${seed}`),
    semanticDigest: sha256Digest(`semantic-${seed}`),
    workerId: worker.workerId,
  };
  return {
    algorithm: 'ed25519' as const,
    body: {
      ...fields,
      idempotencyKey: sha256Digest('threadnote.graph.worker.result-operation.v1\0' + canonicalJson(fields)),
    },
    publicKey: worker.signingPublicKey,
    schemaVersion: 1 as const,
    signature: seed.toString(16).padStart(128, '0'),
  };
}
