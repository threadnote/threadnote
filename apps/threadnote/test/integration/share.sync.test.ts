import {TestError} from '@threadnote/testing/test-error';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import fc from 'fast-check';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {
  clearAutoShareStateForTest,
  listShareConflicts,
  reconcileMissingSharedMemoryIdentity,
  refreshSharedReposInBackground,
  showShareConflict,
} from '@threadnote/threadnote/share/index';
import {isRestoredSharedMemoryIdentityHistory} from '@threadnote/threadnote/share/sync';
import {formatShareConflictNextSteps} from '@threadnote/threadnote/share/conflicts';
import {runShareConflictsTool, runShareConflictShowTool} from '@threadnote/threadnote/mcp/server/share';
import {
  resolveShareConflict as resolveShareConflictEffect,
  runShareInit as runShareInitEffect,
  runSharePublish as runSharePublishEffect,
  runShareSync as runShareSyncEffect,
  syncSharedReposBeforeAgentRead as syncSharedReposBeforeAgentReadEffect,
} from '@threadnote/threadnote/effect/share';
import {runForget as runForgetEffect} from '@threadnote/threadnote/memory/commands';
import type {ShareRuntime, ShareTeamsFile} from '@threadnote/threadnote/types';
import {runCommand} from '@threadnote/threadnote/utils';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runEffect} from '../helpers/effect-runtime.js';

const runShareInit = (...args: Parameters<typeof runShareInitEffect>) => runEffect(runShareInitEffect(...args));
const runSharePublish = (...args: Parameters<typeof runSharePublishEffect>) =>
  runEffect(runSharePublishEffect(...args));
const runForget = (...args: Parameters<typeof runForgetEffect>) => runEffect(runForgetEffect(...args));
const runShareSync = (...args: Parameters<typeof runShareSyncEffect>) => runEffect(runShareSyncEffect(...args));
const syncSharedReposBeforeAgentRead = (...args: Parameters<typeof syncSharedReposBeforeAgentReadEffect>) =>
  runEffect(syncSharedReposBeforeAgentReadEffect(...args));
const refreshSharedRepos = (...args: Parameters<typeof refreshSharedReposInBackground>) =>
  runEffect(refreshSharedReposInBackground(...args));
const resolveShareConflict = (...args: Parameters<typeof resolveShareConflictEffect>) =>
  runEffect(resolveShareConflictEffect(...args));

interface TestShareRepo {
  readonly config: RuntimeConfig;
  readonly home: string;
  readonly remote: string;
  readonly root: string;
  readonly seed: string;
  readonly worktree: string;
}

interface TestShareTeam {
  readonly gitdir: string;
  readonly name: string;
  readonly remote: string;
  readonly seed: string;
  readonly worktree: string;
}

const homes: string[] = [];
const GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
] as const;
const savedGitEnv = new Map<string, string | undefined>();

async function git(args: readonly string[], cwd?: string): Promise<void> {
  await runEffect(runCommand('git', args, {cwd}));
}

async function gitOutput(args: readonly string[], cwd?: string): Promise<string> {
  const result = await runEffect(runCommand('git', args, {cwd}));
  return result.stdout.trim();
}

function canonicalResourceFile(home: string, uri: string): string {
  return join(home, 'data', 'local', ...uri.slice('threadnote://'.length).split('/'));
}

async function writeCanonicalResource(home: string, uri: string, content: string, _encoding = 'utf8'): Promise<void> {
  const file = canonicalResourceFile(home, uri);
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, content, 'utf8');
}

async function nativeStoreFixture(root: string): Promise<{readonly store: string}> {
  const store = join(root, 'home');
  await mkdir(store, {recursive: true});
  return {store};
}

interface DroppedIdentityFixture extends TestShareRepo {
  readonly droppedIdentity: string;
  readonly id: string;
  readonly original: string;
  readonly relativePath: string;
  readonly store: string;
  readonly uri: string;
}

async function makeDroppedIdentityFixture(
  topic: string,
  afterInitialSync?: (fixture: DroppedIdentityFixture) => Promise<void>,
): Promise<DroppedIdentityFixture> {
  const repo = await makeShareRepo();
  const {store} = await nativeStoreFixture(repo.root);
  const relativePath = `durable/projects/threadnote/${topic}.md`;
  const id = `default:${relativePath}`;
  const uri = `threadnote://user/denys/memories/shared/default/${relativePath}`;
  const memoryId = `tn_${topic.replaceAll('-', '_')}`;
  const original = `MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: ${topic}\nmemory_id: ${memoryId}\n\nOriginal body.`;
  const droppedIdentity = original.replace(`memory_id: ${memoryId}\n`, '').replace('Original body.', 'Remote body.');
  await mkdir(dirname(join(repo.seed, relativePath)), {recursive: true});
  await writeFile(join(repo.seed, relativePath), `${original}\n`, 'utf8');
  await git(['add', relativePath], repo.seed);
  await git(['commit', '-m', `add ${topic}`], repo.seed);
  await git(['push', 'origin', 'main'], repo.seed);
  await runShareSync(repo.config, {push: false});
  const fixture = {...repo, droppedIdentity, id, original, relativePath, store, uri};
  await afterInitialSync?.(fixture);
  await writeFile(join(repo.seed, relativePath), `${droppedIdentity}\n`, 'utf8');
  await git(['add', relativePath], repo.seed);
  await git(['commit', '-m', `drop ${topic} identity`], repo.seed);
  await git(['push', 'origin', 'main'], repo.seed);
  await runShareSync(repo.config, {push: false});
  return fixture;
}

async function makeShareRepo(): Promise<TestShareRepo> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-share-sync-'));
  homes.push(root);

  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  await mkdir(seed, {recursive: true});
  await git(['init', '--bare', remote]);
  await git(['init'], seed);
  await git(['checkout', '-b', 'main'], seed);
  await git(['config', 'user.email', 'threadnote-test@example.com'], seed);
  await git(['config', 'user.name', 'Threadnote Test'], seed);
  await writeFile(join(seed, 'README.md'), '# Shared memories\n', 'utf8');
  await git(['add', 'README.md'], seed);
  await git(['commit', '-m', 'initial'], seed);
  await git(['remote', 'add', 'origin', remote], seed);
  await git(['push', '-u', 'origin', 'main'], seed);
  await git(['checkout', '-b', 'other'], seed);
  await writeFile(join(seed, 'other.md'), 'other branch\n', 'utf8');
  await git(['add', 'other.md'], seed);
  await git(['commit', '-m', 'other branch'], seed);
  await git(['push', 'origin', 'other'], seed);
  await git(['checkout', 'main'], seed);
  await git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  const home = join(root, 'home');
  const worktree = join(home, 'share', 'worktrees', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(dirname(worktree), {recursive: true});
  await mkdir(dirname(gitdir), {recursive: true});
  await git(['clone', `--separate-git-dir=${gitdir}`, '--branch', 'main', '--', remote, worktree]);
  await git(['config', 'user.email', 'threadnote-test@example.com'], worktree);
  await git(['config', 'user.name', 'Threadnote Test'], worktree);

  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: join(home, 'seed-manifest.yaml'),
    user: 'denys',
  };
  const teams: ShareTeamsFile = {
    defaultTeam: 'default',
    teams: {
      default: {
        addedAt: new Date(0).toISOString(),
        gitdir,
        name: 'default',
        remote,
        worktree,
      },
    },
    version: 1,
  };
  await mkdir(join(home, 'share'), {recursive: true});
  await writeFile(join(home, 'share', 'teams.json'), `${JSON.stringify(teams, undefined, 2)}\n`, 'utf8');
  return {config, home, remote, root, seed, worktree};
}

async function addShareTeam(repo: TestShareRepo, name: string): Promise<TestShareTeam> {
  const teamRoot = join(repo.root, `team-${name}`);
  const remote = join(teamRoot, 'remote.git');
  const seed = join(teamRoot, 'seed');
  await mkdir(seed, {recursive: true});
  await git(['init', '--bare', remote]);
  await git(['init'], seed);
  await git(['checkout', '-b', 'main'], seed);
  await git(['config', 'user.email', 'threadnote-test@example.com'], seed);
  await git(['config', 'user.name', 'Threadnote Test'], seed);
  await writeFile(join(seed, 'README.md'), '# Shared memories\n', 'utf8');
  await git(['add', 'README.md'], seed);
  await git(['commit', '-m', 'initial'], seed);
  await git(['remote', 'add', 'origin', remote], seed);
  await git(['push', '-u', 'origin', 'main'], seed);
  await git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  const worktree = join(repo.home, 'share', 'worktrees', name);
  const gitdir = join(repo.home, 'share', 'teams', `${name}.gitdir`);
  await mkdir(dirname(worktree), {recursive: true});
  await mkdir(dirname(gitdir), {recursive: true});
  await git(['clone', `--separate-git-dir=${gitdir}`, '--branch', 'main', '--', remote, worktree]);
  await git(['config', 'user.email', 'threadnote-test@example.com'], worktree);
  await git(['config', 'user.name', 'Threadnote Test'], worktree);

  const teamsPath = join(repo.home, 'share', 'teams.json');
  const existingTeams = JSON.parse(await readFile(teamsPath, 'utf8')) as ShareTeamsFile;
  const teams: ShareTeamsFile = {
    ...existingTeams,
    teams: {
      ...existingTeams.teams,
      [name]: {
        addedAt: new Date(0).toISOString(),
        gitdir,
        name,
        remote,
        worktree,
      },
    },
  };
  await writeFile(teamsPath, `${JSON.stringify(teams, undefined, 2)}\n`, 'utf8');
  return {gitdir, name, remote, seed, worktree};
}

