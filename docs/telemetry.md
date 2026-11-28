# Optional anonymous telemetry

Threadnote telemetry is disabled by default. It starts only after an explicit applied consent:

```sh
threadnote telemetry status
threadnote telemetry enable
threadnote telemetry enable --apply
# Or opt in once and stay enabled when later releases expand the data contract:
threadnote telemetry enable --auto-accept --apply
```

`enable` is a preview. It describes the endpoint, the exact data categories, and the session model without writing
configuration or making a network request. `--apply` stores consent under
`~/.threadnote/telemetry/config.json`. Adding `--auto-accept` explicitly opts into future telemetry data-contract
updates without another consent prompt. Omit it to keep the default fail-closed renewal behavior. Reapplying consent
without `--auto-accept` turns automatic acceptance back off while leaving telemetry enabled. Disable follows the same
preview/apply contract:

```sh
threadnote telemetry disable
threadnote telemetry disable --apply
```

`DO_NOT_TRACK=1` or `THREADNOTE_TELEMETRY=0` is an immediate process-level kill switch. An invalid, unreadable, or
unsupported telemetry configuration always fails closed. Install, update, repair, doctor, help, and telemetry consent
commands never enable telemetry implicitly.

Consent has a version independent of the configuration format. Schema v7 requires consent version 7. It adds buckets for semantic recall states and vector refresh durations.
An earlier consent fails closed until the user reviews the current preview and runs `threadnote telemetry enable --apply`.
If earlier consent includes `autoAccept: true`, telemetry stays enabled and new processes use the current contract.
An older release rejects consent from a newer release.

When an upgrade finds valid enabled v5 or v6 consent, it shows the complete preview before it asks to apply v7 consent.
The `--yes` flag does not answer the consent prompt. Non-interactive and automatic updates leave telemetry off and show the manual renewal command.
The preview reuses the previously selected endpoint unless `--endpoint` is supplied. A non-interactive post-update action also
sends a best-effort local desktop reminder. `threadnote telemetry status` and `threadnote doctor` distinguish this
renewal state from malformed configuration and show the same explicit remedy.

Applied disable is observed by active exporters at their next event or transport gate. Queued requests that have not
started are dropped. A network request that already started cannot be recalled, but no later request is sent. Enabling
telemetry, changing its endpoint, or re-enabling it after consent was removed requires restarting already-connected
MCP clients; the CLI uses the new setting on its next invocation.

## What a trace contains

Telemetry uses Effect's traces-only OTLP/HTTP exporter. Threadnote creates a separate diagnostic span around every
CLI operation (including previews and diagnostic commands) and every MCP tool call, except telemetry consent commands
and unambiguous help displays. Fixed subcommand names distinguish operations such as `graph.index` from `graph.query`;
positional values and option values are never appended. The application operation runs with exporter tracing disabled, so the
existing Effect span tree and failure details cannot leak into OTLP.

The current versioned allowlist is limited to:

- the Threadnote app version (`service.version`), embedded runtime version, telemetry-schema version, OS platform, and
  architecture;
- `cli` or `mcp`, a fixed command/tool name, duration, and `success`, `failure`, `interrupted`, `timed-out`, or
  `unavailable`;
- bucketed process memory measurements at operation start and finish (RSS, heap, external, and peak RSS), used to
  diagnose out-of-memory and growth regressions without a process identifier;
- allowlisted phase durations and states for recall, indexing, graph scanning/materialization/resolution/activation,
  embedding, model work, storage waits, and other explicitly instrumented subsystems;
- a recall completion can include four power-of-two count buckets for `current`, `serving-older`, `refreshable`, and `compaction` reads.
  Each completion reports its own counts. If a refresh record exists, the completion adds its build and known stale durations as power-of-two millisecond buckets;
- an automatic-update worker completion includes one closed result: `busy`, `current`, `disabled`, `failed`, or
  `updated`. An `updated` result also includes a boolean saying whether post-update local setup repair still requires
  attention. A `failed` result also retains the existing bounded failure outcome and safe typed failure class; it does
  not include installed versions or installation identity;
- one terminal graph-build lifecycle observation: a successful build includes clean/dirty build kind; closed
  materialization mode, fallback reason, resolution-closure, and efficiency classifications; coarse
  changed/deleted/delta/extracted/reused/staged/total file-count buckets; cached/changed/final fact-byte buckets; and
  rewrite/replay-amplification buckets. A failed graph build adds only bounded outcome/failure type to this lifecycle
  surface, while an interrupted graph build adds only outcome/duration; neither includes graph classifications or
  buckets;
