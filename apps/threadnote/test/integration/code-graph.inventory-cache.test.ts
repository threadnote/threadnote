import {Array as EffectArray} from 'effect';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Effect, Option} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {
  createPackageAttributor,
  extractRepositoryFileFacts,
  resolveExtractedRepositoryFacts,
} from '@threadnote/graph/extractor';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {inventoryRepository} from '@threadnote/graph/inventory';
import {codeGraphBlobReuseCacheKey} from '@threadnote/graph/blob_reuse';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph inventory cache rehydration', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, {force: true, recursive: true});
  });

  it('keeps compact package, TypeScript, and Go context across mixed cache hits without changing hashes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-inventory-cache-'));
    roots.push(root);
    createResolutionFixture(root);
    const firstBatches: CodeGraphInventoryFile[][] = [];
    const first = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity, {
          onContentBatch: files => Effect.sync(() => firstBatches.push([...files])),
        });
      }),
    );
    const firstByPath = new Map(EffectArray.map(first.files, file => [file.path, file]));
    const rawByPath = new Map(EffectArray.map(firstBatches.flat(), file => [file.path, file.content]));

    for (const path of ['go.mod', 'package.json', 'packages/library/package.json', 'tsconfig.json']) {
      const retained = firstByPath.get(path);
      const raw = rawByPath.get(path);
      expect(retained?.content, path).toBeDefined();
      expect(raw, path).toBeDefined();
      expect(Buffer.byteLength(retained!.content!), path).toBeLessThan(Buffer.byteLength(raw!));
      expect(retained).toMatchObject({path, size: Buffer.byteLength(raw!), source: 'commit'});
    }
    expect(firstByPath.get('go.mod')?.content).toContain('module example.com/cache-fixture');
    expect(firstByPath.get('go.mod')?.content).toContain('example.com/cache-dependency v1.2.3');
    expect(firstByPath.get('package.json')?.content).toBe(
      JSON.stringify({
        dependencies: {'@fixture/library': 'workspace:*'},
        main: './src/entry.ts',
        name: '@fixture/root',
      }),
    );
    expect(firstByPath.get('tsconfig.json')?.content).toContain('"@alias/*"');

    const cachedCommittedFileKeys = new Set(
      EffectArray.map(
        EffectArray.filter(first.files, file => file.path !== 'src/helper.ts'),
        inventoryCacheKey,
      ),
    );
    const secondBatches: CodeGraphInventoryFile[][] = [];
    const second = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity, {
          cachedCommittedFileKeys,
          onContentBatch: files => Effect.sync(() => secondBatches.push([...files])),
        });
      }),
    );

    expect(EffectArray.map(secondBatches, batch => EffectArray.map(batch, file => file.path))).toEqual([
      ['src/helper.ts'],
    ]);
    expect(second.parsedFiles).toBe(1);
    expect(EffectArray.map(second.files, file => [file.path, file.contentHash])).toEqual(
      EffectArray.map(first.files, file => [file.path, file.contentHash]),
    );
    for (const path of ['go.mod', 'package.json', 'packages/library/package.json', 'tsconfig.json']) {
      expect(Option.getOrUndefined(EffectArray.findFirst(second.files, file => file.path === path))?.content).toBe(
        firstByPath.get(path)?.content,
      );
    }

    const initialFacts = extractRepositoryFileFacts(firstBatches.flat());
    const cachedFacts = EffectArray.filter(initialFacts, facts => facts.path !== 'src/helper.ts');
    const freshFacts = extractRepositoryFileFacts(secondBatches.flat());
    const attributed = createPackageAttributor(second.files)([...cachedFacts, ...freshFacts]);
    const resolved = resolveExtractedRepositoryFacts(attributed, second.files);
    const symbols = EffectArray.flatMap(resolved, facts => facts.symbols);
    const edges = EffectArray.flatMap(resolved, facts => facts.edges);

    expect(
      Option.getOrUndefined(EffectArray.findFirst(symbols, symbol => symbol.name === 'entryFunction'))?.packageName,
    ).toBe('@fixture/root');
    expect(
      Option.getOrUndefined(EffectArray.findFirst(symbols, symbol => symbol.name === 'libraryFunction'))?.packageName,
    ).toBe('@fixture/library');
    expect(
      EffectArray.some(
        edges,
        edge =>
          edge.sourceName === 'entryFunction' &&
          edge.targetName === 'helperFunction' &&
          edge.provenance === 'resolved' &&
          edge.targetId !== undefined,
      ),
    ).toBe(true);
    expect(
      EffectArray.some(
        edges,
        edge =>
          edge.sourceName === 'entryFunction' &&
          edge.targetName === 'libraryFunction' &&
          edge.provenance === 'resolved' &&
          edge.targetId !== undefined,
      ),
    ).toBe(true);
    expect(
      EffectArray.some(
        edges,
        edge =>
          edge.sourceName === 'example.com/cache-fixture' &&
          edge.relation === 'depends_on' &&
          edge.targetName === 'example.com/cache-dependency',
      ),
    ).toBe(true);
  });

  it('excludes an oversized high-signal manifest before its extraction batch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-inventory-invalid-context-'));
    roots.push(root);
    execFileSync('git', ['-C', root, 'init', '-q']);
    const manifestContent = `{"name":"broken",${Effect2.pipe('x', EffectString.repeat(2 * 1_048_576))}`;
    writeFileSync(join(root, 'package.json'), manifestContent);
    writeFileSync(join(root, 'source.ts'), 'export const source = 1;\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'fixture',
    ]);
    let extractedBytes = 0;

    const inventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity, {
          onContentBatch: files =>
            Effect.sync(() => {
              extractedBytes += EffectArray.reduce(
                files,
                0,
                (total, file) => total + Buffer.byteLength(file.content ?? ''),
              );
            }),
        });
      }),
    );
    expect(extractedBytes).toBe(Buffer.byteLength('export const source = 1;\n'));
    expect(EffectArray.map(inventory.files, file => file.path)).toEqual(['source.ts']);
    expect(inventory.skipped).toBe(1);
    expect(inventory.policyExclusions).toMatchObject({
      bytes: Buffer.byteLength(manifestContent),
      files: 1,
      reasons: [
        {bytes: 0, files: 0, reason: 'svg'},
        {bytes: 0, files: 0, reason: 'low-signal-json'},
        {bytes: 0, files: 0, reason: 'generic-json-size'},
        {
          bytes: Buffer.byteLength(manifestContent),
          files: 1,
          reason: 'high-signal-json-hard-cap',
        },
      ],
    });
  });

  it('admits a new committed path from an existing eligible blob cache key without reading its content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-inventory-blob-cache-'));
    roots.push(root);
    execFileSync('git', ['-C', root, 'init', '-q']);
    mkdirSync(join(root, 'config', 'copies'), {recursive: true});
    const content = '{"nested":{"enabled":true}}\n';
    writeFileSync(join(root, 'config', 'donor.json'), content);
    writeFileSync(join(root, 'config', 'copies', 'target.json'), content);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'duplicate structured blob',
    ]);
    const first = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity);
      }),
    );
    const donor = Option.getOrUndefined(
      EffectArray.findFirst(first.committedFiles, file => file.path === 'config/donor.json'),
    )!;
    const cacheIdentity = Option.getOrThrow(BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentityForPath(donor.path));
    const reuseKey = codeGraphBlobReuseCacheKey(donor, cacheIdentity)!;
    const batches: CodeGraphInventoryFile[][] = [];

    const second = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity, {
          cachedCommittedFileKeys: new Set([reuseKey]),
          onContentBatch: files => Effect.sync(() => batches.push([...files])),
        });
      }),
    );

    expect(batches).toEqual([]);
    expect(second.parsedFiles).toBe(0);
    expect(EffectArray.map(second.files, file => file.path)).toEqual([
      'config/copies/target.json',
      'config/donor.json',
    ]);
    expect(EffectArray.every(second.files, file => file.content === undefined)).toBe(true);
  });

  it('rehydrates cached manifests during a new-commit rebuild without losing attribution or resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-inventory-cache-rebuild-'));
    const home = join(root, '.threadnote-home');
    roots.push(root);
    createResolutionFixture(root);

    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    writeFileSync(join(root, 'src', 'helper.ts'), 'export function helperFunction(): number { return 3; }\n');
    execFileSync('git', ['-C', root, 'add', 'src/helper.ts']);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'change one source file',
    ]);

    const rebuilt = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const graph = yield* store.loadGraph(
          join(home, 'indexes', 'code-graph', 'repositories', indexed.identity.checkoutId, 'graph-v3.sqlite'),
          indexed.snapshot.id,
        );
        return {graph, indexed};
      }),
    );

    expect(rebuilt.indexed.snapshot.id).not.toBe(first.snapshot.id);
    expect(rebuilt.indexed.reusedFiles).toBeGreaterThanOrEqual(rebuilt.indexed.snapshot.fileCount - 1);
    expect(
      Option.getOrUndefined(
        EffectArray.findFirst(
          rebuilt.graph.symbols,
          symbol => symbol.name === 'entryFunction' && symbol.path === 'src/entry.ts',
        ),
      )?.packageName,
    ).toBe('@fixture/root');
    expect(
      Option.getOrUndefined(
        EffectArray.findFirst(
          rebuilt.graph.symbols,
          symbol => symbol.name === 'libraryFunction' && symbol.path === 'packages/library/src/index.ts',
        ),
      )?.packageName,
    ).toBe('@fixture/library');
    expect(
      EffectArray.some(
        rebuilt.graph.edges,
        edge =>
          edge.sourceName === 'entryFunction' &&
          edge.targetName === 'helperFunction' &&
          edge.provenance === 'resolved' &&
          edge.targetId !== undefined,
      ),
    ).toBe(true);
    expect(
      EffectArray.some(
        rebuilt.graph.edges,
        edge =>
          edge.sourceName === 'entryFunction' &&
          edge.targetName === 'libraryFunction' &&
          edge.provenance === 'resolved' &&
          edge.targetId !== undefined,
      ),
    ).toBe(true);
    expect(
      EffectArray.some(
        rebuilt.graph.edges,
        edge =>
          edge.sourceName === 'example.com/cache-fixture' &&
          edge.relation === 'depends_on' &&
          edge.targetName === 'example.com/cache-dependency',
      ),
    ).toBe(true);
  }, 60_000);
});

