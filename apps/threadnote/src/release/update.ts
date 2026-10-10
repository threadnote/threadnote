import {Clock, Console, Crypto, DateTime, Effect, FileSystem, Path, Result, Schema} from 'effect';
import {
  heading,
  info as infoText,
  keyValue,
  promptForConfirmation,
  success,
  warning,
  withSpinnerEffect,
} from '../cli_ui.js';
import {installCommandShim} from '../command-shim.js';
import {extractGzipTar} from '../effect/archive.js';
import {runCommandEffect, runStreamingCommandEffect} from '@threadnote/platform/command';
import {maybeRunEffect} from '../effect/command-presentation.js';
import {applicationError, fromSync} from '@threadnote/platform/errors';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {writeFinalCliOutput} from '../effect/cli/output.js';
import {getJsonEffect, HttpService} from '@threadnote/platform/http';
import {sha256FileHex} from '@threadnote/platform/digest';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {
  activeInstalledVersion,
  activateStandaloneRelease,
  executingInstalledRelease,
  installationRoot,
  promoteStandaloneReleaseDirectory,
  pruneStandaloneReleases,
  type StandalonePromotionFaultInjection,
  withStandaloneInstallationLock,
} from '../installations.js';
import {hasLegacyLifecycleHandoffCandidates, hasProjectNameMigrationCandidates} from '../memory/index.js';
import {isLegacyHomeMigrationPending, isThreadnoteHomeMigrationPending} from '../migration/home.js';
import {whatsNewLinesForVersionRange} from './notes.js';
import {GITHUB_RELEASES_URL, githubReleaseHeaders, isOfficialGitHubReleasesUrl} from './github_auth.js';
import {redactSensitiveText} from '@threadnote/platform/scrubber';
import {sendSystemNotification} from '../system_notification.js';
import {readTelemetryConsentRenewal} from '../telemetry/config.js';
import type {JsonObject} from '@threadnote/platform/json';
import type {PostUpdateOptions, UpdateOptions} from '../types.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {selectUpdateChannel, type UpdateChannel} from './channel.js';
import {isDevelopmentBuildVersion} from './version/compare.js';
import {isStandaloneThreadnoteBuild} from '@threadnote/workspace/runtime-version';
import {
  compareVersions,
  ensureDirectory,
  currentPackageVersion,
  isJsonObject,
  readFileIfExists,
  formatShellCommand,
} from '../utils.js';
import {errorMessage} from '@threadnote/platform/errors';
import {toolRoot} from '@threadnote/workspace/installation';

class UpdateOperationError extends Schema.TaggedError<UpdateOperationError>()('UpdateOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const THREADNOTE_COMMAND = 'threadnote';
const DEFAULT_RELEASE_SOURCE = GITHUB_RELEASES_URL;
const ALLOW_UNTRUSTED_SOURCE_ENV = 'THREADNOTE_ALLOW_UNTRUSTED_RELEASE_SOURCE';
const RELEASE_SOURCE_ENV = 'THREADNOTE_RELEASE_SOURCE';
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const POST_UPDATE_MIGRATIONS_FILE = 'post-update-migrations.json';
const POST_UPDATE_STATE_FILE = 'post-update-state.json';
const POST_UPDATE_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 60_000,
  waitTimeoutMilliseconds: 10 * 60_000,
} as const;
export const STREAMING_SUBCOMMAND_FAILURE_DETAIL_LIMIT = 2_000;

interface UpdateInfo {
  readonly channel: UpdateChannel;
  readonly currentVersion: string;
  readonly installedVersion: string | undefined;
  readonly isChannelSwitch: boolean;
  readonly isUpdateAvailable: boolean;
  readonly isVersionUpgrade: boolean;
  readonly latestVersion: string | undefined;
  readonly source: string;
  readonly usedCache: boolean;
}

interface UpdateCache {
  readonly channel: UpdateChannel;
  readonly checkedAt: string;
  readonly latestVersion: string;
  readonly source: string;
  readonly version: 2;
}

interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
}

interface AvailableRelease {
  readonly assets: readonly ReleaseAsset[];
  readonly immutable: true;
  readonly prerelease: boolean;
  readonly version: string;
}

interface PostUpdateMigration {
  readonly appliesToPrereleases?: boolean;
  readonly commandArgs: readonly string[];
  readonly description: readonly string[];
  readonly id: string;
  readonly instructions: readonly string[];
  readonly introducedIn: string;
  readonly markHandledWhenSkipped?: boolean;
  readonly requiresExplicitTelemetryConsent?: boolean;
  readonly requiresLegacyHandoffs?: boolean;
  readonly requiresLegacyHomeMigration?: boolean;
  readonly requiresPendingHomeMigration?: boolean;
  readonly requiresProjectNameConsolidation?: boolean;
  readonly requiresTelemetryConsentRenewal?: boolean;
  readonly title: string;
}

interface PostUpdateState {
  readonly handledMigrationIds: readonly string[];
}

interface PostUpdateMigrationRunOptions {
  readonly dryRun: boolean;
  readonly fromVersion: string;
  readonly interactive: boolean;
  readonly markHandled: boolean;
  readonly repairFallback?: boolean;
  readonly toVersion: string;
  readonly yes: boolean;
}

export function maybeNotifyUpdate(config: RuntimeConfig, options: {readonly dryRun?: boolean} = {}) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    if (isUpdateNotificationDisabled(system.environment())) {
      return;
    }
    const packageVersion = yield* currentPackageVersion();
    if (isDevelopmentBuildVersion(packageVersion)) {
      return;
    }
    const source = yield* fromSync('resolve release source', () =>
      resolveReleaseSource(undefined, false, system.environment()),
    );
    let info = yield* getUpdateInfo(config, {
      allowCacheWrite: options.dryRun !== true,
      preferFresh: false,
      preferInstalledVersion: false,
      source,
      requestedChannel: undefined,
    });
    if (info.isUpdateAvailable && info.usedCache) {
      info = yield* getUpdateInfo(config, {
        allowCacheWrite: options.dryRun !== true,
        preferFresh: true,
        preferInstalledVersion: false,
        source,
        requestedChannel: undefined,
      });
    }
    if (info.isUpdateAvailable) {
      yield* Console.log('');
      yield* Console.log(warning(`Update available: threadnote ${info.currentVersion} -> ${info.latestVersion}`));
      yield* Console.log(`Run: ${infoText('threadnote update')}`);
    }
  }).pipe(Effect.ignore);
}

