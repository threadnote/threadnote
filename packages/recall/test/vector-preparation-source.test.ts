import {cryptoLayer} from '@threadnote/platform/crypto';
import * as EffectString from 'effect/String';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Array as EffectArray, Clock, Effect, FileSystem, Layer, Option, Path, Record as EffectRecord} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it, vi} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {stepRecallVectorPreparation} from '../src/background/vector-step.js';
import {vectorIndexDatabaseFilename} from '../src/vector-index.js';
import {dropRecallChangeLog, forceRecallFullVectorWalk, recordRecallBodyReads} from './vector-walk.fixture.js';
import * as Candidate from '../src/index/candidate.js';
import * as Scrubber from '@threadnote/platform/scrubber';
import {indexCandidate, RECALL_CANDIDATE_TEXT_VERSION} from '../src/index/candidate.js';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {SystemInfo} from '@threadnote/platform/system';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {
  recallVectorTarget,
  type RecallVectorBuildPlan,
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
const fullPlan = Effect.succeed<RecallVectorBuildPlan>({kind: 'full'});
const platform = Layer.mergeAll(
  Layer.merge(BunServices.layer, cryptoLayer),
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
const embeddingManifest = {
  ...Option.getOrThrow(EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.role === 'embedding')),
  dimensions: 2,
};
const externalFingerprint = EffectString.repeat(64)('a');
const walkDependencies = Layer.mergeAll(
  platform,
  LocalModelCatalog.layer([embeddingManifest]),
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
  Layer.succeed(ExternalSourcePolicy, {
    current: () => Effect.succeed({enabled: true, configFingerprint: externalFingerprint, project: 'threadnote'}),
  }),
);
const walkLayer = Layer.merge(walkDependencies, ResourceStore.layer.pipe(Layer.provide(walkDependencies)));
const externalMetadata = {
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

/**
 * Background vector builds over two memories, a resource without a content hash and an external source, counting
 * body reads at the source port.
 */
const walkFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* ResourceStore;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'recall-source-walk-'}));
  const config = {agentContextHome: home, account: 'local', user: 'test'};
  yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', embeddingManifest.id);
  const memories = path.join(home, 'data/local/user/test/memories/durable/projects/threadnote');
  yield* fs.makeDirectory(memories, {recursive: true});
  const writeMemory = (name: string) =>
    fs.writeFileString(
      path.join(memories, `${name}.md`),
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          memoryId: `tn_${name}`,
          status: 'active',
          project: 'threadnote',
          topic: name,
          sourceAgentClient: 'test',
          timestamp: '2026-11-01T00:00:00Z',
        },
        `Body of memory ${name}.`,
      ),
    );
  for (const name of ['a', 'b']) yield* writeMemory(name);
  const resources = path.join(home, 'data/local/resources/repos/threadnote');
  yield* fs.makeDirectory(resources, {recursive: true});
  yield* fs.writeFileString(path.join(resources, 'r.md'), '# r\n\nBody of a resource without a content hash.');
  const externalUri = externalResourceUri(externalMetadata);
  const externalContent = renderExternalResource(externalMetadata, 'External body.');
  yield* store.mutateChecked(
    {home, account: 'local', user: 'test'},
    [
      {type: 'write', uri: externalUri, content: externalContent, options: {mode: 'upsert'}},
      {
        type: 'write',
        uri: externalDocumentManifestUri('source', 'doc'),
        content: serializeExternalDocumentManifest({
          version: 1,
          sourceId: 'source',
          documentId: 'doc',
          configFingerprint: externalFingerprint,
          status: 'active',
          fetchedAt: yield* Clock.currentTimeMillis,
          maxStaleMilliseconds: 60_000,
          chunks: {[externalUri]: yield* store.fingerprint(externalContent)},
        }),
        options: {mode: 'upsert'},
      },
    ],
    Effect.void,
  );
  yield* loadRecallIndexData(config, {includeInactive: false});
  const reads = yield* recordRecallBodyReads;
  const installed = {
    bytes: 1,
    installed: true,
    modelId: embeddingManifest.id,
    partialBytes: 0,
    path: '/fake/model.gguf',
    verified: true,
  };
  const step = stepRecallVectorPreparation(config, embeddingManifest, Effect.succeed(true)).pipe(
    Effect.provideService(
      LocalModelStore,
      LocalModelStore.of({
        install: () => Effect.die('unexpected install'),
        path: () => installed.path,
        remove: () => Effect.succeed(false),
        status: () => Effect.succeed(installed),
        verify: () => Effect.succeed(installed),
      }),
    ),
    Effect.provideService(
      LocalModelRuntime,
      LocalModelRuntime.of({
        diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 1}),
        embedMany: ({inputs}) =>
          Effect.succeed(
            EffectArray.map(inputs, input => [1, Number.parseInt(EffectString.slice(0, 8)(sha256HexSync(input)), 16)]),
          ),
        generate: () => Effect.die('unexpected generation'),
        rerank: () => Effect.die('unexpected rerank'),
      }),
    ),
  );
  const finish = Effect.gen(function* () {
    for (let turn = 0; turn < 500; turn++) if ((yield* step).state === 'current') return;
    return yield* Effect.die('builder did not converge');
  });
  const vectors = path.join(home, 'indexes/vectors', embeddingManifest.id, vectorIndexDatabaseFilename());
  const sqlite = (filename: string, statements: string) =>
    Effect.sync(() => {
      const db = new Database(filename);
      try {
        db.exec(statements);
      } finally {
        db.close();
      }
    });
  return {
    config,
    fs,
    reads,
    step,
    finish,
    memory: (name: string) => `threadnote://user/test/memories/durable/projects/threadnote/${name}.md`,
    writeMemory,
    lexicalDerivation: recallIndexStatus(config, false).pipe(
      Effect.map(status => {
        const db = new Database(status.databasePath, {readonly: true});
        try {
          return db
            .query<{key: string; value: string}, []>(
              "SELECT key, value FROM metadata WHERE key IN ('content_generation', 'candidate_text_derivation') ORDER BY key",
            )
            .all();
        } finally {
          db.close();
        }
      }),
    ),
    resource: 'threadnote://resources/repos/threadnote/r.md',
    externalUri,
    editVectors: (statements: string) => sqlite(vectors, statements),
    externalFile: path.join(
      home,
      'data/local/resources',
      EffectString.slice('threadnote://resources/'.length)(externalUri),
    ),
    externalContent,
    // Edits stored lexical rows in place and keeps the index integrity marker current.
    editLexical: (statements: string) =>
      recallIndexStatus(config, false).pipe(
        Effect.flatMap(status =>
          sqlite(
            status.databasePath,
            statements +
              "; UPDATE metadata SET value = (SELECT value FROM metadata WHERE key = 'mutation_sequence') WHERE key = 'integrity_sequence'",
          ),
        ),
      ),
    targetPhase: Effect.sync(() => {
      const db = new Database(vectors, {readonly: true});
      try {
        return db
          .query<{phase: string}, []>(
            "SELECT t.phase FROM idle_recall_targets t JOIN vector_generations g USING(generation) WHERE g.state = 'building'",
          )
          .all();
      } finally {
        db.close();
      }
    }),
  };
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
  // P5-A2. One input changes after a first walk; the next full walk reads only the bodies that input decides. A
  // resource without a content hash is read on every walk.
  const documentRow = `WHERE uri = 'threadnote://user/test/memories/durable/projects/threadnote/a.md'`;
  const derivationPart = (index: number, value: number | string) =>
    `UPDATE metadata SET value = json_set(value, '$[${index}]', ${value}) WHERE key = 'candidate_text_derivation'`;
  const changes = {
    unchanged: {lexical: '', vectors: '', all: false},
    size: {lexical: `UPDATE documents SET source_size = source_size + 1 ${documentRow}`, vectors: '', all: false},
    time: {
      lexical: `UPDATE documents SET source_modified_at = '2001-01-01T00:00:00.000Z' ${documentRow}`,
      vectors: '',
      all: false,
    },
    'no-time': {lexical: `UPDATE documents SET source_modified_at = NULL ${documentRow}`, vectors: '', all: false},
    'content-hash': {lexical: `UPDATE documents SET content_hash = 'changed' ${documentRow}`, vectors: '', all: false},
    candidate: {
      lexical: `UPDATE documents SET candidate_json = json_set(candidate_json, '$.title', 'Changed') ${documentRow}`,
      vectors: '',
      all: false,
    },
    'text-derivation': {lexical: derivationPart(2, 999), vectors: '', all: true},
    'lexical-schema': {lexical: derivationPart(1, 14), vectors: '', all: true},
    // A binary that does not write the derivation leaves the record of an older publication.
    'older-publication': {lexical: derivationPart(0, "'older-generation'"), vectors: '', all: true},
    'scope-mapping': {lexical: '', vectors: 'UPDATE vector_generations SET scope_mapping_version = 0', all: true},
  } as const;
  for (const [change, edit] of EffectRecord.toEntries(changes))
    effectIt.effect(`reads again only the bodies a changed input decides (${change})`, () =>
      Effect.gen(function* () {
        const f = yield* walkFixture;
        yield* f.finish;
        const all = [f.externalUri, f.resource, f.memory('a'), f.memory('b')].sort();
        expect([...f.reads].sort()).toEqual(all);
        yield* forceRecallFullVectorWalk(f.config);
        if (edit.lexical) yield* f.editLexical(edit.lexical);
        if (edit.vectors) yield* f.editVectors(edit.vectors);
        f.reads.length = 0;
        yield* f.finish;
        expect([...f.reads].sort()).toEqual(
          edit.all ? all : change === 'unchanged' ? [f.resource] : [f.resource, f.memory('a')].sort(),
        );
      }).pipe(provideFixtureLayer(walkLayer)),
    );
  // N1 and N2. The derivation record holds only while every stored text has its versions. A publication that
  // writes no record, before this record existed or by an older binary, derived the legacy version.
  const previousPublications = {
    recorded: '',
    absent: "DELETE FROM metadata WHERE key = 'candidate_text_derivation'",
    // A legacy publication advances the content generation and leaves the record on the one before. A direct
    // content_generation edit would make the next refresh derive every source again.
    legacy:
      "UPDATE metadata SET value = json_set(value, '$[0]', 'before-legacy') WHERE key = 'candidate_text_derivation'",
  } as const;
  const publishMemory = (f: Effect.Success<typeof walkFixture>, name: string) =>
    Effect.gen(function* () {
      yield* f.writeMemory(name);
      yield* expireRecallIndexValidation(f.config.agentContextHome, false, [f.memory(name)]);
      yield* loadRecallIndexData(f.config, {includeInactive: false, memoryIds: []});
    });
  for (const [previous, edit] of EffectRecord.toEntries(previousPublications))
    effectIt.effect(`reads a body again that a publication left on an older text version (${previous})`, () =>
      Effect.gen(function* () {
        const f = yield* walkFixture;
        yield* f.finish;
        if (edit) yield* f.editLexical(edit);
        // A new text version and the derivation that comes with it; unchanged sources keep their stored text.
        yield* Effect.acquireRelease(
          Effect.sync(() => [
            vi.spyOn(Candidate, 'RECALL_CANDIDATE_TEXT_VERSION', 'get').mockReturnValue(2),
            vi.spyOn(Scrubber, 'redactSensitiveText').mockImplementation(text => `${text}\n\nDerived again.`),
          ]),
          spies => Effect.sync(() => EffectArray.forEach(spies, spy => spy.mockRestore())),
        );
        yield* publishMemory(f, 'n');
        expect(EffectArray.map(yield* f.lexicalDerivation, row => row.key)).toEqual(['content_generation']);
        yield* dropRecallChangeLog(f.config);
        yield* f.finish;
        yield* forceRecallFullVectorWalk(f.config);
        f.reads.length = 0;
        yield* f.finish;
        expect(f.reads).toContain(f.memory('a'));
      }).pipe(provideFixtureLayer(walkLayer)),
    );
  for (const previous of ['absent', 'legacy'] as const)
    effectIt.effect(`writes the derivation record after a ${previous} publication of the current version`, () =>
      Effect.gen(function* () {
        const f = yield* walkFixture;
        const valid = Effect.map(f.lexicalDerivation, rows => {
          const [derivation, generation] = rows;
          return JSON.parse(derivation?.value ?? 'null')?.[0] === generation?.value;
        });
        // An existing index has no record, so its first walk reads every body.
        if (previous === 'absent') yield* f.editLexical(previousPublications.absent);
        yield* f.finish;
        if (previous === 'legacy') yield* f.editLexical(previousPublications.legacy);
        yield* publishMemory(f, 'n');
        expect(yield* valid).toBe(true);
        yield* dropRecallChangeLog(f.config);
        yield* f.finish;
        yield* publishMemory(f, 'o');
        yield* dropRecallChangeLog(f.config);
        f.reads.length = 0;
        yield* f.finish;
        expect([...f.reads].sort()).toEqual([f.resource, f.memory('o')].sort());
      }).pipe(provideFixtureLayer(walkLayer)),
    );
  effectIt.effect('keeps the derivation record through publications with the same versions', () =>
    Effect.gen(function* () {
      const f = yield* walkFixture;
      const record = Effect.map(f.lexicalDerivation, rows => {
        const [derivation, generation] = rows;
        return {generation: generation?.value, derivation: JSON.parse(derivation?.value ?? 'null')};
      });
      const first = yield* record;
      expect(first.derivation).toEqual([first.generation, 15, RECALL_CANDIDATE_TEXT_VERSION]);
      yield* loadRecallIndexData(f.config, {includeInactive: false, memoryIds: []});
      expect(yield* record).toEqual(first);
      yield* f.finish;
      // An incremental publication carries it to the new generation, so a full walk reads only the new body.
      yield* f.writeMemory('n');
      yield* expireRecallIndexValidation(f.config.agentContextHome, false, [f.memory('n')]);
      yield* loadRecallIndexData(f.config, {includeInactive: false, memoryIds: []});
      const carried = yield* record;
      expect(carried.generation).not.toBe(first.generation);
      expect(carried.derivation).toEqual([carried.generation, 15, RECALL_CANDIDATE_TEXT_VERSION]);
      yield* dropRecallChangeLog(f.config);
      f.reads.length = 0;
      yield* f.finish;
      expect([...f.reads].sort()).toEqual([f.resource, f.memory('n')].sort());
    }).pipe(provideFixtureLayer(walkLayer)),
  );
  // The identity binds stored text through RECALL_CANDIDATE_TEXT_VERSION, so the version must move with the text.
  it('pins the derived candidate text to its version', () => {
    const memory = (body: string) =>
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          memoryId: 'tn_golden',
          status: 'active',
          project: 'threadnote',
          topic: 'golden',
          sourceAgentClient: 'test',
          timestamp: '2026-11-01T00:00:00Z',
        },
        body,
      );
    const inputs: readonly (readonly [string, string])[] = [
      ['threadnote://resources/repos/threadnote/plain.md', '# Plain\n\nPlain resource text.\n'],
      [
        'threadnote://resources/repos/threadnote/secret.md',
        '# Config\n\napi_key = "sk-live-0123456789abcdefghijklmnop"\nGITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n',
      ],
      [
        'threadnote://user/test/memories/durable/projects/threadnote/golden.md',
        memory('A memory body.\n\nWith a second paragraph.'),
      ],
      [
        'threadnote://user/test/memories/durable/projects/threadnote/golden-secret.md',
        memory('Rotate password=hunter2-correct-horse before release.'),
      ],
      [externalResourceUri(externalMetadata), renderExternalResource(externalMetadata, 'External body text.')],
    ];
    expect(
      {
        version: RECALL_CANDIDATE_TEXT_VERSION,
        texts: EffectArray.map(inputs, ([uri, content]) => indexCandidate(uri, content, false).text),
      },
      'The stored candidate text changed: increase RECALL_CANDIDATE_TEXT_VERSION, then pin the new texts here.',
    ).toEqual({
      version: 1,
      texts: [
        '# Plain\n\nPlain resource text.\n',
        '# Config\n\napi_key = [REDACTED]\nGITHUB_TOKEN=[REDACTED]\n',
        'A memory body.\n\nWith a second paragraph.',
        'Rotate password=[REDACTED] before release.',
        'External body text.',
      ],
    });
  });
  effectIt.effect('rejects a revoked external source whose body read is skipped', () =>
    Effect.gen(function* () {
      const f = yield* walkFixture;
      yield* f.finish;
      yield* forceRecallFullVectorWalk(f.config);
      // Changed bytes keep the manifest map and the lexical row, so only authorization can refuse the source.
      yield* f.fs.writeFileString(f.externalFile, f.externalContent + 'changed');
      f.reads.length = 0;
      let failure: unknown;
      for (let turn = 0; turn < 500 && failure === undefined; turn++) {
        const result = yield* f.step.pipe(Effect.result);
        if (result._tag === 'Failure') failure = result.failure;
        else if (result.success.state === 'current') break;
      }
      expect(failure).toMatchObject({_tag: 'RecallVectorSourceChanged'});
      // Refused while copying unchanged documents, before any embedding.
      expect(yield* f.targetPhase).toEqual([{phase: 'hydrate'}]);
      expect(f.reads).not.toContain(f.externalUri);
    }).pipe(provideFixtureLayer(walkLayer)),
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
          let target = yield* recallVectorTarget(config, manifest, source, fullPlan);
          yield* prepareRecallVectorMetadata(config, manifest, source, target);
          target = yield* recallVectorTarget(config, manifest, source, fullPlan);
          yield* resolveRecallVectorMetadata(config, manifest, source, target, Effect.succeed(page.candidates));
          target = yield* recallVectorTarget(config, manifest, source, fullPlan);
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
          expect(yield* recallVectorTarget(config, manifest, source, fullPlan)).toEqual(target);
          yield* hydrateRecallVectorDocuments(config, manifest, source, target, logical);
          expect(yield* recallVectorTarget(config, manifest, source, fullPlan)).toMatchObject({
            phase: 'hydrate',
            cursor: 1,
          });
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
        const hydrated = yield* source.hydrate(logical).pipe(Effect.result);
        if (change === 'bytes') expect(hydrated).toMatchObject({_tag: 'Success', success: []});
        else expect(hydrated).toMatchObject({_tag: 'Failure', failure: {_tag: 'RecallVectorSourceChanged'}});
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
