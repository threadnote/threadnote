import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Deferred, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {writePrivateJsonFile} from '@threadnote/graph/sharing/atomic';
import {graphShareControlGetTag, graphShareControlPutTag} from '@threadnote/graph/sharing/control/client';
import {recordPublishedFrontier, runGraphShareControlServer} from '@threadnote/graph/sharing/control/server';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphSharingLayout, graphSharingTagPath} from '@threadnote/graph/sharing/layout';
import {graphShareFrontierDiscoveryTag} from '@threadnote/graph/sharing/namespace';

const sharingLayer = Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer);
const hex40 = FC.array(FC.constantFrom(...'0123456789abcdef'), {minLength: 40, maxLength: 40}).map(value =>
  value.join(''),
);

const startCoordinator = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadnoteHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-authority-'});
  const casRoot = path.join(threadnoteHome, 'cas');
  yield* fs.makeDirectory(casRoot, {recursive: true, mode: 0o700});
  const options = {casRoot, organization: 'acme', repositoryId: 'a'.repeat(64), threadnoteHome};
  const ready = yield* Deferred.make<{readonly url: string}>();
  yield* Effect.forkScoped(
    runGraphShareControlServer({
      ...options,
      listen: {hostname: '127.0.0.1', port: 0},
      onListening: info => Deferred.succeed(ready, info).pipe(Effect.asVoid),
    }),
  );
  return {...options, ...(yield* Deferred.await(ready))};
});

describe('graph contributor authority', () => {
  fcEffectProp(
    effectIt,
    'contributor requests cannot create or replace publisher discovery tags',
    {suffix: hex40, body: FC.string({maxLength: 128})},
    ({suffix, body}) =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const client = yield* HttpClient.HttpClient;
          const server = yield* startCoordinator;
          const original = {digest: sha256Digest('original'), schemaVersion: 1};
          for (const prefix of ['tn-frontier-', 'tn-work-']) {
            const tag = `${prefix}${suffix}`;
            const tagPath = graphSharingTagPath(path, server.casRoot, tag);
            const validBody = JSON.stringify({digest: sha256Digest(body)});
            const attempt = (payload: string) =>
              client.execute(
                HttpClientRequest.put(`${server.url}/v1/tags/${tag}`).pipe(
                  HttpClientRequest.bodyUint8Array(new TextEncoder().encode(payload), 'application/json'),
                ),
              );
            expect((yield* attempt(validBody)).status).toBe(403);
            expect(yield* fs.exists(tagPath)).toBe(false);
            yield* writePrivateJsonFile(tagPath, original);
            const before = yield* fs.readFileString(tagPath);
            expect((yield* attempt(validBody)).status).toBe(403);
            expect((yield* attempt('{')).status).toBe(403);
            expect(yield* fs.readFileString(tagPath)).toBe(before);
            expect(yield* graphShareControlGetTag(server.url, tag)).toBe(original.digest);
          }
        }).pipe(provideTestLayer(sharingLayer)),
      ),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('keeps internal publisher advancement and contributor action-cache writes available', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const server = yield* startCoordinator;
        const branch = 'refs/heads/main';
        const tag = graphShareFrontierDiscoveryTag(server.repositoryId, branch);
        const published = {
          branch,
          descriptorDigest: sha256Digest('descriptor-one'),
          envelopeDigest: sha256Digest('envelope-one'),
          generation: 1,
          manifestDigest: sha256Digest('manifest-one'),
          repositoryId: server.repositoryId,
          sourceCommit: 'b'.repeat(40),
        };
        yield* recordPublishedFrontier(server, published);
        const next = {...published, descriptorDigest: sha256Digest('descriptor-two'), generation: 2};
        yield* recordPublishedFrontier(server, next);
        expect(yield* graphShareControlGetTag(server.url, tag)).toBe(next.descriptorDigest);
        const actionTag = `tn-action-${'c'.repeat(64)}`;
        const actionDigest = sha256Digest('worker-result');
        yield* graphShareControlPutTag(server.url, actionTag, actionDigest);
        expect(yield* graphShareControlGetTag(server.url, actionTag)).toBe(actionDigest);
        expect(yield* graphShareControlGetTag(server.url, tag)).toBe(next.descriptorDigest);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('denies assembly leases without changing coordinator or canonical state', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const client = yield* HttpClient.HttpClient;
        const server = yield* startCoordinator;
        const branch = 'refs/heads/main';
        const tag = graphShareFrontierDiscoveryTag(server.repositoryId, branch);
        const published = {
          branch,
          descriptorDigest: sha256Digest('descriptor'),
          envelopeDigest: sha256Digest('envelope'),
          generation: 1,
          manifestDigest: sha256Digest('manifest'),
          repositoryId: server.repositoryId,
          sourceCommit: 'b'.repeat(40),
        };
        yield* recordPublishedFrontier(server, published);
        const statePath = graphSharingLayout(path, server.threadnoteHome).coordinatorStatePath;
        const before = yield* fs.readFileString(statePath);
        for (const body of [JSON.stringify({batchId: 'c'.repeat(40), idempotencyKey: 'worker-lease'}), '{']) {
          const response = yield* client.execute(
            HttpClientRequest.post(`${server.url}/v1/assembly-leases`).pipe(
              HttpClientRequest.bodyUint8Array(new TextEncoder().encode(body), 'application/json'),
            ),
          );
          expect(response.status).toBe(403);
        }
        expect(yield* fs.readFileString(statePath)).toBe(before);
        expect(yield* graphShareControlGetTag(server.url, tag)).toBe(published.descriptorDigest);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );
});
