import {Array as EffectArray} from 'effect';
import {Context, Effect} from 'effect';
import {isGitExecutable} from '@threadnote/platform/command';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const actions = new Set([
  'provisioning',
  'source-capture',
  'init',
  'save',
  'export-dev-cycle',
  'graph-ready',
  'inspect',
  'begin-phase',
  'snapshot',
  'validate-review',
  'ready',
  'record-delivery',
  'invalidate',
  'resume-phase',
  'reconcile',
  'publication-ready',
  'check',
  'detail',
  'packet',
  'next',
  'other',
]);
const operations = new Set([
  'init',
  'config',
  'add',
  'commit',
  'checkout',
  'rev-parse',
  'status',
  'show',
  'log',
  'ls-tree',
  'rev-list',
  'merge-base',
  'cat-file',
  'check-ref-format',
  'write-tree',
  'diff',
  'diff-tree',
  'ls-files',
  'for-each-ref',
  'update-index',
  'read-tree',
]);
const MAX = 2_147_483_647;
const bounded = (value: number) => Math.min(MAX, Math.max(0, Math.round(value)));
type Entry = {sequence: number; name: string; startedMs: number};

/** No arguments, paths, results, errors, or environment values enter the report. */
export const cycleDiagnostics = () => {
  const origin = performance.now();
  const elapsed = () => bounded(performance.now() - origin);
  let sequence = 0;
  let activeCount = 0;
  let lastStarted: Entry | undefined;
  let lastAction: Entry | undefined;
  let lastCommand: Entry | undefined;
  const active = new Map<number, Entry>();
  const recent: (Entry & {elapsedMs: number; outcome: 'Success' | 'Failure'})[] = [];
  const totals: Record<string, {count: number; elapsedMs: number}> = Object.create(null);
  const observe = <A, E, R>(name: string, program: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const entry = {sequence: (sequence = bounded(sequence + 1)), name, startedMs: elapsed()};
      lastStarted = entry;
      if (Effect2.pipe(name, EffectString.startsWith('action:'))) lastAction = entry;
      else lastCommand = entry;
      activeCount = bounded(activeCount + 1);
      if (active.size < 8) active.set(entry.sequence, entry);
      const total = (totals[name] ??= {count: 0, elapsedMs: 0});
      total.count = bounded(total.count + 1);
      return program.pipe(
        Effect.onExit(exit =>
          Effect.sync(() => {
            activeCount = Math.max(0, activeCount - 1);
            active.delete(entry.sequence);
            const elapsedMs = elapsed() - entry.startedMs;
            total.elapsedMs = bounded(total.elapsedMs + elapsedMs);
            recent.push({...entry, elapsedMs, outcome: exit._tag});
            if (recent.length > 16) recent.shift();
          }),
        ),
      );
    });
  return {
    action: <A, E, R>(name: unknown, program: Effect.Effect<A, E, R>) =>
      observe('action:' + (typeof name === 'string' && actions.has(name) ? name : 'other'), program),
    command: <A, E, R>(
      method: 'execute' | 'executeBytes',
      executable: string,
      args: readonly string[],
      program: Effect.Effect<A, E, R>,
    ) => {
      // Recognize only the global switches used by this suite, with a bounded scan.
      let index = 0;
      for (let scanned = 0; scanned < 16; scanned++) {
        if (args[index] === '--no-optional-locks') index++;
        else if (args[index] === '-C' || args[index] === '-c') index += 2;
        else break;
      }
      const candidate = args[index];
      const operation = !isGitExecutable(executable)
        ? 'other'
        : candidate && operations.has(candidate)
          ? candidate
          : 'other-git';
      return observe(method + ':' + operation, program);
    },
    report: (outcome: 'Success' | 'Failure') => {
      const at = elapsed();
      // Diagnostic output must not replace the original test outcome if stderr is unavailable.
      try {
        process.stderr.write(
          'NATIVE_CYCLE_DIAGNOSTICS ' +
            JSON.stringify({
              version: 1,
              scope: 'native-cycle-lifecycle',
              outcome,
              elapsedMs: at,
              totals,
              activeCount,
              unlistedActiveCount: activeCount - active.size,
              lastStarted: lastStarted && {...lastStarted, elapsedMs: at - lastStarted.startedMs},
              lastAction,
              lastCommand,
              active: EffectArray.map([...active.values()], entry => ({...entry, elapsedMs: at - entry.startedMs})),
              recent,
            }) +
            '\n',
        );
      } catch {
        // Preserve the test result.
      }
    },
  };
};
export class CycleDiagnostics extends Context.Service<CycleDiagnostics, ReturnType<typeof cycleDiagnostics>>()(
  '@threadnote/threadnote/test/dev-skills/native-cycle-diagnostics/CycleDiagnostics',
) {}
