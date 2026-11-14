import {Array as EffectArray, Record as EffectRecord, String as EffectString} from 'effect';
import {platformPathFor, runtimePlatform, runtimeLinuxLibc, type SystemInfoShape} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {isStandaloneThreadnoteBuild} from '@threadnote/workspace/runtime-version';
import type {NativeVectorReaderBinding} from './native-reader-contract.js';

export const NATIVE_VECTOR_READER_PROTOCOL = 2;
export const NATIVE_VECTOR_READER_NAPI = 6;
export const NATIVE_VECTOR_READER_FILES = [
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'build.rs',
  'src/lib.rs',
  'src/db.rs',
  'src/protocol.rs',
  'src/scoring.rs',
  'src/legacy_numeric.rs',
  'NOTICE',
] as const;

export interface NativeVectorReaderBuildInfo {
  readonly protocolVersion: 2;
  readonly napiVersion: 6;
  readonly crateVersion: string;
  readonly sqliteVersion: string;
  readonly sqliteSourceId: string;
  readonly target: string;
  readonly rustVersion: string;
  readonly crtStatic: boolean;
  readonly deploymentTarget: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly lockSha256: string;
  readonly toolchainSha256: string;
  readonly sourceSha256: string;
  readonly buildEnvironmentSha256: string;
}

