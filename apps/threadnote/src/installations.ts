import {Console, Crypto, Effect, FileSystem, Path, Predicate, Schema} from 'effect';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {
  installationRoot,
  liveReleaseLeaseVersions,
  readLiveStandaloneProcessLeases,
  readValidatedRelease,
  STANDALONE_RELEASE_VERSION_PATTERN as RELEASE_VERSION_PATTERN,
  withStandaloneProcessLease,
  type StandaloneActiveRelease as ActiveRelease,
} from './process/standalone_lease.js';
import {compareVersions} from './release/version/compare.js';

class InstallationOperationError extends Schema.TaggedError<InstallationOperationError>()(
  'InstallationOperationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

const ACTIVE_RELEASE_FILE = 'active-release.json';
const ACTIVE_RELEASE_BACKUP_FILE = 'active-release.previous.json';
const ACTIVE_RELEASE_JOURNAL_FILE = 'active-release.promotion.json';
const PROMOTION_JOURNAL_VERSION = 1 as const;
const RETAINED_RELEASE_COUNT = 2;
const INSTALLATION_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 60_000,
  waitTimeoutMilliseconds: 10 * 60_000,
} as const;

interface ActiveReleasePromotion {
  readonly activePath: string;
  readonly backupPath: string;
  readonly temporaryPath: string;
  readonly version: typeof PROMOTION_JOURNAL_VERSION;
}

interface ReleaseDirectoryPromotion {
  readonly backupRoot: string;
  readonly releaseRoot: string;
  readonly stagedRoot: string;
  readonly version: typeof PROMOTION_JOURNAL_VERSION;
}

export type StandalonePromotionStep =
  | 'active-journaled'
  | 'active-previous-backed-up'
  | 'active-promoted'
  | 'release-journaled'
  | 'release-previous-backed-up'
  | 'release-promoted';

export interface StandalonePromotionFaultInjection {
  readonly afterStep?: (step: StandalonePromotionStep) => Effect.Effect<void, unknown>;
}

export {installationRoot, readLiveStandaloneProcessLeases, withStandaloneProcessLease};

export const activateStandaloneRelease = Effect.fn('installations.activateRelease')(function* (
  releaseRoot: string,
  dryRun: boolean,
  faultInjection: StandalonePromotionFaultInjection = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = installationRoot(path, system);
  const release = yield* readValidatedRelease(fs, path, releaseRoot, root);
  if (!release) return;
  if (dryRun) {
    yield* Console.log(`Would mark standalone Threadnote ${release.version} as active.`);
    return;
  }
  yield* recoverActiveReleasePromotion(fs, path, root);
  const crypto = yield* Crypto.Crypto;
  const operationId = `${system.processId}-${yield* crypto.randomUUIDv4}`;
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  const activePath = path.join(root, ACTIVE_RELEASE_FILE);
  const backupPath = path.join(root, ACTIVE_RELEASE_BACKUP_FILE);
  const journalPath = path.join(root, ACTIVE_RELEASE_JOURNAL_FILE);
  const temporaryPath = path.join(root, `.active-release.${operationId}.next.json`);
  yield* fs.remove(temporaryPath, {force: true});
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(release, undefined, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  yield* syncWritableFile(fs, temporaryPath);
  yield* writePrivateJsonAtomically(fs, path, journalPath, {
    activePath,
    backupPath,
    temporaryPath,
    version: PROMOTION_JOURNAL_VERSION,
  } satisfies ActiveReleasePromotion);
  yield* faultInjection.afterStep?.('active-journaled') ?? Effect.void;
  const activeExists = yield* fs.exists(activePath);
  yield* fs.remove(backupPath, {force: true});
  if (activeExists) {
    yield* fs.rename(activePath, backupPath);
    yield* syncDirectoryBestEffort(fs, root);
  }
  yield* faultInjection.afterStep?.('active-previous-backed-up') ?? Effect.void;
  yield* fs
    .rename(temporaryPath, activePath)
    .pipe(Effect.tapError(() => recoverActiveReleasePromotion(fs, path, root)));
  yield* syncDirectoryBestEffort(fs, root);
  yield* faultInjection.afterStep?.('active-promoted') ?? Effect.void;
  yield* fs.remove(backupPath, {force: true});
  yield* fs.remove(journalPath, {force: true});
  yield* syncDirectoryBestEffort(fs, root);
});

export const promoteStandaloneReleaseDirectory = Effect.fn('installations.promoteReleaseDirectory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stagedRoot: string,
  releaseRoot: string,
  processId: number,
  faultInjection: StandalonePromotionFaultInjection = {},
) {
  const resolvedReleaseRoot = path.resolve(releaseRoot);
  const versionsRoot = path.dirname(resolvedReleaseRoot);
  const releaseName = path.basename(resolvedReleaseRoot);
  if (!RELEASE_VERSION_PATTERN.test(releaseName)) {
    return yield* InstallationOperationError.make({
      message: `Cannot promote an invalid standalone release path: ${releaseRoot}`,
    });
  }
  const resolvedStagedRoot = path.resolve(stagedRoot);
  if (!isStandaloneStagingPath(path, versionsRoot, releaseName, resolvedStagedRoot)) {
    return yield* InstallationOperationError.make({
      message: `Standalone release staging path is not recognized within ${versionsRoot}: ${stagedRoot}`,
    });
  }
  yield* recoverStandaloneReleasePromotion(fs, path, resolvedReleaseRoot);
  const backupRoot = releasePromotionBackupPath(path, resolvedReleaseRoot);
  const journalPath = releasePromotionJournalPath(path, resolvedReleaseRoot);
  yield* fs.remove(backupRoot, {force: true, recursive: true});
  yield* writePrivateJsonAtomically(fs, path, journalPath, {
    backupRoot,
    releaseRoot: resolvedReleaseRoot,
    stagedRoot: resolvedStagedRoot,
    version: PROMOTION_JOURNAL_VERSION,
  } satisfies ReleaseDirectoryPromotion);
  yield* faultInjection.afterStep?.('release-journaled') ?? Effect.void;
  if (yield* fs.exists(resolvedReleaseRoot)) {
    yield* fs.rename(resolvedReleaseRoot, backupRoot);
    yield* syncDirectoryBestEffort(fs, versionsRoot);
  }
  yield* faultInjection.afterStep?.('release-previous-backed-up') ?? Effect.void;
  yield* fs
    .rename(resolvedStagedRoot, resolvedReleaseRoot)
    .pipe(Effect.tapError(() => recoverStandaloneReleasePromotion(fs, path, resolvedReleaseRoot)));
  yield* syncDirectoryBestEffort(fs, versionsRoot);
  yield* faultInjection.afterStep?.('release-promoted') ?? Effect.void;
  yield* fs.remove(backupRoot, {force: true, recursive: true});
  yield* fs.remove(journalPath, {force: true});
  yield* syncDirectoryBestEffort(fs, versionsRoot);
  void processId;
});

