import {it as effectIt} from '@effect/vitest';
import {TestError} from '@threadnote/testing/test-error';
import {mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Clock, Effect, Fiber, FileSystem, Path, Result, Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  runBinaryCommandEffect,
  runCommandEffect,
  runDetachedCommandEffect,
  runStreamingCommandEffect,
} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE,
  TELEMETRY_CHILD_ENVIRONMENT_VARIABLE,
  TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE,
  TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE,
  TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE,
} from '@threadnote/threadnote/telemetry/session';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect as run} from '../helpers/effect-runtime.js';
import * as EffectRecord from 'effect/Record';

describe('Effect CommandExecutor', () => {
  it('returns captured output for successful commands', async () => {
    const result = await run(runCommandEffect(process.execPath, ['-e', 'process.stdout.write("ok")']));

    expect(result).toEqual({exitCode: 0, stderr: '', stdout: 'ok'});
  });

  it('collects chunked binary output without changing byte order', async () => {
    const result = await run(
      runBinaryCommandEffect(process.execPath, [
        '-e',
        'for (let index = 0; index < 1024; index += 1) process.stdout.write(Buffer.alloc(4096, index % 251))',
      ]),
    );

    expect(result.stdout.byteLength).toBe(4 * 1_048_576);
    expect(result.stdout[0]).toBe(0);
    expect(result.stdout[4096]).toBe(1);
    expect(result.stdout.at(-1)).toBe(1023 % 251);
  });

  it('models non-zero exits in the typed error channel', async () => {
    const result = await run(
      runCommandEffect(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(7)']).pipe(
        Effect.match({onFailure: Result.fail, onSuccess: Result.succeed}),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result) && result.failure._tag === 'CommandFailed') {
      expect(result.failure.exitCode).toBe(7);
      expect(result.failure.stderr).toBe('bad');
    }
  });

  it('redacts sensitive command arguments from typed failures', async () => {
    const secret = 'manager-bearer-token-value';
    const result = await run(
      runCommandEffect(process.execPath, [
        '-e',
        'process.stderr.write(process.argv[1]); process.exit(7)',
        `Authorization: Bearer ${secret}`,
      ]).pipe(Effect.match({onFailure: Result.fail, onSuccess: Result.succeed})),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(JSON.stringify(result.failure)).not.toContain(secret);
      expect(result.failure.message).toContain('[REDACTED]');
    }
  });

  it('models timeouts without throwing an untyped Error', async () => {
    const result = await run(
      runCommandEffect(process.execPath, ['-e', 'setTimeout(() => undefined, 5000)'], {timeoutMs: 25}).pipe(
        Effect.match({onFailure: Result.fail, onSuccess: Result.succeed}),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result) && result.failure._tag === 'CommandTimedOut') {
      expect(result.failure.timeoutMs).toBe(25);
    }
  });

  it('preserves allowFailure compatibility for callers that inspect exit codes', async () => {
    const result = await run(
      runCommandEffect(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'], {
        allowFailure: true,
      }),
    );

    expect(result).toEqual({exitCode: 3, stderr: 'bad', stdout: ''});
  });

  it('interrupts streaming commands through the command boundary', async () => {
    const childPid = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const pathService = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-streaming-command-'});
          const pidPath = pathService.join(directory, 'child.pid');
          const fiber = yield* runStreamingCommandEffect(process.execPath, [
            '-e',
            'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000)',
            pidPath,
          ]).pipe(Effect.forkScoped);
          const deadline = (yield* Clock.currentTimeMillis) + 5000;
          let pid: number | undefined;
          while ((yield* Clock.currentTimeMillis) < deadline) {
            const content = yield* fs.readFileString(pidPath).pipe(Effect.orElseSucceed(() => undefined));
            const candidate = Number(content);
            if (Number.isInteger(candidate) && candidate > 0) {
              pid = candidate;
              break;
            }
            yield* Effect.sleep(10);
          }
          if (pid === undefined) {
            return yield* TestError.make({message: 'Streaming child did not report readiness.'});
          }
          yield* Fiber.interrupt(fiber);
          return pid;
        }),
      ),
    );

    expect(isProcessRunning(childPid)).toBe(false);
  });

  it('supports inherited output for interactive streaming commands', async () => {
    const result = await run(
      runStreamingCommandEffect(process.execPath, ['-e', 'process.exit(0)'], {inheritOutput: true}),
    );

    expect(result).toEqual({exitCode: 0, stderr: '', stdout: ''});
  });

  effectIt.effect('captures stderr from non-inherited streaming failures', () =>
    runStreamingCommandEffect(process.execPath, ['-e', 'process.stderr.write("post-update boom"); process.exit(1)'], {
      inheritOutput: false,
    }).pipe(
      Effect.tap(result =>
        Effect.sync(() => {
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain('post-update boom');
        }),
      ),
      provideTestLayer(ApplicationLayer),
    ),
  );

  effectIt.effect('closes stdin for non-inherited streaming commands', () =>
    runStreamingCommandEffect(
      process.execPath,
      [
        '-e',
        'process.stdin.resume(); process.stdin.on("data", () => process.exit(2)); process.stdin.on("end", () => process.exit(0)); setTimeout(() => process.exit(3), 2000)',
      ],
      {inheritOutput: false},
    ).pipe(
      Effect.tap(result =>
        Effect.sync(() => {
          expect(result.exitCode).toBe(0);
        }),
      ),
      provideTestLayer(ApplicationLayer),
    ),
  );

  it('waits for a complete detached-child receipt instead of treating file creation as completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadnote-detached-receipt-'));
    const receiptPath = join(directory, 'environment.json');
    try {
      await writeFile(receiptPath, '{', 'utf8');
      const receipt = readCompleteEnvironmentReceipt(receiptPath);
      await new Promise(resolve => setTimeout(resolve, 20));
      await writeFile(receiptPath, JSON.stringify({THREADNOTE_DETACHED_SAFE_VALUE: 'complete'}), 'utf8');

      await expect(receipt).resolves.toEqual({THREADNOTE_DETACHED_SAFE_VALUE: 'complete'});
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  it('scrubs telemetry correlation state from detached children', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadnote-detached-command-'));
    const receiptPath = join(directory, 'environment.json');
    const privateValues = {
      [TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]: 'tns_0123456789abcdef0123456789abcdef',
      [TELEMETRY_CHILD_ENVIRONMENT_VARIABLE]: 'mcp-server',
      [TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]: 'tng_0123456789abcdef',
      [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
      [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'private-provider-session',
    };
    try {
      const spawned = await run(
        runDetachedCommandEffect(
          process.execPath,
          ['-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))', receiptPath],
          {env: {...privateValues, THREADNOTE_DETACHED_SAFE_VALUE: 'preserved'}},
        ),
      );
      expect(spawned).toBe(true);
      const childEnvironment = await readCompleteEnvironmentReceipt(receiptPath);
      expect(childEnvironment).toEqual(expect.objectContaining({THREADNOTE_DETACHED_SAFE_VALUE: 'preserved'}));
      for (const variable of EffectRecord.keys(privateValues)) {
        expect(childEnvironment[variable]).toBeUndefined();
      }
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  it('preserves only a consent-bound alias for a declared detached Threadnote child', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadnote-detached-internal-command-'));
    const receiptPath = join(directory, 'environment.json');
    const sessionId = 'tns_0123456789abcdef0123456789abcdef';
    const consentGeneration = 'tng_0123456789abcdef0123456789abcdef';
    try {
      const spawned = await run(
        runDetachedCommandEffect(
          process.execPath,
          ['-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))', receiptPath],
          {
            env: {
              [TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]: sessionId,
              [TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]: consentGeneration,
              [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
              [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'private-provider-session',
              THREADNOTE_DETACHED_SAFE_VALUE: 'preserved',
            },
            intendedChild: 'auto-update-worker',
          },
        ),
      );
      expect(spawned).toBe(true);
      const childEnvironment = await readCompleteEnvironmentReceipt(receiptPath);
      expect(childEnvironment).toEqual(
        expect.objectContaining({
          [TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]: sessionId,
          [TELEMETRY_CHILD_ENVIRONMENT_VARIABLE]: 'auto-update-worker',
          [TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]: consentGeneration,
          THREADNOTE_DETACHED_SAFE_VALUE: 'preserved',
        }),
      );
      expect(childEnvironment[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(childEnvironment[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]).toBeUndefined();
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });
});

async function readCompleteEnvironmentReceipt(path: string): Promise<Record<string, string>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipt = await readFile(path, 'utf8').catch(() => undefined);
    if (receipt !== undefined) {
      try {
        const parsed: unknown = JSON.parse(receipt);
        if (Schema.is(Schema.Record(Schema.String, Schema.String))(parsed)) {
          return parsed;
        }
      } catch {
        // A detached writer can create the file before its complete JSON payload is visible.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw TestError.make({message: 'Detached child did not publish a complete environment receipt.'});
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return !(typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ESRCH');
  }
}
