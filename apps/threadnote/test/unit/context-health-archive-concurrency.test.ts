import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, PlatformError, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {buildContextHealthReport} from '@threadnote/context/health';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {runImportPack} from '@threadnote/threadnote/memory/commands';
import {previewContextHealthRepairPlanV1} from '@threadnote/threadnote/memory/context/health_repair';
import {
  applyAutomaticContextHealthArchive,
  previewAutomaticContextHealthArchiveReceipt,
} from '@threadnote/threadnote/memory/context/health_repair_commands';
import {proveAutomaticDuplicateArchive} from '@threadnote/threadnote/memory/context/maintenance';
import {resourceStoreLocation} from '@threadnote/threadnote/mcp/server/memory';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';

const NOW = '2026-10-03T15:00:00.000Z';
const ROOT = 'threadnote://user/tester/memories/durable/projects/threadnote';
const dependencies = Layer.mergeAll(
  BunServices.layer,
  TestSystemInfoLayer,
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const unexpectedGraph = () => Effect.die(new Error('Automatic archive must not inspect code citations.'));
const testLayer = Layer.mergeAll(
  dependencies,
  ResourceStore.layer.pipe(Layer.provide(dependencies)),
  TestCommandExecutorLayer.pipe(Layer.provide(dependencies)),
  CodeGraphStore.layer.pipe(Layer.provide(dependencies)),
  CodeGraphLanguagePackRegistry.layer,
  Layer.succeed(CodeGraphQueryService, {
    attachSharedReadySnapshot: unexpectedGraph,
    inspect: unexpectedGraph,
    purge: unexpectedGraph,
    status: unexpectedGraph,
    statusForIdentity: unexpectedGraph,
    statusForPublishedIdentity: unexpectedGraph,
  }),
);

function record(topic: string, metadata: Partial<MemoryMetadata> = {}, body = 'Keep useful context.') {
  return parseMemoryDocument(
    `${ROOT}/${topic}.md`,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        schemaVersion: 2,
        memoryId: `tn_${topic}`,
        project: 'threadnote',
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: NOW,
        topic,
        ...metadata,
      },
      body,
    ),
  )!;
}

function makeFixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'health-archive-concurrency-'});
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: path.join(home, 'threadnote.json'),
      user: 'tester',
    };
    const location = resourceStoreLocation(config);
    const source = record('subject');
    const survivor = record('survivor');
    const records = [source, survivor];
    const report = {
      ...buildContextHealthReport({
        project: 'threadnote',
        records: [],
        now: DateTime.toDateUtc(DateTime.makeUnsafe(NOW)),
      }),
      findings: [
        {
          category: 'exact-duplicate' as const,
          confidence: 'high' as const,
          id: 'exact-duplicate-subject',
          repair: {
            kind: 'deduplicate-memory' as const,
            subjectUri: source.uri,
            targetUri: survivor.uri,
            summary: 'Retire duplicate.',
          },
          repairability: 'reviewable' as const,
          severity: 'high' as const,
          summary: 'Exact duplicate.',
          uris: [source.uri, survivor.uri],
        },
      ],
      status: 'findings' as const,
    };
    const proposal = previewContextHealthRepairPlanV1(report, records).proposals.find(
      item => item.category === 'exact-duplicate' && item.mutation.kind === 'archive-memory',
    );
    expect(proposal).toBeDefined();
    const subject = records.find(item => item.uri === proposal!.mutation.subjectUri)!;
    const store = yield* ResourceStore;
    for (const item of records) yield* store.write(location, item.uri, item.content, {mode: 'create'});
    const archived = previewAutomaticContextHealthArchiveReceipt(config, proposal!, subject, NOW);
    const incoming = record('incoming', {relations: [{type: 'depends_on', uri: subject.uri}]}, 'Incoming claim.');
    const packPath = path.join(home, 'incoming.threadnote-pack.json');
    yield* fs.writeFileString(
      packPath,
      JSON.stringify({
        version: 1,
        sourceUri: ROOT,
        resources: [{relativeUri: 'incoming.md', content: incoming.content}],
      }),
    );
    return {
      fs,
      path,
      home,
      config,
      location,
      subject,
      survivor: records.find(item => item !== subject)!,
      proposal: proposal!,
      archived,
      incoming,
      packPath,
      store,
    };
  });
}

