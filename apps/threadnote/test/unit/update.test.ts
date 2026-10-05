import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdtemp, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import fc from 'fast-check';
import {Crypto, DateTime, Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {Base64Url} from 'effect/encoding';
import {TestClock} from 'effect/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {CommandExecutor} from '@threadnote/platform/command';
import {sha256FileHex} from '@threadnote/platform/digest';
import {HttpService} from '@threadnote/platform/http';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {activateStandaloneRelease, withStandaloneInstallationLock} from '@threadnote/threadnote/installations';
import {migrateThreadnoteStorageLayout} from '@threadnote/threadnote/migration/layout';
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  enabledTelemetryConfiguration,
  readTelemetryConfiguration,
  renderTelemetryConfiguration,
  telemetryConfigurationPath,
} from '@threadnote/threadnote/telemetry/config';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {UpdateOptions} from '@threadnote/threadnote/types';

vi.mock('@threadnote/threadnote/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/utils')>();
  return {
    ...actual,
    currentPackageVersion: vi.fn(() => Effect.succeed('4.0.0')),
  };
});

vi.mock('@threadnote/workspace/installation', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/workspace/installation')>();
  return {...actual, toolRoot: vi.fn(actual.toolRoot)};
});

vi.mock('@threadnote/workspace/runtime-version', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/workspace/runtime-version')>();
  return {
    ...actual,
    isStandaloneThreadnoteBuild: vi.fn(() => false),
  };
});

import {
  fetchLatestVersion,
  isUpdateTargetAllowed,
  latestUpdateVersionLabel,
  maybeNotifyUpdate,
  maybeRunPostUpdateAfterRepair,
  parseReleaseChecksum,
  promoteReleaseDirectory,
  releaseArtifactName,
  requiresFreshStandaloneInstall,
  requestedUpdateChannel,
  resolveReleaseSource,
  runPostUpdate,
  runUpdate,
  shouldPreferActiveInstalledVersion,
  streamingSubcommandFailureMessage,
  STREAMING_SUBCOMMAND_FAILURE_DETAIL_LIMIT,
  verifyOfficialPlatformSignature,
} from '@threadnote/threadnote/release/index';
import * as utils from '@threadnote/threadnote/utils';
import * as version from '@threadnote/workspace/runtime-version';
import * as installation from '@threadnote/workspace/installation';
import {LEGACY_GITHUB_RELEASES_URL, TRANSFERRED_GITHUB_RELEASES_URL} from '@threadnote/threadnote/release/github_auth';

const OFFICIAL_RELEASE_SOURCE = 'https://api.github.com/repos/threadnote/threadnote/releases?per_page=100';
const RELEASE_VERSION = '4.0.0';
const defaultToolRootImplementation = vi.mocked(installation.toolRoot).getMockImplementation();
let isolatedInstallationRoot: string | undefined;
let previousInstallationRoot: string | undefined;

beforeEach(async () => {
  previousInstallationRoot = process.env.THREADNOTE_INSTALL_ROOT;
  isolatedInstallationRoot = await mkdtemp(join(tmpdir(), 'threadnote-update-installation-'));
  process.env.THREADNOTE_INSTALL_ROOT = isolatedInstallationRoot;
  vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(RELEASE_VERSION));
  vi.mocked(version.isStandaloneThreadnoteBuild).mockReturnValue(false);
  if (defaultToolRootImplementation) {
    vi.mocked(installation.toolRoot).mockImplementation(defaultToolRootImplementation);
  }
});

afterEach(async () => {
  if (isolatedInstallationRoot) await rm(isolatedInstallationRoot, {force: true, recursive: true});
  if (previousInstallationRoot === undefined) delete process.env.THREADNOTE_INSTALL_ROOT;
  else process.env.THREADNOTE_INSTALL_ROOT = previousInstallationRoot;
  isolatedInstallationRoot = undefined;
  previousInstallationRoot = undefined;
});

describe('standalone release selection', () => {
  it('resolves explicit channels and rejects conflicting flags', () => {
    expect(requestedUpdateChannel({})).toBeUndefined();
    expect(requestedUpdateChannel({beta: true})).toBe('beta');
    expect(requestedUpdateChannel({stable: true})).toBe('latest');
    expect(() => requestedUpdateChannel({beta: true, stable: true})).toThrow(/either --beta or --stable/);
  });

  it('requires a fresh install before the standalone 4.x updater boundary', () => {
    expect(requiresFreshStandaloneInstall('3.0.5')).toBe(true);
    expect(requiresFreshStandaloneInstall('4.0.0-beta.1')).toBe(false);
  });

  it('selects active installation metadata only for source, development, or installed runtimes', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (preferInstalledVersion, standaloneBuild, developmentBuild, runningInstalledRelease) => {
          const packageVersion = developmentBuild ? `4.4.1-local.g${'a'.repeat(40)}` : '4.4.1';
          expect(
            shouldPreferActiveInstalledVersion({
              packageVersion,
              preferInstalledVersion,
              runningInstalledRelease,
              standaloneBuild,
            }),
          ).toBe(preferInstalledVersion && (!standaloneBuild || developmentBuild || runningInstalledRelease));
        },
      ),
      {numRuns: 100},
    );
    expect(
      shouldPreferActiveInstalledVersion({
        packageVersion: '3.0.5',
        preferInstalledVersion: true,
        runningInstalledRelease: true,
        standaloneBuild: true,
      }),
    ).toBe(false);
  });

  it('labels the inclusive beta channel without describing a stable winner as a beta release', () => {
    expect(latestUpdateVersionLabel('beta')).toBe('Latest beta-channel version');
    expect(latestUpdateVersionLabel('latest')).toBe('Latest version');
  });

  it('permits generated version transitions only under the downgrade policy', () => {
    fc.assert(
      fc.property(
        fc.integer({max: 100, min: 1}),
        fc.constantFrom<'downgrade' | 'equal' | 'upgrade'>('downgrade', 'equal', 'upgrade'),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom<undefined | 'beta' | 'latest'>(undefined, 'beta', 'latest'),
        (baseMajor, direction, currentIsBeta, targetIsBeta, requestedChannel) => {
          const currentMajor = direction === 'downgrade' ? baseMajor + 1 : baseMajor;
          const targetMajor = direction === 'upgrade' ? baseMajor + 1 : baseMajor;
          const effectiveTargetIsBeta = direction === 'equal' ? currentIsBeta : targetIsBeta;
          const currentVersion = `${currentMajor}.0.0${currentIsBeta ? '-beta.2' : ''}`;
          const targetVersion = `${targetMajor}.0.0${effectiveTargetIsBeta ? '-beta.2' : ''}`;
          const expected =
            direction !== 'downgrade' || (currentIsBeta && !effectiveTargetIsBeta && requestedChannel === 'latest');

          expect(isUpdateTargetAllowed(currentVersion, targetVersion, requestedChannel)).toBe(expected);
        },
      ),
      {numRuns: 200},
    );
  });

  effectIt.effect('selects a newer prerelease for beta while stable excludes it, drafts, and mutable releases', () =>
    Effect.gen(function* () {
      const releases = [
        releaseResponse('4.1.0-beta.2', true),
        releaseResponse('4.0.1', false),
        {...releaseResponse('9.0.0', false), draft: true},
        {...releaseResponse('8.0.0', false), immutable: false},
        releaseResponse('4.1.0-beta.1', true),
      ];
      const http = HttpService.of({
        downloadToFile: () => Effect.die('not used'),
        getJson: () => Effect.succeed({body: releases, status: 200}),
        getStatus: () => Effect.succeed(200),
        getText: () => Effect.die('not used'),
      });

      const [stable, beta] = yield* Effect.all([
        fetchLatestVersion(OFFICIAL_RELEASE_SOURCE, 'latest'),
        fetchLatestVersion(OFFICIAL_RELEASE_SOURCE, 'beta'),
      ]).pipe(Effect.provideService(HttpService, http));

      expect(stable).toBe('4.0.1');
      expect(beta).toBe('4.1.0-beta.2');
    }),
  );

  effectIt.effect('selects a newer stable release for the inclusive beta channel', () =>
    Effect.gen(function* () {
      const releases = [releaseResponse('4.1.0-beta.2', true), releaseResponse('4.2.0', false)];
      const http = HttpService.of({
        downloadToFile: () => Effect.die('not used'),
        getJson: () => Effect.succeed({body: releases, status: 200}),
        getStatus: () => Effect.succeed(200),
        getText: () => Effect.die('not used'),
      });

      const [stable, beta] = yield* Effect.all([
        fetchLatestVersion(OFFICIAL_RELEASE_SOURCE, 'latest'),
        fetchLatestVersion(OFFICIAL_RELEASE_SOURCE, 'beta'),
      ]).pipe(Effect.provideService(HttpService, http));

      expect(stable).toBe('4.2.0');
      expect(beta).toBe('4.2.0');
    }),
  );

  fcEffectProp(
    effectIt,
    'selects the newest stable-or-prerelease version for every bounded beta-channel pair',
    {
      betaMinor: fc.integer({max: 50, min: 0}),
      stableMinor: fc.integer({max: 50, min: 0}),
    },
    ({betaMinor, stableMinor}) =>
      Effect.gen(function* () {
        const betaVersion = `4.${betaMinor}.0-beta.1`;
        const stableVersion = `4.${stableMinor}.0`;
        const http = HttpService.of({
          downloadToFile: () => Effect.die('not used'),
          getJson: () =>
            Effect.succeed({
              body: [releaseResponse(betaVersion, true), releaseResponse(stableVersion, false)],
              status: 200,
            }),
          getStatus: () => Effect.succeed(200),
          getText: () => Effect.die('not used'),
        });

        const [stable, beta] = yield* Effect.all([
          fetchLatestVersion(OFFICIAL_RELEASE_SOURCE, 'latest'),
          fetchLatestVersion(OFFICIAL_RELEASE_SOURCE, 'beta'),
        ]).pipe(Effect.provideService(HttpService, http));

        expect(stable).toBe(stableVersion);
        expect(beta).toBe(betaMinor > stableMinor ? betaVersion : stableVersion);
      }),
    {fastCheck: {numRuns: 100}},
  );

  it('requires HTTPS and explicit trust for custom release sources', () => {
    expect(resolveReleaseSource(undefined, false, {})).toBe(OFFICIAL_RELEASE_SOURCE);
    expect(resolveReleaseSource(LEGACY_GITHUB_RELEASES_URL, false, {})).toBe(LEGACY_GITHUB_RELEASES_URL);
    expect(resolveReleaseSource(TRANSFERRED_GITHUB_RELEASES_URL, false, {})).toBe(TRANSFERRED_GITHUB_RELEASES_URL);
    expect(() => resolveReleaseSource('http://mirror.example/releases', true, {})).toThrow(/must use https/);
    expect(resolveReleaseSource('http://127.0.0.1:4312/releases', true, {})).toBe('http://127.0.0.1:4312/releases');
    expect(() => resolveReleaseSource('https://mirror.example/releases', false, {})).toThrow(
      /Refusing custom release source/,
    );
    expect(resolveReleaseSource('https://mirror.example/releases', true, {})).toBe('https://mirror.example/releases');
    expect(
      resolveReleaseSource(undefined, false, {
        THREADNOTE_ALLOW_UNTRUSTED_RELEASE_SOURCE: 'yes',
        THREADNOTE_RELEASE_SOURCE: 'https://mirror.example/releases',
      }),
    ).toBe('https://mirror.example/releases');
  });

  it('validates checksum documents and target names', () => {
    const artifact = 'threadnote-darwin-arm64.tar.gz';
    const checksum = 'a'.repeat(64);
    expect(parseReleaseChecksum(`${checksum}  ${artifact}\n`, artifact)).toBe(checksum);
    expect(() => parseReleaseChecksum(`${checksum}  another.tar.gz\n`, artifact)).toThrow(/Invalid checksum/);
    expect(() => parseReleaseChecksum('not-a-checksum', artifact)).toThrow(/Invalid checksum/);
    expect(releaseArtifactName({architecture: 'aarch64', platform: 'darwin'})).toBe(artifact);
    expect(() => releaseArtifactName({architecture: 'riscv64', platform: 'linux'})).toThrow(
      /No standalone Threadnote artifact/,
    );
  });

  effectIt.effect('verifies every nested Mach-O runtime file on macOS independent of the test host', () =>
    Effect.gen(function* () {
      const commands = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const releaseRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-signature-test-'});
          const executable = path.join(releaseRoot, 'threadnote');
          const nativeLibrary = path.join(releaseRoot, 'runtime', 'nested', 'libfixture.so');
          const ordinaryFile = path.join(releaseRoot, 'runtime', 'nested', 'metadata.txt');
          yield* fs.makeDirectory(path.dirname(nativeLibrary), {recursive: true});
          yield* fs.writeFileString(executable, 'executable fixture\n');
          yield* fs.writeFileString(nativeLibrary, 'native fixture\n');
          yield* fs.writeFileString(ordinaryFile, 'ordinary fixture\n');
          const recorded: string[] = [];
          const commandExecutor = CommandExecutor.of({
            execute: (command, args) =>
              Effect.sync(() => {
                recorded.push([command, ...args].join(' '));
                return {
                  exitCode: 0,
                  stderr: '',
                  stdout:
                    command === 'file' && args.at(-1) === nativeLibrary ? 'Mach-O 64-bit bundle\n' : 'ASCII text\n',
                };
              }),
            executeStreaming: () => Effect.die('not used'),
          });
          const darwinSystem = SystemInfo.of({
            ...baseSystem,
            architecture: 'arm64',
            platform: 'darwin',
          });
          yield* verifyOfficialPlatformSignature(
            fs,
            path,
            releaseRoot,
            TRANSFERRED_GITHUB_RELEASES_URL,
            darwinSystem,
          ).pipe(Effect.provideService(CommandExecutor, commandExecutor));
          return recorded;
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      const codesignCommands = commands.filter(command => command.startsWith('codesign '));
      expect(commands.join('\n')).toContain('file --brief');
      expect(codesignCommands.join('\n')).toContain('libfixture.so');
      expect(codesignCommands.join('\n')).toContain('threadnote');
      expect(codesignCommands.join('\n')).not.toContain('metadata.txt');
      expect(commands.join('\n')).not.toContain('spctl');
    }),
  );

  effectIt.effect('accepts only an explicitly declared unsigned official Windows release', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const releaseRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-windows-signature-policy-'});
          yield* fs.writeFileString(
            path.join(releaseRoot, 'release.json'),
            `${JSON.stringify({codeSignature: 'unsigned'})}\n`,
          );
          const windowsSystem = SystemInfo.of({...baseSystem, architecture: 'x64', platform: 'win32'});
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('unsigned Windows verification must not execute a signature command'),
            executeStreaming: () => Effect.die('not used'),
          });
          const accepted = yield* captureConsole(
            verifyOfficialPlatformSignature(fs, path, releaseRoot, OFFICIAL_RELEASE_SOURCE, windowsSystem).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
            ),
          );
          yield* fs.writeFileString(
            path.join(releaseRoot, 'release.json'),
            `${JSON.stringify({codeSignature: 'authenticode'})}\n`,
          );
          const rejected = yield* verifyOfficialPlatformSignature(
            fs,
            path,
            releaseRoot,
            OFFICIAL_RELEASE_SOURCE,
            windowsSystem,
          ).pipe(Effect.provideService(CommandExecutor, commandExecutor), Effect.flip);
          return {accepted: accepted.output, rejected: String(rejected)};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.accepted).toContain('This Windows release is unsigned');
      expect(result.rejected).toContain('Release signature policy is invalid for Windows');
    }),
  );
});

