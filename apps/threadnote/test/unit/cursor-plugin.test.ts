import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {access, readFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {USER_INSTRUCTIONS_END_MARKER, USER_INSTRUCTIONS_START_MARKER} from '@threadnote/threadnote/constants';
import {cursorPluginDoctorChecks} from '@threadnote/threadnote/cursor/plugin';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';

const root = process.cwd();
const pluginRoot = join(root, 'cursor-plugin');
const cursorPluginVersion = '1.1.0';

describe('Cursor plugin package', () => {
  it('matches Cursor manifest anatomy and the canonical Threadnote instructions', async () => {
    const [
      marketplaceRaw,
      manifestRaw,
      rule,
      instructions,
      pluginLicense,
      licenseScope,
      packageRaw,
      lifecycle,
      update,
      marketplaceLogo,
      canonicalLogo,
      changelog,
    ] = await Promise.all([
      readFile(join(root, '.cursor-plugin', 'marketplace.json'), 'utf8'),
      readFile(join(pluginRoot, '.cursor-plugin', 'plugin.json'), 'utf8'),
      readFile(join(pluginRoot, 'rules', 'threadnote.mdc'), 'utf8'),
      readFile(join(root, 'config', 'agent-instructions.md'), 'utf8'),
      readFile(join(pluginRoot, 'LICENSE'), 'utf8'),
      readFile(join(root, 'CURSOR_PLUGIN_LICENSE.md'), 'utf8'),
      readFile(join(root, 'package.json'), 'utf8'),
      readFile(join(root, 'apps', 'threadnote', 'src', 'lifecycle.ts'), 'utf8'),
      readFile(join(root, 'apps', 'threadnote', 'src', 'release', 'update.ts'), 'utf8'),
      readFile(join(pluginRoot, 'assets', 'logo.svg'), 'utf8'),
      readFile(join(root, 'assets', 'brand', 'threadnote-logo.svg'), 'utf8'),
      readFile(join(pluginRoot, 'CHANGELOG.md'), 'utf8'),
    ]);
    const marketplace = JSON.parse(marketplaceRaw) as Record<string, unknown>;
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;

    expect(Object.keys(marketplace).sort()).toEqual(['metadata', 'name', 'owner', 'plugins']);
    expect(marketplace).toMatchObject({
      name: 'threadnote',
      plugins: [
        {
          minClientVersions: {cursor: '2.5.0'},
          name: 'threadnote',
          source: 'cursor-plugin',
        },
      ],
    });
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'author',
        'category',
        'description',
        'displayName',
        'homepage',
        'keywords',
        'license',
        'logo',
        'minClientVersions',
        'name',
        'publisher',
        'repository',
        'rules',
        'tags',
        'version',
      ].sort(),
    );
    expect(manifest).toMatchObject({
      license: 'MIT',
      logo: 'assets/logo.svg',
      minClientVersions: {cursor: '2.5.0'},
      name: 'threadnote',
      rules: './rules/',
      version: cursorPluginVersion,
    });
    expect(/^## (\S+)/m.exec(changelog)?.[1]).toBe(cursorPluginVersion);
    expect(rule).toMatch(/^---\ndescription: .+\nalwaysApply: true\n---\n/);
    expect(rule).toContain(
      `${USER_INSTRUCTIONS_START_MARKER}\n${instructions.trim()}\n${USER_INSTRUCTIONS_END_MARKER}`,
    );
    expect(pluginLicense.startsWith('MIT License')).toBe(true);
    expect(licenseScope).toContain('`.cursor-plugin/` and `cursor-plugin/`');
    expect(JSON.parse(packageRaw)).toMatchObject({license: 'AGPL-3.0-or-later'});
    expect(await pathExists(join(pluginRoot, '.threadnote-managed.json'))).toBe(false);
    expect(lifecycle).not.toContain('installCursorPlugin');
    expect(lifecycle).not.toContain('removeCursorPlugin');
    expect(update).not.toContain('installCursorPlugin');
    expect(marketplaceLogo).toContain('viewBox="0 0 256 256"');
    expect(marketplaceLogo).toContain('<rect width="256" height="256" rx="44" fill="#141b1e"/>');
    expect(marketplaceLogo).toContain('stroke-width="36"');
    expect(marketplaceLogo).toContain('fill="#67e8c7"');
    expect(svgPathData(marketplaceLogo)).toBe(svgPathData(canonicalLogo));
  });

  it.effect('skips absent Cursor and verifies only Marketplace-managed plugin installs', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-cursor-plugin-'});
        const userHome = path.join(temporaryRoot, 'user');
        const testSystem = SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), PATH: ''}),
          homeDirectory: userHome,
        });
        const doctor = () =>
          cursorPluginDoctorChecks({cursorInstalled: true}).pipe(Effect.provideService(SystemInfo, testSystem));

        const skipped = yield* cursorPluginDoctorChecks({cursorInstalled: false}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(skipped).toEqual([]);

        const missing = yield* doctor();
        expect(missing).toMatchObject([{name: 'Cursor plugin', status: 'warn'}]);
        expect(missing[0]?.detail).toContain('Cursor Marketplace');

        const localRoot = path.join(userHome, '.cursor', 'plugins', 'local', 'threadnote');
        yield* fs.makeDirectory(localRoot, {recursive: true});
        const local = yield* doctor();
        expect(local).toMatchObject([{name: 'Cursor plugin', status: 'fail'}]);
        expect(local[0]?.detail).toContain('unsupported local installation');
        expect(local[0]?.detail).toContain('team marketplace');
        yield* fs.remove(localRoot, {recursive: true});

        const cachedRoot = path.join(userHome, '.cursor', 'plugins', 'cache', 'threadnote', cursorPluginVersion);
        yield* fs.copy(pluginRoot, cachedRoot, {overwrite: true});
        const cached = yield* doctor();
        expect(cached).toMatchObject([{name: 'Cursor plugin', status: 'ok'}]);
        expect(cached[0]?.detail).toContain(cachedRoot);

        yield* fs.makeDirectory(localRoot, {recursive: true});
        const localWithMarketplaceCopy = yield* doctor();
        expect(localWithMarketplaceCopy).toMatchObject([{name: 'Cursor plugin', status: 'fail'}]);
        expect(localWithMarketplaceCopy[0]?.detail).toContain('unsupported local installation');
        yield* fs.remove(localRoot, {recursive: true});

        const cachedManifest = path.join(cachedRoot, '.cursor-plugin', 'plugin.json');
        yield* fs.writeFileString(
          cachedManifest,
          (yield* fs.readFileString(cachedManifest)).replace(
            `"version": "${cursorPluginVersion}"`,
            '"version": "0.9.0"',
          ),
        );
        const outdated = yield* doctor();
        expect(outdated).toMatchObject([{name: 'Cursor plugin', status: 'warn'}]);
        expect(outdated[0]?.detail).toContain(`is older than bundled v${cursorPluginVersion}`);
        expect(outdated[0]?.detail).toContain('Cursor Marketplace');

        yield* fs.copy(pluginRoot, cachedRoot, {overwrite: true});
        const cachedRule = path.join(cachedRoot, 'rules', 'threadnote.mdc');
        yield* fs.writeFileString(cachedRule, (yield* fs.readFileString(cachedRule)).replace('alwaysApply: true', ''));
        const invalid = yield* doctor();
        expect(invalid).toMatchObject([{name: 'Cursor plugin', status: 'fail'}]);
        expect(invalid[0]?.detail).toContain('Cursor Marketplace');

        yield* fs.copy(pluginRoot, cachedRoot, {overwrite: true});
        yield* fs.writeFileString(
          cachedRule,
          (yield* fs.readFileString(cachedRule)).replace(
            'unfamiliar source relationships',
            'unfamiliar source relationships for this task',
          ),
        );
        const sameVersionMismatch = yield* doctor();
        expect(sameVersionMismatch).toMatchObject([{name: 'Cursor plugin', status: 'fail'}]);
        expect(sameVersionMismatch[0]?.detail).toContain(`differs from bundled v${cursorPluginVersion}`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function svgPathData(svg: string): string {
  const pathData = /<path\b[^>]*\bd="([^"]+)"/.exec(svg)?.[1];
  if (!pathData) throw TestError.make({message: 'SVG does not contain a path with geometry data'});
  return pathData;
}
