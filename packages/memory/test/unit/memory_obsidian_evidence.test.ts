import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  formatMemoryDocumentWithKeywords,
  parseMemoryDocument,
  type MemoryObsidianEvidenceV1,
} from '@threadnote/memory/document';
import {memoryCodeCitationContentSharingBlocker} from '@threadnote/memory/code/citation-policy';

const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/decision.md';
const hash = 'a'.repeat(64);
const uuid = '12345678-1234-1234-1234-123456789abc';

function citation(relativePath: string): MemoryObsidianEvidenceV1 {
  return {
    version: 1,
    sourceId: 'notes',
    sourceInstanceId: uuid,
    vaultHash: hash,
    accessHash: hash,
    noteId: uuid,
    relativePath,
    revisionHash: hash,
    sanitizerVersion: 'scrubber-redact-v1',
    fragmentHash: hash,
    fragmentStart: 0,
    fragmentEnd: 4,
    pinId: uuid,
    expiresAt: '2026-12-01T00:00:00.000Z',
  };
}

describe('Obsidian memory evidence metadata', () => {
  it('bounds the complete serialized citation at the parser byte limit (property)', () => {
    const maxBytes = 4096;
    const fixedBytes = new TextEncoder().encode(JSON.stringify(citation(''))).byteLength;
    fc.assert(
      fc.property(fc.integer({min: 1, max: 16}), fc.integer({min: -2, max: 2}), (multibyteCount, offset) => {
        const pathBytes = maxBytes - fixedBytes + offset;
        const relativePath = `${'é'.repeat(multibyteCount)}${'a'.repeat(pathBytes - multibyteCount * 2)}`;
        const evidence = citation(relativePath);
        const serializedBytes = new TextEncoder().encode(JSON.stringify(evidence)).byteLength;
        const metadata = {
          kind: 'durable' as const,
          status: 'active' as const,
          sourceAgentClient: 'test',
          timestamp: '2026-10-09T00:00:00.000Z',
          schemaVersion: 7,
          obsidianEvidence: evidence,
        };

        if (serializedBytes <= maxBytes) {
          const formatted = formatMemoryDocument('MEMORY', metadata, 'Derived prose');
          expect(parseMemoryDocument(uri, formatted)?.metadata.obsidianEvidence).toEqual(evidence);
        } else {
          expect(() => formatMemoryDocument('MEMORY', metadata, 'Derived prose')).toThrow(/4096-byte|invalid/i);
        }
      }),
      {numRuns: 40},
    );
  });

  it('rejects an oversized citation before formatting the memory', () => {
    const evidence = citation(`${'é'.repeat(2000)}.md`);
    expect(new TextEncoder().encode(JSON.stringify(evidence)).byteLength).toBeGreaterThan(4096);
    expect(() =>
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          sourceAgentClient: 'test',
          timestamp: '2026-10-09T00:00:00.000Z',
          schemaVersion: 7,
          obsidianEvidence: evidence,
        },
        'Derived prose',
      ),
    ).toThrow(/4096-byte|invalid/i);
  });

  it('round trips safe paths without changing exact citation identity (property)', () => {
    const segment = fc
      .array(fc.constantFrom(...'abcXYZ012_-'.split('')), {minLength: 1, maxLength: 12})
      .map(chars => chars.join(''));
    fc.assert(
      fc.property(fc.array(segment, {minLength: 1, maxLength: 4}), segments => {
        const evidence = citation(`${segments.join('/')}.md`);
        const formatted = formatMemoryDocument(
          'MEMORY',
          {
            kind: 'durable',
            status: 'active',
            sourceAgentClient: 'test',
            timestamp: '2026-10-09T00:00:00.000Z',
            schemaVersion: 7,
            obsidianEvidence: evidence,
          },
          'Derived prose',
        );
        expect(parseMemoryDocument(uri, formatted)?.metadata.obsidianEvidence).toEqual(evidence);
        expect(memoryCodeCitationContentSharingBlocker(uri, formatted)).toBe('private-obsidian-evidence');
        expect(formatMemoryDocumentWithKeywords(formatted, ['decision'])).toContain(
          `obsidian_evidence: ${JSON.stringify(evidence)}`,
        );
      }),
      {numRuns: 50},
    );
  });

  it('blocks malformed citation shapes and schema rewrites', () => {
    const malformed = 'MEMORY\nkind: durable\nobsidian_evidence: {bad-json}\n\nDerived prose';
    expect(parseMemoryDocument(uri, malformed)?.metadata.obsidianEvidenceError).toBe(true);
    expect(memoryCodeCitationContentSharingBlocker(uri, malformed)).toBe('malformed-citation');
    expect(() => assertMemoryDocumentSchemaWritable(malformed)).toThrow(/Malformed Obsidian evidence/);
    expect(memoryCodeCitationContentSharingBlocker(uri, 'NOT MEMORY\nobsidian_evidence: {}\n\nText')).toBe(
      'malformed-citation',
    );
    const duplicate = `MEMORY\nkind: durable\nobsidian_evidence: ${JSON.stringify(citation('A.md'))}\nobsidian_evidence: ${JSON.stringify(citation('B.md'))}\n\nText`;
    expect(memoryCodeCitationContentSharingBlocker(uri, duplicate)).toBe('malformed-citation');
    expect(() =>
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          sourceAgentClient: 'test',
          timestamp: '2026-10-09T00:00:00.000Z',
          schemaVersion: 6,
          obsidianEvidence: citation('A.md'),
        },
        'Text',
      ),
    ).toThrow(/schema version 7/);
    const legacySchema = `MEMORY\nkind: durable\nschema_version: 6\nobsidian_evidence: ${JSON.stringify(citation('A.md'))}\n\nText`;
    expect(memoryCodeCitationContentSharingBlocker(uri, legacySchema)).toBe('malformed-citation');
    const unknownSchema = `MEMORY\nkind: durable\nschema_version: 999\nobsidian_evidence: ${JSON.stringify(citation('A.md'))}\nfuture: preserved\n\nText`;
    expect(() => assertMemoryDocumentSchemaWritable(unknownSchema)).toThrow(/newer than supported/);
  });
});
