import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, Schema} from 'effect';
import {expect, vi} from 'vitest';
import {refreshDiagnostics, refreshPropertyDiagnostics} from './service-refresh-diagnostics.js';

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
      for (const callback of finished.splice(0)) callback();
    },
  };
};

effectIt.effect('preserves values, failures, defects and interruption without recording their payloads', () =>
  Effect.gen(function* () {
    const diagnostics = refreshDiagnostics();
    const original = {privatePayload: 'not-for-diagnostics'};
    expect(yield* diagnostics.observe(false, Effect.succeed(original))).toBe(original);
    const failed = yield* diagnostics.observe(true, Effect.fail(original)).pipe(Effect.result);
    expect(failed._tag).toBe('Failure');
    if (failed._tag === 'Failure') expect(failed.failure).toBe(original);
    const defect = yield* diagnostics.observe(false, Effect.die(original)).pipe(Effect.exit);
    expect(defect).toEqual(Exit.failCause(Cause.die(original)));
    const interrupted = yield* diagnostics.observe(true, Effect.interrupt).pipe(Effect.exit);
    expect(Exit.hasInterrupts(interrupted)).toBe(true);
    const report = diagnostics.snapshot();
    expect(report).toMatchObject({
      startedEvaluations: 4,
      completedEvaluations: 4,
      successfulEvaluations: 1,
      activeEvaluation: null,
      phase: 'between-evaluations',
    });
    expect(
      report.recent.map(({ordinal, removed, outcome, interrupted}) => ({ordinal, removed, outcome, interrupted})),
    ).toEqual([
      {ordinal: 1, removed: false, outcome: 'Success', interrupted: false},
      {ordinal: 2, removed: true, outcome: 'Failure', interrupted: false},
      {ordinal: 3, removed: false, outcome: 'Failure', interrupted: false},
      {ordinal: 4, removed: true, outcome: 'Failure', interrupted: true},
    ]);
    expect(JSON.stringify(report)).not.toContain('privatePayload');
    expect(JSON.stringify(report)).not.toContain('not-for-diagnostics');
  }),
);

effectIt.effect('observes provisioning, then teardown before scope cleanup, and counts the exit after cleanup', () =>
  Effect.gen(function* () {
    let time = 0;
    const diagnostics = refreshDiagnostics(() => time);
    const stages: ReturnType<typeof diagnostics.snapshot>[] = [];
    const body = Effect.gen(function* () {
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
    }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown'))), Effect.scoped);
    yield* diagnostics.observe(true, body);
    expect(stages[0]).toMatchObject({phase: 'provisioning', completedEvaluations: 0, phaseElapsedMs: 7});
    expect(stages[1]).toMatchObject({
      phase: 'teardown',
      completedEvaluations: 0,
      activeEvaluation: {ordinal: 1, removed: true},
    });
    expect(diagnostics.snapshot()).toMatchObject({
      phase: 'between-evaluations',
      completedEvaluations: 1,
      recent: [{elapsedMs: 20}],
      phases: [
        {phase: 'between-evaluations', elapsedMs: 0},
        {phase: 'provisioning', elapsedMs: 7},
        {phase: 'fixture', elapsedMs: 8},
        {phase: 'teardown', elapsedMs: 5},
      ],
    });
  }),
);

effectIt.effect('registers once per property context and captures abort before teardown and final exit afterward', () =>
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
    const diagnostics = refreshPropertyDiagnostics(test.context, {
      write: line => {
        writes.push(line);
      },
    });
    expect(refreshPropertyDiagnostics(test.context)).toBe(diagnostics);
    expect(add).toHaveBeenCalledTimes(1);
    expect(test.finished).toHaveLength(1);
    let cleaned = false;
    const result = yield* diagnostics
      .observe(
        true,
        Effect.gen(function* () {
          diagnostics.phase('fixture');
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              cleaned = true;
            }),
          );
          diagnostics.phase('refresh');
          test.controller.abort('private-abort-reason');
          expect(cleaned).toBe(false);
          expect(writes).toHaveLength(1);
          expect(JSON.parse(writes[0].slice('SERVICE_REFRESH_DIAGNOSTICS '.length))).toMatchObject({
            event: 'aborted',
            startedEvaluations: 1,
            completedEvaluations: 0,
            activeEvaluation: {ordinal: 1, removed: true},
            phase: 'refresh',
          });
          return yield* Effect.interrupt;
        }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown'))), Effect.scoped),
      )
      .pipe(Effect.exit);
    expect(Exit.hasInterrupts(result)).toBe(true);
    expect(cleaned).toBe(true);
    test.finish();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1].slice('SERVICE_REFRESH_DIAGNOSTICS '.length))).toMatchObject({
      event: 'finished',
      startedEvaluations: 1,
      completedEvaluations: 1,
      successfulEvaluations: 0,
      activeEvaluation: null,
      phase: 'between-evaluations',
      recent: [{outcome: 'Failure', interrupted: true}],
    });
    expect(writes.join('')).not.toContain('private-abort-reason');
  }),
);

