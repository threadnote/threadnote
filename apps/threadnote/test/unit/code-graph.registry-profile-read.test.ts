import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer} from 'effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE} from '@threadnote/graph/sharing/artifacts';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphShareProfileOciArtifact} from '@threadnote/graph/sharing/profile/oci_artifact';
import {defaultGraphShareProfile} from '@threadnote/graph/sharing/profile';
import {makeGraphShareRegistryReader} from '@threadnote/graph/sharing/registry/reader';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, FetchHttpClient.layer);

effectIt.effect('reads a profile manifest only by exact digest with bounded verified registry bytes', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const system = yield* SystemInfo;
    const directory = yield* fs.makeTempDirectoryScoped({prefix: 'graph-profile-read-'});
    const artifact = graphShareProfileOciArtifact(
      defaultGraphShareProfile({
        branch: 'refs/heads/main',
        canonicalRemote: 'github.com/acme/repository',
        organization: 'acme',
        publisherKeyFingerprint: sha256Digest('publisher'),
        repositoryId: 'a'.repeat(64),
      }),
    );
    let mode: 'valid' | 'oversized' | 'wrong-header' | 'wrong-media' | 'tampered' = 'valid';
    let requests = 0;
    const fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        requests++;
        expect(String(url)).toBe(`https://registry.example.test/v2/acme/profile/manifests/${artifact.manifestDigest}`);
        expect(init?.redirect).toBe('manual');
        expect(new Headers(init?.headers).get('accept')).toBe(GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE);
        const bytes =
          mode === 'oversized'
            ? new Uint8Array(8193)
            : mode === 'tampered'
              ? new TextEncoder().encode('{}')
              : artifact.manifestBytes;
        return new Response(new Uint8Array(bytes), {
          headers: {
            'content-type': mode === 'wrong-media' ? 'application/json' : GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            'docker-content-digest': mode === 'wrong-header' ? sha256Digest('other') : sha256Digest(bytes),
          },
        });
      },
      {preconnect: () => undefined},
    ) as typeof globalThis.fetch;
    const reader = yield* makeGraphShareRegistryReader('oci://registry.example.test/acme/profile').pipe(
      Effect.provideService(SystemInfo, {...system, environment: () => ({DOCKER_CONFIG: directory})}),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(CommandExecutor, {
        execute: () => Effect.die('Unexpected credential helper'),
        executeStreaming: () => Effect.die('Unexpected credential helper'),
      }),
    );
    for (const invalid of [
      'latest',
      'tn-frontier-' + 'a'.repeat(40),
      artifact.manifestDigest.slice('sha256:'.length),
      artifact.manifestDigest + '?repository=other',
      '../foreign',
    ]) {
      expect((yield* Effect.result(reader.readProfileManifest(invalid)))._tag).toBe('Failure');
    }
    expect((yield* Effect.result(reader.readManifest(artifact.manifestDigest)))._tag).toBe('Failure');
    expect(requests).toBe(0);
    expect(new Uint8Array(yield* reader.readProfileManifest(artifact.manifestDigest))).toEqual(artifact.manifestBytes);
    for (const next of ['oversized', 'wrong-header', 'wrong-media', 'tampered'] as const) {
      mode = next;
      expect((yield* Effect.result(reader.readProfileManifest(artifact.manifestDigest)))._tag).toBe('Failure');
    }
    expect(requests).toBe(5);
  }).pipe(provideTestLayer(layer)),
);
