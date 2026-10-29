import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {makeCodeGraphWorksetCatalogCandidateSource} from '@threadnote/graph/workset_catalog/candidate_source';
import {createCodeGraphWorksetRoutingProjection} from '@threadnote/graph/workset_catalog/projection';
import {
  publishCodeGraphWorksetCatalogGeneration,
  stageCodeGraphWorksetCatalogGeneration,
} from '@threadnote/graph/workset_catalog/store';
import {
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  type CodeGraphWorksetCatalogGenerationMemberV1,
  type CodeGraphWorksetRoutingSymbolV1,
} from '@threadnote/graph/workset_catalog/types';
import {
  normalizeCodeGraphWorksetRouterQuery,
  rankCodeGraphWorksetRouterCandidates,
  type CodeGraphWorksetCatalogCandidateRequestV1,
  type CodeGraphWorksetCatalogCandidateSourceV1,
} from '@threadnote/graph/workset/router';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('code graph workset catalog candidate source', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  it('uses normalized indexed exact keys for every routing surface with complete coverage', async () => {
    const source = await publishedSource(homes, [
      member(1, 'orders', [
        symbol(1, {
          lookupKeys: ['Route:OrderGateway'],
          name: 'OrderGateway',
          packageName: '@App/Orders',
          path: 'src/Orders/OrderGateway.ts',
          qualifiedName: 'Shop.Orders.OrderGateway',
        }),
        symbol(2, {
          name: 'ＦｕｌｌＷｉｄｔｈ',
          path: 'src/Unicode/FullWidth.ts',
          qualifiedName: 'Unicode.ＦｕｌｌＷｉｄｔｈ',
        }),
      ]),
      member(2, 'payments', [symbol(3, {name: 'PaymentGateway'})]),
    ]);
    const generation = await runEffect(source.readGeneration('engineering'));
    expect(generation).toBeDefined();

    for (const [query, nodeSeed] of [
      ['ordergateway', 1],
      ['route:ordergateway', 1],
      ['shop.orders.ordergateway', 1],
      ['@app/orders', 1],
      ['src/orders/ordergateway.ts', 1],
      ['orders/ordergateway.ts', 1],
      ['FullWidth', 2],
    ] as const) {
      const page = await runEffect(
        source.readExactCandidates(request(generation!.id, query, {limit: 8, maximumHitsPerMember: 4})),
      );
      expect(page.coverage).toEqual({consideredMemberCount: 2, eligibleMemberCount: 2, state: 'complete'});
      expect(EffectArray.map(page.hits, hit => hit.symbol.nodeId)).toContain(nodeId(nodeSeed));
    }
  });

  it('reuses index-time lexical tokens and applies per-member fairness before the global limit', async () => {
    const lexicalTerms = ['http', 'parser', 'parser.ts', 'pkg.name', 'scope', 'snake_case', 'src', 'url'];
    const source = await publishedSource(homes, [
      member(
        1,
        'many',
        Array.from({length: 5}, (_, index) =>
          symbol(10 + index, {
            name: `Many${String(index)}`,
            terms: EffectArray.map(lexicalTerms, term => ({term, weight: 10 - index})),
          }),
        ),
      ),
      member(
        2,
        'few',
        Array.from({length: 2}, (_, index) =>
          symbol(20 + index, {
            name: `Few${String(index)}`,
            terms: EffectArray.map(lexicalTerms, term => ({term, weight: 4 - index})),
          }),
        ),
      ),
    ]);
    const generation = (await runEffect(source.readGeneration('engineering')))!;
    const query = 'URLParser snake_case @scope/pkg.name src/http/URLParser.ts';
    expect(normalizeCodeGraphWorksetRouterQuery(query).terms).toEqual(lexicalTerms);
    const page = await runEffect(
      source.readLexicalCandidates(request(generation.id, query, {limit: 4, maximumHitsPerMember: 2})),
    );

    expect(page.hits).toHaveLength(4);
    expect(countBy(EffectArray.map(page.hits, hit => hit.symbol.repositoryKey))).toEqual(
      new Map([
        ['few', 2],
        ['many', 2],
      ]),
    );
    const ranked = rankCodeGraphWorksetRouterCandidates({
      exactHits: [],
      lexicalHits: page.hits,
      query: normalizeCodeGraphWorksetRouterQuery(query),
    });
    expect(
      EffectArray.every(ranked.symbols, entry =>
        EffectArray.some(entry.scoreReceipt.signals, signal => signal.feature === 'lexical-coverage'),
      ),
    ).toBe(true);
    expect(EffectArray.every(ranked.symbols, entry => entry.score > 0)).toBe(true);
  });

  it('keeps lane ranks and results invariant across keyset page sizes', async () => {
    const source = await publishedSource(
      homes,
      Array.from({length: 3}, (_, repository) =>
        member(
          repository + 1,
          `repository-${String(repository)}`,
          Array.from({length: 5}, (_, index) =>
            symbol(100 + repository * 10 + index, {
              name: `Service${String(repository)}${String(index)}`,
              terms: [{term: 'service', weight: 10 - index}],
            }),
          ),
        ),
      ),
    );
    const generation = (await runEffect(source.readGeneration('engineering')))!;
    const expected = await collectLane(source, request(generation.id, 'service', {limit: 6, maximumHitsPerMember: 2}));

    await fc.assert(
      fc.asyncProperty(fc.integer({min: 2, max: 5}), async limit => {
        const actual = await collectLane(source, request(generation.id, 'service', {limit, maximumHitsPerMember: 2}));
        expect(actual).toEqual(expected);
        expect(EffectArray.map(actual, hit => hit.catalogRank)).toEqual(
          Array.from({length: actual.length}, (_, index) => index + 1),
        );
        expect(
          Math.max(...countBy(EffectArray.map(actual, hit => hit.symbol.repositoryKey)).values()),
        ).toBeLessThanOrEqual(2);
      }),
      {numRuns: 40},
    );
  });

  it('reports complete zero-member coverage without scanning or inventing candidates', async () => {
    const source = await publishedSource(homes, []);
    const generation = (await runEffect(source.readGeneration('engineering')))!;
    const page = await runEffect(
      source.readExactCandidates(request(generation.id, 'anything', {limit: 4, maximumHitsPerMember: 2})),
    );

    expect(page).toEqual({
      coverage: {consideredMemberCount: 0, eligibleMemberCount: 0, state: 'complete'},
      generationId: generation.id,
      hits: [],
      lane: 'exact',
    });
  });
});

