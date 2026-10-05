import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Console, Effect, FileSystem, Layer, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import * as HttpServer from 'effect/http/HttpServer';
import {generateKeyPair, SignJWT} from 'jose';
import {createAccessTokenVerifier} from '@threadnote/protocol/access-token';
import {
  generateGraphSharePublisherKey,
  signGraphShareFrontier,
  type GraphShareFrontierManifestV1,
} from '@threadnote/graph/sharing/artifacts';
import {writePrivateJsonFile} from '@threadnote/graph/sharing/atomic';
import {casBlobPath, putCasBytes} from '@threadnote/graph/sharing/cas';
import {makeGraphControlReader, readGraphControlFrontier} from '@threadnote/graph/sharing/control/reader';
import {emptyGraphShareCoordinatorState} from '@threadnote/graph/sharing/control/protocol';
import {readGraphControlPolicy} from '@threadnote/graph/sharing/control/authorization';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {adoptPublishedFrontier, observeCanonicalHead} from '@threadnote/graph/sharing/frontier';
import {graphSharingFrontierPointerPath, graphSharingLayout} from '@threadnote/graph/sharing/layout';
import {graphShareFrontierDiscoveryTag} from '@threadnote/graph/sharing/namespace';
import {defaultGraphShareProfile, graphShareProfileDigest} from '@threadnote/graph/sharing/profile';

import {provideTestLayer} from '../helpers/effect-layer.js';

const ISSUER = 'https://identity.example.test/';
const AUDIENCE = 'https://graph.example.test';
const REPOSITORY = 'a'.repeat(64);

