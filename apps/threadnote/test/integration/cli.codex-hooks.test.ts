import {Array as EffectArray, Predicate} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {expect, it} from 'vitest';

const execute = promisify(execFile);
const entry = join(process.cwd(), 'apps/threadnote/src/standalone.ts');

it('installs, refreshes, and removes only the managed Codex UserPromptSubmit hook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-codex-hooks-cli-'));
  const userHome = join(root, 'user-home');
  const hooksPath = join(userHome, '.codex', 'hooks.json');
  const original = {
    owner: 'caller',
    hooks: {Stop: [{hooks: [{type: 'command', command: 'caller-stop', timeout: 9}]}]},
  };
  const environment = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    THREADNOTE_HOME: join(root, 'threadnote-home'),
    THREADNOTE_AUTO_UPDATE: '0',
    NO_COLOR: '1',
  };
  try {
    await mkdir(join(userHome, '.codex'), {recursive: true});
    await writeFile(hooksPath, `${JSON.stringify(original, undefined, 2)}\n`, {mode: 0o600});
    const run = (args: readonly string[]) =>
      execute(process.execPath, [entry, ...args], {cwd: root, env: environment, timeout: 20_000});

    await run(['install-hooks', 'codex', '--apply']);
    const parsedInstalled: unknown = JSON.parse(await readFile(hooksPath, 'utf8'));
    if (!Predicate.isObject(parsedInstalled) || !Predicate.isObject(parsedInstalled.hooks))
      throw new Error('Installed Codex hooks configuration must contain a hooks object.');
    const installedHooks = parsedInstalled.hooks;
    const userPromptSubmit = installedHooks.UserPromptSubmit;
    if (!EffectArray.isArray(userPromptSubmit)) throw new Error('Installed UserPromptSubmit hooks must be an array.');
    expect(parsedInstalled.owner).toBe('caller');
    expect(installedHooks.Stop).toEqual(original.hooks.Stop);
    expect(userPromptSubmit).toEqual([
      {
        hooks: [
          {
            type: 'command',
            command: 'threadnote codex-resume-hook',
            timeout: 15,
            statusMessage: 'Loading Threadnote continuation context',
          },
        ],
      },
    ]);
    expect((await stat(hooksPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(userHome, '.codex'))).toEqual(['hooks.json']);

    const once = await readFile(hooksPath, 'utf8');
    await run(['install-hooks', 'codex', '--apply']);
    expect(await readFile(hooksPath, 'utf8')).toBe(once);

    await run(['install-hooks', 'codex', '--remove', '--apply']);
    expect(JSON.parse(await readFile(hooksPath, 'utf8'))).toEqual(original);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}, 45_000);

it.skipIf(process.platform === 'win32')(
  'refuses to replace a symbolic-link Codex hooks config',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-codex-hooks-symlink-'));
    const userHome = join(root, 'user-home');
    const codexHome = join(userHome, '.codex');
    const hooksPath = join(codexHome, 'hooks.json');
    const target = join(root, 'caller-owned.json');
    const original = '{"owner":"caller"}\n';
    const environment = {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      THREADNOTE_HOME: join(root, 'threadnote-home'),
      THREADNOTE_AUTO_UPDATE: '0',
      NO_COLOR: '1',
    };
    try {
      await mkdir(codexHome, {recursive: true});
      await writeFile(target, original, {mode: 0o600});
      await symlink(target, hooksPath);

      await expect(
        execute(process.execPath, [entry, 'install-hooks', 'codex', '--apply'], {
          cwd: root,
          env: environment,
          timeout: 20_000,
        }),
      ).rejects.toMatchObject({stderr: expect.stringContaining('symbolic link')});
      expect(await readFile(target, 'utf8')).toBe(original);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  },
  45_000,
);
