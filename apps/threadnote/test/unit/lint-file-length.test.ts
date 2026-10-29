import {Array as EffectArray, Schema} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {mkdir, mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  FILE_LENGTH_OXLINT_CONFIG,
  PRODUCTION_FILE_LINE_LIMIT,
  collectProductionCodeFiles,
  isProductionCodePath,
  productionCodeFiles,
  runProductionFileLengthLint,
  type OxlintFileLengthRequest,
} from '../../../../scripts/lint-file-length.js';

function runGit(repositoryRoot: string, arguments_: readonly string[]): void {
  const result = Bun.spawnSync({cmd: ['git', ...arguments_], cwd: repositoryRoot, stderr: 'pipe', stdout: 'pipe'});
  if (result.exitCode !== 0) throw TestError.make({message: new TextDecoder().decode(result.stderr)});
}

describe('production file length lint', () => {
  it('configures the native max-lines rule as a 2000-line error without path ignores', async () => {
    const config: unknown = await Bun.file(FILE_LENGTH_OXLINT_CONFIG).json();
    if (
      !Schema.is(
        Schema.Struct({
          ignorePatterns: Schema.optionalKey(Schema.Array(Schema.String)),
          rules: Schema.Record(Schema.String, Schema.Unknown),
        }),
      )(config)
    )
      throw TestError.make({message: 'Expected a native Oxlint configuration.'});
    expect(PRODUCTION_FILE_LINE_LIMIT).toBe(2_000);
    expect(config.rules['max-lines']).toEqual(['error', {max: 2_000, skipBlankLines: false, skipComments: false}]);
    expect(config.ignorePatterns).toBeUndefined();
  });

  it('includes production JavaScript and TypeScript while excluding tests and tooling', () => {
    for (const path of [
      'packages/example/src/index.ts',
      'packages/example/src/feature/view.tsx',
      'apps/website/src/client.js',
      'apps/website/src/app.mts',
    ]) {
      expect(isProductionCodePath(path)).toBe(true);
    }
    for (const path of [
      'test/unit/index.test.ts',
      'packages/example/src/index.test.ts',
      'packages/example/src/__tests__/index.ts',
      'apps/website/src/view.spec.tsx',
      'scripts/build.ts',
      'packages/example/src/styles.css',
    ]) {
      expect(isProductionCodePath(path)).toBe(false);
    }
  });

  fcProp(
    it,
    'selects every production path deterministically regardless iteration order',
    {indexes: FC.uniqueArray(FC.integer({max: 30, min: 0}), {maxLength: 30})},
    ({indexes}) => {
      const files = EffectArray.map(indexes, index => `packages/example/src/module-${index}.ts`);
      const expected = productionCodeFiles(files);

      expect(productionCodeFiles([...files].reverse())).toEqual(expected);
      expect(productionCodeFiles([...files, ...files])).toEqual(expected);
      expect(new Set(expected)).toEqual(new Set(files));
    },
    {fastCheck: {numRuns: 250}},
  );

  it('checks committed, working-tree, and untracked production files in one error-only pass', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'threadnote-file-length-'));
    try {
      await Promise.all([
        mkdir(join(repositoryRoot, 'scripts'), {recursive: true}),
        mkdir(join(repositoryRoot, 'packages/example/src'), {recursive: true}),
        mkdir(join(repositoryRoot, 'test'), {recursive: true}),
        mkdir(join(repositoryRoot, 'apps/website/src'), {recursive: true}),
      ]);
      await Promise.all([
        writeFile(join(repositoryRoot, 'scripts/tool.ts'), 'export {};\n'),
        writeFile(join(repositoryRoot, 'packages/example/src/committed.ts'), 'export const value = 1;\n'),
        writeFile(join(repositoryRoot, 'packages/example/src/legacy.ts'), 'export {};\n'),
        writeFile(join(repositoryRoot, 'packages/example/src/working-tree.ts'), 'export const value = 1;\n'),
        writeFile(join(repositoryRoot, 'test/large.test.ts'), 'export {};\n'),
        writeFile(join(repositoryRoot, 'apps/website/src/site.ts'), 'export {};\n'),
      ]);
      runGit(repositoryRoot, ['init']);
      runGit(repositoryRoot, ['add', '.']);
      runGit(repositoryRoot, [
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=threadnote@example.invalid',
        'commit',
        '-m',
        'fixture',
      ]);
      await writeFile(join(repositoryRoot, 'packages/example/src/committed.ts'), 'export const value = 2;\n');
      runGit(repositoryRoot, ['add', 'packages/example/src/committed.ts']);
      runGit(repositoryRoot, [
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=threadnote@example.invalid',
        'commit',
        '-m',
        'committed change',
      ]);
      await Promise.all([
        writeFile(join(repositoryRoot, 'packages/example/src/new.ts'), 'export {};\n'),
        writeFile(join(repositoryRoot, 'packages/example/src/working-tree.ts'), 'export const value = 2;\n'),
        writeFile(join(repositoryRoot, 'test/large.test.ts'), 'export const changed = true;\n'),
      ]);

      expect(collectProductionCodeFiles(repositoryRoot)).toEqual([
        'apps/website/src/site.ts',
        'packages/example/src/committed.ts',
        'packages/example/src/legacy.ts',
        'packages/example/src/new.ts',
        'packages/example/src/working-tree.ts',
      ]);

      const requests: OxlintFileLengthRequest[] = [];
      expect(
        runProductionFileLengthLint({
          execute: request => {
            requests.push(request);
            return 0;
          },
          repositoryRoot,
        }),
      ).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.files).toEqual([
        'apps/website/src/site.ts',
        'packages/example/src/committed.ts',
        'packages/example/src/legacy.ts',
        'packages/example/src/new.ts',
        'packages/example/src/working-tree.ts',
      ]);
    } finally {
      await rm(repositoryRoot, {force: true, recursive: true});
    }
  });
});
