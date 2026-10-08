import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Redacted, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  externalResourceUri,
  readExternalDocumentManifest,
  readExternalSourceReceipt,
  externalSourceReceiptUri,
  serializeExternalSourceReceipt,
  loadExternalResourceAccess,
} from '@threadnote/store/external-resource';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {superhumanExternalSourcePolicyLayer} from '../../superhuman/access-policy.js';
import {runGitHubSourceAdd, runGitHubSourceSync, runGitHubSourceInventory, runGitHubSourceRemove} from '../source.js';
import {
  readGitHubRepositoryStates,
  readGitHubSyncState,
  listGitHubIdMarkers,
  readGitHubRepositoryCheckpoint,
  writeGitHubRepositoryCheckpoint,
  clearGitHubRepositoryCheckpoint,
  writeGitHubSyncState,
  type GitHubSyncState,
} from '../state.js';
import {makeGitHubClientBudget} from '../client.js';
import {fixtureFetch, json, restItem, timestamp} from './fixtures.js';
const dependencies = Layer.mergeAll(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'github-source.test.ts'}),
        Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: e => ({...e}), sanitizeExternal: e => ({...e})}),
      ),
    ),
  ),
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const access = Layer.merge(dependencies, superhumanExternalSourcePolicyLayer.pipe(Layer.provide(dependencies)));
const layer = Layer.merge(access, ResourceStore.layer.pipe(Layer.provide(access)));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const configFor = (home: string) => ({agentContextHome: home, account: 'local', user: 'tester'}) as RuntimeConfig;
const location = (config: RuntimeConfig) => ({
  home: config.agentContextHome,
  account: config.account,
  user: config.user,
});
const setup = Effect.fn(function* (home: string, id = 'github', repositories = ['owner/repo']) {
  const config = configFor(home);
  yield* runGitHubSourceAdd(config, {
    id,
    repositories,
    project: 'test',
    apply: true,
    apiToken: Redacted.make('ghp_synthetic_test_only_key'),
  });
  return config;
});
const uri = (number = 1) =>
  externalResourceUri({
    provider: 'github',
    sourceId: 'github',
    documentId: `r-7-issue-${number + 10}`,
    pageId: 'description',
    chunkId: 'part-0',
  });
const namePath = (url: URL) =>
  url.pathname
    .replace(/^\/repositories\/7(?=\/|$)/, '/repos/owner/repo')
    .replace(/^\/repositories\/9(?=\/|$)/, '/repos/zowner/healthy');
