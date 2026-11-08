import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Path, Schema} from 'effect';
import {expect, it as boundaryIt, vi} from 'vitest';
import {fromPromise} from '../src/errors.js';
import {
  runtimeLstat,
  runtimeReadBoundedRegularFileAttempt,
  runtimeReadBoundedStableRegularFile,
  runtimeReadStableOsUserIdentity,
  runtimeOpenWriterRoot,
  runtimeOpenGuardedDiskTarget,
  runtimeInspectGuardedDiskTarget,
  runtimeCommitGuardedDiskTarget,
  runtimeCloseGuardedDiskTarget,
  runtimeCloseWriterRoot,
  runtimeOpenPrivateWriterDirectory,
  runtimeClosePrivateWriterDirectory,
  runtimeReadPrivateWriterFile,
  runtimePublishPrivateWriterFile,
  runtimeReadWriterProcessIdentity,
} from '../src/system.js';

effectIt.layer(BunServices.layer)(it => {
  it.effect.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
    'refuses actual inheritable ACL grants on an already opened private directory before publishing bytes',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const folder = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'writer-private-acl-'}));
        const native = process.getBuiltinModule('fs');
        yield* Effect.acquireUseRelease(
          Effect.sync(() => runtimeOpenPrivateWriterDirectory(folder)),
          directory =>
            Effect.sync(() => {
              const chmod = Bun.spawnSync(
                ['/bin/chmod', '+a', 'everyone allow read,write,execute,file_inherit,directory_inherit', folder],
                {stdout: 'pipe', stderr: 'pipe', timeout: 5000},
              );
              expect(chmod.exitCode).toBe(0);
              expect(native.statSync(folder).mode & 0o777).toBe(0o700);
              expect(() =>
                runtimePublishPrivateWriterFile(
                  directory,
                  'private.json',
                  new TextEncoder().encode('FIXTURE_PRIVATE_SOURCE_SENTINEL'),
                  {
                    mode: 'exclusive',
                    nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    assertCurrentSync: () => undefined,
                  },
                ),
              ).toThrow();
              expect(native.existsSync(`${folder}/private.json`)).toBe(false);
              // Existing unexpected ACLs were refused, never silently repaired.
              expect(() => runtimeOpenPrivateWriterDirectory(folder)).toThrow();
            }),
          directory => Effect.sync(() => runtimeClosePrivateWriterDirectory(directory)),
        );
      }),
  );
});

