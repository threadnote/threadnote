import {Array as EffectArray} from 'effect';
import {Crypto, Effect, FileSystem, Option, Path, Predicate, Schema} from 'effect';
import {sha256FileHex, sha256Hex} from '@threadnote/platform/digest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {resourceAccountMutationLockPath} from '@threadnote/store/resource/lock';
import {advanceCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {SystemInfo} from '@threadnote/platform/system';
import {
  LEGACY_THREADNOTE_DATA_DIRECTORY,
  LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION,
  THREADNOTE_STORAGE_LAYOUT_VERSION,
} from '@threadnote/store/layout';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import {hasBoundedMigrationTreeContent, isIgnorableOperatingSystemMetadata} from './evidence.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const STORAGE_LAYOUT_MIGRATION_ID = 'threadnote-storage-layout-v2' as const;
const STORAGE_LAYOUT_MIGRATION_RECEIPT_VERSION = 1 as const;
const MIGRATION_RECEIPT_RELATIVE_PATH = `migration/${STORAGE_LAYOUT_MIGRATION_ID}.json`;
const LAYOUT_RECEIPT_RELATIVE_PATH = 'layout.json';
const LEGACY_CANONICAL_RUNTIME_FILENAMES = new Set(['backend_meta.json']);
const PRESERVED_DUPLICATES_RELATIVE_PATH = `migration/${STORAGE_LAYOUT_MIGRATION_ID}-preserved`;

interface AccountMigration {
  readonly name: string;
  readonly treeSha256: string;
}

interface StorageLayoutMigrationReceipt {
  readonly accounts: readonly AccountMigration[];
  readonly id: typeof STORAGE_LAYOUT_MIGRATION_ID;
  readonly sourceLayoutVersion: typeof LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION;
  readonly status: 'completed' | 'pending';
  readonly targetLayoutVersion: typeof THREADNOTE_STORAGE_LAYOUT_VERSION;
  readonly version: typeof STORAGE_LAYOUT_MIGRATION_RECEIPT_VERSION;
}

export interface StorageLayoutMigrationResult {
  readonly accounts: number;
  readonly action:
    | 'already_current'
    | 'dry_run'
    | 'migrated'
    | 'no_legacy_layout'
    | 'repaired_marker'
    | 'resumed'
    | 'would_repair_marker';
}

export class StorageLayoutMigrationConflict extends Schema.TaggedError<
  StorageLayoutMigrationConflict,
  {readonly brand: unique symbol}
>()('StorageLayoutMigrationConflict', {
  message: Schema.String,
  path: Schema.String,
}) {}

export interface StorageLayoutMigrationOptions {
  readonly apply?: boolean;
  readonly home: string;
}

/**
 * Bounded eligibility check for the beta.1 data/viking layout. This mirrors
 * the state transitions that migrateThreadnoteStorageLayout can perform
 * without hashing or walking the canonical store merely to decide whether an
 * update should offer the migration.
 */
export const isThreadnoteStorageLayoutMigrationPending = Effect.fn('storageLayoutMigration.isPending')(function* (
  options: Pick<StorageLayoutMigrationOptions, 'home'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.resolve(options.home);
  yield* assertLegacyStorageAncestors(fs, path, home);
  const legacyRoot = path.join(home, 'data', LEGACY_THREADNOTE_DATA_DIRECTORY);
  const hasLegacyRoot = (yield* inspectLegacyRoot(fs, legacyRoot)) === 'directory';
  const hasMaterialLegacyRoot =
    hasLegacyRoot &&
    (yield* hasBoundedMigrationTreeContent(fs, path, legacyRoot, (candidate, type) =>
      shouldIncludeLegacyCanonicalStorePath(path, legacyRoot, candidate, type),
    ));
  const receipt = yield* readMigrationReceipt(fs, path.join(home, MIGRATION_RECEIPT_RELATIVE_PATH));
  if (hasMaterialLegacyRoot || receipt?.status === 'pending') return true;

  const currentLayoutVersion = yield* readLayoutVersion(fs, path.join(home, LAYOUT_RECEIPT_RELATIVE_PATH));
  if (currentLayoutVersion === THREADNOTE_STORAGE_LAYOUT_VERSION) return false;
  return receipt?.status === 'completed';
});

/**
 * Flattens the short-lived 4.0.0-beta.1 data/viking/<account> layout into
 * data/<account>. A pending receipt makes every account move/merge resumable.
 * Account writes use the same mutation lock as the canonical resource store;
 * ignored metadata and empty source scaffolds are retained instead of risking
 * recursive deletion while another old-beta process may still be writing.
 */
export const migrateThreadnoteStorageLayout = Effect.fn('storageLayoutMigration.migrate')(function* (
  options: StorageLayoutMigrationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.resolve(options.home);
  yield* assertLegacyStorageAncestors(fs, path, home);
  const dataRoot = path.join(home, 'data');
  const legacyRoot = path.join(dataRoot, LEGACY_THREADNOTE_DATA_DIRECTORY);
  const hasLegacyRoot = (yield* inspectLegacyRoot(fs, legacyRoot)) === 'directory';
  const hasMaterialLegacyRoot =
    hasLegacyRoot &&
    (yield* hasBoundedMigrationTreeContent(fs, path, legacyRoot, (candidate, type) =>
      shouldIncludeLegacyCanonicalStorePath(path, legacyRoot, candidate, type),
    ));
  const receiptPath = path.join(home, MIGRATION_RECEIPT_RELATIVE_PATH);
  const existingReceipt = yield* readMigrationReceipt(fs, receiptPath);
  const currentLayoutVersion = yield* readLayoutVersion(fs, path.join(home, LAYOUT_RECEIPT_RELATIVE_PATH));
  if (
    currentLayoutVersion === THREADNOTE_STORAGE_LAYOUT_VERSION &&
    !hasMaterialLegacyRoot &&
    existingReceipt?.status !== 'pending'
  ) {
    return {accounts: 0, action: 'already_current'} satisfies StorageLayoutMigrationResult;
  }

  if (!hasMaterialLegacyRoot && !existingReceipt) {
    return {accounts: 0, action: 'no_legacy_layout'} satisfies StorageLayoutMigrationResult;
  }
  if (hasMaterialLegacyRoot && existingReceipt?.status === 'completed') {
    return yield* StorageLayoutMigrationConflict.make({
      message: 'A completed storage migration receipt conflicts with a remaining legacy canonical-store directory.',
      path: legacyRoot,
    });
  }

  let receipt = existingReceipt ?? (yield* planMigration(fs, path, dataRoot, legacyRoot));
  if (receipt.status === 'completed') {
    if (currentLayoutVersion !== THREADNOTE_STORAGE_LAYOUT_VERSION) {
      if (options.apply === true) {
        yield* writeCurrentLayoutReceipt(fs, path, home);
        return {accounts: receipt.accounts.length, action: 'repaired_marker'} satisfies StorageLayoutMigrationResult;
      }
      return {accounts: receipt.accounts.length, action: 'would_repair_marker'} satisfies StorageLayoutMigrationResult;
    }
    return {accounts: receipt.accounts.length, action: 'already_current'} satisfies StorageLayoutMigrationResult;
  }
  if (options.apply !== true) {
    return {accounts: receipt.accounts.length, action: 'dry_run'} satisfies StorageLayoutMigrationResult;
  }

  if (existingReceipt && hasLegacyRoot) {
    receipt = mergePendingMigrationPlans(receipt, yield* planMigration(fs, path, dataRoot, legacyRoot));
  }
  yield* writeMigrationReceipt(fs, path, receiptPath, receipt);
  let resumed = existingReceipt !== undefined;
  for (const account of receipt.accounts) {
    yield* withAccountMutationLock(
      fs,
      path,
      home,
      account.name,
      Effect.gen(function* () {
        yield* assertLegacyStorageAncestors(fs, path, home);
        const source = path.join(legacyRoot, account.name);
        const target = path.join(dataRoot, account.name);
        const sourceExists = yield* fs.exists(source);
        const targetExists = yield* fs.exists(target);
        if (sourceExists) yield* assertAccountDirectory(fs, source);
        if (!sourceExists && !targetExists) {
          return yield* StorageLayoutMigrationConflict.make({
            message: `Account "${account.name}" disappeared during the storage layout migration.`,
            path: source,
          });
        }
        const sourceHasMaterial =
          sourceExists &&
          (yield* hasBoundedMigrationTreeContent(fs, path, source, (candidate, type) =>
            shouldIncludeLegacyCanonicalStorePath(path, legacyRoot, candidate, type),
          ));
        yield* advanceCanonicalMutationGeneration(fs, path, home, account.name);
        if (!sourceHasMaterial) {
          if (!targetExists) {
            return yield* StorageLayoutMigrationConflict.make({
              message: `Canonical account "${account.name}" is missing for the pending migration receipt.`,
              path: target,
            });
          }
          const targetDigest = yield* verifyResumedTargetDigest(
            fs,
            path,
            legacyRoot,
            sourceExists ? source : undefined,
            target,
            account,
          );
          if (targetDigest !== account.treeSha256) {
            receipt = replaceAccountDigest(receipt, account.name, targetDigest);
          }
          resumed = true;
          return;
        }
        if (!targetExists) yield* fs.makeDirectory(target, {recursive: true, mode: 0o700});
        yield* mergeDirectories(
          fs,
          path,
          source,
          target,
          (candidate, type) => shouldIncludeLegacyCanonicalStorePath(path, legacyRoot, candidate, type),
          path.join(home, PRESERVED_DUPLICATES_RELATIVE_PATH, account.name),
        );
        if (
          yield* hasBoundedMigrationTreeContent(fs, path, source, (candidate, type) =>
            shouldIncludeLegacyCanonicalStorePath(path, legacyRoot, candidate, type),
          )
        ) {
          return yield* StorageLayoutMigrationConflict.make({
            message: `Legacy account "${account.name}" changed while its storage migration was running.`,
            path: source,
          });
        }
      }),
    );
  }

  yield* assertLegacyStorageAncestors(fs, path, home);
  if ((yield* inspectLegacyRoot(fs, legacyRoot)) === 'directory') {
    if (
      yield* hasBoundedMigrationTreeContent(fs, path, legacyRoot, (candidate, type) =>
        shouldIncludeLegacyCanonicalStorePath(path, legacyRoot, candidate, type),
      )
    ) {
      return yield* StorageLayoutMigrationConflict.make({
        message: 'Material entries remain in the legacy canonical-store directory.',
        path: legacyRoot,
      });
    }
  }
  yield* writeCurrentLayoutReceipt(fs, path, home);
  yield* writeMigrationReceipt(fs, path, receiptPath, {...receipt, status: 'completed'});
  return {
    accounts: receipt.accounts.length,
    action: resumed ? 'resumed' : 'migrated',
  } satisfies StorageLayoutMigrationResult;
});

function planMigration(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dataRoot: string,
  legacyRoot: string,
): Effect.Effect<StorageLayoutMigrationReceipt, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    yield* assertLegacyStorageAncestors(fs, path, path.dirname(dataRoot));
    if ((yield* inspectLegacyRoot(fs, legacyRoot)) !== 'directory') {
      return yield* StorageLayoutMigrationConflict.make({
        message: 'The pending storage migration has no legacy source directory.',
        path: legacyRoot,
      });
    }
    const names = (yield* fs.readDirectory(legacyRoot)).sort();
    const accounts: AccountMigration[] = [];
    for (const name of names) {
      const source = path.join(legacyRoot, name);
      if (Option.isSome(yield* fs.readLink(source).pipe(Effect.option))) {
        return yield* StorageLayoutMigrationConflict.make({
          message: 'Symbolic links are not allowed as Threadnote account roots.',
          path: source,
        });
      }
      const sourceInfo = yield* fs.stat(source);
      if (!shouldIncludeLegacyCanonicalStorePath(path, legacyRoot, source, sourceInfo.type)) continue;
      validatePortableSegment(name, name);
      const target = path.join(dataRoot, name);
      yield* assertAccountDirectory(fs, source);
      if (
        !(yield* hasBoundedMigrationTreeContent(fs, path, source, (candidate, type) =>
          shouldIncludeLegacyCanonicalStorePath(path, legacyRoot, candidate, type),
        ))
      ) {
        continue;
      }
      accounts.push({
        name,
        treeSha256: (yield* fs.exists(target))
          ? yield* digestMergedDirectories(fs, path, source, target, (candidate, type) =>
              shouldIncludeLegacyCanonicalStorePath(path, legacyRoot, candidate, type),
            )
          : yield* digestDirectory(fs, path, source, (candidate, type) =>
              shouldIncludeLegacyCanonicalStorePath(path, legacyRoot, candidate, type),
            ),
      });
    }
    return {
      accounts,
      id: STORAGE_LAYOUT_MIGRATION_ID,
      sourceLayoutVersion: LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION,
      status: 'pending',
      targetLayoutVersion: THREADNOTE_STORAGE_LAYOUT_VERSION,
      version: STORAGE_LAYOUT_MIGRATION_RECEIPT_VERSION,
    };
  });
}

