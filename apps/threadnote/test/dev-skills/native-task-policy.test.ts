import {Array as EffectArray, Effect, Predicate, String as EffectString} from 'effect';
import * as EffectRecord from 'effect/Record';
import {TestClock} from 'effect/testing';
import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {EffectMcpServerAdapter, mcpToolFailureResult} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {readNativeWorkflowState, writeNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {nativeCycleWaiverId} from '@threadnote/workflow-automations/cycle-runtime';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {fixture as cycleFixture, object, run as runCycle} from './native-cycle-lifecycle-fixture.js';
import {runNativeTaskAction} from '../../src/workflow_automation/task_actions.js';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);

describe('dev-cycle workflow policy', () => {
  effectIt.effect('records the configured default policy on a new run and keeps it on replay', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const standard = {...f.config, workflowPolicyDefault: 'standard' as const};
      const init = {...f.base('init'), project: 'fixture', featureId: 'feature', profile: 'desktop'};
      expect(yield* f.call(init, standard)).toMatchObject({status: 'ok', policy: 'standard'});
      expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.state.policy).toEqual({mode: 'standard'});
      expect(yield* f.call({...init, policy: 'standard'}, standard)).toMatchObject({status: 'ok'});
      expect(yield* f.call({...init, policy: 'strict'}, standard).pipe(Effect.flip)).toMatchObject({
        code: 'binding-drift',
      });
    }).pipe(run),
  );

  effectIt.effect('leaves a run without a configured default unmarked, which reads as strict', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      expect(initialized).not.toHaveProperty('policy');
      expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.state).not.toHaveProperty('policy');
    }).pipe(run),
  );

  effectIt.effect('returns an MCP workflow refusal with its code as structured content', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const mcp = new EffectMcpServerAdapter('test', '1', 'workflow policy fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const result = yield* mcp
        .invokeTool('workflow_task_view', {runId: 'missing-run', callerCwd: f.repo})
        .pipe(Effect.matchCauseEffect({onFailure: mcpToolFailureResult, onSuccess: Effect.succeed}));
      expect(result).toMatchObject({isError: true, structuredContent: {status: 'error', code: 'run-not-found'}});
    }).pipe(run),
  );
});

describe('standard-profile tree snapshots', () => {
  const standard = () =>
    cycleFixture(['one'], 'local', false, false, true, undefined, undefined, {}, {policy: 'standard'});
  const record = (f: {readonly config: RuntimeConfig; readonly repo: string}, reason?: string) =>
    runNativeTaskAction(f.config, {
      command: 'record-snapshot',
      runId: 'native-run',
      callerCwd: f.repo,
      ...(reason === undefined ? {} : {reason}),
    }).pipe(Effect.map(result => object(object(object(result).snapshot).snapshot)));

  effectIt.effect('supersedes unreviewed trees, replays the same tree and survives a reconcile', () =>
    Effect.gen(function* () {
      const f = yield* standard();
      const write = (text: string) => f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), text);
      yield* write('export const fixture = 1;\n');
      const first = yield* record(f, 'r1');
      expect(first).toMatchObject({version: 4, dirty: true, outOfPlan: []});
      expect(first).not.toHaveProperty('supersedes');
      yield* write('export const fixture = 2;\n');
      const second = yield* record(f, 'r2');
      expect(second.snapshotId).not.toBe(first.snapshotId);
      expect(second).toMatchObject({supersedes: first.snapshotId, unreviewedSupersession: {reason: 'r2'}});
      const replay = yield* runNativeTaskAction(f.config, {
        command: 'record-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        reason: 'r3',
      });
      expect(replay).toMatchObject({replayed: true, snapshot: {snapshot: {snapshotId: second.snapshotId}}});
      const revised = yield* f.revise({
        phases: EffectArray.map(f.document.phases, phase => ({...phase, outcome: 'Phase works faster.'})),
      });
      yield* f.mutate('reconcile', {plan: revised, reason: 'The phase outcome changed.'});
      yield* f.mutate('resume-phase', {phaseId: 'one', reason: 'The phase outcome was reconciled.'});
      const after = yield* record(f);
      expect(after).toMatchObject({version: 4, supersedes: second.snapshotId});
      expect(after.phaseHash).not.toBe(second.phaseHash);
      const view = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(view.next).toMatchObject({action: 'review', snapshotId: after.snapshotId});
    }).pipe(runCycle),
  );

  effectIt.effect('records a new iteration of an unchanged tree after a reopen instead of replaying it', () =>
    Effect.gen(function* () {
      const f = yield* standard();
      const task = (command: string, fields: Record<string, unknown> = {}) =>
        runNativeTaskAction(f.config, {command, runId: 'native-run', callerCwd: f.repo, ...fields}).pipe(
          Effect.map(object),
        );
      const view = () => readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      const validation = {
        checks: [{command: 'private flow', result: 'passed', evidence: 'Actual scoped source fixture.'}],
        acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Source readback.'}],
      };
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* f.git(['commit', '-qam', 'phase one']);
      const recorded = yield* task('record-snapshot');
      const first = object(object(recorded.snapshot).snapshot);
      yield* f.mutate('validate-review', {
        snapshotId: first.snapshotId,
        attemptId: 'a1',
        report: {
          snapshotId: first.snapshotId,
          phaseHash: first.phaseHash,
          snapshotTree: first.tree,
          status: 'complete',
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        },
      });
      yield* task('record-validation', {snapshotRef: String(recorded.snapshotRef), validation});
      yield* task('reopen', {taskRef: (yield* view()).taskRef, phaseId: 'one', reason: 'The evidence was incomplete.'});
      yield* task('resume', {taskRef: (yield* view()).taskRef, reason: 'Resume after the reopen.'});
      const again = yield* task('record-snapshot', {reason: 'Same tree after the reopen.'});
      const second = object(object(again.snapshot).snapshot);
      expect(again.replayed).toBe(false);
      expect(second.snapshotId).not.toBe(first.snapshotId);
      expect(second.tree).toBe(first.tree);
      expect((yield* view()).next).toMatchObject({action: 'validate', snapshotId: second.snapshotId});
      const validated = yield* task('record-validation', {snapshotRef: String(again.snapshotRef), validation});
      expect(yield* task('deliver-local', {validationRef: String(validated.validationRef)})).toMatchObject({
        status: 'delivered',
      });
    }).pipe(runCycle),
  );

  effectIt.effect('refuses the strict recovery commands and points at record-snapshot', () =>
    Effect.gen(function* () {
      const f = yield* standard();
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      const recorded = object(
        yield* runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo}),
      );
      const before = yield* f.fs.readFileString(f.statePath());
      for (const command of ['supersede-unreviewed-snapshot', 'requalify-base-snapshot'])
        expect(
          yield* runNativeTaskAction(f.config, {
            command,
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: String(recorded.snapshotRef),
            reason: 'Try the strict recovery.',
            ...(command === 'requalify-base-snapshot' ? {userAuthority: 'User: requalify.'} : {}),
          }).pipe(Effect.flip),
        ).toMatchObject({
          code: 'standard-profile-recovery',
          next: {tool: 'workflow_task_snapshot', arguments: {snapshot: {command: 'record'}}},
        });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(runCycle),
  );

  effectIt.effect('keeps the work-packet precondition for a strict run', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(['one'], 'local');
      expect(
        yield* runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo}).pipe(
          Effect.flip,
        ),
      ).toMatchObject({code: 'invalid-work-ref', next: {tool: 'workflow_task_work'}});
    }).pipe(runCycle),
  );
});

