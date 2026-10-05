import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {
  readCodeGraphCliWithContinuity,
  resolveCodeGraphCliReadContinuity,
} from '@threadnote/graph/commands/read_continuity';
import {attachCodeGraphStatusObservation} from '@threadnote/graph/query/contract';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphSnapshotUnavailable, type CodeGraphQueryResult, type CodeGraphStatus} from '@threadnote/graph/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';

describe('code graph CLI shared-read continuity', () => {
  effectIt.effect('keeps clean same-commit borrowed evidence on the strict bounded current path', () =>
    Effect.gen(function* () {
      const initial = attachCodeGraphStatusObservation(scopedStatus(false), statusObservation(false));
      const borrowed = attachCodeGraphStatusObservation(scopedStatus(true), {
        ...statusObservation(false),
        borrowedSnapshotId: 'scope-snapshot',
      });
      const service = CodeGraphQueryService.of({
        attachSharedReadySnapshot: () => Effect.succeed(borrowed),
        inspect: () => Effect.die('Unexpected graph inspection.'),
        purge: () => Effect.die('Unexpected graph purge.'),
        status: () => Effect.die('Unexpected graph status.'),
        statusForIdentity: () => Effect.die('Unexpected identity status.'),
        statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
      });

      const result = yield* resolveCodeGraphCliReadContinuity(CONFIG, service, initial, 'query', 'current');

      expect(result.borrowedContinuity).toBe(true);
      expect(result.readPlan).toEqual({refresh: true, strictFreshness: true, unavailable: false});
      expect(result.status.readySnapshot?.id).toBe('scope-snapshot');
    }),
  );

  effectIt.effect('does not treat same-commit evidence as continuity for a dirty target worktree', () =>
    Effect.gen(function* () {
      const initial = attachCodeGraphStatusObservation(scopedStatus(false), statusObservation(true));
      const borrowed = attachCodeGraphStatusObservation(scopedStatus(true), {
        ...statusObservation(true),
        borrowedSnapshotId: 'scope-snapshot',
      });
      const service = CodeGraphQueryService.of({
        attachSharedReadySnapshot: () => Effect.succeed(borrowed),
        inspect: () => Effect.die('Unexpected graph inspection.'),
        purge: () => Effect.die('Unexpected graph purge.'),
        status: () => Effect.die('Unexpected graph status.'),
        statusForIdentity: () => Effect.die('Unexpected identity status.'),
        statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
      });

      const result = yield* resolveCodeGraphCliReadContinuity(CONFIG, service, initial, 'query', 'current');

      expect(result.borrowedContinuity).toBe(false);
      expect(result.readPlan).toEqual({refresh: true, strictFreshness: true, unavailable: false});
    }),
  );

  effectIt.effect('keeps an older borrowed snapshot on the strict current refresh path', () =>
    Effect.gen(function* () {
      const initial = attachCodeGraphStatusObservation(scopedStatus(false), statusObservation(false));
      const borrowed = attachCodeGraphStatusObservation(scopedStatus(true, 'a'.repeat(40)), {
        ...statusObservation(false),
        borrowedSnapshotId: 'scope-snapshot',
      });
      const service = CodeGraphQueryService.of({
        attachSharedReadySnapshot: () => Effect.succeed(borrowed),
        inspect: () => Effect.die('Unexpected graph inspection.'),
        purge: () => Effect.die('Unexpected graph purge.'),
        status: () => Effect.die('Unexpected graph status.'),
        statusForIdentity: () => Effect.die('Unexpected identity status.'),
        statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
      });

      const result = yield* resolveCodeGraphCliReadContinuity(CONFIG, service, initial, 'query', 'current');

      expect(result.borrowedContinuity).toBe(false);
      expect(result.readPlan).toEqual({refresh: true, strictFreshness: true, unavailable: false});
    }),
  );

  effectIt.effect('serves unchanged borrowed evidence without starting a refresh', () =>
    Effect.gen(function* () {
      const plans: Array<{refresh: boolean; strictFreshness: boolean; unavailable: boolean}> = [];
      const reusedObservations: boolean[] = [];
      const result = yield* readCodeGraphCliWithContinuity(
        {borrowedContinuity: true, readPlan: {refresh: true, strictFreshness: true, unavailable: false}},
        (plan, reuseStatusObservation) => {
          plans.push(plan);
          reusedObservations.push(reuseStatusObservation);
          return Effect.succeed(queryResult('current'));
        },
      );

      expect(result.borrowedContinuity).toBe(true);
      expect(result.result.freshness).toBe('current');
      expect(plans).toEqual([{refresh: false, strictFreshness: true, unavailable: false}]);
      expect(reusedObservations).toEqual([true]);
    }),
  );

  effectIt.effect('falls back to a strict refresh when the target changes during a borrowed read', () =>
    Effect.gen(function* () {
      const plans: Array<{refresh: boolean; strictFreshness: boolean; unavailable: boolean}> = [];
      const reusedObservations: boolean[] = [];
      const result = yield* readCodeGraphCliWithContinuity(
        {borrowedContinuity: true, readPlan: {refresh: true, strictFreshness: true, unavailable: false}},
        (plan, reuseStatusObservation) => {
          plans.push(plan);
          reusedObservations.push(reuseStatusObservation);
          return Effect.succeed(queryResult(plans.length === 1 ? 'stale' : 'current'));
        },
      );

      expect(result.borrowedContinuity).toBe(false);
      expect(result.result.freshness).toBe('current');
      expect(plans).toEqual([
        {refresh: false, strictFreshness: true, unavailable: false},
        {refresh: true, strictFreshness: true, unavailable: false},
      ]);
      expect(reusedObservations).toEqual([true, false]);
    }),
  );

  effectIt.effect('falls back to a strict refresh when borrowed evidence becomes incompatible', () =>
    Effect.gen(function* () {
      const plans: Array<{refresh: boolean; strictFreshness: boolean; unavailable: boolean}> = [];
      const reusedObservations: boolean[] = [];
      const result = yield* readCodeGraphCliWithContinuity(
        {borrowedContinuity: true, readPlan: {refresh: true, strictFreshness: true, unavailable: false}},
        (plan, reuseStatusObservation) => {
          plans.push(plan);
          reusedObservations.push(reuseStatusObservation);
          return plans.length === 1
            ? CodeGraphSnapshotUnavailable.make({message: 'Project scope changed during the borrowed read.'})
            : Effect.succeed(queryResult('current'));
        },
      );

      expect(result.borrowedContinuity).toBe(false);
      expect(result.result.freshness).toBe('current');
      expect(plans).toHaveLength(2);
      expect(reusedObservations).toEqual([true, false]);
    }),
  );
});

