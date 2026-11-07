import {cryptoLayer} from '@threadnote/platform/crypto';
import {zipSync, type Zippable} from 'fflate';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runtimeEntrypointLayer} from '../../src/effect/runtime-entrypoint.js';
import {telemetryChildEnvironmentPolicyLayer} from '../../src/telemetry/session.js';
import {semanticSdkDigest} from '../../src/semantic/fingerprint.js';

const resources = {
  source: 'apps/threadnote/src/semantic/providers/java-diagnostics/src/dev/threadnote/semantic/DiagnosticSnapshot.java',
  typeDefinition:
    'apps/threadnote/src/semantic/providers/java-diagnostics/src/dev/threadnote/semantic/TypeDefinitionSnapshot.java',
  preparedProject:
    'apps/threadnote/src/semantic/providers/java-diagnostics/src/dev/threadnote/semantic/PreparedProjectModel.java',
  manifest: 'apps/threadnote/src/semantic/providers/java-diagnostics/META-INF/MANIFEST.MF',
  plugin: 'apps/threadnote/src/semantic/providers/java-diagnostics/plugin.xml',
  license: 'LICENSE',
  formatterConfiguration: '.prettierrc.json',
  build: 'tools/semantic/build-java-diagnostics.ts',
  applicationBuild: 'apps/threadnote/tools/semantic/build-java-diagnostics.ts',
};
const output = 'apps/threadnote/src/semantic/providers/java_diagnostics_bundle.ts';
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Development build only. The installed adapter consumes these embedded bytes and never invokes javac. */
const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const command = yield* CommandExecutor;
    const root = path.resolve(import.meta.dir, '../../../..');
    const [jdkArgument, serverArgument, mode] = EffectArray.drop(process.argv, 2);
    check(
      jdkArgument && serverArgument && (mode === undefined || mode === '--check'),
      'Usage: bun tools/semantic/build-java-diagnostics.ts <pinned-jdk25> <pinned-jdtls> [--check]',
    );
    const jdk = yield* fs.realPath(path.resolve(jdkArgument));
    const server = yield* fs.realPath(path.resolve(serverArgument));
    const sdkDigests = {jdk: yield* semanticSdkDigest(jdk), server: yield* semanticSdkDigest(server)};
    check(
      sdkDigests.server === '2157c2e0f504a186de8bbd7d21230442643337d33181aa89e10b870a4f567cd6',
      'Use the qualified JDTLS1.63.0-202610191322 distribution',
    );
    check(
      sdkDigests.jdk === 'e55e2e5a8caf01f0fdd6437d9de55bddaadb7c1d3b5ee3eec96e963a0359bb1a',
      'Use the qualified Temurin25.0.5+8 build toolchain',
    );
    const inputs: Record<string, Uint8Array> = {};
    const sourceDigests: Record<string, string> = {};
    for (const [name, relative] of EffectRecord.toEntries(resources)) {
      const bytes = yield* fs.readFile(path.join(root, relative));
      check(bytes.length <= 128 * 1024, 'Build input exceeds capacity');
      inputs[name] = bytes;
      sourceDigests[relative] = sha256HexSync(bytes);
    }
    const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-diagnostics-build-'});
    for (const directory of ['source/dev/threadnote/semantic', 'classes', 'home', 'tmp'])
      yield* fs.makeDirectory(path.join(temporary, directory), {recursive: true, mode: 0o700});
    const source = path.join(temporary, 'source/dev/threadnote/semantic/DiagnosticSnapshot.java');
    const typeDefinition = path.join(temporary, 'source/dev/threadnote/semantic/TypeDefinitionSnapshot.java');
    const preparedProject = path.join(temporary, 'source/dev/threadnote/semantic/PreparedProjectModel.java');
    yield* fs.writeFile(preparedProject, inputs.preparedProject, {mode: 0o600});
    yield* fs.writeFile(typeDefinition, inputs.typeDefinition, {mode: 0o600});
    yield* fs.writeFile(source, inputs.source, {mode: 0o600});
    const jars = EffectArray.filter(yield* fs.readDirectory(path.join(server, 'plugins')), file =>
      EffectString.endsWith('.jar')(file),
    ).sort();
    check(jars.length > 0 && jars.length <= 256, 'Compilation classpath exceeds capacity');
    const environment = {
      PATH: path.join(jdk, 'bin') + ':/usr/bin:/bin',
      JAVA_HOME: jdk,
      HOME: path.join(temporary, 'home'),
      TMPDIR: path.join(temporary, 'tmp'),
      JAVA_TOOL_OPTIONS: '',
      _JAVA_OPTIONS: '',
      JDK_JAVA_OPTIONS: '',
      JDK_JAVAC_OPTIONS: '',
      CLASSPATH: '',
    };
    const compiler = path.join(jdk, 'bin/javac');
    const compilerDigest = sha256HexSync(yield* fs.readFile(compiler));
    yield* command.execute(
      compiler,
      [
        '-J-Djava.awt.headless=true',
        '-J-Duser.home=' + environment.HOME,
        '-J-Djava.io.tmpdir=' + environment.TMPDIR,
        '-g:none',
        '-proc:none',
        '-encoding',
        'UTF-8',
        '--release',
        '21',
        '-classpath',
        EffectArray.join(
          EffectArray.map(jars, name => path.join(server, 'plugins', name)),
          path.sep === '\\' ? ';' : ':',
        ),
        '-d',
        path.join(temporary, 'classes'),
        source,
        typeDefinition,
        preparedProject,
      ],
      {cwd: temporary, env: environment, maxOutputBytes: 65536, timeoutMs: 45000},
    );
    const entries: Zippable = {};
    // ZIP stores wall time; a zone-less fixed value keeps the DOS fields identical across build time zones.
    const stamp = '1980-01-01T00:00:00';
    entries['META-INF/MANIFEST.MF'] = [inputs.manifest, {mtime: stamp, level: 9}];
    entries['META-INF/LICENSE'] = [inputs.license, {mtime: stamp, level: 9}];
    entries['plugin.xml'] = [inputs.plugin, {mtime: stamp, level: 9}];
    const classDirectory = path.join(temporary, 'classes/dev/threadnote/semantic');
    const classes = (yield* fs.readDirectory(classDirectory)).sort();
    check(classes.length > 0 && classes.length <= 16, 'Unexpected compiler outputs');
    for (const file of classes) {
      check(
        /^(?:DiagnosticSnapshot|TypeDefinitionSnapshot|PreparedProjectModel)(?:\$[A-Za-z]+)?\.class$/u.test(file),
        'Unexpected compiler output',
      );
      const bytes = yield* fs.readFile(path.join(classDirectory, file));
      check(bytes.length <= 128 * 1024, 'Compiler output exceeds capacity');
      entries['dev/threadnote/semantic/' + file] = [bytes, {mtime: stamp, level: 9}];
    }
    const jar = zipSync(entries, {level: 9});
    check(jar.length <= 128 * 1024, 'Bundle exceeds capacity');
    const bundle = {
      protocolVersion: 1,
      command: 'threadnote.java.diagnosticSnapshot.v1',
      jarSha256: sha256HexSync(jar),
      jarBase64: btoa(
        EffectArray.join(
          Array.from(jar, byte => String.fromCharCode(byte)),
          '',
        ),
      ),
      provenance: {sourceDigests, sdkDigests, compilerDigest, targetRelease: 21},
    };
    for (const [relative, digest] of EffectRecord.toEntries(sourceDigests))
      check(
        sha256HexSync(yield* fs.readFile(path.join(root, relative))) === digest,
        'Source changed during compilation',
      );
    check(
      (yield* semanticSdkDigest(jdk)) === sdkDigests.jdk && (yield* semanticSdkDigest(server)) === sdkDigests.server,
      'Pinned toolchain changed during compilation',
    );
    const text =
      '// Generated by tools/semantic/build-java-diagnostics.ts. Do not edit.\n' +
      'export const javaDiagnosticBundle = ' +
      JSON.stringify(bundle, null, 2) +
      ' as const;\n';
    const formatted = yield* command.execute(process.execPath, ['fmt', '--no-script', '--stdin-filepath=' + output], {
      cwd: root,
      env: environment,
      input: new TextEncoder().encode(text),
      maxOutputBytes: 512 * 1024,
      timeoutMs: 10000,
    });
    if (mode === '--check')
      check((yield* fs.readFileString(path.join(root, output))) === formatted.stdout, 'Generated bundle is stale');
    else yield* fs.writeFileString(path.join(root, output), formatted.stdout);
    yield* Effect.logInfo(`Java diagnostic bundle ${bundle.jarSha256}, ${jar.length} bytes`);
  }),
);

const base = Layer.mergeAll(
  BunServices.layer,
  cryptoLayer,
  runtimeEntrypointLayer,
  telemetryChildEnvironmentPolicyLayer,
);
const ports = CommandExecutor.layer.pipe(Layer.provideMerge(SystemInfo.layer.pipe(Layer.provideMerge(base))));
// oxlint-disable-next-line effecttsgo/strict-effect-provide -- The development compiler entry point provides its OS/service graph.
if (import.meta.main) BunRuntime.runMain(program.pipe(Effect.provide(ports)));
