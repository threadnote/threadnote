import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Console, Crypto, DateTime, Effect, Exit, FileSystem, Option, Path, Schema} from 'effect';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {observeProcessInstanceIdentity, processInstanceIdentityMatches} from './process_identity.js';
import {compareVersions} from '../release/version/compare.js';
import {createMissingProcessFile} from './owned_file.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class StandaloneProcessLeaseError extends Schema.TaggedError<
  StandaloneProcessLeaseError,
  {readonly brand: unique symbol}
>()('StandaloneProcessLeaseError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const THREADNOTE_COMMAND = 'threadnote';
const PROCESS_LEASE_HEARTBEAT_MILLISECONDS = 30_000;
const PROCESS_LEASE_REPAIR_FAILURE_LIMIT = 3;
const PROCESS_LEASE_DIAGNOSTIC_SCAN_LIMIT = 1_024;
export const STANDALONE_RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface StandaloneActiveRelease {
  readonly releaseRoot: string;
  readonly version: string;
}

interface ProcessLeaseFile {
  readonly parentProcessId: Option.Option<number>;
  readonly processId: number;
  readonly processStartIdentity: Option.Option<string>;
  readonly retirementPolicy: StandaloneProcessRetirementPolicy;
  readonly startedAt: Option.Option<string>;
  readonly token: string;
  readonly version: string;
}

export type StandaloneProcessRetirementPolicy = 'preserve-session' | 'terminate';

/**
 * Privacy-safe process evidence retained by standalone releases predating the
 * runtime process registry. Paths and ownership tokens intentionally never
 * leave this focused lease module.
 */
export interface StandaloneProcessLease {
  readonly parentProcessId: Option.Option<number>;
  readonly processId: number;
  readonly retirementPolicy: StandaloneProcessRetirementPolicy;
  readonly startedAt: Option.Option<string>;
  readonly version: string;
}

export interface StandaloneProcessLeaseDiagnostics {
  readonly leases: readonly StandaloneProcessLease[];
  readonly truncated: boolean;
}

/**
 * Fail-closed process evidence for maintenance and benchmark boundaries. Unlike
 * the user-facing diagnostics, this keeps running leases whose OS start
 * identity could not be read so callers cannot mistake uncertainty for an
 * idle machine.
 */
export interface StandaloneProcessLeaseVerification {
  readonly truncated: boolean;
  readonly unverified: readonly StandaloneProcessLease[];
  readonly verified: readonly StandaloneProcessLease[];
}

interface ObservedStandaloneProcessLease extends StandaloneProcessLease {
  readonly identityVerified: boolean;
  readonly processStartIdentity: Option.Option<string>;
}

export interface SupersededStandaloneProcessTermination {
  readonly preserved: readonly StandaloneProcessLease[];
  readonly remaining: readonly StandaloneProcessLease[];
  readonly signaled: readonly StandaloneProcessLease[];
  readonly skippedUnverified: readonly StandaloneProcessLease[];
}

export function installationRoot(path: Path.Path, system: SystemInfoShape): string {
  const configured = Effect2.pipe(system.environment().THREADNOTE_INSTALL_ROOT, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (configured) return path.resolve(configured);
  const currentRoot = path.dirname(system.executablePath);
  if (path.basename(path.dirname(currentRoot)) === 'versions') {
    return path.dirname(path.dirname(currentRoot));
  }
  const localAppData = system.environment().LOCALAPPDATA;
  if (system.platform === 'win32' && localAppData) return path.join(localAppData, 'Threadnote');
  return path.join(system.homeDirectory, '.local', 'share', THREADNOTE_COMMAND);
}

/**
 * Pins the versioned standalone release for the full process lifetime. Worker
 * processes acquire their own lease so a killed parent cannot prune code that
 * a still-running child is executing.
 */
export function withStandaloneProcessLease<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: {readonly retirementPolicy?: StandaloneProcessRetirementPolicy} = {},
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const root = installationRoot(path, system);
      const release = yield* readValidatedRelease(fs, path, path.dirname(system.executablePath), root);
      if (!release) return yield* effect;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4();
      const processStartIdentity = yield* observeProcessInstanceIdentity(system, system.processId);
      const leaseDirectory = path.join(root, 'leases', release.version);
      const leasePath = path.join(leaseDirectory, `${system.processId}.json`);
      const content = `${JSON.stringify(
        {
          executable: system.executablePath,
          parentProcessId: process.ppid,
          processId: system.processId,
          processStartIdentity,
          retirementPolicy: options.retirementPolicy ?? 'terminate',
          startedAt: DateTime.formatIso(yield* DateTime.now),
          token,
          version: release.version,
        },
        undefined,
        2,
      )}\n`;
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(leaseDirectory, {recursive: true, mode: 0o700});
        yield* fs.writeFileString(leasePath, content, {mode: 0o600});
      }).pipe(
        Effect.tapError(() =>
          Console.error(
            `Threadnote could not write a process lease under ${root}. Grant this installation root write access to run inside a restricted sandbox.`,
          ),
        ),
      );
      yield* Effect.addFinalizer(() => removeOwnedLease(fs, leasePath, token));
      return yield* Effect.raceFirst(
        refreshProcessLease(fs, leaseDirectory, leasePath, token, content, path.join(root, `.lease-${token}.tmp`)).pipe(
          Effect.andThen(Effect.never),
        ),
        effect,
      );
    }),
  );
}

