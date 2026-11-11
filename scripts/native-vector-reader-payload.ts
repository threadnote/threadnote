import {String as EffectString} from 'effect';
import {
  nativeVectorReaderSourceSha256,
  nativeVectorReaderTarget,
  parseNativeVectorReaderManifest,
  sameNativeVectorReaderBuildInfo,
  verifyNativeVectorReaderPayload,
  type NativeVectorReaderBuildInfo,
  type NativeVectorReaderManifest,
} from '@threadnote/recall/vector/native-reader-payload';
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
  if (!development && nativeReaderGit(root, ['status', '--porcelain', '--untracked-files=normal']) !== '') {
    throw new Error('Native vector reader release assembly requires a clean committed checkout.');
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
