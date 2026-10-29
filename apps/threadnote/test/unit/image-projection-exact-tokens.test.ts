import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  IMAGE_PROJECTION_EXACT_TOKEN_LIMIT,
  extractExactMemoryTokens,
  renderExactTokenAppendix,
} from '@threadnote/threadnote/image_projection/exact_tokens';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('image projection exact tokens', () => {
  it('extracts Threadnote identifiers and strips trailing URI punctuation', () => {
    const source = EffectArray.join(
      [
        'See threadnote://user/me/memories/durable/projects/threadnote/plan.md.',
        'memory_id: tn_abc123',
        'Continue with read_context cursor tnrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.',
        'node cgs_0123456789abcdef0123456789abcdef and handle cgr_repo_node',
        'duplicate tn_abc123',
      ],
      '\n',
    );
    expect(extractExactMemoryTokens(source)).toEqual([
      'threadnote://user/me/memories/durable/projects/threadnote/plan.md',
      'tn_abc123',
      'tnrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'cgs_0123456789abcdef0123456789abcdef',
      'cgr_repo_node',
    ]);
  });

  it('omits an appendix when no exact tokens are present', () => {
    expect(renderExactTokenAppendix([])).toBeUndefined();
    expect(extractExactMemoryTokens('plain prose without identifiers')).toEqual([]);
  });

  it('caps unique tokens at IMAGE_PROJECTION_EXACT_TOKEN_LIMIT', () => {
    const ids = Array.from(
      {length: IMAGE_PROJECTION_EXACT_TOKEN_LIMIT + 8},
      (_, index) => `tn_${Effect.pipe(index.toString(16), EffectString.padStart(8, '0'))}`,
    );
    expect(extractExactMemoryTokens(EffectArray.join(ids, ' '))).toHaveLength(IMAGE_PROJECTION_EXACT_TOKEN_LIMIT);
  });

  it('keeps extracted tokens as source substrings and caps uniqueness', () => {
    const filler = fc.stringMatching(/^[A-Za-z0-9 .,'-]{0,40}$/);
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('tn_deadbeef', 'tnrc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cgr_node'), {
          maxLength: 12,
          minLength: 1,
        }),
        filler,
        (ids, noise) => {
          const source = `${noise}\n${EffectArray.join(ids, ' and ')}\n${noise}`;
          const extracted = extractExactMemoryTokens(source);
          expect(extracted.length).toBeLessThanOrEqual(IMAGE_PROJECTION_EXACT_TOKEN_LIMIT);
          expect(new Set(extracted).size).toBe(extracted.length);
          for (const token of extracted) {
            expect(Effect.pipe(source, EffectString.includes(token))).toBe(true);
          }
          for (const id of ids) {
            expect(extracted).toContain(id);
          }
        },
      ),
    );
  });
});