async function publishedSource(
  homes: string[],
  members: readonly CodeGraphWorksetCatalogGenerationMemberV1[],
): Promise<CodeGraphWorksetCatalogCandidateSourceV1> {
  const home = await mkdtemp('threadnote-candidate-source-');
  homes.push(home);
  const staged = await runEffect(
    stageCodeGraphWorksetCatalogGeneration(home, {
      manifestDigest: digest('manifest'),
      members,
      worksetName: 'engineering',
    }),
  );
  await runEffect(
    publishCodeGraphWorksetCatalogGeneration(home, {
      generationId: staged.id,
      worksetName: 'engineering',
    }),
  );
  return runEffect(makeCodeGraphWorksetCatalogCandidateSource(home));
}

function member(
  seed: number,
  repositoryKey: string,
  symbols: readonly CodeGraphWorksetRoutingSymbolV1[],
): CodeGraphWorksetCatalogGenerationMemberV1 {
  return {
    projection: createCodeGraphWorksetRoutingProjection({
      checkoutId: digest(`checkout-${String(seed)}`),
      commitId: Effect.pipe(digest(`commit-${String(seed)}`), EffectString.slice(0, 40)),
      componentCount: 1,
      extractorGeneration: 1,
      projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
      repositoryId: digest(`repository-${String(seed)}`),
      snapshotDigest: digest(`snapshot-digest-${String(seed)}`),
      snapshotId: `cgsn_${Effect.pipe(digest(`snapshot-${String(seed)}`), EffectString.slice(0, 40))}`,
      symbols,
      worktreeId: digest(`worktree-${String(seed)}`),
    }),
    repositoryKey,
  };
}

function symbol(
  seed: number,
  overrides: Partial<CodeGraphWorksetRoutingSymbolV1> = {},
): CodeGraphWorksetRoutingSymbolV1 {
  return {
    exported: seed % 2 === 0,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`lookup:${String(seed)}`],
    name: `Symbol${String(seed)}`,
    nodeId: nodeId(seed),
    packageName: '@fixture/catalog',
    path: `src/symbol-${String(seed)}.ts`,
    qualifiedName: `fixture.Symbol${String(seed)}`,
    span: {column: 0, endColumn: 10, endLine: 1, line: 1},
    terms: [{term: 'fixture', weight: 1}],
    ...overrides,
  };
}

function request(
  generationId: string,
  queryText: string,
  limits: {readonly limit: number; readonly maximumHitsPerMember: number},
): CodeGraphWorksetCatalogCandidateRequestV1 {
  return {
    generationId,
    ...limits,
    query: normalizeCodeGraphWorksetRouterQuery(queryText),
    worksetName: 'engineering',
  };
}

async function collectLane(
  source: CodeGraphWorksetCatalogCandidateSourceV1,
  initial: CodeGraphWorksetCatalogCandidateRequestV1,
) {
  const hits = [];
  let after: string | undefined;
  for (;;) {
    const page = await runEffect(source.readLexicalCandidates({...initial, ...(after === undefined ? {} : {after})}));
    hits.push(...page.hits);
    if (page.next === undefined) return hits;
    after = page.next;
  }
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return new Map([...counts].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

function nodeId(seed: number): string {
  return `cgs_${Effect.pipe(digest(`node-${String(seed)}`), EffectString.slice(0, 32))}`;
}

function digest(value: string): string {
  return sha256HexSync(value);
}