function queryResult(freshness: CodeGraphQueryResult['freshness']): CodeGraphQueryResult {
  return {
    edges: [],
    freshness,
    nodes: [],
    operation: 'query',
    repository: {displayName: 'fixture', repositoryId: 'a'.repeat(64)},
    snapshot: {
      commit: 'b'.repeat(40),
      dirty: false,
      id: 'scope-snapshot',
      worktreeId: 'fresh-worktree',
    },
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    version: 1,
    warnings: [],
  };
}

function scopedStatus(ready: boolean, snapshotCommit = 'b'.repeat(40)): CodeGraphStatus {
  const status: CodeGraphStatus = {
    databasePath: '/threadnote/code-graph.sqlite',
    freshness: 'stale',
    identity: {
      caseMode: 'sensitive',
      checkoutId: 'checkout',
      displayName: 'fixture',
      gitCommonDirectory: '/workspace/repository/.git',
      headCommit: 'b'.repeat(40),
      objectFormat: 'sha1',
      repoRoot: '/workspace/fresh',
      repositoryId: 'a'.repeat(64),
      worktreeId: 'fresh-worktree',
    },
    languagePacks: [],
    projectCoverage: {
      completeness: 'complete',
      configuredRoots: ['apps/docs'],
      dependencyComponents: 0,
      kind: 'project',
      negativeProof: 'selected-graph-only',
      observedWorktreeCommit: 'b'.repeat(40),
      project: 'docs',
      reusedEquivalentSnapshot: false,
      rootComponents: 1,
    },
    ...(ready
      ? {
          readySnapshot: {
            commit: snapshotCommit,
            dirty: false,
            edgeCount: 1,
            extractorSet: 'extractor',
            fileCount: 1,
            id: 'scope-snapshot',
            repositoryId: 'a'.repeat(64),
            scopeId: `code-graph-scope:${'c'.repeat(64)}`,
            state: 'ready' as const,
            symbolCount: 1,
            worktreeId: 'source-worktree',
          },
        }
      : {}),
    stale: true,
  };
  return status;
}

function statusObservation(dirty: boolean) {
  return {
    identity: scopedStatusIdentity(),
    manifestPath: '/threadnote/manifest.yaml',
    overlay: {dirty},
    projectScope: {
      project: {
        graph: {closure: 'dependencies' as const, roots: ['apps/docs']},
        name: 'docs',
        uri: 'threadnote://resources/repos/docs',
      },
      scope: {
        admittedPrefixes: ['apps/docs'],
        closureDigest: 'd'.repeat(64),
        completeness: 'complete' as const,
        controlPaths: ['package.json'],
        definitionDigest: 'e'.repeat(64),
        diagnostics: [],
        includedProjectIds: ['@fixture/docs'],
        rootProjectIds: ['@fixture/docs'],
        scopeKey: `code-graph-scope:${'c'.repeat(64)}`,
      },
    },
  };
}

function scopedStatusIdentity() {
  return {
    caseMode: 'sensitive' as const,
    checkoutId: 'checkout',
    displayName: 'fixture',
    gitCommonDirectory: '/workspace/repository/.git',
    headCommit: 'b'.repeat(40),
    objectFormat: 'sha1' as const,
    repoRoot: '/workspace/fresh',
    repositoryId: 'a'.repeat(64),
    worktreeId: 'fresh-worktree',
  };
}

const CONFIG: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/threadnote',
  agentId: 'test-agent',
  manifestPath: '/threadnote/manifest.yaml',
  user: 'tester',
};
