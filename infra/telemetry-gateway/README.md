# Threadnote telemetry gateway

This Fly service accepts anonymous OTLP/HTTP protobuf traces at `/v1/traces`
and forwards the allowlisted envelope to Grafana Cloud. Logs and metrics do not
have pipelines. The public Go ingress is deliberately small and emits no access
logs; the Collector only listens on loopback.

The Go ingress validates the complete request against the immutable,
version-selected [`telemetry-schema-v1.json`](./telemetry-schema-v1.json),
[`telemetry-schema-v2.json`](./telemetry-schema-v2.json),
[`telemetry-schema-v3.json`](./telemetry-schema-v3.json),
[`telemetry-schema-v4.json`](./telemetry-schema-v4.json), or
[`telemetry-schema-v5.json`](./telemetry-schema-v5.json), or
[`telemetry-schema-v7.json`](./telemetry-schema-v7.json) contract before the
Collector can see it. Versions 1 through 5 remain immutable and accepted for
deployed clients. Version 3 adds a closed automatic-update worker result and an
updated-only repair-required boolean; version 4 inherits that surface and adds
only closed graph request/scope, query-phase, query-stage/subphase, snapshot
selection/freshness, and published snapshot-size buckets. Version 5 inherits
every v4 field and adds only closed Context Brief scope, phase, validation
coverage/result/unknown-reason classifications, truncation state, and power-of-two
citation/status/repository/cache buckets. Version 6 inherits every v5 field and adds only closed Context Brief
contract/mode, code-linked-memory phase, code-anchor coverage/gap/recovery/returned-lane classifications and work
buckets, plus closed deferred-finalization trigger/result and work/latency buckets. It rejects unknown or duplicate
protobuf fields, schema surface mixing, mixed valid/invalid batches, unrecognized attributes and
values, invalid field combinations, span events, links, trace state, status
messages, and malformed identifiers. Accepted
data is rebuilt into a fresh canonical protobuf envelope rather than forwarding
the caller's bytes. The Collector repeats the attribute projection as defense in
depth. Logs and metrics have no pipelines.

The edge ingress also enforces route, method, media type, body, concurrency, and
request-rate limits. A 32 KiB accepted-byte budget per Machine per minute keeps
the required two-Machine deployment below 3 GB of canonical input per month
even under continuous saturation. Collector queues and retries are disabled so
accepted telemetry receives one best-effort export attempt rather than
amplifying provider-side volume. Source addresses are used
only as process-ephemeral HMAC rate-limit keys; they are neither logged nor
forwarded. Production deployment, credential rotation, storage canary,
certificate, DNS, monitoring, and rollback requirements live in the
[production runbook](../../docs/operations/telemetry-production.md).

The scheduled canary checks the actual Fly Machine inventory against the shared
budget before it sends seventeen traces: a frozen-v1 completion, frozen-v2 graph
lifecycle, frozen-v3 graph and automatic-update traces, and current-v4 graph,
automatic-update, query-checkpoint, and query-completion traces, plus current-v5
Context Brief graph, memory, citation-validation, and projection checkpoints and
a complete terminal result; and current-v6 Context Brief code-linked-memory and completion traces plus one
deferred-code-anchor-finalization checkpoint, then a v7 recall completion. At the 20 GB operator gate, setting the Fly secret
`THREADNOTE_TELEMETRY_PUBLIC_INGESTION=disabled` makes `/v1/traces`
return `503` while `/healthz` remains available; the runbook contains the exact
shutdown and recovery procedure.

## Configure Fly

Use the Grafana Cloud OTLP base endpoint (without `/v1/traces`) and a literal
HTTP Basic authorization value:

```sh
fly secrets set \
  GRAFANA_CLOUD_OTLP_ENDPOINT='https://otlp-gateway-<region>.grafana.net/otlp' \
  GRAFANA_CLOUD_AUTHORIZATION='Basic <base64(instance-id:access-policy-token)>'
```

Do not commit either value. The production policy requires a single-stack,
`traces:write`-only access policy and the shortest available trace retention.

## Import the dogfood dashboard

[`threadnote-anonymous-telemetry-dashboard.json`](./threadnote-anonymous-telemetry-dashboard.json)
is a portable Classic dashboard model. In Grafana, open **Dashboards**, choose
**New > Import**, upload the JSON file, and map the `Tempo` input to the
preconfigured **Grafana Cloud Traces** data source. The import replaces
`${DS_TEMPO}` with that data source's UID; it does not need or contain ingestion
credentials.

The suggested dashboard UID is `threadnote-telemetry`. Importing it again into
the same organization updates that dashboard after confirmation. Change the UID
on the import screen when a separate copy is desired. Keep the dashboard private:
its tables can show opaque random session and invocation IDs for correlation, so
do not publish snapshots or use those IDs as metric groupings or alert labels.
Schemas v2 through v7 inherit that existing ephemeral base correlation envelope; no
identifier is part of the graph, automatic-update, or graph-query surface, aggregation, or graph
incident table.