describe('update notifications', () => {
  effectIt.effect('invalidates a prerelease-only beta cache before announcing a newer stable release', () =>
    Effect.gen(function* () {
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('4.1.0-beta.2'));
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-cache-version-'});
          const config = runtimeConfig(path.join(temporaryRoot, 'home'));
          yield* fs.makeDirectory(config.agentContextHome, {recursive: true});
          yield* fs.writeFileString(
            path.join(config.agentContextHome, 'update-check.json'),
            `${JSON.stringify({
              channel: 'beta',
              checkedAt: DateTime.formatIso(yield* DateTime.now),
              latestVersion: '4.1.0-beta.3',
              source: OFFICIAL_RELEASE_SOURCE,
            })}\n`,
          );
          let requests = 0;
          const http = HttpService.of({
            downloadToFile: () => Effect.die('not used'),
            getJson: () =>
              Effect.sync(() => {
                requests += 1;
                return {body: [releaseResponse('4.2.0', false)], status: 200};
              }),
            getStatus: () => Effect.die('not used'),
            getText: () => Effect.die('not used'),
          });
          const system = SystemInfo.of({...baseSystem, environment: () => ({})});
          const captured = yield* captureConsole(
            maybeNotifyUpdate(config).pipe(
              Effect.provideService(HttpService, http),
              Effect.provideService(SystemInfo, system),
            ),
          );
          return {
            cache: JSON.parse(yield* fs.readFileString(path.join(config.agentContextHome, 'update-check.json'))) as {
              readonly latestVersion: string;
              readonly version?: number;
            },
            output: captured.output,
            requests,
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);

      expect(result.requests).toBe(1);
      expect(result.output).toContain('Update available: threadnote 4.1.0-beta.2 -> 4.2.0');
      expect(result.cache).toMatchObject({latestVersion: '4.2.0', version: 2});
    }),
  );

  effectIt.effect('revalidates a cached update before announcing a withdrawn release', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-notification-'});
          const config = runtimeConfig(path.join(temporaryRoot, 'home'));
          yield* writeUpdateCacheFixture(fs, path, config, '4.0.1');
          let requests = 0;
          const http = HttpService.of({
            downloadToFile: () => Effect.die('not used'),
            getJson: () =>
              Effect.sync(() => {
                requests += 1;
                return {body: [releaseResponse(RELEASE_VERSION, false)], status: 200};
              }),
            getStatus: () => Effect.die('not used'),
            getText: () => Effect.die('not used'),
          });
          const system = SystemInfo.of({...baseSystem, environment: () => ({})});
          const captured = yield* captureConsole(
            maybeNotifyUpdate(config, {dryRun: true}).pipe(
              Effect.provideService(HttpService, http),
              Effect.provideService(SystemInfo, system),
            ),
          );
          return {output: captured.output, requests};
        }),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);

      expect(result).toEqual({output: '', requests: 1});
    }),
  );

  effectIt.effect('announces a cached update only after confirming that it is still published', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-notification-'});
          const config = runtimeConfig(path.join(temporaryRoot, 'home'));
          yield* writeUpdateCacheFixture(fs, path, config, '4.0.1');
          let requests = 0;
          const http = HttpService.of({
            downloadToFile: () => Effect.die('not used'),
            getJson: () =>
              Effect.sync(() => {
                requests += 1;
                return {body: [releaseResponse('4.0.1', false)], status: 200};
              }),
            getStatus: () => Effect.die('not used'),
            getText: () => Effect.die('not used'),
          });
          const system = SystemInfo.of({...baseSystem, environment: () => ({})});
          const captured = yield* captureConsole(
            maybeNotifyUpdate(config, {dryRun: true}).pipe(
              Effect.provideService(HttpService, http),
              Effect.provideService(SystemInfo, system),
            ),
          );
          return {output: captured.output, requests};
        }),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);

      expect(result.requests).toBe(1);
      expect(result.output).toContain('Update available: threadnote 4.0.0 -> 4.0.1');
    }),
  );

  effectIt.effect('does not check or announce updates for an exact local development build', () =>
    Effect.gen(function* () {
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(`4.0.0-local.g${'a'.repeat(40)}`));
      let requests = 0;
      const http = HttpService.of({
        downloadToFile: () => Effect.die('not used'),
        getJson: () =>
          Effect.sync(() => {
            requests += 1;
            return {body: [releaseResponse('4.0.1', false)], status: 200};
          }),
        getStatus: () => Effect.die('not used'),
        getText: () => Effect.die('not used'),
      });
      const captured = yield* captureConsole(
        maybeNotifyUpdate(runtimeConfig('/tmp/threadnote-local-update-notification')),
      ).pipe(Effect.provideService(HttpService, http), provideTestLayer(ApplicationLayer));

      expect(captured.output).toBe('');
      expect(requests).toBe(0);
    }),
  );
});

