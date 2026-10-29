import {Array as EffectArray} from 'effect';
import {Clock, Console, Effect, Fiber, Ref, Schedule, Semaphore, Terminal} from 'effect';
import {CliOutput, flushCliOutput} from './effect/cli/output.js';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

type ColorName = 'blue' | 'cyan' | 'dim' | 'green' | 'red' | 'yellow';

const ANSI: Record<ColorName | 'bold' | 'reset', string> = {
  blue: '\u001b[34m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  reset: '\u001b[0m',
  yellow: '\u001b[33m',
};

let colorEnabled = false;

export const initializeCliUi = Effect.fn('cliUi.initialize')(function* () {
  const system = yield* SystemInfo;
  const environment = system.environment();
  colorEnabled =
    system.stdoutIsTTY &&
    environment.NO_COLOR === undefined &&
    environment.CI === undefined &&
    environment.TERM !== 'dumb';
});

export function color(name: ColorName, text: string): string {
  if (!shouldUseColor()) {
    return text;
  }
  return `${ANSI[name]}${text}${ANSI.reset}`;
}

export function bold(text: string): string {
  if (!shouldUseColor()) {
    return text;
  }
  return `${ANSI.bold}${text}${ANSI.reset}`;
}

export function command(text: string): string {
  return color('cyan', text);
}

export function heading(text: string): string {
  return bold(text);
}

export function info(text: string): string {
  return color('cyan', text);
}

export function muted(text: string): string {
  return color('dim', text);
}

export function success(text: string): string {
  return color('green', text);
}

export function warning(text: string): string {
  return color('yellow', text);
}

export function failure(text: string): string {
  return color('red', text);
}

export function keyValue(label: string, value: string): string {
  return `${label}: ${value}`;
}

export const promptForConfirmation = Effect.fn('cliUi.promptForConfirmation')(function* (
  prompt: string,
  defaultYes = false,
) {
  const system = yield* SystemInfo;
  yield* flushCliOutput;
  return yield* Effect.callback<boolean>(resume => {
    const cleanup = system.readLine(prompt, answer => resume(Effect.succeed(confirmationAnswer(answer, defaultYes))));
    return Effect.sync(cleanup);
  });
});

export function confirmationAnswer(answer: string, defaultYes = false): boolean {
  const normalized = Effect2.pipe(answer, EffectString.trim, EffectString.toLowerCase);
  return normalized === '' ? defaultYes : normalized === 'y' || normalized === 'yes';
}

export function selectionIndex(answer: string, choiceCount: number, defaultIndex = 0): number | undefined {
  const normalized = Effect2.pipe(answer, EffectString.trim);
  if (normalized === '') {
    return defaultIndex >= 0 && defaultIndex < choiceCount ? defaultIndex : undefined;
  }
  const selected = Number(normalized);
  return Number.isInteger(selected) && selected >= 1 && selected <= choiceCount ? selected - 1 : undefined;
}

export function promptForSelection(
  prompt: string,
  choices: readonly string[],
  defaultIndex = 0,
): Effect.Effect<number, never, CliOutput | SystemInfo> {
  return Effect.gen(function* () {
    if (choices.length === 0) {
      return -1;
    }
    yield* Console.log(prompt);
    for (const [index, choice] of choices.entries()) {
      yield* Console.log(`${index === defaultIndex ? '>' : ' '} ${index + 1}. ${choice}`);
    }
    const system = yield* SystemInfo;
    while (true) {
      yield* flushCliOutput;
      const answer = yield* Effect.callback<string>(resume => {
        const cleanup = system.readLine(`Select [${defaultIndex + 1}]: `, line => resume(Effect.succeed(line)));
        return Effect.sync(cleanup);
      });
      const selected = selectionIndex(answer, choices.length, defaultIndex);
      if (selected !== undefined) {
        return selected;
      }
      yield* Console.log(`Enter a number from 1 to ${choices.length}, then press Enter.`);
    }
  });
}

export function shouldUseColor(): boolean {
  return colorEnabled;
}

export function withSpinnerEffect<A, E, R>(message: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const environment = system.environment();
    if (!system.stdoutIsTTY || environment.CI !== undefined || environment.THREADNOTE_NO_SPINNER !== undefined) {
      return yield* effect;
    }
    return yield* Effect.acquireUseRelease(
      startSpinner(message),
      () => effect,
      spinner => spinner.stop(),
    );
  });
}

const startSpinner = Effect.fn('cliUi.startSpinner')(function* (message: string) {
  const terminal = yield* Terminal.Terminal;
  const output = yield* CliOutput;
  const flush = output.flush.pipe(Effect.orDie);
  const frames = ['-', '\\', '|', '/'];
  const frameIndex = yield* Ref.make(0);
  const render = Ref.getAndUpdate(frameIndex, index => (index + 1) % frames.length).pipe(
    Effect.flatMap(index =>
      flush.pipe(Effect.andThen(terminal.display(`\r\u001b[2K${muted(frames[index])} ${message}`))),
    ),
  );
  yield* render;
  const fiber = yield* render.pipe(Effect.repeat(Schedule.spaced(100)), Effect.forkDetach);
  return {
    stop: () => Fiber.interrupt(fiber).pipe(Effect.andThen(flush), Effect.andThen(terminal.display('\r\u001b[2K'))),
  };
});

