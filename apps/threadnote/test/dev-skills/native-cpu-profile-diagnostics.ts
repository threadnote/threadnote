import {Config, Effect, Option} from 'effect';
import type {SamplingProfile, SamplingProfileStackFrame} from 'bun:jsc';

export const nativeCpuPacketPrefix = 'NATIVE_AUTHORING_CPU_DIAGNOSTICS ';
export const nativeCpuLimits = {
  traces: 65_536,
  frames: 32,
  keys: 4096,
  self: 256,
  application: 256,
  dependency: 128,
  bytes: 196_608,
} as const;
type Frame = SamplingProfileStackFrame;
type Row = {file: string; name: string; line: number; samples: number};
type Location = Omit<Row, 'samples'>;
const other: Location = {file: 'OTHER', name: 'OTHER', line: 0};
const root = decodeURIComponent(new URL('../../../../', import.meta.url).pathname).replace(/^\/([A-Za-z]:\/)/u, '$1');
const nativeNames: Readonly<Record<string, string>> = {
  stringify: 'STRINGIFY',
  parse: 'PARSE',
  gzipSync: 'GZIP',
  encode: 'ENCODE',
  toBase64: 'BASE64',
  CryptoHasher: 'HASH_CONSTRUCTOR',
  update: 'UPDATE',
  digest: 'DIGEST',
  entries: 'ENTRIES',
  cloneObject: 'CLONE_OBJECT',
  profile: 'PROFILER',
  all: 'ALL',
  get: 'GET',
  run: 'RUN',
  prepare: 'PREPARE',
  open: 'OPEN',
  close: 'CLOSE',
  readFileSync: 'READ_FILE_SYNC',
  writeFileSync: 'WRITE_FILE_SYNC',
  openSync: 'OPEN_SYNC',
  statSync: 'STAT_SYNC',
  renameSync: 'RENAME_SYNC',
  fsyncSync: 'FSYNC_SYNC',
};
const isNative = (frame?: Frame) =>
  !!frame &&
  !frame.sourceURL &&
  frame.sourceID === 4_294_967_295 &&
  (frame.category === 'Unknown Executable' || frame.category === 'Host');
