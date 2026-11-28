import {describe, expect, it as effectIt} from '@effect/vitest';
import {Deferred, Effect, FileSystem, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {makeIdempotentFixtureTempDirectoryScoped} from '@threadnote/testing/fixture-temp-directory';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runGraphShareJoin} from '@threadnote/graph/sharing/client';
import {graphShareControlGetStatus} from '@threadnote/graph/sharing/control/client';
import {loadGraphShareCoordinatorState} from '@threadnote/graph/sharing/control/server';
import {advanceGraphPublisherFrontier} from '@threadnote/graph/sharing/publisher/cycle';
import {
  runGraphPublisherBootstrap,
  runGraphPublisherListen,
  runGraphPublisherServe,
  runGraphShareInit,
} from '@threadnote/threadnote/code_graph/sharing/publisher';

describe('graph share publisher freeze cycle', () => {
  effectIt.effect(
    'freezes two contributor receipts, hydrates, exports, and walks status phases',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-graph-share-freeze-');
          const repository = path.join(root, 'repository');
          const cas = path.join(root, 'cas');
          const publisherHome = path.join(root, 'publisher-home');
          const contributorA = path.join(root, 'contributor-a');
          const contributorB = path.join(root, 'contributor-b');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"graph-share-freeze","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(path.join(repository, 'src', 'index.py'), 'shared = 1\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share-freeze.git']);
          yield* git(repository, ['add', '.']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'base',
          ]);
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: publisherHome});
          const ready = yield* Deferred.make<{readonly coordinatorUrl: string}>();
          yield* runGraphShareInit(config(publisherHome), {
            cas,
            cwd: repository,
            organization: 'acme',
            writeConfig: true,
          });
          yield* git(repository, ['add', '.threadnote/graph-share.json']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'enroll',
          ]);
          yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            threadnoteHome: publisherHome,
          });
          yield* runGraphPublisherBootstrap(config(publisherHome), {cas, cwd: repository});
          yield* Effect.forkScoped(
            runGraphPublisherListen(config(publisherHome), {
              cas,
              cwd: repository,
              listen: '127.0.0.1:0',
              onReady: output => Deferred.succeed(ready, {coordinatorUrl: output.coordinatorUrl}).pipe(Effect.asVoid),
            }),
          );
          const {coordinatorUrl} = yield* Deferred.await(ready);
          yield* runGraphShareJoin(config(contributorA), {cas, coordinator: coordinatorUrl, cwd: repository});
          yield* runGraphShareJoin(config(contributorB), {cas, coordinator: coordinatorUrl, cwd: repository});
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: contributorA});
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: contributorB});
          const afterJoin = yield* graphShareControlGetStatus(coordinatorUrl);
          expect(afterJoin.receipts.length).toBeGreaterThan(0);
          yield* fs.writeFileString(path.join(repository, 'src', 'next.py'), 'next = 2\n');
          yield* git(repository, ['add', 'src/next.py']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'advance',
          ]);
          yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            threadnoteHome: publisherHome,
          });
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: contributorA});
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: contributorB});
          const phases = yield* Ref.make<string[]>([]);
          const advanced = yield* advanceGraphPublisherFrontier(config(publisherHome), {
            cas,
            cwd: repository,
            forceFreeze: true,
            onMachine: machine => Ref.update(phases, current => [...current, machine.phase]),
          });
          expect(advanced.published).toBe(true);
          expect(advanced.generation).toBe(2);
          expect(advanced.checkpointDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
          const walked = yield* Ref.get(phases);
          expect(walked).toContain('frozen');
          expect(walked).toContain('assembling');
          expect(walked).toContain('verifying');
          expect(walked.at(-1) === 'published' || walked.at(-1) === 'collecting').toBe(true);
          const status = yield* graphShareControlGetStatus(coordinatorUrl);
          expect(status.generation).toBeGreaterThanOrEqual(1);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    180_000,
  );

  effectIt.effect(
    'keeps the last signed frontier when HEAD is unrelated',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-graph-share-unrelated-');
          const repository = path.join(root, 'repository');
          const cas = path.join(root, 'cas');
          const publisherHome = path.join(root, 'publisher-home');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"graph-share-unrelated","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(path.join(repository, 'src', 'index.py'), 'shared = 1\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share-unrelated.git']);
          yield* git(repository, ['add', '.']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'base',
          ]);
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: publisherHome});
          yield* runGraphShareInit(config(publisherHome), {
            cas,
            cwd: repository,
            organization: 'acme',
            writeConfig: true,
          });
          yield* git(repository, ['add', '.threadnote/graph-share.json']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'enroll',
          ]);
          yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            threadnoteHome: publisherHome,
          });
          const bootstrapped = yield* runGraphPublisherBootstrap(config(publisherHome), {cas, cwd: repository});
          yield* git(repository, ['checkout', '--orphan', 'other']);
          yield* fs.writeFileString(path.join(repository, 'src', 'index.py'), 'other = 1\n');
          yield* git(repository, ['add', '.']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'unrelated',
          ]);
          const served = yield* runGraphPublisherServe(config(publisherHome), {cas, cwd: repository});
          expect(served.generation).toBe(bootstrapped.generation);
          expect(served.manifestDigest).toBe(bootstrapped.manifestDigest);
          expect(served.type).toBe('code-graph-publisher-serve');
          if (served.type === 'code-graph-publisher-serve') expect(served.published).toBe(false);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    180_000,
  );

  effectIt.effect(
    'publishes a descendant freeze from an incremental ready snapshot without a prior full index',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-graph-share-clean-export-');
          const repository = path.join(root, 'repository');
          const cas = path.join(root, 'cas');
          const publisherHome = path.join(root, 'publisher-home');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"graph-share-clean-export","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(path.join(repository, 'src', 'index.py'), 'shared = 1\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share-clean-export.git']);
          yield* git(repository, ['add', '.']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'base',
          ]);
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: publisherHome});
          yield* runGraphShareInit(config(publisherHome), {
            cas,
            cwd: repository,
            organization: 'acme',
            writeConfig: true,
          });
          yield* git(repository, ['add', '.threadnote/graph-share.json']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'enroll',
          ]);
          yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            threadnoteHome: publisherHome,
          });
          const bootstrapped = yield* runGraphPublisherBootstrap(config(publisherHome), {cas, cwd: repository});
          yield* fs.writeFileString(path.join(repository, 'src', 'next.py'), 'next = 2\n');
          yield* git(repository, ['add', 'src/next.py']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'advance',
          ]);
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: publisherHome});
          const advanced = yield* advanceGraphPublisherFrontier(config(publisherHome), {
            cas,
            cwd: repository,
            forceFreeze: true,
          });
          expect(advanced.published).toBe(true);
          expect(advanced.generation).toBe(bootstrapped.generation + 1);
          expect(advanced.phase === 'published' || advanced.phase === 'collecting').toBe(true);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    180_000,
  );

  effectIt.effect(
    'fails a frozen batch instead of leaving verifying when checkpoint export cannot run',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-graph-share-export-fail-');
          const repository = path.join(root, 'repository');
          const cas = path.join(root, 'cas');
          const publisherHome = path.join(root, 'publisher-home');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"graph-share-export-fail","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(path.join(repository, 'src', 'index.py'), 'shared = 1\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share-export-fail.git']);
          yield* git(repository, ['add', '.']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'base',
          ]);
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: publisherHome});
          yield* runGraphShareInit(config(publisherHome), {
            cas,
            cwd: repository,
            organization: 'acme',
            writeConfig: true,
          });
          yield* git(repository, ['add', '.threadnote/graph-share.json']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'enroll',
          ]);
          yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            threadnoteHome: publisherHome,
          });
          const bootstrapped = yield* runGraphPublisherBootstrap(config(publisherHome), {cas, cwd: repository});
          yield* fs.writeFileString(path.join(repository, 'src', 'next.py'), 'next = 2\n');
          yield* git(repository, ['add', 'src/next.py']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'advance',
          ]);
          yield* fs.writeFileString(path.join(repository, 'src', 'dirty.py'), 'dirty = 1\n');
          const phases = yield* Ref.make<string[]>([]);
          const failed = yield* advanceGraphPublisherFrontier(config(publisherHome), {
            cas,
            cwd: repository,
            forceFreeze: true,
            onMachine: machine => Ref.update(phases, current => [...current, machine.phase]),
          }).pipe(Effect.exit);
          expect(failed._tag).toBe('Failure');
          const walked = yield* Ref.get(phases);
          expect(walked).toContain('frozen');
          expect(walked.at(-1)).toBe('failed');
          expect(walked).not.toContain('published');
          expect(walked).not.toContain('verifying');
          const identity = yield* resolveRepositoryIdentity(repository);
          const coordinator = yield* loadGraphShareCoordinatorState({
            organization: 'acme',
            repositoryId: identity.repositoryId,
            threadnoteHome: publisherHome,
          });
          expect(coordinator.machine.phase).toBe('failed');
          expect(coordinator.machine.generation).toBe(bootstrapped.generation);
          expect(coordinator.machine.publishedFrontier).toBe(bootstrapped.sourceCommit);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    180_000,
  );
});

function config(home: string) {
  return {
    account: 'local' as const,
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'local',
  };
}

function git(repo: string, args: readonly string[]) {
  return runCommandEffect('git', ['-C', repo, ...args]);
}
