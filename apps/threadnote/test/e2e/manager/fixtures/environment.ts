import {accessSync, constants} from '@threadnote/testing/node-fs';
import {delimiter, dirname, join, resolve} from '@threadnote/testing/node-path';
import {pathToFileURL} from '@threadnote/testing/node-url';
import {Array as EffectArray, pipe} from 'effect';
import * as EffectString from 'effect/String';

export const repositoryRoot = resolve(import.meta.dirname, '../../../../../..');
export const candidateBinary = join(
  repositoryRoot,
  'dist',
  process.platform === 'win32' ? 'threadnote.exe' : 'threadnote',
);

export function findExecutable(name: string): string {
  for (const directory of pipe(process.env.PATH ?? '', EffectString.split(delimiter))) {
    const path = join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Try the next explicitly named executable; never execute a shell profile.
    }
  }
  throw new Error(`Manager E2E requires ${name} on PATH.`);
}

export function fixtureEnvironment(root: string): NodeJS.ProcessEnv {
  const home = join(root, 'home');
  const preload = pathToFileURL(join(repositoryRoot, '.context/manager-e2e/runtime/network-preload.mjs')).href;
  return {
    PATH: EffectArray.join([join(root, 'bin'), dirname(findExecutable('git')), '/usr/bin', '/bin'], delimiter),
    ...(process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {}),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    APPDATA: join(root, 'config'),
    LOCALAPPDATA: join(root, 'cache'),
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    THREADNOTE_HOME: home,
    THREADNOTE_MANIFEST: join(root, 'manifest.json'),
    THREADNOTE_USER: 'playwright',
    THREADNOTE_ACCOUNT: 'manager-e2e',
    THREADNOTE_AGENT_ID: 'threadnote',
    THREADNOTE_MODEL_SETUP: 'off',
    THREADNOTE_AUTO_UPDATE: 'off',
    THREADNOTE_TELEMETRY: 'off',
    DO_NOT_TRACK: '1',
    NODE_ENV: 'test',
    CI: '1',
    NO_COLOR: '1',
    TZ: 'UTC',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, 'cache/bun'),
    BUN_OPTIONS: `--no-env-file --preload ${preload}`,
    THREADNOTE_E2E_ROOT: root,
    E2E_GITHUB_TOKEN: `ghp_${pipe('a', EffectString.repeat(36))}`,
    E2E_LINEAR_TOKEN: `lin_api_${pipe('b', EffectString.repeat(40))}`,
    E2E_POCKET_TOKEN: 'pk_fixture_012345678901234567890123456789',
    E2E_SUPERHUMAN_TOKEN: 'superhuman-fixture-key-0123456789',
  };
}