export interface NativeVectorReaderManifest {
  readonly schemaVersion: 1;
  readonly binary: 'threadnote-vector-reader.node';
  readonly binarySha256: string;
  readonly bunTarget: string;
  readonly development: boolean;
  readonly buildEnvironment: Readonly<Record<string, string>>;
  readonly sourceRoot?: string;
  readonly buildInfo: NativeVectorReaderBuildInfo;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !EffectArray.isArray(value);
const stringRecord = (value: unknown): value is Record<string, string> =>
  record(value) && EffectArray.every(EffectRecord.values(value), field => typeof field === 'string');
export function nativeVectorReaderBuildEnvironmentSha256(value: Readonly<Record<string, string>>) {
  return sha256HexSync(JSON.stringify(EffectRecord.toEntries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const gitObject = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);

export function parseNativeVectorReaderManifest(value: unknown): NativeVectorReaderManifest {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.binary !== 'threadnote-vector-reader.node' ||
    !digest(value.binarySha256) ||
    typeof value.bunTarget !== 'string' ||
    typeof value.development !== 'boolean' ||
    !stringRecord(value.buildEnvironment) ||
    (value.development && typeof value.sourceRoot !== 'string') ||
    (!value.development && value.sourceRoot !== undefined) ||
    !record(value.buildInfo)
  ) {
    throw new Error('Invalid native vector reader payload manifest.');
  }
  const info = value.buildInfo;
  if (
    info.protocolVersion !== 2 ||
    info.napiVersion !== 6 ||
    info.crtStatic !== (typeof info.target === 'string' && EffectString.endsWith('-windows-msvc')(info.target)) ||
    typeof info.deploymentTarget !== 'string' ||
    info.deploymentTarget !==
      (typeof info.target === 'string' && EffectString.endsWith('-apple-darwin')(info.target) ? '13.0' : '') ||
    info.rustVersion !== '1.89.0' ||
    typeof info.crateVersion !== 'string' ||
    info.sqliteVersion !== '3.54.1' ||
    typeof info.sqliteSourceId !== 'string' ||
    !gitObject(info.sourceCommit) ||
    !gitObject(info.sourceTree) ||
    !digest(info.lockSha256) ||
    !digest(info.toolchainSha256) ||
    !digest(info.sourceSha256) ||
    !digest(info.buildEnvironmentSha256) ||
    nativeVectorReaderBuildEnvironmentSha256(value.buildEnvironment) !== info.buildEnvironmentSha256 ||
    typeof info.target !== 'string' ||
    nativeVectorReaderTarget(value.bunTarget) !== info.target
  ) {
    throw new Error('Incompatible native vector reader build identity.');
  }
  return {
    schemaVersion: 1,
    binary: 'threadnote-vector-reader.node',
    binarySha256: value.binarySha256,
    bunTarget: value.bunTarget,
    development: value.development,
    buildEnvironment: value.buildEnvironment,
    ...(typeof value.sourceRoot === 'string' ? {sourceRoot: value.sourceRoot} : {}),
    buildInfo: {
      protocolVersion: 2,
      napiVersion: 6,
      crateVersion: info.crateVersion,
      sqliteVersion: info.sqliteVersion,
      sqliteSourceId: info.sqliteSourceId,
      target: info.target,
      rustVersion: info.rustVersion,
      crtStatic: info.crtStatic,
      deploymentTarget: info.deploymentTarget,
      sourceCommit: info.sourceCommit,
      sourceTree: info.sourceTree,
      lockSha256: info.lockSha256,
      toolchainSha256: info.toolchainSha256,
      sourceSha256: info.sourceSha256,
      buildEnvironmentSha256: info.buildEnvironmentSha256,
    },
  };
}

/** The eight compile contracts have distinct architecture/libc ABI identities. */
export function nativeVectorReaderTarget(bunTarget: string): string | undefined {
  const profiles: Readonly<Record<string, string>> = {
    'bun-darwin-arm64': 'aarch64-apple-darwin',
    'bun-darwin-x64': 'x86_64-apple-darwin',
    'bun-linux-arm64': 'aarch64-unknown-linux-gnu',
    'bun-linux-arm64-musl': 'aarch64-unknown-linux-musl',
    'bun-linux-x64-baseline': 'x86_64-unknown-linux-gnu',
    'bun-linux-x64-baseline-musl': 'x86_64-unknown-linux-musl',
    'bun-windows-arm64': 'aarch64-pc-windows-msvc',
    'bun-windows-x64-baseline': 'x86_64-pc-windows-msvc',
  };
  return (
    profiles[bunTarget] ??
    (bunTarget === 'bun-linux-x64'
      ? profiles['bun-linux-x64-baseline']
      : bunTarget === 'bun-windows-x64'
        ? profiles['bun-windows-x64-baseline']
        : undefined)
  );
}
export function nativeVectorReaderHostProfile(
  system: Pick<SystemInfoShape, 'platform' | 'architecture' | 'libc'>,
): string {
  const platform = system.platform === 'win32' ? 'windows' : system.platform;
  const architecture = system.architecture === 'aarch64' ? 'arm64' : system.architecture;
  const baseline = architecture === 'x64' && platform !== 'darwin' ? '-baseline' : '';
  const hostLibc = platform === 'linux' ? (system.libc?.() ?? runtimeLinuxLibc()) : undefined;
  if (platform === 'linux' && hostLibc === undefined) throw new Error('Cannot identify native Linux libc ABI.');
  const libc = hostLibc === 'musl' ? '-musl' : '';
  return `bun-${platform}-${architecture}${baseline}${libc}`;
}

export async function nativeVectorReaderSourceSha256(crateRoot: string): Promise<string> {
  const inputs = await Promise.all(
    EffectArray.map(NATIVE_VECTOR_READER_FILES, async name => [
      name,
      sha256HexSync(new Uint8Array(await Bun.file(`${crateRoot}/${name}`).arrayBuffer())),
    ]),
  );
  return sha256HexSync(JSON.stringify(inputs));
}

export async function verifyNativeVectorReaderPayload(manifestPath: string): Promise<NativeVectorReaderManifest> {
  const manifest = parseNativeVectorReaderManifest(await Bun.file(manifestPath).json());
  const path = platformPathFor(runtimePlatform);
  const binary = path.join(path.dirname(manifestPath), manifest.binary);
  if (sha256HexSync(new Uint8Array(await Bun.file(binary).arrayBuffer())) !== manifest.binarySha256) {
    throw new Error('Native vector reader payload digest mismatch. Rebuild or reinstall this release.');
  }
  return manifest;
}

type LoaderSystem = Pick<SystemInfoShape, 'architecture' | 'platform' | 'executablePath' | 'environment' | 'libc'>;

/** Capability selection occurs before native admission; an advertised broken payload is an error. */
export async function loadNativeVectorReader(system: LoaderSystem): Promise<NativeVectorReaderBinding> {
  const path = platformPathFor(system.platform);
  const standalone = isStandaloneThreadnoteBuild();
  const configured = standalone ? undefined : system.environment().THREADNOTE_NATIVE_VECTOR_READER_MANIFEST;
  const manifestPath = standalone
    ? path.join(path.dirname(system.executablePath), 'runtime', 'vector-reader', 'manifest.json')
    : configured;
  if (manifestPath === undefined)
    throw new Error(
      'Required native vector reader is not bootstrapped. Run bun run native:bootstrap; requests never build or download addons.',
    );
  if (!(await Bun.file(manifestPath).exists())) {
    throw new Error('Required native vector reader manifest is missing. Rebuild or reinstall this distribution.');
  }
  const manifest = await verifyNativeVectorReaderPayload(manifestPath);
  const embeddedIdentity =
    typeof THREADNOTE_RUNTIME_SOURCE_IDENTITY === 'undefined' ? undefined : THREADNOTE_RUNTIME_SOURCE_IDENTITY;
  const profile = standalone && embeddedIdentity ? embeddedIdentity.target : nativeVectorReaderHostProfile(system);
  if (nativeVectorReaderTarget(profile) !== manifest.buildInfo.target || profile !== manifest.bunTarget) {
    throw new Error('Required native vector reader target/libc differs from this runtime.');
  }
  if (standalone) {
    if (manifest.development)
      throw new Error('Development native vector reader artifacts cannot load in standalone releases.');
    const identity =
      typeof THREADNOTE_RUNTIME_SOURCE_IDENTITY === 'undefined' ? undefined : THREADNOTE_RUNTIME_SOURCE_IDENTITY;
    if (
      !identity ||
      identity.commit !== manifest.buildInfo.sourceCommit ||
      identity.tree !== manifest.buildInfo.sourceTree ||
      identity.target !== manifest.bunTarget
    ) {
      throw new Error('Native vector reader source identity differs from this executable.');
    }
  } else {
    const root =
      manifest.sourceRoot ??
      system.environment().THREADNOTE_NATIVE_VECTOR_READER_SOURCE_ROOT ??
      Bun.fileURLToPath(new URL('../../../../', import.meta.url));
    if (!path.isAbsolute(root)) throw new Error('Native vector reader source root must be absolute.');
    if (
      (await nativeVectorReaderSourceSha256(path.join(root, 'packages', 'recall', 'native-vector-reader'))) !==
      manifest.buildInfo.sourceSha256
    ) {
      throw new Error('Explicit native vector reader artifact differs from current native source.');
    }
    for (const [ref, expected] of [
      ['HEAD', manifest.buildInfo.sourceCommit],
      ['HEAD^{tree}', manifest.buildInfo.sourceTree],
    ]) {
      const git = Bun.spawnSync({
        cmd: ['git', '-C', root, 'rev-parse', ref],
        env: system.environment(),
        stdout: 'pipe',
        stderr: 'ignore',
      });
      if (git.exitCode !== 0 || EffectString.trim(git.stdout.toString()) !== expected)
        throw new Error('Explicit native vector reader artifact differs from current checkout.');
    }
  }
  const nativeModule = {exports: {}};
  process.dlopen(nativeModule, path.join(path.dirname(manifestPath), manifest.binary));
  const loaded: unknown = nativeModule.exports;
  if (!isNativeBinding(loaded)) throw new Error('Native vector reader payload exports are incompatible.');
  if (!sameNativeVectorReaderBuildInfo(loaded.buildInfo(), manifest.buildInfo)) {
    throw new Error('Native vector reader binary build identity differs from its manifest.');
  }
  return loaded;
}

export function sameNativeVectorReaderBuildInfo(value: unknown, expected: NativeVectorReaderBuildInfo): boolean {
  return (
    record(value) &&
    EffectArray.every(EffectRecord.toEntries(expected), ([key, field]) => value[key] === field) &&
    EffectRecord.keys(value).length === EffectRecord.keys(expected).length
  );
}

function isNativeBinding(value: unknown): value is NativeVectorReaderBinding & {readonly buildInfo: () => unknown} {
  return (
    record(value) &&
    typeof value.buildInfo === 'function' &&
    typeof value.readSelected === 'function' &&
    typeof value.CancellationToken === 'function'
  );
}