async function makeSeededRemote(root: string): Promise<string> {
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  await mkdir(seed, {recursive: true});
  await git(['init', '--bare', remote]);
  await git(['init'], seed);
  await git(['checkout', '-b', 'main'], seed);
  await git(['config', 'user.email', 'threadnote-test@example.com'], seed);
  await git(['config', 'user.name', 'Threadnote Test'], seed);
  await writeFile(join(seed, 'README.md'), '# Shared memories\n', 'utf8');
  await git(['add', 'README.md'], seed);
  await git(['commit', '-m', 'initial'], seed);
  await git(['remote', 'add', 'origin', remote], seed);
  await git(['push', '-u', 'origin', 'main'], seed);
  await git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return remote;
}

async function makeIdentityRestorationFixture(topic: string) {
  const repo = await makeShareRepo();
  const {store} = await nativeStoreFixture(repo.root);
  const relativePath = `durable/projects/threadnote/${topic}.md`;
  const uri = `threadnote://user/denys/memories/shared/default/${relativePath}`;
  const established = `MEMORY\nkind: durable\nstatus: active\nvisibility: shared\nproject: threadnote\ntopic: ${topic}\nmemory_id: tn_established_identity\n\nOriginal reviewed body.\n`;
  const transient = `MEMORY\nkind: durable\nstatus: active\nvisibility: shared\nproject: threadnote\ntopic: ${topic}\nmemory_id: tn_transient_republish\n\nReplacement body.\n`;
  const restored = established.replace('Original reviewed body.', 'Corrected replacement body.');
  await mkdir(dirname(join(repo.seed, relativePath)), {recursive: true});
  await writeFile(join(repo.seed, relativePath), established, 'utf8');
  await git(['add', relativePath], repo.seed);
  await git(['commit', '-m', 'publish established identity'], repo.seed);
  await git(['push', 'origin', 'main'], repo.seed);
  await runShareSync(repo.config, {push: false});
  await writeFile(join(repo.seed, relativePath), transient, 'utf8');
  await git(['add', relativePath], repo.seed);
  await git(['commit', '-m', 'republish with transient identity'], repo.seed);
  await git(['push', 'origin', 'main'], repo.seed);
  await git(['fetch', 'origin'], repo.worktree);
  await git(['rebase', 'origin/main'], repo.worktree);
  await writeCanonicalResource(store, uri, transient);
  return {...repo, established, relativePath, restored, store, transient, uri};
}

