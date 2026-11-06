import {Array as EffectArray} from 'effect';
import {Effect, Exit} from 'effect';

type Property = 'setup-opt-out' | 'workflow-retirement' | 'shared-context-namespace';
type Phase =
  | 'between-evaluations'
  | 'provisioning'
  | 'fixture'
  | 'explicit-opt-out'
  | 'default-setup'
  | 'status'
  | 'assertion'
  | 'create'
  | 'write-replay'
  | 'archive'
  | 'retired-write-replay'
  | 'archive-replay'
  | 'read-assertion'
  | 'configure-shared'
  | 'seed-source'
  | 'journal-read'
  | 'authorized-read'
  | 'authorized-preflight'
  | 'denied-read'
  | 'denied-preflight'
  | 'teardown';
type Evaluation = {ordinal: number; input: number | null; startedMs: number};
type Record =
  | {
      event: 'phase';
      ordinal: number | null;
      phase: Phase;
      loopIndex: number | null;
      startedMs: number;
      elapsedMs: number;
    }
  | (Evaluation & {event: 'evaluation-exit'; elapsedMs: number; outcome: 'Success' | 'Failure'; interrupted: boolean});

export const workflowDiagnostics = (property: Property, now = () => performance.now()) => {
  const start = now();
  let elapsedMs = 0;
  const elapsed = () => {
    const observed = Math.round(now() - start);
    if (Number.isFinite(observed)) elapsedMs = Math.max(elapsedMs, observed);
    return elapsedMs;
  };
  let phase: Phase = 'between-evaluations';
  let phaseStart = 0;
  let loopIndex: number | null = null;
  let startedEvaluations = 0;
  let completedEvaluations = 0;
  let successfulEvaluations = 0;
  let active: Evaluation | null = null;
  const recent: Record[] = [];
  const record = (entry: Record) => {
    recent.push(entry);
    if (recent.length > 16) recent.shift();
  };
  const closePhase = (at: number) => {
    record({
      event: 'phase',
      ordinal: active?.ordinal ?? null,
      phase,
      loopIndex,
      startedMs: phaseStart,
      elapsedMs: at - phaseStart,
    });
    phaseStart = at;
  };
  return {
    phase: (next: Phase, index?: number) => {
      closePhase(elapsed());
      phase = next;
      loopIndex = index !== undefined && Number.isInteger(index) && index >= 0 && index < 5 ? index : null;
    },
    // Evaluations include any runner replays or shrinking; only Success exits count as successful.
    observe: <A, E, R>(input: number, program: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const at = elapsed();
        closePhase(at);
        const evaluation = {
          ordinal: ++startedEvaluations,
          input:
            Number.isInteger(input) &&
            input >= 1 &&
            input <= (property === 'shared-context-namespace' ? 2 : property === 'setup-opt-out' ? 5 : 4)
              ? input
              : null,
          startedMs: at,
        };
        active = evaluation;
        phase = 'provisioning';
        loopIndex = null;
        return program.pipe(
          Effect.onExit(exit =>
            Effect.sync(() => {
              const finishedAt = elapsed();
              closePhase(finishedAt);
              completedEvaluations++;
              if (Exit.isSuccess(exit)) successfulEvaluations++;
              record({
                ...evaluation,
                event: 'evaluation-exit',
                elapsedMs: finishedAt - at,
                outcome: exit._tag,
                interrupted: Exit.hasInterrupts(exit),
              });
              active = null;
              phase = 'between-evaluations';
              loopIndex = null;
            }),
          ),
        );
      }),
    snapshot: () => {
      const at = elapsed();
      return {
        version: 1,
        property,
        inputName:
          property === 'shared-context-namespace'
            ? 'accessMode'
            : property === 'setup-opt-out'
              ? 'repetitions'
              : 'retries',
        elapsedOrigin: 'observer-created',
        elapsedMs: at,
        startedEvaluations,
        completedEvaluations,
        successfulEvaluations,
        phase,
        loopIndex,
        phaseElapsedMs: at - phaseStart,
        activeEvaluation: active ? {...active, elapsedMs: at - active.startedMs} : null,
        recent: EffectArray.map(recent, entry => ({...entry})),
      };
    },
  };
};

type Lifecycle = {
  readonly signal: AbortSignal;
  readonly onTestFinished: (callback: () => void) => void;
};
const observers = new WeakMap<Lifecycle, ReturnType<typeof workflowDiagnostics>>();

export const workflowPropertyDiagnostics = (
  context: Lifecycle,
  property: Property,
  options: {now?: () => number; write?: (line: string) => void} = {},
) => {
  const existing = observers.get(context);
  if (existing) return existing;
  // The first generated callback creates the observer; earlier runner time is unobserved.
  const diagnostics = workflowDiagnostics(property, options.now);
  observers.set(context, diagnostics);
  const write = options.write ?? (line => process.stderr.write(line));
  let finished = false;
  let reportedAbort = false;
  const report = (event: 'aborted' | 'finished') => {
    try {
      write('WORKFLOW_PROPERTY_DIAGNOSTICS ' + JSON.stringify({event, ...diagnostics.snapshot()}) + '\n');
    } catch {
      // A closed diagnostic sink must never replace the property's result or interruption.
    }
  };
  const aborted = () => {
    if (finished || reportedAbort) return;
    reportedAbort = true;
    report('aborted');
  };
  context.signal.addEventListener('abort', aborted, {once: true});
  context.onTestFinished(() => {
    if (finished) return;
    finished = true;
    context.signal.removeEventListener('abort', aborted);
    if (observers.get(context) === diagnostics) observers.delete(context);
    report('finished');
  });
  if (context.signal.aborted) aborted();
  return diagnostics;
};
