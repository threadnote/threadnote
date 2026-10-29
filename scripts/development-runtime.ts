import {isJsonObject} from '@threadnote/platform/json';
import {Array as EffectArray} from 'effect';
import {ScriptError} from './effect/errors.js';
import {Effect, FileSystem, Option, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256FileHex, sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import {installationRoot} from '@threadnote/threadnote/installations';
import {readStandaloneProcessLeaseVerification} from '@threadnote/threadnote/process/standalone_lease';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const DEVELOPMENT_INSTALL_RECEIPT = 'development-install.json';
export const DEVELOPMENT_INSTALL_RECEIPT_VERSION = 2 as const;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PAYLOAD_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/;
const RELEASE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const DEVELOPMENT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:[0-9A-Za-z-]+\.)*local\.g([0-9a-f]{40}(?:[0-9a-f]{24})?)$/;

export interface DevelopmentInstallReceiptV1 {
  readonly builtAt: string;
  readonly dependencyInstallation: 'bun install --frozen-lockfile';
  readonly executableSha256: string;
  readonly payloadManifest: readonly DevelopmentPayloadManifestEntryV1[];
  readonly payloadManifestSha256: string;
  readonly releaseMetadataSha256: string;
  readonly runtime: string;
  readonly schemaVersion: typeof DEVELOPMENT_INSTALL_RECEIPT_VERSION;
  readonly sourceCommit: string;
  readonly sourceDirty: false;
  readonly sourceLockfileSha256: string;
  readonly sourcePackageManifestSha256: string;
  readonly target: string;
  readonly version: string;
}

export interface DevelopmentPayloadManifestEntryV1 {
  readonly mode: number;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface DevelopmentRuntimeEvidence {
  readonly dependencyInstallation: 'bun install --frozen-lockfile';
  readonly executableSha256: string;
  readonly payloadBytes: number;
  readonly payloadFileCount: number;
  readonly payloadManifestSha256: string;
  readonly releaseMetadataSha256: string;
  readonly runtime: string;
  readonly sourceCommit: string;
  readonly sourceLockfileSha256: string;
  readonly sourcePackageManifestSha256: string;
  readonly target: string;
  readonly version: string;
}

export interface DevelopmentSourceDependencyEvidence {
  readonly sourceLockfileSha256: string;
  readonly sourcePackageManifestSha256: string;
}

export interface CanonicalDevelopmentInstallRoots {
  readonly installRoot: string;
  readonly versionsRoot: string;
}

interface ActiveReleasePointer {
  readonly releaseRoot: string;
  readonly version: string;
}

interface ReleaseMetadata {
  readonly executable: string;
  readonly runtime: string;
  readonly target: string;
  readonly version: string;
}

export function developmentBuildVersion(packageVersion: string, sourceCommit: string): string {
  if (!RELEASE_VERSION_PATTERN.test(packageVersion) || !SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
    throw ScriptError.make({
      message: 'A local development build requires a valid package version and exact Git commit.',
    });
  }
  if (isDevelopmentBuildVersion(packageVersion)) {
    throw ScriptError.make({
      message: 'The checked-in package version must not already be a local development version.',
    });
  }
  const separator = Effect2.pipe(packageVersion, EffectString.includes('-')) ? '.' : '-';
  const version = `${packageVersion}${separator}local.g${sourceCommit}`;
  if (!isDevelopmentBuildVersion(version)) {
    throw ScriptError.make({message: 'Could not derive a valid local development version.'});
  }
  return version;
}

export function isDevelopmentBuildVersion(version: string): boolean {
  return DEVELOPMENT_VERSION_PATTERN.test(version);
}

export function developmentVersionSourceCommit(version: string): Option.Option<string> {
  return Option.fromNullishOr(DEVELOPMENT_VERSION_PATTERN.exec(version)?.[1]);
}

export function parseDevelopmentInstallReceipt(value: unknown): Option.Option<DevelopmentInstallReceiptV1> {
  return isDevelopmentInstallReceiptV1(value) ? Option.some(value) : Option.none();
}

function isDevelopmentInstallReceiptV1(value: unknown): value is DevelopmentInstallReceiptV1 {
  if (!isJsonObject(value)) return false;
  const payloadManifest = parsePayloadManifest(value.payloadManifest);
  return (
    value.schemaVersion === DEVELOPMENT_INSTALL_RECEIPT_VERSION &&
    typeof value.builtAt === 'string' &&
    Number.isFinite(Date.parse(value.builtAt)) &&
    value.dependencyInstallation === 'bun install --frozen-lockfile' &&
    typeof value.version === 'string' &&
    isDevelopmentBuildVersion(value.version) &&
    typeof value.sourceCommit === 'string' &&
    SOURCE_COMMIT_PATTERN.test(value.sourceCommit) &&
    value.sourceDirty === false &&
    typeof value.executableSha256 === 'string' &&
    SHA256_PATTERN.test(value.executableSha256) &&
    Option.isSome(payloadManifest) &&
    typeof value.payloadManifestSha256 === 'string' &&
    SHA256_PATTERN.test(value.payloadManifestSha256) &&
    typeof value.releaseMetadataSha256 === 'string' &&
    SHA256_PATTERN.test(value.releaseMetadataSha256) &&
    typeof value.sourceLockfileSha256 === 'string' &&
    SHA256_PATTERN.test(value.sourceLockfileSha256) &&
    typeof value.sourcePackageManifestSha256 === 'string' &&
    SHA256_PATTERN.test(value.sourcePackageManifestSha256) &&
    typeof value.runtime === 'string' &&
    value.runtime.length > 0 &&
    typeof value.target === 'string' &&
    value.target.length > 0
  );
}

function isPayloadPath(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (
      Effect2.pipe(
        value,
        EffectString.charCodeAt(index),
        Effect2.Option.getOrElse(() => NaN),
      ) === 0
    )
      return false;
  }
  return PAYLOAD_PATH_PATTERN.test(value);
}

