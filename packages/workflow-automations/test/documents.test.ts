import {describe, expect, it} from 'vitest';
import {decodeNativeDocument, outlineNativeDocument, renderNativeDocument} from '../src/documents.js';

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
});
