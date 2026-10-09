# Linear sources (Beta)

Connect selected [Linear](https://linear.app/) work to Threadnote recall so a task can bring back its requirements, the discussion behind them, and related project intent. The Manager marks this integration **Beta**. The connector reads Linear; it does not create issues, post comments, change statuses, or assign agents.

## Access and selection

Create a personal API key with only the **Read** permission and restrict it to the teams you intend to use. Linear administrators can restrict who may create API keys. Keep the key local; never paste it into a memory, repository, issue, or command argument. Linear's [API settings documentation](https://linear.app/docs/api-and-webhooks) describes key permissions.

A source maps one Linear workspace and authenticated user to a Threadnote project. Choose allowed teams and explicitly selected projects or issues. A project spanning several teams does not authorize all of its issues: issue content must also belong to an allowed team. Following a parent, duplicate, dependency, or link must not expand the configured selection. Use separate sources for separate workspaces.

## Set up in Manager

Open **Integrations**, select **Linear · Beta**, and give the connection a name. Provide a Read-only API key or an environment-variable binding, enter allowed team UUIDs and selected project or issue UUIDs, and associate them with one Threadnote project. **Verify selection** resolves names and binds the connection to the authenticated organization and user before saving. Short issue identifiers and URLs are not accepted as scope IDs in this beta.

The saved key stays in protected local credential storage outside source YAML and imported resources. Editing leaves the key field blank; the browser never receives the saved value.

Use **Sync now** to refresh the selected work. Pause makes its cached content ineligible for recall and direct reads; resuming requires a fresh sync before it becomes eligible again. Disconnect removes the local source, credential, and imported cache without changing Linear.

## Set up from the CLI

Bind a locally configured `THREADNOTE_LINEAR_API_KEY` without putting its value on the command line. Substitute the UUIDs returned by Linear for the placeholders below:

```sh
threadnote source add --type linear --id linear-work \
  --organization-id ORGANIZATION_UUID --principal-id USER_UUID \
  --team-id TEAM_UUID --linear-project-id PROJECT_UUID \
  --project threadnote --credential-env THREADNOTE_LINEAR_API_KEY
```

This prints a preview. Repeat with `--apply` to save. Use `--issue-id ISSUE_UUID` for explicit issues, or repeat either selection flag to choose several. At least one team and one project or issue are required. A wrong organization or user binding prevents import.

Run `threadnote source sync linear-work` to report the local cache without calling Linear, then add `--apply` to import. `source list`, `source inventory linear-work`, and `source status linear-work` show configuration, local cache eligibility, and progress. `source remove linear-work --apply` disconnects. Freshness defaults are 60 minutes between automatic refresh attempts and a maximum cache age of 24 hours; set `--refresh-interval-minutes` and `--max-stale-hours` when adding a source.

## Coverage

Imported text is untrusted external evidence. It keeps source links and attribution so an agent can distinguish a requirement from a historical proposal or an individual comment. A resolved thread or reaction is not automatically a reviewed Threadnote decision.

Coverage includes issue descriptions and threaded issue comments with resolution metadata, plus selected project overview text, native documents, and authored updates. Every supported collection is paginated independently. Imports resume within a bounded selection; they do not scan an entire workspace.

Sources accept up to 64 teams, 64 selected projects, and 256 explicit issues. Expanded issue selections and individual collections are bounded at 2,000 objects. Resume advances between complete objects. An individual discussion or project that exceeds a refresh budget remains incomplete; selecting fewer issues does not make an oversized project's documents or updates complete. Use an issue-only source when project history is too large.

A budget, failed page, inaccessible object, or unsupported content type is a coverage limitation, never proof that a discussion is complete or an object was deleted. Archived history differs from deleted content. Attachment binaries, screenshots, external linked document bodies, inline comments, and project-update comments are outside this beta. Images and signed file links are omitted from imported text. Issue relations, milestones, labels, and cycles are also excluded. Mirrored update comments remain excluded until provenance and retention rules can be enforced.

## Freshness and failures

Read-only requests go to the fixed official GraphQL endpoint. Linear can return partial data with HTTP 200, or a GraphQL `RATELIMITED` error with HTTP 400. Both request and query-complexity quotas apply. Threadnote bounds calls, response bytes, and time; retries must respect provider quota signals. Linear discourages broad polling, so the local connector uses bounded user-requested or demand-driven background refresh rather than a continuous workspace poller.

Cached content remains subject to source selection, authentication and maximum-age policy. Pause, disconnect, configuration changes, changed credentials, or detected access loss deny both recall and pinned/direct reads. A transient outage cannot make a partially published snapshot readable. Offline caches cannot guarantee immediate detection of remote permission changes.

## Verification status

Public schema introspection verified the existence of issue and comment fields, independently paginated comment replies, project content/documents/updates, and document text fields on 2026-10-08. These checks establish schema shape, not workspace-specific permissions, returned body fidelity, child-update semantics, or snapshot consistency. The user explicitly left authenticated validation pending. Test coverage uses synthetic responses and isolated local homes; no customer workspace material is needed.

OAuth onboarding, hosted webhook invalidation, native agent delegation, and writeback are later work. The official [read-only MCP server](https://linear.app/docs/mcp) remains an alternative for interactive access; the native source uses a separate scoped persistence and access contract.

Sources: [GraphQL](https://linear.app/developers/graphql), [pagination](https://linear.app/developers/pagination), [rate limits](https://linear.app/developers/rate-limiting), [private-team access](https://linear.app/docs/private-teams), and [comments](https://linear.app/docs/comment-on-issues).

## Retained support for derived memories

Use the [retained source evidence flow](source-evidence.md) to accept a private memory with the exact reviewed sanitized fragment and retrieve it after the imported source changes. Current access checks still apply.
