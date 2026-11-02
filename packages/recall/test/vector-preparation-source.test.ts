import * as EffectString from 'effect/String';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Array as EffectArray, Clock, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {SystemInfo} from '@threadnote/platform/system';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {
  recallVectorTarget,
  prepareRecallVectorMetadata,
  resolveRecallVectorMetadata,
  hydrateRecallVectorDocuments,
} from '../src/background/vector-preparation.js';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {
  ExternalSourcePolicy,
  externalDocumentManifestUri,
  externalResourceUri,
  renderExternalResource,
  serializeExternalDocumentManifest,
} from '@threadnote/store/external-resource';
import {loadRecallIndexData, recallIndexStatus, expireRecallIndexValidation} from '../src/index.js';
import {openRecallVectorPreparationSource} from '../src/index/vector-preparation-source.js';
import type {RecallCandidate} from '../src/rank.js';
const platform = Layer.mergeAll(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: environment => environment,
          sanitizeExternal: environment => environment,
        }),
      ),
    ),
  ),
);
const fixture = (
  count: number,
  conflicting: boolean,
  variant: {approved: boolean; timestamps: boolean; multipleIds: boolean} = {
    approved: false,
    timestamps: false,
    multipleIds: false,
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-source-'});
    const config = {agentContextHome: home, account: 'local', user: 'test'};
    const directory = path.join(home, 'data/local/user/test/memories/durable/projects/threadnote');
    yield* fs.makeDirectory(directory, {recursive: true});
    for (let index = 0; index < count; index++) {
      const hashGroup = conflicting && index === count - 1 ? 1 : 0;
      yield* fs.writeFileString(
        path.join(directory, EffectString.padStart(4, '0')(String(index)) + '.md'),
        formatMemoryDocument(
          'MEMORY',
          {
            kind: 'durable',
            memoryId:
              index % 3 === 0
                ? undefined
                : variant.multipleIds && index % 2
                  ? 'tn_second_identity'
                  : 'tn_same_identity',
            authority: variant.approved && index % 2 ? 'user_approved' : 'agent_generated',
            trust: variant.approved && index % 2 ? 'approved' : 'inferred',
            status: 'active',
            project: 'threadnote',
            topic: 'same-topic',
            sourceAgentClient: 'test',
            timestamp: variant.timestamps && index % 2 ? '2026-09-02T00:00:00Z' : '2026-09-01T00:00:00Z',
            relations: [{type: 'references', uri: `threadnote://resources/repos/threadnote/${index}.md`}],
          },
          `Representative body ${hashGroup}.`,
        ),
      );
    }
    const full = yield* loadRecallIndexData(config, {includeInactive: false});
    return {config, fs, full};
  });
const prepare = (config: Parameters<typeof openRecallVectorPreparationSource>[0]) =>
  Effect.gen(function* () {
    const source = yield* openRecallVectorPreparationSource(config);
    const metadata: RecallCandidate[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const page = yield* source.readMetadataPage(after);
      expect(page.candidates.length).toBeLessThanOrEqual(100);
      expect(EffectArray.every(page.candidates, candidate => candidate.text === '')).toBe(true);
      metadata.push(...page.candidates);
      pages++;
      if (page.done) break;
      after = page.after;
    }
    const logical = yield* source.resolve(metadata);
    const hydrated: RecallCandidate[] = [];
    for (let offset = 0; offset < logical.length; offset += 100)
      hydrated.push(...(yield* source.hydrate(logical.slice(offset, offset + 100))));
    return {source, hydrated, pages};
  });
