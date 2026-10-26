import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  decodeNativeDocument,
  outlineNativeDocument,
  readNativeDocumentSection,
  renderNativeDocument,
} from '../src/documents.js';

const envelope = {
  schemaVersion: 1,
  templateVersion: 1,
  kind: 'plan',
  title: 'Plan café',
  sections: [
    {id: 'overview', heading: 'Overview', body: '  Café and 🧭.  '},
    {id: 'next-steps', heading: 'Next steps', body: 'Review the result.'},
  ],
} as const;

const caught = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('native document envelopes', () => {
  it('decodes and renders a stable UTF-8 Markdown document', () => {
    expect(decodeNativeDocument(envelope)).toEqual(envelope);
    expect(renderNativeDocument(envelope)).toBe(
      '# Plan café\n\n## Overview\n\nCafé and 🧭.\n\n## Next steps\n\nReview the result.\n',
    );
    expect(renderNativeDocument(envelope)).toBe(renderNativeDocument(decodeNativeDocument(envelope)));
  });

  it('rejects heading injection, duplicate or unsafe IDs, and unknown fields', () => {
    for (const invalid of [
      {...envelope, title: 'Title\n## injected'},
      {...envelope, title: '   '},
      {...envelope, sections: [{...envelope.sections[0], heading: 'Heading\n## injected'}]},
      {...envelope, sections: [envelope.sections[0], {...envelope.sections[1], id: envelope.sections[0].id}]},
      {...envelope, sections: [{...envelope.sections[0], id: '../outside'}]},
      {...envelope, sections: [{...envelope.sections[0], id: 'foo..bar'}]},
      {...envelope, path: '/private/document.md'},
      {...envelope, sections: []},
      {...envelope, sections: [{...envelope.sections[0], command: 'python script.py'}]},
      {...envelope, templateVersion: 2},
    ])
      expect(caught(() => decodeNativeDocument(invalid))).toMatchObject({code: 'invalid-document'});
  });

  it('rejects over-limit rendered UTF-8 bytes without truncation', () => {
    const oversized = {...envelope, sections: [{id: 'overview', heading: 'Overview', body: '🧭'.repeat(15_000)}]};
    expect(caught(() => decodeNativeDocument(oversized))).toMatchObject({code: 'invalid-document'});
    expect(caught(() => renderNativeDocument(oversized))).toMatchObject({code: 'invalid-document'});
  });

  it('returns a bounded outline with body byte counts and no body text', () => {
    const outline = outlineNativeDocument(envelope);
    expect(outline).toEqual({
      kind: 'plan',
      title: 'Plan café',
      sections: [
        {id: 'overview', heading: 'Overview', bytes: new TextEncoder().encode('Café and 🧭.').byteLength},
        {id: 'next-steps', heading: 'Next steps', bytes: new TextEncoder().encode('Review the result.').byteLength},
      ],
    });
    expect(JSON.stringify(outline)).not.toContain('Café and');
    expect(JSON.stringify(outline)).not.toContain('Review the result.');
  });

  it('accepts the complete native document kind set while retaining versioned strict decoding', () => {
    for (const kind of [
      'spec',
      'plan',
      'architecture-current',
      'architecture-target',
      'decisions',
      'alternatives',
      'phase',
      'handoff',
      'source',
      'history',
      'index',
      'experience',
    ] as const)
      expect(decodeNativeDocument({...envelope, kind}).kind).toBe(kind);
    expect(caught(() => decodeNativeDocument({...envelope, kind: 'python-plan'}))).toMatchObject({
      code: 'invalid-document',
    });
  });

  it('pages one section on UTF-8 boundaries and rejects stale digests, invalid offsets, and unbounded limits', () => {
    const doc = {...envelope, sections: [{id: 'overview', heading: 'Overview', body: '🧭 café 🌊'}]};
    const first = readNativeDocumentSection(doc, 'overview', {maxBytes: 4});
    expect(first.content).toBe('🧭');
    expect(new TextEncoder().encode(first.content).byteLength).toBe(4);
    expect(first.nextOffsetBytes).toBe(4);
    expect(first.sourceDigest).toBe(sha256HexSync(renderNativeDocument(doc)));
    const second = readNativeDocumentSection(doc, 'overview', {
      offsetBytes: first.nextOffsetBytes!,
      maxBytes: 6,
      sourceDigest: first.sourceDigest,
    });
    expect(second.content).toBe(' café');
    expect(() => readNativeDocumentSection(doc, 'missing')).toThrow(/section does not exist/u);
    expect(() => readNativeDocumentSection(doc, 'overview', {offsetBytes: 1})).toThrow(/splits a UTF-8/u);
    expect(() => readNativeDocumentSection(doc, 'overview', {offsetBytes: Number.MAX_SAFE_INTEGER + 1})).toThrow(
      /safe UTF-8 byte offsets/u,
    );
    expect(() => readNativeDocumentSection(doc, 'overview', {maxBytes: 16_001})).toThrow(/page size/u);
    expect(() => readNativeDocumentSection(doc, 'overview', {maxBytes: 3})).toThrow(/page size/u);
    expect(() =>
      readNativeDocumentSection({...doc, title: 'Changed'}, 'overview', {sourceDigest: first.sourceDigest}),
    ).toThrow(/document changed/u);
  });

  it('pages arbitrary bounded Unicode bodies losslessly with independently checked byte limits', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom('a', 'é', 'e\u0301', '漢', '🧭', '🌊', '\n', ' '), {maxLength: 120})
          .map(x => x.join('')),
        generated => {
          const doc = {...envelope, sections: [{id: 'overview', heading: 'Overview', body: generated}]};
          const expected = generated.trim();
          let offsetBytes = 0;
          let sourceDigest: string | undefined;
          let actual = '';
          let complete = false;
          for (let pageCount = 0; pageCount < 256 && !complete; pageCount += 1) {
            const page = readNativeDocumentSection(doc, 'overview', {
              offsetBytes,
              maxBytes: 7,
              ...(sourceDigest === undefined ? {} : {sourceDigest}),
            });
            expect(page.offsetBytes).toBe(offsetBytes);
            expect(new TextEncoder().encode(page.content).byteLength).toBeLessThanOrEqual(7);
            actual += page.content;
            sourceDigest = page.sourceDigest;
            if (page.nextOffsetBytes === null) complete = true;
            else {
              expect(page.nextOffsetBytes).toBeGreaterThan(offsetBytes);
              offsetBytes = page.nextOffsetBytes;
            }
          }
          expect(complete).toBe(true);
          expect(new TextEncoder().encode(actual)).toEqual(new TextEncoder().encode(expected));
        },
      ),
      {numRuns: 60},
    );
  });
});
