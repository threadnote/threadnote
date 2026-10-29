import {Array as EffectArray} from 'effect';
import type {CodeGraphBuildCapacityFailure} from '@threadnote/graph/build_status';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {ObservedCodeGraphBuildStatus} from '@threadnote/graph/build_status';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {codeGraphLanguagePackStatuses} from '@threadnote/graph/query/status_helpers';
import {
  CODE_GRAPH_STATUS_DEFAULT_BUILD_LIMIT,
  CODE_GRAPH_STATUS_BUILD_SUMMARY_MAXIMUM_BYTES,
  CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT,
  CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT,
  CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT,
  codeGraphStatusBuildLimit,
  codeGraphStatusLanguagePackLimit,
  projectCodeGraphStatusActivityV5,
  projectCodeGraphStatusBuildSummaryV5,
  projectCodeGraphStatusLanguagePacksV4,
} from '@threadnote/graph/status/projection';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const capacityRoles: readonly ('durable' | 'shared' | 'temporary')[] = ['durable', 'shared', 'temporary'];
const capacityFailure: CodeGraphBuildCapacityFailure = {
  code: 'no-space',
  operation: 'stage persistent code graph facts',
  evidence: {
    activeReservations: EffectArray.map(capacityRoles, role => ({
      role,
      bytes: Number.MAX_SAFE_INTEGER,
    })),
    calibrationIdentity: Effect.pipe('c', EffectString.repeat(256)),
    decisionLayer: 'bounded-write-reservation',
    estimateBasis: 'final-fact-bytes-and-row-count',
    filesystems: EffectArray.map(capacityRoles, role => ({
      role,
      availableBytes: Number.MAX_SAFE_INTEGER,
      requiredBytes: Number.MAX_SAFE_INTEGER,
    })),
    modelVersion: Number.MAX_SAFE_INTEGER,
    recovery: 'free-space',
    retryable: false,
    scope: {
      checkoutId: Effect.pipe('a', EffectString.repeat(64)),
      scopeId: `code-graph-scope:${Effect.pipe('b', EffectString.repeat(64))}`,
    },
  },
};

