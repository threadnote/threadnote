import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {
  Array as EffectArray,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {FileLockTimeout} from '@threadnote/platform/file/lock';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {ResourceStore} from '@threadnote/store/resource-store';
import {loadRecallIndexData} from '../../src/index.js';
import {refreshRecallDerivedIndexesFromSelection} from '../../src/mcp/refresh.js';
import {RecallReadyReadBoundary} from '../../src/read_boundary.js';
import {recallResourceInvalidationLayer} from '../../src/resource-invalidation.js';
import {stepRecallVectorPreparation} from '../../src/background/vector-step.js';
import {
  MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS,
  RECALL_SEMANTIC_COMPACTION_NOTICE,
  loadMcpRecallSemanticScoresResult,
  loadRecallSemanticScoresResult,
} from '../../src/semantic_scores.js';
import {vectorIndexDatabaseFilename, vectorIndexStatus} from '../../src/vector-index.js';
import {
  readRecallVectorCompactionState,
  recallVectorStorageReport,
  runRecallVectorCompaction,
} from '../../src/vector/compaction.js';
import {
  readSqlitePageStorage,
  RecallVectorCompactionThresholds,
  sqliteCompactionRecommendation,
} from '../../src/vector/sqlite-pages.js';
import {withRecallVectorWrite} from '../../src/vector/storage.js';
import {selectedSemanticScores, vectorIndexGenerationReadiness} from '../../src/vector/semantic-read.js';

const manifest = {
  ...Option.getOrThrow(EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.role === 'embedding')),
  dimensions: 2,
};
/** Test-sized thresholds; production keeps the 512 MiB floor of the same rule. */
const thresholds = {minimumReclaimableBytes: 1024 * 1024, minimumReclaimableRatio: 0.2, safetyMarginBytes: 0};
const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: environment => environment,
        sanitizeExternal: environment => environment,
      }),
    ),
  ),
);
const services = ResourceStore.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      BunServices.layer,
      cryptoLayer,
      recallResourceInvalidationLayer,
      LocalModelCatalog.layer([manifest]),
      Layer.succeed(RecallVectorCompactionThresholds, thresholds),
      system,
    ),
  ),
);
const installed = {
  bytes: 1,
  installed: true,
  modelId: manifest.id,
  partialBytes: 0,
  path: '/fake.gguf',
  verified: true,
};
const models = LocalModelStore.of({
  install: () => Effect.die('unexpected install'),
  path: () => installed.path,
  remove: () => Effect.succeed(false),
  status: () => Effect.succeed(installed),
  verify: () => Effect.succeed(installed),
});
const runtime = LocalModelRuntime.of({
  diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 1}),
  embedMany: request => Effect.succeed(EffectArray.map(request.inputs, (_, index) => [index % 2, 1 - (index % 2)])),
  generate: () => Effect.die('unexpected generation'),
  rerank: () => Effect.die('unexpected rerank'),
});
const withModels = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.provideService(LocalModelStore, models), Effect.provideService(LocalModelRuntime, runtime));

/**
 * A home with a current vector generation and free pages above the test thresholds. `ballastRows` of 64 KiB
 * live data, with as many free pages again, make one real VACUUM last long enough to act on while it runs.
 */
const fixture = (ballastRows = 0) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* ResourceStore;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'recall-vector-compaction-'}));
    const config = {account: 'local', user: 'test', agentContextHome: home};
    yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
    for (const name of ['alpha', 'beta', 'gamma'])
      yield* store.mutateChecked(
        {account: 'local', user: 'test', home},
        [
          {
            type: 'write',
            uri: `threadnote://user/test/memories/durable/projects/threadnote/${name}.md`,
            content: formatMemoryDocument(
              'MEMORY',
              {
                kind: 'durable',
                memoryId: `tn_${name}`,
                status: 'active',
                project: 'threadnote',
                topic: name,
                sourceAgentClient: 'test',
                timestamp: '2026-11-01T00:00:00Z',
              },
              `Compaction fixture body ${name}.`,
            ),
            options: {mode: 'upsert'},
          },
        ],
        Effect.void,
      );
    const corpus = (yield* loadRecallIndexData(config, {includeInactive: false, memoryIds: []})).generation;
    for (let turn = 0; ; turn++) {
      if (turn > 200) return yield* Effect.die('builder did not converge');
      if ((yield* withModels(stepRecallVectorPreparation(config, manifest, Effect.succeed(true)))).state === 'current')
        break;
    }
    expect(yield* vectorIndexGenerationReadiness(home, manifest, corpus)).toBe('current');
    const database = path.join(home, 'indexes/vectors', manifest.id, vectorIndexDatabaseFilename());
    yield* Effect.sync(() => {
      const db = new Database(database);
      try {
        const blob = new Uint8Array(64 * 1024).map((_, index) => index % 251);
        db.exec('CREATE TABLE ballast (body BLOB); CREATE TABLE padding (body BLOB); BEGIN');
        for (let row = 0; row < ballastRows; row++) db.query('INSERT INTO ballast VALUES (?)').run(blob);
        for (let row = 0; row < Math.max(64, ballastRows); row++) db.query('INSERT INTO padding VALUES (?)').run(blob);
        db.exec('COMMIT; DROP TABLE padding; PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
    });
    const ready = yield* vectorIndexStatus(home, manifest);
    expect(ready.ready).toBe(true);
    const live = sqliteCompactionRecommendation(yield* readSqlitePageStorage(database), thresholds);
    expect(live.recommended).toBe(true);
    return {fs, path, home, config, corpus, database, ready, live};
  });

