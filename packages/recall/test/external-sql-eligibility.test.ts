import {Database} from 'bun:sqlite';
import {describe, expect, it} from 'vitest';
import {recallEligibilityPredicate} from '@threadnote/recall/index/eligibility';

describe('external SQL admission', () => {
  it('excludes inactive and mismatched snapshots before a physical candidate limit, even when pinned', () => {
    const sql = new Database(':memory:');
    try {
      sql.exec('CREATE TABLE documents (uri TEXT, project TEXT, approved_authoritative INTEGER, candidate_json TEXT)');
      const activeUri = 'threadnote://resources/external/superhuman/test-docs/docs/doc_1/pages/page_1/line_1.md';
      const wrongHashUri = 'threadnote://resources/external/superhuman/test-docs/docs/doc_1/pages/page_1/line_2.md';
      const ordinaryUri = 'threadnote://resources/z-ordinary.md';
      const insert = sql.query('INSERT INTO documents VALUES (?, NULL, 0, ?)');
      for (let index = 0; index < 12; index++)
        insert.run(
          `threadnote://resources/external/superhuman/denied-${index}/docs/doc_1/pages/page_1/line_1.md`,
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
  });
});