for (const boundary of ['ancestor', 'existing-file', 'new-file'] as const) {
  effectIt.layer(BunServices.layer)(it => {
    it.effect.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
      `refuses actual unsafe ACL state at the private ${boundary} boundary`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const folder = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'writer-acl-boundary-'}));
          const native = process.getBuiltinModule('fs');
          const child = `${folder}/vault`;
          native.mkdirSync(child, {mode: 0o700});
          const file = `${child}/private.json`;
          const grant = (path: string, permissions: string) => {
            const result = Bun.spawnSync(['/bin/chmod', '+a', `everyone allow ${permissions}`, path], {
              stdout: 'pipe',
              stderr: 'pipe',
              timeout: 5000,
            });
            expect(result.exitCode).toBe(0);
          };
          if (boundary === 'ancestor') {
            grant(folder, 'write,execute,delete_child');
            expect(native.statSync(child).mode & 0o777).toBe(0o700);
            expect(() => runtimeOpenPrivateWriterDirectory(child)).toThrow();
            expect(native.existsSync(file)).toBe(false);
            return;
          }
          yield* Effect.acquireUseRelease(
            Effect.sync(() => runtimeOpenPrivateWriterDirectory(child)),
            directory =>
              Effect.sync(() => {
                const options = {
                  mode: 'exclusive' as const,
                  nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  assertCurrentSync: () => undefined,
                };
                if (boundary === 'existing-file') {
                  native.writeFileSync(file, 'existing fixture', {mode: 0o600});
                  grant(file, 'read,write');
                  const read = vi.spyOn(native, 'readSync');
                  try {
                    expect(() => runtimeReadPrivateWriterFile(directory, 'private.json', 128)).toThrow();
                    expect(read).not.toHaveBeenCalled();
                    expect(
                      runtimePublishPrivateWriterFile(
                        directory,
                        'private.json',
                        new TextEncoder().encode('replacement fixture'),
                        {...options, mode: 'replace'},
                      ).status,
                    ).toBe('unknown');
                  } finally {
                    read.mockRestore();
                  }
                  expect(native.readFileSync(file, 'utf8')).toBe('existing fixture');
                  expect(native.statSync(file).mode & 0o777).toBe(0o600);
                } else {
                  const original = native.fstatSync.bind(native);
                  let injected = false;
                  const probe = vi.spyOn(native, 'fstatSync').mockImplementation((fd, options) => {
                    if (!injected && native.existsSync(file)) {
                      injected = true;
                      grant(file, 'read,write');
                    }
                    return original(fd, options);
                  });
                  try {
                    expect(
                      runtimePublishPrivateWriterFile(
                        directory,
                        'private.json',
                        new TextEncoder().encode('FIXTURE_PRIVATE_SOURCE_SENTINEL'),
                        options,
                      ).status,
                    ).toBe('unknown');
                  } finally {
                    probe.mockRestore();
                  }
                  expect(injected).toBe(true);
                  expect(native.statSync(file).size).toBe(0);
                  expect(native.statSync(file).mode & 0o777).toBe(0o600);
                  expect(() => runtimeReadPrivateWriterFile(directory, 'private.json', 128)).toThrow();
                }
              }),
            directory => Effect.sync(() => runtimeClosePrivateWriterDirectory(directory)),
          );
        }),
    );
  });
}

effectIt.layer(BunServices.layer)(it => {
  it.effect('conditionally writes through actual rooted descriptors and synchronizes the acknowledged source', () =>
    Effect.gen(function* () {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({prefix: 'writer-descriptor-'});
      const canonical = yield* fs.realPath(directory);
      const filename = `${canonical}/a.ts`;
      yield* fs.writeFileString(filename, 'old');
      const native = process.getBuiltinModule('fs');
      const parent = native.statSync(canonical, {bigint: true});
      const original = native.statSync(filename, {bigint: true});
      yield* Effect.acquireUseRelease(
        Effect.sync(() => runtimeOpenWriterRoot(canonical, parent)),
        root =>
          Effect.acquireUseRelease(
            Effect.sync(() =>
              runtimeOpenGuardedDiskTarget(
                root,
                ['a.ts'],
                JSON.stringify([String(original.dev), String(original.ino)]),
                16,
              ),
            ),
            target =>
              Effect.sync(() => {
                let assertions = 0;
                const before = runtimeInspectGuardedDiskTarget(target);
                const result = runtimeCommitGuardedDiskTarget(target, {
                  before,
                  afterBytes: new TextEncoder().encode('new text'),
                  assertCurrentSync: () => {
                    assertions++;
                  },
                });
                expect(result.status).toBe('applied');
                if (result.status === 'applied')
                  expect(new TextDecoder().decode(result.current.bytes)).toBe('new text');
                expect(assertions).toBeGreaterThanOrEqual(3);
                expect(native.readFileSync(filename, 'utf8')).toBe('new text');
              }),
            target => Effect.sync(() => runtimeCloseGuardedDiskTarget(target)),
          ),
        root => Effect.sync(() => runtimeCloseWriterRoot(root)),
      );
    }),
  );
});