function parsePayloadManifest(value: unknown): Option.Option<readonly DevelopmentPayloadManifestEntryV1[]> {
  if (!EffectArray.isArray(value) || value.length === 0) return Option.none();
  const entries: DevelopmentPayloadManifestEntryV1[] = [];
  let priorPath = '';
  for (const candidate of value) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      EffectArray.isArray(candidate) ||
      !('path' in candidate) ||
      typeof candidate.path !== 'string' ||
      !isPayloadPath(candidate.path) ||
      candidate.path <= priorPath ||
      !('size' in candidate) ||
      !Number.isSafeInteger(candidate.size) ||
      Number(candidate.size) < 0 ||
      !('sha256' in candidate) ||
      typeof candidate.sha256 !== 'string' ||
      !SHA256_PATTERN.test(candidate.sha256) ||
      !('mode' in candidate) ||
      !Number.isSafeInteger(candidate.mode) ||
      Number(candidate.mode) < 0 ||
      Number(candidate.mode) > 0o777
    ) {
      return Option.none();
    }
    priorPath = candidate.path;
    entries.push({
      mode: Number(candidate.mode),
      path: candidate.path,
      sha256: candidate.sha256,
      size: Number(candidate.size),
    });
  }
  if (EffectArray.some(entries, entry => entry.path === DEVELOPMENT_INSTALL_RECEIPT)) return Option.none();
  return Option.some(entries);
}