describe('standalone updater', () => {
  effectIt.effect('keeps an extracted release binary independent from an unrelated active development install', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseVersion = '4.4.1';
        const activeVersion = `4.4.1-local.g${'b'.repeat(40)}`;
        vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(releaseVersion));
        vi.mocked(version.isStandaloneThreadnoteBuild).mockReturnValue(true);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-extracted-update-check-'});
        const installRoot = path.join(temporaryRoot, 'install');
        const activeReleaseRoot = path.join(installRoot, 'versions', activeVersion);
        const extractedRoot = path.join(temporaryRoot, 'extracted-release');
        yield* fs.makeDirectory(activeReleaseRoot, {recursive: true});
        yield* fs.makeDirectory(extractedRoot, {recursive: true});
        yield* fs.writeFileString(
          path.join(activeReleaseRoot, 'release.json'),
          `${JSON.stringify({version: activeVersion})}\n`,
        );
        yield* fs.writeFileString(
          path.join(extractedRoot, 'release.json'),
          `${JSON.stringify({version: releaseVersion})}\n`,
        );
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            THREADNOTE_INSTALL_ROOT: installRoot,
          }),
          executablePath: path.join(extractedRoot, baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote'),
        });
        yield* activateStandaloneRelease(activeReleaseRoot, false).pipe(Effect.provideService(SystemInfo, testSystem));
        const http = HttpService.of({
          downloadToFile: () => Effect.die('update check must not download'),
          getJson: () => Effect.succeed({body: [releaseResponse(releaseVersion, false)], status: 200}),
          getStatus: () => Effect.die('not used'),
          getText: () => Effect.die('not used'),
        });

        const captured = yield* captureConsole(
          runUpdate(runtimeConfig(path.join(temporaryRoot, 'home')), {check: true, json: true}).pipe(
            Effect.provideService(HttpService, http),
            Effect.provideService(SystemInfo, testSystem),
          ),
        );

        expect(JSON.parse(captured.output)).toMatchObject({
          currentVersion: releaseVersion,
          isUpdateAvailable: false,
          latestVersion: releaseVersion,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('emits one versioned JSON document for a release check', () =>
    Effect.gen(function* () {
      const captured = yield* captureDryRunUpdateSelection(
        '4.1.0',
        [
          ['4.2.0-beta.1', true],
          ['4.1.1', false],
        ],
        {check: true, json: true, stable: true},
      );

      expect(JSON.parse(captured.output)).toEqual({
        channel: 'latest',
        currentVersion: '4.1.0',
        isChannelSwitch: false,
        isUpdateAvailable: true,
        isVersionUpgrade: true,
        latestVersion: '4.1.1',
        requestedChannel: 'latest',
        source: OFFICIAL_RELEASE_SOURCE,
        type: 'threadnote-update-check',
        usedCache: false,
        version: 1,
      });
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('updates an installed beta to a newer stable release without an explicit channel flag', () =>
    Effect.gen(function* () {
      const captured = yield* captureDryRunUpdateSelection(
        '4.1.0-beta.2',
        [
          ['4.1.0-beta.3', true],
          ['4.2.0', false],
        ],
        {},
      );

      expect(captured.output).toContain('Latest beta-channel version: 4.2.0');
      expect(captured.output).toMatch(/versions[\\/]4\.2\.0/);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('updates an installed release candidate through the inclusive preview channel', () =>
    Effect.gen(function* () {
      const captured = yield* captureDryRunUpdateSelection(
        '4.2.0-rc.1',
        [
          ['4.2.0-rc.2', true],
          ['4.1.1', false],
        ],
        {},
      );

      expect(captured.output).toContain('Latest beta-channel version: 4.2.0-rc.2');
      expect(captured.output).toMatch(/versions[\\/]4\.2\.0-rc\.2/);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('selects a newer stable release when --beta explicitly enters the inclusive channel', () =>
    Effect.gen(function* () {
      const captured = yield* captureDryRunUpdateSelection(
        '4.1.0-beta.2',
        [
          ['4.1.0-beta.3', true],
          ['4.2.0', false],
        ],
        {beta: true},
      );

      expect(captured.output).toContain('Latest beta-channel version: 4.2.0');
      expect(captured.output).toMatch(/versions[\\/]4\.2\.0/);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not reinstall an equal stable winner merely because --beta was explicit', () =>
    Effect.gen(function* () {
      const captured = yield* captureDryRunUpdateSelection(
        '4.2.0',
        [
          ['4.1.0-beta.9', true],
          ['4.2.0', false],
        ],
        {beta: true},
      );

      expect(captured.output).toContain('Latest beta-channel version: 4.2.0');
      expect(captured.output).toContain('Threadnote is up to date.');
      expect(captured.output).not.toContain('Would install standalone Threadnote');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('selects a newer beta over the newest stable release', () =>
    Effect.gen(function* () {
      const captured = yield* captureDryRunUpdateSelection(
        '4.1.0',
        [
          ['4.2.0-beta.1', true],
          ['4.1.1', false],
        ],
        {beta: true},
      );

      expect(captured.output).toContain('Latest beta-channel version: 4.2.0-beta.1');
      expect(captured.output).toMatch(/versions[\\/]4\.2\.0-beta\.1/);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('treats a stale same-channel release listing as up to date without force', () =>
    Effect.gen(function* () {
      const currentVersion = '4.2.0-beta.2';
      const olderVersion = '4.2.0-beta.1';
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(currentVersion));
      let downloadAttempted = false;
      const http = HttpService.of({
        downloadToFile: () => {
          downloadAttempted = true;
          return Effect.die('up-to-date path must not download');
        },
        getJson: () => Effect.succeed({body: [releaseResponse(olderVersion, true)], status: 200}),
        getStatus: () => Effect.die('not used'),
        getText: () => Effect.die('up-to-date path must not fetch checksums'),
      });

      const captured = yield* captureConsole(
        runUpdate(runtimeConfig('/tmp/threadnote-update-stale-listing'), {beta: true}).pipe(
          Effect.provideService(HttpService, http),
        ),
      );

      expect(captured.output).toContain('Threadnote is up to date.');
      expect(captured.output).toContain('run `threadnote repair`, then restart that host once');
      expect(downloadAttempted).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses a forced same-channel downgrade before downloading or activating it', () =>
    Effect.gen(function* () {
      const currentVersion = '4.2.0-beta.2';
      const olderVersion = '4.2.0-beta.1';
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(currentVersion));
      let downloadAttempted = false;
      const http = HttpService.of({
        downloadToFile: () => {
          downloadAttempted = true;
          return Effect.die('downgrade must not download');
        },
        getJson: () => Effect.succeed({body: [releaseResponse(olderVersion, true)], status: 200}),
        getStatus: () => Effect.die('not used'),
        getText: () => Effect.die('downgrade must not fetch checksums'),
      });

      const failure = yield* runUpdate(runtimeConfig('/tmp/threadnote-update-same-channel-downgrade'), {
        beta: true,
        force: true,
      }).pipe(Effect.provideService(HttpService, http), provideTestLayer(ApplicationLayer), Effect.flip);

      expect(String(failure)).toContain(`Refusing to downgrade Threadnote ${currentVersion} to ${olderVersion}`);
      expect(downloadAttempted).toBe(false);
    }),
  );

  effectIt.effect('revalidates the active version under the installation lock before a forced reinstall', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selectedVersion = '4.2.0-beta.2';
        const concurrentlyActivatedVersion = '4.2.0-beta.3';
        vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(selectedVersion));
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-lock-race-'});
        const installRoot = path.join(temporaryRoot, 'install');
        const binRoot = path.join(temporaryRoot, 'bin');
        const selectedRoot = path.join(installRoot, 'versions', selectedVersion);
        const concurrentRoot = path.join(installRoot, 'versions', concurrentlyActivatedVersion);
        for (const [releaseRoot, version] of [
          [selectedRoot, selectedVersion],
          [concurrentRoot, concurrentlyActivatedVersion],
        ] as const) {
          yield* fs.makeDirectory(releaseRoot, {recursive: true});
          yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), `${JSON.stringify({version})}\n`);
        }
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            THREADNOTE_BIN_DIR: binRoot,
            THREADNOTE_INSTALL_ROOT: installRoot,
          }),
        });
        yield* activateStandaloneRelease(selectedRoot, false).pipe(Effect.provideService(SystemInfo, testSystem));

        const selectionStarted = yield* Deferred.make<void>();
        const allowSelection = yield* Deferred.make<void>();
        let releaseFetches = 0;
        let downloadAttempted = false;
        const http = HttpService.of({
          downloadToFile: () => {
            downloadAttempted = true;
            return Effect.die('the stale target must not download');
          },
          getJson: () =>
            Effect.gen(function* () {
              releaseFetches += 1;
              if (releaseFetches === 1) {
                yield* Deferred.succeed(selectionStarted, undefined);
                yield* Deferred.await(allowSelection);
              }
              return {body: [releaseResponse(selectedVersion, true)], status: 200};
            }),
          getStatus: () => Effect.die('not used'),
          getText: () => Effect.die('the stale target must not fetch checksums'),
        });
        const updater = yield* Effect.forkScoped(
          runUpdate(runtimeConfig(path.join(temporaryRoot, 'home')), {
            beta: true,
            force: true,
            postUpdate: false,
            repair: false,
          }).pipe(Effect.provideService(HttpService, http), Effect.provideService(SystemInfo, testSystem), Effect.flip),
        );
        yield* Deferred.await(selectionStarted);
        yield* withStandaloneInstallationLock(activateStandaloneRelease(concurrentRoot, false)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* Deferred.succeed(allowSelection, undefined);

        const failure = yield* Fiber.join(updater);
        const active = JSON.parse(yield* fs.readFileString(path.join(installRoot, 'active-release.json'))) as {
          version: string;
        };
        expect(String(failure)).toContain(
          `Refusing to downgrade Threadnote ${concurrentlyActivatedVersion} to ${selectedVersion}`,
        );
        expect(releaseFetches).toBe(1);
        expect(downloadAttempted).toBe(false);
        expect(active.version).toBe(concurrentlyActivatedVersion);
      }),
    ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses a forced stable-to-older-beta selection before downloading or activating it', () =>
    Effect.gen(function* () {
      const currentVersion = '4.2.0';
      const olderVersion = '4.1.0-beta.1';
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(currentVersion));
      let downloadAttempted = false;
      const http = HttpService.of({
        downloadToFile: () => {
          downloadAttempted = true;
          return Effect.die('downgrade must not download');
        },
        getJson: () => Effect.succeed({body: [releaseResponse(olderVersion, true)], status: 200}),
        getStatus: () => Effect.die('not used'),
        getText: () => Effect.die('downgrade must not fetch checksums'),
      });

      const failure = yield* runUpdate(runtimeConfig('/tmp/threadnote-update-stable-to-beta-downgrade'), {
        beta: true,
        force: true,
      }).pipe(Effect.provideService(HttpService, http), provideTestLayer(ApplicationLayer), Effect.flip);

      expect(String(failure)).toContain(`Refusing to downgrade Threadnote ${currentVersion} to ${olderVersion}`);
      expect(downloadAttempted).toBe(false);
    }),
  );

  effectIt.effect('allows an explicit beta-to-stable channel switch to an older stable version', () =>
    Effect.gen(function* () {
      const currentVersion = '4.2.0-beta.1';
      const stableVersion = '4.1.1';
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(currentVersion));
      const system = yield* SystemInfo;
      const artifactName = releaseArtifactName(system);
      const http = HttpService.of({
        downloadToFile: () => Effect.die('dry run must not download'),
        getJson: () => Effect.succeed({body: [releaseResponse(stableVersion, false, artifactName)], status: 200}),
        getStatus: () => Effect.die('not used'),
        getText: () => Effect.die('dry run must not fetch checksums'),
      });

      const captured = yield* captureConsole(
        runUpdate(runtimeConfig('/tmp/threadnote-update-beta-to-stable'), {
          dryRun: true,
          postUpdate: false,
          repair: false,
          stable: true,
        }).pipe(Effect.provideService(HttpService, http)),
      );

      expect(captured.output).toContain(`Would install standalone Threadnote to:`);
      expect(captured.output).toContain(stableVersion);
      expect(captured.output).toContain('MCP host configurations were not refreshed');
      expect(captured.output).toContain('must run `threadnote repair` and restart once');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('allows force to reinstall the equal selected version', () =>
    Effect.gen(function* () {
      const currentVersion = '4.2.0-beta.1';
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(currentVersion));
      const system = yield* SystemInfo;
      const artifactName = releaseArtifactName(system);
      const http = HttpService.of({
        downloadToFile: () => Effect.die('dry run must not download'),
        getJson: () => Effect.succeed({body: [releaseResponse(currentVersion, true, artifactName)], status: 200}),
        getStatus: () => Effect.die('not used'),
        getText: () => Effect.die('dry run must not fetch checksums'),
      });

      const captured = yield* captureConsole(
        runUpdate(runtimeConfig('/tmp/threadnote-update-force-reinstall'), {
          beta: true,
          dryRun: true,
          force: true,
          postUpdate: false,
          repair: false,
        }).pipe(Effect.provideService(HttpService, http)),
      );

      expect(captured.output).toContain(`Would install standalone Threadnote to:`);
      expect(captured.output).toContain(currentVersion);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('updates the active installation when a newer local development binary invokes the updater', () =>
    Effect.gen(function* () {
      const activeVersion = '4.0.0-beta.19';
      const latestVersion = '4.0.0-beta.30';
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(latestVersion));
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-local-update-test-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const binRoot = path.join(temporaryRoot, 'bin');
          const oldReleaseRoot = path.join(installRoot, 'versions', activeVersion);
          yield* fs.makeDirectory(oldReleaseRoot, {recursive: true});
          yield* fs.writeFileString(
            path.join(oldReleaseRoot, 'release.json'),
            `${JSON.stringify({version: activeVersion})}\n`,
          );
          const artifactName = releaseArtifactName(baseSystem);
          const archivePath = path.join(temporaryRoot, artifactName);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeReleaseArchive(archivePath, artifactName, executableName, latestVersion);
          const checksum = yield* sha256FileHex(archivePath);
          const http = updateHttpService(fs, archivePath, checksum, artifactName, [
            releaseResponse(latestVersion, true, artifactName),
          ]);
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });
          yield* activateStandaloneRelease(oldReleaseRoot, false).pipe(Effect.provideService(SystemInfo, testSystem));

          const captured = yield* captureConsole(
            runUpdate(runtimeConfig(path.join(temporaryRoot, 'home')), {
              allowUntrustedSource: true,
              beta: true,
              postUpdate: false,
              repair: false,
              source: 'http://127.0.0.1:4312/releases',
            }).pipe(Effect.provideService(HttpService, http), Effect.provideService(SystemInfo, testSystem)),
          );
          const launcher = path.join(binRoot, baseSystem.platform === 'win32' ? 'threadnote.cmd' : 'threadnote');
          return {
            active: JSON.parse(yield* fs.readFileString(path.join(installRoot, 'active-release.json'))) as {
              version: string;
            },
            captured,
            launcher: yield* fs.readFileString(launcher),
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.captured.output).toContain(`Current version: ${activeVersion}`);
      expect(result.captured.output).toContain(`Installed standalone Threadnote ${latestVersion}`);
      expect(result.active.version).toBe(latestVersion);
      expect(result.launcher).toContain(latestVersion);
    }),
  );

  effectIt.effect('repairs a managed launcher when the active installation is already current', () =>
    Effect.gen(function* () {
      const latestVersion = '4.0.0-beta.30';
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(latestVersion));
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-launcher-repair-test-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const binRoot = path.join(temporaryRoot, 'bin');
          const releaseRoot = path.join(installRoot, 'versions', latestVersion);
          yield* fs.makeDirectory(releaseRoot, {recursive: true});
          yield* fs.writeFileString(
            path.join(releaseRoot, 'release.json'),
            `${JSON.stringify({version: latestVersion})}\n`,
          );
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });
          yield* activateStandaloneRelease(releaseRoot, false).pipe(Effect.provideService(SystemInfo, testSystem));
          const launcher = path.join(binRoot, baseSystem.platform === 'win32' ? 'threadnote.cmd' : 'threadnote');
          yield* fs.makeDirectory(binRoot, {recursive: true});
          yield* fs.writeFileString(
            launcher,
            baseSystem.platform === 'win32'
              ? '@echo off\r\nrem Generated by threadnote\r\nold-release\\threadnote.exe %*\r\n'
              : '#!/usr/bin/env sh\n# Generated by threadnote\nexec old-release/threadnote "$@"\n',
          );
          const http = HttpService.of({
            downloadToFile: () => Effect.die('up-to-date repair must not download'),
            getJson: () => Effect.succeed({body: [releaseResponse(latestVersion, true)], status: 200}),
            getStatus: () => Effect.die('not used'),
            getText: () => Effect.die('not used'),
          });
          const captured = yield* captureConsole(
            runUpdate(runtimeConfig(path.join(temporaryRoot, 'home')), {beta: true}).pipe(
              Effect.provideService(HttpService, http),
              Effect.provideService(SystemInfo, testSystem),
            ),
          );
          return {captured, launcher: yield* fs.readFileString(launcher)};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.captured.output).toContain('Threadnote is up to date.');
      expect(result.captured.output).toContain('Wrote command launcher:');
      expect(result.launcher).toContain(latestVersion);
      expect(result.launcher).not.toContain('old-release');
    }),
  );

  effectIt.effect('installs a verified archive atomically and points stable launchers at the versioned release', () =>
    Effect.gen(function* () {
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('4.0.0-beta.7'));
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-test-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const binRoot = path.join(temporaryRoot, 'bin');
          const config = runtimeConfig(path.join(temporaryRoot, 'home'));
          const artifactName = releaseArtifactName(baseSystem);
          const archivePath = path.join(temporaryRoot, artifactName);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          const releaseRoot = path.join(installRoot, 'versions', RELEASE_VERSION);
          yield* fs.makeDirectory(releaseRoot, {recursive: true});
          yield* fs.writeFileString(path.join(releaseRoot, 'corrupt.txt'), 'untrusted prior contents\n');
          yield* writeReleaseArchive(archivePath, artifactName, executableName, RELEASE_VERSION);
          const checksum = yield* sha256FileHex(archivePath);
          const release = releaseResponse(RELEASE_VERSION, false, artifactName);
          const http = updateHttpService(fs, archivePath, checksum, artifactName, [release]);
          const signatureCommands: string[] = [];
          const commandExecutor = CommandExecutor.of({
            execute: (executable, args) =>
              Effect.sync(() => {
                signatureCommands.push([executable, ...args].join(' '));
                return {
                  exitCode: 0,
                  stderr: '',
                  stdout: executable === 'file' && args.at(-1)?.endsWith('.so') ? 'Mach-O 64-bit bundle\n' : '',
                };
              }),
            executeStreaming: () => Effect.die('not used'),
          });
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              GH_TOKEN: 'fixture-token',
              LOCALAPPDATA: path.join(temporaryRoot, 'local-app-data'),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
            homeDirectory: path.join(temporaryRoot, 'user-home'),
          });

          const captured = yield* captureConsole(
            runUpdate(config, {
              postUpdate: false,
              repair: false,
              stable: true,
              yes: true,
            }).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(HttpService, http),
              Effect.provideService(SystemInfo, testSystem),
            ),
          );

          const launcher = path.join(binRoot, baseSystem.platform === 'win32' ? 'threadnote.cmd' : 'threadnote');
          const mcpLauncher = path.join(
            binRoot,
            baseSystem.platform === 'win32' ? 'threadnote-mcp-server.cmd' : 'threadnote-mcp-server',
          );
          return {
            captured,
            activeRelease: yield* fs.readFileString(path.join(installRoot, 'active-release.json')),
            corruptContentsExist: yield* fs.exists(path.join(releaseRoot, 'corrupt.txt')),
            grammarAssetsExist: yield* fs.exists(
              path.join(releaseRoot, 'assets', 'code-graph', 'grammars', 'swift.wasm'),
            ),
            executableExists: yield* fs.exists(path.join(releaseRoot, executableName)),
            launcher: yield* fs.readFileString(launcher),
            mcpLauncher: yield* fs.readFileString(mcpLauncher),
            platform: baseSystem.platform,
            releaseMetadata: yield* fs.readFileString(path.join(releaseRoot, 'release.json')),
            signatureCommands,
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.executableExists).toBe(true);
      expect(result.grammarAssetsExist).toBe(true);
      expect(result.corruptContentsExist).toBe(false);
      expect(JSON.parse(result.activeRelease)).toMatchObject({version: RELEASE_VERSION});
      expect(JSON.parse(result.releaseMetadata)).toMatchObject({version: RELEASE_VERSION});
      expect(result.launcher).toContain(`versions/${RELEASE_VERSION}/threadnote`.replaceAll('/', pathSeparator()));
      expect(result.mcpLauncher).toContain('mcp-broker');
      if (result.platform === 'darwin') {
        expect(result.signatureCommands.join('\n')).toContain('codesign --verify --strict --verbose=2');
        expect(result.signatureCommands.join('\n')).toContain('libfixture.so');
        expect(result.signatureCommands.join('\n')).not.toContain('spctl');
      }
      if (result.platform === 'win32') {
        expect(result.signatureCommands).toHaveLength(0);
        expect(result.captured.output).toContain('This Windows release is unsigned');
      }
      if (result.platform === 'linux') expect(result.signatureCommands).toHaveLength(0);
      expect(result.captured.output).toContain(`Installed standalone Threadnote ${RELEASE_VERSION}`);
      expect(result.captured.output).toContain('Update complete.');
    }),
  );

  effectIt.effect('rejects a checksum mismatch before promoting or rewriting launchers', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-checksum-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const binRoot = path.join(temporaryRoot, 'bin');
          const config = runtimeConfig(path.join(temporaryRoot, 'home'));
          const artifactName = releaseArtifactName(baseSystem);
          const archivePath = path.join(temporaryRoot, artifactName);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeReleaseArchive(archivePath, artifactName, executableName, RELEASE_VERSION);
          const release = releaseResponse(RELEASE_VERSION, false, artifactName);
          const http = updateHttpService(fs, archivePath, '0'.repeat(64), artifactName, [release]);
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });

          const failure = yield* runUpdate(config, {
            allowUntrustedSource: true,
            force: true,
            postUpdate: false,
            repair: false,
            source: 'http://127.0.0.1:4312/releases',
          }).pipe(Effect.provideService(HttpService, http), Effect.provideService(SystemInfo, testSystem), Effect.flip);
          const releaseRoot = path.join(installRoot, 'versions', RELEASE_VERSION);
          return {
            activeReleaseExists: yield* fs.exists(path.join(installRoot, 'active-release.json')),
            cliLauncherExists: yield* fs.exists(
              path.join(binRoot, baseSystem.platform === 'win32' ? 'threadnote.cmd' : 'threadnote'),
            ),
            failure,
            mcpLauncherExists: yield* fs.exists(
              path.join(
                binRoot,
                baseSystem.platform === 'win32' ? 'threadnote-mcp-server.cmd' : 'threadnote-mcp-server',
              ),
            ),
            releaseExists: yield* fs.exists(releaseRoot),
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(String(result.failure)).toMatch(/Checksum mismatch/);
      expect(result).toMatchObject({
        activeReleaseExists: false,
        cliLauncherExists: false,
        mcpLauncherExists: false,
        releaseExists: false,
      });
    }),
  );

  effectIt.effect('rejects an archive whose bundled code graph grammar does not match its signed manifest', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-grammar-checksum-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const binRoot = path.join(temporaryRoot, 'bin');
          const config = runtimeConfig(path.join(temporaryRoot, 'home'));
          const artifactName = releaseArtifactName(baseSystem);
          const archivePath = path.join(temporaryRoot, artifactName);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeReleaseArchive(archivePath, artifactName, executableName, RELEASE_VERSION, {
            tamperCodeGraphAsset: true,
          });
          const checksum = yield* sha256FileHex(archivePath);
          const release = releaseResponse(RELEASE_VERSION, false, artifactName);
          const http = updateHttpService(fs, archivePath, checksum, artifactName, [release]);
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });

          const failure = yield* runUpdate(config, {
            allowUntrustedSource: true,
            force: true,
            postUpdate: false,
            repair: false,
            source: 'http://127.0.0.1:4312/releases',
          }).pipe(Effect.provideService(HttpService, http), Effect.provideService(SystemInfo, testSystem), Effect.flip);
          return {
            failure,
            releaseExists: yield* fs.exists(path.join(installRoot, 'versions', RELEASE_VERSION)),
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(String(result.failure)).toMatch(/Code graph asset checksum validation failed for grammars\/[\w-]+\.wasm/);
      expect(result.releaseExists).toBe(false);
    }),
  );

  effectIt.effect('restores an existing release when atomic promotion fails', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-rollback-'});
          const releaseRoot = path.join(temporaryRoot, 'versions', RELEASE_VERSION);
          const missingStagedRoot = path.join(temporaryRoot, 'missing-staged-release');
          const marker = path.join(releaseRoot, 'existing-release.txt');
          yield* fs.makeDirectory(releaseRoot, {recursive: true});
          yield* fs.writeFileString(marker, 'keep this release\n');

          const failure = yield* promoteReleaseDirectory(
            fs,
            path,
            missingStagedRoot,
            releaseRoot,
            true,
            system.processId,
          ).pipe(Effect.flip);
          const backupRoot = path.join(
            path.dirname(releaseRoot),
            `.${path.basename(releaseRoot)}.${system.processId}.backup`,
          );
          return {
            backupExists: yield* fs.exists(backupRoot),
            failure,
            marker: yield* fs.readFileString(marker),
            releaseExists: yield* fs.exists(releaseRoot),
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.releaseExists).toBe(true);
      expect(result.marker).toBe('keep this release\n');
      expect(result.backupExists).toBe(false);
      expect(String(result.failure)).toMatch(/missing-staged-release/);
    }),
  );

  effectIt.effect('runs applicable post-update work before repairing the promoted release', () =>
    Effect.gen(function* () {
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('4.0.0-beta.7'));
      const captured = yield* Effect.gen(function* () {
        const system = yield* SystemInfo;
        const release = releaseResponse(RELEASE_VERSION, false, releaseArtifactName(system));
        const http = HttpService.of({
          downloadToFile: () => Effect.die('dry run does not download'),
          getJson: () => Effect.succeed({body: [release], status: 200}),
          getStatus: () => Effect.succeed(200),
          getText: () => Effect.die('dry run does not download checksums'),
        });
        return yield* captureConsole(
          runUpdate(runtimeConfig('/tmp/threadnote-update-order'), {
            dryRun: true,
            stable: true,
            yes: true,
          }).pipe(Effect.provideService(HttpService, http)),
        );
      }).pipe(provideTestLayer(ApplicationLayer));

      const postUpdate = captured.output.indexOf('post-update --from-version');
      const repair = captured.output.indexOf('repair --no-post-update');
      expect(postUpdate).toBeGreaterThan(0);
      expect(repair).toBeGreaterThan(postUpdate);
    }),
  );

  effectIt.effect('repairs the promoted release even when post-update exits non-zero', () =>
    Effect.gen(function* () {
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('4.0.0-beta.7'));
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-post-update-fail-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const binRoot = path.join(temporaryRoot, 'bin');
          const config = runtimeConfig(path.join(temporaryRoot, 'home'));
          const artifactName = releaseArtifactName(baseSystem);
          const archivePath = path.join(temporaryRoot, artifactName);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeReleaseArchive(archivePath, artifactName, executableName, RELEASE_VERSION);
          const checksum = yield* sha256FileHex(archivePath);
          const release = releaseResponse(RELEASE_VERSION, false, artifactName);
          const http = updateHttpService(fs, archivePath, checksum, artifactName, [release]);
          const streaming: Array<{
            readonly args: readonly string[];
            readonly inheritOutput: boolean | undefined;
            readonly inheritStdin: boolean | undefined;
          }> = [];
          const commandExecutor = CommandExecutor.of({
            execute: (executable, args) =>
              Effect.sync(() => ({
                exitCode: 0,
                stderr: '',
                stdout: executable === 'file' && args.at(-1)?.endsWith('.so') ? 'Mach-O 64-bit bundle\n' : '',
              })),
            executeStreaming: (_executable, args, options) =>
              Effect.sync(() => {
                streaming.push({
                  args: [...args],
                  inheritOutput: options?.inheritOutput,
                  inheritStdin: options?.inheritStdin,
                });
                if (args[0] === 'post-update') {
                  return {exitCode: 1, stderr: 'detached inherit failed\n', stdout: ''};
                }
                return {exitCode: 0, stderr: '', stdout: ''};
              }),
          });
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              LOCALAPPDATA: path.join(temporaryRoot, 'local-app-data'),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
            homeDirectory: path.join(temporaryRoot, 'user-home'),
            stdinIsTTY: false,
            stdoutIsTTY: false,
          });

          const captured = yield* captureConsole(
            runUpdate(config, {stable: true, yes: true}).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(HttpService, http),
              Effect.provideService(SystemInfo, testSystem),
              Effect.flip,
            ),
          );
          return {captured, streaming};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.streaming.map(entry => entry.args[0])).toEqual(['post-update', 'repair']);
      expect(result.streaming.every(entry => entry.inheritOutput === false)).toBe(true);
      expect(result.streaming.every(entry => entry.inheritStdin === false)).toBe(true);
      expect(result.captured.output).toContain('Post-update did not finish. Continuing with local setup repair.');
      expect(result.captured.output).toContain('Repairing local Threadnote setup after standalone update.');
      expect(result.captured.output).not.toContain('Update complete.');
      expect(String(result.captured.value)).toContain('exited with 1');
      expect(String(result.captured.value)).toContain('detached inherit failed');
    }),
  );

  effectIt.effect('refuses to execute an in-place Threadnote 3 to 4 transition', () =>
    Effect.gen(function* () {
      vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('3.0.5'));
      let downloadAttempted = false;
      const http = HttpService.of({
        downloadToFile: () => {
          downloadAttempted = true;
          return Effect.die('must not download');
        },
        getJson: () => Effect.succeed({body: [releaseResponse(RELEASE_VERSION, false)], status: 200}),
        getStatus: () => Effect.succeed(200),
        getText: () => Effect.die('must not download checksums'),
      });

      expect(
        String(
          yield* Effect.flip(
            runUpdate(runtimeConfig('/tmp/threadnote-fresh-install-boundary'), {
              stable: true,
            }).pipe(Effect.provideService(HttpService, http), provideTestLayer(ApplicationLayer)),
          ),
        ),
      ).toMatch(/cannot update across the standalone-runtime boundary.*Install Threadnote 4 fresh/);
      expect(downloadAttempted).toBe(false);
    }),
  );
});

