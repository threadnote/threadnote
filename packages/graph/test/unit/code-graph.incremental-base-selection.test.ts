import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {gitCommitDistanceGroups} from '@threadnote/graph/incremental/base_selection';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

function objectId(index: number): string {
  return Effect.pipe(index.toString(16), EffectString.padStart(40, '0'));
}

describe('incremental clean-base ancestry', () => {
  it('keeps equally near merge parents in one ambiguous distance group', () => {
    const head = objectId(1);
    const left = objectId(2);
    const right = objectId(3);
    const base = objectId(4);

    expect(
      gitCommitDistanceGroups(
        EffectArray.join([`${head} ${left} ${right}`, `${right} ${base}`, `${left} ${base}`, base], '\n'),
        head,
      ),
    ).toEqual([[head], [left, right], [base]]);
  });

  it('fails closed for malformed, conflicting, or headless ancestry evidence', () => {
    const head = objectId(1);
    const parent = objectId(2);
    expect(gitCommitDistanceGroups('not-a-commit', head)).toEqual([]);
    expect(gitCommitDistanceGroups(`${head} ${parent}\n${head}`, head)).toEqual([]);
    expect(gitCommitDistanceGroups(parent, head)).toEqual([]);
  });

  it('includes a bounded frontier parent even when its own row is outside the rev-list window', () => {
    const head = objectId(1);
    const parent = objectId(2);
    expect(gitCommitDistanceGroups(`${head} ${parent}`, head)).toEqual([[head], [parent]]);
  });

  it('is deterministic under row and parent order and equals an independent shortest-distance model', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({max: 63, min: 0}), {maxLength: 6, minLength: 1}),
        fc.array(fc.integer(), {maxLength: 6, minLength: 6}),
        fc.array(fc.boolean(), {maxLength: 6, minLength: 6}),
        (masks, priorities, reverseParents) => {
          const ids = EffectArray.map(masks, (_, index) => objectId(index + 1));
          const parents = EffectArray.map(ids, (_, source) =>
            EffectArray.filter(ids, (__, target) => target > source && (masks[source] & (1 << target)) !== 0),
          );
          const lines = EffectArray.map(
            EffectArray.map(ids, (id, index) => ({
              id,
              index,
              parents: reverseParents[index] ? [...parents[index]].reverse() : parents[index],
              priority: priorities[index] ?? 0,
            })).sort((left, right) => left.priority - right.priority || left.index - right.index),
            row => EffectArray.join([row.id, ...row.parents], ' '),
          );

          expect(gitCommitDistanceGroups(EffectArray.join(lines, '\n'), ids[0])).toEqual(
            independentDistanceGroups(
              ids[0],
              new Map(EffectArray.map(ids, (id, index) => [id, parents[index]] as const)),
            ),
          );
        },
      ),
      {numRuns: 250},
    );
  });
});

function independentDistanceGroups(
  head: string,
  parentsByCommit: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
  const distance = new Map([[head, 0]]);
  let frontier = [head];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const commit of frontier) {
      for (const parent of parentsByCommit.get(commit) ?? []) {
        if (distance.has(parent)) continue;
        distance.set(parent, distance.get(commit)! + 1);
        next.push(parent);
      }
    }
    frontier = next;
  }
  const groups = new Map<number, string[]>();
  for (const [commit, value] of distance) groups.set(value, [...(groups.get(value) ?? []), commit]);
  return EffectArray.map(
    [...groups.entries()].sort(([left], [right]) => left - right),
    ([, commits]) => commits.sort(),
  );
}