export const prepareCanonicalDevelopmentInstallRoots = Effect.fn('developmentRuntime.prepareCanonicalInstallRoots')(
  function* (configuredInstallRoot?: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const logicalInstallRoot = path.resolve(configuredInstallRoot ?? installationRoot(path, system));
    yield* fs.makeDirectory(logicalInstallRoot, {recursive: true, mode: 0o700});
    const realInstallRoot = yield* fs.realPath(logicalInstallRoot);
    const logicalVersionsRoot = path.join(logicalInstallRoot, 'versions');
    yield* fs.makeDirectory(logicalVersionsRoot, {recursive: true, mode: 0o700});
    if (Option.isSome(yield* fs.readLink(logicalVersionsRoot).pipe(Effect.option))) {
      return yield* ScriptError.make({
        message: 'The managed Threadnote versions directory must not be a symbolic link.',
      });
    }
    const realVersionsRoot = yield* fs.realPath(logicalVersionsRoot);
    if (!canonicalPathEquals(path, system, realVersionsRoot, path.join(realInstallRoot, 'versions'))) {
      return yield* ScriptError.make({
        message: 'The managed Threadnote versions directory escapes the installation root.',
      });
    }
    return {installRoot: realInstallRoot, versionsRoot: realVersionsRoot} satisfies CanonicalDevelopmentInstallRoots;
  },
);

export const collectDevelopmentPayloadManifest = Effect.fn('developmentRuntime.collectPayloadManifest')(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const realRoot = yield* fs.realPath(root);
  const entries: DevelopmentPayloadManifestEntryV1[] = [];
  const pending = [{directory: realRoot, relativeDirectory: ''}];
  while (pending.length > 0) {
    const {directory, relativeDirectory} = pending.pop()!;
    for (const name of (yield* fs.readDirectory(directory)).sort()) {
      const entry = path.join(directory, name);
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (relative === DEVELOPMENT_INSTALL_RECEIPT) continue;
      if (!isPayloadPath(relative)) {
        return yield* ScriptError.make({message: 'The development payload contains an invalid relative path.'});
      }
      if (Option.isSome(yield* fs.readLink(entry).pipe(Effect.option))) {
        return yield* ScriptError.make({message: 'The development payload must not contain symbolic links.'});
      }
      const info = yield* fs.stat(entry);
      const expectedRealPath = path.join(realRoot, ...Effect2.pipe(relative, EffectString.split('/')));
      const realEntry = yield* fs.realPath(entry);
      if (!canonicalPathEquals(path, system, realEntry, expectedRealPath)) {
        return yield* ScriptError.make({message: 'The development payload contains a non-canonical path.'});
      }
      if (info.type === 'Directory') {
        pending.push({directory: entry, relativeDirectory: relative});
        continue;
      }
      if (info.type !== 'File') {
        return yield* ScriptError.make({message: 'The development payload contains an unsupported filesystem entry.'});
      }
      const linkCount = Option.getOrUndefined(info.nlink);
      if (linkCount !== undefined && linkCount > 1) {
        return yield* ScriptError.make({message: 'The development payload must not contain hard-linked files.'});
      }
      const size = Number(info.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        return yield* ScriptError.make({message: 'The development payload contains a file with an invalid size.'});
      }
      if (system.platform !== 'win32' && (info.mode & 0o7000) !== 0) {
        return yield* ScriptError.make({
          message: 'The development payload contains a file with unsupported special permission bits.',
        });
      }
      entries.push({
        mode: system.platform === 'win32' ? 0 : info.mode & 0o777,
        path: relative,
        sha256: yield* sha256FileHex(entry),
        size,
      });
    }
  }
  return entries.sort((left, right) => comparePayloadPaths(left.path, right.path));
});

export const developmentPayloadManifestSha256 = Effect.fn('developmentRuntime.payloadManifestDigest')(
  (manifest: readonly DevelopmentPayloadManifestEntryV1[]) => sha256Hex(`${JSON.stringify(manifest)}\n`),
);

