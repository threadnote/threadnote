import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Cause, Console, Crypto, DateTime, Effect, Exit, FileSystem, Layer, Option, Path} from 'effect';
import {
  commandLauncherPath,
  installCommandShim,
  managedCommandLauncherKinds,
  primaryCommandLauncherKind,
  plannedCommandLauncherMutations,
  requiredCommandLauncherModes,
  renderCommandShim,
} from '@threadnote/threadnote/command-shim';
import {runCommandEffect} from '@threadnote/platform/command';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {sha256FileHex, sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {
  activateStandaloneRelease,
  activeInstalledVersion,
  installationRoot,
  promoteStandaloneReleaseDirectory,
  pruneStandaloneReleases,
  withStandaloneInstallationLock,
} from '@threadnote/threadnote/installations';
import {
  explicitlyPreservedStandaloneProcessIds,
  readStandaloneProcessLeaseVerification,
  terminateSupersededStandaloneProcesses,
} from '@threadnote/threadnote/process/standalone_lease';
import {scriptArguments} from './effect/script.js';
import {
  DEVELOPMENT_INSTALL_RECEIPT_VERSION,
  collectDevelopmentPayloadManifest,
  developmentBuildVersion,
  developmentPayloadManifestSha256,
  isDevelopmentBuildVersion,
  prepareCanonicalDevelopmentInstallRoots,
  readDevelopmentReleaseEvidence,
  readManagedDevelopmentRuntimeEvidence,
  stageAndValidateDevelopmentRelease,
  type DevelopmentInstallReceiptV1,
  type DevelopmentRuntimeEvidence,
} from './development-runtime.js';

const ROOT_URL = new URL('..', import.meta.url);
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const COMMAND_TIMEOUT_MILLISECONDS = 30 * 60_000;
const DEVELOPMENT_RUNTIME_OWNER_FILE = 'development-runtime-owner.json';
const DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION_V1 = 1 as const;
const DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION = 2 as const;
const DEVELOPMENT_RUNTIME_OWNER_MAX_BYTES = 16 * 1024;
const DEVELOPMENT_RUNTIME_OWNERSHIP_REVISION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const CLEAN_GIT_STATUS_ARGUMENTS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'status.showUntrackedFiles=all',
  '-c',
  'diff.ignoreSubmodules=none',
  'status',
  '--porcelain=v1',
  '--untracked-files=all',
  '--ignore-submodules=none',
  '--no-renames',
] as const;

export interface LocalStandaloneInstallOptions {
  readonly json: boolean;
  readonly takeOverGlobalRuntime: boolean;
  readonly terminateSuperseded: boolean;
}

export interface LocalStandaloneInstallResult extends DevelopmentRuntimeEvidence {
  readonly active: true;
  readonly cleanupComplete: boolean;
  readonly cleanupIssues: readonly LocalStandaloneCleanupIssue[];
  readonly doctorVerified: true;
  readonly launchersVerified: true;
  readonly preservedMcpSessionProcesses: number;
  readonly remainingSupersededProcesses: number;
  readonly reused: boolean;
  readonly terminatedSupersededProcesses: number;
}

export type LocalStandaloneCleanupIssue =
  'process-inspection' | 'process-termination' | 'release-pruning' | 'staging-removal';

export interface LocalStandaloneActivationInput {
  readonly canonicalInstallRoot: string;
  readonly canonicalVersionsRoot: string;
  readonly commit: string;
  readonly executableName: string;
  readonly ownershipAuthorization?: DevelopmentRuntimeTakeoverAuthorization;
  readonly releaseRoot: string;
  readonly reused: boolean;
  readonly sourceCheckoutId: string;
  readonly stagedRoot: Option.Option<string>;
  readonly terminateSuperseded: boolean;
  readonly version: string;
}

export interface DevelopmentRuntimeOwnerV1 {
  readonly schemaVersion: typeof DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION_V1;
  readonly sourceCheckoutId: string;
  readonly version: string;
}

export interface DevelopmentRuntimeOwnerV2 {
  readonly ownershipRevision: string;
  readonly schemaVersion: typeof DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION;
  readonly sourceCheckoutId: string;
  readonly version: string;
}

export type DevelopmentRuntimeOwner = DevelopmentRuntimeOwnerV1 | DevelopmentRuntimeOwnerV2;

export type DevelopmentRuntimeOwnershipState = DevelopmentRuntimeOwner | 'absent' | 'invalid';

export interface DevelopmentRuntimeOwnershipSnapshot {
  readonly activeVersion: string | undefined;
  readonly owner: DevelopmentRuntimeOwnershipState;
}

export interface DevelopmentRuntimeTakeoverAuthorization extends DevelopmentRuntimeOwnershipSnapshot {
  readonly requestedSourceCheckoutId: string;
}

export type DevelopmentRuntimeOwnershipConflict =
  'different-source-checkout' | 'invalid-ownership-record' | 'untracked-development-activation';

export function parseLocalStandaloneInstallArguments(arguments_: readonly string[]): LocalStandaloneInstallOptions {
  let json = false;
  let takeOverGlobalRuntime = false;
  let terminateSuperseded = false;
  for (const argument of arguments_) {
    if (argument === '--') continue;
    if (argument === '--json') json = true;
    else if (argument === '--take-over-global-runtime') takeOverGlobalRuntime = true;
    else if (argument === '--terminate-superseded') terminateSuperseded = true;
    else throw ScriptError.make({message: `Unknown local standalone install option: ${argument}`});
  }
  return {json, takeOverGlobalRuntime, terminateSuperseded};
}

export function developmentRuntimeOwnershipConflict(
  activeVersion: string | undefined,
  owner: DevelopmentRuntimeOwnershipState,
  requestedSourceCheckoutId: string,
): DevelopmentRuntimeOwnershipConflict | undefined {
  if (activeVersion === undefined || !isDevelopmentBuildVersion(activeVersion)) return undefined;
  if (owner === 'absent') return 'untracked-development-activation';
  if (owner === 'invalid') return 'invalid-ownership-record';
  if (owner.version !== activeVersion) return 'untracked-development-activation';
  return owner.sourceCheckoutId === requestedSourceCheckoutId ? undefined : 'different-source-checkout';
}

