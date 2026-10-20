import {spawn} from '@threadnote/testing/node-child-process';
import {cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir, totalmem} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {BUILTIN_MODEL_MANIFESTS, CORE_GENERATION_MODEL_ID} from '@threadnote/inference/models/builtin';
import {parseModelSetup} from '@threadnote/inference/models/setup';
import {isThreadnoteStorageLayoutReceipt, THREADNOTE_STORAGE_LAYOUT_VERSION} from '@threadnote/store/layout';
import {compareVersions} from '../../src/release/version/compare.js';
import {
  bytesSha256,
  executeUpgradeCommand as execute,
  LOOPBACK_ONLY_POLICY,
  observeUpgradeProcesses,
  optionalUpgradeFile,
  PREDECESSOR_ARCHIVE_SHA256,
  PREDECESSOR_EXECUTABLE_SHA256,
  PREDECESSOR_VERSION,
  recordUpgradeAttempt,
  requiredUpgradeEnvironment,
  serveUpgradeCandidate,
  UPGRADE_ACKNOWLEDGEMENT,
  upgradeEnvironment,
  upgradeHomeSnapshot,
  upgradeQualificationAllowed,
} from '../helpers/model-setup-upgrade.js';

const checkout = process.cwd();
const requested = process.env.THREADNOTE_QUALIFY_OLD_UPGRADE !== undefined;
const manifest = BUILTIN_MODEL_MANIFESTS.find(item => item.id === CORE_GENERATION_MODEL_ID)!;
const expectedEnvironment = {
  THREADNOTE_QUALIFY_OLD_UPGRADE: UPGRADE_ACKNOWLEDGEMENT,
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'macOS',
  RUNNER_ARCH: 'ARM64',
};

it('requires every ephemeral-runner admission condition', () => {
  expect(upgradeQualificationAllowed(expectedEnvironment, 'darwin', 'arm64')).toBe(true);
  for (const key of Object.keys(expectedEnvironment)) {
    expect(upgradeQualificationAllowed({...expectedEnvironment, [key]: undefined}, 'darwin', 'arm64')).toBe(false);
    expect(upgradeQualificationAllowed({...expectedEnvironment, [key]: 'wrong'}, 'darwin', 'arm64')).toBe(false);
  }
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({maxLength: 20}), fc.string({maxLength: 30})),
      fc.constantFrom(...Object.keys(expectedEnvironment)),
      (noise, missing) => {
        expect(
          upgradeQualificationAllowed({...noise, ...expectedEnvironment, [missing]: undefined}, 'darwin', 'arm64'),
        ).toBe(false);
      },
    ),
    {numRuns: 32},
  );
  expect(upgradeQualificationAllowed(expectedEnvironment, 'linux', 'arm64')).toBe(false);
  expect(upgradeQualificationAllowed(expectedEnvironment, 'darwin', 'x64')).toBe(false);
  const environment = upgradeEnvironment('/fixture');
  for (const key of ['HOME', 'CODEX_HOME']) expect(environment[key]).toBe(process.env[key]);
  for (const key of ['THREADNOTE_HOME', 'CI', 'VITEST', 'NODE_ENV', 'GH_TOKEN', 'GITHUB_TOKEN'])
    expect(environment[key]).toBeUndefined();
});

