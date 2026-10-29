import {Array as EffectArray} from 'effect';
import {Context, Effect, Exit, Option, Tracer} from 'effect';

export const WORKFLOW_EXECUTION_PHASES = [
  'provisioning',
  'fixture-filesystem',
  'fixture-git',
  'bind',
  'create',
  'journal-before-index',
  'graph-index',
  'deferred-finalization',
  'fixture-readback',
  'citation-reconcile',
  'recover',
  'create-replay',
  'journal-after-recovery',
  'archive',
  'retired-replay',
  'authoring-provisioning',
  'authoring-git-setup',
  'authoring-profile-setup',
  'authoring-init',
  'authoring-draft-save',
  'authoring-replay',
  'authoring-load',
  'authoring-child-reads',
  'authoring-acceptance',
  'authoring-review',
  'authoring-ready-save',
  'authoring-readback',
  'authoring-private-remote',
  'assertions',
  'teardown',
  'completed',
] as const;
type Phase = (typeof WORKFLOW_EXECUTION_PHASES)[number];
export const WORKFLOW_COMMAND_SPANS = [
  'CommandExecutor.execute',
  'CommandExecutor.executeBinary',
  'CommandExecutor.executeStreaming',
] as const;
type Channel = 'execute' | 'execute-binary' | 'execute-streaming';
type Outcome = 'Success' | 'Failure';
type Event = 'aborted' | 'effect-exit' | 'finished';
type Command = {sequence: number; channel: Channel; startedMs: number};
type Recent =
  | {event: 'phase'; phase: Phase; startedMs: number; elapsedMs: number}
  | (Command & {event: 'command-exit'; elapsedMs: number; outcome: Outcome});
type Options = {
  readonly now?: () => number;
  readonly write?: (line: string) => void;
  readonly testTag?: 'native-authoring-cloud';
};
const MAX_COUNT = 1_000_000;
const MAX_TIME = 86_400_000;
const safely = (observe: () => void) => {
  try {
    observe();
  } catch {
    // Diagnostic faults never own the original Effect or cleanup.
  }
};

class CommandSpan extends Tracer.NativeSpan {
  constructor(private readonly complete: ((outcome: Outcome) => void) | undefined) {
    super({
      name: 'workflow-test-command-observation',
      startTime: 0n,
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      kind: 'internal',
      sampled: true,
    });
  }
  override end(_at: bigint, exit: Exit.Exit<unknown, unknown>) {
    if (this.status._tag === 'Ended') return;
    safely(() => this.complete?.(exit._tag === 'Success' ? 'Success' : 'Failure'));
    super.end(0n, Exit.void);
  }
  override attribute() {}
  override event() {}
  override addLinks() {}
}