export function readValidatedRelease(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
  installRoot: string,
) {
  return Effect.gen(function* () {
    const content = yield* fs.readFileString(path.join(releaseRoot, 'release.json'));
    const value = yield* Effect.try(() => JSON.parse(content) as unknown);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      typeof value.version !== 'string' ||
      !STANDALONE_RELEASE_VERSION_PATTERN.test(value.version)
    ) {
      return undefined;
    }
    const [realInstallRoot, resolvedRoot] = yield* Effect.all([fs.realPath(installRoot), fs.realPath(releaseRoot)]);
    const expectedRoot = path.join(realInstallRoot, 'versions', value.version);
    const normalize = (candidate: string) =>
      path.sep === '\\'
        ? Effect2.pipe(path.resolve(candidate), EffectString.toLocaleLowerCase('en-US'))
        : path.resolve(candidate);
    return normalize(expectedRoot) === normalize(resolvedRoot)
      ? ({releaseRoot: resolvedRoot, version: value.version} satisfies StandaloneActiveRelease)
      : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));
}

export const readLiveStandaloneProcessLeases = Effect.fn('installations.readLiveProcessLeases')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const scan = yield* liveStandaloneProcessLeases(
    fs,
    path,
    installationRoot(path, system),
    system,
    Option.some(PROCESS_LEASE_DIAGNOSTIC_SCAN_LIMIT),
  );
  const unique = new Map<number, StandaloneProcessLease>();
  // Pruning remains conservative when identity lookup is unavailable, but a
  // user-facing diagnostic must not label an unrelated reused PID as
  // Threadnote without a verified start identity.
  for (const lease of EffectArrayPipe(scan.leases, __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (lease, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && lease.identityVerified,
    ),
  ).sort((left, right) => compareVersions(right.version, left.version))) {
    if (!unique.has(lease.processId)) unique.set(lease.processId, lease);
  }
  return {
    leases: [...unique.values()].sort((left, right) => left.processId - right.processId),
    truncated: scan.truncated,
  } satisfies StandaloneProcessLeaseDiagnostics;
});

