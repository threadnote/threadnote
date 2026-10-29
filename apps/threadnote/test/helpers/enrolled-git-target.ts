import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

/** A valid existing shared enrollment for legacy-publication boundary tests, with no live enrollment API. */
export function enrolledGitTarget(memoryId: string): string {
  const body = 'Prior contract.';
  const citation = createMemoryCodeCitation({
    version: 1,
    evidenceRetention: 'capsule-retained',
    extractorSet: 'test',
    fileContentHash: {algorithm: 'sha256', value: Effect.pipe('a', EffectString.repeat(64))},
    path: 'source.ts',
    repositoryId: Effect.pipe('b', EffectString.repeat(64)),
    repositoryIdentityKind: 'remote',
    sourceCommit: Effect.pipe('c', EffectString.repeat(40)),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}`,
    target: {kind: 'file'},
  });
  return formatMemoryDocument(
    'MEMORY',
    {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: 'durable',
      status: 'active',
      project: 'threadnote',
      topic: 'architecture',
      memoryId,
      sourceAgentClient: 'test',
      timestamp: '2026-10-16T00:00:00.000Z',
      visibility: 'shared',
      authority: 'user_approved',
      trust: 'approved',
      codeCitations: [citation],
      topicMaintenance: {
        version: 1,
        memoryId,
        repositoryId: citation.repositoryId,
        bodyHash: sha256HexSync(body),
        coverage: 'declared-only',
        paragraphs: [
          {ordinal: 0, hash: sha256HexSync(body), role: 'descriptive', support: 'direct', citationIds: [citation.id]},
        ],
        additionalDependencies: [],
      },
    },
    body,
  );
}
