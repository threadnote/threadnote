import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {selectAffectedMemories} from '@threadnote/threadnote/context_check/commands';
import type {MemoryRecord} from '@threadnote/memory/document';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('context check citation selection', () => {
  it('respects repository identity and repository case mode', () => {
    const current = record('current', 'Source.ts');
    const other = record('other', 'Source.ts');
    expect(selectAffectedMemories([current, other], 'current', ['source.ts'])).toEqual([]);
    expect(selectAffectedMemories([current, other], 'current', ['source.ts'], 'insensitive')).toEqual([current]);
  });

  it('has set semantics for changed paths and cannot select another repository', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/u), {maxLength: 20}), names => {
        const paths = EffectArray.map(names, name => `${name}.ts`);
        const current = EffectArray.map(paths, path => record('current', path));
        const other = EffectArray.map(paths, path => record('other', path));
        expect(selectAffectedMemories([...other, ...current], 'current', [...paths, ...paths].reverse())).toEqual(
          current,
        );
        expect(selectAffectedMemories(current, 'current', [])).toEqual([]);
      }),
      {numRuns: 40},
    );
  });
});

function record(repositoryId: string, path: string): MemoryRecord {
  return {
    body: '',
    content: '',
    headerTitle: 'MEMORY',
    uri: `threadnote://memory/${repositoryId}/${path}`,
    metadata: {
      kind: 'durable',
      project: 'test',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-17T00:00:00.000Z',
      codeCitations: [
        {
          extractorSet: 'test',
          fileContentHash: {algorithm: 'sha256', value: Effect.pipe('a', EffectString.repeat(64))},
          id: 'citation',
          path,
          repositoryId,
          repositoryIdentityKind: 'local',
          sourceCommit: Effect.pipe('b', EffectString.repeat(40)),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${Effect.pipe('c', EffectString.repeat(40))}`,
          target: {kind: 'file'},
          version: 1,
        },
      ],
    },
  };
}
