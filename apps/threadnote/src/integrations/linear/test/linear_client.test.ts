import {Redacted} from 'effect';
import {describe, expect, it} from 'vitest';
import {createLinearClient} from '../client.js';
import {comment, connection, issue, request, response, safeFetch, source, time, uuid} from './fixtures.js';
const token = Redacted.make('synthetic-linear-private-key');
const errorResponse = (code: string, status = 200) =>
  new Response(
    JSON.stringify({
      data: {issue},
      errors: [{message: 'Sensitive provider details are never retained', extensions: {code}}],
    }),
    {status, headers: {'content-type': 'application/json'}},
  );
describe('Linear GraphQL read contract', () => {
  it('uses raw API-key authorization at the fixed endpoint and withholds partial GraphQL data', async () => {
    const client = createLinearClient(token, {
      fetch: async (url, init) => {
        expect(url.href).toBe('https://api.linear.app/graphql');
        expect(init.redirect).toBe('manual');
        expect(init.headers).toMatchObject({Authorization: 'synthetic-linear-private-key'});
        return errorResponse('INTERNAL_SERVER_ERROR');
      },
    });
    await expect(client.identity()).rejects.toMatchObject({code: 'contract-incomplete'});
    client.close();
  });
  it.each([
    ['RATELIMITED', 400, 'quota-rejected'],
    ['UNAUTHENTICATED', 200, 'authentication-rejected'],
    ['FORBIDDEN', 200, 'access-rejected'],
    ['GRAPHQL_VALIDATION_FAILED', 400, 'contract-invalid'],
  ])('classifies %s without provider messages', async (code, status, expected) => {
    const client = createLinearClient(token, {fetch: async () => errorResponse(String(code), Number(status))});
    try {
      await expect(client.identity()).rejects.toMatchObject({code: expected});
    } finally {
      client.close();
    }
  });
  it.each([401, 403, 404, 429, 503])('classifies HTTP %i', async status => {
    const client = createLinearClient(token, {fetch: async () => response({}, status)});
    await expect(client.identity()).rejects.toMatchObject({
      code: (
        {
          401: 'authentication-rejected',
          403: 'access-rejected',
          404: 'not-found',
          429: 'quota-rejected',
          503: 'transport-rejected',
        } as Record<number, string>
      )[status],
    });
    client.close();
  });
  it.each([200, 400, 429])('preserves the provider cooldown for quota rejection at HTTP %i', async status => {
    const client = createLinearClient(token, {
      fetch: async () =>
        new Response(JSON.stringify({errors: [{extensions: {code: 'RATELIMITED'}}]}), {
          status,
          headers: {'content-type': 'application/json', 'retry-after': '3600'},
        }),
    });
    try {
      await expect(client.identity()).rejects.toMatchObject({
        code: 'quota-rejected',
        retryAfterMilliseconds: 3600000,
      });
    } finally {
      client.close();
    }
  });
  it.each([
    ['invalid', 60000],
    ['-2', 60000],
    ['8640000', 86400000],
  ])('bounds quota cooldown header %s', async (header, milliseconds) => {
    const client = createLinearClient(token, {
      fetch: async () =>
        new Response(JSON.stringify({errors: [{extensions: {code: 'RATELIMITED'}}]}), {
          status: 400,
          headers: {'content-type': 'application/json', 'retry-after': header},
        }),
    });
    try {
      await expect(client.identity()).rejects.toMatchObject({
        code: 'quota-rejected',
        retryAfterMilliseconds: milliseconds,
      });
    } finally {
      client.close();
    }
  });
  it('rejects credential reflection including JSON escaped material', async () => {
    const raw =
      '{"data":{"organization":{"id":"synthetic-linear-private-key"},"viewer":{"id":"00000000-0000-0000-0000-000000000002"}}}';
    for (const payload of [raw, raw.replace('synthetic', '\\u0073ynthetic')]) {
      const client = createLinearClient(token, {
        fetch: async () => new Response(payload, {headers: {'content-type': 'application/json'}}),
      });
      await expect(client.identity()).rejects.toMatchObject({code: 'credential-reflected'});
      client.close();
    }
  });
  it('collects more than 50 comments and independently paginates threaded replies, preserving resolution metadata', async () => {
    const roots = Array.from({length: 51}, (_, i) => comment(100 + i));
    roots[0] = {...roots[0], children: connection([{id: uuid(300)}])};
    const children = Array.from({length: 51}, (_, i) => comment(300 + i, roots[0].id));
    children[50] = {...children[50], editedAt: time};
    roots[0] = {...roots[0], resolvedAt: time, resolvingCommentId: children[50].id};
    let rootCalls = 0,
      replyCalls = 0;
    const client = createLinearClient(token, {
      fetch: async (url, init) => {
        const req = request(init);
        if (req.query.includes('LinearComments')) {
          rootCalls++;
          return response({
            issue: {
              id: issue.id,
              comments: req.variables.after
                ? connection(roots.slice(50))
                : connection(roots.slice(0, 50), true, 'root-page-2'),
            },
          });
        }
        if (req.query.includes('LinearReplies')) {
          replyCalls++;
          return response({
            comment: {
              id: roots[0].id,
              children: req.variables.after
                ? connection(children.slice(50))
                : connection(children.slice(0, 50), true, 'child-page-2'),
            },
          });
        }
        return safeFetch(url, init);
      },
    });
    const result = await client.issueSnapshot(source, issue.id);
    expect(result.comments).toHaveLength(102);
    expect(result.comments.find(c => c.id === roots[0].id)?.resolvingCommentId).toBe(children[50].id);
    expect(rootCalls).toBe(4);
    expect(replyCalls).toBe(4);
    client.close();
  });
  it.each(['duplicate', 'cycle', 'missing-parent', 'missing-field'])('rejects %s comment connection', async kind => {
    const client = createLinearClient(token, {
      fetch: async (url, init) => {
        const req = request(init);
        if (req.query.includes('LinearComments')) {
          let rows: unknown[] = [comment(10)];
          if (kind === 'duplicate') rows = [comment(10), comment(10)];
          if (kind === 'missing-parent') rows = [comment(10, uuid(999))];
          if (kind === 'missing-field') rows = [{...comment(10), body: undefined}];
          return response({
            issue: {
              id: issue.id,
              comments:
                kind === 'cycle'
                  ? connection(req.variables.after ? [comment(11)] : rows, true, 'cycle')
                  : connection(rows),
            },
          });
        }
        return safeFetch(url, init);
      },
    });
    await expect(client.issueSnapshot(source, issue.id)).rejects.toMatchObject({
      code: kind === 'missing-field' ? 'contract-invalid' : 'contract-incomplete',
    });
    client.close();
  });
  it('rejects issues moved outside selected teams and revision changes during hydration', async () => {
    for (const moved of [true, false]) {
      let reads = 0;
      const client = createLinearClient(token, {
        fetch: async (url, init) => {
          const req = request(init);
          if (req.query.includes('LinearIssue(')) {
            reads++;
            return response({
              issue: {
                ...issue,
                ...(moved
                  ? {team: {id: uuid(999), name: 'Other'}}
                  : reads > 1
                    ? {description: 'Changed requirements'}
                    : {}),
              },
            });
          }
          return safeFetch(url, init);
        },
      });
      await expect(client.issueSnapshot(source, issue.id)).rejects.toMatchObject({
        code: moved ? 'scope-rejected' : 'revision-changed',
      });
      client.close();
    }
  });
  it('excludes inline discussions explicitly and never mixes orphaned inline replies into issue discussion', async () => {
    const client = createLinearClient(token, {
      fetch: async (url, init) =>
        request(init).query.includes('LinearComments')
          ? response({issue: {id: issue.id, comments: connection([{...comment(10), documentContentId: uuid(900)}])}})
          : safeFetch(url, init),
    });
    expect((await client.issueSnapshot(source, issue.id)).comments).toEqual([]);
    client.close();
  });
  it('stops under request and byte budgets without returning a partial issue', async () => {
    const client = createLinearClient(token, {maxRequests: 1, fetch: safeFetch});
    await expect(client.issueSnapshot(source, issue.id)).rejects.toMatchObject({code: 'deadline-exceeded'});
    client.close();
    const large = createLinearClient(token, {
      fetch: async () => new Response('x'.repeat(1024 * 1024 + 1), {headers: {'content-type': 'application/json'}}),
    });
    await expect(large.identity()).rejects.toMatchObject({code: 'response-too-large'});
    large.close();
  });
});
