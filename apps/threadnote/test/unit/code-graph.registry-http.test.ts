import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {makeGraphShareRegistryHttp} from '@threadnote/graph/sharing/registry/http';
import {parseGraphShareRegistryTarget} from '@threadnote/graph/sharing/registry/reference';
import {makeGraphShareRegistryReader} from '@threadnote/graph/sharing/registry/reader';
import {makeGraphShareRegistryWriter} from '@threadnote/graph/sharing/registry/writer';
import {graphShareOciDescriptorFromLayers} from '@threadnote/graph/sharing/descriptor';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';

const layer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, FetchHttpClient.layer);
const target = parseGraphShareRegistryTarget('oci://registry.example.test/acme/canonical');
const pathname = '/v2/acme/canonical/blobs/sha256:' + 'a'.repeat(64);
const secret = 'synthetic-helper-output';
const basic = 'Basic ' + Buffer.from('synthetic-reader:' + secret).toString('base64');
type Request = {
  readonly url: URL;
  readonly headers: Headers;
  readonly method: string;
  readonly body: RequestInit['body'];
  readonly signal: AbortSignal | null | undefined;
};

const fixture = Effect.fn('test.registry.fixture')(function* (options: {
  readonly access?: 'read' | 'write';
  readonly writer?: boolean;
  readonly helper?: boolean;
  readonly helperName?: string;
  readonly helperDenied?: boolean;
  readonly helperResponse?: (call: number) => unknown;
  readonly helperStarted?: Deferred.Deferred<void>;
  readonly helperGate?: Deferred.Deferred<void>;
  readonly isAuthorized?: Effect.Effect<boolean, unknown>;
  readonly handler: (request: Request) => Response | Promise<Response>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-registry-auth-'});
  yield* fs.writeFileString(
    path.join(directory, 'config.json'),
    JSON.stringify(
      options.helper
        ? {
            credHelpers: {[target.registry]: options.helperName ?? 'fixture'},
            credsStore: 'unused',
            auths: {[target.registry]: {auth: 'must-not-use'}},
          }
        : {auths: {[target.registry]: {auth: 'must-not-use'}}},
    ),
  );
  const requests: Request[] = [];
  let helperCalls = 0;
  const fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const request = {
        url: new URL(String(url)),
        headers: new Headers(init?.headers),
        method: init?.method ?? 'GET',
        body: init?.body,
        signal: init?.signal,
      };
      expect(init?.redirect).toBe('manual');
      expect(init?.credentials).toBe('omit');
      requests.push(request);
      return options.handler(request);
    },
    {preconnect: () => undefined},
  ) as typeof globalThis.fetch;
  const reader = yield* Effect.gen(function* () {
    return {
      http: yield* makeGraphShareRegistryHttp(target, options.access, options.isAuthorized),
      registry: yield* makeGraphShareRegistryReader('oci://registry.example.test/acme/canonical', options.isAuthorized),
      writer: options.writer
        ? yield* makeGraphShareRegistryWriter('oci://registry.example.test/acme/canonical', options.isAuthorized)
        : undefined,
    };
  }).pipe(
    Effect.provideService(SystemInfo, {...system, environment: () => ({DOCKER_CONFIG: directory})}),
    Effect.provideService(CommandExecutor, {
      execute: (executable, args, input) =>
        Effect.gen(function* () {
          helperCalls++;
          expect(executable).toBe(`docker-credential-${options.helperName ?? 'fixture'}`);
          expect(args).toEqual(['get']);
          expect(new TextDecoder().decode(input?.input)).toBe(target.registry + '\n');
          expect(input?.maxOutputBytes).toBe(16384);
          expect(input?.timeoutMs).toBe(
            options.helperName === 'threadnote-auth0-user'
              ? 25000
              : options.helperName === 'threadnote-oauth-m2m' ||
                  options.helperName === 'threadnote-oauth-publisher-m2m' ||
                  options.helperName === 'threadnote-auth0-m2m' ||
                  options.helperName === 'threadnote-auth0-publisher-m2m'
                ? 10000
                : 5000,
          );
          if (options.helperStarted) yield* Deferred.succeed(options.helperStarted, undefined);
          if (options.helperGate) yield* Deferred.await(options.helperGate);
          return {
            exitCode: options.helperDenied ? 1 : 0,
            stderr: secret,
            stdout: JSON.stringify(
              options.helperResponse?.(helperCalls) ?? {
                Username:
                  options.helperName === 'threadnote-oauth-m2m' ||
                  options.helperName === 'threadnote-oauth-publisher-m2m' ||
                  options.helperName === 'threadnote-auth0-m2m' ||
                  options.helperName === 'threadnote-auth0-publisher-m2m' ||
                  options.helperName === 'threadnote-auth0-user'
                    ? 'zot'
                    : 'synthetic-reader',
                Secret: secret,
              },
            ),
          };
        }),
      executeStreaming: () => Effect.succeed({exitCode: 1, stdout: '', stderr: ''}),
    }),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
  return {
    read: (maximum = 1024) => reader.http(pathname, maximum, 'application/octet-stream'),
    request: reader.http,
    registry: reader.registry,
    writer: reader.writer,
    requests,
    helperCalls: () => helperCalls,
  };
});

