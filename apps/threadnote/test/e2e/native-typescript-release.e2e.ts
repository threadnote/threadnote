import {cp, mkdir, mkdtemp, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {execFile} from '@threadnote/testing/node-child-process';
import {promisify} from '@threadnote/testing/node-util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import * as Schema from 'effect/Schema';
import * as EffectString from 'effect/String';
import * as EffectArray from 'effect/Array';
import {
  SIGNED_NATIVE_TYPESCRIPT_IDENTIFIER,
  releaseAppleTeamId,
} from '../../../../tools/ci/signed-native-typescript.js';

/**
 * Publish smoke for the final payload (macOS: after the private `tsc` is signed, its signed identity is compiled into
 * the outer executable and that executable is signed; before notarization). The packaged CLI must admit the packaged
 * compiler and build TypeScript facts through it. A refused compiler leaves TypeScript files as degraded modules
 * without resolved calls, so the path query below fails.
 */
const execute = promisify(execFile);
const root = process.cwd();
const cli = join(root, 'dist', process.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
const compiler = join(root, 'dist', 'runtime', 'typescript', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
const expectSigned = process.env.THREADNOTE_EXPECT_SIGNED_NATIVE_TYPESCRIPT === '1';
const PathResult = Schema.Struct({
  operation: Schema.String,
  edges: Schema.Array(
    Schema.Struct({relation: Schema.optionalKey(Schema.String), targetName: Schema.optionalKey(Schema.String)}),
  ),
});

let temporaryRoot = '';
let home = '';
let userHome = '';
let repository = '';
const environment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  CI: '1',
  HOME: userHome,
  USERPROFILE: userHome,
  THREADNOTE_HOME: home,
  THREADNOTE_BIN_DIR: join(temporaryRoot, 'bin'),
  THREADNOTE_INSTALL_ROOT: join(temporaryRoot, 'install'),
  THREADNOTE_USER: 'e2e-user',
});
const run = async (command: string, args: readonly string[], cwd = root) => {
  const {stdout, stderr} = await execute(command, [...args], {cwd, env: environment(), maxBuffer: 16 * 1_048_576});
  return {stdout, stderr};
};
const runCli = (args: readonly string[]) => run(cli, ['--home', home, ...args]);

describe('native TypeScript in the release payload', () => {
  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'threadnote-native-typescript-release-'));
    home = join(temporaryRoot, 'home');
    userHome = join(temporaryRoot, 'user');
    repository = join(temporaryRoot, 'repository');
    await mkdir(userHome, {recursive: true});
    await cp(
      join(root, 'apps', 'threadnote', 'test', 'evaluation', 'fixtures', 'code-graph-v1', 'repository'),
      repository,
      {
        recursive: true,
      },
    );
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.email', 'threadnote-e2e@example.com'],
      ['config', 'user.name', 'Threadnote E2E'],
      ['add', '.'],
      ['commit', '-m', 'native TypeScript release fixture'],
    ])
      await run('git', args, repository);
    await runCli(['install', '--no-start']);
  });
  afterAll(async () => {
    if (temporaryRoot) await rm(temporaryRoot, {recursive: true, force: true});
  });

  it.skipIf(!expectSigned || process.platform !== 'darwin')(
    'ships the Developer ID signed private compiler',
    async () => {
      // Publish mode: the release team's hardened runtime signature only, never an ad-hoc one.
      const {stderr} = await execute('/usr/bin/codesign', ['-dvvv', compiler]);
      expect(stderr).toContain(`Identifier=${SIGNED_NATIVE_TYPESCRIPT_IDENTIFIER}`);
      expect(stderr).toMatch(/flags=0x10000\(runtime\) /u);
      expect(stderr).not.toContain('Signature=adhoc');
      expect(stderr).toMatch(new RegExp(`^TeamIdentifier=${releaseAppleTeamId()}$`, 'mu'));
    },
  );

  it('indexes TypeScript through the packaged compiler', async () => {
    const indexed = await runCli(['graph', 'index', '--cwd', repository, '--no-vectors']);
    expect(`${indexed.stdout}${indexed.stderr}`).toContain('Code graph ready for');
    const {stdout} = await runCli([
      'graph',
      'path',
      '--cwd',
      repository,
      '--from',
      'runApplication',
      '--to',
      'withExclusiveFileLock',
      '--json',
    ]);
    const result = Schema.decodeUnknownSync(PathResult)(
      JSON.parse(EffectArray.lastNonEmpty(EffectString.split(EffectString.trim(stdout), '\n')) ?? '{}'),
    );
    expect(result.operation).toBe('path');
    expect(result.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({relation: 'calls', targetName: 'withExclusiveFileLock'})]),
    );
  });
});
