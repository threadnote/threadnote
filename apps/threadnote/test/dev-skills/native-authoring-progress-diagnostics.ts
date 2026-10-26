import {Context, Effect, Exit, type FileSystem, Tracer} from 'effect';
import type {ResourceStoreShape} from '@threadnote/store/resource-store';

// Test-only vocabulary: input, output, attributes, IDs, paths and errors never enter this recorder.
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
  'recall.databaseBody',
  'recall.initializeDatabase',
  'recall.initializeIdentityIndex',
  'recall.selectIndexData',
  'recall.loadIdentityConflicts',
  'recall.ensureDatabaseFresh',
  'recall.scanSources',
  'recall.refreshDatabase',
  'recall.refreshDerivedIndexesAfterCanonicalMutation',
  'external.loadAccess',
  'runCommandEffect',
  'CommandExecutor.execute',
] as const;
const selectedLabels = new Set<string>(nativeProgressSpanLabels);
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
      if (!selectedLabels.has(spanOptions.name)) return span;
      safely(() => {
        const total = (totals[spanOptions.name] ??= {started: 0, ended: 0, failed: 0, inclusiveMs: 0});
        total.started = bounded(total.started + 1);
        const entry = {label: spanOptions.name, sequence: (sequence = bounded(sequence + 1)), startedMs: elapsed()};
        activeCount = bounded(activeCount + 1);
        if (active.size < 8) active.set(span, entry);
        const end = span.end.bind(span);
        let ended = false;
        span.end = (at, exit) => {
          // Delegate every call first, with the exact timestamp and Exit; count once only afterward.
          end(at, exit);
          safely(() => {
            if (ended) return;
            ended = true;
            activeCount = Math.max(0, activeCount - 1);
            active.delete(span);
            total.ended = bounded(total.ended + 1);
            if (Exit.isFailure(exit)) total.failed = bounded(total.failed + 1);
            const inclusiveMs = bounded(Number(at - spanOptions.startTime) / 1_000_000);
            total.inclusiveMs = bounded(total.inclusiveMs + inclusiveMs);
            recent.push({...entry, inclusiveMs, outcome: exit._tag});
            if (recent.length > 32) {
              recent.shift();
              recentDropped = bounded(recentDropped + 1);
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
        activeCount,
        unlistedActiveCount: activeCount - active.size,
        active: [...active.values()].map(entry => ({...entry, ageMs: bounded(at - entry.startedMs)})),
        recent: recent.map(entry => ({...entry})),
        recentDropped,
      };
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
export const reportNativeFailure = <A, E, R>(program: Effect.Effect<A, E, R>, observer: NativeProgressDiagnostics) =>
  program.pipe(
    Effect.onExit(exit =>
      Effect.sync(() => {
        if (Exit.isFailure(exit)) safely(() => observer.reportFailure());
      }),
    ),
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
