import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  retainedTopicGenerationOutput,
  topicGenerationUsage,
  validateTopicGenerationSummary,
  topicGenerationDiagnosticSummary,
} from '../../src/topic-maintenance-generation.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('topic generation observations', () => {
  it('retains bounded UTF8 without changing full output identity', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'é', '界', '🙂', '\n', '\u0000'), {maxLength: 100}),
        fc.integer({min: 0, max: 70}),
        (characters, limit) => {
          const text = EffectArray.join(characters, '');
          const result = retainedTopicGenerationOutput(1, text, 'decoded-json', limit);
          expect(result.hash).toBe(sha256HexSync(text));
          expect(result.bytes).toBe(new TextEncoder().encode(text).byteLength);
          expect(result.retainedBytes).toBeLessThanOrEqual(limit);
          expect(result.retainedBytes).toBe(new TextEncoder().encode(result.text).byteLength);
          expect(Effect.pipe(text, EffectString.startsWith(result.text))).toBe(true);
          expect(result.truncated).toBe(result.text !== text);
        },
      ),
      {numRuns: 80},
    );
  });
  it('never treats partial usage as a measured total', () => {
    expect(
      topicGenerationUsage([{status: 'measured', inputTokens: 2, outputTokens: 3}, {status: 'unavailable'}]),
    ).toEqual({status: 'unavailable'});
    expect(
      topicGenerationUsage([
        {status: 'measured', inputTokens: 2, outputTokens: 3},
        {status: 'measured', inputTokens: 5, outputTokens: 7},
      ]),
    ).toEqual({status: 'measured', inputTokens: 7, outputTokens: 10});
  });
  it('rejects unordered attempts and private fields at the summary boundary', () => {
    const summary = {
      caseId: 'health-case-' + Effect.pipe('b', EffectString.repeat(40)),
      reviewId: 'review-' + Effect.pipe('c', EffectString.repeat(24)),
      targetHash: Effect.pipe('d', EffectString.repeat(64)),
      observationRevision: Effect.pipe('e', EffectString.repeat(64)),
      packetDigest: Effect.pipe('f', EffectString.repeat(64)),
      agent: 'local-ai',
      model: 'model',
      promptVersion: 'v5',
      version: 1,
      receiptId: 'topic-generation-' + Effect.pipe('a', EffectString.repeat(32)),
      state: 'failed',
      phase: 'generation',
      elapsedMilliseconds: 1,
      promptScope: 'user-prompt-utf8-sha256',
      attempts: [
        {
          ordinal: 2,
          promptHash: Effect.pipe('a', EffectString.repeat(64)),
          promptBytes: 3,
          status: 'provider-failed',
          elapsedMilliseconds: 1,
          usage: {status: 'unavailable'},
          output: {status: 'unavailable', reason: 'not-returned'},
        },
      ],
    };
    expect(() => validateTopicGenerationSummary(summary)).toThrow();
    summary.attempts[0].ordinal = 1;
    const before = JSON.stringify(summary);
    expect(validateTopicGenerationSummary(summary)).toEqual(summary);
    expect(JSON.stringify(summary)).toBe(before);
    expect(() => validateTopicGenerationSummary({...summary, firstFailedOutput: 'private'})).toThrow();
    expect(topicGenerationDiagnosticSummary({...summary, firstFailedOutput: 'private'})).toBeUndefined();
    fc.assert(
      fc.property(fc.integer({min: 1, max: 2}), fc.boolean(), (count, reverse) => {
        const attempts = Array.from({length: count}, (_, index) => ({
          ...summary.attempts[0],
          ordinal: index + 1,
          status: index < count - 1 ? 'draft-invalid' : 'provider-failed',
        }));
        const input = {...summary, elapsedMilliseconds: count, attempts: reverse ? [...attempts].reverse() : attempts};
        const before = JSON.stringify(input);
        if (reverse && count === 2) expect(() => validateTopicGenerationSummary(input)).toThrow();
        else
          expect(EffectArray.map(validateTopicGenerationSummary(input).attempts, attempt => attempt.ordinal)).toEqual(
            Array.from({length: count}, (_, index) => index + 1),
          );
        expect(JSON.stringify(input)).toBe(before);
      }),
      {numRuns: 24},
    );
  });
});
