import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {planBazelShards} from '../bazel-shards.mjs';

const targetArbitrary = fc
  .uniqueArray(
    fc.record({
      entries: fc.array(fc.string(), {maxLength: 20}),
      id: fc.integer({max: 100, min: 0}),
      inputs: fc.array(fc.string(), {maxLength: 100}),
      kind: fc.constantFrom('action', 'ci', 'library', 'test'),
      requiresNetwork: fc.boolean(),
      selected: fc.boolean(),
      timeout: fc.option(fc.constant('long'), {nil: null}),
    }),
    {maxLength: 30, selector: target => target.id},
  )
  .map(targets =>
    targets.map(target => ({
      ...target,
      label: `//generated:target_${target.id}`,
    })),
  );

describe('Bazel CI sharding', () => {
  it('isolates PostgreSQL targets and greedily balances the remaining work', () => {
    const inventory = [
      target('//apps/threadnote:test_standard_graph_01_of_04', 16),
      target('//apps/threadnote:test_standard_memory', 12),
      target('//packages/graph:test', 140),
      target('//packages/store:test', 2),
      {...target('//apps/threadnote:test_postgres', 11), requiresNetwork: true},
      {...target('//:recall_quality', 0), kind: 'ci'},
    ];

    const shards = planBazelShards({inventory, selected: inventory.map(candidate => candidate.label), maxShards: 4});

    expect(shards).toHaveLength(4);
    expect(shards.flatMap(shard => shard.targets).sort()).toEqual(
      inventory
        .filter(candidate => candidate.kind === 'test')
        .map(candidate => candidate.label)
        .sort(),
    );
    expect(shards.find(shard => shard.postgres)?.targets).toContain('//apps/threadnote:test_postgres');
  });

  it('uses measured duration hints to separate the known slow CI targets', () => {
    const inventory = [
      target('//apps/threadnote:test_long_heavy_integration_runtime', 1),
      target('//apps/threadnote:test_long_lifecycle_delta', 1),
      target('//apps/threadnote:test_long_heavy_integration_graph', 1),
      target('//apps/threadnote:test_long_incremental_property', 1),
      target('//apps/threadnote:test_long_project_closure', 1),
      target('//packages/graph:test_runtime', 1),
      {...target('//apps/threadnote:test_postgres', 1), requiresNetwork: true},
    ];

    const shards = planBazelShards({inventory, selected: inventory.map(candidate => candidate.label), maxShards: 6});
    const shardFor = (label: string) => shards.find(shard => shard.targets.includes(label))?.id;
    const runtimeShard = shards.find(shard =>
      shard.targets.includes('//apps/threadnote:test_long_heavy_integration_runtime'),
    );

    expect(runtimeShard?.estimatedWeight).toBe(290);
    expect(shardFor('//apps/threadnote:test_long_heavy_integration_runtime')).not.toBe(
      shardFor('//apps/threadnote:test_long_lifecycle_delta'),
    );
    expect(
      new Set([
        shardFor('//apps/threadnote:test_long_heavy_integration_graph'),
        shardFor('//apps/threadnote:test_long_incremental_property'),
        shardFor('//apps/threadnote:test_long_project_closure'),
        shardFor('//packages/graph:test_runtime'),
      ]).size,
    ).toBe(4);
  });

  it('plans selected integration package tests without adding unrelated provider targets', () => {
    const packages = ['core', 'runtime', 'obsidian', 'superhuman', 'pocket', 'github', 'linear'];
    const inventory = packages.map(name => target(`//packages/integration-${name}:test`, 8));
    const selected = packages.filter(name => name !== 'core').map(name => `//packages/integration-${name}:test`);
    const shards = planBazelShards({inventory, selected, maxShards: 8});
    const planned = shards.flatMap(shard => shard.targets);

    expect(shards).toHaveLength(selected.length);
    expect(planned.sort()).toEqual(selected.sort());
    expect(new Set(planned).size).toBe(selected.length);
    expect(shards.every(shard => shard.targets.length === 1)).toBe(true);
  });

  it('accounts for the process startup cost of generated test targets', () => {
    const inventory = [target('//apps/threadnote:test_standard_pooled_1_of_8', 1)];

    const [shard] = planBazelShards({inventory, selected: inventory.map(candidate => candidate.label), maxShards: 1});

    expect(shard.estimatedWeight).toBe(16);
  });

  it('is deterministic, bounded, complete, and duplicate-free for generated inventories', () => {
    fc.assert(
      fc.property(targetArbitrary, fc.integer({max: 8, min: 1}), (inventory, maxShards) => {
        const selected = inventory.filter(target => target.selected).map(target => target.label);
        const executable = inventory
          .filter(target => target.selected && (target.kind === 'action' || target.kind === 'test'))
          .map(target => target.label)
          .sort();
        const first = planBazelShards({inventory, selected, maxShards});
        const second = planBazelShards({
          inventory: [...inventory].reverse(),
          selected: [...selected].reverse(),
          maxShards,
        });
        const planned = first.flatMap(shard => shard.targets);

        expect(first).toEqual(second);
        expect(first.length).toBeLessThanOrEqual(maxShards);
        expect(planned.sort()).toEqual(executable);
        expect(new Set(planned).size).toBe(planned.length);
        for (const target of inventory.filter(
          candidate =>
            candidate.selected &&
            candidate.requiresNetwork &&
            (candidate.kind === 'action' || candidate.kind === 'test'),
        )) {
          expect(first.find(shard => shard.targets.includes(target.label))?.postgres).toBe(true);
        }
      }),
      {numRuns: 100},
    );
  });
});

function target(label: string, entryCount: number) {
  return {
    entries: Array.from({length: entryCount}, (_, index) => `test-${index}.ts`),
    inputs: [],
    kind: 'test',
    label,
    requiresNetwork: false,
    timeout: null,
  };
}
