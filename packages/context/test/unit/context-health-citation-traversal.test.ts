import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {planContextHealthCitationBatch} from '@threadnote/context/citation_validation';
import type {ContextBriefMemoryCandidateV1} from '@threadnote/context/types';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';

function candidate(index: number, repository = index % 40): ContextBriefMemoryCandidateV1 {
  return {
    citationErrorCount: 0,
    codeCitations: [
      createMemoryCodeCitation({
        extractorSet: 'test',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        path: `src/${index}.ts`,
        repositoryId: repository.toString(16).padStart(64, '0'),
        repositoryIdentityKind: 'remote',
        sourceCommit: 'b'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'c'.repeat(40)}`,
        target: {kind: 'file'},
        version: 1,
      }),
    ],
    excerpt: '',
    kind: 'durable',
    rank: index,
    uri: `threadnote://memory/${index.toString().padStart(5, '0')}`,
  };
}

describe('Context Health citation traversal', () => {
  it.each([0, 1, 96, 97, 2_013])('visits all %s citations within both admission limits', count => {
    const candidates = Array.from({length: count}, (_, index) => candidate(index));
    let after: {uri: string; citationId: string} | undefined;
    const visited: string[] = [];
    for (let step = 0; step <= count; step += 1) {
      const batch = planContextHealthCitationBatch(candidates, {after});
      const citations = batch.candidates.flatMap(value => value.codeCitations);
      expect(citations.length).toBeLessThanOrEqual(96);
      expect(new Set(citations.map(value => value.repositoryId)).size).toBeLessThanOrEqual(32);
      visited.push(...batch.candidates.map(value => value.uri));
      after = batch.checkpoint.after;
      if (batch.checkpoint.complete) break;
    }
    expect(visited).toEqual(candidates.map(value => value.uri));
  });

  it('does not restart the prefix when a completed citation disappears', () => {
    const candidates = Array.from({length: 100}, (_, index) => candidate(index, 1));
    const first = planContextHealthCitationBatch(candidates);
    const next = planContextHealthCitationBatch(
      candidates.filter(value => value.uri !== first.checkpoint.after?.uri),
      {
        after: first.checkpoint.after,
      },
    );
    expect(next.candidates.map(value => value.uri)).toEqual(candidates.slice(96).map(value => value.uri));
  });

  it('is deterministic and visits each eligible identity exactly once regardless of input order and batch size', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 230}), fc.integer({min: 1, max: 96}), (count, batchSize) => {
        const candidates = Array.from({length: count}, (_, index) => candidate(index));
        let after: {uri: string; citationId: string} | undefined;
        const visited: string[] = [];
        for (let step = 0; step <= count; step += 1) {
          const batch = planContextHealthCitationBatch([...candidates].reverse(), {after, batchSize});
          visited.push(
            ...batch.candidates.flatMap(value => value.codeCitations.map(citation => `${value.uri}/${citation.id}`)),
          );
          after = batch.checkpoint.after;
          if (batch.checkpoint.complete) break;
        }
        expect(visited).toEqual(
          candidates.flatMap(value => value.codeCitations.map(citation => `${value.uri}/${citation.id}`)),
        );
        expect(new Set(visited).size).toBe(count);
      }),
      {numRuns: 50},
    );
  });
});