The dashboard defaults to six hours and should remain at 24 hours or less because
TraceQL metrics queries have a default 24-hour range limit. Every semantic query
pins its telemetry schema version and the anonymous diagnostic span name. Every
Tempo query excludes the exact synthetic canary version `0.0.0-canary` before
aggregation or table selection. Existing operation panels admit schema versions 1, 2, 3, 4, 5, 6, and 7
so producer upgrades do not make them go dark. Graph-build panels admit versions 2, 3, 4, 5, 6, and 7
and aggregate only by app version, closed mode/fallback/efficiency
classifications, and coarse buckets; their incident table selects the same
bounded fields plus duration. They never group by or select session, invocation,
repository, path, or commit identity. Operation outcomes and latency use
`threadnote.outcome` and the numeric
`threadnote.duration_ms`; OTLP span status and duration do not represent the
operation result. The automatic-update panel uses schemas v3 through v7's closed
result and updated-only repair flag. Graph-query panels admit versions 4, 5, 6, and 7 and
show successful end-to-end p50, p95, and p99 by closed request kind; p50 and p95
for each closed query phase and request kind; p95 by snapshot file-count bucket;
selection/freshness counts; and fine-stage latency by stage/subphase. Phase panels use checkpoint events so a completion's copy of
the last phase is not counted again. Context Brief compatibility panels admit schemas v5 through v7 and show successful
end-to-end and citation-phase p50/p95/p99 latency, coverage/result/unknown-reason trends, status and cache buckets, output truncation,
and safe recent non-successful calls. V6-only panels show contract/mode cohorts, anchor coverage/gap/recovery,
returned lane, requested/resolved/matched-memory buckets, and deferred-finalization trigger/result/work/latency
distributions. They do not display or group by session, invocation, task, path, memory,
citation, repository, workset, commit, snapshot, or hash identity. Live panels diagnose quality signals; they do not
prove correctness or the absence of stale memories. Memory values are intentionally coarse
string buckets and are only grouped and counted.

The dashboard includes an unexpected-full percentage and rewrite/replay
amplification distributions. The percentage denominator is dirty builds; its
guarded Grafana expression renders a zero-count bucket as 0% instead of dividing
by zero, while datasource-wide NoData remains visible. The
amplification panels require a nonzero coarse denominator so clean cold builds
cannot dilute or pollute the incident signal. These are not alert rules. The
operated Tempo data source does not support Grafana-managed alerting, and this
repository has no separate metrics pipeline for these observations. Until a privacy-equivalent
derived-metrics monitor exists, responders must inspect the dashboard during
telemetry review; do not attach identifiers to an external workaround.

The query design follows Grafana's official documentation for the
[dashboard JSON model](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/view-dashboard-json-model/),
[Tempo queries in Grafana](https://grafana.com/docs/grafana/latest/datasources/tempo/query-editor/),
and [TraceQL metrics functions](https://grafana.com/docs/tempo/latest/metrics-from-traces/metrics-queries/functions/).
If an imported panel is empty, widen the dashboard range up to 24 hours and
confirm that the selected Tempo data source returns this query in Explore:

```traceql
{ resource.service.name = "threadnote" && resource.service.version != "0.0.0-canary" && (resource.threadnote.telemetry.schema_version = 1 || resource.threadnote.telemetry.schema_version = 2 || resource.threadnote.telemetry.schema_version = 3 || resource.threadnote.telemetry.schema_version = 4 || resource.threadnote.telemetry.schema_version = 5 || resource.threadnote.telemetry.schema_version = 6 || resource.threadnote.telemetry.schema_version = 7) && span:name = "threadnote.anonymous-diagnostic" } with (most_recent=true)
```

Validate the artifact locally with:

```sh
bun --bun vitest run infra/telemetry-gateway/test/telemetry-gateway-dashboard.test.ts
```

## Validate and smoke locally

Deploy schema v7 in the gateway first. Check that the production canary stores and reads all seventeen traces.
Validate the dashboard before you release a consent-v7 producer. Keep frozen v1 through v6 ingress and canary coverage for supported older producers.

Validate the Collector config without contacting a backend:

```sh
docker run --rm \
  -e GRAFANA_CLOUD_OTLP_ENDPOINT='https://example.invalid/otlp' \
  -e GRAFANA_CLOUD_AUTHORIZATION='Basic ZHVtbXk6ZHVtbXk=' \
  -v "$PWD/infra/telemetry-gateway/collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.158.0@sha256:c5918f78992ee73b0d6f0e599423ac5ec52dd5d9726733114d6eca53d5a32ed5 \
  validate --config=/etc/otelcol-contrib/config.yaml
```

Build the exact Fly image and confirm health with dummy exporter credentials:

```sh
docker build -f infra/telemetry-gateway/Dockerfile -t threadnote-telemetry-gateway .
docker run --rm -d --name threadnote-telemetry-gateway \
  -p 127.0.0.1:18080:8080 \
  -e GRAFANA_CLOUD_OTLP_ENDPOINT='https://otlp-gateway-prod-eu-west-2.grafana.net/otlp' \
  -e GRAFANA_CLOUD_AUTHORIZATION='Basic MTIzNDU2OnRva2Vu' \
  -e THREADNOTE_TELEMETRY_PUBLIC_INGESTION='enabled' \
  threadnote-telemetry-gateway
curl --fail --silent --show-error http://127.0.0.1:18080/healthz
docker stop threadnote-telemetry-gateway
```

Run `fly config validate` before deployment, then follow the production runbook.
