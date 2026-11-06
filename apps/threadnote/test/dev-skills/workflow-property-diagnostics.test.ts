import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Cause, Context, Deferred, Effect, Exit, Fiber, Option, Schema, Tracer} from 'effect';
import fc from 'fast-check';
import {describe, expect, it, vi} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {workflowDiagnostics, workflowPropertyDiagnostics} from './workflow-property-diagnostics.js';
import {
  createWorkflowExecutionDiagnostics,
  executionDiagnosticPhase,
  withWorkflowExecutionDiagnostics,
  workflowExecutionDiagnostics,
  WORKFLOW_COMMAND_SPANS,
  WORKFLOW_EXECUTION_PHASES,
  type WorkflowExecutionDiagnostics,
} from './workflow-execution-diagnostics.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

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
const parse = (line: string) =>
  JSON.parse(Effect2.pipe(line, EffectString.slice('WORKFLOW_PROPERTY_DIAGNOSTICS '.length)));

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
    expect(EffectArray.filter(snapshot.recent, record => record.event === 'evaluation-exit')).toMatchObject([
      {ordinal: 1, input: 1, outcome: 'Success', interrupted: false},
      {ordinal: 2, input: 2, outcome: 'Failure', interrupted: false},
      {ordinal: 3, input: 3, outcome: 'Failure', interrupted: false},
      {ordinal: 4, input: 4, outcome: 'Failure', interrupted: true},
    ]);
    for (const text of EffectRecord.values(privateValue)) expect(JSON.stringify(snapshot)).not.toContain(text);
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
    expect(EffectArray.join(writes, '')).not.toContain('private-abort-reason');
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
      const frozen = Object.freeze(EffectArray.map(evaluations, value => Object.freeze({...value})));
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
        expect(
          EffectArray.map(after.recent, record => (record.event === 'phase' ? 'phase:' + record.phase : record.event)),
        ).toEqual(expectedEvents.slice(-16));
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

effectIt.effect('reports shared namespace access mode before abort cleanup and after the original scoped exit', () =>
  Effect.gen(function* () {
    const test = lifecycle();
    const writes: string[] = [];
    const diagnostics = workflowPropertyDiagnostics(test.context, 'shared-context-namespace', {
      write: line => {
        writes.push(line);
      },
    });
    let cleaned = false;
    const original = {privateBody: 'never-record-body', privateUri: 'threadnote://private/example'};
    const exit = yield* diagnostics
      .observe(
        2,
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              cleaned = true;
            }),
          );
          diagnostics.phase('denied-preflight');
          test.controller.abort(original);
          expect(cleaned).toBe(false);
          expect(writes).toHaveLength(1);
          expect(parse(writes[0])).toMatchObject({
            property: 'shared-context-namespace',
            inputName: 'accessMode',
            event: 'aborted',
            phase: 'denied-preflight',
            startedEvaluations: 1,
            completedEvaluations: 0,
            activeEvaluation: {ordinal: 1, input: 2},
          });
          return yield* Effect.interrupt;
        }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown'))), Effect.scoped),
      )
      .pipe(Effect.exit);
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(cleaned).toBe(true);
    test.finish();
    expect(writes).toHaveLength(2);
    expect(parse(writes[1])).toMatchObject({
      event: 'finished',
      completedEvaluations: 1,
      successfulEvaluations: 0,
      activeEvaluation: null,
    });
    for (const value of EffectRecord.values(original)) expect(EffectArray.join(writes, '')).not.toContain(value);
    const closed = lifecycle();
    const silent = workflowPropertyDiagnostics(closed.context, 'shared-context-namespace', {
      write: () => {
        throw new Error('private sink failure');
      },
    });
    expect(yield* silent.observe(1, Effect.succeed(original))).toBe(original);
    closed.controller.abort(original);
    closed.finish();
  }),
);

effectIt.effect('limits shared namespace numeric access codes and serialized finite diagnostic fields', () =>
  Effect.gen(function* () {
    let time = 0;
    const diagnostics = workflowDiagnostics('shared-context-namespace', () => time);
    for (const input of [-1, 0, 3, Infinity, NaN]) {
      yield* diagnostics.observe(
        input,
        Effect.sync(() => {
          expect(diagnostics.snapshot().activeEvaluation?.input).toBeNull();
          diagnostics.phase('authorized-preflight');
          time = Number.MAX_VALUE;
        }),
      );
    }
    expect(diagnostics.snapshot()).toMatchObject({
      inputName: 'accessMode',
      startedEvaluations: 5,
      completedEvaluations: 5,
      successfulEvaluations: 5,
    });
    expect(diagnostics.snapshot().recent).toHaveLength(16);
    expect(Buffer.byteLength(JSON.stringify(diagnostics.snapshot()), 'utf8')).toBeLessThan(8192);
  }),
);

