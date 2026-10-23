import {Effect} from 'effect';
import {isGitExecutable} from '@threadnote/platform/command';

type Phase =
  | 'provisioning'
  | 'fixture'
  | 'preview'
  | 'hook-install'
  | 'approval-refusal'
  | 'approve'
  | 'publish'
  | 'pending-guard'
  | 'hook-removal'
  | 'resume'
  | 'replay'
  | 'retirement-guard'
  | 'remote-verification'
  | 'canonical-readback'
  | 'teardown';

const gitOperations = new Set([
  'init',
  'config',
  'remote',
  'add',
  'commit',
  'rev-parse',
  'clone',
  'push',
  'fetch',
  'status',
  'show',
  'log',
  'ls-tree',
  'rev-list',
  'merge-base',
  'cat-file',
  'check-ref-format',
]);
const operation = (executable: string, args: readonly string[]) => {
  if (!isGitExecutable(executable)) return 'other';
  const candidate = args[0] === '-C' ? args[2] : args[0];
  return candidate && gitOperations.has(candidate) ? candidate : 'other-git';
};

export const publicationDiagnostics = (now = () => performance.now()) => {
  const start = now();
  const elapsed = () => Math.round(now() - start);
  let currentPhase: Phase = 'provisioning';
  let phaseStart = 0;
  let commandCount = 0;
  let activeCount = 0;
  const phases: {phase: Phase; startedMs: number; elapsedMs: number}[] = [];
  const active = new Map<number, {sequence: number; operation: string; startedMs: number}>();
  const recent: {
    sequence: number;
    operation: string;
    startedMs: number;
    elapsedMs: number;
    outcome: 'Success' | 'Failure';
  }[] = [];

  return {
    phase: (phase: Phase) => {
      const at = elapsed();
      phases.push({phase: currentPhase, startedMs: phaseStart, elapsedMs: at - phaseStart});
      if (phases.length > 16) phases.shift();
      currentPhase = phase;
      phaseStart = at;
    },
    observe: <A, E, R>(executable: string, args: readonly string[], program: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const command = {sequence: ++commandCount, operation: operation(executable, args), startedMs: elapsed()};
        activeCount++;
        if (active.size < 4) active.set(command.sequence, command);
        return program.pipe(
          Effect.onExit(exit =>
            Effect.sync(() => {
              activeCount--;
              active.delete(command.sequence);
              recent.push({...command, elapsedMs: elapsed() - command.startedMs, outcome: exit._tag});
              if (recent.length > 16) recent.shift();
            }),
          ),
        );
      }),
    snapshot: () => {
      const at = elapsed();
      return {
        version: 1,
        scope: 'CommandExecutor.execute',
        elapsedMs: at,
        phase: currentPhase,
        phaseElapsedMs: at - phaseStart,
        phases: phases.map(entry => ({...entry})),
        commandCount,
        activeCount,
        unlistedActiveCount: activeCount - active.size,
        active: [...active.values()].map(entry => ({...entry, elapsedMs: at - entry.startedMs})),
        recent: recent.map(entry => ({...entry})),
      };
    },
  };
};