describe('standard-profile derived ownership', () => {
  const review = (snapshot: Record<string, unknown>) => ({
    snapshotId: snapshot.snapshotId,
    phaseHash: snapshot.phaseHash,
    snapshotTree: snapshot.tree,
    status: 'complete',
    mode: snapshot.reviewBasis ? 'incremental' : 'full',
    selected: ['correctness', 'simplicity'],
    lanes: [
      {name: 'correctness', status: 'complete'},
      {name: 'simplicity', status: 'complete'},
    ],
    findings: [],
  });
  const validation = (snapshot: Record<string, unknown>) => ({
    snapshotTree: snapshot.tree,
    reviewTree: snapshot.tree,
    status: 'passed',
    productState: 'working',
    checks: [{command: 'private flow', result: 'passed', evidence: 'Actual scoped source fixture.'}],
    acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Source readback.'}],
  });

  effectIt.effect('warns about an edit outside the plan and still accepts the reviewed tree', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* f.fs.writeFileString(f.path.join(f.repo, 'notes.md'), 'Unplanned note.\n');
      const recorded = object(
        yield* runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo}),
      );
      expect(recorded.warnings).toEqual([{_tag: 'warn', gate: 'scope.out-of-plan', detail: {files: ['notes.md']}}]);
      const snapshot = object(object(recorded.snapshot).snapshot);
      expect(snapshot.outOfPlan).toEqual(['notes.md']);
      yield* f.mutate('validate-review', {snapshotId: snapshot.snapshotId, attemptId: 'a1', report: review(snapshot)});
      const ready = yield* f.mutate('ready', {
        phaseId: 'one',
        snapshotId: snapshot.snapshotId,
        validation: validation(snapshot),
      });
      expect(ready).toMatchObject({
        status: 'ok',
        warnings: [{_tag: 'warn', gate: 'scope.out-of-plan', detail: {files: ['notes.md']}}],
      });
    }).pipe(runCycle),
  );

  effectIt.effect('keeps the phase pending across a path-only reconcile', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      const first = object(
        object(
          object(
            yield* runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo}),
          ).snapshot,
        ).snapshot,
      );
      yield* f.mutate('validate-review', {snapshotId: first.snapshotId, attemptId: 'a1', report: review(first)});
      const revised = yield* f.revise({
        phases: EffectArray.map(f.document.phases, phase => ({
          ...phase,
          affectedPaths: [...phase.affectedPaths, 'notes.md'],
        })),
      });
      const reconciled = yield* f.mutate('reconcile', {plan: revised, reason: 'Own the notes file.'});
      expect(reconciled.affected).toEqual([]);
      const after = object(
        object(
          object(
            yield* runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo}),
          ).snapshot,
        ).snapshot,
      );
      expect(after).toMatchObject({intentHash: first.intentHash, reviewBasis: {snapshotId: first.snapshotId}});
      expect(after.phaseHash).not.toBe(first.phaseHash);
    }).pipe(runCycle),
  );
});

