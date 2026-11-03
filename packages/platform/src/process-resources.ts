import {Array as EffectArray, Effect, Option, pipe} from 'effect';
import * as EffectString from 'effect/String';
import type {ChildEnvironmentPolicyShape} from './child-environment-policy.js';
import {fromPromise} from './errors.js';

export interface ProcessResourceCounters {
  readonly processId: number;
  readonly processStartIdentity: string;
  readonly cpuMilliseconds: number;
  readonly rssBytes?: number;
  readonly workingDirectory?: string;
}

export interface TimedProcessResourceCounters extends ProcessResourceCounters {
  readonly monotonicMilliseconds: number;
}

export type ProcessCpuObservation = {
  readonly sampledAt: string;
} & (
  | {readonly state: 'sampled'; readonly percent: number; readonly windowMilliseconds: number}
  | {readonly state: 'sampling' | 'unavailable'}
);

/** A full logical core is 100%; process CPU can exceed one core. */
export function processCpuObservation(
  previous: TimedProcessResourceCounters | undefined,
  current: TimedProcessResourceCounters | undefined,
  sampledAt: string,
): ProcessCpuObservation {
  if (!current || !finiteNonnegative(current.cpuMilliseconds) || !Number.isFinite(current.monotonicMilliseconds))
    return {state: 'unavailable', sampledAt};
  if (!previous) return {state: 'sampling', sampledAt};
  const elapsed = current.monotonicMilliseconds - previous.monotonicMilliseconds;
  const cpu = current.cpuMilliseconds - previous.cpuMilliseconds;
  if (
    previous.processId !== current.processId ||
    previous.processStartIdentity !== current.processStartIdentity ||
    !finiteNonnegative(previous.cpuMilliseconds) ||
    !Number.isFinite(elapsed) ||
    elapsed <= 0 ||
    elapsed > 10_000 ||
    !finiteNonnegative(cpu)
  )
    return {state: 'unavailable', sampledAt};
  const percent = (cpu / elapsed) * 100;
  return Number.isFinite(percent)
    ? {state: 'sampled', percent, sampledAt, windowMilliseconds: elapsed}
    : {state: 'unavailable', sampledAt};
}

const PROBE_TIMEOUT_MILLISECONDS = 1_500;
const PROBE_OUTPUT_LIMIT = 128 * 1_024;

