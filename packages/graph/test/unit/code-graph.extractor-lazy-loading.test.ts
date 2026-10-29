import {Array as EffectArray} from 'effect';
import {expect, it} from 'vitest';
import * as FC from 'fast-check';
import {extractFileFacts} from '@threadnote/graph/extractor';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import {mkdtempSync, rmSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

it('loads the TypeScript compiler only for TypeScript extraction, preserving its identity and repeated facts', () => {
  // This contract is process-global module loading, so an isolated CLI boundary is intentional.
  const child = Bun.spawnSync(
    [
      process.execPath,
      '--eval',
      `
const compilerPath = require.resolve('typescript-compiler');
const loaded = () => Object.hasOwn(require.cache, compilerPath);
await import('./apps/threadnote/src/effect/runtime.ts');
const {extractFileFacts, createRepositoryFactAttributor} = await import('@threadnote/graph/extractor');
const {codeGraphLanguagePack} = await import('@threadnote/graph/languages/typescript/pack');
const states = [loaded()];
const file = (path, language, content) => ({
  blobId: 'b'.repeat(40), content, contentHash: 'a'.repeat(64), language,
  mode: '100644', path, size: Buffer.byteLength(content), source: 'commit',
});
const manifest = file('package.json', 'npm-manifest', '{"name":"@test/lazy"}');
const documentation = file('README.md', 'markdown', '# Lazy loading');
const nonTypeScriptFacts = [extractFileFacts(manifest), extractFileFacts(documentation)];
const attributed = createRepositoryFactAttributor([manifest, documentation])(nonTypeScriptFacts);
states.push(loaded());
const identityBefore = codeGraphLanguagePack.extractor.version;
const source = file('src/example.ts', 'typescript', 'export function example(value: number) { return value + 1; }');
const first = extractFileFacts(source);
states.push(loaded());
const second = extractFileFacts(source);
states.push(loaded());
const compiler = await import('typescript-compiler');
const compilerVersion = compiler.default.version;
const packageVersion = (await import('typescript-compiler/package.json')).default.version;
const expectedIdentity = new Bun.CryptoHasher('sha256')
  .update('typescript-compiler-v5-bounded-deduplicated-relationship-surface\\ntypescript:' + compilerVersion)
  .digest('hex');
process.stdout.write(JSON.stringify({
  states, compilerVersion, packageVersion, expectedIdentity, identityBefore,
  identityAfter: codeGraphLanguagePack.extractor.version,
  repeatedFactsEqual: JSON.stringify(first) === JSON.stringify(second),
  declarations: first.symbols.map(symbol => symbol.name),
  nonTypeScriptNames: attributed.flatMap(facts => facts.symbols.map(symbol => symbol.name)),
}) + '\\n');
`,
    ],
    {cwd: Bun.fileURLToPath(new URL('../../../..', import.meta.url)), stderr: 'pipe', stdout: 'pipe'},
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const observed = JSON.parse(child.stdout.toString());
  expect(observed.states).toEqual([false, false, true, true]);
  expect(observed.compilerVersion).toBe(observed.packageVersion);
  expect(observed.identityBefore).toBe(observed.expectedIdentity);
  expect(observed.identityAfter).toBe(observed.identityBefore);
  expect(observed.repeatedFactsEqual).toBe(true);
  expect(observed.declarations).toContain('example');
  expect(observed.nonTypeScriptNames).toEqual(expect.arrayContaining(['@test/lazy', 'Lazy loading']));
});

it('preserves facts and caller inputs across repeated cached-compiler extraction', () => {
  FC.assert(
    FC.property(FC.integer({min: 0, max: 1_000}), FC.integer({min: -100, max: 100}), (suffix, increment) => {
      const content = `export function example${suffix}(value: number) { return value + ${increment}; }`;
      const file: CodeGraphInventoryFile = {
        blobId: Effect.pipe('b', EffectString.repeat(40)),
        content,
        contentHash: Effect.pipe('a', EffectString.repeat(64)),
        language: 'typescript',
        mode: '100644',
        path: `src/example-${suffix}.ts`,
        size: Buffer.byteLength(content),
        source: 'commit',
      };
      const before = structuredClone(file);
      const first = extractFileFacts(file);
      extractFileFacts({...file, content: 'export const unrelated = 1;', path: 'src/unrelated.ts'});
      expect(extractFileFacts(file)).toEqual(first);
      expect(file).toEqual(before);
    }),
    {numRuns: 25},
  );
});

it.each([false, true])('bundles the lazy compiler outside the dependency checkout (compiled: %s)', async compiled => {
  // The program under test is the Bun bundler and its child-process module boundary.
  const directory = mkdtempSync(join(tmpdir(), 'threadnote-lazy-extractor-'));
  try {
    const executable = join(directory, process.platform === 'win32' ? 'extractor.exe' : 'extractor');
    const result = await Bun.build({
      ...(compiled ? {bytecode: true, compile: {outfile: executable}} : {outdir: directory}),
      entrypoints: [
        Bun.fileURLToPath(
          new URL('../../../../apps/threadnote/test/fixtures/code-graph-lazy-extractor.ts', import.meta.url),
        ),
      ],
      format: 'esm',
      minify: true,
      target: 'bun',
    });
    expect(
      result.success,
      EffectArray.join(
        EffectArray.map(result.logs, log => log.message),
        '\n',
      ),
    ).toBe(true);
    const child = Bun.spawnSync(
      compiled ? [executable] : [process.execPath, join(directory, 'code-graph-lazy-extractor.js')],
      {cwd: directory, stderr: 'pipe', stdout: 'pipe'},
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toContain('bundledExample');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