effectIt.effect('labels one unavailable-home evaluation without inventing a generated removed value', () =>
  Effect.gen(function* () {
    const test = lifecycle();
    const writes: string[] = [];
    let time = 0;
    const diagnostics = refreshPropertyDiagnostics(test.context, {
      now: () => time,
      scope: 'dev-skills-refresh-unavailable-home',
      write: line => {
        writes.push(line);
      },
    });
    expect(
      yield* diagnostics.observe(
        undefined,
        Effect.sync(() => {
          diagnostics.phase('index-read');
          time = 7;
          diagnostics.phase('restore-home-index');
          test.controller.abort('private-abort-reason');
          time = 11;
          return 42;
        }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown')))),
      ),
    ).toBe(42);
    test.finish();
    expect(writes).toHaveLength(2);
    const [aborted, finished] = writes.map(line => JSON.parse(line.slice('SERVICE_REFRESH_DIAGNOSTICS '.length)));
    expect(aborted).toMatchObject({
      event: 'aborted',
      scope: 'dev-skills-refresh-unavailable-home',
      startedEvaluations: 1,
      completedEvaluations: 0,
      activeEvaluation: {ordinal: 1},
      phase: 'restore-home-index',
    });
    expect(aborted.activeEvaluation).not.toHaveProperty('removed');
    expect(finished).toMatchObject({
      event: 'finished',
      scope: 'dev-skills-refresh-unavailable-home',
      startedEvaluations: 1,
      completedEvaluations: 1,
      successfulEvaluations: 1,
      activeEvaluation: null,
      phase: 'between-evaluations',
      recent: [{ordinal: 1, outcome: 'Success', interrupted: false}],
    });
    expect(finished.recent[0]).not.toHaveProperty('removed');
    expect(writes.join('')).not.toContain('private-abort-reason');
  }),
);

effectIt.effect('cleans up listeners and isolates reused contexts and already aborted attempts', () =>
  Effect.gen(function* () {
    const test = lifecycle();
    const firstWrites: string[] = [];
    const secondWrites: string[] = [];
    const first = refreshPropertyDiagnostics(test.context, {
      write: line => {
        firstWrites.push(line);
      },
    });
    yield* first.observe(false, Effect.void);
    test.finish();
    test.controller.abort();
    expect(firstWrites).toHaveLength(1);
    const second = refreshPropertyDiagnostics(test.context, {
      write: line => {
        secondWrites.push(line);
      },
    });
    expect(second).not.toBe(first);
    expect(second.snapshot()).toMatchObject({startedEvaluations: 0, completedEvaluations: 0});
    expect(secondWrites).toHaveLength(1);
    expect(secondWrites[0]).toContain('"event":"aborted"');
    expect(refreshPropertyDiagnostics(test.context)).toBe(second);
    expect(test.finished).toHaveLength(1);
    test.finish();
    expect(secondWrites).toHaveLength(2);
    const other = lifecycle();
    const independent = refreshPropertyDiagnostics(other.context, {write: () => {}});
    expect(independent.snapshot()).toMatchObject({startedEvaluations: 0, completedEvaluations: 0});
    other.finish();
  }),
);

effectIt.effect(
  'reports a recovery boundary and shared consumer through abort and cleanup without inventing removed input',
  () =>
    Effect.gen(function* () {
      const test = lifecycle();
      const writes: string[] = [];
      const diagnostics = refreshPropertyDiagnostics(test.context, {
        scope: 'dev-skills-refresh-removal-recovery',
        write: line => {
          writes.push(line);
        },
      });
      let cleaned = false;
      const result = yield* diagnostics
        .observeRecovery(
          'home',
          true,
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                cleaned = true;
              }),
            );
            diagnostics.phase('replay');
            test.controller.abort('private-recovery-payload');
            expect(cleaned).toBe(false);
            return yield* Effect.interrupt;
          }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown'))), Effect.scoped),
        )
        .pipe(Effect.exit);
      expect(Exit.hasInterrupts(result)).toBe(true);
      expect(cleaned).toBe(true);
      test.finish();
      const [aborted, finished] = writes.map(line => JSON.parse(line.slice('SERVICE_REFRESH_DIAGNOSTICS '.length)));
      expect(aborted).toMatchObject({
        event: 'aborted',
        scope: 'dev-skills-refresh-removal-recovery',
        startedEvaluations: 1,
        completedEvaluations: 0,
        phase: 'replay',
        activeEvaluation: {ordinal: 1, boundary: 'home', shared: true},
      });
      expect(aborted.activeEvaluation).not.toHaveProperty('removed');
      expect(finished).toMatchObject({
        event: 'finished',
        completedEvaluations: 1,
        successfulEvaluations: 0,
        recent: [{ordinal: 1, boundary: 'home', shared: true, interrupted: true}],
      });
      expect(writes.join('')).not.toContain('private-recovery-payload');
    }),
);

