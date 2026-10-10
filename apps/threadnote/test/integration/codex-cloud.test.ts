import {execFile} from '@threadnote/testing/node-child-process';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {TestError} from '@threadnote/testing/test-error';
import {describe, expect, it} from 'vitest';

const exec = promisify(execFile);
const gitIdentity = {
  GIT_AUTHOR_EMAIL: 'cloud@threadnote.local',
  GIT_AUTHOR_NAME: 'Cloud Test',
  GIT_COMMITTER_EMAIL: 'cloud@threadnote.local',
  GIT_COMMITTER_NAME: 'Cloud Test',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-codex-cloud-'));
  const remote = join(root, 'memory.git');
  const otherRemote = join(root, 'other.git');
  for (const path of [remote, otherRemote]) {
    await exec('git', ['init', '--bare', '--initial-branch=main', path]);
    const seed = `${path}-seed`;
    await exec('git', ['clone', path, seed]);
    await writeFile(join(seed, 'README.md'), '# Private memory fixture\n');
    await exec('git', ['-C', seed, 'add', '.']);
    await exec('git', ['-C', seed, 'commit', '-m', 'Seed memory'], {env: {...process.env, ...gitIdentity}});
    await exec('git', ['-C', seed, 'push', 'origin', 'main']);
  }
  const userHome = join(root, 'user-home');
  await mkdir(userHome);
  const home = join(root, 'home');
  const cli = (args: readonly string[], targetHome = home) =>
    exec(process.execPath, ['apps/threadnote/src/standalone.ts', ...args, '--home', targetHome], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...gitIdentity,
        HOME: userHome,
        NO_COLOR: '1',
        THREADNOTE_USER: undefined,
        THREADNOTE_AGENT_ID: undefined,
        THREADNOTE_ACCOUNT: undefined,
        CODEX_HOME: undefined,
      },
      maxBuffer: 2 * 1024 * 1024,
    });
  const run = (args: readonly string[], targetHome = home) => cli(['cloud', 'codex', ...args], targetHome);
  const bootstrap = (targetHome = home, team = 'personal', url = remote) =>
    run(['bootstrap', '--remote', url, '--team', team], targetHome);
  return {root, home, userHome, remote, otherRemote, run, bootstrap, cli};
}

function parsed(stdout: string) {
  return JSON.parse(stdout) as {
    isError?: boolean;
    structuredContent?: {memoryUri?: string};
    status?: string;
    shares?: string[];
    identity?: {user: string; agentId: string};
    graph?: {freshness: string; snapshot?: {id: string; commit: string}};
  };
}