describe('post-update validation', () => {
  effectIt.effect('requires both version boundaries', () =>
    Effect.gen(function* () {
      const config = runtimeConfig('/tmp/threadnote-post-update-validation');
      expect(String(yield* Effect.flip(runPostUpdate(config, {}).pipe(provideTestLayer(ApplicationLayer))))).toMatch(
        /Provide --from-version and --to-version/,
      );
    }),
  );

  effectIt.effect('is silent for fresh homes in interactive and non-interactive post-update and repair paths', () =>
    Effect.gen(function* () {
      const outputs = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-fresh-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, '.threadnote');
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('legacy-home-import', {requiresLegacyHomeMigration: true}),
            fixtureMigration('home-recovery', {requiresPendingHomeMigration: true}),
          ]);
          yield* Effect.sync(() => {
            vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () => Effect.die('fresh homes must not run migrations'),
          });
          const outputs: string[] = [];
          for (const interactive of [false, true]) {
            const system = SystemInfo.of({
              ...baseSystem,
              homeDirectory: temporaryRoot,
              stdinIsTTY: interactive,
              stdoutIsTTY: interactive,
            });
            const postUpdate = yield* captureConsole(
              runPostUpdate(runtimeConfig(home), {
                fromVersion: '0.0.0',
                toVersion: RELEASE_VERSION,
              }).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
            const repairFallback = yield* captureConsole(
              maybeRunPostUpdateAfterRepair(runtimeConfig(home), {dryRun: false}).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
            outputs.push(postUpdate.output, repairFallback.output);
          }
          return outputs;
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(outputs).toEqual(['', '', '', '']);
    }),
  );

  effectIt.effect('keeps the shipped beta migration catalog silent for a fresh current home', () =>
    Effect.gen(function* () {
      const outputs = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-catalog-fresh-'});
          const home = path.join(temporaryRoot, '.threadnote');
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () => Effect.die('fresh homes must not run shipped migrations'),
          });
          const outputs: string[] = [];
          for (const interactive of [false, true]) {
            const system = SystemInfo.of({
              ...baseSystem,
              homeDirectory: temporaryRoot,
              stdinIsTTY: interactive,
              stdoutIsTTY: interactive,
            });
            const captured = yield* captureConsole(
              runPostUpdate(runtimeConfig(home), {
                fromVersion: '4.0.0-beta.29',
                toVersion: '4.0.0-beta.30',
              }).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
            outputs.push(captured.output);
          }
          return outputs;
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(outputs).toEqual(['', '']);
    }),
  );

  effectIt.effect('previews renewed telemetry consent and never lets non-interactive --yes apply it', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-telemetry-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, '.threadnote');
          const config = runtimeConfig(home);
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            {
              ...fixtureMigration('telemetry-consent-renewal', {
                requiresExplicitTelemetryConsent: true,
                requiresTelemetryConsentRenewal: true,
              }),
              commandArgs: ['telemetry', 'enable'],
            },
          ]);
          yield* Effect.sync(() => {
            vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          const telemetryFile = yield* telemetryConfigurationPath(config);
          yield* fs.makeDirectory(path.dirname(telemetryFile), {recursive: true});
          yield* fs.writeFileString(
            telemetryFile,
            `${JSON.stringify({
              consentVersion: 5,
              enabled: true,
              endpoint: DEFAULT_TELEMETRY_ENDPOINT,
              sessionSalt: Base64Url.encode(new Uint8Array(32).fill(5)),
              version: 1,
            })}\n`,
          );

          const attempts: string[][] = [];
          let notificationAttempts = 0;
          const commandExecutor = CommandExecutor.of({
            execute: () =>
              Effect.sync(() => {
                notificationAttempts += 1;
                return {exitCode: 127, stderr: '', stdout: ''};
              }),
            executeStreaming: (_executable, args) =>
              Effect.gen(function* () {
                attempts.push([...args]);
                if (args.includes('--apply')) {
                  yield* fs
                    .writeFileString(
                      telemetryFile,
                      renderTelemetryConfiguration(
                        enabledTelemetryConfiguration(
                          DEFAULT_TELEMETRY_ENDPOINT,
                          Base64Url.encode(new Uint8Array(32).fill(6)),
                        ),
                      ),
                    )
                    .pipe(Effect.orDie);
                }
                return {exitCode: 0, stderr: '', stdout: ''};
              }),
          });
          const nonInteractiveSystem = SystemInfo.of({
            ...baseSystem,
            homeDirectory: temporaryRoot,
            stdinIsTTY: false,
            stdoutIsTTY: false,
          });
          const nonInteractive = yield* captureConsole(
            runPostUpdate(config, {fromVersion: '4.4.3', toVersion: '4.4.4', yes: true}).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(SystemInfo, nonInteractiveSystem),
            ),
          );
          const afterNonInteractive = yield* fs.readFileString(telemetryFile);
          const notificationAttemptsAfterNonInteractive = notificationAttempts;

          const interactiveSystem = SystemInfo.of({
            ...nonInteractiveSystem,
            stdinIsTTY: true,
            stdoutIsTTY: true,
            readLine: (_prompt, onLine) => {
              onLine('yes');
              return () => undefined;
            },
          });
          const interactive = yield* captureConsole(
            runPostUpdate(config, {fromVersion: '4.4.3', toVersion: '4.4.4', yes: true}).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(SystemInfo, interactiveSystem),
            ),
          );
          const second = yield* captureConsole(
            runPostUpdate(config, {fromVersion: '4.4.3', toVersion: '4.4.4', yes: true}).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(SystemInfo, interactiveSystem),
            ),
          );
          return {
            afterNonInteractive: JSON.parse(afterNonInteractive),
            attempts,
            current: yield* readTelemetryConfiguration(config),
            interactive: interactive.output,
            nonInteractive: nonInteractive.output,
            notificationAttempts,
            notificationAttemptsAfterNonInteractive,
            second: second.output,
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.afterNonInteractive).toMatchObject({consentVersion: 5, enabled: true});
      expect(result.nonInteractive).toContain('Telemetry remains disabled');
      expect(result.nonInteractive).toContain('telemetry enable --apply');
      expect(result.attempts).toEqual([
        ['telemetry', 'enable'],
        ['telemetry', 'enable'],
        ['telemetry', 'enable', '--apply'],
      ]);
      expect(result.current).toMatchObject({consentVersion: 6, enabled: true});
      expect(result.interactive).toContain('Finished telemetry-consent-renewal');
      expect(result.notificationAttemptsAfterNonInteractive).toBe(1);
      expect(result.notificationAttempts).toBe(1);
      expect(result.second).toBe('');
    }),
  );

  effectIt.effect('keeps telemetry enabled when an earlier consent auto-accepts scope updates', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-auto-consent-'});
        const fixtureRoot = path.join(temporaryRoot, 'tool');
        const config = runtimeConfig(path.join(temporaryRoot, '.threadnote'));
        yield* writePostUpdateFixture(fs, path, fixtureRoot, [
          {
            ...fixtureMigration('telemetry-consent-renewal', {
              requiresExplicitTelemetryConsent: true,
              requiresTelemetryConsentRenewal: true,
            }),
            commandArgs: ['telemetry', 'enable'],
          },
        ]);
        yield* Effect.sync(() => {
          vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
        });
        const telemetryFile = yield* telemetryConfigurationPath(config);
        yield* fs.makeDirectory(path.dirname(telemetryFile), {recursive: true});
        yield* fs.writeFileString(
          telemetryFile,
          `${JSON.stringify({
            autoAccept: true,
            consentVersion: 5,
            enabled: true,
            endpoint: DEFAULT_TELEMETRY_ENDPOINT,
            sessionSalt: Base64Url.encode(new Uint8Array(32).fill(7)),
            version: 1,
          })}\n`,
        );

        let commandAttempts = 0;
        const commandExecutor = CommandExecutor.of({
          execute: () =>
            Effect.sync(() => {
              commandAttempts += 1;
              return {exitCode: 0, stderr: '', stdout: ''};
            }),
          executeStreaming: () =>
            Effect.sync(() => {
              commandAttempts += 1;
              return {exitCode: 0, stderr: '', stdout: ''};
            }),
        });
        const output = yield* captureConsole(
          runPostUpdate(config, {fromVersion: '4.4.3', toVersion: '4.4.4', yes: true}).pipe(
            Effect.provideService(CommandExecutor, commandExecutor),
            Effect.provideService(
              SystemInfo,
              SystemInfo.of({
                ...baseSystem,
                homeDirectory: temporaryRoot,
                stdinIsTTY: false,
                stdoutIsTTY: false,
              }),
            ),
          ),
        );

        expect(output.output).toBe('');
        expect(commandAttempts).toBe(0);
        expect(yield* readTelemetryConfiguration(config)).toMatchObject({
          autoAccept: true,
          consentVersion: 6,
          enabled: true,
        });
        expect(JSON.parse(yield* fs.readFileString(telemetryFile))).toMatchObject({consentVersion: 5});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not announce an action when migration evidence disappears at the locked recheck', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-drift-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, '.threadnote');
          const legacyLayout = path.join(home, 'data', 'viking');
          yield* fs.makeDirectory(legacyLayout, {recursive: true});
          yield* fs.writeFileString(path.join(legacyLayout, 'memory.md'), '# Material beta memory\n');
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('home-recovery', {requiresPendingHomeMigration: true}),
          ]);
          yield* Effect.sync(() => {
            vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          let evidenceChecks = 0;
          const flappingFileSystem = FileSystem.FileSystem.of({
            ...fs,
            exists: target =>
              target === legacyLayout
                ? Effect.sync(() => {
                    evidenceChecks += 1;
                    return evidenceChecks === 1;
                  })
                : fs.exists(target),
          });
          const system = SystemInfo.of({
            ...baseSystem,
            homeDirectory: temporaryRoot,
            stdinIsTTY: false,
            stdoutIsTTY: false,
          });
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () => Effect.die('disappeared evidence must not execute'),
          });
          const captured = yield* captureConsole(
            runPostUpdate(runtimeConfig(home), {
              fromVersion: '4.0.0-beta.1',
              toVersion: RELEASE_VERSION,
            }).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(FileSystem.FileSystem, flappingFileSystem),
              Effect.provideService(SystemInfo, system),
            ),
          );
          return {evidenceChecks, output: captured.output};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result).toEqual({evidenceChecks: 2, output: ''});
    }),
  );

  effectIt.effect('retries evidence-backed beta-layout recovery until it materially completes', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-beta-layout-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, '.threadnote');
          const betaMemory = path.join(home, 'data', 'viking', 'local', 'memory.md');
          yield* fs.makeDirectory(path.dirname(betaMemory), {recursive: true});
          yield* fs.writeFileString(betaMemory, '# Beta memory\n');
          yield* fs.writeFileString(
            path.join(home, 'post-update-state.json'),
            `${JSON.stringify({handledMigrationIds: ['home-recovery']})}\n`,
          );
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('legacy-home-import', {requiresLegacyHomeMigration: true}),
            fixtureMigration('home-recovery', {requiresPendingHomeMigration: true}),
          ]);
          yield* Effect.sync(() => {
            vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          const attempts: string[] = [];
          let materialize = false;
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: (_executable, args) =>
              Effect.gen(function* () {
                attempts.push(args[0] ?? '');
                if (materialize) {
                  yield* fs.remove(path.join(home, 'data', 'viking'), {recursive: true});
                  yield* fs.writeFileString(
                    path.join(home, 'layout.json'),
                    `${JSON.stringify({createdBy: 'threadnote', version: 2})}\n`,
                  );
                }
                return {exitCode: 0, stderr: '', stdout: ''};
              }).pipe(Effect.orDie),
          });
          const system = SystemInfo.of({
            ...baseSystem,
            homeDirectory: temporaryRoot,
            stdinIsTTY: false,
            stdoutIsTTY: false,
          });
          const run = () =>
            captureConsole(
              runPostUpdate(runtimeConfig(home), {
                fromVersion: '4.0.0-beta.1',
                toVersion: RELEASE_VERSION,
                yes: true,
              }).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
          const noOpFailure = yield* run().pipe(Effect.flip);
          materialize = true;
          const first = yield* run();
          const second = yield* run();
          return {attempts, first: first.output, noOpFailure: String(noOpFailure), second: second.output};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.attempts).toEqual(['home-recovery', 'home-recovery']);
      expect(result.noOpFailure).toContain('filesystem requirements remain pending');
      expect(result.first).toContain('Post-update actions are available.');
      expect(result.second).toBe('');
    }),
  );

  effectIt.effect('keeps authoritative home recovery eligible after its introduction version until it completes', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-deferred-home-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, '.threadnote');
          const betaMemory = path.join(home, 'data', 'viking', 'local', 'memory.md');
          yield* fs.makeDirectory(path.dirname(betaMemory), {recursive: true});
          yield* fs.writeFileString(betaMemory, '# Deferred beta memory\n');
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('home-recovery', {requiresPendingHomeMigration: true}),
          ]);
          yield* Effect.sync(() => {
            vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          const system = SystemInfo.of({
            ...baseSystem,
            homeDirectory: temporaryRoot,
            stdinIsTTY: false,
            stdoutIsTTY: false,
          });
          let executions = 0;
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () =>
              Effect.gen(function* () {
                executions += 1;
                yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(SystemInfo, system),
                );
                return {exitCode: 0, stderr: '', stdout: ''};
              }).pipe(Effect.orDie),
          });
          const run = () =>
            captureConsole(
              runPostUpdate(runtimeConfig(home), {
                fromVersion: '4.0.0',
                toVersion: '4.0.1',
                yes: true,
              }).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
          const first = yield* run();
          const second = yield* run();
          return {executions, first: first.output, second: second.output};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result).toEqual({
        executions: 1,
        first: expect.stringContaining('Post-update actions are available.'),
        second: '',
      });
    }),
  );

  effectIt.effect('recovers beta data after an older repair already wrote the current layout marker', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-repair-marker-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, '.threadnote');
          const betaMemory = path.join(home, 'data', 'viking', 'local', 'memory.md');
          yield* fs.makeDirectory(path.dirname(betaMemory), {recursive: true});
          yield* fs.writeFileString(betaMemory, '# Preserved beta memory\n');
          yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('home-recovery', {requiresPendingHomeMigration: true}),
          ]);
          yield* Effect.sync(() => {
            vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          const system = SystemInfo.of({
            ...baseSystem,
            homeDirectory: temporaryRoot,
            stdinIsTTY: false,
            stdoutIsTTY: false,
          });
          let executions = 0;
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () =>
              Effect.gen(function* () {
                executions += 1;
                yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(SystemInfo, system),
                );
                return {exitCode: 0, stderr: '', stdout: ''};
              }).pipe(Effect.orDie),
          });
          const run = () =>
            captureConsole(
              runPostUpdate(runtimeConfig(home), {
                fromVersion: '4.0.0-beta.1',
                toVersion: RELEASE_VERSION,
                yes: true,
              }).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
          const first = yield* run();
          const second = yield* run();
          return {
            executions,
            first: first.output,
            memory: yield* fs.readFileString(path.join(home, 'data', 'local', 'memory.md')),
            second: second.output,
            sourceExists: yield* fs.exists(betaMemory),
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result).toEqual({
        executions: 1,
        first: expect.stringContaining('Post-update actions are available.'),
        memory: '# Preserved beta memory\n',
        second: '',
        sourceExists: false,
      });
    }),
  );

  effectIt.effect('checkpoints each successful migration before a later migration fails', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-checkpoint-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, 'home');
          const config = runtimeConfig(home);
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('fixture-one'),
            fixtureMigration('fixture-two'),
          ]);
          yield* fs.makeDirectory(home, {recursive: true});
          yield* fs.writeFileString(
            path.join(home, '.post-update-state.json.00000000-0000-4000-8000-000000000000.tmp'),
            'interrupted write\n',
          );
          yield* Effect.sync(() => {
            vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });

          let failSecond = true;
          const attempts: string[] = [];
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: (_executable, args) =>
              Effect.sync(() => {
                attempts.push(args[0] ?? '');
                return {
                  exitCode: failSecond && args[0] === 'fixture-two' ? 1 : 0,
                  stderr: '',
                  stdout: '',
                };
              }),
          });
          const firstFailure = yield* runPostUpdate(config, {
            fromVersion: '3.9.0',
            toVersion: RELEASE_VERSION,
            yes: true,
          }).pipe(Effect.provideService(CommandExecutor, commandExecutor), Effect.flip);
          const firstState = JSON.parse(yield* fs.readFileString(path.join(home, 'post-update-state.json'))) as {
            handledMigrationIds: string[];
          };
          const temporaryStateFiles = (yield* fs.readDirectory(home)).filter(name =>
            /^\.post-update-state\.json\..+\.tmp$/.test(name),
          );

          failSecond = false;
          attempts.length = 0;
          yield* runPostUpdate(config, {
            fromVersion: '3.9.0',
            toVersion: RELEASE_VERSION,
            yes: true,
          }).pipe(Effect.provideService(CommandExecutor, commandExecutor));
          const finalState = JSON.parse(yield* fs.readFileString(path.join(home, 'post-update-state.json'))) as {
            handledMigrationIds: string[];
          };
          return {
            finalState,
            firstFailure: String(firstFailure),
            firstState,
            retryAttempts: [...attempts],
            temporaryStateFiles,
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result).toEqual({
        finalState: {handledMigrationIds: ['fixture-one', 'fixture-two']},
        firstFailure: expect.stringContaining('exited with 1'),
        firstState: {handledMigrationIds: ['fixture-one']},
        retryAttempts: ['fixture-two'],
        temporaryStateFiles: [],
      });
    }),
  );

  effectIt.effect('serializes concurrent post-update runs so a migration executes once', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-concurrent-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, 'home');
          const config = runtimeConfig(home);
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [fixtureMigration('fixture-once')]);
          yield* Effect.sync(() => {
            vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });

          let executions = 0;
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () =>
              Effect.gen(function* () {
                executions += 1;
                yield* Effect.sleep(75);
                return {exitCode: 0, stderr: '', stdout: ''};
              }),
          });
          const run = runPostUpdate(config, {
            fromVersion: '3.9.0',
            toVersion: RELEASE_VERSION,
            yes: true,
          }).pipe(Effect.provideService(CommandExecutor, commandExecutor));
          yield* Effect.all([run, run], {concurrency: 2});
          return {
            executions,
            state: JSON.parse(yield* fs.readFileString(path.join(home, 'post-update-state.json'))),
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result).toEqual({
        executions: 1,
        state: {handledMigrationIds: ['fixture-once']},
      });
    }).pipe(TestClock.withLive),
  );

  effectIt.effect('preserves corrupt post-update state instead of silently rerunning migrations', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-corrupt-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, 'home');
          const statePath = path.join(home, 'post-update-state.json');
          const config = runtimeConfig(home);
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [fixtureMigration('must-not-run')]);
          yield* fs.makeDirectory(home, {recursive: true});
          yield* fs.writeFileString(statePath, '{"handledMigrationIds": [');
          yield* Effect.sync(() => {
            vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () => Effect.die('must not run a migration with corrupt state'),
          });
          const failure = yield* runPostUpdate(config, {
            fromVersion: '3.9.0',
            toVersion: RELEASE_VERSION,
            yes: true,
          }).pipe(Effect.provideService(CommandExecutor, commandExecutor), Effect.flip);
          return {
            failure: String(failure),
            state: yield* fs.readFileString(statePath),
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result).toEqual({
        failure: expect.stringContaining('Post-update state is invalid and was preserved'),
        state: '{"handledMigrationIds": [',
      });
    }),
  );
});

