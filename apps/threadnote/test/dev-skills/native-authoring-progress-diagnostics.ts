import {Config, Context, Effect, Exit, type FileSystem, Option, Tracer} from 'effect';
import type {ResourceStoreShape} from '@threadnote/store/resource-store';
import type {SamplingProfile, SamplingProfileStackFrame} from 'bun:jsc';

// Test-only vocabulary: fixed primitive refresh counters and a fixed commit-event timestamp only.
// Input, output, arbitrary attributes, IDs, paths and errors never enter this recorder.
export const nativeProgressBoundaries = [
  'init',
  'authoring-save',
  'authoring-load-document',
  'authoring-load',
  'authoring-read',
  'inspect',
  'other',
  'fixture-raw-store-read',
  'fixture-state-read',
] as const;
export type NativeProgressBoundary = (typeof nativeProgressBoundaries)[number];
export const nativeProgressSpanLabels = [
  ...nativeProgressBoundaries.map(label => `native.progress.${label}`),
  'workflowAutomation.run',
  'workflowAutomation.bound',
  'workflowAutomation.save',
  'workflowAutomation.readState',
  'workflowAutomation.writeState',
  'workflowAutomation.inspectNative',
  'workflowMemory.readJournalFile',
  'workflowMemory.writeJournalFile',
  'workflowMemory.inspectJournal',
  'workflowMemory.reconcileManifest',
  'workflowMemory.prepareOperation',
  'workflowMemory.executeOperation',
  'workflowMemory.verifyBinding',
  'recall.resolveMemoryIdentityAliases',
  'recall.loadMemoryIdentities',
  'recall.executeIndexQuery',
  'recall.acquireDatabase',
  'recall.closeDatabase',
  'recall.databaseBody',
  'recall.initializeDatabase',
  'recall.initializeIdentityIndex',
  'recall.selectIndexData',
  'recall.loadIdentityConflicts',
  'recall.ensureDatabaseFresh',
  'recall.scanSources',
  'recall.refreshDatabase',
  'recall.assembleRefreshSources',
  'recall.hashRefreshGeneration',
  'recall.writeRefresh',
  'recall.writeRefreshBody',
  'recall.rebuildIdentityConflicts',
  'recall.resolveLegacyMemoryLinks',
  'recall.refreshDerivedIndexesAfterCanonicalMutation',
  'external.loadAccess',
  'runCommandEffect',
  'CommandExecutor.execute',
] as const;
const selectedLabels = new Set<string>(nativeProgressSpanLabels);
export const nativeCommandPhases = ['prepare', 'finish', 'graph-ready', 'OTHER'] as const;
export const nativeCommandCohorts = [
  'projection',
  'native-preflight',
  'lower-prepare',
  'execute',
  'binding',
  'capture',
  'OTHER',
] as const;
type CommandPhase = (typeof nativeCommandPhases)[number];
type CommandCohort = (typeof nativeCommandCohorts)[number];
type CommandAncestor = {
  phase?: CommandPhase;
  kind?: 'projection' | 'prepare' | 'execute' | 'save' | 'binding' | 'capture';
};
const commandAncestorLabels = new Map<string, CommandAncestor>([
  ['closeout.stage.prepare', {phase: 'prepare'}],
  ['closeout.stage.finish', {phase: 'finish'}],
  ['closeout.stage.graph-ready', {phase: 'graph-ready'}],
  ['workflowAutomation.projectCloseoutKnowledge', {kind: 'projection'}],
  ['workflowMemory.prepareOperation', {kind: 'prepare'}],
  ['workflowMemory.executeOperation', {kind: 'execute'}],
  ['workflowAutomation.save', {kind: 'save'}],
  ['workflowMemory.verifyBinding', {kind: 'binding'}],
  ['workflowMemory.resolveBinding', {kind: 'binding'}],
  ['memoryCodeCitation.capture', {kind: 'capture'}],
  ['memoryCodeCitation.captureRepositoryGroup', {kind: 'capture'}],
]);
const commandCohort = (parent: Option.Option<Tracer.AnySpan>, known: WeakMap<Tracer.Span, CommandAncestor>) => {
  try {
    let ancestor = parent;
    let phase: CommandPhase | undefined;
    const kinds = new Set<CommandAncestor['kind']>();
    for (let depth = 0; depth < 64 && Option.isSome(ancestor); depth++) {
      if (ancestor.value._tag !== 'Span') {
        ancestor = Option.none();
        break;
      }
      const selected = known.get(ancestor.value);
      phase ??= selected?.phase;
      if (selected?.kind) kinds.add(selected.kind);
      ancestor = ancestor.value.parent;
    }
    if (Option.isSome(ancestor)) return {phase: 'OTHER', cohort: 'OTHER'} as const;
    const cohort: CommandCohort = kinds.has('binding')
      ? 'binding'
      : kinds.has('projection')
        ? 'projection'
        : kinds.has('prepare') && kinds.has('execute')
          ? 'lower-prepare'
          : kinds.has('prepare') && kinds.has('save')
            ? 'native-preflight'
            : kinds.has('execute')
              ? 'execute'
              : kinds.has('capture')
                ? 'capture'
                : 'OTHER';
    return {phase: phase ?? 'OTHER', cohort};
  } catch {
    return {phase: 'OTHER', cohort: 'OTHER'} as const;
  }
};
const ceiling = 2_147_483_647;
const bounded = (n: number) => (Number.isNaN(n) ? 0 : Math.min(ceiling, Math.max(0, Math.round(n))));
const safely = (observe: () => void) => {
  try {
    observe();
  } catch {
    /* Diagnostics cannot change execution. */
  }
};
type Outcome = 'Success' | 'Failure';
type BoundaryRecord = {
  label: NativeProgressBoundary;
  sequence: number;
  outcome: Outcome | 'Started';
  elapsedMs: number;
};
type SpanRecord = {label: string; sequence: number; startedMs: number};
type SpanEnd = SpanRecord & {outcome: Outcome; inclusiveMs: number};
type Counts = {started: number; succeeded: number; failed: number};
type RefreshTransaction = {
  start: bigint;
  invalid: boolean;
  body?: {start: bigint; end?: bigint; succeeded?: boolean};
};
const transactionIntervals = (span: Tracer.Span, transaction: RefreshTransaction, end: bigint) => {
  try {
    const body = transaction.body;
    if (transaction.invalid || !body?.succeeded || body.end === undefined || !(span instanceof Tracer.NativeSpan))
      return undefined;
    const events = span.events;
    if (events.length > 4) return undefined;
    let commit: bigint | undefined;
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (event[0] !== 'effect.sql.transaction.commit') continue;
      if (commit !== undefined || typeof event[1] !== 'bigint') return undefined;
      commit = event[1];
    }
    if (
      commit === undefined ||
      transaction.start > body.start ||
      body.start > body.end ||
      body.end > commit ||
      commit > end
    )
      return undefined;
    const milliseconds = (duration: bigint) => bounded(Number(duration) / 1_000_000);
    return {
      acquireAndBeginMs: milliseconds(body.start - transaction.start),
      bodyMs: milliseconds(body.end - body.start),
      preCommitMs: milliseconds(commit - body.end),
      commitAndReleaseMs: milliseconds(end - commit),
    };
  } catch {
    return undefined;
  }
};
const refreshBucket = () => ({count: 0, scannedSources: 0, changedSources: 0, removedSources: 0, maxChangedSources: 0});
const refreshDecision = (span: Tracer.Span) => {
  const forceAllSources = span.attributes.get('recall.refresh.forceAllSources');
  const forceRefresh = span.attributes.get('recall.refresh.forceRefresh');
  const forceFromMarker = span.attributes.get('recall.refresh.forceFromMarker');
  const canonicalMutationChanged = span.attributes.get('recall.refresh.canonicalMutationChanged');
  const continuityAllowed = span.attributes.get('recall.refresh.continuityAllowed');
  const scannedSources = span.attributes.get('recall.refresh.scannedSources');
  const changedSources = span.attributes.get('recall.refresh.changedSources');
  const removedSources = span.attributes.get('recall.refresh.removedSources');
  if (
    typeof forceAllSources !== 'boolean' ||
    typeof forceRefresh !== 'boolean' ||
    typeof forceFromMarker !== 'boolean' ||
    typeof canonicalMutationChanged !== 'boolean' ||
    typeof continuityAllowed !== 'boolean' ||
    typeof scannedSources !== 'number' ||
    typeof changedSources !== 'number' ||
    typeof removedSources !== 'number' ||
    ![scannedSources, changedSources, removedSources].every(value => Number.isInteger(value) && value >= 0)
  )
    return undefined;
  return {
    forceAllSources,
    forceRefresh,
    forceFromMarker,
    canonicalMutationChanged,
    continuityAllowed,
    scannedSources: bounded(scannedSources),
    changedSources: bounded(changedSources),
    removedSources: bounded(removedSources),
  };
};