describe('code graph status JSON projection', () => {
  it('bounds the observed 74-worktree shape and pins an otherwise omitted current build', () => {
    const builds = Array.from({length: 74}, (_, index) => status(index, 'completed'));
    const waiters = Array.from({length: 74}, (_, index) => status(index + 100, 'active'));
    const currentWorktreeId = builds[73].identity.worktreeId;

    const result = projectCodeGraphStatusActivityV5({builds, waiters}, currentWorktreeId, 8);

    expect(result.build?.worktreeId).toBe(currentWorktreeId);
    expect(result.builds[result.build!.index]).toMatchObject({
      buildId: result.build?.buildId,
      identity: {worktreeId: currentWorktreeId},
    });
    expect(result.builds).toHaveLength(8);
    expect(EffectArray.map(result.builds, build => build.identity.worktreeId)).toContain(currentWorktreeId);
    expect(result.waiters).toHaveLength(8);
    expect(result.queuedWorktreeIds).toHaveLength(8);
    expect(result.projection).toEqual({
      builds: {limit: 8, omitted: 66, returned: 8, total: 74},
      queuedWorktreeIds: {limit: 8, omitted: 66, returned: 8, total: 74},
      waiters: {limit: 8, omitted: 66, returned: 8, total: 74},
    });
    expect(result.waiterCount).toBe(74);
  });

  it('is deterministic, non-mutating, count-bounded, and current-preserving across arbitrary catalog sizes', () => {
    fc.assert(
      fc.property(
        fc.integer({max: 128, min: 0}),
        fc.integer({max: 128, min: 0}),
        fc.integer({max: 127, min: 0}),
        fc.integer({max: CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT, min: 1}),
        (buildCount, waiterCount, currentSeed, limit) => {
          const builds = Array.from({length: buildCount}, (_, index) =>
            status(index, index % 3 === 0 ? 'active' : 'completed'),
          );
          const waiters = Array.from({length: waiterCount}, (_, index) =>
            status(1_000 + Math.floor(index / 2), 'active'),
          );
          const current = buildCount === 0 ? hexId(10_000) : builds[currentSeed % buildCount].identity.worktreeId;
          const originalBuildOrder = EffectArray.map(builds, build => build.identity.worktreeId);
          const originalWaiterOrder = EffectArray.map(waiters, waiter => waiter.identity.worktreeId);

          const first = projectCodeGraphStatusActivityV5({builds, waiters}, current, limit);
          const second = projectCodeGraphStatusActivityV5({builds, waiters}, current, limit);

          expect(second).toEqual(first);
          expect(EffectArray.map(builds, build => build.identity.worktreeId)).toEqual(originalBuildOrder);
          expect(EffectArray.map(waiters, waiter => waiter.identity.worktreeId)).toEqual(originalWaiterOrder);
          expect(first.builds.length).toBeLessThanOrEqual(limit);
          expect(first.waiters.length).toBeLessThanOrEqual(limit);
          expect(first.queuedWorktreeIds.length).toBeLessThanOrEqual(limit);
          expect(new Set(first.queuedWorktreeIds).size).toBe(first.queuedWorktreeIds.length);
          expect(first.projection.builds).toEqual({
            limit,
            omitted: buildCount - first.builds.length,
            returned: first.builds.length,
            total: buildCount,
          });
          expect(first.projection.waiters).toEqual({
            limit,
            omitted: waiterCount - first.waiters.length,
            returned: first.waiters.length,
            total: waiterCount,
          });
          const queuedTotal = new Set(EffectArray.map(waiters, waiter => waiter.identity.worktreeId)).size;
          expect(first.projection.queuedWorktreeIds).toEqual({
            limit,
            omitted: queuedTotal - first.queuedWorktreeIds.length,
            returned: first.queuedWorktreeIds.length,
            total: queuedTotal,
          });
          if (buildCount > 0) {
            expect(first.build?.worktreeId).toBe(current);
            expect(EffectArray.map(first.builds, build => build.identity.worktreeId)).toContain(current);
            expect(first.builds[first.build!.index]?.buildId).toBe(first.build?.buildId);
          }
        },
      ),
      {numRuns: 100},
    );
  });

  it('strips rich diagnostics and bounds live activity without mutating adversarial source records', () => {
    fc.assert(
      fc.property(fc.integer({max: 60_000, min: 0}), fc.constantFrom('x', 'é', '混', '🧠'), (size, unit) => {
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        const noise = unit.repeat(size);
        const source = {
          ...status(size, 'active'),
          activity: {
            batchCompleted: 1,
            batchTotal: 2,
            bytes: 3,
            classifier: noise,
            degraded: true,
            factsBytes: Number.MAX_SAFE_INTEGER,
            language: noise,
            parseMilliseconds: Number.MAX_SAFE_INTEGER,
            persistMilliseconds: Number.MAX_SAFE_INTEGER,
            relations: Number.MAX_SAFE_INTEGER,
            role: noise,
            sizeBucket: '1MiB+',
            stage: 'extracting',
            symbols: Number.MAX_SAFE_INTEGER,
            unexpected: noise,
          },
          coordination: {lockVerified: true, progressSilent: true, role: 'owner', unexpected: noise},
          counters: {
            accepted: Number.MAX_SAFE_INTEGER,
            completed: Number.MAX_SAFE_INTEGER,
            edges: Number.MAX_SAFE_INTEGER,
            embedded: Number.MAX_SAFE_INTEGER,
            excluded: Number.MAX_SAFE_INTEGER,
            pagesCompleted: Number.MAX_SAFE_INTEGER,
            reused: Number.MAX_SAFE_INTEGER,
            resolved: Number.MAX_SAFE_INTEGER,
            rowsDeleted: Number.MAX_SAFE_INTEGER,
            skipped: Number.MAX_SAFE_INTEGER,
            symbols: Number.MAX_SAFE_INTEGER,
            total: Number.MAX_SAFE_INTEGER,
            unexpected: noise,
            unit: 'files',
          },
          error: {summary: noise, capacity: capacityFailure, unexpected: noise},
          eta: {
            basis: 'cached-fact-bytes',
            confidence: 'high',
            remainingMilliseconds: Number.MAX_SAFE_INTEGER,
            scope: 'phase',
            unexpected: noise,
          },
          extraction: {metrics: {unexpected: noise}, topSlowFiles: [{unexpected: noise}]},
          managerContext: {unexpected: noise, worktreePath: noise},
          materialization: {metrics: {unexpected: noise}},
          observation: {
            heartbeatAgeMilliseconds: Number.MAX_SAFE_INTEGER,
            liveness: 'active',
            reason: 'heartbeat-stale',
            unexpected: noise,
          },
          request: {key: noise, unexpected: noise},
          result: {
            dirty: true,
            edges: Number.MAX_SAFE_INTEGER,
            files: Number.MAX_SAFE_INTEGER,
            overlayAssessment: {outcome: 'overlay-success', unexpected: noise},
            snapshotId: noise,
            symbols: Number.MAX_SAFE_INTEGER,
            unexpected: noise,
          },
          subphase: noise,
          timestamps: {
            completedAt: noise,
            heartbeatAt: noise,
            lastProgressAt: noise,
            phaseStartedAt: noise,
            startedAt: noise,
            unexpected: noise,
            updatedAt: noise,
          },
        };
        const original = JSON.stringify(source);

        const first = projectMalformedBuildStatus(source);
        const second = projectMalformedBuildStatus(source);

        expect(second).toEqual(first);
        expect(JSON.stringify(source)).toBe(original);
        expect(first).not.toHaveProperty('extraction');
        expect(first).not.toHaveProperty('managerContext');
        expect(first).not.toHaveProperty('materialization');
        expect(first).not.toHaveProperty('owner');
        expect(first).not.toHaveProperty('request');
        expect(first.activity).not.toHaveProperty('unexpected');
        expect(first.error).not.toHaveProperty('unexpected');
        expect(first.error?.capacity).toEqual(capacityFailure);
        expect(utf8Bytes(first.error?.summary ?? '')).toBeLessThanOrEqual(300);
        expect(utf8Bytes(first.subphase ?? '')).toBeLessThanOrEqual(64);
        expect(utf8Bytes(JSON.stringify(first))).toBeLessThanOrEqual(CODE_GRAPH_STATUS_BUILD_SUMMARY_MAXIMUM_BYTES);
      }),
      {numRuns: 100},
    );
  });

  it('keeps a rich 74-build default activity catalog below a deterministic byte ceiling', () => {
    const richBuilds = Array.from({length: 74}, (_, index) => ({
      ...status(index, 'completed'),
      extraction: {metrics: {noise: Effect.pipe('x', EffectString.repeat(8_000))}},
      materialization: {metrics: {noise: Effect.pipe('y', EffectString.repeat(8_000))}},
    }));
    const currentWorktreeId = richBuilds[73].identity.worktreeId;

    const result = projectMalformedBuildActivity(richBuilds, currentWorktreeId, CODE_GRAPH_STATUS_DEFAULT_BUILD_LIMIT);

    expect(result.projection.builds).toEqual({limit: 4, omitted: 70, returned: 4, total: 74});
    expect(result.builds[result.build!.index]?.identity.worktreeId).toBe(currentWorktreeId);
    expect(utf8Bytes(JSON.stringify(result))).toBeLessThan(4_500);
  });

  it('admits only the documented safe build-limit range', () => {
    expect(codeGraphStatusBuildLimit(undefined)).toBe(CODE_GRAPH_STATUS_DEFAULT_BUILD_LIMIT);
    expect(codeGraphStatusBuildLimit(1)).toBe(1);
    expect(codeGraphStatusBuildLimit(CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT)).toBe(
      CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT,
    );
    for (const invalid of [0, CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT + 1, 1.5, Number.NaN]) {
      expect(codeGraphStatusBuildLimit(invalid)).toBeUndefined();
    }
  });

  it('keeps the default rich language-pack projection compact and discoverable', () => {
    const languagePacks = codeGraphLanguagePackStatuses(BUILTIN_LANGUAGE_PACK_REGISTRY);
    const result = projectCodeGraphStatusLanguagePacksV4(languagePacks, CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT);

    expect(JSON.stringify(languagePacks).length).toBeGreaterThan(10_000);
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
    expect(result.items).toHaveLength(CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT);
    expect(result.receipt).toEqual({
      limit: CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT,
      omitted: languagePacks.length - CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT,
      returned: CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT,
      total: languagePacks.length,
    });
  });

  it('bounds language packs deterministically without mutating the complete catalog', () => {
    const builtins = codeGraphLanguagePackStatuses(BUILTIN_LANGUAGE_PACK_REGISTRY);
    fc.assert(
      fc.property(
        fc.integer({max: 128, min: 0}),
        fc.integer({max: CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT, min: 1}),
        (packCount, limit) => {
          const languagePacks = Array.from({length: packCount}, (_, index) => ({
            ...builtins[index % builtins.length],
            id: `pack-${Effect.pipe(index.toString(), EffectString.padStart(3, '0'))}`,
          }));
          const originalIds = EffectArray.map(languagePacks, pack => pack.id);

          const first = projectCodeGraphStatusLanguagePacksV4(languagePacks, limit);
          const second = projectCodeGraphStatusLanguagePacksV4(languagePacks, limit);

          expect(second).toEqual(first);
          expect(EffectArray.map(languagePacks, pack => pack.id)).toEqual(originalIds);
          expect(first.items).toEqual(languagePacks.slice(0, limit));
          expect(first.items.length).toBeLessThanOrEqual(limit);
          expect(first.receipt).toEqual({
            limit,
            omitted: packCount - first.items.length,
            returned: first.items.length,
            total: packCount,
          });
        },
      ),
      {numRuns: 100},
    );
  });

  it('admits only the documented safe language-pack-limit range', () => {
    expect(codeGraphStatusLanguagePackLimit(undefined)).toBe(CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT);
    expect(codeGraphStatusLanguagePackLimit(1)).toBe(1);
    expect(codeGraphStatusLanguagePackLimit(CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT)).toBe(
      CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT,
    );
    for (const invalid of [0, CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT + 1, 1.5, Number.NaN]) {
      expect(codeGraphStatusLanguagePackLimit(invalid)).toBeUndefined();
    }
  });
});

