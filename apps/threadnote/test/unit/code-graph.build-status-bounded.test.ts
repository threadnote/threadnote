import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'fast-check';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  CODE_GRAPH_BUILD_HISTORY_DIRECTORY_ENTRY_LIMIT,
  CODE_GRAPH_BUILD_HISTORY_STATUS_LIMIT,
  type CodeGraphBuildState,
  type CodeGraphBuildStatus,
  type ObservedCodeGraphBuildStatus,
  codeGraphBuildHistoryInventory,
  maintainCodeGraphBuildHistoryUnit,
  makeCodeGraphBuildReporter,
  pruneCodeGraphBuildHistoryUnit,
  parseCodeGraphBuildStatus,
  readAllCodeGraphBuildStatuses,
} from '@threadnote/graph/build_status';
import {
  CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS,
  codeGraphFailedBuildStatusRemovable,
} from '@threadnote/graph/build_status/validation';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

const BuildStatusTestLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const EXPECTED_BUILD_HISTORY_STATUS_LIMIT = 10_000;
const EXPECTED_BUILD_HISTORY_DIRECTORY_ENTRY_LIMIT = 20_002;

describe('bounded code graph build-status maintenance', () => {
  effectIt.layer(BuildStatusTestLayer)(it => {
    it.effect('keeps Manager context observation-only for an abandoned build', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-status-observation-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
          yield* reporter.progress({completed: 1, phase: 'materializing', reused: 0, total: 2, unit: 'files'});

          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          const statusName = EffectOption.getOrUndefined(
            EffectArray.findFirst(
              yield* fs.readDirectory(directory),
              __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
            ),
          )!;
          const statusPath = path.join(directory, statusName);
          const status = parseCodeGraphBuildStatus(JSON.parse(yield* fs.readFileString(statusPath)));
          if (!status) throw TestError.make({message: 'Expected the written code graph build status.'});
          yield* fs.writeFileString(
            statusPath,
            `${JSON.stringify({...status, owner: {...status.owner, processId: 2_147_483_647}})}\n`,
          );
          const contextName = `${status.buildId}.manager-context`;

          const observed = yield* readAllCodeGraphBuildStatuses(home);

          expect(observed).toHaveLength(1);
          expect(observed[0]?.observation).toMatchObject({liveness: 'abandoned', reason: 'owner-exited'});
          expect(observed[0]?.managerContext).toBeUndefined();
          expect(yield* fs.exists(path.join(directory, contextName))).toBe(true);
        }),
      ),
    );

    it.effect('removes one exact abandoned waiter pair without requiring a successor reporter', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-abandoned-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          const status = {
            ...fixtureStatus(identity, Effect2.pipe('a', EffectString.repeat(32)), 0, 'queued'),
            owner: {
              processId: 2_147_483_647,
              processStartIdentity: 'dead-process-instance',
              runtime: 'bun' as const,
              runtimeVersion: '1.3.14',
            },
          };
          yield* writeStatusPair(fs, path, directory, status);

          expect(yield* maintainCodeGraphBuildHistoryUnit(layout, identity.worktreeId)).toEqual({
            cursorToken: 'bh1:r',
            removedAbandoned: true,
            state: 'progress',
          });
          expect(yield* fs.exists(path.join(directory, `${status.buildId}.json`))).toBe(false);
          expect(yield* fs.exists(path.join(directory, `${status.buildId}.manager-context`))).toBe(false);
        }),
      ),
    );

    it.effect('removes one expired failed receipt without requiring a successor reporter', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-expired-failed-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          const status = fixtureStatus(identity, Effect2.pipe('a', EffectString.repeat(32)), 0, 'failed');
          yield* writeStatusPair(fs, path, directory, status);
          yield* TestClock.setTime(
            Date.parse(status.timestamps.completedAt!) + CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS + 1,
          );

          expect(yield* maintainCodeGraphBuildHistoryUnit(layout, identity.worktreeId)).toEqual({
            cursorToken: 'bh1:r',
            state: 'progress',
          });
          expect(yield* fs.exists(path.join(directory, `${status.buildId}.json`))).toBe(false);
          expect(yield* fs.exists(path.join(directory, `${status.buildId}.manager-context`))).toBe(false);
        }),
      ),
    );

    it.effect('preserves a failed receipt until its retention window elapses', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-recent-failed-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          const status = fixtureStatus(identity, Effect2.pipe('a', EffectString.repeat(32)), 0, 'failed');
          yield* writeStatusPair(fs, path, directory, status);
          yield* TestClock.setTime(
            Date.parse(status.timestamps.completedAt!) + CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS,
          );

          expect(yield* maintainCodeGraphBuildHistoryUnit(layout, identity.worktreeId)).toEqual({state: 'complete'});
          expect(yield* fs.exists(path.join(directory, `${status.buildId}.json`))).toBe(true);
          expect(yield* fs.exists(path.join(directory, `${status.buildId}.manager-context`))).toBe(true);
        }),
      ),
    );

    it.effect('preserves a heartbeat-stalled live waiter and an abandoned status with an exact lock owner', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-protected-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          const live = fixtureStatus(identity, Effect2.pipe('b', EffectString.repeat(32)), 0, 'queued');
          yield* writeStatusPair(fs, path, directory, live);

          expect(yield* maintainCodeGraphBuildHistoryUnit(layout, identity.worktreeId)).toEqual({state: 'complete'});
          expect(yield* fs.exists(path.join(directory, `${live.buildId}.json`))).toBe(true);

          yield* fs.remove(path.join(directory, `${live.buildId}.json`));
          yield* fs.remove(path.join(directory, `${live.buildId}.manager-context`));
          const locked = {
            ...fixtureStatus(identity, Effect2.pipe('c', EffectString.repeat(32)), 1, 'queued'),
            owner: {
              processId: 2_147_483_647,
              processStartIdentity: 'locked-process-instance',
              runtime: 'bun' as const,
              runtimeVersion: '1.3.14',
            },
          };
          yield* writeStatusPair(fs, path, directory, locked);
          yield* fs.makeDirectory(layout.worktreeLockRoot, {recursive: true});
          yield* fs.writeFileString(
            path.join(layout.worktreeLockRoot, `${identity.worktreeId}.lock`),
            `${JSON.stringify({
              processId: locked.owner.processId,
              processStartIdentity: locked.owner.processStartIdentity,
              token: 'exact-owner-token',
              version: 1,
            })}\n`,
            {flag: 'wx', mode: 0o600},
          );

          expect(yield* maintainCodeGraphBuildHistoryUnit(layout, identity.worktreeId)).toEqual({state: 'complete'});
          expect(yield* fs.exists(path.join(directory, `${locked.buildId}.json`))).toBe(true);
          expect(yield* fs.exists(path.join(directory, `${locked.buildId}.manager-context`))).toBe(true);
        }),
      ),
    );

    it.effect('removes at most one exact terminal history pair per bounded maintenance unit', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-unit-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          const statuses = Array.from({length: 11}, (_, index) =>
            fixtureStatus(identity, `${Effect2.pipe(index.toString(16), EffectString.padStart(16, '0'))}`, index),
          );
          for (const status of statuses) {
            yield* writeStatusPair(fs, path, directory, status);
          }
          yield* fs.writeFileString(path.join(directory, 'sentinel.txt'), 'keep', {flag: 'wx', mode: 0o600});
          const currentBuildId = statuses.at(-1)!.buildId;

          const before = yield* fs.readDirectory(directory);
          const result = yield* pruneCodeGraphBuildHistoryUnit(layout, identity.worktreeId, currentBuildId);
          const after = yield* fs.readDirectory(directory);
          const removed = EffectArray.filter(before, name => !after.includes(name)).sort();

          expect(result).toEqual({cursorToken: 'bh1:r', state: 'progress'});
          expect(removed).toEqual(['0000000000000000.json', '0000000000000000.manager-context']);
          expect(yield* fs.exists(path.join(directory, `${currentBuildId}.json`))).toBe(true);
          expect(yield* fs.readFileString(path.join(directory, 'sentinel.txt'))).toBe('keep');
        }),
      ),
    );

    it.effect('preserves an in-place status replacement observed before exact pair removal', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-replacement-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          const statuses = Array.from({length: 9}, (_, index) =>
            fixtureStatus(identity, `${Effect2.pipe(index.toString(16), EffectString.padStart(16, '0'))}`, index),
          );
          for (const status of statuses) yield* writeStatusPair(fs, path, directory, status);
          const target = statuses[0];
          const replacement = {
            ...target,
            error: {summary: 'replacement'},
            state: 'failed' as const,
          };

          const result = yield* pruneCodeGraphBuildHistoryUnit(
            layout,
            identity.worktreeId,
            statuses.at(-1)!.buildId,
            undefined,
            {
              beforeFinalStatusObservation: () =>
                fs.writeFileString(path.join(directory, `${target.buildId}.json`), `${JSON.stringify(replacement)}\n`, {
                  flag: 'w',
                  mode: 0o600,
                }),
            },
          );

          expect(result).toEqual({
            blockedCode: 'invalid-sidecar',
            retryAfterMilliseconds: 30_000,
            state: 'deferred',
          });
          expect(JSON.parse(yield* fs.readFileString(path.join(directory, `${target.buildId}.json`)))).toEqual(
            replacement,
          );
          expect(yield* fs.exists(path.join(directory, `${target.buildId}.manager-context`))).toBe(true);
        }),
      ),
    );

    it.effect('replays safely after interruption between context and status removal', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-replay-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          const statuses = Array.from({length: 9}, (_, index) =>
            fixtureStatus(identity, `${Effect2.pipe(index.toString(16), EffectString.padStart(16, '0'))}`, index),
          );
          for (const status of statuses) yield* writeStatusPair(fs, path, directory, status);
          const target = statuses[0];
          const currentBuildId = statuses.at(-1)!.buildId;

          const interrupted = yield* pruneCodeGraphBuildHistoryUnit(
            layout,
            identity.worktreeId,
            currentBuildId,
            undefined,
            {afterManagerContextRemoval: () => Effect.fail(TestError.make({message: 'interrupt'}))},
          );

          expect(interrupted).toEqual({blockedCode: 'io-error', retryAfterMilliseconds: 1_000, state: 'deferred'});
          expect(yield* fs.exists(path.join(directory, `${target.buildId}.manager-context`))).toBe(false);
          expect(yield* fs.exists(path.join(directory, `${target.buildId}.json`))).toBe(true);

          expect(yield* pruneCodeGraphBuildHistoryUnit(layout, identity.worktreeId, currentBuildId)).toEqual({
            cursorToken: 'bh1:r',
            state: 'progress',
          });
          expect(yield* fs.exists(path.join(directory, `${target.buildId}.json`))).toBe(false);
        }),
      ),
    );

    it.effect('advances past a full nonterminal prefix to one later terminal pair', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-late-terminal-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          const prefix = Array.from({length: 29}, (_, index) =>
            fixtureStatus(
              identity,
              `${Effect2.pipe('-', EffectString.repeat(16))}${Effect2.pipe(index.toString(16), EffectString.padStart(2, '0'))}`,
              index,
              'queued',
            ),
          );
          const terminal = Array.from({length: 9}, (_, index) =>
            fixtureStatus(identity, `f${Effect2.pipe(index.toString(16), EffectString.padStart(15, '0'))}`, 30 + index),
          );
          for (const status of [...prefix, ...terminal]) yield* writeStatusPair(fs, path, directory, status);
          const protectedBuildId = terminal.at(-1)!.buildId;

          const first = yield* pruneCodeGraphBuildHistoryUnit(layout, identity.worktreeId, protectedBuildId);

          expect(first).toEqual({cursorToken: `bh1:s:${prefix.at(-1)!.buildId}`, state: 'progress'});
          expect(yield* fs.exists(path.join(directory, `${terminal[0].buildId}.json`))).toBe(true);
          if (first.state !== 'progress') return;

          expect(
            yield* pruneCodeGraphBuildHistoryUnit(layout, identity.worktreeId, protectedBuildId, first.cursorToken),
          ).toEqual({cursorToken: 'bh1:r', state: 'progress'});
          expect(yield* fs.exists(path.join(directory, `${terminal[0].buildId}.json`))).toBe(false);
          expect(yield* fs.exists(path.join(directory, `${terminal[0].buildId}.manager-context`))).toBe(false);
          for (const status of prefix) {
            expect(yield* fs.exists(path.join(directory, `${status.buildId}.json`))).toBe(true);
          }
        }),
      ),
    );

    it.effect('persists reporter progress across builds so a late terminal pair converges', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-reporter-cursor-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          const prefix = Array.from({length: 29}, (_, index) =>
            fixtureStatus(
              identity,
              `${Effect2.pipe('-', EffectString.repeat(16))}${Effect2.pipe(index.toString(16), EffectString.padStart(2, '0'))}`,
              index,
              'queued',
            ),
          );
          const terminal = Array.from({length: 9}, (_, index) =>
            fixtureStatus(identity, `f${Effect2.pipe(index.toString(16), EffectString.padStart(15, '0'))}`, 30 + index),
          );
          for (const status of [...prefix, ...terminal]) yield* writeStatusPair(fs, path, directory, status);

          const firstReporter = yield* makeCodeGraphBuildReporter(identity, layout);
          yield* firstReporter.completeSnapshot(fixtureSnapshot(identity));

          expect(yield* fs.exists(path.join(directory, '.history-prune-cursor'))).toBe(true);
          expect(yield* fs.exists(path.join(directory, `${terminal[0].buildId}.json`))).toBe(true);

          const secondReporter = yield* makeCodeGraphBuildReporter(identity, layout);
          yield* secondReporter.completeSnapshot(fixtureSnapshot(identity));

          expect(yield* fs.exists(path.join(directory, '.history-prune-cursor'))).toBe(false);
          expect(yield* fs.exists(path.join(directory, `${terminal[0].buildId}.json`))).toBe(false);
          expect(yield* fs.exists(path.join(directory, `${terminal[0].buildId}.manager-context`))).toBe(false);
        }),
      ),
    );

    it.effect('recovers a cursor temporary left by interruption before atomic rename', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-cursor-crash-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          const prefix = Array.from({length: 29}, (_, index) =>
            fixtureStatus(
              identity,
              `${Effect2.pipe('-', EffectString.repeat(16))}${Effect2.pipe(index.toString(16), EffectString.padStart(2, '0'))}`,
              index,
              'queued',
            ),
          );
          const terminal = Array.from({length: 9}, (_, index) =>
            fixtureStatus(identity, `f${Effect2.pipe(index.toString(16), EffectString.padStart(15, '0'))}`, 30 + index),
          );
          for (const status of [...prefix, ...terminal]) yield* writeStatusPair(fs, path, directory, status);
          const first = yield* pruneCodeGraphBuildHistoryUnit(layout, identity.worktreeId, terminal.at(-1)!.buildId);
          expect(first.state).toBe('progress');
          if (first.state !== 'progress') return;
          const temporary = path.join(directory, '.history-prune-cursor.tmp');
          yield* fs.writeFileString(
            temporary,
            `${JSON.stringify({cursorToken: first.cursorToken, schemaVersion: 1})}\n`,
            {flag: 'wx', mode: 0o600},
          );

          const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
          yield* reporter.completeSnapshot(fixtureSnapshot(identity));

          expect(yield* fs.exists(temporary)).toBe(false);
          expect(yield* fs.exists(path.join(directory, '.history-prune-cursor'))).toBe(false);
          expect(yield* fs.exists(path.join(directory, `${terminal[0].buildId}.json`))).toBe(false);
          expect(yield* fs.exists(path.join(directory, `${terminal[0].buildId}.manager-context`))).toBe(false);
        }),
      ),
    );

    it.effect('refuses a symlinked worktree directory without changing the external target', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-symlink-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const statusRoot = path.join(layout.repositoryRoot, 'build-status');
          const directory = path.join(statusRoot, identity.worktreeId);
          const outside = path.join(home, 'outside-build-history');
          yield* fs.makeDirectory(statusRoot, {recursive: true, mode: 0o700});
          yield* fs.makeDirectory(outside, {recursive: true, mode: 0o700});
          const statuses = Array.from({length: 9}, (_, index) =>
            fixtureStatus(identity, `${Effect2.pipe(index.toString(16), EffectString.padStart(16, '0'))}`, index),
          );
          for (const status of statuses) yield* writeStatusPair(fs, path, outside, status);
          const temporary = path.join(outside, '.history-prune-cursor.tmp');
          yield* fs.writeFileString(
            temporary,
            `${JSON.stringify({cursorToken: `bh1:s:${statuses[0].buildId}`, schemaVersion: 1})}\n`,
            {flag: 'wx', mode: 0o600},
          );
          yield* fs.symlink(outside, directory);
          const before = yield* fs.readDirectory(outside);

          expect(yield* pruneCodeGraphBuildHistoryUnit(layout, identity.worktreeId, statuses.at(-1)!.buildId)).toEqual({
            blockedCode: 'invalid-sidecar',
            retryAfterMilliseconds: 30_000,
            state: 'deferred',
          });
          expect(yield* fs.readDirectory(outside)).toEqual(before);
          expect(yield* fs.exists(temporary)).toBe(true);
          expect(yield* fs.exists(path.join(outside, '.history-prune-cursor'))).toBe(false);
        }),
      ),
    );

    it.effect('does not clean a replacement directory introduced after cursor authority freezes', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-recovery-swap-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          const backup = path.join(layout.repositoryRoot, 'build-status', `${identity.worktreeId}.backup`);
          const replacementTemporary = path.join(directory, '.history-prune-cursor.tmp');
          const reporter = yield* makeCodeGraphBuildReporter(identity, layout, undefined, {
            beforeCursorRecovery: () =>
              Effect.gen(function* () {
                yield* fs.rename(directory, backup);
                yield* fs.makeDirectory(directory, {mode: 0o700});
                yield* fs.writeFileString(replacementTemporary, 'replacement', {flag: 'wx', mode: 0o600});
              }),
          });
          yield* fs.writeFileString(
            path.join(directory, '.history-prune-cursor.tmp'),
            `${JSON.stringify({cursorToken: 'bh1:s:0000000000000000', schemaVersion: 1})}\n`,
            {flag: 'wx', mode: 0o600},
          );

          yield* reporter.completeSnapshot(fixtureSnapshot(identity));

          expect(yield* fs.readFileString(replacementTemporary)).toBe('replacement');
          expect(yield* fs.exists(path.join(directory, '.history-prune-cursor'))).toBe(false);
          expect(yield* fs.exists(path.join(backup, '.history-prune-cursor.tmp'))).toBe(true);
        }),
      ),
    );

    it.effect('does not write cursor progress into a replacement directory introduced after its page', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-write-swap-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          const backup = path.join(layout.repositoryRoot, 'build-status', `${identity.worktreeId}.backup`);
          const replacementSentinel = path.join(directory, 'sentinel');
          const reporter = yield* makeCodeGraphBuildReporter(identity, layout, undefined, {
            beforeCursorMutation: () =>
              Effect.gen(function* () {
                yield* fs.rename(directory, backup);
                yield* fs.makeDirectory(directory, {mode: 0o700});
                yield* fs.writeFileString(replacementSentinel, 'replacement', {flag: 'wx', mode: 0o600});
              }),
          });
          const prefix = Array.from({length: 29}, (_, index) =>
            fixtureStatus(
              identity,
              `${Effect2.pipe('-', EffectString.repeat(16))}${Effect2.pipe(index.toString(16), EffectString.padStart(2, '0'))}`,
              index,
              'queued',
            ),
          );
          for (const status of prefix) yield* writeStatusPair(fs, path, directory, status);

          yield* reporter.completeSnapshot(fixtureSnapshot(identity));

          expect(yield* fs.readFileString(replacementSentinel)).toBe('replacement');
          expect(yield* fs.exists(path.join(directory, '.history-prune-cursor'))).toBe(false);
          expect(yield* fs.exists(path.join(directory, '.history-prune-cursor.tmp'))).toBe(false);
          expect(yield* fs.exists(path.join(backup, '.history-prune-cursor'))).toBe(false);
          expect(yield* fs.exists(path.join(backup, '.history-prune-cursor.tmp'))).toBe(false);
        }),
      ),
    );

    it.effect('does not overwrite status or context files after the reporter directory is replaced', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-reporter-swap-'});
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
          const backup = path.join(layout.repositoryRoot, 'build-status', `${identity.worktreeId}.backup`);
          const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
          const statusFile = path.join(directory, `${reporter.ownerIdentity.buildId}.json`);
          const contextFile = path.join(directory, `${reporter.ownerIdentity.buildId}.manager-context`);
          yield* fs.rename(directory, backup);
          yield* fs.makeDirectory(directory, {mode: 0o700});
          yield* fs.writeFileString(statusFile, 'replacement-status', {flag: 'wx', mode: 0o600});
          yield* fs.writeFileString(contextFile, 'replacement-context', {flag: 'wx', mode: 0o600});

          yield* reporter.completeSnapshot(fixtureSnapshot(identity));

          expect(yield* fs.readFileString(statusFile)).toBe('replacement-status');
          expect(yield* fs.readFileString(contextFile)).toBe('replacement-context');
          expect(
            EffectArray.filter(
              yield* fs.readDirectory(directory),
              __effectArrayValue2 => !!(name => Effect2.pipe(name, EffectString.endsWith('.tmp')))(__effectArrayValue2),
            ),
          ).toEqual([]);
        }),
      ),
    );

    fcEffectProp(
      it,
      'never removes more than one matched status/context pair for any bounded terminal backlog',
      {historySize: FC.integer({max: 20, min: 9})},
      ({historySize}) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-history-property-'});
            const identity = fixtureIdentity(home);
            const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
            const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
            yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
            const statuses = Array.from({length: historySize}, (_, index) =>
              fixtureStatus(identity, `${Effect2.pipe(index.toString(16), EffectString.padStart(16, '0'))}`, index),
            );
            for (const status of statuses) yield* writeStatusPair(fs, path, directory, status);
            const currentBuildId = statuses.at(-1)!.buildId;

            const before = new Set(yield* fs.readDirectory(directory));
            yield* pruneCodeGraphBuildHistoryUnit(layout, identity.worktreeId, currentBuildId);
            const after = new Set(yield* fs.readDirectory(directory));
            const removed = EffectArray.filter([...before], name => !after.has(name)).sort();

            expect(removed.length).toBeLessThanOrEqual(2);
            expect(
              EffectArray.filter(removed, name => Effect2.pipe(name, EffectString.endsWith('.json'))),
            ).toHaveLength(1);
            expect(
              EffectArray.filter(removed, name => Effect2.pipe(name, EffectString.endsWith('.manager-context'))),
            ).toHaveLength(1);
            expect(Effect2.pipe(removed[0], EffectString.slice(0, -'.json'.length))).toBe(
              Effect2.pipe(removed[1], EffectString.slice(0, -'.manager-context'.length)),
            );
            expect(after.has(`${currentBuildId}.json`)).toBe(true);
          }),
        ),
      {fastCheck: {numRuns: 16}},
    );

    fcEffectProp(
      it,
      'failed receipts are removable exactly after a finite age exceeds retention and are not protected',
      {
        age: FC.integer({max: CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS * 2, min: 0}),
        pin: FC.boolean(),
      },
      ({age, pin}) =>
        Effect.sync(() => {
          const status = observedFailedStatus(age);
          expect(codeGraphFailedBuildStatusRemovable(status, pin ? status.buildId : undefined)).toBe(
            !pin && age > CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS,
          );
          expect(codeGraphFailedBuildStatusRemovable({...status, state: 'completed'}, undefined)).toBe(false);
          expect(codeGraphFailedBuildStatusRemovable(observedFailedStatus(Number.POSITIVE_INFINITY), undefined)).toBe(
            false,
          );
        }),
      {fastCheck: {numRuns: 50}},
    );

    fcEffectProp(
      it,
      'admits only a capped status inventory and fails closed on raw overflow',
      {
        extraEntries: FC.integer({max: 3, min: 0}),
        overflow: FC.boolean(),
        statusCount: FC.integer({max: EXPECTED_BUILD_HISTORY_STATUS_LIMIT + 1, min: 0}),
      },
      ({extraEntries, overflow, statusCount}) =>
        Effect.sync(() => {
          const statuses = Array.from(
            {length: statusCount},
            (_, index) => `${Effect2.pipe(index.toString(16), EffectString.padStart(16, '0'))}.json`,
          );
          const names = [...statuses, ...Array.from({length: extraEntries}, (_, index) => `sentinel-${index}`)];
          const result = codeGraphBuildHistoryInventory({names, overflow});
          expect(CODE_GRAPH_BUILD_HISTORY_STATUS_LIMIT).toBe(EXPECTED_BUILD_HISTORY_STATUS_LIMIT);
          expect(CODE_GRAPH_BUILD_HISTORY_DIRECTORY_ENTRY_LIMIT).toBe(EXPECTED_BUILD_HISTORY_DIRECTORY_ENTRY_LIMIT);
          const withinRawLimit = names.length <= EXPECTED_BUILD_HISTORY_DIRECTORY_ENTRY_LIMIT;
          const expected = !overflow && withinRawLimit && statusCount <= EXPECTED_BUILD_HISTORY_STATUS_LIMIT;
          expect(result === undefined).toBe(!expected);
          if (expected) expect(result).toEqual(statuses);
        }),
      {fastCheck: {numRuns: 50}},
    );

    it.effect('admits the maximal paired inventory plus cursor and temporary without spending status capacity', () =>
      Effect.sync(() => {
        const statuses = Array.from(
          {length: EXPECTED_BUILD_HISTORY_STATUS_LIMIT},
          (_, index) => `${Effect2.pipe(index.toString(16), EffectString.padStart(16, '0'))}.json`,
        );
        const contexts = EffectArray.map(
          statuses,
          name => `${Effect2.pipe(name, EffectString.slice(0, -'.json'.length))}.manager-context`,
        );
        const maximal = [...statuses, ...contexts, '.history-prune-cursor', '.history-prune-cursor.tmp'];

        expect(maximal).toHaveLength(EXPECTED_BUILD_HISTORY_DIRECTORY_ENTRY_LIMIT);
        expect(codeGraphBuildHistoryInventory({names: maximal, overflow: false})).toEqual(statuses);
        expect(codeGraphBuildHistoryInventory({names: [...maximal, 'excess'], overflow: false})).toBeUndefined();
      }),
    );
  });
});