export const readManagedDevelopmentRuntimeEvidence = Effect.fn('developmentRuntime.readManaged')(function* (
  expectedSourceCommit: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (!SOURCE_COMMIT_PATTERN.test(expectedSourceCommit)) {
    return yield* ScriptError.make({
      message: 'Managed development runtime validation requires an exact source commit.',
    });
  }
  const installRoot = installationRoot(path, system);
  const active = yield* readJsonOption(fs, path.join(installRoot, 'active-release.json')).pipe(
    Effect.map(Option.flatMap(parseActiveReleasePointer)),
  );
  if (Option.isNone(active)) {
    return yield* ScriptError.make({message: 'The managed Threadnote active release pointer is missing or invalid.'});
  }
  const logicalVersionsRoot = path.resolve(path.join(installRoot, 'versions'));
  const [realInstallRoot, realVersionsRoot, realReleaseRoot] = yield* Effect.all([
    fs.realPath(installRoot),
    fs.realPath(logicalVersionsRoot),
    fs.realPath(active.value.releaseRoot),
  ]);
  if (!canonicalPathEquals(path, system, realVersionsRoot, path.join(realInstallRoot, 'versions'))) {
    return yield* ScriptError.make({message: 'The managed Threadnote versions directory is not canonical.'});
  }
  const expectedReleaseRoot = path.join(realVersionsRoot, active.value.version);
  if (!canonicalPathEquals(path, system, realReleaseRoot, expectedReleaseRoot)) {
    return yield* ScriptError.make({
      message: 'The managed Threadnote active release pointer escapes the versions root.',
    });
  }
  const evidence = yield* readDevelopmentReleaseEvidence(realReleaseRoot, expectedSourceCommit);
  if (evidence.version !== active.value.version) {
    return yield* ScriptError.make({
      message: 'The managed Threadnote active pointer and release version do not match.',
    });
  }
  return evidence;
});

/**
 * Fail-closed preflight for local benchmark and host-integration harnesses.
 * It proves the active bytes came from the exact source commit and that no
 * identity-verified executable process remains pinned to another managed
 * release. A stable preserve-session transport may outlive the release it was
 * launched from; its executable descendants must still use the active release.
 */
export const verifyManagedDevelopmentRuntimeForSource = Effect.fn('developmentRuntime.verifyForSource')(function* (
  expectedSourceCommit: string,
) {
  const evidence = yield* readManagedDevelopmentRuntimeEvidence(expectedSourceCommit);
  const live = yield* readStandaloneProcessLeaseVerification();
  if (live.truncated) {
    return yield* ScriptError.make({
      message: 'Managed development runtime verification could not inspect every live process lease.',
    });
  }
  if (live.unverified.length > 0) {
    return yield* ScriptError.make({
      message: 'Managed development runtime verification found live process leases with unverified identity.',
    });
  }
  if (
    EffectArray.some(
      live.verified,
      lease => lease.version !== evidence.version && lease.retirementPolicy !== 'preserve-session',
    )
  ) {
    return yield* ScriptError.make({
      message: 'Managed development runtime verification found a process pinned to a superseded release.',
    });
  }
  const revalidated = yield* readManagedDevelopmentRuntimeEvidence(expectedSourceCommit);
  if (JSON.stringify(revalidated) !== JSON.stringify(evidence)) {
    return yield* ScriptError.make({
      message: 'Managed development runtime verification observed an active release change during preflight.',
    });
  }
  return revalidated;
});

/** Resolve the canonical active executable only after its managed payload and process identity pass verification. */
export const resolveManagedDevelopmentExecutableForSource = Effect.fn('developmentRuntime.resolveExecutable')(
  function* (expectedSourceCommit: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const before = yield* verifyManagedDevelopmentRuntimeForSource(expectedSourceCommit);
    const installRoot = installationRoot(path, system);
    const active = yield* readJsonOption(fs, path.join(installRoot, 'active-release.json')).pipe(
      Effect.map(Option.flatMap(parseActiveReleasePointer)),
    );
    if (Option.isNone(active) || active.value.version !== before.version) {
      return yield* ScriptError.make({message: 'The managed Threadnote active release changed before invocation.'});
    }
    const realInstallRoot = yield* fs.realPath(installRoot);
    const realReleaseRoot = yield* fs.realPath(active.value.releaseRoot);
    const expectedReleaseRoot = path.join(realInstallRoot, 'versions', before.version);
    if (!canonicalPathEquals(path, system, realReleaseRoot, expectedReleaseRoot)) {
      return yield* ScriptError.make({message: 'The managed Threadnote active executable root is not canonical.'});
    }
    const executable = yield* fs.realPath(
      path.join(realReleaseRoot, system.platform === 'win32' ? 'threadnote.exe' : 'threadnote'),
    );
    if ((yield* sha256FileHex(executable)) !== before.executableSha256) {
      return yield* ScriptError.make({message: 'The managed Threadnote executable changed before invocation.'});
    }
    const after = yield* verifyManagedDevelopmentRuntimeForSource(expectedSourceCommit);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      return yield* ScriptError.make({message: 'The managed Threadnote active release changed during resolution.'});
    }
    return {evidence: after, executable, installRoot: realInstallRoot};
  },
);

