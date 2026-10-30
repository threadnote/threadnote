import {Effect, Array as EffectArray, Option as EffectOption, String as EffectString} from 'effect';

import {it as effectIt} from '@effect/vitest';

import {expect} from 'vitest';

import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';

import * as Effect2 from 'effect';
import {
  captureNativeCycleSource,
  completeLocalPhase,
  fixture,
  object,
  run,
  windowsCycleFixtureTimeout,
} from './native-cycle-lifecycle-fixture.js';

effectIt.effect(
  'fences logically independent stacked children after parent invalidation and preserves continuous review history',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one', 'two'], 'local', false, true);
      yield* completeLocalPhase(f, 'one');
      yield* f.git(['checkout', '-b', 'feature/two']);
      yield* completeLocalPhase(f, 'two');
      const acceptedRuntime = decodeNativeCycleRuntime(
        object(JSON.parse(yield* f.fs.readFileString(f.statePath()))).cycle,
      );
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(acceptedRuntime.state.plan.phases, p => p.id === 'two'))
          ?.dependsOn,
      ).toEqual([]);
      yield* f.mutate('invalidate', {phaseId: 'one', reason: 'Real parent source failure.'});
      const before = yield* f.fs.readFileString(f.statePath());
      const refsBefore = (yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout;
      const sourceBefore = yield* captureNativeCycleSource(f.repo, 'HEAD');
      for (const command of ['resume-phase', 'snapshot', 'publication-ready', 'record-delivery']) {
        const rejected = yield* f
          .mutate(command, {
            phaseId: 'two',
            reason: 'Attempt bypass',
            snapshotId: 'blocked-child',
            previous: 'two-review',
            delivery: {},
          })
          .pipe(Effect.result);
        expect(rejected).toMatchObject({_tag: 'Failure', failure: {code: 'dependency-stale'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        expect((yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout).toBe(refsBefore);
        expect(yield* captureNativeCycleSource(f.repo, 'HEAD')).toEqual(sourceBefore);
      }
      yield* f.mutate('resume-phase', {phaseId: 'one', reason: 'Parent repair authorized.'});
      yield* f.git(['checkout', 'feature/one']);
      yield* completeLocalPhase(f, 'one', 'one-reaccepted', 'one-review');
      yield* f.mutate('resume-phase', {phaseId: 'two', reason: 'Parent reaccepted.'});
      yield* f.git(['checkout', 'feature/two']);
      const continued = yield* f.mutate('snapshot', {
        phaseId: 'two',
        snapshotId: 'two-continuation',
        previous: 'two-review',
        acceptedHead: Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim),
        reason: 'Continue from the exact normal phase commit.',
      });
      expect(object(object(continued.snapshot).snapshot).previous).toBe('two-review');
      const runtime = decodeNativeCycleRuntime(object(JSON.parse(yield* f.fs.readFileString(f.statePath()))).cycle);
      expect(runtime.snapshots.length).toBe(acceptedRuntime.snapshots.length + 2);
      expect(runtime.reviews.slice(0, acceptedRuntime.reviews.length)).toEqual(acceptedRuntime.reviews);
      expect(runtime.attempts.slice(0, acceptedRuntime.attempts.length)).toEqual(acceptedRuntime.attempts);
    }).pipe(run),
  windowsCycleFixtureTimeout,
);

effectIt.effect('does not offer or directly publish a retained validated child retargeted onto a pending parent', () =>
  Effect.gen(function* () {
    const f = yield* fixture(['one', 'two'], 'local', false, true, false);
    yield* completeLocalPhase(f, 'one');
    yield* f.git(['checkout', '-b', 'feature/two']);
    yield* completeLocalPhase(f, 'two');
    yield* f.mutate('invalidate', {phaseId: 'one', reason: 'Parent acceptance needs repair.'});
    const plan = yield* f.revise(
      {},
      {one: {branch: 'feature/one', baseBranch: 'main'}, two: {branch: 'feature/two', baseBranch: 'feature/one'}},
    );
    const reconciled = yield* f.mutate('reconcile', {plan, reason: 'Approved unchanged-source stack retarget.'});
    expect(reconciled.next).toMatchObject({action: 'blocked', phaseId: 'one'});
    const resumed = yield* f.mutate('resume-phase', {phaseId: 'one', reason: 'Implement parent repair.'});
    expect(resumed.next).toEqual({action: 'implement', phaseId: 'one'});
    const before = yield* f.fs.readFileString(f.statePath());
    const runtime = decodeNativeCycleRuntime(object(JSON.parse(before)).cycle);
    expect(runtime.state.phases.two.status).toBe('validated');
    expect(runtime.state.phases.two.delivery).toBeUndefined();
    expect(runtime.state.phases.two.history).toHaveLength(1);
    for (const command of ['publication-ready', 'record-delivery', 'snapshot']) {
      expect(
        yield* f.mutate(command, {phaseId: 'two', snapshotId: 'blocked-retarget', delivery: {}}).pipe(Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'dependency-stale'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }
  }).pipe(run),
);

effectIt.effect(
  'rejects transitive ancestor retarget bypasses before source mutation and accepts the retained review after reconciliation',
  () =>
    Effect.gen(function* () {
      const bindings = {
        one: {branch: 'feature/one', baseBranch: 'main'},
        two: {branch: 'feature/two', baseBranch: 'feature/one'},
        three: {branch: 'feature/three', baseBranch: 'feature/two'},
        parent: {branch: 'feature/parent', baseBranch: 'main'},
      };
      const f = yield* fixture(['one', 'two', 'three', 'parent'], 'local', false, true, true, bindings);
      yield* completeLocalPhase(f, 'one');
      yield* f.git(['checkout', '-b', 'feature/two']);
      yield* completeLocalPhase(f, 'two');
      yield* f.git(['checkout', '-b', 'feature/three']);
      yield* f.mutate('begin-phase', {phaseId: 'three'});
      const content = 'export const fixture = "retained third phase";\n';
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), content);
      const captured = yield* f.mutate('snapshot', {phaseId: 'three', snapshotId: 'three-retained'});
      const snapshot = object(object(captured.snapshot).snapshot);
      expect(
        (yield* f.mutate('validate-review', {
          snapshotId: snapshot.snapshotId,
          attemptId: 'three-original-review',
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
        })).status,
      ).toBe('ok');
      const plan = yield* f.revise({}, {...bindings, one: {...bindings.one, baseBranch: 'feature/parent'}});
      expect(
        (yield* f.mutate('reconcile', {plan, reason: 'Retarget accepted ancestor onto an unaccepted stack parent.'}))
          .next,
      ).toEqual({action: 'implement', phaseId: 'parent'});
      const before = yield* f.fs.readFileString(f.statePath());
      const oldRuntime = decodeNativeCycleRuntime(object(JSON.parse(before)).cycle);
      expect(oldRuntime.state.phases.two.status).toBe('published');
      const indexFile = Effect2.pipe(
        (yield* f.git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout,
        EffectString.trim,
      );
      const indexBefore = yield* f.fs.readFile(indexFile);
      const refsBefore = (yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout;
      const sourceBefore = yield* captureNativeCycleSource(f.repo, 'HEAD');
      const validation = {
        snapshotTree: snapshot.tree,
        reviewTree: snapshot.tree,
        status: 'passed',
        productState: 'working',
        checks: [{command: 'Private fixture', result: 'passed', evidence: 'Actual retained source review.'}],
        acceptance: [{criterion: 'three works', result: 'passed', evidence: 'Source readback.'}],
      };
      for (const command of ['snapshot', 'publication-ready', 'ready', 'record-delivery']) {
        expect(
          yield* f
            .mutate(command, {phaseId: 'three', snapshotId: snapshot.snapshotId, validation, delivery: {}})
            .pipe(Effect.result),
        ).toMatchObject({_tag: 'Failure', failure: {code: 'dependency-stale'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        expect(yield* f.fs.readFile(indexFile)).toEqual(indexBefore);
        expect((yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout).toBe(refsBefore);
        expect(yield* captureNativeCycleSource(f.repo, 'HEAD')).toEqual(sourceBefore);
      }
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "two";\n');
      yield* f.git(['checkout', '-b', 'feature/parent']);
      yield* completeLocalPhase(f, 'parent');
      yield* f.git(['checkout', 'feature/one']);
      const ancestor = oldRuntime.state.phases.one;
      yield* f.mutate('record-delivery', {
        phaseId: 'one',
        delivery: {
          phaseId: 'one',
          phaseHash: ancestor.phaseHash,
          delivery: 'local',
          headSha: Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim),
          validatedTree: ancestor.tree,
        },
      });
      yield* f.git(['checkout', 'feature/three']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), content);
      expect((yield* f.mutate('ready', {phaseId: 'three', snapshotId: snapshot.snapshotId, validation})).status).toBe(
        'ok',
      );
      const after = decodeNativeCycleRuntime(object(JSON.parse(yield* f.fs.readFileString(f.statePath()))).cycle);
      expect(after.state.phases.three.status).toBe('validated');
      expect(after.reviews.slice(0, oldRuntime.reviews.length)).toEqual(oldRuntime.reviews);
      expect(after.attempts.slice(0, oldRuntime.attempts.length)).toEqual(oldRuntime.attempts);
      expect(after.state.phases.two).toEqual(oldRuntime.state.phases.two);
    }).pipe(run),
  windowsCycleFixtureTimeout,
);
