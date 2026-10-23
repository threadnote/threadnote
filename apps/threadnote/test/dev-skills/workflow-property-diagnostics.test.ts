import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, Schema} from 'effect';
import {expect, vi} from 'vitest';
import {workflowDiagnostics, workflowPropertyDiagnostics} from './workflow-property-diagnostics.js';

const lifecycle = () => {
  const controller = new AbortController();
  const finished: (() => void)[] = [];
  return {
    controller,
    finished,
    context: {
      signal: controller.signal,
      onTestFinished: (callback: () => void) => {
        finished.push(callback);
      },
    },
    finish: () => {
      for (const callback of finished.splice(0)) {
        callback();
        callback();
      }
    },
  };
};
const parse = (line: string) => JSON.parse(line.slice('WORKFLOW_PROPERTY_DIAGNOSTICS '.length));

effectIt.effect('preserves values, failure identities, defects and interruption without their private payloads', () =>
  Effect.gen(function* () {
    const diagnostics = workflowDiagnostics('workflow-retirement');
    const privateValue = {path: '/private/example', body: 'secret-body', token: 'private-token'};
    expect(yield* diagnostics.observe(1, Effect.succeed(privateValue))).toBe(privateValue);
    const failed = yield* diagnostics.observe(2, Effect.fail(privateValue)).pipe(Effect.result);
    expect(failed._tag).toBe('Failure');
    if (failed._tag === 'Failure') expect(failed.failure).toBe(privateValue);
    expect(yield* diagnostics.observe(3, Effect.die(privateValue)).pipe(Effect.exit)).toEqual(
      Exit.failCause(Cause.die(privateValue)),
    );
    expect(Exit.hasInterrupts(yield* diagnostics.observe(4, Effect.interrupt).pipe(Effect.exit))).toBe(true);
    const snapshot = diagnostics.snapshot();
    expect(snapshot).toMatchObject({startedEvaluations: 4, completedEvaluations: 4, successfulEvaluations: 1});
    expect(snapshot.recent.filter(record => record.event === 'evaluation-exit')).toMatchObject([
      {ordinal: 1, input: 1, outcome: 'Success', interrupted: false},
      {ordinal: 2, input: 2, outcome: 'Failure', interrupted: false},
      {ordinal: 3, input: 3, outcome: 'Failure', interrupted: false},
      {ordinal: 4, input: 4, outcome: 'Failure', interrupted: true},
    ]);
    for (const text of Object.values(privateValue)) expect(JSON.stringify(snapshot)).not.toContain(text);
  }),
);

effectIt.effect('captures provisioning and teardown before cleanup, and records completion after the scoped exit', () =>
  Effect.gen(function* () {
    let time = 0;
    const diagnostics = workflowDiagnostics('setup-opt-out', () => time);
    const stages: ReturnType<typeof diagnostics.snapshot>[] = [];
    yield* diagnostics.observe(
      5,
      Effect.gen(function* () {
        time = 7;
        stages.push(diagnostics.snapshot());
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            time = 20;
            stages.push(diagnostics.snapshot());
          }),
        );
        diagnostics.phase('fixture');
        time = 15;
      }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown'))), Effect.scoped),
    );
    expect(stages[0]).toMatchObject({phase: 'provisioning', completedEvaluations: 0, phaseElapsedMs: 7});
    expect(stages[1]).toMatchObject({
      phase: 'teardown',
      completedEvaluations: 0,
      activeEvaluation: {ordinal: 1, input: 5},
    });
    expect(diagnostics.snapshot()).toMatchObject({
      inputName: 'repetitions',
      phase: 'between-evaluations',
      completedEvaluations: 1,
      recent: [
        {event: 'phase', phase: 'between-evaluations', elapsedMs: 0},
        {event: 'phase', phase: 'provisioning', elapsedMs: 7},
        {event: 'phase', phase: 'fixture', elapsedMs: 8},
        {event: 'phase', phase: 'teardown', elapsedMs: 5},
        {event: 'evaluation-exit', elapsedMs: 20},
      ],
    });
  }),
);