function mergePendingMigrationPlans(
  existing: StorageLayoutMigrationReceipt,
  current: StorageLayoutMigrationReceipt,
): StorageLayoutMigrationReceipt {
  const accounts = new Map(EffectArray.map(existing.accounts, account => [account.name, account]));
  for (const account of current.accounts) accounts.set(account.name, account);
  return {
    ...existing,
    accounts: [...accounts.values()].sort((left, right) =>
      Effect2.pipe(left.name, EffectString.localeCompare(right.name)),
    ),
  };
}

function replaceAccountDigest(
  receipt: StorageLayoutMigrationReceipt,
  account: string,
  treeSha256: string,
): StorageLayoutMigrationReceipt {
  return {
    ...receipt,
    accounts: EffectArray.map(receipt.accounts, current =>
      current.name === account ? {...current, treeSha256} : current,
    ),
  };
}

function verifyResumedTargetDigest(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  legacyRoot: string,
  source: string | undefined,
  target: string,
  account: AccountMigration,
): Effect.Effect<string, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const targetDigest = yield* digestDirectory(fs, path, target, (candidate, type) =>
      shouldIncludeLegacyCanonicalStorePath(path, legacyRoot, candidate, type),
    );
    if (targetDigest === account.treeSha256) return targetDigest;
    const legacyDigest = source
      ? yield* digestMergedDirectories(fs, path, source, target)
      : yield* digestDirectory(fs, path, target);
    if (legacyDigest === account.treeSha256) return targetDigest;
    return yield* StorageLayoutMigrationConflict.make({
      message: `Canonical account "${account.name}" does not match the pending migration receipt.`,
      path: target,
    });
  });
}

