import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {CliOutput, withCliDiagnostics, withCliOutputConsole} from '@threadnote/threadnote/effect/cli/output';
import {Console, Context, Deferred, Effect, Fiber, Layer} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';

class DiagnosticFixture extends Context.Service<DiagnosticFixture, {readonly finishBackground: Effect.Effect<void>}>()(
  '@threadnote/threadnote/test/unit/cli-output-lifecycle.test/DiagnosticFixture',
) {}

const captureLifecycle = (payload: unknown) =>
  Effect.gen(function* () {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = CliOutput.of({
      drain: Effect.void,
      enqueueError: value => stderr.push(value),
      enqueueOutput: value => stdout.push(value),
      flush: Effect.void,
      writeError: value => Effect.sync(() => void stderr.push(value)),
      writeFinal: value => Effect.sync(() => void stdout.push(value)),
    });
    const fixtureLayer = Layer.effect(
      DiagnosticFixture,
      Effect.gen(function* () {
        yield* Effect.logWarning('lifecycle-acquire');
        yield* Effect.addFinalizer(() => Effect.logWarning('lifecycle-release'));
        const trigger = yield* Deferred.make<void>();
        const background = yield* Deferred.await(trigger).pipe(
          Effect.andThen(Effect.logWarning('lifecycle-background')),
          Effect.forkScoped,
        );
        return {
          finishBackground: Deferred.succeed(trigger, undefined).pipe(
            Effect.andThen(Fiber.join(background)),
            Effect.asVoid,
          ),
        };
      }),
    );
    const command = withCliOutputConsole(
      Effect.gen(function* () {
        const fixture = yield* DiagnosticFixture;
        yield* fixture.finishBackground;
        yield* Effect.logWarning('lifecycle-command');
        yield* Console.log(JSON.stringify(payload));
      }),
    ).pipe(Effect.provideService(CliOutput, output));
    const lifecycle = Effect.scoped(
      Layer.build(fixtureLayer).pipe(Effect.flatMap(context => command.pipe(Effect.provide(context)))),
    ).pipe(withCliDiagnostics);

    yield* Console.consoleWith(parent =>
      lifecycle.pipe(
        Effect.provideService(Console.Console, {
          ...parent,
          log: (...args: readonly unknown[]) => void stdout.push(EffectArray.join(EffectArray.map(args, String), ' ')),
          error: (...args: readonly unknown[]) =>
            void stderr.push(EffectArray.join(EffectArray.map(args, String), ' ')),
        }),
      ),
    );
    return {stdout, stderr};
  });

describe('CLI diagnostic lifecycle', () => {
  effectIt.effect('keeps service startup, inherited background and shutdown warnings off JSON stdout', () =>
    Effect.gen(function* () {
      const result = yield* captureLifecycle({type: 'machine-result', negativeZero: -0});

      expect(result.stdout).toEqual(['{"type":"machine-result","negativeZero":0}']);
      expect(result.stderr).toHaveLength(4);
      for (const [index, stage] of ['acquire', 'background', 'command', 'release'].entries()) {
        expect(result.stderr[index]).toContain(`lifecycle-${stage}`);
      }
    }),
  );

  fcEffectProp(
    effectIt,
    'preserves arbitrary JSON payloads across the diagnostic lifecycle',
    {payload: fc.jsonValue()},
    ({payload}) =>
      Effect.gen(function* () {
        const result = yield* captureLifecycle(payload);

        expect(result.stdout).toEqual([JSON.stringify(payload)]);
        expect(JSON.parse(EffectArray.join(result.stdout, '\n'))).toEqual(JSON.parse(JSON.stringify(payload)));
        expect(result.stderr).toHaveLength(4);
      }),
    {fastCheck: {numRuns: 30}},
  );
});
