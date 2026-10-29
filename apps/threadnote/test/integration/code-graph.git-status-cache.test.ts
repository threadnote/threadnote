import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import {CommandExecutor, CommandFailed, type CommandOptions} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {worktreeStatusWithPrivateCache} from '@threadnote/graph/git/status_cache';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const HASH = Effect2.pipe('a', EffectString.repeat(64));
const STATUS_ARGUMENTS = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'] as const;

describe('code graph private Git status cache', () => {
  it.effect('reuses and refreshes only the private index while preserving exact status output', () => {
    let root: string | undefined;
    return Effect.gen(function* () {
      root = mkdtempSync(join(tmpdir(), 'threadnote-git-status-cache-'));
      const repository = join(root, 'repository');
      const gitDirectory = join(repository, '.git');
      const sourceIndex = join(gitDirectory, 'index');
      const home = join(root, 'home');
      mkdirSync(gitDirectory, {recursive: true});
      mkdirSync(home, {recursive: true});
      let sourceIndexObjectIdByte = 7;
      let cacheExtensionBytes = 0;
      const writeSourceIndex = () =>
        writeFileSync(sourceIndex, testGitIndex(sourceIndexObjectIdByte, cacheExtensionBytes));
      writeSourceIndex();
      const identity = repositoryIdentity(repository);
      const base = yield* CommandExecutor;
      const calls: Array<{args: readonly string[]; options?: CommandOptions}> = [];
      const command = CommandExecutor.of({
        ...base,
        execute: (executable, args, options) => {
          expect(executable).toBe('git');
          calls.push({args, options});
          if (args.includes('rev-parse')) return Effect.succeed(result(`${sourceIndex}\n`));
          if (args.includes('update-index')) return Effect.succeed(result(''));
          if (args.includes('fsmonitor--daemon')) return Effect.succeed(result(''));
          if (args.includes('status')) return Effect.succeed(result(' M src/index.ts\0'));
          return Effect.fail(commandFailure(args));
        },
        executeBytes: (_executable, args) =>
          Effect.die(new Error(`Direct index semantics unexpectedly fell back to: ${EffectArray.join(args, ' ')}`)),
      });
      const observe = () =>
        worktreeStatusWithPrivateCache(identity, home, STATUS_ARGUMENTS, {minimumIndexBytes: 1}).pipe(
          Effect.provideService(CommandExecutor, command),
        );

      expect((yield* observe()).stdout).toBe(' M src/index.ts\0');
      expect(
        EffectArray.filter(
          calls,
          __effectArrayValue => !!(call => call.args.includes('update-index'))(__effectArrayValue),
        ),
      ).toHaveLength(2);
      expect(fsmonitorOperations(calls, 'status')).toHaveLength(1);
      expect(fsmonitorOperations(calls, 'start')).toHaveLength(0);
      assertPrivateStatusCall(calls.at(-1), home);

      expect((yield* observe()).stdout).toBe(' M src/index.ts\0');
      expect(
        EffectArray.filter(
          calls,
          __effectArrayValue => !!(call => call.args.includes('update-index'))(__effectArrayValue),
        ),
      ).toHaveLength(2);
      expect(fsmonitorOperations(calls, 'status')).toHaveLength(1);
      assertPrivateStatusCall(calls.at(-1), home);

      cacheExtensionBytes = 3;
      writeSourceIndex();
      expect((yield* observe()).stdout).toBe(' M src/index.ts\0');
      expect(
        EffectArray.filter(
          calls,
          __effectArrayValue => !!(call => call.args.includes('update-index'))(__effectArrayValue),
        ),
      ).toHaveLength(2);
      expect(fsmonitorOperations(calls, 'status')).toHaveLength(1);

      sourceIndexObjectIdByte = 8;
      cacheExtensionBytes = 5;
      writeSourceIndex();
      expect((yield* observe()).stdout).toBe(' M src/index.ts\0');
      expect(
        EffectArray.filter(
          calls,
          __effectArrayValue => !!(call => call.args.includes('update-index'))(__effectArrayValue),
        ),
      ).toHaveLength(4);
      expect(fsmonitorOperations(calls, 'status')).toHaveLength(2);
      expect(fsmonitorOperations(calls, 'start')).toHaveLength(0);
      expect(
        EffectArray.filter(calls, __effectArrayValue => !!(call => call.args.includes('ls-files'))(__effectArrayValue)),
      ).toHaveLength(0);
      assertPrivateStatusCall(calls.at(-1), home);
      expect(
        EffectArray.every(
          calls,
          call =>
            !call.args.includes('--no-optional-locks') ||
            call.args.includes('rev-parse') ||
            call.args.includes('ls-files'),
        ),
      ).toBe(true);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
      ),
      provideTestLayer(ApplicationLayer),
    );
  });

  it.effect('falls back to the read-only status command when private-index setup is unavailable', () => {
    let root: string | undefined;
    return Effect.gen(function* () {
      root = mkdtempSync(join(tmpdir(), 'threadnote-git-status-fallback-'));
      const repository = join(root, 'repository');
      const gitDirectory = join(repository, '.git');
      const sourceIndex = join(gitDirectory, 'index');
      const home = join(root, 'home');
      mkdirSync(gitDirectory, {recursive: true});
      mkdirSync(home, {recursive: true});
      writeFileSync(sourceIndex, 'source-index-v1');
      const calls: Array<{args: readonly string[]; options?: CommandOptions}> = [];
      const base = yield* CommandExecutor;
      const command = CommandExecutor.of({
        ...base,
        execute: (executable, args, options) => {
          expect(executable).toBe('git');
          calls.push({args, options});
          if (args.includes('rev-parse')) return Effect.succeed(result(`${sourceIndex}\n`));
          if (args.includes('update-index')) return Effect.fail(commandFailure(args));
          if (args.includes('status')) return Effect.succeed(result('?? src/new.ts\0'));
          return Effect.fail(commandFailure(args));
        },
      });

      const observed = yield* worktreeStatusWithPrivateCache(repositoryIdentity(repository), home, STATUS_ARGUMENTS, {
        minimumIndexBytes: 1,
      }).pipe(Effect.provideService(CommandExecutor, command));

      expect(observed.stdout).toBe('?? src/new.ts\0');
      const fallback = calls.at(-1);
      expect(fallback?.args.slice(0, 3)).toEqual(['--no-optional-locks', '-C', repository]);
      expect(fallback?.options?.trustedGitIndexFile).toBeUndefined();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
      ),
      provideTestLayer(ApplicationLayer),
    );
  });

  it.effect('accepts a concurrent fsmonitor start after verifying the final daemon state', () => {
    let root: string | undefined;
    return Effect.gen(function* () {
      root = mkdtempSync(join(tmpdir(), 'threadnote-git-status-fsmonitor-race-'));
      const repository = join(root, 'repository');
      const gitDirectory = join(repository, '.git');
      const sourceIndex = join(gitDirectory, 'index');
      const home = join(root, 'home');
      mkdirSync(gitDirectory, {recursive: true});
      mkdirSync(home, {recursive: true});
      writeFileSync(sourceIndex, 'source-index-v1');
      const calls: Array<{args: readonly string[]; options?: CommandOptions}> = [];
      let fsmonitorStatusCalls = 0;
      const base = yield* CommandExecutor;
      const command = CommandExecutor.of({
        ...base,
        execute: (executable, args, options) => {
          expect(executable).toBe('git');
          calls.push({args, options});
          if (args.includes('rev-parse')) return Effect.succeed(result(`${sourceIndex}\n`));
          if (args.includes('update-index')) return Effect.succeed(result(''));
          if (args.includes('fsmonitor--daemon') && args.includes('status')) {
            fsmonitorStatusCalls += 1;
            return Effect.succeed(result('', fsmonitorStatusCalls === 1 ? 1 : 0));
          }
          if (args.includes('fsmonitor--daemon') && args.includes('start')) {
            return Effect.succeed(result('', 128));
          }
          if (args.includes('status')) return Effect.succeed(result(' M src/index.ts\0'));
          return Effect.fail(commandFailure(args));
        },
      });
      const observe = () =>
        worktreeStatusWithPrivateCache(repositoryIdentity(repository), home, STATUS_ARGUMENTS, {
          minimumIndexBytes: 1,
        }).pipe(Effect.provideService(CommandExecutor, command));

      expect((yield* observe()).stdout).toBe(' M src/index.ts\0');
      expect(fsmonitorOperations(calls, 'status')).toHaveLength(2);
      expect(fsmonitorOperations(calls, 'start')).toHaveLength(1);
      expect(
        EffectArray.filter(
          calls,
          __effectArrayValue =>
            !!(call => call.args.includes('--no-optional-locks') && call.args.includes('status'))(__effectArrayValue),
        ),
      ).toEqual([]);

      expect((yield* observe()).stdout).toBe(' M src/index.ts\0');
      expect(fsmonitorOperations(calls, 'status')).toHaveLength(2);
      expect(fsmonitorOperations(calls, 'start')).toHaveLength(1);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
      ),
      provideTestLayer(ApplicationLayer),
    );
  });

  it.effect('falls back when fsmonitor remains unavailable after the start attempt', () => {
    let root: string | undefined;
    return Effect.gen(function* () {
      root = mkdtempSync(join(tmpdir(), 'threadnote-git-status-fsmonitor-unavailable-'));
      const repository = join(root, 'repository');
      const gitDirectory = join(repository, '.git');
      const sourceIndex = join(gitDirectory, 'index');
      const home = join(root, 'home');
      mkdirSync(gitDirectory, {recursive: true});
      mkdirSync(home, {recursive: true});
      writeFileSync(sourceIndex, 'source-index-v1');
      const calls: Array<{args: readonly string[]; options?: CommandOptions}> = [];
      const base = yield* CommandExecutor;
      const command = CommandExecutor.of({
        ...base,
        execute: (executable, args, options) => {
          expect(executable).toBe('git');
          calls.push({args, options});
          if (args.includes('rev-parse')) return Effect.succeed(result(`${sourceIndex}\n`));
          if (args.includes('update-index')) return Effect.succeed(result(''));
          if (args.includes('fsmonitor--daemon')) return Effect.succeed(result('', 1));
          if (args.includes('status')) return Effect.succeed(result('?? src/new.ts\0'));
          return Effect.fail(commandFailure(args));
        },
      });

      const observed = yield* worktreeStatusWithPrivateCache(repositoryIdentity(repository), home, STATUS_ARGUMENTS, {
        minimumIndexBytes: 1,
      }).pipe(Effect.provideService(CommandExecutor, command));

      expect(observed.stdout).toBe('?? src/new.ts\0');
      expect(fsmonitorOperations(calls, 'status')).toHaveLength(2);
      expect(fsmonitorOperations(calls, 'start')).toHaveLength(1);
      const fallback = calls.at(-1);
      expect(fallback?.args.slice(0, 3)).toEqual(['--no-optional-locks', '-C', repository]);
      expect(fallback?.options?.trustedGitIndexFile).toBeUndefined();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
      ),
      provideTestLayer(ApplicationLayer),
    );
  });
});

