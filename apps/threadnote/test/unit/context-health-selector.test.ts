import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  CONTEXT_HEALTH_SELECTOR_MAXIMUM_BYTES,
  contextHealthSelectorCliFlags,
  normalizeContextHealthSelector,
  projectContextHealthRecords,
} from '@threadnote/threadnote/memory/context/health_selector';
import type {MemoryRecord} from '@threadnote/memory/document';

describe('context health selectors', () => {
  it('normalizes bounded exact intersections without narrowing the stored topic grammar', () => {
    const selector = normalizeContextHealthSelector({
      findingCategory: ' validity-expired ',
      kind: ' durable ',
      topic: '  release / v2: βeta  ',
    });

    expect(selector).toEqual({
      findingCategory: 'validity-expired',
      kind: 'durable',
      topic: 'release / v2: βeta',
    });
    expect(contextHealthSelectorCliFlags(selector, JSON.stringify)).toBe(
      ' --finding-category validity-expired --kind durable --topic "release / v2: βeta"',
    );
  });

  it.each([
    [{topic: ''}, '--topic must not be empty'],
    [{topic: 'unsafe\nvalue'}, '--topic contains control characters'],
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    [{topic: '🙂'.repeat(CONTEXT_HEALTH_SELECTOR_MAXIMUM_BYTES / 4 + 1)}, '--topic exceeds 256 UTF-8 bytes'],
    [{kind: 'unknown'}, 'Unknown --kind'],
    [{findingCategory: 'unknown'}, 'Unknown --finding-category'],
    [{after: 'hcx1_invalid'}, '--after must be an exact context-health continuation cursor'],
  ] as const)('rejects invalid selector input %#', (input, message) => {
    expect(() => normalizeContextHealthSelector(input)).toThrow(message);
  });

  it.each([
    ['U+0085 NEXT LINE', '\u0085'],
    ['U+009B CONTROL SEQUENCE INTRODUCER', '\u009b'],
    ['U+2028 LINE SEPARATOR', '\u2028'],
    ['U+2029 PARAGRAPH SEPARATOR', '\u2029'],
  ])('rejects %s anywhere in a topic', (_label, character) => {
    for (const topic of [`${character}safe`, `safe${character}value`, `safe${character}`]) {
      expect(() => normalizeContextHealthSelector({topic})).toThrow('--topic contains control characters');
    }
  });

  it('rejects every Unicode General_Category=Cc code point', () => {
    const controlCodePoints = [
      ...Array.from({length: 0x20}, (_, codePoint) => codePoint),
      ...Array.from({length: 0x21}, (_, offset) => 0x7f + offset),
    ];

    for (const codePoint of controlCodePoints) {
      expect(() => normalizeContextHealthSelector({topic: `${String.fromCodePoint(codePoint)}safe`})).toThrow(
        '--topic contains control characters',
      );
    }
  });

  it('projects category, kind, and topic as an intersection without widening', () => {
    const records = [record('durable', 'shared'), record('handoff', 'shared'), record('durable', 'other')];
    const kind = projectContextHealthRecords(records, normalizeContextHealthSelector({kind: 'durable'}));
    const topic = projectContextHealthRecords(records, normalizeContextHealthSelector({topic: 'shared'}));
    const combined = projectContextHealthRecords(
      records,
      normalizeContextHealthSelector({findingCategory: 'validity-expired', kind: 'durable', topic: 'shared'}),
    );

    expect(kind).toHaveLength(2);
    expect(topic).toHaveLength(2);
    expect(combined).toHaveLength(1);
    const kindUris = new Set(EffectArray.map(kind, item => item.uri));
    const topicUris = new Set(EffectArray.map(topic, item => item.uri));
    expect(EffectArray.every(combined, item => kindUris.has(item.uri))).toBe(true);
    expect(EffectArray.every(combined, item => topicUris.has(item.uri))).toBe(true);
  });
});

function record(kind: 'durable' | 'handoff', topic: string): MemoryRecord {
  return {
    body: 'Synthetic selector fixture.',
    content: 'Synthetic selector fixture.',
    headerTitle: kind === 'handoff' ? 'HANDOFF' : 'MEMORY',
    metadata: {
      kind,
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-18T00:00:00.000Z',
      topic,
    },
    uri: `threadnote://user/test/memories/${kind}/${topic}-${kind}.md`,
  };
}
