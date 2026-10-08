import fc from 'fast-check';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {ResourceStore} from '@threadnote/store/resource-store';
import {runCommandEffect} from '@threadnote/platform/command';
import {ingestSingleFile, stripPersonalProvenanceForSharedPublication} from '@threadnote/threadnote/share/core';
import {runSharePublish} from '@threadnote/threadnote/effect/share';
import {writeDurableMemory, writeMemoryContentWithExpectedHash} from '@threadnote/threadnote/mcp/server/memory';
import {parseMemoryDocument} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {consolidatedMemory, consolidatedUri, stableRelation} from '../helpers/consolidated-memory.js';

const sharedUri = consolidatedUri.replace('/memories/', '/memories/shared/default/');
const relativePath = 'durable/projects/threadnote/result.md';
const fixture = Effect.fn('test.consolidationBoundaries')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-consolidation-boundary-'});
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    user: 'tester',
    manifestPath: path.join(home, 'manifest.yaml'),
  };
  const worktree = path.join(home, 'share', 'worktrees', 'default');
  const remote = path.join(home, 'team.git');
  yield* fs.makeDirectory(worktree, {recursive: true});
  yield* fs.writeFileString(
    path.join(home, 'share', 'teams.json'),
    JSON.stringify({
      version: 1,
      defaultTeam: 'default',
      teams: {
        default: {
          name: 'default',
          addedAt: '2026-10-08T00:00:00.000Z',
          gitdir: path.join(home, 'team.gitdir'),
          remote,
          worktree,
        },
      },
    }),
  );
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', worktree, ...args]);
  yield* git(['init', '-q', '--initial-branch=main']);
  yield* git(['config', 'user.name', 'Test']);
  yield* git(['config', 'user.email', 'test@example.invalid']);
  yield* git(['commit', '--allow-empty', '-qm', 'fixture']);
  yield* runCommandEffect('git', ['init', '--bare', '-q', remote]);
  yield* git(['remote', 'add', 'origin', remote]);
  yield* git(['push', '-qu', 'origin', 'main']);
  const store = yield* ResourceStore;
  return {fs, path, home, config, worktree, store, location: {account: config.account, home, user: config.user}};
});
function assertSharedProjection(content: string, active: boolean) {
  expect(content).not.toContain('consolidation:');
  expect(content).not.toContain('Private discarded claim.');
  expect(content).not.toContain('Private contextual detail.');
  expect(content).not.toContain('private.ts');
  expect(content).not.toContain('threadnote://user/tester/memories/durable/');
  const record = parseMemoryDocument(sharedUri, content);
  expect(record?.body).toContain('Approved conclusion');
  expect(record?.metadata.consolidationError).toBeUndefined();
  expect(record?.metadata.citationErrors).toBeUndefined();
  expect(record?.metadata.codeCitations?.map(c => c.path) ?? []).toEqual(active ? ['portable.ts'] : []);
  expect(record?.metadata.relations ?? []).toEqual(active ? [{type: 'references', uri: stableRelation}] : []);
}

describe('consolidation at publication and repair boundaries', () => {
  it('keeps shared projection idempotent and preserves bounded arbitrary final prose', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,32}$/), fc.boolean(), (suffix, active) => {
        const memory = consolidatedMemory(`Approved conclusion ${suffix}`, active);
        const projected = stripPersonalProvenanceForSharedPublication(memory.content);
        assertSharedProjection(projected, active);
        expect(parseMemoryDocument(sharedUri, projected)?.body).toBe(memory.body);
        expect(stripPersonalProvenanceForSharedPublication(projected)).toBe(projected);
      }),
      {numRuns: 20},
    );
  });
  it('projects only final prose and portable active evidence, without private derivation', () => {
    for (const active of [false, true]) {
      const memory = consolidatedMemory('Approved conclusion.', active);
      assertSharedProjection(stripPersonalProvenanceForSharedPublication(memory.content), active);
      expect(memory.metadata.consolidation?.sources[0].fragments).toContain('Private discarded claim.');
    }
  });
  effectIt.effect('ingests a real shared file without excluded personal history or dirty local anchors', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const file = f.path.join(f.home, 'inbound.md');
      yield* f.fs.writeFileString(file, consolidatedMemory('Approved conclusion.', false).content);
      yield* ingestSingleFile('threadnote-native', f.config, sharedUri, file, 'create', {quiet: true});
      assertSharedProjection(yield* f.store.read(f.location, sharedUri), false);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('publishes and replaces a shared result with final active evidence only', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const memory = consolidatedMemory();
      yield* f.store.write(f.location, consolidatedUri, memory.content, {mode: 'create'});
      yield* runSharePublish(f.config, consolidatedUri, {push: false});
      assertSharedProjection(yield* f.store.read(f.location, sharedUri), true);
      assertSharedProjection(yield* f.fs.readFileString(f.path.join(f.worktree, relativePath)), true);
      const next = consolidatedMemory('Approved conclusion updated.');
      const result = yield* writeDurableMemory(f.config, {
        bodyText: next.body,
        metadata: next.metadata,
        replaceUri: sharedUri,
        deferRecallIndexRefresh: true,
      });
      expect(result.isError).not.toBe(true);
      assertSharedProjection(yield* f.store.read(f.location, sharedUri), true);
      assertSharedProjection(yield* f.fs.readFileString(f.path.join(f.worktree, relativePath)), true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('refuses an invalid repaired postcondition before canonical writing', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const memory = consolidatedMemory();
      yield* f.store.write(f.location, consolidatedUri, memory.content, {mode: 'create'});
      for (const invalid of [
        memory.content.replace(/Approved conclusion\.$/, 'Unreviewed replacement.'),
        memory.content.replace(/^consolidation:.*\n/mu, ''),
      ]) {
        const result = yield* writeMemoryContentWithExpectedHash(
          f.config,
          'threadnote-native',
          consolidatedUri,
          invalid,
          memory.content,
        );
        expect(result.isError).toBe(true);
        expect(yield* f.store.read(f.location, consolidatedUri)).toBe(memory.content);
      }
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