describe('atomic context-health archive retirement', () => {
  effectIt.effect('rejects a checked incoming writer queued after the final dependency proof', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const proofFinished = yield* Deferred.make<void>();
      const releaseProof = yield* Deferred.make<void>();
      const writerContended = yield* Deferred.make<void>();
      const store = yield* ResourceStore.pipe(
        provideTestLayer(
          ResourceStore.layerWith({
            onMutationLockContention: event =>
              event.uri === fixture.incoming.uri
                ? Deferred.succeed(writerContended, undefined).pipe(Effect.asVoid)
                : Effect.void,
          }),
        ),
      );
      const retirement = yield* applyAutomaticContextHealthArchive(
        fixture.config,
        fixture.proposal,
        fixture.home,
        NOW,
        source =>
          proveAutomaticDuplicateArchive(fixture.config, source).pipe(
            Effect.andThen(Deferred.succeed(proofFinished, undefined)),
            Effect.andThen(Deferred.await(releaseProof)),
          ),
      ).pipe(Effect.provideService(ResourceStore, store), Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(proofFinished);
      const rejected = {reason: 'retired-dependency-target'} as const;
      const competing = yield* store
        .writeChecked(
          fixture.location,
          fixture.incoming.uri,
          fixture.incoming.content,
          {mode: 'create'},
          store.read(fixture.location, fixture.subject.uri).pipe(
            Effect.catchTag('ResourceNotFound', () => Effect.fail(rejected)),
            Effect.asVoid,
          ),
        )
        .pipe(Effect.result, Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(writerContended);
      expect(yield* store.read(fixture.location, fixture.subject.uri)).toBe(fixture.subject.content);
      expect(Option.isNone(yield* Effect.option(store.read(fixture.location, fixture.incoming.uri)))).toBe(true);
      yield* Deferred.succeed(releaseProof, undefined);
      expect((yield* Fiber.join(retirement)).status).toBe('applied');
      const result = yield* Fiber.join(competing);
      expect(Result.isFailure(result) && result.failure).toBe(rejected);
      expect(yield* store.read(fixture.location, fixture.archived.uri)).toBe(fixture.archived.content);
    }).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('preserves the subject when import-pack commits before the checked batch acquires the account', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* proveAutomaticDuplicateArchive(fixture.config, fixture.subject);
      const services = yield* Effect.context<Effect.Services<ReturnType<typeof runImportPack>>>();
      const importIncoming = runImportPack(fixture.config, {path: fixture.packPath}).pipe(
        Effect.provide(services),
        Effect.mapError(cause =>
          ResourceIoFailed.make({
            cause,
            operation: 'import',
            uri: fixture.incoming.uri,
            message: 'Test import failed.',
          }),
        ),
      );
      let imported = false;
      const racingStore = ResourceStore.of({
        ...fixture.store,
        mutateChecked: (location, mutations, check) =>
          Effect.gen(function* () {
            if (!imported) {
              imported = true;
              yield* importIncoming;
            }
            yield* fixture.store.mutateChecked(location, mutations, check);
          }),
      });
      const result = yield* applyAutomaticContextHealthArchive(
        fixture.config,
        fixture.proposal,
        fixture.home,
        NOW,
        source => proveAutomaticDuplicateArchive(fixture.config, source),
      ).pipe(Effect.provideService(ResourceStore, racingStore), Effect.result);
      expect(imported).toBe(true);
      expect(Result.isFailure(result)).toBe(true);
      expect(yield* fixture.store.read(fixture.location, fixture.subject.uri)).toBe(fixture.subject.content);
      expect(yield* fixture.store.read(fixture.location, fixture.incoming.uri)).toBe(fixture.incoming.content);
      expect(Option.isNone(yield* Effect.option(fixture.store.read(fixture.location, fixture.archived.uri)))).toBe(
        true,
      );
    }).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('prevents import-pack from committing between the final proof and subject retirement', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const proofFinished = yield* Deferred.make<void>();
      const releaseProof = yield* Deferred.make<void>();
      const importContended = yield* Deferred.make<void>();
      let importObservedRetiredSubject = false;
      const store = yield* ResourceStore.pipe(
        provideTestLayer(
          ResourceStore.layerWith({
            onMutationLockContention: event =>
              event.uri === fixture.incoming.uri
                ? Deferred.succeed(importContended, undefined).pipe(Effect.asVoid)
                : Effect.void,
            onMutationLockAcquired: event =>
              event.uri === fixture.incoming.uri
                ? fixture.store.read(fixture.location, fixture.subject.uri).pipe(
                    Effect.result,
                    Effect.tap(result =>
                      Effect.sync(() => {
                        importObservedRetiredSubject = Result.isFailure(result);
                      }),
                    ),
                    Effect.asVoid,
                  )
                : Effect.void,
          }),
        ),
      );
      const retirement = yield* applyAutomaticContextHealthArchive(
        fixture.config,
        fixture.proposal,
        fixture.home,
        NOW,
        source =>
          proveAutomaticDuplicateArchive(fixture.config, source).pipe(
            Effect.andThen(Deferred.succeed(proofFinished, undefined)),
            Effect.andThen(Deferred.await(releaseProof)),
          ),
      ).pipe(Effect.provideService(ResourceStore, store), Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(proofFinished);
      const importing = yield* runImportPack(fixture.config, {path: fixture.packPath}).pipe(
        Effect.provideService(ResourceStore, store),
        Effect.forkChild({startImmediately: true}),
      );
      yield* Deferred.await(importContended);
      expect(Option.isNone(yield* Effect.option(store.read(fixture.location, fixture.incoming.uri)))).toBe(true);
      expect(yield* store.read(fixture.location, fixture.subject.uri)).toBe(fixture.subject.content);
      yield* Deferred.succeed(releaseProof, undefined);
      expect((yield* Fiber.join(retirement)).status).toBe('applied');
      yield* Fiber.join(importing);
      expect(importObservedRetiredSubject).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('rechecks exact subject and survivor content before any archive mutation', () =>
    Effect.gen(function* () {
      for (const changedRecord of ['subject', 'survivor'] as const) {
        const fixture = yield* makeFixture();
        const changed = fixture[changedRecord];
        const content = `${changed.content}\nChanged concurrent claim.\n`;
        let injected = false;
        const racingStore = ResourceStore.of({
          ...fixture.store,
          mutateChecked: (location, mutations, check) =>
            Effect.gen(function* () {
              if (!injected) {
                injected = true;
                yield* fixture.store.write(fixture.location, changed.uri, content, {mode: 'replace'});
              }
              yield* fixture.store.mutateChecked(location, mutations, check);
            }),
        });
        const result = yield* applyAutomaticContextHealthArchive(
          fixture.config,
          fixture.proposal,
          fixture.home,
          NOW,
          source => proveAutomaticDuplicateArchive(fixture.config, source),
        ).pipe(Effect.provideService(ResourceStore, racingStore), Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(injected).toBe(true);
        expect(yield* fixture.store.read(fixture.location, fixture.subject.uri)).toBe(
          changedRecord === 'subject' ? content : fixture.subject.content,
        );
        expect(yield* fixture.store.read(fixture.location, fixture.survivor.uri)).toBe(
          changedRecord === 'survivor' ? content : fixture.survivor.content,
        );
        expect(Option.isNone(yield* Effect.option(fixture.store.read(fixture.location, fixture.archived.uri)))).toBe(
          true,
        );
      }
    }).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('replays an archive stored before a subject removal failure without duplicating it', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const subjectPath = yield* fixture.fs.realPath(
        fixture.path.join(
          fixture.home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          fixture.subject.uri.split('/').at(-1)!,
        ),
      );
      let failed = false;
      const interruptedFs = FileSystem.FileSystem.of({
        ...fixture.fs,
        remove: (path, options) => {
          if (!failed && path === subjectPath) {
            failed = true;
            return Effect.fail(
              PlatformError.systemError({
                _tag: 'PermissionDenied',
                module: 'FileSystem',
                method: 'remove',
              }),
            );
          }
          return fixture.fs.remove(path, options);
        },
      });
      const store = yield* ResourceStore.pipe(
        provideTestLayer(ResourceStore.layerWith()),
        Effect.provideService(FileSystem.FileSystem, interruptedFs),
      );
      const first = yield* applyAutomaticContextHealthArchive(
        fixture.config,
        fixture.proposal,
        fixture.home,
        NOW,
        source => proveAutomaticDuplicateArchive(fixture.config, source),
      ).pipe(Effect.provideService(ResourceStore, store), Effect.result);
      expect(Result.isFailure(first)).toBe(true);
      expect(failed).toBe(true);
      expect(yield* fixture.store.read(fixture.location, fixture.subject.uri)).toBe(fixture.subject.content);
      expect(yield* fixture.store.read(fixture.location, fixture.archived.uri)).toBe(fixture.archived.content);
      const replay = yield* applyAutomaticContextHealthArchive(
        fixture.config,
        fixture.proposal,
        fixture.home,
        NOW,
        source => proveAutomaticDuplicateArchive(fixture.config, source),
      );
      expect(replay.status).toBe('applied');
      const repeated = yield* applyAutomaticContextHealthArchive(
        fixture.config,
        fixture.proposal,
        fixture.home,
        NOW,
        source => proveAutomaticDuplicateArchive(fixture.config, source),
      );
      expect(repeated.status).toBe('already-applied');
      expect(yield* fixture.store.read(fixture.location, fixture.archived.uri)).toBe(fixture.archived.content);
    }).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );
});
