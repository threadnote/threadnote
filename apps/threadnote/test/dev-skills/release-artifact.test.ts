import {spawn, spawnSync} from '@threadnote/testing/node-child-process';
import {resolve} from '@threadnote/testing/node-path';
import {mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {expect, it} from 'vitest';
import fc from 'fast-check';

// This OS/compiled CLI boundary exercises the extracted native release.
// The literal directory declares the copied fixture/helper closure to Bazel.
const nativeFixtures = ['native-release-workflows.py', 'release-tools-fixture.ts'];
const archive = process.env.THREADNOTE_RELEASE_ARCHIVE;
it.skipIf(!archive)(
  'runs extracted native workflows without external interpreters or source access',
  async () => {
    if (!archive) throw new Error('Missing release archive.');
    const temporary = await mkdtemp(resolve(tmpdir(), 'threadnote-release-tools-'));
    try {
      const tools = resolve(temporary, process.platform === 'win32' ? 'fixture-tools.exe' : 'fixture-tools');
      const build = await Bun.build({
        entrypoints: [resolve('apps/threadnote/test/dev-skills/release-tools-fixture.ts')],
        compile: {outfile: tools},
      });
      expect(build.success, JSON.stringify(build.logs)).toBe(true);
      const python = process.env.THREADNOTE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
      const result = spawnSync(
        python,
        [
          '-B',
          resolve('apps/threadnote/test/dev-skills/release-artifact.py'),
          '--archive',
          resolve(archive),
          '--checkout',
          process.cwd(),
          '--report',
          resolve(process.env.THREADNOTE_RELEASE_REPORT ?? '.context/release-artifact/result.json'),
          '--tools',
          tools,
          ...(process.platform === 'win32' ? ['--functional-only'] : []),
        ],
        {encoding: 'utf8', timeout: 1_850_000},
      );
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}\nFixtures: ${nativeFixtures.join(', ')}`).toBe(0);
    } finally {
      await rm(temporary, {recursive: true, force: true});
    }
  },
  1_860_000,
);

it('forwards complete real Git bytes through the compiled fixture to a delayed consumer', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'threadnote-release-pipe-'));
  try {
    const nativeGit = Bun.which('git');
    if (!nativeGit) throw new Error('Git is required for the compiled fixture boundary.');
    const proxy = resolve(temporary, process.platform === 'win32' ? 'git.exe' : 'git');
    const repo = resolve(temporary, 'objects.git');
    const build = await Bun.build({
      entrypoints: [resolve('apps/threadnote/test/dev-skills/release-tools-fixture.ts')],
      compile: {outfile: proxy},
    });
    expect(build.success, JSON.stringify(build.logs)).toBe(true);
    await writeFile(resolve(temporary, 'tool-paths.json'), JSON.stringify({git: nativeGit}));
    expect(spawnSync(nativeGit, ['init', '--bare', repo], {timeout: 15_000}).status).toBe(0);
    const delayed = async (args: readonly string[]) => {
      const child = spawn(proxy, [...args], {
        env: {...process.env, THREADNOTE_RELEASE_FIXTURE_ROOT: temporary},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      const timer = setTimeout(() => child.kill(), 15_000);
      const completed = new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({code, signal}));
      });
      // Hold both OS pipes unread long enough to force backpressure above their capacity.
      child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
      child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
      child.stdout.pause();
      child.stderr.pause();
      try {
        await new Promise(resolve => setTimeout(resolve, 150));
        child.stdout.resume();
        child.stderr.resume();
        const exit = await completed;
        expect(exit.signal).toBeNull();
        return {...exit, stdout: Buffer.concat(output), stderr: Buffer.concat(errors)};
      } finally {
        clearTimeout(timer);
        child.kill();
      }
    };
    const diagnostic = (result: Awaited<ReturnType<typeof delayed>>) =>
      JSON.stringify({
        code: result.code,
        signal: result.signal,
        stdoutBytes: result.stdout.length,
        stderr: result.stderr.toString('utf8').slice(-4000),
      });
    const repositoryArgs = ['-C', repo, 'rev-parse', '--is-bare-repository'];
    const repository = await delayed(repositoryArgs);
    const piped = spawnSync(proxy, repositoryArgs, {
      env: {...process.env, THREADNOTE_RELEASE_FIXTURE_ROOT: temporary},
      input: '',
      encoding: 'utf8',
      timeout: 15_000,
    });
    const repositoryDiagnostic = JSON.stringify({
      ignoredStdin: diagnostic(repository),
      pipeStdin: {
        code: piped.status,
        error: piped.error?.message,
        stdout: piped.stdout?.slice(-100),
        stderr: piped.stderr?.slice(-4000),
      },
    });
    expect(repository.code, repositoryDiagnostic).toBe(0);
    expect(repository.stdout.toString('utf8').trim(), repositoryDiagnostic).toBe('true');
    expect(repository.stderr.length, repositoryDiagnostic).toBe(0);
    expect(piped.error, repositoryDiagnostic).toBeUndefined();
    expect(piped.status, repositoryDiagnostic).toBe(0);
    expect(piped.stdout.trim(), repositoryDiagnostic).toBe('true');
    expect(piped.stderr.length, repositoryDiagnostic).toBe(0);
    const empty = await delayed(['-C', repo, 'config', 'fixture.empty-output', 'true']);
    expect(empty.code, diagnostic(empty)).toBe(0);
    expect(empty.stdout.length, diagnostic(empty)).toBe(0);
    expect(empty.stderr.length, diagnostic(empty)).toBe(0);
    // Bounded property: arbitrary large byte lengths retain every binary byte and UTF-8 tail.
    await fc.assert(
      fc.asyncProperty(fc.integer({min: 1_048_576, max: 4_194_304}), async size => {
        const payload = Buffer.alloc(size);
        for (let index = 0; index < size; index++) payload[index] = index % 256;
        Buffer.from('final bytes — 日本語 🌊\n').copy(payload, size - 64);
        const stored = spawnSync(nativeGit, ['-C', repo, 'hash-object', '-w', '--stdin'], {
          input: payload,
          encoding: 'utf8',
          timeout: 15_000,
        });
        expect(stored.status).toBe(0);
        const result = await delayed(['-C', repo, 'cat-file', 'blob', stored.stdout.trim()]);
        expect(result.code, diagnostic(result)).toBe(0);
        expect(result.stderr.length).toBe(0);
        expect(result.stdout.length).toBe(payload.length);
        expect(result.stdout.subarray(-64).equals(payload.subarray(-64))).toBe(true);
        expect(result.stdout.equals(payload)).toBe(true);
      }),
      {numRuns: 3, endOnFailure: true},
    );
    const args = ['-C', repo, 'cat-file', 'blob', '0'.repeat(40)];
    const expected = spawnSync(nativeGit, args, {timeout: 15_000});
    expect(expected.status).not.toBe(0);
    const failure = await delayed(args);
    expect(failure.code, diagnostic(failure)).toBe(expected.status);
    expect(failure.stdout.equals(expected.stdout)).toBe(true);
    expect(failure.stderr.equals(expected.stderr)).toBe(true);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}, 60_000);
