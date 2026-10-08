import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import * as FC from 'fast-check';
import {describe, expect} from 'vitest';
import {CommandExecutor} from '@threadnote/platform/command';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {runConsolidationAgentCommand} from '../../src/manager/consolidation_agent.js';

const commandLayer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

function fakeExecutable(script: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-consolidation-agent-test-'});
    const executable = path.join(root, 'fake-agent');
    yield* fs.writeFileString(executable, `#!/bin/sh\n${script}\n`, {mode: 0o700});
    yield* fs.chmod(executable, 0o700);
    return executable;
  });
}

function finalAnswerCommandLayer(stdout: string, stderr: string, finalAnswer: string, exitCode = 0) {
  return Layer.effect(
    CommandExecutor,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return CommandExecutor.of({
        execute: (_executable, args) =>
          Effect.gen(function* () {
            const outputPath = args.at(-1);
            if (outputPath) yield* fs.writeFileString(outputPath, finalAnswer).pipe(Effect.orDie);
            return {exitCode, stderr, stdout};
          }),
        executeStreaming: () => Effect.succeed({exitCode: 0, stderr: '', stdout: ''}),
      });
    }),
  ).pipe(Layer.provideMerge(BunServices.layer));
}

describe('external consolidation agent output boundary', () => {
  effectIt.effect('uses only Codex final-answer output despite stdout and stderr diagnostics', () =>
    Effect.gen(function* () {
      const executable = yield* fakeExecutable(
        `out=\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output-last-message" ]; then out="$2"; shift 2; else shift; fi\ndone\nprintf '%s\\n' '{"type":"thread.started"}' 'stdout diagnostic'\nprintf '%s\\n' 'stderr diagnostic' >&2\nprintf '%s' 'the reviewed replacement body' > "$out"`,
      );
      const draft = yield* runConsolidationAgentCommand('codex', executable, 'source prompt');
      expect(draft).toBe('the reviewed replacement body');
    }).pipe(provideTestLayer(commandLayer)),
  );

  effectIt.effect('accepts a Codex turn that recovers from an intermediate stream error', () =>
    runConsolidationAgentCommand('codex', '/fake/codex', 'source prompt').pipe(
      provideTestLayer(
        finalAnswerCommandLayer(
          '{"type":"error","message":"stream interrupted; retrying"}\n{"type":"turn.completed"}',
          '',
          'recovered final answer',
        ),
      ),
      Effect.tap(draft => Effect.sync(() => expect(draft).toBe('recovered final answer'))),
    ),
  );

  effectIt.effect.each(['codex', 'claude'] as const)(
    'keeps bounded actionable diagnostics for a failed %s process',
    agent =>
      Effect.gen(function* () {
        const diagnostic = `${'x'.repeat(1000)}invalid agent configuration`;
        const result = yield* runConsolidationAgentCommand(agent, '/fake/agent', 'source prompt').pipe(
          provideTestLayer(finalAnswerCommandLayer('echoed source prompt', diagnostic, '', 7)),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain('invalid agent configuration');
          expect(result.failure.message).toContain('exited with 7');
          expect(result.failure.message).not.toContain('echoed source prompt');
          expect(result.failure.message.length).toBeLessThan(550);
        }
      }),
  );

  effectIt.effect('rejects a structured failed Codex turn even when the command exits successfully', () =>
    Effect.gen(function* () {
      const executable = yield* fakeExecutable(
        `out=\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output-last-message" ]; then out="$2"; shift 2; else shift; fi\ndone\nprintf '%s\\n' '{"type":"turn.failed","error":{"message":"unsupported model"}}'\nprintf '%s' 'should not be accepted' > "$out"\nexit 0`,
      );
      const result = yield* runConsolidationAgentCommand('codex', executable, 'source prompt').pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain('unsupported model');
    }).pipe(provideTestLayer(commandLayer)),
  );

  effectIt.effect.each([
    ['nonzero exit', 'exit 7', 'codex exited with'],
    ['missing output file', 'exit 0', 'codex returned no final answer.'],
    [
      'empty output file',
      `out=\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output-last-message" ]; then out="$2"; shift 2; else shift; fi\ndone\n: > "$out"\nexit 0`,
      'codex returned an empty final answer.',
    ],
  ] as const)('rejects Codex %s without using process output as a draft', ([, script, message]) =>
    Effect.gen(function* () {
      const executable = yield* fakeExecutable(script);
      const result = yield* runConsolidationAgentCommand('codex', executable, 'source prompt').pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain(message);
    }).pipe(provideTestLayer(commandLayer)),
  );

  effectIt.effect('keeps Claude print stdout as the draft', () =>
    Effect.gen(function* () {
      const executable = yield* fakeExecutable(`printf '%s\\n' 'Claude replacement body'`);
      const draft = yield* runConsolidationAgentCommand('claude', executable, 'source prompt');
      expect(draft).toBe('Claude replacement body');
    }).pipe(provideTestLayer(commandLayer)),
  );

  fcEffectProp(
    effectIt,
    'keeps Codex diagnostics independent from its final-answer file',
    {
      draft: FC.string({minLength: 1, maxLength: 80}).filter(value => value.trim().length > 0),
      stderr: FC.array(FC.string({maxLength: 80}), {maxLength: 8}).map(lines =>
        lines.map(line => `diagnostic:${JSON.stringify(line)}`).join('\n'),
      ),
      stdout: FC.array(FC.string({maxLength: 80}), {maxLength: 8}).map(lines =>
        lines.map(line => `diagnostic:${JSON.stringify(line)}`).join('\n'),
      ),
    },
    ({draft, stderr, stdout}) =>
      runConsolidationAgentCommand('codex', '/fake/codex', 'source prompt').pipe(
        provideTestLayer(finalAnswerCommandLayer(stdout, stderr, draft)),
        Effect.tap(actual => Effect.sync(() => expect(actual).toBe(draft.trim()))),
      ),
    {fastCheck: {numRuns: 24}},
  );

  effectIt.effect.each([
    ['exactly 32 KiB ASCII', 'a'.repeat(32 * 1024), true],
    ['over 32 KiB ASCII', 'a'.repeat(32 * 1024 + 1), false],
    ['one byte over with UTF-8', `${'a'.repeat(32 * 1024 - 1)}é`, false],
    ['exactly 32 KiB with UTF-8', `${'a'.repeat(32 * 1024 - 4)}😀`, true],
  ] as const)('enforces the UTF-8 byte limit for %s', ([, draft, accepted]) =>
    Effect.gen(function* () {
      const result = yield* runConsolidationAgentCommand('codex', '/fake/codex', 'source prompt').pipe(
        provideTestLayer(finalAnswerCommandLayer('', '', draft)),
        Effect.result,
      );
      expect(Result.isSuccess(result)).toBe(accepted);
      if (Result.isSuccess(result)) expect(new TextEncoder().encode(result.success).byteLength).toBe(32 * 1024);
      else expect(result.failure.message).toContain('32 KiB');
    }),
  );
});
