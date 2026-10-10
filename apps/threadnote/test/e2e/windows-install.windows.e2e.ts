import {TestError} from '@threadnote/testing/test-error';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {delimiter, join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect, it} from 'vitest';
import {windowsCommandLauncherInvocation} from '@threadnote/testing/windows-command-launcher';

const execute = promisify(execFile);
const windowsIt = process.platform === 'win32' ? it : it.skip;
const releaseMetadataProbeTimeoutMilliseconds = 180_000;
const failureOutputLimit = 8_192;

windowsIt('PowerShell bootstrap verifies and installs the standalone Bun release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote windows bootstrap-'));
  const distribution = join(process.cwd(), 'dist');
  const packageManifest = (await Bun.file(join(process.cwd(), 'package.json')).json()) as {readonly version: string};
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const artifactName = `threadnote-windows-${architecture}.tar.gz`;
  const artifact = join(root, artifactName);
  const checksum = `${artifact}.sha256`;
  const installRoot = join(root, 'install');
  const binRoot = join(root, 'bin');
  const userHome = join(root, 'user');
  const powerShellDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
  await Promise.all([mkdir(installRoot, {recursive: true}), mkdir(binRoot, {recursive: true}), mkdir(userHome)]);

  try {
    await execute('tar.exe', ['-czf', artifact, '-C', distribution, '.']);
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(new Uint8Array(await Bun.file(artifact).arrayBuffer()));
    await writeFile(checksum, `${hasher.digest('hex')}  ${artifactName}\n`);
    const assetRequests: string[] = [];
    let transientArchiveFailures = 2;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const name = new URL(request.url).pathname.slice(1);
        if (name === 'stable-winner-releases') {
          return Response.json([
            {
              draft: false,
              immutable: true,
              prerelease: true,
              tag_name: `v${packageManifest.version}`,
            },
            {
              draft: false,
              immutable: true,
              prerelease: false,
              tag_name: 'v9.0.0',
            },
          ]);
        }
        if (name === 'releases') {
          return Response.json([
            {
              draft: false,
              immutable: true,
              prerelease: true,
              tag_name: 'v4.0.0-beta.7',
            },
            {
              draft: false,
              immutable: false,
              prerelease: true,
              tag_name: 'v4.0.0-beta.6',
            },
            {
              draft: true,
              immutable: true,
              prerelease: true,
              tag_name: 'v4.0.0-beta.5',
            },
            {
              draft: false,
              immutable: true,
              prerelease: true,
              tag_name: `v${packageManifest.version}`,
            },
            {
              draft: false,
              immutable: true,
              prerelease: false,
              tag_name: 'v4.1.1',
            },
          ]);
        }
        assetRequests.push(name);
        if (name === `selection/${artifactName}`) return new Response(Bun.file(artifact));
        if (name === `selection/${artifactName}.sha256`) return new Response(Bun.file(checksum));
        if (name === artifactName && transientArchiveFailures > 0) {
          transientArchiveFailures -= 1;
          return new Response('retry this request', {status: 503});
        }
        if (name === artifactName) return new Response(Bun.file(artifact));
        if (name === `${artifactName}.sha256`) return new Response(Bun.file(checksum));
        return new Response('not found', {status: 404});
      },
    });
    try {
      const installerArguments = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(process.cwd(), 'scripts', 'install.ps1'),
        '-Beta',
        '-NoStart',
        '-WithHooks',
      ];
      const installEnvironment = {
        ...process.env,
        DOCKER_CONFIG: join(userHome, '.docker'),
        HOME: userHome,
        LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
        PATH: [powerShellDirectory, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(delimiter),
        THREADNOTE_BIN_DIR: binRoot,
        THREADNOTE_INSTALL_ROOT: installRoot,
        THREADNOTE_HOME: join(userHome, '.threadnote'),
        THREADNOTE_RELEASE_DOWNLOAD_ROOT: `http://127.0.0.1:${server.port}`,
        THREADNOTE_RELEASE_SOURCE: `http://127.0.0.1:${server.port}/releases`,
        USERPROFILE: userHome,
      };
      const stableWinnerFailure = await execute(join(powerShellDirectory, 'powershell.exe'), installerArguments, {
        env: {
          ...installEnvironment,
          THREADNOTE_INSTALL_ROOT: join(root, 'stable-winner-install'),
          THREADNOTE_RELEASE_DOWNLOAD_ROOT: `http://127.0.0.1:${server.port}/selection`,
          THREADNOTE_RELEASE_SOURCE: `http://127.0.0.1:${server.port}/stable-winner-releases`,
        },
        timeout: releaseMetadataProbeTimeoutMilliseconds,
      }).catch((cause: unknown) => cause);
      expectInstallerFailure(stableWinnerFailure, 'stable-winner release metadata probe', {
        stderr: 'Release metadata does not match Threadnote 9.0.0',
        stdout: 'Downloading Threadnote 9.0.0',
      });
      const stableOnlyFailure = await execute(
        join(powerShellDirectory, 'powershell.exe'),
        installerArguments.filter(argument => argument !== '-Beta'),
        {
          env: {
            ...installEnvironment,
            THREADNOTE_CHANNEL: 'stable',
            THREADNOTE_INSTALL_ROOT: join(root, 'stable-only-install'),
            THREADNOTE_RELEASE_DOWNLOAD_ROOT: `http://127.0.0.1:${server.port}/selection`,
          },
          timeout: releaseMetadataProbeTimeoutMilliseconds,
        },
      ).catch((cause: unknown) => cause);
      expectInstallerFailure(stableOnlyFailure, 'stable-only release metadata probe', {
        stderr: 'Release metadata does not match Threadnote 4.1.1',
        stdout: 'Downloading Threadnote 4.1.1',
      });
      for (const rejectedVersion of ['4.0.0-beta.6', '4.0.0-beta.5', '4.0.0-beta.4']) {
        const requestsBefore = assetRequests.length;
        const failure = await execute(join(powerShellDirectory, 'powershell.exe'), installerArguments, {
          env: {...installEnvironment, THREADNOTE_VERSION: rejectedVersion},
          timeout: 60_000,
        }).catch((cause: unknown) => cause);
        expect(
          `${String((failure as {readonly stdout?: unknown}).stdout)}${String((failure as {readonly stderr?: unknown}).stderr)}`,
        ).toContain(`Threadnote ${rejectedVersion} is not a published immutable release.`);
        expect(assetRequests).toHaveLength(requestsBefore);
      }
      const exactFailure = await execute(join(powerShellDirectory, 'powershell.exe'), installerArguments, {
        env: {
          ...installEnvironment,
          THREADNOTE_RELEASE_DOWNLOAD_ROOT: `http://127.0.0.1:${server.port}/missing-assets`,
          THREADNOTE_VERSION: packageManifest.version,
        },
        timeout: 60_000,
      }).catch((cause: unknown) => cause);
      expect(
        `${String((exactFailure as {readonly stdout?: unknown}).stdout)}${String((exactFailure as {readonly stderr?: unknown}).stderr)}`,
      ).toContain(`Downloading Threadnote ${packageManifest.version}`);
      expect(assetRequests.at(-1)).toBe(`missing-assets/${artifactName}`);
      const installationLock = join(installRoot, '.installation.lock');
      await writeFile(installationLock, '');
      const staleInstallationLockDate = new Date(Date.now() - 120_000);
      await utimes(installationLock, staleInstallationLockDate, staleInstallationLockDate);
      const archiveRequestsBeforeInstall = assetRequests.filter(name => name === artifactName).length;
      const result = await execute(join(powerShellDirectory, 'powershell.exe'), installerArguments, {
        env: installEnvironment,
        timeout: 600_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(`Installed standalone Threadnote ${packageManifest.version}`);
      expect(output).toContain('Wrote command launcher');
      expect(output).toContain('Threadnote is installed');
      expect(output).not.toMatch(/\bnpm\b|Python|OpenViking/i);
      expect(assetRequests.filter(name => name === artifactName)).toHaveLength(archiveRequestsBeforeInstall + 3);
      const installedExecutable = join(installRoot, 'versions', packageManifest.version, 'threadnote.exe');
      await expect(stat(installedExecutable)).resolves.toMatchObject({size: expect.any(Number)});
      const version = await execute(installedExecutable, ['--version']);
      expect(version.stdout).toContain(packageManifest.version);
      const launcherInvocation = windowsCommandLauncherInvocation(join(binRoot, 'threadnote.cmd'), ['--version']);
      const launcherVersion = await execute(launcherInvocation.executable, [...launcherInvocation.args], {
        windowsVerbatimArguments: true,
        env: {
          ...process.env,
          HOME: userHome,
          LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
          THREADNOTE_HOME: join(userHome, '.threadnote'),
          USERPROFILE: userHome,
        },
      });
      expect(launcherVersion.stdout).toContain(packageManifest.version);
      await expect(stat(join(binRoot, 'docker-credential-threadnote-auth0-publisher-m2m.cmd'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const posixLauncher = join(binRoot, 'threadnote');
      const posixMcpLauncher = join(binRoot, 'threadnote-mcp-server');
      const posixLauncherContent = await readFile(posixLauncher, 'utf8');
      expect(posixLauncherContent.startsWith('#!/usr/bin/env sh\n')).toBe(true);
      expect(posixLauncherContent).toContain('threadnote.exe');
      expect(posixLauncherContent).not.toContain('\r');
      expect(posixLauncherContent).not.toContain('\\');
      const posixMcpLauncherContent = await readFile(posixMcpLauncher, 'utf8');
      expect(posixMcpLauncherContent.startsWith('#!/usr/bin/env sh\n')).toBe(true);
      expect(posixMcpLauncherContent).toContain('mcp-broker');
      const gitBash = await windowsGitBashExecutable();
      if (process.env.GITHUB_ACTIONS === 'true') {
        expect(gitBash, 'Git Bash is required on Windows CI to cover issue 347').toBeDefined();
      } else if (gitBash === undefined) {
        process.stderr.write('Git Bash not found; skipping Git Bash launcher execution for issue 347.\n');
      }
      if (gitBash !== undefined) {
        const gitBashVersion = await execute(gitBash, [posixLauncher, '--version'], {
          env: {
            ...process.env,
            HOME: userHome,
            LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
            THREADNOTE_HOME: join(userHome, '.threadnote'),
            USERPROFILE: userHome,
          },
        });
        expect(gitBashVersion.stdout).toContain(packageManifest.version);
        const gitBashWhich = await execute(
          gitBash,
          ['-c', 'command -v threadnote && command -v threadnote-mcp-server'],
          {
            env: {
              ...process.env,
              HOME: userHome,
              LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
              PATH: `${binRoot}${delimiter}${process.env.PATH ?? ''}`,
              THREADNOTE_HOME: join(userHome, '.threadnote'),
              USERPROFILE: userHome,
            },
          },
        );
        const resolved = gitBashWhich.stdout
          .trim()
          .split(/\r?\n/u)
          .map(line => line.trim());
        expect(gitBashWhich.stdout).not.toContain('.cmd');
        expect(resolved[0]).toMatch(/\/threadnote$/);
        expect(resolved[1]).toMatch(/\/threadnote-mcp-server$/);
      }
      const transport = new StdioClientTransport({
        args: ['/d', '/c', join(binRoot, 'threadnote-mcp-server.cmd')],
        command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: userHome,
          LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
          THREADNOTE_HOME: join(userHome, '.threadnote'),
          USERPROFILE: userHome,
        },
      });
      const client = new Client({name: 'threadnote-windows-installer-e2e', version: packageManifest.version});
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map(tool => tool.name)).toContain('recall_context');
      } finally {
        await client.close();
      }
      expect(
        JSON.parse(await readFile(join(installRoot, 'versions', packageManifest.version, 'release.json'), 'utf8')),
      ).toMatchObject({version: packageManifest.version});
      const versionsRoot = join(installRoot, 'versions');
      const releaseRoot = join(versionsRoot, packageManifest.version);
      const promotionBackup = join(versionsRoot, `.${packageManifest.version}.promotion-backup`);
      const promotionJournal = join(versionsRoot, `.${packageManifest.version}.promotion.json`);
      const recoverySentinel = join(releaseRoot, 'promotion-recovery-sentinel.txt');
      await writeFile(recoverySentinel, 'preserve the previous release\n');
      await writeFile(
        installationLock,
        `${JSON.stringify({
          processId: 2_147_483_647,
          processStartIdentity: 'win32:stale-installer-fixture',
          token: 'stale-ts-lock',
          version: 1,
        })}\n`,
      );
      const interruptedPromotion = await execute(join(powerShellDirectory, 'powershell.exe'), installerArguments, {
        env: {
          ...installEnvironment,
          THREADNOTE_INSTALLER_FAIL_AFTER_PROMOTION_STEP: 'previous-backed-up',
        },
        timeout: 600_000,
      }).catch((cause: unknown) => cause);
      expect(
        `${String((interruptedPromotion as {readonly stdout?: unknown}).stdout)}${String(
          (interruptedPromotion as {readonly stderr?: unknown}).stderr,
        )}`,
      ).toContain('Injected installer interruption after promotion step: previous-backed-up');
      await expect(stat(releaseRoot)).rejects.toThrow();
      await expect(readFile(join(promotionBackup, 'promotion-recovery-sentinel.txt'), 'utf8')).resolves.toBe(
        'preserve the previous release\n',
      );

      const recoveredPromotion = await execute(join(powerShellDirectory, 'powershell.exe'), installerArguments, {
        env: {
          ...installEnvironment,
          THREADNOTE_INSTALLER_FAIL_AFTER_PROMOTION_STEP: 'journaled',
        },
        timeout: 600_000,
      }).catch((cause: unknown) => cause);
      expect(
        `${String((recoveredPromotion as {readonly stdout?: unknown}).stdout)}${String(
          (recoveredPromotion as {readonly stderr?: unknown}).stderr,
        )}`,
      ).toContain('Injected installer interruption after promotion step: journaled');
      await expect(readFile(recoverySentinel, 'utf8')).resolves.toBe('preserve the previous release\n');
      await expect(stat(promotionBackup)).rejects.toThrow();
      await expect(stat(promotionJournal)).resolves.toMatchObject({size: expect.any(Number)});
    } finally {
      await server.stop(true);
    }
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});

