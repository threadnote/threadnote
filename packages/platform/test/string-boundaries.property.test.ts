import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {parseMarkdownHeadingLine, stripFragment, trimBoundaryCharacters} from '@threadnote/platform/string-boundaries';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('linear string boundaries', () => {
  fcProp(
    it,
    'trims configured boundaries idempotently without changing the retained middle',
    {
      characters: FC.string({maxLength: 8}),
      value: FC.string({maxLength: 200}),
    },
    ({characters, value}) => {
      const trimmed = trimBoundaryCharacters(value, characters);
      expect(trimBoundaryCharacters(trimmed, characters)).toBe(trimmed);
      expect(Effect.pipe(value, EffectString.includes(trimmed))).toBe(true);
      if (trimmed) {
        expect(Effect.pipe(characters, EffectString.includes(trimmed[0]))).toBe(false);
        expect(
          Effect.pipe(
            characters,
            EffectString.includes(
              Effect.pipe(
                trimmed,
                EffectString.at(-1),
                Effect.Option.getOrElse(() => undefined),
              )!,
            ),
          ),
        ).toBe(false);
      }
    },
  );

  fcProp(
    it,
    'strips the first fragment deterministically and idempotently',
    {prefix: FC.string({maxLength: 100}), suffix: FC.string({maxLength: 100})},
    ({prefix, suffix}) => {
      const withoutHashes = Effect.pipe(prefix, EffectString.replaceAll('#', ''));
      expect(stripFragment(`${withoutHashes}#${suffix}`)).toBe(withoutHashes);
      expect(stripFragment(stripFragment(`${withoutHashes}#${suffix}`))).toBe(withoutHashes);
    },
  );

  it('parses bounded ATX headings and preserves literal closing hashes', () => {
    expect(parseMarkdownHeadingLine('### Title ###')).toEqual({level: 3, title: 'Title'});
    expect(parseMarkdownHeadingLine('## C#')).toEqual({level: 2, title: 'C#'});
    expect(parseMarkdownHeadingLine('####### Too deep')).toBeUndefined();
    expect(parseMarkdownHeadingLine(`# ${Effect.pipe('#', EffectString.repeat(100_000))}`)).toEqual({
      level: 1,
      title: Effect.pipe('#', EffectString.repeat(100_000)),
    });
  });
});