export const classifyNativeProgress = (input: unknown): NativeProgressBoundary => {
  try {
    if (typeof input !== 'object' || input === null) return 'other';
    const own = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    };
    const action = own('action');
    if (action === 'init' || action === 'inspect') return action;
    if (action !== 'authoring') return 'other';
    switch (own('command')) {
      case 'save':
        return 'authoring-save';
      case 'load':
        return own('detail') === 'document' ? 'authoring-load-document' : 'authoring-load';
      case 'read':
        return 'authoring-read';
      default:
        return 'other';
    }
  } catch {
    return 'other';
  }
};

type CpuProfiler = (complete: () => Promise<void>, interval: number) => Promise<SamplingProfile>;
type CpuOptions = {enabled?: boolean; load?: () => Promise<CpuProfiler>; flushMs?: number};
type CpuRow = {file: string; name: string; line: number; samples: number};
let activeCpuSession: object | undefined;
let cpuSequence = 0;
const cpuRoot = decodeURIComponent(new URL('../../../../', import.meta.url).pathname).replace(
  /^\/([A-Za-z]:\/)/u,
  '$1',
);
const cpuOther = {file: 'OTHER', name: 'OTHER', line: 0};
const cpuNativeNames: Readonly<Record<string, string>> = {
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
const cpuNative = (frame?: SamplingProfileStackFrame): boolean =>
  !!frame &&
  !frame.sourceURL &&
  frame.sourceID === 4_294_967_295 &&
  (frame.category === 'Unknown Executable' || frame.category === 'Host');
const cpuFrame = (frame?: SamplingProfileStackFrame): Omit<CpuRow, 'samples'> => {
  const source = frame?.sourceURL;
  if (!source) {
    if (frame && cpuNative(frame) && Object.hasOwn(cpuNativeNames, frame.name))
      return {file: 'NATIVE', name: cpuNativeNames[frame.name], line: 0};
    return cpuOther;
  }
  let path: string;
  try {
    path = source.startsWith('file:') ? decodeURIComponent(new URL(source).pathname) : source;
  } catch {
    return cpuOther;
  }
  path = path.replaceAll('\\', '/').replace(/^\/([A-Za-z]:\/)/u, '$1');
  const inside =
    process.platform === 'win32' ? path.toLowerCase().startsWith(cpuRoot.toLowerCase()) : path.startsWith(cpuRoot);
  if (!inside) return cpuOther;
  const file = path.slice(cpuRoot.length).replace(/^node_modules\/\.bun\/[^/]+\/node_modules\//u, 'node_modules/');
  if (
    !/^(?:apps\/threadnote\/|packages\/|node_modules\/(?:@effect\/|effect\/|fflate\/|vitest\/|@vitest\/|vite\/))/u.test(
      file,
    ) ||
    file.split('/').includes('..') ||
    !/^[\w./@-]+$/u.test(file)
  )
    return cpuOther;
  return {
    file: file.slice(0, 160),
    name: (frame.name || 'anonymous').replace(/[^\w$<>.:-]/gu, '_').slice(0, 64),
    line: Number.isSafeInteger(frame.line) && frame.line > 0 && frame.line < 10_000_000 ? frame.line : 0,
  };
};
const summarizeCpu = (profile: SamplingProfile) => {
  const traces = profile.stackTraces.traces;
  const self = new Map<string, CpuRow>();
  const callers = new Map<string, CpuRow>();
  const selfSources = {empty: 0, sourceful: 0, sourceLessNative: 0, sourceLessBuiltin: 0, sourceLessOther: 0};
  const selfCategories = {LLInt: 0, Baseline: 0, DFG: 0, FTL: 0, Host: 0, UnknownExecutable: 0, OTHER: 0};
  const callerKinds = {
    application: 0,
    dependencyOnly: 0,
    rejectedSourceOnly: 0,
    sourceLessOnly: 0,
    empty: 0,
    truncatedWithoutApplication: 0,
  };
  let keysOmitted = 0;
  let framesOmitted = 0;
  const add = (rows: Map<string, CpuRow>, frame: Omit<CpuRow, 'samples'>) => {
    let key = JSON.stringify(frame);
    if (!rows.has(key) && rows.size >= 4095) {
      frame = cpuOther;
      key = JSON.stringify(frame);
      keysOmitted++;
    }
    const row = rows.get(key);
    if (row) row.samples++;
    else rows.set(key, {...frame, samples: 1});
  };
  const analyzed = Math.min(traces.length, 65_536);
  for (let index = 0; index < analyzed; index++) {
    const frames = traces[index].frames;
    const head = frames[0];
    add(self, cpuFrame(head));
    if (!head) selfSources.empty++;
    else if (head.sourceURL) selfSources.sourceful++;
    else if (cpuNative(head)) selfSources.sourceLessNative++;
    else if (head.flags === 1) selfSources.sourceLessBuiltin++;
    else selfSources.sourceLessOther++;
    switch (head?.category) {
      case 'LLInt':
      case 'Baseline':
      case 'DFG':
      case 'FTL':
      case 'Host':
        selfCategories[head.category]++;
        break;
      case 'Unknown Executable':
        selfCategories.UnknownExecutable++;
        break;
      default:
        selfCategories.OTHER++;
    }
    let caller = cpuOther;
    let dependency = false;
    let rejectedSource = false;
    framesOmitted = bounded(framesOmitted + Math.max(0, frames.length - 32));
    for (let frame = 0; frame < Math.min(frames.length, 32); frame++) {
      const candidate = cpuFrame(frames[frame]);
      if (/^(?:apps\/|packages\/)/u.test(candidate.file)) {
        caller = candidate;
        break;
      }
      dependency ||= candidate.file.startsWith('node_modules/');
      rejectedSource ||= !!frames[frame].sourceURL && candidate.file === 'OTHER';
    }
    add(callers, caller);
    const callerKind =
      caller !== cpuOther
        ? 'application'
        : frames.length > 32
          ? 'truncatedWithoutApplication'
          : dependency
            ? 'dependencyOnly'
            : rejectedSource
              ? 'rejectedSourceOnly'
              : frames.length
                ? 'sourceLessOnly'
                : 'empty';
    callerKinds[callerKind]++;
  }
  const top = (rows: Map<string, CpuRow>) => [...rows.values()].sort((a, b) => b.samples - a.samples).slice(0, 16);
  return {
    selfRowsOmitted: Math.max(0, self.size - 16),
    callerRowsOmitted: Math.max(0, callers.size - 16),
    totalTraces: bounded(traces.length),
    analyzedTraces: analyzed,
    tracesOmitted: bounded(traces.length - analyzed),
    framesOmitted,
    keysOmitted,
    selfSources,
    selfCategories,
    callerKinds,
    self: top(self),
    callers: top(callers),
  };
};
type CpuSummary = ReturnType<typeof summarizeCpu>;
type CpuPacket = Partial<CpuSummary> & {
  version: 1;
  role: 'native-fixture-cpu';
  api: 'bun:jsc.profile';
  pid: number;
  session: number;
  bun: string;
  revision: string;
  cliConflict: boolean;
  envConflict: boolean;
  intervalMicros: number;
  status: 'captured' | 'overlap' | 'conflict' | 'unavailable' | 'profile-failed' | 'flush-timeout' | 'export-failed';
  flushMs?: number;
  rowsOmitted?: number;
};
const captureNativeCpu = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  observer: NativeProgressDiagnostics,
  options: CpuOptions,
) =>
  Effect.gen(function* () {
    const enabled =
      options.enabled ??
      (yield* Config.String('THREADNOTE_NATIVE_CPU_PROFILE').pipe(
        Config.withDefault(''),
        Effect.orElseSucceed(() => ''),
      )) === '1';
    if (!enabled) return yield* program;
    const environment = Option.getOrUndefined(
      yield* Config.all({
        profiler: Config.String('BUN_CPU_PROFILE').pipe(Config.withDefault('')),
        options: Config.String('BUN_OPTIONS').pipe(Config.withDefault('')),
      }).pipe(Effect.option),
    );
    const base: CpuPacket = {
      version: 1,
      role: 'native-fixture-cpu',
      api: 'bun:jsc.profile',
      pid: process.pid,
      session: ++cpuSequence,
      bun: typeof Bun === 'undefined' ? 'unavailable' : Bun.version.replace(/[^\w.+-]/gu, '_').slice(0, 32),
      revision: typeof Bun !== 'undefined' && /^[a-f\d]{7,64}$/u.test(Bun.revision) ? Bun.revision : 'unavailable',
      cliConflict: process.execArgv.some(argument => argument.startsWith('--cpu-prof')),
      envConflict:
        !!environment &&
        (!!(environment.profiler && environment.profiler !== '0') || environment.options.includes('--cpu-prof')),
      intervalMicros: 10_000,
      status: 'unavailable',
    };
    return yield* Effect.acquireUseRelease(
      Effect.promise(async () => {
        if (!environment) return {status: 'unavailable' as const};
        if (activeCpuSession) return {status: 'overlap' as const};
        if (base.cliConflict || base.envConflict) return {status: 'conflict' as const};
        const token = {};
        activeCpuSession = token;
        const complete = Promise.withResolvers<void>();
        try {
          const profile = await (options.load?.() ??
            import('bun:jsc').then(
              module => (done: () => Promise<void>, interval: number) => module.profile(done, interval),
            ));
          const result = Promise.resolve(profile(() => complete.promise, base.intervalMicros)).then(
            value => {
              if (activeCpuSession === token) activeCpuSession = undefined;
              return {status: 'captured' as const, value};
            },
            () => {
              if (activeCpuSession === token) activeCpuSession = undefined;
              return {status: 'profile-failed' as const};
            },
          );
          return {status: 'started' as const, complete: complete.resolve, result};
        } catch {
          complete.resolve();
          if (activeCpuSession === token) activeCpuSession = undefined;
          return {status: 'unavailable' as const};
        }
      }),
      () => program,
      (session, exit) =>
        Effect.promise(async () => {
          let packet: CpuPacket = base;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const started = performance.now();
          try {
            if (session.status === 'started') {
              // Resolve on every Exit: rejecting this Promise would discard JSC's data.
              session.complete();
              const configured = options.flushMs ?? 5000;
              const wait = Number.isFinite(configured) ? Math.max(1, Math.min(5000, configured)) : 5000;
              const result = await Promise.race([
                session.result,
                new Promise<{status: 'flush-timeout'}>(resolve => {
                  timer = setTimeout(() => resolve({status: 'flush-timeout'}), wait);
                }),
              ]);
              packet = {...base, status: result.status};
              if (Exit.isFailure(exit) && result.status === 'captured')
                packet = {...packet, ...summarizeCpu(result.value)};
            } else packet = {...base, status: session.status};
          } catch {
            packet = {...base, status: 'export-failed'};
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          if (Exit.isFailure(exit)) observer.reportCpu({...packet, flushMs: bounded(performance.now() - started)});
        }).pipe(Effect.ignoreCause),
    );
  });

export const makeNativeProgressDiagnostics = (
  delegate: Tracer.Tracer,
  options: {
    now?: () => number;
    sink?: (line: string) => void;
    serialize?: (value: unknown) => string;
  } = {},
) => {
  const now = options.now ?? (() => performance.now());
  const sink =
    options.sink ??
    (line => {
      process.stderr.write(line + '\n');
    });
  const serialize = options.serialize ?? JSON.stringify;
  let lastClock = 0;
  const clock = () => {
    safely(() => {
      const next = now();
      if (Number.isFinite(next)) lastClock = Math.max(lastClock, next);
    });
    return lastClock;
  };
  const origin = clock();
  const elapsed = () => bounded(clock() - origin);
  const counters = Object.fromEntries(
    nativeProgressBoundaries.map(label => [label, {started: 0, succeeded: 0, failed: 0}]),
  ) as Record<NativeProgressBoundary, Counts>;
  const totals: Record<string, {started: number; ended: number; failed: number; inclusiveMs: number}> = {};
  const commandAncestors = new WeakMap<Tracer.Span, CommandAncestor>();
  const commandCohorts = Object.fromEntries(
    nativeCommandPhases.map(phase => [
      phase,
      Object.fromEntries(
        nativeCommandCohorts.map(cohort => [cohort, {started: 0, ended: 0, failed: 0, inclusiveMs: 0}]),
      ),
    ]),
  ) as Record<
    CommandPhase,
    Record<CommandCohort, {started: number; ended: number; failed: number; inclusiveMs: number}>
  >;
  const refreshWrites = new WeakSet<Tracer.Span>();
  const refreshTransactions = new WeakMap<Tracer.Span, RefreshTransaction>();
  const transactionBoundaries = {
    observed: 0,
    rejected: 0,
    acquireAndBeginMs: 0,
    bodyMs: 0,
    preCommitMs: 0,
    commitAndReleaseMs: 0,
  };
  const refreshDecisions = {
    observed: 0,
    forceRefresh: 0,
    forceFromMarker: 0,
    canonicalMutationChanged: 0,
    continuityMissing: 0,
    allSources: refreshBucket(),
    incremental: refreshBucket(),
  };
  const active = new Map<Tracer.Span, SpanRecord>();
  const recent: SpanEnd[] = [];
  let sequence = 0;
  let activeCount = 0;
  let recentDropped = 0;
  let historyReadsSucceeded = 0;
  let lastBoundary: BoundaryRecord | undefined;
  let bodyEntered = false;
  let bodyExited = false;
  let bodyStartedMs = 0;
  let bodyEndedMs = 0;
  let reported = false;
  const progress = () => ({
    counters: Object.fromEntries(nativeProgressBoundaries.map(label => [label, {...counters[label]}])),
    saveStarted: counters['authoring-save'].started,
    saveSucceeded: counters['authoring-save'].succeeded,
    historyReadsSucceeded,
    historyRule: 'inferred-from-fixture-boundaries-after-first-successful-state-read',
    lastBoundary: lastBoundary && {...lastBoundary},
  });
  let bodyExitSnapshot: ReturnType<typeof progress> | undefined;
  const tracer = Tracer.make({
    ...(delegate.context ? {context: delegate.context.bind(delegate)} : {}),
    span(spanOptions) {
      // Preserve the active backend and any observer already wrapping this exact span.
      const span = delegate.span.call(delegate, spanOptions);
      const selected = selectedLabels.has(spanOptions.name);
      let command: (typeof commandCohorts)[CommandPhase][CommandCohort] | undefined;
      let transaction: RefreshTransaction | undefined;
      let bodyTransaction: RefreshTransaction | undefined;
      safely(() => {
        const ancestry = commandAncestorLabels.get(spanOptions.name);
        if (ancestry) commandAncestors.set(span, ancestry);
        if (spanOptions.name === 'CommandExecutor.execute') {
          const classified = commandCohort(spanOptions.parent, commandAncestors);
          command = commandCohorts[classified.phase][classified.cohort];
          command.started = bounded(command.started + 1);
        }
        const parent = Option.getOrUndefined(spanOptions.parent);
        if (spanOptions.name === 'recall.writeRefresh') refreshWrites.add(span);
        if (parent?._tag !== 'Span') return;
        if (spanOptions.name === 'sql.transaction' && refreshWrites.has(parent)) {
          transaction = {start: spanOptions.startTime, invalid: false};
          refreshTransactions.set(span, transaction);
        } else if (spanOptions.name === 'recall.writeRefreshBody') {
          bodyTransaction = refreshTransactions.get(parent);
          if (!bodyTransaction) return;
          if (bodyTransaction.body) bodyTransaction.invalid = true;
          else bodyTransaction.body = {start: spanOptions.startTime};
        }
      });
      if (!selected && !transaction) return span;
      safely(() => {
        const total = selected
          ? (totals[spanOptions.name] ??= {started: 0, ended: 0, failed: 0, inclusiveMs: 0})
          : undefined;
        const entry = total
          ? {label: spanOptions.name, sequence: (sequence = bounded(sequence + 1)), startedMs: elapsed()}
          : undefined;
        if (total && entry) {
          total.started = bounded(total.started + 1);
          activeCount = bounded(activeCount + 1);
          if (active.size < 8) active.set(span, entry);
        }
        const end = span.end.bind(span);
        let ended = false;
        span.end = (at, exit) => {
          // Delegate every call first, with the exact timestamp and Exit; count once only afterward.
          end(at, exit);
          safely(() => {
            if (ended) return;
            ended = true;
            if (bodyTransaction?.body) {
              bodyTransaction.body.end = at;
              bodyTransaction.body.succeeded = Exit.isSuccess(exit);
            }
            if (transaction) {
              const intervals = Exit.isSuccess(exit) ? transactionIntervals(span, transaction, at) : undefined;
              if (intervals) {
                transactionBoundaries.observed = bounded(transactionBoundaries.observed + 1);
                transactionBoundaries.acquireAndBeginMs = bounded(
                  transactionBoundaries.acquireAndBeginMs + intervals.acquireAndBeginMs,
                );
                transactionBoundaries.bodyMs = bounded(transactionBoundaries.bodyMs + intervals.bodyMs);
                transactionBoundaries.preCommitMs = bounded(transactionBoundaries.preCommitMs + intervals.preCommitMs);
                transactionBoundaries.commitAndReleaseMs = bounded(
                  transactionBoundaries.commitAndReleaseMs + intervals.commitAndReleaseMs,
                );
              } else transactionBoundaries.rejected = bounded(transactionBoundaries.rejected + 1);
            }
            if (!total || !entry) return;
            activeCount = Math.max(0, activeCount - 1);
            active.delete(span);
            total.ended = bounded(total.ended + 1);
            if (Exit.isFailure(exit)) total.failed = bounded(total.failed + 1);
            const inclusiveMs = bounded(Number(at - spanOptions.startTime) / 1_000_000);
            total.inclusiveMs = bounded(total.inclusiveMs + inclusiveMs);
            if (command) {
              command.ended = bounded(command.ended + 1);
              command.failed = bounded(command.failed + Number(Exit.isFailure(exit)));
              command.inclusiveMs = bounded(command.inclusiveMs + inclusiveMs);
            }
            recent.push({...entry, inclusiveMs, outcome: exit._tag});
            if (recent.length > 32) {
              recent.shift();
              recentDropped = bounded(recentDropped + 1);
            }
            if (spanOptions.name === 'recall.refreshDatabase') {
              const decision = refreshDecision(span);
              if (!decision) return;
              refreshDecisions.observed = bounded(refreshDecisions.observed + 1);
              refreshDecisions.forceRefresh = bounded(refreshDecisions.forceRefresh + Number(decision.forceRefresh));
              refreshDecisions.forceFromMarker = bounded(
                refreshDecisions.forceFromMarker + Number(decision.forceFromMarker),
              );
              refreshDecisions.canonicalMutationChanged = bounded(
                refreshDecisions.canonicalMutationChanged + Number(decision.canonicalMutationChanged),
              );
              refreshDecisions.continuityMissing = bounded(
                refreshDecisions.continuityMissing + Number(!decision.continuityAllowed),
              );
              const bucket = decision.forceAllSources ? refreshDecisions.allSources : refreshDecisions.incremental;
              bucket.count = bounded(bucket.count + 1);
              bucket.scannedSources = bounded(bucket.scannedSources + decision.scannedSources);
              bucket.changedSources = bounded(bucket.changedSources + decision.changedSources);
              bucket.removedSources = bounded(bucket.removedSources + decision.removedSources);
              bucket.maxChangedSources = Math.max(bucket.maxChangedSources, decision.changedSources);
            }
          });
        };
      });
      return span;
    },
  });
  const observer = {
    tracer,
    start(label: NativeProgressBoundary) {
      counters[label].started = bounded(counters[label].started + 1);
      const entry: BoundaryRecord = {
        label,
        sequence: (sequence = bounded(sequence + 1)),
        outcome: 'Started',
        elapsedMs: elapsed(),
      };
      lastBoundary = entry;
      return entry;
    },
    end(entry: BoundaryRecord, outcome: Outcome) {
      const counts = counters[entry.label];
      if (outcome === 'Success') counts.succeeded = bounded(counts.succeeded + 1);
      else counts.failed = bounded(counts.failed + 1);
      if (
        entry.label === 'fixture-raw-store-read' &&
        outcome === 'Success' &&
        counters['fixture-state-read'].succeeded > 0
      )
        historyReadsSucceeded = bounded(historyReadsSucceeded + 1);
      lastBoundary = {...entry, outcome, elapsedMs: bounded(elapsed() - entry.elapsedMs)};
    },
    enterBody() {
      bodyEntered = true;
      bodyStartedMs = elapsed();
    },
    exitBody() {
      bodyExited = true;
      bodyEndedMs = elapsed();
      bodyExitSnapshot = progress();
    },
    snapshot() {
      const at = elapsed();
      return {
        version: 1,
        role: 'native-fixture-progress',
        bodyEntered,
        bodyExited,
        elapsedMs: at,
        bodyMs: bodyEntered ? bounded((bodyExited ? bodyEndedMs : at) - bodyStartedMs) : undefined,
        cleanupObservedMs: bodyExited ? bounded(at - bodyEndedMs) : undefined,
        clocks: {
          facades: 'diagnostic-monotonic-ms',
          activeAges: 'diagnostic-monotonic-ms',
          completedSpans: 'effect-native-timestamps-ns-to-inclusive-ms',
          spanTotals: 'inclusive-overlapping',
        },
        ...progress(),
        bodyExitSnapshot: bodyExitSnapshot && {
          ...bodyExitSnapshot,
          counters: Object.fromEntries(
            Object.entries(bodyExitSnapshot.counters).map(([label, counts]) => [label, {...counts}]),
          ),
          lastBoundary: bodyExitSnapshot.lastBoundary && {...bodyExitSnapshot.lastBoundary},
        },
        totals: Object.fromEntries(Object.entries(totals).map(([label, total]) => [label, {...total}])),
        refreshDecisions: {
          ...refreshDecisions,
          allSources: {...refreshDecisions.allSources},
          incremental: {...refreshDecisions.incremental},
        },
        transactionBoundaries: {...transactionBoundaries},
        commandCohorts: Object.fromEntries(
          nativeCommandPhases.map(phase => [
            phase,
            Object.fromEntries(nativeCommandCohorts.map(cohort => [cohort, {...commandCohorts[phase][cohort]}])),
          ]),
        ),
        activeCount,
        unlistedActiveCount: activeCount - active.size,
        active: [...active.values()].map(entry => ({...entry, ageMs: bounded(at - entry.startedMs)})),
        recent: recent.map(entry => ({...entry})),
        recentDropped,
      };
    },
    reportCpu(packet: CpuPacket) {
      safely(() => {
        const boundedPacket = {...packet, self: packet.self?.slice(), callers: packet.callers?.slice(), rowsOmitted: 0};
        let json = JSON.stringify(boundedPacket);
        while (
          new TextEncoder().encode(json).length > 16_000 &&
          (boundedPacket.self?.length || boundedPacket.callers?.length)
        ) {
          if (boundedPacket.callers?.length) boundedPacket.callers.pop();
          else boundedPacket.self?.pop();
          boundedPacket.rowsOmitted++;
          json = JSON.stringify(boundedPacket);
        }
        if (new TextEncoder().encode(json).length <= 16_000) sink('NATIVE_AUTHORING_CPU_DIAGNOSTICS ' + json);
      });
    },
    reportFailure() {
      if (reported) return;
      reported = true;
      safely(() => {
        const packet = {...observer.snapshot(), outerFailure: true};
        let json = serialize(packet);
        while (json.length > 16_000 && packet.recent.length > 0) {
          packet.recent.shift();
          packet.recentDropped = bounded(packet.recentDropped + 1);
          json = serialize(packet);
        }
        if (json.length <= 16_000) sink('NATIVE_AUTHORING_PROGRESS_DIAGNOSTICS ' + json);
      });
    },
  };
  return observer;
};
export type NativeProgressDiagnostics = ReturnType<typeof makeNativeProgressDiagnostics>;
export const CurrentNativeProgress = Context.Reference<NativeProgressDiagnostics | undefined>(
  'test/CurrentNativeProgress',
  {defaultValue: () => undefined},
);

export const observeNativeBoundary = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  observer: NativeProgressDiagnostics,
  label: NativeProgressBoundary,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let entry: ReturnType<NativeProgressDiagnostics['start']> | undefined;
    safely(() => {
      entry = observer.start(label);
    });
    return program.pipe(
      Effect.onExit(exit =>
        Effect.sync(() => {
          safely(() => {
            if (entry) observer.end(entry, exit._tag);
          });
        }),
      ),
    );
  }).pipe(Effect.withSpan(`native.progress.${label}`));

