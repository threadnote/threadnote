/* oxlint-disable effecttsgo/node-builtin-import -- This test exercises a shell and Git process boundary. */
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const script = new URL('../../../../deploy/threadnote-org-graph/sync-checkout.sh', import.meta.url).pathname;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-graph-sync-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const checkout = join(root, 'checkout');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);
  execFileSync('git', ['init', '--initial-branch=main', seed]);
  for (const directory of [seed]) {
    execFileSync('git', ['-C', directory, 'config', 'user.name', 'Test Publisher']);
    execFileSync('git', ['-C', directory, 'config', 'user.email', 'publisher@example.test']);
  }
  writeFileSync(join(seed, 'source.txt'), 'initial\n');
  execFileSync('git', ['-C', seed, 'add', '.']);
  execFileSync('git', ['-C', seed, 'commit', '-m', 'initial']);
  execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', remote]);
  execFileSync('git', ['-C', seed, 'push', '-u', 'origin', 'main']);
  execFileSync('git', ['clone', remote, checkout]);
  execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Test Publisher']);
  execFileSync('git', ['-C', checkout, 'config', 'user.email', 'publisher@example.test']);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', {mode: 0o755});
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    THREADNOTE_GRAPH_CHECKOUT: checkout,
    THREADNOTE_GRAPH_GIT_REMOTE_URL: remote,
    THREADNOTE_GRAPH_GIT_BRANCH: 'main',
  };
  const run = () => spawnSync('bash', [script, '--once'], {encoding: 'utf8', env: environment});
  const commit = (directory: string, content: string) => {
    writeFileSync(join(directory, 'source.txt'), content);
    execFileSync('git', ['-C', directory, 'add', '.']);
    execFileSync('git', ['-C', directory, 'commit', '-m', Effect.pipe(content, EffectString.trim)]);
  };
  const head = () =>
    Effect.pipe(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {encoding: 'utf8'}), EffectString.trim);
  return {checkout, commit, head, remote, run, seed};
}

describe('Fly graph publisher checkout sync', () => {
  it('follows a remote fast-forward without replacing the persistent checkout', () => {
    const {checkout, commit, head, run, seed} = fixture();
    const before = head();
    commit(seed, 'next\n');
    execFileSync('git', ['-C', seed, 'push', 'origin', 'main']);
    expect(run().status).toBe(0);
    expect(head()).not.toBe(before);
    expect(execFileSync('git', ['-C', checkout, 'status', '--porcelain'], {encoding: 'utf8'})).toBe('');
  });

  it('halts on divergent or dirty source rather than overwriting local state', () => {
    const {checkout, commit, head, run, seed} = fixture();
    commit(checkout, 'local\n');
    const local = head();
    commit(seed, 'remote\n');
    execFileSync('git', ['-C', seed, 'push', 'origin', 'main']);
    expect(run().status).toBe(1);
    expect(head()).toBe(local);
    writeFileSync(join(checkout, 'untracked.txt'), 'keep\n');
    expect(run().status).toBe(1);
    expect(head()).toBe(local);
  });

  it('treats a temporary source outage as retryable', () => {
    const {head, remote, run} = fixture();
    const before = head();
    rmSync(remote, {recursive: true});
    expect(run().status).toBe(75);
    expect(head()).toBe(before);
  });
});
