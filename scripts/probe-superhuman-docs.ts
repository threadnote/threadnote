import {probeSuperhumanTools, ProbeError} from '@threadnote/integration-superhuman/probe';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {getRuntimeConfig} from '@threadnote/threadnote/runtime';
import {telemetryChildEnvironmentPolicyLayer} from '@threadnote/threadnote/telemetry/session';
import {runtimeEntrypointLayer} from '@threadnote/threadnote/effect/runtime-entrypoint';
import {Effect, Layer} from 'effect';

const outcome = await Effect.runPromise(
  getRuntimeConfig().pipe(
    Effect.flatMap(config => probeSuperhumanTools(undefined, {admissionConfig: config})),
    Effect.match({onFailure: error => ({error}), onSuccess: catalog => ({catalog})}),
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This script is the application entry point.
    Effect.provide(
      ApplicationLayer.pipe(Layer.provide(Layer.merge(runtimeEntrypointLayer, telemetryChildEnvironmentPolicyLayer))),
    ),
  ),
);
if ('catalog' in outcome) {
  process.stdout.write(`${JSON.stringify(outcome.catalog, null, 2)}\n`);
} else {
  const code = outcome.error instanceof ProbeError ? outcome.error.code : 'transport-rejected';
  process.stderr.write(`Superhuman Docs MCP probe: ${code}\n`);
  process.exitCode = 1;
}