describe('streaming subcommand failure messages', () => {
  it('redacts secrets in captured child output', () => {
    const message = streamingSubcommandFailureMessage('threadnote', ['post-update'], {
      exitCode: 1,
      stderr: 'Authorization: Bearer super-secret-token-value-abcdef',
      stdout: '',
    });
    expect(message).toContain('exited with 1.');
    expect(message).not.toContain('super-secret-token-value-abcdef');
    expect(message).toContain('[REDACTED]');
  });

  fcEffectProp(
    effectIt,
    'keeps the exit code and a tail of preferred child output',
    {
      extra: fc.integer({max: 400, min: 0}),
      exitCode: fc.integer({max: 255, min: 1}),
      stream: fc.constantFrom('stderr' as const, 'stdout' as const),
    },
    ({extra, exitCode, stream}) =>
      Effect.sync(() => {
        const overflow = extra > 0;
        const body = overflow
          ? `UNIQUEHEAD${'m'.repeat(STREAMING_SUBCOMMAND_FAILURE_DETAIL_LIMIT + extra)}UNIQUETAIL`
          : 'ok-detail';
        const stderr = stream === 'stderr' ? body : '';
        const stdout = stream === 'stdout' ? body : 'ignored-stdout-noise';
        const message = streamingSubcommandFailureMessage('/tmp/threadnote', ['post-update', '--yes'], {
          exitCode,
          stderr,
          stdout,
        });
        expect(message).toContain(`exited with ${exitCode}.`);
        const preferred = stderr.trim() || stdout.trim();
        if (overflow) {
          expect(message).toContain('…');
          expect(message).toContain('UNIQUETAIL');
          expect(message).not.toContain('UNIQUEHEAD');
        } else {
          expect(message).toContain(preferred);
          expect(message).not.toContain('…');
        }
        if (stream === 'stderr') {
          expect(message).not.toContain('ignored-stdout-noise');
        }
      }),
    {fastCheck: {numRuns: 64}},
  );
});

