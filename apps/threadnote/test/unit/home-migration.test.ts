import {provideTestLayer} from '../helpers/effect-layer.js';
import {expect, it} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Path, Predicate} from 'effect';
import {describe} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  assertSufficientHomeMigrationDiskSpace,
  HomeMigrationInsufficientSpace,
  isLegacyHomeMigrationPending,
  isThreadnoteHomeMigrationPending,
  migrateOpenVikingHome,
  runHomeMigration,
} from '@threadnote/threadnote/migration/home';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

describe('OpenViking home migration', () => {
  it.effect('rejects a staged copy when the target volume cannot hold the source plus margin', () =>
    Effect.gen(function* () {
      const failure = yield* assertSufficientHomeMigrationDiskSpace(100, 1_000).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(HomeMigrationInsufficientSpace);
      expect(failure.requiredBytes).toBeGreaterThan(100);
    }),
  );

  it.effect('keeps empty and runtime-only legacy homes ineligible without creating a target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-eligibility-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(legacyHome, {recursive: true});

        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(false);
        expect(yield* isThreadnoteHomeMigrationPending({legacyHome, targetHome})).toBe(false);
        expect(yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome})).toEqual({
          action: 'no_legacy_content',
        });
        expect(yield* fs.exists(targetHome)).toBe(false);

        for (const directory of [
          path.join(legacyHome, 'share', 'teams'),
          path.join(legacyHome, 'share', 'worktrees'),
          path.join(legacyHome, 'data', 'viking', 'local', 'memories'),
          path.join(legacyHome, 'data', 'viking', 'local', 'resources'),
          path.join(legacyHome, 'data', 'viking', 'local', 'user', 'tester', 'memories'),
        ]) {
          yield* fs.makeDirectory(directory, {recursive: true});
        }
        yield* fs.writeFileString(path.join(legacyHome, 'share', 'teams', '.DS_Store'), 'Finder metadata');
        yield* fs.writeFileString(
          path.join(legacyHome, 'data', 'viking', 'local', 'resources', '._metadata'),
          'AppleDouble metadata',
        );
        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(false);
        expect(yield* isThreadnoteHomeMigrationPending({legacyHome, targetHome})).toBe(false);

        yield* fs.makeDirectory(path.join(legacyHome, 'logs'), {recursive: true});
        yield* fs.writeFileString(path.join(legacyHome, 'logs', 'server.log'), 'runtime noise');
        yield* fs.writeFileString(path.join(legacyHome, 'openviking-server.json'), '{}');
        yield* fs.writeFileString(path.join(legacyHome, 'openviking-server.pid'), '12345\n');
        yield* fs.makeDirectory(path.join(legacyHome, 'threadnote'), {recursive: true});
        yield* fs.writeFileString(path.join(legacyHome, 'threadnote', 'local-ai-token'), 'runtime token');
        yield* fs.makeDirectory(path.join(legacyHome, 'data', 'viking'), {recursive: true});
        yield* fs.writeFileString(path.join(legacyHome, 'data', 'viking', 'backend_meta.json'), '{}');
        yield* fs.makeDirectory(targetHome, {recursive: true});
        yield* fs.writeFileString(
          path.join(targetHome, 'layout.json'),
          `${JSON.stringify({createdBy: 'threadnote', version: 2})}\n`,
        );

        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(false);
        expect(yield* isThreadnoteHomeMigrationPending({legacyHome, targetHome})).toBe(false);
        expect(yield* migrateOpenVikingHome({legacyHome, targetHome})).toEqual({action: 'no_legacy_content'});
        expect(yield* fs.exists(path.join(targetHome, 'layout.json'))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('treats the v3 root server PID as runtime-only migration noise', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-v3-pid-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(legacyHome, {recursive: true});
        yield* fs.writeFileString(path.join(legacyHome, 'openviking-server.pid'), '48291\n');

        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(false);
        expect(yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome})).toEqual({
          action: 'no_legacy_content',
        });
        expect(yield* fs.exists(targetHome)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('probes a wide runtime-only legacy root without enumerating it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-wide-probe-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(legacyHome, {recursive: true});
        yield* fs.writeFileString(path.join(legacyHome, 'openviking-server.pid'), '48291\n');
        let enumeratedRoot = false;
        const wideFileSystem = FileSystem.FileSystem.of({
          ...fs,
          readDirectory: (directory, options) => {
            if (directory === legacyHome) {
              enumeratedRoot = true;
              return Effect.die('eligibility must not materialize a wide root directory');
            }
            return fs.readDirectory(directory, options);
          },
        });

        const pending = yield* isLegacyHomeMigrationPending({legacyHome, targetHome}).pipe(
          Effect.provideService(FileSystem.FileSystem, wideFileSystem),
        );
        expect(pending).toBe(false);
        expect(enumeratedRoot).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('detects canonical content for the configured non-default account and user without enumeration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-custom-account-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const memory = path.join(
          legacyHome,
          'data',
          'viking',
          'custom-account',
          'user',
          'custom-user',
          'memories',
          'durable',
          'context.md',
        );
        yield* fs.makeDirectory(path.dirname(memory), {recursive: true});
        yield* fs.writeFileString(memory, '# Custom account context\n');
        const customSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            THREADNOTE_ACCOUNT: 'custom-account',
            THREADNOTE_USER: 'custom-user',
          }),
        });

        expect(
          yield* isLegacyHomeMigrationPending({legacyHome, targetHome}).pipe(
            Effect.provideService(SystemInfo, customSystem),
          ),
        ).toBe(true);
        expect(
          (yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(
            Effect.provideService(SystemInfo, customSystem),
          )).action,
        ).toBe('migrated');
        expect(
          yield* fs.readFileString(
            path.join(targetHome, 'data', 'custom-account', 'user', 'custom-user', 'memories', 'durable', 'context.md'),
          ),
        ).toContain('Custom account context');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('reports beta-only layout and model recovery without a contradictory legacy-home message', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-beta-output-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const betaMemory = path.join(targetHome, 'data', 'viking', 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(betaMemory), {recursive: true});
        yield* fs.writeFileString(betaMemory, '# Beta memory\n');
        yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const preview = yield* captureConsole(runHomeMigration({legacyHome, targetHome}));
        const applied = yield* captureConsole(runHomeMigration({apply: true, legacyHome, targetHome}));

        const modelHome = path.join(root, '.threadnote-model-only');
        yield* fs.makeDirectory(path.join(modelHome, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(modelHome, 'migration', 'legacy-local-model-v1.json'),
          `${JSON.stringify({id: 'legacy-local-model-v1', models: ['bge-small-en-v1.5-q8'], status: 'pending', version: 1})}\n`,
        );
        const modelPreview = yield* captureConsole(runHomeMigration({legacyHome, targetHome: modelHome}));

        expect(preview.output).toContain('Would migrate 1 account(s)');
        expect(applied.output).toContain('Migrated 1 account(s)');
        expect(modelPreview.output).toContain('Would preserve installed local model(s)');
        for (const output of [preview.output, applied.output, modelPreview.output]) {
          expect(output).not.toContain('No legacy ~/.openviking home');
          expect(output).not.toContain('nothing to migrate');
        }
        expect(yield* fs.readFileString(path.join(targetHome, 'data', 'local', 'memory.md'))).toContain('Beta memory');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('reports completed-receipt layout marker repair without claiming there is nothing to migrate', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-marker-output-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(path.join(targetHome, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(targetHome, 'migration', 'threadnote-storage-layout-v2.json'),
          `${JSON.stringify({
            accounts: [],
            id: 'threadnote-storage-layout-v2',
            sourceLayoutVersion: 1,
            status: 'completed',
            targetLayoutVersion: 2,
            version: 1,
          })}\n`,
        );

        const preview = yield* captureConsole(runHomeMigration({legacyHome, targetHome}));
        const applied = yield* captureConsole(runHomeMigration({apply: true, legacyHome, targetHome}));

        expect(preview.output).toContain('Would restore the current Threadnote storage layout marker');
        expect(applied.output).toContain('Restored the current Threadnote storage layout marker');
        for (const output of [preview.output, applied.output]) {
          expect(output).not.toContain('No legacy ~/.openviking home');
          expect(output).not.toContain('nothing to migrate');
        }
        expect(JSON.parse(yield* fs.readFileString(path.join(targetHome, 'layout.json')))).toEqual({
          createdBy: 'threadnote',
          version: 2,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('recognizes genuine legacy canonical content and completed receipts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-canonical-eligibility-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const memory = path.join(legacyHome, 'data', 'viking', 'local', 'memories', 'context.md');
        yield* fs.makeDirectory(path.dirname(memory), {recursive: true});
        yield* fs.writeFileString(memory, '# Canonical context\n');

        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(true);
        expect(yield* isThreadnoteHomeMigrationPending({legacyHome, targetHome})).toBe(true);
        expect((yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome})).action).toBe('migrated');
        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(false);
        expect(yield* isThreadnoteHomeMigrationPending({legacyHome, targetHome})).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('recognizes beta layout and pending local-model recovery without ~/.openviking', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-beta-home-eligibility-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const betaMemory = path.join(targetHome, 'data', 'viking', 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(betaMemory), {recursive: true});
        yield* fs.writeFileString(betaMemory, '# Beta memory\n');

        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(false);
        expect(yield* isThreadnoteHomeMigrationPending({legacyHome, targetHome})).toBe(true);

        yield* fs.remove(path.join(targetHome, 'data'), {recursive: true});
        yield* fs.makeDirectory(path.join(targetHome, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(targetHome, 'migration', 'legacy-local-model-v1.json'),
          `${JSON.stringify({id: 'legacy-local-model-v1', models: ['bge-small-en-v1.5-q8'], status: 'pending', version: 1})}\n`,
        );
        expect(yield* isThreadnoteHomeMigrationPending({legacyHome, targetHome})).toBe(true);

        yield* fs.writeFileString(
          path.join(targetHome, 'migration', 'legacy-local-model-v1.json'),
          `${JSON.stringify({id: 'legacy-local-model-v1', models: ['bge-small-en-v1.5-q8'], status: 'completed', version: 1})}\n`,
        );
        expect(yield* isThreadnoteHomeMigrationPending({legacyHome, targetHome})).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('dry-runs, validates, promotes, preserves the source, and is idempotent', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-migration-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(false);
        const memory = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'runtime.md',
        );
        yield* fs.makeDirectory(path.dirname(memory), {recursive: true});
        yield* fs.writeFileString(memory, '# Runtime\n\nCanonical memory.\n');
        const contentLock = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'resources',
          'repos',
          'threadnote',
          'Cargo.lock',
        );
        yield* fs.makeDirectory(path.dirname(contentLock), {recursive: true});
        yield* fs.writeFileString(contentLock, 'version = 4\n');
        yield* fs.writeFileString(path.join(legacyHome, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
        yield* fs.makeDirectory(path.join(legacyHome, 'logs'), {recursive: true});
        yield* fs.writeFileString(path.join(legacyHome, 'logs', 'server.log'), 'legacy runtime noise');
        yield* fs.writeFileString(path.join(legacyHome, 'openviking-server.pid'), '48291\n');
        yield* fs.writeFileString(path.join(legacyHome, 'ov.conf'), '{"legacy":true}');

        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(true);
        const preview = yield* migrateOpenVikingHome({legacyHome, targetHome});
        expect(preview.action).toBe('dry_run');
        expect(preview.receipt).toMatchObject({files: 3, legacyHome, targetHome});
        expect(yield* fs.exists(targetHome)).toBe(false);

        const migrated = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(migrated.action).toBe('migrated');
        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(false);
        expect(
          yield* fs.readFileString(
            path.join(
              targetHome,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'runtime.md',
            ),
          ),
        ).toContain('Canonical memory');
        expect(yield* fs.exists(path.join(targetHome, 'seed-manifest.yaml'))).toBe(true);
        expect(
          yield* fs.readFileString(
            path.join(targetHome, 'data', 'local', 'resources', 'repos', 'threadnote', 'Cargo.lock'),
          ),
        ).toContain('version = 4');
        expect(yield* fs.exists(path.join(targetHome, 'logs', 'server.log'))).toBe(false);
        expect(yield* fs.exists(path.join(targetHome, 'openviking-server.pid'))).toBe(false);
        expect(yield* fs.exists(path.join(targetHome, 'ov.conf'))).toBe(false);
        expect(yield* fs.readFileString(memory)).toContain('Canonical memory');

        const receipt = parseMigrationReceipt(
          yield* fs.readFileString(path.join(targetHome, 'migration', 'openviking-home-v1.json')),
        );
        expect(receipt.sourceTreeSha256).toMatch(/^[0-9a-f]{64}$/);

        const repeated = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(repeated.action).toBe('already_migrated');
        expect(repeated.receipt?.sourceTreeSha256).toBe(receipt.sourceTreeSha256);

        const interruptedStage = path.join(root, '.threadnote.migrate-interrupted');
        yield* fs.rename(targetHome, interruptedStage);
        const resumed = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(resumed.action).toBe('resumed');
        expect(yield* fs.exists(interruptedStage)).toBe(false);
        expect(yield* fs.exists(targetHome)).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('does not promote a resumable stage after the legacy source changes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-stale-resume-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const source = path.join(legacyHome, 'data', 'viking', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFileString(source, 'first canonical value');
        expect((yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome})).action).toBe('migrated');

        const interruptedStage = path.join(root, '.threadnote.migrate-interrupted');
        yield* fs.rename(targetHome, interruptedStage);
        yield* fs.writeFileString(source, 'newer canonical value');

        const resumed = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(resumed.action).toBe('migrated');
        expect(
          yield* fs.readFileString(
            path.join(targetHome, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md'),
          ),
        ).toBe('newer canonical value');
        expect(yield* fs.exists(interruptedStage)).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('refuses to overwrite an unrelated target home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-conflict-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(legacyHome);
        yield* fs.makeDirectory(targetHome);
        yield* fs.writeFileString(path.join(targetHome, 'unrelated.txt'), 'keep');
        const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);
        expect(error._tag).toBe('HomeMigrationConflict');
        expect(yield* fs.readFileString(path.join(targetHome, 'unrelated.txt'))).toBe('keep');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('does not treat generic Threadnote-like directory names as an owned target home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-generic-marker-conflict-'});
        const legacyHome = path.join(root, '.openviking');
        yield* fs.makeDirectory(legacyHome);
        for (const marker of ['cache', 'data', 'indexes', 'models', 'share', 'threadnote']) {
          const targetHome = path.join(root, `.threadnote-${marker}`);
          const sentinel = path.join(targetHome, marker, 'sentinel.txt');
          yield* fs.makeDirectory(path.dirname(sentinel), {recursive: true});
          yield* fs.writeFileString(sentinel, `preserve-${marker}`);

          const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);

          expect(error._tag).toBe('HomeMigrationConflict');
          expect(yield* fs.readFileString(sentinel)).toBe(`preserve-${marker}`);
          expect(yield* fs.readDirectory(targetHome)).toEqual([marker]);
          expect(yield* fs.readDirectory(path.join(targetHome, marker))).toEqual(['sentinel.txt']);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('requires a strong ownership receipt before recovering into an existing target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-weak-marker-conflict-'});
        const legacyHome = path.join(root, '.openviking');
        yield* fs.makeDirectory(legacyHome);
        const cases = [
          {content: '{"createdBy":', name: 'malformed-layout', relativePath: 'layout.json'},
          {
            content: '{"createdBy":"another-tool","version":2}',
            name: 'unowned-layout',
            relativePath: 'layout.json',
          },
          {
            content: '{"id":',
            name: 'malformed-storage-receipt',
            relativePath: 'migration/threadnote-storage-layout-v2.json',
          },
          {
            content: '{"id":"threadnote-storage-layout-v2","version":1}',
            name: 'incomplete-storage-receipt',
            relativePath: 'migration/threadnote-storage-layout-v2.json',
          },
          {
            content: '{"version":1,"roles":{}}',
            name: 'model-selection',
            relativePath: 'models/selection.json',
          },
          {
            content: '{"version":1,"teams":{}}',
            name: 'share-config',
            relativePath: 'share/teams.json',
          },
          {
            content: 'unowned resource bytes',
            name: 'canonical-looking-data',
            relativePath: 'data/local/resources/sentinel.txt',
          },
        ] as const;

        for (const fixture of cases) {
          const targetHome = path.join(root, `.threadnote-${fixture.name}`);
          const marker = path.join(targetHome, fixture.relativePath);
          yield* fs.makeDirectory(path.dirname(marker), {recursive: true});
          yield* fs.writeFileString(marker, fixture.content);
          const before = yield* snapshotDirectory(fs, path, targetHome);

          const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);

          expect(error._tag).toBe('HomeMigrationConflict');
          expect(yield* snapshotDirectory(fs, path, targetHome)).toEqual(before);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('recovers into an empty beta home without copying server metadata or overwriting generated state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-recovery-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const source = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'recovery.md',
        );
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFileString(source, '# Recovered memory\n');
        const legacyCurrent = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'handoffs',
          'active',
          'threadnote',
          'current.md',
        );
        const betaCurrent = path.join(
          targetHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'handoffs',
          'active',
          'threadnote',
          'current.md',
        );
        yield* fs.makeDirectory(path.dirname(legacyCurrent), {recursive: true});
        yield* fs.writeFileString(legacyCurrent, '# Legacy handoff\n');
        yield* fs.makeDirectory(path.dirname(betaCurrent), {recursive: true});
        yield* fs.writeFileString(betaCurrent, '# Current beta handoff\n');
        yield* fs.writeFileString(path.join(legacyHome, 'data', 'viking', 'backend_meta.json'), '{"server":true}');
        const legacyUpdateCache = '{"channel":"stable","latestVersion":"3.0.3"}';
        const betaUpdateCache = '{"channel":"beta","latestVersion":"4.0.0-beta.9"}';
        yield* fs.writeFileString(path.join(legacyHome, 'update-check.json'), legacyUpdateCache);
        yield* fs.makeDirectory(path.join(targetHome, 'cache'), {recursive: true});
        yield* fs.makeDirectory(path.join(targetHome, 'data', 'local'), {recursive: true});
        yield* fs.writeFileString(path.join(targetHome, 'cache', 'recall.json'), 'derived beta state');
        yield* fs.writeFileString(path.join(targetHome, 'update-check.json'), betaUpdateCache);

        const result = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(result.action).toBe('recovered');
        expect(result.receipt?.files).toBe(2);
        expect(
          yield* fs.readFileString(
            path.join(
              targetHome,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'recovery.md',
            ),
          ),
        ).toContain('Recovered memory');
        expect(yield* fs.readFileString(path.join(targetHome, 'cache', 'recall.json'))).toBe('derived beta state');
        expect(yield* fs.readFileString(path.join(targetHome, 'update-check.json'))).toBe(betaUpdateCache);
        expect(
          yield* fs.readFileString(
            path.join(
              targetHome,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'handoffs',
              'active',
              'threadnote',
              'current.md',
            ),
          ),
        ).toContain('Current beta handoff');
        expect(yield* fs.exists(path.join(targetHome, 'data', 'backend_meta.json'))).toBe(false);
        expect(
          yield* fs.exists(
            path.join(
              targetHome,
              'data',
              'viking',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'recovery.md',
            ),
          ),
        ).toBe(false);
        expect(yield* fs.readFileString(source)).toContain('Recovered memory');
        expect(yield* fs.readFileString(path.join(legacyHome, 'update-check.json'))).toBe(legacyUpdateCache);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('preserves newer canonical content when recovering into a current-layout beta home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-current-content-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const relativeMemory = path.join(
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'front-end-web-monorepo',
          'aspect-checkout-mvp-api.md',
        );
        const legacyMemory = path.join(legacyHome, 'data', 'viking', relativeMemory);
        const targetMemory = path.join(targetHome, 'data', relativeMemory);
        const legacyOnly = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'legacy-only.md',
        );
        yield* fs.makeDirectory(path.dirname(legacyMemory), {recursive: true});
        yield* fs.writeFileString(legacyMemory, '# Older legacy memory\n');
        yield* fs.makeDirectory(path.dirname(legacyOnly), {recursive: true});
        yield* fs.writeFileString(legacyOnly, '# Legacy-only memory\n');
        yield* fs.makeDirectory(path.dirname(targetMemory), {recursive: true});
        yield* fs.writeFileString(targetMemory, '# Newer beta memory\n');
        yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const preview = yield* migrateOpenVikingHome({legacyHome, targetHome});
        expect(preview.action).toBe('dry_run');
        expect(preview.receipt?.preservedCurrentEntries).toBe(1);
        expect(yield* fs.readFileString(targetMemory)).toBe('# Newer beta memory\n');
        expect(yield* fs.exists(path.join(targetHome, 'migration', 'openviking-home-v1.json'))).toBe(false);

        const result = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});

        expect(result.action).toBe('recovered');
        expect(result.receipt?.preservedCurrentEntries).toBe(1);
        expect(yield* fs.readFileString(targetMemory)).toBe('# Newer beta memory\n');
        expect(
          yield* fs.readFileString(
            path.join(
              targetHome,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'legacy-only.md',
            ),
          ),
        ).toBe('# Legacy-only memory\n');
        expect(yield* fs.readFileString(legacyMemory)).toBe('# Older legacy memory\n');
        expect((yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome})).action).toBe('already_migrated');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('still rejects different non-canonical content in a recoverable target home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-config-conflict-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(legacyHome);
        yield* fs.makeDirectory(targetHome);
        yield* fs.writeFileString(path.join(legacyHome, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
        yield* fs.writeFileString(
          path.join(targetHome, 'seed-manifest.yaml'),
          'version: 1\nprojects:\n  - root: current\n',
        );
        yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);

        expect(error._tag).toBe('HomeMigrationConflict');
        expect(yield* fs.readFileString(path.join(targetHome, 'seed-manifest.yaml'))).toContain('root: current');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects every incomplete current managed-share checkout shape before copying', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-share-config-conflict-'});
        const legacyHome = path.join(root, '.openviking');
        const relativeConfig = path.join('share', 'teams', 'default.gitdir', 'config');
        const legacyConfig = path.join(legacyHome, relativeConfig);
        yield* fs.makeDirectory(path.dirname(legacyConfig), {recursive: true});
        yield* fs.writeFileString(legacyConfig, '[remote "origin"]\n\turl = legacy\n');

        for (const scenario of [
          {gitdir: true, head: true, name: 'gitdir-only', worktree: false, worktreeFile: false},
          {gitdir: false, head: false, name: 'worktree-only', worktree: true, worktreeFile: false},
          {gitdir: true, head: false, name: 'missing-head', worktree: true, worktreeFile: false},
          {gitdir: true, head: true, name: 'unsafe-worktree-type', worktree: false, worktreeFile: true},
        ]) {
          const targetHome = path.join(root, `.threadnote-${scenario.name}`);
          const currentGitdir = path.join(targetHome, 'share', 'teams', 'default.gitdir');
          const currentWorktree = path.join(targetHome, 'share', 'worktrees', 'default');
          const currentConfig = path.join(currentGitdir, 'config');
          if (scenario.gitdir) {
            yield* fs.makeDirectory(currentGitdir, {recursive: true});
            yield* fs.writeFileString(currentConfig, `[current]\n\tshape = ${scenario.name}\n`);
            if (scenario.head) {
              yield* fs.writeFileString(path.join(currentGitdir, 'HEAD'), 'ref: refs/heads/current\n');
            }
          }
          if (scenario.worktree) {
            yield* fs.makeDirectory(currentWorktree, {recursive: true});
            yield* fs.writeFileString(path.join(currentWorktree, '.git'), `gitdir: ${currentGitdir}\n`);
          } else if (scenario.worktreeFile) {
            yield* fs.makeDirectory(path.dirname(currentWorktree), {recursive: true});
            yield* fs.writeFileString(currentWorktree, 'not a managed-share worktree directory');
          }
          yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

          const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);

          expect(error._tag).toBe('HomeMigrationConflict');
          expect(error.message).toContain('managed share checkout is incomplete or unsafe');
          if (scenario.gitdir) {
            expect(yield* fs.readFileString(currentConfig)).toContain(`shape = ${scenario.name}`);
          }
          expect(yield* fs.exists(path.join(targetHome, 'migration', 'openviking-home-v1.json'))).toBe(false);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('recovers every provable legacy-derived partial managed-share checkout shape', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-partial-share-recovery-'});

        for (const scenario of [
          'gitdir-prefix-without-head',
          'gitdir-with-head-without-worktree',
          'worktree-with-current-marker',
          'worktree-with-legacy-marker',
          'worktree-already-standard',
          'nonstandard-source-gitdir',
          'rewritten-config-and-partial-worktree',
        ] as const) {
          const legacyHome = path.join(root, scenario, '.openviking');
          const targetHome = path.join(root, scenario, '.threadnote');
          const legacyGitdir = path.join(
            legacyHome,
            'share',
            'teams',
            scenario === 'nonstandard-source-gitdir' ? 'legacy.gitdir' : 'default.gitdir',
          );
          const legacyWorktree =
            scenario === 'worktree-already-standard'
              ? path.join(legacyHome, 'share', 'worktrees', 'default')
              : path.join(legacyHome, 'data', 'viking', 'local', 'user', 'tester', 'memories', 'shared', 'default');
          const currentGitdir = path.join(targetHome, 'share', 'teams', 'default.gitdir');
          const currentWorktree = path.join(targetHome, 'share', 'worktrees', 'default');
          const memoryRelative = path.join('durable', 'projects', 'threadnote', 'legacy-unpublished.md');
          const unpublishedCommit = '0123456789abcdef0123456789abcdef01234567';
          const legacyConfig = `[core]\n\tworktree = ${legacyWorktree}\n[remote "origin"]\n\turl = git@example.invalid:team/memories.git\n`;

          yield* fs.makeDirectory(path.dirname(path.join(legacyWorktree, memoryRelative)), {recursive: true});
          yield* fs.writeFileString(path.join(legacyWorktree, memoryRelative), '# Legacy unpublished memory\n');
          yield* fs.writeFileString(path.join(legacyWorktree, '.git'), `gitdir: ${legacyGitdir}\n`);
          const legacyGitState = new Map<string, string>([
            ['HEAD', 'ref: refs/heads/main\n'],
            ['config', legacyConfig],
            ['FETCH_HEAD', 'legacy transient fetch state\n'],
            ['index', 'legacy staged state'],
            ['refs/heads/main', `${unpublishedCommit}\n`],
            [
              `objects/${Effect2.pipe(unpublishedCommit, EffectString.slice(0, 2))}/${Effect2.pipe(unpublishedCommit, EffectString.slice(2))}`,
              'unpublished object',
            ],
          ]);
          for (const [relativePath, content] of legacyGitState) {
            const file = path.join(legacyGitdir, relativePath);
            yield* fs.makeDirectory(path.dirname(file), {recursive: true});
            yield* fs.writeFileString(file, content);
          }
          yield* fs.makeDirectory(path.join(legacyHome, 'share'), {recursive: true});
          yield* fs.writeFileString(
            path.join(legacyHome, 'share', 'teams.json'),
            `${JSON.stringify(
              {
                defaultTeam: 'default',
                teams: {
                  default: {
                    addedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
                    gitdir: legacyGitdir,
                    name: 'default',
                    remote: 'git@example.invalid:team/memories.git',
                    worktree: legacyWorktree,
                  },
                },
                version: 1,
              },
              null,
              2,
            )}\n`,
          );
          yield* fs.makeDirectory(targetHome, {recursive: true});
          yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

          if (
            scenario === 'gitdir-prefix-without-head' ||
            scenario === 'gitdir-with-head-without-worktree' ||
            scenario === 'nonstandard-source-gitdir' ||
            scenario === 'rewritten-config-and-partial-worktree'
          ) {
            yield* fs.makeDirectory(currentGitdir, {recursive: true});
            yield* fs.writeFileString(
              path.join(currentGitdir, 'config'),
              scenario === 'rewritten-config-and-partial-worktree'
                ? Effect2.pipe(
                    legacyConfig,
                    EffectString.replaceAll(legacyWorktree, currentWorktree),
                    EffectString.replaceAll(legacyGitdir, currentGitdir),
                  )
                : legacyConfig,
            );
          }
          if (scenario === 'gitdir-with-head-without-worktree') {
            yield* fs.writeFileString(path.join(currentGitdir, 'HEAD'), 'ref: refs/heads/main\n');
            yield* fs.writeFileString(path.join(currentGitdir, 'FETCH_HEAD'), 'different current transient state\n');
            yield* fs.makeDirectory(path.join(currentGitdir, 'reftable'), {recursive: true});
            yield* fs.writeFileString(
              path.join(currentGitdir, 'reftable', 'tables.list.lock'),
              'nested transient lock state\n',
            );
          }
          if (
            scenario === 'worktree-with-current-marker' ||
            scenario === 'worktree-with-legacy-marker' ||
            scenario === 'worktree-already-standard' ||
            scenario === 'rewritten-config-and-partial-worktree'
          ) {
            yield* fs.makeDirectory(path.dirname(path.join(currentWorktree, memoryRelative)), {recursive: true});
            yield* fs.writeFileString(path.join(currentWorktree, memoryRelative), '# Legacy unpublished memory\n');
            yield* fs.writeFileString(
              path.join(currentWorktree, '.git'),
              `gitdir: ${scenario === 'worktree-with-legacy-marker' ? legacyGitdir : currentGitdir}\n`,
            );
          }
          if (scenario === 'gitdir-prefix-without-head') {
            const staleCopy = path.join(targetHome, 'migration', '.openviking-home-v1-share-copy', 'stale-copy');
            yield* fs.makeDirectory(path.dirname(staleCopy), {recursive: true});
            yield* fs.writeFileString(staleCopy, 'interrupted prior copy');
          }

          const result = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});

          expect(result.action).toBe('recovered');
          expect(yield* fs.readFileString(path.join(currentWorktree, '.git'))).toBe(`gitdir: ${currentGitdir}\n`);
          expect(yield* fs.readFileString(path.join(currentWorktree, memoryRelative))).toBe(
            '# Legacy unpublished memory\n',
          );
          expect(yield* fs.readFileString(path.join(currentGitdir, 'HEAD'))).toBe('ref: refs/heads/main\n');
          expect(yield* fs.readFileString(path.join(currentGitdir, 'index'))).toBe('legacy staged state');
          expect(yield* fs.exists(path.join(currentGitdir, 'FETCH_HEAD'))).toBe(false);
          expect(yield* fs.exists(path.join(currentGitdir, 'reftable'))).toBe(false);
          expect(yield* fs.exists(path.join(targetHome, 'migration', '.openviking-home-v1-share-copy'))).toBe(false);
          expect(
            yield* fs.readFileString(
              path.join(
                currentGitdir,
                'objects',
                Effect2.pipe(unpublishedCommit, EffectString.slice(0, 2)),
                Effect2.pipe(unpublishedCommit, EffectString.slice(2)),
              ),
            ),
          ).toBe('unpublished object');
          expect(yield* fs.readFileString(path.join(currentGitdir, 'config'))).toContain(
            `worktree = ${currentWorktree}`,
          );
          const teams = parseDefaultShareGitPaths(
            yield* fs.readFileString(path.join(targetHome, 'share', 'teams.json')),
          );
          expect(teams.teams.default).toMatchObject({gitdir: currentGitdir, worktree: currentWorktree});
          expect(yield* fs.readFileString(path.join(legacyGitdir, 'config'))).toBe(legacyConfig);
          expect(yield* fs.readFileString(path.join(legacyGitdir, 'FETCH_HEAD'))).toBe(
            'legacy transient fetch state\n',
          );
          expect(yield* fs.readFileString(path.join(legacyWorktree, '.git'))).toBe(`gitdir: ${legacyGitdir}\n`);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects partial managed-share state that is not a subset of the preserved legacy repository', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-divergent-partial-share-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const legacyGitdir = path.join(legacyHome, 'share', 'teams', 'default.gitdir');
        const legacyWorktree = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'shared',
          'default',
        );
        const currentGitdir = path.join(targetHome, 'share', 'teams', 'default.gitdir');
        const currentOnlyObject = path.join(currentGitdir, 'objects', 'ff', 'current-only');
        yield* fs.makeDirectory(legacyGitdir, {recursive: true});
        yield* fs.makeDirectory(legacyWorktree, {recursive: true});
        yield* fs.writeFileString(path.join(legacyGitdir, 'HEAD'), 'ref: refs/heads/main\n');
        yield* fs.writeFileString(path.join(legacyGitdir, 'config'), `[core]\n\tworktree = ${legacyWorktree}\n`);
        yield* fs.makeDirectory(path.join(legacyGitdir, 'hooks'), {recursive: true});
        yield* fs.writeFileString(path.join(legacyGitdir, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', {mode: 0o600});
        yield* fs.writeFileString(path.join(legacyWorktree, '.git'), `gitdir: ${legacyGitdir}\n`);
        yield* fs.makeDirectory(path.join(legacyHome, 'share'), {recursive: true});
        yield* fs.writeFileString(
          path.join(legacyHome, 'share', 'teams.json'),
          `${JSON.stringify({
            defaultTeam: 'default',
            teams: {
              default: {
                gitdir: legacyGitdir,
                name: 'default',
                remote: 'git@example.invalid:team/memories.git',
                worktree: legacyWorktree,
              },
            },
            version: 1,
          })}\n`,
        );
        yield* fs.makeDirectory(path.dirname(currentOnlyObject), {recursive: true});
        yield* fs.writeFileString(path.join(currentGitdir, 'config'), `[core]\n\tworktree = ${legacyWorktree}\n`);
        yield* fs.writeFileString(currentOnlyObject, 'possibly unpublished current state');
        yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);

        expect(error._tag).toBe('HomeMigrationConflict');
        expect(error.message).toContain('does not match the preserved legacy repository');
        expect(yield* fs.readFileString(currentOnlyObject)).toBe('possibly unpublished current state');
        expect(yield* fs.exists(path.join(targetHome, 'migration', 'openviking-home-v1.json'))).toBe(false);

        if (system.platform !== 'win32') {
          const modeTargetHome = path.join(root, '.threadnote-mode-divergence');
          const modeCurrentGitdir = path.join(modeTargetHome, 'share', 'teams', 'default.gitdir');
          const currentHook = path.join(modeCurrentGitdir, 'hooks', 'pre-commit');
          yield* fs.makeDirectory(path.dirname(currentHook), {recursive: true});
          yield* fs.writeFileString(path.join(modeCurrentGitdir, 'config'), `[core]\n\tworktree = ${legacyWorktree}\n`);
          yield* fs.writeFileString(currentHook, '#!/bin/sh\nexit 0\n', {mode: 0o700});
          yield* fs.writeFileString(
            path.join(modeTargetHome, 'layout.json'),
            '{"createdBy":"threadnote","version":2}\n',
          );

          const modeError = yield* migrateOpenVikingHome({
            apply: true,
            legacyHome,
            targetHome: modeTargetHome,
          }).pipe(Effect.flip);

          expect(modeError._tag).toBe('HomeMigrationConflict');
          expect(modeError.message).toContain('does not match the preserved legacy repository');
          expect((yield* fs.stat(currentHook)).mode & 0o100).toBe(0o100);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects a current share worktree that points at a different Git directory', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-share-marker-conflict-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const legacyGitdir = path.join(legacyHome, 'share', 'teams', 'default.gitdir');
        const currentGitdir = path.join(targetHome, 'share', 'teams', 'default.gitdir');
        const currentWorktree = path.join(targetHome, 'share', 'worktrees', 'default');
        yield* fs.makeDirectory(legacyGitdir, {recursive: true});
        yield* fs.writeFileString(path.join(legacyGitdir, 'HEAD'), 'ref: refs/heads/main\n');
        yield* fs.makeDirectory(currentGitdir, {recursive: true});
        yield* fs.writeFileString(path.join(currentGitdir, 'HEAD'), 'ref: refs/heads/current\n');
        yield* fs.makeDirectory(currentWorktree, {recursive: true});
        yield* fs.writeFileString(path.join(currentWorktree, '.git'), 'gitdir: ../different.gitdir\n');
        yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);

        expect(error._tag).toBe('HomeMigrationConflict');
        expect(error.message).toContain('does not point at its registered Git directory');
        expect(yield* fs.readFileString(path.join(currentGitdir, 'HEAD'))).toBe('ref: refs/heads/current\n');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('migrates the complete legacy share repository when no current checkout exists', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-new-share-recovery-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const legacyWorktree = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'shared',
          'default',
        );
        const legacyGitdir = path.join(legacyHome, 'share', 'teams', 'default.gitdir');
        const legacyCommit = '0123456789abcdef0123456789abcdef01234567';
        const memoryRelative = path.join('durable', 'projects', 'threadnote', 'legacy-share.md');
        yield* fs.makeDirectory(path.dirname(path.join(legacyWorktree, memoryRelative)), {recursive: true});
        yield* fs.writeFileString(path.join(legacyWorktree, memoryRelative), '# Legacy unpublished share\n');
        yield* fs.writeFileString(path.join(legacyWorktree, '.git'), `gitdir: ${legacyGitdir}\n`);
        const legacyState = new Map<string, string>([
          ['HEAD', 'ref: refs/heads/main\n'],
          ['config', `[core]\n\tworktree = ${legacyWorktree}\n`],
          ['index', 'legacy staged state'],
          ['refs/heads/main', `${legacyCommit}\n`],
          ['logs/HEAD', 'legacy HEAD reflog\n'],
          [
            `objects/${Effect2.pipe(legacyCommit, EffectString.slice(0, 2))}/${Effect2.pipe(legacyCommit, EffectString.slice(2))}`,
            'legacy unpublished object',
          ],
          ['future-git-extension/state', 'legacy extension state\n'],
        ]);
        for (const [relativePath, content] of legacyState) {
          const file = path.join(legacyGitdir, relativePath);
          yield* fs.makeDirectory(path.dirname(file), {recursive: true});
          yield* fs.writeFileString(file, content);
        }
        yield* fs.makeDirectory(path.join(legacyHome, 'share'), {recursive: true});
        yield* fs.writeFileString(
          path.join(legacyHome, 'share', 'teams.json'),
          `${JSON.stringify(
            {
              defaultTeam: 'default',
              teams: {
                default: {
                  addedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
                  gitdir: legacyGitdir,
                  name: 'default',
                  remote: 'git@example.invalid:team/memories.git',
                  worktree: legacyWorktree,
                },
              },
              version: 1,
            },
            null,
            2,
          )}\n`,
        );
        yield* fs.makeDirectory(targetHome, {recursive: true});
        yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const result = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        const migratedGitdir = path.join(targetHome, 'share', 'teams', 'default.gitdir');
        const migratedWorktree = path.join(targetHome, 'share', 'worktrees', 'default');

        expect(result.action).toBe('recovered');
        expect(result.receipt?.preservedCurrentEntries).toBeUndefined();
        expect(yield* fs.readFileString(path.join(migratedWorktree, '.git'))).toBe(`gitdir: ${migratedGitdir}\n`);
        expect(yield* fs.readFileString(path.join(migratedGitdir, 'config'))).toContain(
          `worktree = ${migratedWorktree}`,
        );
        expect(yield* fs.readFileString(path.join(migratedGitdir, 'refs', 'heads', 'main'))).toBe(`${legacyCommit}\n`);
        expect(yield* fs.readFileString(path.join(migratedGitdir, 'logs', 'HEAD'))).toBe('legacy HEAD reflog\n');
        expect(
          yield* fs.readFileString(
            path.join(
              migratedGitdir,
              'objects',
              Effect2.pipe(legacyCommit, EffectString.slice(0, 2)),
              Effect2.pipe(legacyCommit, EffectString.slice(2)),
            ),
          ),
        ).toBe('legacy unpublished object');
        expect(yield* fs.readFileString(path.join(migratedGitdir, 'future-git-extension', 'state'))).toBe(
          'legacy extension state\n',
        );
        expect(yield* fs.readFileString(path.join(legacyGitdir, 'index'))).toBe('legacy staged state');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('ignores mutable operating-system metadata while recovering into an existing beta home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-os-metadata-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const sourceMemory = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'metadata.md',
        );
        yield* fs.makeDirectory(path.dirname(sourceMemory), {recursive: true});
        yield* fs.writeFileString(sourceMemory, '# Real content\n');
        yield* fs.writeFileString(path.join(legacyHome, 'data', '.DS_Store'), 'mutable legacy metadata');
        yield* fs.writeFileString(path.join(legacyHome, 'data', '._metadata.md'), 'appledouble metadata');
        yield* fs.writeFileString(path.join(legacyHome, 'data', 'Thumbs.db'), 'Windows thumbnail metadata');
        yield* fs.writeFileString(path.join(legacyHome, 'data', 'desktop.ini'), 'Windows folder metadata');
        yield* fs.makeDirectory(path.join(targetHome, 'data', 'viking'), {recursive: true});
        yield* fs.writeFileString(path.join(targetHome, 'data', '.DS_Store'), 'newer Finder metadata');

        const result = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});

        expect(result.action).toBe('recovered');
        expect(result.receipt?.files).toBe(1);
        expect(
          yield* fs.readFileString(
            path.join(
              targetHome,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'metadata.md',
            ),
          ),
        ).toContain('Real content');
        expect(yield* fs.readFileString(path.join(targetHome, 'data', '.DS_Store'))).toBe('newer Finder metadata');
        expect(yield* fs.exists(path.join(targetHome, 'data', '._metadata.md'))).toBe(false);
        expect(yield* fs.exists(path.join(targetHome, 'data', 'Thumbs.db'))).toBe(false);
        expect(yield* fs.exists(path.join(targetHome, 'data', 'desktop.ini'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('preserves a complete current managed-share repository as one authority boundary', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-share-migration-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const legacyWorktree = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'shared',
          'default',
        );
        const legacyGitdir = path.join(legacyHome, 'share', 'teams', 'default.gitdir');
        const memoryRelative = path.join('durable', 'projects', 'threadnote', 'storage.md');
        yield* fs.makeDirectory(path.dirname(path.join(legacyWorktree, memoryRelative)), {recursive: true});
        yield* fs.makeDirectory(legacyGitdir, {recursive: true});
        yield* fs.writeFileString(path.join(legacyWorktree, memoryRelative), '# Shared storage contract\n');
        yield* fs.writeFileString(path.join(legacyWorktree, '.git'), `gitdir: ${legacyGitdir}\n`);
        yield* fs.writeFileString(
          path.join(legacyGitdir, 'config'),
          `[core]\n\tworktree = ${legacyWorktree}\n[remote "origin"]\n\turl = git@example.invalid:team/memories.git\n`,
        );
        yield* fs.writeFileString(path.join(legacyGitdir, 'HEAD'), 'ref: refs/heads/main\n');
        const legacyIndex = 'legacy staged share state';
        yield* fs.writeFileString(path.join(legacyGitdir, 'index'), legacyIndex);
        const unpublishedCommit = '0123456789abcdef0123456789abcdef01234567';
        const unpublishedObject = path.join(
          legacyGitdir,
          'objects',
          '01',
          Effect2.pipe(unpublishedCommit, EffectString.slice(2)),
        );
        yield* fs.makeDirectory(path.dirname(unpublishedObject), {recursive: true});
        yield* fs.writeFileString(unpublishedObject, 'unpublished commit object');
        yield* fs.makeDirectory(path.join(legacyGitdir, 'refs', 'heads'), {recursive: true});
        yield* fs.writeFileString(path.join(legacyGitdir, 'refs', 'heads', 'main'), `${unpublishedCommit}\n`);
        yield* fs.makeDirectory(path.join(legacyGitdir, 'logs', 'refs', 'heads'), {recursive: true});
        yield* fs.writeFileString(path.join(legacyGitdir, 'logs', 'HEAD'), 'legacy HEAD reflog\n');
        yield* fs.writeFileString(path.join(legacyGitdir, 'logs', 'refs', 'heads', 'main'), 'legacy branch reflog\n');
        yield* fs.writeFileString(path.join(legacyGitdir, 'ORIG_HEAD'), `${unpublishedCommit}\n`);
        yield* fs.writeFileString(path.join(legacyGitdir, 'packed-refs'), `${unpublishedCommit} refs/tags/legacy\n`);
        yield* fs.writeFileString(path.join(legacyGitdir, 'legacy-only-extension'), 'legacy extension state\n');
        yield* fs.writeFileString(
          path.join(legacyGitdir, 'FETCH_HEAD'),
          `${unpublishedCommit}\tnot-for-merge\tbranch 'main' of git@example.invalid:team/memories.git\n`,
        );
        yield* fs.writeFileString(path.join(legacyGitdir, 'COMMIT_EDITMSG'), 'Unpublished shared memory\n');
        yield* fs.writeFileString(path.join(legacyGitdir, 'gc.log'), 'Background maintenance output\n');
        yield* fs.writeFileString(path.join(legacyGitdir, 'index.lock'), 'transient index lock');
        yield* fs.writeFileString(path.join(legacyGitdir, 'refs', 'heads', 'main.lock'), 'transient ref lock');
        yield* fs.makeDirectory(path.join(legacyHome, 'share'), {recursive: true});
        yield* fs.writeFileString(
          path.join(legacyHome, 'share', 'teams.json'),
          `${JSON.stringify(
            {
              defaultTeam: 'default',
              teams: {
                default: {
                  addedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
                  gitdir: legacyGitdir,
                  name: 'default',
                  remote: 'git@example.invalid:team/memories.git',
                  worktree: legacyWorktree,
                },
              },
              version: 1,
            },
            null,
            2,
          )}\n`,
        );
        yield* fs.makeDirectory(path.join(targetHome, 'cache'), {recursive: true});
        yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":1}\n');
        const currentGitdir = path.join(targetHome, 'share', 'teams', 'default.gitdir');
        const currentWorktree = path.join(targetHome, 'share', 'worktrees', 'default');
        yield* fs.makeDirectory(currentGitdir, {recursive: true});
        yield* fs.makeDirectory(path.dirname(path.join(currentWorktree, memoryRelative)), {recursive: true});
        yield* fs.writeFileString(path.join(currentWorktree, memoryRelative), '# Shared storage contract\n');
        const relativeCurrentGitdir = path.relative(currentWorktree, currentGitdir);
        yield* fs.writeFileString(path.join(currentWorktree, '.git'), `gitdir: ${relativeCurrentGitdir}\n`);
        const currentCommit = 'fedcba9876543210fedcba9876543210fedcba98';
        const currentState = new Map<string, string>([
          ['HEAD', 'ref: refs/heads/current\n'],
          [
            'config',
            `[core]\n\tworktree = ${currentWorktree}\n[remote "origin"]\n\turl = git@example.invalid:team/current.git\n`,
          ],
          ['index', 'current beta staged share state'],
          [`sharedindex.${currentCommit}`, 'current split-index state'],
          ['packed-refs', `${currentCommit} refs/tags/current\n`],
          ['refs/heads/main', `${currentCommit}\n`],
          ['logs/HEAD', 'current HEAD reflog\n'],
          ['logs/refs/heads/main', 'current branch reflog\n'],
          ['ORIG_HEAD', `${currentCommit}\n`],
          ['MERGE_HEAD', `${currentCommit}\n`],
          ['rebase-merge/done', 'pick current\n'],
          ['sequencer/todo', 'pick current\n'],
          [
            `objects/${Effect2.pipe(currentCommit, EffectString.slice(0, 2))}/${Effect2.pipe(currentCommit, EffectString.slice(2))}`,
            'current unpublished object',
          ],
          ['objects/pack/pack-current.pack', 'current pack'],
          ['info/exclude', 'current exclusion\n'],
          ['hooks/pre-commit', '#!/bin/sh\nexit 0\n'],
          ['worktrees/linked/gitdir', '/current/linked/worktree/.git\n'],
          ['COMMIT_EDITMSG', 'Current beta share operation\n'],
          ['FETCH_HEAD', `${currentCommit}\tnot-for-merge\tbranch 'main' of current\n`],
          ['gc.log', 'current maintenance output\n'],
          ['index.lock', 'current operation lock'],
          ['future-git-extension/state', 'current extension state\n'],
        ]);
        for (const [relativePath, content] of currentState) {
          const file = path.join(currentGitdir, relativePath);
          yield* fs.makeDirectory(path.dirname(file), {recursive: true});
          yield* fs.writeFileString(file, content);
        }

        const result = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(result.action).toBe('recovered');
        expect(result.receipt?.preservedCurrentEntries).toBe(1);
        expect(result.receipt?.stagedTreeSha256).toMatch(/^[0-9a-f]{64}$/);

        const canonicalMemory = path.join(
          targetHome,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'shared',
          'default',
          memoryRelative,
        );
        const migratedWorktree = path.join(targetHome, 'share', 'worktrees', 'default');
        const migratedGitdir = path.join(targetHome, 'share', 'teams', 'default.gitdir');
        expect(yield* fs.readFileString(canonicalMemory)).toContain('Shared storage contract');
        expect(yield* fs.exists(path.join(path.dirname(canonicalMemory), '..', '..', '..', '.git'))).toBe(false);
        expect(yield* fs.readFileString(path.join(migratedWorktree, memoryRelative))).toContain(
          'Shared storage contract',
        );
        expect(yield* fs.readFileString(path.join(migratedWorktree, '.git'))).toBe(
          `gitdir: ${relativeCurrentGitdir}\n`,
        );
        expect(yield* fs.readFileString(path.join(migratedGitdir, 'config'))).toContain(
          `worktree = ${migratedWorktree}`,
        );
        for (const [relativePath, content] of currentState) {
          expect(yield* fs.readFileString(path.join(migratedGitdir, relativePath))).toBe(content);
        }
        expect(yield* fs.exists(path.join(migratedGitdir, 'legacy-only-extension'))).toBe(false);
        expect(
          yield* fs.exists(
            path.join(
              migratedGitdir,
              'objects',
              Effect2.pipe(unpublishedCommit, EffectString.slice(0, 2)),
              Effect2.pipe(unpublishedCommit, EffectString.slice(2)),
            ),
          ),
        ).toBe(false);
        const migratedTeams = parseDefaultShareGitPaths(
          yield* fs.readFileString(path.join(targetHome, 'share', 'teams.json')),
        );
        expect(migratedTeams.teams.default).toMatchObject({
          gitdir: migratedGitdir,
          worktree: migratedWorktree,
        });

        expect(yield* fs.readFileString(path.join(legacyWorktree, '.git'))).toBe(`gitdir: ${legacyGitdir}\n`);
        expect(yield* fs.exists(path.join(legacyGitdir, 'FETCH_HEAD'))).toBe(true);
        expect(yield* fs.readFileString(path.join(legacyGitdir, 'COMMIT_EDITMSG'))).toBe('Unpublished shared memory\n');
        expect(yield* fs.readFileString(path.join(legacyGitdir, 'index'))).toBe(legacyIndex);
        expect(yield* fs.exists(path.join(legacyGitdir, 'gc.log'))).toBe(true);
        expect(yield* fs.exists(path.join(legacyGitdir, 'index.lock'))).toBe(true);
        expect(yield* fs.exists(path.join(legacyGitdir, 'refs', 'heads', 'main.lock'))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects legacy symlinks that escape the owned home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-symlink-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(legacyHome);
        const canonical = path.join(legacyHome, 'data', 'viking', 'local', 'resources', 'context.md');
        yield* fs.makeDirectory(path.dirname(canonical), {recursive: true});
        yield* fs.writeFileString(canonical, 'canonical context');
        yield* fs.writeFileString(path.join(root, 'outside.md'), 'outside');
        yield* fs.symlink(path.join(root, 'outside.md'), path.join(legacyHome, 'escape.md'));
        const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);
        expect(error._tag).toBe('HomeMigrationUnsafe');
        expect(yield* fs.exists(targetHome)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects absolute symlinks even when they point inside the legacy home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-absolute-symlink-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(legacyHome);
        const canonical = path.join(legacyHome, 'data', 'viking', 'local', 'resources', 'context.md');
        yield* fs.makeDirectory(path.dirname(canonical), {recursive: true});
        yield* fs.writeFileString(canonical, 'canonical context');
        const target = path.join(legacyHome, 'target.md');
        yield* fs.writeFileString(target, 'target');
        yield* fs.symlink(target, path.join(legacyHome, 'absolute.md'));
        const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);
        expect(error._tag).toBe('HomeMigrationUnsafe');
        expect(error.message).toContain('Absolute symbolic links');
        expect(yield* fs.exists(targetHome)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function parseMigrationReceipt(text: string): {readonly sourceTreeSha256: string} {
  const value: unknown = JSON.parse(text);
  if (!Predicate.isObject(value) || typeof value.sourceTreeSha256 !== 'string') {
    throw new Error('Expected a migration receipt with a source tree digest.');
  }
  return {sourceTreeSha256: value.sourceTreeSha256};
}

function parseDefaultShareGitPaths(text: string): {
  readonly teams: {readonly default: {readonly gitdir: string; readonly worktree: string}};
} {
  const value: unknown = JSON.parse(text);
  if (!Predicate.isObject(value) || !Predicate.isObject(value.teams) || !Predicate.isObject(value.teams.default)) {
    throw new Error('Expected a share teams file with a default team.');
  }
  const defaultTeam = value.teams.default;
  if (typeof defaultTeam.gitdir !== 'string' || typeof defaultTeam.worktree !== 'string') {
    throw new Error('Expected default team gitdir and worktree paths.');
  }
  return {teams: {default: {gitdir: defaultTeam.gitdir, worktree: defaultTeam.worktree}}};
}

function snapshotDirectory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<readonly string[], unknown> {
  const walk = (directory: string): Effect.Effect<readonly string[], unknown> =>
    Effect.gen(function* () {
      const snapshot: string[] = [];
      for (const name of (yield* fs.readDirectory(directory)).sort()) {
        const absolutePath = path.join(directory, name);
        const relativePath = EffectArray.join(
          Effect2.pipe(path.relative(root, absolutePath), EffectString.split(path.sep)),
          '/',
        );
        const info = yield* fs.stat(absolutePath);
        if (info.type === 'Directory') {
          snapshot.push(`directory:${relativePath}`, ...(yield* walk(absolutePath)));
        } else {
          snapshot.push(`file:${relativePath}:${yield* fs.readFileString(absolutePath)}`);
        }
      }
      return snapshot;
    });
  return walk(root);
}