describe('standard-profile reconcile of a phase with proof', () => {
  const validation = {
    checks: [{command: 'private flow', result: 'passed', evidence: 'Actual scoped source fixture.'}],
    acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Source readback.'}],
  };
  const setup = () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      const task = (command: string, fields: Record<string, unknown> = {}) =>
        runNativeTaskAction(f.config, {command, runId: 'native-run', callerCwd: f.repo, ...fields}).pipe(
          Effect.map(object),
        );
      const view = () => readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* f.git(['commit', '-qam', 'phase one']);
      const recorded = yield* task('record-snapshot');
      const snapshot = object(object(recorded.snapshot).snapshot);
      yield* f.mutate('validate-review', {
        snapshotId: snapshot.snapshotId,
        attemptId: 'a1',
        report: {
          snapshotId: snapshot.snapshotId,
          phaseHash: snapshot.phaseHash,
          snapshotTree: snapshot.tree,
          status: 'complete',
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        },
      });
      const validated = yield* task('record-validation', {snapshotRef: String(recorded.snapshotRef), validation});
      const pathOnly = f.revise({
        phases: EffectArray.map(f.document.phases, phase => ({
          ...phase,
          affectedPaths: [...phase.affectedPaths, 'notes.md'],
        })),
      });
      return {f, task, view, validated, pathOnly};
    });

  effectIt.effect('keeps a validated phase deliverable with its validation reference across a path-only edit', () =>
    Effect.gen(function* () {
      const {f, task, view, validated, pathOnly} = yield* setup();
      const reconciled = yield* f.mutate('reconcile', {plan: yield* pathOnly, reason: 'Own the notes file.'});
      expect(reconciled.affected).toEqual([]);
      expect((yield* view()).next).toMatchObject({action: 'deliver', phaseId: 'one'});
      expect(yield* task('deliver-local', {validationRef: String(validated.validationRef)})).toMatchObject({
        status: 'delivered',
      });
      expect((yield* view()).next).toMatchObject({action: 'complete'});
    }).pipe(runCycle),
  );

  effectIt.effect('keeps a delivered phase complete across a path-only edit', () =>
    Effect.gen(function* () {
      const {f, task, view, validated, pathOnly} = yield* setup();
      yield* task('deliver-local', {validationRef: String(validated.validationRef)});
      const reconciled = yield* f.mutate('reconcile', {plan: yield* pathOnly, reason: 'Own the notes file.'});
      expect(reconciled.affected).toEqual([]);
      expect((yield* view()).next).toMatchObject({action: 'complete'});
    }).pipe(runCycle),
  );

  effectIt.effect('names reopen as the recovery when the validated source or base changed before delivery', () =>
    Effect.gen(function* () {
      const {f, task, view, validated} = yield* setup();
      const deliver = () => task('deliver-local', {validationRef: String(validated.validationRef)}).pipe(Effect.flip);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 2;\n');
      yield* f.git(['commit', '-qam', 'late fix']);
      const card = yield* view();
      expect(card.next).toMatchObject({action: 'deliver', phaseId: 'one'});
      const reopen = {
        tool: 'workflow_task_control',
        command: 'reopen',
        arguments: {taskRef: card.taskRef, control: {command: 'reopen', phaseId: 'one'}},
      };
      expect(yield* deliver()).toMatchObject({code: 'source-drift', next: reopen});
      const snapshot = yield* task('record-snapshot').pipe(Effect.flip);
      expect(snapshot).toMatchObject({code: 'task-not-ready', next: reopen});
      expect(snapshot.message).not.toMatch(/validation reference/iu);
      yield* f.git(['checkout', '-q', 'main']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.md'), 'Upstream work.\n');
      yield* f.git(['add', 'upstream.md']);
      yield* f.git(['commit', '-qm', 'upstream']);
      yield* f.git(['checkout', '-q', 'feature/one']);
      const moved = yield* deliver();
      expect(moved).toMatchObject({code: 'review-stale', next: reopen});
      expect(moved.next?.cli).toContain('--phase-id one');
      expect(
        yield* task('reopen', {taskRef: card.taskRef, phaseId: 'one', reason: 'The source changed after validation.'}),
      ).toMatchObject({status: 'reopened'});
      yield* task('resume', {taskRef: (yield* view()).taskRef, reason: 'Record the changed tree.'});
      yield* task('record-snapshot');
      expect((yield* view()).next).toMatchObject({action: 'review', phaseId: 'one'});
    }).pipe(runCycle),
  );

  effectIt.effect('keeps a validated phase deliverable across an undelivered base-only reconcile', () =>
    Effect.gen(function* () {
      const {f, task, validated} = yield* setup();
      yield* f.git(['branch', 'release', 'main']);
      const rebound = yield* f.revise({}, {one: {branch: 'feature/one', baseBranch: 'release'}});
      expect((yield* f.mutate('reconcile', {plan: rebound, reason: 'Target the release branch.'})).affected).toEqual(
        [],
      );
      expect(yield* task('deliver-local', {validationRef: String(validated.validationRef)})).toMatchObject({
        status: 'delivered',
      });
    }).pipe(runCycle),
  );
});

describe('reconcile of strict proof after a switch to standard', () => {
  type Phase = Effect.Success<ReturnType<typeof cycleFixture>>['document']['phases'][number];
  const reconcileAfterSwitch = (delivered: boolean, change: (phase: Phase) => Partial<Phase>) =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(['one'], 'local');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      const recorded = yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'strict-1'});
      const snapshot = object(object(recorded.snapshot).snapshot);
      yield* f.mutate('validate-review', {
        snapshotId: snapshot.snapshotId,
        attemptId: 'a1',
        report: {
          snapshotId: snapshot.snapshotId,
          phaseHash: snapshot.phaseHash,
          snapshotTree: snapshot.tree,
          status: 'complete',
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        },
      });
      yield* f.mutate('ready', {
        phaseId: 'one',
        snapshotId: snapshot.snapshotId,
        validation: {
          snapshotTree: snapshot.tree,
          reviewTree: snapshot.tree,
          status: 'passed',
          productState: 'working',
          checks: [{command: 'private flow', result: 'passed', evidence: 'Actual scoped source fixture.'}],
          acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Source readback.'}],
        },
      });
      yield* f.git(['commit', '-qam', 'phase one']);
      if (delivered)
        yield* f.mutate('record-delivery', {
          phaseId: 'one',
          delivery: {
            phaseId: 'one',
            phaseHash: snapshot.phaseHash,
            delivery: 'local',
            headSha: EffectString.trim(String((yield* f.git(['rev-parse', 'HEAD'])).stdout)),
            validatedTree: snapshot.tree,
          },
        });
      yield* runNativeTaskAction(f.config, {
        command: 'set-profile',
        runId: 'native-run',
        callerCwd: f.repo,
        profile: 'standard',
        reason: 'Loosen the running task.',
        userAuthority: 'User: loosen this run.',
      });
      const plan = yield* f.revise({
        phases: EffectArray.map(f.document.phases, phase => ({...phase, ...change(phase)})),
      });
      const reconciled = yield* f.mutate('reconcile', {plan, reason: 'Revise the plan.'});
      const phase = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.phases.one;
      return {affected: reconciled.affected, status: phase?.status, proof: phase?.validation !== undefined};
    });
  const intentAndPaths = (phase: Phase) => ({
    outcome: 'Phase works and also does something materially different.',
    acceptance: EffectArray.map(phase.acceptance, item => ({...item, verification: 'Exercise another flow.'})),
    affectedPaths: [...phase.affectedPaths, 'notes.md'],
  });

  for (const delivered of [false, true])
    effectIt.effect(
      `retires ${delivered ? 'delivered' : 'validated'} proof when the intent changed beside a path edit`,
      () =>
        reconcileAfterSwitch(delivered, intentAndPaths).pipe(
          Effect.map(result => expect(result).toEqual({affected: ['one'], status: 'stale', proof: false})),
          runCycle,
        ),
    );

  effectIt.effect('keeps validated proof across a path-only edit', () =>
    reconcileAfterSwitch(false, phase => ({affectedPaths: [...phase.affectedPaths, 'notes.md']})).pipe(
      Effect.map(result => expect(result).toEqual({affected: [], status: 'validated', proof: true})),
      runCycle,
    ),
  );
});

