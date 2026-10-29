import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import type {MemoryMetadata} from '@threadnote/memory/document';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function richRemoteMemoryMetadata(): MemoryMetadata {
  const timestamp = '2026-09-01T10:00:00.000Z';
  return {
    archivedFrom: 'threadnote://memory/tn_previous',
    authority: 'user_approved',
    candidateId: 'candidate-1',
    codeCitations: [
      createMemoryCodeCitation({
        extractorSet: 'native-code-graph-14',
        fileContentHash: {algorithm: 'sha256', value: Effect.pipe('a', EffectString.repeat(64))},
        path: 'src/example.ts',
        repositoryId: Effect.pipe('1', EffectString.repeat(64)),
        repositoryIdentityKind: 'remote',
        sourceCommit: Effect.pipe('2', EffectString.repeat(40)),
        sourceDirty: false,
        sourceGraphContentId: `cgc_${Effect.pipe('3', EffectString.repeat(40))}`,
        sourceSnapshotId: `cgsn_${Effect.pipe('4', EffectString.repeat(40))}`,
        target: {kind: 'file'},
        version: 1,
      }),
    ],
    createdAt: timestamp,
    evidence: ['session:turn-12', 'commit:abc123'],
    kind: 'durable',
    keywords: ['retained-keyword', 'second keyword', 'retained-keyword'],
    lastReviewed: timestamp,
    memoryId: 'tn_rich_memory',
    project: 'restricted',
    references: ['threadnote://memory/tn_first', 'threadnote://memory/tn_second'],
    relations: [
      {type: 'references', uri: 'threadnote://memory/tn_first'},
      {type: 'depends_on', uri: 'threadnote://memory/tn_second'},
    ],
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceHash: 'sha256:abc123',
    sourceAgentClient: 'codex',
    sourceCommit: 'abc123',
    sourceObservedAt: timestamp,
    sourceSessionId: 'session-1',
    status: 'active',
    supersedes: 'threadnote://memory/tn_previous',
    timestamp,
    topic: 'rich',
    trust: 'approved',
    updatedAt: timestamp,
    validFrom: timestamp,
    validTo: '2027-09-01T10:00:00.000Z',
    visibility: 'shared',
    workspaceScope: 'packages/example',
  };
}