export const runUpdate = Effect.fn('runUpdate')(function* (config: RuntimeConfig, options: UpdateOptions) {
  const system = yield* SystemInfo;
  const requestedChannel = yield* fromSync('select update channel', () => requestedUpdateChannel(options));
  const source = yield* fromSync('resolve release source', () =>
    resolveReleaseSource(options.source, options.allowUntrustedSource, system.environment()),
  );
  const info = yield* withSpinnerEffect(
    'Checking GitHub for the latest standalone Threadnote release',
    getUpdateInfo(config, {
      allowCacheWrite: options.dryRun !== true,
      preferFresh: true,
      preferInstalledVersion: true,
      source,
      requestedChannel,
    }),
  );

  if (options.check === true && options.json === true) {
    if (requiresFreshStandaloneInstall(info.currentVersion)) {
      return yield* UpdateOperationError.make({
        message:
          'Threadnote 3 cannot update across the standalone-runtime boundary. Install Threadnote 4 fresh from the GitHub release installer.',
      });
    }
    yield* writeFinalCliOutput(
      JSON.stringify({
        channel: info.channel,
        currentVersion: info.currentVersion,
        isChannelSwitch: info.isChannelSwitch,
        isUpdateAvailable: info.isUpdateAvailable,
        isVersionUpgrade: info.isVersionUpgrade,
        latestVersion: info.latestVersion ?? null,
        requestedChannel: requestedChannel ?? null,
        source: info.source,
        type: 'threadnote-update-check',
        usedCache: info.usedCache,
        version: 1,
      }),
    );
    return;
  }

  yield* Console.log(keyValue('Current version', infoText(info.currentVersion)));
  yield* Console.log(
    keyValue(
      latestUpdateVersionLabel(info.channel),
      info.latestVersion ? infoText(info.latestVersion) : warning('not published'),
    ),
  );
  yield* Console.log(keyValue('Release source', info.source));
  if (requiresFreshStandaloneInstall(info.currentVersion)) {
    return yield* UpdateOperationError.make({
      message:
        'Threadnote 3 cannot update across the standalone-runtime boundary. Install Threadnote 4 fresh from the GitHub release installer.',
    });
  }

  if (info.latestVersion === undefined) {
    yield* Console.log('No release is currently published for the selected channel.');
    return;
  }
  const latestVersion = info.latestVersion;

  if (options.check === true) {
    if (info.isUpdateAvailable) {
      const command =
        requestedChannel === 'beta'
          ? 'threadnote update --beta'
          : requestedChannel === 'latest'
            ? 'threadnote update --stable'
            : 'threadnote update';
      yield* Console.log(warning(`${info.isChannelSwitch ? 'Channel switch' : 'Update'} available. Run: ${command}`));
      yield* printWhatsNewIfAvailable(info);
    } else {
      yield* Console.log(
        compareVersions(info.currentVersion, latestVersion) > 0
          ? warning(`Current version is newer than the published ${info.channel} release.`)
          : success('Threadnote is up to date.'),
      );
    }
    return;
  }

  if (!info.isUpdateAvailable && options.force !== true) {
    if (info.installedVersion !== undefined) {
      yield* withStandaloneInstallationLock(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const mutationInstalledVersion = (yield* activeInstalledVersion()) ?? info.installedVersion!;
          const activeReleaseRoot = path.join(installationRoot(path, system), 'versions', mutationInstalledVersion);
          yield* installCommandShim(options.dryRun === true, activeReleaseRoot, config.agentContextHome);
        }),
        options.dryRun === true,
      );
    }
    yield* Console.log(success('Threadnote is up to date.'));
    yield* Console.log(
      'Managed launchers are current. If an MCP host still uses the legacy direct server command, run `threadnote repair`, then restart that host once.',
    );
    return;
  }

  if (!isUpdateTargetAllowed(info.currentVersion, latestVersion, requestedChannel)) {
    return yield* updateDowngradeError(info.currentVersion, latestVersion);
  }

  const shouldRepair = options.repair !== false;
  const dryRun = options.dryRun === true;
  const mutation = yield* withStandaloneInstallationLock(
    Effect.gen(function* () {
      const lockedInstalledVersion = yield* activeInstalledVersion();
      const currentVersion = lockedInstalledVersion ?? info.currentVersion;
      if (!isUpdateTargetAllowed(currentVersion, latestVersion, requestedChannel)) {
        return yield* updateDowngradeError(currentVersion, latestVersion);
      }
      const installed = yield* installStandaloneRelease({
        dryRun,
        force: options.force === true,
        source,
        version: latestVersion,
      });
      yield* installCommandShim(dryRun, installed, config.agentContextHome);
      yield* activateStandaloneRelease(installed, dryRun);
      return {currentVersion, releaseRoot: installed};
    }),
    dryRun,
  );
  const {currentVersion: effectiveCurrentVersion, releaseRoot} = mutation;
  const path = yield* Path.Path;
  const threadnoteCommand = path.join(releaseRoot, system.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
  const postUpdateArgs = [
    'post-update',
    '--from-version',
    effectiveCurrentVersion,
    '--to-version',
    latestVersion,
    ...(options.yes === true ? ['--yes'] : []),
  ];
  // The child announces only when it finds evidence-backed work. Keeping the
  // wrapper quiet prevents fresh installs from looking as if a migration was
  // offered when the post-update command intentionally produced no output.
  const postUpdateResult =
    options.postUpdate === false
      ? undefined
      : yield* Effect.result(runStreamingSubcommand(dryRun, threadnoteCommand, postUpdateArgs, false));
  if (options.postUpdate === false) {
    yield* Console.log('Skipping post-update migration prompts because --no-post-update was provided.');
  } else if (postUpdateResult !== undefined && Result.isFailure(postUpdateResult) && shouldRepair) {
    // Promotion already succeeded. Keep going so MCP/hooks still get repaired
    // even when the new binary's post-update child exits non-zero.
    yield* Console.error(
      warning(
        `Post-update did not finish. Continuing with local setup repair. ${errorMessage(postUpdateResult.failure)}`,
      ),
    );
  }
  if (shouldRepair) {
    yield* Console.log('');
    yield* Console.log('Repairing local Threadnote setup after standalone update.');
    yield* runStreamingSubcommand(dryRun, threadnoteCommand, ['repair', '--no-post-update']);
  } else {
    yield* Console.log(
      'Skipping local integration repair because --no-repair was provided. MCP host configurations were not refreshed.',
    );
  }
  yield* withStandaloneInstallationLock(pruneStandaloneReleases(releaseRoot, dryRun), dryRun);
  if (postUpdateResult !== undefined && Result.isFailure(postUpdateResult)) {
    return yield* postUpdateResult.failure;
  }
  yield* Console.log(
    shouldRepair
      ? 'Update complete. Brokered MCP sessions will use the new version on their next request. Legacy direct-server sessions migrated by repair require one host restart.'
      : 'Update complete. Brokered MCP sessions will use the new version on their next request. Hosts still using the legacy direct server command must run `threadnote repair` and restart once.',
  );
  yield* printWhatsNewIfAvailable(info);
});