function fsmonitorOperations(calls: ReadonlyArray<{readonly args: readonly string[]}>, operation: 'start' | 'status') {
  return EffectArray.filter(
    calls,
    __effectArrayValue =>
      !!(call => call.args.includes('fsmonitor--daemon') && call.args.includes(operation))(__effectArrayValue),
  );
}

function assertPrivateStatusCall(
  call: {args: readonly string[]; options?: CommandOptions} | undefined,
  home: string,
): void {
  expect(call?.args).toContain('status');
  expect(call?.args).toContain('core.fsmonitor=true');
  expect(call?.args).toContain('core.untrackedCache=true');
  expect(
    Effect2.pipe(call?.options?.trustedGitIndexFile, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.startsWith(home)),
    ),
  ).toBe(true);
}

function repositoryIdentity(repoRoot: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: HASH,
    displayName: 'fixture',
    gitCommonDirectory: join(repoRoot, '.git'),
    headCommit: Effect2.pipe('b', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot,
    repositoryId: HASH,
    worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
  };
}

function result(stdout: string, exitCode = 0) {
  return {exitCode, stderr: '', stdout};
}

function commandFailure(args: readonly string[]) {
  return CommandFailed.make({
    args,
    executable: 'git',
    exitCode: 1,
    message: 'unsupported private index',
    stderr: 'unsupported private index',
    stdout: '',
  });
}