// Construct the original Effect once before classification/observation. A delegate throw stays a throw.
export const nativeProgressMethod =
  <S, Args extends unknown[], A, E, R>(
    service: S,
    method: (this: S, ...args: Args) => Effect.Effect<A, E, R>,
    classify: (...args: Args) => NativeProgressBoundary | undefined,
    observer: NativeProgressDiagnostics,
  ) =>
  (...args: Args): Effect.Effect<A, E, R> => {
    const program = method.apply(service, args);
    let label: NativeProgressBoundary | undefined;
    safely(() => {
      label = classify(...args);
    });
    return label ? observeNativeBoundary(program, observer, label) : program;
  };

export const observeNativeBody = <A, E, R>(program: Effect.Effect<A, E, R>, observer: NativeProgressDiagnostics) =>
  Effect.suspend(() => {
    safely(() => observer.enterBody());
    return program.pipe(Effect.onExit(() => Effect.sync(() => safely(() => observer.exitBody()))));
  });
export const reportNativeFailure = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  observer: NativeProgressDiagnostics,
  cpu: CpuOptions = {},
) =>
  captureNativeCpu(
    program.pipe(
      Effect.onExit(exit =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) safely(() => observer.reportFailure());
        }),
      ),
    ),
    observer,
    cpu,
  );

