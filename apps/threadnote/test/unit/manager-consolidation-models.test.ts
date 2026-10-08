import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, Result, Sink, Stream} from 'effect';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as TestClock from 'effect/testing/TestClock';
import * as FC from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  discoverConsolidationModels,
  normalizeCodexModelPage,
  selectConsolidationModel,
} from '../../src/manager/consolidation_models.js';

const layer = Layer.mergeAll(
  BunServices.layer,
  TestSystemInfoLayer,
  Layer.succeed(ChildEnvironmentPolicy, {
    sanitizeExternal: env => ({...env, THREADNOTE_TASK_SENTINEL: undefined}),
    preserveIntendedChild: env => env,
  }),
);
function executable(script: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-models-test-'});
    const file = path.join(root, 'codex');
    yield* fs.writeFileString(file, `#!/bin/sh\n${script}\n`, {mode: 0o700});
    yield* fs.chmod(file, 0o700);
    return file;
  });
}
const protocolScript = `initialized=no\nwhile IFS= read -r line; do
 case "$line" in
 *'"method":"initialize"'*) printf '%s\\n' '{"id":1,"result":{}}';;
 *'"method":"initialized"'*) initialized=yes;;\n *'"method":"model/list"'*) [ "$initialized" = yes ] || exit 8; printf '%s\\n' '{"id":2,"result":{"data":[{"model":"provider-choice","displayName":"Provider choice","isDefault":true,"defaultReasoningEffort":"low"}],"nextCursor":null}}';;
 esac
 done`;

describe('consolidation model choices', () => {
  effectIt.effect('interrupts catalog waiting at the deadline and closes the process scope', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let closed = false;
      let sanitized = false;
      const spawner = ChildProcessSpawner.make(command =>
        Effect.gen(function* () {
          expect(command._tag).toBe('StandardCommand');
          if (command._tag === 'StandardCommand') {
            expect(command.args).toEqual(['app-server', '--listen', 'stdio://']);
            expect(command.options.env).toEqual({SAFE: 'value'});
          }
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true;
            }),
          );
          yield* Deferred.succeed(started, undefined);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.never,
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        }),
      );
      const policy = ChildEnvironmentPolicy.of({
        preserveIntendedChild: env => env,
        sanitizeExternal: () => {
          sanitized = true;
          return {SAFE: 'value'};
        },
      });
      const fiber = yield* discoverConsolidationModels('codex', '/fake/codex').pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(ChildEnvironmentPolicy, policy),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(15_000);
      const result = yield* Fiber.join(fiber);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain('timed out');
      expect(sanitized).toBe(true);
      expect(closed).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  it('filters hidden, malformed and duplicate options while preserving the provider default effort', () => {
    expect(
      normalizeCodexModelPage({
        data: [
          {model: 'a', displayName: 'A', isDefault: true, defaultReasoningEffort: 'low'},
          {model: 'hidden', hidden: true},
          {model: ''},
          {model: 'a'},
          {model: 'b', isDefault: false},
        ],
        nextCursor: 'page-2',
      }),
    ).toEqual({
      models: [
        {id: 'a', label: 'A', isDefault: true, reasoningEffort: 'low'},
        {id: 'b', label: 'b', isDefault: false},
      ],
      nextCursor: 'page-2',
    });
  });
  it('normalization is deterministic and produces unique, nonempty visible ids for arbitrary records', () => {
    FC.assert(
      FC.property(
        FC.array(FC.record({model: FC.string({maxLength: 30}), hidden: FC.boolean(), isDefault: FC.boolean()}), {
          maxLength: 40,
        }),
        data => {
          const input = {data};
          const original = JSON.stringify(input);
          const page = normalizeCodexModelPage(input);
          expect(page).toEqual(normalizeCodexModelPage(input));
          expect(new Set(page.models.map(m => m.id)).size).toBe(page.models.length);
          expect(
            page.models.every(m => m.id.trim().length > 0 && data.some(raw => raw.model === m.id && !raw.hidden)),
          ).toBe(true);
          expect(JSON.stringify(input)).toBe(original);
        },
      ),
      {numRuns: 80},
    );
  });
  it.each([undefined, '', ' ', 'stale', 'x'.repeat(257)])('rejects missing or stale selected model %s', model => {
    expect(() => selectConsolidationModel(model, [{id: 'current', label: 'Current', isDefault: true}])).toThrow();
  });
  it('returns the exact selected provider entry', () => {
    const model = {id: 'current', label: 'Current', isDefault: true, reasoningEffort: 'low'};
    expect(selectConsolidationModel('current', [model])).toBe(model);
  });
  effectIt.effect('uses app-server initialization and model/list without a model turn', () =>
    Effect.gen(function* () {
      const file = yield* executable(protocolScript);
      expect(yield* discoverConsolidationModels('codex', file)).toEqual([
        {id: 'provider-choice', label: 'Provider choice', isDefault: true, reasoningEffort: 'low'},
      ]);
    }).pipe(TestClock.withLive, provideTestLayer(layer)),
  );
  effectIt.effect('follows bounded model pages, filters hidden entries, and drains stderr', () =>
    Effect.gen(function* () {
      const file = yield* executable(`while IFS= read -r line; do
 case "$line" in
 *'"method":"initialize"'*) printf '%s\\n' '{"id":1,"result":{}}';;
 *'"cursor":"next-page"'*) printf '%s\\n' '{"id":3,"result":{"data":[{"model":"second"},{"model":"hidden","hidden":true}],"nextCursor":null}}';;
 *'"method":"model/list"'*) printf '%s\\n' 'diagnostic' >&2; printf '%s\\n' '{"id":2,"result":{"data":[{"model":"first","isDefault":true}],"nextCursor":"next-page"}}';;
 esac
 done`);
      expect((yield* discoverConsolidationModels('codex', file)).map(model => model.id)).toEqual(['first', 'second']);
    }).pipe(TestClock.withLive, provideTestLayer(layer)),
  );
  effectIt.effect.each([
    ["printf '%s\\n' 'malformed'", 'invalid'],
    ['printf \'%s\\n\' \'{"id":1,"error":{"message":"sensitive diagnostic"}}\'', 'sign-in'],
    ['head -c 1048577 /dev/zero', 'response limit'],
  ])('rejects malformed, failed or oversized protocol output: %s', ([script, message]) =>
    Effect.gen(function* () {
      const file = yield* executable(`${script}\nwhile IFS= read -r line; do :; done`);
      const result = yield* discoverConsolidationModels('codex', file).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.message).toContain(message);
        expect(result.failure.message).not.toContain('sensitive diagnostic');
      }
    }).pipe(TestClock.withLive, provideTestLayer(layer)),
  );
  effectIt.effect('returns recoverable error on early process exit', () =>
    Effect.gen(function* () {
      const file = yield* executable('exit 7');
      const result = yield* discoverConsolidationModels('codex', file).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain('exited');
    }).pipe(TestClock.withLive, provideTestLayer(layer)),
  );
});