describe.skipIf(!requested)('actual predecessor automatic setup compatibility on disposable macOS', () => {
  let root: string;
  let receipts: string;
  let oldPayload: string;
  let defaultHome: string;
  let version: string;
  let candidateSha256: string;
  let candidateArchiveSha256: string;
  let sourceCommit: string;
  let sourceTree: string;
  let server: ReturnType<typeof serveUpgradeCandidate> | undefined;

  beforeAll(async () => {
    expect(upgradeQualificationAllowed(process.env, process.platform, process.arch)).toBe(true);
    expect(await realpath(requiredUpgradeEnvironment('GITHUB_WORKSPACE'))).toBe(await realpath(checkout));
    root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-real-upgrade-')));
    receipts = requiredUpgradeEnvironment('THREADNOTE_UPGRADE_RECEIPT_DIR');
    await mkdir(receipts, {recursive: true, mode: 0o700});
    defaultHome = join(requiredUpgradeEnvironment('HOME'), '.threadnote');
    expect(await upgradeHomeSnapshot(defaultHome)).toEqual({});
    // This is an empty-home fixture, not a claimed prior install; the real receipt contract permits logging.
    await mkdir(defaultHome, {recursive: true, mode: 0o700});
    await writeFile(
      join(defaultHome, 'layout.json'),
      JSON.stringify({createdBy: 'threadnote', version: THREADNOTE_STORAGE_LAYOUT_VERSION}),
      {mode: 0o600, flag: 'wx'},
    );
    expect(isThreadnoteStorageLayoutReceipt(JSON.parse(await readFile(join(defaultHome, 'layout.json'), 'utf8')))).toBe(
      true,
    );
    const archive = requiredUpgradeEnvironment('THREADNOTE_OLD_RELEASE_ARCHIVE');
    expect(bytesSha256(await readFile(archive))).toBe(PREDECESSOR_ARCHIVE_SHA256);
    const official = JSON.parse(await readFile(requiredUpgradeEnvironment('THREADNOTE_OLD_RELEASE_METADATA'), 'utf8'));
    expect(official).toMatchObject({tag_name: `v${PREDECESSOR_VERSION}`, immutable: true, draft: false});
    expect(official.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'threadnote-darwin-arm64.tar.gz',
          digest: `sha256:${PREDECESSOR_ARCHIVE_SHA256}`,
        }),
      ]),
    );
    oldPayload = join(root, 'predecessor');
    await mkdir(oldPayload);
    await execute('/usr/bin/tar', ['-xzf', archive, '-C', oldPayload]);
    expect(bytesSha256(await readFile(join(oldPayload, 'threadnote')))).toBe(PREDECESSOR_EXECUTABLE_SHA256);
    await execute('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', join(oldPayload, 'threadnote')]);
    const metadata = JSON.parse(await readFile(join(checkout, 'dist', 'release.json'), 'utf8'));
    version = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8')).version;
    expect(metadata).toMatchObject({version, target: 'bun-darwin-arm64'});
    expect(compareVersions(version, PREDECESSOR_VERSION)).toBeGreaterThan(0);
    expect(version).not.toContain('.local.g');
    sourceCommit = (await execute('git', ['rev-parse', 'HEAD'], {cwd: checkout})).stdout.trim();
    sourceTree = (await execute('git', ['rev-parse', 'HEAD^{tree}'], {cwd: checkout})).stdout.trim();
    expect(sourceCommit).toBe(process.env.GITHUB_SHA);
    await execute('git', ['diff', '--exit-code', 'HEAD', '--'], {cwd: checkout});
    candidateSha256 = bytesSha256(await readFile(join(checkout, 'dist', 'threadnote')));
    const candidateArchive = join(root, 'threadnote-darwin-arm64.tar.gz');
    await execute('/usr/bin/tar', ['-czf', candidateArchive, '-C', join(checkout, 'dist'), '.']);
    candidateArchiveSha256 = bytesSha256(await readFile(candidateArchive));
    server = serveUpgradeCandidate(
      candidateArchive,
      `${candidateArchiveSha256}  threadnote-darwin-arm64.tar.gz\n`,
      version,
    );
  });

  afterAll(async () => {
    await server?.close();
  });

  it.each([false, true])(
    'promotes with both legacy steps skipped=%s, then catches up in the bound home',
    async skip => {
      await recordUpgradeAttempt(join(receipts, `${skip ? 'both-skip' : 'legacy-children'}.json`), async () => {
        const run = join(root, skip ? 'both-skip' : 'legacy-children');
        const home = join(run, 'data');
        const installation = join(run, 'installation');
        const releases = join(installation, 'versions');
        const oldRelease = join(releases, PREDECESSOR_VERSION);
        for (const directory of [home, releases, join(run, 'bin'), join(run, 'tmp'), join(run, 'docker')])
          await mkdir(directory, {recursive: true, mode: 0o700});
        await writeFile(join(run, 'docker', 'config.json'), '{}\n', {mode: 0o600});
        await cp(oldPayload, oldRelease, {recursive: true});
        await writeFile(
          join(installation, 'active-release.json'),
          JSON.stringify({releaseRoot: oldRelease, version: PREDECESSOR_VERSION}),
        );
        const policy = join(run, 'loopback-only.sb');
        await writeFile(policy, LOOPBACK_ONLY_POLICY, {mode: 0o600});
        const environment = upgradeEnvironment(run);
        const invoke = (executable: string, args: string[]) =>
          execute(executable, args, {
            cwd: run,
            env: environment,
            timeout: 180_000,
            maxBuffer: 2 * 1024 * 1024,
          });
        const sandbox = (executable: string, args: string[]) =>
          invoke('/usr/bin/sandbox-exec', ['-f', policy, executable, ...args]);
        // These probes qualify the later Manager sandbox, not the unsandboxed legacy update stage.
        await sandbox('/bin/sh', [
          '-c',
          `/usr/bin/python3 -c 'import errno, socket; result = socket.socket().connect_ex(("1.1.1.1", 443)); assert result == errno.EPERM, result'`,
        ]);
        expect((await sandbox('/usr/bin/curl', ['--fail', '--silent', server!.source])).stdout).toContain(
          `v${version}`,
        );
        const psArguments = ['-p', String(process.pid), '-o', 'lstart='];
        expect((await execute('/bin/ps', psArguments, {env: environment})).stdout.trim()).not.toBe('');
        const sandboxPs = await sandbox('/bin/ps', psArguments).then(
          () => ({denied: false, reason: ''}),
          cause => ({
            denied: /Operation not permitted|Permission denied|EPERM|EACCES/i.test(String(cause)),
            reason: String(cause).slice(0, 1024),
          }),
        );
        const defaultBefore = await upgradeHomeSnapshot(defaultHome);
        const defaultLogBefore = (await optionalUpgradeFile(join(defaultHome, 'logs', 'threadnote.log'))) ?? '';
        const stopObserving = await observeUpgradeProcesses(releases);
        const firstRequest = server!.requests.length;
        let update;
        let commands: string[];
        try {
          // Legacy repair requires OS process identity, which sandbox-exec denies on macOS.
          // This explicitly admitted disposable runner allows update-stage network access;
          // any setup job or generation bytes still fail the assertions below.
          update = await invoke(join(oldRelease, 'threadnote'), [
            'update',
            '--home',
            home,
            '--source',
            server!.source,
            '--allow-untrusted-source',
            '--beta',
            '--yes',
            ...(skip ? ['--no-post-update', '--no-repair'] : []),
          ]);
        } finally {
          commands = await stopObserving();
        }
        const output = `${update.stdout}\n${update.stderr}`;
        expect(output).toContain('Update complete.');
        const releaseRequests = server!.requests.slice(firstRequest);
        expect(releaseRequests).toEqual(
          expect.arrayContaining(['/threadnote-darwin-arm64.tar.gz', '/threadnote-darwin-arm64.tar.gz.sha256']),
        );
        expect(commands.filter(command => /model-setup-(?:request|worker)/.test(command))).toEqual([]);
        const newRelease = join(releases, version);
        const candidate = join(newRelease, 'threadnote');
        for (const command of commands.filter(
          line => line.includes(`${candidate} post-update`) || line.includes(`${candidate} repair`),
        ))
          expect(command).not.toContain('--home');
        expect(bytesSha256(await readFile(candidate))).toBe(candidateSha256);
        expect(JSON.parse(await readFile(join(installation, 'active-release.json'), 'utf8'))).toEqual({
          releaseRoot: newRelease,
          version,
        });
        expect(await optionalUpgradeFile(join(home, 'models', 'setup.json'))).toBeUndefined();
        expect(await optionalUpgradeFile(join(defaultHome, 'models', 'setup.json'))).toBeUndefined();
        const logAfter = (await optionalUpgradeFile(join(defaultHome, 'logs', 'threadnote.log'))) ?? '';
        expect(logAfter.startsWith(defaultLogBefore)).toBe(true);
        const log = logAfter.slice(defaultLogBefore.length).trim();
        const completed = log
          ? log
              .split('\n')
              .map(line => JSON.parse(line))
              .filter(entry => entry.event === 'invocation.finished')
          : [];
        if (skip) expect(await upgradeHomeSnapshot(defaultHome)).toEqual(defaultBefore);
        else {
          for (const operation of ['post-update', 'repair'])
            expect(completed).toEqual(
              expect.arrayContaining([expect.objectContaining({operation, version, outcome: 'success'})]),
            );
          expect(output).toContain('Repairing local Threadnote setup after standalone update.');
        }
        const defaultAfterUpdate = await upgradeHomeSnapshot(defaultHome);
        expect(Object.keys(defaultAfterUpdate).filter(file => file.startsWith('models/generation/'))).toEqual([]);
        expect(await upgradeHomeSnapshot(join(home, 'models', 'generation'))).toEqual({});
        let managerOutput = '';
        const manager = spawn(
          '/usr/bin/sandbox-exec',
          ['-f', policy, candidate, 'manage', '--home', home, '--no-open', '--ui-port', '0'],
          {
            cwd: run,
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        manager.stdout.on('data', data => {
          managerOutput = `${managerOutput}${data}`.slice(-128 * 1024);
        });
        manager.stderr.on('data', data => {
          managerOutput = `${managerOutput}${data}`.slice(-128 * 1024);
        });
        const closed = new Promise(resolve => manager.once('close', resolve));
        let evidence: Record<string, unknown> = {};
        try {
          await vi.waitFor(
            async () => {
              expect(managerOutput).toContain('Threadnote manager: http://127.0.0.1:');
              const inspected = parseModelSetup(await readFile(join(home, 'models', 'setup.json'), 'utf8'));
              expect(inspected.status).toBe('valid');
              if (inspected.status !== 'valid') return;
              expect(inspected.state.job).toEqual({
                home,
                modelId: manifest.id,
                revision: manifest.revision,
                sha256: manifest.sha256,
              });
              expect(['retry-wait', 'action-required']).toContain(inspected.state.phase);
              expect(inspected.state.intentEpoch).toBe(inspected.state.reason === 'insufficient-memory' ? 0 : 1);
              expect(inspected.state.attempts).toBe(inspected.state.reason === 'download-failed' ? 1 : 0);
            },
            {timeout: 40_000, interval: 50},
          );
          const admitted = JSON.parse(await readFile(join(home, 'models', 'setup.json'), 'utf8'));
          expect([
            'download-failed',
            'insufficient-memory',
            ...(sandboxPs.denied ? ['worker-identity-unavailable'] : []),
          ]).toContain(admitted.reason);
          expect(admitted.bytes ?? 0).toBe(0);
          for (const hash of Object.values(await upgradeHomeSnapshot(join(home, 'models', 'generation'))))
            expect(hash).toBe(bytesSha256(''));
          expect(await upgradeHomeSnapshot(defaultHome)).toEqual(defaultAfterUpdate);
          evidence = {
            sourceCommit,
            sourceTree,
            candidateVersion: version,
            candidateSha256,
            candidateArchiveSha256,
            predecessorVersion: PREDECESSOR_VERSION,
            predecessorExecutableSha256: PREDECESSOR_EXECUTABLE_SHA256,
            predecessorArchiveSha256: PREDECESSOR_ARCHIVE_SHA256,
            predecessorSourceCommit: '3595076849e656695d1d452a9fc5c1918c4ac322',
            predecessorStrictCodeSignatureVerified: true,
            predecessorPublishedImmutable: true,
            oldUpdaterExitCode: 0,
            legacyBothSkip: skip,
            callerHomeArgumentOnly: true,
            syntheticCandidateReleaseMetadata: true,
            officialCandidateTrustQualified: false,
            updateStage: {
              sandboxed: false,
              networkContained: false,
              limitation:
                'Legacy updater and repair have normal network access on the disposable runner; zero setup jobs and generation bytes are observed assertions, not network-denial guarantees.',
            },
            catchupStage: {
              sandboxed: true,
              networkContained: true,
              loopbackOnlyPolicySha256: bytesSha256(LOOPBACK_ONLY_POLICY),
              remoteNetworkProbe: 'EPERM',
              loopbackNetworkProbe: 'passed',
              processIdentityContainmentProbe: sandboxPs,
            },
            observedCommands: commands,
            releaseFixtureRequests: releaseRequests,
            legacyChildCompletions: completed.filter(entry => ['post-update', 'repair'].includes(entry.operation)),
            defaultHomeSetupJob: false,
            defaultHomeBaseline: 'manual-empty-layout-fixture-validated-against-product-contract',
            defaultHomeContentSha256: bytesSha256(JSON.stringify(defaultAfterUpdate)),
            admitted,
            physicalMemoryBytes: totalmem(),
            nativeGenerationInvokedByTest: false,
          };
        } finally {
          try {
            await sandbox(candidate, ['models', 'setup', '--home', home, '--auto', 'off']);
          } finally {
            manager.kill('SIGTERM');
            await vi.waitFor(() => expect(manager.exitCode !== null || manager.signalCode !== null).toBe(true), {
              timeout: 10_000,
              interval: 50,
            });
            await closed;
          }
          await vi.waitFor(async () => expect(await readdir(join(installation, 'leases', version))).toEqual([]), {
            timeout: 10_000,
            interval: 50,
          });
        }
        expect(await upgradeHomeSnapshot(defaultHome)).toEqual(defaultAfterUpdate);
        return evidence;
      });
    },
  );
});
