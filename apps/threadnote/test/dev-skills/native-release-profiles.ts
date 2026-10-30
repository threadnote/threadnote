import {Array} from 'effect';

export function selectNativeReleaseProfiles(available: readonly string[], selected = 'all'): readonly string[] {
  if (selected === 'all') return [...available];
  if (!Array.contains(available, selected)) throw new Error(`Unavailable native release profile: ${selected}`);
  return [selected];
}
