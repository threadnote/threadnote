import {CallerReadCancellation} from '@threadnote/platform/read_deadline';
import {RecallReadyReadBoundaryError} from '@threadnote/recall/read_boundary';
import {RECALL_READY_READ_WORKER_ARGUMENT, RECALL_READY_READ_CALLER_CANCELLATION_ARGUMENT} from '../worker_protocol.js';
import {Effect} from 'effect';
import {CommandExecutor, CommandSpawnFailed} from '@threadnote/platform/command';
import {threadnoteHomeForProcess, withSignalTransparentThreadnoteWorkerRegistration} from '../process/diagnostics.js';
import {withStandaloneProcessLease} from '../process/standalone_lease.js';
import {recallReadyReadWorkerProgram, readyRecallReadWorkerLayer} from './ready_read_worker.js';

/** Shared source/standalone composition; read requests cannot start other workers. */
export {readyRecallReadWorkerLayer};

export function makeReadyRecallReadWorkerProgram(arguments_: readonly string[], environment: NodeJS.ProcessEnv) {
  const callerCancelled = arguments_.length === 2 && arguments_[1] === RECALL_READY_READ_CALLER_CANCELLATION_ARGUMENT;
  if (arguments_[0] !== RECALL_READY_READ_WORKER_ARGUMENT || (!callerCancelled && arguments_.length !== 1))
    return Effect.fail(RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'}));
  const noChildren = CommandExecutor.of({
    execute: () =>
      Effect.fail(
        CommandSpawnFailed.make({
          args: [],
          executable: '<ready-read>',
          message: 'Ready lexical workers do not launch commands.',
          cause: undefined,
        }),
      ),
    executeStreaming: () => Effect.die('Ready lexical workers do not launch commands.'),
    spawnDetached: () => Effect.succeed(false),
  });
  return threadnoteHomeForProcess(arguments_, environment).pipe(
    Effect.tap(home =>
      Effect.sync(() => {
        environment.THREADNOTE_HOME = home;
      }),
    ),
    Effect.flatMap(home =>
      withStandaloneProcessLease(
        withSignalTransparentThreadnoteWorkerRegistration(
          home,
          'recall-read-worker',
          'ready-recall',
          recallReadyReadWorkerProgram,
        ),
      ),
    ),
    Effect.provideService(CommandExecutor, noChildren),
    Effect.provideService(CallerReadCancellation, callerCancelled),
  );
}