effectIt.effect('registers once and reports abort before cleanup and an idempotent final snapshot after exit', () =>
  Effect.gen(function* () {
    const test = lifecycle();
    const writes: string[] = [];
    const add = vi.spyOn(test.controller.signal, 'addEventListener');
    const remove = vi.spyOn(test.controller.signal, 'removeEventListener');
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        add.mockRestore();
        remove.mockRestore();
      }),
    );
    const diagnostics = workflowPropertyDiagnostics(test.context, 'workflow-retirement', {
      write: line => {
        writes.push(line);
      },
    });
    expect(workflowPropertyDiagnostics(test.context, 'workflow-retirement')).toBe(diagnostics);
    expect(add).toHaveBeenCalledTimes(1);
    expect(test.finished).toHaveLength(1);
    let cleaned = false;
    const exit = yield* diagnostics
      .observe(
        4,
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              cleaned = true;
            }),
          );
          diagnostics.phase('archive-replay', 3);
          test.controller.abort('private-abort-reason');
          test.controller.signal.dispatchEvent(new Event('abort'));
          expect(cleaned).toBe(false);
          expect(writes).toHaveLength(1);
          expect(parse(writes[0])).toMatchObject({
            event: 'aborted',
            phase: 'archive-replay',
            loopIndex: 3,
            completedEvaluations: 0,
            activeEvaluation: {ordinal: 1, input: 4},
          });
          return yield* Effect.interrupt;
        }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown'))), Effect.scoped),
      )
      .pipe(Effect.exit);
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(cleaned).toBe(true);
    test.finish();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(2);
    expect(parse(writes[1])).toMatchObject({
      event: 'finished',
      phase: 'between-evaluations',
      loopIndex: null,
      completedEvaluations: 1,
      successfulEvaluations: 0,
      activeEvaluation: null,
    });
    expect(writes.join('')).not.toContain('private-abort-reason');
  }),
);

effectIt.effect('removes listeners and isolates finished, reused, independent and already aborted contexts', () =>
  Effect.gen(function* () {
    const test = lifecycle();
    const firstWrites: string[] = [];
    const first = workflowPropertyDiagnostics(test.context, 'setup-opt-out', {
      write: line => {
        firstWrites.push(line);
      },
    });
    yield* first.observe(1, Effect.void);
    test.finish();
    test.controller.abort();
    expect(firstWrites).toHaveLength(1);
    const secondWrites: string[] = [];
    const second = workflowPropertyDiagnostics(test.context, 'setup-opt-out', {
      write: line => {
        secondWrites.push(line);
      },
    });
    expect(second).not.toBe(first);
    expect(second.snapshot()).toMatchObject({startedEvaluations: 0, completedEvaluations: 0});
    expect(secondWrites).toHaveLength(1);
    expect(parse(secondWrites[0])).toMatchObject({event: 'aborted', startedEvaluations: 0});
    expect(workflowPropertyDiagnostics(test.context, 'setup-opt-out')).toBe(second);
    test.finish();
    expect(secondWrites).toHaveLength(2);
    const other = lifecycle();
    expect(
      workflowPropertyDiagnostics(other.context, 'workflow-retirement', {write: () => {}}).snapshot(),
    ).toMatchObject({property: 'workflow-retirement', startedEvaluations: 0});
    other.finish();
  }),
);

effectIt.effect('does not let a failing diagnostic sink change success, failure or interruption', () =>
  Effect.gen(function* () {
    const test = lifecycle();
    const diagnostics = workflowPropertyDiagnostics(test.context, 'setup-opt-out', {
      write: () => {
        throw new Error('closed stderr');
      },
    });
    expect(
      yield* diagnostics.observe(
        1,
        Effect.sync(() => {
          test.controller.abort();
          return 42;
        }),
      ),
    ).toBe(42);
    expect(yield* diagnostics.observe(2, Effect.fail('original')).pipe(Effect.result)).toMatchObject({
      _tag: 'Failure',
      failure: 'original',
    });
    expect(Exit.hasInterrupts(yield* diagnostics.observe(3, Effect.interrupt).pipe(Effect.exit))).toBe(true);
    test.finish();
  }),
);

