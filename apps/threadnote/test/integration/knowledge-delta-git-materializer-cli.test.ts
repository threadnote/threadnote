import {Array as EffectArray} from 'effect';
import assert from 'node:assert/strict';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {buildKnowledgeDeltaGitProposalV1} from '@threadnote/threadnote/git_proposal/knowledge_delta';
import {formatMemoryDocument} from '@threadnote/memory/document';
import type {KnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const execFilePromise = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(EffectArray.map(roots.splice(0), root => rm(root, {force: true, recursive: true})));
});

describe('Knowledge Delta Git proposal materializer CLI', () => {
  it('previews without writes and creates one exact hook-free branch commit idempotently', async () => {
    const fixture = await makeFixture();
    const proposal = proposalFor(fixture.baseCommit);
    const proposalPath = join(fixture.root, 'proposal.json');
    await writeFile(proposalPath, proposal.artifact, 'utf8');
    const hookSentinel = join(fixture.root, 'hook-ran');
    await writeHook(join(fixture.worktree, '.git', 'hooks', 'post-checkout'), hookSentinel);
    await writeHook(join(fixture.worktree, '.git', 'hooks', 'pre-commit'), hookSentinel);

    const before = await observeRepository(fixture.worktree);
    const preview = JSON.parse(
      (await runCli(['share', 'materialize', '--proposal', proposalPath], fixture.home)).stdout,
    );
    expect(preview).toMatchObject({
      branch: proposal.proposal.branch.name,
      files: EffectArray.map(proposal.proposal.files, file => file.path),
      outcome: 'preview',
      proposalHash: proposal.proposal.proposalHash,
    });
    expect(await observeRepository(fixture.worktree)).toEqual(before);

    const applied = JSON.parse(
      (await runCli(['share', 'materialize', '--proposal', proposalPath, '--apply'], fixture.home)).stdout,
    );
    expect(applied).toMatchObject({branch: proposal.proposal.branch.name, outcome: 'applied'});
    expect(await git(fixture.worktree, ['rev-parse', 'HEAD'])).toBe(`${fixture.baseCommit}\n`);
    expect(await git(fixture.worktree, ['symbolic-ref', '-q', 'HEAD'])).toBe(before.headRef);
    expect(await git(fixture.worktree, ['status', '--porcelain=v1'])).toBe('');
    expect(await git(fixture.worktree, ['show', `${applied.commit}:${proposal.proposal.files[0].path}`])).toBe(
      proposal.proposal.files[0].content,
    );
    expect(await git(fixture.worktree, ['rev-list', '--parents', '-n', '1', applied.commit])).toBe(
      `${applied.commit} ${fixture.baseCommit}\n`,
    );
    await expect(stat(hookSentinel)).rejects.toThrow();

    const retried = JSON.parse(
      (await runCli(['share', 'materialize', '--proposal', proposalPath, '--apply'], fixture.home)).stdout,
    );
    expect(retried).toEqual({...applied, outcome: 'reused'});

    await configureTeams(fixture.home, fixture.worktree, {
      alias: {access: 'read-write'},
      default: {access: 'read-write'},
    });
    const wrongTeam = await runCli(
      ['share', 'materialize', '--proposal', proposalPath, '--team', 'alias', '--apply'],
      fixture.home,
    ).catch(cliFailure);
    expect(wrongTeam).toMatchObject({code: 1});
    expect(wrongTeam.stderr).toContain('targets shared team "default"');

    await configureTeams(fixture.home, fixture.worktree, {default: {access: 'read-only'}});
    await expect(runCli(['share', 'materialize', '--proposal', proposalPath], fixture.home)).resolves.toBeDefined();
    const readOnly = await runCli(['share', 'materialize', '--proposal', proposalPath, '--apply'], fixture.home).catch(
      cliFailure,
    );
    expect(readOnly).toMatchObject({code: 1});
    expect(readOnly.stderr).toContain('is read-only');

    await configureTeams(fixture.home, fixture.worktree, {default: {access: 'read-write'}});
    const staleTarget = proposalFor(fixture.baseCommit, proposal.proposal.files[0].content);
    const staleTargetPath = join(fixture.root, 'stale-target-proposal.json');
    await writeFile(staleTargetPath, staleTarget.artifact, 'utf8');
    const stale = await runCli(['share', 'materialize', '--proposal', staleTargetPath], fixture.home).catch(cliFailure);
    expect(stale).toMatchObject({code: 1});
    expect(stale.stderr).toContain('Proposal target changed');

    await git(fixture.worktree, ['update-ref', `refs/heads/${proposal.proposal.branch.name}`, fixture.baseCommit]);
    const conflict = await runCli(['share', 'materialize', '--proposal', proposalPath, '--apply'], fixture.home).catch(
      cliFailure,
    );
    expect(conflict).toMatchObject({code: 1});
    expect(conflict.stderr).toContain('Existing materialization branch conflicts');
    expect(await git(fixture.worktree, ['rev-parse', 'HEAD'])).toBe(`${fixture.baseCommit}\n`);
    expect(await git(fixture.worktree, ['status', '--porcelain=v1'])).toBe('');
    await expect(stat(hookSentinel)).rejects.toThrow();
  }, 90_000);

  it.skipIf(process.platform === 'win32')('never follows a tracked parent symlink while applying', async () => {
    const fixture = await makeFixture({empty: true});
    const outside = join(fixture.root, 'outside');
    await mkdir(outside, {recursive: true});
    await symlink(outside, join(fixture.worktree, 'durable'));
    await git(fixture.worktree, ['add', 'durable']);
    await git(fixture.worktree, ['commit', '-m', 'seed symlink']);
    fixture.baseCommit = Effect.pipe(await git(fixture.worktree, ['rev-parse', 'HEAD']), EffectString.trim);
    const proposal = proposalFor(fixture.baseCommit);
    const proposalPath = join(fixture.root, 'proposal.json');
    await writeFile(proposalPath, proposal.artifact, 'utf8');
    const before = await observeRepository(fixture.worktree);

    const result = await runCli(['share', 'materialize', '--proposal', proposalPath, '--apply'], fixture.home).catch(
      cliFailure,
    );
    expect(result).toMatchObject({code: 1});
    await expect(stat(join(outside, 'projects', 'threadnote', 'architecture.md'))).rejects.toThrow();
    expect(await observeRepository(fixture.worktree)).toEqual(before);
  });

  it('creates a materialization branch in a SHA-256 repository', async () => {
    const fixture = await makeFixture({objectFormat: 'sha256'});
    const proposal = proposalFor(fixture.baseCommit);
    const proposalPath = join(fixture.root, 'proposal.json');
    await writeFile(proposalPath, proposal.artifact, 'utf8');

    const applied = JSON.parse(
      (await runCli(['share', 'materialize', '--proposal', proposalPath, '--apply'], fixture.home)).stdout,
    );

    expect(applied).toMatchObject({branch: proposal.proposal.branch.name, outcome: 'applied'});
    expect(String(applied.commit)).toHaveLength(64);

    const retried = JSON.parse(
      (await runCli(['share', 'materialize', '--proposal', proposalPath, '--apply'], fixture.home)).stdout,
    );
    expect(retried).toEqual({...applied, outcome: 'reused'});
  });
});