describe('Codex Cloud CLI integration', () => {
  it.each(['threadnote-context', 'threadnote-code-graph'])(
    'rejects an unowned %s skill before previewing or creating a Git share',
    async skillName => {
      const f = await fixture();
      try {
        const skill = join(f.userHome, '.agents', 'skills', skillName, 'SKILL.md');
        await mkdir(join(f.userHome, '.agents', 'skills', skillName), {recursive: true});
        await writeFile(skill, 'Unrelated user skill.\n');
        for (const options of [['--dry-run'], []]) {
          await expect(
            f.run(['bootstrap', '--remote', f.remote, '--team', 'personal', ...options]),
          ).rejects.toMatchObject({
            stderr: expect.stringContaining('not managed by Threadnote'),
          });
          await expect(readFile(join(f.home, 'share', 'teams.json'))).rejects.toMatchObject({code: 'ENOENT'});
          await expect(readFile(join(f.home, 'codex-cloud', 'profile.json'))).rejects.toMatchObject({code: 'ENOENT'});
          expect(await readFile(skill, 'utf8')).toBe('Unrelated user skill.\n');
        }
      } finally {
        await rm(f.root, {recursive: true, force: true});
      }
    },
    30_000,
  );

  it('prepares a reusable structural graph, detects source changes, and refreshes it at startup', async () => {
    const f = await fixture();
    const repo = join(f.root, 'source');
    try {
      await exec('git', ['init', '--initial-branch=main', repo]);
      await exec('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/threadnote/source.git']);
      const source = join(repo, 'greeting.ts');
      await writeFile(source, 'export function greeting() { return "hello"; }\n');
      const commit = async () => {
        await exec('git', ['-C', repo, 'add', '.']);
        await exec('git', ['-C', repo, 'commit', '-m', 'Source fixture'], {env: {...process.env, ...gitIdentity}});
      };
      await commit();
      await f.run(['bootstrap', '--remote', f.remote, '--team', 'personal', '--cwd', repo, '--dry-run']);
      await expect(readFile(join(f.home, 'codex-cloud', 'profile.json'))).rejects.toMatchObject({code: 'ENOENT'});
      await f.run(['bootstrap', '--remote', f.remote, '--team', 'personal', '--cwd', repo]);
      const first = parsed((await f.run(['verify', '--cwd', repo, '--json'])).stdout);
      expect(first).toMatchObject({status: 'ok', graph: {freshness: 'current'}});
      expect(first.graph?.snapshot?.id).toBeTruthy();
      const unchanged = parsed((await f.run(['start', '--cwd', repo, '--json'])).stdout);
      expect(unchanged.graph?.snapshot?.id).toBe(first.graph?.snapshot?.id);
      expect((await f.cli(['graph', 'query', '--cwd', repo, '--query', 'greeting', '--json'])).stdout).toContain(
        'greeting',
      );
      await f.run([
        'remember',
        '--project',
        'source',
        '--topic',
        'greeting',
        '--cwd',
        repo,
        '--code-ref',
        'greeting.ts',
        '--text',
        'Greeting contract: return a friendly message.',
      ]);
      await f.run([
        'remember',
        '--kind',
        'handoff',
        '--project',
        'source',
        '--topic',
        'greeting-task',
        '--text',
        'Task: greeting contract. Next step: preserve the friendly message.',
      ]);
      const teams = JSON.parse(await readFile(join(f.home, 'share', 'teams.json'), 'utf8'));
      const shared = await readFile(
        join(teams.teams.personal.worktree, 'durable', 'projects', 'source', 'greeting.md'),
        'utf8',
      );
      for (const parts of [
        ['durable'],
        ['shared', 'unconfigured', 'durable'],
        ['shared', 'personal-other', 'durable'],
      ]) {
        const outside = join(
          f.home,
          'data',
          'local',
          'user',
          'codex-cloud',
          'memories',
          ...parts,
          'projects',
          'source',
        );
        await mkdir(outside, {recursive: true});
        await writeFile(
          join(outside, 'outside.md'),
          shared.replace('return a friendly message.', 'OUTSIDE_SCOPE_MARKER.'),
        );
      }
      for (const args of [[], ['--code-ref', 'greeting.ts']]) {
        const brief = await f.run(['brief', '--cwd', repo, '--task', 'greeting contract', '--json', ...args]);
        expect(brief.stdout).toContain('greeting');
        expect(brief.stdout).toContain('Greeting contract: return a friendly message.');
        expect(brief.stdout).toContain('preserve the friendly message.');
        expect(brief.stdout).not.toContain('OUTSIDE_SCOPE_MARKER');
        expect(brief.stdout).not.toContain('/shared/unconfigured/');
        if (args.length > 0) expect(JSON.parse(brief.stdout).coverage.memory.codeAnchors.matchedMemories).toBe(1);
      }
      await expect(
        f.run(['brief', '--cwd', repo, '--task', 'greeting', '--team', 'unconfigured']),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('outside the configured'),
      });
      await writeFile(source, 'export function farewell() { return "goodbye"; }\n');
      await commit();
      await expect(f.run(['verify', '--cwd', repo, '--json'])).rejects.toMatchObject({
        stdout: expect.stringContaining('"status":"fail"'),
      });
      const refreshed = parsed((await f.run(['start', '--cwd', repo, '--json'])).stdout);
      expect(refreshed).toMatchObject({status: 'ok', graph: {freshness: 'current'}});
      expect(refreshed.graph?.snapshot?.id).not.toBe(first.graph?.snapshot?.id);
      expect((await exec('git', ['-C', repo, 'status', '--porcelain'])).stdout).toBe('');
      const tree = (await exec('git', ['--git-dir', f.remote, 'ls-tree', '-r', '--name-only', 'main'])).stdout;
      expect(tree).not.toMatch(/greeting\.ts|graph|sqlite/iu);
      await expect(f.run(['start', '--cwd', 'relative-source', '--json'])).rejects.toMatchObject({
        stderr: expect.stringContaining('absolute'),
      });
    } finally {
      await rm(f.root, {recursive: true, force: true});
    }
  }, 90_000);

  it('preserves subdirectory graph selection in a configured monorepo', async () => {
    const f = await fixture();
    const repo = join(f.root, 'monorepo');
    const manifest = join(f.home, 'seed-manifest.yaml');
    try {
      for (const name of ['a', 'b']) {
        const directory = join(repo, 'apps', name);
        await mkdir(directory, {recursive: true});
        await writeFile(join(directory, 'package.json'), JSON.stringify({name: `@fixture/${name}`}));
        await writeFile(join(directory, 'index.ts'), `export const ${name} = true;\n`);
      }
      await writeFile(join(repo, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
      await exec('git', ['init', '--initial-branch=main', repo]);
      await exec('git', ['-C', repo, 'add', '.']);
      await exec('git', ['-C', repo, 'commit', '-m', 'Monorepo fixture'], {env: {...process.env, ...gitIdentity}});
      await mkdir(f.home, {recursive: true});
      await writeFile(
        manifest,
        [
          'version: 1',
          'projects:',
          ...['a', 'b'].flatMap(name => [
            `  - name: ${name}`,
            `    path: ${repo}`,
            '    seed: []',
            `    uri: threadnote://resources/repos/${name}`,
            '    graph:',
            '      closure: dependencies',
            `      roots: [apps/${name}]`,
          ]),
          '',
        ].join('\n'),
      );
      for (const name of ['a', 'b']) {
        const flags = ['--cwd', join(repo, 'apps', name), '--manifest', manifest];
        await f.run(['bootstrap', '--remote', f.remote, '--team', 'personal', ...flags]);
        const verified = JSON.parse((await f.run(['verify', '--json', ...flags])).stdout);
        expect(verified).toMatchObject({status: 'ok', graph: {freshness: 'current', projectCoverage: {project: name}}});
        const started = JSON.parse((await f.run(['start', '--json', ...flags])).stdout);
        expect(started.graph.snapshot.id).toBe(verified.graph.snapshot.id);
      }
      await expect(f.run(['verify', '--json', '--cwd', repo, '--manifest', manifest])).rejects.toMatchObject({
        stderr: expect.stringContaining('Graph scope is ambiguous'),
      });
    } finally {
      await rm(f.root, {recursive: true, force: true});
    }
  }, 60_000);

  it('waits for a concurrent process to finish its shared repository write before startup refresh', async () => {
    const f = await fixture();
    let owner: ReturnType<typeof Bun.spawn> | undefined;
    let startup: Promise<unknown> | undefined;
    const release = join(f.root, 'lock-owner.release');
    try {
      await f.bootstrap();
      const teams = JSON.parse(await readFile(join(f.home, 'share', 'teams.json'), 'utf8'));
      const ready = join(f.root, 'lock-owner.ready');
      const helper = join(import.meta.dirname, '../helpers/codex-cloud-lock-owner.ts');
      owner = Bun.spawn({
        cmd: [process.execPath, helper, f.home, ready, release, join(teams.teams.personal.worktree, 'README.md')],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await expect
        .poll(
          async () => {
            if (owner!.exitCode !== null) {
              throw TestError.make({message: `Lock owner exited before becoming ready: ${owner!.exitCode}`});
            }
            return Bun.file(ready).exists();
          },
          {timeout: 10_000},
        )
        .toBe(true);
      const pending = f.run(['start', '--json']).then(
        result => ({result}),
        error => ({error}),
      );
      startup = pending;
      expect(await Promise.race([pending, Bun.sleep(2_000).then(() => undefined)])).toBeUndefined();
      await writeFile(release, 'release');
      expect(await owner.exited).toBe(0);
      expect(await pending).toMatchObject({result: {stdout: expect.stringContaining('"status":"ok"')}});
    } finally {
      await writeFile(release, 'release');
      if (owner) {
        const exited = await Promise.race([owner.exited, Bun.sleep(5_000).then(() => undefined)]);
        if (exited === undefined) owner.kill(9);
        await owner.exited;
      }
      await startup;
      await rm(f.root, {recursive: true, force: true});
    }
  }, 45_000);

  it('keeps dry run inert, reuses bootstrap, persists identity, and verifies missing artifacts', async () => {
    const f = await fixture();
    try {
      await f.run(['bootstrap', '--remote', f.remote, '--team', 'personal', '--dry-run']);
      await expect(readFile(join(f.home, 'codex-cloud', 'profile.json'))).rejects.toMatchObject({code: 'ENOENT'});
      await expect(readFile(join(f.home, 'share', 'teams.json'))).rejects.toMatchObject({code: 'ENOENT'});
      await f.bootstrap();
      const profile = await readFile(join(f.home, 'codex-cloud', 'profile.json'), 'utf8');
      const teams = await readFile(join(f.home, 'share', 'teams.json'), 'utf8');
      expect((await f.bootstrap()).stdout).toContain('reusing it');
      expect(await readFile(join(f.home, 'codex-cloud', 'profile.json'), 'utf8')).toBe(profile);
      expect(await readFile(join(f.home, 'share', 'teams.json'), 'utf8')).toBe(teams);
      expect(parsed((await f.run(['verify', '--json'])).stdout)).toMatchObject({
        status: 'ok',
        identity: {user: 'codex-cloud', agentId: 'codex-cloud'},
        shares: ['personal'],
      });
      const registry = JSON.parse(await readFile(join(f.home, 'integrations', 'agents.json'), 'utf8'));
      expect(registry.hosts.codex.mcp).toMatchObject({
        artifactProfile: 'codex-cloud-personal',
        transport: 'cli',
        repair: false,
      });
      await expect(readFile(join(f.userHome, '.codex', 'config.toml'))).rejects.toMatchObject({code: 'ENOENT'});
      const skill = join(f.userHome, '.agents', 'skills', 'threadnote-context', 'SKILL.md');
      await rm(skill);
      await expect(f.run(['verify', '--json'])).rejects.toMatchObject({
        stdout: expect.stringContaining('"status":"fail"'),
        stderr: expect.stringContaining('verification failed'),
      });
      await f.bootstrap();
      expect(await readFile(skill, 'utf8')).toContain('Personal Codex Cloud');
      await expect(f.run(['bootstrap', '--remote', f.otherRemote, '--team', 'personal'])).rejects.toMatchObject({
        stderr: expect.stringContaining('different remote'),
      });
      await expect(
        f.run(['bootstrap', '--remote', f.remote, '--team', 'personal', '--user', 'other-user']),
      ).rejects.toMatchObject({stderr: expect.stringContaining('already uses user')});
      const accessConflict = JSON.parse(teams);
      accessConflict.teams.personal.access = 'read-only';
      await writeFile(join(f.home, 'share', 'teams.json'), JSON.stringify(accessConflict));
      await expect(f.bootstrap()).rejects.toMatchObject({stderr: expect.stringContaining('not read-write')});
      await writeFile(join(f.home, 'share', 'teams.json'), teams);
      const invalidRemote = JSON.parse(teams);
      invalidRemote.teams.personal.remote = 'https://example.invalid/memory.git?token=fixture-value';
      await writeFile(join(f.home, 'share', 'teams.json'), JSON.stringify(invalidRemote));
      await expect(f.run(['start', '--json'])).rejects.toMatchObject({
        stderr: expect.stringContaining('credential-free URL'),
      });
      await expect(f.run(['recall', '--cwd', process.cwd(), '--query', 'fixture'])).rejects.toMatchObject({
        stderr: expect.stringContaining('credential-free URL'),
      });
      await writeFile(join(f.home, 'share', 'teams.json'), teams);
      await mkdir(join(f.home, 'cursor-cloud'));
      await writeFile(
        join(f.home, 'cursor-cloud', 'profile.json'),
        JSON.stringify({
          account: 'local',
          agentId: 'other-agent',
          provider: 'cursor-cloud',
          user: 'other-user',
          version: 1,
        }),
      );
      await expect(f.run(['verify', '--json'])).rejects.toMatchObject({
        stderr: expect.stringContaining('conflicting identities'),
      });
      await rm(join(f.home, 'cursor-cloud'), {recursive: true});
      await f.bootstrap(f.home, 'docs', f.otherRemote);
      expect(parsed((await f.run(['verify', '--json'])).stdout).shares).toEqual(['docs', 'personal']);
    } finally {
      await rm(f.root, {recursive: true, force: true});
    }
  }, 90_000);

  it('pushes durable memory across isolated homes, refreshes startup, and keeps handoffs local', async () => {
    const f = await fixture();
    try {
      const second = join(f.root, 'second-home');
      await f.bootstrap();
      await f.bootstrap(second);
      const stored = parsed(
        (
          await f.run([
            'remember',
            '--project',
            'fixture',
            '--topic',
            'contract',
            '--text',
            'Cloud persistence contract marker.',
            '--json',
          ])
        ).stdout,
      );
      const uri = stored.structuredContent!.memoryUri!;
      expect(uri).toContain('/user/codex-cloud/memories/shared/personal/');
      expect(parsed((await f.run(['start', '--json'], second)).stdout).status).toBe('ok');
      expect(
        (
          await f.run(
            ['recall', '--cwd', process.cwd(), '--query', 'Cloud persistence contract marker', '--project', 'fixture'],
            second,
          )
        ).stdout,
      ).toContain(uri.replace('threadnote://user/codex-cloud/', ''));
      expect((await f.run(['read', '--uri', uri], second)).stdout).toContain('Cloud persistence contract marker');
      const handoff = parsed(
        (
          await f.run([
            'remember',
            '--kind',
            'handoff',
            '--project',
            'fixture',
            '--topic',
            'local-task',
            '--text',
            'Local task handoff marker.',
            '--json',
          ])
        ).stdout,
      );
      expect((await f.run(['read', '--uri', handoff.structuredContent!.memoryUri!])).stdout).toContain(
        'Local task handoff marker',
      );
      await expect(f.run(['read', '--uri', handoff.structuredContent!.memoryUri!], second)).rejects.toBeDefined();
      const tree = await exec('git', ['--git-dir', f.remote, 'ls-tree', '-r', '--name-only', 'main']);
      expect(tree.stdout).toContain('contract.md');
      expect(tree.stdout).not.toContain('local-task');
      const seed = `${f.remote}-seed`;
      await exec('git', ['-C', seed, 'pull', '--rebase'], {env: {...process.env, ...gitIdentity}});
      const inbound = join(seed, 'durable', 'projects', 'fixture');
      await mkdir(inbound, {recursive: true});
      await writeFile(
        join(inbound, 'malformed.md'),
        ['not a memory', '  code_citation: {not-json}', '', 'malformed fixture'].join('\r'),
      );
      await exec('git', ['-C', seed, 'add', '.']);
      await exec('git', ['-C', seed, 'commit', '-m', 'Malformed inbound fixture'], {
        env: {...process.env, ...gitIdentity},
      });
      await exec('git', ['-C', seed, 'push']);
      await expect(f.run(['start', '--json'], second)).rejects.toMatchObject({
        stdout: expect.stringContaining('pending memory conflict'),
        stderr: expect.stringContaining('verification failed'),
      });
      await expect(f.bootstrap(second)).rejects.toMatchObject({
        stderr: expect.stringContaining('share conflicts --team personal'),
      });
    } finally {
      await rm(f.root, {recursive: true, force: true});
    }
  }, 90_000);

  it('enforces selected shares and replacements and surfaces rejected pushes', async () => {
    const f = await fixture();
    try {
      await f.bootstrap();
      await f.bootstrap(f.home, 'docs', f.otherRemote);
      const stored = parsed(
        (
          await f.run([
            'remember',
            '--team',
            'personal',
            '--project',
            'fixture',
            '--topic',
            'contract',
            '--text',
            'Original reviewed contract.',
            '--json',
          ])
        ).stdout,
      );
      const uri = stored.structuredContent!.memoryUri!;
      await expect(f.run(['remember', '--text', 'Ambiguous durable write.'])).rejects.toMatchObject({
        stderr: expect.stringContaining('requires team'),
      });
      await expect(
        f.run(['remember', '--team', 'docs', '--replace-uri', uri, '--text', 'Wrong share replacement.']),
      ).rejects.toMatchObject({stderr: expect.stringContaining('configured Codex Cloud share')});
      await expect(
        f.run(['remember', '--team', 'docs', '--reference', uri, '--text', 'Wrong share reference.']),
      ).rejects.toMatchObject({stderr: expect.stringContaining('selected share')});
      await expect(f.run(['read', '--uri', uri.replace('/personal/', '/unconfigured/')])).rejects.toMatchObject({
        stderr: expect.stringContaining('configured Codex Cloud share'),
      });
      await f.run([
        'remember',
        '--replace-uri',
        uri,
        '--project',
        'fixture',
        '--topic',
        'contract',
        '--text',
        'Updated reviewed contract.',
      ]);
      expect((await f.run(['read', '--uri', uri])).stdout).toContain('Updated reviewed contract');
      const selectedWorktree = JSON.parse(await readFile(join(f.home, 'share', 'teams.json'), 'utf8')).teams.personal
        .worktree;
      const selectedFile = join(selectedWorktree, 'durable', 'projects', 'fixture', 'contract.md');
      const committedContent = await readFile(selectedFile, 'utf8');
      await writeFile(selectedFile, `${committedContent}\nUncommitted local edit marker.\n`);
      await expect(
        f.run([
          'remember',
          '--replace-uri',
          uri,
          '--project',
          'fixture',
          '--topic',
          'contract',
          '--text',
          'Conflicting replacement.',
        ]),
      ).rejects.toBeDefined();
      expect(await readFile(selectedFile, 'utf8')).toContain('Uncommitted local edit marker');
      expect(
        (await exec('git', ['--git-dir', f.remote, 'show', 'main:durable/projects/fixture/contract.md'])).stdout,
      ).toContain('Updated reviewed contract');
      await writeFile(selectedFile, committedContent);
      await expect(
        f.run([
          'remember',
          '--team',
          'docs',
          '--relation',
          JSON.stringify({type: 'references', uri}),
          '--text',
          'Wrong share relation.',
        ]),
      ).rejects.toMatchObject({stderr: expect.stringContaining('authorized memory scope')});
      await expect(f.run(['read', '--uri', 'threadnote://memory/tn_outside_scope'])).rejects.toBeDefined();
      await expect(f.run(['read', '--uri', uri, '--team', 'docs'])).rejects.toMatchObject({
        stderr: expect.stringContaining('configured Codex Cloud share'),
      });
      const tree = await exec('git', ['--git-dir', f.otherRemote, 'ls-tree', '-r', '--name-only', 'main']);
      expect(tree.stdout).not.toContain('contract.md');
      const hook = join(f.remote, 'hooks', 'pre-receive');
      await writeFile(hook, '#!/bin/sh\necho "Fixture push denied" >&2\nexit 1\n');
      await chmod(hook, 0o755);
      await expect(
        f.run(['remember', '--team', 'personal', '--topic', 'rejected', '--text', 'Rejected write marker.', '--json']),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining('"isError":true'),
        stderr: expect.stringContaining('remember failed'),
      });
      await rm(f.remote, {recursive: true, force: true});
      await expect(f.run(['start', '--json'])).rejects.toBeDefined();
    } finally {
      await rm(f.root, {recursive: true, force: true});
    }
  }, 90_000);
});
