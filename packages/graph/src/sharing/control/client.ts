import {Clock, Effect, Schema} from 'effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import {HttpRequestFailed, HttpStatusError} from '@threadnote/platform/http';
import {GRAPH_SHARE_ACTION_KEY} from '../action.js';
import {putCasBytes} from '../cas.js';
import {GRAPH_SHARE_CONTROL_MAX_BODY_BYTES, type GraphShareControlResponse} from './protocol.js';
import {
  parseSha256Digest,
  SHA256_DIGEST,
  SHA256_HEX,
  sha256Digest,
  sha256HexFromDigest,
  type Sha256Digest,
} from '../digest.js';
import {
  graphSharingFailure,
  graphSharingUnavailable,
  GraphSharingError,
  graphSharingHttpFailure,
  graphShareRetryAfterMilliseconds,
} from '../errors.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES, graphSharePayloadLooksLikeGitObject} from '../oci.js';
import {parseGraphShareCoordinatorUrl} from '../profile.js';
import type {GraphShareResultAnnouncementV1} from '../receipts.js';

const dynamicFetch = Object.assign((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args), {
  preconnect: (...args: Parameters<typeof globalThis.fetch.preconnect>) => globalThis.fetch.preconnect(...args),
}) satisfies typeof globalThis.fetch;

const JSON_DECODE = {errors: 'all'} as const;
const JSON_STATUS_DECODE = {errors: 'all', onExcessProperty: 'ignore'} as const;
const DigestOrHex = Schema.Union([
  Schema.String.check(Schema.isPattern(SHA256_DIGEST)),
  Schema.String.check(Schema.isPattern(SHA256_HEX)),
]);
const DigestString = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const ResultReceipt = Schema.Struct({
  actionKey: Schema.String.check(Schema.isPattern(GRAPH_SHARE_ACTION_KEY)),
  attestationDigest: DigestString,
  batchId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  resultManifestDigest: DigestString,
  semanticDigest: DigestString,
});
const CoordinatorStatus = Schema.Struct({
  generation: Schema.Finite,
  observedHead: Schema.optionalKey(Schema.NullOr(Schema.String)),
  organization: Schema.String,
  phase: Schema.String,
  publishedFrontier: Schema.NullOr(Schema.String),
  receipts: Schema.Array(ResultReceipt),
  repositoryId: Schema.String,
});
const CoordinatorFrontier = Schema.Struct({
  envelopeDigest: DigestOrHex,
  frontierDigest: Schema.optionalKey(DigestOrHex),
  manifestDigest: Schema.optionalKey(DigestOrHex),
});
const CoordinatorTagBody = Schema.Struct({
  digest: DigestString,
});

export interface GraphShareCoordinatorFrontierResponse {
  readonly envelopeDigest: Sha256Digest;
  readonly manifestDigest: Sha256Digest;
}

export interface GraphShareCoordinatorStatusResponse {
  readonly generation: number;
  readonly observedHead?: string | null;
  readonly organization: string;
  readonly phase: string;
  readonly publishedFrontier: string | null;
  readonly receipts: readonly GraphShareResultAnnouncementV1[];
  readonly repositoryId: string;
}

export const graphShareControlGetJson = Effect.fn('codeGraph.sharing.controlGetJson')(function* (
  coordinatorUrl: string,
  pathname: string,
) {
  const url = coordinatorPath(coordinatorUrl, pathname);
  const response = yield* execute(HttpClientRequest.get(url), url, 10_000);
  if (response.status === 404) return yield* graphSharingUnavailable(`Coordinator path is missing: ${pathname}`);
  if (response.status < 200 || response.status >= 300) {
    return yield* graphSharingFailure(`Coordinator GET ${pathname} returned HTTP ${response.status}.`);
  }
  return yield* decodeResponseJson(Schema.JsonObject, response);
});

export const graphShareControlPostJson = Effect.fn('codeGraph.sharing.controlPostJson')(function* (
  coordinatorUrl: string,
  pathname: string,
  body: unknown,
) {
  const url = coordinatorPath(coordinatorUrl, pathname);
  const json = yield* Schema.decodeUnknownEffect(
    Schema.Json,
    JSON_DECODE,
  )(body).pipe(Effect.mapError(cause => graphSharingFailure('Coordinator request is not JSON.', cause)));
  const request = yield* HttpClientRequest.post(url).pipe(HttpClientRequest.schemaBodyJson(Schema.Json)(json));
  if (request.body._tag !== 'Uint8Array') {
    return yield* graphSharingFailure('Coordinator request could not be encoded.');
  }
  if (request.body.body.byteLength > GRAPH_SHARE_CONTROL_MAX_BODY_BYTES) {
    return yield* graphSharingFailure('Coordinator request exceeds the 64 KiB control limit.');
  }
  const response = yield* execute(request, url, 10_000);
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    return yield* graphSharingHttpFailure(
      response.status,
      graphShareRetryAfterMilliseconds(response.headers['retry-after'], yield* Clock.currentTimeMillis),
    );
  }
  return {
    body: yield* decodeResponseJson(Schema.Json, response).pipe(Effect.orElseSucceed(() => undefined)),
    status: response.status,
  } satisfies GraphShareControlResponse;
});

