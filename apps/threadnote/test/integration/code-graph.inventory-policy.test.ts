import {Array as EffectArray, Option as EffectOption} from 'effect';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect, it} from 'vitest';
import {inventoryRepository, previewCodeGraphInventory, worktreeOverlayState} from '@threadnote/graph/inventory';
import {
  CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
  CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES,
} from '@threadnote/graph/inventory/policy';
import {CommandExecutor} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {runEffect} from '../helpers/effect-runtime.js';
import {resolveContextBriefFinalFenceOverlay} from '@threadnote/context/citation_validation';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph inventory admission policy', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
  });

  effectIt.effect('excludes low-meaning clean and dirty files before content reads, hashing, or freshness', () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), 'threadnote-inventory-policy-'));
      roots.push(root);
      const excludedPaths = createInventoryPolicyFixture(root);
      const excludedBlobIds = new Set(EffectArray.map(excludedPaths, path => git(root, ['rev-parse', `HEAD:${path}`])));
      const requestedBlobIds: string[] = [];

      const identity = yield* resolveRepositoryIdentity(root);
      const command = yield* CommandExecutor;
      const wrappedCommand = CommandExecutor.of({
        ...command,
        executeBytes: (executable, args, options) => {
          if (executable === 'git' && args.includes('cat-file') && args.includes('--batch')) {
            const input = new TextDecoder().decode(options?.input ?? new Uint8Array());
            requestedBlobIds.push(...EffectArray.filter(Effect2.pipe(input, EffectString.split('\n')), Boolean));
          }
          return command.executeBytes!(executable, args, options);
        },
      });
      const clean = yield* inventoryRepository(identity).pipe(Effect.provideService(CommandExecutor, wrappedCommand));

      expect(EffectArray.map(clean.files, file => file.path)).toEqual([
        'data/small.json',
        'package.json',
        'src/index.ts',
      ]);
      expect(
        EffectArray.filter(
          requestedBlobIds,
          __effectArrayValue => !!(blobId => excludedBlobIds.has(blobId))(__effectArrayValue),
        ),
      ).toEqual([]);
      expect(clean.skipped).toBe(4);
      const cleanExcludedBytes = EffectArray.reduce(
        excludedPaths,
        0,
        (total, path) => total + statSync(join(root, path)).size,
      );
      expect(clean.policyExclusions).toEqual({
        bytes: cleanExcludedBytes,
        files: 4,
        policyVersion: 2,
        reasons: [
          {bytes: statSync(join(root, 'assets/logo.SVG')).size, files: 1, reason: 'svg'},
          {bytes: statSync(join(root, 'SCHEMAS/__SNAPSHOTS__/PROJECT.JSON')).size, files: 1, reason: 'low-signal-json'},
          {bytes: CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES, files: 1, reason: 'generic-json-size'},
          {
            bytes: CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES,
            files: 1,
            reason: 'high-signal-json-hard-cap',
          },
        ],
      });
      expect(clean.diagnostics).toHaveLength(1);
      expect(clean.diagnostics[0].length).toBeLessThan(512);
      for (const path of excludedPaths) expect(clean.diagnostics[0]).not.toContain(path);

      writeFileSync(join(root, 'assets', 'logo.SVG'), '<svg>changed</svg>');
      writeFileSync(join(root, 'SCHEMAS', '__SNAPSHOTS__', 'PROJECT.JSON'), '{"changed":true}');
      writeSizedFile(join(root, 'data', 'events.jsonc'), CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES + 1);
      writeSizedFile(join(root, 'apps', 'mobile', 'project.json'), CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES + 1);
      writeFileSync(join(root, 'assets', 'untracked.svg'), '<svg/>');
      const excludedOnlyOpened: string[] = [];
      const excludedOnly = yield* inventoryWithObservedOpensEffect(root, excludedOnlyOpened);

      expect(
        EffectArray.some(excludedOnlyOpened, path => Effect2.pipe(path, EffectString.endsWith('/.git/info/exclude'))),
      ).toBe(true);
      for (const path of excludedPaths) {
        expect(
          EffectArray.some(excludedOnlyOpened, opened => Effect2.pipe(opened, EffectString.endsWith(`/${path}`))),
          path,
        ).toBe(false);
      }
      expect(excludedOnly.dirty).toBe(false);
      expect(excludedOnly.overlayFingerprint).toBeUndefined();
      expect(yield* observedOverlayStateEffect(root)).toEqual({dirty: false, fingerprint: undefined});
      expect(
        yield* resolveRepositoryIdentity(root).pipe(
          Effect.flatMap(identity => resolveContextBriefFinalFenceOverlay(identity, undefined)),
        ),
      ).toEqual({dirty: false, fingerprint: undefined});
      expect(EffectArray.map(excludedOnly.files, file => file.path)).toEqual(
        EffectArray.map(clean.files, file => file.path),
      );
      expect(excludedOnly.skipped).toBe(5);
      expect(excludedOnly.policyExclusions?.files).toBe(5);
      expect(excludedOnly.policyExclusions?.bytes).toBe(
        EffectArray.reduce(
          [
            'assets/logo.SVG',
            'SCHEMAS/__SNAPSHOTS__/PROJECT.JSON',
            'data/events.jsonc',
            'apps/mobile/project.json',
            'assets/untracked.svg',
          ],
          0,
          (total, path) => total + statSync(join(root, path)).size,
        ),
      );

      writeFileSync(join(root, 'apps', 'mobile', 'project.json'), '{}\n');
      const admittedOpened: string[] = [];
      const admitted = yield* inventoryWithObservedOpensEffect(root, admittedOpened);

      expect(admitted.dirty).toBe(true);
      expect(admitted.overlayFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(yield* observedOverlayStateEffect(root)).toMatchObject({dirty: true, fingerprint: expect.any(String)});
      expect(
        yield* resolveRepositoryIdentity(root).pipe(
          Effect.flatMap(identity => resolveContextBriefFinalFenceOverlay(identity, undefined)),
        ),
      ).toMatchObject({dirty: true, fingerprint: expect.any(String)});
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(admitted.files, file => file.path === 'apps/mobile/project.json'),
        ),
      ).toMatchObject({
        path: 'apps/mobile/project.json',
        size: 3,
        source: 'worktree',
      });
      expect(admitted.policyExclusions?.files).toBe(4);
      expect(
        EffectArray.some(admittedOpened, path =>
          Effect2.pipe(path, EffectString.endsWith('/apps/mobile/project.json')),
        ),
      ).toBe(true);
      for (const path of [
        'assets/logo.SVG',
        'SCHEMAS/__SNAPSHOTS__/PROJECT.JSON',
        'data/events.jsonc',
        'assets/untracked.svg',
      ]) {
        expect(
          EffectArray.some(admittedOpened, opened => Effect2.pipe(opened, EffectString.endsWith(`/${path}`))),
          path,
        ).toBe(false);
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('previews exact aggregate admission decisions without reading excluded blobs', () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), 'threadnote-inventory-preview-'));
      roots.push(root);
      git(root, ['init', '-q']);
      for (const directory of [['apps', 'mobile'], ['assets'], ['data'], ['src']]) {
        mkdirSync(join(root, ...directory), {recursive: true});
      }
      writeFileSync(join(root, 'package.json'), '{"name":"inventory-preview"}\n');
      writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{}}\n');
      writeFileSync(join(root, 'apps', 'mobile', 'project.json'), '{}\n');
      writeFileSync(join(root, 'src', 'active.ts'), 'export const active = true;\n');
      writeFileSync(join(root, 'src', 'ignored.ts'), 'export const ignored = true;\n');
      writeFileSync(join(root, '.threadnoteignore'), 'src/ignored.ts\n');
      writeFileSync(join(root, 'assets', 'icon.svg'), '<svg/>');
      writeSizedFile(join(root, 'data', 'heavy.json'), CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES);
      git(root, ['add', '.']);
      git(root, [
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);
      const excludedBlobIds = new Set([
        git(root, ['rev-parse', 'HEAD:assets/icon.svg']),
        git(root, ['rev-parse', 'HEAD:data/heavy.json']),
      ]);
      const requestedBlobIds: string[] = [];

      const identity = yield* resolveRepositoryIdentity(root);
      const command = yield* CommandExecutor;
      const observedCommand = CommandExecutor.of({
        ...command,
        executeBytes: (executable, args, options) => {
          if (executable === 'git' && args.includes('cat-file') && args.includes('--batch')) {
            requestedBlobIds.push(
              ...EffectArray.filter(
                Effect2.pipe(new TextDecoder().decode(options?.input ?? new Uint8Array()), EffectString.split('\n')),
                Boolean,
              ),
            );
          }
          return command.executeBytes!(executable, args, options);
        },
      });
      const preview = yield* previewCodeGraphInventory(identity).pipe(
        Effect.provideService(CommandExecutor, observedCommand),
      );
      const group = (reason: string, language: string) =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            preview.groups,
            candidate => candidate.reason === reason && candidate.language === language,
          ),
        );

      expect(
        EffectArray.filter(
          requestedBlobIds,
          __effectArrayValue => !!(blobId => excludedBlobIds.has(blobId))(__effectArrayValue),
        ),
      ).toEqual([]);
      expect(preview).toMatchObject({dirty: false, policyVersion: 2, scope: 'head-and-worktree'});
      expect(group('svg', 'document')).toMatchObject({classifier: 'corpus', disposition: 'skipped'});
      expect(group('generic-json-size', 'json')).toMatchObject({classifier: 'schemas', disposition: 'skipped'});
      expect(group('threadnote-ignore', 'typescript')).toMatchObject({
        classifier: 'typescript',
        disposition: 'skipped',
      });
      expect(group('admitted', 'typescript')).toMatchObject({disposition: 'eligible', role: 'source'});
      expect(group('admitted', 'npm-manifest')).toMatchObject({disposition: 'eligible', role: 'manifest'});
      expect(group('admitted', 'typescript-config')).toMatchObject({disposition: 'eligible', role: 'workspace'});
      expect(group('admitted', 'json')).toMatchObject({classifier: 'schemas', disposition: 'eligible'});
      expect(JSON.stringify(preview)).not.toContain(root);
      for (const repositoryPath of ['src/active.ts', 'src/ignored.ts', 'assets/icon.svg', 'data/heavy.json']) {
        expect(JSON.stringify(preview)).not.toContain(repositoryPath);
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('unions committed and checkout-local Threadnote ignore files during inventory', () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), 'threadnote-inventory-ignore-local-'));
      roots.push(root);
      git(root, ['init', '-q']);
      mkdirSync(join(root, 'src'), {recursive: true});
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 1;\n');
      writeFileSync(join(root, 'src', 'c.ts'), 'export const c = 1;\n');
      writeFileSync(join(root, '.threadnoteignore'), 'src/a.ts\n');
      writeFileSync(join(root, '.threadnoteignore.local'), 'src/b.ts\n');
      git(root, ['add', '.threadnoteignore', 'src']);
      git(root, [
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);

      const identity = yield* resolveRepositoryIdentity(root);
      const preview = yield* previewCodeGraphInventory(identity);
      const ignored = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          preview.groups,
          candidate => candidate.reason === 'threadnote-ignore' && candidate.language === 'typescript',
        ),
      );
      const admitted = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          preview.groups,
          candidate => candidate.reason === 'admitted' && candidate.language === 'typescript',
        ),
      );
      expect(ignored).toMatchObject({disposition: 'skipped', files: 2});
      expect(admitted).toMatchObject({disposition: 'eligible', files: 1});

      const inventoried = yield* inventoryRepository(identity);
      expect(EffectArray.map(inventoried.files, file => file.path)).toEqual(['src/c.ts']);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it('bounds Git ignore checks and stable metadata inspection to relevant changed paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-inventory-policy-changed-paths-'));
    roots.push(root);
    git(root, ['init', '-q']);
    mkdirSync(join(root, 'src'), {recursive: true});
    for (let index = 0; index < 512; index += 1) {
      writeFileSync(
        join(root, 'src', `file-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.ts`),
        `export const value${index} = ${index};\n`,
      );
    }
    writeFileSync(join(root, 'artifact.bin'), new Uint8Array([0, 1, 2, 3]));
    writeFileSync(join(root, 'ignored.ts'), 'export const ignored = 0;\n');
    writeFileSync(join(root, '.threadnoteignore'), 'ignored.ts\n# initial\n');
    git(root, ['add', '.']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'fixture',
    ]);
    writeFileSync(join(root, 'src', 'file-000.ts'), 'export const value0 = 1;\n');
    writeFileSync(join(root, 'artifact.bin'), new Uint8Array([4, 5, 6, 7]));
    writeFileSync(join(root, 'ignored.ts'), 'export const ignored = 1;\n');
    writeFileSync(join(root, '.threadnoteignore'), 'ignored.ts\n# changed\n');
    const checkIgnoreInputs: string[][] = [];
    const openedPaths: string[] = [];
    const statPaths: string[] = [];

    const state = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        const command = yield* CommandExecutor;
        const fileSystem = yield* FileSystem.FileSystem;
        const observedCommand = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) => {
            if (executable === 'git' && args.includes('check-ignore')) {
              checkIgnoreInputs.push(
                EffectArray.filter(
                  Effect2.pipe(new TextDecoder().decode(options?.input ?? new Uint8Array()), EffectString.split('\0')),
                  Boolean,
                ),
              );
            }
            return command.execute(executable, args, options);
          },
        });
        const observedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (path, options) => {
            openedPaths.push(String(path));
            return fileSystem.open(path, options);
          },
          stat: path => {
            statPaths.push(String(path));
            return fileSystem.stat(path);
          },
        });
        return yield* worktreeOverlayState(identity).pipe(
          Effect.provideService(CommandExecutor, observedCommand),
          Effect.provideService(FileSystem.FileSystem, observedFileSystem),
        );
      }),
    );

    expect(state.dirty).toBe(true);
    expect(checkIgnoreInputs).toEqual([['src/file-000.ts']]);
    expect(EffectArray.some(statPaths, path => Effect2.pipe(path, EffectString.endsWith('/artifact.bin')))).toBe(false);
    expect(EffectArray.some(statPaths, path => Effect2.pipe(path, EffectString.endsWith('/ignored.ts')))).toBe(false);
    expect(EffectArray.some(openedPaths, path => Effect2.pipe(path, EffectString.endsWith('/ignored.ts')))).toBe(false);

    writeFileSync(join(root, 'src', 'file-000.ts'), 'export const value0 = 0;\n');
    writeFileSync(join(root, 'artifact.bin'), new Uint8Array([0, 1, 2, 3]));
    writeFileSync(join(root, 'ignored.ts'), 'export const ignored = 0;\n');
    expect(await observedOverlayState(root)).toMatchObject({dirty: true, fingerprint: expect.any(String)});
  });

  it('drops stale policy accounting when an excluded file becomes a symlink', async () => {
    const root = createSingleExcludedFixture('threadnote-inventory-policy-symlink-', roots);
    const clean = await inventory(root);
    expect(clean.policyExclusions).toMatchObject({bytes: 6, files: 1});
    rmSync(join(root, 'asset.svg'));
    symlinkSync('src/index.ts', join(root, 'asset.svg'));

    const replaced = await inventory(root);

    expect(replaced.dirty).toBe(false);
    expect(replaced.overlayFingerprint).toBeUndefined();
    expect(replaced.skipped).toBe(1);
    expect(replaced.policyExclusions).toMatchObject({bytes: 0, files: 0});
    expect(await observedOverlayState(root)).toEqual({dirty: false, fingerprint: undefined});
  });

  it('keeps an excluded rename into an ignored destination freshness-clean', async () => {
    const root = createSingleExcludedFixture('threadnote-inventory-policy-rename-', roots);
    mkdirSync(join(root, '.hidden'), {recursive: true});
    git(root, ['mv', 'asset.svg', '.hidden/new.ts']);

    const renamed = await inventory(root);

    expect(renamed.dirty).toBe(false);
    expect(renamed.overlayFingerprint).toBeUndefined();
    expect(renamed.skipped).toBe(1);
    expect(renamed.policyExclusions).toMatchObject({bytes: 0, files: 0});
    expect(await observedOverlayState(root)).toEqual({dirty: false, fingerprint: undefined});
  });

  it('keeps tracked JSON excluded by Git or Threadnote ignore rules freshness-clean without content reads', async () => {
    for (const ignoreFile of ['.gitignore', '.threadnoteignore']) {
      const root = mkdtempSync(join(tmpdir(), 'threadnote-inventory-policy-ignored-json-'));
      roots.push(root);
      git(root, ['init', '-q']);
      writeFileSync(join(root, ignoreFile), 'ignored.json\n');
      writeFileSync(join(root, 'ignored.json'), '{"value":1}\n');
      git(root, ['add', ignoreFile]);
      git(root, ['add', '-f', 'ignored.json']);
      git(root, [
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);
      writeFileSync(join(root, 'ignored.json'), '{"value":2}\n');
      const opened: string[] = [];

      const ignored = await inventoryWithObservedOpens(root, opened);

      expect(ignored.dirty, ignoreFile).toBe(false);
      expect(ignored.overlayFingerprint, ignoreFile).toBeUndefined();
      expect(
        EffectArray.some(opened, path => Effect2.pipe(path, EffectString.endsWith('/ignored.json'))),
        ignoreFile,
      ).toBe(false);
      expect(await observedOverlayState(root), ignoreFile).toEqual({dirty: false, fingerprint: undefined});
    }
  });
});