export const installLocalStandalone = Effect.fn('developmentInstall.run')(function* (
  options: LocalStandaloneInstallOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const sourceRoot = yield* path.fromFileUrl(ROOT_URL);
  const git = Option.fromNullishOr(Bun.which('git'));
  if (Option.isNone(git))
    return yield* ScriptError.make({message: 'Git is required for an exact-HEAD development install.'});
  const [sourceCommit, status] = yield* Effect.all(
    [
      runCommandEffect(git.value, ['rev-parse', 'HEAD'], {cwd: sourceRoot}),
      runCommandEffect(git.value, CLEAN_GIT_STATUS_ARGUMENTS, {cwd: sourceRoot}),
    ],
    {concurrency: 2},
  );
  const commit = sourceCommit.stdout.trim();
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    return yield* ScriptError.make({message: 'The Threadnote checkout did not resolve to an exact Git commit.'});
  }
  if (status.stdout.length > 0) {
    return yield* ScriptError.make({
      message: 'Refusing a global development install from a dirty Threadnote checkout.',
    });
  }
  const manifest = yield* readPackageManifest(fs, path.join(sourceRoot, 'package.json'));
  if (manifest.packageManager !== `bun@${Bun.version}`) {
    return yield* ScriptError.make({
      message: `Global development installs require ${manifest.packageManager}; running bun@${Bun.version}.`,
    });
  }
  const version = developmentBuildVersion(manifest.version, commit);
  const roots = yield* prepareCanonicalDevelopmentInstallRoots(installationRoot(path, system));
  const sourceCheckoutId = yield* developmentSourceCheckoutId(sourceRoot);
  const ownershipAuthorization = yield* prepareDevelopmentRuntimeOwnershipAuthorization(
    roots.installRoot,
    sourceCheckoutId,
    options.takeOverGlobalRuntime,
  );
  const releaseRoot = path.join(roots.versionsRoot, version);
  const executableName = system.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
  const releaseExists = yield* fs.exists(releaseRoot);
  if (releaseExists) {
    const existing = yield* readDevelopmentReleaseEvidence(releaseRoot, commit);
    if (existing.runtime !== `bun-${Bun.version}`) {
      return yield* ScriptError.make({
        message: `The existing exact-HEAD development release uses ${existing.runtime}; expected bun-${Bun.version}.`,
      });
    }
  }
  const stagedRoot = releaseExists
    ? Option.none<string>()
    : Option.some(
        yield* buildAndStageDevelopmentRelease({
          commit,
          canonicalInstallRoot: roots.installRoot,
          canonicalVersionsRoot: roots.versionsRoot,
          executableName,
          json: options.json,
          releaseRoot,
          sourceRoot,
          version,
        }),
      );
  yield* verifyCleanSourceState(sourceRoot, commit);
  const activation = activateLocalStandaloneRelease({
    canonicalInstallRoot: roots.installRoot,
    canonicalVersionsRoot: roots.versionsRoot,
    commit,
    executableName,
    ownershipAuthorization,
    releaseRoot,
    reused: releaseExists,
    sourceCheckoutId,
    stagedRoot,
    terminateSuperseded: options.terminateSuperseded,
    version,
  });
  const result = options.json ? (yield* captureConsole(activation)).value : yield* activation;
  if (options.json) {
    yield* Console.log(JSON.stringify(result));
  } else {
    yield* Console.log(`Installed exact-HEAD Threadnote ${result.version}.`);
    yield* Console.log(`Source commit: ${result.sourceCommit}`);
    yield* Console.log(`Executable SHA-256: ${result.executableSha256}`);
    if (result.preservedMcpSessionProcesses > 0) {
      yield* Console.log(
        `${result.preservedMcpSessionProcesses} live MCP session process(es) remain safely pinned and will promote behind their stable transport.`,
      );
    }
    const processStateUnknown = result.cleanupIssues.some(
      (issue: LocalStandaloneCleanupIssue) => issue === 'process-inspection' || issue === 'process-termination',
    );
    yield* Console.log(
      processStateUnknown
        ? 'Could not verify whether superseded Threadnote processes remain.'
        : result.remainingSupersededProcesses === 0
          ? 'No superseded Threadnote processes remain.'
          : `${result.remainingSupersededProcesses} superseded Threadnote process(es) remain; rerun with --terminate-superseded.`,
    );
    if (!result.cleanupComplete) {
      yield* Console.log(
        `Managed cleanup is incomplete (${result.cleanupIssues.join(', ') || 'superseded processes remain'}); ` +
          'rerun the exact-HEAD installer after active work finishes.',
      );
    }
  }
  return result;
});

const verifyCleanSourceState = Effect.fn('developmentInstall.verifyCleanSourceState')(function* (
  sourceRoot: string,
  expectedCommit: string,
) {
  const git = Option.fromNullishOr(Bun.which('git'));
  if (Option.isNone(git)) return yield* ScriptError.make({message: 'Git disappeared before development activation.'});
  const [commit, status] = yield* Effect.all(
    [
      runCommandEffect(git.value, ['rev-parse', 'HEAD'], {cwd: sourceRoot}),
      runCommandEffect(git.value, CLEAN_GIT_STATUS_ARGUMENTS, {cwd: sourceRoot}),
    ],
    {concurrency: 2},
  );
  if (commit.stdout.trim() !== expectedCommit || status.stdout.length > 0) {
    return yield* ScriptError.make({message: 'The Threadnote checkout changed before development activation.'});
  }
});

