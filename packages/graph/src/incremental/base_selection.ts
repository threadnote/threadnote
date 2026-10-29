import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export const CODE_GRAPH_INCREMENTAL_ANCESTRY_COMMIT_LIMIT = 512;

/**
 * Converts bounded `git rev-list --parents` evidence into shortest-distance
 * commit groups. A group with more than one reusable commit is intentionally
 * ambiguous; callers must fall back instead of selecting by output order.
 */
export function gitCommitDistanceGroups(output: string, headCommit: string): readonly (readonly string[])[] {
  if (!GIT_OBJECT_ID.test(headCommit)) return [];
  const parentsByCommit = new Map<string, readonly string[]>();
  for (const line of Effect2.pipe(output, EffectString.split('\n'))) {
    const fields = EffectArray.filter(Effect2.pipe(line, EffectString.trim, EffectString.split(/\s+/u)), Boolean);
    if (fields.length === 0) continue;
    if (EffectArray.some(fields, field => !GIT_OBJECT_ID.test(field))) return [];
    const commit = fields[0];
    if (commit === undefined) continue;
    const parents = fields.slice(1);
    const previous = parentsByCommit.get(commit);
    if (previous !== undefined && EffectArray.join(previous, '\0') !== EffectArray.join(parents, '\0')) return [];
    parentsByCommit.set(commit, parents);
  }
  if (!parentsByCommit.has(headCommit)) return [];

  const distanceByCommit = new Map<string, number>([[headCommit, 0]]);
  const queue = [headCommit];
  for (let index = 0; index < queue.length; index += 1) {
    const commit = queue[index];
    const distance = distanceByCommit.get(commit)!;
    for (const parent of parentsByCommit.get(commit) ?? []) {
      const nextDistance = distance + 1;
      const previousDistance = distanceByCommit.get(parent);
      if (previousDistance !== undefined && previousDistance <= nextDistance) continue;
      distanceByCommit.set(parent, nextDistance);
      queue.push(parent);
    }
  }

  const commitsByDistance = new Map<number, string[]>();
  for (const [commit, distance] of distanceByCommit) {
    const group = commitsByDistance.get(distance) ?? [];
    group.push(commit);
    commitsByDistance.set(distance, group);
  }
  return EffectArray.map(
    [...commitsByDistance.entries()].sort(([left], [right]) => left - right),
    ([, commits]) => commits.sort(),
  );
}

export function preferredIncrementalBaseCommitGroups(repoRoot: string, headCommit: string) {
  if (!GIT_OBJECT_ID.test(headCommit)) return Effect.succeed<readonly (readonly string[])[]>([]);
  return runCommandEffect(
    'git',
    [
      '-C',
      repoRoot,
      'rev-list',
      '--parents',
      `--max-count=${CODE_GRAPH_INCREMENTAL_ANCESTRY_COMMIT_LIMIT}`,
      headCommit,
    ],
    {
      maxOutputBytes: 256 * 1024,
      timeoutMs: 30_000,
    },
  ).pipe(
    Effect.map(result => gitCommitDistanceGroups(result.stdout, headCommit)),
    Effect.orElseSucceed(() => []),
  );
}
