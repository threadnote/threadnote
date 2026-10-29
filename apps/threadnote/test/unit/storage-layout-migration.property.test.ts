import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Effect, FileSystem, Path} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  isThreadnoteStorageLayoutMigrationPending,
  migrateThreadnoteStorageLayout,
  STORAGE_LAYOUT_MIGRATION_ID,
  StorageLayoutMigrationConflict,
} from '@threadnote/threadnote/migration/layout';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface MergeableTree {
  readonly account: string;
  readonly identical: readonly Uint8Array[];
  readonly sourceOnly: readonly Uint8Array[];
  readonly targetOnly: readonly Uint8Array[];
}

interface TreeSnapshotEntry {
  readonly bytes?: string;
  readonly relative: string;
  readonly type: string;
}

const accountArbitrary = FC.integer({max: 100_000, min: 0}).map(index => `account-${index}`);
const bytesArbitrary = FC.uint8Array({maxLength: 48});
const emptyScaffoldsArbitrary = FC.array(
  FC.array(
    FC.integer({max: 1_000, min: 0}).map(index => `directory-${index}`),
    {maxLength: 6, minLength: 1},
  ),
  {maxLength: 20, minLength: 1},
);

const mergeableTreeArbitrary = FC.record({
  account: accountArbitrary,
  identical: FC.array(bytesArbitrary, {maxLength: 2, minLength: 1}),
  sourceOnly: FC.array(bytesArbitrary, {maxLength: 2, minLength: 1}),
  targetOnly: FC.array(bytesArbitrary, {maxLength: 2, minLength: 1}),
});

const conflictingTreeArbitrary = FC.record({
  account: accountArbitrary,
  conflictIndex: FC.integer({max: 20, min: 0}),
  sourceConflict: bytesArbitrary,
  sourceOnly: bytesArbitrary,
  targetOnly: bytesArbitrary,
  targetSuffix: FC.integer({max: 255, min: 0}),
});

describe('Threadnote storage layout migration properties', () => {
  it.layer(ApplicationLayer)(layerIt => {
    fcEffectProp(
      layerIt,
      'ignores generated empty beta scaffolds and detects the first material file',
      {scaffolds: emptyScaffoldsArbitrary},
      ({scaffolds}) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-empty-property-'});
          const legacyRoot = path.join(home, 'data', 'viking');
          for (const segments of scaffolds) {
            yield* fs.makeDirectory(path.join(legacyRoot, ...segments), {recursive: true});
          }

          expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
          expect(yield* migrateThreadnoteStorageLayout({home})).toEqual({
            accounts: 0,
            action: 'no_legacy_layout',
          });

          const first = scaffolds[0];
          yield* fs.writeFileString(path.join(legacyRoot, ...first, 'material.md'), '# Material beta data\n');
          expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
        }),
      {fastCheck: {numRuns: 20}, timeout: 30_000},
    );

    fcEffectProp(
      layerIt,
      'dry-runs without writes, merges byte-exact trees, and applies idempotently',
      {tree: mergeableTreeArbitrary},
      ({tree}) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-property-'});
          const sourceRoot = path.join(home, 'data', 'viking', tree.account);
          const targetRoot = path.join(home, 'data', tree.account);
          yield* writeMergeableTree(fs, path, sourceRoot, targetRoot, tree);
          yield* fs.writeFileString(path.join(home, 'layout.json'), '{"version":1}\n');

          const beforeDryRun = yield* snapshotTree(fs, path, home);
          expect(yield* migrateThreadnoteStorageLayout({home})).toEqual({
            accounts: 1,
            action: 'dry_run',
          });
          expect(yield* migrateThreadnoteStorageLayout({home})).toEqual({
            accounts: 1,
            action: 'dry_run',
          });
          expect(yield* snapshotTree(fs, path, home)).toEqual(beforeDryRun);
          expect(yield* fs.exists(path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`))).toBe(false);

          expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
            accounts: 1,
            action: 'migrated',
          });
          expect(yield* fileTree(fs, path, sourceRoot)).toEqual({});
          expect(yield* fileTree(fs, path, targetRoot)).toEqual(expectedMergedFiles(tree));
          expect(JSON.parse(yield* fs.readFileString(path.join(home, 'layout.json')))).toEqual({
            createdBy: 'threadnote',
            version: 2,
          });

          const afterFirstApply = yield* snapshotTree(fs, path, home);
          expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
            accounts: 0,
            action: 'already_current',
          });
          expect(yield* snapshotTree(fs, path, home)).toEqual(afterFirstApply);
        }),
      {fastCheck: {numRuns: 10}, timeout: 30_000},
    );

    fcEffectProp(
      layerIt,
      'leaves both trees and receipts untouched when generated files conflict',
      {tree: conflictingTreeArbitrary},
      ({tree}) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-conflict-property-'});
          const sourceRoot = path.join(home, 'data', 'viking', tree.account);
          const targetRoot = path.join(home, 'data', tree.account);
          const conflictRelative = `shared/group/entry-${tree.conflictIndex}.bin`;
          const targetConflict = appendByte(tree.sourceConflict, tree.targetSuffix);
          yield* writeEntry(fs, path, sourceRoot, conflictRelative, tree.sourceConflict);
          yield* writeEntry(fs, path, targetRoot, conflictRelative, targetConflict);
          yield* writeEntry(fs, path, sourceRoot, '00-source-only/entry.bin', tree.sourceOnly);
          yield* writeEntry(fs, path, targetRoot, '99-target-only/entry.bin', tree.targetOnly);
          yield* fs.writeFileString(path.join(home, 'layout.json'), '{"version":1}\n');

          const before = yield* snapshotTree(fs, path, home);
          const dryRunFailure = yield* migrateThreadnoteStorageLayout({home}).pipe(Effect.flip);
          expect(dryRunFailure).toBeInstanceOf(StorageLayoutMigrationConflict);
          expect(yield* snapshotTree(fs, path, home)).toEqual(before);

          const applyFailure = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(Effect.flip);
          expect(applyFailure).toBeInstanceOf(StorageLayoutMigrationConflict);
          expect(yield* snapshotTree(fs, path, home)).toEqual(before);
          expect(yield* fs.exists(path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`))).toBe(false);
        }),
      {fastCheck: {numRuns: 10}, timeout: 30_000},
    );
  });
});