function updateDowngradeError(currentVersion: string, targetVersion: string): UpdateOperationError {
  return UpdateOperationError.make({
    message: `Refusing to downgrade Threadnote ${currentVersion} to ${targetVersion}. --force does not permit version downgrades; only an explicit beta-to-stable channel switch with --stable may install an older version.`,
  });
}

const installStandaloneRelease = Effect.fn('update.installStandaloneRelease')(function* (options: {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly source: string;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const releaseRoot = path.join(installationRoot(path, system), 'versions', options.version);
  const artifactName = releaseArtifactName(system);
  const releases = yield* fetchAvailableReleases(options.source);
  const release = releases.find(candidate => compareVersions(candidate.version, options.version) === 0);
  if (!release) {
    return yield* UpdateOperationError.make({message: `GitHub release ${options.version} is no longer available.`});
  }
  const archiveAsset = release.assets.find(asset => asset.name === artifactName);
  const checksumAsset = release.assets.find(asset => asset.name === `${artifactName}.sha256`);
  if (!archiveAsset || !checksumAsset) {
    return yield* UpdateOperationError.make({
      message: `Release ${options.version} does not publish ${artifactName} and ${artifactName}.sha256 for this platform.`,
    });
  }
  if (options.dryRun) {
    yield* Console.log(`Would download verified release artifact: ${archiveAsset.url}`);
    yield* Console.log(`Would install standalone Threadnote to: ${releaseRoot}`);
    return releaseRoot;
  }

  yield* fs.makeDirectory(path.dirname(releaseRoot), {recursive: true, mode: 0o700});
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temporaryRoot = yield* fs.makeTempDirectoryScoped({
        directory: path.dirname(releaseRoot),
        prefix: '.threadnote-update-',
      });
      const archivePath = path.join(temporaryRoot, artifactName);
      const extractedRoot = path.join(temporaryRoot, 'release');
      const http = yield* HttpService;
      yield* Console.log(`Downloading ${artifactName}`);
      yield* http.downloadToFile(archiveAsset.url, archivePath, {
        headers: releaseRequestHeaders(),
        timeoutMs: 10 * 60_000,
      });
      const checksumResponse = yield* http.getText(checksumAsset.url, {
        headers: releaseRequestHeaders(),
        timeoutMs: 30_000,
      });
      const expectedChecksum = yield* fromSync('parse release checksum', () =>
        parseReleaseChecksum(checksumResponse.body, artifactName),
      );
      const actualChecksum = yield* sha256FileHex(archivePath);
      if (actualChecksum !== expectedChecksum) {
        return yield* UpdateOperationError.make({
          message: `Checksum mismatch for ${artifactName}: expected ${expectedChecksum}, got ${actualChecksum}.`,
        });
      }
      yield* extractGzipTar(archivePath, extractedRoot);
      yield* validateExtractedRelease(fs, path, extractedRoot, options.version, system.platform);
      yield* verifyOfficialPlatformSignature(fs, path, extractedRoot, options.source, system);
      yield* promoteReleaseDirectory(fs, path, extractedRoot, releaseRoot, options.force, system.processId);
      yield* Console.log(`Installed standalone Threadnote ${options.version}: ${releaseRoot}`);
      return releaseRoot;
    }),
  );
});

export const verifyOfficialPlatformSignature = Effect.fn('update.verifyOfficialPlatformSignature')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
  source: string,
  system: SystemInfoShape,
) {
  if (!isOfficialGitHubReleasesUrl(source) || system.platform === 'linux') return;
  const executable = path.join(releaseRoot, system.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
  if (system.platform === 'darwin') {
    for (const file of yield* findFilesRecursively(fs, path, path.join(releaseRoot, 'runtime'))) {
      const type = yield* runCommandEffect('file', ['--brief', file]);
      if (!type.stdout.includes('Mach-O')) continue;
      yield* runCommandEffect('codesign', ['--verify', '--strict', '--verbose=2', file]).pipe(
        Effect.mapError(cause =>
          UpdateOperationError.make({cause, message: `Release signature validation failed for ${file}.`}),
        ),
      );
    }
    yield* runCommandEffect('codesign', ['--verify', '--strict', '--verbose=2', executable]).pipe(
      Effect.mapError(cause =>
        UpdateOperationError.make({cause, message: `Release signature validation failed for ${executable}.`}),
      ),
    );
    return;
  }
  const metadataContent = yield* fs
    .readFileString(path.join(releaseRoot, 'release.json'))
    .pipe(
      Effect.mapError(cause => UpdateOperationError.make({cause, message: 'Release signature policy is invalid.'})),
    );
  const metadata = yield* Effect.try({
    try: () => JSON.parse(metadataContent) as unknown,
    catch: cause => UpdateOperationError.make({cause, message: 'Release signature policy is invalid.'}),
  });
  if (!isJsonObject(metadata) || metadata.codeSignature !== 'unsigned') {
    return yield* UpdateOperationError.make({message: 'Release signature policy is invalid for Windows.'});
  }
  yield* Console.log(
    warning('This Windows release is unsigned. Its immutable GitHub release and SHA-256 checksum were verified.'),
  );
});

const findFilesRecursively = Effect.fn('update.findFilesRecursively')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  if (!(yield* fs.exists(root))) return [] as readonly string[];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const name of yield* fs.readDirectory(directory)) {
      const entry = path.join(directory, name);
      const info = yield* fs.stat(entry);
      if (info.type === 'Directory') pending.push(entry);
      else if (info.type === 'File') files.push(entry);
    }
  }
  return files.sort();
});

export function releaseArtifactName(system: Pick<SystemInfoShape, 'architecture' | 'platform'>): string {
  const platform = system.platform === 'win32' ? 'windows' : system.platform === 'darwin' ? 'darwin' : system.platform;
  const architecture = system.architecture === 'aarch64' ? 'arm64' : system.architecture;
  if (!['darwin', 'linux', 'windows'].includes(platform) || !['arm64', 'x64'].includes(architecture)) {
    throw UpdateOperationError.make({
      message: `No standalone Threadnote artifact is available for ${platform}-${architecture}.`,
    });
  }
  return `threadnote-${platform}-${architecture}.tar.gz`;
}

function releaseRequestHeaders(): Readonly<Record<string, string>> {
  return {
    accept: 'application/octet-stream',
    'user-agent': 'threadnote-cli',
  };
}

export function parseReleaseChecksum(content: string, artifactName: string): string {
  const line = content
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(value => value.length > 0);
  const parsed = line ? parseReleaseChecksumLine(line) : undefined;
  if (!parsed || (parsed.artifact !== undefined && parsed.artifact !== artifactName)) {
    throw UpdateOperationError.make({message: `Invalid checksum document for ${artifactName}.`});
  }
  return parsed.digest.toLowerCase();
}

