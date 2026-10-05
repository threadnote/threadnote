import {Clock, Effect, Redacted, Schema, Semaphore, Stream} from 'effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import {
  GraphSharingError,
  graphSharingFailure,
  graphSharingHttpFailure,
  graphSharingUnavailable,
  graphShareRetryAfterMilliseconds,
} from '../errors.js';
import {parseGraphShareRegistryChallenge, type GraphShareRegistryChallenge} from './auth.js';
import {makeGraphShareRegistryCredentialLoader} from './credentials.js';
import type {GraphShareRegistryTarget} from './reference.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES} from '../oci.js';

const TokenText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16_384),
  Schema.isPattern(/^[\x21-\x7e]+$/u),
);
const TokenResponse = Schema.Struct({
  access_token: Schema.optionalKey(TokenText),
  expires_in: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  token: Schema.optionalKey(TokenText),
});

export interface GraphShareRegistryRequestOptions {
  readonly method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE';
  readonly body?: Uint8Array;
  readonly contentType?: string;
  readonly acceptedStatuses?: readonly (200 | 201 | 202 | 204 | 404)[];
}

/** One reader owns one trusted origin, repository and selected credential provider. */
export const makeGraphShareRegistryHttp = Effect.fn('codeGraph.sharing.registryHttp')(function* <E = never, R = never>(
  target: GraphShareRegistryTarget,
  access: 'read' | 'write' = 'read',
  isAuthorized?: Effect.Effect<boolean, E, R>,
) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const fetch = yield* FetchHttpClient.Fetch;
  const guard = Effect.gen(function* () {
    if (
      isAuthorized !== undefined &&
      !(yield* isAuthorized.pipe(
        Effect.mapError(() => graphSharingUnavailable('Registry authorization check failed.')),
      ))
    )
      return yield* graphSharingFailure('Registry request is no longer authorized.');
  });
  yield* guard;
  const credentials = yield* makeGraphShareRegistryCredentialLoader(target);
  let initialCredential = access === 'write' ? yield* credentials() : undefined;
  yield* guard;
  if (access === 'write' && initialCredential === undefined)
    return yield* graphSharingFailure('Registry writes require a configured credential helper.');
  const request = (
    url: string,
    maximum: number,
    accept: string,
    authorization?: Redacted.Redacted<string>,
    options: GraphShareRegistryRequestOptions = {},
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        let request = HttpClientRequest.make(options.method ?? 'GET')(url).pipe(
          HttpClientRequest.setHeader('accept', accept),
        );
        if (options.body !== undefined)
          request = HttpClientRequest.bodyUint8Array(
            request,
            options.body,
            options.contentType ?? 'application/octet-stream',
          );
        if (authorization !== undefined)
          request = HttpClientRequest.setHeader(request, 'authorization', Redacted.value(authorization));
        yield* guard;
        const response = yield* client
          .execute(request)
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, {redirect: 'manual', credentials: 'omit'}),
            Effect.provideService(FetchHttpClient.Fetch, fetch),
          );
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (response.status === 200 && options.method !== 'HEAD') {
          const length = response.headers['content-length'];
          if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
            return yield* graphSharingFailure('Registry response exceeds its size limit.');
          }
          yield* Stream.runForEach(response.stream, chunk =>
            Effect.gen(function* () {
              size += chunk.byteLength;
              if (size > maximum) return yield* graphSharingFailure('Registry response exceeds its size limit.');
              chunks.push(chunk);
            }),
          );
        }
        yield* guard;
        return {bytes: Buffer.concat(chunks, size), headers: response.headers, status: response.status};
      }),
    ).pipe(
      Effect.timeout(60_000),
      Effect.mapError(error =>
        Schema.is(GraphSharingError)(error) ? error : graphSharingUnavailable('Registry request failed.'),
      ),
    );

  let challenge: GraphShareRegistryChallenge | undefined;
  let authorization: Redacted.Redacted<string> | undefined;
  let expiresAt = 0;
  const authentication = yield* Semaphore.make(1);
  const authorize = Effect.gen(function* () {
    yield* guard;
    if (challenge === undefined) return;
    const credential = initialCredential ?? (yield* credentials());
    yield* guard;
    initialCredential = undefined;
    if (
      credential?.allowedBearerRealm !== undefined &&
      (challenge.kind !== 'bearer' || challenge.realm !== credential.allowedBearerRealm)
    )
      return yield* graphSharingFailure('Registry authentication realm is not trusted for this credential.');
    if (challenge.kind === 'basic') {
      if (credential === undefined)
        return yield* graphSharingFailure('Registry requires a configured credential helper.');
      authorization = credential.authorization;
      expiresAt = (yield* Clock.currentTimeMillis) + 300_000;
      return;
    }
    const url = new URL(challenge.realm);
    url.searchParams.set('scope', access === 'write' ? `repository:${target.repository}:pull,push` : target.pullScope);
    if (challenge.service !== undefined) url.searchParams.set('service', challenge.service);
    const response = yield* request(url.href, 32_768, 'application/json', credential?.authorization);
    yield* guard;
    if (response.status !== 200)
      return yield* graphSharingHttpFailure(
        response.status,
        graphShareRetryAfterMilliseconds(response.headers['retry-after'], yield* Clock.currentTimeMillis),
      );
    const token = yield* Schema.decodeEffect(Schema.fromJsonString(TokenResponse))(
      new TextDecoder().decode(response.bytes),
    ).pipe(Effect.mapError(() => graphSharingFailure('Registry token response is invalid.')));
    const value = token.token ?? token.access_token;
    if (
      value === undefined ||
      (token.token !== undefined && token.access_token !== undefined && token.token !== token.access_token)
    ) {
      return yield* graphSharingFailure('Registry token response is invalid.');
    }
    authorization = Redacted.make(`Bearer ${value}`);
    expiresAt = (yield* Clock.currentTimeMillis) + Math.min(token.expires_in ?? 60, 300) * 1000;
  });

  return (pathname: string, maximum: number, accept: string, options: GraphShareRegistryRequestOptions = {}) =>
    Effect.gen(function* () {
      const method = options.method ?? 'GET';
      if (
        !isRegistryRequestPath(target, pathname, method, access) ||
        !Number.isSafeInteger(maximum) ||
        maximum < 0 ||
        maximum > GRAPH_SHARE_HTTP_CAS_MAX_BYTES ||
        (options.body !== undefined &&
          ((method !== 'POST' && method !== 'PUT') || options.body.byteLength > GRAPH_SHARE_HTTP_CAS_MAX_BYTES))
      ) {
        return yield* graphSharingFailure('Registry request is outside its trusted capability.');
      }
      const acceptedStatuses: readonly number[] = options.acceptedStatuses ?? [200];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        yield* guard;
        const usedAuthorization = yield* authentication.withPermit(
          Effect.gen(function* () {
            if (challenge !== undefined && expiresAt <= (yield* Clock.currentTimeMillis)) yield* authorize;
            return authorization;
          }),
        );
        yield* guard;
        const response = yield* request(target.origin + pathname, maximum, accept, usedAuthorization, options);
        if (acceptedStatuses.includes(response.status)) return response;
        if (response.status !== 401 || attempt === 2) {
          if (response.status === 404) return yield* graphSharingUnavailable('Registry artifact is missing.');
          return yield* graphSharingHttpFailure(
            response.status,
            graphShareRetryAfterMilliseconds(response.headers['retry-after'], yield* Clock.currentTimeMillis),
          );
        }
        const next = yield* Effect.try({
          try: () => parseGraphShareRegistryChallenge(response.headers['www-authenticate'], target, access),
          catch: () => graphSharingFailure('Registry authentication challenge is not trusted.'),
        });
        yield* authentication.withPermit(
          Effect.gen(function* () {
            if (challenge !== undefined && JSON.stringify(next) !== JSON.stringify(challenge))
              return yield* graphSharingFailure('Registry authentication authority changed.');
            challenge = next;
            if (
              authorization === usedAuthorization ||
              authorization === undefined ||
              expiresAt <= (yield* Clock.currentTimeMillis)
            )
              yield* authorize;
          }),
        );
      }
      return yield* graphSharingFailure('Registry authentication retry limit reached.');
    });
});

function isRegistryRequestPath(
  target: GraphShareRegistryTarget,
  value: string,
  method: NonNullable<GraphShareRegistryRequestOptions['method']>,
  access: 'read' | 'write',
): boolean {
  const prefix = `/v2/${target.repository}/`;
  if (!value.startsWith(prefix) || value.length > 8512) return false;
  let url: URL;
  try {
    url = new URL(target.origin + value);
  } catch {
    return false;
  }
  if (url.href !== target.origin + value || url.hash !== '') return false;
  const suffix = url.pathname.slice(prefix.length);
  if (method === 'GET' || method === 'HEAD')
    return url.search === '' && /^(?:manifests|blobs)\/[A-Za-z0-9_.:-]+$/u.test(suffix);
  if (access !== 'write') return false;
  if (method === 'POST') return suffix === 'blobs/uploads/' && url.search === '';
  if (method === 'PUT' && /^manifests\/[A-Za-z0-9_.:-]+$/u.test(suffix)) return url.search === '';
  return (method === 'PUT' || method === 'DELETE') && /^blobs\/uploads\/[A-Za-z0-9_-]{1,256}$/u.test(suffix);
}
