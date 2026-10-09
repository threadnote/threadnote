import * as BunServices from '@effect/platform-bun/BunServices';
import {
  SourceCoordinator,
  SourceCoordinatorError,
  type SourceWorkRegistration,
} from '@threadnote/integration-core/source-coordinator';
import {makeCoordinatorClientLayer, runCoordinatorWorker} from '@threadnote/integration-runtime/coordinator-transport';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {appendFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {Clock, Effect, FileSystem, Layer} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

const [action, home] = process.argv.slice(2);
if (!home) throw new Error('A temporary coordinator home is required.');
const credentialMode = action?.includes('credential') === true;
const raceMode = action?.includes('race') === true;
const credentialEnv = 'THREADNOTE_SYNTHETIC_CREDENTIAL';
const config: RuntimeConfig = {
  account: 'local',
  agentContextHome: home,
  agentId: 'threadnote',
  manifestPath: join(home, 'seed-manifest.yaml'),
  user: 'process-test',
};
const eventPath = join(home, 'events.jsonl');
const record = (kind: string, credentialHash?: string) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap(at =>
      Effect.tryPromise(() =>
        appendFile(eventPath, `${JSON.stringify({kind, pid: process.pid, at, credentialHash})}\n`),
      ),
    ),
  );
const registration: SourceWorkRegistration<FileSystem.FileSystem> = {
  provider: 'synthetic',
  list: () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fingerprint = yield* fs
        .readFileString(join(home, 'source-version'))
        .pipe(Effect.orElseSucceed(() => 'test-fingerprint'));
      return [
        {
          sourceId: 'slow',
          provider: 'synthetic',
          accountKey: 'test-account',
          fingerprint,
          refreshIntervalMs: 60_000,
        },
      ];
    }),
  run: () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* record('start');
      while (!(yield* fs.exists(join(home, 'release')))) yield* Effect.sleep(25);
      yield* fs.writeFileString(join(home, 'snapshot.txt'), 'usable synthetic snapshot');
      yield* record('end');
      return {
        sourceId: 'slow',
        syncedDocuments: ['synthetic://slow/document'],
        warnings: [],
        value: {snapshot: 'usable synthetic snapshot'},
      };
    }),
};
const credentialRegistration: SourceWorkRegistration<FileSystem.FileSystem | SystemInfo> = {
  provider: 'synthetic',
  list: () =>
    Effect.gen(function* () {
      yield* record('list');
      const value = (yield* SystemInfo).environment()[credentialEnv];
      return [
        {
          sourceId: 'credential',
          provider: 'synthetic',
          accountKey: value === undefined ? 'missing' : sha256HexSync(value),
          fingerprint: 'credential-fingerprint',
          refreshIntervalMs: 60_000,
          credentialEnv,
        },
      ];
    }),
  run: () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const value = (yield* SystemInfo).environment()[credentialEnv];
      yield* record('credential', value === undefined ? 'missing' : sha256HexSync(value));
      if (value === undefined) return yield* SourceCoordinatorError.make({message: 'Synthetic credential is missing.'});
      const marker = join(home, 'continued');
      const more = value === 'synthetic-token-b' && !(yield* fs.exists(marker));
      if (more) yield* fs.writeFileString(marker, 'continuation requested');
      return {
        sourceId: 'credential',
        syncedDocuments: ['synthetic://credential/document'],
        warnings: [],
        value: {observed: sha256HexSync(value)},
        ...(more ? {more: true} : {}),
      };
    }),
};
const registrations = credentialMode ? [credentialRegistration] : [registration];
const filesystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let hidden = false;
    return {
      ...fs,
      exists: (path: string) => {
        if (action === 'credential-cold-refresh' && !hidden && path.replaceAll('\\', '/').endsWith('/endpoint.json')) {
          hidden = true;
          return record('hidden-endpoint').pipe(Effect.as(false), Effect.orDie);
        }
        return fs.exists(path);
      },
    };
  }),
).pipe(Layer.provide(BunServices.layer));
const base = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, filesystem);

if (action?.startsWith('worker')) {
  await Effect.runPromise(
    Effect.scoped(
      Layer.build(base).pipe(
        Effect.flatMap(context =>
          record('spawn').pipe(
            Effect.andThen(
              runCoordinatorWorker({config, registrations, idleTimeoutMs: credentialMode || raceMode ? 5_000 : 800}),
            ),
            Effect.provide(context),
          ),
        ),
      ),
    ),
  );
} else {
  const client = makeCoordinatorClientLayer({
    registrations,
    syncTimeoutMs: action === 'deadline' ? 300 : 8_000,
    spawnWorker: workerConfig =>
      Effect.sync(() => {
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            'apps/threadnote/test/integrations/coordinator-process-fixture.ts',
            credentialMode ? 'worker-credential' : raceMode ? 'worker-race' : 'worker',
            workerConfig.agentContextHome,
          ],
          env: process.env,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });
        child.unref();
      }),
  }).pipe(Layer.provideMerge(base));
  await Effect.runPromise(
    Effect.scoped(
      Layer.build(client).pipe(
        Effect.flatMap(context =>
          Effect.gen(function* () {
            const coordinator = yield* SourceCoordinator;
            const started = yield* Clock.currentTimeMillis;
            const result = action?.endsWith('refresh')
              ? yield* coordinator.requestRefresh(config)
              : yield* coordinator.sync(config, credentialMode ? 'credential' : 'slow');
            const elapsedMs = (yield* Clock.currentTimeMillis) - started;
            process.stdout.write(`${JSON.stringify({elapsedMs, result})}\n`);
          }).pipe(Effect.provide(context)),
        ),
      ),
    ),
  );
}
