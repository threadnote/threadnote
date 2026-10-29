import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Console, Crypto, DateTime, Effect, FileSystem, Option, Path, Predicate, Schema} from 'effect';
import {sha256FileHex, sha256Hex} from '@threadnote/platform/digest';
import {
  LEGACY_OPENVIKING_HOME_DIRECTORY,
  LEGACY_THREADNOTE_DATA_DIRECTORY,
  LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION,
  THREADNOTE_HOME_DIRECTORY,
  THREADNOTE_STORAGE_LAYOUT_VERSION,
} from '@threadnote/store/layout';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {withSharedRepositoryHomeLock} from '../effect/share/lock.js';
import {hasBoundedMigrationTreeContent, isIgnorableOperatingSystemMetadata} from './evidence.js';
import {
  isThreadnoteStorageLayoutMigrationPending,
  migrateThreadnoteStorageLayout,
  STORAGE_LAYOUT_MIGRATION_ID,
} from './layout.js';
import {isLegacyLocalModelMigrationPending, migrateLegacyLocalModels} from './models.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const HOME_MIGRATION_ID = 'openviking-home-v1';
export const HOME_MIGRATION_RECEIPT_VERSION = 1 as const;
const RECEIPT_RELATIVE_PATH = `migration/${HOME_MIGRATION_ID}.json`;
const LAYOUT_RELATIVE_PATH = 'layout.json';

const EXCLUDED_LEGACY_PATHS = new Set([
  '.venv',
  'cache',
  'local-ai-server.json',
  'local-ai-server.lock',
  'locks',
  'logs',
  'openviking-server.json',
  'openviking-server.lock',
  'openviking-server.pid',
  'ov.conf',
  'ovcli.conf',
  'update-check.json',
  'venv',
]);

const EXCLUDED_LEGACY_THREADNOTE_PATHS = new Set([
  'data/.openviking.pid',
  'data/viking/backend_meta.json',
  'threadnote/local-ai-token',
  'threadnote/local-ai.json',
  'threadnote/shared-repository.lock',
]);

const TRANSIENT_SHARE_GIT_ROOT_FILENAMES = new Set(['COMMIT_EDITMSG', 'FETCH_HEAD', 'gc.log']);
const TRANSIENT_SHARE_GIT_LOCK_ROOTS = new Set(['info', 'logs', 'objects', 'refs', 'reftable', 'worktrees']);

export interface HomeMigrationOptions {
  readonly apply?: boolean;
  readonly legacyHome?: string;
  readonly targetHome?: string;
}

export interface HomeMigrationReceipt {
  readonly bytes: number;
  readonly completedAt: string;
  readonly directories: number;
  readonly files: number;
  readonly id: typeof HOME_MIGRATION_ID;
  readonly legacyHome: string;
  readonly preservedCurrentEntries?: number;
  readonly sourceTreeSha256: string;
  readonly stagedTreeSha256?: string;
  readonly symlinks: number;
  readonly targetHome: string;
  readonly version: typeof HOME_MIGRATION_RECEIPT_VERSION;
}

export interface HomeMigrationResult {
  readonly action:
    'already_migrated' | 'dry_run' | 'migrated' | 'no_legacy_content' | 'no_legacy_home' | 'recovered' | 'resumed';
  readonly receipt?: HomeMigrationReceipt;
}

interface InventoryEntry {
  readonly digest: string;
  readonly mode: number;
  readonly relativePath: string;
  readonly size: number;
  readonly type: 'directory' | 'file' | 'symlink';
}

interface HomeInventory {
  readonly bytes: number;
  readonly directories: number;
  readonly entries: readonly InventoryEntry[];
  readonly files: number;
  readonly symlinks: number;
  readonly treeSha256: string;
}

interface ManagedShareRecoveryRoot {
  readonly currentGitdir: string;
  readonly currentWorktree: string;
  readonly migration?: LegacyShareMigration;
  readonly sourceGitdirRelative: string;
  readonly teamName: string;
}

interface CurrentShareRecoveryState {
  readonly authoritativeShareGitdirs: ReadonlyMap<string, string>;
  readonly preservedLegacyEntries: ReadonlySet<string>;
}

interface LegacyDerivedShareState {
  readonly preservedLegacyEntries: ReadonlySet<string>;
}

interface LegacyShareMigration {
  readonly finalGitdir: string;
  readonly finalWorktree: string;
  readonly name: string;
  readonly sourceGitdir: string;
  readonly sourceGitdirRelative: string;
  readonly sourceWorktree: string;
  readonly sourceWorktreeRelative: string;
  readonly stageGitdirRelative: string;
  readonly stageWorktreeRelative: string;
}

interface LegacyTeamsFile extends Record<string, unknown> {
  readonly teams?: Record<string, Record<string, unknown>>;
}

interface RecoveryPreflight {
  readonly authoritativeCurrentShareGitdirs: ReadonlySet<string>;
  readonly preservedCurrentEntries: number;
  readonly skippedLegacyEntries: ReadonlySet<string>;
}

export class HomeMigrationConflict extends Schema.TaggedError<HomeMigrationConflict, {readonly brand: unique symbol}>()(
  'HomeMigrationConflict',
  {
    message: Schema.String,
    path: Schema.String,
  },
) {}

export class HomeMigrationFailed extends Schema.TaggedError<HomeMigrationFailed, {readonly brand: unique symbol}>()(
  'HomeMigrationFailed',
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
  },
) {}

export class HomeMigrationInsufficientSpace extends Schema.TaggedError<
  HomeMigrationInsufficientSpace,
  {readonly brand: unique symbol}
>()('HomeMigrationInsufficientSpace', {
  availableBytes: Schema.Finite,
  message: Schema.String,
  requiredBytes: Schema.Finite,
}) {}

export class HomeMigrationUnsafe extends Schema.TaggedError<HomeMigrationUnsafe, {readonly brand: unique symbol}>()(
  'HomeMigrationUnsafe',
  {
    message: Schema.String,
    path: Schema.String,
  },
) {}

export type HomeMigrationError =
  HomeMigrationConflict | HomeMigrationFailed | HomeMigrationInsufficientSpace | HomeMigrationUnsafe;