describe('registry authentication and bounded transport', () => {
  effectIt.effect('refuses a write when authorization is revoked during the eager credential helper', () =>
    Effect.gen(function* () {
      const authorized = yield* Ref.make(true);
      const helperStarted = yield* Deferred.make<void>();
      const helperGate = yield* Deferred.make<void>();
      let dispatches = 0;
      const construction = yield* Effect.forkChild(
        Effect.result(
          fixture({
            access: 'write',
            helper: true,
            helperStarted,
            helperGate,
            isAuthorized: Ref.get(authorized),
            handler: () => {
              dispatches++;
              return new Response(null, {status: 201});
            },
          }),
        ),
      );
      yield* Deferred.await(helperStarted);
      yield* Ref.set(authorized, false);
      yield* Deferred.succeed(helperGate, undefined);
      expect(yield* Fiber.join(construction)).toMatchObject({failure: {kind: 'verification-failed'}});
      expect(dispatches).toBe(0);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('redacts authorization-check failures before credentials or network are used', () =>
    Effect.gen(function* () {
      let dispatches = 0;
      const result = yield* Effect.result(
        fixture({
          access: 'write',
          helper: true,
          isAuthorized: Effect.fail({_tag: 'FixtureAuthorizationError', detail: secret}),
          handler: () => {
            dispatches++;
            return new Response(null, {status: 201});
          },
        }),
      );
      expect(result).toMatchObject({failure: {kind: 'unavailable'}});
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(dispatches).toBe(0);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('refuses the retried write when the principal changes during bearer token exchange', () =>
    Effect.gen(function* () {
      const principal = yield* Ref.make('principal-a');
      const tokenStarted = Promise.withResolvers<void>();
      const tokenResponse = Promise.withResolvers<Response>();
      const f = yield* fixture({
        access: 'write',
        helper: true,
        isAuthorized: Ref.get(principal).pipe(Effect.map(current => current === 'principal-a')),
        handler: request => {
          if (request.url.pathname === '/token') {
            tokenStarted.resolve();
            return tokenResponse.promise;
          }
          return new Response(null, {
            status: 401,
            headers: {'www-authenticate': `Bearer realm="${target.origin}/token",scope="${target.pullScope}"`},
          });
        },
      });
      const write = yield* Effect.forkChild(
        Effect.result(
          f.request('/v2/acme/canonical/blobs/uploads/', 0, 'application/json', {
            method: 'POST',
            acceptedStatuses: [202],
          }),
        ),
      );
      yield* Effect.promise(() => tokenStarted.promise);
      yield* Ref.set(principal, 'principal-b');
      tokenResponse.resolve(Response.json({token: 'synthetic-token'}));
      expect(yield* Fiber.join(write)).toMatchObject({failure: {kind: 'verification-failed'}});
      expect(f.requests.map(request => request.url.pathname)).toEqual(['/v2/acme/canonical/blobs/uploads/', '/token']);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('sends the scoped OAuth registry secret only to the exact Zot bearer-token realm', () =>
    Effect.gen(function* () {
      const zotBasic = 'Basic ' + Buffer.from('zot:' + secret).toString('base64');
      for (const helperName of [
        'threadnote-oauth-m2m',
        'threadnote-oauth-publisher-m2m',
        'threadnote-auth0-m2m',
        'threadnote-auth0-publisher-m2m',
        'threadnote-auth0-user',
      ] as const) {
        const f = yield* fixture({
          helper: true,
          helperName,
          handler: request => {
            if (request.url.pathname === '/zot/auth/token') {
              expect(request.headers.get('authorization')).toBe(zotBasic);
              return Response.json({token: 'zot-scoped-token', expires_in: 60});
            }
            return request.headers.get('authorization') === 'Bearer zot-scoped-token'
              ? new Response(new Uint8Array([1, 2, 3]), {status: 200})
              : new Response(null, {
                  status: 401,
                  headers: {
                    'www-authenticate': `Bearer realm="${target.origin}/zot/auth/token",scope="${target.pullScope}"`,
                  },
                });
          },
        });
        expect((yield* f.read()).bytes).toEqual(Buffer.from([1, 2, 3]));
        expect(f.requests.map(request => request.url.pathname)).toEqual([pathname, '/zot/auth/token', pathname]);
      }
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('never sends OAuth registry credentials to Basic or a different same-origin realm', () =>
    Effect.gen(function* () {
      for (const helperName of [
        'threadnote-oauth-m2m',
        'threadnote-oauth-publisher-m2m',
        'threadnote-auth0-m2m',
        'threadnote-auth0-publisher-m2m',
        'threadnote-auth0-user',
      ] as const) {
        for (const challenge of [
          'Basic realm="registry"',
          `Bearer realm="${target.origin}/other/token",scope="${target.pullScope}"`,
        ]) {
          const f = yield* fixture({
            helper: true,
            helperName,
            handler: () => new Response(null, {status: 401, headers: {'www-authenticate': challenge}}),
          });
          expect((yield* Effect.result(f.read()))._tag).toBe('Failure');
          expect(f.requests.map(request => request.url.pathname)).toEqual([pathname]);
        }
      }
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('shares one credential exchange per concurrent challenge or token renewal', () =>
    Effect.gen(function* () {
      let issued = 0;
      const f = yield* fixture({
        access: 'write',
        helper: true,
        handler: request => {
          if (request.url.pathname === '/token') {
            issued++;
            return Response.json({token: 'parallel-' + issued, expires_in: 1});
          }
          return request.headers.get('authorization') === 'Bearer parallel-' + issued && issued > 0
            ? new Response(null, {status: 202})
            : new Response(null, {
                status: 401,
                headers: {'www-authenticate': `Bearer realm="${target.origin}/token",scope="${target.pullScope}"`},
              });
        },
      });
      const wave = Effect.forEach(
        Array.from({length: 8}),
        () =>
          f.request('/v2/acme/canonical/blobs/uploads/', 0, 'application/json', {
            method: 'POST',
            acceptedStatuses: [202],
          }),
        {concurrency: 8},
      );
      yield* wave;
      expect(issued).toBe(1);
      expect(f.helperCalls()).toBe(1);
      yield* TestClock.adjust(1001);
      yield* wave;
      expect(issued).toBe(2);
      expect(f.helperCalls()).toBe(2);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('requires exact manifest acknowledgements and confines failed upload locations', () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode('{}');
      const digest = sha256Digest(bytes);
      const f = yield* fixture({
        writer: true,
        helper: true,
        handler: request => {
          expect(request.method).toBe('PUT');
          expect(request.headers.get('content-type')).toBe('application/vnd.oci.image.manifest.v1+json');
          return new Response(null, {status: 201, headers: {'docker-content-digest': digest}});
        },
      });
      expect(yield* f.writer!.putManifest(digest, bytes)).toBe(digest);
      expect((yield* Effect.result(f.writer!.putManifest('sha256:' + 'a'.repeat(64), bytes)))._tag).toBe('Failure');
      expect((yield* Effect.result(f.writer!.putManifest('../foreign', bytes)))._tag).toBe('Failure');
      expect(f.requests).toHaveLength(1);
      const mismatch = yield* fixture({
        writer: true,
        helper: true,
        handler: () => new Response(null, {status: 201, headers: {'docker-content-digest': sha256Digest('other')}}),
      });
      expect((yield* Effect.result(mismatch.writer!.putManifest('tn-frontier-test', bytes)))._tag).toBe('Failure');
      for (const location of [
        'https://foreign.example.test/upload',
        '/v2/acme/worker/blobs/uploads/session',
        '/v2/acme/canonical/blobs/uploads/session?digest=existing',
      ]) {
        const invalid = yield* fixture({
          writer: true,
          helper: true,
          handler: request =>
            request.method === 'HEAD'
              ? new Response(null, {status: 404})
              : new Response(null, {status: 202, headers: {location}}),
        });
        expect((yield* Effect.result(invalid.writer!.putBlob(digest, bytes)))._tag).toBe('Failure');
        expect(invalid.requests.map(request => request.method)).toEqual(['HEAD', 'POST']);
      }
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('aborts a stalled upload and cancels only its owned session when its deadline expires', () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode('{}');
      const f = yield* fixture({
        writer: true,
        helper: true,
        handler: request => {
          if (request.method === 'HEAD') return new Response(null, {status: 404});
          if (request.method === 'POST')
            return new Response(null, {status: 202, headers: {location: '/v2/acme/canonical/blobs/uploads/owned'}});
          if (request.method === 'DELETE') return new Response(null, {status: 204});
          return new Promise<Response>(() => {});
        },
      });
      const fiber = yield* Effect.forkChild(Effect.result(f.writer!.putBlob(sha256Digest(bytes), bytes)));
      yield* TestClock.adjust(60_001);
      expect((yield* Fiber.join(fiber))._tag).toBe('Failure');
      expect(f.requests.map(request => request.method)).toEqual(['HEAD', 'POST', 'PUT', 'DELETE']);
      expect(f.requests.find(request => request.method === 'PUT')?.signal?.aborted).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('uploads exact blob bytes through the returned session and deduplicates retries', () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode('{"synthetic":"graph-blob"}');
      const digest = sha256Digest(bytes);
      const upload = '/v2/acme/canonical/blobs/uploads/session-1?_state=a%2fb%3D+x';
      let present = false;
      const f = yield* fixture({
        writer: true,
        helper: true,
        handler: request => {
          if (request.headers.get('authorization') !== basic)
            return new Response(null, {status: 401, headers: {'www-authenticate': 'Basic realm="synthetic"'}});
          if (request.method === 'HEAD')
            return new Response(
              null,
              present
                ? {status: 200, headers: {'docker-content-digest': digest, 'content-length': String(bytes.length)}}
                : {status: 404},
            );
          if (request.method === 'POST') return new Response(null, {status: 202, headers: {location: upload}});
          expect(request.method).toBe('PUT');
          expect(request.url.href).toBe(target.origin + upload + '&digest=' + digest);
          expect(request.body).toEqual(bytes);
          present = true;
          return new Response(null, {status: 201, headers: {'docker-content-digest': digest}});
        },
      });
      expect(yield* f.writer!.putBlob(digest, bytes)).toMatchObject({digest, existed: false});
      expect(yield* f.writer!.putBlob(digest, bytes)).toMatchObject({digest, existed: true});
      expect(f.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
      expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(f.helperCalls()).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('denies invalid upload bytes before networking and cleans up only its failed owned session', () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode('{}');
      const digest = sha256Digest(bytes);
      const upload = '/v2/acme/canonical/blobs/uploads/owned?_state=opaque';
      const f = yield* fixture({
        writer: true,
        helper: true,
        handler: request => {
          if (request.method === 'HEAD') return new Response(null, {status: 404});
          if (request.method === 'POST') return new Response(null, {status: 202, headers: {location: upload}});
          if (request.method === 'DELETE') {
            expect(request.url.href).toBe(target.origin + upload);
            return new Response(null, {status: 204});
          }
          return new Response(null, {status: 503, headers: {'retry-after': '11'}});
        },
      });
      expect(yield* Effect.result(f.writer!.putBlob('sha256:' + 'a'.repeat(64), bytes))).toMatchObject({
        failure: {kind: 'verification-failed'},
      });
      expect(f.requests).toHaveLength(0);
      expect(yield* Effect.result(f.writer!.putBlob(digest, bytes))).toMatchObject({
        failure: {httpStatus: 503, retryAfterMilliseconds: 11_000},
      });
      expect(f.requests.map(request => request.method)).toEqual(['HEAD', 'POST', 'PUT', 'DELETE']);
    }).pipe(provideTestLayer(layer)),
  );
  effectIt.effect('requires an explicitly selected credential before constructing a writer', () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const result = yield* Effect.result(
        fixture({
          access: 'write',
          handler: request => {
            requests.push(request);
            return new Response(null);
          },
        }),
      );
      expect(result).toMatchObject({failure: {kind: 'verification-failed'}});
      expect(requests).toHaveLength(0);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('keeps a writer token request at its fixed pull/push capability after a narrower challenge', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        access: 'write',
        helper: true,
        handler: request => {
          if (request.url.pathname === '/token') {
            expect(request.url.searchParams.get('scope')).toBe('repository:acme/canonical:pull,push');
            expect(request.headers.get('authorization')).toBe(basic);
            return Response.json({token: 'synthetic-writer', expires_in: 60});
          }
          expect(request.method).toBe('POST');
          return request.headers.get('authorization') === 'Bearer synthetic-writer'
            ? new Response(null, {status: 202, headers: {location: '/v2/acme/canonical/blobs/uploads/synthetic'}})
            : new Response(null, {
                status: 401,
                headers: {'www-authenticate': `Bearer realm="${target.origin}/token",scope="${target.pullScope}"`},
              });
        },
      });
      const result = yield* f.request('/v2/acme/canonical/blobs/uploads/', 0, 'application/json', {
        method: 'POST',
        acceptedStatuses: [202],
      });
      expect(result.status).toBe(202);
      expect(f.helperCalls()).toBe(1);
      expect(f.requests).toHaveLength(3);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('a read capability refuses mutations before any network request', () =>
    Effect.gen(function* () {
      const f = yield* fixture({handler: () => new Response(null)});
      const result = yield* Effect.result(f.request(pathname, 0, 'application/json', {method: 'PUT'}));
      expect(result).toMatchObject({failure: {kind: 'verification-failed'}});
      expect(f.requests).toHaveLength(0);
    }).pipe(provideTestLayer(layer)),
  );
  effectIt.effect('uses anonymous reads without falling back to plaintext Docker auths', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        handler: request => {
          expect(request.headers.get('authorization')).toBeNull();
          return new Response('bytes');
        },
      });
      expect(new TextDecoder().decode((yield* f.read()).bytes)).toBe('bytes');
      expect(f.helperCalls()).toBe(0);
      expect(f.requests).toHaveLength(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('uses the selected helper only after an exact-origin Basic challenge', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        helper: true,
        handler: request =>
          request.headers.get('authorization') === basic
            ? new Response('bytes')
            : new Response(null, {status: 401, headers: {'www-authenticate': 'Basic realm="synthetic"'}}),
      });
      yield* f.read();
      yield* f.read();
      expect(f.helperCalls()).toBe(1);
      expect(f.requests).toHaveLength(3);
      expect(f.requests[0]?.headers.get('authorization')).toBeNull();
      expect(f.requests.slice(1).every(request => request.headers.get('authorization') === basic)).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('requests only the exact pull scope and renews short-lived bearer tokens automatically', () =>
    Effect.gen(function* () {
      let issued = 0;
      const f = yield* fixture({
        helper: true,
        handler: request => {
          if (request.url.pathname === '/token') {
            expect(request.url.origin).toBe(target.origin);
            expect(request.url.searchParams.get('scope')).toBe(target.pullScope);
            expect([...request.url.searchParams.keys()].sort()).toEqual(['scope', 'service']);
            expect(request.headers.get('authorization')).toBe(basic);
            return Response.json({token: 'synthetic-token-' + ++issued, expires_in: 1});
          }
          return request.headers.get('authorization') === 'Bearer synthetic-token-' + issued && issued > 0
            ? new Response('bytes')
            : new Response(null, {
                status: 401,
                headers: {
                  'www-authenticate': `Bearer realm="${target.origin}/token",service="registry",scope="${target.pullScope}"`,
                },
              });
        },
      });
      yield* f.read();
      yield* f.read();
      expect(issued).toBe(1);
      expect(f.helperCalls()).toBe(1);
      yield* TestClock.adjust(1001);
      yield* f.read();
      expect(issued).toBe(2);
      expect(f.helperCalls()).toBe(2);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('denied helpers stop without anonymous or alternate-identity fallback and redact output', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        helper: true,
        helperDenied: true,
        handler: () => new Response(null, {status: 401, headers: {'www-authenticate': 'Basic realm="synthetic"'}}),
      });
      const exit = yield* Effect.exit(f.read());
      expect(exit._tag).toBe('Failure');
      expect(JSON.stringify(exit)).not.toContain(secret);
      expect(f.requests).toHaveLength(1);
      expect(f.helperCalls()).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('preserves token endpoint retry hints without retrying immediately', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        handler: request =>
          request.url.pathname === '/token'
            ? new Response(null, {status: 429, headers: {'retry-after': '17'}})
            : new Response(null, {
                status: 401,
                headers: {'www-authenticate': `Bearer realm="${target.origin}/token"`},
              }),
      });
      const result = yield* Effect.result(f.read());
      expect(result).toMatchObject({
        failure: {httpStatus: 429, kind: 'unavailable', retryAfterMilliseconds: 17_000},
      });
      expect(f.requests).toHaveLength(2);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rejects foreign realms, scope widening and redirects before credential use', () =>
    Effect.gen(function* () {
      for (const challenge of [
        'Bearer realm="https://foreign.example.test/token"',
        `Bearer realm="${target.origin}/token",scope="repository:acme/canonical:pull,push"`,
        `Bearer realm="${target.origin}/token?redirect=secret"`,
      ]) {
        const f = yield* fixture({
          helper: true,
          handler: () => new Response(null, {status: 401, headers: {'www-authenticate': challenge}}),
        });
        expect((yield* Effect.exit(f.read()))._tag).toBe('Failure');
        expect(f.requests).toHaveLength(1);
        expect(f.helperCalls()).toBe(0);
      }
      const f = yield* fixture({
        helper: true,
        handler: () =>
          new Response(null, {status: 307, headers: {location: 'https://foreign.example.test/blob?secret=signed'}}),
      });
      const exit = yield* Effect.exit(f.read());
      expect(exit._tag).toBe('Failure');
      expect(JSON.stringify(exit)).not.toContain('signed');
      expect(f.requests).toHaveLength(1);
      expect(f.helperCalls()).toBe(0);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('bounds authentication retries and aborts every completed request scope', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        helper: true,
        handler: () => new Response(null, {status: 401, headers: {'www-authenticate': 'Basic realm="synthetic"'}}),
      });
      expect((yield* Effect.exit(f.read()))._tag).toBe('Failure');
      expect(f.requests).toHaveLength(3);
      expect(f.helperCalls()).toBe(2);
      expect(f.requests.every(request => request.signal?.aborted)).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('stops an oversized streaming response without Content-Length', () =>
    Effect.gen(function* () {
      let cancelled = false;
      const f = yield* fixture({
        handler: () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(8));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      });
      expect((yield* Effect.exit(f.read(12)))._tag).toBe('Failure');
      expect(cancelled).toBe(true);
      expect(f.requests[0]?.signal?.aborted).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );
  effectIt.effect('rejects unsupported helper identities and identity changes without exposing helper contents', () =>
    Effect.gen(function* () {
      for (const response of [
        {Username: '<token>', Secret: secret},
        {Username: 'user:other', Secret: secret},
        {Username: 'synthetic-reader', Secret: secret, ServerURL: 'foreign.example.test'},
      ]) {
        const f = yield* fixture({
          helper: true,
          helperResponse: () => response,
          handler: () => new Response(null, {status: 401, headers: {'www-authenticate': 'Basic realm="fixture"'}}),
        });
        const exit = yield* Effect.exit(f.read());
        expect(exit._tag).toBe('Failure');
        expect(JSON.stringify(exit)).not.toContain(secret);
        expect(f.requests).toHaveLength(1);
      }
      const f = yield* fixture({
        helper: true,
        helperResponse: call => ({Username: call === 1 ? 'first' : 'second', Secret: secret}),
        handler: () => new Response(null, {status: 401, headers: {'www-authenticate': 'Basic realm="fixture"'}}),
      });
      expect((yield* Effect.exit(f.read()))._tag).toBe('Failure');
      expect(f.helperCalls()).toBe(2);
      expect(f.requests).toHaveLength(2);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('verifies exact blob bytes, digest headers and descriptor size bounds', () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode('synthetic graph bytes'),
        digest = sha256Digest(bytes);
      const valid = yield* fixture({handler: () => new Response(bytes, {headers: {'docker-content-digest': digest}})});
      expect(new Uint8Array(yield* valid.registry.readBlob(digest, bytes.length))).toEqual(bytes);
      expect((yield* Effect.exit(valid.registry.readBlob(digest, bytes.length - 1)))._tag).toBe('Failure');
      for (const handler of [
        () => new Response('tampered'),
        () => new Response(bytes, {headers: {'docker-content-digest': sha256Digest('different')}}),
        () => new Response(null, {status: 404}),
      ]) {
        const invalid = yield* fixture({handler});
        expect((yield* Effect.exit(invalid.registry.readBlob(digest)))._tag).toBe('Failure');
      }
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('resolves a tag to the exact immutable OCI manifest bytes and refuses invalid headers', () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode('fixture');
      const descriptor = graphShareOciDescriptorFromLayers({frontier: bytes, envelope: bytes, metadata: bytes});
      const body = new TextEncoder().encode(canonicalJson(descriptor)),
        digest = sha256Digest(body);
      const valid = yield* fixture({
        handler: () =>
          new Response(body, {headers: {'content-type': descriptor.mediaType, 'docker-content-digest': digest}}),
      });
      const resolved = yield* valid.registry.readManifest('tn-frontier-' + 'a'.repeat(40));
      expect(resolved).toMatchObject({
        descriptor,
        digest,
      });
      expect(new Uint8Array(resolved.bytes)).toEqual(body);
      for (const headers of [
        {'content-type': 'application/json', 'docker-content-digest': digest},
        {'content-type': descriptor.mediaType, 'docker-content-digest': sha256Digest('different')},
      ]) {
        const invalid = yield* fixture({handler: () => new Response(body, {headers})});
        expect((yield* Effect.exit(invalid.registry.readManifest('tn-frontier-' + 'a'.repeat(40))))._tag).toBe(
          'Failure',
        );
      }
    }).pipe(provideTestLayer(layer)),
  );
});