effectIt.effect.prop(
  'keeps recovery case inputs and snapshots independent while forwarding the original outcome',
  {
    boundary: Schema.Literals(['journal', 'receipt', 'home', 'runtime']),
    shared: Schema.Boolean,
    succeeds: Schema.Boolean,
  },
  ({boundary, shared, succeeds}) =>
    Effect.gen(function* () {
      const diagnostics = refreshDiagnostics(() => 0, 'dev-skills-refresh-removal-recovery');
      const payload = {privatePayload: 'not-for-recovery-diagnostics'};
      const outcome = yield* diagnostics
        .observeRecovery(
          boundary,
          shared,
          Effect.gen(function* () {
            const active = diagnostics.snapshot();
            expect(active.activeEvaluation).toMatchObject({boundary, shared});
            if (active.activeEvaluation) active.activeEvaluation.shared = !shared;
            expect(diagnostics.snapshot().activeEvaluation?.shared).toBe(shared);
            return yield* succeeds ? Effect.succeed(payload) : Effect.fail(payload);
          }),
        )
        .pipe(Effect.result);
      if (outcome._tag === 'Success') expect(outcome.success).toBe(payload);
      else expect(outcome.failure).toBe(payload);
      const report = diagnostics.snapshot();
      expect(report).toMatchObject({
        startedEvaluations: 1,
        completedEvaluations: 1,
        successfulEvaluations: succeeds ? 1 : 0,
        activeEvaluation: null,
        recent: [{ordinal: 1, boundary, shared, outcome: succeeds ? 'Success' : 'Failure'}],
      });
      expect(report.recent[0]).not.toHaveProperty('removed');
      report.recent[0].shared = !shared;
      expect(diagnostics.snapshot().recent[0].shared).toBe(shared);
      expect(JSON.stringify(report)).not.toContain('not-for-recovery-diagnostics');
    }),
  {arbitrary: {runs: 20}},
);