interface CliFailure extends Error {
  readonly code?: number;
  readonly stderr: string;
}

function isCliFailure(error: unknown): error is CliFailure {
  return (
    error instanceof Error &&
    'stderr' in error &&
    typeof error.stderr === 'string' &&
    (!('code' in error) || typeof error.code === 'number')
  );
}

function cliFailure(error: unknown): CliFailure {
  assert(isCliFailure(error), 'Expected a failed CLI result.');
  return error;
}

interface Fixture {
  baseCommit: string;
  readonly home: string;
  readonly root: string;
  readonly worktree: string;
}

async function makeFixture(
  options: {readonly empty?: boolean; readonly objectFormat?: 'sha1' | 'sha256'} = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-git-materializer-cli-'));
  roots.push(root);
  const home = join(root, 'home');
  const worktree = join(root, 'shared');
  await mkdir(worktree, {recursive: true});
  await git(worktree, ['init', `--object-format=${options.objectFormat ?? 'sha1'}`]);
  await git(worktree, ['config', 'user.email', 'test@example.com']);
  await git(worktree, ['config', 'user.name', 'Threadnote Test']);
  await git(worktree, ['remote', 'add', 'origin', 'https://example.com/threadnote/shared.git']);
  await writeFile(join(worktree, 'README.md'), '# Shared knowledge\n', 'utf8');
  await git(worktree, ['add', 'README.md']);
  await git(worktree, ['commit', '-m', options.empty === true ? 'seed repository' : 'seed shared repository']);
  const baseCommit = Effect.pipe(await git(worktree, ['rev-parse', 'HEAD']), EffectString.trim);
  await configureTeams(home, worktree, {default: {access: 'read-write'}});
  return {baseCommit, home, root, worktree};
}

