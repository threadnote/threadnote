import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, Fiber, FileSystem, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {applyReviewedConsolidation, type ReviewedConsolidationJob} from '../../src/manager/consolidation.js';
import {runArchive} from '@threadnote/threadnote/memory/index';
import {ResourceStore} from '@threadnote/store/resource-store';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {
  captureConsolidationSource,
  consolidationRevision,
  type ConsolidationReview,
} from '@threadnote/memory/consolidation';
import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {validateContextBriefMemoryCitations} from '@threadnote/context/citation_validation';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {runCommandEffect} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const timestamp = '2026-10-08T00:00:00.000Z';
const archiveRoot = 'threadnote://user/test/memories/durable/archived/threadnote';
const resultRoot = 'threadnote://user/test/memories/durable/projects/threadnote';
const fixture = Effect.fn('test.consolidationFixture')(function* (indexedCode = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-consolidation-'});
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'manifest.yaml'),
    user: 'test',
  };
  const location = {account: config.account, home, user: config.user};
  const store = yield* ResourceStore;
  const repo = path.join(home, 'repository');
  yield* fs.makeDirectory(repo);
  const codePath = path.join(repo, 'code.ts');
  const code = 'export const enabled = true;\n';
  yield* fs.writeFileString(codePath, code);
  let citation = createMemoryCodeCitation({
    version: 1,
    extractorSet: 'test',
    repositoryId: 'a'.repeat(64),
    repositoryIdentityKind: 'local',
    sourceCommit: 'b'.repeat(40),
    sourceSnapshotId: `cgsn_${'c'.repeat(40)}`,
    sourceDirty: false,
    fileContentHash: {algorithm: 'sha256', value: sha256HexSync(code)},
    path: 'code.ts',
    target: {kind: 'file'},
  });
  if (indexedCode) {
    const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
    yield* git(['init', '-q', '--initial-branch=main']);
    yield* git(['add', '.']);
    yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial code']);
    const indexer = yield* CodeGraphIndexer;
    yield* indexer.index({cwd: repo, threadnoteHome: home, ensureVectors: false});
    citation = (yield* captureMemoryCodeCitations(config, {callerCwd: repo, refs: ['code.ts']}))[0]!;
  }
  const relation = {type: 'depends_on' as const, uri: 'threadnote://memory/tn_dependency'};
  const bodies = ['Claim one.', 'Claim two.'];
  const sources = yield* Effect.forEach(bodies, (body, i) =>
    Effect.gen(function* () {
      const uri = `${resultRoot}/source-${i}.md`;
      const content = formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          project: 'threadnote',
          topic: `source-${i}`,
          sourceAgentClient: 'test',
          timestamp,
          memoryId: `tn_source_${i}`,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          codeCitations: [citation],
          relations: i === 0 ? [relation] : [],
        },
        body,
      );
      yield* store.write(location, uri, content, {mode: 'create'});
      return captureConsolidationSource({uri, content});
    }),
  );
  const reviews: readonly ConsolidationReview[] = sources.map((source, i) => ({
    section: bodies[i],
    disposition: i === 0 ? 'direct' : 'contextual',
    supports: [{sourceUri: source.uri, fragment: 0, citationIds: [citation.id], relationIndexes: i === 0 ? [0] : []}],
  }));
  const job: ReviewedConsolidationJob = {
    id: 'test-operation',
    createdAt: timestamp,
    draft: bodies.join('\n\n'),
    sources,
    target: {kind: 'durable', project: 'threadnote', topic: 'consolidated', status: 'active'},
  };
  const request = {draft: job.draft, cleanup: 'archive', reviews};
  return {fs, config, store, location, job, request, sources, reviews, citation, relation, codePath, repo};
});

