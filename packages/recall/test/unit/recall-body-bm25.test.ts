import {it as effectIt} from '@effect/vitest';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Array as EffectArray, Effect, Layer, String as EffectString} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect, it} from 'vitest';
import {
  dropRecallBodyBm25Staging,
  initializeRecallBodyBm25Staging,
  publishRecallBodyBm25,
  selectRecallBodyBm25,
  stageRecallBodyBm25,
  stageRecallBodyBm25TermFrequencies,
} from '../../src/index/body-bm25.js';
import {initializeRecallDatabase} from '../../src/index/schema.js';
import {reciprocalRankFusion} from '../../src/rank-fusion.js';
import {recallCandidateLogicalCorpusKey, recallMemoryContentHash, type RecallCandidate} from '../../src/rank.js';

const root = 'threadnote://user/reader/memories';
const personal = `${root}/durable/projects/p`;
const allowedTeam = `${root}/shared/allowed`;
const deniedTeam = `${root}/shared/denied`;
const corpusLayer = SqliteClient.layer({filename: ':memory:', disableWAL: true});

function withDatabase<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(Layer.build(corpusLayer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}

const eligibility = {
  kind: 'candidate-policy',
  projects: {mode: 'allow-projects-and-projectless', projects: ['p']},
  authority: 'approved-authoritative',
} as const;

function memory(uri: string, text: string, properties: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    uri,
    text,
    kind: 'durable',
    fields: {project: 'p', topic: 'metadata-only'},
    contentHash: recallMemoryContentHash(text),
    ...properties,
  };
}

function publish(sql: SqlClient.SqlClient, documents: readonly RecallCandidate[]) {
  return Effect.gen(function* () {
    yield* initializeRecallBodyBm25Staging(sql);
    for (const batch of EffectArray.chunksOf(documents, 8)) {
      yield* stageRecallBodyBm25(sql, 'reader', batch);
      for (const document of batch) {
        const approved = document.trust === 'untrusted' ? 0 : 1;
        yield* sql`
          INSERT INTO documents (
            uri, project, approved_authoritative, source_path, source_size,
            uri_locator_digest, logical_key, document_length, memory_links_truncated, candidate_json
          ) VALUES (
            ${document.uri}, ${document.fields?.project ?? null}, ${approved}, ${document.uri}, ${document.text.length},
            'test', ${recallCandidateLogicalCorpusKey(document)}, 0, 0, ${JSON.stringify(document)}
          )
        `;
      }
    }
    yield* stageRecallBodyBm25TermFrequencies(sql);
    yield* publishRecallBodyBm25(sql);
    yield* dropRecallBodyBm25Staging(sql);
  });
}

function fts5Reference(sql: SqlClient.SqlClient, documents: readonly RecallCandidate[]) {
  return Effect.gen(function* () {
    yield* sql.unsafe(
      "CREATE VIRTUAL TABLE temp.bm25_reference USING fts5(uri UNINDEXED, body, tokenize = 'unicode61')",
    );
    for (const document of documents) {
      yield* sql`INSERT INTO temp.bm25_reference VALUES (${document.uri}, ${document.text})`;
    }
    const rows = yield* sql<{readonly uri: string}>`
      SELECT uri FROM temp.bm25_reference
      WHERE bm25_reference MATCH '"alpha" OR "cafe"'
      ORDER BY bm25(bm25_reference), uri COLLATE BINARY
      LIMIT 10
    `;
    return EffectArray.map(rows, row => row.uri);
  });
}

describe('body-only BM25', () => {
  effectIt.effect('matches FTS5 over authorized, active, deduplicated complete bodies', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeRecallDatabase(sql);
      const owned = memory(`${personal}/a.md`, 'Café alpha alpha', {memoryId: 'tn_owned'});
      const teamAlias = {...owned, uri: `${allowedTeam}/durable/projects/p/alias.md`};
      const teamOnly = memory(`${allowedTeam}/durable/projects/p/b.md`, 'cafe shrub');
      const local = memory(`${personal}/c.md`, 'cafe');
      const other = memory(`${personal}/d.md`, 'alpha coral');
      const empty = memory(`${personal}/empty.md`, '');
      const authorized = [owned, teamOnly, local, other, empty];
      yield* publish(sql, [
        ...authorized,
        teamAlias,
        memory(`${deniedTeam}/durable/projects/p/denied.md`, 'alpha alpha'),
        memory(`${root}/durable/projects/q/d.md`, 'alpha', {fields: {project: 'q'}}),
        memory(`${personal}/untrusted.md`, 'alpha', {trust: 'untrusted'}),
        memory(`${personal}/inactive.md`, 'alpha', {status: 'archived'}),
        memory(`${personal}/future.md`, 'alpha', {validFrom: '3000-01-01T00:00:00Z'}),
        memory('threadnote://resources/external/pocket/denied.md', 'café'),
        memory('threadnote://user/other/memories/durable/denied.md', 'café'),
      ]);
      yield* sql`INSERT INTO oversized_sources VALUES (${`${deniedTeam}/oversized.md`})`;
      const options = {allowedSharedUriScopes: [allowedTeam], eligibility, includeInactive: false};
      const rank = yield* selectRecallBodyBm25(sql, 'reader', {...options, query: '"É" Café cafe ALPHA'});
      expect(rank).toEqual(yield* fts5Reference(sql, authorized));
      const hardScoped = yield* selectRecallBodyBm25(sql, 'reader', {
        ...options,
        allowedUriScopes: [allowedTeam],
        query: 'alpha café',
      });
      expect(hardScoped).toEqual([teamAlias.uri, teamOnly.uri]);
      expect(yield* selectRecallBodyBm25(sql, 'reader', {...options, query: 'metadata-only'})).toEqual([]);
      yield* sql`INSERT INTO oversized_sources VALUES (${`${root}/durable/projects/other/oversized.md`})`;
      expect(yield* selectRecallBodyBm25(sql, 'reader', {...options, query: 'alpha café'})).toEqual(rank);
    }).pipe(withDatabase),
  );

  effectIt.effect('finds a match beyond 512 documents and removes obsolete postings on replacement', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeRecallDatabase(sql);
      const filler = EffectArray.makeBy(513, index => memory(`${personal}/filler-${index}.md`, `coral ${index}`));
      const target = memory(`${personal}/target.md`, 'albatross evidence');
      yield* publish(sql, [...filler, target]);
      const lookup = (query: string) => selectRecallBodyBm25(sql, 'reader', {query, includeInactive: false});
      expect(yield* lookup('albatross')).toEqual([target.uri]);
      yield* sql`DELETE FROM documents WHERE uri = ${target.uri}`;
      yield* publish(sql, [memory(target.uri, 'plover evidence')]);
      expect(yield* lookup('albatross')).toEqual([]);
      expect(yield* lookup('plover')).toEqual([target.uri]);
    }).pipe(withDatabase),
  );
});

describe('reciprocal rank fusion', () => {
  it('uses fixed top-ten windows and exact URI tie breaks', () => {
    expect(reciprocalRankFusion(['b', 'd', 'c'], ['a', 'c', 'd'])).toEqual(['c', 'd', 'a', 'b']);
    const hybrid = EffectArray.makeBy(12, index => `h${EffectString.padStart(2, '0')(String(index))}`);
    expect(reciprocalRankFusion(hybrid, ['h11'])).toEqual(['h00', 'h11', ...hybrid.slice(1, 10)]);
  });
});
