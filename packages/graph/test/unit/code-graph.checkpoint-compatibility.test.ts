import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  codeGraphCheckpointAbiInputV1,
  inspectCodeGraphCheckpointCompatibilityV1,
} from '@threadnote/graph/checkpoint/compatibility';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, codeGraphLanguagePackProvenance} from '@threadnote/graph/languages/registry';
import {Array as EffectArray} from 'effect';

const provenance = EffectArray.map(BUILTIN_LANGUAGE_PACK_REGISTRY.packs, codeGraphLanguagePackProvenance);

describe('code graph checkpoint compatibility', () => {
  it('checks only the language packs active in the checkpoint', () => {
    const actual = codeGraphCheckpointAbiInputV1(provenance.slice(0, 2));

    expect(inspectCodeGraphCheckpointCompatibilityV1(actual, BUILTIN_LANGUAGE_PACK_REGISTRY)).toEqual({
      compatible: true,
      expected: actual,
    });
  });

  it('distinguishes unavailable packs from a changed semantic ABI', () => {
    const actual = codeGraphCheckpointAbiInputV1(provenance.slice(0, 1));
    const unavailable = {
      ...actual,
      languagePacks: [{...actual.languagePacks[0], id: 'future-pack'}],
    };
    const changed = {...actual, workspaceModelVersion: 'future-workspace-model'};

    expect(inspectCodeGraphCheckpointCompatibilityV1(unavailable, BUILTIN_LANGUAGE_PACK_REGISTRY)).toEqual({
      code: 'language-pack-unavailable',
      compatible: false,
      unavailablePackIds: ['future-pack'],
    });
    expect(inspectCodeGraphCheckpointCompatibilityV1(changed, BUILTIN_LANGUAGE_PACK_REGISTRY)).toMatchObject({
      code: 'abi-mismatch',
      compatible: false,
    });
  });

  it('assembles the same ABI for every input pack order', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(provenance, {minLength: provenance.length, maxLength: provenance.length}),
        value => {
          expect(codeGraphCheckpointAbiInputV1(value)).toEqual(codeGraphCheckpointAbiInputV1(provenance));
        },
      ),
      {numRuns: 32},
    );
  });
});
