import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CommandExecutor, runCommandEffect, type CommandOptions} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  nativeVectorReaderBuildEnvironmentSha256,
  nativeVectorReaderHostProfile,
  nativeVectorReaderTarget,
} from '@threadnote/recall/vector/native-reader-payload';
import {releaseTargetForBunTarget} from '../../../../scripts/release-targets.js';
import {NATIVE_INFERENCE_LLAMA_COMMIT} from '../../../../scripts/native-inference-payload.js';
import {archiveRelease} from '../../../../scripts/archive-release.js';
import {extractGzipTar} from '../../src/effect/archive.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

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
const fixture = Effect.fn('test.releaseArchive.fixture')(function* (
  files: readonly FixtureFile[],
  options: {
    readonly bunTarget?: string;
    readonly inferenceTarget?: string;
    readonly nativeSourceCommit?: string;
    readonly nativeSourceTree?: string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote release archive '});
  const dist = path.join(root, 'dist');
  const extracted = path.join(root, 'extracted');
  yield* fs.makeDirectory(dist);
  yield* fs.makeDirectory(extracted);
  const bunTarget = options.bunTarget ?? nativeVectorReaderHostProfile(system);
  const target = releaseTargetForBunTarget(bunTarget);
  const sourceIdentity = {
    version: 1,
    commit: EffectString.repeat(40)('a'),
    tree: EffectString.repeat(40)('b'),
    bun: '1.4.4',
    target: bunTarget,
  };
  const vectorBytes = new TextEncoder().encode('fixture-native-vector');
  const nativeManifest = {
    schemaVersion: 1,
    binary: 'threadnote-vector-reader.node',
    binarySha256: sha256HexSync(vectorBytes),
    bunTarget,
    development: false,
    buildEnvironment: {compiler: 'fixture'},
    buildInfo: {
      protocolVersion: 2,
      napiVersion: 6,
      crateVersion: '0.1.0',
      sqliteVersion: '3.54.1',
      sqliteSourceId: 'fixture',
      target: nativeVectorReaderTarget(bunTarget),
      rustVersion: '1.89.0',
      buildEnvironmentSha256: nativeVectorReaderBuildEnvironmentSha256({compiler: 'fixture'}),
      crtStatic: EffectString.startsWith('bun-windows-')(bunTarget),
      deploymentTarget: EffectString.startsWith('bun-darwin-')(bunTarget) ? '13.0' : '',
      sourceCommit: options.nativeSourceCommit ?? sourceIdentity.commit,
      sourceTree: options.nativeSourceTree ?? sourceIdentity.tree,
      lockSha256: EffectString.repeat(64)('c'),
      toolchainSha256: EffectString.repeat(64)('d'),
      sourceSha256: EffectString.repeat(64)('e'),
    },
  };
  const inferenceFiles = [
    {name: 'runtime/native/fixture.node', bytes: new TextEncoder().encode('fixture-inference-addon')},
    {name: 'runtime/node-llama-cpp.js', bytes: new TextEncoder().encode('export {};')},
  ];
  const descriptor = {
    schemaVersion: 1,
    bunVersion: '1.4.4',
    bunTarget: options.inferenceTarget ?? bunTarget,
    packageVersion: '3.22.2',
    llamaCommit: NATIVE_INFERENCE_LLAMA_COMMIT,
    sourceInputDigest: EffectString.repeat(64)('a'),
    origin: 'locked-prebuilt',
    toolchain: {bun: '1.4.4'},
    files: EffectArray.map(inferenceFiles, file => ({
      path: file.name,
      sha256: sha256HexSync(file.bytes),
      size: file.bytes.length,
    })),
  };
  const allFiles: readonly FixtureFile[] = [
    {
      name: 'release.json',
      bytes: new TextEncoder().encode(JSON.stringify({version: 'fixture', target: bunTarget, sourceIdentity})),
    },
    ...inferenceFiles,
    {name: 'native-inference.json', bytes: new TextEncoder().encode(JSON.stringify(descriptor))},
    {name: 'runtime/vector-reader/threadnote-vector-reader.node', bytes: vectorBytes},
    ...(EffectArray.some(files, file => file.name === 'runtime/vector-reader/manifest.json')
      ? []
      : [
          {
            name: 'runtime/vector-reader/manifest.json',
            bytes: new TextEncoder().encode(JSON.stringify(nativeManifest)),
          },
        ]),
    ...files,
  ];
  for (const file of allFiles) {
    const destination = path.join(dist, file.name);
    yield* fs.makeDirectory(path.dirname(destination), {recursive: true});
    yield* fs.writeFile(destination, file.bytes);
    yield* fs.chmod(destination, file.executable ? 0o755 : 0o644);
  }
  return {fs, path, system, root, dist, extracted, files: allFiles, target, bunTarget, sourceIdentity};
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
  const inventory = EffectArray.map(yield* f.fs.readDirectory(f.extracted, {recursive: true}), name =>
    Effect2.pipe(name, EffectString.replaceAll('\\', '/')),
  );
  const expectedEntries = new Set(
    EffectArray.flatMap(f.files, file => {
      const parts = Effect2.pipe(file.name, EffectString.split('/'));
      return EffectArray.map(parts, (_, index) => EffectArray.join(parts.slice(0, index + 1), '/'));
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
  effectIt.effect('rejects stale same-target native commit or tree before creating outputs', () =>
    Effect.gen(function* () {
      for (const source of [
        {nativeSourceCommit: EffectString.repeat(40)('c')},
        {nativeSourceTree: EffectString.repeat(40)('d')},
      ]) {
        const f = yield* fixture([], source);
        const result = yield* archiveRelease({root: f.root, target: f.target}).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure')
          expect(result.failure).toMatchObject({
            message: 'Native vector reader source identity differs from this release.',
          });
        expect(yield* f.fs.exists(f.path.join(f.root, 'artifacts'))).toBe(false);
      }
    }).pipe(testLayer),
  );
  effectIt.effect('requires a complete valid release source identity before creating outputs', () =>
    Effect.gen(function* () {
      const f = yield* fixture([]);
      for (const sourceIdentity of [
        undefined,
        null,
        {},
        {...f.sourceIdentity, commit: 'invalid'},
        {...f.sourceIdentity, tree: undefined},
        {...f.sourceIdentity, target: 'invalid'},
      ]) {
        yield* f.fs.writeFileString(
          f.path.join(f.dist, 'release.json'),
          JSON.stringify({version: 'fixture', target: f.bunTarget, sourceIdentity}),
        );
        const result = yield* archiveRelease({root: f.root, target: f.target}).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure')
          expect(result.failure).toMatchObject({
            message: 'Release source identity is missing, invalid or differs from its target.',
          });
        expect(yield* f.fs.exists(f.path.join(f.root, 'artifacts'))).toBe(false);
      }
    }).pipe(testLayer),
  );
  effectIt.effect('rejects verified inference overlays from another OS, architecture or libc before output', () =>
    Effect.gen(function* () {
      for (const [bunTarget, inferenceTarget] of [
        ['bun-darwin-arm64', 'bun-windows-x64-baseline'],
        ['bun-darwin-arm64', 'bun-darwin-x64'],
        ['bun-linux-x64-baseline', 'bun-linux-x64-baseline-musl'],
        ['bun-linux-x64-baseline-musl', 'bun-linux-x64-baseline'],
        ['bun-linux-arm64-musl', 'bun-linux-arm64'],
      ]) {
        const f = yield* fixture([], {bunTarget, inferenceTarget});
        const result = yield* archiveRelease({root: f.root, target: f.target}).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure')
          expect(result.failure).toMatchObject({message: 'Native inference target/libc differs from this release.'});
        expect(yield* f.fs.exists(f.path.join(f.root, 'artifacts'))).toBe(false);
      }
    }).pipe(testLayer),
  );
  effectIt.effect('accepts matching GNU and musl inference profiles', () =>
    Effect.gen(function* () {
      for (const bunTarget of ['bun-linux-x64-baseline', 'bun-linux-x64-baseline-musl'])
        yield* verifyRoundtrip(yield* fixture([], {bunTarget}));
    }).pipe(testLayer),
  );

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

  effectIt.effect('refuses an advertised invalid vector payload before creating an archive', () =>
    Effect.gen(function* () {
      const f = yield* fixture([{name: 'runtime/vector-reader/manifest.json', bytes: new TextEncoder().encode('{}')}]);
      const result = yield* archiveRelease({root: f.root, target: f.target}).pipe(Effect.result);
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure')
        expect(result.failure).toMatchObject({message: 'Native vector reader payload is invalid before archive.'});
      expect(yield* f.fs.exists(f.path.join(f.root, 'artifacts', `threadnote-${f.target}.tar.gz`))).toBe(false);
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
            Effect2.pipe(
              (yield* runCommandEffect('xattr', ['-p', 'com.threadnote.archive-test', destination])).stdout,
              EffectString.trim,
            ),
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
          EffectArray.map(files, (file, index) => ({
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