function createResolutionFixture(root: string): void {
  execFileSync('git', ['-C', root, 'init', '-q']);
  mkdirSync(join(root, 'packages', 'library', 'src'), {recursive: true});
  mkdirSync(join(root, 'src'), {recursive: true});
  const padding = Effect2.pipe('x', EffectString.repeat(128 * 1_024));
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        dependencies: {'@fixture/library': 'workspace:*'},
        description: padding,
        exports: './src/entry.ts',
        name: '@fixture/root',
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, 'packages', 'library', 'package.json'),
    `${JSON.stringify({description: padding, exports: './src/index.ts', name: '@fixture/library'}, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {baseUrl: '.', paths: {'@alias/*': ['src/*']}},
        include: ['src/**/*.ts', 'packages/**/*.ts'],
        threadnoteTestPadding: padding,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, 'go.mod'),
    EffectArray.join(
      [
        'module example.com/cache-fixture',
        '',
        'require (',
        '  example.com/cache-dependency v1.2.3',
        ')',
        '',
        `// ${padding}`,
        '',
      ],
      '\n',
    ),
  );
  writeFileSync(
    join(root, 'src', 'entry.ts'),
    EffectArray.join(
      [
        "import {helperFunction} from '@alias/helper';",
        "import {libraryFunction} from '@fixture/library';",
        'export function entryFunction(): number { return helperFunction() + libraryFunction(); }',
        '',
      ],
      '\n',
    ),
  );
  writeFileSync(join(root, 'src', 'helper.ts'), 'export function helperFunction(): number { return 1; }\n');
  writeFileSync(
    join(root, 'packages', 'library', 'src', 'index.ts'),
    'export function libraryFunction(): number { return 2; }\n',
  );
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'fixture',
  ]);
}

function inventoryCacheKey(file: CodeGraphInventoryFile): string {
  const cacheIdentity = BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentityForPath(file.path);
  return `${file.path}\0${file.contentHash}\0${cacheIdentity._tag === 'Some' ? cacheIdentity.value : 'unmatched'}`;
}
