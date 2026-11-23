import {Array as EffectArray} from 'effect';

export const RECALL_FUSION_WINDOW = 10;
const RRF_OFFSET = 60;
// The least common multiple of ranks' denominators 61 through 70.
// Scaled integer scores keep ties exact and remain within Number's safe range.
const RRF_SCALE = 142_813_628_717_760;

export function reciprocalRankFusion(hybrid: readonly string[], bm25: readonly string[]): readonly string[] {
  const scores = new Map<string, number>();
  for (const ranks of [hybrid, bm25]) {
    const seen = new Set<string>();
    for (const [index, uri] of ranks.slice(0, RECALL_FUSION_WINDOW).entries()) {
      if (seen.has(uri)) continue;
      seen.add(uri);
      scores.set(uri, (scores.get(uri) ?? 0) + RRF_SCALE / (RRF_OFFSET + index + 1));
    }
  }
  return EffectArray.map(
    [...scores.entries()].sort(
      ([left, leftScore], [right, rightScore]) =>
        rightScore - leftScore || (left < right ? -1 : left === right ? 0 : 1),
    ),
    ([uri]) => uri,
  );
}