export const recoverStandaloneReleasePromotion = Effect.fn('installations.recoverReleasePromotion')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
) {
  const resolvedReleaseRoot = path.resolve(releaseRoot);
  const journalPath = releasePromotionJournalPath(path, resolvedReleaseRoot);
  const journalExists = yield* fs.exists(journalPath);
  const promotion = journalExists
    ? yield* readReleaseDirectoryPromotion(fs, path, journalPath, resolvedReleaseRoot)
    : undefined;
  const backupRoot = releasePromotionBackupPath(path, resolvedReleaseRoot);
  const bootstrapStagedRoot = path.join(
    path.dirname(resolvedReleaseRoot),
    `.${path.basename(resolvedReleaseRoot)}.bootstrap.staging`,
  );
  const releaseExists = yield* fs.exists(resolvedReleaseRoot);
  const backupExists = yield* fs.exists(backupRoot);
  const bootstrapStagingExists = yield* fs.exists(bootstrapStagedRoot);
  if (!releaseExists && backupExists) {
    yield* fs.rename(backupRoot, resolvedReleaseRoot);
  } else if (releaseExists && backupExists) {
    yield* fs.remove(backupRoot, {force: true, recursive: true});
  }
  if (promotion) {
    yield* fs.remove(standaloneStagingCleanupRoot(path, path.dirname(resolvedReleaseRoot), promotion.stagedRoot), {
      force: true,
      recursive: true,
    });
  }
  if (bootstrapStagingExists && promotion?.stagedRoot !== bootstrapStagedRoot) {
    yield* fs.remove(bootstrapStagedRoot, {force: true, recursive: true});
  }
  if (journalExists) yield* fs.remove(journalPath, {force: true});
  if (!journalExists && !backupExists && !bootstrapStagingExists) return false;
  yield* syncDirectoryBestEffort(fs, path.dirname(resolvedReleaseRoot));
  return true;
});

