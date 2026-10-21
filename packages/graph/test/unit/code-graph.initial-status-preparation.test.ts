import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {makeIdempotentFixtureTempDirectoryScoped} from '@threadnote/testing/fixture-temp-directory';
import {prepareCodeGraphLocalAssociationObservation} from '@threadnote/graph/local_provenance';
import {codeGraphLocalProvenanceLockPath} from '@threadnote/graph/layout';
import {
  parseRepositoryIdentityMetadata,
  startRepositoryWorktreeObservation,
  type RepositoryIdentityMetadata,
} from '@threadnote/graph/repository';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-initial-status-');
  const root = path.join(temporary, 'repo');
  const home = path.join(temporary, 'home');
  yield* fs.makeDirectory(root);
  yield* fs.makeDirectory(home);
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', root, ...args]);
  yield* git(['init', '-q']);
  yield* git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  return {fs, path, root, home, git};
});

describe('initial status preparation', () => {
  effectIt.layer(citationPlatformLayer)(it => {
    it.effect('overlaps status with association publication and joins both before evidence, once per request', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const associationStarted = yield* Deferred.make<void>();
        const releaseAssociation = yield* Deferred.make<void>();
        const statusFinished = yield* Deferred.make<void>();
        let publications = 0;
        let consumed = false;
        const observed = FileSystem.FileSystem.of({
          ...f.fs,
          writeFileString: (file, data, options) => {
            if (!file.endsWith('.tmp')) return f.fs.writeFileString(file, data, options);
            publications += 1;
            return Deferred.succeed(associationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseAssociation)),
              Effect.andThen(f.fs.writeFileString(file, data, options)),
            );
          },
        });
        yield* Effect.gen(function* () {
          const prepared = yield* prepareCodeGraphLocalAssociationObservation(f.home, f.root);
          const waiting = yield* prepared
            .observeTogether(Deferred.succeed(statusFinished, undefined).pipe(Effect.as('ready')))
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  consumed = true;
                }),
              ),
              Effect.forkScoped,
            );
          yield* Deferred.await(associationStarted);
          yield* Deferred.await(statusFinished);
          expect(consumed).toBe(false);
          yield* Deferred.succeed(releaseAssociation, undefined);
          expect(yield* Fiber.join(waiting)).toBe('ready');
          expect(consumed).toBe(true);
          expect(yield* prepared.observeTogether(Effect.succeed('fallback session'))).toBe('fallback session');
          expect(publications).toBe(1);
          const lock = codeGraphLocalProvenanceLockPath(
            f.path,
            f.home,
            prepared.identity.checkoutId,
            prepared.identity.worktreeId,
          );
          expect(yield* f.fs.exists(lock)).toBe(false);
        }).pipe(Effect.provideService(FileSystem.FileSystem, observed));
      }).pipe(TestClock.withLive),
    );

    it.effect('interrupts association work and releases its lock when status preparation fails', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const associationStarted = yield* Deferred.make<void>();
        let interrupted = false;
        const observed = FileSystem.FileSystem.of({
          ...f.fs,
          writeFileString: (file, data, options) =>
            file.endsWith('.tmp')
              ? Deferred.succeed(associationStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Effect.sync(() => {
                      interrupted = true;
                    }),
                  ),
                )
              : f.fs.writeFileString(file, data, options),
        });
        yield* Effect.gen(function* () {
          const prepared = yield* prepareCodeGraphLocalAssociationObservation(f.home, f.root);
          const result = yield* prepared
            .observeTogether(Deferred.await(associationStarted).pipe(Effect.andThen(Effect.fail('status failed'))))
            .pipe(Effect.result);
          expect(result._tag).toBe('Failure');
          expect(interrupted).toBe(true);
          const lock = codeGraphLocalProvenanceLockPath(
            f.path,
            f.home,
            prepared.identity.checkoutId,
            prepared.identity.worktreeId,
          );
          expect(yield* f.fs.exists(lock)).toBe(false);
        }).pipe(Effect.provideService(FileSystem.FileSystem, observed));
      }).pipe(TestClock.withLive),
    );

    it.effect('shares absolute index discovery for nested and linked callers and falls back for unborn HEAD', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const nested = f.path.join(f.root, 'nested directory');
        const linked = f.path.join(f.path.dirname(f.root), 'linked');
        const unborn = f.path.join(f.path.dirname(f.root), 'unborn');
        yield* f.fs.makeDirectory(nested);
        yield* f.git(['worktree', 'add', '-q', '--detach', linked]);
        yield* f.fs.makeDirectory(unborn);
        yield* runCommandEffect('git', ['-C', unborn, 'init', '-q']);
        for (const cwd of [nested, linked, unborn]) {
          const metadata = yield* Deferred.make<RepositoryIdentityMetadata | undefined>();
          let observed: RepositoryIdentityMetadata | undefined;
          const bind = yield* startRepositoryWorktreeObservation(cwd, {
            cache: {threadnoteHome: f.home, minimumIndexBytes: 0},
            metadata: Deferred.await(metadata),
          });
          const prepared = yield* prepareCodeGraphLocalAssociationObservation(f.home, cwd, value => {
            observed = value;
            return Deferred.succeed(metadata, value).pipe(Effect.asVoid);
          });
          expect(yield* prepared.observeTogether(bind(prepared.identity))).toBe(cwd === unborn ? undefined : false);
          if (cwd === unborn) expect(observed).toBeUndefined();
          else {
            const expectedIndex = (yield* runCommandEffect('git', [
              '-C',
              cwd,
              'rev-parse',
              '--path-format=absolute',
              '--git-path',
              'index',
            ])).stdout.trim();
            expect(observed?.sourceIndex).toBe(expectedIndex);
            expect(f.path.isAbsolute(observed!.sourceIndex!)).toBe(true);
          }
        }
      }).pipe(TestClock.withLive),
    );

    it.effect('bounds an unresolved shared metadata observation to ten seconds', () =>
      Effect.gen(function* () {
        const f = yield* fixture.pipe(TestClock.withLive);
        const prepared = yield* prepareCodeGraphLocalAssociationObservation(f.home, f.root).pipe(TestClock.withLive);
        const entered = yield* Deferred.make<void>();
        const bind = yield* startRepositoryWorktreeObservation(f.root, {
          cache: {threadnoteHome: f.home},
          metadata: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const waiting = yield* bind(prepared.identity).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust('10 seconds');
        expect(yield* Fiber.join(waiting)).toBeUndefined();
      }),
    );

    it.effect('cancels a shared metadata wait when surrounding identity discovery fails', () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let canceled = false;
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startRepositoryWorktreeObservation('/unused', {
              cache: {threadnoteHome: '/unused'},
              metadata: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    canceled = true;
                  }),
                ),
              ),
            });
            yield* Deferred.await(entered);
            return yield* Effect.fail('discovery failed');
          }),
        ).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        expect(canceled).toBe(true);
      }),
    );

    it.effect('keeps final association identity validation after concurrent status preparation', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const command = yield* CommandExecutor;
        let changed = false;
        const observed = FileSystem.FileSystem.of({
          ...f.fs,
          writeFileString: (file, data, options) =>
            f.fs.writeFileString(file, data, options).pipe(
              Effect.tap(() =>
                file.endsWith('.tmp') && !changed
                  ? Effect.sync(() => {
                      changed = true;
                    }).pipe(
                      Effect.andThen(
                        f
                          .git([
                            '-c',
                            'user.name=Test',
                            '-c',
                            'user.email=test@example.invalid',
                            'commit',
                            '--allow-empty',
                            '-qm',
                            'changed during publication',
                          ])
                          .pipe(Effect.provideService(CommandExecutor, command), Effect.orDie),
                      ),
                    )
                  : Effect.void,
              ),
            ),
        });
        yield* Effect.gen(function* () {
          const prepared = yield* prepareCodeGraphLocalAssociationObservation(f.home, f.root);
          expect(yield* prepared.observeTogether(Effect.succeed('status completed'))).toBe('status completed');
          expect(changed).toBe(true);
          const target = f.path.join(
            f.home,
            'indexes',
            'code-graph',
            'repositories',
            prepared.identity.checkoutId,
            'local-context',
            'worktrees',
            `${prepared.identity.worktreeId}.json`,
          );
          expect(yield* f.fs.exists(target)).toBe(false);
        }).pipe(Effect.provideService(FileSystem.FileSystem, observed));
      }).pipe(TestClock.withLive),
    );
  });
});