describe('share sync git handling', () => {
  beforeEach(() => {
    savedGitEnv.clear();
    for (const key of GIT_ENV_KEYS) {
      savedGitEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(async () => {
    clearAutoShareStateForTest();
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
    for (const key of GIT_ENV_KEYS) {
      const value = savedGitEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedGitEnv.clear();
  });

  it('auto-commits root Claude guidance and rebases onto the configured upstream', async () => {
    const {config, worktree} = await makeShareRepo();
    await writeFile(join(worktree, 'CLAUDE.md'), '# Shared Claude guidance\n', 'utf8');

    await runShareSync(config, {message: 'share: test sync', push: false});

    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe('');
    await expect(gitOutput(['ls-files', 'CLAUDE.md'], worktree)).resolves.toBe('CLAUDE.md');
    await expect(gitOutput(['log', '-1', '--format=%s', '--', 'CLAUDE.md'], worktree)).resolves.toBe(
      'share: test sync',
    );
  });

  it('publishes a canonical personal memory into the separate worktree and remote', async () => {
    const {config, home, remote, worktree} = await makeShareRepo();
    const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/publish-e2e.md';
    const targetUri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/publish-e2e.md';
    const content =
      'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: publish-e2e\n\nSeparate worktree publish.\n';
    await writeCanonicalResource(home, sourceUri, content);

    await runSharePublish(config, sourceUri, {team: 'default'});

    await expect(readFile(canonicalResourceFile(home, sourceUri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(canonicalResourceFile(home, targetUri), 'utf8')).resolves.toContain(
      'Separate worktree publish.',
    );
    await expect(
      readFile(join(worktree, 'durable', 'projects', 'threadnote', 'publish-e2e.md'), 'utf8'),
    ).resolves.toContain('Separate worktree publish.');
    await expect(
      gitOutput(['--git-dir', remote, 'show', 'main:durable/projects/threadnote/publish-e2e.md']),
    ).resolves.toContain('Separate worktree publish.');
  });

  it('preserves a dirty tracked destination and both canonical stores when publish conflicts', async () => {
    const {config, home, worktree} = await makeShareRepo();
    const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/publish-conflict.md';
    const targetUri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/publish-conflict.md';
    const relativePath = 'durable/projects/threadnote/publish-conflict.md';
    const sourceContent =
      'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: publish-conflict\n\nPersonal source.\n';
    const trackedContent =
      'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: publish-conflict\n\nTracked baseline.\n';
    const dirtyContent =
      'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: publish-conflict\n\nDirty teammate edit.\n';
    await writeCanonicalResource(home, sourceUri, sourceContent);
    await mkdir(dirname(join(worktree, relativePath)), {recursive: true});
    await writeFile(join(worktree, relativePath), trackedContent, 'utf8');
    await git(['add', relativePath], worktree);
    await git(['commit', '-m', 'add tracked conflict target'], worktree);
    await writeFile(join(worktree, relativePath), dirtyContent, 'utf8');
    const statusBefore = await gitOutput(['status', '--porcelain'], worktree);

    await expect(runSharePublish(config, sourceUri, {push: false, team: 'default'})).rejects.toThrow(
      /changed shared worktree file/,
    );

    await expect(readFile(canonicalResourceFile(home, sourceUri), 'utf8')).resolves.toBe(sourceContent);
    await expect(readFile(canonicalResourceFile(home, targetUri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(dirtyContent);
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe(statusBefore);
  });

  it('replaces a forgotten shared memory when its remaining tracked file is clean', async () => {
    const {config, home, worktree} = await makeShareRepo();
    const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/replacement-cycle.md';
    const targetUri =
      'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/replacement-cycle.md';
    const relativePath = 'durable/projects/threadnote/replacement-cycle.md';
    const previousContent =
      'MEMORY\nkind: durable\nstatus: active\nvisibility: shared\nproject: threadnote\ntopic: replacement-cycle\nmemory_id: tn_replacement_cycle\n\nPrevious reviewed body.\n';
    const replacementContent =
      'MEMORY\nkind: durable\nstatus: active\nvisibility: personal\nproject: threadnote\ntopic: replacement-cycle\nmemory_id: tn_replacement_cycle\n\nReplacement reviewed body.\n';
    await writeCanonicalResource(home, sourceUri, replacementContent);
    await writeCanonicalResource(home, targetUri, previousContent);
    await mkdir(dirname(join(worktree, relativePath)), {recursive: true});
    await writeFile(join(worktree, relativePath), previousContent, 'utf8');
    await git(['add', relativePath], worktree);
    await git(['commit', '-m', 'add previous shared memory'], worktree);

    await expect(runSharePublish(config, sourceUri, {push: false, team: 'default'})).rejects.toThrow(
      /already exists with different content/,
    );
    await runForget(config, targetUri, {dryRun: true});
    await expect(readFile(canonicalResourceFile(home, targetUri), 'utf8')).resolves.toBe(previousContent);
    await runForget(config, targetUri, {});
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe('');
    await writeFile(join(worktree, 'unrelated.md'), 'Unrelated staged work.\n', 'utf8');
    await git(['add', 'unrelated.md'], worktree);

    await runSharePublish(config, sourceUri, {push: false, team: 'default'});

    await expect(readFile(canonicalResourceFile(home, sourceUri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    const published = await readFile(canonicalResourceFile(home, targetUri), 'utf8');
    expect(published).toContain('Replacement reviewed body.');
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(published);
    await expect(gitOutput(['diff', '--cached', '--name-only'], worktree)).resolves.toBe('unrelated.md');
    await expect(gitOutput(['ls-tree', '--name-only', 'HEAD', 'unrelated.md'], worktree)).resolves.toBe('');
  });

  it('rejects republishing a forgotten shared path with a different stable identity', async () => {
    const {config, home, worktree} = await makeShareRepo();
    const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/replacement-identity.md';
    const targetUri =
      'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/replacement-identity.md';
    const relativePath = 'durable/projects/threadnote/replacement-identity.md';
    const previousContent =
      'MEMORY\nkind: durable\nstatus: active\nvisibility: shared\nproject: threadnote\ntopic: replacement-identity\nmemory_id: tn_established_shared\n\nPrevious reviewed body.\n';
    const replacementContent =
      'MEMORY\nkind: durable\nstatus: active\nvisibility: personal\nproject: threadnote\ntopic: replacement-identity\nmemory_id: tn_new_personal\n\nReplacement reviewed body.\n';
    await writeCanonicalResource(home, sourceUri, replacementContent);
    await writeCanonicalResource(home, targetUri, previousContent);
    await mkdir(dirname(join(worktree, relativePath)), {recursive: true});
    await writeFile(join(worktree, relativePath), previousContent, 'utf8');
    await git(['add', relativePath], worktree);
    await git(['commit', '-m', 'add established shared identity'], worktree);
    await runForget(config, targetUri, {});

    await expect(runSharePublish(config, sourceUri, {push: false, team: 'default'})).rejects.toThrow(
      /cannot drop or change stable memory_id tn_established_shared/,
    );

    await expect(readFile(canonicalResourceFile(home, sourceUri), 'utf8')).resolves.toBe(replacementContent);
    await expect(readFile(canonicalResourceFile(home, targetUri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(previousContent);
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe('');
  });

  it.each(['staged', 'unstaged'] as const)('preserves a %s deletion of a forgotten tracked target', async deletion => {
    const {config, home, worktree} = await makeShareRepo();
    const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/deleted-replacement.md';
    const targetUri =
      'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/deleted-replacement.md';
    const relativePath = 'durable/projects/threadnote/deleted-replacement.md';
    const worktreePath = join(worktree, relativePath);
    const previousContent =
      'MEMORY\nkind: durable\nstatus: active\nvisibility: shared\nproject: threadnote\ntopic: deleted-replacement\nmemory_id: tn_deleted_replacement\n\nPrevious body.\n';
    const replacementContent = previousContent
      .replace('visibility: shared', 'visibility: personal')
      .replace('Previous body.', 'Replacement body.');
    await writeCanonicalResource(home, sourceUri, replacementContent);
    await writeCanonicalResource(home, targetUri, previousContent);
    await mkdir(dirname(worktreePath), {recursive: true});
    await writeFile(worktreePath, previousContent, 'utf8');
    await git(['add', relativePath], worktree);
    await git(['commit', '-m', 'add deletion target'], worktree);
    await runForget(config, targetUri, {});
    if (deletion === 'staged') {
      await git(['rm', '--', relativePath], worktree);
    } else {
      await rm(worktreePath, {force: true});
    }
    const statusBefore = await gitOutput(['status', '--porcelain'], worktree);

    await expect(runSharePublish(config, sourceUri, {push: false, team: 'default'})).rejects.toThrow(
      /changed shared worktree file/,
    );

    await expect(readFile(canonicalResourceFile(home, sourceUri), 'utf8')).resolves.toBe(replacementContent);
    await expect(readFile(canonicalResourceFile(home, targetUri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(worktreePath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe(statusBefore);
  });

  it('preserves a forgotten target while a Git operation is in progress', async () => {
    const {config, home, worktree} = await makeShareRepo();
    const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/operation-replacement.md';
    const targetUri =
      'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/operation-replacement.md';
    const relativePath = 'durable/projects/threadnote/operation-replacement.md';
    const worktreePath = join(worktree, relativePath);
    const previousContent =
      'MEMORY\nkind: durable\nstatus: active\nvisibility: shared\nproject: threadnote\ntopic: operation-replacement\nmemory_id: tn_operation_replacement\n\nPrevious body.\n';
    const replacementContent = previousContent
      .replace('visibility: shared', 'visibility: personal')
      .replace('Previous body.', 'Replacement body.');
    await writeCanonicalResource(home, sourceUri, replacementContent);
    await writeCanonicalResource(home, targetUri, previousContent);
    await mkdir(dirname(worktreePath), {recursive: true});
    await writeFile(worktreePath, previousContent, 'utf8');
    await git(['add', relativePath], worktree);
    await git(['commit', '-m', 'add operation target'], worktree);
    await runForget(config, targetUri, {});
    const mergeHead = await gitOutput(['rev-parse', '--git-path', 'MERGE_HEAD'], worktree);
    await writeFile(mergeHead, `${await gitOutput(['rev-parse', 'HEAD'], worktree)}\n`, 'utf8');
    const headBefore = await gitOutput(['rev-parse', 'HEAD'], worktree);

    await expect(runSharePublish(config, sourceUri, {push: false, team: 'default'})).rejects.toThrow(
      /in-progress Git operation/,
    );

    await expect(readFile(canonicalResourceFile(home, sourceUri), 'utf8')).resolves.toBe(replacementContent);
    await expect(readFile(canonicalResourceFile(home, targetUri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(worktreePath, 'utf8')).resolves.toBe(previousContent);
    await expect(gitOutput(['rev-parse', 'HEAD'], worktree)).resolves.toBe(headBefore);
  });

  it('preserves arbitrary replacement bodies across a clean tracked forget and republish cycle', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .uniqueArray(fc.string({unit: fc.constantFrom(...'0123456789abcdef'), minLength: 1, maxLength: 32}), {
            minLength: 2,
            maxLength: 2,
          })
          .filter(([previous, replacement]) => previous !== replacement),
        async ([previousBody, replacementBody]) => {
          const {config, home, worktree} = await makeShareRepo();
          const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/property-replacement.md';
          const targetUri =
            'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/property-replacement.md';
          const relativePath = 'durable/projects/threadnote/property-replacement.md';
          const previousContent = `MEMORY\nkind: durable\nstatus: active\nvisibility: shared\nproject: threadnote\ntopic: property-replacement\nmemory_id: tn_property_replacement\n\n${previousBody}\n`;
          const replacementContent = `MEMORY\nkind: durable\nstatus: active\nvisibility: personal\nproject: threadnote\ntopic: property-replacement\nmemory_id: tn_property_replacement\n\n${replacementBody}\n`;
          await writeCanonicalResource(home, sourceUri, replacementContent);
          await writeCanonicalResource(home, targetUri, previousContent);
          await mkdir(dirname(join(worktree, relativePath)), {recursive: true});
          await writeFile(join(worktree, relativePath), previousContent, 'utf8');
          await git(['add', relativePath], worktree);
          await git(['commit', '-m', 'add property shared memory'], worktree);
          await runForget(config, targetUri, {});

          await runSharePublish(config, sourceUri, {push: false, team: 'default'});

          const published = await readFile(canonicalResourceFile(home, targetUri), 'utf8');
          expect(published).toContain(`\n${replacementBody}\n`);
          await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(published);
          await expect(readFile(canonicalResourceFile(home, sourceUri), 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
          });
        },
      ),
      {numRuns: 8},
    );
  });

  it('syncs all configured teams when no team is provided', async () => {
    const repo = await makeShareRepo();
    const friends = await addShareTeam(repo, 'friends');
    const {store} = await nativeStoreFixture(repo.root);
    const defaultRelativePath = 'durable/projects/threadnote/default.md';
    const friendsRelativePath = 'durable/projects/threadnote/friends.md';
    const defaultUri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/default.md';
    const friendsUri = 'threadnote://user/denys/memories/shared/friends/durable/projects/threadnote/friends.md';

    await mkdir(join(repo.seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(repo.seed, defaultRelativePath),
      'MEMORY\nkind: durable\nstatus: active\n\ndefault body\n',
      'utf8',
    );
    await git(['add', defaultRelativePath], repo.seed);
    await git(['commit', '-m', 'add default shared memory'], repo.seed);
    await git(['push', 'origin', 'main'], repo.seed);

    await mkdir(join(friends.seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(friends.seed, friendsRelativePath),
      'MEMORY\nkind: durable\nstatus: active\n\nfriends body\n',
      'utf8',
    );
    await git(['add', friendsRelativePath], friends.seed);
    await git(['commit', '-m', 'add friends shared memory'], friends.seed);
    await git(['push', 'origin', 'main'], friends.seed);

    await runShareSync(repo.config, {push: false});

    await expect(readFile(canonicalResourceFile(store, defaultUri), 'utf8')).resolves.toContain('default body');
    await expect(readFile(canonicalResourceFile(store, friendsUri), 'utf8')).resolves.toContain('friends body');
  });

  it('syncs only the requested team when team is provided', async () => {
    const repo = await makeShareRepo();
    const friends = await addShareTeam(repo, 'friends');
    const {store} = await nativeStoreFixture(repo.root);
    const defaultRelativePath = 'durable/projects/threadnote/default.md';
    const friendsRelativePath = 'durable/projects/threadnote/friends.md';
    const defaultUri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/default.md';
    const friendsUri = 'threadnote://user/denys/memories/shared/friends/durable/projects/threadnote/friends.md';

    await mkdir(join(repo.seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(repo.seed, defaultRelativePath),
      'MEMORY\nkind: durable\nstatus: active\n\ndefault body\n',
      'utf8',
    );
    await git(['add', defaultRelativePath], repo.seed);
    await git(['commit', '-m', 'add default shared memory'], repo.seed);
    await git(['push', 'origin', 'main'], repo.seed);

    await mkdir(join(friends.seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(friends.seed, friendsRelativePath),
      'MEMORY\nkind: durable\nstatus: active\n\nfriends body\n',
      'utf8',
    );
    await git(['add', friendsRelativePath], friends.seed);
    await git(['commit', '-m', 'add friends shared memory'], friends.seed);
    await git(['push', 'origin', 'main'], friends.seed);

    await runShareSync(repo.config, {push: false, team: 'friends'});

    await expect(readFile(canonicalResourceFile(store, friendsUri), 'utf8')).resolves.toContain('friends body');
    await expect(readFile(canonicalResourceFile(store, defaultUri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not let inherited git environment redirect share init into the caller repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-share-init-env-'));
    homes.push(root);
    const remote = await makeSeededRemote(root);

    const callerRepo = join(root, 'caller');
    await mkdir(callerRepo, {recursive: true});
    await git(['init'], callerRepo);
    await git(['checkout', '-b', 'main'], callerRepo);
    await git(['config', 'user.email', 'threadnote-test@example.com'], callerRepo);
    await git(['config', 'user.name', 'Threadnote Test'], callerRepo);
    await writeFile(join(callerRepo, 'tracked.txt'), 'caller repo\n', 'utf8');
    await git(['add', 'tracked.txt'], callerRepo);
    await git(['commit', '-m', 'caller initial'], callerRepo);
    const callerHead = await gitOutput(['rev-parse', 'HEAD'], callerRepo);

    const callerGitDir = join(callerRepo, '.git');
    process.env.GIT_DIR = callerGitDir;
    process.env.GIT_COMMON_DIR = callerGitDir;
    process.env.GIT_WORK_TREE = callerRepo;
    process.env.GIT_INDEX_FILE = join(callerGitDir, 'index');

    const home = join(root, 'home');
    const config: ShareRuntime = {account: 'local', agentContextHome: home, agentId: 'threadnote', user: 'denys'};

    await runShareInit(config, remote, {push: false, team: 'threadnote'});

    await expect(gitOutput(['rev-parse', 'HEAD'], callerRepo)).resolves.toBe(callerHead);
    await expect(gitOutput(['status', '--porcelain'], callerRepo)).resolves.toBe('');
    await expect(gitOutput(['log', '-1', '--format=%s'], callerRepo)).resolves.toBe('caller initial');
  });

  it('stops before rebase when non-shareable untracked files remain', async () => {
    const {config, worktree} = await makeShareRepo();
    await writeFile(join(worktree, 'local.txt'), 'local only\n', 'utf8');

    await expect(runShareSync(config, {message: 'share: test sync', push: false})).rejects.toThrow(
      /did not auto-commit/,
    );
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toContain('?? local.txt');
  });

  it('refuses to ingest upstream shared memories that match the scrubber', async () => {
    const {config, root, seed} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/leak.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/leak.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(seed, relativePath),
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        '',
        ['aws_session_token=', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join(''),
      ].join('\n') + '\n',
      'utf8',
    );
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add unsafe shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    await runShareSync(config, {push: false});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('strips personal provenance and managed metadata before ingesting upstream shared memories', async () => {
    const {config, root, seed} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(seed, relativePath),
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'references: threadnote://user/alice/memories/durable/projects/threadnote/local.md',
        '',
        'shared body',
        '',
        '<!-- MEMORY_FIELDS',
        '{',
        '  "version": 1',
        '}',
        '-->',
      ].join('\n'),
      'utf8',
    );
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory with provenance'], seed);
    await git(['push', 'origin', 'main'], seed);

    await runShareSync(config, {push: false});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(
      ['MEMORY', 'kind: durable', 'status: active', '', 'shared body'].join('\n'),
    );
  });

  it('clears a pending added reindex when native canonical store only differs by the final newline', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nshared body', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nshared body\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await runShareSync(config, {push: false});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nshared body\n',
    );
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rebases a legacy-home pending path onto the current worktree before replay', async () => {
    const {config, home, root, seed} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nshared body', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nshared body\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {
                path: join(root, '.openviking', 'data', 'viking', relativePath),
                relativePath,
                status: 'added',
              },
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await runShareSync(config, {push: false});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nshared body\n',
    );
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not ingest shared agent artifacts as memory conflicts', async () => {
    const {config, home, root, seed} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'agent-artifacts/skills/codex/reviewer/SKILL.md';
    const uri = 'threadnote://user/denys/memories/shared/default/agent-artifacts/skills/codex/reviewer/SKILL.md';
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), '# Reviewer\n\nReview pull requests.\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared skill'], seed);
    await git(['push', 'origin', 'main'], seed);

    await runShareSync(config, {push: false});

    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(runEffect(listShareConflicts(config, {team: 'default'}))).resolves.toEqual([]);
  });

  it('replaces a divergent native canonical store resource when replaying a pending added reindex', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nshared body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await runShareSync(config, {push: false});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nshared body',
    );
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('shows and resolves a pending added conflict by taking shared content', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nshared body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    const conflicts = await runEffect(listShareConflicts(config, {team: 'default'}));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      id,
      reason: 'local native canonical store content differs from the newly added shared file',
      status: 'added',
    });
    const detail = await runEffect(showShareConflict(config, id));
    expect(detail.diff).toContain('local edit');
    expect(detail.diff).toContain('shared body');

    const result = await resolveShareConflict(config, id, {take: 'shared'});

    expect(result.backupPath).toContain('conflict-backups');
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nshared body',
    );
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  }, 10000);

  it('resolves a pending added conflict by publishing local content to the shared repo', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nshared body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await resolveShareConflict(config, id, {push: false, take: 'local'});

    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n',
    );
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n',
    );
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(gitOutput(['log', '-1', '--format=%s'], worktree)).resolves.toBe(`share: resolve ${relativePath}`);
  }, 10000);

  it('resolves a pending added conflict from an explicit merged file', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nshared body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );
    const mergedPath = join(root, 'merged.md');
    await writeFile(mergedPath, 'MEMORY\nkind: durable\nstatus: active\n\nmerged body\n', 'utf8');

    await resolveShareConflict(config, id, {fromFile: mergedPath, push: false});

    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nmerged body\n',
    );
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nmerged body\n',
    );
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  }, 10000);

  it('blocks unshareable citations from outbound conflict resolution and inbound take shared', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/cited.md';
    const id = `default:${relativePath}`;
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/cited.md';
    const sharedContent = citedMemory('shared inbound');
    const unshareableSharedContent = citedMemory('unshareable shared inbound', {
      repositoryIdentityKind: 'local',
    });
    const localContent = citedMemory('local edit', {sourceDirty: true});
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), `${sharedContent}\n`, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add cited shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(sharedContent);
    await writeCanonicalResource(store, uri, localContent);

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await expect(resolveShareConflict(config, id, {push: false, take: 'local'})).rejects.toThrow(
      'dirty worktree cannot be shared',
    );
    const mergedPath = join(root, 'merged-citation.md');
    await writeFile(mergedPath, citedMemory('merged file', {repositoryIdentityKind: 'local'}), 'utf8');
    await expect(resolveShareConflict(config, id, {fromFile: mergedPath, push: false})).rejects.toThrow(
      'portable remote repository identity',
    );
    await expect(
      resolveShareConflict(config, id, {
        mergedContent: malformedCitedMemory('MCP merged content'),
        push: false,
      }),
    ).rejects.toThrow('malformed code citation metadata');

    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(`${sharedContent}\n`);
    await expect(readFile(pendingPath, 'utf8')).resolves.toContain(relativePath);

    await writeFile(join(worktree, relativePath), `${unshareableSharedContent}\n`, 'utf8');
    await expect(resolveShareConflict(config, id, {take: 'shared'})).rejects.toThrow(
      'portable remote repository identity',
    );
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(localContent);
    await expect(readFile(pendingPath, 'utf8')).resolves.toContain(relativePath);
  }, 10000);

  it('blocks dirty, local-identity, and malformed citations at shared Git ingress', async () => {
    const scenarios = [
      {content: citedMemory('dirty inbound', {sourceDirty: true}), message: 'dirty worktree cannot be shared'},
      {
        content: citedMemory('local inbound', {repositoryIdentityKind: 'local'}),
        message: 'portable remote repository identity',
      },
      {
        content: ['not a memory', '  code_citation: {not-json}', '', 'malformed CR-only inbound'].join('\r'),
        message: 'malformed code citation metadata',
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const {config, root, seed} = await makeShareRepo();
      const {store} = await nativeStoreFixture(root);
      const relativePath = `durable/projects/threadnote/cited-inbound-${index}.md`;
      const uri = `threadnote://user/denys/memories/shared/default/${relativePath}`;
      await mkdir(dirname(join(seed, relativePath)), {recursive: true});
      await writeFile(join(seed, relativePath), `${scenario.content}\n`, 'utf8');
      await git(['add', relativePath], seed);
      await git(['commit', '-m', `add blocked cited shared memory ${index}`], seed);
      await git(['push', 'origin', 'main'], seed);

      await runShareSync(config, {push: false});
      await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
      const conflicts = await runEffect(listShareConflicts(config, {team: 'default'}));
      expect(conflicts).toEqual([expect.objectContaining({reason: expect.stringContaining(scenario.message)})]);
    }
  }, 30000);

  it('keeps a stable local identity when explicit shared resolution repairs a dropped ID', async () => {
    const {config, droppedIdentity, home, id, original, relativePath, store, uri, worktree} =
      await makeDroppedIdentityFixture('shared-identity-continuity');
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(original);
    const conflicts = await runEffect(listShareConflicts(config, {team: 'default'}));
    expect(conflicts).toEqual([expect.objectContaining({id, reason: expect.stringContaining('stable memory_id')})]);
    const detail = await runEffect(showShareConflict(config, id));
    expect(detail.resolutionGuidance).toContain(`threadnote share conflict resolve ${id} --take shared`);
    const mcpList = await runEffect(runShareConflictsTool(config, {team: 'default'}));
    const mcpShow = await runEffect(runShareConflictShowTool(config, id, {team: 'default'}));
    expect(mcpList.content[0]?.type === 'text' ? mcpList.content[0].text : '').toContain('"take":"shared"');
    expect(mcpShow.content[0]?.type === 'text' ? mcpShow.content[0].text : '').toContain('"take":"shared"');
    await resolveShareConflict(config, id, {take: 'shared', push: false});
    const repaired = droppedIdentity.replace('\n\n', '\nmemory_id: tn_shared_identity_continuity\n\n');
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(repaired);
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(repaired);
    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await gitOutput(['status', '--porcelain'], worktree)).toBe('');
  }, 20000);

  it('repairs a dropped ID from the previous Git revision when the local record is absent', async () => {
    const {config, droppedIdentity, home, id, original, relativePath, store, uri, worktree} =
      await makeDroppedIdentityFixture('previous-identity');
    await rm(canonicalResourceFile(store, uri));

    await resolveShareConflict(config, id, {push: false, take: 'shared'});

    const expected = droppedIdentity.replace('\n\n', '\nmemory_id: tn_previous_identity\n\n');
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(expected);
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(expected);
    expect(expected).not.toBe(original);
    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 20000);

  it('rejects divergent previous and local identities before mutation', async () => {
    const {config, home, id, relativePath, store, uri, worktree} =
      await makeDroppedIdentityFixture('divergent-identity');
    const divergent =
      'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: divergent-identity\nmemory_id: tn_other_local_identity\n\nLocal body.';
    await writeCanonicalResource(store, uri, divergent);
    const before = {
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      pending: await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    };

    const detail = await runEffect(showShareConflict(config, id));
    expect(detail.resolutionGuidance).not.toContain(`threadnote share conflict resolve ${id} --take shared`);
    await expect(resolveShareConflict(config, id, {push: false, take: 'shared'})).rejects.toThrow(
      'differs from previous shared memory_id',
    );
    expect({
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      pending: await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    }).toEqual(before);
  }, 20000);

  it('rejects staged identity-repair targets in both preview and apply mode', async () => {
    const {config, droppedIdentity, home, id, relativePath, store, uri, worktree} =
      await makeDroppedIdentityFixture('staged-identity-repair');
    const staged = droppedIdentity.replace('Remote body.', 'Unreviewed staged body.');
    await writeFile(join(worktree, relativePath), staged, 'utf8');
    await git(['add', relativePath], worktree);
    const before = {
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      index: await gitOutput(['diff', '--cached'], worktree),
      pending: await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    };

    await expect(resolveShareConflict(config, id, {dryRun: true, push: false, take: 'shared'})).rejects.toThrow(
      'Refusing to overwrite changed shared worktree file',
    );
    await expect(resolveShareConflict(config, id, {push: false, take: 'shared'})).rejects.toThrow(
      'Refusing to overwrite changed shared worktree file',
    );
    expect({
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      index: await gitOutput(['diff', '--cached'], worktree),
      pending: await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    }).toEqual(before);
    await expect(readFile(join(home, 'share', 'conflict-backups'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  }, 20000);

  it('previews a clean identity repair prospectively without mutation', async () => {
    const {config, home, id, relativePath, store, uri, worktree} =
      await makeDroppedIdentityFixture('preview-identity-repair');
    const before = {
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      pending: await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    };

    const preview = await resolveShareConflict(config, id, {dryRun: true, push: false, take: 'shared'});

    expect(preview.messages).toEqual([`Would accept shared file content for ${uri}.`]);
    expect(preview.backupPath).toBeUndefined();
    expect({
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      pending: await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    }).toEqual(before);
    await expect(readFile(join(home, 'share', 'conflict-backups'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  }, 20000);

  it('rejects read-only identity repair before creating backups or mutating state', async () => {
    const {config, home, id, relativePath, store, uri, worktree} =
      await makeDroppedIdentityFixture('read-only-identity-repair');
    const teamsPath = join(home, 'share', 'teams.json');
    const teams = JSON.parse(await readFile(teamsPath, 'utf8')) as {
      teams: {default: {access?: string}};
    };
    teams.teams.default.access = 'read-only';
    await writeFile(teamsPath, `${JSON.stringify(teams, undefined, 2)}\n`, 'utf8');
    const before = {
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      pending: await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    };

    await expect(resolveShareConflict(config, id, {push: false, take: 'shared'})).rejects.toThrow(
      'read-only; cannot repair shared memory identity',
    );
    expect({
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      pending: await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    }).toEqual(before);
    await expect(readFile(join(home, 'share', 'conflict-backups'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  }, 20000);

  it('keeps the tracked source intact after an atomic repair write failure and retries cleanly', async () => {
    const {config, droppedIdentity, home, id, relativePath, store, uri, worktree} =
      await makeDroppedIdentityFixture('atomic-identity-repair');
    const target = join(worktree, relativePath);
    const temporaryPath = `${target}.${process.pid}.tmp`;
    await mkdir(temporaryPath, {recursive: true});

    await expect(resolveShareConflict(config, id, {push: false, take: 'shared'})).rejects.toBeDefined();
    await expect(readFile(target, 'utf8')).resolves.toBe(`${droppedIdentity}\n`);
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toContain('Original body.');
    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).resolves.toContain(
      relativePath,
    );

    await rm(temporaryPath, {recursive: true});
    await resolveShareConflict(config, id, {push: false, take: 'shared'});
    const repaired = droppedIdentity.replace('\n\n', '\nmemory_id: tn_atomic_identity_repair\n\n');
    await expect(readFile(target, 'utf8')).resolves.toBe(repaired);
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(repaired);
  }, 20000);

  it('rejects an identity repair when another active team record owns the stable ID', async () => {
    const fixture = await makeDroppedIdentityFixture('duplicate-identity-repair', async initial => {
      const duplicatePath = 'durable/projects/threadnote/duplicate-owner.md';
      const duplicate =
        'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: duplicate-owner\nmemory_id: tn_duplicate_identity_repair\n\nOther record.';
      await writeFile(join(initial.seed, duplicatePath), `${duplicate}\n`, 'utf8');
      await git(['add', duplicatePath], initial.seed);
      await git(['commit', '-m', 'add duplicate identity owner'], initial.seed);
      await git(['push', 'origin', 'main'], initial.seed);
    });
    const {config, home, id, original, relativePath, store, uri, worktree} = fixture;

    await expect(resolveShareConflict(config, id, {push: false, take: 'shared'})).rejects.toThrow(
      'already owned or ambiguous',
    );
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(original);
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(`${fixture.droppedIdentity}\n`);
    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).resolves.toContain(
      relativePath,
    );
  }, 30000);

  it('rejects an identity repair when the duplicate owner exists only in the pending Git tree', async () => {
    const {config, home, id, original, relativePath, store, uri, worktree} = await makeDroppedIdentityFixture(
      'pending-git-duplicate-identity',
    );
    const duplicatePath = 'durable/projects/threadnote/pending-duplicate-owner.md';
    const duplicateUri = `threadnote://user/denys/memories/shared/default/${duplicatePath}`;
    const duplicate =
      'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: pending-duplicate-owner\nmemory_id: tn_pending_git_duplicate_identity\n\nPending owner.\n';
    await writeFile(join(worktree, duplicatePath), duplicate, 'utf8');
    await git(['add', duplicatePath], worktree);
    await git(['commit', '-m', 'add pending duplicate identity owner'], worktree);
    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      teams: {default: Array<{path: string; relativePath: string; status: string}>};
      version: number;
    };
    pending.teams.default.push({
      path: join(worktree, duplicatePath),
      relativePath: duplicatePath,
      status: 'added',
    });
    await writeFile(pendingPath, `${JSON.stringify(pending, undefined, 2)}\n`, 'utf8');
    await expect(readFile(canonicalResourceFile(store, duplicateUri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    const before = {
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      pending: await readFile(pendingPath, 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    };

    await expect(resolveShareConflict(config, id, {push: false, take: 'shared'})).rejects.toThrow(
      `already owned by ${duplicateUri}`,
    );
    expect({
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      pending: await readFile(pendingPath, 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    }).toEqual(before);
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(original);
  }, 30000);

  it('retries a committed identity repair after push failure before clearing pending state', async () => {
    const {config, droppedIdentity, home, id, relativePath, remote, root, store, uri, worktree} =
      await makeDroppedIdentityFixture('push-retry-identity');
    const missingRemote = join(root, 'temporarily-unavailable.git');
    await git(['remote', 'set-url', 'origin', missingRemote], worktree);

    await expect(resolveShareConflict(config, id, {take: 'shared'})).rejects.toThrow('git push failed');
    const repaired = droppedIdentity.replace('\n\n', '\nmemory_id: tn_push_retry_identity\n\n');
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(repaired);
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(repaired);
    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).resolves.toContain(
      relativePath,
    );
    expect(Number(await gitOutput(['rev-list', '--count', '@{u}..HEAD'], worktree))).toBeGreaterThan(0);

    await git(['remote', 'set-url', 'origin', remote], worktree);
    await resolveShareConflict(config, id, {take: 'shared'});

    expect(await gitOutput(['rev-list', '--count', '@{u}..HEAD'], worktree)).toBe('0');
    expect(await gitOutput(['--git-dir', remote, 'show', `main:${relativePath}`])).toContain(
      'memory_id: tn_push_retry_identity',
    );
    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 30000);

  it('fails closed when upstream diverges after an identity-repair push rejection', async () => {
    const {config, droppedIdentity, home, id, relativePath, seed, store, uri, worktree} =
      await makeDroppedIdentityFixture('diverged-push-retry-identity');
    const newerUpstream = `${droppedIdentity.replace('Remote body.', 'Newer remote body.')}\n`;
    await writeFile(join(seed, relativePath), newerUpstream, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'advance remote during identity repair'], seed);
    await git(['push', 'origin', 'main'], seed);

    await expect(resolveShareConflict(config, id, {take: 'shared'})).rejects.toThrow('git push failed');
    await git(['fetch', 'origin'], worktree);
    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    const before = {
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      index: await gitOutput(['diff', '--cached'], worktree),
      pending: await readFile(pendingPath, 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    };

    await expect(resolveShareConflict(config, id, {take: 'shared'})).rejects.toThrow(
      'upstream content diverged from the unpublished local repair',
    );
    expect({
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      index: await gitOutput(['diff', '--cached'], worktree),
      pending: await readFile(pendingPath, 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    }).toEqual(before);
    expect(await gitOutput(['--git-dir', join(seed, '.git'), 'show', `origin/main:${relativePath}`])).toBe(
      newerUpstream.trim(),
    );
  }, 30000);

  it('keeps changed shared identities fail-closed and omits impossible take-shared guidance', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/identity-change.md';
    const id = `default:${relativePath}`;
    const uri = `threadnote://user/denys/memories/shared/default/${relativePath}`;
    const original = 'MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_original_identity\n\nOriginal body.\n';
    const changed = original
      .replace('tn_original_identity', 'tn_replacement_identity')
      .replace('Original body.', 'Changed body.');
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), original, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add identity-bearing shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(join(seed, relativePath), changed, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'change shared memory identity'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});

    const detail = await runEffect(showShareConflict(config, id));
    expect(detail.reason).toContain('changed stable memory_id');
    expect(detail.resolutionGuidance).not.toContain(`threadnote share conflict resolve ${id} --take shared`);
    expect(detail.resolutionGuidance).toContain(`threadnote share conflict resolve ${id} --take local`);
    const mcpList = await runEffect(runShareConflictsTool(config, {team: 'default'}));
    const mcpShow = await runEffect(runShareConflictShowTool(config, id, {team: 'default'}));
    const mcpListText = mcpList.content[0]?.type === 'text' ? mcpList.content[0].text : '';
    const mcpShowText = mcpShow.content[0]?.type === 'text' ? mcpShow.content[0].text : '';
    expect(mcpListText).not.toContain('"take":"shared"');
    expect(mcpShowText).not.toContain('"take":"shared"');
    const before = {
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      index: await gitOutput(['diff', '--cached'], worktree),
      pending: await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    };
    await expect(resolveShareConflict(config, id, {take: 'shared', push: false})).rejects.toThrow(
      'changed stable memory_id',
    );
    expect({
      canonical: await readFile(canonicalResourceFile(store, uri), 'utf8'),
      head: await gitOutput(['rev-parse', 'HEAD'], worktree),
      index: await gitOutput(['diff', '--cached'], worktree),
      pending: await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8'),
      status: await gitOutput(['status', '--porcelain=v1'], worktree),
      worktree: await readFile(join(worktree, relativePath), 'utf8'),
    }).toEqual(before);
  }, 20000);

  it('preserves arbitrary safe bodies while reconciling only missing shared identities', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-f0-9]{1,48}$/), body => {
        const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/property-identity.md';
        const establishedId = 'tn_property_identity';
        const local = `MEMORY\nkind: durable\nstatus: active\nmemory_id: ${establishedId}\n\nlocal body\n`;
        const shared = `MEMORY\nkind: durable\nstatus: active\n\n${body}\n`;
        const reconciled = reconcileMissingSharedMemoryIdentity(uri, local, shared);
        expect(reconciled).toBe(`MEMORY\nkind: durable\nstatus: active\nmemory_id: ${establishedId}\n\n${body}\n`);
        expect(parseMemoryDocument(uri, reconciled)?.metadata.memoryId).toBe(establishedId);
        expect(reconcileMissingSharedMemoryIdentity(uri, reconciled, reconciled)).toBe(reconciled);
        expect(reconciled.endsWith(`\n\n${body}\n`)).toBe(true);

        const changedIdentity = shared.replace('\n\n', '\nmemory_id: tn_other_identity\n\n');
        expect(() => reconcileMissingSharedMemoryIdentity(uri, local, changedIdentity)).toThrow(
          'changed stable memory_id',
        );
      }),
      {numRuns: 32},
    );
  });

  it('rejects merged content that drops stable local identity', async () => {
    const {config, home, root, seed} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/identity-merge.md';
    const id = `default:${relativePath}`;
    const uri = `threadnote://user/denys/memories/shared/default/${relativePath}`;
    const original = 'MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_merge_identity\n\nOriginal body.\n';
    const droppedIdentity = original
      .replace('memory_id: tn_merge_identity\n', '')
      .replace('Original body.', 'Merged body.');
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), original, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add identity-bearing shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(join(seed, relativePath), droppedIdentity, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'drop shared memory identity'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await expect(resolveShareConflict(config, id, {mergedContent: droppedIdentity})).rejects.toThrow(
      'stable memory_id',
    );
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(original.trimEnd());
    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).resolves.toContain(
      relativePath,
    );
  }, 20000);

  it('accepts a remote restoration of an earlier stable identity after a transient republish identity', async () => {
    const {config, relativePath, restored, seed, store, uri} =
      await makeIdentityRestorationFixture('restored-identity');
    await writeFile(join(seed, relativePath), restored, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'restore established identity'], seed);
    await git(['push', 'origin', 'main'], seed);

    await runShareSync(config, {push: false});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(restored.trim());
    await expect(runEffect(listShareConflicts(config, {team: 'default'}))).resolves.toEqual([]);
  }, 20000);

  it('keeps a historical identity restoration pending when another native memory owns the restored id', async () => {
    const {config, home, relativePath, restored, seed, store, transient, uri} =
      await makeIdentityRestorationFixture('native-duplicate-restoration');
    const duplicateUri =
      'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/native-duplicate-owner.md';
    const duplicate =
      'MEMORY\nkind: durable\nstatus: active\nvisibility: shared\nproject: threadnote\ntopic: native-duplicate-owner\nmemory_id: tn_established_identity\n\nOther active owner.\n';
    await writeCanonicalResource(store, duplicateUri, duplicate);
    await writeFile(join(seed, relativePath), restored, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'restore duplicated established identity'], seed);
    await git(['push', 'origin', 'main'], seed);

    await runShareSync(config, {push: false});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(transient);
    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).resolves.toContain(
      relativePath,
    );
  }, 20000);

  it('keeps a historical identity restoration pending when another Git file owns the restored id', async () => {
    const {config, home, relativePath, restored, seed, store, transient, uri} =
      await makeIdentityRestorationFixture('git-duplicate-restoration');
    const duplicatePath = 'durable/projects/threadnote/git-duplicate-owner.md';
    const duplicate =
      'MEMORY\nkind: durable\nstatus: active\nvisibility: shared\nproject: threadnote\ntopic: git-duplicate-owner\nmemory_id: tn_established_identity\n\nOther Git owner.\n';
    await writeFile(join(seed, relativePath), restored, 'utf8');
    await writeFile(join(seed, duplicatePath), duplicate, 'utf8');
    await git(['add', relativePath, duplicatePath], seed);
    await git(['commit', '-m', 'restore identity beside duplicate Git owner'], seed);
    await git(['push', 'origin', 'main'], seed);

    await runShareSync(config, {push: false});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(transient);
    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).resolves.toContain(
      relativePath,
    );
  }, 20000);

  it('recognizes only identity histories that return from the current id to the incoming id', () => {
    const id = fc
      .string({unit: fc.constantFrom(...'0123456789abcdef'), minLength: 1, maxLength: 24})
      .map(value => `tn_${value}`);
    fc.assert(
      fc.property(fc.uniqueArray(id, {minLength: 3, maxLength: 3}), ([incoming, current, unrelated]) => {
        expect(isRestoredSharedMemoryIdentityHistory([incoming, current, incoming], current, incoming)).toBe(true);
        expect(
          isRestoredSharedMemoryIdentityHistory(
            [incoming, incoming, current, current, undefined, incoming, incoming],
            current,
            incoming,
          ),
        ).toBe(true);
        expect(isRestoredSharedMemoryIdentityHistory([incoming, current, unrelated, incoming], current, incoming)).toBe(
          false,
        );
        expect(isRestoredSharedMemoryIdentityHistory([incoming, unrelated, incoming], current, incoming)).toBe(false);
      }),
      {numRuns: 64},
    );
  });

  it('resolves a pending modified conflict by taking shared content', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared';
    const newContent = 'MEMORY\nkind: durable\nstatus: active\n\nnew shared';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), `${oldContent}\n`, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(join(seed, relativePath), newContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'update shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);
    await git(['-C', worktree, 'rebase', '@{u}']);
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {path: join(worktree, relativePath), previousContent: oldContent, relativePath, status: 'modified'},
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await resolveShareConflict(config, id, {take: 'shared'});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(newContent);
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(newContent);
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  }, 10000);

  it('resolves a pending modified conflict by publishing local content', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared';
    const newContent = 'MEMORY\nkind: durable\nstatus: active\n\nnew shared';
    const localContent = 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), `${oldContent}\n`, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(join(seed, relativePath), newContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'update shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);
    await git(['-C', worktree, 'rebase', '@{u}']);
    await writeCanonicalResource(store, uri, localContent, 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {path: join(worktree, relativePath), previousContent: oldContent, relativePath, status: 'modified'},
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await resolveShareConflict(config, id, {push: false, take: 'local'});

    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(localContent);
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(localContent);
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(gitOutput(['log', '-1', '--format=%s'], worktree)).resolves.toBe(`share: resolve ${relativePath}`);
  }, 10000);

  it('resolves a pending removed conflict by taking the shared deletion', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), `${oldContent}\n`, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await rm(join(seed, relativePath));
    await git(['add', '-A'], seed);
    await git(['commit', '-m', 'delete shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);
    await git(['-C', worktree, 'rebase', '@{u}']);
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {path: join(worktree, relativePath), previousContent: oldContent, relativePath, status: 'removed'},
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    const deletionConflicts = await runEffect(listShareConflicts(config, {team: 'default'}));
    expect(formatShareConflictNextSteps('default', deletionConflicts)).toContain(
      `threadnote share conflict resolve ${id} --take shared`,
    );

    const failureDirectory = dirname(canonicalResourceFile(store, uri));
    await chmod(failureDirectory, 0o000);
    await expect(resolveShareConflict(config, id, {take: 'shared'})).rejects.toThrow(
      /resource stat|permission|EACCES/i,
    );
    await chmod(failureDirectory, 0o700);
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toContain('local edit');
    await expect(readFile(pendingPath, 'utf8')).resolves.toContain(relativePath);

    await resolveShareConflict(config, id, {take: 'shared'});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(join(worktree, relativePath), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  }, 10000);

  it('resolves a pending removed conflict by restoring local content to the shared repo', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared';
    const localContent = 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), `${oldContent}\n`, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await rm(join(seed, relativePath));
    await git(['add', '-A'], seed);
    await git(['commit', '-m', 'delete shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);
    await git(['-C', worktree, 'rebase', '@{u}']);
    await writeCanonicalResource(store, uri, localContent, 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {path: join(worktree, relativePath), previousContent: oldContent, relativePath, status: 'removed'},
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await resolveShareConflict(config, id, {push: false, take: 'local'});

    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(localContent);
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(localContent);
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(gitOutput(['log', '-1', '--format=%s'], worktree)).resolves.toBe(`share: resolve ${relativePath}`);
  }, 10000);

  it('keeps pending conflict inspection available when previous shared content fails scrubbing', async () => {
    const {config, home, root, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const sharedContent = 'MEMORY\nkind: durable\nstatus: active\n\nsafe remote body\n';
    await mkdir(dirname(join(worktree, relativePath)), {recursive: true});
    await writeFile(join(worktree, relativePath), sharedContent, 'utf8');
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nlocal body\n', 'utf8');
    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {
                path: join(worktree, relativePath),
                previousContent:
                  'MEMORY\nkind: durable\nstatus: active\n\naws_session_token=abcdefghijklmnopqrstuvwxyz0123456789ABCD\n',
                relativePath,
                status: 'modified',
              },
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    const conflicts = await runEffect(listShareConflicts(config, {team: 'default'}));
    const detail = await runEffect(showShareConflict(config, `default:${relativePath}`));

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      hasPreviousContent: false,
      reason: expect.stringContaining('previous shared content is not readable'),
    });
    expect(detail.sharedContent).toContain('safe remote body');
    expect(detail.previousContent).toBeUndefined();

    await resolveShareConflict(config, `default:${relativePath}`, {take: 'shared'});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toContain('safe remote body');
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('replaces divergent native canonical store content when replaying a pending modified reindex after restart', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared';
    const newContent = 'MEMORY\nkind: durable\nstatus: active\n\nnew shared';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), `${oldContent}\n`, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(join(seed, relativePath), newContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'update shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);
    await git(['-C', worktree, 'rebase', '@{u}']);
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {path: join(worktree, relativePath), previousContent: oldContent, relativePath, status: 'modified'},
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await runShareSync(config, {push: false});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(newContent);
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('deletes a divergent native canonical store resource when the shared file is deleted', async () => {
    const {config, root, seed} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nold shared\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    await rm(join(seed, relativePath));
    await git(['add', '-A'], seed);
    await git(['commit', '-m', 'delete shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    await runShareSync(config, {push: false});

    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('keeps a shared deletion pending when native canonical store stat fails transiently', async () => {
    const {config, home, root, seed} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nold shared\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: true});
    await git(['pull', '--rebase', 'origin', 'main'], seed);

    await rm(join(seed, relativePath));
    await git(['add', '-A'], seed);
    await git(['commit', '-m', 'delete shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    const failureDirectory = dirname(canonicalResourceFile(store, uri));
    await chmod(failureDirectory, 0o000);

    const firstResult = await syncSharedReposBeforeAgentRead(config);

    expect(firstResult.syncedTeams).toEqual(['default']);
    expect(firstResult.warnings.some(warning => warning.includes('1 pending shared memory ingest failure'))).toBe(true);
    await chmod(failureDirectory, 0o700);
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toContain('old shared');
    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await expect(readFile(pendingPath, 'utf8')).resolves.toContain(relativePath);

    const secondResult = await syncSharedReposBeforeAgentRead(config);

    expect(secondResult.syncedTeams).toEqual(['default']);
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('restores a dirty pending file before retrying its native canonical store ingest', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const remoteContent = 'MEMORY\nkind: durable\nstatus: active\n\nremote body\n';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), remoteContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: true});
    await git(['pull', '--rebase', 'origin', 'main'], seed);

    await writeFile(
      join(worktree, relativePath),
      'MEMORY\nkind: durable\nstatus: active\n\nlocal dirty edit\n',
      'utf8',
    );
    await writeCanonicalResource(store, uri, 'MEMORY\nkind: durable\nstatus: active\n\nstale cache\n', 'utf8');
    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual(['default']);
    expect(result.warnings.some(warning => warning.includes('restored 1 tracked shared file'))).toBe(true);
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(remoteContent);
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toContain('remote body');
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rewrites equivalent native canonical store content with duplicate managed metadata', async () => {
    const {config, root, seed} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const trailer = ['<!-- MEMORY_FIELDS', '{', '  "version": 1', '}', '-->'].join('\n');
    const remoteContent = `MEMORY\nkind: durable\nstatus: active\n\nremote body\n\n${trailer}\n`;
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), remoteContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await writeCanonicalResource(store, uri, `${remoteContent.trim()}\n\n${trailer}\n`, 'utf8');

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual(['default']);
    const stored = await readFile(canonicalResourceFile(store, uri), 'utf8');
    expect(stored).toContain('remote body');
    expect(stored).not.toContain('<!-- MEMORY_FIELDS');
  });

  it('leaves equivalent native canonical store content with one managed metadata trailer byte-for-byte unchanged', async () => {
    const {config, root, seed} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const trailer = ['<!-- MEMORY_FIELDS', '{', '  "version": 1', '}', '-->'].join('\n');
    const remoteContent = `MEMORY\nkind: durable\nstatus: active\n\nremote body\n\n${trailer}\n`;
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), remoteContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await writeCanonicalResource(store, uri, remoteContent, 'utf8');

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual(['default']);
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toBe(remoteContent);
  });

  it('restores dirty tracked shared files before automatic sync', async () => {
    const {config, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nold shared\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: true});
    await git(['pull', '--rebase', 'origin', 'main'], seed);

    await writeFile(
      join(worktree, relativePath),
      'MEMORY\nkind: durable\nstatus: active\n\nlocal dirty edit\n',
      'utf8',
    );
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nremote update\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'update shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual(['default']);
    expect(result.warnings.some(warning => warning.includes('restored 1 tracked shared file'))).toBe(true);
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe('');
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toContain('remote update');
    await expect(readFile(canonicalResourceFile(store, uri), 'utf8')).resolves.toContain('remote update');
  });

  it('carries a behind team across a process-state restart through the fetch receipt', async () => {
    const {config, home, seed} = await makeShareRepo();
    const relativePath = 'durable/projects/threadnote/restart-receipt.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/restart-receipt.md';
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(
      join(seed, relativePath),
      'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: restart-receipt\n\nRemote body.\n',
      'utf8',
    );
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add restart receipt memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    await refreshSharedRepos(config, true);
    const receiptPath = join(home, 'share', 'fetch-receipts', 'default.json');
    await expect(readFile(receiptPath, 'utf8').then(content => JSON.parse(content))).resolves.toMatchObject({
      behind: 1,
      succeeded: true,
    });
    clearAutoShareStateForTest();

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual(['default']);
    await expect(readFile(canonicalResourceFile(home, uri), 'utf8')).resolves.toContain('Remote body.');
    await expect(readFile(receiptPath, 'utf8').then(content => JSON.parse(content))).resolves.toMatchObject({
      behind: 0,
      succeeded: true,
    });
  });

  it('forces a primed reader to consume the first receipt written by a concurrent process after deferral', async () => {
    const {config, home, remote, root, seed, worktree} = await makeShareRepo();
    const relativePath = 'durable/projects/threadnote/concurrent-receipt.md';
    const uri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/concurrent-receipt.md';
    expect(await syncSharedReposBeforeAgentRead(config)).toEqual({syncedTeams: [], warnings: []});

    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(
      join(seed, relativePath),
      'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: concurrent-receipt\n\nRemote body.\n',
      'utf8',
    );
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add concurrent receipt memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['fetch', 'origin'], worktree);

    const ready = join(root, 'receipt-owner.ready');
    const release = join(root, 'receipt-owner.release');
    const helper = join(import.meta.dirname, '../helpers/share-lock-receipt-owner.ts');
    const owner = Bun.spawn({
      cmd: [process.execPath, helper, home, ready, release, remote, worktree],
      stderr: 'pipe',
      stdout: 'pipe',
    });
    let ownerExitCode: number | undefined;
    try {
      const readyDeadline = Date.now() + 10_000;
      while (!(await Bun.file(ready).exists())) {
        if (owner.exitCode !== null) {
          throw TestError.make({
            message: `Receipt owner exited before acquiring the lock: ${await new Response(owner.stderr).text()}`,
          });
        }
        if (Date.now() >= readyDeadline) {
          throw TestError.make({
            message: 'Timed out waiting for the receipt owner to acquire the shared repository lock.',
          });
        }
        await Bun.sleep(10);
      }
      const deferred = await syncSharedReposBeforeAgentRead(config);

      expect(deferred).toEqual({syncedTeams: [], warnings: []});
      await expect(readFile(canonicalResourceFile(home, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await writeFile(release, 'release\n', 'utf8');
      const exited = await Promise.race([owner.exited, Bun.sleep(5_000).then(() => undefined)]);
      if (exited === undefined) owner.kill(9);
      ownerExitCode = await owner.exited;
    }
    if (ownerExitCode !== 0) {
      throw TestError.make({
        message: `Receipt owner exited with ${ownerExitCode}: ${await new Response(owner.stderr).text()}`,
      });
    }

    const caughtUp = await syncSharedReposBeforeAgentRead(config);

    expect(caughtUp.syncedTeams).toEqual(['default']);
    await expect(readFile(canonicalResourceFile(home, uri), 'utf8')).resolves.toContain('Remote body.');
    await expect(
      readFile(join(home, 'share', 'fetch-receipts', 'default.json'), 'utf8').then(content => JSON.parse(content)),
    ).resolves.toMatchObject({behind: 0, succeeded: true});
  });

  it('leaves an in-progress rebase untouched when retrying pending ingestion', async () => {
    const {config, home, seed, worktree} = await makeShareRepo();
    const relativePath = 'durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared\n';
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), oldContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['pull', '--rebase', 'origin', 'main'], worktree);

    await writeFile(
      join(worktree, relativePath),
      'MEMORY\nkind: durable\nstatus: active\n\nlocal resolution\n',
      'utf8',
    );
    await git(['add', relativePath], worktree);
    await git(['commit', '-m', 'local shared edit'], worktree);
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nremote resolution\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'remote shared edit'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['fetch', 'origin'], worktree);
    const rebase = await runEffect(runCommand('git', ['rebase', 'origin/main'], {allowFailure: true, cwd: worktree}));
    expect(rebase.exitCode).not.toBe(0);
    await writeFile(
      join(home, 'share', 'auto-sync-pending-reindexes.json'),
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'modified'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );
    const statusBefore = await gitOutput(['status', '--porcelain'], worktree);
    const indexBefore = await gitOutput(['ls-files', '-u'], worktree);
    const contentBefore = await readFile(join(worktree, relativePath), 'utf8');

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('Git operation already in progress'))).toBe(true);
    expect(result.warnings.some(warning => warning.includes('continued for other remote changes'))).toBe(false);
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe(statusBefore);
    await expect(gitOutput(['ls-files', '-u'], worktree)).resolves.toBe(indexBefore);
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(contentBefore);
  });

  it('leaves an in-progress merge index and worktree untouched', async () => {
    const {config, seed, worktree} = await makeShareRepo();
    const relativePath = 'durable/projects/threadnote/shared.md';
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nremote body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['fetch', 'origin'], worktree);
    await git(['merge', '--no-ff', '--no-commit', 'origin/main'], worktree);
    const statusBefore = await gitOutput(['status', '--porcelain'], worktree);
    const indexBefore = await gitOutput(['diff', '--cached', '--binary'], worktree);
    const contentBefore = await readFile(join(worktree, relativePath), 'utf8');

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('Git operation already in progress'))).toBe(true);
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe(statusBefore);
    await expect(gitOutput(['diff', '--cached', '--binary'], worktree)).resolves.toBe(indexBefore);
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(contentBefore);
  });

  it('preserves unrelated untracked files and reports that automatic sync is blocked', async () => {
    const {config, seed, worktree} = await makeShareRepo();
    const relativePath = 'durable/projects/threadnote/shared.md';
    await writeFile(join(worktree, 'local.txt'), 'local only\n', 'utf8');
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nremote body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('untracked or unmanaged changes'))).toBe(true);
    await expect(readFile(join(worktree, 'local.txt'), 'utf8')).resolves.toBe('local only\n');
    await expect(gitOutput(['rev-parse', 'HEAD'], worktree)).resolves.not.toBe(
      await gitOutput(['rev-parse', 'origin/main'], worktree),
    );
  });

  it('does not let one failed memory ingest block later remote memories', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {store} = await nativeStoreFixture(root);
    const blockedPath = 'durable/projects/threadnote/blocked.md';
    const safePath = 'durable/projects/threadnote/safe.md';
    const safeUri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/safe.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(seed, blockedPath),
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        '',
        ['aws_session_token=', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join(''),
      ].join('\n') + '\n',
      'utf8',
    );
    await git(['add', blockedPath], seed);
    await git(['commit', '-m', 'add blocked shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    const firstResult = await syncSharedReposBeforeAgentRead(config);

    expect(firstResult.syncedTeams).toEqual(['default']);
    expect(firstResult.warnings.some(warning => warning.includes('1 pending shared memory ingest failure'))).toBe(true);

    await writeFile(join(seed, safePath), 'MEMORY\nkind: durable\nstatus: active\n\nsafe body\n', 'utf8');
    await git(['add', safePath], seed);
    await git(['commit', '-m', 'add safe shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);

    const secondResult = await syncSharedReposBeforeAgentRead(config);

    expect(secondResult.syncedTeams).toEqual(['default']);
    expect(secondResult.warnings.some(warning => warning.includes('1 pending shared memory ingest failure'))).toBe(
      true,
    );
    expect(
      secondResult.warnings.some(warning => warning.includes('Automatic sync continued for other remote changes')),
    ).toBe(true);
    await expect(readFile(canonicalResourceFile(store, safeUri), 'utf8')).resolves.toContain('safe body');
    await expect(gitOutput(['rev-parse', 'HEAD'], worktree)).resolves.toBe(
      await gitOutput(['rev-parse', 'origin/main'], worktree),
    );
    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).resolves.toContain(
      blockedPath,
    );
  });

  it('materializes previous content only for a failed remote update', async () => {
    const {config, home, seed} = await makeShareRepo();
    const relativePath = 'durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared\n';
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), oldContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: true});
    await git(['pull', '--rebase', 'origin', 'main'], seed);

    await writeFile(
      join(seed, relativePath),
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        '',
        ['aws_session_token=', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join(''),
      ].join('\n') + '\n',
      'utf8',
    );
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'update shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.warnings.some(warning => warning.includes('1 pending shared memory ingest failure'))).toBe(true);
    const pending = JSON.parse(await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')) as {
      teams: {default: Array<{previousContent?: string; previousRevision?: string}>};
    };
    expect(pending.teams.default[0]?.previousContent).toBe(oldContent);
    expect(pending.teams.default[0]?.previousRevision).toBeUndefined();
  });
});