const healthyUri = externalResourceUri({
  provider: 'github',
  sourceId: 'github',
  documentId: 'r-9-issue-13',
  pageId: 'description',
  chunkId: 'part-0',
});
const selectedFetch = (url: URL) => {
  const pathname = namePath(url);
  if (pathname === '/repos/zowner/healthy')
    return Promise.resolve(json({id: 9, full_name: 'zowner/healthy', private: false}));
  const item = {...restItem(3), html_url: 'https://github.com/zowner/healthy/issues/3'};
  if (pathname === '/repos/zowner/healthy/issues') return Promise.resolve(json([item]));
  if (pathname === '/repos/zowner/healthy/issues/3') return Promise.resolve(json(item));
  if (pathname.startsWith('/repos/zowner/healthy/')) return Promise.resolve(json([]));
  return fixtureFetch([1, 2])(url);
};
describe('GitHub source', () => {
  effectIt.effect('publishes complete stable snapshots idempotently and denies direct reads on removal', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* setup(yield* fs.makeTempDirectoryScoped());
      const result = yield* runGitHubSourceSync(config, {
        id: 'github',
        apply: true,
        clientOptions: {fetch: fixtureFetch()},
      });
      expect(result.syncedDocuments).toEqual(['r-7-issue-11', 'r-7-issue-12']);
      expect(result.progress).toBeUndefined();
      const store = yield* ResourceStore;
      expect(yield* store.read(location(config), uri())).toContain('Body 1');
      const first = yield* readExternalDocumentManifest(location(config), 'github', 'r-7-issue-11', 'github');
      yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch: fixtureFetch()}});
      const second = yield* readExternalDocumentManifest(location(config), 'github', 'r-7-issue-11', 'github');
      expect(first?.chunks).toEqual(second?.chunks);
      yield* runGitHubSourceRemove(config, {id: 'github', apply: true});
      expect(Result.isFailure(yield* store.read(location(config), uri()).pipe(Effect.result))).toBe(true);
    }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect('keeps the watermark of an incompletely enumerated stream while advancing completed streams', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* setup(yield* fs.makeTempDirectoryScoped());
      const boundary = Date.parse(timestamp) + 3600000;
      yield* TestClock.setTime(boundary);
      yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch: fixtureFetch([1])}});
      yield* TestClock.setTime(boundary + 180000);
      const mock = fixtureFetch([1]);
      const fetch = async (url: URL) => {
        if (namePath(url) === '/repos/owner/repo/issues') return json([]);
        if (namePath(url) === '/repos/owner/repo/issues/comments') {
          if (url.searchParams.get('page') === '2') return json({}, 429, {'retry-after': '120'});
          const next = new URL(url);
          next.searchParams.set('page', '2');
          return json([], 200, {link: `<${next}>; rel="next"`});
        }
        return mock(url);
      };
      yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch}});
      const repository = (yield* readGitHubRepositoryStates(config, 'github'))![0];
      expect(repository.issueWatermark).toBe(boundary + 180000);
      expect(repository.commentsWatermark).toBe(boundary);
      expect(repository.reviewCommentsWatermark).toBe(boundary);
      expect((yield* readGitHubSyncState(config, 'github'))?.phase).toBe('comments');
    }).pipe(provide),
  );
  effectIt.effect.prop(
    'resumes bounded backfill equivalent to an independent complete inventory model',
    {
      count: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 6})),
      start: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 20})),
    },
    ({count, start}) =>
      Effect.gen(function* () {
        const numbers = Array.from({length: count}, (_, i) => start + i);
        const fs = yield* FileSystem.FileSystem;
        const config = yield* setup(yield* fs.makeTempDirectoryScoped());
        let done = false;
        for (let run = 0; run < numbers.length + 5; run++) {
          const result = yield* runGitHubSourceSync(config, {
            id: 'github',
            apply: true,
            clientOptions: {fetch: fixtureFetch(numbers), maxRequests: 6},
          });
          if (!result.progress) {
            done = true;
            break;
          }
        }
        expect(done).toBe(true);
        expect(yield* readGitHubSyncState(config, 'github')).toBeUndefined();
        const inventory = yield* runGitHubSourceInventory(config, 'github');
        expect(inventory.entries.map(x => x.documentId).sort()).toEqual(numbers.map(n => `r-7-issue-${n + 10}`).sort());
        expect(inventory.entries.every(x => x.status === 'active')).toBe(true);
        const store = yield* ResourceStore;
        for (const number of numbers)
          expect(yield* store.read(location(config), uri(number))).toContain(`Body ${number}`);
      }).pipe(TestClock.withLive, provide),
    {timeout: 30000, arbitrary: {runs: 5, seed: 42}},
  );
  effectIt.effect(
    'overlapping comment deltas refresh edits and reconciliation removes deleted comments with unchanged parent dates',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* setup(yield* fs.makeTempDirectoryScoped());
        let phase = 0;
        const mock = fixtureFetch([1]);
        const fetch = async (url: URL) => {
          if (namePath(url).endsWith('/issues/1/comments'))
            return json(
              phase === 2
                ? []
                : [
                    {
                      id: 5,
                      user: {login: 'alice'},
                      body: phase === 0 ? 'Original' : 'Edited',
                      created_at: timestamp,
                      updated_at: timestamp,
                      html_url: 'https://github.com/owner/repo/issues/1#issuecomment-5',
                    },
                  ],
            );
          if (namePath(url).endsWith('/issues/1')) return json({...restItem(1), comments: phase === 2 ? 0 : 1});
          if (phase === 1 && namePath(url) === '/repos/owner/repo/issues/comments')
            return json([{id: 5, issue_url: 'https://api.github.com/repos/owner/Repo/issues/1'}]);
          if (phase > 0 && namePath(url) === '/repos/owner/repo/issues') return json([]);
          return mock(url);
        };
        const commentUri = externalResourceUri({
          provider: 'github',
          sourceId: 'github',
          documentId: 'r-7-issue-11',
          pageId: 'comment-5',
          chunkId: 'part-0',
        });
        const store = yield* ResourceStore;
        for (phase = 0; phase < 3; phase++) {
          yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch}});
          const manifest = yield* readExternalDocumentManifest(location(config), 'github', 'r-7-issue-11', 'github');
          if (phase < 2)
            expect(yield* store.read(location(config), commentUri)).toContain(phase === 0 ? 'Original' : 'Edited');
          else expect(manifest?.chunks[commentUri]).toBeUndefined();
        }
      }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect(
    'reconciliation observes review state and thread resolution changes with unchanged parent updated_at',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* setup(yield* fs.makeTempDirectoryScoped());
        let resolved = false;
        const fetch = async (url: URL) => {
          if (namePath(url) === '/repos/owner/repo') return json({id: 7, full_name: 'owner/repo', private: false});
          if (namePath(url) === '/repos/owner/repo/issues') return json(resolved ? [] : [restItem(1, true)]);
          if (namePath(url) === '/graphql')
            return json({
              data: {
                repository: {
                  databaseId: 7,
                  pullRequest: {
                    reviewThreads: {
                      nodes: [
                        {
                          id: 'thread1',
                          isResolved: resolved,
                          isOutdated: resolved,
                          path: 'file.ts',
                          line: 1,
                          comments: {
                            nodes: [
                              {
                                id: 'reply1',
                                author: {login: 'reviewer'},
                                body: 'Inline note',
                                createdAt: timestamp,
                                updatedAt: timestamp,
                                url: 'https://github.com/owner/repo/pull/1#discussion_r1',
                                diffHunk: '@@ line @@',
                                pullRequestReview: {state: resolved ? 'DISMISSED' : 'APPROVED'},
                              },
                            ],
                            totalCount: 1,
                            pageInfo: {hasNextPage: false, endCursor: null},
                          },
                        },
                      ],
                      totalCount: 1,
                      pageInfo: {hasNextPage: false, endCursor: null},
                    },
                  },
                },
              },
            });
          if (namePath(url).endsWith('/reviews'))
            return json([
              {
                id: 5,
                state: resolved ? 'DISMISSED' : 'APPROVED',
                submitted_at: timestamp,
                user: {login: 'reviewer'},
                body: 'Review summary',
                html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-5',
              },
            ]);
          if (namePath(url).includes('/pulls/1'))
            return json({number: 1, html_url: 'https://github.com/owner/repo/pull/1', merged: false, draft: false});
          if (namePath(url).endsWith('/comments')) return json([]);
          return json(restItem(1, true));
        };
        for (const changed of [false, true]) {
          resolved = changed;
          const result = yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch}});
          expect(result.progress).toBeUndefined();
          const manifest = yield* readExternalDocumentManifest(location(config), 'github', 'r-7-pull-11', 'github');
          const store = yield* ResourceStore;
          const resources: string[] = [];
          for (const uri of Object.keys(manifest?.chunks ?? {}))
            resources.push(yield* store.read(location(config), uri));
          expect(resources.join('\n')).toContain(`Resolved: ${changed}; outdated: ${changed}`);
          expect(resources.join('\n')).toContain(`Review: ${changed ? 'DISMISSED' : 'APPROVED'}`);
          expect(resources.join('\n')).toContain(`updated: ${timestamp}`);
        }
      }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect('denies observed repository loss and source authentication loss but keeps quota snapshots', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const status of [403, 404, 401, 429]) {
        const config = yield* setup(yield* fs.makeTempDirectoryScoped());
        yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch: fixtureFetch([1])}});
        yield* runGitHubSourceSync(config, {
          id: 'github',
          apply: true,
          clientOptions: {fetch: async () => json({}, status, status === 429 ? {'retry-after': '120'} : {})},
        });
        const store = yield* ResourceStore;
        const read = yield* store.read(location(config), uri()).pipe(Effect.result);
        expect(Result.isSuccess(read)).toBe(status === 429);
        const receipt = yield* readExternalSourceReceipt(location(config), 'github', 'github');
        if (status === 401) expect(receipt?.status).toBe('authentication-rejected');
        if (status === 429) expect(receipt?.nextAttemptAt).toBeGreaterThan(yield* Clock.currentTimeMillis);
      }
    }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect('expires last complete cache at max age and quarantines credential-like conversation edits', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* setup(yield* fs.makeTempDirectoryScoped());
      yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch: fixtureFetch([1])}}).pipe(
        TestClock.withLive,
      );
      const manifest = yield* readExternalDocumentManifest(location(config), 'github', 'r-7-issue-11', 'github');
      const store = yield* ResourceStore;
      yield* TestClock.setTime(manifest!.fetchedAt + manifest!.maxStaleMilliseconds + 1);
      expect(Result.isFailure(yield* store.read(location(config), uri()).pipe(Effect.result))).toBe(true);
      const mock = fixtureFetch([1]);
      yield* runGitHubSourceSync(config, {
        id: 'github',
        apply: true,
        clientOptions: {
          fetch: async url =>
            namePath(url).endsWith('/issues/1')
              ? json({...restItem(1), body: 'api_token: synthetic-secret'})
              : mock(url),
        },
      }).pipe(TestClock.withLive);
      const inventory = yield* runGitHubSourceInventory(config, 'github').pipe(TestClock.withLive);
      expect(inventory.entries[0].status).toBe('quarantined');
    }).pipe(provide),
  );
  effectIt.effect('pins repository numeric identity and rejects name reuse', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* setup(yield* fs.makeTempDirectoryScoped());
      yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch: fixtureFetch([1])}});
      const mock = fixtureFetch([1]);
      yield* runGitHubSourceSync(config, {
        id: 'github',
        apply: true,
        clientOptions: {
          fetch: async url =>
            namePath(url) === '/repos/owner/repo' ? json({id: 9, full_name: 'owner/repo', private: false}) : mock(url),
        },
      });
      const repository = yield* readGitHubRepositoryStates(config, 'github');
      expect(repository?.[0].id).toBe('7');
      expect(repository?.[0].status).toBe('pending');
      expect(Result.isFailure(yield* (yield* ResourceStore).read(location(config), uri()).pipe(Effect.result))).toBe(
        true,
      );
    }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect('progresses past oversized conversations with visible deferred inventory', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* setup(yield* fs.makeTempDirectoryScoped());
      const mock = fixtureFetch([1, 2]);
      const result = yield* runGitHubSourceSync(config, {
        id: 'github',
        apply: true,
        clientOptions: {
          fetch: async url =>
            namePath(url) === '/repos/owner/repo/issues/1'
              ? new Response('x'.repeat(3 * 1024 * 1024), {headers: {'content-type': 'application/json'}})
              : mock(url),
        },
      });
      expect(result.syncedDocuments).toContain('r-7-issue-12');
      const inventory = yield* runGitHubSourceInventory(config, 'github');
      expect(inventory.entries.find(e => e.documentId === 'r-7-issue-11')?.status).toBe('pending');
      expect(result.warnings.join(' ')).toContain('response-too-large');
    }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect('denies pending publication when configuration changes during provider reads', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* setup(yield* fs.makeTempDirectoryScoped());
      const mock = fixtureFetch([1]);
      let changed = false;
      const result = yield* runGitHubSourceSync(config, {
        id: 'github',
        apply: true,
        clientOptions: {
          fetch: async url => {
            if (!changed && namePath(url).endsWith('/issues/1')) {
              changed = true;
              const file = `${config.agentContextHome}/threadnote/sources.yaml`;
              const data = await import('node:fs/promises');
              const text = await data.readFile(file, 'utf8');
              await data.writeFile(file, text.replace('enabled: true', 'enabled: false'));
            }
            return mock(url);
          },
        },
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(Result.isFailure(yield* (yield* ResourceStore).read(location(config), uri()).pipe(Effect.result))).toBe(
        true,
      );
    }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect(
    'persists repository denial before interrupted cleanup and recovers only after scope validation',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* setup(yield* fs.makeTempDirectoryScoped(), 'github', ['owner/repo', 'zowner/healthy']);
        yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch: selectedFetch}});
        const store = yield* ResourceStore;
        let quarantined = 0;
        const interruptedStore: typeof store = {
          ...store,
          mutateChecked: (where, mutations, check) => {
            if (
              mutations.some(
                m =>
                  m.type === 'write' &&
                  m.uri.endsWith('/.manifest.json') &&
                  m.content.includes('"status":"quarantined"'),
              ) &&
              ++quarantined === 2
            )
              return Effect.die('Synthetic interrupted cleanup');
            return store.mutateChecked(where, mutations, check);
          },
        };
        const deniedFetch = async (url: URL) =>
          namePath(url) === '/repos/owner/repo' ? json({}, 403) : selectedFetch(url);
        const interrupted = yield* runGitHubSourceSync(config, {
          id: 'github',
          apply: true,
          clientOptions: {fetch: deniedFetch},
        }).pipe(Effect.provideService(ResourceStore, interruptedStore), Effect.exit);
        expect(interrupted._tag).toBe('Failure');
        expect((yield* readExternalSourceReceipt(location(config), 'github', 'github'))?.deniedRepositoryIds).toEqual([
          '7',
        ]);
        expect(
          (yield* readExternalDocumentManifest(location(config), 'github', 'r-7-issue-12', 'github'))?.status,
        ).toBe('active');
        for (const number of [1, 2])
          expect(Result.isFailure(yield* store.read(location(config), uri(number)).pipe(Effect.result))).toBe(true);
        expect(yield* loadExternalResourceAccess(location(config))).toEqual({[healthyUri]: expect.any(String)});
        expect(yield* store.read(location(config), healthyUri)).toContain('Body 3');
        yield* runGitHubSourceSync(config, {
          id: 'github',
          apply: true,
          clientOptions: {fetch: selectedFetch, maxRequests: 1},
        });
        expect((yield* readExternalSourceReceipt(location(config), 'github', 'github'))?.deniedRepositoryIds).toEqual([
          '7',
        ]);
        expect(Result.isFailure(yield* store.read(location(config), uri(2)).pipe(Effect.result))).toBe(true);
        for (let attempt = 0; attempt < 4; attempt++) {
          const recovered = yield* runGitHubSourceSync(config, {
            id: 'github',
            apply: true,
            clientOptions: {fetch: selectedFetch},
          });
          if (!recovered.progress) break;
        }
        expect(
          (yield* readExternalSourceReceipt(location(config), 'github', 'github'))?.deniedRepositoryIds ?? [],
        ).toEqual([]);
        expect(yield* store.read(location(config), uri(2))).toContain('Body 2');
      }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect('consumes a saved changed-number page when its first parent becomes unavailable', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* setup(yield* fs.makeTempDirectoryScoped(), 'github', ['owner/repo', 'zowner/healthy']);
      yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch: selectedFetch}});
      const changedFetch = async (url: URL) => {
        const pathname = namePath(url);
        if (pathname === '/repos/owner/repo/issues') return json([]);
        if (pathname === '/repos/owner/repo/issues/comments')
          return json([1, 2].map(n => ({id: n, issue_url: `https://api.github.com/repos/owner/repo/issues/${n}`})));
        if (pathname === '/repos/owner/repo/issues/1') return json({}, 404);
        return selectedFetch(url);
      };
      yield* runGitHubSourceSync(config, {
        id: 'github',
        apply: true,
        clientOptions: {fetch: changedFetch, maxRequests: 3},
      });
      expect((yield* readGitHubRepositoryCheckpoint(config, 'github', '7', 0))?.numbers).toEqual([1, 2]);
      const synced: string[] = [];
      let done = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = yield* runGitHubSourceSync(config, {
          id: 'github',
          apply: true,
          clientOptions: {fetch: changedFetch},
        });
        synced.push(...result.syncedDocuments);
        if (!result.progress) {
          done = true;
          break;
        }
      }
      expect(done).toBe(true);
      expect(synced).toContain('r-7-issue-12');
      expect(synced).toContain('r-9-issue-13');
      const repositories = yield* readGitHubRepositoryStates(config, 'github');
      expect(repositories?.find(r => r.id === '7')?.unresolvedNumbers).toEqual([
        {number: 1, nextAttemptAt: expect.any(Number)},
      ]);
      const store = yield* ResourceStore;
      expect(Result.isFailure(yield* store.read(location(config), uri()).pipe(Effect.result))).toBe(true);
      expect(yield* store.read(location(config), uri(2))).toContain('Body 2');
      expect(yield* store.read(location(config), healthyUri)).toContain('Body 3');
      expect(
        (yield* readExternalSourceReceipt(location(config), 'github', 'github'))?.deniedRepositoryIds ?? [],
      ).toEqual([]);
    }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect.prop(
    'advances complete delta streams while preserving permanently deferred retry markers',
    {cycles: Schema.Int.check(Schema.isBetween({minimum: 2, maximum: 4}))},
    ({cycles}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* setup(yield* fs.makeTempDirectoryScoped());
        const mock = fixtureFetch([1, 2]);
        const fetch = async (url: URL) =>
          namePath(url) === '/repos/owner/repo/issues/1'
            ? new Response('x'.repeat(3 * 1024 * 1024), {headers: {'content-type': 'application/json'}})
            : mock(url);
        let boundary = Date.parse(timestamp) + 3600000;
        for (let cycle = 0; cycle < cycles; cycle++) {
          yield* TestClock.setTime(boundary);
          const observed: string[] = [];
          yield* runGitHubSourceSync(config, {
            id: 'github',
            apply: true,
            clientOptions: {
              fetch: url => {
                if (url.searchParams.has('since')) observed.push(url.searchParams.get('since')!);
                return fetch(url);
              },
            },
          });
          const repository = (yield* readGitHubRepositoryStates(config, 'github'))![0];
          expect(repository.issueWatermark).toBe(boundary);
          expect(repository.commentsWatermark).toBe(boundary);
          expect(repository.reviewCommentsWatermark).toBe(boundary);
          if (cycle > 0) expect(observed.every(since => Date.parse(since) >= boundary - 300000)).toBe(true);
          expect((yield* listGitHubIdMarkers(config, 'github'))?.find(m => m.number === 1)?.pending).toBe(true);
          expect(yield* (yield* ResourceStore).read(location(config), uri(2))).toContain('Body 2');
          boundary += 180000;
        }
      }).pipe(provide),
    {timeout: 30000, arbitrary: {runs: 3, seed: 81}},
  );
  effectIt.effect('guards both cached PRs before interrupted unscoped permission denial and through recovery', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const mode of ['graphql', 'candidate']) {
        const config = yield* setup(yield* fs.makeTempDirectoryScoped(), 'github', ['owner/repo', 'zowner/healthy']);
        let forbidden = false;
        const fetch = async (url: URL) => {
          const pathname = namePath(url);
          if (pathname === '/repos/owner/repo/issues')
            return json(forbidden && mode === 'candidate' ? [] : [restItem(1, true), restItem(2, true)]);
          if (pathname === '/repos/owner/repo/issues/comments' && forbidden && mode === 'candidate')
            return json(
              [1, 2].map(number => ({
                id: number,
                issue_url: `https://api.github.com/repos/owner/repo/issues/${number}`,
              })),
            );
          if (pathname === '/graphql')
            return forbidden && mode === 'graphql'
              ? json({errors: [{type: 'FORBIDDEN'}]})
              : json({
                  data: {
                    repository: {
                      databaseId: 7,
                      pullRequest: {
                        reviewThreads: {nodes: [], totalCount: 0, pageInfo: {hasNextPage: false, endCursor: null}},
                      },
                    },
                  },
                });
          if (/^\/repos\/owner\/repo\/pulls\/[12]$/.test(pathname)) {
            const number = Number(pathname.split('/').at(-1));
            return json({
              number,
              html_url: `https://github.com/owner/repo/pull/${number}`,
              merged: false,
              draft: false,
            });
          }
          if (/^\/repos\/owner\/repo\/issues\/[12]$/.test(pathname))
            return forbidden && mode === 'candidate'
              ? json({}, 403)
              : json(restItem(Number(pathname.split('/').at(-1)), true));
          if (pathname === '/repos/owner/repo' || pathname.startsWith('/repos/zowner/healthy'))
            return selectedFetch(url);
          return json([]);
        };
        const boundary = Date.parse(timestamp) + 3600000;
        yield* TestClock.setTime(boundary);
        yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch}});
        const store = yield* ResourceStore;
        const pullUri = (number: number) =>
          externalResourceUri({
            provider: 'github',
            sourceId: 'github',
            documentId: `r-7-pull-${number + 10}`,
            pageId: 'description',
            chunkId: 'part-0',
          });
        expect(yield* store.read(location(config), pullUri(2))).toContain('Body 2');
        forbidden = true;
        yield* TestClock.setTime(boundary + 180000);
        let quarantined = 0;
        const interruptedStore: typeof store = {
          ...store,
          mutateChecked: (where, mutations, check) => {
            if (
              mutations.some(
                m =>
                  m.type === 'write' &&
                  m.uri.endsWith('/.manifest.json') &&
                  m.content.includes('"status":"quarantined"'),
              ) &&
              ++quarantined === 2
            )
              return Effect.die('Synthetic interrupted permission cleanup');
            return store.mutateChecked(where, mutations, check);
          },
        };
        const result = yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch}}).pipe(
          Effect.provideService(ResourceStore, interruptedStore),
          Effect.exit,
        );
        expect(result._tag).toBe('Failure');
        expect((yield* readExternalSourceReceipt(location(config), 'github', 'github'))?.deniedRepositoryIds).toEqual([
          '7',
        ]);
        expect((yield* readExternalDocumentManifest(location(config), 'github', 'r-7-pull-12', 'github'))?.status).toBe(
          'active',
        );
        for (const number of [1, 2]) {
          expect(Result.isFailure(yield* store.read(location(config), pullUri(number)).pipe(Effect.result))).toBe(true);
          expect(
            Result.isFailure(yield* store.readBounded(location(config), pullUri(number), 64).pipe(Effect.result)),
          ).toBe(true);
        }
        expect(yield* loadExternalResourceAccess(location(config))).toEqual({[healthyUri]: expect.any(String)});
        expect(yield* store.read(location(config), healthyUri)).toContain('Body 3');
        forbidden = false;
        yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch, maxRequests: 1}});
        expect((yield* readExternalSourceReceipt(location(config), 'github', 'github'))?.deniedRepositoryIds).toEqual([
          '7',
        ]);
        for (let attempt = 0; attempt < 2; attempt++)
          yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch, maxRequests: 23}});
        expect((yield* readExternalDocumentManifest(location(config), 'github', 'r-7-pull-11', 'github'))?.status).toBe(
          'active',
        );
        expect((yield* readExternalDocumentManifest(location(config), 'github', 'r-7-pull-12', 'github'))?.status).toBe(
          'quarantined',
        );
        expect(Result.isFailure(yield* store.read(location(config), pullUri(2)).pipe(Effect.result))).toBe(true);
        expect(Object.keys(yield* loadExternalResourceAccess(location(config)))).not.toContain(pullUri(2));
        yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch}});
        for (const number of [1, 2])
          expect(yield* store.read(location(config), pullUri(number))).toContain(`Body ${number}`);
      }
    }).pipe(provide),
  );
  effectIt.effect(
    'parks saturated changed pages without starving a healthy repository or restarting its unfinished import',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* setup(yield* fs.makeTempDirectoryScoped(), 'github', ['owner/repo', 'zowner/healthy']);
        const boundary = Date.parse(timestamp) + 3600000;
        yield* TestClock.setTime(boundary);
        let cycle = 0;
        let changed = false;
        let unavailableCalls = 0;
        const healthyNumbers = Array.from({length: 8}, (_, i) => 200 + i);
        const fetch = async (url: URL) => {
          const pathname = namePath(url);
          if (pathname === '/repos/owner/repo') return json({id: 7, full_name: 'owner/repo', private: false});
          if (pathname === '/repos/owner/repo/issues') return json([]);
          if (changed && pathname === '/repos/owner/repo/issues/comments') {
            const page = Number(url.searchParams.get('page') ?? 1);
            const numbers = page === 1 ? Array.from({length: 100}, (_, i) => i + 1) : [101, 102, 103];
            const next = new URL(url);
            next.searchParams.set('page', '2');
            return json(
              numbers.map(number => ({
                id: number,
                issue_url: `https://api.github.com/repos/owner/repo/issues/${number}`,
              })),
              200,
              page === 1 ? {link: `<${next}>; rel="next"`} : {},
            );
          }
          if (/^\/repos\/owner\/repo\/issues\/\d+$/.test(pathname)) {
            unavailableCalls++;
            return json({}, 404);
          }
          if (pathname === '/repos/zowner/healthy') return json({id: 9, full_name: 'zowner/healthy', private: false});
          const item = (number: number) => ({
            ...restItem(number),
            body: `Healthy cycle ${cycle}`,
            html_url: `https://github.com/zowner/healthy/issues/${number}`,
          });
          if (pathname === '/repos/zowner/healthy/issues') return json(changed ? [] : healthyNumbers.map(item));
          if (/^\/repos\/zowner\/healthy\/issues\/\d+$/.test(pathname))
            return json(item(Number(pathname.split('/').at(-1))));
          return json([]);
        };
        yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch}});
        changed = true;
        let sawUnfinishedHealthy = false;
        let sawResumedHealthyComplete = false;
        for (cycle = 1; cycle <= 24; cycle++) {
          yield* TestClock.setTime(boundary + cycle * 180000);
          unavailableCalls = 0;
          const result = yield* runGitHubSourceSync(config, {
            id: 'github',
            apply: true,
            clientOptions: {fetch, maxRequests: 16, budget: makeGitHubClientBudget(20000, 16)},
          });
          expect(result.syncedDocuments.some(doc => doc.startsWith('r-9-'))).toBe(true);
          expect(unavailableCalls).toBeLessThan(8);
          const repositories = (yield* readGitHubRepositoryStates(config, 'github'))!;
          const unavailable = repositories.find(r => r.id === '7')!;
          expect(unavailable.commentsWatermark).toBe(boundary);
          const healthy = repositories.find(r => r.id === '9')!;
          if (cycle === 1) {
            expect(healthy.parked).toBe(true);
            sawUnfinishedHealthy = true;
          }
          if (sawUnfinishedHealthy && !healthy.parked) sawResumedHealthyComplete = true;
        }
        expect(sawUnfinishedHealthy && sawResumedHealthyComplete).toBe(true);
        const unavailable = (yield* readGitHubRepositoryStates(config, 'github'))!.find(r => r.id === '7')!;
        expect(unavailable.unresolvedNumbers).toHaveLength(100);
        expect(unavailable.parked).toBe(true);
        const parked = (yield* readGitHubRepositoryCheckpoint(config, 'github', '7', 0))!;
        expect(parked.page).toBe(2);
        expect(parked.phase).toBe('comments');
        expect(parked.numbers).toEqual([101, 102, 103]);
        const retained = [...unavailable.unresolvedNumbers!.map(item => item.number), ...parked.numbers!];
        expect(new Set(retained)).toEqual(new Set(Array.from({length: 103}, (_, i) => i + 1)));
      }).pipe(provide),
    {timeout: 120000},
  );
  effectIt.effect.prop(
    'roundtrips bounded parked checkpoints, preserves legacy cursors and removes completed checkpoints',
    {
      page: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 5})),
      count: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 10})),
      revalidating: Schema.Boolean,
    },
    ({page, count, revalidating}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* setup(yield* fs.makeTempDirectoryScoped());
        const legacy: GitHubSyncState = {
          version: 1,
          fingerprint: 'a'.repeat(64),
          accessEpoch: (yield* readExternalSourceReceipt(location(config), 'github', 'github'))!.accessEpoch,
          repositoryIndex: 0,
          phase: 'comments',
          page,
          offset: 0,
          items: [],
          hasMore: true,
          boundary: 100,
          incomplete: false,
          ...(revalidating ? {revalidatingRepositoryId: '7'} : {}),
        };
        const parked: GitHubSyncState = {
          ...legacy,
          numbers: Array.from({length: count}, (_, i) => i + 1),
          incomplete: true,
          ...(revalidating ? {revalidatingRepositoryId: '7', revalidatingRepositoryGeneration: 'b'.repeat(64)} : {}),
        };
        const before = structuredClone(parked);
        yield* writeGitHubSyncState(config, 'github', legacy, Effect.void);
        yield* writeGitHubRepositoryCheckpoint(config, 'github', '7', parked, Effect.void);
        expect(yield* readGitHubRepositoryCheckpoint(config, 'github', '7', 0)).toEqual(before);
        expect(yield* readGitHubSyncState(config, 'github')).toEqual(legacy);
        expect(parked).toEqual(before);
        yield* clearGitHubRepositoryCheckpoint(config, 'github', '7', 0, Effect.void);
        expect(yield* readGitHubRepositoryCheckpoint(config, 'github', '7', 0)).toBeUndefined();
      }).pipe(provide),
    {arbitrary: {runs: 5, seed: 92}},
  );
  effectIt.effect(
    'rejects mismatched or malformed parked access before provider calls and removes parked files on disconnect',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* setup(yield* fs.makeTempDirectoryScoped());
        yield* runGitHubSourceSync(config, {
          id: 'github',
          apply: true,
          clientOptions: {fetch: fixtureFetch([1]), maxRequests: 3},
        });
        const saved = (yield* readGitHubRepositoryCheckpoint(config, 'github', '7', 0))!;
        expect(saved.items.map(item => item.number)).toEqual([1]);
        const filename = `${config.agentContextHome}/data/local/resources/external/github/github/.checkpoints/r-7-0.json`;
        for (const invalid of [
          {...saved, accessEpoch: 'f'.repeat(64)},
          {...saved, numbers: Array.from({length: 101}, (_, i) => i + 1)},
          {...saved, revalidatingRepositoryGeneration: 'b'.repeat(64)},
          {...saved, revalidatingRepositoryId: '7', revalidatingRepositoryGeneration: 'invalid'},
        ]) {
          yield* fs.writeFileString(filename, JSON.stringify(invalid));
          let calls = 0;
          const result = yield* runGitHubSourceSync(config, {
            id: 'github',
            apply: true,
            clientOptions: {
              fetch: async () => {
                calls++;
                return json({});
              },
            },
          }).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          expect(calls).toBe(0);
        }
        yield* writeGitHubRepositoryCheckpoint(config, 'github', '7', saved, Effect.void);
        yield* runGitHubSourceRemove(config, {id: 'github', apply: true});
        expect(yield* fs.exists(filename)).toBe(false);
      }).pipe(provide),
  );
  effectIt.effect(
    'eventually publishes each selected repository when the foreground request budget is smaller than the selection',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const names = Array.from({length: 17}, (_, i) => `owner/repo-${i}`);
        const config = yield* setup(yield* fs.makeTempDirectoryScoped(), 'github', names);
        const fetch = async (url: URL) => {
          const metadata = /^\/repos\/owner\/repo-(\d+)$/.exec(url.pathname);
          if (metadata) {
            const index = Number(metadata[1]);
            return json({id: 100 + index, full_name: names[index], private: false});
          }
          const repository = /^\/repositories\/(\d+)(.*)$/.exec(url.pathname)!;
          const index = Number(repository[1]) - 100;
          const item = {...restItem(1), html_url: `https://github.com/${names[index]}/issues/1`};
          return json(repository[2] === '/issues' ? [item] : repository[2] === '/issues/1' ? item : []);
        };
        let done = false;
        for (let run = 0; run < 30; run++) {
          const budget = makeGitHubClientBudget(20000, 16);
          const result = yield* runGitHubSourceSync(config, {
            id: 'github',
            apply: true,
            clientOptions: {fetch, maxRequests: 16, budget},
          });
          expect(budget.requests).toBeLessThanOrEqual(16);
          if (!result.progress) {
            done = true;
            break;
          }
        }
        expect(done).toBe(true);
        expect(
          (yield* runGitHubSourceInventory(config, 'github')).entries.filter(entry => entry.status === 'active'),
        ).toHaveLength(names.length);
      }).pipe(provide),
    {timeout: 120000},
  );
  effectIt.effect(
    'invalidates prior guarded recovery when a repeated denial crashes after its authorization receipt write',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ResourceStore;
        for (const legacy of [false, true]) {
          const config = yield* setup(yield* fs.makeTempDirectoryScoped(), 'github', ['owner/repo', 'zowner/healthy']);
          let mode: 'baseline' | 'denied' | 'recovering' | 'unavailable' | 'fresh' = 'baseline';
          let unavailableReads = 0;
          let freshReads = 0;
          const pullUri = externalResourceUri({
            provider: 'github',
            sourceId: 'github',
            documentId: 'r-7-pull-11',
            pageId: 'description',
            chunkId: 'part-0',
          });
          const fetch = async (url: URL) => {
            const pathname = namePath(url);
            if (pathname === '/repos/owner/repo') return mode === 'denied' ? json({}, 403) : selectedFetch(url);
            if (pathname.startsWith('/repos/zowner/healthy')) return selectedFetch(url);
            if (pathname === '/repos/owner/repo/issues') return json([restItem(1, true), restItem(2, true)]);
            if (pathname === '/repos/owner/repo/issues/1') {
              if (mode === 'unavailable') {
                unavailableReads++;
                return json({}, 404);
              }
              if (mode === 'fresh') {
                freshReads++;
                return json({...restItem(1, true), body: 'Fresh restored snapshot'});
              }
              return json(restItem(1, true));
            }
            if (pathname === '/repos/owner/repo/issues/2') return json(restItem(2, true));
            if (/^\/repos\/owner\/repo\/pulls\/[12]$/.test(pathname)) {
              const number = Number(pathname.split('/').at(-1));
              return mode === 'recovering' && number === 2
                ? json({}, 403)
                : json({number, html_url: `https://github.com/owner/repo/pull/${number}`, merged: false, draft: false});
            }
            if (pathname === '/graphql')
              return json({
                data: {
                  repository: {
                    databaseId: 7,
                    pullRequest: {
                      reviewThreads: {nodes: [], totalCount: 0, pageInfo: {hasNextPage: false, endCursor: null}},
                    },
                  },
                },
              });
            return json([]);
          };
          const boundary = Date.parse(timestamp) + 3600000;
          yield* TestClock.setTime(boundary);
          yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch}});
          mode = 'denied';
          yield* TestClock.setTime(boundary + 180000);
          yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch}});
          if (legacy) {
            const receipt = (yield* readExternalSourceReceipt(location(config), 'github', 'github'))!;
            const {repositoryDenialGenerations: _generation, ...oldReceipt} = receipt;
            yield* store.write(
              location(config),
              externalSourceReceiptUri('github', 'github'),
              serializeExternalSourceReceipt(oldReceipt),
              {mode: 'replace'},
            );
            const oldCheckpoint = (yield* readGitHubSyncState(config, 'github'))!;
            yield* writeGitHubSyncState(
              config,
              'github',
              {...oldCheckpoint, revalidatingRepositoryId: '7', revalidatingRepositoryGeneration: undefined},
              Effect.void,
            );
          }
          mode = 'recovering';
          let firstPublished = false;
          let repeatedDenialPersisted = false;
          const interruptedStore: typeof store = {
            ...store,
            mutateChecked: (where, mutations, check) => {
              if (repeatedDenialPersisted && mutations.some(m => m.type === 'write' && m.uri.endsWith('/.sync.json')))
                return Effect.die('Synthetic crash after repeated denial receipt');
              return store.mutateChecked(where, mutations, check).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (
                      mutations.some(
                        m =>
                          m.type === 'write' &&
                          m.uri.endsWith('/r-7-pull-11/.manifest.json') &&
                          m.content.includes('"status":"active"'),
                      )
                    )
                      firstPublished = true;
                    if (
                      firstPublished &&
                      mutations.some(
                        m =>
                          m.type === 'write' &&
                          m.uri.endsWith('/.access.json') &&
                          JSON.parse(m.content).deniedRepositoryIds?.includes('7'),
                      )
                    )
                      repeatedDenialPersisted = true;
                  }),
                ),
              );
            },
          };
          const interrupted = yield* runGitHubSourceSync(config, {
            id: 'github',
            apply: true,
            clientOptions: {fetch},
          }).pipe(Effect.provideService(ResourceStore, interruptedStore), Effect.exit);
          expect(interrupted._tag).toBe('Failure');
          expect(firstPublished && repeatedDenialPersisted).toBe(true);
          const retained = (yield* readGitHubSyncState(config, 'github'))!;
          expect(retained.revalidatingRepositoryId).toBe('7');
          expect(retained.offset).toBe(1);
          expect(
            (yield* readExternalDocumentManifest(location(config), 'github', 'r-7-pull-11', 'github'))?.status,
          ).toBe('active');
          expect(
            (yield* listGitHubIdMarkers(config, 'github'))?.find(marker => marker.documentId === 'r-7-pull-11')
              ?.observedBoundary,
          ).toBe(retained.boundary);
          const latest = (yield* readExternalSourceReceipt(location(config), 'github', 'github'))!;
          expect(latest.deniedRepositoryIds).toContain('7');
          mode = 'unavailable';
          yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch}});
          expect(Result.isFailure(yield* store.read(location(config), pullUri).pipe(Effect.result))).toBe(true);
          expect(Result.isFailure(yield* store.readBounded(location(config), pullUri, 64).pipe(Effect.result))).toBe(
            true,
          );
          expect(Object.keys(yield* loadExternalResourceAccess(location(config)))).not.toContain(pullUri);
          expect(unavailableReads).toBeGreaterThan(0);
          expect(latest.repositoryDenialGenerations?.['7']).not.toBe(retained.revalidatingRepositoryGeneration);
          expect(yield* store.read(location(config), healthyUri)).toContain('Body 3');
          yield* TestClock.setTime(boundary + 360000);
          mode = 'fresh';
          yield* runGitHubSourceSync(config, {id: 'github', apply: true, clientOptions: {fetch}});
          expect(freshReads).toBeGreaterThanOrEqual(2);
          expect(yield* store.read(location(config), pullUri)).toContain('Fresh restored snapshot');
          expect(Object.keys(yield* loadExternalResourceAccess(location(config)))).toContain(pullUri);
        }
      }).pipe(provide),
    {timeout: 120000},
  );
});
