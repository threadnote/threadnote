import {Array as EffectArray} from 'effect';
import {mkdtemp, mkdir, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {basename, join} from '@threadnote/testing/node-path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resolveRepoName as resolveRepoNameEffect, runCommand as runCommandEffect} from '@threadnote/threadnote/utils';
import {runEffect} from '../helpers/effect-runtime.js';

const resolveRepoName = (...args: Parameters<typeof resolveRepoNameEffect>) =>
  runEffect(resolveRepoNameEffect(...args));
const runCommand = (...args: Parameters<typeof runCommandEffect>) => runEffect(runCommandEffect(...args));

const GIT_ENV_KEYS = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;

describe('resolveRepoName', () => {
  let workspace: string;
  let previousCallerCwd: string | undefined;
  let previousGitEnv: Map<string, string | undefined>;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'threadnote-reponame-'));
    previousCallerCwd = process.env.THREADNOTE_CALLER_CWD;
    previousGitEnv = new Map(EffectArray.map(GIT_ENV_KEYS, key => [key, process.env[key]]));
    delete process.env.THREADNOTE_CALLER_CWD;
    for (const key of GIT_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(async () => {
    if (previousCallerCwd === undefined) {
      delete process.env.THREADNOTE_CALLER_CWD;
    } else {
      process.env.THREADNOTE_CALLER_CWD = previousCallerCwd;
    }
    for (const key of GIT_ENV_KEYS) {
      const value = previousGitEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(workspace, {recursive: true, force: true});
  });

  it('resolves the repo name from the origin remote, not the clone dir', async () => {
    const repoRoot = join(workspace, 'easy-to-type');
    await mkdir(repoRoot);
    await runCommand('git', ['init'], {cwd: repoRoot});
    await runCommand('git', ['remote', 'add', 'origin', 'git@github.com:Kashkovsky/threadnote.git'], {cwd: repoRoot});

    await expect(resolveRepoName(repoRoot)).resolves.toBe('threadnote');
  });

  it('resolves the primary repo name from a linked worktree, not the worktree dir', async () => {
    const repoRoot = join(workspace, 'myrepo');
    await mkdir(repoRoot);
    await runCommand('git', ['init'], {cwd: repoRoot});
    await runCommand('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: repoRoot,
    });

    const worktree = join(workspace, 'myrepo-city');
    await runCommand('git', ['worktree', 'add', '-b', 'city', worktree], {cwd: repoRoot});

    // Naive basename(repoRoot) would mis-file the worktree under "myrepo-city".
    expect(basename(worktree)).toBe('myrepo-city');
    await expect(resolveRepoName(worktree)).resolves.toBe('myrepo');
    await expect(resolveRepoName(repoRoot)).resolves.toBe('myrepo');
  });

  it('returns undefined outside a git repository', async () => {
    await expect(resolveRepoName(workspace)).resolves.toBeUndefined();
  });
});