export const developmentSourceCheckoutId = Effect.fn('developmentInstall.sourceCheckoutId')(function* (
  sourceRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const canonicalSourceRoot = yield* fs.realPath(sourceRoot);
  const normalizedSourceRoot =
    system.platform === 'win32' ? canonicalSourceRoot.toLocaleLowerCase('en-US') : canonicalSourceRoot;
  return yield* sha256Hex(`threadnote-development-source-checkout-v1\0${normalizedSourceRoot}`);
});

function ownershipConflictMessage(conflict: DevelopmentRuntimeOwnershipConflict): string {
  return conflict === 'different-source-checkout'
    ? 'another source checkout owns the active global development runtime'
    : conflict === 'untracked-development-activation'
      ? 'the active global development runtime changed outside its owning installer'
      : 'the active global development runtime ownership record is invalid';
}

function ownershipStatesEqual(
  left: DevelopmentRuntimeOwnershipState,
  right: DevelopmentRuntimeOwnershipState,
): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.sourceCheckoutId === right.sourceCheckoutId &&
    left.version === right.version &&
    (left.schemaVersion === DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION_V1 ||
      (right.schemaVersion === DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION &&
        left.ownershipRevision === right.ownershipRevision))
  );
}

export function developmentRuntimeTakeoverAuthorizationMatches(
  authorization: DevelopmentRuntimeTakeoverAuthorization,
  snapshot: DevelopmentRuntimeOwnershipSnapshot,
): boolean {
  return (
    authorization.activeVersion === snapshot.activeVersion && ownershipStatesEqual(authorization.owner, snapshot.owner)
  );
}

const readDevelopmentRuntimeOwnershipSnapshotUnlocked = Effect.fn(
  'developmentInstall.readRuntimeOwnershipSnapshotUnlocked',
)(function* (installRoot: string) {
  const [activeVersion, owner] = yield* Effect.all([
    activeInstalledVersion(),
    readDevelopmentRuntimeOwner(installRoot),
  ]);
  return {activeVersion, owner} satisfies DevelopmentRuntimeOwnershipSnapshot;
});

export const readDevelopmentRuntimeOwnershipSnapshot = Effect.fn('developmentInstall.readRuntimeOwnershipSnapshot')(
  function* (installRoot: string) {
    return yield* withStandaloneInstallationLock(readDevelopmentRuntimeOwnershipSnapshotUnlocked(installRoot));
  },
);

function validateRequestedSourceCheckoutId(requestedSourceCheckoutId: string) {
  return SHA256_PATTERN.test(requestedSourceCheckoutId)
    ? Effect.void
    : Effect.fail(ScriptError.make({message: 'The development source checkout identity is invalid.'}));
}

function refuseOwnershipConflict(conflict: DevelopmentRuntimeOwnershipConflict) {
  return ScriptError.make({
    message:
      `Refusing to replace the global Threadnote runtime because ${ownershipConflictMessage(conflict)}. ` +
      'Rerun with --take-over-global-runtime only after confirming the other development task has finished.',
  });
}

export const prepareDevelopmentRuntimeOwnershipAuthorization = Effect.fn(
  'developmentInstall.prepareRuntimeOwnershipAuthorization',
)(function* (installRoot: string, requestedSourceCheckoutId: string, takeOverGlobalRuntime: boolean) {
  yield* validateRequestedSourceCheckoutId(requestedSourceCheckoutId);
  const snapshot = yield* withStandaloneInstallationLock(
    Effect.gen(function* () {
      const current = yield* readDevelopmentRuntimeOwnershipSnapshotUnlocked(installRoot);
      const conflict = developmentRuntimeOwnershipConflict(
        current.activeVersion,
        current.owner,
        requestedSourceCheckoutId,
      );
      if (conflict !== undefined && !takeOverGlobalRuntime) return yield* refuseOwnershipConflict(conflict);
      if (
        takeOverGlobalRuntime &&
        typeof current.owner !== 'string' &&
        current.owner.schemaVersion === DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION_V1 &&
        current.owner.version === current.activeVersion
      ) {
        return {
          activeVersion: current.activeVersion,
          owner: yield* writeDevelopmentRuntimeOwner(installRoot, current.owner),
        } satisfies DevelopmentRuntimeOwnershipSnapshot;
      }
      return current;
    }),
  );
  return takeOverGlobalRuntime
    ? ({...snapshot, requestedSourceCheckoutId} satisfies DevelopmentRuntimeTakeoverAuthorization)
    : undefined;
});

const requireDevelopmentRuntimeOwnership = Effect.fn('developmentInstall.requireRuntimeOwnership')(function* (
  installRoot: string,
  requestedSourceCheckoutId: string,
  authorization: DevelopmentRuntimeTakeoverAuthorization | undefined,
) {
  yield* validateRequestedSourceCheckoutId(requestedSourceCheckoutId);
  const snapshot = yield* readDevelopmentRuntimeOwnershipSnapshotUnlocked(installRoot);
  if (authorization !== undefined) {
    if (
      authorization.requestedSourceCheckoutId !== requestedSourceCheckoutId ||
      !developmentRuntimeTakeoverAuthorizationMatches(authorization, snapshot)
    ) {
      return yield* ScriptError.make({
        message:
          'Refusing to replace the global Threadnote runtime because ownership changed after takeover authorization. ' +
          'Confirm the current owner has finished, then rerun to obtain a fresh handoff.',
      });
    }
    return;
  }
  const conflict = developmentRuntimeOwnershipConflict(
    snapshot.activeVersion,
    snapshot.owner,
    requestedSourceCheckoutId,
  );
  if (conflict !== undefined) return yield* refuseOwnershipConflict(conflict);
});