export const graphShareControlGetCas = Effect.fn('codeGraph.sharing.controlGetCas')(function* (
  coordinatorUrl: string,
  digest: string,
) {
  const expected = parseSha256Digest(digest);
  const url = coordinatorPath(coordinatorUrl, `/v1/cas/sha256/${sha256HexFromDigest(expected)}`);
  const response = yield* execute(HttpClientRequest.get(url), url, 60_000);
  if (response.status === 404) return yield* graphSharingUnavailable(`CAS object is missing: ${expected}`);
  if (response.status === 413) {
    return yield* graphSharingUnavailable(`CAS object exceeds the HTTP transfer limit: ${expected}`);
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* graphSharingFailure(`CAS GET returned HTTP ${response.status}.`);
  }
  const bytes = yield* readResponseBytes(response, url);
  if (graphSharePayloadLooksLikeGitObject(bytes)) {
    return yield* graphSharingFailure('Graph CAS must not serve Git objects.');
  }
  if (sha256Digest(bytes) !== expected) {
    return yield* graphSharingFailure(`CAS object digest mismatch: ${expected}`);
  }
  return bytes;
});

export const graphShareControlPutCas = Effect.fn('codeGraph.sharing.controlPutCas')(function* (
  coordinatorUrl: string,
  bytes: Uint8Array,
) {
  if (bytes.byteLength > GRAPH_SHARE_HTTP_CAS_MAX_BYTES) {
    return yield* graphSharingFailure('CAS payload exceeds the HTTP transfer limit.');
  }
  if (graphSharePayloadLooksLikeGitObject(bytes)) {
    return yield* graphSharingFailure('Graph CAS must not store Git objects.');
  }
  const digest = sha256Digest(bytes);
  const url = coordinatorPath(coordinatorUrl, `/v1/cas/sha256/${sha256HexFromDigest(digest)}`);
  const request = HttpClientRequest.put(url).pipe(HttpClientRequest.bodyUint8Array(bytes, 'application/octet-stream'));
  const response = yield* execute(request, url, 60_000);
  if (response.status < 200 || response.status >= 300) {
    return yield* graphSharingHttpFailure(
      response.status,
      graphShareRetryAfterMilliseconds(response.headers['retry-after'], yield* Clock.currentTimeMillis),
    );
  }
  return digest;
});

export const graphShareControlGetTag = Effect.fn('codeGraph.sharing.controlGetTag')(function* (
  coordinatorUrl: string,
  name: string,
) {
  const url = coordinatorPath(coordinatorUrl, `/v1/tags/${name}`);
  const response = yield* execute(HttpClientRequest.get(url), url, 10_000);
  if (response.status === 404) return yield* graphSharingUnavailable(`Coordinator path is missing: /v1/tags/${name}`);
  if (response.status < 200 || response.status >= 300) {
    return yield* graphSharingFailure(`Tag GET returned HTTP ${response.status}.`);
  }
  const body = yield* decodeResponseJson(CoordinatorTagBody, response, JSON_STATUS_DECODE);
  return parseSha256Digest(body.digest);
});

export const graphShareControlPutTag = Effect.fn('codeGraph.sharing.controlPutTag')(function* (
  coordinatorUrl: string,
  name: string,
  digest: Sha256Digest,
) {
  const url = coordinatorPath(coordinatorUrl, `/v1/tags/${name}`);
  const request = yield* HttpClientRequest.put(url).pipe(
    HttpClientRequest.schemaBodyJson(CoordinatorTagBody)({digest}),
  );
  const response = yield* execute(request, url, 10_000);
  if (response.status !== 200 && response.status !== 201) {
    return yield* graphSharingHttpFailure(
      response.status,
      graphShareRetryAfterMilliseconds(response.headers['retry-after'], yield* Clock.currentTimeMillis),
    );
  }
  return digest;
});