function proposalFor(baseCommit: string, existingTarget?: string) {
  const reviewId = 'review-0123456789abcdef';
  const candidateId = `${reviewId}-1`;
  const content = formatMemoryDocument(
    'MEMORY',
    {
      authority: 'user_approved',
      candidateId,
      kind: 'durable',
      memoryId: 'tn_materialized_decision',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-17T00:00:00.000Z',
      topic: 'architecture',
      trust: 'approved',
      visibility: 'shared',
    },
    'Use the reviewed materializer contract.',
  );
  const delta: KnowledgeDeltaV1 = {
    items: [
      {
        candidateId,
        comparison: 'new',
        comparisonReason: 'test',
        confidence: 0.9,
        mutationPreview: {bodyText: 'Use the reviewed materializer contract.', operation: 'create', truncated: false},
        proposedDestination: {kind: 'durable', project: 'threadnote', topic: 'architecture'},
        recommendation: 'create',
        sourceEvidence: ['test'],
        state: 'applied',
        truncated: false,
        type: 'decision-or-invariant',
      },
    ],
    noAction: false,
    reviewId,
    revision: 1,
    type: 'knowledge-delta',
    version: 1,
  };
  return buildKnowledgeDeltaGitProposalV1({
    baseCommit,
    delta,
    mutations: [
      {
        approval: {expectedSourceContentHash: sha256HexSync(content), reviewId, revision: 1, share: true},
        candidateId,
        expectedTarget:
          existingTarget === undefined
            ? {state: 'absent'}
            : {content: existingTarget, contentHash: sha256HexSync(existingTarget), state: 'present'},
        operation: existingTarget === undefined ? 'create' : 'replace',
        sourceContent: content,
        sourceUri: 'threadnote://user/local/memories/durable/projects/threadnote/architecture.md',
      },
    ],
    project: 'threadnote',
    target: {
      repositoryId: sha256HexSync('repository-v1\nexample.com/threadnote/shared'),
      team: 'default',
    },
  });
}

async function configureTeams(
  home: string,
  worktree: string,
  teams: Readonly<Record<string, {readonly access: 'read-only' | 'read-write'}>>,
): Promise<void> {
  const share = join(home, 'share');
  await mkdir(share, {recursive: true});
  await writeFile(
    join(share, 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: EffectRecord.fromEntries(
          EffectArray.map(EffectRecord.toEntries(teams), ([name, team]) => [
            name,
            {
              access: team.access,
              addedAt: '2026-09-17T00:00:00.000Z',
              gitdir: join(worktree, '.git'),
              name,
              remote: 'local-test',
              worktree,
            },
          ]),
        ),
        version: 1,
      },
      undefined,
      2,
    )}\n`,
    'utf8',
  );
}

async function observeRepository(worktree: string) {
  const index = join(worktree, '.git', 'index');
  const status = await git(worktree, ['--no-optional-locks', 'status', '--porcelain=v1']);
  const indexInfo = await stat(index);
  return {
    head: await git(worktree, ['rev-parse', 'HEAD']),
    headRef: await git(worktree, ['symbolic-ref', '-q', 'HEAD']),
    index: Buffer.from(await readFile(index)).toString('base64'),
    indexModifiedMilliseconds: indexInfo.mtimeMs,
    refs: await git(worktree, ['for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads']),
    status,
  };
}

async function writeHook(path: string, sentinel: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\nprintf hook > "${sentinel}"\n`, {encoding: 'utf8', mode: 0o755});
}

function runCli(args: readonly string[], home: string) {
  return execFilePromise(
    process.execPath,
    [join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), ...args],
    {
      env: {...process.env, NO_COLOR: '1', THREADNOTE_HOME: home, THREADNOTE_USER: 'local'},
    },
  );
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFilePromise('git', ['-C', cwd, ...args])).stdout;
}
