import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {classifyGitIngestDocument} from '@threadnote/remote-memory/git/ingest_document';

const path = {kind: 'durable' as const, project: 'threadnote', topic: 'contract'};
const header = 'MEMORY\nkind: durable\nproject: threadnote\ntopic: contract';

describe('Git ingestion metadata boundary', () => {
  it.each(['# MEMORY\nPlain Markdown.', 'A normal memory.', ''])('keeps plain Markdown active: %s', content => {
    expect(classifyGitIngestDocument(content, path)).toEqual({accepted: true, status: 'active'});
  });

  it.each([
    'status:',
    'status: invalid',
    'status: active\nstatus: active',
    'kind: durable',
    'project: other',
    'project:',
    'repo: threadnote',
    'topic: wrong',
    'topic:',
    'schema_version:',
    'schema_version: 0',
    'schema_version: 1.2',
    'schema_version: 999',
    'schema_version: 4\nschema_version: 4',
  ])('rejects ambiguous or unsupported critical metadata: %s', field => {
    expect(classifyGitIngestDocument(`${header}\n${field}\n\nSafe body.`, path)).toEqual({
      accepted: false,
      reason: 'metadata',
    });
  });

  it('supports omitted legacy status and the project alias', () => {
    expect(classifyGitIngestDocument(`${header.replace('project:', 'repo:')}\n\nSafe body.`, path)).toEqual({
      accepted: true,
      status: 'active',
    });
  });

  it('rejects private imported-note evidence from Git share ingestion', () => {
    const citation = {
      version: 1,
      sourceId: 'notes',
      sourceInstanceId: '12345678-1234-1234-1234-123456789abc',
      vaultHash: 'a'.repeat(64),
      accessHash: 'a'.repeat(64),
      noteId: '12345678-1234-1234-1234-123456789abc',
      relativePath: 'Decision.md',
      revisionHash: 'a'.repeat(64),
      sanitizerVersion: 'scrubber-redact-v1',
      fragmentHash: 'a'.repeat(64),
      fragmentStart: 0,
      fragmentEnd: 4,
      pinId: '12345678-1234-1234-1234-123456789abc',
      expiresAt: '2026-12-01T00:00:00.000Z',
    } as const;
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        project: 'threadnote',
        topic: 'contract',
        sourceAgentClient: 'test',
        timestamp: '2026-10-09T00:00:00.000Z',
        schemaVersion: 7,
        obsidianEvidence: citation,
      },
      'Private derived prose.',
    );
    expect(classifyGitIngestDocument(content, path)).toEqual({accepted: false, reason: 'metadata'});
    expect(
      classifyGitIngestDocument(`${header}\nobsidian_evidence: {bad-json}\n\nPrivate derived prose.`, path),
    ).toEqual({accepted: false, reason: 'metadata'});
  });

  it.each([
    ['NOT MEMORY', `schema_version: 7\nobsidian_evidence: ${JSON.stringify(privateEvidence())}`],
    ['NOT MEMORY', 'obsidian_evidence: {bad-json}'],
    ['NOT MEMORY', `schema_version: 7\n obsidian_evidence : ${JSON.stringify(privateEvidence())}`],
    ['NOT MEMORY', ' obsidian_evidence : {bad-json}'],
    ['HANDOFF', `kind: handoff\nschema_version: 7\nobsidian_evidence: ${JSON.stringify(privateEvidence())}`],
    ['HANDOFF', 'obsidian_evidence: {bad-json}'],
    ['HANDOFF', `kind: handoff\nschema_version: 7\n obsidian_evidence : ${JSON.stringify(privateEvidence())}`],
    ['HANDOFF', ' obsidian_evidence : {bad-json}'],
  ])('rejects private evidence before legacy or mismatched marker acceptance: %s / %s', (marker, fields) => {
    const targetPath = marker === 'HANDOFF' ? {...path, kind: 'handoff' as const} : path;
    expect(classifyGitIngestDocument(`${marker}\n${fields}\n\nPrivate derived prose.`, targetPath)).toEqual({
      accepted: false,
      reason: 'metadata',
    });
  });

  it('preserves lifecycle classification across supported kinds, statuses, and portable identities', () => {
    FC.assert(
      FC.property(
        FC.constantFrom('durable' as const, 'handoff' as const),
        FC.constantFrom('active' as const, 'archived' as const, 'expired' as const, 'superseded' as const),
        FC.stringMatching(/^[a-z][a-z0-9]{0,12}$/),
        FC.stringMatching(/^[a-z][a-z0-9]{0,12}$/),
        (kind, status, project, topic) => {
          const content = formatMemoryDocument(
            kind === 'durable' ? 'MEMORY' : 'HANDOFF',
            {
              kind,
              status,
              project,
              topic,
              schemaVersion: 4,
              sourceAgentClient: 'test',
              timestamp: '2026-09-07T00:00:00.000Z',
              keywords: ['preserved metadata'],
              references: ['https://example.com/contract'],
            },
            'Safe content.',
          );
          expect(classifyGitIngestDocument(content, {kind, project, topic})).toEqual({accepted: true, status});
        },
      ),
      {numRuns: 64},
    );
  });
});

function privateEvidence() {
  return {
    version: 1,
    sourceId: 'notes',
    sourceInstanceId: '12345678-1234-1234-1234-123456789abc',
    vaultHash: 'a'.repeat(64),
    accessHash: 'a'.repeat(64),
    noteId: '12345678-1234-1234-1234-123456789abc',
    relativePath: 'Decision.md',
    revisionHash: 'a'.repeat(64),
    sanitizerVersion: 'scrubber-redact-v1',
    fragmentHash: 'a'.repeat(64),
    fragmentStart: 0,
    fragmentEnd: 4,
    pinId: '12345678-1234-1234-1234-123456789abc',
    expiresAt: '2026-12-01T00:00:00.000Z',
  } as const;
}