const migrateOpenVikingHomeImpl = Effect.fn('homeMigration.migrate')(function* (options: HomeMigrationOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const legacyHome = resolveHomeInput(
    path,
    system.homeDirectory,
    options.legacyHome ?? path.join(system.homeDirectory, LEGACY_OPENVIKING_HOME_DIRECTORY),
  );
  const targetHome = resolveHomeInput(
    path,
    system.homeDirectory,
    options.targetHome ?? path.join(system.homeDirectory, THREADNOTE_HOME_DIRECTORY),
  );
  assertSeparateHomes(path, legacyHome, targetHome);

  if (yield* fs.exists(targetHome)) {
    const receipt = yield* readReceipt(fs, path.join(targetHome, RECEIPT_RELATIVE_PATH));
    if (receipt?.legacyHome === legacyHome && receipt.targetHome === targetHome) {
      return {action: 'already_migrated', receipt};
    }
    if (!(yield* fs.exists(legacyHome))) {
      return {action: 'no_legacy_home'};
    }
    if (!(yield* isRecoverableThreadnoteTarget(fs, path, targetHome))) {
      return yield* HomeMigrationConflict.make({
        message: `Target home already exists without a matching ${HOME_MIGRATION_ID} receipt or a recognizable Threadnote layout.`,
        path: targetHome,
      });
    }
    if (!(yield* hasMaterialLegacyHomeContent(fs, path, system, legacyHome))) {
      return {action: 'no_legacy_content'};
    }
    const recovery = recoverIntoExistingTarget(fs, path, system, legacyHome, targetHome, options.apply === true);
    return options.apply === true ? yield* withSharedRepositoryHomeLock(targetHome, recovery) : yield* recovery;
  }
  if (!(yield* fs.exists(legacyHome))) {
    return {action: 'no_legacy_home'};
  }
  yield* fs.access(legacyHome, {readable: true});
  if (!(yield* hasMaterialLegacyHomeContent(fs, path, system, legacyHome))) {
    return {action: 'no_legacy_content'};
  }
  const targetParent = path.dirname(targetHome);
  yield* fs.makeDirectory(targetParent, {recursive: true, mode: 0o700});
  yield* fs.access(targetParent, {writable: true});

  const resumable = yield* findResumableStage(fs, path, targetParent, targetHome, legacyHome);
  if (resumable) {
    if (options.apply !== true) {
      return {action: 'dry_run', receipt: resumable.receipt};
    }
    yield* fs.rename(resumable.path, targetHome);
    return {action: 'resumed', receipt: resumable.receipt};
  }

  const inventory = yield* inventoryHome(fs, path, legacyHome, shouldIncludeLegacyPath);
  const shareMigrations = yield* planLegacyShareMigrations(fs, path, legacyHome, targetHome);
  const duplicatedShareBytes = duplicatedMigrationBytes(inventory, shareMigrations);
  const availableBytes = yield* system.availableDiskBytes(targetParent);
  if (availableBytes !== undefined) {
    yield* assertSufficientHomeMigrationDiskSpace(inventory.bytes + duplicatedShareBytes, availableBytes);
  }
  const now = DateTime.formatIso(yield* DateTime.now);
  const receipt: HomeMigrationReceipt = {
    bytes: inventory.bytes,
    completedAt: now,
    directories: inventory.directories,
    files: inventory.files,
    id: HOME_MIGRATION_ID,
    legacyHome,
    sourceTreeSha256: inventory.treeSha256,
    symlinks: inventory.symlinks,
    targetHome,
    version: HOME_MIGRATION_RECEIPT_VERSION,
  };
  if (options.apply !== true) {
    return {action: 'dry_run', receipt};
  }

  const stage = yield* fs.makeTempDirectory({
    directory: targetParent,
    prefix: `${path.basename(targetHome)}.migrate-`,
  });
  yield* fs.chmod(stage, 0o700);
  yield* copyInventory(fs, path, legacyHome, stage, inventory);
  yield* verifyCopiedInventory(fs, path, stage, inventory);

  const sourceAfterCopy = yield* inventoryHome(fs, path, legacyHome, shouldIncludeLegacyPath);
  if (sourceAfterCopy.treeSha256 !== inventory.treeSha256) {
    return yield* HomeMigrationConflict.make({
      message: 'The legacy home changed during migration. The staged copy was retained; rerun after writes stop.',
      path: legacyHome,
    });
  }

  yield* migrateLegacyShares(fs, path, stage, shareMigrations);
  yield* migrateThreadnoteStorageLayout({apply: true, home: stage});
  yield* migrateLegacyLocalModels({apply: true, home: stage});
  const stagedInventory = yield* inventoryHome(fs, path, stage, relativePath => relativePath !== LAYOUT_RELATIVE_PATH);
  const completedReceipt: HomeMigrationReceipt = {
    ...receipt,
    stagedTreeSha256: stagedInventory.treeSha256,
  };
  const receiptPath = path.join(stage, RECEIPT_RELATIVE_PATH);
  yield* fs.makeDirectory(path.dirname(receiptPath), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(receiptPath, `${JSON.stringify(completedReceipt, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  yield* fs.rename(stage, targetHome);
  return {action: 'migrated', receipt: completedReceipt};
});

export const migrateOpenVikingHome = (
  options: HomeMigrationOptions = {},
): Effect.Effect<
  HomeMigrationResult,
  HomeMigrationError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo
> =>
  migrateOpenVikingHomeImpl(options).pipe(
    Effect.filterOrFail(isHomeMigrationResult, result =>
      HomeMigrationFailed.make({
        cause: result,
        message: 'OpenViking home migration returned an invalid result.',
        operation: 'migrate OpenViking home',
      }),
    ),
    Effect.mapError(cause =>
      isHomeMigrationError(cause)
        ? cause
        : HomeMigrationFailed.make({
            cause,
            message: cause instanceof Error ? cause.message : String(cause),
            operation: 'migrate OpenViking home',
          }),
    ),
  );

export const isLegacyHomeMigrationPending = Effect.fn('homeMigration.isPending')(function* (
  options: Pick<HomeMigrationOptions, 'legacyHome' | 'targetHome'> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const legacyHome = resolveHomeInput(
    path,
    system.homeDirectory,
    options.legacyHome ?? path.join(system.homeDirectory, LEGACY_OPENVIKING_HOME_DIRECTORY),
  );
  if (!(yield* fs.exists(legacyHome))) {
    return false;
  }
  const targetHome = resolveHomeInput(
    path,
    system.homeDirectory,
    options.targetHome ?? path.join(system.homeDirectory, THREADNOTE_HOME_DIRECTORY),
  );
  const receipt = yield* readReceipt(fs, path.join(targetHome, RECEIPT_RELATIVE_PATH));
  if (receipt?.legacyHome === legacyHome && receipt.targetHome === targetHome) return false;
  return yield* hasMaterialLegacyHomeContent(fs, path, system, legacyHome);
});

/**
 * All migration work performed by `threadnote migrate --apply`: legacy-home
 * import/recovery plus the short-lived beta storage and local-model layouts.
 * This lets earlier 4.0 betas recover even when ~/.openviking is absent while
 * keeping fresh installs and runtime-only legacy homes silent.
 */
export const isThreadnoteHomeMigrationPending = Effect.fn('homeMigration.isThreadnoteHomePending')(function* (
  options: Pick<HomeMigrationOptions, 'legacyHome' | 'targetHome'> = {},
) {
  if (yield* isLegacyHomeMigrationPending(options)) return true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const targetHome = resolveHomeInput(
    path,
    system.homeDirectory,
    options.targetHome ?? path.join(system.homeDirectory, THREADNOTE_HOME_DIRECTORY),
  );
  if (!(yield* fs.exists(targetHome))) return false;
  if (yield* isThreadnoteStorageLayoutMigrationPending({home: targetHome})) return true;
  return yield* isLegacyLocalModelMigrationPending({home: targetHome});
});

function hasMaterialLegacyHomeContent(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  legacyHome: string,
) {
  return Effect.gen(function* () {
    const environment = system.environment();
    const accounts = portableIdentityCandidates(['local', environment.THREADNOTE_ACCOUNT]);
    const users = portableIdentityCandidates([system.userName, environment.THREADNOTE_USER]);
    const evidence = [
      path.join(legacyHome, 'seed-manifest.yaml'),
      path.join(legacyHome, 'seed-state.json'),
      path.join(legacyHome, 'share', 'teams.json'),
      path.join(legacyHome, 'share', 'teams'),
      path.join(legacyHome, 'share', 'worktrees'),
    ];
    for (const account of accounts) {
      evidence.push(
        path.join(legacyHome, 'data', LEGACY_THREADNOTE_DATA_DIRECTORY, account, 'memories'),
        path.join(legacyHome, 'data', LEGACY_THREADNOTE_DATA_DIRECTORY, account, 'resources'),
        path.join(legacyHome, 'data', LEGACY_THREADNOTE_DATA_DIRECTORY, account, 'user'),
      );
      for (const user of users) {
        evidence.push(
          path.join(legacyHome, 'data', LEGACY_THREADNOTE_DATA_DIRECTORY, account, 'user', user, 'memories'),
        );
      }
    }
    for (const candidate of evidence) {
      if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) return true;
      if (!(yield* fs.exists(candidate))) continue;
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isNone(info)) return true;
      if (info.value.type !== 'Directory') return true;
      if (
        yield* hasBoundedMigrationTreeContent(fs, path, candidate, entry =>
          shouldIncludeLegacyPath(path.relative(legacyHome, entry)),
        )
      ) {
        return true;
      }
    }
    return yield* isLegacyLocalModelMigrationPending({home: legacyHome});
  });
}

function portableIdentityCandidates(values: readonly (string | undefined)[]): readonly string[] {
  const candidates = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    try {
      validatePortableSegment(value, value);
      candidates.add(value);
    } catch {
      // Invalid environment identities cannot name canonical account roots.
    }
  }
  return [...candidates];
}

export const runHomeMigration = Effect.fn('homeMigration.run')(function* (options: HomeMigrationOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const targetHome = resolveHomeInput(
    path,
    system.homeDirectory,
    options.targetHome ?? path.join(system.homeDirectory, THREADNOTE_HOME_DIRECTORY),
  );
  const result = yield* migrateOpenVikingHome(options);
  let reportedBetaRecovery = false;
  if (yield* fs.exists(targetHome)) {
    const layoutResult = yield* migrateThreadnoteStorageLayout({
      apply: options.apply === true,
      home: targetHome,
    });
    const modelResult = yield* migrateLegacyLocalModels({
      apply: options.apply === true,
      home: targetHome,
    });
    if (layoutResult.action === 'dry_run') {
      reportedBetaRecovery = true;
      yield* Console.log(
        `Would migrate ${layoutResult.accounts} account(s) from the beta.1 canonical-store layout into ~/.threadnote/data.`,
      );
    } else if (layoutResult.action === 'would_repair_marker') {
      reportedBetaRecovery = true;
      yield* Console.log('Would restore the current Threadnote storage layout marker from its completed receipt.');
    } else if (layoutResult.action === 'migrated' || layoutResult.action === 'resumed') {
      reportedBetaRecovery = true;
      yield* Console.log(
        `${layoutResult.action === 'resumed' ? 'Resumed' : 'Migrated'} ${layoutResult.accounts} account(s) into the Threadnote storage layout.`,
      );
    } else if (layoutResult.action === 'repaired_marker') {
      reportedBetaRecovery = true;
      yield* Console.log('Restored the current Threadnote storage layout marker from its completed receipt.');
    }
    if (modelResult.action === 'dry_run') {
      reportedBetaRecovery = true;
      yield* Console.log(`Would preserve installed local model(s): ${EffectArray.join(modelResult.models, ', ')}.`);
    } else if (modelResult.action === 'migrated' || modelResult.action === 'resumed') {
      reportedBetaRecovery = true;
      yield* Console.log(`Preserved installed local model(s): ${EffectArray.join(modelResult.models, ', ')}.`);
    }
  }
  switch (result.action) {
    case 'already_migrated':
      if (!reportedBetaRecovery) {
        yield* Console.log(`Threadnote home is already migrated: ${result.receipt?.targetHome}`);
      }
      return;
    case 'dry_run':
      yield* Console.log(
        `Would migrate ${result.receipt?.files ?? 0} files (${result.receipt?.bytes ?? 0} bytes) from ${result.receipt?.legacyHome} to ${result.receipt?.targetHome}.`,
      );
      if ((result.receipt?.preservedCurrentEntries ?? 0) > 0) {
        yield* Console.log(
          `Would preserve ${result.receipt?.preservedCurrentEntries} current Threadnote entries or managed repositories instead of overlaying their legacy versions.`,
        );
      }
      yield* Console.log('Rerun with --apply to stage, validate, and atomically promote the new home.');
      return;
    case 'migrated':
      yield* Console.log(`Migrated and validated Threadnote home: ${result.receipt?.targetHome}`);
      yield* Console.log(`Legacy home was preserved unchanged: ${result.receipt?.legacyHome}`);
      return;
    case 'no_legacy_home':
      if (!reportedBetaRecovery) {
        yield* Console.log('No legacy ~/.openviking home was found; nothing to migrate.');
      }
      return;
    case 'no_legacy_content':
      if (!reportedBetaRecovery) {
        yield* Console.log('No canonical content was found in the legacy ~/.openviking home; nothing to migrate.');
      }
      return;
    case 'recovered':
      yield* Console.log(
        `Recovered legacy memories, resources, and share configuration into ${result.receipt?.targetHome}.`,
      );
      if ((result.receipt?.preservedCurrentEntries ?? 0) > 0) {
        yield* Console.log(
          `Preserved ${result.receipt?.preservedCurrentEntries} current Threadnote entries or managed repositories; their legacy versions remain in the unchanged legacy home.`,
        );
      }
      yield* Console.log(`Legacy home was preserved unchanged: ${result.receipt?.legacyHome}`);
      return;
    case 'resumed':
      yield* Console.log(`Promoted a previously validated migration: ${result.receipt?.targetHome}`);
  }
});

function isRecoverableThreadnoteTarget(fs: FileSystem.FileSystem, path: Path.Path, targetHome: string) {
  return Effect.gen(function* () {
    const layout = yield* readJsonObject(fs, path.join(targetHome, LAYOUT_RELATIVE_PATH));
    if (
      layout?.createdBy === 'threadnote' &&
      (layout.version === LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION ||
        layout.version === THREADNOTE_STORAGE_LAYOUT_VERSION)
    ) {
      return true;
    }
    if (yield* isOwnedDirectory(fs, path.join(targetHome, 'data', 'viking'))) {
      return true;
    }
    const storageMigration = yield* readJsonObject(
      fs,
      path.join(targetHome, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`),
    );
    if (
      storageMigration?.id === STORAGE_LAYOUT_MIGRATION_ID &&
      storageMigration.targetLayoutVersion === THREADNOTE_STORAGE_LAYOUT_VERSION &&
      storageMigration.version === 1
    ) {
      return true;
    }
    return false;
  });
}