export const readDevelopmentRuntimeOwner = Effect.fn('developmentInstall.readRuntimeOwner')(function* (
  installRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const file = path.join(installRoot, DEVELOPMENT_RUNTIME_OWNER_FILE);
  if (!(yield* fs.exists(file))) return 'absent';
  const [link, info] = yield* Effect.all([fs.readLink(file).pipe(Effect.option), fs.stat(file).pipe(Effect.option)]);
  if (
    Option.isSome(link) ||
    Option.isNone(info) ||
    info.value.type !== 'File' ||
    Number(info.value.size) > DEVELOPMENT_RUNTIME_OWNER_MAX_BYTES ||
    (system.platform !== 'win32' && (info.value.mode & 0o7777) !== 0o600)
  ) {
    return 'invalid';
  }
  const source = yield* fs.readFileString(file).pipe(Effect.option);
  if (Option.isNone(source)) return 'invalid';
  const value = yield* Effect.sync(() => {
    try {
      return JSON.parse(source.value) as unknown;
    } catch {
      return undefined;
    }
  });
  return value === undefined ? 'invalid' : parseDevelopmentRuntimeOwner(value);
});

function parseDevelopmentRuntimeOwner(value: unknown): DevelopmentRuntimeOwnershipState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid';
  const candidate = value as {
    readonly ownershipRevision?: unknown;
    readonly schemaVersion?: unknown;
    readonly sourceCheckoutId?: unknown;
    readonly version?: unknown;
  };
  const commonValid =
    typeof candidate.sourceCheckoutId === 'string' &&
    SHA256_PATTERN.test(candidate.sourceCheckoutId) &&
    typeof candidate.version === 'string' &&
    isDevelopmentBuildVersion(candidate.version);
  if (!commonValid) return 'invalid';
  if (candidate.schemaVersion === DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION_V1) {
    return candidate as DevelopmentRuntimeOwnerV1;
  }
  return candidate.schemaVersion === DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION &&
    typeof candidate.ownershipRevision === 'string' &&
    DEVELOPMENT_RUNTIME_OWNERSHIP_REVISION_PATTERN.test(candidate.ownershipRevision)
    ? (candidate as DevelopmentRuntimeOwnerV2)
    : 'invalid';
}

const writeDevelopmentRuntimeOwner = Effect.fn('developmentInstall.writeRuntimeOwner')(function* (
  installRoot: string,
  owner: Pick<DevelopmentRuntimeOwnerV2, 'sourceCheckoutId' | 'version'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const file = path.join(installRoot, DEVELOPMENT_RUNTIME_OWNER_FILE);
  const temporary = path.join(installRoot, `.${DEVELOPMENT_RUNTIME_OWNER_FILE}.${yield* crypto.randomUUIDv4}.tmp`);
  const nextOwner: DevelopmentRuntimeOwnerV2 = {
    ...owner,
    ownershipRevision: yield* crypto.randomUUIDv4,
    schemaVersion: DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION,
  };
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, `${JSON.stringify(nextOwner, undefined, 2)}\n`, {flag: 'wx', mode: 0o600});
    yield* fs.rename(temporary, file);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  return nextOwner;
});

/**
 * The complete managed-release mutation is one installation-lock critical
 * section. Activation is the commit point: a later health-repair failure keeps
 * the exact release active because repaired state may not be backward
 * compatible. Cleanup remains deferred so prior releases and processes survive
 * for diagnosis.
 */