export const verifyManagedDevelopmentRuntimeForSourceCheckout = Effect.fn('developmentRuntime.verifyForSourceCheckout')(
  function* (sourceRoot: string, expectedSourceCommit: string) {
    const path = yield* Path.Path;
    const [runtime, sourceLockfileSha256, sourcePackageManifestSha256] = yield* Effect.all(
      [
        verifyManagedDevelopmentRuntimeForSource(expectedSourceCommit),
        sha256FileHex(path.join(sourceRoot, 'bun.lock')),
        sha256FileHex(path.join(sourceRoot, 'package.json')),
      ],
      {concurrency: 3},
    );
    if (
      runtime.sourceLockfileSha256 !== sourceLockfileSha256 ||
      runtime.sourcePackageManifestSha256 !== sourcePackageManifestSha256
    ) {
      return yield* ScriptError.make({
        message: 'Managed development runtime dependency evidence does not match the clean source checkout.',
      });
    }
    return runtime;
  },
);

export const readDevelopmentReleaseEvidence = Effect.fn('developmentRuntime.readRelease')(function* (
  releaseRoot: string,
  expectedSourceCommit: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const receiptValue = yield* readJsonOption(fs, path.join(releaseRoot, DEVELOPMENT_INSTALL_RECEIPT));
  const metadataValue = yield* readJsonOption(fs, path.join(releaseRoot, 'release.json'));
  const receipt = Option.flatMap(receiptValue, parseDevelopmentInstallReceipt);
  const metadata = Option.flatMap(metadataValue, parseReleaseMetadata);
  if (Option.isNone(receipt) || Option.isNone(metadata)) {
    return yield* ScriptError.make({message: 'The managed development release metadata or provenance is invalid.'});
  }
  const sourceFromVersion = developmentVersionSourceCommit(receipt.value.version);
  if (
    receipt.value.sourceCommit !== expectedSourceCommit ||
    Option.getOrUndefined(sourceFromVersion) !== expectedSourceCommit ||
    metadata.value.version !== receipt.value.version ||
    metadata.value.runtime !== receipt.value.runtime ||
    metadata.value.target !== receipt.value.target ||
    !releaseTargetMatchesHost(metadata.value.target, system)
  ) {
    return yield* ScriptError.make({
      message: 'The managed development release does not match the exact source commit.',
    });
  }
  const executableName = system.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
  if (metadata.value.executable !== executableName) {
    return yield* ScriptError.make({message: 'The managed development release executable metadata is invalid.'});
  }
  const executable = path.join(releaseRoot, executableName);
  const [realReleaseParent, realReleaseRoot] = yield* Effect.all([
    fs.realPath(path.dirname(releaseRoot)),
    fs.realPath(releaseRoot),
  ]);
  if (!canonicalPathEquals(path, system, realReleaseRoot, path.join(realReleaseParent, path.basename(releaseRoot)))) {
    return yield* ScriptError.make({message: 'The managed development release directory is not canonical.'});
  }
  const receiptPath = path.join(releaseRoot, DEVELOPMENT_INSTALL_RECEIPT);
  if (
    Option.isSome(yield* fs.readLink(receiptPath).pipe(Effect.option)) ||
    !canonicalPathEquals(
      path,
      system,
      yield* fs.realPath(receiptPath),
      path.join(realReleaseRoot, DEVELOPMENT_INSTALL_RECEIPT),
    )
  ) {
    return yield* ScriptError.make({
      message: 'The managed development release contains a non-canonical provenance file.',
    });
  }
  const receiptInfo = yield* fs.stat(receiptPath);
  if (receiptInfo.type !== 'File' || (system.platform !== 'win32' && (receiptInfo.mode & 0o7777) !== 0o600)) {
    return yield* ScriptError.make({
      message: 'The managed development release provenance file has unsafe permissions.',
    });
  }
  const actualPayloadManifest = yield* collectDevelopmentPayloadManifest(releaseRoot);
  const [actualPayloadManifestSha256, receiptPayloadManifestSha256] = yield* Effect.all([
    developmentPayloadManifestSha256(actualPayloadManifest),
    developmentPayloadManifestSha256(receipt.value.payloadManifest),
  ]);
  if (
    actualPayloadManifestSha256 !== receipt.value.payloadManifestSha256 ||
    receiptPayloadManifestSha256 !== receipt.value.payloadManifestSha256 ||
    JSON.stringify(actualPayloadManifest) !== JSON.stringify(receipt.value.payloadManifest)
  ) {
    return yield* ScriptError.make({
      message: 'The managed development release payload manifest does not match its files.',
    });
  }
  const executableEntry = Option.getOrUndefined(
    EffectArray.findFirst(actualPayloadManifest, entry => entry.path === executableName),
  );
  const releaseMetadataEntry = Option.getOrUndefined(
    EffectArray.findFirst(actualPayloadManifest, entry => entry.path === 'release.json'),
  );
  if (!executableEntry || !releaseMetadataEntry) {
    return yield* ScriptError.make({message: 'The managed development release payload omits required files.'});
  }
  const [executableInfo, versionResult] = yield* Effect.all(
    [
      fs.stat(executable),
      runCommandEffect(executable, ['--version'], {
        env: {...system.environment(), THREADNOTE_INSTALL_ROOT: installationRoot(path, system)},
        maxOutputBytes: 16 * 1024,
        timeoutMs: 30_000,
      }),
    ],
    {concurrency: 2},
  );
  if (
    executableEntry.sha256 !== receipt.value.executableSha256 ||
    releaseMetadataEntry.sha256 !== receipt.value.releaseMetadataSha256 ||
    (system.platform !== 'win32' && (executableInfo.mode & 0o111) === 0) ||
    Effect2.pipe(versionResult.stdout, EffectString.trim) !== `threadnote v${receipt.value.version}`
  ) {
    return yield* ScriptError.make({message: 'The managed development release failed its digest or version check.'});
  }
  return {
    dependencyInstallation: receipt.value.dependencyInstallation,
    executableSha256: executableEntry.sha256,
    payloadBytes: EffectArray.reduce(actualPayloadManifest, 0, (total, entry) => total + entry.size),
    payloadFileCount: actualPayloadManifest.length,
    payloadManifestSha256: actualPayloadManifestSha256,
    releaseMetadataSha256: releaseMetadataEntry.sha256,
    runtime: receipt.value.runtime,
    sourceCommit: receipt.value.sourceCommit,
    sourceLockfileSha256: receipt.value.sourceLockfileSha256,
    sourcePackageManifestSha256: receipt.value.sourcePackageManifestSha256,
    target: receipt.value.target,
    version: receipt.value.version,
  } satisfies DevelopmentRuntimeEvidence;
});

