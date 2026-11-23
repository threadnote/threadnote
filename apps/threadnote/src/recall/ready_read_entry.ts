import {Effect, Layer, Runtime} from 'effect';
import {withCliDiagnostics} from '../effect/cli/output.js';
import {runtimeEntrypointLayer} from '../effect/runtime-entrypoint.js';
import {signalTransparentTeardown} from '../process/signal_transparent_main.js';
import {telemetryChildEnvironmentPolicyLayer} from '../effect/child-environment.js';
import {RECALL_READY_READ_WORKER_ARGUMENT} from '../worker_protocol.js';
import {withReadyRecallReadWorkerProcess} from './ready_read_main.js';
import {readyRecallReadWorkerStartupLayer, recallReadyReadWorkerStartupProgram} from './ready_read_worker.js';

/** Shared by the source entry and the standalone executable's early dispatch. */
export function runReadyRecallReadWorker(arguments_: readonly string[]) {
  if (arguments_[0] !== RECALL_READY_READ_WORKER_ARGUMENT)
    throw new Error('Expected the private ready-read worker role.');
  Runtime.makeRunMain(signalTransparentTeardown)(
    withReadyRecallReadWorkerProcess(arguments_, process.env, recallReadyReadWorkerStartupProgram).pipe(
      Effect.provide(
        readyRecallReadWorkerStartupLayer.pipe(
          Layer.provideMerge(Layer.merge(telemetryChildEnvironmentPolicyLayer, runtimeEntrypointLayer)),
        ),
      ),
      withCliDiagnostics,
    ),
    {disableErrorReporting: true},
  );
}

if (import.meta.main) runReadyRecallReadWorker(process.argv.slice(2));
