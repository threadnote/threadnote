import {Array as EffectArray, Option as EffectOption} from 'effect';
import {readFileSync, readdirSync, statSync} from '@threadnote/testing/node-fs';
import {join, relative} from '@threadnote/testing/node-path';
import * as FC from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  createPackageAttributor,
  createRepositoryFactAttributor,
  createRepositoryFactResolver,
  extractRepositoryFacts,
  extractRepositoryFileFacts,
} from '@threadnote/graph/extractor';
import {
  createRepositoryFactAttributionContext,
  createRepositoryFactAttributorFromContext,
  repositoryFactCandidatePaths,
} from '@threadnote/graph/extractor_context';
import {createCachedCodeGraphFactsAttributor, deriveCachedCodeGraphFacts} from '@threadnote/graph/indexer';
import {discoverManifestWorkspace} from '@threadnote/graph/workspace';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const REPOSITORY = join(
  import.meta.dirname,
  '../../../../apps/threadnote/test/evaluation/fixtures/code-graph-v1/repository',
);

describe('native code graph extraction', () => {
  const files = fixtureFiles(REPOSITORY);
  const facts = extractRepositoryFacts(files);
  const symbols = EffectArray.flatMap(facts, file => file.symbols);
  const edges = EffectArray.flatMap(facts, file => file.edges);

  it('extracts the reviewed symbol contract with repository-relative evidence', () => {
    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({kind: 'function', name: 'withExclusiveFileLock', path: 'packages/core/src/lock.ts'}),
        expect.objectContaining({kind: 'class', name: 'FileLock', path: 'packages/core/src/lock.ts'}),
        expect.objectContaining({kind: 'interface', name: 'LockLease', path: 'packages/core/src/lock.ts'}),
        expect.objectContaining({kind: 'function', name: 'ensureVectorIndex'}),
        expect.objectContaining({kind: 'function', name: 'refreshRecallIndex'}),
        expect.objectContaining({kind: 'function', name: 'runApplication', packageName: '@fixture/app'}),
      ]),
    );
    expect(
      EffectArray.every(
        symbols,
        symbol =>
          !Effect.pipe(symbol.path, EffectString.startsWith('/')) &&
          !Effect.pipe(symbol.path, EffectString.includes('\\')),
      ),
    ).toBe(true);
  });

  it('resolves only grounded cross-file relationships and keeps provenance explicit', () => {
    const keys = EffectArray.map(
      edges,
      edge => `${edge.sourceName}:${edge.relation}:${edge.targetName}:${edge.provenance}`,
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        'ensureVectorIndex:calls:withExclusiveFileLock:resolved',
        'refreshRecallIndex:calls:withExclusiveFileLock:resolved',
        'VectorIndexCoordinator:extends:FileLock:resolved',
        'runApplication:calls:ensureVectorIndex:resolved',
        '@fixture/app:depends_on:@fixture/search:declared',
        '@fixture/search:depends_on:@fixture/core:declared',
      ]),
    );
    expect(
      EffectArray.every(
        EffectArray.filter(edges, edge => edge.provenance === 'resolved'),
        edge => Boolean(edge.sourceId && edge.targetId),
      ),
    ).toBe(true);
    expect(EffectArray.some(edges, edge => edge.targetName === 'Error' && edge.provenance === 'resolved')).toBe(false);
  });

  it('resolves file batches equivalently while retaining only symbols and reexports globally', () => {
    const attributePackages = createPackageAttributor(files);
    const attributed = EffectArray.map(files, file => attributePackages(extractRepositoryFileFacts([file]))[0]);
    const resolver = createRepositoryFactResolver(
      EffectArray.map(attributed, file => ({
        diagnostics: [],
        edges: EffectArray.filter(file.edges, edge => edge.relation === 'reexports'),
        path: file.path,
        symbols: file.symbols,
      })),
      files,
    );
    const streamed = EffectArray.flatMap(attributed, file => resolver.resolve([file]));

    expect(streamed).toEqual(facts);
  });

  it('rehydrates deferred raw references before applying Node workspace scopes', () => {
    const cachedFiles = [
      sourceFile('package.json', '{"name":"cached-workspace"}\n'),
      sourceFile('dependency.ts', 'export function dependency(): number { return 1; }\n'),
      sourceFile(
        'consumer.ts',
        'import {dependency} from "./dependency.js";\n' +
          'export function consumer(): number { return dependency(); }\n',
      ),
    ];
    const raw = extractRepositoryFileFacts(cachedFiles);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(
            EffectOption.getOrUndefined(EffectArray.findFirst(raw, file => file.path === 'consumer.ts'))?.references,
          ),
          __effectArrayReceiver =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(__effectArrayReceiver, reference => reference.relation === 'calls'),
            ),
        ),
      )?.lookupTiers,
    ).toEqual([]);

    const derived = deriveCachedCodeGraphFacts(cachedFiles, discoverManifestWorkspace(cachedFiles), raw);
    const callReference = EffectOption.getOrUndefined(
      EffectOption.map(
        EffectOption.fromNullishOr(
          EffectOption.getOrUndefined(EffectArray.findFirst(derived, file => file.path === 'consumer.ts'))?.references,
        ),
        __effectArrayReceiver =>
          EffectOption.getOrUndefined(
            EffectArray.findFirst(__effectArrayReceiver, reference => reference.relation === 'calls'),
          ),
      ),
    );
    const dependency = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.flatMap(derived, file => file.symbols),
        symbol => symbol.name === 'dependency',
      ),
    );
    const resolved = createRepositoryFactResolver(derived, cachedFiles).resolve(derived);

    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(callReference?.lookupTiers.flat()), __effectArrayReceiver =>
          EffectArray.some(
            __effectArrayReceiver,
            __effectArrayValue => !!(key => dependency?.lookupKeys?.includes(key))(__effectArrayValue),
          ),
        ),
      ),
    ).toBe(true);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(callReference?.lookupTiers.flat()), __effectArrayReceiver =>
          EffectArray.every(
            __effectArrayReceiver,
            __effectArrayValue => !!(key => Effect.pipe(key, EffectString.includes(':cgp_')))(__effectArrayValue),
          ),
        ),
      ),
    ).toBe(true);
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          EffectArray.flatMap(resolved, file => file.edges),
          edge => edge.sourceName === 'consumer' && edge.relation === 'calls',
        ),
      ),
    ).toMatchObject({provenance: 'resolved', targetId: dependency?.id, targetName: 'dependency'});
  });

  it('resolves documentation through explicit global lookup keys only', () => {
    const cachedFiles = [
      sourceFile('src/service.ts', 'class Service { private privateValue(): number { return 1; } }\n'),
      sourceFile('docs/note.md', '# Internals\n\nSee `privateValue`.\n'),
    ];
    const workspace = discoverManifestWorkspace(cachedFiles);
    const raw = extractRepositoryFileFacts(cachedFiles);
    const derived = deriveCachedCodeGraphFacts(cachedFiles, workspace, raw);
    const privateSymbol = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.flatMap(derived, file => file.symbols),
        symbol => symbol.name === 'privateValue',
      ),
    );
    const unresolved = createRepositoryFactResolver(derived, cachedFiles).resolve(derived);

    expect(privateSymbol).toBeDefined();
    expect(privateSymbol?.exported).toBe(false);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(privateSymbol?.lookupKeys), __effectArrayReceiver =>
          EffectArray.some(
            __effectArrayReceiver,
            __effectArrayValue => !!(key => Effect.pipe(key, EffectString.startsWith('global:')))(__effectArrayValue),
          ),
        ),
      ),
    ).toBe(false);
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          EffectArray.flatMap(unresolved, file => file.edges),
          edge => edge.relation === 'documents' && edge.targetName === 'privateValue',
        ),
      )?.targetId,
    ).toBeUndefined();

    const explicitRaw = EffectArray.map(raw, file => ({
      ...file,
      symbols: EffectArray.map(file.symbols, symbol =>
        symbol.name === 'privateValue'
          ? {...symbol, lookupKeys: [...(symbol.lookupKeys ?? []), 'global:name:privateValue']}
          : symbol,
      ),
    }));
    const explicitDerived = deriveCachedCodeGraphFacts(cachedFiles, workspace, explicitRaw);
    const explicitPrivateSymbol = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.flatMap(explicitDerived, file => file.symbols),
        symbol => symbol.name === 'privateValue',
      ),
    );
    const resolved = createRepositoryFactResolver(explicitDerived, cachedFiles).resolve(explicitDerived);

    expect(explicitPrivateSymbol?.lookupKeys).toContain('global:name:privateValue');
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          EffectArray.flatMap(resolved, file => file.edges),
          edge => edge.relation === 'documents' && edge.targetName === 'privateValue',
        ),
      ),
    ).toMatchObject({provenance: 'syntactic', targetId: explicitPrivateSymbol?.id, targetName: 'privateValue'});

    const documentationFiles = [sourceFile('docs/a.md', 'See `Target`.\n'), sourceFile('docs/b.md', '# Target\n')];
    const rawDocumentation = extractRepositoryFacts(documentationFiles);
    const rawHeading = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.flatMap(rawDocumentation, file => file.symbols),
        symbol => symbol.name === 'Target',
      ),
    );
    const derivedDocumentation = deriveCachedCodeGraphFacts(
      documentationFiles,
      discoverManifestWorkspace(documentationFiles),
      extractRepositoryFileFacts(documentationFiles),
    );
    const resolvedDocumentation = createRepositoryFactResolver(derivedDocumentation, documentationFiles).resolve(
      derivedDocumentation,
    );
    const rawDocumentEdge = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.flatMap(rawDocumentation, file => file.edges),
        edge => edge.relation === 'documents' && edge.targetName === 'Target',
      ),
    );
    const derivedDocumentEdge = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.flatMap(resolvedDocumentation, file => file.edges),
        edge => edge.relation === 'documents' && edge.targetName === 'Target',
      ),
    );

    expect(rawDocumentEdge?.targetId).toBe(rawHeading?.id);
    expect(derivedDocumentEdge?.targetId).toBe(rawHeading?.id);
  });

  it('reuses immutable repository attribution across materialization batches', () => {
    const cachedFiles = [
      sourceFile('package.json', '{"name":"root-package"}\n'),
      sourceFile('packages/app/package.json', '{"name":"nested-package"}\n'),
      sourceFile('packages/app/src/deep/dependency.ts', 'export function dependency(): number { return 1; }\n'),
      sourceFile(
        'packages/app/src/deep/consumer.ts',
        'import {dependency} from "./dependency.js";\n' +
          'export function consumer(): number { return dependency(); }\n',
      ),
      sourceFile('packages/application/src/unrelated.ts', 'export const unrelated = true;\n'),
    ];
    const workspace = discoverManifestWorkspace(cachedFiles);
    const raw = extractRepositoryFileFacts(cachedFiles);
    const attributeFacts = createCachedCodeGraphFactsAttributor(cachedFiles, workspace);
    const streamed = EffectArray.flatMap(raw, file => attributeFacts([file]));
    const rebuiltPerBatch = EffectArray.flatMap(raw, file =>
      createCachedCodeGraphFactsAttributor(cachedFiles, workspace)([file]),
    );
    const repositoryOnly = createRepositoryFactAttributor(cachedFiles)(raw);

    expect(streamed).toEqual(rebuiltPerBatch);
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          EffectArray.flatMap(streamed, file => file.symbols),
          symbol => symbol.path === 'packages/app/src/deep/consumer.ts' && symbol.name === 'consumer',
        ),
      )?.packageName,
    ).toBe('nested-package');
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          EffectArray.flatMap(repositoryOnly, file => file.symbols),
          symbol => symbol.path === 'packages/application/src/unrelated.ts' && symbol.name === 'unrelated',
        ),
      )?.packageName,
    ).toBe('root-package');
  });

  it('replays repository attribution from bounded context plus exact path-membership probes', () => {
    FC.assert(
      FC.property(FC.integer({max: 100, min: 0}), packageIndex => {
        const root = `packages/package-${packageIndex}`;
        const contextFiles = [sourceFile(`${root}/package.json`, `{"name":"package-${packageIndex}"}\n`)];
        const dependency = sourceFile(
          `${root}/src/dependency.ts`,
          'export function dependency(): number { return 1; }\n',
        );
        const consumer = sourceFile(
          `${root}/src/consumer.ts`,
          'import {dependency} from "./dependency.js";\n' +
            'export function consumer(): number { return dependency(); }\n',
        );
        const repositoryFiles = [...contextFiles, dependency, consumer];
        const rawConsumer = extractRepositoryFileFacts([consumer]);
        const candidates = repositoryFactCandidatePaths(contextFiles, rawConsumer);
        const attribution = createRepositoryFactAttributionContext(contextFiles);
        const repositoryPaths = new Set(EffectArray.map(repositoryFiles, file => file.path));
        const existingCandidates = new Set(
          EffectArray.filter(
            candidates,
            (path, __effectArrayIndex) => __effectArrayIndex in candidates && repositoryPaths.has(path),
          ),
        );

        const expected = createRepositoryFactAttributor(repositoryFiles)(rawConsumer);
        expect(createRepositoryFactAttributorFromContext(contextFiles, existingCandidates)(rawConsumer)).toEqual(
          expected,
        );
        expect(attribution.attribute(existingCandidates)(rawConsumer)).toEqual(expected);
        expect(attribution.candidatePaths(rawConsumer)).toEqual(candidates);
        expect(attribution.candidatePaths(rawConsumer)).toEqual(attribution.candidatePaths(rawConsumer));
        expect(existingCandidates.has(dependency.path)).toBe(true);
        expect(candidates.length).toBeLessThanOrEqual(16);
      }),
      {numRuns: 100},
    );
  });

  it('reuses parsed manifest context across candidate discovery and exact attribution', () => {
    let manifestReads = 0;
    const manifest = sourceFile('packages/app/package.json', '{"name":"app"}\n');
    Object.defineProperty(manifest, 'content', {
      configurable: true,
      enumerable: true,
      get: () => {
        manifestReads += 1;
        return '{"name":"app"}\n';
      },
    });
    const dependency = sourceFile(
      'packages/app/src/dependency.ts',
      'export function dependency(): number { return 1; }\n',
    );
    const consumer = sourceFile(
      'packages/app/src/consumer.ts',
      'import {dependency} from "./dependency.js";\n' + 'export function consumer(): number { return dependency(); }\n',
    );
    const rawConsumer = extractRepositoryFileFacts([consumer]);
    const expected = createRepositoryFactAttributor([manifest, dependency, consumer])(rawConsumer);
    manifestReads = 0;
    const attribution = createRepositoryFactAttributionContext([manifest]);
    const parsedManifestReads = manifestReads;
    const candidates = attribution.candidatePaths(rawConsumer);
    const existing = new Set(EffectArray.filter(candidates, path => path === dependency.path));

    expect(attribution.attribute(existing)(rawConsumer)).toEqual(expected);
    expect(parsedManifestReads).toBe(2);
    expect(manifestReads).toBe(parsedManifestReads);
  });

  it('indexes documentation without promoting prose similarity to a source dependency', () => {
    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'heading',
          name: 'Fixture architecture',
          path: 'docs/architecture.md',
        }),
      ]),
    );
    expect(
      EffectArray.some(edges, edge => edge.provenance === 'model' || edge.relation === 'semantic_association'),
    ).toBe(false);
  });

  it('keeps explicit document and media links as resolvable graph evidence', () => {
    const linked = EffectArray.flatMap(
      extractRepositoryFacts([
        sourceFile(
          'docs/architecture.md',
          '# Retry design\n\nSee [the flow](../diagrams/retry-flow.png) and `docs/reliability.pdf`.\n',
        ),
      ]),
      file => file.edges,
    );

    expect(EffectArray.map(linked, edge => edge.targetName)).toEqual(
      expect.arrayContaining(['diagrams/retry-flow.png', 'docs/reliability.pdf']),
    );
    expect(
      EffectArray.every(
        EffectArray.filter(
          linked,
          edge =>
            Effect.pipe(edge.targetName, EffectString.endsWith('.png')) ||
            Effect.pipe(edge.targetName, EffectString.endsWith('.pdf')),
        ),
        edge => edge.relation === 'documents' && edge.provenance === 'syntactic',
      ),
    ).toBe(true);
  });

  it('proves imported targets through their module instead of globally unique names', () => {
    const resolved = extractRepositoryFacts([
      sourceFile('src/a.ts', 'export function collision(): string { return "a"; }\n'),
      sourceFile('src/b.ts', 'export function collision(): string { return "b"; }\n'),
      sourceFile(
        'src/use.ts',
        'import {collision} from "./b.js";\nexport function useCollision(): string { return collision(); }\n',
      ),
      sourceFile('src/unrelated.ts', 'export function phantom(): string { return "unrelated"; }\n'),
      sourceFile(
        'src/missing.ts',
        'import {phantom} from "./does-not-exist.js";\nexport function usePhantom(): string { return phantom(); }\n',
      ),
    ]);
    const resolvedSymbols = EffectArray.flatMap(resolved, file => file.symbols);
    const resolvedEdges = EffectArray.flatMap(resolved, file => file.edges);
    const collisionCall = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        resolvedEdges,
        edge => edge.sourceName === 'useCollision' && edge.relation === 'calls' && edge.targetName === 'collision',
      ),
    );
    const collisionTarget = EffectOption.getOrUndefined(
      EffectArray.findFirst(resolvedSymbols, symbol => symbol.id === collisionCall?.targetId),
    );
    const missingCall = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        resolvedEdges,
        edge => edge.sourceName === 'usePhantom' && edge.relation === 'calls' && edge.targetName === 'phantom',
      ),
    );

    expect(collisionCall).toMatchObject({provenance: 'resolved'});
    expect(collisionTarget?.path).toBe('src/b.ts');
    expect(missingCall).toMatchObject({provenance: 'syntactic'});
    expect(missingCall?.targetId).toBeUndefined();
  });

  it('resolves randomized TypeScript overload groups without collapsing their symbols', () => {
    FC.assert(
      FC.property(
        FC.uniqueArray(FC.integer({max: 4, min: 0}), {maxLength: 5, minLength: 2}),
        FC.integer({max: 100, min: 0}),
        (generatedArities, selectedIndex) => {
          const arities = [...generatedArities].sort((left, right) => left - right);
          const selectedArity = arities[selectedIndex % arities.length];
          const secondArity = arities[(selectedIndex + 1) % arities.length];
          const resolved = extractRepositoryFacts([
            sourceFile('src/overloads.ts', overloadFixture(arities)),
            sourceFile('src/use-overloads.ts', overloadUseFixture(selectedArity, secondArity)),
          ]);
          const symbols = EffectArray.flatMap(resolved, file => file.symbols);
          const edges = EffectArray.flatMap(resolved, file => file.edges);
          const parseSymbols = EffectArray.filter(
            symbols,
            symbol => symbol.path === 'src/overloads.ts' && symbol.name === 'parse',
          );
          const decodeSymbols = EffectArray.filter(
            symbols,
            symbol => symbol.path === 'src/overloads.ts' && symbol.name === 'decode',
          );
          const implementation = EffectOption.getOrUndefined(
            EffectArray.findFirst(
              parseSymbols,
              __effectArrayValue =>
                !!(symbol =>
                  Effect.pipe(symbol.signature, effectOptionalString =>
                    effectOptionalString == null
                      ? undefined
                      : Effect.pipe(effectOptionalString, EffectString.includes('...values')),
                  ))(__effectArrayValue),
            ),
          );
          const selectedDeclaration = EffectOption.getOrUndefined(
            EffectArray.findFirst(decodeSymbols, symbol => symbol.arity === selectedArity),
          );
          const secondDeclaration = EffectOption.getOrUndefined(
            EffectArray.findFirst(decodeSymbols, symbol => symbol.arity === secondArity),
          );
          const call = (sourceName: string, targetName: string) =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(
                edges,
                edge => edge.sourceName === sourceName && edge.relation === 'calls' && edge.targetName === targetName,
              ),
            );

          expect(new Set(EffectArray.map(parseSymbols, symbol => symbol.id)).size).toBe(arities.length + 1);
          expect(new Set(EffectArray.map(decodeSymbols, symbol => symbol.id)).size).toBe(arities.length);
          expect(implementation).toBeDefined();
          expect(selectedDeclaration).toBeDefined();
          expect(secondDeclaration).toBeDefined();
          expect(call('useLocal', 'parse')).toMatchObject({
            provenance: 'resolved',
            targetId: implementation?.id,
          });
          expect(call('useImported', 'parse')).toMatchObject({
            provenance: 'resolved',
            targetId: implementation?.id,
          });
          const declaredCalls = EffectArray.filter(
            edges,
            edge => edge.sourceName === 'useDeclared' && edge.relation === 'calls' && edge.targetName === 'decode',
          );
          expect(declaredCalls).toHaveLength(2);
          expect(new Set(EffectArray.map(declaredCalls, edge => edge.id)).size).toBe(2);
          expect(new Set(EffectArray.map(declaredCalls, edge => edge.targetId))).toEqual(
            new Set([selectedDeclaration?.id, secondDeclaration?.id]),
          );
        },
      ),
      {numRuns: 100},
    );
  });

  it('scopes repeated TypeScript path aliases to the importing package', () => {
    const scoped = extractRepositoryFacts([
      sourceFile(
        'packages/a/tsconfig.json',
        JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}}}),
      ),
      sourceFile(
        'packages/b/tsconfig.json',
        JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}}}),
      ),
      sourceFile('packages/a/src/shared.ts', 'export function shared(): string { return "a"; }\n'),
      sourceFile('packages/b/src/shared.ts', 'export function shared(): string { return "b"; }\n'),
      sourceFile(
        'packages/a/src/use.ts',
        'import {shared} from "@/shared";\nexport function useA(): string { return shared(); }\n',
      ),
      sourceFile(
        'packages/b/src/use.ts',
        'import {shared} from "@/shared";\nexport function useB(): string { return shared(); }\n',
      ),
    ]);
    const scopedSymbols = EffectArray.flatMap(scoped, file => file.symbols);
    const scopedEdges = EffectArray.flatMap(scoped, file => file.edges);
    const targetPath = (source: string) => {
      const call = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          scopedEdges,
          edge => edge.sourceName === source && edge.relation === 'calls' && edge.targetName === 'shared',
        ),
      );
      return EffectOption.getOrUndefined(EffectArray.findFirst(scopedSymbols, symbol => symbol.id === call?.targetId))
        ?.path;
    };

    expect(targetPath('useA')).toBe('packages/a/src/shared.ts');
    expect(targetPath('useB')).toBe('packages/b/src/shared.ts');
  });

  it('uses the deepest package and TypeScript scopes inside a nested monorepo', () => {
    const nested = extractRepositoryFacts([
      sourceFile(
        'package.json',
        JSON.stringify({name: '@fixture/root', workspaces: ['apps/*', 'apps/app/modules/*', 'libs/*']}),
      ),
      sourceFile(
        'tsconfig.json',
        JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@shared/*': ['libs/shared/*']}}}),
      ),
      sourceFile('libs/shared/package.json', JSON.stringify({exports: './value.ts', name: '@fixture/outer-shared'})),
      sourceFile('libs/shared/value.ts', 'export function sharedValue(): string { return "outer"; }\n'),
      sourceFile(
        'apps/sibling/src/use.ts',
        'import {sharedValue} from "@shared/value";\nexport function useOuter(): string { return sharedValue(); }\n',
      ),
      sourceFile(
        'apps/app/package.json',
        JSON.stringify({
          dependencies: {'@fixture/outer-shared': 'workspace:*'},
          name: '@fixture/nested-app',
          workspaces: ['modules/*'],
        }),
      ),
      sourceFile(
        'apps/app/tsconfig.json',
        JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@shared/*': ['modules/shared/*']}}}),
      ),
      sourceFile('apps/app/modules/shared/package.json', JSON.stringify({name: '@fixture/nested-shared'})),
      sourceFile('apps/app/modules/shared/value.ts', 'export function sharedValue(): string { return "nested"; }\n'),
      sourceFile(
        'apps/app/src/use.ts',
        EffectArray.join(
          [
            'import {sharedValue as nestedValue} from "@shared/value";',
            'import {sharedValue as outerValue} from "@fixture/outer-shared";',
            'export function useNested(): string { return nestedValue(); }',
            'export function useIntegrated(): string { return outerValue(); }',
          ],
          '\n',
        ),
      ),
    ]);
    const nestedSymbols = EffectArray.flatMap(nested, file => file.symbols);
    const nestedEdges = EffectArray.flatMap(nested, file => file.edges);
    const target = (sourceName: string) => {
      const edge = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          nestedEdges,
          candidate =>
            candidate.sourceName === sourceName &&
            candidate.relation === 'calls' &&
            candidate.targetName === 'sharedValue',
        ),
      );
      return EffectOption.getOrUndefined(EffectArray.findFirst(nestedSymbols, symbol => symbol.id === edge?.targetId));
    };

    expect(target('useOuter')).toMatchObject({
      packageName: '@fixture/outer-shared',
      path: 'libs/shared/value.ts',
    });
    expect(target('useNested')).toMatchObject({
      packageName: '@fixture/nested-shared',
      path: 'apps/app/modules/shared/value.ts',
    });
    expect(target('useIntegrated')).toMatchObject({
      packageName: '@fixture/outer-shared',
      path: 'libs/shared/value.ts',
    });
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          nestedEdges,
          edge =>
            edge.sourceName === '@fixture/nested-app' &&
            edge.relation === 'depends_on' &&
            edge.targetName === '@fixture/outer-shared',
        ),
      ),
    ).toMatchObject({provenance: 'declared'});
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(nestedSymbols, symbol => symbol.name === 'useNested'))
        ?.packageName,
    ).toBe('@fixture/nested-app');
  });

  it('selects each alias project scope once per importing source', () => {
    let scopeScans = 0;
    const projectFiles = Array.from({length: 20}, (_, index) => {
      const root = `packages/p${Effect.pipe(String(index), EffectString.padStart(2, '0'))}`;
      return [
        sourceFile(
          `${root}/tsconfig.json`,
          JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}}}),
        ),
        sourceFile(`${root}/src/shared.ts`, `export function shared${index}(): number { return ${index}; }\n`),
      ];
    }).flat();
    const calls = EffectArray.join(
      Array.from({length: 50}, () => 'shared0();'),
      '\n',
    );
    const files = [
      ...projectFiles,
      sourceFile(
        'packages/p00/src/use.ts',
        `import {shared0} from "@/shared";\nexport function useAliases(): void {\n${calls}\n}\n`,
      ),
    ];

    extractRepositoryFacts(files, {onAliasScopeScan: () => (scopeScans += 1)});

    expect(scopeScans).toBe(1);
  });

  it('does not resolve relative imports that escape above the repository root', () => {
    const escaped = extractRepositoryFacts([
      sourceFile('src/foo.ts', 'export function phantom(): string { return "inside"; }\n'),
      sourceFile(
        'src/deep/use.ts',
        'import {phantom} from "../../../src/foo";\nexport function usePhantom(): string { return phantom(); }\n',
      ),
    ]);
    const call = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.flatMap(escaped, file => file.edges),
        edge => edge.sourceName === 'usePhantom' && edge.relation === 'calls',
      ),
    );

    expect(call).toMatchObject({provenance: 'syntactic'});
    expect(call?.targetId).toBeUndefined();
  });

  it('fails closed for ambiguous package export conditions', () => {
    const ambiguous = extractRepositoryFacts([
      sourceFile(
        'packages/library/package.json',
        JSON.stringify({
          exports: {'.': {import: './src/import.ts', require: './src/require.ts'}},
          name: '@fixture/library',
        }),
      ),
      sourceFile('packages/library/src/import.ts', 'export function value(): string { return "import"; }\n'),
      sourceFile('packages/library/src/require.ts', 'export function value(): string { return "require"; }\n'),
      sourceFile(
        'src/use.ts',
        'import {value} from "@fixture/library";\nexport function useValue(): string { return value(); }\n',
      ),
    ]);
    const call = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.flatMap(ambiguous, file => file.edges),
        edge => edge.sourceName === 'useValue' && edge.relation === 'calls',
      ),
    );

    expect(call).toMatchObject({provenance: 'syntactic'});
    expect(call?.targetId).toBeUndefined();
  });

  it('leaves duplicate workspace package names unresolved', () => {
    const duplicate = extractRepositoryFacts([
      sourceFile('packages/a/package.json', JSON.stringify({exports: './src/index.ts', name: '@fixture/duplicate'})),
      sourceFile('packages/b/package.json', JSON.stringify({exports: './src/index.ts', name: '@fixture/duplicate'})),
      sourceFile('packages/a/src/index.ts', 'export function duplicateValue(): string { return "a"; }\n'),
      sourceFile('packages/b/src/index.ts', 'export function duplicateValue(): string { return "b"; }\n'),
      sourceFile(
        'package.json',
        JSON.stringify({dependencies: {'@fixture/duplicate': 'workspace:*'}, name: '@fixture/root'}),
      ),
      sourceFile(
        'src/use.ts',
        'import {duplicateValue} from "@fixture/duplicate";\nexport function useDuplicate(): string { return duplicateValue(); }\n',
      ),
    ]);
    const edges = EffectArray.flatMap(duplicate, file => file.edges);

    const dependency = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        edges,
        edge => edge.sourceName === '@fixture/root' && edge.targetName === '@fixture/duplicate',
      ),
    );
    expect(dependency).toMatchObject({provenance: 'declared'});
    expect(dependency?.targetId).toBeUndefined();
    const call = EffectOption.getOrUndefined(
      EffectArray.findFirst(edges, edge => edge.sourceName === 'useDuplicate' && edge.targetName === 'duplicateValue'),
    );
    expect(call).toMatchObject({provenance: 'syntactic'});
    expect(call?.targetId).toBeUndefined();
    expect(
      EffectArray.filter(
        EffectArray.flatMap(duplicate, file => file.diagnostics),
        value => Effect.pipe(value, EffectString.includes('duplicate workspace')),
      ),
    ).toHaveLength(2);
  });

  it('applies TypeScript aliases only to files included by that project', () => {
    const scoped = extractRepositoryFacts([
      sourceFile(
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}},
          exclude: ['src/generated/**'],
          include: ['src/**/*.ts'],
        }),
      ),
      sourceFile('src/shared.ts', 'export function shared(): string { return "shared"; }\n'),
      sourceFile(
        'src/use.ts',
        'import {shared} from "@/shared";\nexport function includedUse(): string { return shared(); }\n',
      ),
      sourceFile(
        'tests/use.ts',
        'import {shared} from "@/shared";\nexport function excludedUse(): string { return shared(); }\n',
      ),
      sourceFile(
        'src/generated/use.ts',
        'import {shared} from "@/shared";\nexport function generatedUse(): string { return shared(); }\n',
      ),
    ]);
    const edges = EffectArray.flatMap(scoped, file => file.edges);
    const call = (name: string) =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          edges,
          edge => edge.sourceName === name && edge.relation === 'calls' && edge.targetName === 'shared',
        ),
      );

    expect(call('includedUse')).toMatchObject({provenance: 'resolved'});
    expect(call('excludedUse')).toMatchObject({provenance: 'syntactic'});
    expect(call('generatedUse')).toMatchObject({provenance: 'syntactic'});
  });

  it('fails closed for empty projects, undeclared package entries, and cross-class this members', () => {
    const scoped = extractRepositoryFacts([
      sourceFile(
        'tsconfig.json',
        JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}}, files: []}),
      ),
      sourceFile('src/shared.ts', 'export function shared(): string { return "shared"; }\n'),
      sourceFile(
        'src/use.ts',
        'import {shared} from "@/shared";\nexport function useShared(): string { return shared(); }\n',
      ),
      sourceFile('packages/library/package.json', JSON.stringify({name: '@fixture/library'})),
      sourceFile('packages/library/src/index.ts', 'export function value(): string { return "value"; }\n'),
      sourceFile(
        'src/package-use.ts',
        'import {value} from "@fixture/library";\nexport function useValue(): string { return value(); }\n',
      ),
      sourceFile(
        'src/classes.ts',
        EffectArray.join(
          ['export class First { invoke(): void { this.missing(); } }', 'export class Second { missing(): void {} }'],
          '\n',
        ),
      ),
    ]);
    const edges = EffectArray.flatMap(scoped, file => file.edges);
    const call = (source: string, target: string) =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          edges,
          edge => edge.sourceName === source && edge.relation === 'calls' && edge.targetName === target,
        ),
      );

    expect(call('useShared', 'shared')).toMatchObject({provenance: 'syntactic'});
    expect(call('useValue', 'value')).toMatchObject({provenance: 'syntactic'});
    expect(call('invoke', 'this.missing')).toMatchObject({provenance: 'syntactic'});
    expect(call('invoke', 'this.missing')?.targetId).toBeUndefined();
  });

  it('keeps shadowed parameters, locals, and nested declarations syntactic', () => {
    const scoped = extractRepositoryFacts([
      sourceFile('src/helper.ts', 'export function helper(): string { return "module"; }\n'),
      sourceFile(
        'src/use.ts',
        EffectArray.join(
          [
            'import {helper} from "./helper.js";',
            'export function parameterUse(helper: () => string): string { return helper(); }',
            'export function localUse(): string {',
            '  const helper = (): string => "local";',
            '  return helper();',
            '}',
            'export function nestedUse(): string {',
            '  function nested(): string { return "nested"; }',
            '  return nested();',
            '}',
            'export function importedUse(): string { return helper(); }',
          ],
          '\n',
        ),
      ),
    ]);
    const calls = EffectArray.filter(
      EffectArray.flatMap(scoped, file => file.edges),
      edge => edge.relation === 'calls',
    );
    const call = (source: string, target: string) =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(calls, edge => edge.sourceName === source && edge.targetName === target),
      );

    expect(call('parameterUse', 'helper')).toMatchObject({provenance: 'syntactic'});
    expect(call('parameterUse', 'helper')?.targetId).toBeUndefined();
    expect(call('localUse', 'helper')).toMatchObject({provenance: 'syntactic'});
    expect(call('localUse', 'helper')?.targetId).toBeUndefined();
    expect(call('nestedUse', 'nested')).toMatchObject({provenance: 'syntactic'});
    expect(call('nestedUse', 'nested')?.targetId).toBeUndefined();
    expect(call('importedUse', 'helper')).toMatchObject({provenance: 'resolved'});
  });

  it('keeps named function and class expression self-references syntactic', () => {
    const scoped = extractRepositoryFacts([
      sourceFile('src/helper.ts', 'export function helper(): string { return "module"; }\n'),
      sourceFile(
        'src/use.ts',
        EffectArray.join(
          [
            'import {helper} from "./helper.js";',
            'export const namedFunction = function helper(): unknown { return helper(); };',
            'export const namedClass = class helper { method(): unknown { return helper(); } };',
          ],
          '\n',
        ),
      ),
    ]);
    const selfReferences = EffectArray.filter(
      EffectArray.flatMap(scoped, file => file.edges),
      edge => edge.evidencePath === 'src/use.ts' && edge.relation === 'calls' && edge.targetName === 'helper',
    );

    expect(selfReferences).toHaveLength(2);
    expect(
      EffectArray.every(selfReferences, edge => edge.provenance === 'syntactic' && edge.targetId === undefined),
    ).toBe(true);
  });
});

