import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {extractorSetIdentityFromPackProvenance} from '@threadnote/graph/indexer';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  codeGraphLanguagePackProvenance,
  createCodeGraphLanguagePackRegistry,
} from '@threadnote/graph/languages/registry';
import {assessCodeGraphLanguagePackDelta} from '@threadnote/graph/languages/provenance';
import {codeGraphSnapshotMatchesCurrentLanguagePacks} from '@threadnote/graph/query';
import type {CodeGraphLanguagePackProvenance} from '@threadnote/graph/store';

const packIds = ['typescript', 'bazel', 'python', 'java'] as const;

describe('code graph language-pack provenance', () => {
  fcEffectProp(
    it,
    'selects exactly cache-identity changes independent of receipt ordering',
    {
      changed: FC.uniqueArray(FC.constantFrom(...packIds), {maxLength: packIds.length}),
      reversePrevious: FC.constantFrom(false, true),
      reverseCurrent: FC.constantFrom(false, true),
    },
    ({changed, reverseCurrent, reversePrevious}) =>
      Effect.sync(() => {
        const previous = EffectArray.map(packIds, pack);
        const changedIds = new Set<string>(changed);
        const current = EffectArray.map(previous, value =>
          changedIds.has(value.id) ? {...value, cacheIdentity: `${value.cacheIdentity}-next`} : value,
        );
        const result = assessCodeGraphLanguagePackDelta(
          reversePrevious ? [...previous].reverse() : previous,
          reverseCurrent ? [...current].reverse() : current,
        );
        expect(result).toEqual({changedPackIds: [...changed].sort(), mode: 'compatible'});
        expect(extractorSetIdentityFromPackProvenance(previous)).toBe(
          extractorSetIdentityFromPackProvenance([...previous].reverse()),
        );
      }),
    {fastCheck: {numRuns: 100}},
  );

  it.effect('fails closed when resolution derivation or active pack membership changes', () =>
    Effect.sync(() => {
      const previous = [pack('typescript'), pack('bazel')];
      expect(
        assessCodeGraphLanguagePackDelta(previous, [
          {...pack('typescript'), resolutionVersion: 'resolver-v2'},
          pack('bazel'),
        ]),
      ).toEqual({mode: 'fallback', reason: 'pack-surface-changed'});
      expect(assessCodeGraphLanguagePackDelta(previous, [pack('typescript')])).toEqual({
        mode: 'fallback',
        reason: 'pack-surface-changed',
      });
      expect(assessCodeGraphLanguagePackDelta([], previous)).toEqual({
        mode: 'fallback',
        reason: 'missing-provenance',
      });
    }),
  );

  fcEffectProp(
    it,
    'recognizes current snapshot contracts independent of active-pack ordering and rejects provenance drift',
    {
      activeIds: FC.uniqueArray(FC.constantFrom(...packIds), {minLength: 1}),
      reverseCatalog: FC.boolean(),
      reverseReceipt: FC.boolean(),
    },
    ({activeIds, reverseCatalog, reverseReceipt}) =>
      Effect.sync(() => {
        const activeIdSet = new Set<string>(activeIds);
        const selected = EffectArrayPipe(BUILTIN_LANGUAGE_PACK_REGISTRY.packs, __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (value, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && activeIdSet.has(value.id),
          ),
        );
        const registry = createCodeGraphLanguagePackRegistry(reverseCatalog ? [...selected].reverse() : selected);
        const provenance = EffectArray.map(selected, codeGraphLanguagePackProvenance);
        const extractorSet = extractorSetIdentityFromPackProvenance(provenance);
        const snapshot = {extractorSet};
        const storedProvenance = reverseReceipt ? [...provenance].reverse() : provenance;

        expect(codeGraphSnapshotMatchesCurrentLanguagePacks(snapshot, storedProvenance, registry)).toBe(true);
        expect(
          codeGraphSnapshotMatchesCurrentLanguagePacks(
            snapshot,
            EffectArray.map(storedProvenance, (value, index) =>
              index === 0 ? {...value, cacheIdentity: `${value.cacheIdentity}-stale`} : value,
            ),
            registry,
          ),
        ).toBe(false);
      }),
    {fastCheck: {numRuns: 100}},
  );
});

function pack(id: string): CodeGraphLanguagePackProvenance {
  return {
    cacheIdentity: `${id}-extractor-v1`,
    derivationIdentity: `${id}-derivation-v1`,
    id,
    resolutionDomain: id,
    resolutionVersion: 'resolver-v1',
  };
}
