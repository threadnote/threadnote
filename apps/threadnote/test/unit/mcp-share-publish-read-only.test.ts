import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {describe} from 'vitest';
import * as TestClock from 'effect/testing/TestClock';
import {runCommandEffect} from '@threadnote/platform/command';
import {succeedUndefined} from '@threadnote/platform/optional';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runShareSetAccess} from '@threadnote/threadnote/effect/share';
import {runSharePublishTool} from '@threadnote/threadnote/mcp/server/share';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('MCP share-publish team access', () => {
  for (const preview of [true, false]) {
    it.effect(
      `refuses read-only ${preview ? 'preview' : 'publication and push'} without changing either repository`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* publicationFixture();
          yield* runShareSetAccess(fixture.config, {mode: 'read-only'});
          const before = yield* fixture.snapshot();
          const teamsBefore = yield* fixture.fs.readFileString(fixture.teamsPath);
          const result = yield* runSharePublishTool(fixture.config, fixture.sourceUri, {preview, push: true});

          expect({result, state: yield* fixture.snapshot()}).toEqual({
            result: {
              content: [{type: 'text', text: expect.stringContaining('read-only; cannot publish memories')}],
              isError: true,
            },
            state: before,
          });
          expect(yield* fixture.fs.readFileString(fixture.teamsPath)).toBe(teamsBefore);
        }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );
  }

  it.effect.prop(
    'refuses before reading the source regardless of publication options',
    {
      preview: Schema.UndefinedOr(Schema.Boolean),
      push: Schema.UndefinedOr(Schema.Boolean),
      redact: Schema.UndefinedOr(Schema.Boolean),
      allowUncitedPendingCodeRefs: Schema.UndefinedOr(Schema.Boolean),
      team: Schema.UndefinedOr(Schema.Literal('reference')),
    },
    options =>
      Effect.gen(function* () {
        const fixture = yield* publicationFixture();
        yield* runShareSetAccess(fixture.config, {mode: 'read-only'});
        const before = yield* fixture.snapshot();
        const originalOptions = {...options};
        const store = yield* ResourceStore;
        let reads = 0;
        const result = yield* runSharePublishTool(fixture.config, fixture.sourceUri, options).pipe(
          Effect.provideService(
            ResourceStore,
            ResourceStore.of({
              ...store,
              read: () =>
                Effect.sync(() => {
                  reads++;
                  return fixture.content;
                }),
            }),
          ),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          {type: 'text', text: expect.stringContaining('read-only; cannot publish memories')},
        ]);
        expect(reads).toBe(0);
        expect(options).toEqual(originalOptions);
        expect(yield* fixture.snapshot()).toEqual(before);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    {arbitrary: {runs: 24}},
  );

  it.effect('rechecks access under the publication lock after a concurrent public downgrade', () =>
    Effect.gen(function* () {
      const fixture = yield* publicationFixture();
      const before = yield* fixture.snapshot();
      const store = yield* ResourceStore;
      const context = yield* Effect.context<Effect.Services<ReturnType<typeof runShareSetAccess>>>();
      const downgrade = runShareSetAccess(fixture.config, {mode: 'read-only'}).pipe(
        Effect.provide(context),
        Effect.orDie,
      );
      let reads = 0;
      const result = yield* runSharePublishTool(fixture.config, fixture.sourceUri, {push: true}).pipe(
        Effect.provideService(
          ResourceStore,
          ResourceStore.of({
            ...store,
            read: (location, uri) =>
              uri === fixture.sourceUri
                ? Effect.gen(function* () {
                    reads++;
                    if (reads === 1) yield* downgrade;
                    return yield* store.read(location, uri);
                  })
                : store.read(location, uri),
          }),
        ),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {type: 'text', text: expect.stringContaining('read-only; cannot publish memories')},
      ]);
      expect(reads).toBe(1);
      expect(yield* fixture.snapshot()).toEqual(before);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it.effect('still previews and pushes an eligible memory to a writable team', () =>
    Effect.gen(function* () {
      const fixture = yield* publicationFixture();
      const before = yield* fixture.snapshot();
      const preview = yield* runSharePublishTool(fixture.config, fixture.sourceUri, {preview: true});
      expect(preview.isError).not.toBe(true);
      expect(yield* fixture.snapshot()).toEqual(before);

      const result = yield* runSharePublishTool(fixture.config, fixture.sourceUri, {push: true});
      expect(result.isError).toBe(false);
      expect(yield* fixture.fs.exists(fixture.sourcePath)).toBe(false);
      const after = yield* fixture.snapshot();
      expect(after.worktreeHead).not.toBe(before.worktreeHead);
      expect(after.remoteHead).toBe(after.worktreeHead);
      expect(after.worktreeStatus).toBe('');
      expect(after.sharedContent).toContain('Synthetic publication authority control.');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});

const publicationFixture = Effect.fn('test.mcpSharePublishAccessFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-share-access-'});
  const worktree = path.join(home, 'worktree');
  const remote = path.join(home, 'remote.git');
  const teamsPath = path.join(home, 'share', 'teams.json');
  const data = path.join(home, 'data', 'local', 'user', 'tester');
  const relative = path.join('durable', 'projects', 'threadnote', 'authority.md');
  const sourcePath = path.join(data, 'memories', relative);
  const canonicalTarget = path.join(data, 'memories', 'shared', 'reference', relative);
  const content =
    'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: authority\n\nSynthetic publication authority control.\n';
  const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/authority.md';
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'seed-manifest.yaml'),
    user: 'tester',
  };
  const git = (...args: string[]) => runCommandEffect('git', args).pipe(Effect.map(result => result.stdout.trim()));
  yield* fs.makeDirectory(path.dirname(sourcePath), {recursive: true});
  yield* fs.makeDirectory(path.dirname(teamsPath), {recursive: true});
  yield* fs.writeFileString(sourcePath, content);
  yield* git('init', '--bare', '--quiet', remote);
  yield* git('init', '--quiet', '--initial-branch=main', worktree);
  yield* git('-C', worktree, 'config', 'user.name', 'Threadnote Test');
  yield* git('-C', worktree, 'config', 'user.email', 'threadnote@example.test');
  yield* git('-C', worktree, 'config', 'commit.gpgsign', 'false');
  yield* git('-C', worktree, 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic initial state');
  yield* git('-C', worktree, 'remote', 'add', 'origin', remote);
  yield* git('-C', worktree, 'push', '--quiet', '--set-upstream', 'origin', 'main');
  yield* fs.writeFileString(
    teamsPath,
    JSON.stringify({
      version: 1,
      defaultTeam: 'reference',
      teams: {reference: {name: 'reference', addedAt: '2026-10-22T00:00:00Z', gitdir: remote, remote, worktree}},
    }),
  );
  const optionalContent = (file: string) =>
    fs.exists(file).pipe(Effect.flatMap(exists => (exists ? fs.readFileString(file) : succeedUndefined)));
  const snapshot = () =>
    Effect.gen(function* () {
      return {
        sourceContent: yield* optionalContent(sourcePath),
        sharedContent: yield* optionalContent(canonicalTarget),
        worktreeContent: yield* optionalContent(path.join(worktree, relative)),
        worktreeHead: yield* git('-C', worktree, 'rev-parse', 'HEAD'),
        remoteHead: yield* git('--git-dir', remote, 'rev-parse', 'refs/heads/main'),
        worktreeStatus: yield* git('-C', worktree, 'status', '--porcelain'),
      };
    });
  return {config, content, fs, snapshot, sourcePath, sourceUri, teamsPath};
});