const location = (frame?: Frame): Location => {
  if (!frame?.sourceURL)
    return frame && isNative(frame) && Object.hasOwn(nativeNames, frame.name)
      ? {file: 'NATIVE', name: nativeNames[frame.name], line: 0}
      : other;
  let path: string;
  try {
    const source = frame.sourceURL;
    if (source.startsWith('file:')) {
      const url = new URL(source);
      if (url.host || url.search || url.hash) return other;
      path = decodeURIComponent(url.pathname);
    } else path = source;
  } catch {
    return other;
  }
  path = path.replaceAll('\\', '/').replace(/^\/([A-Za-z]:\/)/u, '$1');
  const inside =
    process.platform === 'win32' ? path.toLowerCase().startsWith(root.toLowerCase()) : path.startsWith(root);
  if (!inside) return other;
  const file = path.slice(root.length).replace(/^node_modules\/\.bun\/[^/]+\/node_modules\//u, 'node_modules/');
  if (
    file.length > 160 ||
    !/^(?:apps\/threadnote\/|packages\/|node_modules\/(?:@effect\/|effect\/|fflate\/|vitest\/|@vitest\/|vite\/))/u.test(
      file,
    ) ||
    file.split('/').some(part => part === '..' || part === '.' || !part) ||
    !/^[\w./@-]+$/u.test(file)
  )
    return other;
  return {
    file,
    name: (frame.name || 'anonymous').replace(/[^\w$<>.:-]/gu, '_').slice(0, 64),
    line: Number.isSafeInteger(frame.line) && frame.line > 0 && frame.line < 10_000_000 ? frame.line : 0,
  };
};

// Only qualified source-less CLOSE heads are partitioned; sampled ancestry is not exclusive cost.
export const summarizeNativeCpu = (profile: Pick<SamplingProfile, 'stackTraces'>) => {
  const traces = profile.stackTraces.traces;
  const maps = {self: new Map<string, Row>(), application: new Map<string, Row>(), dependency: new Map<string, Row>()};
  const omissions = {
    traces: Math.max(0, traces.length - nativeCpuLimits.traces),
    frames: 0,
    keys: {self: 0, application: 0, dependency: 0},
    rows: {self: 0, application: 0, dependency: 0},
    samples: {self: 0, application: 0, dependency: 0},
  };
  const close = {
    nativeCloseTotal: 0,
    closeDriverAndRecallObserved: 0,
    closeDriverObservedRecallUnknown: 0,
    closeDriverUnknown: 0,
    missingContext: 0,
    rejectedContext: 0,
    truncatedContext: 0,
  };
  const context = {applicationUnknown: 0, dependencyUnknown: 0, empty: 0, rejected: 0, truncated: 0};
  const add = (table: keyof typeof maps, value: Location) => {
    const rows = maps[table];
    let key = JSON.stringify(value);
    // Reserve OTHER so key overflow never exceeds the cap.
    if (!rows.has(key) && rows.size >= nativeCpuLimits.keys - 1 && value !== other) {
      omissions.keys[table]++;
      value = other;
      key = JSON.stringify(value);
    }
    const prior = rows.get(key);
    if (prior) prior.samples++;
    else rows.set(key, {...value, samples: 1});
  };
  const analyzedTraces = Math.min(traces.length, nativeCpuLimits.traces);
  for (let index = 0; index < analyzedTraces; index++) {
    const frames = traces[index].frames;
    const head = location(frames[0]);
    add('self', head);
    let application: Location | undefined;
    let dependency: Location | undefined;
    let driver = false;
    let recall = false;
    let rejected = false;
    const truncated = frames.length > nativeCpuLimits.frames;
    omissions.frames += Math.max(0, frames.length - nativeCpuLimits.frames);
    for (let frame = 0; frame < Math.min(frames.length, nativeCpuLimits.frames); frame++) {
      const candidate = location(frames[frame]);
      if (/^(?:apps\/|packages\/)/u.test(candidate.file)) application ??= candidate;
      if (candidate.file.startsWith('node_modules/')) dependency ??= candidate;
      driver ||= /^node_modules\/@effect\/sql-sqlite-bun\/(?:dist\/SqliteClient\.js|src\/SqliteClient\.ts)$/u.test(
        candidate.file,
      );
      recall ||= /^packages\/recall\/src\/index\/database\.(?:ts|js)$/u.test(candidate.file);
      rejected ||= !!frames[frame].sourceURL && candidate === other;
    }
    add('application', application ?? other);
    add('dependency', dependency ?? other);
    context.applicationUnknown += Number(!application);
    context.dependencyUnknown += Number(!dependency);
    context.empty += Number(frames.length === 0);
    context.rejected += Number(rejected);
    context.truncated += Number(truncated);
    if (head.file === 'NATIVE' && head.name === 'CLOSE') {
      close.nativeCloseTotal++;
      if (driver && recall) close.closeDriverAndRecallObserved++;
      else if (driver) close.closeDriverObservedRecallUnknown++;
      else close.closeDriverUnknown++;
      close.missingContext += Number(frames.length <= 1);
      close.rejectedContext += Number(rejected);
      close.truncatedContext += Number(truncated);
    }
  }
  const top = (table: keyof typeof maps, cap: number) => {
    const rows = [...maps[table].values()].sort(
      (a, b) => b.samples - a.samples || JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
    const omitted = rows.slice(cap);
    omissions.rows[table] = omitted.length;
    omissions.samples[table] = omitted.reduce((sum, row) => sum + row.samples, 0);
    return rows.slice(0, cap);
  };
  const summary = {
    totalTraces: traces.length,
    analyzedTraces,
    close,
    context,
    omissions,
    self: top('self', nativeCpuLimits.self),
    application: top('application', nativeCpuLimits.application),
    dependency: top('dependency', nativeCpuLimits.dependency),
  };
  // All tables share one UTF-8 budget; count every dropped row and its samples.
  const bytes = () => Buffer.byteLength(JSON.stringify(summary));
  while (bytes() > nativeCpuLimits.bytes - 2048) {
    const table = (['self', 'application', 'dependency'] as const).reduce((a, b) =>
      summary[a].length >= summary[b].length ? a : b,
    );
    const row = summary[table].pop();
    if (!row) throw new Error('CPU summary metadata exceeds cap');
    omissions.rows[table]++;
    omissions.samples[table] += row.samples;
  }
  return summary;
};

export type NativeCpuProfiler = (complete: () => Promise<void>, interval: number) => Promise<SamplingProfile>;
export type NativeCpuOptions = {
  enabled?: boolean;
  load?: () => Promise<NativeCpuProfiler>;
  flushMs?: number;
  startupMs?: number;
};
type Status =
  | 'captured'
  | 'insufficient'
  | 'overlap'
  | 'conflict'
  | 'unavailable'
  | 'profile-failed'
  | 'flush-timeout'
  | 'export-failed';
export type NativeCpuPacket = {
  version: 1;
  role: 'native-fixture-cpu';
  api: 'bun:jsc.profile';
  scope: 'provided-native-scope-includes-acquisition-body-finalization';
  pid: number;
  session: number;
  bun: string;
  revision: string;
  intervalMicros: 10000;
  status: Status;
  outcome: 'Success' | 'Failure';
  flushMs: number;
  summary?: ReturnType<typeof summarizeNativeCpu>;
};
let active: object | undefined;
let sequence = 0;
export const captureNativeCpu = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  sink: (packet: NativeCpuPacket) => void,
  options: NativeCpuOptions = {},
): Effect.Effect<A, E, R> => {
  // No import, allocation, owner, timer or clock read in the ordinary path.
  if (!(options.enabled ?? process.env.THREADNOTE_NATIVE_CPU_PROFILE === '1')) return program;
  return Effect.gen(function* () {
    const environment = Option.getOrUndefined(
      yield* Config.all({
        profiler: Config.String('BUN_CPU_PROFILE').pipe(Config.withDefault('')),
        options: Config.String('BUN_OPTIONS').pipe(Config.withDefault('')),
      }).pipe(Effect.option),
    );
    const base = {
      version: 1 as const,
      role: 'native-fixture-cpu' as const,
      api: 'bun:jsc.profile' as const,
      scope: 'provided-native-scope-includes-acquisition-body-finalization' as const,
      pid: process.pid,
      session: ++sequence,
      intervalMicros: 10000 as const,
      bun: typeof Bun === 'undefined' ? 'unavailable' : Bun.version.replace(/[^\w.+-]/gu, '_').slice(0, 32),
      revision: typeof Bun !== 'undefined' && /^[a-f\d]{7,64}$/u.test(Bun.revision) ? Bun.revision : 'unavailable',
    };
    return yield* Effect.acquireUseRelease(
      Effect.promise(async () => {
        if (!environment) return {status: 'unavailable' as const};
        if (active) return {status: 'overlap' as const};
        if (
          process.execArgv.some(arg => arg.startsWith('--cpu-prof')) ||
          (!!environment.profiler && environment.profiler !== '0') ||
          environment.options.includes('--cpu-prof')
        )
          return {status: 'conflict' as const};
        const token = {};
        active = token;
        const complete = Promise.withResolvers<void>();
        let startupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const configured = options.startupMs ?? 5000;
          const wait = Number.isFinite(configured) ? Math.max(1, Math.min(5000, configured)) : 5000;
          const profiler = await Promise.race([
            options.load?.() ??
              import('bun:jsc').then(
                module => (done: () => Promise<void>, interval: number) => module.profile(done, interval),
              ),
            new Promise<undefined>(resolve => {
              startupTimer = setTimeout(() => resolve(undefined), wait);
            }),
          ]);
          if (!profiler) {
            complete.resolve();
            if (active === token) active = undefined;
            return {status: 'unavailable' as const};
          }
          // A late loader only settles the losing Promise; it can never invoke a profiler.
          const result = Promise.resolve(profiler(() => complete.promise, base.intervalMicros)).then(
            value => {
              if (active === token) active = undefined;
              return {status: 'captured' as const, value};
            },
            () => {
              if (active === token) active = undefined;
              return {status: 'profile-failed' as const};
            },
          );
          return {status: 'started' as const, complete: complete.resolve, result};
        } catch {
          complete.resolve();
          if (active === token) active = undefined;
          return {status: 'unavailable' as const};
        } finally {
          if (startupTimer !== undefined) clearTimeout(startupTimer);
        }
      }),
      () => program,
      (session, exit) =>
        Effect.promise(async () => {
          let status: Status = 'unavailable';
          let summary: NativeCpuPacket['summary'];
          let timer: ReturnType<typeof setTimeout> | undefined;
          const started = performance.now();
          try {
            if (session.status === 'started') {
              session.complete(); // Resolve, never reject, on success/error/defect/interruption.
              const configured = options.flushMs ?? 5000;
              const wait = Number.isFinite(configured) ? Math.max(1, Math.min(5000, configured)) : 5000;
              const result = await Promise.race([
                session.result,
                new Promise<{status: 'flush-timeout'}>(resolve => {
                  timer = setTimeout(() => resolve({status: 'flush-timeout'}), wait);
                }),
              ]);
              status = result.status;
              if (result.status === 'captured') {
                summary = summarizeNativeCpu(result.value);
                if (!summary.analyzedTraces) status = 'insufficient';
              }
            } else status = session.status;
          } catch {
            status = 'export-failed';
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          try {
            sink({
              ...base,
              status,
              outcome: exit._tag,
              flushMs: Math.max(0, Math.round(performance.now() - started)),
              ...(summary ? {summary} : {}),
            });
          } catch {
            /* An observer must never replace the original Exit. */
          }
          // A timed-out profiler retains its owner until its Promise settles: no overlapping retry.
        }).pipe(Effect.ignoreCause),
    );
  });
};
