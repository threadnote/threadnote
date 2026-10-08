import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Redacted, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {afterAll, beforeAll, describe, expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {
  externalDocumentManifestUri,
  externalResourceUri,
  readExternalDocumentManifest,
  renderExternalResource,
  serializeExternalDocumentManifest,
} from '@threadnote/store/external-resource';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {loadRecallIndexData} from '@threadnote/recall/index';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  obsidianConfigurationPath,
  mutateSourceConfiguration,
  readSourceConfiguration,
  renderSourceConfiguration,
  upsertSuperhumanSource,
  requireSuperhumanSource,
  sourceConfigurationFingerprint,
} from '../../config.js';
import {resolveSuperhumanCredential, superhumanCredentialConfigured} from '../credentials.js';
import {
  runSuperhumanSourceAdd,
  runSuperhumanSourceRemove,
  runSuperhumanSourceSync,
  syncSuperhumanSourcesBeforeRecall,
} from '../source.js';
import {superhumanExternalSourcePolicyLayer} from '../access-policy.js';

const dependencies = Layer.mergeAll(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'superhuman-source-sync.test.ts'}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: environment => ({...environment}),
          sanitizeExternal: environment => ({...environment}),
        }),
      ),
    ),
  ),
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const accessDependencies = Layer.merge(
  dependencies,
  superhumanExternalSourcePolicyLayer.pipe(Layer.provide(dependencies)),
);
const testLayer = Layer.merge(accessDependencies, ResourceStore.layer.pipe(Layer.provide(accessDependencies)));
const provideLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(testLayer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const page = {
  id: 'page_one',
  type: 'page',
  name: 'Safe Notes',
  isHidden: false,
  isEffectivelyHidden: false,
  contentType: 'canvas',
  updatedAt: '2026-10-08T10:00:00Z',
};
const safeFetch = async (url: URL) => {
  if (url.pathname.endsWith('/content'))
    return response({
      items: [
        {id: 'line_one', type: 'line', itemContent: {style: 'p', format: 'plainText', content: 'needle evidence'}},
      ],
    });
  if (url.pathname.endsWith('/pages/page_one')) return response(page);
  return response({items: [page]});
};
const interruption = (uri: string) =>
  ResourceIoFailed.make({cause: undefined, message: 'Synthetic cleanup failure.', operation: 'remove', uri});

let oldCredential: string | undefined;
beforeAll(() => {
  oldCredential = process.env.SUPERHUMAN_DOCS_TEST_TOKEN;
  process.env.SUPERHUMAN_DOCS_TEST_TOKEN = 'synthetic-token';
});
afterAll(() => {
  if (oldCredential === undefined) delete process.env.SUPERHUMAN_DOCS_TEST_TOKEN;
  else process.env.SUPERHUMAN_DOCS_TEST_TOKEN = oldCredential;
});

describe('Superhuman source sync', () => {
  effectIt.effect('checks Manager create and edit preconditions before changing credentials or scope', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-source-preconditions-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      const base = {id: 'concurrent', project: 'test', apply: true};
      const attempts = [0, 1].map(index => ({
        ...base,
        documents: [`doc_${index}`],
        apiToken: Redacted.make(`synthetic-concurrent-${index}`),
        expectedFingerprint: null,
      }));
      const results = yield* Effect.forEach(
        attempts,
        options => runSuperhumanSourceAdd(config, options).pipe(Effect.result),
        {
          concurrency: 2,
        },
      );
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      expect(results.filter(Result.isFailure)).toHaveLength(1);
      const winner = results.findIndex(Result.isSuccess);
      const source = requireSuperhumanSource(yield* readSourceConfiguration(config), base.id);
      expect(source.documents).toEqual([{id: `doc_${winner}`}]);
      expect(Redacted.value(yield* resolveSuperhumanCredential(config, source))).toBe(`synthetic-concurrent-${winner}`);
      const expectedFingerprint = sourceConfigurationFingerprint(source);
      yield* mutateSourceConfiguration(config, current => upsertSuperhumanSource(current, {...source, enabled: false}));
      const staleEdit = yield* runSuperhumanSourceAdd(config, {
        ...base,
        documents: ['replacement'],
        apiToken: Redacted.make('synthetic-stale-edit-token'),
        enabled: true,
        expectedFingerprint,
      }).pipe(Effect.result);
      expect(Result.isFailure(staleEdit)).toBe(true);
      expect(requireSuperhumanSource(yield* readSourceConfiguration(config), base.id)).toEqual({
        ...source,
        enabled: false,
      });
      expect(Redacted.value(yield* resolveSuperhumanCredential(config, source))).toBe(`synthetic-concurrent-${winner}`);
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect(
    'cleans an orphaned credential after interrupted source creation when retried with environment mode',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-source-credential-orphan-'});
        const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
        const token = 'synthetic-interrupted-creation-token';
        const options = {id: 'orphan', documents: ['doc_one'], project: 'test', apply: true};
        const interrupted = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            to.endsWith('/sources.yaml') ? fs.rename(`${home}/missing-configuration`, to) : fs.rename(from, to),
        });
        const failure = yield* runSuperhumanSourceAdd(config, {...options, apiToken: Redacted.make(token)}).pipe(
          Effect.provideService(FileSystem.FileSystem, interrupted),
          Effect.result,
        );
        expect(Result.isFailure(failure)).toBe(true);
        expect(JSON.stringify(failure)).not.toContain(token);
        const tokenFile = `${home}/threadnote/credentials/superhuman/orphan`;
        expect(yield* fs.exists(tokenFile)).toBe(true);
        expect((yield* readSourceConfiguration(config)).sources).toEqual([]);
        yield* runSuperhumanSourceAdd(config, {...options, credentialEnv: 'SUPERHUMAN_DOCS_TEST_TOKEN'});
        expect(yield* fs.exists(tokenFile)).toBe(false);
        expect(
          requireSuperhumanSource(yield* readSourceConfiguration(config), options.id).credentialStorage,
        ).toBeUndefined();
      }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('stores only a local credential reference, preserves selections on edits, and removes on apply', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-source-credential-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      const token = 'synthetic-manager-token';
      const options = {
        id: 'managed',
        documents: ['doc_one', 'doc_two'],
        documentSelection: [{id: 'doc_one', pages: ['page_one']}, {id: 'doc_two'}],
        project: 'test',
        apiToken: Redacted.make(token),
      };
      yield* runSuperhumanSourceAdd(config, options);
      expect(yield* fs.exists(`${home}/threadnote/credentials/superhuman/managed`)).toBe(false);
      yield* runSuperhumanSourceAdd(config, {...options, apply: true});
      let source = requireSuperhumanSource(yield* readSourceConfiguration(config), options.id);
      expect(source.credentialStorage).toBe('local');
      expect(source.documents).toEqual(options.documentSelection);
      const yaml = yield* fs.readFileString(yield* obsidianConfigurationPath(config));
      expect(yaml).toContain('credential_storage: local');
      expect(yaml).not.toContain(token);
      yield* runSuperhumanSourceSync(config, {
        id: options.id,
        apply: true,
        clientOptions: {
          fetch: async (url, init) => {
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            return safeFetch(url);
          },
        },
      });
      yield* runSuperhumanSourceAdd(config, {...options, apiToken: undefined, enabled: false, apply: true});
      source = requireSuperhumanSource(yield* readSourceConfiguration(config), options.id);
      expect(source.enabled).toBe(false);
      expect(Redacted.value(yield* resolveSuperhumanCredential(config, source))).toBe(token);
      yield* runSuperhumanSourceRemove(config, {id: options.id});
      expect(yield* superhumanCredentialConfigured(config, source)).toBe(true);
      yield* runSuperhumanSourceRemove(config, {id: options.id, apply: true});
      expect(yield* fs.exists(`${home}/threadnote/credentials/superhuman/managed`)).toBe(false);
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('denies cached resources before token rotation can fail and repairs on explicit retry', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-source-rotate-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      const options = {
        id: 'rotate',
        documents: ['doc_one'],
        project: 'test',
        apply: true,
        apiToken: Redacted.make('synthetic-original-token'),
      };
      yield* runSuperhumanSourceAdd(config, options);
      yield* runSuperhumanSourceSync(config, {id: options.id, apply: true, clientOptions: {fetch: safeFetch}});
      const uri = externalResourceUri({
        sourceId: options.id,
        documentId: 'doc_one',
        pageId: 'page_one',
        chunkId: `b-${sha256HexSync('line_one').slice(0, 24)}-0`,
      });
      const store = yield* ResourceStore;
      expect(yield* store.read({home, account: 'local', user: 'tester'}, uri)).toContain('needle');
      const credentials = `${home}/threadnote/credentials/superhuman`;
      yield* fs.chmod(credentials, 0o755);
      const rotation = yield* runSuperhumanSourceAdd(config, {
        ...options,
        apiToken: Redacted.make('synthetic-rotated-token'),
      }).pipe(Effect.result);
      expect(Result.isFailure(rotation)).toBe(true);
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
      expect((yield* syncSuperhumanSourcesBeforeRecall(config, {fetch: safeFetch})).syncedSources).toEqual([]);
      yield* fs.chmod(credentials, 0o700);
      yield* runSuperhumanSourceAdd(config, {...options, apiToken: Redacted.make('synthetic-rotated-token')});
      yield* runSuperhumanSourceSync(config, {id: options.id, apply: true, clientOptions: {fetch: safeFetch}});
      expect(yield* store.read({home, account: 'local', user: 'tester'}, uri)).toContain('needle');
      yield* runSuperhumanSourceAdd(config, {
        ...options,
        apiToken: undefined,
        credentialStorage: undefined,
        credentialEnv: 'SUPERHUMAN_DOCS_TEST_TOKEN',
      });
      expect(yield* fs.exists(`${credentials}/rotate`)).toBe(false);
      expect(
        requireSuperhumanSource(yield* readSourceConfiguration(config), options.id).credentialStorage,
      ).toBeUndefined();
      yield* runSuperhumanSourceSync(config, {id: options.id, apply: true, clientOptions: {fetch: safeFetch}});
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('rejects reflected tokens and inconsistent document selections before persistence', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-source-reflection-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      const token = 'synthetic_private';
      const options = {
        id: 'managed',
        documents: ['doc_one'],
        project: 'test',
        apply: true,
        apiToken: Redacted.make(token),
      };
      for (const reflection of [
        {id: token},
        {project: token},
        {documents: [token]},
        {documentSelection: [{id: 'doc_one', pages: [token]}]},
      ]) {
        const rejected = yield* runSuperhumanSourceAdd(config, {...options, ...reflection}).pipe(Effect.result);
        expect(Result.isFailure(rejected)).toBe(true);
        expect(JSON.stringify(rejected)).not.toContain(token);
      }
      expect(
        Result.isFailure(
          yield* runSuperhumanSourceAdd(config, {...options, documentSelection: [{id: 'doc_two'}]}).pipe(Effect.result),
        ),
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* runSuperhumanSourceAdd(config, {...options, apiToken: undefined, credentialStorage: 'local'}).pipe(
            Effect.result,
          ),
        ),
      ).toBe(true);
      expect((yield* readSourceConfiguration(config)).sources).toEqual([]);
      expect(yield* fs.exists(`${home}/threadnote/credentials`)).toBe(false);
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('keeps an interrupted credential removal disabled until explicit cleanup retry', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-source-credential-remove-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runSuperhumanSourceAdd(config, {
        id: 'managed',
        documents: ['doc_one'],
        project: 'test',
        apply: true,
        apiToken: Redacted.make('synthetic-local-token'),
      });
      yield* runSuperhumanSourceSync(config, {id: 'managed', apply: true, clientOptions: {fetch: safeFetch}});
      const tokenFile = `${home}/threadnote/credentials/superhuman/managed`;
      yield* fs.chmod(tokenFile, 0o644);
      const removed = yield* runSuperhumanSourceRemove(config, {id: 'managed', apply: true}).pipe(Effect.result);
      expect(Result.isFailure(removed)).toBe(true);
      expect(requireSuperhumanSource(yield* readSourceConfiguration(config), 'managed').enabled).toBe(false);
      expect((yield* loadRecallIndexData(config, {includeInactive: false, query: 'needle'})).candidates).toEqual([]);
      expect((yield* syncSuperhumanSourcesBeforeRecall(config, {fetch: safeFetch})).syncedSources).toEqual([]);
      expect(yield* fs.exists(tokenFile)).toBe(true);
      yield* fs.chmod(tokenFile, 0o600);
      yield* runSuperhumanSourceRemove(config, {id: 'managed', apply: true});
      expect(yield* fs.exists(tokenFile)).toBe(false);
      expect((yield* readSourceConfiguration(config)).sources).toEqual([]);
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('denies the entire source before an authentication purge can fail', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-source-denial-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      const location = {home, account: 'local', user: 'tester'};
      yield* runSuperhumanSourceAdd(config, {
        id: 'multi',
        apply: true,
        documents: ['doc_one', 'doc_two'],
        credentialEnv: 'SUPERHUMAN_DOCS_TEST_TOKEN',
        project: 'test',
      });
      yield* runSuperhumanSourceSync(config, {id: 'multi', apply: true, clientOptions: {fetch: safeFetch}});
      const uris = ['doc_one', 'doc_two'].map(documentId =>
        externalResourceUri({
          sourceId: 'multi',
          documentId,
          pageId: 'page_one',
          chunkId: `b-${sha256HexSync('line_one').slice(0, 24)}-0`,
        }),
      );
      expect((yield* loadRecallIndexData(config, {includeInactive: false, query: 'needle'})).candidates).toHaveLength(
        2,
      );
      const store = yield* ResourceStore;
      const interruptedStore = ResourceStore.of({
        ...store,
        mutateChecked: (target, mutations, check) =>
          mutations.some(mutation => mutation.type === 'remove' && mutation.uri.endsWith('.md'))
            ? Effect.fail(interruption(uris[0]))
            : store.mutateChecked(target, mutations, check),
      });
      const failed = yield* runSuperhumanSourceSync(config, {
        id: 'multi',
        apply: true,
        clientOptions: {fetch: async () => response({}, 401)},
      }).pipe(Effect.provideService(ResourceStore, interruptedStore), Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      for (const uri of uris) expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
      expect(
        (yield* loadRecallIndexData(config, {
          includeInactive: false,
          query: 'needle',
          requiredUris: uris,
          eligibility: {kind: 'pinned-hard-uri-bypass'},
        })).candidates,
      ).toEqual([]);
      yield* runSuperhumanSourceSync(config, {
        id: 'multi',
        apply: true,
        clientOptions: {
          fetch: url => (url.pathname.includes('/doc_two/') ? Promise.resolve(response({}, 403)) : safeFetch(url)),
        },
      });
      expect(Result.isSuccess(yield* store.read(location, uris[0]).pipe(Effect.result))).toBe(true);
      expect(Result.isFailure(yield* store.read(location, uris[1]).pipe(Effect.result))).toBe(true);
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('keeps pending receipts bounded through near-limit turnover and interrupted publication', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-rollover-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      const location = {home, account: 'local', user: 'tester'};
      yield* runSuperhumanSourceAdd(config, {
        id: 'rollover',
        apply: true,
        documents: ['doc_one'],
        credentialEnv: 'SUPERHUMAN_DOCS_TEST_TOKEN',
        project: 'test',
      });
      yield* runSuperhumanSourceSync(config, {id: 'rollover', apply: true, clientOptions: {fetch: safeFetch}});
      const active = (yield* readExternalDocumentManifest(location, 'rollover', 'doc_one'))!;
      const oldUri = Object.keys(active.chunks)[0];
      const store = yield* ResourceStore;
      yield* store.write(
        location,
        externalDocumentManifestUri('rollover', 'doc_one'),
        serializeExternalDocumentManifest({
          ...active,
          chunks: {
            ...active.chunks,
            ...Object.fromEntries(
              Array.from({length: 2047}, (_, i) => [
                externalResourceUri({
                  sourceId: 'rollover',
                  documentId: 'doc_one',
                  pageId: 'page_one',
                  chunkId: `missing-${i}`,
                }),
                'a'.repeat(64),
              ]),
            ),
          },
        }),
        {mode: 'upsert'},
      );
      const replacementFetch = (ids: string[]) => async (url: URL) =>
        url.pathname.endsWith('/content')
          ? response({
              items: ids.map(id => ({id, type: 'line', itemContent: {style: 'p', format: 'plainText', content: id}})),
            })
          : safeFetch(url);
      const interruptedStore = ResourceStore.of({
        ...store,
        mutateChecked: (target, mutations, check) =>
          mutations.some(mutation => mutation.type === 'write' && mutation.uri.endsWith('.md'))
            ? store
                .mutateChecked(target, mutations.slice(0, 1), check)
                .pipe(Effect.andThen(Effect.fail(interruption(oldUri))))
            : store.mutateChecked(target, mutations, check),
      });
      const result = yield* runSuperhumanSourceSync(config, {
        id: 'rollover',
        apply: true,
        clientOptions: {fetch: replacementFetch(['new_one', 'new_two'])},
      }).pipe(Effect.provideService(ResourceStore, interruptedStore), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      const pending = yield* readExternalDocumentManifest(location, 'rollover', 'doc_one');
      expect(pending?.status).toBe('pending');
      expect(Object.keys(pending?.chunks ?? {})).toHaveLength(2);
      expect(yield* fs.exists(`${home}/data/local/resources/${oldUri.slice('threadnote://resources/'.length)}`)).toBe(
        false,
      );
      for (const uri of Object.keys(pending!.chunks))
        expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
      yield* runSuperhumanSourceSync(config, {
        id: 'rollover',
        apply: true,
        clientOptions: {fetch: replacementFetch(['final_line'])},
      });
      const recovered = yield* readExternalDocumentManifest(location, 'rollover', 'doc_one');
      expect(recovered?.status).toBe('active');
      expect(Object.keys(recovered?.chunks ?? {})).toHaveLength(1);
      for (const uri of Object.keys(pending!.chunks))
        expect(yield* fs.exists(`${home}/data/local/resources/${uri.slice('threadnote://resources/'.length)}`)).toBe(
          false,
        );
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('persists outage backoff for missing and active caches without resetting freshness', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const populated of [false, true]) {
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-outage-'});
        const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
        const location = {home, account: 'local', user: 'tester'};
        yield* runSuperhumanSourceAdd(config, {
          id: 'outage',
          apply: true,
          documents: ['doc_one'],
          credentialEnv: 'SUPERHUMAN_DOCS_TEST_TOKEN',
          project: 'test',
        });
        if (populated)
          yield* runSuperhumanSourceSync(config, {id: 'outage', apply: true, clientOptions: {fetch: safeFetch}});
        const before = yield* readExternalDocumentManifest(location, 'outage', 'doc_one');
        yield* TestClock.adjust(15 * 60_000);
        let calls = 0;
        const fetch = async () => {
          calls++;
          return response({}, 503);
        };
        yield* syncSuperhumanSourcesBeforeRecall(config, {fetch});
        const receipt = yield* readExternalDocumentManifest(location, 'outage', 'doc_one');
        expect(calls).toBe(1);
        expect(receipt?.status).toBe(populated ? 'active' : 'quarantined');
        expect(receipt?.nextAttemptAt).toBeGreaterThan(yield* Clock.currentTimeMillis);
        if (before) {
          expect(receipt?.fetchedAt).toBe(before.fetchedAt);
          const store = yield* ResourceStore;
          expect(Result.isSuccess(yield* store.read(location, Object.keys(before.chunks)[0]).pipe(Effect.result))).toBe(
            true,
          );
        }
        yield* syncSuperhumanSourcesBeforeRecall(config, {fetch});
        expect(calls).toBe(1);
        yield* TestClock.adjust(receipt!.nextAttemptAt! - (yield* Clock.currentTimeMillis));
        yield* syncSuperhumanSourcesBeforeRecall(config, {fetch});
        expect(calls).toBe(2);
      }
    }).pipe(provideLayer),
  );

  effectIt.effect('removes an already disabled source and keeps interrupted removal out of automatic refresh', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const enabled of [true, false]) {
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-remove-'});
        const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
        yield* runSuperhumanSourceAdd(config, {
          id: 'remove',
          apply: true,
          documents: ['doc_one'],
          credentialEnv: 'SUPERHUMAN_DOCS_TEST_TOKEN',
          project: 'test',
        });
        yield* runSuperhumanSourceSync(config, {id: 'remove', apply: true, clientOptions: {fetch: safeFetch}});
        if (!enabled)
          yield* mutateSourceConfiguration(config, current => ({
            projections: current.projections,
            version: 2,
            sources: current.sources.map(source => ({...source, enabled: false})),
          }));
        const store = yield* ResourceStore;
        const interruptedStore = ResourceStore.of({
          ...store,
          mutateChecked: (target, mutations, check) =>
            mutations.some(mutation => mutation.type === 'remove')
              ? Effect.fail(interruption(mutations[0].uri))
              : store.mutateChecked(target, mutations, check),
        });
        expect(
          Result.isFailure(
            yield* runSuperhumanSourceRemove(config, {id: 'remove', apply: true}).pipe(
              Effect.provideService(ResourceStore, interruptedStore),
              Effect.result,
            ),
          ),
        ).toBe(true);
        expect((yield* readSourceConfiguration(config)).sources[0]?.enabled).toBe(false);
        let calls = 0;
        yield* syncSuperhumanSourcesBeforeRecall(config, {
          fetch: async () => {
            calls++;
            return response({items: []});
          },
        });
        expect(calls).toBe(0);
        yield* runSuperhumanSourceRemove(config, {id: 'remove', apply: true});
        expect((yield* readSourceConfiguration(config)).sources).toEqual([]);
        expect(yield* fs.exists(`${home}/data/local/resources/external/superhuman/remove`)).toBe(false);
      }
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('keeps interrupted reconfiguration denied until an explicit cleanup retry', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-reconfigure-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      const options = {
        id: 'reconfigure',
        apply: true,
        documents: ['doc_one'],
        credentialEnv: 'SUPERHUMAN_DOCS_TEST_TOKEN',
        project: 'test',
      };
      yield* runSuperhumanSourceAdd(config, options);
      yield* runSuperhumanSourceSync(config, {id: options.id, apply: true, clientOptions: {fetch: safeFetch}});
      const store = yield* ResourceStore;
      const interruptedStore = ResourceStore.of({
        ...store,
        mutateChecked: (target, mutations, check) =>
          mutations.some(mutation => mutation.type === 'remove')
            ? Effect.fail(interruption(mutations[0].uri))
            : store.mutateChecked(target, mutations, check),
      });
      expect(
        Result.isFailure(
          yield* runSuperhumanSourceAdd(config, {...options, project: 'changed'}).pipe(
            Effect.provideService(ResourceStore, interruptedStore),
            Effect.result,
          ),
        ),
      ).toBe(true);
      let calls = 0;
      yield* syncSuperhumanSourcesBeforeRecall(config, {
        fetch: async () => {
          calls++;
          return response({items: []});
        },
      });
      expect(calls).toBe(0);
      yield* runSuperhumanSourceAdd(config, {...options, project: 'changed'});
      yield* runSuperhumanSourceSync(config, {id: options.id, apply: true, clientOptions: {fetch: safeFetch}});
      const manifest = yield* readExternalDocumentManifest(
        {home, account: 'local', user: 'tester'},
        options.id,
        'doc_one',
      );
      expect(manifest?.status).toBe('active');
      expect(
        (yield* loadRecallIndexData(config, {includeInactive: false, query: 'needle'})).candidates[0]?.fields?.project,
      ).toBe('changed');
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('backs off a missing credential without attempting HTTP', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-missing-credential-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runSuperhumanSourceAdd(config, {
        id: 'missing-credential',
        apply: true,
        documents: ['doc_one'],
        credentialEnv: 'SUPERHUMAN_SYNTHETIC_MISSING_CREDENTIAL_TEST',
        project: 'test',
      });
      let calls = 0;
      const fetch = async () => {
        calls++;
        return response({items: []});
      };
      yield* syncSuperhumanSourcesBeforeRecall(config, {fetch});
      const receipt = yield* readExternalDocumentManifest(
        {home, account: 'local', user: 'tester'},
        'missing-credential',
        'doc_one',
      );
      expect(receipt?.status).toBe('quarantined');
      expect(receipt?.nextAttemptAt).toBeGreaterThan(yield* Clock.currentTimeMillis);
      yield* syncSuperhumanSourcesBeforeRecall(config, {fetch});
      expect(calls).toBe(0);
    }).pipe(provideLayer),
  );
  effectIt.effect('activates a complete snapshot, then quarantines it on access denial', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-sync-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runSuperhumanSourceAdd(config, {
        id: 'test',
        apply: true,
        documents: ['doc_one'],
        credentialEnv: 'SUPERHUMAN_DOCS_TEST_TOKEN',
        project: 'test',
      });
      const fetch = async (url: URL) => {
        if (url.pathname.endsWith('/content'))
          return response({
            items: [
              {id: 'line_one', type: 'line', itemContent: {style: 'p', format: 'plainText', content: 'safe text'}},
            ],
          });
        if (url.pathname.endsWith('/pages/page_one')) return response(page);
        return response({items: [page]});
      };
      const first = yield* runSuperhumanSourceSync(config, {id: 'test', apply: true, clientOptions: {fetch}});
      expect(first.syncedDocuments).toEqual(['doc_one']);
      const location = {home, account: 'local', user: 'tester'};
      const active = yield* readExternalDocumentManifest(location, 'test', 'doc_one');
      expect(active?.status).toBe('active');
      expect(Object.keys(active?.chunks ?? {})).toHaveLength(1);
      const store = yield* ResourceStore;
      const orphanUri = externalResourceUri({
        sourceId: 'test',
        documentId: 'doc_one',
        pageId: 'page_one',
        chunkId: 'old',
      });
      const orphan = renderExternalResource(
        {
          version: 1,
          sourceId: 'test',
          documentId: 'doc_one',
          pageId: 'page_one',
          chunkId: 'old',
          project: 'test',
          title: 'Old',
          rendererVersion: 'v1',
          scrubberVersion: 'v1',
          coverage: 'canvas-plain-text',
        },
        'old text',
      );
      yield* store.write(location, orphanUri, orphan, {mode: 'create'});
      yield* store.write(
        location,
        externalDocumentManifestUri('test', 'doc_one'),
        serializeExternalDocumentManifest({
          ...active!,
          status: 'pending',
          chunks: {...active!.chunks, [orphanUri]: sha256HexSync(orphan)},
        }),
        {mode: 'upsert'},
      );
      yield* runSuperhumanSourceSync(config, {id: 'test', apply: true, clientOptions: {fetch}});
      expect((yield* readExternalDocumentManifest(location, 'test', 'doc_one'))?.status).toBe('active');
      expect(
        yield* fs.exists(`${home}/data/local/resources/external/superhuman/test/docs/doc_one/pages/page_one/old.md`),
      ).toBe(false);
      const temporary = yield* runSuperhumanSourceSync(config, {
        id: 'test',
        apply: true,
        clientOptions: {fetch: async () => response({message: 'temporary'}, 503)},
      });
      expect(temporary.warnings).toEqual(['Superhuman document doc_one: transport-rejected.']);
      expect((yield* readExternalDocumentManifest(location, 'test', 'doc_one'))?.chunks).toEqual(active?.chunks);
      const incomplete = yield* runSuperhumanSourceSync(config, {
        id: 'test',
        apply: true,
        clientOptions: {
          fetch: async url => {
            if (url.pathname.endsWith('/content'))
              return response({
                items: [
                  {id: 'line_one', type: 'line', itemContent: {style: 'p', format: 'plainText', content: 'change'}},
                ],
                nextPageToken: 'repeated',
              });
            if (url.searchParams.has('pageToken')) return response({items: [], nextPageToken: 'repeated'});
            if (url.pathname.endsWith('/pages/page_one')) return response(page);
            return response({items: [page]});
          },
        },
      });
      expect(incomplete.warnings).toEqual(['Superhuman document doc_one: contract-incomplete.']);
      expect((yield* readExternalDocumentManifest(location, 'test', 'doc_one'))?.chunks).toEqual(active?.chunks);
      const denied = yield* runSuperhumanSourceSync(config, {
        id: 'test',
        apply: true,
        clientOptions: {fetch: async () => response({message: 'private'}, 403)},
      });
      expect(denied.warnings).toEqual(['Superhuman document doc_one: access-rejected.']);
      expect((yield* readExternalDocumentManifest(location, 'test', 'doc_one'))?.status).toBe('quarantined');
      yield* runSuperhumanSourceSync(config, {id: 'test', apply: true, clientOptions: {fetch}});
      const reflected = yield* runSuperhumanSourceSync(config, {
        id: 'test',
        apply: true,
        clientOptions: {
          fetch: url =>
            url.pathname.endsWith('/content')
              ? Promise.resolve(
                  response({
                    items: [
                      {
                        id: 'line_one',
                        type: 'line',
                        itemContent: {style: 'p', format: 'plainText', content: 'synthetic-token'},
                      },
                    ],
                  }),
                )
              : fetch(url),
        },
      });
      expect(reflected.warnings).toEqual(['Superhuman document doc_one: credential-reflected.']);
      expect((yield* readExternalDocumentManifest(location, 'test', 'doc_one'))?.status).toBe('quarantined');
      for (const uri of Object.keys(active!.chunks)) {
        expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
        expect(yield* fs.exists(`${home}/data/local/resources/${uri.slice('threadnote://resources/'.length)}`)).toBe(
          false,
        );
      }
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('persists quota retry time and serves no missing snapshot as active', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-quota-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runSuperhumanSourceAdd(config, {
        id: 'quota',
        apply: true,
        documents: ['doc_one'],
        credentialEnv: 'SUPERHUMAN_DOCS_TEST_TOKEN',
        project: 'test',
      });
      let calls = 0;
      const result = yield* runSuperhumanSourceSync(config, {
        id: 'quota',
        apply: true,
        clientOptions: {
          fetch: async () => {
            calls++;
            return response({message: 'rate limit'}, 429);
          },
        },
      });
      expect(result.warnings).toEqual(['Superhuman document doc_one: quota-rejected.']);
      const receipt = yield* readExternalDocumentManifest({home, account: 'local', user: 'tester'}, 'quota', 'doc_one');
      expect(receipt?.status).toBe('quarantined');
      expect(receipt?.nextAttemptAt).toBeGreaterThan(yield* Clock.currentTimeMillis);
      yield* runSuperhumanSourceSync(config, {
        id: 'quota',
        apply: true,
        clientOptions: {
          fetch: async () => {
            calls++;
            return response({items: []});
          },
        },
      });
      expect(calls).toBe(1);
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('rejects publication when source configuration changes during provider fetch', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-fence-'});
      const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
      yield* runSuperhumanSourceAdd(config, {
        id: 'fence',
        apply: true,
        documents: ['doc_one'],
        credentialEnv: 'SUPERHUMAN_DOCS_TEST_TOKEN',
        project: 'test',
      });
      const configPath = yield* obsidianConfigurationPath(config);
      const changedConfiguration = upsertSuperhumanSource(yield* readSourceConfiguration(config), {
        type: 'superhuman',
        id: 'fence',
        enabled: true,
        credentialEnv: 'SUPERHUMAN_DOCS_TEST_TOKEN',
        project: 'changed',
        documents: [{id: 'doc_one'}],
        includeHidden: false,
        refreshIntervalMinutes: 15,
        maxStaleHours: 24,
      });
      const changedBytes = renderSourceConfiguration(changedConfiguration);
      let changed = false;
      const result = yield* runSuperhumanSourceSync(config, {
        id: 'fence',
        apply: true,
        clientOptions: {
          fetch: async url => {
            if (!changed) {
              changed = true;
              await Bun.write(configPath, changedBytes);
            }
            if (url.pathname.endsWith('/content'))
              return response({
                items: [
                  {id: 'line_one', type: 'line', itemContent: {style: 'p', format: 'plainText', content: 'safe text'}},
                ],
              });
            if (url.pathname.endsWith('/pages/page_one')) return response(page);
            return response({items: [page]});
          },
        },
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(
        yield* readExternalDocumentManifest({home, account: 'local', user: 'tester'}, 'fence', 'doc_one'),
      ).toBeUndefined();
    }).pipe(TestClock.withLive, provideLayer),
  );
});
