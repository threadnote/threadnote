import {TestError} from '@threadnote/testing/test-error';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdtempSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {basename, isAbsolute, join} from '@threadnote/testing/node-path';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {runCodeGraphCompact, runCodeGraphIndex} from '@threadnote/threadnote/code_graph/commands';
import {
  normalizeCredentialFreeRemote,
  normalizeRepositoryBranchName,
  repositoryIdentityMatchesExpectation,
  resolveRepositoryIdentity,
  resolveRepositoryIdentityDetail,
} from '@threadnote/graph/repository';
import {CommandExecutor} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph repository identity', () => {
  it('rejects branch labels containing bidirectional display controls', () => {
    expect(normalizeRepositoryBranchName('feature/safe')).toBe('feature/safe');
    expect(normalizeRepositoryBranchName('feature/\u202Etxt')).toBeUndefined();
    expect(normalizeRepositoryBranchName('\u2066spoof\u2069')).toBeUndefined();
  });

  it('strips credentials and non-identity URL fields from remotes', () => {
    expect(normalizeCredentialFreeRemote('git@github.com:Kashkovsky/threadnote.git')).toBe(
      'github.com/Kashkovsky/threadnote',
    );
    expect(
      normalizeCredentialFreeRemote('https://user:secret@github.com/Kashkovsky/threadnote.git?token=private#fragment'),
    ).toBe('github.com/Kashkovsky/threadnote');
    expect(normalizeCredentialFreeRemote('file:///private/repository')).toBeUndefined();
  });

  it('uses only the folder label for a local repository display name', async () => {
    const root = localRepository();
    const identity = await runEffect(resolveRepositoryIdentity(root));

    expect(identity.displayName).toBe(basename(root));
    expect(identity.remoteIdentity).toBeUndefined();
  });

  it('observes an unborn branch without preventing zero-commit identity fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-unborn-'));
    git(root, ['init', '-q', '-b', 'unborn-work']);

    const identity = await runEffect(resolveRepositoryIdentity(root));

    expect(identity.branch).toBe('unborn-work');
    expect(identity.headCommit).toBe(
      Effect2.pipe('0', EffectString.repeat(identity.objectFormat === 'sha256' ? 64 : 40)),
    );
  });

  it('shares one bounded directory command without serializing git-dir into public identity', async () => {
    const root = localRepository();
    const detail = await runEffect(resolveRepositoryIdentityDetail(root));

    expect(isAbsolute(detail.gitDirectory)).toBe(true);
    expect(detail.gitDirectory).toBe(detail.identity.gitCommonDirectory);
    expect(detail.identity).not.toHaveProperty('gitDirectory');

    const failure = await runEffect(
      Effect.gen(function* () {
        const command = yield* CommandExecutor;
        const executeBytes = command.executeBytes;
        if (executeBytes === undefined)
          return yield* TestError.make({message: 'binary command adapter is unavailable'});
        const malformed = CommandExecutor.of({
          ...command,
          executeBytes: (executable, args, options) =>
            executable === 'git' && args.includes('--git-common-dir')
              ? Effect.succeed({exitCode: 0, stderr: '', stdout: new TextEncoder().encode(`${root}/.git\n`)})
              : executeBytes(executable, args, options),
        });
        return yield* resolveRepositoryIdentityDetail(root).pipe(
          Effect.provideService(CommandExecutor, malformed),
          Effect.flip,
        );
      }),
    );

    expect(failure.message).toBe('Git repository directory metadata is invalid.');
    expect(JSON.stringify(failure)).not.toContain(root);
  });

  it('shares repository identity but isolates linked worktree identity', async () => {
    const root = localRepository();
    git(root, ['branch', 'linked']);
    const linked = join(mkdtempSync(join(tmpdir(), 'threadnote-code-graph-linked-')), 'worktree');
    git(root, ['worktree', 'add', linked, 'linked']);
    const [primary, worktree] = await runEffect(
      Effect.all([resolveRepositoryIdentity(root), resolveRepositoryIdentity(linked)], {
        concurrency: 2,
      }),
    );

    expect(worktree.repositoryId).toBe(primary.repositoryId);
    expect(worktree.checkoutId).toBe(primary.checkoutId);
    expect(worktree.branch).toBe('linked');
    expect(worktree.worktreeId).not.toBe(primary.worktreeId);
  });

  it('shares remote identity while assigning independent clones separate storage identities', async () => {
    const firstRoot = localRepository();
    const secondRoot = localRepository();
    for (const root of [firstRoot, secondRoot]) {
      git(root, ['remote', 'add', 'origin', 'https://github.com/example/shared.git']);
    }
    const [first, second] = await runEffect(
      Effect.all([resolveRepositoryIdentity(firstRoot), resolveRepositoryIdentity(secondRoot)], {
        concurrency: 2,
      }),
    );

    expect(first.repositoryId).toBe(second.repositoryId);
    expect(first.checkoutId).not.toBe(second.checkoutId);
  });

  it('requires every Manager graph identity component to match', () => {
    const expected = {
      checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
      repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
      worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
    };
    expect(repositoryIdentityMatchesExpectation(expected, expected)).toBe(true);
    for (const component of ['checkoutId', 'repositoryId', 'worktreeId'] as const) {
      expect(
        repositoryIdentityMatchesExpectation(
          {...expected, [component]: differentGraphId(expected[component])},
          expected,
        ),
        component,
      ).toBe(false);
    }
  });

  it('revalidates the complete expected identity in index and compact commands', async () => {
    const root = localRepository();
    const identity = await runEffect(resolveRepositoryIdentity(root));
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: join(root, '.threadnote-test-home'),
      agentId: 'threadnote',
      manifestPath: join(root, '.threadnote-test-home', 'manifest.yaml'),
      user: 'test',
    };
    for (const component of ['checkoutId', 'repositoryId', 'worktreeId'] as const) {
      const expectedIdentity = {...identity, [component]: differentGraphId(identity[component])};
      await expect(runEffect(runCodeGraphIndex(config, {cwd: root, expectedIdentity})), component).rejects.toThrow(
        'Repository identity does not match the requested graph target.',
      );
      await expect(
        runEffect(runCodeGraphCompact(config, {cwd: root, dryRun: true, expectedIdentity})),
        component,
      ).rejects.toThrow('Repository identity does not match the requested graph target.');
    }

    git(root, ['remote', 'add', 'origin', 'https://example.com/changed.git']);
    await expect(runEffect(runCodeGraphIndex(config, {cwd: root, expectedIdentity: identity}))).rejects.toThrow(
      'Repository identity does not match the requested graph target.',
    );
    await expect(
      runEffect(runCodeGraphCompact(config, {cwd: root, dryRun: true, expectedIdentity: identity})),
    ).rejects.toThrow('Repository identity does not match the requested graph target.');
  });
});

function localRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-identity-'));
  git(root, ['init', '-q']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

function differentGraphId(value: string): string {
  return `${Effect2.pipe(value, EffectString.startsWith('f')) ? 'e' : 'f'}${Effect2.pipe(value, EffectString.slice(1))}`;
}
