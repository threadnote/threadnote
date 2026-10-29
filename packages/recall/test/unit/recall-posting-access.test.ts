import {Array as EffectArray} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import type {RecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {postingLexicalScore} from '@threadnote/recall/index/lexical';
import {selectRecallQueryTermStatistics, selectTopRecallPostingsByTerms} from '@threadnote/recall/index/selection';
import type {RecallCorpusStatistics} from '@threadnote/recall/rank';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const root = 'threadnote://user/allowed/memories';
const terms = ['alpha', 'beta'];
interface Document {
  readonly id: number;
  readonly uri: string;
  readonly logicalKey: string;
  readonly length: number;
  readonly project: string | null;
  readonly approved: boolean;
  readonly kind: 'durable' | 'preference';
  readonly terms: readonly string[];
  readonly weight: number;
  readonly frequency: number;
}
const database = SqliteClient.layer({filename: ':memory:'});
function withDatabase<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(Layer.build(database).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}
const generatedRow = fc.record({
  location: fc.constantFrom('allowed', 'other-user', 'neighbor'),
  logical: fc.integer({min: 0, max: 8}),
  length: fc.integer({min: 1, max: 80}),
  project: fc.constantFrom(null, 'p', 'q'),
  approved: fc.boolean(),
  kind: fc.constantFrom('durable' as const, 'preference' as const),
  terms: fc.subarray(terms),
  weight: fc.integer({min: 1, max: 4}),
  frequency: fc.integer({min: 1, max: 3}),
});

describe('recall posting access cost', () => {
  effectIt.effect('uses sparse global terms for a broad authorized corpus without a URI range scan', () =>
    Effect.gen(function* () {
      const documents = fixtureDocuments(200, 24);
      const sql = yield* createDocuments(documents);
      const {observed, captured} = observeQueries(sql);
      const statistics = modelStatistics(documents);
      const selected = yield* selectTopRecallPostingsByTerms(
        observed,
        ['alpha'],
        [root],
        undefined,
        undefined,
        undefined,
        undefined,
        8,
        statistics,
        {...statistics, physicalDocumentCount: documents.length},
      );
      expect(EffectArray.map(selected, row => row.uri)).toEqual(EffectArray.map(documents.slice(0, 8), row => row.uri));
      const plan = yield* queryPlan(sql, captured.at(-1)!);
      expect(
        EffectArray.some(plan, row =>
          Effect2.pipe(row.detail, EffectString.includes('SEARCH p USING PRIMARY KEY (term=?)')),
        ),
      ).toBe(true);
      expect(
        EffectArray.some(plan, row =>
          Effect2.pipe(row.detail, EffectString.includes('SEARCH d USING INTEGER PRIMARY KEY (rowid=?)')),
        ),
      ).toBe(true);
      expect(EffectArray.some(plan, row => Effect2.pipe(row.detail, EffectString.includes('documents_uri')))).toBe(
        false,
      );
    }).pipe(withDatabase),
  );

  effectIt.effect('retains the URI plan for a small user root beside another user common-term corpus', () =>
    Effect.gen(function* () {
      const documents = EffectArray.map(fixtureDocuments(200, 200), (row, index) => ({
        ...row,
        uri: index < 24 ? row.uri : Effect2.pipe(row.uri, EffectString.replace('/allowed/', '/other/')),
      }));
      const sql = yield* createDocuments(documents);
      const {observed, captured} = observeQueries(sql);
      const statistics = modelStatistics(documents.slice(0, 24));
      const selected = yield* selectTopRecallPostingsByTerms(
        observed,
        ['alpha'],
        [root],
        undefined,
        undefined,
        undefined,
        undefined,
        8,
        statistics,
        {...modelStatistics(documents), physicalDocumentCount: documents.length},
      );
      expect(EffectArray.map(selected, row => row.uri)).toEqual(EffectArray.map(documents.slice(0, 8), row => row.uri));
      expect(
        EffectArray.some(yield* queryPlan(sql, captured.at(-1)!), row =>
          Effect2.pipe(row.detail, EffectString.includes('documents_uri')),
        ),
      ).toBe(true);
    }).pipe(withDatabase),
  );

  effectIt.effect('bounds hidden physical aliases and falls back when statistics are missing or inconsistent', () =>
    Effect.gen(function* () {
      const documents = EffectArray.map(fixtureDocuments(40, 40), (row, index) => ({
        ...row,
        logicalKey: index < 4 ? row.logicalKey : 'hidden-alias',
        uri: index < 4 ? row.uri : Effect2.pipe(row.uri, EffectString.replace('/allowed/', '/other/')),
      }));
      const sql = yield* createDocuments(documents);
      const {observed, captured} = observeQueries(sql);
      const scoped = modelStatistics(documents.slice(0, 4));
      const global = {...modelStatistics(documents), physicalDocumentCount: documents.length};
      for (const evidence of [
        global,
        undefined,
        {...global, physicalDocumentCount: 1},
        {...global, physicalDocumentCount: Number.NaN},
        {...global, documentFrequency: {}},
        {...global, documentFrequency: {alpha: -1}},
      ]) {
        yield* selectTopRecallPostingsByTerms(
          observed,
          ['alpha'],
          [root],
          undefined,
          undefined,
          undefined,
          undefined,
          8,
          scoped,
          evidence,
        );
        expect(
          EffectArray.some(yield* queryPlan(sql, captured.at(-1)!), row =>
            Effect2.pipe(row.detail, EffectString.includes('documents_uri')),
          ),
        ).toBe(true);
      }
    }).pipe(withDatabase),
  );

  fcEffectProp(
    effectIt,
    'preserves scoped rows, ordering, logical statistics and storage across either access plan',
    {
      rows: fc.array(generatedRow, {minLength: 1, maxLength: 32}),
      aliases: fc.boolean(),
      queryTerms: fc.subarray(terms, {minLength: 1}),
      scope: fc.constantFrom('root', 'exact', 'both-users', 'empty', 'all'),
      policy: fc.constantFrom('any', 'approved', 'project', 'projectless', 'deny'),
      limit: fc.integer({min: 1, max: 8}),
    },
    ({rows, aliases, queryTerms, scope, policy, limit}) =>
      Effect.gen(function* () {
        const documents: Document[] = EffectArray.map(rows, (row, index) => ({
          ...row,
          id: rows.length - index,
          logicalKey: `logical-${aliases ? row.logical : index}`,
          uri: `${row.location === 'allowed' ? root : row.location === 'other-user' ? 'threadnote://user/other/memories' : `${root}-neighbor`}/${Effect2.pipe(String(index), EffectString.padStart(4, '0'))}`,
        }));
        const scopes =
          scope === 'all'
            ? undefined
            : scope === 'empty'
              ? ['   ']
              : scope === 'exact'
                ? [documents[0].uri]
                : scope === 'both-users'
                  ? [root, 'threadnote://user/other/memories']
                  : [`${root}/`, root];
        const eligibility: RecallEligibilityPolicy = {
          kind: 'candidate-policy',
          authority: policy === 'approved' ? 'approved-authoritative' : 'any',
          projects:
            policy === 'deny'
              ? {mode: 'deny-all'}
              : policy === 'project'
                ? {mode: 'allow-projects-and-projectless', projects: ['p']}
                : policy === 'projectless'
                  ? {mode: 'projectless-only'}
                  : {mode: 'unrestricted'},
        };
        const eligible = EffectArray.filter(
          documents,
          (row, index) =>
            index in documents &&
            (scope === 'all' ||
              (scope === 'exact'
                ? row.uri === documents[0].uri
                : scope === 'root'
                  ? Effect2.pipe(row.uri, EffectString.startsWith(`${root}/`))
                  : scope === 'both-users' &&
                    (Effect2.pipe(row.uri, EffectString.startsWith(`${root}/`)) ||
                      Effect2.pipe(row.uri, EffectString.startsWith('threadnote://user/other/memories/'))))) &&
            policy !== 'deny' &&
            (policy !== 'approved' || row.approved) &&
            (policy !== 'project' || row.kind === 'preference' || row.project === null || row.project === 'p') &&
            (policy !== 'projectless' || row.kind === 'preference' || row.project === null),
        );
        const sql = yield* createDocuments(documents);
        const before = yield* sql.unsafe('SELECT * FROM documents ORDER BY id');
        const corpusStatistics = modelStatistics(documents);
        const global = {...corpusStatistics, physicalDocumentCount: documents.length};
        const statistics = yield* selectRecallQueryTermStatistics(sql, terms, corpusStatistics, {
          allowedUriScopes: scopes,
          eligibility,
        });
        expect(statistics).toEqual(modelStatistics(eligible));
        const previous = yield* selectTopRecallPostingsByTerms(
          sql,
          queryTerms,
          scopes,
          eligibility,
          undefined,
          undefined,
          undefined,
          limit,
          statistics,
        );
        const {observed, captured} = observeQueries(sql);
        const selected = yield* selectTopRecallPostingsByTerms(
          observed,
          queryTerms,
          scopes,
          eligibility,
          undefined,
          undefined,
          undefined,
          limit,
          statistics,
          global,
        );
        if (
          scope !== 'all' &&
          !Effect2.pipe(captured.at(-1)!.text, EffectString.includes('INDEXED BY documents_uri'))
        ) {
          const physicalPostings = EffectArray.reduce(
            documents,
            0,
            (count, row) =>
              count +
              EffectArray.filter(
                queryTerms,
                (term, __effectArrayIndex) => __effectArrayIndex in queryTerms && row.terms.includes(term),
              ).length,
          );
          expect(physicalPostings).toBeLessThanOrEqual(eligible.length);
        }
        const expected = EffectArray.flatMap([...queryTerms].sort(), term =>
          EffectArray.map(
            EffectArray.map(
              EffectArray.filter(eligible, row => row.terms.includes(term)),
              row => ({
                row,
                score: postingLexicalScore(
                  {documentLength: row.length, fieldWeight: row.weight, termFrequency: row.frequency},
                  term,
                  statistics,
                ),
              }),
            )
              .sort(
                (a, b) =>
                  b.score - a.score ||
                  b.row.weight - a.row.weight ||
                  (a.row.uri < b.row.uri ? -1 : a.row.uri > b.row.uri ? 1 : 0),
              )
              .slice(0, limit),
            ({row}) => ({
              term,
              document_id: row.id,
              document_length: row.length,
              field_weight: row.weight,
              term_frequency: row.frequency,
              uri: row.uri,
            }),
          ),
        );
        expect(selected).toEqual(previous);
        expect(selected).toEqual(expected);
        expect(yield* sql.unsafe('SELECT * FROM documents ORDER BY id')).toEqual(before);
      }).pipe(withDatabase),
    {fastCheck: {numRuns: 50}},
  );
});

function fixtureDocuments(count: number, matches: number): Document[] {
  return Array.from({length: count}, (_, index) => ({
    id: count - index,
    uri: `${root}/${Effect2.pipe(String(index), EffectString.padStart(4, '0'))}`,
    logicalKey: `logical-${index}`,
    length: 20,
    project: 'p',
    approved: true,
    kind: 'durable',
    terms: index < matches ? ['alpha'] : [],
    weight: 1,
    frequency: 1,
  }));
}

function modelStatistics(documents: readonly Document[]): RecallCorpusStatistics {
  const lengths = new Map<string, number>();
  EffectArray.forEach(documents, row =>
    lengths.set(row.logicalKey, Math.max(lengths.get(row.logicalKey) ?? 0, row.length)),
  );
  const totalDocumentLength = EffectArray.reduce([...lengths.values()], 0, (sum, length) => sum + length);
  return {
    documentCount: lengths.size,
    totalDocumentLength,
    averageDocumentLength: lengths.size === 0 ? 1 : totalDocumentLength / lengths.size,
    documentFrequency: EffectRecord.fromEntries(
      EffectArray.flatMap(terms, term => {
        const count = new Set(
          EffectArray.map(
            EffectArray.filter(
              documents,
              (row, __effectArrayIndex) => __effectArrayIndex in documents && row.terms.includes(term),
            ),
            row => row.logicalKey,
          ),
        ).size;
        return count === 0 ? [] : [[term, count]];
      }),
    ),
  };
}

interface Query {
  readonly text: string;
  readonly parameters: readonly unknown[];
}
function observeQueries(sql: SqlClient.SqlClient) {
  const captured: Query[] = [];
  const observed = new Proxy(sql, {
    get(target, property, receiver) {
      if (property !== 'unsafe') return Reflect.get(target, property, receiver);
      return <A extends object>(text: string, parameters: readonly unknown[] = []) => {
        captured.push({text, parameters});
        return target.unsafe<A>(text, parameters);
      };
    },
  });
  return {observed, captured};
}
function queryPlan(sql: SqlClient.SqlClient, query: Query) {
  return sql.unsafe<{detail: string}>(`EXPLAIN QUERY PLAN ${query.text}`, query.parameters);
}
const createDocuments = Effect.fn('test.createRecallPostingAccessDocuments')(function* (
  documents: readonly Document[],
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(
    'CREATE TABLE documents (id INTEGER PRIMARY KEY, uri TEXT NOT NULL, logical_key TEXT NOT NULL, document_length INTEGER NOT NULL, project TEXT, approved_authoritative INTEGER NOT NULL, workspace_scope TEXT, candidate_json TEXT NOT NULL)',
  );
  yield* sql.unsafe(
    'CREATE TABLE postings (term TEXT NOT NULL, document_id INTEGER NOT NULL, field_weight REAL NOT NULL, term_frequency INTEGER NOT NULL, PRIMARY KEY(term, document_id)) WITHOUT ROWID',
  );
  yield* sql.unsafe('CREATE INDEX documents_uri ON documents(uri)');
  yield* sql.unsafe('CREATE INDEX documents_workspace_scope_uri ON documents(workspace_scope, uri)');
  yield* sql.unsafe('CREATE INDEX postings_document_id ON postings(document_id)');
  yield* sql.withTransaction(
    Effect.forEach(
      documents,
      row =>
        Effect.gen(function* () {
          yield* sql.unsafe('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, NULL, ?)', [
            row.id,
            row.uri,
            row.logicalKey,
            row.length,
            row.project,
            Number(row.approved),
            JSON.stringify({kind: row.kind}),
          ]);
          for (const term of row.terms)
            yield* sql.unsafe('INSERT INTO postings VALUES (?, ?, ?, ?)', [term, row.id, row.weight, row.frequency]);
        }),
      {discard: true},
    ),
  );
  return sql;
});
