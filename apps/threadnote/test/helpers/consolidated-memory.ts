import {captureConsolidationSource, reviewConsolidation} from '@threadnote/memory/consolidation';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';

export const privateRelation = 'threadnote://user/tester/memories/durable/projects/threadnote/private.md';
export const stableRelation = 'threadnote://memory/tn_dependency';
export const consolidatedUri = 'threadnote://user/tester/memories/durable/projects/threadnote/result.md';
export function consolidatedMemory(body = 'Approved conclusion.', active = true) {
  const citation = (path: string, local: boolean) =>
    createMemoryCodeCitation({
      version: 1,
      extractorSet: 'test',
      repositoryId: 'a'.repeat(64),
      repositoryIdentityKind: local ? 'local' : 'remote',
      sourceCommit: 'b'.repeat(40),
      sourceSnapshotId: `cgsn_${'c'.repeat(40)}`,
      sourceDirty: local,
      fileContentHash: {algorithm: 'sha256', value: 'd'.repeat(64)},
      path,
      target: {kind: 'file'},
    });
  const portable = citation('portable.ts', false);
  const historical = citation('private.ts', true);
  const base = {
    kind: 'durable' as const,
    status: 'active' as const,
    project: 'threadnote',
    topic: 'result',
    sourceAgentClient: 'test',
    timestamp: '2026-10-08T00:00:00.000Z',
    schemaVersion: 6,
  };
  const source = captureConsolidationSource({
    uri: consolidatedUri.replace('result.md', 'private-input.md'),
    content: formatMemoryDocument(
      'MEMORY',
      {
        ...base,
        memoryId: 'tn_private_input',
        codeCitations: [portable, historical],
        relations: [
          {type: 'depends_on', uri: privateRelation},
          {type: 'references', uri: stableRelation},
        ],
      },
      'Private discarded claim.\n\nPrivate contextual detail.',
    ),
  });
  const reviewed = reviewConsolidation(
    body,
    [source],
    [
      {
        section: body,
        disposition: active ? 'direct' : 'contextual',
        supports: [
          {
            sourceUri: source.uri,
            fragment: 1,
            citationIds: [active ? portable.id : historical.id],
            relationIndexes: active ? [0, 1] : [],
          },
        ],
      },
    ],
    {
      operationId: 'boundary-review',
      cleanup: 'keep',
      cleanupShared: false,
      target: {
        kind: base.kind,
        status: base.status,
        project: base.project,
        topic: base.topic,
        sourceAgentClient: 'manager',
      },
    },
  );
  const content = formatMemoryDocument(
    'MEMORY',
    {
      ...base,
      memoryId: 'tn_reviewed',
      codeCitations: reviewed.codeCitations,
      relations: reviewed.relations,
      consolidation: reviewed.provenance,
    },
    body,
  );
  const record = parseMemoryDocument(consolidatedUri, content);
  if (!record || record.metadata.consolidationError) throw new Error('Invalid consolidated fixture.');
  return record;
}