effectIt.effect('keeps an unavailable diagnostic sink from replacing Effect exits', () =>
  Effect.gen(function* () {
    const test = lifecycle();
    const diagnostics = refreshPropertyDiagnostics(test.context, {
      write: () => {
        throw new Error('closed stderr');
      },
    });
    expect(
      yield* diagnostics.observe(
        false,
        Effect.sync(() => {
          test.controller.abort();
          return 42;
        }),
      ),
    ).toBe(42);
    expect(yield* diagnostics.observe(true, Effect.fail('original')).pipe(Effect.result)).toMatchObject({
      _tag: 'Failure',
      failure: 'original',
    });
    test.finish();
  }),
);

effectIt.effect.prop(
  'keeps ordered bounded evaluation and phase histories with independent snapshots',
  {
    evaluations: Schema.Array(
      Schema.Struct({
        removed: Schema.Boolean,
        succeeds: Schema.Boolean,
        phase: Schema.Literals(['install', 'refresh', 'assertions-status']),
        duration: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 20})),
      }),
    ).check(Schema.isBetweenLength(18, 32)),
  },
  ({evaluations}) =>
    Effect.gen(function* () {
      let time = 0;
      const diagnostics = refreshDiagnostics(() => time);
      const initial = diagnostics.snapshot();
      const expectedPhases: string[] = [];
      const frozen = Object.freeze(evaluations.map(value => Object.freeze({...value})));
      const inputBefore = JSON.stringify(evaluations);
      let successes = 0;
      for (const [index, evaluation] of frozen.entries()) {
        const before = diagnostics.snapshot();
        const saved = JSON.stringify(before);
        yield* diagnostics
          .observe(
            evaluation.removed,
            Effect.gen(function* () {
              const active = diagnostics.snapshot();
              expect(active).toMatchObject({
                startedEvaluations: index + 1,
                completedEvaluations: index,
                phase: 'provisioning',
                activeEvaluation: {ordinal: index + 1, removed: evaluation.removed},
              });
              if (active.activeEvaluation) active.activeEvaluation.removed = !evaluation.removed;
              expect(diagnostics.snapshot().activeEvaluation?.removed).toBe(evaluation.removed);
              diagnostics.phase(evaluation.phase);
              time += evaluation.duration;
              return yield* evaluation.succeeds ? Effect.void : Effect.fail('private-failure');
            }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown')))),
          )
          .pipe(Effect.result);
        if (evaluation.succeeds) successes++;
        expectedPhases.push('between-evaluations', 'provisioning', evaluation.phase, 'teardown');
        const after = diagnostics.snapshot();
        expect(after).toMatchObject({
          startedEvaluations: index + 1,
          completedEvaluations: index + 1,
          successfulEvaluations: successes,
          phase: 'between-evaluations',
          activeEvaluation: null,
        });
        expect(after.recent.map(({ordinal, removed, outcome}) => ({ordinal, removed, outcome}))).toEqual(
          frozen
            .slice(0, index + 1)
            .map((entry, ordinal) => ({
              ordinal: ordinal + 1,
              removed: entry.removed,
              outcome: entry.succeeds ? 'Success' : 'Failure',
            }))
            .slice(-16),
        );
        expect(after.phases.map(entry => entry.phase)).toEqual(expectedPhases.slice(-16));
        expect(after.recent.length).toBeLessThanOrEqual(16);
        expect(after.phases.length).toBeLessThanOrEqual(16);
        expect(JSON.stringify(before)).toBe(saved);
        const unmodified = JSON.stringify(after);
        after.recent[0].removed = !after.recent[0].removed;
        after.phases[0].phase = 'release';
        expect(JSON.stringify(diagnostics.snapshot())).toBe(unmodified);
      }
      expect(initial.startedEvaluations).toBe(0);
      expect(initial.recent).toEqual([]);
      expect(initial.phases).toEqual([]);
      expect(JSON.stringify(evaluations)).toBe(inputBefore);
      expect(JSON.stringify(diagnostics.snapshot())).not.toContain('private-failure');
    }),
  {arbitrary: {runs: 30}},
);
