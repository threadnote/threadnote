import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CommandExecutor, runCommandEffect, type CommandOptions} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {archiveRelease} from '../../../../scripts/archive-release.js';
import {extractGzipTar} from '../../src/effect/archive.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';

const systemLayer = Layer.effect(
  SystemInfo,
  Effect.gen(function* () {
    const base = yield* SystemInfo;
    const environment: NodeJS.ProcessEnv = {...base.environment(), THREADNOTE_ARCHIVE_TEST_ENV: 'preserved'};
    delete environment.COPYFILE_DISABLE;
    return SystemInfo.of({...base, environment: () => ({...environment})});
  }),
).pipe(Layer.provide(TestSystemInfoLayer));
const archiveTestLayer = Layer.mergeAll(
  BunServices.layer,
  systemLayer,
  TestCommandExecutorLayer.pipe(Layer.provideMerge(BunServices.layer), Layer.provide(systemLayer)),
);
const testLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(TestClock.withLive, provideTestLayer(archiveTestLayer));

interface FixtureFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly executable?: boolean;
}
const fixture = Effect.fn('test.releaseArchive.fixture')(function* (files: readonly FixtureFile[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote release archive '});
  const dist = path.join(root, 'dist');
  const extracted = path.join(root, 'extracted');
  yield* fs.makeDirectory(dist);
  yield* fs.makeDirectory(extracted);
  const allFiles: readonly FixtureFile[] = [
    {name: 'release.json', bytes: new TextEncoder().encode('{"version":"fixture"}\n')},
    ...files,
  ];
  for (const file of allFiles) {
    const destination = path.join(dist, file.name);
    yield* fs.makeDirectory(path.dirname(destination), {recursive: true});
    yield* fs.writeFile(destination, file.bytes);
    yield* fs.chmod(destination, file.executable ? 0o755 : 0o644);
  }
  const target = `${system.platform === 'win32' ? 'windows' : system.platform}-${system.architecture}`;
  return {fs, path, system, root, dist, extracted, files: allFiles, target};
});
const verifyRoundtrip = Effect.fn('test.releaseArchive.verifyRoundtrip')(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
) {
  const archive = yield* archiveRelease({
    root: f.root,
    target: f.target,
    artifactsRoot: f.path.join(f.root, 'artifacts with spaces'),
  });
  const archiveBytes = yield* f.fs.readFile(archive.artifactPath);
  expect(archive.checksum).toBe(sha256HexSync(archiveBytes));
  expect(yield* f.fs.readFileString(archive.checksumPath)).toBe(
    `${sha256HexSync(archiveBytes)}  ${f.path.basename(archive.artifactPath)}\n`,
  );
  yield* extractGzipTar(archive.artifactPath, f.extracted);
  const inventory = (yield* f.fs.readDirectory(f.extracted, {recursive: true})).map(name => name.replaceAll('\\', '/'));
  const expectedEntries = new Set(
    f.files.flatMap(file => {
      const parts = file.name.split('/');
      return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    }),
  );
  expect(inventory.sort()).toEqual([...expectedEntries].sort());
  for (const file of f.files) {
    const actual = f.path.join(f.extracted, file.name);
    expect(Array.from(yield* f.fs.readFile(actual))).toEqual(Array.from(file.bytes));
    expect(Array.from(yield* f.fs.readFile(f.path.join(f.dist, file.name)))).toEqual(Array.from(file.bytes));
    if (f.system.platform !== 'win32')
      expect((yield* f.fs.stat(actual)).mode & 0o777).toBe(file.executable ? 0o755 : 0o644);
  }
  return archive;
});

describe('production release archives', () => {
  effectIt.effect('preserves process environment, payload inventory, bytes, checksums and executable mode', () =>
    Effect.gen(function* () {
      const f = yield* fixture([
        {name: 'threadnote', bytes: new TextEncoder().encode('#!/bin/sh\nexit 0\n'), executable: true},
        {name: 'config/._ordinary.txt', bytes: Uint8Array.from([0, 255, 10])},
      ]);
      const command = yield* CommandExecutor;
      const observed: CommandOptions[] = [];
      const recording = CommandExecutor.of({
        ...command,
        execute: (executable, args, options) => {
          if (executable === 'tar' && args[0] === '-czf') observed.push(options ?? {});
          return command.execute(executable, args, options);
        },
      });
      yield* verifyRoundtrip(f).pipe(Effect.provideService(CommandExecutor, recording));
      expect(observed).toHaveLength(1);
      expect(observed[0].env).toMatchObject({THREADNOTE_ARCHIVE_TEST_ENV: 'preserved', COPYFILE_DISABLE: '1'});
      expect(observed[0].env?.PATH).toBe(f.system.environment().PATH);
    }).pipe(testLayer),
  );

  effectIt.effect.skipIf(process.platform !== 'darwin')(
    'does not turn real macOS file/directory xattrs into AppleDouble payload files',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture([
          {name: 'config/agent-skills/dev-cycle/SKILL.md', bytes: new TextEncoder().encode('workflow\n')},
          {name: 'threadnote', bytes: new TextEncoder().encode('executable\n'), executable: true},
        ]);
        const file = f.path.join(f.dist, 'config/agent-skills/dev-cycle/SKILL.md');
        const directory = f.path.dirname(file);
        for (const destination of [file, directory])
          yield* runCommandEffect('xattr', [
            '-w',
            'com.threadnote.archive-test',
            'benign-fixture-metadata',
            destination,
          ]);
        yield* verifyRoundtrip(f);
        for (const destination of [file, directory])
          expect(
            (yield* runCommandEffect('xattr', ['-p', 'com.threadnote.archive-test', destination])).stdout.trim(),
          ).toBe('benign-fixture-metadata');
      }).pipe(testLayer),
  );

  effectIt.effect.prop(
    'roundtrips bounded generated nested payload trees without missing, extra or changed files',
    {
      files: Schema.Array(
        Schema.Struct({
          bytes: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 255}))).check(
            Schema.isMaxLength(64),
          ),
          executable: Schema.Boolean,
          nested: Schema.Boolean,
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
    },
    ({files}) =>
      Effect.gen(function* () {
        const f = yield* fixture(
          files.map((file, index) => ({
            name: `config/agent-skills/dev-cycle/${file.nested ? 'scripts/nested/' : ''}file ${index}.bin`,
            bytes: Uint8Array.from(file.bytes),
            executable: file.executable,
          })),
        );
        yield* verifyRoundtrip(f);
      }).pipe(testLayer),
    {arbitrary: {runs: 8}},
  );
});
