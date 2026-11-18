import {Array, Record} from 'effect';
import fc from 'fast-check';
import {expect, it} from 'vitest';
import {partitionSmokeFiles} from '../windows-smoke-sequencer.js';
import durations from '../windows-smoke-durations.json' with {type: 'json'};
import {platformNeutralDevSkills} from '../windows-smoke.config.js';

it('balances the observed Windows lane across four serial runners', () => {
  const neutral = new Set(platformNeutralDevSkills());
  const lane = Array.filter(Record.keys(durations), file => !neutral.has(file));
  const shards = partitionSmokeFiles(lane, 4, file => file);
  const hints: Readonly<Record<string, number>> = durations;
  const totals = Array.map(shards, files => Array.reduce(files, 0, (sum, file) => sum + hints[file]));
  expect(Math.max(...totals)).toBeLessThan(1_200_000);
});

it('preserves complete disjoint coverage, determinism, inputs, and a bounded maximum load', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.record({id: fc.nat(10_000), milliseconds: fc.integer({min: 1, max: 1_000_000})}), {
        selector: value => value.id,
        maxLength: 80,
      }),
      fc.integer({min: 1, max: 8}),
      (files, count) => {
        const original = [...files];
        const hints = Record.fromEntries(Array.map(files, file => [String(file.id), file.milliseconds]));
        const pathOf = (file: (typeof files)[number]) => String(file.id);
        const shards = partitionSmokeFiles(files, count, pathOf, hints);
        expect(shards).toHaveLength(count);
        expect(shards).toEqual(partitionSmokeFiles([...files].reverse(), count, pathOf, hints));
        expect(files).toEqual(original);
        const flattened = Array.flatten(shards);
        expect(flattened).toHaveLength(files.length);
        expect(new Set(flattened)).toEqual(new Set(files));
        const totals = Array.map(shards, shard => Array.reduce(shard, 0, (sum, file) => sum + file.milliseconds));
        const sum = Array.reduce(files, 0, (total, file) => total + file.milliseconds);
        const maximum = Math.max(0, ...Array.map(files, file => file.milliseconds));
        expect(Math.max(...totals)).toBeLessThanOrEqual(sum / count + maximum);
      },
    ),
    {numRuns: 100},
  );
});

it('assigns newly discovered files even without historical timings', () => {
  expect(
    Array.flatten(partitionSmokeFiles(['new.test.ts', 'known.test.ts'], 4, file => file, {'known.test.ts': 1})).sort(),
  ).toEqual(['known.test.ts', 'new.test.ts']);
});

it.each([0, -1, 1.5, Infinity])('rejects invalid shard count %s', count => {
  expect(() => partitionSmokeFiles([], count, String)).toThrow('positive integer');
});
