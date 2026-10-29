import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Effect, Layer, Schema} from 'effect';
import {
  isolatedLocalModelRuntimeLayer,
  serveWorker,
  type LocalModelWorkerProcess,
  type LocalModelWorkerSpawner,
} from '@threadnote/threadnote/effect/ai/isolated-local-model-runtime';
import {LocalModelRuntime, type LocalModelRuntimeShape} from '@threadnote/inference/engine/local-model-runtime';

import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const generationManifest = EffectOption.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, candidate => candidate.role === 'generation'),
)!;
const embeddingManifest = {
  ...EffectOption.getOrUndefined(
    EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, candidate => candidate.role === 'embedding'),
  )!,
  dimensions: 2,
};

const unicodeTextArbitrary = FC.array(
  FC.constantFrom('a', 'Z', '0', ' ', 'é', '漢', '🙂', '🧪', '\n', '\r', '\0', '\\', '"'),
  {maxLength: 24},
).map(characters => EffectArray.join(characters, ''));

const chunkWidthsArbitrary = FC.array(FC.integer({max: 64, min: 1}), {
  maxLength: 80,
  minLength: 1,
});

const echoRuntime: LocalModelRuntimeShape = {
  diagnostics: Effect.succeed({backend: 'property-test', buildType: 'prebuilt', cpuMathCores: 4}),
  embedMany: request => Effect.succeed(EffectArray.map(request.inputs, input => [input.length, 1])),
  generate: request => Effect.succeed({prompt: request.prompt, system: request.system}),
  rerank: request => Effect.succeed(EffectArray.map(request.documents, document => document.length)),
};