effectIt.effect.prop(
  'bounds shared namespace outcome history and snapshots independently of private values and input mutations',
  {
    evaluations: Schema.Array(
      Schema.Struct({
        readOnly: Schema.Boolean,
        phase: Schema.Literals(['authorized-read', 'authorized-preflight', 'denied-read', 'denied-preflight']),
        outcome: Schema.Literals(['success', 'failure', 'defect', 'interruption']),
        duration: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 9})),
      }),
    ).check(Schema.isBetweenLength(1, 22)),
  },
  ({evaluations}) =>
    Effect.gen(function* () {
      let time = 0;
      let cleaned = 0;
      let successes = 0;
      const diagnostics = workflowDiagnostics('shared-context-namespace', () => time);
      const originalInput = JSON.stringify(evaluations);
      const frozen = Object.freeze(EffectArray.map(evaluations, value => Object.freeze({...value})));
      const expectedEvents: string[] = [];
      const privateValue = {body: 'private-shared-body', uri: 'threadnote://private/shared-context'};
      for (const [index, evaluation] of frozen.entries()) {
        const before = diagnostics.snapshot();
        const beforeText = JSON.stringify(before);
        // Closed diagnostic codes describe the original Boolean; no generated suffix or URI is retained.
        const mode = evaluation.readOnly ? 2 : 1;
        const exit = yield* diagnostics
          .observe(
            mode,
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  cleaned++;
                }),
              );
              expect(diagnostics.snapshot()).toMatchObject({
                phase: 'provisioning',
                startedEvaluations: index + 1,
                completedEvaluations: index,
                activeEvaluation: {ordinal: index + 1, input: mode},
              });
              diagnostics.phase(evaluation.phase);
              time += evaluation.duration;
              switch (evaluation.outcome) {
                case 'success':
                  return privateValue;
                case 'failure':
                  return yield* Effect.fail(privateValue);
                case 'defect':
                  return yield* Effect.die(privateValue);
                case 'interruption':
                  return yield* Effect.interrupt;
              }
            }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown'))), Effect.scoped),
          )
          .pipe(Effect.exit);
        if (evaluation.outcome === 'success') {
          successes++;
          expect(exit).toEqual(Exit.succeed(privateValue));
        } else if (evaluation.outcome === 'failure') {
          expect(exit).toEqual(Exit.fail(privateValue));
        } else if (evaluation.outcome === 'defect') {
          expect(exit).toEqual(Exit.failCause(Cause.die(privateValue)));
        }
        expect(Exit.hasInterrupts(exit)).toBe(evaluation.outcome === 'interruption');
        expect(cleaned).toBe(index + 1);
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
          activeEvaluation: null,
          phase: 'between-evaluations',
          inputName: 'accessMode',
        });
        expect(
          EffectArray.map(after.recent, record => (record.event === 'phase' ? 'phase:' + record.phase : record.event)),
        ).toEqual(expectedEvents.slice(-16));
        expect(after.recent.at(-1)).toMatchObject({
          event: 'evaluation-exit',
          ordinal: index + 1,
          input: mode,
          outcome: evaluation.outcome === 'success' ? 'Success' : 'Failure',
          interrupted: evaluation.outcome === 'interruption',
          elapsedMs: evaluation.duration,
        });
        expect(JSON.stringify(before)).toBe(beforeText);
        const afterText = JSON.stringify(after);
        after.recent[0].startedMs = -1;
        expect(JSON.stringify(diagnostics.snapshot())).toBe(afterText);
        expect(Buffer.byteLength(afterText, 'utf8')).toBeLessThan(8192);
        for (const value of EffectRecord.values(privateValue)) expect(afterText).not.toContain(value);
      }
      expect(JSON.stringify(evaluations)).toBe(originalInput);
    }),
  {arbitrary: {runs: 20}},
);

