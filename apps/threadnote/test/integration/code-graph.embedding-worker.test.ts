import {TestError} from '@threadnote/testing/test-error';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {Database} from 'bun:sqlite';
import {existsSync} from '@threadnote/testing/node-fs';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  fixtureLayer,
  alternateManifest,
  seed,
  lanes,
  manifest,
  checkoutId,
  worktreeId,
  snapshotId,
} from '../fixtures/code-graph-embedding-worker-child.js';
import * as SqlClient from 'effect/sql/SqlClient';
import {enqueueCodeGraphEmbeddingDemandSql} from '@threadnote/graph/vector/demand';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphStore} from '@threadnote/graph/store';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {runtimeOpenTextDirectoryNameReader, SystemInfo} from '@threadnote/platform/system';
import {withCodeGraphDatabaseWriteLock} from '@threadnote/graph/maintenance/gate';

const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const childPath = new URL('../fixtures/code-graph-embedding-worker-child.ts', import.meta.url).pathname;
interface Event {
  event: string;
  pid: number;
  childPid?: number;
  inputs?: number;
  pool?: number;
  limit?: number;
  state?: string;
  modelId?: string;
}
const events = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(`${home}/events.jsonl`).pipe(Effect.orElseSucceed(() => ''));
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Event);
  });
const until = <R>(condition: Effect.Effect<boolean, unknown, R>, label = 'barrier', maximumAttempts = 400) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      if (yield* condition) return;
      yield* Effect.sleep(25);
    }
    return yield* TestError.make({message: `Embedding worker fixture did not reach ${label}.`});
  });
const startHost = (home: string) =>
  Effect.sync(() =>
    Bun.spawn({
      cmd: [process.execPath, childPath, '--wake', '--home', home],
      stdout: 'pipe',
      stderr: 'pipe',
      env: {...process.env},
    }),
  );
const startScopedHost = (home: string) =>
  Effect.gen(function* () {
    const child = yield* startHost(home);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }),
    );
    return child;
  });
const hostResult = (child: Effect.Success<ReturnType<typeof startHost>>) =>
  Effect.promise(async () => ({
    code: await child.exited,
    output: await new Response(child.stdout).text(),
    error: await new Response(child.stderr).text(),
  }));
const host = (home: string) =>
  Effect.acquireUseRelease(startHost(home), hostResult, child =>
    Effect.sync(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  );
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-detached-vector-worker-'});
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const records = yield* events(home);
      const ids = new Set(records.flatMap(record => (record.childPid ? [record.pid, record.childPid] : [record.pid])));
      for (const pid of ids)
        if (pid !== process.pid)
          yield* Effect.sync(() => {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* Fixture already exited. */
            }
          });
    }),
  );
  return home;
});
const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(provideTestLayer(fixtureLayer), TestClock.withLive);

