import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  InvalidProjectSeedPattern,
  validateProjectSeedPattern,
  validateProjectSeedPatterns,
} from '@threadnote/threadnote/seed_pattern';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

const segment = FC.stringMatching(/^[a-z][a-z0-9._-]{0,20}$/u).filter(value => value !== '..');

describe('project seed pattern safety', () => {
  fcProp(
    it,
    'preserves bounded repository-relative patterns byte for byte',
    {
      glob: FC.constantFrom('', '/*', '/**/*.md'),
      segments: FC.array(segment, {maxLength: 8, minLength: 1}),
    },
    ({glob, segments}) => {
      const pattern = `${EffectArray.join(segments, '/')}${glob}`;
      expect(validateProjectSeedPattern(pattern)).toBe(pattern);
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'rejects every generated parent traversal segment',
    {
      prefix: FC.array(segment, {maxLength: 5}),
      suffix: FC.array(segment, {maxLength: 5}),
    },
    ({prefix, suffix}) => {
      const pattern = EffectArray.join([...prefix, '..', ...suffix], '/');
      expect(() => validateProjectSeedPattern(pattern)).toThrow(InvalidProjectSeedPattern);
      expect(() => validateProjectSeedPattern(Effect.pipe(pattern, EffectString.replaceAll('/', '\\')))).toThrow(
        InvalidProjectSeedPattern,
      );
    },
    {fastCheck: {numRuns: 200}},
  );

  it('allows an empty project seed list but rejects rooted patterns', () => {
    expect(validateProjectSeedPatterns([])).toEqual([]);
    for (const pattern of ['/etc/passwd', '\\\\server\\share', 'C:\\Windows\\system.ini', '~/secrets']) {
      expect(() => validateProjectSeedPattern(pattern)).toThrow(InvalidProjectSeedPattern);
    }
  });
});
