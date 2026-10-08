import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {Redacted} from 'effect';
import {createSlackPilotSession} from '../client.js';
import {compareTimestamps, parsePilotInput, SlackPilotError} from '../contract.js';
import {retrieveSlackPilot} from '../live.js';
import {probeSlackPilot} from '../probe.js';

const token = Redacted.make('xoxp-synthetic-private-credential');
const input = parsePilotInput({
  project: 'threadnote',
  teamId: 'T000001',
  userId: 'U000001',
  channelIds: ['C000001'],
  question: 'Why did we choose live recall?',
  keywords: 'live recall',
});
const firstTs = '1791480000.000001';
const replyTs = '1791480000.000002';
const permalink = (channel: string, ts: string) =>
  `https://example.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
const hit = (channel = 'C000001', ts = firstTs) => ({
  team_id: input.teamId,
  channel_id: channel,
  message_ts: ts,
  author_user_id: 'U000002',
  content: 'synthetic private discussion',
  permalink: permalink(channel, ts),
});
const thread = (ts = firstTs) => ({
  ok: true,
  has_more: false,
  messages: [{type: 'message', user: 'U000002', ts, text: 'synthetic private discussion'}],
});

function harness(
  overrides: {
    semantic?: boolean;
    search?: (args: Record<string, unknown>) => unknown;
    replies?: (args: Record<string, unknown>, count: number) => unknown;
    identity?: unknown;
  } = {},
) {
  const calls: {method: string; args: Record<string, unknown>}[] = [];
  const fetchImpl = async (url: URL, init: RequestInit): Promise<Response> => {
    expect(url.origin).toBe('https://slack.com');
    expect(url.search).toBe('');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${Redacted.value(token)}`);
    const method = url.pathname.slice('/api/'.length);
    const args = JSON.parse(String(init.body));
    calls.push({method, args});
    if (method === 'auth.test')
      return Response.json(overrides.identity ?? {ok: true, team_id: input.teamId, user_id: input.userId});
    if (method === 'assistant.search.info')
      return Response.json({ok: true, is_ai_search_enabled: overrides.semantic ?? true});
    if (method === 'assistant.search.context')
      return Response.json(overrides.search?.(args) ?? {ok: true, results: {messages: [hit()]}});
    if (method === 'conversations.replies')
      return Response.json(overrides.replies?.(args, calls.filter(c => c.method === method).length) ?? thread());
    throw new Error('unexpected route');
  };
  return {calls, fetch: fetchImpl};
}