function shouldIncludeLegacyCanonicalStorePath(
  path: Path.Path,
  legacyRoot: string,
  candidate: string,
  type: string,
): boolean {
  if (type !== 'File') return true;
  const name = path.basename(candidate);
  if (isIgnorableOperatingSystemMetadata(name)) return false;
  return (
    path.resolve(path.dirname(candidate)) !== path.resolve(legacyRoot) ||
    !LEGACY_CANONICAL_RUNTIME_FILENAMES.has(Effect2.pipe(name, EffectString.toLowerCase))
  );
}

function withAccountMutationLock<A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  account: string,
  effect: Effect.Effect<A, E, R>,
) {
  return withExclusiveFileLock(
    fs,
    resourceAccountMutationLockPath(path, home, account),
    {
      heartbeatIntervalMilliseconds: 10_000,
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 30_000,
      waitTimeoutMilliseconds: 30_000,
    },
    effect,
  );
}

function assertLegacyStorageAncestors(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const dataRoot = path.join(home, 'data');
    if (Option.isSome(yield* fs.readLink(dataRoot).pipe(Effect.option))) {
      return yield* StorageLayoutMigrationConflict.make({
        message: 'The Threadnote data directory must not be a symbolic link during storage migration.',
        path: dataRoot,
      });
    }
    if (!(yield* fs.exists(dataRoot))) return;
    const info = yield* fs.stat(dataRoot);
    if (info.type !== 'Directory') {
      return yield* StorageLayoutMigrationConflict.make({
        message: 'The Threadnote data path must be a regular directory during storage migration.',
        path: dataRoot,
      });
    }
    const canonicalHome = yield* fs.realPath(home);
    const canonicalDataRoot = yield* fs.realPath(dataRoot);
    if (path.resolve(canonicalDataRoot) !== path.resolve(canonicalHome, 'data')) {
      return yield* StorageLayoutMigrationConflict.make({
        message: 'The Threadnote data directory resolves outside its owned canonical path.',
        path: dataRoot,
      });
    }
  });
}

