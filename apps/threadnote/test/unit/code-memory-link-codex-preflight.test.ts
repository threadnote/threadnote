import {describe, expect, it} from 'vitest';
import {
  assertCodeMemoryLinkGraphStatusPreflight,
  assertCodeMemoryLinkSelectedMemoryRosterV1,
  codeMemoryLinkContextBriefSelectedMemoriesV1,
} from '../../../../scripts/code-memory-link-codex-preflight.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('Code Memory Link Codex graph preflight', () => {
  const commit = Effect.pipe('1', EffectString.repeat(40));
  const repositoryRoot = '/private/evaluation/repository';
  const origin = 'https://fixtures.threadnote.invalid/code-memory-link/tsk_1111111111111111.git';
  const repositoryId = Effect.pipe('2', EffectString.repeat(64));

  it('requires the exact ready-current snapshot and repository identity', () => {
    expect(assertCodeMemoryLinkGraphStatusPreflight(status(), {commit, origin, repositoryRoot})).toEqual({
      graphContentId: `cgc_${Effect.pipe('4', EffectString.repeat(64))}`,
      snapshotId: `cgsnap_${Effect.pipe('3', EffectString.repeat(64))}`,
    });
    expect(
      assertCodeMemoryLinkGraphStatusPreflight({...status(), version: 3}, {commit, origin, repositoryRoot}),
    ).toEqual({
      graphContentId: `cgc_${Effect.pipe('4', EffectString.repeat(64))}`,
      snapshotId: `cgsnap_${Effect.pipe('3', EffectString.repeat(64))}`,
    });
    expect(
      assertCodeMemoryLinkGraphStatusPreflight({...status(), version: 4}, {commit, origin, repositoryRoot}),
    ).toEqual({
      graphContentId: `cgc_${Effect.pipe('4', EffectString.repeat(64))}`,
      snapshotId: `cgsnap_${Effect.pipe('3', EffectString.repeat(64))}`,
    });
    expect(
      assertCodeMemoryLinkGraphStatusPreflight({...status(), version: 5}, {commit, origin, repositoryRoot}),
    ).toEqual({
      graphContentId: `cgc_${Effect.pipe('4', EffectString.repeat(64))}`,
      snapshotId: `cgsnap_${Effect.pipe('3', EffectString.repeat(64))}`,
    });
  });

  it.each([
    [
      'head commit',
      (value: ReturnType<typeof status>) => ({
        ...value,
        identity: {...value.identity, headCommit: Effect.pipe('9', EffectString.repeat(40))},
      }),
    ],
    [
      'root',
      (value: ReturnType<typeof status>) => ({...value, identity: {...value.identity, repoRoot: '/private/other'}}),
    ],
    [
      'remote',
      (value: ReturnType<typeof status>) => ({
        ...value,
        identity: {...value.identity, remoteIdentity: 'example.invalid/other'},
      }),
    ],
    [
      'snapshot commit',
      (value: ReturnType<typeof status>) => ({
        ...value,
        readySnapshot: {...value.readySnapshot, commit: Effect.pipe('9', EffectString.repeat(40))},
      }),
    ],
    [
      'dirty snapshot',
      (value: ReturnType<typeof status>) => ({...value, readySnapshot: {...value.readySnapshot, dirty: true}}),
    ],
    [
      'building snapshot',
      (value: ReturnType<typeof status>) => ({...value, readySnapshot: {...value.readySnapshot, state: 'building'}}),
    ],
    [
      'other repository',
      (value: ReturnType<typeof status>) => ({
        ...value,
        readySnapshot: {...value.readySnapshot, repositoryId: Effect.pipe('9', EffectString.repeat(64))},
      }),
    ],
    [
      'missing content identity',
      (value: ReturnType<typeof status>) => ({
        ...value,
        readySnapshot: {...value.readySnapshot, graphContentId: undefined},
      }),
    ],
  ])('rejects %s', (_label, mutate) => {
    expect(() =>
      assertCodeMemoryLinkGraphStatusPreflight(mutate(status()), {commit, origin, repositoryRoot}),
    ).toThrow();
  });

  it('binds both ambiguous memories by exact identity and content', () => {
    const roster = codeMemoryLinkContextBriefSelectedMemoriesV1({
      activeHandoffs: [],
      durableDecisions: [
        {excerpt: 'opaque_a=enabled', uri: 'threadnote://memory/first'},
        {excerpt: 'opaque_a=disabled', uri: 'threadnote://memory/second'},
      ],
      type: 'context-brief',
      version: 3,
    });
    expect(roster).toHaveLength(2);
    expect(() => assertCodeMemoryLinkSelectedMemoryRosterV1(roster, roster)).not.toThrow();
    expect(() => assertCodeMemoryLinkSelectedMemoryRosterV1(roster, roster.slice(0, 1))).toThrow(
      'selected-memory identity/content roster',
    );
    expect(() =>
      assertCodeMemoryLinkSelectedMemoryRosterV1(roster, [
        {...roster[0], contentSha256: Effect.pipe('0', EffectString.repeat(64))},
        roster[1],
      ]),
    ).toThrow('selected-memory identity/content roster');
  });

  function status() {
    return {
      identity: {
        headCommit: commit,
        remoteIdentity: 'fixtures.threadnote.invalid/code-memory-link/tsk_1111111111111111',
        repoRoot: repositoryRoot,
        repositoryId,
      },
      readySnapshot: {
        commit,
        dirty: false,
        graphContentId: `cgc_${Effect.pipe('4', EffectString.repeat(64))}`,
        id: `cgsnap_${Effect.pipe('3', EffectString.repeat(64))}`,
        repositoryId,
        state: 'ready',
      },
      stale: false,
      type: 'code-graph-status',
      version: 2,
    };
  }
});