function releaseResponse(version: string, prerelease: boolean, artifactName = 'threadnote-darwin-arm64.tar.gz') {
  return {
    assets: [
      {
        browser_download_url: `https://github.com/threadnote/threadnote/releases/download/v${version}/${artifactName}`,
        name: artifactName,
      },
      {
        browser_download_url: `https://github.com/threadnote/threadnote/releases/download/v${version}/${artifactName}.sha256`,
        name: `${artifactName}.sha256`,
      },
    ],
    draft: false,
    immutable: true,
    prerelease,
    tag_name: `v${version}`,
  };
}

function runtimeConfig(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'update-test',
  };
}

function captureDryRunUpdateSelection(
  currentVersion: string,
  releases: readonly (readonly [version: string, prerelease: boolean])[],
  options: UpdateOptions,
) {
  vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(currentVersion));
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const artifactName = releaseArtifactName(system);
    const http = HttpService.of({
      downloadToFile: () => Effect.die('dry run must not download'),
      getJson: () =>
        Effect.succeed({
          body: releases.map(([version, prerelease]) => releaseResponse(version, prerelease, artifactName)),
          status: 200,
        }),
      getStatus: () => Effect.die('not used'),
      getText: () => Effect.die('dry run must not fetch checksums'),
    });
    return yield* captureConsole(
      runUpdate(runtimeConfig(`/tmp/threadnote-update-selection-${currentVersion}`), {
        ...options,
        dryRun: true,
        postUpdate: false,
        repair: false,
      }).pipe(Effect.provideService(HttpService, http)),
    );
  });
}

