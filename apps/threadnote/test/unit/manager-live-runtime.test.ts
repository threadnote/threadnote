import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunSocket from '@effect/platform-bun/BunSocket';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Path, Ref, Schema, String as Str} from 'effect';
import {HttpClient, HttpClientRequest, HttpServer, HttpServerRequest, HttpServerResponse} from 'effect/http';
import * as Socket from 'effect/socket/Socket';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {MANAGER_LIVE_SNAPSHOT_HEADER, ManagerLiveServerFrame} from '@threadnote/manager/live/contracts';
import {runtimeConfigForTest} from '@threadnote/workspace/test/helpers/runtime-config';
import type {CodeGraphAutomaticCompactionStatus} from '@threadnote/graph/automatic/compaction';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {makeManagerLiveObservationRuntime} from '../../src/manager/live_observation_runtime.js';
import {installationRoot} from '../../src/process/standalone_lease.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

effectIt.effect('keeps the composed fresh-home account live sources connected across panel subscriptions', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-live-runtime-'});
    const config = runtimeConfigForTest({agentContextHome: home, manifestPath: `${home}/seed-manifest.yaml`});
    yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
    const system = yield* SystemInfo;
    const fixtureSystem = {
      ...system,
      homeDirectory: home,
      currentDirectory: () => home,
      executablePath: `${home}/bin/bun`,
      environment: () => ({HOME: home, THREADNOTE_INSTALL_ROOT: `${home}/standalone`}),
      signalProcess: () => {
        throw new Error('Unexpected process signal from live snapshot');
      },
    };
    yield* Effect.gen(function* () {
      expect(installationRoot(yield* Path.Path, yield* SystemInfo)).toBe(`${home}/standalone`);
      const context = yield* Layer.build(BunHttpServer.layer({hostname: '127.0.0.1', port: 0}));
      const server = Context.get(context, HttpServer.HttpServer);
      if (server.address._tag === 'UnixPathAddress') throw new Error('Expected TCP server');
      const origin = `http://127.0.0.1:${server.address.port}`;
      const runtime = yield* makeManagerLiveObservationRuntime(
        config,
        server.address.port,
        'synthetic-token',
        yield* Ref.make<CodeGraphAutomaticCompactionStatus>({state: 'idle'}),
      );
      yield* server.serve(
        Effect.gen(function* () {
          return (
            (yield* runtime.live.handle(yield* HttpServerRequest.HttpServerRequest)) ??
            HttpServerResponse.empty({status: 404})
          );
        }),
      );
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.execute(
        yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(`${origin}/api/live-session`, {
            headers: {
              authorization: 'Bearer synthetic-token',
              origin,
              [MANAGER_LIVE_SNAPSHOT_HEADER]: 'processes',
            },
          }),
          {topics: ['home', 'share-conflicts', 'processes']},
        ),
      );
      const ticket = yield* Schema.decodeUnknownEffect(Schema.Struct({ticket: Schema.String}))(yield* response.json);
      const socket = yield* Socket.makeWebSocket(
        `${Str.replace('http:', 'ws:')(origin)}/api/live?ticket=${ticket.ticket}`,
        {
          headers: {origin},
        },
      );
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const pending: ManagerLiveServerFrame[] = [];
      const next = Effect.suspend(() =>
        pending.length > 0
          ? Effect.succeed(pending.shift()!)
          : reader.pull.pipe(
              Effect.flatMap(batch =>
                Effect.gen(function* () {
                  for (const raw of batch)
                    pending.push(
                      yield* Schema.decodeUnknownEffect(ManagerLiveServerFrame)(
                        JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)),
                      ),
                    );
                  return pending.shift()!;
                }),
              ),
            ),
      );
      expect(yield* next).toMatchObject({type: 'welcome', snapshots: ['processes']});
      const shares = {topic: 'share-conflicts', scope: 'account'} as const;
      const accountHome = {topic: 'home', scope: 'account'} as const;
      const processes = {topic: 'processes', scope: 'account'} as const;
      for (const [index, resources] of [
        [processes, shares],
        [processes, shares, accountHome],
        [processes, shares],
      ].entries()) {
        const generation = index + 1;
        yield* writer.write(JSON.stringify({type: 'subscribe', version: 1, generation, resources}));
        let acknowledged = false;
        while (!acknowledged) {
          const frame = yield* next;
          acknowledged = frame.type === 'subscribed' && frame.generation === generation;
        }
      }
      let snapshot = false;
      while (!snapshot) {
        const frame = yield* next;
        if (frame.type !== 'snapshot' || frame.generation !== 3) continue;
        expect(frame.resource).toEqual(processes);
        expect(frame.data).toMatchObject({schemaVersion: 1, processes: [], truncated: false});
        snapshot = true;
      }
      yield* writer.write(new Socket.CloseEvent());
      for (let attempt = 0; attempt < 50 && (yield* runtime.live.diagnostics).connections !== 0; attempt++)
        yield* Effect.sleep(10);
      expect((yield* runtime.live.diagnostics).connections).toBe(0);
    }).pipe(Effect.provideService(SystemInfo, fixtureSystem));
  }).pipe(
    Effect.timeout('8 seconds'),
    TestClock.withLive,
    provideTestLayer(Layer.mergeAll(ApplicationLayer, BunHttpClient.layer, BunSocket.layerWebSocketConstructor)),
  ),
);
