import {Array, String} from 'effect';
import {relative} from '@threadnote/testing/node-path';
import {BaseSequencer, type TestSpecification} from 'vitest/node';
import observedDurations from './windows-smoke-durations.json' with {type: 'json'};

// CI run 41039873225; split lifecycle files use the sum of their original examples.
const durations: Readonly<Record<string, number>> = observedDurations;
const comparePaths = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function partitionSmokeFiles<T>(
  files: readonly T[],
  count: number,
  pathOf: (file: T) => string,
  hints: Readonly<Record<string, number>> = durations,
): T[][] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Shard count must be a positive integer.');
  const weight = (file: T) => hints[pathOf(file)] ?? 15_000;
  const bins = Array.makeBy(count, () => ({files: [] as T[], milliseconds: 0}));
  const ordered = [...files].sort(
    (left, right) => weight(right) - weight(left) || comparePaths(pathOf(left), pathOf(right)),
  );
  for (const file of ordered) {
    const target = Array.reduce(bins, bins[0], (best, bin) => (bin.milliseconds < best.milliseconds ? bin : best));
    target.files.push(file);
    target.milliseconds += weight(file);
  }
  return Array.map(bins, bin => bin.files);
}

export default class WindowsSmokeSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return Promise.resolve(files);
    return Promise.resolve(
      partitionSmokeFiles(files, shard.count, file =>
        String.replaceAll('\\', '/')(relative(this.ctx.config.root, file.moduleId)),
      )[shard.index - 1],
    );
  }
}
