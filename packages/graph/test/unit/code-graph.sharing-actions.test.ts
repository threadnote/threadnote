import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {
  graphShareLanguageAndRole,
  graphShareMaterializedActionKey,
  graphShareParseActionKey,
} from '@threadnote/graph/sharing/action';
import {
  GRAPH_SHARE_CAS_CANONICAL,
  GRAPH_SHARE_CAS_WORKER,
  graphShareActionDiscoveryTag,
  graphShareFrontierDiscoveryTag,
  isGraphShareCanonicalRegistry,
  isGraphShareWorkerRegistry,
} from '@threadnote/graph/sharing/namespace';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

const HEX = '0123456789abcdef';

describe('graph share action keys and namespaces', () => {
  it('keeps worker and canonical CAS namespaces distinct', () => {
    expect(GRAPH_SHARE_CAS_CANONICAL).not.toBe(GRAPH_SHARE_CAS_WORKER);
    expect(isGraphShareCanonicalRegistry(GRAPH_SHARE_CAS_CANONICAL)).toBe(true);
    expect(isGraphShareWorkerRegistry(GRAPH_SHARE_CAS_WORKER)).toBe(true);
    expect(isGraphShareWorkerRegistry(GRAPH_SHARE_CAS_CANONICAL)).toBe(false);
    expect(graphShareActionDiscoveryTag(Effect.pipe('a', EffectString.repeat(64)))).toBe(
      `tn-action-${Effect.pipe('a', EffectString.repeat(64))}`,
    );
    expect(
      Effect.pipe(
        graphShareFrontierDiscoveryTag(Effect.pipe('b', EffectString.repeat(64)), 'refs/heads/main'),
        EffectString.startsWith('tn-frontier-'),
      ),
    ).toBe(true);
  });

  it('is deterministic and changes when any parse-action input changes', () => {
    FC.assert(
      FC.property(
        FC.tuple(
          hexString(64),
          hexString(64),
          FC.string({maxLength: 40, minLength: 1}),
          hexString(64),
          FC.constantFrom('typescript:source', 'json:manifest'),
        ),
        FC.integer({max: 4, min: 0}),
        (fields, index) => {
          const [repositoryId, extractorSet, normalizedPath, contentHash, languageAndRole] = fields;
          const input = {contentHash, extractorSet, languageAndRole, normalizedPath, repositoryId};
          expect(graphShareParseActionKey(input)).toBe(graphShareParseActionKey({...input}));
          const mutated = [...fields];
          mutated[index] = `${mutated[index]}x`;
          const [nextRepositoryId, nextExtractorSet, nextPath, nextHash, nextLanguage] = mutated;
          expect(
            graphShareParseActionKey({
              contentHash: nextHash,
              extractorSet: nextExtractorSet,
              languageAndRole: nextLanguage,
              normalizedPath: nextPath,
              repositoryId: nextRepositoryId,
            }),
          ).not.toBe(graphShareParseActionKey(input));
        },
      ),
      {numRuns: 40},
    );
  });

  it('separates parse keys from materialized keys', () => {
    const parseKey = graphShareParseActionKey({
      contentHash: Effect.pipe('c', EffectString.repeat(64)),
      extractorSet: Effect.pipe('e', EffectString.repeat(64)),
      languageAndRole: graphShareLanguageAndRole('typescript', 'source'),
      normalizedPath: 'src/index.ts',
      repositoryId: Effect.pipe('r', EffectString.repeat(64)),
    });
    const materialized = graphShareMaterializedActionKey({
      contentHash: Effect.pipe('c', EffectString.repeat(64)),
      graphAbi: Effect.pipe('a', EffectString.repeat(64)),
      graphContentId: 'cgc_' + Effect.pipe('d', EffectString.repeat(40)),
      normalizedPath: 'src/index.ts',
      parseResultDigest: Effect.pipe('p', EffectString.repeat(64)),
      repositoryId: Effect.pipe('r', EffectString.repeat(64)),
      workspaceFingerprint: Effect.pipe('w', EffectString.repeat(64)),
    });
    expect(parseKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(materialized).toMatch(/^[0-9a-f]{64}$/u);
    expect(parseKey).not.toBe(materialized);
  });
});

function hexString(length: number) {
  return FC.array(FC.constantFrom(...HEX), {maxLength: length, minLength: length}).map(characters =>
    EffectArray.join(characters, ''),
  );
}
