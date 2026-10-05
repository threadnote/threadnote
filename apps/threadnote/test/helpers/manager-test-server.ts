import {BunHttpServer} from '@effect/platform-bun';
import {Effect, Fiber, Scope} from 'effect';
import {HttpServer} from 'effect/http';
import {createManagerServer} from '@threadnote/threadnote/manager/index';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from './effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';

export interface ManagerTestServer {
  readonly close: () => Promise<void>;
  readonly url: string;
}

// The manager tests exercise the actual fetch/HTTP callback boundary. This
// helper owns the one Effect runtime that backs that Promise-native server.
export async function startManagerTestServer(config: RuntimeConfig, token: string): Promise<ManagerTestServer> {
  let resolveAddress: ((value: string) => void) | undefined;
  let rejectAddress: ((reason: unknown) => void) | undefined;
  const address = new Promise<string>((resolve, reject) => {
    resolveAddress = resolve;
    rejectAddress = reject;
  });
  const fiber = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const worksetScope = yield* Scope.Scope;
        yield* server.serve(createManagerServer({config, jobs: new Map(), token, worksetScope}));
        const serverAddress = server.address;
        if (serverAddress._tag === 'UnixPathAddress') {
          return yield* TestError.make({message: 'manager test server did not bind to TCP'});
        }
        yield* Effect.sync(() => resolveAddress?.(`http://127.0.0.1:${serverAddress.port}`));
        return yield* Effect.never;
      }),
    ).pipe(
      provideTestLayer(BunHttpServer.layerTest),
      provideTestLayer(ApplicationLayer),
      Effect.tapError(error => Effect.sync(() => rejectAddress?.(error))),
    ),
  );
  return {
    close: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
    url: await address,
  };
}