function expectInstallerFailure(
  outcome: unknown,
  scenario: string,
  expected: {readonly stderr: string; readonly stdout: string},
): void {
  const failure = outcome as {
    readonly code?: unknown;
    readonly killed?: boolean;
    readonly signal?: unknown;
    readonly stderr?: unknown;
    readonly stdout?: unknown;
  };
  const stderr = String(failure.stderr ?? '');
  const stdout = String(failure.stdout ?? '');
  const diagnostics = boundedFailureOutput(
    `code: ${String(failure.code ?? 'unknown')}\nkilled: ${String(failure.killed ?? false)}\nsignal: ${String(
      failure.signal ?? 'none',
    )}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  if (!(outcome instanceof Error)) {
    throw TestError.make({message: `${scenario} unexpectedly succeeded.\n${diagnostics}`});
  }
  if (failure.killed === true) {
    throw TestError.make({
      cause: outcome,
      message: `${scenario} exceeded the ${releaseMetadataProbeTimeoutMilliseconds} ms deadline (signal ${String(
        failure.signal ?? 'unknown',
      )}).\n${diagnostics}`,
    });
  }
  expect(stdout, diagnostics).toContain(expected.stdout);
  expect(stderr, diagnostics).toContain(expected.stderr);
}

function boundedFailureOutput(output: string): string {
  return output.length <= failureOutputLimit ? output : `${output.slice(0, failureOutputLimit)}\n[output truncated]`;
}

async function windowsGitBashExecutable(): Promise<string | undefined> {
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    Bun.which('bash') ?? undefined,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      await stat(candidate);
    } catch {
      continue;
    }
    const identity = await execute(candidate, ['-c', 'uname -s'], {timeout: 10_000}).catch(() => undefined);
    if (identity !== undefined && /^(MINGW|MSYS)/u.test(identity.stdout.trim())) return candidate;
  }
  return undefined;
}