describe('standard-profile delivery of a dirty-recorded tree', () => {
  for (const [label, bindings] of [
    ['a phase branch', undefined],
    ['the base branch itself', {one: {branch: 'feature/one', baseBranch: 'feature/one'}}],
  ] as const)
    effectIt.effect(`delivers a validated dirty tree on ${label} once that exact tree is committed`, () =>
      Effect.gen(function* () {
        const f = yield* cycleFixture(
          ['one'],
          'local',
          false,
          false,
          true,
          bindings,
          undefined,
          {},
          {policy: 'standard'},
        );
        const task = (command: string, fields: Record<string, unknown> = {}) =>
          runNativeTaskAction(f.config, {command, runId: 'native-run', callerCwd: f.repo, ...fields}).pipe(
            Effect.map(object),
          );
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
        const recorded = yield* task('record-snapshot');
        const snapshot = object(object(recorded.snapshot).snapshot);
        expect(snapshot.dirty).toBe(true);
        yield* f.mutate('validate-review', {
          snapshotId: snapshot.snapshotId,
          attemptId: 'a1',
          report: {
            snapshotId: snapshot.snapshotId,
            phaseHash: snapshot.phaseHash,
            snapshotTree: snapshot.tree,
            status: 'complete',
            mode: 'full',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings: [],
          },
        });
        const validated = yield* task('record-validation', {
          snapshotRef: recorded.snapshotRef,
          validation: {
            checks: [{command: 'private flow', result: 'passed', evidence: 'Actual scoped source fixture.'}],
            acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Source readback.'}],
          },
        });
        const uncommitted = yield* task('deliver-local', {validationRef: validated.validationRef}).pipe(Effect.flip);
        expect(uncommitted).toMatchObject({
          code: 'source-drift',
          next: {tool: 'workflow_task_deliver', command: 'deliver-local'},
        });
        expect(uncommitted.message).toMatch(/commit/iu);
        yield* f.git(['commit', '-qam', 'phase one']);
        const head = EffectString.trim(String((yield* f.git(['rev-parse', 'HEAD'])).stdout));
        const delivered = yield* task('deliver-local', {validationRef: validated.validationRef});
        expect(delivered).toMatchObject({
          status: 'delivered',
          replayed: false,
          receipt: {headSha: head, validatedTree: snapshot.tree},
        });
        // Delivery moved the validation to the commit; the reference from before it still replays the delivery.
        expect(yield* task('deliver-local', {validationRef: validated.validationRef})).toEqual({
          ...delivered,
          replayed: true,
        });
        expect((yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).next).toMatchObject({
          action: 'complete',
        });
      }).pipe(runCycle),
    );
});

describe('actionable refusals', () => {
  effectIt.effect('points a review without a review card at the action on the current card', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      const refusal = yield* runNativeTaskAction(f.config, {
        command: 'record-review',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: 'not-a-snapshot-ref',
        report: {},
      }).pipe(Effect.flip);
      expect(refusal).toMatchObject({
        next: {
          tool: 'workflow_task_snapshot',
          command: 'record',
          arguments: {runId: 'native-run', callerCwd: f.repo, snapshot: {command: 'record'}},
        },
      });
      expect(refusal.next?.cli).toContain('task-action record-snapshot --run-id native-run');
    }).pipe(runCycle),
  );
});

