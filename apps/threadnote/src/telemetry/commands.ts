import {Console, Effect, Result, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {errorMessage} from '@threadnote/platform/errors';
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  TELEMETRY_CONSENT_VERSION,
  TelemetryConfigurationError,
  createEnabledTelemetryConfiguration,
  disabledTelemetryConfiguration,
  normalizeTelemetryEndpoint,
  readTelemetryConsentRenewal,
  readTelemetryConfiguration,
  telemetryEnvironmentOptOut,
  writeTelemetryConfiguration,
} from './config.js';
import {SystemInfo} from '@threadnote/platform/system';

export interface TelemetryEnableOptions {
  readonly apply?: boolean;
  readonly autoAccept?: boolean;
  readonly endpoint?: string;
}

export interface TelemetryDisableOptions {
  readonly apply?: boolean;
}

const TELEMETRY_DATA_SUMMARY =
  'General CLI and MCP operations, event timestamps and durations, outcomes, bounded runtime memory/resource observations, phases/state, safe typed failures, app/runtime/schema versions, platform, architecture, and random session/invocation/OTLP transport IDs. Automatic-update worker completions additionally include one closed automatic-update result (busy, current, disabled, failed, or updated); updated results include a repair-required boolean, while failed results retain the bounded failure outcome/type. Successful graph builds additionally include coarse build-kind/materialization/fallback/closure/efficiency classifications, changed/deleted/delta/extracted/reused/staged/total file-count buckets, cached/changed/final fact-byte buckets, and rewrite/replay-amplification buckets. Failed graph builds add only bounded outcome/type to that lifecycle surface; interrupted graph builds add only outcome/duration. Neither adds graph classifications or buckets. MCP graph inspection diagnostics additionally include closed request-kind, local/workset scope, and status/snapshot/execute stage labels. A selected local published snapshot adds only active/promoted/borrowed selection, current/deferred/stale freshness, and coarse file/symbol/edge-count buckets. Successful Context Brief diagnostics additionally include closed local/workset scope, task-only-v2/code-anchored-v3 contract, brief/locate/explain/trace/impact mode, graph/memory/code-linked-memory/citation-validation/projection phases, returned graph/memory lane and bounded gap classes, code-anchor coverage plus recovery-present state and power-of-two requested/resolved/matched-memory buckets, none/complete/partial/unavailable validation coverage, none/exact-only/relocated/stale/unknown/mixed citation result, a closed unknown-reason class when applicable, output-truncated state, and power-of-two buckets for cited memories, citations by status, repositories validated, and cache hits. Recall completions additionally include power-of-two buckets for semantic read state counts and the durations of the last vector refresh. Deferred code-anchor finalization checkpoints additionally include a closed trigger/result and power-of-two latency and work-count buckets. Non-successful Context Brief and finalization checkpoints never include result-derived fields.';
const TELEMETRY_EXCLUSION_SUMMARY =
  'Never arguments, environment values, memory or prompt content or identity, task/query text, recall queries/results, MCP payloads/results, paths, node/symbol/citation identity, repository/workset/commit/snapshot/hash identity, exact private counts, exception messages/stacks, user, account, or agent IDs.';
const FIRST_PARTY_DESTINATION_SUMMARY =
  'Destination policy: the first-party gateway forwards accepted traces to Grafana Cloud EU with 14-day trace retention; transport providers process source IP addresses, but Threadnote does not store them in telemetry or emit access logs.';
const CUSTOM_DESTINATION_SUMMARY = 'Destination policy: The selected endpoint operator controls storage and retention.';

function telemetryDestinationSummary(endpoint: string): string {
  return endpoint === DEFAULT_TELEMETRY_ENDPOINT ? FIRST_PARTY_DESTINATION_SUMMARY : CUSTOM_DESTINATION_SUMMARY;
}

