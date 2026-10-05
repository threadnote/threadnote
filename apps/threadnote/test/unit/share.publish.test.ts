import {existsSync} from '@threadnote/testing/node-fs';
import {createHash} from '@threadnote/testing/node-crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Effect} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runSharePublish as runSharePublishEffect} from '@threadnote/threadnote/effect/share';
import {readMemoryWithRelocations} from '@threadnote/memory/relocation';
import type {CommandResult} from '@threadnote/platform/command';
import type {ShareRuntime} from '@threadnote/threadnote/types';
import * as utils from '@threadnote/threadnote/utils';
import {runEffect} from '../helpers/effect-runtime.js';

const runSharePublish = (...args: Parameters<typeof runSharePublishEffect>) =>
  runEffect(runSharePublishEffect(...args));

vi.mock('@threadnote/threadnote/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/utils')>();
  return {
    ...actual,
    maybeRun: vi.fn(),
    requiredExecutable: vi.fn().mockReturnValue(Effect.succeed('git')),
    runCommand: vi.fn(),
    sleep: vi.fn().mockReturnValue(Effect.void),
  };
});

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stdout, stderr: ''});
const fail = (stderr: string): CommandResult => ({exitCode: 1, stdout: '', stderr});

async function makeRuntime(): Promise<ShareRuntime> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-share-publish-'));
  const worktree = join(home, 'shared', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(join(home, 'share'), {recursive: true});
  await mkdir(worktree, {recursive: true});
  const sourcePath = join(
    home,
    'data',
    'local',
    'user',
    'test-user',
    'memories',
    'durable',
    'projects',
    'foo',
    'bar.md',
  );
  await mkdir(join(sourcePath, '..'), {recursive: true});
  await writeFile(
    sourcePath,
    'MEMORY\nkind: durable\nstatus: active\nproject: foo\ntopic: bar\nmemory_id: tn_share_publish\n\nBody\n',
  );
  await writeFile(
    join(home, 'share', 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: {
          default: {
            addedAt: '2026-06-05T00:00:00.000Z',
            gitdir,
            name: 'default',
            remote: 'git@example.com:team/memories.git',
            worktree,
          },
        },
        version: 1,
      },
      undefined,
      2,
    )}\n`,
  );
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    user: 'test-user',
  };
}

function mockPublishCommands(sourcePath: string, pushResult: CommandResult, sourcePresentAtPush: boolean[]): void {
  vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
    if (executable === 'git' && args.includes('rev-parse') && args.includes('--git-path')) {
      return Effect.succeed(
        ok(Array.from({length: 6}, (_, index) => `${sourcePath}.git-operation-${index}`).join('\n')),
      );
    }
    if (executable === 'git' && args.includes('add')) {
      return Effect.succeed(ok());
    }
    if (executable === 'git' && args.includes('diff') && args.includes('--cached')) {
      return Effect.succeed(ok('durable/projects/foo/bar.md\0'));
    }
    if (executable === 'git' && args.includes('commit')) {
      return Effect.succeed(ok('[main abc123] share'));
    }
    if (executable === 'git' && args.includes('push')) {
      return Effect.sync(() => {
        sourcePresentAtPush.push(existsSync(sourcePath));
        return pushResult;
      });
    }
    return Effect.succeed(ok());
  });
  vi.mocked(utils.maybeRun).mockImplementation((dryRun, executable, args, options) =>
    dryRun ? succeedUndefined : vi.mocked(utils.runCommand)(executable, args, options),
  );
}

describe('runSharePublish transaction ordering', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(utils.runCommand).mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('pushes the shared memory before removing the personal source', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourceUri = 'threadnote://user/test-user/memories/durable/projects/foo/bar.md';
    const sourcePath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    const targetPath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'shared',
      'default',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    const worktreeTargetPath = join(
      config.agentContextHome,
      'shared',
      'default',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    const sourcePresentAtPush: boolean[] = [];
    mockPublishCommands(sourcePath, ok('pushed'), sourcePresentAtPush);

    await runSharePublish(config, sourceUri, {});

    expect(sourcePresentAtPush).toEqual([true]);
    const gitCommands = vi.mocked(utils.runCommand).mock.calls.filter(([executable]) => executable === 'git');
    const commitIndex = gitCommands.findIndex(([, args]) => args.includes('commit'));
    const pushIndex = gitCommands.findIndex(([, args]) => args.includes('push'));
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(pushIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeLessThan(pushIndex);
    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(targetPath)).toBe(true);
    expect(existsSync(worktreeTargetPath)).toBe(true);
    expect(await readFile(targetPath, 'utf8')).toContain('visibility: shared');
    expect(await runEffect(readMemoryWithRelocations(config, sourceUri))).toMatchObject({
      canonicalUri: 'threadnote://user/test-user/memories/shared/default/durable/projects/foo/bar.md',
      requestedUri: sourceUri,
    });
  });

  it('keeps identity-alias relations and drops local projection URIs in the published copy', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourceUri = 'threadnote://user/test-user/memories/durable/projects/foo/bar.md';
    const sourcePath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    const targetPath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'shared',
      'default',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    const worktreeTargetPath = join(
      config.agentContextHome,
      'shared',
      'default',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    await writeFile(
      sourcePath,
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: foo',
        'topic: bar',
        'memory_id: tn_share_publish',
        'relation: related_to threadnote://memory/tn_e7d22dadd14756e7d665',
        'relation: related_to threadnote://user/test-user/memories/durable/projects/foo/private.md',
        'candidate_id: review-local-1',
        '',
        'Body',
        '',
      ].join('\n'),
    );
    mockPublishCommands(sourcePath, ok('pushed'), []);

    await runSharePublish(config, sourceUri, {});

    const published = await readFile(targetPath, 'utf8');
    expect(published).toContain('relation: related_to threadnote://memory/tn_e7d22dadd14756e7d665');
    expect(published).not.toContain('private.md');
    expect(published).not.toMatch(/^candidate_id:/m);
    expect(await readFile(worktreeTargetPath, 'utf8')).toBe(published);
  });

  it('requires an explicit uncited choice before publishing a pending-anchor memory', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourceUri = 'threadnote://user/test-user/memories/durable/projects/foo/bar.md';
    const sourcePath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    const pendingPath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'private',
      'deferred-code-anchors',
      'v1',
      `${createHash('sha256').update(sourceUri).digest('hex')}.json`,
    );
    await mkdir(join(pendingPath, '..'), {recursive: true, mode: 0o700});
    await writeFile(pendingPath, '{}\n', {mode: 0o600});
    mockPublishCommands(sourcePath, ok('pushed'), []);

    await expect(runSharePublish(config, sourceUri, {})).rejects.toThrow(/code citations are still pending/);
    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(pendingPath)).toBe(true);

    await runSharePublish(config, sourceUri, {allowUncitedPendingCodeRefs: true});
    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(pendingPath)).toBe(false);
  });

  it('resumes an equivalent canonical target left by an interrupted publish', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourceUri = 'threadnote://user/test-user/memories/durable/projects/foo/bar.md';
    const sourcePath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    const canonicalTargetPath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'shared',
      'default',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    await mkdir(join(canonicalTargetPath, '..'), {recursive: true});
    await writeFile(canonicalTargetPath, await readFile(sourcePath, 'utf8'));
    mockPublishCommands(sourcePath, ok('pushed'), []);

    await runSharePublish(config, sourceUri, {});

    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(join(config.agentContextHome, 'shared', 'default', 'durable', 'projects', 'foo', 'bar.md'))).toBe(
      true,
    );
  });

  it('refuses to overwrite a changed shared worktree target before writing canonical state', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourceUri = 'threadnote://user/test-user/memories/durable/projects/foo/bar.md';
    const sourcePath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    const canonicalTargetPath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'shared',
      'default',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    const worktreeTargetPath = join(
      config.agentContextHome,
      'shared',
      'default',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    await mkdir(join(worktreeTargetPath, '..'), {recursive: true});
    await writeFile(worktreeTargetPath, 'MEMORY\nkind: durable\nstatus: active\n\nNewer teammate content\n');
    mockPublishCommands(sourcePath, ok('pushed'), []);

    await expect(runSharePublish(config, sourceUri, {})).rejects.toThrow(/changed shared worktree file/);

    await expect(readFile(sourcePath, 'utf8')).resolves.toContain('Body');
    await expect(readFile(canonicalTargetPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(worktreeTargetPath, 'utf8')).resolves.toContain('Newer teammate content');
    expect(vi.mocked(utils.runCommand).mock.calls.some(([, args]) => args.includes('add'))).toBe(false);
  });

  it('does not remove the personal source when git push fails', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourceUri = 'threadnote://user/test-user/memories/durable/projects/foo/bar.md';
    const sourcePath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    mockPublishCommands(sourcePath, fail('permission denied'), []);

    await expect(runSharePublish(config, sourceUri, {})).rejects.toThrow(/git push failed/);

    expect(existsSync(sourcePath)).toBe(true);
  });

  it('still blocks a machine-local path on durable memory publish', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourceUri = 'threadnote://user/test-user/memories/durable/projects/foo/bar.md';
    const sourcePath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    await writeFile(
      sourcePath,
      'MEMORY\nkind: durable\nstatus: active\nproject: foo\ntopic: bar\nmemory_id: tn_share_publish\n\nSee /Users/jane/work/notes.md\n',
    );
    mockPublishCommands(sourcePath, ok('pushed'), []);

    await expect(runSharePublish(config, sourceUri, {})).rejects.toThrow(/macOS home path/);
  });
});