function parseReleaseChecksumLine(line: string): {readonly artifact?: string; readonly digest: string} | undefined {
  const digest = line.slice(0, 64);
  if (digest.length !== 64 || [...digest].some(character => !'0123456789abcdefABCDEF'.includes(character))) {
    return undefined;
  }
  if (line.length === 64) return {digest};
  const separator = line[64];
  if (separator !== ' ' && separator !== '\t') return undefined;
  let artifact = line.slice(64).trimStart();
  if (artifact.startsWith('*')) artifact = artifact.slice(1);
  return artifact ? {artifact, digest} : undefined;
}

const validateExtractedRelease = Effect.fn('update.validateExtractedRelease')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
  version: string,
  platform: NodeJS.Platform,
) {
  const metadataContent = yield* fs.readFileString(path.join(releaseRoot, 'release.json'));
  const metadata = yield* Effect.try({
    try: () => JSON.parse(metadataContent) as unknown,
    catch: cause => UpdateOperationError.make({cause, message: 'Release metadata is invalid.'}),
  });
  const executable = platform === 'win32' ? 'threadnote.exe' : 'threadnote';
  if (
    !isJsonObject(metadata) ||
    metadata.version !== version ||
    metadata.executable !== executable ||
    !isJsonObject(metadata.codeGraphAssets) ||
    metadata.codeGraphAssets.manifest !== 'assets/code-graph/manifest.json' ||
    metadata.codeGraphAssets.version !== 1 ||
    !(yield* fs.exists(path.join(releaseRoot, executable))) ||
    !(yield* fs.exists(path.join(releaseRoot, 'runtime', 'node-llama-cpp.js')))
  ) {
    return yield* UpdateOperationError.make({message: `Release artifact validation failed for Threadnote ${version}.`});
  }
  yield* validateCodeGraphAssets(fs, path, releaseRoot);
  if (platform !== 'win32') {
    yield* fs.chmod(path.join(releaseRoot, executable), 0o755);
  }
});

const validateCodeGraphAssets = Effect.fn('update.validateCodeGraphAssets')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
) {
  const manifestPath = path.join(releaseRoot, 'assets', 'code-graph', 'manifest.json');
  const content = yield* fs.readFileString(manifestPath);
  const manifest = yield* Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: cause => UpdateOperationError.make({cause, message: 'Code graph asset manifest is invalid.'}),
  });
  if (!isJsonObject(manifest) || manifest.version !== 1 || !isJsonObject(manifest.runtime)) {
    return yield* UpdateOperationError.make({message: 'Code graph asset manifest is invalid.'});
  }
  const grammars = isJsonObject(manifest.grammars) ? manifest.grammars : {};
  const expected = [
    {
      id: 'web-tree-sitter',
      metadata: manifest.runtime,
      path: 'runtime/web-tree-sitter.wasm',
      runtime: true,
    },
    ...Object.entries(grammars)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, metadata]) => ({id, metadata, runtime: false})),
  ];
  for (const asset of expected) {
    if (
      !isJsonObject(asset.metadata) ||
      typeof asset.metadata.path !== 'string' ||
      typeof asset.metadata.version !== 'string' ||
      typeof asset.metadata.source !== 'string' ||
      !asset.metadata.source.startsWith('https://github.com/') ||
      typeof asset.metadata.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(asset.metadata.sha256) ||
      (asset.runtime
        ? asset.metadata.id !== asset.id
        : !Number.isInteger(asset.metadata.abi) || Number(asset.metadata.abi) <= 0)
    ) {
      return yield* UpdateOperationError.make({message: `Code graph asset metadata is invalid for ${asset.id}.`});
    }
    const assetPath = path.join(releaseRoot, 'assets', 'code-graph', ...asset.metadata.path.split('/'));
    if (!(yield* fs.exists(assetPath)) || (yield* sha256FileHex(assetPath)) !== asset.metadata.sha256) {
      return yield* UpdateOperationError.make({
        message: `Code graph asset checksum validation failed for ${asset.metadata.path}.`,
      });
    }
    if (!asset.runtime) {
      if (typeof asset.metadata.license !== 'string') {
        return yield* UpdateOperationError.make({
          message: `Code graph asset license metadata is missing for ${asset.id}.`,
        });
      }
      const licensePath = path.join(releaseRoot, 'assets', 'code-graph', ...asset.metadata.license.split('/'));
      if (!(yield* fs.exists(licensePath)) || (yield* fs.stat(licensePath)).size <= 0) {
        return yield* UpdateOperationError.make({
          message: `Code graph asset license is missing for ${asset.metadata.license}.`,
        });
      }
      if (typeof asset.metadata.builderLicense === 'string') {
        const builderLicensePath = path.join(
          releaseRoot,
          'assets',
          'code-graph',
          ...asset.metadata.builderLicense.split('/'),
        );
        if (!(yield* fs.exists(builderLicensePath)) || (yield* fs.stat(builderLicensePath)).size <= 0) {
          return yield* UpdateOperationError.make({
            message: `Code graph asset builder license is missing for ${asset.metadata.builderLicense}.`,
          });
        }
      }
    }
  }
  const runtimeLicense = path.join(releaseRoot, 'assets', 'code-graph', 'licenses', 'web-tree-sitter.LICENSE');
  if (!(yield* fs.exists(runtimeLicense)) || (yield* fs.stat(runtimeLicense)).size <= 0) {
    return yield* UpdateOperationError.make({
      message: 'Code graph asset license is missing for web-tree-sitter.LICENSE.',
    });
  }
});

export const promoteReleaseDirectory = Effect.fn('update.promoteReleaseDirectory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stagedRoot: string,
  releaseRoot: string,
  force: boolean,
  processId: number,
  faultInjection: StandalonePromotionFaultInjection = {},
) {
  void force;
  yield* promoteStandaloneReleaseDirectory(fs, path, stagedRoot, releaseRoot, processId, faultInjection);
});

function printWhatsNewIfAvailable(info: UpdateInfo) {
  if (!info.isVersionUpgrade || info.latestVersion === undefined) {
    return Effect.void;
  }
  const latestVersion = info.latestVersion;
  return Effect.gen(function* () {
    yield* Console.log('');
    const whatsNew = yield* withSpinnerEffect(
      'Fetching GitHub release notes',
      whatsNewLinesForVersionRange(info.currentVersion, latestVersion, {
        includePrereleases: info.channel === 'beta',
      }),
    );
    for (const line of whatsNew) {
      yield* Console.log(line === "What's new:" ? heading(line) : line);
    }
  });
}

