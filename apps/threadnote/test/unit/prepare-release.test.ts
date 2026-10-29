import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {provideTestLayer} from '../helpers/effect-layer.js';
import fc from 'fast-check';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {describe, expect, it} from 'vitest';

import {
  nextPatchVersion,
  parsePrepareReleaseArguments,
  prepareRelease,
  releaseNotesPathForVersion,
  replacePackageVersion,
  isSupportedReleaseVersion,
  validateReleaseNotes,
} from '../../../../scripts/prepare-release.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const PrepareReleaseTestLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const validNotes = EffectArray.join(
  [
    "## What's new",
    '',
    'Threadnote 4.6.7 returns a complete memory from `read_context` up to 64 KiB, or refuses with an outline instead of paging.',
    '',
    '### Complete-or-refuse memory reads',
    '',
    'Agents get the full note or an outline.',
    '',
  ],
  '\n',
);

const stableVersionArbitrary = fc
  .tuple(fc.integer({max: 20, min: 0}), fc.integer({max: 40, min: 0}), fc.integer({max: 80, min: 0}))
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

const numberedBetaArbitrary = fc
  .tuple(
    fc.integer({max: 20, min: 0}),
    fc.integer({max: 40, min: 0}),
    fc.integer({max: 80, min: 0}),
    fc.integer({min: 1, max: 100_000}),
  )
  .map(([major, minor, patch, number]) => `${major}.${minor}.${patch}-beta.${number}`);

describe('prepare-release', () => {
  it('requires exactly one version selector', () => {
    expect(parsePrepareReleaseArguments(['--patch', '--dry-run', '--json'])).toEqual({
      dryRun: true,
      json: true,
      patch: true,
      version: undefined,
    });
    expect(parsePrepareReleaseArguments(['--version', '4.6.7'])).toEqual({
      dryRun: false,
      json: false,
      patch: false,
      version: '4.6.7',
    });
    expect(parsePrepareReleaseArguments(['--version', '5.0.7-beta.1'])).toMatchObject({version: '5.0.7-beta.1'});
    expect(parsePrepareReleaseArguments(['--version', '6.0.0-beta.42'])).toMatchObject({version: '6.0.0-beta.42'});
    expect(() => parsePrepareReleaseArguments([])).toThrow('Pass exactly one of --patch or --version');
    expect(() => parsePrepareReleaseArguments(['--patch', '--version', '4.6.7'])).toThrow(
      'Pass exactly one of --patch or --version',
    );
    expect(() => parsePrepareReleaseArguments(['--force'])).toThrow('Unknown prepare-release option');
  });

  it('increments only the patch component of a stable version', () => {
    fc.assert(
      fc.property(stableVersionArbitrary, version => {
        const [major, minor, patch] = EffectArray.map(Effect2.pipe(version, EffectString.split('.')), Number);
        expect(nextPatchVersion(version)).toBe(`${major}.${minor}.${(patch ?? 0) + 1}`);
        expect(releaseNotesPathForVersion(nextPatchVersion(version))).toBe(
          `.github/release-notes/v${major}.${minor}.${(patch ?? 0) + 1}.md`,
        );
      }),
      {numRuns: 64},
    );
    expect(() => nextPatchVersion('4.6.7-beta.1')).toThrow('Cannot increment patch');
  });

  it('validates curated notes the website publisher accepts', () => {
    const result = validateReleaseNotes(validNotes, '4.6.7');
    expect(Effect2.pipe(result.summary, EffectString.startsWith('Threadnote 4.6.7 returns a complete memory'))).toBe(
      true,
    );
    expect(result.headline.length).toBeGreaterThan(0);
    expect(result.headline.length).toBeLessThanOrEqual(240);
    expect(() => validateReleaseNotes('## Changes\nNope.', '4.6.7')).toThrow("must start with ## What's new");
  });

  it('accepts canonical safe-integer stable versions and numbered beta versions for any base version', () => {
    fc.assert(
      fc.property(stableVersionArbitrary, numberedBetaArbitrary, (stableVersion, betaVersion) => {
        expect(isSupportedReleaseVersion(stableVersion)).toBe(true);
        expect(validateReleaseNotes(validNotes, stableVersion).headline).not.toHaveLength(0);
        expect(isSupportedReleaseVersion(betaVersion)).toBe(true);
        expect(validateReleaseNotes(validNotes, betaVersion).headline).not.toHaveLength(0);
      }),
      {numRuns: 64},
    );
    for (const version of [
      '00.1.2',
      '1.02.3',
      '1.2.003',
      '9007199254740992.0.0',
      '0.9007199254740992.0',
      '0.0.9007199254740992',
      '5.0.7-beta',
      '5.0.7-beta.0',
      '5.0.7-beta.01',
      '05.0.7-beta.1',
      '5.00.7-beta.1',
      '5.0.07-beta.1',
      '9007199254740992.0.0-beta.1',
      '0.9007199254740992.0-beta.1',
      '0.0.9007199254740992-beta.1',
      '0.0.0-beta.9007199254740992',
      '5.0.0-rc.1',
      'x',
    ]) {
      expect(isSupportedReleaseVersion(version)).toBe(false);
      expect(() => validateReleaseNotes(validNotes, version)).toThrow('Release version must be');
    }
  });

  it('replaces only the package version field', () => {
    const replaced = replacePackageVersion({name: 'threadnote', version: '4.6.6'}, '4.6.7');
    expect(JSON.parse(replaced.source)).toEqual({name: 'threadnote', version: '4.6.7'});
    expect(Effect2.pipe(replaced.source, EffectString.endsWith('\n'))).toBe(true);
  });

  effectIt.effect('writes the package version only after notes validate', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-prepare-release-'});
      const packageFile = path.join(root, 'package.json');
      yield* fs.writeFileString(
        packageFile,
        `${JSON.stringify({name: 'threadnote', version: '4.6.6'}, undefined, 2)}\n`,
      );
      const missing = yield* prepareRelease({dryRun: true, json: true, patch: true, version: undefined}, root).pipe(
        Effect.flip,
      );
      expect(missing).toMatchObject({message: expect.stringContaining('release-notes')});
      yield* fs.makeDirectory(path.join(root, '.github', 'release-notes'), {recursive: true});
      yield* fs.writeFileString(path.join(root, '.github', 'release-notes', 'v4.6.7.md'), validNotes);
      const dryRun = yield* prepareRelease({dryRun: true, json: true, patch: true, version: undefined}, root);
      expect(dryRun).toMatchObject({
        dryRun: true,
        previousVersion: '4.6.6',
        version: '4.6.7',
        wrotePackageVersion: false,
      });
      expect(JSON.parse(yield* fs.readFileString(packageFile))).toMatchObject({version: '4.6.6'});
      const written = yield* prepareRelease({dryRun: false, json: true, patch: true, version: undefined}, root);
      expect(written.wrotePackageVersion).toBe(true);
      expect(JSON.parse(yield* fs.readFileString(packageFile))).toMatchObject({version: '4.6.7'});

      yield* fs.writeFileString(path.join(root, '.github', 'release-notes', 'v6.2.3-beta.1.md'), validNotes);
      const beta = yield* prepareRelease({dryRun: true, json: true, patch: false, version: '6.2.3-beta.1'}, root);
      expect(EffectArray.join(beta.nextSteps, '\n')).toContain('protected main');
      expect(EffectArray.join(beta.nextSteps, '\n')).not.toContain('release/5.0.0');
    }).pipe(provideTestLayer(PrepareReleaseTestLayer)),
  );
});