function status(index: number, liveness: 'active' | 'completed'): ObservedCodeGraphBuildStatus {
  const timestamp = new Date(index * 1_000).toISOString();
  return {
    buildId: `build-${Effect.pipe(index.toString(16), EffectString.padStart(16, '0'))}`,
    counters: {completed: index, total: index + 1, unit: 'files'},
    identity: {
      checkoutId: hexId(200_000),
      commit: Effect.pipe(hexId(index), EffectString.slice(0, 40)),
      repositoryId: hexId(300_000),
      worktreeId: hexId(index),
    },
    observation: {heartbeatAgeMilliseconds: index, liveness},
    owner: {processId: index + 1, runtime: 'bun', runtimeVersion: '1.3.14'},
    phase: 'scanning',
    schemaVersion: 1,
    state: liveness === 'active' ? 'running' : 'completed',
    timestamps: {
      ...(liveness === 'completed' ? {completedAt: timestamp} : {}),
      heartbeatAt: timestamp,
      lastProgressAt: timestamp,
      phaseStartedAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function hexId(index: number): string {
  return Effect.pipe(index.toString(16), EffectString.padStart(64, '0'));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function projectMalformedBuildStatus(source: unknown) {
  // @ts-expect-error -- this test deliberately projects malformed runtime fields to verify sanitization.
  return projectCodeGraphStatusBuildSummaryV5(source);
}

function projectMalformedBuildActivity(builds: unknown, currentWorktreeId: string, limit: number) {
  // @ts-expect-error -- this test deliberately supplies oversized malformed build details to verify projection bounds.
  return projectCodeGraphStatusActivityV5({builds, waiters: []}, currentWorktreeId, limit);
}
