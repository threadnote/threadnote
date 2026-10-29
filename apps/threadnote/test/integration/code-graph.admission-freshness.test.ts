import {Array as EffectArray} from 'effect';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {runIsolatedCodeGraphIndexSnapshot} from '@threadnote/graph/isolated/index';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('current graph admission freshness', () => {
  it.effect(
    'recovers real isolated child builds with the same policy-bound request identity',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const query = yield* CodeGraphQueryService;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-isolated-admission-'});
        const repo = path.join(root, 'repository');
        const home = path.join(root, 'home');
        yield* fs.makeDirectory(repo);
        yield* fs.writeFileString(path.join(repo, 'included.ts'), 'export const includedSymbol = 1;\n');
        yield* fs.writeFileString(path.join(repo, 'excluded.ts'), 'export const excludedSymbol = 2;\n');
        const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
        yield* git(['init', '-q', '--initial-branch=main']);
        yield* git(['add', '.']);
        yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
        const first = yield* runIsolatedCodeGraphIndexSnapshot({cwd: repo, threadnoteHome: home, ensureVectors: false});
        expect(first.snapshot.fileCount).toBe(2);
        yield* fs.writeFileString(path.join(repo, '.git/info/exclude'), 'excluded.ts\n');
        const second = yield* runIsolatedCodeGraphIndexSnapshot({
          cwd: repo,
          threadnoteHome: home,
          ensureVectors: false,
        });
        expect(second.snapshot.fileCount).toBe(1);
        const inspected = yield* query.inspect({
          cwd: repo,
          threadnoteHome: home,
          operation: 'query',
          query: 'excludedSymbol',
          refresh: true,
          requestMaintenance: false,
        });
        expect(inspected.freshness).toBe('current');
        expect(EffectArray.some(inspected.nodes, node => node.name === 'excludedSymbol')).toBe(false);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );

  it.effect(
    'refreshes clean and dirty graphs after policy changes, including changes during a query',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-admission-freshness-'});
        const repo = path.join(root, 'repository');
        const home = path.join(root, 'home');
        yield* fs.makeDirectory(path.join(repo, 'src'), {recursive: true});
        yield* fs.writeFileString(path.join(repo, 'package.json'), '{"name":"admission-freshness","type":"module"}\n');
        yield* fs.writeFileString(path.join(repo, 'src/included.ts'), 'export const includedSymbol = 1;\n');
        yield* fs.writeFileString(path.join(repo, 'src/excluded.ts'), 'export const excludedSymbol = 2;\n');
        const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
        yield* git(['init', '-q', '--initial-branch=main']);
        yield* git(['add', '.']);
        yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
        const exclude = path.join(repo, '.git/info/exclude');
        const inspect = () =>
          query.inspect({
            cwd: repo,
            threadnoteHome: home,
            operation: 'query',
            query: 'excludedSymbol',
            refresh: true,
            requestMaintenance: false,
          });
        for (const dirty of [false, true]) {
          yield* fs.writeFileString(exclude, '');
          if (dirty)
            yield* fs.writeFileString(path.join(repo, 'src/included.ts'), 'export const includedSymbol = 3;\n');
          const indexed = yield* indexer.index({cwd: repo, threadnoteHome: home, ensureVectors: false});
          expect(indexed.snapshot.dirty).toBe(dirty);
          if (!dirty) {
            const peer = path.join(root, 'peer');
            const restricted = path.join(root, 'restricted');
            yield* git(['config', 'extensions.worktreeConfig', 'true']);
            yield* git(['worktree', 'add', '-q', '-b', 'peer', peer]);
            yield* git(['worktree', 'add', '-q', '-b', 'restricted', restricted]);
            const peerIdentity = yield* resolveRepositoryIdentity(peer);
            const shared = yield* query.attachSharedReadySnapshot(home, peerIdentity, undefined, {
              requestMaintenance: false,
            });
            expect(shared.freshness).toBe('current');
            expect(shared.readySnapshot?.id).toBe(indexed.snapshot.id);
            yield* fs.writeFileString(exclude, 'src/excluded.ts\n');
            const reobserved = yield* query.attachSharedReadySnapshot(home, peerIdentity, shared, {
              requestMaintenance: false,
            });
            expect(reobserved.freshness).toBe('stale');
            yield* fs.writeFileString(exclude, '');
            const peerExcludes = path.join(root, 'peer-excludes');
            yield* fs.writeFileString(peerExcludes, 'src/excluded.ts\n');
            yield* runCommandEffect('git', [
              '-C',
              restricted,
              'config',
              '--worktree',
              'core.excludesFile',
              peerExcludes,
            ]);
            const restrictedIdentity = yield* resolveRepositoryIdentity(restricted);
            const denied = yield* query.attachSharedReadySnapshot(home, restrictedIdentity, undefined, {
              requestMaintenance: false,
            });
            expect(denied.freshness).toBe('stale');
            expect(denied.readySnapshot).toBeUndefined();
            const concurrent = yield* Effect.all(
              [
                indexer.index({cwd: repo, threadnoteHome: home, ensureVectors: false}),
                indexer.index({cwd: restricted, threadnoteHome: home, ensureVectors: false}),
              ],
              {concurrency: 2},
            );
            expect(concurrent[0].snapshot.graphContentId).not.toBe(concurrent[1].snapshot.graphContentId);
            const restrictedQuery = yield* query.inspect({
              cwd: restricted,
              threadnoteHome: home,
              operation: 'query',
              query: 'excludedSymbol',
              refresh: true,
              requestMaintenance: false,
            });
            expect(restrictedQuery.freshness).toBe('current');
            expect(EffectArray.some(restrictedQuery.nodes, node => node.name === 'excludedSymbol')).toBe(false);
          }
          yield* fs.writeFileString(exclude, 'src/excluded.ts\n');
          const excluded = yield* inspect();
          expect(excluded.freshness).toBe('current');
          expect(EffectArray.some(excluded.nodes, node => node.name === 'excludedSymbol')).toBe(false);
          yield* fs.writeFileString(exclude, '# comment-only policy\n');
          const restored = yield* inspect();
          expect(restored.freshness).toBe('current');
          expect(EffectArray.some(restored.nodes, node => node.name === 'excludedSymbol')).toBe(true);
          yield* fs.writeFileString(exclude, '# different comment, same admission\n');
          expect((yield* inspect()).freshness).toBe('current');
        }
        let changed = false;
        const raced = yield* query.inspect({
          cwd: repo,
          threadnoteHome: home,
          operation: 'query',
          query: 'excludedSymbol',
          refresh: true,
          requestMaintenance: false,
          interlock: {
            afterSnapshotSelected: () =>
              Effect.gen(function* () {
                if (!changed) {
                  changed = true;
                  yield* fs.writeFileString(exclude, 'src/excluded.ts\n');
                }
              }).pipe(Effect.orDie),
          },
        });
        expect(raced.freshness).toBe('current');
        expect(EffectArray.some(raced.nodes, node => node.name === 'excludedSymbol')).toBe(false);
        yield* fs.writeFileString(exclude, '');
        let changedDuringIndex = false;
        yield* indexer.index({
          cwd: repo,
          threadnoteHome: home,
          ensureVectors: false,
          onProgress: progress =>
            Effect.gen(function* () {
              if (!changedDuringIndex && progress.phase === 'activating' && progress.subphase === 'complete') {
                changedDuringIndex = true;
                yield* fs.writeFileString(exclude, 'src/excluded.ts\n');
              }
            }),
        });
        expect(changedDuringIndex).toBe(true);
        const afterLateIndexChange = yield* inspect();
        expect(afterLateIndexChange.freshness).toBe('current');
        expect(EffectArray.some(afterLateIndexChange.nodes, node => node.name === 'excludedSymbol')).toBe(false);
        yield* fs.writeFileString(exclude, '');
        yield* git(['add', 'src/included.ts']);
        yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'next layer']);
        const layered = yield* indexer.index({cwd: repo, threadnoteHome: home, ensureVectors: false});
        expect(layered.snapshot.dirty).toBe(false);
        expect(layered.snapshot.baseSnapshotId).toBeDefined();
        yield* fs.writeFileString(exclude, 'src/excluded.ts\n');
        const afterLayerPolicyChange = yield* inspect();
        expect(afterLayerPolicyChange.freshness).toBe('current');
        expect(EffectArray.some(afterLayerPolicyChange.nodes, node => node.name === 'excludedSymbol')).toBe(false);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );
});
