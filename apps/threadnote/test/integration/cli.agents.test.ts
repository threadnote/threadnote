import {access, mkdir, mkdtemp, readFile, realpath, rm} from '@threadnote/testing/node-fs-promises';
import {execFile} from '@threadnote/testing/node-child-process';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {afterEach, describe, expect, it} from 'vitest';

const execFilePromise = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {force: true, recursive: true})));
});

describe('agents CLI', () => {
  it('installs project surfaces and repairs/removes using the receipt from another cwd', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-agents-project-')));
    temporaryDirectories.push(root);
    const user = join(root, 'user');
    const project = join(root, 'project');
    const elsewhere = join(root, 'elsewhere');
    await Promise.all([mkdir(project), mkdir(elsewhere)]);
    const environment = {
      HOME: user,
      USERPROFILE: user,
      THREADNOTE_HOME: join(user, '.threadnote'),
      THREADNOTE_BIN_DIR: join(root, 'bin'),
      THREADNOTE_INSTALL_ROOT: join(root, 'install'),
    };
    const settings = join(project, '.roo', 'mcp.json');
    const preview = await runCli(['agents', 'install', 'roo', '--scope', 'project'], environment, project);
    expect(preview.stdout).toContain(settings);
    await expect(access(settings)).rejects.toMatchObject({code: 'ENOENT'});
    await runCli(['agents', 'install', 'roo', '--scope', 'project', '--apply'], environment, project);
    const registry = JSON.parse(await readFile(join(user, '.threadnote', 'integrations', 'agents.json'), 'utf8'));
    expect(registry.surfaces['roo-project']).toMatchObject({
      scope: 'project',
      cwd: project,
      root: join(project, '.roo'),
      mcp: {path: settings},
    });
    const instructions = join(project, '.roo', 'rules', 'threadnote.md');
    await rm(instructions);
    await runCli(['agents', 'repair', 'roo', '--apply'], environment, elsewhere);
    await access(instructions);
    await expect(access(join(elsewhere, '.roo'))).rejects.toMatchObject({code: 'ENOENT'});
    await runCli(['agents', 'remove', 'roo', '--apply'], environment, elsewhere);
    await expect(access(settings)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('registers the command grammar and preserves preview/apply boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-agents-cli-'));
    temporaryDirectories.push(root);
    const user = join(root, 'user');
    const environment = {
      HOME: user,
      USERPROFILE: user,
      XDG_CONFIG_HOME: join(root, 'config'),
      THREADNOTE_HOME: join(user, '.threadnote'),
      THREADNOTE_BIN_DIR: join(root, 'bin'),
      THREADNOTE_INSTALL_ROOT: join(root, 'install'),
    };
    const settings = join(user, '.gemini', 'settings.json');

    const help = await runCli(['agents', '--help'], environment);
    expect(help.stdout).toContain('install');
    expect(help.stdout).toContain('repair');
    expect(help.stdout).toContain('remove');

    const catalog = JSON.parse((await runCli(['agents', 'list', '--json'], environment)).stdout) as {
      readonly agents: readonly {
        readonly id: string;
        readonly projectGuidance: {readonly status: string; readonly targetPath?: string};
      }[];
      readonly version: number;
    };
    expect(catalog.version).toBe(1);
    expect(catalog.agents).toHaveLength(28);
    expect(catalog.agents.find(agent => agent.id === 'codex-cloud')?.projectGuidance.status).toBe('unsupported');
    expect(catalog.agents.some(agent => agent.id === 'gemini-cli')).toBe(true);
    expect(catalog.agents.find(agent => agent.id === 'gemini-cli')?.projectGuidance).toEqual({
      status: 'managed',
      targetPath: 'GEMINI.md',
    });
    expect(catalog.agents.find(agent => agent.id === 'zed-native')?.projectGuidance.status).toBe('unsupported');
    const catalogText = (await runCli(['agents', 'list'], environment)).stdout;
    expect(catalogText).toContain('Project guidance: GEMINI.md');
    expect(catalogText).toContain('Project guidance needs first-match dynamic target selection before automation.');

    const preview = await runCli(['agents', 'install', 'gemini'], environment);
    expect(preview.stdout).toContain('Would merge mcpServers.threadnote');
    await expect(access(settings)).rejects.toMatchObject({code: 'ENOENT'});

    const applied = await runCli(['agents', 'install', 'gemini-cli', '--apply'], environment);
    expect(applied.stdout).toContain('Installed Gemini CLI');
    const installed = await readFile(settings, 'utf8');
    expect(installed).toContain('THREADNOTE_MCP_CLIENT');

    const repairPreview = await runCli(['repair', '--dry-run', '--mcp', 'all', '--no-post-update'], environment);
    expect(repairPreview.stdout).toContain('Would merge mcpServers.threadnote');
    expect(await readFile(settings, 'utf8')).toBe(installed);

    const status = JSON.parse((await runCli(['agents', 'status', '--json'], environment)).stdout) as {
      readonly agents: readonly {readonly id: string; readonly state: string}[];
    };
    expect(status.agents.find(agent => agent.id === 'gemini-cli')).toMatchObject({state: 'current'});
    expect((await runCli(['doctor', '--dry-run'], environment)).stdout).toContain('gemini-cli agent surface: current');

    await runCli(['agents', 'repair', 'gemini-cli'], environment);
    expect(await readFile(settings, 'utf8')).toBe(installed);
    await runCli(['agents', 'remove', 'gemini-cli'], environment);
    expect(await readFile(settings, 'utf8')).toBe(installed);

    await expect(runCli(['agents', 'install', 'not-an-agent'], environment)).rejects.toMatchObject({code: 1});
    await expect(runCli(['agents', 'install', 'aider'], environment)).rejects.toMatchObject({code: 1});
    await expect(runCli(['agents', 'remove', 'codex-cli'], environment)).rejects.toMatchObject({code: 1});

    await runCli(['agents', 'remove', 'gemini-cli', '--apply'], environment);
    await expect(access(settings)).rejects.toMatchObject({code: 'ENOENT'});

    await runCli(['agents', 'install', 'gemini-cli', '--apply'], environment);
    await expect(
      runCli(['uninstall', '--dry-run', '--mcp', 'none', '--preserve-memories'], environment),
    ).rejects.toMatchObject({code: 1});
    const uninstallPreview = await runCli(['uninstall', '--dry-run', '--preserve-memories'], environment);
    expect(uninstallPreview.stdout).toContain(`Would remove owned MCP entry from ${settings}`);
    expect(await readFile(settings, 'utf8')).toContain('THREADNOTE_MCP_CLIENT');
    await runCli(['uninstall', '--preserve-memories'], environment);
    await expect(access(settings)).rejects.toMatchObject({code: 'ENOENT'});
  });
});

function runCli(args: readonly string[], environment: NodeJS.ProcessEnv, cwd?: string) {
  return execFilePromise(
    process.execPath,
    [join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), ...args],
    {
      env: {...process.env, ...environment, NO_COLOR: '1'},
      cwd,
    },
  );
}
