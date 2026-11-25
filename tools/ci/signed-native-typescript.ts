/**
 * Publish step "Verify signed native TypeScript identity" (macOS legs only). Release tooling, never shipped.
 *
 * After `runtime/typescript/tsc` is signed with Developer ID, this proves, or fails closed, that:
 * - the reference payload is the reviewed construction binary (exact host pin);
 * - the signed code is the reviewed code: arm64 `macho-code-v1` equals the reviewed canonical digest, and x64
 *   `unsigned-origin-v1` restores the exact reviewed unsigned bytes;
 * - the signature policy holds: one SHA-256 CodeDirectory, no alternate CodeDirectory, no entitlements, hardened
 *   runtime, MAIN_BINARY exec-segment flags only, the explicit identifier, every page hash and every special slot;
 * - every `__LINKEDIT` data reference ends at or before `dataoff`;
 * - `codesign --verify --strict` accepts the Developer ID requirement for the committed release Team ID.
 * It then records the exact signed SHA-256 and cdhash. `scripts/build.ts --relink-signed-native-typescript` compiles
 * that record into the outer executable before the outer executable is signed.
 */
import {readFile, stat, writeFile} from 'node:fs/promises';
import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import {
  nativeTypeScriptHostKey,
  nativeTypeScriptReviewedBinarySha256,
} from '@threadnote/graph/typescript_native_asset_pins';
import {
  CPU_TYPE_ARM64,
  CPU_TYPE_X86_64,
  MACHO_MAXIMUM_BYTES,
  machoCodeIdentityError,
  hex,
  isHexDigest,
  machoCodeDigest,
  machoCodeSignature,
  machoSignaturePolicyViolations,
  machoUnsignedOrigin,
  sha256,
} from './macho-code-identity.js';

/** The explicit signing identifier for the private compiler; the publish `-R` requirement pins it. */
export const SIGNED_NATIVE_TYPESCRIPT_IDENTIFIER = 'dev.threadnote.typescript-native';
export const SIGNED_NATIVE_TYPESCRIPT_RECORD_KIND = 'threadnote-signed-native-typescript-v1';

/**
 * The Apple Developer Team ID that signs Threadnote macOS releases. It is public (every signed binary carries it) and
 * committed so that review, not the signing secret, decides which team a release may be signed by. The publish import
 * step refuses an imported Developer ID identity of another team, and the signed compiler requirement uses this value.
 * Provenance: the `TeamIdentifier` of the Developer ID Application signature on the v5.4.4 darwin-arm64 release
 * executable (`threadnote-darwin-arm64.tar.gz`, which matches its published checksum).
 */
export const RELEASE_APPLE_TEAM_ID: string = '92WS7HVJ55';
const TEAM_ID = /^[A-Z0-9]{10}$/u;

/** The committed release Team ID; a malformed value fails closed. */
export function releaseAppleTeamId(value: string = RELEASE_APPLE_TEAM_ID): string {
  if (!TEAM_ID.test(value))
    throw new Error('The release Apple Team ID constant is not set to a ten-character Team ID.');
  return value;
}

/** The import step's check: the imported Developer ID identity must belong to the committed release team. */
export function assertSigningTeam(identityTeam: string, expected: string = RELEASE_APPLE_TEAM_ID): void {
  if (identityTeam !== releaseAppleTeamId(expected))
    throw new Error('The imported Developer ID identity does not belong to the release Apple Team ID.');
}

/**
 * Canonical forms of the reviewed host binaries. The arm64 value is `macho-code-v1` of the reviewed linker-signed
 * binary (pin 6453082c…); every publish recomputes it from the reference payload, so it cannot drift from the pin.
 * The reviewed x64 binary is unsigned, so its canonical form is the reviewed pin itself.
 */
export const signedNativeTypeScriptCanonicalForms = {
  'darwin-arm64': {
    form: 'macho-code-v1',
    cputype: CPU_TYPE_ARM64,
    sha256: '04ca16a8f2f0d831a2eb0bff378e15e4cc73e77508e0834dbd02db29eb22af0d',
  },
  'darwin-x64': {
    form: 'unsigned-origin-v1',
    cputype: CPU_TYPE_X86_64,
    sha256: nativeTypeScriptReviewedBinarySha256('darwin-x64') ?? '',
  },
} as const;
export type SignedNativeTypeScriptHost = keyof typeof signedNativeTypeScriptCanonicalForms;
export const isSignedNativeTypeScriptHost = (host: string): host is SignedNativeTypeScriptHost =>
  host === 'darwin-arm64' || host === 'darwin-x64';

export interface SignedNativeTypeScriptRecord {
  readonly kind: typeof SIGNED_NATIVE_TYPESCRIPT_RECORD_KIND;
  readonly host: SignedNativeTypeScriptHost;
  readonly identifier: string;
  readonly sha256: string;
  readonly cdhash: string;
  readonly canonicalForm: 'macho-code-v1' | 'unsigned-origin-v1';
  readonly canonicalSha256: string;
  readonly codeLimit: number;
  readonly pageSize: number;
  readonly flags: number;
}

