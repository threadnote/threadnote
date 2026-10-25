import * as BunServices from '@effect/platform-bun/BunServices';
import {appendFileSync, existsSync, readFileSync} from '@threadnote/testing/node-fs';
import {Crypto, Effect, FileSystem, Layer, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CodeGraphStore} from '@threadnote/graph/store';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {runCodeGraphEmbeddingWorker} from '@threadnote/graph/vector/worker';
import {readCodeGraphEmbeddingDemandPage, enqueueCodeGraphEmbeddingDemandSql} from '@threadnote/graph/vector/demand';
import {withCodeGraphDatabaseWriteLock, withCodeGraphTargetWorktreeLock} from '@threadnote/graph/maintenance/gate';
import {
  CODE_GRAPH_EXTRACTOR_GENERATION,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {ModelNotInstalled} from '@threadnote/inference/engine/errors';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {SystemInfo} from '@threadnote/platform/system';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {wakeCodeGraphEmbeddingWorker} from '../../src/code_graph/embedding_worker.js';
import {
  isolatedLocalModelRuntimeLayer,
  localModelWorkerServer,
  type LocalModelWorkerProcess,
} from '../../src/effect/ai/isolated-local-model-runtime.js';

export const checkoutId = 'a'.repeat(64);
export const worktreeId = 'b'.repeat(64);
export const manifest = {...BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'bge-small-en-v1.5-q8')!, dimensions: 2};
export const alternateManifest = {
  ...manifest,
  id: 'fixture-embedding-b',
  sha256: 'b'.repeat(64),
};
export const snapshotId = `cgsn_${'1'.repeat(40)}`;
export function record(home: string, event: Record<string, unknown>) {
  appendFileSync(`${home}/events.jsonl`, `${JSON.stringify({...event, pid: process.pid})}\n`);
}
const modelStore = Layer.succeed(
  LocalModelStore,
  LocalModelStore.of({
    install: home =>
      Effect.sync(() => record(home, {event: 'download'})).pipe(
        Effect.andThen(Effect.die('Unexpected automatic model download')),
      ),
    remove: () => Effect.succeed(false),
    path: home => `${home}/fake.gguf`,
    status: (home, requestedManifest) =>
      Effect.succeed({
        modelId: requestedManifest.id,
        installed: !existsSync(`${home}/missing-model`),
        verified: true,
        path: `${home}/fake.gguf`,
        bytes: requestedManifest.size,
        partialBytes: 0,
      }),
    verify: (home, requestedManifest) =>
      existsSync(`${home}/missing-model`)
        ? ModelNotInstalled.make({
            modelId: requestedManifest.id,
            path: `${home}/fake.gguf`,
            message: 'Fixture model is not installed.',
          })
        : Effect.succeed({
            modelId: requestedManifest.id,
            installed: true,
            verified: true,
            path: `${home}/fake.gguf`,
            bytes: requestedManifest.size,
            partialBytes: 0,
          }),
  }),
);
export const fixtureLayer = Layer.mergeAll(
  CodeGraphStore.layer,
  LocalModelCatalog.layer([manifest, alternateManifest]),
  modelStore,
  TestCommandExecutorLayer,
).pipe(Layer.provideMerge(TestSystemInfoLayer), Layer.provideMerge(BunServices.layer));
export const seed = (home: string, count = 65, catalogId = checkoutId, viewId = worktreeId) =>
  Effect.gen(function* () {
    const checkoutId = catalogId;
    const worktreeId = viewId;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(home, {recursive: true});
    const store = yield* CodeGraphStore;
    const catalog = yield* LocalModelCatalog;
    yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
    const layout = codeGraphLayout(path, home, checkoutId, worktreeId);
    const identity: RepositoryIdentity = {
      caseMode: 'sensitive',
      checkoutId,
      worktreeId,
      displayName: 'worker-test',
      gitCommonDirectory: home,
      headCommit: 'c'.repeat(40),
      objectFormat: 'sha1',
      repoRoot: home,
      repositoryId: checkoutId,
    };
    const snapshot: CodeGraphSnapshot = {
      id: snapshotId,
      commit: identity.headCommit,
      dirty: false,
      edgeCount: 0,
      extractorSet: 'test',
      fileCount: count,
      repositoryId: checkoutId,
      state: 'ready',
      symbolCount: count,
      worktreeId,
    };
    yield* store.initialize(layout.databasePath);
    yield* store.markBuilding(layout.databasePath, identity, snapshot);
    yield* store.withSession(
      layout.databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (let n = 0; n < count; n++) {
          const id = `symbol-${n.toString().padStart(4, '0')}`;
          yield* sql.unsafe(
            'INSERT INTO symbols (snapshot_id, id, content_hash, kind, name, qualified_name, path, language, lookup_keys_json, exported, span_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              snapshotId,
              id,
              'a'.repeat(64),
              'function',
              `Alpha${n}`,
              `Alpha${n}`,
              `${id}.ts`,
              'typescript',
              '[]',
              1,
              JSON.stringify({line: 1, column: 1, endLine: 1, endColumn: 2}),
            ],
          );
        }
        yield* sql.unsafe("UPDATE snapshots SET state = 'ready' WHERE id = ?", [snapshotId]);
        yield* sql.unsafe('INSERT INTO snapshot_extractor_generations VALUES (?, ?)', [
          snapshotId,
          CODE_GRAPH_EXTRACTOR_GENERATION,
        ]);
      }),
    );
    yield* store.promote(layout.databasePath, identity, snapshotId);
    yield* store.withSession(
      layout.databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [active] = yield* sql.unsafe<{activated_at: string}>(
          'SELECT activated_at FROM active_snapshots WHERE worktree_id = ?',
          [worktreeId],
        );
        yield* enqueueCodeGraphEmbeddingDemandSql(sql, {worktreeId, snapshotId, activatedAt: active.activated_at});
      }),
    );
    return layout;
  });
