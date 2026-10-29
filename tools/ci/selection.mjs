import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

// External module resolution can affect every target even when bazel-diff reports no local impact.
const globalInputs = new Set(['MODULE.bazel.lock']);

/**
 * @param {{
 *   inventory: readonly string[];
 *   impacted: readonly string[];
 *   changedFiles: readonly string[];
 *   knownInputs: readonly string[];
 *   targetDependencies?: Readonly<Record<string, readonly string[]>>;
 *   targetInputs?: Readonly<Record<string, readonly string[]>>;
 *   failure?: string;
 * }} input
 */
export function selectTargets({
  inventory,
  impacted,
  changedFiles,
  knownInputs,
  targetDependencies = {},
  targetInputs = {},
  failure,
}) {
  const all = [...new Set(inventory)].sort();
  const known = new Set([...knownInputs, ...globalInputs]);
  const unknown = EffectArray.filter(changedFiles, path => !known.has(path)).sort();
  if (failure || unknown.length)
    return {mode: 'fallback', reason: failure ?? 'unmodeled-inputs', unknown, targets: all};
  if (
    !EffectArray.isArray(impacted) ||
    EffectArray.some(impacted, label => typeof label !== 'string' || !Effect.pipe(label, EffectString.startsWith('//')))
  ) {
    return {mode: 'fallback', reason: 'invalid-impacted-targets', unknown: [], targets: all};
  }
  if (EffectArray.some(changedFiles, path => globalInputs.has(path)))
    return {mode: 'fallback', reason: 'global-inputs', unknown: [], targets: all};
  const affected = new Set(impacted);
  const changed = new Set(changedFiles);
  for (const label of all) {
    if (EffectArray.some(targetInputs[label] ?? [], path => changed.has(path))) affected.add(label);
  }
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const label of all) {
      if (
        affected.has(label) ||
        !EffectArray.some(targetDependencies[label] ?? [], dependency => affected.has(dependency))
      )
        continue;
      affected.add(label);
      propagated = true;
    }
  }
  return {
    mode: 'selective',
    reason: 'bazel-diff',
    unknown: [],
    targets: EffectArray.filter(all, label => affected.has(label)),
  };
}
