import {BunFileSystem, BunPath} from '@effect/platform-bun';
import {Effect, FileSystem, Path} from 'effect';
import {unzipSync} from 'fflate';

// This standalone CI entrypoint owns its Bun platform services.
// oxlint-disable-next-line effecttsgo/strict-effect-provide
const fileSystem = Effect.runSync(Effect.provide(FileSystem.FileSystem, BunFileSystem.layer));
// oxlint-disable-next-line effecttsgo/strict-effect-provide
const path = Effect.runSync(Effect.provide(Path.Path, BunPath.layer));

export const VERSION = '15.2.0';
// Official release assets and SHA-256 digests from
// https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0
export const ASSETS: Readonly<Record<string, {target: string; sha256: string}>> = {
  amd64: {
    target: 'x86_64-pc-windows-msvc',
    sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
  },
  arm64: {
    target: 'aarch64-pc-windows-msvc',
    sha256: 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f',
  },
};
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 30_000;
export const PROBE_TIMEOUT_MS = 10_000;

export function usable(executable: string | null, timeout = PROBE_TIMEOUT_MS): boolean {
  if (!executable) return false;
  try {
    const result = Bun.spawnSync({
      cmd: [executable, '--version'],
      stdout: 'pipe',
      stderr: 'pipe',
      timeout,
      maxBuffer: 64 * 1024,
    });
    return result.success && result.stdout.toString().startsWith('ripgrep ');
  } catch {
    return false;
  }
}

const defaults = {
  assets: ASSETS,
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxExecutableBytes: MAX_EXECUTABLE_BYTES,
  which: (path: string) => Bun.which('rg', {PATH: path}),
  probe: usable,
  fetch: (url: string, signal: AbortSignal) => fetch(url, {signal}),
};

async function boundedDownload(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Ripgrep release download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error('Ripgrep release download has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error('Ripgrep release archive failed its pinned SHA-256/size check');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

/** Admit Windows workflow tests only with a usable, verified ripgrep executable. */
export async function ensureRipgrep(
  environment: Readonly<Record<string, string | undefined>>,
  architecture: string,
  overrides: Partial<typeof defaults> = {},
): Promise<string> {
  const options = {...defaults, ...overrides};
  const existing = options.which(environment.PATH ?? '');
  if (existing && options.probe(existing, PROBE_TIMEOUT_MS)) return existing;
  // Normalize the runner architecture aliases for the pinned Windows assets.
  const normalizedArchitecture = architecture.toLowerCase() === 'x64' ? 'amd64' : architecture.toLowerCase();
  if (!Object.hasOwn(options.assets, normalizedArchitecture)) {
    throw new Error(`Unsupported Windows architecture: ${architecture}`);
  }
  const asset = options.assets[normalizedArchitecture];
  const {GITHUB_PATH: githubPath, RUNNER_TEMP: runnerTemp} = environment;
  if (!githubPath || !runnerTemp) throw new Error('GITHUB_PATH and RUNNER_TEMP are required');
  const name = `ripgrep-${VERSION}-${asset.target}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${name}.zip`;
  const payload = await boundedDownload(
    await options.fetch(url, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)),
    options.maxArchiveBytes,
  );
  if (new Bun.CryptoHasher('sha256').update(payload).digest('hex') !== asset.sha256) {
    throw new Error('Ripgrep release archive failed its pinned SHA-256/size check');
  }
  // Filter before inflation; never extract arbitrary archive paths or other files.
  const memberName = `${name}/rg.exe`;
  let expectedSize = 0;
  const members = unzipSync(payload, {
    filter: member => {
      if (member.name !== memberName) return false;
      if (expectedSize || member.originalSize <= 0 || member.originalSize > options.maxExecutableBytes) {
        throw new Error('Ripgrep executable exceeds its size bound or is duplicated');
      }
      expectedSize = member.originalSize;
      return true;
    },
  });
  const executableBytes = members[memberName];
  if (!executableBytes || executableBytes.byteLength !== expectedSize) {
    throw new Error('Ripgrep archive lacks the exact executable member or has an invalid size');
  }
  const directory = await Effect.runPromise(
    fileSystem.makeTempDirectory({directory: runnerTemp, prefix: 'threadnote-ripgrep-'}),
  );
  try {
    const executable = path.join(directory, 'rg.exe');
    await Effect.runPromise(fileSystem.writeFile(executable, executableBytes));
    if (!options.probe(executable, PROBE_TIMEOUT_MS)) throw new Error('Pinned ripgrep executable failed --version');
    // Publish only after checksum, archive and actual execution verification.
    const exists = await Effect.runPromise(fileSystem.exists(githubPath));
    const separator = !exists || (await Effect.runPromise(fileSystem.readFile(githubPath))).at(-1) === 10 ? '' : '\n';
    await Effect.runPromise(fileSystem.writeFileString(githubPath, `${separator}${directory}\n`, {flag: 'a'}));
    return executable;
  } catch (error) {
    await Effect.runPromise(fileSystem.remove(directory, {recursive: true, force: true}));
    throw error;
  }
}

if (import.meta.main) {
  try {
    if (process.platform !== 'win32') throw new Error('This prerequisite is only for Windows runners');
    const executable = await ensureRipgrep(process.env, process.arch);
    await Bun.write(Bun.stdout, `Using verified ripgrep: ${executable}\n`);
  } catch (error) {
    await Bun.write(Bun.stderr, `Windows workflow prerequisite failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
