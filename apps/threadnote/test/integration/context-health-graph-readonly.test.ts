import {it as effectIt} from '@effect/vitest';
import {Context, Effect, Exit, FileSystem, Layer, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {runCommandEffect} from '@threadnote/platform/command';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphDatabaseSession} from '@threadnote/graph/store/session';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, type MemoryMetadata, type MemoryRecord} from '@threadnote/memory/document';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {collectContextHealth} from '@threadnote/threadnote/memory/context/health_commands';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('Context Health graph observation', () => {
  effectIt.effect('uses an existing session for a snapshot published during an absent observation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-status-published-'});
      const repository = yield* makeRepository(path.join(root, 'repository'));
      const home = path.join(root, 'home');
      yield* fs.makeDirectory(home);
      const query = yield* CodeGraphQueryService;
      const indexer = yield* CodeGraphIndexer;
      let published = false;
      let used = 0;
      yield* query.withStatusSession!(
        home,
        repository,
        undefined,
        {
          requestMaintenance: false,
          afterIdentityObserved: () => {
            if (published) return Effect.void;
            published = true;
            return indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: home}).pipe(Effect.asVoid);
          },
        },
        status =>
          Effect.gen(function* () {
            used += 1;
            expect(status.readySnapshot).toBeDefined();
            const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
            expect(Option.isSome(session)).toBe(true);
            if (Option.isSome(session)) expect(session.value.databasePath).toBe(status.databasePath);
          }),
      );
      expect(used).toBe(1);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('does not recreate a graph removed between observation and session acquisition', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-status-removed-'});
      const repository = yield* makeRepository(path.join(root, 'repository'));
      const home = path.join(root, 'home');
      const identity = yield* resolveRepositoryIdentity(repository);
      const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
      const store = yield* CodeGraphStore;
      yield* store.initialize(layout.databasePath);
      let acquired = false;
      let used = false;
      const removingStore = CodeGraphStore.of({
        ...store,
        withSession: (databasePath, read, options) =>
          Effect.sync(() => {
            acquired = true;
          }).pipe(
            Effect.andThen(fs.remove(databasePath).pipe(Effect.orDie)),
            Effect.andThen(store.withSession(databasePath, read, options)),
          ),
      });
      const services = yield* Layer.build(
        Layer.fresh(CodeGraphQueryService.layer).pipe(Layer.provide(Layer.succeed(CodeGraphStore, removingStore))),
      );
      const query = Context.get(services, CodeGraphQueryService);
      const result = yield* query.withStatusSession!(home, repository, undefined, {requestMaintenance: false}, () =>
        Effect.sync(() => {
          used = true;
        }),
      ).pipe(Effect.exit);
      expect(acquired).toBe(true);
      expect(Exit.isFailure(result)).toBe(true);
      expect(used).toBe(false);
      expect(yield* fs.exists(layout.databasePath)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('leaves an unindexed caller without a database and preserves canonical cited memory', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-health-readonly-'});
      const indexed = yield* makeRepository(path.join(root, 'indexed'));
      const unindexed = yield* makeRepository(path.join(root, 'unindexed'));
      const home = path.join(root, 'home');
      yield* fs.makeDirectory(home);
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: path.join(home, 'seed-manifest.yaml'),
        user: 'tester',
      };
      yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
      const indexer = yield* CodeGraphIndexer;
      yield* indexer.index({cwd: indexed, ensureVectors: false, threadnoteHome: home});
      const citations = yield* captureMemoryCodeCitations(config, {callerCwd: indexed, refs: ['src/price.ts']});
      expect(citations).toHaveLength(1);
      const metadata: MemoryMetadata = {
        codeCitations: citations,
        kind: 'durable',
        memoryId: 'tn_health_readonly',
        project: 'fixture-health',
        schemaVersion: MEMORY_SCHEMA_VERSION,
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: '2026-10-03T00:00:00.000Z',
        topic: 'price-contract',
        visibility: 'personal',
      };
      const body = 'Synthetic pricing multiplies the amount by two.';
      const content = formatMemoryDocument('MEMORY', metadata, body);
      const uri = 'threadnote://user/tester/memories/durable/projects/fixture-health/price-contract.md';
      const record: MemoryRecord = {body, content, headerTitle: 'MEMORY', metadata, uri};
      const store = yield* ResourceStore;
      const location = {account: config.account, home, user: config.user};
      yield* store.write(location, uri, content, {mode: 'create'});
      const identity = yield* resolveRepositoryIdentity(unindexed);
      const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
      expect(yield* fs.exists(layout.databasePath)).toBe(false);
      const report = yield* collectContextHealth(config, 'fixture-health', [record], unindexed);
      expect(report.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({category: 'citation-unknown'})]),
      );
      expect(yield* fs.exists(layout.databasePath)).toBe(false);
      expect(yield* store.read(location, uri)).toBe(content);
      expect(yield* fs.readFileString(path.join(indexed, 'src/price.ts'))).toBe(SOURCE);
      const current = yield* collectContextHealth(config, 'fixture-health', [record], indexed);
      expect(current.findings.filter(finding => finding.category.startsWith('citation-'))).toEqual([]);
      expect(yield* store.read(location, uri)).toBe(content);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  fcEffectProp(
    effectIt,
    'repeated status sessions never create an absent graph',
    {
      reads: fc.integer({min: 1, max: 4}),
      maintenance: fc.boolean(),
    },
    ({reads, maintenance}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-status-readonly-'});
        const repository = yield* makeRepository(path.join(root, 'repository'));
        const home = path.join(root, 'home');
        yield* fs.makeDirectory(home);
        const identity = yield* resolveRepositoryIdentity(repository);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const query = yield* CodeGraphQueryService;
        for (let read = 0; read < reads; read += 1) {
          const status = yield* query.withStatusSession!(
            home,
            repository,
            undefined,
            {requestMaintenance: maintenance},
            Effect.succeed,
          );
          expect(status.readySnapshot).toBeUndefined();
          expect(status.stale).toBe(true);
          expect(yield* fs.exists(layout.databasePath)).toBe(false);
        }
        expect(yield* fs.readFileString(path.join(repository, 'src/price.ts'))).toBe(SOURCE);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {fastCheck: {numRuns: 8}},
  );
});

const SOURCE = 'export const price = (amount: number) => amount * 2;\n';
const makeRepository = Effect.fn('test.health.makeRepository')(function* (repository: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
  yield* fs.writeFileString(path.join(repository, 'src/price.ts'), SOURCE);
  yield* runCommandEffect('git', ['init', '--quiet'], {cwd: repository});
  yield* runCommandEffect('git', ['add', '.'], {cwd: repository});
  yield* runCommandEffect(
    'git',
    [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--quiet',
      '--message',
      'fixture',
    ],
    {cwd: repository},
  );
  return repository;
});
