import {Database} from 'bun:sqlite';
import * as FC from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {RecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {recallEligibilityPredicate} from '@threadnote/recall/index/eligibility';

const providers = ['superhuman', 'pocket', 'github', 'linear'] as const;

describe('external SQL admission', () => {
  it.each(providers)(
    'excludes inactive and mismatched %s snapshots before a physical candidate limit, even when pinned',
    provider => {
      const sql = new Database(':memory:');
      try {
        sql.exec(
          'CREATE TABLE documents (uri TEXT, project TEXT, approved_authoritative INTEGER, candidate_json TEXT)',
        );
        const activeUri = `threadnote://resources/external/${provider}/test-docs/docs/doc_1/pages/page_1/line_1.md`;
        const wrongHashUri = `threadnote://resources/external/${provider}/test-docs/docs/doc_1/pages/page_1/line_2.md`;
        const ordinaryUri = 'threadnote://resources/z-ordinary.md';
        const insert = sql.query('INSERT INTO documents VALUES (?, NULL, 0, ?)');
        for (let index = 0; index < 12; index++)
          insert.run(
            `threadnote://resources/external/${provider}/denied-${index}/docs/doc_1/pages/page_1/line_1.md`,
            JSON.stringify({contentHash: 'a'.repeat(64)}),
          );
        insert.run(wrongHashUri, JSON.stringify({contentHash: 'b'.repeat(64)}));
        insert.run(activeUri, JSON.stringify({contentHash: 'a'.repeat(64)}));
        insert.run(ordinaryUri, '{}');
        const active = recallEligibilityPredicate('d', {
          kind: 'pinned-hard-uri-bypass',
          externalResources: {[activeUri]: 'a'.repeat(64), [wrongHashUri]: 'a'.repeat(64)},
        });
        expect(
          sql.query(`SELECT uri FROM documents AS d WHERE ${active.sql} ORDER BY uri LIMIT 1`).all(...active.params),
        ).toEqual([{uri: activeUri}]);
        const denied = recallEligibilityPredicate('d', {kind: 'pinned-hard-uri-bypass'});
        expect(
          sql.query(`SELECT uri FROM documents AS d WHERE ${denied.sql} ORDER BY uri LIMIT 1`).all(...denied.params),
        ).toEqual([{uri: ordinaryUri}]);
        sql.query('INSERT INTO documents VALUES (?, ?, 0, ?)').run('threadnote://resources/projected.md', 'demo', '{}');
        const projectless = recallEligibilityPredicate('d', {
          kind: 'candidate-policy',
          authority: 'any',
          projects: {mode: 'projectless-only'},
          externalResources: {[activeUri]: 'a'.repeat(64)},
        });
        expect(
          sql.query(`SELECT uri FROM documents AS d WHERE ${projectless.sql} ORDER BY uri`).all(...projectless.params),
        ).toEqual([{uri: activeUri}, {uri: ordinaryUri}]);
      } finally {
        sql.close();
      }
    },
  );

  it.each(providers)('denies the exact %s root and descendants without excluding neighboring roots', provider => {
    const sql = new Database(':memory:');
    try {
      sql.exec('CREATE TABLE documents (uri TEXT, candidate_json TEXT)');
      const root = `threadnote://resources/external/${provider}`;
      const insert = sql.query('INSERT INTO documents VALUES (?, ?)');
      for (const uri of [root, `${root}/`, `${root}/snapshot.md`, `${root}-other/file.md`, `${root}0/file.md`]) {
        insert.run(uri, '{}');
      }
      for (const policy of [undefined, {kind: 'pinned-hard-uri-bypass'} as const]) {
        const predicate = recallEligibilityPredicate('d', policy);
        expect(
          sql.query(`SELECT uri FROM documents AS d WHERE ${predicate.sql} ORDER BY uri`).all(...predicate.params),
        ).toEqual([{uri: `${root}-other/file.md`}, {uri: `${root}0/file.md`}]);
      }
    } finally {
      sql.close();
    }
  });

  it('matches independent access, metadata and limit rules across providers', () => {
    const row = FC.record({
      provider: FC.constantFrom(...providers),
      location: FC.constantFrom('root', 'child', 'neighbor', 'ordinary'),
      neighbor: FC.constantFrom('-other', '0', 'ish'),
      contentHash: FC.constantFrom(null, 'a'.repeat(64), 'b'.repeat(64)),
      accessHash: FC.constantFrom(null, 'a'.repeat(64), 'b'.repeat(64)),
      project: FC.constantFrom(null, 'demo', 'other'),
      approved: FC.boolean(),
    });
    FC.assert(
      FC.property(FC.array(row, {minLength: 1, maxLength: 12}), FC.integer({min: 1, max: 8}), (inputs, limit) => {
        const sql = new Database(':memory:');
        try {
          sql.exec(
            'CREATE TABLE documents (id INTEGER, uri TEXT, project TEXT, approved_authoritative INTEGER, candidate_json TEXT)',
          );
          const rows = inputs.map((input, id) => {
            const root = `threadnote://resources/external/${input.provider}`;
            const uri =
              input.location === 'root'
                ? root
                : input.location === 'child'
                  ? `${root}/generated-${id}.md`
                  : input.location === 'neighbor'
                    ? `${root}${input.neighbor}/generated-${id}.md`
                    : `threadnote://resources/ordinary-${id}.md`;
            return {...input, id, uri};
          });
          const access = Object.fromEntries(
            rows.flatMap(row => (row.accessHash === null ? [] : [[row.uri, row.accessHash]])),
          );
          const insert = sql.query('INSERT INTO documents VALUES (?, ?, ?, ?, ?)');
          for (const row of rows) {
            insert.run(
              row.id,
              row.uri,
              row.project,
              Number(row.approved),
              JSON.stringify({contentHash: row.contentHash}),
            );
          }
          const policies: readonly (RecallEligibilityPolicy | undefined)[] = [
            undefined,
            {kind: 'pinned-hard-uri-bypass', externalResources: access},
            ...(['unrestricted', 'projectless-only', 'allow-projects-and-projectless', 'deny-all'] as const).flatMap(
              mode =>
                (['any', 'approved-authoritative'] as const).map(authority => ({
                  kind: 'candidate-policy' as const,
                  authority,
                  projects: mode === 'allow-projects-and-projectless' ? {mode, projects: ['demo']} : {mode},
                  externalResources: access,
                })),
            ),
          ];
          for (const policy of policies) {
            for (const checkHash of [true, false]) {
              const predicate = recallEligibilityPredicate('d', policy, checkHash ? undefined : false);
              const expected = rows
                .filter(row => {
                  const external = providers.some(provider => {
                    const root = `threadnote://resources/external/${provider}`;
                    return row.uri === root || row.uri.startsWith(`${root}/`);
                  });
                  if (
                    external &&
                    (policy?.externalResources?.[row.uri] === undefined ||
                      (checkHash && policy.externalResources[row.uri] !== row.contentHash))
                  )
                    return false;
                  if (policy?.kind !== 'candidate-policy') return true;
                  if (policy.projects.mode === 'deny-all') return false;
                  if (policy.projects.mode === 'projectless-only' && row.project !== null) return false;
                  if (
                    policy.projects.mode === 'allow-projects-and-projectless' &&
                    row.project !== null &&
                    row.project !== 'demo'
                  )
                    return false;
                  return policy.authority === 'any' || row.approved;
                })
                .slice(0, limit)
                .map(row => ({id: row.id}));
              expect(
                sql
                  .query(`SELECT id FROM documents AS d WHERE ${predicate.sql} ORDER BY id LIMIT ?`)
                  .all(...predicate.params, limit),
              ).toEqual(expected);
            }
          }
        } finally {
          sql.close();
        }
      }),
      {numRuns: 40},
    );
  });
});
