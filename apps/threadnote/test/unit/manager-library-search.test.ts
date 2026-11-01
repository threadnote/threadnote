import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Option, Path} from 'effect';
import {beforeEach, expect, vi} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';
import {provideTestLayer} from '../helpers/effect-layer.js';

const {semantic, sections, readBatches} = vi.hoisted(() => ({
  semantic: vi.fn(),
  sections: vi.fn(),
  readBatches: [] as string[][],
}));
vi.mock('@threadnote/recall/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('@threadnote/recall/runtime')>();
  return {
    ...original,
    loadMcpRecallSemanticScoresResult: semantic,
    prepareRecallSections: (...args: Parameters<typeof original.prepareRecallSections>) =>
      sections.getMockImplementation() ? sections(...args) : original.prepareRecallSections(...args),
  };
});
vi.mock('../../src/memory/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/memory/index.js')>();
  return {
    ...original,
    readMemoryRecordsByUri: (...args: Parameters<typeof original.readMemoryRecordsByUri>) => {
      readBatches.push([...args[1]]);
      return original.readMemoryRecordsByUri(...args);
    },
  };
});
import {searchManagerLibrary} from '../../src/manager/library_search.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

beforeEach(() => {
  semantic.mockReset();
  sections.mockReset();
  readBatches.length = 0;
});

effectIt.effect(
  'finds semantic and body matches through the real recall ranker while isolating Local and each Team',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-library-search-'});
      const config = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: path.join(home, 'manifest.yaml'),
        user: 'test',
      };
      const base = 'threadnote://user/test/memories';
      const documents = [
        ['durable/projects/demo/opaque.md', 'Deployment decisions are recorded here.'],
        ['durable/projects/demo/body.md', 'The canary rollout uses progressive delivery.'],
        ['shared/alpha/durable/projects/demo/opaque.md', 'Alpha deployment decisions.'],
        ['shared/beta/durable/projects/demo/opaque.md', 'Beta deployment decisions.'],
      ];
      for (const [relative, body] of documents) {
        const file = path.join(home, 'data/local/user/test/memories', relative);
        yield* fs.makeDirectory(path.dirname(file), {recursive: true});
        yield* fs.writeFileString(
          file,
          `MEMORY\nkind: durable\nstatus: active\nproject: demo\ntopic: Opaque note\nsource_agent_client: user\ntimestamp: 2026-10-26T00:00:00.000Z\n\n${body}`,
        );
      }
      const index = yield* loadRecallIndexData(config, {includeInactive: false, forceRefresh: true});
      semantic.mockImplementation(() =>
        Effect.succeed({
          status: 'available',
          result: {
            corpusGeneration: Option.fromNullishOr(index.generation),
            scores: Option.some(new Map(EffectArray.map(documents, ([relative]) => [`${base}/${relative}`, 0.99]))),
            warning: Option.none(),
          },
        }),
      );
      const search = (query: string, scope: string) =>
        searchManagerLibrary(
          config,
          new URL(
            `http://manager/api/library/search?query=${encodeURIComponent(query)}&scope=${encodeURIComponent(scope)}`,
          ),
        );
      const local = yield* search('shipping software safely', 'local');
      expect(local.semantic).toBe('available');
      expect(local.uris).toContain(`${base}/${documents[0][0]}`);
      expect(EffectArray.every(local.uris, uri => !Effect2.pipe(uri, EffectString.includes('/shared/')))).toBe(true);
      expect(semantic.mock.calls[0][4]).toEqual([base]);
      const team = yield* search('shipping software safely', 'team:alpha');
      expect(team.uris).toEqual([`${base}/${documents[2][0]}`]);
      expect(semantic.mock.calls[1][4]).toEqual([`${base}/shared/alpha`]);
      semantic.mockImplementation(() =>
        Effect.succeed({
          status: 'unavailable',
          result: {corpusGeneration: Option.none(), scores: Option.none(), warning: Option.none()},
        }),
      );
      const lexical = yield* search('canary rollout', 'local');
      expect(lexical.semantic).toBe('unavailable');
      expect(lexical.uris).toContain(`${base}/${documents[1][0]}`);
    }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect('rejects empty, oversized and invalid-scope requests before using inference', () =>
  Effect.gen(function* () {
    const config = {
      account: 'local',
      agentContextHome: '/unused',
      agentId: 'threadnote',
      manifestPath: '/unused/manifest.yaml',
      user: 'test',
    };
    for (const params of [
      'query=',
      `query=${Effect2.pipe('x', EffectString.repeat(1025))}`,
      'query=hello&scope=invalid',
      'query=hello&scope=team:',
    ]) {
      const result = yield* searchManagerLibrary(config, new URL(`http://manager/api/library/search?${params}`)).pipe(
        Effect.result,
      );
      expect(result._tag).toBe('Failure');
    }
    expect(semantic).not.toHaveBeenCalled();
  }).pipe(provideTestLayer(ApplicationLayer)),
);

