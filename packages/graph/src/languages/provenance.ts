import {Array as EffectArray} from 'effect';
import type {CodeGraphLanguagePackProvenance} from '../store/models.js';

export type CodeGraphLanguagePackDelta =
  | {
      readonly changedPackIds: readonly string[];
      readonly mode: 'compatible';
    }
  | {
      readonly mode: 'fallback';
      readonly reason: 'missing-provenance' | 'pack-surface-changed';
    };

/**
 * A cache-identity-only change means extraction changed while project and
 * resolution derivation stayed stable. Anything else fails closed because a
 * receipt alone cannot prove a bounded resolution closure.
 */
export function assessCodeGraphLanguagePackDelta(
  previous: readonly CodeGraphLanguagePackProvenance[],
  current: readonly CodeGraphLanguagePackProvenance[],
): CodeGraphLanguagePackDelta {
  if (previous.length === 0 || current.length === 0) return {mode: 'fallback', reason: 'missing-provenance'};
  const previousById = new Map(EffectArray.map(previous, pack => [pack.id, pack]));
  const currentById = new Map(EffectArray.map(current, pack => [pack.id, pack]));
  if (
    previousById.size !== previous.length ||
    currentById.size !== current.length ||
    previousById.size !== currentById.size ||
    EffectArray.some([...previousById.keys()], id => !currentById.has(id))
  ) {
    return {mode: 'fallback', reason: 'pack-surface-changed'};
  }
  const changedPackIds: string[] = [];
  for (const [id, before] of previousById) {
    const after = currentById.get(id)!;
    if (
      before.derivationIdentity !== after.derivationIdentity ||
      before.resolutionDomain !== after.resolutionDomain ||
      before.resolutionVersion !== after.resolutionVersion
    ) {
      return {mode: 'fallback', reason: 'pack-surface-changed'};
    }
    if (before.cacheIdentity !== after.cacheIdentity) changedPackIds.push(id);
  }
  return {changedPackIds: changedPackIds.sort(), mode: 'compatible'};
}