export const activeInstalledRelease = Effect.fn('installations.activeRelease')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = installationRoot(path, system);
  const readValidatedPointer = (pointerPath: string) =>
    Effect.gen(function* () {
      const pointer = yield* readActiveRelease(fs, pointerPath);
      if (!pointer) return undefined;
      const validated = yield* readValidatedRelease(fs, path, pointer.releaseRoot, root);
      return validated?.version === pointer.version ? validated : undefined;
    });
  const active = yield* readValidatedPointer(path.join(root, ACTIVE_RELEASE_FILE));
  if (active) return active;

  // Activation briefly moves the old pointer aside before atomically promoting
  // the replacement. A broker starting in that bounded gap may keep serving the
  // validated previous release, but only while an exact, valid promotion
  // journal proves that the backup belongs to this installation. This is a
  // read-only fallback: installation-lock recovery remains the sole mutator.
  const journalPath = path.join(root, ACTIVE_RELEASE_JOURNAL_FILE);
  const promotion = yield* readActiveReleasePromotion(fs, path, root, journalPath).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  return promotion ? yield* readValidatedPointer(promotion.backupPath) : undefined;
});

export const activeInstalledVersion = Effect.fn('installations.activeVersion')(function* () {
  return (yield* activeInstalledRelease())?.version;
});

export const executingInstalledRelease = Effect.fn('installations.executingRelease')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  return yield* readValidatedRelease(fs, path, path.dirname(system.executablePath), installationRoot(path, system));
});

export const pruneStandaloneReleases = Effect.fn('installations.pruneReleases')(function* (
  activeReleaseRoot: string,
  dryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = installationRoot(path, system);
  const expectedActive = yield* readValidatedRelease(fs, path, activeReleaseRoot, root);
  if (!expectedActive) return {complete: false, failedRemovals: 0} as const;
  const activePath = path.join(root, ACTIVE_RELEASE_FILE);
  const activePointerExists = yield* fs.exists(activePath);
  const activePointer = yield* readActiveRelease(fs, activePath);
  if (activePointerExists && !activePointer) {
    yield* Console.warn('WARN skipping release pruning because the active release pointer is invalid.');
    return {complete: false, failedRemovals: 0} as const;
  }
  const currentActive = activePointer
    ? yield* readValidatedRelease(fs, path, activePointer.releaseRoot, root)
    : undefined;
  if (activePointer && currentActive?.version !== activePointer.version) {
    yield* Console.warn('WARN skipping release pruning because the active release pointer is not valid.');
    return {complete: false, failedRemovals: 0} as const;
  }
  if (currentActive && currentActive.releaseRoot !== expectedActive.releaseRoot) {
    yield* Console.warn(
      `WARN skipping stale release pruning for ${expectedActive.version}; ${currentActive.version} is now active.`,
    );
    return {complete: false, failedRemovals: 0} as const;
  }
  const active = currentActive ?? expectedActive;
  const versionsRoot = path.join(root, 'versions');
  if (!(yield* fs.exists(versionsRoot))) return {complete: false, failedRemovals: 0} as const;
  const releases = (yield* Effect.forEach(yield* fs.readDirectory(versionsRoot), name =>
    readValidatedRelease(fs, path, path.join(versionsRoot, name), root),
  )).filter((release): release is ActiveRelease => release !== undefined);
  const keep = new Set<string>([active.version]);
  const running = yield* readValidatedRelease(fs, path, path.dirname(system.executablePath), root);
  if (running) keep.add(running.version);
  const liveVersions = yield* liveReleaseLeaseVersions(fs, path, root, system).pipe(
    Effect.catch(cause =>
      Effect.gen(function* () {
        yield* Console.warn(
          `WARN skipping release pruning because process inspection was incomplete: ${String(cause)}`,
        );
        return undefined;
      }),
    ),
  );
  if (!liveVersions) return {complete: false, failedRemovals: 0} as const;
  for (const version of liveVersions) keep.add(version);
  for (const release of releases.sort((left, right) => compareVersions(right.version, left.version))) {
    if (keep.size >= RETAINED_RELEASE_COUNT) break;
    keep.add(release.version);
  }
  let failedRemovals = 0;
  for (const release of releases) {
    if (keep.has(release.version)) continue;
    if (dryRun) {
      yield* Console.log(`Would remove superseded standalone release: ${release.releaseRoot}`);
    } else {
      yield* fs.remove(release.releaseRoot, {recursive: true}).pipe(
        Effect.tap(() => Console.log(`Removed superseded standalone release: ${release.releaseRoot}`)),
        Effect.catch(cause =>
          Effect.sync(() => {
            failedRemovals += 1;
          }).pipe(
            Effect.andThen(
              Console.warn(
                `WARN could not remove superseded standalone release ${release.releaseRoot}: ${String(cause)}`,
              ),
            ),
          ),
        ),
      );
    }
  }
  return {complete: failedRemovals === 0, failedRemovals} as const;
});

