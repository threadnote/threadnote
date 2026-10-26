import {createHash} from '@threadnote/testing/node-crypto';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {zipSync} from 'fflate';
import fc from 'fast-check';
import {afterEach, expect, it, vi} from 'vitest';
import {
  ASSETS,
  DOWNLOAD_TIMEOUT_MS,
  ensureRipgrep,
  MAX_ARCHIVE_BYTES,
  MAX_EXECUTABLE_BYTES,
  PROBE_TIMEOUT_MS,
  usable,
  VERSION,
} from '../windows-workflow-prerequisites.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

function fixture(initialPath = 'previous-directory\n') {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-prerequisite-test-'));
  roots.push(root);
  const githubPath = join(root, 'github-path');
  writeFileSync(githubPath, initialPath);
  const environment = {PATH: 'original-path', RUNNER_TEMP: root, GITHUB_PATH: githubPath};
  return {root, githubPath, environment};
}

const executableBytes = Buffer.from('synthetic executable');
const memberName = (target = ASSETS.amd64.target) => `ripgrep-${VERSION}-${target}/rg.exe`;
const archive = (name = memberName(), bytes = executableBytes) => zipSync({[name]: bytes});
const sha256 = (payload: Uint8Array) => createHash('sha256').update(payload).digest('hex');

function dependencies(payload = archive(), target = ASSETS.amd64.target) {
  return {
    assets: {amd64: {target, sha256: sha256(payload)}, arm64: {target, sha256: sha256(payload)}},
    which: vi.fn((): string | null => null),
    probe: vi.fn((_executable: string | null, _timeout = PROBE_TIMEOUT_MS) => true),
    fetch: vi.fn(async (_url: string, _signal: AbortSignal) => new Response(payload)),
  };
}

function expectUnchanged(test: ReturnType<typeof fixture>) {
  expect(readFileSync(test.githubPath, 'utf8')).toBe('previous-directory\n');
  expect(readdirSync(test.root)).toEqual(['github-path']);
}

it('retains the official architecture pins, byte bounds and deadlines', () => {
  expect(ASSETS).toEqual({
    amd64: {
      target: 'x86_64-pc-windows-msvc',
      sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
    },
    arm64: {
      target: 'aarch64-pc-windows-msvc',
      sha256: 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f',
    },
  });
  expect([MAX_ARCHIVE_BYTES, MAX_EXECUTABLE_BYTES, DOWNLOAD_TIMEOUT_MS, PROBE_TIMEOUT_MS]).toEqual([
    8 * 1024 * 1024,
    16 * 1024 * 1024,
    30_000,
    10_000,
  ]);
});

it('keeps a working runner tool without download or environment mutation', async () => {
  const test = fixture();
  const before = {...test.environment};
  const options = dependencies();
  options.which.mockReturnValue('runner-rg');
  expect(await ensureRipgrep(test.environment, 'AMD64', options)).toBe('runner-rg');
  expect(options.which).toHaveBeenCalledWith('original-path');
  expect(options.probe).toHaveBeenCalledWith('runner-rg', 10_000);
  expect(options.fetch).not.toHaveBeenCalled();
  expect(test.environment).toEqual(before);
  expectUnchanged(test);
});

it.each(['AMD64', 'x64', 'ARM64'])(
  'replaces a missing or broken tool with the verified %s executable before publication',
  async architecture => {
    const target = architecture === 'ARM64' ? ASSETS.arm64.target : ASSETS.amd64.target;
    for (const initial of [null, 'broken-rg']) {
      const test = fixture();
      const before = {...test.environment};
      const payload = archive(memberName(target));
      const options = dependencies(payload, target);
      options.which.mockReturnValue(initial);
      options.probe.mockImplementation((...arguments_: unknown[]) => {
        expect(readFileSync(test.githubPath, 'utf8')).toBe('previous-directory\n');
        return arguments_[0] !== 'broken-rg';
      });
      const executable = await ensureRipgrep(test.environment, architecture, options);
      expect(readFileSync(executable)).toEqual(executableBytes);
      expect(readFileSync(test.githubPath, 'utf8')).toBe(`previous-directory\n${dirname(executable)}\n`);
      expect(test.environment).toEqual(before);
      expect(options.fetch).toHaveBeenCalledExactlyOnceWith(
        `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/ripgrep-${VERSION}-${target}.zip`,
        expect.any(AbortSignal),
      );
      expect(options.fetch.mock.calls[0][1].aborted).toBe(false);
      expect(options.probe.mock.calls.every(call => call[1] === 10_000)).toBe(true);
    }
  },
);

it.each(['', 'previous-directory', 'previous-directory\n'])('appends one path line after %j', async initial => {
  const test = fixture(initial);
  const executable = await ensureRipgrep(test.environment, 'x64', dependencies());
  const prefix = initial.endsWith('\n') || initial === '' ? initial : `${initial}\n`;
  // Empty files receive a blank separator consistently with the original helper.
  expect(readFileSync(test.githubPath, 'utf8')).toBe(`${initial === '' ? '\n' : prefix}${dirname(executable)}\n`);
});

