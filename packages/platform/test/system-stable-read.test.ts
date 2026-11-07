import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Path} from 'effect';
import {expect, vi} from 'vitest';
import {fromPromise} from '../src/errors.js';
import {
  runtimeLstat,
  runtimeReadBoundedRegularFileAttempt,
  runtimeReadBoundedStableRegularFile,
} from '../src/system.js';

effectIt.layer(BunServices.layer)(it => {
  it.effect('binds a bounded read to its earlier file proof despite restored size and mtime', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({prefix: 'stable-read-proof-'});
      const filename = path.join(directory, 'source.md');
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T00:00:00.000Z'));
      yield* fs.writeFileString(filename, 'old');
      yield* fs.utimes(filename, timestamp, timestamp);
      const before = yield* fromPromise('before', () => runtimeLstat(filename));
      const read = (expected: typeof before) =>
        fromPromise('read', () => runtimeReadBoundedStableRegularFile(filename, 3, expected));
      expect(new TextDecoder().decode(yield* read(before))).toBe('old');
      yield* fs.writeFileString(filename, 'new');
      yield* fs.utimes(filename, timestamp, timestamp);
      const after = yield* fromPromise('after', () => runtimeLstat(filename));
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(yield* read(before).pipe(Effect.flip)).toMatchObject({
        cause: {_tag: 'SystemOperationError', message: 'Target changed since preparation.'},
      });
      expect(new TextDecoder().decode(yield* read(after))).toBe('new');
    }),
  );
});

for (const boundary of [
  'replacement',
  'strict',
  'symlink',
  'nonregular',
  'oversized',
  'zero-id',
  'cross-device',
  'same-object',
  'io',
  'close',
] as const) {
  effectIt.layer(BunServices.layer)(it => {
    it.effect(`keeps ${boundary} evidence and descriptor cleanup ahead of replacement recovery`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'classified-read-'});
        const filename = path.join(root, 'a'),
          replacement = path.join(root, 'b');
        yield* fs.writeFileString(filename, 'old');
        yield* fs.writeFileString(replacement, 'new');
        const a = yield* fromPromise('statA', () =>
          process.getBuiltinModule('fs').promises.lstat(filename, {bigint: true}),
        );
        const b = yield* fromPromise('statB', () =>
          process.getBuiltinModule('fs').promises.lstat(replacement, {bigint: true}),
        );
        if (boundary === 'symlink') Object.defineProperty(b, 'isSymbolicLink', {value: () => true});
        if (boundary === 'nonregular') Object.defineProperty(b, 'isFile', {value: () => false});
        if (boundary === 'oversized') Object.defineProperty(b, 'size', {value: 4n});
        if (boundary === 'zero-id') Object.defineProperty(b, 'ino', {value: 0n});
        if (boundary === 'cross-device') Object.defineProperty(b, 'dev', {value: a.dev + 1n});
        if (boundary === 'same-object') {
          Object.defineProperty(b, 'ino', {value: a.ino});
          Object.defineProperty(b, 'mtimeNs', {value: a.mtimeNs + 1n});
        }
        const native = process.getBuiltinModule('fs').promises;
        const originalLstat = native.lstat.bind(native),
          originalOpen = native.open.bind(native);
        const failure = new Error('injected native failure');
        let probes = 0,
          closeCalls = 0,
          readCalls = 0;
        let physicalClose: (() => Promise<void>) | undefined;
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const lstat = vi
              .spyOn(native, 'lstat')
              .mockImplementation((...args) =>
                args[0] === filename ? Promise.resolve(++probes === 1 ? a : b) : originalLstat(...args),
              );
            const open = vi.spyOn(native, 'open').mockImplementation(async (...args) => {
              const handle = await originalOpen(...args);
              if (args[0] !== filename) return handle;
              physicalClose = handle.close.bind(handle);
              Object.defineProperty(handle, 'stat', {
                value: () => (boundary === 'io' ? Promise.reject(failure) : Promise.resolve(a)),
              });
              handle.read = () => {
                readCalls++;
                return Promise.reject(new Error('mismatched objects cannot be read'));
              };
              handle.close = async () => {
                closeCalls++;
                if (boundary === 'close') throw failure;
                await physicalClose?.();
                physicalClose = undefined;
              };
              return handle;
            });
            return {lstat, open};
          }),
          () =>
            Effect.gen(function* () {
              const outcome = yield* fromPromise('attempt', async () =>
                boundary === 'strict'
                  ? runtimeReadBoundedStableRegularFile(filename, 3)
                  : runtimeReadBoundedRegularFileAttempt(filename, 3),
              ).pipe(Effect.result);
              expect(outcome._tag).toBe(boundary === 'replacement' ? 'Success' : 'Failure');
              if (outcome._tag === 'Success') expect(outcome.success).toEqual({status: 'replaced'});
              if (outcome._tag === 'Failure' && (boundary === 'close' || boundary === 'io'))
                expect(outcome.failure.cause).toBe(failure);
              expect(readCalls).toBe(0);
              expect(closeCalls).toBe(1);
              expect(probes).toBe(boundary === 'io' ? 1 : 2);
              expect(physicalClose === undefined).toBe(boundary !== 'close');
            }),
          spies =>
            Effect.promise(async () => {
              spies.open.mockRestore();
              spies.lstat.mockRestore();
              await physicalClose?.();
            }),
        );
      }),
    );
  });
}

