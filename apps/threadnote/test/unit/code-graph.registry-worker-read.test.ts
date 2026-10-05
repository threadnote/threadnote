import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer} from 'effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {makeGraphShareRegistryReader} from '@threadnote/graph/sharing/registry/reader';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE} from '@threadnote/graph/sharing/artifacts';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, FetchHttpClient.layer);

effectIt.effect(
  'fetches worker manifests only by exact digest under the fixed repository with bounded verified bytes',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const system = yield* SystemInfo;
      const directory = yield* fs.makeTempDirectoryScoped({prefix: 'graph-worker-read-'});
      const bytes = new TextEncoder().encode('{"synthetic":"manifest"}');
      const digest = sha256Digest(bytes);
      let mode: 'valid' | 'oversized' | 'wrong-digest' | 'wrong-media' = 'valid';
      let requests = 0;
      const fetch = Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          requests++;
          expect(String(url)).toBe('https://registry.example.test/v2/acme/worker/manifests/' + digest);
          expect(init?.redirect).toBe('manual');
          expect(new Headers(init?.headers).get('accept')).toBe(GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE);
          return new Response(mode === 'oversized' ? new Uint8Array(8193) : bytes, {
            headers: {
              'content-type': mode === 'wrong-media' ? 'application/json' : GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
              'docker-content-digest': mode === 'wrong-digest' ? sha256Digest('other') : digest,
            },
          });
        },
        {preconnect: () => undefined},
      ) as typeof globalThis.fetch;
      const reader = yield* makeGraphShareRegistryReader('oci://registry.example.test/acme/worker').pipe(
        Effect.provideService(SystemInfo, {...system, environment: () => ({DOCKER_CONFIG: directory})}),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provideService(CommandExecutor, {
          execute: () => Effect.die('Unexpected credential helper'),
          executeStreaming: () => Effect.die('Unexpected credential helper'),
        }),
      );
      for (const invalid of ['latest', '../foreign', 'https://foreign.example.test', digest + '?destination=other'])
        expect((yield* Effect.result(reader.readWorkerManifest(invalid)))._tag).toBe('Failure');
      expect(requests).toBe(0);
      expect(new Uint8Array(yield* reader.readWorkerManifest(digest))).toEqual(bytes);
      for (const next of ['oversized', 'wrong-digest', 'wrong-media'] as const) {
        mode = next;
        expect((yield* Effect.result(reader.readWorkerManifest(digest)))._tag).toBe('Failure');
      }
      expect(requests).toBe(4);
    }).pipe(provideTestLayer(layer)),
);