effectIt.effect(
  'recovers committed demand without reindexing and duplicate hosts launch one actual worker with bounded isolated inference',
  () =>
    run(
      Effect.gen(function* () {
        const home = yield* fixture;
        const layout = yield* seed(home, 130);
        // The durable publication exists before either host has attempted a spawn.
        expect((yield* lanes(home))[0]?.state).toBe('queued');
        const results = yield* Effect.all([host(home), host(home)], {concurrency: 2});
        for (const result of results) {
          expect(result.error).toBe('');
          expect(result.code).toBe(0);
          expect(JSON.parse(result.output).ready).toBe(true);
        }
        yield* until(lanes(home).pipe(Effect.map(rows => rows[0]?.state === 'ready')));
        yield* Effect.sync(() => {
          const db = new Database(layout.databasePath);
          try {
            expect(db.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
          } finally {
            db.close();
          }
        });
        const records = yield* events(home);
        expect(records.filter(record => record.event === 'worker-ready')).toHaveLength(1);
        const calls = records.filter(record => record.event === 'inference');
        expect(calls).toHaveLength(5);
        let activeBatches = 0;
        let maximumBatches = 0;
        for (const event of records) {
          if (event.event === 'inference') maximumBatches = Math.max(maximumBatches, ++activeBatches);
          if (event.event === 'inference-finished') activeBatches -= 1;
        }
        expect(maximumBatches).toBe(1);
        expect(activeBatches).toBe(0);

        expect(calls.every(call => call.inputs! <= 32 && call.pool === 1)).toBe(true);
        expect(records.filter(record => record.event === 'symbol-page').every(record => record.limit! <= 400)).toBe(
          true,
        );
        yield* Effect.sync(() => {
          const db = new Database(`${layout.vectorRoot}/${manifest.id}/vectors-v2.sqlite`);
          try {
            expect(db.query('SELECT state, count FROM vector_generations').all()).toEqual([
              {state: 'ready', count: 130},
            ]);
            expect(db.query('SELECT COUNT(*) AS count FROM vector_pointers').get()).toEqual({count: 1});
          } finally {
            db.close();
          }
        });
      }),
    ),
  30_000,
);

effectIt.effect(
  'repairs attachment-before-acknowledgement after a real worker crash without embedding again',
  () =>
    run(
      Effect.gen(function* () {
        const home = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        yield* seed(home, 2);
        yield* fs.writeFileString(`${home}/crash-after-attach`, '');
        expect((yield* host(home)).code).toBe(0);
        yield* until(events(home).pipe(Effect.map(records => records.some(record => record.event === 'attached'))));
        const callsBefore = (yield* events(home)).filter(record => record.event === 'inference').length;
        expect((yield* lanes(home))[0]?.state).not.toBe('ready');
        yield* fs.remove(`${home}/crash-after-attach`);
        expect((yield* host(home)).code).toBe(0);
        yield* until(lanes(home).pipe(Effect.map(rows => rows[0]?.state === 'ready')));
        expect((yield* events(home)).filter(record => record.event === 'inference')).toHaveLength(callsBefore);
      }),
    ),
  30_000,
);

effectIt.effect(
  'times out a real isolated model child, records a durable failure, and releases its process',
  () =>
    run(
      Effect.gen(function* () {
        const home = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        yield* seed(home, 2);
        yield* fs.writeFileString(`${home}/hang-model`, '');
        expect((yield* host(home)).code).toBe(0);
        yield* until(lanes(home).pipe(Effect.map(rows => rows[0]?.attempt === 1)));
        const [lane] = yield* lanes(home);
        expect(lane).toMatchObject({state: 'deferred', attempt: 1});
        expect(lane.notBefore).toBeGreaterThan(0);
        const spawned = (yield* events(home)).filter(record => record.event === 'model-spawn');
        expect(spawned).toHaveLength(1);
        yield* until(Effect.sync(() => spawned.every(child => !system.isProcessRunning(child.childPid!))));
      }),
    ),
  30_000,
);

for (const barrier of ['ready', 'claim', 'checkpoint'] as const) {
  effectIt.effect(
    `recovers a process killed after ${barrier} with recorded demand and no new graph index`,
    () =>
      run(
        Effect.gen(function* () {
          const home = yield* fixture;
          const fs = yield* FileSystem.FileSystem;
          yield* seed(home, 65);
          yield* fs.writeFileString(`${home}/crash-after-${barrier}`, '');
          expect((yield* host(home)).code).toBe(0);
          yield* until(
            events(home).pipe(
              Effect.map(records =>
                records.some(
                  record =>
                    record.event ===
                    (barrier === 'ready' ? 'worker-ready' : barrier === 'claim' ? 'claimed' : 'checkpoint'),
                ),
              ),
            ),
          );
          yield* fs.remove(`${home}/crash-after-${barrier}`);
          expect((yield* host(home)).code).toBe(0);
          yield* until(lanes(home).pipe(Effect.map(rows => rows[0]?.state === 'ready')));
          const inputs = (yield* events(home))
            .filter(record => record.event === 'inference')
            .reduce((total, event) => total + event.inputs!, 0);
          expect(inputs).toBe(65);
        }),
      ),
    30_000,
  );
}
effectIt.effect(
  'blocks missing models without downloads or inference and keeps structural evidence available',
  () =>
    run(
      Effect.gen(function* () {
        const home = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        const layout = yield* seed(home, 2);
        yield* fs.writeFileString(`${home}/missing-model`, '');
        expect((yield* host(home)).code).toBe(0);
        yield* until(lanes(home).pipe(Effect.map(rows => rows[0]?.state === 'blocked')));
        const worker = (yield* events(home)).find(record => record.event === 'worker-ready')!;
        const system = yield* SystemInfo;
        yield* until(
          Effect.sync(() => !system.isProcessRunning(worker.pid)),
          'blocked worker idle exit',
        );
        expect(
          (yield* events(home)).filter(record => record.event === 'inference' || record.event === 'download'),
        ).toEqual([]);
        expect((yield* store.readySnapshot(layout.databasePath, worktreeId))?.id).toBe(snapshotId);
        expect(yield* fs.exists(`${layout.vectorRoot}/${manifest.id}/vectors-v2.sqlite`)).toBe(false);
        yield* store.withSession(
          layout.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe('UPDATE embedding_demand SET not_before = 0 WHERE worktree_id = ?', [worktreeId]);
          }),
        );
        const secondWake = yield* host(home);
        expect(secondWake.code).toBe(0);
        expect(JSON.parse(secondWake.output).ready).toBe(true);
        const workers = (yield* events(home)).filter(record => record.event === 'worker-ready');
        expect(workers).toHaveLength(2);
        const secondWorker = workers[1];
        expect(secondWorker.pid).not.toBe(worker.pid);
        yield* until(
          Effect.sync(() => !system.isProcessRunning(secondWorker.pid)),
          'second blocked-lane worker idle exit',
          80,
        );
        expect((yield* lanes(home))[0]).toMatchObject({state: 'blocked', notBefore: 0});
      }),
    ),
  30_000,
);
effectIt.effect(
  'defers a claimed lane behind a busy writer gate while a healthy second catalog completes',
  () =>
    run(
      Effect.gen(function* () {
        const home = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const healthyCheckout = 'd'.repeat(64);
        yield* seed(home, 2);
        const healthy = yield* seed(home, 2, healthyCheckout, 'e'.repeat(64));
        yield* fs.writeFileString(`${home}/catalog.json`, JSON.stringify([checkoutId, healthyCheckout]));
        yield* fs.writeFileString(`${home}/pause-after-claim`, '');
        yield* fs.writeFileString(`${home}/skip-model-lock`, '');
        const child = yield* startScopedHost(home);
        yield* until(events(home).pipe(Effect.map(rows => rows.some(row => row.event === 'claimed'))));
        yield* withCodeGraphDatabaseWriteLock(
          home,
          checkoutId,
          Effect.gen(function* () {
            yield* fs.remove(`${home}/pause-after-claim`);
            yield* until(
              store.withSession(
                healthy.databasePath,
                Effect.gen(function* () {
                  const rows = yield* (yield* SqlClient.SqlClient).unsafe<{state: string}>(
                    'SELECT state FROM embedding_demand',
                  );
                  return rows[0]?.state === 'ready';
                }),
                {readOnly: true},
              ),
              'healthy second catalog while first writer gate is held',
            );
            const results = yield* events(home);
            expect(results.some(row => row.event === 'unit-result' && row.state === 'deferred')).toBe(true);
          }),
          20_000,
        );
        const completed = yield* hostResult(child);
        expect(completed.code).toBe(0);
        const firstLayout = codeGraphLayout(path, home, checkoutId, worktreeId);
        yield* until(
          store.withSession(
            firstLayout.databasePath,
            Effect.gen(function* () {
              const rows = yield* (yield* SqlClient.SqlClient).unsafe<{state: string}>(
                'SELECT state FROM embedding_demand',
              );
              return rows[0]?.state === 'ready';
            }),
            {readOnly: true},
          ),
          'contended lane recovery after writer release',
        );
      }),
    ),
  30_000,
);
effectIt.effect(
  'rebinds an in-flight current view from model A to B and publishes no pointer for A',
  () =>
    run(
      Effect.gen(function* () {
        const home = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const catalog = yield* LocalModelCatalog;
        const layout = yield* seed(home, 2);
        yield* fs.writeFileString(`${home}/pause-model-batch`, '');
        const child = yield* startScopedHost(home);
        yield* until(
          events(home).pipe(
            Effect.map(rows => rows.some(row => row.event === 'inference' && row.modelId === manifest.id)),
          ),
          'model A inference barrier',
        );
        yield* selectLocalModel(home, catalog, 'embedding', alternateManifest.id);
        yield* fs.remove(`${home}/pause-model-batch`);
        const completed = yield* hostResult(child);
        expect(completed.code).toBe(0);
        yield* until(lanes(home).pipe(Effect.map(rows => rows[0]?.state === 'ready')));
        expect((yield* lanes(home))[0]?.model).toMatchObject({
          id: alternateManifest.id,
          sha256: alternateManifest.sha256,
        });
        yield* Effect.sync(() => {
          const oldPath = `${layout.vectorRoot}/${manifest.id}/vectors-v2.sqlite`;
          if (existsSync(oldPath)) {
            const db = new Database(oldPath);
            try {
              expect(db.query('SELECT COUNT(*) AS count FROM vector_pointers').get()).toEqual({count: 0});
              expect(db.query('SELECT COUNT(*) AS count FROM vectors').get()).toEqual({count: 0});
            } finally {
              db.close();
            }
          }
          const db = new Database(`${layout.vectorRoot}/${alternateManifest.id}/vectors-v2.sqlite`);
          try {
            expect(db.query('SELECT COUNT(*) AS count FROM vector_pointers').get()).toEqual({count: 1});
          } finally {
            db.close();
          }
        });
        expect((yield* events(home)).filter(row => row.event === 'inference').map(row => row.modelId)).toEqual([
          manifest.id,
          alternateManifest.id,
        ]);
      }),
    ),
  30_000,
);
effectIt.effect(
  'cancels an explicitly removed view without reviving its snapshot or starting inference',
  () =>
    run(
      Effect.gen(function* () {
        const home = yield* fixture;
        const store = yield* CodeGraphStore;
        const layout = yield* seed(home, 2);
        yield* store.removeView(layout.databasePath, worktreeId, snapshotId);
        expect((yield* host(home)).code).toBe(0);
        yield* until(lanes(home).pipe(Effect.map(rows => rows[0]?.state === 'cancelled')));
        expect(
          (yield* events(home)).filter(record => record.event === 'inference' || record.event === 'download'),
        ).toEqual([]);
        expect(yield* store.readySnapshot(layout.databasePath, worktreeId)).toBeUndefined();
      }),
    ),
  30_000,
);