function readJsonObject(
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<Record<string, unknown> | undefined, never> {
  return fs.readFileString(file).pipe(
    Effect.map(content => {
      try {
        const value = JSON.parse(content) as unknown;
        return Predicate.isObject(value) ? value : undefined;
      } catch {
        return undefined;
      }
    }),
    Effect.orElseSucceed(() => undefined),
  );
}

function isOwnedDirectory(fs: FileSystem.FileSystem, directory: string): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    if (!(yield* pathEntryExists(fs, directory))) return false;
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) return false;
    return (yield* fs.stat(directory)).type === 'Directory';
  }).pipe(Effect.orElseSucceed(() => false));
}

function isOwnedFile(fs: FileSystem.FileSystem, file: string): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    if (!(yield* pathEntryExists(fs, file))) return false;
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return false;
    return (yield* fs.stat(file)).type === 'File';
  }).pipe(Effect.orElseSucceed(() => false));
}

function pathEntryExists(fs: FileSystem.FileSystem, target: string): Effect.Effect<boolean, never> {
  return Effect.all([fs.stat(target).pipe(Effect.option), fs.readLink(target).pipe(Effect.option)]).pipe(
    Effect.map(([info, link]) => Option.isSome(info) || Option.isSome(link)),
  );
}

function recoverIntoExistingTarget(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  legacyHome: string,
  targetHome: string,
  apply: boolean,
) {
  return Effect.gen(function* () {
    yield* fs.access(legacyHome, {readable: true});
    yield* fs.access(targetHome, {writable: true});
    const inventory = yield* inventoryHome(fs, path, legacyHome, shouldIncludeLegacyPath);
    const shareMigrations = yield* planLegacyShareMigrations(fs, path, legacyHome, targetHome);
    const availableBytes = yield* system.availableDiskBytes(targetHome);
    if (availableBytes !== undefined) {
      yield* assertSufficientHomeMigrationDiskSpace(
        inventory.bytes + duplicatedMigrationBytes(inventory, shareMigrations),
        availableBytes,
      );
    }
    const preflight = yield* preflightMappedInventory(fs, path, targetHome, inventory, shareMigrations);
    const receipt: HomeMigrationReceipt = {
      bytes: inventory.bytes,
      completedAt: DateTime.formatIso(yield* DateTime.now),
      directories: inventory.directories,
      files: inventory.files,
      id: HOME_MIGRATION_ID,
      legacyHome,
      ...(preflight.preservedCurrentEntries > 0 ? {preservedCurrentEntries: preflight.preservedCurrentEntries} : {}),
      sourceTreeSha256: inventory.treeSha256,
      symlinks: inventory.symlinks,
      targetHome,
      version: HOME_MIGRATION_RECEIPT_VERSION,
    };
    if (!apply) {
      return {action: 'dry_run', receipt} satisfies HomeMigrationResult;
    }

    yield* copyMappedInventory(fs, path, legacyHome, targetHome, inventory, preflight.skippedLegacyEntries);
    yield* verifyMappedInventory(fs, path, targetHome, inventory, preflight.skippedLegacyEntries);
    yield* migrateLegacySharesIntoExisting(
      fs,
      path,
      targetHome,
      shareMigrations,
      preflight.authoritativeCurrentShareGitdirs,
    );
    const sourceAfterCopy = yield* inventoryHome(fs, path, legacyHome, shouldIncludeLegacyPath);
    if (sourceAfterCopy.treeSha256 !== inventory.treeSha256) {
      return yield* HomeMigrationConflict.make({
        message: 'The legacy home changed during recovery. Copied files were retained; rerun after writes stop.',
        path: legacyHome,
      });
    }
    yield* migrateThreadnoteStorageLayout({apply: true, home: targetHome});
    yield* migrateLegacyLocalModels({apply: true, home: targetHome});
    const targetInventory = yield* inventoryHome(
      fs,
      path,
      targetHome,
      relativePath => relativePath !== RECEIPT_RELATIVE_PATH && relativePath !== 'threadnote/shared-repository.lock',
    );
    const completedReceipt: HomeMigrationReceipt = {...receipt, stagedTreeSha256: targetInventory.treeSha256};
    const receiptPath = path.join(targetHome, RECEIPT_RELATIVE_PATH);
    yield* fs.makeDirectory(path.dirname(receiptPath), {recursive: true, mode: 0o700});
    yield* fs.writeFileString(receiptPath, `${JSON.stringify(completedReceipt, null, 2)}\n`, {mode: 0o600});
    return {action: 'recovered', receipt: completedReceipt} satisfies HomeMigrationResult;
  });
}

