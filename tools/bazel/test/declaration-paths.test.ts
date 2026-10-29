import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {expect, it} from 'vitest';
import {bazelSourceLabel, packageExportPatterns, packageOwner} from '../declaration-paths.mjs';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const covers = (pattern: string, file: string) =>
  Effect.pipe(pattern, EffectString.endsWith('/**'))
    ? Effect.pipe(file, EffectString.startsWith(Effect.pipe(pattern, EffectString.slice(0, -2))))
    : pattern === file;

it('collapses package files to stable top-level export patterns', () => {
  expect(
    packageExportPatterns(['test/unit/example.test.ts', 'src/nested/value.ts', 'package.json', 'src/index.ts']),
  ).toEqual(['package.json', 'src/**', 'test/**']);
});

it('covers every declared file without making nested additions expand the BUILD declaration', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(
        fc.tuple(
          fc.constantFrom('src', 'test', 'assets', 'public'),
          fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/), {minLength: 1, maxLength: 3}),
        ),
        {maxLength: 20, selector: value => EffectArray.join([value[0], EffectArray.join(value[1], ',')], '/')},
      ),
      entries => {
        const files = EffectArray.map(entries, ([root, parts]) => `${root}/${EffectArray.join(parts, '/')}.ts`);
        const patterns = packageExportPatterns(files);
        expect(EffectArray.every(files, file => EffectArray.some(patterns, pattern => covers(pattern, file)))).toBe(
          true,
        );
        expect(packageExportPatterns([...files, 'src/new/deep/file.ts'])).toEqual(
          packageExportPatterns([...files, 'src/existing.ts']),
        );
      },
    ),
    {numRuns: 50},
  );
});

it('uses the nearest hand-written Bazel package for generated source labels', () => {
  const packageRoots = ['infra', 'infra/telemetry-gateway', 'infra/telemetry-gateway/internal/budget'];
  const file = 'infra/telemetry-gateway/internal/budget/state.go';
  expect(packageOwner(file, [...packageRoots].reverse())).toBe('infra/telemetry-gateway/internal/budget');
  expect(bazelSourceLabel(file, packageRoots)).toBe('//infra/telemetry-gateway/internal/budget:state.go');
  expect(bazelSourceLabel('README.md', packageRoots)).toBe('//:README.md');
});
