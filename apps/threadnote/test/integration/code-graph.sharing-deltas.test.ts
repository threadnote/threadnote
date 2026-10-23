import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {makeIdempotentFixtureTempDirectoryScoped} from '@threadnote/testing/fixture-temp-directory';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {parseGraphShareFrontierManifest, parseGraphShareFrontierPointer} from '@threadnote/graph/sharing/artifacts';
import {decodeJsonBytes, readJsonFile} from '@threadnote/graph/sharing/atomic';
import {readVerifiedCasBlob} from '@threadnote/graph/sharing/cas';
import {maybeImportSharedGraphBase, runGraphShareJoin} from '@threadnote/graph/sharing/client';
import {graphSharingFrontierPointerPath, graphSharingLayout} from '@threadnote/graph/sharing/layout';
import {advanceGraphPublisherFrontier} from '@threadnote/graph/sharing/publisher/cycle';
import {runGraphPublisherBootstrap, runGraphShareInit} from '@threadnote/threadnote/code_graph/sharing/publisher';
import {loadSharedGraphQuerySource, writeSharedGraphProvenance} from '@threadnote/graph/sharing/provenance';
import {CodeGraphStore} from '@threadnote/graph/store';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

describe('graph share TCG1 delta publication and apply', () => {
  effectIt.effect(
    'publishes one delta, imports it on a second home, reapplies as a no-op, and keeps ready on a wrong base',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-deltas-'});
          const repository = path.join(root, 'repository');
          const cas = path.join(root, 'cas');
          const publisherHome = path.join(root, 'publisher-home');
          const clientHome = path.join(root, 'client-home');
          const cleanHome = path.join(root, 'clean-home');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"graph-share-deltas","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const shared = 1;\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['config', 'core.ignorecase', 'false']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share-deltas.git']);
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
          yield* git(repository, ['config', 'core.ignorecase', 'true']);
          yield* runGraphShareJoin(config(clientHome), {cas, cwd: repository});
          expect(
            yield* maybeImportSharedGraphBase({
              cwd: repository,
              identity: yield* resolveRepositoryIdentity(repository),
              threadnoteHome: clientHome,
            }),
          ).toMatchObject({imported: true, checkpointDigest: bootstrapped.checkpointDigest});
          const firstImport = yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            threadnoteHome: clientHome,
          });
          expect(firstImport.snapshot.id).toMatch(/^cgsn_/);
          yield* fs.writeFileString(path.join(repository, 'src', 'next.ts'), 'export const next = 2;\n');
          yield* git(repository, ['add', 'src/next.ts']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'advance',
          ]);
          yield* git(repository, ['config', 'core.ignorecase', 'false']);
          yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            threadnoteHome: publisherHome,
          });
          const advanced = yield* advanceGraphPublisherFrontier(config(publisherHome), {
            cas,
            cwd: repository,
            forceFreeze: true,
          });
          expect(advanced.published).toBe(true);
          expect(advanced.generation).toBe(bootstrapped.generation + 1);
          const identity = yield* resolveRepositoryIdentity(repository);
          const frontier = yield* readPublishedFrontier(publisherHome, cas, identity.repositoryId);
          expect(frontier.checkpoint.manifestDigest).toBe(bootstrapped.checkpointDigest);
          expect(frontier.deltas).toHaveLength(1);
          expect(frontier.deltas[0]?.targetCommit).toBe(identity.headCommit);
          expect(frontier.sourceCommit).toBe(identity.headCommit);
          yield* git(repository, ['config', 'core.ignorecase', 'true']);
          const clientApplied = yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            threadnoteHome: clientHome,
          });
          const clean = yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: cleanHome});
          expect(clientApplied.snapshot.commit).toBe(clean.snapshot.commit);
          expect(clientApplied.snapshot.fileCount).toBe(clean.snapshot.fileCount);
          expect(clientApplied.snapshot.symbolCount).toBe(clean.snapshot.symbolCount);
          expect(clientApplied.snapshot.graphContentId).toBe(clean.snapshot.graphContentId);
          expect(
            yield* loadSharedGraphQuerySource({
              checkoutId: identity.checkoutId,
              localCommit: identity.headCommit,
              repositoryId: identity.repositoryId,
              snapshot: clientApplied.snapshot,
              threadnoteHome: clientHome,
            }),
          ).toMatchObject({deltaCount: 1, kind: 'shared-base-plus-local-overlay'});
          expect(
            yield* loadSharedGraphQuerySource({
              checkoutId: identity.checkoutId,
              localCommit: identity.headCommit,
              repositoryId: identity.repositoryId,
              snapshot: clean.snapshot,
              threadnoteHome: cleanHome,
            }),
          ).toBeUndefined();
          const reapply = yield* maybeImportSharedGraphBase({
            cwd: repository,
            identity,
            threadnoteHome: clientHome,
          });
          expect(reapply).toMatchObject({
            imported: false,
            reason: 'already-installed',
            snapshotId: frontier.snapshotId,
            checkpointDigest: frontier.checkpoint.manifestDigest,
          });
          yield* writeSharedGraphProvenance(clientHome, identity.checkoutId, {
            checkpointDigest: `sha256:${'9'.repeat(64)}`,
            deltaCount: 0,
            frontierCommit: frontier.sourceCommit,
            profileDigest: frontier.profileDigest,
            repositoryId: identity.repositoryId,
            schemaVersion: 1,
            snapshotId: clientApplied.snapshot.id,
          });
          const wrongBase = yield* maybeImportSharedGraphBase({
            cwd: repository,
            identity,
            threadnoteHome: clientHome,
          });
          expect(wrongBase).toEqual({imported: false, reason: 'quarantined'});
          const clientLayout = codeGraphLayout(path, clientHome, identity.checkoutId, identity.worktreeId);
          const ready = yield* store.readySnapshot(clientLayout.databasePath, identity.worktreeId);
          expect(ready?.id).toBe(clientApplied.snapshot.id);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    180_000,
  );

  effectIt.effect(
    'publishes compaction when the overlay closure proof is incomplete',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-graph-share-compact-');
          const repository = path.join(root, 'repository');
          const cas = path.join(root, 'cas');
          const publisherHome = path.join(root, 'publisher-home');
          const clientHome = path.join(root, 'client-home');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"graph-share-compact","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const shared = 1;\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share-compact.git']);
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
          yield* runGraphShareJoin(config(clientHome), {cas, cwd: repository});
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: clientHome});
          yield* fs.makeDirectory(path.join(repository, 'packages', 'lib', 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"graph-share-compact","private":true,"type":"module","workspaces":["packages/*"]}\n',
          );
          yield* fs.writeFileString(
            path.join(repository, 'packages', 'lib', 'package.json'),
            '{"name":"@acme/lib","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(
            path.join(repository, 'packages', 'lib', 'src', 'index.ts'),
            'export const lib = 1;\n',
          );
          yield* git(repository, ['add', '.']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'workspace',
          ]);
          yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            threadnoteHome: publisherHome,
          });
          const advanced = yield* advanceGraphPublisherFrontier(config(publisherHome), {
            cas,
            cwd: repository,
            forceFreeze: true,
          });
          expect(advanced.published).toBe(true);
          const identity = yield* resolveRepositoryIdentity(repository);
          const frontier = yield* readPublishedFrontier(publisherHome, cas, identity.repositoryId);
          expect(frontier.deltas).toEqual([]);
          expect(frontier.checkpoint.manifestDigest).not.toBe(bootstrapped.checkpointDigest);
          expect(frontier.checkpoint.sourceCommit).toBe(identity.headCommit);
          const applied = yield* maybeImportSharedGraphBase({
            cwd: repository,
            identity,
            threadnoteHome: clientHome,
          });
          expect(applied).toMatchObject({
            imported: true,
            checkpointDigest: frontier.checkpoint.manifestDigest,
          });
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

const readPublishedFrontier = Effect.fn('test.graphShare.readPublishedFrontier')(function* (
  threadnoteHome: string,
  casRoot: string,
  repositoryId: string,
) {
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome, casRoot);
  const pointer = parseGraphShareFrontierPointer(
    yield* readJsonFile(graphSharingFrontierPointerPath(path, layout.frontiersRoot, repositoryId)),
  );
  return parseGraphShareFrontierManifest(
    yield* decodeJsonBytes(yield* readVerifiedCasBlob(casRoot, pointer.manifestDigest)),
  );
});
