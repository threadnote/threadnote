import {describe, expect, it} from 'vitest';
import * as fc from 'fast-check';
import {
  memoryCodeCitationContentSharingBlocker,
  memoryHasPrivateEvidenceProvenance,
} from '@threadnote/memory/code/citation-policy';

describe('memory code-citation sharing policy', () => {
  const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/projection.md';

  it('distinguishes ordinary code parse errors from private provenance for projections', () => {
    const content = 'MEMORY\nkind: durable\ncode_citation: {not-json}\n\nBody';
    expect(memoryCodeCitationContentSharingBlocker(uri, content)).toBe('malformed-citation');
    expect(memoryHasPrivateEvidenceProvenance(uri, content)).toBe(false);
    expect(memoryHasPrivateEvidenceProvenance(uri, 'MEMORY\nkind: durable\n\nobsidian_evidence: body text')).toBe(
      false,
    );
  });

  it('keeps private or unparseable provenance blocked alongside malformed code citations', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('obsidian_evidence', 'source_evidence', 'topic_maintenance'),
        fc.constantFrom('\n', '\r\n', '\r'),
        fc.constantFrom('', ' ', '\t'),
        fc.string({maxLength: 40}),
        (header, newline, spacing, canary) => {
          const content = [
            'MEMORY',
            'kind: durable',
            'code_citation: {not-json}',
            `${spacing}${header}${spacing}: ${JSON.stringify({canary})}`,
            '',
            'Private body',
          ].join(newline);
          expect(memoryHasPrivateEvidenceProvenance(uri, content)).toBe(true);
          expect(memoryCodeCitationContentSharingBlocker(uri, content)).toBe('malformed-citation');
        },
      ),
      {numRuns: 30},
    );
  });

  it('fails closed on a citation header even when the containing memory cannot be parsed', () => {
    const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/unparseable.md';

    expect(memoryCodeCitationContentSharingBlocker(uri, 'MEMORY\ncode_citation: {not-json}\n\nBody')).toBe(
      'malformed-citation',
    );
    expect(memoryCodeCitationContentSharingBlocker(uri, 'not a memory\ncode_citation: {not-json}\n\nBody')).toBe(
      'malformed-citation',
    );
    expect(memoryCodeCitationContentSharingBlocker(uri, 'not a memory\n  code_citation: {not-json}\n\nBody')).toBe(
      'malformed-citation',
    );
    expect(memoryCodeCitationContentSharingBlocker(uri, 'not a memory\r  code_citation: {not-json}\r\rBody')).toBe(
      'malformed-citation',
    );
    expect(memoryCodeCitationContentSharingBlocker(uri, 'not a memory\n\ncode_citation: body text')).toBeUndefined();
  });

  it.each(['\n', '\r\n', '\r'])('fails closed on near-canonical citation keys with %j line endings', newline => {
    const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/near-canonical.md';
    for (const citationLine of ['code_citation : {not-json}', 'code_citation\t: {not-json}']) {
      const parseable = [
        'MEMORY',
        'kind: durable',
        'project: threadnote',
        'topic: near-canonical',
        'schema_version: 4',
        citationLine,
        '',
        'Body',
      ].join(newline);
      const unparseable = ['not a memory', citationLine, '', 'Body'].join(newline);

      expect(memoryCodeCitationContentSharingBlocker(uri, parseable)).toBe('malformed-citation');
      expect(memoryCodeCitationContentSharingBlocker(uri, unparseable)).toBe('malformed-citation');
    }
  });
});