export const graphShareControlGetFrontier = Effect.fn('codeGraph.sharing.controlGetFrontier')(function* (
  coordinatorUrl: string,
  branchHash: string,
) {
  const url = coordinatorPath(coordinatorUrl, `/v1/frontiers/${branchHash}`);
  const response = yield* execute(HttpClientRequest.get(url), url, 10_000);
  if (response.status === 404)
    return yield* graphSharingUnavailable(`Coordinator path is missing: /v1/frontiers/${branchHash}`);
  if (response.status < 200 || response.status >= 300) {
    return yield* graphSharingFailure(`Coordinator GET /v1/frontiers/${branchHash} returned HTTP ${response.status}.`);
  }
  const body = yield* decodeResponseJson(CoordinatorFrontier, response);
  const manifest = body.manifestDigest ?? body.frontierDigest;
  if (manifest === undefined) return yield* graphSharingFailure('Coordinator frontier response is invalid.');
  return {
    envelopeDigest: parseSha256Digest(body.envelopeDigest),
    manifestDigest: parseSha256Digest(manifest),
  } satisfies GraphShareCoordinatorFrontierResponse;
});

export const graphShareControlGetStatus = Effect.fn('codeGraph.sharing.controlGetStatus')(function* (
  coordinatorUrl: string,
) {
  const url = coordinatorPath(coordinatorUrl, '/v1/status');
  const response = yield* execute(HttpClientRequest.get(url), url, 10_000);
  if (response.status < 200 || response.status >= 300) {
    return yield* graphSharingFailure(`Coordinator GET /v1/status returned HTTP ${response.status}.`);
  }
  return yield* decodeResponseJson(CoordinatorStatus, response, JSON_STATUS_DECODE);
});

export const graphShareControlAnnounceResult = Effect.fn('codeGraph.sharing.controlAnnounceResult')(function* (
  coordinatorUrl: string,
  announcement: GraphShareResultAnnouncementV1,
  idempotencyKey: string,
) {
  return yield* graphShareControlPostJson(coordinatorUrl, '/v1/results', {
    ...announcement,
    idempotencyKey,
  });
});

export const mirrorCoordinatorCasBlob = Effect.fn('codeGraph.sharing.mirrorCoordinatorCasBlob')(function* (
  casRoot: string,
  coordinatorUrl: string,
  digest: string,
) {
  const bytes = yield* graphShareControlGetCas(coordinatorUrl, digest);
  const stored = yield* putCasBytes(casRoot, bytes);
  if (stored !== parseSha256Digest(digest)) {
    return yield* graphSharingFailure('Mirrored CAS digest does not match the coordinator object.');
  }
  return stored;
});

function coordinatorPath(coordinatorUrl: string, pathname: string): string {
  return `${parseGraphShareCoordinatorUrl(coordinatorUrl)}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function execute(request: HttpClientRequest.HttpClientRequest, urlText: string, timeoutMs: number) {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, dynamicFetch),
      Effect.mapError(cause =>
        HttpRequestFailed.make({
          cause,
          message: `Graph share request failed: ${urlText}`,
          method: request.method,
          url: urlText,
        }),
      ),
    );
  }).pipe(
    Effect.timeout(timeoutMs),
    Effect.mapError(cause => {
      if (Schema.is(HttpRequestFailed)(cause) || Schema.is(HttpStatusError)(cause)) return cause;
      return graphSharingUnavailable(`Coordinator is unreachable: ${urlText}`);
    }),
    Effect.catchIf(
      error => Schema.is(HttpRequestFailed)(error),
      error => graphSharingUnavailable(error.message),
    ),
  );
}

function readResponseBytes(response: HttpClientResponse.HttpClientResponse, urlText: string) {
  return response.arrayBuffer.pipe(
    Effect.mapError(cause =>
      HttpRequestFailed.make({
        cause,
        message: `Graph share response could not be read: ${urlText}`,
        method: response.request.method,
        url: urlText,
      }),
    ),
    Effect.flatMap(buffer => {
      const bytes = new Uint8Array(buffer);
      return bytes.byteLength > GRAPH_SHARE_HTTP_CAS_MAX_BYTES
        ? graphSharingFailure('Coordinator response exceeds the transfer limit.')
        : Effect.succeed(bytes);
    }),
    Effect.catchIf(
      error => Schema.is(HttpRequestFailed)(error),
      error => graphSharingUnavailable(error.message),
    ),
  );
}

function decodeResponseJson<S extends Schema.Constraint>(
  schema: S,
  response: HttpClientResponse.HttpClientResponse,
  options: typeof JSON_DECODE | typeof JSON_STATUS_DECODE = JSON_DECODE,
) {
  return HttpClientResponse.schemaBodyJson(
    schema,
    options,
  )(response).pipe(
    Effect.mapError(cause =>
      Schema.is(GraphSharingError)(cause) ? cause : graphSharingFailure('Coordinator JSON is invalid.', cause),
    ),
  );
}
