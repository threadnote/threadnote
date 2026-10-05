import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Console, Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpServer from 'effect/http/HttpServer';
import {generateKeyPair, SignJWT} from 'jose';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {graphShareParseActionKey} from '@threadnote/graph/sharing/action';
import {
  generateGraphSharePublisherKey,
  signGraphShareFrontier,
  GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
} from '@threadnote/graph/sharing/artifacts';
import {writePrivateJsonFile} from '@threadnote/graph/sharing/atomic';
import {putCasBytes} from '@threadnote/graph/sharing/cas';
import {readGraphControlPolicy} from '@threadnote/graph/sharing/control/authorization';
import {makeGraphControlReader} from '@threadnote/graph/sharing/control/reader';
import {withCoordinatorStateLock} from '@threadnote/graph/sharing/coordinator_lock';
import {
  admitGraphControlWorkerResult,
  graphWorkerAdmissionStatePath,
  readGraphWorkerAdmissionStore,
  retireGraphWorkerAdmissionsCoveredByPublishedSourceLocked,
  retireGraphWorkerAdmissionsForPublishedSourceLocked,
} from '@threadnote/graph/sharing/control/result_admission';
import {
  emptyGraphWorkerAdmissionStore,
  GRAPH_WORKER_ADMISSION_MAX_RECEIPTS,
} from '@threadnote/graph/sharing/worker/admission_state';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphSharingFrontierPointerPath, graphSharingLayout} from '@threadnote/graph/sharing/layout';
import {readAuthenticatedGraphShareFrontier} from '@threadnote/graph/sharing/frontier_acceptance';
import {graphShareRegistryPublicationScope} from '@threadnote/graph/sharing/registry/publication';
import {graphShareParseResultArtifact} from '@threadnote/graph/sharing/parse/result';
import {defaultGraphShareProfile, graphShareProfileDigest} from '@threadnote/graph/sharing/profile';
import {signGraphWorkerResultAnnouncement} from '@threadnote/graph/sharing/worker/announcement';
import {
  parkGraphWorkerAdmissionReceipts,
  readGraphWorkerAdmissionArchive,
} from '@threadnote/graph/sharing/worker/admission_archive';
import {createGraphWorkerResultArtifact} from '@threadnote/graph/sharing/worker/result';
import {makeGraphWorkerSigner} from '@threadnote/graph/sharing/worker/signing';
import {createAccessTokenVerifier} from '@threadnote/protocol/access-token';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {provideTestLayer} from '../helpers/effect-layer.js';

const issuer = 'https://identity.example.test/';
const audience = 'https://graph.example.test';
const repositoryId = 'a'.repeat(64);
const graphAbi = 'c'.repeat(64);
const registry = 'https://registry.example.test/v2/acme/worker';
const encode = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
const layer = Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer);

