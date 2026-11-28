import type {CliCommandReference, DocsArticle} from './docsTypes.js';

export const optionalAnonymousTelemetryCliCommand: CliCommandReference = {
  command: 'telemetry',
  summary: 'Preview, explicitly enable, inspect, or revoke anonymous CLI and MCP operational telemetry.',
  examples: [
    'threadnote telemetry status',
    'threadnote telemetry enable',
    'threadnote telemetry enable --apply',
    'threadnote telemetry enable --auto-accept --apply',
    'threadnote telemetry disable --apply',
  ],
};

export const optionalAnonymousTelemetryDocsArticle: DocsArticle = {
  id: 'optional-anonymous-telemetry',
  title: 'Optional anonymous telemetry',
  summary: 'Explicitly opt in to allowlisted CLI and MCP diagnostics, or keep the default off.',
  keywords: ['anonymous telemetry', 'OpenTelemetry', 'OTLP', 'privacy', 'diagnostics'],
  body: [
    {
      type: 'code',
      language: 'sh',
      code: `threadnote telemetry status
threadnote telemetry enable
# Review the preview, then opt in only if you agree:
threadnote telemetry enable --apply
# Or explicitly accept future data-contract updates too:
threadnote telemetry enable --auto-accept --apply
# Revoke persisted consent:
threadnote telemetry disable --apply`,
    },
    {
      type: 'paragraph',
      text: 'Telemetry is disabled by default. Applied consent covers allowlisted CLI and MCP operation names, outcomes, durations, coarse memory and progress buckets, and safe typed failure classes. An automatic-update worker completion adds one closed result (busy, current, disabled, failed, or updated); updated results add a repair-required boolean. A successful graph build additionally adds path-free diagnostics: clean/dirty kind; closed materialization, fallback, closure, and efficiency classes; changed, deleted, delta, extracted, reused, staged, and total file-count buckets; cached, changed, and final fact-byte buckets; and rewrite/replay-amplification buckets. MCP graph inspections can additionally add only closed request kind, local/workset scope, snapshot selection/freshness, phase/stage/subphase, and published file/symbol/edge-count buckets. Successful Context Briefs can additionally add only closed local/workset scope, task-only-v2/code-anchored-v3 contract, brief/locate/explain/trace/impact mode, graph/memory/code-linked-memory/citation-validation/projection phase timing, returned lane, code-anchor coverage/gap/recovery classes and power-of-two requested/resolved/matched-memory buckets, citation coverage/result/unknown-reason classes, output truncation, and power-of-two cited-memory/citation/status/repository/cache buckets. Deferred code-anchor finalization checkpoints add only a closed trigger/result and power-of-two work/latency buckets. A failed or interrupted operation never adds result-derived Context Brief or finalization fields. Telemetry also covers app and runtime versions, random session and invocation identifiers, and the timestamps and transport IDs required by OTLP. It never includes arguments, environment values, task/query text, code-ref selectors, paths, memory/citation/node/repository/workset/commit/snapshot/hash identity, prompts or memory content, exact private counts, MCP payloads, exception messages, stacks, account identifiers, or a persistent installation identifier.',
    },
    {
      type: 'paragraph',
      text: 'Consent is versioned separately from the configuration format. Schema v7 requires consent version 7. If an earlier consent does not include automatic acceptance, review the current preview and apply consent again to enable telemetry. Users who apply consent with --auto-accept instead opt into future data-contract updates without another prompt, so telemetry stays enabled after those updates. A consent version from a newer Threadnote release still fails closed in an older release.',
    },
    {
      type: 'paragraph',
      text: 'The default first-party endpoint validates the complete versioned envelope before forwarding traces to Grafana Cloud EU. Accepted traces use the stack’s shortest current retention: 14-day trace retention on the free plan. Fly.io and Grafana necessarily process source IP addresses while transporting HTTPS requests, but Threadnote neither writes an IP into a trace nor emits application access logs.',
    },
    {
      type: 'list',
      items: [
        'A random MCP session identifier lasts for one broker lifetime; a standalone CLI invocation gets a fresh identifier.',
        'DO_NOT_TRACK=1 or THREADNOTE_TELEMETRY=0 disables sending without removing persisted consent.',
        'Changing, enabling, or re-enabling telemetry requires restarting already-connected MCP clients; CLI changes apply on the next invocation.',
        'Exporter, network, shutdown, and telemetry-config failures are best-effort and cannot change the application result.',
      ],
    },
    {
      type: 'note',
      text: 'Run threadnote telemetry enable without --apply to review the exact current data and destination contract without writing configuration or making a request. Add --auto-accept only if you also want to accept future telemetry scope changes automatically.',
    },
  ],
};
