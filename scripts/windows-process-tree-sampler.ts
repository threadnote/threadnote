import {Effect, Path, Array as EffectArray, Option, String as EffectString} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {ScriptError, scriptError} from './effect/errors.js';
import type {BenchmarkProcessTreeEntry} from './code-graph-benchmark-sampler.js';

export const WINDOWS_PROCESS_TREE_INTERVAL_MS = 250;
export const WINDOWS_PROCESS_TREE_REQUEST_TIMEOUT_MS = 1000;
const FRAME_LIMIT = 1024 * 1024;
const ENTRY_LIMIT = 4096;
export interface WindowsSamplerIdentity {
  readonly processId: number;
  readonly startIdentity: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
function decimal(value: unknown): bigint | undefined {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/u.test(value) ? BigInt(value) : undefined;
}

/** Decode exact integer counters before converting them to the shared sampler representation. */
export function parseWindowsProcessTreeResponse(
  value: unknown,
  expectedId: string,
): readonly BenchmarkProcessTreeEntry[] | undefined {
  if (!record(value) || value.protocol !== 1 || value.kind !== 'sample' || value.id !== expectedId)
    throw ScriptError.make({message: 'Windows sampler response does not match its request.'});
  if (
    value.ok === false &&
    (value.reason === 'process-inspection-failed' ||
      value.reason === 'root-exited' ||
      value.reason === 'root-identity-changed')
  )
    return undefined;
  if (
    value.ok !== true ||
    !EffectArray.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > ENTRY_LIMIT
  )
    throw ScriptError.make({message: 'Windows sampler response has an invalid process tree.'});
  const seen = new Set<number>();
  return EffectArray.map(value.entries, entry => {
    if (!record(entry)) throw ScriptError.make({message: 'Windows sampler process entry is invalid.'});
    const pid = entry.processId;
    const ppid = entry.parentProcessId;
    const rss = decimal(entry.rssBytes);
    const cpu = decimal(entry.cpuTicks);
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      seen.has(pid) ||
      typeof ppid !== 'number' ||
      !Number.isSafeInteger(ppid) ||
      ppid < 0 ||
      typeof entry.startIdentity !== 'string' ||
      !/^win32:[1-9][0-9]{0,19}$/u.test(entry.startIdentity) ||
      rss === undefined ||
      rss > BigInt(Number.MAX_SAFE_INTEGER) ||
      cpu === undefined ||
      cpu > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw ScriptError.make({
        message: 'Windows sampler process counters or identity are invalid.',
      });
    seen.add(pid);
    return {
      processId: pid,
      parentProcessId: ppid,
      startIdentity: entry.startIdentity,
      rssBytes: Number(rss),
      cpuMilliseconds: Number(cpu) / 10000,
    };
  });
}

/** Bounded framing for the one private PowerShell NDJSON stream. */
export function windowsSamplerFrames(input: ReadableStream<Uint8Array>) {
  const reader = input.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let buffered = '';
  const line = async () => {
    for (;;) {
      const newline = Option.getOrElse(EffectString.indexOf('\n')(buffered), () => -1);
      if (newline !== -1) {
        const result = EffectString.replace(/\r$/u, '')(EffectString.slice(0, newline)(buffered));
        buffered = EffectString.slice(newline + 1)(buffered);
        if (new TextEncoder().encode(result).byteLength > FRAME_LIMIT) throw new Error('Windows sampler frame limit.');
        return JSON.parse(result) as unknown;
      }
      if (new TextEncoder().encode(buffered).byteLength > FRAME_LIMIT) throw new Error('Windows sampler frame limit.');
      const next = await reader.read();
      if (next.done) throw new Error('Windows sampler helper ended.');
      buffered += decoder.decode(next.value, {stream: true});
    }
  };
  const boundedLine = async (milliseconds: number) => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      return await Promise.race([
        line(),
        new Promise<never>((_, reject) => {
          timer = globalThis.setTimeout(() => reject(new Error('Windows sampler helper timed out.')), milliseconds);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return {read: boundedLine, close: () => reader.cancel()};
}

/** One scoped child, never one PowerShell launch per observation. */
export const makeWindowsProcessTreeSampler = Effect.fn('windowsProcessTreeSampler.make')(function* () {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const script = yield* path.fromFileUrl(new URL('./windows-process-tree-sampler.ps1', import.meta.url));
  const child = Bun.spawn({
    cmd: ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', script],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const frames = windowsSamplerFrames(child.stdout);
  let stderrText = '';
  const stderrReader = child.stderr.getReader();
  const drainStderr = async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await stderrReader.read();
      if (chunk.done) return;
      if (stderrText.length < 16 * 1024) stderrText += decoder.decode(chunk.value, {stream: true});
      stderrText = EffectString.slice(0, 16 * 1024)(stderrText);
    }
  };
  const stderrDrained = drainStderr().catch(() => undefined);
  let sequence = 0;
  let failed = false;
  let rootIdentity: string | undefined;
  let parentExited = false;
  let failure: string | undefined;
  const waitExit = async (milliseconds: number) => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      return await Promise.race([
        child.exited,
        new Promise<undefined>(resolve => {
          timer = globalThis.setTimeout(() => resolve(undefined), milliseconds);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const dispose = async () => {
    try {
      await child.stdin.end();
    } catch {
      /* Exit confirmation below remains authoritative. */
    }
    if ((await waitExit(1000)) === undefined) child.kill();
    if ((await waitExit(1000)) === undefined)
      throw ScriptError.make({message: 'Windows sampler helper exit was not confirmed.'});
    await frames.close().catch(() => undefined);
    await stderrDrained;
  };
  yield* Effect.addFinalizer(() => Effect.tryPromise({try: dispose, catch: scriptError}).pipe(Effect.orDie));
  const ready = yield* Effect.tryPromise({
    try: () => frames.read(3000),
    catch: cause =>
      ScriptError.make({cause, message: `Windows sampler startup failed: ${String(cause)} ${stderrText}`}),
  });
  if (!record(ready) || ready.protocol !== 1 || ready.kind !== 'ready' || ready.processId !== child.pid)
    return yield* ScriptError.make({message: 'Windows sampler helper readiness is invalid.'});
  const startIdentity = yield* system.processStartIdentity(child.pid);
  if (startIdentity === undefined)
    return yield* ScriptError.make({
      message: 'Windows sampler helper identity is unavailable.',
    });
  const identity: WindowsSamplerIdentity = {processId: child.pid, startIdentity};
  return {
    identity,
    get failure() {
      return failure;
    },
    get parentExited() {
      return parentExited;
    },
    sample: (rootProcessId: number) =>
      Effect.tryPromise({
        try: async () => {
          if (failed) return undefined;
          const id = String(++sequence);
          try {
            await child.stdin.write(
              `${JSON.stringify({protocol: 1, id, rootProcessId, expectedRootIdentity: rootIdentity})}\n`,
            );
            await child.stdin.flush();
            const reply = await frames.read(WINDOWS_PROCESS_TREE_REQUEST_TIMEOUT_MS);
            const entries = parseWindowsProcessTreeResponse(reply, id);
            if (
              record(reply) &&
              reply.ok === false &&
              (reply.reason === 'root-exited' || reply.reason === 'root-identity-changed')
            )
              parentExited = true;
            const root =
              entries === undefined
                ? undefined
                : Option.getOrUndefined(EffectArray.findFirst(entries, entry => entry.processId === rootProcessId));
            if (
              entries !== undefined &&
              (root === undefined || (rootIdentity !== undefined && root.startIdentity !== rootIdentity))
            )
              return undefined;
            rootIdentity ??= root?.startIdentity;
            return entries;
          } catch (cause) {
            failure = `Windows sampler transport failed: ${String(cause)} ${stderrText}`;
            failed = true;
            if (child.exitCode === null) child.kill();
            return undefined;
          }
        },
        catch: scriptError,
      }),
  };
});