function createInventoryPolicyFixture(root: string): readonly string[] {
  git(root, ['init', '-q']);
  for (const directory of [['apps', 'mobile'], ['assets'], ['data'], ['SCHEMAS', '__SNAPSHOTS__'], ['src']]) {
    mkdirSync(join(root, ...directory), {recursive: true});
  }
  writeFileSync(join(root, 'package.json'), '{"name":"inventory-policy-fixture"}\n');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const index = 1;\n');
  writeSizedFile(join(root, 'data', 'small.json'), CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES - 1);
  writeFileSync(join(root, 'assets', 'logo.SVG'), '<svg/>');
  writeFileSync(join(root, 'SCHEMAS', '__SNAPSHOTS__', 'PROJECT.JSON'), '{}');
  writeSizedFile(join(root, 'data', 'events.jsonc'), CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES);
  writeSizedFile(join(root, 'apps', 'mobile', 'project.json'), CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  return ['assets/logo.SVG', 'SCHEMAS/__SNAPSHOTS__/PROJECT.JSON', 'data/events.jsonc', 'apps/mobile/project.json'];
}

const inventoryWithObservedOpensEffect = Effect.fn('test.inventoryWithObservedOpens')(function* (
  root: string,
  opened: string[],
) {
  const identity = yield* resolveRepositoryIdentity(root);
  const fileSystem = yield* FileSystem.FileSystem;
  const observedFileSystem = FileSystem.FileSystem.of({
    ...fileSystem,
    open: (path, options) =>
      Effect.sync(() => opened.push(String(path))).pipe(Effect.andThen(fileSystem.open(path, options))),
  });
  return yield* inventoryRepository(identity).pipe(Effect.provideService(FileSystem.FileSystem, observedFileSystem));
});

async function inventoryWithObservedOpens(root: string, opened: string[]) {
  return runEffect(inventoryWithObservedOpensEffect(root, opened));
}

async function inventory(root: string) {
  return runEffect(
    Effect.gen(function* () {
      const identity = yield* resolveRepositoryIdentity(root);
      return yield* inventoryRepository(identity);
    }),
  );
}

const observedOverlayStateEffect = Effect.fn('test.observedOverlayState')(function* (root: string) {
  const identity = yield* resolveRepositoryIdentity(root);
  return yield* worktreeOverlayState(identity);
});

async function observedOverlayState(root: string) {
  return runEffect(observedOverlayStateEffect(root));
}

function writeSizedFile(path: string, size: number): void {
  writeFileSync(path, Buffer.alloc(size, 0x78));
}

function createSingleExcludedFixture(prefix: string, roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  git(root, ['init', '-q']);
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'asset.svg'), '<svg/>');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const index = 1;\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  return root;
}

function git(root: string, args: readonly string[]): string {
  return Effect2.pipe(execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}), EffectString.trim);
}
