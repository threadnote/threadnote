import {Array as EffectArray} from 'effect';
import {readdirSync} from '@threadnote/testing/node-fs';
import {Clock, Effect, Fiber} from 'effect';
import {afterEach, describe, expect, it, vi} from 'vitest';

const shareMocks = vi.hoisted(() => ({
  markSharedAutoSyncDeferred: vi.fn(),
  personalUriFor: vi.fn(),
  resolveTeam: vi.fn(),
  runShareConflicts: vi.fn(),
  runSharePublish: vi.fn(),
  runShareSync: vi.fn(),
  runShareUnpublish: vi.fn(),
  shareAgentArtifact: vi.fn(),
  shareBundlePack: vi.fn(),
  refreshSharedReposInBackground: vi.fn(),
  syncSharedReposBeforeAgentRead: vi.fn(),
  sharedUriFor: vi.fn(),
  unused: vi.fn(),
}));

vi.mock('@threadnote/threadnote/share/index', () => ({
  installSharedAgentArtifacts: shareMocks.unused,
  listShareConflicts: shareMocks.unused,
  listSharedAgentArtifacts: shareMocks.unused,
  markSharedAutoSyncDeferred: shareMocks.markSharedAutoSyncDeferred,
  personalUriFor: shareMocks.personalUriFor,
  removeMemoryUri: shareMocks.unused,
  refreshSharedReposInBackground: shareMocks.refreshSharedReposInBackground,
  resolveShareConflict: shareMocks.unused,
  resolveTeam: shareMocks.resolveTeam,
  runShareConflictResolve: shareMocks.unused,
  runShareConflicts: shareMocks.runShareConflicts,
  runShareConflictShow: shareMocks.unused,
  runShareInit: shareMocks.unused,
  runShareInstallArtifacts: shareMocks.unused,
  runShareList: shareMocks.unused,
  runSharePublish: shareMocks.runSharePublish,
  runSharePublishArtifact: shareMocks.unused,
  runSharePublishBundle: shareMocks.unused,
  runShareRemove: shareMocks.unused,
  runShareRename: shareMocks.unused,
  runShareSetUrl: shareMocks.unused,
  runShareStatus: shareMocks.unused,
  runShareSync: shareMocks.runShareSync,
  runShareUnpublish: shareMocks.runShareUnpublish,
  shareAgentArtifact: shareMocks.shareAgentArtifact,
  shareBundlePack: shareMocks.shareBundlePack,
  SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS: 300_000,
  sharedUriFor: shareMocks.sharedUriFor,
  showShareConflict: shareMocks.unused,
  syncSharedReposBeforeAgentRead: shareMocks.syncSharedReposBeforeAgentRead,
}));

