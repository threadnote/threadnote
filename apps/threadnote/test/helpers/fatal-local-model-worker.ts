import {Array as EffectArray} from 'effect';
import type {
  LocalModelWorkerProcess,
  LocalModelWorkerSpawner,
} from '@threadnote/threadnote/effect/ai/isolated-local-model-runtime';

export interface FatalLocalModelWorkerHarness {
  readonly spawnCount: () => number;
  readonly spawnWorker: LocalModelWorkerSpawner;
}

/**
 * Starts a real child process that terminates with a native-crash-shaped
 * stderr message as soon as it receives a worker request.
 */
export function fatalLocalModelWorkerHarness(): FatalLocalModelWorkerHarness {
  let count = 0;
  return {
    spawnCount: () => count,
    spawnWorker: () => {
      count += 1;
      return spawnFatalLocalModelWorker();
    },
  };
}

function spawnFatalLocalModelWorker(): LocalModelWorkerProcess {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      '-e',
      EffectArray.join(
        [
          "process.stdin.once('data', () => {",
          "  process.stderr.write('FATAL ERROR: synthetic native generation crash\\n');",
          '  process.exit(134);',
          '});',
          'process.stdin.resume();',
        ],
        '\n',
      ),
    ],
    env: {...process.env},
    stdin: 'pipe',
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const input = child.stdin;
  return {
    closeInput: async () => {
      await input.end();
    },
    exited: child.exited,
    kill: () => child.kill('SIGKILL'),
    stderr: child.stderr as ReadableStream<Uint8Array>,
    stdout: child.stdout as ReadableStream<Uint8Array>,
    write: async line => {
      await input.write(line);
      await input.flush();
    },
  };
}
