import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {shouldReuseReadySnapshotForCleanCommit} from '@threadnote/graph/indexer';
import {shouldAttachSharedReadySnapshot} from '@threadnote/graph/query';
import {codeGraphWatcherRefreshIndexRequest} from '@threadnote/graph/watcher';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const commit = Effect.pipe('a', EffectString.repeat(40));
const otherCommit = Effect.pipe('b', EffectString.repeat(40));
const graphContentId = `cgc_${Effect.pipe('1', EffectString.repeat(40))}`;
const otherGraphContentId = `cgc_${Effect.pipe('2', EffectString.repeat(40))}`;

describe('shouldAttachSharedReadySnapshot', () => {
  it('promotes when the worktree is clean and a HEAD-matching candidate is unused', () => {
    expect(
      shouldAttachSharedReadySnapshot({
        candidate: {commit, dirty: false, id: 'cgsn_shared'},
        headCommit: commit,
        overlayDirty: false,
        readySnapshot: undefined,
      }),
    ).toBe(true);
  });

  it('no-ops when the worktree is dirty', () => {
    expect(
      shouldAttachSharedReadySnapshot({
        candidate: {commit, dirty: false, id: 'cgsn_shared'},
        headCommit: commit,
        overlayDirty: true,
        readySnapshot: undefined,
      }),
    ).toBe(false);
  });

  it('no-ops when there is no reusable candidate', () => {
    expect(
      shouldAttachSharedReadySnapshot({
        headCommit: commit,
        overlayDirty: false,
        readySnapshot: undefined,
      }),
    ).toBe(false);
  });

  it('no-ops when the worktree pointer already matches the candidate', () => {
    expect(
      shouldAttachSharedReadySnapshot({
        candidate: {commit, dirty: false, id: 'cgsn_shared'},
        headCommit: commit,
        overlayDirty: false,
        readySnapshot: {commit, id: 'cgsn_shared'},
      }),
    ).toBe(false);
  });

  it('rejects dirty or wrong-commit candidates', () => {
    expect(
      shouldAttachSharedReadySnapshot({
        candidate: {commit, dirty: true, id: 'cgsn_dirty'},
        headCommit: commit,
        overlayDirty: false,
      }),
    ).toBe(false);
    expect(
      shouldAttachSharedReadySnapshot({
        candidate: {commit: otherCommit, dirty: false, id: 'cgsn_other'},
        headCommit: commit,
        overlayDirty: false,
      }),
    ).toBe(false);
  });

  it('still attaches a clean shared candidate when only local overlay dirtiness matters', () => {
    // Sibling dirty overlays must not be modeled as overlayDirty on this worktree.
    expect(
      shouldAttachSharedReadySnapshot({
        candidate: {commit, dirty: false, id: 'cgsn_shared'},
        headCommit: commit,
        overlayDirty: false,
        readySnapshot: undefined,
      }),
    ).toBe(true);
  });

  fcProp(
    it,
    'attaches only for clean overlays with a distinct HEAD-matching clean candidate',
    {
      candidateCommit: FC.constantFrom(commit, otherCommit),
      candidateDirty: FC.boolean(),
      candidateId: FC.constantFrom('cgsn_a', 'cgsn_b'),
      hasCandidate: FC.boolean(),
      hasReady: FC.boolean(),
      overlayDirty: FC.boolean(),
      readyId: FC.constantFrom('cgsn_a', 'cgsn_b'),
    },
    ({candidateCommit, candidateDirty, candidateId, hasCandidate, hasReady, overlayDirty, readyId}) => {
      const candidate = hasCandidate ? {commit: candidateCommit, dirty: candidateDirty, id: candidateId} : undefined;
      const readySnapshot = hasReady ? {commit, id: readyId} : undefined;
      const expected =
        !overlayDirty &&
        candidate !== undefined &&
        candidate.dirty === false &&
        candidate.commit === commit &&
        candidate.id !== readySnapshot?.id;
      expect(
        shouldAttachSharedReadySnapshot({
          candidate,
          headCommit: commit,
          overlayDirty,
          readySnapshot,
        }),
      ).toBe(expected);
    },
    {fastCheck: {numRuns: 200}},
  );
});