const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-control-reader-'});
  const key = yield* generateGraphSharePublisherKey();
  const profile = defaultGraphShareProfile({
    branch: 'main',
    canonicalRemote: 'github.com/acme/repo',
    organization: 'acme',
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: REPOSITORY,
  });
  const profileDigest = graphShareProfileDigest(profile);
  const options = {
    casRoot: path.join(home, 'cas'),
    enrollment: {
      profile: `cas://${profileDigest}`,
      publisherKeyFingerprint: key.fingerprint,
      repositoryId: REPOSITORY,
      schemaVersion: 1 as const,
    },
    policyFile: path.join(home, 'policy.json'),
    profile,
    threadnoteHome: home,
  };
  const manifest: GraphShareFrontierManifestV1 = {
    branch: 'refs/heads/main',
    checkpoint: {
      manifestDigest: sha256Digest('checkpoint'),
      snapshotId: `cgsn_${'a'.repeat(40)}`,
      sourceCommit: 'b'.repeat(40),
    },
    deltas: [],
    generation: 1,
    graphAbi: 'c'.repeat(64),
    graphContentId: `cgc_${'d'.repeat(40)}`,
    logicalGraphDigest: sha256Digest('logical'),
    previousManifestDigest: null,
    profileDigest,
    publisherFence: 1,
    repositoryId: REPOSITORY,
    schemaVersion: 1,
    snapshotId: `cgsn_${'a'.repeat(40)}`,
    sourceCommit: 'b'.repeat(40),
  };
  const pointerFile = graphSharingFrontierPointerPath(
    path,
    graphSharingLayout(path, home, options.casRoot).frontiersRoot,
    REPOSITORY,
  );
  const publish = (value: GraphShareFrontierManifestV1) =>
    Effect.gen(function* () {
      const signed = yield* signGraphShareFrontier(key, value);
      const manifestDigest = yield* putCasBytes(
        options.casRoot,
        new TextEncoder().encode(JSON.stringify(signed.manifest)),
      );
      const envelopeDigest = yield* putCasBytes(
        options.casRoot,
        new TextEncoder().encode(JSON.stringify(signed.envelope)),
      );
      const pointer = {envelopeDigest, manifestDigest, schemaVersion: 1};
      yield* writePrivateJsonFile(pointerFile, pointer);
      return pointer;
    });
  const pointer = yield* publish(manifest);
  const coordinatorStateRef = yield* Ref.make({
    ...emptyGraphShareCoordinatorState({organization: 'acme', repositoryId: REPOSITORY}),
    machine: adoptPublishedFrontier(
      emptyGraphShareCoordinatorState({organization: 'acme', repositoryId: REPOSITORY}).machine,
      {generation: manifest.generation, manifestDigest: pointer.manifestDigest, sourceCommit: manifest.sourceCommit},
    ),
  });
  const at = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const policy = {
    audience: AUDIENCE,
    grants: [{expiresAt: at + 3600, scopes: ['graph:read'], subject: 'private-reader'}],
    issuer: ISSUER,
    jwksUrl: `${ISSUER}.well-known/jwks.json`,
    organization: 'acme',
    profileDigest,
    repositoryId: REPOSITORY,
    schemaVersion: 1,
  };
  yield* writePrivateJsonFile(options.policyFile, policy);
  const jwtKey = yield* Effect.promise(() => generateKeyPair('RS256'));
  const token = (overrides: Record<string, unknown> = {}) =>
    Effect.gen(function* () {
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      return yield* Effect.promise(() =>
        new SignJWT({
          aud: AUDIENCE,
          exp: now + 300,
          iat: now,
          iss: ISSUER,
          scope: 'graph:read',
          sub: 'private-reader',
          ...overrides,
        })
          .setProtectedHeader({alg: 'RS256'})
          .sign(jwtKey.privateKey),
      );
    });
  const validToken = yield* token();
  const reader = yield* makeGraphControlReader(
    {...options, coordinatorStateRef},
    createAccessTokenVerifier(jwtKey.publicKey, {audience: AUDIENCE, issuer: ISSUER}),
  );
  const context = yield* Layer.build(BunHttpServer.layer({hostname: '127.0.0.1', port: 0}));
  const server = yield* HttpServer.HttpServer.pipe(Effect.provide(context));
  const audits: string[] = [];
  const inherited = yield* Console.Console;
  yield* server.serve(
    reader.handle.pipe(
      Effect.provideService(Console.Console, {
        ...inherited,
        log: (...values: readonly unknown[]) => {
          audits.push(...values.map(String));
        },
      }),
    ),
  );
  if (server.address._tag === 'UnixPathAddress') throw new Error('Expected TCP');
  const url = `http://127.0.0.1:${server.address.port}`;
  const request = (
    pathname = '/v1/status',
    auth = validToken,
    headers: Record<string, string> = {},
    method = 'GET',
    body?: unknown,
  ) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = (
        method === 'GET' ? HttpClientRequest.get(url + pathname) : HttpClientRequest.post(url + pathname)
      ).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${auth}`,
          'x-threadnote-repository-id': REPOSITORY,
          'x-threadnote-profile-digest': profileDigest,
          ...headers,
        }),
      );
      const outbound =
        body === undefined
          ? request
          : request.pipe(
              HttpClientRequest.bodyUint8Array(new TextEncoder().encode(JSON.stringify(body)), 'application/json'),
            );
      const response = yield* client.execute(outbound);
      return {body: yield* response.json, headers: response.headers, status: response.status};
    });
  return {
    audits,
    coordinatorStateRef,
    fs,
    home,
    manifest,
    options,
    pointer,
    pointerFile,
    policy,
    profileDigest,
    publish,
    request,
    token,
    validToken,
  };
});

describe('authenticated metadata-only graph reads', () => {
  effectIt.effect('shows an authorized exact collection head while retaining the verified published frontier', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const nextHead = 'e'.repeat(40);
        expect((yield* f.request()).body).toMatchObject({
          generation: 1,
          observedHead: null,
          phase: 'published',
          publishedFrontier: f.manifest.sourceCommit,
          receipts: [],
        });
        yield* Ref.update(f.coordinatorStateRef, state => ({
          ...state,
          machine: observeCanonicalHead(state.machine, {
            commit: nextHead,
            isDescendantOfPublished: true,
            nowSeconds: 100,
          }),
        }));
        expect((yield* f.request()).body).toMatchObject({
          generation: 1,
          observedHead: nextHead,
          phase: 'collecting',
          publishedFrontier: f.manifest.sourceCommit,
          receipts: [],
        });
        yield* Ref.update(f.coordinatorStateRef, state => ({
          ...state,
          machine: observeCanonicalHead(state.machine, {
            commit: 'f'.repeat(40),
            isDescendantOfPublished: false,
            nowSeconds: 101,
          }),
        }));
        expect((yield* f.request()).body).toMatchObject({
          observedHead: null,
          phase: 'published',
          publishedFrontier: f.manifest.sourceCommit,
        });
        expect((yield* f.request('/v1/status', '')).status).toBe(401);
        yield* Ref.update(f.coordinatorStateRef, state => ({
          ...state,
          machine: {...state.machine, publishedFrontier: 'f'.repeat(40)},
        }));
        expect((yield* f.request()).body).toMatchObject({
          observedHead: null,
          phase: 'published',
          publishedFrontier: f.manifest.sourceCommit,
        });
      }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer))),
    ),
  );

  effectIt.effect(
    'serves verified metadata while denying artifacts and every mutation without changing graph state',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const f = yield* fixture();
          const before = yield* f.fs.readFileString(f.pointerFile);
          const status = yield* f.request();
          expect(status.status).toBe(200);
          expect(status.body).toMatchObject({
            generation: 1,
            profileDigest: f.profileDigest,
            receipts: [],
            repositoryId: REPOSITORY,
          });
          expect(status.headers['cache-control']).toBe('no-store');
          const branchHash = graphShareFrontierDiscoveryTag(REPOSITORY, 'refs/heads/main').slice('tn-frontier-'.length);
          expect((yield* f.request(`/v1/frontiers/${branchHash}`)).body).toMatchObject({
            envelopeDigest: f.pointer.envelopeDigest,
            manifestDigest: f.pointer.manifestDigest,
          });
          expect((yield* f.request('/.well-known/threadnote-graph', '')).body).toEqual({
            controlMode: 'authenticated-metadata',
            organization: 'acme',
            protocolVersions: ['v1'],
          });
          for (const route of [
            '/v1/cas/sha256/' + 'a'.repeat(64),
            '/v1/tags/tn-action-' + 'a'.repeat(64),
            '/v1/work/' + 'a'.repeat(40),
          ])
            expect((yield* f.request(route)).status).toBe(404);
          for (const route of ['/v1/enroll', '/v1/results', '/v1/claims', '/v1/assembly-leases'])
            expect((yield* f.request(route, f.validToken, {}, 'POST')).status).toBe(403);
          expect(yield* f.fs.readFileString(f.pointerFile)).toBe(before);
          expect(f.audits.length).toBeGreaterThan(0);
          for (const event of f.audits) {
            const parsed = JSON.parse(event);
            expect(Object.keys(parsed).sort()).toEqual(
              parsed.principalId === undefined
                ? ['event', 'operation', 'status']
                : ['event', 'operation', 'principalId', 'status'],
            );
            expect(event).not.toContain(f.validToken);
            expect(event).not.toContain('private-reader');
            expect(event).not.toContain(f.home);
          }
        }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer))),
      ),
  );

  effectIt.effect('enrolls only the authenticated contributor and replays the same bounded identity', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* writePrivateJsonFile(f.options.policyFile, {
          ...f.policy,
          grants: [{...f.policy.grants[0], scopes: ['graph:read', 'graph:contribute']}],
        });
        const token = yield* f.token({scope: 'graph:contribute'});
        const body = {idempotencyKey: 'same-operation', repositoryId: REPOSITORY, profileDigest: f.profileDigest};
        expect((yield* f.request('/v1/enroll', f.validToken, {}, 'POST', body)).status).toBe(403);
        const first = yield* f.request('/v1/enroll', token, {}, 'POST', body);
        expect(first.status).toBe(201);
        expect(first.body).toMatchObject({
          repositoryId: REPOSITORY,
          profileDigest: f.profileDigest,
          workerId: expect.stringMatching(/^gw_[0-9a-f]{32}$/u),
          expiresAt: expect.any(Number),
        });
        expect(
          (yield* f.request('/v1/enroll', token, {}, 'POST', {...body, profileDigest: sha256Digest('wrong-profile')}))
            .status,
        ).toBe(403);
        expect(
          (yield* f.request('/v1/enroll', token, {}, 'POST', {...body, idempotencyKey: 'x'.repeat(65_536)})).status,
        ).toBe(413);
        const replay = yield* f.request('/v1/enroll', token, {}, 'POST', body);
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(first.body);
        for (const override of [
          {workerId: 'selected'},
          {role: 'publisher'},
          {source: 'secret'},
          {expiresAt: 9999999999},
        ])
          expect((yield* f.request('/v1/enroll', token, {}, 'POST', {...body, ...override})).status).toBe(400);
        expect((yield* f.request('/v1/status', token)).status).toBe(403);
        yield* writePrivateJsonFile(f.options.policyFile, {...f.policy, grants: []});
        expect((yield* f.request('/v1/enroll', token, {}, 'POST', body)).status).toBe(403);
        for (const text of f.audits) {
          expect(text).not.toContain(token);
          expect(text).not.toContain('same-operation');
        }
      }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer))),
    ),
  );

  effectIt.effect('rejects invalid JWTs, wrong scope and memory administrator tokens with bounded errors', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const token of [
          '',
          'private-malformed-token',
          yield* f.token({iss: ISSUER.slice(0, -1)}),
          yield* f.token({aud: 'https://other.example.test'}),
        ]) {
          const result = yield* f.request('/v1/status', token);
          expect(result.status).toBe(401);
          expect(result.body).toEqual({error: 'unauthorized'});
          expect(result.headers['www-authenticate']).toBe('Bearer');
        }
        for (const token of [yield* f.token({scope: 'memory:admin'}), yield* f.token({sub: 'other-reader'})])
          expect((yield* f.request('/v1/status', token)).status).toBe(403);
        for (const headers of [
          {'x-threadnote-repository-id': 'b'.repeat(64)},
          {'x-threadnote-profile-digest': sha256Digest('wrong')},
        ] as Record<string, string>[])
          expect((yield* f.request('/v1/status', f.validToken, headers)).status).toBe(403);
      }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer))),
    ),
  );

  effectIt.effect('observes grant expiry/removal immediately and fails closed on malformed or changed authority', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const grants of [[], [{...f.policy.grants[0], expiresAt: 1}]]) {
          yield* writePrivateJsonFile(f.options.policyFile, {...f.policy, grants});
          expect((yield* f.request()).status).toBe(403);
        }
        yield* writePrivateJsonFile(f.options.policyFile, f.policy);
        expect((yield* f.request()).status).toBe(200);
        yield* f.fs.writeFileString(f.options.policyFile, '{');
        expect((yield* f.request()).body).toEqual({error: 'unavailable'});
        yield* writePrivateJsonFile(f.options.policyFile, {...f.policy, audience: 'https://changed.example.test'});
        expect((yield* f.request()).status).toBe(503);
        yield* f.fs.remove(f.options.policyFile);
        expect((yield* f.request()).status).toBe(503);
      }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer))),
    ),
  );

  effectIt.effect('rejects a signed frontier from another profile, repository or branch', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const manifest of [
          {...f.manifest, profileDigest: sha256Digest('other')},
          {...f.manifest, repositoryId: 'b'.repeat(64)},
          {...f.manifest, branch: 'refs/heads/other'},
        ]) {
          yield* f.publish(manifest);
          expect((yield* f.request()).status).toBe(503);
        }
        yield* f.publish(f.manifest);
        expect((yield* readGraphControlFrontier(f.options)).manifest).toEqual(f.manifest);
      }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer))),
    ),
  );

  effectIt.effect('rejects oversized policy files before decoding', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-policy-bound-'});
      const file = `${directory}/policy.json`;
      yield* fs.writeFileString(file, ' '.repeat(128 * 1024 + 1));
      expect((yield* readGraphControlPolicy(file).pipe(Effect.result))._tag).toBe('Failure');
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('returns bounded errors for corrupt or oversized artifacts and invalid signatures', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const envelopeFile = yield* casBlobPath(f.options.casRoot, f.pointer.envelopeDigest);
        const envelope = JSON.parse(yield* f.fs.readFileString(envelopeFile));
        for (const value of ['{', JSON.stringify({privateInvalidField: f.home}), ' '.repeat(64 * 1024 + 1)]) {
          const manifestDigest = yield* putCasBytes(f.options.casRoot, new TextEncoder().encode(value));
          yield* writePrivateJsonFile(f.pointerFile, {...f.pointer, manifestDigest});
          const response = yield* f.request();
          expect(response.status).toBe(503);
          expect(response.body).toEqual({error: 'unavailable'});
        }
        const envelopeDigest = yield* putCasBytes(
          f.options.casRoot,
          new TextEncoder().encode(JSON.stringify({...envelope, signature: '0'.repeat(128)})),
        );
        yield* writePrivateJsonFile(f.pointerFile, {...f.pointer, envelopeDigest});
        expect((yield* f.request()).body).toEqual({error: 'unavailable'});
        expect(JSON.stringify(f.audits)).not.toContain(f.home);
      }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer))),
    ),
  );
});