function fixtureStatus(
  identity: RepositoryIdentity,
  buildId: string,
  sequence: number,
  state: CodeGraphBuildState = 'completed',
): CodeGraphBuildStatus {
  const timestamp = new Date(Date.UTC(2026, 7, 9, 12, 0, sequence)).toISOString();
  return {
    buildId,
    counters: {},
    identity: {
      checkoutId: identity.checkoutId,
      commit: identity.headCommit,
      repositoryId: identity.repositoryId,
      worktreeId: identity.worktreeId,
    },
    owner: {processId: process.pid, runtime: 'bun', runtimeVersion: '1.3.14'},
    phase: state === 'queued' ? 'waiting' : 'materializing',
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

function fixtureSnapshot(identity: RepositoryIdentity): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    completedAt: new Date().toISOString(),
    dirty: false,
    edgeCount: 34,
    extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
    fileCount: 12,
    id: 'cgsn_fixture',
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 56,
    worktreeId: identity.worktreeId,
  };
}

function writeStatusPair(fs: FileSystem.FileSystem, path: Path.Path, directory: string, status: CodeGraphBuildStatus) {
  return Effect.all(
    [
      fs.writeFileString(path.join(directory, `${status.buildId}.json`), `${JSON.stringify(status)}\n`, {
        flag: 'wx',
        mode: 0o600,
      }),
      fs.writeFileString(
        path.join(directory, `${status.buildId}.manager-context`),
        `${JSON.stringify({buildId: status.buildId, schemaVersion: 1, worktreePath: '/bounded/example'})}\n`,
        {flag: 'wx', mode: 0o600},
      ),
    ],
    {concurrency: 2, discard: true},
  );
}

function fixtureIdentity(home: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
    displayName: 'example/repository',
    gitCommonDirectory: `${home}/repository/.git`,
    headCommit: Effect2.pipe('d', EffectString.repeat(40)),
    objectFormat: 'sha1',
    remoteIdentity: 'example.invalid/repository',
    repoRoot: `${home}/repository`,
    repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
    worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
  };
}

function observedFailedStatus(heartbeatAgeMilliseconds: number): ObservedCodeGraphBuildStatus {
  return {
    ...fixtureStatus(fixtureIdentity('/tmp'), Effect2.pipe('a', EffectString.repeat(32)), 0, 'failed'),
    observation: {heartbeatAgeMilliseconds, liveness: 'failed'},
  };
}
