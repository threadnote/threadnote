import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {ExternalSourcePolicy} from '@threadnote/store/external-resource';
import {RECALL_REFRESH_SOURCE_TABLE, scanRecallSources, stageRecallSources} from '@threadnote/recall/index/refresh';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const database = SqliteClient.layer({filename: ':memory:'});
const locatorIndex = `${RECALL_REFRESH_SOURCE_TABLE}_locator_digest`;
interface Source {
  readonly id: number;
  readonly resource: boolean;
  readonly policy: boolean;
  readonly invalidated: boolean;
  readonly body: string;
}
interface SourceRow {
  readonly uri: string;
  readonly uri_locator_digest: string;
  readonly source_path: string;
  readonly source_modified_at: string | null;
  readonly source_size: number;
  readonly authority_policy_key: string | null;
  readonly invalidated: number;
}
function withDatabase<A, E, R>(effect: Effect.Effect<A, E, R>, filename?: string) {
  const selected = filename === undefined ? database : SqliteClient.layer({filename});
  return Effect.scoped(Layer.build(selected).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}
function sources(count: number): Source[] {
  return Array.from({length: count}, (_, id) => ({
    id,
    resource: id % 2 === 0,
    policy: id % 3 === 0,
    invalidated: id % 5 === 0,
    body: `body ${id}`,
  }));
}
const fixture = Effect.fn('test.recallSourceScanFixture')(function* (sources: readonly Source[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-source-scan-'});
  const expected: SourceRow[] = [];
  for (const source of sources) {
    const name = `source-${Effect2.pipe(source.id.toString(), EffectString.padStart(3, '0'))}.md`;
    const relative = source.resource ? ['resources', name] : ['user', 'allowed', 'memories', name];
    const file = path.join(home, 'data', 'acct', ...relative);
    yield* fs.makeDirectory(path.dirname(file), {recursive: true});
    yield* fs.writeFileString(file, source.body);
    const stat = yield* fs.stat(file);
    const uri = source.resource ? `threadnote://resources/${name}` : `threadnote://user/allowed/memories/${name}`;
    expected.push({
      uri,
      uri_locator_digest: new Bun.CryptoHasher('sha256')
        .update(JSON.stringify({kind: 'memory-link-locator', uri, version: 1}))
        .digest('hex'),
      source_path: file,
      source_modified_at: Option.getOrNull(Option.map(stat.mtime, date => date.toISOString())),
      source_size: new TextEncoder().encode(source.body).length,
      authority_policy_key: source.policy ? `authority-${source.id}` : null,
      invalidated: Number(source.invalidated),
    });
  }
  expected.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  const config = {account: 'acct', agentContextHome: home, user: 'allowed'};
  const policy = {
    entryKeyByUri: new Map(
      EffectArray.flatMap(expected, row =>
        row.authority_policy_key === null ? [] : [[row.uri, row.authority_policy_key]],
      ),
    ),
    sourcePathByUri: new Map<string, string>(),
  };
  const scan = (sql: SqlClient.SqlClient) =>
    scanRecallSources(
      sql,
      fs,
      path,
      config,
      true,
      policy,
      new Set(
        EffectArray.map(
          EffectArray.filter(expected, row => row.invalidated === 1),
          row => row.uri,
        ),
      ),
    );
  return {expected, scan, fs, path, config, policy};
});
const seedPersistedInventory = (sql: SqlClient.SqlClient, skipped = 0) =>
  Effect.gen(function* () {
    yield* sql.unsafe('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    yield* sql.unsafe(
      "INSERT INTO metadata VALUES ('content_generation', 'baseline'), ('oversized_document_count', ?)",
      [String(skipped)],
    );
    yield* sql.unsafe(
      `CREATE TABLE documents AS SELECT uri, source_path, source_modified_at, source_size, authority_policy_key FROM temp.${RECALL_REFRESH_SOURCE_TABLE}`,
    );
  });
const verifyInventory = Effect.fn('test.verifyRecallSourceInventory')(function* (sources: readonly Source[]) {
  const {expected, scan} = yield* fixture(sources);
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    expect(yield* scan(sql)).toEqual({scannedSourceCount: expected.length, skippedOversizedDocumentCount: 0});
    const rows = yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`);
    expect(rows).toEqual(expected);
    for (const row of expected) {
      const lookup = yield* sql.unsafe<{readonly uri: string}>(
        `SELECT uri FROM temp.${RECALL_REFRESH_SOURCE_TABLE} WHERE uri_locator_digest = ? AND uri = ?`,
        [row.uri_locator_digest, row.uri],
      );
      expect(EffectArray.map(lookup, value => value.uri)).toEqual([row.uri]);
    }
    const plan = yield* sql.unsafe<{readonly detail: string}>(
      `EXPLAIN QUERY PLAN SELECT uri FROM temp.${RECALL_REFRESH_SOURCE_TABLE}
       WHERE uri_locator_digest = ? ORDER BY uri`,
      [expected[0]?.uri_locator_digest ?? Effect2.pipe('0', EffectString.repeat(64))],
    );
    expect(EffectArray.some(plan, row => Effect2.pipe(row.detail, EffectString.includes(locatorIndex)))).toBe(true);
  }).pipe(withDatabase);
});

describe('Recall source staging', () => {
  effectIt.layer(BunServices.layer)(it => {
    for (const includeInactive of [false, true])
      it.effect(`keeps direct inactive-folder files ${includeInactive ? 'in' : 'out of'} the selected variant`, () =>
        Effect.gen(function* () {
          const {fs, path, config, policy, expected} = yield* fixture(sources(1));
          const inactiveUris: string[] = [];
          for (const status of ['archived', 'expired', 'superseded']) {
            const directory = path.join(
              config.agentContextHome,
              'data',
              config.account,
              'user',
              config.user,
              'memories',
              status,
            );
            yield* fs.makeDirectory(directory, {recursive: true});
            yield* fs.writeFileString(path.join(directory, 'direct.md'), 'inactive source');
            inactiveUris.push(`threadnote://user/${config.user}/memories/${status}/direct.md`);
          }
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const result = yield* scanRecallSources(sql, fs, path, config, includeInactive, policy, new Set());
            const uris = EffectArray.map(
              yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE}`),
              row => row.uri,
            ).sort();
            expect(uris).toEqual(
              [...EffectArray.map(expected, row => row.uri), ...(includeInactive ? inactiveUris : [])].sort(),
            );
            expect(result.scannedSourceCount).toBe(includeInactive ? 4 : 1);
          }).pipe(withDatabase);
        }),
      );
    it.effect('permits an independent SQLite writer while touched source checks are paused', () =>
      Effect.gen(function* () {
        const {expected, scan, fs, path, config, policy} = yield* fixture(sources(1));
        const filename = path.join(config.agentContextHome, 'staging.sqlite');
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const paused = {
          ...fs,
          realPath: (target: string) =>
            target === config.agentContextHome
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(fs.realPath(target)),
                )
              : fs.realPath(target),
        };
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* scan(sql);
          yield* seedPersistedInventory(sql);
          yield* sql.unsafe('CREATE TABLE writer_probe (value TEXT NOT NULL)');
          const staging = yield* stageRecallSources(sql, paused, path, config, {
            includeInactive: true,
            canonicalResourcePolicy: policy,
            invalidatedUris: new Set([expected[0].uri]),
            mode: {kind: 'touched', contentGeneration: 'baseline'},
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(entered).pipe(Effect.timeout('2 seconds'));
          const script = `import {Database} from 'bun:sqlite';
            const db = new Database(process.argv.at(-1), {create: false});
            db.exec('PRAGMA busy_timeout = 50');
            db.exec('BEGIN IMMEDIATE');
            db.exec("INSERT INTO writer_probe VALUES ('independent')");
            db.exec('COMMIT');
            db.close();`;
          const writer = yield* Effect.acquireUseRelease(
            Effect.sync(() =>
              Bun.spawn([process.execPath, '--eval', script, filename], {
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'pipe',
              }),
            ),
            child =>
              Effect.gen(function* () {
                const code = yield* Effect.promise(() => child.exited);
                const stderr = yield* Effect.promise(() => new Response(child.stderr).text());
                return {code, stderr};
              }).pipe(Effect.timeout('2 seconds')),
            child =>
              Effect.promise(async () => {
                if (child.exitCode === null) child.kill();
                await child.exited;
              }),
          ).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
          expect(writer.code, writer.stderr).toBe(0);
          expect((yield* Fiber.join(staging)).mode).toBe('touched');
          expect(yield* sql.unsafe('SELECT value FROM writer_probe')).toEqual([{value: 'independent'}]);
          expect(yield* sql.unsafe('SELECT value FROM metadata WHERE key = ?', ['content_generation'])).toEqual([
            {value: 'baseline'},
          ]);
          expect(yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE}`)).toEqual([
            {...expected[0], invalidated: 1},
          ]);
        }).pipe(effect => withDatabase(effect, filename));
      }).pipe(TestClock.withLive),
    );
    it.effect('forces hydration of an invalidated file with unchanged size and modification time', () =>
      Effect.gen(function* () {
        const {expected, scan, fs, path, config, policy} = yield* fixture(sources(1));
        const target = expected[0];
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* scan(sql);
          yield* seedPersistedInventory(sql);
          yield* fs.writeFileString(target.source_path, EffectString.repeat(target.source_size)('x'));
          const originalTime = DateTime.toDateUtc(DateTime.makeUnsafe(target.source_modified_at!));
          yield* fs.utimes(target.source_path, originalTime, originalTime);
          const result = yield* stageRecallSources(sql, fs, path, config, {
            includeInactive: true,
            canonicalResourcePolicy: policy,
            invalidatedUris: new Set([target.uri]),
            mode: {kind: 'touched', contentGeneration: 'baseline'},
          });
          expect(result.mode).toBe('touched');
          expect(yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE}`)).toEqual([
            {...target, invalidated: 1},
          ]);
        }).pipe(withDatabase);
      }),
    );
    for (const uncertainty of ['generation', 'oversized-count', 'prefix', 'foreign-user', 'unknown-missing'] as const) {
      it.effect(`requests full rehydration when ${uncertainty} prevents a proved touched pass`, () =>
        Effect.gen(function* () {
          const {expected, scan, fs, path, config, policy} = yield* fixture(sources(1));
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* scan(sql);
            yield* seedPersistedInventory(sql);
            if (uncertainty === 'oversized-count')
              yield* sql.unsafe("UPDATE metadata SET value = 'unknown' WHERE key = 'oversized_document_count'");
            const uri =
              uncertainty === 'prefix'
                ? 'threadnote://resources'
                : uncertainty === 'foreign-user'
                  ? 'threadnote://user/other/memories/forbidden.md'
                  : uncertainty === 'unknown-missing'
                    ? 'threadnote://resources/missing.md'
                    : expected[0].uri;
            const result = yield* stageRecallSources(sql, fs, path, config, {
              includeInactive: true,
              canonicalResourcePolicy: policy,
              invalidatedUris: new Set([uri]),
              mode: {kind: 'touched', contentGeneration: uncertainty === 'generation' ? 'wrong' : 'baseline'},
            });
            expect(result).toMatchObject({
              mode: 'full',
              forceAllSources: true,
              scannedSourceCount: 1,
              skippedOversizedDocumentCount: 0,
            });
            expect((yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE}`))[0].uri).toBe(
              expected[0].uri,
            );
          }).pipe(withDatabase);
        }),
      );
    }
    fcEffectProp(
      it,
      'touched inventories equal a clean scan after finite file mutations without changing persisted rows',
      {
        actions: fc.array(
          fc.record({
            id: fc.integer({min: 0, max: 5}),
            action: fc.constantFrom('write', 'delete', 'move'),
            body: fc.string({maxLength: 32}),
          }),
          {minLength: 1, maxLength: 8},
        ),
      },
      ({actions}) =>
        Effect.gen(function* () {
          const {scan, fs, path, config, policy} = yield* fixture(sources(3));
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* scan(sql);
            yield* seedPersistedInventory(sql);
            const before = yield* sql.unsafe('SELECT * FROM documents ORDER BY uri');
            const touched = new Set<string>();
            for (const action of actions) {
              const name = `source-${EffectString.padStart(3, '0')(String(action.id))}.md`;
              const segments = action.id % 2 === 0 ? ['resources'] : ['user', 'allowed', 'memories'];
              const filename = path.join(config.agentContextHome, 'data', 'acct', ...segments, name);
              const uri =
                action.id % 2 === 0 ? `threadnote://resources/${name}` : `threadnote://user/allowed/memories/${name}`;
              touched.add(uri);
              if (action.action === 'delete') yield* fs.remove(filename, {force: true});
              else if (action.action === 'write') yield* fs.writeFileString(filename, action.body);
              else if (yield* fs.exists(filename)) {
                const moved = path.join(config.agentContextHome, 'data', 'acct', 'resources', 'moved-' + name);
                yield* fs.rename(filename, moved);
                touched.add(`threadnote://resources/moved-${name}`);
              }
            }
            const result = yield* stageRecallSources(sql, fs, path, config, {
              includeInactive: true,
              canonicalResourcePolicy: policy,
              invalidatedUris: touched,
              mode: {kind: 'touched', contentGeneration: 'baseline'},
            });
            const staged = yield* sql.unsafe<SourceRow>(
              `SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`,
            );
            const full = yield* scanRecallSources(sql, fs, path, config, true, policy, touched);
            expect(
              yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`),
            ).toEqual(staged);
            expect(result.skippedOversizedDocumentCount).toBe(full.skippedOversizedDocumentCount);
            expect(yield* sql.unsafe('SELECT * FROM documents ORDER BY uri')).toEqual(before);
          }).pipe(withDatabase);
        }),
      {fastCheck: {numRuns: 12}},
    );
    for (const change of ['grow', 'shrink', 'delete-oversized', 'retain-other-oversized'] as const) {
      it.effect(`preserves oversized inventory counts for ${change}`, () =>
        Effect.gen(function* () {
          const {scan, expected, fs, path, config, policy} = yield* fixture(sources(2));
          const target = expected[0];
          const other = expected[1];
          if (change === 'shrink' || change === 'delete-oversized')
            yield* fs.writeFileString(target.source_path, EffectString.repeat(512 * 1024 + 1)('x'));
          if (change === 'retain-other-oversized')
            yield* fs.writeFileString(other.source_path, EffectString.repeat(512 * 1024 + 1)('x'));
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const baseline = yield* scan(sql);
            yield* seedPersistedInventory(sql, baseline.skippedOversizedDocumentCount);
            if (change === 'delete-oversized') yield* fs.remove(target.source_path);
            else
              yield* fs.writeFileString(
                target.source_path,
                change === 'grow' ? EffectString.repeat(512 * 1024 + 1)('x') : 'small',
              );
            const result = yield* stageRecallSources(sql, fs, path, config, {
              includeInactive: true,
              canonicalResourcePolicy: policy,
              invalidatedUris: new Set([target.uri]),
              mode: {kind: 'touched', contentGeneration: 'baseline'},
            });
            expect(result.mode).toBe(change === 'shrink' || change === 'delete-oversized' ? 'full' : 'touched');
            expect(result.forceAllSources).toBe(result.mode === 'full');
            const staged = yield* sql.unsafe<SourceRow>(
              `SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`,
            );
            const full = yield* scanRecallSources(sql, fs, path, config, true, policy, new Set([target.uri]));
            expect(result.skippedOversizedDocumentCount).toBe(full.skippedOversizedDocumentCount);
            expect(
              yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`),
            ).toEqual(staged);
          }).pipe(withDatabase);
        }),
      );
    }
    it.effect('retains a verified decomposed source path for its normalized URI', () =>
      Effect.gen(function* () {
        const {scan, fs, path, config, policy} = yield* fixture(sources(1));
        const filename = path.join(config.agentContextHome, 'data', 'acct', 'resources', 'e\u0301.md');
        yield* fs.writeFileString(filename, 'before');
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* scan(sql);
          yield* seedPersistedInventory(sql);
          yield* fs.writeFileString(filename, 'after');
          const uri = 'threadnote://resources/%C3%A9.md';
          const result = yield* stageRecallSources(sql, fs, path, config, {
            includeInactive: true,
            canonicalResourcePolicy: policy,
            invalidatedUris: new Set([uri]),
            mode: {kind: 'touched', contentGeneration: 'baseline'},
          });
          const canonicalExists = yield* fs.exists(path.join(path.dirname(filename), '\u00e9.md'));
          expect(result.mode).toBe(canonicalExists ? 'touched' : 'full');
          const staged = yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`);
          yield* scanRecallSources(sql, fs, path, config, true, policy, new Set([uri]));
          expect(
            yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`),
          ).toEqual(staged);
        }).pipe(withDatabase);
      }),
    );
    for (const move of [
      {
        kind: 'case-rename',
        from: 'A.md',
        to: 'a.md',
        uris: ['threadnote://resources/A.md', 'threadnote://resources/a.md'],
      },
      {kind: 'case-upsert', from: 'A.md', to: 'a.md', uris: ['threadnote://resources/a.md']},
      {kind: 'normalization-rename', from: 'e\u0301.md', to: '\u00e9.md', uris: ['threadnote://resources/%C3%A9.md']},
    ]) {
      it.effect(`preserves the complete current inventory after ${move.kind}`, () =>
        Effect.gen(function* () {
          const {scan, fs, path, config, policy} = yield* fixture(sources(1));
          const root = path.join(config.agentContextHome, 'data', 'acct', 'resources');
          const from = path.join(root, move.from);
          const to = path.join(root, move.to);
          yield* fs.writeFileString(from, 'before');
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* scan(sql);
            yield* seedPersistedInventory(sql);
            if (move.kind === 'case-upsert') {
              const replacement = path.join(root, 'replacement.tmp');
              yield* fs.writeFileString(replacement, 'after');
              yield* fs.rename(replacement, to);
            } else yield* fs.rename(from, to);
            const touched = new Set(move.uris);
            const result = yield* stageRecallSources(sql, fs, path, config, {
              includeInactive: true,
              canonicalResourcePolicy: policy,
              invalidatedUris: touched,
              mode: {kind: 'touched', contentGeneration: 'baseline'},
            });
            if (move.kind !== 'normalization-rename') expect(result.mode).toBe('full');
            const staged = yield* sql.unsafe<SourceRow>(
              `SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`,
            );
            yield* scanRecallSources(sql, fs, path, config, true, policy, touched);
            expect(
              yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`),
            ).toEqual(staged);
          }).pipe(withDatabase);
        }),
      );
    }
    it.effect('refuses ambiguous canonical and decomposed spellings when the filesystem permits both', () =>
      Effect.gen(function* () {
        const {scan, fs, path, config, policy} = yield* fixture(sources(1));
        const root = path.join(config.agentContextHome, 'data', 'acct', 'resources');
        const decomposed = path.join(root, 'e\u0301.md');
        const canonical = path.join(root, '\u00e9.md');
        yield* fs.writeFileString(decomposed, 'old');
        const distinctNames = !(yield* fs.exists(canonical));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* scan(sql);
          yield* seedPersistedInventory(sql);
          const before = yield* sql.unsafe('SELECT * FROM documents ORDER BY uri');
          yield* fs.writeFileString(canonical, 'new');
          const uri = 'threadnote://resources/%C3%A9.md';
          const staged = yield* stageRecallSources(sql, fs, path, config, {
            includeInactive: true,
            canonicalResourcePolicy: policy,
            invalidatedUris: new Set([uri]),
            mode: {kind: 'touched', contentGeneration: 'baseline'},
          }).pipe(Effect.exit);
          if (distinctNames) expect(Exit.isFailure(staged)).toBe(true);
          else {
            expect(Exit.isSuccess(staged)).toBe(true);
            const inventory = yield* sql.unsafe<SourceRow>(
              `SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`,
            );
            yield* scanRecallSources(sql, fs, path, config, true, policy, new Set([uri]));
            expect(
              yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`),
            ).toEqual(inventory);
          }
          expect(yield* sql.unsafe('SELECT * FROM documents ORDER BY uri')).toEqual(before);
        }).pipe(withDatabase);
      }),
    );
    it.effect(
      'stages one touched file among two thousand without walking canonical roots or changing persisted rows',
      () =>
        Effect.gen(function* () {
          const {expected, scan, fs, path, config, policy} = yield* fixture(sources(2048));
          for (const provider of ['superhuman', 'pocket', 'linear', 'github'])
            yield* fs.makeDirectory(
              path.join(
                config.agentContextHome,
                'data',
                'acct',
                'resources',
                'external',
                provider,
                'project-a',
                'docs',
                'doc_1',
              ),
              {recursive: true},
            );
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* scan(sql);
            yield* seedPersistedInventory(sql);
            const target = expected[1500];
            yield* fs.writeFileString(target.source_path, 'changed target');
            let directoryReads = 0;
            let unrelatedFileStats = 0;
            let externalPolicyReads = 0;
            const traced = {
              ...fs,
              readDirectory: (...args: Parameters<typeof fs.readDirectory>) => {
                directoryReads++;
                return fs.readDirectory(...args);
              },
              stat: (filename: string) => {
                if (filename !== target.source_path && EffectString.endsWith('.md')(filename)) unrelatedFileStats++;
                return fs.stat(filename);
              },
            };
            const before = yield* sql.unsafe('SELECT * FROM documents ORDER BY uri');
            const result = yield* stageRecallSources(sql, traced, path, config, {
              includeInactive: true,
              canonicalResourcePolicy: policy,
              invalidatedUris: new Set([target.uri]),
              mode: {kind: 'touched', contentGeneration: 'baseline'},
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, traced),
              Effect.provideService(ExternalSourcePolicy, {
                current: () =>
                  Effect.sync(() => {
                    externalPolicyReads++;
                    return {enabled: true, configFingerprint: EffectString.repeat(64)('a'), project: null};
                  }),
              }),
            );
            expect(result).toMatchObject({mode: 'touched', scannedSourceCount: 1, skippedOversizedDocumentCount: 0});
            expect(directoryReads).toBe(0);
            expect(unrelatedFileStats).toBe(0);
            expect(externalPolicyReads).toBe(0);
            expect(yield* sql.unsafe('SELECT * FROM documents ORDER BY uri')).toEqual(before);
            const staged = yield* sql.unsafe<SourceRow>(
              `SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`,
            );
            expect(staged).toHaveLength(expected.length);
            expect(
              EffectArray.map(
                EffectArray.filter(staged, row => row.invalidated === 1),
                row => row.uri,
              ),
            ).toEqual([target.uri]);
            yield* scanRecallSources(sql, fs, path, config, true, policy, new Set([target.uri]));
            expect(
              yield* sql.unsafe<SourceRow>(`SELECT * FROM temp.${RECALL_REFRESH_SOURCE_TABLE} ORDER BY uri`),
            ).toEqual(staged);
          }).pipe(withDatabase);
        }),
    );
    for (const count of [0, 1, 255, 256, 257, 513]) {
      it.effect(`stages complete metadata and indexed locator lookups for ${count} sources`, () =>
        verifyInventory(sources(count)),
      );
    }
    fcEffectProp(
      it,
      'matches independent metadata and locator models across both source roots',
      {
        sources: fc.uniqueArray(
          fc.record({
            id: fc.integer({min: 0, max: 99}),
            resource: fc.boolean(),
            policy: fc.boolean(),
            invalidated: fc.boolean(),
            body: fc.string({maxLength: 48}),
          }),
          {maxLength: 16, selector: source => source.id},
        ),
      },
      ({sources}) => verifyInventory(sources),
      {fastCheck: {numRuns: 12}},
    );
    for (const {count, failIndex} of [
      {count: 255, failIndex: false},
      {count: 513, failIndex: false},
      {count: 0, failIndex: true},
      {count: 257, failIndex: true},
    ]) {
      it.effect(`propagates ${failIndex ? 'index-build' : 'source-insert'} failure for ${count} sources`, () =>
        Effect.gen(function* () {
          const {scan} = yield* fixture(sources(count));
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            let indexAttempts = 0;
            let injectedFailures = 0;
            let returnedCompleteInventory = false;
            const failing = new Proxy(sql, {
              get(target, property, receiver) {
                if (property !== 'unsafe') return Reflect.get(target, property, receiver);
                return <A extends object>(text: string, parameters: readonly unknown[] = []) => {
                  const indexBuild = Effect2.pipe(text, EffectString.startsWith(`CREATE INDEX temp.${locatorIndex}`));
                  if (indexBuild) indexAttempts += 1;
                  if (
                    failIndex
                      ? indexBuild
                      : Effect2.pipe(text, EffectString.startsWith(`INSERT INTO ${RECALL_REFRESH_SOURCE_TABLE} `))
                  ) {
                    injectedFailures += 1;
                    return target.unsafe<A>('SELECT * FROM missing_recall_source_stage_failure');
                  }
                  return target.unsafe<A>(text, parameters);
                };
              },
            });
            const result = yield* scan(failing).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  returnedCompleteInventory = true;
                }),
              ),
              Effect.exit,
            );
            expect(Exit.isFailure(result)).toBe(true);
            expect(injectedFailures).toBe(1);
            expect(indexAttempts).toBe(failIndex ? 1 : 0);
            expect(returnedCompleteInventory).toBe(false);
          }).pipe(withDatabase);
        }),
      );
    }
  });
});
