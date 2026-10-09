import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  formatMemoryDocumentWithKeywords,
  parseMemoryDocument,
} from '@threadnote/memory/document';
import {memoryCodeCitationContentSharingBlocker} from '@threadnote/memory/code/citation-policy';
import type {SourceEvidenceCitationV1} from '@threadnote/store/source-evidence';

const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/evidence.md';
const hash = 'a'.repeat(64);

const evidence: SourceEvidenceCitationV1 = {
  version: 1,
  provider: 'github',
  sourceId: 'issues',
  sourceInstanceId: hash,
  resourceUri: 'threadnote://resources/external/github/issues/docs/r-1-issue-1/pages/main/chunk-1.md',
  accessHash: hash,
  revisionHash: hash,
  contentHash: hash,
  rendererVersion: 'github-v1',
  sanitizerVersion: 'scrubber-redact-v1',
  fragmentHash: hash,
  fragmentStart: 0,
  fragmentEnd: 4,
  pinId: '12345678-1234-4234-8234-123456789abc',
  expiresAt: '2026-12-01T00:00:00.000Z',
};

function document(citation: SourceEvidenceCitationV1 = evidence): string {
  return formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      status: 'active',
      sourceAgentClient: 'test',
      timestamp: '2026-10-09T00:00:00.000Z',
      schemaVersion: 8,
      sourceEvidence: citation,
    },
    'Derived prose.',
  );
}

describe('source evidence memory boundary', () => {
  it('round trips immutable private citation through keyword edits', () => {
    const formatted = document();
    expect(parseMemoryDocument(uri, formatted)?.metadata.sourceEvidence).toEqual(evidence);
    const changed = formatMemoryDocumentWithKeywords(formatted, ['decision']);
    expect(parseMemoryDocument(uri, changed)?.metadata.sourceEvidence).toEqual(evidence);
    expect(memoryCodeCitationContentSharingBlocker(uri, changed)).toBe('private-source-evidence');
  });

  it('rejects malformed, duplicate, noncanonical, and legacy-schema source citations', () => {
    const citationLine = `source_evidence: ${JSON.stringify(evidence)}`;
    for (const raw of [
      'source_evidence: {bad-json}',
      `${citationLine}\n${citationLine}`,
      ` source_evidence: ${JSON.stringify(evidence)}`,
      `source_evidence:  ${JSON.stringify(evidence)}`,
    ]) {
      const content = `MEMORY\nkind: durable\nschema_version: 8\n${raw}\n\nDerived prose.`;
      expect(parseMemoryDocument(uri, content)?.metadata.sourceEvidenceError).toBe(true);
      expect(memoryCodeCitationContentSharingBlocker(uri, content)).toBe('malformed-citation');
      expect(() => assertMemoryDocumentSchemaWritable(content)).toThrow(/source evidence/i);
    }
    const legacy = `MEMORY\nkind: durable\nschema_version: 7\n${citationLine}\n\nDerived prose.`;
    expect(memoryCodeCitationContentSharingBlocker(uri, legacy)).toBe('malformed-citation');
    expect(() => assertMemoryDocumentSchemaWritable(legacy)).toThrow(/source evidence/i);
  });

  it('keeps the exact private citation immutable across safe body edits (property)', () => {
    fc.assert(
      fc.property(
        fc.string({minLength: 1, maxLength: 100}).filter(value => value.trim().length > 0),
        body => {
          const formatted = formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'active',
              sourceAgentClient: 'test',
              timestamp: '2026-10-09T00:00:00.000Z',
              schemaVersion: 8,
              sourceEvidence: evidence,
            },
            body,
          );
          expect(parseMemoryDocument(uri, formatted)?.metadata.sourceEvidence).toEqual(evidence);
          expect(memoryCodeCitationContentSharingBlocker(uri, formatted)).toBe('private-source-evidence');
        },
      ),
      {numRuns: 40},
    );
  });
});