export const runTelemetryStatus = Effect.fn('telemetry.command.status')(function* (config: RuntimeConfig) {
  const system = yield* SystemInfo;
  const optOut = telemetryEnvironmentOptOut(system.environment());
  const loaded = yield* Effect.result(readTelemetryConfiguration(config));
  if (Result.isFailure(loaded)) {
    const renewal = yield* readTelemetryConsentRenewal(config).pipe(Effect.orElseSucceed(() => undefined));
    if (renewal !== undefined) {
      yield* Console.log(
        `Anonymous telemetry: disabled (consent version ${renewal.consentVersion} does not cover the current version ${TELEMETRY_CONSENT_VERSION} data contract).`,
      );
      yield* Console.log('Review the current contract with: threadnote telemetry enable');
      yield* Console.log('After reviewing it, renew explicitly with: threadnote telemetry enable --apply');
      yield* Console.log(`Endpoint: ${renewal.endpoint}`);
      yield* Console.log(telemetryDestinationSummary(renewal.endpoint));
      yield* Console.log(`Data contract: ${TELEMETRY_DATA_SUMMARY}`);
      yield* Console.log(`Privacy contract: ${TELEMETRY_EXCLUSION_SUMMARY}`);
      return;
    }
    yield* Console.log('Anonymous telemetry: disabled (configuration is invalid and fails closed).');
    yield* Console.log(`Configuration error: ${errorMessage(loaded.failure)}`);
    yield* Console.log(`Data contract: ${TELEMETRY_DATA_SUMMARY}`);
    yield* Console.log(`Privacy contract: ${TELEMETRY_EXCLUSION_SUMMARY}`);
    return;
  }
  const configuration = loaded.success;
  if (configuration?.enabled !== true) {
    yield* Console.log('Anonymous telemetry: disabled (default; no telemetry is sent).');
    yield* Console.log(`Data contract: ${TELEMETRY_DATA_SUMMARY}`);
    yield* Console.log(`Privacy contract: ${TELEMETRY_EXCLUSION_SUMMARY}`);
    return;
  }
  if (optOut !== undefined) {
    yield* Console.log(`Anonymous telemetry: disabled by ${optOut} (persisted consent remains enabled).`);
  } else {
    yield* Console.log('Anonymous telemetry: enabled.');
  }
  yield* Console.log(
    configuration.autoAccept === true
      ? 'Future telemetry data-contract updates: accepted automatically.'
      : 'Future telemetry data-contract updates: require explicit consent.',
  );
  yield* Console.log(`Endpoint: ${configuration.endpoint}`);
  yield* Console.log(telemetryDestinationSummary(configuration.endpoint));
  yield* Console.log(`Data contract: ${TELEMETRY_DATA_SUMMARY}`);
  yield* Console.log(`Privacy contract: ${TELEMETRY_EXCLUSION_SUMMARY}`);
});

export const runTelemetryEnable = Effect.fn('telemetry.command.enable')(function* (
  config: RuntimeConfig,
  options: TelemetryEnableOptions,
) {
  const renewal = yield* readTelemetryConsentRenewal(config).pipe(Effect.orElseSucceed(() => undefined));
  const endpoint = yield* Effect.try({
    try: () => normalizeTelemetryEndpoint(options.endpoint ?? renewal?.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT),
    catch: cause =>
      Schema.is(TelemetryConfigurationError)(cause)
        ? cause
        : TelemetryConfigurationError.make({message: 'Telemetry endpoint validation failed.', cause}),
  });
  yield* Console.log('Enable anonymous operational telemetry for Threadnote CLI and MCP diagnostics.');
  if (renewal !== undefined) {
    yield* Console.log(
      `Existing consent version ${renewal.consentVersion} remains fail-closed until you explicitly accept the current version ${TELEMETRY_CONSENT_VERSION} contract.`,
    );
  }
  yield* Console.log(`Endpoint: ${endpoint}`);
  yield* Console.log(telemetryDestinationSummary(endpoint));
  yield* Console.log(`Data sent: ${TELEMETRY_DATA_SUMMARY}`);
  yield* Console.log(`Data excluded: ${TELEMETRY_EXCLUSION_SUMMARY}`);
  yield* Console.log(
    options.autoAccept === true
      ? 'Future telemetry data-contract updates will be accepted automatically without another consent prompt.'
      : 'Future telemetry data-contract updates will require explicit consent; use --auto-accept to opt into automatic acceptance.',
  );
  if (options.apply !== true) {
    yield* Console.log('No changes made. Re-run with --apply to record this consent.');
    return;
  }
  const current = yield* Effect.result(readTelemetryConfiguration(config));
  if (
    Result.isSuccess(current) &&
    current.success?.enabled === true &&
    current.success.endpoint === endpoint &&
    (current.success.autoAccept === true) === (options.autoAccept === true)
  ) {
    yield* Console.log('Telemetry consent is already enabled for this endpoint.');
    const system = yield* SystemInfo;
    const optOut = telemetryEnvironmentOptOut(system.environment());
    if (optOut !== undefined) {
      yield* Console.log(`Telemetry remains disabled while ${optOut} is set.`);
    }
    return;
  }
  const configuration = yield* createEnabledTelemetryConfiguration(endpoint, options.autoAccept === true);
  const file = yield* writeTelemetryConfiguration(config, configuration);
  const system = yield* SystemInfo;
  const optOut = telemetryEnvironmentOptOut(system.environment());
  yield* Console.log(`Telemetry consent enabled in ${file}.`);
  if (configuration.autoAccept === true) {
    yield* Console.log('Automatic acceptance of future telemetry data-contract updates is enabled.');
  }
  yield* Console.log('Restart connected MCP clients that started before this consent change.');
  if (optOut !== undefined) {
    yield* Console.log(`Telemetry remains disabled while ${optOut} is set.`);
  }
});

export const runTelemetryDisable = Effect.fn('telemetry.command.disable')(function* (
  config: RuntimeConfig,
  options: TelemetryDisableOptions,
) {
  yield* Console.log('Disable anonymous operational telemetry for all Threadnote CLI and MCP diagnostics.');
  yield* Console.log(
    'Queued diagnostics are dropped after the active exporter observes this change; a network request already in flight cannot be recalled.',
  );
  if (options.apply !== true) {
    yield* Console.log('No changes made. Re-run with --apply to disable telemetry.');
    return;
  }
  const file = yield* writeTelemetryConfiguration(config, disabledTelemetryConfiguration());
  yield* Console.log(`Telemetry disabled in ${file}.`);
});