describe('audited waivers', () => {
  const validation = {
    checks: [{command: 'private flow', result: 'passed', evidence: 'Actual scoped source fixture.'}],
    acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Source readback.'}],
  };
  const waive = (f: {readonly config: RuntimeConfig; readonly repo: string}) =>
    runNativeTaskAction(f.config, {
      command: 'waive',
      runId: 'native-run',
      callerCwd: f.repo,
      gate: 'review.required',
      reason: 'The review tool is unavailable for this local fixture.',
      userAuthority: 'User: ship this local change without a review.',
    }).pipe(Effect.map(object));

  effectIt.effect('delivers an unreviewed tree only after a recorded waiver for that exact tree', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'one']);
      const recorded = object(
        yield* runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo}),
      );
      const validate = () =>
        runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(recorded.snapshotRef),
          validation,
        });
      expect(yield* validate().pipe(Effect.flip)).toMatchObject({
        code: 'review-pending',
        gate: 'review.required',
        next: {tool: 'workflow_task_control', command: 'waive', arguments: {control: {gate: 'review.required'}}},
      });
      const first = yield* waive(f);
      expect(first).toMatchObject({status: 'waived', replayed: false, waiver: {gate: 'review.required'}});
      const repeated = yield* waive(f);
      expect(repeated).toMatchObject({replayed: true, revision: first.revision, waiver: first.waiver});
      const validated = object(yield* validate());
      const delivered = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-local',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: String(validated.validationRef),
        }),
      );
      expect(object(validated.validation).waiverId).toBe(object(first.waiver).id);
      expect(delivered).toMatchObject({
        status: 'delivered',
        waivers: [first.waiver],
        coveringWaiverId: object(first.waiver).id,
      });
    }).pipe(runCycle),
  );

  effectIt.effect('lets an MCP caller run the next command of a refusal as given', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      const mcp = new EffectMcpServerAdapter('test', '1', 'workflow next fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const invoke = (tool: string, input: unknown) =>
        mcp.invokeTool(tool, object(input)).pipe(
          Effect.matchCauseEffect({onFailure: mcpToolFailureResult, onSuccess: Effect.succeed}),
          Effect.map(result => object(object(result).structuredContent)),
        );
      const fill = (value: unknown, values: Readonly<Record<string, string>>): unknown =>
        typeof value === 'string' && /^<[A-Za-z]+>$/u.test(value)
          ? (values[EffectString.slice(1, -1)(value)] ?? value)
          : EffectArray.isArray(value)
            ? EffectArray.map(value, item => fill(item, values))
            : Predicate.isObject(value)
              ? EffectRecord.map(value as Record<string, unknown>, item => fill(item, values))
              : value;
      const scope = {runId: 'native-run', callerCwd: f.repo};
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* f.git(['commit', '-qam', 'one']);
      const recorded = yield* invoke('workflow_task_snapshot', {...scope, snapshot: {command: 'record'}});
      const refused = yield* invoke('workflow_task_record_validation', {
        ...scope,
        snapshotRef: recorded.snapshotRef,
        ...validation,
      });
      expect(refused).toMatchObject({code: 'review-pending', next: {tool: 'workflow_task_control'}});
      const next = object(refused.next);
      expect(next.arguments).not.toHaveProperty('taskRef');
      const authority = {reason: 'No reviewer is available.', userAuthority: 'User: ship it unreviewed.'};
      expect(yield* invoke(String(next.tool), fill(next.arguments, authority))).toMatchObject({status: 'waived'});
      const card = yield* invoke('workflow_task_view', scope);
      const snapshotRef = object(object(card.phase).snapshot).snapshotRef;
      expect(snapshotRef).toMatch(/^taskref-/u);
      expect(card.next).toMatchObject({
        action: 'validate',
        tool: 'workflow_task_record_validation',
        arguments: {...scope, snapshotRef, checks: '<checks>', acceptance: '<acceptance>'},
      });
      const control = (profile: 'standard' | 'strict') => ({
        ...scope,
        control: {command: 'set-profile', profile, reason: 'Release work needs every gate.'},
      });
      expect(yield* invoke('workflow_task_control', control('strict'))).toMatchObject({status: 'changed'});
      const loosen = object((yield* invoke('workflow_task_control', control('standard'))).next);
      expect(yield* invoke(String(loosen.tool), fill(loosen.arguments, authority))).toMatchObject({
        status: 'changed',
        profile: 'standard',
      });
    }).pipe(runCycle),
  );

  effectIt.effect('refuses a waiver of a gate that no decision consults', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo});
      const before = yield* f.fs.readFileString(f.statePath());
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'waive',
          runId: 'native-run',
          callerCwd: f.repo,
          gate: 'validation.required',
          reason: 'No validation is possible here.',
          userAuthority: 'User: skip validation.',
        }).pipe(Effect.flip),
      ).toMatchObject({code: 'invalid-request'});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(runCycle),
  );

  effectIt.effect('moves the card to validation once a review.blocking waiver covers the blocked tree', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      const view = () => readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* f.git(['commit', '-qam', 'one']);
      const recorded = object(
        yield* runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo}),
      );
      const snapshot = object(object(recorded.snapshot).snapshot);
      yield* f.mutate('validate-review', {
        snapshotId: snapshot.snapshotId,
        attemptId: 'a1',
        report: {
          snapshotId: snapshot.snapshotId,
          phaseHash: snapshot.phaseHash,
          snapshotTree: snapshot.tree,
          status: 'complete',
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [
            {
              id: 'f1',
              file: 'source.ts',
              line: 1,
              body: 'Wrong value.',
              trigger: 'Always.',
              impact: 'Breaks.',
              evidence: 'Read it.',
              severity: 'important',
              category: 'correctness',
              confidence: 90,
              state: 'new',
            },
          ],
        },
      });
      const validate = () =>
        runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(recorded.snapshotRef),
          validation,
        });
      expect((yield* view()).next).toMatchObject({action: 'implement'});
      expect(yield* validate().pipe(Effect.flip)).toMatchObject({
        gate: 'review.blocking',
        next: {command: 'waive', arguments: {control: {gate: 'review.blocking'}}},
      });
      yield* runNativeTaskAction(f.config, {
        command: 'waive',
        runId: 'native-run',
        callerCwd: f.repo,
        gate: 'review.blocking',
        reason: 'The finding is accepted for this local fixture.',
        userAuthority: 'User: ship it with the known finding.',
      });
      expect((yield* view()).next).toMatchObject({action: 'validate', snapshotId: snapshot.snapshotId});
      expect(object(yield* validate())).toMatchObject({status: 'recorded'});
    }).pipe(runCycle),
  );

  effectIt.effect('replays a waiver for a later snapshot of the same tree and lists it in a commit delivery', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'commit',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      const record = () =>
        runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo}).pipe(
          Effect.map(object),
        );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* f.git(['commit', '-qam', 'one']);
      yield* record();
      const first = yield* waive(f);
      const revised = yield* f.revise({
        phases: EffectArray.map(f.document.phases, phase => ({
          ...phase,
          affectedPaths: [...phase.affectedPaths, 'notes.md'],
        })),
      });
      yield* f.mutate('reconcile', {plan: revised, reason: 'Own the notes file.'});
      const again = yield* record();
      expect(object(object(again.snapshot).snapshot).snapshotId).not.toBe(object(first.waiver).snapshotId);
      expect(yield* waive(f)).toMatchObject({status: 'waived', replayed: true, waiver: first.waiver});
      const validated = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(again.snapshotRef),
          validation,
        }),
      );
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-commit',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: String(validated.validationRef),
          commitEvidence: 'Verified fixture commit ' + EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout),
        }),
      ).toMatchObject({status: 'delivered', waivers: [first.waiver]});
    }).pipe(runCycle),
  );

  effectIt.effect('refuses a waiver past the retained limit before saving', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo});
      const stored = yield* readNativeWorkflowState(f.config, 'native-run');
      const cycle = stored?.state.cycle;
      const snapshot = cycle?.snapshots.at(-1)?.snapshot;
      if (!stored || !cycle || !snapshot) throw new Error('Expected a recorded snapshot.');
      const waivers = EffectArray.makeBy(128, index => {
        const fields = {
          gate: 'review.blocking' as const,
          phaseId: snapshot.phaseId,
          snapshotId: snapshot.snapshotId,
          tree: snapshot.tree,
          intentHash: snapshot.intentHash ?? snapshot.phaseHash,
          reason: `Fixture waiver ${index}.`,
          userAuthority: 'User: fixture authority.',
        };
        return {id: nativeCycleWaiverId(fields), ...fields};
      });
      yield* writeNativeWorkflowState(f.config, {...stored.state, cycle: {...cycle, waivers}}, stored.revision);
      const before = yield* f.fs.readFileString(f.statePath());
      expect(yield* waive(f).pipe(Effect.flip)).toMatchObject({
        code: 'waiver-capacity',
        detail: {limit: 128},
        next: {tool: 'workflow_task_view'},
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(runCycle),
  );

  effectIt.effect('does not carry a waiver to a changed tree', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      const record = () =>
        runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo}).pipe(
          Effect.map(object),
        );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* record();
      yield* waive(f);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 2;\n');
      const changed = yield* record();
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(changed.snapshotRef),
          validation,
        }).pipe(Effect.flip),
      ).toMatchObject({code: 'review-pending', gate: 'review.required'});
    }).pipe(runCycle),
  );
  effectIt.effect('does not carry a waiver across a change of the phase intent', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      const record = () =>
        runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo}).pipe(
          Effect.map(object),
        );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* f.git(['commit', '-qam', 'phase one']);
      const first = object(object((yield* record()).snapshot).snapshot);
      yield* waive(f);
      const revised = yield* f.revise({
        phases: EffectArray.map(f.document.phases, phase => ({
          ...phase,
          outcome: 'Phase works and also does something materially different.',
          acceptance: EffectArray.map(phase.acceptance, item => ({...item, verification: 'Exercise another flow.'})),
        })),
      });
      expect((yield* f.mutate('reconcile', {plan: revised, reason: 'The phase intent changed.'})).affected).toEqual([
        'one',
      ]);
      yield* f.mutate('resume-phase', {phaseId: 'one', reason: 'The phase intent was reconciled.'});
      const changed = yield* record();
      const snapshot = object(object(changed.snapshot).snapshot);
      expect(snapshot).toMatchObject({tree: first.tree});
      expect(snapshot.intentHash).not.toBe(first.intentHash);
      expect((yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).next).toMatchObject({
        action: 'review',
        snapshotId: snapshot.snapshotId,
      });
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(changed.snapshotRef),
          validation,
        }).pipe(Effect.flip),
      ).toMatchObject({code: 'review-pending', gate: 'review.required'});
    }).pipe(runCycle),
  );
});

