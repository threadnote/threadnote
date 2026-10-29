import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {applyScrubber, redactSensitiveText, SCRUBBER_PATTERNS} from '@threadnote/platform/scrubber';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const text = FC.array(FC.constantFrom('a', 'b', 'c', 'A', 'B', 'C', '0', '1', ' ', '\n', 'é', '😀'), {
  maxLength: 60,
}).map(characters => EffectArray.join(characters, ''));
const flags = FC.constantFrom('', 'g', 'i', 'gi', 'm', 'gm', 's', 'gs', 'y', 'gy', 'iy', 'giy', 'u', 'gu', 'uy', 'guy');
const source = FC.constantFrom('[a-c]+', 'a|b', '(?=a)', '^a', 'a$', '\\s+', '[é😀]', 'a.*?b', '[01]');

function uncachedCustomRedaction(content: string, regex: RegExp, placeholder: string) {
  if (!new RegExp(regex.source, regex.flags).test(content)) return {cleaned: content, redactions: []};
  const global = new RegExp(
    regex.source,
    Effect.pipe(regex.flags, EffectString.includes('g')) ? regex.flags : `${regex.flags}g`,
  );
  return {
    cleaned: Effect.pipe(content, EffectString.replace(global, placeholder)),
    redactions: [
      {
        count: (
          Effect.pipe(
            content,
            EffectString.match(global),
            Effect.Option.getOrElse(() => null),
          ) ?? []
        ).length,
        name: 'custom',
      },
    ],
  };
}

describe('private scrubber matching clones', () => {
  fcProp(
    it,
    'matches fresh native regexes across same-owner mutation, repetition and restoration',
    {
      steps: FC.array(FC.record({flags, lastIndex: FC.integer({max: 100, min: 0}), source, text}), {
        maxLength: 12,
        minLength: 1,
      }),
      placeholder: FC.constantFrom('<mask>', '$&', '$$', '$`', "$'"),
    },
    ({steps, placeholder}) => {
      const regex = /a/;
      for (const step of [...steps, steps[0]]) {
        regex.compile(step.source, step.flags);
        regex.lastIndex = step.lastIndex;
        const expected = uncachedCustomRedaction(step.text, regex, placeholder);
        for (let repeat = 0; repeat < 2; repeat += 1) {
          expect(
            applyScrubber(step.text, {additionalPatterns: [{name: 'custom', placeholder, regex}], redact: true}),
          ).toEqual(expected);
          expect(regex.lastIndex).toBe(step.lastIndex);
          expect(regex.source).toBe(step.source);
          expect(regex.flags).toBe(new RegExp(step.source, step.flags).flags);
        }
      }
    },
    {fastCheck: {numRuns: 75}},
  );

  it('observes catalog regex recompilation without changing caller-owned state', () => {
    const regex = SCRUBBER_PATTERNS[0].regex;
    const initial = {flags: regex.flags, lastIndex: regex.lastIndex, source: regex.source};
    try {
      regex.compile('ALPHA', 'g');
      regex.lastIndex = 50;
      expect(redactSensitiveText('ALPHA BETA ALPHA')).toBe('<secret> BETA <secret>');
      expect(regex.lastIndex).toBe(50);
      regex.compile('beta', 'gi');
      regex.lastIndex = 25;
      expect(redactSensitiveText('ALPHA BETA ALPHA')).toBe('ALPHA <secret> ALPHA');
      expect(regex.lastIndex).toBe(25);
      regex.compile('ALPHA', 'g');
      expect(redactSensitiveText('ALPHA BETA ALPHA')).toBe('<secret> BETA <secret>');
    } finally {
      regex.compile(initial.source, initial.flags);
      regex.lastIndex = initial.lastIndex;
    }
    expect(redactSensitiveText('-----BEGIN RSA PRIVATE KEY-----')).toBe('<secret>');
  });

  it('keeps repeated credential and local-path redaction byte-compatible', () => {
    const token = EffectArray.join(['ghp_', 'abcdefghijklmnopqrst'], '');
    const input = `token=value ${token} /Users/example/work C:\\Users\\example\\work`;
    for (let repeat = 0; repeat < 3; repeat += 1) {
      expect(redactSensitiveText(input)).toBe('token=[REDACTED] <secret> <local-path> <local-path>');
      expect(applyScrubber(input, {redact: true})).toEqual({blocker: 'GitHub token', cleaned: input, redactions: []});
    }
  });

  it('redacts quoted and bearer assignments while preserving labels and separators', () => {
    expect(
      redactSensitiveText(
        EffectArray.join(
          ['api_key = "two words"', 'authorization: Bearer abc.def', "session='opaque'", 'url=https://example.com'],
          '\n',
        ),
      ),
    ).toBe(
      EffectArray.join(
        ['api_key = [REDACTED]', 'authorization: [REDACTED]', 'session=[REDACTED]', 'url=https://example.com'],
        '\n',
      ),
    );
  });

  it('preserves output when an oversized pattern evicts the retained clone', () => {
    const regex = /a/;
    for (const pattern of ['a', Effect.pipe('a', EffectString.repeat(65_537)), 'a']) {
      regex.compile(pattern, 'g');
      regex.lastIndex = 7;
      const content = pattern;
      expect(
        applyScrubber(content, {additionalPatterns: [{name: 'custom', placeholder: '<mask>', regex}], redact: true}),
      ).toEqual(uncachedCustomRedaction(content, regex, '<mask>'));
      expect(regex.lastIndex).toBe(7);
    }
  });
});
