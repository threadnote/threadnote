import {Redacted} from 'effect';
import {createSlackPilotSession, type SlackPilotOptions} from './client.js';
import {
  assertScope,
  checkedPermalink,
  compareTimestamps,
  cursor,
  fail,
  message,
  parsePilotInput,
  record,
  SlackPilotError,
  timestamp,
  type SlackLiveCard,
  type SlackLiveMessage,
  type SlackErrorCode,
  type SlackPilotInput,
} from './contract.js';

export interface SlackLiveResult {
  readonly provider: 'slack';
  readonly authority: 'external';
  readonly trust: 'untrusted';
  readonly persistence: 'transient';
  readonly retrieval: 'semantic-eligible' | 'keyword';
  readonly searchCoverage: 'first-pages-only';
  readonly cards: readonly SlackLiveCard[];
  readonly notices: readonly SlackErrorCode[];
  readonly retryAfterSeconds?: number;
  readonly requests: Readonly<Record<string, number>>;
  readonly responseBytes: number;
}

function ordered(messages: readonly SlackLiveMessage[]): SlackLiveMessage[] {
  return [...new Map(messages.map(item => [item.ts, item])).values()].sort((a, b) => compareTimestamps(a.ts, b.ts));
}

function searchCards(value: Record<string, unknown>, input: SlackPilotInput, channel: string): SlackLiveCard[] {
  if (!record(value.results) || !Array.isArray(value.results.messages) || value.results.messages.length > 20)
    return fail('contract-invalid');
  cursor(value); // Validate continuation metadata even though this probe deliberately doesn't follow search cursors.
  return value.results.messages.map(hit => {
    if (!record(hit) || hit.team_id !== input.teamId || hit.channel_id !== channel) return fail('scope-mismatch');
    assertScope(hit, input, channel);
    const selected = message(hit.message_ts, hit.author_user_id, hit.content);
    const permalink = checkedPermalink(hit.permalink, channel, selected.ts);
    if (hit.thread_ts !== undefined && !timestamp(hit.thread_ts)) return fail('contract-invalid');
    const context: SlackLiveMessage[] = [];
    if (hit.context_messages !== undefined) {
      if (!record(hit.context_messages)) return fail('contract-invalid');
      for (const side of ['before', 'after']) {
        const entries = hit.context_messages[side];
        if (entries === undefined) continue;
        if (!Array.isArray(entries) || entries.length > 100) return fail('contract-invalid');
        for (const entry of entries) {
          if (!record(entry)) return fail('contract-invalid');
          // Slack's context objects inherit the enclosing channel/team. Reject explicit contradictory identities.
          assertScope(entry, input, channel);
          context.push(message(entry.ts, entry.user_id, entry.text));
        }
      }
    }
    return {
      channelId: channel,
      messageTs: selected.ts,
      ...(hit.thread_ts === undefined ? {} : {rootTs: hit.thread_ts}),
      permalink,
      coverage: 'search-excerpt',
      messages: ordered([...context, selected]),
    };
  });
}

function dedupe(cards: readonly SlackLiveCard[]): SlackLiveCard[] {
  const unique = new Map<string, SlackLiveCard>();
  for (const card of cards) {
    const key = `${card.channelId}/${card.rootTs ?? card.messageTs}`;
    const existing = unique.get(key);
    if (!existing) unique.set(key, card);
    else if (card.coverage === 'complete-thread' || existing.coverage !== 'complete-thread') {
      unique.set(key, {
        ...card,
        messages:
          card.coverage === 'complete-thread' ? card.messages : ordered([...existing.messages, ...card.messages]),
      });
    }
  }
  return [...unique.values()];
}

async function readThread(
  session: ReturnType<typeof createSlackPilotSession>,
  input: SlackPilotInput,
  card: SlackLiveCard,
): Promise<SlackLiveCard> {
  let next: string | undefined;
  const seenCursors = new Set<string>();
  const messages: SlackLiveMessage[] = [];
  let root: string | undefined;
  let complete: boolean;
  do {
    const value = await session.request('conversations.replies', {
      channel: card.channelId,
      ts: card.rootTs ?? card.messageTs,
      limit: 100,
      ...(next === undefined ? {} : {cursor: next}),
    });
    assertScope(value, input, card.channelId);
    if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 100)
      return fail('contract-invalid');
    if (value.has_more !== undefined && typeof value.has_more !== 'boolean') return fail('contract-invalid');
    for (const entry of value.messages) {
      if (!record(entry) || entry.type !== 'message') return fail('contract-invalid');
      assertScope(entry, input, card.channelId);
      const item = message(entry.ts, entry.user ?? entry.bot_id, entry.text);
      if (entry.thread_ts !== undefined && !timestamp(entry.thread_ts)) return fail('contract-invalid');
      if (root === undefined) root = entry.thread_ts ?? item.ts;
      if (entry.thread_ts !== undefined && entry.thread_ts !== root) return fail('scope-mismatch');
      if (card.rootTs !== undefined && root !== card.rootTs) return fail('scope-mismatch');
      messages.push(item);
    }
    next = cursor(value);
    if (next !== undefined && seenCursors.has(next)) return fail('contract-invalid');
    if (next !== undefined) seenCursors.add(next);
    complete = value.has_more === false && next === undefined;
  } while (next !== undefined && session.counts['conversations.replies'] < 2);
  const sorted = ordered(messages);
  // A read is evidence for this hit only when it contains the requested message (or its previously known root).
  if (!sorted.some(item => item.ts === (card.rootTs ?? card.messageTs))) return fail('scope-mismatch');
  const containsRoot = sorted.some(item => item.ts === root);
  return {
    ...card,
    rootTs: root,
    coverage:
      complete && containsRoot && !sorted.some(item => item.textTruncated || item.textRedacted)
        ? 'complete-thread'
        : 'partial-thread',
    messages: sorted,
  };
}