function preflightMappedInventory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  targetHome: string,
  inventory: HomeInventory,
  shareMigrations: readonly LegacyShareMigration[],
) {
  return Effect.gen(function* () {
    const currentShareState = yield* findCurrentShareRecoveryState(fs, path, targetHome, inventory, shareMigrations);
    const skippedLegacyEntries = new Set<string>(
      EffectArray.map(
        EffectArrayPipe(inventory.entries, __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (entry, __effectArrayIndex) =>
              __effectArrayIndex in __effectArrayValues &&
              EffectArray.some([...currentShareState.authoritativeShareGitdirs.keys()], root =>
                isRelativePathWithin(root, entry.relativePath),
              ),
          ),
        ),
        entry => entry.relativePath,
      ),
    );
    for (const entry of currentShareState.preservedLegacyEntries) {
      skippedLegacyEntries.add(entry);
    }
    let preservedCurrentEntries =
      currentShareState.authoritativeShareGitdirs.size + currentShareState.preservedLegacyEntries.size;
    for (const entry of inventory.entries) {
      if (skippedLegacyEntries.has(entry.relativePath)) continue;
      if (entry.type !== 'directory' && (yield* hasCurrentBetaEntry(fs, path, targetHome, entry.relativePath))) {
        skippedLegacyEntries.add(entry.relativePath);
        preservedCurrentEntries += 1;
        continue;
      }
      const mappedRelativePath = mappedLegacyRelative(entry.relativePath);
      const target = path.join(targetHome, mappedRelativePath);
      if (!(yield* fs.exists(target))) continue;
      if (entry.type === 'directory') {
        const info = yield* fs.stat(target);
        if (info.type === 'Directory' && Option.isNone(yield* fs.readLink(target).pipe(Effect.option))) continue;
      } else if (entry.type === 'file') {
        const info = yield* fs.stat(target);
        if (
          info.type === 'File' &&
          Number(info.size) === entry.size &&
          (yield* sha256FileHex(target)) === entry.digest
        ) {
          continue;
        }
        if (
          info.type === 'File' &&
          Option.isNone(yield* fs.readLink(target).pipe(Effect.option)) &&
          shouldPreserveCurrentRecoveryFile(mappedRelativePath)
        ) {
          skippedLegacyEntries.add(entry.relativePath);
          preservedCurrentEntries += 1;
          continue;
        }
      } else {
        const link = yield* fs.readLink(target).pipe(Effect.option);
        if (Option.isSome(link) && (yield* sha256Hex(link.value)) === entry.digest) continue;
      }
      return yield* HomeMigrationConflict.make({
        message: `Recovery would overwrite different existing content: ${mappedLegacyRelative(entry.relativePath)}.`,
        path: target,
      });
    }
    return {
      authoritativeCurrentShareGitdirs: new Set(currentShareState.authoritativeShareGitdirs.values()),
      preservedCurrentEntries,
      skippedLegacyEntries,
    } satisfies RecoveryPreflight;
  });
}

function findCurrentShareRecoveryState(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  targetHome: string,
  inventory: HomeInventory,
  shareMigrations: readonly LegacyShareMigration[],
) {
  return Effect.gen(function* () {
    const roots = managedShareRecoveryRoots(path, targetHome, inventory, shareMigrations);
    const authoritative = new Map<string, string>();
    const preservedLegacyEntries = new Set<string>();
    for (const root of roots) {
      const gitdirExists = yield* pathEntryExists(fs, root.currentGitdir);
      const worktreeExists = yield* pathEntryExists(fs, root.currentWorktree);
      if (!gitdirExists && !worktreeExists) continue;
      const completeCheckout =
        gitdirExists &&
        worktreeExists &&
        (yield* isOwnedDirectory(fs, root.currentGitdir)) &&
        (yield* isOwnedDirectory(fs, root.currentWorktree)) &&
        (yield* isOwnedFile(fs, path.join(root.currentGitdir, 'HEAD')));
      const marker = path.join(root.currentWorktree, '.git');
      if (completeCheckout && (yield* readGitdirMarker(fs, path, marker)) === path.resolve(root.currentGitdir)) {
        authoritative.set(portableInput(root.sourceGitdirRelative), path.resolve(root.currentGitdir));
        continue;
      }

      const legacyDerived = yield* inspectLegacyDerivedShareState(fs, path, inventory, root, {
        gitdirExists,
        worktreeExists,
      });
      if (legacyDerived) {
        for (const entry of legacyDerived.preservedLegacyEntries) {
          preservedLegacyEntries.add(entry);
        }
        continue;
      }

      if (completeCheckout) {
        return yield* HomeMigrationConflict.make({
          message: `Current managed share worktree "${root.teamName}" does not point at its registered Git directory; recovery stopped without changing either copy.`,
          path: marker,
        });
      }
      return yield* HomeMigrationConflict.make({
        message: `Current managed share checkout is incomplete or unsafe: team "${root.teamName}" does not match the preserved legacy repository, so recovery will not combine them.`,
        path: gitdirExists ? root.currentGitdir : root.currentWorktree,
      });
    }
    return {
      authoritativeShareGitdirs: authoritative,
      preservedLegacyEntries,
    } satisfies CurrentShareRecoveryState;
  });
}

function inspectLegacyDerivedShareState(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  legacyInventory: HomeInventory,
  root: ManagedShareRecoveryRoot,
  state: {readonly gitdirExists: boolean; readonly worktreeExists: boolean},
): Effect.Effect<LegacyDerivedShareState | undefined, never, Crypto.Crypto> {
  return Effect.gen(function* () {
    const migration = root.migration;
    if (!migration) return undefined;
    const preservedLegacyEntries = new Set<string>();
    if (state.gitdirExists) {
      const gitdirComparison = yield* compareLegacyDerivedTree(fs, path, legacyInventory, root.currentGitdir, {
        kind: 'gitdir',
        legacyRoot: migration.sourceGitdir,
        legacyRootRelative: migration.sourceGitdirRelative,
        migration,
      });
      if (!gitdirComparison) return undefined;
      for (const entry of gitdirComparison) {
        preservedLegacyEntries.add(entry);
      }
    }
    if (state.worktreeExists) {
      const worktreeComparison = yield* compareLegacyDerivedTree(fs, path, legacyInventory, root.currentWorktree, {
        kind: 'worktree',
        legacyRoot: migration.sourceWorktree,
        legacyRootRelative: migration.sourceWorktreeRelative,
        migration,
      });
      if (!worktreeComparison) return undefined;
      for (const entry of worktreeComparison) {
        preservedLegacyEntries.add(entry);
      }
    }
    return {preservedLegacyEntries} satisfies LegacyDerivedShareState;
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function compareLegacyDerivedTree(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  legacyInventory: HomeInventory,
  currentRoot: string,
  options:
    | {
        readonly kind: 'gitdir';
        readonly legacyRoot: string;
        readonly legacyRootRelative: string;
        readonly migration: LegacyShareMigration;
      }
    | {
        readonly kind: 'worktree';
        readonly legacyRoot: string;
        readonly legacyRootRelative: string;
        readonly migration: LegacyShareMigration;
      },
): Effect.Effect<ReadonlySet<string> | undefined, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    if (!(yield* isOwnedDirectory(fs, currentRoot)) || !(yield* isOwnedDirectory(fs, options.legacyRoot))) {
      return undefined;
    }
    const currentInventory = yield* inventoryHome(fs, path, currentRoot, () => true);
    const legacyEntries = inventoryEntriesWithin(legacyInventory, options.legacyRootRelative);
    const preservedLegacyEntries = new Set<string>();
    const transientFiles =
      options.kind === 'gitdir'
        ? new Set(
            EffectArray.map(
              EffectArrayPipe(currentInventory.entries, __effectArrayValues =>
                EffectArray.filter(
                  __effectArrayValues,
                  (entry, __effectArrayIndex) =>
                    __effectArrayIndex in __effectArrayValues &&
                    entry.type !== 'directory' &&
                    isTransientShareGitPath(
                      portableInput(path.join(options.migration.stageGitdirRelative, entry.relativePath)),
                    ),
                ),
              ),
              entry => entry.relativePath,
            ),
          )
        : new Set<string>();
    const transientOnlyDirectories = findTransientOnlyDirectories(currentInventory.entries, transientFiles);

    for (const currentEntry of currentInventory.entries) {
      if (transientFiles.has(currentEntry.relativePath) || transientOnlyDirectories.has(currentEntry.relativePath)) {
        continue;
      }
      const legacyEntry = legacyEntries.get(currentEntry.relativePath);
      if (
        legacyEntry &&
        currentEntry.type === legacyEntry.type &&
        currentEntry.size === legacyEntry.size &&
        currentEntry.digest === legacyEntry.digest &&
        (currentEntry.type !== 'file' || (currentEntry.mode & 0o100) === (legacyEntry.mode & 0o100))
      ) {
        continue;
      }

      if (
        options.kind === 'worktree' &&
        currentEntry.relativePath === '.git' &&
        currentEntry.type === 'file' &&
        (yield* readGitdirMarker(fs, path, path.join(currentRoot, '.git'))) ===
          path.resolve(options.migration.finalGitdir)
      ) {
        preservedLegacyEntries.add(portableInput(path.join(options.legacyRootRelative, '.git')));
        continue;
      }

      if (
        options.kind === 'gitdir' &&
        currentEntry.relativePath === 'config' &&
        currentEntry.type === 'file' &&
        legacyEntry?.type === 'file'
      ) {
        const legacyConfig = yield* fs.readFileString(path.join(options.legacyRoot, 'config'));
        const migratedConfig = rewriteLegacyShareGitConfig(legacyConfig, options.migration);
        if ((yield* fs.readFileString(path.join(currentRoot, 'config'))) === migratedConfig) {
          preservedLegacyEntries.add(
            portableInput(path.join(options.migration.sourceGitdirRelative, currentEntry.relativePath)),
          );
          continue;
        }
      }

      return undefined;
    }
    return preservedLegacyEntries;
  });
}

