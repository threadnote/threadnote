import {execFile} from '@threadnote/testing/node-child-process';
import {existsSync} from '@threadnote/testing/node-fs';
import {mkdir, mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {describe, expect, it} from 'vitest';

const execFilePromise = promisify(execFile);
const cliTimeoutMs = 15_000;

describe('native workflow automation CLI exit boundary', () => {
  it('returns one JSON error and a nonzero exit for malformed and unsupported input without writing native state', async () => {
    const fixture = await createFixture();
    try {
      const cases = [
        {name: 'malformed JSON', input: Buffer.from('{"protocolVersion":', 'utf8'), code: 'invalid-json'},
        {
          name: 'unsupported closed request',
          input: Buffer.from(
            JSON.stringify({
              protocolVersion: 1,
              executorVersion: 1,
              action: 'capabilities',
              unsupportedSentinel: 'must-not-leak',
            }),
          ),
          code: 'invalid-request',
        },
        {name: 'invalid UTF-8', input: Buffer.from([0xff, 0xfe]), code: 'invalid-request'},
      ];

      for (const testCase of cases) {
        const result = await runCli(fixture, testCase.input);
        expect(result.exitCode, testCase.name).not.toBe(0);
        const response = expectSingleJsonLine(result.stdout);
        expect(response).toMatchObject({status: 'error', code: testCase.code, protocolVersion: 1, executorVersion: 1});
        expect(typeof response.message).toBe('string');
        expect((response.message as string).length).toBeGreaterThan(0);
        expect((response.message as string).length).toBeLessThanOrEqual(512);
        expect(result.stdout.length).toBeLessThanOrEqual(1024);
        expect(result.stderr).toBe('');
        expect(result.stdout).not.toContain('unsupportedSentinel');
        expect(result.stdout).not.toContain('must-not-leak');
        expectNativeStateAbsent(fixture.home);
      }
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  }, 60_000);

  it('returns capabilities successfully without creating native state', async () => {
    const fixture = await createFixture();
    try {
      const result = await runCli(
        fixture,
        Buffer.from(JSON.stringify({protocolVersion: 1, executorVersion: 1, action: 'capabilities'})),
      );
      expect(result.exitCode).toBe(0);
      const response = expectSingleJsonLine(result.stdout);
      expect(response).toMatchObject({status: 'ok', protocolVersion: 1, executorVersion: 1});
      expect(response.operations).toContain('cycle');
      expect(result.stderr).toBe('');
      expectNativeStateAbsent(fixture.home);
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  }, 30_000);
});

type Fixture = {root: string; repository: string; home: string; environment: NodeJS.ProcessEnv};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-native-automation-cli-'));
  const repository = join(root, 'repository');
  const userHome = join(root, 'user-home');
  const home = join(root, 'threadnote-home');
  await Promise.all([mkdir(repository, {recursive: true}), mkdir(userHome, {recursive: true})]);
  await writeFile(join(repository, 'subject.ts'), 'export const subject = true;\n');
  await execFilePromise('git', ['init', '--quiet', '--initial-branch=main', repository], {cwd: root});

  const environment = {...process.env};
  for (const key of Object.keys(environment))
    if (/^(?:THREADNOTE_|CODEX_|CURSOR_|BUN_)/u.test(key) || /^(?:https?|all)_proxy$/iu.test(key))
      delete environment[key];
  Object.assign(environment, {
    HOME: userHome,
    USERPROFILE: userHome,
    THREADNOTE_USER: 'cli-test',
    THREADNOTE_AGENT_ID: 'test',
    THREADNOTE_HOME: home,
    XDG_CONFIG_HOME: join(userHome, '.config'),
    XDG_DATA_HOME: join(userHome, '.local', 'share'),
    XDG_STATE_HOME: join(userHome, '.local', 'state'),
    LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
    APPDATA: join(userHome, 'AppData', 'Roaming'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    NO_COLOR: '1',
  });
  return {root, repository, home, environment};
}

async function runCli(fixture: Fixture, input: Uint8Array) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'),
      'workflow-automation',
      '--home',
      fixture.home,
    ],
    {
      cwd: fixture.repository,
      env: fixture.environment,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, cliTimeoutMs);
  try {
    await child.stdin.write(input);
    await child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error(`workflow-automation CLI exceeded ${cliTimeoutMs} ms`);
    return {exitCode, stdout, stderr};
  } finally {
    clearTimeout(timeout);
  }
}

function expectSingleJsonLine(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith('\n')).toBe(true);
  const lines = stdout.trimEnd().split(/\r?\n/u);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.length).toBeLessThanOrEqual(1024);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

function expectNativeStateAbsent(home: string): void {
  expect(existsSync(join(home, 'workflow-automations', 'native-v1'))).toBe(false);
}
