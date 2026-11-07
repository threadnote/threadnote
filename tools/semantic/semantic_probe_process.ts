import {isJsonObject} from '@threadnote/platform/json';
/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Disposable process probes own and reap their spawned OS process group. */
import type {ChildProcess} from 'node:child_process';

export async function withinProbeDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function releaseProbeHandles(child: ChildProcess) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

/** SIGKILL and runtime crashes cannot run this cooperative cleanup. */
export function installProbeSignalCleanup(cleanup: (signal: 'SIGINT' | 'SIGTERM') => Promise<void>) {
  let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
  const handle = (signal: 'SIGINT' | 'SIGTERM') => {
    if (interrupted) return;
    interrupted = signal;
    const code = signal === 'SIGINT' ? 130 : 143;
    const timer = setTimeout(() => {
      process.stderr.write('Signal cleanup deadline exceeded; child state is unknown and scratch must be retained.\n');
      process.exit(code);
    }, 8000);
    void cleanup(signal)
      .catch(error => {
        process.stderr.write(`Signal cleanup failed; child state is unknown: ${String(error)}\n`);
      })
      .finally(() => {
        clearTimeout(timer);
        process.exit(code);
      });
  };
  const interrupt = () => handle('SIGINT');
  const terminate = () => handle('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  return {
    get interrupted() {
      return interrupted;
    },
    dispose: () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    },
  };
}

/** Covers the group created by detached spawn, including descendants after its leader exits.
 * It does not claim containment of descendants that deliberately create another group. */
export function ownedProbeGroup(child: ChildProcess) {
  const grouped = process.platform !== 'win32';
  let forced = false;
  const exists = () => {
    if (!child.pid) return false;
    if (!grouped) return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (isJsonObject(error) && error.code === 'ESRCH') return false;
      // macOS can briefly deny probes while an editor process group is exiting.
      // EPERM establishes neither successful cleanup nor absence; keep waiting.
      if (isJsonObject(error) && error.code === 'EPERM') return true;
      throw error;
    }
  };
  const signal = (value: NodeJS.Signals) => {
    if (!exists()) return;
    forced = true;
    try {
      if (grouped) process.kill(-child.pid!, value);
      else child.kill(value);
    } catch (error) {
      if (!isJsonObject(error) || (error.code !== 'ESRCH' && error.code !== 'EPERM')) throw error;
    }
  };
  const wait = async (milliseconds: number) => {
    const deadline = performance.now() + milliseconds;
    while (exists() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    return !exists();
  };
  const cleanup = async () => {
    if (!(await wait(100))) {
      signal('SIGTERM');
      if (!(await wait(1000))) signal('SIGKILL');
    }
    return {scope: grouped ? 'posix-process-group' : 'direct-child-only', drained: await wait(1000), forced};
  };
  return {signal, cleanup};
}
