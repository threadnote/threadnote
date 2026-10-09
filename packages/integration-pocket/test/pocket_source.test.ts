import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Redacted, Result} from 'effect';
import {TestClock, TestConsole} from 'effect/testing';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {readExternalDocumentManifest} from '@threadnote/store/external-resource';
import {loadRecallIndexData} from '@threadnote/recall/index';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {makeSourceConfigurationRegistry, sourceConfigurationStoreLayer} from '@threadnote/integration-runtime/config';
import {externalSourcePolicyLayer} from '@threadnote/integration-runtime/access-policy';
import {pocketSourceCodec} from '../src/config.js';
import {pocketExternalSourcePolicy} from '../src/access-policy.js';
import {
  runPocketSourceAdd,
  runPocketSourceSync,
  runPocketSourceInventory,
  runPocketSourceStatus,
  runPocketSourceRemove,
  syncPocketSourcesBeforeRecall,
  type PocketSyncResult,
} from '../src/source.js';
import {renderPocketRecord} from '../src/render.js';
import {createPocketClient, PocketClientError} from '../src/client.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readPocketSyncState} from '../src/state.js';

const baseServices = Layer.mergeAll(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'pocket-source.test.ts'}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: environment => ({...environment}),
          sanitizeExternal: environment => ({...environment}),
        }),
      ),
    ),
  ),
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const dependencies = Layer.merge(
  baseServices,
  sourceConfigurationStoreLayer(makeSourceConfigurationRegistry({sources: [pocketSourceCodec], projections: []})).pipe(
    Layer.provide(baseServices),
  ),
);
const access = Layer.merge(
  dependencies,
  externalSourcePolicyLayer([pocketExternalSourcePolicy]).pipe(Layer.provide(dependencies)),
);
const layer = Layer.merge(access, ResourceStore.layer.pipe(Layer.provide(access)));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const provideWithConsole = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Layer.build(Layer.merge(layer, TestConsole.layer)).pipe(
      Effect.flatMap(context => effect.pipe(Effect.provide(context))),
    ),
  );
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

let previousReflectionEnv: string | undefined;
beforeAll(() => {
  previousReflectionEnv = process.env.POCKET_TEST_REFLECTION;
  process.env.POCKET_TEST_REFLECTION = 'pk_envsecret';
});
afterAll(() => {
  if (previousReflectionEnv === undefined) delete process.env.POCKET_TEST_REFLECTION;
  else process.env.POCKET_TEST_REFLECTION = previousReflectionEnv;
});

