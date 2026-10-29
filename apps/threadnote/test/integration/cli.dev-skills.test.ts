import {Array as EffectArray} from 'effect';
import {access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {execFile} from '@threadnote/testing/node-child-process';
import {createHash} from '@threadnote/testing/node-crypto';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {afterEach, describe, expect, it} from 'vitest';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const exec = promisify(execFile);
const roots: string[] = [];
const entrypoint = join(process.cwd(), 'apps/threadnote/src/standalone.ts');
afterEach(async () => {
  await Promise.all(EffectArray.map(roots.splice(0), root => rm(root, {force: true, recursive: true})));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-dev-skills-cli-')));
  roots.push(root);
  const user = join(root, 'user');
  const home = join(root, 'data');
  const environment = {...process.env};
  for (const key of EffectRecord.keys(environment)) {
    if (
      Effect.pipe(key, EffectString.startsWith('THREADNOTE_')) ||
      Effect.pipe(key, EffectString.startsWith('CODEX_')) ||
      Effect.pipe(key, EffectString.startsWith('CURSOR_'))
    )
      delete environment[key];
  }
  Object.assign(environment, {
    HOME: user,
    USERPROFILE: user,
    THREADNOTE_HOME: home,
    THREADNOTE_USER: 'tester',
    THREADNOTE_AGENT_ID: 'test',
    THREADNOTE_BIN_DIR: join(root, 'bin'),
    THREADNOTE_INSTALL_ROOT: join(root, 'runtime'),
    XDG_CONFIG_HOME: join(user, '.config'),
    XDG_DATA_HOME: join(user, '.local/share'),
    XDG_STATE_HOME: join(user, '.local/state'),
    LOCALAPPDATA: join(user, 'AppData/Local'),
    APPDATA: join(user, 'AppData/Roaming'),
    NO_COLOR: '1',
    // Source-mode Bun otherwise writes its transpiler cache before Threadnote starts.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
  });
  const call = (args: readonly string[], selectedHome = home) =>
    exec(process.execPath, [entrypoint, ...args], {
      cwd: root,
      env: {...environment, THREADNOTE_HOME: selectedHome},
      maxBuffer: 4_000_000,
    });
  return {root, user, home, call, skillRoot: join(user, '.agents/skills')};
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function visit(relative: string) {
    for (const entry of await readdir(join(root, relative), {withFileTypes: true})) {
      const child = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        out[child] = 'directory';
        await visit(child);
      } else
        out[child] = createHash('sha256')
          .update(await readFile(join(root, child)))
          .digest('hex');
    }
  }
  await visit('');
  return out;
}

describe('development workflows CLI', () => {
  it('keeps full-runner reads, previews and rejected selections free of filesystem writes', async () => {
    const f = await fixture();
    const before = await snapshot(f.root);
    for (const args of [
      ['dev-skills', '--help'],
      ['dev-skills', 'list', '--json'],
      ['--home', f.home, 'dev-skills', 'status', '--agent', 'codex', '--json'],
      ['dev-skills', 'install', '--agent', 'codex', '--dry-run', '--json', '--home', f.home],
      ['dev-skills', 'remove', '--agent', 'codex', '--dry-run'],
    ]) {
      await f.call(args);
      expect(await snapshot(f.root)).toEqual(before);
    }
    for (const args of [
      ['dev-skills', 'install', '--agent', 'unknown-host'],
      ['dev-skills', 'install', '--agent', 'aider'],
      ['dev-skills', 'install', '--agent', 'codex', '--scope', 'invalid'],
      ['dev-skills', 'install', '--agent', 'codex', '--profile', 'org'],
      ['dev-skills', 'install'],
    ]) {
      await expect(f.call(args)).rejects.toMatchObject({code: 1});
      expect(await snapshot(f.root)).toEqual(before);
    }
  }, 90_000);

  it('installs complete offline workflows, repeats without mutation and retains generation payloads after removal', async () => {
    const f = await fixture();
    const installed = JSON.parse((await f.call(['dev-skills', 'install', '--agent', 'codex', '--json'])).stdout);
    expect(installed.applied).toBe(true);
    for (const name of ['dev-spec', 'dev-plan', 'dev-cycle', 'watch-pr']) {
      const content = await readFile(join(f.skillRoot, name, 'SKILL.md'), 'utf8');
      expect(content).toContain(name);
      expect(content).not.toContain('{{THREADNOTE_');
      expect(content).not.toContain(process.cwd());
    }
    const before = await snapshot(f.root);
    const repeated = JSON.parse((await f.call(['dev-skills', 'install', '--agent', 'codex', '--json'])).stdout);
    expect(repeated.applied).toBe(false);
    expect(await snapshot(f.root)).toEqual(before);
    const status = JSON.parse((await f.call(['dev-skills', 'status', '--agent', 'codex', '--json'])).stdout);
    expect(status.targets[0]).toMatchObject({installationState: 'current', enrolled: true});
    expect(status.targets[0].readiness.planning.state).toBe('blocked');
    expect(await snapshot(f.root)).toEqual(before);
    await f.call(['dev-skills', 'remove', '--agent', 'codex', '--json']);
    await expect(access(join(f.skillRoot, 'dev-plan/SKILL.md'))).rejects.toMatchObject({code: 'ENOENT'});
    const remaining = await snapshot(f.root);
    expect(
      EffectArray.some(
        EffectRecord.keys(remaining),
        path =>
          Effect.pipe(path, EffectString.includes('generations')) &&
          Effect.pipe(path, EffectString.endsWith(join('dev-plan', 'SKILL.md'))),
      ),
    ).toBe(true);
  }, 90_000);

  it('full uninstall preserves another home, edited files and old native generations', async () => {
    const f = await fixture();
    const otherHome = join(f.root, 'other-data');
    await f.call(['dev-skills', 'install', '--agent', 'codex']);
    await f.call(['dev-skills', 'install', '--agent', 'codex'], otherHome);
    const planFile = join(f.skillRoot, 'dev-plan/SKILL.md');
    const original = await readFile(planFile, 'utf8');
    await f.call(['uninstall', '--mcp', 'none', '--preserve-memories']);
    expect(await readFile(planFile, 'utf8')).toBe(original);
    await writeFile(planFile, original + '\nMy local instructions.\n');
    await mkdir(join(f.skillRoot, 'unrelated'));
    await writeFile(join(f.skillRoot, 'unrelated/SKILL.md'), 'User-owned skill\n');
    await f.call(['uninstall', '--mcp', 'none', '--preserve-memories'], otherHome);
    expect(await readFile(planFile, 'utf8')).toContain('My local instructions.');
    expect(await readFile(join(f.skillRoot, 'unrelated/SKILL.md'), 'utf8')).toBe('User-owned skill\n');
    await expect(access(join(f.skillRoot, 'dev-spec/SKILL.md'))).rejects.toMatchObject({code: 'ENOENT'});
    const status = JSON.parse((await f.call(['dev-skills', 'status', '--json'], otherHome)).stdout);
    expect(status.targets.every((target: {enrolled: boolean}) => !target.enrolled)).toBe(true);
    expect(
      EffectArray.some(
        EffectRecord.keys(await snapshot(f.root)),
        path =>
          Effect.pipe(path, EffectString.includes('generations')) &&
          Effect.pipe(path, EffectString.endsWith(join('dev-plan', 'SKILL.md'))),
      ),
    ).toBe(true);
  }, 90_000);
});
