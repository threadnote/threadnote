/* oxlint-disable effecttsgo/node-builtin-import -- Verified tool bootstrap runs before npm installation. */
import {chmodSync, existsSync, mkdirSync, renameSync, rmSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const bazelVersion = '9.2.0';
const bazelHashes = {
  'darwin-arm64': 'dd466352a3e4d3581b8898740ee1ff208866ccbe25f8d367c5dcb950219587e6',
  'darwin-x64': '14c9bcb01303b38192e0e2895051c1bcf19bf89d7e416f5aeeeb48b6b624cfbf',
  'linux-arm64': '049dd21f40ad979db11c3ee68c96a42ce75f1185e69ac61ab20de1501427a410',
  'linux-x64': '7668a95db1250f12c40407251e4e203b4ec8bf39bc495d2f485b2d8c99048694',
};
const diffVersion = '49.1.0';
const diffAssets = {
  'darwin-arm64': ['macos-arm64', '1a0ca31c4bf28f8ad14a8fde17d9380f0513f8f386ba20f8d05e441aa12438f5'],
  'linux-arm64': ['linux-arm64', '3c528f28c079f5889728613771ea5f679c26ec67a12acecac345322dcb13c4af'],
  'linux-x64': ['linux-amd64', 'ab9dea07341a4d764aaed15225ac5ea65f381fc1a1ae304e9fc0147b5e832a87'],
};
const platform = `${process.platform}-${process.arch}`;
async function download(root, name, url, digest) {
  const executable = resolve(root, '.context/bazel-tools', name);
  const verify = async path =>
    new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex') === digest;
  if (!existsSync(executable)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Cannot download ${name}: HTTP ${response.status}`);
    mkdirSync(dirname(executable), {recursive: true});
    const temporary = `${executable}.${process.pid}.tmp`;
    try {
      await Bun.write(temporary, response);
      if (!(await verify(temporary))) throw new Error(`Checksum mismatch for ${name}`);
      chmodSync(temporary, 0o755);
      renameSync(temporary, executable);
    } finally {
      rmSync(temporary, {force: true});
    }
  }
  if (!(await verify(executable))) throw new Error(`Checksum mismatch for cached ${name}`);
  return executable;
}

export async function bazelPath(root) {
  const digest = bazelHashes[platform];
  if (!digest) throw new Error(`Bazel compatibility gate does not support ${platform}`);
  const configured = Effect.pipe(await Bun.file(resolve(root, '.bazelversion')).text(), EffectString.trim);
  if (configured !== bazelVersion) throw new Error('Update Bazel bootstrap hashes together with .bazelversion');
  const asset = `bazel-${bazelVersion}-${process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`;
  return download(
    root,
    `bazel-${bazelVersion}-${platform}`,
    `https://github.com/bazelbuild/bazel/releases/download/${bazelVersion}/${asset}`,
    digest,
  );
}

export async function bazelDiffPath(root) {
  const asset = diffAssets[platform];
  if (!asset) throw new Error(`Pinned bazel-diff does not support ${platform}`);
  return download(
    root,
    `bazel-diff-${diffVersion}-${platform}`,
    `https://github.com/Tinder/bazel-diff/releases/download/v${diffVersion}/bazel-diff-rust-${asset[0]}`,
    asset[1],
  );
}
