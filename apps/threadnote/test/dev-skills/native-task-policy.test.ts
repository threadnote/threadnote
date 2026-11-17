import {Array as EffectArray, Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {EffectMcpServerAdapter, mcpToolFailureResult} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
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
        phases: EffectArray.map(f.document.phases, phase => ({
          ...phase,
          affectedPaths: [...phase.affectedPaths, 'notes.md'],
        })),
      });
      yield* f.mutate('reconcile', {plan: revised, reason: 'Own the notes file.'});
      yield* f.mutate('resume-phase', {phaseId: 'one', reason: 'The plan paths were reconciled.'});
      const after = yield* record(f);
      expect(after).toMatchObject({version: 4, supersedes: second.snapshotId});
      expect(after.phaseHash).not.toBe(second.phaseHash);
      const view = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(view.next).toMatchObject({action: 'review', snapshotId: after.snapshotId});
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