function inventoryEntriesWithin(inventory: HomeInventory, root: string): ReadonlyMap<string, InventoryEntry> {
  const portableRoot = Effect2.pipe(portableInput(root), EffectString.replace(/\/+$/, ''));
  const prefix = `${portableRoot}/`;
  return new Map(
    EffectArray.map(
      EffectArrayPipe(inventory.entries, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (entry, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues &&
            Effect2.pipe(entry.relativePath, EffectString.startsWith(prefix)),
        ),
      ),
      entry => [
        Effect2.pipe(entry.relativePath, EffectString.slice(prefix.length)),
        {...entry, relativePath: Effect2.pipe(entry.relativePath, EffectString.slice(prefix.length))},
      ],
    ),
  );
}

function findTransientOnlyDirectories(
  entries: readonly InventoryEntry[],
  transientFiles: ReadonlySet<string>,
): ReadonlySet<string> {
  const candidates = new Set(EffectArray.flatMap([...transientFiles], relativePathAncestors));
  for (const entry of entries) {
    if (transientFiles.has(entry.relativePath)) continue;
    if (entry.type === 'directory' && candidates.has(entry.relativePath)) continue;
    for (const ancestor of relativePathAncestors(entry.relativePath)) {
      candidates.delete(ancestor);
    }
  }
  return candidates;
}

function relativePathAncestors(relativePath: string): readonly string[] {
  const segments = Effect2.pipe(portableInput(relativePath), EffectString.split('/'));
  const ancestors: string[] = [];
  for (let length = 1; length < segments.length; length += 1) {
    ancestors.push(EffectArray.join(segments.slice(0, length), '/'));
  }
  return ancestors;
}

function managedShareRecoveryRoots(
  path: Path.Path,
  targetHome: string,
  inventory: HomeInventory,
  shareMigrations: readonly LegacyShareMigration[],
): readonly ManagedShareRecoveryRoot[] {
  const roots = new Map<string, ManagedShareRecoveryRoot>();
  const plannedSourceGitdirRoots = new Set(
    EffectArray.map(shareMigrations, migration => portableInput(migration.sourceGitdirRelative)),
  );
  for (const migration of shareMigrations) {
    const sourceGitdirRelative = portableInput(migration.sourceGitdirRelative);
    roots.set(portableInput(path.resolve(migration.finalGitdir)), {
      currentGitdir: migration.finalGitdir,
      currentWorktree: migration.finalWorktree,
      migration,
      sourceGitdirRelative,
      teamName: migration.name,
    });
  }
  for (const entry of inventory.entries) {
    const standardRoot = managedShareGitdirRoot(entry.relativePath);
    if (!standardRoot || plannedSourceGitdirRoots.has(standardRoot)) continue;
    const gitdirName = Effect2.pipe(standardRoot, EffectString.split('/')).at(-1);
    const teamName = Effect2.pipe(gitdirName, effectOptionalString =>
      effectOptionalString == null
        ? undefined
        : Effect2.pipe(effectOptionalString, EffectString.slice(0, -'.gitdir'.length)),
    );
    if (!teamName) continue;
    const currentGitdir = path.join(targetHome, standardRoot);
    const currentRootKey = portableInput(path.resolve(currentGitdir));
    if (roots.has(currentRootKey)) continue;
    roots.set(currentRootKey, {
      currentGitdir,
      currentWorktree: path.join(targetHome, 'share', 'worktrees', teamName),
      sourceGitdirRelative: standardRoot,
      teamName,
    });
  }
  return [...roots.values()];
}

function managedShareGitdirRoot(relativePath: string): string | undefined {
  const segments = Effect2.pipe(portableInput(relativePath), EffectString.split('/'));
  const gitdirName = segments[2];
  if (
    segments.length < 3 ||
    segments[0] !== 'share' ||
    segments[1] !== 'teams' ||
    !Effect2.pipe(gitdirName, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.endsWith('.gitdir')),
    )
  ) {
    return undefined;
  }
  const teamName = Effect2.pipe(gitdirName, EffectString.slice(0, -'.gitdir'.length));
  return /^[a-z0-9][a-z0-9._-]*$/.test(teamName) && !/^\.+$/.test(teamName)
    ? EffectArray.join(segments.slice(0, 3), '/')
    : undefined;
}

function readGitdirMarker(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  marker: string,
): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(marker))) return undefined;
    if (Option.isSome(yield* fs.readLink(marker).pipe(Effect.option))) return undefined;
    if ((yield* fs.stat(marker)).type !== 'File') return undefined;
    const value = Effect2.pipe(yield* fs.readFileString(marker), EffectString.trim);
    const gitdir = Effect2.pipe(/^gitdir:\s*(.+)$/i.exec(value)?.[1], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
    return gitdir ? path.resolve(path.dirname(marker), gitdir) : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function isRelativePathWithin(root: string, candidate: string): boolean {
  const portableRoot = portableInput(root);
  const portableCandidate = portableInput(candidate);
  return (
    portableCandidate === portableRoot || Effect2.pipe(portableCandidate, EffectString.startsWith(`${portableRoot}/`))
  );
}

function copyMappedInventory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourceRoot: string,
  targetRoot: string,
  inventory: HomeInventory,
  preservedCurrentEntries: ReadonlySet<string>,
) {
  return Effect.gen(function* () {
    for (const entry of inventory.entries) {
      const source = path.join(sourceRoot, entry.relativePath);
      const target = path.join(targetRoot, mappedLegacyRelative(entry.relativePath));
      if (preservedCurrentEntries.has(entry.relativePath)) continue;
      if (yield* fs.exists(target)) continue;
      if (entry.type === 'directory') {
        yield* fs.makeDirectory(target, {recursive: true, mode: 0o700});
      } else if (entry.type === 'file') {
        yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
        const temporary = `${target}.${HOME_MIGRATION_ID}.tmp`;
        yield* fs.copyFile(source, temporary);
        yield* fs.chmod(temporary, 0o600 | (entry.mode & 0o100));
        yield* fs.rename(temporary, target);
      } else {
        yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
        yield* fs.symlink(yield* fs.readLink(source), target);
      }
    }
  });
}

function verifyMappedInventory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  targetRoot: string,
  inventory: HomeInventory,
  preservedCurrentEntries: ReadonlySet<string>,
) {
  return Effect.gen(function* () {
    for (const entry of inventory.entries) {
      if (entry.type === 'directory') continue;
      if (preservedCurrentEntries.has(entry.relativePath)) continue;
      const target = path.join(targetRoot, mappedLegacyRelative(entry.relativePath));
      if (entry.type === 'file') {
        const info = yield* fs.stat(target);
        if (
          info.type !== 'File' ||
          Number(info.size) !== entry.size ||
          (yield* sha256FileHex(target)) !== entry.digest
        ) {
          return yield* HomeMigrationConflict.make({
            message: `Recovered file failed validation: ${mappedLegacyRelative(entry.relativePath)}.`,
            path: target,
          });
        }
      } else {
        const link = yield* fs.readLink(target);
        if ((yield* sha256Hex(link)) !== entry.digest) {
          return yield* HomeMigrationConflict.make({
            message: `Recovered symbolic link failed validation: ${mappedLegacyRelative(entry.relativePath)}.`,
            path: target,
          });
        }
      }
    }
  });
}

function mappedLegacyRelative(relativePath: string): string {
  const portable = portableInput(relativePath);
  const legacyPrefix = 'data/viking';
  return portable === legacyPrefix
    ? 'data'
    : Effect2.pipe(portable, EffectString.startsWith(`${legacyPrefix}/`))
      ? `data/${Effect2.pipe(portable, EffectString.slice(legacyPrefix.length + 1))}`
      : portable;
}

function shouldPreserveCurrentRecoveryFile(relativePath: string): boolean {
  return Effect2.pipe(portableInput(relativePath), EffectString.startsWith('data/'));
}

function hasCurrentBetaEntry(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  targetRoot: string,
  legacyRelativePath: string,
) {
  const portable = portableInput(legacyRelativePath);
  if (mappedLegacyRelative(portable) === portable) return Effect.succeed(false);
  return fs.exists(path.join(targetRoot, portable));
}