/** Pure checks over the signed and reference bytes. Throws one error listing every violation. */
export function verifySignedNativeTypeScriptBytes(input: {
  readonly host: SignedNativeTypeScriptHost;
  readonly signed: Uint8Array;
  readonly reference: Uint8Array;
  readonly identifier?: string;
}): SignedNativeTypeScriptRecord {
  const canonical = signedNativeTypeScriptCanonicalForms[input.host];
  const identifier = input.identifier ?? SIGNED_NATIVE_TYPESCRIPT_IDENTIFIER;
  const reviewed = nativeTypeScriptReviewedBinarySha256(input.host);
  if (!reviewed || !isHexDigest(canonical.sha256, 32))
    throw machoCodeIdentityError([`no reviewed pin for ${input.host}`]);
  const violations: string[] = [];
  // The reference must be the reviewed construction bytes, and its canonical form the recorded constant.
  if (hex(sha256(input.reference)) !== reviewed) violations.push('reference payload is not the reviewed binary');
  else if (
    canonical.form === 'macho-code-v1' &&
    machoCodeDigest(input.reference, canonical.cputype).sha256 !== canonical.sha256
  )
    violations.push('reviewed binary does not have the recorded canonical digest');
  const actual =
    canonical.form === 'macho-code-v1'
      ? machoCodeDigest(input.signed, canonical.cputype).sha256
      : hex(sha256(machoUnsignedOrigin(input.signed, canonical.cputype)));
  if (actual !== canonical.sha256) violations.push(`${canonical.form} digest differs from the reviewed binary`);
  const signature = machoCodeSignature(input.signed, canonical.cputype);
  violations.push(...machoSignaturePolicyViolations(signature, {identifier, requireRuntime: true}));
  if (violations.length > 0) throw machoCodeIdentityError(violations);
  return {
    kind: SIGNED_NATIVE_TYPESCRIPT_RECORD_KIND,
    host: input.host,
    identifier,
    sha256: hex(sha256(input.signed)),
    cdhash: signature.cdhash,
    canonicalForm: canonical.form,
    canonicalSha256: actual,
    codeLimit: signature.codeLimit,
    pageSize: signature.pageSize,
    flags: signature.flags,
  };
}

/** The Developer ID Application requirement for the expected Team ID and identifier. */
export function developerIdRequirement(
  teamId: string = RELEASE_APPLE_TEAM_ID,
  identifier = SIGNED_NATIVE_TYPESCRIPT_IDENTIFIER,
): string {
  releaseAppleTeamId(teamId);
  return EffectArray.join(
    [
      'anchor apple generic',
      `identifier "${identifier}"`,
      'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
      'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
      `certificate leaf[subject.OU] = "${teamId}"`,
    ],
    ' and ',
  );
}

/** `codesign --verify --strict` with a test requirement; a nonzero status fails closed. */
export async function verifyCodeRequirement(path: string, requirement: string): Promise<void> {
  const child = Bun.spawn(['/usr/bin/codesign', '--verify', '--strict', `-R=${requirement}`, path], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (status !== 0)
    throw machoCodeIdentityError([
      `codesign requirement check failed with status ${status}: ${EffectString.trim(EffectString.slice(0, 400)(stderr))}`,
    ]);
}

async function readBounded(path: string): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MACHO_MAXIMUM_BYTES)
    throw machoCodeIdentityError([`${path} is not a bounded file`]);
  return new Uint8Array(await readFile(path));
}

/** File-level verification: byte checks, then the code requirement, then the bytes again (no change in between). */
export async function verifySignedNativeTypeScript(input: {
  readonly host: SignedNativeTypeScriptHost;
  readonly executable: string;
  readonly reference: string;
  readonly identifier?: string;
  /** Required in publish. Tests omit it, because an ad-hoc signature cannot satisfy a Developer ID requirement. */
  readonly requirement?: string;
}): Promise<SignedNativeTypeScriptRecord> {
  const signed = await readBounded(input.executable);
  const record = verifySignedNativeTypeScriptBytes({
    host: input.host,
    signed,
    reference: await readBounded(input.reference),
    ...(input.identifier === undefined ? {} : {identifier: input.identifier}),
  });
  if (input.requirement !== undefined) await verifyCodeRequirement(input.executable, input.requirement);
  if (hex(sha256(await readBounded(input.executable))) !== record.sha256)
    throw machoCodeIdentityError(['signed executable changed during verification']);
  return record;
}

const argument = (arguments_: readonly string[], name: string): string => {
  const index = arguments_.indexOf(name);
  const value = index < 0 ? undefined : arguments_[index + 1];
  if (!value || EffectString.startsWith('--')(value)) throw new Error(`${name} <path> is required.`);
  return value;
};

/**
 * `bun tools/ci/signed-native-typescript.ts check-signing-team <team>`: the imported identity's team.
 * `bun tools/ci/signed-native-typescript.ts verify --executable <tsc> --reference <tsc> --record <json>`.
 */
async function main(arguments_: readonly string[]): Promise<void> {
  if (arguments_[0] === 'check-signing-team') {
    assertSigningTeam(arguments_[1] ?? '');
    return;
  }
  if (arguments_[0] !== 'verify')
    throw new Error('Usage: check-signing-team <team> | verify --executable <tsc> --reference <tsc> --record <json>');
  const host = nativeTypeScriptHostKey(process.platform, process.arch);
  if (!isSignedNativeTypeScriptHost(host)) throw new Error(`No signed native TypeScript policy for ${host}.`);
  const record = await verifySignedNativeTypeScript({
    host,
    executable: argument(arguments_, '--executable'),
    reference: argument(arguments_, '--reference'),
    requirement: developerIdRequirement(),
  });
  await writeFile(argument(arguments_, '--record'), `${JSON.stringify(record, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  process.stdout.write(
    `Signed native TypeScript ${record.host}: sha256 ${record.sha256}, cdhash ${record.cdhash}, ${record.canonicalForm} ${record.canonicalSha256}\n`,
  );
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