- graph-query timing for `inspect_code_graph` and `analyze_code_graph`: a closed request kind and local/workset scope;
  the closed `graph.query.status`, `graph.query.snapshot`, and `graph.query.execute` phase durations; and, for a local
  published snapshot, closed selection/freshness classes plus power-of-two file-, symbol-, and edge-count buckets.
  Schema v4 also admits snapshot-free checkpoints for the closed stages `query-repository-identity`,
  `query-worktree-observation`, `query-strict-reobservation`, and `query-serialization`. A normal executed stage has no
  subphase; the only exceptional query-stage subphases are `skipped` and `fallback`. Stage checkpoints never acquire or
  retain snapshot buckets on the terminal completion. Workset requests do not export a member repository's snapshot
  surface, and non-successful completions do not export snapshot buckets;
- Context Brief timing and quality diagnostics on successful results: closed `local` or `workset` scope;
  `task-only-v2` or `code-anchored-v3` contract; `brief`, `locate`, `explain`, `trace`, or `impact` mode;
  `context.brief.graph`, `context.brief.memory`, `context.brief.code-linked-memory`,
  `context.brief.citation-validation`, and `context.brief.projection` phase durations; a closed
  `none`, `memory`, `graph`, or `mixed` returned lane; complete/partial/unavailable code-anchor coverage; a boolean
  anchor-gap state; a closed none/unresolved/truncated/unavailable/mixed gap class; a boolean saying whether bounded
  recovery guidance survived projection; and power-of-two requested-, resolved-, and matched-memory anchor buckets;
  `none`, `complete`, `partial`, or `unavailable` citation-validation coverage;
  `none`, `exact-only`, `relocated`, `stale`, `unknown`, or `mixed` aggregate result; one closed unknown-reason class
  when unknown evidence is present; a boolean output-truncated state; and power-of-two buckets for cited memories,
  total citations, exact/relocated/stale/unknown citations, repositories validated, and cache hits. A failed,
  interrupted, timed-out, or unavailable completion retains only its closed outcome/type and never the
  result-derived citation surface. Live telemetry diagnoses coverage, latency, warnings, and abstention; it cannot
  prove citation correctness or absence of stale memory;
- deferred code-anchor finalization checkpoints: a closed `context-brief`, `explicit`, `graph-index`, or
  `workset-prepare` trigger; a closed `conflict`, `contended`, `failed`, `finalized`, `mixed`, `no-work`, or `pending`
  result; and power-of-two scanned, matched, finalized, pending, conflict, failed, and latency buckets. They never
  include a memory URI, requested code ref, pending-intent identity, repository identity, path, or exact count. A
  non-successful checkpoint retains only its closed outcome/type and never result-derived fields;
- a random agent-session identifier and correlation scope, plus a random per-invocation identifier that joins that
  operation's completion, phase, and liveness spans;
- a bounded safe failure type for every failed operation, plus structured fields when a subsystem exposes a closed
  diagnostic contract (for example storage domain, code, operation, recovery class, and retryability).
- span start/end timestamps and fresh OpenTelemetry trace/span transport identifiers. These are required by the OTLP
  trace envelope and are not Threadnote, MCP, installation, or provider request identifiers.

It never contains command arguments, environment values, user/account/agent identifiers, process IDs, host names,
paths, working directories, repository or workset names or identities, commit/snapshot/content hashes,
branches/remotes, memory identity or content, citation or node identity, task text, transcript content,
recall/code query text or results, symbol names, exact file/symbol/edge counts, exact
citation/repository/cache/code-anchor/finalization counts, MCP payloads, request IDs, progress tokens, logs, SQL,
exception messages, or stack traces. The exporter is best-effort:
network, configuration, batching, and shutdown failures cannot change a command or MCP result or cause application work
to run twice.

Threadnote deliberately has no persistent installation identifier. An MCP session identifier is random for one broker
lifetime and survives promotion to a newer MCP child. A standalone CLI invocation has a fresh identifier. When an
agent host exposes the same conversation token to both processes, Threadnote can derive the same opaque session alias
with a local consent-time salt; the token and salt are never exported. Without such a provider token, Threadnote does
not claim that unrelated CLI and MCP processes belong to the same conversation.

