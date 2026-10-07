import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Effect} from 'effect';
import {afterEach, describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {
  fetchThreadnoteReleaseNotes,
  formatWhatsNew,
  releaseForVersion,
  releasesBetween,
  type ReleaseNote,
} from '@threadnote/threadnote/release/notes';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

const releases: readonly ReleaseNote[] = [
  {
    body: '## Changes\n- Newer than requested.',
    title: 'future',
    version: '0.7.10',
  },
  {
    body: '## Changes\n- Fixed shared replacements.\n- Added docs.',
    title: 'one-step shared memory updates',
    version: '0.7.8',
  },
  {
    body: '## Changes\nPlain paragraph.\n* Star bullet.',
    title: 'formatted version output',
    version: '0.7.9',
  },
  {
    body: '- Old release.',
    title: 'old',
    version: '0.7.7',
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchThreadnoteReleaseNotes', () => {
  effectIt.effect('includes GitHub prereleases only when the beta channel requests them', () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json([
            {
              body: '- Beta change.',
              draft: false,
              name: '3.0.0-beta.1',
              prerelease: true,
              tag_name: 'v3.0.0-beta.1',
            },
            {
              body: '- Stable change.',
              draft: false,
              name: '2.0.4',
              prerelease: false,
              tag_name: 'v2.0.4',
            },
          ]),
        ),
      );

      const stable = yield* fetchThreadnoteReleaseNotes().pipe(provideTestLayer(ApplicationLayer));
      const beta = yield* fetchThreadnoteReleaseNotes({includePrereleases: true}).pipe(
        provideTestLayer(ApplicationLayer),
      );

      expect(stable.map(release => release.version)).toEqual(['2.0.4']);
      expect(beta.map(release => release.version)).toEqual(['3.0.0-beta.1', '2.0.4']);
    }),
  );
});

describe('releasesBetween', () => {
  it('partitions installed and upgrade notes in version order without mutating discovery results', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({min: 0, max: 40}), {maxLength: 30}),
        fc.integer({min: 0, max: 30}),
        fc.integer({min: 0, max: 10}),
        (patches, current, distance) => {
          const notes = patches.map(patch => ({version: '5.1.' + patch, title: 'Release', body: ''}));
          const before = structuredClone(notes);
          const upper = current + distance;
          const installed = releaseForVersion(notes, '5.1.' + current);
          const available = releasesBetween(notes, '5.1.' + current, '5.1.' + upper);
          expect(installed.map(note => note.version)).toEqual(patches.includes(current) ? ['5.1.' + current] : []);
          expect(available.map(note => note.version)).toEqual(
            patches
              .filter(patch => patch > current && patch <= upper)
              .sort((a, b) => a - b)
              .map(patch => '5.1.' + patch),
          );
          expect(notes).toEqual(before);
        },
      ),
      {numRuns: 60},
    );
  });
  it('returns newer releases up to latest in ascending order', () => {
    expect(releasesBetween(releases, '0.7.7', '0.7.9').map(release => release.version)).toEqual(['0.7.8', '0.7.9']);
  });
});

describe('releaseForVersion', () => {
  it('returns only the requested release', () => {
    expect(releaseForVersion(releases, '0.7.7').map(release => release.version)).toEqual(['0.7.7']);
  });
});

describe('formatWhatsNew', () => {
  it('formats release titles and normalized body lines', () => {
    expect(formatWhatsNew(releasesBetween(releases, '0.7.7', '0.7.9'))).toEqual([
      "What's new:",
      '0.7.8: one-step shared memory updates',
      '  - Fixed shared replacements.',
      '  - Added docs.',
      '0.7.9: formatted version output',
      '  Plain paragraph.',
      '  - Star bullet.',
    ]);
  });

  it('returns no lines when there are no releases to show', () => {
    expect(formatWhatsNew([])).toEqual([]);
  });
});