describe('Manager reviewed consolidation application', () => {
  effectIt.effect(
    'archives cited inputs only after verified structured provenance and still reports changed code',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        const applied = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, f.request);
        const record = parseMemoryDocument(applied.resultUri, yield* f.store.read(f.location, applied.resultUri))!;
        expect(record.metadata.codeCitations).toEqual([f.citation]);
        expect(record.metadata.relations).toEqual([f.relation]);
        expect(record.metadata.consolidation?.sources.map(s => s.fragments)).toEqual([['Claim one.'], ['Claim two.']]);
        for (const source of f.sources)
          expect(yield* f.store.read(f.location, source.uri).pipe(Effect.option)).toMatchObject({_tag: 'None'});
        expect(yield* f.store.list(f.location, archiveRoot, {recursive: true})).toHaveLength(2);
        const candidate = {
          citationErrorCount: record.metadata.citationErrors?.length ?? 0,
          codeCitations: record.metadata.codeCitations!,
          excerpt: record.body,
          kind: 'durable' as const,
          project: 'threadnote',
          topic: 'consolidated',
          rank: 0,
          uri: record.uri,
        };
        const freshness = () =>
          validateContextBriefMemoryCitations(f.config, {callerCwd: f.repo, kind: 'repository'}, [candidate]);
        expect((yield* freshness())[0]?.receipts.map(r => r.status)).toEqual(['exact']);
        yield* f.fs.writeFileString(f.codePath, 'export const enabled = false;\n');
        yield* runCommandEffect('git', ['-C', f.repo, 'add', '.']);
        yield* runCommandEffect('git', [
          '-C',
          f.repo,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-qm',
          'changed cited code',
        ]);
        yield* (yield* CodeGraphIndexer).index({
          cwd: f.repo,
          threadnoteHome: f.config.agentContextHome,
          ensureVectors: false,
        });
        expect((yield* freshness())[0]?.receipts).toEqual([
          expect.objectContaining({status: 'changed', reason: 'source-changed'}),
        ]);
        // Consolidation itself can later be archived without losing its derivation binding.
        yield* runArchive(f.config, applied.resultUri, {expectedRevision: consolidationRevision(record.content)});
        const archives = yield* f.store.list(f.location, archiveRoot, {recursive: true});
        const resultArchive = yield* Effect.forEach(archives, entry =>
          f.store.read(f.location, entry.uri).pipe(Effect.map(content => parseMemoryDocument(entry.uri, content))),
        );
        expect(
          resultArchive.find(r => r?.metadata.memoryId === record.metadata.memoryId)?.metadata.consolidation,
        ).toEqual(record.metadata.consolidation);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects stale paragraph review and a changed source before writing or cleanup', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const stale = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, {...f.request, draft: 'Edited.'}).pipe(
        Effect.result,
      );
      expect(Result.isFailure(stale)).toBe(true);
      const source = f.sources[0];
      const old = yield* f.store.read(f.location, source.uri);
      const changed = old.replace('Claim one.', 'A newer decision.');
      yield* f.store.write(f.location, source.uri, changed, {mode: 'replace'});
      const result = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, f.request).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(yield* f.store.read(f.location, source.uri)).toBe(changed);
      expect(yield* f.store.list(f.location, resultRoot, {recursive: true})).toHaveLength(2);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'recovers an interruption after archive save before source deletion without duplicating either result or archive, including restart',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let interrupted = false;
        const interrupting = ResourceStore.of({
          ...f.store,
          remove: (location, uri, options) => {
            if (uri === f.sources[0].uri && !interrupted) {
              interrupted = true;
              return Effect.interrupt;
            }
            return f.store.remove(location, uri, options);
          },
        });
        const fiber = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, f.request).pipe(
          Effect.provideService(ResourceStore, interrupting),
          Effect.forkChild({startImmediately: true}),
        );
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
        expect(f.job.resultUri).toBe(`${resultRoot}/consolidated.md`);
        expect(yield* f.store.list(f.location, archiveRoot, {recursive: true})).toHaveLength(1);
        const resumed = yield* applyReviewedConsolidation(f.config, undefined, f.job.id, {resultUri: f.job.resultUri});
        expect(resumed.resultUri).toBe(f.job.resultUri);
        expect(yield* f.store.list(f.location, resultRoot, {recursive: true})).toHaveLength(1);
        expect(yield* f.store.list(f.location, archiveRoot, {recursive: true})).toHaveLength(2);
        const bytes = yield* f.store.read(f.location, resumed.resultUri);
        yield* applyReviewedConsolidation(f.config, undefined, f.job.id, {resultUri: resumed.resultUri});
        const restartedOriginalRequest = yield* applyReviewedConsolidation(f.config, undefined, f.job.id, {
          ...f.request,
          ...f.job.target,
        });
        expect(restartedOriginalRequest.resultUri).toBe(resumed.resultUri);
        expect(yield* f.store.read(f.location, resumed.resultUri)).toBe(bytes);
        const changedRequest = yield* applyReviewedConsolidation(f.config, undefined, f.job.id, {
          resultUri: resumed.resultUri,
          cleanup: 'forget',
        }).pipe(Effect.result);
        expect(Result.isFailure(changedRequest)).toBe(true);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  for (const cleanup of ['archive', 'forget'] as const)
    effectIt.effect(`CAS fences ${cleanup} against a raw store writer between review and deletion`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const source = f.sources[0];
        const original = yield* f.store.read(f.location, source.uri);
        const changed = original.replace('Claim one.', 'Newer revision survives.');
        let raced = false;
        const racing = ResourceStore.of({
          ...f.store,
          remove: (location, uri, options) =>
            Effect.gen(function* () {
              if (uri === source.uri && !raced) {
                raced = true;
                yield* f.store.write(location, uri, changed, {mode: 'replace'});
              }
              return yield* f.store.remove(location, uri, options);
            }),
        });
        const result = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, {...f.request, cleanup}).pipe(
          Effect.provideService(ResourceStore, racing),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(raced).toBe(true);
        expect(yield* f.store.read(f.location, source.uri)).toBe(changed);
        expect(yield* f.store.read(f.location, f.sources[1].uri)).toContain('Claim two.');
        const archives = yield* f.store
          .list(f.location, archiveRoot, {recursive: true})
          .pipe(Effect.catchTag('ResourceNotFound', () => Effect.succeed([])));
        expect(archives).toHaveLength(0);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );

  effectIt.effect('preserves a concurrently changed archive when rolling back failed source cleanup', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = f.sources[0];
      const original = yield* f.store.read(f.location, source.uri);
      let changedArchiveUri = '';
      const racing = ResourceStore.of({
        ...f.store,
        remove: (location, uri, options) =>
          Effect.gen(function* () {
            if (uri === source.uri) {
              yield* f.store.write(location, uri, original.replace('Claim one.', 'Newer source.'), {mode: 'replace'});
              const archives = yield* f.store.list(location, archiveRoot, {recursive: true});
              changedArchiveUri = archives[0].uri;
              yield* f.store.write(location, changedArchiveUri, 'Newer archive revision.', {mode: 'replace'});
            }
            return yield* f.store.remove(location, uri, options);
          }),
      });
      const result = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, f.request).pipe(
        Effect.provideService(ResourceStore, racing),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(yield* f.store.read(f.location, source.uri)).toContain('Newer source.');
      expect(yield* f.store.read(f.location, changedArchiveUri)).toBe('Newer archive revision.');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps every source when stored result verification fails', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const corrupting = ResourceStore.of({
        ...f.store,
        read: (location, uri) =>
          f.store
            .read(location, uri)
            .pipe(
              Effect.map(content =>
                uri.endsWith('/consolidated.md') ? content.replace('Claim one.', 'Corrupted.') : content,
              ),
            ),
      });
      const result = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, f.request).pipe(
        Effect.provideService(ResourceStore, corrupting),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      for (const source of f.sources)
        expect(yield* f.store.read(f.location, source.uri)).toContain(source.fragments[0]);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses a source or unrelated destination collision without overwriting any memory', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const sourceBytes = yield* f.store.read(f.location, f.sources[0].uri);
      const sourceCollision = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, {
        ...f.request,
        topic: 'source-0',
      }).pipe(Effect.result);
      expect(Result.isFailure(sourceCollision)).toBe(true);
      expect(yield* f.store.read(f.location, f.sources[0].uri)).toBe(sourceBytes);
      const existing = sourceBytes.replace('Claim one.', 'Unrelated existing memory.');
      yield* f.store.write(f.location, `${resultRoot}/consolidated.md`, existing, {mode: 'create'});
      const collision = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, f.request).pipe(Effect.result);
      expect(Result.isFailure(collision)).toBe(true);
      expect(yield* f.store.read(f.location, `${resultRoot}/consolidated.md`)).toBe(existing);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reuses a canonical save when interruption prevented assigning the in-memory result URI', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const resultUri = `${resultRoot}/consolidated.md`;
      const interruptedStore = ResourceStore.of({
        ...f.store,
        writeChecked: (location, uri, content, options, check) =>
          f.store
            .writeChecked(location, uri, content, options, check)
            .pipe(Effect.tap(() => (uri === resultUri ? Effect.interrupt : Effect.void))),
      });
      const fiber = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, f.request).pipe(
        Effect.provideService(ResourceStore, interruptedStore),
        Effect.forkChild({startImmediately: true}),
      );
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
      expect(f.job.resultUri).toBeUndefined();
      const bytes = yield* f.store.read(f.location, resultUri);
      const retried = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, f.request);
      expect(retried.resultUri).toBe(resultUri);
      expect(yield* f.store.read(f.location, resultUri)).toBe(bytes);
      expect(yield* f.store.list(f.location, resultRoot, {recursive: true})).toHaveLength(1);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('creates the result atomically without replacing a raw writer that races the preflight', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const resultUri = `${resultRoot}/consolidated.md`;
      const existing = (yield* f.store.read(f.location, f.sources[0].uri)).replace(
        'Claim one.',
        'Concurrent destination.',
      );
      let raced = false;
      const racing = ResourceStore.of({
        ...f.store,
        writeChecked: (location, uri, content, options, check) =>
          Effect.gen(function* () {
            if (uri === resultUri && !raced) {
              raced = true;
              yield* f.store.write(location, uri, existing, {mode: 'create'});
            }
            return yield* f.store.writeChecked(location, uri, content, options, check);
          }),
      });
      const result = yield* applyReviewedConsolidation(f.config, f.job, f.job.id, f.request).pipe(
        Effect.provideService(ResourceStore, racing),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(raced).toBe(true);
      expect(yield* f.store.read(f.location, resultUri)).toBe(existing);
      for (const source of f.sources)
        expect(yield* f.store.read(f.location, source.uri)).toContain(source.fragments[0]);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
