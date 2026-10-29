import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Layer, Option, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {RECALL_REFRESH_SOURCE_TABLE, scanRecallSources} from '@threadnote/recall/index/refresh';
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
function withDatabase<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(Layer.build(database).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
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
  const scan = (sql: SqlClient.SqlClient) =>
    scanRecallSources(
      sql,
      fs,
      path,
      {account: 'acct', agentContextHome: home, user: 'allowed'},
      true,
      {
        entryKeyByUri: new Map(
          EffectArray.flatMap(expected, row =>
            row.authority_policy_key === null ? [] : [[row.uri, row.authority_policy_key]],
          ),
        ),
        sourcePathByUri: new Map(),
      },
      new Set(
        EffectArray.map(
          EffectArray.filter(expected, row => row.invalidated === 1),
          row => row.uri,
        ),
      ),
    );
  return {expected, scan};
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
