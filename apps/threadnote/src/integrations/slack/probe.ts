import {Redacted} from 'effect';
import type {SlackPilotOptions} from './client.js';
import type {SlackPilotInput} from './contract.js';
import {retrieveSlackPilot} from './live.js';

/** The diagnostic intentionally omits all Slack content, identifiers, queries, names and links. */
export async function probeSlackPilot(
  token: Redacted.Redacted<string>,
  input: SlackPilotInput,
  options: SlackPilotOptions = {},
) {
  const result = await retrieveSlackPilot(token, input, options);
  return {
    endpoint: 'https://slack.com/api/assistant.search.context',
    retrieval: result.retrieval,
    searchCoverage: result.searchCoverage,
    requests: result.requests,
    responseBytes: result.responseBytes,
    notices: result.notices,
    ...(result.retryAfterSeconds === undefined ? {} : {retryAfterSeconds: result.retryAfterSeconds}),
    evidence: {
      cards: result.cards.length,
      messages: result.cards.reduce((sum, card) => sum + card.messages.length, 0),
      completeThreads: result.cards.filter(card => card.coverage === 'complete-thread').length,
      partialThreads: result.cards.filter(card => card.coverage === 'partial-thread').length,
      searchExcerpts: result.cards.filter(card => card.coverage === 'search-excerpt').length,
      unresolvedRoots: result.cards.filter(card => card.rootTs === undefined).length,
      truncatedMessages: result.cards.reduce(
        (sum, card) => sum + card.messages.filter(item => item.textTruncated).length,
        0,
      ),
      redactedMessages: result.cards.reduce(
        (sum, card) => sum + card.messages.filter(item => item.textRedacted).length,
        0,
      ),
    },
  };
}
