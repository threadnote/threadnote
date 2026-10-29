import {mkdir, mkdtemp, writeFile} from './node-fs-promises.js';
import {tmpdir} from './node-os.js';
import {join} from './node-path.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface GitShareWorktreeFixture {
  readonly remote: string;
  readonly root: string;
  readonly worktree: string;
}

export async function createGitShareWorktreeFixture(
  prefix = 'threadnote-git-canonical-',
): Promise<GitShareWorktreeFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const worktree = join(root, 'composer');
  await mkdir(seed, {recursive: true});
  await git(['init', '--bare', remote]);
  await git(['init'], seed);
  await git(['checkout', '-b', 'main'], seed);
  await git(['config', 'user.email', 'threadnote-test@example.com'], seed);
  await git(['config', 'user.name', 'Threadnote Test'], seed);
  await git(['config', 'core.autocrlf', 'false'], seed);
  await writeFile(join(seed, 'README.md'), '# Shared memories\n', 'utf8');
  await git(['add', 'README.md'], seed);
  await git(['commit', '-m', 'initial'], seed);
  await git(['remote', 'add', 'origin', remote], seed);
  await git(['push', '-u', 'origin', 'main'], seed);
  await git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(['clone', '--branch', 'main', '--', remote, worktree]);
  await git(['config', 'user.email', 'threadnote-test@example.com'], worktree);
  await git(['config', 'user.name', 'Threadnote Test'], worktree);
  await git(['config', 'core.autocrlf', 'false'], worktree);
  return {remote, root, worktree};
}

export async function cloneGitShareWorktree(remote: string, directory: string): Promise<string> {
  await git(['clone', '--branch', 'main', '--', remote, directory]);
  await git(['config', 'user.email', 'threadnote-test@example.com'], directory);
  await git(['config', 'user.name', 'Threadnote Test'], directory);
  await git(['config', 'core.autocrlf', 'false'], directory);
  return directory;
}

export async function git(args: readonly string[], cwd?: string): Promise<string> {
  const child = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      Effect.pipe(stderr, EffectString.trim) ||
        Effect.pipe(stdout, EffectString.trim) ||
        `git ${args[0] ?? 'command'} failed`,
    );
  }
  return stdout;
}
