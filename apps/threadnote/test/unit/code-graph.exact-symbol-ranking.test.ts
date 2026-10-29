import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {Database} from 'bun:sqlite';
import {expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'fast-check';
import {CodeGraphStore} from '@threadnote/graph/store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';

const exactSymbol = 'runIsolatedCodeGraphIndexSnapshot';
const repositoryId = 'repository-exact-symbol-ranking';
const snapshotId = 'snapshot-exact-symbol-ranking';
const timestamp = '2026-08-27T00:00:00.000Z';
const worktreeId = 'worktree-exact-symbol-ranking';
const spanJson = JSON.stringify({column: 1, endColumn: 2, endLine: 1, line: 1});

effectIt.effect('keeps an exact variable match in a full page of boosted mutation owners', () =>
  Effect.scoped(
    queryExactSymbolRanking(10, 10).pipe(
      Effect.tap(results =>
        Effect.sync(() => {
          expect(results).toHaveLength(10);
          expect(
            EffectOption.getOrUndefined(EffectArray.findFirst(results, result => result.name === exactSymbol)),
          ).toMatchObject({score: 1});
        }),
      ),
    ),
  ).pipe(provideTestLayer(ApplicationLayer)),
);

fcEffectProp(
  effectIt,
  'keeps exact identity in bounded result pages above the lexical candidate floor',
  {
    distractorCount: FC.integer({max: 140, min: 101}),
    limit: FC.integer({max: 5, min: 1}),
  },
  ({distractorCount, limit}) =>
    Effect.scoped(
      queryExactSymbolRanking(distractorCount, limit).pipe(
        Effect.tap(results =>
          Effect.sync(() => {
            expect(EffectArray.some(results, result => result.name === exactSymbol)).toBe(true);
          }),
        ),
        Effect.asVoid,
      ),
    ).pipe(provideTestLayer(ApplicationLayer)),
  {fastCheck: {numRuns: 30}},
);

const queryExactSymbolRanking = Effect.fn('test.queryExactSymbolRanking')(function* (
  distractorCount: number,
  limit: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-exact-ranking-'});
  const databasePath = path.join(root, 'graph-v3.sqlite');
  yield* store.initialize(databasePath);
  yield* Effect.sync(() => insertExactSymbolRankingFixture(databasePath, distractorCount));
  return yield* store.searchSymbols(databasePath, snapshotId, exactSymbol, limit);
});

function insertExactSymbolRankingFixture(databasePath: string, distractorCount: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.transaction(() => {
      database
        .query(
          `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
           VALUES (?, 'exact-symbol-ranking', 'sha1', ?, ?)`,
        )
        .run(repositoryId, timestamp, timestamp);
      database
        .query(
          `INSERT INTO snapshots (
             id, repository_id, worktree_id, commit_id, extractor_set, dirty, overlay_fingerprint,
             state, file_count, symbol_count, edge_count, started_at, completed_at, failure_summary
           ) VALUES (?, ?, ?, 'commit', 'exact-symbol-ranking', 0, NULL, 'ready', 0, ?, 0, ?, ?, NULL)`,
        )
        .run(snapshotId, repositoryId, worktreeId, distractorCount + 1, timestamp, timestamp);
      const insertSymbol = database.query(`INSERT INTO symbols (
        snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
        lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
        signature, documentation, span_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'typescript', NULL, '[]', 'typescript', NULL, NULL, 1, NULL, NULL, ?)`);
      insertSymbol.run(
        snapshotId,
        'exact-symbol',
        'hash-exact-symbol',
        'variable',
        exactSymbol,
        exactSymbol,
        'src/code_graph/isolated/index.ts',
        spanJson,
      );
      const insertTerm = database.query(
        'INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight) VALUES (?, ?, ?, ?)',
      );
      for (let index = 0; index < distractorCount; index += 1) {
        const id = `mutation-owner-${index}`;
        const name = `purgeCodeGraphSnapshot${index}`;
        insertSymbol.run(
          snapshotId,
          id,
          `hash-${id}`,
          'function',
          name,
          name,
          `src/code_graph/maintenance-${index}.ts`,
          spanJson,
        );
        for (const term of ['code', 'graph', 'index', 'isolated', 'run', 'snapshot']) {
          insertTerm.run(snapshotId, term, id, 5);
        }
      }
    })();
  } finally {
    database.close(false);
  }
}
