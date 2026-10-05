import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber, FileSystem, Path, PlatformError, Queue} from 'effect';
import {TestClock, TestConsole} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {pruneStandaloneReleases} from '@threadnote/threadnote/installations';
import {
  readStandaloneProcessLeaseVerification,
  withStandaloneProcessLease,
} from '@threadnote/threadnote/process/standalone_lease';
import {createMissingProcessFile} from '@threadnote/threadnote/process/owned_file';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nativeSystem = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-lease-reconcile-'});
  for (const version of ['4.0.0', '4.0.1', '4.0.2']) {
    const release = path.join(root, 'versions', version);
    yield* fs.makeDirectory(release, {recursive: true});
    yield* fs.writeFileString(path.join(release, 'release.json'), JSON.stringify({version}));
  }
  const system = SystemInfo.of({
    ...nativeSystem,
    environment: () => ({THREADNOTE_INSTALL_ROOT: root}),
    executablePath: path.join(root, 'versions', '4.0.0', 'threadnote'),
    isProcessRunning: id => id === nativeSystem.processId,
    canonicalProcessStartIdentity: () => Effect.succeed('lease-process'),
    processStartIdentity: () => Effect.succeed('lease-process'),
  });
  return {fs, path, root, system, leasePath: path.join(root, 'leases', '4.0.0', `${system.processId}.json`)};
});

const observeLeasePublication = (fs: FileSystem.FileSystem, file: string) =>
  Effect.gen(function* () {
    const published = yield* Deferred.make<void>();
    return {
      published,
      fs: FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) =>
          fs
            .link(from, to)
            .pipe(Effect.tap(() => (to === file ? Deferred.succeed(published, undefined) : Effect.void))),
      }),
    };
  });