describe('lexical vector preparation source', () => {
  fcEffectProp(
    effectIt,
    'paged projection/global resolution/hydration equals the full authorized load across page boundaries',
    {
      count: fc.integer({min: 201, max: 208}),
      conflicting: fc.boolean(),
      approved: fc.boolean(),
      timestamps: fc.boolean(),
      multipleIds: fc.boolean(),
    },
    ({count, conflicting, approved, timestamps, multipleIds}) =>
      Effect.gen(function* () {
        const f = yield* fixture(count, conflicting, {approved, timestamps, multipleIds});
        const prepared = yield* prepare(f.config);
        expect(prepared.pages).toBe(3);
        expect(prepared.hydrated).toEqual(f.full.candidates);
        expect(
          EffectArray.flatMap(prepared.hydrated, candidate => candidate.equivalentUris ?? []).length,
        ).toBeGreaterThan(50);
        expect(EffectArray.flatMap(prepared.hydrated, candidate => candidate.relations ?? []).length).toBe(count);
      }).pipe(provideFixtureLayer(platform)),
    {fastCheck: {numRuns: 8}},
  );
  for (const malformed of [null, 42, undefined])
    effectIt.effect(`rejects malformed text on a losing alias (${String(malformed)})`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(3, false);
        const status = yield* recallIndexStatus(f.config, false);
        yield* Effect.sync(() => {
          const db = new Database(status.databasePath);
          try {
            const row = db
              .query<{id: number; candidate_json: string}, []>(
                'SELECT id,candidate_json FROM documents ORDER BY uri DESC LIMIT 1',
              )
              .get()!;
            const value = JSON.parse(row.candidate_json);
            value.text = malformed;
            db.query('UPDATE documents SET candidate_json = ? WHERE id = ?').run(JSON.stringify(value), row.id);
            // Keep the fixture's metadata integrity current so original JSON-type validation is exercised.
            db.exec(
              "UPDATE metadata SET value = (SELECT value FROM metadata WHERE key = 'mutation_sequence') WHERE key = 'integrity_sequence'",
            );
          } finally {
            db.close();
          }
        });
        const source = yield* openRecallVectorPreparationSource(f.config);
        expect((yield* source.readMetadataPage(undefined).pipe(Effect.result))._tag).toBe('Failure');
      }).pipe(provideFixtureLayer(platform)),
    );
  effectIt.effect('returns a typed unavailable result if a previously ready source disappears', () =>
    Effect.gen(function* () {
      const f = yield* fixture(3, false);
      const source = yield* openRecallVectorPreparationSource(f.config);
      yield* f.fs.remove(source.databasePath, {force: true});
      const exit = yield* source.readMetadataPage(undefined).pipe(Effect.result);
      expect(exit).toMatchObject({_tag: 'Failure', failure: {_tag: 'RecallIndexCorrupt'}});
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('rejects canonical drift between pages', () =>
    Effect.gen(function* () {
      const f = yield* fixture(3, false);
      const source = yield* openRecallVectorPreparationSource(f.config);
      yield* expireRecallIndexValidation(f.config.agentContextHome, false);
      expect(yield* source.readMetadataPage(undefined).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {_tag: 'RecallVectorSourceChanged'},
      });
    }).pipe(provideFixtureLayer(platform)),
  );
  for (const change of ['revoke', 'expire', 'bytes', 'hydration-race'] as const)
    effectIt.effect(`rechecks external authorization at hydration and publication (${change})`, () => {
      let enabled = true;
      const fingerprint = EffectString.repeat(64)('a');
      const dependencies = Layer.mergeAll(
        platform,
        Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
        Layer.succeed(ExternalSourcePolicy, {
          current: () => Effect.sync(() => ({enabled, configFingerprint: fingerprint, project: 'threadnote'})),
        }),
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-external-source-'});
        const config = {agentContextHome: home, account: 'local', user: 'test'};
        const location = {home, account: 'local', user: 'test'};
        const store = yield* ResourceStore;
        const metadata = {
          version: 1 as const,
          sourceId: 'source',
          documentId: 'doc',
          pageId: 'page',
          chunkId: 'chunk',
          project: 'threadnote',
          title: 'External',
          rendererVersion: '1',
          scrubberVersion: '1',
          coverage: 'canvas-plain-text' as const,
        };
        const uri = externalResourceUri(metadata);
        const content = renderExternalResource(metadata, 'External body.');
        const now = yield* Clock.currentTimeMillis;
        yield* store.mutateChecked(
          location,
          [
            {type: 'write', uri, content, options: {mode: 'upsert'}},
            {
              type: 'write',
              uri: externalDocumentManifestUri('source', 'doc'),
              content: serializeExternalDocumentManifest({
                version: 1,
                sourceId: 'source',
                documentId: 'doc',
                configFingerprint: fingerprint,
                status: 'active',
                fetchedAt: now,
                maxStaleMilliseconds: 1000,
                chunks: {[uri]: yield* store.fingerprint(content)},
              }),
              options: {mode: 'upsert'},
            },
          ],
          Effect.void,
        );
        const full = yield* loadRecallIndexData(config, {includeInactive: false});
        expect(full.candidates).toHaveLength(1);
        const source = yield* openRecallVectorPreparationSource(config);
        const page = yield* source.readMetadataPage(undefined);
        const logical = yield* source.resolve(page.candidates);
        expect(yield* source.hydrate(logical)).toEqual(full.candidates);
        if (change === 'hydration-race') {
          const manifest = {...BUILTIN_MODEL_MANIFESTS[0], role: 'embedding' as const, dimensions: 2};
          let target = yield* recallVectorTarget(config, manifest, source);
          yield* prepareRecallVectorMetadata(config, manifest, source, target);
          target = yield* recallVectorTarget(config, manifest, source);
          yield* resolveRecallVectorMetadata(config, manifest, source, target, Effect.succeed(page.candidates));
          target = yield* recallVectorTarget(config, manifest, source);
          expect(target).toMatchObject({phase: 'hydrate', cursor: 0, chunk_cursor: 0, alias_cursor: 0});
          const racedSource = {
            ...source,
            hydrate: (selected: typeof logical, options?: Parameters<typeof source.hydrate>[1]) =>
              Effect.sync(() => {
                enabled = false;
              }).pipe(
                Effect.andThen(source.hydrate(selected, options)),
                Effect.ensuring(
                  Effect.sync(() => {
                    enabled = true;
                  }),
                ),
              ),
          };
          expect(
            yield* hydrateRecallVectorDocuments(config, manifest, racedSource, target, logical).pipe(Effect.result),
          ).toMatchObject({_tag: 'Failure', failure: {_tag: 'RecallVectorSourceChanged'}});
          expect(yield* source.authorize(logical)).toBeUndefined();
          expect(yield* recallVectorTarget(config, manifest, source)).toEqual(target);
          yield* hydrateRecallVectorDocuments(config, manifest, source, target, logical);
          expect(yield* recallVectorTarget(config, manifest, source)).toMatchObject({phase: 'hydrate', cursor: 1});
          return;
        }
        if (change === 'revoke') enabled = false;
        else if (change === 'expire') yield* TestClock.adjust(1001);
        else {
          const path = yield* Path.Path;
          // Bypass mutation markers deliberately: authorization must verify actual external bytes too.
          const filename = path.join(
            home,
            'data/local/resources',
            EffectString.slice('threadnote://resources/'.length)(uri),
          );
          yield* fs.writeFileString(filename, content + 'changed');
        }
        expect(yield* source.hydrate(logical)).toEqual([]);
        expect((yield* source.authorize(logical).pipe(Effect.result))._tag).toBe('Failure');
        expect(
          (yield* (yield* openRecallVectorPreparationSource(config)).readMetadataPage(undefined)).candidates,
        ).toEqual(change === 'bytes' ? page.candidates : []);
      }).pipe(provideFixtureLayer(Layer.merge(dependencies, ResourceStore.layer.pipe(Layer.provide(dependencies)))));
    });
});

function provideFixtureLayer<Services, E, R>(layer: Layer.Layer<Services, E, R>) {
  return <A, E2, R2>(program: Effect.Effect<A, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))));
}
