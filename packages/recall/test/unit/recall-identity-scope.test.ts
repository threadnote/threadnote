import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  createRecallIdentityConflictLoader,
  initializeRecallIdentityIndex,
  RECALL_IDENTITY_COLUMN_SCHEMA_VERSION,
  recallIndexMetadataIsCurrent,
  rebuildRecallIdentityConflicts,
} from '@threadnote/recall/index/identity';
import {
  recallIdentityUriScopePredicate,
  recallUriScopePredicate,
  type RecallSqlPredicate,
} from '@threadnote/recall/index/scope';
import {selectRecallDocumentRowsByMemoryIds} from '@threadnote/recall/index/selection';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const root = 'threadnote://user/me/memories/durable';
const target = `${root}/target.md`;
const edge = fc.oneof(
  fc.constantFrom(
    'a',
    'a0',
    'a-other',
    '日本語',
    '🌊',
    "quote'",
    'double"',
    '%20',
    '_',
    '\\',
    'a\uD800b',
    'a\uDFFFb',
    'a\uFFFDb',
    'a\u0000b',
    'a\tb',
    'a\nb',
  ),
  fc.array(fc.integer({min: 0, max: 0xffff}), {minLength: 1, maxLength: 3}).map(codes => String.fromCharCode(...codes)),
);
const uri = fc.array(edge, {minLength: 1, maxLength: 3}).map(parts => `${root}/${EffectArray.join(parts, '/')}`);
const document = fc.record({uri, memoryId: fc.constantFrom('tn_a', 'tn_b'), contentHash: fc.constantFrom('a', 'b')});

interface Row {
  readonly uri: string;
  readonly memoryId: string;
  readonly contentHash: string;
}

function withDatabase<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Layer.build(SqliteClient.layer({filename: ':memory:'})).pipe(
      Effect.flatMap(context => effect.pipe(Effect.provide(context))),
    ),
  );
}

function createDatabase(rows: readonly Row[]): Database {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE documents (id INTEGER PRIMARY KEY, uri TEXT NOT NULL, candidate_json TEXT NOT NULL)');
  const insert = database.query('INSERT INTO documents (uri, candidate_json) VALUES (?, ?)');
  for (const row of rows) insert.run(row.uri, JSON.stringify(row));
  return database;
}

function selected(database: Database, scope: RecallSqlPredicate, conflicts = false) {
  return database
    .query(
      conflicts
        ? `SELECT json_extract(d.candidate_json, '$.memoryId') AS memory_id
           FROM documents AS d WHERE ${scope.sql}
           GROUP BY json_extract(d.candidate_json, '$.memoryId')
           HAVING COUNT(DISTINCT json_extract(d.candidate_json, '$.contentHash')) > 1
           ORDER BY memory_id`
        : `SELECT id FROM documents AS d WHERE ${scope.sql} ORDER BY id`,
    )
    .all(...scope.params);
}