describe('Slack interactive live pilot (Promise/HTTP boundary)', () => {
  it('binds the account, compiles a public channel filter and emits safe structural probe evidence', async () => {
    const api = harness();
    const summary = await probeSlackPilot(token, input, {fetch: api.fetch});
    expect(summary.evidence).toMatchObject({cards: 1, completeThreads: 1, unresolvedRoots: 0});
    const search = api.calls.find(c => c.method === 'assistant.search.context')!.args;
    expect(search).toMatchObject({
      query: `${input.question} in:<#C000001>`,
      channel_types: ['public_channel'],
      content_types: ['messages'],
      sort: 'score',
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /synthetic private|C000001|T000001|U000001|live recall|example\.slack|xoxp-/,
    );
    expect(api.calls.map(c => c.method)).toEqual([
      'auth.test',
      'assistant.search.info',
      'assistant.search.context',
      'conversations.replies',
    ]);
  });

  it('uses keywords and relevance sort when semantic search is unavailable', async () => {
    const api = harness({semantic: false});
    const result = await retrieveSlackPilot(token, input, {fetch: api.fetch});
    expect(result.retrieval).toBe('keyword');
    expect(api.calls[2].args.query).toBe('live recall in:<#C000001>');
    expect(api.calls[2].args.sort).toBe('score');
  });

  it.each([
    {team_id: 'TOTHER1'},
    {channel_id: 'COTHER1'},
    {context_messages: {before: [{team_id: 'TOTHER1', ts: replyTs, user_id: 'U000002', text: 'out of scope'}]}},
    {context_messages: {after: [{channel_id: 'COTHER1', ts: replyTs, user_id: 'U000002', text: 'out of scope'}]}},
    {permalink: `https://evil.example/archives/C000001/p${firstTs.replace('.', '')}`},
  ])('rejects contradictory result/context identities or links before exposing evidence (%j)', async extra => {
    const api = harness({search: () => ({ok: true, results: {messages: [{...hit(), ...extra}]}})});
    await expect(retrieveSlackPilot(token, input, {fetch: api.fetch})).rejects.toBeInstanceOf(SlackPilotError);
    expect(api.calls).toHaveLength(3);
  });

  it.each([
    {team_id: 'TOTHER1', user_id: input.userId},
    {team_id: input.teamId, user_id: 'UOTHER1'},
    {team_id: input.teamId, user_id: input.userId, bot_id: 'B000001'},
  ])('rejects the wrong account or bot identity before search', async identity => {
    const api = harness({identity: {ok: true, ...identity}});
    await expect(retrieveSlackPilot(token, input, {fetch: api.fetch})).rejects.toMatchObject({code: 'scope-mismatch'});
    expect(api.calls).toHaveLength(1);
  });

  it('copies channel scope before await so caller mutation cannot widen it', async () => {
    const selected = {...input, channelIds: ['C000001']};
    const api = harness();
    const pending = retrieveSlackPilot(token, selected, {fetch: api.fetch});
    selected.channelIds.push('COTHER1');
    const result = await pending;
    expect(result.cards.every(card => card.channelId === 'C000001')).toBe(true);
    expect(api.calls.filter(c => c.method === 'assistant.search.context')).toHaveLength(1);
  });

  it('drops a search excerpt when a subsequent read reports the message unavailable', async () => {
    const api = harness({replies: () => ({ok: false, error: 'thread_not_found'})});
    const result = await retrieveSlackPilot(token, input, {fetch: api.fetch});
    expect(result.cards).toHaveLength(0);
    expect(result.notices).toEqual(['not-found']);
  });

  it('drops the entire result on permission loss, even after receiving search content', async () => {
    const api = harness({replies: () => ({ok: false, error: 'token_revoked', detail: 'provider secret text'})});
    await expect(retrieveSlackPilot(token, input, {fetch: api.fetch})).rejects.toMatchObject({
      code: 'authentication-rejected',
    });
  });

  it('resolves a reply hit to its root, deduplicates that thread and preserves microseconds', async () => {
    const api = harness({
      search: () => ({ok: true, results: {messages: [hit('C000001', replyTs), hit()]}}),
      replies: () => ({
        ok: true,
        has_more: false,
        messages: [
          {type: 'message', user: 'U000002', ts: firstTs, thread_ts: firstTs, text: 'proposal'},
          {type: 'message', user: 'U000002', ts: replyTs, thread_ts: firstTs, text: 'correction'},
        ],
      }),
    });
    const result = await retrieveSlackPilot(token, input, {fetch: api.fetch});
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].rootTs).toBe(firstTs);
    expect(result.cards[0].messages.map(m => m.ts)).toEqual([firstTs, replyTs]);
    expect(result.requests['conversations.replies']).toBe(1);
  });

  it('limits pagination to two thread reads and clearly reports an unfinished thread', async () => {
    const api = harness({
      replies: (_, count) => ({
        ok: true,
        has_more: true,
        response_metadata: {next_cursor: `page-${count}`},
        messages: [
          {type: 'message', user: 'U000002', ts: count === 1 ? firstTs : replyTs, thread_ts: firstTs, text: 'partial'},
        ],
      }),
    });
    const result = await retrieveSlackPilot(token, input, {fetch: api.fetch});
    expect(result.cards[0].coverage).toBe('partial-thread');
    expect(result.cards[0].messages).toHaveLength(2);
    expect(result.requests['conversations.replies']).toBe(2);
    expect(api.calls[4].args).toMatchObject({cursor: 'page-1', ts: firstTs, channel: 'C000001'});
  });

  it('requires explicit pagination completion and treats truncated content as partial', async () => {
    const missing = harness({replies: () => ({ok: true, messages: thread().messages})});
    expect((await retrieveSlackPilot(token, input, {fetch: missing.fetch})).cards[0].coverage).toBe('partial-thread');
    const long = harness({
      replies: () => ({...thread(), messages: [{...thread().messages[0], text: 'a'.repeat(9_000)}]}),
    });
    const card = (await retrieveSlackPilot(token, input, {fetch: long.fetch})).cards[0];
    expect(card.coverage).toBe('partial-thread');
    expect(card.messages[0].textTruncated).toBe(true);
  });

  it('rejects a read from a different thread rather than merging unrelated evidence', async () => {
    const api = harness({replies: () => thread('1791480001.000001')});
    await expect(retrieveSlackPilot(token, input, {fetch: api.fetch})).rejects.toMatchObject({code: 'scope-mismatch'});
  });

  it('stops on 429 without retrying or serving cached content', async () => {
    const api = harness();
    let requests = 0;
    const result = await retrieveSlackPilot(token, input, {
      fetch: async (url, init) => {
        requests++;
        return url.pathname.endsWith('conversations.replies')
          ? new Response('private throttle body', {status: 429, headers: {'retry-after': '60'}})
          : api.fetch(url, init);
      },
    });
    expect(requests).toBe(4);
    expect(result.cards[0].coverage).toBe('search-excerpt');
    expect(result.notices).toEqual(['quota-rejected']);
    expect(result.retryAfterSeconds).toBe(60);
  });

  it('cancels a hanging response body within the whole-task deadline', async () => {
    let cancelled = false;
    const session = createSlackPilotSession(token, {
      totalTimeoutMs: 20,
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    try {
      await expect(session.request('auth.test', {})).rejects.toMatchObject({code: 'deadline-exceeded'});
      expect(cancelled).toBe(true);
    } finally {
      session.close();
    }
  });

  it.each(['redirect', 'too-large', 'credential-reflected', 'network'])(
    'keeps transport failures bounded and credential-safe (%s)',
    async mode => {
      const session = createSlackPilotSession(token, {
        fetch: async () => {
          if (mode === 'redirect')
            return new Response(null, {status: 302, headers: {location: 'https://evil.example'}});
          if (mode === 'too-large') return new Response('private', {headers: {'content-length': String(300 * 1024)}});
          if (mode === 'credential-reflected') return Response.json({ok: true, text: Redacted.value(token)});
          throw new Error(`secret ${Redacted.value(token)}`);
        },
      });
      try {
        await expect(session.request('auth.test', {})).rejects.toBeInstanceOf(SlackPilotError);
      } finally {
        session.close();
      }
    },
  );

  it('scrubs credentials found in message text before returning live evidence', async () => {
    const api = harness({
      replies: () => ({
        ...thread(),
        messages: [{...thread().messages[0], text: 'ghp_syntheticPrivateCredential123456789'}],
      }),
    });
    const result = await retrieveSlackPilot(token, input, {fetch: api.fetch});
    expect(JSON.stringify(result)).not.toContain('ghp_syntheticPrivateCredential123456789');
  });
});

describe('Slack pilot invariants', () => {
  it('never widens channel scope or exceeds call budgets under arbitrary duplicate results', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({min: 1, max: 3}),
        fc.array(fc.integer({min: 0, max: 19}), {maxLength: 20}),
        fc.boolean(),
        async (count, hits, outOfScope) => {
          const channels = Array.from({length: count}, (_, i) => `C00000${i + 1}`);
          const api = harness({
            search: args => {
              const channel = channels.find(c => String(args.query).endsWith(`in:<#${c}>`))!;
              return {
                ok: true,
                results: {
                  messages: outOfScope
                    ? [hit('COTHER1')]
                    : hits.map(n => hit(channel, `1791480000.${String(n).padStart(6, '0')}`)),
                },
              };
            },
            replies: args => thread(String(args.ts)),
          });
          const pending = retrieveSlackPilot(token, {...input, channelIds: channels}, {fetch: api.fetch});
          if (outOfScope) {
            await expect(pending).rejects.toMatchObject({code: 'scope-mismatch'});
            expect(api.calls).toHaveLength(3);
            return;
          }
          const result = await pending;
          expect(result.requests['assistant.search.context']).toBe(count);
          expect(result.requests['conversations.replies']).toBeLessThanOrEqual(2);
          expect(result.cards.length).toBeLessThanOrEqual(5);
          expect(result.cards.every(card => channels.includes(card.channelId))).toBe(true);
          expect(new Set(result.cards.map(card => `${card.channelId}/${card.rootTs ?? card.messageTs}`)).size).toBe(
            result.cards.length,
          );
        },
      ),
      {numRuns: 35},
    );
  });

  it('orders timestamp strings according to an independent integer microsecond model', () => {
    const ts = fc.tuple(fc.integer({min: 0, max: 2_000_000_000}), fc.integer({min: 0, max: 999_999}));
    fc.assert(
      fc.property(ts, ts, ([a, am], [b, bm]) => {
        const modelA = BigInt(a) * 1_000_000n + BigInt(am);
        const modelB = BigInt(b) * 1_000_000n + BigInt(bm);
        const expected = modelA < modelB ? -1 : modelA > modelB ? 1 : 0;
        expect(compareTimestamps(`${a}.${String(am).padStart(6, '0')}`, `${b}.${String(bm).padStart(6, '0')}`)).toBe(
          expected,
        );
      }),
      {numRuns: 100},
    );
    expect(compareTimestamps('1.1', '1.100001')).toBe(-1);
  });

  it.each(['in:COTHER1', 'foo OR bar', 'secret\ntext', '(query)', 'query:filter'])(
    'rejects caller-supplied search syntax (%s)',
    question => {
      expect(() => parsePilotInput({...input, question})).toThrow(SlackPilotError);
    },
  );

  it('enforces session budgets even if a caller attempts repeated requests', async () => {
    const session = createSlackPilotSession(token, {fetch: async () => Response.json({ok: true})});
    try {
      for (let n = 0; n < 3; n++) await session.request('assistant.search.context', {});
      await expect(session.request('assistant.search.context', {})).rejects.toMatchObject({code: 'budget-exhausted'});
      expect(session.counts['assistant.search.context']).toBe(3);
    } finally {
      session.close();
    }
  });
});