export const runPostUpdate = Effect.fn('runPostUpdate')(function* (config: RuntimeConfig, options: PostUpdateOptions) {
  if (!options.fromVersion || !options.toVersion) {
    return yield* applicationError(
      'validate post-update options',
      UpdateOperationError.make({message: 'Provide --from-version and --to-version for post-update.'}),
    );
  }
  const fromVersion = options.fromVersion;
  const toVersion = options.toVersion;
  const system = yield* SystemInfo;
  const interactive = system.stdinIsTTY && system.stdoutIsTTY;
  yield* runApplicablePostUpdateMigrations(config, {
    dryRun: options.dryRun === true,
    fromVersion,
    interactive,
    markHandled: true,
    toVersion,
    yes: options.yes === true,
  });
});

export function maybeRunPostUpdateAfterRepair(config: RuntimeConfig, options: {readonly dryRun: boolean}) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const toVersion = yield* currentPackageVersion();
    const interactive = system.stdinIsTTY && system.stdoutIsTTY;
    yield* runApplicablePostUpdateMigrations(config, {
      dryRun: options.dryRun,
      fromVersion: '0.0.0',
      interactive,
      markHandled: true,
      repairFallback: true,
      toVersion,
      yes: false,
    });
  });
}

/**
 * Run a subprocess with live stdout/stderr. Interactive TTYs inherit stdio;
 * non-TTY callers (including the detached auto-update worker) pipe and capture
 * output so a non-zero exit still has a diagnosable message. Dry-run defers to
 * `maybeRun` so it only prints the command it would run.
 */
function runStreamingSubcommand(
  dryRun: boolean,
  executable: string,
  args: readonly string[],
  announce: boolean = true,
) {
  if (dryRun) {
    return maybeRunEffect(true, executable, args).pipe(
      Effect.asVoid,
      Effect.mapError(cause => applicationError('run interactive subcommand', cause)),
    );
  }
  return Effect.gen(function* () {
    if (announce) yield* Console.log(`Running: ${formatShellCommand(executable, args)}`);
    const system = yield* SystemInfo;
    const result = yield* runStreamingCommandEffect(executable, args, {
      inheritOutput: system.stdoutIsTTY,
      inheritStdin: system.stdinIsTTY,
    });
    if (result.exitCode !== 0) {
      return yield* applicationError(
        'run interactive subcommand',
        UpdateOperationError.make({message: streamingSubcommandFailureMessage(executable, args, result)}),
      );
    }
  });
}

/** @internal Exported so failure-text redaction and truncation can be property-tested. */
export function streamingSubcommandFailureMessage(
  executable: string,
  args: readonly string[],
  result: {readonly exitCode: number; readonly stderr: string; readonly stdout: string},
): string {
  const command = formatShellCommand(executable, args);
  const preferred = redactSensitiveText(result.stderr.trim() || result.stdout.trim());
  if (preferred.length === 0) {
    return `${command} exited with ${result.exitCode}.`;
  }
  const truncated =
    preferred.length > STREAMING_SUBCOMMAND_FAILURE_DETAIL_LIMIT
      ? `…${preferred.slice(-STREAMING_SUBCOMMAND_FAILURE_DETAIL_LIMIT)}`
      : preferred;
  return `${command} exited with ${result.exitCode}. ${truncated}`;
}

function getUpdateInfo(
  config: RuntimeConfig,
  options: {
    readonly allowCacheWrite: boolean;
    readonly preferFresh: boolean;
    readonly preferInstalledVersion: boolean;
    readonly source: string;
    readonly requestedChannel: UpdateChannel | undefined;
  },
) {
  return Effect.gen(function* () {
    const packageVersion = yield* currentPackageVersion();
    const standaloneBuild = isStandaloneThreadnoteBuild();
    const runningInstalledRelease =
      options.preferInstalledVersion && standaloneBuild && !isDevelopmentBuildVersion(packageVersion)
        ? (yield* executingInstalledRelease()) !== undefined
        : false;
    const installedVersion = shouldPreferActiveInstalledVersion({
      packageVersion,
      preferInstalledVersion: options.preferInstalledVersion,
      runningInstalledRelease,
      standaloneBuild,
    })
      ? yield* activeInstalledVersion()
      : undefined;
    const currentVersion = installedVersion ?? packageVersion;
    const inferredChannel = selectUpdateChannel(currentVersion);
    const channel = selectUpdateChannel(currentVersion, options.requestedChannel);
    const cached = options.preferFresh ? undefined : yield* readFreshCache(config, options.source, channel);
    const latestVersion = cached?.latestVersion ?? (yield* fetchLatestVersion(options.source, channel));
    if (!cached && latestVersion !== undefined && options.allowCacheWrite) {
      yield* writeUpdateCache(config, {
        channel,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        latestVersion,
        source: options.source,
        version: 2,
      });
    }
    const isChannelSwitch =
      latestVersion !== undefined &&
      options.requestedChannel === 'latest' &&
      inferredChannel === 'beta' &&
      selectUpdateChannel(latestVersion) === 'latest';
    const isVersionUpgrade = latestVersion !== undefined && compareVersions(currentVersion, latestVersion) < 0;
    return {
      channel,
      currentVersion,
      installedVersion,
      isChannelSwitch,
      isUpdateAvailable: latestVersion !== undefined && (isChannelSwitch || isVersionUpgrade),
      isVersionUpgrade,
      latestVersion,
      source: options.source,
      usedCache: cached !== undefined,
    };
  });
}

export function shouldPreferActiveInstalledVersion(options: {
  readonly packageVersion: string;
  readonly preferInstalledVersion: boolean;
  readonly runningInstalledRelease: boolean;
  readonly standaloneBuild: boolean;
}): boolean {
  return (
    options.preferInstalledVersion &&
    !requiresFreshStandaloneInstall(options.packageVersion) &&
    (!options.standaloneBuild || isDevelopmentBuildVersion(options.packageVersion) || options.runningInstalledRelease)
  );
}

export function requestedUpdateChannel(options: Pick<UpdateOptions, 'beta' | 'stable'>): UpdateChannel | undefined {
  if (options.beta === true && options.stable === true) {
    throw UpdateOperationError.make({message: 'Choose either --beta or --stable, not both.'});
  }
  if (options.beta === true) {
    return 'beta';
  }
  if (options.stable === true) {
    return 'latest';
  }
  return undefined;
}

export function isUpdateTargetAllowed(
  currentVersion: string,
  targetVersion: string,
  requestedChannel: UpdateChannel | undefined,
): boolean {
  if (compareVersions(currentVersion, targetVersion) <= 0) return true;
  return (
    requestedChannel === 'latest' &&
    selectUpdateChannel(currentVersion) === 'beta' &&
    selectUpdateChannel(targetVersion) === 'latest'
  );
}