/** The free-space probe is the compaction's only injected seam; every other step runs for real. */
const withProbe = <A, E, R>(probe: SystemInfoShape['availableDiskBytes'], program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const real = yield* SystemInfo;
    return yield* program.pipe(Effect.provideService(SystemInfo, {...real, availableDiskBytes: probe}));
  });
const plenty = () => Effect.succeed(Number.MAX_SAFE_INTEGER);
const compact = (home: string) => withProbe(plenty, runRecallVectorCompaction(home, manifest));
/** A compaction that holds the vector lock, with `running` recorded, until `release`. */
const heldCompaction = (home: string) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fiber = yield* withProbe(
      () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(1e15)),
      runRecallVectorCompaction(home, manifest),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(entered).pipe(Effect.timeout('5 seconds'));
    return {fiber, release: Deferred.succeed(release, undefined)};
  });
const sqlite = <A>(database: string, use: (db: Database) => A) =>
  Effect.sync(() => {
    const db = new Database(database);
    try {
      return use(db);
    } finally {
      db.close();
    }
  });
const integrity = (database: string) =>
  sqlite(database, db => db.query<{integrity_check: string}, []>('PRAGMA integrity_check').get()?.integrity_check);
const walBytes = (fs: FileSystem.FileSystem, database: string) =>
  fs.stat(database + '-wal').pipe(
    Effect.map(info => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );

/** `run` compacts for real; `stall` holds the lock in the unit because its probe never answers. */
const childScript = `
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {runRecallVectorCompaction} from '@threadnote/recall/vector/compaction';
import {RecallVectorCompactionThresholds} from '@threadnote/recall/vector/sqlite-pages';
const [home, mode] = process.argv.slice(-2);
const manifest = {...BUILTIN_MODEL_MANIFESTS.find(model => model.role === 'embedding'), dimensions: 2};
const system = SystemInfo.layer.pipe(Layer.provide(Layer.mergeAll(
  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
  Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: e => e, sanitizeExternal: e => e}),
)));
const probe = Layer.effect(SystemInfo, Effect.gen(function* () {
  const real = yield* SystemInfo;
  return {...real, availableDiskBytes: () => mode === 'stall' ? Effect.never : Effect.succeed(Number.MAX_SAFE_INTEGER)};
})).pipe(Layer.provide(system));
await Effect.runPromise(runRecallVectorCompaction(home, manifest).pipe(
  Effect.provide(Layer.mergeAll(
    BunServices.layer, cryptoLayer, probe,
    Layer.succeed(RecallVectorCompactionThresholds, ${JSON.stringify(thresholds)}),
  )),
));
`;

/** A real child compaction, stopped by the release with SIGKILL when it still runs. */
const compactionChild = (home: string, mode: 'run' | 'stall') =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn([process.execPath, '--eval', childScript, home, mode], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      }),
    ),
    child =>
      Effect.promise(async () => {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      }),
  );
/**
 * Waits until the child's VACUUM runs: only VACUUM takes the SQLite write lock inside the unit, so an
 * immediate write transaction on an idle connection fails exactly while it runs.
 */
