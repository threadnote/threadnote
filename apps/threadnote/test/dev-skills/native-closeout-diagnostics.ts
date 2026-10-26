import {Context, Effect, Option} from 'effect';
import {TestClock} from 'effect/testing';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {provideNative} from './native-automation-fixture.js';
import {closeoutSpanDiagnostics} from './native-closeout-span-diagnostics.js';

const stages = new Set([
  'application-scope',
  'body',
  'fixture',
  'provisioning',
  'fixture-git',
  'cloud-profile',
  'init',
  'save',
  'graph-ready',
  'read',
  'write',
  'load',
  'controller-state',
  'schema',
  'validation-input',
  'prepare',
  'finish',
  'inspect',
  'publication-preview',
  'status-before',
  'index',
  'status-after',
  'other',
]);
const bounded = (value: number) => Math.min(2_147_483_647, Math.max(0, Math.round(value)));
type Entry = {sequence: number; stage: string; startedMs: number};

/** Test-only observer: closed labels, no request values or error messages. */
export const closeoutDiagnostics = (now = () => performance.now()) => {
  const spans = closeoutSpanDiagnostics(now);
  let origin: number | undefined;
  let previousElapsed = 0;
  const elapsed = () => {
    try {
      const at = now();
      if (Number.isFinite(at)) {
        origin ??= at;
        previousElapsed = Math.max(previousElapsed, bounded(at - origin));
      }
    } catch {
      // Preserve the last observation when the diagnostic clock is unavailable.
    }
    return previousElapsed;
  };
  elapsed();
  let sequence = 0;
  let activeCount = 0;
  let recentDropped = 0;
  let bodyEnteredMs: number | undefined;
  let bodyExitedMs: number | undefined;
  const active = new Map<number, Entry>();
  const recent: (Entry & {elapsedMs: number; outcome: 'Success' | 'Failure'})[] = [];
  const totals: Record<string, {count: number; elapsedMs: number}> = Object.create(null);
  const stage = <A, E, R>(label: unknown, program: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const entry = {
        sequence: (sequence = bounded(sequence + 1)),
        stage: typeof label === 'string' && stages.has(label) ? label : 'other',
        startedMs: elapsed(),
      };
      if (entry.stage === 'body') bodyEnteredMs = entry.startedMs;
      activeCount = bounded(activeCount + 1);
      if (active.size < 8) active.set(entry.sequence, entry);
      const total = (totals[entry.stage] ??= {count: 0, elapsedMs: 0});
      total.count = bounded(total.count + 1);
      return program.pipe(
        Effect.withSpan(`closeout.stage.${entry.stage}`),
        Effect.onExit(exit =>
          Effect.sync(() => {
            activeCount = Math.max(0, activeCount - 1);
            active.delete(entry.sequence);
            const at = elapsed();
            if (entry.stage === 'body') bodyExitedMs = at;
            const elapsedMs = bounded(at - entry.startedMs);
            total.elapsedMs = bounded(total.elapsedMs + elapsedMs);
            recent.push({...entry, elapsedMs, outcome: exit._tag});
            if (recent.length > 32) {
              recent.shift();
              recentDropped = bounded(recentDropped + 1);
            }
          }),
        ),
      );
    });
  return {
    tracer: spans.tracer,
    stage,
    graph: <A, E, R>(program: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        const indexer = yield* CodeGraphIndexer;
        let indexStarted = false;
        return yield* program.pipe(
          Effect.provideService(
            CodeGraphQueryService,
            CodeGraphQueryService.of({
              ...query,
              status: (...args) => stage(indexStarted ? 'status-after' : 'status-before', query.status(...args)),
            }),
          ),
          Effect.provideService(
            CodeGraphIndexer,
            CodeGraphIndexer.of({
              ...indexer,
              index: (...args) =>
                Effect.suspend(() => {
                  indexStarted = true;
                  return stage('index', indexer.index(...args));
                }),
            }),
          ),
        );
      }),
    report: () => {
      try {
        const at = elapsed();
        process.stderr.write(
          'NATIVE_CLOSEOUT_DIAGNOSTICS ' +
            JSON.stringify({
              version: 1,
              scope: 'native-closeout-lifecycle',
              elapsedMs: at,
              bodyEnteredMs,
              bodyExitedMs,
              layerAcquisitionMs: bodyEnteredMs ?? at,
              cleanupMs: bodyExitedMs === undefined ? undefined : bounded(at - bodyExitedMs),
              totals,
              activeCount,
              unlistedActiveCount: activeCount - active.size,
              active: [...active.values()].map(entry => ({...entry, elapsedMs: bounded(at - entry.startedMs)})),
              recent,
              recentDropped,
              spans: spans.snapshot(),
            }) +
            '\n',
        );
      } catch {
        // Diagnostic output must never replace the failure being investigated.
      }
    },
  };
};
class CloseoutDiagnostics extends Context.Service<CloseoutDiagnostics, ReturnType<typeof closeoutDiagnostics>>()(
  '@threadnote/threadnote/test/dev-skills/native-closeout-diagnostics/CloseoutDiagnostics',
) {}

export const observeCloseoutStage = <A, E, R>(stage: unknown, program: Effect.Effect<A, E, R>) =>
  Effect.serviceOption(CloseoutDiagnostics).pipe(
    Effect.flatMap(observer => (Option.isSome(observer) ? observer.value.stage(stage, program) : program)),
  );
export const observeCloseoutGraph = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.serviceOption(CloseoutDiagnostics).pipe(
    Effect.flatMap((observer): Effect.Effect<A, E, R | CodeGraphQueryService | CodeGraphIndexer> =>
      Option.isSome(observer) ? observer.value.graph(program) : program,
    ),
  );

export const runCloseout = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const observer = closeoutDiagnostics();
    return observer
      .stage(
        'application-scope',
        observer
          .stage('body', program)
          .pipe(Effect.provideService(CloseoutDiagnostics, observer), TestClock.withLive, provideNative),
      )
      .pipe(
        Effect.withTracer(observer.tracer),
        Effect.onExit(exit =>
          Effect.sync(() => {
            if (exit._tag === 'Failure') observer.report();
          }),
        ),
      );
  });