const fixture = Effect.fn('test.workerAdmission.fixture')(function* (enabled = true) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-control-result-'});
  const repoRoot = path.join(home, 'source');
  yield* fs.makeDirectory(repoRoot, {recursive: true});
  const executor = Context.get(yield* Layer.build(TestCommandExecutorLayer), CommandExecutor);
  const git = (args: string[]) =>
    runCommandEffect('git', ['-C', repoRoot, ...args]).pipe(Effect.provideService(CommandExecutor, executor));
  yield* git(['init', '-q']);
  yield* fs.writeFileString(path.join(repoRoot, 'source.txt'), 'baseline\n');
  yield* git(['add', '.']);
  yield* git([
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'baseline',
  ]);
  const publishedCommit = (yield* git(['rev-parse', 'HEAD'])).stdout.trim();
  yield* fs.writeFileString(path.join(repoRoot, 'source.txt'), 'candidate\n');
  yield* git(['add', '.']);
  yield* git([
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'candidate',
  ]);
  const candidateCommit = (yield* git(['rev-parse', 'HEAD'])).stdout.trim();
  const key = yield* generateGraphSharePublisherKey();
  const baseline = defaultGraphShareProfile({
    branch: 'main',
    canonicalRemote: 'github.com/acme/repo',
    organization: 'acme',
    publisherKeyFingerprint: key.fingerprint,
    repositoryId,
  });
  const profile = {...baseline, registry: {...baseline.registry, worker: 'oci://registry.example.test/acme/worker'}};
  const profileDigest = graphShareProfileDigest(profile);
  const options = {
    casRoot: path.join(home, 'cas'),
    enrollment: {
      profile: `cas://${profileDigest}`,
      publisherKeyFingerprint: key.fingerprint,
      repositoryId,
      schemaVersion: 1 as const,
    },
    policyFile: path.join(home, 'policy.json'),
    profile,
    repoRoot,
    threadnoteHome: home,
    enableWorkerResults: enabled,
  };
  const manifest = {
    branch: 'refs/heads/main',
    checkpoint: {
      manifestDigest: sha256Digest('checkpoint'),
      snapshotId: `cgsn_${'a'.repeat(40)}`,
      sourceCommit: publishedCommit,
    },
    deltas: [],
    generation: 1,
    graphAbi,
    graphContentId: `cgc_${'d'.repeat(40)}`,
    logicalGraphDigest: sha256Digest('logical'),
    previousManifestDigest: null,
    profileDigest,
    publisherFence: 1,
    repositoryId,
    schemaVersion: 1 as const,
    snapshotId: `cgsn_${'a'.repeat(40)}`,
    sourceCommit: publishedCommit,
  };
  const signed = yield* signGraphShareFrontier(key, manifest);
  const manifestDigest = yield* putCasBytes(options.casRoot, encode(signed.manifest));
  const envelopeDigest = yield* putCasBytes(options.casRoot, encode(signed.envelope));
  yield* writePrivateJsonFile(
    graphSharingFrontierPointerPath(path, graphSharingLayout(path, home, options.casRoot).frontiersRoot, repositoryId),
    {envelopeDigest, manifestDigest, schemaVersion: 1},
  );
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const policy = {
    audience,
    grants: [{expiresAt: now + 3600, scopes: ['graph:contribute', 'graph:read'], subject: 'worker-principal'}],
    issuer,
    jwksUrl: `${issuer}.well-known/jwks.json`,
    organization: 'acme',
    profileDigest,
    repositoryId,
    schemaVersion: 1,
  };
  yield* writePrivateJsonFile(options.policyFile, policy);
  const jwtKey = yield* Effect.promise(() => generateKeyPair('RS256'));
  const token = (scope = 'graph:contribute') =>
    Effect.gen(function* () {
      const at = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      return yield* Effect.promise(() =>
        new SignJWT({aud: audience, exp: at + 600, iat: at, iss: issuer, scope, sub: 'worker-principal'})
          .setProtectedHeader({alg: 'RS256'})
          .sign(jwtKey.privateKey),
      );
    });
  const validToken = yield* token();
  const registryBytes = new Map<string, Uint8Array>();
  const registryPaths: string[] = [];
  const registryHook: {current?: (address: string) => Promise<void>} = {};
  const fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      registryPaths.push(address);
      await registryHook.current?.(address);
      expect(address.startsWith(registry + '/')).toBe(true);
      expect(init?.redirect).toBe('manual');
      expect(init?.credentials).toBe('omit');
      const bytes = registryBytes.get(address);
      if (bytes === undefined) return new Response(null, {status: 404});
      return new Response(new TextDecoder().decode(bytes), {
        headers: {
          'content-type': address.includes('/manifests/')
            ? GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE
            : 'application/octet-stream',
          'docker-content-digest': sha256Digest(bytes),
        },
      });
    },
    {preconnect: () => undefined},
  ) as typeof globalThis.fetch;
  const signer = yield* makeGraphWorkerSigner(home, sha256Digest('credential identity'));
  const reader = yield* makeGraphControlReader(
    options,
    createAccessTokenVerifier(jwtKey.publicKey, {audience, issuer}),
  );
  const fetchClient = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient);
  const context = yield* Layer.build(BunHttpServer.layer({hostname: '127.0.0.1', port: 0}));
  const server = yield* HttpServer.HttpServer.pipe(Effect.provide(context));
  const system = yield* SystemInfo;
  const inherited = yield* Console.Console;
  yield* server.serve(
    reader.handle.pipe(
      Effect.provideService(HttpClient.HttpClient, fetchClient),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(SystemInfo, {...system, environment: () => ({DOCKER_CONFIG: home})}),
      Effect.provideService(Console.Console, {...inherited, log: () => undefined}),
    ),
  );
  if (server.address._tag === 'UnixPathAddress') throw new Error('Expected TCP');
  const url = `http://127.0.0.1:${server.address.port}`;
  const request = (
    pathname: string,
    auth = validToken,
    body?: unknown,
    headers: Record<string, string> = {},
    method: 'GET' | 'POST' = 'POST',
  ) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const outbound = (
        method === 'GET' ? HttpClientRequest.get(url + pathname) : HttpClientRequest.post(url + pathname)
      ).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${auth}`,
          'x-threadnote-repository-id': repositoryId,
          'x-threadnote-profile-digest': profileDigest,
          ...headers,
        }),
      );
      const prepared =
        body === undefined ? outbound : HttpClientRequest.bodyUint8Array(outbound, encode(body), 'application/json');
      const withOverrides = HttpClientRequest.setHeaders(prepared, headers);
      const response = yield* client.execute(withOverrides);
      return {body: yield* response.json, status: response.status};
    });
  const enroll = Effect.gen(function* () {
    const response = yield* request('/v1/enroll', validToken, {
      idempotencyKey: 'same-enrollment',
      profileDigest,
      repositoryId,
      signingPublicKey: signer.publicKey,
    });
    expect(response.status).toBe(201);
    return response.body as {expiresAt: number; principalId: string; workerId: string};
  });
  const candidate = (
    worker: {expiresAt: number; principalId: string; workerId: string},
    diagnostics: string[] = [],
    batchId = candidateCommit,
    producerGraphAbi = graphAbi,
  ) =>
    Effect.gen(function* () {
      const action = {
        contentHash: 'a'.repeat(64),
        extractorSet: 'b'.repeat(64),
        languageAndRole: 'typescript:source',
        normalizedPath: 'src/index.ts',
        repositoryId,
      };
      const parsed = graphShareParseResultArtifact({
        ...action,
        actionKey: graphShareParseActionKey(action),
        gitBlobId: 'd'.repeat(40),
        facts: {path: action.normalizedPath, diagnostics, edges: [], symbols: []},
      });
      const authority = {
        expiresAt: worker.expiresAt,
        graphAbi: producerGraphAbi,
        principalId: worker.principalId,
        profileDigest,
        repositoryId,
        signingPublicKey: signer.publicKey,
        workerId: worker.workerId,
      };
      const artifact = yield* createGraphWorkerResultArtifact({
        metadata: {
          batchId,
          sourceCommit: batchId,
          graphAbi: producerGraphAbi,
          identityClass: 'oauth-principal',
          issuedAt: Math.floor((yield* Clock.currentTimeMillis) / 1000),
          partialCoverage: false,
          platform: {os: 'linux', architecture: 'x64'},
          principalId: worker.principalId,
          profileDigest,
          releaseIdentity: '4.6.11-local.gsynthetic',
          repositoryId,
          resourceLimits: [],
          workerId: worker.workerId,
        },
        resultBytes: encode(parsed),
        signer,
      });
      const announcement = yield* signGraphWorkerResultAnnouncement({artifact, expected: authority, signer});
      registryBytes.set(`${registry}/manifests/${artifact.manifestDigest}`, artifact.manifestBytes);
      for (const bytes of [encode({}), artifact.resultBytes, artifact.attestationBytes])
        registryBytes.set(`${registry}/blobs/${sha256Digest(bytes)}`, bytes);
      return {announcement, artifact};
    });
  const statePath = yield* graphWorkerAdmissionStatePath(home, yield* readGraphControlPolicy(options.policyFile));
  return {
    candidate,
    candidateCommit,
    commandExecutor: executor,
    enroll,
    fs,
    git,
    key,
    manifest,
    options,
    policy,
    profileDigest,
    publishedCommit,
    registryBytes,
    registryHook,
    registryPaths,
    request,
    signer,
    statePath,
    token,
    validToken,
  };
});

describe('authenticated signed worker admission route', () => {
  effectIt.effect('parks an old source at hot capacity and replays it when that source returns', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const first = yield* f.candidate(worker);
        expect((yield* f.request('/v1/results', f.validToken, first.announcement)).status).toBe(201);
        const policy = yield* readGraphControlPolicy(f.options.policyFile);
        const original = (yield* readGraphWorkerAdmissionStore(f.options.threadnoteHome, policy)).receipts[0];
        const oldReceipts = [original];
        for (let index = 1; index < GRAPH_WORKER_ADMISSION_MAX_RECEIPTS; index += 1) {
          const fields = {
            ...original.announcement.body,
            actionKey: sha256Digest(`old-action-${index}`).slice(7),
            resultManifestDigest: sha256Digest(`old-manifest-${index}`),
          };
          const {idempotencyKey: _, ...operation} = fields;
          const body = {
            ...fields,
            idempotencyKey: sha256Digest('threadnote.graph.worker.result-operation.v1\0' + canonicalJson(operation)),
          };
          const announcement = {...original.announcement, body};
          oldReceipts.push({
            ...original,
            announcement,
            announcementDigest: sha256Digest(canonicalJson(announcement)),
            signedBodyDigest: sha256Digest(canonicalJson(body)),
          });
        }
        oldReceipts.sort((left, right) =>
          left.announcement.body.idempotencyKey.localeCompare(right.announcement.body.idempotencyKey),
        );
        yield* writePrivateJsonFile(f.statePath, {
          quarantine: [],
          receipts: oldReceipts,
          schemaVersion: 2,
        });
        const beforeOverflow = yield* f.fs.readFileString(f.statePath);
        const excess = yield* f.candidate(worker, ['different result']);
        expect(yield* f.request('/v1/results', f.validToken, excess.announcement)).toEqual({
          body: {error: 'capacity-exceeded'},
          status: 429,
        });
        expect(yield* f.fs.readFileString(f.statePath)).toBe(beforeOverflow);
        const path = yield* Path.Path;
        yield* f.fs.writeFileString(path.join(f.options.repoRoot, 'source.txt'), 'new head\n');
        yield* f.git(['add', '.']);
        yield* f.git([
          '-c',
          'user.name=Threadnote Test',
          '-c',
          'user.email=test@threadnote.local',
          'commit',
          '-qm',
          'new head',
        ]);
        const newerHead = (yield* f.git(['rev-parse', 'HEAD'])).stdout.trim();
        const newer = yield* f.candidate(worker, [], newerHead);
        const nextManifest = {
          ...f.manifest,
          checkpoint: {...f.manifest.checkpoint, sourceCommit: f.candidateCommit},
          generation: 2,
          previousManifestDigest: sha256Digest(encode(f.manifest)),
          sourceCommit: f.candidateCommit,
        };
        const signed = yield* signGraphShareFrontier(f.key, nextManifest);
        const manifestDigest = yield* putCasBytes(f.options.casRoot, encode(signed.manifest));
        const envelopeDigest = yield* putCasBytes(f.options.casRoot, encode(signed.envelope));
        const pointerPath = graphSharingFrontierPointerPath(
          path,
          graphSharingLayout(path, f.options.threadnoteHome, f.options.casRoot).frontiersRoot,
          repositoryId,
        );
        const initialPointer = JSON.parse(yield* f.fs.readFileString(pointerPath));
        yield* writePrivateJsonFile(pointerPath, {envelopeDigest, manifestDigest, schemaVersion: 1});
        expect(yield* f.request('/v1/results', f.validToken, newer.announcement)).toEqual({
          body: {error: 'capacity-exceeded'},
          status: 429,
        });
        expect(yield* f.fs.readFileString(f.statePath)).toBe(beforeOverflow);
        yield* writePrivateJsonFile(pointerPath, initialPointer);
        expect((yield* f.request('/v1/results', f.validToken, newer.announcement)).status).toBe(201);
        const hot = JSON.parse(yield* f.fs.readFileString(f.statePath)) as {receipts: unknown[]};
        expect(hot.receipts).toHaveLength(1);
        expect((yield* readGraphWorkerAdmissionStore(f.options.threadnoteHome, policy)).receipts).toHaveLength(
          GRAPH_WORKER_ADMISSION_MAX_RECEIPTS + 1,
        );
        yield* f.git(['checkout', '--detach', f.candidateCommit]);
        const downloads = f.registryPaths.length;
        f.registryBytes.clear();
        expect(yield* f.request('/v1/results', f.validToken, first.announcement)).toEqual({
          body: {idempotencyKey: first.announcement.body.idempotencyKey, status: 'duplicate'},
          status: 200,
        });
        expect(f.registryPaths).toHaveLength(downloads);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('keeps an intermediate source pending until canonical publication reaches it', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const path = yield* Path.Path;
        yield* f.fs.writeFileString(path.join(f.options.repoRoot, 'source.txt'), 'newer head\n');
        yield* f.git(['add', '.']);
        yield* f.git([
          '-c',
          'user.name=Threadnote Test',
          '-c',
          'user.email=test@threadnote.local',
          'commit',
          '-qm',
          'newer head',
        ]);
        const intermediate = yield* f.candidate(worker);
        expect(yield* f.request('/v1/results', f.validToken, intermediate.announcement)).toEqual({
          body: {error: 'source-unavailable'},
          status: 425,
        });
        expect(yield* f.fs.exists(f.statePath)).toBe(false);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('rejects the durably published source even when an older receipt remains', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const stale = yield* f.candidate(worker, [], f.publishedCommit);
        expect(yield* f.request('/v1/results', f.validToken, stale.announcement)).toEqual({
          body: {error: 'stale-source', idempotencyKey: stale.announcement.body.idempotencyKey},
          status: 409,
        });
        expect(yield* f.fs.exists(f.statePath)).toBe(false);

        const first = yield* f.candidate(worker);
        expect((yield* f.request('/v1/results', f.validToken, first.announcement)).status).toBe(201);
        const nextManifest = {
          ...f.manifest,
          checkpoint: {...f.manifest.checkpoint, sourceCommit: f.candidateCommit},
          generation: 2,
          previousManifestDigest: sha256Digest(encode(f.manifest)),
          sourceCommit: f.candidateCommit,
        };
        const signed = yield* signGraphShareFrontier(f.key, nextManifest);
        const manifestDigest = yield* putCasBytes(f.options.casRoot, encode(signed.manifest));
        const envelopeDigest = yield* putCasBytes(f.options.casRoot, encode(signed.envelope));
        const path = yield* Path.Path;
        yield* writePrivateJsonFile(
          graphSharingFrontierPointerPath(
            path,
            graphSharingLayout(path, f.options.threadnoteHome, f.options.casRoot).frontiersRoot,
            repositoryId,
          ),
          {envelopeDigest, manifestDigest, schemaVersion: 1},
        );
        expect(
          (yield* readAuthenticatedGraphShareFrontier(
            f.options.casRoot,
            graphShareRegistryPublicationScope(f.options),
            {envelopeDigest, manifestDigest, schemaVersion: 1},
          )).sourceCommit,
        ).toBe(f.candidateCommit);
        expect(yield* f.request('/v1/results', f.validToken, stale.announcement)).toEqual({
          body: {error: 'stale-source', idempotencyKey: stale.announcement.body.idempotencyKey},
          status: 409,
        });
        const unknown = yield* f.candidate(worker, [], 'd'.repeat(40));
        expect(yield* f.request('/v1/results', f.validToken, unknown.announcement)).toEqual({
          body: {error: 'source-unavailable'},
          status: 425,
        });
        const downloads = f.registryPaths.length;
        expect(yield* f.request('/v1/results', f.validToken, first.announcement)).toEqual({
          body: {error: 'stale-source', idempotencyKey: first.announcement.body.idempotencyKey},
          status: 409,
        });
        expect(f.registryPaths).toHaveLength(downloads);
        const policy = yield* readGraphControlPolicy(f.options.policyFile);
        yield* withCoordinatorStateLock(
          {threadnoteHome: f.options.threadnoteHome},
          retireGraphWorkerAdmissionsForPublishedSourceLocked(f.options.threadnoteHome, policy, f.candidateCommit),
        );
        expect(yield* f.request('/v1/results', f.validToken, first.announcement)).toEqual({
          body: {error: 'stale-source', idempotencyKey: first.announcement.body.idempotencyKey},
          status: 409,
        });
        expect(f.registryPaths.length).toBeGreaterThan(downloads);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('reads bounded scoped admissions and retires the exact published source under coordinator lock', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const {announcement} = yield* f.candidate(worker);
        expect((yield* f.request('/v1/results', f.validToken, announcement)).status).toBe(201);
        const policy = yield* readGraphControlPolicy(f.options.policyFile);
        expect((yield* readGraphWorkerAdmissionStore(f.options.threadnoteHome, policy)).receipts).toHaveLength(1);
        const retired = yield* withCoordinatorStateLock(
          {threadnoteHome: f.options.threadnoteHome},
          retireGraphWorkerAdmissionsForPublishedSourceLocked(f.options.threadnoteHome, policy, f.candidateCommit),
        );
        expect(retired.retired).toBe(1);
        expect((yield* readGraphWorkerAdmissionStore(f.options.threadnoteHome, policy)).receipts).toHaveLength(0);
        expect(
          (yield* retireGraphWorkerAdmissionsForPublishedSourceLocked(
            f.options.threadnoteHome,
            policy,
            f.candidateCommit,
          )).retired,
        ).toBe(0);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('retires only authenticated published ancestors and preserves a newer unpublished source', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const path = yield* Path.Path;
        const commit = (name: string) =>
          Effect.gen(function* () {
            yield* f.fs.writeFileString(path.join(f.options.repoRoot, 'source.txt'), `${name}\n`);
            yield* f.git(['add', '.']);
            yield* f.git([
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '-qm',
              name,
            ]);
            return (yield* f.git(['rev-parse', 'HEAD'])).stdout.trim();
          });
        const intermediate = yield* f.candidate(worker);
        expect((yield* f.request('/v1/results', f.validToken, intermediate.announcement)).status).toBe(201);
        const publishedNext = yield* commit('published next');
        const next = yield* f.candidate(worker, [], publishedNext);
        expect((yield* f.request('/v1/results', f.validToken, next.announcement)).status).toBe(201);
        const unpublished = yield* commit('unpublished newer');
        const later = yield* f.candidate(worker, [], unpublished);
        expect((yield* f.request('/v1/results', f.validToken, later.announcement)).status).toBe(201);
        const policy = yield* readGraphControlPolicy(f.options.policyFile);
        const beforeParking = yield* readGraphWorkerAdmissionStore(f.options.threadnoteHome, policy);
        const parked = beforeParking.receipts.filter(receipt => receipt.sourceCommit === f.candidateCommit);
        const archive = yield* readGraphWorkerAdmissionArchive(f.statePath, policy);
        expect(
          (yield* parkGraphWorkerAdmissionReceipts(f.statePath, policy, archive, f.candidateCommit, parked)).status,
        ).toBe('parked');
        yield* writePrivateJsonFile(f.statePath, {
          quarantine: [],
          receipts: beforeParking.receipts.filter(receipt => receipt.sourceCommit !== f.candidateCommit),
          schemaVersion: 2,
        });
        const cleanup = withCoordinatorStateLock(
          {threadnoteHome: f.options.threadnoteHome},
          retireGraphWorkerAdmissionsCoveredByPublishedSourceLocked(
            {
              casRoot: f.options.casRoot,
              enrollment: f.options.enrollment,
              home: f.options.threadnoteHome,
              profile: f.options.profile,
              repoRoot: f.options.repoRoot,
            },
            policy,
          ),
        ).pipe(Effect.provideService(CommandExecutor, f.commandExecutor));
        expect((yield* cleanup).retired).toBe(0);
        const manifest = {
          ...f.manifest,
          checkpoint: {...f.manifest.checkpoint, sourceCommit: publishedNext},
          generation: 2,
          previousManifestDigest: sha256Digest(encode(f.manifest)),
          sourceCommit: publishedNext,
        };
        const signed = yield* signGraphShareFrontier(f.key, manifest);
        const manifestDigest = yield* putCasBytes(f.options.casRoot, encode(signed.manifest));
        const envelopeDigest = yield* putCasBytes(f.options.casRoot, encode(signed.envelope));
        yield* writePrivateJsonFile(
          graphSharingFrontierPointerPath(
            path,
            graphSharingLayout(path, f.options.threadnoteHome, f.options.casRoot).frontiersRoot,
            repositoryId,
          ),
          {envelopeDigest, manifestDigest, schemaVersion: 1},
        );
        expect((yield* cleanup).retired).toBe(2);
        expect((yield* readGraphWorkerAdmissionArchive(f.statePath, policy)).receipts).toEqual([]);
        expect(
          (yield* readGraphWorkerAdmissionStore(f.options.threadnoteHome, policy)).receipts.map(r => r.sourceCommit),
        ).toEqual([unpublished]);
        expect((yield* cleanup).retired).toBe(0);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('is closed by default even for an enrolled contributor', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture(false);
        const worker = yield* f.enroll;
        const {announcement} = yield* f.candidate(worker);
        expect((yield* f.request('/v1/results', f.validToken, announcement)).status).toBe(403);
        expect(yield* f.fs.exists(f.statePath)).toBe(false);
        expect(f.registryPaths).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('admits exact OCI closure once and replays its durable receipt without hydrating facts', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const {announcement, artifact} = yield* f.candidate(worker);
        const first = yield* f.request('/v1/results', f.validToken, announcement);
        expect(first).toEqual({
          body: {idempotencyKey: announcement.body.idempotencyKey, status: 'accepted'},
          status: 201,
        });
        expect(f.registryPaths).toContain(`${registry}/manifests/${artifact.manifestDigest}`);
        const downloads = f.registryPaths.length;
        f.registryBytes.clear();
        const replay = yield* f.request('/v1/results', f.validToken, announcement);
        expect(replay).toEqual({
          body: {idempotencyKey: announcement.body.idempotencyKey, status: 'duplicate'},
          status: 200,
        });
        expect(f.registryPaths).toHaveLength(downloads);
        const state = JSON.parse(yield* f.fs.readFileString(f.statePath));
        expect(state.receipts).toHaveLength(1);
        expect(JSON.stringify(state)).not.toContain('diagnostics');
        expect(JSON.stringify(state)).not.toContain('src/index.ts');
        yield* f.fs.writeFileString(f.statePath, '{');
        expect((yield* f.request('/v1/results', f.validToken, announcement)).status).toBe(503);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('admits a signed new producer ABI before the published frontier changes', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const producerGraphAbi = 'd'.repeat(64);
        const {announcement} = yield* f.candidate(worker, [], f.candidateCommit, producerGraphAbi);
        expect((yield* f.request('/v1/results', f.validToken, announcement)).status).toBe(201);
        const state = JSON.parse(yield* f.fs.readFileString(f.statePath));
        expect(state.receipts[0].graphAbi).toBe(producerGraphAbi);
        f.registryBytes.clear();
        expect((yield* f.request('/v1/results', f.validToken, announcement)).body).toMatchObject({
          status: 'duplicate',
        });
        expect(
          (yield* f.request('/v1/results', f.validToken, {...announcement, signature: '0'.repeat(128)})).status,
        ).toBe(400);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('keeps fast replay under the coordinator lock until retirement can run', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const {announcement} = yield* f.candidate(worker);
        expect((yield* f.request('/v1/results', f.validToken, announcement)).status).toBe(201);
        f.registryBytes.clear();
        const policy = yield* readGraphControlPolicy(f.options.policyFile);
        const executor = Context.get(yield* Layer.build(TestCommandExecutorLayer), CommandExecutor);
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const calls = yield* Ref.make(0);
        const paused = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const readCurrentPolicy = Ref.updateAndGet(calls, count => count + 1).pipe(
          Effect.flatMap(count =>
            count === 3
              ? Deferred.succeed(paused, undefined).pipe(Effect.flatMap(() => Deferred.await(release)))
              : Effect.void,
          ),
          Effect.as(policy),
        );
        const replay = yield* admitGraphControlWorkerResult({
          announcement,
          casRoot: f.options.casRoot,
          commandExecutor: executor,
          enrollment: f.options.enrollment,
          home: f.options.threadnoteHome,
          initialPolicy: policy,
          principal: {
            expiresAt: now + 600,
            issuer,
            scopes: new Set(['graph:contribute']),
            subject: 'worker-principal',
          },
          profile: f.options.profile,
          repoRoot: f.options.repoRoot,
          readCurrentPolicy,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(paused);
        const retirement = yield* withCoordinatorStateLock(
          {threadnoteHome: f.options.threadnoteHome},
          writePrivateJsonFile(f.statePath, emptyGraphWorkerAdmissionStore()),
        ).pipe(Effect.forkChild);
        const retiredBeforeReplay = yield* Effect.race(
          Fiber.join(retirement).pipe(Effect.as(true)),
          Effect.sleep('100 millis').pipe(Effect.as(false)),
        );
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(replay)).status).toBe('duplicate');
        yield* Fiber.join(retirement);
        expect(retiredBeforeReplay).toBe(false);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('rejects wrong scope, profile, key and manifest substitution before receipt mutation', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const {announcement, artifact} = yield* f.candidate(worker);
        const readOnly = yield* f.token('graph:read');
        expect((yield* f.request('/v1/results', readOnly, announcement)).status).toBe(403);
        expect(
          (yield* f.request('/v1/results', f.validToken, announcement, {
            'x-threadnote-profile-digest': sha256Digest('wrong'),
          })).status,
        ).toBe(403);
        expect(
          (yield* f.request('/v1/results', f.validToken, {...announcement, signature: '0'.repeat(128)})).status,
        ).toBe(400);
        expect(
          (yield* f.request('/v1/results', f.validToken, {...announcement, publicKey: '0'.repeat(64)})).status,
        ).toBe(400);
        f.registryBytes.set(`${registry}/manifests/${artifact.manifestDigest}`, encode({tampered: true}));
        expect((yield* f.request('/v1/results', f.validToken, announcement)).status).toBe(400);
        expect(yield* f.fs.exists(f.statePath)).toBe(false);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('cross-checks every detached claim against the attested result after valid re-signing', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const {announcement} = yield* f.candidate(worker);
        const {idempotencyKey, ...original} = announcement.body;
        void idempotencyKey;
        for (const override of [
          {actionKey: '0'.repeat(64)},
          {attestationDigest: sha256Digest('other-attestation')},
          {batchId: '0'.repeat(40)},
          {semanticDigest: sha256Digest('other-semantics')},
        ]) {
          const fields = {...original, ...override};
          const body = {
            ...fields,
            idempotencyKey: sha256Digest('threadnote.graph.worker.result-operation.v1\0' + canonicalJson(fields)),
          };
          const signed = {...announcement, body, signature: yield* f.signer.sign('announcement', encode(body))};
          expect((yield* f.request('/v1/results', f.validToken, signed)).status).toBe(400);
        }
        expect(yield* f.fs.exists(f.statePath)).toBe(false);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('rechecks a revoked grant and quarantines semantic conflicts across batches', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const first = yield* f.candidate(worker);
        expect((yield* f.request('/v1/results', f.validToken, first.announcement)).status).toBe(201);
        yield* writePrivateJsonFile(f.options.policyFile, {...f.policy, grants: []});
        expect((yield* f.request('/v1/results', f.validToken, first.announcement)).status).toBe(403);
        yield* writePrivateJsonFile(f.options.policyFile, f.policy);
        const conflicting = yield* f.candidate(worker, ['different'], f.candidateCommit);
        const admitted = yield* f.request('/v1/results', f.validToken, conflicting.announcement);
        expect(admitted.body).toMatchObject({status: 'quarantined'});
        const state = JSON.parse(yield* f.fs.readFileString(f.statePath));
        expect(state.receipts).toHaveLength(2);
        expect(state.quarantine).toHaveLength(1);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('bounds request bodies and rejects malformed JSON without registry I/O', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const {announcement} = yield* f.candidate(worker);
        expect((yield* f.request('/v1/results', f.validToken, {large: 'x'.repeat(65_536)})).status).toBe(413);
        expect(
          (yield* f.request('/v1/results', f.validToken, {body: {workerId: worker.workerId}, unknown: true})).status,
        ).toBe(400);
        expect(
          (yield* f.request('/v1/results', f.validToken, announcement, {'content-type': 'text/plain'})).status,
        ).toBe(400);
        expect(f.registryPaths).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('rejects a canonical-overlapping worker registry before any OCI read', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const {announcement} = yield* f.candidate(worker);
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const policy = yield* readGraphControlPolicy(f.options.policyFile);
        const profile = {
          ...f.options.profile,
          registry: {...f.options.profile.registry, canonical: f.options.profile.registry.worker},
        };
        const executor = Context.get(yield* Layer.build(TestCommandExecutorLayer), CommandExecutor);
        for (const boundPolicy of [policy, {...policy, profileDigest: graphShareProfileDigest(profile)}]) {
          const outcome = yield* admitGraphControlWorkerResult({
            announcement,
            casRoot: f.options.casRoot,
            commandExecutor: executor,
            enrollment: f.options.enrollment,
            home: f.options.threadnoteHome,
            initialPolicy: boundPolicy,
            principal: {
              expiresAt: now + 600,
              issuer,
              scopes: new Set(['graph:contribute']),
              subject: 'worker-principal',
            },
            profile,
            repoRoot: f.options.repoRoot,
            readCurrentPolicy: Effect.succeed(boundPolicy),
          }).pipe(Effect.flip);
          expect(outcome).toMatchObject({kind: 'verification-failed'});
        }
        expect(f.registryPaths).toEqual([]);
        expect(yield* f.fs.exists(f.statePath)).toBe(false);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('keeps metadata responsive while two registry reads exceed ten seconds', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const {announcement} = yield* f.candidate(worker);
        let signalStarted: (() => void) | undefined;
        let releaseRegistry: (() => void) | undefined;
        const bothStarted = new Promise<void>(resolve => {
          signalStarted = resolve;
        });
        const released = new Promise<void>(resolve => {
          releaseRegistry = resolve;
        });
        let waiting = 0;
        f.registryHook.current = async address => {
          if (!address.includes('/manifests/')) return;
          waiting += 1;
          if (waiting === 2) signalStarted?.();
          await released;
        };
        yield* Effect.gen(function* () {
          const first = yield* Effect.forkChild(f.request('/v1/results', f.validToken, announcement));
          const second = yield* Effect.forkChild(f.request('/v1/results', f.validToken, announcement));
          yield* Effect.promise(() => bothStarted);
          expect((yield* f.request('/v1/results', f.validToken, announcement)).status).toBe(503);
          const readToken = yield* f.token('graph:read');
          expect((yield* f.request('/v1/status', readToken, undefined, {}, 'GET')).status).toBe(200);
          yield* Effect.sleep('11 seconds');
          releaseRegistry?.();
          const responses = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
          expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
        }).pipe(Effect.ensuring(Effect.sync(() => releaseRegistry?.())));
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('holds result download and receipt commit behind the coordinator pointer lock', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const worker = yield* f.enroll;
        const {announcement} = yield* f.candidate(worker);
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const lockOwner = yield* withCoordinatorStateLock(
          {threadnoteHome: f.options.threadnoteHome},
          Effect.gen(function* () {
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(release);
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(locked);
        yield* Effect.gen(function* () {
          const submission = yield* Effect.forkChild(f.request('/v1/results', f.validToken, announcement));
          yield* Effect.sleep('100 millis');
          expect(f.registryPaths).toEqual([]);
          expect(yield* f.fs.exists(f.statePath)).toBe(false);
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(submission)).status).toBe(201);
          yield* Fiber.join(lockOwner);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      }).pipe(provideTestLayer(layer)),
    ),
  );
});
