import {Effect, FileSystem, Layer, Path, Stdio, Terminal} from 'effect';
import {ChildProcessSpawner} from 'effect/process';
import {Command} from 'effect/cli';
import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {makeNativeTaskViewCommand} from '../../src/effect/workflow_cli.js';
import {fixture, object, run} from './native-cycle-lifecycle-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const cliTestLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die('unused'),
      readInput: Effect.die('unused'),
      readLine: Effect.die('unused'),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die('unused')),
  ),
);

describe('native task view', () => {
  effectIt.effect('returns a bounded read-only view through the guarded native inspection path', () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const before = yield* f.fs.readFileString(f.statePath());
        const view = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        const inspect = object(yield* f.call({...f.base('cycle'), command: 'inspect'}));
        expect(view).toMatchObject({
          status: 'ready',
          runId: 'native-run',
          featureId: 'feature',
          objective: 'Deliver each safe phase and continue without waiting for merge.',
          next: {action: 'implement', phaseId: 'one'},
          role: 'implementation',
          phase: {id: 'one', scope: ['source.ts'], acceptance: ['one works']},
        });
        expect(view.revision).toBe(inspect.revision);
        expect(new TextEncoder().encode(JSON.stringify(view)).byteLength).toBeLessThan(8192);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }),
    ),
  );

  effectIt.effect('parses task-view with role omitted or supplied at the CLI boundary', () =>
    Effect.gen(function* () {
      const received: {
        readonly runId: string;
        readonly callerCwd: string;
        readonly role?: string;
        readonly cursor?: string;
      }[] = [];
      const command = Command.make('workflow-automation').pipe(
        Command.withSubcommands([makeNativeTaskViewCommand(options => Effect.sync(() => received.push(options)))]),
      );
      const runCommand = Command.runWith(command, {version: 'fixture'});
      yield* runCommand(['task-view', '--run-id', 'run', '--caller-cwd', '/repo']);
      yield* runCommand([
        'task-view',
        '--run-id',
        'run',
        '--caller-cwd',
        '/repo',
        '--role',
        'review',
        '--cursor',
        'task-v1.eyJ2ZXJzaW9uIjoxfQ',
      ]);
      expect(received).toEqual([
        {runId: 'run', callerCwd: '/repo', role: undefined, cursor: undefined},
        {runId: 'run', callerCwd: '/repo', role: 'review', cursor: 'task-v1.eyJ2ZXJzaW9uIjoxfQ'},
      ]);
    }).pipe(provideTestLayer(cliTestLayer)),
  );

  effectIt.effect('rejects malformed or stale continuations with a restart instruction', () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* readNativeTaskView(f.config, {
          runId: 'native-run',
          callerCwd: f.repo,
          cursor: 'task-v1.invalid',
        }).pipe(Effect.match({onFailure: error => ({error}), onSuccess: value => ({value})}));
        expect(result).toHaveProperty('error');
        if ('error' in result) expect(result.error).toMatchObject({code: 'stale-cursor'});
      }),
    ),
  );

  effectIt.effect('reports captured unreviewed snapshots as review work', () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.mutate('begin-phase', {phaseId: 'one'});
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "review pending";\n');
        const captured = object(yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'one-review-pending'}));
        const snapshot = object(object(captured.snapshot).snapshot);
        const view = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(view).toMatchObject({
          status: 'ready',
          role: 'review',
          next: {action: 'review', phaseId: 'one', snapshotId: snapshot.snapshotId},
          phase: {snapshot: {snapshotId: 'one-review-pending', requiredReviewLanes: ['correctness', 'simplicity']}},
          missingInputs: [
            'A complete independent review for snapshot one-review-pending',
            'Correctness and simplicity review lanes with complete reports',
          ],
        });
      }),
    ),
  );

  effectIt.effect('blocks obsolete plan work until a fresh approved export is reconciled', () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.revise({objective: 'A revised, approved objective.'});
        const view = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(view).toMatchObject({
          status: 'blocked',
          objective: 'Reconcile this cycle to its current approved plan.',
          next: {action: 'reconcile-plan'},
          missingInputs: [
            'A fresh verified export of the current approved plan',
            'Cycle reconciliation against that export',
          ],
        });
        expect(view).not.toHaveProperty('phase');
      }),
    ),
  );
});
