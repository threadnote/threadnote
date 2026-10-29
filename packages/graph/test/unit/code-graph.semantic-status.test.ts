import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Deferred, Effect, FileSystem, Fiber, Path, Schema} from 'effect';
import {expect, it} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import {codeGraphLayout} from '../../src/layout.js';
import type {CodeGraphEmbeddingCheck} from '../../src/embedding.js';
import {CodeGraphSemanticStatusSchema, type CodeGraphSnapshot} from '../../src/types.js';
import {CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL} from '../../src/vector/demand.js';
import {
  CODE_GRAPH_SEMANTIC_STATUS_TIMEOUT_MILLISECONDS,
  observeCodeGraphSemanticStatus,
} from '../../src/vector/status.js';
import {TestClock} from 'effect/testing';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const snapshot: CodeGraphSnapshot = {
  id: `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`,
  worktreeId: Effect2.pipe('b', EffectString.repeat(64)),
  commit: Effect2.pipe('c', EffectString.repeat(40)),
  dirty: false,
  edgeCount: 0,
  fileCount: 1,
  symbolCount: 3,
  extractorSet: 'fixture',
  repositoryId: 'repository',
  state: 'ready',
};
const epoch = '2026-01-01T00:00:00.000Z';
const fixture = (version = 19) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'semantic-status-'});
    const layout = codeGraphLayout(path, home, Effect2.pipe('a', EffectString.repeat(64)), snapshot.worktreeId);
    yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true});
    yield* Effect.sync(() => {
      const db = new Database(layout.databasePath);
      try {
        db.run('CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT)');
        db.run('INSERT INTO schema_metadata VALUES (?, ?)', ['persistent_extension_schema_revision', String(version)]);
        db.run('CREATE TABLE snapshots (id TEXT PRIMARY KEY, scope_id TEXT, state TEXT)');
        db.run('CREATE TABLE active_snapshots (worktree_id TEXT, scope_id TEXT, snapshot_id TEXT, activated_at TEXT)');
        db.run('CREATE TABLE removed_views (worktree_id TEXT, scope_id TEXT, expected_snapshot_id TEXT)');
        db.run("INSERT INTO snapshots VALUES (?, 'full-repository', 'ready')", [snapshot.id]);
        db.run("INSERT INTO active_snapshots VALUES (?, 'full-repository', ?, ?)", [
          snapshot.worktreeId,
          snapshot.id,
          epoch,
        ]);
        if (version === 19) db.run(CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL);
      } finally {
        db.close();
      }
    });
    const update = (sql: string, parameters: (string | number | null)[] = []) =>
      Effect.sync(() => {
        const db = new Database(layout.databasePath);
        try {
          db.run(sql, parameters);
        } finally {
          db.close();
        }
      });
    const demand = (
      state: string,
      options: {reason?: string; notBefore?: number; activatedAt?: string; active?: unknown} = {},
    ) =>
      update('INSERT OR REPLACE INTO embedding_demand VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        snapshot.worktreeId,
        'full-repository',
        snapshot.id,
        options.activatedAt ?? epoch,
        state,
        0,
        options.notBefore ?? 0,
        options.reason ?? null,
        null,
        options.active ? JSON.stringify(options.active) : null,
      ]);
    const observe = (check: CodeGraphEmbeddingCheck = {state: 'stale', reason: 'missing'}) =>
      observeCodeGraphSemanticStatus({
        threadnoteHome: home,
        layout,
        snapshot,
        embedding: {check: () => Effect.succeed(check)},
      });
    return {fs, home, layout, update, demand, observe};
  });