effectIt.effect(
  'denied persistence preserves queued demand and vectors, exits without spinning, and resumes after capacity recovery',
  () =>
    run(
      Effect.gen(function* () {
        const home = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        const layout = yield* seed(home, 2);
        expect((yield* host(home)).code).toBe(0);
        yield* until(lanes(home).pipe(Effect.map(rows => rows[0]?.state === 'ready')));
        const readyWorker = (yield* events(home)).find(record => record.event === 'worker-ready')!;
        const system = yield* SystemInfo;
        yield* until(
          Effect.sync(() => !system.isProcessRunning(readyWorker.pid)),
          'original worker exit',
        );
        const payload = () => {
          const db = new Database(`${layout.vectorRoot}/${manifest.id}/vectors-v2.sqlite`);
          try {
            return db
              .query('SELECT generation, symbol_id, hex(vector) AS vector FROM vectors ORDER BY symbol_id')
              .all();
          } finally {
            db.close();
          }
        };
        const before = yield* Effect.sync(payload);
        const activation = iso((yield* Clock.currentTimeMillis) + 1);
        yield* store.withSession(
          layout.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe('UPDATE active_snapshots SET activated_at = ? WHERE worktree_id = ?', [
              activation,
              worktreeId,
            ]);
            yield* enqueueCodeGraphEmbeddingDemandSql(sql, {worktreeId, snapshotId, activatedAt: activation});
          }),
        );
        yield* fs.writeFileString(`${home}/disk-denied`, '');
        expect((yield* host(home)).code).toBe(0);
        const deniedWorker = (yield* events(home)).filter(record => record.event === 'worker-ready').at(-1)!;
        yield* until(
          Effect.sync(() => !system.isProcessRunning(deniedWorker.pid)),
          'capacity-denied worker idle exit',
        );
        expect((yield* lanes(home))[0]).toMatchObject({state: 'queued', attempt: 0, notBefore: 0});
        expect((yield* events(home)).some(record => record.event === 'unit-result' && record.state === 'blocked')).toBe(
          true,
        );
        const callsBeforeRecovery = (yield* events(home)).filter(record => record.event === 'inference').length;
        expect(callsBeforeRecovery).toBe(1);
        expect(yield* Effect.sync(payload)).toEqual(before);
        expect((yield* store.readySnapshot(layout.databasePath, worktreeId))?.id).toBe(snapshotId);
        yield* fs.remove(`${home}/disk-denied`);
        expect((yield* host(home)).code).toBe(0);
        yield* until(
          lanes(home).pipe(Effect.map(rows => rows[0]?.state === 'ready')),
          'same recorded demand after capacity recovery',
        );
        expect((yield* events(home)).filter(record => record.event === 'inference')).toHaveLength(callsBeforeRecovery);
      }),
    ),
  30_000,
);