export const lanes = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const store = yield* CodeGraphStore;
    const layout = codeGraphLayout(path, home, checkoutId, worktreeId);
    return yield* store.withSession(
      layout.databasePath,
      Effect.gen(function* () {
        return yield* readCodeGraphEmbeddingDemandPage(yield* SqlClient.SqlClient);
      }),
      {readOnly: true},
    );
  });
function spawnModel(home: string): LocalModelWorkerProcess {
  const child = Bun.spawn({
    cmd: [process.execPath, import.meta.filename, '--model', '--home', home],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {...process.env},
  });
  record(home, {event: 'model-spawn', childPid: child.pid});
  return {
    closeInput: async () => {
      await child.stdin.end();
    },
    exited: child.exited,
    kill: () => child.kill('SIGKILL'),
    stderr: child.stderr,
    stdout: child.stdout,
    write: async line => {
      await child.stdin.write(line);
      await child.stdin.flush();
    },
  };
}
const argument = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const main = Effect.gen(function* () {
  const home = argument('--home');
  const system = yield* SystemInfo;
  if (process.argv.includes('--model')) {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | SystemInfo | Crypto.Crypto>();
    const runtime = LocalModelRuntime.of({
      diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 2}),
      embedMany: ({inputs, embeddingContextPoolSize, manifest: requestedManifest}) =>
        Effect.gen(function* () {
          record(home, {
            event: 'inference',
            inputs: inputs.length,
            pool: embeddingContextPoolSize,
            modelId: requestedManifest.id,
          });
          if (existsSync(`${home}/hang-model`)) return yield* Effect.never;
          while (existsSync(`${home}/pause-model-batch`)) yield* Effect.sleep(10);
          if (!existsSync(`${home}/skip-model-lock`))
            yield* withCodeGraphTargetWorktreeLock(
              home,
              checkoutId,
              worktreeId,
              withCodeGraphDatabaseWriteLock(home, checkoutId, Effect.void, 0),
            ).pipe(Effect.provide(context), Effect.orDie);
          record(home, {event: 'inference-finished'});
          return inputs.map(() => [1, 0]);
        }),
      generate: () => Effect.die('unexpected'),
      rerank: () => Effect.die('unexpected'),
    });
    return yield* localModelWorkerServer.pipe(Effect.provideService(LocalModelRuntime, runtime));
  }
  if (process.argv.includes('--wake')) {
    const result = yield* wakeCodeGraphEmbeddingWorker(home).pipe(
      Effect.provideService(SystemInfo, {...system, developmentEntrypoint: import.meta.filename}),
    );
    process.stdout.write(`${JSON.stringify({ready: result})}\n`);
    return;
  }
  const store = yield* CodeGraphStore;
  const instrumented = {
    ...store,
    loadEmbeddingSymbolPage: (...args: Parameters<typeof store.loadEmbeddingSymbolPage>) =>
      Effect.sync(() => record(home, {event: 'symbol-page', limit: args[3]})).pipe(
        Effect.andThen(store.loadEmbeddingSymbolPage(...args)),
      ),
  };
  const program = runCodeGraphEmbeddingWorker(home, {
    version: argument('--version') || (yield* getThreadnoteVersion()),
    catalogPage: () =>
      Effect.succeed({
        checkoutIds: existsSync(`${home}/catalog.json`)
          ? (JSON.parse(readFileSync(`${home}/catalog.json`, 'utf8')) as string[])
          : [checkoutId],
      }),
    onUnitResult: result => Effect.sync(() => record(home, {event: 'unit-result', state: result.state})),
    pollMilliseconds: 25,
    idleGraceMilliseconds: 75,
    onReady: Effect.sync(() => {
      record(home, {event: 'worker-ready'});
      if (existsSync(`${home}/crash-after-ready`)) process.exit(76);
    }),
    onClaim: Effect.sync(() => {
      record(home, {event: 'claimed'});
      if (existsSync(`${home}/crash-after-claim`)) process.exit(78);
    }).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          while (existsSync(`${home}/pause-after-claim`)) yield* Effect.sleep(10);
        }),
      ),
    ),
    afterCheckpoint: Effect.sync(() => {
      record(home, {event: 'checkpoint'});
      if (existsSync(`${home}/crash-after-checkpoint`)) process.exit(79);
    }),
    afterAttachment: Effect.sync(() => {
      record(home, {event: 'attached'});
      if (existsSync(`${home}/crash-after-attach`)) process.exit(77);
    }),
  });
  const runtimeContext = yield* Layer.build(
    isolatedLocalModelRuntimeLayer({
      spawnWorker: () => spawnModel(home),
      requestDeadlineMs: 1500,
      maximumRequestAttempts: 1,
      idleTimeoutMs: 0,
    }),
  );
  yield* program.pipe(
    Effect.provideService(
      SystemInfo,
      existsSync(`${home}/disk-denied`) ? {...system, availableDiskBytes: () => Effect.succeed(0)} : system,
    ),
    Effect.provideService(CodeGraphStore, instrumented),
    Effect.provide(runtimeContext),
  );
});
if (import.meta.main) {
  await Effect.runPromise(main.pipe(provideTestLayer(fixtureLayer)));
}