export const readStandaloneProcessLeaseVerification = Effect.fn('installations.readProcessLeaseVerification')(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const scan = yield* liveStandaloneProcessLeases(
      fs,
      path,
      installationRoot(path, system),
      system,
      Option.some(PROCESS_LEASE_DIAGNOSTIC_SCAN_LIMIT),
    );
    const unique = (leases: readonly ObservedStandaloneProcessLease[]) => {
      const byProcess = new Map<number, StandaloneProcessLease>();
      for (const lease of [...leases].sort((left, right) => compareVersions(right.version, left.version))) {
        if (!byProcess.has(lease.processId)) byProcess.set(lease.processId, publicLease(lease));
      }
      return [...byProcess.values()].sort((left, right) => left.processId - right.processId);
    };
    return {
      truncated: scan.truncated,
      unverified: unique(EffectArray.filter(scan.leases, lease => !lease.identityVerified)),
      verified: unique(
        EffectArrayPipe(scan.leases, __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (lease, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && lease.identityVerified,
          ),
        ),
      ),
    } satisfies StandaloneProcessLeaseVerification;
  },
);

export const liveReleaseLeaseVersions = Effect.fn('installations.liveLeaseVersions')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  installRoot: string,
  system: SystemInfoShape,
) {
  const scan = yield* liveStandaloneProcessLeases(
    fs,
    path,
    installRoot,
    system,
    Option.some(PROCESS_LEASE_DIAGNOSTIC_SCAN_LIMIT),
  );
  if (scan.truncated) {
    return yield* StandaloneProcessLeaseError.make({
      message: 'Standalone release pruning could not completely inspect the live process leases.',
    });
  }
  return [...new Set(EffectArray.map(scan.leases, lease => lease.version))];
});

/**
 * Explicit developer-maintenance operation for retiring processes pinned to a
 * superseded standalone release. Every signal is guarded by a fresh process
 * start-identity comparison; leases without verifiable identity are reported
 * but never signaled.
 */
export const terminateSupersededStandaloneProcesses = Effect.fn('installations.terminateSupersededProcesses')(
  function* (activeVersion: string, options: {readonly gracefulWaitMilliseconds?: number} = {}) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    if (!STANDALONE_RELEASE_VERSION_PATTERN.test(activeVersion)) {
      return yield* StandaloneProcessLeaseError.make({
        message: 'Cannot terminate processes for an invalid active release version.',
      });
    }
    const scan = yield* liveStandaloneProcessLeases(
      fs,
      path,
      installationRoot(path, system),
      system,
      Option.some(PROCESS_LEASE_DIAGNOSTIC_SCAN_LIMIT),
    );
    if (scan.truncated) {
      return yield* StandaloneProcessLeaseError.make({
        message: 'Cannot terminate superseded processes because live lease inspection was incomplete.',
      });
    }
    const superseded = EffectArray.filter(
      scan.leases,
      lease => lease.version !== activeVersion && lease.processId !== system.processId,
    );
    // The stable broker is explicitly session-pinned, but its versioned MCP
    // runtime and workers retain the default terminate policy. An explicit
    // maintenance cleanup must therefore preserve only leases that opted in,
    // rather than treating every descendant of the broker as pinned too.
    const preservedIds = explicitlyPreservedStandaloneProcessIds(superseded);
    const preserved = EffectArray.filter(superseded, lease => preservedIds.has(lease.processId));
    const eligible = EffectArray.filter(superseded, lease => !preservedIds.has(lease.processId));
    const verified = EffectArray.filter(eligible, lease => lease.identityVerified);
    const skippedUnverified = EffectArray.map(
      EffectArray.filter(eligible, lease => !lease.identityVerified),
      publicLease,
    );
    const candidateIds = new Set(EffectArray.map(verified, lease => lease.processId));
    const roots = EffectArray.filter(
      verified,
      lease => Option.isNone(lease.parentProcessId) || !candidateIds.has(lease.parentProcessId.value),
    );
    const descendants = EffectArray.filter(verified, lease => !roots.includes(lease));
    const signaled = new Map<number, StandaloneProcessLease>();
    for (const lease of roots) {
      if (yield* signalLeaseIfStillOwned(system, lease, 'SIGTERM')) {
        signaled.set(lease.processId, publicLease(lease));
      }
    }
    yield* waitForLeasesToExit(system, roots, boundedGracefulWait(options.gracefulWaitMilliseconds));
    for (const lease of descendants) {
      if (yield* signalLeaseIfStillOwned(system, lease, 'SIGTERM')) {
        signaled.set(lease.processId, publicLease(lease));
      }
    }
    yield* waitForLeasesToExit(system, descendants, boundedGracefulWait(options.gracefulWaitMilliseconds));
    for (const lease of verified) {
      if (yield* signalLeaseIfStillOwned(system, lease, 'SIGKILL')) {
        signaled.set(lease.processId, publicLease(lease));
      }
    }
    yield* waitForLeasesToExit(system, verified, 1_000);
    return {
      preserved: EffectArray.map(preserved, publicLease).sort((left, right) => left.processId - right.processId),
      remaining: EffectArray.map(
        EffectArray.filter(verified, lease => system.isProcessRunning(lease.processId)),
        publicLease,
      ),
      signaled: [...signaled.values()].sort((left, right) => left.processId - right.processId),
      skippedUnverified: skippedUnverified.sort((left, right) => left.processId - right.processId),
    } satisfies SupersededStandaloneProcessTermination;
  },
);

