import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {isMemoryId, memoryIdentityAlias, memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {verifyResolvedMemoryIdentity} from '@threadnote/recall/memory/identity';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('stable memory identity aliases', () => {
  it('round-trips every valid bounded memory identity deterministically', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'), {
            maxLength: 128,
            minLength: 1,
          })
          .map(characters => `tn_${EffectArray.join(characters, '')}`),
        memoryId => {
          const alias = memoryIdentityAlias(memoryId);
          expect(isMemoryId(memoryId)).toBe(true);
          expect(memoryIdFromIdentityAlias(alias)).toBe(memoryId);
          expect(memoryIdentityAlias(memoryId)).toBe(alias);
          expect(Buffer.byteLength(alias, 'utf8')).toBeLessThanOrEqual(151);
        },
      ),
      {numRuns: 100},
    );
  });

  it.each([
    'threadnote://memory',
    'threadnote://memory/tn_',
    'threadnote://memory/tn_bad/value',
    'threadnote://memory/tn_bad#fragment',
    `threadnote://memory/tn_${Effect2.pipe('a', EffectString.repeat(129))}`,
    'threadnote://user/test/memories/tn_valid',
  ])('rejects malformed or non-identity URI %s', uri => {
    expect(memoryIdFromIdentityAlias(uri)).toBeUndefined();
  });

  effectIt.effect('fails closed when live bytes no longer carry the resolved identity', () =>
    Effect.gen(function* () {
      const alias = 'threadnote://memory/tn_expected';
      const canonicalUri = 'threadnote://user/test/memories/durable/projects/threadnote/identity.md';
      const error = yield* Effect.flip(
        verifyResolvedMemoryIdentity(
          {canonicalUri, expectedMemoryId: 'tn_expected', requestedUri: alias},
          canonicalUri,
          EffectArray.join(
            [
              'MEMORY',
              'kind: durable',
              'status: active',
              'memory_id: tn_reused_uri',
              'source_agent_client: test',
              'timestamp: 2026-08-31T00:00:00.000Z',
              '',
              'Different live identity.',
            ],
            '\n',
          ),
        ),
      );

      expect(error).toMatchObject({memoryId: 'tn_expected', reason: 'live-mismatch'});
    }),
  );
});