export interface ProgressIndicator {
  update(message: string): Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

const INTERACTIVE_PROGRESS_SPINNER_WIDTH = 4;

/** Keep rewritten TTY progress on one visual row so long status text cannot wrap and flood the terminal. */
export function clipInteractiveProgressText(text: string, columns: number): string {
  const width = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
  const budget = Math.max(1, width - INTERACTIVE_PROGRESS_SPINNER_WIDTH);
  const characters = Array.from(text);
  if (characters.length <= budget) return text;
  if (budget <= 1) return '…';
  return `${EffectArray.join(characters.slice(0, budget - 1), '')}…`;
}

export function withProgressLine<A, E, R>(
  initial: string,
  use: (update: (message: string) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    startProgress(initial),
    progress => use(message => progress.update(message).pipe(Effect.ignore)),
    progress => progress.stop.pipe(Effect.ignore),
  );
}

interface LineProgressState {
  readonly family: string;
  readonly lastEmittedAtMilliseconds: number;
  readonly lastEmittedMessage: string;
  readonly pendingMessage?: string;
}

const LINE_PROGRESS_INTERVAL_MILLISECONDS = 1_000;

export const startProgress = Effect.fn('cliUi.startProgress')(function* (message: string) {
  const system = yield* SystemInfo;
  const environment = system.environment();
  if (environment.THREADNOTE_NO_PROGRESS !== undefined) {
    return {
      stop: Effect.void,
      update: (_nextMessage: string) => Effect.void,
    };
  }
  if (!system.stdoutIsTTY || environment.CI !== undefined || environment.THREADNOTE_NO_SPINNER !== undefined) {
    yield* Console.log(message);
    const state = yield* Ref.make<LineProgressState>({
      family: progressMessageFamily(message),
      lastEmittedAtMilliseconds: yield* Clock.currentTimeMillis,
      lastEmittedMessage: message,
    });
    const gate = yield* Semaphore.make(1);
    return {
      update: (nextMessage: string) =>
        gate.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (nextMessage === current.lastEmittedMessage || nextMessage === current.pendingMessage) return;
            const now = yield* Clock.currentTimeMillis;
            const family = progressMessageFamily(nextMessage);
            const familyChanged = family !== current.family;
            if (familyChanged) {
              if (
                current.pendingMessage !== undefined &&
                current.pendingMessage !== current.lastEmittedMessage &&
                current.pendingMessage !== nextMessage
              ) {
                yield* Console.log(current.pendingMessage);
              }
              yield* Console.log(nextMessage);
              yield* Ref.set(state, {
                family,
                lastEmittedAtMilliseconds: now,
                lastEmittedMessage: nextMessage,
              });
              return;
            }
            if (now - current.lastEmittedAtMilliseconds >= LINE_PROGRESS_INTERVAL_MILLISECONDS) {
              yield* Console.log(nextMessage);
              yield* Ref.set(state, {
                family,
                lastEmittedAtMilliseconds: now,
                lastEmittedMessage: nextMessage,
              });
              return;
            }
            yield* Ref.set(state, {...current, pendingMessage: nextMessage});
          }),
        ),
      stop: gate.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.pendingMessage === undefined || current.pendingMessage === current.lastEmittedMessage) return;
          yield* Console.log(current.pendingMessage);
          yield* Ref.set(state, {
            family: progressMessageFamily(current.pendingMessage),
            lastEmittedAtMilliseconds: yield* Clock.currentTimeMillis,
            lastEmittedMessage: current.pendingMessage,
          });
        }),
      ),
    };
  }

  const terminal = yield* Terminal.Terminal;
  const output = yield* CliOutput;
  const flush = output.flush.pipe(Effect.orDie);
  const frames = ['-', '\\', '|', '/'];
  const frameIndex = yield* Ref.make(0);
  const currentMessage = yield* Ref.make(message);
  const render = Effect.all([
    Ref.getAndUpdate(frameIndex, index => (index + 1) % frames.length),
    Ref.get(currentMessage),
    terminal.columns.pipe(Effect.orElseSucceed(() => 80)),
  ]).pipe(
    Effect.flatMap(([index, text, columns]) =>
      flush.pipe(
        Effect.andThen(
          terminal.display(
            `\r\u001b[2K${muted(frames[index])} ${clipInteractiveProgressText(text, Number.isFinite(columns) ? columns : 80)}`,
          ),
        ),
      ),
    ),
  );
  yield* render;
  const fiber = yield* render.pipe(Effect.repeat(Schedule.spaced(100)), Effect.forkDetach);
  return {
    update: (nextMessage: string) =>
      Ref.get(currentMessage).pipe(
        Effect.flatMap(current =>
          current === nextMessage ? Effect.void : Ref.set(currentMessage, nextMessage).pipe(Effect.andThen(render)),
        ),
      ),
    stop: Fiber.interrupt(fiber).pipe(Effect.andThen(flush), Effect.andThen(terminal.display('\r\u001b[2K'))),
  };
});

function progressMessageFamily(message: string): string {
  const separator = / · |:| \(/.exec(message);
  return separator ? Effect2.pipe(message, EffectString.slice(0, separator.index)) : message;
}