for (const boundary of ['distinct-descriptor', 'strict', 'all-a', 'unsafe-path', 'unsafe-descriptor'] as const) {
  effectIt.layer(BunServices.layer)(it => {
    it.effect(`classifies A-path/B-descriptor/A-path only with safe distinct objects: ${boundary}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'descriptor-replacement-'});
        const filename = path.join(root, 'a'),
          other = path.join(root, 'b');
        yield* fs.writeFileString(filename, 'old');
        yield* fs.writeFileString(other, 'new');
        const native = process.getBuiltinModule('fs').promises;
        const originalLstat = native.lstat.bind(native),
          originalOpen = native.open.bind(native);
        const before = yield* fromPromise('before', () => native.lstat(filename, {bigint: true}));
        const after = yield* fromPromise('after', () => native.lstat(filename, {bigint: true}));
        const descriptor =
          boundary === 'all-a' ? before : yield* fromPromise('descriptor', () => native.lstat(other, {bigint: true}));
        Object.defineProperty(after, 'ctimeNs', {value: before.ctimeNs + 1n});
        if (boundary === 'unsafe-path') Object.defineProperty(after, 'isSymbolicLink', {value: () => true});
        if (boundary === 'unsafe-descriptor') Object.defineProperty(descriptor, 'size', {value: 4n});
        let probes = 0,
          reads = 0,
          closes = 0;
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const lstat = vi
              .spyOn(native, 'lstat')
              .mockImplementation((...args) =>
                args[0] === filename ? Promise.resolve(++probes === 1 ? before : after) : originalLstat(...args),
              );
            const open = vi.spyOn(native, 'open').mockImplementation(async (...args) => {
              const handle = await originalOpen(...args);
              if (args[0] !== filename) return handle;
              const close = handle.close.bind(handle);
              Object.defineProperty(handle, 'stat', {value: () => Promise.resolve(descriptor)});
              handle.read = () => {
                reads++;
                return Promise.reject(new Error('Mismatched descriptor bytes must be discarded.'));
              };
              handle.close = async () => {
                await close();
                closes++;
              };
              return handle;
            });
            return {lstat, open};
          }),
          () =>
            Effect.gen(function* () {
              const outcome = yield* fromPromise('attempt', async () =>
                boundary === 'strict'
                  ? runtimeReadBoundedStableRegularFile(filename, 3)
                  : runtimeReadBoundedRegularFileAttempt(filename, 3),
              ).pipe(Effect.result);
              expect(outcome._tag).toBe(boundary === 'distinct-descriptor' ? 'Success' : 'Failure');
              if (outcome._tag === 'Success') expect(outcome.success).toEqual({status: 'replaced'});
              expect(probes).toBe(2);
              expect(reads).toBe(0);
              expect(closes).toBe(1);
            }),
          spies =>
            Effect.sync(() => {
              spies.open.mockRestore();
              spies.lstat.mockRestore();
            }),
        );
      }),
    );
  });
}