Provider integrations must supply a token scoped to one conversation. They must never substitute an account, user,
machine, or installation token. Threadnote accepts only named provider integrations and treats inherited child aliases
as valid only when they are marked as an intended Threadnote child and match the current consent generation. Generic
subprocesses do not inherit the provider token, session alias, or consent marker.

Long-running work emits a first liveness checkpoint after 30 seconds and then once per minute. Isolated graph/model
worker crashes, parser memory degradation, timeouts, and non-zero exits are observed by the parent process. No
in-process telemetry system can guarantee a final span if the entire parent is killed or runs out of memory before a
checkpoint is exported; the last successful checkpoint is the available evidence in that case.

The OTLP payload does not identify a person or installation, but an HTTPS service necessarily receives a source IP address
during transport. Operators and hosting providers can process that network metadata even though Threadnote does not
put it in a span. This is anonymous application telemetry, not a promise of network anonymity. The first-party
gateway emits no application access logs; Fly.io still processes transport metadata at its edge and retains the
gateway process's fixed operational stdout/stderr for seven days.

## Destination

The default destination is the first-party OTLP/HTTP traces endpoint
`https://telemetry.threadnote.io/v1/traces`. A self-hosted or development collector can be selected during consent:

```sh
threadnote telemetry enable --endpoint https://telemetry.example.com/v1/traces
threadnote telemetry enable --endpoint http://127.0.0.1:4318/v1/traces --apply
```

Production endpoints must use HTTPS; plain HTTP is accepted only on loopback for local testing. URLs with embedded
credentials, query strings, or fragments are rejected. The endpoint is stored with the consent so Threadnote cannot
silently redirect an existing opt-in to a new destination.

The recommended production path is:

```text
Threadnote CLI/MCP
        │  OTLP/HTTP protobuf, traces only
        ▼
telemetry.threadnote.io schema gateway
        │  server-side credentials
        ▼
OpenTelemetry Collector / Grafana Alloy
        ▼
Tempo-compatible trace storage
```

The gateway, rather than the open-source binary, owns vendor credentials. It rejects logs and metrics, admits the
immutable v1 through v7 trace contracts, validates the complete versioned resource/span envelope before
forwarding, caps bodies and rates, rejects unknown fields, avoids forwarding client IP headers, and emits no application access
logs. V1 and v2 are frozen, v3 adds only the closed automatic-update result and repair-required flag, v4 adds only
the closed, bucketed graph-query surface, v5 adds only the closed Context Brief citation surface, v6 adds the
closed Context Brief code-anchor and deferred-finalization surface, and v7 adds the recall buckets.
Accepted traces are stored in Grafana Cloud EU with
the 14-day retention of its Always Free plan. The gateway's fixed accepted-byte budget keeps the required two-Machine
deployment below 3 GB of canonical input per month, leaving headroom within the plan's 50 GB allowance for bounded
retries. The static Threadnote GitHub Pages site cannot receive OTLP and public GitHub issues are not an appropriate
telemetry sink.

The first-party gateway is separate deployment infrastructure. Its public storage canary verifies TLS, all seven
immutable schemas, forwarding, and Grafana query visibility. Deploy the schema v7 gateway first and verify the canary.
Deploy the compatible dashboard before you release the consent-v7 producer.

## Local Jaeger dogfooding

Jaeger's all-in-one image is a convenient transient OTLP receiver and trace UI for local validation. Bind both ports
to loopback so the collector and UI are not exposed on the network:

```sh
docker run --detach --rm --name threadnote-jaeger \
  -p 127.0.0.1:4318:4318 \
  -p 127.0.0.1:16686:16686 \
  cr.jaegertracing.io/jaegertracing/jaeger:2.20.0
```

Use an isolated Threadnote home when exercising consent so normal development configuration stays untouched:

```sh
export THREADNOTE_DOGFOOD_HOME="$(mktemp -d)"
THREADNOTE_HOME="$THREADNOTE_DOGFOOD_HOME" threadnote telemetry enable \
  --endpoint http://127.0.0.1:4318/v1/traces --apply
THREADNOTE_HOME="$THREADNOTE_DOGFOOD_HOME" threadnote version
```

Open `http://127.0.0.1:16686`, select the `threadnote` service, and search for traces. The resource attributes include
the app version as `service.version`; diagnostic spans contain only the allowlisted fields documented above. Jaeger's
all-in-one storage is in memory, so stopping the container discards the dogfooding traces:

```sh
docker stop threadnote-jaeger
```