function inspectLegacyRoot(fs: FileSystem.FileSystem, legacyRoot: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(legacyRoot).pipe(Effect.option))) {
      return yield* StorageLayoutMigrationConflict.make({
        message: 'The legacy canonical-store root must not be a symbolic link.',
        path: legacyRoot,
      });
    }
    if (!(yield* fs.exists(legacyRoot))) return 'absent' as const;
    const info = yield* fs.stat(legacyRoot);
    if (info.type !== 'Directory') {
      return yield* StorageLayoutMigrationConflict.make({
        message: 'The legacy canonical-store root must be a regular directory.',
        path: legacyRoot,
      });
    }
    return 'directory' as const;
  });
}

function assertAccountDirectory(fs: FileSystem.FileSystem, source: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(source).pipe(Effect.option))) {
      return yield* StorageLayoutMigrationConflict.make({
        message: 'Symbolic links are not allowed as Threadnote account roots.',
        path: source,
      });
    }
    const info = yield* fs.stat(source);
    if (info.type !== 'Directory') {
      return yield* StorageLayoutMigrationConflict.make({
        message: 'Every entry in the legacy canonical store must be an account directory.',
        path: source,
      });
    }
  });
}

function digestDirectory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  include: (candidate: string, type: string) => boolean = () => true,
): Effect.Effect<string, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const entries: string[] = [];
    const visit = (directory: string, relativeDirectory: string): Effect.Effect<void, unknown, Crypto.Crypto> =>
      Effect.gen(function* () {
        for (const name of (yield* fs.readDirectory(directory)).sort()) {
          const absolute = path.join(directory, name);
          const relative = EffectArray.join(
            Effect2.pipe(path.join(relativeDirectory, name), EffectString.split(path.sep)),
            '/',
          );
          if (Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option))) {
            return yield* StorageLayoutMigrationConflict.make({
              message: 'Symbolic links are not allowed in the canonical Threadnote store.',
              path: absolute,
            });
          }
          const info = yield* fs.stat(absolute);
          if (!include(absolute, info.type)) continue;
          if (info.type === 'Directory') {
            entries.push(`directory\0${relative}\n`);
            yield* visit(absolute, relative);
          } else if (info.type === 'File') {
            entries.push(
              `file\0${relative}\0${Number(info.size)}\0${yield* sha256FileHex(absolute).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              )}\n`,
            );
          } else {
            return yield* StorageLayoutMigrationConflict.make({
              message: `Unsupported canonical-store entry type: ${info.type}.`,
              path: absolute,
            });
          }
        }
      });
    yield* visit(root, '');
    return yield* sha256Hex(EffectArray.join(entries, ''));
  });
}