describe('isolated local model worker protocol properties', () => {
  fcEffectProp(
    it,
    'preserves ordered requests across arbitrary UTF-8 byte boundaries and JSONL framing',
    {
      finalNewline: FC.boolean(),
      leadingBlankLines: FC.integer({max: 3, min: 0}),
      requests: FC.array(
        FC.record({
          blankLines: FC.integer({max: 3, min: 0}),
          crlf: FC.boolean(),
          prompt: unicodeTextArbitrary,
          system: unicodeTextArbitrary,
        }),
        {maxLength: 6, minLength: 1},
      ),
      widths: chunkWidthsArbitrary,
    },
    ({finalNewline, leadingBlankLines, requests, widths}) =>
      Effect.gen(function* () {
        const lines: FramedLine[] = EffectArray.map(requests, (request, index) => ({
          blankLines: request.blankLines,
          eol: request.crlf ? '\r\n' : '\n',
          line: JSON.stringify({
            id: `request-${index}`,
            operation: 'generate',
            payload: {
              jsonSchema: {type: 'object'},
              manifest: generationManifest,
              maxTokens: 32,
              modelPath: '/models/generation.gguf',
              prompt: request.prompt,
              system: request.system,
            },
            protocol: 1,
          }),
        }));
        const bytes = new TextEncoder().encode(frameLines(lines, leadingBlankLines, finalNewline));
        const output: string[] = [];

        yield* serveWorker(echoRuntime, {
          input: asyncChunks(splitBytes(bytes, widths)),
          writeLine: line => {
            output.push(line);
            return Promise.resolve();
          },
        });

        expect(EffectArray.map(output, line => JSON.parse(line))).toEqual(
          EffectArray.map(requests, (request, index) => ({
            id: `request-${index}`,
            ok: true,
            protocol: 1,
            result: {prompt: request.prompt, system: request.system},
          })),
        );
      }),
    {fastCheck: {numRuns: 60}},
  );

  fcEffectProp(
    it,
    'reports malformed lines without desynchronizing the next valid request',
    {
      finalNewline: FC.boolean(),
      invalidLines: FC.array(
        FC.record({
          blankLines: FC.integer({max: 2, min: 0}),
          crlf: FC.boolean(),
          line: FC.constantFrom(
            '{',
            'not-json',
            '{}',
            '{"id":"bad id","operation":"diagnostics","payload":{},"protocol":1}',
            '{"id":"wrong-version","operation":"diagnostics","payload":{},"protocol":2}',
            '{"id":"missing-payload","operation":"diagnostics","protocol":1}',
          ),
        }),
        {maxLength: 8, minLength: 1},
      ),
      widths: chunkWidthsArbitrary,
    },
    ({finalNewline, invalidLines, widths}) =>
      Effect.gen(function* () {
        const lines: FramedLine[] = [
          ...EffectArray.map(invalidLines, record => ({
            blankLines: record.blankLines,
            eol: record.crlf ? ('\r\n' as const) : ('\n' as const),
            line: record.line,
          })),
          {
            blankLines: 2,
            eol: '\r\n',
            line: JSON.stringify({
              id: 'valid-tail',
              operation: 'diagnostics',
              payload: {},
              protocol: 1,
            }),
          },
        ];
        const output: string[] = [];

        yield* serveWorker(echoRuntime, {
          input: asyncChunks(splitBytes(new TextEncoder().encode(frameLines(lines, 1, finalNewline)), widths)),
          writeLine: line => {
            output.push(line);
            return Promise.resolve();
          },
        });

        expect(EffectArray.map(output, line => JSON.parse(line))).toEqual([
          ...EffectArray.map(invalidLines, () => ({
            error: {tag: 'WorkerProtocolInvalid'},
            id: 'invalid',
            ok: false,
            protocol: 1,
          })),
          {
            id: 'valid-tail',
            ok: true,
            protocol: 1,
            result: {backend: 'property-test', buildType: 'prebuilt', cpuMathCores: 4},
          },
        ]);
      }),
    {fastCheck: {numRuns: 40}},
  );

  it.effect('rejects unsupported embedding pool values before invoking the runtime', () =>
    Effect.gen(function* () {
      let embeddingCalls = 0;
      const runtime: LocalModelRuntimeShape = {
        ...echoRuntime,
        embedMany: request =>
          Effect.sync(() => {
            embeddingCalls += 1;
            return EffectArray.map(request.inputs, input => [input.length, 1]);
          }),
      };
      const invalidValues: readonly unknown[] = [3, '8'];
      const input = EffectArray.join(
        EffectArray.map(invalidValues, (embeddingContextPoolSize, index) =>
          JSON.stringify({
            id: `invalid-pool-${index}`,
            operation: 'embedMany',
            payload: {
              embeddingContextPoolSize,
              inputs: ['input'],
              manifest: embeddingManifest,
              modelPath: '/models/embedding.gguf',
            },
            protocol: 1,
          }),
        ),
        '\n',
      );
      const output: string[] = [];

      yield* serveWorker(runtime, {
        input: asyncChunks([`${input}\n`]),
        writeLine: line => {
          output.push(line);
          return Promise.resolve();
        },
      });

      expect(EffectArray.map(output, line => JSON.parse(line))).toEqual(
        EffectArray.map(invalidValues, (_, index) => ({
          error: {tag: 'WorkerProtocolInvalid'},
          id: `invalid-pool-${index}`,
          ok: false,
          protocol: 1,
        })),
      );
      expect(embeddingCalls).toBe(0);
    }),
  );

  fcEffectProp(
    it,
    'discards a malformed, mismatched, or oversized worker and retries once with a framed response',
    {
      blankLines: FC.integer({max: 3, min: 0}),
      crlf: FC.boolean(),
      failure: FC.constantFrom('malformed' as const, 'mismatched' as const, 'oversized' as const),
      input: unicodeTextArbitrary,
      widths: chunkWidthsArbitrary,
    },
    ({blankLines, crlf, failure, input, widths}) => {
      const processes: ScriptedWorkerProcess[] = [];
      const spawn: LocalModelWorkerSpawner = () => {
        const attempt = processes.length;
        const worker = new ScriptedWorkerProcess(request => {
          if (attempt === 0) {
            if (failure === 'malformed') worker.stdoutFeed.push('{not-json}\n');
            else if (failure === 'mismatched') {
              worker.stdoutFeed.push(
                `${JSON.stringify({
                  id: `${request.id}-other`,
                  ok: true,
                  protocol: request.protocol,
                  result: [[input.length, 7]],
                })}\n`,
              );
            } else {
              worker.stdoutFeed.push(Effect2.pipe('x', EffectString.repeat(257)));
            }
            return;
          }
          const eol = crlf ? '\r\n' : '\n';
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
          const response = `${eol.repeat(blankLines)}${JSON.stringify({
            id: request.id,
            ok: true,
            protocol: request.protocol,
            result: [[input.length, 7]],
          })}${eol}`;
          for (const chunk of splitBytes(new TextEncoder().encode(response), widths)) {
            worker.stdoutFeed.push(chunk);
          }
        });
        processes.push(worker);
        return worker;
      };

      return Effect.gen(function* () {
        const runtime = yield* LocalModelRuntime;
        expect(
          yield* runtime.embedMany({
            inputs: [input],
            manifest: embeddingManifest,
            modelPath: '/models/embedding.gguf',
          }),
        ).toEqual([[input.length, 7]]);
        expect(processes).toHaveLength(2);
        expect(processes[0].killed).toBe(true);
        expect(processes[0].writes).toHaveLength(1);
        expect(processes[1].writes).toHaveLength(1);
        expect(processes[0].writes[0].id).not.toBe(processes[1].writes[0].id);
      }).pipe(provideTestLayer(workerRuntimeLayer(spawn)));
    },
    {fastCheck: {numRuns: 40}},
  );
});

