import {Array as EffectArray} from 'effect';
import {spawnSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Deferred, Effect, Fiber} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS,
  codeGraphGitWorktreeAdminNameKeys,
  observeCodeGraphGitWorktreeRegistry,
  type CodeGraphGitWorktreeRegistryObservation,
} from '@threadnote/graph/git/worktree/registration';
import {CommandExecutor} from '@threadnote/platform/command';
import {CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT} from '@threadnote/threadnote/worker_protocol';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const roots: string[] = [];
const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('code graph Git worktree registration worker', () => {
  it('observes a partial file registration through the hidden worker without following or leaking it', () => {
    const common = commonDirectoryFixture();
    const adminName = 'private-partial-registration';
    writeFileSync(join(common, 'worktrees', adminName), '/blocked/registered/worktree/.git\n');
    const request = {
      adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, adminName),
      checkoutId: CHECKOUT_ID,
      gitCommonDirectory: common,
      protocol: 1,
    };

    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, '../../src/standalone.ts'), CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT],
      {
        encoding: 'utf8',
        env: {...process.env, THREADNOTE_CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER: '1'},
        input: `${JSON.stringify(request)}\n`,
        timeout: 2_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({state: 'present'});
    expect(result.stdout).not.toContain(common);
    expect(result.stdout).not.toContain(adminName);
    expect(result.stderr).not.toContain(common);
    expect(result.stderr).not.toContain(adminName);
  });

  it('round-trips a present observation through the bounded parent command boundary', async () => {
    const common = commonDirectoryFixture();
    const adminName = 'bounded-parent-observation';
    writeFileSync(join(common, 'worktrees', adminName), 'partial');
    const result = await runEffect(
      observeCodeGraphGitWorktreeRegistry(
        {checkoutId: CHECKOUT_ID, gitCommonDirectory: common},
        {adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, adminName), kind: 'linked'},
      ),
    );

    expect(result).toMatchObject({entryCount: 1, state: 'present'});
    expect(JSON.stringify(result)).not.toContain(common);
    expect(JSON.stringify(result)).not.toContain(adminName);
  });

  it('keeps concurrent helper observations bounded and deterministic under registry load', async () => {
    const common = commonDirectoryFixture();
    const adminName = 'concurrent-target';
    for (let index = 0; index < 256; index += 1) {
      writeFileSync(join(common, 'worktrees', `registration-${index}`), '');
    }
    writeFileSync(join(common, 'worktrees', adminName), 'partial');
    const registration = {
      adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, adminName),
      kind: 'linked',
    } as const;

    const observations = await runEffect(
      Effect.all(
        Array.from({length: 8}, () =>
          observeCodeGraphGitWorktreeRegistry({checkoutId: CHECKOUT_ID, gitCommonDirectory: common}, registration),
        ),
        {concurrency: 'unbounded'},
      ),
    );

    expect(observations).toHaveLength(8);
    expect(EffectArray.every(observations, observation => observation.state === 'present')).toBe(true);
    expect(new Set(EffectArray.map(observations, observation => JSON.stringify(observation)))).toHaveLength(1);
  });

  it('rejects oversized worker input with one bounded path-free response', () => {
    const privateMarker = '/private/oversized/common-gitdir';
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, '../../src/standalone.ts'), CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT],
      {
        encoding: 'utf8',
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        input: `${privateMarker}${'x'.repeat(CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerInputBytes)}\n`,
        timeout: 2_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({reason: 'invalid', state: 'unknown'});
    expect(result.stdout).not.toContain(privateMarker);
  });

  it('returns path-free timeout and releases an interrupted worker execution', async () => {
    const common = commonDirectoryFixture();
    const registration = {
      adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, 'target'),
      kind: 'linked',
    } as const;
    let timeoutFinalized = false;
    const timeout = await runEffect(
      Effect.gen(function* () {
        const command = yield* CommandExecutor;
        const blocked = CommandExecutor.of({
          ...command,
          executeBytes: () =>
            Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  timeoutFinalized = true;
                }),
              ),
            ),
        });
        return yield* observeCodeGraphGitWorktreeRegistry(
          {checkoutId: CHECKOUT_ID, gitCommonDirectory: common},
          registration,
          {timeoutMilliseconds: 20},
        ).pipe(Effect.provideService(CommandExecutor, blocked));
      }),
    );

    let cancellationFinalized = false;
    await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const command = yield* CommandExecutor;
          const started = yield* Deferred.make<void>();
          const blocked = CommandExecutor.of({
            ...command,
            executeBytes: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    cancellationFinalized = true;
                  }),
                ),
              ),
          });
          const fiber = yield* observeCodeGraphGitWorktreeRegistry(
            {checkoutId: CHECKOUT_ID, gitCommonDirectory: common},
            registration,
            {timeoutMilliseconds: 10_000},
          ).pipe(Effect.provideService(CommandExecutor, blocked), Effect.forkScoped);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(fiber);
        }),
      ),
    );

    expect(timeout).toEqual({reason: 'timeout', state: 'unknown'});
    expect(timeoutFinalized).toBe(true);
    expect(cancellationFinalized).toBe(true);
    expect(JSON.stringify(timeout)).not.toContain(common);
  });

  it('keeps the common directory and raw admin name out of argv, response, and failures', async () => {
    const common = commonDirectoryFixture();
    const adminName = 'private-admin-name';
    const registration = {
      adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, adminName),
      kind: 'linked',
    } as const;
    let observedArguments: readonly string[] = [];
    let observedInput = '';
    const response: CodeGraphGitWorktreeRegistryObservation = {reason: 'unavailable', state: 'unknown'};

    const result = await runEffect(
      Effect.gen(function* () {
        const command = yield* CommandExecutor;
        const recording = CommandExecutor.of({
          ...command,
          executeBytes: (_executable, args, options) => {
            observedArguments = args;
            observedInput = new TextDecoder().decode(options?.input);
            return Effect.succeed({
              exitCode: 0,
              stderr: '',
              stdout: new TextEncoder().encode(`${JSON.stringify(response)}\n`),
            });
          },
        });
        return yield* observeCodeGraphGitWorktreeRegistry(
          {checkoutId: CHECKOUT_ID, gitCommonDirectory: common},
          registration,
        ).pipe(Effect.provideService(CommandExecutor, recording));
      }),
    );

    expect(EffectArray.join(observedArguments, ' ')).not.toContain(common);
    expect(EffectArray.join(observedArguments, ' ')).not.toContain(adminName);
    expect(observedInput).toContain(common);
    expect(observedInput).not.toContain(adminName);
    expect(JSON.stringify(result)).not.toContain(common);
    expect(JSON.stringify(result)).not.toContain(adminName);
  });
});

function commonDirectoryFixture(): string {
  const common = mkdtempSync(join(tmpdir(), 'threadnote-registration-worker-'));
  roots.push(common);
  mkdirSync(join(common, 'worktrees'));
  return common;
}
