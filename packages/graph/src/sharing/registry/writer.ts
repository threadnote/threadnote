import {Effect} from 'effect';
import {GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE} from '../artifacts.js';
import {parseSha256Digest, sha256Digest} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {
  GRAPH_SHARE_HTTP_CAS_MAX_BYTES,
  GRAPH_SHARE_REGISTRY_MANIFEST_MAX_BYTES,
  graphSharePayloadLooksLikeGitObject,
} from '../oci.js';
import {makeGraphShareRegistryHttp} from './http.js';
import {parseGraphShareRegistryTarget} from './reference.js';
import {parseGraphShareRegistryUploadLocation} from './upload.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const makeGraphShareRegistryWriter = Effect.fn('codeGraph.sharing.registryWriter')(function* <
  E = never,
  R = never,
>(reference: string, isAuthorized?: Effect.Effect<boolean, E, R>) {
  const target = yield* Effect.try({
    try: () => parseGraphShareRegistryTarget(reference),
    catch: () => graphSharingFailure('OCI registry reference is invalid.'),
  });
  const request = yield* makeGraphShareRegistryHttp(target, 'write', isAuthorized);
  const prefix = `/v2/${target.repository}/`;
  const manifestPath = (reference: string) =>
    Effect.gen(function* () {
      if (!/^(?:sha256:[0-9a-f]{64}|[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/u.test(reference))
        return yield* graphSharingFailure('Registry manifest reference is invalid.');
      return `${prefix}manifests/${reference}`;
    });
  return {
    putBlob: (digest: string, bytes: Uint8Array) =>
      Effect.gen(function* () {
        if (
          bytes.byteLength > GRAPH_SHARE_HTTP_CAS_MAX_BYTES ||
          sha256Digest(bytes) !== digest ||
          graphSharePayloadLooksLikeGitObject(bytes)
        )
          return yield* graphSharingFailure('Registry upload blob is invalid.');
        const present = yield* request(`${prefix}blobs/${digest}`, 0, 'application/octet-stream', {
          method: 'HEAD',
          acceptedStatuses: [200, 404],
        });
        if (present.status === 200) {
          if (
            present.headers['docker-content-digest'] !== digest ||
            present.headers['content-length'] !== String(bytes.byteLength)
          )
            return yield* graphSharingFailure('Registry existing blob acknowledgement is invalid.');
          return {digest, existed: true};
        }
        let completed = false;
        return yield* Effect.acquireUseRelease(
          request(`${prefix}blobs/uploads/`, 0, 'application/json', {method: 'POST', acceptedStatuses: [202]}).pipe(
            Effect.flatMap(response =>
              Effect.try({
                try: () => parseGraphShareRegistryUploadLocation(target, response.headers.location),
                catch: () => graphSharingFailure('Registry upload location is invalid.'),
              }),
            ),
          ),
          location =>
            Effect.gen(function* () {
              const response = yield* request(
                `${location}${Effect2.pipe(location, EffectString.includes('?')) ? '&' : '?'}digest=${digest}`,
                0,
                'application/json',
                {method: 'PUT', body: bytes, acceptedStatuses: [201]},
              );
              if (response.headers['docker-content-digest'] !== digest)
                return yield* graphSharingFailure('Registry upload acknowledgement is invalid.');
              completed = true;
              return {digest, existed: false};
            }),
          location =>
            completed
              ? Effect.void
              : request(location, 0, 'application/json', {
                  method: 'DELETE',
                  acceptedStatuses: [204, 404],
                }).pipe(Effect.timeout(2000), Effect.ignore),
        );
      }),
    putManifest: (reference: string, bytes: Uint8Array) =>
      Effect.gen(function* () {
        const pathname = yield* manifestPath(reference);
        const digest = sha256Digest(bytes);
        if (
          bytes.byteLength > GRAPH_SHARE_REGISTRY_MANIFEST_MAX_BYTES ||
          (Effect2.pipe(reference, EffectString.startsWith('sha256:')) && reference !== digest)
        )
          return yield* graphSharingFailure('Registry manifest upload is invalid.');
        const response = yield* request(pathname, 0, 'application/json', {
          method: 'PUT',
          body: bytes,
          contentType: GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
          acceptedStatuses: [201],
        });
        if (response.headers['docker-content-digest'] !== digest)
          return yield* graphSharingFailure('Registry manifest acknowledgement is invalid.');
        return digest;
      }),
    headManifest: (reference: string) =>
      Effect.gen(function* () {
        const response = yield* request(yield* manifestPath(reference), 0, GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE, {
          method: 'HEAD',
          acceptedStatuses: [200, 404],
        });
        if (response.status === 404) return undefined;
        return yield* Effect.try({
          try: () => parseSha256Digest(response.headers['docker-content-digest'] ?? ''),
          catch: () => graphSharingFailure('Registry manifest acknowledgement is invalid.'),
        });
      }),
  };
});
