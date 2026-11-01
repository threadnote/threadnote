import {createInterface} from 'node:readline';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Context, Deferred, Effect, Layer} from 'effect';
import {HttpServer, HttpServerRequest, HttpServerResponse} from 'effect/http';
import {makeManagerLive, managerLiveHttpLayer, serveManagerLive} from '../../src/manager/live.js';

let stop: Deferred.Deferred<void> | undefined;
let releaseResponse: Deferred.Deferred<void> | undefined;
// The external controller must remain available while interrupted HTTP cleanup drains.
const input = createInterface({input: process.stdin});
input.on('line', line => {
  if (line === 'stop' && stop) Deferred.doneUnsafe(stop, Effect.void);
  if (line === 'release' && releaseResponse) Deferred.doneUnsafe(releaseResponse, Effect.void);
});

const healthSubscribed = new Set<string>();
const healthReleased = new Map<string, number>();
const observationSubscribed = new Set<string>();
const observationReleased = new Map<string, number>();
const program = Effect.gen(function* () {
  const live = yield* Effect.scoped(
    Effect.gen(function* () {
      stop = yield* Deferred.make<void>();
      releaseResponse = yield* Deferred.make<void>();
      const responseReady = releaseResponse;
      const context = yield* Layer.build(managerLiveHttpLayer(0));
      const server = Context.get(context, HttpServer.HttpServer);
      if (server.address._tag === 'UnixPathAddress') throw new Error('Expected a TCP fixture listener.');
      const origin = `http://127.0.0.1:${server.address.port}`;
      const live = yield* makeManagerLive({
        origin,
        token: 'synthetic-shutdown-fixture',
        projects: Effect.succeed(new Set(['fixture'])),
        health: {
          subscribe: key =>
            Effect.sync(() => {
              healthSubscribed.add(key);
              return [];
            }),
          release: key =>
            Effect.sync(() => {
              healthReleased.set(key, (healthReleased.get(key) ?? 0) + 1);
            }),
        },
        observations: {
          topics: ['graph-status'],
          subscribe: key =>
            Effect.sync(() => {
              observationSubscribed.add(key);
              return [];
            }),
          release: key =>
            Effect.sync(() => {
              observationReleased.set(key, (observationReleased.get(key) ?? 0) + 1);
            }),
        },
      });
      yield* serveManagerLive(
        server,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.url === '/slow') {
            yield* Console.log(JSON.stringify({type: 'accepted'}));
            yield* Deferred.await(responseReady);
            return HttpServerResponse.text('finite response', {status: 207});
          }
          if (request.url === '/diagnostics') return HttpServerResponse.jsonUnsafe(yield* live.diagnostics);
          return (yield* live.handle(request)) ?? HttpServerResponse.empty({status: 404});
        }),
        live,
      );
      yield* Console.log(JSON.stringify({type: 'ready', port: server.address.port}));
      yield* Deferred.await(stop);
      return live;
    }),
  );
  // Observe after the actual server Scope, including connection consumers, has closed.
  yield* Console.log(
    JSON.stringify({
      type: 'released',
      diagnostics: yield* live.diagnostics,
      healthSubscribed: [...healthSubscribed],
      healthReleased: [...healthReleased],
      observationSubscribed: [...observationSubscribed],
      observationReleased: [...observationReleased],
    }),
  );
}).pipe(Effect.ensuring(Effect.sync(() => input.close())));

// oxlint-disable-next-line effecttsgo/strict-effect-provide -- This fixture is the owned child-process application entrypoint.
BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