const awaitVacuum = (database: string, child: Bun.Subprocess<'ignore', 'ignore', 'pipe'>) =>
  Effect.gen(function* () {
    const probe = new Database(database);
    probe.exec('PRAGMA busy_timeout = 0');
    const vacuuming = () => {
      try {
        probe.exec('BEGIN IMMEDIATE');
        probe.exec('ROLLBACK');
        return false;
      } catch {
        return true;
      }
    };
    const deadline = (yield* Clock.currentTimeMillis) + 15_000;
    while (!vacuuming()) {
      if ((yield* Clock.currentTimeMillis) > deadline || child.exitCode !== null) {
        probe.close();
        const stderr = yield* Effect.promise(() => new Response(child.stderr).text());
        return yield* Effect.die(`compaction child never reached VACUUM: ${stderr}`);
      }
      yield* Effect.sleep('1 millis');
    }
    return {vacuuming, close: Effect.sync(() => probe.close())};
  });

/** A ready-read worker whose vector read fails validation, as a read that meets a held file does. */
const failingBoundary = RecallReadyReadBoundary.of({
  read: request =>
    Effect.succeed({
      protocol: 1 as const,
      binding: 'fixture',
      operation: request.operation,
      outcome: request.operation === 'vector-state' ? ('success' as const) : ('failed' as const),
      maintenanceRequested: false,
      observations: [],
      value: {readiness: 'corrupt'},
    }),
});