function digestMergedDirectories(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourceRoot: string,
  targetRoot: string,
  include: (candidate: string, type: string) => boolean = () => true,
): Effect.Effect<string, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    if (
      Option.isSome(yield* fs.readLink(targetRoot).pipe(Effect.option)) ||
      (yield* fs.stat(targetRoot)).type !== 'Directory'
    ) {
      return yield* StorageLayoutMigrationConflict.make({
        message: 'The canonical account destination must be a regular directory.',
        path: targetRoot,
      });
    }
    const entries: string[] = [];
    const visit = (
      sourceDirectory: string | undefined,
      targetDirectory: string | undefined,
      relativeDirectory: string,
    ): Effect.Effect<void, unknown, Crypto.Crypto> =>
      Effect.gen(function* () {
        const names = new Set<string>();
        if (sourceDirectory) {
          for (const name of yield* fs.readDirectory(sourceDirectory)) names.add(name);
        }
        if (targetDirectory) {
          for (const name of yield* fs.readDirectory(targetDirectory)) names.add(name);
        }
        for (const name of [...names].sort()) {
          const source = sourceDirectory ? path.join(sourceDirectory, name) : undefined;
          const target = targetDirectory ? path.join(targetDirectory, name) : undefined;
          const sourceExists = source !== undefined && (yield* fs.exists(source));
          const targetExists = target !== undefined && (yield* fs.exists(target));
          const sourcePath = sourceExists ? source : undefined;
          const targetPath = targetExists ? target : undefined;
          const relative = EffectArray.join(
            Effect2.pipe(path.join(relativeDirectory, name), EffectString.split(path.sep)),
            '/',
          );
          for (const absolute of [sourcePath, targetPath]) {
            if (absolute && Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option))) {
              return yield* StorageLayoutMigrationConflict.make({
                message: 'Symbolic links are not allowed in the canonical Threadnote store.',
                path: absolute,
              });
            }
          }
          const sourceInfo = sourcePath ? yield* fs.stat(sourcePath) : undefined;
          const targetInfo = targetPath ? yield* fs.stat(targetPath) : undefined;
          if (sourceInfo && targetInfo && sourceInfo.type !== targetInfo.type) {
            return yield* StorageLayoutMigrationConflict.make({
              message: `Legacy and canonical entries have different types at "${relative}".`,
              path: targetPath!,
            });
          }
          const info = sourceInfo ?? targetInfo;
          if (!include(sourcePath ?? targetPath!, info?.type ?? 'Unknown')) continue;
          if (info?.type === 'Directory') {
            entries.push(`directory\0${relative}\n`);
            yield* visit(sourcePath, targetPath, relative);
          } else if (info?.type === 'File') {
            const selected = sourcePath ?? targetPath!;
            const size = Number(info.size);
            const digest = yield* sha256FileHex(selected).pipe(Effect.provideService(FileSystem.FileSystem, fs));
            if (sourcePath && targetPath) {
              const targetSize = Number(targetInfo!.size);
              const targetDigest = yield* sha256FileHex(targetPath).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              );
              if (size !== targetSize || digest !== targetDigest) {
                return yield* StorageLayoutMigrationConflict.make({
                  message: `Legacy and canonical files differ at "${relative}".`,
                  path: targetPath,
                });
              }
            }
            entries.push(`file\0${relative}\0${size}\0${digest}\n`);
          } else {
            return yield* StorageLayoutMigrationConflict.make({
              message: `Unsupported canonical-store entry type: ${info?.type ?? 'missing'}.`,
              path: sourcePath ?? targetPath ?? targetRoot,
            });
          }
        }
      });
    yield* visit(sourceRoot, targetRoot, '');
    return yield* sha256Hex(EffectArray.join(entries, ''));
  });
}