const liveStandaloneProcessLeases = Effect.fn('installations.liveProcessLeases')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  installRoot: string,
  system: SystemInfoShape,
  scanLimit: Option.Option<number>,
) {
  const leasesRoot = path.join(installRoot, 'leases');
  if (!(yield* fs.exists(leasesRoot))) {
    return {leases: [] as readonly ObservedStandaloneProcessLease[], truncated: false};
  }
  const live: ObservedStandaloneProcessLease[] = [];
  let inspected = 0;
  let truncated = false;
  const versions = yield* Effect.exit(fs.readDirectory(leasesRoot));
  if (Exit.isFailure(versions)) {
    return {leases: live, truncated: true};
  }
  scan: for (const version of versions.value.sort()) {
    if (!STANDALONE_RELEASE_VERSION_PATTERN.test(version)) {
      truncated = true;
      continue;
    }
    const versionRoot = path.join(leasesRoot, version);
    const names = yield* Effect.exit(fs.readDirectory(versionRoot));
    if (Exit.isFailure(names)) {
      truncated = true;
      continue;
    }
    for (const name of names.value.sort()) {
      if (Option.isSome(scanLimit) && inspected >= scanLimit.value) {
        truncated = true;
        break scan;
      }
      inspected += 1;
      const processId = Number(/^([1-9]\d*)\.json$/.exec(name)?.[1]);
      const leasePath = path.join(versionRoot, name);
      if (!Number.isSafeInteger(processId) || processId <= 0) {
        truncated = true;
        continue;
      }
      const lease = yield* readProcessLease(fs, leasePath);
      if (Option.isNone(lease) || lease.value.processId !== processId || lease.value.version !== version) {
        if (system.isProcessRunning(processId)) truncated = true;
        else yield* fs.remove(leasePath, {force: true}).pipe(Effect.ignore);
        continue;
      }
      const processIsRunning = system.isProcessRunning(processId);
      const currentProcessIdentity = processIsRunning
        ? yield* observeProcessInstanceIdentity(system, processId)
        : undefined;
      const storedProcessIdentity = Option.getOrUndefined(lease.value.processStartIdentity);
      const identityMatches = processInstanceIdentityMatches(storedProcessIdentity, currentProcessIdentity);
      if (processIsRunning && identityMatches) {
        const processStartIdentity =
          currentProcessIdentity !== undefined &&
          storedProcessIdentity !== undefined &&
          storedProcessIdentity !== currentProcessIdentity
            ? Option.some(currentProcessIdentity)
            : lease.value.processStartIdentity;
        if (Option.isSome(processStartIdentity) && processStartIdentity.value !== storedProcessIdentity) {
          yield* rewriteLeaseProcessStartIdentity(fs, leasePath, processStartIdentity.value).pipe(Effect.ignore);
        }
        live.push({
          identityVerified:
            Option.isSome(processStartIdentity) &&
            currentProcessIdentity !== undefined &&
            processStartIdentity.value === currentProcessIdentity,
          parentProcessId: lease.value.parentProcessId,
          processId,
          processStartIdentity,
          retirementPolicy: lease.value.retirementPolicy,
          startedAt: lease.value.startedAt,
          version,
        });
      } else {
        yield* fs.remove(leasePath, {force: true}).pipe(Effect.ignore);
      }
    }
  }
  return {leases: live, truncated};
});

