import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {decodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import {describe, expect} from 'vitest';
import {CurrentNativeJobAutoLaunch, runNativeJobWorker} from '../../src/workflow_automation/native_jobs.js';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {runNativeTaskAction} from '../../src/workflow_automation/task_actions.js';
import {fixture, object, run} from './native-cycle-lifecycle-fixture.js';

const packet = {
  capacity: {
    model: 'fixture-background',
    effort: 'low',
    selection: 'least-sufficient',
    risk: 'settled',
    reason: 'The fixture exercises a bounded one-file phase.',
    catalogEvidence: 'Synthetic local test capability record.',
  },
  anchors: [{path: 'source.ts', pattern: 'export const fixture'}],
  ownership: ['source.ts'],
  checks: ['bun test focused fixture'],
};
const proposal = {
  architecture: {
    summary: 'The fixture records a source-checked local implementation.',
    components: ['Fixture source', 'Native cycle'],
    contracts: ['Preserve exact local validation and delivery evidence.'],
    diagram: 'flowchart TD\n Fixture --> Cycle',
    invariants: ['Only the committed validated source is delivered.'],
    unknowns: [],
    deviations: [],
    codeRefs: ['source.ts'],
  },
  architectureVerification: 'Inspected the committed fixture source and its recorded phase proof.',
  combinedChecks: [{command: 'focused fixture task flow', result: 'passed', evidence: 'The task flow passed.'}],
  phaseEvidence: [{id: 'one', acceptance: [{criterion: 'one works', evidence: 'Delivered after the move.'}]}],
  scenarios: [],
  decisions: [{id: 'delivery', implemented: 'The phase delivered locally.', rationale: 'The plan selects local.'}],
};

describe('native run storage moves', () => {
  // Windows directory links need host privileges; the move contract is exercised where symlinks are ordinary.
  effectIt.effect.skipIf(process.platform === 'win32')(
    'resumes a run whose home and checkout moved behind links at their original paths, and only that run',
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture(['one'], 'local');
          const runId = 'native-run';
          const view = (callerCwd = f.repo, config = f.config) => readNativeTaskView(config, {runId, callerCwd});
          const action = (fields: Record<string, unknown>) =>
            runNativeTaskAction(f.config, {runId, callerCwd: f.repo, ...fields}).pipe(
              Effect.map(object),
              Effect.provideService(CurrentNativeJobAutoLaunch, false),
            );
          yield* action({command: 'begin', taskRef: String(object(yield* view()).taskRef)});
          const work = yield* action({command: 'work', packet});
          const before = object(yield* view());

          // Move both stores elsewhere and leave links at the original paths.
          const moved = f.path.join(f.root, 'moved');
          const movedHome = f.path.join(moved, 'home');
          const movedRepo = f.path.join(moved, 'repo');
          yield* f.fs.makeDirectory(moved);
          for (const [from, to] of [
            [f.home, movedHome],
            [f.repo, movedRepo],
          ] as const)
            yield* f.fs.rename(from, to).pipe(Effect.andThen(f.fs.symlink(to, from)));

          expect(object(yield* view())).toMatchObject({revision: before.revision, next: before.next});
          expect(object(yield* view(movedRepo))).toMatchObject({revision: before.revision, next: before.next});
          // Another checkout of the same history and a copy of the moved home remain other contexts.
          const otherRepo = f.path.join(f.root, 'other-repo');
          yield* runCommandEffect('git', ['clone', '--quiet', movedRepo, otherRepo]);
          expect(yield* view(otherRepo).pipe(Effect.result)).toMatchObject({failure: {code: 'binding-drift'}});
          const copiedHome = f.path.join(f.root, 'copied-home');
          yield* f.fs.copy(movedHome, copiedHome);
          expect(yield* view(f.repo, {...f.config, agentContextHome: copiedHome}).pipe(Effect.result)).toMatchObject({
            failure: {code: 'binding-drift'},
          });
          // Moving only the home back leaves a mixed old and moved context that names the same stores.
          yield* f.fs.remove(f.home).pipe(Effect.andThen(f.fs.rename(movedHome, f.home)));
          expect(object(yield* view())).toMatchObject({revision: before.revision, next: before.next});

          yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "one";\n');
          yield* f.git(['add', 'source.ts']);
          yield* f.git(['commit', '-m', 'Phase one']);
          const snapshot = yield* action({command: 'record-snapshot', workRef: String(work.workRef)});
          const reviewed = yield* action({
            command: 'record-review',
            snapshotRef: snapshot.snapshotRef,
            report: {
              mode: 'full',
              selected: ['correctness', 'simplicity'],
              lanes: [
                {name: 'correctness', status: 'complete'},
                {name: 'simplicity', status: 'complete'},
              ],
              findings: [],
            },
          });
          const validation = yield* action({
            command: 'record-validation',
            snapshotRef: reviewed.snapshotRef,
            validation: {
              checks: [{command: 'phase one check', result: 'passed', evidence: 'Moved-storage fixture.'}],
              acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Committed source.'}],
            },
          });
          expect(yield* action({command: 'deliver-local', validationRef: validation.validationRef})).toMatchObject({
            status: 'delivered',
          });

          const job = (ref: unknown) =>
            runNativeJobWorker(f.config, runId, String(decodeNativeTaskActionRef(String(ref))?.jobId), f.call).pipe(
              Effect.map(object),
            );
          const prepareRef = (yield* action({command: 'finish', proposal})).prepareRef;
          expect(yield* job(prepareRef)).toMatchObject({status: 'completed'});
          const finishRef = (yield* action({command: 'finish', proposal, prepareRef, resume: true})).finishRef;
          expect(yield* job(finishRef)).toMatchObject({status: 'completed'});
          expect(yield* action({command: 'finish', proposal, finishRef, resume: true})).toMatchObject({
            status: 'complete',
          });
        }),
      ),
    {timeout: 60_000},
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'saves revised authoring for a run whose checkout moved behind a link at its original path',
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture(['one'], 'local');
          const movedRepo = f.path.join(f.root, 'moved-repo');
          yield* f.fs.rename(f.repo, movedRepo).pipe(Effect.andThen(f.fs.symlink(movedRepo, f.repo)));
          const revised = yield* f.revise({title: 'Cycle fixture after the move'});
          expect(object(revised.source).root).toMatchObject({uri: expect.any(String)});
        }),
      ),
    {timeout: 60_000},
  );
});