describe('review coverage under one intent', () => {
  const validation = {
    checks: [{command: 'private flow', result: 'passed', evidence: 'Actual scoped source fixture.'}],
    acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Source readback.'}],
  };
  const blocker = (id: string, state = 'new') => ({
    id,
    file: 'source.ts',
    line: 1,
    body: 'The helper is wrong.',
    trigger: 'Always.',
    impact: 'Breaks the phase.',
    evidence: 'Read it.',
    severity: 'important',
    category: 'correctness',
    confidence: 90,
    state,
  });
  const setup = () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      const task = (command: string, fields: Record<string, unknown> = {}) =>
        runNativeTaskAction(f.config, {command, runId: 'native-run', callerCwd: f.repo, ...fields}).pipe(
          Effect.map(object),
        );
      const view = () => readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      const commit = (text: string) =>
        Effect.gen(function* () {
          yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), text);
          yield* f.git(['commit', '-qam', 'phase change']);
          const recorded = yield* task('record-snapshot');
          return {ref: String(recorded.snapshotRef), snapshot: object(object(recorded.snapshot).snapshot)};
        });
      const review = (snapshot: Record<string, unknown>, attemptId: string, findings: readonly unknown[] = []) =>
        f.mutate('validate-review', {
          snapshotId: snapshot.snapshotId,
          attemptId,
          report: {
            snapshotId: snapshot.snapshotId,
            phaseHash: snapshot.phaseHash,
            snapshotTree: snapshot.tree,
            status: 'complete',
            mode: snapshot.reviewBasis ? 'incremental' : 'full',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings,
          },
        });
      return {f, task, view, commit, review};
    });

  effectIt.effect('does not let an earlier clean review answer for a later review that recorded a blocker', () =>
    Effect.gen(function* () {
      const {f, task, view, commit, review} = yield* setup();
      const first = yield* commit('export const helper = 1;\nexport const fixture = 1;\n');
      yield* review(first.snapshot, 'a1');
      const second = yield* commit('export const helper = 1;\nexport const fixture = 2;\n');
      yield* review(second.snapshot, 'a2', [blocker('f1')]);
      const reverted = yield* commit('export const helper = 1;\nexport const fixture = 1;\n');
      expect(reverted.snapshot.tree).toBe(first.snapshot.tree);
      expect((yield* view()).next).toMatchObject({action: 'review', snapshotId: reverted.snapshot.snapshotId});
      // The latest snapshot of the phase decides coverage, so the earlier snapshot of the same tree cannot validate it.
      for (const ref of [reverted.ref, first.ref])
        expect(yield* task('record-validation', {snapshotRef: ref, validation}).pipe(Effect.flip)).toMatchObject({
          code: 'review-pending',
        });
      const ready = yield* f
        .mutate('ready', {
          phaseId: 'one',
          snapshotId: first.snapshot.snapshotId,
          acceptedHead: EffectString.trim(String((yield* f.git(['rev-parse', 'HEAD'])).stdout)),
          validation: {snapshotTree: first.snapshot.tree, status: 'passed', productState: 'working', ...validation},
        })
        .pipe(Effect.flip);
      expect(ready).toMatchObject({code: 'review-pending'});
    }).pipe(runCycle),
  );

  effectIt.effect('validates only the latest snapshot of a phase once a later one recorded another tree', () =>
    Effect.gen(function* () {
      const {f, task, commit, review} = yield* setup();
      const first = yield* commit('export const fixture = 1;\n');
      yield* review(first.snapshot, 'a1');
      yield* commit('export const fixture = 2;\n');
      // The source returns to the first tree without a new snapshot.
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
      yield* f.git(['commit', '-qam', 'revert']);
      expect(yield* task('record-validation', {snapshotRef: first.ref, validation}).pipe(Effect.flip)).toMatchObject({
        code: 'stale-snapshot-ref',
        next: {command: 'view'},
      });
    }).pipe(runCycle),
  );

  effectIt.effect('takes the newest review of the same tree, so a later blocker outranks an earlier clean review', () =>
    Effect.gen(function* () {
      const {f, task, commit, review} = yield* setup();
      const first = yield* commit('export const fixture = 1;\n');
      yield* review(first.snapshot, 'a1');
      // Each move of the declared base records a new snapshot of the same tree.
      const sameTreeAfterBaseMove = (name: string) =>
        Effect.gen(function* () {
          yield* f.git(['checkout', '-q', 'main']);
          yield* f.fs.writeFileString(f.path.join(f.repo, name), 'Upstream work.\n');
          yield* f.git(['add', name]);
          yield* f.git(['commit', '-qm', 'upstream']);
          yield* f.git(['checkout', '-q', 'feature/one']);
          const recorded = yield* task('record-snapshot');
          const snapshot = object(object(recorded.snapshot).snapshot);
          expect(snapshot.tree).toBe(first.snapshot.tree);
          return {ref: String(recorded.snapshotRef), snapshot};
        });
      const second = yield* sameTreeAfterBaseMove('upstream-1.md');
      yield* review(second.snapshot, 'a2', [blocker('f1')]);
      const third = yield* sameTreeAfterBaseMove('upstream-2.md');
      expect(yield* task('record-validation', {snapshotRef: third.ref, validation}).pipe(Effect.flip)).toMatchObject({
        code: 'review-blocked',
        gate: 'review.blocking',
      });
    }).pipe(runCycle),
  );

  effectIt.effect('answers a stale validation reference with the current one the deliver card carries', () =>
    Effect.gen(function* () {
      const {task, view, commit, review} = yield* setup();
      const first = yield* commit('export const fixture = 1;\n');
      yield* review(first.snapshot, 'a1');
      const earlier = yield* task('record-validation', {snapshotRef: first.ref, validation});
      expect((yield* view()).phase?.validationRef).toBe(earlier.validationRef);
      yield* task('reopen', {taskRef: (yield* view()).taskRef, phaseId: 'one', reason: 'Look again.'});
      yield* task('resume', {taskRef: (yield* view()).taskRef, reason: 'Validate again.'});
      const again = yield* task('record-snapshot');
      const current = yield* task('record-validation', {
        snapshotRef: again.snapshotRef,
        validation: {...validation, checks: [{...validation.checks[0], evidence: 'A second scoped run.'}]},
      });
      expect((yield* view()).phase?.validationRef).toBe(current.validationRef);
      const stale = yield* task('deliver-local', {validationRef: earlier.validationRef}).pipe(Effect.flip);
      expect(stale).toMatchObject({
        code: 'stale-validation-ref',
        next: {command: 'deliver-local', arguments: {delivery: {validationRef: current.validationRef}}},
      });
      expect(yield* task('deliver-local', {validationRef: current.validationRef})).toMatchObject({status: 'delivered'});
    }).pipe(runCycle),
  );

  effectIt.effect('refuses a review.blocking waiver until a recorded review of the tree has blockers', () =>
    Effect.gen(function* () {
      const {f, task, commit, review} = yield* setup();
      const first = yield* commit('export const fixture = 1;\n');
      const accept = {gate: 'review.blocking', reason: 'Accept whatever comes.', userAuthority: 'User: fine.'};
      expect(yield* task('waive', accept).pipe(Effect.flip)).toMatchObject({
        code: 'invalid-waiver',
        next: {command: 'record-review'},
      });
      yield* review(first.snapshot, 'a1');
      expect(yield* task('waive', accept).pipe(Effect.flip)).toMatchObject({
        code: 'invalid-waiver',
        next: {command: 'view'},
      });
      expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.waivers ?? []).toEqual([]);
    }).pipe(runCycle),
  );

  effectIt.effect('binds a review.blocking waiver to the blocked review it accepted', () =>
    Effect.gen(function* () {
      const {task, view, commit, review} = yield* setup();
      const first = yield* commit('export const fixture = 1;\n');
      yield* review(first.snapshot, 'a1', [blocker('f1')]);
      const accept = {gate: 'review.blocking', reason: 'Accept the helper finding.', userAuthority: 'User: ship it.'};
      const waived = yield* task('waive', accept);
      yield* task('record-validation', {snapshotRef: first.ref, validation});
      yield* task('reopen', {taskRef: (yield* view()).taskRef, phaseId: 'one', reason: 'Look again.'});
      yield* task('resume', {taskRef: (yield* view()).taskRef, reason: 'Review the same tree again.'});
      const again = yield* task('record-snapshot');
      const second = object(object(again.snapshot).snapshot);
      expect(second.tree).toBe(first.snapshot.tree);
      yield* review(second, 'a2', [blocker('f1', 'carried'), blocker('f2')]);
      const validate = () => task('record-validation', {snapshotRef: String(again.snapshotRef), validation});
      expect(yield* validate().pipe(Effect.flip)).toMatchObject({code: 'review-blocked', gate: 'review.blocking'});
      const rewaived = yield* task('waive', accept);
      expect(rewaived).toMatchObject({status: 'waived', replayed: false});
      expect(object(rewaived.waiver).id).not.toBe(object(waived.waiver).id);
      expect(yield* validate()).toMatchObject({status: 'recorded'});
    }).pipe(runCycle),
  );
});