export const activateLocalStandaloneRelease = Effect.fn('developmentInstall.activate')(function* (
  input: LocalStandaloneActivationInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const executable = path.join(input.releaseRoot, input.executableName);
  const criticalSection = Effect.gen(function* () {
    const roots = yield* requireCanonicalDevelopmentInstallRoots(
      input.canonicalInstallRoot,
      input.canonicalVersionsRoot,
      input.version,
      input.releaseRoot,
      input.stagedRoot,
    );
    const installRoot = roots.installRoot;
    yield* requireDevelopmentRuntimeOwnership(installRoot, input.sourceCheckoutId, input.ownershipAuthorization);
    let reused = input.reused;
    let promotedByThisInstall = false;
    if (Option.isSome(input.stagedRoot)) {
      if (yield* fs.exists(input.releaseRoot)) {
        const concurrentEvidence = yield* readDevelopmentReleaseEvidence(input.releaseRoot, input.commit).pipe(
          Effect.mapError(cause =>
            ScriptError.make({message: 'A concurrent exact-version development release is not reusable.', cause}),
          ),
        );
        yield* requireEvidenceVersion(concurrentEvidence, input.version);
        reused = true;
      } else {
        const stagedEvidence = yield* readDevelopmentReleaseEvidence(input.stagedRoot.value, input.commit).pipe(
          Effect.mapError(cause =>
            ScriptError.make({message: 'The staged development release changed before activation.', cause}),
          ),
        );
        yield* requireEvidenceVersion(stagedEvidence, input.version);
        yield* promoteStandaloneReleaseDirectory(fs, path, input.stagedRoot.value, input.releaseRoot, system.processId);
        promotedByThisInstall = true;
      }
    }
    const snapshots = yield* Effect.gen(function* () {
      const releaseEvidence = yield* readDevelopmentReleaseEvidence(input.releaseRoot, input.commit).pipe(
        Effect.mapError(cause =>
          ScriptError.make({
            cause,
            message: input.reused
              ? 'The existing exact-version development release is not reusable.'
              : 'The promoted development release failed validation.',
          }),
        ),
      );
      yield* requireEvidenceVersion(releaseEvidence, input.version);
      const doctor = yield* runCommandEffect(executable, ['doctor', '--dry-run'], {
        env: {...system.environment(), THREADNOTE_INSTALL_ROOT: installRoot},
        maxOutputBytes: 2 * 1024 * 1024,
        timeoutMs: 5 * 60_000,
      });
      if (!doctor.stdout.includes('Running Threadnote doctor checks.') || !doctor.stdout.includes('Summary:')) {
        return yield* ScriptError.make({
          message: 'The installed development executable did not complete doctor verification.',
        });
      }
      const managedFileSnapshots: LocalFileSnapshot[] = [];
      for (const {mode, kind} of yield* plannedCommandLauncherMutations()) {
        managedFileSnapshots.push(
          yield* captureFileSnapshot(fs, yield* commandLauncherPath(mode, kind), `${mode} ${kind} launcher`, 0o755),
        );
      }
      managedFileSnapshots.push(
        yield* captureFileSnapshot(fs, path.join(installRoot, 'active-release.json'), 'active release pointer', 0o600),
      );
      managedFileSnapshots.push(
        yield* captureFileSnapshot(
          fs,
          path.join(installRoot, DEVELOPMENT_RUNTIME_OWNER_FILE),
          'development runtime owner',
          0o600,
        ),
      );
      return managedFileSnapshots;
    }).pipe(
      Effect.catchCause(validationCause =>
        promotedByThisInstall
          ? fs.remove(input.releaseRoot, {force: true, recursive: true}).pipe(
              Effect.matchCauseEffect({
                onFailure: cleanupCause =>
                  Effect.fail(
                    ScriptError.make({
                      message: 'The new development release failed validation and could not be removed.',
                      cause: new AggregateError([Cause.squash(validationCause), Cause.squash(cleanupCause)]),
                    }),
                  ),
                onSuccess: () => Effect.failCause(validationCause),
              }),
            )
          : Effect.failCause(validationCause),
      ),
    );
    const activeEvidence = yield* Effect.gen(function* () {
      yield* activateStandaloneRelease(input.releaseRoot, false);
      const evidence = yield* readManagedDevelopmentRuntimeEvidence(input.commit);
      yield* installCommandShim(false, input.releaseRoot);
      yield* verifyLaunchers(fs, input.releaseRoot, input.version);
      yield* writeDevelopmentRuntimeOwner(installRoot, {
        sourceCheckoutId: input.sourceCheckoutId,
        version: input.version,
      });
      return evidence;
    }).pipe(
      Effect.catchCause(activationCause =>
        restoreFileSnapshots(fs, path, system, snapshots).pipe(
          Effect.matchCauseEffect({
            onFailure: rollbackCause =>
              Effect.fail(
                ScriptError.make({
                  message: 'Development release activation failed and rollback was incomplete.',
                  cause: new AggregateError([Cause.squash(activationCause), Cause.squash(rollbackCause)]),
                }),
              ),
            onSuccess: () => Effect.failCause(activationCause),
          }),
        ),
      ),
    );
    yield* verifyActivatedDevelopmentRelease(executable, installRoot, input.version).pipe(
      Effect.catchCause(healthCause =>
        Effect.fail(
          ScriptError.make({
            cause: Cause.squash(healthCause),
            message:
              'The exact-HEAD development release is active, but doctor verification still failed after repair. ' +
              'The prior release and superseded processes were preserved for diagnosis.',
          }),
        ),
      ),
    );

    let terminatedSupersededProcesses = 0;
    const preservedMcpSessionProcessIds = new Set<number>();
    const unresolvedProcessIds = new Set<number>();
    const cleanupIssues = new Set<LocalStandaloneCleanupIssue>();
    if (input.terminateSuperseded) {
      // Revalidate the pointer immediately before signaling. The installation
      // lock prevents it from changing until retirement and pruning finish.
      const activeRevalidation = yield* Effect.exit(readManagedDevelopmentRuntimeEvidence(input.commit));
      if (Exit.isFailure(activeRevalidation)) {
        cleanupIssues.add('process-termination');
      } else {
        const termination = yield* Effect.exit(terminateSupersededStandaloneProcesses(input.version));
        if (Exit.isFailure(termination)) {
          cleanupIssues.add('process-termination');
        } else {
          terminatedSupersededProcesses = termination.value.signaled.length;
          for (const lease of termination.value.preserved) preservedMcpSessionProcessIds.add(lease.processId);
          for (const lease of [...termination.value.skippedUnverified, ...termination.value.remaining]) {
            unresolvedProcessIds.add(lease.processId);
          }
        }
      }
    }
    const live = yield* Effect.exit(readStandaloneProcessLeaseVerification());
    if (Exit.isFailure(live)) {
      cleanupIssues.add('process-inspection');
    } else {
      if (live.value.truncated || live.value.unverified.length > 0) cleanupIssues.add('process-inspection');
      const superseded = [...live.value.verified, ...live.value.unverified].filter(
        lease => lease.version !== input.version,
      );
      // The benchmark/runtime preflight permits only the stable transport that
      // explicitly opted into session preservation. Its versioned MCP runtime
      // and workers remain terminate-policy leases, so report them as pending
      // retirement even before an explicit cleanup is requested.
      const preservedProcessIds = explicitlyPreservedStandaloneProcessIds(superseded);
      for (const lease of superseded) {
        if (preservedMcpSessionProcessIds.has(lease.processId)) continue;
        if (preservedProcessIds.has(lease.processId)) {
          preservedMcpSessionProcessIds.add(lease.processId);
          unresolvedProcessIds.delete(lease.processId);
        } else {
          unresolvedProcessIds.add(lease.processId);
        }
      }
    }
    if (Option.isSome(input.stagedRoot)) {
      const stagedRoot = input.stagedRoot.value;
      const stagedRemoval = yield* Effect.exit(
        Effect.gen(function* () {
          if (yield* fs.exists(stagedRoot)) {
            yield* fs.remove(stagedRoot, {force: true, recursive: true});
          }
          if (yield* fs.exists(stagedRoot)) {
            return yield* ScriptError.make({message: 'The development staging directory still exists after cleanup.'});
          }
        }),
      );
      if (Exit.isFailure(stagedRemoval)) cleanupIssues.add('staging-removal');
    }
    const pruning = yield* Effect.exit(pruneStandaloneReleases(input.releaseRoot, false));
    if (Exit.isFailure(pruning) || !pruning.value.complete) cleanupIssues.add('release-pruning');
    return {
      ...activeEvidence,
      active: true,
      cleanupComplete: cleanupIssues.size === 0 && unresolvedProcessIds.size === 0,
      cleanupIssues: [...cleanupIssues].sort(),
      doctorVerified: true,
      launchersVerified: true,
      preservedMcpSessionProcesses: preservedMcpSessionProcessIds.size,
      remainingSupersededProcesses: unresolvedProcessIds.size,
      reused,
      terminatedSupersededProcesses,
    } satisfies LocalStandaloneInstallResult;
  });
  return yield* withStandaloneInstallationLock(criticalSection).pipe(
    Effect.ensuring(
      Option.isSome(input.stagedRoot)
        ? fs.remove(input.stagedRoot.value, {force: true, recursive: true}).pipe(Effect.ignore)
        : Effect.void,
    ),
  );
});