function migrateLegacySharesIntoExisting(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  targetHome: string,
  migrations: readonly LegacyShareMigration[],
  authoritativeCurrentShareGitdirs: ReadonlySet<string>,
) {
  const stagingRoot = path.join(targetHome, 'migration', `.${HOME_MIGRATION_ID}-share-copy`);
  const cleanupStaging = fs.remove(stagingRoot, {force: true, recursive: true}).pipe(Effect.ignore);
  return Effect.gen(function* () {
    if (migrations.length === 0) return;
    yield* cleanupStaging;
    const teamsPath = path.join(targetHome, 'share', 'teams.json');
    const teamsFile = parseLegacyTeamsFile(JSON.parse(yield* fs.readFileString(teamsPath)));
    for (const migration of migrations) {
      const preservesCurrentRepository = authoritativeCurrentShareGitdirs.has(path.resolve(migration.finalGitdir));
      const canonicalWorktree = path.join(targetHome, mappedLegacyRelative(migration.sourceWorktreeRelative));
      const canonicalGitMarker = path.join(canonicalWorktree, '.git');
      if (yield* fs.exists(canonicalGitMarker)) {
        yield* fs.remove(canonicalGitMarker, {recursive: true});
      }

      if (!(yield* fs.exists(migration.finalWorktree))) {
        const temporaryWorktree = path.join(targetHome, 'share', 'worktrees', `.${migration.name}.migrate`);
        if (yield* fs.exists(temporaryWorktree)) {
          yield* fs.remove(temporaryWorktree, {recursive: true});
        }
        yield* fs.makeDirectory(path.dirname(temporaryWorktree), {recursive: true, mode: 0o700});
        yield* fs.copy(migration.sourceWorktree, temporaryWorktree, {preserveTimestamps: true});
        const temporaryGitMarker = path.join(temporaryWorktree, '.git');
        if (yield* fs.exists(temporaryGitMarker)) {
          yield* fs.remove(temporaryGitMarker, {recursive: true});
        }
        yield* fs.writeFileString(temporaryGitMarker, `gitdir: ${migration.finalGitdir}\n`, {mode: 0o600});
        yield* fs.rename(temporaryWorktree, migration.finalWorktree);
      } else if (!preservesCurrentRepository) {
        yield* copyMissingLegacyTree(
          fs,
          path,
          migration.sourceWorktree,
          migration.finalWorktree,
          path.join(stagingRoot, migration.name, 'worktree'),
          relativePath => portableInput(relativePath) !== '.git',
        );
        yield* fs.writeFileString(path.join(migration.finalWorktree, '.git'), `gitdir: ${migration.finalGitdir}\n`, {
          mode: 0o600,
        });
      }

      const targetSourceGitdir = path.join(targetHome, migration.sourceGitdirRelative);
      if (targetSourceGitdir !== migration.finalGitdir && !preservesCurrentRepository) {
        yield* fs.makeDirectory(migration.finalGitdir, {recursive: true, mode: 0o700});
        yield* copyMissingLegacyTree(
          fs,
          path,
          migration.sourceGitdir,
          migration.finalGitdir,
          path.join(stagingRoot, migration.name, 'gitdir'),
          () => true,
        );
      }
      const gitConfigPath = path.join(migration.finalGitdir, 'config');
      if (!preservesCurrentRepository && (yield* fs.exists(gitConfigPath))) {
        const gitConfig = yield* fs.readFileString(gitConfigPath);
        yield* fs.writeFileString(gitConfigPath, rewriteLegacyShareGitConfig(gitConfig, migration), {mode: 0o600});
      }
      if (!preservesCurrentRepository && (yield* fs.exists(migration.finalGitdir))) {
        yield* removeTransientLegacyDerivedGitEntries(fs, path, migration);
      }
      const entry = teamsFile.teams?.[migration.name];
      if (entry) {
        entry.gitdir = migration.finalGitdir;
        entry.worktree = migration.finalWorktree;
      }
    }
    yield* fs.writeFileString(teamsPath, `${JSON.stringify(teamsFile, null, 2)}\n`, {mode: 0o600});
  }).pipe(Effect.ensuring(cleanupStaging));
}

function removeTransientLegacyDerivedGitEntries(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migration: LegacyShareMigration,
): Effect.Effect<void, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const inventory = yield* inventoryHome(fs, path, migration.finalGitdir, () => true);
    const transientFiles = new Set(
      EffectArray.map(
        EffectArrayPipe(inventory.entries, __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (entry, __effectArrayIndex) =>
              __effectArrayIndex in __effectArrayValues &&
              entry.type !== 'directory' &&
              isTransientShareGitPath(portableInput(path.join(migration.stageGitdirRelative, entry.relativePath))),
          ),
        ),
        entry => entry.relativePath,
      ),
    );
    const transientOnlyDirectories = findTransientOnlyDirectories(inventory.entries, transientFiles);
    for (const relativePath of transientFiles) {
      yield* fs.remove(path.join(migration.finalGitdir, relativePath), {force: true});
    }
    for (const relativePath of [...transientOnlyDirectories].sort((left, right) => right.length - left.length)) {
      const directory = path.join(migration.finalGitdir, relativePath);
      if ((yield* fs.readDirectory(directory)).length === 0) {
        yield* fs.remove(directory, {recursive: true});
      }
    }
  });
}

function copyMissingLegacyTree(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourceRoot: string,
  targetRoot: string,
  stagingRoot: string,
  include: (relativePath: string) => boolean,
): Effect.Effect<void, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const inventory = yield* inventoryHome(fs, path, sourceRoot, include);
    for (const entry of inventory.entries) {
      const source = path.join(sourceRoot, entry.relativePath);
      const target = path.join(targetRoot, entry.relativePath);
      if (yield* pathEntryExists(fs, target)) continue;
      if (entry.type === 'directory') {
        yield* fs.makeDirectory(target, {recursive: true, mode: 0o700});
      } else if (entry.type === 'file') {
        const staged = path.join(stagingRoot, entry.relativePath);
        yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
        yield* fs.makeDirectory(path.dirname(staged), {recursive: true, mode: 0o700});
        yield* fs.copyFile(source, staged);
        yield* fs.chmod(staged, 0o600 | (entry.mode & 0o100));
        if (!(yield* inventoryEntryMatches(fs, staged, entry))) {
          return yield* HomeMigrationConflict.make({
            message: `Staged share file failed validation: ${entry.relativePath}.`,
            path: staged,
          });
        }
        yield* installStagedShareEntry(fs, staged, target, entry);
      } else {
        const staged = path.join(stagingRoot, entry.relativePath);
        yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
        yield* fs.makeDirectory(path.dirname(staged), {recursive: true, mode: 0o700});
        yield* fs.symlink(yield* fs.readLink(source), staged);
        if (!(yield* inventoryEntryMatches(fs, staged, entry))) {
          return yield* HomeMigrationConflict.make({
            message: `Staged share symbolic link failed validation: ${entry.relativePath}.`,
            path: staged,
          });
        }
        yield* installStagedShareEntry(fs, staged, target, entry);
      }
    }
  });
}

function installStagedShareEntry(
  fs: FileSystem.FileSystem,
  staged: string,
  target: string,
  expected: InventoryEntry,
): Effect.Effect<void, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    if (yield* pathEntryExists(fs, target)) {
      if (yield* inventoryEntryMatches(fs, target, expected)) {
        yield* fs.remove(staged, {force: true});
        return;
      }
      return yield* HomeMigrationConflict.make({
        message: `Share recovery target changed while copying: ${expected.relativePath}.`,
        path: target,
      });
    }
    yield* fs.rename(staged, target);
    if (!(yield* inventoryEntryMatches(fs, target, expected))) {
      return yield* HomeMigrationConflict.make({
        message: `Recovered share entry failed validation: ${expected.relativePath}.`,
        path: target,
      });
    }
  });
}

function inventoryEntryMatches(
  fs: FileSystem.FileSystem,
  target: string,
  expected: InventoryEntry,
): Effect.Effect<boolean, never, Crypto.Crypto> {
  return Effect.gen(function* () {
    if (!(yield* pathEntryExists(fs, target))) return false;
    if (expected.type === 'file') {
      if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) return false;
      const info = yield* fs.stat(target);
      return (
        info.type === 'File' &&
        Number(info.size) === expected.size &&
        (info.mode & 0o100) === (expected.mode & 0o100) &&
        (yield* sha256FileHex(target).pipe(Effect.provideService(FileSystem.FileSystem, fs))) === expected.digest
      );
    }
    if (expected.type === 'symlink') {
      const link = yield* fs.readLink(target).pipe(Effect.option);
      return Option.isSome(link) && (yield* sha256Hex(link.value)) === expected.digest;
    }
    return yield* isOwnedDirectory(fs, target);
  }).pipe(Effect.orElseSucceed(() => false));
}

function rewriteLegacyShareGitConfig(config: string, migration: LegacyShareMigration): string {
  return Effect2.pipe(config, __effectPipeInput => {
    const __effectPipeStage0 = Effect2.pipe(
      __effectPipeInput,
      EffectString.replaceAll(migration.sourceWorktree, migration.finalWorktree),
    );
    const __effectPipeStage1 = Effect2.pipe(
      __effectPipeStage0,
      EffectString.replaceAll(migration.sourceGitdir, migration.finalGitdir),
    );
    return __effectPipeStage1;
  });
}

function assertSeparateHomes(path: Path.Path, legacyHome: string, targetHome: string): void {
  if (
    legacyHome === targetHome ||
    isWithin(path, legacyHome, targetHome) ||
    isWithin(path, targetHome, legacyHome) ||
    path.parse(legacyHome).root === legacyHome ||
    path.parse(targetHome).root === targetHome
  ) {
    throw HomeMigrationUnsafe.make({
      message: 'Legacy and target homes must be separate, non-root directories and cannot contain each other.',
      path: targetHome,
    });
  }
}