effectIt.effect(
  'services every lane beyond the first demand page and adopts one shared ready generation without repeated inference',
  () =>
    run(
      Effect.gen(function* () {
        const home = yield* fixture;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const layout = yield* seed(home, 2);
        for (let n = 1; n <= 65; n++) {
          const sibling = n.toString(16).padStart(64, '0');
          yield* store.promote(
            layout.databasePath,
            {
              caseMode: 'sensitive',
              checkoutId,
              worktreeId: sibling,
              displayName: 'sibling',
              gitCommonDirectory: home,
              headCommit: 'c'.repeat(40),
              objectFormat: 'sha1',
              repoRoot: home,
              repositoryId: checkoutId,
            },
            snapshotId,
          );
          yield* store.withSession(
            layout.databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const [active] = yield* sql.unsafe<{activated_at: string}>(
                'SELECT activated_at FROM active_snapshots WHERE worktree_id = ?',
                [sibling],
              );
              yield* enqueueCodeGraphEmbeddingDemandSql(sql, {
                worktreeId: sibling,
                snapshotId,
                activatedAt: active.activated_at,
              });
            }),
          );
        }
        expect((yield* host(home)).code).toBe(0);
        yield* until(
          store.withSession(
            layout.databasePath,
            Effect.gen(function* () {
              const rows = yield* (yield* SqlClient.SqlClient).unsafe<{count: number}>(
                "SELECT COUNT(*) AS count FROM embedding_demand WHERE state = 'ready'",
              );
              return rows[0].count === 66;
            }),
            {readOnly: true},
          ),
          'all66 finite lanes ready',
          1200,
        );
        expect((yield* events(home)).filter(record => record.event === 'inference')).toHaveLength(1);
        yield* Effect.sync(() => {
          const root = codeGraphLayout(path, home, checkoutId, worktreeId).vectorRoot;
          const db = new Database(`${root}/${manifest.id}/vectors-v2.sqlite`);
          try {
            expect(db.query('SELECT COUNT(*) AS count FROM vector_pointers').get()).toEqual({count: 66});
            expect(db.query('SELECT COUNT(*) AS count FROM vector_generations').get()).toEqual({count: 1});
          } finally {
            db.close();
          }
        });
      }),
    ),
  60_000,
);