describe('stable identity URI scope SQL', () => {
  it('preserves unrestricted, invalid-only, normalized and exact-or-descendant boundaries', () => {
    const database = createDatabase(
      EffectArray.map(
        [root, `${root}/`, target, `${target}/child`, `${root}0/neighbor`, `${root}-other/neighbor`],
        uri => ({
          uri,
          memoryId: 'tn_a',
          contentHash: 'a',
        }),
      ),
    );
    try {
      const scopes: readonly (readonly string[] | undefined)[] = [
        undefined,
        [],
        ['', '#invalid', '///#invalid'],
        [root],
        [`${root}///#ignored`, root, target],
        [target],
        [target, target],
        [`${root}0`],
      ];
      for (const inputs of scopes) {
        const original = recallUriScopePredicate('d', inputs);
        const identity = recallIdentityUriScopePredicate('d', inputs);
        expect(identity.restricted).toBe(original.restricted);
        expect(selected(database, identity)).toEqual(selected(database, original));
      }
      expect(selected(database, recallIdentityUriScopePredicate('d', [target]))).toEqual([{id: 3}, {id: 4}]);
      expect(selected(database, recallIdentityUriScopePredicate('d', ['#invalid']))).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('preserves SQL UTF-8 binding for lone surrogates, replacement characters, NUL and duplicate malformed scopes', () => {
    for (const suffix of [
      'a\uD800b',
      'a\uDFFFb',
      'a\uD800\uD800b',
      'a\uDFFF\uD800b',
      'a\uD800',
      'a\uDFFF',
      'a\uD800\uDFFFb',
      'a\uFFFDb',
      'a\u0000b',
      'a\tb',
      'a\nb',
      '🌊',
    ]) {
      const scope = `${root}/${suffix}`;
      const database = createDatabase(
        EffectArray.map([scope, `${scope}/child`, `${scope}0/neighbor`, `${root}/unrelated`], uri => ({
          uri,
          memoryId: 'tn_a',
          contentHash: 'a',
        })),
      );
      try {
        const scopes = [scope, scope, `${root}/a\uD800b`, `${root}/a\uDFFFb`, `${scope}///#ignored`];
        const original = recallUriScopePredicate('d', scopes);
        const identity = recallIdentityUriScopePredicate('d', scopes);
        expect(selected(database, identity)).toEqual(selected(database, original));
        if (suffix === 'a\uD800b' || suffix === 'a\uDFFFb')
          expect(selected(database, identity)).toEqual([{id: 1}, {id: 2}]);
      } finally {
        database.close();
      }
    }
    const malformed = [`${root}/a\uD800b`, `${root}/🌊`, `${root}/a\u0000b`];
    expect(recallIdentityUriScopePredicate('d', malformed)).toEqual(recallUriScopePredicate('d', malformed));
    const wellFormed = [`${root}/a\uFFFDb`, `${root}/🌊`, `${root}/a\u0000b`];
    expect(JSON.parse(recallIdentityUriScopePredicate('d', wellFormed).params[0])).toEqual(wellFormed);
  });

  it('matches the retained range predicate and its conflict corpus for generated scopes and lexical edges', () => {
    fc.assert(
      fc.property(
        fc.array(document, {minLength: 1, maxLength: 18}),
        fc.array(uri, {maxLength: 10}),
        fc.boolean(),
        (rows, extraScopes, restrict) => {
          const database = createDatabase(rows);
          try {
            const scopes = restrict
              ? [
                  ...extraScopes,
                  ...EffectArray.map(rows.slice(0, 3), row => `${row.uri}///#ignored`),
                  '#invalid',
                  ...extraScopes.slice(0, 2),
                ]
              : undefined;
            const original = recallUriScopePredicate('d', scopes);
            const identity = recallIdentityUriScopePredicate('d', scopes);
            expect(selected(database, identity)).toEqual(selected(database, original));
            expect(selected(database, identity, true)).toEqual(selected(database, original, true));
            expect(
              selected(
                database,
                recallIdentityUriScopePredicate('d', scopes === undefined ? undefined : [...scopes].reverse()),
              ),
            ).toEqual(selected(database, identity));
          } finally {
            database.close();
          }
        },
      ),
      {numRuns: 100, seed: 20261026},
    );
  });

  it('keeps restricted SQL and parameter count fixed as retained scopes grow', () => {
    const small = recallIdentityUriScopePredicate('d', [target]);
    for (const count of [10, 200, 1024]) {
      const scopes = Array.from({length: count}, (_, index) => `${root}/owned-${index}.md`);
      const predicate = recallIdentityUriScopePredicate('d', [...scopes, target]);
      expect(predicate.sql).toBe(small.sql);
      expect(predicate.params).toHaveLength(1);
      expect(JSON.parse(predicate.params[0])).toEqual([...scopes, target]);
    }
  });

  effectIt.effect('uses the identity index for candidate and conflict selectors with growing authorized history', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(
        'CREATE TABLE documents (id INTEGER PRIMARY KEY, uri TEXT NOT NULL, candidate_json TEXT NOT NULL, project TEXT, approved_authoritative INTEGER NOT NULL)',
      );
      yield* sql.unsafe('CREATE INDEX documents_uri ON documents(uri)');
      yield* initializeRecallIdentityIndex(sql);
      const externalUri = 'threadnote://resources/external/github/org/repo/doc.md';
      const rows: readonly Row[] = [
        {uri: target, memoryId: 'tn_a', contentHash: 'a'},
        {uri: `${root}/duplicate.md`, memoryId: 'tn_a', contentHash: 'b'},
        {uri: `${root}/other.md`, memoryId: 'tn_b', contentHash: 'a'},
        {uri: `${root}0/unauthorized.md`, memoryId: 'tn_a', contentHash: 'c'},
        {uri: externalUri, memoryId: 'tn_ext', contentHash: 'ext-a'},
        {uri: `${root}/ext-copy.md`, memoryId: 'tn_ext', contentHash: 'ext-b'},
      ];
      for (const row of rows)
        yield* sql.unsafe(
          'INSERT INTO documents (uri, memory_id, content_hash, candidate_json, approved_authoritative) VALUES (?, ?, ?, ?, 0)',
          [row.uri, row.memoryId, row.contentHash, JSON.stringify(row)],
        );
      const captured: {text: string; parameters: readonly unknown[]}[] = [];
      const observed = new Proxy(sql, {
        get(target, property, receiver) {
          if (property !== 'unsafe') return Reflect.get(target, property, receiver);
          return <A extends object>(text: string, parameters: readonly unknown[] = []) => {
            captured.push({text, parameters});
            return target.unsafe<A>(text, parameters);
          };
        },
      });
      for (const count of [0, 10, 200, 1024]) {
        const scopes = [...Array.from({length: count}, (_, index) => `${root}/owned-${index}.md`), target];
        const candidates = yield* selectRecallDocumentRowsByMemoryIds(observed, ['tn_a'], scopes, undefined);
        expect(EffectArray.map(candidates, row => row.uri)).toEqual([target]);
        const loadConflicts = createRecallIdentityConflictLoader(observed);
        expect(yield* loadConflicts(scopes, undefined, ['tn_a'])).toEqual(new Set());
        expect(yield* loadConflicts([...scopes, `${root}/duplicate.md`], undefined, ['tn_a'])).toEqual(
          new Set(['tn_a']),
        );
      }
      const loadExternalConflicts = createRecallIdentityConflictLoader(observed);
      expect(
        yield* loadExternalConflicts(
          [`${root}/ext-copy.md`, externalUri],
          {
            kind: 'candidate-policy',
            authority: 'any',
            projects: {mode: 'unrestricted'},
            externalResources: {[externalUri]: 'ext-a'},
          },
          ['tn_ext'],
        ),
      ).toEqual(new Set(['tn_ext']));

      let coveringPlanCount = 0;
      for (const query of captured) {
        const plan = yield* sql.unsafe<{detail: string}>(`EXPLAIN QUERY PLAN ${query.text}`, query.parameters);
        const isConflictQuery =
          Effect2.pipe(query.text, EffectString.includes('GROUP BY')) ||
          Effect2.pipe(query.text, EffectString.includes('HAVING COUNT(DISTINCT'));
        if (isConflictQuery) coveringPlanCount += 1;
        const expectedPlanDetail = isConflictQuery
          ? 'SEARCH d USING COVERING INDEX documents_memory_identity'
          : 'SEARCH d USING INDEX documents_memory_identity';
        expect(EffectArray.some(plan, row => Effect2.pipe(row.detail, EffectString.includes(expectedPlanDetail)))).toBe(
          true,
        );
        expect(EffectArray.some(plan, row => row.detail === 'SCAN d')).toBe(false);
      }
      expect(captured).toHaveLength(13);
      expect(coveringPlanCount).toBe(9);
    }).pipe(withDatabase),
  );

  effectIt.effect(
    'uses covering indexes for full conflict rebuilds and document_length aggregates while upgrading legacy v13 indexes idempotently',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
        yield* sql.unsafe(
          "CREATE TABLE documents (id INTEGER PRIMARY KEY, uri TEXT UNIQUE NOT NULL, candidate_json TEXT NOT NULL, project TEXT, approved_authoritative INTEGER NOT NULL, logical_key TEXT NOT NULL DEFAULT 'k', document_length INTEGER NOT NULL DEFAULT 10)",
        );
        yield* sql.unsafe(`
          CREATE TRIGGER documents_integrity_update
          AFTER UPDATE ON documents
          BEGIN
            UPDATE metadata
            SET value = CAST(value AS INTEGER) + 1
            WHERE key = 'mutation_sequence';
          END
        `);
        yield* sql.unsafe('CREATE INDEX documents_logical_key ON documents(logical_key)');
        yield* sql.unsafe(
          `CREATE INDEX documents_memory_identity
           ON documents(json_extract(candidate_json, '$.memoryId'), json_extract(candidate_json, '$.contentHash'))`,
        );
        yield* sql.unsafe(
          `INSERT INTO metadata (key, value) VALUES
             ('content_generation', 'gen-legacy'),
             ('memory_identity_conflict_generation', 'gen-legacy'),
             ('mutation_sequence', '4'),
             ('integrity_sequence', '4')`,
        );
        yield* sql.unsafe(
          'INSERT INTO documents (uri, candidate_json, approved_authoritative, logical_key, document_length) VALUES (?, ?, 0, ?, ?)',
          [target, JSON.stringify({uri: target, memoryId: 'tn_a', contentHash: 'a'}), 'k-a', 12],
        );
        yield* sql.unsafe(
          'INSERT INTO documents (uri, candidate_json, approved_authoritative, logical_key, document_length) VALUES (?, ?, 0, ?, ?)',
          [
            `${root}/duplicate.md`,
            JSON.stringify({uri: `${root}/duplicate.md`, memoryId: 'tn_a', contentHash: 'b'}),
            'k-a',
            18,
          ],
        );
        yield* sql.unsafe(
          'INSERT INTO documents (uri, candidate_json, approved_authoritative, logical_key, document_length) VALUES (?, ?, 0, ?, ?)',
          [
            `${root}/single.md`,
            JSON.stringify({uri: `${root}/single.md`, memoryId: 'tn_b', contentHash: 'a'}),
            'k-b',
            7,
          ],
        );
        yield* sql.unsafe(
          'INSERT INTO documents (uri, candidate_json, approved_authoritative, logical_key, document_length) VALUES (?, ?, 0, ?, ?)',
          [`${root}/plain.md`, JSON.stringify({uri: `${root}/plain.md`}), 'k-plain', 4],
        );

        const loadMetadata = sql
          .unsafe<{key: string; value: string}>('SELECT key, value FROM metadata')
          .pipe(Effect.map(rows => new Map(EffectArray.map(rows, row => [row.key, row.value] as const))));
        expect(recallIndexMetadataIsCurrent(yield* loadMetadata)).toBe(false);

        yield* initializeRecallIdentityIndex(sql);

        const afterFirst = yield* loadMetadata;
        expect(afterFirst.get('memory_identity_schema_version')).toBe(RECALL_IDENTITY_COLUMN_SCHEMA_VERSION);
        expect(recallIndexMetadataIsCurrent(afterFirst)).toBe(true);
        const migratedSequence = afterFirst.get('mutation_sequence');
        expect(Number(migratedSequence)).toBeGreaterThan(4);

        const indexRow = yield* sql.unsafe<{sql: string}>(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'documents_memory_identity'",
        );
        expect(indexRow[0]?.sql).toContain('(memory_id, content_hash, uri)');
        expect(indexRow[0]?.sql).not.toContain('json_extract');
        const logicalKeyIndexRow = yield* sql.unsafe<{sql: string}>(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'documents_logical_key'",
        );
        expect(logicalKeyIndexRow[0]?.sql).toContain('(logical_key, document_length)');

        for (const aggregateQuery of [
          'SELECT COUNT(*) AS document_count, COALESCE(SUM(document_length), 0) AS total_document_length FROM documents',
          'SELECT COUNT(*) AS document_count, COALESCE(SUM(document_length), 0) AS total_document_length FROM (SELECT logical_key, MAX(document_length) AS document_length FROM documents GROUP BY logical_key)',
        ]) {
          const plan = yield* sql.unsafe<{detail: string}>(`EXPLAIN QUERY PLAN ${aggregateQuery}`);
          expect(
            EffectArray.some(plan, row =>
              Effect2.pipe(row.detail, EffectString.includes('USING COVERING INDEX documents_logical_key')),
            ),
          ).toBe(true);
        }

        yield* initializeRecallIdentityIndex(sql);
        const afterSecond = yield* loadMetadata;
        expect(afterSecond.get('mutation_sequence')).toBe(migratedSequence);
        expect(recallIndexMetadataIsCurrent(afterSecond)).toBe(true);

        const capturedRebuild: string[] = [];
        const observed = new Proxy(sql, {
          get(target, property, receiver) {
            if (property !== 'unsafe') return Reflect.get(target, property, receiver);
            return <A extends object>(text: string, parameters: readonly unknown[] = []) => {
              if (Effect2.pipe(text, EffectString.includes('INSERT INTO memory_identity_conflicts')))
                capturedRebuild.push(text);
              return target.unsafe<A>(text, parameters);
            };
          },
        });
        yield* rebuildRecallIdentityConflicts(observed);
        expect(capturedRebuild).toHaveLength(1);
        const rebuildPlan = yield* sql.unsafe<{detail: string}>(`EXPLAIN QUERY PLAN ${capturedRebuild[0]}`);
        expect(
          EffectArray.some(rebuildPlan, row =>
            Effect2.pipe(row.detail, EffectString.includes('USING COVERING INDEX documents_memory_identity')),
          ),
        ).toBe(true);
        const conflicts = yield* sql.unsafe<{memory_id: string}>(
          'SELECT memory_id FROM memory_identity_conflicts ORDER BY memory_id',
        );
        expect(conflicts).toEqual([{memory_id: 'tn_a'}]);
      }).pipe(withDatabase),
  );
});