function inventoryHome(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  include: (relativePath: string) => boolean,
): Effect.Effect<HomeInventory, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const entries: InventoryEntry[] = [];
    const visit = (directory: string, relativeDirectory: string): Effect.Effect<void, unknown, Crypto.Crypto> =>
      Effect.gen(function* () {
        const names = (yield* fs.readDirectory(directory)).sort((left, right) =>
          Effect2.pipe(left, EffectString.localeCompare(right)),
        );
        for (const name of names) {
          const relativePath = portableRelative(path, path.join(relativeDirectory, name));
          if (!include(relativePath)) continue;
          const absolutePath = path.join(directory, name);
          const symbolicLink = yield* fs.readLink(absolutePath).pipe(Effect.option);
          if (Option.isSome(symbolicLink)) {
            const target = symbolicLink.value;
            if (path.isAbsolute(target)) {
              return yield* HomeMigrationUnsafe.make({
                message: `Absolute symbolic links are not migrated because they would retain a dependency on the legacy home: ${relativePath}.`,
                path: absolutePath,
              });
            }
            const resolved = path.resolve(path.dirname(absolutePath), target);
            if (!isWithinOrSame(path, root, resolved)) {
              return yield* HomeMigrationUnsafe.make({
                message: `Symbolic link escapes the legacy home: ${relativePath}.`,
                path: absolutePath,
              });
            }
            entries.push({
              digest: yield* sha256Hex(target),
              mode: 0,
              relativePath,
              size: new TextEncoder().encode(target).length,
              type: 'symlink',
            });
            continue;
          }
          const info = yield* fs.stat(absolutePath);
          if (info.type === 'Directory') {
            entries.push({digest: '', mode: info.mode, relativePath, size: 0, type: 'directory'});
            yield* visit(absolutePath, relativePath);
          } else if (info.type === 'File') {
            entries.push({
              digest: yield* sha256FileHex(absolutePath).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
              mode: info.mode,
              relativePath,
              size: Number(info.size),
              type: 'file',
            });
          } else {
            return yield* HomeMigrationUnsafe.make({
              message: `Unsupported filesystem entry in legacy home: ${relativePath} (${info.type}).`,
              path: absolutePath,
            });
          }
        }
      });
    yield* visit(root, '');
    const treeSha256 = yield* sha256Hex(
      EffectArray.join(
        EffectArray.map(
          EffectArray.filter(entries, entry => entry.type !== 'directory'),
          entry => `${entry.type}\0${entry.relativePath}\0${entry.size}\0${entry.digest}\n`,
        ),
        '',
      ),
    );
    return {
      bytes: EffectArray.reduce(entries, 0, (total, entry) => total + (entry.type === 'file' ? entry.size : 0)),
      directories: EffectArray.filter(entries, entry => entry.type === 'directory').length,
      entries,
      files: EffectArray.filter(entries, entry => entry.type === 'file').length,
      symlinks: EffectArray.filter(entries, entry => entry.type === 'symlink').length,
      treeSha256,
    };
  });
}

function copyInventory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourceRoot: string,
  targetRoot: string,
  inventory: HomeInventory,
) {
  return Effect.gen(function* () {
    for (const entry of inventory.entries) {
      const source = path.join(sourceRoot, entry.relativePath);
      const target = path.join(targetRoot, entry.relativePath);
      if (entry.type === 'directory') {
        yield* fs.makeDirectory(target, {recursive: true, mode: 0o700});
      } else if (entry.type === 'file') {
        yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
        yield* fs.copyFile(source, target);
        yield* fs.chmod(target, 0o600 | (entry.mode & 0o100));
      } else {
        yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
        yield* fs.symlink(yield* fs.readLink(source), target);
      }
    }
  });
}

function verifyCopiedInventory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stage: string,
  expected: HomeInventory,
): Effect.Effect<void, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const actual = yield* inventoryHome(fs, path, stage, () => true);
    if (actual.treeSha256 !== expected.treeSha256) {
      return yield* HomeMigrationConflict.make({
        message: 'Staged home validation failed: copied file metadata or hashes do not match.',
        path: stage,
      });
    }
  });
}

function findResumableStage(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  parent: string,
  targetHome: string,
  legacyHome: string,
): Effect.Effect<{readonly path: string; readonly receipt: HomeMigrationReceipt} | undefined, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const prefix = `${path.basename(targetHome)}.migrate-`;
    const names = EffectArray.filter(
      yield* fs.readDirectory(parent),
      __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.startsWith(prefix)))(__effectArrayValue),
    ).sort();
    let currentSourceInventory: HomeInventory | undefined;
    for (const name of names) {
      const candidate = path.join(parent, name);
      const receipt = yield* readReceipt(fs, path.join(candidate, RECEIPT_RELATIVE_PATH));
      if (!receipt || receipt.targetHome !== targetHome || receipt.legacyHome !== legacyHome) continue;
      const inventory = yield* inventoryHome(
        fs,
        path,
        candidate,
        relativePath => relativePath !== RECEIPT_RELATIVE_PATH && relativePath !== LAYOUT_RELATIVE_PATH,
      );
      if (inventory.treeSha256 === (receipt.stagedTreeSha256 ?? receipt.sourceTreeSha256)) {
        currentSourceInventory ??= yield* inventoryHome(fs, path, legacyHome, shouldIncludeLegacyPath);
        if (currentSourceInventory.treeSha256 !== receipt.sourceTreeSha256) {
          continue;
        }
        return {path: candidate, receipt};
      }
    }
    return undefined;
  });
}

function readReceipt(
  fs: FileSystem.FileSystem,
  receiptPath: string,
): Effect.Effect<HomeMigrationReceipt | undefined, unknown> {
  return fs.readFileString(receiptPath).pipe(
    Effect.map(content => parseReceipt(JSON.parse(content))),
    Effect.orElseSucceed(() => undefined),
  );
}

function parseReceipt(value: unknown): HomeMigrationReceipt {
  if (
    !Predicate.isObject(value) ||
    value.id !== HOME_MIGRATION_ID ||
    value.version !== HOME_MIGRATION_RECEIPT_VERSION
  ) {
    throw new Error('Invalid migration receipt.');
  }
  const bytes = value.bytes;
  const completedAt = value.completedAt;
  const directories = value.directories;
  const files = value.files;
  const legacyHome = value.legacyHome;
  const preservedCurrentEntries = value.preservedCurrentEntries;
  const sourceTreeSha256 = value.sourceTreeSha256;
  const stagedTreeSha256 = value.stagedTreeSha256;
  const symlinks = value.symlinks;
  const targetHome = value.targetHome;
  if (
    typeof files !== 'number' ||
    !Number.isInteger(files) ||
    typeof directories !== 'number' ||
    !Number.isInteger(directories) ||
    typeof symlinks !== 'number' ||
    !Number.isInteger(symlinks) ||
    typeof bytes !== 'number' ||
    !Number.isFinite(bytes) ||
    (preservedCurrentEntries !== undefined &&
      (typeof preservedCurrentEntries !== 'number' ||
        !Number.isInteger(preservedCurrentEntries) ||
        preservedCurrentEntries < 0)) ||
    typeof sourceTreeSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sourceTreeSha256) ||
    (stagedTreeSha256 !== undefined &&
      (typeof stagedTreeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(stagedTreeSha256))) ||
    typeof legacyHome !== 'string' ||
    !legacyHome ||
    typeof targetHome !== 'string' ||
    !targetHome ||
    typeof completedAt !== 'string' ||
    !completedAt
  ) {
    throw new Error('Invalid migration receipt fields.');
  }
  return {
    bytes,
    completedAt,
    directories,
    files,
    id: HOME_MIGRATION_ID,
    legacyHome,
    ...(preservedCurrentEntries === undefined ? {} : {preservedCurrentEntries}),
    sourceTreeSha256,
    ...(stagedTreeSha256 === undefined ? {} : {stagedTreeSha256}),
    symlinks,
    targetHome,
    version: HOME_MIGRATION_RECEIPT_VERSION,
  };
}

function parseLegacyTeamsFile(value: unknown): LegacyTeamsFile {
  if (!Predicate.isObject(value)) throw new Error('Legacy share teams file is not an object.');
  const rawTeams = value.teams;
  if (rawTeams === undefined) return {...value};
  if (!Predicate.isObject(rawTeams)) throw new Error('Legacy share teams value is not an object.');
  const teams: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of EffectRecord.toEntries(rawTeams)) {
    if (!Predicate.isObject(entry)) throw new Error(`Legacy share team ${name} is not an object.`);
    teams[name] = entry;
  }
  return {...value, teams};
}

