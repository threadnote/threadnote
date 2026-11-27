import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Option, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import * as EffectString from 'effect/String';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {ResourceStore} from '@threadnote/store/resource-store';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {loadRecallIndexData, recallIndexDatabaseFilename} from '@threadnote/recall/index';
import {
  RECALL_CHANGE_LOG_MAX_PUBLICATIONS,
  readRecallChangesSince,
  readRecallFirstPublicationAfter,
  recordRecallChangeLog,
} from '../../src/index/change_log.js';
import {initializeRecallDatabase} from '../../src/index/schema.js';

interface Row {
  readonly uri: string;
  readonly project?: string | null;
  readonly approved?: 0 | 1;
  readonly candidate?: string;
  readonly memoryId?: string | null;
  readonly hash?: string | null;
  readonly logicalKey?: string;
}

const withMemoryDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Layer.build(SqliteClient.layer({filename: ':memory:'})).pipe(
      Effect.flatMap(context => effect.pipe(Effect.provide(context))),
    ),
  );

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* initializeRecallDatabase(sql);
  yield* sql.unsafe(`CREATE TEMP TABLE indexed (uri TEXT PRIMARY KEY, project TEXT, approved_authoritative INTEGER,
    workspace_scope TEXT, memory_id TEXT, content_hash TEXT, candidate_json TEXT, logical_key TEXT)`);
  yield* sql.unsafe('CREATE TEMP TABLE replaced (document_id INTEGER PRIMARY KEY)');
  const tables = {indexedTable: 'indexed', replacedTable: 'replaced'};
  const setMetadata = (key: string, value: string) =>
    sql`INSERT INTO metadata (key, value) VALUES (${key}, ${value})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  const setGeneration = (generation: string) => setMetadata('content_generation', generation);
  /** Writes the generation with consistent integrity metadata, as a completed publication does. */
  const commitGeneration = (generation: string) =>
    Effect.gen(function* () {
      yield* setGeneration(generation);
      yield* setMetadata('memory_identity_conflict_generation', generation);
      const sequence = yield* sql<{readonly value: string}>`
        SELECT value FROM metadata WHERE key = 'mutation_sequence'`;
      yield* setMetadata('integrity_sequence', sequence[0]?.value ?? '0');
    });
  const insertDocument = (row: Row) =>
    sql`INSERT INTO documents (uri, project, approved_authoritative, workspace_scope, source_path, source_size,
          uri_locator_digest, memory_id, content_hash, logical_key, document_length, memory_links_truncated,
          candidate_json)
        VALUES (${row.uri}, ${row.project ?? null}, ${row.approved ?? 0}, NULL, ${row.uri}, 1, 'd',
          ${row.memoryId ?? null}, ${row.hash ?? null}, ${row.logicalKey ?? row.uri}, 1, 0, ${row.candidate ?? '{}'})`;
  /** Simulates one publication: stage rows, record the log, then apply the rows and the generation. */
  const publish = (generation: string, upserts: readonly Row[], removals: readonly string[]) =>
    Effect.gen(function* () {
      yield* sql.unsafe('DELETE FROM temp.indexed');
      yield* sql.unsafe('DELETE FROM temp.replaced');
      for (const row of upserts)
        yield* sql`INSERT INTO temp.indexed VALUES (${row.uri}, ${row.project ?? null}, ${row.approved ?? 0}, NULL,
          ${row.memoryId ?? null}, ${row.hash ?? null}, ${row.candidate ?? '{}'}, ${row.logicalKey ?? row.uri})`;
      yield* sql.unsafe(
        `INSERT INTO temp.replaced SELECT id FROM documents
        WHERE uri IN (SELECT uri FROM temp.indexed) OR uri IN (${EffectArray.join(
          EffectArray.map(['', ...removals], () => '?'),
          ',',
        )})`,
        ['', ...removals],
      );
      yield* recordRecallChangeLog(sql, tables, generation);
      yield* sql.unsafe('DELETE FROM documents WHERE id IN (SELECT document_id FROM temp.replaced)');
      for (const row of upserts) yield* insertDocument(row);
      yield* commitGeneration(generation);
    });
  return {sql, publish, setGeneration, commitGeneration, insertDocument};
});

const uris = (result: Effect.Success<ReturnType<typeof readRecallChangesSince>>) =>
  result.state === 'known' ? EffectArray.map(result.changed, entry => `${entry.kind}:${entry.uri}`).sort() : 'unknown';

effectIt.effect('records real changes only and merges entries across a chain', () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      const {sql, publish} = yield* setup;
      yield* publish('g1', [{uri: 'a', memoryId: 'm_a', hash: 'h1'}, {uri: 'b'}, {uri: 'c'}, {uri: 'd'}], []);
      // b: project only; c: authority only; d: unchanged re-index (time or size only); f: logical key only.
      yield* publish('g1b', [{uri: 'f'}], []);
      yield* publish(
        'g2',
        [
          {uri: 'a', memoryId: 'm_a', hash: 'h2', candidate: '{"text":1}'},
          {uri: 'b', project: 'p'},
          {uri: 'c', approved: 1},
          {uri: 'd'},
          {uri: 'f', logicalKey: 'other'},
        ],
        [],
      );
      expect(uris(yield* readRecallChangesSince(sql, 'g1b'))).toEqual([
        'changed:a',
        'changed:b',
        'changed:c',
        'changed:f',
      ]);
      yield* publish('g3', [{uri: 'a', memoryId: 'm_a', hash: 'h3', candidate: '{"text":2}'}, {uri: 'e'}], ['b']);
      const merged = yield* readRecallChangesSince(sql, 'g1');
      expect(uris(merged)).toEqual(['added:e', 'added:f', 'changed:a', 'changed:c', 'removed:b']);
      expect(
        merged.state === 'known' &&
          Option.getOrUndefined(EffectArray.findFirst(merged.changed, entry => entry.uri === 'a')),
      ).toMatchObject({
        beforeContentHash: 'h1',
        afterContentHash: 'h3',
        beforeMemoryId: 'm_a',
      });
      expect(yield* readRecallChangesSince(sql, 'g3')).toEqual({state: 'known', contentGeneration: 'g3', changed: []});
    }),
  ),
);

effectIt.effect('a memory removed and added again is changed from its first state', () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      const {sql, publish} = yield* setup;
      yield* publish('g1', [{uri: 'x', memoryId: 'm_x', hash: 'h1'}], []);
      yield* publish('g2', [], ['x']);
      yield* publish('g3', [{uri: 'x', memoryId: 'm_x', hash: 'h2'}], []);
      expect(yield* readRecallChangesSince(sql, 'g1')).toEqual({
        state: 'known',
        contentGeneration: 'g3',
        changed: [
          {
            uri: 'x',
            kind: 'changed',
            beforeMemoryId: 'm_x',
            beforeContentHash: 'h1',
            afterMemoryId: 'm_x',
            afterContentHash: 'h2',
          },
        ],
      });
    }),
  ),
);

effectIt.effect('stamps each header with the publication time, also with zero entries', () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      const {sql, publish} = yield* setup;
      yield* TestClock.setTime(1_000);
      yield* publish('g1', [{uri: 'a'}], []);
      // A fresh database has no stored generation, so its first header starts the chain.
      expect(yield* sql`SELECT previous_generation FROM recall_change_publications`).toEqual([
        {previous_generation: null},
      ]);
      yield* TestClock.setTime(5_000);
      yield* publish('g2', [{uri: 'a'}], []);
      const headers = yield* sql<{readonly published_at: number; readonly entry_count: number}>`
        SELECT published_at, entry_count FROM recall_change_publications ORDER BY sequence`;
      expect(headers).toEqual([
        {published_at: 1_000, entry_count: 1},
        {published_at: 5_000, entry_count: 0},
      ]);
      expect(yield* readRecallChangesSince(sql, 'g1')).toEqual({state: 'known', contentGeneration: 'g2', changed: []});
      expect(yield* readRecallFirstPublicationAfter(sql, 'g1')).toEqual(Option.some({publishedAtMillis: 5_000}));
      // An unchanged generation writes no header and keeps the chain.
      yield* TestClock.setTime(9_000);
      yield* publish('g2', [], []);
      expect(yield* sql`SELECT COUNT(*) AS count FROM recall_change_publications`).toEqual([{count: 2}]);
      expect(yield* readRecallFirstPublicationAfter(sql, 'g1')).toEqual(Option.some({publishedAtMillis: 5_000}));
      expect(yield* readRecallFirstPublicationAfter(sql, 'g0')).toEqual(Option.none());
    }),
  ),
);

effectIt.effect('returns unknown for stale metadata, a pruned log, a missing header, or a missing table', () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      const {sql, publish, setGeneration, commitGeneration, insertDocument} = yield* setup;
      // Stale metadata: g0 is stored without the integrity state of a completed publication, so the
      // header has a null previous generation even though g0 is the stored previous state.
      yield* setGeneration('g0');
      yield* publish('g1', [{uri: 'a'}], []);
      expect(yield* sql`SELECT previous_generation FROM recall_change_publications`).toEqual([
        {previous_generation: null},
      ]);
      expect(yield* readRecallChangesSince(sql, 'g0')).toEqual({state: 'unknown'});
      for (let i = 2; i <= RECALL_CHANGE_LOG_MAX_PUBLICATIONS + 2; i++)
        yield* publish(`g${i}`, [{uri: 'a', candidate: `{"v":${i}}`}], []);
      // Pruned headers had one entry each; none of those entries remains.
      expect(
        yield* sql`SELECT COUNT(*) AS count FROM recall_change_entries
          WHERE publication_sequence < (SELECT MIN(sequence) FROM recall_change_publications)`,
      ).toEqual([{count: 0}]);
      expect(yield* sql`SELECT COUNT(*) AS count FROM recall_change_entries`).toEqual([
        {count: RECALL_CHANGE_LOG_MAX_PUBLICATIONS},
      ]);
      const last = `g${RECALL_CHANGE_LOG_MAX_PUBLICATIONS + 2}`;
      expect(yield* readRecallChangesSince(sql, 'g1')).toEqual({state: 'unknown'});
      expect((yield* readRecallChangesSince(sql, 'g5')).state).toBe('known');
      // An older binary published without a header.
      yield* setGeneration('g-old');
      expect(yield* readRecallChangesSince(sql, last)).toEqual({state: 'unknown'});
      // A gap in the middle: an older binary publishes without a header, then the new code publishes again.
      yield* publish('h1', [], []);
      yield* publish('h2', [], []);
      yield* commitGeneration('h-old');
      yield* publish('h3', [], []);
      expect(yield* readRecallChangesSince(sql, 'h1')).toEqual({state: 'unknown'});
      expect((yield* readRecallChangesSince(sql, 'h-old')).state).toBe('known');
      // A change of documents outside a publication breaks the chain.
      yield* insertDocument({uri: 'outside'});
      yield* publish('h4', [], []);
      expect(yield* readRecallChangesSince(sql, 'h3')).toEqual({state: 'unknown'});
      yield* sql.unsafe('DROP TABLE recall_change_entries');
      yield* sql.unsafe('DROP TABLE recall_change_publications');
      expect(yield* readRecallChangesSince(sql, 'h4')).toEqual({state: 'unknown'});
    }),
  ),
);

effectIt.effect('returns unknown when a publication or prune runs between the entry read and the recheck', () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      const {sql, publish, setGeneration} = yield* setup;
      const interfere = [
        sql.unsafe(
          'DELETE FROM recall_change_publications WHERE sequence = (SELECT MIN(sequence) FROM recall_change_publications)',
        ),
        setGeneration('g-concurrent'),
      ];
      for (const interference of interfere) {
        // The first header of the chain from g1 is the oldest kept header.
        yield* publish('g1', [{uri: 'a', candidate: '{"v":1}'}], []);
        yield* sql.unsafe('DELETE FROM recall_change_publications');
        yield* publish('g2', [{uri: 'a', candidate: '{"v":2}'}], []);
        yield* publish('g3', [{uri: 'a', candidate: '{"v":3}'}], []);
        // Run the interference just before the entry read, through the sql parameter the reader takes.
        const racing = new Proxy(sql, {
          get(target, property, receiver) {
            if (property !== 'unsafe') return Reflect.get(target, property, receiver);
            return (statement: string, parameters?: ReadonlyArray<unknown>) =>
              EffectString.includes('FROM recall_change_entries')(statement)
                ? interference.pipe(Effect.andThen(target.unsafe(statement, parameters)))
                : target.unsafe(statement, parameters);
          },
        });
        expect(yield* readRecallChangesSince(racing, 'g1')).toEqual({state: 'unknown'});
      }
    }),
  ),
);

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
    ),
  ),
);
const services = ResourceStore.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, cryptoLayer, system, recallResourceInvalidationLayer)),
);
const document = (id: number, body: string) =>
  `MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_${id}\nsource_agent_client: test\ntimestamp: 2026-11-03T00:00:00.000Z\n\n${body}`;

effectIt.effect('a real publication logs exactly the added, changed and removed memories', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* ResourceStore;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'recall-change-log-'}));
    const config = {account: 'local', user: 'me', agentContextHome: home, manifestPath: path.join(home, 'm.json')};
    yield* fs.writeFileString(config.manifestPath, JSON.stringify({version: 1, projects: []}));
    const location = {account: 'local', user: 'me', home};
    const uri = (id: number) => `threadnote://user/me/memories/durable/${id}.md`;
    const write = (id: number, body: string) =>
      store.mutateChecked(
        location,
        [{type: 'write', uri: uri(id), content: document(id, body), options: {mode: 'upsert'}}],
        Effect.void,
      );
    for (const id of [0, 1, 2, 3]) yield* write(id, `alpha ${id}`);
    const refresh = loadRecallIndexData(config, {includeInactive: false, memoryIds: []});
    yield* refresh;
    const filename = path.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
    const withIndex = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      Effect.scoped(
        Layer.build(SqliteClient.layer({filename, readonly: true})).pipe(
          Effect.flatMap(context => SqlClient.SqlClient.pipe(Effect.flatMap(use), Effect.provide(context))),
        ),
      );
    const generation = () =>
      withIndex(sql =>
        sql<{readonly value: string}>`SELECT value FROM metadata WHERE key = 'content_generation'`.pipe(
          Effect.map(rows => rows[0]?.value ?? ''),
        ),
      );
    const touchedRow = () =>
      withIndex(sql =>
        sql<{readonly id: number; readonly source_modified_at: string | null}>`
          SELECT id, source_modified_at FROM documents WHERE uri = ${uri(2)}`.pipe(Effect.map(rows => rows[0])),
      );
    const touchedBefore = yield* touchedRow();
    const before = yield* generation();
    yield* write(0, 'alpha changed');
    yield* write(4, 'alpha added');
    yield* store.mutateChecked(location, [{type: 'remove', uri: uri(1)}], Effect.void);
    // Only the file time changes for memory 2.
    const touched = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', '2.md');
    yield* fs.utimes(touched, 2_000_000_000, 2_000_000_000);
    yield* refresh;
    expect(yield* generation()).not.toBe(before);
    const touchedAfter = yield* touchedRow();
    expect(touchedAfter?.id).not.toBe(touchedBefore?.id);
    expect(touchedAfter?.source_modified_at).not.toBe(touchedBefore?.source_modified_at);
    const result = yield* withIndex(sql => readRecallChangesSince(sql, before));
    expect(uris(result)).toEqual([`added:${uri(4)}`, `changed:${uri(0)}`, `removed:${uri(1)}`]);
  }).pipe(
    Effect.scoped,
    effect =>
      Effect.scoped(Layer.build(services).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context))))),
    TestClock.withLive,
  ),
);
