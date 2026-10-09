import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Redacted, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  externalResourceAccess,
  loadExternalResourceAccess,
  readExternalDocumentManifest,
  readExternalSourceReceipt,
} from '@threadnote/store/external-resource';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  mutateSourceConfiguration,
  readSourceConfiguration,
  requireLinearSource,
  sourceConfigurationFingerprint,
  upsertLinearSource,
} from '../src/config.js';
import {sourceConfigurationPath, makeSourceConfigurationRegistry} from '@threadnote/integration-runtime/config';
import {linearSourceCodec} from '../src/config.js';
import {
  runLinearSourceAdd,
  runLinearSourceRemove,
  runLinearSourceSync,
  runLinearSourceInventory,
  runLinearSourceStatus,
  syncLinearSourcesBeforeRecall,
} from '../src/source.js';
import {resolveLinearCredential, storeLinearCredential} from '../src/credentials.js';
import {linearDocumentId} from '../src/render.js';
import {comment, connection, issue, request, response, safeFetch, source, uuid} from './fixtures.js';
import {provideLayer} from './layer.js';
import {TestConsole} from 'effect/testing';
const configurationRegistry = makeSourceConfigurationRegistry({sources: [linearSourceCodec], projections: []});
const options = {...source, apply: true, apiToken: Redacted.make('synthetic-linear-private-key')};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'linear-source-'}));
  const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
  return {fs, home, config, location: {home, account: 'local', user: 'tester'}};
});
const doc = linearDocumentId(source.organizationId, 'issue', issue.id);
describe('Linear read-only source lifecycle', () => {
  effectIt.effect('protects local credentials and denies all provider cache after disable/remove', () =>
    Effect.gen(function* () {
      const {config, fs, home, location} = yield* fixture;
      yield* runLinearSourceAdd(config, options);
      expect((yield* readSourceConfiguration(config)).sources).toHaveLength(1);
      expect(
        Redacted.value(
          yield* resolveLinearCredential(
            config,
            requireLinearSource(yield* readSourceConfiguration(config), source.id),
          ),
        ),
      ).toBe('synthetic-linear-private-key');
      expect(
        (yield* fs.readFileString(yield* sourceConfigurationPath(config))).includes('synthetic-linear-private-key'),
      ).toBe(false);
      expect((yield* fs.stat(`${home}/threadnote/credentials/linear/${source.id}`)).mode & 0o077).toBe(0);
      const imported = yield* runLinearSourceSync(config, {
        id: source.id,
        apply: true,
        clientOptions: {fetch: safeFetch},
      });
      expect(imported.syncedDocuments).toEqual([doc]);
      const manifest = yield* readExternalDocumentManifest(location, source.id, doc, 'linear');
      expect(manifest?.status).toBe('active');
      const uris = Object.keys(manifest!.chunks);
      expect(uris.length).toBe(2);
      expect(Object.keys(yield* loadExternalResourceAccess(location))).toEqual(uris);
      expect(yield* externalResourceAccess(location, uris[0])).toBe(true);
      expect((yield* runLinearSourceInventory(config, source.id)).entries).toHaveLength(1);
      yield* runLinearSourceStatus(config, source.id);
      expect(yield* TestConsole.logLines).toContain(`Linear source "${source.id}": 1 cached item(s).`);
      const current = requireLinearSource(yield* readSourceConfiguration(config), source.id);
      yield* mutateSourceConfiguration(config, c => upsertLinearSource(c, {...current, enabled: false}));
      expect(Object.keys(yield* loadExternalResourceAccess(location))).toEqual([]);
      expect(Result.isFailure(yield* (yield* ResourceStore).read(location, uris[0]).pipe(Effect.result))).toBe(true);
      yield* runLinearSourceRemove(config, {id: source.id, apply: true});
      expect((yield* readSourceConfiguration(config)).sources).toEqual([]);
      expect(yield* fs.exists(`${home}/threadnote/credentials/linear/${source.id}`)).toBe(false);
    }).pipe(TestClock.withLive, provideLayer),
  );
  effectIt.effect('is idempotent, honors pre-recall cooldown and expires stale evidence', () =>
    Effect.gen(function* () {
      const {config, location} = yield* fixture;
      yield* runLinearSourceAdd(config, options);
      yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch: safeFetch}});
      const previous = yield* readExternalDocumentManifest(location, source.id, doc, 'linear');
      yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch: safeFetch}});
      expect((yield* readExternalDocumentManifest(location, source.id, doc, 'linear'))?.chunks).toEqual(
        previous?.chunks,
      );
      let calls = 0;
      yield* syncLinearSourcesBeforeRecall(config, {
        fetch: async (url, init) => {
          calls++;
          return safeFetch(url, init);
        },
      });
      expect(calls).toBe(0);
      const current = requireLinearSource(yield* readSourceConfiguration(config), source.id);
      yield* mutateSourceConfiguration(config, c => upsertLinearSource(c, {...current, maxStaleHours: 1}));
      expect(Object.keys(yield* loadExternalResourceAccess(location))).toEqual([]);
    }).pipe(TestClock.withLive, provideLayer),
  );
  effectIt.effect(
    'withholds incomplete discussion, preserves prior complete chunks and resumes budget-limited import',
    () =>
      Effect.gen(function* () {
        const {config, location} = yield* fixture;
        yield* runLinearSourceAdd(config, options);
        const partial = yield* runLinearSourceSync(config, {
          id: source.id,
          apply: true,
          clientOptions: {fetch: safeFetch, maxRequests: 3},
        });
        expect('progress' in partial ? partial.progress : undefined).toEqual({completed: 0, total: 1});
        expect(yield* readExternalDocumentManifest(location, source.id, doc, 'linear')).toBeUndefined();
        yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch: safeFetch}});
        const previous = yield* readExternalDocumentManifest(location, source.id, doc, 'linear');
        const failed = yield* runLinearSourceSync(config, {
          id: source.id,
          apply: true,
          clientOptions: {
            fetch: async (url, init) =>
              request(init).query.includes('LinearComments')
                ? new Response(
                    JSON.stringify({
                      data: {issue: {id: issue.id, comments: connection([comment(100)])}},
                      errors: [{extensions: {code: 'INTERNAL_SERVER_ERROR'}}],
                    }),
                    {headers: {'content-type': 'application/json'}},
                  )
                : safeFetch(url, init),
          },
        });
        expect(failed.warnings).toContain('Linear refresh: contract-incomplete.');
        expect((yield* readExternalDocumentManifest(location, source.id, doc, 'linear'))?.chunks).toEqual(
          previous?.chunks,
        );
      }).pipe(TestClock.withLive, provideLayer),
  );
  effectIt.effect('quarantines moved issues and rejects organization mismatch/auth without serving cached text', () =>
    Effect.gen(function* () {
      const {config, location} = yield* fixture;
      yield* runLinearSourceAdd(config, options);
      yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch: safeFetch}});
      yield* runLinearSourceSync(config, {
        id: source.id,
        apply: true,
        clientOptions: {
          fetch: async (url, init) =>
            request(init).query.includes('LinearIssue(')
              ? response({issue: {...issue, team: {id: uuid(999), name: 'Outside'}}})
              : safeFetch(url, init),
        },
      });
      expect((yield* readExternalDocumentManifest(location, source.id, doc, 'linear'))?.status).toBe('quarantined');
      expect(Object.keys(yield* loadExternalResourceAccess(location))).toEqual([]);
      yield* runLinearSourceAdd(config, options);
      yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch: safeFetch}});
      yield* runLinearSourceSync(config, {
        id: source.id,
        apply: true,
        clientOptions: {fetch: async () => response({organization: {id: uuid(999)}, viewer: {id: source.principalId}})},
      });
      expect((yield* readExternalSourceReceipt(location, source.id, 'linear'))?.status).toBe('authentication-rejected');
      expect(Object.keys(yield* loadExternalResourceAccess(location))).toEqual([]);
      yield* runLinearSourceSync(config, {
        id: source.id,
        apply: true,
        clientOptions: {fetch: async () => response({}, 401)},
      });
      expect(Object.keys(yield* loadExternalResourceAccess(location))).toEqual([]);
    }).pipe(TestClock.withLive, provideLayer),
  );
  effectIt.effect('persists RATELIMITED cooldown and sanitizes reflected keys', () =>
    Effect.gen(function* () {
      const {config, location} = yield* fixture;
      yield* runLinearSourceAdd(config, options);
      let requests = 0;
      const fetch = async () => {
        requests++;
        return new Response(
          JSON.stringify({errors: [{message: 'sensitive detail', extensions: {code: 'RATELIMITED'}}]}),
          {status: 400, headers: {'content-type': 'application/json'}},
        );
      };
      yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch}});
      const access = yield* readExternalSourceReceipt(location, source.id, 'linear');
      expect(access?.nextAttemptAt).toBeGreaterThan(yield* Clock.currentTimeMillis);
      yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch}});
      expect(requests).toBe(1);
      yield* runLinearSourceAdd(config, options);
      const result = yield* runLinearSourceSync(config, {
        id: source.id,
        apply: true,
        clientOptions: {
          fetch: async () =>
            response({organization: {id: 'synthetic-linear-private-key'}, viewer: {id: source.principalId}}),
        },
      });
      expect(JSON.stringify(result)).not.toContain('synthetic-linear-private-key');
      expect((yield* readExternalSourceReceipt(location, source.id, 'linear'))?.status).toBe('authentication-rejected');
    }).pipe(TestClock.withLive, provideLayer),
  );
  effectIt.effect('denies cache with missing credential and never publishes after source configuration changes', () =>
    Effect.gen(function* () {
      const {config, fs, location} = yield* fixture;
      yield* runLinearSourceAdd(config, options);
      const path = yield* sourceConfigurationPath(config);
      let changed = false;
      const result = yield* runLinearSourceSync(config, {
        id: source.id,
        apply: true,
        clientOptions: {
          fetch: async (url, init) => {
            if (!changed) {
              changed = true;
              await Bun.write(
                path,
                configurationRegistry.render(
                  upsertLinearSource({version: 2, sources: [source], projections: []}, {...source, project: 'other'}),
                ),
              );
            }
            return safeFetch(url, init);
          },
        },
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(yield* readExternalDocumentManifest(location, source.id, doc, 'linear')).toBeUndefined();
      yield* runLinearSourceAdd(config, options);
      yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch: safeFetch}});
      yield* fs.remove(`${config.agentContextHome}/threadnote/credentials/linear/${source.id}`);
      expect(Object.keys(yield* loadExternalResourceAccess(location))).toEqual([]);
      const unavailable = yield* runLinearSourceSync(config, {
        id: source.id,
        apply: true,
        clientOptions: {fetch: safeFetch},
      });
      expect(unavailable.warnings).toEqual(['Linear credential is unavailable.']);
    }).pipe(TestClock.withLive, provideLayer),
  );
  effectIt.effect('checks expected fingerprint before changing a protected credential', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      yield* runLinearSourceAdd(config, options);
      const current = requireLinearSource(yield* readSourceConfiguration(config), source.id);
      const result = yield* runLinearSourceAdd(config, {
        ...options,
        apiToken: Redacted.make('synthetic-replacement-key'),
        expectedFingerprint: 'a'.repeat(64),
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(Redacted.value(yield* resolveLinearCredential(config, current))).toBe('synthetic-linear-private-key');
      expect(
        sourceConfigurationFingerprint(requireLinearSource(yield* readSourceConfiguration(config), source.id)),
      ).toBe(sourceConfigurationFingerprint(current));
      yield* runLinearSourceRemove(config, {id: source.id, apply: true});
    }).pipe(TestClock.withLive, provideLayer),
  );
  effectIt.effect(
    'denies cached text immediately when the configured key rotates, and rejects publication if rotation occurs during fetch',
    () =>
      Effect.gen(function* () {
        const {config, location} = yield* fixture;
        yield* runLinearSourceAdd(config, options);
        yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch: safeFetch}});
        const old = yield* readExternalDocumentManifest(location, source.id, doc, 'linear');
        expect(Object.keys(yield* loadExternalResourceAccess(location))).not.toEqual([]);
        yield* storeLinearCredential(config, source.id, Redacted.make('synthetic-rotated-private-key'));
        expect(Object.keys(yield* loadExternalResourceAccess(location))).toEqual([]);
        yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch: safeFetch}});
        expect((yield* readExternalDocumentManifest(location, source.id, doc, 'linear'))?.accessEpoch).not.toBe(
          old?.accessEpoch,
        );
        let rotated = false;
        const keyFile = `${config.agentContextHome}/threadnote/credentials/linear/${source.id}`;
        const result = yield* runLinearSourceSync(config, {
          id: source.id,
          apply: true,
          clientOptions: {
            fetch: async (url, init) => {
              if (request(init).query.includes('LinearComments') && !rotated) {
                rotated = true;
                await Bun.write(keyFile, 'synthetic-second-rotated-key');
              }
              return safeFetch(url, init);
            },
          },
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(Object.keys(yield* loadExternalResourceAccess(location))).toEqual([]);
      }).pipe(TestClock.withLive, provideLayer),
  );
});