function writeMergeableTree(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourceRoot: string,
  targetRoot: string,
  tree: MergeableTree,
) {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(sourceRoot, {recursive: true});
    yield* fs.makeDirectory(targetRoot, {recursive: true});
    for (const [index, bytes] of tree.sourceOnly.entries()) {
      yield* writeEntry(fs, path, sourceRoot, sourceOnlyPath(index), bytes);
    }
    for (const [index, bytes] of tree.targetOnly.entries()) {
      yield* writeEntry(fs, path, targetRoot, targetOnlyPath(index), bytes);
    }
    for (const [index, bytes] of tree.identical.entries()) {
      const relative = identicalPath(index);
      yield* writeEntry(fs, path, sourceRoot, relative, bytes);
      yield* writeEntry(fs, path, targetRoot, relative, bytes);
    }
  });
}

function writeEntry(fs: FileSystem.FileSystem, path: Path.Path, root: string, relative: string, bytes: Uint8Array) {
  return Effect.gen(function* () {
    const target = path.join(root, ...Effect2.pipe(relative, EffectString.split('/')));
    yield* fs.makeDirectory(path.dirname(target), {recursive: true});
    yield* fs.writeFile(target, bytes);
  });
}

function snapshotTree(fs: FileSystem.FileSystem, path: Path.Path, root: string) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(root))) return [] satisfies readonly TreeSnapshotEntry[];
    const entries: TreeSnapshotEntry[] = [];
    for (const relative of (yield* fs.readDirectory(root, {recursive: true})).sort()) {
      const absolute = path.join(root, relative);
      const info = yield* fs.stat(absolute);
      entries.push({
        ...(info.type === 'File' ? {bytes: bytesHex(yield* fs.readFile(absolute))} : {}),
        relative: EffectArray.join(Effect2.pipe(relative, EffectString.split(path.sep)), '/'),
        type: info.type,
      });
    }
    return entries.sort((left, right) => Effect2.pipe(left.relative, EffectString.localeCompare(right.relative)));
  });
}

function fileTree(fs: FileSystem.FileSystem, path: Path.Path, root: string) {
  return Effect.gen(function* () {
    const entries = yield* snapshotTree(fs, path, root);
    return EffectRecord.fromEntries(
      EffectArray.map(
        EffectArray.filter(entries, entry => entry.type === 'File'),
        entry => [entry.relative, entry.bytes],
      ),
    );
  });
}

function expectedMergedFiles(tree: MergeableTree): Record<string, string> {
  return EffectRecord.fromEntries([
    ...EffectArray.map(tree.sourceOnly, (bytes, index) => [sourceOnlyPath(index), bytesHex(bytes)] as const),
    ...EffectArray.map(tree.targetOnly, (bytes, index) => [targetOnlyPath(index), bytesHex(bytes)] as const),
    ...EffectArray.map(tree.identical, (bytes, index) => [identicalPath(index), bytesHex(bytes)] as const),
  ]);
}

function sourceOnlyPath(index: number): string {
  return `source/group-${index % 2}/entry-${index}.bin`;
}

function targetOnlyPath(index: number): string {
  return `target/group-${index % 2}/entry-${index}.bin`;
}

function identicalPath(index: number): string {
  return `shared/group-${index % 2}/entry-${index}.bin`;
}

function appendByte(bytes: Uint8Array, suffix: number): Uint8Array {
  const result = new Uint8Array(bytes.length + 1);
  result.set(bytes);
  result[result.length - 1] = suffix;
  return result;
}

function bytesHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