describe('incremental review by default', () => {
  const report = (snapshot: Record<string, unknown>) => ({
    snapshotId: snapshot.snapshotId,
    phaseHash: snapshot.phaseHash,
    snapshotTree: snapshot.tree,
    status: 'complete',
    mode: snapshot.reviewBasis ? 'incremental' : 'full',
    selected: ['correctness', 'simplicity'],
    lanes: [
      {name: 'correctness', status: 'complete'},
      {name: 'simplicity', status: 'complete'},
    ],
    findings: [],
  });
  const setup = (initial: string | Uint8Array = 'export const fixture = 1;\n') =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      const record = () =>
        runNativeTaskAction(f.config, {command: 'record-snapshot', runId: 'native-run', callerCwd: f.repo}).pipe(
          Effect.map(result => object(object(object(result).snapshot).snapshot)),
        );
      const view = () => readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo, role: 'review'});
      yield* typeof initial === 'string'
        ? f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), initial)
        : f.fs.writeFile(f.path.join(f.repo, 'source.ts'), initial);
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'phase one']);
      const reviewed = yield* record();
      yield* f.mutate('validate-review', {snapshotId: reviewed.snapshotId, attemptId: 'a1', report: report(reviewed)});
      // Move the base: a new upstream commit on main that does not touch the phase file.
      yield* f.git(['checkout', '-q', 'main']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.md'), 'Upstream work.\n');
      yield* f.git(['add', 'upstream.md']);
      yield* f.git(['commit', '-m', 'upstream']);
      yield* f.git(['checkout', '-q', 'feature/one']);
      return {f, record, view, reviewed};
    });

  effectIt.effect('reuses the review after a clean rebase and asks only for validation', () =>
    Effect.gen(function* () {
      const {f, record, view, reviewed} = yield* setup();
      yield* f.git(['rebase', '-q', 'main']);
      const rebased = yield* record();
      expect(rebased.changeDigest).toBe(reviewed.changeDigest);
      expect(rebased.scopeBase).not.toBe(reviewed.scopeBase);
      expect((yield* view()).next).toMatchObject({action: 'validate', snapshotId: rebased.snapshotId});
    }).pipe(runCycle),
  );

  effectIt.effect('records the same tree again when the base moved without a rebase, then validates it', () =>
    Effect.gen(function* () {
      const {f, record, view, reviewed} = yield* setup();
      expect((yield* view()).next).toMatchObject({action: 'implement'});
      const again = yield* record();
      expect(again.snapshotId).not.toBe(reviewed.snapshotId);
      expect(again).toMatchObject({tree: reviewed.tree, scopeBase: reviewed.scopeBase});
      expect(again.declaredBaseHead).not.toBe(reviewed.declaredBaseHead);
      const card = yield* view();
      expect(card.next).toMatchObject({action: 'validate', snapshotId: again.snapshotId});
      const task = (command: string, fields: Record<string, unknown>) =>
        runNativeTaskAction(f.config, {command, runId: 'native-run', callerCwd: f.repo, ...fields}).pipe(
          Effect.map(object),
        );
      const validated = yield* task('record-validation', {
        snapshotRef: card.phase?.snapshot?.snapshotRef,
        validation: {
          checks: [{command: 'private flow', result: 'passed', evidence: 'Actual scoped source fixture.'}],
          acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Source readback.'}],
        },
      });
      expect(yield* task('deliver-local', {validationRef: validated.validationRef})).toMatchObject({
        status: 'delivered',
      });
    }).pipe(runCycle),
  );

  effectIt.effect('restarts with a full review when the rebased patch changed', () =>
    Effect.gen(function* () {
      const {f, record, view, reviewed} = yield* setup();
      yield* f.git(['rebase', '-q', 'main']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 2;\n');
      const changed = yield* record();
      expect(changed.changeDigest).not.toBe(reviewed.changeDigest);
      expect(changed).not.toHaveProperty('reviewBasis');
      expect((yield* view()).next).toMatchObject({action: 'review', snapshotId: changed.snapshotId});
    }).pipe(runCycle),
  );

  // git patch-id ignores whitespace inside a line, and a decoded diff loses bytes that are not valid UTF-8.
  for (const [label, initial, edited] of [
    ['whitespace inside a line', 'export const fixture = "a b";\n', 'export const fixture = "ab";\n'],
    ['a byte that is not valid UTF-8', Uint8Array.of(0x2f, 0x2f, 0xe9, 0x0a), Uint8Array.of(0x2f, 0x2f, 0xe8, 0x0a)],
  ] as const)
    effectIt.effect(`restarts with a full review when a rebased change differs only by ${label}`, () =>
      Effect.gen(function* () {
        const {f, record, view, reviewed} = yield* setup(initial);
        yield* f.git(['rebase', '-q', 'main']);
        yield* typeof edited === 'string'
          ? f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), edited)
          : f.fs.writeFile(f.path.join(f.repo, 'source.ts'), edited);
        yield* f.git(['commit', '-qam', 'edit the reviewed change']);
        const changed = yield* record();
        expect(changed.changeDigest).not.toBe(reviewed.changeDigest);
        expect(changed).not.toHaveProperty('reviewBasis');
        expect((yield* view()).next).toMatchObject({action: 'review', snapshotId: changed.snapshotId});
      }).pipe(runCycle),
    );

  effectIt.effect('reviews only the increment after a path-only reconcile', () =>
    Effect.gen(function* () {
      const {f, record, view, reviewed} = yield* setup();
      const revised = yield* f.revise({
        phases: EffectArray.map(f.document.phases, phase => ({
          ...phase,
          affectedPaths: [...phase.affectedPaths, 'notes.md'],
        })),
      });
      yield* f.mutate('reconcile', {plan: revised, reason: 'Own the notes file.'});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 3;\n');
      const next = yield* record();
      expect(next).toMatchObject({reviewBasis: {snapshotId: reviewed.snapshotId}});
      expect((yield* view()).phase?.snapshot).toMatchObject({recordingMode: 'incremental'});
    }).pipe(runCycle),
  );
});

