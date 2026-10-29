import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Console, Effect, Terminal} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {clipInteractiveProgressText, promptForSelection, startProgress} from '@threadnote/threadnote/cli_ui';
import {CliOutput, makeQueuedCliWriter, withCliOutputConsole} from '@threadnote/threadnote/effect/cli/output';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('CLI progress indicator', () => {
  effectIt.effect('keeps Effect diagnostics off machine-readable stdout', () =>
    Effect.gen(function* () {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const flush = Effect.void;
      const output = CliOutput.of({
        drain: flush,
        enqueueError: value => stderr.push(value),
        enqueueOutput: value => stdout.push(value),
        flush,
        writeError: value => Effect.sync(() => stderr.push(value)),
        writeFinal: value => Effect.sync(() => stdout.push(value)),
      });

      yield* withCliOutputConsole(
        Effect.gen(function* () {
          yield* Console.log('{"type":"machine-result"}');
          yield* Effect.logWarning('deferred maintenance diagnostic');
        }),
      ).pipe(Effect.provideService(CliOutput, output));

      expect(stdout).toEqual(['{"type":"machine-result"}']);
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toContain('deferred maintenance diagnostic');
    }),
  );

  it('waits for a backpressured pipe write before flushing or closing it', async () => {
    const events: string[] = [];
    let releaseWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>(resolve => {
      releaseWrite = resolve;
    });
    const writer = makeQueuedCliWriter(() => ({
      end: () => {
        events.push('end');
        return 0;
      },
      flush: () => {
        events.push('flush');
        return 0;
      },
      write: async output => {
        events.push(`write:${output}`);
        await pendingWrite;
        events.push('written');
        return output.length;
      },
    }));

    const write = writer.write('complete-json');
    await Promise.resolve();
    expect(events).toEqual(['write:complete-json\n']);
    releaseWrite?.();
    await write;
    await writer.drain();

    expect(events).toEqual(['write:complete-json\n', 'written', 'flush', 'end']);
  });

  it.each(['write', 'flush', 'end'] as const)(
    'silently stops writing after a downstream consumer closes the pipe during %s',
    async failureStage => {
      const events: string[] = [];
      const brokenPipe = Object.assign(new Error('broken pipe'), {code: 'EPIPE'});
      const sinkOperation = (operation: 'end' | 'flush' | 'write') => {
        events.push(operation);
        if (failureStage === operation) throw brokenPipe;
        return 0;
      };
      const writer = makeQueuedCliWriter(() => ({
        end: () => sinkOperation('end'),
        flush: () => sinkOperation('flush'),
        write: () => sinkOperation('write'),
      }));

      await writer.write('requested-prefix');
      await writer.drain();
      await writer.write('unrequested-suffix');
      await writer.drain();

      expect(events).toEqual(
        failureStage === 'write'
          ? ['write']
          : failureStage === 'flush'
            ? ['write', 'flush']
            : ['write', 'flush', 'end'],
      );
    },
  );

  it.each(
    EffectArray.flatMap(['EBADF', 'ENOTTY'] as const, code =>
      EffectArray.map(['write', 'flush', 'end'] as const, failureStage => ({code, failureStage})),
    ),
  )('silently stops writing after $code on a non-TTY sink during $failureStage', async ({code, failureStage}) => {
    const events: string[] = [];
    const invalidFd = Object.assign(new Error('invalid fd'), {code});
    const sinkOperation = (operation: 'end' | 'flush' | 'write') => {
      events.push(operation);
      if (failureStage === operation) throw invalidFd;
      return 0;
    };
    const writer = makeQueuedCliWriter(
      () => ({
        end: () => sinkOperation('end'),
        flush: () => sinkOperation('flush'),
        write: () => sinkOperation('write'),
      }),
      {isTty: false},
    );

    await writer.write('requested-prefix');
    await writer.drain();
    await writer.write('unrequested-suffix');
    await writer.drain();

    expect(events).toEqual(
      failureStage === 'write' ? ['write'] : failureStage === 'flush' ? ['write', 'flush'] : ['write', 'flush', 'end'],
    );
  });

  it('keeps EBADF fail-closed on a TTY sink', async () => {
    const failure = Object.assign(new Error('bad fd'), {code: 'EBADF'});
    const writer = makeQueuedCliWriter(
      () => ({
        end: () => 0,
        flush: () => 0,
        write: () => {
          throw failure;
        },
      }),
      {isTty: true},
    );

    await expect(writer.write('complete-json')).rejects.toBe(failure);
    await expect(writer.flush()).rejects.toBe(failure);
  });

  it('preserves non-consumer-gone sink failures for TTY and pipe writers', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.string(), async (isTty, code) => {
        const consumerGone = code === 'EPIPE' || (!isTty && (code === 'EBADF' || code === 'ENOTTY'));
        const failure = Object.assign(new Error('sink failure'), {code});
        const writer = makeQueuedCliWriter(
          () => ({
            end: () => 0,
            flush: () => 0,
            write: () => {
              throw failure;
            },
          }),
          {isTty},
        );

        if (consumerGone) {
          await expect(writer.write('complete-json')).resolves.toBeUndefined();
          await expect(writer.flush()).resolves.toBeUndefined();
        } else {
          await expect(writer.write('complete-json')).rejects.toBe(failure);
          await expect(writer.flush()).rejects.toBe(failure);
        }
      }),
      {numRuns: 64},
    );
  });

  effectIt.effect('renders each explicit milestone immediately in an interactive terminal', () =>
    Effect.gen(function* () {
      const displays: string[] = [];
      const system = yield* SystemInfo.pipe(provideTestLayer(ApplicationLayer));
      const interactiveSystem = SystemInfo.of({
        ...system,
        environment: () => ({}),
        stdoutIsTTY: true,
      });
      const terminal = Terminal.make({
        columns: Effect.succeed(120),
        display: text =>
          Effect.sync(() => {
            displays.push(text);
          }),
        readInput: Effect.never,
        readLine: Effect.never,
        rows: Effect.succeed(40),
      });
      const output = orderedCliOutput([]);

      yield* Effect.acquireUseRelease(
        startProgress('Building lexical recall index.'),
        progress => progress.update('Building lexical recall index: 64/4,084 (1%).'),
        progress => progress.stop,
      ).pipe(
        Effect.provideService(CliOutput, output),
        Effect.provideService(SystemInfo, interactiveSystem),
        Effect.provideService(Terminal.Terminal, terminal),
      );

      expect(
        EffectArray.some(displays, display =>
          Effect2.pipe(display, EffectString.includes('Building lexical recall index.')),
        ),
      ).toBe(true);
      expect(EffectArray.some(displays, display => Effect2.pipe(display, EffectString.includes('64/4,084 (1%)')))).toBe(
        true,
      );
      expect(displays.at(-1)).toBe('\r\u001b[2K');
    }),
  );

  effectIt.effect('clips interactive TTY progress to the terminal width and skips unchanged updates', () =>
    Effect.gen(function* () {
      const displays: string[] = [];
      const system = yield* SystemInfo.pipe(provideTestLayer(ApplicationLayer));
      const interactiveSystem = SystemInfo.of({
        ...system,
        environment: () => ({}),
        stdoutIsTTY: true,
      });
      const terminal = Terminal.make({
        columns: Effect.succeed(24),
        display: text =>
          Effect.sync(() => {
            displays.push(text);
          }),
        readInput: Effect.never,
        readLine: Effect.never,
        rows: Effect.succeed(40),
      });
      const output = orderedCliOutput([]);
      const longMessage = 'Scanning · 12/345 files · this path must not wrap onto another row';

      yield* Effect.acquireUseRelease(
        startProgress(longMessage),
        progress =>
          Effect.gen(function* () {
            const afterStart = displays.length;
            yield* progress.update(longMessage);
            expect(displays.length).toBe(afterStart);
            yield* progress.update(`${longMessage} · next`);
          }),
        progress => progress.stop,
      ).pipe(
        Effect.provideService(CliOutput, output),
        Effect.provideService(SystemInfo, interactiveSystem),
        Effect.provideService(Terminal.Terminal, terminal),
      );

      expect(EffectArray.some(displays, display => Effect2.pipe(display, EffectString.includes('\n')))).toBe(false);
      expect(EffectArray.some(displays, display => Effect2.pipe(display, EffectString.includes('…')))).toBe(true);
      expect(
        EffectArray.every(displays, display => !Effect2.pipe(display, EffectString.includes('must not wrap'))),
      ).toBe(true);
    }),
  );

  it('clips rewritten progress text to one terminal row', () => {
    expect(clipInteractiveProgressText('short', 80)).toBe('short');
    expect(
      Effect2.pipe(clipInteractiveProgressText('abcdefghijklmnopqrstuvwxyz', 20), EffectString.endsWith('…')),
    ).toBe(true);
    expect(Array.from(clipInteractiveProgressText('abcdefghijklmnopqrstuvwxyz', 20)).length).toBeLessThanOrEqual(16);
    expect(Array.from(clipInteractiveProgressText('abcdefghijklmnopqrstuvwxyz', 10)).length).toBeLessThanOrEqual(6);
    fc.assert(
      fc.property(fc.integer({max: 200, min: 1}), fc.string({maxLength: 80}), (columns, text) => {
        const clipped = clipInteractiveProgressText(text, columns);
        const budget = Math.max(1, Math.floor(columns) - 4);
        const source = Array.from(text);
        const rendered = Array.from(clipped);
        if (source.length <= budget) expect(clipped).toBe(text);
        else expect(rendered.length).toBeLessThanOrEqual(budget);
        expect(
          Effect2.pipe(clipped, EffectString.includes('\n')) || Effect2.pipe(clipped, EffectString.includes('\r')),
        ).toBe(false);
      }),
      {numRuns: 40},
    );
  });

  effectIt.effect('flushes queued headings before an interactive terminal frame', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const system = yield* SystemInfo.pipe(provideTestLayer(ApplicationLayer));
      const interactiveSystem = SystemInfo.of({...system, environment: () => ({}), stdoutIsTTY: true});
      const output = orderedCliOutput(events);
      const terminal = Terminal.make({
        columns: Effect.succeed(120),
        display: text =>
          Effect.sync(() => {
            events.push(`terminal:${text}`);
          }),
        readInput: Effect.never,
        readLine: Effect.never,
        rows: Effect.succeed(40),
      });

      yield* withCliOutputConsole(
        Effect.gen(function* () {
          yield* Console.log('Indexing code graph.');
          const progress = yield* startProgress('Scanning repository source from Git.');
          yield* progress.stop;
        }),
      ).pipe(
        Effect.provideService(CliOutput, output),
        Effect.provideService(SystemInfo, interactiveSystem),
        Effect.provideService(Terminal.Terminal, terminal),
      );

      expect(events[0]).toBe('Indexing code graph.');
      expect(events[1]).toContain('terminal:');
      expect(events[1]).toContain('Scanning repository source from Git.');
    }),
  );

  effectIt.effect('flushes queued menu lines before writing a direct prompt', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const system = yield* SystemInfo.pipe(provideTestLayer(ApplicationLayer));
      const interactiveSystem = SystemInfo.of({
        ...system,
        readLine: (prompt, onLine) => {
          events.push(prompt);
          onLine('1');
          return () => {};
        },
      });
      const output = orderedCliOutput(events);

      const selected = yield* withCliOutputConsole(promptForSelection('Choose a model:', ['Small', 'Large'])).pipe(
        Effect.provideService(CliOutput, output),
        Effect.provideService(SystemInfo, interactiveSystem),
      );

      expect(selected).toBe(0);
      expect(events).toEqual(['Choose a model:', '> 1. Small', '  2. Large', 'Select [1]: ']);
    }),
  );

  effectIt.effect('coalesces rapid line-mode updates while preserving phase boundaries and the final milestone', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo.pipe(provideTestLayer(ApplicationLayer));
      const lineSystem = SystemInfo.of({
        ...system,
        environment: () => ({}),
        stdoutIsTTY: false,
      });

      const captured = yield* captureConsole(
        Effect.acquireUseRelease(
          startProgress('Scanning repository source from Git.'),
          progress =>
            Effect.gen(function* () {
              for (let index = 0; index < 100; index += 1) {
                yield* progress.update(`Scanning · ${index}/100 files`);
              }
              for (let index = 0; index < 100; index += 1) {
                yield* progress.update(`Materializing · ${index}/100 files`);
              }
              yield* progress.update('Ready · 100 files');
            }),
          progress => progress.stop,
        ),
      ).pipe(Effect.provideService(SystemInfo, lineSystem), provideTestLayer(ApplicationLayer));

      expect(Effect2.pipe(captured.output, EffectString.split('\n'))).toEqual([
        'Scanning repository source from Git.',
        'Scanning · 0/100 files',
        'Scanning · 99/100 files',
        'Materializing · 0/100 files',
        'Materializing · 99/100 files',
        'Ready · 100 files',
      ]);
    }),
  );

  effectIt.effect('keeps captured result lines when progress is disabled', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo.pipe(provideTestLayer(ApplicationLayer));
      const quietSystem = SystemInfo.of({
        ...system,
        environment: () => ({THREADNOTE_NO_PROGRESS: '1'}),
        stdoutIsTTY: false,
      });

      const captured = yield* captureConsole(
        Effect.acquireUseRelease(
          startProgress('Would purge · acquiring locks'),
          progress =>
            Effect.gen(function* () {
              yield* progress.update('Would purge · deleting files');
              yield* Console.log('Would remove derived code graph index for checkout abcdef123456.');
            }),
          progress => progress.stop,
        ),
      ).pipe(Effect.provideService(SystemInfo, quietSystem), provideTestLayer(ApplicationLayer));

      expect(captured.output).toBe('Would remove derived code graph index for checkout abcdef123456.');
    }),
  );

  fcEffectProp(
    effectIt,
    'disabled progress emits no console lines',
    {
      messages: fc.array(fc.string({maxLength: 40, minLength: 1}), {maxLength: 8, minLength: 1}),
    },
    ({messages}) =>
      Effect.gen(function* () {
        const system = yield* SystemInfo.pipe(provideTestLayer(ApplicationLayer));
        const quietSystem = SystemInfo.of({
          ...system,
          environment: () => ({THREADNOTE_NO_PROGRESS: '1'}),
          stdoutIsTTY: false,
        });
        const [initial = '', ...updates] = messages;
        const captured = yield* captureConsole(
          Effect.acquireUseRelease(
            startProgress(initial),
            progress => Effect.forEach(updates, message => progress.update(message), {discard: true}),
            progress => progress.stop,
          ),
        ).pipe(Effect.provideService(SystemInfo, quietSystem), provideTestLayer(ApplicationLayer));
        expect(captured.output).toBe('');
      }),
    {fastCheck: {numRuns: 40}},
  );
});

function orderedCliOutput(events: string[]) {
  const pending: string[] = [];
  const flush = Effect.sync(() => {
    events.push(...pending);
    pending.length = 0;
  });
  return CliOutput.of({
    drain: flush,
    enqueueError: output => pending.push(output),
    enqueueOutput: output => pending.push(output),
    flush,
    writeError: output => Effect.sync(() => events.push(output)),
    writeFinal: output => Effect.sync(() => events.push(output)),
  });
}
