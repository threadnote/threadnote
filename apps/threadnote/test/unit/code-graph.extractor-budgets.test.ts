import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {Option} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  createResolutionAttributor,
  extractFileFacts,
  TYPESCRIPT_DYNAMIC_RELATIONSHIP_LIMIT,
} from '@threadnote/graph/extractor';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {extractStructuredSchemaFacts} from '@threadnote/graph/languages/schemas/extractor';
import {GENERIC_STRUCTURED_DECLARATION_LIMIT} from '@threadnote/graph/languages/schemas/policy';
import type {CodeGraphWorkspaceProject} from '@threadnote/graph/languages/types';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('code graph per-file extraction budgets', () => {
  it('bounds generic structured declarations deterministically across object widths', () => {
    fc.assert(
      fc.property(fc.integer({max: 800, min: 0}), width => {
        const content = JSON.stringify(
          EffectRecord.fromEntries(Array.from({length: width}, (_, index) => [`property-${index}`, {leaf: index}])),
        );
        const first = extractStructuredSchemaFacts(sourceFile('data/object.json', 'json', content), {
          packageName: Option.none(),
          project: Option.none(),
        });
        const second = extractStructuredSchemaFacts(sourceFile('data/object.json', 'json', content), {
          packageName: Option.none(),
          project: Option.none(),
        });

        expect(first).toEqual(second);
        expect(first.symbols.length).toBeLessThanOrEqual(GENERIC_STRUCTURED_DECLARATION_LIMIT + 1);
        if (width > GENERIC_STRUCTURED_DECLARATION_LIMIT) {
          expect(EffectArray.join(first.diagnostics, '\n')).toContain('generic structured declarations were bounded');
        }
      }),
      {numRuns: 40},
    );
  });

  it('does not materialize global resolution projections for generic structured leaves', () => {
    const file = sourceFile('data/object.json', 'json', JSON.stringify({root: {first: 1, second: 2}}));
    const extracted = extractStructuredSchemaFacts(file, {packageName: Option.none(), project: Option.none()});
    const [facts] = createResolutionAttributor([file])([extracted]);
    if (!facts) throw TestError.make({message: 'missing resolved structured facts'});
    const leaves = EffectArray.filter(facts.symbols, symbol => symbol.kind === 'property');

    expect(leaves.length).toBeGreaterThan(0);
    expect(EffectArray.every(leaves, symbol => (symbol.lookupKeys ?? []).length === 0)).toBe(true);
    expect(
      Option.getOrUndefined(EffectArray.findFirst(facts.symbols, symbol => symbol.kind === 'module'))?.lookupKeys,
    ).toEqual(expect.arrayContaining(['global:path:data%2Fobject.json']));
  });

  it('bounds pathological TypeScript calls while preserving imports, reexports, and later declarations', () => {
    const calls = Array.from({length: TYPESCRIPT_DYNAMIC_RELATIONSHIP_LIMIT + 2_000}, () => 'dependency();');
    const content = EffectArray.join(
      [
        'import {dependency} from "./dependency.js";',
        'export function generated(): void {',
        ...calls,
        '}',
        'export {dependency as forwarded} from "./dependency.js";',
        'export interface PreservedAfterBudget { readonly value: string }',
      ],
      '\n',
    );
    const startedAt = performance.now();
    const facts = extractFileFacts(sourceFile('src/generated.ts', 'typescript', content));
    const duration = performance.now() - startedAt;

    expect(EffectArray.filter(facts.edges, edge => edge.relation === 'calls')).toHaveLength(1);
    const references = facts.references;
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(references), values =>
          EffectArray.filter(values, (reference, index) => index in values && reference.relation === 'calls'),
        ),
      ),
    ).toHaveLength(1);
    expect(
      EffectArray.some(facts.edges, edge => edge.relation === 'imports' && edge.targetName === './dependency.js'),
    ).toBe(true);
    expect(
      EffectArray.some(facts.edges, edge => edge.relation === 'reexports' && edge.targetName === './dependency.js'),
    ).toBe(true);
    expect(EffectArray.some(facts.symbols, symbol => symbol.name === 'PreservedAfterBudget')).toBe(true);
    expect(EffectArray.join(facts.diagnostics, '\n')).toContain('call and construct relationships were bounded');
    expect(extractFileFacts(sourceFile('src/generated.ts', 'typescript', content))).toEqual(facts);
    expect(duration).toBeLessThan(5_000);
  });

  it('uses declaration-surface extraction for multi-megabyte generated TypeScript', () => {
    const content = EffectArray.join(
      [
        `/* ${Effect.pipe('generated ', EffectString.repeat(240_000))} */`,
        'import {dependency} from "./dependency.js";',
        'export function preserved(): void { dependency(); }',
        'export {dependency as forwarded} from "./dependency.js";',
      ],
      '\n',
    );
    const facts = extractFileFacts(sourceFile('src/huge-generated.ts', 'typescript', content));

    expect(EffectArray.some(facts.symbols, symbol => symbol.name === 'preserved')).toBe(true);
    expect(EffectArray.some(facts.edges, edge => edge.relation === 'imports')).toBe(true);
    expect(EffectArray.some(facts.edges, edge => edge.relation === 'reexports')).toBe(true);
    expect(EffectArray.some(facts.edges, edge => edge.relation === 'calls')).toBe(false);
    expect(EffectArray.join(facts.diagnostics, '\n')).toContain('declaration-surface extraction');
  });

  it.each([
    ['json', 'data/large.json', (padding: string) => `{"root":{"preserved":1},"payload":"${padding}"}`],
    [
      'jsonc',
      'data/large.jsonc',
      (padding: string) => `// retained comment\n{"root":{"preserved":1},"payload":"${padding}"}`,
    ],
    ['yaml', 'data/large.yaml', (padding: string) => `root:\n  preserved: value\npayload: ${padding}`],
  ] as const)('indexes large unknown generic %s as bounded metadata', (language, path, buildContent) => {
    const facts = extractStructuredSchemaFacts(
      sourceFile(path, language, buildContent(Effect.pipe('x', EffectString.repeat(5 * 1_024 * 1_024)))),
      {
        packageName: Option.none(),
        project: Option.none(),
      },
    );

    expect(EffectArray.map(facts.symbols, symbol => symbol.name)).toEqual([path]);
    expect(EffectArray.join(facts.diagnostics, '\n')).toContain('module metadata only');
  });

  it('keeps recognized multi-megabyte configs fully structured within their safety budget', () => {
    const content = `{"architecture":{"runtime":{"owner":"platform"}},"payload":"${Effect.pipe('x', EffectString.repeat(5 * 1_024 * 1_024))}"}`;
    const facts = extractStructuredSchemaFacts(sourceFile('config/runtime-config.json', 'json', content), {
      packageName: Option.none(),
      project: Option.none(),
    });

    expect(EffectArray.map(facts.symbols, symbol => symbol.name)).toEqual(
      expect.arrayContaining(['architecture', 'runtime', 'owner', 'payload']),
    );
    expect(facts.diagnostics).toEqual([]);
  });

  it('locates quoted, escaped, and duplicate JSON keys in one linear source pass', () => {
    const content = EffectArray.join(
      ['{', '  "ordinary": 1,', '  "escaped\\u0020key": {', '    "duplicate": {"duplicate": 2}', '  }', '}'],
      '\n',
    );
    const facts = extractStructuredSchemaFacts(sourceFile('config/locations.json', 'json', content), {
      packageName: Option.none(),
      project: Option.none(),
    });

    expect(
      Option.getOrUndefined(EffectArray.findFirst(facts.symbols, symbol => symbol.name === 'ordinary'))?.span,
    ).toMatchObject({
      column: 4,
      endColumn: 12,
      line: 2,
    });
    expect(
      Option.getOrUndefined(EffectArray.findFirst(facts.symbols, symbol => symbol.name === 'escaped key'))?.span,
    ).toMatchObject({
      column: 4,
      endColumn: 20,
      line: 3,
    });
    expect(
      EffectArray.map(
        EffectArray.filter(facts.symbols, symbol => symbol.name === 'duplicate'),
        symbol => symbol.span.line,
      ),
    ).toEqual([4, 4]);
    expect(
      EffectArray.map(
        EffectArray.filter(facts.symbols, symbol => symbol.name === 'duplicate'),
        symbol => symbol.span.column,
      ),
    ).toEqual([6, 20]);
  });

  it('shallow-extracts recognized configs above the full-structure safety budget', () => {
    const content = `{"architecture":{"owner":"runtime"},"payload":"${Effect.pipe('x', EffectString.repeat(17 * 1_024 * 1_024))}"}`;
    const facts = extractStructuredSchemaFacts(sourceFile('config/architecture-schema.json', 'json', content), {
      packageName: Option.none(),
      project: Option.none(),
    });

    expect(EffectArray.map(facts.symbols, symbol => symbol.name)).toEqual(
      expect.arrayContaining(['architecture', 'owner', 'payload']),
    );
    expect(facts.symbols.length).toBeLessThanOrEqual(129);
    expect(EffectArray.join(facts.diagnostics, '\n')).toContain('bounded shallow extraction');
  });

  it('keeps a 25 MiB generic JSON file searchable without materializing its object graph', () => {
    const content = `{"architecture":{"owner":"runtime"},"payload":"${Effect.pipe('x', EffectString.repeat(25 * 1_024 * 1_024))}"}`;
    const startedAt = performance.now();
    const facts = extractStructuredSchemaFacts(sourceFile('data/large.json', 'json', content), {
      packageName: Option.none(),
      project: Option.none(),
    });
    const duration = performance.now() - startedAt;

    expect(EffectArray.map(facts.symbols, symbol => symbol.name)).toEqual(['data/large.json']);
    expect(EffectArray.join(facts.diagnostics, '\n')).toContain('module metadata only');
    expect(duration).toBeLessThan(1_000);
  });

  it.each([
    'test/__snapshots__/api.json',
    'test/golden/render.json',
    'models-document/test/golden-data/example/v1/checksum_info.json',
    'models-document/test/golden_data/example/v1/checksum_info.json',
    'fixtures/events.json',
    'logs/oplog/session.json',
    'evaluation/results.json',
    'datasets/prompts.json',
    'assets/animations/loading.json',
  ])('keeps low-signal structured corpus metadata-only by default: %s', path => {
    const facts = extractStructuredSchemaFacts(sourceFile(path, 'json', '{"frames":[{"value":1}]}'), {
      packageName: Option.none(),
      project: Option.none(),
    });

    expect(EffectArray.map(facts.symbols, symbol => symbol.name)).toEqual([path]);
    expect(EffectArray.join(facts.diagnostics, '\n')).toContain('module metadata only');
  });

  it('does not classify golden-like path prefixes as low-signal directories', () => {
    const path = 'models-document/test/golden-database/example/v1/checksum_info.json';
    const facts = extractStructuredSchemaFacts(sourceFile(path, 'json', '{"checksum":{"algorithm":"sha256"}}'), {
      packageName: Option.none(),
      project: Option.none(),
    });

    expect(EffectArray.map(facts.symbols, symbol => symbol.name)).toEqual(
      expect.arrayContaining([path, 'checksum', 'algorithm']),
    );
    expect(facts.diagnostics).toEqual([]);
  });

  it('extracts low-signal structured metadata without receiving its payload', () => {
    const path = 'test/__snapshots__/large.json';
    const facts = extractStructuredSchemaFacts(
      {
        blobId: 'blob:snapshot',
        contentHash: 'snapshot-hash',
        contentOmittedReason: 'metadata-only',
        language: 'json',
        mode: '100644',
        path,
        size: 25 * 1_024 * 1_024,
        source: 'commit',
      },
      {packageName: Option.none(), project: Option.none()},
    );

    expect(EffectArray.map(facts.symbols, symbol => symbol.name)).toEqual([path]);
    expect(EffectArray.join(facts.diagnostics, '\n')).toContain('module metadata only');
  });

  it('keeps bounded iOS asset-catalog scalar values searchable', () => {
    const path = 'Mobile/Assets.xcassets/AppIcon.appiconset/Contents.json';
    const facts = extractStructuredSchemaFacts(
      sourceFile(
        path,
        'json',
        JSON.stringify({
          images: [{filename: 'AppIcon-Monochrome@3x.png', idiom: 'universal', scale: '3x'}],
          info: {author: 'xcode', version: 1},
        }),
      ),
      {packageName: Option.some('MobileApp'), project: Option.none()},
    );

    const resourceValues = EffectArray.filter(facts.symbols, symbol => symbol.kind === 'resource-value');
    expect(EffectArray.map(resourceValues, symbol => symbol.name)).toEqual(
      expect.arrayContaining(['AppIcon-Monochrome@3x.png', 'universal', '3x', 'xcode', '1']),
    );
    expect(
      Option.getOrUndefined(
        EffectArray.findFirst(resourceValues, symbol => symbol.name === 'AppIcon-Monochrome@3x.png'),
      )?.lookupKeys,
    ).toEqual(expect.arrayContaining(['app', 'icon', 'monochrome', '3x', 'png']));
    expect(EffectArray.every(resourceValues, symbol => symbol.packageName === 'MobileApp')).toBe(true);
  });

  it('attributes iOS asset-catalog values to the nearest typed mobile component through the registry', async () => {
    const project: CodeGraphWorkspaceProject = {
      buildSystem: 'xcode',
      dependencies: [],
      dependencyDetails: [],
      diagnostics: [],
      id: 'cgp_mobile',
      kind: 'project',
      languages: ['swift'],
      name: 'MobileApp',
      provenance: 'declared',
      resolutionDomain: 'swift',
      root: 'Mobile',
      sourceRoots: ['Mobile'],
      workspaceId: 'cgw_mobile',
      workspaceRoots: ['Mobile'],
    };
    const facts = await runEffect(
      BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(
        sourceFile(
          'Mobile/Assets.xcassets/AppIcon.appiconset/Contents.json',
          'json',
          JSON.stringify({images: [{filename: 'AppIcon-Monochrome.png'}]}),
        ),
        [project],
      ),
    );

    expect(
      Option.getOrUndefined(EffectArray.findFirst(facts.symbols, symbol => symbol.kind === 'resource-value')),
    ).toMatchObject({
      name: 'AppIcon-Monochrome.png',
      packageName: 'MobileApp',
    });
  });

  it('keeps dedicated package manifests fully functional above the generic config threshold', () => {
    const content = JSON.stringify({
      dependencies: {'@fixture/runtime': '1.0.0'},
      name: '@fixture/large-manifest',
      padding: Effect.pipe('x', EffectString.repeat(5 * 1_024 * 1_024)),
    });
    const facts = extractFileFacts(sourceFile('package.json', 'npm-manifest', content));

    expect(facts.symbols).toEqual(expect.arrayContaining([expect.objectContaining({name: '@fixture/large-manifest'})]));
    expect(facts.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({relation: 'depends_on', targetName: '@fixture/runtime'})]),
    );
  });
});

function sourceFile(path: string, language: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: `blob:${path}`,
    content,
    contentHash: `hash:${path}`,
    language,
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}