export function withStandaloneInstallationLock<A, E, R>(effect: Effect.Effect<A, E, R>, dryRun = false) {
  if (dryRun) return effect;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const root = installationRoot(path, system);
    const lockPath = path.join(root, '.installation.lock');
    return yield* withExclusiveFileLock(
      fs,
      lockPath,
      INSTALLATION_LOCK_OPTIONS,
      recoverStandaloneInstallationState(fs, path, root).pipe(Effect.andThen(effect)),
    );
  });
}

function readActiveRelease(fs: FileSystem.FileSystem, file: string) {
  return fs.readFileString(file).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => {
          const value = JSON.parse(content) as unknown;
          if (
            typeof value !== 'object' ||
            value === null ||
            !('releaseRoot' in value) ||
            !('version' in value) ||
            typeof value.releaseRoot !== 'string' ||
            typeof value.version !== 'string'
          ) {
            return undefined;
          }
          return {releaseRoot: value.releaseRoot, version: value.version} satisfies ActiveRelease;
        },
        catch: () => undefined,
      }),
    ),
    Effect.orElseSucceed(() => undefined),
  );
}

const recoverStandaloneInstallationState = Effect.fn('installations.recoverState')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  yield* recoverActiveReleasePromotion(fs, path, root);
  for (const name of yield* fs.readDirectory(root)) {
    if (/^\.active-release\.[0-9]+-[0-9a-f-]+\.next\.json$/i.test(name)) {
      yield* fs.remove(path.join(root, name), {force: true});
    }
  }
  const versionsRoot = path.join(root, 'versions');
  if (!(yield* fs.exists(versionsRoot))) return;
  const names = (yield* fs.readDirectory(versionsRoot)).sort();
  for (const name of names) {
    const match = /^\.([0-9A-Za-z.-]+)\.(?:promotion(?:\.json|-backup)|bootstrap\.staging)$/.exec(name);
    const version = match?.[1];
    if (!version || !RELEASE_VERSION_PATTERN.test(version)) continue;
    yield* recoverStandaloneReleasePromotion(fs, path, path.join(versionsRoot, version));
  }
  for (const name of names) {
    if (/^\.threadnote-update-[0-9A-Za-z._-]+$/.test(name)) {
      yield* fs.remove(path.join(versionsRoot, name), {force: true, recursive: true});
    }
  }
});

const recoverActiveReleasePromotion = Effect.fn('installations.recoverActiveReleasePromotion')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  const journalPath = path.join(root, ACTIVE_RELEASE_JOURNAL_FILE);
  const journalExists = yield* fs.exists(journalPath);
  const promotion = journalExists ? yield* readActiveReleasePromotion(fs, path, root, journalPath) : undefined;
  const activePath = path.join(root, ACTIVE_RELEASE_FILE);
  const backupPath = path.join(root, ACTIVE_RELEASE_BACKUP_FILE);
  const activeExists = yield* fs.exists(activePath);
  const backupExists = yield* fs.exists(backupPath);
  if (!activeExists && backupExists) {
    yield* fs.rename(backupPath, activePath);
  } else if (activeExists && backupExists) {
    yield* fs.remove(backupPath, {force: true});
  }
  if (promotion) yield* fs.remove(promotion.temporaryPath, {force: true});
  if (journalExists) yield* fs.remove(journalPath, {force: true});
  if (!journalExists && !backupExists) return false;
  yield* syncDirectoryBestEffort(fs, root);
  return true;
});

const readActiveReleasePromotion = Effect.fn('installations.readActiveReleasePromotion')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  journalPath: string,
) {
  const value = yield* parsePromotionJournal(fs, journalPath);
  const activePath = path.join(root, ACTIVE_RELEASE_FILE);
  const backupPath = path.join(root, ACTIVE_RELEASE_BACKUP_FILE);
  if (
    value.version !== PROMOTION_JOURNAL_VERSION ||
    value.activePath !== activePath ||
    value.backupPath !== backupPath ||
    typeof value.temporaryPath !== 'string' ||
    path.dirname(value.temporaryPath) !== root ||
    !/^\.active-release\.[0-9]+-[0-9a-f-]+\.next\.json$/i.test(path.basename(value.temporaryPath))
  ) {
    return yield* InstallationOperationError.make({
      message: `Active release promotion journal is invalid: ${journalPath}`,
    });
  }
  return {
    activePath,
    backupPath,
    temporaryPath: value.temporaryPath,
    version: PROMOTION_JOURNAL_VERSION,
  } satisfies ActiveReleasePromotion;
});