function citedMemory(
  body: string,
  overrides: {readonly repositoryIdentityKind?: 'local' | 'remote'; readonly sourceDirty?: boolean} = {},
): string {
  const citation = createMemoryCodeCitation({
    extractorSet: 'native-code-graph-13',
    fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
    path: 'src/share_conflicts.ts',
    repositoryId: 'b'.repeat(64),
    repositoryIdentityKind: overrides.repositoryIdentityKind ?? 'remote',
    sourceCommit: 'c'.repeat(40),
    sourceDirty: overrides.sourceDirty ?? false,
    sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
    target: {kind: 'file'},
    version: 1,
  });
  return formatMemoryDocument(
    'MEMORY',
    {
      codeCitations: [citation],
      kind: 'durable',
      project: 'threadnote',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      sourceAgentClient: 'codex',
      status: 'active',
      timestamp: '2026-08-26T20:00:00.000Z',
      topic: 'share-conflict-citations',
    },
    body,
  );
}

function malformedCitedMemory(body: string): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: threadnote',
    'topic: share-conflict-citations',
    'source_agent_client: codex',
    'timestamp: 2026-08-26T20:00:00.000Z',
    `schema_version: ${MEMORY_SCHEMA_VERSION}`,
    '  code_citation: {not-json}',
    '',
    body,
  ].join('\n');
}
