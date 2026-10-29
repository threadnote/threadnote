import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import {Predicate, Redacted} from 'effect';
import fc from 'fast-check';
import {createGitHubClient, githubDocumentId} from '../src/client.js';
import {renderGitHubConversation} from '../src/render.js';
import {conversation, json, restItem, timestamp} from './fixtures.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const token = Redacted.make('ghp_synthetic_test_key_only');
describe('GitHub client', () => {
  it('keeps credentials on the fixed origin and follows bounded repository redirects', async () => {
    const calls: URL[] = [];
    const client = createGitHubClient(token, {
      fetch: async url => {
        calls.push(url);
        return calls.length === 1
          ? new Response(null, {status: 301, headers: {location: 'https://api.github.com/repositories/7'}})
          : json({id: 7, full_name: 'owner/renamed', private: true});
      },
    });
    try {
      expect(await client.repository('owner/repo')).toEqual({id: '7', name: 'owner/renamed', private: true});
      expect(EffectArray.map(calls, u => u.origin)).toEqual(['https://api.github.com', 'https://api.github.com']);
    } finally {
      client.close();
    }
    const evil = createGitHubClient(token, {
      fetch: async () => new Response(null, {status: 301, headers: {location: 'https://evil.example/repos/o/r'}}),
    });
    try {
      await expect(evil.repository('owner/repo')).rejects.toMatchObject({code: 'transport-rejected'});
    } finally {
      evil.close();
    }
  });
  it('separates secondary quotas from forbidden and ambiguous404', async () => {
    for (const [response, code] of [
      [json({message: 'You have exceeded a secondary rate limit.'}, 403), 'quota-rejected'],
      [json({message: 'Resource not accessible by personal access token'}, 403), 'access-rejected'],
      [json({}, 404), 'not-found'],
    ] as const) {
      const client = createGitHubClient(token, {fetch: async () => response});
      try {
        await expect(client.repository('owner/repo')).rejects.toMatchObject({code});
      } finally {
        client.close();
      }
    }
  });
  it('rejects partial GraphQL data and missing nested pagination', async () => {
    for (const broken of [
      {data: {repository: {}}, errors: [{type: 'INTERNAL'}]},
      {
        data: {
          repository: {
            databaseId: 7,
            pullRequest: {reviewThreads: {nodes: [], pageInfo: {hasNextPage: true, endCursor: null}, totalCount: 1}},
          },
        },
      },
    ]) {
      const client = createGitHubClient(token, {
        fetch: async url =>
          url.pathname === '/graphql'
            ? json(broken)
            : url.pathname === '/repos/owner/repo'
              ? json({id: 7, full_name: 'owner/repo', private: false})
              : Effect.pipe(url.pathname, EffectString.endsWith('/reviews')) ||
                  Effect.pipe(url.pathname, EffectString.endsWith('/comments'))
                ? json([])
                : Effect.pipe(url.pathname, EffectString.includes('/pulls/'))
                  ? json({number: 1, html_url: 'https://github.com/owner/repo/pull/1', merged: false, draft: false})
                  : json(restItem(1, true)),
      });
      try {
        await expect(
          client.conversation(conversation.repository, {id: '11', number: 1, kind: 'pull'}),
        ).rejects.toMatchObject({code: 'contract-incomplete'});
      } finally {
        client.close();
      }
    }
  });
  it('reads independently paginated thread replies, submitted reviews, and stable double snapshots', async () => {
    const nestedCalls: string[] = [];
    const comment = (index: number) => ({
      id: `c${index}`,
      author: {login: 'alice'},
      body: `Reply ${index}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      url: `https://github.com/owner/repo/pull/1#discussion_r${index}`,
      diffHunk: '@@ line @@',
      pullRequestReview: {state: 'APPROVED'},
    });
    const conn = (nodes: unknown[], more = false) => ({
      nodes,
      totalCount: 101,
      pageInfo: {hasNextPage: more, endCursor: more ? 'next' : null},
    });
    const thread = (nested: unknown) => ({
      id: 'thread1',
      isResolved: true,
      isOutdated: true,
      path: 'file.ts',
      line: 1,
      comments: nested,
    });
    const client = createGitHubClient(token, {
      fetch: async (url, init) => {
        if (url.pathname === '/repos/owner/repo') return json({id: 7, full_name: 'owner/repo', private: false});
        if (url.pathname === '/graphql') {
          if (typeof init.body !== 'string') throw new Error('Expected a serialized GraphQL request');
          const requestBody: unknown = JSON.parse(init.body);
          if (!Predicate.isObject(requestBody) || !Predicate.isObject(requestBody.variables)) {
            throw new Error('Expected GraphQL request variables');
          }
          const requestId = requestBody.variables.id;
          if (requestId !== undefined && typeof requestId !== 'string') {
            throw new Error('Expected an optional string GraphQL node id');
          }
          if (requestId) {
            nestedCalls.push(requestId);
            return json({data: {node: thread(conn([comment(101)]))}});
          }
          return json({
            data: {
              repository: {
                databaseId: 7,
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      thread(
                        conn(
                          Array.from({length: 100}, (_, i) => comment(i + 1)),
                          true,
                        ),
                      ),
                    ],
                    totalCount: 1,
                    pageInfo: {hasNextPage: false, endCursor: null},
                  },
                },
              },
            },
          });
        }
        if (Effect.pipe(url.pathname, EffectString.endsWith('/reviews')))
          return json([
            {id: 2, state: 'PENDING'},
            {
              id: 3,
              state: 'APPROVED',
              submitted_at: timestamp,
              user: {login: 'alice'},
              body: 'Approved',
              html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-3',
            },
          ]);
        if (Effect.pipe(url.pathname, EffectString.endsWith('/comments'))) return json([]);
        if (Effect.pipe(url.pathname, EffectString.includes('/pulls/')))
          return json({number: 1, html_url: 'https://github.com/owner/repo/pull/1', merged: false, draft: false});
        return json(restItem(1, true));
      },
    });
    try {
      const value = await client.stableConversation(conversation.repository, {id: '11', number: 1, kind: 'pull'});
      expect(value.threads[0].comments).toHaveLength(101);
      expect(value.threads[0]).toMatchObject({resolved: true, outdated: true});
      expect(EffectArray.map(value.reviews, r => r.id)).toEqual(['3']);
      expect(nestedCalls).toEqual(['thread1', 'thread1']);
    } finally {
      client.close();
    }
  });
  it('follows pinned numeric pagination and accepts canonical mixed-case changed-item links', async () => {
    const paths: string[] = [];
    const continuation =
      'https://api.github.com/repositories/7/issues?per_page=100&page=2&state=all&sort=created&direction=asc&after=Y3Vyc29yX2FiYw%3D%3D';
    const namedContinuation = Effect.pipe(continuation, EffectString.replace('/repositories/7/', '/repos/owner/Repo/'));
    const client = createGitHubClient(token, {
      fetch: async url => {
        paths.push(url.pathname + url.search);
        if (url.pathname === '/repos/owner/repo') return json({id: 7, full_name: 'owner/Repo', private: false});
        if (Effect.pipe(url.pathname, EffectString.endsWith('/issues/comments')))
          return json([{id: 4, issue_url: 'https://api.github.com/repos/owner/Repo/issues/2'}]);
        if (Effect.pipe(url.pathname, EffectString.endsWith('/pulls/comments')))
          return json([{id: 5, pull_request_url: 'https://api.github.com/repositories/7/pulls/3'}]);
        return url.searchParams.get('page') === '1'
          ? json([restItem(1)], 200, {link: `<${namedContinuation}>; rel="next"`})
          : json([restItem(2)]);
      },
    });
    try {
      await client.repository('owner/repo');
      const first = await client.listIssues('owner/repo', 1);
      expect(first.continuation).toBe(namedContinuation);
      expect(
        EffectArray.map((await client.listIssues('owner/repo', 2, undefined, first.continuation)).items, i => i.number),
      ).toEqual([2]);
      expect(paths.at(-1)).toContain('/repositories/7/issues?');
      expect((await client.listChangedNumbers('owner/repo', 'comments', 1, timestamp)).numbers).toEqual([2]);
      expect((await client.listChangedNumbers('owner/repo', 'review-comments', 1, timestamp)).numbers).toEqual([3]);
      await expect(
        client.listIssues('owner/repo', 2, undefined, Effect.pipe(continuation, EffectString.replace('/7/', '/8/'))),
      ).rejects.toMatchObject({code: 'contract-incomplete'});
    } finally {
      client.close();
    }
  });
  it('keeps the selected repository identity when its name is reused mid-run', async () => {
    const paths: string[] = [];
    let reused = false;
    const client = createGitHubClient(token, {
      fetch: async url => {
        paths.push(url.pathname);
        if (url.pathname === '/repos/owner/repo')
          return json({id: reused ? 8 : 7, full_name: 'owner/repo', private: false});
        if (url.pathname === '/graphql')
          return json({
            data: {
              repository: {
                databaseId: 8,
                pullRequest: {
                  reviewThreads: {nodes: [], totalCount: 0, pageInfo: {hasNextPage: false, endCursor: null}},
                },
              },
            },
          });
        if (url.pathname === '/repositories/7/issues') return json([restItem(1)]);
        if (url.pathname === '/repositories/7/issues/1') return json(restItem(1));
        if (url.pathname === '/repositories/7/issues/2') return json(restItem(2, true));
        if (url.pathname === '/repositories/7/pulls/2')
          return json({number: 2, html_url: 'https://github.com/owner/repo/pull/2', merged: false, draft: false});
        if (
          Effect.pipe(url.pathname, EffectString.endsWith('/comments')) ||
          Effect.pipe(url.pathname, EffectString.endsWith('/reviews'))
        )
          return json([]);
        return json({}, 404);
      },
    });
    try {
      const selected = await client.repository('owner/repo');
      reused = true;
      expect((await client.listIssues(selected.name, 1)).items).toEqual([{id: '11', number: 1, kind: 'issue'}]);
      expect(await client.candidate(selected.name, 1)).toEqual({id: '11', number: 1, kind: 'issue'});
      expect((await client.conversation(selected, {id: '11', number: 1, kind: 'issue'})).id).toBe('11');
      await expect(
        client.conversation({...selected, id: '8'}, {id: '11', number: 1, kind: 'issue'}),
      ).rejects.toMatchObject({code: 'access-rejected'});
      await expect(client.stableConversation(selected, {id: '12', number: 2, kind: 'pull'})).rejects.toMatchObject({
        code: 'access-rejected',
      });
      await expect(client.repository('owner/repo')).rejects.toMatchObject({code: 'access-rejected'});
      expect(
        EffectArray.filter(
          paths,
          __effectArrayValue => !!(path => Effect.pipe(path, EffectString.startsWith('/repos/')))(__effectArrayValue),
        ),
      ).toEqual(['/repos/owner/repo', '/repos/owner/repo']);
      expect(
        EffectArray.filter(
          paths,
          __effectArrayValue =>
            !!(path => Effect.pipe(path, EffectString.startsWith('/repositories/')))(__effectArrayValue),
        ),
      ).toEqual([
        '/repositories/7/issues',
        '/repositories/7/issues/1',
        '/repositories/7/issues/1',
        '/repositories/7/issues/1/comments',
        '/repositories/7/issues/2',
        '/repositories/7/issues/2/comments',
        '/repositories/7/pulls/2',
        '/repositories/7/pulls/2/reviews',
      ]);
    } finally {
      client.close();
    }
  });
  it('uses GraphQL quota headers for provider retry deadlines', async () => {
    const responses: {headers: Record<string, string>; minimum: number}[] = [
      {
        headers: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 3600)},
        minimum: 3_500_000,
      },
      {headers: {'retry-after': '240'}, minimum: 239_000},
    ];
    for (const {headers, minimum} of responses) {
      const client = createGitHubClient(token, {
        fetch: async url => {
          if (url.pathname === '/repos/owner/repo') return json({id: 7, full_name: 'owner/repo', private: false});
          if (url.pathname === '/graphql') return json({errors: [{type: 'RATE_LIMITED'}]}, 200, headers);
          if (
            Effect.pipe(url.pathname, EffectString.endsWith('/comments')) ||
            Effect.pipe(url.pathname, EffectString.endsWith('/reviews'))
          )
            return json([]);
          if (Effect.pipe(url.pathname, EffectString.endsWith('/pulls/1')))
            return json({number: 1, html_url: 'https://github.com/owner/repo/pull/1', merged: false, draft: false});
          return json(restItem(1, true));
        },
      });
      try {
        const error = await client.conversation(conversation.repository, {id: '11', number: 1, kind: 'pull'}).then(
          () => null,
          error => error,
        );
        expect(error).toMatchObject({code: 'quota-rejected'});
        expect(error.retryAfterMilliseconds).toBeGreaterThanOrEqual(minimum);
      } finally {
        client.close();
      }
    }
  });
  it('rejects changing complete snapshots and escaped credential reflections', async () => {
    let read = 0;
    const client = createGitHubClient(token, {
      fetch: async url =>
        url.pathname === '/repos/owner/repo'
          ? json({id: 7, full_name: 'owner/repo', private: false})
          : Effect.pipe(url.pathname, EffectString.endsWith('/comments'))
            ? json([])
            : json({...restItem(1), body: String(++read)}),
    });
    try {
      await expect(
        client.stableConversation(conversation.repository, {id: '11', number: 1, kind: 'issue'}),
      ).rejects.toMatchObject({code: 'snapshot-changed'});
    } finally {
      client.close();
    }
    const escaped = createGitHubClient(token, {
      fetch: async () =>
        new Response(
          Effect.pipe(
            JSON.stringify({id: 7, full_name: 'owner/repo', private: false, note: Redacted.value(token)}),
            EffectString.replaceAll('ghp_', String.raw`\u0067hp_`),
          ),
          {headers: {'content-type': 'application/json'}},
        ),
    });
    try {
      await expect(escaped.repository('owner/repo')).rejects.toMatchObject({code: 'credential-reflected'});
    } finally {
      escaped.close();
    }
  });
  it('preserves numeric identity and bounded evidence without mutating input', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 1_000_000}),
        fc.integer({min: 1, max: 1_000_000}),
        fc.array(fc.constantFrom('a', 'b', '\n', '🙂'), {maxLength: 30000}),
        (repoId, id, chars) => {
          const value = {
            ...conversation,
            id: String(id),
            repository: {...conversation.repository, id: String(repoId)},
            body: EffectArray.join(chars, ''),
          };
          const before = JSON.stringify(value);
          const chunks = renderGitHubConversation(value);
          expect(githubDocumentId(String(repoId), value)).toBe(`r-${repoId}-issue-${id}`);
          expect(JSON.stringify(value)).toBe(before);
          expect(renderGitHubConversation(value)).toEqual(chunks);
          expect(EffectArray.every(chunks, c => Buffer.byteLength(c.body) <= 16 * 1024)).toBe(true);
          const fragments = Effect.pipe(
            EffectArray.join(
              EffectArray.map(chunks, c =>
                Effect.pipe(
                  c.body,
                  EffectString.slice(
                    Effect.pipe(
                      c.body,
                      EffectString.indexOf('\n\n'),
                      Effect.Option.getOrElse(() => -1),
                    ) + 2,
                  ),
                ),
              ),
              '',
            ),
            EffectString.replace(/^Description by alice\n/, ''),
          );
          expect(fragments).toBe(value.body || '(empty)');
        },
      ),
      {numRuns: 50},
    );
  });
  it('blocks secrets even in review context', () => {
    expect(() => renderGitHubConversation({...conversation, body: 'api_token: private-value'})).toThrow();
    expect(() => renderGitHubConversation({...conversation, title: 'ghp_abcdefghijklmnopqrstuvwxyz'})).toThrow();
  });
});