describe('vector database compaction', () => {
  effectIt.layer(services)(it => {
    it.effect('compacts to the live data, truncates the WAL beside an open reader and admits no build step', () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const reader = new Database(f.database, {readonly: true});
        yield* Effect.addFinalizer(() => Effect.sync(() => reader.close()));
        reader.query('SELECT count(*) FROM vector_chunks').get();
        const held = yield* heldCompaction(f.home);
        const events: string[] = [];
        const build = yield* withRecallVectorWrite(
          f.config,
          manifest,
          Effect.sync(() => events.push('build')),
        ).pipe(Effect.result, Effect.forkScoped);
        yield* Effect.sleep('300 millis');
        expect(events).toEqual([]);
        yield* held.release;
        const result = yield* Fiber.join(held.fiber);
        const built = yield* Fiber.join(build);
        // The build ran only after the compaction released the lock, or gave up waiting for it.
        if (built._tag === 'Failure') expect(Schema.is(FileLockTimeout)(built.failure)).toBe(true);
        else expect(events).toEqual(['build']);

        expect(result).toMatchObject({state: 'complete'});
        const size = Number((yield* f.fs.stat(f.database)).size);
        expect(size).toBeLessThanOrEqual(f.live.liveBytes * 1.25);
        // The reader keeps the WAL file; only the TRUNCATE checkpoint empties it while that connection is open.
        expect(yield* f.fs.exists(f.database + '-wal')).toBe(true);
        expect(yield* walBytes(f.fs, f.database)).toBe(0);
        expect(yield* vectorIndexStatus(f.home, manifest)).toMatchObject({
          ready: true,
          generation: f.ready.generation,
          chunkCount: f.ready.chunkCount,
        });
        expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.corpus)).toBe('current');
        expect(yield* readRecallVectorCompactionState(f.home, manifest.id)).toMatchObject({
          state: 'complete',
          afterBytes: size,
        });
        expect(yield* compact(f.home)).toEqual({state: 'skipped', reason: 'cooldown'});
      }).pipe(TestClock.withLive),
    );

    it.effect('defers on too little free disk space without touching the file, then waits out the cooldown', () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const before = Number((yield* f.fs.stat(f.database)).size);
        expect(yield* withProbe(() => Effect.succeed(0), runRecallVectorCompaction(f.home, manifest))).toEqual({
          state: 'deferred',
          reason: 'disk-space',
        });
        expect(Number((yield* f.fs.stat(f.database)).size)).toBe(before);
        expect(yield* integrity(f.database)).toBe('ok');
        expect(yield* vectorIndexStatus(f.home, manifest)).toMatchObject({ready: true, generation: f.ready.generation});
        const report = yield* recallVectorStorageReport(f.home, manifest.id);
        expect(report?.compaction).toMatchObject({state: 'deferred', reason: 'disk-space'});
        expect(report?.reclaimableBytes).toBe(f.live.reclaimableBytes);
        expect(yield* compact(f.home)).toEqual({state: 'skipped', reason: 'cooldown'});
        yield* TestClock.adjust('6 minutes');
        expect(yield* compact(f.home)).toMatchObject({state: 'complete'});
      }),
    );

    it.effect('applies the free-space rule to the SQLite temporary directory that holds the VACUUM copy', () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const temporary = yield* f.fs.realPath(yield* f.fs.makeTempDirectoryScoped({prefix: 'sqlite-tmp-'}));
        const real = yield* SystemInfo;
        const result = yield* runRecallVectorCompaction(f.home, manifest).pipe(
          Effect.provideService(SystemInfo, {
            ...real,
            environment: () => ({...real.environment(), SQLITE_TMPDIR: temporary}),
            availableDiskBytes: directory => Effect.succeed(directory === temporary ? 0 : Number.MAX_SAFE_INTEGER),
          }),
        );
        expect(result).toEqual({state: 'deferred', reason: 'disk-space'});
        expect(yield* integrity(f.database)).toBe('ok');
      }),
    );

    it.effect('records a failure after the running state with a reason and keeps the database valid', () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const exit = yield* withProbe(
          () => Effect.die('probe broke'),
          runRecallVectorCompaction(f.home, manifest),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* readRecallVectorCompactionState(f.home, manifest.id)).toMatchObject({
          state: 'failed',
          reason: 'unit-failed',
        });
        expect(yield* integrity(f.database)).toBe('ok');
        expect(yield* vectorIndexStatus(f.home, manifest)).toMatchObject({ready: true, generation: f.ready.generation});
      }),
    );

    it.effect('records a compaction killed during VACUUM as failed and keeps the database valid', () =>
      Effect.gen(function* () {
        const f = yield* fixture(640);
        const child = yield* compactionChild(f.home, 'run');
        const vacuum = yield* awaitVacuum(f.database, child);
        child.kill('SIGKILL');
        yield* Effect.promise(() => child.exited);
        yield* vacuum.close;

        expect(yield* integrity(f.database)).toBe('ok');
        expect(yield* readRecallVectorCompactionState(f.home, manifest.id)).toMatchObject({state: 'running'});
        // The stopped VACUUM never committed: the free pages are still there.
        expect(sqliteCompactionRecommendation(yield* readSqlitePageStorage(f.database), thresholds).recommended).toBe(
          true,
        );
        expect(yield* compact(f.home)).toEqual({state: 'failed', reason: 'interrupted'});
        expect(yield* recallVectorStorageReport(f.home, manifest.id)).toMatchObject({
          compaction: {state: 'failed', reason: 'interrupted'},
        });
        expect(yield* vectorIndexStatus(f.home, manifest)).toMatchObject({ready: true, generation: f.ready.generation});
        expect(yield* compact(f.home)).toEqual({state: 'skipped', reason: 'cooldown'});
      }).pipe(TestClock.withLive),
    );

    it.effect('records complete for a stopped unit whose VACUUM had committed', () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        expect(yield* compact(f.home)).toMatchObject({state: 'complete'});
        const state = f.path.join(f.path.dirname(f.database), 'compaction.json');
        yield* f.fs.writeFileString(state, JSON.stringify({version: 1, state: 'running', processId: 2 ** 30, at: 0}));
        expect(yield* compact(f.home)).toMatchObject({state: 'complete'});
        expect(yield* readRecallVectorCompactionState(f.home, manifest.id)).toMatchObject({state: 'complete'});
      }),
    );

    it.effect('serves a TS read path while a real VACUUM runs in another process', () =>
      Effect.gen(function* () {
        const f = yield* fixture(1200);
        const child = yield* compactionChild(f.home, 'run');
        const vacuum = yield* awaitVacuum(f.database, child);
        // WAL readers keep their snapshot during VACUUM, so the metadata read stays current and fast.
        const started = yield* Clock.currentTimeMillis;
        const readiness = yield* vectorIndexGenerationReadiness(f.home, manifest, f.corpus);
        const status = yield* vectorIndexStatus(f.home, manifest);
        const read = yield* withModels(loadMcpRecallSemanticScoresResult(f.config, 'compaction fixture', 5));
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        const overlapped = vacuum.vacuuming();
        yield* vacuum.close;
        yield* Effect.promise(() => child.exited);
        expect(overlapped).toBe(true);
        expect(readiness).toBe('current');
        expect(status).toMatchObject({ready: true, generation: f.ready.generation});
        expect(elapsed).toBeLessThan(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS);
        // Scores with the native reader; without it the scoring read fails, and the failure is the compaction's.
        if (read.status === 'available') expect(Option.isSome(read.result.scores)).toBe(true);
        else expect(Option.getOrUndefined(read.result.warning)).toBe(RECALL_SEMANTIC_COMPACTION_NOTICE);
        expect(yield* readRecallVectorCompactionState(f.home, manifest.id)).toMatchObject({state: 'complete'});
      }).pipe(TestClock.withLive),
    );

    it.effect('names the compaction in MCP and CLI reads that fail during it, and only then', () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const reads = Effect.gen(function* () {
          const mcp = yield* withModels(loadMcpRecallSemanticScoresResult(f.config, 'compaction fixture', 5));
          const cli = yield* withModels(loadRecallSemanticScoresResult(f.config, 'compaction fixture', 5));
          return {mcp, cli: Option.getOrUndefined(cli.warning)};
        }).pipe(Effect.provideService(RecallReadyReadBoundary, failingBoundary));
        const before = yield* reads;
        expect(before.mcp.result.warning).not.toEqual(Option.some(RECALL_SEMANTIC_COMPACTION_NOTICE));
        expect(before.cli).toContain('VectorIndexCorrupt');

        const held = yield* heldCompaction(f.home);
        const during = yield* reads;
        yield* held.release;
        yield* Fiber.join(held.fiber);
        expect(during.mcp).toMatchObject({status: 'unavailable'});
        expect(during.mcp.result.warning).toEqual(Option.some(RECALL_SEMANTIC_COMPACTION_NOTICE));
        expect(during.cli).toBe(RECALL_SEMANTIC_COMPACTION_NOTICE);
      }).pipe(TestClock.withLive),
    );

    it.effect('gives a mutation refresh the compaction notice during a compaction and the rebuild hint otherwise', () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const version = yield* sqlite(f.database, db =>
          db.query<{user_version: number}, []>('PRAGMA user_version').get(),
        );
        // A schema version the reader rejects makes the readiness `corrupt`, as a read that fails on the file does.
        const refreshWithCorruptReadiness = Effect.acquireUseRelease(
          sqlite(f.database, db => db.exec('PRAGMA user_version = 99')),
          () => withModels(refreshRecallDerivedIndexesFromSelection(f.config, [])),
          () => sqlite(f.database, db => db.exec(`PRAGMA user_version = ${version?.user_version ?? 0}`)),
        );
        const held = yield* heldCompaction(f.home);
        const during = yield* refreshWithCorruptReadiness;
        yield* held.release;
        expect(yield* Fiber.join(held.fiber)).toMatchObject({state: 'complete'});
        expect(during).toEqual({state: 'deferred', repair: RECALL_SEMANTIC_COMPACTION_NOTICE});
        expect(yield* refreshWithCorruptReadiness).toMatchObject({
          state: 'deferred',
          repair: expect.stringContaining('threadnote index rebuild'),
        });
      }).pipe(TestClock.withLive),
    );

    it.effect('answers in-process MCP and CLI recalls inside their time limit during a compaction', () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const held = yield* heldCompaction(f.home);
        const started = yield* Clock.currentTimeMillis;
        const mcp = yield* withModels(loadMcpRecallSemanticScoresResult(f.config, 'compaction fixture', 5));
        const cli = yield* withModels(loadRecallSemanticScoresResult(f.config, 'compaction fixture', 5));
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        yield* held.release;
        expect(yield* Fiber.join(held.fiber)).toMatchObject({state: 'complete'});
        expect(elapsed).toBeLessThan(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS);
        // Scores when the ready generation serves; otherwise the compaction notice, never a stale-index warning.
        if (mcp.status === 'available') expect(Option.isSome(mcp.result.scores)).toBe(true);
        else expect(mcp.result.warning).toEqual(Option.some(RECALL_SEMANTIC_COMPACTION_NOTICE));
        if (Option.isNone(cli.scores)) expect(cli.warning).toEqual(Option.some(RECALL_SEMANTIC_COMPACTION_NOTICE));
      }).pipe(TestClock.withLive),
    );

    it.effect('queues maintenance-only demand after one read of a file above the threshold', () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const demand = f.path.join(f.home, 'recall', 'vector-compaction-demand-v1', manifest.id + '.json');
        expect(yield* f.fs.exists(f.path.join(f.home, 'recall', 'embedding-demand-v1'))).toBe(false);
        yield* withModels(selectedSemanticScores(f.config, 'compaction fixture')).pipe(Effect.ignore);
        expect(yield* f.fs.exists(demand)).toBe(true);
      }),
    );
  });
});