it('parses complete index-bearing metadata without accepting malformed frames or mutating bytes', () => {
  const utf8 = new TextEncoder();
  const segment = fc
    .array(fc.constantFrom('a', 'Z', '0', ' ', 'é', '東', '🦉', '\\'), {minLength: 1, maxLength: 24})
    .map(chars => chars.join(''));
  fc.assert(
    fc.property(segment, fc.constantFrom('sha1' as const, 'sha256' as const), (part, objectFormat) => {
      const expected = {
        repoRoot: `/repo/${part}/root`,
        commonDirectory: '/common',
        gitDirectory: '/git',
        objectFormat,
        headCommit: 'a'.repeat(objectFormat === 'sha1' ? 40 : 64),
        sourceIndex: `/index/${part}/index`,
      };
      const frame = `${Object.values(expected).join('\n')}\n`;
      const bytes = utf8.encode(frame);
      const before = bytes.slice();
      expect(parseRepositoryIdentityMetadata(bytes, true)).toEqual(expected);
      expect(bytes).toEqual(before);
      const invalidUtf8 = bytes.slice();
      invalidUtf8[1] = 255;
      expect(parseRepositoryIdentityMetadata(invalidUtf8, true)).toBeUndefined();
      expect(parseRepositoryIdentityMetadata(bytes)).toBeUndefined();
      for (const invalid of [
        frame.slice(0, -1),
        frame + '\n',
        frame.replaceAll('\n', '\r\n'),
        frame + '\0',
        frame.replace(expected.sourceIndex, ''),
        frame.replace(expected.sourceIndex, 'a\0b'),
        frame.replace(expected.headCommit, 'HEAD'),
      ])
        expect(parseRepositoryIdentityMetadata(utf8.encode(invalid), true)).toBeUndefined();
    }),
    {numRuns: 64},
  );
  const prefix = `/repo\n/common\n/git\nsha1\n${'a'.repeat(40)}\n`;
  const exactIndex = '/' + 'i'.repeat(16_384 - 2);
  expect(parseRepositoryIdentityMetadata(utf8.encode(prefix + exactIndex + '\n'), true)?.sourceIndex).toBe(exactIndex);
  expect(parseRepositoryIdentityMetadata(utf8.encode(prefix + exactIndex + 'i\n'), true)).toBeUndefined();
});