export function latestUpdateVersionLabel(channel: UpdateChannel): string {
  return channel === 'beta' ? 'Latest beta-channel version' : 'Latest version';
}

export function requiresFreshStandaloneInstall(version: string): boolean {
  const major = Number.parseInt(stableVersionCore(version).split('.', 1)[0] ?? '', 10);
  return Number.isSafeInteger(major) && major < 4;
}

export {currentPackageVersion};

export const fetchLatestVersion = Effect.fn('fetchLatestVersion')(function* (
  source: string = DEFAULT_RELEASE_SOURCE,
  channel: UpdateChannel = 'latest',
) {
  const releases = yield* fetchAvailableReleases(source);
  const candidates = channel === 'beta' ? releases : releases.filter(release => !release.prerelease);
  return candidates.sort((left, right) => compareVersions(right.version, left.version))[0]?.version;
});

const fetchAvailableReleases = Effect.fn('update.fetchAvailableReleases')(function* (source: string) {
  const headers = yield* githubReleaseHeaders(source);
  const response = yield* getJsonEffect(source, {
    headers,
    timeoutMs: 5000,
  }).pipe(
    Effect.mapError(cause =>
      applicationError(
        'check GitHub for updates',
        UpdateOperationError.make({cause, message: `Could not check GitHub for updates: ${errorMessage(cause)}`}),
      ),
    ),
  );
  if (!Array.isArray(response.body)) {
    return yield* applicationError(
      'check GitHub for updates',
      UpdateOperationError.make({message: 'GitHub releases response was not an array.'}),
    );
  }
  return response.body.flatMap(parseAvailableRelease);
});

function parseAvailableRelease(value: unknown): readonly AvailableRelease[] {
  if (!isJsonObject(value) || value.draft === true || value.immutable !== true || typeof value.tag_name !== 'string') {
    return [];
  }
  const version = value.tag_name.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !Array.isArray(value.assets)) {
    return [];
  }
  const assets = value.assets.flatMap(asset => {
    if (!isJsonObject(asset) || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') {
      return [];
    }
    return [{name: asset.name, url: asset.browser_download_url}];
  });
  return [{assets, immutable: true, prerelease: value.prerelease === true, version}];
}

const readFreshCache = Effect.fn('update.readFreshCache')(function* (
  config: RuntimeConfig,
  source: string,
  channel: UpdateChannel,
) {
  const rawCache = yield* readFileIfExists(yield* updateCachePath(config));
  if (!rawCache) {
    return undefined;
  }
  const parsedResult = Result.try((): unknown => JSON.parse(rawCache));
  if (Result.isFailure(parsedResult)) {
    return undefined;
  }
  const parsed = parsedResult.success;
  if (
    !isJsonObject(parsed) ||
    parsed.version !== 2 ||
    parsed.channel !== channel ||
    typeof parsed.checkedAt !== 'string' ||
    typeof parsed.latestVersion !== 'string' ||
    parsed.source !== source
  ) {
    return undefined;
  }
  const checkedAt = Date.parse(parsed.checkedAt);
  if (!Number.isFinite(checkedAt) || (yield* Clock.currentTimeMillis) - checkedAt > UPDATE_CHECK_TTL_MS) {
    return undefined;
  }
  return {
    channel,
    checkedAt: parsed.checkedAt,
    latestVersion: parsed.latestVersion,
    source,
    version: 2,
  } satisfies UpdateCache;
});

const writeUpdateCache = Effect.fn('update.writeCache')(function* (config: RuntimeConfig, cache: UpdateCache) {
  const fs = yield* FileSystem.FileSystem;
  yield* ensureDirectory(config.agentContextHome, false);
  yield* fs.writeFileString(yield* updateCachePath(config), `${JSON.stringify(cache, null, 2)}\n`, {mode: 0o600});
});

const updateCachePath = Effect.fn('update.cachePath')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, 'update-check.json');
});

const runApplicablePostUpdateMigrations = Effect.fn('update.runApplicableMigrations')(function* (
  config: RuntimeConfig,
  options: PostUpdateMigrationRunOptions,
) {
  const run = runApplicablePostUpdateMigrationsUnlocked(config, options);
  if (options.dryRun) return yield* run;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withExclusiveFileLock(
    fs,
    path.join(config.agentContextHome, 'locks', 'post-update-migrations.lock'),
    POST_UPDATE_LOCK_OPTIONS,
    run,
  );
});