describe('issue #1074 acceptance', () => {
  effectIt.effect(
    'replays snapshot, unplanned edit, snapshot, rebase onto a moved base and snapshot without refusal',
    () =>
      Effect.gen(function* () {
        const f = yield* cycleFixture(
          ['one'],
          'local',
          false,
          false,
          true,
          undefined,
          undefined,
          {},
          {policy: 'standard'},
        );
        const record = (reason: string) =>
          runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            reason,
          }).pipe(Effect.map(result => object(object(object(result).snapshot).snapshot)));
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = 1;\n');
        const first = yield* record('first source');
        yield* f.fs.writeFileString(f.path.join(f.repo, 'notes.md'), 'Outside the planned paths.\n');
        const second = yield* record('edit outside the plan');
        expect(second).toMatchObject({supersedes: first.snapshotId, outOfPlan: ['notes.md']});
        yield* f.git(['add', '-A']);
        yield* f.git(['commit', '-m', 'phase work']);
        yield* f.git(['checkout', '-q', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.md'), 'Moved base.\n');
        yield* f.git(['add', 'upstream.md']);
        yield* f.git(['commit', '-m', 'move the base']);
        yield* f.git(['checkout', '-q', 'feature/one']);
        yield* f.git(['rebase', '-q', 'main']);
        const third = yield* record('rebased onto the moved base');
        expect(third).toMatchObject({version: 4, supersedes: second.snapshotId, outOfPlan: ['notes.md']});
        expect(third.scopeBase).not.toBe(second.scopeBase);
      }).pipe(runCycle),
  );
});

describe('workflow profile switch', () => {
  effectIt.effect('tightens with a reason, replays, and loosens only with user authority', () =>
    Effect.gen(function* () {
      const f = yield* cycleFixture(
        ['one'],
        'local',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {policy: 'standard'},
      );
      const setProfile = (profile: 'standard' | 'strict', userAuthority?: string) =>
        runNativeTaskAction(f.config, {
          command: 'set-profile',
          runId: 'native-run',
          callerCwd: f.repo,
          profile,
          reason: 'Release work needs every gate.',
          ...(userAuthority === undefined ? {} : {userAuthority}),
        });
      const strict = object(yield* setProfile('strict'));
      expect(strict).toMatchObject({status: 'changed', profile: 'strict', from: 'standard'});
      expect(object(yield* setProfile('strict'))).toMatchObject({status: 'unchanged', revision: strict.revision});
      expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.state.policy).toMatchObject({mode: 'strict'});
      expect(yield* setProfile('standard').pipe(Effect.flip)).toMatchObject({
        code: 'profile-authority-required',
        next: {command: 'set-profile'},
      });
      expect(object(yield* setProfile('standard', 'User: loosen this run again.'))).toMatchObject({
        status: 'changed',
        profile: 'standard',
        policy: {userAuthority: 'User: loosen this run again.'},
      });
    }).pipe(runCycle),
  );
});
