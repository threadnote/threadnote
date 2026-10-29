import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {describe, expect} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {isJsonObject} from '@threadnote/platform/json';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {runTelemetryDisable, runTelemetryEnable, runTelemetryStatus} from '@threadnote/threadnote/telemetry/commands';
import {readTelemetryConfiguration, telemetryConfigurationPath} from '@threadnote/threadnote/telemetry/config';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('telemetry commands', () => {
  effectIt.effect('previews the complete consent contract without creating state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-preview-'});
        const config = runtimeConfig(home);
        const preview = yield* captureConsole(runTelemetryEnable(config, {}));

        expect(preview.output).toContain('General CLI and MCP operations');
        expect(preview.output).toContain('bounded runtime memory/resource observations');
        expect(preview.output).toContain('phases/state');
        expect(preview.output).toContain('safe typed failures');
        expect(preview.output).toContain('automatic-update result');
        expect(preview.output).toContain('repair-required');
        expect(preview.output).toContain('Successful graph builds additionally include');
        expect(preview.output).toContain('build-kind/materialization/fallback/closure/efficiency');
        expect(preview.output).toContain('changed/deleted/delta/extracted/reused/staged/total file-count buckets');
        expect(preview.output).toContain('fact-byte buckets, and rewrite/replay-amplification buckets');
        expect(preview.output).toContain('Failed graph builds add only bounded outcome/type');
        expect(preview.output).toContain('interrupted graph builds add only outcome/duration');
        expect(preview.output).toContain('Neither adds graph classifications or buckets');
        expect(preview.output).toContain('MCP graph inspection diagnostics additionally include');
        expect(preview.output).toContain('closed request-kind, local/workset scope');
        expect(preview.output).toContain('active/promoted/borrowed selection');
        expect(preview.output).toContain('file/symbol/edge-count buckets');
        expect(preview.output).toContain('Successful Context Brief diagnostics additionally include');
        expect(preview.output).toContain('code-linked-memory/citation-validation/projection phases');
        expect(preview.output).toContain('task-only-v2/code-anchored-v3 contract');
        expect(preview.output).toContain('returned graph/memory lane and bounded gap classes');
        expect(preview.output).toContain('Deferred code-anchor finalization checkpoints additionally include');
        expect(preview.output).toContain('none/complete/partial/unavailable validation coverage');
        expect(preview.output).toContain('none/exact-only/relocated/stale/unknown/mixed citation result');
        expect(preview.output).toContain('power-of-two buckets for cited memories');
        expect(preview.output).toContain('Non-successful Context Brief and finalization checkpoints never include');
        expect(preview.output).toContain('Never arguments');
        expect(preview.output).toContain('MCP payloads/results');
        expect(preview.output).toContain('Grafana Cloud EU');
        expect(preview.output).toContain('14-day trace retention');
        expect(preview.output).toContain('transport providers process source IP addresses');
        expect(preview.output).toContain('use --auto-accept to opt into automatic acceptance');
        expect(preview.output).toContain('No changes made. Re-run with --apply');
        expect(yield* fs.exists(yield* telemetryConfigurationPath(config))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('applies consent, reports an environment kill switch, and disables with salt removal', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseSystem = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-commands-'});
        const config = runtimeConfig(home);
        const customPreview = yield* captureConsole(
          runTelemetryEnable(config, {endpoint: 'https://collector.example/v1/traces'}),
        );
        expect(customPreview.output).not.toContain('Grafana Cloud EU');
        expect(customPreview.output).toContain('The selected endpoint operator controls storage and retention.');
        const enabled = yield* captureConsole(runTelemetryEnable(config, {apply: true}));
        expect(enabled.output).toContain('Telemetry consent enabled');
        expect(enabled.output).toContain('Restart connected MCP clients');
        const firstConfiguration = yield* readTelemetryConfiguration(config);
        expect(firstConfiguration?.enabled).toBe(true);
        yield* runTelemetryEnable(config, {apply: true});
        expect(yield* readTelemetryConfiguration(config)).toEqual(firstConfiguration);
        yield* runTelemetryEnable(config, {apply: true, endpoint: 'https://collector.example/v1/traces'});
        const changedEndpoint = yield* readTelemetryConfiguration(config);
        expect(changedEndpoint).toMatchObject({
          enabled: true,
          endpoint: 'https://collector.example/v1/traces',
        });
        expect(changedEndpoint?.enabled === true ? changedEndpoint.sessionSalt : undefined).not.toBe(
          firstConfiguration?.enabled === true ? firstConfiguration.sessionSalt : undefined,
        );

        const dntSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), DNT: '1'}),
        });
        const status = yield* captureConsole(runTelemetryStatus(config)).pipe(
          Effect.provideService(SystemInfo, dntSystem),
        );
        expect(status.output).toContain('disabled by DNT');
        expect(status.output).toContain('persisted consent remains enabled');

        yield* runTelemetryDisable(config, {});
        expect((yield* readTelemetryConfiguration(config))?.enabled).toBe(true);
        yield* runTelemetryDisable(config, {apply: true});
        const disabled = yield* readTelemetryConfiguration(config);
        expect(disabled).toEqual({consentVersion: 6, enabled: false, version: 1});
        expect(yield* fs.readFileString(yield* telemetryConfigurationPath(config))).not.toContain('sessionSalt');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('requires an explicit apply before replacing consent from version 5', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-consent-v6-'});
        const config = runtimeConfig(home);
        yield* runTelemetryEnable(config, {apply: true});
        const file = yield* telemetryConfigurationPath(config);
        const parsedPrevious: unknown = JSON.parse(yield* fs.readFileString(file));
        if (!isJsonObject(parsedPrevious)) throw new Error('Expected a telemetry configuration object.');
        const previous = parsedPrevious;
        const previousEndpoint = 'https://collector.example/v1/traces';
        yield* fs.writeFileString(
          file,
          `${JSON.stringify({...previous, consentVersion: 5, endpoint: previousEndpoint}, undefined, 2)}\n`,
        );

        const status = yield* captureConsole(runTelemetryStatus(config));
        expect(status.output).toContain('does not cover the current version 6 data contract');
        expect(status.output).toContain('threadnote telemetry enable --apply');
        expect(status.output).toContain(`Endpoint: ${previousEndpoint}`);

        const preview = yield* captureConsole(runTelemetryEnable(config, {}));
        expect(preview.output).toContain('Existing consent version 5 remains fail-closed');
        expect(preview.output).toContain(`Endpoint: ${previousEndpoint}`);
        expect(preview.output).toContain('No changes made. Re-run with --apply');
        expect(JSON.parse(yield* fs.readFileString(file))).toMatchObject({consentVersion: 5, enabled: true});

        yield* runTelemetryEnable(config, {apply: true, autoAccept: true});
        expect(yield* readTelemetryConfiguration(config)).toMatchObject({
          autoAccept: true,
          consentVersion: 6,
          enabled: true,
          endpoint: previousEndpoint,
        });

        const statusAfterRenewal = yield* captureConsole(runTelemetryStatus(config));
        expect(statusAfterRenewal.output).toContain('Future telemetry data-contract updates: accepted automatically');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function runtimeConfig(agentContextHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'threadnote',
    manifestPath: `${agentContextHome}/manifest.yaml`,
    user: 'tester',
  };
}
