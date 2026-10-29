import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Option, Path} from 'effect';
import {beforeEach, expect, vi} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {provideTestLayer} from '../helpers/effect-layer.js';

const {semantic} = vi.hoisted(() => ({semantic: vi.fn()}));
vi.mock('@threadnote/recall/runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/recall/runtime')>()),
  loadMcpRecallSemanticScoresResult: semantic,
}));
import {searchManagerLibrary} from '../../src/manager/library_search.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

beforeEach(() => semantic.mockReset());

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