describe('workflow execution diagnostics', () => {
  const span = (diagnostics: WorkflowExecutionDiagnostics, name: string = WORKFLOW_COMMAND_SPANS[0]) =>
    diagnostics.tracer.span({
      name,
      startTime: 0n,
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      kind: 'internal',
      root: false,
      sampled: true,
    });
  const lifecycle = (controller = new AbortController()) => {
    const finished: (() => void)[] = [];
    return {
      signal: controller.signal,
      onTestFinished: (callback: () => void) => {
        finished.push(callback);
      },
      finish: () => EffectArray.forEach(finished, callback => callback()),
      controller,
    };
  };
  const packets = (lines: readonly string[]) =>
    EffectArray.map(lines, line =>
      JSON.parse(Effect2.pipe(line, EffectString.slice('WORKFLOW_EXECUTION_DIAGNOSTICS '.length))),
    );

  class Dependency extends Context.Service<Dependency, {readonly value: object}>()(
    '@threadnote/threadnote/test/dev-skills/workflow-property-diagnostics.test/Dependency',
  ) {}

  effectIt.effect(
    'execution observer retains absent identity, typed environment, result identity and one execution',
    () =>
      Effect.gen(function* () {
        const value = {original: true};
        let calls = 0;
        const original = Effect.gen(function* () {
          calls++;
          return (yield* Dependency).value;
        });
        expect(withWorkflowExecutionDiagnostics(original)).toBe(original);
        const diagnostics = createWorkflowExecutionDiagnostics({write: () => {}});
        const observed: Effect.Effect<object, never, Dependency> = withWorkflowExecutionDiagnostics(
          original,
          diagnostics,
        );
        expect(yield* observed.pipe(Effect.provideService(Dependency, {value}))).toBe(value);
        expect(calls).toBe(1);
        expect(diagnostics.snapshot()).toMatchObject({
          programStarted: true,
          programCompleted: true,
          programOutcome: 'Success',
        });
      }),
  );

  it('execution command records are closed, bounded, idempotent and independent snapshots', () => {
    let time = 0;
    const lines: string[] = [];
    const diagnostics = createWorkflowExecutionDiagnostics({now: () => time, write: line => lines.push(line)});
    const children = Array.from({length: 7}, (_, index) => span(diagnostics, WORKFLOW_COMMAND_SPANS[index % 3]));
    expect(diagnostics.snapshot()).toMatchObject({
      commandCount: 7,
      activeCount: 7,
      unlistedActiveCount: 3,
      droppedActiveRecords: 3,
      overflow: true,
    });
    expect(diagnostics.snapshot().active).toHaveLength(4);
    time = 8;
    for (const child of children) {
      child.end(0n, Exit.void);
      child.end(0n, Exit.fail('private'));
    }
    for (let index = 0; index < 30; index++) diagnostics.phase('archive');
    const copied = diagnostics.snapshot();
    expect(copied).toMatchObject({completedCommands: 7, successfulCommands: 7, activeCount: 0, droppedRecords: 21});
    expect(copied.recent).toHaveLength(16);
    copied.recent.splice(0);
    expect(diagnostics.snapshot().recent).toHaveLength(16);
    diagnostics.report('aborted');
    expect(JSON.stringify(packets(lines)[0]).length).toBeLessThanOrEqual(8192);
  });

  it('execution spans discard metadata, payloads and unknown labels without retaining input', () => {
    const diagnostics = createWorkflowExecutionDiagnostics({now: () => 0, write: () => {}});
    const poison = new Proxy(
      {},
      {
        get: () => {
          throw new Error('/private/body/token');
        },
      },
    );
    const options = {
      name: WORKFLOW_COMMAND_SPANS[0],
      get startTime(): never {
        throw new Error('clock metadata');
      },
      get parent(): never {
        throw new Error('parent');
      },
      get annotations(): never {
        throw new Error('annotations');
      },
      get links(): never {
        throw new Error('links');
      },
      get kind(): never {
        throw new Error('kind');
      },
      get root(): never {
        throw new Error('root');
      },
      get sampled(): never {
        throw new Error('sampled');
      },
    };
    const measured = diagnostics.tracer.span(options);
    measured.attribute('/private/path', poison);
    measured.event('/private/body', 0n, {credential: poison});
    measured.addLinks([{span: measured, attributes: {credential: poison}}]);
    measured.end(0n, Exit.fail(poison));
    span(diagnostics, '/private/unknown').end(0n, Exit.void);
    expect(measured.attributes.size).toBe(0);
    expect(measured.links).toEqual([]);
    expect(measured instanceof Tracer.NativeSpan ? measured.events : []).toEqual([]);
    expect(diagnostics.snapshot()).toMatchObject({commandCount: 1, completedCommands: 1, successfulCommands: 0});
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('/private');
  });

  effectIt.effect('execution failures, defects and interruption retain their original identities and finalizers', () =>
    Effect.gen(function* () {
      const diagnostics = createWorkflowExecutionDiagnostics({write: () => {}});
      const original = {private: 'typed failure'};
      const failure = yield* withWorkflowExecutionDiagnostics(Effect.fail(original), diagnostics).pipe(Effect.result);
      expect(failure._tag === 'Failure' ? failure.failure : undefined).toBe(original);
      const defect = new Error('private defect');
      const died = yield* withWorkflowExecutionDiagnostics(
        Effect.die(defect),
        createWorkflowExecutionDiagnostics({write: () => {}}),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(died) ? Cause.squash(died.cause) : undefined).toBe(defect);
      const entered = yield* Deferred.make<void>();
      let cleaned = 0;
      const child = yield* withWorkflowExecutionDiagnostics(
        Effect.acquireUseRelease(
          Effect.void,
          () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          () =>
            Effect.sync(() => {
              cleaned++;
            }),
        ),
        createWorkflowExecutionDiagnostics({write: () => {}}),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(child);
      expect(Exit.isFailure(yield* Fiber.await(child))).toBe(true);
      expect(cleaned).toBe(1);
    }),
  );

  effectIt.effect('actual abort packet precedes Deferred-blocked cleanup and effect-exit observes its completion', () =>
    Effect.gen(function* () {
      const context = lifecycle();
      const lines: string[] = [];
      const diagnostics = workflowExecutionDiagnostics(context, {write: line => lines.push(line)});
      const entered = yield* Deferred.make<void>();
      const cleanupEntered = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const program = Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.sync(() => diagnostics.phase('archive')).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Effect.never),
          ),
        () =>
          Effect.sync(() => diagnostics.phase('teardown')).pipe(
            Effect.andThen(Deferred.succeed(cleanupEntered, undefined)),
            Effect.andThen(Deferred.await(releaseCleanup)),
          ),
      );
      // The real AbortSignal interrupts the program through this callback; no second Effect runtime is started.
      const aborted = Effect.callback<never>(resume => {
        const interrupt = () => resume(Effect.interrupt);
        context.signal.addEventListener('abort', interrupt, {once: true});
        if (context.signal.aborted) interrupt();
        return Effect.sync(() => context.signal.removeEventListener('abort', interrupt));
      });
      const child = yield* withWorkflowExecutionDiagnostics(Effect.raceFirst(program, aborted), diagnostics).pipe(
        Effect.forkChild,
      );
      yield* Effect.gen(function* () {
        yield* Deferred.await(entered);
        context.controller.abort();
        yield* Deferred.await(cleanupEntered);
        expect(EffectArray.map(packets(lines), packet => packet.event)).toEqual(['aborted']);
        expect(packets(lines)[0]).toMatchObject({phase: 'archive', programCompleted: false});
        yield* Deferred.succeed(releaseCleanup, undefined);
        expect(Exit.isFailure(yield* Fiber.await(child))).toBe(true);
        expect(EffectArray.map(packets(lines), packet => packet.event)).toEqual(['aborted', 'effect-exit']);
        expect(packets(lines)[1]).toMatchObject({programCompleted: true, programOutcome: 'Failure'});
        context.finish();
        context.finish();
        expect(EffectArray.map(packets(lines), packet => packet.event)).toEqual(['aborted', 'effect-exit', 'finished']);
      }).pipe(
        Effect.ensuring(Deferred.succeed(releaseCleanup, undefined).pipe(Effect.andThen(Fiber.interrupt(child)))),
      );
    }),
  );

  effectIt.effect('clock, observer and sink faults cannot replace or rerun original work', () =>
    Effect.gen(function* () {
      let index = 0;
      const values = [0, NaN, Infinity, -2, 90_000_000];
      const diagnostics = createWorkflowExecutionDiagnostics({
        now: () => {
          const value = values[index++];
          if (value === undefined) throw new Error('clock');
          return value;
        },
        write: () => {
          throw new Error('sink');
        },
      });
      diagnostics.phase('archive');
      span(diagnostics).end(0n, Exit.void);
      diagnostics.report('aborted');
      expect(diagnostics.snapshot()).toMatchObject({invalid: true, overflow: true, elapsedMs: 86_400_000});
      const faulty = {
        ...diagnostics,
        started() {
          throw new Error('started');
        },
        exited() {
          throw new Error('exited');
        },
        phase() {
          throw new Error('phase');
        },
      };
      executionDiagnosticPhase(faulty, 'archive');
      const value = {original: true};
      let calls = 0;
      const original = Effect.sync(() => {
        calls++;
        return value;
      });
      expect(yield* withWorkflowExecutionDiagnostics(original, faulty)).toBe(value);
      const attach = {
        ...faulty,
        get tracer(): never {
          throw new Error('attach');
        },
      };
      expect(yield* withWorkflowExecutionDiagnostics(original, attach)).toBe(value);
      expect(calls).toBe(2);
      const options = {
        now: () => 0,
        get write(): never {
          throw new Error('write getter');
        },
      };
      expect(() => createWorkflowExecutionDiagnostics(options)).not.toThrow();
    }),
  );

  it('attempt lifecycle is idempotent, removes listeners and handles aborted or failed registration', () => {
    const context = lifecycle();
    const add = vi.spyOn(context.signal, 'addEventListener');
    const remove = vi.spyOn(context.signal, 'removeEventListener');
    const lines: string[] = [];
    const diagnostics = workflowExecutionDiagnostics(context, {write: line => lines.push(line)});
    expect(workflowExecutionDiagnostics(context)).toBe(diagnostics);
    context.finish();
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0][1]);
    context.controller.abort();
    expect(EffectArray.map(packets(lines), packet => packet.event)).toEqual(['finished']);
    const retry = workflowExecutionDiagnostics(context, {write: line => lines.push(line)});
    expect(retry).not.toBe(diagnostics);
    expect(EffectArray.map(packets(lines), packet => packet.event)).toEqual(['finished', 'aborted']);
    context.finish();
    const broken = {
      signal: new AbortController().signal,
      onTestFinished() {
        throw new Error('registration');
      },
    };
    expect(() => workflowExecutionDiagnostics(broken)).not.toThrow();
    const badSignal = {
      get signal(): never {
        throw new Error('signal getter');
      },
      onTestFinished() {},
    };
    expect(() => workflowExecutionDiagnostics(badSignal)).not.toThrow();
    add.mockRestore();
    remove.mockRestore();
  });

  it('keeps the default execution tag and permits the native authoring cloud tag', () => {
    const defaultContext = lifecycle();
    const defaultLines: string[] = [];
    workflowExecutionDiagnostics(defaultContext, {write: line => defaultLines.push(line)});
    defaultContext.finish();
    expect(packets(defaultLines)[0]).toMatchObject({test: 'workflow-citation-recovery', event: 'finished'});

    const nativeContext = lifecycle();
    const nativeLines: string[] = [];
    const diagnostics = workflowExecutionDiagnostics(nativeContext, {
      testTag: 'native-authoring-cloud',
      write: line => nativeLines.push(line),
    });
    expect(diagnostics.snapshot().test).toBe('native-authoring-cloud');
    nativeContext.finish();
    expect(packets(nativeLines)[0]).toMatchObject({test: 'native-authoring-cloud', event: 'finished'});
  });

  it('abort retains the last work phase when an earlier listener already entered teardown', () => {
    const context = lifecycle();
    const lines: string[] = [];
    const earlier = () => executionDiagnosticPhase(diagnostics, 'teardown');
    context.signal.addEventListener('abort', earlier, {once: true});
    const diagnostics = workflowExecutionDiagnostics(context, {write: line => lines.push(line)});
    diagnostics.phase('archive');
    context.controller.abort();
    expect(packets(lines)[0]).toMatchObject({
      event: 'aborted',
      phase: 'teardown',
      lastWorkPhase: 'archive',
      programCompleted: false,
    });
    context.finish();
  });

  it('execution command count saturation stays finite without additional retained records', () => {
    const diagnostics = createWorkflowExecutionDiagnostics({now: () => 0, write: () => {}});
    for (let index = 0; index < 1_000_001; index++) span(diagnostics).end(0n, Exit.void);
    expect(diagnostics.snapshot()).toMatchObject({
      commandCount: 1_000_000,
      completedCommands: 1_000_000,
      successfulCommands: 1_000_000,
      activeCount: 0,
      overflow: true,
    });
    expect(diagnostics.snapshot().active).toEqual([]);
    expect(diagnostics.snapshot().recent).toHaveLength(16);
  });

  fcEffectProp(
    effectIt,
    'execution schedule totals and bounded private snapshots agree with an independent model',
    {
      abortFirst: fc.boolean(),
      succeeds: fc.boolean(),
      events: fc.array(
        fc.record({
          kind: fc.constantFrom('start', 'finish', 'phase'),
          channel: fc.integer({min: 0, max: 3}),
          target: fc.integer({min: 0, max: 29}),
          success: fc.boolean(),
          phase: fc.constantFrom(...WORKFLOW_EXECUTION_PHASES),
          privatePayload: fc.string({maxLength: 30}),
        }),
        {maxLength: 40},
      ),
    },
    input =>
      Effect.sync(() => {
        const before = structuredClone(input);
        let time = 0;
        const context = lifecycle();
        const lines: string[] = [];
        const diagnostics = workflowExecutionDiagnostics(context, {now: () => time, write: line => lines.push(line)});
        const started: {measured: Tracer.Span; observed: boolean}[] = [];
        const completed = new Map<number, boolean>();
        const modelRecent: {event: string; sequence?: number; outcome?: string; phase?: string}[] = [];
        let phase: string = 'provisioning';
        let sequence = 0;
        for (const event of input.events) {
          time += 3;
          if (event.kind === 'start') {
            const observed = event.channel < 3;
            const measured = span(diagnostics, WORKFLOW_COMMAND_SPANS[event.channel] ?? '/private/unknown');
            measured.attribute('/private/body/token', event.privatePayload);
            started.push({measured, observed});
            if (observed) sequence++;
          } else if (event.kind === 'finish') {
            const child = started[event.target];
            if (!child) continue;
            child.measured.end(0n, event.success ? Exit.void : Exit.fail(event.privatePayload));
            child.measured.end(0n, Exit.void);
            if (child.observed && !completed.has(event.target)) {
              completed.set(event.target, event.success);
              const ordinal = EffectArray.filter(started.slice(0, event.target + 1), value => value.observed).length;
              modelRecent.push({
                event: 'command-exit',
                sequence: ordinal,
                outcome: event.success ? 'Success' : 'Failure',
              });
            }
          } else {
            diagnostics.phase(event.phase);
            modelRecent.push({event: 'phase', phase});
            phase = event.phase;
          }
        }
        const snapshot = diagnostics.snapshot();
        expect(snapshot).toMatchObject({
          commandCount: sequence,
          completedCommands: completed.size,
          successfulCommands: EffectArray.filter([...completed.values()], Boolean).length,
          activeCount: sequence - completed.size,
          phase,
        });
        const expected = modelRecent.slice(-16);
        expect(
          EffectArray.map(snapshot.recent, entry =>
            entry.event === 'phase'
              ? {event: entry.event, phase: entry.phase}
              : {event: entry.event, sequence: entry.sequence, outcome: entry.outcome},
          ),
        ).toEqual(expected);
        expect(snapshot.active.length).toBeLessThanOrEqual(4);
        expect(snapshot.active.length + snapshot.unlistedActiveCount).toBe(snapshot.activeCount);
        expect(snapshot.recent.length).toBeLessThanOrEqual(16);
        expect(snapshot.droppedRecords).toBe(Math.max(0, modelRecent.length - 16));
        const serialized = JSON.stringify(snapshot);
        expect(serialized.length).toBeLessThanOrEqual(8192);
        expect(serialized).not.toContain('/private');
        snapshot.active.splice(0);
        snapshot.recent.splice(0);
        expect(JSON.stringify(diagnostics.snapshot())).toBe(serialized);
        diagnostics.exited(input.succeeds ? 'Success' : 'Failure');
        diagnostics.exited('Failure');
        if (input.abortFirst) context.controller.abort();
        context.finish();
        context.finish();
        context.controller.abort();
        expect(EffectArray.map(packets(lines), packet => packet.event)).toEqual(
          input.abortFirst ? ['effect-exit', 'aborted', 'finished'] : ['effect-exit', 'finished'],
        );
        expect(EffectArray.every(packets(lines), packet => packet.programCompleted)).toBe(true);
        expect(workflowExecutionDiagnostics(context, {write: () => {}})).not.toBe(diagnostics);
        context.finish();
        expect(input).toEqual(before);
      }),
    {fastCheck: {numRuns: 20}},
  );
});