/** Observe only existing command spans; this does not inventory operating-system children. */
export function createWorkflowExecutionDiagnostics(options: Options = {}) {
  let invalid = false;
  let overflow = false;
  let now = () => performance.now();
  let write = (line: string) => {
    process.stderr.write(line);
  };
  safely(() => {
    now = options.now ?? now;
    write = options.write ?? write;
  });
  const read = () => {
    try {
      const value = now();
      if (Number.isFinite(value)) return value;
    } catch {
      // Keep the previous finite observation if a clock fails.
    }
    invalid = true;
    return undefined;
  };
  const origin = read() ?? 0;
  let last = 0;
  const elapsed = () => {
    const at = read();
    if (at === undefined) return last;
    const next = Math.round(at - origin);
    invalid ||= next < last;
    overflow ||= next > MAX_TIME;
    last = Math.max(last, Math.min(MAX_TIME, Math.max(0, next)));
    return last;
  };
  const increment = (value: number) => {
    overflow ||= value >= MAX_COUNT;
    return Math.min(MAX_COUNT, value + 1);
  };
  let phase: Phase = 'provisioning';
  let lastWorkPhase: Phase = 'provisioning';
  let phaseStart = 0;
  let programStarted = false;
  let programCompleted = false;
  let programOutcome: Outcome | null = null;
  let commandCount = 0;
  let completedCommands = 0;
  let successfulCommands = 0;
  let activeCount = 0;
  let droppedRecords = 0;
  let droppedActiveRecords = 0;
  const active = new Map<number, Command>();
  const recent: Recent[] = [];
  const record = (entry: Recent) => {
    recent.push(entry);
    if (recent.length > 16) {
      recent.shift();
      droppedRecords = increment(droppedRecords);
    }
  };
  const changePhase = (next: Phase) => {
    if (!WORKFLOW_EXECUTION_PHASES.includes(next)) {
      invalid = true;
      return;
    }
    const at = elapsed();
    record({event: 'phase', phase, startedMs: phaseStart, elapsedMs: at - phaseStart});
    phase = next;
    if (next !== 'teardown' && next !== 'completed') lastWorkPhase = next;
    phaseStart = at;
  };
  const tracer = Tracer.make({
    span(options) {
      let channel: Channel | undefined;
      safely(() => {
        const name = options.name;
        if (name === WORKFLOW_COMMAND_SPANS[0]) channel = 'execute';
        else if (name === WORKFLOW_COMMAND_SPANS[1]) channel = 'execute-binary';
        else if (name === WORKFLOW_COMMAND_SPANS[2]) channel = 'execute-streaming';
      });
      if (channel === undefined || programCompleted) return new CommandSpan(undefined);
      if (commandCount === MAX_COUNT) {
        overflow = true;
        return new CommandSpan(undefined);
      }
      const command = {sequence: ++commandCount, channel, startedMs: elapsed()};
      activeCount++;
      if (active.size < 4) active.set(command.sequence, command);
      else {
        overflow = true;
        droppedActiveRecords = increment(droppedActiveRecords);
      }
      return new CommandSpan(outcome => {
        activeCount--;
        completedCommands = increment(completedCommands);
        if (outcome === 'Success') successfulCommands = increment(successfulCommands);
        active.delete(command.sequence);
        record({...command, event: 'command-exit', elapsedMs: elapsed() - command.startedMs, outcome});
      });
    },
  });
  const snapshot = () => {
    const at = elapsed();
    return {
      version: 1,
      test: options.testTag ?? 'workflow-citation-recovery',
      scope: 'existing-command-effect-spans',
      elapsedOrigin: 'observer-created',
      elapsedMs: at,
      phase,
      lastWorkPhase,
      phaseElapsedMs: at - phaseStart,
      programStarted,
      programCompleted,
      programOutcome,
      commandCount,
      completedCommands,
      successfulCommands,
      activeCount,
      unlistedActiveCount: activeCount - active.size,
      active: EffectArray.map([...active.values()], entry => ({...entry, elapsedMs: at - entry.startedMs})),
      recent: EffectArray.map(recent, entry => ({...entry})),
      droppedRecords,
      droppedActiveRecords,
      overflow,
      invalid,
    };
  };
  const report = (event: Event) => {
    safely(() => {
      if (event !== 'aborted' && event !== 'effect-exit' && event !== 'finished') {
        invalid = true;
        return;
      }
      const packet = {event, ...snapshot()};
      let json = JSON.stringify(packet);
      if (json.length > 8192) json = JSON.stringify({...packet, active: [], recent: [], overflow: true});
      write('WORKFLOW_EXECUTION_DIAGNOSTICS ' + json + '\n');
    });
  };
  return {
    tracer,
    phase: (next: Phase) => safely(() => changePhase(next)),
    started: () => {
      programStarted = true;
    },
    exited: (outcome: Outcome) => {
      if (programCompleted) return;
      if (outcome !== 'Success' && outcome !== 'Failure') {
        invalid = true;
        return;
      }
      programCompleted = true;
      programOutcome = outcome;
      changePhase('completed');
      report('effect-exit');
    },
    snapshot,
    report,
  };
}

export type WorkflowExecutionDiagnostics = ReturnType<typeof createWorkflowExecutionDiagnostics>;

export function executionDiagnosticPhase(diagnostics: WorkflowExecutionDiagnostics | undefined, phase: Phase): void {
  safely(() => diagnostics?.phase(phase));
}

export function withWorkflowExecutionDiagnostics<A, E, R>(
  original: Effect.Effect<A, E, R>,
  diagnostics?: WorkflowExecutionDiagnostics,
): Effect.Effect<A, E, R> {
  if (!diagnostics) return original;
  let observed = original;
  safely(() => {
    observed = Effect.withTracer(original, diagnostics.tracer);
  });
  return Effect.suspend(() => {
    safely(() => diagnostics.started());
    return observed.pipe(Effect.onExit(exit => Effect.sync(() => safely(() => diagnostics.exited(exit._tag)))));
  });
}

type Lifecycle = {readonly signal: AbortSignal; readonly onTestFinished: (callback: () => void) => void};
const observers = new WeakMap<Lifecycle, WorkflowExecutionDiagnostics>();

export function workflowExecutionDiagnostics(context: Lifecycle, options: Options = {}): WorkflowExecutionDiagnostics {
  const existing = observers.get(context);
  if (existing) return existing;
  const diagnostics = createWorkflowExecutionDiagnostics(options);
  observers.set(context, diagnostics);
  let finished = false;
  let reportedAbort = false;
  let signal: AbortSignal | undefined;
  const aborted = () => {
    if (finished || reportedAbort) return;
    reportedAbort = true;
    diagnostics.report('aborted');
  };
  const cleanup = () => safely(() => signal?.removeEventListener('abort', aborted));
  safely(() => {
    signal = context.signal;
    signal.addEventListener('abort', aborted, {once: true});
  });
  try {
    context.onTestFinished(() => {
      if (finished) return;
      finished = true;
      cleanup();
      if (observers.get(context) === diagnostics) observers.delete(context);
      diagnostics.report('finished');
    });
  } catch {
    cleanup();
    observers.delete(context);
  }
  safely(() => {
    if (signal?.aborted) aborted();
  });
  return diagnostics;
}