effectIt.layer(citationPlatformLayer)(it => {
  it.effect('leaves revision 18 without demand not-requested and byte-for-byte unchanged', () =>
    Effect.gen(function* () {
      const {fs, layout, observe} = yield* fixture(18);
      const before = yield* fs.readFile(layout.databasePath);
      expect(yield* observe()).toEqual({state: 'not-requested', snapshotId: snapshot.id});
      expect(yield* fs.readFile(layout.databasePath)).toEqual(before);
    }),
  );
  it.effect('never promotes a recorded ready lane when the selected model generation changed', () =>
    Effect.gen(function* () {
      const {demand, observe} = yield* fixture();
      yield* demand('ready');
      expect(yield* observe()).toMatchObject({state: 'deferred', reason: 'selected-generation-not-ready'});
      expect(yield* observe({state: 'ready', modelId: 'selected', reused: 3})).toMatchObject({
        state: 'ready',
        modelId: 'selected',
        completedSymbols: 3,
      });
    }),
  );
  it.effect('reports persisted capacity block even when model is unavailable, without writes', () =>
    Effect.gen(function* () {
      const {demand, observe, fs, layout} = yield* fixture();
      yield* demand('blocked', {reason: 'physicaldisk0'});
      const before = yield* fs.readFile(layout.databasePath);
      expect(yield* observe({state: 'unavailable', reason: 'no model'})).toMatchObject({
        state: 'blocked',
        reason: 'physicaldisk0',
      });
      expect(yield* fs.readFile(layout.databasePath)).toEqual(before);
    }),
  );
  it.effect('reports physical zero even when admission prevented persisting a blocked lane', () =>
    Effect.gen(function* () {
      const {demand, observe, fs, layout} = yield* fixture();
      yield* demand('queued');
      const before = yield* fs.readFile(layout.databasePath);
      const system = yield* SystemInfo;
      expect(
        yield* observe().pipe(
          Effect.provideService(SystemInfo, {...system, availableDiskBytes: () => Effect.succeed(0)}),
        ),
      ).toMatchObject({state: 'blocked', reason: 'disk-capacity-unavailable'});
      expect(yield* fs.readFile(layout.databasePath)).toEqual(before);
    }),
  );
  it.effect('keeps recorded demand unavailable when no selected model is available', () =>
    Effect.gen(function* () {
      const {demand, observe} = yield* fixture();
      yield* demand('queued');
      expect(yield* observe({state: 'unavailable', reason: 'missing model'})).toMatchObject({
        state: 'unavailable',
        reason: 'selected-model-unavailable',
      });
    }),
  );
  it.effect('reports live ownership and bounded attempts, then deferred after lease expiry', () =>
    Effect.gen(function* () {
      const {demand, observe} = yield* fixture();
      const active = {
        worktreeId: snapshot.worktreeId,
        scopeId: 'full-repository',
        snapshotId: snapshot.id,
        activatedAt: epoch,
        owner: {token: 'owner', processId: 123, processStartIdentity: 'process'},
        model: {id: 'model', sha256: Effect2.pipe('a', EffectString.repeat(64)), dimensions: 2, templateVersion: 1},
        expiresAt: 1000,
      };
      yield* demand('building', {active});
      expect(yield* observe()).toMatchObject({state: 'embedding', attempt: 0});
      yield* demand('building', {active: {...active, expiresAt: 0}});
      expect(yield* observe()).toMatchObject({state: 'deferred', reason: 'worker-lease-expired'});
    }),
  );
  it.effect('times out optional metadata and releases interrupted observation resources', () =>
    Effect.gen(function* () {
      const {fs, layout, home} = yield* fixture();
      const started = yield* Deferred.make<void>();
      let released = false;
      const before = yield* fs.readFile(layout.databasePath);
      const observation = observeCodeGraphSemanticStatus({
        threadnoteHome: home,
        layout,
        snapshot,
        embedding: {
          check: () =>
            Effect.acquireUseRelease(
              Deferred.succeed(started, undefined),
              () => Effect.never,
              () =>
                Effect.sync(() => {
                  released = true;
                }),
            ),
        },
      });
      const pending = yield* observation.pipe(Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(started);
      yield* TestClock.adjust(CODE_GRAPH_SEMANTIC_STATUS_TIMEOUT_MILLISECONDS);
      expect(yield* Fiber.join(pending)).toMatchObject({
        state: 'unavailable',
        reason: 'semantic-observation-timed-out',
      });
      expect(released).toBe(true);
      expect(yield* fs.readFile(layout.databasePath)).toEqual(before);
    }),
  );
  it.effect('keeps unknown schema unavailable rather than ready', () =>
    Effect.gen(function* () {
      const {observe, fs, layout} = yield* fixture(20);
      const before = yield* fs.readFile(layout.databasePath);
      expect(yield* observe({state: 'ready', modelId: 'selected', reused: 3})).toMatchObject({state: 'unavailable'});
      expect(yield* fs.readFile(layout.databasePath)).toEqual(before);
    }),
  );
  it.effect('fences stale demand epochs and a superseded vector observation', () =>
    Effect.gen(function* () {
      const {demand, observe, update, home, layout} = yield* fixture();
      yield* demand('queued', {activatedAt: '2025-01-01T00:00:00.000Z'});
      expect(yield* observe()).toMatchObject({state: 'not-requested'});
      const result = yield* observeCodeGraphSemanticStatus({
        threadnoteHome: home,
        layout,
        snapshot,
        embedding: {
          check: () =>
            update("UPDATE active_snapshots SET activated_at='2026-02-01T00:00:00.000Z'").pipe(
              Effect.as({state: 'ready', modelId: 'selected', reused: 3} as const),
            ),
        },
      });
      expect(result).toMatchObject({state: 'unavailable', reason: 'selected-view-changed'});
    }),
  );
  it.effect.prop(
    'repeated lane observations are deterministic, bounded, and do not mutate storage',
    {
      state: Schema.Literals(['queued', 'deferred', 'blocked']),
      retryAt: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 100000})),
      reason: Schema.String.check(Schema.isMaxLength(64)),
    },
    ({state, retryAt, reason}) =>
      Effect.gen(function* () {
        const {demand, observe, fs, layout} = yield* fixture();
        yield* demand(state, {
          notBefore: retryAt,
          reason: Effect2.pipe(reason, EffectString.replaceAll('\0', '')) || 'fixture',
        });
        const before = yield* fs.readFile(layout.databasePath);
        const first = yield* observe();
        expect(first.state).toBe(state);
        expect(yield* observe()).toEqual(first);
        expect(first.reason?.length ?? 0).toBeLessThanOrEqual(512);
        expect(yield* fs.readFile(layout.databasePath)).toEqual(before);
      }),
    {arbitrary: {runs: 20}},
  );
});

it('decodes legacy receipts without semantic and bounds optional semantic metadata', () => {
  const receipt = Schema.Struct({semantic: Schema.optionalKey(CodeGraphSemanticStatusSchema)});
  expect(Schema.decodeSync(receipt)({})).toEqual({});
  expect(
    Schema.decodeSync(receipt)({
      semantic: {state: 'queued', snapshotId: snapshot.id, attempt: 0, retryAt: 1000},
    }),
  ).toEqual({semantic: {state: 'queued', snapshotId: snapshot.id, attempt: 0, retryAt: 1000}});
  expect(() => Schema.decodeSync(receipt)({semantic: {state: 'ready', completedSymbols: -1}})).toThrow();
  expect(() =>
    Schema.decodeSync(receipt)({semantic: {state: 'blocked', reason: Effect2.pipe('x', EffectString.repeat(513))}}),
  ).toThrow();
});