function testGitIndex(objectIdByte: number, cacheExtensionBytes: number): Uint8Array {
  const path = new TextEncoder().encode('src/index.ts');
  const unpaddedEntryBytes = 40 + 20 + 2 + path.byteLength + 1;
  const entryBytes = Math.ceil(unpaddedEntryBytes / 8) * 8;
  const extensionBytes = cacheExtensionBytes === 0 ? 0 : 8 + cacheExtensionBytes;
  const contentBytes = 12 + entryBytes + extensionBytes;
  const index = new Uint8Array(contentBytes + 20);
  index.set(new TextEncoder().encode('DIRC'));
  const view = new DataView(index.buffer);
  view.setUint32(4, 2, false);
  view.setUint32(8, 1, false);
  view.setUint32(12 + 24, 0o100644, false);
  index.fill(objectIdByte, 12 + 40, 12 + 60);
  view.setUint16(12 + 60, path.byteLength, false);
  index.set(path, 12 + 62);
  if (cacheExtensionBytes > 0) {
    const extensionOffset = 12 + entryBytes;
    index.set(new TextEncoder().encode('TREE'), extensionOffset);
    view.setUint32(extensionOffset + 4, cacheExtensionBytes, false);
    index.fill(0x41, extensionOffset + 8, extensionOffset + 8 + cacheExtensionBytes);
  }
  index.set(new Bun.CryptoHasher('sha1').update(index.subarray(0, contentBytes)).digest(), contentBytes);
  return index;
}
