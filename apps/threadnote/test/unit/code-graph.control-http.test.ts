import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {CommandExecutor} from '@threadnote/platform/command';

import {enrollGraphControlClient} from '@threadnote/graph/sharing/client/enrollment';
import {makeAuthenticatedGraphControlClient} from '@threadnote/graph/sharing/control/http';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {provideTestLayer} from '../helpers/effect-layer.js';

const scope = {
  coordinatorUrl: 'https://graph.example.test/team',
  organization: 'acme',
  profileDigest: sha256Digest('profile'),
  repositoryId: 'a'.repeat(64),
};
const issuer = 'https://login.example.test/';
const audience = 'https://graph.example.test';
const layer = Layer.mergeAll(TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer)), FetchHttpClient.layer);
const fixture = Effect.fn('test.controlHttp.fixture')(function* (
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  options: {coordinatorUrl?: string; beforeCredential?: Effect.Effect<void>} = {},
) {
  const requestScope = {...scope, coordinatorUrl: options.coordinatorUrl ?? scope.coordinatorUrl};
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-control-http-'});
  yield* fs.makeDirectory(path.join(home, 'graph-sharing'));
  yield* fs.writeFileString(
    path.join(home, 'graph-sharing/control-credentials.json'),
    JSON.stringify({
      bindings: [
        {
          coordinatorUrl: requestScope.coordinatorUrl,
          organization: scope.organization,
          helper: 'fixture',
          issuer,
          audience,
        },
      ],
      schemaVersion: 1,
    }),
  );
  let helperCalls = 0;
  let httpCalls = 0;
  const fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      httpCalls++;
      expect(init?.redirect).toBe('manual');
      expect(init?.credentials).toBe('omit');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-threadnote-profile-digest')).toBe(scope.profileDigest);
      expect(headers.get('x-threadnote-repository-id')).toBe(scope.repositoryId);
      return handler(String(url), init!);
    },
    {preconnect: () => undefined},
  ) as typeof globalThis.fetch;
  const client = yield* makeAuthenticatedGraphControlClient(home, requestScope, 'graph:contribute').pipe(
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(CommandExecutor, {
      execute: () =>
        Effect.gen(function* () {
          helperCalls++;
          if (options.beforeCredential !== undefined) yield* options.beforeCredential;
          return {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              accessToken: 'synthetic-token-' + helperCalls,
              audience,
              issuer,
              schemaVersion: 1,
              subject: 'principal',
              expiresAt: Math.floor((yield* Clock.currentTimeMillis) / 1000) + 600,
            }),
          };
        }),
      executeStreaming: () => Effect.succeed({exitCode: 1, stdout: '', stderr: ''}),
    }),
  );
  return {home, client, helperCalls: () => helperCalls, httpCalls: () => httpCalls};
});

