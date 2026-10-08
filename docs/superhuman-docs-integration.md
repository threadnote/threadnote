# Superhuman Docs sources

Threadnote reads explicitly selected Superhuman Docs documents through the [public REST API](https://docs.superhuman.com/developers/apis/v1), using the fixed server in its [OpenAPI specification](https://docs.superhuman.com/apis/v1/openapi.json). Version 1 imports canvas plain-text lines. Tables, comments, attachments, images, embedded pages, and synced pages are outside that coverage. Hidden pages are excluded unless the source explicitly enables them.

## Set up in Manager

Open **Integrations**, then **Add integration** or **Available integrations**, and choose **Superhuman Docs**. Enter a connection name, a Read only API token, and document or page links. **Add links** (or Enter) verifies their API identities and turns them into removable chips with titles and document/page icons: a document link selects the whole document, while a page link selects that page. Choose a project association or explicitly keep the connection projectless, then create the connection. Reopening settings restores the saved selections immediately and loads their current titles and links; if Docs is unavailable, the selected IDs remain visible and editable.

Manager stores the token in a bounded, owner-only local credential file, outside memories, imported resources, and source YAML. It never returns the saved value to the browser. Reopening settings leaves the token field blank; a token-only update retains the selected document and page IDs. Disconnect removes the saved token along with the local connection and cache. Rotation and removal deny the old cache before cleanup.

An advanced **Environment variable** credential choice uses a variable already available to the Threadnote process. This also supports devices where protected local ownership cannot be verified, including the current Windows adapter; local token storage fails closed there rather than writing an unprotected credential.

**Your connections** lists all configured products with their original product marks and relevant actions. Use **Sync now** to import selected Docs content, or settings, pause, enable, and disconnect controls to manage a connection. **Available integrations** is a separate searchable catalog, so adding products does not displace existing connection controls. Refresh interval, maximum cache age, and hidden-page inclusion are in advanced settings. Obsidian keeps its import preview, export, and Inbox review workflows.

## Set up through the CLI

Create a **Read only API** personal access token and set it privately in `SUPERHUMAN_DOCS_API_TOKEN` for the Threadnote process. A token restricted to MCP does not authorize REST access. Source configuration stores the environment variable name, never the credential. Avoid putting the token in shell history, tracked files, or source YAML.

Configure an immutable document-ID allowlist, optionally restricted to page IDs. Choose a local project explicitly or use `--projectless`:

```sh
threadnote source add --type superhuman --id engineering-docs \
  --doc DOCUMENT_ID --page PAGE_ID --project engineering
threadnote source add --type superhuman --id engineering-docs \
  --doc DOCUMENT_ID --page PAGE_ID --project engineering --apply
threadnote source inventory engineering-docs
threadnote source sync engineering-docs --apply
threadnote source status engineering-docs
```

`--doc` can be repeated. `--page` requires exactly one selected document. IDs are case-sensitive and may contain underscores. The browser URL's `_d` marker is a delimiter rather than part of the document ID; slugs are not an authoritative way to recover API IDs. The diagnostic resolver can independently check a known document ID before reading the selected page.

Sources default to a 15-minute refresh interval and a maximum cached age of 24 hours. Change these with `--refresh-interval-minutes` and `--max-stale-hours`. An alternative credential binding uses `--credential-env ENVIRONMENT_VARIABLE`. `--include-hidden` explicitly allows hidden canvas pages.

Recall refreshes due sources with bounded request, time, and byte budgets. A transient provider failure can retain a previously complete cache within its allowed age and persists a jittered retry time. Explicit sync can retry transient failures immediately; provider quota deadlines still apply. Confirmed authentication or access loss quarantines the affected cache immediately, with source-wide denial recorded before cleanup. Disabled, removed, reconfigured, expired, or quarantined resources are denied by direct reads and recall, including pinned URIs. Cursor Cloud memory scopes do not read or refresh these local sources.

Imported content is untrusted external evidence. Its project and provenance come from local configuration and validated API identities; document text cannot supply memory metadata or become approved guidance. Threadnote scans each selected document for credentials, including the active token in original and normalized text, before rendering bounded chunks. Only complete, stable observed page inventories and line continuations can replace a cached document. Pages without revision metadata require two matching complete ordered content observations. Pending publication receipts deny partially written snapshots until resource mutations and index invalidation complete. REST offers no pinned cross-page revision, so this establishes an observed consistency check rather than an atomic provider snapshot.

Preview source removal, then apply it to quarantine and purge the cached resources:

```sh
threadnote source remove engineering-docs
threadnote source remove engineering-docs --apply
```

Existing Obsidian sources and projections remain supported in `sources.yaml`. Adding a Superhuman source upgrades version 1 configuration to version 2 without dropping those settings.

## Read-contract diagnostics

The authenticated REST diagnostic resolves one explicitly selected browser page, enumerates document page metadata, and compares ordered selected-page plain-text lines with page sizes 500 and 1. Set an absolute owner-only token-file path in `SUPERHUMAN_DOCS_TOKEN_FILE`, the page URL in `SUPERHUMAN_DOCS_SELECTED_URL`, and an independent document ID in `SUPERHUMAN_DOCS_SELECTED_DOC_ID`, then run:

```sh
bun scripts/probe-superhuman-rest.ts
```

Output contains structural counts, equality checks, and coverage flags, omitting document identifiers, titles, text, revisions, and credentials. Continuation requests send only the opaque `pageToken`, which carries the original query options. Repeating `limit` can produce HTTP 400. The probe permits at most 16 requests, five seconds per request, thirty seconds total, 256 KiB per response, and 2 MiB aggregate. Redirects must remain on the same origin and preserve the requested resource and query.

Authenticated testing verified a complete three-page inventory and identical ordered content for a selected two-line canvas across full and one-line batches. This validates the plain-text pagination contract only; it does not establish rich-canvas or table fidelity.

The earlier MCP diagnostics remain available as `scripts/probe-superhuman-docs.ts` and `scripts/probe-superhuman-contract.ts`. Catalog discovery uses only initialize, initialized, and paginated tools/list at the fixed official MCP endpoint. It bounds catalog pages, tools, response bytes, and time, and omits provider descriptions. The selected-page diagnostic uses reviewed read tools and always reports the complete Markdown read contract as unverified. MCP resource URI context fragments and redirect locations are transient provider data, never local identities. The production source uses the verified REST contract.