effectIt.effect(
  'reads real catalog directories after the64-row boundary with scoped reader cleanup',
  () =>
    run(
      Effect.gen(function* () {
        const home = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        for (let n = 0; n < 130; n++) yield* fs.makeDirectory(`${home}/directory-${n.toString().padStart(3, '0')}`);
        yield* fs.writeFileString(`${home}/ordinary-file`, '');
        const names = yield* Effect.acquireUseRelease(
          Effect.promise(() => runtimeOpenTextDirectoryNameReader(home)),
          reader =>
            Effect.gen(function* () {
              const found: string[] = [];
              for (let turn = 0; turn < 10; turn++) {
                const page = yield* Effect.promise(() => reader.readPage(64));
                expect(page.names.length).toBeLessThanOrEqual(64);
                found.push(...page.names);
                if (page.done) return found;
              }
              return yield* TestError.make({message: 'Directory reader failed to finish its finite catalog.'});
            }),
          reader => Effect.promise(() => reader.close()),
        );
        expect(new Set(names).size).toBe(130);
        expect(names.sort()).toEqual(Array.from({length: 130}, (_, n) => `directory-${n.toString().padStart(3, '0')}`));
      }),
    ),
  10_000,
);

effectIt.effect(
  'contains an unsupported catalog schema while progressing a healthy recorded lane',
  () =>
    run(
      Effect.gen(function* () {
        const home = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        const unsupported = yield* seed(home, 2);
        const healthyId = 'd'.repeat(64);
        const healthy = yield* seed(home, 2, healthyId);
        yield* fs.writeFileString(`${home}/catalog.json`, JSON.stringify([checkoutId, healthyId]));
        yield* Effect.sync(() => {
          const db = new Database(unsupported.databasePath);
          try {
            db.exec("UPDATE schema_metadata SET value = '999' WHERE key = 'persistent_extension_schema_revision'");
          } finally {
            db.close();
          }
        });
        expect((yield* host(home)).code).toBe(0);
        yield* until(
          store.withSession(
            healthy.databasePath,
            Effect.gen(function* () {
              return (
                (yield* (yield* SqlClient.SqlClient).unsafe<{state: string}>('SELECT state FROM embedding_demand'))[0]
                  .state === 'ready'
              );
            }),
            {readOnly: true},
          ),
          'healthy lane behind unsupported catalog',
        );
        yield* Effect.sync(() => {
          const db = new Database(unsupported.databasePath);
          try {
            expect(
              db.query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'").get(),
            ).toEqual({value: '999'});
            expect(db.query('SELECT state, active_json FROM embedding_demand').all()).toEqual([
              {state: 'queued', active_json: null},
            ]);
          } finally {
            db.close();
          }
        });
      }),
    ),
  30_000,
);