describe('authenticated graph control transport', () => {
  effectIt.effect('carries enrollment eligibility through the real control transport before dispatch', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let authorized = true;
      const f = yield* fixture(() => Response.json({ok: true}, {status: 201}), {
        beforeCredential: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
      });
      const enrollment = yield* enrollGraphControlClient({
        home: f.home,
        scope,
        client: f.client,
        isAuthorized: Effect.sync(() => authorized),
      }).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      authorized = false;
      yield* Deferred.succeed(resume, undefined);
      expect((yield* Fiber.join(enrollment))._tag).toBe('Failure');
      expect(f.httpCalls()).toBe(0);
    }).pipe(provideTestLayer(layer)),
  );

  for (const pausedAttempt of [1, 2])
    effectIt.effect(`stops dispatch when authorization is revoked during credential attempt ${pausedAttempt}`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let authorized = true;
        let attempts = 0;
        const f = yield* fixture(() => new Response(null, {status: 401}), {
          beforeCredential: Effect.gen(function* () {
            if (++attempts === pausedAttempt) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
            }
          }),
        });
        const request = yield* f.client
          .request(
            'POST',
            '/v1/enroll',
            {},
            Effect.sync(() => authorized),
          )
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        authorized = false;
        yield* Deferred.succeed(resume, undefined);
        expect((yield* Fiber.join(request))._tag).toBe('Failure');
        expect(f.httpCalls()).toBe(pausedAttempt - 1);
      }).pipe(provideTestLayer(layer)),
    );

  effectIt.effect('joins origin and mounted coordinator bases with a single endpoint separator', () =>
    Effect.gen(function* () {
      for (const base of ['https://graph.example.test', 'https://graph.example.test/team'])
        for (const suffix of ['', '/']) {
          const f = yield* fixture(
            url => {
              expect(url).toBe(base + '/v1/enroll');
              return Response.json({ok: true}, {status: 201});
            },
            {coordinatorUrl: base + suffix},
          );
          yield* f.client.request('POST', '/v1/enroll', {});
          expect(f.httpCalls()).toBe(1);
        }
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('retries one token rejection while keeping concurrent requests scoped to their resource', () =>
    Effect.gen(function* () {
      const f = yield* fixture((url, init) => {
        expect(url).toBe(scope.coordinatorUrl + '/v1/enroll');
        const authorization = new Headers(init.headers).get('authorization');
        if (authorization === 'Bearer synthetic-token-1') return new Response(null, {status: 401});
        expect(authorization).toBe('Bearer synthetic-token-2');
        return Response.json({ok: true}, {status: 201});
      });
      const results = yield* Effect.forEach(
        Array.from({length: 8}),
        () => f.client.request('POST', '/v1/enroll', {idempotencyKey: 'operation'}),
        {concurrency: 8},
      );
      expect(results.every(result => result.status === 201 && result.body.ok === true)).toBe(true);
      expect(f.helperCalls()).toBe(2);
      expect(new Set(results.map(result => result.credential.identity)).size).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rejects redirects, caller-controlled destinations and excessive control bodies', () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        () => new Response(null, {status: 302, headers: {location: 'https://foreign.example.test'}}),
      );
      for (const pathname of [
        'https://foreign.example.test',
        '//foreign.example.test',
        '/v1/../v1/enroll',
        '/v1/enroll?destination=other',
        '/v1/cas/sha256:' + 'a'.repeat(64),
      ])
        expect((yield* Effect.result(f.client.request('POST', pathname, {})))._tag).toBe('Failure');
      expect((yield* Effect.result(f.client.request('POST', '/v1/enroll', {large: 'x'.repeat(65536)})))._tag).toBe(
        'Failure',
      );
      expect(f.httpCalls()).toBe(0);
      expect(f.helperCalls()).toBe(0);
      expect((yield* Effect.result(f.client.request('GET', '/v1/status')))._tag).toBe('Failure');
      expect(f.httpCalls()).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('bounds streamed metadata and preserves backpressure without retaining server bodies', () =>
    Effect.gen(function* () {
      const big = yield* fixture(() => new Response('x'.repeat(65537)));
      expect((yield* Effect.result(big.client.request('GET', '/v1/status')))._tag).toBe('Failure');
      const denied = yield* fixture(
        () => new Response('synthetic-private-response', {status: 429, headers: {'retry-after': '120'}}),
      );
      const result = yield* Effect.result(denied.client.request('POST', '/v1/enroll', {}));
      expect(result._tag).toBe('Failure');
      expect(JSON.stringify(result)).toContain('120000');
      expect(JSON.stringify(result)).not.toContain('synthetic-private-response');
      expect(denied.httpCalls()).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('returns only a bounded exact stale-source result response', () =>
    Effect.gen(function* () {
      const idempotencyKey = sha256Digest('stale operation');
      const stale = yield* fixture(() => Response.json({error: 'stale-source', idempotencyKey}, {status: 409}));
      const response = yield* stale.client.request('POST', '/v1/results', {});
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: 'stale-source',
        idempotencyKey,
      });
      const conflict = yield* fixture(() =>
        Response.json({error: 'operation-conflict', idempotencyKey}, {status: 409}),
      );
      expect((yield* Effect.result(conflict.client.request('POST', '/v1/results', {})))._tag).toBe('Failure');
      const extra = yield* fixture(() =>
        Response.json({error: 'stale-source', idempotencyKey, unexpected: true}, {status: 409}),
      );
      expect((yield* Effect.result(extra.client.request('POST', '/v1/results', {})))._tag).toBe('Failure');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('keeps a valid result admission alive beyond the prior 30-second deadline', () =>
    Effect.gen(function* () {
      let entered!: () => void;
      let resolve!: (response: Response) => void;
      const started = new Promise<void>(ready => {
        entered = ready;
      });
      const pending = new Promise<Response>(ready => {
        resolve = ready;
      });
      const f = yield* fixture(() => {
        entered();
        return pending;
      });
      const request = yield* f.client.request('POST', '/v1/results', {}).pipe(Effect.result, Effect.forkScoped);
      yield* Effect.promise(() => started);
      yield* TestClock.adjust('31 seconds');
      expect(request.pollUnsafe()).toBeUndefined();
      resolve(Response.json({idempotencyKey: sha256Digest('operation'), status: 'accepted'}, {status: 201}));
      expect((yield* Fiber.join(request))._tag).toBe('Success');
      expect(f.httpCalls()).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('bounds the whole result request across a 401 credential retry', () =>
    Effect.gen(function* () {
      const secondCredential = yield* Deferred.make<void>();
      let loads = 0;
      const f = yield* fixture(() => new Response(null, {status: 401}), {
        beforeCredential: Effect.gen(function* () {
          if (++loads === 2) {
            yield* Deferred.succeed(secondCredential, undefined);
            yield* Effect.sleep('600 seconds');
          }
        }),
      });
      const request = yield* f.client.request('POST', '/v1/results', {}).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(secondCredential);
      yield* TestClock.adjust('311 seconds');
      expect((yield* Fiber.join(request))._tag).toBe('Failure');
      expect(f.httpCalls()).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );
});