/** Reads only bounded PIDs and numeric counters; never command lines or environment values. */
export const readProcessResourceCounters = Effect.fn('system.processResources')(function* (
  processIds: readonly number[],
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  sanitizeExternal: ChildEnvironmentPolicyShape['sanitizeExternal'],
  readLink?: (path: string) => Effect.Effect<string | undefined>,
) {
  const ids = [...new Set(EffectArray.filter(processIds, id => Number.isSafeInteger(id) && id > 0))].slice(0, 100);
  if (ids.length === 0) return new Map<number, ProcessResourceCounters>();
  const env = {...sanitizeExternal(environment), LANG: 'C', LC_ALL: 'C', TZ: 'UTC'};
  if (platform === 'darwin') {
    const output = yield* probeCommand(
      ['/bin/ps', '-o', 'pid=,rss=,time=,lstart=', '-p', EffectArray.join(EffectArray.map(ids, String), ',')],
      env,
    );
    const before = parseDarwinProcessResources(output, ids);
    const directories = parseDarwinWorkingDirectories(
      yield* probeCommand(
        ['/usr/sbin/lsof', '-a', '-p', EffectArray.join(EffectArray.map(ids, String), ','), '-d', 'cwd', '-Fn0'],
        env,
      ).pipe(Effect.timeoutOrElse({duration: 250, orElse: () => Effect.succeed('')})),
      ids,
    );
    if (directories.size === 0) return before;
    const after = parseDarwinProcessResources(
      yield* probeCommand(
        ['/bin/ps', '-o', 'pid=,rss=,time=,lstart=', '-p', EffectArray.join(EffectArray.map(ids, String), ',')],
        env,
      ),
      ids,
    );
    const result = new Map<number, ProcessResourceCounters>();
    for (const [id, row] of after) {
      const workingDirectory =
        before.get(id)?.processStartIdentity === row.processStartIdentity ? directories.get(id) : undefined;
      result.set(id, {...row, ...(workingDirectory ? {workingDirectory} : {})});
    }
    return result;
  }
  if (platform === 'win32') {
    const output = yield* probeCommand(
      [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ids=$env:THREADNOTE_PROCESS_IDS -split ","; ' +
          'Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { try { ' +
          '[pscustomobject]@{pid=$_.Id;rss=$_.WorkingSet64;cpu=$_.TotalProcessorTime.TotalMilliseconds;' +
          'start=$_.StartTime.ToUniversalTime().Ticks.ToString()} } catch {} } | ConvertTo-Json -Compress',
      ],
      {...env, THREADNOTE_PROCESS_IDS: EffectArray.join(EffectArray.map(ids, String), ',')},
    );
    return parseWindowsProcessResources(output, ids);
  }
  if (platform !== 'linux') return new Map<number, ProcessResourceCounters>();
  const [ticksText, pageText] = yield* Effect.all(
    [probeCommand(['getconf', 'CLK_TCK'], env), probeCommand(['getconf', 'PAGESIZE'], env)],
    {concurrency: 2},
  );
  const ticks = Number(ticksText);
  const pageBytes = Number(pageText);
  if (!Number.isSafeInteger(ticks) || ticks <= 0 || !Number.isSafeInteger(pageBytes) || pageBytes <= 0)
    return new Map<number, ProcessResourceCounters>();
  const rows = yield* Effect.forEach(
    ids,
    id =>
      fromPromise('processResources.stat', () => Bun.file(`/proc/${id}/stat`).text()).pipe(
        Effect.flatMap(text =>
          Effect.gen(function* () {
            const before = parseLinuxProcessResources(text, id, ticks, pageBytes);
            if (!before || !readLink) return before;
            const workingDirectory = safeWorkingDirectory(yield* readLink(`/proc/${id}/cwd`));
            if (!workingDirectory) return before;
            const after = parseLinuxProcessResources(
              yield* fromPromise('processResources.verifyStat', () => Bun.file(`/proc/${id}/stat`).text()),
              id,
              ticks,
              pageBytes,
            );
            return after && before.processStartIdentity === after.processStartIdentity
              ? {...after, workingDirectory}
              : after;
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      ),
    {concurrency: 8},
  );
  const result = new Map<number, ProcessResourceCounters>();
  for (const row of rows) if (row !== undefined) result.set(row.processId, row);
  return result;
});

function safeWorkingDirectory(value: unknown): string | undefined {
  return typeof value === 'string' &&
    pipe(value, EffectString.startsWith('/')) &&
    !/[^\u0020-\u007e\u00a0-\u{10ffff}]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= 4096
    ? value
    : undefined;
}

export function parseDarwinWorkingDirectories(
  output: string,
  processIds: readonly number[],
): ReadonlyMap<number, string> {
  const result = new Map<number, string>();
  const selected = new Set(processIds);
  let id = 0;
  let cwd = false;
  for (const raw of EffectString.split(output, '\0')) {
    const field = pipe(raw, EffectString.replace(/^\n+/u, ''));
    if (/^p\d+$/u.test(field)) {
      id = Number(pipe(field, EffectString.slice(1)));
      cwd = false;
    } else if (pipe(field, EffectString.startsWith('f'))) cwd = field === 'fcwd';
    else if (cwd && selected.has(id) && pipe(field, EffectString.startsWith('n'))) {
      const path = safeWorkingDirectory(pipe(field, EffectString.slice(1)));
      if (path) result.set(id, path);
    }
  }
  return result;
}

function probeCommand(command: readonly string[], environment: NodeJS.ProcessEnv): Effect.Effect<string> {
  return Effect.acquireUseRelease(
    Effect.try(() =>
      Bun.spawn({
        cmd: [...command],
        env: environment,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        maxBuffer: PROBE_OUTPUT_LIMIT,
        killSignal: 'SIGKILL',
      }),
    ),
    child =>
      fromPromise('processResources.probe', async () => {
        const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        return code === 0 && text.length <= PROBE_OUTPUT_LIMIT ? text : '';
      }),
    child =>
      Effect.sync(() => {
        if (child.exitCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* Already exited. */
          }
        }
      }),
  ).pipe(
    Effect.timeoutOrElse({duration: PROBE_TIMEOUT_MILLISECONDS, orElse: () => Effect.succeed('')}),
    Effect.orElseSucceed(() => ''),
  );
}

export function parseProcessCpuTime(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})(?:\.(\d+))?$/.exec(text);
  if (!match || Number(match[4]) >= 60 || (match[2] !== undefined && Number(match[3]) >= 60)) return undefined;
  const value =
    ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 3_600 + Number(match[3]) * 60 + Number(match[4])) * 1_000 +
    Number(`0.${match[5] ?? '0'}`) * 1_000;
  return finiteNonnegative(value) ? value : undefined;
}

