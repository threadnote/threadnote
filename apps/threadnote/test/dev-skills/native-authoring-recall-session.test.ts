import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it} from '@effect/vitest';
import {Effect, FileSystem, Layer, Option} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, vi} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {
  SystemInfo,
  readOpenedFileSystemIdentity,
  readPathFileSystemIdentity,
  type FileSystemIdentity,
} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {makeWorkflowRecallRefresh} from '../../src/workflow_memory/recall_refresh.js';

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'workflow-recall-session-test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: environment => ({...environment}),
        sanitizeExternal: environment => ({...environment}),
      }),
    ),
  ),
);
const dependencies = Layer.mergeAll(
  BunServices.layer,
  system,
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const provideServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(dependencies).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));

it.effect('retains through the normal flush and closes before failure cleanup begins', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'workflow-recall-session-'});
    const config = {account: 'local', agentContextHome: home, user: 'fixture'};
    // Failure-only, generated-fixture diagnostics: no paths, IDs or document bytes.
    const diagnostics: unknown[] = [];
    const openedIdentities = new Map<string, FileSystemIdentity>();
    const record = (value: unknown) => {
      diagnostics.push(value);
      if (diagnostics.length > 24) diagnostics.shift();
    };
    const kind = (value: string) =>
      value.endsWith('.sqlite')
        ? 'database'
        : value.endsWith('-wal')
          ? 'wal'
          : value.endsWith('-shm')
            ? 'shm'
            : undefined;
    const identity = (value: Option.Option<FileSystemIdentity>) =>
      Option.isSome(value)
        ? {positive: value.value.dev >= 0n && value.value.ino > 0n, inodeBits: value.value.ino.toString(2).length}
        : {missing: true};
    const observing = FileSystem.make({
      ...fs,
      access: (value, options) =>
        fs.access(value, options).pipe(
          Effect.tap(() =>
            Effect.sync(() => record({file: kind(value) ?? 'parent', step: options ? 'access' : 'exists', ok: true})),
          ),
          Effect.tapError(error =>
            Effect.sync(() =>
              record({file: kind(value) ?? 'parent', step: options ? 'access' : 'exists', reason: error.reason._tag}),
            ),
          ),
        ),
      stat: value =>
        fs.stat(value).pipe(
          Effect.tap(info =>
            kind(value)
              ? readPathFileSystemIdentity(value, info, 'File').pipe(
                  Effect.tap(exact =>
                    Effect.sync(() =>
                      record({
                        file: kind(value),
                        step: 'path',
                        normalizedMissing: Option.isNone(info.ino),
                        matchesOpened:
                          Option.isSome(exact) &&
                          openedIdentities.get(kind(value) ?? '')?.dev === exact.value.dev &&
                          openedIdentities.get(kind(value) ?? '')?.ino === exact.value.ino,
                        ...identity(exact),
                      }),
                    ),
                  ),
                )
              : Effect.void,
          ),
        ),
      open: (value, options) =>
        fs.open(value, options).pipe(
          Effect.map(file =>
            !kind(value)
              ? file
              : new Proxy(file, {
                  get: (target, key, receiver) =>
                    key === 'stat'
                      ? file.stat.pipe(
                          Effect.tap(info =>
                            readOpenedFileSystemIdentity(file, info, 'File').pipe(
                              Effect.tap(exact =>
                                Effect.sync(() => {
                                  if (Option.isSome(exact)) openedIdentities.set(kind(value) ?? '', exact.value);
                                  record({
                                    file: kind(value),
                                    step: 'handle',
                                    normalizedMissing: Option.isNone(info.ino),
                                    ...identity(exact),
                                  });
                                }),
                              ),
                            ),
                          ),
                        )
                      : Reflect.get(target, key, receiver),
                }),
          ),
          Effect.tapError(error =>
            kind(value)
              ? Effect.sync(() => record({file: kind(value), step: 'open', reason: error.reason._tag}))
              : Effect.void,
          ),
        ),
    });
    const query = loadRecallIndexData(config, {includeInactive: false}).pipe(
      Effect.provideService(FileSystem.FileSystem, observing),
    );
    yield* query;
    const close = vi.spyOn(Database.prototype, 'close');
    yield* Effect.gen(function* () {
      const batching = makeWorkflowRecallRefresh(() =>
        query.pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              expect(close, JSON.stringify({platform: process.platform, probes: diagnostics})).toHaveBeenCalledTimes(0),
            ),
          ),
          Effect.orDie,
        ),
      );
      yield* batching.withBatch(
        config,
        Effect.gen(function* () {
          yield* query;
          yield* query;
          yield* batching.refresh(config, ['normal']);
        }),
      );
      expect(close).toHaveBeenCalledTimes(1);
      close.mockClear();
      let cleanup = false;
      const failing = makeWorkflowRecallRefresh(() =>
        Effect.gen(function* () {
          // The request's retained connection has already closed. Cleanup gets
          // its ordinary fresh scope, which closes before this callback returns.
          expect(close).toHaveBeenCalledTimes(1);
          yield* query;
          expect(close).toHaveBeenCalledTimes(2);
          cleanup = true;
        }).pipe(Effect.orDie),
      );
      const exit = yield* failing
        .withBatch(
          config,
          Effect.gen(function* () {
            yield* query;
            yield* failing.track(config, ['failed']);
            return yield* Effect.fail('original');
          }),
        )
        .pipe(Effect.exit);
      expect(exit._tag).toBe('Failure');
      expect(cleanup).toBe(true);
    }).pipe(Effect.ensuring(Effect.sync(() => close.mockRestore())));
  }).pipe(TestClock.withLive, provideServices),
);
