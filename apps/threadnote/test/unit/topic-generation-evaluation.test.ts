import {readFile} from '@threadnote/testing/node-fs-promises';
import {describe, expect, it} from 'vitest';
import {
  topicStudyGenerationObservationV1,
  assertTopicStudyLedgerV1,
  parseTopicStudyCorpusJsonV1,
  topicStudyCorpusHashV1,
  topicStudyLedgerRowV1,
  topicStudyUnavailableObservationV1,
} from '../../src/evaluation/topic-maintenance-longitudinal.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const summary = {
  version: 1,
  receiptId: 'topic-generation-' + Effect.pipe('a', EffectString.repeat(32)),
  caseId: 'health-case-' + Effect.pipe('b', EffectString.repeat(40)),
  reviewId: 'review-' + Effect.pipe('c', EffectString.repeat(24)),
  targetHash: Effect.pipe('d', EffectString.repeat(64)),
  observationRevision: Effect.pipe('e', EffectString.repeat(64)),
  packetDigest: Effect.pipe('f', EffectString.repeat(64)),
  agent: 'local-ai',
  model: 'fixture',
  modelVersion: 'revision:digest',
  promptVersion: 'v5',
  state: 'failed',
  phase: 'generation',
  elapsedMilliseconds: 10,
  promptScope: 'user-prompt-utf8-sha256',
  attempts: [
    {
      ordinal: 1,
      promptHash: Effect.pipe('a', EffectString.repeat(64)),
      promptBytes: 6,
      status: 'provider-failed',
      elapsedMilliseconds: 10,
      usage: {status: 'unavailable'},
      output: {status: 'unavailable', reason: 'not-returned'},
    },
  ],
} as const;
const expected = {caseId: summary.caseId, agent: summary.agent, model: summary.model};
describe('versioned generation study observations', () => {
  it('reads success and failure summaries while rejecting mismatches and private fields', () => {
    expect(topicStudyGenerationObservationV1({diagnostics: summary}, expected)).toEqual(summary);
    expect(topicStudyGenerationObservationV1({maintenance: {generation: {observation: summary}}}, expected)).toEqual(
      summary,
    );
    expect(topicStudyGenerationObservationV1({maintenance: {generation: {attempts: 1}}}, expected)).toBeUndefined();
    expect(() => topicStudyGenerationObservationV1({diagnostics: {...summary, model: 'other'}}, expected)).toThrow();
    expect(() =>
      topicStudyGenerationObservationV1({diagnostics: {...summary, firstFailedOutput: 'private'}}, expected),
    ).toThrow();
  });
  it('round-trips an optional observation without changing legacy row identity or singular prompt scope', async () => {
    const corpus = parseTopicStudyCorpusJsonV1(
      await readFile('apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1/sequence.json', 'utf8'),
    );
    const event = corpus.events[0];
    const observation = topicStudyUnavailableObservationV1(event, 'fixture');
    const base = {
      corpusHash: topicStudyCorpusHashV1(corpus),
      runNonce: 'observations',
      arm: 'maintained-local' as const,
      repetition: 1,
      eventIndex: event.index,
      eventId: event.id,
      previousHash: null,
    };
    const legacy = topicStudyLedgerRowV1({...base, observation});
    expect(assertTopicStudyLedgerV1(JSON.stringify(legacy), corpus)[0]).toEqual(legacy);
    const extended = topicStudyLedgerRowV1({
      ...base,
      observation: {...observation, generationObservation: summary},
    });
    const parsed = assertTopicStudyLedgerV1(JSON.stringify(extended), corpus)[0];
    expect(parsed.observation.generationObservation).toEqual(summary);
    expect(parsed.observation.promptHash).toBeNull();
    expect(extended.hash).not.toBe(legacy.hash);
  });
});
