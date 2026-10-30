import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, Layer} from 'effect';
import {HttpClient, HttpServer, HttpServerResponse} from 'effect/http';
import {TestClock} from 'effect/testing';
import {TestError} from '@threadnote/testing/test-error';
import {expect} from 'vitest';
import {managerLiveHttpLayer} from '../../src/manager/live.js';

effectIt.effect(
  'keeps a slow library response connected beyond the default HTTP idle timeout',
  () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.merge(managerLiveHttpLayer(0), BunHttpClient.layer));
      const server = Context.get(context, HttpServer.HttpServer);
      if (server.address._tag === 'UnixPathAddress') return yield* TestError.make({message: 'Expected TCP server'});

      // A complete library scan can exceed Bun's default 10-second HTTP idle timeout.
      yield* server.serve(Effect.sleep('22 seconds').pipe(Effect.as(HttpServerResponse.text('library ready'))));
      const client = Context.get(context, HttpClient.HttpClient);
      const response = yield* client.get(`http://127.0.0.1:${server.address.port}/api/tree`);

      expect(response.status).toBe(200);
      expect(yield* response.text).toBe('library ready');
    }).pipe(Effect.timeout('35 seconds'), TestClock.withLive),
  40_000,
);
