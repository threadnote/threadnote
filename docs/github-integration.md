# GitHub integration

Connect selected GitHub repositories to recall the requirements, discussion, and review decisions behind a change. Threadnote reads issues, pull request descriptions, conversation comments, submitted reviews, and inline review threads from `github.com`. Each imported conversation retains its source links, authors, timestamps, status, and review context.

## Connect a repository

Open **Integrations** in Manager and choose **GitHub**. Select a local project, or choose projectless, and enter the repositories to import as `owner/repository` names or GitHub repository URLs. Only explicitly selected repositories are imported.

Use a fine-grained personal access token limited to those repositories, with **Issues** and **Pull requests** read permissions and repository metadata access. Organization approval may be required. Manager can store the token in protected local storage; an environment credential binding is available in advanced settings. Platforms where protected ownership cannot be verified must use an environment binding.

The CLI supports the same repository selection. Make the token available to the Threadnote process as `THREADNOTE_GITHUB_TOKEN`; never put it in command arguments or `sources.yaml`.

```bash
threadnote source add --type github --id engineering \
  --repo owner/repository --project engineering \
  --credential-env THREADNOTE_GITHUB_TOKEN --apply
threadnote source sync engineering --apply
threadnote source status engineering
```

Repeat `--repo` for additional repositories. Use `--projectless` instead of `--project` for a source without a project. Without `--apply`, source commands preview their changes.

## Coverage and freshness

Initial sync walks the selected repositories' issue and pull request history, including closed conversations. Request, time, and byte budgets bound each run. Status shows progress while import continues; a completed conversation can become available before the repository's historical import finishes.

Subsequent sync reads incremental issue and comment changes and reconciles previously imported conversations. Reconciliation also detects review and thread changes that may not update the parent issue timestamp. Manager displays the latest sync and reconciliation times separately. Sources default to a 15-minute refresh interval and a maximum cache age of 24 hours; the CLI accepts `--refresh-interval-minutes` and `--max-stale-hours`.

Recall requests background refresh of due sources and searches the eligible local cache immediately. **Sync now**, or `source sync --apply`, allows more work per run. An incomplete or oversized conversation remains visibly pending or needs attention; partially read pages never become a complete imported conversation.

Review threads retain replies, resolution and outdated status, and a bounded diff excerpt. Discussion comments, submitted reviews, and inline comments remain distinct. GitHub Discussions, commit comments, attachments, full repository code, GitHub Enterprise hosts, and private pending reviews are outside this integration's coverage.

## Access and source handling

Imported conversations are untrusted external evidence. Their project and provenance come from local configuration and validated GitHub identities. Conversation text cannot become approved guidance or change source configuration. Credential-like content is quarantined before publication.

Transient failures can retain the last complete cache within its allowed age. Rate-limit deadlines apply to explicit sync as well as automatic refresh. Observed authentication or repository access loss denies the affected cached resources. Paused, removed, reconfigured, expired, and quarantined resources are unavailable to recall and direct reads, including pinned URIs.

Preview removal before purging a connection's imported resources and locally stored credential:

```bash
threadnote source remove engineering
threadnote source remove engineering --apply
```

## Verify API access

`scripts/probe-github-source.ts` performs read-only contract checks without importing content. Set `THREADNOTE_GITHUB_TOKEN` and `GITHUB_PROBE_REPOSITORY`; optionally set `GITHUB_PROBE_NUMBER` to verify one complete conversation with two matching observations.

```bash
GITHUB_PROBE_REPOSITORY=owner/repository bun scripts/probe-github-source.ts
```

The probe prints structural counts and a snapshot hash, without conversation text, authors, or credentials. Its inventory result is explicitly a first-page sample. It does not modify GitHub or verify mutation and revocation behavior.

GitHub documents the [issue and conversation APIs](https://docs.github.com/en/rest/issues), [submitted reviews](https://docs.github.com/en/rest/pulls/reviews), [GraphQL review threads](https://docs.github.com/en/graphql/reference/pulls), and [pagination and rate-limit handling](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
