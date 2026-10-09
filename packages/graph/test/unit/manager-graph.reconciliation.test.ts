import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import type {
  CodeGraphLifecycleOpportunityResult,
  CodeGraphLifecycleOpportunityTarget,
} from '../../src/lifecycle/opportunity.js';
import {
  projectManagerGraphReconciliationStatus,
  type ManagerGraphReconciliationObservation,
} from '../../src/manager/reconciliation.js';

const checkedAt = '2026-10-09T12:00:00.000Z';

describe('Manager graph reconciliation status', () => {
  it('reports blocked repositories when no verified anchor is available', () => {
    expect(
      projectManagerGraphReconciliationStatus({
        activeBuild: false,
        checkedAt,
        maintenance: false,
        observation: observation([target({pending: true}), target({pending: false})]),
      }),
    ).toEqual({
      blockedRepositories: 1,
      checkedAt,
      pendingRepositories: 1,
      viewCleanupAdvanced: false,
      repositoryCount: 2,
      state: 'observed',
      unavailableRepositories: 0,
      viewsTruncated: false,
    });
  });

  it('counts mixed anchor evidence without exposing its paths or identities', () => {
    const input = {
      activeBuild: false,
      checkedAt,
      maintenance: false,
      observation: observation([
        target({anchorIdentity: true, pending: true}),
        target({anchorPath: true, pending: true}),
        target({pending: true}),
      ]),
    };
    const before = structuredClone(input);
    const projected = projectManagerGraphReconciliationStatus(input);

    expect(projected).toMatchObject({blockedRepositories: 1, pendingRepositories: 3});
    expect(input).toEqual(before);
    expect(Object.keys(projected).sort()).toEqual([
      'blockedRepositories',
      'checkedAt',
      'pendingRepositories',
      'repositoryCount',
      'state',
      'unavailableRepositories',
      'viewCleanupAdvanced',
      'viewsTruncated',
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/private|databasePath|anchorPath|anchorIdentity/u);
  });

  it('reports worktree cleanup progress without claiming an active-view removal count', () => {
    const result = {
      checkoutId: 'a'.repeat(64),
      opportunity: 'status',
      result: {
        cleanup: 'removed-worktree-view',
        expiredLeases: 0,
        remaining: true,
        retiredSnapshots: 0,
        rowsDeleted: 0,
        state: 'completed',
      },
      state: 'completed',
    } as const satisfies CodeGraphLifecycleOpportunityResult;

    expect(
      projectManagerGraphReconciliationStatus({
        activeBuild: false,
        checkedAt,
        lifecycleResult: result,
        maintenance: false,
        observation: observation([target({pending: true})]),
      }),
    ).toMatchObject({blockedRepositories: 1, pendingRepositories: 1, viewCleanupAdvanced: true, state: 'observed'});
    // Residual cleanup uses this same result; it is not an active-view removal count.
    expect(
      projectManagerGraphReconciliationStatus({
        activeBuild: false,
        checkedAt,
        lifecycleResult: result,
        maintenance: false,
        observation: observation([]),
      }),
    ).not.toHaveProperty('removedViews');
    expect(
      projectManagerGraphReconciliationStatus({
        activeBuild: false,
        checkedAt,
        lifecycleResult: {...result, result: {...result.result, cleanup: 'none'}},
        maintenance: false,
        observation: observation([]),
      }),
    ).toMatchObject({viewCleanupAdvanced: false});
  });

  it('defers status during active builds and maintenance, and reports failed observation as unavailable', () => {
    expect(projectManagerGraphReconciliationStatus({activeBuild: true, checkedAt, maintenance: false})).toEqual({
      reason: 'active-build',
      state: 'deferred',
    });
    expect(projectManagerGraphReconciliationStatus({activeBuild: false, checkedAt, maintenance: true})).toEqual({
      reason: 'maintenance',
      state: 'deferred',
    });
    expect(projectManagerGraphReconciliationStatus({activeBuild: false, checkedAt, maintenance: false})).toEqual({
      state: 'unavailable',
    });
  });

  it('reports databases whose view observations were unavailable', () => {
    expect(
      projectManagerGraphReconciliationStatus({
        activeBuild: false,
        checkedAt,
        maintenance: false,
        observation: {
          lifecycleTargets: [],
          repositoryCount: 3,
          unavailableRepositories: 2,
          viewsTruncated: false,
        },
      }),
    ).toMatchObject({pendingRepositories: 0, repositoryCount: 3, unavailableRepositories: 2});
  });

  it('matches an independent count model for bounded pending repositories and mixed anchor evidence', () =>
    FC.assert(
      FC.property(
        FC.record({
          rows: FC.array(
            FC.record({
              anchor: FC.constantFrom('identity' as const, 'none' as const, 'path' as const),
              available: FC.boolean(),
              pending: FC.boolean(),
            }),
            {maxLength: 32},
          ),
          viewsTruncated: FC.boolean(),
        }),
        ({rows, viewsTruncated}) => {
          const targets = rows.flatMap(row =>
            row.available
              ? [
                  target({
                    ...(row.anchor === 'identity' ? {anchorIdentity: true} : {}),
                    ...(row.anchor === 'path' ? {anchorPath: true} : {}),
                    pending: row.pending,
                  }),
                ]
              : [],
          );
          const inputObservation = {
            lifecycleTargets: targets,
            repositoryCount: rows.length,
            unavailableRepositories: rows.filter(row => !row.available).length,
            viewsTruncated,
          };
          const before = structuredClone(inputObservation);
          const result = projectManagerGraphReconciliationStatus({
            activeBuild: false,
            checkedAt,
            maintenance: false,
            observation: inputObservation,
          });
          const pendingCount = rows.reduce((count, row) => count + Number(row.available && row.pending), 0);
          const blockedCount = rows.reduce(
            (count, row) => count + Number(row.available && row.pending && row.anchor === 'none'),
            0,
          );

          expect(result).toEqual({
            blockedRepositories: blockedCount,
            checkedAt,
            pendingRepositories: pendingCount,
            viewCleanupAdvanced: false,
            repositoryCount: rows.length,
            state: 'observed',
            unavailableRepositories: rows.filter(row => !row.available).length,
            viewsTruncated,
          });
          expect(inputObservation).toEqual(before);
          expect(JSON.stringify(result)).not.toMatch(/private|databasePath|anchorPath|anchorIdentity/u);
        },
      ),
      {numRuns: 200},
    ));
});

function observation(
  lifecycleTargets: readonly CodeGraphLifecycleOpportunityTarget[],
): ManagerGraphReconciliationObservation {
  return {
    lifecycleTargets,
    repositoryCount: lifecycleTargets.length,
    unavailableRepositories: 0,
    viewsTruncated: false,
  };
}

function target(input: {
  readonly anchorIdentity?: boolean;
  readonly anchorPath?: boolean;
  readonly pending: boolean;
}): CodeGraphLifecycleOpportunityTarget {
  return {
    ...(input.anchorIdentity
      ? {
          anchorIdentity: {
            caseMode: 'sensitive',
            displayName: 'synthetic/repository',
            gitCommonDirectory: '/private/repository/.git',
            headCommit: 'd'.repeat(40),
            objectFormat: 'sha1',
            repoRoot: '/private/repository',
            checkoutId: 'a'.repeat(64),
            repositoryId: 'b'.repeat(64),
            worktreeId: 'c'.repeat(64),
          },
        }
      : {}),
    ...(input.anchorPath ? {anchorPath: '/private/repository/path'} : {}),
    checkoutId: 'a'.repeat(64),
    databasePath: '/private/graph/database.sqlite',
    reconciliationPending: input.pending,
  };
}