describe('shouldReuseReadySnapshotForCleanCommit', () => {
  it('reuses when commit and graph content match a clean candidate', () => {
    expect(
      shouldReuseReadySnapshotForCleanCommit({
        candidate: {commit, dirty: false, graphContentId, id: 'cgsn_other_id'},
        graphContentId,
        headCommit: commit,
      }),
    ).toBe(true);
  });

  it('rejects dirty, wrong-commit, missing, or content-mismatched candidates', () => {
    expect(
      shouldReuseReadySnapshotForCleanCommit({
        candidate: {commit, dirty: true, graphContentId, id: 'cgsn_dirty'},
        graphContentId,
        headCommit: commit,
      }),
    ).toBe(false);
    expect(
      shouldReuseReadySnapshotForCleanCommit({
        candidate: {commit: otherCommit, dirty: false, graphContentId, id: 'cgsn_other'},
        graphContentId,
        headCommit: commit,
      }),
    ).toBe(false);
    expect(
      shouldReuseReadySnapshotForCleanCommit({
        candidate: {commit, dirty: false, id: 'cgsn_legacy'},
        graphContentId,
        headCommit: commit,
      }),
    ).toBe(false);
    expect(
      shouldReuseReadySnapshotForCleanCommit({
        candidate: {commit, dirty: false, graphContentId: otherGraphContentId, id: 'cgsn_mismatch'},
        graphContentId,
        headCommit: commit,
      }),
    ).toBe(false);
    expect(
      shouldReuseReadySnapshotForCleanCommit({
        graphContentId,
        headCommit: commit,
      }),
    ).toBe(false);
  });

  fcProp(
    it,
    'reuses only clean HEAD snapshots with an explicit matching graphContentId',
    {
      candidateCommit: FC.constantFrom(commit, otherCommit),
      candidateDirty: FC.boolean(),
      candidateGraphContentId: FC.constantFrom(graphContentId, otherGraphContentId, undefined),
      hasCandidate: FC.boolean(),
    },
    ({candidateCommit, candidateDirty, candidateGraphContentId, hasCandidate}) => {
      const candidate = hasCandidate
        ? {
            commit: candidateCommit,
            dirty: candidateDirty,
            ...(candidateGraphContentId === undefined ? {} : {graphContentId: candidateGraphContentId}),
            id: 'cgsn_candidate',
          }
        : undefined;
      const expected =
        candidate !== undefined &&
        candidate.dirty === false &&
        candidate.commit === commit &&
        candidate.graphContentId === graphContentId;
      expect(
        shouldReuseReadySnapshotForCleanCommit({
          candidate,
          graphContentId,
          headCommit: commit,
        }),
      ).toBe(expected);
    },
    {fastCheck: {numRuns: 200}},
  );
});

describe('codeGraphWatcherRefreshIndexRequest', () => {
  it('queues background vectors after watcher indexing publication', () => {
    expect(
      codeGraphWatcherRefreshIndexRequest({
        cwd: '/repo',
        key: 'worktree',
        threadnoteHome: '/home',
      }),
    ).toEqual({
      cwd: '/repo',
      vectorPolicy: 'background',
      onProgress: undefined,
      threadnoteHome: '/home',
    });
  });

  it('forwards a caller-supplied builder admission class', () => {
    expect(
      codeGraphWatcherRefreshIndexRequest({
        admissionClass: 'background',
        cwd: '/repo',
        key: 'worktree',
        threadnoteHome: '/home',
      }),
    ).toMatchObject({admissionClass: 'background', vectorPolicy: 'background'});
  });
});
