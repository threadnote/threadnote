import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_DETACHED_READY_COUNT_MAXIMUM,
  CODE_GRAPH_DETACHED_READY_ESTIMATED_BYTES_MAXIMUM,
  estimatedCodeGraphSnapshotRetentionBytes,
  selectCodeGraphSnapshotRetention,
  type CodeGraphSnapshotRetentionCandidate,
} from '@threadnote/graph/snapshot/retention';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const candidateArbitrary: fc.Arbitrary<CodeGraphSnapshotRetentionCandidate> = fc.record({
  commit: fc.stringMatching(/^[0-9a-f]{40}$/u),
  completedAt: fc
    .integer({max: 999_999, min: 0})
    .map(
      value =>
        `2026-08-${Effect.pipe(String((value % 28) + 1), EffectString.padStart(2, '0'))}T00:00:${Effect.pipe(String(value % 60), EffectString.padStart(2, '0'))}.000Z`,
    ),
  edgeCount: fc.integer({max: 10_000_000, min: 0}),
  graphContentId: fc.option(fc.stringMatching(/^[0-9a-f]{40}$/u), {nil: undefined}),
  hasNewerEquivalent: fc.boolean(),
  id: fc.uuid(),
  repositoryId: fc.stringMatching(/^[0-9a-f]{64}$/u),
  symbolCount: fc.integer({max: 1_000_000, min: 0}),
});

describe('code graph snapshot retention', () => {
  it('is deterministic, partitions candidates exactly once, and keeps every repository within both caps', () => {
    fc.assert(
      fc.property(fc.array(candidateArbitrary, {maxLength: 80}), candidates => {
        const first = selectCodeGraphSnapshotRetention(candidates);
        const second = selectCodeGraphSnapshotRetention([...candidates].reverse());
        expect(second).toEqual(first);
        expect(EffectArray.map([...first.retain, ...first.retire], value => value.id).sort()).toEqual(
          EffectArray.map(candidates, value => value.id).sort(),
        );
        for (const repositoryId of new Set(EffectArray.map(first.retain, value => value.repositoryId))) {
          const retained = EffectArray.filter(first.retain, value => value.repositoryId === repositoryId);
          expect(retained.length).toBeLessThanOrEqual(CODE_GRAPH_DETACHED_READY_COUNT_MAXIMUM);
          const bytes = EffectArray.reduce(
            retained,
            0,
            (total, value) => total + estimatedCodeGraphSnapshotRetentionBytes(value),
          );
          if (retained.length > 1) expect(bytes).toBeLessThanOrEqual(CODE_GRAPH_DETACHED_READY_ESTIMATED_BYTES_MAXIMUM);
        }
        expect(EffectArray.every(first.retain, value => !value.hasNewerEquivalent)).toBe(true);
      }),
      {numRuns: 250},
    );
  });

  it('always keeps the newest unique detached snapshot even when its estimate alone exceeds the byte cap', () => {
    const candidate: CodeGraphSnapshotRetentionCandidate = {
      commit: Effect.pipe('a', EffectString.repeat(40)),
      completedAt: '2026-08-10T00:00:00.000Z',
      edgeCount: 10_000_000,
      graphContentId: 'cgc_newest',
      hasNewerEquivalent: false,
      id: `cgsn_${Effect.pipe('1', EffectString.repeat(40))}`,
      repositoryId: Effect.pipe('b', EffectString.repeat(64)),
      symbolCount: 1_000_000,
    };
    expect(selectCodeGraphSnapshotRetention([candidate]).retain).toEqual([candidate]);
  });
});
