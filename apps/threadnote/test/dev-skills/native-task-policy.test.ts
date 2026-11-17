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
        next: {tool: 'workflow_task_snapshot', command: 'record', args: {runId: 'native-run', callerCwd: f.repo}},
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
        next: {tool: 'workflow_task_control', command: 'waive', args: {gate: 'review.required'}},
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
      expect(delivered).toMatchObject({status: 'delivered', waivers: [first.waiver]});
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