export function parseDarwinProcessResources(
  output: string,
  processIds: readonly number[],
): ReadonlyMap<number, ProcessResourceCounters> {
  const selected = new Set(processIds);
  const rows = new Map<number, ProcessResourceCounters>();
  for (const line of EffectString.split(output, /\r?\n/)) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s*$/.exec(
        line,
      );
    if (!match) continue;
    const processId = Number(match[1]);
    const cpuMilliseconds = parseProcessCpuTime(match[3]);
    const rssBytes = Number(match[2]) * 1_024;
    if (!selected.has(processId) || cpuMilliseconds === undefined || !Number.isSafeInteger(rssBytes)) continue;
    rows.set(processId, {processId, cpuMilliseconds, rssBytes, processStartIdentity: `darwin-v2:${match[4]}`});
  }
  return rows;
}

export function parseLinuxProcessResources(
  stat: string,
  processId: number,
  ticks: number,
  pageBytes: number,
): ProcessResourceCounters | undefined {
  if (
    !pipe(stat, EffectString.startsWith(`${processId} (`)) ||
    !Number.isSafeInteger(ticks) ||
    ticks <= 0 ||
    !Number.isSafeInteger(pageBytes) ||
    pageBytes <= 0
  )
    return undefined;
  const end = Option.getOrElse(pipe(stat, EffectString.lastIndexOf(')')), () => -1);
  if (end < 0) return undefined;
  const fields = pipe(stat, EffectString.slice(end + 1), EffectString.trim, EffectString.split(/\s+/));
  const user = Number(fields[11]);
  const kernel = Number(fields[12]);
  const start = fields[19];
  const rssBytes = Number(fields[21]) * pageBytes;
  if (
    !start ||
    !/^\d+$/.test(start) ||
    !Number.isSafeInteger(user) ||
    user < 0 ||
    !Number.isSafeInteger(kernel) ||
    kernel < 0 ||
    !Number.isSafeInteger(rssBytes) ||
    rssBytes < 0
  )
    return undefined;
  const cpuMilliseconds = ((user + kernel) / ticks) * 1_000;
  return finiteNonnegative(cpuMilliseconds)
    ? {processId, processStartIdentity: `linux:${start}`, cpuMilliseconds, rssBytes}
    : undefined;
}

export function parseWindowsProcessResources(
  output: string,
  processIds: readonly number[],
): ReadonlyMap<number, ProcessResourceCounters> {
  const result = new Map<number, ProcessResourceCounters>();
  try {
    const parsed: unknown = JSON.parse(output);
    const rows = EffectArray.isArray(parsed) ? parsed : [parsed];
    const selected = new Set(processIds);
    for (const row of rows) {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('pid' in row) ||
        !('cpu' in row) ||
        !('rss' in row) ||
        !('start' in row)
      )
        continue;
      if (
        typeof row.pid !== 'number' ||
        !selected.has(row.pid) ||
        typeof row.cpu !== 'number' ||
        !finiteNonnegative(row.cpu) ||
        typeof row.rss !== 'number' ||
        !Number.isSafeInteger(row.rss) ||
        row.rss < 0 ||
        typeof row.start !== 'string' ||
        !/^\d{1,20}$/.test(row.start)
      )
        continue;
      result.set(row.pid, {
        processId: row.pid,
        processStartIdentity: `win32:${row.start}`,
        cpuMilliseconds: row.cpu,
        rssBytes: row.rss,
      });
    }
  } catch {
    /* Missing or malformed observations are unavailable. */
  }
  return result;
}

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
