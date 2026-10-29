import {Array as EffectArray} from 'effect';
import {Console, Effect} from 'effect';
import {CliOutput} from './cli/output.js';
import {SystemInfo} from '@threadnote/platform/system';

function capturingConsole(parent: Console.Console, lines: string[]): Console.Console {
  const append = (...args: readonly unknown[]): void => {
    lines.push(EffectArray.join(EffectArray.map(args, String), ' '));
  };
  return {
    ...parent,
    error: append,
    log: append,
    warn: append,
  };
}

export function captureConsole<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<{readonly output: string; readonly value: A}, E, R> {
  return Console.consoleWith(parent => {
    const lines: string[] = [];
    const service = capturingConsole(parent, lines);
    const cliOutput = CliOutput.of({
      drain: Effect.void,
      enqueueError: output => {
        lines.push(output);
      },
      enqueueOutput: output => {
        lines.push(output);
      },
      flush: Effect.void,
      writeError: output =>
        Effect.sync(() => {
          lines.push(output);
        }),
      writeFinal: output =>
        Effect.sync(() => {
          lines.push(output);
        }),
    });
    return effect.pipe(
      Effect.provideService(Console.Console, service),
      Effect.provideService(CliOutput, cliOutput),
      Effect.map(value => ({output: EffectArray.join(lines, '\n'), value})),
    );
  });
}

/** Capture stdout while suppressing CLI progress indicators. */
export function captureConsoleWithoutProgress<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<{readonly output: string; readonly value: A}, E, R | SystemInfo> {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    return yield* captureConsole(effect).pipe(
      Effect.provideService(
        SystemInfo,
        SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), THREADNOTE_NO_PROGRESS: '1'}),
        }),
      ),
    );
  });
}
