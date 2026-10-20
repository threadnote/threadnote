import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readdir, rm, stat} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const execute = promisify(execFile);
const checkout = process.cwd();
const compiled = join(checkout, 'dist', process.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'threadnote-model-setup-e2e-'));
});
afterEach(async () => {
  await rm(root, {recursive: true, force: true});
});

const variants = [
  {name: 'source', command: process.execPath, prefix: [join(checkout, 'apps/threadnote/src/standalone.ts')]},
  {name: 'packaged', command: compiled, prefix: []},
];

describe.each(variants)('$name model setup boundaries', variant => {
  it('keeps an early queued request from recreating an erased home before any bootstrap', async () => {
    const home = join(root, 'data');
    const poison = join(root, 'environment-home');
    await mkdir(home);
    const info = await stat(home, {bigint: true});
    const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
    await rm(home, {recursive: true});
    const environment = {...process.env};
    for (const key of [
      'CI',
      'VITEST',
      'NODE_ENV',
      'THREADNOTE_TOOLSET',
      'THREADNOTE_MCP_TOOLSET',
      'THREADNOTE_MODEL_SETUP',
    ])
      delete environment[key];
    await execute(variant.command, [...variant.prefix, 'model-setup-request', '--home', home, '--identity', identity], {
      cwd: root,
      env: {...environment, THREADNOTE_HOME: poison, THREADNOTE_INSTALL_ROOT: join(root, 'installation')},
      timeout: 15_000,
    });
    expect((await readdir(root)).sort()).toEqual([]);
  });

  it('defers implicit work for an unmanaged executable without active installation authority', async () => {
    const home = join(root, 'data');
    await mkdir(home);
    const info = await stat(home, {bigint: true});
    const environment = {...process.env};
    for (const key of [
      'CI',
      'VITEST',
      'NODE_ENV',
      'THREADNOTE_TOOLSET',
      'THREADNOTE_MCP_TOOLSET',
      'THREADNOTE_MODEL_SETUP',
    ])
      delete environment[key];
    await execute(
      variant.command,
      [
        ...variant.prefix,
        'model-setup-request',
        '--home',
        home,
        '--identity',
        `${info.dev}:${info.ino}:${info.birthtimeNs}`,
      ],
      {
        cwd: root,
        env: {
          ...environment,
          THREADNOTE_HOME: join(root, 'wrong-home'),
          THREADNOTE_INSTALL_ROOT: join(root, 'installation'),
        },
        timeout: 15_000,
      },
    );
    expect(await readdir(home)).toEqual([]);
    expect((await readdir(root)).sort()).toEqual(['data']);
  });

  it.each(['CI', 'THREADNOTE_MODEL_SETUP'])('preserves %s exclusion in a valid home-bound child', async exclusion => {
    const home = join(root, 'data');
    await mkdir(home);
    const info = await stat(home, {bigint: true});
    await execute(
      variant.command,
      [
        ...variant.prefix,
        'model-setup-request',
        '--home',
        home,
        '--identity',
        `${info.dev}:${info.ino}:${info.birthtimeNs}`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          [exclusion]: exclusion === 'CI' ? '1' : 'off',
          THREADNOTE_HOME: join(root, 'wrong-home'),
          THREADNOTE_INSTALL_ROOT: join(root, 'installation'),
        },
        timeout: 15_000,
      },
    );
    expect(await readdir(home)).toEqual([]);
    expect((await readdir(root)).sort()).toEqual(['data']);
  });

  it('keeps public status and dry-run read-only for an absent explicitly selected home', async () => {
    const home = join(root, 'absent');
    for (const flags of [['--status', '--json'], ['--dry-run']]) {
      const result = await execute(variant.command, [...variant.prefix, 'models', 'setup', '--home', home, ...flags], {
        cwd: root,
        env: {
          ...process.env,
          THREADNOTE_HOME: join(root, 'wrong-home'),
          THREADNOTE_INSTALL_ROOT: join(root, 'installation'),
        },
        timeout: 15_000,
      });
      if (flags.includes('--json'))
        expect(JSON.parse(result.stdout)).toMatchObject({phase: 'not-requested', artifactReady: false});
    }
    expect(await readdir(root)).toEqual([]);
  });
});
