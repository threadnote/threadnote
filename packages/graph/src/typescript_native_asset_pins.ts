import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';

/**
 * Single source for the reviewed native TypeScript 7.1 runtime asset: digests, provenance, the staged manifest shape
 * and the tree-digest encoding. Construction, release staging, prepared-asset verification, the graph extractor, the
 * semantic provider and the native tests all consume these values.
 * Importing this module has no acquisition, process or environment side effects.
 * Every pin is part of the TypeScript pack cache identity: a pin change also updates NAVIGATION_PROOF_CACHE_IDENTITY,
 * which the any-OS body-discovery unit test asserts against the computed identity.
 */
export const nativeTypeScriptAssetPins = {
  version: '7.1.0-beta',
  /** Release staging and runtime admission accept only these separately reviewed host binaries. */
  reviewedHostBinaries: [
    {host: 'darwin-arm64', sha256: '6453082c0e4fa16b78a37106fce911d0df9b79192025a1b4fdecdf92286e3c47'},
    // Reviewed construction identities, not qualification: trusted same-repository run 44645978175 of reviewed
    // commit db499c1b3 (deadline multiplier 3), artifact native-typescript-construction-<host>. Its darwin-arm64
    // artifact reproduced the pin above.
    {host: 'darwin-x64', sha256: '0bff3b247bf35c5cc8f7544c665cd5cfaaacfa424400ca6e956d777ca3397458'},
    // The binary links the runner image's C toolchain (cgo), so a pin holds only on the image it was reviewed on.
    // linux-x64 is the ubuntu-24.04 construction that every linux-x64 consumer runs on: trusted same-repository CI run
    // 45657551541 of reviewed commit 2ed43b880, job "Native TypeScript asset · linux-x64". The earlier pin came from
    // the ubuntu-26.04 image that ubuntu-latest selected on 2026-11-20 and never matched an ubuntu-24.04 build.
    {host: 'linux-x64', sha256: '0faa85f91e05a506f9a5d61ce643a565960d3e332d55aeb2c28bdbf6372af026'},
    {host: 'linux-arm64', sha256: '294a3396080820b44e223d741eb040dfbd2d4c9b36855497f7df6ccdaaebacee'},
  ],
  frontend: {
    baseSdkTreeSha256: '359158a40b603029094ae95804af12820ef1e90187300b12bdf6d3b50da5e568',
    patchSha256: '2d85454eb544d731610470668ec2a2e8b4153b328323ecf3c66a81c9b73dfba2',
    derivedSdkTreeSha256: 'd4807d3176106daeea1f77ddc25be07c0444c57c3cd7a276e025d490b96d6f1c',
    bundleTreeSha256: 'f5db6d62b42f88480b8ae9e9499f04cfe66f345df5dec4cb278dbecc54701cc9',
  },
  provenance: {
    kind: 'private-source-overlay',
    sourceCommit: '3e9236361fa97a9e6c685f4833ac457ae2d8c50a',
    sourceTree: '2a322d5d8eefb3b2f295c5ed6398de7237f6249a',
    overlaySha256: '48f5fb06e0ba3b505b3633077cf6670c652c28e594309e259a5248412c87dae0',
  },
} as const;

/**
 * The darwin-arm64 reviewed binary is linker-signed. Its cdhash is a pure function of the reviewed bytes, so it is
 * pinned with them and binds the spawned image through the kernel. The darwin-x64 reviewed binary is unsigned: it has no
 * image to bind, and only the exact byte check applies to it outside a signed release.
 */
const reviewedLinkerSignedCdhashes: Readonly<Record<string, string>> = {
  'darwin-arm64': 'ee5a36bcabbc43bcdc7fa6e4d4bb9245551d4ece',
};

/** The Darwin code identity the kernel must report for a spawned compiler, before it runs. */
export interface NativeTypeScriptExpectedImage {
  readonly cdhash: string;
  readonly requireRuntime: boolean;
}
/** The exact executable bytes the runtime accepts on a host, and the Darwin image they must run as. */
export interface NativeTypeScriptExecutableIdentity {
  /** The reviewed construction digest that `manifest.json` names. */
  readonly reviewedSha256: string;
  /** The exact file digest: the reviewed pin, or the compiled-in signed digest in a signed macOS release. */
  readonly sha256: string;
  readonly image?: NativeTypeScriptExpectedImage;
}

const digest = (value: unknown, bytes: number): value is string =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u').test(value);

/**
 * The signed `tsc` identity that publish compiled into a notarized macOS executable, after its CI verifier proved the
 * signed bytes carry the reviewed code. Source mode and unsigned builds have none. A malformed value throws.
 */
export function nativeTypeScriptSignedReleaseIdentity():
  {readonly host: string; readonly sha256: string; readonly cdhash: string} | undefined {
  if (typeof THREADNOTE_SIGNED_NATIVE_TYPESCRIPT === 'undefined' || THREADNOTE_SIGNED_NATIVE_TYPESCRIPT === null)
    return undefined;
  const {host, sha256, cdhash} = THREADNOTE_SIGNED_NATIVE_TYPESCRIPT;
  if (typeof host !== 'string' || !digest(sha256, 32) || !digest(cdhash, 20))
    throw new Error('The compiled-in signed native TypeScript identity is malformed.');
  return {host, sha256, cdhash};
}