import {
  runShareConflicts,
  runSharePublish,
  runShareSync,
  runShareUnpublish,
  syncSharedReposBeforeAgentRead,
} from '@threadnote/threadnote/effect/share';
import {join, mkdir, mkdtemp, rm, utimes, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('Effect share transaction', () => {
  const homes: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  it('pins the resolved default team for both target locking and publication', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-');
    homes.push(agentContextHome);
    let simulatedDefault = 'alpha';
    let publishedTeam: string | undefined;
    shareMocks.resolveTeam.mockImplementation(() =>
      Effect.sync(() => {
        simulatedDefault = 'beta';
        return {
          config: {
            addedAt: '2026-07-23T00:00:00.000Z',
            gitdir: '/test/alpha.git',
            name: 'alpha',
            remote: 'git@example.com:test/alpha.git',
            worktree: '/test/alpha',
          },
          name: 'alpha',
        };
      }),
    );
    shareMocks.sharedUriFor.mockReturnValue(
      'threadnote://user/test-user/memories/shared/alpha/durable/projects/threadnote/recall.md',
    );
    shareMocks.runSharePublish.mockImplementation((_config, _sourceUri, options) =>
      Effect.sync(() => {
        publishedTeam = options.team ?? simulatedDefault;
      }),
    );

    await runEffect(
      runSharePublish(
        {
          account: 'local',
          agentContextHome,
          agentId: 'threadnote',
          user: 'test-user',
        },
        'threadnote://user/test-user/memories/durable/projects/threadnote/recall.md',
        {},
      ),
    );

    expect(publishedTeam).toBe('alpha');
    expect(shareMocks.runSharePublish).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({team: 'alpha'}),
    );
  });

  it('pins the unpublish team and holds both source and target URI locks during apply', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-unpublish-');
    homes.push(agentContextHome);
    const sourceUri = 'threadnote://user/test-user/memories/shared/alpha/durable/projects/threadnote/recall.md';
    const targetUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/recall.md';
    let lockedUriCount = 0;
    let unpublishedTeam: string | undefined;
    shareMocks.resolveTeam.mockReturnValue(
      Effect.succeed({
        config: {
          addedAt: '2026-08-08T00:00:00.000Z',
          gitdir: '/test/alpha.git',
          name: 'alpha',
          remote: 'git@example.com:test/alpha.git',
          worktree: '/test/alpha',
        },
        name: 'alpha',
      }),
    );
    shareMocks.personalUriFor.mockReturnValue(targetUri);
    shareMocks.runShareUnpublish.mockImplementation((_config, _sourceUri, options) =>
      Effect.sync(() => {
        unpublishedTeam = options.team;
        lockedUriCount = EffectArray.filter(readdirSync(join(agentContextHome, 'threadnote', 'memory-locks')), name =>
          Effect2.pipe(name, EffectString.endsWith('.lock')),
        ).length;
      }),
    );

    await runEffect(
      runShareUnpublish({account: 'local', agentContextHome, agentId: 'threadnote', user: 'test-user'}, sourceUri, {}),
    );

    expect(unpublishedTeam).toBe('alpha');
    expect(shareMocks.personalUriFor).toHaveBeenCalledWith(expect.any(Object), sourceUri, 'alpha');
    expect(lockedUriCount).toBe(2);
  });

  it('keeps explicit sync blocked when an interrupted auto-sync Promise is still running', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-sync-');
    homes.push(agentContextHome);
    const events: string[] = [];
    let markFirstStarted: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    const firstBlocked = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const config = {
      account: 'local',
      agentContextHome,
      agentId: 'threadnote',
      user: 'test-user',
    };

    await runEffect(
      Effect.gen(function* () {
        shareMocks.syncSharedReposBeforeAgentRead.mockImplementationOnce(() =>
          Effect.gen(function* () {
            events.push('first:start');
            markFirstStarted?.();
            yield* Effect.promise(() => firstBlocked);
            events.push('first:end');
            return {syncedTeams: [], warnings: []};
          }),
        );
        shareMocks.runShareSync.mockImplementationOnce(() =>
          Effect.sync(() => {
            events.push('second:start');
          }),
        );

        const first = yield* Effect.forkChild(syncSharedReposBeforeAgentRead(config));
        yield* Effect.promise(() => firstStarted);
        const interruption = yield* Effect.forkChild(Fiber.interrupt(first));
        yield* Effect.yieldNow;
        const second = yield* Effect.forkChild(runShareSync(config, {}));
        yield* Effect.yieldNow;
        expect(events).toEqual(['first:start']);
        yield* Effect.sync(() => releaseFirst?.());
        yield* Fiber.join(interruption);
        yield* Fiber.join(second);
      }),
    );

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('quietly defers to a healthy process lease and retries auto-sync on the next read', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-read-lock-');
    homes.push(agentContextHome);
    let markSyncStarted: (() => void) | undefined;
    let releaseSync: (() => void) | undefined;
    const syncStarted = new Promise<void>(resolve => {
      markSyncStarted = resolve;
    });
    const syncBlocked = new Promise<void>(resolve => {
      releaseSync = resolve;
    });
    let automaticReadEntered = false;
    const config = {
      account: 'local',
      agentContextHome,
      agentId: 'threadnote',
      user: 'test-user',
    };

    await runEffect(
      Effect.gen(function* () {
        shareMocks.runShareSync.mockImplementationOnce(() =>
          Effect.gen(function* () {
            markSyncStarted?.();
            yield* Effect.promise(() => syncBlocked);
          }),
        );
        shareMocks.syncSharedReposBeforeAgentRead.mockImplementationOnce(() =>
          Effect.sync(() => {
            automaticReadEntered = true;
            return {syncedTeams: ['default'], warnings: []};
          }),
        );
        const explicitSync = yield* Effect.forkChild(runShareSync(config, {}));
        yield* Effect.promise(() => syncStarted);
        const startedAt = yield* Clock.currentTimeMillis;
        const automaticRead = yield* syncSharedReposBeforeAgentRead(config);
        const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
        expect(automaticRead).toEqual({syncedTeams: [], warnings: []});
        expect(elapsed).toBeLessThan(200);
        expect(automaticReadEntered).toBe(false);

        releaseSync?.();
        yield* Fiber.join(explicitSync);
        const catchUpRead = yield* syncSharedReposBeforeAgentRead(config);

        expect(catchUpRead).toEqual({syncedTeams: ['default'], warnings: []});
        expect(automaticReadEntered).toBe(true);
      }),
    );
  });

  it('keeps an unverifiable repository lock visible as a bounded diagnostic', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-unverified-lock-');
    homes.push(agentContextHome);
    const lockPath = join(agentContextHome, 'threadnote', 'shared-repository.lock');
    await mkdir(join(agentContextHome, 'threadnote'), {recursive: true});
    await writeFile(lockPath, 'not-a-threadnote-lock\n', {mode: 0o600});
    let automaticReadEntered = false;
    shareMocks.syncSharedReposBeforeAgentRead.mockReturnValue(
      Effect.sync(() => {
        automaticReadEntered = true;
        return {syncedTeams: [], warnings: []};
      }),
    );

    const result = await runEffect(
      syncSharedReposBeforeAgentRead({
        account: 'local',
        agentContextHome,
        agentId: 'threadnote',
        user: 'test-user',
      }),
    );

    expect(result).toEqual({
      syncedTeams: [],
      warnings: [
        'Shared repository auto-sync used the local snapshot because the repository lock was stale or unverifiable; run threadnote doctor --dry-run if this warning persists.',
      ],
    });
    expect(result.warnings[0].length).toBeLessThan(200);
    expect(automaticReadEntered).toBe(false);
  });

  it('does not mistake a stale live-owner lease for healthy concurrent work', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-stale-lock-');
    homes.push(agentContextHome);
    const lockPath = join(agentContextHome, 'threadnote', 'shared-repository.lock');
    await mkdir(join(agentContextHome, 'threadnote'), {recursive: true});
    await writeFile(lockPath, `${process.pid}:stalled-owner\n`, {mode: 0o600});
    const stale = new Date(Date.now() - 11 * 60 * 1_000);
    await utimes(lockPath, stale, stale);

    const result = await runEffect(
      syncSharedReposBeforeAgentRead({
        account: 'local',
        agentContextHome,
        agentId: 'threadnote',
        user: 'test-user',
      }),
    );

    expect(result.warnings).toEqual([
      'Shared repository auto-sync used the local snapshot because the repository lock was stale or unverifiable; run threadnote doctor --dry-run if this warning persists.',
    ]);
  });

  it('recovers a dead-owner repository lock instead of silently deferring auto-sync', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-dead-lock-');
    homes.push(agentContextHome);
    const lockPath = join(agentContextHome, 'threadnote', 'shared-repository.lock');
    await mkdir(join(agentContextHome, 'threadnote'), {recursive: true});
    await writeFile(lockPath, '2147483647:dead-owner\n', {mode: 0o600});
    shareMocks.syncSharedReposBeforeAgentRead.mockReturnValue(Effect.succeed({syncedTeams: ['default'], warnings: []}));

    const result = await runEffect(
      syncSharedReposBeforeAgentRead({
        account: 'local',
        agentContextHome,
        agentId: 'threadnote',
        user: 'test-user',
      }),
    );

    expect(result).toEqual({syncedTeams: ['default'], warnings: []});
    expect(shareMocks.syncSharedReposBeforeAgentRead).toHaveBeenCalledOnce();
  });

  it('keeps sync blocked while conflict inspection refreshes pending state', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-conflicts-');
    homes.push(agentContextHome);
    const events: string[] = [];
    let markInspectionStarted: (() => void) | undefined;
    let releaseInspection: (() => void) | undefined;
    const inspectionStarted = new Promise<void>(resolve => {
      markInspectionStarted = resolve;
    });
    const inspectionBlocked = new Promise<void>(resolve => {
      releaseInspection = resolve;
    });
    const config = {
      account: 'local',
      agentContextHome,
      agentId: 'threadnote',
      user: 'test-user',
    };
    shareMocks.runShareConflicts.mockImplementationOnce(() =>
      Effect.gen(function* () {
        events.push('inspection:start');
        markInspectionStarted?.();
        yield* Effect.promise(() => inspectionBlocked);
        events.push('inspection:end');
        return [];
      }),
    );
    shareMocks.runShareSync.mockImplementationOnce(() =>
      Effect.sync(() => {
        events.push('sync:start');
      }),
    );

    await runEffect(
      Effect.gen(function* () {
        const inspection = yield* Effect.forkChild(runShareConflicts(config, {}));
        yield* Effect.promise(() => inspectionStarted);
        const sync = yield* Effect.forkChild(runShareSync(config, {}));
        yield* Effect.yieldNow;
        expect(events).toEqual(['inspection:start']);
        yield* Effect.sync(() => releaseInspection?.());
        yield* Fiber.join(inspection);
        yield* Fiber.join(sync);
      }),
    );

    expect(events).toEqual(['inspection:start', 'inspection:end', 'sync:start']);
  });
});
