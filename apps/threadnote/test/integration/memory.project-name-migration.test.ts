import {Array as EffectArray} from 'effect';
import {mkdtemp, mkdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {hasProjectNameMigrationCandidates, runMigrateProjectNames} from '@threadnote/threadnote/memory/index';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runCommand} from '@threadnote/threadnote/utils';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const GIT_ENV_KEYS = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;

describe('project-name memory migration', () => {
  let previousCallerCwd: string | undefined;
  let previousGitEnv: Map<string, string | undefined>;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'threadnote-project-migration-'));
    previousCallerCwd = process.env.THREADNOTE_CALLER_CWD;
    previousGitEnv = new Map(EffectArray.map(GIT_ENV_KEYS, key => [key, process.env[key]]));
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
    vi.restoreAllMocks();
    await rm(workspace, {recursive: true, force: true});
  });

  it('dry-runs moving clone-folder memories to the remote repo project', async () => {
    const repoRoot = join(workspace, 'easy-to-type');
    await initRepo(repoRoot, 'git@github.com:Kashkovsky/threadnote.git');
    process.env.THREADNOTE_CALLER_CWD = repoRoot;

    const config = runtimeConfig(join(workspace, 'home'));
    await mkdir(config.agentContextHome, {recursive: true});
    await writeFile(
      config.manifestPath,
      EffectArray.join(
        [
          'version: 1',
          'projects:',
          '  - name: easy-to-type',
          `    path: ${repoRoot}`,
          '    uri: threadnote://resources/repos/easy-to-type',
          '    seed: [README.md]',
          '    graph:',
          '      roots: [apps/easy]',
          '      closure: dependencies',
          '      include: [tools/generated]',
          'worksets:',
          '  - name: local',
          '    projects: [easy-to-type]',
          'future_monorepo:',
          '  path_candidates: [/Users/denys/src/future]',
          '  uri: threadnote://resources/repos/future',
          '',
        ],
        '\n',
      ),
      'utf8',
    );
    await writeMemory(
      config,
      'durable/projects/easy-to-type/current.md',
      EffectArray.join(
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: easy-to-type',
          'topic: current',
          'source_agent_client: codex',
          'timestamp: 2026-07-07T00:00:00.000Z',
          '',
          'Feature knowledge.',
        ],
        '\n',
      ),
    );
    await writeMemory(
      config,
      'durable/projects/threadnote/current.md',
      EffectArray.join(
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: threadnote',
          'topic: current',
          'source_agent_client: codex',
          'timestamp: 2026-07-07T00:00:00.000Z',
          '',
          'Existing remote-named memory.',
        ],
        '\n',
      ),
    );

    await expect(runEffect(hasProjectNameMigrationCandidates(config))).resolves.toBe(true);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runEffect(runMigrateProjectNames(config, {dryRun: true}));

    const output = EffectArray.join(
      EffectArray.map(log.mock.calls, call => EffectArray.join(call, ' ')),
      '\n',
    );
    expect(output).toContain('Would update seed manifest:');
    expect(output).toContain('name: threadnote');
    expect(output).toContain('uri: threadnote://resources/repos/threadnote');
    expect(output).toContain('- threadnote');
    expect(output).toContain('future_monorepo:');
    expect(output).toContain('path_candidates:');
    expect(output).toContain('graph:');
    expect(output).toContain('roots:');
    expect(output).toContain('apps/easy');
    expect(output).not.toContain('futureMonorepo');
    expect(output).not.toContain('pathCandidates');
    expect(output).toContain(
      'threadnote://user/denys/memories/durable/projects/easy-to-type/current.md -> threadnote://user/denys/memories/durable/projects/threadnote/current-from-easy-to-type.md',
    );
    expect(output).toContain(
      'Project-name migration summary: 1 memory would be migrated from easy-to-type to threadnote',
    );
    expect(output).toContain('seed manifest would be updated');
    expect(output).toContain('Run threadnote seed --only threadnote');
  });

  it('uses repo_path evidence from memories when no seed manifest exists', async () => {
    const repoRoot = join(workspace, 'easy-to-type');
    await initRepo(repoRoot, 'git@github.com:Kashkovsky/threadnote.git');

    const config = runtimeConfig(join(workspace, 'home'));
    await mkdir(config.agentContextHome, {recursive: true});
    await writeMemory(
      config,
      'handoffs/active/easy-to-type/current.md',
      EffectArray.join(
        [
          'MEMORY',
          'kind: handoff',
          'status: active',
          'project: easy-to-type',
          'topic: current',
          'source_agent_client: codex',
          'timestamp: 2026-07-07T00:00:00.000Z',
          '',
          'repo: easy-to-type',
          `repo_path: ${repoRoot}`,
          'branch: main',
        ],
        '\n',
      ),
    );

    await expect(runEffect(hasProjectNameMigrationCandidates(config))).resolves.toBe(true);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runEffect(runMigrateProjectNames(config, {dryRun: true}));

    const output = EffectArray.join(
      EffectArray.map(log.mock.calls, call => EffectArray.join(call, ' ')),
      '\n',
    );
    expect(output).not.toContain('Would update seed manifest:');
    expect(output).toContain(
      'threadnote://user/denys/memories/handoffs/active/easy-to-type/current.md -> threadnote://user/denys/memories/handoffs/active/threadnote/current.md',
    );
    expect(output).toContain(
      'Project-name migration summary: 1 memory would be migrated from easy-to-type to threadnote',
    );
    expect(output).toContain('seed manifest unchanged');
  });

  it('scans all memory-backed manifest projects, not only the current workspace', async () => {
    const currentRepo = join(workspace, 'threadnote');
    await initRepo(currentRepo, 'git@github.com:Kashkovsky/threadnote.git');
    const otherRepo = join(workspace, 'ta');
    await initRepo(otherRepo, 'git@github.com:Kashkovsky/igor-bot.git');
    process.env.THREADNOTE_CALLER_CWD = currentRepo;

    const config = runtimeConfig(join(workspace, 'home'));
    await mkdir(config.agentContextHome, {recursive: true});
    await writeFile(
      config.manifestPath,
      EffectArray.join(
        [
          'version: 1',
          'projects:',
          '  - name: threadnote',
          `    path: ${currentRepo}`,
          '    uri: threadnote://resources/repos/threadnote',
          '    seed: [README.md]',
          '  - name: ta',
          `    path: ${otherRepo}`,
          '    uri: threadnote://resources/repos/ta',
          '    seed: [README.md]',
          'worksets:',
          '  - name: all',
          '    projects: [threadnote, ta]',
          '',
        ],
        '\n',
      ),
      'utf8',
    );
    await writeMemory(
      config,
      'durable/projects/ta/current.md',
      EffectArray.join(
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: ta',
          'topic: current',
          'source_agent_client: codex',
          'timestamp: 2026-07-07T00:00:00.000Z',
          '',
          'Feature knowledge.',
        ],
        '\n',
      ),
    );

    await expect(runEffect(hasProjectNameMigrationCandidates(config))).resolves.toBe(true);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runEffect(runMigrateProjectNames(config, {dryRun: true}));

    const output = EffectArray.join(
      EffectArray.map(log.mock.calls, call => EffectArray.join(call, ' ')),
      '\n',
    );
    expect(output).toContain('Would update seed manifest:');
    expect(output).toContain('name: igor-bot');
    expect(output).toContain('uri: threadnote://resources/repos/igor-bot');
    expect(output).toContain('- igor-bot');
    expect(output).toContain(
      'threadnote://user/denys/memories/durable/projects/ta/current.md -> threadnote://user/denys/memories/durable/projects/igor-bot/current.md',
    );
    expect(output).toContain('Project-name migration summary: 1 memory would be migrated from ta to igor-bot');
  });
});

function runtimeConfig(agentContextHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'threadnote',
    manifestPath: join(agentContextHome, 'seed-manifest.yaml'),
    user: 'denys',
  };
}

async function initRepo(repoRoot: string, remoteUrl: string): Promise<void> {
  await mkdir(repoRoot);
  await runEffect(runCommand('git', ['init'], {cwd: repoRoot}));
  await runEffect(runCommand('git', ['remote', 'add', 'origin', remoteUrl], {cwd: repoRoot}));
}

async function writeMemory(config: RuntimeConfig, relativePath: string, content: string): Promise<void> {
  const path = join(
    config.agentContextHome,
    'data',
    config.account,
    'user',
    config.user,
    'memories',
    ...Effect.pipe(relativePath, EffectString.split('/')),
  );
  await mkdir(join(path, '..'), {recursive: true});
  await writeFile(path, content, 'utf8');
}