const query = 'literal-rescue-marker';
const fixture = (literalCount: number, team: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-library-literal-'});
    const base = 'threadnote://user/test/memories';
    const relativePrefix = team ? 'shared/alpha/' : '';
    const literals = Array.from({length: literalCount}, (_, i) => `${base}/${relativePrefix}durable/literal-${i}.md`);
    const stale = `${base}/${relativePrefix}durable/stale.md`;
    const foreign = `${base}/shared/beta/durable/foreign.md`;
    const bodies = new Map([
      ...EffectArray.map(literals, uri => [uri, `Body with ${query}.`] as const),
      [stale, 'The canonical body does not contain the indexed marker.'],
      [foreign, query],
    ]);
    const originals = new Map<string, string>();
    for (const [uri, body] of bodies) {
      const file = path.join(
        home,
        'data/local/user/test/memories',
        Effect2.pipe(uri, EffectString.slice(base.length + 1)),
      );
      yield* fs.makeDirectory(path.dirname(file), {recursive: true});
      const canonical = `MEMORY\nkind: durable\nstatus: active\nproject: demo\ntopic: Literal fixture\nsource_agent_client: user\ntimestamp: 2026-11-01T00:00:00.000Z\n\n${body}`;
      originals.set(file, canonical);
      yield* fs.writeFileString(file, canonical);
    }
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: path.join(home, 'manifest.yaml'),
      user: 'test',
    };
    return {
      fs,
      path,
      home,
      base,
      prefix: team ? `${base}/shared/alpha` : base,
      literals,
      stale,
      foreign,
      originals,
      config,
      scope: team ? 'team:alpha' : 'local',
    };
  });

const mockSections = (ranked: string[], expansion: string[]) => {
  const result = {
    ranked: EffectArray.map(ranked, uri => ({uri})),
    expansionCandidates: EffectArray.map(expansion, uri => ({uri, text: query})),
    semanticResult: {scores: Option.none(), warning: Option.none()},
    operationalWarnings: [],
  };
  sections.mockImplementation(() => Effect.succeed(result));
  semantic.mockImplementation(() =>
    Effect.succeed({
      status: 'unavailable',
      result: {corpusGeneration: Option.none(), scores: Option.none(), warning: Option.none()},
    }),
  );
  return result;
};

effectIt.effect('keeps a verified literal body match when 100 ranked hits already fill the response', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1, false);
    const ranked = Array.from({length: 120}, (_, i) => `${f.base}/durable/ranked-${i}.md`);
    mockSections(ranked, f.literals);
    const result = yield* searchManagerLibrary(
      f.config,
      new URL(`http://manager/api/library/search?query=${query}&scope=local`),
    );
    expect(result.uris).toHaveLength(100);
    expect(result.uris[0]).toBe(f.literals[0]);
    expect(result.uris.slice(1)).toEqual(ranked.slice(0, 99));
    expect(readBatches).toEqual([f.literals]);
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect('verifies at most 100 literal candidates and deduplicates the result', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1, false);
    mockSections(
      [],
      Array.from({length: 130}, () => f.literals[0]),
    );
    const result = yield* searchManagerLibrary(
      f.config,
      new URL(`http://manager/api/library/search?query=${query}&scope=local`),
    );
    expect(result.uris).toEqual(f.literals);
    expect(readBatches).toHaveLength(1);
    expect(readBatches[0]).toHaveLength(100);
  }).pipe(provideTestLayer(ApplicationLayer)),
);

fcEffectProp(
  effectIt,
  'preserves literal priority, scope, uniqueness, cap, ranked order and inputs',
  {
    noiseCount: fc.integer({min: 0, max: 160}),
    literalCount: fc.integer({min: 0, max: 5}),
    team: fc.boolean(),
    overlap: fc.boolean(),
  },
  ({noiseCount, literalCount, team, overlap}) =>
    Effect.gen(function* () {
      const f = yield* fixture(literalCount, team);
      const noise = Array.from({length: noiseCount}, (_, i) => `${f.prefix}/durable/ranked-${i}.md`);
      const ranked = [
        f.foreign,
        ...EffectArray.flatMap(noise, uri => [uri + '#section', uri]),
        ...(overlap ? EffectArray.map(f.literals, uri => uri + '#overlap') : []),
      ];
      const expansion = [...f.literals, f.stale, f.foreign, ...f.literals];
      const rankedBefore = [...ranked];
      const expansionBefore = [...expansion];
      const sectionResult = mockSections(ranked, expansion);
      const sectionSnapshot = JSON.stringify(sectionResult);
      const readStart = readBatches.length;
      const result = yield* searchManagerLibrary(
        f.config,
        new URL(`http://manager/api/library/search?query=${query}&scope=${encodeURIComponent(f.scope)}`),
      );
      expect(result.uris.length).toBeLessThanOrEqual(100);
      expect(new Set(result.uris).size).toBe(result.uris.length);
      expect(result.uris.slice(0, literalCount)).toEqual(f.literals);
      expect(EffectArray.filter(result.uris, uri => !EffectArray.contains(f.literals, uri))).toEqual(
        noise.slice(0, 100 - literalCount),
      );
      expect(result.uris).not.toContain(f.stale);
      expect(result.uris).not.toContain(f.foreign);
      expect(
        EffectArray.every(
          result.uris,
          uri =>
            Effect2.pipe(uri, EffectString.startsWith(f.prefix + '/')) &&
            (team || !Effect2.pipe(uri, EffectString.includes('/shared/'))),
        ),
      ).toBe(true);
      expect(readBatches.slice(readStart)).toEqual([expansion]);
      expect(readBatches[readStart].length).toBeLessThanOrEqual(100);
      expect(ranked).toEqual(rankedBefore);
      expect(expansion).toEqual(expansionBefore);
      expect(JSON.stringify(sectionResult)).toBe(sectionSnapshot);
      for (const [file, canonical] of f.originals) {
        expect(yield* f.fs.readFileString(file)).toBe(canonical);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  {fastCheck: {numRuns: 24, seed: 971}},
);