const readReleaseDirectoryPromotion = Effect.fn('installations.readReleaseDirectoryPromotion')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  journalPath: string,
  releaseRoot: string,
) {
  const value = yield* parsePromotionJournal(fs, journalPath);
  const versionsRoot = path.dirname(releaseRoot);
  const backupRoot = releasePromotionBackupPath(path, releaseRoot);
  const journalReleaseRoot = typeof value.releaseRoot === 'string' ? path.resolve(value.releaseRoot) : undefined;
  const journalBackupRoot = typeof value.backupRoot === 'string' ? path.resolve(value.backupRoot) : undefined;
  const journalStagedRoot = typeof value.stagedRoot === 'string' ? path.resolve(value.stagedRoot) : undefined;
  const journalVersionsRoot = journalReleaseRoot ? path.dirname(journalReleaseRoot) : undefined;
  const rootsReferToSameDirectory =
    journalVersionsRoot === undefined
      ? false
      : yield* Effect.all([fs.realPath(versionsRoot), fs.realPath(journalVersionsRoot)]).pipe(
          Effect.map(([expected, observed]) => expected === observed),
          Effect.orElseSucceed(() => false),
        );
  const rebasedStagedRoot =
    journalVersionsRoot && journalStagedRoot
      ? path.resolve(versionsRoot, path.relative(journalVersionsRoot, journalStagedRoot))
      : undefined;
  if (
    value.version !== PROMOTION_JOURNAL_VERSION ||
    !rootsReferToSameDirectory ||
    journalReleaseRoot !== path.join(journalVersionsRoot!, path.basename(releaseRoot)) ||
    journalBackupRoot !== path.join(journalVersionsRoot!, path.basename(backupRoot)) ||
    rebasedStagedRoot === undefined ||
    !isStandaloneStagingPath(path, versionsRoot, path.basename(releaseRoot), rebasedStagedRoot)
  ) {
    return yield* InstallationOperationError.make({
      message: `Standalone release promotion journal is invalid: ${journalPath}`,
    });
  }
  return {
    backupRoot,
    releaseRoot,
    stagedRoot: rebasedStagedRoot,
    version: PROMOTION_JOURNAL_VERSION,
  } satisfies ReleaseDirectoryPromotion;
});

const parsePromotionJournal = Effect.fn('installations.parsePromotionJournal')(function* (
  fs: FileSystem.FileSystem,
  journalPath: string,
) {
  const content = yield* fs.readFileString(journalPath);
  return yield* Effect.try({
    try: () => {
      const value = JSON.parse(content) as unknown;
      if (!Predicate.isObject(value)) {
        throw InstallationOperationError.make({message: 'expected a JSON object'});
      }
      return value;
    },
    catch: cause =>
      InstallationOperationError.make({cause, message: `Could not parse promotion journal ${journalPath}.`}),
  });
});

function releasePromotionBackupPath(path: Path.Path, releaseRoot: string): string {
  return path.join(path.dirname(releaseRoot), `.${path.basename(releaseRoot)}.promotion-backup`);
}

function releasePromotionJournalPath(path: Path.Path, releaseRoot: string): string {
  return path.join(path.dirname(releaseRoot), `.${path.basename(releaseRoot)}.promotion.json`);
}

function isContainedPath(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isStandaloneStagingPath(
  path: Path.Path,
  versionsRoot: string,
  releaseName: string,
  candidate: string,
): boolean {
  if (!isContainedPath(path, versionsRoot, candidate)) return false;
  const segments = path.relative(versionsRoot, candidate).split(path.sep);
  if (
    segments.length === 2 &&
    segments[1] === 'release' &&
    /^\.threadnote-update-[0-9A-Za-z._-]+$/.test(segments[0] ?? '')
  ) {
    return true;
  }
  return (
    segments.length === 1 &&
    new RegExp(`^\\.${escapeRegExp(releaseName)}\\.[0-9A-Za-z._-]+\\.staging$`).test(segments[0] ?? '')
  );
}

function standaloneStagingCleanupRoot(path: Path.Path, versionsRoot: string, stagedRoot: string): string {
  const segments = path.relative(versionsRoot, stagedRoot).split(path.sep);
  return segments.length === 2 && segments[1] === 'release' ? path.dirname(stagedRoot) : stagedRoot;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const writePrivateJsonAtomically = Effect.fn('installations.writePrivateJsonAtomically')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
  value: unknown,
) {
  const crypto = yield* Crypto.Crypto;
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${yield* crypto.randomUUIDv4}.tmp`);
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, `${JSON.stringify(value, undefined, 2)}\n`, {flag: 'wx', mode: 0o600});
    yield* syncWritableFile(fs, temporary);
    yield* fs.rename(temporary, target);
    yield* syncDirectoryBestEffort(fs, directory);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});