function publicLease(lease: ObservedStandaloneProcessLease): StandaloneProcessLease {
  return {
    parentProcessId: lease.parentProcessId,
    processId: lease.processId,
    retirementPolicy: lease.retirementPolicy,
    startedAt: lease.startedAt,
    version: lease.version,
  };
}

/** @internal Pure ancestry closure used by process-retirement tests. */
export function preservedStandaloneProcessIds(
  leases: readonly Pick<StandaloneProcessLease, 'parentProcessId' | 'processId' | 'retirementPolicy'>[],
): ReadonlySet<number> {
  const preserved = new Set(explicitlyPreservedStandaloneProcessIds(leases));
  let changed = true;
  while (changed) {
    changed = false;
    for (const lease of leases) {
      if (
        !preserved.has(lease.processId) &&
        Option.isSome(lease.parentProcessId) &&
        preserved.has(lease.parentProcessId.value)
      ) {
        preserved.add(lease.processId);
        changed = true;
      }
    }
  }
  return preserved;
}

/** @internal Explicit preserve-session leases remain alive during requested retirement. */
export function explicitlyPreservedStandaloneProcessIds(
  leases: readonly Pick<StandaloneProcessLease, 'processId' | 'retirementPolicy'>[],
): ReadonlySet<number> {
  return new Set(
    EffectArray.map(
      EffectArray.filter(leases, lease => lease.retirementPolicy === 'preserve-session'),
      lease => lease.processId,
    ),
  );
}

function signalLeaseIfStillOwned(
  system: SystemInfoShape,
  lease: ObservedStandaloneProcessLease,
  signal: NodeJS.Signals,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (!system.isProcessRunning(lease.processId) || Option.isNone(lease.processStartIdentity)) return false;
    const identity = yield* observeProcessInstanceIdentity(system, lease.processId);
    if (identity !== lease.processStartIdentity.value) return false;
    return yield* Effect.try({
      try: () => {
        system.signalProcess(lease.processId, signal);
        return true;
      },
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false));
  });
}

function waitForLeasesToExit(
  system: SystemInfoShape,
  leases: readonly ObservedStandaloneProcessLease[],
  waitMilliseconds: number,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const iterations = Math.ceil(waitMilliseconds / 100);
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (EffectArray.every(leases, lease => !system.isProcessRunning(lease.processId))) return;
      yield* Effect.sleep(100);
    }
  });
}

function boundedGracefulWait(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 30_000) : 5_000;
}

function refreshProcessLease(
  fs: FileSystem.FileSystem,
  leaseDirectory: string,
  leasePath: string,
  token: string,
  content: string,
  temporary: string,
) {
  return Effect.gen(function* () {
    let repairFailures = 0;
    let repairing = false;
    while (true) {
      yield* Effect.sleep(PROCESS_LEASE_HEARTBEAT_MILLISECONDS);
      const retained = yield* Effect.gen(function* () {
        if (!(yield* fs.exists(leasePath))) {
          repairing = true;
          yield* fs.makeDirectory(leaseDirectory, {recursive: true, mode: 0o700});
          const restored = yield* createMissingProcessFile(fs, leasePath, temporary, content);
          repairing = false;
          repairFailures = 0;
          return restored;
        }
        if ((yield* readLeaseToken(fs, leasePath, true)) !== token) return false;
        repairing = false;
        repairFailures = 0;
        const now = yield* DateTime.nowAsDate;
        yield* fs.utimes(leasePath, now, now);
        return true;
      }).pipe(
        Effect.catch(() => {
          if (!repairing || ++repairFailures < PROCESS_LEASE_REPAIR_FAILURE_LIMIT) return Effect.succeed(true);
          const message =
            `Threadnote could not restore its process lease after ${PROCESS_LEASE_REPAIR_FAILURE_LIMIT} consecutive attempts; ` +
            'stopping this process to protect its release. Check installation filesystem write access and atomic hard-link support.';
          return Console.error(message).pipe(Effect.andThen(Effect.fail(StandaloneProcessLeaseError.make({message}))));
        }),
      );
      if (!retained) {
        return yield* StandaloneProcessLeaseError.make({
          message: 'Threadnote lost ownership of its process lease; stopping this process to protect its release.',
        });
      }
    }
  });
}

