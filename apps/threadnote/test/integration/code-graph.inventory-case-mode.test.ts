import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {inventoryRepository, previewCodeGraphInventory} from '@threadnote/graph/inventory';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {runCommandEffect} from '@threadnote/platform/command';
import {StandaloneBrokerLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('portable Git ignore matching', () => {
  fcEffectProp(
    it,
    'keeps committed inventory and preview invariant under the local Git case setting',
    {suffix: fc.array(fc.constantFrom(...'abcdef'), {maxLength: 6}).map(chars => EffectArray.join(chars, ''))},
    ({suffix}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-inventory-case-'});
        yield* fs.makeDirectory(path.join(root, 'src'));
        const admitted = `src/Value${suffix}.ts`;
        const excluded = `src/ignored${suffix}.ts`;
        yield* fs.writeFileString(path.join(root, 'src/always.ts'), 'export const always = true;\n');
        yield* fs.writeFileString(path.join(root, admitted), 'export const value = 1;\n');
        yield* fs.writeFileString(path.join(root, excluded), 'export const ignored = 2;\n');
        yield* fs.writeFileString(
          path.join(root, '.gitignore'),
          `${Effect2.pipe(admitted, EffectString.toLowerCase)}\n${excluded}\n`,
        );
        yield* git(root, ['init', '-q']);
        yield* git(root, ['add', '-f', admitted, excluded, 'src/always.ts', '.gitignore']);
        yield* git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
        const observations = [];
        for (const mode of ['false', 'true']) {
          yield* git(root, ['config', 'core.ignorecase', mode]);
          const identity = yield* resolveRepositoryIdentity(root);
          const inventory = yield* inventoryRepository(identity);
          const preview = yield* previewCodeGraphInventory(identity, {includeOverlay: false});
          expect(inventory.dirty).toBe(false);
          expect(EffectArray.map(inventory.files, file => file.path)).toEqual([admitted, 'src/always.ts']);
          expect(
            Effect2.pipe((yield* git(root, ['config', '--get', 'core.ignorecase'])).stdout, EffectString.trim),
          ).toBe(mode);
          expect((yield* git(root, ['status', '--porcelain'])).stdout).toBe('');
          observations.push({
            files: inventory.files,
            skipped: inventory.skipped,
            groups: preview.groups,
            totals: preview.totals,
          });
        }
        expect(observations[1]).toEqual(observations[0]);
      }).pipe(provideTestLayer(StandaloneBrokerLayer), TestClock.withLive),
    {fastCheck: {numRuns: 12}},
  );
});

function git(repo: string, args: readonly string[]) {
  return runCommandEffect('git', ['-C', repo, ...args]);
}