it.each(['transport', 'HTTP', 'stream', 'unsupported'])('fails closed for %s failures', async failure => {
  const test = fixture();
  const options = dependencies();
  if (failure === 'transport') options.fetch.mockRejectedValue(new Error('network unavailable'));
  if (failure === 'HTTP') options.fetch.mockResolvedValue(new Response(null, {status: 504}));
  if (failure === 'stream') {
    options.fetch.mockResolvedValue(
      new Response(new ReadableStream({start: controller => controller.error(new Error('stream failed'))})),
    );
  }
  await expect(
    ensureRipgrep(test.environment, failure === 'unsupported' ? 'unsupported' : 'x64', options),
  ).rejects.toThrow();
  if (failure === 'unsupported') expect(options.fetch).not.toHaveBeenCalled();
  expect(options.probe).not.toHaveBeenCalled();
  expectUnchanged(test);
});

it.each(['constructor', '__proto__', 'toString'])(
  'rejects unsupported architecture %s before download',
  async architecture => {
    const test = fixture();
    const options = dependencies();
    await expect(ensureRipgrep(test.environment, architecture, options)).rejects.toThrow('Unsupported');
    expect(options.fetch).not.toHaveBeenCalled();
    expectUnchanged(test);
  },
);

it('rejects arbitrary single-byte corruption before executing or publishing', async () => {
  const payload = archive();
  await fc.assert(
    fc.asyncProperty(
      fc.integer({min: 0, max: payload.length - 1}),
      fc.integer({min: 0, max: 7}),
      async (offset, bit) => {
        const test = fixture();
        const options = dependencies(payload);
        const corrupted = payload.slice();
        corrupted[offset] ^= 1 << bit;
        options.fetch.mockResolvedValue(new Response(corrupted));
        await expect(ensureRipgrep(test.environment, 'x64', options)).rejects.toThrow('SHA-256');
        expect(options.probe).not.toHaveBeenCalled();
        expectUnchanged(test);
      },
    ),
    {numRuns: 25},
  );
});

it.each(['../rg.exe', 'other/rg.exe'])('does not extract unexpected member %s', async name => {
  const test = fixture();
  const options = dependencies(archive(name));
  await expect(ensureRipgrep(test.environment, 'x64', options)).rejects.toThrow('exact executable');
  expect(options.probe).not.toHaveBeenCalled();
  expectUnchanged(test);
});

it('ignores unrelated archive entries, including traversal entries', async () => {
  const test = fixture();
  const payload = zipSync({[memberName()]: executableBytes, '../escaped.exe': Buffer.from('unrelated')});
  const executable = await ensureRipgrep(test.environment, 'x64', dependencies(payload));
  expect(readdirSync(dirname(executable))).toEqual(['rg.exe']);
  expect(readdirSync(test.root).sort()).toEqual(['github-path', dirname(executable).split(/[/\\]/u).at(-1)].sort());
});

it.each(['archive', 'executable', 'empty executable'])('enforces the %s byte bound before publication', async kind => {
  const test = fixture();
  const payload = kind === 'empty executable' ? archive(memberName(), Buffer.alloc(0)) : archive();
  const options = {
    ...dependencies(payload),
    maxArchiveBytes: kind === 'archive' ? payload.length - 1 : payload.length,
    maxExecutableBytes: kind === 'executable' ? executableBytes.length - 1 : MAX_EXECUTABLE_BYTES,
  };
  await expect(ensureRipgrep(test.environment, 'x64', options)).rejects.toThrow(/size bound|size check/u);
  expect(options.probe).not.toHaveBeenCalled();
  expectUnchanged(test);
});

it('cancels an oversized download without draining the stream', async () => {
  const test = fixture();
  const cancel = vi.fn();
  const options = {...dependencies(), maxArchiveBytes: 1};
  options.fetch.mockResolvedValue(
    new Response(new ReadableStream({start: controller => controller.enqueue(new Uint8Array(2)), cancel})),
  );
  await expect(ensureRipgrep(test.environment, 'x64', options)).rejects.toThrow('size check');
  expect(cancel).toHaveBeenCalledOnce();
  expectUnchanged(test);
});

it('removes an unusable pinned executable and never publishes it', async () => {
  const test = fixture();
  const options = dependencies();
  options.probe.mockReturnValue(false);
  await expect(ensureRipgrep(test.environment, 'x64', options)).rejects.toThrow('--version');
  expectUnchanged(test);
});

it('cleans its installation directory if path publication fails', async () => {
  const test = fixture();
  await expect(
    ensureRipgrep({...test.environment, GITHUB_PATH: join(test.root, 'missing', 'github-path')}, 'x64', dependencies()),
  ).rejects.toThrow();
  expectUnchanged(test);
});

it('probes actual subprocess success, output, launch failure and deadline', () => {
  const test = fixture();
  const tool = join(test.root, 'probe');
  if (process.platform === 'win32') return;
  const script = (body: string) => writeFileSync(tool, `#!/bin/sh\n${body}\n`, {mode: 0o700});
  script('printf "ripgrep 15.2.0\\n"');
  expect(usable(tool)).toBe(true);
  script('printf "ripgrep 15.2.0\\n"; exit 9');
  expect(usable(tool)).toBe(false);
  script('printf "other-tool\\n"');
  expect(usable(tool)).toBe(false);
  script('while :; do :; done');
  expect(usable(tool, 50)).toBe(false);
  expect(usable(join(test.root, 'missing'))).toBe(false);
  expect(usable(null)).toBe(false);
});