/**
 * The executable identity for a host, or undefined when the host has no reviewed pin:
 * - a compiled macOS release built with a signed identity accepts exactly those signed bytes, which must run as the
 *   signed cdhash with the hardened runtime;
 * - every other build accepts exactly the reviewed bytes; on darwin-arm64 they must also run as the linker cdhash.
 */
export function nativeTypeScriptExecutableIdentity(host: string): NativeTypeScriptExecutableIdentity | undefined {
  const reviewedSha256 = nativeTypeScriptReviewedBinarySha256(host);
  if (reviewedSha256 === undefined) return undefined;
  const signed = nativeTypeScriptSignedReleaseIdentity();
  if (signed !== undefined && EffectString.startsWith('darwin-')(host)) {
    if (signed.host !== host) throw new Error('The compiled-in signed native TypeScript identity names another host.');
    return {reviewedSha256, sha256: signed.sha256, image: {cdhash: signed.cdhash, requireRuntime: true}};
  }
  const linker = reviewedLinkerSignedCdhashes[host];
  return {reviewedSha256, sha256: reviewedSha256, ...(linker ? {image: {cdhash: linker, requireRuntime: false}} : {})};
}

/** Source-mode variable naming a host-prepared asset (the `prepared` sibling of `payload`). Compiled builds ignore it. */
export const NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV = 'THREADNOTE_TYPESCRIPT_NATIVE_PREPARED_ASSET_DIR';

/** `${platform}-${arch}` of a Node/Bun host, the key reviewed binaries are pinned under. */
export const nativeTypeScriptHostKey = (platform: string, arch: string) => `${platform}-${arch}`;

/** The reviewed binary digest for a host, or undefined when that host has no reviewed pin. */
export function nativeTypeScriptReviewedBinarySha256(host: string): string | undefined {
  for (const pin of nativeTypeScriptAssetPins.reviewedHostBinaries) if (pin.host === host) return pin.sha256;
  return undefined;
}

/**
 * The one reviewed-binary decision shared by CI asset provisioning and runtime admission: which check a staged manifest
 * fails on this host, or `undefined` when it names this host's reviewed binary. The result is a value-free check name.
 */
export function nativeTypeScriptManifestPinFailure(
  manifest: {readonly sha256: string; readonly executable: string},
  platform: string,
  arch: string,
): 'no-reviewed-pin' | 'manifest-binary' | 'manifest-executable' | undefined {
  const pinned = nativeTypeScriptReviewedBinarySha256(nativeTypeScriptHostKey(platform, arch));
  if (pinned === undefined) return 'no-reviewed-pin';
  if (manifest.sha256 !== pinned) return 'manifest-binary';
  if (manifest.executable !== (platform === 'win32' ? 'tsc.exe' : 'tsc')) return 'manifest-executable';
  return undefined;
}

/**
 * Tree digest encoding shared by construction, staging and every runtime verifier: `[relative path, sha|directory]`.
 * Entries are ordered with `String.prototype.localeCompare` (via Effect String) in the runtime's default ICU locale, not
 * by code units. The reviewed SDK and bundle digests were produced under that ordering, so changing the comparator
 * would change every pinned tree digest; keep it unless the pins are re-derived together.
 */
export function nativeTypeScriptTreeDigest(entries: readonly (readonly [string, string])[]): string {
  const sorted = [...entries].sort(([left], [right]) => EffectString.localeCompare(right)(left));
  return sha256HexSync(JSON.stringify(sorted));
}

const {version, frontend, provenance} = nativeTypeScriptAssetPins;
/** The staged `manifest.json`. Every field except the binary digest is a pin; the digest must match a host pin. */
export const NativeTypeScriptAssetManifest = Schema.Struct({
  version: Schema.Literal(version),
  executable: Schema.Literals(['tsc', 'tsc.exe']),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  frontend: Schema.Struct({
    baseSdkTreeSha256: Schema.Literal(frontend.baseSdkTreeSha256),
    patchSha256: Schema.Literal(frontend.patchSha256),
    derivedSdkTreeSha256: Schema.Literal(frontend.derivedSdkTreeSha256),
    bundleTreeSha256: Schema.Literal(frontend.bundleTreeSha256),
  }),
  provenance: Schema.Struct({
    kind: Schema.Literal(provenance.kind),
    sourceCommit: Schema.Literal(provenance.sourceCommit),
    sourceTree: Schema.Literal(provenance.sourceTree),
    overlaySha256: Schema.Literal(provenance.overlaySha256),
    officialNpmBinary: Schema.Literal(false),
  }),
});
export type NativeTypeScriptAssetManifest = typeof NativeTypeScriptAssetManifest.Type;

/** The exact manifest staged beside an executable with this digest. */
export function nativeTypeScriptAssetManifest(
  executable: 'tsc' | 'tsc.exe',
  binarySha256: string,
): NativeTypeScriptAssetManifest {
  return {
    version,
    executable,
    sha256: binarySha256,
    frontend: {...frontend},
    provenance: {...provenance, officialNpmBinary: false},
  };
}
export const nativeTypeScriptAssetManifestText = (manifest: NativeTypeScriptAssetManifest) =>
  `${JSON.stringify(manifest, null, 2)}\n`;