boundaryIt.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'reads one OS account home across actual processes with different configured homes',
  async () => {
    const identity = runtimeReadStableOsUserIdentity();
    expect(runtimeReadWriterProcessIdentity(process.pid)).toBe(runtimeReadWriterProcessIdentity(process.pid));
    const childSource = `import {runtimeReadStableOsUserIdentity} from ${JSON.stringify(new URL('../src/system.ts', import.meta.url).href)};
      const actual = runtimeReadStableOsUserIdentity();
      const hash = value => new Bun.CryptoHasher('sha256').update(value).digest('hex');
      console.log(JSON.stringify({uid:actual.userId,home:hash(actual.accountHome),builtin:hash(process.getBuiltinModule('os').userInfo().homedir)}));`;
    const rows: {uid: number; home: string; builtin: string}[] = [];
    for (const marker of ['/tmp/threadnote-identity-A', '/tmp/threadnote-identity-B']) {
      const child = Bun.spawn([process.execPath, '-e', childSource], {
        env: {...process.env, HOME: marker, USERPROFILE: marker, THREADNOTE_HOME: marker},
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try {
        const [output, errors, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(0);
        expect(errors).toBe('');
        expect(output.length).toBeLessThan(1_024);
        rows.push(JSON.parse(output));
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
      }
    }
    expect(rows[0].uid).toBe(identity.userId);
    expect(rows[1].uid).toBe(identity.userId);
    expect(rows[0].home).toBe(rows[1].home);
    expect(rows[0].builtin).not.toBe(rows[1].builtin);
  },
);

effectIt.layer(BunServices.layer)(it => {
  it.effect('durably publishes private journal revisions through pinned native directories', () =>
    Effect.gen(function* () {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'writer-private-journal-'});
      const canonical = yield* fs.realPath(root);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => runtimeOpenPrivateWriterDirectory(canonical)),
        directory =>
          Effect.sync(() => {
            const options = {
              mode: 'exclusive' as const,
              nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              assertCurrentSync: () => undefined,
            };
            expect(runtimeReadPrivateWriterFile(directory, 'journal.json', 128)).toBeUndefined();
            expect(
              runtimePublishPrivateWriterFile(
                directory,
                'journal.json',
                new TextEncoder().encode('{"revision":1}'),
                options,
              ).status,
            ).toBe('published');
            const replaced = runtimePublishPrivateWriterFile(
              directory,
              'journal.json',
              new TextEncoder().encode('{"revision":2}'),
              {...options, mode: 'replace'},
            );
            expect(replaced.status).toBe('published');
            const read = runtimeReadPrivateWriterFile(directory, 'journal.json', 128);
            expect(new TextDecoder().decode(read?.bytes)).toBe('{"revision":2}');
            expect(read?.identity.mode && read.identity.mode & 0o077n).toBe(0n);
            expect(
              runtimePublishPrivateWriterFile(directory, 'journal.json', new Uint8Array([0]), options).status,
            ).toBe('unknown');
            expect(new TextDecoder().decode(runtimeReadPrivateWriterFile(directory, 'journal.json', 128)?.bytes)).toBe(
              '{"revision":2}',
            );
          }),
        directory => Effect.sync(() => runtimeClosePrivateWriterDirectory(directory)),
      );
    }),
  );
});