describe('standalone lease reconciliation', () => {
  effectIt.effect.each([false, true])('bounds missing-lease failure even if later probes fail (%s)', failProbes =>
    Effect.gen(function* () {
      const {fs, system, leasePath} = yield* fixture;
      const attempts = yield* Queue.unbounded<void>();
      const ready = yield* Deferred.make<void>();
      let finalized = false;
      let publicationFailed = false;
      const unsupported = FileSystem.FileSystem.of({
        ...fs,
        exists: file =>
          file === leasePath && publicationFailed && failProbes
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: 'PermissionDenied',
                  module: 'FileSystem',
                  method: 'exists',
                }),
              ).pipe(Effect.ensuring(Queue.offer(attempts, undefined)))
            : fs.exists(file),
        link: () => {
          publicationFailed = true;
          return Effect.fail(
            PlatformError.systemError({
              _tag: 'Unknown',
              module: 'FileSystem',
              method: 'link',
              description: 'ENOTSUP',
            }),
          );
        },
        remove: (file, options) =>
          fs
            .remove(file, options)
            .pipe(Effect.tap(() => (file.endsWith('.tmp') ? Queue.offer(attempts, undefined) : Effect.void))),
      });
      const running = yield* withStandaloneProcessLease(
        Effect.gen(function* () {
          yield* fs.remove(leasePath);
          yield* Deferred.succeed(ready, undefined);
          return yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      ).pipe(
        Effect.provideService(SystemInfo, system),
        Effect.provideService(FileSystem.FileSystem, unsupported),
        Effect.exit,
        Effect.forkScoped({startImmediately: true}),
      );
      yield* Deferred.await(ready);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        yield* TestClock.adjust(30_000);
        yield* Queue.take(attempts);
      }
      const result = yield* Fiber.join(running);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('3 consecutive attempts');
      expect(finalized).toBe(true);
      expect(yield* fs.exists(leasePath)).toBe(false);
      expect(yield* TestConsole.errorLines).toEqual([expect.stringContaining('stopping this process')]);
    }).pipe(
      provideTestLayer(TestSystemInfoLayer),
      provideTestLayer(BunServices.layer),
      provideTestLayer(TestConsole.layer),
    ),
  );

  effectIt.effect('resets the publication failure budget after recovery and preserves normal completion', () =>
    Effect.gen(function* () {
      const {fs, system, leasePath} = yield* fixture;
      const attempts = yield* Queue.unbounded<void>();
      let supported = true;
      const flaky = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) =>
          supported
            ? fs.link(from, to)
            : Effect.fail(
                PlatformError.systemError({
                  _tag: 'Unknown',
                  module: 'FileSystem',
                  method: 'link',
                  description: 'ENOTSUP',
                }),
              ),
        remove: (file, options) =>
          fs
            .remove(file, options)
            .pipe(Effect.tap(() => (file.endsWith('.tmp') ? Queue.offer(attempts, undefined) : Effect.void))),
      });
      const result = yield* withStandaloneProcessLease(
        Effect.gen(function* () {
          for (let episode = 0; episode < 2; episode += 1) {
            yield* fs.remove(leasePath);
            supported = false;
            for (let failure = 0; failure < 2; failure += 1) {
              yield* TestClock.adjust(30_000);
              yield* Queue.take(attempts);
            }
            supported = true;
            yield* TestClock.adjust(30_000);
            yield* Queue.take(attempts);
            expect(yield* fs.exists(leasePath)).toBe(true);
          }
          yield* fs.remove(leasePath);
          supported = false;
          yield* TestClock.adjust(30_000);
          yield* Queue.take(attempts);
          return 'completed';
        }),
      ).pipe(Effect.provideService(SystemInfo, system), Effect.provideService(FileSystem.FileSystem, flaky));
      expect(result).toBe('completed');
      expect(yield* fs.exists(leasePath)).toBe(false);
      expect(yield* TestConsole.errorLines).toEqual([]);
    }).pipe(
      provideTestLayer(TestSystemInfoLayer),
      provideTestLayer(BunServices.layer),
      provideTestLayer(TestConsole.layer),
    ),
  );

  effectIt.effect.each([false, true])('stops and preserves a foreign or invalid replacement lease (%s)', invalid =>
    Effect.gen(function* () {
      const {fs, system, leasePath} = yield* fixture;
      const observed = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      let finalized = false;
      let watching = false;
      let replacement = '';
      const observedFs = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (file, encoding) =>
          fs
            .readFileString(file, encoding)
            .pipe(
              Effect.tap(() => (file === leasePath && watching ? Deferred.succeed(observed, undefined) : Effect.void)),
            ),
      });
      const running = yield* withStandaloneProcessLease(
        Effect.gen(function* () {
          const original = JSON.parse(yield* fs.readFileString(leasePath));
          replacement = invalid ? '{}' : JSON.stringify({...original, token: 'foreign-token'});
          yield* fs.writeFileString(leasePath, replacement);
          watching = true;
          yield* Deferred.succeed(ready, undefined);
          return yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      ).pipe(
        Effect.provideService(SystemInfo, system),
        Effect.provideService(FileSystem.FileSystem, observedFs),
        Effect.exit,
        Effect.forkScoped({startImmediately: true}),
      );
      yield* Deferred.await(ready);
      yield* TestClock.adjust(30_000);
      yield* Deferred.await(observed);
      const result = yield* Fiber.join(running);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('lost ownership');
      expect(finalized).toBe(true);
      expect(yield* fs.readFileString(leasePath)).toBe(replacement);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('retries a transient lease read failure without surrendering ownership', () =>
    Effect.gen(function* () {
      const {fs, system, leasePath} = yield* fixture;
      const publication = yield* observeLeasePublication(fs, leasePath);
      const failed = yield* Deferred.make<void>();
      let fail = true;
      const flaky = FileSystem.FileSystem.of({
        ...publication.fs,
        readFileString: (file, encoding) => {
          if (file !== leasePath || !fail) return fs.readFileString(file, encoding);
          fail = false;
          return fs.readFileString(`${file}.missing`).pipe(Effect.ensuring(Deferred.succeed(failed, undefined)));
        },
      });
      yield* withStandaloneProcessLease(
        Effect.gen(function* () {
          yield* TestClock.adjust(30_000);
          yield* Deferred.await(failed);
          yield* fs.remove(leasePath);
          yield* TestClock.adjust(30_000);
          yield* Deferred.await(publication.published);
        }),
      ).pipe(Effect.provideService(SystemInfo, system), Effect.provideService(FileSystem.FileSystem, flaky));
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('preserves a competing destination created immediately before atomic publication', () =>
    Effect.gen(function* () {
      const {fs, path, root} = yield* fixture;
      const file = path.join(root, 'record.json');
      const temporary = path.join(root, 'record.tmp');
      const interlocked = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) => fs.writeFileString(to, 'foreign').pipe(Effect.andThen(fs.link(from, to))),
      });
      expect(yield* fs.exists(file)).toBe(false);
      expect(yield* createMissingProcessFile(interlocked, file, temporary, 'owned')).toBe(false);
      expect(yield* fs.readFileString(file)).toBe('foreign');
      expect(yield* fs.exists(temporary)).toBe(false);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('fails closed and cleans its temporary when atomic publication is unsupported', () =>
    Effect.gen(function* () {
      const {fs, path, root} = yield* fixture;
      const file = path.join(root, 'record.json');
      const temporary = path.join(root, 'record.tmp');
      const unsupported = FileSystem.FileSystem.of({
        ...fs,
        link: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: 'Unknown',
              module: 'FileSystem',
              method: 'link',
              description: 'ENOTSUP',
            }),
          ),
      });
      expect(Exit.isFailure(yield* Effect.exit(createMissingProcessFile(unsupported, file, temporary, 'owned')))).toBe(
        true,
      );
      expect(yield* fs.exists(file)).toBe(false);
      expect(yield* fs.exists(temporary)).toBe(false);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('keeps orphaned repair temporaries outside lease discovery', () =>
    Effect.gen(function* () {
      const {fs, path, system, leasePath} = yield* fixture;
      const repaired = yield* Deferred.make<void>();
      let temporary = '';
      const orphaning = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) => {
          temporary = from;
          return fs
            .link(from, to)
            .pipe(Effect.tap(() => (to === leasePath ? Deferred.succeed(repaired, undefined) : Effect.void)));
        },
        remove: (file, options) => Effect.suspend(() => (file === temporary ? Effect.void : fs.remove(file, options))),
      });
      yield* withStandaloneProcessLease(
        Effect.gen(function* () {
          yield* fs.remove(leasePath);
          yield* TestClock.adjust(30_000);
          yield* Deferred.await(repaired);
          expect(yield* fs.exists(temporary)).toBe(true);
          expect(yield* fs.readDirectory(path.dirname(leasePath))).toEqual([`${system.processId}.json`]);
          expect((yield* readStandaloneProcessLeaseVerification()).truncated).toBe(false);
        }),
      ).pipe(Effect.provideService(SystemInfo, system), Effect.provideService(FileSystem.FileSystem, orphaning));
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('restores the immutable idle lease and protects its release from pruning', () =>
    Effect.gen(function* () {
      const {fs, path, root, system, leasePath} = yield* fixture;
      const requested = yield* Deferred.make<void>();
      const allowPublication = yield* Deferred.make<void>();
      const gated = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) =>
          Deferred.succeed(requested, undefined).pipe(
            Effect.andThen(Deferred.await(allowPublication)),
            Effect.andThen(fs.link(from, to)),
          ),
      });
      const publication = yield* observeLeasePublication(gated, leasePath);
      yield* withStandaloneProcessLease(
        Effect.gen(function* () {
          const original = yield* fs.readFileString(leasePath);
          yield* fs.remove(path.dirname(leasePath), {recursive: true});
          yield* TestClock.adjust(30_000);
          yield* Deferred.await(requested);
          expect(yield* fs.exists(leasePath)).toBe(false);
          yield* Deferred.succeed(allowPublication, undefined);
          yield* Deferred.await(publication.published);
          expect(yield* fs.readFileString(leasePath)).toBe(original);
          yield* pruneStandaloneReleases(path.join(root, 'versions', '4.0.2'), false).pipe(
            Effect.provideService(SystemInfo, {
              ...system,
              executablePath: path.join(root, 'versions', '4.0.1', 'threadnote'),
            }),
          );
          expect(yield* fs.exists(path.join(root, 'versions', '4.0.0'))).toBe(true);
        }),
      ).pipe(Effect.provideService(SystemInfo, system), Effect.provideService(FileSystem.FileSystem, publication.fs));
      expect(yield* fs.exists(leasePath)).toBe(false);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('retries after a transient heartbeat failure', () =>
    Effect.gen(function* () {
      const {fs, system, leasePath} = yield* fixture;
      const publication = yield* observeLeasePublication(fs, leasePath);
      let attempts = 0;
      const refreshed = yield* Deferred.make<void>();
      const flaky = FileSystem.FileSystem.of({
        ...publication.fs,
        utimes: (file, atime, mtime) => {
          attempts += 1;
          return fs
            .utimes(attempts === 1 ? `${file}.missing` : file, atime, mtime)
            .pipe(Effect.ensuring(Deferred.succeed(refreshed, undefined)));
        },
      });
      yield* withStandaloneProcessLease(
        Effect.gen(function* () {
          yield* TestClock.adjust(30_000);
          yield* Deferred.await(refreshed);
          expect(attempts).toBe(1);
          yield* fs.remove(leasePath);
          yield* TestClock.adjust(30_000);
          yield* Deferred.await(publication.published);
          expect(yield* fs.exists(leasePath)).toBe(true);
        }),
      ).pipe(Effect.provideService(SystemInfo, system), Effect.provideService(FileSystem.FileSystem, flaky));
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  fcEffectProp(
    effectIt,
    'never overwrites or removes a foreign lease token',
    {token: fc.string({minLength: 1, maxLength: 60})},
    ({token}) =>
      Effect.gen(function* () {
        const {fs, system, leasePath} = yield* fixture;
        const ready = yield* Deferred.make<void>();
        let foreign = '';
        const running = yield* withStandaloneProcessLease(
          Effect.gen(function* () {
            const original = JSON.parse(yield* fs.readFileString(leasePath));
            foreign = JSON.stringify({...original, token: `foreign:${token}`});
            yield* fs.writeFileString(leasePath, foreign);
            yield* Deferred.succeed(ready, undefined);
            return yield* Effect.never;
          }),
        ).pipe(Effect.provideService(SystemInfo, system), Effect.exit, Effect.forkScoped({startImmediately: true}));
        yield* Deferred.await(ready);
        yield* TestClock.adjust(30_000);
        expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true);
        expect(yield* fs.readFileString(leasePath)).toBe(foreign);
      }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
    {fastCheck: {numRuns: 20}},
  );
});
