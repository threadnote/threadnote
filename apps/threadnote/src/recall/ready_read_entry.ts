import {Effect, Layer, Runtime} from 'effect';
import {withCliDiagnostics} from '../effect/cli/output.js';
import {runtimeEntrypointLayer} from '../effect/runtime-entrypoint.js';
import {signalTransparentTeardown} from '../process/signal_transparent_main.js';
import {telemetryChildEnvironmentPolicyLayer} from '../telemetry/session.js';
import {RECALL_READY_READ_WORKER_ARGUMENT} from '../worker_protocol.js';
import {makeReadyRecallReadWorkerProgram, readyRecallReadWorkerLayer} from './ready_read_main.js';

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] !== RECALL_READY_READ_WORKER_ARGUMENT)
    throw new Error('Expected the private ready-read worker role.');
  const runSignalTransparentMain = Runtime.makeRunMain(signalTransparentTeardown);
  runSignalTransparentMain(
    makeReadyRecallReadWorkerProgram(arguments_, process.env).pipe(
      Effect.provide(
        readyRecallReadWorkerLayer.pipe(
          Layer.provideMerge(Layer.merge(telemetryChildEnvironmentPolicyLayer, runtimeEntrypointLayer)),
        ),
      ),
      withCliDiagnostics,
    ),
    {disableErrorReporting: true},
  );
}
