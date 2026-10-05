import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect, vi} from 'vitest';
import {managerContextHealthRecordPreviews} from '@threadnote/threadnote/manager/attention';
import type {ManagerContextHealthResponseV1} from '@threadnote/manager/attention/contracts';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';

const evidence = vi.hoisted(() => ({calls: 0}));
vi.mock('@threadnote/context/citation_validation', async importOriginal => {
  const original = await importOriginal<typeof import('@threadnote/context/citation_validation')>();
  return {
    ...original,
    readContextHealthCitationEvidence: () => {
      evidence.calls++;
      return Effect.succeed({coverage: 'unavailable', generation: 'synthetic', attemptedSteps: [], excerpts: []});
    },
  };
});

const citation = createMemoryCodeCitation({
  extractorSet: 'synthetic',
  fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
  path: 'src/example.ts',
  repositoryId: 'b'.repeat(64),
  repositoryIdentityKind: 'remote',
  sourceCommit: 'c'.repeat(40),
  sourceDirty: false,
  sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
  target: {
    fragmentCanonicalization: 'utf8-source-span-v1',
    fragmentHash: {algorithm: 'sha256', value: 'e'.repeat(64)},
    kind: 'symbol',
    language: 'typescript',
    name: 'supported',
    nodeId: `cgs_${'f'.repeat(32)}`,
    qualifiedName: 'module.supported',
    span: {column: 1, endColumn: 10, endLine: 12, line: 12},
    symbolKind: 'function',
  },
  version: 1,
});
const uri = 'threadnote://memory/synthetic-preview';
const content = formatMemoryDocument(
  'MEMORY',
  {
    kind: 'durable',
    schemaVersion: 5,
    project: 'synthetic',
    status: 'active',
    timestamp: '2026-10-04T00:00:00.000Z',
    sourceAgentClient: 'test',
    topic: 'synthetic-preview',
    codeCitations: [citation],
  },
  '# Synthetic heading\n\nSupporting statement.',
);
const record = parseMemoryDocument(uri, content);
if (record === undefined) throw new Error('Invalid synthetic preview record.');
const findings = [
  {id: 'finding-1', uris: [uri], repair: {targetUri: `${uri}#${citation.id}`}},
  {id: 'finding-2', uris: [uri], repair: {targetUri: `${uri}#${citation.id}`}},
] as unknown as ManagerContextHealthResponseV1['findings'];

describe('Manager Context Health list previews', () => {
  effectIt.effect('keeps canonical memory and citation labels without reading native source evidence', () =>
    Effect.gen(function* () {
      evidence.calls = 0;
      const previews = yield* managerContextHealthRecordPreviews([record], findings);
      expect(evidence.calls).toBe(0);
      expect(previews).toEqual([
        {
          uri,
          title: 'Synthetic heading',
          excerpt: 'Supporting statement.',
          kind: 'durable',
          topic: 'synthetic-preview',
          code: [
            {
              citationId: citation.id,
              findingIds: ['finding-1', 'finding-2'],
              path: 'src/example.ts',
              line: 12,
              targetLabel: 'module.supported',
            },
          ],
        },
      ]);
    }),
  );
});