interface FramedLine {
  readonly blankLines: number;
  readonly eol: '\n' | '\r\n';
  readonly line: string;
}

function frameLines(lines: readonly FramedLine[], leadingBlankLines: number, finalNewline: boolean): string {
  const firstEol = lines[0]?.eol ?? '\n';
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
  let framed = firstEol.repeat(leadingBlankLines);
  for (const entry of lines) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    framed += entry.eol.repeat(entry.blankLines);
    framed += `${entry.line}${entry.eol}`;
  }
  if (!finalNewline && lines.length > 0)
    framed = Effect2.pipe(framed, EffectString.slice(0, -lines.at(-1)!.eol.length));
  return framed;
}

function splitBytes(bytes: Uint8Array, widths: readonly number[]): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const width of widths) {
    if (offset >= bytes.byteLength) break;
    const end = Math.min(bytes.byteLength, offset + width);
    chunks.push(bytes.slice(offset, end));
    offset = end;
  }
  if (offset < bytes.byteLength) chunks.push(bytes.slice(offset));
  return chunks;
}

async function* asyncChunks(chunks: readonly (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> {
  yield* chunks;
}

function workerRuntimeLayer(spawnWorker: LocalModelWorkerSpawner) {
  return isolatedLocalModelRuntimeLayer({
    maxStderrBytes: 128,
    requestDeadlineMs: 1_000,
    responseLimitBytes: 256,
    spawnWorker,
  }).pipe(Layer.provide(TestSystemInfoLayer));
}

const decodeWireRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    operation: Schema.String,
    payload: Schema.Unknown,
    protocol: Schema.Finite,
  }),
);
type WireRequest = ReturnType<typeof decodeWireRequest>;

class ScriptedWorkerProcess implements LocalModelWorkerProcess {
  readonly stderrFeed = new AsyncFeed<string | Uint8Array>();
  readonly stdoutFeed = new AsyncFeed<string | Uint8Array>();
  readonly stderr = this.stderrFeed;
  readonly stdout = this.stdoutFeed;
  readonly writes: WireRequest[] = [];
  readonly exited: Promise<number>;
  killed = false;
  private resolveExit = (_code: number) => {};

  constructor(private readonly onWrite: (request: WireRequest) => void) {
    this.exited = new Promise(resolve => {
      this.resolveExit = resolve;
    });
  }

  closeInput(): void {
    this.stderrFeed.end();
    this.stdoutFeed.end();
    this.resolveExit(0);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.stderrFeed.end();
    this.stdoutFeed.end();
    this.resolveExit(137);
  }

  write(line: string): void {
    const request = decodeWireRequest(JSON.parse(line));
    this.writes.push(request);
    this.onWrite(request);
  }
}

class AsyncFeed<A> implements AsyncIterable<A> {
  private ended = false;
  private readonly queued: A[] = [];
  private readonly waiters: Array<(result: IteratorResult<A>) => void> = [];

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({done: true, value: undefined});
  }

  push(value: A): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({done: false, value});
    else this.queued.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<A> {
    return {
      next: () => {
        const value = this.queued.shift();
        if (value !== undefined) return Promise.resolve({done: false, value});
        if (this.ended) return Promise.resolve({done: true, value: undefined});
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}
