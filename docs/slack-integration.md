# Slack live recall: private pilot

Slack is the next prioritized recall integration. The intended rollout is a
private internal-app pilot followed by a public integration. The first slice is
a bounded retrieval adapter and a structural diagnostic, available as
`threadnote slack probe`. It is not wired into automatic recall or the persistent
source synchronizer.

## What the pilot verifies

For one foreground task, the adapter binds a user token to an expected workspace
and user through `auth.test`, checks semantic-search eligibility through
`assistant.search.info`, and searches one to three explicitly selected public
project channels with `assistant.search.context`. Each channel gets one search,
using the question when semantic search is available or supplied keywords when
it is not. Relevance sort stays enabled; changing to timestamp sort would change
the retrieval mode, not merely reorder the same matches.

Search results and their context messages remain excerpts. The adapter expands
at most two thread pages across the whole task through `conversations.replies`,
resolves roots from that response, and merges matching hits from the same thread.
Slack timestamps remain strings. The documented search response does not promise
a root timestamp; the adapter never invents one from a reply timestamp.

The diagnostic prints counts, request counts, byte counts, retrieval eligibility,
coverage and static failure codes. It omits message text, names, identifiers,
queries and permalinks. The internal adapter returns separately typed transient,
untrusted evidence for later product composition. There is no Slack content cache,
resource snapshot, embedding, durable memory write or background refresh.

## Run the authenticated contract probe

Use an app built and installed internally for the pilot workspace. RTS is
available to internal and directory-published apps; an unlisted commercially
distributed app is not a supported substitute. For a new internal app, configure
these **user** OAuth scopes and install/reinstall it in that workspace:

- `search:read.public` for capability discovery and public-channel search;
- `channels:history` for the targeted public-thread reads.

Use the consenting pilot user's OAuth access token, not a bot token. No client
secret, write scope, file download, private-channel or DM access is needed for
this slice. Save the token directly to an absolute, owner-only local file through
your credential workflow; never paste it into chat or pass it as a CLI argument.
Set `THREADNOTE_SLACK_TOKEN_FILE` to that file's path. Expired/revoked tokens require
a new credential; this diagnostic does not implement OAuth or refresh rotation.

Create an owner-only task JSON file (`chmod 600`) outside the repository. Replace
the example IDs with the expected workspace, user and selected public channel IDs:

```json
{
  "project": "threadnote",
  "teamId": "T0123456789",
  "userId": "U0123456789",
  "channelIds": ["C0123456789"],
  "question": "Why did we choose live recall?",
  "keywords": "live recall"
}
```

```sh
threadnote slack probe --input /absolute/path/slack-pilot-task.json
```

Both files must be regular, owner-only files; symlinks are rejected. The token
file path is the only credential reference accepted by the CLI. Plain questions
and keywords are accepted; filter operators, controls and recognized credentials
are rejected. The adapter compiles channel filters itself and never widens scope.
Start with a synthetic discussion in one pilot channel so the authenticated
contract can be checked without retaining real conversations as fixtures.
This initial file-credential probe requires POSIX owner IDs; Windows onboarding
needs a protected credential mechanism in a later slice.

## Bounds and interpretation

- Maximum per task: one identity call, one capability call, three searches,
  two thread-read calls, five evidence cards, 512 KiB response bytes and a
  10-second deadline. Each response is capped at 256 KiB. There are no automatic
  retries. A thread-read cursor consumes the same two-call budget.
- Search pages are never exhaustively enumerated. `first-pages-only` means that
  a no-match result cannot prove that a discussion never happened.
- A thread is complete only when the read explicitly reports `has_more: false`,
  has no continuation cursor, includes its root, and contains no truncated or redacted text.
  Missing pagination metadata is partial. Completeness describes the currently
  accessible API response, not deleted history or all workspace activity.
- Returned workspace/channel identities and context identities are checked
  before exposing evidence. Permission/authentication loss or contradictory
  identities aborts the result. A subsequent not-found read drops that hit.
  Slack Connect and private/DM contracts are outside this initial probe.
- Quota and deadline failures stop further work and report partial evidence.
  HTTP 429 reports `retryAfterSeconds` when supplied; do not rerun before that
  delay. No prior-task body cache exists. Run authenticated probes serially:
  the per-task budget is not yet a cross-process rate scheduler.
- Text passes through Threadnote's existing credential scrubber. This is a
  pattern-based boundary, not a guarantee to detect every secret in conversation.

The [RTS method documentation](https://docs.slack.dev/reference/methods/assistant.search.context/)
currently documents 10 requests/minute per user, a workspace limit starting at
10+ requests/minute, unspecified daily limits, and a 5 requests/minute,
100-messages/request allowance for user-token history/reply calls supplementing
RTS. Generic [thread-read limits](https://docs.slack.dev/reference/methods/conversations.replies/)
also vary by app distribution. Authenticated observations, not an assumed higher
tier, must determine the production scheduler.

## Next slices and public gates

1. Authenticate the internal probe and verify actual response identities,
   search quality, reply-root resolution, pagination and rate entitlement.
   Exercise missing scopes, revoked access and deletion with synthetic fixtures.
2. Add PKCE OAuth and atomic, single-flight rotating credentials, shared
   per-user/workspace/method scheduling, cancellation and fair interactive budgets.
   The pilot's direct Web API transport does not establish the official Slack MCP
   server's authenticated tool contract; compare its read-only tools separately.
3. Evaluate roughly 30 realistic recall tasks against native Slack search.
   Record useful-thread placement, cited correctness, partialness, request/byte
   counts, latency and throttling. Keep real Slack text out of persisted fixtures.
4. Compose live evidence beside ordinary memory recall with explicit project
   routing and foreground-task eligibility. Preserve separate authority and
   coverage. Do not force Slack bodies through `source sync` or `ResourceStore`.
5. Add the native **Use thread in Threadnote** message shortcut and private
   project/task selector, with an App Home for user-managed references. A hosted
   HTTP companion handles signed native callbacks and scoped references; desktop
   content reads use the user's local credential. Socket Mode is for internal
   pilots, not the public Marketplace path.

Before public distribution, confirm with Slack the permitted multi-workspace
pilot route, Marketplace suitability of the native workflow, retained reference
metadata and derived decisions, and downstream agent-host/model retention.
Slack's [API terms](https://slack.com/intl/en-gb/terms-of-service/api) and
[Marketplace guidelines](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/)
make persistent Slack archives/indexes and an MCP-only public app unsuitable.
Do not assume that a paraphrase or user approval exempts Slack-derived content
from those contracts. The eventual integration should retrieve live, cite the
discussion and let workspace permissions and retention remain authoritative.

The prototype performs immediate in-process processing without writing Slack
data. It does not claim that arbitrary agent transcripts or model prompts are
ephemeral. That downstream boundary must be settled before exposing message
content through MCP or automatic recall.
