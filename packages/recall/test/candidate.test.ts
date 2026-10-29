import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {indexCandidate} from '@threadnote/recall/index/candidate';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

const uri = 'threadnote://resources/repos/threadnote/fallback.md';

describe('recall candidate heading titles', () => {
  it('skips whitespace-only headings without consuming the next line', () => {
    const content = `#${Effect.pipe('\t', EffectString.repeat(65_536))}\n\n## Actual title\nBody text.`;

    expect(indexCandidate(uri, content, true).fields?.title).toBe('Actual title');
  });

  it('retains the URI title when no supported heading has text', () => {
    expect(indexCandidate(uri, '# \t\n#### Too deep\nOrdinary text', true).fields?.title).toBe('fallback.md');
  });

  it('extracts the same title for arbitrary Markdown heading levels and horizontal spacing', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 3}),
        fc.array(fc.constantFrom(' ', '\t'), {minLength: 1, maxLength: 200}),
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{0,60}$/),
        (level, spacing, title) => {
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
          const content = `Ordinary text\n${'#'.repeat(level)}${EffectArray.join(spacing, '')}${title}\t \nBody text.`;

          expect(indexCandidate(uri, content, true).fields?.title).toBe(Effect.pipe(title, EffectString.trim));
        },
      ),
      {numRuns: 50},
    );
  });
});
