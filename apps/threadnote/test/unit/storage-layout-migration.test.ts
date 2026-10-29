import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {describe} from 'vitest';
import {sha256FileHex, sha256Hex} from '@threadnote/platform/digest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {
  isThreadnoteStorageLayoutMigrationPending,
  migrateThreadnoteStorageLayout,
  STORAGE_LAYOUT_MIGRATION_ID,
  StorageLayoutMigrationConflict,
} from '@threadnote/threadnote/migration/layout';
import {loadRecallIndex} from '@threadnote/recall/index';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('Threadnote storage layout migration', () => {
  it.effect('ignores empty beta layout scaffolds, including after a completed migration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-empty-scaffold-'});
        yield* fs.makeDirectory(path.join(home, 'data', 'viking', 'local', 'user'), {recursive: true});
        yield* fs.writeFileString(path.join(home, 'data', 'viking', 'backend_meta.json'), '{"runtime":true}\n');
        yield* fs.writeFileString(path.join(home, 'data', 'viking', '.DS_Store'), 'Finder metadata');
        yield* fs.writeFileString(path.join(home, 'data', 'viking', 'desktop.ini'), 'Windows metadata');
        yield* fs.writeFileString(path.join(home, 'data', 'viking', 'Thumbs.db'), 'Windows thumbnails');
        yield* fs.writeFileString(path.join(home, 'data', 'viking', 'local', '._memory.md'), 'AppleDouble metadata');
        yield* fs.writeFileString(path.join(home, 'data', 'viking', 'local', 'user', '.DS_Store'), 'Finder metadata');

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
        expect(yield* migrateThreadnoteStorageLayout({home})).toEqual({
          accounts: 0,
          action: 'no_legacy_layout',
        });

        yield* fs.makeDirectory(path.join(home, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`),
          `${JSON.stringify({
            accounts: [],
            id: STORAGE_LAYOUT_MIGRATION_ID,
            sourceLayoutVersion: 1,
            status: 'completed',
            targetLayoutVersion: 2,
            version: 1,
          })}\n`,
        );
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 0,
          action: 'already_current',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('removes ignored metadata and empty account scaffolds while migrating real beta data', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-metadata-cleanup-'});
        const realMemory = path.join(home, 'data', 'viking', 'local', 'memory.md');
        const emptyAccount = path.join(home, 'data', 'viking', 'empty-account', 'nested');
        yield* fs.makeDirectory(path.dirname(realMemory), {recursive: true});
        yield* fs.makeDirectory(emptyAccount, {recursive: true});
        yield* fs.writeFileString(realMemory, 'real beta memory');
        yield* fs.writeFileString(path.join(path.dirname(realMemory), '.DS_Store'), 'Finder metadata');
        yield* fs.writeFileString(path.join(home, 'data', 'viking', 'backend_meta.json'), '{"runtime":true}\n');
        yield* fs.writeFileString(path.join(emptyAccount, 'Thumbs.db'), 'Windows thumbnails');

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
        expect(yield* migrateThreadnoteStorageLayout({home})).toEqual({accounts: 1, action: 'dry_run'});
        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'migrated',
        });
        expect(yield* fs.readFileString(path.join(home, 'data', 'local', 'memory.md'))).toBe('real beta memory');
        expect(yield* fs.exists(path.join(home, 'data', 'empty-account'))).toBe(false);
        expect(yield* fs.exists(path.join(home, 'data', 'viking'))).toBe(true);
        expect(yield* fs.exists(path.join(home, 'data', 'local', '.DS_Store'))).toBe(false);
        expect(yield* fs.exists(path.join(home, 'data', 'viking', 'local', '.DS_Store'))).toBe(true);
        expect(yield* readCanonicalMutationGeneration(fs, path, home, 'local')).toMatch(/^v1:/);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('does not hide a material account directory that shares a runtime-metadata filename', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-runtime-name-account-'});
        const source = path.join(home, 'data', 'viking', 'backend_meta.json', 'memory.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFileString(source, 'material account data');

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'migrated',
        });
        expect(yield* fs.readFileString(path.join(home, 'data', 'backend_meta.json', 'memory.md'))).toBe(
          'material account data',
        );
        expect(yield* fs.exists(source)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('accepts additive canonical writes that arrive after a source file moves', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-additive-target-'});
        const source = path.join(home, 'data', 'viking', 'local', 'memory.md');
        const target = path.join(home, 'data', 'local', 'memory.md');
        const additive = path.join(home, 'data', 'local', 'new-memory.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFileString(source, 'planned beta memory');
        let injected = false;
        const racingFs: FileSystem.FileSystem = {
          ...fs,
          rename: (from, to) =>
            fs.rename(from, to).pipe(
              Effect.tap(() => {
                if (injected || from !== source || to !== target) return Effect.void;
                injected = true;
                return fs.writeFileString(additive, 'concurrent canonical memory');
              }),
            ),
        };

        expect(
          yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(
            Effect.provideService(FileSystem.FileSystem, racingFs),
          ),
        ).toEqual({accounts: 1, action: 'migrated'});
        expect(yield* fs.readFileString(target)).toBe('planned beta memory');
        expect(yield* fs.readFileString(additive)).toBe('concurrent canonical memory');
        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('keeps a late legacy write and resumes it instead of deleting the source tree', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-late-source-'});
        const sourceRoot = path.join(home, 'data', 'viking', 'local');
        const source = path.join(sourceRoot, 'memory.md');
        const lateSource = path.join(sourceRoot, 'late-memory.md');
        const targetRoot = path.join(home, 'data', 'local');
        yield* fs.makeDirectory(sourceRoot, {recursive: true});
        yield* fs.writeFileString(source, 'planned beta memory');
        let moved = false;
        let injected = false;
        const racingFs: FileSystem.FileSystem = {
          ...fs,
          readDirectory: directory =>
            fs.readDirectory(directory).pipe(
              Effect.tap(entries => {
                if (injected || !moved || directory !== sourceRoot || entries.length > 0) return Effect.void;
                injected = true;
                return fs.writeFileString(lateSource, 'late beta memory');
              }),
            ),
          rename: (from, to) =>
            fs.rename(from, to).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (from === source) moved = true;
                }),
              ),
            ),
        };

        const interrupted = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(
          Effect.provideService(FileSystem.FileSystem, racingFs),
          Effect.flip,
        );
        expect(interrupted).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(yield* fs.readFileString(lateSource)).toBe('late beta memory');
        expect(yield* fs.readFileString(path.join(targetRoot, 'memory.md'))).toBe('planned beta memory');

        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'resumed',
        });
        expect(yield* fs.readFileString(path.join(targetRoot, 'late-memory.md'))).toBe('late beta memory');
        expect(yield* fs.exists(lateSource)).toBe(false);
        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('flattens beta.1 accounts into data and records a resumable migration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-migration-'});
        const source = path.join(home, 'data', 'viking', 'local', 'resources', 'repos', 'threadnote', 'guide.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFileString(source, '# Guide\n');
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"version":1}\n');

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
        expect(yield* migrateThreadnoteStorageLayout({home})).toEqual({accounts: 1, action: 'dry_run'});
        expect(yield* fs.exists(source)).toBe(true);

        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'migrated',
        });
        expect(
          yield* fs.readFileString(path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'guide.md')),
        ).toContain('Guide');
        expect(yield* fs.exists(source)).toBe(false);
        expect(yield* fs.exists(path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`))).toBe(true);
        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('fully reconciles a migration generation before a later targeted mutation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-recall-continuity-'});
        const currentRoot = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote');
        const legacyRoot = path.join(home, 'data', 'viking', 'local', 'resources', 'repos', 'threadnote');
        yield* fs.makeDirectory(currentRoot, {recursive: true});
        yield* fs.makeDirectory(legacyRoot, {recursive: true});
        yield* fs.writeFileString(path.join(currentRoot, 'first.md'), '# First\n\nfirst-anchor');
        yield* fs.writeFileString(path.join(currentRoot, 'stable.md'), '# Stable\n\nstable-anchor');
        yield* fs.writeFileString(path.join(legacyRoot, 'migrated.md'), '# Migrated\n\nmigrated-anchor');
        const config = {account: 'local', agentContextHome: home, user: 'test-user'};
        expect(yield* loadRecallIndex(config, {includeInactive: false})).toHaveLength(2);

        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'migrated',
        });
        const store = yield* ResourceStore;
        const laterUri = 'threadnote://resources/repos/threadnote/later.md';
        yield* store.write({account: 'local', home, user: 'test-user'}, laterUri, '# Later\n\nlater-anchor', {
          mode: 'create',
        });
        const indexingTotals: number[] = [];
        const refreshed = yield* loadRecallIndex(config, {
          includeInactive: false,
          onProgress: progress =>
            Effect.sync(() => {
              if (progress.phase === 'indexing' && progress.completed === 0) indexingTotals.push(progress.total);
            }),
        });

        expect(indexingTotals).toEqual([4]);
        expect(EffectArray.map(refreshed, candidate => candidate.uri)).toEqual([
          'threadnote://resources/repos/threadnote/first.md',
          laterUri,
          'threadnote://resources/repos/threadnote/migrated.md',
          'threadnote://resources/repos/threadnote/stable.md',
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('refuses an account collision without moving either tree', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-conflict-'});
        const source = path.join(home, 'data', 'viking', 'local', 'memory.md');
        const target = path.join(home, 'data', 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.makeDirectory(path.dirname(target), {recursive: true});
        yield* fs.writeFileString(source, 'source');
        yield* fs.writeFileString(target, 'target');

        const failure = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(yield* fs.readFileString(source)).toBe('source');
        expect(yield* fs.readFileString(target)).toBe('target');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('merges disjoint beta.1 and canonical account contents', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-merge-'});
        const source = path.join(home, 'data', 'viking', 'local', 'current.md');
        const target = path.join(home, 'data', 'local', 'legacy.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.makeDirectory(path.dirname(target), {recursive: true});
        yield* fs.writeFileString(source, 'current beta memory');
        yield* fs.writeFileString(target, 'legacy memory');

        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'migrated',
        });
        expect(yield* fs.readFileString(path.join(home, 'data', 'local', 'current.md'))).toBe('current beta memory');
        expect(yield* fs.readFileString(target)).toBe('legacy memory');
        expect(yield* fs.exists(source)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('recovers beta.1 data even when repair already wrote the current layout marker', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-current-marker-'});
        const source = path.join(home, 'data', 'viking', 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFileString(source, 'beta memory');
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'migrated',
        });
        expect(yield* fs.readFileString(path.join(home, 'data', 'local', 'memory.md'))).toBe('beta memory');
        expect(yield* fs.exists(source)).toBe(false);
        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('resumes a pending receipt even when the current layout marker already exists', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-pending-marker-'});
        const target = path.join(home, 'data', 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(target), {recursive: true});
        yield* fs.writeFileString(target, 'already moved');
        const digest = yield* sha256FileHex(target);
        const treeSha256 = yield* sha256Hex(`file\0memory.md\0${'already moved'.length}\0${digest}\n`);
        yield* fs.makeDirectory(path.join(home, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`),
          `${JSON.stringify({
            accounts: [{name: 'local', treeSha256}],
            id: STORAGE_LAYOUT_MIGRATION_ID,
            sourceLayoutVersion: 1,
            status: 'pending',
            targetLayoutVersion: 2,
            version: 1,
          })}\n`,
        );
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'resumed',
        });
        expect(yield* fs.readFileString(target)).toBe('already moved');
        expect(yield* readCanonicalMutationGeneration(fs, path, home, 'local')).toMatch(/^v1:/);
        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('upgrades an old pending receipt whose target digest included OS metadata', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-legacy-metadata-digest-'});
        const target = path.join(home, 'data', 'local', 'memory.md');
        const metadata = path.join(home, 'data', 'local', '.DS_Store');
        const memory = 'already moved';
        const metadataContent = 'legacy Finder metadata';
        yield* fs.makeDirectory(path.dirname(target), {recursive: true});
        yield* fs.writeFileString(target, memory);
        yield* fs.writeFileString(metadata, metadataContent);
        const legacyTreeSha256 = yield* sha256Hex(
          `file\0.DS_Store\0${metadataContent.length}\0${yield* sha256FileHex(metadata)}\n` +
            `file\0memory.md\0${memory.length}\0${yield* sha256FileHex(target)}\n`,
        );
        const filteredTreeSha256 = yield* sha256Hex(
          `file\0memory.md\0${memory.length}\0${yield* sha256FileHex(target)}\n`,
        );
        yield* fs.makeDirectory(path.join(home, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`),
          `${JSON.stringify({
            accounts: [{name: 'local', treeSha256: legacyTreeSha256}],
            id: STORAGE_LAYOUT_MIGRATION_ID,
            sourceLayoutVersion: 1,
            status: 'pending',
            targetLayoutVersion: 2,
            version: 1,
          })}\n`,
        );

        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'resumed',
        });
        const receipt = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            accounts: Schema.Array(Schema.Struct({treeSha256: Schema.String})),
            status: Schema.Literals(['completed', 'pending']),
          }),
        )(JSON.parse(yield* fs.readFileString(path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`))));
        expect(receipt.status).toBe('completed');
        expect(receipt.accounts[0]?.treeSha256).toBe(filteredTreeSha256);
        expect(yield* fs.readFileString(metadata)).toBe(metadataContent);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects a source-absent resume when the canonical target does not match its receipt', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-incomplete-resume-'});
        yield* fs.makeDirectory(path.join(home, 'data', 'local'), {recursive: true});
        yield* fs.makeDirectory(path.join(home, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`),
          `${JSON.stringify({
            accounts: [{name: 'local', treeSha256: Effect2.pipe('a', EffectString.repeat(64))}],
            id: STORAGE_LAYOUT_MIGRATION_ID,
            sourceLayoutVersion: 1,
            status: 'pending',
            targetLayoutVersion: 2,
            version: 1,
          })}\n`,
        );
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const failure = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(
          JSON.parse(yield* fs.readFileString(path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`)))
            .status,
        ).toBe('pending');
        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects an empty residual source scaffold when its canonical target is incomplete', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-empty-residual-resume-'});
        yield* fs.makeDirectory(path.join(home, 'data', 'viking', 'local'), {recursive: true});
        yield* fs.makeDirectory(path.join(home, 'data', 'local'), {recursive: true});
        yield* fs.makeDirectory(path.join(home, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`),
          `${JSON.stringify({
            accounts: [{name: 'local', treeSha256: Effect2.pipe('a', EffectString.repeat(64))}],
            id: STORAGE_LAYOUT_MIGRATION_ID,
            sourceLayoutVersion: 1,
            status: 'pending',
            targetLayoutVersion: 2,
            version: 1,
          })}\n`,
        );

        const failure = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(StorageLayoutMigrationConflict);
        const receipt = yield* Schema.decodeUnknownEffect(
          Schema.Struct({status: Schema.Literals(['completed', 'pending'])}),
        )(JSON.parse(yield* fs.readFileString(path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`))));
        expect(receipt.status).toBe('pending');
        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('reports and repairs a missing or stale layout marker from a completed receipt', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-marker-repair-'});
        for (const [name, marker] of [
          ['missing', undefined],
          ['stale', '{"createdBy":"threadnote","version":1}\n'],
        ] as const) {
          const home = path.join(root, name);
          yield* fs.makeDirectory(path.join(home, 'migration'), {recursive: true});
          yield* fs.writeFileString(
            path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`),
            `${JSON.stringify({
              accounts: [],
              id: STORAGE_LAYOUT_MIGRATION_ID,
              sourceLayoutVersion: 1,
              status: 'completed',
              targetLayoutVersion: 2,
              version: 1,
            })}\n`,
          );
          if (marker !== undefined) yield* fs.writeFileString(path.join(home, 'layout.json'), marker);

          expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
          expect(yield* migrateThreadnoteStorageLayout({home})).toEqual({
            accounts: 0,
            action: 'would_repair_marker',
          });
          expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
            accounts: 0,
            action: 'repaired_marker',
          });
          expect(JSON.parse(yield* fs.readFileString(path.join(home, 'layout.json')))).toEqual({
            createdBy: 'threadnote',
            version: 2,
          });
          expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects a symbolic-link legacy root before eligibility or apply can traverse it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-root-link-'});
        const external = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-external-'});
        const externalMemory = path.join(external, 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(externalMemory), {recursive: true});
        yield* fs.writeFileString(externalMemory, 'must remain external');
        yield* fs.makeDirectory(path.join(home, 'data'), {recursive: true});
        yield* fs.symlink(external, path.join(home, 'data', 'viking'));
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const eligibility = yield* isThreadnoteStorageLayoutMigrationPending({home}).pipe(Effect.flip);
        const apply = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(Effect.flip);
        expect(eligibility).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(apply).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(yield* fs.readFileString(externalMemory)).toBe('must remain external');
        expect(yield* fs.exists(path.join(home, 'data', 'local'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects a symbolic-link data parent before eligibility or apply can reach external beta data', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-data-link-'});
        const externalData = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-external-data-'});
        const externalMemory = path.join(externalData, 'viking', 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(externalMemory), {recursive: true});
        yield* fs.writeFileString(externalMemory, 'must remain external');
        yield* fs.symlink(externalData, path.join(home, 'data'));
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const eligibility = yield* isThreadnoteStorageLayoutMigrationPending({home}).pipe(Effect.flip);
        const apply = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(Effect.flip);
        expect(eligibility).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(apply).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(yield* fs.readFileString(externalMemory)).toBe('must remain external');
        expect(yield* fs.exists(path.join(externalData, 'local'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects a non-directory legacy root before eligibility or apply can traverse it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-root-file-'});
        const legacyRoot = path.join(home, 'data', 'viking');
        yield* fs.makeDirectory(path.dirname(legacyRoot), {recursive: true});
        yield* fs.writeFileString(legacyRoot, 'not a directory');

        const eligibility = yield* isThreadnoteStorageLayoutMigrationPending({home}).pipe(Effect.flip);
        const apply = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(Effect.flip);
        expect(eligibility).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(apply).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(yield* fs.readFileString(legacyRoot)).toBe('not a directory');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
