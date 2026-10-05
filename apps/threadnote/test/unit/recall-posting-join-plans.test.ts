import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect} from 'vitest';
import type {RecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {postingLexicalScore} from '@threadnote/recall/index/lexical';
import {selectRecallQueryTermStatistics, selectTopRecallPostingsByTerms} from '@threadnote/recall/index/selection';
import type {RecallCorpusStatistics} from '@threadnote/recall/rank';
import {provideTestLayer} from '../helpers/effect-layer.js';

const withDatabase = provideTestLayer(SqliteClient.layer({filename: ':memory:'}));
const prefix = 'threadnote://user/test/memories/allowed';
const terms = ['alpha', 'beta', 'absent'];
interface Document {
  readonly id: number;
  readonly uri: string;
  readonly logicalKey: string;
  readonly length: number;
  readonly project: string | null;
  readonly workspace: string | null;
  readonly approved: boolean;
  readonly terms: readonly string[];
  readonly weight: number;
  readonly frequency: number;
}
type Selection = Parameters<typeof selectRecallQueryTermStatistics>[3];
const generatedDocument = FC.record({
  allowed: FC.boolean(),
  approved: FC.boolean(),
  frequency: FC.integer({min: 1, max: 3}),
  length: FC.integer({min: 1, max: 100}),
  logical: FC.integer({min: 0, max: 12}),
  project: FC.constantFrom(null, 'p', 'q'),
  terms: FC.subarray(['alpha', 'beta']),
  weight: FC.integer({min: 1, max: 5}),
  workspace: FC.constantFrom(null, 'team', 'team/app', 'elsewhere'),
});

describe('scoped recall posting joins', () => {
  effectIt.effect('filters aliases, URI boundaries and authority before logical counts and posting limits', () =>
    Effect.gen(function* () {
      const base = {project: 'p', workspace: null, approved: true, terms: ['alpha'], weight: 1, frequency: 1};
      const documents: Document[] = [
        {...base, id: 4, uri: `${prefix}/first`, logicalKey: 'shared', length: 10},
        {...base, id: 3, uri: `${prefix}/alias`, logicalKey: 'shared', length: 20},
        {...base, id: 2, uri: `${prefix}-elsewhere/high`, logicalKey: 'shared', length: 1_000, weight: 1_000},
        {
          ...base,
          id: 1,
          uri: `${prefix}/unapproved`,
          logicalKey: 'other',
          length: 1_000,
          weight: 1_000,
          approved: false,
        },
      ];
      const sql = yield* createDocuments(documents);
      const eligibility = {
        kind: 'candidate-policy',
        authority: 'approved-authoritative',
        projects: {mode: 'unrestricted'},
      } as const;
      const statistics = yield* selectRecallQueryTermStatistics(sql, ['alpha'], modelStatistics(documents), {
        allowedUriScopes: [prefix],
        eligibility,
        project: 'p',
      });
      expect(statistics).toEqual({
        documentCount: 1,
        totalDocumentLength: 20,
        averageDocumentLength: 20,
        documentFrequency: {alpha: 1},
      });
      const selected = yield* selectTopRecallPostingsByTerms(
        sql,
        ['alpha'],
        [prefix],
        eligibility,
        'p',
        undefined,
        undefined,
        1,
        statistics,
      );
      expect(selected.map(row => row.document_id)).toEqual([4]);
    }).pipe(withDatabase),
  );

  effectIt.effect('counts sparse URI-scoped terms by document rowid without repeated range scans', () =>
    Effect.gen(function* () {
      const documents: Document[] = Array.from({length: 2_000}, (_, index) => ({
        id: 2_000 - index,
        uri: `${prefix}/${String(index).padStart(5, '0')}`,
        logicalKey: `logical-${index}`,
        length: 20,
        project: 'p',
        workspace: null,
        approved: true,
        terms: index < 24 ? ['alpha'] : [],
        weight: 1,
        frequency: 1,
      }));
      const sql = yield* createDocuments(documents);
      const {captured, observed} = observeQueries(sql);
      const options = {allowedUriScopes: [prefix], project: 'p'};
      const statistics = yield* selectRecallQueryTermStatistics(
        observed,
        ['alpha'],
        modelStatistics(documents),
        options,
      );
      expect(statistics.documentFrequency).toEqual({alpha: 24});
      const selected = yield* selectTopRecallPostingsByTerms(
        observed,
        ['alpha'],
        [prefix],
        undefined,
        'p',
        undefined,
        undefined,
        8,
        statistics,
      );
      expect(selected.map(row => row.uri)).toEqual(documents.slice(0, 8).map(row => row.uri));
      const joins = captured.filter(query => query.text.includes('COUNT(DISTINCT d.logical_key)'));
      expect(joins).toHaveLength(1);
      for (const query of joins) {
        const plan = yield* sql.unsafe<{detail: string}>(`EXPLAIN QUERY PLAN ${query.text}`, query.parameters);
        expect(plan.some(row => /SEARCH p USING PRIMARY KEY \(term=/u.test(row.detail))).toBe(true);
        expect(plan.some(row => row.detail.includes('SEARCH d USING INTEGER PRIMARY KEY (rowid=?)'))).toBe(true);
        expect(plan.some(row => /(?:SCAN d|SEARCH d USING INDEX documents_uri)/u.test(row.detail))).toBe(false);
      }
    }).pipe(withDatabase),
  );

  effectIt.effect('retains workspace-only frequency and narrow-scope top-posting access plans', () =>
    Effect.gen(function* () {
      const documents: Document[] = Array.from({length: 100}, (_, index) => ({
        id: index + 1,
        uri: `${prefix}/${index}`,
        logicalKey: `logical-${index}`,
        length: 20,
        project: 'p',
        workspace: index === 0 ? 'team/app' : 'elsewhere',
        approved: true,
        terms: ['alpha'],
        weight: 1,
        frequency: 1,
      }));
      const sql = yield* createDocuments(documents);
      const {captured, observed} = observeQueries(sql);
      for (const allowedUriScopes of [undefined, []]) {
        const statistics = yield* selectRecallQueryTermStatistics(observed, ['alpha'], modelStatistics(documents), {
          allowedUriScopes,
          workspaceScope: 'team/app',
        });
        expect(statistics.documentFrequency).toEqual({alpha: 1});
      }
      const frequencyQueries = captured.filter(query => query.text.includes('COUNT(DISTINCT d.logical_key)'));
      expect(frequencyQueries).toHaveLength(2);
      expect(frequencyQueries[0]).toEqual(frequencyQueries[1]);
      for (const query of frequencyQueries) {
        const plan = yield* sql.unsafe<{detail: string}>(`EXPLAIN QUERY PLAN ${query.text}`, query.parameters);
        expect(plan.some(row => row.detail.includes('documents_workspace_scope_uri'))).toBe(true);
      }
      const selected = yield* selectTopRecallPostingsByTerms(
        observed,
        ['alpha'],
        [documents[0].uri],
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        modelStatistics(documents.slice(0, 1)),
      );
      expect(selected.map(row => row.document_id)).toEqual([1]);
      const postingQuery = captured.find(query => query.text.startsWith('WITH query_terms'))!;
      const plan = yield* sql.unsafe<{detail: string}>(
        `EXPLAIN QUERY PLAN ${postingQuery.text}`,
        postingQuery.parameters,
      );
      expect(plan.some(row => row.detail.includes('documents_uri'))).toBe(true);
    }).pipe(withDatabase),
  );

  fcEffectProp(
    effectIt,
    'matches independent scoped logical statistics and JavaScript ranking before every per-term limit',
    {
      rows: FC.array(generatedDocument, {minLength: 1, maxLength: 36}),
      limit: FC.integer({min: 1, max: 8}),
      scope: FC.constantFrom('prefix', 'exact', 'all', 'empty'),
      project: FC.constantFrom(undefined, 'p'),
      workspace: FC.constantFrom('all', 'hierarchy', 'sibling'),
      policy: FC.constantFrom('any', 'approved', 'project', 'deny', 'pinned'),
    },
    ({rows, limit, scope, project, workspace, policy}) =>
      Effect.gen(function* () {
        const documents: Document[] = rows.map((row, index) => ({
          ...row,
          id: rows.length - index,
          uri: `${prefix}${row.allowed ? '' : '-elsewhere'}/${String(index).padStart(4, '0')}`,
          logicalKey: `logical-${row.logical}`,
        }));
        const allowedUriScopes =
          scope === 'all'
            ? undefined
            : scope === 'empty'
              ? ['   ']
              : scope === 'exact'
                ? [documents[0].uri]
                : [`${prefix}/`, prefix];
        const eligibility: RecallEligibilityPolicy | undefined =
          policy === 'any'
            ? undefined
            : policy === 'pinned'
              ? {kind: 'pinned-hard-uri-bypass'}
              : {
                  kind: 'candidate-policy',
                  authority: policy === 'approved' ? 'approved-authoritative' : 'any',
                  projects:
                    policy === 'deny'
                      ? {mode: 'deny-all'}
                      : policy === 'project'
                        ? {mode: 'allow-projects-and-projectless', projects: ['p']}
                        : {mode: 'unrestricted'},
                };
        const options: Selection = {
          allowedUriScopes,
          eligibility,
          project,
          workspaceScope: workspace === 'all' ? undefined : 'team/app',
          workspaceScopeMode: workspace === 'sibling' ? 'sibling' : 'hierarchy',
        };
        const eligible = documents.filter(
          row =>
            (scope === 'all' ||
              (scope === 'exact'
                ? row.uri === documents[0].uri
                : scope === 'prefix' && row.uri.startsWith(`${prefix}/`))) &&
            (project === undefined || row.project === project) &&
            policy !== 'deny' &&
            (policy !== 'approved' || row.approved) &&
            (policy !== 'project' || row.project === null || row.project === 'p') &&
            (workspace === 'all' ||
              (workspace === 'hierarchy'
                ? row.workspace === null || row.workspace === 'team' || row.workspace === 'team/app'
                : row.workspace !== null && row.workspace !== 'team' && row.workspace !== 'team/app')),
        );
        const sql = yield* createDocuments(documents);
        const before = yield* sql.unsafe('SELECT * FROM documents ORDER BY id');
        const expectedStatistics = modelStatistics(eligible);
        const actualStatistics = yield* selectRecallQueryTermStatistics(
          sql,
          terms,
          modelStatistics(documents),
          options,
        );
        expect(actualStatistics).toEqual(expectedStatistics);
        const selected = yield* selectTopRecallPostingsByTerms(
          sql,
          terms,
          allowedUriScopes,
          eligibility,
          project,
          options.workspaceScope,
          options.workspaceScopeMode,
          limit,
          actualStatistics,
        );
        const expected = terms.flatMap(term =>
          eligible
            .filter(row => row.terms.includes(term))
            .map(row => ({
              row,
              score: postingLexicalScore(
                {documentLength: row.length, fieldWeight: row.weight, termFrequency: row.frequency},
                term,
                expectedStatistics,
              ),
            }))
            .sort(
              (left, right) =>
                right.score - left.score ||
                right.row.weight - left.row.weight ||
                (left.row.uri < right.row.uri ? -1 : left.row.uri > right.row.uri ? 1 : 0),
            )
            .slice(0, limit)
            .map(({row}) => ({
              term,
              document_id: row.id,
              document_length: row.length,
              field_weight: row.weight,
              term_frequency: row.frequency,
              uri: row.uri,
            })),
        );
        expect(selected).toEqual(expected);
        expect(yield* sql.unsafe('SELECT * FROM documents ORDER BY id')).toEqual(before);
      }).pipe(withDatabase),
    {fastCheck: {numRuns: 75}},
  );
});

function observeQueries(sql: SqlClient.SqlClient) {
  const captured: Array<{text: string; parameters: readonly unknown[]}> = [];
  const observed = new Proxy(sql, {
    get(target, property, receiver) {
      if (property !== 'unsafe') return Reflect.get(target, property, receiver);
      return <A extends object>(text: string, parameters: readonly unknown[] = []) => {
        captured.push({text, parameters});
        return target.unsafe<A>(text, parameters);
      };
    },
  });
  return {captured, observed};
}

function modelStatistics(documents: readonly Document[]): RecallCorpusStatistics {
  const lengths = new Map<string, number>();
  for (const row of documents) lengths.set(row.logicalKey, Math.max(lengths.get(row.logicalKey) ?? 0, row.length));
  const totalDocumentLength = [...lengths.values()].reduce((sum, length) => sum + length, 0);
  const documentFrequency: Record<string, number> = {};
  for (const term of terms) {
    const count = new Set(documents.filter(row => row.terms.includes(term)).map(row => row.logicalKey)).size;
    if (count > 0) documentFrequency[term] = count;
  }
  return {
    documentCount: lengths.size,
    totalDocumentLength,
    averageDocumentLength: lengths.size === 0 ? 1 : totalDocumentLength / lengths.size,
    documentFrequency,
  };
}

const createDocuments = Effect.fn('test.createRecallJoinDocuments')(function* (documents: readonly Document[]) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`CREATE TABLE documents (id INTEGER PRIMARY KEY, uri TEXT NOT NULL,
    logical_key TEXT NOT NULL, document_length INTEGER NOT NULL, project TEXT,
    approved_authoritative INTEGER NOT NULL, workspace_scope TEXT)`);
  yield* sql.unsafe(`CREATE TABLE postings (term TEXT NOT NULL, document_id INTEGER NOT NULL,
    field_weight REAL NOT NULL, term_frequency INTEGER NOT NULL, PRIMARY KEY(term, document_id)) WITHOUT ROWID`);
  yield* sql.unsafe('CREATE INDEX documents_uri ON documents(uri)');
  yield* sql.unsafe('CREATE INDEX documents_workspace_scope_uri ON documents(workspace_scope, uri)');
  yield* sql.unsafe('CREATE INDEX postings_document_id ON postings(document_id)');
  yield* sql.withTransaction(
    Effect.forEach(
      documents,
      row =>
        Effect.gen(function* () {
          yield* sql.unsafe('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)', [
            row.id,
            row.uri,
            row.logicalKey,
            row.length,
            row.project,
            row.approved ? 1 : 0,
            row.workspace,
          ]);
          for (const term of row.terms)
            yield* sql.unsafe('INSERT INTO postings VALUES (?, ?, ?, ?)', [term, row.id, row.weight, row.frequency]);
        }),
      {discard: true},
    ),
  );
  return sql;
});
