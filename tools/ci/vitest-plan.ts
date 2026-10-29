import * as EffectRecord from 'effect/Record';
import {Array as EffectArray} from 'effect';
export const CI_STANDARD_TEST_TIMEOUT_MILLISECONDS = 30_000;

export const ciLongRunningTestGroups = {
  'lifecycle-alpha': ['apps/threadnote/test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-beta': ['apps/threadnote/test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-gamma': ['apps/threadnote/test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-delta': ['apps/threadnote/test/integration/code-graph.lifecycle.test.ts'],
  'project-closure': ['apps/threadnote/test/integration/code-graph.project-closure.test.ts'],
  'incremental-property': [
    'apps/threadnote/test/integration/code-graph.barrel-incremental.property.test.ts',
    'apps/threadnote/test/integration/code-graph.incremental.property.test.ts',
    'apps/threadnote/test/unit/code-graph.analysis-summary.property.test.ts',
    'apps/threadnote/test/unit/code-graph.resolution-summary.property.test.ts',
    'apps/threadnote/test/unit/code-graph.store-query.property.test.ts',
  ],
  'load-evidence': [
    'apps/threadnote/test/integration/code-graph.removed-view-cleanup-load.test.ts',
    'apps/threadnote/test/integration/code-graph.vector-retirement-load.test.ts',
    'apps/threadnote/test/integration/code-graph.cache-capacity-load.test.ts',
  ],
  'os-contention': [
    'apps/threadnote/test/integration/code-graph.repair-signal.test.ts',
    'apps/threadnote/test/integration/code-graph.read-bootstrap.test.ts',
    'apps/threadnote/test/integration/code-graph.view-attach-lock.test.ts',
    'apps/threadnote/test/integration/code-graph.vector-retirement-os.test.ts',
    'apps/threadnote/test/integration/code-graph.removed-view-cleanup-os.test.ts',
    'apps/threadnote/test/integration/code-graph.cache-capacity-os.test.ts',
    'apps/threadnote/test/integration/code-graph.disk-reservation.test.ts',
    'apps/threadnote/test/unit/code-graph.maintenance-residual-live.test.ts',
  ],
  // Recent release-branch PR timing keeps these runtime-boundary suites close
  // to the combined graph-heavy suites below without mixing their fixtures.
  'heavy-integration-runtime': [
    'apps/threadnote/test/integration/cli.effect.test.ts',
    'apps/threadnote/test/integration/mcp.native-tools.test.ts',
  ],
  'heavy-integration-graph': [
    'apps/threadnote/test/integration/code-graph.performance-evidence.test.ts',
    'apps/threadnote/test/integration/code-graph.snapshot-repair.property.test.ts',
    'apps/threadnote/test/integration/code-graph.cross-session-incremental.test.ts',
    'apps/threadnote/test/integration/code-graph.session.test.ts',
    'apps/threadnote/test/integration/code-graph.benchmark-preflight.test.ts',
    'apps/threadnote/test/unit/code-graph.tree-sitter-identity.property.test.ts',
    'apps/threadnote/test/unit/code-graph.languages.property.test.ts',
    'apps/threadnote/test/unit/code-graph.languages.test.ts',
  ],
  'heavy-state': [
    'apps/threadnote/test/unit/code-graph.workset-catalog-projection.test.ts',
    'apps/threadnote/test/unit/code-graph.removed-view-cleanup.property.test.ts',
    'apps/threadnote/test/unit/code-graph.view-removal.property.test.ts',
    'apps/threadnote/test/unit/code-graph.worktree-reconciliation.test.ts',
    'apps/threadnote/test/unit/code-graph.vector-retirement-schema.test.ts',
    'apps/threadnote/test/unit/code-graph.vector-retirement-ordinary.test.ts',
    'apps/threadnote/test/unit/code-graph.vector-maintenance.test.ts',
    'apps/threadnote/test/unit/code-graph.materialization-store.test.ts',
    'apps/threadnote/test/unit/evaluation.recall-v2.test.ts',
    'apps/threadnote/test/unit/code-graph.project-closure-store.test.ts',
    'apps/threadnote/test/unit/code-graph.snapshot-retention.test.ts',
    'apps/threadnote/test/integration/share.sync.test.ts',
    'apps/threadnote/test/unit/code-graph.cache-coalescer.test.ts',
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type CiLongRunningTestGroupName = keyof typeof ciLongRunningTestGroups;

export const ciLongRunningTestGroupNames = EffectRecord.keys(ciLongRunningTestGroups);

export const ciScheduledLongRunningTestGroupNames = [
  'load-evidence',
] as const satisfies readonly CiLongRunningTestGroupName[];

const ciScheduledLongRunningTestGroups = new Set<CiLongRunningTestGroupName>(ciScheduledLongRunningTestGroupNames);

export const ciRequiredLongRunningTestGroupNames = EffectArray.filter(
  ciLongRunningTestGroupNames,
  group => !ciScheduledLongRunningTestGroups.has(group),
);

// These groups exercise parser processes or shared state heavily enough that
// cross-file Vitest workers can starve otherwise fast fixtures on hosted runners.
export const ciSerializedLongRunningTestGroups = new Set<CiLongRunningTestGroupName>([
  'heavy-integration-runtime',
  'heavy-integration-graph',
  'heavy-state',
  'incremental-property',
  'load-evidence',
  'os-contention',
]);