function recoverable(error: unknown): error is SlackPilotError {
  return (
    error instanceof SlackPilotError &&
    [
      'quota-rejected',
      'budget-exhausted',
      'deadline-exceeded',
      'transport-rejected',
      'not-found',
      'response-too-large',
    ].includes(error.code)
  );
}

/** Callable only for one foreground task; callers must drop the result after immediate use. */
export async function retrieveSlackPilot(
  token: Redacted.Redacted<string>,
  selected: SlackPilotInput,
  options: SlackPilotOptions = {},
): Promise<SlackLiveResult> {
  const input = parsePilotInput(selected); // Copy/freeze scope before the first asynchronous boundary.
  const session = createSlackPilotSession(token, options);
  const notices: SlackErrorCode[] = [];
  let retryAfterSeconds: number | undefined;
  const notice = (error: SlackPilotError) => {
    notices.push(error.code);
    if (error.retryAfterSeconds !== undefined)
      retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, error.retryAfterSeconds);
  };
  let cards: SlackLiveCard[] = [];
  try {
    const identity = await session.request('auth.test', {});
    if (identity.team_id !== input.teamId || identity.user_id !== input.userId || identity.bot_id !== undefined)
      return fail('scope-mismatch');
    const info = await session.request('assistant.search.info', {});
    if (typeof info.is_ai_search_enabled !== 'boolean') return fail('contract-invalid');
    const retrieval = info.is_ai_search_enabled ? 'semantic-eligible' : 'keyword';
    try {
      const pages: SlackLiveCard[][] = [];
      for (const channel of input.channelIds) {
        const result = await session.request('assistant.search.context', {
          query: `${info.is_ai_search_enabled ? input.question : input.keywords} in:<#${channel}>`,
          channel_types: ['public_channel'],
          content_types: ['messages'],
          include_context_messages: true,
          include_bots: false,
          include_message_blocks: false,
          sort: 'score',
        });
        pages.push(searchCards(result, input, channel));
        // Round-robin preserves provider relevance within a channel without starving other project channels.
        const roundRobin = Array.from({length: 20}, (_, index) => pages.flatMap(page => page[index] ?? []));
        cards = dedupe(roundRobin.flat()).slice(0, 5);
      }
      const expanded: SlackLiveCard[] = [];
      for (let index = 0; index < cards.length && session.counts['conversations.replies'] < 2; index++) {
        const card = cards[index];
        if (
          expanded.some(item => item.channelId === card.channelId && item.messages.some(m => m.ts === card.messageTs))
        )
          continue;
        try {
          const thread = await readThread(session, input, card);
          expanded.push(thread);
          cards[index] = thread;
        } catch (error) {
          if (!recoverable(error)) throw error;
          notice(error);
          if (error.code === 'not-found') {
            // A deleted/unavailable message must not survive through its preceding search excerpt.
            cards.splice(index, 1);
            index--;
          }
          if (error.code !== 'not-found') break;
        }
      }
      // Once roots are known, merge search hits which occurred inside an already-expanded thread.
      cards = dedupe(
        cards.map(
          card =>
            expanded.find(
              thread => thread.channelId === card.channelId && thread.messages.some(item => item.ts === card.messageTs),
            ) ?? card,
        ),
      );
    } catch (error) {
      if (!recoverable(error)) throw error;
      notice(error);
    }
    return {
      provider: 'slack',
      authority: 'external',
      trust: 'untrusted',
      persistence: 'transient',
      retrieval,
      searchCoverage: 'first-pages-only',
      cards,
      notices: [...new Set(notices)],
      ...(retryAfterSeconds === undefined ? {} : {retryAfterSeconds}),
      requests: session.counts,
      responseBytes: session.responseBytes,
    };
  } finally {
    session.close();
  }
}