function mergeDirectories(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourceRoot: string,
  targetRoot: string,
  include: (candidate: string, type: string) => boolean,
  preservedRoot: string,
) {
  const visit = (
    sourceDirectory: string,
    targetDirectory: string,
    relativeDirectory: string,
  ): Effect.Effect<void, unknown, Crypto.Crypto> =>
    Effect.gen(function* () {
      for (const name of (yield* fs.readDirectory(sourceDirectory)).sort()) {
        const source = path.join(sourceDirectory, name);
        const target = path.join(targetDirectory, name);
        if (Option.isSome(yield* fs.readLink(source).pipe(Effect.option))) {
          return yield* StorageLayoutMigrationConflict.make({
            message: 'Symbolic links are not allowed in the canonical Threadnote store.',
            path: source,
          });
        }
        const sourceInfo = yield* fs.stat(source);
        if (!include(source, sourceInfo.type)) continue;
        const targetExists = yield* fs.exists(target);
        if (!targetExists && sourceInfo.type === 'Directory') {
          yield* fs.makeDirectory(target, {recursive: true, mode: 0o700});
          yield* visit(source, target, path.join(relativeDirectory, name));
          continue;
        }
        if (!targetExists && sourceInfo.type === 'File') {
          yield* fs.rename(source, target);
          continue;
        }
        if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
          return yield* StorageLayoutMigrationConflict.make({
            message: 'Symbolic links are not allowed in the canonical Threadnote store.',
            path: target,
          });
        }
        const targetInfo = yield* fs.stat(target);
        if (sourceInfo.type === 'Directory' && targetInfo.type === 'Directory') {
          yield* visit(source, target, path.join(relativeDirectory, name));
          continue;
        }
        if (sourceInfo.type === 'File' && targetInfo.type === 'File') {
          const sourceDigest = yield* sha256FileHex(source).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          const targetDigest = yield* sha256FileHex(target).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          if (Number(sourceInfo.size) === Number(targetInfo.size) && sourceDigest === targetDigest) {
            yield* preserveDuplicateFile(fs, path, source, path.join(relativeDirectory, name), preservedRoot);
            continue;
          }
        }
        return yield* StorageLayoutMigrationConflict.make({
          message: `Cannot safely merge different entries at "${target}".`,
          path: target,
        });
      }
    });
  return visit(sourceRoot, targetRoot, '');
}

function preserveDuplicateFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  source: string,
  relative: string,
  preservedRoot: string,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (let duplicate = 0; ; duplicate += 1) {
      const candidate = path.join(preservedRoot, `duplicate-${duplicate}`, relative);
      if (yield* fs.exists(candidate)) continue;
      yield* fs.makeDirectory(path.dirname(candidate), {recursive: true, mode: 0o700});
      yield* fs.rename(source, candidate);
      return;
    }
  });
}

function readLayoutVersion(fs: FileSystem.FileSystem, receiptPath: string): Effect.Effect<number | undefined, unknown> {
  return fs.readFileString(receiptPath).pipe(
    Effect.map(content => {
      const parsed: unknown = JSON.parse(content);
      if (!Predicate.isObject(parsed)) return undefined;
      const version = parsed.version;
      return typeof version === 'number' ? version : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );
}

function readMigrationReceipt(
  fs: FileSystem.FileSystem,
  receiptPath: string,
): Effect.Effect<StorageLayoutMigrationReceipt | undefined, unknown> {
  return fs.readFileString(receiptPath).pipe(
    Effect.map(content => {
      const value: unknown = JSON.parse(content);
      if (!Predicate.isObject(value)) {
        throw new Error('Invalid Threadnote storage layout migration receipt.');
      }
      const parsed = value;
      if (
        parsed.id !== STORAGE_LAYOUT_MIGRATION_ID ||
        parsed.version !== STORAGE_LAYOUT_MIGRATION_RECEIPT_VERSION ||
        parsed.sourceLayoutVersion !== LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION ||
        parsed.targetLayoutVersion !== THREADNOTE_STORAGE_LAYOUT_VERSION ||
        (parsed.status !== 'pending' && parsed.status !== 'completed') ||
        !EffectArray.isArray(parsed.accounts)
      ) {
        throw new Error('Invalid Threadnote storage layout migration receipt.');
      }
      const accounts: AccountMigration[] = [];
      for (const account of parsed.accounts) {
        if (!Predicate.isObject(account)) {
          throw new Error('Invalid account in storage layout migration receipt.');
        }
        const fields = account;
        if (typeof fields.name !== 'string' || typeof fields.treeSha256 !== 'string') {
          throw new Error('Invalid account in storage layout migration receipt.');
        }
        validatePortableSegment(fields.name, fields.name);
        if (!/^[a-f0-9]{64}$/.test(fields.treeSha256)) {
          throw new Error('Invalid account digest in storage layout migration receipt.');
        }
        accounts.push({name: fields.name, treeSha256: fields.treeSha256});
      }
      return {
        accounts,
        id: STORAGE_LAYOUT_MIGRATION_ID,
        sourceLayoutVersion: parsed.sourceLayoutVersion,
        status: parsed.status === 'pending' ? ('pending' as const) : ('completed' as const),
        targetLayoutVersion: parsed.targetLayoutVersion,
        version: STORAGE_LAYOUT_MIGRATION_RECEIPT_VERSION,
      };
    }),
    Effect.orElseSucceed(() => undefined),
  );
}

function writeMigrationReceipt(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  receiptPath: string,
  receipt: StorageLayoutMigrationReceipt,
) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    yield* fs.makeDirectory(path.dirname(receiptPath), {recursive: true, mode: 0o700});
    const temporary = `${receiptPath}.${system.processId}.tmp`;
    yield* fs.writeFileString(temporary, `${JSON.stringify(receipt, undefined, 2)}\n`, {mode: 0o600});
    yield* fs.rename(temporary, receiptPath);
  });
}

function writeCurrentLayoutReceipt(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const target = path.join(home, LAYOUT_RECEIPT_RELATIVE_PATH);
    const temporary = `${target}.${STORAGE_LAYOUT_MIGRATION_ID}.tmp`;
    yield* fs.writeFileString(
      temporary,
      `${JSON.stringify({createdBy: 'threadnote', version: THREADNOTE_STORAGE_LAYOUT_VERSION}, undefined, 2)}\n`,
      {mode: 0o600},
    );
    yield* fs.rename(temporary, target);
  });
}