function planLegacyShareMigrations(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  legacyHome: string,
  targetHome: string,
): Effect.Effect<readonly LegacyShareMigration[], HomeMigrationUnsafe | unknown> {
  return Effect.gen(function* () {
    const teamsPath = path.join(legacyHome, 'share', 'teams.json');
    if (!(yield* fs.exists(teamsPath))) return [];
    const raw = yield* fs.readFileString(teamsPath);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () =>
        HomeMigrationUnsafe.make({
          message: 'Legacy share teams file is not valid JSON.',
          path: teamsPath,
        }),
    });
    if (!Predicate.isObject(parsed)) return [];
    const teams = parsed.teams;
    if (!Predicate.isObject(teams)) return [];

    const plans: LegacyShareMigration[] = [];
    for (const [name, value] of EffectRecord.toEntries(teams)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || /^\.+$/.test(name)) {
        return yield* HomeMigrationUnsafe.make({
          message: `Legacy share has an unsafe team name: ${name}.`,
          path: teamsPath,
        });
      }
      if (!Predicate.isObject(value)) continue;
      const entry = value;
      if (typeof entry.worktree !== 'string' || typeof entry.gitdir !== 'string') continue;
      const sourceWorktreeRelative = checkedLegacyRelative(path, legacyHome, entry.worktree, 'share worktree');
      const sourceGitdirRelative = checkedLegacyRelative(path, legacyHome, entry.gitdir, 'share gitdir');
      plans.push({
        finalGitdir: path.join(targetHome, 'share', 'teams', `${name}.gitdir`),
        finalWorktree: path.join(targetHome, 'share', 'worktrees', name),
        name,
        sourceGitdir: path.resolve(entry.gitdir),
        sourceGitdirRelative,
        sourceWorktree: path.resolve(entry.worktree),
        sourceWorktreeRelative,
        stageGitdirRelative: path.join('share', 'teams', `${name}.gitdir`),
        stageWorktreeRelative: path.join('share', 'worktrees', name),
      });
    }
    return plans;
  });
}

function checkedLegacyRelative(path: Path.Path, legacyHome: string, value: string, label: string): string {
  const absolute = path.resolve(value);
  if (!isWithin(path, legacyHome, absolute)) {
    throw HomeMigrationUnsafe.make({
      message: `Legacy ${label} is outside the owned home and cannot be migrated safely.`,
      path: absolute,
    });
  }
  return path.relative(legacyHome, absolute);
}

function duplicatedMigrationBytes(inventory: HomeInventory, migrations: readonly LegacyShareMigration[]): number {
  const roots = EffectArray.flatMap(migrations, migration => [
    portableInput(migration.sourceWorktreeRelative),
    ...(migration.sourceGitdirRelative === migration.stageGitdirRelative
      ? []
      : [portableInput(migration.sourceGitdirRelative)]),
  ]);
  return EffectArray.reduce(
    EffectArrayPipe(inventory.entries, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (entry, __effectArrayIndex) =>
          __effectArrayIndex in __effectArrayValues &&
          entry.type === 'file' &&
          EffectArray.some(
            roots,
            root =>
              entry.relativePath === root || Effect2.pipe(entry.relativePath, EffectString.startsWith(`${root}/`)),
          ),
      ),
    ),
    0,
    (total, entry) => total + entry.size,
  );
}

function migrateLegacyShares(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stage: string,
  migrations: readonly LegacyShareMigration[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (migrations.length === 0) return;
    const teamsPath = path.join(stage, 'share', 'teams.json');
    const teamsFile = parseLegacyTeamsFile(JSON.parse(yield* fs.readFileString(teamsPath)));
    for (const migration of migrations) {
      const sourceWorktree = path.join(stage, migration.sourceWorktreeRelative);
      const stageWorktree = path.join(stage, migration.stageWorktreeRelative);
      if (!(yield* fs.exists(sourceWorktree))) {
        return yield* HomeMigrationUnsafe.make({
          message: `Legacy share worktree is missing: ${migration.name}.`,
          path: sourceWorktree,
        });
      }
      yield* fs.makeDirectory(path.dirname(stageWorktree), {recursive: true, mode: 0o700});
      yield* fs.copy(sourceWorktree, stageWorktree, {preserveTimestamps: true});

      const canonicalGitMarker = path.join(sourceWorktree, '.git');
      if (yield* fs.exists(canonicalGitMarker)) {
        yield* fs.remove(canonicalGitMarker, {recursive: true});
      }

      const sourceGitdir = path.join(stage, migration.sourceGitdirRelative);
      const stageGitdir = path.join(stage, migration.stageGitdirRelative);
      if (!(yield* fs.exists(sourceGitdir))) {
        return yield* HomeMigrationUnsafe.make({
          message: `Legacy share gitdir is missing: ${migration.name}.`,
          path: sourceGitdir,
        });
      }
      if (sourceGitdir !== stageGitdir) {
        yield* fs.makeDirectory(path.dirname(stageGitdir), {recursive: true, mode: 0o700});
        yield* fs.copy(sourceGitdir, stageGitdir, {preserveTimestamps: true});
      }
      yield* fs.writeFileString(path.join(stageWorktree, '.git'), `gitdir: ${migration.finalGitdir}\n`, {mode: 0o600});
      const gitConfigPath = path.join(stageGitdir, 'config');
      if (yield* fs.exists(gitConfigPath)) {
        const gitConfig = yield* fs.readFileString(gitConfigPath);
        yield* fs.writeFileString(gitConfigPath, rewriteLegacyShareGitConfig(gitConfig, migration), {mode: 0o600});
      }
      const entry = teamsFile.teams?.[migration.name];
      if (entry) {
        entry.gitdir = migration.finalGitdir;
        entry.worktree = migration.finalWorktree;
      }
    }
    yield* fs.writeFileString(teamsPath, `${JSON.stringify(teamsFile, null, 2)}\n`, {mode: 0o600});
  });
}

function shouldIncludeLegacyPath(relativePath: string): boolean {
  const portable = portableInput(relativePath);
  const top = Effect2.pipe(portable, EffectString.split('/'))[0] ?? '';
  const basename = Effect2.pipe(portable, EffectString.split('/')).at(-1) ?? '';
  return (
    !EXCLUDED_LEGACY_PATHS.has(top) &&
    !EXCLUDED_LEGACY_THREADNOTE_PATHS.has(portable) &&
    !isIgnorableOperatingSystemMetadata(basename) &&
    !isTransientShareGitPath(portable)
  );
}

function isTransientShareGitPath(relativePath: string): boolean {
  const segments = Effect2.pipe(relativePath, EffectString.split('/'));
  if (
    segments.length < 4 ||
    segments[0] !== 'share' ||
    segments[1] !== 'teams' ||
    Effect2.pipe(segments[2], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.endsWith('.gitdir')),
    ) !== true
  ) {
    return false;
  }
  const gitSegments = segments.slice(3);
  const filename = gitSegments.at(-1) ?? '';
  if (gitSegments.length === 1 && TRANSIENT_SHARE_GIT_ROOT_FILENAMES.has(filename)) return true;
  if (!Effect2.pipe(filename, EffectString.endsWith('.lock'))) return false;
  return gitSegments.length === 1 || TRANSIENT_SHARE_GIT_LOCK_ROOTS.has(gitSegments[0] ?? '');
}

function portableRelative(path: Path.Path, value: string): string {
  return Effect2.pipe(portableInput(path.normalize(value)), EffectString.replace(/^\/+/, ''));
}

function portableInput(value: string): string {
  return Effect2.pipe(value, EffectString.replaceAll('\\', '/'));
}

function resolveHomeInput(path: Path.Path, userHome: string, value: string): string {
  if (value === '~') return path.resolve(userHome);
  if (Effect2.pipe(value, EffectString.startsWith('~/')) || Effect2.pipe(value, EffectString.startsWith('~\\'))) {
    return path.resolve(userHome, Effect2.pipe(value, EffectString.slice(2)));
  }
  return path.resolve(value);
}

function isWithin(path: Path.Path, parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !Effect2.pipe(relative, EffectString.startsWith(`..${path.sep}`)) &&
    !path.isAbsolute(relative)
  );
}

function isWithinOrSame(path: Path.Path, parent: string, candidate: string): boolean {
  return parent === candidate || isWithin(path, parent, candidate);
}

function isHomeMigrationError(cause: unknown): cause is HomeMigrationError {
  return (
    Schema.is(HomeMigrationConflict)(cause) ||
    Schema.is(HomeMigrationFailed)(cause) ||
    Schema.is(HomeMigrationInsufficientSpace)(cause) ||
    Schema.is(HomeMigrationUnsafe)(cause)
  );
}

function isHomeMigrationResult(value: unknown): value is HomeMigrationResult {
  if (!Predicate.isObject(value)) return false;
  return (
    value.action === 'already_migrated' ||
    value.action === 'dry_run' ||
    value.action === 'migrated' ||
    value.action === 'no_legacy_content' ||
    value.action === 'no_legacy_home' ||
    value.action === 'recovered' ||
    value.action === 'resumed'
  );
}

export function assertSufficientHomeMigrationDiskSpace(
  sourceBytes: number,
  availableBytes: number,
): Effect.Effect<void, HomeMigrationInsufficientSpace> {
  const safetyMargin = Math.min(
    512 * 1024 * 1024,
    Math.max(16 * 1024 * 1024, Math.ceil(Math.max(0, sourceBytes) * 0.1)),
  );
  const requiredBytes = Math.max(0, sourceBytes) + safetyMargin;
  return availableBytes >= requiredBytes
    ? Effect.void
    : Effect.fail(
        HomeMigrationInsufficientSpace.make({
          availableBytes,
          message: `Home migration needs ${requiredBytes} free bytes for a validated staged copy; only ${availableBytes} are available.`,
          requiredBytes,
        }),
      );
}
