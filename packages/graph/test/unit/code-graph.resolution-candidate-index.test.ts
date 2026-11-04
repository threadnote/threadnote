import {
  candidateSynopsis,
  candidateSynopsisMayContain,
  candidateSynopsisBinding,
} from '@threadnote/graph/store/resolution/candidate_synopsis';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {vi} from 'vitest';
import * as CandidatePages from '@threadnote/graph/store/resolution/candidate_pages';
import {Array as EffectArray, Effect, Layer, Logger, References, pipe} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import * as Console from 'effect/Console';
import * as FC from 'fast-check';
import * as EffectString from 'effect/String';
import type * as Scope from 'effect/Scope';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {
  ensureResolutionCandidateIndexSchema,
  resolutionCandidateSnapshotTriggerCompatible,
  resolutionCandidateIndexSchemaReady,
  resolutionCandidateAuthorityToken,
  resolutionCandidateSnapshotFileTriggersCompatible,
  resolutionCandidateFileRepresentable,
  RESOLUTION_CANDIDATE_INDEX_TABLES,
} from '@threadnote/graph/store/resolution/candidate_index';
import {
  readCandidateReexportRow,
  selectResolutionCandidateIndexClosure,
} from '@threadnote/graph/store/resolution/candidate_index_read';
import {
  candidateIndexPages,
  finishResolutionCandidateIndex,
  stageResolutionCandidateIndex,
} from '@threadnote/graph/store/resolution/candidate_index_write';
import {
  planProjectResolutionCandidateScan,
  scanProjectResolutionCandidateClosure,
} from '@threadnote/graph/store/resolution/candidate_closure';
import type {CodeGraphFileFacts, CodeGraphReference} from '@threadnote/graph/types';
import {
  CodeGraphStore,
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
  CODE_GRAPH_RESOLUTION_SURFACE_VERSION,
  type CodeGraphDirectPersistentCapacityProtector,
} from '@threadnote/graph/store';
import {assessResolutionCandidateIncrementalClosure} from '@threadnote/graph/indexer/resolution_candidate_closure';
import {candidatePairHint} from '@threadnote/graph/store/resolution/candidate_pages';
import {CANDIDATE_PAGE_INDEXES, CANDIDATE_PAGE_TABLES} from '@threadnote/graph/store/resolution/candidate_page_schema';
import {candidateSnapshotKey} from '@threadnote/graph/store/resolution/candidate_page_store';
import {
  readCandidateKeyPages,
  readCandidateKeyWavePages,
  readCandidateFileProjection,
} from '@threadnote/graph/store/resolution/candidate_page_read';
import {resolutionCandidateFileEvidence} from '@threadnote/graph/materialization/candidate_evidence';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';

const databaseLayer = SqliteClient.layer({filename: ':memory:'});
const provideDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>) =>
  Effect.scoped(Layer.build(databaseLayer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const identity = {snapshotId: 'base', workspaceFingerprint: 'workspace', fileSetFingerprint: 'files'};
const write = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect;
const query = (key: string, snapshotId = 'base') => ({
  ...identity,
  snapshotId,
  initialLookupKeys: [{key, resolutionDomain: 'typescript'}],
  additionalReexports: [],
  maximumSelectedFiles: 128,
});

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe(`CREATE TABLE snapshots (id TEXT PRIMARY KEY, base_snapshot_id TEXT, state TEXT, extractor_set TEXT,
    graph_content_id TEXT, file_count INTEGER, symbol_count INTEGER, edge_count INTEGER, dirty INTEGER)`);
  yield* sql.unsafe(
    'CREATE TABLE snapshot_files (snapshot_id TEXT, path TEXT, content_hash TEXT, PRIMARY KEY(snapshot_id,path)) WITHOUT ROWID',
  );
  yield* sql.unsafe(`CREATE TABLE snapshot_symbol_lookup (snapshot_id TEXT, lookup_key TEXT, symbol_id TEXT,
    resolution_domain TEXT, provenance TEXT, evidence_path TEXT, PRIMARY KEY(snapshot_id,lookup_key,symbol_id)) WITHOUT ROWID`);
  yield* sql.unsafe(
    'CREATE TABLE snapshot_file_deletions (snapshot_id TEXT, path TEXT, PRIMARY KEY(snapshot_id,path)) WITHOUT ROWID',
  );
  yield* sql.unsafe(
    'CREATE TABLE snapshot_reuse_receipts (snapshot_id TEXT PRIMARY KEY, workspace_fingerprint TEXT, file_set_fingerprint TEXT, format_version INTEGER, resolution_surface_version INTEGER, extractor_set TEXT)',
  );
  yield* ensureResolutionCandidateIndexSchema(sql);
  return sql;
});

function createSnapshot(sql: SqlClient.SqlClient, id: string, paths: readonly string[], root?: string) {
  return Effect.gen(function* () {
    yield* sql`INSERT INTO snapshots VALUES (${id}, ${root ?? null}, 'ready', 'extractor', ${id}, ${paths.length}, 0, 0, 0)`;
    for (const path of paths) yield* sql`INSERT INTO snapshot_files VALUES (${id}, ${path}, ${path})`;
  });
}

function reference(path: string, key: string, aliases: readonly string[] = []): CodeGraphReference {
  return {
    edgeId: `${path}:${key}`,
    evidencePath: path,
    evidenceSpan: {line: 1, column: 1, endLine: 1, endColumn: 2},
    sourceName: path,
    targetName: key,
    relation: aliases.length ? 'reexports' : 'references',
    provenance: 'resolved',
    resolutionDomain: 'typescript',
    lookupTiers: [[key], ['unresolved-fallback']],
    ...(aliases.length ? {aliasLookupKeys: aliases} : {}),
  };
}

function stage(sql: SqlClient.SqlClient, id: string, paths: readonly string[], refs: readonly CodeGraphReference[]) {
  return stageResolutionCandidateIndex(
    sql,
    {snapshotId: id, files: EffectArray.map(paths, path => ({path, contentHash: path})), references: refs},
    write,
  );
}

