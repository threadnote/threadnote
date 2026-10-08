# Pocket sources

Connect [Pocket](https://heypocket.com/) to make its recordings, summaries, transcripts, and related text available to Threadnote recall. A connection covers every recording accessible to its API key. There is no item picker: later syncs discover new recordings and refresh existing ones, including summaries that finished processing since the previous sync.

## Set up in Manager

Open **Integrations**, choose **Pocket**, and enter a connection name and a Pocket API key. Associate the connection with a project or explicitly keep it projectless, then save. Saving starts the initial sync. Use **Sync now** to refresh again; large accounts can require further syncs as bounded work continues.

Manager keeps the key in protected local credential storage outside source YAML, memories, and imported resources. It never sends the saved value back to the browser. Leave the key blank when editing to preserve the current credential. Advanced setup can instead reference an environment variable available to the Threadnote process. Use that mode on systems where protected local storage is unavailable.

Pause makes cached Pocket content ineligible for recall and direct reads. Disconnect removes the local connection, credential, and imported cache. Neither action changes data in Pocket.

## Set up through the CLI

Create an API key in Pocket and make it available privately to the Threadnote process as `POCKET_API_KEY`. Threadnote stores the variable name rather than its value. The [Pocket API reference](https://docs.heypocketai.com/docs/api) describes API-key authentication.

```sh
threadnote source add --type pocket --id pocket-notes --project engineering
threadnote source add --type pocket --id pocket-notes --project engineering --apply
threadnote source sync pocket-notes --apply
threadnote source inventory pocket-notes
threadnote source status pocket-notes
threadnote source remove pocket-notes --apply
```

Use `--projectless` instead of `--project` for a source deliberately available across projects. `--credential-env NAME` selects a different credential variable. Refresh and maximum stale-age settings bound automatic refresh and use of cached content. Recall refreshes due connections; it does not run a background webhook listener.

## Coverage and sync

Threadnote uses the fixed, official Pocket API origin with read-only GET requests. It discovers recordings through the [paginated list endpoint](https://docs.heypocketai.com/docs/api/recordings/list-recordings) and requests [recording details](https://docs.heypocketai.com/docs/api/recordings/get-recording-details) with transcripts and summarizations included. Recording titles, timestamps, speakers, tags, available translation metadata, and structured summary data are retained as bounded text. Folder and tag catalogs provide their available names and metadata too.

The public schema leaves summarizations open-ended. Threadnote preserves their structured text rather than assuming one template. Action items or mind maps are available when Pocket includes them in the returned data. Audio files, downloads, attachments, administrative organization settings, and data inaccessible to the API key are outside this text integration.

Sync has request, time, and response-size budgets. Automatic recall refresh shares one budget across Pocket connections and rotates which connection starts first. Discovery saves each page's recording IDs before processing them and continues across bounded runs. A failed recording or optional catalog does not prevent later recordings from importing. Failed items remain eligible for retry.

Pocket's pagination can change while sync runs. After a complete successful listing, Threadnote confirms missing cached recordings through their detail endpoint before removing them. A successful detail response preserves and refreshes the recording; transient failures preserve the cache within its stale-age limit. Partial or failed discovery does not authorize cleanup. Stable recording identities keep renames and updates on the same resources.

Imported text remains untrusted external evidence. Local configuration controls its project and access policy; remote text cannot create durable memories or approved guidance. Threadnote scans before publishing chunks and rejects credential-bearing content. Authentication loss denies the source cache immediately; per-record access loss denies that record. Transient failures can retain previously complete content only within the configured stale-age limit. Incomplete publication stays inaccessible until repaired by sync.

These local external sources are excluded from Cursor Cloud memory scopes and from Context Brief synthesis. They remain recallable through the normal local recall and resource-read paths after a successful sync.
