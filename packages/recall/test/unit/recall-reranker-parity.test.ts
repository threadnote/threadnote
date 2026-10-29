import {describe, expect, it} from '@effect/vitest';
import {
  evaluateRecallRerankerParity,
  parseRecallRerankerParityFixtureV1,
  type RecallRerankerParityFixtureV1,
} from '../../../../scripts/training/recall-reranker-parity.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('recall reranker Python/native parity', () => {
  it('passes bounded score drift while preserving meaningful Python ordering', () => {
    const fixture = parityFixture();
    const result = evaluateRecallRerankerParity(fixture, new Map([['validation-a', [0.89, 0.21, 0.195]]]), {
      maximumAbsoluteError: 0.02,
      minimumOrderingGap: 0.01,
    });

    expect(result.passed).toBe(true);
    expect(result.pairs).toBe(3);
    expect(result.absoluteError.failures).toBe(0);
    expect(result.ordering.comparisons).toBe(3);
    expect(result.ordering.failures).toHaveLength(0);
  });

  it('reports independent absolute-error and ordering failures', () => {
    const fixture = parityFixture();
    const result = evaluateRecallRerankerParity(fixture, new Map([['validation-a', [0.91, 0.25, 0.27]]]), {
      maximumAbsoluteError: 0.02,
      minimumOrderingGap: 0.01,
    });

    expect(result.passed).toBe(false);
    expect(result.absoluteError.failures).toBe(2);
    expect(result.ordering.failures).toEqual([
      expect.objectContaining({
        groupId: 'validation-a',
        leftCandidateId: 'negative-a',
        rightCandidateId: 'negative-b',
      }),
    ]);
  });

  it('rejects a fixture that is not validation-only or has non-finite scores', () => {
    const fixture = parityFixture();

    expect(() => parseRecallRerankerParityFixtureV1({...fixture, split: 'test'})).toThrow();
    expect(() =>
      parseRecallRerankerParityFixtureV1({
        ...fixture,
        groups: [
          {
            ...fixture.groups[0],
            candidates: [
              {...fixture.groups[0].candidates[0], pythonScore: Number.NaN},
              ...fixture.groups[0].candidates.slice(1),
            ],
          },
        ],
      }),
    ).toThrow(/invalid candidate|Expected a finite number/);
  });
});

function parityFixture(): RecallRerankerParityFixtureV1 {
  return {
    configurationSha256: Effect.pipe('a', EffectString.repeat(64)),
    dataset: {
      groupFileSha256: Effect.pipe('b', EffectString.repeat(64)),
      groupsSha256: Effect.pipe('c', EffectString.repeat(64)),
      manifestSha256: Effect.pipe('d', EffectString.repeat(64)),
      purpose: 'harness_smoke',
    },
    groups: [
      {
        candidates: [
          {candidateId: 'positive', document: 'Relevant evidence.', pythonScore: 0.9, relevance: 3},
          {candidateId: 'negative-a', document: 'Near distractor.', pythonScore: 0.22, relevance: 0},
          {candidateId: 'negative-b', document: 'Far distractor.', pythonScore: 0.19, relevance: 0},
        ],
        groupId: 'validation-a',
        query: 'Where is the retry policy configured?',
      },
    ],
    kind: 'threadnote_recall_reranker_python_parity',
    run: {
      modelTreeSha256: Effect.pipe('e', EffectString.repeat(64)),
      runJsonSha256: Effect.pipe('f', EffectString.repeat(64)),
      trainingCodeRevision: Effect.pipe('1', EffectString.repeat(40)),
    },
    runtimeTarget: {
      architecture: 'jina-bert',
      contextLimit: 8192,
      documentCharacterLimit: 4000,
      nodeLlamaCpp: '3.19.1',
    },
    scoring: {
      backend: 'sentence-transformers-cross-encoder',
      device: 'cpu',
      python: '3.12.5',
      sentenceTransformers: '5.6.1',
      torch: '2.13.0',
      transformers: '4.57.6',
    },
    selection: {algorithm: 'sha256-stratified-answerability-v1', maximumGroups: 8},
    split: 'validation',
    version: 1,
  };
}
