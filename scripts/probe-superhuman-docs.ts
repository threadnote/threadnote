import {probeSuperhumanTools, ProbeError} from '@threadnote/integration-superhuman/probe';
import {ScriptSystemInfoLayer} from './effect/system-layer.ts';
import {runtimeEntrypointLayer} from '@threadnote/threadnote/effect/runtime-entrypoint';
import {Effect, Layer} from 'effect';

const outcome = await Effect.runPromise(
  probeSuperhumanTools().pipe(
    Effect.match({onFailure: error => ({error}), onSuccess: catalog => ({catalog})}),
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This script is the application entry point.
    Effect.provide(ScriptSystemInfoLayer.pipe(Layer.provide(runtimeEntrypointLayer))),
  ),
);
if ('catalog' in outcome) {
  process.stdout.write(`${JSON.stringify(outcome.catalog, null, 2)}\n`);
} else {
  const code = outcome.error instanceof ProbeError ? outcome.error.code : 'transport-rejected';
  process.stderr.write(`Superhuman Docs MCP probe: ${code}\n`);
  process.exitCode = 1;
}
