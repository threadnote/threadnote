import {Array as EffectArray} from 'effect';

/** Check an already typed array candidate without changing its readonly element type. */
export const isReadonlyArray = <A>(value: ReadonlyArray<A> | null | undefined): value is ReadonlyArray<A> =>
  EffectArray.isArray(value);