function removeOwnedLease(fs: FileSystem.FileSystem, leasePath: string, token: string) {
  return Effect.gen(function* () {
    if ((yield* readLeaseToken(fs, leasePath)) === token) yield* fs.remove(leasePath, {force: true});
  }).pipe(Effect.ignore);
}

function rewriteLeaseProcessStartIdentity(fs: FileSystem.FileSystem, leasePath: string, processStartIdentity: string) {
  return fs.readFileString(leasePath).pipe(
    Effect.flatMap(content => {
      let value: unknown;
      try {
        value = JSON.parse(content) as unknown;
      } catch {
        return Effect.void;
      }
      if (typeof value !== 'object' || value === null) return Effect.void;
      return fs.writeFileString(leasePath, `${JSON.stringify({...value, processStartIdentity}, undefined, 2)}\n`, {
        mode: 0o600,
      });
    }),
  );
}

function readLeaseToken(fs: FileSystem.FileSystem, leasePath: string, strict = false) {
  return readProcessLease(fs, leasePath, strict).pipe(
    Effect.map(Option.map(lease => lease.token)),
    Effect.map(Option.getOrUndefined),
  );
}

function readProcessLease(fs: FileSystem.FileSystem, leasePath: string, strict = false) {
  const read = fs.readFileString(leasePath).pipe(
    Effect.map(content => {
      let value: unknown;
      try {
        value = JSON.parse(content) as unknown;
      } catch {
        return Option.none<ProcessLeaseFile>();
      }
      if (
        typeof value !== 'object' ||
        value === null ||
        !('processId' in value) ||
        !('token' in value) ||
        !('version' in value) ||
        typeof value.processId !== 'number' ||
        !Number.isSafeInteger(value.processId) ||
        value.processId <= 0 ||
        typeof value.token !== 'string' ||
        typeof value.version !== 'string' ||
        !STANDALONE_RELEASE_VERSION_PATTERN.test(value.version) ||
        ('processStartIdentity' in value &&
          value.processStartIdentity !== undefined &&
          typeof value.processStartIdentity !== 'string')
      ) {
        return Option.none<ProcessLeaseFile>();
      }
      const parentProcessId =
        'parentProcessId' in value && Number.isSafeInteger(value.parentProcessId) && Number(value.parentProcessId) >= 0
          ? Option.some(Number(value.parentProcessId))
          : Option.none<number>();
      const processStartIdentity =
        'processStartIdentity' in value && typeof value.processStartIdentity === 'string'
          ? Option.some(value.processStartIdentity)
          : Option.none<string>();
      const startedAt =
        'startedAt' in value && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
          ? Option.some(value.startedAt)
          : Option.none<string>();
      const retirementPolicy =
        'retirementPolicy' in value && value.retirementPolicy === 'preserve-session' ? 'preserve-session' : 'terminate';
      return Option.some({
        parentProcessId,
        processId: value.processId,
        processStartIdentity,
        retirementPolicy,
        startedAt,
        token: value.token,
        version: value.version,
      } satisfies ProcessLeaseFile);
    }),
  );
  return strict ? read : read.pipe(Effect.orElseSucceed(() => Option.none<ProcessLeaseFile>()));
}
