import {Clock, Effect, Redacted, Schema, Stream} from 'effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import {makeGraphControlCredentialLoader, type GraphControlClientScope} from './credentials.js';
import {GRAPH_SHARE_CONTROL_MAX_BODY_BYTES} from './protocol.js';
import {SHA256_DIGEST} from '../digest.js';
import {
  GraphSharingError,
  graphSharingFailure,
  graphSharingHttpFailure,
  graphSharingUnavailable,
  graphShareRetryAfterMilliseconds,
} from '../errors.js';

export const makeAuthenticatedGraphControlClient = Effect.fn('codeGraph.sharing.authenticatedControlClient')(function* (
  home: string,
  scope: GraphControlClientScope,
  capability: 'graph:read' | 'graph:contribute',
) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const fetch = yield* FetchHttpClient.Fetch;
  const credentials = yield* makeGraphControlCredentialLoader(home, scope, capability);
  const request = <E = never, R = never>(
    method: 'GET' | 'POST',
    pathname: string,
    body?: unknown,
    isAuthorized?: Effect.Effect<boolean, E, R>,
  ) => {
    const run = Effect.gen(function* () {
      const allowed =
        method === 'POST'
          ? capability === 'graph:contribute' &&
            (pathname === '/v1/enroll' || pathname === '/v1/results') &&
            body !== undefined
          : body === undefined && (pathname === '/v1/status' || /^\/v1\/frontiers\/[0-9a-f]{40}$/u.test(pathname));
      if (!allowed) return yield* graphSharingFailure('Graph control request is outside its trusted capability.');
      const encoded =
        body === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(Schema.Json)(body).pipe(
              Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.Json))),
              Effect.map(value => new TextEncoder().encode(value)),
              Effect.mapError(() => graphSharingFailure('Graph control request is invalid.')),
            );
      if (encoded !== undefined && encoded.byteLength > GRAPH_SHARE_CONTROL_MAX_BODY_BYTES)
        return yield* graphSharingFailure('Graph control request exceeds the 64 KiB metadata limit.');
      for (let attempt = 0; attempt < 2; attempt++) {
        if (isAuthorized !== undefined && !(yield* isAuthorized))
          return yield* graphSharingFailure('Graph control request is no longer authorized.');
        const credential = yield* credentials.load;
        if (isAuthorized !== undefined && !(yield* isAuthorized))
          return yield* graphSharingFailure('Graph control request is no longer authorized.');
        const response = yield* Effect.scoped(
          Effect.gen(function* () {
            let outbound = HttpClientRequest.make(method)(scope.coordinatorUrl.replace(/\/$/u, '') + pathname).pipe(
              HttpClientRequest.setHeader('accept', 'application/json'),
              HttpClientRequest.setHeader('authorization', Redacted.value(credential.authorization)),
              HttpClientRequest.setHeader('x-threadnote-repository-id', scope.repositoryId),
              HttpClientRequest.setHeader('x-threadnote-profile-digest', scope.profileDigest),
            );
            if (encoded !== undefined)
              outbound = HttpClientRequest.bodyUint8Array(outbound, encoded, 'application/json');
            const inbound = yield* client
              .execute(outbound)
              .pipe(
                Effect.provideService(FetchHttpClient.RequestInit, {redirect: 'manual', credentials: 'omit'}),
                Effect.provideService(FetchHttpClient.Fetch, fetch),
              );
            if (
              inbound.status !== 200 &&
              inbound.status !== 201 &&
              !(pathname === '/v1/results' && inbound.status === 409)
            )
              return {status: inbound.status, headers: inbound.headers, body: undefined};
            const length = inbound.headers['content-length'];
            if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > GRAPH_SHARE_CONTROL_MAX_BODY_BYTES))
              return yield* graphSharingFailure('Graph control response exceeds its metadata limit.');
            const bytes = new Uint8Array(GRAPH_SHARE_CONTROL_MAX_BODY_BYTES);
            let size = 0;
            yield* Stream.runForEach(inbound.stream, chunk =>
              Effect.gen(function* () {
                if (size + chunk.byteLength > bytes.byteLength)
                  return yield* graphSharingFailure('Graph control response exceeds its metadata limit.');
                bytes.set(chunk, size);
                size += chunk.byteLength;
              }),
            );
            const text = yield* Effect.try({
              try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, size)),
              catch: () => graphSharingFailure('Graph control response is invalid.'),
            });
            const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(text).pipe(
              Effect.mapError(() => graphSharingFailure('Graph control response is invalid.')),
            );
            if (inbound.status === 409) {
              if (
                Object.keys(parsed).sort().join(',') !== 'error,idempotencyKey' ||
                parsed.error !== 'stale-source' ||
                typeof parsed.idempotencyKey !== 'string' ||
                !SHA256_DIGEST.test(parsed.idempotencyKey)
              )
                return {status: inbound.status, headers: inbound.headers, body: undefined};
            }
            return {status: inbound.status, headers: inbound.headers, body: parsed};
          }),
        ).pipe(
          // The admission server may spend five minutes validating a bounded OCI closure.
          Effect.timeout(pathname === '/v1/results' ? 310_000 : 10_000),
          Effect.mapError(error =>
            Schema.is(GraphSharingError)(error) ? error : graphSharingUnavailable('Graph control request failed.'),
          ),
        );
        if (response.body !== undefined) return {status: response.status, body: response.body, credential};
        if (response.status === 401 && attempt === 0) {
          credentials.invalidate(credential);
          continue;
        }
        return yield* graphSharingHttpFailure(
          response.status,
          graphShareRetryAfterMilliseconds(response.headers['retry-after'], yield* Clock.currentTimeMillis),
        );
      }
      return yield* graphSharingFailure('Graph control authentication retry limit reached.');
    });
    // A 401 replay must share the same result deadline, including credential refresh.
    return pathname === '/v1/results'
      ? run.pipe(
          Effect.timeout(310_000),
          Effect.mapError(error =>
            Schema.is(GraphSharingError)(error) ? error : graphSharingUnavailable('Graph control request failed.'),
          ),
        )
      : run;
  };
  return {request, credentials};
});