function fixtureFiles(root: string): readonly CodeGraphInventoryFile[] {
  const paths: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const target = join(directory, name);
      if (statSync(target).isDirectory()) visit(target);
      else paths.push(target);
    }
  };
  visit(root);
  return EffectArray.map(paths.sort(), path => {
    const content = readFileSync(path, 'utf8');
    const repositoryPath = Effect.pipe(relative(root, path), EffectString.replaceAll('\\', '/'));
    return {
      blobId: `fixture:${sha256HexSync(content)}`,
      content,
      contentHash: sha256HexSync(content),
      language: language(repositoryPath),
      mode: '100644',
      path: repositoryPath,
      size: new TextEncoder().encode(content).byteLength,
      source: 'commit',
    };
  });
}

function language(path: string): string {
  if (/\.tsx?$/.test(path)) return 'typescript';
  if (/\.md$/.test(path)) return 'markdown';
  if (Effect.pipe(path, EffectString.endsWith('package.json'))) return 'npm-manifest';
  return 'text';
}

function sourceFile(path: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: `fixture:${sha256HexSync(content)}`,
    content,
    contentHash: sha256HexSync(content),
    language: language(path),
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}

function overloadFixture(arities: readonly number[]): string {
  const declarations = (name: string, prefix: string) =>
    EffectArray.map(arities, arity => {
      const parameters = EffectArray.join(
        Array.from({length: arity}, (_, index) => `value${index}: number`),
        ', ',
      );
      return `${prefix} function ${name}(${parameters}): string;`;
    });
  return EffectArray.join(
    [
      ...declarations('parse', 'export'),
      'export function parse(...values: readonly number[]): string { return values.join(","); }',
      ...declarations('decode', 'export declare'),
      'export function useLocal(): string { return parse(1); }',
      '',
    ],
    '\n',
  );
}

function overloadUseFixture(firstArity: number, secondArity: number): string {
  const argumentsList = (arity: number) =>
    EffectArray.join(
      Array.from({length: arity}, (_, index) => String(index)),
      ', ',
    );
  return EffectArray.join(
    [
      'import {decode, parse} from "./overloads.js";',
      'export function useImported(): string { return parse(1); }',
      `export function useDeclared(): string { return decode(${argumentsList(firstArity)}) + decode(${argumentsList(secondArity)}); }`,
      '',
    ],
    '\n',
  );
}