const runApplicablePostUpdateMigrationsUnlocked = Effect.fn('update.runApplicableMigrationsUnlocked')(function* (
  config: RuntimeConfig,
  options: PostUpdateMigrationRunOptions,
) {
  const system = yield* SystemInfo;
  if (!options.dryRun) yield* removeInterruptedPostUpdateStateWrites(config);
  const state = yield* readPostUpdateState(config);
  const migrations = yield* applicablePostUpdateMigrations(config, {
    fromVersion: options.fromVersion,
    handledMigrationIds: state.handledMigrationIds,
    toVersion: options.toVersion,
  });
  if (migrations.length === 0) {
    return;
  }

  const threadnoteCommand = currentThreadnoteCommand(system) ?? THREADNOTE_COMMAND;
  let announced = false;
  const handledMigrationIds = new Set(state.handledMigrationIds);
  const checkpoint = (migrationId: string) => {
    if (options.dryRun || !options.markHandled || handledMigrationIds.has(migrationId)) return Effect.void;
    handledMigrationIds.add(migrationId);
    return writePostUpdateState(config, {handledMigrationIds: [...handledMigrationIds].sort()});
  };
  for (const migration of migrations) {
    if (!(yield* migrationRequirementsSatisfied(config, migration))) {
      if (!options.dryRun) yield* checkpoint(migration.id);
      continue;
    }
    if (!announced) {
      announced = true;
      if (options.repairFallback === true) {
        yield* Console.log('');
        yield* Console.log('Repair found package post-update actions.');
        yield* Console.log(
          'This also covers updates launched by older Threadnote versions that only knew how to run repair.',
        );
        if (!options.interactive) {
          yield* Console.log(
            'This process is non-interactive, so Threadnote will print the manual migration command instead of prompting.',
          );
          yield* Console.log(
            `Run the prompt manually with: threadnote post-update --from-version 0.0.0 --to-version ${options.toVersion}`,
          );
        }
      }
      yield* Console.log('');
      yield* Console.log('Post-update actions are available.');
    }
    yield* printPostUpdateMigration(migration);
    if (migration.requiresExplicitTelemetryConsent === true) {
      yield* runStreamingSubcommand(options.dryRun, threadnoteCommand, migration.commandArgs);
      if (options.dryRun) {
        yield* Console.log('After reviewing the preview, explicit consent would still require:');
        yield* Console.log(`  ${formatMigrationCommand(threadnoteCommand, [...migration.commandArgs, '--apply'])}`);
        continue;
      }
      const accepted =
        options.interactive &&
        (yield* promptForConfirmation('Apply the current anonymous telemetry consent now? [y/N] '));
      if (!accepted) {
        yield* Console.log('Telemetry remains disabled. After reviewing the preview, renew explicitly with:');
        yield* Console.log(`  ${formatMigrationCommand(threadnoteCommand, [...migration.commandArgs, '--apply'])}`);
        if (!options.interactive) {
          yield* sendSystemNotification({
            body: 'Anonymous telemetry remains off after its data contract changed. Run threadnote telemetry enable, review the preview, then apply consent explicitly.',
            title: 'Threadnote telemetry consent review',
          });
        }
        continue;
      }
      yield* runStreamingSubcommand(false, threadnoteCommand, [...migration.commandArgs, '--apply']);
      if (yield* migrationRequirementsSatisfied(config, migration)) {
        return yield* applicationError(
          'verify post-update telemetry consent',
          UpdateOperationError.make({
            message: `Migration ${migration.id} exited successfully but telemetry consent still requires renewal; it was not marked handled.`,
          }),
        );
      }
      yield* checkpoint(migration.id);
      for (const instruction of migration.instructions) yield* Console.log(instruction);
      continue;
    }
    const accepted =
      options.dryRun ||
      options.yes ||
      (options.interactive && (yield* promptForConfirmation('Apply this migration now? [y/N] ')));
    if (!accepted) {
      yield* Console.log('Skipped. Run manually later:');
      yield* Console.log(`  ${formatMigrationCommand(threadnoteCommand, migration.commandArgs)}`);
      if (options.interactive && migration.markHandledWhenSkipped === true) {
        yield* checkpoint(migration.id);
      }
      continue;
    }
    yield* runStreamingSubcommand(options.dryRun, threadnoteCommand, migration.commandArgs);
    if (!options.dryRun) {
      if (hasAuthoritativeHomeRequirements(migration) && (yield* migrationRequirementsSatisfied(config, migration))) {
        return yield* applicationError(
          'verify post-update migration',
          UpdateOperationError.make({
            message: `Migration ${migration.id} exited successfully but its filesystem requirements remain pending; it was not marked handled.`,
          }),
        );
      }
      yield* checkpoint(migration.id);
      for (const instruction of migration.instructions) {
        yield* Console.log(instruction);
      }
    } else {
      yield* Console.log('After this migration succeeds, Threadnote will print:');
      for (const instruction of migration.instructions) {
        yield* Console.log(`  ${instruction}`);
      }
    }
  }
});

const applicablePostUpdateMigrations = Effect.fn('update.applicableMigrations')(function* (
  config: RuntimeConfig,
  options: {
    readonly fromVersion: string;
    readonly handledMigrationIds: readonly string[];
    readonly toVersion: string;
  },
) {
  const migrations = yield* readPostUpdateMigrations();
  const handled = new Set(options.handledMigrationIds);
  const applicable: PostUpdateMigration[] = [];
  for (const migration of migrations) {
    if (handled.has(migration.id) && !hasAuthoritativeRequirements(migration)) {
      continue;
    }
    if (compareVersions(options.fromVersion, migration.introducedIn) >= 0 && !hasAuthoritativeRequirements(migration)) {
      continue;
    }
    if (!postUpdateMigrationReached(migration, options.fromVersion, options.toVersion)) {
      continue;
    }
    if (!(yield* migrationRequirementsSatisfied(config, migration))) {
      continue;
    }
    applicable.push(migration);
  }
  return applicable;
});

const migrationRequirementsSatisfied = Effect.fn('update.migrationRequirementsSatisfied')(function* (
  config: RuntimeConfig,
  migration: PostUpdateMigration,
) {
  if (migration.requiresLegacyHandoffs === true && !(yield* hasLegacyLifecycleHandoffCandidates(config))) {
    return false;
  }
  if (
    migration.requiresLegacyHomeMigration === true &&
    !(yield* isLegacyHomeMigrationPending({targetHome: config.agentContextHome}))
  ) {
    return false;
  }
  if (
    migration.requiresPendingHomeMigration === true &&
    !(yield* isThreadnoteHomeMigrationPending({targetHome: config.agentContextHome}))
  ) {
    return false;
  }
  if (migration.requiresProjectNameConsolidation === true && !(yield* hasProjectNameMigrationCandidates(config))) {
    return false;
  }
  if (
    migration.requiresTelemetryConsentRenewal === true &&
    (yield* readTelemetryConsentRenewal(config).pipe(Effect.orElseSucceed(() => undefined))) === undefined
  ) {
    return false;
  }
  return true;
});

function hasAuthoritativeRequirements(migration: PostUpdateMigration): boolean {
  return hasAuthoritativeHomeRequirements(migration) || migration.requiresTelemetryConsentRenewal === true;
}

function hasAuthoritativeHomeRequirements(migration: PostUpdateMigration): boolean {
  return migration.requiresLegacyHomeMigration === true || migration.requiresPendingHomeMigration === true;
}

const readPostUpdateMigrations = Effect.fn('update.readPostUpdateMigrations')(function* () {
  const path = yield* Path.Path;
  const raw = yield* readFileIfExists(path.join(yield* toolRoot(), 'config', POST_UPDATE_MIGRATIONS_FILE));
  if (!raw) {
    return [];
  }
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(raw),
    catch: cause => UpdateOperationError.make({cause, message: `Could not parse ${POST_UPDATE_MIGRATIONS_FILE}.`}),
  });
  if (!isJsonObject(parsed) || !Array.isArray(parsed.migrations)) {
    throw UpdateOperationError.make({message: `${POST_UPDATE_MIGRATIONS_FILE} must contain a migrations array.`});
  }
  return parsed.migrations.map(parsePostUpdateMigration);
});