for (const failure of ['source', 'readonly', 'hardlink', 'parent-symlink', 'lease', 'short-write'] as const) {
  effectIt.layer(BunServices.layer)(it => {
    it.effect(`preserves native guarded targets across ${failure} before or during mutation`, () =>
      Effect.gen(function* () {
        if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({prefix: 'writer-native-conflict-'});
        const canonical = yield* fs.realPath(directory);
        const native = process.getBuiltinModule('fs');
        native.mkdirSync(`${canonical}/project`);
        native.mkdirSync(`${canonical}/project/sub`);
        native.mkdirSync(`${canonical}/outside`);
        const filename = `${canonical}/project/sub/a.ts`;
        native.writeFileSync(filename, 'old');
        native.writeFileSync(`${canonical}/outside/a.ts`, 'outside');
        const parent = native.statSync(`${canonical}/project`, {bigint: true});
        const source = native.statSync(filename, {bigint: true});
        yield* Effect.acquireUseRelease(
          Effect.sync(() => runtimeOpenWriterRoot(`${canonical}/project`, parent)),
          root =>
            Effect.acquireUseRelease(
              Effect.sync(() =>
                runtimeOpenGuardedDiskTarget(
                  root,
                  ['sub', 'a.ts'],
                  JSON.stringify([String(source.dev), String(source.ino)]),
                  32,
                ),
              ),
              target =>
                Effect.sync(() => {
                  const before = runtimeInspectGuardedDiskTarget(target);
                  if (failure === 'source') native.writeFileSync(filename, 'user');
                  if (failure === 'readonly') native.chmodSync(filename, 0o400);
                  if (failure === 'hardlink') native.linkSync(filename, `${canonical}/alias`);
                  if (failure === 'parent-symlink') {
                    native.renameSync(`${canonical}/project/sub`, `${canonical}/project/detached`);
                    native.symlinkSync(`${canonical}/outside`, `${canonical}/project/sub`);
                  }
                  const originalWrite = native.writeSync.bind(native);
                  let calls = 0;
                  const spy =
                    failure === 'short-write'
                      ? vi.spyOn(native, 'writeSync').mockImplementation((...args: unknown[]) => {
                          const [fd, buffer, offset, length, position] = args;
                          if (
                            typeof fd !== 'number' ||
                            !(buffer instanceof Uint8Array) ||
                            typeof offset !== 'number' ||
                            typeof length !== 'number' ||
                            typeof position !== 'number'
                          )
                            throw new Error('Unexpected native descriptor-write arguments');
                          if (++calls > 1) throw new Error('bounded injected disk failure');
                          return originalWrite(fd, buffer, offset, 1, position);
                        })
                      : undefined;
                  try {
                    const apply = () =>
                      runtimeCommitGuardedDiskTarget(target, {
                        before,
                        afterBytes: new TextEncoder().encode('new'),
                        assertCurrentSync: () => {
                          if (failure === 'lease') throw new Error('lease lost');
                        },
                      });
                    if (failure === 'lease') expect(apply).toThrow('lease lost');
                    else expect(apply().status).toBe(failure === 'short-write' ? 'unknown' : 'conflict');
                    if (failure === 'short-write') expect(calls).toBe(2);
                  } finally {
                    spy?.mockRestore();
                  }
                  expect(native.readFileSync(`${canonical}/outside/a.ts`, 'utf8')).toBe('outside');
                  const surviving = failure === 'parent-symlink' ? `${canonical}/project/detached/a.ts` : filename;
                  expect(native.readFileSync(surviving, 'utf8')).toBe(
                    failure === 'source' ? 'user' : failure === 'short-write' ? 'nld' : 'old',
                  );
                }),
              target => Effect.sync(() => runtimeCloseGuardedDiskTarget(target)),
            ),
          root => Effect.sync(() => runtimeCloseWriterRoot(root)),
        );
      }),
    );
  });
}

effectIt.layer(BunServices.layer)(it => {
  it.effect.prop(
    'rejects generated unsafe relative components without changing any source',
    [Schema.Literals(['../', 'a/', 'a\\', '\0']), Schema.String.check(Schema.isMaxLength(16))],
    ([prefix, suffix]) =>
      Effect.gen(function* () {
        if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
        const fs = yield* FileSystem.FileSystem;
        const folder = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'writer-component-property-'}));
        const native = process.getBuiltinModule('fs');
        native.writeFileSync(`${folder}/a.ts`, 'source');
        const before = native.statSync(`${folder}/a.ts`, {bigint: true});
        yield* Effect.acquireUseRelease(
          Effect.sync(() => runtimeOpenWriterRoot(folder, native.statSync(folder, {bigint: true}))),
          root =>
            Effect.sync(() => {
              expect(() =>
                runtimeOpenGuardedDiskTarget(
                  root,
                  [prefix + suffix],
                  JSON.stringify([String(before.dev), String(before.ino)]),
                  32,
                ),
              ).toThrow();
              expect(native.readFileSync(`${folder}/a.ts`, 'utf8')).toBe('source');
            }),
          root => Effect.sync(() => runtimeCloseWriterRoot(root)),
        );
      }),
    {arbitrary: {runs: 20}},
  );
});

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