const verifyActivatedDevelopmentRelease = Effect.fn('developmentInstall.verifyActivated')(function* (
  executable: string,
  installRoot: string,
  expectedVersion: string,
) {
  const system = yield* SystemInfo;
  const commandOptions = {
    env: {...system.environment(), THREADNOTE_INSTALL_ROOT: installRoot},
    maxOutputBytes: 2 * 1024 * 1024,
    timeoutMs: COMMAND_TIMEOUT_MILLISECONDS,
  } as const;
  const runDoctorStrict = () =>
    runCommandEffect(executable, ['doctor', '--dry-run', '--strict'], {...commandOptions, allowFailure: true});
  yield* runCommandEffect(
    executable,
    ['development-install-repair', '--activate-integrations', '--expected-version', expectedVersion],
    commandOptions,
  );
  const repair = () =>
    runCommandEffect(executable, ['development-install-repair', '--expected-version', expectedVersion], commandOptions);
  const initial = yield* runDoctorStrict();
  const initialFailures = developmentDoctorFailureCount(initial.stdout);
  if (initialFailures === undefined || (initial.exitCode !== 0 && initialFailures === 0)) {
    return yield* ScriptError.make({
      message: 'The activated development executable did not complete doctor verification.',
    });
  }
  if (initial.exitCode === 0 && initialFailures === 0) return;

  yield* repair();
  const repaired = yield* runDoctorStrict();
  const repairedFailures = developmentDoctorFailureCount(repaired.stdout);
  if (repaired.exitCode === 0 && repairedFailures === 0) return;
  if (
    repaired.exitCode === 0 ||
    repairedFailures === undefined ||
    !developmentDoctorHasOnlyConcurrentRecallProjectionFailures(repaired.stdout, repairedFailures)
  ) {
    return yield* ScriptError.make({
      message: 'The activated development executable still has doctor failures after repair.',
    });
  }

  yield* repair();
  const stabilized = yield* runDoctorStrict();
  if (stabilized.exitCode !== 0 || developmentDoctorFailureCount(stabilized.stdout) !== 0) {
    return yield* ScriptError.make({
      message: 'The activated development executable still has doctor failures after repair.',
    });
  }
});

function developmentDoctorFailureCount(stdout: string): number | undefined {
  const match = /(?:^|\r?\n)Summary: (\d+) failure\(s\), \d+ warning\(s\)(?:\r?\n|$)/u.exec(stdout);
  if (match?.[1] === undefined) return undefined;
  const failures = Number(match[1]);
  return Number.isSafeInteger(failures) ? failures : undefined;
}

export function developmentDoctorHasOnlyConcurrentRecallProjectionFailures(
  stdout: string,
  failureCount: number,
): boolean {
  const failures = stdout
    .split(/\r?\n/u)
    .map(line => /^FAIL\s+([^:]+):\s*(.*)$/u.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({detail: match[2] ?? '', name: match[1] ?? ''}));
  return (
    failures.length === failureCount &&
    failures.length > 0 &&
    failures.every(({detail, name}) => {
      if (name === 'lexical recall index') {
        return detail === 'canonical documents changed; run `threadnote repair`';
      }
      if (name !== 'vector recall index') return false;
      return (
        detail === 'unavailable until the lexical recall index is ready' ||
        /; stale; canonical documents changed; run `threadnote repair`$/u.test(detail)
      );
    })
  );
}

function requireEvidenceVersion(evidence: DevelopmentRuntimeEvidence, expectedVersion: string) {
  return evidence.version === expectedVersion
    ? Effect.void
    : Effect.fail(
        ScriptError.make({message: 'The validated development release version does not match its activation target.'}),
      );
}

interface LocalFileSnapshot {
  readonly content: Option.Option<string>;
  readonly file: string;
  readonly label: string;
  readonly mode: number;
}

const captureFileSnapshot = Effect.fn('developmentInstall.captureFileSnapshot')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  label: string,
  defaultMode: number,
) {
  const [exists, link, content, info] = yield* Effect.all([
    fs.exists(file),
    fs.readLink(file).pipe(Effect.option),
    fs.readFileString(file).pipe(Effect.option),
    fs.stat(file).pipe(Effect.option),
  ]);
  if (Option.isSome(link) || (exists && Option.isNone(content))) {
    return yield* ScriptError.make({message: 'A managed installation file cannot be safely snapshotted for rollback.'});
  }
  return {
    content,
    file,
    label,
    mode: Option.isSome(info) ? info.value.mode & 0o777 : defaultMode,
  } satisfies LocalFileSnapshot;
});

const restoreFileSnapshots = Effect.fn('developmentInstall.restoreFileSnapshots')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  snapshots: readonly LocalFileSnapshot[],
) {
  const failures: Error[] = [];
  for (const snapshot of snapshots) {
    const restored = yield* Effect.exit(restoreFileSnapshot(fs, path, system, snapshot));
    if (Exit.isFailure(restored)) {
      failures.push(
        ScriptError.make({message: `Could not restore the ${snapshot.label}.`, cause: Cause.squash(restored.cause)}),
      );
    }
  }
  if (failures.length > 0) {
    return yield* ScriptError.make({
      cause: new AggregateError(failures, 'One or more managed installation files were not restored.'),
      message: 'One or more managed installation files were not restored.',
    });
  }
});

