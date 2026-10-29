import {Array as EffectArray} from 'effect';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('first dirty index clean-base admission', () => {
  it.effect(
    'shares its verified committed base while keeping dirty symbols local',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-first-dirty-admission-'});
        const repo = path.join(root, 'repository');
        const peer = path.join(root, 'peer');
        const home = path.join(root, 'home');
        yield* fs.makeDirectory(repo);
        yield* fs.writeFileString(path.join(repo, 'package.json'), '{"name":"first-dirty","type":"module"}\n');
        for (let i = 0; i < 12; i++) {
          yield* fs.writeFileString(path.join(repo, `file${i}.ts`), `export const cleanSymbol${i} = ${i};\n`);
        }
        const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
        yield* git(['init', '-q', '--initial-branch=main']);
        yield* git(['add', '.']);
        yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
        yield* git(['worktree', 'add', '-q', '-b', 'peer', peer]);
        yield* fs.writeFileString(path.join(repo, 'file0.ts'), 'export const dirtyOnlyCanary = 42;\n');
        const dirty = yield* indexer.index({cwd: repo, threadnoteHome: home, ensureVectors: false});
        expect(dirty.snapshot.dirty).toBe(true);
        expect(dirty.snapshot.baseSnapshotId).toBeDefined();
        const peerIdentity = yield* resolveRepositoryIdentity(peer);
        const attached = yield* query.attachSharedReadySnapshot(home, peerIdentity, undefined, {
          requestMaintenance: false,
        });
        expect(attached.freshness).toBe('current');
        expect(attached.readySnapshot?.id).toBe(dirty.snapshot.baseSnapshotId);
        const clean = yield* query.inspect({
          cwd: peer,
          threadnoteHome: home,
          operation: 'query',
          query: 'cleanSymbol0',
          refresh: false,
          requestMaintenance: false,
        });
        expect(EffectArray.some(clean.nodes, node => node.name === 'cleanSymbol0')).toBe(true);
        expect(EffectArray.some(clean.nodes, node => node.name === 'dirtyOnlyCanary')).toBe(false);
        const current = yield* query.inspect({
          cwd: repo,
          threadnoteHome: home,
          operation: 'query',
          query: 'dirtyOnlyCanary',
          refresh: true,
          requestMaintenance: false,
        });
        expect(current.freshness).toBe('current');
        expect(current.snapshot.id).toBe(dirty.snapshot.id);
        expect(EffectArray.some(current.nodes, node => node.name === 'dirtyOnlyCanary')).toBe(true);
        const restricted = path.join(root, 'restricted');
        yield* git(['worktree', 'add', '-q', '-b', 'restricted', restricted]);
        yield* fs.writeFileString(path.join(repo, '.git/info/exclude'), 'file1.ts\n');
        const denied = yield* query.attachSharedReadySnapshot(
          home,
          yield* resolveRepositoryIdentity(restricted),
          undefined,
          {requestMaintenance: false},
        );
        expect(denied.freshness).toBe('stale');
        expect(denied.readySnapshot).toBeUndefined();
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );
});