// These returned facades are never provided back into the application service graph.
const storeFacades = new WeakMap<NativeProgressDiagnostics, WeakMap<object, object>>();
const progressStore = <S extends Pick<ResourceStoreShape, 'read'>>(
  store: S,
  observer: NativeProgressDiagnostics,
): S => {
  let facades = storeFacades.get(observer);
  if (!facades) {
    facades = new WeakMap();
    storeFacades.set(observer, facades);
  }
  const existing = facades.get(store);
  if (existing) return existing as S;
  const facade = {...store, read: nativeProgressMethod(store, store.read, () => 'fixture-raw-store-read', observer)};
  facades.set(store, facade);
  return facade;
};
export const nativeProgressFacades = <
  S extends Pick<ResourceStoreShape, 'read'>,
  F extends Pick<FileSystem.FileSystem, 'readFileString'>,
>(
  store: S,
  fs: F,
  defaultStatePath: string,
  observer: NativeProgressDiagnostics | undefined,
): {store: S; fs: F} =>
  observer
    ? {
        store: progressStore(store, observer),
        fs: {
          ...fs,
          readFileString: nativeProgressMethod(
            fs,
            fs.readFileString,
            file => (file === defaultStatePath ? 'fixture-state-read' : undefined),
            observer,
          ),
        },
      }
    : {store, fs};
