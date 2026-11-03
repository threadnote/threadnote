import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, Layer, pipe} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
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
} from '@threadnote/graph/store/resolution/candidate_index';
import {selectResolutionCandidateIndexClosure} from '@threadnote/graph/store/resolution/candidate_index_read';
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
      expect(result.directAliasSymbolConflictIdentities).toEqual(new Set(['typescript\0alias']));
      expect(result.candidateIndex?.associationsRead).toBeGreaterThan(0);
      const unresolved = yield* selectResolutionCandidateIndexClosure(sql, query('unresolved-fallback'));
      expect(unresolved).toMatchObject({mode: 'eligible', paths});
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
      yield* sql`DELETE FROM snapshot_candidate_lookup WHERE snapshot_id = 'base' AND evidence_path = 'b.ts'`;
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
      yield* sql`DELETE FROM snapshot_candidate_lookup WHERE snapshot_id = 'base' AND lookup_key = 'stable'`;
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

  effectIt.effect(
    'does not rebind an old complete file when canonical restaging detects extra retained lookup rows',
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* createSnapshot(sql, 'base', ['a.ts']);
        yield* stage(sql, 'base', ['a.ts'], [reference('a.ts', 'value')]);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(true);
        yield* sql.unsafe('DROP TRIGGER snapshot_candidate_lookup_candidate_invalidate_insert');
        yield* sql`INSERT INTO snapshot_candidate_lookup VALUES ('base', 'typescript', 'untrusted-extra', 'a.ts')`;
        expect(yield* ensureResolutionCandidateIndexSchema(sql)).toBe(true);
        yield* stage(sql, 'base', ['a.ts'], [reference('a.ts', 'value')]);
        expect(
          yield* sql`SELECT complete FROM snapshot_candidate_files WHERE snapshot_id = 'base' AND path = 'a.ts'`,
        ).toEqual([{complete: 0}]);
        expect(yield* finishResolutionCandidateIndex(sql, identity, write)).toBe(false);
        expect(yield* selectResolutionCandidateIndexClosure(sql, query('value'))).toBeUndefined();
      }).pipe(provideDatabase),
  );

  effectIt.effect('blocks populated missing-index recovery without rebuilding or touching retained proof', () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const paths = Array.from({length: 1507}, (_, n) => `indexed-${n}.ts`);
      const references = EffectArray.map(paths, path => reference(path, path));
      yield* createSnapshot(sql, 'base', paths);
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
      expect(maximumFiles).toBe(1000);
      expect(maximumBindings).toBe(1000);
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
          candidateIndex: {associationsRead: 1},
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
});
