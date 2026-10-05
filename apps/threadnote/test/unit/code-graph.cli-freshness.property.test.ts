import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphCliReadPlan,
  codeGraphCliUsesBorrowedContinuity,
  defaultCodeGraphCliFreshness,
  type CodeGraphCliFreshnessPolicy,
} from '@threadnote/threadnote/code_graph/commands';
import type {CodeGraphSnapshot} from '@threadnote/graph/types';

const readySnapshot: CodeGraphSnapshot = {
  commit: 'a'.repeat(40),
  dirty: false,
  edgeCount: 1,
  extractorSet: 'extractor',
  fileCount: 1,
  graphContentId: 'content',
  id: 'cgsn_ready',
  repositoryId: 'repository',
  state: 'ready',
  symbolCount: 1,
  worktreeId: 'worktree',
};

const currentIdentity = {
  caseMode: 'sensitive' as const,
  checkoutId: 'checkout',
  displayName: 'fixture',
  gitCommonDirectory: '/workspace/repository/.git',
  headCommit: readySnapshot.commit,
  objectFormat: 'sha1' as const,
  repoRoot: '/workspace/repository',
  repositoryId: readySnapshot.repositoryId,
  worktreeId: 'current-worktree',
};

describe('code graph CLI freshness properties', () => {
  it('keeps path and impact strict-current while ordinary semantic reads default to ready', () => {
    expect(defaultCodeGraphCliFreshness('path')).toBe('current');
    expect(defaultCodeGraphCliFreshness('impact')).toBe('current');
    for (const operation of ['query', 'node', 'neighbors', 'explain'] as const) {
      expect(defaultCodeGraphCliFreshness(operation)).toBe('ready');
    }
  });

  it('matches the independent readiness model for every policy and status shape', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<CodeGraphCliFreshnessPolicy>('ready', 'current', 'allow-stale'),
        fc.boolean(),
        fc.boolean(),
        (policy, hasReadySnapshot, stale) => {
          const result = codeGraphCliReadPlan(policy, {
            readySnapshot: hasReadySnapshot ? readySnapshot : undefined,
            stale,
          });
          const expectedUnavailable = policy === 'allow-stale' && !hasReadySnapshot;
          const expectedRefresh = !expectedUnavailable && (!hasReadySnapshot || (stale && policy === 'current'));

          expect(result).toEqual({
            refresh: expectedRefresh,
            strictFreshness: policy === 'current',
            unavailable: expectedUnavailable,
          });
        },
      ),
      {numRuns: 100},
    );
  });

  it('never starts indexing when allow-stale is selected', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (hasReadySnapshot, stale) => {
        const result = codeGraphCliReadPlan('allow-stale', {
          readySnapshot: hasReadySnapshot ? readySnapshot : undefined,
          stale,
        });
        expect(result.refresh).toBe(false);
        expect(result.unavailable).toBe(!hasReadySnapshot);
      }),
      {numRuns: 50},
    );
  });

  it('uses an existing ready snapshot without refreshing under the default ready policy', () => {
    fc.assert(
      fc.property(fc.boolean(), stale => {
        const result = codeGraphCliReadPlan('ready', {readySnapshot, stale});
        expect(result).toEqual({refresh: false, strictFreshness: false, unavailable: false});
      }),
      {numRuns: 50},
    );
  });

  it('serves borrowed current-policy continuity only for stale-safe ordinary reads', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('query', 'node', 'neighbors', 'explain', 'path', 'impact'),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (operation, borrowedSnapshot, stale, sameCommit, worktreeClean) => {
          const identity = sameCommit ? currentIdentity : {...currentIdentity, headCommit: 'b'.repeat(40)};
          const continuity = codeGraphCliUsesBorrowedContinuity(
            'current',
            operation,
            {identity, readySnapshot, stale},
            borrowedSnapshot,
            worktreeClean,
          );
          expect(continuity).toBe(
            borrowedSnapshot && worktreeClean && sameCommit && stale && operation !== 'path' && operation !== 'impact',
          );
        },
      ),
      {numRuns: 100},
    );
    expect(
      codeGraphCliUsesBorrowedContinuity(
        'ready',
        'query',
        {identity: currentIdentity, readySnapshot, stale: true},
        true,
        true,
      ),
    ).toBe(false);
    expect(
      codeGraphCliUsesBorrowedContinuity(
        'current',
        'query',
        {identity: currentIdentity, readySnapshot: undefined, stale: true},
        true,
        true,
      ),
    ).toBe(false);
  });
});