describe('complete reverse resolution candidate evidence', () => {
  effectIt.effect('keeps unresolved tiers, transitive reexport consumers and direct-symbol conflicts', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const paths = ['barrel.ts', 'consumer.ts', 'unrelated.ts'];
      yield* createSnapshot(sql, 'base', paths);
      yield* stage(sql, 'base', paths, [
        reference(paths[0], 'exported', ['alias']),
        reference(paths[1], 'alias'),
        reference(paths[2], 'other'),
      ]);
      yield* sql`INSERT INTO snapshot_symbol_lookup VALUES ('base', 'alias', 'direct', 'typescript', 'symbol', 'unrelated.ts')`;
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      const result = yield* selectResolutionCandidateIndexClosure(sql, query('exported'));
      expect(result).toMatchObject({
        mode: 'eligible',
        paths: ['barrel.ts', 'consumer.ts'],
        factBytes: 0,
        scannedFiles: 0,
      });
      if (result?.mode !== 'eligible') return;
      expect(result.directAliasSymbolConflictIdentities).toEqual(new Set(['10:typescript5:alias']));
      expect(result.candidateIndex?.associationsRead).toBeGreaterThan(0);
      const unresolved = yield* selectResolutionCandidateIndexClosure(sql, query('unresolved-fallback'));
      expect(unresolved).toMatchObject({mode: 'eligible', paths});
    }).pipe(provideDatabase),
  );

  effectIt.effect('keeps both exact NUL-framed consumers and matches the complete raw-closure oracle', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const paths = ['a.ts', 'b.ts'];
      const pairs = [
        {resolutionDomain: 'a\0b', key: 'c'},
        {resolutionDomain: 'a', key: 'b\0c'},
      ];
      const refs = EffectArray.map(paths, (path, n) => ({
        ...reference(path, pairs[n].key),
        resolutionDomain: pairs[n].resolutionDomain,
        lookupTiers: [[pairs[n].key]],
      }));
      yield* createSnapshot(sql, 'base', paths);
      yield* stage(sql, 'base', paths, refs);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      const files = EffectArray.map(paths, path => ({
        path,
        contentHash: path,
        blobId: path,
        mode: '100644',
        size: 1,
        language: 'typescript',
        source: 'commit' as const,
      }));
      const facts = new Map(
        EffectArray.map(paths, (path, n) => [
          path,
          {path, symbols: [], edges: [], references: [refs[n]], diagnostics: []},
        ]),
      );
      const plan = planProjectResolutionCandidateScan({
        files,
        bytesByPath: new Map(EffectArray.map(paths, p => [p, 1])),
      });
      expect(plan.mode).toBe('eligible');
      if (plan.mode !== 'eligible') return;
      for (const keys of [pairs, [pairs[0]], [pairs[1]], [{resolutionDomain: 'a', key: 'c'}]]) {
        const indexed = yield* selectResolutionCandidateIndexClosure(sql, {
          ...query('unused'),
          initialLookupKeys: keys,
        });
        const raw = yield* scanProjectResolutionCandidateClosure({
          plan,
          initialLookupKeys: keys,
          maximumSelectedFiles: 128,
          loadPage: () => Effect.succeed({facts, bytesByPath: new Map(EffectArray.map(paths, p => [p, 1]))}),
        });
        expect(indexed?.mode).toBe('eligible');
        expect(raw.mode).toBe('eligible');
        if (indexed?.mode === 'eligible' && raw.mode === 'eligible') {
          const expected = EffectArray.filter(paths, (_, n) =>
            EffectArray.some(keys, k => k.resolutionDomain === pairs[n].resolutionDomain && k.key === pairs[n].key),
          );
          expect(indexed.paths).toEqual(expected);
          expect(indexed.paths).toEqual(raw.paths);
          expect(indexed.affectedAliasLookupIdentities).toEqual(raw.affectedAliasLookupIdentities);
        }
      }
    }).pipe(provideDatabase),
  );

  effectIt.effect(
    'admits complete UTF8 reexport cursor plus payload BEFORE hydration at the remaining shared-byte boundary',
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* createSnapshot(sql, 'base', ['barrel.ts']);
        yield* stage(
          sql,
          'base',
          ['barrel.ts'],
          [
            {...reference('barrel.ts', 'key', ['alias']), edgeId: 'a'},
            {...reference('barrel.ts', 'key', ['alias']), edgeId: 'é😀'},
          ],
        );
        const originals = yield* sql<{
          readonly edge_id: string;
          readonly payload_json: string;
        }>`SELECT edge_id,payload_json FROM snapshot_candidate_reexports ORDER BY edge_id`;
        let hydrated = 0,
          queries = 0;
        const observed = new Proxy(sql, {
          get(target, key, receiver) {
            if (key === 'unsafe')
              return (...args: Parameters<typeof sql.unsafe>) =>
                target.unsafe(...args).pipe(
                  Effect.tap(rows =>
                    Effect.sync(() => {
                      queries++;
                      for (const row of rows)
                        if (
                          ('payload_json' in row && row.payload_json !== null) ||
                          ('edge_id' in row && row.edge_id !== null)
                        )
                          hydrated++;
                    }),
                  ),
                );
            return Reflect.get(target, key, receiver);
          },
        });
        for (let n = 0; n < originals.length; n++) {
          const row = originals[n];
          const bytes = 192 + Buffer.byteLength(row.edge_id) + Buffer.byteLength(row.payload_json);
          const after = n === 0 ? undefined : originals[n - 1].edge_id;
          hydrated = 0;
          expect(yield* readCandidateReexportRow(observed, 'base', 'barrel.ts', undefined, after, bytes - 1)).toEqual({
            bytes,
            exceeded: true,
          });
          expect(hydrated).toBe(0); // SQL CASE returned neither the complete cursor nor the payload.
          expect(yield* readCandidateReexportRow(observed, 'base', 'barrel.ts', undefined, after, bytes)).toEqual({
            bytes,
            row,
          });
          expect(hydrated).toBe(1);
        }
        expect(Buffer.byteLength(originals[1].edge_id)).toBe(6);
        const before = queries;
        expect(yield* readCandidateReexportRow(observed, 'base', 'barrel.ts', undefined, undefined, 191)).toEqual({
          bytes: 192,
          exceeded: true,
        });
        expect(queries).toBe(before);
        const huge = EffectString.repeat(8 * 1048576)('x');
        yield* sql`UPDATE snapshot_candidate_reexports SET payload_json = ${huge} WHERE edge_id = 'a'`;
        hydrated = 0;
        expect(yield* readCandidateReexportRow(observed, 'base', 'barrel.ts', undefined, undefined, 193)).toEqual({
          bytes: 192 + 1 + 8 * 1048576,
          exceeded: true,
        });
        expect(hydrated).toBe(0);
      }).pipe(provideDatabase),
  );

  effectIt.effect('refuses partial pages, changed rows, stale versions and missing legacy evidence', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* createSnapshot(sql, 'base', ['a.ts', 'b.ts']);
      yield* stage(sql, 'base', ['a.ts'], [reference('a.ts', 'a')]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('a'))).toBeUndefined();
      yield* stage(sql, 'base', ['b.ts'], [reference('b.ts', 'b')]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      yield* sql`DELETE FROM snapshot_candidate_synopsis_pages WHERE file_key IN
        (SELECT file_key FROM snapshot_candidate_synopsis_files WHERE path = 'b.ts')`;
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('b'))).toBeUndefined();
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
      yield* createSnapshot(sql, 'legacy', ['old.ts']);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('old', 'legacy'))).toBeUndefined();
    }).pipe(provideDatabase),
  );

  effectIt.effect(
    'invalidates proof under old-writer file or lookup mutation, but preserves retained-root retirement',
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* createSnapshot(sql, 'base', ['a.ts']);
        yield* stage(sql, 'base', ['a.ts'], [reference('a.ts', 'a')]);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        yield* sql`UPDATE snapshots SET state = 'retired' WHERE id = 'base'`;
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('a'))).toMatchObject({
          mode: 'eligible',
          paths: ['a.ts'],
        });
        yield* sql`INSERT INTO snapshot_symbol_lookup VALUES ('base', 'a', 'symbol', 'typescript', 'symbol', 'a.ts')`;
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('a'))).toBeUndefined();
      }).pipe(provideDatabase),
  );

  effectIt.effect('composes repeated deltas over a retained retired root and masks replaced references', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const paths = ['a.ts', 'b.ts', 'c.ts'];
      yield* createSnapshot(sql, 'base', paths);
      yield* stage(sql, 'base', paths, [reference('a.ts', 'old'), reference('b.ts', 'stable')]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      yield* createSnapshot(sql, 'first', ['a.ts'], 'base');
      yield* sql`UPDATE snapshots SET file_count = 3 WHERE id = 'first'`;
      yield* stage(sql, 'first', ['a.ts'], [reference('a.ts', 'new')]);
      expect(yield* finishResolutionCandidateIndex(sql, {...identity, snapshotId: 'first'}, write)).toBe(true);
      yield* sql`UPDATE snapshots SET state = 'retired' WHERE id = 'base'`;
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('old', 'first'))).toMatchObject({
        mode: 'eligible',
        paths: [],
      });
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('new', 'first'))).toMatchObject({
        mode: 'eligible',
        paths: ['a.ts'],
      });
      yield* createSnapshot(sql, 'second', ['a.ts', 'c.ts'], 'base');
      yield* sql`UPDATE snapshots SET file_count = 3 WHERE id = 'second'`;
      yield* stage(sql, 'second', ['c.ts'], [reference('c.ts', 'second')]);
      expect(
        yield* finishResolutionCandidateIndex(
          sql,
          {...identity, snapshotId: 'second', inheritedSnapshotId: 'first'},
          write,
        ),
      ).toBe(true);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('new', 'second'))).toMatchObject({
        mode: 'eligible',
        paths: ['a.ts'],
      });
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('stable', 'second'))).toMatchObject({
        mode: 'eligible',
        paths: ['b.ts'],
      });
      yield* sql`DELETE FROM snapshot_candidate_synopsis_pages WHERE file_key IN
        (SELECT file_key FROM snapshot_candidate_synopsis_files WHERE path = 'b.ts')`;
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('new', 'second'))).toBeUndefined();
    }).pipe(provideDatabase),
  );

  effectIt.effect('keeps an interrupted transaction from publishing partial negative evidence', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* createSnapshot(sql, 'base', ['a.ts']);
      const outcome = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* stage(sql, 'base', ['a.ts'], [reference('a.ts', 'a')]);
            return yield* Effect.fail('interrupt-before-completion');
          }),
        ),
      );
      expect(outcome._tag).toBe('Failure');
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('a'))).toBeUndefined();
    }).pipe(provideDatabase),
  );

  effectIt.effect(
    'requires the exact alias receipt and optional mutation trigger, including after root retirement',
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* createSnapshot(sql, 'base', ['a.ts']);
        yield* stage(sql, 'base', ['a.ts'], [reference('a.ts', 'value')]);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        yield* createSnapshot(sql, 'alias', [], 'base');
        yield* sql`UPDATE snapshots SET file_count = 1 WHERE id = 'alias'`;
        yield* sql`INSERT INTO snapshot_reuse_receipts VALUES ('alias', 'workspace', 'files',
        ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}, ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}, 'extractor')`;
        yield* sql`UPDATE snapshots SET state = 'retired' WHERE id = 'base'`;
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('value', 'alias'))).toMatchObject({
          mode: 'eligible',
          paths: ['a.ts'],
        });
        yield* sql`UPDATE snapshot_reuse_receipts SET resolution_surface_version = -1 WHERE snapshot_id = 'alias'`;
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('value', 'alias'))).toBeUndefined();
        expect(yield* resolutionCandidateSnapshotTriggerCompatible(sql)).toBe(true);
        yield* sql.unsafe('DROP TRIGGER snapshots_candidate_invalidate_update');
        yield* sql.unsafe(
          'CREATE TRIGGER snapshots_candidate_invalidate_update AFTER UPDATE ON snapshots BEGIN SELECT 1; END',
        );
        expect(yield* resolutionCandidateSnapshotTriggerCompatible(sql)).toBe(false);
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toBeUndefined();
      }).pipe(provideDatabase),
  );

  for (const loss of [
    'lookup-table',
    'reexport-table',
    'lookup-trigger',
    'reexport-trigger',
    'generation-table',
    'authority-table',
  ] as const) {
    effectIt.effect(`revokes old completeness atomically after reconstructing ${loss}`, () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* createSnapshot(sql, 'base', ['a.ts']);
        const refs = [reference('a.ts', 'value', ['alias'])];
        yield* stage(sql, 'base', ['a.ts'], refs);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        const oldToken = yield* resolutionCandidateAuthorityToken(sql);
        if (loss === 'generation-table') yield* sql.unsafe('DROP TABLE snapshot_candidate_generations');
        else if (loss === 'authority-table') yield* sql.unsafe('DROP TABLE snapshot_candidate_authority');
        else if (loss === 'lookup-table') yield* sql.unsafe('DROP TABLE snapshot_candidate_lookup');
        else if (loss === 'reexport-table') yield* sql.unsafe('DROP TABLE snapshot_candidate_reexports');
        else if (loss === 'lookup-trigger') {
          yield* sql.unsafe('DROP TRIGGER snapshot_candidate_lookup_candidate_invalidate_delete');
          yield* sql`DELETE FROM snapshot_candidate_lookup WHERE snapshot_id = 'base'`;
        } else {
          yield* sql.unsafe('DROP TRIGGER snapshot_candidate_reexports_candidate_invalidate_delete');
          yield* sql`DELETE FROM snapshot_candidate_reexports WHERE snapshot_id = 'base'`;
        }
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toBeUndefined();
        const before = yield* sql`SELECT * FROM snapshot_candidate_files`;
        const receipts = yield* sql`SELECT * FROM snapshot_candidate_receipts`;
        expect(yield* ensureResolutionCandidateIndexSchema(sql)).toBe(true);
        expect(yield* resolutionCandidateAuthorityToken(sql)).not.toBe(oldToken);
        expect(yield* sql`SELECT * FROM snapshot_candidate_files`).toEqual(before);
        expect(yield* sql`SELECT * FROM snapshot_candidate_receipts`).toEqual(receipts);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toBeUndefined();
        yield* stage(sql, 'base', ['a.ts'], refs);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toMatchObject({
          mode: 'eligible',
          paths: ['a.ts'],
        });
      }).pipe(provideDatabase),
    );
  }

  effectIt.effect('bounds known schema SQL before decoding and preserves failed repair atomically', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* createSnapshot(sql, 'base', ['a.ts']);
      yield* stage(sql, 'base', ['a.ts'], [reference('a.ts', 'value')]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      yield* sql.unsafe('DROP TRIGGER snapshots_candidate_invalidate_update');
      yield* sql.unsafe(
        `CREATE TRIGGER snapshots_candidate_invalidate_update AFTER UPDATE ON snapshots BEGIN SELECT '${pipe('x', EffectString.repeat(8193))}'; END`,
      );
      expect(yield* resolutionCandidateSnapshotTriggerCompatible(sql)).toBe(false);
      expect(yield* resolutionCandidateIndexSchemaReady(sql)).toBe(false);
      const repaired = yield* Effect.exit(ensureResolutionCandidateIndexSchema(sql));
      expect(repaired._tag).toBe('Failure');
      expect((yield* sql`SELECT 1 FROM snapshots WHERE state = 'ready'`).length).toBe(1);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toBeUndefined();
    }).pipe(provideDatabase),
  );

  effectIt.effect('admits only exact optional file invalidation triggers across schema observations', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      expect(yield* resolutionCandidateSnapshotFileTriggersCompatible(sql)).toBe(true);
      yield* sql.unsafe('CREATE TRIGGER unrelated_file_trigger AFTER UPDATE ON snapshot_files BEGIN SELECT 1; END');
      expect(yield* resolutionCandidateSnapshotFileTriggersCompatible(sql)).toBe(false);
      yield* sql.unsafe('DROP TRIGGER unrelated_file_trigger');
      yield* sql.unsafe('DROP TRIGGER snapshot_files_candidate_invalidate_update');
      expect(yield* resolutionCandidateSnapshotFileTriggersCompatible(sql)).toBe(true);
      expect(yield* resolutionCandidateIndexSchemaReady(sql)).toBe(false);
      yield* sql.unsafe(
        `CREATE TRIGGER snapshot_files_candidate_invalidate_update AFTER UPDATE ON snapshot_files BEGIN SELECT '${pipe('x', EffectString.repeat(8193))}'; END`,
      );
      expect(yield* resolutionCandidateSnapshotFileTriggersCompatible(sql)).toBe(false);
    }).pipe(provideDatabase),
  );

  effectIt.effect('reports an unrepresentable batch row through the typed Effect failure channel', () =>
    Effect.gen(function* () {
      const failure = yield* candidateIndexPages(['oversized'], () => 8 * 1_048_576 + 1).pipe(Effect.flip);
      expect(failure._tag).toBe('CodeGraphStoreError');
    }),
  );

  effectIt.effect('does not seal a canonical file prefix with extra retained pages', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* createSnapshot(sql, 'base', ['a.ts']);
      yield* stage(sql, 'base', ['a.ts'], [reference('a.ts', 'value')]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      yield* sql`UPDATE snapshot_candidate_synopsis_files SET sealed = 0 WHERE path = 'a.ts'`;
      yield* sql`INSERT INTO snapshot_candidate_synopsis_pages SELECT snapshot_key,file_key,ordinal + 1,entry_count,raw_bytes,stored_bytes,
          original_tuple_bytes,raw_sha,stored_sha,codec,synopsis,synopsis_sha,payload,literal_domain,literal_key FROM snapshot_candidate_synopsis_pages`;
      const failure = yield* stage(sql, 'base', ['a.ts'], [reference('a.ts', 'value')]).pipe(Effect.flip);
      expect(failure).toMatchObject({_tag: 'CodeGraphStoreError'});
      expect(
        yield* sql`SELECT complete FROM snapshot_candidate_files WHERE snapshot_id = 'base' AND path = 'a.ts'`,
      ).toEqual([{complete: 0}]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toBeUndefined();
    }).pipe(provideDatabase),
  );

  for (const drift of ['extra-column-check', 'oversized-definition', 'case-variant-name'] as const) {
    effectIt.effect(`refuses incompatible populated lookup ${drift} before any index creation`, () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        const paths = Array.from({length: 1507}, (_, n) => `incompatible-${n}.ts`);
        yield* createSnapshot(sql, 'base', paths);
        yield* stage(
          sql,
          'base',
          paths,
          EffectArray.map(paths, path => reference(path, path)),
        );
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        yield* sql.unsafe('DROP INDEX snapshot_candidate_lookup_path');
        if (drift === 'case-variant-name') {
          yield* sql.unsafe('ALTER TABLE snapshot_candidate_lookup RENAME TO renamed_candidate_lookup');
          yield* sql.unsafe('ALTER TABLE renamed_candidate_lookup RENAME TO SNAPSHOT_CANDIDATE_LOOKUP');
        } else {
          const check = drift === 'oversized-definition' ? ` AND '${pipe('x', EffectString.repeat(8193))}' <> ''` : '';
          yield* sql.unsafe(
            `ALTER TABLE snapshot_candidate_lookup ADD COLUMN extra TEXT CHECK (extra IS NULL${check})`,
          );
        }
        const beforeLookup =
          yield* sql`SELECT * FROM snapshot_candidate_lookup ORDER BY snapshot_id, resolution_domain, lookup_key, evidence_path`;
        const beforeFiles = yield* sql`SELECT * FROM snapshot_candidate_files ORDER BY snapshot_id, path`;
        const beforeReceipts = yield* sql`SELECT * FROM snapshot_candidate_receipts ORDER BY snapshot_id`;
        const beforeBindings =
          yield* sql`SELECT * FROM snapshot_candidate_generations ORDER BY snapshot_id, kind, path`;
        const beforeAuthority = yield* sql`SELECT * FROM snapshot_candidate_authority`;
        const beforeSchema = yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
        let ddlAttempts = 0;
        const guarded = new Proxy(sql, {
          get(target, key, receiver) {
            if (key !== 'unsafe') return Reflect.get(target, key, receiver);
            return (text: string, parameters: readonly unknown[] = []) => {
              if (/^\s*(?:CREATE|DROP|ALTER)\b/iu.test(text)) {
                ddlAttempts += 1;
                return Effect.die('Incompatible lookup must refuse before DDL, including hidden index rebuild');
              }
              return sql.unsafe(text, parameters);
            };
          },
        });
        const failure = yield* ensureResolutionCandidateIndexSchema(guarded).pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: 'CodeGraphStoreError',
          message: 'Resolution candidate index schema is incompatible.',
        });
        expect(ddlAttempts).toBe(0);
        expect(
          yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'snapshot_candidate_lookup_path' COLLATE NOCASE`,
        ).toEqual([]);
        expect(
          yield* sql`SELECT * FROM snapshot_candidate_lookup ORDER BY snapshot_id, resolution_domain, lookup_key, evidence_path`,
        ).toEqual(beforeLookup);
        expect(yield* sql`SELECT * FROM snapshot_candidate_files ORDER BY snapshot_id, path`).toEqual(beforeFiles);
        expect(yield* sql`SELECT * FROM snapshot_candidate_receipts ORDER BY snapshot_id`).toEqual(beforeReceipts);
        expect(yield* sql`SELECT * FROM snapshot_candidate_generations ORDER BY snapshot_id, kind, path`).toEqual(
          beforeBindings,
        );
        expect(yield* sql`SELECT * FROM snapshot_candidate_authority`).toEqual(beforeAuthority);
        expect(yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).toEqual(beforeSchema);
        expect(yield* selectResolutionCandidateIndexClosure(sql, query(paths[0]))).toBeUndefined();
      }).pipe(provideDatabase),
    );
  }

  effectIt.effect('recreates a missing path index only when its canonical lookup table is empty', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* sql.unsafe('DROP INDEX snapshot_candidate_lookup_path');
      expect(yield* ensureResolutionCandidateIndexSchema(sql)).toBe(true);
      expect(yield* resolutionCandidateIndexSchemaReady(sql)).toBe(true);
      expect(
        (yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'snapshot_candidate_lookup_path'`)
          .length,
      ).toBe(1);
    }).pipe(provideDatabase),
  );

  effectIt.effect('blocks populated missing-index recovery without rebuilding or touching retained proof', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const paths = Array.from({length: 1507}, (_, n) => `indexed-${n}.ts`);
      const references = EffectArray.map(paths, path => reference(path, path));
      yield* createSnapshot(sql, 'base', paths);
      for (const path of paths)
        yield* sql`INSERT INTO snapshot_candidate_lookup VALUES ('base','typescript',${path},${path})`;
      yield* stage(sql, 'base', paths, references);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      const beforeFiles = yield* sql`SELECT * FROM snapshot_candidate_files ORDER BY snapshot_id, path`;
      const beforeLookup =
        yield* sql`SELECT * FROM snapshot_candidate_lookup ORDER BY snapshot_id, resolution_domain, lookup_key, evidence_path`;
      const beforeBindings = yield* sql`SELECT * FROM snapshot_candidate_generations ORDER BY snapshot_id, kind, path`;
      const beforeReceipts = yield* sql`SELECT * FROM snapshot_candidate_receipts ORDER BY snapshot_id`;
      const oldToken = yield* resolutionCandidateAuthorityToken(sql);
      yield* sql.unsafe('DROP INDEX snapshot_candidate_lookup_path');
      const guarded = new Proxy(sql, {
        get(target, key, receiver) {
          if (key !== 'unsafe') return Reflect.get(target, key, receiver);
          return (text: string, parameters: readonly unknown[] = []) => {
            expect(pipe(text, EffectString.includes('CREATE INDEX IF NOT EXISTS snapshot_candidate_lookup_path'))).toBe(
              false,
            );
            return sql.unsafe(text, parameters);
          };
        },
      });
      expect(yield* ensureResolutionCandidateIndexSchema(guarded)).toBe(true);
      const blocked = yield* sql`SELECT token, state FROM snapshot_candidate_authority`;
      expect(blocked).toMatchObject([{state: 'blocked'}]);
      expect(blocked[0]?.token).not.toBe(oldToken);
      expect(yield* resolutionCandidateAuthorityToken(sql)).toBeUndefined();
      expect(yield* resolutionCandidateIndexSchemaReady(sql)).toBe(false);
      expect(yield* ensureResolutionCandidateIndexSchema(guarded)).toBe(false);
      expect(yield* sql`SELECT token, state FROM snapshot_candidate_authority`).toEqual(blocked);
      const noWrite = <A, E, R>(_effect: Effect.Effect<A, E, R>) =>
        Effect.die('Blocked optional evidence must not write');
      yield* stageResolutionCandidateIndex(
        guarded,
        {
          snapshotId: 'base',
          files: EffectArray.map(paths, path => ({path, contentHash: path})),
          references,
        },
        noWrite,
      );
      expect(yield* finishResolutionCandidateIndex(guarded, identity, noWrite)).toBe(false);
      expect(yield* selectResolutionCandidateIndexClosure(guarded, query(paths[0]))).toBeUndefined();
      expect(yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'snapshot_candidate_lookup_path'`).toEqual([]);
      expect(yield* sql`SELECT * FROM snapshot_candidate_files ORDER BY snapshot_id, path`).toEqual(beforeFiles);
      expect(
        yield* sql`SELECT * FROM snapshot_candidate_lookup ORDER BY snapshot_id, resolution_domain, lookup_key, evidence_path`,
      ).toEqual(beforeLookup);
      expect(yield* sql`SELECT * FROM snapshot_candidate_generations ORDER BY snapshot_id, kind, path`).toEqual(
        beforeBindings,
      );
      expect(yield* sql`SELECT * FROM snapshot_candidate_receipts ORDER BY snapshot_id`).toEqual(beforeReceipts);
      // Only explicit canonical restoration can re-enable bounded restaging; it cannot revive the old generation.
      yield* sql.unsafe(
        'CREATE INDEX snapshot_candidate_lookup_path ON snapshot_candidate_lookup(snapshot_id, evidence_path, resolution_domain, lookup_key)',
      );
      expect(yield* ensureResolutionCandidateIndexSchema(sql)).toBe(true);
      expect(yield* resolutionCandidateAuthorityToken(sql)).not.toBe(oldToken);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query(paths[0]))).toBeUndefined();
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
      yield* stage(sql, 'base', paths, references);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query(paths[0]))).toMatchObject({
        mode: 'eligible',
        paths: [paths[0]],
      });
    }).pipe(provideDatabase),
  );

  effectIt.effect('revokes large retained proof with one authority write and no bulk receipt or file mutation', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const paths = Array.from({length: 1507}, (_, n) => `retained-${n}.ts`);
      for (const id of ['base', 'other']) {
        yield* createSnapshot(sql, id, paths);
        yield* stage(sql, id, paths, [reference(paths[0], 'value')]);
        expect(yield* finishResolutionCandidateIndex(sql, {...identity, snapshotId: id}, write)).toBe(true);
      }
      const oldToken = yield* resolutionCandidateAuthorityToken(sql);
      const beforeFiles = yield* sql`SELECT * FROM snapshot_candidate_files ORDER BY snapshot_id, path`;
      const beforeReceipts = yield* sql`SELECT * FROM snapshot_candidate_receipts ORDER BY snapshot_id`;
      const beforeBindings = yield* sql`SELECT * FROM snapshot_candidate_generations ORDER BY snapshot_id, kind, path`;
      yield* sql.unsafe('CREATE TEMP TABLE candidate_write_audit (kind TEXT NOT NULL)');
      yield* sql.unsafe(
        "CREATE TEMP TRIGGER no_receipt_reset BEFORE DELETE ON snapshot_candidate_receipts BEGIN SELECT RAISE(ABORT, 'receipt reset forbidden'); END",
      );
      yield* sql.unsafe(
        "CREATE TEMP TRIGGER no_file_reset BEFORE UPDATE ON snapshot_candidate_files BEGIN SELECT RAISE(ABORT, 'file reset forbidden'); END",
      );
      yield* sql.unsafe(
        "CREATE TEMP TRIGGER audit_authority AFTER UPDATE ON snapshot_candidate_authority BEGIN INSERT INTO candidate_write_audit VALUES ('authority'); END",
      );
      yield* sql.unsafe('DROP TRIGGER snapshot_candidate_lookup_candidate_invalidate_delete');
      expect(yield* ensureResolutionCandidateIndexSchema(sql)).toBe(true);
      expect(yield* resolutionCandidateAuthorityToken(sql)).not.toBe(oldToken);
      expect(yield* sql`SELECT kind FROM candidate_write_audit`).toEqual([{kind: 'authority'}]);
      expect(yield* sql`SELECT * FROM snapshot_candidate_files ORDER BY snapshot_id, path`).toEqual(beforeFiles);
      expect(yield* sql`SELECT * FROM snapshot_candidate_receipts ORDER BY snapshot_id`).toEqual(beforeReceipts);
      expect(yield* sql`SELECT * FROM snapshot_candidate_generations ORDER BY snapshot_id, kind, path`).toEqual(
        beforeBindings,
      );
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toBeUndefined();
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
      yield* sql.unsafe('DROP TRIGGER no_receipt_reset');
      yield* sql.unsafe('DROP TRIGGER no_file_reset');
      yield* sql.unsafe(
        "CREATE TEMP TRIGGER audit_file_update AFTER UPDATE ON snapshot_candidate_files BEGIN INSERT INTO candidate_write_audit VALUES ('file'); END",
      );
      yield* sql.unsafe(
        "CREATE TEMP TRIGGER audit_binding_insert AFTER INSERT ON snapshot_candidate_generations BEGIN INSERT INTO candidate_write_audit VALUES ('binding'); END",
      );
      yield* sql.unsafe(
        "CREATE TEMP TRIGGER audit_binding_update AFTER UPDATE ON snapshot_candidate_generations BEGIN INSERT INTO candidate_write_audit VALUES ('binding'); END",
      );
      let maximumFiles = 0;
      let maximumBindings = 0;
      let pages = 0;
      const boundedWriter = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM candidate_write_audit`;
            const value = yield* effect;
            const counts = yield* sql<{
              readonly kind: string;
              readonly count: number;
            }>`SELECT kind, COUNT(*) AS count FROM candidate_write_audit GROUP BY kind`;
            for (const row of counts) {
              if (row.kind === 'file') {
                expect(row.count).toBeLessThanOrEqual(1000);
                maximumFiles = Math.max(maximumFiles, row.count);
              }
              if (row.kind === 'binding') {
                expect(row.count).toBeLessThanOrEqual(1000);
                maximumBindings = Math.max(maximumBindings, row.count);
              }
            }
            pages += 1;
            return value;
          }),
        );
      const protector: CodeGraphDirectPersistentCapacityProtector = (boundary, effect) =>
        Effect.sync(() => {
          expect(boundary.rowCount).toBeLessThanOrEqual(3001);
        }).pipe(Effect.andThen(effect));
      yield* stageResolutionCandidateIndex(
        sql,
        {
          snapshotId: 'base',
          files: EffectArray.map(paths, path => ({path, contentHash: path})),
          references: [reference(paths[0], 'value')],
        },
        boundedWriter,
        protector,
      );
      // Shared batches count metadata + seal operations, not only one file table. Original 1,000-row guards remain.
      expect(maximumFiles).toBe(333);
      expect(maximumBindings).toBe(167);
      expect(pages).toBeGreaterThan(2);
      expect(yield* finishResolutionCandidateIndex(sql, identity, boundedWriter, protector)).toBe(true);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toMatchObject({
        mode: 'eligible',
        paths: [paths[0]],
      });
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('value', 'other'))).toBeUndefined();
    }).pipe(provideDatabase),
  );

  effectIt.effect(
    'invalidates receipt proof when file bindings change and publishes receipt binding before its receipt',
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* createSnapshot(sql, 'base', ['a.ts']);
        const refs = [reference('a.ts', 'value')];
        yield* stage(sql, 'base', ['a.ts'], refs);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        yield* sql`DELETE FROM snapshot_candidate_generations WHERE snapshot_id = 'base' AND kind = 'file'`;
        expect((yield* sql`SELECT 1 FROM snapshot_candidate_receipts`).length).toBe(0);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
        yield* stage(sql, 'base', ['a.ts'], refs);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        yield* sql`UPDATE snapshot_candidate_generations SET authority_token = 'stale' WHERE snapshot_id = 'base' AND kind = 'file'`;
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toBeUndefined();
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
        yield* stage(sql, 'base', ['a.ts'], refs);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        expect((yield* sql`SELECT 1 FROM snapshot_candidate_receipts`).length).toBe(1);
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toMatchObject({
          mode: 'eligible',
          paths: ['a.ts'],
        });
      }).pipe(provideDatabase),
  );

  effectIt.effect('seeks exact source bindings from each bounded terminal VALUES row before completion', () =>
    Effect.gen(function* () {
      const original = yield* setup;
      const plans: string[][] = [];
      const sql = new Proxy(original, {
        get(target, key, receiver) {
          if (key !== 'unsafe') return Reflect.get(target, key, receiver);
          return (text: string, parameters: readonly unknown[] = []) => {
            if (!EffectString.startsWith('WITH expected(file_key,path,content_hash')(text))
              return original.unsafe(text, parameters);
            return Effect.gen(function* () {
              const plan = yield* original.unsafe<{readonly detail: string}>(`EXPLAIN QUERY PLAN ${text}`, parameters);
              plans.push(EffectArray.map(plan, row => row.detail));
              return yield* original.unsafe(text, parameters);
            });
          };
        },
      });
      const paths = Array.from({length: 365}, (_, n) => `binding-${n}.ts`);
      yield* createSnapshot(sql, 'base', paths);
      yield* stage(
        sql,
        'base',
        paths,
        EffectArray.map(paths, path => reference(path, path)),
      );
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      expect(plans.length).toBeGreaterThan(1);
      for (const details of plans) {
        expect(details).toContain('SCAN expected');
        for (const alias of ['file', 'source', 'owner', 'legacy']) {
          expect(EffectArray.some(details, detail => EffectString.startsWith(`SEARCH ${alias} USING `)(detail))).toBe(
            true,
          );
          expect(EffectArray.some(details, detail => EffectString.startsWith(`SCAN ${alias}`)(detail))).toBe(false);
        }
      }
      expect(yield* selectResolutionCandidateIndexClosure(sql, query(paths[0]))).toMatchObject({
        mode: 'eligible',
        paths: [paths[0]],
      });
    }).pipe(provideDatabase),
  );

  effectIt.effect('refuses generation rotation during stage and finish until complete canonical restaging', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* createSnapshot(sql, 'base', ['a.ts']);
      const refs = [reference('a.ts', 'value')];
      let calls = 0;
      const rotatingStageWriter = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          if (++calls === 2) {
            yield* sql.unsafe('DROP TRIGGER snapshot_candidate_lookup_candidate_invalidate_delete');
            yield* ensureResolutionCandidateIndexSchema(sql);
          }
          return yield* effect;
        });
      yield* stageResolutionCandidateIndex(
        sql,
        {snapshotId: 'base', files: [{path: 'a.ts', contentHash: 'a.ts'}], references: refs},
        rotatingStageWriter,
      );
      expect(calls).toBe(2);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
      yield* stage(sql, 'base', ['a.ts'], refs);
      const rotatingFinishWriter = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          yield* sql.unsafe('DROP TRIGGER snapshot_candidate_lookup_candidate_invalidate_delete');
          yield* ensureResolutionCandidateIndexSchema(sql);
          return yield* effect;
        });
      expect(yield* finishResolutionCandidateIndex(sql, identity, rotatingFinishWriter)).toBe(false);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toBeUndefined();
      yield* stage(sql, 'base', ['a.ts'], refs);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
    }).pipe(provideDatabase),
  );

  effectIt.effect('revokes retained root, clean alias and inherited delta admission on authority loss', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* createSnapshot(sql, 'base', ['a.ts', 'b.ts']);
      yield* stage(sql, 'base', ['a.ts', 'b.ts'], [reference('a.ts', 'root')]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      yield* createSnapshot(sql, 'alias', [], 'base');
      yield* sql`UPDATE snapshots SET file_count = 2 WHERE id = 'alias'`;
      yield* sql`INSERT INTO snapshot_reuse_receipts VALUES ('alias', 'workspace', 'files', ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}, ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}, 'extractor')`;
      yield* createSnapshot(sql, 'delta', ['b.ts'], 'base');
      yield* sql`UPDATE snapshots SET file_count = 2 WHERE id = 'delta'`;
      yield* stage(sql, 'delta', ['b.ts'], [reference('b.ts', 'delta')]);
      expect(yield* finishResolutionCandidateIndex(sql, {...identity, snapshotId: 'delta'}, write)).toBe(true);
      const before = yield* resolutionCandidateAuthorityToken(sql);
      yield* sql.unsafe('DROP TABLE snapshot_candidate_authority');
      yield* ensureResolutionCandidateIndexSchema(sql);
      expect(yield* resolutionCandidateAuthorityToken(sql)).not.toBe(before);
      for (const id of ['base', 'alias', 'delta'])
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('root', id))).toBeUndefined();
      yield* stage(sql, 'base', ['a.ts', 'b.ts'], [reference('a.ts', 'root')]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('root', 'alias'))).toMatchObject({
        mode: 'eligible',
        paths: ['a.ts'],
      });
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('delta', 'delta'))).toBeUndefined();
      yield* stage(sql, 'delta', ['b.ts'], [reference('b.ts', 'delta')]);
      expect(yield* finishResolutionCandidateIndex(sql, {...identity, snapshotId: 'delta'}, write)).toBe(true);
    }).pipe(provideDatabase),
  );

  effectIt.effect('adds generation authority to exact legacy tables without rewriting their retained evidence', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* createSnapshot(sql, 'base', ['a.ts']);
      const refs = [reference('a.ts', 'value')];
      yield* stage(sql, 'base', ['a.ts'], refs);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      yield* sql.unsafe('DROP TABLE snapshot_candidate_generations');
      yield* sql.unsafe('DROP TABLE snapshot_candidate_authority');
      yield* sql.unsafe('DROP TRIGGER snapshots_candidate_invalidate_update');
      yield* sql.unsafe(`CREATE TRIGGER snapshots_candidate_invalidate_update AFTER UPDATE ON snapshots
        WHEN NEW.state NOT IN ('ready', 'retired') OR OLD.extractor_set IS NOT NEW.extractor_set
          OR OLD.graph_content_id IS NOT NEW.graph_content_id OR OLD.base_snapshot_id IS NOT NEW.base_snapshot_id
          OR OLD.file_count IS NOT NEW.file_count OR OLD.symbol_count IS NOT NEW.symbol_count OR OLD.edge_count IS NOT NEW.edge_count
        BEGIN DELETE FROM snapshot_candidate_receipts WHERE snapshot_id = OLD.id; END`);
      // Reconstruct the pre-generation receipt format exactly; it has no authority binding.
      yield* sql`INSERT OR REPLACE INTO snapshot_candidate_receipts VALUES ('base', 1, NULL, 'extractor', 'base', 'workspace', 'files', 1)`;
      const oldFiles = yield* sql`SELECT * FROM snapshot_candidate_files`;
      const oldLookups = yield* sql`SELECT * FROM snapshot_candidate_lookup`;
      const oldReceipt = yield* sql`SELECT * FROM snapshot_candidate_receipts`;
      expect(yield* ensureResolutionCandidateIndexSchema(sql)).toBe(true);
      const upgraded = (yield* sql<{
        readonly sql: string;
      }>`SELECT sql FROM sqlite_master WHERE name = 'snapshots_candidate_invalidate_update'`)[0].sql;
      expect(upgraded).toContain('DELETE FROM snapshot_candidate_generations');
      expect(yield* sql`SELECT * FROM snapshot_candidate_files`).toEqual(oldFiles);
      expect(yield* sql`SELECT * FROM snapshot_candidate_lookup`).toEqual(oldLookups);
      expect(yield* sql`SELECT * FROM snapshot_candidate_receipts`).toEqual(oldReceipt);
      expect((yield* sql`SELECT 1 FROM snapshot_candidate_generations`).length).toBe(0);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toBeUndefined();
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
      yield* stage(sql, 'base', ['a.ts'], refs);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toMatchObject({
        mode: 'eligible',
        paths: ['a.ts'],
      });
    }).pipe(provideDatabase),
  );

  effectIt.effect(
    'refuses authority rotation during inherited delta copying without publishing mixed-generation proof',
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* createSnapshot(sql, 'base', ['a.ts', 'b.ts']);
        yield* stage(sql, 'base', ['a.ts', 'b.ts'], [reference('a.ts', 'root')]);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        yield* createSnapshot(sql, 'first', ['a.ts'], 'base');
        yield* sql`UPDATE snapshots SET file_count = 2 WHERE id = 'first'`;
        yield* stage(sql, 'first', ['a.ts'], [reference('a.ts', 'first')]);
        expect(yield* finishResolutionCandidateIndex(sql, {...identity, snapshotId: 'first'}, write)).toBe(true);
        yield* createSnapshot(sql, 'second', ['a.ts', 'b.ts'], 'base');
        yield* sql`UPDATE snapshots SET file_count = 2 WHERE id = 'second'`;
        yield* stage(sql, 'second', ['b.ts'], [reference('b.ts', 'second')]);
        let rotated = false;
        const interruptedCopy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            if (!rotated) {
              rotated = true;
              yield* sql.unsafe('DROP TRIGGER snapshot_candidate_lookup_candidate_invalidate_delete');
              yield* ensureResolutionCandidateIndexSchema(sql);
            }
            return yield* effect;
          });
        expect(
          yield* finishResolutionCandidateIndex(
            sql,
            {...identity, snapshotId: 'second', inheritedSnapshotId: 'first'},
            interruptedCopy,
          ),
        ).toBe(false);
        expect(rotated).toBe(true);
        expect((yield* sql`SELECT 1 FROM snapshot_candidate_receipts WHERE snapshot_id = 'second'`).length).toBe(0);
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('first', 'second'))).toBeUndefined();
        yield* stage(sql, 'base', ['a.ts', 'b.ts'], [reference('a.ts', 'root')]);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        yield* stage(sql, 'first', ['a.ts'], [reference('a.ts', 'first')]);
        expect(yield* finishResolutionCandidateIndex(sql, {...identity, snapshotId: 'first'}, write)).toBe(true);
        yield* stage(sql, 'second', ['b.ts'], [reference('b.ts', 'second')]);
        expect(
          yield* finishResolutionCandidateIndex(
            sql,
            {...identity, snapshotId: 'second', inheritedSnapshotId: 'first'},
            write,
          ),
        ).toBe(true);
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('first', 'second'))).toMatchObject({
          mode: 'eligible',
          paths: ['a.ts'],
        });
      }).pipe(provideDatabase),
  );

  effectIt.effect('uses the leading snapshot/domain/key range rather than scanning unrelated candidates', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const plan = yield* sql<{
        readonly detail: string;
      }>`EXPLAIN QUERY PLAN SELECT evidence_path FROM snapshot_candidate_lookup
      WHERE snapshot_id = 'base' AND resolution_domain = 'typescript' AND lookup_key = 'key' ORDER BY evidence_path LIMIT 129`;
      expect(
        EffectArray.join(
          EffectArray.map(plan, row => row.detail),
          '\n',
        ),
      ).toContain('PRIMARY KEY (snapshot_id=? AND resolution_domain=? AND lookup_key=?)');
    }).pipe(provideDatabase),
  );

  effectIt.effect('selects and decodes only affected full facts above the unchanged 256 MiB whole-scan cap', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const paths = ['changed.ts', 'consumer.ts', ...Array.from({length: 129}, (_, n) => `unrelated-${n}.ts`)];
      const files = EffectArray.map(paths, path => ({
        path,
        contentHash: path,
        blobId: path,
        mode: '100644',
        size: 10,
        source: 'commit' as const,
        language: 'typescript',
      }));
      yield* createSnapshot(sql, 'base', paths);
      yield* stage(sql, 'base', paths, [reference('consumer.ts', 'new-export')]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      yield* sql.unsafe('CREATE TABLE raw_test_facts (path TEXT PRIMARY KEY, payload TEXT NOT NULL) WITHOUT ROWID');
      const padding = pipe('x', EffectString.repeat(2 * 1_048_576));
      for (const path of paths) {
        const payload = JSON.stringify({
          path,
          symbols: [],
          edges: [],
          references: [],
          diagnostics: pipe(path, EffectString.startsWith('unrelated-')) ? [padding] : [],
        } satisfies CodeGraphFileFacts);
        yield* sql`INSERT INTO raw_test_facts VALUES (${path}, ${payload})`;
      }
      const total = (yield* sql<{
        readonly bytes: number;
      }>`SELECT SUM(length(CAST(payload AS BLOB))) AS bytes FROM raw_test_facts`)[0].bytes;
      expect(total).toBeGreaterThan(256 * 1_048_576);
      const metadataPaths: string[] = [];
      const decodedPaths: string[] = [];
      const storeContext = yield* Layer.build(
        Layer.mock(CodeGraphStore, {
          resolutionCandidateIndexClosure: (_database, input) =>
            selectResolutionCandidateIndexClosure(sql, input).pipe(Effect.orDie),
          loadCachedFacts: (_database, selected, _extractor, options) =>
            Effect.gen(function* () {
              const facts = new Map<string, CodeGraphFileFacts>();
              const bytesByPath = new Map<string, number>();
              for (const file of selected) {
                if (options?.decode === false) {
                  const row = (yield* sql<{
                    readonly bytes: number;
                  }>`SELECT length(CAST(payload AS BLOB)) AS bytes FROM raw_test_facts WHERE path = ${file.path}`)[0];
                  bytesByPath.set(file.path, row.bytes);
                  metadataPaths.push(file.path);
                } else {
                  const row = (yield* sql<{
                    readonly payload: string;
                  }>`SELECT payload FROM raw_test_facts WHERE path = ${file.path}`)[0];
                  bytesByPath.set(file.path, Buffer.byteLength(row.payload));
                  decodedPaths.push(file.path);
                  facts.set(file.path, JSON.parse(row.payload));
                }
              }
              return {
                bytes: EffectArray.reduce([...bytesByPath.values()], 0, (sum, n) => sum + n),
                bytesByPath,
                facts,
                keys: new Set(EffectArray.map(selected, file => file.path)),
              };
            }).pipe(Effect.orDie),
        }),
      );
      const store = yield* CodeGraphStore.pipe(Effect.provide(storeContext));
      const workspace = {fingerprint: 'workspace', projects: [], workspaces: [], diagnostics: []};
      const assess = () =>
        assessResolutionCandidateIncrementalClosure({
          baseSnapshotId: 'base',
          baseFileSetFingerprint: 'files',
          baseFiles: files,
          candidateReexports: [],
          committedWorkspace: workspace,
          currentChangedFiles: [files[0]],
          currentFiles: files,
          currentWorkspace: workspace,
          initialLookupKeys: query('new-export').initialLookupKeys,
          languagePacks: BUILTIN_LANGUAGE_PACK_REGISTRY,
          layout: {
            databasePath: '/unused/private-fixture',
            databaseWriteLockPath: '',
            checkoutId: '',
            lockPath: '',
            repositoryRoot: '',
            staleMarkerPath: '',
            vectorRoot: '',
            worktreeLockRoot: '',
            worktreeId: '',
          },
          projectCount: 1,
          store,
        });
      const result = yield* assess();
      expect(result).toMatchObject({
        mode: 'compatible',
        files: [files[0], files[1]],
        proportionalWork: {
          attributionContextFiles: 0,
          baseFactsLoaded: 2,
          // One SQL route plus both complete decoded all-tier associations are charged.
          candidateIndex: {associationsRead: 3},
        },
      });
      expect(metadataPaths).toEqual(['changed.ts', 'consumer.ts']);
      expect(decodedPaths).toEqual(['changed.ts', 'consumer.ts']);
      yield* sql`DELETE FROM snapshot_candidate_receipts WHERE snapshot_id = 'base'`;
      expect(yield* assess()).toMatchObject({
        mode: 'fallback',
        reason: 'project-closure-unbounded',
        fallbackBoundary: {metric: 'candidate-scan-fact-bytes', limit: 256 * 1_048_576},
      });
      expect(decodedPaths).toEqual(['changed.ts', 'consumer.ts']);
    }).pipe(provideDatabase),
  );

  fcEffectProp(
    effectIt,
    'matches the complete raw scanner for bounded generated all-tier reference sets',
    {
      refs: FC.array(
        FC.record({
          file: FC.integer({min: 0, max: 7}),
          key: FC.integer({min: 0, max: 12}),
          alias: FC.option(FC.integer({min: 0, max: 12}), {nil: undefined}),
        }),
        {
          maxLength: 45,
        },
      ),
      seed: FC.integer({min: 0, max: 12}),
    },
    ({refs, seed}) =>
      Effect.gen(function* () {
        const sql = yield* setup;
        const paths = Array.from({length: 8}, (_, n) => `file-${n}.ts`);
        const unique = new Map(
          EffectArray.map(refs, r => [
            `${r.file}:${r.key}`,
            reference(paths[r.file], `key-${r.key}`, r.alias === undefined ? [] : [`key-${r.alias}`]),
          ]),
        );
        const references = [...unique.values()];
        yield* createSnapshot(sql, 'base', paths);
        yield* stage(sql, 'base', paths, references);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        const facts = new Map(
          EffectArray.map(paths, path => [
            path,
            {
              path,
              diagnostics: [],
              symbols: [],
              edges: [],
              references: EffectArray.filter(references, r => r.evidencePath === path),
            } satisfies CodeGraphFileFacts,
          ]),
        );
        const files = EffectArray.map(paths, path => ({
          path,
          contentHash: path,
          blobId: path,
          mode: '100644',
          size: 1,
          source: 'commit' as const,
          language: 'typescript',
        }));
        const bytesByPath = new Map(
          EffectArray.map(paths, path => [path, Buffer.byteLength(JSON.stringify(facts.get(path)))]),
        );
        const plan = planProjectResolutionCandidateScan({files, bytesByPath});
        expect(plan.mode).toBe('eligible');
        if (plan.mode !== 'eligible') return;
        const scanned = yield* scanProjectResolutionCandidateClosure({
          plan,
          maximumSelectedFiles: 128,
          initialLookupKeys: query(`key-${seed}`).initialLookupKeys,
          loadPage: page =>
            Effect.succeed({
              facts: new Map(EffectArray.map(page, f => [f.path, facts.get(f.path)!])),
              bytesByPath: new Map(EffectArray.map(page, f => [f.path, bytesByPath.get(f.path)!])),
            }),
        });
        const indexed = yield* selectResolutionCandidateIndexClosure(sql, query(`key-${seed}`));
        expect(indexed?.mode).toBe('eligible');
        expect(scanned.mode).toBe('eligible');
        if (indexed?.mode === 'eligible' && scanned.mode === 'eligible') expect(indexed.paths).toEqual(scanned.paths);
      }).pipe(provideDatabase),
    {fastCheck: {numRuns: 30}},
  );
  effectIt.effect('seals complete Bun pages and resumes the exact immutable prefix after bounded interruption', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      // One physical row/page: cross the unchanged1000-row transaction guard,
      // while retaining every source association in logical work/capacity accounting.
      const refs = Array.from({length: 64000}, (_, i) => reference('a.ts', `key-${i}`));
      yield* createSnapshot(sql, 'base', ['a.ts']);
      let transactions = 0;
      const stopped: CodeGraphDirectPersistentCapacityProtector = (_boundary, effect) => {
        transactions += 1;
        return transactions === 4 ? Effect.interrupt : effect;
      };
      const input = {snapshotId: 'base', files: [{path: 'a.ts', contentHash: 'a.ts'}], references: refs};
      expect((yield* stageResolutionCandidateIndex(sql, input, write, stopped).pipe(Effect.exit))._tag).toBe('Failure');
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
      const prefix = yield* sql`SELECT * FROM snapshot_candidate_synopsis_pages ORDER BY snapshot_key,file_key,ordinal`;
      expect(prefix.length).toBeGreaterThan(0);
      expect(prefix.length).toBeLessThan(1001);
      const start = performance.now();
      yield* stageResolutionCandidateIndex(sql, input, write);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      const elapsed = performance.now() - start;
      expect(
        yield* sql`SELECT * FROM snapshot_candidate_synopsis_pages WHERE ordinal < ${prefix.length} ORDER BY snapshot_key,file_key,ordinal`,
      ).toEqual(prefix);
      const token = yield* resolutionCandidateAuthorityToken(sql);
      expect(token).toBeDefined();
      const snapshotKey = yield* candidateSnapshotKey(sql, 'base', token);
      expect(snapshotKey).toBeDefined();
      if (snapshotKey === undefined) return yield* Effect.die('Expected current candidate snapshot binding.');
      const files = yield* sql<{
        readonly file_key: number;
        readonly association_count: number;
        readonly page_count: number;
        readonly canonical_sha: string;
      }>`
      SELECT file_key,association_count,page_count,canonical_sha FROM snapshot_candidate_synopsis_files WHERE snapshot_key = ${snapshotKey}`;
      const file = files[0];
      const projection = yield* readCandidateFileProjection(
        sql,
        snapshotKey,
        file.file_key,
        'a.ts',
        file.association_count,
        file.page_count,
        file.canonical_sha,
      );
      const expected = [
        ...new Set(EffectArray.flatMap(refs, ref => EffectArray.flatMap(ref.lookupTiers, tier => tier))),
      ].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      expect(projection?.pairs).toEqual(EffectArray.map(expected, key => ['typescript', key]));
      expect(file.association_count).toBe(64001);
      expect(file.page_count).toBe(1001);
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      const allocatedPages = yield* sql<{readonly page_count: number}>`PRAGMA page_count`;
      const pageSize = yield* sql<{readonly page_size: number}>`PRAGMA page_size`;
      yield* Effect.log(
        JSON.stringify({
          fixture: 'candidate-pages-64001-exact-associations',
          resumedConstructionMilliseconds: elapsed,
          associations: file.association_count,
          pages: file.page_count,
          sqliteAllocatedBytes: allocatedPages[0].page_count * pageSize[0].page_size,
          note: 'real Bun bounded fixture; not hosted fit or 300ms acceptance',
        }),
      ).pipe(
        Effect.provideService(Console.Console, globalThis.console),
        Effect.provideService(Logger.CurrentLoggers, new Set([Logger.consoleJson])),
        Effect.provideService(References.MinimumLogLevel, 'Info'),
      );
    }).pipe(provideDatabase),
  );

  effectIt.effect(
    'keeps bounded indexed page folds, exact false-positive comparison and metadata-before-payload caps',
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* createSnapshot(sql, 'base', ['a.ts', 'b.ts', 'c.ts']);
        const unrelated = Array.from({length: 130}, (_, i) => reference('c.ts', `unrelated-${i}`));
        const first = [
          ...CandidatePages.candidateFilePages(
            CandidatePages.canonicalCandidatePairs(
              EffectArray.flatMap(unrelated, ref =>
                EffectArray.flatMap(ref.lookupTiers, tier =>
                  EffectArray.map(tier, key => [ref.resolutionDomain, key] as const),
                ),
              ),
            ),
          ),
        ][0];
        let needle: string | undefined;
        for (let i = 0; i < 100000 && needle === undefined; i++) {
          const key = `false-positive-${i}`;
          if (candidateSynopsisMayContain(first.synopsis, candidatePairHint(['typescript', key]))) needle = key;
        }
        expect(needle).toBeDefined();
        const refs = [reference('a.ts', needle!), reference('b.ts', needle!), ...unrelated];
        yield* stage(sql, 'base', ['a.ts', 'b.ts', 'c.ts'], refs);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        const token = yield* resolutionCandidateAuthorityToken(sql);
        const snapshotKey = yield* candidateSnapshotKey(sql, 'base', token);
        const plan = yield* sql.unsafe<{readonly detail: string}>(
          `EXPLAIN QUERY PLAN SELECT file_key,ordinal
        FROM snapshot_candidate_synopsis_pages WHERE snapshot_key = ? AND (file_key,ordinal) > (?,?) ORDER BY file_key,ordinal LIMIT 1`,
          [snapshotKey, -1, -1],
        );
        expect(EffectArray.some(plan, row => EffectString.includes('SEARCH')(row.detail))).toBe(true);
        expect(EffectArray.some(plan, row => EffectString.includes('TEMP B-TREE')(row.detail))).toBe(false);
        expect(yield* selectResolutionCandidateIndexClosure(sql, query(needle!))).toMatchObject({
          mode: 'eligible',
          paths: ['a.ts', 'b.ts'],
        });
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('absent'))).toMatchObject({
          mode: 'eligible',
          paths: [],
        });
        const collision = yield* readCandidateKeyPages(
          sql,
          'base',
          undefined,
          {key: needle!, resolutionDomain: 'typescript'},
          10000,
          8 * 1048576,
          128,
          token,
        );
        expect(collision?.paths).toEqual(['a.ts', 'b.ts']);
        expect(collision?.exceeded).toBeUndefined();
        expect(collision!.associations).toBeGreaterThan(64); // The natural false-positive page is fully decoded and charged.
        const limited = yield* readCandidateKeyPages(
          sql,
          'base',
          undefined,
          {key: needle!, resolutionDomain: 'typescript'},
          10000,
          8 * 1048576,
          1,
          token,
        );
        expect(limited?.exceeded).toBe('files');
        let payloadSelects = 0;
        let queryCalls = 0;
        const metadataOnly = new Proxy(sql, {
          apply(target, thisArg, args) {
            queryCalls += 1;
            const first: unknown = args[0];
            const text = EffectArray.isArray(first)
              ? EffectArray.join(
                  EffectArray.filter(first, (x): x is string => typeof x === 'string'),
                  '?',
                )
              : '';
            if (pipe(text, EffectString.includes('THEN page.payload'))) {
              payloadSelects += 1;
              throw new Error('Payload must not be hydrated.');
            }
            return Reflect.apply(target, thisArg, args);
          },
        });
        const tiny = yield* readCandidateKeyPages(
          metadataOnly,
          'base',
          undefined,
          {key: needle!, resolutionDomain: 'typescript'},
          1,
          10000,
          128,
          token,
        );
        expect(tiny?.exceeded).toBe('rows');
        expect(payloadSelects).toBe(0);
        expect(queryCalls).toBe(2);
        queryCalls = 0;
        expect(
          (yield* readCandidateKeyPages(
            metadataOnly,
            'base',
            undefined,
            {key: needle!, resolutionDomain: 'typescript'},
            0,
            10000,
            128,
            token,
          ))?.exceeded,
        ).toBe('rows');
        expect(queryCalls).toBe(0);
        expect(payloadSelects).toBe(0);
      }).pipe(provideDatabase),
  );

  effectIt.effect(
    'folds one new-key wave once and charges masked/negative metadata and observation exhaustion before hydration',
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* createSnapshot(sql, 'base', ['a.ts', 'b.ts', 'c.ts']);
        yield* stage(
          sql,
          'base',
          ['a.ts', 'b.ts', 'c.ts'],
          [reference('a.ts', 'first'), reference('b.ts', 'second'), reference('c.ts', 'other')],
        );
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        const token = yield* resolutionCandidateAuthorityToken(sql);
        const keys = [
          {key: 'first', resolutionDomain: 'typescript'},
          {key: 'second', resolutionDomain: 'typescript'},
        ];
        let folds = 0,
          payloads = 0,
          calls = 0;
        const observed = new Proxy(sql, {
          apply(target, thisArg, args) {
            calls++;
            const first: unknown = args[0];
            const text = EffectArray.isArray(first)
              ? EffectArray.join(
                  EffectArray.filter(first, (s): s is string => typeof s === 'string'),
                  '?',
                )
              : '';
            if (EffectString.includes('THEN page.payload')(text)) payloads++;
            else if (EffectString.includes('FROM snapshot_candidate_synopsis_pages AS page')(text)) folds++;
            return Reflect.apply(target, thisArg, args);
          },
        });
        const selected = yield* readCandidateKeyWavePages(
          observed,
          'base',
          undefined,
          keys,
          1000,
          1048576,
          128,
          token,
          2000000,
        );
        expect(selected?.paths).toEqual(['a.ts', 'b.ts']);
        expect(folds).toBe(2); // One bounded metadata batch and charged terminal sentinel, independent of two keys.
        expect(selected?.bitTests).toBe(3 * 2 * 8);
        expect(selected?.observations).toBeGreaterThanOrEqual(3 * 2);
        expect(payloads).toBe(2);
        calls = 0;
        payloads = 0;
        folds = 0;
        expect(
          yield* readCandidateKeyWavePages(observed, 'base', undefined, [], 1000, 1048576, 128, token, 2000000),
        ).toEqual({paths: [], associations: 0, bytes: 0, observations: 0, bitTests: 0});
        expect(calls).toBe(0);
        const exhausted = yield* readCandidateKeyWavePages(
          observed,
          'base',
          undefined,
          keys,
          1000,
          1048576,
          128,
          token,
          1,
        );
        expect(exhausted).toMatchObject({paths: [], observations: 2, exceeded: 'observations'});
        expect(calls).toBe(0);
        expect(payloads).toBe(0);
      }).pipe(provideDatabase),
  );

  effectIt.effect(
    'reserves the full mixed metadata batch before a positive can spend the last observation allowance',
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        const paths = ['a.ts', 'b.ts', 'c.ts'];
        for (let positive = 0; positive < 3; positive++) {
          const id = `mix-${positive}`;
          yield* createSnapshot(sql, id, paths);
          yield* stage(
            sql,
            id,
            paths,
            EffectArray.map(paths, (path, n) => reference(path, n === positive ? 'needle' : `negative-${n}`)),
          );
          expect(yield* finishResolutionCandidateIndex(sql, {...identity, snapshotId: id}, write)).toBe(true);
          const token = yield* resolutionCandidateAuthorityToken(sql);
          let payloads = 0,
            folds = 0;
          const observed = new Proxy(sql, {
            apply(target, thisArg, args) {
              const strings: unknown = args[0];
              const text = EffectArray.isArray(strings)
                ? EffectArray.join(
                    EffectArray.filter(strings, (x): x is string => typeof x === 'string'),
                    '?',
                  )
                : '';
              if (EffectString.includes('THEN page.payload')(text)) payloads++;
              if (EffectString.includes('AS path_bytes')(text)) folds++;
              return Reflect.apply(target, thisArg, args);
            },
          });
          const priorWaveObservations = 1999997;
          const selected = yield* readCandidateKeyWavePages(
            observed,
            id,
            undefined,
            [{resolutionDomain: 'typescript', key: 'needle'}],
            1000,
            1048576,
            128,
            token,
            2000000 - priorWaveObservations,
          );
          expect(selected).toMatchObject({paths: [], associations: 3, observations: 5, exceeded: 'observations'});
          expect(selected?.bitTests).toBe((positive + 1) * 8); // only reserved metadata rows are probed
          expect(payloads).toBe(0);
          expect(folds).toBe(1);
        }
      }).pipe(provideDatabase),
  );

  effectIt.effect('charges masked indexed candidates before replacement or deletion eligibility', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const paths = ['a.ts', 'b.ts'];
      yield* createSnapshot(sql, 'base', paths);
      yield* stage(
        sql,
        'base',
        paths,
        EffectArray.map(paths, path => reference(path, 'needle')),
      );
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      const token = yield* resolutionCandidateAuthorityToken(sql);
      for (const kind of ['replacement', 'deletion'] as const) {
        const files = kind === 'replacement' ? paths : ['a.ts'];
        yield* createSnapshot(sql, kind, files, 'base');
        if (kind === 'deletion') yield* sql`INSERT INTO snapshot_file_deletions VALUES (${kind},'b.ts')`;
        yield* stage(sql, kind, files, []);
        expect(yield* finishResolutionCandidateIndex(sql, {...identity, snapshotId: kind}, write)).toBe(true);
        let payloadReads = 0;
        const metadataOnly = new Proxy(sql, {
          apply(target, thisArg, args) {
            const first: unknown = args[0];
            const text = EffectArray.isArray(first)
              ? EffectArray.join(
                  EffectArray.filter(first, (x): x is string => typeof x === 'string'),
                  '?',
                )
              : '';
            if (EffectString.includes('THEN page.payload')(text)) {
              payloadReads += 1;
              throw new Error('A masked page must not hydrate payload.');
            }
            return Reflect.apply(target, thisArg, args);
          },
        });
        const bounded = yield* readCandidateKeyPages(
          metadataOnly,
          'base',
          kind,
          {key: 'needle', resolutionDomain: 'typescript'},
          1,
          10000,
          128,
          token,
        );
        expect(bounded).toMatchObject({paths: [], associations: 2, exceeded: 'rows'});
        const complete = yield* readCandidateKeyPages(
          metadataOnly,
          'base',
          kind,
          {key: 'needle', resolutionDomain: 'typescript'},
          3,
          10000,
          128,
          token,
        );
        expect(complete).toEqual({paths: [], associations: 2, bytes: 1088, observations: 2, bitTests: 16});
        expect(payloadReads).toBe(0);
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('needle', kind))).toMatchObject({
          mode: 'eligible',
          paths: [],
        });
      }
      yield* createSnapshot(sql, 'mixed', ['a.ts'], 'base');
      yield* stage(sql, 'mixed', ['a.ts'], []);
      expect(yield* finishResolutionCandidateIndex(sql, {...identity, snapshotId: 'mixed'}, write)).toBe(true);
      const mixed = yield* readCandidateKeyPages(
        sql,
        'base',
        'mixed',
        {key: 'needle', resolutionDomain: 'typescript'},
        10,
        10000,
        128,
        token,
      );
      expect(mixed).toMatchObject({paths: ['b.ts'], associations: 4});
      expect(mixed?.exceeded).toBeUndefined();
    }).pipe(provideDatabase),
  );

  for (const variant of ['full-value', 'wrong-synopsis', 'missing-bit'] as const) {
    effectIt.effect(
      `refuses an unsealed same-cardinality ${variant} prefix without overwriting retained evidence`,
      () =>
        Effect.gen(function* () {
          const sql = yield* setup;
          yield* createSnapshot(sql, 'base', ['a.ts']);
          const refs = [reference('a.ts', 'value')];
          yield* stage(sql, 'base', ['a.ts'], refs);
          yield* sql`UPDATE snapshot_candidate_synopsis_files SET sealed = 0`;
          const original = [
            ...CandidatePages.candidateFilePages(
              CandidatePages.canonicalCandidatePairs([
                ['typescript', 'value'],
                ['typescript', 'unresolved-fallback'],
              ]),
            ),
          ][0];
          const owner = (yield* sql<{
            readonly snapshot_key: number;
            readonly file_key: number;
          }>`SELECT snapshot_key,file_key FROM snapshot_candidate_synopsis_files`)[0];
          let altered = original;
          if (variant === 'full-value')
            altered = [
              ...CandidatePages.candidateFilePages(
                CandidatePages.canonicalCandidatePairs([
                  ['typescript', 'other'],
                  ['typescript', 'unresolved-fallback'],
                ]),
              ),
            ][0];
          const bits =
            variant === 'wrong-synopsis'
              ? candidateSynopsis([candidatePairHint(['typescript', 'other'])])
              : variant === 'missing-bit'
                ? new Uint8Array(128)
                : altered.synopsis;
          yield* sql`DELETE FROM snapshot_candidate_synopsis_pages`;
          yield* sql`INSERT INTO snapshot_candidate_synopsis_pages
            SELECT snapshot_key,file_key,0,2,${altered.rawBytes},${altered.storedBytes},original_tuple_bytes,
              ${altered.rawSha},${altered.storedSha},${altered.codec},${bits},
              ${candidateSynopsisBinding(owner.snapshot_key, owner.file_key, 0, altered.rawSha, altered.storedSha, bits)},${altered.payload!},NULL,NULL
              FROM snapshot_candidate_synopsis_files`;
          const tables = [...CANDIDATE_PAGE_TABLES, ...RESOLUTION_CANDIDATE_INDEX_TABLES];
          const before = yield* Effect.forEach(tables, table =>
            sql.unsafe(`SELECT * FROM ${table.name} ORDER BY ${EffectArray.join(table.keyColumns, ',')}`),
          );
          expect((yield* stage(sql, 'base', ['a.ts'], refs).pipe(Effect.exit))._tag).toBe('Failure');
          const after = yield* Effect.forEach(tables, table =>
            sql.unsafe(`SELECT * FROM ${table.name} ORDER BY ${EffectArray.join(table.keyColumns, ',')}`),
          );
          expect(after).toEqual(before);
          expect(yield* sql`SELECT complete FROM snapshot_candidate_files`).toEqual([{complete: 0}]);
          expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
          expect(yield* sql`SELECT * FROM snapshot_candidate_receipts`).toEqual([]);
          expect(yield* sql`SELECT * FROM snapshot_candidate_synopsis_receipts`).toEqual([]);
          expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toBeUndefined();
          expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
        }).pipe(provideDatabase),
    );
  }

  effectIt.effect('refuses populated format4 index loss without rebuilding or altering retained family rows', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* createSnapshot(sql, 'base', ['a.ts']);
      yield* stage(sql, 'base', ['a.ts'], [reference('a.ts', 'key')]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      const before = [];
      for (const table of CANDIDATE_PAGE_TABLES)
        before.push(
          yield* sql.unsafe(`SELECT * FROM ${table.name} ORDER BY ${EffectArray.join(table.keyColumns, ',')}`),
        );
      const oldToken = yield* resolutionCandidateAuthorityToken(sql);
      yield* sql.unsafe('DROP INDEX snapshot_candidate_synopsis_snapshots_path');
      expect(yield* ensureResolutionCandidateIndexSchema(sql)).toBe(true);
      expect(yield* resolutionCandidateAuthorityToken(sql)).toBeUndefined();
      expect(yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'snapshot_candidate_synopsis_snapshots_path'`).toEqual(
        [],
      );
      for (const [i, table] of CANDIDATE_PAGE_TABLES.entries())
        expect(
          yield* sql.unsafe(`SELECT * FROM ${table.name} ORDER BY ${EffectArray.join(table.keyColumns, ',')}`),
        ).toEqual(before[i]);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('key'))).toBeUndefined();
      yield* sql.unsafe(CANDIDATE_PAGE_INDEXES[0].sql);
      expect(yield* ensureResolutionCandidateIndexSchema(sql)).toBe(true);
      expect(yield* resolutionCandidateAuthorityToken(sql)).not.toBe(oldToken);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
      yield* stage(sql, 'base', ['a.ts'], [reference('a.ts', 'key')]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      expect(yield* sql`SELECT COUNT(*) AS count FROM snapshot_candidate_synopsis_snapshots`).toEqual([{count: 2}]);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('key'))).toMatchObject({
        mode: 'eligible',
        paths: ['a.ts'],
      });
    }).pipe(provideDatabase),
  );
  effectIt.effect(
    'admits original source work before canonical allocation and releases preparation before writers',
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* createSnapshot(sql, 'base', ['a.ts']);
        let edgeReads = 0;
        let preparation = false;
        let admitted = false;
        const ref = reference('a.ts', 'value', ['alias']);
        const originalCanonical = CandidatePages.canonicalCandidatePairs;
        const canonical = vi.spyOn(CandidatePages, 'canonicalCandidatePairs').mockImplementation(values => {
          expect(admitted).toBe(true);
          expect(preparation).toBe(true);
          return originalCanonical(values);
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => canonical.mockRestore()));
        Object.defineProperty(ref, 'edgeId', {
          get: () => {
            edgeReads++;
            return 'a.ts:value';
          },
        });
        const preparationGate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              expect(preparation).toBe(false);
              preparation = true;
            }),
            () => effect,
            () =>
              Effect.sync(() => {
                preparation = false;
              }),
          );
        const input = {
          snapshotId: 'base',
          files: [{path: 'a.ts', contentHash: 'a.ts'}],
          references: [ref],
          preparationGate,
        };
        const denied: CodeGraphDirectPersistentCapacityProtector = (boundary, _effect) => {
          expect(preparation).toBe(false);
          expect(boundary.rowCount).toBe(5);
          expect(boundary.finalFactBytes).toBeGreaterThan(0);
          return Effect.interrupt;
        };
        expect((yield* stageResolutionCandidateIndex(sql, input, write, denied).pipe(Effect.exit))._tag).toBe(
          'Failure',
        );
        expect(edgeReads).toBeGreaterThan(0); // Constant-space scalar/length prewalk precedes admission.
        expect(canonical).not.toHaveBeenCalled();
        expect(preparation).toBe(false);
        expect(yield* sql`SELECT COUNT(*) AS count FROM snapshot_candidate_synopsis_snapshots`).toEqual([{count: 0}]);
        const boundaries: {rowCount: number; bytes: number}[] = [];
        const protector: CodeGraphDirectPersistentCapacityProtector = (boundary, effect) => {
          expect(preparation).toBe(false);
          boundaries.push({rowCount: boundary.rowCount, bytes: boundary.finalFactBytes});
          admitted = true;
          return effect;
        };
        const writer = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
          expect(preparation).toBe(false);
          return effect;
        };
        yield* stageResolutionCandidateIndex(sql, input, writer, protector);
        expect(preparation).toBe(false);
        expect(edgeReads).toBeGreaterThan(0);
        expect(boundaries[0]).toEqual({rowCount: 5, bytes: 91});
        expect(yield* finishResolutionCandidateIndex(sql, identity, writer, protector)).toBe(true);
      }).pipe(provideDatabase),
  );
  effectIt.effect('keeps literal BOM keys exact and masks root references from deleted files', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const largeKey = '\ufeff' + EffectString.repeat(70000)('x');
      yield* createSnapshot(sql, 'base', ['a.ts', 'b.ts']);
      yield* stage(sql, 'base', ['a.ts', 'b.ts'], [reference('a.ts', largeKey), reference('b.ts', 'other')]);
      expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query(largeKey))).toMatchObject({
        mode: 'eligible',
        paths: ['a.ts'],
      });
      expect(
        yield* sql`SELECT literal_key FROM snapshot_candidate_synopsis_pages WHERE codec = 'literal-pair-v1'`,
      ).toEqual([{literal_key: largeKey}]);
      yield* createSnapshot(sql, 'deleted', ['b.ts'], 'base');
      yield* sql`INSERT INTO snapshot_file_deletions VALUES ('deleted','a.ts')`;
      yield* stage(sql, 'deleted', ['b.ts'], [reference('b.ts', 'other')]);
      expect(yield* finishResolutionCandidateIndex(sql, {...identity, snapshotId: 'deleted'}, write)).toBe(true);
      expect(yield* selectResolutionCandidateIndexClosure(sql, query(largeKey, 'deleted'))).toMatchObject({
        mode: 'eligible',
        paths: [],
      });
      expect(yield* selectResolutionCandidateIndexClosure(sql, query('other', 'deleted'))).toMatchObject({
        mode: 'eligible',
        paths: ['b.ts'],
      });
      yield* sql`DELETE FROM snapshot_file_deletions WHERE snapshot_id = 'deleted' AND path = 'a.ts'`;
      expect(yield* selectResolutionCandidateIndexClosure(sql, query(largeKey, 'deleted'))).toBeUndefined();
    }).pipe(provideDatabase),
  );
  effectIt.effect(
    'measures complete production Bun construction and object allocation at a supported large source scale',
    () =>
      Effect.gen(function* () {
        const originalSql = yield* setup;
        let clientStatementCalls = 0;
        const sql = new Proxy(originalSql, {
          apply(target, thisArg, args) {
            clientStatementCalls += 1;
            return Reflect.apply(target, thisArg, args);
          },
          get(target, key, receiver) {
            if (key !== 'unsafe') return Reflect.get(target, key, receiver);
            return (text: string, parameters: readonly unknown[] = []) => {
              clientStatementCalls += 1;
              return originalSql.unsafe(text, parameters);
            };
          },
        });
        const paths = Array.from({length: 3635}, (_, i) => `fixture-${String(i)}.ts`);
        const refs: CodeGraphReference[] = [];
        for (const [i, path] of paths.entries())
          for (let j = 0; j < (i < 1806 ? 37 : 36); j += 1) {
            const key = `module/repository/packages/library/src/deep/shared/path/${i}/exported-symbol-${j}`;
            refs.push(reference(path, key, i < 915 && j === 0 ? [`alias-${i}`] : []));
          }
        yield* createSnapshot(sql, 'base', paths);
        let encodingMs = 0;
        let decodingMs = 0;
        let writerMs = 0;
        let preparationMs = 0;
        let transactions = 0;
        let guards = 0;
        const allocations: {rows: number; bytes: number}[] = [];
        const originalPages = CandidatePages.candidateFilePages;
        const originalDecode = CandidatePages.decodeCandidatePage;
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const pages = vi.spyOn(CandidatePages, 'candidateFilePages').mockImplementation(function* (pairs) {
              const source = originalPages(pairs);
              try {
                for (;;) {
                  const start = performance.now();
                  const next = source.next();
                  encodingMs += performance.now() - start;
                  if (next.done) return;
                  yield next.value;
                }
              } finally {
                source.return(undefined);
              }
            });
            const decode = vi.spyOn(CandidatePages, 'decodeCandidatePage').mockImplementation((payload, page) => {
              const start = performance.now();
              try {
                return originalDecode(payload, page);
              } finally {
                decodingMs += performance.now() - start;
              }
            });
            return {pages, decode};
          }),
          () =>
            Effect.gen(function* () {
              const writer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                Effect.gen(function* () {
                  transactions += 1;
                  const start = performance.now();
                  const result = yield* effect;
                  writerMs += performance.now() - start;
                  return result;
                });
              const preparationGate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                Effect.gen(function* () {
                  const start = performance.now();
                  const result = yield* effect;
                  preparationMs += performance.now() - start;
                  return result;
                });
              const protector: CodeGraphDirectPersistentCapacityProtector = (boundary, effect) =>
                Effect.gen(function* () {
                  guards += 1;
                  allocations.push({rows: boundary.rowCount, bytes: boundary.finalFactBytes});
                  return yield* effect;
                });
              clientStatementCalls = 0;
              const start = performance.now();
              yield* stageResolutionCandidateIndex(
                sql,
                {
                  snapshotId: 'base',
                  files: EffectArray.map(paths, path => ({path, contentHash: path})),
                  references: refs,
                  preparationGate,
                },
                writer,
                protector,
              );
              expect(yield* finishResolutionCandidateIndex(sql, identity, writer, protector)).toBe(true);
              const constructionMs = performance.now() - start;
              const constructionClientStatementCalls = clientStatementCalls;
              const constructionEncodingMs = encodingMs;
              const constructionDecodingMs = decodingMs;
              expect(constructionEncodingMs).toBeGreaterThan(0);
              expect(constructionDecodingMs).toBeGreaterThan(0);
              const totals = (yield* sql<{
                readonly files: number;
                readonly associations: number;
                readonly pages: number;
                readonly routes: number;
                readonly reexports: number;
                readonly original_bytes: number;
                readonly raw_bytes: number;
                readonly stored_bytes: number;
              }>`SELECT
        (SELECT COUNT(*) FROM snapshot_candidate_synopsis_files) AS files,
        (SELECT SUM(association_count) FROM snapshot_candidate_synopsis_files) AS associations,
        (SELECT COUNT(*) FROM snapshot_candidate_synopsis_pages) AS pages,
        (SELECT COUNT(*) FROM snapshot_candidate_page_routes) AS routes,
        (SELECT COUNT(*) FROM snapshot_candidate_reexports) AS reexports,
        (SELECT SUM(original_tuple_bytes) FROM snapshot_candidate_synopsis_files) AS original_bytes,
        (SELECT SUM(raw_bytes) FROM snapshot_candidate_synopsis_pages) AS raw_bytes,
        (SELECT SUM(stored_bytes) FROM snapshot_candidate_synopsis_pages) AS stored_bytes`)[0];
              expect(totals).toMatchObject({
                files: 3635,
                associations: 136301,
                pages: 3635,
                routes: 0,
                reexports: 915,
              });
              const token = yield* resolutionCandidateAuthorityToken(sql);
              const snapshotKey = yield* candidateSnapshotKey(sql, 'base', token);
              if (snapshotKey === undefined) return yield* Effect.die('Expected current candidate snapshot binding.');
              let afterFile = -1;
              let compared = 0;
              let comparedBytes = 0;
              let comparedReexports = 0;
              for (;;) {
                const files = yield* sql<{
                  readonly file_key: number;
                  readonly path: string;
                  readonly association_count: number;
                  readonly page_count: number;
                  readonly canonical_sha: string;
                }>`
          SELECT file_key,path,association_count,page_count,canonical_sha FROM snapshot_candidate_synopsis_files
          WHERE snapshot_key=${snapshotKey} AND file_key > ${afterFile} ORDER BY file_key LIMIT 1000`;
                if (files.length === 0) break;
                for (const file of files) {
                  afterFile = file.file_key;
                  const i = paths.indexOf(file.path);
                  expect(i).toBeGreaterThanOrEqual(0);
                  const expected: CandidatePages.CandidatePair[] = [['typescript', 'unresolved-fallback']];
                  for (let j = 0; j < (i < 1806 ? 37 : 36); j += 1)
                    expected.push([
                      'typescript',
                      `module/repository/packages/library/src/deep/shared/path/${i}/exported-symbol-${j}`,
                    ]);
                  expected.sort(
                    (a, b) =>
                      Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])) ||
                      Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1])),
                  );
                  const projection = yield* readCandidateFileProjection(
                    sql,
                    snapshotKey,
                    file.file_key,
                    file.path,
                    file.association_count,
                    file.page_count,
                    file.canonical_sha,
                  );
                  expect(projection?.pairs).toEqual(expected);
                  compared += expected.length;
                  for (const pair of expected)
                    comparedBytes +=
                      Buffer.byteLength('base') +
                      Buffer.byteLength(file.path) +
                      Buffer.byteLength(pair[0]) +
                      Buffer.byteLength(pair[1]);
                  const hyperedges = yield* sql<{
                    readonly payload_json: string;
                  }>`SELECT payload_json FROM snapshot_candidate_reexports WHERE snapshot_id='base' AND evidence_path=${file.path}`;
                  expect(hyperedges).toHaveLength(i < 915 ? 1 : 0);
                  if (i < 915) {
                    expect(hyperedges[0].payload_json).toBe(
                      JSON.stringify({
                        sourcePath: file.path,
                        aliases: [{key: `alias-${i}`, resolutionDomain: 'typescript'}],
                        candidates: [
                          {
                            key: `module/repository/packages/library/src/deep/shared/path/${i}/exported-symbol-0`,
                            resolutionDomain: 'typescript',
                          },
                          {key: 'unresolved-fallback', resolutionDomain: 'typescript'},
                        ],
                      }),
                    );
                    comparedReexports += 1;
                  }
                }
              }
              expect(compared).toBe(136301);
              expect(comparedBytes).toBe(totals.original_bytes);
              expect(comparedReexports).toBe(915);
              const positive = `module/repository/packages/library/src/deep/shared/path/2000/exported-symbol-2`;
              const selected = yield* selectResolutionCandidateIndexClosure(sql, query(positive));
              expect(selected).toMatchObject({mode: 'eligible', paths: [paths[2000]]});
              expect(yield* selectResolutionCandidateIndexClosure(sql, query('negative-full-value'))).toMatchObject({
                mode: 'eligible',
                paths: [],
              });
              const second = `module/repository/packages/library/src/deep/shared/path/2001/exported-symbol-3`;
              expect(
                yield* selectResolutionCandidateIndexClosure(sql, {
                  ...query(positive),
                  initialLookupKeys: [
                    {key: positive, resolutionDomain: 'typescript'},
                    {key: second, resolutionDomain: 'typescript'},
                  ],
                }),
              ).toMatchObject({mode: 'eligible', paths: [paths[2000], paths[2001]]});
              const objects =
                yield* sql`SELECT name,COUNT(*) AS pages,SUM(pgsize) AS allocated_bytes,SUM(payload) AS payload_bytes FROM dbstat GROUP BY name ORDER BY name`;
              const pageCount = (yield* sql<{readonly page_count: number}>`PRAGMA page_count`)[0].page_count;
              const pageSize = (yield* sql<{readonly page_size: number}>`PRAGMA page_size`)[0].page_size;
              const freePages = (yield* sql<{readonly freelist_count: number}>`PRAGMA freelist_count`)[0]
                .freelist_count;
              expect(EffectArray.reduce(objects, 0, (n, row) => n + Number(row.pages)) + freePages).toBe(pageCount);
              expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
              yield* Effect.log(
                JSON.stringify({
                  fixture: 'generated-source-3635-files-136301-associations-915-hyperedges',
                  totals,
                  originalReferenceRows: refs.length,
                  constructionMs,
                  preparationMs,
                  pageGeneratorMs: constructionEncodingMs,
                  decodingMs: constructionDecodingMs,
                  fullVerificationEncodingMs: encodingMs - constructionEncodingMs,
                  fullVerificationDecodingMs: decodingMs - constructionDecodingMs,
                  writerMs,
                  transactions,
                  guards,
                  explicitClientStatementCalls: constructionClientStatementCalls,
                  sqlCounterScope:
                    'explicit tagged/unsafe calls during successful constructor; excludes internal BEGIN/COMMIT/trigger/VM work, which remains timed',
                  preallocationEstimate: allocations[0],
                  guardRows: EffectArray.map(allocations, row => row.rows),
                  allocatedDatabaseBytes: pageCount * pageSize,
                  freePages,
                  objects,
                  selectiveWork: selected?.mode === 'eligible' ? selected.candidateIndex : null,
                  limitations:
                    'Synthetic exact full source fixture; in-memory SQLite object allocations, supplied protector observation not filesystem capacity; not private04 or hosted timing/storage acceptance.',
                }),
              ).pipe(
                Effect.provideService(Console.Console, globalThis.console),
                Effect.provideService(Logger.CurrentLoggers, new Set([Logger.consoleJson])),
                Effect.provideService(References.MinimumLogLevel, 'Info'),
              );
            }),
          resource =>
            Effect.sync(() => {
              resource.pages.mockRestore();
              resource.decode.mockRestore();
            }),
        );
      }).pipe(provideDatabase),
    30000,
  );
  effectIt.effect(
    'stages a source-legal near-limit literal without turning reserved metadata into an exclusion',
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        const snapshotId = 'cgsn_' + EffectString.repeat(40)('a');
        const path = 'a.ts';
        const empty: CodeGraphReference = {
          edgeId: 'edge',
          evidencePath: path,
          evidenceSpan: {line: 1, column: 1, endLine: 1, endColumn: 2},
          sourceName: 'x',
          targetName: 'x',
          relation: 'references',
          provenance: 'syntactic',
          resolutionDomain: 'typescript',
          lookupTiers: [['']],
        };
        const maximum = 8 * 1048576;
        const overhead = Math.max(
          Buffer.byteLength(JSON.stringify(empty)),
          Buffer.byteLength(JSON.stringify([snapshotId, 'typescript', '', path])),
          26,
        );
        const key = EffectString.repeat(maximum - overhead)('x');
        const ref = {...empty, lookupTiers: [[key]]};
        expect(Buffer.byteLength(JSON.stringify(ref))).toBeLessThanOrEqual(maximum);
        expect(Buffer.byteLength(JSON.stringify([snapshotId, 'typescript', key, path]))).toBeLessThanOrEqual(maximum);
        expect(resolutionCandidateFileRepresentable(snapshotId, {path, contentHash: path}, [ref])).toBe(true);
        // The former arbitrary256B eligibility padding really would reject this original-source-legal association.
        const originalBytes =
          Buffer.byteLength(snapshotId) +
          Buffer.byteLength(path) +
          Buffer.byteLength('typescript') +
          Buffer.byteLength(key);
        expect(originalBytes + 256).toBeGreaterThan(maximum);
        yield* createSnapshot(sql, snapshotId, [path]);
        let maximumReserved = 0;
        const protector: CodeGraphDirectPersistentCapacityProtector = (boundary, effect) => {
          maximumReserved = Math.max(maximumReserved, boundary.finalFactBytes);
          return effect;
        };
        yield* stageResolutionCandidateIndex(
          sql,
          {snapshotId, files: [{path, contentHash: path}], references: [ref]},
          write,
          protector,
        );
        expect(yield* finishResolutionCandidateIndex(sql, {...identity, snapshotId}, write, protector)).toBe(true);
        const token = yield* resolutionCandidateAuthorityToken(sql);
        const snapshotKey = yield* candidateSnapshotKey(sql, snapshotId, token);
        if (snapshotKey === undefined) return yield* Effect.die('Expected current candidate snapshot binding.');
        const file = (yield* sql<{
          readonly file_key: number;
          readonly association_count: number;
          readonly page_count: number;
          readonly canonical_sha: string;
        }>`
      SELECT file_key,association_count,page_count,canonical_sha FROM snapshot_candidate_synopsis_files WHERE snapshot_key=${snapshotKey}`)[0];
        const projection = yield* readCandidateFileProjection(
          sql,
          snapshotKey,
          file.file_key,
          path,
          file.association_count,
          file.page_count,
          file.canonical_sha,
        );
        expect(projection?.pairs).toEqual([['typescript', key]]);
        const literal = (yield* sql<{
          readonly raw_bytes: number;
          readonly stored_bytes: number;
          readonly literal_key: string;
        }>`
      SELECT raw_bytes,stored_bytes,literal_key FROM snapshot_candidate_synopsis_pages WHERE snapshot_key=${snapshotKey}`)[0];
        expect(literal.literal_key).toBe(key);
        expect(literal.raw_bytes).toBeLessThanOrEqual(maximum);
        expect(literal.stored_bytes + 16).toBeLessThanOrEqual(maximum);
        expect(maximumReserved).toBeGreaterThan(maximum); // Overhead stays reserved, never silently discarded or used as a smaller source quota.
        const tooWide = {...empty, lookupTiers: [[key + 'x']]};
        expect(Buffer.byteLength(JSON.stringify(tooWide))).toBeGreaterThan(maximum);
        const inventory = {
          path,
          contentHash: path,
          blobId: path,
          mode: '100644',
          size: 1,
          source: 'commit' as const,
          language: 'typescript',
        };
        const facts = {path, symbols: [], edges: [], diagnostics: [], references: [tooWide]};
        expect(resolutionCandidateFileEvidence([inventory], [facts], [facts], snapshotId).files).toEqual([]);
        const rowTooWide = {...empty, lookupTiers: [[EffectString.repeat(maximum)('x')]]};
        expect(resolutionCandidateFileRepresentable(snapshotId, {path, contentHash: path}, [rowTooWide])).toBe(false);
        expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      }).pipe(provideDatabase),
    30000,
  );
});
