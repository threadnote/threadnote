import {Effect, Array as EffectArray, String as EffectString} from 'effect';
import {
  nativeVectorReaderSourceSha256,
  nativeVectorReaderTarget,
  parseNativeVectorReaderManifest,
  sameNativeVectorReaderBuildInfo,
  verifyNativeVectorReaderPayload,
  type NativeVectorReaderBuildInfo,
  type NativeVectorReaderManifest,
} from '@threadnote/recall/vector/native-reader-payload';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {platformPathFor} from '@threadnote/platform/system';

export {nativeVectorReaderTarget, verifyNativeVectorReaderPayload};
const path = platformPathFor(process.platform);

export function nativeReaderGit(root: string, args: readonly string[]): string {
  const result = Bun.spawnSync({cmd: ['git', '-C', root, ...args], stdout: 'pipe', stderr: 'pipe'});
  if (result.exitCode !== 0) throw new Error(`Native vector reader could not inspect Git ${args[0]}.`);
  return EffectString.trim(result.stdout.toString());
}

export async function nativeReaderBuildInputs(root: string, bunTarget: string, development: boolean) {
  if (!development) {
    const status = nativeReaderGit(root, ['status', '--porcelain', '--untracked-files=normal']);
    if (status !== '') {
      throw new Error(
        'Native vector reader release assembly requires a clean committed checkout. ' +
          `Repository-relative Git status (bounded): ${JSON.stringify(EffectString.slice(0, 4096)(status))}`,
      );
    }
  }
  const sourceCommit = nativeReaderGit(root, ['rev-parse', 'HEAD']);
  const sourceTree = nativeReaderGit(root, ['rev-parse', 'HEAD^{tree}']);
  const crateRoot = path.join(root, 'packages', 'recall', 'native-vector-reader');
  const sourceSha256 = await nativeVectorReaderSourceSha256(crateRoot);
  const lockSha256 = sha256HexSync(new Uint8Array(await Bun.file(path.join(crateRoot, 'Cargo.lock')).arrayBuffer()));
  const toolchainSha256 = sha256HexSync(
    new Uint8Array(await Bun.file(path.join(crateRoot, 'rust-toolchain.toml')).arrayBuffer()),
  );
  const target = nativeVectorReaderTarget(bunTarget);
  if (!target) return undefined;
  if (!development) {
    const release: unknown = await Bun.file(path.join(root, 'dist', 'release.json')).json();
    if (
      typeof release !== 'object' ||
      release === null ||
      !('sourceIdentity' in release) ||
      !('target' in release) ||
      release.target !== bunTarget
    ) {
      throw new Error('Build the JavaScript release for this target before native assembly.');
    }
    const identity = release.sourceIdentity;
    if (
      typeof identity !== 'object' ||
      identity === null ||
      !('commit' in identity) ||
      !('tree' in identity) ||
      !('target' in identity) ||
      identity.commit !== sourceCommit ||
      identity.tree !== sourceTree ||
      identity.target !== bunTarget
    ) {
      throw new Error('JavaScript distribution source identity differs from current clean HEAD.');
    }
  }
  return {sourceCommit, sourceTree, sourceSha256, lockSha256, toolchainSha256, target};
}

export async function readNativeReaderBuildInfo(binaryPath: string): Promise<NativeVectorReaderBuildInfo> {
  const nativeModule = {exports: {}};
  process.dlopen(nativeModule, binaryPath);
  const binding: unknown = nativeModule.exports;
  if (
    typeof binding !== 'object' ||
    binding === null ||
    !('buildInfo' in binding) ||
    typeof binding.buildInfo !== 'function'
  ) {
    throw new Error('Native vector reader binary does not export buildInfo().');
  }
  return binding.buildInfo();
}

/** Publish the descriptor only after the copied binary and its build identity have been verified. */
export async function publishNativeReaderManifest(
  directory: string,
  fields: Omit<NativeVectorReaderManifest, 'schemaVersion' | 'binary' | 'binarySha256'>,
) {
  const binary = path.join(directory, 'threadnote-vector-reader.node');
  const manifest = parseNativeVectorReaderManifest({
    schemaVersion: 1,
    binary: 'threadnote-vector-reader.node',
    binarySha256: sha256HexSync(new Uint8Array(await Bun.file(binary).arrayBuffer())),
    ...fields,
  });
  if (!sameNativeVectorReaderBuildInfo(await readNativeReaderBuildInfo(binary), manifest.buildInfo)) {
    throw new Error('Native vector reader staged binary identity differs from the build inputs.');
  }
  await Bun.write(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Inspect the actual native artifact, including dependencies hidden from source metadata. */
export const auditNativeReaderBinary = Effect.fn('nativeReader.auditBinary')(function* (
  binaryPath: string,
  bunTarget: string,
  options: {readonly inference?: boolean} = {},
) {
  const commands: readonly (readonly [string, readonly string[]])[] =
    process.platform === 'linux'
      ? [
          ['readelf', ['--file-header', '--dynamic', '--version-info', binaryPath]],
          ['nm', ['-D', '--defined-only', binaryPath]],
        ]
      : process.platform === 'darwin'
        ? [
            ['otool', ['-L', binaryPath]],
            ['xcrun', ['vtool', '-show-build', binaryPath]],
            ['nm', ['-gU', binaryPath]],
          ]
        : [['dumpbin', ['/HEADERS', '/DEPENDENTS', '/EXPORTS', binaryPath]]];
  let output = '';
  for (const [command, arguments_] of commands) {
    const result = yield* runCommandEffect(command, arguments_, {timeoutMs: 30_000, maxOutputBytes: 512 * 1024});
    output += result.stdout;
  }
  if (/(?:libsqlite3(?:\.so|\.dylib)|sqlite3\.dll)/iu.test(output))
    throw new Error('Native payload unexpectedly depends on external SQLite.');
  if (!options.inference && /\b_?sqlite3_[A-Za-z0-9_]+\b/u.test(output))
    throw new Error('Native vector reader unexpectedly exports private SQLite symbols.');
  if (process.platform === 'linux') {
    const versions = [...EffectString.matchAll(/\bGLIBC_(\d+)\.(\d+)/gu)(output)];
    if (EffectString.endsWith('-musl')(bunTarget) && versions.length !== 0)
      throw new Error('Musl native payload contains GNU libc symbol dependencies.');
    if (
      !EffectString.endsWith('-musl')(bunTarget) &&
      EffectArray.some(versions, match => Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) > 17))
    )
      throw new Error('Native payload raises the supported glibc 2.17 floor.');
  }
  if (process.platform === 'darwin') {
    const floor = options.inference ? 14 : 13;
    if (
      EffectArray.some(
        [...EffectString.matchAll(/\bminos\s+(\d+)(?:\.(\d+))?/gu)(output)],
        match => Number(match[1]) > floor || (Number(match[1]) === floor && Number(match[2] ?? 0) > 0),
      )
    )
      throw new Error(`Native payload raises the supported macOS ${floor}.0 floor.`);
  }
  if (
    process.platform === 'win32' &&
    (!options.inference || bunTarget === 'bun-windows-arm64') &&
    /\b(?:vcruntime\d*|msvcp\d*|msvcr\d*|msvcrt)(?:_[a-z0-9]+)?\.dll\b/iu.test(output)
  )
    throw new Error('Native payload requires an external Visual C++ runtime instead of the pinned static CRT.');
  return sha256HexSync(output);
});
