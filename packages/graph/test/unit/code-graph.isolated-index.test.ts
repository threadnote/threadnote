import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {succeedUndefined} from '@threadnote/platform/optional';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {isolatedBuilderRequestMatches} from '@threadnote/graph/isolated/builder';
import {codeGraphBuildRequestKey} from '@threadnote/graph/indexer/build';
import {WorktreeChangedDuringIndex} from '@threadnote/graph/indexer/shared';
import {recoverIsolatedCodeGraphIndexSnapshot} from '@threadnote/graph/isolated/index';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {CodeGraphSnapshotUnavailable, type CodeGraphSnapshot, type RepositoryIdentity} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const identity: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
  displayName: 'fixture/repository',
  gitCommonDirectory: '/fixture/repository/.git',
  headCommit: Effect2.pipe('b', EffectString.repeat(40)),
  objectFormat: 'sha1',
  repoRoot: '/fixture/repository',
  repositoryId: Effect2.pipe('c', EffectString.repeat(64)),
  worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
};

const snapshot: CodeGraphSnapshot = {
  commit: identity.headCommit,
  dirty: false,
  edgeCount: 41,
  extractorSet: 'fixture-extractors',
  fileCount: 3,
  id: `cgsn_${Effect2.pipe('e', EffectString.repeat(40))}`,
  repositoryId: identity.repositoryId,
  state: 'ready',
  symbolCount: 29,
  worktreeId: identity.worktreeId,
};

const result = {
  dirty: snapshot.dirty,
  edges: snapshot.edgeCount,
  files: snapshot.fileCount,
  requestKey: 'request-key',
  snapshotId: snapshot.id,
  symbols: snapshot.symbolCount,
} as const;

describe('isolated index snapshot recovery', () => {
  it('never attaches a vector-required request to an active or completed structural-only build', () => {
    const languagePacks = BUILTIN_LANGUAGE_PACK_REGISTRY;
    const structuralOnlyKey = codeGraphBuildRequestKey(
      identity,
      {dirty: false},
      languagePacks,
      undefined,
      false,
      Effect2.pipe('f', EffectString.repeat(64)),
    );
    const vectorRequiredKey = codeGraphBuildRequestKey(
      identity,
      {dirty: false},
      languagePacks,
      undefined,
      true,
      Effect2.pipe('f', EffectString.repeat(64)),
    );

    expect(vectorRequiredKey).not.toBe(structuralOnlyKey);
    for (const liveness of ['active', 'completed'] as const) {
      const status = {
        observation: {liveness},
        request: {key: structuralOnlyKey},
      };
      expect(isolatedBuilderRequestMatches(status, vectorRequiredKey)).toBe(false);
    }
  });

  effectIt.effect('recovers the exact authoritative ready snapshot named by the child receipt', () =>
    Effect.gen(function* () {
      const loadedIds: string[] = [];
      const recovered = yield* recoverIsolatedCodeGraphIndexSnapshot({
        completedIdentity: identity,
        currentRequestKey: result.requestKey,
        loadReadySnapshot: snapshotId =>
          Effect.sync(() => {
            loadedIds.push(snapshotId);
            return snapshot;
          }),
        requestedIdentity: identity,
        requestedRequestKey: result.requestKey,
        result,
      });

      expect(loadedIds).toEqual([snapshot.id]);
      expect(recovered).toEqual({identity, snapshot});
    }),
  );

  effectIt.effect('fails closed when the child receipt has no authoritative ready snapshot', () =>
    Effect.gen(function* () {
      const failure = yield* recoverIsolatedCodeGraphIndexSnapshot({
        completedIdentity: identity,
        currentRequestKey: result.requestKey,
        loadReadySnapshot: () => succeedUndefined,
        requestedIdentity: identity,
        requestedRequestKey: result.requestKey,
        result,
      }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(CodeGraphSnapshotUnavailable);
    }),
  );

  fcEffectProp(
    effectIt,
    'rejects every post-child target, commit, or request-key drift before loading a publishable snapshot (property)',
    {drift: fc.constantFrom('checkout', 'repository', 'worktree', 'head', 'receipt-request', 'current-request')},
    ({drift}) =>
      Effect.gen(function* () {
        let snapshotLoads = 0;
        const completedIdentity = {
          ...identity,
          ...(drift === 'checkout' ? {checkoutId: Effect2.pipe('f', EffectString.repeat(64))} : {}),
          ...(drift === 'repository' ? {repositoryId: Effect2.pipe('f', EffectString.repeat(64))} : {}),
          ...(drift === 'worktree' ? {worktreeId: Effect2.pipe('f', EffectString.repeat(64))} : {}),
          ...(drift === 'head' ? {headCommit: Effect2.pipe('f', EffectString.repeat(40))} : {}),
        };
        const failure = yield* recoverIsolatedCodeGraphIndexSnapshot({
          completedIdentity,
          currentRequestKey: drift === 'current-request' ? 'changed-current-request' : result.requestKey,
          loadReadySnapshot: () =>
            Effect.sync(() => {
              snapshotLoads += 1;
              return snapshot;
            }),
          requestedIdentity: identity,
          requestedRequestKey: result.requestKey,
          result: drift === 'receipt-request' ? {...result, requestKey: 'changed-receipt-request'} : result,
        }).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(WorktreeChangedDuringIndex);
        expect(snapshotLoads).toBe(0);
      }),
    {fastCheck: {numRuns: 36}},
  );

  fcEffectProp(
    effectIt,
    'rejects every authoritative snapshot mutation after exactly one ready-row load (property)',
    {drift: fc.constantFrom('snapshot', 'repository', 'commit', 'dirty', 'files', 'symbols', 'edges', 'worktree')},
    ({drift}) =>
      Effect.gen(function* () {
        let snapshotLoads = 0;
        const completedResult = drift === 'worktree' ? {...result, dirty: true} : result;
        const loadedSnapshot: CodeGraphSnapshot = {
          ...snapshot,
          dirty: completedResult.dirty,
          ...(drift === 'snapshot' ? {id: `cgsn_${Effect2.pipe('f', EffectString.repeat(40))}`} : {}),
          ...(drift === 'repository' ? {repositoryId: Effect2.pipe('f', EffectString.repeat(64))} : {}),
          ...(drift === 'commit' ? {commit: Effect2.pipe('f', EffectString.repeat(40))} : {}),
          ...(drift === 'dirty' ? {dirty: !completedResult.dirty} : {}),
          ...(drift === 'files' ? {fileCount: completedResult.files + 1} : {}),
          ...(drift === 'symbols' ? {symbolCount: completedResult.symbols + 1} : {}),
          ...(drift === 'edges' ? {edgeCount: completedResult.edges + 1} : {}),
          ...(drift === 'worktree' ? {worktreeId: Effect2.pipe('f', EffectString.repeat(64))} : {}),
        };
        const failure = yield* recoverIsolatedCodeGraphIndexSnapshot({
          completedIdentity: identity,
          currentRequestKey: result.requestKey,
          loadReadySnapshot: () =>
            Effect.sync(() => {
              snapshotLoads += 1;
              return loadedSnapshot;
            }),
          requestedIdentity: identity,
          requestedRequestKey: result.requestKey,
          result: completedResult,
        }).pipe(Effect.flip);

        expect(snapshotLoads).toBe(1);
        expect(failure).toBeInstanceOf(
          drift === 'snapshot' || drift === 'repository' ? CodeGraphSnapshotUnavailable : WorktreeChangedDuringIndex,
        );
      }),
    {fastCheck: {numRuns: 40}},
  );
});
