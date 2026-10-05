import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Clock, Effect} from 'effect';
import * as FC from 'fast-check';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect, vi} from 'vitest';
import {releaseSnapshotLease} from '@threadnote/graph/store/leases';
import {initializeSchema} from '@threadnote/graph/store/schema/initialization';
import {CODE_GRAPH_EXTRACTOR_GENERATION} from '@threadnote/graph/types';
import {provideTestLayer} from '../helpers/effect-layer.js';

const SNAPSHOT = 'cgsn_1111111111111111111111111111111111111111';
const EXPIRED_SNAPSHOT = 'cgsn_2222222222222222222222222222222222222222';
const WORKTREE = 'c'.repeat(64);
// Scoped authority inspects its immutable definitions through sqlite_master;
// the narrow lease path only checks lease/snapshot authority and never emits
// this parameterized definition lookup.
const cleanupObservation = (query: string) =>
  query.includes('FROM sqlite_master WHERE name = ? COLLATE NOCASE LIMIT 2');

describe('snapshot lease retirement authority', () => {
  effectIt.effect('skips unused full retirement observations for clean and already released leases', () =>
    withFixture(sql =>
      Effect.gen(function* () {
        yield* seedLease(sql, 'clean', SNAPSHOT, false);
        const queries = yield* observeQueries();
        expect(yield* releaseSnapshotLease('clean')).toBe(false);
        expect(queries.filter(cleanupObservation)).toHaveLength(0);
        expect(queries.some(query => query.includes("pragma_table_xinfo('snapshot_leases')"))).toBe(true);
        expect(queries.some(query => query.includes('WHERE lease.expires_at <= ?'))).toBe(true);
        queries.length = 0;
        expect(yield* releaseSnapshotLease('clean')).toBe(false);
        expect(queries.filter(cleanupObservation)).toHaveLength(0);
        expect(yield* snapshotState(sql)).toBe('ready');
        expect(yield* sql`SELECT token FROM snapshot_leases`).toEqual([]);
      }),
    ),
  );

  effectIt.effect('checks full authority only when the final retirement baton has no successor', () =>
    withFixture(sql =>
      Effect.gen(function* () {
        yield* seedLease(sql, 'first', SNAPSHOT, true);
        yield* seedLease(sql, 'last', SNAPSHOT, false, 120_000);
        const queries = yield* observeQueries();
        expect(yield* releaseSnapshotLease('first')).toBe(false);
        expect(queries.filter(cleanupObservation)).toHaveLength(0);
        expect(yield* sql`SELECT token, retire_when_inactive FROM snapshot_leases`).toEqual([
          {retire_when_inactive: 1, token: 'last'},
        ]);
        queries.length = 0;
        expect(yield* releaseSnapshotLease('last')).toBe(true);
        expect(queries.some(cleanupObservation)).toBe(true);
        expect(yield* snapshotState(sql)).toBe('retired');
      }),
    ),
  );

  for (const mutation of [
    'ALTER TABLE removed_view_cleanup ADD COLUMN unexpected TEXT',
    'DROP INDEX snapshots_base_state_id',
  ]) {
    effectIt.effect(`does not retire without current full authority: ${mutation}`, () =>
      withFixture(sql =>
        Effect.gen(function* () {
          yield* seedLease(sql, 'last', SNAPSHOT, true);
          yield* sql.unsafe(mutation);
          const queries = yield* observeQueries();
          expect(yield* releaseSnapshotLease('last')).toBe(false);
          expect(queries.some(cleanupObservation)).toBe(true);
          expect(yield* snapshotState(sql)).toBe('ready');
          expect(yield* sql`SELECT token FROM snapshot_leases`).toEqual([]);
        }),
      ),
    );
  }

  effectIt.effect('keeps narrow authority and malformed lease failures non-mutating', () =>
    withFixture(sql =>
      Effect.gen(function* () {
        yield* seedLease(sql, 'clean', SNAPSHOT, false);
        yield* sql`DROP INDEX snapshot_leases_expiry`;
        expect(yield* Effect.flip(releaseSnapshotLease('clean'))).toMatchObject({
          _tag: 'CodeGraphStoreError',
          message: 'Code graph snapshot lease authority schema is invalid.',
        });
        expect(yield* sql`SELECT token FROM snapshot_leases`).toEqual([{token: 'clean'}]);
        expect(yield* snapshotState(sql)).toBe('ready');
        yield* sql`CREATE INDEX snapshot_leases_expiry ON snapshot_leases(expires_at)`;
        yield* sql`UPDATE snapshot_leases SET expires_at = 'invalid' WHERE token = 'clean'`;
        expect(yield* Effect.flip(releaseSnapshotLease('clean'))).toMatchObject({
          _tag: 'CodeGraphStoreError',
          message: 'Code graph snapshot lease manifest is invalid.',
        });
        expect(yield* sql`SELECT token, expires_at FROM snapshot_leases`).toEqual([
          {expires_at: 'invalid', token: 'clean'},
        ]);
        expect(yield* snapshotState(sql)).toBe('ready');
      }),
    ),
  );

  effectIt.effect('ignores partial cleanup-trigger sets during ordinary lease release', () =>
    withFixture(sql =>
      Effect.gen(function* () {
        yield* seedLease(sql, 'clean', SNAPSHOT, false);
        const trigger = yield* sql<{readonly name: string}>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'trigger' AND tbl_name = 'removed_views'
          ORDER BY name
          LIMIT 1
        `;
        expect(trigger[0]?.name).toBeDefined();
        yield* sql.unsafe(`DROP TRIGGER "${trigger[0]?.name?.replaceAll('"', '""')}"`);
        const queries = yield* observeQueries();
        expect(yield* releaseSnapshotLease('clean')).toBe(false);
        expect(queries.filter(cleanupObservation)).toHaveLength(0);
        expect(yield* snapshotState(sql)).toBe('ready');
        expect(yield* sql`SELECT token FROM snapshot_leases`).toEqual([]);
      }),
    ),
  );

  effectIt.effect('ignores malformed cleanup triggers during ordinary lease release', () =>
    withFixture(sql =>
      Effect.gen(function* () {
        yield* seedLease(sql, 'clean', SNAPSHOT, false);
        const trigger = yield* sql<{readonly name: string}>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'trigger' AND tbl_name = 'removed_views'
          ORDER BY name
          LIMIT 1
        `;
        const name = trigger[0]?.name;
        expect(name).toBeDefined();
        const escapedName = name?.replaceAll('"', '""');
        yield* sql.unsafe(`DROP TRIGGER "${escapedName}"`);
        yield* sql.unsafe(`CREATE TRIGGER "${escapedName}" AFTER INSERT ON removed_views BEGIN SELECT 1; END`);
        const queries = yield* observeQueries();
        expect(yield* releaseSnapshotLease('clean')).toBe(false);
        expect(queries.filter(cleanupObservation)).toHaveLength(0);
        expect(yield* snapshotState(sql)).toBe('ready');
        expect(yield* sql`SELECT token FROM snapshot_leases`).toEqual([]);
      }),
    ),
  );

  effectIt.effect('retains independent expired-page retirement during an ordinary release', () =>
    withFixture(sql =>
      Effect.gen(function* () {
        yield* seedSnapshot(sql, EXPIRED_SNAPSHOT);
        yield* seedLease(sql, 'clean', SNAPSHOT, false);
        yield* seedLease(sql, 'expired', EXPIRED_SNAPSHOT, true, 0);
        const queries = yield* observeQueries();
        expect(yield* releaseSnapshotLease('clean')).toBe(true);
        expect(queries.some(cleanupObservation)).toBe(true);
        expect(yield* snapshotState(sql)).toBe('ready');
        expect(yield* snapshotState(sql, EXPIRED_SNAPSHOT)).toBe('retired');
        expect(yield* sql`SELECT token FROM snapshot_leases`).toEqual([]);
      }),
    ),
  );

  effectIt.effect('omits unused SQL failures but preserves failures before required retirement', () =>
    withFixture(sql =>
      Effect.gen(function* () {
        yield* seedLease(sql, 'clean', SNAPSHOT, false);
        yield* seedLease(sql, 'last', SNAPSHOT, true);
        yield* observeQueries(cleanupObservation);
        expect(yield* releaseSnapshotLease('clean')).toBe(false);
        expect(yield* Effect.flip(releaseSnapshotLease('last'))).toMatchObject({_tag: 'SqlError'});
        expect(yield* sql`SELECT token FROM snapshot_leases`).toEqual([{token: 'last'}]);
        expect(yield* snapshotState(sql)).toBe('ready');
      }),
    ),
  );

  fcEffectProp(
    effectIt,
    'preserves the baton across generated insertion and expiry order with sorted releases',
    {
      active: FC.boolean(),
      flagged: FC.nat(5),
      order: FC.uniqueArray(FC.integer({min: 0, max: 5}), {minLength: 1, maxLength: 6}),
    },
    ({active, flagged, order}) =>
      withFixture(sql =>
        Effect.gen(function* () {
          const tokens = order.map(index => `reader-${index}`);
          const carrier = tokens[flagged % tokens.length];
          const remaining = new Set(tokens);
          for (const [index, token] of tokens.entries()) {
            yield* seedLease(sql, token, SNAPSHOT, token === carrier, 60_000 + index);
          }
          if (active) {
            yield* sql`
              INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
              VALUES (${WORKTREE}, ${SNAPSHOT}, '1970-01-01T00:00:00.000Z')
            `;
          }
          for (const token of [...tokens].sort()) {
            remaining.delete(token);
            expect(yield* releaseSnapshotLease(token)).toBe(!active && remaining.size === 0);
            expect(yield* snapshotState(sql)).toBe(!active && remaining.size === 0 ? 'retired' : 'ready');
            const leases = yield* sql<{readonly token: string; readonly retire_when_inactive: number}>`
              SELECT token, retire_when_inactive FROM snapshot_leases ORDER BY token
            `;
            expect(leases.map(lease => lease.token)).toEqual([...remaining].sort());
            expect(leases.filter(lease => lease.retire_when_inactive === 1)).toHaveLength(remaining.size > 0 ? 1 : 0);
          }
        }),
      ),
    {fastCheck: {numRuns: 24}},
  );
});

function withFixture<A, E, R>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* initializeSchema(sql);
    yield* sql`
      INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
      VALUES ('repository', 'fixture', 'sha1', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
    `;
    yield* seedSnapshot(sql, SNAPSHOT);
    return yield* use(sql);
  }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true})));
}

function seedSnapshot(sql: SqlClient.SqlClient, snapshotId: string) {
  return Effect.gen(function* () {
    yield* sql`
      INSERT INTO snapshots (
        id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
        extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
        edge_count, started_at, completed_at, failure_summary
      ) VALUES (
        ${snapshotId}, 'repository', ${WORKTREE}, ${'1'.repeat(40)}, ${`cgc_${snapshotId.slice(-40)}`}, NULL,
        'fixture', 0, NULL, 'ready', 0, 0, 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', NULL
      )
    `;
    yield* sql`
      INSERT INTO snapshot_extractor_generations (snapshot_id, generation)
      VALUES (${snapshotId}, ${CODE_GRAPH_EXTRACTOR_GENERATION})
    `;
  });
}

function seedLease(sql: SqlClient.SqlClient, token: string, snapshotId: string, flagged: boolean, duration = 60_000) {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
      INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
      VALUES (${token}, ${snapshotId}, ${now + duration}, ${flagged ? 1 : 0})
    `;
  });
}

function snapshotState(sql: SqlClient.SqlClient, snapshotId = SNAPSHOT) {
  return sql<{readonly state: string}>`SELECT state FROM snapshots WHERE id = ${snapshotId}`.pipe(
    Effect.map(rows => rows[0]?.state),
  );
}

const observeQueries = Effect.fn('test.observeLeaseQueries')(function* (fail?: (query: string) => boolean) {
  const queries: string[] = [];
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const original = Database.prototype.query;
      return vi.spyOn(Database.prototype, 'query').mockImplementation(function (
        this: Database,
        ...args: Parameters<Database['query']>
      ) {
        queries.push(args[0]);
        if (fail?.(args[0])) throw new Error('Required retirement observation fixture failure');
        return Reflect.apply(original, this, args);
      });
    }),
    spy => Effect.sync(() => spy.mockRestore()),
  );
  return queries;
});