/**
 * Copies a completed build into a disposable release directory, writes its
 * provenance receipt, and validates the exact bytes before the directory can
 * be promoted. Any failure after staging begins removes the disposable tree.
 */
export const stageAndValidateDevelopmentRelease = Effect.fn('developmentRuntime.stageRelease')(function* (input: {
  readonly distributionRoot: string;
  readonly executableName: string;
  readonly expectedSourceCommit: string;
  readonly receipt: DevelopmentInstallReceiptV1;
  readonly stagedRoot: string;
  readonly versionsRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const stage = Effect.gen(function* () {
    const [realVersionsRoot, realStagedParent] = yield* Effect.all([
      fs.realPath(input.versionsRoot),
      fs.realPath(path.dirname(input.stagedRoot)),
    ]);
    if (
      !canonicalPathEquals(path, system, realVersionsRoot, realStagedParent) ||
      (yield* fs.exists(input.stagedRoot))
    ) {
      return yield* ScriptError.make({
        message: 'The development staging path is not a fresh child of the versions root.',
      });
    }
    const distributionManifest = yield* collectDevelopmentPayloadManifest(input.distributionRoot);
    const distributionManifestSha256 = yield* developmentPayloadManifestSha256(distributionManifest);
    if (
      distributionManifestSha256 !== input.receipt.payloadManifestSha256 ||
      JSON.stringify(distributionManifest) !== JSON.stringify(input.receipt.payloadManifest)
    ) {
      return yield* ScriptError.make({message: 'The development distribution changed before staging.'});
    }
    yield* fs.copy(input.distributionRoot, input.stagedRoot, {overwrite: true});
    yield* fs.writeFileString(
      path.join(input.stagedRoot, DEVELOPMENT_INSTALL_RECEIPT),
      `${JSON.stringify(input.receipt, undefined, 2)}\n`,
      {mode: 0o600},
    );
    if (system.platform !== 'win32') {
      yield* fs.chmod(path.join(input.stagedRoot, input.executableName), 0o755);
    }
    yield* readDevelopmentReleaseEvidence(input.stagedRoot, input.expectedSourceCommit).pipe(
      Effect.mapError(cause =>
        ScriptError.make({message: 'The staged development release failed validation before activation.', cause}),
      ),
    );
    return input.stagedRoot;
  });
  return yield* stage.pipe(
    Effect.onError(() => fs.remove(input.stagedRoot, {force: true, recursive: true}).pipe(Effect.ignore)),
  );
});

function parseActiveReleasePointer(value: unknown): Option.Option<ActiveReleasePointer> {
  return isActiveReleasePointer(value) ? Option.some(value) : Option.none();
}

function isActiveReleasePointer(value: unknown): value is ActiveReleasePointer {
  return (
    isJsonObject(value) &&
    typeof value.releaseRoot === 'string' &&
    typeof value.version === 'string' &&
    isDevelopmentBuildVersion(value.version)
  );
}

function parseReleaseMetadata(value: unknown): Option.Option<ReleaseMetadata> {
  return isReleaseMetadata(value) ? Option.some(value) : Option.none();
}

function isReleaseMetadata(value: unknown): value is ReleaseMetadata {
  return (
    isJsonObject(value) &&
    typeof value.executable === 'string' &&
    typeof value.runtime === 'string' &&
    typeof value.target === 'string' &&
    typeof value.version === 'string' &&
    isDevelopmentBuildVersion(value.version)
  );
}

function canonicalPathEquals(
  path: Path.Path,
  system: Pick<import('@threadnote/platform/system').SystemInfoShape, 'platform'>,
  left: string,
  right: string,
): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return system.platform === 'win32' ? Effect2.pipe(resolved, EffectString.toLocaleLowerCase('en-US')) : resolved;
  };
  return normalize(left) === normalize(right);
}

function comparePayloadPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function releaseTargetMatchesHost(
  target: string,
  system: Pick<import('@threadnote/platform/system').SystemInfoShape, 'architecture' | 'platform'>,
): boolean {
  const platform = system.platform === 'win32' ? 'windows' : system.platform;
  const architecture = system.architecture === 'arm64' ? '(?:arm64|aarch64)' : system.architecture;
  return new RegExp(`^bun-${platform}-${architecture}(?:-|$)`).test(target);
}

function readJsonOption(fs: FileSystem.FileSystem, file: string): Effect.Effect<Option.Option<unknown>> {
  return fs.readFileString(file).pipe(
    Effect.flatMap(source => Effect.try(() => JSON.parse(source) as unknown)),
    Effect.option,
  );
}
