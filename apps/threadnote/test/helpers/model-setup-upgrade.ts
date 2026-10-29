import {Array as EffectArray} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {createHash} from '@threadnote/testing/node-crypto';
import {lstat, readFile, readdir, readlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const executeUpgradeCommand = promisify(execFile);
export const PREDECESSOR_VERSION = '5.3.0-beta.4';
export const PREDECESSOR_ARCHIVE_SHA256 = '161ad1b05d6b5996a45b5cae80b5cd36beea95f87a4535b61734949a56dbddfe';
export const PREDECESSOR_EXECUTABLE_SHA256 = '9096d53c33c21cd333917fa44093b1481b39273ccf97040f815dd8a293e21cb1';
export const UPGRADE_ACKNOWLEDGEMENT = 'ephemeral-macos-real-predecessor';
export const LOOPBACK_ONLY_POLICY = `(version 1)
(allow default)
(deny network-outbound (require-not (remote ip "localhost:*")))
`;

/** This opt-in lane deliberately permits legacy repair to use the disposable runner's real OS home. */
export function upgradeQualificationAllowed(environment: NodeJS.ProcessEnv, platform: string, architecture: string) {
  return (
    environment.THREADNOTE_QUALIFY_OLD_UPGRADE === UPGRADE_ACKNOWLEDGEMENT &&
    environment.GITHUB_ACTIONS === 'true' &&
    environment.RUNNER_ENVIRONMENT === 'github-hosted' &&
    environment.RUNNER_OS === 'macOS' &&
    environment.RUNNER_ARCH === 'ARM64' &&
    platform === 'darwin' &&
    architecture === 'arm64'
  );
}

export function upgradeEnvironment(run: string): NodeJS.ProcessEnv {
  // No CI/test/cloud exclusions, credentials, THREADNOTE_HOME, or HOME/CODEX_HOME redirection.
  const inherited = EffectRecord.fromEntries(
    EffectArray.flatMap(['HOME', 'CODEX_HOME', 'PATH', 'USER', 'LOGNAME', 'LANG'], key =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  return {
    ...inherited,
    TMPDIR: join(run, 'tmp'),
    THREADNOTE_INSTALL_ROOT: join(run, 'installation'),
    THREADNOTE_BIN_DIR: join(run, 'bin'),
    DOCKER_CONFIG: join(run, 'docker'),
    THREADNOTE_TELEMETRY: 'off',
    THREADNOTE_NO_UPDATE_CHECK: '1',
  };
}

export const bytesSha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export function requiredUpgradeEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw TestError.make({message: `Missing required upgrade qualification input: ${name}`});
  return value;
}

export async function optionalUpgradeFile(file: string) {
  return readFile(file, 'utf8').catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return undefined;
    throw cause;
  });
}

export async function recordUpgradeAttempt(file: string, attempt: () => Promise<Record<string, unknown>>) {
  await writeFile(file, JSON.stringify({status: 'running'}), {mode: 0o600});
  try {
    const evidence = await attempt();
    await writeFile(file, JSON.stringify({status: 'passed', ...evidence}, null, 2), {mode: 0o600});
  } catch (cause) {
    await writeFile(
      file,
      JSON.stringify(
        {
          status: 'failed',
          error: Effect.pipe(String(cause), EffectString.slice(0, 2048)),
        },
        null,
        2,
      ),
      {mode: 0o600},
    );
    throw cause;
  }
}

/** Content fingerprints include symlink targets without following them or reading unrelated runner files. */
export async function upgradeHomeSnapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const names = await readdir(join(root, prefix)).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  });
  const result: Record<string, string> = {};
  for (const name of names.sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const file = join(root, relative);
    const info = await lstat(file);
    if (info.isSymbolicLink()) result[relative] = `symlink:${await readlink(file)}`;
    else if (info.isDirectory()) Object.assign(result, await upgradeHomeSnapshot(root, relative));
    else if (info.isFile()) result[relative] = bytesSha256(await readFile(file));
  }
  return result;
}

/** Same two-asset GitHub response shape as installer E2E; immutable is synthetic parser metadata only. */
export function serveUpgradeCandidate(archive: string, checksum: string, version: string) {
  const artifact = 'threadnote-darwin-arm64.tar.gz';
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === '/releases') {
        return Response.json([
          {
            assets: EffectArray.map([artifact, `${artifact}.sha256`], name => ({
              name,
              browser_download_url: `${url.origin}/${name}`,
            })),
            draft: false,
            immutable: true,
            prerelease: Effect.pipe(version, EffectString.includes('-')),
            tag_name: `v${version}`,
          },
        ]);
      }
      if (url.pathname === `/${artifact}`) return new Response(Bun.file(archive));
      if (url.pathname === `/${artifact}.sha256`) return new Response(checksum);
      return new Response('not found', {status: 404});
    },
  });
  return {source: `http://127.0.0.1:${server.port}/releases`, requests, close: () => server.stop(true)};
}

/** Bounded supplementary observations; the pinned updater's synchronous exit is the completion oracle. */
export async function observeUpgradeProcesses(releaseRoot: string) {
  const observed = new Set<string>();
  let pending = Promise.resolve();
  let sampling = false;
  let failure: unknown;
  const sample = async () => {
    const {stdout} = await executeUpgradeCommand('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command=']);
    for (const line of Effect.pipe(stdout, EffectString.split('\n'))) {
      if (Effect.pipe(line, EffectString.includes(`${releaseRoot}/`)) && observed.size < 256)
        observed.add(Effect.pipe(line, EffectString.trim, EffectString.slice(0, 2048)));
    }
  };
  await sample();
  const timer = setInterval(() => {
    if (sampling || failure) return;
    sampling = true;
    pending = sample()
      .catch(cause => {
        failure = cause;
      })
      .finally(() => {
        sampling = false;
      });
  }, 25);
  return async () => {
    clearInterval(timer);
    await pending;
    if (failure) throw TestError.make({message: 'Upgrade process observation failed.', cause: failure});
    return [...observed];
  };
}