describe('Pocket source', () => {
  effectIt.effect('prints inventory and status through the provider source functions', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'pocket-source-inventory-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runPocketSourceAdd(config, {
        id: 'local',
        projectless: true,
        apply: true,
        apiToken: Redacted.make('pk_synthetic_inventory'),
      });
      yield* runPocketSourceInventory(config, 'local');
      yield* runPocketSourceStatus(config, 'local');
      expect(yield* TestConsole.logLines).toEqual(expect.arrayContaining(['Pocket source "local": 0 cached item(s).']));
    }).pipe(TestClock.withLive, provideWithConsole),
  );

  effectIt.effect('rejects normalized source fields reflecting environment, retained, or rotated keys', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'pocket-reflection-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      for (const apply of [false, true]) {
        const attempt = yield* runPocketSourceAdd(config, {
          id: 'env',
          project: 'pk_envsecret',
          credentialEnv: 'POCKET_TEST_REFLECTION',
          apply,
        }).pipe(Effect.result);
        expect(Result.isFailure(attempt)).toBe(true);
      }
      expect(yield* fs.exists(`${home}/threadnote/sources.yaml`)).toBe(false);
      yield* runPocketSourceAdd(config, {
        id: 'local',
        project: 'safe',
        apply: true,
        apiToken: Redacted.make('pk_previouskey'),
      });
      const retained = yield* runPocketSourceAdd(config, {
        id: 'local',
        project: 'pk_previouskey',
        apply: true,
      }).pipe(Effect.result);
      expect(Result.isFailure(retained)).toBe(true);
      const rotation = yield* runPocketSourceAdd(config, {
        id: 'local',
        project: 'pk_previouskey',
        apply: true,
        apiToken: Redacted.make('pk_newkey'),
      }).pipe(Effect.result);
      expect(Result.isFailure(rotation)).toBe(true);
      const configText = yield* fs.readFileString(`${home}/threadnote/sources.yaml`);
      expect(configText).not.toMatch(/pk_previouskey|pk_newkey|pk_envsecret/);
      const inventory = yield* runPocketSourceInventory(config, 'local');
      expect(inventory.source.project).toBe('safe');
    }).pipe(TestClock.withLive, provide),
  );

  it('uses the fixed origin and rejects redirects without sending credentials elsewhere', async () => {
    const calls: URL[] = [];
    const client = createPocketClient(Redacted.make('pk_synthetic_test'), {
      fetch: async url => {
        calls.push(url);
        return new Response(null, {status: 302, headers: {location: 'https://elsewhere.example/private'}});
      },
    });
    try {
      await expect(client.list(1)).rejects.toMatchObject({
        code: 'transport-rejected',
      } satisfies Partial<PocketClientError>);
      expect(calls).toHaveLength(1);
      expect(calls[0].origin).toBe('https://public.heypocketai.com');
    } finally {
      client.close();
    }
  });

  it('renders opaque transcript and summary shapes deterministically', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 200}), text => {
        const record = {
          id: 'record_1',
          title: 'Meeting',
          transcript: [{text}],
          summarizations: {actionItems: [{description: text}]},
        };
        const first = renderPocketRecord(record);
        expect(renderPocketRecord({...record})).toEqual(first);
        expect(first.every(chunk => Buffer.byteLength(chunk.body) <= 16 * 1024)).toBe(true);
      }),
      {numRuns: 80},
    );
  });

  it('blocks credential labels after joining structured fields', () => {
    expect(() => renderPocketRecord({id: 'record_1', summarizations: {api_token: 'sensitive-value'}})).toThrow();
    expect(() => renderPocketRecord({id: 'record_1', transcript: [{text: 'password: visible-value'}]})).toThrow();
  });

  it('preserves long provider Retry-After without following redirects', async () => {
    const client = createPocketClient(Redacted.make('pk_synthetic_test'), {
      fetch: async () => new Response(null, {status: 429, headers: {'retry-after': '172800'}}),
    });
    try {
      const failure = await client.list(1).catch(error => error as PocketClientError);
      if (!(failure instanceof PocketClientError)) throw new Error('Expected Pocket quota failure.');
      expect(failure.code).toBe('quota-rejected');
      expect(failure.retryAfterMilliseconds).toBe(172_800_000);
    } finally {
      client.close();
    }
  });

  effectIt.effect('syncs accessible recordings and catalog into direct read and recall, then denies on removal', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'pocket-source-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runPocketSourceAdd(config, {
        id: 'pocket-test',
        project: 'test',
        apply: true,
        apiToken: Redacted.make('pk_synthetic_test'),
      });
      const calls: URL[] = [];
      const fetch = async (url: URL, init: RequestInit) => {
        calls.push(url);
        expect(url.origin).toBe('https://public.heypocketai.com');
        expect(init.method).toBe('GET');
        expect(init.redirect).toBe('manual');
        if (url.pathname.endsWith('/folders')) return json({success: true, data: [{id: 'folder_1', name: 'Work'}]});
        if (url.pathname.endsWith('/tags')) return json({success: true, data: [{id: 'tag_1', name: 'Strategy'}]});
        if (url.pathname.endsWith('/recordings'))
          return json({
            success: true,
            data: [{id: 'record_1', title: 'Meeting'}],
            pagination: {page: 1, limit: 100, total: 1, total_pages: 1, has_more: false},
          });
        return json({
          success: true,
          data: {
            id: 'record_1',
            title: 'Meeting',
            transcript: [{speakerName: 'Alex', text: 'needle transcript'}],
            summarizations: {action_items: [{text: 'needle followup'}]},
          },
        });
      };
      const first = yield* runPocketSourceSync(config, {id: 'pocket-test', apply: true, clientOptions: {fetch}});
      expect(first.syncedDocuments).toEqual(['record_1']);
      expect(calls).toHaveLength(4);
      const doc = `r-${sha256HexSync('record_1').slice(0, 40)}`;
      const state = yield* readExternalDocumentManifest(
        {home, account: 'local', user: 'tester'},
        'pocket-test',
        doc,
        'pocket',
      );
      expect(state?.status).toBe('active');
      const uri = Object.keys(state!.chunks)[0];
      const store = yield* ResourceStore;
      expect(yield* store.read({home, account: 'local', user: 'tester'}, uri)).toContain('needle transcript');
      const recalled = yield* loadRecallIndexData(config, {
        includeInactive: false,
        query: 'needle',
        requiredUris: [uri],
        eligibility: {kind: 'pinned-hard-uri-bypass'},
      });
      expect(recalled.candidates.some(candidate => candidate.uri === uri)).toBe(true);
      expect((yield* runPocketSourceInventory(config, 'pocket-test')).entries.length).toBe(3);
      yield* runPocketSourceRemove(config, {id: 'pocket-test', apply: true});
      expect(
        Result.isFailure(yield* store.read({home, account: 'local', user: 'tester'}, uri).pipe(Effect.result)),
      ).toBe(true);
      expect(
        (yield* loadRecallIndexData(config, {
          includeInactive: false,
          query: 'needle',
          requiredUris: [uri],
          eligibility: {kind: 'pinned-hard-uri-bypass'},
        })).candidates,
      ).toEqual([]);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('resumes a bounded inventory and removes disappeared records only after a complete listing', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'pocket-resume-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runPocketSourceAdd(config, {
        id: 'resume',
        project: 'test',
        apply: true,
        apiToken: Redacted.make('pk_synthetic_resume'),
      });
      let inventory = Array.from({length: 14}, (_, index) => ({id: `record_${index}`, title: `Record ${index}`}));
      let listingStatus = 200;
      const fetch = async (url: URL) => {
        if (url.pathname.endsWith('/folders') || url.pathname.endsWith('/tags')) return json({success: true, data: []});
        if (url.pathname.endsWith('/recordings'))
          return listingStatus === 201
            ? json({
                success: true,
                data: [],
                pagination: {page: 1, limit: 100, total: 1, total_pages: 1, has_more: false},
              })
            : listingStatus === 200
              ? json({
                  success: true,
                  data: inventory,
                  pagination: {page: 1, limit: 100, total: inventory.length, total_pages: 1, has_more: false},
                })
              : json({error: 'temporary'}, listingStatus);
        const id = url.pathname.split('/').at(-1)!;
        if (!inventory.some(item => item.id === id)) return json({}, 404);
        return json({success: true, data: {id, title: id, transcript: [{text: `needle ${id}`}]}});
      };
      const imported = new Set<string>();
      for (let attempt = 0; attempt < 5; attempt++) {
        const result: PocketSyncResult = yield* runPocketSourceSync(config, {
          id: 'resume',
          apply: true,
          clientOptions: {fetch, maxRequests: 8},
        });
        for (const id of result.syncedDocuments) imported.add(id);
        if (!result.progress) break;
      }
      expect(imported.size).toBe(14);
      expect((yield* runPocketSourceInventory(config, 'resume')).entries.length).toBe(16);
      listingStatus = 500;
      yield* runPocketSourceSync(config, {id: 'resume', apply: true, clientOptions: {fetch}});
      expect((yield* runPocketSourceInventory(config, 'resume')).entries.length).toBe(16);
      listingStatus = 201;
      yield* runPocketSourceSync(config, {id: 'resume', apply: true, clientOptions: {fetch}});
      expect((yield* runPocketSourceInventory(config, 'resume')).entries.length).toBe(16);
      listingStatus = 200;
      inventory = [];
      yield* runPocketSourceSync(config, {id: 'resume', apply: true, clientOptions: {fetch}});
      expect((yield* runPocketSourceInventory(config, 'resume')).entries.length).toBe(16);
      yield* runPocketSourceSync(config, {id: 'resume', apply: true, clientOptions: {fetch}});
      expect((yield* runPocketSourceInventory(config, 'resume')).entries.length).toBe(2);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('persists provider retry delay and denies cached content on authentication loss', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'pocket-denial-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runPocketSourceAdd(config, {
        id: 'denial',
        projectless: true,
        apply: true,
        apiToken: Redacted.make('pk_synthetic_denial'),
      });
      const healthy = async (url: URL) => {
        if (url.pathname.endsWith('/folders') || url.pathname.endsWith('/tags')) return json({success: true, data: []});
        if (url.pathname.endsWith('/recordings'))
          return json({
            success: true,
            data: [{id: 'record_1'}],
            pagination: {page: 1, limit: 100, total: 1, total_pages: 1, has_more: false},
          });
        return json({success: true, data: {id: 'record_1', transcript: [{text: 'denial needle'}]}});
      };
      yield* runPocketSourceSync(config, {id: 'denial', apply: true, clientOptions: {fetch: healthy}});
      const doc = `r-${sha256HexSync('record_1').slice(0, 40)}`;
      const state = yield* readExternalDocumentManifest(
        {home, account: 'local', user: 'tester'},
        'denial',
        doc,
        'pocket',
      );
      const uri = Object.keys(state!.chunks)[0];
      const store = yield* ResourceStore;
      expect(
        Result.isSuccess(yield* store.read({home, account: 'local', user: 'tester'}, uri).pipe(Effect.result)),
      ).toBe(true);
      const rejected = yield* runPocketSourceSync(config, {
        id: 'denial',
        apply: true,
        clientOptions: {fetch: async () => json({}, 401)},
      });
      expect(rejected.warnings).toContain('Pocket source access was rejected.');
      expect(
        Result.isFailure(yield* store.read({home, account: 'local', user: 'tester'}, uri).pipe(Effect.result)),
      ).toBe(true);

      yield* runPocketSourceAdd(config, {
        id: 'quota',
        projectless: true,
        apply: true,
        apiToken: Redacted.make('pk_synthetic_quota'),
      });
      let calls = 0;
      const limited = async () => {
        calls++;
        return new Response(null, {status: 429, headers: {'retry-after': '172800'}});
      };
      yield* runPocketSourceSync(config, {id: 'quota', apply: true, clientOptions: {fetch: limited}});
      const inventory = yield* runPocketSourceInventory(config, 'quota');
      expect(inventory.nextAttemptAt).toBeGreaterThan((yield* Clock.currentTimeMillis) + 170_000_000);
      yield* runPocketSourceSync(config, {id: 'quota', apply: true, clientOptions: {fetch: limited}});
      expect(calls).toBe(1);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect(
    'quarantines a denied catalog, imports past a poison detail, and fences a denied recording list',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'pocket-scoped-denial-'});
        const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
        yield* runPocketSourceAdd(config, {
          id: 'scoped',
          projectless: true,
          apply: true,
          apiToken: Redacted.make('pk_synthetic_scoped'),
        });
        let phase: 'healthy' | 'poison' | 'list-denied' = 'healthy';
        const fetch = async (url: URL) => {
          if (url.pathname.endsWith('/folders'))
            return phase === 'poison'
              ? json({}, 403)
              : json({success: true, data: [{id: 'folder_1', name: 'old folder needle'}]});
          if (url.pathname.endsWith('/tags')) return json({success: true, data: []});
          if (url.pathname.endsWith('/recordings')) {
            if (phase === 'list-denied') return json({}, 403);
            const items = phase === 'healthy' ? [{id: 'record_a'}] : [{id: 'record_a'}, {id: 'record_b'}];
            return json({
              success: true,
              data: items,
              pagination: {page: 1, limit: 100, total: items.length, total_pages: 1, has_more: false},
            });
          }
          const id = url.pathname.split('/').at(-1)!;
          if (phase === 'poison' && id === 'record_a') return json({}, 500);
          return json({success: true, data: {id, transcript: [{text: `needle ${id}`}]}});
        };
        yield* runPocketSourceSync(config, {id: 'scoped', apply: true, clientOptions: {fetch}});
        const location = {home, account: 'local', user: 'tester'};
        const catalog = yield* readExternalDocumentManifest(location, 'scoped', 'catalog-folders', 'pocket');
        const catalogUri = Object.keys(catalog!.chunks)[0];
        const store = yield* ResourceStore;
        expect(Result.isSuccess(yield* store.read(location, catalogUri).pipe(Effect.result))).toBe(true);
        phase = 'poison';
        const poisoned = yield* runPocketSourceSync(config, {id: 'scoped', apply: true, clientOptions: {fetch}});
        expect(poisoned.syncedDocuments).toContain('record_b');
        expect(Result.isFailure(yield* store.read(location, catalogUri).pipe(Effect.result))).toBe(true);
        expect(
          (yield* loadRecallIndexData(config, {
            includeInactive: false,
            query: 'old folder needle',
            requiredUris: [catalogUri],
            eligibility: {kind: 'pinned-hard-uri-bypass'},
          })).candidates.some(candidate => candidate.uri === catalogUri),
        ).toBe(false);
        const bDoc = `r-${sha256HexSync('record_b').slice(0, 40)}`;
        const bManifest = yield* readExternalDocumentManifest(location, 'scoped', bDoc, 'pocket');
        const bUri = Object.keys(bManifest!.chunks)[0];
        expect(yield* store.read(location, bUri)).toContain('record_b');
        expect((yield* runPocketSourceInventory(config, 'scoped')).progress).toBeDefined();
        phase = 'list-denied';
        yield* runPocketSourceSync(config, {id: 'scoped', apply: true, clientOptions: {fetch}});
        expect(Result.isFailure(yield* store.read(location, bUri).pipe(Effect.result))).toBe(true);
        expect(
          (yield* loadRecallIndexData(config, {
            includeInactive: false,
            query: 'record_b',
            requiredUris: [bUri],
            eligibility: {kind: 'pinned-hard-uri-bypass'},
          })).candidates,
        ).toEqual([]);
      }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect('resumes saved page IDs after offset drift and confirms absence through detail before removal', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'pocket-stable-page-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runPocketSourceAdd(config, {
        id: 'stable',
        projectless: true,
        apply: true,
        apiToken: Redacted.make('pk_synthetic_stable'),
      });
      let ids = ['record_a', 'record_b', 'record_c'];
      let denyB = false;
      const fetch = async (url: URL) => {
        if (url.pathname.endsWith('/folders') || url.pathname.endsWith('/tags')) return json({success: true, data: []});
        if (url.pathname.endsWith('/recordings'))
          return json({
            success: true,
            data: ids.map(id => ({id})),
            pagination: {page: 1, limit: 100, total: ids.length, total_pages: 1, has_more: false},
          });
        const id = url.pathname.split('/').at(-1)!;
        if (id === 'record_b' && denyB) return json({}, 404);
        return json({success: true, data: {id, transcript: [{text: `stable needle ${id}`}]}});
      };
      const first = yield* runPocketSourceSync(config, {
        id: 'stable',
        apply: true,
        clientOptions: {fetch, maxRequests: 4},
      });
      expect(first.syncedDocuments).toEqual(['record_a']);
      ids = ['record_b', 'record_c'];
      const resumed = yield* runPocketSourceSync(config, {
        id: 'stable',
        apply: true,
        clientOptions: {fetch, maxRequests: 4},
      });
      expect(resumed.syncedDocuments).toEqual(['record_b', 'record_c']);
      expect((yield* runPocketSourceInventory(config, 'stable')).entries.length).toBe(5);
      ids = ['record_a', 'record_c'];
      const retained = yield* runPocketSourceSync(config, {id: 'stable', apply: true, clientOptions: {fetch}});
      expect(retained.syncedDocuments).toContain('record_b');
      expect((yield* runPocketSourceInventory(config, 'stable')).entries.length).toBe(5);
      denyB = true;
      yield* runPocketSourceSync(config, {id: 'stable', apply: true, clientOptions: {fetch}});
      expect((yield* runPocketSourceInventory(config, 'stable')).entries.length).toBe(4);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('restarts discovery after a saved later page becomes invalid', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'pocket-page-shrink-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runPocketSourceAdd(config, {
        id: 'shrink',
        projectless: true,
        apply: true,
        apiToken: Redacted.make('pk_synthetic_shrink'),
      });
      const original = Array.from({length: 101}, (_, index) => `record_${index}`);
      let listing = original;
      const pages: number[] = [];
      const fetch = async (url: URL) => {
        if (url.pathname.endsWith('/folders') || url.pathname.endsWith('/tags')) return json({success: true, data: []});
        if (url.pathname.endsWith('/recordings')) {
          const page = Number(url.searchParams.get('page'));
          pages.push(page);
          if ((page - 1) * 100 >= listing.length && page > 1) return json({}, 400);
          const data = listing.slice((page - 1) * 100, page * 100).map(id => ({id}));
          return json({
            success: true,
            data,
            pagination: {
              page,
              limit: 100,
              total: listing.length,
              total_pages: Math.ceil(listing.length / 100),
              has_more: page * 100 < listing.length,
            },
          });
        }
        const id = url.pathname.split('/').at(-1)!;
        return json({success: true, data: {id, transcript: [{text: `retained ${id}`}]}});
      };
      const first: PocketSyncResult = yield* runPocketSourceSync(config, {
        id: 'shrink',
        apply: true,
        clientOptions: {fetch, maxRequests: 103},
      });
      expect(first.progress?.page).toBe(2);
      expect((yield* runPocketSourceInventory(config, 'shrink')).entries.length).toBe(102);
      listing = ['record_0', 'record_fresh'];
      const invalid: PocketSyncResult = yield* runPocketSourceSync(config, {
        id: 'shrink',
        apply: true,
        clientOptions: {fetch},
      });
      expect(invalid.progress?.page).toBe(1);
      expect((yield* runPocketSourceInventory(config, 'shrink')).entries.length).toBe(102);
      const recovered = yield* runPocketSourceSync(config, {id: 'shrink', apply: true, clientOptions: {fetch}});
      expect(recovered.syncedDocuments).toContain('record_fresh');
      expect(pages.slice(0, 3)).toEqual([1, 2, 1]);
      expect(
        (yield* runPocketSourceInventory(config, 'shrink')).entries.some(
          item => item.documentId === `r-${sha256HexSync('record_fresh').slice(0, 40)}`,
        ),
      ).toBe(true);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('checkpoints confirmation when the local run deadline expires', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'pocket-confirm-deadline-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runPocketSourceAdd(config, {
        id: 'deadline',
        projectless: true,
        apply: true,
        apiToken: Redacted.make('pk_synthetic_deadline'),
      });
      let listing = Array.from({length: 20}, (_, index) => `record_${index}`);
      let delayDetail = false;
      let detailCalls = 0;
      const fetch = async (url: URL) => {
        if (url.pathname.endsWith('/folders') || url.pathname.endsWith('/tags')) return json({success: true, data: []});
        if (url.pathname.endsWith('/recordings'))
          return json({
            success: true,
            data: listing.map(id => ({id})),
            pagination: {page: 1, limit: 100, total: listing.length, total_pages: 1, has_more: false},
          });
        detailCalls++;
        if (delayDetail) await new Promise(resolve => setTimeout(resolve, 200));
        const id = url.pathname.split('/').at(-1)!;
        return delayDetail ? json({success: true, data: {id}}) : json({}, 404);
      };
      // Prime active markers, then leave a confirmation cursor just before its first old ID.
      const importFetch = async (url: URL) => {
        if (url.pathname.endsWith('/folders') || url.pathname.endsWith('/tags')) return json({success: true, data: []});
        if (url.pathname.endsWith('/recordings'))
          return json({
            success: true,
            data: listing.map(id => ({id})),
            pagination: {page: 1, limit: 100, total: listing.length, total_pages: 1, has_more: false},
          });
        const id = url.pathname.split('/').at(-1)!;
        return json({success: true, data: {id, transcript: [{text: `old ${id}`}]}});
      };
      yield* runPocketSourceSync(config, {id: 'deadline', apply: true, clientOptions: {fetch: importFetch}});
      listing = [];
      yield* runPocketSourceSync(config, {id: 'deadline', apply: true, clientOptions: {fetch, maxRequests: 3}});
      expect((yield* readPocketSyncState(config, 'deadline'))?.phase).toBe('confirm');
      delayDetail = true;
      const expired: PocketSyncResult = yield* runPocketSourceSync(config, {
        id: 'deadline',
        apply: true,
        clientOptions: {fetch, totalTimeoutMilliseconds: 100},
      });
      expect(expired.progress).toBeDefined();
      expect(detailCalls).toBe(1);
      expect((yield* readPocketSyncState(config, 'deadline'))?.confirmAfter).toBeUndefined();
      delayDetail = false;
      yield* runPocketSourceSync(config, {id: 'deadline', apply: true, clientOptions: {fetch}});
      expect((yield* runPocketSourceInventory(config, 'deadline')).entries.length).toBe(2);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('shares automatic refresh budget and rotates the starting source across calls', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'pocket-fair-refresh-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      for (let index = 0; index < 5; index++)
        yield* runPocketSourceAdd(config, {
          id: `fair${index}`,
          projectless: true,
          apply: true,
          apiToken: Redacted.make(`pk_fair${index}`),
        });
      let calls = 0;
      const fetch = async (url: URL) => {
        calls++;
        if (url.pathname.endsWith('/folders') || url.pathname.endsWith('/tags')) return json({success: true, data: []});
        if (url.pathname.endsWith('/recordings'))
          return json({
            success: true,
            data: [{id: 'record_1'}],
            pagination: {page: 1, limit: 100, total: 1, total_pages: 1, has_more: false},
          });
        return json({success: true, data: {id: 'record_1', transcript: [{text: 'fairness needle'}]}});
      };
      const first = yield* syncPocketSourcesBeforeRecall(config, {fetch});
      expect(calls).toBeLessThanOrEqual(16);
      const firstCount = calls;
      const second = yield* syncPocketSourcesBeforeRecall(config, {fetch});
      expect(calls - firstCount).toBeLessThanOrEqual(16);
      expect(new Set([...first.syncedSources, ...second.syncedSources]).size).toBe(5);
    }).pipe(TestClock.withLive, provide),
  );
});