const restoreFileSnapshot = Effect.fn('developmentInstall.restoreFileSnapshot')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  snapshot: LocalFileSnapshot,
) {
  if (Option.isNone(snapshot.content)) {
    yield* fs.remove(snapshot.file, {force: true});
    return;
  }
  const content = snapshot.content.value;
  yield* fs.makeDirectory(path.dirname(snapshot.file), {recursive: true, mode: 0o700});
  const temporary = path.join(
    path.dirname(snapshot.file),
    `.${path.basename(snapshot.file)}.${system.processId}.rollback`,
  );
  yield* Effect.gen(function* () {
    yield* fs.remove(temporary, {force: true});
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: snapshot.mode});
    if (system.platform !== 'win32') yield* fs.chmod(temporary, snapshot.mode);
    yield* fs.rename(temporary, snapshot.file);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

const buildAndStageDevelopmentRelease = Effect.fn('developmentInstall.buildAndStage')(function* (input: {
  readonly canonicalInstallRoot: string;
  readonly canonicalVersionsRoot: string;
  readonly commit: string;
  readonly executableName: string;
  readonly json: boolean;
  readonly releaseRoot: string;
  readonly sourceRoot: string;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  yield* requireCanonicalDevelopmentInstallRoots(
    input.canonicalInstallRoot,
    input.canonicalVersionsRoot,
    input.version,
    input.releaseRoot,
    Option.none(),
  );
  if (!input.json) yield* Console.log(`Building standalone Threadnote from ${input.commit.slice(0, 12)}.`);
  yield* runCommandEffect(system.executablePath, ['install', '--frozen-lockfile'], {
    cwd: input.sourceRoot,
    maxOutputBytes: 2 * 1024 * 1024,
    timeoutMs: COMMAND_TIMEOUT_MILLISECONDS,
  });
  yield* runCommandEffect(system.executablePath, ['run', 'build'], {
    cwd: input.sourceRoot,
    env: {...system.environment(), THREADNOTE_DEVELOPMENT_BUILD_VERSION: input.version},
    maxOutputBytes: 2 * 1024 * 1024,
    timeoutMs: COMMAND_TIMEOUT_MILLISECONDS,
  });
  const git = Option.fromNullishOr(Bun.which('git'));
  if (Option.isNone(git)) return yield* ScriptError.make({message: 'Git disappeared during the development build.'});
  const [afterCommit, afterStatus] = yield* Effect.all(
    [
      runCommandEffect(git.value, ['rev-parse', 'HEAD'], {cwd: input.sourceRoot}),
      runCommandEffect(git.value, CLEAN_GIT_STATUS_ARGUMENTS, {cwd: input.sourceRoot}),
    ],
    {concurrency: 2},
  );
  if (afterCommit.stdout.trim() !== input.commit || afterStatus.stdout.length > 0) {
    return yield* ScriptError.make({
      message: 'The Threadnote checkout changed while building the development executable.',
    });
  }
  const distributionRoot = path.join(input.sourceRoot, 'dist');
  const releaseMetadataPath = path.join(distributionRoot, 'release.json');
  const releaseMetadata = yield* readReleaseMetadata(fs, releaseMetadataPath);
  if (releaseMetadata.version !== input.version || releaseMetadata.executable !== input.executableName) {
    return yield* ScriptError.make({message: 'The development build did not embed its exact SHA-bound version.'});
  }
  const executable = path.join(distributionRoot, input.executableName);
  const payloadManifest = yield* collectDevelopmentPayloadManifest(distributionRoot);
  const [
    executableSha256,
    payloadManifestSha256,
    releaseMetadataSha256,
    sourceLockfileSha256,
    sourcePackageManifestSha256,
    versionResult,
  ] = yield* Effect.all(
    [
      sha256FileHex(executable),
      developmentPayloadManifestSha256(payloadManifest),
      sha256FileHex(releaseMetadataPath),
      sha256FileHex(path.join(input.sourceRoot, 'bun.lock')),
      sha256FileHex(path.join(input.sourceRoot, 'package.json')),
      runCommandEffect(executable, ['--version'], {maxOutputBytes: 16 * 1024, timeoutMs: 30_000}),
    ],
    {concurrency: 6},
  );
  if (versionResult.stdout.trim() !== `threadnote v${input.version}`) {
    return yield* ScriptError.make({message: 'The compiled development executable reported the wrong version.'});
  }
  const receipt: DevelopmentInstallReceiptV1 = {
    builtAt: DateTime.formatIso(yield* DateTime.now),
    dependencyInstallation: 'bun install --frozen-lockfile',
    executableSha256,
    payloadManifest,
    payloadManifestSha256,
    releaseMetadataSha256,
    runtime: releaseMetadata.runtime,
    schemaVersion: DEVELOPMENT_INSTALL_RECEIPT_VERSION,
    sourceCommit: input.commit,
    sourceDirty: false,
    sourceLockfileSha256,
    sourcePackageManifestSha256,
    target: releaseMetadata.target,
    version: input.version,
  };
  yield* requireCanonicalDevelopmentInstallRoots(
    input.canonicalInstallRoot,
    input.canonicalVersionsRoot,
    input.version,
    input.releaseRoot,
    Option.none(),
  );
  const crypto = yield* Crypto.Crypto;
  const stagedRoot = path.join(input.canonicalVersionsRoot, `.${input.version}.${yield* crypto.randomUUIDv4}.staging`);
  return yield* stageAndValidateDevelopmentRelease({
    distributionRoot,
    executableName: input.executableName,
    expectedSourceCommit: input.commit,
    receipt,
    stagedRoot,
    versionsRoot: input.canonicalVersionsRoot,
  });
});

const verifyLaunchers = Effect.fn('developmentInstall.verifyLaunchers')(function* (
  fs: FileSystem.FileSystem,
  releaseRoot: string,
  expectedVersion: string,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  let cliLauncher = '';
  for (const mode of yield* requiredCommandLauncherModes()) {
    for (const kind of managedCommandLauncherKinds(system.platform)) {
      const [launcher, expected] = yield* Effect.all([
        commandLauncherPath(mode, kind),
        renderCommandShim(releaseRoot, mode, kind),
      ]);
      const actual = yield* fs.readFileString(launcher);
      if (actual !== expected) {
        return yield* ScriptError.make({
          message: `The managed ${mode} ${kind} launcher did not activate the development release.`,
        });
      }
      if (system.platform !== 'win32') {
        const info = yield* fs.stat(launcher);
        if ((info.mode & 0o777) !== 0o755) yield* fs.chmod(launcher, 0o755);
        const repaired = yield* fs.stat(launcher);
        if ((repaired.mode & 0o777) !== 0o755) {
          return yield* ScriptError.make({
            message: `The managed ${mode} ${kind} launcher does not have safe executable mode.`,
          });
        }
      }
      if (mode === 'cli' && kind === primaryCommandLauncherKind(system.platform)) cliLauncher = launcher;
    }
  }
  if (cliLauncher === '') {
    return yield* ScriptError.make({message: 'No primary CLI launcher was verified for this platform.'});
  }
  const version = yield* runCommandEffect(cliLauncher, ['--version'], {
    env: {...system.environment(), THREADNOTE_INSTALL_ROOT: installationRoot(path, system)},
    maxOutputBytes: 16 * 1024,
    timeoutMs: 30_000,
  });
  if (version.stdout.trim() !== `threadnote v${expectedVersion}`) {
    return yield* ScriptError.make({
      message: 'The managed CLI launcher did not execute the activated development release.',
    });
  }
});

const requireCanonicalDevelopmentInstallRoots = Effect.fn('developmentInstall.requireCanonicalRoots')(function* (
  expectedInstallRoot: string,
  expectedVersionsRoot: string,
  version: string,
  releaseRoot: string,
  stagedRoot: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const current = yield* prepareCanonicalDevelopmentInstallRoots(installationRoot(path, system));
  if (!platformPathEquals(path, system, current.installRoot, expectedInstallRoot)) {
    return yield* ScriptError.make({
      message: 'The managed Threadnote installation root changed or escaped its canonical location.',
    });
  }
  if (!platformPathEquals(path, system, current.versionsRoot, expectedVersionsRoot)) {
    return yield* ScriptError.make({
      message: 'The managed Threadnote versions root changed or escaped its canonical location.',
    });
  }
  if (path.basename(releaseRoot) !== version) {
    return yield* ScriptError.make({message: 'The development release name does not match its version.'});
  }
  const releaseParent = yield* fs.realPath(path.dirname(releaseRoot));
  if (!platformPathEquals(path, system, releaseParent, current.versionsRoot)) {
    return yield* ScriptError.make({message: 'The development release parent is not the canonical versions root.'});
  }
  if (Option.isSome(stagedRoot)) {
    const name = path.basename(stagedRoot.value);
    const validName = name.startsWith(`.${version}.`) && name.endsWith('.staging');
    const stagedParent = yield* fs.realPath(path.dirname(stagedRoot.value));
    const parentMatches = platformPathEquals(path, system, stagedParent, current.versionsRoot);
    const link = yield* fs.readLink(stagedRoot.value).pipe(Effect.option);
    const info = yield* fs.stat(stagedRoot.value).pipe(Effect.option);
    const canonical = yield* fs.realPath(stagedRoot.value).pipe(Effect.option);
    if (
      !validName ||
      !parentMatches ||
      Option.isSome(link) ||
      Option.isNone(info) ||
      info.value.type !== 'Directory' ||
      Option.isNone(canonical) ||
      !platformPathEquals(path, system, canonical.value, path.join(stagedParent, name))
    ) {
      return yield* ScriptError.make({
        message: 'The development staging directory changed or escaped before activation.',
      });
    }
  }
  return current;
});

function platformPathEquals(
  path: Path.Path,
  system: Pick<SystemInfoShape, 'platform'>,
  left: string,
  right: string,
): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return system.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}

function readPackageManifest(fs: FileSystem.FileSystem, file: string) {
  return fs.readFileString(file).pipe(
    Effect.flatMap(source =>
      Effect.try({
        try: () => JSON.parse(source) as {readonly packageManager?: unknown; readonly version?: unknown},
        catch: cause => ScriptError.make({message: 'Could not parse package.json.', cause}),
      }),
    ),
    Effect.flatMap(manifest =>
      typeof manifest.version === 'string' &&
      manifest.version.length > 0 &&
      typeof manifest.packageManager === 'string' &&
      /^bun@\d+\.\d+\.\d+$/u.test(manifest.packageManager)
        ? Effect.succeed({packageManager: manifest.packageManager, version: manifest.version})
        : Effect.fail(ScriptError.make({message: 'package.json must declare a version and exact Bun packageManager.'})),
    ),
  );
}

function readReleaseMetadata(fs: FileSystem.FileSystem, file: string) {
  return fs.readFileString(file).pipe(
    Effect.flatMap(source =>
      Effect.try({
        try: () => JSON.parse(source) as unknown,
        catch: cause => ScriptError.make({message: 'Could not parse the development release metadata.', cause}),
      }),
    ),
    Effect.flatMap(value => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return Effect.fail(ScriptError.make({message: 'The development release metadata is invalid.'}));
      }
      const candidate = value as Partial<{
        readonly executable: string;
        readonly runtime: string;
        readonly target: string;
        readonly version: string;
      }>;
      return typeof candidate.executable === 'string' &&
        typeof candidate.runtime === 'string' &&
        typeof candidate.target === 'string' &&
        typeof candidate.version === 'string'
        ? Effect.succeed(candidate as {executable: string; runtime: string; target: string; version: string})
        : Effect.fail(ScriptError.make({message: 'The development release metadata is incomplete.'}));
    }),
  );
}

const systemLayer = ScriptSystemInfoLayer;
const commandLayer = ScriptCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const installerLayer = Layer.merge(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));
const program = Effect.gen(function* () {
  const options = parseLocalStandaloneInstallArguments(yield* scriptArguments());
  return yield* installLocalStandalone(options);
});

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, installerLayer));