function parsePostUpdateMigration(value: unknown): PostUpdateMigration {
  if (
    !isJsonObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.introducedIn !== 'string' ||
    typeof value.title !== 'string' ||
    !Array.isArray(value.description) ||
    !Array.isArray(value.commandArgs) ||
    !Array.isArray(value.instructions)
  ) {
    throw UpdateOperationError.make({message: `Invalid entry in ${POST_UPDATE_MIGRATIONS_FILE}.`});
  }
  const commandArgs = stringArray(value, 'commandArgs');
  const requiresExplicitTelemetryConsent = value.requiresExplicitTelemetryConsent === true;
  const requiresTelemetryConsentRenewal = value.requiresTelemetryConsentRenewal === true;
  if (
    requiresExplicitTelemetryConsent !== requiresTelemetryConsentRenewal ||
    (requiresExplicitTelemetryConsent &&
      (commandArgs.length !== 2 || commandArgs[0] !== 'telemetry' || commandArgs[1] !== 'enable'))
  ) {
    throw UpdateOperationError.make({
      message: `Invalid explicit telemetry consent entry in ${POST_UPDATE_MIGRATIONS_FILE}.`,
    });
  }
  return {
    appliesToPrereleases: value.appliesToPrereleases === true,
    commandArgs,
    description: stringArray(value, 'description'),
    id: value.id,
    instructions: stringArray(value, 'instructions'),
    introducedIn: value.introducedIn,
    markHandledWhenSkipped: value.markHandledWhenSkipped === true,
    requiresExplicitTelemetryConsent,
    requiresLegacyHandoffs: value.requiresLegacyHandoffs === true,
    requiresLegacyHomeMigration: value.requiresLegacyHomeMigration === true,
    requiresPendingHomeMigration: value.requiresPendingHomeMigration === true,
    requiresProjectNameConsolidation: value.requiresProjectNameConsolidation === true,
    requiresTelemetryConsentRenewal,
    title: value.title,
  };
}

function postUpdateMigrationReached(migration: PostUpdateMigration, fromVersion: string, toVersion: string): boolean {
  if (compareVersions(migration.introducedIn, toVersion) <= 0) {
    return true;
  }
  return (
    migration.appliesToPrereleases === true &&
    compareVersions(fromVersion, toVersion) < 0 &&
    stableVersionCore(migration.introducedIn) === stableVersionCore(toVersion) &&
    toVersion.includes('-')
  );
}

function stableVersionCore(version: string): string {
  return version.trim().replace(/^v/, '').split(/[+-]/, 1)[0] ?? '';
}

function stringArray(value: JsonObject, key: string): readonly string[] {
  const raw = value[key];
  if (!Array.isArray(raw) || !raw.every(item => typeof item === 'string')) {
    throw UpdateOperationError.make({message: `Invalid ${key} in ${POST_UPDATE_MIGRATIONS_FILE}.`});
  }
  return raw;
}

const printPostUpdateMigration = Effect.fn('update.printPostUpdateMigration')(function* (
  migration: PostUpdateMigration,
) {
  yield* Console.log('');
  yield* Console.log(`${migration.title} (${migration.introducedIn})`);
  for (const line of migration.description) {
    yield* Console.log(`- ${line}`);
  }
});

function formatMigrationCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(part => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

function currentThreadnoteCommand(system: SystemInfoShape): string | undefined {
  const executable = system.executablePath.trim();
  return executable || undefined;
}

const readPostUpdateState = Effect.fn('update.readPostUpdateState')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* postUpdateStatePath(config);
  if (!(yield* fs.exists(statePath))) {
    return {handledMigrationIds: []};
  }
  const raw = yield* fs.readFileString(statePath);
  const parsedResult = Result.try((): unknown => JSON.parse(raw));
  if (Result.isFailure(parsedResult)) {
    return yield* UpdateOperationError.make({message: `Post-update state is invalid and was preserved: ${statePath}`});
  }
  const parsed = parsedResult.success;
  if (!isJsonObject(parsed) || !Array.isArray(parsed.handledMigrationIds)) {
    return yield* UpdateOperationError.make({message: `Post-update state is invalid and was preserved: ${statePath}`});
  }
  if (!parsed.handledMigrationIds.every((id): id is string => typeof id === 'string')) {
    return yield* UpdateOperationError.make({message: `Post-update state is invalid and was preserved: ${statePath}`});
  }
  return {handledMigrationIds: [...new Set(parsed.handledMigrationIds)].sort()};
});

const removeInterruptedPostUpdateStateWrites = Effect.fn('update.removeInterruptedStateWrites')(function* (
  config: RuntimeConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(config.agentContextHome))) return;
  for (const name of yield* fs.readDirectory(config.agentContextHome)) {
    if (/^\.post-update-state\.json\.[0-9a-f-]+\.tmp$/i.test(name)) {
      yield* fs.remove(path.join(config.agentContextHome, name), {force: true});
    }
  }
});

const writePostUpdateState = Effect.fn('update.writePostUpdateState')(function* (
  config: RuntimeConfig,
  state: PostUpdateState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const target = yield* postUpdateStatePath(config);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${yield* crypto.randomUUIDv4}.tmp`);
  yield* ensureDirectory(config.agentContextHome, false);
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, `${JSON.stringify(state, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    yield* syncWritableFile(fs, temporary);
    yield* fs.rename(temporary, target);
    yield* syncDirectoryBestEffort(fs, path.dirname(target));
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

const postUpdateStatePath = Effect.fn('update.postUpdateStatePath')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, POST_UPDATE_STATE_FILE);
});

export function releaseSource(environment: NodeJS.ProcessEnv): string {
  return resolveReleaseSource(undefined, false, environment);
}

export function resolveReleaseSource(
  source: string | undefined,
  allowUntrustedSource: boolean | undefined,
  environment: NodeJS.ProcessEnv,
): string {
  const untrustedSourceAllowed = allowsUntrustedSource(allowUntrustedSource, environment);
  const normalized = normalizeReleaseSource(
    source ?? environment[RELEASE_SOURCE_ENV] ?? DEFAULT_RELEASE_SOURCE,
    untrustedSourceAllowed,
  );
  if (!isOfficialGitHubReleasesUrl(normalized) && !untrustedSourceAllowed) {
    throw UpdateOperationError.make({
      message: `Refusing custom release source ${normalized}. Use the official GitHub releases API, pass --allow-untrusted-source, or set ${ALLOW_UNTRUSTED_SOURCE_ENV}=1 only for an approved mirror.`,
    });
  }
  return normalized;
}

function normalizeReleaseSource(source: string, untrustedSourceAllowed: boolean): string {
  const url = new URL(source);
  const localDevelopmentSource =
    untrustedSourceAllowed &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !localDevelopmentSource) {
    throw UpdateOperationError.make({message: `Release source must use https: ${source}`});
  }
  return url.toString();
}

function allowsUntrustedSource(option: boolean | undefined, environment: NodeJS.ProcessEnv): boolean {
  if (option === true) {
    return true;
  }
  const envValue = environment[ALLOW_UNTRUSTED_SOURCE_ENV]?.trim().toLowerCase();
  return envValue === '1' || envValue === 'true' || envValue === 'yes';
}

function isUpdateNotificationDisabled(environment: NodeJS.ProcessEnv): boolean {
  return (
    environment.CI !== undefined ||
    environment.NO_UPDATE_NOTIFIER !== undefined ||
    environment.THREADNOTE_NO_UPDATE_CHECK !== undefined
  );
}
