import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import {chunkRecallDocument, RECALL_CHUNKER_VERSION} from '@threadnote/recall/chunker';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('recall chunker', () => {
  it('preserves heading context, bounds chunks, and keeps stable identities', () => {
    const source = EffectArray.join(
      [
        '# Storage',
        '',
        'Canonical markdown remains authoritative.',
        '',
        '## Atomic writes',
        '',
        ...Array.from(
          {length: 80},
          (_, index) => `Paragraph ${index}: ${Effect.pipe('safe storage ', EffectString.repeat(8))}`,
        ),
      ],
      '\n\n',
    );
    const first = chunkRecallDocument('threadnote://resources/repos/threadnote/storage.md', source, {
      maxCharacters: 600,
      overlapCharacters: 60,
    });
    const second = chunkRecallDocument(
      'threadnote://resources/repos/threadnote/storage.md',
      Effect.pipe(source, EffectString.replaceAll('\n', '\r\n')),
      {
        maxCharacters: 600,
        overlapCharacters: 60,
      },
    );

    expect(first.length).toBeGreaterThan(2);
    expect(EffectArray.every(first, chunk => chunk.content.length <= 600)).toBe(true);
    expect(EffectArray.some(first, chunk => chunk.heading === 'Storage > Atomic writes')).toBe(true);
    expect(second).toEqual(first);
    expect(new Set(EffectArray.map(first, chunk => chunk.id)).size).toBe(first.length);
    expect(RECALL_CHUNKER_VERSION).toBe(3);
  });

  it('rejects unsafe overlap settings and omits empty documents', () => {
    expect(chunkRecallDocument('threadnote://resources/empty.md', ' \n')).toEqual([]);
    expect(() =>
      chunkRecallDocument('threadnote://resources/invalid.md', 'value', {
        maxCharacters: 256,
        overlapCharacters: 128,
      }),
    ).toThrow('invalid');
  });
});
