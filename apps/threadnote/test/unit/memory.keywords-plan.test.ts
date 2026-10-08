import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  resolveMemoryKeywordPlan,
  shouldEnrichForKeywordPlan,
  tryResolveMemoryKeywordPlan,
} from '@threadnote/threadnote/memory/keywords';

describe('resolveMemoryKeywordPlan', () => {
  it('falls through to automatic on a fresh memory', () => {
    expect(resolveMemoryKeywordPlan({})).toEqual({mode: 'automatic'});
  });

  it('treats fresh-memory clear as a no-op automatic', () => {
    expect(resolveMemoryKeywordPlan({clearKeywords: true})).toEqual({mode: 'automatic'});
  });

  it('preserves prior keywords by default', () => {
    expect(resolveMemoryKeywordPlan({replacedKeywords: ['arc', 'karpenter']})).toEqual({
      mode: 'preserved',
      keywords: ['arc', 'karpenter'],
    });
  });

  it('normalizes preserved keywords and falls through when nothing usable remains', () => {
    expect(resolveMemoryKeywordPlan({replacedKeywords: ['  ARC  ', 'arc', 'x', '']})).toEqual({
      mode: 'preserved',
      keywords: ['ARC'],
    });
    expect(resolveMemoryKeywordPlan({replacedKeywords: ['x', '  ']})).toEqual({mode: 'automatic'});
  });

  it('clears only when prior keywords exist', () => {
    expect(resolveMemoryKeywordPlan({clearKeywords: true, replacedKeywords: ['arc']})).toEqual({
      mode: 'cleared',
    });
  });

  it('regenerates personal memories and rejects shared regeneration', () => {
    expect(resolveMemoryKeywordPlan({regenerateKeywords: true, replacedKeywords: ['arc']})).toEqual({
      mode: 'regenerate',
    });
    expect(() => resolveMemoryKeywordPlan({regenerateKeywords: true, replacedKeywords: ['arc'], shared: true})).toThrow(
      /shared/i,
    );
  });

  it('stores explicit keywords normalized', () => {
    expect(resolveMemoryKeywordPlan({keywords: [' jitconfig ', 'jitconfig', 'karpenter']})).toEqual({
      mode: 'explicit',
      keywords: ['jitconfig', 'karpenter'],
    });
  });

  it('rejects mutually exclusive options with CLI spellings by default', () => {
    for (const input of [
      {keywords: ['arc'], clearKeywords: true},
      {keywords: ['arc'], regenerateKeywords: true},
      {clearKeywords: true, regenerateKeywords: true},
    ] as const) {
      expect(() => resolveMemoryKeywordPlan(input)).toThrow(/--keyword.*--clear-keywords.*--regenerate-keywords/);
    }
    expect(() => resolveMemoryKeywordPlan({keywords: ['   ']})).toThrow(/non-empty/);
  });

  it('uses MCP field names on the MCP surface', () => {
    expect(() => resolveMemoryKeywordPlan({keywords: ['arc'], clearKeywords: true, surface: 'mcp'})).toThrow(
      /keywords, clearKeywords, or regenerateKeywords/,
    );
  });

  it('accepts explicit handoff keywords without enrichment and rejects smoke authoring', () => {
    const plan = resolveMemoryKeywordPlan({keywords: [' arc ', 'arc'], kind: 'handoff', replacedKeywords: ['old']});
    expect(plan).toEqual({mode: 'explicit', keywords: ['arc']});
    expect(shouldEnrichForKeywordPlan(plan)).toBe(false);
    expect(() => resolveMemoryKeywordPlan({keywords: ['arc'], kind: 'smoke'})).toThrow(/smoke/);
  });

  it('rejects generation for handoffs and smoke while preserving clear and replace controls', () => {
    for (const kind of ['handoff', 'smoke'] as const) {
      expect(() => resolveMemoryKeywordPlan({regenerateKeywords: true, kind, replacedKeywords: ['old']})).toThrow(
        `Keyword regeneration is not supported for ${kind} memories.`,
      );
    }
    expect(resolveMemoryKeywordPlan({clearKeywords: true, kind: 'handoff', replacedKeywords: ['old']})).toEqual({
      mode: 'cleared',
    });
    expect(resolveMemoryKeywordPlan({kind: 'handoff', replacedKeywords: ['old']})).toEqual({
      mode: 'preserved',
      keywords: ['old'],
    });
  });

  it('preserves explicit handoff keywords across replacement without mutation or generation', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z][a-z0-9]{2,20}$/), {minLength: 1, maxLength: 40}), keywords => {
        const original = [...keywords];
        const expected = [...new Set(keywords)].slice(0, 32);
        const authored = resolveMemoryKeywordPlan({kind: 'handoff', keywords, replacedKeywords: ['obsolete']});
        expect(authored).toEqual({mode: 'explicit', keywords: expected});
        expect(shouldEnrichForKeywordPlan(authored)).toBe(false);
        const replaced = resolveMemoryKeywordPlan({kind: 'handoff', replacedKeywords: expected});
        expect(replaced).toEqual({mode: 'preserved', keywords: expected});
        expect(shouldEnrichForKeywordPlan(replaced)).toBe(false);
        expect(keywords).toEqual(original);
      }),
      {numRuns: 50},
    );
  });

  it('caps explicit keywords at 32', () => {
    const keywords = Array.from({length: 40}, (_, index) => `keyword number ${index}`);
    const plan = resolveMemoryKeywordPlan({keywords});
    expect(plan.mode).toBe('explicit');
    if (plan.mode === 'explicit') {
      expect(plan.keywords).toHaveLength(32);
    }
  });
});

describe('tryResolveMemoryKeywordPlan', () => {
  it('returns the plan on success and the message on failure', () => {
    expect(tryResolveMemoryKeywordPlan({replacedKeywords: ['arc']})).toEqual({
      plan: {mode: 'preserved', keywords: ['arc']},
    });
    const outcome = tryResolveMemoryKeywordPlan({keywords: ['arc'], clearKeywords: true});
    expect('message' in outcome && outcome.message).toMatch(/Choose only one/);
  });
});