function writeUpdateCacheFixture(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RuntimeConfig,
  latestVersion: string,
) {
  return fs.makeDirectory(config.agentContextHome, {recursive: true}).pipe(
    Effect.andThen(
      fs.writeFileString(
        path.join(config.agentContextHome, 'update-check.json'),
        `${JSON.stringify({
          channel: 'latest',
          checkedAt: new Date().toISOString(),
          latestVersion,
          source: OFFICIAL_RELEASE_SOURCE,
          version: 2,
        })}\n`,
      ),
    ),
  );
}

function fixtureMigration(
  id: string,
  requirements: {
    readonly requiresExplicitTelemetryConsent?: boolean;
    readonly requiresLegacyHomeMigration?: boolean;
    readonly requiresPendingHomeMigration?: boolean;
    readonly requiresTelemetryConsentRenewal?: boolean;
  } = {},
) {
  return {
    commandArgs: [id],
    description: [`Run ${id}.`],
    id,
    instructions: [`Finished ${id}.`],
    introducedIn: RELEASE_VERSION,
    ...requirements,
    title: id,
  };
}

function writePostUpdateFixture(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  migrations: readonly ReturnType<typeof fixtureMigration>[],
) {
  const configRoot = path.join(root, 'config');
  return fs
    .makeDirectory(configRoot, {recursive: true})
    .pipe(
      Effect.andThen(
        fs.writeFileString(
          path.join(configRoot, 'post-update-migrations.json'),
          `${JSON.stringify({migrations, version: 1}, undefined, 2)}\n`,
        ),
      ),
    );
}

