import {Console, Context, Effect, Layer, Logger, Schema} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';

class CliOutputError extends Schema.TaggedError<CliOutputError>()('CliOutputError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export interface CliOutputShape {
  readonly drain: Effect.Effect<void, Error>;
  readonly enqueueError: (output: string) => void;
  readonly enqueueOutput: (output: string) => void;
  readonly flush: Effect.Effect<void, Error>;
  readonly writeError: (output: string) => Effect.Effect<void, Error>;
  readonly writeFinal: (output: string) => Effect.Effect<void, Error>;
}

export function makeFinalCliOutput(write: (output: string) => Promise<void>) {
  return Effect.fn('cliOutput.writeFinal')(function* (output: string) {
    yield* Effect.tryPromise({
      try: () => write(output),
      catch: cause => CliOutputError.make({cause, message: 'Failed to write complete Threadnote CLI output.'}),
    });
  });
}

interface CliOutputSink {
  readonly end: (error?: Error) => number | Promise<number>;
  readonly flush: () => number | Promise<number>;
  readonly write: (chunk: string) => number | Promise<number>;
}

const CONSUMER_GONE_ON_PIPE_CODES = new Set(['EBADF', 'ENOTTY']);

const isConsumerGoneError = (cause: unknown, isTty: boolean): boolean => {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false;
  const code = String(cause.code);
  return code === 'EPIPE' || (!isTty && CONSUMER_GONE_ON_PIPE_CODES.has(code));
};

/** @internal Exported so pipe-backpressure ordering can be regression-tested without a real subprocess. */
export function makeQueuedCliWriter(open: () => CliOutputSink, options: {readonly isTty?: boolean} = {}) {
  const isTty = options.isTty === true;
  let sink: CliOutputSink | undefined;
  let tail = Promise.resolve();
  let failure: unknown;
  let ended = false;
  let consumerClosed = false;
  const write = (output: string): Promise<void> => {
    const write = tail.then(async () => {
      if (consumerClosed) return;
      try {
        sink ??= open();
        // Bun may complete a pipe write asynchronously once the OS pipe reaches
        // backpressure. Flushing before that promise settles can close a large
        // final JSON payload at an arbitrary prefix on slower hosts.
        await sink.write(`${output}\n`);
        await sink.flush();
      } catch (cause) {
        // `head` closing after its requested prefix is EPIPE. Detached
        // auto-update children writing to ignored/invalid non-TTY stdio can
        // also surface EBADF/ENOTTY. Interactive TTYs stay fail-closed for
        // those codes so machine-readable writeFinal cannot silently drop.
        if (!isConsumerGoneError(cause, isTty)) throw cause;
        consumerClosed = true;
      }
    });
    tail = write.catch(cause => {
      failure ??= cause;
    });
    return write;
  };
  const flush = async (): Promise<void> => {
    await tail;
    if (failure !== undefined) {
      throw failure instanceof Error ? failure : new Error('Could not finish writing CLI output.', {cause: failure});
    }
  };
  return {
    drain: async (): Promise<void> => {
      await flush();
      if (sink !== undefined && !ended && !consumerClosed) {
        ended = true;
        try {
          await sink.end();
        } catch (cause) {
          if (!isConsumerGoneError(cause, isTty)) throw cause;
          consumerClosed = true;
        }
      }
    },
    enqueue: (output: string): void => {
      void write(output);
    },
    flush,
    write,
  };
}

const formatConsoleArguments = (arguments_: readonly unknown[]): string =>
  arguments_.map(value => (typeof value === 'string' ? value : String(value))).join(' ');

export class CliOutput extends Context.Service<CliOutput, CliOutputShape>()(
  '@threadnote/threadnote/effect/cli/output/CliOutput',
) {
  static readonly layer = Layer.effect(
    CliOutput,
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const stdout = makeQueuedCliWriter(() => Bun.stdout.writer({highWaterMark: 64 * 1024}), {
        isTty: system.stdoutIsTTY,
      });
      const stderr = makeQueuedCliWriter(() => Bun.stderr.writer({highWaterMark: 64 * 1024}), {
        isTty: system.stderrIsTTY === true,
      });
      return CliOutput.of({
        drain: Effect.tryPromise({
          try: () => Promise.all([stdout.drain(), stderr.drain()]).then(() => undefined),
          catch: cause => CliOutputError.make({cause, message: 'Failed to drain Threadnote CLI output.'}),
        }),
        enqueueError: stderr.enqueue,
        enqueueOutput: stdout.enqueue,
        flush: Effect.tryPromise({
          try: () => Promise.all([stdout.flush(), stderr.flush()]).then(() => undefined),
          catch: cause => CliOutputError.make({cause, message: 'Failed to flush Threadnote CLI output.'}),
        }),
        writeError: makeFinalCliOutput(stderr.write),
        writeFinal: makeFinalCliOutput(stdout.write),
      });
    }),
  );
}

/** Apply outside runtime layers so their acquisition, background fibers and finalizers inherit stderr logging. */
export const withCliDiagnostics = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Logger.LogToStderr, true));

/** Routes Effect Console output through the same awaited, backpressured sinks as final payloads. */
export const withCliOutputConsole = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const output = yield* CliOutput;
    return yield* Console.consoleWith(parent =>
      effect.pipe(
        // Machine-readable commands own stdout. Effect diagnostics, including failures from inherited detached
        // fibers, must use stderr so a late log line cannot follow and invalidate the final JSON document.
        withCliDiagnostics,
        Effect.provideService(Console.Console, {
          ...parent,
          debug: (...arguments_: readonly unknown[]) => output.enqueueOutput(formatConsoleArguments(arguments_)),
          error: (...arguments_: readonly unknown[]) => output.enqueueError(formatConsoleArguments(arguments_)),
          info: (...arguments_: readonly unknown[]) => output.enqueueOutput(formatConsoleArguments(arguments_)),
          log: (...arguments_: readonly unknown[]) => output.enqueueOutput(formatConsoleArguments(arguments_)),
          warn: (...arguments_: readonly unknown[]) => output.enqueueError(formatConsoleArguments(arguments_)),
        }),
        Effect.ensuring(output.drain.pipe(Effect.orDie)),
      ),
    );
  });

export const writeFinalCliOutput = Effect.fn('cliOutput.writeFinalFromService')(function* (output: string) {
  const cliOutput = yield* CliOutput;
  yield* cliOutput.writeFinal(output);
});

export const flushCliOutput = Effect.flatMap(CliOutput, output => output.flush).pipe(Effect.orDie);
