import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {planContextHealthCitationBatch} from '@threadnote/context/citation_validation';
import type {ContextBriefMemoryCandidateV1} from '@threadnote/context/types';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

function candidate(index: number, repository = index % 40): ContextBriefMemoryCandidateV1 {
  return {
    citationErrorCount: 0,
    codeCitations: [
      createMemoryCodeCitation({
        extractorSet: 'test',
        fileContentHash: {algorithm: 'sha256', value: Effect.pipe('a', EffectString.repeat(64))},
        path: `src/${index}.ts`,
        repositoryId: Effect.pipe(repository.toString(16), EffectString.padStart(64, '0')),
        repositoryIdentityKind: 'remote',
        sourceCommit: Effect.pipe('b', EffectString.repeat(40)),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect.pipe('c', EffectString.repeat(40))}`,
        target: {kind: 'file'},
        version: 1,
      }),
    ],
    excerpt: '',
    kind: 'durable',
    rank: index,
    uri: `threadnote://memory/${Effect.pipe(index.toString(), EffectString.padStart(5, '0'))}`,
  };
}

describe('Context Health citation traversal', () => {
  it.each([0, 1, 96, 97, 2_013])('visits all %s citations within both admission limits', count => {
    const candidates = Array.from({length: count}, (_, index) => candidate(index));
    let after: {uri: string; citationId: string} | undefined;
    const visited: string[] = [];
    for (let step = 0; step <= count; step += 1) {
      const batch = planContextHealthCitationBatch(candidates, {after});
      const citations = EffectArray.flatMap(batch.candidates, value => value.codeCitations);
      expect(citations.length).toBeLessThanOrEqual(96);
      expect(new Set(EffectArray.map(citations, value => value.repositoryId)).size).toBeLessThanOrEqual(32);
      visited.push(...EffectArray.map(batch.candidates, value => value.uri));
      after = batch.checkpoint.after;
      if (batch.checkpoint.complete) break;
    }
    expect(visited).toEqual(EffectArray.map(candidates, value => value.uri));
  });

  it('does not restart the prefix when a completed citation disappears', () => {
    const candidates = Array.from({length: 100}, (_, index) => candidate(index, 1));
    const first = planContextHealthCitationBatch(candidates);
    const next = planContextHealthCitationBatch(
      EffectArray.filter(candidates, value => value.uri !== first.checkpoint.after?.uri),
      {
        after: first.checkpoint.after,
      },
    );
    expect(EffectArray.map(next.candidates, value => value.uri)).toEqual(
      EffectArray.map(candidates.slice(96), value => value.uri),
    );
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
            ...EffectArray.flatMap(batch.candidates, value =>
              EffectArray.map(value.codeCitations, citation => `${value.uri}/${citation.id}`),
            ),
          );
          after = batch.checkpoint.after;
          if (batch.checkpoint.complete) break;
        }
        expect(visited).toEqual(
          EffectArray.flatMap(candidates, value =>
            EffectArray.map(value.codeCitations, citation => `${value.uri}/${citation.id}`),
          ),
        );
        expect(new Set(visited).size).toBe(count);
      }),
      {numRuns: 50},
    );
  });

  it('selects the same citation identities and selectors regardless of the cited memory kind', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('durable', 'handoff', 'incident', 'preference', 'smoke'), {maxLength: 120}),
        kinds => {
          const expected = EffectArray.map(kinds, (_, index) => candidate(index));
          const varied = EffectArray.map(expected, (subject, index) => ({...subject, kind: kinds[index]}));
          let after: {uri: string; citationId: string} | undefined;
          for (let step = 0; step <= kinds.length; step += 1) {
            const baseline = planContextHealthCitationBatch(expected, {after, batchSize: 13});
            const actual = planContextHealthCitationBatch(varied, {after, batchSize: 13});
            const identities = (batch: typeof actual) =>
              EffectArray.flatMap(batch.candidates, subject =>
                EffectArray.map(
                  subject.codeCitations,
                  citation => `${subject.uri}\0${citation.id}\0${citation.repositoryId}`,
                ),
              );
            expect(identities(actual)).toEqual(identities(baseline));
            expect(actual.checkpoint).toEqual(baseline.checkpoint);
            if (actual.checkpoint.complete) break;
            after = actual.checkpoint.after;
          }
        },
      ),
      {numRuns: 50},
    );
  });
});