function updateHttpService(
  fs: FileSystem.FileSystem,
  archivePath: string,
  checksum: string,
  artifactName: string,
  releases: readonly unknown[],
) {
  return HttpService.of({
    downloadToFile: (_url, destination) =>
      fs.copyFile(archivePath, destination).pipe(Effect.orDie, Effect.as({resumed: false, status: 200})),
    getJson: () => Effect.succeed({body: releases, status: 200}),
    getStatus: () => Effect.succeed(200),
    getText: () => Effect.succeed({body: `${checksum}  ${artifactName}\n`, status: 200}),
  });
}

function writeReleaseArchive(
  archivePath: string,
  _artifactName: string,
  executableName: string,
  version: string,
  options: {readonly tamperCodeGraphAsset?: boolean} = {},
) {
  return Effect.tryPromise({
    try: async () => {
      const manifest = JSON.parse(await Bun.file('assets/code-graph/manifest.json').text()) as {
        readonly grammars: Readonly<
          Record<
            string,
            {
              readonly builderLicense?: string;
              readonly license: string;
              readonly licensePackagePath?: string;
              readonly packagePath?: string;
              readonly path: string;
            }
          >
        >;
      };
      const grammarMetadata = Object.values(manifest.grammars);
      const assetPaths = [
        'manifest.json',
        'runtime/web-tree-sitter.wasm',
        'licenses/web-tree-sitter.LICENSE',
        ...grammarMetadata.map(asset => asset.path),
        ...grammarMetadata.map(asset => asset.license),
        ...grammarMetadata.flatMap(asset => (asset.builderLicense ? [asset.builderLicense] : [])),
      ].filter((value, index, values) => values.indexOf(value) === index);
      const assets = Object.fromEntries(
        await Promise.all(
          assetPaths.map(async asset => [
            `assets/code-graph/${asset}`,
            await codeGraphFixtureAsset(asset, grammarMetadata),
          ]),
        ),
      );
      const cursorPluginPaths = [
        '.cursor-plugin/plugin.json',
        'assets/logo.svg',
        'rules/threadnote.mdc',
        'README.md',
        'CHANGELOG.md',
        'LICENSE',
      ];
      const cursorPluginAssets = Object.fromEntries(
        await Promise.all(
          cursorPluginPaths.map(async asset => [
            `cursor-plugin/${asset}`,
            await Bun.file(`cursor-plugin/${asset}`).bytes(),
          ]),
        ),
      );
      if (options.tamperCodeGraphAsset) {
        const firstGrammar = Object.entries(manifest.grammars).sort(([left], [right]) =>
          left.localeCompare(right),
        )[0]?.[1];
        if (firstGrammar === undefined) throw TestError.make({message: 'Code graph fixture manifest has no grammars.'});
        assets[`assets/code-graph/${firstGrammar.path}`] = new TextEncoder().encode('tampered grammar');
      }
      return Bun.Archive.write(
        archivePath,
        {
          ...assets,
          ...cursorPluginAssets,
          [executableName]: '#!/usr/bin/env sh\nexit 0\n',
          'release.json': `${JSON.stringify({
            codeGraphAssets: {
              manifest: 'assets/code-graph/manifest.json',
              version: 1,
            },
            codeSignature:
              executableName === 'threadnote.exe'
                ? 'unsigned'
                : process.platform === 'darwin'
                  ? 'developer-id'
                  : 'none',
            executable: executableName,
            nativeRuntime: 'runtime/node-llama-cpp.js',
            nativeRuntimePackage: '@node-llama-cpp/test',
            runtime: `bun-${Bun.version}`,
            target: `bun-${process.platform}-${process.arch}`,
            version,
          })}\n`,
          'runtime/node-llama-cpp.js': 'export const smoke = true;\n',
          'runtime/native/libfixture.so': 'fixture native payload\n',
          'runtime/native/.keep': '',
        },
        {compress: 'gzip'},
      );
    },
    catch: cause => TestError.make({message: 'Could not create updater fixture archive.', cause}),
  });
}

async function codeGraphFixtureAsset(
  asset: string,
  grammars: readonly {
    readonly license: string;
    readonly licensePackagePath?: string;
    readonly packagePath?: string;
    readonly path: string;
  }[],
): Promise<Uint8Array> {
  const bundled = Bun.file(`assets/code-graph/${asset}`);
  if (await bundled.exists()) return bundled.bytes();
  const grammar = grammars.find(value => value.path === asset);
  if (grammar?.packagePath) return Bun.file(grammar.packagePath).bytes();
  const license = grammars.find(value => value.license === asset);
  if (license?.licensePackagePath) return Bun.file(license.licensePackagePath).bytes();
  throw TestError.make({message: `Missing code graph fixture asset: ${asset}`});
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
