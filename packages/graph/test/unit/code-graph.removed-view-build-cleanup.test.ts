import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {mkdtempSync, rmSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import type {CodeGraphBuildStatus} from '@threadnote/graph/build_status';
import {
  CODE_GRAPH_REMOVED_VIEW_BUILD_DIRECTORY_ENTRY_LIMIT,
  CODE_GRAPH_REMOVED_VIEW_BUILD_STATUS_PAGE_LIMIT,
  CODE_GRAPH_REMOVED_VIEW_BUILD_STATUS_LIMIT,
  cleanupCodeGraphRemovedViewBuildStatusUnit,
  codeGraphRemovedViewBuildStatusInventory,
  type CodeGraphRemovedViewBuildCleanupOptions,
} from '@threadnote/graph/removed_view/build_cleanup';
import {codeGraphScopeViewKey} from '@threadnote/graph/scope/identity';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const REPOSITORY_ID = Effect2.pipe('b', EffectString.repeat(64));
const WORKTREE_ID = Effect2.pipe('c', EffectString.repeat(64));
const SNAPSHOT_A = `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`;
const SNAPSHOT_B = `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`;
const BUILD_A = '11111111-1111-1111';
const BUILD_B = '22222222-2222-2222';
const SCOPE_ID = `code-graph-scope:${Effect2.pipe('d', EffectString.repeat(64))}`;
const TestLayer = BunServices.layer;

describe('removed view build-status cleanup', () => {
  effectIt.layer(TestLayer)(it => {
    it.effect('removes one exact terminal status and context while preserving other history and sentinels', () =>
      withFixture(({fs, home, statusDirectory}) =>
        Effect.gen(function* () {
          const exactStatus = buildStatus(BUILD_A, 'completed', SNAPSHOT_A);
          const otherStatus = buildStatus(BUILD_B, 'completed', SNAPSHOT_B);
          yield* writeStatus(fs, statusDirectory, exactStatus);
          yield* writeStatus(fs, statusDirectory, otherStatus);
          yield* writeContext(fs, statusDirectory, BUILD_A);
          yield* fs.writeFileString(join(statusDirectory, 'sentinel.txt'), 'keep', {flag: 'wx', mode: 0o600});

          const result = yield* cleanupCodeGraphRemovedViewBuildStatusUnit(home, CHECKOUT_ID, WORKTREE_ID, SNAPSHOT_A);

          expect(result).toEqual({cursorToken: expect.stringMatching(/^bs1:/u), state: 'progress'});
          expect(yield* fs.exists(join(statusDirectory, `${BUILD_A}.json`))).toBe(false);
          expect(yield* fs.exists(join(statusDirectory, `${BUILD_A}.manager-context`))).toBe(false);
          expect(JSON.parse(yield* fs.readFileString(join(statusDirectory, `${BUILD_B}.json`)))).toEqual(otherStatus);
          expect(yield* fs.readFileString(join(statusDirectory, 'sentinel.txt'))).toBe('keep');

          expect(result.state).toBe('progress');
          if (result.state !== 'progress') return;
          const verification = yield* cleanupCodeGraphRemovedViewBuildStatusUnit(
            home,
            CHECKOUT_ID,
            WORKTREE_ID,
            SNAPSHOT_A,
            result.cursorToken,
          );
          expect(verification.state).toBe('progress');
          if (verification.state !== 'progress') return;
          expect(
            yield* cleanupCodeGraphRemovedViewBuildStatusUnit(
              home,
              CHECKOUT_ID,
              WORKTREE_ID,
              SNAPSHOT_A,
              verification.cursorToken,
            ),
          ).toEqual({state: 'complete'});
        }),
      ),
    );

    it.effect('cleans only the selected scoped build-status sidecar', () =>
      withFixture(({fs, home, statusDirectory}) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const scopedDirectory = path.join(
            path.dirname(statusDirectory),
            codeGraphScopeViewKey(WORKTREE_ID, SCOPE_ID),
          );
          yield* fs.makeDirectory(scopedDirectory, {recursive: true, mode: 0o700});
          const base = buildStatus(BUILD_A, 'completed', SNAPSHOT_A);
          const scoped = {...base, identity: {...base.identity, scopeId: SCOPE_ID}};
          const full = buildStatus(BUILD_A, 'completed', SNAPSHOT_A);
          yield* writeStatus(fs, scopedDirectory, scoped);
          yield* writeStatus(fs, statusDirectory, full);

          const result = yield* cleanupCodeGraphRemovedViewBuildStatusUnit(
            home,
            CHECKOUT_ID,
            WORKTREE_ID,
            SNAPSHOT_A,
            undefined,
            {scopeId: SCOPE_ID},
          );

          expect(result).toEqual({cursorToken: expect.stringMatching(/^bs1:/u), state: 'progress'});
          expect(yield* fs.exists(join(scopedDirectory, `${BUILD_A}.json`))).toBe(false);
          expect(yield* fs.exists(join(statusDirectory, `${BUILD_A}.json`))).toBe(true);
        }),
      ),
    );

    it.effect('preserves running, queued, and terminal records without the exact snapshot result', () =>
      withFixture(({fs, home, statusDirectory}) =>
        Effect.gen(function* () {
          const statuses = [
            buildStatus(BUILD_A, 'running'),
            buildStatus(BUILD_B, 'queued'),
            buildStatus('33333333-3333-3333', 'failed'),
            buildStatus('44444444-4444-4444', 'completed', SNAPSHOT_B),
          ];
          for (const status of statuses) yield* writeStatus(fs, statusDirectory, status);

          const scan = yield* cleanupCodeGraphRemovedViewBuildStatusUnit(home, CHECKOUT_ID, WORKTREE_ID, SNAPSHOT_A);
          expect(scan.state).toBe('progress');
          if (scan.state !== 'progress') return;
          expect(
            yield* cleanupCodeGraphRemovedViewBuildStatusUnit(
              home,
              CHECKOUT_ID,
              WORKTREE_ID,
              SNAPSHOT_A,
              scan.cursorToken,
            ),
          ).toEqual({state: 'complete'});
          for (const status of statuses) {
            expect(JSON.parse(yield* fs.readFileString(join(statusDirectory, `${status.buildId}.json`)))).toEqual(
              status,
            );
          }
        }),
      ),
    );

    it.effect('replays safely when interrupted after context removal and before status removal', () =>
      withFixture(({fs, home, statusDirectory}) =>
        Effect.gen(function* () {
          yield* writeStatus(fs, statusDirectory, buildStatus(BUILD_A, 'completed', SNAPSHOT_A));
          yield* writeContext(fs, statusDirectory, BUILD_A);
          let interrupted = false;
          const first = yield* cleanupCodeGraphRemovedViewBuildStatusUnit(
            home,
            CHECKOUT_ID,
            WORKTREE_ID,
            SNAPSHOT_A,
            undefined,
            {
              afterManagerContextRemoval: () =>
                Effect.sync(() => {
                  interrupted = true;
                }).pipe(Effect.andThen(Effect.fail(TestError.make({message: 'interrupt'})))),
            },
          );

          expect(interrupted).toBe(true);
          expect(first).toEqual({blockedCode: 'io-error', retryAfterMilliseconds: 1_000, state: 'deferred'});
          expect(yield* fs.exists(join(statusDirectory, `${BUILD_A}.manager-context`))).toBe(false);
          expect(yield* fs.exists(join(statusDirectory, `${BUILD_A}.json`))).toBe(true);

          expect(yield* cleanupCodeGraphRemovedViewBuildStatusUnit(home, CHECKOUT_ID, WORKTREE_ID, SNAPSHOT_A)).toEqual(
            {cursorToken: expect.stringMatching(/^bs1:/u), state: 'progress'},
          );
          expect(yield* fs.exists(join(statusDirectory, `${BUILD_A}.json`))).toBe(false);
        }),
      ),
    );

    it.effect('preserves a status replacement observed before final deletion', () =>
      withFixture(({fs, home, statusDirectory}) =>
        Effect.gen(function* () {
          yield* writeStatus(fs, statusDirectory, buildStatus(BUILD_A, 'completed', SNAPSHOT_A));
          yield* writeContext(fs, statusDirectory, BUILD_A);
          const replacement = buildStatus(BUILD_A, 'completed', SNAPSHOT_B);
          const options: CodeGraphRemovedViewBuildCleanupOptions = {
            beforeFinalStatusObservation: () =>
              fs.writeFileString(join(statusDirectory, `${BUILD_A}.json`), `${JSON.stringify(replacement)}\n`, {
                flag: 'w',
                mode: 0o600,
              }),
          };

          const result = yield* cleanupCodeGraphRemovedViewBuildStatusUnit(
            home,
            CHECKOUT_ID,
            WORKTREE_ID,
            SNAPSHOT_A,
            undefined,
            options,
          );

          expect(result).toEqual({blockedCode: 'invalid-sidecar', retryAfterMilliseconds: 30_000, state: 'deferred'});
          expect(JSON.parse(yield* fs.readFileString(join(statusDirectory, `${BUILD_A}.json`)))).toEqual(replacement);
          expect(yield* fs.exists(join(statusDirectory, `${BUILD_A}.manager-context`))).toBe(true);
        }),
      ),
    );

    it.effect('fails closed on malformed and symbolic-link manifests', () =>
      withFixture(({fs, home, root, statusDirectory}) =>
        Effect.gen(function* () {
          const malformed = join(statusDirectory, `${BUILD_A}.json`);
          yield* fs.writeFileString(malformed, '{', {flag: 'wx', mode: 0o600});
          expect(yield* cleanupCodeGraphRemovedViewBuildStatusUnit(home, CHECKOUT_ID, WORKTREE_ID, SNAPSHOT_A)).toEqual(
            {blockedCode: 'invalid-sidecar', retryAfterMilliseconds: 30_000, state: 'deferred'},
          );
          expect(yield* fs.readFileString(malformed)).toBe('{');

          yield* fs.remove(malformed);
          yield* fs.symlink(join(root, 'outside'), malformed);
          expect(yield* cleanupCodeGraphRemovedViewBuildStatusUnit(home, CHECKOUT_ID, WORKTREE_ID, SNAPSHOT_A)).toEqual(
            {blockedCode: 'invalid-sidecar', retryAfterMilliseconds: 30_000, state: 'deferred'},
          );
          expect(yield* fs.readLink(malformed)).toBe(join(root, 'outside'));
        }),
      ),
    );

    it.effect('rejects non-private status mode and a UTF-8-oversize manager context without deletion', () =>
      withFixture(({fs, home, statusDirectory}) =>
        Effect.gen(function* () {
          const status = buildStatus(BUILD_A, 'completed', SNAPSHOT_A);
          const statusFile = join(statusDirectory, `${BUILD_A}.json`);
          yield* writeStatus(fs, statusDirectory, status);
          yield* fs.chmod(statusFile, 0o644);
          expect(yield* cleanupCodeGraphRemovedViewBuildStatusUnit(home, CHECKOUT_ID, WORKTREE_ID, SNAPSHOT_A)).toEqual(
            {blockedCode: 'invalid-sidecar', retryAfterMilliseconds: 30_000, state: 'deferred'},
          );
          expect(yield* fs.exists(statusFile)).toBe(true);

          yield* fs.chmod(statusFile, 0o600);
          const contextFile = join(statusDirectory, `${BUILD_A}.manager-context`);
          yield* fs.writeFileString(
            contextFile,
            `${JSON.stringify({buildId: BUILD_A, schemaVersion: 1, worktreePath: Effect2.pipe('é', EffectString.repeat(2_049))})}\n`,
            {flag: 'wx', mode: 0o600},
          );
          expect(yield* cleanupCodeGraphRemovedViewBuildStatusUnit(home, CHECKOUT_ID, WORKTREE_ID, SNAPSHOT_A)).toEqual(
            {blockedCode: 'invalid-sidecar', retryAfterMilliseconds: 30_000, state: 'deferred'},
          );
          expect(yield* fs.exists(statusFile)).toBe(true);
          expect(yield* fs.exists(contextFile)).toBe(true);
        }),
      ),
    );

    it.effect('reads one bounded content page and catches an exact status inserted behind its cursor', () =>
      withFixture(({fs, home, statusDirectory}) =>
        Effect.gen(function* () {
          const statuses = Array.from({length: CODE_GRAPH_REMOVED_VIEW_BUILD_STATUS_PAGE_LIMIT + 1}, (_, index) =>
            buildStatus(
              Effect2.pipe((index + 1).toString(16), EffectString.padStart(16, '0')),
              'completed',
              SNAPSHOT_B,
            ),
          );
          for (const status of statuses) yield* writeStatus(fs, statusDirectory, status);

          const first = yield* cleanupCodeGraphRemovedViewBuildStatusUnit(home, CHECKOUT_ID, WORKTREE_ID, SNAPSHOT_A);
          expect(first).toEqual({cursorToken: expect.stringMatching(/^bs1:s:/u), state: 'progress'});
          if (first.state !== 'progress') return;

          const tamperedCursor = `${Effect2.pipe(first.cursorToken, EffectString.slice(0, -1))}${Effect2.pipe(first.cursorToken, EffectString.endsWith('0')) ? '1' : '0'}`;
          expect(
            yield* cleanupCodeGraphRemovedViewBuildStatusUnit(
              home,
              CHECKOUT_ID,
              WORKTREE_ID,
              SNAPSHOT_A,
              tamperedCursor,
            ),
          ).toEqual({blockedCode: 'invalid-sidecar', retryAfterMilliseconds: 30_000, state: 'deferred'});

          const inserted = buildStatus('0000000000000000', 'completed', SNAPSHOT_A);
          yield* writeStatus(fs, statusDirectory, inserted);
          const second = yield* cleanupCodeGraphRemovedViewBuildStatusUnit(
            home,
            CHECKOUT_ID,
            WORKTREE_ID,
            SNAPSHOT_A,
            first.cursorToken,
          );
          expect(second).toEqual({cursorToken: expect.stringMatching(/^bs1:v:/u), state: 'progress'});
          expect(yield* fs.exists(join(statusDirectory, `${inserted.buildId}.json`))).toBe(true);
          if (second.state !== 'progress') return;

          const verification = yield* cleanupCodeGraphRemovedViewBuildStatusUnit(
            home,
            CHECKOUT_ID,
            WORKTREE_ID,
            SNAPSHOT_A,
            second.cursorToken,
          );
          expect(verification).toEqual({cursorToken: expect.stringMatching(/^bs1:r:/u), state: 'progress'});
          expect(yield* fs.exists(join(statusDirectory, `${inserted.buildId}.json`))).toBe(false);
        }),
      ),
    );

    it.effect('admits 10k pairs plus cursor recovery files and rejects either bounded inventory overflow', () =>
      Effect.sync(() => {
        const statusNames = Array.from(
          {length: CODE_GRAPH_REMOVED_VIEW_BUILD_STATUS_LIMIT},
          (_, index) => `${Effect2.pipe(index.toString(16), EffectString.padStart(16, '0'))}.json`,
        );
        const pairedContexts = EffectArray.map(
          statusNames,
          name => `${Effect2.pipe(name, EffectString.slice(0, -5))}.manager-context`,
        );
        const maximalLegitimatePage = {
          names: [...statusNames, ...pairedContexts, '.history-prune-cursor', '.history-prune-cursor.tmp'],
          overflow: false,
        } as const;

        expect(maximalLegitimatePage.names).toHaveLength(CODE_GRAPH_REMOVED_VIEW_BUILD_DIRECTORY_ENTRY_LIMIT);
        expect(codeGraphRemovedViewBuildStatusInventory(maximalLegitimatePage)).toEqual(statusNames);
        expect(codeGraphRemovedViewBuildStatusInventory({...maximalLegitimatePage, overflow: true})).toBeUndefined();
        expect(
          codeGraphRemovedViewBuildStatusInventory({
            names: [
              ...statusNames,
              `${Effect2.pipe(CODE_GRAPH_REMOVED_VIEW_BUILD_STATUS_LIMIT.toString(16), EffectString.padStart(16, '0'))}.json`,
            ],
            overflow: false,
          }),
        ).toBeUndefined();
        expect(
          codeGraphRemovedViewBuildStatusInventory({
            names: [...maximalLegitimatePage.names, 'excess'],
            overflow: false,
          }),
        ).toBeUndefined();
      }),
    );
  });
});