effectIt.effect('keeps invalid numeric diagnostic inputs finite and bounded', () =>
  Effect.gen(function* () {
    let time = 0;
    const diagnostics = workflowDiagnostics('workflow-retirement', () => time);
    yield* diagnostics.observe(
      Infinity,
      Effect.sync(() => {
        time = Infinity;
        diagnostics.phase('write-replay', NaN);
        expect(diagnostics.snapshot()).toMatchObject({loopIndex: null, elapsedMs: 0, activeEvaluation: {input: null}});
      }),
    );
    time = -10;
    expect(diagnostics.snapshot().elapsedMs).toBe(0);
  }),
);

effectIt.effect.prop(
  'bounds ordered phase and evaluation history while preserving inputs, privacy and independent snapshots',
  {
    setup: Schema.Boolean,
    evaluations: Schema.Array(
      Schema.Struct({
        input: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 4})),
        succeeds: Schema.Boolean,
        phase: Schema.Literals(['default-setup', 'write-replay']),
        index: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 3})),
        duration: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 9})),
      }),
    ).check(Schema.isBetweenLength(6, 20)),
  },
  ({setup, evaluations}) =>
    Effect.gen(function* () {
      let time = 0;
      const diagnostics = workflowDiagnostics(setup ? 'setup-opt-out' : 'workflow-retirement', () => time);
      const initial = diagnostics.snapshot();
      const frozen = Object.freeze(evaluations.map(value => Object.freeze({...value})));
      const inputBefore = JSON.stringify(evaluations);
      const expectedEvents: string[] = [];
      let successes = 0;
      for (const [index, evaluation] of frozen.entries()) {
        const before = diagnostics.snapshot();
        const beforeText = JSON.stringify(before);
        yield* diagnostics
          .observe(
            evaluation.input,
            Effect.gen(function* () {
              const active = diagnostics.snapshot();
              expect(active).toMatchObject({
                startedEvaluations: index + 1,
                completedEvaluations: index,
                phase: 'provisioning',
                loopIndex: null,
                activeEvaluation: {ordinal: index + 1, input: evaluation.input},
              });
              if (active.activeEvaluation) active.activeEvaluation.input = null;
              expect(diagnostics.snapshot().activeEvaluation?.input).toBe(evaluation.input);
              diagnostics.phase(evaluation.phase, evaluation.index);
              expect(diagnostics.snapshot()).toMatchObject({phase: evaluation.phase, loopIndex: evaluation.index});
              time += evaluation.duration;
              return yield* evaluation.succeeds ? Effect.void : Effect.fail({privatePayload: 'never-record-this'});
            }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown')))),
          )
          .pipe(Effect.result);
        if (evaluation.succeeds) successes++;
        expectedEvents.push(
          'phase:between-evaluations',
          'phase:provisioning',
          'phase:' + evaluation.phase,
          'phase:teardown',
          'evaluation-exit',
        );
        const after = diagnostics.snapshot();
        expect(after).toMatchObject({
          startedEvaluations: index + 1,
          completedEvaluations: index + 1,
          successfulEvaluations: successes,
          phase: 'between-evaluations',
          activeEvaluation: null,
          loopIndex: null,
        });
        expect(after.recent.map(record => (record.event === 'phase' ? 'phase:' + record.phase : record.event))).toEqual(
          expectedEvents.slice(-16),
        );
        expect(after.recent.length).toBeLessThanOrEqual(16);
        expect(after.recent.at(-1)).toMatchObject({
          event: 'evaluation-exit',
          ordinal: index + 1,
          input: evaluation.input,
          outcome: evaluation.succeeds ? 'Success' : 'Failure',
          elapsedMs: evaluation.duration,
        });
        expect(JSON.stringify(before)).toBe(beforeText);
        const afterText = JSON.stringify(after);
        after.recent[0].startedMs = -1;
        expect(JSON.stringify(diagnostics.snapshot())).toBe(afterText);
      }
      expect(initial.recent).toEqual([]);
      expect(JSON.stringify(evaluations)).toBe(inputBefore);
      expect(JSON.stringify(diagnostics.snapshot())).not.toContain('never-record-this');
    }),
  {arbitrary: {runs: 24}},
);
