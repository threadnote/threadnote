import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {DateTime, Effect} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {afterEach, describe, expect, vi} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {checkForThreadnoteUpdate} from '@threadnote/threadnote/release/check';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(EffectArray.map(temporaryDirectories.splice(0), path => rm(path, {force: true, recursive: true})));
});

describe('Effect update check', () => {
  effectIt.effect('skips network work for unknown development versions', () =>
    Effect.gen(function* () {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      yield* runCheck('/unused', 'unknown');
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('uses a fresh cache without fetching', () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const cachePath = join(directory, 'update.json');
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.promise(() =>
        writeFile(
          cachePath,
          JSON.stringify({channel: 'latest', checkedAt, latestVersion: '2.0.0', version: 3}),
          'utf8',
        ),
      );
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      expect(yield* runCheck(cachePath, '1.0.0')).toEqual({
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        outdated: true,
      });
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  fcEffectProp(
    effectIt,
    'refetches when cache age reaches the 24-hour TTL (property)',
    {ageMs: FC.integer({min: 0, max: 48 * 60 * 60 * 1000})},
    ({ageMs}) =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(temporaryDirectory);
        const cachePath = join(directory, 'update.json');
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        yield* Effect.promise(() =>
          writeFile(
            cachePath,
            JSON.stringify({channel: 'latest', checkedAt, latestVersion: '2.0.0', version: 3}),
            'utf8',
          ),
        );
        const fetch = vi.fn(async (_url: string | URL) =>
          Response.json([
            {
              assets: [],
              draft: false,
              immutable: true,
              prerelease: false,
              tag_name: 'v3.0.0',
            },
          ]),
        );
        vi.stubGlobal('fetch', fetch);
        yield* TestClock.adjust(ageMs);

        const result = yield* runCheck(cachePath, '1.0.0');
        if (ageMs < 24 * 60 * 60 * 1000) {
          expect(fetch).not.toHaveBeenCalled();
          expect(result).toEqual({currentVersion: '1.0.0', latestVersion: '2.0.0', outdated: true});
        } else {
          expect(fetch).toHaveBeenCalled();
          expect(result).toEqual({currentVersion: '1.0.0', latestVersion: '3.0.0', outdated: true});
        }
      }),
    {fastCheck: {numRuns: 16}},
  );

  effectIt.effect('fetches through HttpService and persists a successful result', () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const cachePath = join(directory, 'update.json');
      const fetch = vi.fn(async (_url: string | URL) =>
        Response.json([
          {
            assets: [],
            draft: false,
            immutable: true,
            prerelease: false,
            tag_name: 'v1.2.0',
          },
        ]),
      );
      vi.stubGlobal('fetch', fetch);

      expect(yield* runCheck(cachePath, '1.1.0')).toEqual({
        currentVersion: '1.1.0',
        latestVersion: '1.2.0',
        outdated: true,
      });
      expect(
        EffectArray.some(fetch.mock.calls, ([url]) =>
          Effect2.pipe(String(url), EffectString.includes('/releases?per_page=100')),
        ),
      ).toBe(true);
      expect(yield* Effect.promise(() => readFile(cachePath, 'utf8'))).toContain('"channel":"latest"');
      expect(yield* Effect.promise(() => readFile(cachePath, 'utf8'))).toContain('"latestVersion":"1.2.0"');
    }),
  );

  effectIt.effect('invalidates a v2 beta cache and discovers a newer stable release', () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const cachePath = join(directory, 'update.json');
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.promise(() =>
        writeFile(
          cachePath,
          JSON.stringify({
            channel: 'beta',
            checkedAt,
            latestVersion: '3.0.0-beta.2',
            version: 2,
          }),
          'utf8',
        ),
      );
      const fetch = vi.fn(async (_url: string | URL) =>
        Response.json([
          {
            assets: [],
            draft: false,
            immutable: true,
            prerelease: true,
            tag_name: 'v3.0.0-beta.2',
          },
          {
            assets: [],
            draft: false,
            immutable: true,
            prerelease: false,
            tag_name: 'v3.0.0',
          },
        ]),
      );
      vi.stubGlobal('fetch', fetch);

      expect(yield* runCheck(cachePath, '3.0.0-beta.1')).toEqual({
        currentVersion: '3.0.0-beta.1',
        latestVersion: '3.0.0',
        outdated: true,
      });
      expect(
        EffectArray.some(fetch.mock.calls, ([url]) =>
          Effect2.pipe(String(url), EffectString.includes('/releases?per_page=100')),
        ),
      ).toBe(true);
      expect(yield* Effect.promise(() => readFile(cachePath, 'utf8'))).toContain('"channel":"beta"');
      expect(yield* Effect.promise(() => readFile(cachePath, 'utf8'))).toContain('"latestVersion":"3.0.0"');
      expect(yield* Effect.promise(() => readFile(cachePath, 'utf8'))).toContain('"version":3');
    }),
  );
});

function runCheck(cachePath: string, currentVersion: string) {
  return checkForThreadnoteUpdate({cachePath, currentVersion}).pipe(provideTestLayer(ApplicationLayer));
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'threadnote-update-check-'));
  temporaryDirectories.push(directory);
  return directory;
}
