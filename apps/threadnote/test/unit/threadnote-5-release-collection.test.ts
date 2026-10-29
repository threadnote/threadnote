import {Array as EffectArray, Record as EffectRecord} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {projectionSelections, type NativeProjection} from '../../src/evaluation/threadnote-5-release-collection.js';

describe('release collection projection selections', () => {
  fcProp(
    it,
    'preserves native sparse array flatMap traversal',
    {
      leaves: FC.array(FC.string({maxLength: 20, minLength: 1}), {maxLength: 24}),
      holes: FC.array(FC.nat(23), {maxLength: 24}),
    },
    ({leaves, holes}) => {
      const values: NativeProjection[] = EffectArray.map(leaves, (select, index) => ({
        select,
        pointer: '/' + index,
        trial: index,
      }));
      for (const index of holes) if (index < values.length) delete values[index];
      const projection: NativeProjection = {array: values};
      expect(projectionSelections(projection)).toEqual(nativeProjectionSelections(projection));
    },
  );
});

function nativeProjectionSelections(
  projection: NativeProjection,
): readonly {select: string; pointer: string; trial: number}[] {
  if ('select' in projection) return [projection];
  if ('collect' in projection) return [{select: projection.collect, pointer: projection.pointer, trial: -1}];
  if ('array' in projection) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Native flatMap is the independent sparse-hole oracle.
    return projection.array.flatMap(nativeProjectionSelections);
  }
  return EffectArray.flatMap(EffectRecord.values(projection.object), nativeProjectionSelections);
}
