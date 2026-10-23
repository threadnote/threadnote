import {Effect, Exit} from 'effect';

type Phase =
  | 'provisioning'
  | 'fixture'
  | 'install'
  | 'remove-or-disable'
  | 'release'
  | 'preview'
  | 'prepare'
  | 'activate'
  | 'index-read'
  | 'restore-home-index'
  | 'refresh'
  | 'replay'
  | 'assertions-status'
  | 'teardown'
  | 'between-evaluations';

type DiagnosticScope =
  'dev-skills-refresh-property' | 'dev-skills-refresh-unavailable-home' | 'dev-skills-refresh-removal-recovery';
type RecoveryBoundary = 'journal' | 'receipt' | 'home' | 'runtime';
type Evaluation = {
  ordinal: number;
  removed?: boolean;
  boundary?: RecoveryBoundary;
  shared?: boolean;
  startedMs: number;
};
const historyLimit = 16;

export const refreshDiagnostics = (
  now = () => performance.now(),
  scope: DiagnosticScope = 'dev-skills-refresh-property',
) => {
  const start = now();
  const elapsed = () => Math.round(now() - start);
  let phase: Phase = 'between-evaluations';
  let phaseStart = 0;
  let startedEvaluations = 0;
  let completedEvaluations = 0;
  let successfulEvaluations = 0;
  let active: Evaluation | null = null;
  const phases: {ordinal: number | null; phase: Phase; startedMs: number; elapsedMs: number}[] = [];
  const recent: (Evaluation & {elapsedMs: number; outcome: 'Success' | 'Failure'; interrupted: boolean})[] = [];

  const closePhase = (at: number) => {
    phases.push({ordinal: active?.ordinal ?? null, phase, startedMs: phaseStart, elapsedMs: at - phaseStart});
    if (phases.length > historyLimit) phases.shift();
    phaseStart = at;
  };

  // Each invocation is an evaluation; the runner can also invoke it while shrinking.
  const observe = <A, E, R>(
    input: Pick<Evaluation, 'removed' | 'boundary' | 'shared'>,
    program: Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend(() => {
      const at = elapsed();
      closePhase(at);
      const evaluation = {
        ordinal: ++startedEvaluations,
        ...input,
        startedMs: at,
      };
      active = evaluation;
      phase = 'provisioning';
      return program.pipe(
        Effect.onExit(exit =>
          Effect.sync(() => {
            const finishedAt = elapsed();
            closePhase(finishedAt);
            completedEvaluations++;
            if (Exit.isSuccess(exit)) successfulEvaluations++;
            recent.push({
              ...evaluation,
              elapsedMs: finishedAt - evaluation.startedMs,
              outcome: exit._tag,
              interrupted: Exit.hasInterrupts(exit),
            });
            if (recent.length > historyLimit) recent.shift();
            active = null;
            phase = 'between-evaluations';
          }),
        ),
      );
    });

  return {
    phase: (next: Phase) => {
      closePhase(elapsed());
      phase = next;
    },
    observe: <A, E, R>(removed: boolean | undefined, program: Effect.Effect<A, E, R>) =>
      observe(removed === undefined ? {} : {removed}, program),
    observeRecovery: <A, E, R>(boundary: RecoveryBoundary, shared: boolean, program: Effect.Effect<A, E, R>) =>
      observe({boundary, shared}, program),
    snapshot: () => {
      const at = elapsed();
      return {
        version: 1,
        scope,
        elapsedOrigin: 'observer-created',
        elapsedMs: at,
        startedEvaluations,
        completedEvaluations,
        successfulEvaluations,
        phase,
        phaseElapsedMs: at - phaseStart,
        activeEvaluation: active ? {...active, elapsedMs: at - active.startedMs} : null,
        phases: phases.map(entry => ({...entry})),
        recent: recent.map(entry => ({...entry})),
      };
    },
  };
};

type TestLifecycle = {
  readonly signal: AbortSignal;
  readonly onTestFinished: (callback: () => void) => void;
};
const observers = new WeakMap<TestLifecycle, ReturnType<typeof refreshDiagnostics>>();

export const refreshPropertyDiagnostics = (
  context: TestLifecycle,
  options: {now?: () => number; scope?: DiagnosticScope; write?: (line: string) => void} = {},
) => {
  const existing = observers.get(context);
  if (existing) return existing;
  // The first test callback creates this observer; earlier runner time is unobserved.
  const diagnostics = refreshDiagnostics(options.now, options.scope);
  observers.set(context, diagnostics);
  const write = options.write ?? (line => process.stderr.write(line));
  const report = (event: 'aborted' | 'finished') => {
    try {
      write(`SERVICE_REFRESH_DIAGNOSTICS ${JSON.stringify({event, ...diagnostics.snapshot()})}\n`);
    } catch {
      // A diagnostic sink must not replace the test's result or interruption.
    }
  };
  const aborted = () => report('aborted');
  context.signal.addEventListener('abort', aborted, {once: true});
  context.onTestFinished(() => {
    context.signal.removeEventListener('abort', aborted);
    if (observers.get(context) === diagnostics) observers.delete(context);
    report('finished');
  });
  if (context.signal.aborted) aborted();
  return diagnostics;
};