function withFixture<A, E, R>(
  use: (fixture: {
    readonly fs: FileSystem.FileSystem;
    readonly home: string;
    readonly root: string;
    readonly statusDirectory: string;
  }) => Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-removed-view-build-cleanup-'))),
        directory => Effect.sync(() => rmSync(directory, {force: true, recursive: true})),
      );
      const home = path.join(root, 'home');
      const statusDirectory = path.join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        CHECKOUT_ID,
        'build-status',
        WORKTREE_ID,
      );
      yield* fs.makeDirectory(statusDirectory, {recursive: true, mode: 0o700});
      return yield* use({fs, home, root, statusDirectory});
    }),
  );
}

function buildStatus(buildId: string, state: CodeGraphBuildStatus['state'], snapshotId?: string): CodeGraphBuildStatus {
  const timestamp = new Date(0).toISOString();
  return {
    buildId,
    counters: {},
    identity: {
      checkoutId: CHECKOUT_ID,
      commit: Effect2.pipe('3', EffectString.repeat(40)),
      repositoryId: REPOSITORY_ID,
      worktreeId: WORKTREE_ID,
    },
    owner: {processId: 42, runtime: 'bun', runtimeVersion: '1.3.14'},
    phase: state === 'queued' ? 'waiting' : 'materializing',
    ...(snapshotId === undefined ? {} : {result: {dirty: false, edges: 1, files: 1, snapshotId, symbols: 1}}),
    schemaVersion: 1,
    state,
    timestamps: {
      ...(state === 'completed' || state === 'failed' ? {completedAt: timestamp} : {}),
      heartbeatAt: timestamp,
      lastProgressAt: timestamp,
      phaseStartedAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function writeStatus(fs: FileSystem.FileSystem, directory: string, status: CodeGraphBuildStatus) {
  return fs.writeFileString(join(directory, `${status.buildId}.json`), `${JSON.stringify(status)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

function writeContext(fs: FileSystem.FileSystem, directory: string, buildId: string) {
  return fs.writeFileString(
    join(directory, `${buildId}.manager-context`),
    `${JSON.stringify({buildId, schemaVersion: 1, worktreePath: '/private/missing-worktree'})}\n`,
    {flag: 'wx', mode: 0o600},
  );
}
