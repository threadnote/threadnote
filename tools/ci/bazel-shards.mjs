/**
 * @typedef {{
 *   label: string;
 *   kind: string;
 *   entries?: readonly string[];
 *   inputs?: readonly string[];
 *   requiresNetwork?: boolean;
 *   timeout?: string | null;
 * }} BazelTarget
 */

// Coarse wall-clock seconds from full-fallback GitHub Actions runs. Bazel's
// target shape is a useful fallback for new targets, but entry and input counts
// do not predict integration-test runtime well. Keep these values rounded so
// ordinary run-to-run noise does not reshuffle the matrix.
const DURATION_HINTS = new Map([
  ['//:format', 30],
  ['//:lint', 45],
  ['//apps/threadnote:test_long_heavy_integration_graph', 190],
  ['//apps/threadnote:test_long_heavy_integration_runtime', 290],
  ['//apps/threadnote:test_long_heavy_state', 170],
  ['//apps/threadnote:test_long_incremental_property', 170],
  ['//apps/threadnote:test_long_lifecycle_delta', 270],
  ['//apps/threadnote:test_long_os_contention', 30],
  ['//apps/threadnote:test_long_project_closure', 150],
  ['//apps/threadnote:test_postgres', 35],
  ['//packages/graph:test', 80],
  ['//packages/graph:test_runtime', 120],
  ['//packages/memory:test_runtime', 60],
]);

const REPOSITORY_CHECKS = new Set(['//:format', '//:lint', '//:test_typecheck', '//:workspace_check']);

/**
 * @param {BazelTarget} target
 */
function targetWeight(target) {
  const durationHint = DURATION_HINTS.get(target.label);
  if (durationHint !== undefined) return durationHint;
  const entryWeight = Math.max(target.entries?.length ?? 0, 1);
  const inputWeight = Math.max(Math.ceil((target.inputs?.length ?? 0) / 80), 1);
  const processWeight = target.kind === 'test' ? 15 : 0;
  const timeoutWeight = target.timeout === 'long' ? 20 : 0;
  const actionWeight = target.kind === 'action' ? 10 : 0;
  return processWeight + Math.max(entryWeight, inputWeight) + timeoutWeight + actionWeight;
}

/**
 * @param {string} label
 */
function targetName(label) {
  if (label.startsWith('//apps/threadnote:test_long_')) return label.slice('//apps/threadnote:test_long_'.length);
  if (label === '//apps/threadnote:test_postgres') return 'postgres tests';
  if (label.startsWith('//apps/threadnote:test_standard_')) return 'threadnote tests';
  if (label.startsWith('//packages/graph:')) return 'graph tests';
  if (label.startsWith('//apps/website:')) return 'website';
  if (label.startsWith('//packages/')) return 'package tests';
  if (label.startsWith('//infra/')) return 'infrastructure';
  return 'repository checks';
}

/**
 * Deterministically balances executable Bazel targets across independent CI
 * runners. Network targets stay together in one PostgreSQL-enabled shard;
 * ordinary targets may share that shard so the service lane does useful work.
 *
 * @param {{inventory: readonly BazelTarget[]; selected: readonly string[]; maxShards?: number}} input
 */
export function planBazelShards({inventory, selected, maxShards = 8}) {
  if (!Number.isSafeInteger(maxShards) || maxShards < 1) throw new Error('maxShards must be a positive integer');

  const selectedLabels = new Set(selected);
  const executable = inventory
    .filter(target => selectedLabels.has(target.label) && (target.kind === 'action' || target.kind === 'test'))
    .map(target => ({...target, weight: targetWeight(target)}));
  const network = executable.filter(target => target.requiresNetwork);
  const ordinary = executable.filter(target => !target.requiresNetwork);
  const checks = ordinary
    .filter(target => REPOSITORY_CHECKS.has(target.label))
    .sort((left, right) => left.label.localeCompare(right.label));
  const groups = ordinary
    .filter(target => !REPOSITORY_CHECKS.has(target.label))
    .map(target => ({targets: [target], weight: target.weight}));
  if (checks.length > 0) groups.push({targets: checks, weight: checks.reduce((sum, target) => sum + target.weight, 0)});
  const ordinaryShardCount = Math.min(groups.length, Math.max(maxShards - (network.length > 0 ? 1 : 0), 0));
  const bins = Array.from({length: ordinaryShardCount}, () => ({postgres: false, targets: [], weight: 0}));
  if (network.length > 0) {
    bins.push({
      postgres: true,
      targets: [...network].sort((left, right) => left.label.localeCompare(right.label)),
      weight: network.reduce((sum, target) => sum + target.weight, 0),
    });
  }
  if (ordinary.length > 0 && bins.length === 0) bins.push({postgres: false, targets: [], weight: 0});
  for (const group of groups.sort(
    (left, right) => right.weight - left.weight || left.targets[0].label.localeCompare(right.targets[0].label),
  )) {
    const bin = bins.reduce((best, candidate) => (candidate.weight < best.weight ? candidate : best));
    bin.targets.push(...group.targets);
    bin.weight += group.weight;
  }

  return bins
    .filter(bin => bin.targets.length > 0)
    .sort((left, right) => {
      if (left.postgres !== right.postgres) return left.postgres ? 1 : -1;
      return left.targets[0].label.localeCompare(right.targets[0].label);
    })
    .map((bin, index, all) => {
      const focus = [...bin.targets].sort(
        (left, right) => right.weight - left.weight || left.label.localeCompare(right.label),
      )[0];
      return {
        id: `shard-${String(index + 1).padStart(2, '0')}`,
        name: `${index + 1}/${all.length} · ${targetName(focus.label)}`,
        postgres: bin.postgres,
        estimatedWeight: bin.weight,
        targets: bin.targets.map(target => target.label).sort(),
      };
    });
}
