import {RECALL_READY_READ_WORKER_ARGUMENT} from './worker_protocol.js';

// Ready reads spend their child allowance under the caller's read deadline.
// Dispatch that worker before evaluating the CLI module graph it never uses.
if (process.argv[2] === RECALL_READY_READ_WORKER_ARGUMENT) {
  const {runReadyRecallReadWorker} = await import('./recall/ready_read_entry.js');
  runReadyRecallReadWorker(process.argv.slice(2));
} else {
  await import('./standalone_cli.js');
}
